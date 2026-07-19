// @ts-check
// 帳單「自動學習」的全部邏輯（B2 集中一處）：套用學習、從編輯學、從匯入學。
// 學習表＝db.learnedCategories：{ storeKey(cleanStore 後原名) → {category, subcategory, name?} }。
// ⚠️「國外交易服務費」不學：它的說明帶當筆金額（國外交易服務費-2350.00），每筆 key 都不同，
//    學了永遠不會再命中，只會讓學習表無限膨脹；它的分類本來就由 statement.js finalize
//    繼承前一筆消費，不需要也不該學（使用者定，2026-07）。判準用 statement.js 的 isServiceFee。
// 詳細規矩見 AGENTS.md「帳單自動學習」同步點列。
import { categorize, isServiceFee, cleanStore, applyDisplayLabels, origFromStmtRef, normalizeStoreDisplay, stripDisplayLabels } from '../statement.js';
import { resolveImportCategory } from './categories.js';
/** @typedef {import('../types.js').Db} Db */

/**
 * 套用學習：依店名（cleanStore 後的 store）套用使用者過往修正過的分類/顯示名，優先於內建規則。
 * 回傳的每筆都帶 storeKey（穩定 key，匯入端存起來、日後學習用）。
 * @param {Db} db @param {any[]} txs
 */
export function applyLearned(db, txs) {
  const learned = db.learnedCategories || {};
  return txs.map(t => {
    const key = t.storeKey || t.store || '';   // storeKeyOf(desc)＝品牌層身分鑰匙（改顯示名/換分店都不變）
    // 服務費「套用端」也要擋（自審 r2，中）：擋新增不夠——學習表若還有舊的服務費紀錄（清理前、
    // 或從備份還原），固定金額的月費會重複命中同一 key，把 finalize 的「繼承前一筆」正確分類蓋掉。
    if (isServiceFee(key) || isServiceFee(t.desc)) return { ...t, storeKey: key };
    const l = learned[key];
    const out = { ...t, storeKey: key };
    if (l) {
      if (l.name) out.store = l.name;                                                     // 套用學過的顯示店名
      if (l.category) { out.category = l.category; out.subcategory = l.subcategory || ''; } // 套用學過的分類
    }
    // 原文級覆蓋（2026-07-18，店名對照表逐列改名）：key＝帳單原文（t.desc）。銀行截斷的店名會讓
    // 不同分店共用同一個 storeKey（FP-12MINI (桃/(新 → 都是 12MINI），原文級才能各自取名——優先於 storeKey 級。
    const fine = learned[String(t.desc || '')];
    if (fine) {
      if (fine.name) out.store = fine.name;
      if (fine.category) { out.category = fine.category; out.subcategory = fine.subcategory || ''; }
    }
    return out;
  });
}

/**
 * 從「編輯帳單交易」學（掛在通用 CRUD 的 beforeSave）：只學 source:'stmt'，避免手動記帳污染。
 * **分兩層記**（storeKey 改為品牌層之後的必要拆分，2026-07-18）：
 * ①分類 → storeKey（品牌層，同品牌各分店共用，本來就該一起）
 * ②顯示名 → **原文級**（learned[原文]）——顯示名含分店（統一超商（百福）），記在品牌 key 會讓
 *   同品牌其他分店被連動改名（＝使用者踩過的 12MINI 桃/新 連動 bug）。改回自動名 → 清除 name。
 *
 * ③**顯示名跟著分類走**（使用者定 2026-07-19）：顯示名有一部分取決於分類——子類是「停車費」時
 *   要包成「停車費（店名）」。以前只改分類不會重算 note，得手動去按「整理店名格式」才補得上，
 *   而那正是第一帖要消滅的「忘了按按鈕」。更糟的是下面的學習比對會拿**新分類算出的自動名**去比
 *   **沒被重算的舊 note**，兩者當然不同 → 把「嘟嘟房林口站」誤記成使用者刻意取的自訂名，
 *   日後規則再怎麼改進都會被這個假自訂名壓過去（實測確認）。
 *   判準：**這次沒有改動店名**（拿 `prev` 比，不能看 patch——表單整份送出，patch 一定有 note）
 *   **且沒有原文級自訂名** → 用新分類重算 note。使用者真的取過名字就一律不動。
 * @param {Db} db @param {any} item @param {any} [prev] 更新前的那一筆（updateItem 提供）
 */
export function learnFromStmtEdit(db, item, prev) {
  if (item.source !== 'stmt') return;
  // 只用 storeKey 當 key（Codex#10-8：無 storeKey 的舊資料一律不學）——note 可被使用者改名，
  // 原始店名身分已不可考，退用 note 會把規則掛在錯的 key 上（永不命中、或劫持真的同名店家）。
  const key = item.storeKey;
  if (!key || isServiceFee(key) || isServiceFee(item.note)) return;   // 服務費不學（見檔頭說明）
  const lc = (db.learnedCategories ||= {});
  const e = lc[key] || {};
  e.category = item.category || ''; e.subcategory = item.subcategory || '';
  delete e.name;                                       // 品牌層不留顯示名（見檔頭②；舊資料一併清掉）
  lc[key] = e;
  const orig = origFromStmtRef(item.stmtRef);
  if (!orig) return;                                   // 沒有原文＝無處掛原文級規則，只學分類
  const autoName = applyDisplayLabels(cleanStore(orig), { desc: orig, subcategory: item.subcategory });
  const fine = lc[orig] || {};
  // ③顯示名跟著分類走（見檔頭）：這次沒改店名、且沒有自訂名 → 用新分類重算。
  // 要在下面的學習比對**之前**做，否則「只改分類」會被誤記成自訂名。
  // ⚠️ 沒有 prev 時一律當「有改名字」（既有考題抓到）：拿不到舊值就無從判斷，
  // 而猜錯的代價不對稱——猜「沒改」會把使用者剛打的名字覆寫掉，猜「有改」只是沿用舊行為。
  // 實務上只有 CRUD 那條路會走到這裡，而它一定帶 prev；其餘直接呼叫的行為維持不變。
  const noteUnchanged = Boolean(prev) && String(item.note || '') === String(prev.note || '');
  const hasCustomName = Object.hasOwn(fine, 'name') && typeof fine.name === 'string' && fine.name !== '';
  if (noteUnchanged && hasCustomName) {
    // 只改分類、而且使用者取過名字：以**自訂名為底**拆掉舊標記再重上（與「店名格式整理」同一套做法），
    // 自訂名本身不動——標記是顯示層的東西，學習值不該帶標記（AGENTS.md）。
    item.note = applyDisplayLabels(normalizeStoreDisplay(stripDisplayLabels(String(fine.name))),
      { desc: orig, subcategory: item.subcategory });
  } else {
    if (noteUnchanged) item.note = autoName;             // 只改分類、沒有自訂名 → 顯示名跟著自動名走
    if (item.note && item.note !== autoName) fine.name = item.note;   // 這次真的改了名字 → 學起來
    else delete fine.name;                              // 與自動名相同 → 不需要規則（自我修剪）
  }
  if (Object.keys(fine).length) lc[orig] = fine;
  else delete lc[orig];                                // 全同自動＝不需要規則（自我修剪，同 renameStoreDisplay）
}

/**
 * 從「匯入時的選擇」學：只記「使用者手動改成與『完整自動判斷』不同」的分類（避免整表爆）。
 * ⚠️ Codex#2：必須比對「完整自動＝categorize→resolveImportCategory（含別名/生效樹校正）」，不是只比內建
 * categorize——否則別名結果（娛樂→休閒）會被重記成共用 storeKey 規則，日後移除別名仍被鎖住。
 * 且若該原文已有「原文級」學習（rename-store 寫的），不可再升級成共用 storeKey（會污染同 storeKey 的其他分店）。
 * @param {Db} db @param {string} storeKey @param {string} desc 原始說明 @param {string} category @param {string} subcategory
 */
export function learnFromImport(db, storeKey, desc, category, subcategory) {
  const d = String(desc || '');
  if (!storeKey || isServiceFee(storeKey) || isServiceFee(d)) return;   // 服務費不學（見檔頭說明）
  if (db.learnedCategories?.[d]?.category) return;                      // 原文級已涵蓋→不升級成共用 storeKey（Codex#2）
  const [ac, asub] = resolveImportCategory(db, ...categorize(d));       // 完整自動結果（含別名/生效樹校正）
  if (category === ac && (subcategory || '') === (asub || '')) return;  // 與自動相同＝沒有新資訊，不學
  const e = (db.learnedCategories ||= {})[storeKey] || {};
  e.category = category; e.subcategory = subcategory;
  db.learnedCategories[storeKey] = e;
}
