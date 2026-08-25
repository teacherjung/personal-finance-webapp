// @ts-check
// Stage 5b（William 2026-08-23 選 A 案：建「簽帳金融卡」卡片實體）：金融卡帳單一份產出兩種明細。
// A 區「刷卡消費明細」（買了什麼）→ 自動建（或找到）簽帳卡、記到它的卡片帳本（帶分類，走信用卡帳單同一條寫入路）；
// D 區「刷卡消費／刷卡退貨」（錢的流向）→ 現金流照記，但**分類留空**（同繳卡費模型）——消費分析只算卡片那一份，
// 錢不算兩次。綜合對帳單沒有 A 區 ⇒ 它的刷卡列照舊分類（行為不變）。
// 隔離暫存 DB；帳號、店名、金額全是合成的。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-debit-ledger-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { previewBankStatement, applyBankStatement, listBankBatches, deleteBankBatch } = await import('../lib/services/bank-import.js');
const { consumptionByMonth } = await import('../lib/derive.js');
const { FIELD_SCHEMA } = await import('../lib/schema.js');
const { getDb, saveDb } = await import('../lib/repo.js');

after(() => { for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

const MASKED = '**********8791';
/** 金融卡帳單的合成解析結果：D 區三筆（兩筆刷卡、一筆轉帳存入）＋ A 區兩筆（同一筆錢的另一種印法）。
 * 餘額鏈：10000 → 刷卡 -305 → 9695 → 轉帳存入 +1000 → 10695 → 刷卡 -1234 → 9461。 */
function debitParsed(/** @type {(f:any)=>void} */ mutate) {
  const f = {
    bank: '台新', referenceDate: '2026-01-31',
    accounts: [{ suffix: '8791', masked: MASKED, balance: 9461, currency: 'TWD', label: '簽帳金融卡', note: '', kind: 'demand', period: '', suffixOnly: true, balanceFromDetail: true }],
    accountCurrency: { [MASKED]: 'TWD' },
    transactions: [
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-29', summary: '轉帳存入', direction: 'in', amount: 1000, balance: 10695, note: '' },
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-30', summary: '刷卡消費', direction: 'out', amount: 1234, balance: 9461, note: '合成商店Ｂ' },
    ],
    cardRows: [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-30', date: '2026-01-29', amount: 1234, fee: 0, lastFour: '8808', desc: '合成商店Ｂ', region: 'TW', extra: '' },
    ],
  };
  if (mutate) mutate(f);
  return f;
}
async function resetDb() {
  const db = await getDb();
  db.accounts = []; db.transactions = []; db.cards = []; db.learnedBank = {}; db.learnedCategories = {};
  await saveDb(db);
}

test('登記：卡片型別枚舉有 debit、卡片表單選項也有（枚舉與表單的棘輪）', () => {
  assert.ok(FIELD_SCHEMA.cards.type.includes('debit'));
  const src = readFileSync(new URL('../public/modules/cards.js', import.meta.url), 'utf8');
  assert.match(src, /value: 'debit', label: '簽帳金融卡'/, '表單選項要有簽帳金融卡（枚舉有、表單沒有＝那種卡選不到）');
});

test('★預覽：A 區兩筆會記到「台新簽帳金融卡 8808」（還沒有這張卡＝標會新建）；D 區刷卡列分類留空、轉帳列照常分類', async () => {
  await resetDb();
  const r = await previewBankStatement('QUJD', '', async () => debitParsed());
  assert.equal(r.cardLedger.count, 2, '★A 區兩筆');
  assert.equal(r.cardLedger.duplicate, 0);
  assert.deepEqual(r.cardLedger.cards.map((c) => [c.name, c.lastFour, c.exists]), [['台新簽帳金融卡 8808', '8808', false]]);
  const rows = r.transactions.rows;
  assert.deepEqual(rows.map((x) => [x.summary, x.type, x.category]), [['刷卡消費', 'expense', ''], ['轉帳存入', 'income', '其他'], ['刷卡消費', 'expense', '']],
    '★D 區刷卡列分類留空（同繳卡費）、別的列不受影響');
});

test('★套用：自動建卡、A 區記進卡片帳本（ledger card、帶分類、stmtRef 以卡片 id 起頭）、D 區進現金流分類留空；消費分析只算一次', async () => {
  await resetDb();
  const a = await applyBankStatement('QUJD', '', async () => debitParsed());
  assert.equal(a.ok, true);
  assert.equal(a.transactions.imported, 3, 'D 區三筆都進現金流');
  assert.deepEqual(a.cardLedger.cards.map((c) => [c.name, c.created, c.imported, c.skipped]), [['台新簽帳金融卡 8808', true, 2, 0]]);
  const db = await getDb();
  const card = (db.cards || []).find((/** @type {any} */ c) => c.type === 'debit');
  assert.ok(card, '★建了一張簽帳卡');
  assert.equal(card.lastFour, '8808'); assert.equal(card.issuer, '台新');
  const cardTx = (db.transactions || []).filter((/** @type {any} */ t) => t.ledger === 'card');
  assert.equal(cardTx.length, 2, '★卡片帳本兩筆');
  for (const t of cardTx) {
    assert.equal(t.account, card.name);
    assert.ok(String(t.stmtRef).startsWith(`${card.id}|`), 'stmtRef 以卡片 id 起頭＝信用卡帳單同一套去重身分');
    assert.equal(t.source, 'stmt'); assert.equal(t.type, 'expense');
    assert.ok(t.category, '★卡片帳本那一份帶分類');
    assert.equal(t.stmtMonth, '2026-01', '帳單期別＝對帳單期間結束日的月份');
  }
  assert.deepEqual(cardTx.map((t) => [t.date, t.amount]), [['2026-01-27', 305], ['2026-01-29', 1234]], '消費日＋台幣金額');
  const cashTx = (db.transactions || []).filter((/** @type {any} */ t) => t.source === 'bank');
  assert.deepEqual(cashTx.map((t) => [t.type, t.category]), [['expense', ''], ['income', '其他'], ['expense', '']], '★現金流的刷卡列分類留空');
  // 消費視角（月度回顧）＝兩帳聯集裡「有分類的支出」：刷卡只算卡片帳本那一份＝305＋1234，不是兩倍
  const cons = consumptionByMonth(db);
  const total = Object.values(cons.byMonth['2026-01'] || {}).reduce((s, row) => s + Number(row.total || 0), 0);
  assert.equal(total, 305 + 1234, '★錢不算兩次');
});

test('★重匯同一份：卡片帳本兩筆都是重複（不再記）、現金流三筆也重複、不會多建第二張卡', async () => {
  await resetDb();
  await applyBankStatement('QUJD', '', async () => debitParsed());
  const r = await previewBankStatement('QUJD', '', async () => debitParsed());
  assert.equal(r.cardLedger.duplicate, 2, '★預覽就標兩筆重複');
  assert.equal(r.cardLedger.cards[0].exists, true, '卡已存在');
  const a = await applyBankStatement('QUJD', '', async () => debitParsed());
  assert.equal(a.cardLedger.imported, 0); assert.equal(a.cardLedger.skipped, 2);
  assert.equal(a.transactions.imported, 0);
  const db = await getDb();
  assert.equal((db.cards || []).filter((/** @type {any} */ c) => c.type === 'debit').length, 1, '★只有一張');
  assert.equal((db.transactions || []).filter((/** @type {any} */ t) => t.ledger === 'card').length, 2);
});

test('既有簽帳卡（使用者自己建、發卡機構寫長名）：配到它、不新建', async () => {
  await resetDb();
  const db0 = await getDb();
  db0.cards = [{ id: 'mycard', name: '我的金融卡', type: 'debit', issuer: '台新國際商業銀行', lastFour: '8808' }];
  await saveDb(db0);
  const r = await previewBankStatement('QUJD', '', async () => debitParsed());
  assert.deepEqual(r.cardLedger.cards.map((c) => [c.cardId, c.name, c.exists]), [['mycard', '我的金融卡', true]]);
  const a = await applyBankStatement('QUJD', '', async () => debitParsed());
  assert.equal(a.cardLedger.cards[0].created, false);
  const db = await getDb();
  assert.equal((db.cards || []).length, 1);
  assert.ok((db.transactions || []).filter((/** @type {any} */ t) => t.ledger === 'card').every((/** @type {any} */ t) => t.account === '我的金融卡'));
});

test('★卡片配對三個條件缺一不可：信用卡同末碼不算、簽帳卡末碼不同不算、簽帳卡別家銀行不算——都要另建一張', async () => {
  for (const [label, card] of /** @type {[string, any][]} */ ([
    ['信用卡同末碼', { id: 'cc', name: '台新信用卡', type: 'credit', issuer: '台新', lastFour: '8808' }],
    ['簽帳卡末碼不同', { id: 'd1', name: '別張金融卡', type: 'debit', issuer: '台新', lastFour: '1234' }],
    ['簽帳卡別家銀行', { id: 'd2', name: '玉山金融卡', type: 'debit', issuer: '玉山銀行', lastFour: '8808' }],
  ])) {
    await resetDb();
    const db0 = await getDb(); db0.cards = [card]; await saveDb(db0);
    const r = await previewBankStatement('QUJD', '', async () => debitParsed());
    assert.equal(r.cardLedger.cards[0].exists, false, `★${label}：不可配到它`);
    await applyBankStatement('QUJD', '', async () => debitParsed());
    const db = await getDb();
    assert.equal((db.cards || []).length, 2, `★${label}：另建一張`);
    assert.ok((db.transactions || []).filter((/** @type {any} */ t) => t.ledger === 'card').every((/** @type {any} */ t) => t.account === '台新簽帳金融卡 8808'), `★${label}：記到新建那張`);
  }
});

test('★新建的卡：同一份帳單裡兩筆完全相同的刷卡（同日同店同額）都要記（stmtRef 帶 |#2）——建卡後要用真 id 重算序號', async () => {
  await resetDb();
  const parsed = debitParsed((f) => {
    // D 區也是兩筆一樣的刷卡（兩區對得上才記；餘額鏈 10000→9695→9390）
    f.transactions = [
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9390, note: '合成商店Ａ' },
    ];
    f.accounts[0].balance = 9390;
    f.cardRows = [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
    ];
  });
  const a = await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(a.cardLedger.imported, 2, '★兩杯一樣的咖啡是真消費，第二筆不可被當重複吃掉');
  const db = await getDb();
  const refs = (db.transactions || []).filter((/** @type {any} */ t) => t.ledger === 'card').map((/** @type {any} */ t) => String(t.stmtRef));
  assert.ok(refs.some((x) => x.endsWith('|#2')), `第二筆帶序號段（實得 ${refs.join(' / ')}）`);
});

test('★沒有 A 區（綜合對帳單那種）：刷卡列照舊分類、不建卡、cardLedger 空——行為不變', async () => {
  await resetDb();
  const r = await previewBankStatement('QUJD', '', async () => debitParsed((f) => { f.cardRows = []; }));
  assert.deepEqual(r.cardLedger, { cards: [], count: 0, duplicate: 0, notRecorded: { unmatched: 0, unreadable: 0, cashflowCategorized: 0 }, error: '' });
  assert.ok(r.transactions.rows.filter((x) => x.summary === '刷卡消費').every((x) => x.category), '★沒有 A 區＝刷卡列要有分類（否則消費分析少算）');
  const a = await applyBankStatement('QUJD', '', async () => debitParsed((f) => { f.cardRows = []; }));
  assert.deepEqual(a.cardLedger, { cards: [], imported: 0, skipped: 0, notRecorded: { unmatched: 0, unreadable: 0, cashflowCategorized: 0 }, error: '' });
  const db = await getDb();
  assert.equal((db.cards || []).length, 0);
  assert.ok((db.transactions || []).filter((/** @type {any} */ t) => t.source === 'bank' && /刷卡/.test(String(t.bankSummary))).every((/** @type {any} */ t) => t.category));
});

test('刷卡退貨：A 區負數＝卡片帳本的退款列（金額為負、標待配對）；D 區進帳列分類留空', async () => {
  await resetDb();
  const parsed = debitParsed((f) => {
    f.transactions = [
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-30', summary: '刷卡退貨', direction: 'in', amount: 305, balance: 10000, note: '合成商店Ａ' },
    ];
    f.accounts[0].balance = 10000;
    f.cardRows = [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-30', date: '2026-01-29', amount: -305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
    ];
  });
  const a = await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(a.cardLedger.imported, 2);
  const db = await getDb();
  const refund = (db.transactions || []).find((/** @type {any} */ t) => t.ledger === 'card' && t.amount < 0);
  assert.ok(refund, '★退款列存進卡片帳本');
  assert.equal(refund.refundOf, null, '待配對標記（同信用卡退款）');
  const inRow = (db.transactions || []).find((/** @type {any} */ t) => t.source === 'bank' && t.dir === 'in');
  assert.equal(inRow.type, 'income'); assert.equal(inRow.category, '', '★刷卡退貨的進帳分類留空');
});

test('學過的規則讓位：使用者曾把「刷卡消費」學成某分類，有 A 區時仍留空（A 區那一份才是分類的家）', async () => {
  await resetDb();
  const db0 = await getDb();
  db0.learnedBank = { '刷卡消費|合成商店Ａ': { type: 'expense', category: '生活', subcategory: '外食' } };
  await saveDb(db0);
  const r = await previewBankStatement('QUJD', '', async () => debitParsed());
  const row = r.transactions.rows.find((x) => x.summary === '刷卡消費');
  assert.equal(row.category, '', '★學過也留空');
  assert.equal(row.learned, false, '不可標「已學」（沒套用）');
});

// ---------- 畫面的兩句白話（就地解釋鐵則：懂了才不會把正常數字當算錯） ----------
test('預覽窗那一句：講到記到哪張卡、幾筆、重複幾筆、以及「錢不會算兩次」的理由；沒有 A 區＝空字串不畫', async () => {
  const { bankCardLedgerNote, bankCardLedgerDoneText, bankApplyDoneText } = await import('../public/modules/cashflow-model.js');
  assert.equal(bankCardLedgerNote({ cards: [], count: 0, duplicate: 0 }), '');
  assert.equal(bankCardLedgerNote(null), '');
  const s = bankCardLedgerNote({ cards: [{ name: '台新簽帳金融卡 8808', exists: false }], count: 17, duplicate: 2 });
  for (const must of ['刷卡消費明細', '17 筆', '台新簽帳金融卡 8808', '會新建這張卡', '2 筆之前記過', '不分類', '只算卡片那一份']) assert.ok(s.includes(must), `★缺「${must}」：${s}`);
  assert.ok(!s.includes('不會算兩次'), '★不寫無條件保證（事後手動補分類、刪卡重匯都會讓它變假——只說這幾筆怎麼算）');
  assert.ok(!bankCardLedgerNote({ cards: [{ name: 'X', exists: true }], count: 3, duplicate: 0 }).includes('新建'), '卡已存在＝不說新建');
  assert.ok(bankCardLedgerNote({ cards: [{ name: 'X', exists: true }], count: 3, duplicate: 3 }).includes('全部都記過了'), '全重複＝要說這次不會再記');
  // 不記的三種原因各自講得出來；A 區讀不出來＝講原因
  const nr = bankCardLedgerNote({ cards: [], count: 0, duplicate: 0, notRecorded: { cashflowCategorized: 2, unmatched: 1, unreadable: 0 } });
  assert.ok(nr.includes('2 筆帳戶那邊之前已經記過') && nr.includes('1 筆對不上'), `★三種不記的原因要講：${nr}`);
  assert.ok(nr.includes('照常分類'), '沒記到卡片＝帳戶那邊照常分類');
  assert.ok(bankCardLedgerNote({ cards: [{ name: 'X', exists: true }], count: 1, notRecorded: { unreadable: 1 } }).includes('另有 1 筆店名或金額沒讀完整'));
  assert.ok(bankCardLedgerNote({ error: '讀不出台幣金額' }).includes('只記了帳戶明細'), '★A 區讀不出來＝講清楚只記了帳戶明細');
  assert.ok(bankCardLedgerDoneText({ cards: [], notRecorded: { unmatched: 1 } }).includes('1 筆沒記到卡片'));
  // 完成句：掛在既有的 bankApplyDoneText 後面，照既有口吻
  const done = bankApplyDoneText({ updated: 1, created: 0, skipped: 0, cardLedger: { cards: [{ name: '台新簽帳金融卡 8808', created: true, imported: 17, skipped: 0 }], imported: 17, skipped: 0 } }, { imported: 48, skipped: 0 }, null);
  assert.ok(done.includes('刷卡消費明細：「台新簽帳金融卡 8808」（新建） 17 筆'), `★完成句要講卡片帳本那一段：${done}`);
  assert.equal(bankCardLedgerDoneText({ cards: [], imported: 0, skipped: 0 }), '', '沒有＝不多講');
  assert.ok(bankCardLedgerDoneText({ cards: [{ name: 'X', created: false, imported: 0, skipped: 5 }] }).includes('略過重複 5'));
});

test('銀行匯入紀錄的筆數格與刪除確認句要把兩本帳都講出來（確認 3 筆、實際刪 5 筆＝畫面說謊）', async () => {
  const { bankBatchCountText, bankBatchDeleteConfirmText } = await import('../public/modules/cashflow-model.js');
  assert.equal(bankBatchCountText({ count: 3 }), '3');
  assert.equal(bankBatchCountText({ count: 3, cardCount: 2 }), '3（＋卡片消費明細 2）');
  const t = bankBatchDeleteConfirmText({ count: 3, cardCount: 2, minDate: '2026-01-28', maxDate: '2026-01-30' });
  assert.ok(t.includes('3 筆收支交易') && t.includes('2 筆刷卡消費明細') && t.includes('一起刪'), `★兩本帳都要講：${t}`);
  assert.equal(bankBatchDeleteConfirmText({ count: 3, minDate: 'a', maxDate: 'b' }), '整批 3 筆（a~b）', '沒有連帶＝照舊');
  const src = readFileSync(new URL('../public/modules/cashflow.js', import.meta.url), 'utf8');
  assert.match(src, /confirmDelete\(bankBatchDeleteConfirmText\(b\)/, '★確認窗走共用句');
  assert.match(src, /bankBatchCountText\(b\)/, '★筆數格走共用句');
});

test('預覽窗真的接上那一句（cashflow.js 樣板走 bankCardLedgerNote、有 cardLedger 才畫）', () => {
  const src = readFileSync(new URL('../public/modules/cashflow.js', import.meta.url), 'utf8');
  assert.match(src, /bankCardLedgerNote\(\/\*\* @type \{any\} \*\/ \(r\)\.cardLedger\)/, '★樣板要呼叫 bankCardLedgerNote(r.cardLedger)');
  assert.match(src, /bankCardLedgerNote[^\n]*from '\.\/cashflow-model\.js'/, '從 cashflow-model 匯入，不手寫第二份');
});

// ---------- 跨帳單：錢不算兩次要在「兩種版面各匯一次」也成立（預審抓到的洞） ----------
/** 綜合對帳單（同帳戶、完整遮罩、沒有 A 區）：同三筆交易、刷卡列帶分類。 */
function combinedParsed() {
  const M = '900200****8791';
  return {
    bank: '台新', referenceDate: '2026-01-31',
    accounts: [{ suffix: '8791', masked: M, balance: 9461, currency: 'TWD', label: '活儲', note: '', kind: 'demand', period: '' }],
    accountCurrency: { [M]: 'TWD' },
    transactions: [
      { acctSuffix: '8791', acctMasked: M, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: M, date: '2026-01-29', summary: '轉帳存入', direction: 'in', amount: 1000, balance: 10695, note: '' },
      { acctSuffix: '8791', acctMasked: M, date: '2026-01-30', summary: '刷卡消費', direction: 'out', amount: 1234, balance: 9461, note: '合成商店Ｂ' },
    ],
  };
}
const consumption = (/** @type {any} */ db) => Object.values(consumptionByMonth(db).byMonth['2026-01'] || {}).reduce((s, row) => s + Number(row.total || 0), 0);

test('★綜合對帳單先匯（刷卡列帶分類）、金融卡帳單後匯：A 區那兩筆**不記**到卡片帳本（帳戶那邊早就帶分類記過）——消費不翻倍', async () => {
  await resetDb();
  await applyBankStatement('QUJD', '', async () => combinedParsed());
  const db1 = await getDb();
  const before = consumption(db1);
  assert.equal(before, 305 + 1234, '綜合對帳單：刷卡列帶分類＝消費 1539');
  const r = await previewBankStatement('QUJD', '', async () => debitParsed());
  assert.equal(r.cardLedger.count, 0, '★預覽就說這次不記到卡片');
  assert.equal(r.cardLedger.notRecorded.cashflowCategorized, 2, '★兩筆因帳戶那邊早就帶分類記過而不記');
  assert.ok(r.transactions.rows.filter((x) => x.summary === '刷卡消費').every((x) => x.category), '★D 區刷卡列這次不留空（對應的 A 區筆沒記）');
  const a = await applyBankStatement('QUJD', '', async () => debitParsed(), { skipSimilar: true });
  assert.equal(a.cardLedger.imported, 0);
  assert.equal((await getDb()).cards.length, 0, '沒記任何一筆＝不建卡');
  assert.equal(consumption(await getDb()), before, '★消費視角不翻倍');
});

test('★「帳戶那邊早就帶分類記過」只認同機構同末碼＋刷卡摘要：別的帳戶、別家銀行、不是刷卡的列（同日同額）都不擋', async () => {
  for (const [label, row] of /** @type {[string, any][]} */ ([
    ['別的帳戶同日同額', { id: 'o', source: 'bank', date: '2026-01-28', amount: 305, dir: 'out', type: 'expense', category: '生活', account: '別戶', bankRef: 'bank|900100****1234|2026-01-28|out|305||刷卡消費|合成商店Ａ', bankSummary: '刷卡消費', bankNote: '合成商店Ａ' }],
    ['同帳戶同日同額但不是刷卡', { id: 'o', source: 'bank', date: '2026-01-28', amount: 305, dir: 'out', type: 'expense', category: '生活', account: '台新 8791', bankRef: 'bank|900200****8791|2026-01-28|out|305||CD轉出|', bankSummary: 'CD轉出', bankNote: '' }],
    ['別家銀行同末碼同日同額的刷卡', { id: 'o', source: 'bank', date: '2026-01-28', amount: 305, dir: 'out', type: 'expense', category: '生活', account: '玉山 8791', bankRef: 'bank2|玉山商業銀行|700100****8791|2026-01-28|out|305||刷卡消費|合成商店Ａ', bankSummary: '刷卡消費', bankNote: '合成商店Ａ' }],
  ])) {
    await resetDb();
    const db0 = await getDb(); db0.transactions = [row]; await saveDb(db0);
    const r = await previewBankStatement('QUJD', '', async () => debitParsed());
    assert.equal(r.cardLedger.notRecorded.cashflowCategorized, 0, `★${label}：不擋`);
    assert.equal(r.cardLedger.count, 2, `★${label}：兩筆照記`);
  }
});

test('★「帳戶那邊早就帶分類記過」要認得舊資料：沒有 dir 欄（方向從 bankRef 還原）、最舊的純末碼鍵、沒有原文欄（反解）都擋', async () => {
  for (const [label, row] of /** @type {[string, any][]} */ ([
    ['舊列沒有 dir', { id: 'o', source: 'bank', date: '2026-01-28', amount: 305, type: 'expense', category: '生活', account: '台新 8791', bankRef: 'bank|900200****8791|2026-01-28|out|305||刷卡消費|合成商店Ａ' }],
    ['最舊的純末碼鍵', { id: 'o', source: 'bank', date: '2026-01-28', amount: 305, type: 'expense', category: '生活', account: '台新 8791', bankRef: 'bank|8791|2026-01-28|out|305||刷卡消費|合成商店Ａ' }],
    ['AI 抄成台新銀行的 bank2 鍵', { id: 'o', source: 'bank', date: '2026-01-28', amount: 305, dir: 'out', type: 'expense', category: '生活', account: '台新 8791', bankRef: 'bank2|台新銀行|900200****8791|2026-01-28|out|305||刷卡消費|合成商店Ａ' }],
  ])) {
    await resetDb();
    const db0 = await getDb(); db0.transactions = [row]; await saveDb(db0);
    const r = await previewBankStatement('QUJD', '', async () => debitParsed());
    assert.equal(r.cardLedger.notRecorded.cashflowCategorized, 1, `★${label}：那一筆要擋`);
    assert.equal(r.cardLedger.count, 1, `★${label}：另一筆照記`);
    const a = await applyBankStatement('QUJD', '', async () => debitParsed(), { skipSimilar: true });
    assert.equal(a.cardLedger.imported, 1);
    assert.equal(consumption(await getDb()), 305 + 1234, `★${label}：消費不翻倍`);
  }
});

test('★同日同額多筆、兩區筆數不等：整群不搬，而且預覽＝套用（A 區 1 筆、D 區 2 筆：卡片記 0、D 兩列都照舊分類）', async () => {
  await resetDb();
  const parsed = debitParsed((f) => {
    f.transactions = [
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9390, note: '合成商店Ａ' },
    ];
    f.accounts[0].balance = 9390;
    f.cardRows = [f.cardRows[0]];
  });
  const r = await previewBankStatement('QUJD', '', async () => parsed);
  assert.equal(r.cardLedger.count, 0, '★預覽：整群不搬');
  assert.ok(r.transactions.rows.every((x) => x.category), '★D 兩列都照舊分類');
  const a = await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(a.cardLedger.imported, 0, '★套用＝預覽');
  const db = await getDb();
  assert.equal(consumption(db), 610, '兩筆刷卡各算一次（走帳戶那邊的分類）');
  assert.ok((db.transactions || []).filter((/** @type {any} */ t) => t.source === 'bank').every((/** @type {any} */ t) => t.category));
});

test('退款跨版面的口徑（釘現況）：綜合對帳單先匯→退貨列是收入、不抵消費（main 既有口徑）；金融卡先匯→卡片帳本配對退款、消費歸零', async () => {
  const buyRefundDebit = () => debitParsed((f) => {
    f.transactions = [
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-30', summary: '刷卡退貨', direction: 'in', amount: 305, balance: 10000, note: '合成商店Ａ' },
    ];
    f.accounts[0].balance = 10000;
    f.cardRows = [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-30', date: '2026-01-29', amount: -305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
    ];
  });
  const buyRefundCombined = () => ({ ...combinedParsed(), transactions: [
    { acctSuffix: '8791', acctMasked: '900200****8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
    { acctSuffix: '8791', acctMasked: '900200****8791', date: '2026-01-30', summary: '刷卡退貨', direction: 'in', amount: 305, balance: 10000, note: '合成商店Ａ' },
  ], accounts: [{ suffix: '8791', masked: '900200****8791', balance: 10000, currency: 'TWD', label: '活儲', note: '', kind: 'demand', period: '' }] });
  // 綜合先：刷卡消費帶分類（305）、刷卡退貨是收入——消費 305（與 main 相同）；金融卡後匯＝A 區兩筆都被擋、不變
  await resetDb();
  await applyBankStatement('QUJD', '', async () => buyRefundCombined());
  assert.equal(consumption(await getDb()), 305, 'main 既有口徑：銀行側退貨列是收入，不抵消費');
  const pv = await previewBankStatement('QUJD', '', async () => buyRefundDebit());
  assert.equal(pv.cardLedger.notRecorded.cashflowCategorized, 2, '★買與退兩筆都被「帳戶那邊已帶分類」擋（退貨那列是收入、也帶分類＝照樣是 blocker）');
  assert.equal(pv.cardLedger.count, 0);
  const ap = await applyBankStatement('QUJD', '', async () => buyRefundDebit(), { skipSimilar: true });
  assert.equal(ap.cardLedger.imported, 0, '★一筆都不記');
  assert.equal((await getDb()).cards.length, 0, '★沒建卡');
  assert.equal((await getDb()).transactions.filter((/** @type {any} */ t) => t.ledger === 'card').length, 0, '★卡片帳本沒有列');
  assert.equal(consumption(await getDb()), 305, '★不動（不會變 610、也不會偷偷變 0）');
  // 金融卡先：卡片帳本一買一退配對＝消費 0；綜合後匯（勾跳過）＝不動
  await resetDb();
  await applyBankStatement('QUJD', '', async () => buyRefundDebit());
  assert.equal(consumption(await getDb()), 0, '卡片帳本的退款配對抵掉消費');
  await applyBankStatement('QUJD', '', async () => buyRefundCombined(), { skipSimilar: true });
  assert.equal(consumption(await getDb()), 0, '★綜合後匯（勾跳過）：不動');
});

test('★批次生命週期跟著那份銀行帳單：卡片帳本那幾筆不列在信用卡匯入紀錄、不准改卡／單獨刪；從銀行匯入紀錄刪那份帳單時一起拿掉', async () => {
  const { listBatches, reassignBatch, deleteBatch } = await import('../lib/services/statement-import.js');
  const { listBankBatches, deleteBankBatch } = await import('../lib/services/bank-import.js');
  await resetDb();
  const db0 = await getDb(); db0.cards = [{ id: 'cc', name: '某信用卡', type: 'credit' }]; await saveDb(db0);
  await applyBankStatement('QUJD', '', async () => debitParsed());
  const db = await getDb();
  const cardTx = (db.transactions || []).filter((/** @type {any} */ t) => t.ledger === 'card');
  const bankBatch = (db.transactions || []).find((/** @type {any} */ t) => t.source === 'bank').importBatch;
  assert.ok(cardTx.every((/** @type {any} */ t) => t.bankBatch === bankBatch), '★卡片帳本列蓋上那份銀行帳單的批次代號');
  assert.equal((await listBatches()).length, 0, '★信用卡匯入紀錄不列它');
  const bb = (await listBankBatches()).find((/** @type {any} */ b) => b.batchId === bankBatch);
  assert.equal(bb.cardCount, 2, '銀行匯入紀錄知道這份帳單連帶記了 2 筆卡片消費');
  const cardBatch = cardTx[0].importBatch;
  await assert.rejects(reassignBatch(cardBatch, 'cc'), (/** @type {any} */ e) => e.status === 400 && /銀行帳單綁在一起/.test(e.message), '★不准改卡（改了 stmtRef 換卡片 id＝重匯時再記一次）');
  await assert.rejects(deleteBatch(cardBatch), (/** @type {any} */ e) => e.status === 400, '★不准單獨刪（D 區那幾列已留空＝消費少算）');
  const r = await deleteBankBatch(bankBatch);
  assert.equal(r.removed, 3 + 2, '★刪那份銀行帳單＝現金流 3 筆＋卡片帳本 2 筆一起拿掉');
  assert.equal((await getDb()).transactions.length, 0);
});

test('★金融卡帳單先匯、綜合對帳單後匯（勾跳過疑似重複）：消費只算卡片那一份', async () => {
  await resetDb();
  await applyBankStatement('QUJD', '', async () => debitParsed());
  const before = consumption(await getDb());
  assert.equal(before, 305 + 1234);
  const r = await previewBankStatement('QUJD', '', async () => combinedParsed());
  assert.equal(r.transactions.counts.similar, 3, '同帳戶同日同額＝疑似重複提醒');
  await applyBankStatement('QUJD', '', async () => combinedParsed(), { skipSimilar: true });
  assert.equal(consumption(await getDb()), before, '★照警語勾跳過＝不翻倍');
});

test('★A 區與 D 區筆數對不上：對不上的 A 區筆不記、對不上的 D 區刷卡列不留空（兩本帳都不會少算或多算）', async () => {
  await resetDb();
  const parsed = debitParsed((f) => { f.cardRows = [f.cardRows[0]]; });   // A 區只讀到一筆（305）；D 區兩筆刷卡
  const r = await previewBankStatement('QUJD', '', async () => parsed);
  assert.equal(r.cardLedger.count, 1);
  const rows = r.transactions.rows.filter((x) => x.summary === '刷卡消費');
  assert.deepEqual(rows.map((x) => [x.amount, x.category === '']), [[305, true], [1234, false]], '★305 留空（卡片會記）、1234 照舊分類（卡片沒記）');
  await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(consumption(await getDb()), 305 + 1234, '★兩筆各算一次');
  // 反向：A 區多一筆對不上 D 區＝不記
  await resetDb();
  const extra = debitParsed((f) => { f.cardRows.push({ postDate: '2026-01-15', date: '2026-01-14', amount: 777, fee: 0, lastFour: '8808', desc: '對不上的店', region: 'TW', extra: '' }); });
  const r2 = await previewBankStatement('QUJD', '', async () => extra);
  assert.equal(r2.cardLedger.notRecorded.unmatched, 1, '★對不上的那筆不記');
  assert.equal(r2.cardLedger.count, 2);
});

test('★同鍵群組裡一筆抄不完整＝整群不記，而且計數也整群（畫面不可低報沒記到卡片的筆數）', async () => {
  await resetDb();
  const parsed = debitParsed((f) => {
    f.transactions = [
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9390, note: '合成商店Ｂ' },
    ];
    f.accounts[0].balance = 9390;
    f.cardRows = [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '', region: 'TW', extra: '' },   // 店名空
    ];
  });
  const r = await previewBankStatement('QUJD', '', async () => parsed);
  assert.equal(r.cardLedger.count, 0, '整群不記');
  assert.equal(r.cardLedger.notRecorded.unreadable, 2, '★兩筆都算進「沒記」（不是只算壞的那一筆）');
  assert.ok(r.transactions.rows.every((x) => x.category), 'D 兩列都照舊分類');
});

test('★A 區某筆抄得不完整（店名空／含分段符／金額 0）：那筆不記、對應的 D 區列不留空（不可兩本帳都沒分類）', async () => {
  for (const bad of [{ desc: '' }, { desc: 'A|B' }, { amount: 0 }]) {
    await resetDb();
    const parsed = debitParsed((f) => { Object.assign(f.cardRows[0], bad); });
    const r = await previewBankStatement('QUJD', '', async () => parsed);
    const nr = r.cardLedger.notRecorded;
    assert.equal(nr.unreadable + nr.unmatched, 1, `★${JSON.stringify(bad)}：不記（金額 0 的對不上 D 區＝算 unmatched；其餘＝unreadable）`);
    assert.equal(r.cardLedger.count, 1, '另一筆照記');
    const row305 = r.transactions.rows.find((x) => x.amount === 305);
    assert.ok(row305.category, `★${JSON.stringify(bad)}：D 區那列照舊分類`);
  }
});

test('A 區讀不出來（版面壞、parser 丟 bank_unrecognized）：D 區照常匯、刷卡列照舊分類、cardLedger 帶原因', async () => {
  await resetDb();
  const parsed = debitParsed((f) => { f.cardRows = []; f.cardRowsError = '簽帳金融卡的刷卡消費明細有一列讀不出台幣金額（帳單版面可能與預期不同，請回報）'; });
  const r = await previewBankStatement('QUJD', '', async () => parsed);
  assert.match(r.cardLedger.error, /讀不出台幣金額/);
  assert.ok(r.transactions.rows.filter((x) => x.summary === '刷卡消費').every((x) => x.category));
  const a = await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(a.transactions.imported, 3);
  assert.match(a.cardLedger.error, /讀不出台幣金額/);
});

// ---------- 預審點名的空包彈 ----------
test('A 區走信用卡同一條管線：學過的店家分類要套（learnedCategories）、店名要清理', async () => {
  await resetDb();
  const db0 = await getDb();
  db0.learnedCategories = { '合成商店Ａ': { category: '娛樂', subcategory: '' } };
  await saveDb(db0);
  await applyBankStatement('QUJD', '', async () => debitParsed());
  const db = await getDb();
  const t = (db.transactions || []).find((/** @type {any} */ x) => x.ledger === 'card' && x.amount === 305);
  assert.equal(t.category, '娛樂', '★學過的店家分類要套到卡片帳本的列');
});

test('多張卡：同一份帳單兩個末四碼＝各建各的卡、各記各的', async () => {
  await resetDb();
  const parsed = debitParsed((f) => { f.cardRows[1].lastFour = '1234'; });
  const r = await previewBankStatement('QUJD', '', async () => parsed);
  assert.deepEqual(r.cardLedger.cards.map((c) => [c.lastFour, c.exists]), [['8808', false], ['1234', false]]);
  const a = await applyBankStatement('QUJD', '', async () => parsed);
  assert.deepEqual(a.cardLedger.cards.map((c) => [c.lastFour, c.created, c.imported]), [['8808', true, 1], ['1234', true, 1]]);
  const db = await getDb();
  assert.equal((db.cards || []).filter((/** @type {any} */ c) => c.type === 'debit').length, 2);
});

test('預覽：刷卡退貨的 D 區列留空時型別是 income（不是一律 expense）；卡片帳本列不寫 stmtDue；沒填發卡機構的簽帳卡也配得到', async () => {
  await resetDb();
  const parsed = debitParsed((f) => {
    f.transactions = [
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-30', summary: '刷卡退貨', direction: 'in', amount: 305, balance: 10000, note: '合成商店Ａ' },
    ];
    f.accounts[0].balance = 10000;
    f.cardRows = [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-30', date: '2026-01-29', amount: -305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
    ];
  });
  const db0 = await getDb();
  db0.cards = [{ id: 'noissuer', name: '沒寫銀行的金融卡', type: 'debit', lastFour: '8808' }];
  await saveDb(db0);
  const r = await previewBankStatement('QUJD', '', async () => parsed);
  assert.deepEqual(r.transactions.rows.map((x) => [x.summary, x.type, x.category]), [['刷卡消費', 'expense', ''], ['刷卡退貨', 'income', '']], '★預覽的退貨列是 income');
  assert.equal(r.cardLedger.cards[0].cardId, 'noissuer', '★發卡機構缺席＝配得到');
  await applyBankStatement('QUJD', '', async () => parsed);
  const db = await getDb();
  assert.ok((db.transactions || []).filter((/** @type {any} */ t) => t.ledger === 'card').every((/** @type {any} */ t) => !Object.hasOwn(t, 'stmtDue')), '★不寫 stmtDue（批次列表才顯示「—」而不是 0）');
});

test('★國外交易服務費另立一筆（William 2026-08-23 拍板）：主筆金額照帳單、服務費記「店名 國外交易服務費」；0 不多記；重匯全重複；刪銀行批次一起走（null／負值另有專題）', async () => {
  await resetDb();
  const parsed = debitParsed((f) => {
    f.cardRows[0].fee = 15;                      // 合成商店Ａ 305＋服務費 15
    f.cardRows[1].fee = 0;                       // 0＝不多記
  });
  const r = await previewBankStatement('QUJD', '', async () => parsed);
  assert.equal(r.cardLedger.count, 3, '★兩筆主筆＋一筆服務費');
  const a = await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(a.cardLedger.imported, 3);
  const db = await getDb();
  const ledger = db.transactions.filter((t) => t.source === 'stmt');
  assert.equal(ledger.length, 3);
  const fee = ledger.find((t) => /國外交易服務費/.test(String(t.store || t.note || '')));
  assert.ok(fee, `★服務費那筆存在（實得 ${JSON.stringify(ledger.map((t) => [t.store || t.note, t.amount]))}）`);
  assert.equal(fee.amount, 15);
  assert.match(String(fee.note || fee.store || ''), /合成商店Ａ/, '★服務費筆帶店名（查帳認得出是哪筆消費的、也是 stmtRef 的去重身分）');
  assert.equal(fee.date, '2026-01-27', '消費日與主筆同一天');
  assert.ok(fee.bankBatch, '★生命週期跟著銀行帳單（bankBatch 蓋上＝刪批次一起走、單獨刪擋下）');
  const main = ledger.find((t) => t.amount === 305);
  assert.equal(main.amount, 305, '★主筆金額照帳單原樣（不含服務費）');
  assert.equal(ledger.filter((t) => /國外交易服務費/.test(String(t.store || t.note || ''))).length, 1, '★fee 0 的那筆不多記');
  // 消費視角：總額＝兩筆相加
  const spend = ledger.reduce((s, t) => s + t.amount, 0);
  assert.equal(spend, 305 + 15 + 1234);
  // 重匯＝全重複（stmtRef 帶 desc＝服務費那筆自己有身分）
  const r2 = await previewBankStatement('QUJD', '', async () => parsed);
  assert.equal(r2.cardLedger.duplicate, 3, '★三筆全認出重複');
  // 刪銀行批次＝服務費那筆一起走
  const batches = await listBankBatches();
  await deleteBankBatch(batches[0].batchId);
  const db2 = await getDb();
  assert.equal(db2.transactions.filter((t) => t.source === 'stmt').length, 0, '★卡片帳本（含服務費筆）清空');
});

test('★服務費邊界各自成題（r1#1）：null／缺欄不多記；負值（退款的服務費退回）照記負筆', async () => {
  await resetDb();
  const pNull = debitParsed((f) => { f.cardRows[0].fee = null; delete f.cardRows[1].fee; });
  const rNull = await previewBankStatement('QUJD', '', async () => pNull);
  assert.equal(rNull.cardLedger.count, 2, '★null／缺欄都不多記');
  await resetDb();
  const pNeg = debitParsed((f) => {
    f.cardRows[0].fee = 15;
    // 退款列：金額負、服務費也負（退回）
    f.cardRows[1] = { ...f.cardRows[1], amount: -1234, fee: -15 };
    f.transactions[2] = { ...f.transactions[2], summary: '刷卡退貨', direction: 'in', amount: 1234, balance: 11929 };
    f.accounts[0].balance = 11929;
  });
  const rNeg = await previewBankStatement('QUJD', '', async () => pNeg);
  assert.equal(rNeg.cardLedger.count, 4, `★兩主筆＋兩服務費（實得 ${JSON.stringify(rNeg.cardLedger)}）`);
  await applyBankStatement('QUJD', '', async () => pNeg);
  const db = await getDb();
  const ledger = db.transactions.filter((t) => t.source === 'stmt');
  const feeRows = ledger.filter((t) => /國外交易服務費/.test(String(t.note || t.store || '')));
  assert.deepEqual(feeRows.map((t) => t.amount).sort((a, b) => a - b), [-15, 15], '★負值服務費照記');
  const neg = feeRows.find((t) => t.amount === -15);
  assert.match(String(neg.note || neg.store || ''), /合成商店Ｂ/, '★退回筆帶店名');
  assert.ok(new Set(ledger.map((t) => t.stmtRef)).size === ledger.length, 'stmtRef 各自唯一');
});

test('★部分重匯：庫裡只剩服務費那筆時，重匯補回主筆、服務費跳過（stmtRef 各自身分）；同店同日同額兩筆各帶費＝#2 序號分得開', async () => {
  await resetDb();
  const parsed = debitParsed((f) => { f.cardRows[0].fee = 15; });
  await applyBankStatement('QUJD', '', async () => parsed);
  let db = await getDb();
  const feeRef = db.transactions.find((t) => t.source === 'stmt' && /國外交易服務費/.test(String(t.note || t.store || ''))).stmtRef;
  db.transactions = db.transactions.filter((t) => t.source !== 'stmt' || /國外交易服務費/.test(String(t.note || t.store || '')));
  await saveDb(db);
  const r2 = await previewBankStatement('QUJD', '', async () => parsed);
  assert.equal(r2.cardLedger.duplicate, 1, '★只有服務費那筆算重複');
  assert.equal(r2.cardLedger.count, 3);
  const a2 = await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(a2.cardLedger.imported, 2, '★補回兩筆主筆');
  db = await getDb();
  assert.equal(db.transactions.filter((t) => t.source === 'stmt').length, 3);
  assert.equal(db.transactions.filter((t) => t.stmtRef === feeRef).length, 1, '★服務費沒被重複記');
  // 同鍵兩筆各帶費＝#2 序號
  await resetDb();
  const twin = debitParsed((f) => {
    f.cardRows = [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 100, fee: 15, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-28', date: '2026-01-27', amount: 100, fee: 15, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' },
    ];
    f.transactions = [
      { acctSuffix: '8791', acctMasked: '**********8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 100, balance: 9900, note: '合成商店Ａ' },
      { acctSuffix: '8791', acctMasked: '**********8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 100, balance: 9800, note: '合成商店Ａ' },
    ];
    f.accounts[0].balance = 9800;
  });
  await applyBankStatement('QUJD', '', async () => twin);
  const db2 = await getDb();
  const refs = db2.transactions.filter((t) => t.source === 'stmt').map((t) => String(t.stmtRef));
  assert.equal(refs.length, 4, `★兩主筆＋兩服務費（實得 ${JSON.stringify(refs)}）`);
  assert.equal(new Set(refs).size, 4, '★同鍵靠 #2 序號分得開');
  assert.equal(refs.filter((r) => r.endsWith('#2')).length, 2);
});

test('★部分重匯的批次歸屬（Codex #509 r2#1）：舊帳單已匯（沒有服務費那年代）、重匯補服務費＝服務費綁到「它 D 列所屬的舊批次」，不是沒有銀行列的新批次；刪舊批次零殘留', async () => {
  await resetDb();
  const old = debitParsed((f) => { f.cardRows[0].fee = 0; });
  await applyBankStatement('QUJD', '', async () => old);
  const before = await listBankBatches();
  assert.equal(before.length, 1);
  const oldBatch = before[0].batchId;
  // 升級路徑：同一份帳單、這次讀出服務費欄
  const upgraded = debitParsed((f) => { f.cardRows[0].fee = 15; });
  const a2 = await applyBankStatement('QUJD', '', async () => upgraded);
  assert.equal(a2.transactions.imported, 0, 'D 區全重複');
  assert.equal(a2.cardLedger.imported, 1, '只補服務費一筆');
  const db = await getDb();
  const fee = db.transactions.find((t) => t.source === 'stmt' && /國外交易服務費/.test(String(t.note || t.store || '')));
  assert.equal(fee.bankBatch, oldBatch, `★綁舊批次（實得 ${fee.bankBatch}、舊批次 ${oldBatch}）`);
  const after = await listBankBatches();
  assert.equal(after.length, 1, '★沒有多出一個空批次');
  assert.equal(after[0].cardCount, 3, `★卡片列三筆都算在同一批（實得 ${JSON.stringify(after)}）`);
  await deleteBankBatch(oldBatch);
  const db2 = await getDb();
  assert.equal(db2.transactions.filter((t) => t.source === 'stmt').length, 0, '★刪舊批次＝服務費一起走、零殘留');
  assert.equal(db2.transactions.filter((t) => t.source === 'bank').length, 0);
});

test('★服務費繼承主筆學過的最終分類（Codex #509 r2#2）：學過「合成商店Ａ→娛樂/遊戲」＝主筆與服務費都歸娛樂；consumptionByMonth 直接驗、其他不落 15', async () => {
  await resetDb();
  const db0 = await getDb();
  db0.learnedCategories = { '合成商店Ａ': { category: '娛樂', subcategory: '遊戲' } };   // 娛樂/遊戲＝內建分類樹既有
  await saveDb(db0);
  const parsed = debitParsed((f) => { f.cardRows[0].fee = 15; });
  await applyBankStatement('QUJD', '', async () => parsed);   // 建卡路徑＝匯入端會用真卡 id 重算列＋重做繼承（兩個繼承點都吃到）
  const db = await getDb();
  const fee = db.transactions.find((t) => t.source === 'stmt' && /國外交易服務費/.test(String(t.note || t.store || '')));
  assert.equal(fee.category, '娛樂');
  assert.equal(fee.subcategory, '遊戲');
  const cons = consumptionByMonth(db).byMonth['2026-01'] || {};
  assert.equal(Number(cons['娛樂']?.total || 0), 305 + 15, `★消費分析正式路徑：娛樂＝320（實得 ${JSON.stringify(cons)}）`);
  assert.equal(Number(cons['其他']?.total || 0), 1234, '★其他只有合成商店Ｂ那筆＝服務費 15 沒有落進來');
  // exists 路徑（卡已存在＝不重算列、直接用 plan 的列）：刪批次留卡、重匯＝繼承同樣成立
  const batches = await listBankBatches();
  await deleteBankBatch(batches[0].batchId);
  const dbMid = await getDb();
  assert.equal(dbMid.cards.length, 1, '前提：卡留著');
  await applyBankStatement('QUJD', '', async () => parsed);
  const db2 = await getDb();
  const fee2 = db2.transactions.find((t) => t.source === 'stmt' && /國外交易服務費/.test(String(t.note || t.store || '')));
  assert.equal(fee2.category, '娛樂', '★exists 路徑也繼承');
  assert.equal(fee2.subcategory, '遊戲');
});

test('★混批次的部分重匯：一半 D 列在舊批次、一半新匯＝各卡片列綁各自 D 列的批次（重複列不佔序）', async () => {
  await resetDb();
  const short = debitParsed((f) => {
    f.cardRows = [f.cardRows[0]];
    f.transactions = [f.transactions[0]];
    f.accounts[0].balance = 9695;
  });
  await applyBankStatement('QUJD', '', async () => short);
  const oldBatch = (await listBankBatches())[0].batchId;
  const full = debitParsed();
  const a2 = await applyBankStatement('QUJD', '', async () => full);
  assert.equal(a2.transactions.imported, 2, 'D1 重複、D2/D3 新匯');
  assert.equal(a2.cardLedger.imported, 1, '卡片只補 1234 那筆');
  const db = await getDb();
  const batches = await listBankBatches();
  assert.equal(batches.length, 2);
  const newBatch = batches.map((b) => b.batchId).find((id) => id !== oldBatch);
  const main1 = db.transactions.find((t) => t.source === 'stmt' && t.amount === 305);
  const main2 = db.transactions.find((t) => t.source === 'stmt' && t.amount === 1234);
  assert.equal(main1.bankBatch, oldBatch, '★305 綁舊批次（它的 D 列在舊批）');
  assert.equal(main2.bankBatch, newBatch, `★1234 綁新批次（重複列不佔 written 序；實得 ${main2.bankBatch}、新批 ${newBatch}）`);
  await deleteBankBatch(oldBatch);
  const db2 = await getDb();
  assert.ok(db2.transactions.some((t) => t.stmtRef === main2.stmtRef), '刪舊批次不掃到新批的卡片列');
  await deleteBankBatch(newBatch);
  assert.equal((await getDb()).transactions.filter((t) => t.source === 'stmt').length, 0, '零殘留');
});

test('★fail-closed 可達路徑（Codex #509 r3#1）：庫裡有「空分類的攣生 D 列」＋預設跳過疑似重複＝D 被跳過、卡片整筆（含服務費）不記、不建卡、計入對不上', async () => {
  await resetDb();
  const db0 = await getDb();
  db0.transactions = [{
    id: 'twin', ledger: 'cashflow', source: 'bank', date: '2026-01-28', type: 'expense', category: '', subcategory: '',
    amount: 305, account: '別版面匯的', note: '刷卡消費', dir: 'out',
    bankRef: 'bank|**********8791|2026-01-28|out|305|9695|金融卡消費|別版面原文', bankSummary: '金融卡消費', bankNote: '別版面原文',
  }];
  await saveDb(db0);
  const parsed = debitParsed((f) => {
    f.cardRows = [f.cardRows[0]];
    f.cardRows[0].fee = 15;
    f.transactions = [f.transactions[0]];
    f.accounts[0].balance = 9695;
  });
  const a = await applyBankStatement('QUJD', '', async () => parsed, { skipSimilar: true });
  assert.equal(a.transactions.similarSkipped, 1, `前提：D 列被當疑似重複跳過（實得 ${JSON.stringify(a.transactions)}）`);
  assert.equal(a.cardLedger.imported, 0, '★卡片一筆都不記');
  assert.equal(a.cardLedger.notRecorded.unmatched, 2, `★主筆＋服務費都計入對不上（實得 ${JSON.stringify(a.cardLedger.notRecorded)}）`);
  const db = await getDb();
  assert.equal(db.transactions.filter((t) => t.source === 'stmt').length, 0, '★零 stmt 列（記了＝沒有 bankBatch 的孤兒）');
  assert.equal((db.cards || []).length, 0, '★不建卡');
});

test('★祖父去重鍵的 D 列也走服務費升級路徑（Codex #509 r4#1）：舊鍵 bank|末碼|… 的空分類 D 列＝去重認得、批次也查得到＝主筆＋服務費綁舊批、刪批零殘留', async () => {
  await resetDb();
  const db0 = await getDb();
  db0.transactions = [{
    id: 'legacy', ledger: 'cashflow', source: 'bank', date: '2026-01-28', type: 'expense', category: '', subcategory: '',
    amount: 305, account: '祖父時代匯的', note: '刷卡消費', dir: 'out', importBatch: 'legacy-batch', importedAt: '2026-02-01T00:00:00.000Z',
    bankRef: 'bank|8791|2026-01-28|out|305|9695|刷卡消費|合成商店Ａ', bankSummary: '刷卡消費', bankNote: '合成商店Ａ',
  }];
  await saveDb(db0);
  const parsed = debitParsed((f) => {
    f.cardRows = [f.cardRows[0]];
    f.cardRows[0].fee = 15;
    f.transactions = [{ ...f.transactions[0], note: '合成商店Ａ' }];
    f.accounts[0].balance = 9695;
  });
  const a = await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(a.transactions.skipped, 1, `前提：祖父鍵被去重認出（實得 ${JSON.stringify(a.transactions)}）`);
  assert.equal(a.cardLedger.imported, 2, `★主筆＋服務費都補進卡片帳本（實得 ${JSON.stringify(a.cardLedger)}）`);
  const db = await getDb();
  const stmt = db.transactions.filter((t) => t.source === 'stmt');
  assert.deepEqual(stmt.map((t) => t.bankBatch), ['legacy-batch', 'legacy-batch'], '★都綁祖父列的批次');
  await deleteBankBatch('legacy-batch');
  const db2 = await getDb();
  assert.equal(db2.transactions.length, 0, '★刪祖父批次＝零殘留');
});

test('★同鍵歧義群跨舊新批次＝整群不記、也不留空（Codex #509 r5#1）：不按列印順序猜批次；單批的同鍵群照常記', async () => {
  await resetDb();
  // 舊批：「B 那筆」的 D 列＋它的 A 區卡片筆（＝D 留空、卡片主筆已記；去重鍵與新帳單的第二列 D 完全相同）
  const short = debitParsed((f) => {
    f.cardRows = [{ postDate: '2026-01-28', date: '2026-01-27', amount: 100, fee: 0, lastFour: '8808', desc: '店Ｂ', region: 'TW', extra: '' }];
    f.transactions = [{ acctSuffix: '8791', acctMasked: '**********8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 100, balance: 9900, note: '店Ｂ' }];
    f.accounts[0].balance = 9900;
  });
  await applyBankStatement('QUJD', '', async () => short);
  const oldBatch = (await listBankBatches())[0].batchId;
  // 新帳單：同鍵（同扣款日同額）兩筆——A 新匯、B 是舊批的重複；A 區順序 A→B、D 區順序 B→A（順序故意反）
  const full = debitParsed((f) => {
    f.cardRows = [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 100, fee: 15, lastFour: '8808', desc: '店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-28', date: '2026-01-27', amount: 100, fee: 15, lastFour: '8808', desc: '店Ｂ', region: 'TW', extra: '' },
    ];
    f.transactions = [
      { acctSuffix: '8791', acctMasked: '**********8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 100, balance: 9900, note: '店Ｂ' },
      { acctSuffix: '8791', acctMasked: '**********8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 100, balance: 9800, note: '店Ａ' },
    ];
    f.accounts[0].balance = 9800;
  });
  const a = await applyBankStatement('QUJD', '', async () => full);
  assert.equal(a.transactions.skipped, 1, `前提：B 的 D 列是舊批重複（實得 ${JSON.stringify(a.transactions)}）`);
  assert.equal(a.cardLedger.imported, 0, '★跨批的同鍵群整群不記');
  assert.equal(a.cardLedger.notRecorded.unmatched, 2, `★整群計入對不上（實得 ${JSON.stringify(a.cardLedger.notRecorded)}）`);
  const db = await getDb();
  assert.deepEqual(db.transactions.filter((t) => t.source === 'stmt').map((t) => [t.note || '', t.amount]), [['店Ｂ', 100]], '★只剩舊批那筆卡片主筆——A 的主筆／兩筆服務費都沒被亂綁進來');
  const newD = db.transactions.find((t) => t.source === 'bank' && t.bankNote === '店Ａ');
  assert.notEqual(newD.category, '', '★不留空（不記就不留空——錢不可從消費視角消失）');
  await deleteBankBatch(oldBatch);
  const db2 = await getDb();
  assert.equal(db2.transactions.filter((t) => t.source === 'bank').length, 1, '刪舊批不掃到新批的 D 列');
  assert.equal(db2.transactions.filter((t) => t.source === 'stmt').length, 0, '刪舊批把它的卡片主筆帶走、零殘留');
});

test('★超限 fee 在計畫層就擋（Codex #509 r5#2）：整群 unreadable、D 不留空、預覽＝套用；別群不受影響、批次不錯綁', async () => {
  await resetDb();
  const parsed = debitParsed((f) => { f.cardRows[0].fee = 100000001; });
  const r = await previewBankStatement('QUJD', '', async () => parsed);
  assert.equal(r.cardLedger.count, 1, `★超限那群（主筆＋費）整群不進 count、只剩 1234 那筆（實得 ${JSON.stringify(r.cardLedger)}）`);
  assert.equal(r.cardLedger.notRecorded.unreadable, 1, '★計入抄不完整');
  const a = await applyBankStatement('QUJD', '', async () => parsed);
  assert.equal(a.cardLedger.imported, 1, '★套用＝預覽（沒有寫入層才略過的分家）');
  const db = await getDb();
  const stmt = db.transactions.filter((t) => t.source === 'stmt');
  assert.deepEqual(stmt.map((t) => t.amount), [1234]);
  const newBatch = (await listBankBatches())[0].batchId;
  assert.equal(stmt[0].bankBatch, newBatch, '★1234 綁對自己的批次（沒被錯位）');
  const d305 = db.transactions.find((t) => t.source === 'bank' && t.amount === 305);
  assert.notEqual(d305.category, '', '★超限那群的 D 不留空');
});

test('★無批次的舊 D 列（批次制之前匯的）＝生命週期沒有家（Codex #509 r6#1）：同鍵群含它＝整群不記、兩筆 D 都不留空；單筆對上它也不記', async () => {
  await resetDb();
  const db0 = await getDb();
  db0.transactions = [{
    id: 'preBatch', ledger: 'cashflow', source: 'bank', date: '2026-01-28', type: 'expense', category: '', subcategory: '',
    amount: 100, account: '批次制之前匯的', note: '刷卡消費', dir: 'out',
    bankRef: 'bank|**********8791|2026-01-28|out|100|9900|刷卡消費|店Ｂ', bankSummary: '刷卡消費', bankNote: '店Ｂ',
  }];
  await saveDb(db0);
  // 同鍵兩筆：店Ｂ＝那筆無批次舊列的重複、店Ａ＝新；A 區 fee 各不同、D 順序反轉
  const full = debitParsed((f) => {
    f.cardRows = [
      { postDate: '2026-01-28', date: '2026-01-27', amount: 100, fee: 15, lastFour: '8808', desc: '店Ａ', region: 'TW', extra: '' },
      { postDate: '2026-01-28', date: '2026-01-27', amount: 100, fee: 25, lastFour: '8808', desc: '店Ｂ', region: 'TW', extra: '' },
    ];
    f.transactions = [
      { acctSuffix: '8791', acctMasked: '**********8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 100, balance: 9900, note: '店Ｂ' },
      { acctSuffix: '8791', acctMasked: '**********8791', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 100, balance: 9800, note: '店Ａ' },
    ];
    f.accounts[0].balance = 9800;
  });
  const r = await previewBankStatement('QUJD', '', async () => full);
  assert.equal(r.cardLedger.count, 0, `★預覽就整群不記（實得 ${JSON.stringify(r.cardLedger)}）`);
  assert.equal(r.cardLedger.notRecorded.unmatched, 2);
  const a = await applyBankStatement('QUJD', '', async () => full);
  assert.equal(a.cardLedger.imported, 0, '★套用＝預覽');
  const db = await getDb();
  assert.equal(db.transactions.filter((t) => t.source === 'stmt').length, 0, '★零卡片列（不錯綁任何批次）');
  for (const t of db.transactions.filter((x) => x.source === 'bank' && x.id !== 'preBatch')) {
    assert.notEqual(t.category, '', `★新匯的 D 不留空（${t.bankNote}）`);
  }
  const newBatch = (await listBankBatches()).find((b) => b.cardCount === 0);
  assert.ok(newBatch, '新批次沒有連帶卡片列');
  await deleteBankBatch(newBatch.batchId);
  const db2 = await getDb();
  assert.ok(db2.transactions.some((t) => t.id === 'preBatch'), '刪新批不掃到無批次舊列');
  assert.equal(db2.transactions.filter((t) => t.source === 'stmt').length, 0, '零殘缺生命週期');
  // 單筆（非同鍵群）對上無批次舊列＝同樣不記、不留空
  await resetDb();
  const db3 = await getDb();
  db3.transactions = [{
    id: 'preBatch2', ledger: 'cashflow', source: 'bank', date: '2026-01-28', type: 'expense', category: '', subcategory: '',
    amount: 305, account: '批次制之前匯的', note: '刷卡消費', dir: 'out',
    bankRef: 'bank|**********8791|2026-01-28|out|305|9695|刷卡消費|合成商店Ａ', bankSummary: '刷卡消費', bankNote: '合成商店Ａ',
  }];
  await saveDb(db3);
  const single = debitParsed((f) => {
    f.cardRows = [{ ...f.cardRows[0], fee: 15 }];
    f.transactions = [{ ...f.transactions[0], note: '合成商店Ａ' }];
    f.accounts[0].balance = 9695;
  });
  const a2 = await applyBankStatement('QUJD', '', async () => single);
  assert.equal(a2.cardLedger.imported, 0, `★單筆也不記（實得 ${JSON.stringify(a2.cardLedger)}）`);
  assert.equal(a2.cardLedger.notRecorded.unmatched, 1);
  assert.equal((await getDb()).transactions.filter((t) => t.source === 'stmt').length, 0);
});

test('編輯窗的「帳戶／卡片」下拉收簽帳金融卡（#503 待辦 A2）：形狀釘（transactions.js 是頁面模組、載不進 node——弱考題，守的是拼字；行為由「保留現值 unshift」既有機制兜底）', () => {
  const src = readFileSync(new URL('../public/modules/transactions.js', import.meta.url), 'utf8');
  assert.match(src, /\['credit', 'debit'\]\.includes\(c\.type \|\| 'credit'\)/, '★簽帳卡也在下拉（會員卡仍不收）');
  assert.match(src, /label: '信用卡／簽帳卡'/, '欄位名不再只寫信用卡');
  assert.ok(!/c\.type \|\| 'credit'\) === 'credit'/.test(src.split('accountOptions')[1].slice(0, 400)), '舊的二元判準已移除');
});
