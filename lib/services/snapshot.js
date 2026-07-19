// @ts-check
// 每月快照（B2 服務層）：同時記「淨資產快照」與投組「投入 vs 市值」快照，同月覆蓋。
import { getDb, saveDb } from '../repo.js';
import { computeAssets, computeIb, monthKey } from '../derive.js';

/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，台灣早上 8 點前會差一天）。 */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 記錄本月快照，回傳淨資產快照物件。 */
export function takeSnapshot() {
  const db = getDb();
  const a = computeAssets(db);
  const mk = monthKey();
  const localDate = localToday();
  const snap = { month: mk, date: localDate,
    netWorth: a.netWorth, assets: a.assets, liabilities: a.liabilities, byClass: a.byClass };
  db.snapshots = (db.snapshots || []).filter(s => s.month !== mk);
  db.snapshots.push(snap);
  db.snapshots.sort((x, y) => x.month.localeCompare(y.month));
  // 同時記錄投資組合的「投入 vs 市值」快照（重用 computeIb，避免重複算 FX/成本）
  const ib = computeIb(db);
  db.portfolioSnapshots = (db.portfolioSnapshots || []).filter(s => s.month !== mk);
  db.portfolioSnapshots.push({ month: mk, cost: Math.round(ib.totalCost), value: Math.round(ib.totalValue) });
  db.portfolioSnapshots.sort((x, y) => x.month.localeCompare(y.month));
  saveDb(db);
  return snap;
}

/**
 * 記錄「今天」的淨值日線（D0）。與月快照的關鍵差別：月快照**同月覆蓋**（手上永遠只有每月一個點，
 * 連「今天 vs 昨天」都算不出來），日線**同日覆寫、跨日累積**——同一天內重開 app 會用最新值蓋掉今天這行，
 * 跨到明天則新增一行。差異引擎（D3）的原料就是這條線。
 * @returns {import('../types.js').DailyValue} 剛寫入的今日這行
 */
export function recordDailyValue() {
  const db = getDb();
  const a = computeAssets(db);
  const ib = computeIb(db);
  const date = localToday();
  const row = {
    date,
    netWorth: Math.round(a.netWorth), assets: Math.round(a.assets), liabilities: Math.round(a.liabilities),
    pfCost: Math.round(ib.totalCost), pfValue: Math.round(ib.totalValue),
    usdTwd: Number(db.settings?.usdTwd || 32)   // 與 derive.js fxRates 同口徑（缺值用同一個預設）
  };
  db.dailyValues = (db.dailyValues || []).filter(d => d.date !== date);
  db.dailyValues.push(row);
  db.dailyValues.sort((x, y) => x.date.localeCompare(y.date));
  saveDb(db);
  return row;
}

/**
 * 自動快照（1-1：開 app 觸發）：每個「本地日曆日」至多記一次——本月快照已是今天的日期就跳過，
 * 否則記錄並覆蓋本月（維持「本月＝最新淨值」，且不打擾使用者同日手動記的快照）。
 * 日線（D0）則**每次都寫**：它是同日覆寫的，重寫一次只是把今天這行更新成最新值，不會長出多餘資料，
 * 而且同日內資產有變動時日線才跟得上（月快照跳過不代表日線也該跳過）。
 * @returns {{recorded: boolean, snap: any, daily: import('../types.js').DailyValue}}
 *          recorded＝月快照這次是否真的寫入（前端只在 true 時提示＋刷新）
 */
export function takeSnapshotIfDue() {
  const daily = recordDailyValue();
  const db = getDb();
  const existing = (db.snapshots || []).find(s => s.month === monthKey());
  if (existing && existing.date === localToday()) return { recorded: false, snap: existing, daily };
  return { recorded: true, snap: takeSnapshot(), daily };
}
