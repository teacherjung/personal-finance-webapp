// @ts-check
// 店名規則自助管理（第三帖，使用者定 2026-07-19）：讀取／預覽影響／套用。
//
// 「預覽影響」是這一帖的安全帶：規則是全庫生效的，一條寫太寬的規則可能把幾百筆店名改壞。
// 所以套用前一定先跑一次 dryRun——**用候選規則暫時上線、跑既有的 normalizeBranches(dryRun)、
// 再還原**——讓使用者看到「這條規則會動到哪幾筆、變成什麼樣」才決定要不要存。
import { getDb, saveDb } from '../repo.js';
import { setRulesOverride, sanitizeStoreRules, validateStoreRulesStrict, emptyStoreRules } from '../store-rules.js';
import { normalizeBranches, normalizeIfRulesChanged } from './statement-import.js';
import { origFromStmtRef, cleanStore, normalizeStoreDisplay, storeKeyOfName } from '../statement.js';

/** @param {number} status @param {string} msg */
const apiError = (status, msg) => Object.assign(new Error(msg), { status });

/** 目前的使用者規則（沒設定過＝空規則，代表只有內建規則生效）。 */
export async function getStoreRules() {
  const db = await getDb();
  return { rules: sanitizeStoreRules(db.settings?.storeRules ?? emptyStoreRules()) };
}

/**
 * 用「候選規則」暫時上線跑一段程式，跑完**一定**還原（finally）——
 * 預覽不可以留下副作用：中途拋錯卻沒還原的話，這個 Node 行程接下來所有的店名清理都會用到
 * 那份還沒被使用者接受的規則（本機單行程，影響是全域且看不見的）。
 *
 * ⚠️ 用的是 `setRulesOverride`（覆蓋層）而不是 `setUserRules`：規則入櫃檯之後，預覽內部的
 * `getDb()` 會把規則重設回 settings 的值——候選規則會在讀第一次資料時就被洗掉，
 * 預覽永遠顯示「0 筆變動」（自審實測踩到）。覆蓋層才蓋得住櫃檯。
 * ⚠️ **必須 `await fn()` 再進 finally**（C4a）：fn 內含 async 的 normalizeBranches——若不 await，
 * fn 一遇到第一個 `await getDb()` 控制權就回到這裡、finally 立刻把覆蓋還原，後半段跑的是
 * 舊規則＝預覽又變「0 筆變動」（同一個病的 async 版）。
 * @template T @param {any} candidate @param {() => T | Promise<T>} fn @returns {Promise<T>}
 */
async function withRules(candidate, fn) {
  try {
    setRulesOverride(candidate);
    return await fn();
  } finally {
    setRulesOverride(null);
  }
}

/**
 * 整組規則的**冪等性**檢查（Codex r4#4）：跨規則串接（B→C ＋ A→B）會讓同一店名每整理一次
 * 就再變一次——第一次 A→B、第二次才 B→C，名字或鑰匙口徑跟著漂移。單條規則的自我冪等已在
 * `sanitizeStoreRules` 擋掉（`to` 含 `match`），但跨規則要靠「跑兩次結果相同」才驗得出來。
 * 做法：用候選規則暫時上線，對**每條規則的產物 `to`** 再清一次——若 `clean(to) !== to`，
 * 代表還有別的規則會接著改它 → 不是固定點 → 拒絕，並白話說明。
 * @param {any} rules 已 sanitize 的規則 @returns {Promise<string[]>} 問題訊息（空＝冪等）
 */
export async function checkRulesIdempotent(rules) {
  return withRules(rules, () => {
    /** @type {string[]} */
    const errs = [];
    const seen = new Set();
    for (const kind of ['canon', 'brand', 'rename']) {
      for (const e of rules[kind] || []) {
        const to = String(e.to || '');
        if (!to || seen.has(kind + '|' + to)) continue;
        seen.add(kind + '|' + to);
        // canon 的產物是「最終顯示名」，用 cleanStore 這條總管道再跑一次最貼近真實整理；
        // brand/rename 用 normalizeStoreDisplay（cleanStore 收尾呼叫的同一條）＝「就地整理」重複執行的固定點。
        const again = kind === 'canon' ? cleanStore(to) : normalizeStoreDisplay(to);
        if (again !== to) {
          errs.push(`規則產生的「${to}」還會被其他規則再改成「${again}」——` +
            '整理每跑一次名字就會再變一次。請把這幾條改成一步到位（例如直接寫 A→最終名），別接力。');
        } else if (kind !== 'canon') {
          // 完整管線的品牌口徑（Codex r5#6）：normalizeStoreDisplay 看不到 STORE_CANON——那張表只在
          // cleanStore 開頭比對「帳單原文」。rename 產物若是內建標準名的別種寫法（STARBUCKS SHOP），
          // 未來哪張帳單直接印這串字時會被 canon 清成「星巴克」＝同一家店兩種顯示名、兩把鑰匙，
          // 統計與學習從此分家。只比**品牌身分**（storeKeyOfName）：cleanStore 摘掉尾端「（分店）」
          // 屬正常裝飾差（統一超商（百福）→統一超商），不是漂移，不可誤殺。
          const full = cleanStore(to);
          if (full !== to && storeKeyOfName(full) !== storeKeyOfName(to)) {
            errs.push(`規則產生的「${to}」在完整清理管線裡會變成另一個品牌「${full}」——` +
              '同一家店會出現兩種口徑（改名的舊帳單一種、未來直接印這串字的新帳單另一種），統計與學習會分家。' +
              `請直接寫成「${full}」。`);
          }
        }
      }
    }
    return errs;
  });
}

/**
 * 預覽一組規則對「全庫」的影響（不寫檔）。三件事，嚴重度由輕到重：
 * ①顯示名 before→after（改錯了再改回來就好）
 * ②身分鑰匙變動筆數（＝哪些消費算同一家店，會連動統計、排行、學習）
 * ③**不可逆的兩種**——刪掉規則也還原不回來，預覽一定要講出來，否則使用者看到
 *   「4 筆顯示名會變」就按下去，教過的東西默默消失：
 *   ・`learnedConflicts`：兩把鑰匙併成一把時，兩邊手動教過的分類只留得下一個（自審 r3 抓到）
 *   ・`learnedNameChanges`：學過的**自訂店名**被新規則改寫或清除（Codex r3#2 抓到——
 *     這個更隱蔽，孤兒學習的自訂名被改時 changed/keyChanged 都是 0，
 *     UI 於是說「不會改動任何既有記錄」，使用者放心按下去，取好的名字就沒了）
 * @param {any} rules
 * @returns {Promise<{changed:number, keyChanged:number, changes:{id:string,before:string,after:string}[],
 *            learnedConflicts:{key:string,field:string,kept:string,dropped:string}[], learnedConflictTotal:number,
 *            learnedNameChanges:{key:string,before:string,after:string}[], learnedNameChangeTotal:number}>}
 */
export async function previewStoreRules(rules) {
  const clean = sanitizeStoreRules(rules);
  const r = await withRules(clean, () => normalizeBranches(true));
  return { changed: r.changed, keyChanged: r.keyChanged, changes: r.changes || [],
    learnedConflicts: r.learnedConflicts || [], learnedConflictTotal: r.learnedConflictTotal || 0,
    learnedNameChanges: r.learnedNameChanges || [], learnedNameChangeTotal: r.learnedNameChangeTotal || 0 };
}

/**
 * 存下規則並立刻套用到既有資料（＝存完就生效，不必再記得按一次「整理店名格式」——
 * 那正是第一帖要解的病，別在第三帖復發）。
 * 套用順序：先寫 settings → 再走 `normalizeIfRulesChanged`（它會重算含使用者規則的指紋、
 * 跑整理、記下新指紋），這樣「開 app 自動整理」與「這裡手動存檔」共用同一條路，不會互相打架。
 *
 * ⚠️ **這條路刻意沒有「操作前自動備份」**：不產生 `pre-rules.bak`、不擋、不問——完整理由與
 * 刻意接受的代價寫在 `lib/services/backup.js` 的設計註解（重點：那層網自己會失敗，而失敗的那一次
 * 畫面照樣說成功）。所以畫面上也不可以承諾任何自動還原檔。
 * 使用者手上有哪些救援手段，單一真相就在那段設計註解（這裡不重列，免得長出第二份會漂的清單）。
 * ⚠️ 想順手補回來的人請先讀那段：`test/vault-and-backup-integrity.test.js` 的〈裁決〉那一題
 * 釘著這條路不得出現操作前備份，補了就會轉紅。
 *
 * @param {any} rules
 * @returns {Promise<{ok:true, rules:any, changed:number, keyChanged:number, learnedRemapped:number, learnedNamesFixed:number}>}
 */
export async function saveStoreRules(rules) {
  if (rules === undefined || rules === null) throw apiError(400, '缺少規則內容');
  // ⚠️ 儲存這條路要**嚴格**（Codex r3#6）：寬鬆處理的結果是「型別打錯 → 當成空物件 →
  // 回報成功 → 把使用者手上全部的規則清空」。形狀不對就整包拒絕，什麼都不動。
  const errs = validateStoreRulesStrict(rules);
  if (errs.length) throw apiError(400, `規則沒有儲存（${errs.length} 個問題）：` + errs.slice(0, 5).join('；')
    + (errs.length > 5 ? `；…另外 ${errs.length - 5} 個` : ''));
  const clean = sanitizeStoreRules(rules);
  // 跨規則冪等（Codex r4#4）：整理會重複執行，串接規則會讓名字每跑一次就再變一次
  const idemErrs = await checkRulesIdempotent(clean);
  if (idemErrs.length) throw apiError(400, `規則沒有儲存（會愈整理愈亂）：` + idemErrs.slice(0, 3).join('；'));
  const db = await getDb();
  db.settings = { ...db.settings, storeRules: clean };
  await saveDb(db);
  const r = await normalizeIfRulesChanged(true);   // force：UI 儲存前已預覽＋確認過不可逆效果（#133），不再問第二次；內含 getDb()＝規則入櫃檯
  return { ok: true, rules: clean,
    changed: r.changed || 0, keyChanged: r.keyChanged || 0,
    learnedRemapped: r.learnedRemapped || 0, learnedNamesFixed: r.learnedNamesFixed || 0 };
}

/**
 * 孤兒學習條目：`learnedCategories` 裡「對不上任何現存交易」的 key
 *（既不是某筆交易的帳單原文，也不是某筆交易的身分鑰匙）。
 *
 * 為什麼要看得到它們（使用者定 2026-07-19，第三帖的配套）：
 * ①刪掉整批帳單後，學習仍刻意留著給未來匯入——但使用者無從得知自己還留著哪些規則；
 * ②改了店名規則會讓鑰匙搬家，**搬不動的孤兒**（normalizeBranches 刻意原封不動，r2-Codex#1）
 *   就成了「看不見卻仍會在下次匯入生效」的隱形規則。列出來才有機會判斷要不要刪。
 * 純唯讀（比照帳務體檢）；刪除走既有的 `POST /api/learned/delete`。
 * @returns {Promise<{items: {key:string, name?:string, category?:string, subcategory?:string}[], total:number}>}
 */
export async function listOrphanLearned() {
  const db = await getDb();
  const origs = new Set();
  const keys = new Set();
  for (const t of db.transactions || []) {
    if (t.storeKey) keys.add(String(t.storeKey));
    if (t.source === 'stmt' && t.stmtRef) {
      const o = origFromStmtRef(t.stmtRef);
      if (o) origs.add(o);
    }
  }
  const lc = db.learnedCategories || {};
  const items = [];
  for (const [key, v] of Object.entries(lc)) {
    if (origs.has(key) || keys.has(key)) continue;
    items.push({ key, name: v?.name, category: v?.category, subcategory: v?.subcategory });
  }
  items.sort((a, b) => a.key.localeCompare(b.key, 'zh-Hant'));
  return { items, total: Object.keys(lc).length };
}
