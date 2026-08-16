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
/** 單帳戶台幣版面：期初 5,000 → 支出 200 → 存入 700 → 期末 5,500；印合計（2 筆／出 200／入 700）。 */
const linesFull = () => [
  L(10, [[40, '合成第一銀行 存款對帳單']]),
  L(30, [[40, '900100****3301'], [200, 'TWD'], [320, '5,500']]),
  L(50, [[40, '2026/07/03'], [140, '超商繳費'], [240, '200'], [320, '4,800']]),
  L(60, [[40, '2026/07/05'], [140, '薪資入帳'], [280, '700'], [320, '5,500']]),
  L(80, [[40, '合計'], [140, '2 筆'], [240, '200'], [280, '700']]),
];
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
/** 含無往來帳戶（B3 用）：3301 有明細；3309 只在概要（餘額 8,000、零明細）。 */
const linesIdle = () => [
  L(10, [[40, '合成第一銀行 存款對帳單']]),
  L(30, [[40, '900100****3301'], [200, 'TWD'], [320, '5,500']]),
  L(35, [[40, '900100****3309'], [200, 'TWD'], [320, '8,000']]),
  L(50, [[40, '2026/07/03'], [140, '超商繳費'], [240, '200'], [320, '4,800']]),
  L(60, [[40, '2026/07/05'], [140, '薪資入帳'], [280, '700'], [320, '5,500']]),
  L(80, [[40, '合計'], [140, '2 筆'], [240, '200'], [280, '700']]),
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
  totals: { txCount: 2, totalOut: 200, totalIn: 700 },
  accounts: [{ masked: M1, balance: 5500, currency: 'TWD', label: '活存', note: '' }],
  transactions: [tx({}), tx({ date: '2026-07-05', direction: 'in', amount: 700, balance: 5500, summary: '薪資入帳' })],
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
  // ---- A 類（閘本來就擋；全管線照樣擋——列出以示「加防線沒有弄丟舊保護」）----
  { id: 'A1', name: '單筆金額抄錯（200 讀成 900）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions[0].amount = 900; return a; },
    why: '900 不在版面上＝接地先擋；就算在，餘額鏈也斷＝閘擋。' },
  { id: 'A2', name: '金額差一個數量級（700 讀成 7000）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions[1].amount = 7000; return a; },
    why: '同 A1。' },
  { id: 'A3', name: '方向看反（存入讀成支出）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions[1].direction = 'out'; return a; },
    why: '餘額鏈斷＋合計出入互換＝reconcile 擋。' },
  { id: 'A4', name: '漏讀一整筆', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions = [a.transactions[1]]; return a; },
    why: '合計筆數 2≠1＋期初接不上＝reconcile 擋。' },
  { id: 'A5', name: '同一筆讀成兩筆', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions = [a.transactions[0], a.transactions[0], a.transactions[1]]; return a; },
    why: '合計筆數＋餘額鏈＝reconcile 擋。' },
  { id: 'A6', name: '餘額欄抄錯（金額對、餘額錯）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions[0].balance = 4700; return a; },
    why: '4700 不在版面＝接地擋；在也會餘額鏈斷。' },
  { id: 'A7', name: '把 A 帳戶的一列掛到 B 帳戶（末碼讀錯）', lines: linesTwo, expect: 'caught',
    make: () => { const a = answerTwo(); a.transactions[2].acctMasked = M1; return a; },
    why: '兩個帳戶的餘額鏈都斷＝reconcile 擋。' },
  { id: 'A8', name: '期末與概要對不上（漏讀期末幾筆）', lines: linesFull, expect: 'caught',
    make: () => { const a = answerFull(); a.transactions = [a.transactions[0]]; a.totals = { txCount: 1, totalOut: 200, totalIn: null }; return a; },
    why: '末筆 4,800 對不上概要 5,500＝reconcile 擋（注入連合計一起改＝模擬 AI 自洽地漏讀）。' },
  { id: 'A9', name: '整份只讀出一筆（其餘全漏）', lines: linesTwo, expect: 'caught',
    make: () => { const a = answerTwo(); a.transactions = [a.transactions[0]]; return a; },
    why: '合計筆數＋鏈＋概要＝reconcile 擋。' },
  { id: 'D1', name: '某台幣帳戶餘額欄全空（零驗證）', lines: linesTwo, expect: 'caught',
    make: () => { const a = answerTwo(); a.transactions[2].balance = null; return a; },
    why: 'twdAccountsUnverified＞0＝★6 逐帳戶覆蓋保守拒收（與閘版同判定）。' },
  // ---- B 類（閘單獨看不到的 12 型——全管線重測＝本份的存在理由）----
  { id: 'B1', name: '金額與餘額一起改成自洽的另一組數字', lines: linesFull, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerFull(); a.transactions[0].amount = 250; a.transactions[0].balance = 4750; a.totals = { txCount: 2, totalOut: 250, totalIn: 700 }; return a; },
    why: '250/4,750 不在版面上＝接地擋。⚠️ 殘洞（誠實）：若湊出來的數字恰好都在帳單他處印過＝接地看不到（grounded docstring 記載的已知殘洞）。' },
  { id: 'B2', name: '每個帳戶的第一筆金額讀錯（含餘額配合改）', lines: linesFull, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerFull(); a.transactions[0].amount = 260; a.transactions[0].balance = 4740; return a; },
    why: '首筆的餘額沒有上一筆可比＝閘看不到；但 260/4,740 不在版面＝接地擋；帳單有印合計時合計也擋。' },
  { id: 'B3', name: '本期無往來帳戶的概要餘額讀錯', lines: linesIdle, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerIdle(); a.accounts[1].balance = 8800; return a; },
    why: '零明細＝閘無從驗；但 8,800 不在版面＝接地擋（P2-2a 的主要收獲之一）。' },
  { id: 'B4', name: '某筆金額讀錯、同筆餘額讀成空白', lines: linesFull, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerFull(); a.transactions[0].amount = 210; a.transactions[0].balance = null; return a; },
    why: '該對驗算被跳過＝閘看不到；但 210 不在版面＝接地擋。' },
  { id: 'B5', name: '一筆支出與一筆收入併成一筆淨額', lines: linesFull, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerFull(); a.transactions = [tx({ direction: 'in', amount: 500, balance: 5500, summary: '淨額' })]; a.totals = { txCount: 1, totalOut: null, totalIn: 500 }; return a; },
    why: '餘額鏈自洽＝閘看不到；但淨額 500 不在版面＝接地擋；就算在，帳單印的合計筆數/出入也對不上。' },
  { id: 'B6', name: '整個帳戶被漏讀（概要與明細都沒讀到）', lines: linesTwo, expect: 'caught', defense: 'reconcile',
    make: () => { const a = answerTwo(); a.accountCurrencies = [{ masked: M1, currency: 'TWD' }]; a.accounts = [a.accounts[0]]; a.transactions = a.transactions.slice(0, 2); return a; },
    why: '漏掉的帳戶沒有數字可驗＝閘看不到；但帳單印的合計（3 筆/出 500）涵蓋整份＝合計交叉驗證擋。⚠️ 帳單沒印合計時＝仍看不到（誠實條件）。' },
  { id: 'B7', name: '台幣帳戶被誤判成外幣', lines: linesTwo, expect: 'missed',
    make: () => { const a = answerTwo(); a.accountCurrencies[1].currency = 'USD'; a.accounts[1].currency = 'USD'; a.totals = { txCount: null, totalOut: null, totalIn: null }; return a; },
    why: '誤判成外幣⇒該帳戶被排除在台幣驗算外、混幣又讓合計整道跳過（契約的刻意取捨）＝三道都看不到。仍寫在預覽窗盲點清單。' },
  { id: 'B8', name: '整筆漏掉每個帳戶的第一筆', lines: linesFull, expect: 'caught', defense: 'reconcile',
    make: () => { const a = answerFull(); a.transactions = [a.transactions[1]]; return a; },
    why: '首筆整筆消失＝後面的鏈照樣自洽；但帳單印的合計筆數 2≠1、支出合計 200≠0＝合計擋。沒印合計＝仍看不到。' },
  { id: 'B9', name: '外幣帳戶被誤判成台幣', lines: linesForeign, expect: 'missed',
    make: () => { const a = answerForeign(); a.accountCurrencies[1].currency = 'TWD'; a.accounts[1].currency = 'TWD'; return a; },
    why: '外幣列的數字都真的印在版面上（接地過）、自己的鏈也自洽、混幣讓合計跳過＝三道都看不到⇒外幣數字被當台幣入帳。仍是最重的已知盲點之一。' },
  { id: 'B10', name: '首筆的方向讀反（收入讀成支出）', lines: linesFull, expect: 'caught', defense: 'reconcile',
    make: () => { const a = answerFull(); a.transactions[0].direction = 'in'; return a; },
    why: '首筆方向＝閘的既有盲點；但帳單印的出/入合計立刻對不上＝合計擋（裁示⑧b 兼補的正是這格）。沒印合計＝仍看不到。' },
  { id: 'B11', name: '摘要抄錯字（金額全對）', lines: linesFull, expect: 'missed',
    make: () => { const a = answerFull(); a.transactions[0].summary = '超商激費'; return a; },
    why: '三道防線都只看數字＝看不到。⚠️ 雙讀開著時：摘要是比對欄位——兩讀不同＝比對器擋（不相關錯誤）；兩讀錯得一模一樣＝仍看不到（本份量的正是這個情境）。' },
  { id: 'B12', name: '日期讀錯（金額與餘額全對）', lines: linesFull, expect: 'missed',
    make: () => { const a = answerFull(); a.transactions[0].date = '2026-07-04'; return a; },
    why: '同 B11（日期也是比對欄位）。去重鍵含日期⇒重匯時會被當新的一筆＝仍是預覽窗要警告的重點。' },
  { id: 'C0', name: '外幣明細的金額讀錯', lines: linesForeign, expect: 'caught', defense: 'grounded',
    make: () => { const a = answerForeign(); a.transactions[2].amount = 60; a.transactions[2].balance = 160; return a; },
    why: 'P1b-3 時代「閘本來就不管外幣」＝漏；接地檢查不分幣別、60/160 不在版面＝擋（畫面數字錯也擋得到了）。' },
];

// ---- 逐型跑（互扣鐵則同 P1b-3：改壞防線＝caught 變 missed 紅；改好防線＝missed 變 caught 也紅）----
for (const c of CASES) {
  test(`全管線攔截｜${c.id}：${c.name}＝${c.expect === 'caught' ? '擋下' : '漏接（誠實）'}`, () => {
    const got = pipeline(c.make(), c.lines());
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

// ---- 與 §八 的互扣數字（改一邊另一邊就紅）----
test('全管線攔截｜§八互扣數字：23 型中 19 擋下、4 型漏接（B7/B9/B11/B12；B11/B12 的不相關情境另由雙讀比對器補）', () => {
  const caught = CASES.filter((c) => c.expect === 'caught').map((c) => c.id);
  const missed = CASES.filter((c) => c.expect === 'missed').map((c) => c.id);
  assert.equal(CASES.length, 23, '型數與 P1b-3 原測一一對應');
  assert.equal(caught.length, 19, '§八「全管線重測」小節寫的擋下數');
  assert.deepEqual(missed, ['B7', 'B9', 'B11', 'B12'], '§八寫的殘存盲點清單——多擋一型或漏一型都要回去改文件');
});
