// @ts-check
// 放寬帳號遮罩判準（William 2026-08-23 裁示：**AI 照帳單原樣抄，改寫由程式做**）。
// 理由：AI 路線是「模板認不得的版面」的退路，提示詞叫 AI 照原樣抄，驗收卻只認半形星號＝聽話的模型反而被整份拒收、
// 訊息還是術語。規則：X／x／圓點／全形星 → 同數量的半形星號；沒遮就不動（完整帳號原樣、末碼＝末四碼）；真的看不出末碼
// （整串被遮）才整份先不匯入，訊息白話。
// ⚠️ 模板路線與去重鍵共用的 accountSuffix 只認半形星號（本檔有考題釘它對完整號回空）；寬版另立 accountSuffixAny。
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
test('normalizeMaskShape｜X／x／圓點／全形星／× → 同數量的半形星號；沒遮罩的完整帳號原樣不動；分隔符不動；# 不是遮罩', () => {
  assert.equal(normalizeMaskShape('123XXXX456'), '123****456');
  assert.equal(normalizeMaskShape('123xxxx456'), '123****456');
  assert.equal(normalizeMaskShape('123••••456'), '123****456');
  assert.equal(normalizeMaskShape('123●●●456'), '123***456', '同數量（三顆就三顆）');
  assert.equal(normalizeMaskShape('900100＊＊＊＊3301'), '900100****3301');
  assert.equal(normalizeMaskShape('123××456'), '123**456', '乘號也是遮罩（Codex #504 r1#5）');
  assert.equal(normalizeMaskShape('123##456'), '123##456', '★井號不是遮罩（常是「帳號#」標籤；當遮罩改寫＝#12345678903301 的整串被當成末碼）');
  assert.equal(accountSuffixAny(normalizeMaskShape('#12345678903301')), '', '★帶 # 的取不出末碼＝拒收，不會存成 *1234…');
  assert.ok(!MASK_CHARS.includes('#'));
  assert.equal(normalizeMaskShape('900100****3301'), '900100****3301', '本來就是半形星號＝不動');
  assert.equal(normalizeMaskShape('12345678901234'), '12345678901234', '★沒遮就不動');
  assert.equal(normalizeMaskShape('900-100****3301'), '900-100****3301', '分隔符原樣（比對那邊會剝）');
  assert.equal(normalizeMaskShape('**********8791'), '**********8791');
  // 核准的遮罩字元清單**固定寫在考題裡**（不從正式常數導出——常數與正則一起漏掉某字元時，導出的迴圈會一起少測；r4#4）
  const APPROVED_MASK_CHARS = ['*', 'x', 'X', '•', '●', '·', '○', '◯', '×'];
  assert.deepEqual([...MASK_CHARS].sort(), [...APPROVED_MASK_CHARS].sort(), '★正式常數要與核准清單完全一致');
  for (const ch of APPROVED_MASK_CHARS) assert.equal(normalizeMaskShape(`123${ch}${ch}456`), '123**456', `★遮罩字元 ${JSON.stringify(ch)}`);
  assert.equal(normalizeMaskShape('*12345678903301'), '*12345678903301', '單一星號原樣（放寬前就收的形）');
});

test('normalizeMaskShape｜含其他字母的字串一個字不動（X 分不出是遮罩還是帳號本文）→ 下游取不出末碼＝拒收，不會被改寫後收進來', () => {
  assert.equal(normalizeMaskShape('ABX12345678'), 'ABX12345678', '★Codex #504 r1#5：不可改成 AB*12345678');
  assert.equal(accountSuffixAny(normalizeMaskShape('ABX12345678')), '', '★英數帳號＝取不出末碼（AI 路線不收，與放寬前相同）');
  assert.equal(normalizeMaskShape('IBAN GB29NWBKXXXX1234'), 'IBAN GB29NWBKXXXX1234');
  assert.equal(normalizeMaskShape('123X456'), '123X456', '★單一個 X 可能是帳號本文／檢查碼＝不當遮罩（r2#5）');
  assert.equal(accountSuffixAny(normalizeMaskShape('123X456')), '', '★取不出末碼＝拒收');
  assert.equal(normalizeMaskShape('123XX456'), '123**456', '連續兩個以上才是遮罩（已知取捨：帳號本文真的連續兩個 X 會被誤當遮罩——支援 X 遮罩就分不出，契約記載）');
});

test('normalizeMaskShape｜全形數字折成半形（同一個數字的另一種印法，不算改寫）', () => {
  assert.equal(normalizeMaskShape('１２３４５６７８９０１２３４'), '12345678901234');
  assert.equal(accountSuffixAny(normalizeMaskShape('１２３４５６７８９０１２３４')), '1234');
  assert.equal(normalizeMaskShape('９００１００＊＊＊＊３３０１'), '900100****3301', '全形星與全形數字一起折');
  // ⚠️ 只折全形 ASCII 區：圈號數字／上標數字不是同一個字＝不折＝取不出末碼＝拒收（r8#4：整串 NFKC 會把 ①2345678903301 折成另一顆戶的完整號）
  for (const raw of ['①2345678903301', '1²345678903301']) {
    assert.equal(normalizeMaskShape(raw), raw, `★不折：${raw}`);
    assert.equal(accountSuffixAny(normalizeMaskShape(raw)), '', `★拒收：${raw}`);
  }
  assert.equal(normalizeMaskShape('⑨00100****3301'), '⑨00100****3301', '帶星號的：⑨ 不折（文法閘會整個拒收）');
});

test('x 緊鄰星號＝遮罩的一部分（x****3301 → *****3301，與 bankRefBase 的佔位同形＝都是「只比末碼」）；不緊鄰星號的單一個 x 是字面（r8#3）', () => {
  assert.equal(normalizeMaskShape('x****3301'), '*****3301');
  assert.equal(normalizeMaskShape('****x3301'), '*****3301');
  assert.equal(normalizeMaskShape('x123'), 'x123');
  assert.equal(accountSuffixAny(normalizeMaskShape('x123')), '');
  assert.equal(normalizeMaskShape('*1234'), '*1234', '單一個星號原樣');
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

test('沒遮罩的帳號與既有遮罩帳戶的關係：登記的是遮罩形（900100****3301）、帳單印完整號＝頭尾對得上也只能「證明不了」停手（r5#1）；對不上＝新建', () => {
  const parsed = (/** @type {string} */ masked) => ({ bank: '合成一銀', referenceDate: '2026-06-30', accounts: [{ suffix: '3301', masked, balance: 1500, currency: 'TWD', label: '活存', note: '', kind: 'demand', period: '' }], accountCurrency: { [masked]: 'TWD' }, transactions: [] });
  const db = { accounts: [{ id: 'a', name: '登記遮罩形', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('90010011223301'))).rows[0].action, 'ambiguous', '★登記的遮罩是自動建戶抄來的，證明不了它就是這個完整號（可能是 …1111… 也可能是 …9999…）＝停手');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('90010099993301'))).rows[0].action, 'ambiguous', '★r5#1 的反例：不可 update');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('90020011223301'))).rows[0].action, 'create', '★前綴不同＝另一顆');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('9001001122333301'))).rows[0].action, 'ambiguous', '星號數不是證據（repo 既有考題就用四顆星配 15 碼）：頭尾對上＝相容＝一樣停手');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('900-100-1122-3301'))).rows[0].action, 'ambiguous', '分隔符剝掉再比');
  applyBalancesToDb(db, /** @type {any} */ (parsed('90010099993301')));
  assert.equal(db.accounts.length, 1, '★停手＝不新建');
  assert.equal(db.accounts[0].balance, 1, '★停手＝不蓋');
  // 三碼末碼的印法（900300****162）對完整號 …3162：末碼長度不同也一樣停手、不可拆成兩顆（r2#2：兩顆餘額都進資產＝多算一份）
  const db162 = { accounts: [{ id: 'a', name: '登記遮罩形', type: 'cash', currency: 'TWD', balance: 100, balanceAsOf: '2026-05-31', accountNo: '900300****162', bank: '合成一銀' }], transactions: [], settings: {} };
  const p162 = { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [{ suffix: '3162', masked: '90030011223162', balance: 1500, currency: 'TWD', label: '活存', note: '', kind: 'demand', period: '' }], accountCurrency: { '90030011223162': 'TWD' }, transactions: [] };
  assert.equal(previewBalancesForDb(db162, /** @type {any} */ (p162)).rows[0].action, 'ambiguous', '★可見頭尾都對上＝相容＝停手');
  applyBalancesToDb(db162, /** @type {any} */ (p162));
  assert.equal(db162.accounts.length, 1, '★沒有新建第二顆');
  assert.equal(db162.accounts[0].balance, 100, '★也沒有蓋');
  // 使用者到資產頁把帳號補成完整號之後＝完整對完整全等＝命中
  db.accounts[0].accountNo = '90010099993301';
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('90010099993301'))).rows[0].action, 'update', '★補完整後就命中');
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
  // 一遮一全：可見頭尾任一對不上、或完整號沒比頭尾更長（沒藏到任何一碼）＝不是疑似重複；頭尾都對上＝疑似重複（與餘額身分那把同一把尺、不驗「藏幾碼＝幾顆星」）
  for (const [masked, why, want] of [
    ['900300****3301', '前綴不同（庫裡是 900100 與 900200 兩顆）', 0],
    ['900100****2301', '末碼不同', 0],
    ['**********2301', '看不到前綴、但末碼 2301 對 3301 不一致', 0],
    ['**********3301', '看不到前綴、末碼一致＝提醒', 3],
    ['900100******3301', '六顆星對 14 碼完整號＝頭尾都對上＝疑似重複（星號數不是證據；與身分那把同強度）', 3],
  ]) {
    clearAiTicketsForTest();
    const m = answer(masked);
    for (const t of m.transactions) t.summary = `${t.summary}(${why})`;
    const pvm = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
    assert.equal(pvm.transactions.counts.similar, want, `★${why}`);
  }
});

test('已知取捨 (c′)：同一顆戶在兩種版面印成不同末碼長度（900300****162 對完整號 …3162）＝去重鍵與疑似重複都認不出（會匯兩次）；內轉判定只比末四碼、與遮罩自有帳戶同一個精度（r2#3）', async () => {
  await seedDb();
  const m = answer('900300****162');
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  clearAiTicketsForTest();
  const full = answer('90030011223162');
  for (const t of full.transactions) t.summary = `${t.summary}(完整號印法)`;
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(full), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.duplicate, 0);
  assert.equal(pv2.transactions.counts.similar, 0, '取捨 (c′)：末碼 162 對 3162、寬度 13 對 14＝兩把尺都認不出（寬一分的代價是預設跳過真交易，選擇不放寬）');
  // 內轉精度對照：自有帳戶是遮罩形或完整號，對同一條備註要給同一個答案
  const classify = (/** @type {string} */ own, /** @type {string} */ note) => {
    const raw = answer(own);
    raw.transactions[1] = { acctMasked: own, date: '2026-06-02', direction: 'out', amount: 500, balance: 500, summary: '轉帳支出', note };
    const row = previewBankTxForDb({ accounts: [], transactions: [], settings: {} }, /** @type {any} */ (normalizeAiBank(raw))).rows.find((/** @type {any} */ r) => r.date === '2026-06-02');
    return row && row.type;
  };
  assert.equal(classify('90010011223301', '轉入 ****301'), classify('900100****3301', '轉入 ****301'), '★末三碼的備註：完整號與遮罩自有戶同一個判法');
  assert.equal(classify('90010011223301', '轉入 ****301'), 'expense', '★只比末四碼＝ 301 不算自己的（r2#3：加末三碼會把轉到別人尾碼 301 戶的真支出排出收支）');
  assert.equal(classify('90010011223301', '轉入 ****3301'), 'transfer');
  assert.equal(classify('900100****3301', '轉入 ****3301'), 'transfer');
});

test('★登記遮罩形對遮罩帳單：可見前綴逐段比，不可把登記的前後段數字串起來再 startsWith（r2#1：9001****3301 串成 90013301、對 900133 拼出不存在的相鄰）', () => {
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  const mk = (/** @type {string} */ accountNo) => ({ accounts: [{ id: 'a', name: '舊戶', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo, bank: '合成一銀' }], transactions: [], settings: {} });
  const act = (/** @type {string} */ reg, /** @type {string} */ stmt) => previewBalancesForDb(mk(reg), /** @type {any} */ (parsed(stmt))).rows[0].action;
  assert.equal(act('9001****3301', '900133XXXX3301'), 'ambiguous', '★帳單前綴更長、以登記前綴開頭＝登記的證明不了＝停手');
  assert.equal(act('9001****3301', '900199****3301'), 'ambiguous');
  assert.equal(act('9001****3301', '9002****3301'), 'create', '前綴不同＝另一顆');
  assert.equal(act('900133****3301', '9001****3301'), 'ambiguous', '★相容≠命中（r3#1）：9001****3301 只代表「某個 9001 開頭 3301 結尾的戶」，不能證明就是 900133 那顆');
  assert.equal(act('900100****3301', '900100****3301'), 'update', '比對形全等＝命中');
  assert.equal(act('900-100****3301', '900100XXXX3301'), 'update', '分隔符與遮罩字元差異＝同一個比對形');
  assert.equal(act('**********3301', '900100****3301'), 'ambiguous', '★登記看不到前綴（AI 全星號帳單自動建的、沒標記）＝相容但證明不了＝停手（Stage 1 標記戶另走寬鬆徑補登）');
  // 可見字母是身分的一部分，不可剝掉再比（r2#1／r3#1）
  assert.equal(act('AB****5678', '12345678'), 'create', '★AB****5678 對 12345678：AB 是可見位、對不上');
  assert.equal(act('12345678', 'AB****5678'), 'create', '★反向：登記純數字、帳單 AB 遮罩＝AB 不是空前綴');
  assert.equal(act('AB12345678', '12345678'), 'create', '★完整對完整＝比對形全等，不是只比數字');
});

test('★多顆候選＝停手（r3#1）：兩顆相容戶取第一顆、全星號（XXXXXXXXXX3301 改寫後）同末碼多戶取第一顆，都不可；餘額不動、帳戶數不變、交易掛 autoName', async () => {
  const two = (/** @type {string} */ x, /** @type {string} */ y) => ({ accounts: [
    { id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 10, balanceAsOf: '2026-05-31', accountNo: x, bank: '合成一銀' },
    { id: 'b', name: 'B戶', type: 'cash', currency: 'TWD', balance: 20, balanceAsOf: '2026-05-31', accountNo: y, bank: '合成一銀' },
  ], transactions: [], settings: {} });
  for (const [x, y, stmt, why] of [
    ['900133****3301', '900144****3301', '9001****3301', '兩顆都相容、都證明不了'],
    ['900100****3301', '900200****3301', 'XXXXXXXXXX3301', '全星號（AI 原樣抄 X、改寫成星號）同末碼兩戶'],
    ['900100****3301', '9001****3301', '900100****3301', '一顆命中、一顆相容＝並存也停手'],
  ]) {
    const db = two(x, y);
    const parsed = normalizeAiBank(answer(stmt));
    assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed)).rows[0].action, 'ambiguous', `★${why}`);
    applyBalancesToDb(db, /** @type {any} */ (parsed));
    assert.deepEqual(db.accounts.map((/** @type {any} */ a) => a.balance), [10, 20], `★餘額不動：${why}`);
    assert.equal(db.accounts.length, 2, `★帳戶數不變：${why}`);
    const rows = previewBankTxForDb(db, /** @type {any} */ (parsed)).rows;
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(r.account, '合成一銀 3301（活存）', `★交易掛帳單概要的 autoName、不掛既有戶（實得 ${r.account}）：${why}`);
  }
  // 對照：只有一顆＝登記完整號才命中；登記是另一個遮罩形＝有交集也只能停手（r9#1：存在可能相同≠證明相同）
  const full1 = { accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 10, balanceAsOf: '2026-05-31', accountNo: '90010011223301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(full1, /** @type {any} */ (normalizeAiBank(answer('XXXXXXXXXX3301')))).rows[0].action, 'update');
  const mask1 = { accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 10, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(mask1, /** @type {any} */ (normalizeAiBank(answer('XXXXXXXXXX3301')))).rows[0].action, 'ambiguous', '★登記遮罩形對全星號帳單＝停手');
  const mask301 = { accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 100, balanceAsOf: '2026-05-31', accountNo: '9001****301', bank: '合成一銀' }], transactions: [], settings: {} };
  const p3301 = normalizeAiBank(answer('****3301'));
  assert.equal(previewBalancesForDb(mask301, /** @type {any} */ (p3301)).rows[0].action, 'ambiguous', '★r9#1 的反例：9001****301 對 ****3301 不可 update');
  applyBalancesToDb(mask301, /** @type {any} */ (p3301));
  assert.equal(mask301.accounts[0].balance, 100);
  assert.equal(mask301.accounts.length, 1);
  assert.equal(previewBankTxForDb(mask301, /** @type {any} */ (p3301)).rows[0].account, '合成一銀 3301（活存）', '★交易不掛 A 戶');
  assert.equal(previewBalancesForDb(mask1, /** @type {any} */ (normalizeAiBank(answer('900100****3301')))).rows[0].action, 'update', '比對形全等＝命中');
});

test('★雙讀比對保留可見字母（r3#2）：AB****5678 對 CD****5678＝衝突，不可因剝掉字母而「一致」', async () => {
  const { maskedCmp, aiAnswersAgree } = await import('../lib/ai-parse.js');
  assert.equal(maskedCmp('AB****5678', 'CD****5678'), 'conflict');
  assert.equal(maskedCmp('AB****5678', '12345678'), 'conflict');
  assert.equal(maskedCmp('900100XXXX3301', '900-100****3301'), 'same', '遮罩字元與分隔符的印法差異＝同一個');
  const a = answer('AB****5678'), b = answer('CD****5678');
  const v = aiAnswersAgree(a, b);
  assert.equal(v.agree, false, `★兩個模型抄出不同帳戶＝不一致（實得 ${JSON.stringify(v)}）`);
});

test('★分隔符：`900-100XXXX3301` 的可見前綴不可因為連字號而變成空（空＝任何同末碼的戶都配得上）；親手填的 X 遮罩登記戶對完整號帳單也配得到', () => {
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  const db = { accounts: [{ id: 'b', name: 'B戶', type: 'cash', currency: 'TWD', balance: 77, balanceAsOf: '2026-05-31', accountNo: '90020011223301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('900-100XXXX3301'))).rows[0].action, 'create', '★900-100 不是 900200 那顆');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('900-200****3301'))).rows[0].action, 'update', '連字號剝掉後 900200 配得到');
  const db2 = { accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '900100XXXX3301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db2, /** @type {any} */ (parsed('90010011223301'))).rows[0].action, 'ambiguous', '★親手填 X 遮罩＝同一把改寫再比（相容＝停手，與星號遮罩同）');
  assert.equal(previewBalancesForDb(db2, /** @type {any} */ (parsed('90020011223301'))).rows[0].action, 'create');
  assert.equal(previewBalancesForDb(db2, /** @type {any} */ (parsed('900100XXXX3301'))).rows[0].action, 'update', '遮罩對遮罩比對形全等＝命中');
});


test('★交易掛名：帳單印完整號、庫裡只有「另一個完整號、末碼相同」的戶＝不可退回末碼撿它（Codex #504 r1#1）；只有「登記的數字＝末碼本身」才退得到，銀行代碼前置／較短號／遮罩形都 autoName', () => {
  const parsedFor = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: answer(masked).transactions.slice(0, 1) });
  const mk = (/** @type {string} */ accountNo) => ({ accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo, bank: '合成一銀' }], transactions: [], settings: {} });
  const nameOf = (/** @type {any} */ db, /** @type {string} */ masked) => previewBankTxForDb(db, /** @type {any} */ (parsedFor(masked))).rows[0].account;
  assert.notEqual(nameOf(mk('90010011223301'), '90020011223301'), 'A戶', '★B 戶的交易不可掛到 A 戶');
  assert.equal(nameOf(mk('90010011223301'), '90010011223301'), 'A戶', '整串相同＝掛得到');
  assert.equal(nameOf(mk('3301'), '90010011223301'), 'A戶', '登記只填末四碼（數字＝末碼本身）＝退路撿得到');
  const withOther = { accounts: [...mk('3301').accounts, { id: 'z', name: 'Z戶', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '900200****4402', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBankTxForDb(withOther, /** @type {any} */ (parsedFor('90010011223301'))).rows[0].account, 'A戶', '同機構另一顆不同末碼的戶不影響退路（恰一顆是看同末碼）');
  assert.notEqual(nameOf(mk('11223301'), '90010011223301'), 'A戶', '★較短但比末碼長的號＝分不出是只填末幾碼還是另一顆短帳號（r5#3）＝不撿');
  assert.notEqual(nameOf(mk('812-90010011223301'), '90010011223301'), 'A戶', '登記多了銀行代碼＝證明不了＝不撿（autoName）');
  assert.notEqual(nameOf(mk('900100****3301'), '90010011223301'), 'A戶', '★登記遮罩形對完整號＝相容但證明不了＝不掛');
  assert.notEqual(nameOf(mk('900100****3301'), '9001001122333301'), 'A戶');
  assert.notEqual(nameOf(mk('9001****3301'), '77777790013301'), 'A戶', '★登記遮罩形的數字 90013301 是完整號的尾段、卻不是同一顆（r2#1）：退路不准撿遮罩形');
});

test('★Stage 1 標記戶（金融卡先建、只知末四碼）對 AI 完整號帳單／連字號遮罩帳單：寬鬆徑照樣認親並補登（maskedParts 要認得完整號與連字號，否則前綴當空＝寬鬆徑被跳過＝裂戶）', () => {
  const mk = () => ({ accounts: [{ id: 'd', name: '金融卡建的', type: 'cash', currency: 'TWD', balance: 5, balanceAsOf: '2026-05-31', accountNo: '3301', accountNoSuffixOnly: true, bank: '合成一銀' }], transactions: [], settings: {} });
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  for (const stmt of ['90010011223301', '900-100****3301']) {
    const db = mk();
    assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed(stmt))).rows[0].action, 'update', `★${stmt}：標記戶唯一＝認親`);
    applyBalancesToDb(db, /** @type {any} */ (parsed(stmt)));
    assert.equal(db.accounts.length, 1, `★${stmt}：不裂戶`);
    assert.equal(db.accounts[0].accountNo, stmt, `★${stmt}：補登成帳單的帳號`);
    assert.equal(db.accounts[0].accountNoSuffixOnly, undefined, '標記清掉');
  }
});

test('★幣別退路也走裁決器：兩顆同號登記戶（JPY／TWD）分不出＝當沒有（TWD），不可取第一顆', () => {
  const db = { accounts: [
    { id: 'j', name: '日圓', type: 'cash', currency: 'JPY', balance: 1, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '合成一銀' },
    { id: 't', name: '台幣', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '合成一銀' },
  ], transactions: [], settings: {} };
  const parsed = { bank: '合成一銀', referenceDate: '2026-06-30', accounts: [], accountCurrency: {}, transactions: [
    { acctMasked: '900100****3301', acctSuffix: '3301', date: '2026-06-01', direction: 'in', amount: 1000, balance: 1000, summary: '轉帳存入', note: '' },
  ] };
  const pv = previewBankTxForDb(db, /** @type {any} */ (parsed));
  assert.equal(pv.rows.length, 1);
  assert.equal(pv.rows[0].foreign, false, `★分不出＝不當外幣丟掉（實得 ${JSON.stringify(pv.rows[0])}）`);
  db.accounts.shift();   // 只剩台幣戶＝唯一命中
  assert.equal(previewBankTxForDb(db, /** @type {any} */ (parsed)).rows[0].foreign, false);
  db.accounts[0].currency = 'JPY';   // 唯一命中且是外幣＝外幣
  assert.equal(previewBankTxForDb(db, /** @type {any} */ (parsed)).rows[0].foreign, true);
});

test('★五碼以上的純末碼祖父鍵（bank|12345|…）仍要被疑似重複認得（r4#2：寬版別名不可把祖父鍵截成四碼）', async () => {
  await seedDb();
  const db0 = await getDb();
  db0.transactions = [
    { id: 'old1', ledger: 'cashflow', source: 'bank', date: '2026-06-01', type: 'income', category: '其他收入', subcategory: '', amount: 1000, account: '舊戶', note: '舊版摘要', bankRef: 'bank|12345|2026-06-01|in|1000|1000|舊版摘要|' },
  ];
  await saveDb(db0);
  // 台新（bank| 祖父格式）、帳單印五碼末碼
  const a = { ...answer('900100****12345'), bank: '台新' };
  a.transactions = [{ acctMasked: '900100****12345', date: '2026-06-01', direction: 'in', amount: 1000, balance: 1000, summary: '新版摘要', note: '' }];
  a.accounts[0].balance = 1000;
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(a), aiExtract: fakeExtract });
  assert.equal(pv.transactions.counts.duplicate, 0, '摘要不同＝去重鍵不同');
  assert.equal(pv.transactions.counts.similar, 1, `★祖父鍵 12345 解讀成末碼＝提醒（實得 ${JSON.stringify(pv.transactions.counts)}）`);
  const r = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(a), aiExtract: fakeExtract, skipSimilar: true });
  assert.equal(/** @type {any} */ (r).transactions.similarSkipped, 1, '★預設跳過＝不多算現金流');
});

test('★金融卡計畫的「帳戶那邊早就帶分類記過」擋門靠去重鍵格式判來源：bank2 完整號列算、bank| 純數字段當祖父末碼（r4#2／r7#3）', async () => {
  const MASKED = '**********8791';
  const parsed = {
    bank: '台新', referenceDate: '2026-01-31',
    accounts: [{ suffix: '8791', masked: MASKED, balance: 9695, currency: 'TWD', label: '簽帳金融卡', note: '', kind: 'demand', period: '', suffixOnly: true, balanceFromDetail: true }],
    accountCurrency: { [MASKED]: 'TWD' },
    transactions: [{ acctSuffix: '8791', acctMasked: MASKED, date: '2026-01-28', summary: '刷卡消費', direction: 'out', amount: 305, balance: 9695, note: '合成商店Ａ' }],
    cardRows: [{ postDate: '2026-01-28', date: '2026-01-27', amount: 305, fee: 0, lastFour: '8808', desc: '合成商店Ａ', region: 'TW', extra: '' }],
  };
  for (const [ref, why] of [
    ['bank2|台新|90010011228791|2026-01-28|out|305|9695|刷卡消費|合成商店Ａ', 'bank2 格式的完整號列＝末四碼解讀'],
    ['bank2|台新|900-100-1122-8791|2026-01-28|out|305|9695|刷卡消費|合成商店Ａ', 'bank2 格式、AI 照抄分隔符＝先剝再讀'],
    ['bank|18791|2026-01-28|out|305|9695|刷卡消費|合成商店Ａ', 'bank| 格式的五碼純數字＝祖父末碼 18791 ≠ 8791＝不算（r7#3：不可截成四碼冒充）'],
    ['bank|90010011228791|2026-01-28|out|305|9695|刷卡消費|合成商店Ａ', 'bank| 格式的長純數字也當祖父末碼讀＝不算（取捨 d′）'],
    ['bank|2791|2026-01-28|out|305|9695|刷卡消費|合成商店Ａ', '四碼祖父鍵 2791 ≠ 8791＝不算'],
  ]) {
    await seedDb();
    const db0 = await getDb();
    db0.transactions = [{ id: 'x', ledger: 'cashflow', source: 'bank', date: '2026-01-28', type: 'expense', category: '餐飲', subcategory: '', amount: 305, account: 'A', note: '合成商店Ａ', bankRef: ref, bankSummary: '刷卡消費', bankNote: '合成商店Ａ', dir: 'out' }];
    await saveDb(db0);
    const r = await previewBankStatement('QUJD', '', async () => /** @type {any} */ (parsed));
    const want = why.includes('不算') ? 0 : 1;
    assert.equal(r.cardLedger.notRecorded.cashflowCategorized, want, `★${why}（實得 ${JSON.stringify(r.cardLedger.notRecorded)}）`);
  }
  // 五碼祖父鍵且末碼真的是帳單的五碼末碼（****18791）：兩種解讀都收＝擋得住
  const parsed5 = { ...parsed, accounts: [{ ...parsed.accounts[0], suffix: '18791', masked: '*********18791' }], accountCurrency: { '*********18791': 'TWD' },
    transactions: [{ ...parsed.transactions[0], acctSuffix: '18791', acctMasked: '*********18791' }] };
  await seedDb();
  const db1 = await getDb();
  db1.transactions = [{ id: 'x', ledger: 'cashflow', source: 'bank', date: '2026-01-28', type: 'expense', category: '餐飲', subcategory: '', amount: 305, account: 'A', note: '合成商店Ａ', bankRef: 'bank|18791|2026-01-28|out|305|9695|刷卡消費|合成商店Ａ', bankSummary: '刷卡消費', bankNote: '合成商店Ａ', dir: 'out' }];
  await saveDb(db1);
  const r5 = await previewBankStatement('QUJD', '', async () => /** @type {any} */ (parsed5));
  assert.equal(r5.cardLedger.notRecorded.cashflowCategorized, 1, `★五碼祖父鍵對五碼末碼＝擋得住（實得 ${JSON.stringify(r5.cardLedger.notRecorded)}）`);
});

test('★一遮一全至少要藏一碼（r4#1）：900100****3301 對 10 碼的 9001003301＝不是同一顆（餘額不蓋、不掛名、不當疑似重複）', async () => {
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  const db = { accounts: [{ id: 'a', name: '遮罩戶', type: 'cash', currency: 'TWD', balance: 10, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('9001003301'))).rows[0].action, 'create', '★零藏碼＝不是');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('90010013301'))).rows[0].action, 'ambiguous', '藏一碼＝相容（停手）');
  await seedDb();
  const m = answer('900100****3301');
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  clearAiTicketsForTest();
  const ten = answer('9001003301');
  for (const t of ten.transactions) t.summary = `${t.summary}(10碼)`;
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(ten), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.similar, 0, '★零藏碼＝不是疑似重複（預設跳過會吃掉真交易）');
  assert.equal(pv2.rows[0].action, 'create', '★餘額那邊也判成另一顆（autoName 與第一顆同名是既有的命名取捨，不在本支）');
});


test('★疑似重複的方向性（r5#1）：既有列是遮罩、新列是完整號＝證明不了＝不算疑似重複（算了會被預設跳過、吃掉另一顆戶的真交易）；反向（既有完整號、新列遮罩）照算', async () => {
  await seedDb();
  const m = answer('900100****3301');
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  clearAiTicketsForTest();
  const full = answer('90010099993301');
  for (const t of full.transactions) t.summary = `${t.summary}(另一顆)`;
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(full), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.similar, 0, '★不算');
  const r = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv2.aiTicket, aiEngineFactory: engineOf(full), aiExtract: fakeExtract, skipSimilar: true });
  assert.equal(/** @type {any} */ (r).transactions.imported, 3, '★預設跳過也不會吃掉');
});

test('★去重鍵帳號段帶分隔符的完整號（AI 照抄 900-100-1122-3301）：疑似重複索引與金融卡擋門都要認得（r5#2）', async () => {
  await seedDb();
  const dashed = answer('900-100-1122-3301');
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(dashed), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(dashed), aiExtract: fakeExtract });
  const db = await getDb();
  assert.ok(db.transactions.every((/** @type {any} */ t) => String(t.bankRef).includes('|900-100-1122-3301|')), '去重鍵照抄分隔符（既有設計）');
  clearAiTicketsForTest();
  const plain = answer('90010011223301');
  for (const t of plain.transactions) t.summary = `${t.summary}(沒分隔符)`;
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(plain), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.similar, 3, `★同一顆戶的兩種印法＝提醒（實得 ${JSON.stringify(pv2.transactions.counts)}）`);
  // 金融卡擋門：既有列帳號段帶分隔符
  const MASKED = '**********3301';
  const parsedCard = {
    bank: '合成一銀', referenceDate: '2026-06-30',
    accounts: [{ suffix: '3301', masked: MASKED, balance: 500, currency: 'TWD', label: '簽帳金融卡', note: '', kind: 'demand', period: '', suffixOnly: true, balanceFromDetail: true }],
    accountCurrency: { [MASKED]: 'TWD' },
    transactions: [{ acctSuffix: '3301', acctMasked: MASKED, date: '2026-06-02', summary: '刷卡消費', direction: 'out', amount: 500, balance: 500, note: '合成商店' }],
    cardRows: [{ postDate: '2026-06-02', date: '2026-06-01', amount: 500, fee: 0, lastFour: '8808', desc: '合成商店', region: 'TW', extra: '' }],
  };
  const db2 = await getDb();
  db2.transactions = [{ id: 'x', ledger: 'cashflow', source: 'bank', date: '2026-06-02', type: 'expense', category: '餐飲', subcategory: '', amount: 500, account: 'A', note: '合成商店', bankRef: 'bank2|合成一銀|900-100-1122-3301|2026-06-02|out|500|500|刷卡消費|合成商店', bankSummary: '刷卡消費', bankNote: '合成商店', dir: 'out' }];
  await saveDb(db2);
  const r = await previewBankStatement('QUJD', '', async () => /** @type {any} */ (parsedCard));
  assert.equal(r.cardLedger.notRecorded.cashflowCategorized, 1, `★帶分隔符的完整號列也擋得住（實得 ${JSON.stringify(r.cardLedger.notRecorded)}）`);
});

test('★多段遮罩的中間可見碼也要比（r6#1）：900100**22**3301 對 9001009911993301 的 22 與 11 衝突＝不是；字母段同理；疑似重複同一支', async () => {
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  const mk = (/** @type {string} */ accountNo) => ({ accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 111, balanceAsOf: '2026-05-31', accountNo, bank: '合成一銀' }], transactions: [], settings: {} });
  const act = (/** @type {string} */ reg, /** @type {string} */ stmt) => previewBalancesForDb(mk(reg), /** @type {any} */ (parsed(stmt))).rows[0].action;
  assert.equal(act('9001009911993301', '900100**22**3301'), 'create', '★中段 22 對 11 衝突');
  assert.equal(act('9001009911993301', '900100**11**3301'), 'update', '中段 11 對上＝命中（登記完整號是身分）');
  assert.equal(act('9001009911993301', '900100**99**3301'), 'create', '★99 要在「藏至少一碼之後、3301 之前再藏至少一碼」——這個完整號排不出來＝不是');
  assert.equal(act('9001009911993301', '9001**9911**3301'), 'update', '藏 00、見 9911、藏 99＝排得出來＝命中');
  assert.equal(act('9001009911993301', '9001009911993301'), 'update');
  // 遮罩對遮罩＝語言有沒有交集：900100**11**3301 與 900100**22**3301 同時描述 900100a11b22c3301＝相容＝停手（r7#2：「中段全等」那條手寫規則是錯的）
  assert.equal(act('900100**11**3301', '900100**22**3301'), 'ambiguous', '★兩個遮罩語言有交集＝證明不了不同＝停手、不可新建');
  assert.equal(act('9001**11**3301', '9001**9911**3301'), 'ambiguous', '★r7#2 的反例：兩者同時描述 90015991173301');
  assert.equal(act('900100**11**3301', '900100****3301'), 'ambiguous', '段數不同＝相容＝停手');
  assert.equal(act('900100**11**3301', '900200**11**3301'), 'create', '前綴字面衝突＝沒有交集＝另一顆');
  assert.equal(act('9001**3301', '90012**3301'), 'ambiguous', '9001 與 90012 開頭相容（90012x3301 同時符合）');
  assert.equal(act('90013**3301', '90012**3301'), 'create', '第五碼 3 對 2 衝突＝沒有交集');
  // 疑似重複
  await seedDb();
  const full = answer('9001009911993301');
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(full), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(full), aiExtract: fakeExtract });
  for (const [masked, want] of [['900100**22**3301', 0], ['900100**11**3301', 3]]) {
    clearAiTicketsForTest();
    const m = answer(masked);
    for (const t of m.transactions) t.summary = `${t.summary}(${masked})`;
    const pvm = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
    assert.equal(pvm.transactions.counts.similar, want, `★${masked}`);
  }
});

test('★登記看不到前綴的遮罩（****3301，AI 全星號帳單自動建的、沒標記）對完整號帳單＝相容＝停手，不裂戶；疑似重複也不算（r6#2）', async () => {
  await seedDb();
  const allStar = answer('**********3301');
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(allStar), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(allStar), aiExtract: fakeExtract });
  const db1 = await getDb();
  assert.equal(db1.accounts.length, 1);
  assert.equal(db1.accounts[0].accountNo, '**********3301');
  assert.notEqual(db1.accounts[0].accountNoSuffixOnly, true, '前提：AI 路線建的全星號戶沒有 Stage 1 標記');
  clearAiTicketsForTest();
  const full = answer('90010099993301');
  for (const t of full.transactions) t.summary = `${t.summary}(完整號)`;
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(full), aiExtract: fakeExtract });
  assert.equal(pv2.rows[0].action, 'ambiguous', '★不可 create（同戶裂兩顆、資產多算）');
  assert.equal(pv2.transactions.counts.similar, 0, '★既有列是遮罩、新列完整號＝不算疑似重複');
  const r = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv2.aiTicket, aiEngineFactory: engineOf(full), aiExtract: fakeExtract, skipSimilar: true });
  assert.equal(/** @type {any} */ (r).transactions.imported, 3, '★預設跳過也不吃掉');
  const db2 = await getDb();
  assert.equal(db2.accounts.length, 1, '★沒有第二顆');
  assert.equal(db2.accounts[0].balance, 1500, '第一次匯入的餘額沒被第二份蓋掉…');
});

test('★Stage 1 標記戶的真實形狀（**********1234 ＋ accountNoSuffixOnly）對完整號帳單：不進裁決器、寬鬆徑認親並補登', () => {
  const db = { accounts: [{ id: 'd', name: '金融卡建的', type: 'cash', currency: 'TWD', balance: 5, balanceAsOf: '2026-05-31', accountNo: '**********1234', accountNoSuffixOnly: true, bank: '合成一銀' }], transactions: [], settings: {} };
  const parsed = normalizeAiBank({ ...answer('90010011221234'), transactions: [] });
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed)).rows[0].action, 'update');
  applyBalancesToDb(db, /** @type {any} */ (parsed));
  assert.equal(db.accounts.length, 1);
  assert.equal(db.accounts[0].accountNo, '90010011221234', '★補登成完整號');
  assert.equal(db.accounts[0].accountNoSuffixOnly, undefined);
});

test('★看不到前綴的多段遮罩（****22**3301）不可走「只比末碼」（r7#1）：對沒有 22 的完整號＝不是；疑似重複對 ****11**3301＝不算；中段字母也比（r7#4）', async () => {
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  const mk = (/** @type {string} */ accountNo) => ({ accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo, bank: '合成一銀' }], transactions: [], settings: {} });
  const act = (/** @type {string} */ reg, /** @type {string} */ stmt) => previewBalancesForDb(mk(reg), /** @type {any} */ (parsed(stmt))).rows[0].action;
  assert.equal(act('9001009911993301', '****22**3301'), 'create', '★完整號裡沒有 22＝不是');
  assert.equal(act('9001009911993301', '****11**3301'), 'update', '11 在藏至少一碼之後、3301 之前再藏至少一碼＝蓋得住＝命中（登記完整號是身分）');
  assert.equal(act('9001009911993301', '****3301'), 'update', '單段全星號＝只比末碼（既有語意）');
  // 中段字母
  assert.equal(act('AB12CD345678', 'AB**CD**5678'), 'update', '★中段 CD 對上');
  assert.equal(act('AB12ZZ345678', 'AB**CD**5678'), 'create', '★中段 CD 對 ZZ 衝突');
  assert.equal(act('AB12CD345678', 'AB**cd**5678'), 'create', '大小寫是可見字元');
  // 疑似重複：既有 ****11**3301、新 ****22**3301＝不算；既有完整號、新 ****22**3301（沒有 22）＝不算
  await seedDb();
  const m11 = answer('****11**3301');
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m11), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(m11), aiExtract: fakeExtract });
  clearAiTicketsForTest();
  const m22 = answer('****22**3301');
  for (const t of m22.transactions) t.summary = `${t.summary}(22)`;
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m22), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.similar, 0, '★同一家銀行不會把同一顆戶印成不同中段＝不算（算了＝預設跳過另一顆戶的真交易）');
  const r = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv2.aiTicket, aiEngineFactory: engineOf(m22), aiExtract: fakeExtract, skipSimilar: true });
  assert.equal(/** @type {any} */ (r).transactions.imported, 3);
  await seedDb();
  const full = answer('9001009911993301');
  const pv3 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(full), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv3.aiTicket, aiEngineFactory: engineOf(full), aiExtract: fakeExtract });
  for (const [masked, want] of [['****22**3301', 0], ['****11**3301', 3], ['AB**CD**5678', 0]]) {
    clearAiTicketsForTest();
    const m = answer(masked);
    for (const t of m.transactions) t.summary = `${t.summary}(${masked})`;
    const pvm = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
    assert.equal(pvm.transactions.counts.similar, want, `★${masked}`);
  }
});

test('★語言交集判準本身（acctPatternsIntersect 透過身分判定觀察）：星號至少吃一碼、兩星號互吃、字面逐字', () => {
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  const mk = (/** @type {string} */ accountNo) => ({ accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 1, balanceAsOf: '2026-05-31', accountNo, bank: '合成一銀' }], transactions: [], settings: {} });
  const act = (/** @type {string} */ reg, /** @type {string} */ stmt) => previewBalancesForDb(mk(reg), /** @type {any} */ (parsed(stmt))).rows[0].action;
  assert.equal(act('90013301', '9001****3301'), 'create', '9001 與 3301 之間沒有任何一碼可藏＝蓋不住');
  assert.equal(act('900153301', '9001****3301'), 'update', '藏一碼＝蓋得住');
  assert.equal(act('9001**3301', '90013**3301'), 'ambiguous', '9001* 與 90013*：第二邊的 3 落在第一邊的星號裡＝有交集');
  assert.equal(act('9001**13301', '90013**3301'), 'ambiguous', '9001*13301 與 90013*3301：90013x13301？第一邊要 …13301 結尾、第二邊 90013 開頭＝9001 3 … 1 3301 有交集');
  assert.equal(act('9001**23301', '90013**3301'), 'ambiguous', '9001 3 … 2 3301');
  assert.equal(act('9002**3301', '9001**3301'), 'create', '第四碼 2 對 1 衝突');
});


test('語言交集是對稱的（直測）：星號在哪一邊都至少吃一碼、兩邊星號互吃、字面逐字', async () => {
  const { acctPatternsIntersectForTest: X } = await import('../lib/services/bank-import.js');
  assert.equal(X('900100****3301', '90010011223301'), true);
  assert.equal(X('90010011223301', '900100****3301'), true, '★對稱');
  assert.equal(X('9001003301', '900100****3301'), false, '★對方星號也至少吃一碼');
  assert.equal(X('900100****3301', '9001003301'), false);
  assert.equal(X('9001**11**3301', '9001**9911**3301'), true, 'r7#2');
  assert.equal(X('9001**9911**3301', '9001**11**3301'), true);
  assert.equal(X('9002****3301', '9001****3301'), false);
  assert.equal(X('AB****5678', 'CD****5678'), false);
  assert.equal(X('AB****5678', 'AB125678'), true);
  assert.equal(X('****3301', '****3301'), true);
  assert.equal(X('', '****3301'), false);
});


test('★裁決器看所有同機構的戶、不先用末碼篩（r8#1）：登記 9001****301 對帳單 9001****3301 有交集＝停手、不裂戶；兩顆相交的戶＝停手不更新', () => {
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  const one = { accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 100, balanceAsOf: '2026-05-31', accountNo: '9001****301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(one, /** @type {any} */ (parsed('9001****3301'))).rows[0].action, 'ambiguous', '★末碼 301 對 3301：語言有交集＝停手（不可 create）');
  applyBalancesToDb(one, /** @type {any} */ (parsed('9001****3301')));
  assert.equal(one.accounts.length, 1, '★不裂戶');
  assert.equal(one.accounts[0].balance, 100);
  const two = { accounts: [
    { id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 100, balanceAsOf: '2026-05-31', accountNo: '9001****301', bank: '合成一銀' },
    { id: 'b', name: 'B戶', type: 'cash', currency: 'TWD', balance: 150, balanceAsOf: '2026-05-31', accountNo: '9001****3301', bank: '合成一銀' },
  ], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(two, /** @type {any} */ (parsed('9001****3301'))).rows[0].action, 'ambiguous', '★一顆命中（全等）＋一顆相交＝停手');
  applyBalancesToDb(two, /** @type {any} */ (parsed('9001****3301')));
  assert.deepEqual(two.accounts.map((/** @type {any} */ a) => a.balance), [100, 150], '★都不動');
  const rows = previewBankTxForDb(two, /** @type {any} */ (normalizeAiBank(answer('9001****3301')))).rows;
  for (const r of rows) assert.equal(r.account, '合成一銀 3301（活存）', '★交易掛 autoName');
  // 反向：登記 9001****3301、帳單 9001****301（三碼末碼印法）＝相交＝停手
  const rev = { accounts: [{ id: 'b', name: 'B戶', type: 'cash', currency: 'TWD', balance: 150, balanceAsOf: '2026-05-31', accountNo: '9001****3301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(rev, /** @type {any} */ (parsed('9001****301'))).rows[0].action, 'ambiguous');
});

test('★台新沒遮的完整號寫成 bank2|台新|…（來源可判）：同一份帳單有無分隔符重抄＝疑似重複（預設跳過）；台新帶星號的照舊 bank|（r8#2）', async () => {
  await seedDb();
  const a = { ...answer('90010011223301'), bank: '台新' };
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(a), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(a), aiExtract: fakeExtract });
  const db = await getDb();
  assert.ok(db.transactions.every((/** @type {any} */ t) => String(t.bankRef).startsWith('bank2|台新|90010011223301|')), `★完整號走 bank2（實得 ${db.transactions[0].bankRef}）`);
  clearAiTicketsForTest();
  const b = { ...answer('900-100-1122-3301'), bank: '台新' };
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(b), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.similar, 3, `★有無分隔符＝疑似重複（實得 ${JSON.stringify(pv2.transactions.counts)}）`);
  const r = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv2.aiTicket, aiEngineFactory: engineOf(b), aiExtract: fakeExtract, skipSimilar: true });
  assert.equal(/** @type {any} */ (r).transactions.imported, 0, '★預設跳過＝不入帳');
  assert.equal(/** @type {any} */ (r).transactions.similarSkipped, 3);
  // 台新帶星號＝祖父格式 bank|
  await seedDb();
  const m = { ...answer('900100****3301'), bank: '台新' };
  const pv3 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv3.aiTicket, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  const db3 = await getDb();
  assert.ok(db3.transactions.every((/** @type {any} */ t) => String(t.bankRef).startsWith('bank|900100****3301|')), '台新遮罩＝bank| 祖父格式不變');
});


test('★星號數不是資訊（r9#3）：900100*****3301 對登記 900100****3301＝全等命中；重匯同一份只改星號數＝疑似重複（預設跳過）', async () => {
  const parsed = (/** @type {string} */ masked) => normalizeAiBank({ ...answer(masked), transactions: [] });
  const db = { accounts: [{ id: 'a', name: 'A戶', type: 'cash', currency: 'TWD', balance: 10, balanceAsOf: '2026-05-31', accountNo: '900100****3301', bank: '合成一銀' }], transactions: [], settings: {} };
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('900100*****3301'))).rows[0].action, 'update');
  assert.equal(previewBalancesForDb(db, /** @type {any} */ (parsed('900100**3301'))).rows[0].action, 'update');
  await seedDb();
  const m = answer('900100****3301');
  const pv = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv.aiTicket, aiEngineFactory: engineOf(m), aiExtract: fakeExtract });
  clearAiTicketsForTest();
  const m5 = answer('900100*****3301');
  const pv2 = await previewBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiEngineFactory: engineOf(m5), aiExtract: fakeExtract });
  assert.equal(pv2.transactions.counts.duplicate + pv2.transactions.counts.similar, 3, `★同一份帳單只改星號數＝重複或疑似重複（實得 ${JSON.stringify(pv2.transactions.counts)}）`);
  const r = await applyBankStatement('QUFBQQ==', undefined, notRecognized, { useAi: true, aiTicket: pv2.aiTicket, aiEngineFactory: engineOf(m5), aiExtract: fakeExtract, skipSimilar: true });
  assert.equal(/** @type {any} */ (r).transactions.imported, 0, '★不會算兩次');
});

test('★帳號文法整串驗（r9#2）：夾沒核准符號的 #900100****3301 三個欄位都拒收（不可只看星號後的數字）', () => {
  for (const raw of ['#900100****3301', '900100****3301#', '⑨00100****3301', '900100****3301/1']) {
    assert.equal(accountSuffixAny(normalizeMaskShape(raw)), '', `★取不出：${raw}`);
    for (const breakIt of [
      (/** @type {any} */ a) => { a.accountCurrencies[0].masked = raw; },
      (/** @type {any} */ a) => { a.accounts[0].masked = raw; },
      (/** @type {any} */ a) => { a.transactions[0].acctMasked = raw; },
    ]) {
      const a = answer('900100****3301'); breakIt(a);
      assert.throws(() => normalizeAiBank(a), (/** @type {any} */ e) => e.code === 'ai_bad_answer' && /看不出末幾碼/.test(e.message) && !e.message.includes(raw), `★拒收：${raw}`);
    }
  }
  assert.equal(accountSuffixAny('AB****5678'), '5678', '字母合法');
  assert.equal(accountSuffixAny('900-100 ****3301'), '3301', '分隔符合法');
});
