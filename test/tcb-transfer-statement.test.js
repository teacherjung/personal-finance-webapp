// 合成 PDF 的幾何重現合庫分行；字串與數字全為新造假資料，不載入使用者文件。
// 多筆、跨頁與異常版本是壓力情境，不能據此宣稱涵蓋銀行所有版型。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './helpers/build-pdf.js';
import { progressText } from '../public/modules/progress-text.js';

const dir = mkdtempSync(join(tmpdir(), 'finance-tcb-'));
process.env.STORE_FILE = join(dir, 'store.db');
const { parseBankStatement } = await import('../lib/bank-statement.js');
const { previewBankStatement, applyBankStatement, assertAiBankReconciled, previewBankTxForDb, importBankTxToDb } = await import('../lib/services/bank-import.js');
const { getDb, saveDb, emptyDb } = await import('../lib/repo.js');
after(() => rmSync(dir, { recursive: true, force: true }));

const cell = (x, y, w, s) => ({ x, y, w, s });
const source = '9001000***363';
const target = '006-9002000***003301';
const summary = () => [
  cell(208, 741, 180, '電 子 綜 合 對 帳 單'),
  cell(330, 703, 115, '對帳單基準日：115/09/30'),
  cell(52, 686, 200, '合作金庫銀行為您提供專屬電子綜合對帳單，'),
  cell(35, 229, 50, '【台幣類】'),
  cell(60, 210, 20, '種類'), cell(154, 210, 20, '帳號'), cell(251, 210, 40, '帳戶餘額'),
  cell(332, 210, 65, '起存日／放款日'), cell(430, 210, 30, '到期日'), cell(515, 210, 20, '期間'),
  cell(50, 194, 40, '綜合存款'), cell(131, 194, 65, source), cell(272, 194, 40, '7,890.12'),
  cell(35, 168, 60, '【黃金存摺】'), cell(127, 149, 20, '帳號'), cell(279, 149, 90, '台幣計價結存公克數'),
  cell(105, 131, 65, '9003000***778'), cell(373, 131, 20, '20.00'),
  cell(253, 107, 90, '電子化轉帳交易明細'),
  cell(35, 83, 180, '【網路銀行(含行動網銀)轉帳交易明細】'),
];
const headers = () => [
  cell(38, 771, 36, '交易日期'), cell(88, 771, 36, '交易時間'), cell(144, 771, 18, '摘要'),
  cell(198, 771, 36, '轉出帳號'), cell(274, 771, 68, '轉入行/轉入帳號'),
  cell(369, 775, 77, '轉出幣別/轉出金額'), cell(369, 766, 77, '轉入幣別/轉入金額'),
  cell(459, 775, 45, '手續費幣別'), cell(472, 766, 18, '金額'), cell(527, 771, 18, '備註'),
];
const row = (y = 749, time = '08:12:34') => [
  cell(36, y, 41, '115/09/10'), cell(88, y, 36, time), cell(135, y, 36, '網銀轉帳'),
  cell(187, y, 59, source), cell(263, y, 90, target),
  cell(403, y + 4, 45, '$1,234.56'), cell(477, y - 5, 9, '$0'),
  cell(511, y + 4, 50, '合成備註'), cell(525, y - 5, 23, '續行文字'),
];
const end = (y = 722) => cell(38, y, 520, '-'.repeat(45) + '【以下空白】' + '-'.repeat(45));
const pages = () => [summary(), [...headers(), ...row(), end()]];

// 每格自行指定 x/y/寬度，避免等寬排字器把受測欄位擠到別欄。只驗文字層，並非銀行字型的視覺複本。
function pdf(pages) {
  const hex = n => n.toString(16).padStart(4, '0');
  const cid = new Map();
  for (const c of pages.flat()) for (const ch of c.s) if (!cid.has(ch)) cid.set(ch, cid.size + 1);
  const pairs = [...cid].map(([ch, n]) => `<${hex(n)}> <${hex(ch.codePointAt(0))}>`);
  let bf = '';
  for (let i = 0; i < pairs.length; i += 100) {
    const part = pairs.slice(i, i + 100);
    bf += `${part.length} beginbfchar\n${part.join('\n')}\nendbfchar\n`;
  }
  const cmap = Buffer.from('/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /TCB-UCS def\n/CMapType 2 def\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' + bf + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n');
  const objs = ['', '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${7 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 1000 >>',
    `<< /Length ${cmap.length} >>`,
    '<< /Type /FontDescriptor /FontName /Synthetic /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 /CapHeight 1000 /StemV 80 >>'];
  const streams = { 5: cmap };
  pages.forEach((cs, i) => {
    const content = Buffer.from(cs.map(c => `BT /F1 10 Tf ${100 * c.w / (c.s.length * 10)} Tz 1 0 0 1 ${c.x} ${c.y} Tm <${[...c.s].map(ch => hex(cid.get(ch))).join('')}> Tj ET`).join('\n'));
    const p = 7 + 2 * i;
    objs[p] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${p + 1} 0 R >>`;
    objs[p + 1] = `<< /Length ${content.length} >>`; streams[p + 1] = content;
  });
  return build(objs, streams);
}
const b64 = p => Buffer.from(pdf(p)).toString('base64');
const change = (p, text, next) => { const c = p.flat().find(c => c.s === text); assert.ok(c, text); Object.assign(c, next); return p; };

const expected = {
  acctSuffix: '363', acctMasked: source, date: '2026-09-10', summary: '網銀轉帳',
  direction: 'out', amount: 1234.56, balance: null,
  note: '08:12:34 006-9002000***003301 合成備註 續行文字',
};
test('合庫正式 PDF 入口：分頁區名、上下行金額與備註；黃金不進存款餘額', async () => {
  const r = await parseBankStatement(pdf(pages()));
  assert.equal(r.bank, '合作金庫銀行'); assert.equal(r.referenceDate, '2026-09-30');
  assert.deepEqual(r.transactions, [expected]);
  assert.deepEqual(r.accounts, [{ suffix: '363', masked: source, balance: 7890.12, currency: 'TWD', label: '綜合存款', note: '' }]);
  assert.deepEqual({ ...r.accountCurrency }, { [source]: 'TWD' });
});
test('合庫多筆跨頁：重複表頭不成交易，同日同額不同時間分開', async () => {
  const p = [summary(), [...headers(), ...row(), ...row(719, '09:12:34')], [...headers(), ...row(749, '10:12:34'), end()]];
  const r = await parseBankStatement(pdf(p));
  assert.deepEqual(r.transactions, [expected, { ...expected, note: expected.note.replace('08:', '09:') }, { ...expected, note: expected.note.replace('08:', '10:') }]);
});
for (const [label, mutate] of [
  ['其他銀行', p => change(p, '合作金庫銀行為您提供專屬電子綜合對帳單，', { s: '合成測試銀行' })],
  ['沒有轉帳區', p => change(p, '電子化轉帳交易明細', { s: '其他明細' })],
  ['壞日期', p => change(p, '115/09/10', { s: '115/02/30' })],
  ['晚於基準日', p => change(p, '115/09/10', { s: '115/10/01' })],
  ['壞時間', p => change(p, '08:12:34', { s: '25:00:00' })],
  ['壞金額', p => change(p, '$1,234.56', { s: '$1,2x4.56' })],
  ['外幣金額', p => change(p, '$1,234.56', { s: 'USD1,234.56' })],
  ['負金額', p => change(p, '$1,234.56', { s: '-1234.56' })],
  ['零金額', p => change(p, '$1,234.56', { s: '$0.00' })],
  ['轉入欄金額', p => change(p, '$1,234.56', { y: 744 })],
  ['非零手續費', p => change(p, '$0', { s: '$15' })],
  ['缺表頭', p => change(p, '交易時間', { s: '未知欄位' })],
  ['來源帳戶不明', p => { const c = p[1].find(c => c.s === source); c.s = '9009999***363'; return p; }],
  ['轉入銀行不明', p => change(p, target, { s: '9002000***003301' })],
  ['備註管線分隔字元', p => change(p, '合成備註', { s: '測試|備註' })],
  ['雙金額', p => { p[1].push(cell(403, 744, 45, '$20.00')); return p; }],
  ['缺手續費', p => [p[0], p[1].filter(c => c.s !== '$0')]],
  ['混有外幣概要', p => { p[0].push(cell(35, 120, 60, '【外幣類】')); return p; }],
  ['表頭前漏列', p => { p[0].push(...row(50)); return p; }],
  ['重複概要帳戶', p => { p[0].push(...p[0].filter(c => c.y === 194).map(c => ({ ...c, y: 180 }))); return p; }],
  ['缺交易', p => [p[0], [...headers(), end()]]],
  ['缺結尾', p => [p[0], [...headers(), ...row()]]],
  ['離交易太遠的備註', p => change(p, '續行文字', { y: 730 })],
  ['無台幣證據', p => change(p, '【台幣類】', { s: '【外幣類】' })],
]) test(`合庫拒收：${label}`, async () => {
  await assert.rejects(() => parseBankStatement(pdf(mutate(pages()))), { code: 'bank_unrecognized', status: 400 });
});

test('合庫預覽／套用：唯讀、不同銀行同尾碼、保留舊帳、重匯與同日同額', async () => {
  const db = emptyDb();
  db.accounts = [{ id: 'other-bank', name: '其他行假帳戶', bank: '台新', type: 'cash', class: '現金', currency: 'TWD', accountNo: source, balance: 42 }];
  db.transactions = [{ id: 'keep-tcb-test', date: '2026-09-01', type: 'expense', category: '其他', subcategory: '未分類', amount: 77, account: '其他行假帳戶', source: 'manual', ledger: 'cashflow', note: '本題專屬保存值' }];
  await saveDb(db);
  const before = await getDb();
  const p = pages(); p[1] = [...headers(), ...row(), ...row(719, '09:12:34'), end(692)];
  const encoded = b64(p);
  const preview = await previewBankStatement(encoded);
  assert.deepEqual(await getDb(), before, '預覽不得寫入資料庫');
  assert.equal(preview.reconcile.level, 'weak');
  assert.equal(preview.transactions.rows.length, 2);
  const applied = await applyBankStatement(encoded);
  assert.equal(applied.transactions.imported, 2);
  const written = await getDb();
  assert.deepEqual(written.transactions.find(t => t.id === 'keep-tcb-test'), before.transactions[0]);
  assert.deepEqual(written.accounts.find(a => a.id === 'other-bank'), before.accounts[0]);
  const added = written.transactions.filter(t => t.source === 'bank');
  assert.equal(added.length, 2); assert.equal(new Set(added.map(t => t.bankRef)).size, 2);
  for (const t of added) { assert.equal(t.type, 'expense'); assert.equal(t.amount, 1234.56); assert.equal(t.bankSummary, '網銀轉帳'); }
  assert.ok(added.every(t => t.account !== '其他行假帳戶'));
  assert.equal(written.accounts.length, 2, '收款對方不自動建為本人帳戶');
  const repeated = await applyBankStatement(encoded);
  assert.equal(repeated.transactions.imported, 0);
  assert.deepEqual((await getDb()).transactions, written.transactions);
});

test('合庫拒收的套用保留本題舊值；AI 仍不可借弱驗證放行', async () => {
  const db = emptyDb();
  db.accounts = [{ id: 'keep-failed-tcb', name: '拒收保存值', bank: '合作金庫銀行', type: 'cash', class: '現金', currency: 'TWD', accountNo: source, balance: 765 }];
  await saveDb(db); const before = await getDb();
  await assert.rejects(() => applyBankStatement(b64(change(pages(), '$0', { s: '$15' }))), { code: 'bank_unrecognized' });
  assert.deepEqual(await getDb(), before);
  const parsed = await parseBankStatement(pdf(pages()));
  assert.throws(() => assertAiBankReconciled(parsed, before), { code: 'ai_weak_refused' });
});


test('合庫欄位整體平移仍按表頭讀取；空白備註不吃別欄', async () => {
  const p = pages();
  for (const c of p.flat()) c.x += 12;
  p[1] = p[1].filter(c => !['合成備註', '續行文字'].includes(c.s));
  const r = await parseBankStatement(pdf(p));
  assert.deepEqual(r.transactions, [{ ...expected, note: '08:12:34 006-9002000***003301' }]);
  assert.equal(r.accounts[0].balance, 7890.12);
});

test('合庫電子化轉帳匯入不推定同戶定存到期', async () => {
  const db = emptyDb();
  db.accounts = [{ id: 'tcb-cd-preserve', name: '合成定存', type: 'cash', class: '現金', bank: '合作金庫銀行',
    currency: 'TWD', balance: 24680, accountNo: source, balanceAsOf: '2026-09-01',
    cdKey: '合作金庫銀行|363|TWD|2026/01/10~2026/09/10|24680|#1' }];
  await saveDb(db); const before = await getDb();
  const applied = await applyBankStatement(b64(pages()));
  assert.equal(applied.transactions.imported, 1);
  const after = await getDb();
  assert.deepEqual(after.accounts.find(a => a.id === 'tcb-cd-preserve'), before.accounts[0]);
  assert.equal(after.transactions.filter(t => t.source === 'bank').length, 1);
});


test('合庫備註中的空白標記不能截掉交易', async () => {
  const p = pages(); p[1] = [...headers(), ...row(), ...row(719, '09:12:34'), end(692)];
  const notes = p[1].filter(c => c.s === '合成備註'); notes[1].s = '【以下空白】';
  const r = await parseBankStatement(pdf(p));
  assert.deepEqual(r.transactions, [expected, { ...expected, note: '09:12:34 006-9002000***003301 【以下空白】 續行文字' }]);
});

for (const [label, tail] of [
  ['同頁仍有交易', () => [[...headers(), ...row(), end(), ...row(689, '09:12:34')]]],
  ['續頁仍有交易', () => [[...headers(), ...row(), end()], [...headers(), ...row()]]],
]) test(`合庫結尾後${label}：拒收且套用保留本題舊值`, async () => {
  const db = emptyDb();
  db.accounts = [{ id: 'tcb-tail-keep', name: '結尾歧義保存值', bank: '合作金庫銀行', type: 'cash', class: '現金', currency: 'TWD', accountNo: source, balance: 456 }];
  await saveDb(db); const before = await getDb();
  const encoded = b64([summary(), ...tail()]);
  await assert.rejects(() => previewBankStatement(encoded), { code: 'bank_unrecognized' });
  await assert.rejects(() => applyBankStatement(encoded), { code: 'bank_unrecognized' });
  assert.deepEqual(await getDb(), before);
});
test('合庫結尾後的說明文字不成交易', async () => {
  const p = pages(); p[1].push(cell(38, 700, 200, '合成服務說明，請核對帳單。'));
  const r = await parseBankStatement(pdf(p));
  assert.deepEqual(r.transactions, [expected]);
});
test('合庫外幣概要標題附字仍拒收，不只認獨立標題格', async () => {
  const p = change(pages(), '【黃金存摺】', { s: '【外幣類】合成說明' });
  await assert.rejects(() => parseBankStatement(pdf(p)), { code: 'bank_unrecognized' });
});

test('合庫三碼相同的他行收款戶不直接判內轉：正式預覽與匯入一致', async () => {
  await saveDb(emptyDb());
  const encoded = b64(change(pages(), target, { s: '822-9002000***363' }));
  const stages = [];
  const preview = await previewBankStatement(encoded, undefined, undefined, { onStage: frame => stages.push(frame) });
  assert.equal(preview.transactions.rows[0].type, 'expense');
  assert.equal(preview.reconcile.level, 'weak');
  assert.equal(progressText(stages.find(f => f.s === 'verify')), '正在檢查可驗算的資料…');
  assert.equal(progressText(stages.find(f => f.s === 'build_preview')), '檢查完成，正在整理預覽…');
  const applied = await applyBankStatement(encoded);
  assert.equal(applied.transactions.imported, 1);
  const db = await getDb();
  assert.equal(db.transactions.length, 1);
  assert.equal(db.transactions[0].type, 'expense');
});

for (const from of ['accounts', 'accountCurrency']) test(`本人末碼證據 ${from}：少於四碼不認，四碼與六碼維持完整末碼比對`, () => {
  for (const suffix of ['3', '63', '363', '3363', '003363']) {
    for (const direction of ['in', 'out']) {
      const masked = `9001000***${suffix}`;
      const own = { suffix, masked, balance: 100, currency: 'TWD', label: '綜合存款', note: '' };
      const parsed = { bank: '合作金庫銀行', accounts: from === 'accounts' ? [own] : [],
        accountCurrency: from === 'accountCurrency' ? { [masked]: 'TWD' } : {},
        transactions: [{ ...expected, acctMasked: masked, acctSuffix: suffix, direction, note: `822-9002000***${suffix}` }] };
      const db = emptyDb();
      const want = suffix.length >= 4 ? 'transfer' : direction === 'out' ? 'expense' : 'income';
      assert.equal(previewBankTxForDb(db, parsed).rows[0].type, want, `${suffix} ${direction}`);
      assert.equal(importBankTxToDb(db, parsed).imported, 1);
      assert.equal(db.transactions[0].type, want, `${suffix} ${direction}`);
    }
  }
});

test('合庫短名既有帳戶：正式 PDF 匯入不裂戶，重匯不增加交易', async () => {
  const db = emptyDb();
  db.accounts = [{ id: 'tcb-alias-existing', name: '合成既有合庫戶', bank: '合作金庫', type: 'cash', class: '現金', currency: 'TWD', accountNo: source, balance: 5000 }];
  await saveDb(db);
  const encoded = b64(pages());
  const applied = await applyBankStatement(encoded);
  assert.equal(applied.transactions.imported, 1);
  const after = await getDb();
  assert.equal(after.accounts.length, 1);
  assert.equal(after.accounts[0].id, 'tcb-alias-existing');
  assert.equal(after.accounts[0].bank, '合作金庫');
  assert.equal(after.accounts[0].balance, 7890.12);
  assert.equal(after.transactions[0].account, '合成既有合庫戶');
  assert.equal((await applyBankStatement(encoded)).transactions.imported, 0);
  assert.deepEqual((await getDb()).transactions, after.transactions);
});
