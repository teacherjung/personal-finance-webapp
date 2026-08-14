// 「這次不匯入疑似重複」（William 2026-08-14 實測時的需求）：
// 同期間匯過另一種版面時，48/57 筆被標「疑似重複」——按確認會全部再匯一次（現金流多算一份），
// 不匯又進不了剩下的 9 筆。解法＝預覽窗勾選框：勾了就跳過**預覽標的那些**、其餘照匯。
//
// 三條紀律：
// ①判準與預覽**同一套**（similarTxIndex＋similarKey）——預覽標幾筆、匯入就跳幾筆，不另立口徑。
// ②嚴格 true 才生效（applyBody 只在 === true 放 key；路由只認 === true；服務層只認 === true）。
// ③誠實：「疑似」是啟發式——真的同帳戶同日同額刷兩次會被一起跳過，所以它是**可取消的勾選**
//   （預覽窗預設勾＝往「不多算錢」倒；使用者可取消），tooltip 明講代價（可事後手動補記）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 正式入口題要碰 repo 櫃檯——隔離 DB 必須在 import 服務層**之前**設好（store.js 載入時定路徑）
const TEST_STORE = join(tmpdir(), `finance-skip-sim-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { importBankTxToDb, applyBankStatement } = await import('../lib/services/bank-import.js');
const { applyBody } = await import('../public/modules/ai-consent.js');
const { bankSkipSimilarOptionHtml, bankApplyDoneText, bankPreviewFootnote } = await import('../public/modules/cashflow-model.js');
const { getDb, saveDb } = await import('../lib/repo.js');

after(() => {
  for (const suffix of ['', '-wal', '-shm', '.bak']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* 沒有就算了 */ }
  }
});

/** 合成資料（零真實帳單內容）：db 裡已有一筆「同帳戶＋同日＋同額＋同方向」的舊交易 */
const makeDb = () => ({
  accounts: [],
  settings: {},
  transactions: [{
    id: 'old1', date: '2026-01-28', type: 'expense', amount: 305, account: '合成活儲',
    ledger: 'cashflow', source: 'bank', dir: 'out',
    // 舊版面的 bankRef（文字寫法不同＝bankRef 對不上＝防重複認不出來——這正是「疑似重複」的病）
    bankRef: 'bank|999900****0001|2026-01-28|out|305||舊版面寫法',
  }],
});
/** 新版面同一筆交易（文字不同、金額日期方向相同）＋一筆真正的新交易 */
const PARSED = Object.freeze({
  bank: '台新',
  accounts: [],
  accountCurrency: { '999900****0001': 'TWD' },
  transactions: [
    { acctSuffix: '0001', acctMasked: '999900****0001', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: null, note: '合成商店' },
    { acctSuffix: '0001', acctMasked: '999900****0001', date: '2026-01-31', summary: '轉帳存入', direction: 'in', amount: 999, balance: null, note: '合成來源' },
  ],
});

test('勾了＝跳過疑似重複、其餘照匯；沒勾＝照舊全匯（兩個方向都要驗）', () => {
  const db1 = makeDb();
  const r1 = importBankTxToDb(db1, PARSED, { skipSimilar: true });
  assert.equal(r1.similarSkipped, 1, '★同帳戶＋同日＋同額＋同方向那筆要被跳過');
  assert.equal(r1.imported, 1, '★真正的新交易照匯——「跳過疑似」不可以把整份擋掉');
  assert.equal(db1.transactions.length, 2, '落庫＝舊 1＋新 1');

  const db2 = makeDb();
  const r2 = importBankTxToDb(db2, PARSED, {});
  assert.equal(r2.similarSkipped, 0, '★沒勾＝維持既有行為（疑似重複只提醒不擋）');
  assert.equal(r2.imported, 2, '沒勾＝兩筆都進（含重複那筆——這是使用者自己的選擇）');
});

test('嚴格 true：字串 "true"、1、undefined 都不啟動跳過（服務層那一關）', () => {
  for (const junk of ['true', 1, {}, undefined, null]) {
    const db = makeDb();
    const r = importBankTxToDb(db, PARSED, { skipSimilar: /** @type {any} */ (junk) });
    assert.equal(r.similarSkipped, 0, `★${JSON.stringify(junk)} 不可以被當成 true——跳過交易是會少記帳的動作`);
    assert.equal(r.imported, 2);
  }
});

test('applyBody：嚴格 true 才放 key，AI 與模板兩條路線都帶得動', () => {
  const ai = applyBody({ engine: 'ai', aiTicket: 't1' }, { data: 'b64', skipSimilar: true });
  assert.equal(ai.skipSimilar, true, 'AI 路線（憑票寫入）也要能帶——寫入端一樣會算疑似重複');
  const tpl = applyBody({ rows: [] }, { data: 'b64', skipSimilar: true });
  assert.equal(tpl.skipSimilar, true, '模板路線同樣帶');
  for (const junk of [undefined, false, 'true', 1]) {
    const b = applyBody({ rows: [] }, { data: 'b64', skipSimilar: /** @type {any} */ (junk) });
    assert.equal('skipSimilar' in b, false,
      `★${JSON.stringify(junk)} 不放 key——String(undefined) 是 truthy，鬆一次就是 #450 那族的病`);
  }
});

test('勾選框：有疑似重複才畫、預設勾、tooltip 誠實講代價；0 筆＝不畫', () => {
  const html = bankSkipSimilarOptionHtml(48);
  assert.match(html, /這次不匯入 48 筆「疑似重複」/u);
  assert.match(html, /checked/u, '★預設勾＝往「不多算錢」那邊倒（少記的可以手動補、多算的要人工找出來刪）');
  assert.match(html, /真的刷兩次同額的也會被跳過，可事後手動補記/u,
    '★tooltip 要誠實講啟發式的代價——不講，使用者以為勾了就零風險');
  assert.equal(bankSkipSimilarOptionHtml(0), '', '★沒東西可跳＝不畫開關');
});

test('完成訊息：跳過幾筆要說出來（不說＝使用者以為那 48 筆也進了）', () => {
  const msg = bankApplyDoneText(
    { balancesSkipped: false, updated: 1, created: 0, skipped: 0, unsupported: 0 },
    { imported: 9, skipped: 0, similarSkipped: 48, foreign: 0 });
  assert.match(msg, /依勾選跳過疑似重複 48/u, '★勾選的結果要回報');
  const msg2 = bankApplyDoneText(
    { balancesSkipped: false, updated: 1, created: 0, skipped: 0, unsupported: 0 },
    { imported: 9, skipped: 0, foreign: 0 });
  assert.doesNotMatch(msg2, /疑似重複/u, '沒勾（欄位缺席）＝不提，維持既有訊息形狀');
});

test('互扣｜同末碼、不同可見前綴＝不是疑似重複：preview 不標、apply 也不跳（r2 阻擋）', async () => {
  // ⚠️ r2 的刀：preview 與 apply 的判準原本各手抄一份，apply 那份把前綴否決拔掉時 84 題全綠
  //   ——後果是「預覽判定不同帳戶（不標）、套用卻跳過**真交易**」＝使用者掉帳。
  //   現在兩端共用 isSimilarTx；這題釘住「不同前綴」這一格在**兩端同時**成立。
  const { previewBankTxForDb } = await import('../lib/services/bank-import.js');
  const dbShape = () => ({
    accounts: [], settings: {},
    transactions: [{
      id: 'old1', date: '2026-01-28', type: 'expense', amount: 305, account: '合成活儲',
      ledger: 'cashflow', source: 'bank', dir: 'out',
      bankRef: 'bank|111100****0001|2026-01-28|out|305||舊版面寫法',   // 前綴 1111
    }],
  });
  const parsedDiffPrefix = {
    bank: '台新', accounts: [], accountCurrency: { '222200****0001': 'TWD' },
    transactions: [   // 前綴 2222、同末碼 0001、同日同額同方向＝不同帳戶的真交易
      { acctSuffix: '0001', acctMasked: '222200****0001', date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: null, note: '合成商店' },
    ],
  };
  const { rows } = previewBankTxForDb(dbShape(), parsedDiffPrefix);
  assert.equal(rows[0].similar, false, '★preview：前綴兩邊都印得出來且不同＝不標疑似重複');
  const db = dbShape();
  const r = importBankTxToDb(db, parsedDiffPrefix, { skipSimilar: true });
  assert.equal(r.similarSkipped, 0, '★apply：同一格判準——不同前綴的真交易**不可以**被跳過（跳了＝掉帳）');
  assert.equal(r.imported, 1);
});

test('正式入口｜applyBankStatement 帶 skipSimilar：勾了跳過、沒勾全匯（r1 阻擋：接縫要有考題）', async () => {
  // ⚠️ 這題的存在理由：把 applyBankStatement 裡那行改回 importBankTxToDb(db, parsed)
  //   （完全忽略 skipSimilar），只呼叫 helper 的題全綠——「勾了卻沒跳過」正是本支最壞的結果。
  const parseIt = async () => ({ ...PARSED, referenceDate: null });
  const seed = async () => {
    const db = await getDb();
    db.accounts = []; db.transactions = structuredClone(makeDb().transactions);
    await saveDb(db);
  };
  await seed();
  const r1 = await applyBankStatement('c3lu', '', parseIt, { skipSimilar: true });
  assert.equal(r1.transactions.similarSkipped, 1, '★正式入口勾了＝要真的跳過');
  assert.equal(r1.transactions.imported, 1, '其餘照匯');
  assert.equal((await getDb()).transactions.length, 2, '落庫＝舊 1＋新 1');

  await seed();
  const r2 = await applyBankStatement('c3lu', '', parseIt, {});
  assert.equal(r2.transactions.similarSkipped, 0, '★沒勾＝照舊全匯');
  assert.equal((await getDb()).transactions.length, 3, '落庫＝舊 1＋新 2（含重複那筆）');
  // 誠實劃界：AI 憑票路線與本接縫共用同一行 importBankTxToDb 呼叫（applyBankStatement 內），
  // 票機制本身另有 ai-parse 考題；本題釘的是「opts 有沒有被傳到寫入端」這個接縫。
});

test('腳註隨勾選改口：勾著＝講「實際匯入 N−M 筆」、取消＝回到原句（r4 阻擋①）', () => {
  const on = bankPreviewFootnote({ shown: 57, similar: 48, skipSimilarChecked: true });
  assert.match(on, /57 筆中有 48 筆標「疑似重複」/u);
  assert.match(on, /實際匯入 9 筆/u, '★勾著＝要講實際會匯入幾筆——「57 筆都會匯入」是假話');
  assert.doesNotMatch(on, /就是按下確認會匯入的全部內容/u, '★勾著不可再承諾全部匯入');
  const off = bankPreviewFootnote({ shown: 57, similar: 48, skipSimilarChecked: false });
  assert.match(off, /以上 57 筆就是按下確認會匯入的全部內容/u, '取消勾選＝全部會匯入＝原句為真');
  assert.equal(bankPreviewFootnote({ shown: 9 }), '以上 9 筆就是按下確認會匯入的全部內容。',
    'similar=0 ＝原行為一字不動（既有考題的射程）');
});

test('腳註接線：勾選 onchange 用同一支純函式重算（不手拼第二句）', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public/modules/cashflow.js'), 'utf8');
  assert.match(src, /if \(skipChk\) skipChk\.onchange = \(\) => \{/u,
    '★勾選一動就要重算腳註——連同 if (skipChk) 守衛一起釘（if (false) 化＝字面還在、接線已死）');
  assert.match(src, /fn\.textContent = bankPreviewFootnote\(\{ shown: previewTx\.length/u,
    '★重算走同一支 bankPreviewFootnote——手拼第二句＝文案分家');
  assert.match(src, /skipSimilarChecked: skipChk\.checked === true/u, '★讀真勾選狀態、嚴格布林');
  assert.match(src, /skipSimilarChecked: !!c\.similar/u,
    '★初始渲染＝預設勾（有疑似重複時 checkbox 預設 checked，腳註第一眼就要講對）');
});

test('路由嚴格布林：statement.js 只認 req.body.skipSimilar === true（原始碼釘住）', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  // ⚠️ r4：要**剝掉註解**再比對——不剝的話，把正確句留在註解、程式改成 truthy 照樣過
  //    （驗行為不驗文字的固定維度；'false' 字串變 true＝錯誤跳過真交易）。
  const src = readFileSync(join(ROOT, 'lib/routes/statement.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
  assert.match(src, /skipSimilar: req\.body\.skipSimilar === true/u,
    '★路由層也要嚴格布林——服務層雖有第二道，但雙層嚴格是 useAi 的既有紀律');
  assert.doesNotMatch(src, /skipSimilar: !!req\.body\.skipSimilar|skipSimilar: Boolean\(/u,
    '★truthy 形一律紅（\'false\' 字串會變 true＝錯誤跳過真交易）');
});
