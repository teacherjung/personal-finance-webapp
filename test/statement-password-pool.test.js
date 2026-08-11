// @ts-check
// P0.5 匯入密碼池（LOCAL 側）考題：池的組裝順序與去重、試密碼迴圈的錯誤分類（機器判準優先）、
// 記住/清除的持久化（去重、上限最舊讓位）、銀行兩入口端到端接池（注入解析器接縫）。
// HOSTED 側（加密/投影/匯出剝除/匯入不採用）在 test/hosted-secrets.test.js 的 P0.5 區塊。
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const TEST_STORE = join(tmpdir(), `finance-pwpool-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const store = await import('../lib/store.js');
const { getDb } = await import('../lib/repo.js');
const { rememberedPasswords, statementPasswordPool, parseWithPool, rememberStatementPassword, clearStatementPasswords } = await import('../lib/services/statement-import.js');
const { previewBankStatement, applyBankStatement } = await import('../lib/services/bank-import.js');

after(() => {
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

beforeEach(() => { store.save({ ...store.emptyDb() }); });

const pwErr = () => Object.assign(new Error('銀行對帳單 PDF 密碼錯誤'), { status: 400, code: 'pdf_password' });

test('池組裝｜順序＝本次輸入→空字串→各卡→記住的；重複只留第一次出現', () => {
  const db = {
    cards: [
      { type: 'credit', pdfPassword: 'A111111111' },
      { type: 'credit', pdfPassword: 'B222222222' },
      { name: '會員卡', type: 'membership', pdfPassword: 'M999999999' },   // 非信用卡＝不進池
    ],
    settings: { rememberedStatementPasswords: JSON.stringify(['C333333333', 'A111111111']) },
  };
  assert.deepEqual(statementPasswordPool(db, ['X000000000']),
    ['X000000000', '', 'A111111111', 'B222222222', 'C333333333'],
    '本次輸入最優先；卡密與記住的去重；非信用卡的密碼不撈');
  assert.deepEqual(statementPasswordPool({}, []), [''], '空 db＝只剩「未加密」一發');
});

test('池組裝｜記住清單壞形狀＝當空（不是 JSON／不是陣列／混入非字串），不炸匯入', () => {
  assert.deepEqual(rememberedPasswords({ settings: { rememberedStatementPasswords: 'not-json' } }), []);
  assert.deepEqual(rememberedPasswords({ settings: { rememberedStatementPasswords: '{"a":1}' } }), []);
  assert.deepEqual(rememberedPasswords({ settings: { rememberedStatementPasswords: JSON.stringify(['ok', 7, '', null]) } }), ['ok']);
  assert.deepEqual(rememberedPasswords({}), []);
});

test('試密碼迴圈｜密碼類錯誤（code 機器判準）換下一個、對的那組成功返回', async () => {
  /** @type {string[]} */ const tried = [];
  const parse = async (/** @type {Uint8Array} */ _b, /** @type {string} */ pw) => {
    tried.push(pw);
    if (pw !== 'C333333333') throw pwErr();
    return { ok: pw };
  };
  const r = await parseWithPool(parse, new Uint8Array([1]), ['', 'A111111111', 'C333333333', 'D444444444']);
  assert.deepEqual(r, { ok: 'C333333333' });
  assert.deepEqual(tried, ['', 'A111111111', 'C333333333'], '成功即停，不多試後面的');
});

test('試密碼迴圈｜非密碼錯誤（格式/無明細）當場丟出，不可拿別的密碼繼續撞', async () => {
  /** @type {string[]} */ const tried = [];
  const boom = Object.assign(new Error('這份 XLSX 找不到消費明細'), { status: 400 });
  const parse = async (/** @type {Uint8Array} */ _b, /** @type {string} */ pw) => { tried.push(pw); throw boom; };
  await assert.rejects(parseWithPool(parse, new Uint8Array([1]), ['', 'A111111111']), boom);
  assert.deepEqual(tried, [''], '第一發就該停（繼續撞只是浪費並模糊真正的錯誤）');
});

test('試密碼迴圈｜缺 code 的舊訊息走 regex 後備；全敗＝丟最後一個密碼錯（code 保留給前端跳窗）', async () => {
  const legacy = () => Object.assign(new Error('這份 PDF 有加密，請提供密碼'), { status: 400 });
  const parse = async () => { throw legacy(); };
  await assert.rejects(parseWithPool(parse, new Uint8Array([1]), ['', 'x']), (/** @type {any} */ e) => {
    assert.match(e.message, /加密/);
    return true;
  });
  const coded = async () => { throw pwErr(); };
  await assert.rejects(parseWithPool(coded, new Uint8Array([1]), ['']), (/** @type {any} */ e) => e.code === 'pdf_password');
});

test('記住/清除｜去重、上限 8 組最舊讓位、清除歸零（走真資料庫）', async () => {
  assert.equal((await rememberStatementPassword('P111111111')).count, 1);
  assert.equal((await rememberStatementPassword('P111111111')).count, 1, '重複記＝不長大');
  for (let i = 2; i <= 9; i++) await rememberStatementPassword(`P${i}${i}${i}0000000`);
  const db = await getDb();
  const list = rememberedPasswords(db);
  assert.equal(list.length, 8, '上限 8 組');
  assert.ok(!list.includes('P111111111'), '最舊的讓位');
  assert.equal((await clearStatementPasswords()).count, 0);
  assert.equal(rememberedPasswords(await getDb()).length, 0);
  await assert.rejects(rememberStatementPassword(''), (/** @type {any} */ e) => e.status === 400);
  await assert.rejects(rememberStatementPassword('x'.repeat(101)), (/** @type {any} */ e) => e.status === 400);
});

// ---------- 銀行兩入口端到端接池（注入解析器接縫＝P0 r3 建立的測試通道） ----------

/** 最小可過閘、可套用的銀行解析產物（假帳號）。 */
function bankParsed() {
  return {
    bank: '台新', referenceDate: '2026-07-31',
    accounts: [{ suffix: '3301', masked: '900100****3301', balance: 10500, currency: 'TWD', label: '新臺幣活儲', note: '' }],
    accountCurrency: { '900100****3301': 'TWD' },
    transactions: [
      { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-07-01', summary: '轉帳存入', direction: 'in', amount: 1000, balance: 10000, note: '' },
      { acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-07-02', summary: '轉帳存入', direction: 'in', amount: 500, balance: 10500, note: '' },
    ],
  };
}

/** 只認一組密碼的假解析器。 @param {string} good */
const lockedParse = (good) => async (/** @type {Uint8Array} */ _b, /** @type {string} */ pw) => {
  if (pw !== good) throw pwErr();
  return /** @type {any} */ (bankParsed());
};

test('銀行預覽｜body 沒帶密碼＝自動用記住的池開檔（P0.5 的核心體驗）', async () => {
  await rememberStatementPassword('R555555555');
  const r = await previewBankStatement('QUJD', '', lockedParse('R555555555'));
  assert.equal(r.reconcile.level, 'strong', '池裡那組開成功、照常走閘與預覽');
});

test('銀行預覽｜池全敗＝400 且帶 code（前端據它跳密碼窗），不靜默', async () => {
  await assert.rejects(previewBankStatement('QUJD', '', lockedParse('NOT-IN-POOL')), (/** @type {any} */ e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'pdf_password');
    return true;
  });
});

test('銀行套用｜同樣自己重跑池（不收前端帶回的中選密碼）、成功真的落地', async () => {
  await rememberStatementPassword('R666666666');
  const a = await applyBankStatement('QUJD', '', lockedParse('R666666666'));
  assert.equal(a.ok, true);
  assert.equal(a.transactions.imported, 2);
  const db = await getDb();
  assert.equal((db.transactions || []).filter((/** @type {any} */ t) => t.source === 'bank').length, 2);
});

test('銀行預覽｜使用者這次輸入的密碼最優先（池只是後備）', async () => {
  /** @type {string[]} */ const tried = [];
  const parse = async (/** @type {Uint8Array} */ _b, /** @type {string} */ pw) => { tried.push(pw); if (pw !== 'TYPED12345') throw pwErr(); return /** @type {any} */ (bankParsed()); };
  await previewBankStatement('QUJD', 'TYPED12345', parse);
  assert.deepEqual(tried, ['TYPED12345'], '第一發就是本次輸入');
});

test('錯誤 code 通道｜sendRouteError 把 e.code 帶進回應（前端跳密碼窗的機器判準；沒 code＝不多欄）', async () => {
  const { sendRouteError } = await import('../lib/routes/route-helpers.js');
  /** @type {any} */ let sent;
  const res = { status: (/** @type {number} */ s) => ({ json: (/** @type {any} */ b) => { sent = { s, b }; } }) };
  sendRouteError(res, () => { throw new Error('帶 status 的錯不該走 next'); },
    Object.assign(new Error('這份 PDF 有加密，請提供密碼'), { status: 400, code: 'pdf_password' }));
  assert.deepEqual(sent, { s: 400, b: { error: '這份 PDF 有加密，請提供密碼', code: 'pdf_password' } });
  sendRouteError(res, () => {}, Object.assign(new Error('別的 400'), { status: 400 }));
  assert.deepEqual(sent.b, { error: '別的 400' }, '沒 code 就不多欄（舊呼叫端形狀不變）');
});

// ---------- r1 修正的考題 ----------

test('r1#1｜rethrowParseError 保留 pdf_password code（前端跳窗的機器判準；別的 code 不放行）', async () => {
  const { rethrowParseError } = await import('../lib/services/statement-import.js');
  assert.throws(() => rethrowParseError(Object.assign(new Error('密碼錯'), { status: 400, code: 'pdf_password' })),
    (/** @type {any} */ e) => { assert.equal(e.status, 400); assert.equal(e.code, 'pdf_password'); return true; });
  assert.throws(() => rethrowParseError(Object.assign(new Error('別的'), { status: 400, code: 'something_else' })),
    (/** @type {any} */ e) => { assert.equal(e.code, undefined, '只放行白名單 code'); return true; });
});

test('r1#2｜讀取端 fail-safe 上限：raw 有 20 組/超長字串，pool 只吃 ≤8 組×≤100 字', () => {
  const many = Array.from({ length: 20 }, (_, i) => `P${i}`.padEnd(10, '0'));
  many.push('x'.repeat(200));   // 超長：要被濾掉
  const db = { settings: { rememberedStatementPasswords: JSON.stringify(many) } };
  const list = rememberedPasswords(db);
  assert.equal(list.length, 8, '硬限 8 組（池大小＝每次上傳的解析次數）');
  assert.ok(!list.some((/** @type {string} */ p) => p.length > 100), '超長被濾掉');
});

test('r1#2｜寫入端上限：pickRememberedStatementPasswords 把超大/壞值收斂（通用 PUT 進不了大池）', async () => {
  const { pickRememberedStatementPasswords, sanitizeSettings } = await import('../lib/schema.js');
  const huge = JSON.stringify(Array.from({ length: 5000 }, (_, i) => `p${i}`.padEnd(50, '0')));
  const picked = pickRememberedStatementPasswords({ rememberedStatementPasswords: huge });
  assert.equal(JSON.parse(picked.rememberedStatementPasswords).length, 8, '寫入端就砍到 8 組');
  assert.deepEqual(pickRememberedStatementPasswords({ rememberedStatementPasswords: 'not-json' }), {}, '非 JSON＝不寫（缺席語意）');
  // 通用 settings 匯入路徑（sanitizeSettings）也走同一道：塞巨量字串→存進去的是 ≤8 組
  const s = sanitizeSettings({ rememberedStatementPasswords: huge, currency: 'TWD' });
  assert.equal(JSON.parse(s.rememberedStatementPasswords).length, 8);
  assert.equal(s.currency, 'TWD', '其餘設定照常');
});

test('r1#3｜previewForCard 的密碼排在池最前（沒勾記住時、選卡/改卡重解析沿用使用者輸入）', () => {
  // previewForCard(cardId, b64, typedPw) 組池＝[typedPw, cardPw, '', 各卡, 記住的]；typedPw 第一發
  const db = { cards: [{ type: 'credit', pdfPassword: 'CARD00000' }], settings: {} };
  assert.deepEqual(statementPasswordPool(db, ['TYPED9999', 'CARD00000']),
    ['TYPED9999', 'CARD00000', '', 'CARD00000'].filter((v, i, a) => a.indexOf(v) === i),
    'typedPw 最優先、與卡密去重');
  assert.equal(statementPasswordPool(db, ['TYPED9999', 'CARD00000'])[0], 'TYPED9999');
});

test('r1#4｜parseWithPool：帶非密碼 code 但訊息含「密碼」字樣＝當場停，不撞完整池', async () => {
  /** @type {string[]} */ const tried = [];
  const parse = async (/** @type {Uint8Array} */ _b, /** @type {string} */ pw) => {
    tried.push(pw);
    throw Object.assign(new Error('子行程內部錯誤：密碼解析失敗'), { status: 500, code: 'pdf_child_internal' });
  };
  await assert.rejects(parseWithPool(parse, new Uint8Array([1]), ['', 'A', 'B']),
    (/** @type {any} */ e) => e.code === 'pdf_child_internal');
  assert.deepEqual(tried, [''], 'code 優先＝非密碼 code 就停，不因訊息含「密碼」續撞');
});

test('r1#L6｜櫃檯（sanitizeDbForWrite）保留記住的密碼池、且套上限（LOCAL 備份可還原）', async () => {
  const { sanitizeDbForWrite } = await import('../lib/schema.js');
  const out = sanitizeDbForWrite({ settings: { rememberedStatementPasswords: JSON.stringify(['KEEP12345']) } });
  assert.deepEqual(JSON.parse(out.settings.rememberedStatementPasswords), ['KEEP12345'], '櫃檯不剝這欄＝LOCAL 存/還原保留');
  const big = sanitizeDbForWrite({ settings: { rememberedStatementPasswords: JSON.stringify(Array(50).fill('p123456789')) } });
  assert.equal(JSON.parse(big.settings.rememberedStatementPasswords).length, 8, '櫃檯寫入也套上限');
});

// ---------- r2 修正的考題 ----------

test('r2#1｜整池封頂：5000 張卡＝parseFn 呼叫次數不超過 MAX_POOL_ATTEMPTS（卡數無上限也擋得住 DoS）', async () => {
  const { MAX_POOL_ATTEMPTS } = await import('../lib/statement-password-policy.js');
  const db = { cards: Array.from({ length: 5000 }, (_, i) => ({ type: 'credit', pdfPassword: `CARD${i}`.padEnd(9, '0') })), settings: {} };
  const pool = statementPasswordPool(db);
  assert.ok(pool.length <= MAX_POOL_ATTEMPTS, `池被封頂在 ${MAX_POOL_ATTEMPTS}（實得 ${pool.length}）`);
  // 走真迴圈：全不對＝parseFn 最多被叫 MAX_POOL_ATTEMPTS 次
  let calls = 0;
  const parse = async () => { calls++; throw Object.assign(new Error('密碼錯'), { status: 400, code: 'pdf_password' }); };
  await assert.rejects(parseWithPool(parse, new Uint8Array([1]), pool));
  assert.ok(calls <= MAX_POOL_ATTEMPTS, `解析嘗試被封頂（實得 ${calls} 次）`);
});

test('r2#1｜封頂砍的是最不優先的尾巴：本次輸入/空密碼/前幾張卡一定在池裡', () => {
  const db = { cards: Array.from({ length: 5000 }, (_, i) => ({ type: 'credit', pdfPassword: `CARD${i}`.padEnd(9, '0') })), settings: {} };
  const pool = statementPasswordPool(db, ['TYPED9999']);
  assert.equal(pool[0], 'TYPED9999', '本次輸入最優先、不被砍');
  assert.equal(pool[1], '', '未加密那發也在');
  assert.ok(pool.includes('CARD0'.padEnd(9, '0')), '前幾張卡在池裡');
});

test('r2#3｜previewForCard 走正式路徑：卡密錯、typed password 對＝typed 先試且預覽成功', async () => {
  store.save({ ...store.emptyDb(), cards: [{ id: 'c1', name: '台新卡', type: 'credit', issuer: '台新銀行', pdfPassword: 'WRONGCARD' }] });
  const { previewForCard } = await import('../lib/services/statement-import.js');
  /** @type {string[]} */ const tried = [];
  // 假解析器：只認 'TYPED-OK'；回一份最小可過中閘（弱閘）的產物
  const parse = async (/** @type {Uint8Array} */ _b, /** @type {string} */ pw) => {
    tried.push(pw);
    if (pw !== 'TYPED-OK') throw Object.assign(new Error('PDF 密碼錯誤'), { status: 400, code: 'pdf_password' });
    return /** @type {any} */ ({ bank: '台新', lastFour: null, transactions: [], statementMonth: '', statementDue: null, statementTotals: null });
  };
  const r = await previewForCard('c1', 'QUJD', 'TYPED-OK', parse);
  assert.equal(tried[0], 'TYPED-OK', '使用者輸入的密碼排在池最前、第一發就試');
  assert.ok(r.card && r.card.id === 'c1', '預覽成功、歸到指定卡');
});
