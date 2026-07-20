// @ts-check
// 核心路由（B2）：整包資料/總覽/設定/快照/自訂分類/備份匯出入。
import { Router } from 'express';
import { getDb, saveDb, getSettings, updateSettings, emptyDb } from '../repo.js';
import { sanitizeSettings, validateImportItem, sanitizeLearned, COLLECTIONS, READONLY_COLLECTIONS } from '../schema.js';
import { buildSummary, monthKey } from '../derive.js';
import { projectDb, projectSettings } from '../secret-fields.js';
import { takeSnapshot, takeSnapshotIfDue } from '../services/snapshot.js';
import { effectiveTree, saveTree } from '../services/categories.js';

export const coreRoutes = Router();

// ---- 整份資料 ----
coreRoutes.get('/api/db', (req, res) => res.json(projectDb(getDb())));   // 剝機密（自主體檢）：僅資產頁用、只讀 accounts
coreRoutes.get('/api/summary', (req, res) => res.json(buildSummary(getDb())));

coreRoutes.get('/api/settings', (req, res) => res.json(projectSettings(getSettings())));   // 剝 flexToken（自主體檢）
// 白名單＋型別過濾：擋未知欄位、IB 同步擁有的 lastEquity/income/lastSync、以及錯型別（usdTwd:'oops'→NaN）
coreRoutes.put('/api/settings', (req, res) => res.json(updateSettings(sanitizeSettings(req.body))));

// ---- 每月淨資產快照（隨時間變化的主軸）----
coreRoutes.post('/api/snapshot', (req, res) => res.json(takeSnapshot()));
// 自動快照（1-1）：開 app 呼叫，每個本地日曆日至多記一次（已記今天就跳過，不重複寫、不打擾手動快照）
coreRoutes.post('/api/snapshot/auto', (req, res) => res.json(takeSnapshotIfDue()));

// ---- 自訂支出分類樹（大類＋子類）：讀目前生效的樹／儲存新樹（含改名連動更新）----
coreRoutes.get('/api/categories', (req, res) => res.json(effectiveTree()));
coreRoutes.post('/api/categories', (req, res) => {
  // tree 必須明確存在且為物件（Codex#6）：缺 tree 會被 sanitizeTree 當成「刪光→只剩其他/未分類」、
  // 把所有支出交易改歸未分類。要真的刪光，前端仍會送明確的 tree:{}（sanitizeTree 保底其他/未分類）。
  const b = req.body;
  if (!b || typeof b.tree !== 'object' || b.tree === null || Array.isArray(b.tree)) {
    return res.status(400).json({ error: '缺少分類樹（tree），未做任何變更' });
  }
  res.json(saveTree(b));
});

// 舊「分類轉換（一次性）」已移除（使用者定 2026-07-18）：使用者資料早已全數轉換為兩層分類、
// 按鈕實測回 0 筆；日後分類調整一律走「分類管理」（/api/categories）。極舊備份若需轉換，
// 程式碼在 git 歷史（CATEGORY_MIGRATION，PR #92 前）可撈回。

// ---- 匯出 / 匯入備份 ----
coreRoutes.get('/api/export', (req, res) => {
  // ⚠️ 備份必須是**完整**資料（含 pdfPassword/flexToken）——投影過的備份還原後密碼會永久遺失。
  res.setHeader('Content-Disposition', `attachment; filename="finance-backup-${monthKey()}.json"`);
  res.json(getDb());
});
coreRoutes.post('/api/import', (req, res) => {
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
  for (const nested of ['signals', 'fxTwd', 'ib', 'expenseTree', 'categoryAliases', 'subAliases', 'storeRules']) {
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
  if (itemErrors.length) {
    return res.status(400).json({ error: `匯入檔有不合法的欄位值（枚舉/布林），已中止：${itemErrors.slice(0, 8).join('；')}` });
  }
  // 合併到乾淨底稿：缺少的集合補空陣列、缺少的設定補預設，避免壞檔讓之後 load/derive 出錯。
  // settings 走型別過濾（Codex）：錯型別的數值欄位（usdTwd:'oops'）會被剝掉→由 base 預設補上，
  // 不會讓 NaN 污染 netWorth/槓桿；allowIbSyncFields 保留備份的 lastEquity/income/lastSync（仍深層驗型別）。
  const cleanSettings = sanitizeSettings(b.settings, { allowIbSyncFields: true });
  const merged = {
    ...base, ...b, ...cleanCollections,
    // learnedCategories：value 非物件（{bad:null}）會讓設定頁讀 v.name 崩 → 清理
    learnedCategories: sanitizeLearned(b.learnedCategories),
    settings: {
      ...base.settings, ...cleanSettings,
      signals: { ...base.settings.signals, ...(cleanSettings.signals || {}) },
      fxTwd: { ...base.settings.fxTwd, ...(cleanSettings.fxTwd || {}) },
      ib: { ...base.settings.ib, ...(cleanSettings.ib || {}) }
    }
  };
  saveDb(merged);
  res.json({ ok: true });
});
