// 帳單匯入「整條管線」考題（2026-07-19，使用者實測回報應繳金額永遠空白後補）。
//
// 為什麼要有這一檔：#126/#127 做了帳單年月與應繳金額，兩端的考題都很紮實——
// `extractStatementMonth`／`extractStatementDue`（純解析）十幾題、`importRows`（給定明確參數）也有題。
// **但沒有任何一題測「預覽有沒有把解析到的值交給匯入」**，而前端正是從預覽的回應讀這兩個值再送回去的。
// 結果 previewAuto/previewForCard 只挑了 bank/lastFour/transactions，期別與應繳金額在中間被默默丟掉：
// 每一批都退回「推估」年月、應繳金額永遠是「—」。兩端各自都對，斷在中間那條線上。
//
// 所以這裡測的是**跨模組的交接**：解析 → 預覽 → 匯入 → 批次列表，四棒都要把值傳下去。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import * as XLSX from 'xlsx';

const TEST_STORE = join(tmpdir(), `finance-pipeline-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { previewAuto, previewForCard, importRows, listBatches } = await import('../lib/services/statement-import.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/**
 * 合成一份「台新官網下載」格式的 XLSX（走真正的解析器，不是假資料注入）。
 * 表頭放結帳日與本期應繳總金額，明細列＝[消費日, 入帳日, 說明, , 金額, , , 外幣]。
 */
function taishinXlsxB64() {
  const aoa = [
    ['台新銀行 2026/02 信用卡明細'],
    ['帳單結帳日：115/01/04', '', '繳款截止日：115/01/20'],
    ['本期應繳總金額', '', 'NT$46,299'],
    ['卡號末四碼 1234'],
    ['消費日', '入帳日', '說明', '', '金額', '', '', '外幣'],
    ['2026/01/02', '2026/01/03', '星巴克', '', '150', '', '', ''],
    ['2026/01/05', '2026/01/06', '全聯', '', '300', '', '', '']
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
  return Buffer.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))).toString('base64');
}

beforeEach(() => {
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'card1', name: '台新Richart卡', type: 'credit', issuer: '台新銀行', lastFour: '1234' }] });
});

test('預覽要把「帳單年月」與「應繳金額」交出來（前端就是從預覽回應讀這兩個值再送回匯入的）', async () => {
  const r = await previewForCard('card1', taishinXlsxB64());
  assert.equal(r.statementMonth, '2026-01', '結帳日 115/01/04 → 帳單年月 2026-01（以結帳日當月為準）');
  assert.equal(r.statementDue, 46299, '應繳金額要讀自帳單表頭的「本期應繳總金額」');
  assert.ok(r.transactions.length >= 2, '明細照樣要解析得出來');
});

test('免選卡預覽（自動歸卡那條路）也要交出這兩個值', async () => {
  const r = await previewAuto(taishinXlsxB64());
  assert.ok(r.resolvedCard, '末四碼唯一命中→自動歸卡');
  assert.equal(r.statementMonth, '2026-01');
  assert.equal(r.statementDue, 46299);
});

test('整條管線：解析 → 預覽 → 匯入 → 批次列表，四棒都要把值傳下去', async () => {
  // 完全照前端的做法：從預覽的回應拿值，再回送給匯入
  const pre = await previewForCard('card1', taishinXlsxB64());
  importRows('card1', pre.transactions, pre.statementMonth || '', pre.statementDue ?? null);

  const batches = listBatches();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].stmtMonth, '2026-01', '批次列表要顯示真正的帳單年月，不是退回「推估」');
  assert.equal(batches[0].stmtDue, 46299, '批次列表要顯示應繳金額，不是「—」');
  assert.equal(batches[0].count, 2);

  // 而且要真的存進每一筆交易（listBatches 是從交易聚合出來的）
  const txs = store.load().transactions || [];
  assert.ok(txs.every(t => t.stmtMonth === '2026-01'), '每一筆都要帶帳單期別');
  assert.ok(txs.every(t => t.stmtDue === 46299), '每一筆都要帶應繳金額');
});

test('讀不到表頭時要誠實留空（退回推估），不可硬塞值', async () => {
  // 沒有結帳日、沒有應繳金額的極簡帳單
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['消費日', '入帳日', '說明', '', '金額'],
    ['2026/03/02', '2026/03/03', '星巴克', '', '150']
  ]), 'Sheet1');
  const b64 = Buffer.from(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))).toString('base64');

  const pre = await previewForCard('card1', b64);
  assert.equal(pre.statementMonth, '', '讀不到期別＝空字串（批次列表會標「推估」）');
  assert.equal(pre.statementDue, null, '讀不到應繳金額＝null（批次列表顯示「—」）');

  importRows('card1', pre.transactions, pre.statementMonth || '', pre.statementDue ?? null);
  const t = (store.load().transactions || [])[0];
  assert.ok(!('stmtMonth' in t), '讀不到就不寫欄位，不要塞空字串進資料');
  assert.ok(!('stmtDue' in t), '同上');
});
