// @ts-check
// C5 考題：機密欄位的信封加密、雲端匯出剝機密、匯入不吃機密、錯誤訊息不洩漏。
//
// 三個要一起看的性質：
//   ①**at-rest 加密**：資料庫裡躺的是密文（拿走整顆資料庫也讀不到 token 與身分證字號）。
//   ②**投影**（既有）：機密不送瀏覽器。兩道各管各的，缺一不可——
//     只有投影＝資料庫外流就全裸；只有加密＝前端仍拿得到明文。
//   ③**錯誤訊息**：全鏈路不得出現機密值本身。
import { test, before, beforeEach, after } from 'node:test';
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
const { app, resetRateLimitsForTest } = await import('../server.js');

// 這三個字串就是「機密」——整份考題到處掃它們，任何回應／錯誤訊息／資料庫列出現就算洩漏
const FLEX = 'FLEXTOKEN-SECRET-0001';
const TAISHIN = 'A123456789';        // 台新證券 PDF 密碼＝身分證字號（合成假值）
const CARDPW = 'B987654321';         // 信用卡帳單 PDF 密碼（合成假值）
const FULL_ACCOUNT_NO = '9001001234567890';   // 完整銀行帳號（PII，合成假值）

// ⚠️ **每題開始前把限速計數歸零**（2026-07-29）：「上傳解析類」是每帳號每 5 分鐘 30 次，
// 而這一檔有十幾題各自走 `/api/import`——排在後面的題目會拿到 **429 而不是它要考的東西**。
// 那個失敗長得跟真 bug 一模一樣（實測連續踩到兩次：一次 413→429、一次機密保存題），
// 而且**每加一題就往前推一格**。限速本身另有 `test/server.test.js` 專門考，這裡歸零不會漏掉它。
beforeEach(() => resetRateLimitsForTest());

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

// ⚠️ **每題自己種、自己驗前置條件**（鐵則 9③；Codex 定向複審 2026-07-29 抓到共用 `ACCOUNT_ID`）。
//    共用可變狀態的代價不是「不夠漂亮」：前一題失敗時，後面每一題都會在 precondition 連鎖失敗，
//    一次紅十題、真正的病因埋在最上面那一條裡。而且單題重跑會直接掛掉，
//    突變測試的「這一題有沒有轉紅」也就分不清是修法生效還是前置條件沒了。

/** 建一個本題專屬的帳戶，順便證明它真的存進去了。 @param {string} tok @param {string} accountNo @param {string} name */
async function newAccount(tok, accountNo, name) {
  const r = await as(tok, '/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name, type: 'cash', currency: 'TWD', balance: 100, accountNo }),
  });
  assert.equal(r.status, 200, `前置條件：建帳戶應該成功——${await r.clone().text()}`);
  const id = (await r.json()).id;
  const list = await (await as(tok, '/api/accounts')).json();
  assert.equal(list.find((/** @type {any} */ a) => a.id === id)?.accountNoSet, true,
    '前置條件：新帳戶的完整帳號真的存進去了（沒存進去的話後面斷言什麼都證明不了）');
  return id;
}

/** 種一組本題專屬的機密（三種各一），回傳本題該用的值。 @param {string} tok @param {string} tag */
async function newSecrets(tok, tag) {
  const flex = `FLEXTOKEN-${tag}`;
  const taishin = `TAISHIN-${tag}`;
  const cardPw = `CARDPW-${tag}`;
  const s = await as(tok, '/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ taishinSecPdfPassword: taishin, ib: { flexToken: flex, flexQueryId: '123' } }),
  });
  assert.equal(s.status, 200, `前置條件：設定機密應該成功——${await s.clone().text()}`);
  const c = await as(tok, '/api/cards', { method: 'POST', body: JSON.stringify({ name: `測試卡-${tag}`, pdfPassword: cardPw }) });
  assert.equal(c.status, 200, `前置條件：建卡片應該成功——${await c.clone().text()}`);
  const cardId = (await c.json()).id;
  return { flex, taishin, cardPw, cardId };
}

/** 從清單裡撈本題自己那一筆（不可以用 `[0]`——別題也會建）。 @param {any[]} list @param {string} id */
const byId = (list, id) => list.find((/** @type {any} */ x) => x.id === id);

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
  // 走真正的寫入路徑（PUT /api/settings ＋ POST /api/cards ＋ POST /api/accounts）
  const { flex, taishin, cardPw } = await newSecrets('tokA', 'at-rest');
  // 帳戶也走真寫入路徑建一個。accountNo 是 PII 但**刻意不加密**——
  // 它只從備份檔剝除，見 lib/secret-fields.js 的兩張清單。
  await newAccount('tokA', FULL_ACCOUNT_NO, '測試帳戶-at-rest');

  const raw = rawOf(A.id);
  for (const [label, secret] of [['IB flexToken', flex], ['台新證券密碼', taishin], ['卡片 PDF 密碼', cardPw]]) {
    assert.ok(!raw.includes(secret), `${label} 以明文躺在資料庫裡！`);
  }
  assert.match(raw, /enc:v1:/, '資料庫裡應該看得到密文前綴');
});

test('可用性：加密之後，伺服器自己讀回來仍拿得到明文（不然功能就壞了）', async () => {
  // /api/export 在 HOSTED 會剝機密，所以改用「能證明伺服器讀得到」的既有行為：
  // 投影後的 …Set 布林為 true ＝ 伺服器手上那份確實是非空的明文。
  const { cardId } = await newSecrets('tokA', 'usable');
  const settings = await (await as('tokA', '/api/settings')).json();
  assert.equal(settings.taishinSecPdfPasswordSet, true);
  assert.equal(settings.ib.flexTokenSet, true);
  const cards = await (await as('tokA', '/api/cards')).json();
  assert.equal(byId(cards, cardId)?.pdfPasswordSet, true);
});

test('投影仍然成立（C5 不可以把既有防線弄壞）：機密一個字都不送瀏覽器', async () => {
  const { flex, taishin, cardPw } = await newSecrets('tokA', 'projection');
  for (const p of ['/api/settings', '/api/cards', '/api/db', '/api/summary']) {
    const body = await (await as('tokA', p)).text();
    for (const secret of [flex, taishin, cardPw]) {
      assert.ok(!body.includes(secret), `${p} 把機密送到瀏覽器了！`);
    }
    assert.ok(!body.includes('enc:v1:'), `${p} 把密文送到瀏覽器了（沒意義又洩漏了長度資訊）`);
  }
});

// ============================================================================
// 三、雲端匯出／匯入（裁決⑤＋C0 威脅模型）
// ============================================================================

test('雲端匯出：不含機密（裁決⑤），但其餘資料完整、可還原', async () => {
  const { flex, taishin, cardPw, cardId } = await newSecrets('tokA', 'export');
  const body = await (await as('tokA', '/api/export')).text();
  for (const secret of [flex, taishin, cardPw]) assert.ok(!body.includes(secret), '雲端匯出不可含機密');
  assert.ok(!body.includes('enc:v1:'), '也不可以含密文（那等於把加密後的機密交出去）');
  const dump = JSON.parse(body);
  assert.equal(dump.settings.taishinSecPdfPassword, '', '欄位要留著且為空＝「未設定」，不是整個消失');
  assert.equal(dump.settings.ib.flexToken, '');
  const card = byId(dump.cards, cardId);
  assert.equal(card.pdfPassword, '');
  assert.equal(card.name, '測試卡-export', '非機密資料必須完整');
});

// ⚠️ 2026-07-28 新增。這是 Codex 收官審查 #7（accountNo）**確認可避免的那一半**：
//    「資料庫裡要不要加密」仍是 William 的裁決，但「完整帳號跟著備份檔離開伺服器」不必等裁決——
//    裁決⑤剝掉三個機密欄位的理由（檔案會被下載、可能轉寄或存到別處）對 accountNo 一字不差適用，
//    當初只是因為 accountNo 不在 C0 第五節的機密清單裡而漏掉。
test('雲端匯出：完整帳號也不可以跟著備份檔離開伺服器（accountNo）', async () => {
  const NO = '9001001111222233';
  const id = await newAccount('tokA', NO, '測試帳戶-匯出');
  const body = await (await as('tokA', '/api/export')).text();
  assert.ok(!body.includes(NO),
    `雲端匯出夾帶了完整帳號（${NO}）——那個檔案會被下載到裝置上、可能轉寄`);
  const dump = JSON.parse(body);
  const acc = byId(dump.accounts, id);
  assert.equal(acc.accountNo, '', '欄位要留著且為空＝「未設定」，不是整個消失（還原時才不會少一個鍵）');
  assert.equal(acc.name, '測試帳戶-匯出', '非機密資料必須完整');
});

test('accountNo 只從備份檔剝除，**沒有**被加密——那是 William 的裁決，不可以順手代決', async () => {
  // 資料庫裡那一份必須原封不動是明文。加密會連帶影響 matchAccount 的可見前綴比對與 ownSuffixSet
  // （見 lib/secret-fields.js 檔頭 📌），是另一件事、要另外決定。
  const NO = '9001003333444455';
  await newAccount('tokA', NO, '測試帳戶-明文');
  const raw = JSON.stringify(pg.selectAs(A.id));
  assert.ok(raw.includes(NO),
    '資料庫裡的 accountNo 應該還是明文——這一題若變紅，代表有人把 accountNo 加進了加密清單');
  assert.ok(!raw.includes(`enc:v1:${NO}`), 'sanity');
});

// ============================================================================
// ⚠️ 走完「匯出→匯入」整趟的考題（2026-07-29 補；沒有這些題就是上一版那個 blocking 回歸）
// ============================================================================
//
// 上一版只斷言**匯出端**（備份檔不含完整帳號、資料庫裡未加密），於是
// 「剝掉之後匯入端沒有對稱地保留回來」這件事完全沒被守住——
// 匯出→匯入回自己的帳號會把所有帳號洗成空字串，**而且回 200**。
// 教訓：**剝除與還原是一對，考題也必須成對**。只考單邊等於沒考。

// ⚠️⚠️ **保存型考題一定要另外證明「受測操作真的執行了」**（鐵則 9③；Codex 定向複審第七輪抓到）。
//    實測：把 `saveDb` 暫時改成不寫入、handler 仍回 200——來回①②⑤⑪**四題單獨跑全部通過**。
//    它們不是假考題（破壞保存機制時確實會紅），但少了這道證明就分不清
//    「保住了」和「這趟匯入根本沒發生」。作法＝在備份裡同時改一個**非機密**標記，
//    匯入後斷言它已更新；機密／帳號則斷言一字不差。
/**
 * 在備份裡種一個**非機密**標記。用 `settings.usdTwd`：它是純數字、一定會來回、
 * 而且與機密／帳號那兩條路完全無關（不會讓考題自己互相影響）。
 * @param {any} backup @param {number} mark 每題給一個不同的值
 */
function markBackup(backup, mark) {
  backup.settings = { ...(backup.settings || {}), usdTwd: mark };
  return mark;
}
/** 匯入後確認標記真的落庫了＝這趟匯入確實寫進去。 @param {number} mark */
async function assertImportRan(mark) {
  const settings = await (await as('tokA', '/api/settings')).json();
  assert.equal(settings?.usdTwd, mark,
    `這趟匯入沒有真的寫進去（非機密標記 usdTwd=${mark} 不在資料庫裡）——` +
    '底下「機密／帳號保住了」的斷言證明不了任何事');
}

test('來回①：匯出→匯入回自己的帳號，完整帳號必須還在（不可以被洗成空字串）', async () => {
  const NO = '9001005555666677';
  const id = await newAccount('tokA', NO, '測試帳戶-來回1');

  const backup = await (await as('tokA', '/api/export')).json();
  assert.equal(byId(backup.accounts, id).accountNo, '',
    '前置條件：備份檔本身確實不含完整帳號（那是刻意的）');
  const mark = markBackup(backup, 31.11);

  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200, `還原自己的備份應該成功：${await r.clone().text()}`);
  await assertImportRan(mark);

  const after = await (await as('tokA', '/api/accounts')).json();
  const acc2 = byId(after, id);
  assert.equal(acc2?.accountNoSet, true,
    '還原自己的備份之後，完整帳號必須還在——被洗掉的話 matchAccount 會配不到，' +
    '每期帳單多開一個重複帳戶、淨資產默默多算，而畫面回 200 說成功');
  assert.equal(acc2?.accountNoLast4, NO.slice(-4), '末四碼要對得上原值');
  // 資料層再確認一次（API 回應說 ok 正是這個 bug 的一部分）
  assert.ok(rawOf(A.id).includes(NO), '資料庫裡的完整帳號必須原封不動');
});

test('來回②：三個機密欄位在同一趟來回中也要保住（對照組）', async () => {
  // ⚠️ 這一題 v2 是**假考題**（Codex 定向複審：把它自己的 export/import 兩行刪掉，21/21 照樣全過）——
  //    它只是在檢查「前一題跑完之後機密還在」，證明不了本題宣稱的那趟來回。
  //    修法：**先把機密換成本題專屬的新值**，再走來回，最後斷言新值還在。
  //    這樣受測的那趟匯出匯入就**提供了「受保護狀態被覆寫或清除的機會」**，斷言才有意義
  //    （措辭依 Codex 2026-07-29 定案；不是「唯一能讓斷言成立的路徑」——保存型考題不是那個結構）。
  // ⚠️ v5 再修一次（Codex 定向複審第三輪）：原本三個機密只有 flexToken 精確比對，
  //    另外兩個只驗 `…Set === true`。實測「保留正確 flexToken、把另外兩個換成錯誤的非空值」
  //    → 25/25 全綠。**「有值」不等於「還是原來那個值」**——換錯人的密碼一樣是 true。
  //    所以三個一律從假 Postgres 的原始列解密、逐一比對本題剛種下去的確切值。
  const { flex: RT_FLEX, taishin: RT_TAISHIN, cardPw: RT_CARDPW, cardId } = await newSecrets('tokA', 'roundtrip2');
  const rowOf = (/** @type {string} */ key) => pg.selectAs(A.id).find(r => r.key === key)?.data;
  // ⚠️ **不可以比對密文本身**：AES-GCM 每次用新的 nonce，同一個明文加密兩次密文必然不同
  //    （第一版就是這樣紅的）。要比**解密之後的值**。
  const { decryptSecret } = await import('../lib/crypto-secrets.js');
  /** 三個機密在資料庫裡「解密之後」各是什麼。 */
  const plaintexts = () => {
    const settings = rowOf('settings') || {};
    const card = (rowOf('cards') || []).find((/** @type {any} */ c) => c.id === cardId) || {};
    return {
      flex: decryptSecret(String(settings?.ib?.flexToken || ''), `${A.id}|settings.ib.flexToken`),
      taishin: decryptSecret(String(settings?.taishinSecPdfPassword || ''), `${A.id}|settings.taishinSecPdfPassword`),
      cardPw: decryptSecret(String(card?.pdfPassword || ''), `${A.id}|cards.${cardId}.pdfPassword`),
    };
  };
  const expected = { flex: RT_FLEX, taishin: RT_TAISHIN, cardPw: RT_CARDPW };
  assert.ok(String(rowOf('settings')?.ib?.flexToken).startsWith('enc:v1:'), '前置條件：新 token 已加密落庫');
  assert.deepEqual(plaintexts(), expected, '前置條件：資料庫裡解出來就是本題種下去的那三個值');

  const backup = await (await as('tokA', '/api/export')).json();
  assert.equal(backup.settings.ib.flexToken, '', '前置條件：備份檔本身不含機密（裁決⑤）');
  const mark = markBackup(backup, 31.22);
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200, `還原應該成功：${await r.clone().text()}`);
  await assertImportRan(mark);

  // 斷言看**資料庫原始列**：三個解密後的值都要與匯入前一字不差
  assert.deepEqual(plaintexts(), expected,
    '這一趟來回把某個機密換掉或清掉了——三個都必須還是本題種下去的那一個（不是「有值就好」）');
});

test('來回⑤：舊備份**根本沒有 accountNo 欄位**時，現值一樣不可以被洗掉', async () => {
  // ⚠️ Codex 定向複審抓到的 blocking：v2 的 `mapBackupOnlyPii` 寫成 `if ('accountNo' in a)`，
  //    於是舊備份（升級前產生的、根本沒有那個欄位）整個被跳過 → 還原路徑沒機會把現值填回去
  //    → 帳號照樣被洗掉，而且回 200。
  //    「留空＝不變更」的相容性宣稱**必須連「欄位不存在」一起涵蓋**，否則那句話是假的。
  const NO = '9001007777888899';
  const id = await newAccount('tokA', NO, '測試帳戶-來回5');

  const backup = await (await as('tokA', '/api/export')).json();
  // 模擬「升級前產生的舊備份」：整個欄位不存在（不是空字串）
  for (const a of backup.accounts) delete a.accountNo;
  assert.ok(!('accountNo' in byId(backup.accounts, id)),
    '前置條件：欄位真的被刪掉了（不是空字串）');
  const mark = markBackup(backup, 31.55);

  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200, `舊備份應該還原得回來：${await r.clone().text()}`);
  await assertImportRan(mark);
  const after = await (await as('tokA', '/api/accounts')).json();
  assert.equal(byId(after, id)?.accountNoSet, true,
    '舊備份（沒有 accountNo 欄位）把現值洗掉了——「留空＝不變更」沒有涵蓋「欄位不存在」');
  assert.ok(rawOf(A.id).includes(NO), '資料庫裡的完整帳號必須原封不動');
});

test('來回③：匯入檔裡帶著完整帳號時要照收（LOCAL 的完整備份搬進雲端不可以反而被清掉）', async () => {
  // accountNo 的語意與機密欄位**刻意不同**：機密一律不採用檔案裡的值（可能來自別處、不可信），
  // accountNo 走「留空＝不變更」——它不是憑證，只是不該跟著檔案出門。
  const NEW_NO = '900100999988887777';
  const id = await newAccount('tokA', '9001002222333344', '測試帳戶-來回3');
  const backup = await (await as('tokA', '/api/export')).json();
  byId(backup.accounts, id).accountNo = NEW_NO;
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200);
  // ⚠️ v5 修（Codex 定向複審第三輪）：原本只驗末四碼，於是「前 14 碼被改壞、只保留末四碼」
  //    照樣全綠。投影只吐末四碼，所以要比對**完整字串**就得看資料庫原始列。
  const after = await (await as('tokA', '/api/accounts')).json();
  assert.equal(byId(after, id)?.accountNoLast4, NEW_NO.slice(-4), '投影的末四碼要對');
  const stored = (JSON.parse(rawOf(A.id)).find((/** @type {any} */ x) => x.key === 'accounts')?.data || [])
    .find((/** @type {any} */ a) => a.id === id);
  assert.equal(stored?.accountNo, NEW_NO,
    '完整帳號必須一字不差＝檔案裡帶的值原封不動收下（只驗末四碼的話，前面被改壞也看不出來）');
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

test('來回⑬：型別碰撞的**反方向**（目前 `"7"`、匯入 `7`）→ 帳號一樣不可以被繼承', async () => {
  // ⚠️ Codex 定向複審第五輪抓到：來回⑨只鎖住「**來源端**不穩定」——來源被略過後 `kept` 本來就是空的，
  //    所以拿掉最終回填處的**目標端** `stable` 判斷，來回⑨照樣全綠。
  //    把方向反過來（來源是合法字串、目標是數字）才殺得到那一道：
  //    `kept` 裡有 `accounts.7.accountNo`，而匯入那筆的 `String(7)` 也算出同一條路徑。
  const OLD_NO = '9001004747474747';
  const seed = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { id: '7', name: '字串 id 的舊帳戶', type: 'cash', currency: 'TWD', balance: 1, accountNo: OLD_NO },
    ] }),
  });
  assert.equal(seed.status, 200, `前置條件：種資料應該成功——${await seed.clone().text()}`);
  assert.ok(rawOf(A.id).includes(OLD_NO), '前置條件：舊帳號真的進資料庫了');

  const r = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { id: 7, name: '數字 id 的另一個帳戶', type: 'cash', currency: 'TWD', balance: 2, accountNo: '' },
    ] }),
  });
  assert.equal(r.status, 200, `匯入應該成功：${await r.clone().text()}`);

  const accs = JSON.parse(rawOf(A.id)).find((/** @type {any} */ x) => x.key === 'accounts')?.data || [];
  assert.equal(accs.length, 1, '前置條件：匯入後只剩新的那一筆');
  assert.equal(accs[0].name, '數字 id 的另一個帳戶', '前置條件：新資料真的取代了舊資料');
  assert.equal(accs[0].accountNo, '',
    `新帳戶繼承了舊帳號（${OLD_NO}）——目標端身分不明時也不可以取用回填值`);

  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, accounts: [] }) });
});

test('來回⑭：型別碰撞的反方向——**卡片密碼**同樣不可以被繼承', async () => {
  // 同來回⑬，換到機密那條路（`lib/routes/core.js` 兩行回填各自都要有考題殺得掉）。
  const { cardPw } = await newSecrets('tokA', 'revdup');
  const seed = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, cards: [{ id: '7', name: '字串 id 的舊卡' }] }),
  });
  assert.equal(seed.status, 200, `前置條件：種資料應該成功——${await seed.clone().text()}`);
  // 用正式路徑把密碼設進那張字串 id 的卡（匯入不採用檔案裡的機密，所以要另外設）
  const put = await as('tokA', '/api/cards/7', { method: 'PUT', body: JSON.stringify({ pdfPassword: cardPw }) });
  assert.equal(put.status, 200, `前置條件：設密碼應該成功——${await put.clone().text()}`);
  assert.equal(byId(await (await as('tokA', '/api/cards')).json(), '7')?.pdfPasswordSet, true, '前置條件：舊卡真的有密碼');

  const r = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, cards: [{ id: 7, name: '數字 id 的另一張卡', pdfPassword: '' }] }),
  });
  assert.equal(r.status, 200, `匯入應該成功：${await r.clone().text()}`);

  const cards = await (await as('tokA', '/api/cards')).json();
  assert.equal(cards.length, 1, '前置條件：匯入後只剩新的那一張');
  assert.equal(cards[0].name, '數字 id 的另一張卡', '前置條件：新資料真的取代了舊資料');
  assert.equal(cards[0].pdfPasswordSet, false,
    '新卡繼承了舊卡的 PDF 密碼——目標端身分不明時也不可以取用回填值');

  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, cards: [] }) });
});

test('來回⑪：舊備份**省略 pdfPassword 欄位**時，現有密碼一樣不可以被洗掉', async () => {
  // ⚠️ Codex 定向複審第四輪抓到的 High：`mapSecrets` 原本寫 `'pdfPassword' in c`，
  //    而 `validateImportItem` 允許舊備份省略非必填欄位——於是那張卡整個被跳過，
  //    現有密碼沒機會被填回，**匯入回 200 之後永久消失**。
  //    這是 `mapBackupOnlyPii` v2 修過的同一個病，在 `mapSecrets` 裡沒人修。
  const { cardPw, cardId } = await newSecrets('tokA', 'omitfield');
  const before = await (await as('tokA', '/api/cards')).json();
  assert.equal(byId(before, cardId)?.pdfPasswordSet, true, '前置條件：那張卡真的有密碼');

  const backup = await (await as('tokA', '/api/export')).json();
  // 模擬「升級前產生的舊備份」：整個欄位不存在（不是空字串）
  for (const c of backup.cards) delete c.pdfPassword;
  assert.ok(!('pdfPassword' in byId(backup.cards, cardId)), '前置條件：欄位真的被刪掉了');
  const mark = markBackup(backup, 31.99);

  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(backup) });
  assert.equal(r.status, 200, `舊備份應該還原得回來：${await r.clone().text()}`);
  await assertImportRan(mark);

  const after = await (await as('tokA', '/api/cards')).json();
  assert.equal(byId(after, cardId)?.pdfPasswordSet, true,
    '舊備份（沒有 pdfPassword 欄位）把現有密碼洗掉了——「留空＝不變更」沒有涵蓋「欄位不存在」');
  // 「有值」不夠，要**還是原來那一個**
  const { decryptSecret } = await import('../lib/crypto-secrets.js');
  const storedCard = (pg.selectAs(A.id).find(r2 => r2.key === 'cards')?.data || [])
    .find((/** @type {any} */ c) => c.id === cardId);
  assert.equal(decryptSecret(String(storedCard?.pdfPassword || ''), `${A.id}|cards.${cardId}.pdfPassword`), cardPw,
    '解出來必須還是本題種下去的那一組密碼');
});

test('來回⑫：兩張同 id 的卡，其中一張**省略欄位** → 不可以繞過撞號偵測拿到舊密碼', async () => {
  // ⚠️ 同一個 High 的第二個後果（Codex 實測重現）：目標側只走訪「有欄位」的那一張，
  //    於是同一條路徑只被數到一次 → **撞號偵測整個繞過** → 舊密碼被填進其中一張。
  //    來回⑩兩張都明寫 `pdfPassword: ''`，所以打不到這條縫。
  const { cardId } = await newSecrets('tokA', 'omitdup');
  assert.equal(byId(await (await as('tokA', '/api/cards')).json(), cardId)?.pdfPasswordSet, true, '前置條件');

  const r = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, cards: [
      { id: cardId, name: '同 id 卡甲（有欄位）', pdfPassword: '' },
      { id: cardId, name: '同 id 卡乙（省略欄位）' },   // ← 刻意沒有 pdfPassword
    ] }),
  });
  assert.equal(r.status, 200, `匯入應該成功：${await r.clone().text()}`);

  const cards = await (await as('tokA', '/api/cards')).json();
  assert.equal(cards.length, 2, '前置條件：兩張同 id 的卡都要真的落庫，這一題才考得到撞號');
  const withPw = cards.filter((/** @type {any} */ c) => c.pdfPasswordSet);
  assert.equal(withPw.length, 0,
    `有 ${withPw.length} 張卡拿到密碼（${withPw.map((/** @type {any} */ c) => c.name).join('、')}）` +
    '——省略欄位讓目標側少數一次，撞號偵測被繞過');

  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, cards: [] }) });
});

test('來回⑨：id 型別碰撞（目前 `7`、匯入 `"7"`）→ 不可以繼承舊帳號', async () => {
  // ⚠️ Codex 定向複審 v5 抓到：路徑一律用 `String(id)` 組，所以數字 7 與字串 "7"
  //    算出**同一條路徑**，而 `lib/schema.js` 的匯入驗證刻意保留任意型別的 id。
  //    兩側各只有一筆 → 撞號數不出來 → 新帳戶繼承舊帳號、回 200。
  //    修法＝身分只認**非空字串**（`isStableId`）。
  const OLD_NO = '9001001212121212';
  const seed = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { id: 7, name: '數字 id 的舊帳戶', type: 'cash', currency: 'TWD', balance: 1, accountNo: OLD_NO },
    ] }),
  });
  assert.equal(seed.status, 200, `前置條件：種資料應該成功——${await seed.clone().text()}`);
  assert.ok(rawOf(A.id).includes(OLD_NO), '前置條件：舊帳號真的進資料庫了');

  const r = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { id: '7', name: '字串 id 的另一個帳戶', type: 'cash', currency: 'TWD', balance: 2, accountNo: '' },
    ] }),
  });
  assert.equal(r.status, 200, `匯入應該成功：${await r.clone().text()}`);

  const accs = JSON.parse(rawOf(A.id)).find((/** @type {any} */ x) => x.key === 'accounts')?.data || [];
  assert.equal(accs.length, 1, '前置條件：匯入後只剩新的那一筆');
  assert.equal(accs[0].name, '字串 id 的另一個帳戶', '前置條件：確實是新的那一筆');
  assert.equal(accs[0].accountNo, '',
    `新帳戶繼承了舊帳號（${OLD_NO}）——數字 id 與字串 id 會算出同一條路徑，不可以當身分`);

  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, accounts: [] }) });
});

test('來回⑩：**機密欄位**同樣要有身分／歧義防線（匯入兩張同 id 的卡不可以共用同一組密碼）', async () => {
  // ⚠️ Codex 定向複審 v5 抓到的 High：accountNo 那條路修了三輪，**機密那條路完全沒有這道防線**。
  //    實測：先建一張有 PDF 密碼的卡，再匯入兩張同 id、密碼留空的不同卡 →
  //    兩張的 pdfPasswordSet 都變 true ＝一張卡的密碼被複製給兩張。
  //    同一個判準（keepableByPath）現在兩張清單共用。
  const { cardId, cardPw } = await newSecrets('tokA', 'dupcard');
  const before = await (await as('tokA', '/api/cards')).json();
  assert.equal(byId(before, cardId)?.pdfPasswordSet, true, '前置條件：那張卡真的有密碼');

  const r = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, cards: [
      { id: cardId, name: '同 id 卡甲', pdfPassword: '' },
      { id: cardId, name: '同 id 卡乙', pdfPassword: '' },
    ] }),
  });
  assert.equal(r.status, 200, `匯入應該成功：${await r.clone().text()}`);

  const cards = await (await as('tokA', '/api/cards')).json();
  assert.equal(cards.length, 2, '前置條件：兩張同 id 的卡都要真的落庫，這一題才考得到撞號');
  const withPw = cards.filter((/** @type {any} */ c) => c.pdfPasswordSet);
  assert.equal(withPw.length, 0,
    `有 ${withPw.length} 張卡拿到密碼（${withPw.map((/** @type {any} */ c) => c.name).join('、')}）` +
    '——同 id 撞號時不可以把一張卡的密碼複製給兩張');
  assert.ok(!rawOf(A.id).includes(cardPw), '資料庫裡不該再有那組密碼的明文');

  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, cards: [] }) });
});

test('來回⑦：目前一筆無 id、匯入另一筆**完全不同的**無 id 帳戶 → 不可以繼承舊帳號', async () => {
  // ⚠️ Codex 定向複審 v4 抓到的 blocking，比來回④⑥更陰：
  //    兩側**各只有一筆**沒有 id 的帳戶，所以「同一條路徑出現兩次」的撞號偵測**根本不會啟動**——
  //    但 `accounts..accountNo` 這個座標對兩筆完全不同的帳戶是同一格，於是
  //    「完全不同的新帳戶」靜靜地繼承了舊帳戶的完整帳號，而且回 200。
  //    修法不是再多數一輪，而是**缺 id 時根本不給座標**（path === null）。
  const OLD_NO = '9001001111222233';

  // ① 目前資料：一筆沒有 id、帶完整帳號的舊帳戶
  const seed = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { name: '舊帳戶', type: 'cash', currency: 'TWD', balance: 1, accountNo: OLD_NO },
    ] }),
  });
  assert.equal(seed.status, 200, `前置條件：種資料應該成功——${await seed.clone().text()}`);
  assert.ok(rawOf(A.id).includes(OLD_NO), '前置條件：舊帳戶的完整帳號真的進資料庫了');

  // ② 匯入一筆**完全不同的**帳戶（也沒有 id、帳號留空）
  const r = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { name: '完全不同的新帳戶', type: 'cash', currency: 'TWD', balance: 2, accountNo: '' },
    ] }),
  });
  assert.equal(r.status, 200, `匯入應該成功（不是靠 500 擋下來的）：${await r.clone().text()}`);

  // ③ 前置條件：受測操作真的把它換掉了（不然下面斷言是空歡喜）
  const accs = JSON.parse(rawOf(A.id)).find((/** @type {any} */ x) => x.key === 'accounts')?.data || [];
  assert.equal(accs.length, 1, '前置條件：匯入後只剩那一筆新帳戶');
  assert.equal(accs[0].name, '完全不同的新帳戶', '前置條件：確實是新的那一筆');

  // ④ 關鍵斷言
  assert.equal(accs[0].accountNo, '',
    `新帳戶繼承了舊帳戶的完整帳號（${OLD_NO}）——沒有 id 的帳戶不可以拿路徑當身分。` +
    '錯的帳號會拿去配銀行帳單、判自家末碼、分內轉');
  assert.ok(!rawOf(A.id).includes(OLD_NO), '資料庫裡不該再有舊帳號');

  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, accounts: [] }) });
});

test('來回⑧：**目前資料**兩筆同 id、匯入只有一筆該 id → 目標不可以拿到任何一個舊帳號', async () => {
  // ⚠️ Codex 定向複審 v4 的漏考：來回④⑥在「來源側」與「目標側」都放兩筆，
  //    所以只要目標側的撞號偵測還在，拿掉來源側的照樣全綠——來源側那道防線沒有被鎖住。
  //    這一題只讓**來源側**撞號，目標側單一筆。
  const DUP_ID = 'dup-source-id';
  const NO_1 = '9001004444555566';
  const NO_2 = '9001006666777788';

  const seed = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { id: DUP_ID, name: '來源甲', type: 'cash', currency: 'TWD', balance: 1, accountNo: NO_1 },
      { id: DUP_ID, name: '來源乙', type: 'cash', currency: 'TWD', balance: 2, accountNo: NO_2 },
    ] }),
  });
  assert.equal(seed.status, 200, `前置條件：種資料應該成功——${await seed.clone().text()}`);
  const seeded = JSON.parse(rawOf(A.id)).find((/** @type {any} */ x) => x.key === 'accounts')?.data || [];
  assert.equal(seeded.length, 2, '前置條件：來源側真的有兩筆同 id（不然這一題考不到來源撞號）');

  // 匯入只有一筆用那個 id、帳號留空
  const r = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { id: DUP_ID, name: '目標', type: 'cash', currency: 'TWD', balance: 3, accountNo: '' },
    ] }),
  });
  assert.equal(r.status, 200, `匯入應該成功：${await r.clone().text()}`);

  const accs = JSON.parse(rawOf(A.id)).find((/** @type {any} */ x) => x.key === 'accounts')?.data || [];
  assert.equal(accs.length, 1, '前置條件：匯入後只剩目標那一筆');
  assert.equal(accs[0].accountNo, '',
    `目標拿到了 ${accs[0].accountNo}——來源側有兩筆同 id 時，回填來源本身就不確定是誰的，不可以賭一個`);

  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, accounts: [] }) });
});

test('來回⑥：**匯入檔裡**兩筆用同一個 id → 不可以兩筆都拿到同一個完整帳號', async () => {
  // ⚠️ Codex 定向複審 2026-07-29 抓到的 blocking：v3 只數「目前資料」那一側的路徑撞號。
  //    那擋得住「現有兩筆沒有 id」（來回④），卻擋不住這一題——目前資料只有一筆、每條路徑都唯一，
  //    退出機制根本不會啟動；但回填是**按路徑**做的，於是匯入後的兩筆帳戶
  //    **同時**從同一條路徑拿到同一個完整帳號。實測會有兩筆收到同一組號碼。
  //    修法＝兩側都數，任一側撞號就關掉「從現值回填」這條退路。
  const DUP_ID = 'dup-account-id';
  const NO = '9001008888999900';

  // ① 目前資料：一筆帶完整帳號、id ＝ DUP_ID（用匯入種，才造得出指定 id）
  const seed = await as('tokA', '/api/import', {
    method: 'POST',
    body: JSON.stringify({ settings: {}, accounts: [
      { id: DUP_ID, name: '原本的', type: 'cash', currency: 'TWD', balance: 1, accountNo: NO },
    ] }),
  });
  assert.equal(seed.status, 200, `前置條件：種資料應該成功——${await seed.clone().text()}`);
  assert.ok(rawOf(A.id).includes(NO), '前置條件：完整帳號真的進資料庫了');

  // ② 匯入檔：兩筆同 id、accountNo 都留空（＝雲端匯出剝除後的樣子）
  const evil = { settings: {}, accounts: [
    { id: DUP_ID, name: '甲', type: 'cash', currency: 'TWD', balance: 1, accountNo: '' },
    { id: DUP_ID, name: '乙', type: 'cash', currency: 'TWD', balance: 2, accountNo: '' },
  ] };
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(evil) });
  assert.equal(r.status, 200, `匯入應該成功（不是靠 500 擋下來的）：${await r.clone().text()}`);

  // ③ 前置條件：兩筆真的都進去了（不然下面「沒有人拿到」是空歡喜）
  const accs = JSON.parse(rawOf(A.id)).find((/** @type {any} */ x) => x.key === 'accounts')?.data || [];
  assert.equal(accs.length, 2, '前置條件：兩筆同 id 的帳戶都要真的落庫，這一題才考得到撞號');

  // ④ 關鍵斷言：不可以有任何一筆拿到那個完整帳號
  const got = accs.filter((/** @type {any} */ a) => a.accountNo === NO);
  assert.equal(got.length, 0,
    `有 ${got.length} 筆帳戶拿到同一個完整帳號（${got.map((/** @type {any} */ a) => a.name).join('、')}）` +
    '——匯入側的路徑撞號沒有擋。撞號時寧可留空，也不要把甲的帳號寫進乙那一格');

  // 收尾
  await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, accounts: [] }) });
});

test('stripSecretsForBackup：深拷貝，不可以順手把記憶體裡那包也清掉', () => {
  // ⚠️ v6 補 accounts（Codex 定向複審第四輪）：原本測資只有 settings/cards，
  //    所以「輸出正確、但順手把原物件的 accountNo 清空」這種突變照樣全綠——
  //    本 PR 新增的那張清單完全沒被這一題涵蓋。
  const live = {
    settings: { taishinSecPdfPassword: TAISHIN, ib: { flexToken: FLEX } },
    cards: [{ id: 'c1', pdfPassword: CARDPW }],
    accounts: [{ id: 'a1', accountNo: FULL_ACCOUNT_NO }],
  };
  const out = stripSecretsForBackup(live);
  assert.equal(out.settings.ib.flexToken, '');
  assert.equal(out.settings.taishinSecPdfPassword, '');
  assert.equal(out.cards[0].pdfPassword, '');
  assert.equal(out.accounts[0].accountNo, '', '第二張清單也要剝乾淨');
  assert.equal(live.settings.ib.flexToken, FLEX, '原物件必須完好——它可能還要拿去用');
  assert.equal(live.settings.taishinSecPdfPassword, TAISHIN);
  assert.equal(live.cards[0].pdfPassword, CARDPW);
  assert.equal(live.accounts[0].accountNo, FULL_ACCOUNT_NO,
    '原物件的完整帳號也必須完好——匯出順手清掉記憶體裡那包＝使用者的帳號當場消失');

  // ⚠️ **欄位不存在時也要走訪**（同來回⑪⑫那個 High，只是換到 settings 這一側）。
  //    走匯入路徑碰不到這個情境（`merged.settings` 一定含這些欄位，`emptyDb()` 底稿給的），
  //    所以只有純函式層釘得住——把 `in` 判斷加回去，這一段會紅。
  const sparse = /** @type {any} */ (stripSecretsForBackup({ settings: { ib: {} }, cards: [{ id: 'c1' }], accounts: [{ id: 'a1' }] }));
  assert.equal(sparse.settings.taishinSecPdfPassword, '', '欄位原本不存在也要補成空字串（＝「未設定」）');
  assert.equal(sparse.settings.ib.flexToken, '');
  assert.equal(sparse.cards[0].pdfPassword, '');
  assert.equal(sparse.accounts[0].accountNo, '');
});

test('匯入：檔案裡夾帶的機密一律不採用，但已設定的憑證要保住（留空＝不變更）', async () => {
  // ⚠️ 這一題 v7 前是**假考題**（Codex 定向複審第五輪）：
  //    ①不自己種現有憑證，單題獨跑會失敗（依賴前一題狀態，違反鐵則 9③）。
  //    ②只掃「匯入的明文有沒有進資料庫」＋`…Set === true`。但匯入值**被正常加密之後明文本來就不存在**，
  //      而「錯誤的非空值」照樣讓 `…Set` 是 true——所以把規則改成「匯入值非空就採用」，這一題全綠。
  //    修法：本題自己種三個專屬值、匯入**另一組**值，最後從假 Postgres **解密逐欄比對**
  //    仍是本題種下去的那三個。對應的突變是「非空匯入值優先」，不是「一律清空」。
  const { flex, taishin, cardPw, cardId } = await newSecrets('tokA', 'nosteal');
  const { decryptSecret } = await import('../lib/crypto-secrets.js');
  const rowOf = (/** @type {string} */ key) => pg.selectAs(A.id).find(r2 => r2.key === key)?.data;
  const plaintexts = () => {
    const settings = rowOf('settings') || {};
    const card = (rowOf('cards') || []).find((/** @type {any} */ c) => c.id === cardId) || {};
    return {
      flex: decryptSecret(String(settings?.ib?.flexToken || ''), `${A.id}|settings.ib.flexToken`),
      taishin: decryptSecret(String(settings?.taishinSecPdfPassword || ''), `${A.id}|settings.taishinSecPdfPassword`),
      cardPw: decryptSecret(String(card?.pdfPassword || ''), `${A.id}|cards.${cardId}.pdfPassword`),
    };
  };
  const mine = { flex, taishin, cardPw };
  assert.deepEqual(plaintexts(), mine, '前置條件：資料庫裡解出來就是本題種下去的三個值');

  // 匯入檔帶著**另一組**機密（模擬「來路不明的備份」），並保留本題那張卡的 id
  const evil = {
    settings: { usdTwd: 31, taishinSecPdfPassword: 'EVIL-INJECTED-1', ib: { flexToken: 'EVIL-INJECTED-2' } },
    cards: [{ id: cardId, name: '匯入的卡', pdfPassword: 'EVIL-INJECTED-3' }],
  };
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(evil) });
  assert.equal(r.status, 200, await r.clone().text());

  // 前置條件：受測操作真的跑了（非機密欄位確實被匯入覆蓋）——不然下面的「機密沒變」是空歡喜
  const settings = await (await as('tokA', '/api/settings')).json();
  assert.equal(settings.usdTwd, 31, '前置條件：非機密欄位照常還原＝這趟匯入真的執行了');
  const cards = await (await as('tokA', '/api/cards')).json();
  assert.equal(byId(cards, cardId)?.name, '匯入的卡', '前置條件：卡名確實被匯入檔覆蓋');

  const raw = rawOf(A.id);
  for (const injected of ['EVIL-INJECTED-1', 'EVIL-INJECTED-2', 'EVIL-INJECTED-3']) {
    assert.ok(!raw.includes(injected), '匯入檔的機密不可以進資料庫（明文或密文都不行）');
  }
  // 關鍵斷言：三個機密**解密後**都必須還是本題自己種的那一個（「有值」不夠——錯的值一樣有值）
  assert.deepEqual(plaintexts(), mine,
    '匯入採用了檔案裡的機密（或把現值換掉了）——上傳的備份可能來自別處，裡面的 token／密碼不可信');
});

// ============================================================================
// 四、跨租戶：加密不會變成新的洩漏管道
// ============================================================================

test('跨租戶：兩人存同一份明文，密文不同、解得回同一個值，且互相看不到（C4b 隔離 ＋ C5 加密疊加）', async () => {
  // ⚠️ 這一題原本是**假考題**（Codex 定向複審第六輪抓到，而且是我自己的隔離重構造成的）：
  //    它只替 B 寫入，A 那一側靠前一題留下的資料。重構後 A 存的是 `FLEXTOKEN-nosteal`、
  //    B 存的是 `FLEXTOKEN-SECRET-0001`——**兩份密文不同本來就可能只是因為明文不同**，
  //    根本沒有證明題名宣稱的「同一明文在不同租戶下密文不同」。單題獨跑更是直接紅。
  //    修法：本題自己替 A、B 各寫一次**同一個本題專屬的明文**，兩次都確認成功再比。
  const SHARED = 'FLEXTOKEN-CROSS-TENANT-SAME';
  for (const tok of ['tokA', 'tokB']) {
    const r = await as(tok, '/api/settings', {
      method: 'PUT', body: JSON.stringify({ ib: { flexToken: SHARED, flexQueryId: '123' } }),
    });
    assert.equal(r.status, 200, `前置條件：${tok} 寫入應該成功——${await r.clone().text()}`);
  }
  const ctOf = (/** @type {string} */ uid) =>
    pg.selectAs(uid).find((/** @type {any} */ r) => r.key === 'settings')?.data?.ib?.flexToken;
  const ctA = String(ctOf(A.id) || '');
  const ctB = String(ctOf(B.id) || '');
  assert.ok(ctA.startsWith('enc:v1:') && ctB.startsWith('enc:v1:'), '前置條件：兩邊都真的加密落庫了');

  // ① 同一份明文、兩份不同的密文（IV 隨機＋AAD 綁使用者）
  //    → 拿到整顆資料庫也**無法用「密文相等」比對出誰跟誰用同一組憑證**
  assert.notEqual(ctA, ctB, '同一份明文在不同租戶的密文必須不同');
  // ② 但各自都解得回同一個原文（不是「加壞了所以不同」）
  assert.equal(decryptSecret(ctA, `${A.id}|settings.ib.flexToken`), SHARED);
  assert.equal(decryptSecret(ctB, `${B.id}|settings.ib.flexToken`), SHARED);
  // ③ AAD 綁租戶：把 A 的密文搬到 B 的列上也解不開
  assert.equal(decryptSecret(ctA, `${B.id}|settings.ib.flexToken`), '', 'A 的密文在 B 的列上必須解不開');

  // ④ 隔離：A 有台新密碼、B 沒有 → B 不可以看到 A 的（A 那一側也要本題自己種）
  const aTaishin = 'TAISHIN-CROSS-TENANT';
  assert.equal((await as('tokA', '/api/settings', {
    method: 'PUT', body: JSON.stringify({ taishinSecPdfPassword: aTaishin }),
  })).status, 200, '前置條件：A 的台新密碼要由本題自己種');
  assert.equal((await (await as('tokA', '/api/settings')).json()).taishinSecPdfPasswordSet, true, '前置條件：A 真的有');
  assert.equal((await (await as('tokB', '/api/settings')).json()).taishinSecPdfPasswordSet, false,
    'B 沒設過台新密碼，不可以看到 A 的');
  assert.ok(!rawOf(B.id).includes(aTaishin), 'A 的台新密碼不可以出現在 B 的列裡');
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
  // ⚠️ 這一題原本是**假考題**（Codex 定向複審第六輪抓到，同樣是我自己的隔離重構造成的）：
  //    它掃的是檔頭那三個舊常數，但重構後 A 存的是 `newSecrets()` 產生的標籤值——
  //    **資料庫裡根本沒有它在找的字串**，所以就算錯誤回應把真正的機密整串吐出來，這題也全綠。
  //    修法：本題自己種三個專屬機密、確認真的落庫，再用**那三個確切明文**掃回應。
  const { flex, taishin, cardPw } = await newSecrets('tokA', 'errmsg');
  const raw = rawOf(A.id);
  assert.ok(raw.includes('enc:v1:'), '前置條件：三個機密真的加密落庫了');
  for (const secret of [flex, taishin, cardPw]) {
    assert.ok(!raw.includes(secret), `前置條件：${secret} 不該以明文躺在資料庫（掃描標的要是「加密後的真機密」）`);
  }

  const probes = [
    ['/api/import', 'POST', '{"settings":{},"transactions":"oops"}', 400],
    ['/api/cards/does-not-exist', 'PUT', '{"name":"x"}', 404],
    ['/api/settings', 'PUT', '{"usdTwd":"not-a-number"}', 200],   // 壞型別被剝欄、其餘照存
    ['/api/statement/preview', 'POST', '{"data":"not-a-pdf"}', 400],
    ['/api/securities/preview', 'POST', '{"data":"not-a-pdf"}', 400],
    ['/api/bank-statement/preview', 'POST', '{"data":"not-a-pdf"}', 400],
  ];
  for (const [p, method, body, expected] of probes) {
    const r = await as('tokA', p, { method, body });
    // ⚠️ 先斷言探針**真的走到預定的 handler**：如果哪天路由改了、統一回 404，
    //    「回應不含機密」會變成廢話——沒到現場當然掃不到東西。
    assert.equal(r.status, expected, `${method} ${p} 應該回 ${expected}（探針要真的抵達那個 handler）`);
    const text = await r.text();
    for (const secret of [flex, taishin, cardPw]) {
      assert.ok(!text.includes(secret), `${method} ${p} 的錯誤回應含機密值！`);
    }
    assert.ok(!text.includes('enc:v1:'), `${method} ${p} 的錯誤回應含密文！`);
  }
});

// ============================================================================
// HOSTED 的 body 上限：**打正式接線**，不是打 helper
// ============================================================================
//
// ⚠️ Codex 定向複審第三輪抓到：`test/request-limits.test.js` 的 HOSTED 題自建 express app
//    直接呼叫 `installJsonBodyParsers()`，證明得了 helper 正確，**證明不了 `server.js` 還在用它**。
//    突變 `server.js` 的 HOSTED 接線改掛通用 15MB parser → 1134 題全綠。
//    這一檔本來就在 HOSTED 模式下跑真正的 `app`，所以放這裡才打得到正式路徑。

// ⚠️ 這一題**用 tokA 就好**：限速已改成每題開始前歸零（檔頭 beforeEach）。
//    第一版曾拿到 **429 而不是 413**——A 的「上傳解析類」額度被前面十幾題吃光，
//    考的東西被限速搶先擋掉。當時的權宜之計是改用 B 的額度，現在根因修掉了。
test('HOSTED 正式接線：只吃列的匯入端點超過 1 MB → 413（不是 helper，是 server.js 那條線）', async () => {
  // ⚠️ 這一題第一版是**假考題**（Codex 定向複審第四輪抓到）：測資少了 `stmtRef`，
  //    正式服務會把 300 筆**全部略過**（回 `imported:0, skipped:300`），而斷言只寫
  //    `status !== 413`——把正式 handler 突變成明確回 500，它照樣全綠。
  //    「沒有被擋下」不等於「真的匯進去了」。修法＝送合法的列、斷言 `imported === 300`，
  //    再從正式讀取端確認本題專屬的交易確實落庫。
  const { cardId } = await newSecrets('tokA', 'bodylimit');

  // ① 正常規模先過（收緊不可以誤殺真實使用者；真實台新帳單約 122 筆）
  //    stmtRef 必須是 `卡id|消費日|金額|原文`（`lib/services/statement-import.js` 會伺服器端重建並比對）
  const DESC = (/** @type {number} */ i) => `某某餐飲店股份有限公司台北信義分店-bodylimit-${i}`;
  const transactions = Array.from({ length: 300 }, (_, i) => ({
    date: '2026-07-01', desc: DESC(i), amount: 1234 + i,
    stmtRef: `${cardId}|2026-07-01|${1234 + i}|${DESC(i)}`,
  }));
  const ok = await as('tokA', `/api/cards/${cardId}/statement/import`, {
    method: 'POST', body: JSON.stringify({ transactions }),
  });
  assert.equal(ok.status, 200,
    `HOSTED 的 300 筆真實規模帳單必須過得去（body ${JSON.stringify({ transactions }).length} bytes）：${await ok.clone().text()}`);
  const okBody = await ok.json();
  assert.equal(okBody.imported, 300,
    `300 筆必須真的匯進去，不是「沒被 413 擋下」就算數（實際 ${JSON.stringify(okBody)}）`);
  // 從正式讀取端再確認一次：回應說 imported 也可能是騙人的。
  // ⚠️ 落庫的 `note` 是**清理後的顯示店名**、`desc` 根本不存在——原文留在 `stmtRef` 裡。
  //    用這次匯入自己的 `batchId` 數最直接，也不會被別題的資料干擾。
  assert.ok(okBody.batchId, '匯入回應要帶批次代號');
  const txs = await (await as('tokA', '/api/transactions')).json();
  assert.equal(txs.filter((/** @type {any} */ t) => t.importBatch === okBody.batchId).length, 300,
    '本題這一批的 300 筆交易必須真的落庫（回應說 imported:300 不等於真的寫進去了）');

  // ② 超過 1MB 必須被擋——這是修法真正保護的那一面（Supabase 的容量）
  const tooBig = await as('tokA', `/api/cards/${cardId}/statement/import`, {
    method: 'POST', body: JSON.stringify({ transactions, note: 'x'.repeat(1_100_000) }),
  });
  assert.equal(tooBig.status, 413,
    'HOSTED 的列匯入超過 1 MB 必須擋下——這一題若綠了，代表 server.js 的接線沒在用 installJsonBodyParsers');

  // ③ 吃檔案的端點在 HOSTED 仍維持大入口（收緊只針對吃列的那一條）
  const file = await as('tokA', '/api/bank-statement/preview', {
    method: 'POST', body: JSON.stringify({ data: 'x'.repeat(1_100_000) }),
  });
  assert.notEqual(file.status, 413, 'HOSTED 也不可以把吃檔案的端點一起掐死');
});
