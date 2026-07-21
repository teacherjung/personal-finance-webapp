// @ts-check
// 每日洞察引擎（差異引擎，D3）：把「現在的狀態」接上時間維度，回答「自從上次看，投組變了什麼、app 又給了什麼新見解」。
// 設計原則（docs/每日洞察引擎-施工計畫.md）：解讀優先於價格、平靜日不造噪音、報喜也報憂、教育不建議、失敗靜默降級。
//
// ⚠️ **書籤更新時機**：`GET /api/insights` 被讀取＝視為「看過了」，當下更新書籤（insightState）。只有總覽會呼叫它。
// ⚠️ **read-await-write**：先 await 外部資料（CAPE/實質利率，market-data 快取、失敗靜默 null），**await 之後才 getDb→
//    算→寫**（全同步、無 await）——避免整包 db 跨 await 被別的寫入覆蓋（同 D1 refreshQuotesIfStale / syncIb r3#1）。
import { getDb, saveDb } from '../repo.js';
import { buildSummary } from '../derive.js';
import { getCape, getRealYield } from './market-data.js';
import { computeSignalTiers, ecyOf } from '../../public/modules/signal-tiers.js';

const TIER_MARKETS = /** @type {const} */ (['us', 'china', 'japan', 'korea', 'taiwan']);
const CALM_PCT_THRESHOLD = 0.3;   // |今日 Δ%| 低於此且無 🆕/✓/跳檔 → 平靜（施工時可調）

/** YYYY-MM-DD 加減天數（UTC 純日算術，DST 安全）。 @param {string} dateStr @param {number} delta @returns {string} */
function addDaysStr(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 排序後的日線列裡，找 date ≤ target 中最接近的一列（沒有回 null）。 @param {any[]} rows @param {string} target */
function closestOnOrBefore(rows, target) {
  let best = null;
  for (const r of rows) { if (r.date <= target) best = r; else break; }   // rows 升冪
  return best;
}

/**
 * 固定窗 Δ（今天／本週），從日線集合算。舊資料沒日線就找「最接近的既有日」比；資料不足就不顯示該窗（不硬算）。
 * @param {any[]} daily @returns {{today: any|null, week: any|null}}
 */
function computeWindows(daily) {
  const rows = (daily || [])
    .filter(d => d && typeof d.date === 'string' && typeof d.netWorth === 'number')
    .sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 2) return { today: null, week: null };
  const latest = rows[rows.length - 1];
  const pctOf = (from) => (from && from.netWorth) ? (latest.netWorth - from.netWorth) / from.netWorth * 100 : null;
  const win = (from) => (from && from.date !== latest.date)
    ? { fromDate: from.date, toDate: latest.date, delta: latest.netWorth - from.netWorth, pct: pctOf(from) }
    : null;
  const today = win(rows[rows.length - 2]);                              // 最近一個既有日（昨天或更早）
  const week = win(closestOnOrBefore(rows, addDaysStr(latest.date, -7))); // 約 7 天前的既有日
  return { today, week };
}

/** 把一條提醒壓成書籤要存的輕量快照（key＋顯示所需最小欄位）。 @param {any} r */
const snapshot = (r) => ({ key: String(r.key || ''), title: String(r.title || ''), module: String(r.module || ''), level: String(r.level || '') });

/**
 * 取得洞察並更新書籤（GET /api/insights 服務層）。
 * @param {{fetchImpl?: typeof fetch, now?: Date}} [opts] fetchImpl＝注入報價來源（測試）；now＝本次讀取時間（測試可固定）
 * @returns {Promise<any>}
 */
export async function getInsights(opts = {}) {
  const { fetchImpl, now } = opts;
  const nowIso = (now || new Date()).toISOString();

  // 1) await 之前：只抓外部估值資料（CAPE／實質利率），算 ECY。失敗靜默降級成 null（原則5，不擋、不吵）。
  let ecy = null;
  try {
    const [cape, ry] = await Promise.all([getCape({ fetchImpl }), getRealYield({ fetchImpl })]);
    ecy = ecyOf(cape?.value, ry?.value);
  } catch { /* 失敗靜默降級：ecy 維持初始 null（原則5） */ }

  // 2) await 之後才取整包 db（避免跨 await 覆蓋）；之後全同步、無 await。
  const db = getDb();
  const summary = buildSummary(db);
  const settings = db.settings || {};
  const tiers = computeSignalTiers({ signals: settings.signals || {}, ecy });
  const curReminders = (summary.reminders || []).map(snapshot);
  const curByKey = new Map(curReminders.map(r => [r.key, r]));
  const netWorth = summary.netWorth;
  const pfValue = summary.ib?.totalValue || 0;

  // 3) 讀書籤（空物件＝首次執行）
  const bm = (db.insightState && Object.keys(db.insightState).length) ? db.insightState : null;
  const firstRun = !bm;
  const prevReminders = Array.isArray(bm?.reminders) ? bm.reminders : [];
  const prevByKey = new Map(prevReminders.map((/** @type {any} */ r) => [r.key, r]));

  // 🆕 新出現 / ✓ 已解除 / 持續中（首次執行全當持續中、不標 🆕，避免假新鮮感洪水，見計畫§六）
  const newReminders = firstRun ? [] : curReminders.filter(r => !prevByKey.has(r.key));
  const clearedReminders = firstRun ? [] : prevReminders.filter((/** @type {any} */ r) => !curByKey.has(r.key));
  const ongoingReminders = firstRun ? curReminders : curReminders.filter(r => prevByKey.has(r.key));

  // 跳檔（估值檔位變動）：兩邊都有值且不同才算——null↔值（資料剛填/剛清）不當跳檔（免假訊號）
  const tierChanges = [];
  if (!firstRun && bm?.tiers) {
    for (const m of TIER_MARKETS) {
      const before = bm.tiers[m], after = tiers[m];
      if (before != null && after != null && before !== after) tierChanges.push({ market: m, from: before, to: after });
    }
  }

  // 自上次 Δ（有書籤才算；首次不顯示，只顯示固定窗）
  const sinceLast = firstRun ? null : {
    netWorth: netWorth - (Number(bm.netWorth) || 0),
    pfValue: pfValue - (Number(bm.pfValue) || 0),
  };

  // 固定窗 Δ（今天／本週）
  const windows = computeWindows(db.dailyValues || []);

  // 平靜判定：無 🆕、無 ✓、無跳檔、且 |今日 Δ%| 低於門檻（或無今日窗）
  const todayPct = windows.today?.pct;
  const calm = !newReminders.length && !clearedReminders.length && !tierChanges.length
    && (todayPct == null || Math.abs(todayPct) < CALM_PCT_THRESHOLD);

  // 4) 更新書籤（讀取＝看過了）：roll lastSeenAt→prevSeenAt，存目前快照。同一次寫檔（此處無 await，db 未過期）。
  const prevSeenAt = bm?.lastSeenAt || null;
  db.insightState = {
    lastSeenAt: nowIso, prevSeenAt,
    netWorth, pfValue,
    reminders: curReminders,
    tiers,
    usdTwd: Number(settings.usdTwd) || null,
  };
  saveDb(db);

  return {
    firstRun,
    seenAt: nowIso,
    prevSeenAt,
    netWorth, pfValue,
    sinceLast,
    windows,
    tiers, ecy,
    reminders: { new: newReminders, cleared: clearedReminders, ongoing: ongoingReminders, all: curReminders },
    tierChanges,
    calm,
  };
}
