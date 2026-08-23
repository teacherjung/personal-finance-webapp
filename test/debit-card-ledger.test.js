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

const { previewBankStatement, applyBankStatement } = await import('../lib/services/bank-import.js');
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
  assert.deepEqual(r.cardLedger, { cards: [], count: 0, duplicate: 0 });
  assert.ok(r.transactions.rows.filter((x) => x.summary === '刷卡消費').every((x) => x.category), '★沒有 A 區＝刷卡列要有分類（否則消費分析少算）');
  const a = await applyBankStatement('QUJD', '', async () => debitParsed((f) => { f.cardRows = []; }));
  assert.deepEqual(a.cardLedger, { cards: [], imported: 0, skipped: 0 });
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
  for (const must of ['刷卡消費明細', '17 筆', '台新簽帳金融卡 8808', '會新建這張卡', '2 筆之前記過', '不再分類', '不會算兩次']) assert.ok(s.includes(must), `★缺「${must}」：${s}`);
  assert.ok(!bankCardLedgerNote({ cards: [{ name: 'X', exists: true }], count: 3, duplicate: 0 }).includes('新建'), '卡已存在＝不說新建');
  assert.ok(bankCardLedgerNote({ cards: [{ name: 'X', exists: true }], count: 3, duplicate: 3 }).includes('全部都記過了'), '全重複＝要說這次不會再記');
  // 完成句：掛在既有的 bankApplyDoneText 後面，照既有口吻
  const done = bankApplyDoneText({ updated: 1, created: 0, skipped: 0, cardLedger: { cards: [{ name: '台新簽帳金融卡 8808', created: true, imported: 17, skipped: 0 }], imported: 17, skipped: 0 } }, { imported: 48, skipped: 0 }, null);
  assert.ok(done.includes('刷卡消費明細：「台新簽帳金融卡 8808」（新建） 17 筆'), `★完成句要講卡片帳本那一段：${done}`);
  assert.equal(bankCardLedgerDoneText({ cards: [], imported: 0, skipped: 0 }), '', '沒有＝不多講');
  assert.ok(bankCardLedgerDoneText({ cards: [{ name: 'X', created: false, imported: 0, skipped: 5 }] }).includes('略過重複 5'));
});

test('預覽窗真的接上那一句（cashflow.js 樣板走 bankCardLedgerNote、有 cardLedger 才畫）', () => {
  const src = readFileSync(new URL('../public/modules/cashflow.js', import.meta.url), 'utf8');
  assert.match(src, /bankCardLedgerNote\(\/\*\* @type \{any\} \*\/ \(r\)\.cardLedger\)/, '★樣板要呼叫 bankCardLedgerNote(r.cardLedger)');
  assert.match(src, /bankCardLedgerNote[^\n]*from '\.\/cashflow-model\.js'/, '從 cashflow-model 匯入，不手寫第二份');
});
