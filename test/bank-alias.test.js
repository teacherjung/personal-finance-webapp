// @ts-check
// 機構名正規化（Stage 4，2026-08-22／23）。
// 為什麼要有：內建範本寫「台新」、AI 路線照抬頭抄「台新銀行」「台新國際商業銀行」「Taishin Bank」，而機構名進了
// 去重鍵、帳戶機構戳、定存身分鍵、疑似重複索引。寫法不一致＝重匯同一份帳單認不出重複（現金流翻倍）、同一顆帳戶
// 被當成他行而裂戶、台新走 AI 路線時去重鍵走錯格式。
// 這份考題釘：①**身分那把尺只認得台新**（其他機構只去公司型態字＋字元正規化，兩種寫法並存＝漏合併、可接受）
// ②**祖父條款**——存好的鍵一個位元組不改，比對時兩邊都正規化 ③**不可亂合併**：審查六輪各找到一對共用品牌的不同法人
// （三家上海、中國銀行 vs 中國國際商業銀行、城市名銀行、日本樂天 vs 台灣樂天、中信銀行 vs 中國信託、富邦香港 vs 台北富邦），
// 全部列在「兩兩不同」表裡，任一對被壓成同一字串＝紅 ④疑似重複的提醒用另一把寬鬆的尺（main 既有啟發式）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-bank-alias-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;   // 顯示層那題走 getDb/saveDb（自動整理），要隔離暫存檔
after(() => { for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

const { canonicalBank, sameBank, canonRef, canonCdKey, looseBankKey } = await import('../lib/bank-alias.js');
const { previewBankTxForDb, importBankTxToDb, previewBalancesForDb, applyBalancesToDb } = await import('../lib/services/bank-import.js');

// ---------- 規則本身 ----------
test('台新家族：所有寫法壓回「台新」（中英、全形、公司型態字、Richart）', () => {
  for (const w of ['台新', '台新銀行', '台新國際商業銀行', '台新國際商業銀行股份有限公司', '臺新銀行', ' 台新 ', 'Taishin Bank', 'TAISHIN INTERNATIONAL BANK',
    'Taishin Bank Co., Ltd.', 'Taishin Bank Co Ltd', 'TAISHIN INTERNATIONAL BANK CO., LTD.', 'Taishin Commercial Bank', 'ＴＡＩＳＨＩＮ　ＢＡＮＫ', 'Richart', 'taishin']) {
    assert.equal(canonicalBank(w), '台新', w);
  }
});

test('★身分那把尺只認得台新：其他機構只去公司型態字、不剝銀行字樣、不查別名（兩種寫法並存＝漏合併，可接受）', () => {
  assert.equal(canonicalBank('玉山商業銀行'), '玉山商業銀行');
  assert.equal(canonicalBank('玉山商業銀行股份有限公司'), '玉山商業銀行', '公司型態字剝掉');
  assert.equal(canonicalBank('E.SUN Bank'), 'E.SUN BANK', '不認得的拉丁名＝大寫摺疊、Bank 不剝');
  assert.equal(canonicalBank('Foo Bank, Ltd.'), 'FOO BANK', '公司字剝掉；Bank 不剝');
  assert.equal(canonicalBank('Lincoln Inc.'), 'LINCOLN');
  assert.equal(canonicalBank('Vinc'), 'VINC', '公司字要整個詞才剝（Vinc 的尾巴不是 Inc）');
  assert.equal(canonicalBank('U.S. Bancorp'), 'U.S. BANCORP');
  assert.equal(sameBank('HSBC', 'hsbc'), true, '同一家的大小寫不可被當兩家');
  assert.equal(sameBank('玉山', '玉山商業銀行'), false, '漏合併的方向：兩個短名並存、看得出來');
});

test('★不可亂合併：台新證券≠台新；只剩通用詞不回空；分段符剝掉', () => {
  assert.notEqual(canonicalBank('台新證券'), '台新', '★證券是另一家——剝掉等於把兩家併成一家');
  assert.equal(canonicalBank('銀行'), '銀行', '只剩通用詞＝回原形，不回空（空會被當成缺席）');
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
  assert.equal(canonRef('bank2|玉山商業銀行股份有限公司|800****1|2026-06-10|in|100||a|b'), 'bank2|玉山商業銀行|800****1|2026-06-10|in|100||a|b', '他行：只去公司型態字');
  assert.equal(canonRef('bank|900100****8791|2026-06-10|in|100||a|b'), 'bank|900100****8791|2026-06-10|in|100||a|b', '舊格式一個位元組不動');
  assert.equal(canonRef('bank2|沒有第二個分段符'), 'bank2|沒有第二個分段符');
  assert.equal(canonRef(''), '');
  // 備註含 `|` 也不可被動到：只改機構段
  assert.equal(canonRef('bank2|玉山銀行|800****1|2026-06-10|in|100||a|b|c'), 'bank2|玉山銀行|800****1|2026-06-10|in|100||a|b|c');
});

test('canonCdKey｜定存身分鍵比對形：只壓第一段', () => {
  assert.equal(canonCdKey('台新銀行|1234|USD||51|#1'), '台新|1234|USD||51|#1');
  assert.equal(canonCdKey('第一銀行股份有限公司|1234|USD||51|#1'), '第一銀行|1234|USD||51|#1');
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

test('★去重｜他行只去公司型態字就互認；不同銀行的同字樣帳號仍分得開', () => {
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他',
      bankRef: 'bank2|玉山商業銀行股份有限公司|900100****3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const same = { bank: '玉山商業銀行', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  assert.equal(importBankTxToDb(db, same).imported, 0, '玉山商業銀行＝玉山商業銀行股份有限公司');
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
  const parsed = { bank: '台新', referenceDate: '2026-06-30', accounts: [cd], accountCurrency: { '900100****1234': 'USD' }, transactions: [] };
  const db = { accounts: [
    { id: 'cd1', name: '台新 定存', type: 'cash', currency: 'USD', balance: 51, accountNo: '900100****1234', bank: '台新銀行', cdKey: '台新銀行|1234|USD|2026-01-01~2026-07-01|51|#1' },
  ], transactions: [], settings: {} };
  const rows = previewBalancesForDb(db, /** @type {any} */ (parsed)).rows;
  assert.ok(rows.every((r) => r.action !== 'create'), `★不可再建一戶（實得 ${rows.map((r) => r.action).join(',')}）`);
  applyBalancesToDb(db, /** @type {any} */ (parsed));
  assert.equal(db.accounts.length, 1, '★同一筆定存');
  assert.equal(db.accounts[0].cdKey, '台新銀行|1234|USD|2026-01-01~2026-07-01|51|#1', '舊鍵不回寫');
  assert.equal(db.accounts[0].balance, 51);
});

test('★定存｜舊戶 cdKey 長寫法＋參考日已過迄日、但這期**仍印著它**＝不可歸零（liveKeys 要用比對形才認得出「還印著」）', () => {
  // 這一題專釘到期判定那條路：內建範本（deterministic）才會跑 maturedCdAccounts；若 liveKeys 拿舊鍵逐字比，
  // 舊戶的「台新銀行|…」對不上本批的「台新|…」⇒ 被當成「這期沒印」⇒ 過了迄日就歸零＝還在的定存被清成 0。
  const cd = { suffix: '1234', masked: '900100****1234', balance: 51, currency: 'USD', label: '定存', note: '', kind: 'time', period: '2026-01-01~2026-07-01' };
  const parsed = { bank: '台新', referenceDate: '2026-08-31', accounts: [cd], accountCurrency: { '900100****1234': 'USD' }, transactions: [] };
  const db = { accounts: [
    { id: 'cd1', name: '台新 定存', type: 'cash', currency: 'USD', balance: 51, balanceAsOf: '2026-06-30', accountNo: '900100****1234', bank: '台新銀行', cdKey: '台新銀行|1234|USD|2026-01-01~2026-07-01|51|#1' },
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

// ---------- 不可亂合併：審查六輪各找到的「共用品牌的不同法人」，正規化後必須兩兩不同 ----------
// 這張表是亂合併方向唯一的機械守門：任兩家同名＝紅。要放寬身分那把尺之前，先拿這張表試。
const DISTINCT_INSTITUTIONS = [
  '台新國際商業銀行', '台新證券',
  '上海商業儲蓄銀行', '上海商業銀行', '上海銀行',            // 台灣／香港／中國三家
  '中國銀行股份有限公司', '中國國際商業銀行股份有限公司',     // 兩家不同法人，官方登記名都帶公司字
  '中信銀行', '中國信託商業銀行',                            // 中國中信銀行 vs 台灣中國信託
  'Fubon Bank', 'Taipei Fubon Bank',                         // 富邦銀行（香港） vs 台北富邦
  'Rakuten Bank, Ltd.', 'Rakuten International Commercial Bank Co., Ltd.',   // 日本樂天銀行 vs 台灣樂天國際商業銀行
  '臺中商業銀行', '高雄銀行', '彰化商業銀行', '台中', '高雄', '彰化',   // 城市名銀行 vs 裸城市名
  '國泰世華商業銀行', '國泰人壽', '玉山商業銀行', '兆豐國際商業銀行', '第一商業銀行', 'HSBC', 'Citibank',
];
test('★不可亂合併：共用品牌的不同法人，正規化後必須兩兩不同（任何放寬都先過這一題）', () => {
  const seen = new Map();
  for (const name of DISTINCT_INSTITUTIONS) {
    const c = canonicalBank(name);
    assert.ok(c, `${name} 不可正規化成空`);
    assert.ok(!seen.has(c), `★「${name}」與「${seen.get(c)}」被壓成同一個短名「${c}」`);
    seen.set(c, name);
  }
});

test('★裸地名不是機構：「台灣」「台中」「上海」自己一個詞，不可被當成任何一家銀行', () => {
  for (const place of ['台灣', '台中', '高雄', '上海', '中國']) {
    assert.equal(sameBank(place, `${place}銀行`), false, `★${place} ≠ ${place}銀行`);
    assert.equal(sameBank(place, '台新'), false);
  }
});

// ---------- 疑似重複提醒的寬鬆尺（不碰身分） ----------
test('寬鬆尺 looseBankKey：台中銀行＝台中商業銀行、合成一銀商業銀行＝合成一銀（機構維度之前的既有啟發式）；但身分尺仍分開', () => {
  assert.equal(looseBankKey('台中銀行'), looseBankKey('台中商業銀行'));
  assert.equal(looseBankKey('彰化銀行'), looseBankKey('彰化商業銀行'));
  assert.equal(looseBankKey('台新'), looseBankKey('台新國際商業銀行'));
  assert.notEqual(looseBankKey('合成一銀商業銀行'), looseBankKey('台新'));
  assert.equal(sameBank('台中銀行', '台中商業銀行'), false, '身分尺不認（兩個短名並存）');
});

test('★疑似重複：既有列機構寫「台中商業銀行」、新帳單寫「台中銀行」、同末碼同日同額＝要提醒（寬鬆尺）；但不是明確重複（身分尺）', () => {
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他',
      bankRef: 'bank2|台中商業銀行|****3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const parsed = { bank: '台中銀行', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  const row = previewBankTxForDb(db, parsed).rows[0];
  assert.equal(row.duplicate, false, '身分不同＝不是明確重複');
  assert.equal(row.similar, true, '★寬鬆尺要提醒疑似重複');
});

test('★英文公司型態字：「Taishin Bank Co Ltd」抄回來的台新列，與內建範本同一筆＝明確重複、餘額配到同一顆', () => {
  const db = { accounts: [{ id: 'a', name: '台新活儲', type: 'cash', currency: 'TWD', balance: 100, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '台新' }], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他', bankRef: 'bank|900100****3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const parsed = { bank: 'Taishin Bank Co Ltd', referenceDate: '2026-06-30', accounts: [{ suffix: '3301', masked: '900100****3301', balance: 5000, currency: 'TWD', label: '活儲', note: '', kind: 'demand', period: '' }], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  assert.equal(previewBankTxForDb(db, parsed).rows[0].duplicate, true, '★明確重複');
  assert.equal(importBankTxToDb(db, parsed).imported, 0);
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed)).rows[0].action, 'update', '★配到同一顆、不裂戶');
});

test('★去重比對形：舊 `bank2|台新銀行|x****3302|…`（沒遮罩時自己補的佔位）對新的無遮罩列＝明確重複', () => {
  // bankRefBase 沒有 acctMasked 時會拼 `x****末碼`；這種帳號段含星號＝要改寫成 bank|（跟新列拼出來的一樣）
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他', bankRef: 'bank2|台新銀行|x****3302|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const parsed = { bank: '台新', accounts: [], accountCurrency: {}, transactions: [btx({ acctSuffix: '3302', acctMasked: '' })] };
  assert.equal(previewBankTxForDb(db, parsed).rows[0].duplicate, true, '★佔位遮罩也是遮罩＝同一筆');
  assert.equal(importBankTxToDb(db, parsed).imported, 0);
});

test('★原型鍵（鐵則 3.5）：機構名是外部文字，`__proto__`／`constructor`／`toString` 不可撈到原型上的東西', () => {
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    const c = canonicalBank(k);
    assert.equal(typeof c, 'string', `${k} 要回字串`);
    assert.equal(sameBank(k, '台新'), false);
  }
  // 走正式預覽：機構名是保留字的帳單不可讓預覽炸掉（instKey 會對結果 .toLowerCase()）
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'o', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他', bankRef: 'bank2|constructor|900100****3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const parsed = { bank: '__proto__', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  assert.doesNotThrow(() => previewBankTxForDb(db, parsed));
});

test('★去重比對形不可冒充末碼祖父鍵：`bank2|台新|<純末碼>|…` 不改寫成 `bank|`（那是 bankRefLegacy 的命名空間）', () => {
  // 舊列帳號段只有末碼（沒星號）；新列是同銀行、同末碼、**不同前綴**的另一顆帳戶——兩者不是同一筆
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他',
      bankRef: 'bank2|台新銀行|3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const parsed = { bank: '台新', accounts: [], accountCurrency: { '900200****3301': 'TWD' }, transactions: [btx({ acctMasked: '900200****3301' })] };
  assert.equal(previewBankTxForDb(db, parsed).rows[0].duplicate, false, '★不可標成明確重複');
  assert.equal(importBankTxToDb(db, parsed).imported, 1, '★真交易要匯進來');
  assert.equal(canonRef('bank2|台新銀行|3301|2026-06-10|in|1000||轉帳存入|'), 'bank2|台新|3301|2026-06-10|in|1000||轉帳存入|');
});

test('★跨機構正式路：中國銀行（股份有限公司）的帳戶，中國國際商業銀行（股份有限公司）的帳單不可配到它', () => {
  const parsed = { bank: '中國國際商業銀行股份有限公司', referenceDate: '2026-06-30', accounts: [{ suffix: '3301', masked: '900100****3301', balance: 1, currency: 'TWD', label: '活儲', note: '', kind: 'demand', period: '' }], accountCurrency: { '900100****3301': 'TWD' }, transactions: [] };
  const db = { accounts: [{ id: 'a', name: '中銀活儲', type: 'cash', currency: 'TWD', balance: 5000, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '中國銀行股份有限公司' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed)).rows[0].action, 'create', '★不同機構＝建新戶，不可 update 蓋餘額');
  applyBalancesToDb(db, /** @type {any} */ (parsed));
  assert.equal(db.accounts[0].balance, 5000, '★中國銀行的餘額不可被蓋');
  // 定存與去重同一把尺
  assert.notEqual(canonCdKey('中國銀行股份有限公司|3301|USD||51|#1'), canonCdKey('中國國際商業銀行股份有限公司|3301|USD||51|#1'));
  assert.notEqual(canonRef('bank2|中國銀行股份有限公司|900100****3301|2026-06-10|in|1||a|b'), canonRef('bank2|中國國際商業銀行股份有限公司|900100****3301|2026-06-10|in|1||a|b'));
});

// ---------- 每一處機構守門都要過同一把尺（預審突變逐處存活後補的行為題） ----------
test('★幣別判定：機構戳舊寫法「台新銀行」的外幣帳戶，台新帳單沒印幣別表時仍要判成外幣、不可當台幣匯進現金流', () => {
  // txCurrency 的退路：帳單自己沒有這個帳號的幣別 ⇒ 查 db 帳戶；機構守門若逐字比，「台新銀行」≠「台新」
  // ＝查不到 ⇒ fail-open 成 TWD ⇒ 美元交易被當台幣入帳。
  const db = { accounts: [{ id: 'u', name: '台新美元', type: 'cash', currency: 'USD', accountNo: '900100****7777', bank: '台新銀行' }], transactions: [], learnedBank: {}, settings: {} };
  const parsed = { bank: '台新', accounts: [], accountCurrency: {}, transactions: [btx({ acctSuffix: '7777', acctMasked: '900100****7777', amount: 100 })] };
  const r = importBankTxToDb(db, parsed);
  assert.equal(r.foreign, 1, '★判成外幣（不匯入）');
  assert.equal(r.imported, 0);
});

test('★定存到期：舊戳「台新銀行」的定存，新一期帳單（台新）沒印它、參考日已過迄日＝要歸零（守門逐字比就永遠不歸零）', () => {
  const db = { accounts: [
    { id: 'cd1', name: '台新 定存', type: 'cash', currency: 'USD', balance: 51, balanceAsOf: '2026-06-30', accountNo: '900100****1234', bank: '台新銀行', cdKey: '台新銀行|1234|USD|2026-01-01~2026-07-01|51|#1' },
  ], transactions: [], settings: {} };
  // 新一期：只印活存、沒印定存；參考日 8/31 已過迄日 7/1
  const parsed = { bank: '台新', referenceDate: '2026-08-31', accounts: [{ suffix: '1234', masked: '900100****1234', balance: 999, currency: 'USD', label: '活存', note: '', kind: 'demand', period: '' }], accountCurrency: { '900100****1234': 'USD' }, transactions: [] };
  const rows = previewBalancesForDb(db, /** @type {any} */ (parsed), { deterministic: true }).rows;
  assert.ok(rows.some((r) => r.action === 'mature-zero'), `★要有一列到期歸零（實得 ${rows.map((r) => r.action).join(',')}）`);
  applyBalancesToDb(db, /** @type {any} */ (parsed), { deterministic: true });
  const cd = /** @type {any} */ (db.accounts.find((a) => a.id === 'cd1'));
  assert.equal(cd.balance, 0, '★到期定存歸零');
});

test('★交易掛名：機構戳舊寫法「台新銀行」的帳戶，台新帳單的交易要掛到它名下（不可退化成「台新 3301」）', () => {
  const db = { accounts: [{ id: 'a', name: '我的台新活儲', type: 'cash', currency: 'TWD', accountNo: '900100****3301', bank: '台新銀行' }], transactions: [], learnedBank: {}, settings: {} };
  const parsed = { bank: '台新', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  importBankTxToDb(db, parsed);
  assert.equal(/** @type {any} */ (db.transactions.at(-1)).account, '我的台新活儲');
});

test('★顯示「轉入到：」：對方帳號是自己機構戳舊寫法的帳戶，顯示名要翻成帳戶名', () => {
  const db = { accounts: [
    { id: 'a', name: '台新活儲', type: 'cash', currency: 'TWD', accountNo: '900100****3301', bank: '台新銀行' },
    { id: 'b', name: '台新預備', type: 'cash', currency: 'TWD', accountNo: '900100****8791', bank: '台新銀行' },
  ], transactions: [], learnedBank: {}, settings: {} };
  const parsed = { bank: '台新', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({ summary: '轉帳支取', note: '轉入900100****8791', direction: 'out', amount: 500 })] };
  importBankTxToDb(db, parsed);
  assert.match(String(/** @type {any} */ (db.transactions.at(-1)).note), /轉入到：台新預備/);
});

test('★疑似重複索引：既有列機構抄成英文「Taishin Bank」、帳號只印末碼，新帳單（台新）同日同額＝要提醒疑似重複', () => {
  // 鍵不同（帳號遮罩不同）＝不是明確重複；機構名若沒過同一把尺，索引鍵對不上＝不提醒＝跨版式重複靜默落帳
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'old', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他',
      bankRef: 'bank2|Taishin Bank|****3301|2026-06-10|in|1000||轉帳存入|' },
  ] };
  const parsed = { bank: '台新', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({})] };
  const row = previewBankTxForDb(db, parsed).rows[0];
  assert.equal(row.duplicate, false, '帳號遮罩不同＝不是明確重複');
  assert.equal(row.similar, true, '★但要提醒疑似重複');
});

test('★去重比對形要保留批內出現序 #N：舊列（AI 抄成台新銀行）兩筆全同、餘額讀不到＝鍵尾 |#2；內建範本重匯時兩筆都要認出是重複', () => {
  const tail = '2026-06-10|in|1000||轉帳存入|';
  const db = { accounts: [], learnedBank: {}, settings: {}, transactions: [
    { id: 'o1', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他', bankRef: `bank2|台新銀行|900100****3301|${tail}` },
    { id: 'o2', source: 'bank', date: '2026-06-10', amount: 1000, dir: 'in', type: 'income', category: '其他', bankRef: `bank2|台新銀行|900100****3301|${tail}#2` },
  ] };
  const again = { bank: '台新', accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: [btx({}), btx({})] };
  const r = importBankTxToDb(db, again);
  assert.equal(r.imported, 0, '★第二筆（#2）也要認出是重複——比對形若剝掉 #N，第二筆會再匯一次');
  assert.equal(r.skipped, 2);
});

test('預覽／套用回傳的 bank 欄＝正規短名（畫面上的「銀行：」與新建帳戶的戳一致）', () => {
  const parsed = { bank: '台新國際商業銀行', referenceDate: '2026-06-30', accounts: [], accountCurrency: {}, transactions: [] };
  const db = { accounts: [], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed)).bank, '台新');
  assert.equal(applyBalancesToDb({ accounts: [], transactions: [], settings: {} }, /** @type {any} */ (parsed)).bank, '台新');
});

test('★顯示層的機構段也過同一把尺：舊列 `bank2|台新銀行|…` 的自動說明要跟 `bank|…` 列一樣補「812-」前綴', async () => {
  const { reconcileAccountNamesAuto } = await import('../lib/services/bank-import.js');
  const { getDb, saveDb } = await import('../lib/repo.js');
  const db = await getDb();
  db.accounts = [];
  const tail = '2026-06-10|out|1000||轉帳支出|轉出900300****9999';
  db.transactions = [
    { id: 'x1', date: '2026-06-10', type: 'transfer', category: '內轉', subcategory: '內轉出', amount: 1000, account: '台新 8791', note: '', ledger: 'cashflow', source: 'bank', dir: 'out', bankRef: `bank2|台新銀行|900100****8791|${tail}` },
    { id: 'x2', date: '2026-06-10', type: 'transfer', category: '內轉', subcategory: '內轉出', amount: 1000, account: '台新 8791', note: '', ledger: 'cashflow', source: 'bank', dir: 'out', bankRef: `bank|900100****8791|${tail}` },
  ];
  await saveDb(db);
  await reconcileAccountNamesAuto();
  const fresh = await getDb();
  const n = (/** @type {string} */ id) => String(/** @type {any} */ ((fresh.transactions || []).find((/** @type {any} */ t) => t.id === id)).note);
  assert.equal(n('x1'), n('x2'), `★兩列同一家、同內容，顯示名必須相同（實得 ${n('x1')} vs ${n('x2')}）`);
  assert.match(n('x2'), /812-/, '台新行內帳號顯示補 812-');
});
