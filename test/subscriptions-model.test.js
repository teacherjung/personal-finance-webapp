// 訂閱攤提純函式考題（系統優化階段二②）：subscriptions-model.js 零依賴、直接 import 斷言
//（同 securities-view/goal-tracking 前例）。分兩部：
// 一、固定輸入輸出題——鎖住每個純函式的行為。
// 二、**前後端對照考題**（本檔的存在理由）：前端 costForMonth 與後端 derive.js subCostForMonth
//     是同一套口徑的兩份實作（同步點註解互指），用同一組案例雙邊對照，防兩邊走散＝
//     訂閱頁顯示的錢與總覽/緊急預備金算的錢不一致。首跑抓到的兩處走散點已於 2026-07-24
//     結案（#264），由文末對照考題與 schema 邊界題持續鎖住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECORD_START, CYCLE_MONTHS, cycleMonths, isLifetimeSub, feeMonthVal, feeYearVal, monthlyCost,
  addMonths, daysInMonth, dayOfMonth, costForMonth, activeInMonth, amortizedForMonth,
  costFormula, costDetailRows,
} from '../public/modules/subscriptions-model.js';
import { subCostForMonth } from '../lib/derive.js';
import { validateImportItem, sanitizeDbForWrite } from '../lib/schema.js';

/** 造一筆合成訂閱（絕不用真實資料）；預設月繳、使用中、從 2026-06 起算 */
const mk = (over = {}) => ({ id: 'sub-x', name: '測試服務', cycle: 'monthly', amount: 390, status: 'active', active: true, since: '2026-06', ...over });

// ---------- 一、固定輸入輸出題 ----------

test('週期換算：feeMonthVal／feeYearVal 各週期四捨五入、終身一律 0、缺金額 0', () => {
  assert.equal(feeMonthVal(mk({ cycle: 'quarterly', amount: 900 })), 300);
  assert.equal(feeYearVal(mk({ cycle: 'quarterly', amount: 900 })), 3600);
  assert.equal(feeMonthVal(mk({ cycle: 'yearly', amount: 999 })), 83);    // 999/12=83.25 → 83
  assert.equal(feeYearVal(mk({ cycle: 'yearly', amount: 999 })), 999);
  assert.equal(feeMonthVal(mk({ cycle: 'semiannual', amount: 1800 })), 300);
  assert.equal(feeMonthVal(mk({ cycle: 'lifetime', amount: 9999 })), 0);
  assert.equal(feeYearVal(mk({ cycle: 'lifetime', amount: 9999 })), 0);
  assert.equal(feeMonthVal(mk({ amount: undefined })), 0);
  // 未知週期（壞資料）＝當月繳處理（CYCLE_MONTHS 查無 → 1）
  assert.equal(cycleMonths(mk({ cycle: 'weekly' })), 1);
  assert.equal(isLifetimeSub(mk({ cycle: 'lifetime' })), true);
  assert.equal(CYCLE_MONTHS.yearly, 12);
  // monthlyCost＝攤提地基：不取整（999/12=83.25），取整只發生在顯示層 feeMonthVal
  assert.equal(monthlyCost(mk({ cycle: 'yearly', amount: 999 })), 83.25);
  assert.equal(monthlyCost(mk({ cycle: 'lifetime', amount: 999 })), 0);
});

test('addMonths：跨年進位／退位、補零', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-03', 14), '2027-05');
  assert.equal(addMonths('2026-11', -25), '2024-10');
  assert.equal(addMonths('2026-09', 0), '2026-09');
});

test('daysInMonth：平年 2 月 28、閏年 2 月 29、大小月', () => {
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29);   // 閏年
  assert.equal(daysInMonth('2026-04'), 30);
  assert.equal(daysInMonth('2026-12'), 31);
});

test('dayOfMonth：正常取日；沒有日的字串／空值回 0（不硬猜）', () => {
  assert.equal(dayOfMonth('2026-07-05'), 5);
  assert.equal(dayOfMonth('2026-07-31'), 31);
  assert.equal(dayOfMonth('2026-07'), 0);
  assert.equal(dayOfMonth(''), 0);
  assert.equal(dayOfMonth('亂七八糟'), 0);
});

test('costForMonth：使用中月繳＝月費；停用當月月繳＝0（那個月不再扣款）；停用月之後＝0', () => {
  assert.equal(costForMonth(mk(), '2026-07'), 390);
  assert.equal(costForMonth(mk({ endsOn: '2026-07-15' }), '2026-07'), 0);
  assert.equal(costForMonth(mk({ endsOn: '2026-07-15' }), '2026-06'), 390);   // 停用前一個月照算
  assert.equal(costForMonth(mk({ endsOn: '2026-07-15' }), '2026-08'), 0);
});

test('costForMonth：季/年繳停用當月按「該月實際天數」比例；滿月停用不打折（自主體檢 Q4）', () => {
  // 季繳 930 → 月攤提 310；7/15 停用 → 310 × 15/31 = 150
  assert.equal(costForMonth(mk({ cycle: 'quarterly', amount: 930, endsOn: '2026-07-15' }), '2026-07'), 150);
  // 平年 2/28 滿月停用＝整月（舊 bug：固定 30 天分母會算成 28/30 打折）
  assert.equal(costForMonth(mk({ cycle: 'yearly', amount: 1200, since: '2026-01', endsOn: '2026-02-28' }), '2026-02'), 100);
  // 閏年 2/29 滿月停用＝整月
  assert.equal(costForMonth(mk({ cycle: 'yearly', amount: 1200, since: '2028-01', endsOn: '2028-02-29' }), '2028-02'), 100);
  // 小月 4/30 滿月；4/15 → 半個月
  assert.equal(costForMonth(mk({ cycle: 'quarterly', amount: 900, since: '2026-04', endsOn: '2026-04-30' }), '2026-04'), 300);
  assert.equal(costForMonth(mk({ cycle: 'quarterly', amount: 900, since: '2026-04', endsOn: '2026-04-15' }), '2026-04'), 150);
});

test('costForMonth：since 起算月起算、之前 0；已停用（status/active 兩種寫法）0；終身 0', () => {
  assert.equal(costForMonth(mk({ since: '2026-07' }), '2026-07'), 390);
  assert.equal(costForMonth(mk({ since: '2026-07' }), '2026-06'), 0);
  assert.equal(costForMonth(mk({ status: 'ended' }), '2026-07'), 0);
  assert.equal(costForMonth(mk({ active: false }), '2026-07'), 0);
  assert.equal(costForMonth(mk({ cycle: 'lifetime', amount: 9999 }), '2026-07'), 0);
  // 缺 since 的舊資料＝退用 RECORD_START 當地板（2026-06 前不計）
  assert.equal(costForMonth(mk({ since: undefined }), addMonths(RECORD_START, -1)), 0);
  assert.equal(costForMonth(mk({ since: undefined }), RECORD_START), 390);
});

test('activeInMonth／amortizedForMonth：>0 判定與總額加總', () => {
  assert.equal(activeInMonth(mk(), '2026-07'), true);
  assert.equal(activeInMonth(mk({ endsOn: '2026-07-01', cycle: 'monthly' }), '2026-07'), false);
  const subs = [mk(), mk({ id: 'b', cycle: 'quarterly', amount: 900 }), mk({ id: 'c', status: 'ended' })];
  assert.equal(amortizedForMonth(subs, '2026-07'), 690);   // 390 + 300 + 0
  assert.equal(amortizedForMonth([], '2026-07'), 0);
});

test('costFormula：月繳「月費」；季/年繳「÷ N」；停用當月加「× 日 / 該月天數」', () => {
  assert.equal(costFormula(mk(), '2026-07'), '月費');
  assert.equal(costFormula(mk({ cycle: 'quarterly' }), '2026-07'), '季費 ÷ 3');
  assert.equal(costFormula(mk({ cycle: 'yearly' }), '2026-07'), '年費 ÷ 12');
  assert.equal(costFormula(mk({ cycle: 'quarterly', endsOn: '2026-07-15' }), '2026-07'), '季費 ÷ 3 × 15 / 31');
  assert.equal(costFormula(mk({ cycle: 'yearly', endsOn: '2026-02-28' }), '2026-02'), '年費 ÷ 12 × 28 / 28');
});

test('costDetailRows：只留計入>0 的列、金額高→低、同額依服務名 zh-Hant', () => {
  const rows = costDetailRows([
    mk({ name: '乙服務', amount: 200 }),
    mk({ name: '甲服務', amount: 200 }),
    mk({ name: '大戶', cycle: 'quarterly', amount: 1500 }),   // 月攤提 500
    mk({ name: '停了', status: 'ended' }),
  ], '2026-07');
  assert.deepEqual(rows.map(r => r.service), ['大戶', '乙服務', '甲服務']);   // 500 > 200×2（zh-Hant 按筆畫：乙 1 畫 < 甲 5 畫）
  assert.deepEqual(rows.map(r => r.amount), [500, 200, 200]);
  assert.equal(rows[0].cycle, '季繳');
  assert.equal(rows[0].formula, '季費 ÷ 3');
});

// ---------- 二、前後端對照考題（同步點保險）----------
// 同一筆訂閱、同一個月份，前端 costForMonth（訂閱頁顯示）與後端 subCostForMonth
//（總覽固定訂閱/緊急預備金）必須算出同一個數字——否則使用者兩頁看到不同的錢。

/** 斷言前後端同值，且等於期望值 */
const both = (s, month, expected, msg) => {
  const fe = costForMonth(s, month);
  const be = subCostForMonth(s, month);
  assert.equal(fe, be, `前後端不一致（${msg}）：前端 ${fe} vs 後端 ${be}`);
  assert.equal(fe, expected, `期望值不符（${msg}）`);
};

test('前後端對照：五種週期的基本攤提', () => {
  both(mk({ cycle: 'monthly', amount: 390 }), '2026-07', 390, '月繳');
  both(mk({ cycle: 'quarterly', amount: 900 }), '2026-07', 300, '季繳');
  both(mk({ cycle: 'semiannual', amount: 1800 }), '2026-07', 300, '半年繳');
  both(mk({ cycle: 'yearly', amount: 3600 }), '2026-07', 300, '年繳');
  both(mk({ cycle: 'lifetime', amount: 9999 }), '2026-07', 0, '終身');
  both(mk({ cycle: 'weekly', amount: 500 }), '2026-07', 500, '未知週期＝當月繳');
});

test('前後端對照：since 起算月／起算前', () => {
  both(mk({ since: '2026-07' }), '2026-07', 390, '起算當月');
  both(mk({ since: '2026-07' }), '2026-06', 0, '起算前一月');
  both(mk({ cycle: 'yearly', amount: 1200, since: '2026-01' }), '2026-03', 100, '明確 since 的歷史月');
});

test('前後端對照：停用月語意（月繳當月 0；季/年繳按實際天數比例；停用後 0）', () => {
  both(mk({ endsOn: '2026-07-15' }), '2026-07', 0, '月繳停用當月');
  both(mk({ endsOn: '2026-07-15' }), '2026-06', 390, '月繳停用前月');
  both(mk({ endsOn: '2026-07-15' }), '2026-08', 0, '停用月之後');
  both(mk({ cycle: 'quarterly', amount: 930, endsOn: '2026-07-15' }), '2026-07', 150, '季繳 7/15 停（31 天月）');
  both(mk({ cycle: 'quarterly', amount: 900, since: '2026-04', endsOn: '2026-04-15' }), '2026-04', 150, '季繳 4/15 停（30 天月）');
  both(mk({ cycle: 'yearly', amount: 1200, since: '2026-01', endsOn: '2026-02-28' }), '2026-02', 100, '平年 2/28 滿月停＝不打折');
  both(mk({ cycle: 'yearly', amount: 1200, since: '2028-01', endsOn: '2028-02-29' }), '2028-02', 100, '閏年 2/29 滿月停＝不打折');
  both(mk({ cycle: 'semiannual', amount: 1860, endsOn: '2026-07-31' }), '2026-07', 310, '大月 7/31 滿月停＝不打折');
});

test('前後端對照：已停用與缺欄位', () => {
  both(mk({ status: 'ended' }), '2026-07', 0, 'status ended');
  both(mk({ active: false }), '2026-07', 0, 'active false');
  both(mk({ amount: undefined }), '2026-07', 0, '缺金額');
});

test('前後端對照：整包總額（amortizedForMonth vs 後端逐筆加總）', () => {
  const subs = [
    mk(), mk({ id: 'b', cycle: 'quarterly', amount: 900 }), mk({ id: 'c', cycle: 'yearly', amount: 3600 }),
    mk({ id: 'd', status: 'ended' }), mk({ id: 'e', cycle: 'lifetime', amount: 777 }),
    mk({ id: 'f', cycle: 'quarterly', amount: 930, endsOn: '2026-07-15' }),
  ];
  const beSum = subs.reduce((t, s) => t + subCostForMonth(s, '2026-07'), 0);
  assert.equal(amortizedForMonth(subs, '2026-07'), beSum);
  assert.equal(beSum, 390 + 300 + 300 + 0 + 0 + 150);
});

// ---------- 走散點結案（2026-07-24 對照考題首跑發現 → Codex 修正單 → William 照准） ----------
// ①統一：後端補 RECORD_START 地板（單一真相＝本檔常數、derive.js 直接 import）。
// ②不改公式：月份型 endsOn 定義為「非法輸入、由資料入口拒絕」——一致性契約範圍＝通過 schema 的合法訂閱資料，
//   不替結構上進不來的輸入決定該少算還是多算；改用邊界考題證明三個強制點都擋得住。

test('走散點①已修正：缺 since 的舊訂閱——前後端同用 RECORD_START 地板，2026-06 前不虛構歷史費用、當月起正常計費', () => {
  const s = mk({ since: undefined });
  both(s, '2026-05', 0, '地板前的歷史月＝兩邊都 0');
  both(s, RECORD_START, 390, 'RECORD_START 當月＝兩邊正常計費');
  both(s, '2026-07', 390, '地板後的月份＝兩邊正常計費');
});

test('走散點②結案：endsOn 只有年月＝非法輸入，匯入與寫入櫃檯都拒絕、strip 搬家剝欄——公式永遠收不到 YYYY-MM', () => {
  const bad = { name: '測試服務', cycle: 'quarterly', amount: 900, status: 'active', active: true, since: '2026-06', endsOn: '2026-07' };
  // 匯入強制點：逐筆列 errors → 路由整份 400（isRealDate 只認真實 YYYY-MM-DD）
  const v = validateImportItem('subscriptions', bad);
  assert.ok(v.errors.some(e => e.includes('endsOn')), `匯入驗證要點名 endsOn（實得：${v.errors.join(',')}）`);
  // 寫入櫃檯強制點：throw 模式當場擋下（任何寫入路徑結構上繞不過 store.save 的驗證牆）
  assert.throws(() => sanitizeDbForWrite({ settings: {}, subscriptions: [bad] }, { mode: 'throw' }));
  // 舊 JSON 搬家 strip 模式：非必填壞欄位剝除、列保留 → 攤提公式永遠收不到月份型 endsOn
  const stripped = sanitizeDbForWrite({ settings: {}, subscriptions: [bad] }, { mode: 'strip' });
  assert.equal(stripped.subscriptions.length, 1, 'strip＝剝欄不濾列（endsOn 非必填）');
  assert.equal('endsOn' in stripped.subscriptions[0], false, 'strip 後 endsOn 已剝除');
  // CRUD 強制點（400）在 test/server.test.js 有對應 HTTP 考題（同一把 FIELD_SCHEMA 尺）
});
