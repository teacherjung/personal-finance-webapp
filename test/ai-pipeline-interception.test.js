// @ts-check
// P1b-3 續集：**全管線**條件攔截率——同 P1b-3 的 23 型注入，改打正式 AI 路線的完整防線
// （驗收 normalizeAiBank → 接地 assertAiBankGrounded → 合計＋閘 assertAiBankReconciled）。
//
// ⚠️ 這份量的情境＝**「兩讀都錯成同一份答案」的最壞情境（相關錯誤）**：
//   P2-4 雙讀之後，「一讀錯、另一讀對」的不相關錯誤在**比對欄位**上一律被比對器看到（不一致
//   →仲裁→三讀不同＝擋下）——那條防線的承重在 test/ai-dual-read.test.js，本份不重量。
//   本份回答的是剩下那個問題：**如果兩個模型犯了同一個錯**（或使用者關掉雙讀），三道靜態防線
//   攔得住哪幾型？
// ⚠️ 與 test/ai-gate-interception.test.js 的關係：那份量**閘單獨**的性質（P1b-3 原測、數字與
//   §八「A 類 9/9、B 類 12 型漏接」互扣、刻意凍結）；本份量**全管線**、數字與 §八 的
//   「全管線重測」小節互扣。兩份的型號一一對應（A1–A9、D1、B1–B12、C0），勿合併——合併會把
//   「閘的承諾」與「管線的現況」攪在一起（閘的數字是對使用者的承諾、不可漂）。
// ⚠️ 條件攔截率＝「如果犯了 X 型錯會不會被擋」，不是「AI 多常犯錯」（後者要真 AI＋語料，未做）。
//
// 假資料鐵則（收支契約）：帳號一律明顯假值（900100/900200 前綴系），絕不複製真帳單遮罩末碼。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { normalizeAiBank, assertAiBankGrounded, linesToText } = await import('../lib/ai-parse.js');
const { assertAiBankReconciled } = await import('../lib/services/bank-import.js');

// ---- 合成帳單（版面原文＝接地檢查的對照物；**有印合計列**＝合計交叉驗證上膛）----
const L = (/** @type {number} */ y, /** @type {any[]} */ pairs) => ({ y, cells: pairs.map((p) => ({ x: p[0], s: p[1] })) });
/** 單帳戶台幣版面（v2＝三筆，A4「漏中間一筆」才有鏈斷可看）：期初 5,000 → 出 200 → 出 100 → 入 800
 *  → 期末 5,500；印合計（3 筆／出 300／入 800）。 */
const linesFull = () => [
  L(10, [[40, '合成第一銀行 存款對帳單']]),
  L(30, [[40, '900100****3301'], [200, 'TWD'], [320, '5,500']]),
  L(50, [[40, '2026/07/03'], [140, '超商繳費'], [240, '200'], [320, '4,800']]),
  L(55, [[40, '2026/07/04'], [140, '咖啡'], [240, '100'], [320, '4,700']]),
  L(60, [[40, '2026/07/05'], [140, '薪資入帳'], [280, '800'], [320, '5,500']]),
  L(80, [[40, '合計'], [140, '3 筆'], [240, '300'], [280, '800']]),
];
/** 同版面**不印合計**（負例用：合計類防線繳械）。 */
const linesFullNoTotals = () => linesFull().filter((l) => l.y !== 80);
/** 同版面不印合計＋一行雜數字（負例用：接地防線被「帳單他處印過的數字」繳械——利率/廣告數字是真實形）。 */
const linesStray = () => [...linesFullNoTotals(), L(90, [[40, '本期利率參考'], [140, '250'], [200, '4,750'], [240, '4,650'], [280, '850'], [320, '700']])];
/** 雙帳戶版面（B6/B7/A7 用）：3301 同上；3302 一筆支出 300、期末 1,200；合計 3 筆／出 500／入 700。 */
const linesTwo = () => [
  L(10, [[40, '合成第一銀行 存款對帳單']]),
  L(30, [[40, '900100****3301'], [200, 'TWD'], [320, '5,500']]),
  L(35, [[40, '900100****3302'], [200, 'TWD'], [320, '1,200']]),
  L(50, [[40, '2026/07/03'], [60, '3301'], [140, '超商繳費'], [240, '200'], [320, '4,800']]),
  L(60, [[40, '2026/07/05'], [60, '3301'], [140, '薪資入帳'], [280, '700'], [320, '5,500']]),
  L(70, [[40, '2026/07/06'], [60, '3302'], [140, '轉帳支出'], [240, '300'], [320, '1,200']]),
  L(80, [[40, '合計'], [140, '3 筆'], [240, '500'], [280, '700']]),
];
/** 雙帳戶版面不印合計（N6 用）。 */
const linesTwoNoTotals = () => linesTwo().filter((l) => l.y !== 80);
/** 含無往來帳戶（B3 用）：3301 三筆同 v2；3309 只在概要（餘額 8,000、零明細）。 */
const linesIdle = () => [
  ...linesFull().slice(0, 2),
  L(35, [[40, '900100****3309'], [200, 'TWD'], [320, '8,000']]),
  ...linesFull().slice(2),
];
/** 含外幣帳戶（B9/C0 用）：3301 台幣同上；3305 USD 一筆存入 50、期末 150。⚠️ 混幣＝合計整道跳過（契約） */
const linesForeign = () => [
  L(10, [[40, '合成第一銀行 存款對帳單']]),
  L(30, [[40, '900100****3301'], [200, 'TWD'], [320, '5,500']]),
  L(35, [[40, '900100****3305'], [200, 'USD'], [320, '150']]),
  L(50, [[40, '2026/07/03'], [60, '3301'], [140, '超商繳費'], [240, '200'], [320, '4,800']]),
  L(60, [[40, '2026/07/05'], [60, '3301'], [140, '薪資入帳'], [280, '700'], [320, '5,500']]),
  L(70, [[40, '2026/07/07'], [60, '3305'], [140, '海外匯入'], [280, '50'], [320, '150']]),
];

// ---- 每個版面的黃金答案（AI 答案卷原始形；normalize 會驗收它）----
const M1 = '900100****3301', M2 = '900100****3302', M5 = '900100****3305', M9 = '900100****3309';
const tx = (/** @type {any} */ o) => ({ acctMasked: M1, date: '2026-07-03', direction: 'out', amount: 200, balance: 4800, summary: '超商繳費', note: '', ...o });
const answerFull = () => ({
  bank: '合成第一銀行', referenceDate: '2026-07-31',
  accountCurrencies: [{ masked: M1, currency: 'TWD' }],
  totals: { txCount: 3, totalOut: 300, totalIn: 800 },
  accounts: [{ masked: M1, balance: 5500, currency: 'TWD', label: '活存', note: '' }],
  transactions: [
    tx({}),
    tx({ date: '2026-07-04', amount: 100, balance: 4700, summary: '咖啡' }),
    tx({ date: '2026-07-05', direction: 'in', amount: 800, balance: 5500, summary: '薪資入帳' }),
  ],
});
const answerTwo = () => ({
  bank: '合成第一銀行', referenceDate: '2026-07-31',
  accountCurrencies: [{ masked: M1, currency: 'TWD' }, { masked: M2, currency: 'TWD' }],
  totals: { txCount: 3, totalOut: 500, totalIn: 700 },
  accounts: [
    { masked: M1, balance: 5500, currency: 'TWD', label: '活存', note: '' },
    { masked: M2, balance: 1200, currency: 'TWD', label: '活存', note: '' },
  ],
  transactions: [
    tx({}), tx({ date: '2026-07-05', direction: 'in', amount: 700, balance: 5500, summary: '薪資入帳' }),
    tx({ acctMasked: M2, date: '2026-07-06', amount: 300, balance: 1200, summary: '轉帳支出' }),
  ],
});
const answerIdle = () => ({
  ...answerFull(),
  accountCurrencies: [{ masked: M1, currency: 'TWD' }, { masked: M9, currency: 'TWD' }],
  accounts: [
    { masked: M1, balance: 5500, currency: 'TWD', label: '活存', note: '' },
    { masked: M9, balance: 8000, currency: 'TWD', label: '活存', note: '' },
  ],
});
const answerForeign = () => ({
  bank: '合成第一銀行', referenceDate: '2026-07-31',
  accountCurrencies: [{ masked: M1, currency: 'TWD' }, { masked: M5, currency: 'USD' }],
  totals: { txCount: null, totalOut: null, totalIn: null },   // 混幣＝AI 照提示詞填 null（誠實缺席）
  accounts: [
    { masked: M1, balance: 5500, currency: 'TWD', label: '活存', note: '' },
    { masked: M5, balance: 150, currency: 'USD', label: '外幣', note: '' },
  ],
  transactions: [
    tx({}), tx({ date: '2026-07-05', direction: 'in', amount: 700, balance: 5500, summary: '薪資入帳' }),
    tx({ acctMasked: M5, date: '2026-07-07', direction: 'in', amount: 50, balance: 150, summary: '海外匯入' }),
  ],
});

// ---- 全管線 harness：驗收→接地→（合計＋閘）；回「哪一道擋下」或 'missed' ----
const DB = () => ({ accounts: [], transactions: [], settings: {} });
/** @returns {'normalize'|'grounded'|'reconcile'|'missed'} */
function pipeline(/** @type {any} */ answer, /** @type {any[]} */ lines) {
  /** @type {any} */ let parsed;
  try { parsed = normalizeAiBank(answer); } catch { return 'normalize'; }
  try { assertAiBankGrounded(parsed, linesToText(lines)); } catch { return 'grounded'; }
  try { assertAiBankReconciled(parsed, DB()); } catch { return 'reconcile'; }
  return 'missed';
}

/** 23 型（型號與 test/ai-gate-interception.test.js 一一對應）。expect＝全管線判定；
 *  defense＝預期由哪一道擋（'missed' 型免填）；why＝為什麼（含殘洞誠實句）。 */
const CASES = [
  // ---- A 類（閘本來就擋；全管線照樣擋——列出以示「加防線沒有弄丟舊保護」。A 類不鎖 defense：
  //      這裡的宣稱是「有人擋」，「閘自己擋」的承諾在凍結的原卷）----
  { id: 'A1', name: '單筆金額抄錯（100 讀成 900；非首筆——首筆是 B2 的刀，r1#1）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions[1].amount = 900; return a; },
    proves: (/** @type {any} */ a) => a.transactions[1].amount === 900 && a.transactions[1].balance === 4700,
    why: '900 不在版面（遮罩帳號 900100 是另一個 token、數值不相等）＝接地擋；就算在，鏈（4800−900≠4700）也斷＝閘的老本行。' },
  { id: 'A2', name: '金額差一個數量級（800 讀成 8000）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions[2].amount = 8000; return a; },
    proves: (/** @type {any} */ a) => a.transactions[2].amount === 8000,
    why: '同 A1。' },
  { id: 'A3', name: '方向看反（存入讀成支出）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions[2].direction = 'out'; return a; },
    proves: (/** @type {any} */ a) => a.transactions[2].direction === 'out',
    why: '餘額鏈斷（4700−800≠5500）＋合計出入互換＝reconcile 擋。' },
  { id: 'A4', name: '漏讀中間一整筆（跳過一行）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions = [a.transactions[0], a.transactions[2]]; return a; },
    proves: (/** @type {any} */ a) => a.transactions.length === 2 && a.transactions[1].summary === '薪資入帳' && a.transactions[0].balance === 4800,
    why: '鏈斷（4800＋800≠5500）＝閘的老本行（Grok H2：漏**首筆**是 B8 的刀、漏**中間**才是 A4——兩刀不同、判定不同）。' },
  { id: 'A5', name: '同一筆讀成兩筆（重複一行）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions = [a.transactions[0], a.transactions[0], a.transactions[1], a.transactions[2]]; return a; },
    proves: (/** @type {any} */ a) => a.transactions.length === 4 && a.transactions[1].balance === a.transactions[0].balance,
    why: '鏈斷（4800−200≠4800）＋合計筆數＝reconcile 擋。' },
  { id: 'A6', name: '餘額欄抄錯（金額對、餘額錯）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions[0].balance = 4650; return a; },
    proves: (/** @type {any} */ a) => a.transactions[0].balance === 4650,
    why: '4,650 不在版面＝接地擋；在也會鏈斷。' },
  { id: 'A7', name: '把 A 帳戶的一列掛到 B 帳戶（末碼讀錯）', lines: linesTwo, expect: 'caught',
    make: () => { const a = answerTwo(); a.transactions[2].acctMasked = M1; return a; },
    proves: (/** @type {any} */ a) => a.transactions[2].acctMasked === M1 && a.accounts.length === 2,
    why: '兩個帳戶的餘額鏈都斷＝reconcile 擋。' },
  { id: 'A8', name: '期末與概要對不上（漏讀期末幾筆）', lines: linesFull, expect: 'caught', defense: 'reconcile',
    make: () => { const a = answerFull(); a.transactions = a.transactions.slice(0, 2); a.totals = { txCount: null, totalOut: null, totalIn: null }; return a; },
    proves: (/** @type {any} */ a) => a.transactions.length === 2 && a.totals.txCount === null && a.transactions[1].balance === 4700,
    why: '末筆 4,700 對不上概要 5,500＝reconcile 擋。合計全 null（誠實缺席＝合計不上膛；r2#1：原版填 2、但 2 不在版面＝接地先開火＝孤立失敗）——這格鎖 reconcile 證明概要閘仍承重。' },
  { id: 'A9', name: '整份只讀出一筆（其餘全漏）', lines: linesTwo, expect: 'caught',
    make: () => { const a = answerTwo(); a.transactions = [a.transactions[0]]; return a; },
    proves: (/** @type {any} */ a) => a.transactions.length === 1 && a.accounts.length === 2,
    why: '合計筆數＋鏈＋概要＝reconcile 擋。' },
  { id: 'D1', name: '某台幣帳戶餘額欄全空（零驗證）', lines: linesTwo, expect: 'caught',
    make: () => { const a = answerTwo(); a.transactions[2].balance = null; return a; },
    proves: (/** @type {any} */ a) => a.transactions[2].balance === null && a.accounts[1].currency === 'TWD',
    why: 'twdAccountsUnverified＞0＝★6 逐帳戶覆蓋保守拒收（與閘版同判定）。' },
  // ---- B 類（閘單獨看不到的 12 型——全管線重測＝本份的存在理由）----
  { id: 'B1', name: '金額與餘額一起改成自洽的另一組數字（合計也一起自洽）', lines: linesFull, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerFull(); Object.assign(a.transactions[0], { amount: 250, balance: 4750 }); Object.assign(a.transactions[1], { balance: 4650 }); Object.assign(a.transactions[2], { amount: 850 }); a.totals = { txCount: 3, totalOut: 350, totalIn: 850 }; return a; },
    proves: (/** @type {any} */ a) => a.transactions[0].amount === 250 && a.transactions[0].balance === 4750 && a.transactions[1].balance === 4650 && a.transactions[2].amount === 850 && a.totals.totalOut === 350,
    why: '鏈（250→4750→4650→＋850＝5500）與合計全自洽＝閘與合計都看不到（Grok H1 後的真自洽版）；唯一的破綻＝250/4,750/4,650/850 不在版面＝接地擋。殘洞負例見 N3。' },
  { id: 'B2', name: '每個帳戶的第一筆金額讀錯（只改金額、鏈不動）', lines: linesFull, expect: 'caught', defense: 'reconcile',
    make: () => { const a = answerFull(); a.transactions[0].amount = 300; return a; },
    proves: (/** @type {any} */ a) => a.transactions[0].amount === 300 && a.transactions[0].balance === 4800 && a.totals.totalOut === 300,
    why: '首筆金額不進鏈（沒有上一筆可比）＝閘看不到；錯值刻意用**帳單他處印過的 300**（合計列）＝接地也看不到——孤立出「合計兼補首筆」那道：照抄的出合計 300 對不上逐筆 400＝合計擋（裁示⑧b）。錯值不在版面的情境改由接地擋（B1/B4 已證）；兩道都失效的組合見 N3。' },
  { id: 'B3', name: '本期無往來帳戶的概要餘額讀錯', lines: linesIdle, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerIdle(); a.accounts[1].balance = 8800; return a; },
    proves: (/** @type {any} */ a) => a.accounts[1].balance === 8800 && a.transactions.length === 3,
    why: '零明細＝閘無從驗；但 8,800 不在版面＝接地擋（P2-2a 的主要收獲之一）。' },
  { id: 'B4', name: '某筆金額讀錯、同筆餘額讀成空白（非首筆——空白才是閘盲掉的原因，r1#1）', lines: linesFull, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerFull(); a.transactions[1].amount = 210; a.transactions[1].balance = null; return a; },
    proves: (/** @type {any} */ a) => a.transactions[1].amount === 210 && a.transactions[1].balance === null,
    why: '餘額空白＝相鄰兩對驗算都被跳過＝閘看不到（餘額在＝4800−210≠4700 閘就抓得到——空白是真正的盲因）；但 210 不在版面＝接地擋。負例 N5＝錯值 250 撞雜訊列＋無合計＝仍看不到。' },
  { id: 'B5', name: '一筆支出與一筆收入併成一筆淨額', lines: linesFull, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerFull(); a.transactions = [a.transactions[0], tx({ date: '2026-07-05', direction: 'in', amount: 700, balance: 5500, summary: '淨額' })]; return a; },
    proves: (/** @type {any} */ a) => a.transactions.length === 2 && a.transactions[1].amount === 700 && a.transactions[1].direction === 'in',
    why: '咖啡 100 出＋薪資 800 入被併成淨入 700（4800＋700＝5500 鏈自洽）＝閘看不到；但 700 不在 v2 版面＝接地擋；照抄的合計（3 筆/出 300）也對不上。兩道都失效的負例＝N4。' },
  { id: 'B6', name: '整個帳戶被漏讀（概要與明細都沒讀到）', lines: linesTwo, expect: 'caught', defense: 'reconcile',
    make: () => { const a = answerTwo(); a.accountCurrencies = [{ masked: M1, currency: 'TWD' }]; a.accounts = [a.accounts[0]]; a.transactions = a.transactions.slice(0, 2); return a; },
    proves: (/** @type {any} */ a) => a.accounts.length === 1 && a.accountCurrencies.length === 1 && a.transactions.length === 2,
    why: '漏掉的帳戶沒有數字可驗＝閘看不到；但帳單印的合計（3 筆/出 500）涵蓋整份＝合計擋。⚠️ 沒印合計＝仍看不到（專屬負例 N6）。' },
  { id: 'B7', name: '台幣帳戶被誤判成外幣', lines: linesTwo, expect: 'missed',
    make: () => { const a = answerTwo(); a.accountCurrencies[1].currency = 'USD'; a.accounts[1].currency = 'USD'; a.totals = { txCount: null, totalOut: null, totalIn: null }; return a; },
    proves: (/** @type {any} */ a) => a.accounts[1].currency === 'USD' && a.accountCurrencies[1].currency === 'USD' && a.totals.txCount === null,
    why: '誤判成外幣⇒該帳戶被排除在台幣驗算外、混幣又讓合計整道跳過（契約的刻意取捨）＝三道都看不到。仍寫在預覽窗盲點清單。' },
  { id: 'B8', name: '整筆漏掉每個帳戶的第一筆', lines: linesFull, expect: 'caught', defense: 'reconcile',
    make: () => { const a = answerFull(); a.transactions = a.transactions.slice(1); return a; },
    proves: (/** @type {any} */ a) => a.transactions.length === 2 && a.transactions[0].summary === '咖啡' && a.totals.txCount === 3,
    why: '首筆整筆消失＝剩下的鏈（4700＋800＝5500）與期末全自洽＝閘看不到（與 A4 漏**中間**刻意分刀）；但照抄的合計（3 筆/出 300）對不上（2 筆/出 100）＝合計擋。沒印合計＝仍看不到（負例 N1）。' },
  { id: 'B9', name: '外幣帳戶被誤判成台幣', lines: linesForeign, expect: 'missed',
    make: () => { const a = answerForeign(); a.accountCurrencies[1].currency = 'TWD'; a.accounts[1].currency = 'TWD'; return a; },
    proves: (/** @type {any} */ a) => a.accounts[1].currency === 'TWD' && a.accountCurrencies[1].currency === 'TWD',
    why: '外幣列的數字都真的印在版面上（接地過）、自己的鏈也自洽、混幣讓合計跳過＝三道都看不到⇒外幣數字被當台幣入帳。仍是最重的已知盲點之一。' },
  { id: 'B10', name: '首筆的方向讀反（支出讀成存入）', lines: linesFull, expect: 'caught', defense: 'reconcile',
    make: () => { const a = answerFull(); a.transactions[0].direction = 'in'; return a; },
    proves: (/** @type {any} */ a) => a.transactions[0].direction === 'in' && a.transactions[0].balance === 4800,
    why: '首筆方向不進鏈＝閘的既有盲點；但照抄的出/入合計立刻對不上（出 300→100、入 800→1000）＝合計擋。沒印合計＝仍看不到（負例 N2）。' },
  { id: 'B11', name: '摘要抄錯字（金額全對）', lines: linesFull, expect: 'missed',
    make: () => { const a = answerFull(); a.transactions[0].summary = '超商激費'; return a; },
    proves: (/** @type {any} */ a) => a.transactions[0].summary === '超商激費' && a.transactions[0].amount === 200,
    why: '三道防線都只看數字＝看不到。雙讀開著時摘要在比對欄位清單內（test/ai-dual-read.test.js 的逐欄承重題）——兩讀不同＝比對器擋；兩讀錯得一模一樣（＝本份量的情境）＝仍看不到。' },
  { id: 'B12', name: '日期讀錯（金額與餘額全對）', lines: linesFull, expect: 'missed',
    make: () => { const a = answerFull(); a.transactions[0].date = '2026-07-04'; return a; },
    proves: (/** @type {any} */ a) => a.transactions[0].date === '2026-07-04' && a.transactions[0].amount === 200,
    why: '同 B11（日期也在比對欄位清單）。去重鍵含日期⇒重匯時會被當新的一筆＝仍是預覽窗要警告的重點。' },
  { id: 'C0', name: '外幣明細的金額讀錯', lines: linesForeign, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerForeign(); a.transactions[2].amount = 60; a.transactions[2].balance = 160; return a; },
    proves: (/** @type {any} */ a) => a.transactions[2].amount === 60 && a.transactions[2].balance === 160,
    why: 'P1b-3 時代「閘本來就不管外幣」＝漏；接地檢查不分幣別、60/160 不在版面＝擋（畫面數字錯也擋得到了）。' },
];

// ---- 逐型跑（互扣鐵則同 P1b-3：改壞防線＝caught 變 missed 紅；改好防線＝missed 變 caught 也紅）----
for (const c of CASES) {
  test(`全管線攔截｜${c.id}：${c.name}＝${c.expect === 'caught' ? '擋下' : '漏接（誠實）'}`, () => {
    const injected = c.make();
    assert.ok(c.proves, `★${c.id} 缺 proves＝無法證明注入真的執行（AGENTS 鐵則 9、r1#2：missed 型退化成 no-op 仍會替漏接名單計數）`);
    assert.ok(c.proves(injected), `★${c.id} 的注入沒有生效（make 改壞或被 no-op 化）——先證明受測操作確實執行`);
    const got = pipeline(injected, c.lines());
    if (c.expect === 'caught') {
      assert.notEqual(got, 'missed', `★${c.id} 應被擋下（${c.why}）`);
      if (c.defense) assert.equal(got, c.defense, `★${c.id} 預期由「${c.defense}」擋——換一道擋＝行為變了、§八的歸因要跟著改`);
    } else {
      assert.equal(got, 'missed', `★${c.id} 目前三道都看不到（誠實漏接）——若有防線接住了＝好消息，但 §八 與預覽窗清單要一起更新（互扣鐵則）`);
    }
  });
}

// ---- 基準自證：四個黃金答案本身全管線綠（注入前的版面與答案是健康的——否則上面全是假紅）----
test('全管線攔截｜基準：四個版面的黃金答案全部通過三道（夾具健康自證）', () => {
  assert.equal(pipeline(answerFull(), linesFull()), 'missed');
  assert.equal(pipeline(answerTwo(), linesTwo()), 'missed');
  assert.equal(pipeline(answerIdle(), linesIdle()), 'missed');
  assert.equal(pipeline(answerForeign(), linesForeign()), 'missed');
});

// ---- N 系條件負例（Grok r0＋Codex r1#3：「仍看不到」的每一句但書都要有題撐著——N 系就是那些「仍」）----
// ⚠️ 不入 23 型計數：它們量的是**條件**（合計缺席／數字撞版面），不是新的錯誤型。
test('N1｜B8 同刀但帳單沒印合計＝仍看不到（①「沒印合計」但書的負例）', () => {
  const a = answerFull(); a.transactions = a.transactions.slice(1); a.totals = { txCount: null, totalOut: null, totalIn: null };
  assert.equal(pipeline(a, linesFullNoTotals()), 'missed', '★合計是唯一看得到首筆整漏的防線——拿掉合計列＝誠實漏接');
});

test('N2｜B10 同刀但帳單沒印合計＝仍看不到（①方向子況的負例）', () => {
  const a = answerFull(); a.transactions[0].direction = 'in'; a.totals = { txCount: null, totalOut: null, totalIn: null };
  assert.equal(pipeline(a, linesFullNoTotals()), 'missed');
});

test('N3｜B1 同刀但湊的數字全是帳單他處印過的、又沒印合計＝仍看不到（④殘洞句的負例）', () => {
  const a = answerFull();
  Object.assign(a.transactions[0], { amount: 250, balance: 4750 });
  Object.assign(a.transactions[1], { balance: 4650 });
  Object.assign(a.transactions[2], { amount: 850 });
  a.totals = { txCount: null, totalOut: null, totalIn: null };
  assert.equal(pipeline(a, linesStray()), 'missed', '★250/4,750/4,650/850 全印在雜訊列（利率/廣告數字是真實形）＝接地過、鏈自洽、無合計可比＝三道全盲——④殘洞句就是在講這個');
});

test('N4｜B5 同刀但淨額印在帳單他處、又沒印合計＝仍看不到（⑥「兩條件都不成立」的負例）', () => {
  const a = answerFull();
  a.transactions = [a.transactions[0], tx({ date: '2026-07-05', direction: 'in', amount: 700, balance: 5500, summary: '淨額' })];
  a.totals = { txCount: null, totalOut: null, totalIn: null };
  assert.equal(pipeline(a, linesStray()), 'missed', '★淨額 700 剛好印在雜訊列＋沒印合計＝⑥的兩個擋下條件都不成立');
});

test('N5｜B4 同刀但錯值印在帳單他處＋沒印合計＝仍看不到（⑤「同④」但書的負例）', () => {
  const a = answerFull();
  a.transactions[1].amount = 250; a.transactions[1].balance = null;   // 錯值 250 印在雜訊列（r2#3：舊註解誤寫 210）
  a.totals = { txCount: null, totalOut: null, totalIn: null };
  assert.equal(pipeline(a, linesStray()), 'missed', '★餘額空白讓閘盲、250 撞雜訊列讓接地盲、無合計讓合計盲＝三道全失效');
});

test('N6｜B6 同刀但帳單沒印合計＝仍看不到（⑦「沒印＝仍看不到」但書的負例）', () => {
  const a = answerTwo();
  a.accountCurrencies = [{ masked: M1, currency: 'TWD' }]; a.accounts = [a.accounts[0]]; a.transactions = a.transactions.slice(0, 2);
  a.totals = { txCount: null, totalOut: null, totalIn: null };
  assert.equal(pipeline(a, linesTwoNoTotals()), 'missed', '★整戶漏讀在沒印合計的帳單上＝沒有任何數字可對＝誠實漏接');
});

// ---- 與 §八 的互扣數字（改一邊另一邊就紅）----
test('全管線攔截｜§八互扣＝機械釘（Grok r0 低：原版只鎖考卷自身＝改文件不改考卷不會紅）', async () => {
  const caught = CASES.filter((c) => c.expect === 'caught').map((c) => c.id);
  const missed = CASES.filter((c) => c.expect === 'missed').map((c) => c.id);
  assert.equal(CASES.length, 23, '型數與 P1b-3 原測一一對應');
  assert.equal(caught.length, 19);
  assert.deepEqual(missed, ['B7', 'B9', 'B11', 'B12']);
  const { readFileSync } = await import('node:fs');
  const { join: j } = await import('node:path');
  const raw = readFileSync(j(process.cwd(), 'docs/parser-generalization-plan.md'), 'utf8');
  // r1#4：剝 HTML 註解＋鎖 §八 目標段（同凍結舊卷的邊界）——否則核准字串搬進註解或別段仍 includes=true
  const KEY = '19 型擋下、4 型漏接（B7 台幣認成外幣／B9 外幣認成台幣／B11 摘要錯／B12 日期錯）';
  const sectionEight = (/** @type {string} */ doc) => doc.split('## 八、誠實劃界')[1]?.split(/\n## /)[0]?.replace(/<!--[\s\S]*?-->/g, '') || '';
  // 抽取器自證（讓剝註解與鎖段真的承重——改成讀整檔＝這兩條先紅）：
  assert.ok(!sectionEight(`## 八、誠實劃界\n<!-- ${KEY} -->\n## 九`).includes(KEY), '★字串只在 HTML 註解＝不算數');
  assert.ok(!sectionEight(`## 七、別段\n${KEY}\n## 八、誠實劃界\n沒有\n## 九`).includes(KEY), '★字串只在別段＝不算數');
  assert.ok(sectionEight(raw).includes(KEY),
    '★§八**本段正文**要跟考卷一字不差——搬進註解/別段/改數字都紅（真互扣）');
});
