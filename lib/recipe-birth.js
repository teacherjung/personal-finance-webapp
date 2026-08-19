// @ts-check
/**
 * 版面規則卡的**出生紀錄**（2026-08-19；體檢 R2：七種失敗原因目前完全不留痕——沒寫進 db、沒 log、
 * 畫面只印一句通稱「這次沒存成」。於是「規則卡到底有沒有誕生過、卡在哪一關」對使用者與維護者
 * 都是黑箱，而規則卡正是「同版面第二次起零 AI」那條省錢路的全部指望）。
 *
 * 這支只做**記錄與顯示**，不改出生判準（放寬哪一關要等有證據再談＝本支存在的理由）。
 *
 * ⚠️ 機密：只記**結果代碼**（封閉列舉）＋機構名＋日期。**不記帳單內容、不記配方內容、不記原文**。
 * ⚠️ 鍵集合封閉＝這張表不會膨脹（與 storeRules 那種可任意長的自訂表不同），所以放得進 settings。
 */

/** 出生結果代碼（`generateRecipeAfterImport` 的回傳；`ok` 是本模組加的成功格）。 */
export const BIRTH_CODES = Object.freeze([
  'ok',                       // 存成了（成功也要記——沒有分母就看不出失敗率）
  'recipe_engine_missing',    // 沒鑰匙／沒引擎＝根本沒去生成
  'recipe_gen_failed',        // 生成那一發自己壞了（模型錯誤、票裡沒原文、例外）
  'recipe_birth_strict',      // 出生關①：零內容機械驗證沒過（欄位太長、藏數字、鍵不合法…）
  'recipe_birth_match',       // 出生關②：配方對不上它自己的出生帳單（錨點不在版面上）
  'recipe_birth_parse',       // 出生關②：用這張卡解出生帳單時直接拒解
  'recipe_birth_statement',   // 出生關②：錨點落在交易列上（會把帳單內容當成版面詞彙）
  'recipe_birth_reproduce',   // 出生關③：解出來的結果與使用者確認過的那份**逐欄不同**
]);
const VALID = new Set(BIRTH_CODES);
const MAX_N = 100000;   // 計數上限（防呆：正常一個月頂多幾次）

/** 把一次出生結果併進統計表（純函式；回新表，不改原表）。
 * @param {any} stats 既有 settings.recipeBirthStats @param {string} code @param {string} bank @param {string} today YYYY-MM-DD
 * @returns {Record<string, {n:number, lastAt:string, lastBank:string}>} */
export function recordBirth(stats, code, bank, today) {
  const out = sanitizeBirthStats(stats);
  const key = VALID.has(code) ? code : 'recipe_gen_failed';   // 未知代碼歸到「生成失敗」（fail-closed：不長出新鍵）
  const prev = out[key] || { n: 0, lastAt: '', lastBank: '' };
  out[key] = {
    n: Math.min(MAX_N, prev.n + 1),
    lastAt: /^\d{4}-\d{2}-\d{2}$/.test(String(today)) ? String(today) : prev.lastAt,
    lastBank: String(bank || prev.lastBank || '').slice(0, 20),
  };
  return out;
}

/** 讀寫兩端共用的消毒：只留封閉鍵、數字夾在範圍內、字串截短（壞資料進來不會炸畫面）。
 * @param {any} stats @returns {Record<string, {n:number, lastAt:string, lastBank:string}>} */
export function sanitizeBirthStats(stats) {
  /** @type {any} */ const out = Object.create(null);
  if (!stats || typeof stats !== 'object') return out;
  for (const k of BIRTH_CODES) {
    const v = /** @type {any} */ (stats)[k];
    if (!v || typeof v !== 'object') continue;
    const n = Number(v.n);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[k] = {
      n: Math.min(MAX_N, Math.floor(n)),
      lastAt: /^\d{4}-\d{2}-\d{2}$/.test(String(v.lastAt || '')) ? String(v.lastAt) : '',
      lastBank: String(v.lastBank || '').slice(0, 20),
    };
  }
  return out;
}

/** 統計摘要（給畫面用的純資料）：總嘗試、成功、失敗、最常卡的那一關。
 * @param {any} stats @returns {{total:number, ok:number, failed:number, top:{code:string, n:number}|null}} */
export function birthSummary(stats) {
  const s = sanitizeBirthStats(stats);
  let total = 0, ok = 0;
  /** @type {{code:string, n:number}|null} */ let top = null;
  for (const [k, v] of Object.entries(s)) {
    total += v.n;
    if (k === 'ok') { ok += v.n; continue; }
    if (!top || v.n > top.n) top = { code: k, n: v.n };
  }
  return { total, ok, failed: total - ok, top };
}
