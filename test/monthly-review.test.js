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

test('buildMonthlyReview：未指定月份時跳過尚未匯入的空月，明點空月仍照選', () => {
  const db = { transactions: [
    tx('may', '2026-05-08', 500, { category: '飲食' }),
  ] };
  const now = new Date(2026, 6, 22);

  const defaultReview = buildMonthlyReview(db, '', now);
  assert.deepEqual(defaultReview.months.map(m => [m.month, m.total]), [['2026-05', 500], ['2026-06', 0]]);
  assert.equal(defaultReview.selectedMonth, '2026-05', '最新已結清月空白時，預設應回到最近有消費的月份');

  const requestedEmpty = buildMonthlyReview(db, '2026-06', now);
  assert.equal(requestedEmpty.selectedMonth, '2026-06', '使用者明點空月時仍須尊重選擇');
});

// ── 回饋（點數折抵）＝負數列的第三格（使用者定 2026-08-06）─────────────────────────────
// 判準本身的正負例在 test/reward-credit.test.js；這裡測的是「進了 pairRefunds 之後行為變成怎樣」。
const reward = (id, date, amount, extra = {}) => tx(id, date, amount, {
  storeKey: '折帳單', note: '折帳單（信用卡點數折抵消費）', category: '其他', subcategory: '未分類',
  stmtRef: `card-1|${date}|${amount}|折帳單_信用卡點數折抵消費`, ...extra,
});

test('回饋｜不進退款配對：配對身分真的撞上時，那筆真消費不會被抵掉', () => {
  // ⚠️ **配對身分不是 storeKey，是帳單原文算出來的 refundPairKeyOf**（lib/derive.js 的 refundPairIdentity）。
  //    第一版這題的 fixture 給消費與回饋兩種不同的原文（`某店消費` vs `折帳單_…`）＝兩把鑰匙根本不同，
  //    回饋本來就配不到任何東西 ⇒ 就算把「回饋提前 continue」整段拿掉、讓它照常進配對池，這題照樣全綠。
  //    （Grok 掃描 2026-08-23 抓到；我實跑那個突變確認 12 題全過＝原版是空包彈。）
  //    正解＝兩組的配對鑰匙**都相同**（都是 `星巴克`），唯一的變因只有負數列原文帶不帶回饋字樣。
  const buy = (id) => tx(id, '2026-05-10', 365, { note: '星巴克', stmtRef: 'card-1|2026-05-10|365|星巴克' });

  // 對照組：同一把鑰匙、負數列**沒有**回饋字樣 ⇒ 是普通退款 ⇒ 配得起來、5 月被抵成 0
  const asRefund = consumptionByMonth({ transactions: [
    buy('buy'),
    tx('neg', '2026-06-14', -365, { note: '星巴克退貨', stmtRef: 'card-1|2026-06-14|-365|退貨_星巴克' }),
  ] });
  assert.equal(asRefund.byMonth['2026-05']['飲食'].total, 0, '對照組沒配起來＝這題證明不了任何事（鑰匙沒對上？）');
  assert.equal(asRefund.rewards.length, 0, '對照組不該有回饋');

  // 實驗組：**同一把鑰匙**、負數列帶回饋字樣 ⇒ 不進配對池 ⇒ 5 月那 365 原封不動
  const asReward = consumptionByMonth({ transactions: [
    buy('buy'),
    tx('rw', '2026-06-14', -365, { note: '點數折抵（星巴克）', stmtRef: 'card-1|2026-06-14|-365|點數折抵_星巴克' }),
  ] });
  assert.equal(asReward.byMonth['2026-05']['飲食'].total, 365, '回饋把真消費抵掉了');
  assert.deepEqual(asReward.unmatchedRefunds, [], '回饋不該落進未對應退款清單');
  assert.equal(asReward.rewards.length, 1);
  assert.equal(asReward.rewards[0].amount, 365, '回饋金額要取絕對值＝畫面講「有多少錢」');
});

test('回饋｜自己的月份不長出負數、不新增分類', () => {
  const out = consumptionByMonth({ transactions: [reward('rw', '2026-06-14', -365)] });
  assert.deepEqual(Object.keys(out.byMonth), [], '回饋自己不可長出任何月份');
  assert.equal(out.rewards.length, 1);
});

test('回饋｜讓位給真退款：三列同一把配對鑰匙時，消費該被真退款抵、不該被回饋佔走', () => {
  // 同卡、**同一把配對鑰匙（星巴克）**、同金額：一筆消費、一筆較早的回饋、一筆較晚的真退款。
  // 回饋若仍進配對池，它日期較早會先把消費配走 ⇒ 真退款被擠進未對應清單、5 月不會歸零。
  const rows = [
    tx('buy', '2026-05-10', 365, { note: '星巴克', stmtRef: 'card-1|2026-05-10|365|星巴克' }),
    tx('rw', '2026-05-20', -365, { note: '點數折抵（星巴克）', stmtRef: 'card-1|2026-05-20|-365|點數折抵_星巴克' }),
    tx('ref', '2026-06-14', -365, { note: '星巴克退貨', stmtRef: 'card-1|2026-06-14|-365|退貨_星巴克' }),
  ];
  const out = consumptionByMonth({ transactions: rows });
  assert.equal(out.byMonth['2026-05']['飲食'].total, 0, '真退款沒有抵到那筆消費（被回饋佔走了？）');
  assert.deepEqual(out.unmatchedRefunds, [], '真退款被擠到未對應清單去了');
  assert.equal(out.rewards.length, 1, '回饋要獨立成一格');
  assert.equal(out.rewards[0].id, 'rw');
});

test('回饋｜繳款優先：同時像繳款又像回饋的說明仍走繳款那格（順序不可調換）', () => {
  const out = consumptionByMonth({ transactions: [
    tx('pay', '2026-06-20', -1000, {
      storeKey: '折帳單', note: '自動轉帳扣繳信用卡款 折帳單',
      stmtRef: 'card-1|2026-06-20|-1000|自動轉帳扣繳信用卡款_折帳單',
    }),
  ] });
  assert.deepEqual(out.unmatchedRefunds, []);
  assert.deepEqual(out.rewards, [], '繳款被判成回饋了——三格的順序被調換過');
});

test('回饋｜月度回顧的回饋格與未對應退款同為全庫口徑（窗口外的回饋不可從畫面消失）', () => {
  // 回饋日期刻意放在「近六個已結清月」之外——那正是使用者真實資料的處境（2025-09 的折抵）。
  const now = new Date(2026, 7, 24);   // 2026-08-24：窗口＝2026-02〜2026-07
  const review = buildMonthlyReview({ transactions: [
    reward('rw', '2025-09-14', -365),
    tx('buy', '2026-06-10', 500),
  ] }, '', now);
  assert.equal(review.rewards.count, 1, '窗口外的回饋在月度回顧上整個看不見了');
  assert.equal(review.rewards.total, 365);
  assert.equal(review.rewards.items[0].store, '折帳單（信用卡點數折抵消費）');
  assert.equal(review.unmatchedRefunds.count, 0, '回饋不該同時出現在未對應退款那一格');
});
