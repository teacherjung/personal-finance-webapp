// 月度回顧 P1：消費視角的兩帳聯集、退款跨月配對與分類彙總。
// 只用合成資料，不讀取任何真實 store。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumptionByMonth, buildMonthlyReview } from '../lib/derive.js';

const tx = (id, date, amount, extra = {}) => ({
  id, date, amount, type: 'expense', ledger: 'card', source: 'stmt',
  account: '合成測試卡', storeKey: '星巴克', note: '星巴克', category: '飲食', subcategory: '飲料／咖啡',
  stmtRef: `card-1|${date}|${amount}|星巴克`, ...extra,
});

test('consumptionByMonth：跨月退款抵回原消費月與原分類，退款月不變負', () => {
  const out = consumptionByMonth({ transactions: [
    tx('buy', '2026-05-10', 500),
    tx('refund', '2026-07-02', -500, { category: '其他', subcategory: '未分類', note: '星巴克退款' }),
    tx('cash', '2026-05-12', 300, { ledger: 'cashflow', source: 'bank', account: '現金', storeKey: '市場', category: '生活', subcategory: '', stmtRef: undefined }),
  ] });

  assert.equal(out.byMonth['2026-05']['飲食'].total, 0, '退款歸原購買月與原分類');
  assert.equal(out.byMonth['2026-05']['生活'].total, 300, '現金流帳本也要納入消費視角');
  assert.equal(out.byMonth['2026-07'], undefined, '退款本身不應讓退款月出現負消費');
  assert.deepEqual(out.unmatchedRefunds, []);
});

test('consumptionByMonth：先匯退款時擱置，後補舊月消費會自癒', () => {
  const refund = tx('refund', '2026-07-02', -500, { note: '星巴克退款' });
  const first = consumptionByMonth({ transactions: [refund] });
  assert.equal(first.unmatchedRefunds.length, 1);
  assert.equal(first.unmatchedRefunds[0].amount, 500);
  assert.deepEqual(Object.keys(first.byMonth), [], '孤兒退款不可出現在任何月份');

  const healed = consumptionByMonth({ transactions: [refund, tx('buy', '2026-05-10', 500)] });
  assert.equal(healed.unmatchedRefunds.length, 0);
  assert.equal(healed.byMonth['2026-05']['飲食'].total, 0);
});

test('consumptionByMonth：部分退款不亂抵；同額退款一對一、優先最近的較早消費', () => {
  const out = consumptionByMonth({ transactions: [
    tx('old', '2026-04-01', 500),
    tx('recent', '2026-05-01', 500),
    tx('refund-1', '2026-07-01', -500),
    tx('refund-2', '2026-07-02', -500),
    tx('partial', '2026-07-03', -200),
    tx('extra-refund', '2026-07-04', -500),
  ] });

  assert.equal(out.byMonth['2026-05']['飲食'].total, 0, '第一筆先抵最近的 5 月');
  assert.equal(out.byMonth['2026-04']['飲食'].total, 0, '第二筆才抵 4 月，同一消費不重複用');
  assert.deepEqual(out.unmatchedRefunds.map(r => r.amount), [200, 500], '部分退款與多出的退款都明示擱置');
});

test('consumptionByMonth：同店同額也不可跨卡或用同日交易配對，且不修改 db', () => {
  const db = { transactions: [
    tx('card-a-buy', '2026-05-01', 500),
    tx('card-b-refund', '2026-07-01', -500, { stmtRef: 'card-2|2026-07-01|-500|星巴克退款' }),
    tx('same-day-buy', '2026-06-01', 800, { storeKey: '書店', stmtRef: 'card-1|2026-06-01|800|書店' }),
    tx('same-day-refund', '2026-06-01', -800, { storeKey: '書店', stmtRef: 'card-1|2026-06-01|-800|書店退款' }),
  ] };
  const before = JSON.stringify(db);
  const out = consumptionByMonth(db);

  assert.equal(out.byMonth['2026-05']['飲食'].total, 500);
  assert.equal(out.byMonth['2026-06']['飲食'].total, 800);
  assert.deepEqual(out.unmatchedRefunds.map(r => r.amount), [800, 500]);
  assert.equal(JSON.stringify(db), before, '彙總只能推導，不可偷寫 refundOf 或改交易');
});

test('consumptionByMonth：排除繳卡費、外幣、壞日期與非支出；使用者文字不污染原型', () => {
  const protoCategory = JSON.parse('{"id":"proto","date":"2026-05-03","amount":100,"type":"expense","ledger":"cashflow","category":"__proto__","subcategory":"toString","account":"cash","storeKey":"shop"}');
  const out = consumptionByMonth({ transactions: [
    protoCategory,
    tx('payment', '2026-05-04', 10_000, { ledger: 'cashflow', source: 'bank', category: '', subcategory: '', note: '信用卡款', stmtRef: undefined }),
    tx('usd', '2026-05-05', 100, { currency: 'USD' }),
    tx('bad-date', '2026-02-31', 100),
    tx('income', '2026-05-06', 100, { type: 'income' }),
    tx('transfer', '2026-05-07', 100, { type: 'transfer' }),
  ] });

  assert.equal(out.byMonth['2026-05']['__proto__'].total, 100);
  assert.equal(out.byMonth['2026-05']['__proto__'].subs.toString, 100);
  assert.equal(Object.getPrototypeOf(out.byMonth), null);
  assert.equal(Object.getPrototypeOf(out.byMonth['2026-05']), null);
  assert.equal(Object.getPrototypeOf(out.byMonth['2026-05']['__proto__'].subs), null);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(Object.keys(out.byMonth), ['2026-05']);
});

test('buildMonthlyReview：只列已結清月、不補記帳前假月，分類百分比與現金流透支分開', () => {
  const db = { transactions: [
    tx('a', '2026-03-03', 300, { category: '飲食', subcategory: '' }),
    tx('b', '2026-03-04', 100, { category: '生活', subcategory: '日用品' }),
    tx('income', '2026-03-10', 250, { type: 'income', ledger: 'cashflow', source: undefined, category: '工作', subcategory: '薪資', stmtRef: undefined }),
    tx('cash-expense', '2026-03-11', 400, { ledger: 'cashflow', source: 'bank', account: '現金', storeKey: '房東', category: '居住', subcategory: '房租', stmtRef: undefined }),
    tx('current', '2026-07-01', 999),
  ] };
  const out = buildMonthlyReview(db, '2026-03', new Date(2026, 6, 22));

  assert.deepEqual(out.months.map(m => m.month), ['2026-03', '2026-04', '2026-05', '2026-06']);
  assert.equal(out.months[0].total, 800, '消費視角同時收 card 與 cashflow');
  assert.equal(out.months[1].hasData, false, '開始記帳後的空檔要誠實標記');
  assert.equal(out.months.some(m => m.month === '2026-07'), false, '本月不列入');
  assert.equal(out.selected.total, 800);
  assert.deepEqual(out.selected.categories.map(c => [c.name, c.amount, c.pct]), [
    ['居住', 400, 50], ['飲食', 300, 37.5], ['生活', 100, 12.5],
  ]);
  assert.equal(out.selected.categories.find(c => c.name === '飲食').subcategories[0].name, '（未分子類）');
  assert.deepEqual(out.selected.cashflow, { month: '2026-03', income: 250, expense: 400, net: -150, overdraft: true, overdraftAmount: 150 });
});
