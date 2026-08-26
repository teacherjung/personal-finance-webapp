// @ts-check
// 資料存取「單一櫃檯」（B1）：所有讀寫資料的動作都經過這裡。
// 櫃檯後面有**兩顆引擎**（C4b，2026-07-27）：
//   LOCAL（預設＝你的 Mac）  → `lib/store.js`：SQLite `data/store.db`，無帳號、無 user 維度。
//   HOSTED（noteasy.com.tw）→ `lib/store-pg.js`：Supabase Postgres，按 user_id 隔離（RLS）＋樂觀鎖。
// 判準只有一個：`lib/hosted.js isHosted()`。**其他程式（路由、業務邏輯）一行都不必知道差別**——
// 這正是 B1 單一櫃檯當年留下的紅利。
// 規矩：server.js 與 services 一律 import 本檔，**不要直接 import store.js／store-pg.js**（AGENTS.md）。
//
// **async 契約（C4a，2026-07-27）**：全部函式是 async——HOSTED 的 Postgres client 必然非同步，
// 櫃檯簽名先行統一，呼叫端一律 `await`。LOCAL 模式底層仍是同步 SQLite、函式體內沒有任何真正的
// await 點：呼叫後立即完成、只隔一個 microtask——**Node 在清空 microtask queue 之前不會處理下一個
// HTTP 請求**，所以 LOCAL 下「await getDb() → 改 → await saveDb()」與改造前的同步版本一樣，
// 不會被並發請求插隊，讀改寫的原子性不變（test/repo-async.test.js 有考題證明）。
// ⚠️ 呼叫端規矩：read-modify-write（getDb…saveDb）之間**不可再夾真正的外部 IO await**
//（fetch／fs／timer／**HOSTED 下的另一次 getDb**）——那會打開交錯窗口。既有的少數先例
//（ib-sync／refreshQuotesIfStale 的「先抓完外部資料、才開櫃檯」）不在此列，照抄它們的形狀。
//
// **並行安全（C4b，C0 契約 P1-5）**：LOCAL 靠 microtask 連續性，HOSTED 靠 **compare-and-swap**——
// 讀出來時記下每個 kv key 的 version，寫回時比對；不合＝有人在這期間改過，**一個字都不寫**。
// 兩種寫入路徑的處置刻意不同（見下面 `mutate` 與 `saveDb` 的註解）：
//   ①**櫃檯自己的五支寫入函式**（addItem/updateItem/deleteItem/replaceCollection/updateSettings）
//     ——改動邏輯在櫃檯手上，撞版本時可以「重讀、重做、重寫」一次，呼叫端無感。
//   ②**getDb…saveDb 這一對**——改動邏輯在呼叫端的記憶體物件裡，櫃檯**沒有能力重算**，
//     所以直接回 409 讓使用者重整後再存一次。這是誠實的劃界，不是偷懶：
//     假裝重試（拿舊快照再寫一次）等於把別人剛寫的資料吃掉，比 409 危險得多。
import { load, save, uid, emptyDb, backupNow as localBackupNow, snapshotTo as localSnapshotTo, dataDir as localDataDir, normalizeLedger } from './store.js';
import { loadKv, saveKv } from './store-pg.js';
import { isHosted } from './hosted.js';
import { setUserRules } from './store-rules.js';
import { normalizePortfolioSymbol } from '../public/modules/portfolio-symbol.js';
/** @typedef {import('./types.js').Db} Db */
/** @typedef {import('./types.js').Settings} Settings */

export { uid, emptyDb, normalizeLedger };   // 純函式（不碰任何引擎），由櫃檯統一轉供

/**
 * 讀出來的那一版的 kv 版本戳（HOSTED 的 CAS 用）。
 * 用 **Symbol** 而不是普通欄位：`Object.keys`／`JSON.stringify`／`sanitizeDbForWrite` 全都看不到它，
 * 所以它不可能被當成資料寫進資料庫、也不會出現在 `/api/db` 的回應裡；
 * 又因為標成 enumerable，`{...db}` 這種淺拷貝**會**把它帶著走（呼叫端偶爾會這樣用）。
 */
const VERSIONS = Symbol('kvVersions');

/**
 * 「**規則入櫃檯**」（第三帖，2026-07-19）：使用者自訂的店名規則存在 `settings.storeRules`，
 * 但 `lib/statement.js` 是純函式模組（測試直接 import、不碰資料庫）不能自己讀 settings——
 * 所以由櫃檯在每次讀取時把規則餵給 `store-rules.js`。
 *
 * 為什麼裝在櫃檯（比照 B3「驗證入櫃檯」）：任何要用到店名規則的程式碼，**一定**得先向櫃檯拿資料，
 * 所以在這裡同步就「結構上不可能忘記」——不必在每個新端點記得呼叫、也不必為此多讀一次檔。
 * 值沒變時 `setUserRules` 直接返回（只比對一小段 JSON），對每次讀取的成本可忽略。
 * **本檔所有讀取一律走這裡、不要直接呼叫 `load()`／`loadKv()`**——漏一處就會有路徑拿到過期規則。
 * ⚠️ HOSTED 下 `setUserRules` 寫的是**這個請求自己的**規則槽（`lib/tenant.js`），不是模組級單例——
 * 否則 A 的規則會被 B 的讀取洗掉（C4b 修掉的跨租戶污染）。
 * @template T @param {T} db @returns {T}
 */
function syncRules(db) {
  try { setUserRules(/** @type {any} */ (db)?.settings?.storeRules); }
  catch (e) { console.warn('[repo] 店名規則同步失敗（沿用上一版規則）:', /** @type {any} */ (e)?.message); }
  return db;
}

/** 把版本戳釘在 db 物件上（只有 HOSTED 有值）。 @param {any} db @param {any} versions */
function stamp(db, versions) {
  Object.defineProperty(db, VERSIONS, { value: versions, enumerable: true, configurable: true, writable: true });
  return db;
}

/** 讀整包（引擎分流＋規則同步＋HOSTED 版本戳）。 @returns {Promise<any>} */
async function readDb() {
  if (!isHosted()) return syncRules(load());
  const { db, versions } = await loadKv();
  return stamp(syncRules(db), versions);
}

/**
 * 櫃檯自己的寫入（讀→改→寫都在櫃檯內）。HOSTED 撞版本時**重讀重做重寫一次**，再撞才丟 409。
 * `fn(db, skip)`：呼叫 `skip()` 代表「這次不需要寫入」——`updateItem` 找不到那一筆就是這種情況，
 * **不可以照樣寫一次**（原本的程式碼是 `if (i < 0) return null;` 在 save 之前就返回；照樣寫會多跑一趟
 * 全庫驗證牆、在 HOSTED 還會白白把版本推進去，讓別人的分頁莫名撞 409）。
 * ⚠️ `fn` 必須是**同步**函式：它在讀出與寫回之間對記憶體 db 動手，一旦允許 async 就等於
 *    在讀寫之間開 await 窗口（鐵則 8③／④）。
 * @template T @param {(db: any, skip: () => void) => T} fn @returns {Promise<T>}
 */
async function mutate(fn) {
  if (!isHosted()) {
    const db = syncRules(load());
    let skipped = false;
    const out = fn(db, () => { skipped = true; });
    if (!skipped) save(db);
    return out;
  }
  for (let attempt = 0; ; attempt++) {
    const { db, versions } = await loadKv();
    syncRules(db);
    let skipped = false;
    const out = fn(db, () => { skipped = true; });
    if (skipped) return out;
    try {
      await saveKv(db, versions);
      return out;
    } catch (e) {
      // 只有「版本衝突」才值得重試，而且只重試一次（無限重試在高並發下會把伺服器綁死）。
      if (/** @type {any} */ (e)?.code === 'kv_conflict' && attempt === 0) continue;
      throw e;
    }
  }
}

/** 讀整包資料（複雜流程用：IB 同步、帳單匯入、總覽計算…）。 @returns {Promise<Db>} */
export async function getDb() { return readDb(); }

/**
 * 寫回整包資料（與 getDb 成對使用）。
 * HOSTED：拿 `getDb()` 當時的版本戳做 compare-and-swap；版本不合＝丟 **409**（不重試，理由見檔頭②）。
 * **沒有版本戳**（呼叫端自己拼了一個新物件，例如 `/api/import` 的 merged）預設直接 throw——
 * 無條件整包覆蓋是這套資料層最危險的一件事，必須由呼叫端明確寫出 `{ overwrite: true }` 才准做。
 *
 * ⚠️ **`overwrite` 也必須交出版本戳的來源**（`from` ＝呼叫端讀資料時那一次 `getDb()` 的結果）。
 *    2026-07-28 之前這條路是「寫入前一刻自己重抓一次目前版本」——那等於**自己蓋章給自己看**：
 *    CAS 只保護「重抓」到「寫入」那一瞬間，而真正需要保護的是「呼叫端讀資料」到「寫入」那一整段。
 *    後果已重現：A 分頁還原備份的同時 B 分頁存了新的 IB token → CAS 照樣成功 → 新 token 被舊值蓋掉、
 *    而且回 200 說成功（Codex 收官審查 #2）。**這一族（無聲毀資料＋畫面說成功）是這套系統最嚴重的錯**。
 *    拿不出 `from` 就 throw：讓「無來源版本的整包覆蓋」在這道櫃檯上根本不存在。
 * @param {Db} db @param {{overwrite?: boolean, from?: Db}=} opts
 */
export async function saveDb(db, opts) {
  if (!isHosted()) { save(db); return db; }
  const stamped = /** @type {any} */ (db)[VERSIONS];
  const expected = opts?.overwrite ? /** @type {any} */ (opts.from)?.[VERSIONS] : stamped;
  if (!expected) {
    throw Object.assign(
      new Error('伺服器拒絕了一次沒有來源版本的整包寫入（請重新整理後再試）'),
      { status: 500, code: 'kv_no_version' });
  }
  // ⚠️ `overwrite` 走完整 CAS：版本不合＝409、一個字都不寫（保護的是呼叫端讀資料到這裡的整段窗口）。
  stamp(db, await saveKv(db, expected));   // 重新戳：同一個物件可以再存一次
  return db;
}

/** 讀某個集合（不存在回空陣列）。 @param {string} col @returns {Promise<any[]>} */
export async function getCollection(col) { return /** @type {any} */ (await readDb())[col] || []; }

/** @param {any[]} rows @param {string} symbol */
function latestStockFundamentals(rows, symbol) {
  return rows
    .filter((row) => normalizePortfolioSymbol(row?.symbol) === symbol)
    .sort((a, b) => String(b.lastAttemptAt || b.fetchedAt || '').localeCompare(String(a.lastAttemptAt || a.fetchedAt || '')))[0]
    || null;
}

/** 讀某代號的每租戶 SEC 快取；若舊資料重複，暫時讀最後一次嘗試的那筆。 @param {unknown} requestedSymbol */
export async function getStockFundamentalsCache(requestedSymbol) {
  const symbol = normalizePortfolioSymbol(requestedSymbol);
  if (!symbol) return null;
  return latestStockFundamentals((await readDb()).stockFundamentals || [], symbol);
}

/**
 * 原子更新某代號的每租戶 SEC 快取；updater 必須同步、可在 HOSTED CAS 衝突時重跑。
 * 寫入時一併收斂同代號舊重複列，外部 IO 絕不可放進 updater。
 * @param {unknown} requestedSymbol @param {(current:any|null)=>any|null} updater
 */
export async function updateStockFundamentalsCache(requestedSymbol, updater) {
  const symbol = normalizePortfolioSymbol(requestedSymbol);
  if (!symbol) throw Object.assign(new Error('股票代號格式不合法'), { status: 400 });
  return mutate((db) => {
    const rows = Array.isArray(db.stockFundamentals) ? db.stockFundamentals : [];
    const current = latestStockFundamentals(rows, symbol);
    const next = updater(current);
    db.stockFundamentals = rows.filter((/** @type {any} */ row) => normalizePortfolioSymbol(row?.symbol) !== symbol);
    if (next) db.stockFundamentals.push({ ...next, symbol });
    return next;
  });
}

/**
 * 規則卡出生統計的原子累加（2026-08-19；Codex #489 r1#2：先 getDb 算好整包再交給 updateSettings＝
 * 兩次同時出生都從 n=5 讀起、後寫者蓋成 n=6＝**掉一筆**，而這支的全部價值就是那些筆數）。
 * updater 必須同步、可在 CAS 衝突時對 fresh db 重跑（櫃檯規矩④）。
 * @param {(current:any)=>any} updater 收 fresh 的 settings.recipeBirthStats、回新表
 */
export async function updateRecipeBirthStats(updater) {
  return mutate((db) => {
    db.settings = { ...db.settings, recipeBirthStats: updater(db.settings?.recipeBirthStats) };
    return db.settings.recipeBirthStats;
  });
}

/**
 * AI 每日用量的原子累加（成本護欄 C1；同 updateRecipeBirthStats 的理由：先讀再算好整包交出去＝
 * 並發兩發都從同一個 n 讀起、後寫者蓋掉前者＝少算一發，保險絲就鬆了）。
 * updater 收 **fresh 的整包 settings**（上限與用量都要看最新的）、回新的 aiUsage；必須純、
 * 可在 CAS 衝突時對 fresh 重跑（櫃檯規矩④）。
 * @param {(settings:any)=>any} updater
 */
export async function updateAiUsage(updater) {
  return mutate((db) => {
    db.settings = { ...db.settings, aiUsage: updater(db.settings) };
    return db.settings.aiUsage;
  });
}

/**
 * 配方寫入櫃檯（P2-3）：parseRecipes 的**新增／換版**寫入口（apply 的計數走同交易 db 直改；使用者刪卡走 bank-import 的 deleteParseRecipe——三個寫入面都在服務層、通用 CRUD 仍 404）。
 * 前置條件＝呼叫端已跑完**出生三關**（validateRecipeStrict＋against-statement＋reproduces）——
 * 櫃檯不重驗深層（單一實作在 parse-recipe.js），只做原子寫與版本語意。
 * - rebirthId 有值且找得到列＝**重生**（裁示②④）：舊 current 降 previous、新配方上 current、
 *   rebirths+1、suspect 解除、graduateStreak 從零重數（畢業重新累積）。
 * - 否則＝新建一列。
 * @param {object} recipe 已過三關的格式 A 配方
 * @param {{rebirthId?: string, notAfter?: string, bank?: string}} [o]
 *   notAfter＝A4 世代檢查（r1#1）：候選列的 lastUsedAt 晚於它（＝生成在途時已自證）＝不降版、改走
 *   新建——判準**必須**在 mutate 內用 fresh row 做（呼叫端先讀 db 再 await Opus＝舊快照、競態實測可穿）。
 * @returns {Promise<{recipeId: string, rebirth: boolean, rebirths?: number}>}
 */
export async function saveParseRecipe(recipe, o = {}) {
  return mutate((db) => {
    const rows = Array.isArray(db.parseRecipes) ? db.parseRecipes : (db.parseRecipes = []);
    const now = new Date().toISOString();
    let target = o.rebirthId ? rows.find((/** @type {any} */ r) => r?.id === o.rebirthId) : null;
    if (target && o.notAfter && typeof (/** @type {any} */ (target)).lastUsedAt === 'string' && (/** @type {any} */ (target)).lastUsedAt > o.notAfter) target = null;   // 其後已自證＝新建
    if (target) {
      target.previous = target.current;
      target.current = recipe;
      target.rebirths = (Number(target.rebirths) || 0) + 1;   // 內建化候選訊號（累計 5＝進清單，由人裁）
      target.suspect = false;
      target.graduateStreak = 0;   // 重生後從零重數（裁示②）
      target.graduated = false;
      target.updatedAt = now;
      return { recipeId: String(target.id), rebirth: true, rebirths: target.rebirths };
    }
    const id = `rcp-${uid()}`;
    rows.push({ id, bank: String(/** @type {any} */ (recipe)?.bank || o.bank || ''), current: recipe,
      graduateStreak: 0, graduated: false, suspect: false, rebirths: 0,
      createdAt: now, updatedAt: now });
    return { recipeId: id, rebirth: false };
  });
}

/** 新增一筆（自動配 id）並存檔。 @param {string} col @param {Record<string, any>} fields */
export async function addItem(col, fields) {
  return mutate((db) => {
    const item = { id: uid(), ...fields };
    (db[col] ||= []).push(item);
    return item;
  });
}

/**
 * 更新一筆並存檔；找不到回 null。
 * beforeSave(db, item, prev)：同一次寫入內順帶的其他更新（例：帳單交易改分類→寫入學習表、
 * 顯示名跟著新分類重算），確保「更新＋附帶效果」一次寫檔完成，不會存到一半。
 * `prev`＝更新前的那一筆（淺拷貝快照）——**判斷「使用者這次到底改了什麼」必須靠它**：
 * 前端表單是整份送出的，`patch` 裡一定有 note，光看 patch 分不出「改了店名」還是「只改分類」。
 * ⚠️ **beforeSave 必須是同步函式**（契約，C4a）：它在「讀出」與「寫回」之間對記憶體中的 db
 * 物件動手，一旦允許 async 就等於在讀寫之間開 await 窗口；HOSTED（C4b）的 CAS 重試也依賴這個
 * 假設——重試會**整段重跑一次**（重新 findIndex、重套 patch、重跑 beforeSave），所以 beforeSave
 * 必須是「對新讀出來的 db 重跑一次也對」的純粹改動，不可以有外部副作用（發信、寫檔、計數器）。
 * @param {string} col @param {string} id @param {Record<string, any>} patch
 * @param {(db: Db, item: any, prev: any) => void=} beforeSave
 */
export async function updateItem(col, id, patch, beforeSave) {
  return mutate((db, skip) => {
    const list = db[col] || [];
    const i = list.findIndex((/** @type {any} */ x) => x.id === id);
    if (i < 0) { skip(); return null; }
    const prev = { ...list[i] };
    list[i] = { ...list[i], ...patch, id };
    if (beforeSave) beforeSave(db, list[i], prev);
    return list[i];
  });
}

/** 刪除一筆並存檔。 @param {string} col @param {string} id */
export async function deleteItem(col, id) {
  await mutate((db) => { db[col] = (db[col] || []).filter((/** @type {any} */ x) => x.id !== id); });
}

/** **整批取代**某集合並存檔（原子：單次寫入，全有或全無）。呼叫端負責先驗證每筆＋配好 id——本函式不再驗證。
 * 用途＝「先清空再重建」型的儲存（如資產配置目標）不必 GET→逐筆 DELETE→逐筆 POST（中途失敗會半刪半建）。
 * ⚠️ 語意是「整批蓋掉這個集合」，所以 HOSTED 的 CAS 重試也會照樣蓋——同一位使用者在兩個分頁同時
 * 編輯同一個集合時，後送出的那份贏。這是既有語意（LOCAL 也是這樣），不是 C4b 新增的風險。
 * @param {string} col @param {any[]} items @returns {Promise<any[]>} */
export async function replaceCollection(col, items) {
  return mutate((db) => { db[col] = items; return db[col]; });
}

/** 讀設定。 @returns {Promise<Settings>} */
export async function getSettings() { return (await readDb()).settings; }

/** 部分更新設定（巢狀的 ib / fxTwd 用合併、不整包蓋掉）並存檔。 @param {Record<string, any>} patch */
export async function updateSettings(patch) {
  return mutate((db) => {
    db.settings = {
      ...db.settings, ...patch,
      ib: { ...db.settings.ib, ...(patch.ib || {}) },
      fxTwd: { ...db.settings.fxTwd, ...(patch.fxTwd || {}) },
      // signals 同樣要巢狀合併（自審 r2，中）：整包取代會讓「只更新中國 PE」抹掉其他四個市場的手動估值
      signals: { ...db.settings.signals, ...(patch.signals || {}) }
    };
    return db.settings;
  });
}

// ---- 本機檔案操作（備份／快照）：HOSTED 一律擋掉 --------------------------------
// 為什麼要經過櫃檯：這三支會 `open()` 本機 SQLite。HOSTED 下若有任何一條路徑碰到它們，
// 就會在 Render 的**暫時性**檔案系統憑空建出一顆 `data/store.db`——而且因為那顆是全新的空庫，
// `migrateIfNeeded` 會拿 `data/seed.json` 種底稿，於是「今天的備份」內容變成 demo 假帳本，
// 使用者還會在畫面上看到「已備份」。這比「白做工」嚴重得多，所以擋在櫃檯而不是靠自律。
// ⚠️ 三支**維持同步簽名**（AGENTS.md 鐵則 8①：轉供的函式仍同步）——呼叫端沒有 await，
// 改成 async 會讓它們當場變成 fire-and-forget。

/** 不可逆整批操作前的備份。HOSTED＝**不做也不假裝做**，回 false 讓呼叫端據實以告。 @param {string} tag @returns {boolean} */
export function backupNow(tag) { return isHosted() ? false : localBackupNow(tag); }

/** 把目前資料庫做成完整快照到指定路徑（每日備份用）。HOSTED 沒有本機資料庫可快照。 @param {string} destPath @returns {string} */
export function snapshotTo(destPath) {
  if (isHosted()) throw Object.assign(new Error('HOSTED 模式沒有本機資料庫可以快照'), { code: 'hosted_no_local_db' });
  return localSnapshotTo(destPath);
}

/** 資料檔所在資料夾（每日備份服務要在它底下開 `backups/`）。HOSTED 沒有這個資料夾。 @returns {string} */
export function dataDir() {
  if (isHosted()) throw Object.assign(new Error('HOSTED 模式沒有本機資料資料夾'), { code: 'hosted_no_local_db' });
  return localDataDir();
}
