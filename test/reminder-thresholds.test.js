// 提醒安全網的「刻度不可被靜靜調鬆」考題（夜班稽核第四批B，2026-08-05）
//
// 起因＝2026-08-04 夜班突變體檢最清楚的一個結論：**核心算錢的地方守得非常紮實**
//（金額口徑、帳本判準、槓桿、內轉全部一動就紅），破口精準集中在「什麼時候該提醒你」——
// 七處門檻與視窗全都沒有踩在邊界上的考題：門檻拉高十倍、紅色提醒視窗從 60 天縮到 6 天、
// 樣本數從 3 個月鬆到 2 個月，1487 題完全無感。
//
// 這些刻度就是「生存優先」那張安全網的網目大小。網目被悄悄放大不會有任何徵兆——
// 提醒只是「沒出現」，而使用者不會發現一個本來該出現的提醒沒有出現。
//
// 每一題都刻意踩在**邊界的兩側**（該出現的要出現、不該出現的不可出現），
// 這樣門檻往任一方向漂都會轉紅。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, computeGoalTracking, monthKey, pairRefunds } from '../lib/derive.js';

/** 動態日期（2026-08-01 假紅事故的教訓：「本月／近月」語意的 fixture 不可寫死年月）。 */
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayIso = () => iso(new Date());
const daysFromNow = (n) => iso(new Date(Date.now() + n * 86400000));
const monthsAgo = (n) => { const d = new Date(); return monthKey(new Date(d.getFullYear(), d.getMonth() - n, 1)); };

const BASE = {
  settings: { usdTwd: 32, emergencyFundMonths: 6, allocationDriftPct: 5 },
  accounts: [], holdings: [], transactions: [], subscriptions: [], cards: [], insurance: [],
};
const summaryOf = (over) => buildSummary({ ...BASE, ...over, settings: { ...BASE.settings, ...(over.settings || {}) } });
const keysOf = (over) => summaryOf(over).reminders.map((/** @type {any} */ r) => r.key);
const findR = (over, key) => summaryOf(over).reminders.find((/** @type {any} */ r) => r.key === key);

// ─────────────────────────────────────────────────────────────────────────────
// 一、視窗兩端都要釘死（信用卡繳款、保險漏繳）
// ─────────────────────────────────────────────────────────────────────────────

test('提醒｜信用卡繳款：7 天內要出現，且 3 天內才升級成 warn（視窗與升級一題釘住）', () => {
  // ⚠️ 規則標題自己寫「7 天內」。視窗縮到 3 天的副作用更嚴重：level 是 `d <= 3 ? 'warn' : 'info'`，
  //    收到 3 之後 info 級整個變成打不到的死碼＝這張提醒再也不會有「提早幾天的溫和提示」階段。
  const cardWithDueIn = (days) => {
    const d = new Date(Date.now() + days * 86400000);
    return { cards: [{ id: 'c1', name: '測試卡', type: 'credit', dueDay: d.getDate() }] };
  };
  const soon = findR(cardWithDueIn(5), 'card-due-c1');
  assert.ok(soon, '繳款日在 5 天後＝落在 7 天視窗內，必須出現提醒（視窗縮小就會漏掉）');
  assert.equal(soon.level, 'info', '5 天後屬「溫和提示」階段（視窗縮到 3 天時這一階會變成死碼）');
  const urgent = findR(cardWithDueIn(2), 'card-due-c1');
  assert.ok(urgent, '2 天後當然要出現');
  assert.equal(urgent.level, 'warn', '3 天內要升級成 warn');
});

test('提醒｜保險繳費日已過：60 天視窗內必須是 danger，超過就不再提醒（兩端都釘）', () => {
  // ⚠️ 這個 60 是 2026-07-22 使用者定的自主體檢決議：nextPayment 是手動欄位、不會自動推進，
  //    繳費日一過提醒就無聲消失＝**最需要提醒的漏繳反而零訊號**。
  //    視窗縮到 6 天＝逾期第 7～60 天的漏繳全部靜音，而且那是 danger 級。
  const policy = (dateIso) => ({
    insurance: [{ id: 'p1', policyName: '測試保單', insured: '我', premium: 12000,
      premiumCycle: 'yearly', nextPayment: dateIso }],
  });
  const overdue30 = findR(policy(daysFromNow(-30)), 'ins-pay-p1');
  assert.ok(overdue30, '繳費日過了 30 天＝仍在 60 天視窗內，必須提醒（視窗縮小＝漏繳靜音）');
  assert.equal(overdue30.level, 'danger', '已過期是 danger 級（不可降級成溫和提示）');
  assert.match(overdue30.title, /已過 30 天/, '要說清楚過了幾天');
  assert.ok(!keysOf(policy(daysFromNow(-90))).includes('ins-pay-p1'),
    '過了 90 天＝超出視窗，不再提醒（視窗放大到無限＝提醒牆會被陳年舊帳塞滿）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、門檻的比較邊界（配置偏離、緊急預備金高估）
// ─────────────────────────────────────────────────────────────────────────────

test('提醒｜資產配置偏離「恰好等於」門檻時要出現（邊界含在內）', () => {
  // ⚠️ 恰好偏離 5.0%（＝設定值本身）時提醒消失＝典型的邊界無守衛（>= 改 > 全綠）。
  //    造法：現金 5 萬、股票 5 萬 ⇒ 各 50%；目標現金 45%／股票 55% ⇒ 偏離恰好 5.0%
  const over = {
    settings: { allocationDriftPct: 5 },
    accounts: [{ id: 'a1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 50000 }],
    holdings: [{ id: 'h1', symbol: 'CSPX', name: 'ETF', layer: 'core', currency: 'TWD', quantity: 1, price: 50000 }],
    assetTargets: [{ class: '現金', targetPct: 45 }, { class: '股票', targetPct: 55 }],
  };
  const hit = summaryOf(over).reminders.filter((/** @type {any} */ r) => String(r.key).startsWith('alloc-drift-'));
  assert.ok(hit.length > 0,
    '偏離恰好等於門檻（5.0%）時必須提醒——把 >= 改成 > 就會在邊界上靜靜消失');
  assert.ok(hit.some((/** @type {any} */ r) => /5\.0%/.test(r.title)), '標題要顯示 5.0% 的偏離量');
});

test('提醒｜緊急預備金高估：現金流月均明顯大於 0、但仍小於卡帳月均時也要出聲', () => {
  // ⚠️ 這是「安全網不可無聲」的過渡期保險。唯一守它的既有考題讓 avgExp 恰好是 0，
  //    所以 `cardAvg > 0` 永遠成立、比較式 `cardAvg > avgExp` 本身完全沒被測到：
  //    門檻改成 `cardAvg > avgExp * 10` 照樣全綠。
  //    現實中的半匯入狀態（銀行對帳單只匯了一部分、現金流月均 5,000 而卡帳月均 40,000）
  //    正是這張網要救的場景。
  const m1 = monthsAgo(1);
  const over = {
    accounts: [{ id: 'c1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 100000 }],
    cards: [{ id: 'card1', name: '測試卡', type: 'credit' }],
    transactions: [
      // 現金流帳本：月均約 5,000（明顯大於 0）
      { id: 't1', date: `${m1}-05`, type: 'expense', category: '生活', amount: 5000, ledger: 'cashflow' },
      // 卡帳本：月均約 40,000（遠大於現金流）
      { id: 't2', date: `${m1}-06`, type: 'expense', category: '生活', amount: 40000, ledger: 'card', source: 'stmt', cardId: 'card1' },
    ],
  };
  assert.ok(keysOf(over).includes('emergency-fund-optimistic'),
    '卡帳月均（40,000）遠大於現金流月均（5,000）＝可撐月數被高估，必須出聲'
    + '（門檻乘 10 之後這張網就靜靜關閉，而測試無感）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、樣本數與口徑（目標追蹤、訂閱狀態、退款配對）
// ─────────────────────────────────────────────────────────────────────────────

test('目標追蹤｜只有兩個月資料不可算出「預計達成」（至少三個月才敢講）', () => {
  // ⚠️ computeGoalTracking 的 JSDoc 明寫「兩者都至少要三個月份」。門檻鬆到 2 之後，
  //    只有兩個月資料就會算出速度與到達月數，把「還不知道」講成一個看起來可信的數字，
  //    使用者會照一個樣本數不足的估計做決定。
  const mk = (n) => `${monthsAgo(n)}-10`;
  const txFor = (months) => months.flatMap((n, i) => [
    { id: `i${i}`, date: mk(n), type: 'income', category: '工作', amount: 60000, ledger: 'cashflow' },
    { id: `e${i}`, date: mk(n), type: 'expense', category: '生活', amount: 30000, ledger: 'cashflow' },
  ]);
  const dbOf = (months) => ({
    ...BASE, settings: { ...BASE.settings, netWorthTarget: 10000000 },
    accounts: [{ id: 'c1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 1000000 }],
    transactions: txFor(months),
  });
  const two = computeGoalTracking(dbOf([1, 2]));
  assert.equal(two.savingsSpeed, null, '只有兩個月＝樣本不足，速度必須是 null（不可硬算）');
  assert.equal(two.monthsSavings, null, '到達月數也必須是 null');
  const three = computeGoalTracking(dbOf([1, 2, 3]));
  assert.ok(three.savingsSpeed !== null, '三個月才開始給速度（反面：門檻被改嚴也會紅）');
});

test('訂閱｜停用當天不算使用中（前後端同口徑的邊界）', () => {
  // ⚠️ subActive 是註解標明的前後端同步點（與前端 subStatus 同口徑：「停用日已過（daysUntil ≤ 0）不算」）。
  //    邊界從 > 0 鬆到 >= 0 之後，停用當天的訂閱在總覽被算成使用中、在訂閱頁不算，
  //    總覽「本月固定訂閱」的項數與訂閱頁互相打架。
  const subOn = (dateIso) => ({
    subscriptions: [{ id: 's1', name: '測試訂閱', amount: 300, cycle: 'monthly',
      since: `${monthsAgo(6)}-01`, endsOn: dateIso }],
  });
  const endsToday = summaryOf(subOn(todayIso())).subscriptions;
  assert.equal(endsToday.count, 0,
    '停用日就是今天＝已經不算使用中（邊界鬆掉會讓總覽與訂閱頁的項數打架）');
  const endsTomorrow = summaryOf(subOn(daysFromNow(1))).subscriptions;
  assert.equal(endsTomorrow.count, 1, '停用日在明天＝今天還算使用中（反面）');
});

test('退款配對｜同一天的消費與退款不配對（規則寫的是「日期較早」）', () => {
  // ⚠️ 四個配對條件之一是「消費日期較早」。鬆成「同一天也算」之後，同日買了又退
  //    （當場取消最常見）會被直接抵掉，月度回顧的分類金額與未對應退款數同時變動。
  //    現行刻意把它列為未對應退款——寧可擱置也不亂抵。
  // ⚠️ 考題設計（第一版是空包彈，突變驗證抓到）：配對候選的鑰匙＝[帳戶, 店家身分, 金額]，
  //    而卡片交易的「帳戶」是從 `stmtRef` 的第一段取的。fixture 少了 stmtRef ⇒ 鑰匙是空的 ⇒
  //    候選清單永遠是空的 ⇒ 日期比較根本走不到，`<` 改 `<=` 照樣綠。
  //    所以下面刻意附上完整的 stmtRef，並用「前一天」那組反面確認 fixture 真的配得起來。
  const mk = (dateIso, amount, id) => ({
    id, date: dateIso, type: 'expense', category: '生活', amount,
    ledger: 'card', source: 'stmt', cardId: 'card1',
    stmtRef: `card1|${dateIso}|${Math.abs(amount)}|星巴克`, storeKey: '星巴克', note: '星巴克',
  });
  const dbOf = (buyDate) => ({
    ...BASE, cards: [{ id: 'card1', name: '測試卡', type: 'credit' }],
    transactions: [mk(buyDate, 1700, 'buy'), mk(`${monthsAgo(1)}-15`, -1700, 'ref')],
  });

  // 反面先跑：消費在前一天＝必須配對得起來（證明這組 fixture 真的走到日期比較那一步）
  const earlier = pairRefunds(dbOf(`${monthsAgo(1)}-14`));
  assert.equal(earlier.pairs.length, 1, 'fixture 自我驗證：消費日較早時必須配對成功');

  // 正題：同一天不可配對
  const same = pairRefunds(dbOf(`${monthsAgo(1)}-15`));
  assert.equal(same.pairs.length, 0, '同一天不可配對（規則是「消費日期較早」）');
  assert.ok(same.unmatchedRefunds.some((/** @type {any} */ u) => u.id === 'ref'),
    '這筆退款要進 unmatchedRefunds（金額憑空消失比數字難看更危險）');
});
