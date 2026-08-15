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
//
// ⚠️ 第四版的教訓（#413 r3 阻擋）：這兩條都不在刻度本身，而在「抽原始碼來測前端」那類考題**能證明什麼**——
//    (a) 語法樹只證明得了語法與綁定，**證明不了資料流真的抵達畫面**：把印在畫面上的橘標籤搬進一個
//        不呈現的探針變數，正式資產頁不再標偏離，全套考題照樣全綠。（這個洞第五版關掉了，見下。）
//    (b) 形狀斷言不可比正式行為還嚴：把 `export const f = (d) => …` 改寫成等價的
//        `export function f(d) …`（本體逐字不變、行為完全相同）上一版會紅＝**假紅**。
//        考題只該紅在行為變了的時候；為了會紅而紅的考題最後會被當成雜訊關掉（修法見 declSourceOf）。
//
// ⚠️ 第五版的教訓（#413 r4 阻擋，**五顆假紅擠在同一處**）：配置偏離那題的前端半邊，上一版是
//    「在語法樹上找到橘標籤的三元式 → 取條件旗標 → 把旗標的初始值切下來現場跑」。複驗者實測的五顆
//    突變全部是「正式行為一字未變卻轉紅」：多一張 `tag amber` 標籤（全站十處的慣用寫法）、
//    map 回呼參數 `r` 改名、解構出來的 `db` 改名、門檻提到迴圈外、判準抽成 helper。
//    病根不在其中任何一條，而在**「切一小段原始碼出來跑」這個手法本身**——它必須認得判準長什麼形狀、
//    住在哪一層、叫什麼名字，於是每一種等價改寫都是一顆假紅。修法不是多認幾種形狀，是**不再切**：
//    整支 assets.js 搬進 sandbox 跑 `renderAssets()`、斷言它真的印出來的 HTML（見 renderAssetsHtml）。
//    順帶把 (a) 那個洞關上了——探針變數不會出現在畫面的 HTML 上。
//    ⚠️ 這條的射程寫清楚，別擴寫成全檔口號：**「抽原始碼來測前端」還留在訂閱那題**
//    （loadFrontendSubStatus，切的是純函式、跨檔綁定另有一套檢查撐著），它自己的劃界寫在該處。
//
// ⚠️ 第六版的教訓（#413 r4 阻擋）：把正式碼搬進 sandbox 跑，證明的是「**這一支**函式印什麼」，
//    不是「使用者按下那一頁時跑的是它」。上一版少了後半句，複驗者於是**留著原 renderer 一字不動**、
//    另寫一支「先呼叫它、再把橘標籤從真正的 DOM 拔掉」的 wrapper，把 `ROUTES.assets` 改接過去：
//    正式資產頁真的不再顯示偏離標籤，而 7 題全綠、完整套件全綠、typecheck／lint 全綠。
//    修法＝把**正式路由的綁定**也變成斷言（assertAssetsRouteBinding：`ROUTES.assets` 綁的必須是
//    從 assets.js 具名 import 進來的 `renderAssets`，依作用域規則解析、不是認字串）。
//    這條的通則值得記住：**「我抄／跑的是正式碼」還缺一句「而正式環境跑的是我抄／跑的那一份」**
//    ——同一個病在本檔已經出現三次（r2 的 daysUntil 綁定、自審的匯出端、這次的路由端）。
//
// ⚠️ 第七版的教訓（#413 r5 阻擋）：四條全在「配置偏離」那題的前端半邊，**兩條是洞、兩條是假紅**。
//    (a) **假 DOM 太窮，等於把「印完再改掉」整族藏起來**：上一版的 view 替身把 innerHTML 當純字串存、
//        `querySelectorAll` 一律回 `[]`，於是 r4 那顆 wrapper 只要**搬進 renderAssets 自己的尾巴**
//        （`view().querySelectorAll('.tag.amber').forEach((el) => el.remove())`）就照樣靜靜全綠：
//        路由綁定沒變、匯出沒變、模組沒變，而正式資產頁的橘色偏離標籤全部消失。
//        延後一拍再改寫 innerHTML（`setTimeout(…, 0)`）是同一顆的第二種形狀。
//        ⚠️ 上一版劃界寫的是「事件綁好之後的 DOM 行為不在射程內」——那句指的是 click handler，
//        **讀不出「renderAssets 可以自己把剛印好的標籤拔掉」**，而斷言訊息「本題測到的 HTML 到不了畫面」
//        反過來暗示綁對了就到得了畫面。現在這族收進射程（真 DOM harness＋flushLater），劃界也改口。
//    (b) **偏離判準只被「有錢的類別」壓著**：fixture 兩個類別的 value 都 > 0，於是判準多一個
//        `r.value > 0` 的合取子完全無感——而後端對 value=0 的類別照舊發提醒，
//        正是本題自己寫的「總覽說偏離、資產頁不標＝兩頁打架」。「目標 20% 卻一張都沒買」是偏離最大、
//        也最該提醒的一格，現在 fixture 就有這第三個類別。
//    (c)(d) 兩顆**假紅**都在 ROUTES 的形狀斷言上：`Object.freeze({…})`（零行為差異的純強化，
//        而且**正是本檔劃界自己建議的關門方向**——往自己推薦的方向走第一步就假紅，與 declSourceOf 記的
//        r3 教訓、renderAssetsHtml 記的 r4 教訓 (e) 是同一個模式）、以及「前幾條路由分組成常數再展開、
//        assets 仍就地寫死在展開**之後**」（依語言規則後寫的具名屬性一定贏，行為完全相同）。
//        修法是往下拆一層與看位置，不是多認一種形狀（見 frozenObjectArg 與 lateSpread 那條斷言）。
//        ⚠️ 這兩顆上一版被列進「轉紅」表當成守住東西的證據——**假紅記成戰功比缺口更糟**，本輪一起改口。
//
// ⚠️ 第八版的教訓（#413 r26 阻擋）：三顆全在 r25 那個「數欄位之前先扣掉名牌」的動作上——
//    **修法自己是新的攻擊面**。r25 為了治「類別叫『收益 20%』」的假紅而開始扣名牌，扣的手法帶進三個病：
//    (a) 扣完之後用**換行**把剩下的文字節點接起來，於是名牌以外一個被標籤切開的百分比
//        （`30<strong>%</strong>`）被切成 `30\n%` ⇒ 第三欄漏算 ⇒ **該吵著紅的負例靜靜放行**（是洞）；
//    (b) 扣的是「這一塊裡**所有**跟類別同字的文字節點」而不是**已確認的那一處**，
//        於是同一塊裡在真名牌之外再印一次同一個類別名稱時，第二處被自己的計數吃掉 ⇒ **誤放行**；
//    (c) 名牌比對只正規化畫面那一側、拿沒收過空白的類別名去比，於是 ` 收益 20% `／`收益  20%`
//        這兩種**合法輸入**（表單原值送出、後端只驗非空字串）一處名牌都認不出來 ⇒ **假紅**。
//    通則值得記住：**「扣掉一段再判斷」必須把三件事一起講清楚——扣的是哪一個節點（身分，不是內容）、
//    扣完之後剩下的東西怎麼接（相鄰語意，不是換行）、比對前兩側是不是同一套正規化。**
//    修法見 visibleTextOutside／fieldPctCount／classLabelNodes，四種形狀都已釘成常設案例
//    （split-node 第三欄與同塊重複名牌是負例，前後空白與連續空白是正例）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 真正的 JS parser 與作用域分析（ESLint 自己用的那兩顆，隨 devDependency 的 eslint 一起裝）。
// 為什麼不自己寫正則掃字串＝見 loadFrontendSubStatus 的「第二次教訓」。
import { JSDOM } from 'jsdom';
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

test('提醒｜資產配置偏離：恰好等於門檻要出現、差 0.1% 不出現，正負各自出聲；前端資產頁**真的印出來的 HTML** 也各測一次（橘標籤；版面還用 CHART 上色時連進度條顏色一起比對）', async (t) => {
  // ⚠️ 三件事一起釘：
  //    (a) 邊界：恰好偏離 5.0%（＝設定值本身）時提醒消失＝典型的邊界無守衛（>= 改 > 全綠）；
  //        另一側用 4.9% 釘住「門檻不可被偷偷調小」。
  //    (b) 方向：判準是 `Math.abs(row.diff) >= 門檻`。⚠️ 只斷言「有任何一張 alloc-drift 出現」
  //        的話，拿掉 Math.abs 照樣全綠（正偏離那張還在）——所以**正負兩張分別點名**。
  //    (c) 兩份實作：同一個門檻在前端 public/modules/assets.js 有第二份獨立的判斷
  //        （資產頁那條「實際 vs 目標」要不要標「偏離」的橘標籤）。
  //        ⚠️ 這是訂閱那題（subActive／subStatus）被 #413 r1 退回重寫的同一個病型，就在隔壁原封不動：
  //        只改前端那行 `>=` → `> 門檻 * 3`，全部考題零失敗，實際後果是總覽提醒牆說偏離、
  //        資產頁那條卻不標紅，兩頁互相打架。所以前端那份也拉進來測。
  //        ⚠️ 做法在 #413 r4 換過（見 renderAssetsHtml）：從「抽判準式出來算」改成
  //        **整支 assets.js 進 sandbox 跑 renderAssets()、斷言它真的印出來的 HTML**——
  //        射程因此從「判準式的值」推進到「橘標籤真的出現在畫面的 HTML 上」。
  //        ⚠️ **定位**又在 #413 r22／r24／r25／r26 換過四次（見 allocRow）：從「用區塊標題與圖例文案切字串」
  //        改成「照結構找」，再把結構指紋裡殘留的「目標」二字與 `includes` 的子字串比對一起換掉，
  //        接著把欄位計數改成「先扣掉名牌內容再數」，最後把那個「扣」字收乾淨（只扣指名的那一處、
  //        剩下的照相鄰語意接、兩側同一套正規化）——現在只認「類別名牌（正規化後精確）＋同層
  //        **名牌以外**成對的百分比欄位」。起因多數是假紅：Codex UI PR #421 純重排版面，以及
  //        「目標→規劃」等價改寫、「現金／現金等價物」、「收益 20%」、類別名稱多打空白這些合法配置；
  //        r26 另有兩顆是**洞**（名牌以外被切開的第三欄漏算、同塊第二處名牌被自己的計數吃掉）。
  //  造法：現金 5 萬、股票 5 萬 ⇒ 各 50%；目標 45/55 ⇒ 偏離恰好 +5.0%／−5.0%
  const alloc = (cashTarget, stockTarget, extraTargets = []) => ({
    settings: { allocationDriftPct: 5 },
    accounts: [{ id: 'a1', name: '現金', type: 'cash', class: '現金', currency: 'TWD', balance: 50000 }],
    holdings: [{ id: 'h1', symbol: 'CSPX', name: 'ETF', layer: 'core', currency: 'TWD', quantity: 1, price: 50000 }],
    assetTargets: [{ class: '現金', targetPct: cashTarget }, { class: '股票', targetPct: stockTarget }, ...extraTargets],
  });

  // ⚠️ 第三個類別是後補的（#413 r5 阻擋）：目標 20%、**一張都沒買**（value = 0）。
  //    上一版兩個類別的 value 都 > 0，於是前端判準多一個 `r.value > 0` 的合取子完全無感——
  //    複驗者實測 7/7 全綠，而後端對 value=0 的類別照舊發提醒，
  //    正是本題自己寫的「總覽說偏離、資產頁不標＝兩頁打架」。
  //    「目標 20% 卻一張都沒買」是偏離最大的一格，剛好也是最該提醒的一格，所以兩邊都點名。
  const boundaryDb = fullDb(alloc(45, 55, [{ class: '債券', targetPct: 20 }]));
  const boundary = buildSummary(boundaryDb);
  const onBoundary = boundary.reminders
    .filter((/** @type {any} */ r) => String(r.key).startsWith('alloc-drift-'));
  const over = onBoundary.find((/** @type {any} */ r) => r.key === 'alloc-drift-現金');
  const under = onBoundary.find((/** @type {any} */ r) => r.key === 'alloc-drift-股票');
  const zeroValue = onBoundary.find((/** @type {any} */ r) => r.key === 'alloc-drift-債券');
  assert.ok(over, '正偏離恰好 +5.0%（等於門檻）必須提醒——>= 改成 > 就會在邊界上靜靜消失');
  assert.match(over.title, /\+5\.0%/, '標題要顯示 +5.0% 的偏離量');
  assert.ok(under, '負偏離恰好 −5.0% 也必須提醒——判準拿掉 Math.abs（只看正偏離）時，就是這一條轉紅');
  assert.match(under.title, /-5\.0%/, '標題要顯示 -5.0% 的偏離量（負號要在）');
  assert.ok(zeroValue, '後端：目標 20% 卻一張都沒買（value=0）也要提醒——這是偏離最大的一格');
  assert.match(zeroValue.title, /-20\.0%/, '標題要顯示 -20.0%（一張都沒買＝整段目標都缺）');

  const nearMissDb = fullDb(alloc(45.1, 54.9));
  const nearMiss = buildSummary(nearMissDb).reminders
    .filter((/** @type {any} */ r) => String(r.key).startsWith('alloc-drift-'));
  assert.equal(nearMiss.length, 0,
    '偏離 4.9% ＜ 門檻 5%：兩個類別都不可出聲（門檻被偷偷調小、提醒牆被噪音塞滿時會紅）');

  // 前端資產頁那份：吃的是同一份 db（`/summary` 就是 buildSummary 的輸出，正式環境就是這樣接的）
  const boundaryHtml = await renderAssetsHtml(boundaryDb);
  const cash = allocRow(boundaryHtml, '現金');
  const stock = allocRow(boundaryHtml, '股票');
  const bond = allocRow(boundaryHtml, '債券');
  // 三條互不冒充：切成一大塊時，「正偏離那條」的斷言會被負偏離那條混過去（結構定位的第一個自我驗證）
  for (const [row, others] of /** @type {[any, string[]][]} */ ([
    [cash, ['股票', '債券']], [stock, ['現金', '債券']], [bond, ['現金', '股票']],
  ])) {
    for (const other of others) {
      assert.ok(!row.text.includes(other),
        `資產頁的「${row.cls}」那一條裡混進了「${other}」——切太大塊，下面幾條會互相冒充`);
    }
  }
  // ⚠️ fixture 自我驗證讀的是**數字本身**，不是「目標」這兩個字（#413 r24 Finding 1）：
  //    實際比例一律 `toFixed(1)`（`50.0%`）、目標比例照設定值原樣印（`45%`），
  //    兩個數字的形狀本來就不一樣 ⇒ 就算欄位標籤改寫成別的字，仍分得出誰是實際、誰是目標
  //    （把兩者印反 ⇒ 變成 `45.0%` 與 `50%` ⇒ 這兩條都紅）。
  assert.match(cash.text, standalonePct('50.0'),
    'fixture 自我驗證：資產頁的現金那一條真的是 50.0%（否則下面幾條測到的不是邊界）');
  assert.match(cash.text, standalonePct('45'), 'fixture 自我驗證：現金那一條的目標真的是 45%（偏離恰好 +5.0%）');
  assert.equal(driftTag(cash), '偏離 +5.0%',
    '前端：恰好 +5.0% 要在資產頁標出橘色「偏離」標籤（前端 `>=` 鬆掉時只有這裡會紅——總覽說偏離、資產頁不標＝兩頁打架）');
  const painted = assertBarPaint(cash, boundaryHtml, true,
    '前端：偏離時那一條進度條要換成橘色（顏色若改成另外算一份判準、與標籤走散，這條會紅）');
  assert.match(stock.text, standalonePct('50.0'), 'fixture 自我驗證：股票那一條真的是 50.0%');
  assert.match(stock.text, standalonePct('55'), 'fixture 自我驗證：股票那一條的目標真的是 55%（偏離恰好 −5.0%）');
  assert.equal(driftTag(stock), '偏離 -5.0%',
    '前端：恰好 −5.0% 也要標偏離（前端那份拿掉 Math.abs 時會紅）');
  assert.equal(assertBarPaint(stock, boundaryHtml, true, '前端：負偏離那一條的進度條同樣要橘'), painted,
    '同一頁上有的條有 CHART 顏色、有的沒有（要有人回來看）');
  assert.match(bond.text, standalonePct('0.0'),
    'fixture 自我驗證：債券那一條真的是 0.0%（value=0 的那一格；`-20.0%` 的尾巴不算數）');
  assert.match(bond.text, standalonePct('20'), 'fixture 自我驗證：債券那一條的目標真的是 20%');
  assert.equal(driftTag(bond), '偏離 -20.0%',
    '前端：目標 20% 卻一張都沒買也要標偏離（判準多一個 `r.value > 0` 的合取子時只有這裡會紅——後端提醒、資產頁不標＝兩頁打架）');
  assert.equal(assertBarPaint(bond, boundaryHtml, true, '前端：這一格的進度條同樣要橘（0% 也是偏離）'), painted,
    '同一頁上有的條有 CHART 顏色、有的沒有（要有人回來看）');
  if (!painted) {
    // 不靜靜跳過：把「這一輪少驗了什麼」講出來（見 assertBarPaint 的劃界——標籤那一路仍全額釘著）
    t.diagnostic('資產頁的進度條不再用 CHART 的顏色上色（改由 CSS token 著色）'
      + '＝「顏色與標籤走散」這條這一輪沒有東西可比；偏離只剩橘標籤一個出口，上面各條照舊全額釘著。');
  }

  const nearMissHtml = await renderAssetsHtml(nearMissDb);
  const nearMissCash = allocRow(nearMissHtml, '現金');
  assert.match(nearMissCash.text, standalonePct('50.0'), 'fixture 自我驗證：這一組的實際比例真的是 50.0%');
  assert.match(nearMissCash.text, standalonePct('45.1'), 'fixture 自我驗證：這一組真的是 4.9% 的偏離');
  assert.equal(driftTag(nearMissCash), null,
    '前端：偏離 4.9% 不可標偏離（前端門檻被偷偷調小時會紅）');
  assertBarPaint(nearMissCash, nearMissHtml, false, '前端：沒偏離就維持綠色進度條');

  const loosenedDb = { ...boundaryDb, settings: { ...boundaryDb.settings, allocationDriftPct: 6 } };
  assert.equal(driftTag(allocRow(await renderAssetsHtml(loosenedDb), '現金')), null,
    '前端讀的必須是 settings.allocationDriftPct 這把設定（改讀別的鍵時會退回預設 5、把 5.0% 判成偏離，這裡就紅）');

  // ── 合法等價改寫：這些**必須全綠**（#413 r24 的兩顆假紅，逐顆釘成常設考題）──
  // 沒有這一段，「定位不吃顯示文案」就只是嘴上說說——而假紅的標準反應是把考題關掉。
  // (i) 欄位標籤那個字寫什麼都定位得到——三種寫法直接餵定位器（不動正式碼，永遠會跑到）。
  //     ⚠️ 這一顆刻意用合成版面而不是「把真頁面的『目標』replace 成『規劃』」：後者要先假設
  //        真頁面現在印的是「目標」，正式碼哪天真的改叫「規劃」，那顆案例自己就會假紅——
  //        那正是 r24 Finding 1 的病型，等價案例本身不可以再犯一次。
  for (const label of ['目標', '規劃', 'Target']) {
    const row = allocRow(
      `<div><div><span>現金</span><span>50.0% / ${label} 45%</span>`
      + '<span class="tag amber">偏離 +5.0%</span></div><div class="bar"></div></div>', '現金');
    assert.match(row.text, standalonePct('50.0'), `等價案例：欄位標籤寫「${label}」時，實際比例照樣定位得到`);
    assert.match(row.text, standalonePct('45'), `等價案例：欄位標籤寫「${label}」時，目標比例照樣定位得到`);
    assert.equal(driftTag(row), '偏離 +5.0%',
      `等價案例：欄位旁邊的字寫「${label}」都必須定位到同一條列——`
      + '上一版拿「目標」兩個字當必要座標，純文案改寫就假紅（#413 r24 Finding 1）');
  }
  // (ii) 真頁面上**所有非類別名稱的中文字**一次換掉（比「目標→規劃」更狠：區塊標題、圖例、
  //      欄位標籤、連橘標籤裡的「偏離」二字都不留）。定位與那顆標籤照樣讀得到＝顯示文案零座標。
  const CLASSES = ['現金', '股票', '債券'];
  const reworded = boundaryHtml.replace(/[一-鿿]+/g, (m) => (CLASSES.includes(m) ? m : '★'));
  assert.notEqual(reworded, boundaryHtml,
    '等價案例沒改到東西——版面上已經沒有任何「非類別名稱」的中文字（整段改寫成英文？）要有人回來換一個等價改寫');
  for (const [cls, actual, target, drift] of /** @type {[string, string, string, string][]} */ ([
    ['現金', '50.0', '45', '+5.0'], ['股票', '50.0', '55', '-5.0'], ['債券', '0.0', '20', '-20.0'],
  ])) {
    const row = allocRow(reworded, cls);
    assert.match(row.text, standalonePct(actual), `等價案例：文案全換掉後，「${cls}」那一條的實際比例照樣定位得到`);
    assert.match(row.text, standalonePct(target), `等價案例：「${cls}」那一條的目標比例照樣定位得到`);
    assert.match(String(driftTag(row)), new RegExp(`${drift.replace('+', '\\+').replace('.', '\\.')}%`),
      `等價案例：「${cls}」那一條的橘標籤照樣讀得到（標籤認的是 .tag.amber 這個結構，不是「偏離」兩個字）`);
  }
  // 使用者多開一個名字**以現有類別為前綴**的合法類別（現金／現金等價物）：兩條各自定位得到，不可判成重複列
  const twinHtml = await renderAssetsHtml(
    fullDb(alloc(45, 55, [{ class: '債券', targetPct: 20 }, { class: '現金等價物', targetPct: 10 }])));
  const twinCash = allocRow(twinHtml, '現金');
  const twinEquiv = allocRow(twinHtml, '現金等價物');
  assert.notEqual(twinCash.head, twinEquiv.head,
    '等價案例：「現金」與「現金等價物」抓到同一條＝類別比對又退回子字串（#413 r24 Finding 2）');
  assert.match(twinCash.text, standalonePct('45'), '等價案例：「現金」那一條抓到的還是目標 45% 那條');
  assert.equal(driftTag(twinCash), '偏離 +5.0%',
    '等價案例：頁面上多一個「現金等價物」類別時，「現金」那一條的偏離標籤照舊讀得到'
    + '（上一版 `text.includes(cls)` 會把兩條算成重複列＝假紅）');
  assert.match(twinEquiv.text, standalonePct('10'), '等價案例：「現金等價物」那一條抓到的是它自己的目標 10%');
  assert.equal(driftTag(twinEquiv), '偏離 -10.0%', '等價案例：「現金等價物」那一條有它自己的偏離標籤');

  // 使用者把類別**取名成帶百分比的字**（合法自由字串：`lib/schema.js` 的白名單原樣收下，
  // `public/modules/assets.js` 也照樣 esc 之後印出來）：名字裡的 `20%` 不可以被當成第三個欄位（#413 r25 Finding 1）。
  // ⚠️ 名字裡的 `20%` 與這一條真正的目標 `10%` 刻意取不同數字——同號的話，
  //    「認錯欄位」與「認對欄位」會印出一樣的字，這顆案例自己就分不出真假。
  const pctNameHtml = await renderAssetsHtml(
    fullDb(alloc(45, 55, [{ class: '債券', targetPct: 20 }, { class: '收益 20%', targetPct: 10 }])));
  const pctNameRow = allocRow(pctNameHtml, '收益 20%');
  assert.match(pctNameRow.text, standalonePct('0.0'),
    '等價案例：類別名稱帶百分比時，那一條的實際比例（0.0%＝一張都沒買）照樣定位得到');
  assert.match(pctNameRow.text, standalonePct('10'),
    '等價案例：抓到的目標是這一條自己的 10%，不是名字裡那個 20%');
  assert.equal(driftTag(pctNameRow), '偏離 -10.0%',
    '等價案例：類別叫「收益 20%」時偏離標籤照樣讀得到——'
    + '上一版對整層的文字數百分比，名字裡的 `20%` 加上實際／目標合計 3 個 ⇒ 定位不到 ⇒ 假紅（#413 r25 Finding 1）');
  // 同一頁上原本那幾條不可以被這個名字帶壞（名牌只在數自己那一條時被扣掉）
  assert.equal(driftTag(allocRow(pctNameHtml, '現金')), '偏離 +5.0%',
    '等價案例：頁面上多一個名字帶百分比的類別時，「現金」那一條照舊定位得到、標籤照舊讀得到');

  // 使用者在類別名稱**前後多打了空白**、或名字中間按了**連續兩個空白**：兩種都是合法資料
  //（`public/modules/assets.js` 的 collect 把表單原值原樣送出、`lib/routes/crud.js` 只驗非空字串），
  // 版面也原樣印出來。名牌比對只正規化畫面那一側時，這兩種一處都認不出來 ⇒ 假紅（#413 r26 Finding）。
  for (const [raw, kind] of /** @type {[string, string][]} */ ([
    [' 收益 20% ', '前後空白'], ['收益  20%', '連續空白'],
  ])) {
    const rawHtml = await renderAssetsHtml(
      fullDb(alloc(45, 55, [{ class: '債券', targetPct: 20 }, { class: raw, targetPct: 10 }])));
    // fixture 自我驗證：那些空白真的原封不動印到版面上了（被誰收掉的話，這顆案例什麼都沒測到）
    assert.ok(rawHtml.includes(raw),
      `等價案例（${kind}）：版面已不是原樣印出類別名稱（空白被收掉了？）——這顆案例要有人回來換一種寫法`);
    const rawRow = allocRow(rawHtml, raw);
    assert.match(rawRow.text, standalonePct('0.0'),
      `等價案例（${kind}）：類別名稱帶多餘空白時，那一條的實際比例（0.0%）照樣定位得到`);
    assert.match(rawRow.text, standalonePct('10'),
      `等價案例（${kind}）：抓到的目標是這一條自己的 10%，不是名字裡那個 20%`);
    assert.equal(driftTag(rawRow), '偏離 -10.0%',
      `等價案例（${kind}）：類別名稱帶多餘空白時偏離標籤照樣讀得到——`
      + '上一版只正規化畫面那一側、拿沒收過空白的類別名去比，一處名牌都認不出來 ⇒ 假紅（#413 r26 Finding）');
    assert.equal(driftTag(allocRow(rawHtml, '現金')), '偏離 +5.0%',
      `等價案例（${kind}）：同一頁上原本那幾條不可以被這個名字帶壞`);
  }

  // ── 對照組：證明上面幾條真的咬在「結構＋那顆橘標籤」上，不是碰巧在某段字串裡看到「偏離」兩個字 ──
  // （沒有這一段，定位改寫之後「還會不會紅」就只是嘴上說說；本檔記過的空包彈都是這樣長出來的）
  assert.throws(() => allocRow(boundaryHtml, '黃金'), /要 1 條/,
    '對照組：抓一個頁面上沒有的類別必須吵著紅，不可以靜靜回一段空字串（那會讓下面每一條都變空包彈）');
  const noTag = boundaryHtml.replace(/class="tag amber"/g, 'class="tag"');
  assert.notEqual(noTag, boundaryHtml,
    '對照組沒改到東西——版面已不用 `tag amber` 標偏離，上面那幾條 driftTag 斷言要有人回來更新');
  assert.equal(driftTag(allocRow(noTag, '現金')), null,
    '對照組：橘標籤一被拔掉，driftTag 必須看得出來（看得出來，上面「要標偏離」那幾條才守得住東西）');
  const noTarget = boundaryHtml.replace(new RegExp(standalonePct('45').source, 'g'), '45');
  assert.notEqual(noTarget, boundaryHtml, '對照組沒改到東西——現金那一條已不印目標 45%，這顆對照組要有人回來更新');
  assert.throws(() => allocRow(noTarget, '現金'), /要 1 條/,
    '對照組：那一條不再印出成對的「實際／目標」欄位時，定位必須吵著紅（結構指紋失效要有人回來更新，不是靜靜抓到別塊）');
  // 重複列：同一份版面出現兩次＝同一個類別有兩條列，必須吵著紅（不可挑一條靜靜用）
  assert.throws(() => allocRow(boundaryHtml + boundaryHtml, '現金'), /要 1 條/,
    '對照組：同一個類別出現兩條列時必須吵著紅');
  // 兩條列被併成一塊、以及類別名稱不再單獨印成名牌：直接餵定位器一段合成版面（不動正式碼）
  assert.throws(() => allocRow(
    '<div><div><span>現金</span><span>50.0% / 目標 45%</span>'
    + '<span>股票</span><span>50.0% / 目標 55%</span></div><div class="bar"></div></div>', '現金'), /要 1 條/,
    '對照組：兩條列被併成同一塊時必須吵著紅（否則「這一條」會被隔壁那條混過去）');
  assert.throws(() => allocRow(
    '<div><div><span>現金部位 50.0% / 目標 45%</span></div><div class="bar"></div></div>', '現金'), /要 1 條/,
    '對照組：類別名稱不再單獨印成一個名牌（跟別的字黏成一句）時必須吵著紅');
  // 名牌**以外**真的多出第三個不帶號的百分比欄位：照舊要吵著紅
  //（上面「收益 20%」那顆等價案例扣掉的只有名牌自己那一節，不是把第三個欄位一起放行）
  assert.throws(() => allocRow(
    '<div><div><span>現金</span><span>50.0% / 目標 45%</span><span>30%</span></div>'
    + '<div class="bar"></div></div>', '現金'), /要 1 條/,
    '對照組：那一層在名牌以外多出第三個不帶號的百分比欄位時必須吵著紅——'
    + '不然「這一條的實際／目標是哪兩個數字」就沒人守了（#413 r25 修法的劃界）');
  // 同一顆的第二種形狀：第三個欄位被標籤**切成兩節**（`30<strong>%</strong>`）——瀏覽器眼裡一樣是 30%
  assert.throws(() => allocRow(
    '<div><div><span>現金</span><span>50.0% / 目標 45%</span><span>30<strong>%</strong></span></div>'
    + '<div class="bar"></div></div>', '現金'), /要 1 條/,
    '對照組：名牌以外的第三個百分比被標籤切成兩節時同樣要吵著紅——'
    + '上一版把剩下的文字節點用換行接起來，這一格變成 `30\\n%` ⇒ 漏算 ⇒ 該紅的負例靜靜放行（#413 r26 Finding）');
  // 同一塊裡在真正的名牌之外**再印一次**同一個類別名稱：讀法不只一種，必須吵著紅
  assert.throws(() => allocRow(
    '<div><div><span>現金</span><span>50.0% / 目標 45%</span></div>'
    + '<small>現金</small><div class="bar"></div></div>', '現金'), /要 1 處/,
    '對照組：同一塊裡出現第二處同名名牌時必須吵著紅——'
    + '上一版把「所有跟類別同字的文字節點」一律扣掉，第二處被自己的計數吃掉 ⇒ 誤放行（#413 r26 Finding）');
});

/** 進度條顏色的哨兵：CHART.orange／green 由測試端注入這兩串，才驗得出偏離時換的是哪一個顏色。 */
const ORANGE = '__CHART_ORANGE__';
const GREEN = '__CHART_GREEN__';

const APP_REL = 'public/app.js';
const ASSETS_REL = 'public/modules/assets.js';

/**
 * 斷言「**`ROUTES.assets` 綁到的**就是本題搬進 sandbox 的那一支 renderAssets」。
 *
 * ⚠️ 措辭刻意不寫成「使用者按下時跑的就是它」（#413 r5 非阻擋指出前後不一致）：下面的劃界第 1 條
 *    自己承認**不驗 `router()` 有沒有在用 `ROUTES` 這張表、也不驗查表之前有沒有特例分支**——
 *    那句話比這條檢查做得到的事大。承諾要跟射程對齊。
 *
 * ⚠️ 這條檢查存在的唯一理由＝#413 r4 的阻擋繞法（值得原地逐字記下來）：上一版只從 assets.js
 *    取回一支同名函式來跑，**完全沒有核對正式路由接到誰**。複驗者於是保留 `renderAssets()` 一字不動、
 *    在 app.js 另寫一支 `renderAssetsWithoutDrift()`（先呼叫舊 renderer，再從真正的 DOM 移除
 *    `.tag.amber`），把 `ROUTES.assets` 改接新的那支——**正式資產頁真的不再顯示橘色偏離標籤**，
 *    而新增 7 題全綠、完整套件全綠、typecheck／lint 全綠。當時那處劃界還寫著「改由別的函式渲染
 *    會吵著紅」，那句話因此是**假的**（現在改成事實了，見 renderAssetsHtml 劃界第 2 條）。
 *
 * 認的是「綁到誰」而不是形狀（同 assertDaysUntilBinding 的做法：問語言的作用域規則，不是認字串）：
 *   - `assets: renderAssets`（現況）、`assets: renderAssetsPage`（**改名 import**）都收——
 *     配對看的是「來自哪支模組的哪個匯出」，不是本地叫什麼名字。
 *   - `assets: () => renderAssets()`（**純轉手包一層**，router 是 `await fn()`＝行為等價）也收，
 *     見 passThroughCallee；轉手包裝裡多做任何第二件事（複驗者那顆繞法的形狀）就不是純轉手＝紅。
 *   - 註解不必特別處理：對 parser 而言註解不存在（AGENTS.md 那條硬規則）。
 *
 * ⚠️ 誠實劃界（認不了什麼／擋不住什麼）：
 *   1. 射程止於 **app.js 的 `ROUTES` 這張表**。`router()` 哪天改查別張表、或資產頁改由別處
 *      （例如 index.html 自己接）渲染，本題認不出來——這條檢查會照舊全綠。
 *      「router 真的照 ROUTES 分派」不在本題射程內。
 *   2. `ROUTES` 必須是「看得出 assets 綁到誰」的就地物件字面值。認不出來的三種寫法各有一條斷言點名、
 *      **吵著紅**要人回來更新，不是靜靜綠：真的動態組表（例 `Object.freeze(Object.assign({}, …))`）、
 *      展開（`...`）排在 assets 那一條**之後**（後寫的會蓋掉它）、事後 `ROUTES.assets = …` 賦值。
 *      ⚠️ 反過來，這幾種**不算**（零行為差異，不可假紅——#413 r5 的兩顆假紅就在這裡）：
 *      `Object.freeze({…})`／`Object.seal({…})` 純強化（拆開參數再往下驗，見 frozenObjectArg；
 *      而它**正是本條末尾自己建議的那個關門方向的第一步**）、展開排在 assets **之前**、
 *      assets 改名 import。
 *      ⚠️ 「事後改表」只認得**賦值**這一種：`Object.assign(ROUTES, { assets: … })` 這類
 *      **用函式改表**認不出來——**這句是量過的**：那顆繞法實測 7/7 靜靜全綠。之所以不補：本檔現行的
 *      `Object.hasOwn(ROUTES, route) ? ROUTES[route] : …` 也是「把 ROUTES 整個交給某個函式」，
 *      要分辨得回頭列舉哪些函式無害——那正是本檔記了三次的「列舉繞法補不完」。
 *      真要關門得換方向（把路由表連分派一起收成一支唯讀的單一真相），那是另一支 PR 的事。
 *   3. 轉手包裝只跟著走「整個本體就是一句呼叫」的形狀。寫成別的等價形狀
 *      （例如 `assets: async () => { const r = await renderAssets(); return r; }`）會吵著紅——
 *      這是刻意的：包裝裡能不能多做事，必須有人看過才算。
 *
 * ⚠️ 這些話是量過的（#413 r5 這一輪逐顆重跑，正式碼真的改、grep 確認落地後才跑）：
 *    **轉紅**（fail 1、pass 6，不是整支崩）：r4 那顆 wrapper 逐字重放（具名函式）、
 *    同一顆改寫成就地箭頭（做兩件事的版本）、assets.js 同檔改名匯出
 *    （`export { renderAssetsNoDrift as renderAssets }`，本體一字不動）、
 *    路由改指分叉出來的 `assets-v2.js`（門檻鬆一格）、真的動態組表
 *    （`Object.freeze(Object.assign({}, BASE_ROUTES))`）、展開排在 assets **之後**
 *    （`...LATE_ROUTES` 把 assets 蓋成銀行帳戶頁）、`ROUTES.assets = …` 事後賦值。
 *    **維持全綠**（等價改寫，不可假紅）：`renderAssets as renderAssetsPage` 改名 import、
 *    `assets: () => renderAssets()` 純轉手、`Object.freeze({…})`、`Object.seal({…})`、
 *    前三條路由分組成常數再展開（assets 仍就地寫死在展開之後；再加 freeze 的版本也一起量過）。
 */
function assertAssetsRouteBinding() {
  const app = parseModule(APP_REL);
  const def = topLevelDef(app, 'ROUTES');
  assert.equal(def.type, 'Variable', `${APP_REL} 的 ROUTES 不是就地宣告的變數（實際：${def.type}）`);
  let table = def.node.init;
  for (let inner = frozenObjectArg(app, table); inner; inner = frozenObjectArg(app, table)) table = inner;
  assert.equal(table && table.type, 'ObjectExpression',
    `${APP_REL} 的 ROUTES 不是就地寫死的物件字面值（改成動態組表了？本題認不出 assets 綁到誰，要有人回來更新）`);
  walkAst(app.ast, (/** @type {any} */ n) => {
    assert.ok(!(n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression'
      && n.left.object.type === 'Identifier' && n.left.object.name === 'ROUTES'),
      `${APP_REL}:${n.loc.start.line} 事後對 ROUTES 的欄位賦值（ROUTES.x = …）：`
      + '物件字面值不再是最後的答案，本題要有人回來更新');
  });
  const props = table.properties.filter((/** @type {any} */ p) => p.type === 'Property' && !p.computed
    && (p.key.type === 'Identifier' ? p.key.name : p.key.value) === 'assets');
  assert.equal(props.length, 1,
    `${APP_REL} 的 ROUTES 裡叫 assets 的那一條有 ${props.length} 份`
    + '（0＝路由改名、改用算出來的鍵，或整條被搬進展開進來的那一份；>1＝重複）'
    + '——使用者按「資產配置」跑到誰會變成用猜的');
  // 展開（...）只在**排在 assets 之後**時才成問題：依語言規則，後寫的才會蓋掉先寫的。
  // 排在 assets 之前的展開（例：把前幾條路由分組成 MONEY_ROUTES 再展開、assets 仍就地寫死在後面）
  // 行為完全相同，不可假紅（#413 r5 阻擋）。
  const assetsAt = table.properties.indexOf(props[0]);
  const lateSpread = table.properties.find((/** @type {any} */ p, /** @type {number} */ i) =>
    p.type === 'SpreadElement' && i > assetsAt);
  assert.ok(!lateSpread,
    `${APP_REL}:${lateSpread && lateSpread.loc.start.line} 的展開（...）排在 assets 那一條之後：`
    + '後寫的會蓋掉 assets，本題認不出最後綁到誰，要有人回來更新');

  let node = props[0].value;
  for (let hop = 0; hop < 3; hop++) {              // 純轉手包裝算等價寫法，跟著它走（不算假紅）
    const callee = passThroughCallee(node);
    if (!callee) break;
    node = callee;
  }
  assert.equal(node.type, 'Identifier',
    `${APP_REL} 的 ROUTES.assets 綁的不是一個名字（實際：${node.type}）——`
    + '本題認不出資產頁跑的是哪一支，要有人回來更新（純轉手包一層是收的，見 passThroughCallee）');
  const ref = app.manager.scopes.flatMap((/** @type {any} */ s) => s.references)
    .find((/** @type {any} */ r) => r.identifier === node);
  assert.ok(ref, `${APP_REL} 的 ROUTES.assets 綁的 ${node.name} 在作用域圖上找不到（本題要有人回來更新）`);
  const variable = ref.resolved;
  assert.ok(variable, `${APP_REL} 的 ROUTES.assets 綁的 ${node.name} 解析不到任何宣告（全域漏網？）`);
  assert.equal(variable.scope.type, 'module',
    `${APP_REL} 的 ROUTES.assets 綁到的 ${node.name} 不在模組層（實際：${variable.scope.type}）`);
  assert.equal(variable.defs.length, 1, `${APP_REL} 的 ${node.name} 有 ${variable.defs.length} 份宣告`);
  const bind = variable.defs[0];
  assert.equal(bind.type, 'ImportBinding',
    `${APP_REL} 的 ROUTES.assets 綁到的 ${node.name} 是本檔就地宣告的（實際：${bind.type}）——`
    + `資產頁跑的不是 ${ASSETS_REL} 匯出的那一支，本題測到的 HTML 到不了畫面`
    + '（#413 r4 的繞法：另寫一支 wrapper 先呼叫舊 renderer、再把橘標籤從 DOM 移掉）');
  assert.equal(bind.node.type, 'ImportSpecifier',
    'ROUTES.assets 必須綁到具名 import（default／namespace 引入＝本題認不出跑的是哪一支）');
  assert.equal(bind.node.imported.name, 'renderAssets',
    `ROUTES.assets 綁到的是 ${bind.node.imported.name}、不是 renderAssets——資產頁跑的是另一支`);
  const source = String(bind.parent.source.value);
  assert.ok(source.startsWith('.'), `ROUTES.assets 的 renderAssets 來自「${source}」，不是相對路徑`);
  assert.equal(resolve(dirname(join(ROOT, APP_REL)), source), join(ROOT, ASSETS_REL),
    `ROUTES.assets 的 renderAssets 來自「${source}」，不是本題搬進 sandbox 的 ${ASSETS_REL}`);
}

/**
 * `Object.freeze({…})`／`Object.seal({…})` 只包著一個物件字面值時 ⇒ 回傳裡面那個字面值（否則 null）。
 *
 * ⚠️ 為什麼要拆（#413 r5 阻擋的假紅，值得原地記下來）：`const ROUTES = Object.freeze({…})` 是
 *    **零行為差異的純強化**，而且正是本處劃界第 2 條自己建議的關門方向（「把路由表收成唯讀的單一真相」）——
 *    上一版卻在那一步就以形狀斷言轉紅，訊息還把它誤判成「改成動態組表了」。
 *    要認出 assets 綁到誰完全不需要新資訊：`Object.freeze` 的參數就是原封不動的那個物件字面值。
 *    這與 declSourceOf 記的 r3 教訓是同一個模式：**形狀斷言不可比正式行為還嚴**。
 * `Object` 本身被就地宣告或 import 遮蔽掉時**不拆**（那不是語言的 Object，包出來的東西無從得知）——
 * 那種寫法會落到上面那條 ObjectExpression 斷言、吵著紅要人回來看。
 */
function frozenObjectArg(mod, node) {
  if (!node || node.type !== 'CallExpression' || node.arguments.length !== 1) return null;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return null;
  if (callee.object.type !== 'Identifier' || callee.object.name !== 'Object') return null;
  // preventExtensions 也是行為等價的包裝（#413 r6 非阻擋：複驗實測它會假紅在「不是物件字面值」）
  if (callee.property.type !== 'Identifier'
    || !['freeze', 'seal', 'preventExtensions'].includes(callee.property.name)) return null;
  const ref = mod.manager.scopes.flatMap((/** @type {any} */ s) => s.references)
    .find((/** @type {any} */ r) => r.identifier === callee.object);
  if (ref && ref.resolved) return null;             // 被本檔的宣告／import 遮蔽掉＝不是語言的 Object
  const arg = node.arguments[0];
  if (arg.type === 'ObjectExpression') return arg;
  // ⚠️ 巢狀包裝也要拆（#413 r5 非阻擋）：`Object.freeze(Object.seal({…}))` 與單層完全等價，
  //    上一版只接直接包住物件字面值 ⇒ 那種寫法會假紅在「不是物件字面值」。假紅的標準反應是
  //    把考題放寬掉，所以寧可現在遞迴。
  return frozenObjectArg(mod, arg);
}

/**
 * 「整個本體就是一句呼叫」的轉手包裝 ⇒ 回傳被呼叫的那個東西（`() => renderAssets()` ⇒ `renderAssets`）。
 * 不是這種形狀就回 null（由呼叫端吵著紅）。刻意窄：包裝裡多做第二件事就認不得，
 * 因為「先呼叫原 renderer、再把標籤拔掉」正是要擋的那顆繞法。
 */
function passThroughCallee(node) {
  // `renderAssets.bind(null)`／`.bind(this 值)` 也是純轉手（#413 r6 非阻擋：複驗實測它會假紅在
  // 「綁的不是一個名字」）。只收 **零或一個引數**：`.bind(null, x)` 會預填參數＝行為改了，紅是對的。
  if (node && node.type === 'CallExpression' && node.arguments.length <= 1
    && node.callee.type === 'MemberExpression' && !node.callee.computed
    && node.callee.property.type === 'Identifier' && node.callee.property.name === 'bind') {
    return node.callee.object;
  }
  if (!node || (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression')) return null;
  let body = node.body;
  if (body.type === 'BlockStatement') {
    if (body.body.length !== 1) return null;
    const only = body.body[0];
    if (only.type === 'ReturnStatement') body = only.argument;
    else if (only.type === 'ExpressionStatement') body = only.expression;
    else return null;
  }
  if (body && body.type === 'AwaitExpression') body = body.argument;
  return body && body.type === 'CallExpression' ? body.callee : null;
}

/** 走過整棵語法樹。（espree 不掛 parent 指標，所以「某個節點的上一層是誰」得自己走下來看。） */
function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'range' || key === 'loc' || key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach((/** @type {any} */ c) => walkAst(c, visit));
    else if (child && typeof child === 'object' && typeof child.type === 'string') walkAst(child, visit);
  }
}

/**
 * 把 public/modules/assets.js **整支模組**搬進 sandbox 跑 `renderAssets()`，回傳它寫進 `view()` 的 HTML。
 * 做法：用語法樹的位置切掉 import 宣告與 export 關鍵字（**其餘一個字不動**），剩下整段丟進 `new Function`，
 * 它要的外部名字（import 的本地名、node 沒有的瀏覽器全域如 `Chart`）由測試端注入替身。
 * 於是資產頁那條「偏離」橘標籤是**正式碼自己算、自己印**的，不是測試裡另抄一份判準。
 * ⚠️ 進度條只在**版面還用 CHART 上色時**才連顏色一起比對（#413 r24 Finding 3 的改口）：
 *    #421 起進度條改用 CSS 變數與設計 token 著色、`assets.js` 連 CHART 都不再 import，
 *    HTML 上只剩寬度，顏色由樣式表決定＝**沒有東西可比、也沒有驗過**（那一輪會發 diagnostic
 *    講明少驗了什麼，見 assertBarPaint 與劃界第 1 條）。這一段別讀成「顏色已驗」。
 *
 * ⚠️ 為什麼從「抽判準式出來算」改成「跑整支模組」（#413 r4 阻擋，五顆假紅擠在同一處，值得原地記下來）：
 *    上一版的做法是「在語法樹上找到橘標籤那個三元式 → 取它的條件旗標 → 把旗標的初始值切下來包成
 *    `(r, db) => boolean` 現場跑」。它擋得住的東西是真的，但**對等價改寫過敏**——複驗者五顆突變
 *    全部是「正式行為一字未變卻轉紅」：
 *      (a) assets.js 只要出現第二個 `tag amber` 三元式（例：總負債卡加一張「負債大於資產」標籤）
 *          就撞上「只能有一處」那條計數斷言。`tag amber` 是全站慣用寫法（public/ 下十處、八個模組），
 *          日常功能開發就會踩到。
 *      (b)(c) 把 map 回呼的參數 `r` 純改名成 `row`、把 `const [db, alloc] = …` 的 `db` 改名成 `store`
 *          ——sandbox 硬寫 `new Function('r', 'db', …)`，於是 ReferenceError。參數名不是介面。
 *      (d) 把門檻提到迴圈外（`const driftPct = …` ＋ `>= driftPct`）——切下來的初始值不再自成一體。
 *      (e) 把判準抽成 helper（`const isDrift = (r, db) => …`）——同上。這顆最該記：
 *          **上一版劃界第 1 條自己建議的關門方向就是「把偏離判準抽出去共用」**，
 *          往那個方向走的第一步就會讓本題假紅。
 *    共同病根是「切一小段原始碼出來跑」這個手法本身：它必須認得判準長什麼形狀、住在哪一層、叫什麼名字。
 *    正解不是多認幾種形狀，是**不再切**——整支模組原封不動搬進去跑，改名／搬家／抽 helper／
 *    多一張橘標籤全部與本題無關。
 *    ⚠️ 這句話是量過的，不是講講而已：(a)–(e) 五顆逐字重放**全綠**（#413 r5 這一輪逐顆重跑），
 *    另外兩顆等價改寫也全綠：`renderAssets` 改寫成 `export const` 箭頭函式、
 *    兩處 `b.onclick = …` 改成 `b.addEventListener('click', …)`；
 *    r4 那一輪另外量過「新增一個不相關的 import 並在版面裡用它」，也是全綠。
 *    而真的動行為的全部**轉紅**：本輪重跑的是前端 `>=` 改 `>`、拿掉 `Math.abs`、
 *    判準多一個 `r.value > 0` 的合取子、後端 `>=` 改 `>`；
 *    r4 那一輪另外量過門檻乘 3、改讀別的設定鍵、進度條顏色與標籤走散、探針繞法。
 *    ⚠️ r22 補量的是**跨 PR 那一側**：上面這四顆在「合入 #421 head cc653ba」的樹上逐顆重放同樣轉紅，
 *    而 #421 本身（純重排版面：標題／圖例改寫、列改排序、進度條改用 CSS token）**全綠**。
 *
 * ⚠️ 順帶把上一版明寫「開著」的那個洞關上了：上一版只證明得了「判準式算出來的值在四個邊界上都對」，
 *    把**印在畫面上**的標籤搬進一個不呈現的探針變數就能全綠（複驗者 #413 r3 的繞法）。現在斷言的是
 *    `view().innerHTML` 裡那一條上真的有 `.tag.amber` 這顆標籤，探針繞法會轉紅。
 *
 * ⚠️ 但「跑得動」與「使用者按了資產配置真的跑到它」是兩件事——**#413 r4 的阻擋就在這道縫**：
 *    上一版只從本檔取回一支同名函式，沒有核對正式路由，於是「原 renderer 留著、另接一支
 *    先呼叫它再把橘標籤從 DOM 拔掉的 wrapper」全套考題靜靜全綠。那道縫由 assertAssetsRouteBinding
 *    補上（`ROUTES.assets` 綁的必須就是本檔以 `renderAssets` 之名匯出的那一支）；
 *    匯出這一端也走匯出表（exportedLocalName），同檔改名匯出不會讓 sandbox 抄到沒人在跑的乾淨那份。
 *
 * ⚠️ 誠實劃界（擋不住什麼，逐條寫明）：
 *   1. 這是「原始碼搬進 sandbox＋jsdom 跑」，**不是真瀏覽器視窗**：import 進來的函式仍是替身
 *      （api／esc／wan／CHART…），DOM 則是真的（jsdom）。驗到的是 assets.js 模板印進**活頁面**
 *      的產物——`esc()` 消毒得對不對、`CHART.orange` 實際是什麼顏色、CSS 有沒有把標籤藏起來，
 *      仍不在射程內（jsdom 不做排版與視覺；esc 有自己的考題：test/xss-id-escaping.test.js）。
 *      ⚠️ 所以這裡的用詞是「**印進頁面**」而不是「使用者看得見」：給橘標籤印一個 `hidden`
 *      屬性（瀏覽器上就消失了）本題照舊全綠。「看得見」得靠真瀏覽器＋排版引擎，本題證不了。
 *      ⚠️ 同理，`matchMedia`（jsdom 未實作，本題給了規格形狀的替身）固定回「不符合」：
 *      正式碼若依螢幕寬度或主題分兩種版面，**本題只走「不符合」那一條**（桌面寬度、淺色）。
 *   2. 只跑 `renderAssets()` 這一條路徑，斷言讀的是跑完（含放行計時器與事件圈走過十幾拍、
 *      並**取樣兩次**比對，見 settle／firstSample）之後**活頁面**上的 #view。
 *      **抓得住的是這幾種**（逐顆驗過紅，不是「整族」——那句話 #413 r19 判定為誇大並已改口）：
 *      同一拍就拔標籤、清 body／砍祖先（#view 從頁面消失）、換入口
 *      （view()／byId／document／window 別名都是同一顆真 document）、先篩選或數筆數再動手
 *      （真 DOM 的 matches 與筆數就是正式語意）、明列的延後排程（setTimeout／setInterval／
 *      requestAnimationFrame／queueMicrotask／requestIdleCallback 的裸呼叫與 window.xxx 兩形式，
 *      連同對應的取消器）、訊息通道類（MessageChannel／BroadcastChannel／postMessage＝吵著紅替身）、
 *      子頁面（iframe 類＝渲染後零容忍）、以及**多輪非同步後才動手**（靠兩次取樣比對，
 *      不靠攔截）。⚠️ **抓不住的**：本題沒有明列、也不經事件圈的延後來源（例如把工作交給
 *      本題沒接管的宿主機制），以及「第二次取樣之後」才發生的變更——射程是有限的十幾拍，
 *      不是無限等待。這一條是 r5–r9 五輪假 DOM 攻防的收官：
 *      假 DOM 每答不準一個問題就是一顆靜默繞法（入口→別名→全域→判斷式→筆數），
 *      真 DOM 讓那一整族沒有第二種答案。
 *      **使用者按下按鈕之後** handler 裡做什麼仍不在射程內（本題不點按鈕）。
 *      ⚠️ 「資產頁真的由這一支渲染」**不是憑本題跑得動就成立的**，它由 assertAssetsRouteBinding
 *      另外斷言（`ROUTES.assets` 綁的就是本檔這支匯出）——上一版這裡寫「改由別的函式渲染會吵著紅」，
 *      那句話當時**沒有任何東西撐著、而且是假的**：複驗者留著原 renderer、另接一支先呼叫它再從 DOM
 *      拔掉橘標籤的 wrapper，正式資產頁真的不再標偏離，本題卻全綠。射程與認不得的寫法見該函式的劃界。
 *   3. **偏離判準搬進另一支模組的那天，本題要改寫**：sandbox 給不認得的 import 一個無害替身，
 *      所以不相關的新相依不會把本題弄成假紅；但判準真的搬過去時，邊界斷言會轉紅（不是靜靜綠）——
 *      這句也量過：把判準抽成 `./drift-criterion.js` 的 `isDrift` 再 import 回來，紅的是
 *      「偏離 4.9% 不可標偏離」那條。那時該把本題改成直接 import 那支共用模組，
 *      那也才是真正的關門（見 #409 的零 DOM 模組前例）。
 *   4. 斷言吃的是**畫面上真的印出來的東西**，但**定位不吃顯示文案、也不吃類別名稱的內容**
 *      （#413 r22 起，r24／r25／r26 收乾淨，見 allocRow）：一條列靠「印著類別名稱的**名牌**
 *      （那一節可見文字正規化後精確等於類別名）＋同一層**名牌以外成對的兩個百分比欄位**
 *      （實際／目標；帶號的偏離量不算）」認出來，區塊標題、圖例、標題層級（h2／h3）、
 *      列的排序、CSS class 名稱、**欄位旁邊的字**（「目標 45%」→「規劃 45%」）改寫一律不影響；
 *      使用者把類別取成「現金等價物」「收益 20%」，或名字前後／中間多打了空白
 *      （` 收益 20% `／`收益  20%`）這些合法輸入也一律不影響
 *      ——後幾顆是 r24／r25／r26 抓到的假紅，已各自釘成常設等價案例。
 *      剩下**仍會吵著紅**的是：類別名稱不再單獨印成名牌、兩個欄位不再與名牌同層、
 *      那一層在名牌以外多出第三個不帶號的百分比欄位（連被標籤切成兩節的 `30<strong>%</strong>` 也算）、
 *      同一塊裡同一個類別被印成不只一處名牌、進度條搬離那一條的父層、兩條列併成一塊、
 *      或橘標籤不再是 `.tag.amber`——那些都動到了「使用者看不看得出哪一類偏離」，
 *      要人回來看過才算，不是靜靜綠。
 *      ⚠️ 進度條顏色只在**版面還用 CHART 上色時**比對（#421 起改用 CSS token 著色＝沒有第二個
 *      出口可比，這時發診斷訊息講明少驗了什麼，見 assertBarPaint 的劃界）。
 *   5. 這是「同一口徑兩份實作，兩邊各測一次」的守法，不是消除重複。要根治得把門檻收成一份共用判斷
 *      （前端得能拿到），那是另一支 PR 的事，本支不動正式碼。
 *   6. **「同一段程式在測試環境與真瀏覽器走不同分支」不在射程內**（#413 r12–r19 的完整結論，
 *      這一條是本題最重要的誠實劃界，請不要在讀完就把它當成小字）：
 *      形如 `if (<某個 Chrome 有、jsdom 沒有的東西>) { 把提醒從畫面上拿掉 }` 的改動，
 *      在本題會走「沒有」那一邊 ⇒ 全綠，在使用者的瀏覽器會走「有」那一邊 ⇒ 提醒消失。
 *      r12–r18 我確實試過關掉這一族：在真 DOM 外再包一層 Proxy 守衛，把「讀一個不存在的名字」
 *      變成吵著紅。結局值得原地記下來——**r18 那一輪的七項發現裡有四項是守衛自己造成的誤殺**
 *      （合法 expando 寫入、事件處理器的 `this === currentTarget`、Event 子類的 newTarget、
 *      巢狀拆包後的物件身分），每輪修三個生出三四個：**護欄本身成了缺陷來源**。
 *      真正的關門要真瀏覽器引擎（Playwright 那一級），那是另一支 PR 的規模。
 *      ⚠️ 所以請這樣讀本題的保證（用詞刻意不是「整族」——見第 2 條的逐項明列，#413 r20 改口）：
 *      **抓得住第 2 條明列的那幾種**（同一拍動手、清 body／砍祖先、換入口、篩選與筆數、
 *      明列的五個延後排程、訊息通道類、子頁面、以及取樣兩次涵蓋到的多輪非同步——逐顆驗過紅）；
 *      **抓不住**：只在真瀏覽器才發作的環境分流（第 6 條）、沒明列也不經事件圈的延後來源、
 *      以及「第二次取樣之後」才發生的變更（射程是有限的十幾拍，不是無限等待）。
 */
async function renderAssetsHtml(db) {
  const mod = parseModule(ASSETS_REL);
  // 以 renderAssets 之名對外匯出的是哪一份（同檔改名匯出＝正式頁面跑的不是 sandbox 這一份，吵著紅）
  const exported = exportedLocalName(mod, 'renderAssets');
  topLevelDef(mod, exported);                  // 頂層唯一一份宣告（改名／轉手匯出都吵著紅）
  assertAssetsRouteBinding();                  // 正式資產頁真的接到這一支（見該函式：#413 r4 的阻擋繞法）
  const { body, needs } = moduleAsScript(mod);
  // ---------- 真 DOM（#413 r10：jsdom，William 2026-08-06 拍板） ----------
  // r5–r9 五輪攻防的結論：用「假 DOM」守「畫面不被渲染路徑事後改動」，假 DOM 就得誠實回答
  // **所有**問題——r5 入口（view()）、r6 入口別名與祖先鏈、r7 window 系全域別名、r8 判斷式
  // 說謊（matches() 恆 false）、r9 集合筆數說謊（白名單內查詢恆回 1 顆，真實頁面是 0 顆，
  // 「有沒有東西」被拿來當開關）。每一個答不準的地方都是一顆靜默繞法，追逼真是重造半個
  // 瀏覽器的無底洞。根治＝不再假裝：這裡就是一顆規格級 DOM（jsdom，僅測試用相依），
  // 查詢、篩選、筆數、祖先、別名全部如實反映渲染結果，說謊面整族消失。
  // runScripts:'outside-only' ＝ 開啟 win.eval：模組將**在 jsdom 的 window realm 裡執行**
  // （#413 r10 阻擋：DOM 真了但程式還在 Node realm，`globalThis.document` 在 Node 這頭不存在、
  //  變體靜默略過；realm 遷移後 globalThis === window，老派逃逸 Function('return this')() 也拿到 window）。
  const dom = new JSDOM('<!doctype html><html><body><main id="view"></main></body></html>',
    { runScripts: 'outside-only' });
  const win = dom.window;
  const doc = win.document;
  // sandbox 自己的計時器：**明列的那五個名字**（見下方迴圈）排給「稍後」的工作，
  // 跑完 renderAssets 之後在有限拍數內放行——不是「排程工作全部放行」（#413 r20 改口：
  // 沒被明列、也不經事件圈的延後來源不在射程內；取樣之後的變更同樣不在，見劃界第 2 條）。
  // 取消語意是真的（#413 r13 假紅專查）：上一版的 clear／cancel 只掛在白名單上、其實不取消，
  // 於是「排了又合法取消」（真瀏覽器不會動到 DOM）在本題照樣執行回呼＝假紅。現在配對 id 真的移除。
  let nextTimerId = 1;
  /** @type {Map<number, () => any>} */
  const jobs = new Map();
  const later = (/** @type {any} */ fn, /** @type {any} */ _ms, /** @type {any[]} */ ...args) => {
    const id = nextTimerId++;
    if (typeof fn === 'function') jobs.set(id, () => fn(...args));
    return id;
  };
  const cancelLater = (/** @type {any} */ id) => { jobs.delete(Number(id)); };
  const flushLater = async () => {
    // 放行時排的新工作也要跑（上限只為了防呆：正式碼在渲染路徑上排無窮迴圈計時器是別的問題）
    for (let round = 0; round < 20 && jobs.size; round++) {
      const batch = [...jobs.entries()];
      jobs.clear();
      for (const [, job] of batch) await job();
    }
  };
  // ⚠️ 取消器（clearTimeout 家族）自 #413 r14 起真的接手了：排了又取消＝不執行回呼，
  //    與真瀏覽器一致（現行 assets.js 一顆計時器都沒排）。
  const esc = (/** @type {any} */ s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));
  const num = (/** @type {any} */ n) => String(Number(n) || 0);
  // 已知替身**依「來源模組＋匯出名」配對，不是依 import 進來的本地別名**
  //（#413 r4 的誠實性修正：按本地名配的話，`api as fetchApi` 這種合法改名會配不到替身、
  //  改吃無害替身＝考題莫名其妙壞掉，而正式行為一個字都沒變。改名不是介面。）
  /** @type {Record<string, Record<string, any>>} */
  const stubsBySource = {
    '../app.js': {
      api: async (/** @type {string} */ path) => {
        if (path === '/db') return db;
        if (path === '/summary') return buildSummary(db);    // 正式環境的 /summary 就是這個函式的輸出
        throw new Error(`本題只餵了 /db 與 /summary 的替身，資產頁多打了 ${path}（要有人回來更新本題）`);
      },
      // view／byId 都指到**同一顆真 document**：r5/r6 的「換個入口撈節點」不再有第二種答案，
      // 渲染印出來的 id（pie／addAcc…）也由真 DOM 自然解析——replace 假 el() 的整套需求消失。
      view: () => doc.getElementById('view'),
      byId: (/** @type {any} */ id) => doc.getElementById(String(id)),
      currentRouteSeq: () => 1,
      esc, wan: num, money: num, moneyCur: num, pct: num,
    },
    './theme.js': { CHART: { orange: ORANGE, green: GREEN }, PALETTE: ['#000'], AXIS: '#000' },
    './icons.js': { icon: () => '' },
  };
  // 這台 node 沒有的瀏覽器全域＝一律給真 DOM 的那一份；window 的標準別名（r7 那一族）同一顆。
  // ---------- 交出去的就是真 DOM 本身（#413 r19：守衛層拆除，見檔頭劃界第 6 條） ----------
  // r12–r18 我在真 DOM 外面加了一層 Proxy 守衛，想連「只在真瀏覽器才發作的環境偵測式突變」
  // 也一起關掉（`if (window.<Chrome 專屬 API>)` 在 jsdom 是 undefined ⇒ 靜靜跳過分支）。
  // 那條路在 r18 走到盡頭：那一輪的七項發現裡**有四項是守衛自己造成的誤殺**
  //（合法 expando、`this === currentTarget`、Event 子類的 newTarget、巢狀拆包身分），
  // 每輪修三個生出三四個——護欄本身變成缺陷來源，比它擋掉的東西更貴。
  // 所以退回站得住的核心：**真 DOM 如實反映**已經抓得住劃界第 2 條**逐項明列**的那幾種
  //（同一拍動手／清 body／砍祖先／換入口／篩選與筆數／明列的五個延後排程／訊息通道類／
  //  子頁面／取樣兩次涵蓋到的多輪非同步，全部逐顆驗過紅）——**不是「整族」**（r20 改口）。
  // 至於「同一段程式在兩個引擎走不同分支」——那要真瀏覽器引擎才判得準，明確劃出射程（第 6 條）。
  /** @type {Record<string, any>} */
  const globalStubs = {
    Chart: class { destroy() { } },
    document: doc,
    window: win, self: win, top: win, parent: win, frames: win,
  };
  // 計時器這幾個名字 node 真的有，所以 moduleAsScript 不會列進 needs——本題**刻意換成自己的**：
  // 「印完再延後拔掉」不是逃生門（延後 0 毫秒或 50 毫秒都一樣），所以全部收進排程器（jobs）、跑完一起放行。
  // 裸呼叫（參數注入）與 window.xxx（掛在 window 上叫）兩種形式都要接進同一顆排程器
  //（#413 r10 阻擋＝window 形式漏接；r11 阻擋＝裸 requestIdleCallback 漏列）。
  // 改寫後**驗證真的生效**——r11 抓到上一版空 catch 會吞掉寫入失敗，跟註解宣稱的「不吞」相反：
  // 現在不包 try（寫入丟錯＝直接紅），寫完再讀回比對，不相等也直接丟錯。
  for (const name of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'requestIdleCallback']) {
    globalStubs[name] = later;
    if (!needs.some((/** @type {any} */ n) => n.name === name)) needs.push({ name, source: null, imported: null });
    win[name] = later;
    if (win[name] !== later) throw new Error(`win.${name} 換排程器沒生效（jsdom 版本行為變了？要有人回來看）`);
  }
  for (const name of ['clearTimeout', 'clearInterval', 'cancelAnimationFrame', 'cancelIdleCallback']) {
    globalStubs[name] = cancelLater;
    if (!needs.some((/** @type {any} */ n) => n.name === name)) needs.push({ name, source: null, imported: null });
    win[name] = cancelLater;
    if (win[name] !== cancelLater) throw new Error(`win.${name} 換取消器沒生效（要有人回來看）`);
  }
  // jsdom 沒有實作 `matchMedia`（它是規格 API、只是 jsdom 的已知缺件）——不補的話，正式碼合法用它
  // 判斷版面（例：小螢幕把圖例移到下方）就會 TypeError＝**合法寫法被誤殺**（#413 跨 PR 閘在
  // 與 #421 的組合裡實測到）。給一顆規格形狀的替身，固定回「不符合」＝桌面寬度、淺色。
  // ⚠️ 誠實劃界（併入第 1 條的視覺面）：**版面／主題分支只走「不符合」那一條**，
  //    另一條分支印出來什麼，本題證不了——那要真瀏覽器＋排版引擎。
  win.matchMedia = (/** @type {any} */ q) => ({
    media: String(q), matches: false, onchange: null,
    addEventListener() { }, removeEventListener() { },
    addListener() { }, removeListener() { }, dispatchEvent: () => false,
  });
  // 訊息通道類的延後入口（MessageChannel／BroadcastChannel／window.postMessage）：渲染路徑沒有
  // 任何合法用途，而它們的投遞時序本題排不空——一律換成吵著紅的替身（fail-loud，不吞）。
  win.MessageChannel = class { constructor() { throw new Error('渲染路徑用了 MessageChannel（延後排程的旁門）——要有人回來看過本題'); } };
  win.BroadcastChannel = class { constructor() { throw new Error('渲染路徑用了 BroadcastChannel——要有人回來看過本題'); } };
  win.postMessage = () => { throw new Error('渲染路徑用了 window.postMessage——要有人回來看過本題'); };
  const stubFor = (/** @type {{ name: string, source: string | null, imported: string | null }} */ need) => {
    const table = need.source === null ? globalStubs : (stubsBySource[need.source] || {});
    const key = need.source === null ? need.name : String(need.imported);
    if (Object.hasOwn(table, key)) return table[key];
    // 未知的**瀏覽器全域**（node 沒有、本題也沒餵的名字，例：scheduler／Worker）＝吵著紅
    //（#413 r11 阻擋：背景排程器落到無害替身會把「延後動 DOM」整包吞掉）。
    // 未知的**跨模組 import** 照舊給無害替身——不相關的新相依不可以弄假紅（劃界第 3 條）。
    if (need.source === null) {
      throw new Error(`assets.js 用到本題沒餵過的瀏覽器全域「${need.name}」——要有人回來看過本題（無害替身會吞掉排程類旁門，所以這裡刻意吵著紅）`);
    }
    return benignStub();
  };
  // 在 window realm 裡建函式（取代 Node realm 的 new Function）：realm 內 globalThis === window、
  // 未被參數遮蔽的瀏覽器全域一律解析到同一顆 window——Node 這頭的 global 不再是可逃逸的第二真相。
  const factory = /** @type {any} */ (win.eval(
    `(function (${needs.map((n) => n.name).join(', ')}) { ${body}\nreturn ${exported}; })`));
  const renderAssets = /** @type {() => Promise<void>} */ (factory(...needs.map(stubFor)));
  await renderAssets();
  // 排空＋讓真的事件圈走幾拍。⚠️ 走「幾拍」而不是一拍（#413 r19 阻擋）：複驗者用一條**不經計時器**
  // 的多輪非同步工作（每輪讓一拍、跑完幾輪才拔標籤）逃過單拍取樣——沒有環境偵測、真瀏覽器也會拔掉。
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await flushLater();
      await new Promise((r) => setTimeout(r, 0));
    }
    await flushLater();
  };
  await settle();
  // **取樣兩次**：先記一份，再走同樣多拍，第二份必須一樣——「取樣之後才動手」那條路因此也吵著紅。
  // 這一步刻意不靠任何 Proxy 守衛（r12–r18 那條路已證明護欄自己會變成缺陷來源），
  // 只靠「多等一會兒、再看一次」——便宜、沒有假紅面、而且正式渲染跑完就不再動畫面。
  const firstSample = (doc.getElementById('view') || { innerHTML: '\u0000#view 已不在頁面上' }).innerHTML;
  await settle();
  // 斷言讀「**活的**頁面」：從 document 根重新查，不抓舊參照——
  // 清空 body／砍祖先 ⇒ #view 從頁面上消失（下一行吵著紅）；
  // 拔標籤／改內容 ⇒ innerHTML 如實少字（各題的內容斷言紅）。這正是假 DOM 五輪都做不到的一句話。
  // 子 browsing context（iframe 類）自帶另一個 realm 的原生計時器，本題排不空（#413 r11 阻擋）
  // ——渲染路徑沒有任何合法理由建子頁面，所以直接零容忍：出現就吵著紅。
  assert.equal(doc.querySelectorAll('iframe, frame, object, embed').length, 0,
    '渲染路徑建立了子頁面（iframe 類）——子 realm 的計時器本題排不空，要有人回來看過本題');
  const live = doc.getElementById('view');
  assert.ok(live, '渲染跑完後 #view 已不在頁面上（渲染路徑動到 #view 以外的節點——真瀏覽器裡等於整頁被清）');
  const html = live.innerHTML;
  assert.equal(html, firstSample,
    '渲染跑完、事件圈走了十幾拍之後，#view 的內容又變了'
    + '——渲染路徑有一條「等一等再動畫面」的非同步工作（#413 r19 阻擋：多輪非同步拔標籤）。'
    + '正式碼的渲染路徑跑完就不該再改畫面；真要這樣做，要有人回來看過本題');
  win.close();
  return html;
}


/**
 * 把一支瀏覽器模組整支轉成「`new Function` 裡跑得動的 script」：切掉 import 宣告與 export 關鍵字，
 * 其餘一個字不改。回報它需要外部餵進來的每一個名字，**連身分一起回報**：
 * `{ name: 本地名, source: 來自哪支模組, imported: 那支模組的哪個匯出 }`
 * （`source: null`＝這台 node 沒有的全域，例如 `Chart`；`Math`／`Object` 這種真的有的就用真的）。
 * ⚠️ 身分要連來源＋匯出名一起帶，替身才配得對：只帶本地名的話，`api as fetchApi` 這種
 *    純改名（正式行為完全相同）會配不到替身——那是假紅／莫名其妙的壞掉，不是守住東西。
 */
function moduleAsScript(mod) {
  /** @type {[number, number][]} */
  const cuts = [];
  /** @type {{ name: string, source: string | null, imported: string | null }[]} */
  const needs = [];
  for (const node of mod.scope.block.body) {
    if (node.type === 'ImportDeclaration') {
      cuts.push([node.range[0], node.range[1]]);
      for (const sp of node.specifiers) {
        needs.push({
          name: sp.local.name,
          source: String(node.source.value),
          // 具名 import 帶匯出名；default／namespace 用這兩個記號（本題沒有已知替身，會落到無害替身）
          imported: sp.type === 'ImportSpecifier' ? sp.imported.name
            : sp.type === 'ImportDefaultSpecifier' ? 'default' : '*',
        });
      }
    } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      // 有 declaration＝只去掉 `export`／`export default` 關鍵字（宣告本體留著）；沒有＝整句是匯出表，整句切掉。
      cuts.push(node.declaration ? [node.range[0], node.declaration.range[0]] : [node.range[0], node.range[1]]);
    } else if (node.type === 'ExportAllDeclaration') {
      cuts.push([node.range[0], node.range[1]]);
    }
  }
  let body = mod.src;
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0])) body = body.slice(0, from) + body.slice(to);
  for (const ref of mod.scope.through) {          // 解析不到宣告的名字＝全域（import 已在上面收過）
    const name = ref.identifier.name;
    if (!needs.some((n) => n.name === name) && !(name in globalThis)) {
      needs.push({ name, source: null, imported: null });
    }
  }
  return { body, needs };
}

/**
 * 本題不認得的 import／全域用它頂著：取任何屬性回自己、被呼叫或 new 回自己、塞進模板字串是空字串。
 * 用意是「**不相關**的新相依不會把本題弄成假紅」；而它真的被偏離判準或那段版面吃到時，
 * 邊界斷言會轉紅（該有的標籤沒有／不該有的有／整段抓不到），不是靜靜綠。
 *
 * ⚠️ `then` 一定要回 `undefined`（#413 r4 抓到的誠實性缺口，值得原地記下來）：`then` 也回自己的話，
 *    這顆替身在 `await` 眼裡就是一個「呼叫 then 只會拿到另一個 thenable」的無底洞——
 *    資產頁只要多一個 `await 某個新 import()`，考題不是紅也不是綠，而是**整題逾時**
 *    （node --test 報 `cancelled 1`）。回 undefined ＝ `await 替身` 直接得到替身本身。
 */
function benignStub() {
  /** @type {any} */
  const proxy = new Proxy(function () { }, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : proxy),
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

/** 把一段文字裡的空白收成單一空格（版面換行縮排不同不該影響比對）。 */
function normText(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }

/**
 * 一條配置列上的**兩個百分比欄位**（實際、目標）：`\d+(.\d+)?%` 而且前面**不接正負號**。
 * 帶號的那個（`偏離 +5.0%`／`偏離 -20.0%`）是標籤不是欄位，刻意排除。
 *
 * ⚠️ 這是 #413 r24 Finding 1 的修法：上一版的指紋是「目標 N%」這串**顯示文案**，
 *    於是把列內的「目標 45%」等價改寫成「規劃 45%」（數字、結構、判準、標籤全不動）就假紅。
 *    現在的指紋是「這一層帶著成對的兩個百分比欄位」——欄位**旁邊寫什麼字一律不影響**。
 */
const FIELD_PCT = /(?<![-+\d.])\d+(\.\d+)?%/g;

/**
 * 名牌被扣掉之後留在原處的**隔板**：不是數字、不是 `%`、也不是正負號，
 * 所以「扣掉名牌讓前後兩節黏成一個新數字」（`…20` ＋ `%`）不會發生。
 * 用一個字元而不是換行，是為了保留其餘文字的**相鄰**語意（見 visibleTextOutside）。
 */
const LABEL_GAP = '␀';   // ␀ U+2400（SYMBOL FOR NULL）——**可見字元**，不是控制字元
// ⚠️ 原本寫的是真的 NUL（`\x00`）。那讓 `grep` 直接把整支檔當二進位而拒絕搜尋，
//    git 也只差一點就會這樣判（NUL 落在它取樣的前 8000 位元組內就會）——一旦判成二進位，
//    **GitHub 上就看不到這支檔的 diff、審查者等於審不到**。上面那三條要求（單一字元、
//    不是數字／`%`／正負號）U+2400 一樣滿足。由 test/comment-test-refs.test.js 盯著。

/**
 * 這一層裡**名牌以外**的可見文字：已確認的名牌節點（文字節點或整棵子樹）換成一片隔板，
 * 其餘一律照瀏覽器 `textContent` 的語意**相鄰接起來**。
 *
 * ⚠️ 「相鄰」這三個字是 #413 r26 Finding 的修法，值得原地記下來：上一版把剩下的每個文字節點
 *    用**換行**接起來，於是名牌以外一個被標籤切開的百分比（`30<strong>%</strong>`）
 *    在計數時變成 `30\n%` ⇒ 第三個欄位漏算 ⇒ 該吵著紅的負例靜靜放行。
 *    瀏覽器眼裡那就是連著的「30%」，計數也必須照同一套語意。
 */
function visibleTextOutside(el, labelNodes) {
  let out = '';
  const visit = (/** @type {any} */ node) => {
    for (const child of node.childNodes) {
      if (labelNodes.has(child)) { out += LABEL_GAP; continue; }   // 名牌整個（含子樹）不計
      if (child.nodeType === 3) out += String(child.nodeValue ?? '');
      else if (child.nodeType === 1) visit(child);
    }
  };
  if (el && !labelNodes.has(el)) visit(el);
  return out;
}

/**
 * 這一層裡有幾個**欄位**百分比——數之前先把**傳進來的那幾個已確認名牌**整個扣掉。
 *
 * ⚠️ 這是 #413 r25 Finding 1 的修法：上一版對整個 `textContent` 計數，於是使用者開一個
 *    合法的類別叫「收益 20%」時，**名字裡的 `20%`** 加上實際、目標兩欄合計 3 個，
 *    被「必須恰好 2 個」拒絕 ⇒ 那一條定位不到 ⇒ 假紅。`assetTargets.class` 是自由字串
 *    （`lib/schema.js` 的白名單原樣收下），合法資料不可以改變定位結果——這跟 r24 的
 *    「現金／現金等價物」是同一個病型：**指紋不可以把資料本身的內容當成版面結構**。
 *    名牌是先被 `classLabelNodes` 精確認出來的**類別名稱本身**，不是欄位，所以不計數；
 *    其餘每一個不帶號的百分比照舊算欄位（**旁邊寫什麼字一律不影響**）。
 * ⚠️ 扣掉的是**呼叫端指名的那幾個節點**，不是「這一層裡所有跟類別同字的文字節點」
 *    （#413 r26 Finding）：上一版是後者，於是同一塊裡在真正的名牌之外**再印一次**同一個
 *    類別名稱時，第二個也被一併扣掉 ⇒ 「一個類別在一塊裡只該有一處名牌」沒人守 ⇒ 誤放行。
 *    名牌以外的地方多出第三個不帶號的百分比，照舊吵著紅（連被標籤切成兩節的也算）。
 */
function fieldPctCount(el, labelNodes) {
  return (visibleTextOutside(el, labelNodes).match(FIELD_PCT) || []).length;
}

/**
 * 頁面上把 `cls` **單獨印成一個名牌**的每一處，回傳那個**名牌節點本身**——
 * 通常是文字節點；名牌被標籤切開時（`<span>收益 <em>20%</em></span>`）則是剛好包住整段的那個元素。
 * 一個名牌只認**最內層**的一個節點：外面再包幾層都不會變成第二處。
 *
 * ⚠️ 比對的是「那一節的可見文字**正規化後恰好等於**正規化後的類別名稱」，不是子字串（#413 r24 Finding 2）：
 *    上一版用 `text.includes(cls)`，於是使用者多開一個合法的「現金等價物」類別時，
 *    那一條也算進「現金」名下 ⇒ 兩條各自正確的列被判成「重複列」⇒ 假紅。
 *    類別名稱在版面上本來就是自己一格（`<span>現金 …`／`<strong>現金</strong>`），
 *    用整節文字比對既精確、又不吃它外面包的是什麼標籤。
 * ⚠️ **兩邊都要正規化**（#413 r26 Finding）：上一版只把畫面那一側收空白、拿沒收過的 `cls` 去比，
 *    於是使用者把類別打成 ` 收益 20% `（前後空白）或 `收益  20%`（連續空白）時一處都認不出來 ⇒ 假紅。
 *    那兩種都是合法資料——表單原值直接送出（`public/modules/assets.js` 的 collect），
 *    後端只驗非空字串（`lib/routes/crud.js`），版面也原樣印出來。
 */
function classLabelNodes(root, cls) {
  const want = normText(cls);
  /** @type {any[]} */
  const out = [];
  if (!want) return out;      // 空白類別名沒有可比的名牌；定位會在上層吵著紅，不是靜靜抓到別塊
  /** @returns {boolean} 這棵子樹裡認出名牌了沒 */
  const visit = (/** @type {any} */ node) => {
    if (node.nodeType === 3) {
      if (node.parentElement && normText(node.nodeValue) === want) { out.push(node); return true; }
      return false;
    }
    if (node.nodeType !== 1) return false;
    let inner = false;
    for (const child of node.childNodes) if (visit(child)) inner = true;
    if (inner) return true;                       // 內層已經認出來了＝這一層只是外包裝，不算第二處
    if (normText(node.textContent) === want) { out.push(node); return true; }
    return false;
  };
  for (const child of root.childNodes) visit(child);
  return out;
}

/** 名牌**所在的那個元素**（往上找列的起點）：文字節點取父元素，整棵子樹的名牌就是它自己。 */
function labelHost(node) { return node.nodeType === 3 ? node.parentElement : node; }

/** 某個百分比**單獨**出現（前面不接數字／小數點／負號）：`0.0%` 不可以被 `-20.0%` 的尾巴冒充。 */
function standalonePct(n) { return new RegExp(`(?<![-\\d.])${String(n).replace('.', '\\.')}%`); }

/** @type {Map<string, any>} */
const snapshots = new Map();

/**
 * 把 renderAssetsHtml 交回來的那份**定版快照**重新解析成查得動的 DOM。
 * 刻意解析字串而不是留著活頁面的節點：斷言讀到的必須就是「取樣兩次都一樣」的那一份
 *（見 renderAssetsHtml 的 settle／firstSample），不是取樣之後又被誰動過的活 DOM。
 */
function snapshot(html) {
  let root = snapshots.get(html);
  if (!root) {
    root = new JSDOM(`<!doctype html><html><body><div id="rendered">${html}</div></body></html>`)
      .window.document.getElementById('rendered');
    snapshots.set(html, root);
  }
  return root;
}

/**
 * 從資產頁印出來的 HTML 裡取出某個資產類別那一條（標籤區＋進度條），
 * **照結構與欄位座標找，一個顯示文案都不當必要座標**。
 *
 * 定位規則（兩種版面都成立）：
 *   · 一條列的**頭部** ＝ 從「印著這個類別名稱的名牌」往上走，遇到的第一層**恰好帶著兩個
 *     百分比欄位**（實際、目標；帶正負號的偏離量不算）的祖先——標籤與兩個數字都在這一層；
 *   · 一條列的**整塊** ＝ 那個頭部的父層（進度條就在同一層，兩版皆然）。
 * 名牌＝**那一節的可見文字正規化後恰好等於類別名稱**（見 classLabelNodes），
 * 欄位＝**那一處名牌以外**、照 `textContent` 相鄰語意數出來的成對百分比數字（見 fieldPctCount）。
 * 於是「目標 45%」改寫成「規劃 45%」、區塊標題與圖例改寫、標題層級改寫、
 * 列的排序改寫、CSS class 改名，一律不影響定位；類別名稱裡自己帶了百分比（「收益 20%」）、
 * 或前後／中間多打了空白（` 收益 20% `／`收益  20%`）也一樣。
 *
 * ⚠️ 為什麼一路換到這裡（五輪，值得原地記下來）：
 *    · r22 之前：拿三個**顯示文案**當座標（區塊標題「資產配置 vs 目標」、圖例「深色直線＝目標比例」、
 *      「跳過 `</h3>`」這個標題層級）。Codex UI PR #421 只重排版面、判準與標籤一字未動，本題假紅。
 *    · r22：改成「同時含類別名稱與唯一一個『目標 N%』的最小元素」——結構是進步了，
 *      但**指紋裡還留著「目標」這兩個字**（r24 Finding 1）：把列內的「目標 45%」等價改寫成
 *      「規劃 45%」照樣假紅，而且對照組還明文要求它必須紅。同一個病沒治完。
 *    · r22 的第二個病（r24 Finding 2）：類別用 `text.includes(cls)` 比對，使用者多開一個
 *      合法的「現金等價物」類別時，「現金」會抓到兩條 ⇒ 判成重複列 ⇒ 假紅。
 *    · r24 還剩的第三個病（r25 Finding 1）：欄位是對**整層的文字**數百分比，
 *      於是類別叫「收益 20%」時，名字裡的那個 `20%` 被當成第三個欄位 ⇒ 定位不到 ⇒ 假紅。
 *      改法見 fieldPctCount：**先扣掉已經精確認出來的名牌內容再數**。
 *    · r25 的修法自己帶進三個病（r26 Finding，一次三顆，全在「扣掉名牌」這個動作上）：
 *      ①扣完之後用**換行**把剩下的文字節點接起來 ⇒ 名牌以外被標籤切開的第三個欄位
 *      （`30<strong>%</strong>`）漏算 ⇒ **該紅的負例靜靜放行**（是洞，不是假紅）；
 *      ②扣的是「這一塊裡所有跟類別同字的文字節點」而不是**已確認的那一處** ⇒ 同一塊裡
 *      在真名牌之外再印一次同一個類別名稱時，第二處被一併扣掉 ⇒ **誤放行**；
 *      ③名牌比對只正規化畫面那一側、沒正規化 `cls` ⇒ 使用者把類別打成 ` 收益 20% `
 *      或 `收益  20%`（都是合法資料）時一處都認不出來 ⇒ 假紅。
 *      改法見 visibleTextOutside／fieldPctCount／classLabelNodes：**相鄰語意、只扣指名的那一處、兩邊都正規化**。
 *    現在指紋只剩兩樣**資料本身**：類別名牌（正規化後精確比對）與名牌以外成對的百分比欄位
 *    （不含帶號的偏離量）。四次都是同一個教訓：合法資料不可以改變定位結果。
 *
 * ⚠️ 仍然吵著紅的（這不是「什麼都不認」）：類別名稱不再單獨印成一個名牌、實際／目標兩個欄位
 *    不再與名牌同層、那一層在**名牌以外**多出第三個**不帶號**的百分比欄位（連被標籤切成兩節的也算）、
 *    同一塊裡同一個類別被印成不只一處名牌、進度條搬離那一條的父層、或兩條列被併成同一塊
 *    ——這些都動到了「使用者看不看得出哪一類偏離」，要人回來看過才算。
 */
function allocRow(html, cls) {
  const root = snapshot(html);
  const labels = classLabelNodes(root, cls);
  /** @type {any[]} */
  const heads = [];
  for (const label of labels) {
    // 扣掉的只有**這一處**已確認的名牌：頁面別處（或同一塊裡）再印一次同一個類別名稱時，
    // 那一處照樣算在可見文字裡，才輪得到下面兩句把它擋下來（#413 r26 Finding）。
    const only = new Set([label]);
    let head = labelHost(label);
    while (head && head !== root && fieldPctCount(head, only) < 2) head = head.parentElement;
    // 撐不起一條列的名牌就跳過——頁面別處也會把同一個類別名稱印成一格
    //（例：帳戶明細表的「資產類別」欄），那一格往上沒有成對的百分比欄位，
    // 一路走到整頁時欄位是好幾條列加起來的（不成對）。真的該是一條列卻認不出來時，
    // heads 會少一條 ⇒ 下面那句 assert 吵著紅，不會靜靜略過。
    if (!head || head === root) continue;
    if (fieldPctCount(head, only) !== 2) continue;
    if (classLabelNodes(head, cls).length !== 1) continue;
    if (!heads.includes(head)) heads.push(head);
  }
  assert.equal(heads.length, 1,
    `資產頁的配置區塊裡「印著「${cls}」名牌、且同一層在名牌以外恰好帶著兩個百分比欄位（實際／目標）」的列`
    + `有 ${heads.length} 條（要 1 條；頁面上共有 ${labels.length} 處把「${cls}」單獨印成名牌）`
    + '——0＝sandbox 沒渲染成功、類別名稱沒單獨印成名牌、兩個欄位不再與名牌同層、'
    + '或兩條列被併成一塊（欄位不成對）；>1＝同一類別被印成好幾條。兩種都要有人回來更新本題');
  const head = heads[0];
  const block = head.parentElement;
  assert.ok(block && block !== root,
    `資產頁的「${cls}」那一條沒有外層（進度條與標籤不再同屬一塊＝要有人回來更新本題）`);
  const blockLabels = classLabelNodes(block, cls);
  assert.equal(blockLabels.length, 1,
    `資產頁的「${cls}」那一塊裡把類別名稱單獨印成名牌的有 ${blockLabels.length} 處（要 1 處）——`
    + '同一塊裡除了那一條的名牌之外還印了一次同一個類別名稱，「這一條是哪一條」就不只一種讀法'
    + '（要有人回來更新本題）');
  assert.equal(fieldPctCount(block, new Set(blockLabels)), 2,
    `資產頁的「${cls}」那一塊裡有不只一組「實際／目標」百分比欄位——兩條列被併在同一塊，`
    + '本題的「這一條」會被隔壁那條混過去（要有人回來更新本題）');
  return { cls, head, block, text: normText(head.textContent), html: block.innerHTML };
}

/**
 * 那一條上**真的印出來的**橘色偏離標籤（`.tag.amber`）的文字；沒標就回 null。
 * 認的是標籤這個結構本身，不是「這段字裡有沒有『偏離』兩個字」——
 * 頁面別處的說明文案（例：#421 的面板附註「偏離門檻 5%」）不可以冒充成「這一條被標了偏離」。
 */
function driftTag(row) {
  const tags = [...row.head.querySelectorAll('.tag.amber')];
  assert.ok(tags.length <= 1,
    `資產頁的「${row.cls}」那一條上有 ${tags.length} 個橘標籤（要有人回來更新本題）`);
  return tags.length ? normText(tags[0].textContent) : null;
}

/**
 * 進度條顏色是同一個旗標（`off`）的**第二個出口**：與標籤走散＝標籤說偏離、進度條卻還是綠的。
 * 有比對到就回 true，**版面根本不用 CHART 的顏色上色時回 false**（沒有第二個出口可比）。
 *
 * ⚠️ 這個 false 是誠實的缺口，不是暗門，請照這樣讀（#413 跨 PR 閘的實測結論）：
 *    判斷依據是「**整頁**還有沒有 CHART 的顏色哨兵」，不是「這一條有沒有」。
 *    · 想把偏離那條的橘色偷偷拿掉、其餘照舊上色 ⇒ 整頁仍有哨兵 ⇒ 走下面的比對 ⇒ **紅**。
 *    · 要讓這裡回 false，得把整頁的 CHART 上色全部撤掉——那是整段版面改寫
 *      （#421 就是：進度條改用 CSS 變數與設計 token 著色，`CHART` 連 import 都不再需要），
 *      不是「悄悄調鬆一格」。那之後偏離只剩標籤這一個出口，而標籤那一路本題照舊全額釘著。
 *    真要連「CSS 決定的顏色」也一起守，得靠真瀏覽器＋排版引擎（見 renderAssetsHtml 劃界第 1 條）。
 */
function assertBarPaint(row, html, drifting, why) {
  if (!html.includes(ORANGE) && !html.includes(GREEN)) return false;
  assert.match(row.html, new RegExp(drifting ? ORANGE : GREEN), why);
  assert.doesNotMatch(row.html, new RegExp(drifting ? GREEN : ORANGE),
    `資產頁的「${row.cls}」那一條同時吃到兩種顏色（顏色與標籤走散了？要有人回來看）`);
  return true;
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
 * ⚠️ **第三次教訓（#413 自審阻擋）：綁定檢查只走到 import 這一端，匯出那一端還是空的。**
 *    上一版的誠實劃界第 2 條寫「app.js 那個匯出算得對不對，是 app.js 自己的考題」——
 *    全套考題裡並沒有那樣一題，所以那句話是**沒有東西撐著的口頭承諾**。自審者把 r2 的繞法
 *    原樣搬到隔壁檔就穿過去了：app.js 留一份沒被匯出的乾淨 `daysUntil`、真正對外的改成
 *    `export { daysUntilShifted as daysUntil }`（函式本體一個字都沒改）。subscriptions.js 的
 *    import 一字未動＝下面四條斷言全過，而當時的切法只用「頂層有沒有這個名字」去找，
 *    抄走的正是那份沒人在跑的乾淨函式。修法＝跨檔那兩份先走匯出表
 *    （見 exportedSourceOf／exportedLocalName）：切下來的必須就是**以該名字對外匯出**的那一份。
 *
 * ⚠️ **第四次教訓（#413 r3 阻擋，這顆是考題自己的錯，不是正式碼的）：形狀斷言不可比正式行為還嚴。**
 *    上一版切原始碼時硬要求變數宣告，於是把 `export const parseLocalDate = (d) => {…}` 改寫成
 *    等價的 `export function parseLocalDate(d) {…}`（本體逐字不變、行為完全相同）也會紅＝**假紅**。
 *    現在兩種等價形狀都收（見 declSourceOf）；那顆突變也已從「行為突變證據」裡撤掉。
 *
 * ⚠️ 誠實劃界（擋不住什麼，逐條寫明——這段話自己也要禁得起反例）：
 *    1. 只管 subStatus 這條路。訂閱頁若改成**不靠 subStatus 分組**（換另一套判斷）、
 *       或前端別處自己再算一次停用日，本題照樣綠——那要靠頁面層的考題，不在射程內。
 *    2. 跨檔的口徑只釘到**模組介面**為止：subscriptions.js 那頭證明「`daysUntil` 綁到來自
 *       `../app.js` 的同名具名 import」，app.js 這頭證明「以 `daysUntil` 之名匯出的就是本檔頂層
 *       那份、被抄進 sandbox 的宣告」，兩頭接得起來。轉手匯出、同檔改名匯出、重複匯出、
 *       改用星號匯出都會**吵著紅**要人回來更新，不是靜靜綠。
 *       至於 app.js 內部：daysUntil 本體引用的 `parseLocalDate` 走同一套檢查（也是頂層唯一宣告
 *       ＋以同名匯出），它若改引用別的名字，sandbox 會 ReferenceError＝紅得很吵。
 *       三份宣告（parseLocalDate／daysUntil／subStatus）用 `const` 箭頭或 `function` 寫都抓得到
 *       ＝**不需要有人回來更新**（等價形狀，見 declSourceOf；三份都實測過改寫成另一種形狀仍全綠，
 *       而在該形狀上動真正的行為照樣轉紅）。
 *    3. subStatus 若改吃 daysUntil 以外的新相依，本題**不會靜靜綠**，但也不是好好轉紅：
 *       sandbox 裡會 ReferenceError（紅得很吵，代表有人得回來更新本題）。
 *    4. 「抄原始碼出來現場跑」這個手法，本質上管不到**執行期才決定**的東西（動態 import、eval）。
 *       要連這些都關掉，得把 subStatus 搬進零 DOM 模組、讓考題直接 import 正式模組。
 *       那條路**刻意沒走**：subStatus 吃的 parseLocalDate／daysUntil 住在 app.js，而 app.js
 *       在 node 裡 import 不起來（本支實測 `import('./public/app.js')`＝當場 TypeError）。
 *       ⚠️ 絆倒點比「app.js 自己綁 DOM」**更早也更深，別寫錯**（本支自審實跑堆疊才發現）：
 *       第一個爆的是它 import 進來的 `public/modules/portfolio.js:37`——模組頂層一句
 *       `let viewCur = localStorage.getItem('pf_viewCur') || 'TWD'`，node 裡 `localStorage`
 *       是 undefined，**app.js 自己的本體連跑都還沒跑到**。app.js 頂層那三處 DOM 綁定
 *       （`document.querySelectorAll('#nav a')`、`window.addEventListener`、
 *       `$('#snapshotBtn').addEventListener`）一樣擋著，只是排在後面。
 *       所以要搬 subStatus，不只是把 parseLocalDate／daysUntil 搬出 app.js 再回頭轉匯出——
 *       整串 import 的瀏覽器相依都要一起處理，是動到前端共用核心的重構，
 *       **成本高、且不在本支（純考題 PR）的範圍內**。
 *       ⚠️ 理由到此為止——**不要寫成「驗不了」**（上一版就是這麼寫的，本支自審打掉）：AGENTS.md 對
 *       「改前端」要求的驗證（**全部頁面 reload 無 console error**，頁面清單＝app.js 的 `ROUTES`）
 *       這棵樹上做得到。repo 自己備著手段——`.claude/launch.json` 的 `finance-test`（`STORE_FILE`
 *       指暫存 .db ＋獨立 PORT，不碰 `data/`）；同樣手法在本樹實測過，server 起得來、
 *       `/`＋`/api/summary`＋`/app.js` 皆 200（200 不等於零 console error，**逐頁 reload 那段是工、
 *       不是關著的門**），`docs/每日洞察引擎-施工計畫.md` 也記著曾用它跑完整輪零 console error。
 *       所以這裡劃的是**範圍界、不是能力界**：真要搬，補足那輪驗證再動共用核心即可。
 */
function loadFrontendSubStatus() {
  const app = parseModule('public/app.js');
  const subs = parseModule('public/modules/subscriptions.js');
  const status = localSourceOf(subs, 'subStatus');
  assertDaysUntilBinding(subs, status.bodyNode);
  const src = [exportedSourceOf(app, 'parseLocalDate'), exportedSourceOf(app, 'daysUntil'), status.source].join('\n');
  return /** @type {(s: any) => string} */ (new Function(`${src}\nreturn subStatus;`)());
}

/** 用真正的 parser 把一支模組解析成語法樹＋作用域圖（不是自己寫正則掃字串——見上面第二次教訓）。
 *  註：本函式那條 `assert.ok(scope)`＝**函式庫回傳值的防呆**，不是守正式碼的斷言
 *  （ES module 必有模組作用域，正式碼怎麼改都碰不到它）；留著只為了 espree／eslint-scope
 *  哪天換 API 時錯得看得懂。⚠️ assertDaysUntilBinding 裡那條 `assert.ok(fnScope)` **不同**：
 *  subStatus 若改成「宣告的本體不是函式」（例如 `const subStatus = memoize(…)`），它會真的失敗——
 *  那是要人回來更新本題的吵鬧紅，不是防呆。 */
function parseModule(relPath) {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  const ast = parseJs(src, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const manager = analyzeScopes(ast, { ecmaVersion: 2026, sourceType: 'module' });
  const scope = manager.scopes.find((/** @type {any} */ s) => s.type === 'module');
  assert.ok(scope, `${relPath} 解析不出模組作用域（它還是 ES module 嗎？）`);
  return { relPath, src, ast, manager, scope };
}

/** 取模組頂層某個名字的宣告。找不到／不只一份都吵著紅——改名時要有人回來更新本題，而不是靜靜跳過。 */
function topLevelDef(mod, name) {
  const variable = mod.scope.variables.find((/** @type {any} */ v) => v.name === name);
  assert.ok(variable, `${mod.relPath} 頂層找不到 ${name}（改名或改成轉手匯出了？那要一起更新本考題）`);
  assert.equal(variable.defs.length, 1,
    `${mod.relPath} 的 ${name} 有 ${variable.defs.length} 份宣告，抄哪一份會變成用猜的`);
  return variable.defs[0];
}

/** 一段 `export` 的 declaration 宣告了哪些名字（function／class／var 家族與解構都算）。 */
function declaredNames(decl) {
  if (decl.type === 'VariableDeclaration') return decl.declarations.flatMap((/** @type {any} */ d) => patternNames(d.id));
  return decl.id ? [decl.id.name] : [];
}

/** 綁定樣式（含解構、預設值、rest）宣告出來的名字。 */
function patternNames(node, out = []) {
  if (!node) return out;
  if (node.type === 'Identifier') out.push(node.name);
  else if (node.type === 'ObjectPattern') node.properties.forEach((/** @type {any} */ p) => patternNames(p.type === 'RestElement' ? p.argument : p.value, out));
  else if (node.type === 'ArrayPattern') node.elements.forEach((/** @type {any} */ e) => patternNames(e, out));
  else if (node.type === 'AssignmentPattern') patternNames(node.left, out);
  else if (node.type === 'RestElement') patternNames(node.argument, out);
  return out;
}

/**
 * 找出模組**以 name 這個名字對外匯出**的是哪一份宣告——不是「模組裡剛好也叫 name」的那一份。
 * （#413 自審阻擋：app.js 只要留一份**沒被匯出**的乾淨 `daysUntil`、真正對外的換成
 * `const daysUntilShifted = (d) => daysUntil(d) + 1; export { daysUntilShifted as daysUntil };`，
 * subscriptions.js 的 import 一個字都不用動＝綁定檢查四條全過，而 sandbox 抄走的是那份沒人在跑的
 * 乾淨函式：正式環境「停用日＝今天」回 'ending'、總覽與訂閱頁走散，全套考題靜靜全綠。
 * 名字綁到誰是口徑的一部分，這句話在**匯出這一端**同樣要有東西撐著。）
 */
function exportedLocalName(mod, name) {
  const found = [];
  for (const node of mod.scope.block.body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.declaration && declaredNames(node.declaration).includes(name)) found.push({ local: name, reExport: false });
    for (const sp of node.specifiers || []) {
      if (sp.exported.name === name) found.push({ local: sp.local.name, reExport: Boolean(node.source) });
    }
  }
  assert.equal(found.length, 1,
    `${mod.relPath} 以「${name}」的身分對外匯出的宣告有 ${found.length} 份（0＝沒匯出、或改走轉手／星號匯出；`
    + '>1＝重複匯出）——別的模組 import 到的是哪一份會變成用猜的');
  assert.equal(found[0].reExport, false,
    `${mod.relPath} 的 ${name} 是轉手匯出（export … from），本檔沒有可抄的宣告`);
  assert.equal(found[0].local, name,
    `${mod.relPath} 對外匯出的 ${name} 其實是 ${found[0].local}（同檔改名匯出）——`
    + `別的模組跑的是 ${found[0].local}，不是本檔頂層那個 ${name}，本題要有人回來更新`);
  return found[0].local;
}

/**
 * 把一份頂層宣告還原成 sandbox 跑得動的原始碼（用語法樹的位置切，不是正則），
 * 順便回傳「本體那個節點」給作用域檢查用（`export` 關鍵字不在節點範圍內，切出來就能直接跑）。
 *
 * **兩種等價形狀都收**：`NAME = <運算式>` 的變數宣告（含箭頭／函式運算式）與 `function NAME(…) {…}`。
 * ⚠️ 為什麼要收兩種（#413 r3 阻擋，值得原地記下來）：上一版硬要求變數宣告，複驗者只把
 *    `export const parseLocalDate = (d) => {…}` 改寫成 `export function parseLocalDate(d) {…}`
 *    ——函式本體逐字不變、正式行為完全相同、typecheck 與 lint 全綠——本題就以形狀斷言轉紅。
 *    那是**假紅**：本題要守的是「sandbox 跑的是正式環境那一份」，不是「作者得用哪個關鍵字宣告」。
 *    為了會紅而紅的考題最後會被當成雜訊關掉，比缺口更糟。
 */
function declSourceOf(mod, name, def) {
  if (def.type === 'FunctionName') {
    assert.equal(def.node.type, 'FunctionDeclaration',
      `${mod.relPath} 的 ${name} 是 ${def.node.type}（不是頂層 function 宣告，切不出可獨立執行的原始碼）`);
    return { source: mod.src.slice(def.node.range[0], def.node.range[1]), bodyNode: def.node };
  }
  assert.equal(def.type, 'Variable',
    `${mod.relPath} 的 ${name} 既不是就地宣告的變數、也不是 function 宣告（實際：${def.type}）`);
  assert.equal(def.node.id.type, 'Identifier', `${mod.relPath} 的 ${name} 是解構出來的，本題切不出可獨立執行的宣告`);
  assert.ok(def.node.init, `${mod.relPath} 的 ${name} 沒有初始值`);
  return {
    source: `const ${name} = ${mod.src.slice(def.node.init.range[0], def.node.init.range[1])};`,
    bodyNode: def.node.init,
  };
}

/** 跨檔相依：切下**以 name 之名對外匯出**的那一份（先過 exportedLocalName，不是同名的鄰居）。 */
function exportedSourceOf(mod, name) {
  return declSourceOf(mod, name, topLevelDef(mod, exportedLocalName(mod, name))).source;
}

/** 同檔內呼叫的路徑：切本檔頂層那一份（頁面就是直接叫它的，所以刻意不經匯出表）。 */
function localSourceOf(mod, name) {
  return declSourceOf(mod, name, topLevelDef(mod, name));
}

/**
 * subStatus 裡用到的**每一個** `daysUntil`，依語言的作用域規則都必須解析到
 * 「模組層、來自 `../app.js`、沒改名的具名 import」——也就是本題配進 sandbox 的那一份。
 * （這條檢查存在的唯一理由＝上面兩段繞法；沒有它，本檔宣稱守住的東西守不住。）
 */
function assertDaysUntilBinding(mod, bodyNode) {
  const fnScope = mod.manager.acquire(bodyNode);
  assert.ok(fnScope, `${mod.relPath} 取不到 subStatus 的作用域`
    + `（宣告的本體是 ${bodyNode.type}、不是函式？例如改成 memoize(…) 包一層——那本題要有人回來更新）`);
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
