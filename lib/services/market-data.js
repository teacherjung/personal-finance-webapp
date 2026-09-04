// @ts-check
// 市場資料服務（D1，2026-07-21）：Yahoo 報價、Shiller PE（CAPE）、美 10 年期實質利率（FRED）的
// 抓取＋記憶體快取，抽自 lib/routes/market.js（路由變薄殼）。**後端 auto 流程可直接呼叫、不繞 HTTP**。
// 皆唯讀外部資料＋失敗靜默降級（用上次值／設定頁手動值）。fetch 可注入（fetchImpl），供 node --test 餵合成資料。
import { getDb, getSettings, saveDb } from '../repo.js';
import { positiveRate, roundRate } from '../../public/modules/fx-rates.js';   // 正數才算匯率／四捨五入後再驗（丙）

/**
 * 抓 URL 並讀完 body（json／text）——**逾時包住整段**，不只包到拿到 headers 為止（Codex #556 r1 高）：
 * 上游回了 headers 卻永遠不吐 body 時，AbortController 未必救得了合成／代理的 Response，所以另外用 deadline 賽跑，
 * 逾時一律 reject；呼叫端本來就把 reject 當「這個來源沒資料」。開機維護序列（/snapshot/auto、bootSettled）因此有硬上限。
 * @param {string} url @param {number} ms @param {typeof fetch} fetchImpl @param {'json'|'text'} kind
 */
async function fetchBodyWithTimeout(url, ms, fetchImpl, kind) {
  const ctrl = new AbortController();
  /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { ctrl.abort(); reject(new Error(`timeout ${ms}ms: ${url}`)); }, ms); });
  try {
    const body = fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal }).then(r => (kind === 'json' ? r.json() : r.text()));
    return await Promise.race([body, deadline]);
  } finally { clearTimeout(timer); }
}

// ---- 市場報價（Yahoo Finance，10 分鐘記憶體快取）----
const quoteCache = new Map();
/** 匯率代號（Yahoo）：美元／英鎊／日幣 兌台幣。放在 getQuotes 的 FX 備援與 refreshQuotesIfStale 共用。 */
export const FX_SYMBOLS = Object.freeze(['TWD=X', 'GBPTWD=X', 'JPYTWD=X']);
/**
 * 匯率備援管道（丙，William 2026-09-04 裁「降低缺匯率的機率＝多管道」）：Yahoo 沒給的匯率代號依序退到這裡。
 * 兩個都是免費、免金鑰、USD 基準的公開 API；換算成「兌台幣」＝ TWD ÷ 該幣。台灣銀行牌告 CSV 伺服器端會被機器人驗證頁擋住，不列。
 * ⚠️ 新主機都登記在 server.js OUTBOUND_ENDPOINTS 與 test/hosted-auth.test.js 的 ALLOWED（機械對帳）。
 */
const FX_FALLBACK_CHANNELS = [
  { source: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD', pick: (/** @type {any} */ j) => (j && j.result === 'success' && j.rates) ? j.rates : null },
  { source: 'currency-api', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json', pick: (/** @type {any} */ j) => (j && j.usd) ? j.usd : null },
];
/**
 * 抓匯率備援：回 `{ 'TWD=X': {t, price, currency:'', source}, 'GBPTWD=X'…, 'JPYTWD=X'… }`；每個管道都失敗＝空物件（呼叫端保留舊值）。
 * **逐代號**依序退：第一個管道只給了美元，英鎊／日圓會繼續問下一個管道（Codex #556 r1 中）；三個都填滿就停。
 * 只抓 `want` 裡列的代號（預設三個都要）。
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, want?: readonly string[]}} [opts]
 */
export async function fetchFxFallback(opts = {}) {
  const { fetchImpl = globalThis.fetch, timeoutMs = 6000, want = FX_SYMBOLS } = opts;
  /** @type {Record<string, any>} */
  const out = Object.create(null);
  const missing = () => want.filter(sym => !out[sym]);
  for (const ch of FX_FALLBACK_CHANNELS) {
    if (!missing().length) break;
    try {
      const rates = ch.pick(await fetchBodyWithTimeout(ch.url, timeoutMs, fetchImpl, 'json'));
      const twd = positiveRate(rates?.TWD ?? rates?.twd), gbp = positiveRate(rates?.GBP ?? rates?.gbp), jpy = positiveRate(rates?.JPY ?? rates?.jpy);
      if (!twd) continue;   // 沒有 USD→TWD 就換算不了任何一個
      const t = Date.now();
      if (!out['TWD=X'] && want.includes('TWD=X')) out['TWD=X'] = { t, price: twd, currency: '', source: ch.source };
      if (!out['GBPTWD=X'] && want.includes('GBPTWD=X') && gbp) out['GBPTWD=X'] = { t, price: twd / gbp, currency: '', source: ch.source };
      if (!out['JPYTWD=X'] && want.includes('JPYTWD=X') && jpy) out['JPYTWD=X'] = { t, price: twd / jpy, currency: '', source: ch.source };
    } catch { /* 這個管道失敗：試下一個 */ }
  }
  return out;
}
/**
 * 抓一批報價 → { sym: {t, price, currency} | null }（抓不到／解析失敗＝null）。**平行抓**（不再逐檔序列——
 * 離線時最慢一個 timeout 而非 N×timeout）；10 分鐘內用快取。倫敦英鎊以便士報價（GBp/GBX）÷100 轉英鎊。
 * @param {string[]} symbols @param {{fetchImpl?:typeof fetch, ttlMs?:number, timeoutMs?:number}} [opts]
 */
export async function getQuotes(symbols, opts = {}) {
  const { fetchImpl = globalThis.fetch, ttlMs = 10 * 60 * 1000, timeoutMs = 6000 } = opts;
  const syms = [...new Set((symbols || []).map(s => String(s).trim()).filter(Boolean))].slice(0, 40);
  const pairs = await Promise.all(syms.map(async (sym) => {
    const c = quoteCache.get(sym);
    if (c && Date.now() - c.t < ttlMs) return /** @type {[string, any]} */ ([sym, c]);
    try {
      const j = await fetchBodyWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, timeoutMs, fetchImpl, 'json');
      const meta = j?.chart?.result?.[0]?.meta;
      // 價要是「有限正數」才算抓到（Codex #556 r4）：Yahoo 回非空壞值（字串／0／負）時不可快取、匯率代號要退備援
      if (meta && positiveRate(meta.regularMarketPrice) != null) {
        let price = Number(meta.regularMarketPrice), currency = meta.currency || '';
        if (currency === 'GBp' || currency === 'GBX') { price = price / 100; currency = 'GBP'; }   // 便士→英鎊
        const q = { t: Date.now(), price, currency };
        quoteCache.set(sym, q);
        return /** @type {[string, any]} */ ([sym, q]);
      }
      return /** @type {[string, any]} */ ([sym, null]);
    } catch { return /** @type {[string, any]} */ ([sym, null]); }
  }));
  /** @type {Record<string, any>} */
  const out = Object.create(null);   // null-proto：symbols 是呼叫端字串，__proto__ 在普通物件上會吞鍵（Codex r7#4）
  for (const [sym, q] of pairs) out[sym] = q;
  // 匯率備援（丙）：Yahoo 沒給的匯率代號才退到備援管道；抓到的一樣進 10 分鐘快取（帶 source 供診斷）。
  const fxNeeded = FX_SYMBOLS.filter(sym => syms.includes(sym) && !out[sym]);
  if (fxNeeded.length) {
    const fb = await fetchFxFallback({ fetchImpl, timeoutMs, want: fxNeeded });
    for (const sym of fxNeeded) if (fb[sym]) { quoteCache.set(sym, fb[sym]); out[sym] = fb[sym]; }
  }
  return out;
}

// ---- Shiller PE（CAPE），multpl.com，12 小時快取；失敗退回設定頁手動值 ----
let capeCache = null;
/** @param {{fetchImpl?:typeof fetch}} [opts] @returns {Promise<{t:number, value:number|null, source:string}>} */
export async function getCape(opts = {}) {
  const { fetchImpl = globalThis.fetch } = opts;
  if (capeCache && Date.now() - capeCache.t < 12 * 3600 * 1000) return capeCache;
  try {
    const html = await fetchBodyWithTimeout('https://www.multpl.com/shiller-pe', 8000, fetchImpl, 'text');
    const m = html.match(/id="current"[\s\S]{0,300}?(\d+\.\d+)/);
    if (m) { capeCache = { t: Date.now(), value: Number(m[1]), source: 'multpl.com' }; return capeCache; }
    throw new Error('parse failed');
  } catch {
    // getSettings()→load() 在 store 損毀時會 throw；包一層避免未處理例外拖垮程式
    let manual = null;
    try { manual = (await getSettings())?.capeManual; } catch { /* store 壞掉：退回無手動值 */ }
    return { t: Date.now(), value: manual ? Number(manual) : null, source: 'manual' };
  }
}

// ---- 美 10 年期實質利率（FRED DFII10 免金鑰 CSV），12 小時快取；失敗退回手動值。ECY＝1/CAPE − 實質利率 ----
let realYieldCache = null;
/** @param {{fetchImpl?:typeof fetch}} [opts] @returns {Promise<{t:number, value:number|null, date?:string, source:string}>} */
export async function getRealYield(opts = {}) {
  const { fetchImpl = globalThis.fetch } = opts;
  if (realYieldCache && Date.now() - realYieldCache.t < 12 * 3600 * 1000) return realYieldCache;
  try {
    const lines = (await fetchBodyWithTimeout('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10', 8000, fetchImpl, 'text')).trim().split('\n');
    for (let i = lines.length - 1; i > 0; i--) {   // 由後往前找最後一筆有值的（假日為空）
      const [date, v] = lines[i].split(',');
      if (v && v.trim() && v.trim() !== '.' && isFinite(Number(v))) {
        realYieldCache = { t: Date.now(), value: Number(v), date, source: 'FRED DFII10' };
        return realYieldCache;
      }
    }
    throw new Error('parse failed');
  } catch {
    let manual = null;
    try { manual = (await getSettings())?.signals?.realYieldManual; } catch { /* store 壞掉：不讓 fallback 拖垮程式 */ }
    return { t: Date.now(), value: (manual != null && manual !== '') ? Number(manual) : null, source: 'manual' };
  }
}

/**
 * 開 app 自動刷新報價（D1）：報價若比 `maxAgeMs` 還舊（看 `settings.quotesLastAt`）→ 抓**匯率＋持股報價**、
 * 就地更新 `settings.usdTwd/fxTwd` 與 `holdings.price`，寫 `settings.quotesLastAt`。之後的日線（recordDailyValue）
 * 就反映新價。只更新有 `quoteSymbol` 的持股；報價幣別與持股幣別不符（如 GBp）就略過——與前端 refreshQuotes 同口徑。
 * **失敗處理（原則5 失敗靜默降級、不擋開機）**：抓到的保留、抓不到的持股保留舊價。**只要抓到任何報價（含匯率）
 * 就記 `quotesLastAt`、1 小時內不再抓**——刻意如此：個別壞代號（下市/打錯）的 null 不快取，若「一筆失敗就不記時間」，
 * 每次開 app 都會因它而全抓一遍（打爆 API）；代價是該筆保留舊價、要等下個 1 小時窗才重試（可接受，門檻本就 1 小時）。
 * **全部都抓不到**才不記時間、下次開重試（reason:'no-data'）。匯率永遠優先抓（放 syms 最前，不被 40 檔上限砍掉）。
 * @param {{fetchImpl?:typeof fetch, now?:number, maxAgeMs?:number, quoteTtlMs?:number}} [opts]
 * @returns {Promise<{refreshed:boolean, updated:number, skipped?:number, reason?:string}>}
 */
export async function refreshQuotesIfStale(opts = {}) {
  const { fetchImpl, now = Date.now(), maxAgeMs = 60 * 60 * 1000, quoteTtlMs } = opts;
  // ⚠️**外部 IO await 之前只讀「發請求需要的」**（新鮮度判斷＋要抓哪些代號）；整包 db 等回應**之後**才 getDb() 再寫——
  //   Yahoo 要數秒，若拿外部 IO 前的舊快照整包寫回，這段期間新增的交易/店名整理會被無聲覆蓋（Codex r13#1，高；
  //   同 syncIb r3#1「讀整包→await→寫整包」病，AGENTS.md 同步點清單有記）。
  const pre = await getDb();
  const lastRaw = pre.settings?.quotesLastAt;
  const last = lastRaw ? Date.parse(lastRaw) : 0;
  if (last && !Number.isNaN(last) && now - last < maxAgeMs) return { refreshed: false, updated: 0, reason: 'fresh' };
  const FX_SYMS = FX_SYMBOLS;   // 匯率代號（getQuotes 內含備援管道：Yahoo 抓不到才退）
  // FX 放**最前面**：getQuotes 有 40 檔上限，攸關每筆外幣估值的匯率絕不能被一大票持股擠掉。FX 恆存在，故 syms 必非空。
  const syms = /** @type {string[]} */ ([...new Set([...FX_SYMS, ...(pre.holdings || []).map(h => h.quoteSymbol).filter(Boolean)])]);
  let quotes;
  try { quotes = await getQuotes(syms, { fetchImpl, ttlMs: quoteTtlMs }); }
  catch { return { refreshed: false, updated: 0, reason: 'fetch-failed' }; }   // 防禦：getQuotes 內部逐檔已 try/catch、正常不會拋
  // 外部 IO await 完才取最新整包，只把匯率與對應持股價**合併**進去（不動其他欄位）。
  const db = await getDb();
  const holdings = db.holdings || [];
  const settings = db.settings || (db.settings = /** @type {any} */ ({}));
  let updated = 0, skipped = 0, gotAny = false;
  // 只有「四捨五入後仍是正數」才寫回（與前端 portfolio-quotes 同口徑；Codex #556 r3／r4）：壞值／溢位不可變 NaN、Infinity、null 蓋掉舊匯率
  const usd = roundRate(quotes['TWD=X']?.price, 1000), gbp = roundRate(quotes['GBPTWD=X']?.price, 1000), jpy = roundRate(quotes['JPYTWD=X']?.price, 10000);
  if (usd != null) { settings.usdTwd = usd; gotAny = true; }
  const fxTwd = { ...(settings.fxTwd || {}) };
  if (gbp != null) { fxTwd.GBP = gbp; gotAny = true; }
  if (jpy != null) { fxTwd.JPY = jpy; gotAny = true; }
  settings.fxTwd = fxTwd;
  for (const h of holdings) {
    const q = h.quoteSymbol && quotes[h.quoteSymbol];
    if (!q || q.price == null) { if (h.quoteSymbol) skipped++; continue; }
    if (q.currency && q.currency.toUpperCase() !== (h.currency || 'TWD').toUpperCase()) { skipped++; continue; }
    h.price = Math.round(q.price * 100) / 100; updated++; gotAny = true;
  }
  if (!gotAny) return { refreshed: false, updated: 0, reason: 'no-data' };   // 全都沒抓到：保留舊價、不寫時間，下次開再試
  settings.quotesLastAt = new Date(now).toISOString();
  await saveDb(db);
  return { refreshed: true, updated, skipped };
}
