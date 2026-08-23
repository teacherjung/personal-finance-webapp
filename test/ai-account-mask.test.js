// @ts-check
// 放寬帳號遮罩判準（William 2026-08-23 裁示：**AI 照帳單原樣抄，改寫由程式做**）。
// 以前 AI 路線硬性要求遮罩帳號含半形星號：X／圓點／全形星／沒遮罩一律整份拒收，錯誤訊息還是術語——而提示詞又叫 AI
// 「照原樣抄」＝聽話的模型反而被拒。現在：X／x／圓點／全形星 → 同數量的半形星號；沒遮就不動（完整帳號原樣、末碼＝末四碼）；
// 真的看不出末碼（整串被遮）才整份先不匯入，訊息白話。
// ⚠️ 模板路線與去重鍵共用的 accountSuffix **一個位元組沒動**（只認半形星號）；寬版另立 accountSuffixAny。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-aimask-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { accountSuffix, accountSuffixAny, normalizeMaskShape, MASK_CHARS } = await import('../lib/bank-statement.js');
const { normalizeAiBank, AI_BANK_MODELS, buildBankSystem } = await import('../lib/ai-parse.js');
const { previewBankStatement, applyBankStatement, previewBalancesForDb, applyBalancesToDb, previewBankTxForDb } = await import('../lib/services/bank-import.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { clearAiTicketsForTest } = await import('../lib/ai-confirm-ticket.js');

after(() => { for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

// ---------- 純函式 ----------
test('normalizeMaskShape｜X／x／圓點／全形星／×／# → 同數量的半形星號；沒遮罩的完整帳號原樣不動；分隔符不動', () => {
  assert.equal(normalizeMaskShape('123XXXX456'), '123****456');
  assert.equal(normalizeMaskShape('123xxxx456'), '123****456');
  assert.equal(normalizeMaskShape('123••••456'), '123****456');
  assert.equal(normalizeMaskShape('123●●●456'), '123***456', '同數量（三顆就三顆）');
  assert.equal(normalizeMaskShape('900100＊＊＊＊3301'), '900100****3301');
  assert.equal(normalizeMaskShape('123××456'), '123**456', '乘號也是遮罩（Codex #504 r1#5）');
  assert.equal(normalizeMaskShape('123##456'), '123**456', '井號也是遮罩');
  assert.equal(normalizeMaskShape('900100****3301'), '900100****3301', '本來就是半形星號＝不動');
  assert.equal(normalizeMaskShape('12345678901234'), '12345678901234', '★沒遮就不動');
  assert.equal(normalizeMaskShape('900-100****3301'), '900-100****3301', '分隔符原樣（比對那邊會剝）');
  assert.equal(normalizeMaskShape('**********8791'), '**********8791');
  // MASK_CHARS 的每一個字元都真的會被改寫（兩個正則與常數同一組字元）
  for (const ch of MASK_CHARS) assert.equal(normalizeMaskShape(`123${ch}${ch}456`), '123**456', `★遮罩字元 ${JSON.stringify(ch)}`);
});

test('normalizeMaskShape｜含其他字母的字串一個字不動（X 分不出是遮罩還是帳號本文）→ 下游取不出末碼＝拒收，不會被改寫後收進來', () => {
  assert.equal(normalizeMaskShape('ABX12345678'), 'ABX12345678', '★Codex #504 r1#5：不可改成 AB*12345678');
  assert.equal(accountSuffixAny(normalizeMaskShape('ABX12345678')), '', '★英數帳號＝取不出末碼（AI 路線不收，與放寬前相同）');
  assert.equal(normalizeMaskShape('IBAN GB29NWBKXXXX1234'), 'IBAN GB29NWBKXXXX1234');
});

test('normalizeMaskShape｜全形數字折成半形（同一個數字的另一種印法，不算改寫）', () => {
  assert.equal(normalizeMaskShape('１２３４５６７８９０１２３４'), '12345678901234');
  assert.equal(accountSuffixAny(normalizeMaskShape('１２３４５６７８９０１２３４')), '1234');
});

test('accountSuffixAny｜有遮罩＝同 accountSuffix；沒遮罩的完整帳號＝末四碼；整串被遮或不是帳號長相＝空', () => {
  assert.equal(accountSuffixAny('900100****3301'), '3301');
  assert.equal(accountSuffixAny('900200****363'), '363', '三碼末碼照舊');
  assert.equal(accountSuffixAny('12345678901234'), '1234', '★沒遮＝末四碼');
  assert.equal(accountSuffixAny('123-456-789012'), '9012', '夾分隔符也算沒遮');
  assert.equal(accountSuffixAny('**********'), '', '整串被遮＝看不出末碼');
  assert.equal(accountSuffixAny('123456****'), '', '星號在尾端＝看不出末碼');
  assert.equal(accountSuffixAny('1234'), '', '太短＝不是帳號長相');
  assert.equal(accountSuffixAny('abc'), '');
  // ★模板路線與去重鍵共用的 accountSuffix 一個位元組沒動：沒遮的帳號它仍取不出（那條路永遠不會拿到沒遮的）
  assert.equal(accountSuffix('12345678901234'), '');
  assert.equal(accountSuffix('900100****3301'), '3301');
});

// ---------- AI 答案卷驗收 ----------
const answer = (/** @type {string} */ masked, /** @type {string} */ txMasked = masked) => ({
  bank: '合成一銀', referenceDate: '2026-06-30',
  accountCurrencies: [{ masked, currency: 'TWD' }],
  totals: { txCount: null, totalOut: null, totalIn: null },
  accounts: [{ masked, balance: 1500, currency: 'TWD', label: '活存', note: '' }],
  transactions: [
    { acctMasked: txMasked, date: '2026-06-01', direction: 'in', amount: 1000, balance: 1000, summary: '轉帳存入', note: '' },
    { acctMasked: txMasked, date: '2026-06-02', direction: 'out', amount: 500, balance: 500, summary: 'CD提款', note: '' },
    { acctMasked: txMasked, date: '2026-06-03', direction: 'in', amount: 1000, balance: 1500, summary: '存款息', note: '' },
  ],
});

test('★驗收：四種印法都收、存進去的是改寫後的形（X／圓點／全形星→半形星；沒遮＝原樣）', () => {
  for (const [raw, want] of [['123XXXX3301', '123****3301'], ['123••••3301', '123****3301'], ['900100＊＊＊＊3301', '900100****3301'], ['12345678903301', '12345678903301']]) {
    const p = normalizeAiBank(answer(raw));
    assert.equal(p.accounts[0].masked, want, `★${raw}`);
    assert.equal(p.accounts[0].suffix, '3301');
    assert.deepEqual(Object.keys(p.accountCurrency), [want], '幣別表的鍵也是改寫後的形（下游 exact-key 查表）');
    assert.equal(p.transactions[0].acctMasked, want);
    assert.equal(p.transactions[0].acctSuffix, '3301');
  }
});

test('★驗收：AI 同一份答案裡帳戶用全形星、交易用半形星＝改寫後同一把鍵（不會因印法不同而查無幣別）', () => {
  const p = normalizeAiBank(answer('900100＊＊＊＊3301', '900100****3301'));
  assert.equal(p.transactions[0].acctMasked, p.accounts[0].masked);
});

test('★驗收：真的看不出末碼（整串被遮）才拒收，訊息白話、不回聲帳號——三個欄位**各自**只壞那一欄（Codex #504 r1#6：壞同一份三欄永遠先在第一欄拒收＝後兩欄假綠）', () => {
  const GOOD = '900100****3301';
  /** @type {Array<[string, (a:any, bad:string)=>void, RegExp]>} */
  const breakers = [
    ['幣別表', (a, bad) => { a.accountCurrencies[0].masked = bad; }, /帳戶幣別表/],
    ['帳戶', (a, bad) => { a.accounts[0].masked = bad; }, /第 1 個帳戶/],
    ['交易', (a, bad) => { a.transactions[1].acctMasked = bad; }, /第 2 筆交易/],
  ];
  for (const [which, breakIt, where] of breakers) {
    for (const raw of ['**********', 'XXXXXXXXXX', '123456****', 'ABX12345678']) {
      const a = answer(GOOD); breakIt(a, raw);
      assert.throws(() => normalizeAiBank(a), (/** @type {any} */ e) => {
        assert.equal(e.code, 'ai_bad_answer', `${which}/${raw}`);
        assert.match(e.message, where, `★指到壞的那一欄：${which}/${raw}：${e.message}`);
        assert.match(e.message, /看不出末幾碼/, `★白話：${e.message}`);
        assert.match(e.message, /這份先不匯入/);
        assert.ok(!e.message.includes(raw) && !e.message.includes(normalizeMaskShape(raw)), `★不回聲帳號：${which}/${raw}：${e.message}`);
        assert.ok(!/masked|accountCurrencies/.test(e.message), '★沒有術語');
        return true;
      });
    }
  }
});

test('提示詞：仍叫 AI 照原樣抄、沒遮就照印完整帳號（改寫是程式的事，不是模型的事）', () => {
  const sys = buildBankSystem();
  assert.match(sys, /照帳單原樣抄/);
  assert.match(sys, /沒有遮罩就照印完整帳號/);
});

// ---------- 走完整 AI 路線 ----------
const notRecognized = async () => { throw Object.assign(new Error('這份 PDF 看起來不是台新銀行綜合對帳單'), { status: 400, code: 'bank_unrecognized' }); };
const fakeExtract = async () => [{ y: 0, cells: [{ x: 0, s: '合成帳單內文標記字串 1,000 500 1,500' }] }];
const engineOf = (/** @type {any} */ ans) => () => ({ models: AI_BANK_MODELS, parseOnce: async () => ans });
async function seedDb() {
  clearAiTicketsForTest();
  const db = await getDb();
  db.accounts = []; db.transactions = []; db.cards = [];
  db.settings.aiApiKey = 'sk-ant-synthetic-test-key';
  /** @type {any} */ (db.settings).aiDualRead = false;
  await saveDb(db);
}

test('★端到端：AI 抄成 X 遮罩的帳單 → 預覽／套用走得通；重匯時 AI 改抄全形星＝同一筆認得出重複（去重鍵存的是改寫後的形）', async () => {
  await seedDb();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(answer('900100XXXX3301')), aiExtract: fakeExtract });
  assert.equal(pv.transactions.rows.length, 3);
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(answer('900100XXXX3301')), aiExtract: fakeExtract });
  const db = await getDb();
  const refs = db.transactions.map((/** @type {any} */ t) => String(t.bankRef));
  assert.ok(refs.every((r) => r.includes('|900100****3301|')), `★去重鍵的帳號段是半形星號形：${refs[0]}`);
  // 重匯：AI 這次用全形星抄
  clearAiTicketsForTest();
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(answer('900100＊＊＊＊3301')), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.duplicate, 3, '★同一份帳單換一種遮罩符號抄＝三筆都是重複');
});

test('★端到端：帳單沒遮罩（完整帳號）→ 收、末碼＝末四碼、帳戶配得到自己登記的完整帳號；餘額走嚴格徑（整串都要對）', async () => {
  await seedDb();
  const db0 = await getDb();
  db0.accounts = [
    { id: 'mine', name: '我的一銀', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '12345678903301' },
    { id: 'other', name: '別人的', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '99999999993301' },   // 同末碼、不同帳號
  ];
  await saveDb(db0);
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(answer('12345678903301')), aiExtract: fakeExtract });
  const row = pv.rows.find((/** @type {any} */ r) => r.action === 'update');
  assert.ok(row && row.matchedName === '我的一銀', `★配到整串相同的那顆（實得 ${JSON.stringify(pv.rows.map((/** @type {any} */ r) => [r.action, r.matchedName]))}）`);
  assert.ok(!pv.rows.some((/** @type {any} */ r) => r.matchedName === '別人的'), '★同末碼不同帳號不可被蓋');
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(answer('12345678903301')), aiExtract: fakeExtract });
  const db = await getDb();
  assert.equal(db.accounts.find((/** @type {any} */ a) => a.id === 'mine').balance, 1500);
  assert.equal(db.accounts.find((/** @type {any} */ a) => a.id === 'other').balance, 1);
  assert.ok(db.transactions.every((/** @type {any} */ t) => t.account === '我的一銀'), '交易掛到自己的帳戶');
});

test('沒遮罩的帳號與既有遮罩帳戶的關係：登記的是遮罩形（900100****3301）、帳單印完整號＝前綴對得上才配；對不上＝新建', () => {
  const parsed = (/** @type {string} */ masked) => ({ bank: '合成一銀', referenceDate: '2026-06-30', accounts: [{ suffix: '3301', masked, balance: 1500, currency: 'TWD', label: '活存', note: '', kind: 'demand', period: '' }], accountCurrency: { [masked]: 'TWD' }, transactions: [] });
  const db = { accounts: [{ id: 'a', name: '登記遮罩形', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('90010011223301'))).rows[0].action, 'update', '遮罩逐位蓋得住完整號＝配得到');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('90020011223301'))).rows[0].action, 'create', '★前綴不同＝另一顆');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('9001001122333301'))).rows[0].action, 'create', '★寬度不同（四顆星蓋不住六碼）＝另一顆（Codex #504 r1#1）');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('900-100-1122-3301'))).rows[0].action, 'update', '分隔符不算寬度');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('900100112233013301'))).rows[0].action, 'create', '★可見位碰巧都對得上、但寬度不同（18 碼）＝蓋不住');
  applyBalancesToDb(db, /** @type {any} */ (parsed('90010011223301')));
  assert.equal(db.accounts[0].balance, 1500);
  // ★使用者親手填的完整帳號（沒星號）不走「前綴延伸」那條：完整對完整＝整串都要對
  const db2 = { accounts: [{ id: 'b', name: '親手填完整號', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '90010011223301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db2, /** @type {any} */ (parsed('90010099993301'))).rows[0].action, 'create', '★中段不同＝另一顆');
  const db3 = { accounts: [{ id: 'c', name: '更長的完整號', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '900100112299993301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db3, /** @type {any} */ (parsed('90010011223301'))).rows[0].action, 'create', '★登記的更長、頭尾都對得上＝仍是另一顆（完整對完整要整串全等）');
  assert.equal(previewBalancesForDb(db2, /** @type {any} */ (parsed('900100****3301'))).rows[0].action, 'update', '遮罩帳單對完整登記戶＝既有判準照舊');
});

test('★端到端：先用沒遮的完整帳號匯入，再匯同期間的遮罩版面＝去重鍵認不出（取捨 c），但疑似重複那把寬鬆尺照樣提醒', async () => {
  await seedDb();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(answer('90010011223301')), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(answer('90010011223301')), aiExtract: fakeExtract });
  clearAiTicketsForTest();
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(answer('900100****3301')), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.duplicate, 0, '遮罩對完整沒有可靠等式＝去重鍵不互認');
  assert.equal(pv2.transactions.counts.similar, 3, '★同機構＋末碼＋日期＋方向＋金額＝三筆都提醒（既有列的末碼要從完整帳號取得出來）');
});

test('★內轉判定：只在幣別表出現（餘額空白）的沒遮帳號，末碼也要算「自己的帳號」——轉給它的列是內轉、不是支出', () => {
  const raw = answer('90010011223301');
  raw.accountCurrencies.push({ masked: '99999999993302', currency: 'TWD' });   // 餘額空白的第二顆戶：只在幣別表
  raw.transactions[1] = { acctMasked: '90010011223301', date: '2026-06-02', direction: 'out', amount: 500, balance: 500, summary: '轉帳支出', note: '轉入 ****3302' };
  const parsed = normalizeAiBank(raw);
  const db = { accounts: [], transactions: [], settings: {} };
  const pv = previewBankTxForDb(db, /** @type {any} */ (parsed));
  const row = pv.rows.find((/** @type {any} */ r) => r.date === '2026-06-02');
  assert.equal(row && row.type, 'transfer', `★實得 ${JSON.stringify(row && [row.type, row.category])}`);
});

test('★疑似重複的前綴否決認得完整號：兩個不同完整號（同末碼同日同額）＝不是疑似重複、不會被預設跳過（Codex #504 r1#2）', async () => {
  await seedDb();
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(answer('90010011223301')), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(answer('90010011223301')), aiExtract: fakeExtract });
  clearAiTicketsForTest();
  const other = answer('90020011223301');
  for (const t of other.transactions) t.summary = `${t.summary}(B戶)`;   // 原文不同＝去重鍵本來就不同
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(other), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.similar, 0, '★900100 與 900200 是兩顆戶');
  const r = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv2.aiTicket, aiEngineFactory: engineOf(other), aiExtract: fakeExtract, skipSimilar: true });
  assert.equal(/** @type {any} */ (r).transactions.imported, 3, `★預設跳過疑似重複時三筆仍匯入（實得 ${JSON.stringify(/** @type {any} */ (r).transactions)}）`);
  // 遮罩蓋不住的完整號（寬度不同）也不是疑似重複
  clearAiTicketsForTest();
  const wide = answer('9001001122333301');
  for (const t of wide.transactions) t.summary = `${t.summary}(16碼)`;
  const pv3 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(wide), aiExtract: fakeExtract });
  assert.equal(pv3.transactions.counts.similar, 0);
  // 一遮一全：遮罩蓋不住既有的完整號（前綴不同、或寬度不同）＝不是疑似重複
  for (const [masked, why] of [['900300****3301', '前綴不同（庫裡是 900100 與 900200 兩顆）'], ['900100******3301', '六顆星＝16 碼、蓋不住 14 碼']]) {
    clearAiTicketsForTest();
    const m = answer(masked);
    for (const t of m.transactions) t.summary = `${t.summary}(${why})`;
    const pvm = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
    assert.equal(pvm.transactions.counts.similar, 0, `★${why}`);
  }
});

test('★交易掛名：帳單印完整號、庫裡只有「另一個完整號、末碼相同」的戶＝不可退回末碼撿它（Codex #504 r1#1）；登記只填末幾碼／多了銀行代碼的戶照舊退得到', () => {
  const parsedFor = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: answer(masked).transactions.slice(0, 1) });
  const mk = (/** @type {string} */ accountNo) => ({ accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo, bank: '合成一銀' }], transactions: [], settings: {} });
  const nameOf = (/** @type {any} */ db, /** @type {string} */ masked) => previewBankTxForDb(db, /** @type {any} */ (parsedFor(masked))).rows[0].account;
  assert.notEqual(nameOf(mk('90010011223301'), '90020011223301'), 'A戶', '★B 戶的交易不可掛到 A 戶');
  assert.equal(nameOf(mk('90010011223301'), '90010011223301'), 'A戶', '整串相同＝掛得到');
  assert.equal(nameOf(mk('3301'), '90010011223301'), 'A戶', '登記只填末四碼＝退路撿得到');
  assert.equal(nameOf(mk('812-90010011223301'), '90010011223301'), 'A戶', '登記多了銀行代碼＝退路撿得到');
  assert.equal(nameOf(mk('900100****3301'), '90010011223301'), 'A戶', '登記遮罩形、逐位蓋得住＝掛得到');
  assert.notEqual(nameOf(mk('900100****3301'), '9001001122333301'), 'A戶', '★寬度不同＝蓋不住＝不掛');
});
