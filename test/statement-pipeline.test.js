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
const { previewAuto, previewForCard, importRows, listBatches, setBatchMonth, issuerMatchesBank } = await import('../lib/services/statement-import.js');
const { cjkPdf } = await import('./helpers/build-pdf.js');

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
  assert.ok(r.resolvedCard, '末四碼唯一命中＋機構認得出來＋那張卡的發卡行對得上→自動歸卡');
  assert.equal(r.statementMonth, '2026-01');
  assert.equal(r.statementDue, 46299);
});

test('對卡判定（階段三缺口 M4）：同末四碼兩張卡→不自動選、回候選；末四碼沒中但該銀行唯一一張→自動命中', async () => {
  // 補發卡情境：兩張卡同末四碼。若回歸成「自動選第一張」＝帳單匯錯卡、跨卡去重失效、同筆消費重複計入分析。
  store.save({ ...store.emptyDb(), cards: [
    { id: 'c1', name: '台新舊卡', type: 'credit', issuer: '台新銀行', lastFour: '1234' },
    { id: 'c2', name: '台新補發卡', type: 'credit', issuer: '台新銀行', lastFour: '1234' },
  ] });
  const r = await previewAuto(taishinXlsxB64());
  assert.equal(r.resolvedCard, null, '同末四碼多卡＝系統不可硬猜');
  assert.deepEqual(r.candidates.map((/** @type {any} */ c) => c.id).sort(), ['c1', 'c2'], '兩張都要進候選讓使用者選');
  // 單卡銀行 fallback：帳單末四碼 1234 對不到 9999，但該銀行只有這一張 → 自動歸它
  store.save({ ...store.emptyDb(), cards: [
    { id: 'c9', name: '台新唯一卡', type: 'credit', issuer: '台新銀行', lastFour: '9999' },
  ] });
  const r2 = await previewAuto(taishinXlsxB64());
  assert.equal(r2.resolvedCard?.id, 'c9', '末四碼不合但該銀行僅此一張→自動歸卡');
});

test('整條管線：解析 → 預覽 → 匯入 → 批次列表，四棒都要把值傳下去', async () => {
  // 完全照前端的做法：從預覽的回應拿值，再回送給匯入
  const pre = await previewForCard('card1', taishinXlsxB64());
  await importRows('card1', pre.transactions, pre.statementMonth || '', pre.statementDue ?? null);

  const batches = await listBatches();
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

  await importRows('card1', pre.transactions, pre.statementMonth || '', pre.statementDue ?? null);
  const t = (store.load().transactions || [])[0];
  assert.ok(!('stmtMonth' in t), '讀不到就不寫欄位，不要塞空字串進資料');
  assert.ok(!('stmtDue' in t), '同上');
});

// ---------- 日期／月份的真實日曆驗證（Codex r3#9）----------
// 長期以來只驗長相：2026-13、2026-99-99、2026-02-31 全都過得了關。
// 後果不是崩潰而是**默默算錯**——月份排序（localeCompare 把 2026-13 排在 2026-02 後面）、
// 提醒天數、費用攤提、日線的「找最接近的既有日」都會偏掉，而且畫面上看起來一切正常。

test('真實日曆驗證：月份要 01–12、日期要真的存在（Codex r3#9）', async () => {
  const { isRealMonth, isRealDate } = await import('../lib/schema.js');
  // 月份
  assert.equal(isRealMonth('2026-01'), true);
  assert.equal(isRealMonth('2026-12'), true);
  assert.equal(isRealMonth('2026-13'), false, '13 月不存在');
  assert.equal(isRealMonth('2026-00'), false);
  // 日期
  assert.equal(isRealDate('2026-02-28'), true);
  assert.equal(isRealDate('2028-02-29'), true, '2028 是閏年');
  assert.equal(isRealDate('2026-02-29'), false, '2026 不是閏年');
  assert.equal(isRealDate('2026-02-31'), false, '2 月沒有 31 號');
  assert.equal(isRealDate('2026-04-31'), false, '4 月只有 30 天');
  assert.equal(isRealDate('2026-99-99'), false);
  assert.equal(isRealDate('2026-13-01'), false);
});

test('櫃檯擋得住假日期：壞的月份/日期進不了資料庫', () => {
  const base = store.emptyDb();
  assert.throws(() => store.save({ ...base, history: [{ id: 'h', month: '2026-13', amount: 1 }] }), /month/,
    '13 月會讓 history 頁的排序與 slice 全部偏掉');
  assert.throws(() => store.save({ ...base, dailyValues: [{ date: '2026-02-31', netWorth: 1 }] }), /date/,
    '不存在的日子會讓差異引擎「找最接近的既有日」對錯');
  assert.throws(() => store.save({ ...base,
    transactions: [{ id: 't', date: '2026-04-31', type: 'expense', category: '飲食', amount: 1 }] }), /date/,
    '交易日期同理（壞日期會讓該筆默默不被計入月現金流）');
});

test('手動修正帳單年月也走同一套判準（不可只驗長相）', async () => {
  await assert.rejects(() => setBatchMonth('any', '2026-13'), /YYYY-MM/,
    'Codex 實測舊版會回成功、資料庫真的存下 2026-13');
});

test('自主體檢｜同帳單同店同日同額兩筆真消費：都匯入；重匯同帳單仍正確去重', async () => {
  const store = await import('../lib/store.js');
  const { previewForCard, importRows } = await import('../lib/services/statement-import.js');
  const { default: XLSX } = await import('xlsx');
  // 合成台新 XLSX：同一天、同店、同金額兩筆（真的買兩杯一樣的咖啡）
  const rows = [
    ['台新銀行'], ['2026/07 信用卡明細'], ['本期帳單金額', '新臺幣 500'],
    ['交易日', '入帳日', '說明', '', '金額', '', '', ''],
    ['2026/07/03', '2026/07/05', '星巴克', '', '150', '', '', ''],
    ['2026/07/03', '2026/07/05', '星巴克', '', '150', '', '', ''],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });

  store.save({ ...store.emptyDb(), cards: [{ id: 'k1', name: '台新卡', type: 'credit', issuer: '台新' }] });
  const prev = await previewForCard('k1', b64);
  const coffees = prev.transactions.filter(t => t.desc === '星巴克');
  assert.equal(coffees.length, 2, '兩筆都在預覽');
  assert.notEqual(coffees[0].stmtRef, coffees[1].stmtRef, '兩筆的 stmtRef 要不同（第二筆帶 #2）');
  assert.ok(!coffees[0].duplicate && !coffees[1].duplicate, '同帳單內兩筆都不算重複');

  const r1 = await importRows('k1', prev.transactions);
  assert.equal(r1.imported, 2, '兩筆真消費都要進帳（修正前第二筆被吃掉）');

  // 重匯同一份帳單：序號依解析順序固定 → 兩筆都被判重複、都跳過（不會多出來）
  const prev2 = await previewForCard('k1', b64);
  assert.ok(prev2.transactions.filter(t => t.desc === '星巴克').every(t => t.duplicate), '重匯時兩筆都標重複');
  const r2 = await importRows('k1', prev2.transactions);
  assert.equal(r2.imported, 0, '重匯不可多出任何一筆');
  assert.equal(store.load().transactions.filter(t => String(t.note).includes('星巴克')).length, 2, '總數仍是 2');
});


// ── 認不出機構時的守門（2026-08-27）─────────────────────────────────────────────
// 背景：`String(issuer).includes('')` 恆真，所以解析器判不出是哪一家（`bank: ''`）時，
//   **每一張信用卡**都會算成「這家的卡」，於是「該銀行只有一張卡就自動歸」那條會把別家帳單
//   自動記到使用者唯一的那張卡上——錢記到錯的卡，畫面上沒有任何提示。

test('★J1 認不出機構（bank 空字串）時，不得有任何卡片算「這家的卡」', () => {
  assert.equal(issuerMatchesBank('台新銀行', '台新'), true);
  assert.equal(issuerMatchesBank('台新銀行', ''), false, '★空機構名不得恆真（includes(\'\') 的陷阱）');
  assert.equal(issuerMatchesBank('', ''), false);
  assert.equal(issuerMatchesBank(null, ''), false);
  assert.equal(issuerMatchesBank('玉山銀行', '台新'), false);
});

test('★J2 端到端：讀得到列但認不出機構的 PDF，即使只有一張卡也不准自動歸卡', async () => {
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'only', name: '我唯一的卡', type: 'credit', issuer: '台新銀行', lastFour: '9999' }] });
  // 這份 PDF 讀得到兩筆交易，但**沒印任何機構名**，末四碼也對不上那張卡。
  const b64 = Buffer.from(cjkPdf([
    ['信用卡消費明細'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
    ['115/06/05', '115/06/07', '全聯福利中心', '320'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.bank, '', '前提：這份確實認不出機構');
  assert.equal(r.bankEvidence, 'none', '★證據種類要一路帶到回應（前端據它印警語）');
  assert.ok(r.transactions === undefined || r.transactions.length >= 0);
  assert.equal(r.resolvedCard, null, '★不准自動歸卡——即使他只有一張卡');
  assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 1, '要回候選讓使用者自己選');
});

test('★J2b 對照：認得出機構時，「該銀行只有一張卡」那條照舊自動歸卡（沒有被誤殺）', async () => {
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'only', name: '台新卡', type: 'credit', issuer: '台新銀行', lastFour: '9999' }] });
  const b64 = Buffer.from(cjkPdf([
    ['台新國際商業銀行 信用卡消費明細'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.bank, '台新', '前提：這份認得出機構');
  assert.equal(r.bankEvidence, 'header');
  assert.ok(r.resolvedCard, '★認得出機構＋該銀行唯一一張卡 ⇒ 仍然自動歸卡');
  assert.equal(r.resolvedCard.id, 'only');
});

test('★J3 認不出機構時，末四碼唯一命中也**只當候選**、不自動選（Codex #518 r1#2）', async () => {
  // 分支④說「禁止自動歸卡」，但 previewAuto 原本先用 lastFour 決定 resolvedCard ⇒ 整條分支被繞過。
  // 末四碼不是全域唯一，而「認不出機構」代表那些列可能是別家版面被硬讀出來的垃圾。
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'c9', name: '某張卡', type: 'credit', issuer: '台新銀行', lastFour: '9999' }] });
  const b64 = Buffer.from(cjkPdf([
    ['信用卡消費明細'],                       // 沒有機構名
    ['卡號末四碼 9999'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.bank, '', '前提：這份確實認不出機構');
  assert.equal(r.lastFour, '9999', '前提：末四碼讀得到、而且只有一張卡對得上');
  assert.equal(r.resolvedCard, null, '★末四碼唯一命中也不准自動選——認不出機構時列本身就可疑');
  assert.deepEqual(r.candidates.map(c => c.id), ['c9'], '要把那張卡列成候選，讓使用者自己確認');
});

test('★J4 選卡／改卡之後，「認不出機構」的警語不得消失（Codex #518 r1#4）', async () => {
  // 前端選卡會改打 previewForCard 並用回應覆蓋 curR；那個端點原本沒回 bankEvidence，
  // 於是警語在**使用者最需要看到它的時刻**（正要決定記到哪張卡）消失＝畫面說謊。
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'c9', name: '某張卡', type: 'credit', issuer: '台新銀行', lastFour: '9999' }] });
  const unknown = Buffer.from(cjkPdf([
    ['信用卡消費明細'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  const r = await previewForCard('c9', unknown);
  assert.equal(r.bank, '');
  assert.equal(r.bankEvidence, 'none', '★指定卡片預覽也要交出證據種類，否則警語印不出來');
  // 對照：認得出機構時不得亂鳴
  const known = Buffer.from(cjkPdf([
    ['台新國際商業銀行 信用卡消費明細'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  assert.equal((await previewForCard('c9', known)).bankEvidence, 'header');
});

test('★J5 已知機構＋末四碼指向別家的卡 ⇒ 兩個訊號打架就退人工選（Codex #518 r2#4）', async () => {
  // 實測：帳單清楚印「台新」、末四碼 1234，而資料庫裡唯一的 1234 是台北富邦卡
  // ⇒ 舊寫法照樣自動選中那張富邦卡＝交易寫到錯的卡。末四碼不是全域唯一。
  // ⚠️ 一定要**多放一張末四碼不同的同行卡**（Codex #520 r8#1）：只放 fb 一張時，把
  //    「candidates = hit」那行整個拿掉，fallback 找不到同行卡會退回全部卡片＝同樣只有 fb
  //    ⇒ 本題照樣綠、契約宣稱的「末四碼優先當線索」其實沒人釘。加了 ts 之後那個突變會紅
  //    （拿掉 hit 分支 ⇒ 台新單卡走分支②自動歸 ts，resolvedCard 不再是 null）。
  store.save({ ...store.emptyDb(), cards: [
    { id: 'fb', name: '富邦卡', type: 'credit', issuer: '台北富邦銀行', lastFour: '1234' },
    { id: 'ts', name: '台新卡', type: 'credit', issuer: '台新銀行', lastFour: '9999' },
  ] });
  const b64 = Buffer.from(cjkPdf([
    ['台新銀行 信用卡消費明細'],
    ['卡號末四碼 1234'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.bank, '台新', '前提：機構認得出來是台新');
  assert.equal(r.lastFour, '1234', '前提：末四碼讀得到、而且只有那張富邦卡對得上');
  assert.equal(r.resolvedCard, null, '★訊號打架就不自動選——即使同行的台新卡只有一張');
  assert.deepEqual(r.candidates.map(c => c.id), ['fb'],
    '★候選＝末四碼命中的那張、不進同行 fallback（末四碼優先當線索；契約決策樹③(a)）');
});

test('★J8 「判不出發卡行」的卡不可以靜靜出局——沒填發卡行的卡在庫，單卡自動歸要退手選', async () => {
  // 族群過濾＋唯一性判準的陷阱補完（William 2026-08-28 裁示「擋：不確定就問我」）：
  // #520 只補了「歧義寫法」這一個入口，「判不出身分」的卡（沒填是最常見的形狀）仍被無聲排除
  // ⇒ 那張卡如果就是帳單這家的（新建卡還沒填發卡行），帳單自動記到另一張有填的卡＝錢記錯。
  store.save({ ...store.emptyDb(), cards: [
    { id: 'ts', name: '台新卡', type: 'credit', issuer: '台新銀行' },
    { id: 'blank', name: '還沒填發卡行的卡', type: 'credit' },
  ] });
  const b64 = Buffer.from(cjkPdf([
    ['台新銀行 信用卡消費明細'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.bank, '台新', '前提：帳單認得出是台新');
  assert.equal(r.resolvedCard, null, '★沒填發卡行的卡「說不定就是台新的」⇒ 不可自動歸');
  assert.deepEqual((r.candidates || []).map((/** @type {any} */ c) => c.id), ['ts', 'blank'],
    '★候選要含那張沒填的卡（看得到才選得到、也才會想起去填發卡行）、照原卡片順序');
});

test('★J8b 「清單與樣式都認不出」的出局原因都擋——含壞型別 String() 後仍認不出的（真陣列經櫃檯直達）', async () => {
  for (const [label, issuer] of [
    ['清單外文字', '某某會員俱樂部'],
    ['壞型別字串化後的垃圾（字串形）', '[object Object]'],
    // ⚠️ 真非字串、經 store 櫃檯原樣落庫直達 previewAuto（Codex #522 r1 指定的第四格）：
    //    {} 字串化成 "[object Object]" ⇒ 判不出 ⇒ 擋。
    ['壞型別（真物件經櫃檯）', /** @type {any} */ ({ bad: true })],
  ]) {
    store.save({ ...store.emptyDb(), cards: [
      { id: 'ts', name: '台新卡', type: 'credit', issuer: '台新銀行' },
      { id: 'x', name: '判不出的卡', type: 'credit', issuer },
    ] });
    const b64 = Buffer.from(cjkPdf([
      ['台新銀行 信用卡消費明細'],
      ['115/06/02', '115/06/04', '星巴克', '150'],
    ])).toString('base64');
    const r = await previewAuto(b64);
    assert.equal(r.resolvedCard, null, `★${label}＝判不出 ⇒ 擋自動歸`);
    assert.ok((r.candidates || []).some((/** @type {any} */ c) => c.id === 'x'), `★${label}的卡要進候選`);
  }
});

test('★J8e documenting：壞型別 String() 後**剛好認得出**＝照字面判、不擋（#520 裁定「字串化的答案」）', async () => {
  // Codex #522 r1 的重現案例。這不是理想行為的背書，是**照實記載既有語意**：#520 已裁定並用考題釘住
  // 「壞型別的答案＝它字串化之後的答案＝與使用者直接打那串字同義」。要把「形狀壞」本身當不確定
  // ＝翻掉那個裁定，另案再議；在那之前，文件與守門的宣稱都以本題為準（「壞資料」限縮成
  // 「String() 後仍認不出的值」）。
  store.save({ ...store.emptyDb(), cards: [
    { id: 'ts', name: '台新卡', type: 'credit', issuer: '台新銀行' },
    { id: 'arr', name: '陣列發卡行的卡', type: 'credit', issuer: /** @type {any} */ (['玉山銀行']) },
  ] });
  const b64 = Buffer.from(cjkPdf([
    ['台新銀行 信用卡消費明細'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.resolvedCard?.id, 'ts',
    '★String(["玉山銀行"])＝"玉山銀行"＝確定別家 ⇒ 台新單卡照樣自動歸（documenting）');
});

test('★J8c 對照：清單認得的別家卡（含沒有內建範本的那些）**不**擋——「認得出但沒範本」不是「判不出」', async () => {
  // 沒有這一題，守門會被「乾脆把 issuerBank 回空的都擋」蒙混過去——那會讓 William 的遠東商銀卡
  // 擋掉他所有台新／富邦帳單的自動歸（過度 fail-closed，裁示時攤開過的邊界）。
  for (const other of ['遠東商銀', '玉山銀行', '台北富邦銀行']) {
    store.save({ ...store.emptyDb(), cards: [
      { id: 'ts', name: '台新卡', type: 'credit', issuer: '台新銀行' },
      { id: 'o', name: '別家卡', type: 'credit', issuer: other },
    ] });
    const b64 = Buffer.from(cjkPdf([
      ['台新銀行 信用卡消費明細'],
      ['115/06/02', '115/06/04', '星巴克', '150'],
    ])).toString('base64');
    const r = await previewAuto(b64);
    assert.equal(r.resolvedCard?.id, 'ts', `★「${other}」確定不是台新 ⇒ 台新單卡照樣自動歸`);
  }
});

test('★J8d 對照：歧義寫法但**都不是這家**（「富邦」卡 vs 台新帳單）不擋——歧義只擋歧義所含的那幾家', async () => {
  store.save({ ...store.emptyDb(), cards: [
    { id: 'ts', name: '台新卡', type: 'credit', issuer: '台新銀行' },
    { id: 'fb', name: '舊寫法富邦卡', type: 'credit', issuer: '富邦' },
  ] });
  const b64 = Buffer.from(cjkPdf([
    ['台新銀行 信用卡消費明細'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.resolvedCard?.id, 'ts',
    '★「富邦」不管是台北還是香港都不是台新 ⇒ 確定別家 ⇒ 台新單卡照樣自動歸');
});

test('★J5b 對照：機構與末四碼**一致**時仍然自動歸卡（沒有被誤殺）', async () => {
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'ts', name: '台新卡', type: 'credit', issuer: '台新銀行', lastFour: '1234' }] });
  const b64 = Buffer.from(cjkPdf([
    ['台新銀行 信用卡消費明細'],
    ['卡號末四碼 1234'],
    ['115/06/02', '115/06/04', '星巴克', '150'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.ok(r.resolvedCard, '★兩個訊號一致 ⇒ 照舊自動歸卡');
  assert.equal(r.resolvedCard.id, 'ts');
});

test('★J6 台北富邦帳單＋同末四碼的**香港富邦**卡 ⇒ 不得自動歸卡（Codex #518 r3#2）', async () => {
  // `String(issuer).includes('富邦')` 對「富邦銀行（香港）有限公司」為真 ⇒ 舊寫法直接歸到香港卡。
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'hk', name: '香港富邦卡', type: 'credit', issuer: '富邦銀行（香港）有限公司', lastFour: '1234' }] });
  const b64 = Buffer.from(cjkPdf([
    ['台北富邦銀行 信用卡帳單'],
    ['卡號末四碼 1234'],
    ['115/07/03', '一般商店', '115/07/05', '1,250'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.bank, '富邦', '前提：帳單認得出是台北富邦');
  assert.equal(r.lastFour, '1234', '前提：末四碼讀得到、而且只有那張香港卡對得上');
  assert.equal(r.resolvedCard, null, '★香港富邦不是台北富邦 ⇒ 退人工選');
});

test('★★J7 歧義寫法的卡不可以靜靜出局，把「該問使用者」變成「自動歸卡」（工作流對抗驗證 2026-08-28）', async () => {
  // 這是**本支自己引入**的回歸，Codex 四輪都沒看到，工作流的對抗驗證抓到並實測重現。
  //   `bankCards` 是族群過濾、分支②是唯一性判準 ⇒ 把一張「說不定就是這家」的卡移出族群，
  //   會讓「兩張、有歧義、該問使用者」靜靜變成「只剩一張、自動歸卡」。
  // 情境：兩張台北富邦卡——舊那張的 issuer 是清單化之前的自由文字「富邦」（歧義寫法），
  //   新那張是清單上的正式寫法；帳單認得出機構，但**末四碼讀不出來**（所以只能靠分支②）。
  store.save({ ...store.emptyDb(), cards: [
    { id: 'old', name: '舊寫法的富邦卡', type: 'credit', issuer: '富邦' },
    { id: 'new', name: '清單挑的富邦卡', type: 'credit', issuer: '台北富邦銀行' },
  ] });
  const b64 = Buffer.from(cjkPdf([
    ['台北富邦銀行 信用卡帳單'],
    ['115/07/03', '一般商店', '115/07/05', '1,250'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.bank, '富邦', '前提：帳單認得出是台北富邦');
  assert.ok(!r.lastFour, '前提：末四碼讀不出來 ⇒ 只能靠「該銀行單卡」那條分支');
  assert.equal(r.resolvedCard, null,
    '★不可自動歸卡——舊那張「富邦」說不定就是同一家，base 在這裡是問使用者的');
  // ⚠️ **直接驗正式回應的順序，不可先 sort 再比**（Codex #520 r5#1）：前端選卡 select 沒有
  //    空白提示項，第一項＝預設選中。sort 過的斷言看不到「守門把預選從舊卡偏向新卡」這種變更；
  //    base 的候選順序＝原卡片順序（old → new），守門後必須維持。
  const ids = (r.candidates || []).map((/** @type {any} */ c) => c.id);
  assert.deepEqual(ids, ['old', 'new'],
    '★兩張都要進候選、且照原卡片順序——串接順序會把預設選中靜靜換成新卡');
});

test('★J7b 對照：舊卡換成**別家**（不是歧義、是真的不同家）時，分支②照樣自動歸卡', async () => {
  // 沒有這一題，J7 會被「乾脆整個不自動歸卡」蒙混過去——那是把護欄做成恆真。
  store.save({ ...store.emptyDb(), cards: [
    { id: 'esun', name: '玉山卡', type: 'credit', issuer: '玉山銀行' },
    { id: 'new', name: '清單挑的富邦卡', type: 'credit', issuer: '台北富邦銀行' },
  ] });
  const b64 = Buffer.from(cjkPdf([
    ['台北富邦銀行 信用卡帳單'],
    ['115/07/03', '一般商店', '115/07/05', '1,250'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.equal(r.resolvedCard?.id, 'new', '★玉山不是「說不定的富邦」，它出局是對的 ⇒ 仍然只剩一張 ⇒ 自動歸');
});

test('★J6b 對照：同一份帳單配**台北富邦**卡時仍然自動歸卡', async () => {
  store.save({ ...store.emptyDb(),
    cards: [{ id: 'tp', name: '台北富邦卡', type: 'credit', issuer: '台北富邦銀行', lastFour: '1234' }] });
  const b64 = Buffer.from(cjkPdf([
    ['台北富邦銀行 信用卡帳單'],
    ['卡號末四碼 1234'],
    ['115/07/03', '一般商店', '115/07/05', '1,250'],
  ])).toString('base64');
  const r = await previewAuto(b64);
  assert.ok(r.resolvedCard, '★機構對得上就照舊自動歸卡（上一題不是「什麼都不歸」）');
  assert.equal(r.resolvedCard.id, 'tp');
});
