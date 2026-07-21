// @ts-check
// 帳單「自動學習」的全部邏輯（B2 集中一處）：套用學習、從編輯學、從匯入學。
// 學習表＝db.learnedCategories：{ storeKey(cleanStore 後原名) → {category, subcategory, name?} }。
// ⚠️「國外交易服務費」不學：它的說明帶當筆金額（國外交易服務費-2350.00），每筆 key 都不同，
//    學了永遠不會再命中，只會讓學習表無限膨脹；它的分類本來就由 statement.js finalize
//    繼承前一筆消費，不需要也不該學（使用者定，2026-07）。判準用 statement.js 的 isServiceFee。
// 詳細規矩見 AGENTS.md「帳單自動學習」同步點列。
import { categorize, isServiceFee, cleanStore, applyDisplayLabels, origFromStmtRef, isPlatformArtifactName } from '../statement.js';
import { resolveImportCategory, parkingSubName } from './categories.js';
import { getOwn, setOwn, isProtoKey } from '../safe-map.js';
/** @typedef {import('../types.js').Db} Db */

/**
 * 這家店有沒有「使用者自訂顯示名」——原文級（desc）優先於品牌級（storeKey），平台殘骸名不算數
 * （優食（UE）等舊 bug 產物，非真自訂名）。匯入／遷移／同店一起改都用它判「逐字 vs 自動」，
 * 三處共用同一判準才不會各走各的（使用者定 2026-07-20：自訂名逐字，不再自動貼標記）。
 * @param {Db} db @param {string} desc 帳單原文 @param {string} storeKey 身分鑰匙 @returns {string} 自訂名，沒有回 ''
 */
export function customStoreName(db, desc, storeKey) {
  const lc = db.learnedCategories || {};
  // **逐層各自判「是不是真自訂名」再合併**——必須與 applyLearned 一致（它每層各帶 `!isPlatformArtifactName`
  // 守衛，見下）。不可先 `||` 合併再判：原文級的平台殘骸名（優食（UE））會短路 `||`、再被整體
  // isPlatformArtifactName 打成 ''，把品牌級的真自訂名遮蔽掉 → 預覽（applyLearned 判自訂）與匯入
  // （此處判自動）顯示名不一致（Codex/自審 2026-07-20 實測 legacy 資料）。空字串同理落到下一層。
  const pick = (x) => (typeof x === 'string' && x && !isPlatformArtifactName(x)) ? x : '';
  return pick(getOwn(lc, String(desc || ''))?.name) || pick(getOwn(lc, String(storeKey || ''))?.name);
}

/**
 * 套用學習：依店名（cleanStore 後的 store）套用使用者過往修正過的分類/顯示名，優先於內建規則。
 * 回傳的每筆都帶 storeKey（穩定 key，匯入端存起來、日後學習用）。
 * 命中自訂名時標 `storeCustom:true`——顯示標記（FP／停車費）由 conformTxs 只加在**自動名**上，
 * 自訂名逐字（使用者定 2026-07-20）。
 * @param {Db} db @param {any[]} txs
 */
export function applyLearned(db, txs) {
  const learned = db.learnedCategories || {};
  return txs.map(t => {
    const key = t.storeKey || t.store || '';   // storeKeyOf(desc)＝品牌層身分鑰匙（改顯示名/換分店都不變）
    // 服務費「套用端」也要擋（自審 r2，中）：擋新增不夠——學習表若還有舊的服務費紀錄（清理前、
    // 或從備份還原），固定金額的月費會重複命中同一 key，把 finalize 的「繼承前一筆」正確分類蓋掉。
    if (isServiceFee(key) || isServiceFee(t.desc)) return { ...t, storeKey: key };
    const l = getOwn(learned, key);
    const out = { ...t, storeKey: key };
    if (l) {
      // 平台殘骸名不算自訂（不標 storeCustom）→ 落回自動名，讓 conformTxs 砍平台前綴、上正確標記
      if (l.name && !isPlatformArtifactName(l.name)) { out.store = l.name; out.storeCustom = true; }   // 套用學過的顯示店名（逐字）
      if (l.category) { out.category = l.category; out.subcategory = l.subcategory || ''; } // 套用學過的分類
    }
    // 原文級覆蓋（2026-07-18，店名對照表逐列改名）：key＝帳單原文（t.desc）。銀行截斷的店名會讓
    // 不同分店共用同一個 storeKey（FP-12MINI (桃/(新 → 都是 12MINI），原文級才能各自取名——優先於 storeKey 級。
    const fine = getOwn(learned, String(t.desc || ''));
    if (fine) {
      if (fine.name && !isPlatformArtifactName(fine.name)) { out.store = fine.name; out.storeCustom = true; }
      if (fine.category) { out.category = fine.category; out.subcategory = fine.subcategory || ''; }
    }
    return out;
  });
}

/**
 * 品牌層「不留 name」的正確手段是**搬家、不是刪除**（Codex r11#4；normalizeBranches 的既有語意＝
 * 「摘掉改掛回原文級」）：舊格式品牌層自訂名是活資料（customStoreName／applyLearned 都仍支援），
 * 直接刪＝使用者取的名字無聲蒸發——違反「手做的心血務必保留」原則。
 * 把 entry 上的有效自訂名（非空、非平台殘骸）改掛到該品牌**所有現存帳單交易**的原文級
 * （原文級已有名＝優先、不覆蓋，同 normalizeBranches 的 truthy 判準），搬得了才刪品牌層 name；
 * 一個原文都掛不到（交易缺 stmtRef 等）＝**保留品牌層 name**（保留＞流失；AGENTS.md 記載的刻意例外，
 * 待 normalizeBranches 或下次編輯再搬）。平台殘骸名照舊清掉不搬（五處同判準）。
 * @param {Db} db @param {string} storeKey 品牌鑰匙 @param {any} e 該品牌層 entry（就地修改）
 */
export function migrateBrandName(db, storeKey, e) {
  const name = (typeof e.name === 'string' && e.name && !isPlatformArtifactName(e.name)) ? e.name : '';
  if (!name) { delete e.name; return; }               // 沒有效自訂名（含平台殘骸）＝照舊清掉
  const lc = (db.learnedCategories ||= {});
  let attached = 0, selfOrig = false;
  for (const t of db.transactions || []) {
    if (t.source !== 'stmt' || String(t.storeKey || '') !== String(storeKey)) continue;
    const o = origFromStmtRef(t.stmtRef);
    if (!o || isProtoKey(o)) continue;
    // 原文＝鑰匙（乾淨品牌名的原文：星巴克/全聯這型，極常見）：learned[原文] 與 learned[storeKey]
    // 是**同一格**——entry 本身就兼任原文級的家，名字留在原地即是「已搬」。把自己當著落再刪
    // ＝r11#4 要防的蒸發在此子集原樣重演（對抗審查實測抓到：getOwn 回同一物件、name 尚未刪＝truthy）。
    if (o === String(storeKey)) { selfOrig = true; continue; }
    const fine = getOwn(lc, o) || {};
    // 「已有著落」判準＝與 customStoreName 同一把尺（非空且非平台殘骸）：殘骸名不遮蔽品牌層、
    // 不算著落——用真名直接蓋掉它（殘骸本就該清；沿 truthy 判會讓真自訂名被殘骸「頂替」而蒸發）。
    if (typeof fine.name === 'string' && fine.name && !isPlatformArtifactName(fine.name)) { attached++; continue; }
    fine.name = name; setOwn(lc, o, fine); attached++;
  }
  // 搬成了才刪；selfOrig＝entry 自己就是原文級的家→保留；一個原文都掛不到＝保留
  // （品牌層暫留 name 的合法情境，normalizeBranches 同語意：無著落不摘）。
  if (attached && !selfOrig) delete e.name;
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
  if (isProtoKey(key)) return;                         // 原型名不可能是真店名（Codex r4#1）
  const e = getOwn(lc, key) || {};
  e.category = item.category || ''; e.subcategory = item.subcategory || '';
  migrateBrandName(db, key, e);                        // 品牌層不留顯示名（見檔頭②）——搬家到原文級、不是刪除（Codex r11#4）
  setOwn(lc, key, e);
  const orig = origFromStmtRef(item.stmtRef);
  if (!orig) return;                                   // 沒有原文＝無處掛原文級規則，只學分類
  const autoName = applyDisplayLabels(cleanStore(orig), { desc: orig, subcategory: item.subcategory, parkSub: parkingSubName(db) });
  if (isProtoKey(orig)) return;                        // 同上：帳單原文也是使用者/銀行給的字
  const fine = getOwn(lc, orig) || {};
  // ③顯示名跟著分類走（見檔頭）：這次沒改店名、且沒有自訂名 → 用新分類重算。
  // 要在下面的學習比對**之前**做，否則「只改分類」會被誤記成自訂名。
  // ⚠️ 沒有 prev 時一律當「有改名字」（既有考題抓到）：拿不到舊值就無從判斷，
  // 而猜錯的代價不對稱——猜「沒改」會把使用者剛打的名字覆寫掉，猜「有改」只是沿用舊行為。
  // 實務上只有 CRUD 那條路會走到這裡，而它一定帶 prev；其餘直接呼叫的行為維持不變。
  const noteUnchanged = Boolean(prev) && String(item.note || '') === String(prev.note || '');
  // 平台殘骸名（優食（UE））不算真自訂——與其他四處（applyLearned/customStoreName/normalizeBranches/
  // applyCategoryToStore）同一判準（三處共用同一判準的鐵則）：只改分類時，殘骸名要落回自動名、不逐字留存。
  const hasCustomName = Object.hasOwn(fine, 'name') && typeof fine.name === 'string' && fine.name !== ''
    && !isPlatformArtifactName(fine.name);
  if (noteUnchanged) {
    // 只改了分類/子類、沒動顯示名：有自訂名就維持逐字不動（使用者定 2026-07-20：自訂名不因分類變動被重貼標記，
    // 換言之改成「停車費」子類也不會自動包成「停車費（自訂名）」）；沒有自訂名＝自動名，跟著新子類重算（標記照舊）。
    if (!hasCustomName) item.note = autoName;
  } else {
    // 這次真的改了顯示名 → 逐字照登（不拆不貼標記）；與自動名相同才不記（自我修剪）。
    // ⚠️**清空＝回復預設自動名**（使用者定 2026-07-21：刪掉修改的說明→回自動生成）：note 空時不留空白，
    //   改回 autoName、並清掉學習的自訂名（＝「還原自動」的自然入口，等同 reset）。
    if (item.note && item.note !== autoName) fine.name = item.note;
    else { delete fine.name; item.note = autoName; }
  }
  if (Object.keys(fine).length) setOwn(lc, orig, fine);
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
  // 原型名不可能是真店名（Codex r5#1）：這裡以前用裸物件讀寫，storeKey='__proto__' 時
  // `lc[key] || {}` 撈到的是 **Object.prototype 本尊**（truthy！）→ 下一行直接在全域原型上
  // 寫 category＝整個行程的每個空物件都「繼承」到一個分類，pdfjs 當場崩潰。
  if (isProtoKey(storeKey)) return;
  if (getOwn(db.learnedCategories || {}, d)?.category) return;          // 原文級已涵蓋→不升級成共用 storeKey（Codex#2）
  const [ac, asub] = resolveImportCategory(db, ...categorize(d));       // 完整自動結果（含別名/生效樹校正）
  if (category === ac && (subcategory || '') === (asub || '')) return;  // 與自動相同＝沒有新資訊，不學
  const lc = (db.learnedCategories ||= {});
  const e = getOwn(lc, storeKey) || {};
  e.category = category; e.subcategory = subcategory;
  setOwn(lc, storeKey, e);
}
