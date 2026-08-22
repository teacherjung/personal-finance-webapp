// @ts-check
// Stage 2（使用者定 2026-08-22）：帳單原文的「摘要」與「備註」**各自**存進帳本（bankSummary／bankNote）。
// 為什麼要存：交易上的 `note` 是**顯示用**的組合結果（收支說明過濾器的好讀版，或使用者自己取的名字），
// 一旦改寫就回不到原文；在這之前，唯一的原文留底是去重鍵 `bankRef` 的尾兩段——而那要靠切 `|` 反解，
// 備註以 `#數字` 結尾（會被當成批內出現序剝掉）或摘要自己含 `|`（切點錯位）就還原不出原文。
// 這份考題釘四件事：①匯入把原文一字不改地存下來，且**去重鍵格式一個位元組沒動**（動了＝重匯同帳單
// 認不出重複＝現金流翻倍）②顯示層讀的是原文欄、不是反解 ③舊資料照舊走反解、**不回填**
// ④備註是空字串時不可掉回反解（型別判定 typeof 'string'，不是 truthy）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-bank-rawtext-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { importBankTxToDb, reconcileAccountNamesAuto } = await import('../lib/services/bank-import.js');
const { FIELD_SCHEMA, LONG_TEXT_FIELDS, lengthErrorOf, sanitizeDbForWrite } = await import('../lib/schema.js');
const { getDb, saveDb } = await import('../lib/repo.js');

after(() => {
  for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ }
  }
});

const btx = (/** @type {any} */ o) => ({ acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-06-10', summary: '轉帳存入', direction: 'in', amount: 1000, balance: null, note: '', ...o });
const parsed = (/** @type {any[]} */ txns) => ({ accounts: [], accountCurrency: { '900100****3301': 'TWD' }, transactions: txns });
const baseDb = () => ({ transactions: [], accounts: [{ id: 'a', name: '台新 3301', type: 'cash', currency: 'TWD', accountNo: '900100****3301' }], learnedBank: {}, settings: {} });

// ---------- ① 匯入：原文一字不改地留底 ----------
test('匯入：摘要與備註各自原樣存下（含反解會弄丟的 #數字結尾），去重鍵格式一個位元組沒動', () => {
  const db = baseDb();
  const summary = '轉帳支取';
  const note = '轉入288810****8791 養育費#2';   // 結尾 #2＝反解會當成「批內出現序」剝掉的那種備註
  importBankTxToDb(db, parsed([btx({ summary, note, direction: 'out', amount: 5000 })]));
  const t = /** @type {any} */ (db.transactions.at(-1));
  assert.equal(t.bankSummary, summary, '摘要原文原樣');
  assert.equal(t.bankNote, note, '備註原文原樣（#2 不可被吃掉）');
  // 去重鍵＝祖父條款，格式不可變（台新照舊 bank|完整遮罩帳號|日期|方向|金額|餘額|摘要|備註）
  assert.equal(t.bankRef, `bank|900100****3301|2026-06-10|out|5000||${summary}|${note}`);
});

test('匯入：備註空白時存空字串（不是 undefined）——顯示層才不會以為「沒有原文」而掉回反解', () => {
  const db = baseDb();
  importBankTxToDb(db, parsed([btx({ summary: '存款息', note: '', direction: 'in', amount: 23 })]));
  const t = /** @type {any} */ (db.transactions.at(-1));
  assert.equal(t.bankSummary, '存款息');
  assert.equal(t.bankNote, '');
  assert.equal(typeof t.bankNote, 'string');
});

// ---------- ②③ 顯示層讀原文欄；舊資料照舊反解、不回填 ----------
test('顯示層：有原文欄的讀原文欄、沒有的才反解——同一筆資料兩種結果，證明讀的真的是欄位', async () => {
  const db = await getDb();
  db.accounts = [{ id: 'a1', name: '台新活儲（Richart）', type: 'cash', class: '現金', currency: 'TWD', balance: 0, accountNo: '288810123458791' }];
  const summary = '媒體轉入';
  const note = '基金配息群益主權#2';                                     // 反解會把 #2 當出現序剝掉
  const bankRef = `bank|288810****8791|2026-07-01|in|100|900|${summary}|${note}`;
  const row = (/** @type {string} */ id, /** @type {any} */ extra) => ({
    id, date: '2026-07-01', type: 'income', category: '被動', subcategory: '股息', amount: 100,
    account: '台新活儲（Richart）', note: '', ledger: 'cashflow', source: 'bank', dir: 'in', bankRef, ...extra,
  });
  db.transactions = [
    row('new', { bankSummary: summary, bankNote: note }),   // Stage 2 之後匯入的：有原文欄
    row('old', {}),                                          // Stage 2 之前匯入的：只有去重鍵
  ];
  await saveDb(db);
  await reconcileAccountNamesAuto();
  const fresh = await getDb();
  const tNew = /** @type {any} */ ((fresh.transactions || []).find((/** @type {any} */ t) => t.id === 'new'));
  const tOld = /** @type {any} */ ((fresh.transactions || []).find((/** @type {any} */ t) => t.id === 'old'));
  assert.equal(tNew.note, '現金轉入・基金配息群益主權#2', '有原文欄＝顯示得出完整原文');
  assert.equal(tOld.note, '現金轉入・基金配息群益主權', '沒有原文欄＝照舊反解（#2 被當出現序剝掉，這就是要存欄位的理由）');
  assert.notEqual(tNew.note, tOld.note, '兩者必須不同——相同就代表顯示層根本沒讀原文欄');
  // 舊資料不回填（使用者定）：原文只有帳單知道，拿反解結果冒充原文比誠實反解更糟
  assert.equal(Object.hasOwn(tOld, 'bankSummary'), false, '舊列不可被偷偷補上原文欄');
  assert.equal(Object.hasOwn(tOld, 'bankNote'), false);
});

// ---------- ④ 空備註不掉回反解 ----------
test('備註空白：顯示只剩摘要——不可拿去重鍵裡的字冒充原文', async () => {
  const db = await getDb();
  db.accounts = [];
  db.transactions = [{
    id: 'e1', date: '2026-07-02', type: 'income', category: '被動', subcategory: '利息', amount: 23,
    account: '台新 3301', note: '', ledger: 'cashflow', source: 'bank', dir: 'in',
    bankSummary: '存款息', bankNote: '',
    // 去重鍵裡的備註段刻意放一段不同的字：讀對欄位就看不到它
    bankRef: 'bank|900100****3301|2026-07-02|in|23||存款息|不是原文的備註',
  }];
  await saveDb(db);
  await reconcileAccountNamesAuto();
  const t = /** @type {any} */ (((await getDb()).transactions || [])[0]);
  assert.equal(t.note, '存款利息', '空備註＝只顯示摘要');
  assert.ok(!t.note.includes('不是原文'), '不可掉回反解');
});

test('探針：兩欄都是空字串＝原文真的是空的，仍不可掉回反解（判定是「欄位存在」，不是「有沒有值」）', async () => {
  // ⚠️ 這是**探針考題**、不是真實資料形狀（真實列的原文欄與去重鍵尾兩段本來就一致）：
  //    它存在的唯一理由是釘住 bankRawText 的判定寫法——把 typeof 改寫成 truthy 就只有這一格會紅。
  const db = await getDb();
  db.accounts = [];
  db.transactions = [{
    id: 'z1', date: '2026-07-03', type: 'income', category: '被動', subcategory: '利息', amount: 5,
    account: '台新 3301', note: '', ledger: 'cashflow', source: 'bank', dir: 'in',
    bankSummary: '', bankNote: '',
    bankRef: 'bank|900100****3301|2026-07-03|in|5||存款息|不是原文的備註',
  }];
  await saveDb(db);
  await reconcileAccountNamesAuto();
  const t = /** @type {any} */ (((await getDb()).transactions || [])[0]);
  assert.equal(t.note, '', '原文是空的就顯示空的，不可從去重鍵撿字回來');
});

// ---------- 登記：型別與長度 ----------
test('登記：兩欄進 FIELD_SCHEMA（壞型別被剝除）與長內容名單（匯入原文不被短欄位上限誤傷）', () => {
  assert.equal(FIELD_SCHEMA.transactions.bankSummary, 'str');
  assert.equal(FIELD_SCHEMA.transactions.bankNote, 'str');
  assert.ok(LONG_TEXT_FIELDS.transactions.includes('bankSummary'));
  assert.ok(LONG_TEXT_FIELDS.transactions.includes('bankNote'));
  assert.equal(lengthErrorOf('transactions', 'bankNote', 'x'.repeat(300)), null, '300 字的備註不可被 200 字短上限擋下');
  const cleaned = sanitizeDbForWrite({ settings: {}, transactions: [{ id: 't', date: '2026-06-01', type: 'expense', category: 'x', amount: 1, bankSummary: 123, bankNote: '好的' }] }, { mode: 'strip' });
  const t = /** @type {any} */ (cleaned.transactions[0]);
  assert.equal(Object.hasOwn(t, 'bankSummary'), false, '非字串的原文欄要被剝掉（留著會讓顯示層拿數字當原文）');
  assert.equal(t.bankNote, '好的');
});
