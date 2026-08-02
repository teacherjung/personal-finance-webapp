// @ts-check
// SEC 官方基本面資料服務：外部請求、全站節流、有限重試與每租戶快取。
// 外部資料抓取可以跨租戶共用 in-flight promise；資料庫寫入一定在各自請求恢復後才做，不能放進共用 promise。

import { getStockFundamentalsCache, updateStockFundamentalsCache } from '../repo.js';
import {
  SecDataContractError,
  currentDebtLabelAccessions,
  lookupSecTicker,
  normalizeSecSymbol,
  parseCurrentDebtLabelHint,
  parseSecCompanyFacts
} from '../stock-fundamentals.js';
import { normalizePortfolioSymbol } from '../../public/modules/portfolio-symbol.js';
import { withHeavySlot } from '../heavy-admission.js';

export const STOCK_FUNDAMENTALS_TTL_MS = 24 * 60 * 60 * 1000;
export const SEC_MIN_INTERVAL_MS = 500;
// 佇列兩道護欄（2026-07-30，#335 複審 dos 條）：SEC 一慢，無上限的佇列會把「一個功能暫時不能用」
// 放大成「所有租戶的 refresh 排隊十幾分鐘、連線與記憶體全被佔住」。兩種模式都套——保護的是行程可用性
//（LOCAL 自己猛按也會自噎），與速率限制（只 HOSTED）的判準不同。
export const SEC_QUEUE_MAX_DEPTH = 16;        // 排隊中＋執行中的上限；滿了新請求立即 503，不無限排
export const SEC_REFRESH_BUDGET_MS = 60_000;  // 單次 refresh 全管線總時限（排隊等待＋最多 11 個請求＋重試）
export const SEC_TIMEOUT_MS = 10 * 1000;
export const SEC_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SEC_SUBMISSIONS_ROOT = 'https://data.sec.gov/submissions';
const SEC_FACTS_ROOT = 'https://data.sec.gov/api/xbrl/companyfacts';
const SEC_ARCHIVES_ROOT = 'https://www.sec.gov/Archives/edgar/data';
const MAX_ATTEMPTS = 3;

/** @typedef {{
 * fetchImpl?: typeof fetch,
 * now?: () => number,
 * sleep?: (ms:number) => Promise<void>,
 * userAgent?: string,
 * timeoutMs?: number,
 * minIntervalMs?: number,
 * maxQueueDepth?: number,
 * refreshBudgetMs?: number,
 * maxResponseBytes?: number,
 * ttlMs?: number,
 * logger?: Pick<Console, 'warn'>
 * }} StockFundamentalsOptions */

/** @type {StockFundamentalsOptions|null} */
let testOptions = null;
/** @type {Promise<any>} */
let secQueue = Promise.resolve();
let nextSecRequestAt = 0;
let secQueueDepth = 0;
/** @type {Map<string, Promise<any>>} */
const refreshInFlight = new Map();

/** 測試專用：替 HTTP 端點注入合成 SEC 回應；傳 null 還原正式設定。 @param {StockFundamentalsOptions|null} opts */
export function setStockFundamentalsOptionsForTest(opts) {
  testOptions = opts;
  secQueue = Promise.resolve();
  nextSecRequestAt = 0;
  secQueueDepth = 0;
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

// ---- SEC 身分＝私有 Symbol，不可偽造（#358 r1 blocking 的修法）--------------------------
// 舊判準「錯誤帶 stage ＝ SEC 端」不是結構性保證：廣包 catch 會替**任何**內部例外補上 stage。
// Symbol 只存在於本模組，外部（含意外穿過來的內部例外）拿不到 ⇒ 「可記入租戶 lastError」
// 的資格只有下面這一個鑄造點發得出來。
const SEC_ORIGIN = Symbol('sec-origin');
const SEC_RETRYABLE = Symbol('sec-retryable');

/** SEC 端可歸因的失敗（唯一有資格寫入 lastError 的錯）。 @param {string} message @param {{status?:number,code:string,stage:string,upstreamStatus?:number,retryable?:boolean}} meta */
function secError(message, meta) {
  const err = /** @type {any} */ (serviceError(message, meta));
  err[SEC_ORIGIN] = true;
  if (meta.retryable) err[SEC_RETRYABLE] = true;
  return err;
}

/** @param {unknown} e */
const isSecOriginError = (e) => Boolean(e && /** @type {any} */ (e)[SEC_ORIGIN]);

// 佇列滿＝back-pressure：既不是 SEC 的錯（不得記 lastError）也不是程式 bug（不得走內部 500
// 通用訊息——使用者要看到「請稍後再試」的真話）。第三種身分，同樣用私有 Symbol 防偽。
const SEC_BACKPRESSURE = Symbol('sec-backpressure');
function backpressureError() {
  const err = /** @type {any} */ (serviceError('SEC 官方資料更新排隊已滿，請稍後再試', {
    status: 503, code: 'sec_queue_full', stage: 'queue'
  }));
  err[SEC_BACKPRESSURE] = true;
  return err;
}
/** @param {unknown} e */
const isBackpressure = (e) => Boolean(e && /** @type {any} */ (e)[SEC_BACKPRESSURE]);
/**
 * 共用重型名額滿了（`withHeavySlot`）＝**同一種第三身分**：不是 SEC 的錯、也不是程式 bug。
 * 不標的話會被錯誤歸因當成內部例外洗成 500 通用訊息（2026-08-02 實測踩到），
 * 使用者就看不到「請稍後再試」這句真話。 @param {unknown} e
 */
function asHeavyBackpressure(e) {
  const err = /** @type {any} */ (e);
  err[SEC_BACKPRESSURE] = true;
  err.stage = err.stage || 'queue';
  return err;
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
    maxQueueDepth: merged.maxQueueDepth ?? SEC_QUEUE_MAX_DEPTH,
    refreshBudgetMs: merged.refreshBudgetMs ?? SEC_REFRESH_BUDGET_MS,
    maxResponseBytes: merged.maxResponseBytes ?? SEC_MAX_RESPONSE_BYTES,
    ttlMs: merged.ttlMs ?? STOCK_FUNDAMENTALS_TTL_MS,
    logger: merged.logger || console
  };
}

/**
 * 全站 SEC 佇列。序列化比「同時兩條」更保守，且相鄰起始時間至少 500ms，確保不超過 2 req/s。
 * @template T @param {() => Promise<T>} fn @param {ReturnType<typeof resolvedOptions>} opts
 */
async function throughSecQueue(fn, opts, guard) {
  // 深度上限：滿了「立即」拒絕（fail-fast），不進鏈——無上限的排隊會把慢放大成全站噎住
  if (secQueueDepth >= opts.maxQueueDepth) throw backpressureError();
  secQueueDepth += 1;
  // ⚠️ r3（Codex #361 r2 blocking 1）：deadline race **只在「還沒開始執行」時**有效。
  // r2 版無條件 race＝呼叫端拿到 504 後，fetchSecResource 的 finally 清掉 per-fetch abort timer，
  // 而底下的 body 還在讀且**再也沒有人取消它**——body 永不結束就永遠不執行 `secQueueDepth -= 1`，
  // 名額永久洩漏、佇列慢性死亡（Codex 隔離重現：abortSeen=false、舊工作占住唯一名額）。
  // 一旦開始執行，硬期限改由 AbortController 負責（它的逾時已夾成剩餘預算）。
  let started = false;
  const expired = () => Boolean(guard && opts.now() >= guard.deadlineAt);
  const timeoutErr = () => secError('SEC 官方資料更新超過總時限（多半是 SEC 端變慢），已保留上次成功資料', {
    status: 504, code: 'sec_timeout', stage: guard ? guard.stage : 'queue'
  });
  const run = secQueue.then(async () => {
    try {
      if (expired()) throw timeoutErr();
      const waitMs = Math.max(0, nextSecRequestAt - opts.now());
      if (waitMs) await opts.sleep(waitMs);
      // ⚠️ 這裡刻意**不**再驗一次期限（r4，Codex #361 r3 建議）：
      // 「pacing sleep 後」與 fetchSecResource 的「發出前再驗剩餘預算」行為完全重疊，
      // 兩道並存會讓任一道被誤刪時考題都不出聲（實測 M6／M7 各自單獨拆都全綠、M8 才紅）。
      // 唯一守門留在**最靠近實際發送點、且每次 retry 都會經過**的那一道。
      started = true;
      nextSecRequestAt = opts.now() + Math.max(0, opts.minIntervalMs);
      return await fn();
    } finally {
      secQueueDepth -= 1;
    }
  });
  secQueue = run.catch(() => undefined);
  if (!guard) return run;
  return new Promise((resolve, reject) => {
    const remaining = Math.max(0, guard.deadlineAt - opts.now());
    const timer = setTimeout(() => {
      if (started) return;   // 已開始＝abort 負責硬期限；這裡再 race 會拆掉取消機制
      reject(secError('SEC 官方資料更新超過總時限（排隊等待過久），已保留上次成功資料', {
        status: 504, code: 'sec_timeout', stage: guard.stage
      }));
    }, remaining);
    run.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
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
/**
 * body 讀取的網路失敗在「源頭」定性（#358 r2 blocking）：headers 已收到後串流中斷
 * （undici 丟 `TypeError: terminated`）不是 abort、也不會有鋼印——不定性的話會被
 * 誤判成內部錯誤：不重試、報 500、不記 lastError（r1 舊版反而會重試三次）。
 * 只包「讀」這一步；解碼與位元組計算留在外面（那些炸了是程式 bug，該走內部出口）。
 * @template T
 * @param {() => Promise<T>} read @param {string} stage @returns {Promise<T>}
 */
async function readBodyStep(read, stage) {
  try {
    return await read();
  } catch (readError) {
    if (isAbort(readError)) throw readError;
    throw secError('SEC 官方資料連線中斷，已保留上次成功資料', {
      status: 502, code: 'sec_network_error', stage, retryable: true
    });
  }
}

async function readSecText(response, stage, opts) {
  const maxBytes = Math.max(1, opts.maxResponseBytes);
  const declaredBytes = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    try { await response.body?.cancel(); } catch { /* 取消失敗不改變拒絕結果 */ }
    throw secError('SEC 官方資料回應過大，已保留上次成功資料', {
      code: 'sec_response_too_large', stage
    });
  }

  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (!reader) {
    const fallback = await readBodyStep(() => response.text(), stage);
    bytes = new TextEncoder().encode(fallback).byteLength;
    if (bytes > maxBytes) {
      throw secError('SEC 官方資料回應過大，已保留上次成功資料', {
        code: 'sec_response_too_large', stage
      });
    }
    text = fallback;
  } else {
    for (;;) {
      const { done, value } = await readBodyStep(() => reader.read(), stage);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        try { await reader.cancel(); } catch { /* 取消失敗不改變拒絕結果 */ }
        throw secError('SEC 官方資料回應過大，已保留上次成功資料', {
          code: 'sec_response_too_large', stage
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }

  return text;
}

/**
 * @param {Response} response @param {string} stage @param {ReturnType<typeof resolvedOptions>} opts
 */
async function readSecJson(response, stage, opts) {
  const text = await readSecText(response, stage, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw secError('SEC 官方資料格式無法解析，已保留上次成功資料', {
      code: 'sec_invalid_json', stage
    });
  }
}

/**
 * 只接受程式內建的固定 URL；呼叫端沒有任何 URL 輸入面。
 * @template T
 * @param {string} url
 * @param {string} stage
 * @param {ReturnType<typeof resolvedOptions>} opts
 * @param {string} accept
 * @param {(response:Response,stage:string,opts:ReturnType<typeof resolvedOptions>)=>Promise<T>} readResponse
 * @param {number} deadlineAt ⚠️ **必填**（不是 optional、也不接受 undefined）：收斂冗餘之後它是總期限的
 *   唯一入口，每個呼叫點都是單點失效。標成必填才能讓「傳 undefined」也被 typecheck 擋下——
 *   少寫參數會被 arity 擋，但傳 undefined 曾經 typecheck 與 24 題全綠（Codex #361 r5）。
 */
async function fetchSecResource(url, stage, opts, accept, readResponse, deadlineAt) {
  const userAgent = validUserAgent(opts.userAgent);
  if (!userAgent) {
    throw secError('SEC_USER_AGENT 尚未設定，請填「產品名稱 聯絡信箱」後再更新官方基本面資料', {
      status: 503, code: 'sec_user_agent_missing', stage
    });
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      return await throughSecQueue(async () => {
        const ctrl = new AbortController();
        // r2：per-fetch 逾時夾成「剩餘預算」——接近總時限時不可再跑滿 10 秒（Codex #361 r1 blocking 1）
        if (deadlineAt && opts.now() >= deadlineAt) {
          throw secError('SEC 官方資料更新超過總時限（多半是 SEC 端變慢），已保留上次成功資料', {
            status: 504, code: 'sec_timeout', stage
          });
        }
        const effTimeoutMs = deadlineAt
          ? Math.max(1, Math.min(opts.timeoutMs, deadlineAt - opts.now()))
          : opts.timeoutMs;
        timer = setTimeout(() => ctrl.abort(), effTimeoutMs);
        let response;
        try {
          response = await opts.fetchImpl(url, {
            signal: ctrl.signal,
            headers: {
              Accept: accept,
              'User-Agent': userAgent
            }
          });
        } catch (fetchError) {
          // 只有「fetch 本體」的失敗在這裡定性為 SEC 連線錯（abort 交外層辨識成逾時）。
          // 佇列、時鐘、sleep 等任何其他例外**不經過這裡**＝保持內部身分。
          if (isAbort(fetchError)) throw fetchError;
          throw secError('SEC 官方資料連線失敗，已保留上次成功資料', {
            status: 502, code: 'sec_network_error', stage, retryable: true
          });
        }
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          try { await response.body?.cancel(); } catch { /* 重試判準不受取消失敗影響 */ }
          throw secError(`SEC 官方資料暫時無法取得（HTTP ${response.status}）`, {
            code: 'sec_http_error', stage, upstreamStatus: response.status, retryable
          });
        }
        // r2（Codex #361 r1 blocking 2）：body 讀取留在佇列「裡面」——headers 到了不等於資源釋放，
        // body 還掛著時連線與記憶體都占用中，深度必須涵蓋到讀完為止（「排隊中＋執行中」的契約）。
        // 代價＝下一個請求要等前一個 body 讀完才開始（更保守的 SEC 節流，刻意接受）。
        return await readResponse(response, stage, opts);
      }, opts, { deadlineAt, stage });
    } catch (error) {
      // ⚠️ 分流順序是本函式的安全核心（#358 r1 blocking）：
      // ①branded＋可重試（連線失敗／429／5xx）→ 重試；②branded 不可重試（4xx/讀取層已定性）→ 原樣丟；
      // ③abort（我們自己的計時器）→ 重試後定性為逾時；④**其他一切＝內部例外，原樣外拋**。
      const aborted = isAbort(error);
      if (!aborted && !isSecOriginError(error)) throw error;
      const retryable = aborted || Boolean(/** @type {any} */ (error)[SEC_RETRYABLE]);
      if (retryable && attempt + 1 < MAX_ATTEMPTS) {
        // r2：重試補眠前先驗預算——快沒預算了就別再睡（睡完也只會逾時）
        // r3（Codex #361 r2 blocking 2）：backoff 也要在總預算內——r2 只在睡前驗一次，
        // 剩 1ms 也會完整睡滿 500/1000ms，而那段期間沒有任何 deadline 在管（實測 budget 120ms
        // 卻 618ms 才回 504）。夾成剩餘預算、睡完再驗一次、邊界用 >=。
        const budgetTimeout = () => secError('SEC 官方資料更新超過總時限（多半是 SEC 端變慢），已保留上次成功資料', {
          status: 504, code: 'sec_timeout', stage
        });
        const backoffMs = Math.min(4000, 500 * (2 ** attempt));
        if (deadlineAt) {
          const remaining = deadlineAt - opts.now();
          if (remaining <= 0) throw budgetTimeout();
          await opts.sleep(Math.min(backoffMs, remaining));
          if (opts.now() >= deadlineAt) throw budgetTimeout();
        } else {
          await opts.sleep(backoffMs);
        }
        continue;
      }
      if (aborted) {
        throw secError('SEC 官方資料請求逾時，已保留上次成功資料', {
          status: 504, code: 'sec_timeout', stage
        });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw secError('SEC 官方資料暫時無法取得', { code: 'sec_unavailable', stage });
}

/** @param {string} url @param {string} stage @param {ReturnType<typeof resolvedOptions>} opts @param {number} deadlineAt */
function fetchSecJson(url, stage, opts, deadlineAt) {
  return fetchSecResource(url, stage, opts, 'application/json', readSecJson, deadlineAt);
}

/** @param {string} url @param {string} stage @param {ReturnType<typeof resolvedOptions>} opts @param {number} deadlineAt */
function fetchSecText(url, stage, opts, deadlineAt) {
  return fetchSecResource(url, stage, opts, 'application/xml,text/xml;q=0.9', readSecText, deadlineAt);
}

/**
 * Company Facts 沒有 presentation label；只為同一申報同時出現兩個 currentDebt 成分的 accession
 * 補抓申報者 label linkbase。抓不到 label 時保留純解析器的 fail-closed 判準，不讓整次更新失敗。
 * @param {string} cik
 * @param {any} submissions
 * @param {any} companyFacts
 * @param {ReturnType<typeof resolvedOptions>} opts
 */
async function fetchCurrentDebtLabelHints(cik, submissions, companyFacts, opts, deadlineAt) {
  const recent = submissions?.filings?.recent;
  const accessions = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : [];
  const primaryDocuments = Array.isArray(recent?.primaryDocument) ? recent.primaryDocument : [];
  const documentsByAccession = new Map();
  for (let index = 0; index < accessions.length; index += 1) {
    const accession = typeof accessions[index] === 'string' ? accessions[index].trim() : '';
    const primaryDocument = typeof primaryDocuments[index] === 'string'
      ? primaryDocuments[index].trim()
      : '';
    if (/^\d{10}-\d{2}-\d{6}$/.test(accession)
      && /^[A-Za-z0-9._-]+\.html?$/i.test(primaryDocument)) {
      documentsByAccession.set(accession, primaryDocument);
    }
  }

  /** @type {Record<string, 'includes-current-long-term-debt'|'short-term-only'>} */
  const hints = Object.create(null);
  const entity = cik.replace(/^0+/, '') || '0';
  for (const accession of currentDebtLabelAccessions(companyFacts)) {
    const primaryDocument = documentsByAccession.get(accession);
    if (!primaryDocument) continue;
    const directory = accession.replaceAll('-', '');
    const labelDocument = primaryDocument.replace(/\.html?$/i, '_lab.xml');
    try {
      const xml = await fetchSecText(
        `${SEC_ARCHIVES_ROOT}/${entity}/${directory}/${labelDocument}`,
        'filing-label',
        opts,
        deadlineAt
      );
      const hint = parseCurrentDebtLabelHint(xml);
      if (hint !== 'unknown') hints[accession] = hint;
    } catch (error) {
      opts.logger.warn(
        `SEC currentDebt label 暫時無法取得（${accession}）：${/** @type {any} */ (error)?.code || 'unknown'}`
      );
      // 預算耗盡＝後面每一筆也只會逾時，別再逐筆空轉（label 是 best-effort、
      // 本來就「不記 lastError」的刻意例外——快取照樣成功，只是少了 label 佐證）
      if (/** @type {any} */ (error)?.code === 'sec_timeout') break;
    }
  }
  return hints;
}

/** @param {string} symbol @param {ReturnType<typeof resolvedOptions>} opts */
async function fetchOfficialFundamentals(symbol, opts) {
  // 單次 refresh 的總預算從這裡起算：排隊等待＋最多 11 個請求（3 必要＋至多 8 個 label）＋重試全包含
  const deadlineAt = opts.now() + Math.max(1, opts.refreshBudgetMs);
  const tickerPayload = await fetchSecJson(SEC_TICKERS_URL, 'ticker-map', opts, deadlineAt);
  const ticker = lookupSecTicker(tickerPayload, symbol);
  if (!ticker) {
    throw secError(`SEC 查不到股票代號 ${symbol}`, {
      status: 404, code: 'sec_symbol_not_found', stage: 'ticker-map'
    });
  }

  // r2：改序列。佇列本來就把執行序列化，`Promise.all` 拿不到任何平行收益，
  // 卻同時佔兩個名額——單一使用者的一次 refresh 就可能把自己擠成 503，
  // 而且滿載時「一支入隊、一支被拒」會讓入隊那支白做工（Codex #361 r1 建議項）。
  const submissions = await fetchSecJson(`${SEC_SUBMISSIONS_ROOT}/CIK${ticker.cik}.json`, 'submissions', opts, deadlineAt);
  const companyFacts = await fetchSecJson(`${SEC_FACTS_ROOT}/CIK${ticker.cik}.json`, 'company-facts', opts, deadlineAt);
  const currentDebtLabelHints = await fetchCurrentDebtLabelHints(
    ticker.cik,
    submissions,
    companyFacts,
    opts,
    deadlineAt
  );
  try {
    return {
      cik: ticker.cik,
      data: parseSecCompanyFacts({
        symbol,
        cik: ticker.cik,
        submissions,
        companyFacts,
        currentDebtLabelHints
      })
    };
  } catch (parseError) {
    // 根因要進伺服器日誌——#351 那次「全 502、被當成 SEC 壞了」花了一天才查到，
    // 就是因為真正的錯誤字串在日誌裡一個字都沒有。
    opts.logger.warn(
      `[stock-fundamentals] symbol=${symbol} parse 失敗根因：${/** @type {any} */ (parseError)?.message || parseError}`
    );
    // 只有解析器**明確宣告**的資料契約錯（SecDataContractError）才算 SEC 端；
    // 其他一切＝解析器程式 bug＝內部錯誤，原樣外拋（#351 那類 bug 不得再被報成上游故障）。
    if (parseError instanceof SecDataContractError) {
      throw secError('SEC 官方資料契約不完整，已保留上次成功資料', {
        code: 'sec_parse_error', stage: 'parse'
      });
    }
    throw parseError;
  }
}

/**
 * 內部錯誤（寫入櫃檯、schema、CAS……）的統一出口：**不得洗成 SEC 失敗**。
 * 三條紀律，方向與洗白版完全相反：
 * ①完整根因進伺服器日誌（那是給開發者的）②瀏覽器只拿通用訊息（內部原文含
 * `[schema] …請修程式`、甚至 JSON.stringify 的欄位值，不該給使用者）③**絕不寫進
 * 租戶快取的 lastError**——把內部故障永久記成「SEC 失敗」，F5 畫面會長期冤枉 SEC，
 * 而下一個寫入層 bug 又要靠真資料才查得出來（#335 複審、#351 的病史）。
 * @param {string} symbol @param {any} cause @param {ReturnType<typeof resolvedOptions>} opts @param {string} what
 */
function internalStoreError(symbol, cause, opts, what) {
  opts.logger.warn(
    `[stock-fundamentals] symbol=${symbol} 內部錯誤（非 SEC，不記入快取）：${what}失敗：${cause?.message || cause}`
  );
  return serviceError('伺服器儲存官方資料時發生內部錯誤（不是 SEC 的問題），請稍後再試', {
    status: 500, code: 'fundamentals_store_error', stage: 'store'
  });
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
    // ⚠️ **名額在這裡取、不在 HTTP 層**（2026-08-02，Codex #371 r2 High 的正解）：一次 refresh
    //    要抓最多 25MiB 並整包 JSON.parse（實測 RSS +118MiB），與 PDF 上傳並行會越過 512MB。
    //    但**去重命中的請求幾乎不花記憶體**——掛在 HTTP 層連它也會擋掉（實測會打掉既有的
    //    「A/B 並發同代號」考題），純損失。只有走到這個分支（真的要抓）才佔名額，滿了 503。
    // ⚠️ **等名額的隊伍要用 SEC 自己的上限**（Codex #371 r4 High）：不傳的話，請求會全部
    //    卡在共用名額的隊伍裡、排不到 `throughSecQueue` 的深度檢查，#361 的 SEC_QUEUE_MAX_DEPTH
    //    就在 HOSTED 變成打不到的死碼——而那條隊伍本身沒有長度上限，跨代號可以無限長。
    shared = withHeavySlot(() => fetchOfficialFundamentals(symbol, opts),
      { group: 'sec-refresh', maxInGroup: opts.maxQueueDepth })
      .catch((e) => {
        const code = /** @type {any} */ (e)?.code;
        throw (code === 'heavy_busy' || code === 'heavy_queue_full') ? asHeavyBackpressure(e) : e;
      });
    refreshInFlight.set(symbol, shared);
    shared.finally(() => {
      if (refreshInFlight.get(symbol) === shared) refreshInFlight.delete(symbol);
    }).catch(() => undefined);
  }

  // ⚠️ 錯誤歸因是這段的核心契約（#335 複審 contract/security 兩條、2026-07-30 修；r2 改判準）：
  // SEC 端可歸因的錯**只有** secError() 鑄造點發得出 SEC_ORIGIN（模組私有 Symbol、不可偽造）；
  // 「帶 stage」不是證明——廣包 catch 曾替內部例外補 stage（r1 blocking）。無鋼印＝內部錯。
  // 舊版把兩者混在同一個 catch：內部錯被記成 SEC lastError 永久寫進租戶快取、
  // 內部原文吐給瀏覽器、伺服器日誌卻只印 stage=unknown——#351 花一天查根因就是這個機制。
  /** @type {{ cik: string, data: any }} */
  let official;
  try {
    official = await shared;
  } catch (error) {
    const err = /** @type {any} */ (error);
    // 佇列滿＝back-pressure：原樣往外（503＋真話「請稍後再試」）、不記 lastError、不算內部錯
    if (isBackpressure(err)) throw err;
    if (!isSecOriginError(err)) throw internalStoreError(symbol, err, opts, '取得官方資料');
    const at = new Date(opts.now()).toISOString();
    const lastError = {
      at,
      code: String(err.code || 'sec_unknown_error'),
      stage: String(err.stage),
      status: Number(err.upstreamStatus || err.status || 502),
      message: String(err.message || 'SEC 官方資料更新失敗')
    };
    // 根因（含 message）進伺服器日誌——舊版只印 stage/status/code，真正的錯誤字串一個字都沒有
    opts.logger.warn(
      `[stock-fundamentals] symbol=${symbol} stage=${lastError.stage} status=${lastError.status} code=${lastError.code} message=${lastError.message}`
    );
    // lastError 的持久化自己也可能失敗（它走同一個櫃檯）；失敗時記日誌、照樣回報原始 SEC 錯，
    // 不能讓「記錄失敗」把「真正的失敗」蓋掉。
    let record = null;
    try {
      record = await updateStockFundamentalsCache(symbol, (current) => ({
        ...(current || {}),
        symbol,
        lastAttemptAt: at,
        lastError
      }));
    } catch (persistError) {
      opts.logger.warn(
        `[stock-fundamentals] symbol=${symbol} lastError 寫入失敗（不影響回報原始 SEC 錯誤）：${/** @type {any} */ (persistError)?.message || persistError}`
      );
    }
    if (record) {
      const view = cacheView(record, symbol, opts.now(), opts.ttlMs);
      if (view.data) return { ...view, refreshed: false, refreshError: lastError };
    }
    throw serviceError(lastError.message, {
      status: Number(err.status) || 502,
      code: lastError.code,
      stage: lastError.stage,
      upstreamStatus: Number(err.upstreamStatus) || undefined
    });
  }

  // SEC 成功之後的寫入是**我們的**責任區：失敗＝內部錯誤（500、通用訊息、完整根因進日誌、
  // 不寫 lastError——寫入層都壞了，硬寫多半也失敗，而且會把內部故障永久冤枉成 SEC 失敗）。
  try {
    const fetchedAt = new Date(opts.now()).toISOString();
    const record = await updateStockFundamentalsCache(symbol, () => ({
      symbol,
      lastAttemptAt: fetchedAt,
      fetchedAt,
      data: official.data
    }));
    return { ...cacheView(record, symbol, opts.now(), opts.ttlMs), refreshed: true };
  } catch (writeError) {
    throw internalStoreError(symbol, writeError, opts, '寫入官方資料快取');
  }
}
