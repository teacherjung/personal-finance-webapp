// @ts-check
// 核心路由（B2）：整包資料/總覽/設定/快照/自訂分類/備份匯出入。
import { Router } from 'express';
import { getDb, saveDb, getSettings, updateSettings, emptyDb, normalizeLedger } from '../repo.js';
import {
  sanitizeSettings, validateImportItem, sanitizeLearned, sanitizeLearnedBank,
  COLLECTIONS, READONLY_COLLECTIONS, duplicateResearchSymbols
} from '../schema.js';
import { buildSummary, buildMonthlyReview, monthKey, pairRefunds } from '../derive.js';
import { projectDb, projectSettings, stripSecretsForBackup, mapSecrets } from '../secret-fields.js';
import { isHosted } from '../hosted.js';
import { takeSnapshot, takeSnapshotIfDue, nowLocal } from '../services/snapshot.js';
import { dailyBackupIfDue } from '../services/backup.js';
import { getInsights } from '../services/insights.js';
import { effectiveTree, saveTree, effectiveIncomeTree, saveIncomeTree, effectiveTransferSubs, saveTransferSubs } from '../services/categories.js';
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
  const { pairs, unmatchedRefunds } = pairRefunds(await getDb());
  res.json({
    pairs: pairs.map(({ purchase, refund }) => ({
      refundId: String(refund.id || ''), refundDate: String(refund.date || ''),
      amount: Math.abs(Number(refund.amount)),
      purchaseId: String(purchase.id || ''), purchaseDate: String(purchase.date || ''),
      purchaseMonth: monthKey(purchase.date),
    })),
    unmatchedRefunds,
  });
}));
// 每日滾動備份（階段四 A）：開 app 呼叫，今天沒備過才備一份、保留 30 天。**備份失敗不擋 app**
// （服務層自己吞例外並累計失敗次數），但要把狀態如實回給前端——畫面必須明顯警告（裁決 2026-07-24）。
coreRoutes.post('/api/backup/daily', asyncRoute(async (req, res) => res.json(await dailyBackupIfDue(nowLocal().date))));
// 每日洞察引擎（D3）：讀取＝視為「看過了」→ 更新書籤（有寫檔副作用，故只有總覽呼叫）。失敗靜默降級成平靜空殼
// （原則5：絕不擋開機、絕不跳錯誤打擾）。內部已對報價抓取失敗自處理（ecy=null）。
coreRoutes.get('/api/insights', async (req, res) => {
  try { res.json(await getInsights()); }
  catch (e) {
    res.json({ firstRun: true, calm: true, reminders: { new: [], cleared: [], ongoing: [], all: [] },
      tierChanges: [], sinceLast: null, windows: { today: null, week: null }, error: String(/** @type {any} */ (e)?.message || e) });
  }
});

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
  const b = req.body;   // subs 必須是陣列（缺→sanitize 當空→回預設，會把使用者刪光的清單默默復原成預設）
  if (!b || !Array.isArray(b.subs)) {
    return res.status(400).json({ error: '缺少內轉子分類清單（subs），未做任何變更' });
  }
  res.json(await saveTransferSubs(b));
}));

// 舊「分類轉換（一次性）」已移除（使用者定 2026-07-18）：使用者資料早已全數轉換為兩層分類、
// 按鈕實測回 0 筆；日後分類調整一律走「分類管理」（/api/categories）。極舊備份若需轉換，
// 程式碼在 git 歷史（CATEGORY_MIGRATION，PR #92 前）可撈回。

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
  if (itemErrors.length) {
    return res.status(400).json({ error: `匯入檔有不合法的欄位值，已中止：${itemErrors.slice(0, 8).join('；')}` });
  }
  // 三層重構搬家的隱蔽回歸點（影響分析點名）：還原「重構前的舊備份」不經 store.js 的一次性搬家
  //（meta 守衛已記錄「搬過了」），缺 ledger 的交易會照舊規則被讀取端當 cashflow——
  // 其中 source:'stmt' 的卡片消費就被誤算進現金流。這裡跑同一個 normalizeLedger（單一判準，勿另寫）。
  if (Array.isArray(cleanCollections.transactions)) normalizeLedger(cleanCollections.transactions);
  // 合併到乾淨底稿：缺少的集合補空陣列、缺少的設定補預設，避免壞檔讓之後 load/derive 出錯。
  // settings 走型別過濾（Codex）：錯型別的數值欄位（usdTwd:'oops'）會被剝掉→由 base 預設補上，
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
  if (isHosted()) {
    /** @type {Map<string, string>} */
    const kept = new Map();
    mapSecrets(await getDb(), (v, path) => { kept.set(path, v); return v; });
    mapSecrets(merged, (_v, path) => kept.get(path) ?? '');
  }
  // ⚠️ `{ overwrite: true }`（C4b）：`merged` 是這裡自己拼出來的**新物件**，沒有 getDb 的版本戳，
  // 而還原備份的語意本來就是「整包蓋掉」。櫃檯預設拒絕沒有版本戳的整包寫入（防呆），
  // 所以這條路必須明確寫出來——**全 repo 只有這一處可以這樣寫**。
  // HOSTED 的租戶綁定不靠這一行把關，而是結構性的：`merged` 裡任何 `user_id` 之類的頂層鍵，
  // 在櫃檯只寫 KV_KEYS 時就被丟掉；列屬於誰由 Postgres 的 `default auth.uid()`
  // ＋RLS 的 `with check` 決定——**匯入檔改不動它，也偽造不了別人的 user_id**（C0 對抗考題第 9 條）。
  await saveDb(merged, { overwrite: true });
  res.json({ ok: true });
}));
