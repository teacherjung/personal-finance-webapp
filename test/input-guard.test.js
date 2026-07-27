// 異常輸入防線（階段四 B，裁決 2026-07-24／William 2026-07-27 定不降級）考題。
// 規格四句話：短欄位合理上限（200）；長內容極寬鬆技術上限（20000）＝不干涉正常寫作；
// 超過＝CRUD 明確 400 點名、**絕不靜默截斷**；匯入內容與合法舊資料**不可被誤傷**（還原路放行）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWritable, validateImportItem, sanitizeDbForWrite, lengthErrorOf, LEN_SHORT, LEN_LONG } from '../lib/schema.js';

const short = (n) => 'x'.repeat(n);
const emptyish = () => ({ settings: { currency: 'TWD' } });

test('短欄位：200 字整＝放行（邊界）、201 字＝400 點名（含上限與實際長度）', () => {
  const ok = pickWritable('accounts', { name: short(LEN_SHORT), type: 'cash' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.name.length, LEN_SHORT);
  const bad = pickWritable('accounts', { name: short(LEN_SHORT + 1), type: 'cash' });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /name/, '要點名欄位');
  assert.match(bad.errors[0], /200/, '要講上限');
  assert.match(bad.errors[0], /201/, '要講實際長度（使用者才知道差多少）');
  assert.ok(!('name' in bad.value), '超長值絕不可寫入（也絕不可截斷後寫入）');
});

test('長內容：19,999 字論點＝放行（不干涉正常寫作）、20,001 字＝400', () => {
  const ok = pickWritable('transactions', { note: short(LEN_LONG) });
  assert.deepEqual(ok.errors, []);
  const bad = pickWritable('transactions', { note: short(LEN_LONG + 1) });
  assert.match(bad.errors[0], /note.*20000/);
  // research 頂層寫作欄同級
  assert.deepEqual(pickWritable('research', { symbol: 'AAPL', thesis: short(15000) }).errors, []);
  assert.match(pickWritable('research', { symbol: 'AAPL', thesis: short(LEN_LONG + 1) }).errors[0], /thesis/);
});

test('研究巢狀：寫作欄（reasons/text/note）長級、識別欄（label）短級', () => {
  const okDeep = pickWritable('research', {
    symbol: 'AAPL',
    scorecard: { reasons: { business: short(5000) } },
    catalysts: [{ id: 'c1', text: short(3000) }],
    checkpoints: [{ date: '2026-07-01', note: short(3000) }],
  });
  assert.deepEqual(okDeep.errors, []);
  const badLabel = pickWritable('research', { symbol: 'AAPL', sources: [{ label: short(300), url: 'https://x.com' }] });
  // sources.label 超 200 → 巢狀 errors 點名路徑
  assert.ok(badLabel.errors.some(e => e.includes('label')), JSON.stringify(badLabel.errors));
  const badDeep = pickWritable('research', { symbol: 'AAPL', scorecard: { reasons: { business: short(LEN_LONG + 1) } } });
  assert.ok(badDeep.errors.some(e => e.includes('reasons')), '巢狀寫作欄超過技術上限也要擋');
});

test('匯入（備份還原路）：超長舊資料**放行**——合法舊資料不可因升級被刪', () => {
  // 防線上線前寫入的超長欄位，備份還原時必須回得來（#201 的 >1MB 考題釘 body 分流、這題釘欄位層）
  const r = validateImportItem('transactions', { id: 't1', date: '2026-07-01', amount: 100, note: short(LEN_LONG * 2) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.item.note.length, LEN_LONG * 2, '一字不動、不剝不截');
  // 超長舊研究（巢狀）也一樣
  const res = validateImportItem('research', { id: 'r1', symbol: 'AAPL', thesis: short(LEN_LONG * 2), scorecard: { reasons: { business: short(LEN_LONG + 5) } } });
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
});

test('櫃檯：兩種模式對超長都只 warn 放行、不 throw 不剝不截（還原不可變 500）', () => {
  for (const mode of ['throw', 'strip']) {
    const db = { ...emptyish(), transactions: [{ id: 't1', date: '2026-07-01', amount: 100, note: short(LEN_LONG + 100) }] };
    const out = sanitizeDbForWrite(db, { mode: /** @type {any} */ (mode) });
    assert.equal(out.transactions[0].note.length, LEN_LONG + 100, `${mode} 模式：原樣保留`);
  }
});

test('匯入內容不被一般表單上限誤傷：stmtRef／bankRef／autoNote 在長級名單', () => {
  const r = pickWritable('transactions', { note: short(1000) });   // note 長級
  assert.deepEqual(r.errors, []);
  // stmtRef 不在 CRUD 白名單（服務層欄位）——驗 lengthErrorOf 本身的分級
  assert.equal(lengthErrorOf('transactions', 'stmtRef', short(5000)), null, '帳單原文（含去重序號）給技術上限');
  assert.equal(lengthErrorOf('transactions', 'bankRef', short(5000)), null);
  assert.equal(lengthErrorOf('transactions', 'autoNote', short(5000)), null);
  assert.match(String(lengthErrorOf('transactions', 'category', short(300))), /category/, '分類仍是短欄');
});

test('lengthErrorOf：非字串一律 null（數字/物件不歸這道牆管）', () => {
  assert.equal(lengthErrorOf('transactions', 'amount', 99999999), null);
  assert.equal(lengthErrorOf('transactions', 'note', null), null);
  assert.equal(lengthErrorOf('transactions', 'note', undefined), null);
  assert.equal(lengthErrorOf('沒這個集合', 'whatever', short(201)), String(lengthErrorOf('沒這個集合', 'whatever', short(201))), '未知集合＝預設短級，不炸');
});

test('正常使用完全無感：典型資料全部照舊放行', () => {
  const typical = pickWritable('transactions', { date: '2026-07-27', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 120, account: '台新Richart卡', note: '停車費（林口文化二路）' });
  assert.deepEqual(typical.errors, []);
  const card = pickWritable('cards', { name: '台新Richart卡', benefits: short(3000), pdfPassword: 'A123456789' });
  assert.deepEqual(card.errors, []);
});

// ---- 服務層新輸入路（Codex #297 複審抓到的繞道）----
// POST /api/cards/:id/statement/import 吃 req.body.transactions＝HTTP 可直給、不經 pickWritable。
test('帳單匯入端點：超長 desc＝400 點名且資料庫零寫入（服務層不可繞過防線）', async (t) => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { rmSync } = await import('node:fs');
  const TEST_STORE = join(tmpdir(), `finance-input-guard-svc-${process.pid}.db`);
  process.env.STORE_FILE = TEST_STORE;
  const store = await import('../lib/store.js');
  const { importRows } = await import('../lib/services/statement-import.js');
  t.after(() => { for (const sfx of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + sfx); } catch { /* 可能不存在 */ } } });

  const db = store.emptyDb();
  db.cards = [{ id: 'c1', name: '測試卡', type: 'credit' }];
  store.save(db);

  const bad = { date: '2026-07-01', amount: 100, desc: short(LEN_LONG + 1), stmtRef: 'x' };
  await assert.rejects(async () => importRows('c1', [bad], '2026-07', null), (/** @type {any} */ e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /desc/, '要點名欄位');
    assert.match(e.message, /20000/, '要講上限');
    return true;
  });
  assert.equal(store.load().transactions.length, 0, '整批中止、零寫入');

  // 超長 category（短欄）同樣 400
  await assert.rejects(async () => importRows('c1', [{ date: '2026-07-01', amount: 100, desc: '正常店', stmtRef: 'x', category: short(LEN_SHORT + 1) }], '2026-07', null),
    (/** @type {any} */ e) => e.status === 400 && /category/.test(e.message));

  // 合法長 desc（>200 但 ≤20000＝匯入內容不被短欄誤傷）照常入庫，note/stmtRef/storeKey 一字不截
  const longButLegal = 'Ｘ'.repeat(500);
  const r = await importRows('c1', [{ date: '2026-07-02', amount: 200, desc: longButLegal, stmtRef: 'y' }], '2026-07', null);
  assert.equal(r.imported, 1);
  const tx = store.load().transactions[0];
  assert.ok(tx.stmtRef.includes(longButLegal), 'stmtRef 保留完整原文、不截斷');
});
