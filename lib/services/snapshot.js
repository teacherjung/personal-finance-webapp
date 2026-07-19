// @ts-check
// 快照（B2 服務層）兩條線，差別在覆蓋的粒度：
//   月快照（snapshots／portfolioSnapshots）＝**同月覆蓋**，一個月只留一個點（長期趨勢用）
//   日線（dailyValues，D0）＝**同日覆寫、跨日累積**，一天一行（差異引擎 D3 的原料）
// 月快照算不出「今天 vs 昨天」——那正是加日線的理由，別把兩者的覆蓋規則搞混。
import { getDb, saveDb } from '../repo.js';
import { computeAssets, computeIb, monthKey } from '../derive.js';

/** 本地日期 YYYY-MM-DD（toISOString 是 UTC，台灣早上 8 點前會差一天）。 */
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 寫入本月快照本身（不含日線）。回傳淨資產快照物件。 */
function writeMonthlySnapshot() {
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
 * 記錄「今天」的淨值日線（D0）。**同日覆寫、跨日累積**——同一天內重跑會用最新值蓋掉今天這行，
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
 * 手動「記錄本月快照」（設定頁的按鈕）：月快照＋日線一起更新。
 * 日線也要寫（自審 r3）——不然使用者剛改完一筆大額資產、按了快照鈕，月份的點更新了、
 * 日線卻停在早上開 app 時的舊值，差異引擎算出來的「今天變化」會對不上他剛看到的數字。
 */
export function takeSnapshot() {
  recordDailyValue();
  return writeMonthlySnapshot();
}

/**
 * 自動快照（1-1：開 app 觸發）：月快照每個「本地日曆日」至多記一次——已是今天的日期就跳過，
 * 否則記錄並覆蓋本月（維持「本月＝最新淨值」，且不打擾使用者同日手動記的快照）。
 * 日線則**每次都寫**：同日覆寫不會長出多餘資料，而同日內資產有變動時日線才跟得上
 *（月快照跳過不代表日線也該跳過）。
 * ⚠️ 這裡刻意呼叫 `writeMonthlySnapshot` 而非 `takeSnapshot`——後者自己也會寫日線，
 * 會變成同一次開 app 寫兩遍全庫。
 * @returns {{recorded: boolean, snap: any, daily: import('../types.js').DailyValue}}
 *          recorded＝月快照這次是否真的寫入（前端只在 true 時提示＋刷新）
 */
export function takeSnapshotIfDue() {
  const daily = recordDailyValue();
  const db = getDb();
  const existing = (db.snapshots || []).find(s => s.month === monthKey());
  if (existing && existing.date === localToday()) return { recorded: false, snap: existing, daily };
  return { recorded: true, snap: writeMonthlySnapshot(), daily };
}
