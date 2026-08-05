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
// ⚠️ 第一版的教訓（Codex #413 r1 阻擋，值得原地記下來）：檔頭原本就寫著「每一題都刻意踩在
//    邊界的兩側」，但 fixture 用的是 5／2 天、−30／−90 天、40,000／5,000 這種**離邊界很遠**的數字。
//    「兩側」不等於「相鄰兩格」：離得遠的兩側只擋得住把刻度改到天邊的突變，
//    刻度往旁邊挪一格（7→5、3→2、−60→−30、`> avgExp` → `> avgExp * 2`）照樣全綠。
//    現在每一題都釘在**相鄰的兩格**上：該出現的最後一格必須出現、外面第一格必須不出現。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSummary, computeGoalTracking, monthKey, pairRefunds } from '../lib/derive.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

test('提醒｜信用卡繳款：第 7 天要出現、第 8 天不可出現；第 4 天仍 info、第 3 天升 warn（四格相鄰邊界）', () => {
  // ⚠️ 規則標題自己寫「7 天內」。視窗縮小的副作用更嚴重：level 是 `d <= 3 ? 'warn' : 'info'`，
  //    視窗收到 3 之後 info 級整個變成打不到的死碼＝這張提醒再也不會有「提早幾天的溫和提示」階段。
  //    這裡把視窗尾端（7／8）與升級門檻（4／3）四格全部釘住，刻度往任一方向挪一格都會紅。
  const cardWithDueIn = (days) => {
    const d = new Date(Date.now() + days * 86400000);
    return { cards: [{ id: 'c1', name: '測試卡', type: 'credit', dueDay: d.getDate() }] };
  };
  const last = findR(cardWithDueIn(7), 'card-due-c1');
  assert.ok(last, '第 7 天＝視窗最後一格，必須出現（視窗收到 6 天以下就會紅）');
  assert.equal(last.level, 'info', '第 7 天屬「溫和提示」階段');
  assert.match(last.title, /7 天後/, '標題要說清楚剩幾天');
  assert.ok(!keysOf(cardWithDueIn(8)).includes('card-due-c1'),
    '第 8 天＝視窗外第一格，不可出現（視窗放大到 8 天以上就會紅）');

  const mild = findR(cardWithDueIn(4), 'card-due-c1');
  assert.ok(mild, '第 4 天當然要出現');
  assert.equal(mild.level, 'info', '第 4 天還在溫和提示階段（升級門檻放寬到 4 就會紅）');
  const urgent = findR(cardWithDueIn(3), 'card-due-c1');
  assert.ok(urgent, '第 3 天當然要出現');
  assert.equal(urgent.level, 'warn', '第 3 天＝升級成 warn 的第一格（升級門檻收到 2 就會紅）');
});

test('提醒｜保險繳費日已過：第 60 天仍是 danger、第 61 天不再提醒（視窗尾端的相鄰兩格）', () => {
  // ⚠️ 這個 60 是 2026-07-22 使用者定的自主體檢決議：nextPayment 是手動欄位、不會自動推進，
  //    繳費日一過提醒就無聲消失＝**最需要提醒的漏繳反而零訊號**。
  //    視窗縮小＝那一段逾期的漏繳全部靜音，而且那是 danger 級。
  const policy = (dateIso) => ({
    insurance: [{ id: 'p1', policyName: '測試保單', insured: '我', premium: 12000,
      premiumCycle: 'yearly', nextPayment: dateIso }],
  });
  const lastDay = findR(policy(daysFromNow(-60)), 'ins-pay-p1');
  assert.ok(lastDay, '逾期第 60 天＝視窗最後一格，必須提醒（視窗縮小＝漏繳靜音）');
  assert.equal(lastDay.level, 'danger', '已過期是 danger 級（不可降級成溫和提示）');
  assert.match(lastDay.title, /已過 60 天/, '要說清楚過了幾天');
  assert.ok(!keysOf(policy(daysFromNow(-61))).includes('ins-pay-p1'),
    '逾期第 61 天＝視窗外第一格，不再提醒（視窗放大＝提醒牆會被陳年舊帳塞滿）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、門檻的比較邊界（配置偏離、緊急預備金高估）
// ─────────────────────────────────────────────────────────────────────────────

test('提醒｜資產配置偏離：恰好等於門檻要出現、差 0.1% 不出現，且正負偏離各自都要出聲', () => {
  // ⚠️ 兩件事一起釘：
  //    (a) 邊界：恰好偏離 5.0%（＝設定值本身）時提醒消失＝典型的邊界無守衛（>= 改 > 全綠）；
  //        另一側用 4.9% 釘住「門檻不可被偷偷調小」。
  //    (b) 方向：判準是 `Math.abs(row.diff) >= 門檻`。⚠️ 只斷言「有任何一張 alloc-drift 出現」
  //        的話，拿掉 Math.abs 照樣全綠（正偏離那張還在）——所以**正負兩張分別點名**。
  //  造法：現金 5 萬、股票 5 萬 ⇒ 各 50%；目標 45/55 ⇒ 偏離恰好 +5.0%／−5.0%
  const alloc = (cashTarget, stockTarget) => ({
    settings: { allocationDriftPct: 5 },
    accounts: [{ id: 'a1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 50000 }],
    holdings: [{ id: 'h1', symbol: 'CSPX', name: 'ETF', layer: 'core', currency: 'TWD', quantity: 1, price: 50000 }],
    assetTargets: [{ class: '現金', targetPct: cashTarget }, { class: '股票', targetPct: stockTarget }],
  });

  const onBoundary = summaryOf(alloc(45, 55)).reminders
    .filter((/** @type {any} */ r) => String(r.key).startsWith('alloc-drift-'));
  const over = onBoundary.find((/** @type {any} */ r) => r.key === 'alloc-drift-現金');
  const under = onBoundary.find((/** @type {any} */ r) => r.key === 'alloc-drift-股票');
  assert.ok(over, '正偏離恰好 +5.0%（等於門檻）必須提醒——>= 改成 > 就會在邊界上靜靜消失');
  assert.match(over.title, /\+5\.0%/, '標題要顯示 +5.0% 的偏離量');
  assert.ok(under, '負偏離恰好 −5.0% 也必須提醒——判準拿掉 Math.abs（只看正偏離）時，就是這一條轉紅');
  assert.match(under.title, /-5\.0%/, '標題要顯示 -5.0% 的偏離量（負號要在）');

  const nearMiss = summaryOf(alloc(45.1, 54.9)).reminders
    .filter((/** @type {any} */ r) => String(r.key).startsWith('alloc-drift-'));
  assert.equal(nearMiss.length, 0,
    '偏離 4.9% ＜ 門檻 5%：兩個類別都不可出聲（門檻被偷偷調小、提醒牆被噪音塞滿時會紅）');
});

test('提醒｜緊急預備金高估：卡帳月均與現金流月均「恰好相等」不出聲、只多 1 元就出聲（比較式本身釘死）', () => {
  // ⚠️ 這是「安全網不可無聲」的過渡期保險。唯一守它的既有考題讓 avgExp 恰好是 0，
  //    所以 `cardAvg > 0` 永遠成立、比較式 `cardAvg > avgExp` 本身完全沒被測到：
  //    門檻改成 `cardAvg > avgExp * 10` 照樣全綠。
  //    ⚠️ 用 40,000 對 5,000 也一樣擋不住：那離邊界太遠，`* 2` 之後仍然成立。
  //    要釘死比較式，兩格必須相鄰——相等（不出聲）與差 1 元（出聲）。
  const m1 = monthsAgo(1);
  const over = (cardAmount) => ({
    accounts: [{ id: 'c1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 100000 }],
    cards: [{ id: 'card1', name: '測試卡', type: 'credit' }],
    transactions: [
      // 現金流帳本：上個月唯一一筆支出 10,000 ⇒ 月均 10,000
      { id: 't1', date: `${m1}-05`, type: 'expense', category: '生活', amount: 10000, ledger: 'cashflow' },
      // 卡帳本：上個月唯一一筆消費 ⇒ 月均＝cardAmount
      { id: 't2', date: `${m1}-06`, type: 'expense', category: '生活', amount: cardAmount, ledger: 'card', source: 'stmt', cardId: 'card1' },
    ],
  });
  assert.ok(!keysOf(over(10000)).includes('emergency-fund-optimistic'),
    '兩邊月均恰好相等＝現金流已追上卡帳，這張過渡期保險要安靜（`>` 鬆成 `>=` 時會紅）');
  assert.ok(keysOf(over(10001)).includes('emergency-fund-optimistic'),
    '卡帳月均只要多 1 元就要出聲（門檻乘 2、乘 10 都會讓這張網靜靜關閉，而使用者不會發現）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、樣本數與口徑（目標追蹤、訂閱狀態、退款配對）
// ─────────────────────────────────────────────────────────────────────────────

test('目標追蹤｜兩個樣本不可算出「預計達成」：現金流與淨值快照**兩把尺各測一次**', () => {
  // ⚠️ computeGoalTracking 的 JSDoc 明寫「兩者都至少要三個月份」。門檻鬆到 2 之後，
  //    只有兩筆資料就會算出速度與到達月數，把「還不知道」講成一個看起來可信的數字，
  //    使用者會照一個樣本數不足的估計做決定。
  // ⚠️ 兩把尺是**兩段各自獨立的判斷**（savingsSamples >= 3 與 netWorthSamples >= 3）：
  //    只測現金流那一把，單獨放寬淨值快照那一把是完全無感的（Codex #413 r1 實測全綠）。
  const mk = (n) => `${monthsAgo(n)}-10`;
  const txFor = (months) => months.flatMap((n, i) => [
    { id: `i${i}`, date: mk(n), type: 'income', category: '工作', amount: 60000, ledger: 'cashflow' },
    { id: `e${i}`, date: mk(n), type: 'expense', category: '生活', amount: 30000, ledger: 'cashflow' },
  ]);
  const baseDb = {
    ...BASE, settings: { ...BASE.settings, netWorthTarget: 10000000 },
    accounts: [{ id: 'c1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 1000000 }],
  };

  // (a) 現金流結餘那把尺
  const dbOf = (months) => ({ ...baseDb, transactions: txFor(months) });
  const two = computeGoalTracking(dbOf([1, 2]));
  assert.equal(two.savingsSpeed, null, '只有兩個月＝樣本不足，存錢速度必須是 null（不可硬算）');
  assert.equal(two.monthsSavings, null, '到達月數也必須是 null');
  const three = computeGoalTracking(dbOf([1, 2, 3]));
  assert.ok(three.savingsSpeed !== null, '三個月才開始給存錢速度（反面：門檻被改嚴也會紅）');

  // (b) 淨值快照那把尺（月份由舊到新排；淨值遞增＝速度為正，才不會被「速度非正不硬算」那段吃掉）
  const snapDbOf = (months) => ({
    ...baseDb,
    snapshots: months.map((n, i) => ({ month: monthsAgo(n), date: `${monthsAgo(n)}-28`, netWorth: 1000000 + i * 200000 })),
  });
  const twoSnaps = computeGoalTracking(snapDbOf([2, 1]));
  assert.equal(twoSnaps.netWorthSamples, 2, 'fixture 自我驗證：這兩筆快照真的被採計（否則下面兩條是空包彈）');
  assert.equal(twoSnaps.netWorthSpeed, null, '只有兩筆月快照＝樣本不足，淨值速度必須是 null');
  assert.equal(twoSnaps.monthsNetWorth, null, '淨值口徑的到達月數也必須是 null');
  const threeSnaps = computeGoalTracking(snapDbOf([3, 2, 1]));
  assert.ok(threeSnaps.netWorthSpeed !== null, '三筆快照才開始給淨值速度（反面：門檻被改嚴也會紅）');
});

test('訂閱｜停用當天不算使用中：後端 subActive 與前端 subStatus **兩份實作各測一次**', () => {
  // ⚠️ subActive 是註解標明的前後端同步點（與前端 subStatus 同口徑：「停用日已過（daysUntil ≤ 0）不算」）。
  //    邊界從 > 0 鬆到 >= 0 之後，停用當天的訂閱在總覽被算成使用中、在訂閱頁不算，
  //    總覽「本月固定訂閱」的項數與訂閱頁互相打架。
  // ⚠️ 「同口徑」是一句**兩邊都要測**才撐得住的話（Codex #413 r1 阻擋：本檔原本只 import 後端，
  //    前端那份 `> 0` 改成 `>= 0` 沒有任何一題會紅）。前端模組頂層就碰 document、在 node 裡 import 不起來，
  //    所以照 test/xss-id-escaping.test.js 的既有做法：把**正式環境真正在跑的那段原始碼**抓出來現場執行，
  //    不是在測試裡另抄一份。
  const front = loadFrontendSubStatus();
  const subOn = (dateIso) => ({
    subscriptions: [{ id: 's1', name: '測試訂閱', amount: 300, cycle: 'monthly',
      since: `${monthsAgo(6)}-01`, endsOn: dateIso }],
  });
  const today = todayIso();
  const tomorrow = daysFromNow(1);

  // 後端：總覽「每月固定訂閱」的項數
  assert.equal(summaryOf(subOn(today)).subscriptions.count, 0,
    '後端：停用日就是今天＝已經不算使用中');
  assert.equal(summaryOf(subOn(tomorrow)).subscriptions.count, 1,
    '後端：停用日在明天＝今天還算使用中（反面）');

  // 前端：訂閱頁的狀態分組
  assert.equal(front({ id: 's1', endsOn: today }), 'ended',
    '前端：停用日就是今天＝已停用（這裡是 `> 0` 鬆成 `>= 0` 時唯一會轉紅的地方）');
  assert.equal(front({ id: 's1', endsOn: tomorrow }), 'ending',
    '前端：停用日在明天＝即將停用、仍算使用中（反面）');
});

/**
 * 取出前端 public/modules/subscriptions.js 裡**正式環境真正在跑的那份 subStatus**。
 * 它依賴 app.js 的 parseLocalDate／daysUntil，所以連那兩段一起抓過來（同樣是正式碼）。
 * 抓不到就直接讓考題失敗——函式改名時要有人來更新這題，而不是靜靜跳過。
 *
 * ⚠️ 誠實劃界：這只驗到 **subStatus 這個函式本身的天數口徑**。
 *    訂閱頁若改成不靠 subStatus 分組（換另一套判斷）、或前端別處自己再算一次停用日，
 *    本題照樣綠——那種走散要靠頁面層的考題，不在這一題的射程內。
 */
function loadFrontendSubStatus() {
  const appSrc = readFileSync(join(ROOT, 'public/app.js'), 'utf8');
  const parseLocal = /export const parseLocalDate = \([\s\S]*?\n\};/.exec(appSrc);
  assert.ok(parseLocal, 'app.js 找不到 parseLocalDate 的定義（改名了？那要一起更新本考題）');
  const daysUntilLine = appSrc.split('\n').find(l => l.includes('export const daysUntil'));
  assert.ok(daysUntilLine, 'app.js 找不到 daysUntil 的定義（改名了？那要一起更新本考題）');
  const subSrc = readFileSync(join(ROOT, 'public/modules/subscriptions.js'), 'utf8');
  const statusFn = /export function subStatus\(s\) \{[\s\S]*?\n\}/.exec(subSrc);
  assert.ok(statusFn, 'subscriptions.js 找不到 subStatus 的定義（改名了？那要一起更新本考題）');
  const src = [parseLocal[0], daysUntilLine, statusFn[0]]
    .join('\n').replace(/export const /g, 'const ').replace(/export function /g, 'function ');
  return /** @type {(s: any) => string} */ (new Function(`${src}\nreturn subStatus;`)());
}

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
