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
 * 自動快照（1-1：開 app 觸發）：每個「本地日曆日」至多記一次——本月快照已是今天的日期就跳過，
 * 否則記錄並覆蓋本月（維持「本月＝最新淨值」，且不打擾使用者同日手動記的快照）。
 * @returns {{recorded: boolean, snap: any}} recorded＝這次是否真的寫入（前端只在 true 時提示＋刷新）
 */
export function takeSnapshotIfDue() {
  const db = getDb();
  const existing = (db.snapshots || []).find(s => s.month === monthKey());
  if (existing && existing.date === localToday()) return { recorded: false, snap: existing };
  return { recorded: true, snap: takeSnapshot() };
}
