// @ts-check
// C6 考題：主金鑰不符時，**不可以把資料庫裡的密文蓋掉**（資料毀損止血，2026-07-28）。
//
// 病根（Codex 收官審查 #6，我實測重現過）：
//   `decryptSecret` 解不開時回空字串（生存優先，見 lib/crypto-secrets.js 檔頭③）——這是對的，
//   app 不該因為一個欄位解不開就整個打不開。錯的是**寫回**那一段：`saveKv` 每次寫入都重寫
//   全部 20 個 kv key，那個空字串會在使用者下一次「隨手記一筆帳」時把原密文永久蓋掉。
//   主金鑰設錯一次 → 記一筆帳 → IB token 與 PDF 密碼（＝身分證字號）全滅，
//   **換回正確金鑰也救不回來**（密文已經不在資料庫裡了）。
//
// 這一檔的每一題都要能「把修拿掉就變紅」——尤其是第三題（路徑撞號），
// 它守的是修法自己引進的新風險，不是原本的病。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';

const DIR = mkdtempSync(join(tmpdir(), 'finance-secret-writeback-'));
process.env.STORE_FILE = join(DIR, 'store.db');
process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SITE_ORIGIN = 'https://noteasy.com.tw';

/** 正確的金鑰。 */
const KEY_GOOD = Buffer.alloc(32, 9).toString('base64');
/** 設錯的金鑰（長度合法、內容不同——這才是「換回來救得回」有意義的情境；長度不合法會在開機就 fail-fast）。 */
const KEY_WRONG = Buffer.alloc(32, 7).toString('base64');
process.env.NOTEASY_MASTER_KEY = KEY_GOOD;

const { setSupabaseFactoryForTest, cookieAdapterFor } = await import('../lib/services/auth.js');
const { createFakePostgres, makeFakeSupabaseFactory } = await import('../test-doubles/fake-supabase.js');
const { encryptSecret } = await import('../lib/crypto-secrets.js');
const { tenantUndecryptableSecrets } = await import('../lib/tenant.js');
const { app } = await import('../server.js');

const FLEX = 'FLEXTOKEN-WRITEBACK-0001';
const TAISHIN = 'A123456789';       // 台新證券 PDF 密碼＝身分證字號（合成假值）
const CARDPW = 'B987654321';        // 信用卡帳單 PDF 密碼（合成假值）

const A = { id: 'user-wb-a', email: 'a@x.com' };
const C = { id: 'user-wb-c', email: 'c@x.com' };
const pg = createFakePostgres();
before(() => setSupabaseFactoryForTest(
  makeFakeSupabaseFactory({ pg, users: { tokA: A, tokC: C }, cookieAdapterFor })));

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;
const ORIGIN = 'https://noteasy.com.tw';

after(() => {
  server.close();
  setSupabaseFactoryForTest(null);
  process.env.NOTEASY_MASTER_KEY = KEY_GOOD;
  rmSync(DIR, { recursive: true, force: true });
});

const as = (/** @type {string} */ tok, /** @type {string} */ p, /** @type {any} */ init = {}) => fetch(`${base}${p}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: `sb-test-auth-token=${tok}`, ...(init.headers || {}) },
});

/** 某位使用者在（假）資料庫裡的原始 JSON——**未經解密**，等同「把整顆資料庫 dump 出來看」。 @param {string} uid */
const rawOf = (uid) => JSON.stringify(pg.selectAs(uid));
/** 某位使用者某個 kv key 的原始值。 @param {string} uid @param {string} key */
const rowOf = (uid, key) => pg.selectAs(uid).find(r => r.key === key)?.data;

/** 「隨手記一筆帳」＝最無辜的一次寫入。病就是從這種操作觸發的。 @param {string} tok @param {string} note */
const jotDownOneExpense = (tok, note) => as(tok, '/api/transactions', {
  method: 'POST',
  body: JSON.stringify({ date: '2026-07-28', type: 'expense', category: '其他', amount: 55, note }),
});

// ============================================================================
// 一、主考題：金鑰設錯 → 記一筆帳 → 密文還在，換回正確金鑰救得回來
// ============================================================================

test('金鑰設錯期間的一次無辜寫入，不可以把密文蓋掉（換回正確金鑰要能救回來）', async () => {
  // --- 佈景：用正確金鑰把三個機密都設好
  assert.equal((await as('tokA', '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ taishinSecPdfPassword: TAISHIN, ib: { flexToken: FLEX, flexQueryId: '123' } }),
  })).status, 200);
  assert.equal((await as('tokA', '/api/cards', {
    method: 'POST', body: JSON.stringify({ name: '測試卡', pdfPassword: CARDPW }),
  })).status, 200);

  const before = rawOf(A.id);
  assert.match(before, /enc:v1:/, '佈景沒做成：資料庫裡應該要有密文');
  const cipherFlex = rowOf(A.id, 'settings')?.ib?.flexToken;
  const cipherTaishin = rowOf(A.id, 'settings')?.taishinSecPdfPassword;
  const cipherCard = rowOf(A.id, 'cards')?.[0]?.pdfPassword;
  assert.ok(cipherFlex && cipherTaishin && cipherCard, '佈景沒做成：三個密文都要抓得到');

  // --- 事故：金鑰被設錯了（換了一把、忘了帶舊的、Render 環境變數貼錯……）
  process.env.NOTEASY_MASTER_KEY = KEY_WRONG;
  try {
    // 使用者不知道出事了（畫面上只是那幾個欄位變成「未設定」），照常記一筆帳
    // ⚠️ 這裡會噴三行 `[crypto] 機密欄位解密失敗…` 的 console.warn，是**預期行為**（生存優先）
    assert.equal((await jotDownOneExpense('tokA', '金鑰壞掉期間的無辜記帳')).status, 200);

    // 核心斷言：資料庫裡那三串密文必須**原封不動**
    assert.equal(rowOf(A.id, 'settings')?.ib?.flexToken, cipherFlex,
      'IB token 的密文被空字串蓋掉了——金鑰設錯一次就永久毀資料');
    assert.equal(rowOf(A.id, 'settings')?.taishinSecPdfPassword, cipherTaishin,
      '台新證券密碼（身分證字號）的密文被蓋掉了');
    assert.equal(rowOf(A.id, 'cards')?.[0]?.pdfPassword, cipherCard,
      '卡片 PDF 密碼的密文被蓋掉了');

    // 而且那筆帳真的記進去了（止血不可以是「乾脆不讓他存」）
    assert.match(JSON.stringify(rowOf(A.id, 'transactions')), /金鑰壞掉期間的無辜記帳/,
      '帳沒記進去＝止血變成了功能故障');
  } finally {
    process.env.NOTEASY_MASTER_KEY = KEY_GOOD;
  }

  // --- 救援：金鑰換回來，三個機密都要回得來
  const s = await (await as('tokA', '/api/settings')).json();
  assert.equal(s.ib.flexTokenSet, true, '換回正確金鑰之後 IB token 應該救得回來');
  assert.equal(s.taishinSecPdfPasswordSet, true, '換回正確金鑰之後台新證券密碼應該救得回來');
  const cards = await (await as('tokA', '/api/cards')).json();
  assert.equal(cards[0].pdfPasswordSet, true, '換回正確金鑰之後卡片密碼應該救得回來');

  // 而且救回來的是**原來那個值**，不是「有東西但是垃圾」
  const dump = await (await as('tokA', '/api/db')).text();
  assert.ok(!dump.includes('enc:v1:'), '救回來之後不可以把密文送到瀏覽器');
});

// ============================================================================
// 二、不可以「黏手」：使用者輸入新值時，要用當下的金鑰正常加密
// ============================================================================

test('金鑰壞掉期間輸入新值：照常加密覆蓋，不會被舊密文黏住', async () => {
  const NEWTOKEN = 'FLEXTOKEN-TYPED-WHILE-BROKEN';
  const cipherBefore = rowOf(A.id, 'settings')?.ib?.flexToken;

  process.env.NOTEASY_MASTER_KEY = KEY_WRONG;
  try {
    assert.equal((await as('tokA', '/api/settings', {
      method: 'PUT', body: JSON.stringify({ ib: { flexToken: NEWTOKEN, flexQueryId: '123' } }),
    })).status, 200);

    const after = rowOf(A.id, 'settings')?.ib?.flexToken;
    assert.notEqual(after, cipherBefore,
      '使用者明明輸入了新 token，卻被舊密文黏住了——保護寫得太寬，功能會壞掉');
    assert.match(String(after), /^enc:v1:/, '新值要照常加密');
    // 用「設錯的那把金鑰」讀得回來＝它確實是用當下的金鑰加密的
    const s = await (await as('tokA', '/api/settings')).json();
    assert.equal(s.ib.flexTokenSet, true, '當下這把金鑰應該解得開它自己剛加密的東西');
  } finally {
    process.env.NOTEASY_MASTER_KEY = KEY_GOOD;
  }
});

// ============================================================================
// 三、修法自己引進的風險：路徑撞號時，絕不可以把甲的密文寫進乙
// ============================================================================

test('兩張沒有 id 的卡片（路徑撞號）：寧可不救，也不可以把甲的密碼變成乙的', async () => {
  // 為什麼會有沒有 id 的卡片：`/api/import` 吃的是使用者給的檔案，而 `sanitizeDbForWrite`
  // **不會**補 id（已實測）。兩張都會算出同一個機密路徑 `cards..pdfPassword`。
  const PW_A = 'CARD-AAA-111';
  const PW_B = 'CARD-BBB-222';
  const AAD = `${C.id}|cards..pdfPassword`;
  const encA = encryptSecret(PW_A, AAD);
  const encB = encryptSecret(PW_B, AAD);
  assert.notEqual(encA, encB);

  pg.seed(C.id, 'cards', [
    { name: '甲卡', pdfPassword: encA },
    { name: '乙卡', pdfPassword: encB },
  ]);

  process.env.NOTEASY_MASTER_KEY = KEY_WRONG;
  try {
    assert.equal((await jotDownOneExpense('tokC', '路徑撞號情境')).status, 200);
  } finally {
    process.env.NOTEASY_MASTER_KEY = KEY_GOOD;
  }

  const cards = rowOf(C.id, 'cards');
  // **這一條是承重的**：沒有「撞號就不登記」那道防護，寫回是按路徑寫的，
  // 最後登記的（乙卡）密文會被寫進**兩格**——甲卡的密碼就這樣變成了乙卡的。
  assert.notEqual(cards?.[0]?.pdfPassword, encB,
    '甲卡的密碼被換成乙卡的了——這比原本的「解不開」嚴重得多（原本無害，現在是寫錯）');
  assert.notEqual(cards?.[1]?.pdfPassword, encA, '乙卡也不可以拿到甲卡的密文');
  // 撞號的欄位退回今天的行為（救不回來），這是刻意的取捨：寧可少救，也不要寫錯
  assert.equal(cards?.[0]?.pdfPassword, '', '撞號的欄位不登記＝退回原本行為');
  assert.equal(cards?.[1]?.pdfPassword, '');
});

// ============================================================================
// 四、每次讀取都要清空（CAS 重試會重跑 loadKv）
// ============================================================================

test('槽每次讀取都清空：別的分頁「正當清空」了某欄位，重試時不可以把它復活', async () => {
  // 直接考 store-pg 的讀取語意（CAS 重試在 lib/repo.js 的 mutate 裡，會重跑一次 loadKv）。
  const { runWithTenant } = await import('../lib/tenant.js');
  const { loadKv } = await import('../lib/store-pg.js');

  // 一顆只認 C、直接接上假 Postgres 的 client（不經 HTTP，才控制得住「兩次讀取之間」）
  const supabase = {
    from: () => ({ select: () => ({ then: (/** @type {any} */ ok) => Promise.resolve({ data: pg.selectAs(C.id), error: null }).then(ok) }) }),
  };

  pg.seed(C.id, 'settings', { ib: { flexToken: encryptSecret(FLEX, `${C.id}|settings.ib.flexToken`) } }, 5);

  process.env.NOTEASY_MASTER_KEY = KEY_WRONG;
  try {
    await runWithTenant({ userId: C.id, supabase }, async () => {
      await loadKv();
      assert.equal(tenantUndecryptableSecrets()?.get('settings.ib.flexToken') != null, true,
        '第一次讀取應該登記「這個欄位解不開」');

      // 另一個分頁把它正當清空了（於是資料庫裡不再是密文）
      pg.seed(C.id, 'settings', { ib: { flexToken: '' } }, 6);

      await loadKv();   // ← CAS 衝突後的重試會走到這裡
      assert.equal(tenantUndecryptableSecrets()?.has('settings.ib.flexToken'), false,
        '沒清空槽：上一輪的舊密文會把「別人剛清空的欄位」復活、蓋掉正確結果');
    });
  } finally {
    process.env.NOTEASY_MASTER_KEY = KEY_GOOD;
  }
});

// ============================================================================
// 五、LOCAL 完全不適用
// ============================================================================

test('LOCAL（無租戶 context）：槽回 null，這條路完全不存在', () => {
  assert.equal(tenantUndecryptableSecrets(), null,
    'LOCAL 不加密，也就沒有「解不開」這回事——不可以在本機開出一條新路徑');
});
