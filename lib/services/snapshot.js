// @ts-check
// 每月快照（B2 服務層）：同時記「淨資產快照」與投組「投入 vs 市值」快照，同月覆蓋。
import { getDb, saveDb } from '../repo.js';
import { computeAssets, computeIb, monthKey } from '../derive.js';

/** 記錄本月快照，回傳淨資產快照物件。 */
export function takeSnapshot() {
  const db = getDb();
  const a = computeAssets(db);
  const mk = monthKey();
  const d = new Date();   // 本地日期（toISOString 是 UTC，台灣早上 8 點前會差一天）
  const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
