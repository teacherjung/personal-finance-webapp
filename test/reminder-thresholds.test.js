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
//
// ⚠️ 第二版的教訓（#413 自審，同樣原地記下來）：上一版只釘了視窗的**尾端**，近端整段沒守——
//    `d <= 3 ? 'warn'` 加個 `d >= 1`（繳款當天悄悄從 warn 降成 info）、`d < 0 && d >= -60` 收成
//    `d < -1`（保險逾期第 1 天整張 danger 提醒消失），兩顆突變都只改正式碼、全部考題零失敗。
//    **近端才是最急的那一格**（今天要繳、剛漏繳）。
//
// ⚠️ 第三版的教訓（#413 複驗阻擋）：第二版的檔頭把**個案結論寫成了全檔通則**——收尾寫「所以現在
//    兩端都釘」，但保險那一族當時只釘了負視窗的兩端（−60／−61）與兩邊的近端（0、−1）；
//    正視窗的尾端（30／31）與 warn/info 的升級門檻（7／8）兩處**完全沒有考題壓著**，
//    而那正是隔壁卡片那題早就釘住的兩種刻度。複驗者的兩顆繞法當時全綠：
//    `d >= 0 && d <= 30` → `d <= 2`（提前提醒從 30 天縮成 2 天）、
//    `d <= 7 ? 'warn'` → `d <= 0 ? 'warn'`（第 1〜30 天全部從 warn 降成 info；d=0 兩邊都還是 warn，
//    所以第二版剛補的「繳費當天是 warn」擋不住它）。現在兩處都補了相鄰兩格的斷言。
//    範圍講清楚：「兩端都釘」只涵蓋**本節這兩題視窗型的提醒**（信用卡繳款、保險繳費），
//    它們的視窗兩端與 warn/info 升級門檻各自都踩在相鄰兩格上；
//    第二節以下的題目是門檻不是視窗（配置偏離、緊急預備金、樣本數、訂閱天數口徑），
//    各自守什麼寫在各自的題裡，不適用這句。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// 真正的 JS parser 與作用域分析（ESLint 自己用的那兩顆，隨 devDependency 的 eslint 一起裝）。
// 為什麼不自己寫正則掃字串＝見 loadFrontendSubStatus 的「第二次教訓」。
import { parse as parseJs } from 'espree';
import { analyze as analyzeScopes } from 'eslint-scope';
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
const fullDb = (over) => ({ ...BASE, ...over, settings: { ...BASE.settings, ...(over.settings || {}) } });
const summaryOf = (over) => buildSummary(fullDb(over));
const keysOf = (over) => summaryOf(over).reminders.map((/** @type {any} */ r) => r.key);
const findR = (over, key) => summaryOf(over).reminders.find((/** @type {any} */ r) => r.key === key);

// ─────────────────────────────────────────────────────────────────────────────
// 一、視窗兩端都要釘死（信用卡繳款、保險漏繳）
// ─────────────────────────────────────────────────────────────────────────────

test('提醒｜信用卡繳款：第 7 天要出現、第 8 天不可出現；第 4 天仍 info、第 3 天升 warn；繳款當天仍是 warn（尾端＋升級門檻＋近端）', () => {
  // ⚠️ 規則標題自己寫「7 天內」。視窗縮小的副作用更嚴重：level 是 `d <= 3 ? 'warn' : 'info'`，
  //    視窗收到 3 之後 info 級整個變成打不到的死碼＝這張提醒再也不會有「提早幾天的溫和提示」階段。
  //    這裡把視窗尾端（7／8）與升級門檻（4／3）四格全部釘住，刻度往任一方向挪一格都會紅。
  // ⚠️ 近端（第 0 天）是後補的（#413 自審）：升級判斷只有上界，`d <= 3` 加個下界 `d >= 1` 之後，
  //    標題寫著「今天繳款」的那一格會悄悄從 warn 降成 info——最急的一格反而變成溫和提示，
  //    而既有的「兩張卡的繳款提醒 key」那題只看 key、不看 level，擋不住。
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

  const dueToday = findR(cardWithDueIn(0), 'card-due-c1');
  assert.ok(dueToday, '繳款當天必須出現（視窗近端＝最急的那一格）');
  assert.match(dueToday.title, /今天繳款/, '當天的標題寫「今天繳款」，不是「0 天後」');
  assert.equal(dueToday.level, 'warn',
    '繳款當天仍是 warn（升級判斷補上下界、例如 `d <= 3` 改 `d <= 3 && d >= 1`，今天就會被悄悄降成 info）');
});

test('提醒｜保險繳費日：正視窗第 30／31 天、升級門檻第 8／7 天、逾期第 60／61 天，加上繳費當天與逾期第 1 天的接縫', () => {
  // ⚠️ 這個 60 是 2026-07-22 使用者定的自主體檢決議：nextPayment 是手動欄位、不會自動推進，
  //    繳費日一過提醒就無聲消失＝**最需要提醒的漏繳反而零訊號**。
  //    視窗縮小＝那一段逾期的漏繳全部靜音，而且那是 danger 級。
  // ⚠️ 接縫是後補的（#413 自審）：正視窗（`d >= 0 && d <= 30`，warn）與負視窗（`d < 0 && d >= -60`，danger）
  //    是相鄰兩格，中間沒有第三條路——任一邊的近端往內縮一格（`d >= 1`／`d < -1`），那一格就掉進兩個
  //    分支的縫裡、整張提醒憑空消失。上一版只釘尾端（60／61），這兩顆突變全部考題零失敗。
  // ⚠️ **正視窗的尾端（30／31）與 warn→info 的升級門檻（7／8）是第三版才補的**（#413 複驗阻擋）：
  //    這一族原本只釘了負視窗的兩端與兩邊的近端，正視窗那半邊只有 d=0 一格。複驗者的兩顆突變
  //    （`d <= 30` → `d <= 2`＝提前提醒從 30 天縮成 2 天；`d <= 7 ? 'warn'` → `d <= 0 ? 'warn'`＝
  //    第 1〜30 天全部從 warn 降成 info）當時都只改正式碼、全部考題零失敗。第二顆特別陰險：
  //    d=0 在突變前後都還是 warn，所以剛補的「繳費當天是 warn」擋不住它。
  //    卡片那題早就把這兩種刻度（視窗尾端＋升級門檻）釘成相鄰兩格，這裡比照補齊。
  const policy = (dateIso) => ({
    insurance: [{ id: 'p1', policyName: '測試保單', insured: '我', premium: 12000,
      premiumCycle: 'yearly', nextPayment: dateIso }],
  });
  // 正視窗的尾端：第 30 天要出現、第 31 天不可出現
  const lastAhead = findR(policy(daysFromNow(30)), 'ins-pay-p1');
  assert.ok(lastAhead, '第 30 天＝正視窗最後一格，必須出現（`d <= 30` 收小＝提前提醒的天數被靜靜砍掉）');
  assert.equal(lastAhead.level, 'info', '第 30 天屬「溫和提示」階段');
  assert.match(lastAhead.title, /30 天後/, '標題要說清楚剩幾天');
  assert.ok(!keysOf(policy(daysFromNow(31))).includes('ins-pay-p1'),
    '第 31 天＝正視窗外第一格，不可出現（視窗放大＝一整個月以外的保費也來洗提醒牆）');

  // warn／info 的升級門檻：第 8 天仍 info、第 7 天升 warn
  const mild = findR(policy(daysFromNow(8)), 'ins-pay-p1');
  assert.ok(mild, '第 8 天當然要出現');
  assert.equal(mild.level, 'info', '第 8 天還在溫和提示階段（升級門檻放寬到 8 就會紅）');
  const urgent = findR(policy(daysFromNow(7)), 'ins-pay-p1');
  assert.ok(urgent, '第 7 天當然要出現');
  assert.equal(urgent.level, 'warn',
    '第 7 天＝升級成 warn 的第一格（`d <= 7 ? \'warn\'` 往任一方向挪一格都會紅；門檻收到 0 之後整段 1〜30 天靜靜降級）');

  const lastDay = findR(policy(daysFromNow(-60)), 'ins-pay-p1');
  assert.ok(lastDay, '逾期第 60 天＝視窗最後一格，必須提醒（視窗縮小＝漏繳靜音）');
  assert.equal(lastDay.level, 'danger', '已過期是 danger 級（不可降級成溫和提示）');
  assert.match(lastDay.title, /已過 60 天/, '要說清楚過了幾天');
  assert.ok(!keysOf(policy(daysFromNow(-61))).includes('ins-pay-p1'),
    '逾期第 61 天＝視窗外第一格，不再提醒（視窗放大＝提醒牆會被陳年舊帳塞滿）');

  // 接縫的相鄰兩格：繳費當天（正視窗近端）與逾期第 1 天（負視窗近端）
  const dueToday = findR(policy(daysFromNow(0)), 'ins-pay-p1');
  assert.ok(dueToday, '繳費當天必須提醒（正視窗近端收成 `d >= 1`，今天要繳的保費會整張消失）');
  assert.match(dueToday.title, /今天繳費/, '當天的標題寫「今天繳費」，不是「0 天後」');
  assert.equal(dueToday.level, 'warn', '繳費當天是 warn（還沒過期，不是 danger）');

  const firstOverdue = findR(policy(daysFromNow(-1)), 'ins-pay-p1');
  assert.ok(firstOverdue, '逾期第 1 天必須提醒（負視窗近端收成 `d < -1`，剛漏繳的那一刻反而零訊號）');
  assert.match(firstOverdue.title, /已過 1 天/, '要說清楚過了幾天');
  assert.equal(firstOverdue.level, 'danger', '逾期第一天就是 danger（不可等幾天才變紅）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、門檻的比較邊界（配置偏離、緊急預備金高估）
// ─────────────────────────────────────────────────────────────────────────────

test('提醒｜資產配置偏離：恰好等於門檻要出現、差 0.1% 不出現，正負各自出聲；後端提醒與前端資產頁**兩份實作各測一次**', () => {
  // ⚠️ 三件事一起釘：
  //    (a) 邊界：恰好偏離 5.0%（＝設定值本身）時提醒消失＝典型的邊界無守衛（>= 改 > 全綠）；
  //        另一側用 4.9% 釘住「門檻不可被偷偷調小」。
  //    (b) 方向：判準是 `Math.abs(row.diff) >= 門檻`。⚠️ 只斷言「有任何一張 alloc-drift 出現」
  //        的話，拿掉 Math.abs 照樣全綠（正偏離那張還在）——所以**正負兩張分別點名**。
  //    (c) 兩份實作：同一個門檻在前端 public/modules/assets.js 有第二份獨立的判斷
  //        （資產頁「資產配置 vs 目標」那條要不要標「偏離」的橘標籤與橘進度條）。
  //        ⚠️ 這是訂閱那題（subActive／subStatus）被 #413 r1 退回重寫的同一個病型，就在隔壁原封不動：
  //        只改前端那行 `>=` → `> 門檻 * 3`，全部考題零失敗，實際後果是總覽提醒牆說偏離、
  //        資產頁那條卻不標紅，兩頁互相打架。所以前端那份也拉進來測（做法見 loadFrontendDriftFlag）。
  //  造法：現金 5 萬、股票 5 萬 ⇒ 各 50%；目標 45/55 ⇒ 偏離恰好 +5.0%／−5.0%
  const alloc = (cashTarget, stockTarget) => ({
    settings: { allocationDriftPct: 5 },
    accounts: [{ id: 'a1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 50000 }],
    holdings: [{ id: 'h1', symbol: 'CSPX', name: 'ETF', layer: 'core', currency: 'TWD', quantity: 1, price: 50000 }],
    assetTargets: [{ class: '現金', targetPct: cashTarget }, { class: '股票', targetPct: stockTarget }],
  });

  const boundaryDb = fullDb(alloc(45, 55));
  const boundary = buildSummary(boundaryDb);
  const onBoundary = boundary.reminders
    .filter((/** @type {any} */ r) => String(r.key).startsWith('alloc-drift-'));
  const over = onBoundary.find((/** @type {any} */ r) => r.key === 'alloc-drift-現金');
  const under = onBoundary.find((/** @type {any} */ r) => r.key === 'alloc-drift-股票');
  assert.ok(over, '正偏離恰好 +5.0%（等於門檻）必須提醒——>= 改成 > 就會在邊界上靜靜消失');
  assert.match(over.title, /\+5\.0%/, '標題要顯示 +5.0% 的偏離量');
  assert.ok(under, '負偏離恰好 −5.0% 也必須提醒——判準拿掉 Math.abs（只看正偏離）時，就是這一條轉紅');
  assert.match(under.title, /-5\.0%/, '標題要顯示 -5.0% 的偏離量（負號要在）');

  const nearMissDb = fullDb(alloc(45.1, 54.9));
  const nearMiss = buildSummary(nearMissDb).reminders
    .filter((/** @type {any} */ r) => String(r.key).startsWith('alloc-drift-'));
  assert.equal(nearMiss.length, 0,
    '偏離 4.9% ＜ 門檻 5%：兩個類別都不可出聲（門檻被偷偷調小、提醒牆被噪音塞滿時會紅）');

  // 前端資產頁那份：吃的是同一份 db 與同一批 allocation.rows（正式環境就是這樣接的）
  const frontOff = loadFrontendDriftFlag();
  const rowOf = (/** @type {any} */ summary, /** @type {string} */ cls) =>
    summary.allocation.rows.find((/** @type {any} */ r) => r.class === cls);
  const cashRow = rowOf(boundary, '現金');
  const stockRow = rowOf(boundary, '股票');
  assert.ok(cashRow && stockRow, 'fixture 自我驗證：兩個類別都要在 allocation.rows 裡（否則下面幾條是空包彈）');
  assert.equal(cashRow.diff.toFixed(1), '5.0', 'fixture 自我驗證：偏離量真的是 +5.0（否則測到的不是邊界）');
  assert.equal(frontOff(cashRow, boundaryDb), true,
    '前端：恰好 +5.0% 要標「偏離」（前端 `>=` 鬆掉時只有這裡會紅——總覽說偏離、資產頁不標紅＝兩頁打架）');
  assert.equal(frontOff(stockRow, boundaryDb), true,
    '前端：恰好 −5.0% 也要標（前端那份拿掉 Math.abs 時會紅）');
  assert.equal(frontOff(rowOf(buildSummary(nearMissDb), '現金'), nearMissDb), false,
    '前端：偏離 4.9% 不可標（前端門檻被調小時會紅）');
  assert.equal(frontOff(cashRow, { ...boundaryDb, settings: { ...boundaryDb.settings, allocationDriftPct: 6 } }), false,
    '前端讀的必須是 settings.allocationDriftPct 這把設定（改讀別的鍵時會退回預設 5、把 5.0% 判成偏離，這裡就紅）');
});

/**
 * 取出前端 public/modules/assets.js 裡**正式環境真正在跑的那行偏離判準**（`const off = …`），
 * 包成 `(row, db) => boolean` 現場執行。手法與 loadFrontendSubStatus 同源：不在測試裡另抄一份，
 * 抓不到就直接讓考題失敗——那行改名或改寫時要有人來更新本題，而不是靜靜跳過。
 *
 * ⚠️ 誠實劃界（擋不住什麼，逐條寫明）：
 *   1. 只驗這一行**算出來的旗標**。它下游怎麼用（橘色 tag、進度條顏色）本題不看，
 *      頁面若改成在樣板裡另外內嵌一套判斷、或乾脆不用 off，本題照樣綠。
 *   2. 只認 `const off = …` 這個單行寫法。拆成多行、搬進別的函式、換個變數名，都會走到下面的
 *      assert 大聲失敗（不是靜靜跳過），但那也代表本題需要有人回來更新。
 *   3. 這是「同一口徑兩份實作，兩邊各測一次」的守法，不是消除重複。要根治得把門檻收成一份
 *      共用判斷（前端得能拿到），那是另一支 PR 的事，本支不動正式碼。
 */
function loadFrontendDriftFlag() {
  const src = readFileSync(join(ROOT, 'public/modules/assets.js'), 'utf8');
  const hits = [...src.matchAll(/^[ \t]*const off = .*;$/gm)];
  assert.equal(hits.length, 1,
    `assets.js 必須（且只能）有一行 \`const off = …\` 的偏離判準，實際 ${hits.length} 行（改名／搬家時要一起更新本考題）`);
  return /** @type {(row: any, db: any) => boolean} */ (
    new Function('r', 'db', `${hits[0][0].trim()}\nreturn off;`)
  );
}

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
  // ⚠️ 光抄函式本體還不夠（Codex #413 r2 阻擋）：subStatus 一個字不動、只換掉它吃到的 daysUntil
  //    （改名 import 再就地包一層）就能繞過。名字綁到誰也是口徑的一部分——見 loadFrontendSubStatus
  //    的 assertDaysUntilBinding 與該處逐條寫明的「擋不住什麼」。
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
 * ⚠️ 這是「把原始碼抄出來現場跑」的手法，所以除了函式本體，**還必須驗它吃到的名字綁到誰**
 *    （Codex #413 r2 阻擋，值得原地記下來）：上一版只抓函式本體、再自己從 app.js 配一份乾淨的
 *    daysUntil，於是 subStatus 一個字都不用動就能繞過——把 import 改成 `daysUntil as rawDaysUntil`、
 *    緊接著 `const daysUntil = (d) => rawDaysUntil(d) + 1`，正式環境裡「停用日＝今天」的訂閱
 *    回 'ending'（＝仍算使用中）、總覽項數與訂閱頁分組走散，而全套考題靜靜全綠。
 *    **函式本體位元組相同 ≠ 行為相同：名字綁到誰也是口徑的一部分**，所以下面加了 assertDaysUntilBinding。
 *
 * ⚠️ **第二次教訓（Codex 複驗再度阻擋，審 `3c4414c`）：那一版的綁定檢查是自己寫的正則，
 *    於是同一個家族又穿過去一次。** 複驗者的繞法是兩件事湊起來：
 *    (a) 一行**註解掉的假 import**（`// import { daysUntil } from '../app.js';`）被正則當成
 *        合法綁定收下；(b) 真正生效的是 `const { daysUntil } = { daysUntil: d => rawDaysUntil(d) + 1 }`
 *        ——**解構**宣告，不符合正則只認得的 `const daysUntil` 那一種形狀。
 *    正式前端因此把停用當天的 0 加成 1、`subStatus` 錯回 'ending'，全套考題再次靜靜全綠。
 *    這正是 AGENTS.md 那條硬規則在說的事（掃原始碼的形狀考題**要先去掉註解、不可只認得一種寫法**），
 *    也是 eslint.config.js 檔頭記了三次的同一個病：**列舉繞法補不完，要把判斷交給 parser。**
 *    所以整段改成真正的語法樹＋作用域分析（espree 解析、eslint-scope 建作用域圖），
 *    直接問「subStatus 裡的這個 daysUntil，依語言規則綁到誰」。註解對 parser 而言不存在；
 *    解構、`var`／`let`／`function`／`class`、函式參數、內層遮蔽⋯⋯對作用域分析也是同一件事——
 *    **不是多認得一種形狀，是不再靠認形狀。**
 *
 * ⚠️ 誠實劃界（擋不住什麼，逐條寫明——這段話自己也要禁得起反例）：
 *    1. 只管 subStatus 這條路。訂閱頁若改成**不靠 subStatus 分組**（換另一套判斷）、
 *       或前端別處自己再算一次停用日，本題照樣綠——那要靠頁面層的考題，不在射程內。
 *    2. 綁定分析在 subscriptions.js **這一個檔案內**是完整的，但**不會跟著走進 app.js**：
 *       它證明的是「`daysUntil` 這個名字綁到來自 `../app.js` 的同名具名 import」，
 *       至於 app.js 那個匯出算得對不對，是 app.js 自己的考題。
 *       （app.js 若改成轉手匯出 `export { x as daysUntil } from './y.js'`，本檔取不到就地宣告，
 *       會**吵著紅**要人回來更新，不是靜靜綠。）
 *    3. subStatus 若改吃 daysUntil 以外的新相依，本題**不會靜靜綠**，但也不是好好轉紅：
 *       sandbox 裡會 ReferenceError（紅得很吵，代表有人得回來更新本題）。
 *    4. 「抄原始碼出來現場跑」這個手法，本質上管不到**執行期才決定**的東西（動態 import、eval）。
 *       要連這些都關掉，得把 subStatus 搬進零 DOM 模組、讓考題直接 import 正式模組。
 *       那條路**刻意沒走**：subStatus 吃的 parseLocalDate／daysUntil 住在 app.js，而 app.js
 *       模組頂層就直接綁 DOM（`document.querySelectorAll('#nav a')`、`window.addEventListener`、
 *       `$('#snapshotBtn').addEventListener`——最後那個在 node 裡當場拋錯），import 不起來；
 *       要搬 subStatus 就得連那兩支一起搬出 app.js 再回頭轉匯出，是動到前端共用核心的重構，
 *       而 AGENTS.md 對「改前端」要求的驗證（**全部頁面 reload 無 console error**）在這支
 *       純考題 PR 的環境裡做不到，沒驗過就改共用核心比留著這條劃界更危險。
 */
function loadFrontendSubStatus() {
  const app = parseModule('public/app.js');
  const subs = parseModule('public/modules/subscriptions.js');
  const status = functionSourceOf(subs, 'subStatus');
  assertDaysUntilBinding(subs, status.node);
  const src = [constSourceOf(app, 'parseLocalDate'), constSourceOf(app, 'daysUntil'), status.source].join('\n');
  return /** @type {(s: any) => string} */ (new Function(`${src}\nreturn subStatus;`)());
}

/** 用真正的 parser 把一支模組解析成語法樹＋作用域圖（不是自己寫正則掃字串——見上面第二次教訓）。
 *  註：本函式與 assertDaysUntilBinding 各有一條 `assert.ok(scope/fnScope)`＝**函式庫回傳值的防呆**，
 *  不是守正式碼的斷言（ES module 必有模組作用域、function 宣告必有作用域，正式碼怎麼改都碰不到它們）；
 *  留著只為了 espree／eslint-scope 哪天換 API 時錯得看得懂。 */
function parseModule(relPath) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  const ast = parseJs(src, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const manager = analyzeScopes(ast, { ecmaVersion: 2026, sourceType: 'module' });
  const scope = manager.scopes.find((/** @type {any} */ s) => s.type === 'module');
  assert.ok(scope, `${relPath} 解析不出模組作用域（它還是 ES module 嗎？）`);
  return { relPath, src, manager, scope };
}

/** 取模組頂層某個名字的宣告。找不到／不只一份都吵著紅——改名時要有人回來更新本題，而不是靜靜跳過。 */
function topLevelDef(mod, name) {
  const variable = mod.scope.variables.find((/** @type {any} */ v) => v.name === name);
  assert.ok(variable, `${mod.relPath} 頂層找不到 ${name}（改名或改成轉手匯出了？那要一起更新本考題）`);
  assert.equal(variable.defs.length, 1,
    `${mod.relPath} 的 ${name} 有 ${variable.defs.length} 份宣告，抄哪一份會變成用猜的`);
  return variable.defs[0];
}

/** 把 `export const NAME = …` 還原成 sandbox 跑得動的 `const NAME = …;`（用語法樹的位置切，不是正則）。 */
function constSourceOf(mod, name) {
  const def = topLevelDef(mod, name);
  assert.equal(def.type, 'Variable', `${mod.relPath} 的 ${name} 不是就地宣告的常數（實際：${def.type}）`);
  assert.ok(def.node.init, `${mod.relPath} 的 ${name} 沒有初始值`);
  return `const ${name} = ${mod.src.slice(def.node.init.range[0], def.node.init.range[1])};`;
}

/** 取頂層 function 宣告的節點與原始碼（`export` 關鍵字不在節點範圍內，切出來就能直接跑）。 */
function functionSourceOf(mod, name) {
  const def = topLevelDef(mod, name);
  assert.equal(def.type, 'FunctionName', `${mod.relPath} 的 ${name} 不是頂層 function 宣告（實際：${def.type}）`);
  return { node: def.node, source: mod.src.slice(def.node.range[0], def.node.range[1]) };
}

/**
 * subStatus 裡用到的**每一個** `daysUntil`，依語言的作用域規則都必須解析到
 * 「模組層、來自 `../app.js`、沒改名的具名 import」——也就是本題配進 sandbox 的那一份。
 * （這條檢查存在的唯一理由＝上面兩段繞法；沒有它，本檔宣稱守住的東西守不住。）
 */
function assertDaysUntilBinding(mod, fnNode) {
  const fnScope = mod.manager.acquire(fnNode);
  assert.ok(fnScope, `${mod.relPath} 取不到 subStatus 的作用域`);
  const refs = [];
  const collect = (/** @type {any} */ scope) => {
    for (const ref of scope.references) if (ref.identifier.name === 'daysUntil') refs.push(ref);
    scope.childScopes.forEach(collect);
  };
  collect(fnScope);
  assert.ok(refs.length > 0,
    'subStatus 裡一個 daysUntil 都沒用到＝這條綁定檢查變成空包彈（判準換人了？那要一起更新本考題）');

  for (const ref of refs) {
    const line = ref.identifier.loc.start.line;
    const variable = ref.resolved;
    assert.ok(variable, `${mod.relPath}:${line} 的 daysUntil 解析不到任何宣告（全域漏網？）`);
    assert.equal(variable.scope.type, 'module',
      `${mod.relPath}:${line} 的 daysUntil 必須綁到模組層的 import，不可被內層宣告或參數遮蔽（實際作用域：${variable.scope.type}）`);
    assert.equal(variable.defs.length, 1,
      `${mod.relPath} 的 daysUntil 有 ${variable.defs.length} 份宣告`);
    const def = variable.defs[0];
    assert.equal(def.type, 'ImportBinding',
      `${mod.relPath}:${line} 的 daysUntil 必須來自 import，不可是模組裡就地宣告的（實際：${def.type}——解構／var／function／class 就地包一層全走這條）`);
    assert.equal(def.node.type, 'ImportSpecifier',
      'daysUntil 必須是具名 import（default／namespace 引入都算換了一把尺）');
    assert.equal(def.node.imported.name, 'daysUntil',
      'daysUntil 必須綁到 app.js 的同名匯出（`X as daysUntil`＝subStatus 換了一把尺，本題卻還配著舊尺）');
    assert.equal(def.parent.source.value, '../app.js',
      'daysUntil 必須來自 ../app.js（改從別的模組拿＝正式環境跑的不再是本題配進去的那一份）');
  }
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
