// @ts-check
// 機構名正規化（Stage 4，2026-08-22）。
// 為什麼要有：同一家銀行在內建範本、AI 路線、配方產線上的寫法不一樣（「台新」「台新銀行」
// 「台新國際商業銀行」「Taishin Bank」），而機構名進了去重鍵、帳戶機構戳、定存身分鍵、疑似重複索引。
// 寫法不一致的後果：重匯同一份帳單認不出重複（現金流翻倍）、同一顆帳戶被當成他行而裂戶、
// 台新走 AI 路線時去重鍵走錯格式。這份考題釘：①正規化的規則本身 ②**祖父條款**——存好的鍵
// 一個位元組不改，比對時兩邊都正規化就認得出來 ③不可亂合併（證券≠銀行）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { canonicalBank, sameBank, canonRef, canonCdKey } = await import('../lib/bank-alias.js');
const { previewBankTxForDb, importBankTxToDb, previewBalancesForDb, applyBalancesToDb } = await import('../lib/services/bank-import.js');

// ---------- ① 規則本身 ----------
test('canonicalBank｜剝通用後綴：各種長寫法都壓回同一個短名；短名本身不動', () => {
  for (const w of ['台新', '台新銀行', '台新國際商業銀行', '台新國際商業銀行股份有限公司', '臺新銀行', ' 台新 ']) {
    assert.equal(canonicalBank(w), '台新', w);
  }
  assert.equal(canonicalBank('國泰世華商業銀行'), '國泰世華');
  assert.equal(canonicalBank('合作金庫商業銀行'), '合作金庫');
});

test('canonicalBank｜別名表：英文寫法與暱稱對得回中文短名（比對不分大小寫、空白、點）', () => {
  assert.equal(canonicalBank('Taishin Bank'), '台新');
  assert.equal(canonicalBank('TAISHIN INTERNATIONAL BANK'), '台新');
  assert.equal(canonicalBank('Taishin Commercial Bank'), '台新', '英文通用後綴先剝、再查表');
  assert.equal(canonicalBank('LINE Bank'), 'LINE Bank', '短名本身含 Bank 的，剝完要查表補回');
  assert.equal(canonicalBank('E.SUN Bank'), '玉山');
  assert.equal(canonicalBank('中信'), '中國信託');
  assert.equal(canonicalBank('bank of taiwan'), '台灣銀行');
});

test('★canonicalBank｜不可亂合併：不同實體剝不掉（證券≠銀行）、不認得的名字原樣回、只剩通用詞不回空', () => {
  assert.notEqual(canonicalBank('台新證券'), '台新', '★證券是另一家——剝掉等於把兩家併成一家');
  assert.equal(canonicalBank('HSBC'), 'HSBC', '不認得＝原樣（寧可兩個短名並存，也不猜）');
  assert.equal(canonicalBank('銀行'), '銀行', '只剩通用詞＝回剝之前的形，不回空（空會被當成缺席）');
  assert.equal(canonicalBank(''), '', '空輸入才回空');
  assert.ok(!canonicalBank('台新|x').includes('|'), '分段符一律剝掉（去重鍵用 | 分段，機構段含它就切錯位）');
});

test('sameBank｜兩邊都正規化後相等才同家；空字串與任何名字都不同家（缺席語意由呼叫端決定）', () => {
  assert.equal(sameBank('台新', '台新國際商業銀行'), true);
  assert.equal(sameBank('Taishin Bank', '臺新銀行'), true);
  assert.equal(sameBank('台新', '台新證券'), false);
  assert.equal(sameBank('台新', '國泰世華'), false);
  assert.equal(sameBank('', ''), false);
  assert.equal(sameBank('', '台新'), false);
});

test('canonRef｜去重鍵比對形：機構段壓成短名，台新改寫成 `bank|` 祖父格式；舊格式與不認得的形狀原樣', () => {
  assert.equal(canonRef('bank2|台新國際商業銀行|900100****8791|2026-06-10|in|100||摘要|備註'),
    'bank|900100****8791|2026-06-10|in|100||摘要|備註', '★台新的長寫法要對回內建範本一直在拼的舊格式');
  assert.equal(canonRef('bank2|玉山商業銀行|800****1|2026-06-10|in|100||a|b'), 'bank2|玉山|800****1|2026-06-10|in|100||a|b');
  assert.equal(canonRef('bank|900100****8791|2026-06-10|in|100||a|b'), 'bank|900100****8791|2026-06-10|in|100||a|b', '舊格式一個位元組不動');
  assert.equal(canonRef('bank2|沒有第二個分段符'), 'bank2|沒有第二個分段符');
  assert.equal(canonRef(''), '');
  // 備註含 `|` 也不可被動到：只改機構段
  assert.equal(canonRef('bank2|玉山銀行|800****1|2026-06-10|in|100||a|b|c'), 'bank2|玉山|800****1|2026-06-10|in|100||a|b|c');
});

test('canonCdKey｜定存身分鍵比對形：只壓第一段', () => {
  assert.equal(canonCdKey('第一銀行|1234|USD||51|#1'), '第一|1234|USD||51|#1');
  assert.equal(canonCdKey('第一|1234|USD||51|#1'), '第一|1234|USD||51|#1');
  assert.equal(canonCdKey('沒有分段符'), '沒有分段符');
});

// ---------- ② 祖父條款：走正式服務層 ----------
const btx = (/** @type {any} */ o) => ({ acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-06-10', summary: '轉帳存入', direction: 'in', amount: 1000, balance: null, note: '', ...o });

test('★去重｜AI 路線抄成「台新國際商業銀行」存下的舊列，與內建範本（台新）重匯同一筆＝明確重複，不可再匯一次', () => {
  // 存好的鍵是 bank2|台新國際商業銀行|…（當年 AI 照抬頭抄的）；一個位元組不改。
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他',
      bankRef: 'bank2|台新國際商業銀行|900100****3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const parsed = { bank: '台新', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  assert.equal(previewBankTxForDb(db, parsed).rows[0].duplicate, true, '★預覽要標明確重複');
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.imported, 0, '★套用一筆都不可再匯（匯了＝現金流翻倍）');
  assert.equal(r.skipped, 1);
  assert.equal(/** @type {any} */ (db.transactions[0]).bankRef, 'bank2|台新國際商業銀行|900100****3301|2026-06-10|in|1000||轉帳存入|', '舊列的鍵原封不動（祖父：不回寫）');
});

test('★去重｜反向：內建範本匯過的台新列，之後 AI 路線抄成「台新銀行」重匯＝同樣認得出重複；而且新列的鍵走 `bank|` 祖父格式', () => {
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他',
      bankRef: 'bank|900100****3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const parsedAi = { bank: '台新銀行', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  assert.equal(importBankTxToDb(db, parsedAi).imported, 0, '★AI 抄成「台新銀行」也要認出是同一筆');
  // 新的一筆（別的日期）存下來的鍵＝bank| 格式，不是 bank2|台新銀行|
  const parsedNew = { ...parsedAi, transactions: [btx({ date: '2026-06-11' })] };
  importBankTxToDb(db, parsedNew);
  assert.equal(/** @type {any} */ (db.transactions.at(-1)).bankRef, 'bank|900100****3301|2026-06-11|in|1000||轉帳存入|',
    '★台新的任何寫法都要拼成內建範本的 `bank|` 格式——否則同一份帳單走兩條路線就對不上');
});

test('★去重｜他行的長短寫法也互認，但不同銀行的同字樣帳號仍分得開', () => {
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他',
      bankRef: 'bank2|玉山商業銀行|900100****3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const same = { bank: '玉山', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  assert.equal(importBankTxToDb(db, same).imported, 0, '玉山＝玉山商業銀行');
  const other = { bank: '國泰世華', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  assert.equal(importBankTxToDb(db, other).imported, 1, '★不同銀行同字樣帳號同日同額＝各自一筆，不可互吃');
});

test('★帳戶｜機構戳是舊寫法「台新銀行」的帳戶，台新帳單要認得出是同一顆（不裂戶）；證券戳仍擋', () => {
  const acct = (/** @type {string} */ bank) => ({ id: 'a', name: '台新活儲', type: 'cash', currency: 'TWD', balance: 100, accountNo: '900100****3301', bank });
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [{ suffix: '3301', masked: '900100****3301', balance: 5000, currency: 'TWD', label: '活儲', note: '', kind: 'demand', period: '' }], accountCurrency: { '900100****3301': 'TWD' }, transactions: [] };
  const okDb = { accounts: [acct('台新銀行')], transactions: [], settings: {} };
  const rows = previewBalancesForDb(okDb, /** @type {any} */ (parsed)).rows;
  assert.equal(rows[0].action, 'update', '★舊戳「台新銀行」＝同一家，要更新這顆、不可 create 第二顆');
  applyBalancesToDb(okDb, /** @type {any} */ (parsed));
  assert.equal(okDb.accounts.length, 1, '★不裂戶');
  assert.equal(okDb.accounts[0].balance, 5000);
  assert.equal(okDb.accounts[0].bank, '台新銀行', '舊戳不回寫（祖父：比對時正規化，資料不動）');
  // 證券戳＝另一家：照舊不配（不可因為都姓台新就蓋餘額）
  const secDb = { accounts: [acct('台新證券')], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(secDb, /** @type {any} */ (parsed)).rows[0].action, 'create', '★台新證券≠台新——不可蓋它的餘額');
});

test('帳戶｜新建帳戶的機構戳＝正規短名（AI 抄的長寫法不會原樣進戳）', () => {
  const parsed = { bank: '台新國際商業銀行', referenceDate: '2026-06-30', accounts: [{ suffix: '3301', masked: '900100****3301', balance: 5000, currency: 'TWD', label: '活儲', note: '', kind: 'demand', period: '' }], accountCurrency: { '900100****3301': 'TWD' }, transactions: [] };
  const db = { accounts: [], transactions: [], settings: {} };
  applyBalancesToDb(db, /** @type {any} */ (parsed));
  assert.equal(db.accounts[0].bank, '台新');
});

test('★定存｜舊戶 cdKey 的機構段是長寫法：新一期用短名算出的鍵仍要配到同一筆（不多建一戶、到期也找得到它）', () => {
  const cd = { suffix: '1234', masked: '900100****1234', balance: 51, currency: 'USD', label: '定存', note: '', kind: 'time', period: '2026-01-01~2026-07-01' };
  const parsed = { bank: '第一', referenceDate: '2026-06-30', accounts: [cd], accountCurrency: { '900100****1234': 'USD' }, transactions: [] };
  const db = { accounts: [
    { id: 'cd1', name: '第一 定存', type: 'cash', currency: 'USD', balance: 51, accountNo: '900100****1234', bank: '第一銀行', cdKey: '第一銀行|1234|USD|2026-01-01~2026-07-01|51|#1' },
  ], transactions: [], settings: {} };
  const rows = previewBalancesForDb(db, /** @type {any} */ (parsed)).rows;
  assert.ok(rows.every((r) => r.action !== 'create'), `★不可再建一戶（實得 ${rows.map((r) => r.action).join(',')}）`);
  applyBalancesToDb(db, /** @type {any} */ (parsed));
  assert.equal(db.accounts.length, 1, '★同一筆定存');
  assert.equal(db.accounts[0].cdKey, '第一銀行|1234|USD|2026-01-01~2026-07-01|51|#1', '舊鍵不回寫');
  assert.equal(db.accounts[0].balance, 51);
});

test('★定存｜舊戶 cdKey 長寫法＋參考日已過迄日、但這期**仍印著它**＝不可歸零（liveKeys 要用比對形才認得出「還印著」）', () => {
  // 這一題專釘到期判定那條路：內建範本（deterministic）才會跑 maturedCdAccounts；若 liveKeys 拿舊鍵逐字比，
  // 舊戶的「第一銀行|…」對不上本批的「第一|…」⇒ 被當成「這期沒印」⇒ 過了迄日就歸零＝還在的定存被清成 0。
  const cd = { suffix: '1234', masked: '900100****1234', balance: 51, currency: 'USD', label: '定存', note: '', kind: 'time', period: '2026-01-01~2026-07-01' };
  const parsed = { bank: '第一', referenceDate: '2026-08-31', accounts: [cd], accountCurrency: { '900100****1234': 'USD' }, transactions: [] };
  const db = { accounts: [
    { id: 'cd1', name: '第一 定存', type: 'cash', currency: 'USD', balance: 51, balanceAsOf: '2026-06-30', accountNo: '900100****1234', bank: '第一銀行', cdKey: '第一銀行|1234|USD|2026-01-01~2026-07-01|51|#1' },
  ], transactions: [], settings: {} };
  const rows = previewBalancesForDb(db, /** @type {any} */ (parsed), { deterministic: true }).rows;
  assert.ok(!rows.some((r) => r.action === 'mature-zero'), `★這期還印著＝不可歸零（實得 ${rows.map((r) => r.action).join(',')}）`);
  applyBalancesToDb(db, /** @type {any} */ (parsed), { deterministic: true });
  assert.equal(db.accounts[0].balance, 51, '★餘額不可被清成 0');
});

test('★帳戶｜金融卡明細（只有末碼）對上機構戳是舊寫法「台新銀行」的帳戶：要認親更新，不可歧義停手', () => {
  const parsed = { bank: '台新', referenceDate: '2026-06-30',
    accounts: [{ suffix: '8791', masked: '**********8791', balance: 175105, currency: 'TWD', label: '簽帳金融卡', note: '', kind: 'demand', period: '', suffixOnly: true, balanceFromDetail: true }],
    accountCurrency: { '**********8791': 'TWD' }, transactions: [] };
  const db = { accounts: [{ id: 'a', name: '台新活儲', type: 'cash', currency: 'TWD', balance: 100, balanceAsOf: '2026-05-31', accountNo: '900100****8791', bank: '台新銀行' }], transactions: [], settings: {} };
  const rows = previewBalancesForDb(db, /** @type {any} */ (parsed)).rows;
  assert.equal(rows[0].action, 'update', `★舊戳「台新銀行」＝能證明是台新的戶，要更新（實得 ${rows[0].action}）`);
});
