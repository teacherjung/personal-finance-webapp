// @ts-check
// C5 考題：機密欄位的信封加密、雲端匯出剝機密、匯入不吃機密、錯誤訊息不洩漏。
//
// 三個要一起看的性質：
//   ①**at-rest 加密**：資料庫裡躺的是密文（拿走整顆資料庫也讀不到 token 與身分證字號）。
//   ②**投影**（既有）：機密不送瀏覽器。兩道各管各的，缺一不可——
//     只有投影＝資料庫外流就全裸；只有加密＝前端仍拿得到明文。
//   ③**錯誤訊息**：全鏈路不得出現機密值本身。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';

const DIR = mkdtempSync(join(tmpdir(), 'finance-hosted-secrets-'));
process.env.STORE_FILE = join(DIR, 'store.db');
process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SITE_ORIGIN = 'https://noteasy.com.tw';
process.env.NOTEASY_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

const { setSupabaseFactoryForTest, cookieAdapterFor } = await import('../lib/services/auth.js');
const { createFakePostgres, makeFakeSupabaseFactory } = await import('../test-doubles/fake-supabase.js');
const { encryptSecret, decryptSecret, isEncrypted } = await import('../lib/crypto-secrets.js');
const { stripSecretsForBackup } = await import('../lib/secret-fields.js');
const { hostedConfig } = await import('../lib/hosted.js');
const { app } = await import('../server.js');

// 這三個字串就是「機密」——整份考題到處掃它們，任何回應／錯誤訊息／資料庫列出現就算洩漏
const FLEX = 'FLEXTOKEN-SECRET-0001';
const TAISHIN = 'A123456789';        // 台新證券 PDF 密碼＝身分證字號（合成假值）
const CARDPW = 'B987654321';         // 信用卡帳單 PDF 密碼（合成假值）
const FULL_ACCOUNT_NO = '9001001234567890';   // 完整銀行帳號（PII，合成假值）
/** @type {string} */
let ACCOUNT_ID = '';

const A = { id: 'user-sec-a', email: 'a@x.com' };
const B = { id: 'user-sec-b', email: 'b@x.com' };
const pg = createFakePostgres();
before(() => setSupabaseFactoryForTest(
  makeFakeSupabaseFactory({ pg, users: { tokA: A, tokB: B }, cookieAdapterFor })));

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;
const ORIGIN = 'https://noteasy.com.tw';

after(() => {
  server.close();
  setSupabaseFactoryForTest(null);
  rmSync(DIR, { recursive: true, force: true });
});

const as = (/** @type {string} */ tok, /** @type {string} */ p, /** @type {any} */ init = {}) => fetch(`${base}${p}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: `sb-test-auth-token=${tok}`, ...(init.headers || {}) },
});

/** 資料庫裡（＝假 Postgres 的列）某位使用者的原始 JSON 字串。 @param {string} uid */
const rawOf = (uid) => JSON.stringify(pg.selectAs(uid));

// ============================================================================
// 一、純函式層：加解密本身
// ============================================================================

test('加密：同一份明文每次密文都不同（隨機 IV），但都解得回原文', () => {
  const a = encryptSecret(FLEX, 'user-1|settings.ib.flexToken');
  const b = encryptSecret(FLEX, 'user-1|settings.ib.flexToken');
  assert.ok(isEncrypted(a) && isEncrypted(b));
  assert.notEqual(a, b, '固定 IV 會讓「兩個欄位是不是同一個值」從密文一眼可辨');
  assert.ok(!a.includes(FLEX), '密文裡不可以看得到明文');
  assert.equal(decryptSecret(a, 'user-1|settings.ib.flexToken'), FLEX);
  assert.equal(decryptSecret(b, 'user-1|settings.ib.flexToken'), FLEX);
});

test('加密：空字串＝「未設定」，原樣不加密（否則 …Set 布林投影會失準）', () => {
  assert.equal(encryptSecret('', 'x|y'), '');
  assert.equal(decryptSecret('', 'x|y'), '');
});

test('加密：不重複包第二層（已是密文就原樣回）', () => {
  const once1 = encryptSecret(FLEX, 'u|p');
  assert.equal(encryptSecret(once1, 'u|p'), once1);
});

test('AAD 綁定：密文搬到別人的列、或搬到別的欄位，都解不開（回空字串＋不丟明文）', () => {
  const ct = encryptSecret(TAISHIN, 'user-A|settings.taishinSecPdfPassword');
  assert.equal(decryptSecret(ct, 'user-B|settings.taishinSecPdfPassword'), '', '換一個人就解不開');
  assert.equal(decryptSecret(ct, 'user-A|settings.ib.flexToken'), '', '換一個欄位就解不開');
  assert.equal(decryptSecret(ct, 'user-A|settings.taishinSecPdfPassword'), TAISHIN, '原位照樣解得開');
});

test('竄改偵測：改動密文一個字元＝解不出東西（GCM 完整性），不會默默吐出垃圾', () => {
  const ct = encryptSecret(FLEX, 'u|p');
  const broken = ct.slice(0, -2) + (ct.endsWith('A') ? 'B' : 'A') + '=';
  assert.equal(decryptSecret(broken, 'u|p'), '');
});

test('主金鑰：長度不對＝啟動就 fail-fast（不可默默用半套上線）', () => {
  const saved = process.env.NOTEASY_MASTER_KEY;
  process.env.NOTEASY_MASTER_KEY = Buffer.alloc(16, 1).toString('base64');
  assert.throws(() => hostedConfig(), /NOTEASY_MASTER_KEY/);
  delete process.env.NOTEASY_MASTER_KEY;
  assert.throws(() => hostedConfig(), /NOTEASY_MASTER_KEY/, '整個缺也要 fail-fast');
  process.env.NOTEASY_MASTER_KEY = saved;
  assert.equal(hostedConfig().masterKey, saved);
});

// ============================================================================
// 二、端到端：資料庫裡躺的是密文，前端拿到的是「有沒有設定」
// ============================================================================

test('at-rest：三個機密欄位存進資料庫時全是密文，明文一個字都找不到', async () => {
  // 走真正的寫入路徑（PUT /api/settings ＋ POST /api/cards）
  const s = await as('tokA', '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ taishinSecPdfPassword: TAISHIN, ib: { flexToken: FLEX, flexQueryId: '123' } }),
  });
  assert.equal(s.status, 200);
  const c = await as('tokA', '/api/cards', { method: 'POST', body: JSON.stringify({ name: '測試卡', pdfPassword: CARDPW }) });
  assert.equal(c.status, 200);
  // 帳戶也走真寫入路徑建一個（下面兩題要用）。accountNo 是 PII 但**刻意不加密**——
  // 它只從備份檔剝除，見 lib/secret-fields.js 的兩張清單。
  const a = await as('tokA', '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name: '測試帳戶', type: 'cash', currency: 'TWD', balance: 100, accountNo: FULL_ACCOUNT_NO }),
  });
  assert.equal(a.status, 200, `建帳戶應該成功：${await a.clone().text()}`);
  ACCOUNT_ID = (await a.json()).id;

  const raw = rawOf(A.id);
  for (const [label, secret] of [['IB flexToken', FLEX], ['台新證券密碼', TAISHIN], ['卡片 PDF 密碼', CARDPW]]) {
    assert.ok(!raw.includes(secret), `${label} 以明文躺在資料庫裡！`);
  }
  assert.match(raw, /enc:v1:/, '資料庫裡應該看得到密文前綴');
});

test('可用性：加密之後，伺服器自己讀回來仍拿得到明文（不然功能就壞了）', async () => {
  // /api/export 在 HOSTED 會剝機密，所以改用「能證明伺服器讀得到」的既有行為：
  // 投影後的 …Set 布林為 true ＝ 伺服器手上那份確實是非空的明文。
  const settings = await (await as('tokA', '/api/settings')).json();
  assert.equal(settings.taishinSecPdfPasswordSet, true);
  assert.equal(settings.ib.flexTokenSet, true);
  const cards = await (await as('tokA', '/api/cards')).json();
  assert.equal(cards[0].pdfPasswordSet, true);
});

test('投影仍然成立（C5 不可以把既有防線弄壞）：機密一個字都不送瀏覽器', async () => {
  for (const p of ['/api/settings', '/api/cards', '/api/db', '/api/summary']) {
    const body = await (await as('tokA', p)).text();
    for (const secret of [FLEX, TAISHIN, CARDPW]) {
      assert.ok(!body.includes(secret), `${p} 把機密送到瀏覽器了！`);
    }
    assert.ok(!body.includes('enc:v1:'), `${p} 把密文送到瀏覽器了（沒意義又洩漏了長度資訊）`);
  }
});

// ============================================================================
// 三、雲端匯出／匯入（裁決⑤＋C0 威脅模型）
// ============================================================================

test('雲端匯出：不含機密（裁決⑤），但其餘資料完整、可還原', async () => {
  const body = await (await as('tokA', '/api/export')).text();
  for (const secret of [FLEX, TAISHIN, CARDPW]) assert.ok(!body.includes(secret), '雲端匯出不可含機密');
  assert.ok(!body.includes('enc:v1:'), '也不可以含密文（那等於把加密後的機密交出去）');
  const dump = JSON.parse(body);
  assert.equal(dump.settings.taishinSecPdfPassword, '', '欄位要留著且為空＝「未設定」，不是整個消失');
  assert.equal(dump.settings.ib.flexToken, '');
  assert.equal(dump.cards[0].pdfPassword, '');
  assert.equal(dump.cards[0].name, '測試卡', '非機密資料必須完整');
});

// ⚠️ 2026-07-28 新增。這是 Codex 收官審查 #7（accountNo）**確認可避免的那一半**：
//    「資料庫裡要不要加密」仍是 William 的裁決，但「完整帳號跟著備份檔離開伺服器」不必等裁決——
//    裁決⑤剝掉三個機密欄位的理由（檔案會被下載、可能轉寄或存到別處）對 accountNo 一字不差適用，
//    當初只是因為 accountNo 不在 C0 第五節的機密清單裡而漏掉。
test('雲端匯出：完整帳號也不可以跟著備份檔離開伺服器（accountNo）', async () => {
  const body = await (await as('tokA', '/api/export')).text();
  assert.ok(!body.includes(FULL_ACCOUNT_NO),
    `雲端匯出夾帶了完整帳號（${FULL_ACCOUNT_NO}）——那個檔案會被下載到裝置上、可能轉寄`);
  const dump = JSON.parse(body);
  const acc = dump.accounts.find((/** @type {any} */ a) => a.id === ACCOUNT_ID);
  assert.equal(acc.accountNo, '', '欄位要留著且為空＝「未設定」，不是整個消失（還原時才不會少一個鍵）');
  assert.equal(acc.name, '測試帳戶', '非機密資料必須完整');
});

test('accountNo 只從備份檔剝除，**沒有**被加密——那是 William 的裁決，不可以順手代決', async () => {
  // 資料庫裡那一份必須原封不動是明文。加密會連帶影響 matchAccount 的可見前綴比對與 ownSuffixSet
  // （見 lib/secret-fields.js 檔頭 📌），是另一件事、要另外決定。
  const raw = JSON.stringify(pg.selectAs(A.id));
  assert.ok(raw.includes(FULL_ACCOUNT_NO),
    '資料庫裡的 accountNo 應該還是明文——這一題若變紅，代表有人把 accountNo 加進了加密清單');
  assert.ok(!raw.includes(`enc:v1:${FULL_ACCOUNT_NO}`), 'sanity');
});

test('stripSecretsForBackup：深拷貝，不可以順手把記憶體裡那包也清掉', () => {
  const live = { settings: { taishinSecPdfPassword: TAISHIN, ib: { flexToken: FLEX } }, cards: [{ id: 'c1', pdfPassword: CARDPW }] };
  const out = stripSecretsForBackup(live);
  assert.equal(out.settings.ib.flexToken, '');
  assert.equal(live.settings.ib.flexToken, FLEX, '原物件必須完好——它可能還要拿去用');
  assert.equal(live.cards[0].pdfPassword, CARDPW);
});

test('匯入：檔案裡夾帶的機密一律不採用，但已設定的憑證要保住（留空＝不變更）', async () => {
  const evil = {
    settings: { usdTwd: 31, taishinSecPdfPassword: 'EVIL-INJECTED-1', ib: { flexToken: 'EVIL-INJECTED-2' } },
    cards: [{ id: 'evil-card', name: '匯入的卡', pdfPassword: 'EVIL-INJECTED-3' }],
  };
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(evil) });
  assert.equal(r.status, 200, await r.clone().text());

  const raw = rawOf(A.id);
  for (const injected of ['EVIL-INJECTED-1', 'EVIL-INJECTED-2', 'EVIL-INJECTED-3']) {
    assert.ok(!raw.includes(injected), '匯入檔的機密不可以進資料庫（明文或密文都不行）');
  }
  // 已設定的憑證要保住（否則「還原一次備份」＝把 IB token 洗掉，使用者不會知道）
  const settings = await (await as('tokA', '/api/settings')).json();
  assert.equal(settings.ib.flexTokenSet, true, '匯入不可以把已設定的 IB token 清掉');
  assert.equal(settings.taishinSecPdfPasswordSet, true);
  assert.equal(settings.usdTwd, 31, '非機密欄位照常還原');
});

// ============================================================================
// 四、跨租戶：加密不會變成新的洩漏管道
// ============================================================================

test('跨租戶：B 存了同一組機密，兩人的密文不同，且互相看不到（C4b 隔離 ＋ C5 加密疊加）', async () => {
  await as('tokB', '/api/settings', { method: 'PUT', body: JSON.stringify({ ib: { flexToken: FLEX } }) });
  const rawA = rawOf(A.id);
  const rawB = rawOf(B.id);
  assert.ok(rawA.includes('enc:v1:') && rawB.includes('enc:v1:'));
  assert.notEqual(rawA, rawB);
  // 同一份明文在兩個人的列上密文不同（IV 隨機＋AAD 綁使用者）→ 無法用「密文相等」比對出誰跟誰用同一組憑證
  const ctA = JSON.parse(rawA).find((/** @type {any} */ r) => r.key === 'settings')?.data?.ib?.flexToken;
  const ctB = JSON.parse(rawB).find((/** @type {any} */ r) => r.key === 'settings')?.data?.ib?.flexToken;
  assert.ok(ctA && ctB && ctA !== ctB, '同一份明文在不同租戶的密文必須不同');
  const bSettings = await (await as('tokB', '/api/settings')).json();
  assert.equal(bSettings.taishinSecPdfPasswordSet, false, 'B 沒設過台新密碼，不可以看到 A 的');
});

// ============================================================================
// 五、錯誤訊息全鏈路不得含機密（C0 對抗考題第 6 條）
// ============================================================================

test('錯誤訊息：解密失敗的警告只講欄位路徑，不含值也不含密文', () => {
  /** @type {string[]} */
  const warned = [];
  const orig = console.warn;
  console.warn = (/** @type {any[]} */ ...args) => warned.push(args.join(' '));
  try {
    const ct = encryptSecret(TAISHIN, 'user-A|settings.taishinSecPdfPassword');
    decryptSecret(ct, 'user-WRONG|settings.taishinSecPdfPassword');   // 解不開 → 會警告
  } finally { console.warn = orig; }
  assert.equal(warned.length, 1, '解不開一定要出聲（靜默＝使用者不知道憑證失效了）');
  assert.ok(!warned[0].includes(TAISHIN), '警告訊息不可含機密值');
  assert.ok(!warned[0].includes('enc:v1:'), '也不要把密文整串印出來');
  assert.match(warned[0], /taishinSecPdfPassword/, '但要講清楚是哪個欄位，使用者才知道去哪裡重設');
});

test('錯誤訊息：壞請求打各個端點，回應一律不含機密值', async () => {
  const probes = [
    ['/api/import', 'POST', '{"settings":{},"transactions":"oops"}'],
    ['/api/cards/does-not-exist', 'PUT', '{"name":"x"}'],
    ['/api/settings', 'PUT', '{"usdTwd":"not-a-number"}'],
    ['/api/statement/preview', 'POST', '{"data":"not-a-pdf"}'],
    ['/api/securities/preview', 'POST', '{"data":"not-a-pdf"}'],
    ['/api/bank-statement/preview', 'POST', '{"data":"not-a-pdf"}'],
  ];
  for (const [p, method, body] of probes) {
    const r = await as('tokA', p, { method, body });
    const text = await r.text();
    for (const secret of [FLEX, TAISHIN, CARDPW]) {
      assert.ok(!text.includes(secret), `${method} ${p} 的錯誤回應含機密值！`);
    }
    assert.ok(!text.includes('enc:v1:'), `${method} ${p} 的錯誤回應含密文！`);
  }
});
