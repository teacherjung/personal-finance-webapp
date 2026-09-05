// @ts-check
// 核心路由（B2）：整包資料/總覽/設定/快照/自訂分類/備份匯出入。
import { Router } from 'express';
import { getDb, saveDb, getSettings, updateSettings, emptyDb, normalizeLedger } from '../repo.js';
import {
  sanitizeSettings, validateImportItem, sanitizeLearned, sanitizeLearnedBank,
  COLLECTIONS, READONLY_COLLECTIONS, duplicateResearchSymbols
} from '../schema.js';
import { buildSummary, buildMonthlyReview, monthKey, pairRefunds } from '../derive.js';
import { projectDb, projectSettings, stripSecretsForBackup, mapSecrets, mapBackupOnlyPii } from '../secret-fields.js';
import { isHosted } from '../hosted.js';
import { takeSnapshot, takeSnapshotIfDue, nowLocal } from '../services/snapshot.js';
import { dailyBackupIfDue } from '../services/backup.js';
import { effectiveTree, saveTree, effectiveIncomeTree, saveIncomeTree, effectiveTransferSubs, saveTransferSubs } from '../services/categories.js';
import { cleanTransferSubs } from '../schema.js';
import { asyncRoute } from './route-helpers.js';   // C4a：repo 改 async 後，handler 全 async——Express 4 不接 async 拋錯，包這層讓錯誤照舊走全域中介

export const coreRoutes = Router();

// ---- 整份資料 ----
coreRoutes.get('/api/db', asyncRoute(async (req, res) => res.json(projectDb(await getDb()))));   // 剝機密（自主體檢）：僅資產頁用、只讀 accounts
coreRoutes.get('/api/summary', asyncRoute(async (req, res) => res.json(buildSummary(await getDb()))));
coreRoutes.get('/api/monthly-review', asyncRoute(async (req, res) => {
  const requestedMonth = typeof req.query.month === 'string' ? req.query.month : '';
  res.json(buildMonthlyReview(await getDb(), requestedMonth));
}));
// 退款配對關係（唯讀）：信用卡費頁用它做「消費歸屬」統計與兩端標記（退款列標消費月、消費列標已退多少）。
// 只吐 id／日期／金額／月份＝交易上本來就會回給前端的欄位，無機密；配對判準與月度回顧同一份（derive.pairRefunds）。
coreRoutes.get('/api/refund-pairs', asyncRoute(async (req, res) => {
  const { pairs, unmatchedRefunds, rewards } = pairRefunds(await getDb());
  res.json({
    pairs: pairs.map(({ purchase, refund }) => ({
      refundId: String(refund.id || ''), refundDate: String(refund.date || ''),
      amount: Math.abs(Number(refund.amount)),
      purchaseId: String(purchase.id || ''), purchaseDate: String(purchase.date || ''),
      purchaseMonth: monthKey(purchase.date),
    })),
    unmatchedRefunds,
    // 回饋也一起回：信用卡費頁要在同一個角落講「本月回饋 X 元」。前端自己拿字樣重算＝判準變兩份，
    // 與 pairRefunds 檔頭那條「配對規則只能改這裡」相牴觸。
    rewards,
  });
}));
// 每日滾動備份（階段四 A）：開 app 呼叫，今天沒備過才備一份、保留 30 天。**備份失敗不擋 app**
// （服務層自己吞例外並累計失敗次數），但要把狀態如實回給前端——畫面必須明顯警告（裁決 2026-07-24）。
coreRoutes.post('/api/backup/daily', asyncRoute(async (req, res) => res.json(await dailyBackupIfDue(nowLocal().date))));

coreRoutes.get('/api/settings', asyncRoute(async (req, res) => res.json(projectSettings(await getSettings()))));   // 剝 flexToken（自主體檢）
// 白名單＋型別過濾：擋未知欄位、IB 同步擁有的 lastEquity/income/lastSync、以及錯型別（usdTwd:'oops'→NaN）
coreRoutes.put('/api/settings', asyncRoute(async (req, res) => res.json(projectSettings(await updateSettings(sanitizeSettings(req.body))))));   // 寫入端也剝 flexToken（Codex r10#2）——只 GET 剝、PUT 不剝＝改個匯率就把 token 送回瀏覽器

// ---- 每月淨資產快照（隨時間變化的主軸）----
coreRoutes.post('/api/snapshot', asyncRoute(async (req, res) => res.json(await takeSnapshot())));
// 自動快照（1-1）：開 app 呼叫，每個本地日曆日至多記一次（已記今天就跳過，不重複寫、不打擾手動快照）
coreRoutes.post('/api/snapshot/auto', asyncRoute(async (req, res) => res.json(await takeSnapshotIfDue())));

// ---- 自訂支出分類樹（大類＋子類）：讀目前生效的樹／儲存新樹（含改名連動更新）----
coreRoutes.get('/api/categories', asyncRoute(async (req, res) => res.json(effectiveTree(await getDb()))));
coreRoutes.post('/api/categories', asyncRoute(async (req, res) => {
  // tree 必須明確存在且為物件（Codex#6）：缺 tree 會被 sanitizeTree 當成「刪光→只剩其他/未分類」、
  // 把所有支出交易改歸未分類。要真的刪光，前端仍會送明確的 tree:{}（sanitizeTree 保底其他/未分類）。
  const b = req.body;
  if (!b || typeof b.tree !== 'object' || b.tree === null || Array.isArray(b.tree)) {
    return res.status(400).json({ error: '缺少分類樹（tree），未做任何變更' });
  }
  res.json(await saveTree(b));
}));

// ---- 自訂收入分類樹（三層重構 stage 1）：現金流帳本的收入用，與支出樹各自一棵 ----
coreRoutes.get('/api/income-categories', asyncRoute(async (req, res) => res.json(effectiveIncomeTree(await getDb()))));
coreRoutes.post('/api/income-categories', asyncRoute(async (req, res) => {
  const b = req.body;   // 同支出樹：tree 必須明確存在（缺 tree 會被 sanitize 當成「刪光」）
  if (!b || typeof b.tree !== 'object' || b.tree === null || Array.isArray(b.tree)) {
    return res.status(400).json({ error: '缺少分類樹（tree），未做任何變更' });
  }
  res.json(await saveIncomeTree(b));
}));

// ---- 內轉子分類（使用者定 2026-07-21，可全編輯）：扁平清單 [{label,role?}]；存檔連動既有內轉交易 ----
coreRoutes.get('/api/transfer-subcategories', asyncRoute(async (req, res) => res.json(effectiveTransferSubs(await getDb()))));
coreRoutes.post('/api/transfer-subcategories', asyncRoute(async (req, res) => {
  const b = req.body;   // subs 必須是陣列，而且清乾淨之後至少要留下一項
  if (!b || !Array.isArray(b.subs)) {
    return res.status(400).json({ error: '缺少內轉子分類清單（subs），未做任何變更' });
  }
  // 清完一項都不剩＝擋在這裡回可讀訊息。服務層也擋（那是給別的呼叫端的第二道網），
  // 但它 throw 出去會被全域中介換成泛用訊息——使用者要看得懂「為什麼沒存成」，所以這條路自己回話。
  if (!cleanTransferSubs(b.subs).length) {
    return res.status(400).json({ error: '清單裡沒有任何可用的內轉分類名稱，未做任何變更' });
  }
  res.json(await saveTransferSubs(b));
}));

// 舊「分類轉換（一次性）」已移除（使用者定 2026-07-18）：使用者資料早已全數轉換為兩層分類、
// 按鈕實測回 0 筆；日後分類調整一律走「分類管理」（/api/categories）。極舊備份若需轉換，
// 程式碼在 git 歷史（CATEGORY_MIGRATION，PR #92 前）可撈回。

// ---- 這是本機版還是雲端版（唯讀、無機密）----
// 🧑‍⚖️ William 2026-08-08：匯出前的告知窗要**講準**（`/api/export` 兩種模式刻意相反——LOCAL 含機密、
// HOSTED 剝除），而 `public/` 全樹刻意沒有模式資訊。所以開一支最小的唯讀端點讓畫面問。
// ⚠️ 這裡**只回一個布林**：不回版本、不回設定、不回任何機密——「我是不是雲端版」看網址就知道，
//    本身不是秘密；但也僅止於此，別把這支端點養成「什麼都問它」的雜物間。
// ⚠️ 前端拿不到答案時**必須往含機密那邊猜**（見 public/modules/backup-export.js 的 EXPORT_NOTICE_*）：
//    猜錯的方向要是「以為不含機密」，使用者會把含 IB 憑證的檔案隨手轉寄出去。
coreRoutes.get('/api/mode', (req, res) => res.json({ hosted: isHosted() }));

// ---- 匯出 / 匯入備份 ----
coreRoutes.get('/api/export', asyncRoute(async (req, res) => {
  // ⚠️ LOCAL：備份必須是**完整**資料（含 pdfPassword/flexToken）——投影過的備份還原後密碼會永久遺失。
  // ⚠️ HOSTED（C5，裁決⑤）：**刻意相反**——雲端匯出不含機密。那個檔案會經過瀏覽器下載、
  //    可能被轉寄或存到別處，風險與「留在你自己硬碟上的本機備份」完全不同。
  //    William 確認過「不含機密仍可正常還原，只需重輸 PDF 密碼與 IB 憑證各一次」後拍板。
  const db = await getDb();
  res.setHeader('Content-Disposition', `attachment; filename="finance-backup-${monthKey()}.json"`);
  res.json(isHosted() ? stripSecretsForBackup(db) : db);
}));
/**
 * 「留空＝保留現值」到底哪些路徑可以安全回填——**兩張清單共用同一個判準**
 * （2026-07-29，Codex 定向複審第三輪指出 accountNo 有這道防線、機密欄位卻完全沒有）。
 *
 * ⚠️⚠️ 回填只准在**三個條件同時成立**時發生，缺一不可。這是被連抓三輪才收斂出來的：
 *
 *  ①**這一筆有穩定身分**（`stable`，判準＝`isStableId`：只有非空字串算數）。
 *    id 不在必填欄位裡（`lib/schema.js`），而匯入驗證刻意保留任意型別的 id，所以：
 *    缺 id → 全部塌成 `accounts..accountNo`／`cards..pdfPassword`；
 *    `id: 7` 與 `id: "7"` → `String()` 之後是同一條路徑。
 *    **兩側各只有一筆時撞號根本數不出來**，於是「完全不同的新帳戶」靜靜地繼承舊帳號、
 *    新卡片繼承舊卡的 PDF 密碼，而且都回 200。
 *  ②**目前資料那側沒有同路徑重複**——否則回填來源本身就不確定是誰的。
 *  ③**匯入後那側沒有同路徑重複**——否則兩筆會**同時**從同一條路徑取到同一個值。
 *
 *  退出只關掉「從現值回填」這條退路；accountNo 那條路上**檔案裡自己帶的非空值照收**——
 *  那是該筆自己的值，不會錯配。
 *  判準與 `lib/store-pg.js` 對 `cards..pdfPassword` 的處置一致：
 *  **寧可少救一個欄位，也不要把資料寫錯。**
 *
 * 📌 已知代價（刻意的）：用非字串 id 匯入的卡片／帳戶，重新匯入時保不住密碼與帳號。
 *    正常路徑（`POST /api/cards`／`/api/accounts`）配的是 `uid()` 字串，碰不到這一條。
 *
 * ⚠️ 呼叫端**還要再擋一次 `stable`**（見 `/api/import` 裡那兩行 `stable ? … : …`）：
 *    這裡擋的是「別把身分不明的值收進 Map」，那裡擋的是「就算收進來了也不准取用」。
 *    **兩道各自都是必要的，方向剛好相反**（突變測試逐項實測）：
 *    ・只拿掉這裡 → **來回⑨紅**：目前 `id: 7`（數字）進了 Map，匯入的 `id: "7"` 本身是
 *      合法字串、取用那道會放行，於是照樣繼承。
 *    ・只拿掉那裡 → **來回⑬⑭紅**：目前 `id: "7"`（字串）合法地進了 Map，匯入的 `id: 7`
 *      身分不明，全靠取用那道擋下來。
 *
 *    📌 值得記的教訓：v7 我在這裡寫過「第二道殺不掉、是刻意留的第二層」——**那是錯的**。
 *    我只試了一個方向就下結論。Codex 定向複審把型別碰撞反過來，當場殺掉。
 *    「這一行沒有考題殺得掉」這種話，先確認自己有沒有試完所有方向再寫。
 *
 * @param {(db:any, fn:(value:string, path:string, stable:boolean)=>string)=>any} walk 兩張清單的走訪器之一
 * @param {any} snapshot 目前資料（同一次 getDb）
 * @param {any} merged 匯入後的結果
 * @returns {Map<string, string>} 可以安全回填的「路徑 → 現值」
 */
function keepableByPath(walk, snapshot, merged) {
  /** @type {Map<string, string>} */
  const kept = new Map();
  /** @type {Set<string>} */
  const ambiguous = new Set();
  walk(snapshot, (v, path, stable) => {
    if (!stable) return v;                                          // ①
    if (kept.has(path)) ambiguous.add(path); else kept.set(path, v);   // ②
    return v;
  });
  /** 匯入後那一側同一條路徑出現幾次（不改值，純計數）。 @type {Set<string>} */
  const seenTarget = new Set();
  walk(merged, (v, path, stable) => {
    if (!stable) return v;
    if (seenTarget.has(path)) ambiguous.add(path); else seenTarget.add(path);   // ③
    return v;
  });
  for (const p of ambiguous) kept.delete(p);
  return kept;
}

coreRoutes.post('/api/import', asyncRoute(async (req, res) => {
  const b = req.body;
  // settings 也要擋陣列（自審 r2，中）：typeof [] === 'object'，settings:[] 會繞過檢查、把全部設定（匯率/IB token）默默重設成預設
  if (!b || typeof b !== 'object' || Array.isArray(b) || !b.settings || typeof b.settings !== 'object' || Array.isArray(b.settings)) {
    return res.status(400).json({ error: '匯入檔格式不正確（需為含 settings 的備份 JSON）' });
  }
  // 巢狀設定也 fail-closed（Codex#10-4）：signals/fxTwd/ib 若是陣列或非物件，sanitize 只會「略過」→
  // 默默套回預設（IB token/匯率被清）。壞備份要明確拒絕，不要靜默重設。
  // 巢狀物件型設定：signals/fxTwd/ib＋自訂分類與店名規則（自主體檢，中）——
  // 後三者以前只在 sanitize 時「靜默剝除」壞值→回 200，使用者的自訂分類樹與手做店名規則默默消失。
  // 型別錯就跟其他一樣明確拒絕（fail-closed），不要假裝匯入成功。
  for (const nested of ['signals', 'fxTwd', 'ib', 'expenseTree', 'incomeTree', 'categoryAliases', 'subAliases', 'incomeCategoryAliases', 'incomeSubAliases', 'storeRules']) {
    const v = /** @type {any} */ (b.settings)[nested];
    if (nested in b.settings && (v === null || typeof v !== 'object' || Array.isArray(v))) {
      return res.status(400).json({ error: `匯入檔格式不正確（settings.${nested} 應為物件）` });
    }
  }
  // 集合/物件欄位若出現但型別不對（陣列變字串、物件變別的）→ 壞備份，明確擋下。
  // （否則 { subscriptions:'oops' } 會覆蓋底稿的陣列，讓之後 buildSummary 的 .reduce/.map 崩掉。Codex 驗證）
  const base = emptyDb();
  /** @type {string[]} */
  const badFields = [];
  for (const [key, baseVal] of Object.entries(base)) {
    if (key === 'settings' || !(key in b)) continue;
    if (Array.isArray(baseVal)) {
      if (!Array.isArray(b[key])) badFields.push(`${key}（應為清單）`);
    } else if (baseVal && typeof baseVal === 'object') {   // learnedCategories：需為非陣列物件
      if (!b[key] || typeof b[key] !== 'object' || Array.isArray(b[key])) badFields.push(`${key}（應為物件）`);
    }
  }
  if (badFields.length) {
    return res.status(400).json({ error: `匯入檔格式不正確（這些欄位型別錯誤）：${badFields.join('、')}` });
  }
  // 集合逐筆驗證（Codex 三～五輪）：非物件元素（[null]）過濾掉、數值/陣列壞值剝掉、陣列過濾壞元素；
  // 枚舉/布林非法值（cycle:'yearlyy'、accounts.type:'mortgagex'）→ 收集錯誤、整份匯入拒絕（不可靜默落到
  // 危險預設，會讓月費/資產負債方向算錯）。snapshots（頂層陣列）也過濾非物件元素、learnedCategories 清理。
  /** @type {Record<string, any>} */
  const cleanCollections = {};
  /** @type {string[]} */
  const itemErrors = [];
  for (const col of [...COLLECTIONS, ...READONLY_COLLECTIONS, 'snapshots']) {
    if (!Array.isArray(b[col])) continue;
    const out = [];
    b[col].forEach((/** @type {any} */ it, /** @type {number} */ i) => {
      const { item, errors } = validateImportItem(col, it);
      if (errors.length) itemErrors.push(`${col}[${i}]: ${errors.join('/')}`);
      if (item !== null) out.push(item);   // 非物件（null）過濾掉
    });
    cleanCollections[col] = out;
  }
  const duplicateResearch = duplicateResearchSymbols(cleanCollections.research || []);
  if (duplicateResearch.length) {
    itemErrors.push(`research: 同一代號重複（${duplicateResearch.join('、')}）`);
  }
  // r2（P2-2）：parseRecipes 的 id 集合級唯一要在**驗證階段**擋（400＋零寫入）——櫃檯的 throw
  // tripwire 留著抓「內部寫入漏驗證」，但使用者的壞備份不可以被誤報成 500 伺服器錯。
  const seenRecipeIds = new Set();
  for (const r of cleanCollections.parseRecipes || []) {
    if (seenRecipeIds.has(r.id)) { itemErrors.push(`parseRecipes: 重複 id「${r.id}」`); break; }
    seenRecipeIds.add(r.id);
  }
  if (itemErrors.length) {
    return res.status(400).json({ error: `匯入檔有不合法的欄位值，已中止：${itemErrors.slice(0, 8).join('；')}` });
  }
  // 三層重構搬家的隱蔽回歸點（影響分析點名）：還原「重構前的舊備份」不經 store.js 的一次性搬家
  //（meta 守衛已記錄「搬過了」），缺 ledger 的交易會照舊規則被讀取端當 cashflow——
  // 其中 source:'stmt' 的卡片消費就被誤算進現金流。這裡跑同一個 normalizeLedger（單一判準，勿另寫）。
  if (Array.isArray(cleanCollections.transactions)) normalizeLedger(cleanCollections.transactions);
  // 合併到乾淨底稿：缺少的集合補空陣列、缺少的設定補預設，避免壞檔讓之後 load/derive 出錯。
  // settings 走型別過濾（Codex）：錯型別的數值欄位（usdTwd:'oops'）會被剝掉（不再由 base 補預設——計算時 fx-rates.js 退預設值並標註；丙），
  // 不會讓 NaN 污染 netWorth/槓桿；allowIbSyncFields 保留備份的 lastEquity/income/lastSync（仍深層驗型別）。
  const badCustom = [];
  const cleanSettings = sanitizeSettings(b.settings, { allowIbSyncFields: true, badOut: badCustom });
  // 內層也 fail-closed（Codex r10#3）：外層物件型別已在上面擋過，但內層壞值（expenseTree.餐飲:'oops'、
  // storeRules.rename:'oops'）以前只被 sanitize 靜默剝除→回 200，使用者的自訂分類樹/手做店名規則默默消失。
  // 依「資料安全優先」：這四欄有任何內層壞值就整份退回、什麼都不動（sanitizeStoreRules 對『櫃檯單欄寫入』
  // 仍寬鬆，只有『匯入整包備份』這條走 fail-closed）。IB/匯率等欄位維持寬鬆退回預設（不在此清單）。
  const wiped = badCustom.filter(x => /^(settings\.)?(expenseTree|incomeTree|categoryAliases|subAliases|incomeCategoryAliases|incomeSubAliases|storeRules)(\.|$)/.test(x));
  if (wiped.length) {
    return res.status(400).json({ error: `匯入檔格式不正確（自訂分類／店名規則有壞值，未做任何變更）：${wiped.slice(0, 8).join('、')}` });
  }
  const merged = {
    ...base, ...b, ...cleanCollections,
    // learnedCategories：value 非物件（{bad:null}）會讓設定頁讀 v.name 崩 → 清理
    learnedCategories: sanitizeLearned(b.learnedCategories),
    learnedBank: sanitizeLearnedBank(b.learnedBank),   // 銀行收支學習表：同樣清理（壞 type/保留字 key）

    settings: {
      ...base.settings, ...cleanSettings,
      signals: { ...base.settings.signals, ...(cleanSettings.signals || {}) },
      fxTwd: { ...base.settings.fxTwd, ...(cleanSettings.fxTwd || {}) },
      ib: { ...base.settings.ib, ...(cleanSettings.ib || {}) }
    }
  };
  // HOSTED（C5，C0 威脅模型「HOSTED 匯入剝機密欄位」）：**匯入檔裡的機密欄位一律不採用**。
  // 兩個理由：①上傳的備份可能來自別處，裡面的 token／密碼不可信 ②雲端匯出本來就不含機密（裁決⑤），
  // 所以「合法的雲端備份」那些欄位本來就是空的——照單全收只會把使用者已經設好的憑證清成空白。
  // 作法＝**保留目前已存的值**（沿用「留空＝不變更」的既有慣例），不是清空。
  // ⚠️ `snapshot` 一定要留住並往下傳（Codex 收官審查 #2）：它同時是「機密的來源」與「版本戳的來源」，
  //    兩者必須是**同一次讀取**。舊寫法把 getDb() 用完就丟、讓 saveDb 在寫入前一刻自己重抓版本，
  //    結果是「讀機密」到「寫入」之間別人寫進來的東西被這份 stale payload 無聲蓋掉（還回 200）。
  /** @type {any} */
  let snapshot = null;
  if (isHosted()) {
    // ⚠️ **只讀一次**（鐵則 8⑤）：機密、accountNo 與版本戳三者都必須來自同一份 snapshot。
    //    讀兩次＝兩份可能不同的真相，而且第二份沒有版本戳可傳給 CAS。
    snapshot = await getDb();

    // ⚠️ **第二張清單也一定要在這裡對稱處理**（2026-07-29，自審抓到的 blocking 回歸）。
    //    `stripSecretsForBackup` 會把 `accountNo` 從雲端備份剝掉，但如果匯入端不保留現值，
    //    「匯出→匯入回自己的帳號」就會把**所有帳戶的完整帳號洗成空字串，而且回 200**。
    //    後果不是少一個欄位：`matchAccount` 配不到 → 每期帳單多開一個重複帳戶 →
    //    餘額分散兩戶、**淨資產默默多算**；`ownSuffixSet` 少掉自己的末碼 →
    //    自家帳戶之間的內轉被寫成收入。（＝「無聲毀資料＋畫面說成功」那一族。）
    //
    // ⚠️ 兩張清單的**回填安全判準完全相同**（`keepableByPath`），只有「檔案裡的值採不採用」不同：
    //    機密＝`kept.get(path) ?? ''`（**一律不採用檔案裡的值**——上傳的備份可能來自別處，
    //    裡面的 token／密碼不可信）。
    //    accountNo 走既有的「**留空＝不變更**」慣例：它不是憑證、只是不該跟著檔案出門，
    //    所以檔案裡有值就照收（LOCAL 的完整備份搬進 HOSTED 時才不會反而被清掉），
    //    取不到才退回目前已存的值。
    const keptSecrets = keepableByPath(mapSecrets, snapshot, merged);
    mapSecrets(merged, (_v, path, stable) => (stable ? keptSecrets.get(path) : undefined) ?? '');

    const keptPii = keepableByPath(mapBackupOnlyPii, snapshot, merged);
    mapBackupOnlyPii(merged, (v, path, stable) => v || (stable ? keptPii.get(path) : '') || '');
  }
  // ⚠️ `{ overwrite: true }`（C4b）：`merged` 是這裡自己拼出來的**新物件**，沒有 getDb 的版本戳，
  // 而還原備份的語意本來就是「整包蓋掉」。櫃檯預設拒絕沒有版本戳的整包寫入（防呆），
  // 所以這條路必須明確寫出來——**全 repo 只有這一處可以這樣寫**。
  // HOSTED 的租戶綁定不靠這一行把關，而是結構性的：`merged` 裡任何 `user_id` 之類的頂層鍵，
  // 在櫃檯只寫 KV_KEYS 時就被丟掉；列屬於誰由 Postgres 的 `default auth.uid()`
  // ＋RLS 的 `with check` 決定——**匯入檔改不動它，也偽造不了別人的 user_id**（C0 對抗考題第 9 條）。
  // `from: snapshot` ＝上面那一次 getDb() 的版本戳。中間有人寫進來 → CAS 不合 → 409、一個字都不寫。
  // （LOCAL 的 snapshot 是 null，但 LOCAL 走 `save(db)` 那條路，根本不到 CAS。）
  await saveDb(merged, { overwrite: true, from: snapshot });
  res.json({ ok: true });
}));
