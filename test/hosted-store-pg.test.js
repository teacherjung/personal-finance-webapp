// @ts-check
// C4b 考題：HOSTED 模式的 Supabase Postgres 資料層——**跨使用者隔離**、compare-and-swap、
// 匯入綁 session user、絕不落回本機 SQLite、架構護欄。
//
// 誠實劃界（很重要，別把這份考題讀成比它更強的東西）：
//   ✅ 這裡證明的是「**我們的程式**在正確的資料庫語意下不會洩漏、不會互蓋」——
//      隔離不靠 app 記得加 where（正式碼一條 where 都沒有）、寫入不靠祈禱（版本不合就整批不寫）。
//   ❌ 這裡**不能**證明「Supabase 上的 RLS 政策真的寫對了」。那要打到真的 Postgres，
//      屬於 C6（部署到測試網址後的對抗審查）。本檔只用靜態考題盯住 `db/supabase-schema.sql`
//      的政策形狀（FOR ALL＋USING＋WITH CHECK＋force RLS＋service_role 無權限）。
//
// 假 Postgres 在 `test-doubles/fake-supabase.js`：RLS 在**資料層**強制，所以「app 故意不寫
// where 條件」在這裡會如實地被擋住——這正是要測的性質。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { gitEnv } from '../lib/git-env.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';

// 陷阱檔：HOSTED 模式**一個位元組都不該**寫到本機 SQLite。用 mkdtemp 整個資料夾，
// 這樣連「備份服務偷偷建了 backups/」都驗得到（照 test/daily-backup.test.js 的形狀）。
const DIR = mkdtempSync(join(tmpdir(), 'finance-hosted-pg-'));
const TEST_STORE = join(DIR, 'store.db');
process.env.STORE_FILE = TEST_STORE;
process.env.NOTEASY_HOSTED = '1';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SITE_ORIGIN = 'https://noteasy.com.tw';
process.env.NOTEASY_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');   // C5：機密加密主金鑰（考題用固定值）

const { setSupabaseFactoryForTest, cookieAdapterFor } = await import('../lib/services/auth.js');
const { createFakePostgres, makeFakeSupabaseFactory } = await import('../test-doubles/fake-supabase.js');
const { KV_KEYS, emptyDb } = await import('../lib/store.js');
const repo = await import('../lib/repo.js');
const { runWithTenant } = await import('../lib/tenant.js');
const { setStockFundamentalsOptionsForTest } = await import('../lib/services/stock-fundamentals.js');
const { app } = await import('../server.js');

// ⚠️ 一定要用 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼，
// 拿去 readFileSync／spawnSync 會 ENOENT（第一版就踩到）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const A = { id: 'user-aaa', email: 'a@x.com' };
const B = { id: 'user-bbb', email: 'b@x.com' };
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

/** 用某位使用者的身分打 API。 @param {string} tok @param {string} p @param {any=} init */
const as = (tok, p, init = {}) => fetch(`${base}${p}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: `sb-test-auth-token=${tok}`, ...(init.headers || {}) },
});

/**
 * 幫一位使用者鋪一整份「每個 kv 鍵都有可辨識標記」的資料，直接塞進假 Postgres
 *（＝模擬他自己早就存好的資料）。標記一律用 `id`／字串欄位，字面上獨一無二，
 * 這樣就能用「回應的 JSON 字串裡有沒有別人的標記」來抓任何位置的洩漏。
 * @param {string} uid @param {string} mark
 */
function seedTenant(uid, mark) {
  const db = /** @type {any} */ (emptyDb());
  // settings 的字串標記要挑「真的收得下自由文字」的欄位：capeManual 之類的手動估值欄位
  // 只收數字字串，塞標記會被驗證牆擋掉（第一版踩到）。自訂分類樹是使用者文字，天生自由。
  db.settings.expenseTree = { [`${mark}類`]: [`${mark}-settings`] };
  db.settings.usdTwd = mark === 'MARKA' ? 31 : 33;
  db.accounts = [{ id: `${mark}-accounts`, name: `${mark}戶`, type: 'cash', class: '現金', balance: 1000, currency: 'TWD' }];
  db.assetTargets = [{ id: `${mark}-assetTargets`, class: `${mark}類`, targetPct: 100 }];
  db.transactions = [{ id: `${mark}-transactions`, date: '2026-07-01', type: 'expense', category: '其他', subcategory: '', amount: 100, note: `${mark}筆`, ledger: 'cashflow' }];
  db.subscriptions = [{ id: `${mark}-subscriptions`, name: `${mark}訂閱`, amount: 100, cycle: 'monthly' }];
  db.insurance = [{ id: `${mark}-insurance`, name: `${mark}保單` }];
  db.cards = [{ id: `${mark}-cards`, name: `${mark}卡`, pdfPassword: `${mark}-SECRET` }];
  db.history = [{ id: `${mark}-history`, month: '2026-07', name: `${mark}史` }];
  db.parseRecipes = [{ id: `${mark}-parseRecipes`, bank: `${mark}銀行`,
    current: { formatVersion: 1, bank: `${mark}銀行`, docAnchors: [`${mark}錨點`], dateFormat: 'west-slash',
      refDate: { strategy: 'none', anchor: null }, summary: { sections: [], endAnchor: '總計', balancePick: 'first' },
      detail: { rowIdent: 'date-first', headerOut: '支出', headerIn: '存入', headerBalance: '餘額', headerNote: null, headerIgnore: [] } },
    graduateStreak: 0, graduated: false, suspect: false, rebirths: 0,
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' }];
  db.holdings = [{ id: `${mark}-holdings`, symbol: `${mark}SYM`.toUpperCase().replace(/[^A-Z]/g, ''), name: `${mark}持股`, shares: 1, avgCost: 1, currency: 'USD', layer: 'core' }];
  db.watchlist = [{ id: `${mark}-watchlist`, symbol: 'WATCH', note: `${mark}願望` }];
  db.research = [{ id: `${mark}-research`, symbol: `${mark}RES`.toUpperCase().replace(/[^A-Z]/g, ''), thesis: `${mark}論點` }];
  db.stockFundamentals = [{
    symbol: 'CAL',
    lastAttemptAt: '2026-07-28T00:00:00.000Z',
    fetchedAt: '2026-07-28T00:00:00.000Z',
    data: {
      symbol: 'CAL',
      market: 'US',
      company: { cik: '0000900002', name: `${mark}-stockFundamentals`, sic: null, fiscalYearEnd: '1231' },
      periods: { annual: [], latestQuarter: null },
      metrics: {},
      warnings: []
    }
  }];
  db.portfolioSnapshots = [{ id: `${mark}-portfolioSnapshots`, month: '2026-07', invested: 1, value: 1 }];
  db.ibTrades = [{ id: `${mark}-ibTrades`, symbol: 'IBT' }];
  db.dailyValues = [{ id: `${mark}-dailyValues`, date: '2026-07-01', netWorth: 1 }];
  db.securityTrades = [];   // 合約 11 欄必填，這裡不塞（隔離另有 /api/securities 的空清單驗收）
  db.snapshots = [{ id: `${mark}-snapshots`, month: '2026-07', netWorth: 1 }];
  db.learnedCategories = { [`${mark}-learnedCategories`]: { category: '其他', subcategory: '' } };
  db.learnedBank = { [`${mark}-learnedBank`]: { type: 'expense', category: '其他', subcategory: '' } };
  db.transferSubs = [{ label: `${mark}-transferSubs` }];
  db.insightState = { lastSeenAt: `${mark}-insightState` };
  for (const k of KV_KEYS) pg.seed(uid, k, db[k]);
  return db;
}

// ============================================================================
// 一、跨使用者隔離：**逐集合列舉、不抽樣**（C0 對抗考題第 1 條）
// ============================================================================

test('A/B 隔離：兩人各自有全套資料，A 打每一個讀取端點都只看得到自己的（逐條列舉）', async () => {
  seedTenant(A.id, 'MARKA');
  seedTenant(B.id, 'MARKB');

  // 所有集合的 GET（通用 CRUD／readonly＋securities／stock-fundamentals 專屬入口）
  // ＋ 會回整包／彙總／學習表／匯出的端點。**這份清單就是「不抽樣」的意思**。
  const READ_ENDPOINTS = [
    '/api/accounts', '/api/assetTargets', '/api/transactions', '/api/subscriptions', '/api/insurance',
    '/api/cards', '/api/history', '/api/holdings', '/api/watchlist', '/api/research',
    '/api/portfolioSnapshots', '/api/ibTrades', '/api/dailyValues',
    '/api/securities', '/api/securities/batches',
    '/api/stock-fundamentals/CAL',
    '/api/db', '/api/summary', '/api/settings', '/api/export',
    '/api/learned', '/api/bank-learned', '/api/parse-recipes', '/api/statement/batches', '/api/bank-statement/batches',
    '/api/refund-pairs', '/api/monthly-review', '/api/categories', '/api/income-categories',
    '/api/transfer-subcategories', '/api/statement/rules', '/api/statement/health',
  ];
  for (const p of READ_ENDPOINTS) {
    const r = await as('tokA', p);
    assert.equal(r.status, 200, `GET ${p} 應該通`);
    const body = await r.text();
    assert.ok(!body.includes('MARKB'), `GET ${p} 洩漏了 B 的資料！`);
  }
  // 反向也要成立（不是「A 剛好看不到」而是「兩邊互相看不到」）
  for (const p of READ_ENDPOINTS) {
    const body = await (await as('tokB', p)).text();
    assert.ok(!body.includes('MARKA'), `GET ${p}（以 B 的身分）洩漏了 A 的資料！`);
  }
  // 而且要真的看得到自己的（否則「都是空的」也會通過上面的斷言）
  assert.match(await (await as('tokA', '/api/parse-recipes')).text(), /MARKA-parseRecipes/, '自己的規則卡看得到（不是兩邊都空）');
  assert.match(await (await as('tokB', '/api/parse-recipes')).text(), /MARKB-parseRecipes/);
  assert.match(await (await as('tokA', '/api/transactions')).text(), /MARKA-transactions/);
  assert.match(await (await as('tokB', '/api/transactions')).text(), /MARKB-transactions/);
  assert.match(await (await as('tokA', '/api/stock-fundamentals/CAL')).text(), /MARKA-stockFundamentals/);
  assert.match(await (await as('tokB', '/api/stock-fundamentals/CAL')).text(), /MARKB-stockFundamentals/);
});

test('A/B 隔離：規則卡刪除端點——A 刪 B 的卡＝404 且 B 一張不少；A 刪自己的卡＝成功（Codex #513 r4）', async () => {
  seedTenant(A.id, 'MARKA');
  seedTenant(B.id, 'MARKB');
  const del = (/** @type {string} */ tok, /** @type {string} */ id) => as(tok, '/api/parse-recipes/delete', { method: 'POST', body: JSON.stringify({ id }) });
  const r1 = await del('tokA', 'MARKB-parseRecipes');
  assert.equal(r1.status, 404, '★A 刪 B 的 id＝在 A 的世界裡找不到（重複 Content-Type 標頭會讓 body 解析失敗＝400——del 不另帶 headers、用 as() 的預設）');
  assert.match(await (await as('tokB', '/api/parse-recipes')).text(), /MARKB-parseRecipes/, '★B 的卡一張不少');
  const r2 = await del('tokA', 'MARKA-parseRecipes');
  assert.equal(r2.status, 200, 'A 刪自己的卡＝成功');
  assert.doesNotMatch(await (await as('tokA', '/api/parse-recipes')).text(), /MARKA-parseRecipes/);
  assert.match(await (await as('tokB', '/api/parse-recipes')).text(), /MARKB-parseRecipes/, 'B 仍完整');
});


test('A/B 並發更新同一代號：公開 SEC 請求只抓一輪，兩人的快取各寫回自己的 RLS namespace', async () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/sec/calendar-year-company.json'), 'utf8'));
  let calls = 0;
  let clock = Date.parse('2026-07-28T06:00:00.000Z');
  setStockFundamentalsOptionsForTest({
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    minIntervalMs: 0,
    userAgent: 'NotEasy Test data@example.test',
    logger: { warn() {} },
    fetchImpl: async (url) => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));   // 讓 A/B handler 確實重疊在同一個 in-flight
      const path = String(url);
      if (path.endsWith('company_tickers.json')) return new Response(JSON.stringify(fixture.tickerIndex));
      if (path.includes('/submissions/')) return new Response(JSON.stringify(fixture.submissions));
      if (path.includes('/companyfacts/')) return new Response(JSON.stringify(fixture.companyFacts));
      throw new Error(`未核准 URL：${path}`);
    }
  });
  try {
    const [a, b] = await Promise.all([
      as('tokA', '/api/stock-fundamentals/CAL/refresh', { method: 'POST', body: '{}' }),
      as('tokB', '/api/stock-fundamentals/CAL/refresh', { method: 'POST', body: '{}' })
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(calls, 3, '同一份公開 SEC 資料只抓一輪');
    const aCache = pg.selectAs(A.id).find(row => row.key === 'stockFundamentals')?.data;
    const bCache = pg.selectAs(B.id).find(row => row.key === 'stockFundamentals')?.data;
    assert.equal(aCache?.[0]?.data?.company?.name, 'Synthetic Calendar Services', 'A 的完成分支寫回 A');
    assert.equal(bCache?.[0]?.data?.company?.name, 'Synthetic Calendar Services', 'B 的完成分支寫回 B');
    assert.notEqual(aCache, bCache, '兩個租戶不可共用同一個資料列物件');
  } finally {
    setStockFundamentalsOptionsForTest(null);
  }
});

test('A/B 隔離：A 拿 B 的 id 做 PUT／DELETE，B 的資料一筆都不能少（逐集合列舉）', async () => {
  const COLS = ['accounts', 'assetTargets', 'transactions', 'subscriptions', 'insurance',
    'cards', 'history', 'holdings', 'watchlist', 'research'];
  for (const col of COLS) {
    const victim = `MARKB-${col}`;
    const put = await as('tokA', `/api/${col}/${victim}`, { method: 'PUT', body: JSON.stringify({ name: '被劫持' }) });
    assert.equal(put.status, 404, `PUT /api/${col}/${victim} 必須找不到（不可改到 B 的列）`);
    const del = await as('tokA', `/api/${col}/${victim}`, { method: 'DELETE' });
    assert.ok(del.status === 200 || del.status === 404, `DELETE /api/${col}/${victim} 回應碼異常`);
    // 關鍵：不管回什麼碼，**B 那一筆必須還在**
    const bBody = await (await as('tokB', `/api/${col}`)).text();
    assert.ok(bBody.includes(victim), `A 的 DELETE 把 B 的 ${col} 刪掉了！`);
  }
});

test('A/B 隔離：A 新增一筆，B 完全看不到；B 的筆數不變', async () => {
  const before = JSON.parse(await (await as('tokB', '/api/transactions')).text()).length;
  const r = await as('tokA', '/api/transactions', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-07-05', type: 'expense', category: '其他', amount: 55, note: 'MARKA-新增' }),
  });
  assert.equal(r.status, 200);
  const bList = JSON.parse(await (await as('tokB', '/api/transactions')).text());
  assert.equal(bList.length, before, 'B 的筆數不可因為 A 新增而改變');
  assert.ok(!JSON.stringify(bList).includes('MARKA'), 'B 看不到 A 新增的那筆');
  assert.match(await (await as('tokA', '/api/transactions')).text(), /MARKA-新增/, 'A 自己看得到');
});

// ============================================================================
// 二、隔離「不依賴 app 記得加 where」（C0 對抗考題第 3 條的可測版本）
// ============================================================================

test('故意漏 where：正式碼一條 user_id 過濾都沒下，隔離仍成立（RLS 是唯一真相）', async () => {
  pg.calls.filters.length = 0;
  const body = await (await as('tokA', '/api/db')).text();
  assert.deepEqual(pg.calls.filters, [], '資料層不該自己加任何 where——隔離要靠 RLS，加了反而讓人以為 RLS 可有可無');
  // B 的列**確實存在於同一張表**（不是「表裡本來就沒有」的假隔離）
  const owners = new Set(pg.allRows().map(r => r.user_id));
  assert.ok(owners.has(A.id) && owners.has(B.id), '假 Postgres 裡兩人的列都在');
  assert.ok(!body.includes('MARKB'), '同一張表、沒有 where，A 仍然只讀得到自己的列');
});

test('資料層不得偷偷用 service_role（裁決⑥不可退讓）', () => {
  // 判準是「有沒有**用**」而不是「有沒有提到」——註解裡寫「絕不可用 service_role」是好事，
  // 不該被自己的警語絆倒。真正要抓的是：讀了 service-role 的環境變數，或用它建 client。
  const envHits = [];
  const clientFiles = [];
  for (const f of libFiles()) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    if (/process\.env\.[A-Z_]*SERVICE_ROLE[A-Z_]*/.test(text)) envHits.push(f);
    if (/\bcreate(Server)?Client\s*\(/.test(text)) clientFiles.push(f);
  }
  assert.deepEqual(envHits, [], 'service_role key＝繞過 RLS 的萬能鑰匙，正式程式碼一處都不可以讀它');
  assert.deepEqual(clientFiles, ['lib/services/auth.js'], 'Supabase client 只能在一個地方建（好稽核）');
  const auth = readFileSync(join(ROOT, 'lib/services/auth.js'), 'utf8');
  assert.match(auth, /createServerClient\(url,\s*anonKey,/, '建 client 一律用 anon key＋使用者 cookie，RLS 才有身分可比對');
});

// ============================================================================
// 三、並行寫入：compare-and-swap（C0 契約 P1-5）
// ============================================================================

test('CAS：兩個並發新增，兩筆都要活著（櫃檯自己的寫入會重讀重做重試一次）', async () => {
  const mk = (/** @type {string} */ note) => ({ date: '2026-07-06', type: 'expense', category: '其他', amount: 7, note });
  const [r1, r2] = await Promise.all([
    as('tokA', '/api/transactions', { method: 'POST', body: JSON.stringify(mk('並發甲')) }),
    as('tokA', '/api/transactions', { method: 'POST', body: JSON.stringify(mk('並發乙')) }),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const notes = JSON.parse(await (await as('tokA', '/api/transactions')).text()).map((/** @type {any} */ t) => t.note);
  assert.ok(notes.includes('並發甲'), '第一筆並發寫入不可被蓋掉');
  assert.ok(notes.includes('並發乙'), '第二筆並發寫入不可被蓋掉');
});

test('CAS：saveDb 拿到過期版本＝丟 409（不會靜默把別人的寫入吃掉）', async () => {
  await runWithTenant({ userId: A.id, supabase: fakeClientFor('tokA') }, async () => {
    const stale = await repo.getDb();          // 讀出「這一版」
    await repo.updateSettings({ usdTwd: 31 }); // 別人（或另一個分頁）在這中間寫了一次
    /** @type {any} */
    let err = null;
    try { await repo.saveDb(stale); } catch (e) { err = e; }
    assert.ok(err, '拿過期版本存檔必須失敗，不可默默覆蓋');
    assert.equal(err.status, 409);
    assert.equal(err.code, 'kv_conflict');
  });
});

test('CAS：整包寫入一定要有版本戳來源——`overwrite: true` 也不例外，還要交出 `from`（匯入專用）', async () => {
  await runWithTenant({ userId: A.id, supabase: fakeClientFor('tokA') }, async () => {
    const fresh = await repo.getDb();
    const naked = JSON.parse(JSON.stringify(fresh));      // JSON 來回＝版本戳掉了
    /** @type {any} */
    let err = null;
    try { await repo.saveDb(naked); } catch (e) { err = e; }
    assert.equal(err?.code, 'kv_no_version', '沒有來源版本的整包覆蓋＝預設拒絕（防呆）');

    // ⚠️ 這一段是 2026-07-28 改掉的契約（Codex 收官審查 #2）。
    //    舊行為：`{ overwrite: true }` 自己去資料庫重抓一次目前版本＝**自己蓋章給自己看**，
    //    所以「呼叫端讀資料」到「寫入」之間別人寫的東西會被無聲蓋掉（下一題重現整條路）。
    //    新契約：overwrite 一樣要交出版本戳，只是來源改成呼叫端明講的 `from`。
    err = null;
    try { await repo.saveDb(naked, { overwrite: true }); } catch (e) { err = e; }
    assert.equal(err?.code, 'kv_no_version',
      'overwrite 沒有交出 from＝一樣要拒絕（不准有「無來源版本的整包覆蓋」這條路）');

    await repo.saveDb(naked, { overwrite: true, from: fresh });   // 交出讀資料時那一份才准
  });
});

test('409 送到瀏覽器時是原味訊息，不是「請求格式不正確」', async () => {
  const err = Object.assign(new Error('資料在你操作期間被另一個裝置或分頁改過，請重新整理後再存一次'), { status: 409 });
  // 直接驗全域錯誤中介的分支（比湊出真實競態穩定得多）
  const res = { code: 0, body: /** @type {any} */ (null), headersSent: false,
    status(/** @type {number} */ c) { this.code = c; return this; }, json(/** @type {any} */ b) { this.body = b; return this; } };
  /** @type {any} */
  const handler = app._router.stack.map((/** @type {any} */ l) => l.handle).find((/** @type {any} */ h) => h.length === 4);
  handler(err, {}, res, () => {});
  assert.equal(res.code, 409);
  assert.match(res.body.error, /重新整理/, '使用者要看得懂「該做什麼」，不是被告知格式錯誤');
});

// ============================================================================
// 四、匯入綁 session user（C0 對抗考題第 9 條）
// ============================================================================

test('匯入：檔案裡塞 user_id／別人的資料，只會寫進自己的 namespace；B 一筆都不動', async () => {
  const bBefore = JSON.stringify(pg.selectAs(B.id));
  const evil = {
    user_id: B.id,                       // ← 想指定寫給誰
    userId: B.id,
    settings: { usdTwd: 30 },
    transactions: [{ id: 'imported-1', date: '2026-07-07', type: 'expense', category: '其他', amount: 1, note: 'IMPORTED' }],
  };
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify(evil) });
  assert.equal(r.status, 200, `匯入應成功：${await r.clone().text()}`);

  assert.equal(JSON.stringify(pg.selectAs(B.id)), bBefore, 'B 的列必須一個位元組都沒變');
  const aRows = pg.selectAs(A.id);
  assert.deepEqual(aRows.map(r2 => r2.key).filter(k => !KV_KEYS.includes(k)), [],
    '匯入檔裡的 user_id 之類的頂層鍵不可以變成 kv 的列');
  assert.ok(aRows.every(r2 => r2.user_id === A.id), '寫進去的列一律屬於 session user');
  assert.match(await (await as('tokA', '/api/db')).text(), /IMPORTED/, 'A 自己的資料確實被還原了');
});

test('匯入：壞備份被擋下時，原資料一筆都不動', async () => {
  const aBefore = JSON.stringify(pg.selectAs(A.id));
  const r = await as('tokA', '/api/import', { method: 'POST', body: JSON.stringify({ settings: {}, transactions: 'oops' }) });
  assert.equal(r.status, 400);
  assert.equal(JSON.stringify(pg.selectAs(A.id)), aBefore, '壞匯入不可動到任何一列');
});

// ============================================================================
// 五、HOSTED 絕不落回本機 SQLite
// ============================================================================

test('HOSTED：整輪跑完，本機 store.db 從未被建立（而且 API 確實是通的，不是整條路壞掉）', async () => {
  assert.equal((await as('tokA', '/api/summary')).status, 200, '正面對照：HOSTED 的 API 是活的');
  for (const sfx of ['', '.bak', '-wal', '-shm', '.json']) {
    assert.equal(existsSync(TEST_STORE + sfx), false, `HOSTED 不可以建立 ${TEST_STORE + sfx}`);
  }
  assert.deepEqual(readdirSync(DIR), [], '資料夾必須全空——連 backups/ 都不該出現');
});

test('HOSTED：每日備份短路＝不做也不假裝做，failStreak 歸零（不對雲端使用者顯示本機救援指引）', async () => {
  const r = await as('tokA', '/api/backup/daily', { method: 'POST', body: '{}' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ran, false);
  assert.equal(body.created, false);
  assert.equal(body.hosted, true);
  assert.equal(body.failStreak, 0, '殘留的舊 streak 不可讓雲端畫面跳「請檢查電腦硬碟空間」');
  assert.deepEqual(readdirSync(DIR), [], '不可建出 backups/');
});

test('HOSTED：本機備份三支經櫃檯就被擋（backupNow 回 false、snapshotTo/dataDir throw）', () => {
  assert.equal(repo.backupNow('pre-rules'), false, '維持同步簽名＋回 false，呼叫端才能據實以告');
  assert.throws(() => repo.snapshotTo(join(DIR, 'x.db')), /HOSTED/);
  assert.throws(() => repo.dataDir(), /HOSTED/);
});

// ============================================================================
// 六、fail-closed：沒有身分就不准碰資料
// ============================================================================

test('fail-closed：HOSTED 下在沒有租戶 context 的情況呼叫櫃檯＝throw，絕不退回共用資料', async () => {
  await assert.rejects(() => repo.getDb(), /確認你的身分/, '沒有身分就讀不到任何東西');
  await assert.rejects(() => repo.getCollection('transactions'), /確認你的身分/);
  await assert.rejects(() => repo.addItem('transactions', { amount: 1 }), /確認你的身分/);
  await assert.rejects(() => repo.updateSettings({ usdTwd: 1 }), /確認你的身分/);
});

test('fail-closed：有 userId 但沒有 supabase client（接線錯誤）也一樣 throw', async () => {
  await runWithTenant({ userId: A.id, supabase: null }, async () => {
    await assert.rejects(() => repo.getDb(), /確認你的身分/);
  });
});

// ============================================================================
// 七、新租戶的起點：乾淨底稿，不是別人的示範資料
// ============================================================================

test('新租戶：一列都沒有時讀到 emptyDb() 底稿（settings 有預設值），且不是 data/seed.json 的示範資料', async () => {
  const NEW = { id: 'user-new', email: 'n@x.com' };
  await runWithTenant({ userId: NEW.id, supabase: fakeClientFor('tokNew', NEW) }, async () => {
    const db = /** @type {any} */ (await repo.getDb());
    assert.equal(typeof db.settings, 'object');
    assert.equal(db.settings.usdTwd, emptyDb().settings.usdTwd, 'settings 必須是完整預設值，不是空物件');
    assert.equal(db.settings.equityCapPct, emptyDb().settings.equityCapPct);
    for (const col of ['accounts', 'transactions', 'holdings', 'cards']) {
      assert.deepEqual(db[col], [], `${col} 應為空陣列`);
    }
    assert.ok(!JSON.stringify(db).includes('MARKA'), '新租戶不可以看到別人的資料');
  });
  // seed.json 的示範資料只屬於 LOCAL（那是 William 本機的底稿），不可以灌進任何雲端租戶
  const seedPath = join(ROOT, 'data', 'seed.json');
  if (existsSync(seedPath)) {
    const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
    if (Array.isArray(seed.accounts) && seed.accounts.length) {
      assert.equal(pg.selectAs('user-new').length, 0, '新租戶不可以被種進 seed 示範資料');
    }
  }
});

// ============================================================================
// 八、店名規則不可跨租戶污染（C4b 修掉的隱蔽破口）
// ============================================================================

test('店名規則：A 的自訂規則不會外溢到 B 的請求（模組級單例已改成 per-request 槽）', async () => {
  const { getUserRulesRaw, userRulesFingerprint } = await import('../lib/store-rules.js');
  const aRules = { canon: [{ match: '甲店', to: 'A專屬店', mode: 'contains' }], brand: [], rename: [], chains: [], parkExempt: [] };
  const aDb = /** @type {any} */ (emptyDb());
  aDb.settings.storeRules = aRules;
  pg.seed(A.id, 'settings', aDb.settings);

  /** @type {any} */
  let aSeen = null;
  /** @type {any} */
  let bSeen = null;
  /** @type {string} */
  let bFingerprint = '';
  await runWithTenant({ userId: A.id, supabase: fakeClientFor('tokA') }, async () => {
    await repo.getDb();                       // 櫃檯把 A 的規則餵進「A 這個請求的槽」
    aSeen = getUserRulesRaw();
    // B 的請求在 A 還沒結束時插進來（多人情境的真實樣子）
    await runWithTenant({ userId: B.id, supabase: fakeClientFor('tokB') }, async () => {
      await repo.getDb();
      bSeen = getUserRulesRaw();
      bFingerprint = userRulesFingerprint();
    });
    // ⚠️ 這一行是整條考題的重點：B 跑完之後，A 手上的規則**必須還是 A 的**
    assert.deepEqual(getUserRulesRaw(), aSeen, 'B 的請求把 A 的店名規則洗掉了（跨租戶污染）');
  });
  assert.equal(aSeen.canon.length, 1, 'A 應該拿到自己的規則');
  assert.equal(aSeen.canon[0].to, 'A專屬店');
  assert.equal(bSeen.canon.length, 0, 'B 沒有自訂規則，應該拿到乾淨的內建行為');
  assert.ok(!bFingerprint.includes('A專屬店'),
    '規則指紋會被寫進 settings.storeRulesHash＝污染會被持久化，這裡必須乾淨');
});

// ============================================================================
// 九、JSONB 往返：原型污染防線在 Postgres 版一樣成立
// ============================================================================

test('JSONB 往返：學習表的保留字 key 進不了資料庫（原型污染防線不因換引擎失效）', async () => {
  await runWithTenant({ userId: 'user-proto', supabase: fakeClientFor('tokProto', { id: 'user-proto', email: 'p@x.com' }) }, async () => {
    const db = /** @type {any} */ (await repo.getDb());
    // 用 JSON.parse 造「自有的 __proto__ 鍵」——物件字面量寫不出來（會變成設原型）
    db.learnedCategories = JSON.parse('{"__proto__":{"category":"壞"},"正常店":{"category":"其他","subcategory":""}}');
    await repo.saveDb(db);
    const row = pg.selectAs('user-proto').find(r => r.key === 'learnedCategories');
    assert.ok(row, '應該有 learnedCategories 這一列');
    assert.ok(!Object.hasOwn(row.data, '__proto__'), '__proto__ 不可以被存進 JSONB');
    assert.ok(Object.hasOwn(row.data, '正常店'), '正常的鍵要留著');
    assert.equal(/** @type {any} */ ({}).category, undefined, 'Object.prototype 不可以被污染');
  });
});

// ============================================================================
// 十、架構護欄（防止下一個人不小心把 HOSTED 拉回本機檔案系統）
// ============================================================================

test('架構：只有 repo.js 與 store-pg.js 可以 import store.js，且 store-pg 只准用純函式', () => {
  /** @type {string[]} */
  const importers = [];
  for (const f of libFiles()) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    if (/from\s+['"][./]*(\.\.\/)?store\.js['"]/.test(text)) importers.push(f);
  }
  assert.deepEqual(importers.sort(), ['lib/repo.js', 'lib/store-pg.js'],
    '資料存取一律走櫃檯：多一個檔案直接 import store.js，HOSTED 就會憑空建出本機 SQLite');

  const pgSrc = readFileSync(join(ROOT, 'lib/store-pg.js'), 'utf8');
  const importLine = pgSrc.split('\n').find(l => l.includes("from './store.js'")) || '';
  for (const forbidden of ['load', 'save', 'snapshotTo', 'dataDir', 'backupNow']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(importLine),
      `store-pg.js 不可以 import 會開啟本機 SQLite 的 ${forbidden}`);
  }
});

test('架構：kv 的鍵只有一份真相（store.js 的 KV_KEYS），adapter 不可以自己抄一份', () => {
  const pgSrc = readFileSync(join(ROOT, 'lib/store-pg.js'), 'utf8');
  assert.ok(/import\s*\{[^}]*KV_KEYS[^}]*\}\s*from\s*'\.\/store\.js'/.test(pgSrc),
    'KV_KEYS 必須從 store.js 拿；各抄一份＝新增鍵時只改一邊，那個鍵在雲端版永遠寫不進去且不報錯');
  // 2026-08-15 P2-2：+parseRecipes（配方快取）＝22。schema.sql 的 kv 表是通用鍵值（無逐鍵 DDL）、
  // RLS 政策不因新鍵而變——本次同步檢查完畢；這個數字是「新增集合必須路過這裡」的絆線，照舊手動改。
  assert.equal(KV_KEYS.length, 22, 'kv 鍵數變了就要同步檢查 db/supabase-schema.sql 與本檔');
});

// ============================================================================
// 十一、SQL 政策的靜態考題（真正的 RLS 驗證歸 C6，這裡盯住政策形狀）
// ============================================================================

test('SQL：RLS 政策必須 FOR ALL＋USING＋WITH CHECK＋force，且 service_role 沒有權限（P1-3／裁決⑥）', () => {
  const sql = readFileSync(join(ROOT, 'db/supabase-schema.sql'), 'utf8');
  assert.match(sql, /alter table public\.kv enable row level security/i);
  assert.match(sql, /alter table public\.kv force row level security/i, 'force＝連表擁有者也要守 RLS');
  assert.match(sql, /create policy[\s\S]*?for all[\s\S]*?using \(user_id = \(select auth\.uid\(\)\)\)[\s\S]*?with check \(user_id = \(select auth\.uid\(\)\)\)/i,
    '只寫 USING 只擋讀——A 仍能 INSERT/UPDATE 出 B 的列（P1-3）');
  assert.match(sql, /revoke all on table public\.kv from service_role/i, '裁決⑥：service_role 繞過 RLS，不給它資料表權限');
  assert.match(sql, /revoke all on function public\.kv_save\(jsonb, jsonb\) from service_role/i);
  assert.match(sql, /security invoker/i, 'security definer 會讓這支函式變成繞過 RLS 的後門');
  assert.match(sql, /user_id\s+uuid\s+not null default auth\.uid\(\)/i, 'user_id 由資料庫填，app 永遠不必也不該自己填');
  assert.match(sql, /version\s+bigint\s+not null default 1/i, 'P1-5 樂觀鎖欄位');
});

test('⭐ 架構護欄的清單不可被繼承的 GIT_* 帶去別棵樹（拿掉 env: gitEnv() 要紅）', () => {
  // ⚠️ 上面兩道架構護欄（service_role、誰可以 import store.js）都是「逐檔讀 libFiles() 的內容」。
  //    清單一被換掉，它們就掃了別棵樹而回報通過——**護欄什麼都沒做卻說通過**。
  //    `cwd` 隔離不了 `GIT_DIR`（有它時 git 不看 cwd），而從連結工作樹 push 時 hook 環境本來就有它。
  // ⚠️ **這一題是代理指標，射程有限**：注入的 `GIT_DIR` 是實測唯一「四種呼叫形狀通吃」的變數
  //    （對照表在 test/helpers/dirty-git-env.js 檔頭），它證明的是真實情境下結果沒被帶偏。
  //    ⚠️ 它**擋不住**「把清法退化成只刪 GIT_DIR 的列名版」——那一族由同檔的
  //    「交給 git 的環境裡不可以有任何 GIT_*」那題（直接讀子行程收到什麼）守。
  const restore = injectDirtyGitEnv();
  try {
    const files = libFiles();
    assert.ok(files.includes('lib/store-pg.js'),
      '注入髒 GIT_* 之後清單裡就沒有 lib/store-pg.js 了＝環境沒被隔離，架構護欄會掃錯對象');
    assert.ok(files.length > 20, `注入髒 GIT_* 之後只掃到 ${files.length} 個檔＝隔離失效`);
  } finally {
    restore();
  }
});

// ---- 小工具 ----------------------------------------------------------------
/**
 * 正式程式碼的檔案清單（給架構考題掃）。
 * ⚠️ 用 `--cached --others --exclude-standard`＝**已追蹤＋還沒 git add 的新檔都算**。
 * 只用 `git ls-files` 的話，違規的新檔在被 commit 之前完全掃不到——護欄會在最需要它的那一刻失效。
 * @returns {string[]}
 */
function libFiles() {
  // ⚠️ **`env: gitEnv()` 不可省**：`GIT_DIR` 一旦被繼承（從連結工作樹 push 時 hook 環境本來就有），
  //    `cwd` 形同無效 ⇒ 這份清單會是**別棵樹**的內容，上面那些架構護欄照樣回報通過。
  //    理由與機制在 lib/git-env.js；行為題＝本檔題名關鍵字「架構護欄的清單不可被繼承的 GIT_*」那題。
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'lib', 'server.js'],
    { encoding: 'utf8', cwd: ROOT, env: gitEnv() }).trim();
  return out ? out.split('\n').filter(f => f.endsWith('.js')) : [];
}

/** 造一個「某位使用者的」假 client（給不經 HTTP、直接測櫃檯的考題用）。 @param {string} tok @param {any=} user */
function fakeClientFor(tok, user) {
  const factory = makeFakeSupabaseFactory({
    pg, users: { [tok]: user || (tok === 'tokB' ? B : A) }, cookieAdapterFor,
  });
  return factory({ headers: { cookie: `sb-test-auth-token=${tok}` } }, { set() {}, append() {} });
}

test('⭐ 架構護欄交給 git 的環境裡不可以有任何 GIT_*（直接斷言，不靠代理指標）', () => {
  // ⚠️ 題名關鍵字「架構護欄的清單不可被繼承的 GIT_*」那題是代理指標，只涵蓋「剛好會改變這個指令的變數」；
  //    這一題直接問子行程收到什麼。
  assertChildGitEnvClean(assert, 'hosted-store-pg 的 libFiles()', () => libFiles());
});

test('成本護欄 C1｜被上限擋下的 take＝settings 版本不動（skip 不落盤；Codex #515 r1#1：永不 skip 的壞法讓被擋請求整庫寫入、HOSTED 推版本增加 CAS 對撞）', async () => {
  const { updateAiUsage } = await import('../lib/repo.js');
  const { makeAiBudget } = await import('../lib/ai-budget.js');
  const { getDb, saveDb } = await import('../lib/repo.js');
  const verOf = () => /** @type {any} */ (pg.allRows().find((r) => r.user_id === A.id && r.key === 'settings'))?.version;
  await runWithTenant({ userId: A.id, supabase: fakeClientFor('tokA') }, async () => {
    const db = await getDb();
    db.settings = { ...db.settings, aiCapPerBill: 9, aiCapPerDay: 1 };
    await saveDb(db);
    const b1 = makeAiBudget({ updateUsage: updateAiUsage, today: () => '2026-08-26' });
    await b1.take();   // 放行那發＝真的寫（版本前進）
    const verAfterTake = verOf();
    const b2 = makeAiBudget({ updateUsage: updateAiUsage, today: () => '2026-08-26' });   // 第二份帳單、單日已滿
    await assert.rejects(b2.take(), (/** @type {any} */ e) => e.code === 'ai_budget_exceeded');
    assert.equal(verOf(), verAfterTake, '★被擋那發＝零寫入、版本不動（值沒變還落盤＝白佔一次 CAS 窗口）');
    const usage = /** @type {any} */ ((await getDb()).settings).aiUsage;
    assert.deepEqual(usage, { date: '2026-08-26', n: 1 }, '計數也沒被動');
  });
});

// ============================================================================
// 第二輪稽核第二批 2B：lib/store-pg.js loadKv 的「未知鍵忽略」（2026-09-02 稽核：拿掉那個 continue 沒有任何一題會紅）。
// 表裡的列不一定是 app 寫的（psql 直塞、舊版殘留、惡意 __proto__）：只認 KV_KEYS，其餘不進記憶體、不進 versions。
// ============================================================================

test('2B｜loadKv：表裡混進不認識的鍵（含 __proto__）→ 記憶體 db 沒有那把鑰匙、versions 也沒有、認識的鍵照常讀', async () => {
  const U = { id: 'user-unknown-key', email: 'k@x.com' };
  pg.seed(U.id, 'evil', { hi: 1 });
  pg.seed(U.id, '__proto__', { polluted: true });
  pg.seed(U.id, 'settings', { usdTwd: 30.5 });
  await runWithTenant({ userId: U.id, supabase: fakeClientFor('tokU', U) }, async () => {
    const { loadKv } = await import('../lib/store-pg.js');
    const { db, versions } = await loadKv();
    assert.ok(!Object.hasOwn(db, 'evil'), '不認識的鍵不可進記憶體 db');
    assert.ok(!Object.hasOwn(versions, 'evil') && !Object.hasOwn(versions, '__proto__'), 'versions 只認 KV_KEYS');
    assert.equal(/** @type {any} */ ({}).polluted, undefined, 'Object.prototype 不可以被污染');
    assert.equal(db.settings.usdTwd, 30.5, '對照：認識的鍵照常讀進來（否則這題只是在考「什麼都沒讀」）');
  });
});
