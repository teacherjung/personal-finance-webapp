// @ts-check
// 訂閱攤提純函式（系統優化階段二②，2026-07-24 從 subscriptions.js 搬出、搬家不裝修）：
// 週期換算、月份工具、costForMonth（某月應計入金額）、amortizedForMonth（某月總攤提）、
// 計算方式文案（costFormula/costDetailRows）。**零依賴**（無 DOM/API/app.js）＝node 可直測
// 固定輸入輸出考題（同 securities-view.js/goal-tracking.js 前例）。
// ⚠️ subStatus **刻意不在這**：它吃 app.js 的 daysUntil（依「今天」而變）＝非固定輸入輸出，留在頁面層。
// ⚠️ 同步點：後端 lib/derive.js 的 subCostForMonth 是同一套口徑——**改攤提公式兩邊都要動**，
// 一致性由 test/subscriptions-model.test.js 的「前後端對照考題」鎖住（兩處走散點已於 2026-07-24
// 結案＝#264：缺 since 兩邊同用本檔 RECORD_START、月份型 endsOn 由 schema 邊界題擋在門外）。

export const RECORD_START = '2026-06';   // 從這個月開始記錄訂閱費

export const CYCLE_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12, lifetime: 1 };
export const CYCLE_LABELS = { monthly: '月繳', quarterly: '季繳', semiannual: '半年', yearly: '年繳', lifetime: '終身' };
export const CYCLE_FEE_LABELS = { monthly: '月費', quarterly: '季費', semiannual: '半年費', yearly: '年費', lifetime: '終身' };
// 月費 / 年費 換算（四捨五入到整數）
export const cycleMonths = (s) => CYCLE_MONTHS[s.cycle] || 1;
export const isLifetimeSub = (s) => s.cycle === 'lifetime';
export const feeMonthVal = (s) => isLifetimeSub(s) ? 0 : Math.round(Number(s.amount || 0) / cycleMonths(s));
export const feeYearVal = (s) => isLifetimeSub(s) ? 0 : Math.round(Number(s.amount || 0) * 12 / cycleMonths(s));

export const monthlyCost = (s) => isLifetimeSub(s) ? 0 : Number(s.amount || 0) / cycleMonths(s);

// ---- 月份工具（monthKey 由 app.js 提供）----
export function addMonths(mk, n) { let [y, m] = mk.split('-').map(Number); m += n; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; }

// 該月實際天數（自主體檢 Q4：分母用實際天數，2/28 滿月停用＝算滿月，不再固定 30 天打折）
export function daysInMonth(mk) { const [y, m] = String(mk).split('-').map(Number); return new Date(y, m, 0).getDate(); }
export function dayOfMonth(dateStr) {
  const n = Number(String(dateStr || '').slice(8, 10));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---- 續費日自動推進（使用者定 2026-07-26：「沒有任何改到的時候直接推到下一期，除非我手動輸入停用日」）----
// 為什麼需要：`nextCharge` 是使用者手填的固定日期、不會自己走。日期一過，那筆訂閱就從
// 「未來 30 天」的續費時間線上消失（使用者 2026-07-26 回報「怎麼都沒有即將扣款的訂閱」）。
// ⚠️ 只動「下一次要扣款的日子」，**不碰任何金額**：攤提（costForMonth）看的是 since／endsOn／
// amount／cycle，跟 nextCharge 無關——推日期不會改變任何一個月已經算好的錢（有考題鎖住）。
/** 日期加 N 個月；目標月沒有那天就收到當月最後一天（1/31＋1 月＝2/28）。 @param {string} dateStr YYYY-MM-DD @param {number} n */
export function addMonthsToDate(dateStr, n) {
  const [y, m, d] = String(dateStr || '').split('-').map(Number);
  if (!(y > 0 && m >= 1 && m <= 12 && d >= 1)) return '';
  const mk = addMonths(`${y}-${String(m).padStart(2, '0')}`, n);
  const last = daysInMonth(mk);
  return `${mk}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * 這筆訂閱的續費日該推到哪一天；不需要推（或不該推）回 null。
 * 不推的情況：終身、已停用／已結束、**使用者手動填了停用日或標成即將停用**（使用者定：這種就別自己動）、
 * 沒有合法續費日、續費日還沒到（含今天＝今天要扣，維持顯示「今天」）。
 * 逾期很久也只推到「第一個未來的日期」＝一次補到位，不是每期補一筆（本 app 不記錄過去的扣款）。
 * ⚠️ 每一期都從**原始日期**加 N 個月算，不是拿收月底後的結果再加——否則 1/31 會一路縮成 28 號。
 * @param {any} sub @param {string} todayIso YYYY-MM-DD @returns {string|null}
 */
export function rolledNextCharge(sub, todayIso) {
  const s = sub || {};
  if (isLifetimeSub(s) || s.status === 'ended' || s.active === false) return null;
  if (s.status === 'ending' || s.endsOn) return null;   // 使用者手動輸入停用日＝不自動推
  const base = String(s.nextCharge || '');
  const today = String(todayIso || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  if (base >= today) return null;   // 還沒到期（含今天）
  const step = cycleMonths(s);
  if (!Number.isFinite(step) || step < 1) return null;
  for (let k = 1; k <= 1200; k++) {   // 上限 100 年份的期數＝純防呆，正常情況一兩圈就跳出
    const next = addMonthsToDate(base, step * k);
    if (!next) return null;
    if (next >= today) return next === base ? null : next;
  }
  return null;
}

// 某訂閱在指定月份應計入的金額（月繳用月費；季/年繳攤提到每月，停用當月按天數比例）
export function costForMonth(s, mk) {
  if (isLifetimeSub(s)) return 0;
  const since = s.since || RECORD_START;
  if (mk < since) return 0;
  const base = monthlyCost(s);
  const endsOn = s.endsOn || '';
  if (!endsOn) return s.active === false || s.status === 'ended' ? 0 : base;
  const endMk = endsOn.slice(0, 7);
  if (endMk < mk) return 0;
  if (s.cycle === 'monthly') return endMk === mk ? 0 : base;
  if (endMk === mk) { const dim = daysInMonth(mk); return base * Math.min(dayOfMonth(endsOn), dim) / dim; }
  return base;
}

// 某訂閱在指定月份是否仍需付費
export function activeInMonth(s, mk) {
  return costForMonth(s, mk) > 0;
}

// 某月份的訂閱攤提總額。依「當下所有訂閱狀態」即時計算
export function amortizedForMonth(subs, mk) {
  return subs.reduce((t, s) => t + costForMonth(s, mk), 0);
}

export function costFormula(s, mk) {
  const endMk = (s.endsOn || '').slice(0, 7);
  const day = dayOfMonth(s.endsOn);
  if (s.cycle === 'monthly') return '月費';
  const base = `${CYCLE_FEE_LABELS[s.cycle] || '月費'} ÷ ${cycleMonths(s)}`;
  if (s.endsOn && endMk === mk) { const dim = daysInMonth(mk); return `${base} × ${Math.min(day, dim)} / ${dim}`; }
  return base;
}

export function costDetailRows(subs, mk) {
  return subs.map(s => ({
    service: s.name,
    cycle: CYCLE_LABELS[s.cycle] || '月繳',
    formula: costFormula(s, mk),
    amount: costForMonth(s, mk)
  })).filter(r => r.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.service.localeCompare(b.service, 'zh-Hant'));
}
