// 退款歸屬（使用者定 2026-07-27）：信用卡費頁的分類統計與「本月消費」改用消費歸屬口徑，
// 與總覽月度回顧同一套判準（配對由後端 derive.pairRefunds 算，這裡只驗「拿配對結果做加總與標記」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refundLookups, consumptionCategoryTotals, unmatchedRefundsForMonth } from '../public/modules/refund-attribution.js';

const tx = (id, date, category, amount, extra = {}) => ({ id, date, category, amount, ...extra });

test('消費歸屬：退款抵減「原消費那個月的那一類」，退款當月不動', () => {
  const jan = tx('p1', '2026-01-12', '娛樂', 1700);
  const feb = tx('p2', '2026-02-03', '飲食', 500);
  const refund = tx('r1', '2026-03-16', '娛樂', -1700);
  const all = [jan, feb, refund];
  const pairs = [{ refundId: 'r1', purchaseId: 'p1', purchaseMonth: '2026-01', amount: 1700 }];

  const janRows = all.filter(t => t.date.startsWith('2026-01'));
  const marRows = all.filter(t => t.date.startsWith('2026-03'));
  assert.deepEqual({ ...consumptionCategoryTotals(janRows, all, pairs, '2026-01') }, { 娛樂: 0 }, '消費月被抵成 0');
  assert.deepEqual({ ...consumptionCategoryTotals(marRows, all, pairs, '2026-03') }, {}, '退款當月完全不動（那筆負數不算進 3 月）');
});

test('消費歸屬：抵減落在「原消費的分類」，不是退款自己的分類', () => {
  // 使用者把原消費改分類、退款那列還停在舊分類時，抵到退款的分類會讓一類變負、另一類永遠虛高
  const purchase = tx('p1', '2026-01-12', '娛樂', 1700);
  const refund = tx('r1', '2026-02-16', '其他', -1700);
  const all = [purchase, refund];
  const pairs = [{ refundId: 'r1', purchaseId: 'p1', purchaseMonth: '2026-01', amount: 1700 }];
  assert.deepEqual({ ...consumptionCategoryTotals([purchase], all, pairs, '2026-01') }, { 娛樂: 0 });
});

test('消費歸屬：未對應退款完全不計入（不會偷偷變成負數或假收入）', () => {
  const purchase = tx('p1', '2026-03-02', '飲食', 900);
  const orphan = tx('r9', '2026-03-20', '保險', -5198);   // 配不到 → pairs 裡沒有它
  const all = [purchase, orphan];
  const rows = all.filter(t => t.date.startsWith('2026-03'));
  assert.deepEqual({ ...consumptionCategoryTotals(rows, all, [], '2026-03') }, { 飲食: 900 });
});

test('消費歸屬：原消費不在這個帳本（現金流那本的退款）不干擾本頁', () => {
  const cardPurchase = tx('p1', '2026-01-05', '飲食', 300);
  const all = [cardPurchase];   // 信用卡帳本只有這一筆
  const pairs = [{ refundId: 'rX', purchaseId: '不在本帳本', purchaseMonth: '2026-01', amount: 999 }];
  assert.deepEqual({ ...consumptionCategoryTotals([cardPurchase], all, pairs, '2026-01') }, { 飲食: 300 });
});

test('降級路徑：配對表載不到時退回帳面口徑（退款算在退款當月）', () => {
  const purchase = tx('p1', '2026-03-02', '娛樂', 2000);
  const refund = tx('r1', '2026-03-20', '娛樂', -500);
  const rows = [purchase, refund];
  assert.deepEqual({ ...consumptionCategoryTotals(rows, rows, [], '2026-03', false) }, { 娛樂: 1500 });
});

test('分類名叫 toString／__proto__ 也不會壞掉（原型污染坑）', () => {
  const rows = [tx('p1', '2026-01-02', 'toString', 100), tx('p2', '2026-01-03', '__proto__', 50)];
  const out = consumptionCategoryTotals(rows, rows, [], '2026-01');
  assert.equal(out['toString'], 100);
  assert.equal(out['__proto__'], 50);
  assert.equal(typeof ({}).toString, 'function', '不可污染到全域原型');
});

test('兩端標記：退款列拿得到原消費月份、消費列拿得到已退金額', () => {
  const pairs = [
    { refundId: 'r1', purchaseId: 'p1', purchaseMonth: '2026-01', amount: 1700 },
    { refundId: 'r2', purchaseId: 'p2', purchaseMonth: '2026-02', amount: 60 },
  ];
  const { refundMonthOf, refundedOf } = refundLookups(pairs);
  assert.equal(refundMonthOf.get('r1'), '2026-01');
  assert.equal(refundMonthOf.get('r2'), '2026-02');
  assert.equal(refundedOf.get('p1'), 1700);
  assert.equal(refundedOf.get('p2'), 60);
  assert.equal(refundMonthOf.get('沒配到的'), undefined, '沒配到就不該有標記');
  // 壞資料不可炸畫面
  assert.doesNotThrow(() => refundLookups(null));
  assert.doesNotThrow(() => refundLookups([null, {}]));
});

test('未對應清單：只留本月、且只留這個帳本裡的那幾筆', () => {
  const all = [tx('r1', '2026-03-20', '保險', -5198), tx('r2', '2026-02-11', '健康', -300)];
  const unmatched = [
    { id: 'r1', date: '2026-03-20', amount: 5198, store: '友邦人壽' },
    { id: 'r2', date: '2026-02-11', amount: 300, store: '林口運動中心' },
    { id: 'bank1', date: '2026-03-05', amount: 88, store: '銀行帳本的退款' },   // 不在本帳本
  ];
  const got = unmatchedRefundsForMonth(unmatched, all, '2026-03');
  assert.deepEqual(got.map(u => u.id), ['r1']);
  assert.deepEqual(unmatchedRefundsForMonth(unmatched, all, '2026-02').map(u => u.id), ['r2']);
  assert.deepEqual(unmatchedRefundsForMonth(null, all, '2026-03'), []);
});
