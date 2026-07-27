// @ts-check
// 快照（B2 服務層）兩條線，差別在覆蓋的粒度：
//   月快照（snapshots／portfolioSnapshots）＝**同月覆蓋**，一個月只留一個點（長期趨勢用）
//   日線（dailyValues，D0）＝**同日覆寫、跨日累積**，一天一行（差異引擎 D3 的原料）
// 月快照算不出「今天 vs 昨天」——那正是加日線的理由，別把兩者的覆蓋規則搞混。
import { getDb, saveDb } from '../repo.js';
import { rollDueSubscriptions } from './subscriptions.js';   // 開 app 的每日維護：續費日過期自動推到下一期（2026-07-26）
import { computeAssets, computeIb } from '../derive.js';

/**
 * 本地「現在」只擷取一次，同一次流程共用（Codex r3#8）：
 * 每呼叫一次就重讀時鐘的話，跨午夜那一瞬間會拿到不同日期，讓「判斷該不該寫」與
 * 「實際寫哪一天」對不上（判斷時還是 19 號、寫入時已是 20 號）。
 * @returns {{date: string, month: string}} 本地日 YYYY-MM-DD 與月份 YYYY-MM（toISOString 是 UTC，台灣早上 8 點前會差一天）
 */
export function nowLocal() {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { date, month: date.slice(0, 7) };
}

/**
 * 時鐘倒退保護（Codex r3#8）：電腦時間被調回過去（手動改、時區設錯、虛擬機還原）時，
 * 「同日覆寫／同月覆蓋」會拿**舊資料蓋掉更新的歷史**——已記錄好的 07-20 快照，
 * 在時鐘變成 07-19 時會被整個換掉，而那是純歷史、補不回來。
 * 判準：現在的日期比「資料庫裡最新的一天」還早 → 不寫。
 * @param {any} db @param {string} today
 * @returns {string} 空字串＝可以寫；非空＝資料庫裡最新的那一天（不該寫的理由）
 */
function clockWentBackwards(db, today) {
  const maxOf = (/** @type {any[]} */ list) => (list || []).reduce((m, /** @type {any} */ r) =>
    (r?.date && String(r.date) > m ? String(r.date) : m), '');
  const latest = [maxOf(db.dailyValues), maxOf(db.snapshots)].sort().pop() || '';
  return (latest && today < latest) ? latest : '';
}

/** 寫入本月快照本身（不含日線）。回傳淨資產快照物件。 @param {{date:string, month:string}} now */
async function writeMonthlySnapshot(now) {
  const db = await getDb();
  const a = computeAssets(db);
  const snap = { month: now.month, date: now.date,
    netWorth: a.netWorth, assets: a.assets, liabilities: a.liabilities, byClass: a.byClass };
  db.snapshots = (db.snapshots || []).filter(s => s.month !== now.month);
  db.snapshots.push(snap);
  db.snapshots.sort((x, y) => x.month.localeCompare(y.month));
  // 同時記錄投資組合的「投入 vs 市值」快照（重用 computeIb，避免重複算 FX/成本）
  const ib = computeIb(db);
  db.portfolioSnapshots = (db.portfolioSnapshots || []).filter(s => s.month !== now.month);
  db.portfolioSnapshots.push({ month: now.month, cost: Math.round(ib.totalCost), value: Math.round(ib.totalValue) });
  db.portfolioSnapshots.sort((x, y) => x.month.localeCompare(y.month));
  await saveDb(db);
  return snap;
}

/**
 * 記錄「今天」的淨值日線（D0）。**同日覆寫、跨日累積**——同一天內重跑會用最新值蓋掉今天這行，
 * 跨到明天則新增一行。差異引擎（D3）的原料就是這條線。
 * **三種匯率都留底**（Codex r3#10）：系統支援 USD/GBP/JPY 三種外幣，只存 usdTwd 的話，
 * 日後看到淨值變動也分不出是「資產本身漲了」還是「英鎊/日圓匯率動了」——那正是 D3 要解讀的事。
 * @param {{date:string, month:string}=} now 共用同一次擷取的時間（不給就自己取）
 * @returns {Promise<import('../types.js').DailyValue|null>} 剛寫入的今日這行；時鐘倒退時回 null（不寫）
 */
export async function recordDailyValue(now = nowLocal()) {
  const db = await getDb();
  const back = clockWentBackwards(db, now.date);
  if (back) {
    console.warn(`[snapshot] 現在的日期（${now.date}）比資料庫裡最新的一天（${back}）還早，略過寫入日線——` +
      '電腦時間可能不正確；硬寫會拿舊資料蓋掉更新的歷史紀錄，而那補不回來。');
    return null;
  }
  const a = computeAssets(db);
  const ib = computeIb(db);
  const fx = /** @type {any} */ (db.settings?.fxTwd) || {};
  const row = {
    date: now.date,
    netWorth: Math.round(a.netWorth), assets: Math.round(a.assets), liabilities: Math.round(a.liabilities),
    pfCost: Math.round(ib.totalCost), pfValue: Math.round(ib.totalValue),
    usdTwd: Number(db.settings?.usdTwd || 32),   // 與 derive.js fxRates 同口徑（缺值用同一個預設）
    gbpTwd: Number(fx.GBP || 0), jpyTwd: Number(fx.JPY || 0)
  };
  db.dailyValues = (db.dailyValues || []).filter(d => d.date !== now.date);
  db.dailyValues.push(row);
  db.dailyValues.sort((x, y) => x.date.localeCompare(y.date));
  await saveDb(db);
  return row;
}

/**
 * 手動「記錄本月快照」（設定頁的按鈕）：月快照＋日線一起更新。
 * 日線也要寫（自審 r3）——不然使用者剛改完一筆大額資產、按了快照鈕，月份的點更新了、
 * 日線卻停在早上開 app 時的舊值，差異引擎算出來的「今天變化」會對不上他剛看到的數字。
 * 時鐘倒退時**明確擋下並說明**（不是安靜略過）：使用者按鈕的本意是「記錄現在」，
 * 不是「刪掉更新的歷史」——這種情況要讓他看見，才有機會去修系統時間。
 */
export async function takeSnapshot() {
  const now = nowLocal();
  const back = clockWentBackwards(await getDb(), now.date);
  if (back) {
    throw Object.assign(new Error(
      `電腦目前的日期（${now.date}）比已經記錄的最新資料（${back}）還早。為了不覆蓋更新的歷史紀錄，這次沒有記錄。請先確認系統時間是否正確。`),
    { status: 400 });
  }
  await recordDailyValue(now);
  return writeMonthlySnapshot(now);
}

/**
 * 自動快照（1-1：開 app 觸發）：月快照每個「本地日曆日」至多記一次——已是今天的日期就跳過，
 * 否則記錄並覆蓋本月（維持「本月＝最新淨值」，且不打擾使用者同日手動記的快照）。
 * 日線則**每次都寫**：同日覆寫不會長出多餘資料，而同日內資產有變動時日線才跟得上
 *（月快照跳過不代表日線也該跳過）。
 * ⚠️ 這裡刻意呼叫 `writeMonthlySnapshot` 而非 `takeSnapshot`——後者自己也會寫日線，
 * 會變成同一次開 app 寫兩遍全庫。
 * @returns {Promise<{recorded: boolean, snap: any, daily: import('../types.js').DailyValue|null, skipped?: string,
 *          subsRolled?: {id:string,name:string,from:string,to:string}[]}>} subsRolled＝這次自動推進的訂閱續費日
 *          recorded＝月快照這次是否真的寫入（前端只在 true 時提示＋刷新）
 */
export async function takeSnapshotIfDue() {
  const now = nowLocal();
  const db0 = await getDb();
  const back = clockWentBackwards(db0, now.date);
  // 自動流程遇到時鐘倒退＝安靜略過（開 app 不該跳錯誤打擾；console 有警告可查）
  if (back) {
    console.warn(`[snapshot] 現在的日期（${now.date}）比資料庫裡最新的一天（${back}）還早，本次自動快照與日線全部略過。`);
    return { recorded: false, snap: (db0.snapshots || []).find(s => s.month === now.month) || null, daily: null, skipped: back };
  }
  const daily = await recordDailyValue(now);
  // 訂閱續費日自動推進（使用者定 2026-07-26）：掛在同一個「開 app 每日維護」入口，
  // 與月快照的節流無關——**每次開 app 都要檢查**（過期一天也該立刻歸位），沒有要推就不寫檔。
  // 時鐘倒退時上面已整段 return，這裡自然也不會跑（同一道護欄）。
  const { rolled } = await rollDueSubscriptions(now.date);
  const existing = ((await getDb()).snapshots || []).find(s => s.month === now.month);
  if (existing && existing.date === now.date) return { recorded: false, snap: existing, daily, subsRolled: rolled };
  return { recorded: true, snap: await writeMonthlySnapshot(now), daily, subsRolled: rolled };
}
