// 退款歸屬（使用者定 2026-07-27）：信用卡費頁的分類統計與「本月消費」改用消費歸屬口徑，
// 與總覽月度回顧同一套判準（配對由後端 derive.pairRefunds 算，這裡只驗「拿配對結果做加總與標記」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refundLookups, consumptionCategoryTotals, topSpendCategories, unmatchedRefundsForMonth, rewardsForMonth } from '../public/modules/refund-attribution.js';

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

test('兩端標記：退款列拿得到原消費日、消費列拿得到退款日（使用者定 2026-07-27 第二版）', () => {
  // 標日期不標月份：同一個月可能有好幾筆同店消費，月份指不出是哪一筆
  const pairs = [
    { refundId: 'r1', purchaseId: 'p1', purchaseDate: '2026-02-22', purchaseMonth: '2026-02', refundDate: '2026-03-16', amount: 8800 },
    { refundId: 'r2', purchaseId: 'p2', purchaseDate: '2026-01-05', purchaseMonth: '2026-01', refundDate: '2026-02-11', amount: 60 },
  ];
  const { purchaseDateOf, refundDateOf } = refundLookups(pairs);
  assert.equal(purchaseDateOf.get('r1'), '2026-02-22');
  assert.equal(purchaseDateOf.get('r2'), '2026-01-05');
  assert.equal(refundDateOf.get('p1'), '2026-03-16');
  assert.equal(refundDateOf.get('p2'), '2026-02-11');
  assert.equal(purchaseDateOf.get('沒配到的'), undefined, '沒配到就不該有標記');
  assert.equal(refundDateOf.get('沒被退的'), undefined);
  // 壞資料不可炸畫面
  assert.doesNotThrow(() => refundLookups(null));
  assert.doesNotThrow(() => refundLookups([null, {}]));
});

test('長條清單：整筆被退掉的分類不畫成 0 元空長條（Codex 複審 2026-07-27）', () => {
  // 病徵：某月只有一筆 娛樂 1,700，後來配對成功退款 1,700 → byCat={娛樂:0}
  //       → 舊寫法仍畫出「娛樂 0 元」一條空長條，且與月度回顧不一致（後端輸出分類時就過濾 total>0）
  const purchase = tx('p1', '2026-01-12', '娛樂', 1700);
  const refund = tx('r1', '2026-03-16', '娛樂', -1700);
  const pairs = [{ refundId: 'r1', purchaseId: 'p1', purchaseMonth: '2026-01', amount: 1700 }];
  const byCat = consumptionCategoryTotals([purchase], [purchase, refund], pairs, '2026-01');
  assert.deepEqual({ ...byCat }, { 娛樂: 0 }, '加總本身仍是 0（資料層不說謊）');
  assert.deepEqual(topSpendCategories(byCat), [], '畫面層不畫它 → 落到「本月尚無消費」空狀態');
});

test('長條清單：排序、取前六、負數要留著', () => {
  const totals = { 飲食: 860, 娛樂: 0, 交通: -1200, 學習: 80, 生活: 3000, 健康: 500, 保險: 20, 居住: 5 };
  const got = topSpendCategories(totals);
  assert.deepEqual(got.map(([n]) => n), ['生活', '交通', '飲食', '健康', '學習', '保險'], '依金額絕對值大到小取前六');
  assert.equal(got.find(([n]) => n === '交通')?.[1], -1200,
    '帳面口徑（配對表載不到）下淨負＝這個月淨收回，是真資訊，不可跟著 0 一起濾掉');
  assert.ok(!got.some(([n]) => n === '娛樂'), '0 不畫');
  // 壞資料不可炸畫面
  assert.deepEqual(topSpendCategories(null), []);
  assert.deepEqual(topSpendCategories({ 飲食: 'abc' }), [], '不是數字＝當 0，不畫');
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

test('回饋按月篩：與未對應退款同一把尺（信用卡費頁是按月看的那一頭）', () => {
  // ⚠️ 這一題是 Grok 掃描 2026-08-23 第 3 條補的：在此之前 `rewardsForMonth` 在整個 test/ 裡**零次**出現，
  //    只有 API 那頭有題（斷言 body.rewards 存在）。前端若漏接這個欄位、或改成自己拿字樣重算，
  //    當時沒有任何一題會轉紅——而信用卡費頁角落那筆錢就會消失。
  const all = [
    { id: 'rw1', date: '2026-03-14', amount: -365 },
    { id: 'rw2', date: '2026-02-09', amount: -120 },
  ];
  const rewards = [
    { id: 'rw1', date: '2026-03-14', amount: 365, store: '折帳單（信用卡點數折抵消費）' },
    { id: 'rw2', date: '2026-02-09', amount: 120, store: '點數折抵' },
    { id: 'ghost', date: '2026-03-02', amount: 99, store: '不在本帳本的回饋' },
  ];
  assert.deepEqual(rewardsForMonth(rewards, all, '2026-03').map(r => r.id), ['rw1']);
  assert.deepEqual(rewardsForMonth(rewards, all, '2026-02').map(r => r.id), ['rw2']);
  assert.deepEqual(rewardsForMonth(rewards, all, '2026-01'), [], '沒有回饋的月份要回空陣列');
  assert.deepEqual(rewardsForMonth(null, all, '2026-03'), [], '端點沒回 rewards 時不可炸掉整頁');
  assert.deepEqual(rewardsForMonth(undefined, all, '2026-03'), []);
});
