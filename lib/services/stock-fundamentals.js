// @ts-check
// SEC 官方基本面資料服務：外部請求、全站節流、有限重試與每租戶快取。
// 外部資料抓取可以跨租戶共用 in-flight promise；資料庫寫入一定在各自請求恢復後才做，不能放進共用 promise。

import { getStockFundamentalsCache, updateStockFundamentalsCache } from '../repo.js';
import {
  lookupSecTicker,
  normalizeSecSymbol,
  parseSecCompanyFacts
} from '../stock-fundamentals.js';
import { normalizePortfolioSymbol } from '../../public/modules/portfolio-symbol.js';

export const STOCK_FUNDAMENTALS_TTL_MS = 24 * 60 * 60 * 1000;
export const SEC_MIN_INTERVAL_MS = 500;
export const SEC_TIMEOUT_MS = 10 * 1000;
export const SEC_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_SUBMISSIONS_ROOT = 'https://data.sec.gov/submissions';
const SEC_FACTS_ROOT = 'https://data.sec.gov/api/xbrl/companyfacts';
const MAX_ATTEMPTS = 3;

/** @typedef {{
 * fetchImpl?: typeof fetch,
 * now?: () => number,
 * sleep?: (ms:number) => Promise<void>,
 * userAgent?: string,
 * timeoutMs?: number,
 * minIntervalMs?: number,
 * maxResponseBytes?: number,
 * ttlMs?: number,
 * logger?: Pick<Console, 'warn'>
 * }} StockFundamentalsOptions */

/** @type {StockFundamentalsOptions|null} */
let testOptions = null;
/** @type {Promise<any>} */
let secQueue = Promise.resolve();
let nextSecRequestAt = 0;
/** @type {Map<string, Promise<any>>} */
const refreshInFlight = new Map();

/** 測試專用：替 HTTP 端點注入合成 SEC 回應；傳 null 還原正式設定。 @param {StockFundamentalsOptions|null} opts */
export function setStockFundamentalsOptionsForTest(opts) {
  testOptions = opts;
  secQueue = Promise.resolve();
  nextSecRequestAt = 0;
  refreshInFlight.clear();
}

/** @param {unknown} value */
function stockSymbol(value) {
  // 保留字判斷要在大寫之前做：toString 若先變 TOSTRING，就會逃過 Object.prototype 家族防線。
  const sec = normalizeSecSymbol(value);
  const portfolio = normalizePortfolioSymbol(value);
  return sec && sec === portfolio ? sec : null;
}

/** @param {string} message @param {{status?:number,code:string,stage:string,upstreamStatus?:number}} meta */
function serviceError(message, meta) {
  return Object.assign(new Error(message), {
    status: meta.status ?? 502,
    code: meta.code,
    stage: meta.stage,
    upstreamStatus: meta.upstreamStatus ?? null
  });
}

/** SEC 要求可辨識產品＋聯絡信箱；換行也必須拒絕，避免 header injection。 @param {unknown} value */
function validUserAgent(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= 200
    && /^[^\r\n]{1,160}\s+[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
    ? text
    : null;
}

/** @param {StockFundamentalsOptions=} opts */
function resolvedOptions(opts) {
  const merged = { ...(testOptions || {}), ...(opts || {}) };
  return {
    fetchImpl: merged.fetchImpl || globalThis.fetch,
    now: merged.now || (() => Date.now()),
    sleep: merged.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms))),
    userAgent: merged.userAgent ?? process.env.SEC_USER_AGENT,
    timeoutMs: merged.timeoutMs ?? SEC_TIMEOUT_MS,
    minIntervalMs: merged.minIntervalMs ?? SEC_MIN_INTERVAL_MS,
    maxResponseBytes: merged.maxResponseBytes ?? SEC_MAX_RESPONSE_BYTES,
    ttlMs: merged.ttlMs ?? STOCK_FUNDAMENTALS_TTL_MS,
    logger: merged.logger || console
  };
}

/**
 * 全站 SEC 佇列。序列化比「同時兩條」更保守，且相鄰起始時間至少 500ms，確保不超過 2 req/s。
 * @template T @param {() => Promise<T>} fn @param {ReturnType<typeof resolvedOptions>} opts
 */
async function throughSecQueue(fn, opts) {
  const run = secQueue.then(async () => {
    const waitMs = Math.max(0, nextSecRequestAt - opts.now());
    if (waitMs) await opts.sleep(waitMs);
    nextSecRequestAt = opts.now() + Math.max(0, opts.minIntervalMs);
    return fn();
  });
  secQueue = run.catch(() => undefined);
  return run;
}

/** @param {unknown} error */
function isAbort(error) {
  return /** @type {any} */ (error)?.name === 'AbortError'
    || /** @type {any} */ (error)?.code === 'ABORT_ERR';
}

/**
 * 邊讀邊守上限，不能等 response.text/json 全吃進記憶體後才檢查。
 * @param {Response} response @param {string} stage @param {ReturnType<typeof resolvedOptions>} opts
 */
async function readSecJson(response, stage, opts) {
  const maxBytes = Math.max(1, opts.maxResponseBytes);
  const declaredBytes = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    try { await response.body?.cancel(); } catch { /* 取消失敗不改變拒絕結果 */ }
    throw serviceError('SEC 官方資料回應過大，已保留上次成功資料', {
      code: 'sec_response_too_large', stage
    });
  }

  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (!reader) {
    const fallback = await response.text();
    bytes = new TextEncoder().encode(fallback).byteLength;
    if (bytes > maxBytes) {
      throw serviceError('SEC 官方資料回應過大，已保留上次成功資料', {
        code: 'sec_response_too_large', stage
      });
    }
    text = fallback;
  } else {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* 取消失敗不改變拒絕結果 */ }
        throw serviceError('SEC 官方資料回應過大，已保留上次成功資料', {
          code: 'sec_response_too_large', stage
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw serviceError('SEC 官方資料格式無法解析，已保留上次成功資料', {
      code: 'sec_invalid_json', stage
    });
  }
}

/**
 * 只接受程式內建的固定 URL；呼叫端沒有任何 URL 輸入面。
 * @param {string} url @param {string} stage @param {ReturnType<typeof resolvedOptions>} opts
 */
async function fetchSecJson(url, stage, opts) {
  const userAgent = validUserAgent(opts.userAgent);
  if (!userAgent) {
    throw serviceError('SEC_USER_AGENT 尚未設定，請填「產品名稱 聯絡信箱」後再更新官方基本面資料', {
      status: 503, code: 'sec_user_agent_missing', stage
    });
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      const response = await throughSecQueue(async () => {
        const ctrl = new AbortController();
        timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
        return opts.fetchImpl(url, {
          signal: ctrl.signal,
          headers: {
            Accept: 'application/json',
            'User-Agent': userAgent
          }
        });
      }, opts);

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        try { await response.body?.cancel(); } catch { /* 重試判準不受取消失敗影響 */ }
        if (retryable && attempt + 1 < MAX_ATTEMPTS) {
          await opts.sleep(Math.min(4000, 500 * (2 ** attempt)));
          continue;
        }
        throw serviceError(`SEC 官方資料暫時無法取得（HTTP ${response.status}）`, {
          code: 'sec_http_error', stage, upstreamStatus: response.status
        });
      }
      return await readSecJson(response, stage, opts);
    } catch (error) {
      if (/** @type {any} */ (error)?.code && /** @type {any} */ (error)?.stage) throw error;
      const aborted = isAbort(error);
      if (attempt + 1 < MAX_ATTEMPTS) {
        await opts.sleep(Math.min(4000, 500 * (2 ** attempt)));
        continue;
      }
      throw serviceError(
        aborted ? 'SEC 官方資料請求逾時，已保留上次成功資料' : 'SEC 官方資料連線失敗，已保留上次成功資料',
        { status: aborted ? 504 : 502, code: aborted ? 'sec_timeout' : 'sec_network_error', stage }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw serviceError('SEC 官方資料暫時無法取得', { code: 'sec_unavailable', stage });
}

/** @param {string} symbol @param {ReturnType<typeof resolvedOptions>} opts */
async function fetchOfficialFundamentals(symbol, opts) {
  const tickerPayload = await fetchSecJson(SEC_TICKERS_URL, 'ticker-map', opts);
  const ticker = lookupSecTicker(tickerPayload, symbol);
  if (!ticker) {
    throw serviceError(`SEC 查不到股票代號 ${symbol}`, {
      status: 404, code: 'sec_symbol_not_found', stage: 'ticker-map'
    });
  }

  const [submissions, companyFacts] = await Promise.all([
    fetchSecJson(`${SEC_SUBMISSIONS_ROOT}/CIK${ticker.cik}.json`, 'submissions', opts),
    fetchSecJson(`${SEC_FACTS_ROOT}/CIK${ticker.cik}.json`, 'company-facts', opts)
  ]);
  try {
    return {
      cik: ticker.cik,
      data: parseSecCompanyFacts({ symbol, cik: ticker.cik, submissions, companyFacts })
    };
  } catch {
    throw serviceError('SEC 官方資料契約不完整，已保留上次成功資料', {
      code: 'sec_parse_error', stage: 'parse'
    });
  }
}

/** @param {any} record @param {string} symbol @param {number} now @param {number} ttlMs */
function cacheView(record, symbol, now, ttlMs) {
  const fetchedMs = typeof record?.fetchedAt === 'string' ? Date.parse(record.fetchedAt) : NaN;
  const hasData = Boolean(record?.data && typeof record.data === 'object');
  const ageMs = hasData && Number.isFinite(fetchedMs) ? Math.max(0, now - fetchedMs) : null;
  const fresh = hasData && ageMs !== null && ageMs <= ttlMs;
  return {
    symbol,
    freshness: !hasData ? 'missing' : fresh ? 'fresh' : 'stale',
    fresh,
    stale: hasData && !fresh,
    fetchedAt: hasData ? record.fetchedAt || null : null,
    lastAttemptAt: record?.lastAttemptAt || null,
    ageMs,
    expiresAt: hasData && Number.isFinite(fetchedMs) ? new Date(fetchedMs + ttlMs).toISOString() : null,
    data: hasData ? record.data : null,
    lastError: record?.lastError || null
  };
}

/** 只讀每租戶快取，不自動對外連線。 @param {unknown} requestedSymbol @param {StockFundamentalsOptions=} options */
export async function getStockFundamentals(requestedSymbol, options) {
  const symbol = stockSymbol(requestedSymbol);
  if (!symbol) {
    throw serviceError('股票代號格式不合法', { status: 400, code: 'invalid_symbol', stage: 'input' });
  }
  const opts = resolvedOptions(options);
  return cacheView(await getStockFundamentalsCache(symbol), symbol, opts.now(), opts.ttlMs);
}

/** 強制更新；失敗時保留最後成功資料，只另記本次錯誤。 @param {unknown} requestedSymbol @param {StockFundamentalsOptions=} options */
export async function refreshStockFundamentals(requestedSymbol, options) {
  const symbol = stockSymbol(requestedSymbol);
  if (!symbol) {
    throw serviceError('股票代號格式不合法', { status: 400, code: 'invalid_symbol', stage: 'input' });
  }
  const opts = resolvedOptions(options);
  let shared = refreshInFlight.get(symbol);
  if (!shared) {
    shared = fetchOfficialFundamentals(symbol, opts);
    refreshInFlight.set(symbol, shared);
    shared.finally(() => {
      if (refreshInFlight.get(symbol) === shared) refreshInFlight.delete(symbol);
    }).catch(() => undefined);
  }

  try {
    const official = await shared;
    const fetchedAt = new Date(opts.now()).toISOString();
    const record = await updateStockFundamentalsCache(symbol, () => ({
      symbol,
      lastAttemptAt: fetchedAt,
      fetchedAt,
      data: official.data
    }));
    return { ...cacheView(record, symbol, opts.now(), opts.ttlMs), refreshed: true };
  } catch (error) {
    const err = /** @type {any} */ (error);
    const at = new Date(opts.now()).toISOString();
    const lastError = {
      at,
      code: String(err?.code || 'sec_unknown_error'),
      stage: String(err?.stage || 'unknown'),
      status: Number(err?.upstreamStatus || err?.status || 502),
      message: String(err?.message || 'SEC 官方資料更新失敗')
    };
    const record = await updateStockFundamentalsCache(symbol, (current) => ({
      ...(current || {}),
      symbol,
      lastAttemptAt: at,
      lastError
    }));
    opts.logger.warn(
      `[stock-fundamentals] symbol=${symbol} cik=- stage=${lastError.stage} status=${lastError.status} code=${lastError.code}`
    );
    const view = cacheView(record, symbol, opts.now(), opts.ttlMs);
    if (view.data) return { ...view, refreshed: false, refreshError: lastError };
    throw serviceError(lastError.message, {
      status: Number(err?.status) || 502,
      code: lastError.code,
      stage: lastError.stage,
      upstreamStatus: Number(err?.upstreamStatus) || undefined
    });
  }
}
