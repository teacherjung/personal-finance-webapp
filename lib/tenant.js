// @ts-check
// 請求範圍的「租戶身分」（C4b；C0 契約 P1-2）。
//
// 一句話：HOSTED 模式下，「這個請求是誰的」不能存在模組級變數裡——Node 是單行程多請求，
// 模組級變數會被下一個請求覆蓋，A 的資料就這樣送給 B。正確做法＝`AsyncLocalStorage`：
// 身分掛在「這條非同步呼叫鏈」上，同時間跑的另一條鏈拿到的是它自己的那份。
//
// 三條規矩（契約，違反＝PR 不得合併）：
// ① **fail-closed**：HOSTED 下拿不到 userId＝`requireTenant()` 直接 throw，
//    **絕不 fallback 到任何共用資料**（fallback 的後果是「看起來能用、其實全部人共用一個帳本」）。
// ② **禁止模組級 userId**：要加新的請求範圍狀態，一律加進本檔的 context 物件，不要在別的模組開 `let`。
// ③ LOCAL 模式（預設、你的 Mac）**完全沒有 context**——`currentTenant()` 回 null，
//    所有讀寫照舊走本機 SQLite，行為與 C4b 之前 byte-for-byte 等價。
//
// 為什麼「店名規則」也住在這裡（C4b 修的隱蔽破口）：`lib/store-rules.js` 的生效規則本來是
// **模組級單例**（由櫃檯每次讀取時餵進去）。單人本機沒問題，多人就成了跨租戶污染——
// A 的請求剛把自己的規則設進去、一個 await 之後 B 的讀取把它洗掉，A 後半段的店名清理
// 就用了 B 的規則（甚至會把 B 的規則指紋寫進 A 的 settings.storeRulesHash，持久化的錯）。
// 所以 HOSTED 下規則狀態改放這個 per-request 槽（見 `lib/store-rules.js` 的 `slot()`）。
import { AsyncLocalStorage } from 'node:async_hooks';

/** @typedef {{raw: any, rawJson: string|null, compiled: any, override: any}} RulesSlot */
/** @typedef {{userId: string, supabase: any, rules: RulesSlot, undecryptable: Map<string, string>}} Tenant */

/** @type {AsyncLocalStorage<Tenant>} */
const als = new AsyncLocalStorage();

/** 全新的（空的）規則槽：欄位語意與 `lib/store-rules.js` 的模組級單例一一對應。 @returns {RulesSlot} */
function emptyRulesSlot() { return { raw: null, rawJson: null, compiled: null, override: null }; }

/**
 * 在「這個使用者的身分」底下跑接下來的整條請求鏈（auth gate 用）。
 * ⚠️ 一定要用 `runWithTenant(ctx, next)` 包住 `next`——**不可**先 `als.enterWith()` 再 next，
 * enterWith 會污染同一個 tick 之後的所有東西（Node 官方警告），正是我們要防的跨請求污染。
 * @template T
 * @param {{userId: string, supabase?: any}} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTenant(ctx, fn) {
  const userId = String(ctx?.userId || '');
  if (!userId) throw new Error('[tenant] runWithTenant 缺 userId——身分不明的請求絕不可進入資料層（fail-closed）');
  return als.run({ userId, supabase: ctx.supabase || null, rules: emptyRulesSlot(), undecryptable: new Map() }, fn);
}

/** 目前請求的租戶；LOCAL 模式或還沒進 gate＝null。 @returns {Tenant|null} */
export function currentTenant() { return als.getStore() || null; }

/**
 * 取目前租戶，**拿不到就 throw**（HOSTED 資料層的唯一入口都該用這支）。
 * 訊息刻意不含使用者資訊；status 500＝這是伺服器端的接線錯誤，不是使用者做錯什麼。
 * @returns {Tenant}
 */
export function requireTenant() {
  const t = als.getStore();
  if (!t || !t.userId) {
    throw Object.assign(
      new Error('伺服器無法確認你的身分，請重新登入後再試'),
      { status: 500, code: 'tenant_missing' });
  }
  return t;
}

/**
 * 目前請求的店名規則槽；**LOCAL（無 context）回 null＝呼叫端用模組級單例**。
 * 只有 `lib/store-rules.js` 該呼叫這支。
 * @returns {RulesSlot|null}
 */
export function tenantRulesSlot() {
  const t = als.getStore();
  return t ? t.rules : null;
}

/**
 * 這個請求「讀出來時解不開」的機密欄位：`欄位路徑 → 資料庫裡原本躺著的那串密文`。
 *
 * 為什麼需要它（C6 資料毀損止血，2026-07-28）：`decryptSecret` 解不開時回空字串（生存優先，
 * 見 `lib/crypto-secrets.js` 檔頭③），但 `store-pg.js` 的 `saveKv` **每次寫入都重寫全部 KV_KEYS**
 * ——那個空字串會在使用者下一次隨手記一筆帳時把原密文**永久蓋掉**。主金鑰設錯一次，
 * IB token 與 PDF 密碼（＝身分證字號）就全滅，換回正確金鑰也救不回來（已實測）。
 * 所以寫回時要認得出「這些欄位的空字串不是使用者清空的，是我們解不開」，把原密文原封不動寫回去。
 *
 * ⚠️ 為什麼一定住在**這個請求**的 context、不可以是模組級 Map：模組級的話，A 解不開的密文會被
 *    寫進 B 的列（`saveKv` 只認路徑、不認人）——正是 C4b 修掉的那一類跨租戶污染，而且後果是資料毀損。
 * LOCAL（無 context）回 null＝完全不適用（LOCAL 不加密）。
 * @returns {Map<string, string>|null}
 */
export function tenantUndecryptableSecrets() {
  const t = als.getStore();
  return t ? t.undecryptable : null;
}
