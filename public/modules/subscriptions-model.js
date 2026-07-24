// @ts-check
// 訂閱攤提純函式（系統優化階段二②，2026-07-24 從 subscriptions.js 搬出、搬家不裝修）：
// 週期換算、月份工具、costForMonth（某月應計入金額）、amortizedForMonth（某月總攤提）、
// 計算方式文案（costFormula/costDetailRows）。**零依賴**（無 DOM/API/app.js）＝node 可直測
// 固定輸入輸出考題（同 securities-view.js/goal-tracking.js 前例）。
// ⚠️ subStatus **刻意不在這**：它吃 app.js 的 daysUntil（依「今天」而變）＝非固定輸入輸出，留在頁面層。
// ⚠️ 同步點：後端 lib/derive.js 的 subCostForMonth 是同一套口徑——**改攤提公式兩邊都要動**，
// 一致性由 test/subscriptions-model.test.js 的「前後端對照考題」鎖住（含兩處記錄在案的既有走散點）。

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
