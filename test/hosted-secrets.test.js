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

// ============================================================================
// ⚠️ 走完「匯出→匯入」整趟的考題（2026-07-29 補；沒有這些題就是上一版那個 blocking 回歸）
// ============================================================================
//
// 上一版只斷言**匯出端**（備份檔不含完整帳號、資料庫裡未加密），於是
// 「剝掉之後匯入端沒有對稱地保留回來」這件事完全沒被守住——
// 匯出→匯入回自己的帳號會把所有帳號洗成空字串，**而且回 200**。
// 教訓：**剝除與還原是一對，考題也必須成對**。只考單邊等於沒考。

test('來回①：匯出→匯入回自己的帳號，完整帳號必須還在（不可以被洗成空字串）', async () => {
  const before = await (await as('tokA', '/api/accounts')).json();
  const acc = before.find((/** @type {any} */ a) => a.id === ACCOUNT_ID);
  assert.equal(acc?.accountNoSet, true, '前置條件：帳號本來是有設定的');

  const backup = await (await as('tokA', '/api/export')).json();
  assert.equal(backup.accounts.find((/** @type {any} */ a) => a.id === ACCOUNT_ID).accountNo, '',
    '前置條件：備份檔本身確實不含完整帳號（那是刻意的）');

  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200, `還原自己的備份應該成功：${await r.clone().text()}`);

  const after = await (await as('tokA', '/api/accounts')).json();
  const acc2 = after.find((/** @type {any} */ a) => a.id === ACCOUNT_ID);
  assert.equal(acc2?.accountNoSet, true,
    '還原自己的備份之後，完整帳號必須還在——被洗掉的話 matchAccount 會配不到，' +
    '每期帳單多開一個重複帳戶、淨資產默默多算，而畫面回 200 說成功');
  assert.equal(acc2?.accountNoLast4, FULL_ACCOUNT_NO.slice(-4), '末四碼要對得上原值');
  // 資料層再確認一次（API 回應說 ok 正是這個 bug 的一部分）
  assert.ok(rawOf(A.id).includes(FULL_ACCOUNT_NO), '資料庫裡的完整帳號必須原封不動');
});

test('來回②：三個機密欄位在同一趟來回中也要保住（對照組）', async () => {
  // ⚠️ 這一題 v2 是**假考題**（Codex 定向複審：把它自己的 export/import 兩行刪掉，21/21 照樣全過）——
  //    它只是在檢查「前一題跑完之後機密還在」，證明不了本題宣稱的那趟來回。
  //    修法：**先把機密換成本題專屬的新值**，再走來回，最後斷言新值還在。
  //    這樣受測的那趟匯出匯入就**提供了「受保護狀態被覆寫或清除的機會」**，斷言才有意義
  //    （措辭依 Codex 2026-07-29 定案；不是「唯一能讓斷言成立的路徑」——保存型考題不是那個結構）。
  const RT_FLEX = `FLEX-ROUNDTRIP-${Date.now()}`;
  const put = await as('tokA', '/api/settings', {
    method: 'PUT', body: JSON.stringify({ ib: { flexToken: RT_FLEX, flexQueryId: '123' } }),
  });
  assert.equal(put.status, 200, '前置條件：換上本題專屬的新 token');
  const settingsRow = () => pg.selectAs(A.id).find(r => r.key === 'settings')?.data;
  // ⚠️ **不可以比對密文本身**：AES-GCM 每次用新的 nonce，同一個明文加密兩次密文必然不同
  //    （第一版就是這樣紅的）。要比**解密之後的值**。
  const { decryptSecret } = await import('../lib/crypto-secrets.js');
  const plainOf = () => decryptSecret(String(settingsRow()?.ib?.flexToken || ''), `${A.id}|settings.ib.flexToken`);
  assert.ok(String(settingsRow()?.ib?.flexToken).startsWith('enc:v1:'), '前置條件：新 token 已加密落庫');
  assert.equal(plainOf(), RT_FLEX, '前置條件：資料庫裡解出來就是本題專屬的新 token');

  const backup = await (await as('tokA', '/api/export')).json();
  assert.equal(backup.settings.ib.flexToken, '', '前置條件：備份檔本身不含機密（裁決⑤）');
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200, `還原應該成功：${await r.clone().text()}`);

  // 斷言看**資料庫原始列**：密文要與匯入前完全相同（＝那一趟來回沒有把它換掉或清掉）
  assert.equal(plainOf(), RT_FLEX,
    '這一趟來回把 IB token 換掉或清掉了（解密後的值必須還是本題種下去的那一個）');
  const s2 = await (await as('tokA', '/api/settings')).json();
  assert.equal(s2.ib.flexTokenSet, true, 'IB token 要保住');
  assert.equal(s2.taishinSecPdfPasswordSet, true, '台新密碼要保住');
  const cards = await (await as('tokA', '/api/cards')).json();
  assert.equal(cards[0].pdfPasswordSet, true, '卡片密碼要保住');
});

test('來回⑤：舊備份**根本沒有 accountNo 欄位**時，現值一樣不可以被洗掉', async () => {
  // ⚠️ Codex 定向複審抓到的 blocking：v2 的 `mapBackupOnlyPii` 寫成 `if ('accountNo' in a)`，
  //    於是舊備份（升級前產生的、根本沒有那個欄位）整個被跳過 → 還原路徑沒機會把現值填回去
  //    → 帳號照樣被洗掉，而且回 200。
  //    「留空＝不變更」的相容性宣稱**必須連「欄位不存在」一起涵蓋**，否則那句話是假的。
  const before = await (await as('tokA', '/api/accounts')).json();
  assert.equal(before.find((/** @type {any} */ a) => a.id === ACCOUNT_ID)?.accountNoSet, true, '前置條件');

  const backup = await (await as('tokA', '/api/export')).json();
  // 模擬「升級前產生的舊備份」：整個欄位不存在（不是空字串）
  for (const a of backup.accounts) delete a.accountNo;
  assert.ok(!('accountNo' in backup.accounts.find((/** @type {any} */ a) => a.id === ACCOUNT_ID)),
    '前置條件：欄位真的被刪掉了（不是空字串）');

  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200, `舊備份應該還原得回來：${await r.clone().text()}`);
  const after = await (await as('tokA', '/api/accounts')).json();
  assert.equal(after.find((/** @type {any} */ a) => a.id === ACCOUNT_ID)?.accountNoSet, true,
    '舊備份（沒有 accountNo 欄位）把現值洗掉了——「留空＝不變更」沒有涵蓋「欄位不存在」');
  assert.ok(rawOf(A.id).includes(FULL_ACCOUNT_NO), '資料庫裡的完整帳號必須原封不動');
});

test('來回③：匯入檔裡帶著完整帳號時要照收（LOCAL 的完整備份搬進雲端不可以反而被清掉）', async () => {
  // accountNo 的語意與機密欄位**刻意不同**：機密一律不採用檔案裡的值（可能來自別處、不可信），
  // accountNo 走「留空＝不變更」——它不是憑證，只是不該跟著檔案出門。
  const NEW_NO = '900100999988887777';
  const backup = await (await as('tokA', '/api/export')).json();
  backup.accounts.find((/** @type {any} */ a) => a.id === ACCOUNT_ID).accountNo = NEW_NO;
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200);
  const after = await (await as('tokA', '/api/accounts')).json();
  assert.equal(after.find((/** @type {any} */ a) => a.id === ACCOUNT_ID)?.accountNoLast4, '7777',
    '檔案裡有值就要照收');
  // 收尾：改回原值，不影響後續題目
  await as('tokA', `/api/accounts/${ACCOUNT_ID}`, { method: 'PUT', body: JSON.stringify({ accountNo: FULL_ACCOUNT_NO }) });
});

test('來回④：沒有 id 的帳戶路徑會撞號 → 一律不還原，**絕不可以把甲的帳號寫進乙那一格**', async () => {
  // `accounts[].id` 不在必填欄位裡（`lib/schema.js`），兩筆沒有 id 的帳戶會算出同一個
  // 路徑 `accounts..accountNo`，而還原是**按路徑寫的**——沒有護欄的話會把甲的帳號填進乙那一格。
  // 與 `lib/store-pg.js` 對 `cards..pdfPassword` 的處置同一個判準：
  // **寧可少救一個欄位，也不要把資料寫錯。**
  //
  // ⚠️ 這一題第一版只斷言「兩筆會算出同一個路徑」——**護欄拿掉照樣綠**（突變測試當場抓到）。
  //    要走**正式匯入路徑**、斷言「乙沒有拿到甲的號碼」才算數。
  const A_NO = '111122223333';
  const B_NO = '444455556666';
  const twoNoId = {
    settings: {},
    accounts: [
      { name: '無 id 甲', type: 'cash', currency: 'TWD', balance: 1, accountNo: A_NO },
      { name: '無 id 乙', type: 'cash', currency: 'TWD', balance: 2, accountNo: B_NO },
    ],
  };
  // ① 先用匯入把這兩筆種進去（這是唯一能造出「沒有 id 的帳戶」的正式路徑）
  assert.equal((await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(twoNoId) })).status, 200);
  const seeded = JSON.parse(rawOf(A.id));
  const seededAccounts = seeded.find((/** @type {any} */ r) => r.key === 'accounts')?.data || [];
  assert.equal(seededAccounts.length, 2, '前置條件：兩筆都進去了');

  // ② 匯出（accountNo 被剝成空）→ 再匯入回來
  const backup = await (await as('tokA', '/api/export')).json();
  assert.equal((await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) })).status, 200);

  // ③ 關鍵斷言：**不准出現「甲的號碼跑到乙身上」**
  const after = JSON.parse(rawOf(A.id));
  const accs = after.find((/** @type {any} */ r) => r.key === 'accounts')?.data || [];
  const 甲 = accs.find((/** @type {any} */ a) => a.name === '無 id 甲');
  const 乙 = accs.find((/** @type {any} */ a) => a.name === '無 id 乙');
  assert.ok(甲 && 乙, '兩筆帳戶都要還在');
  assert.notEqual(乙.accountNo, A_NO, '❌ 甲的帳號被寫進乙那一格了——路徑撞號的護欄沒生效');
  assert.notEqual(甲.accountNo, B_NO, '❌ 乙的帳號被寫進甲那一格了');
  // 路徑撞號時我們選擇**兩邊都不還原**（空字串），而不是賭一個
  assert.equal(甲.accountNo, '', '撞號時寧可留空');
  assert.equal(乙.accountNo, '', '撞號時寧可留空');

  // 收尾：清掉這兩筆，別影響後面的題目
  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, accounts: [] }) });
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
