// 崩潰安全與健壯性考題（自審 3/3＋B3 SQLite）：交易寫入、統一錯誤處理、
// IB 同步幣別牆、舊資料自動搬家、櫃檯級驗證（驗證入櫃檯）。
// 隔離：STORE_FILE 指向 os 暫存檔（同 server.test.js 規矩），絕不碰真實 data/。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const TEST_STORE = join(tmpdir(), `finance-robust-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const store = await import('../lib/store.js');
const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
  for (const suf of ['', '.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

test('SQLite 存讀：save→load 完整往返、交易式寫入（B3）', () => {
  const dbObj = { ...store.emptyDb(), history: [{ id: 'm1', month: '2026-07', amount: 42 }] };
  store.save(dbObj);
  const back = store.load();
  assert.equal(back.history?.[0]?.amount, 42, '寫進 SQLite 再讀回要一致');
  assert.ok(Array.isArray(back.transactions), '缺的集合讀回為空陣列');
});

test('驗證入櫃檯（B3）：任何路徑寫入非法枚舉 → save() 當場 throw（結構性堵死「繞過牆」）', () => {
  const bad = { ...store.emptyDb(), subscriptions: [{ id: 'x', name: 'bad', amount: 1200, cycle: 'yearlyy' }] };
  assert.throws(() => store.save(bad), /cycle/, '非法 cycle 必須在唯一寫入口被攔下');
  const bad2 = { ...store.emptyDb(), accounts: [{ id: 'y', name: 'z', type: 'mortgagex', balance: 100 }] };
  assert.throws(() => store.save(bad2), /type/, '非法 accounts.type 必須被攔下');
});

test('驗證入櫃檯：settings 也過牆（Codex#8-2）——usdTwd 錯型別在唯一寫入口被攔下', () => {
  const bad = { ...store.emptyDb(), settings: { ...store.emptyDb().settings, usdTwd: 'oops' } };
  assert.throws(() => store.save(/** @type {any} */ (bad)), /usdTwd/, '設定壞值不可繞過櫃檯（會讓匯率換算全錯）');
  const bad2 = { ...store.emptyDb(), settings: { ...store.emptyDb().settings, fxTwd: { GBP: -1 } } };
  assert.throws(() => store.save(/** @type {any} */ (bad2)), /fxTwd/, '負匯率不可繞過櫃檯');
});

test('驗證入櫃檯：非物件元素在寫入口被濾除（不用等匯入端記得清）', () => {
  const dirty = { ...store.emptyDb(), holdings: [null, { id: 'h1', symbol: 'CSPX', currency: 'USD', quantity: 1, price: 10 }, 'junk'] };
  store.save(/** @type {any} */ (dirty));
  const back = store.load();
  assert.equal(back.holdings.length, 1, '非物件元素應被濾掉');
  assert.equal(back.holdings[0].symbol, 'CSPX');
});

test('舊資料自動搬家（B3）：store.json → SQLite，資料完整、原 json 保留', () => {
  // 用子行程跑（搬家只在開檔時檢查一次；本行程的資料庫已開啟）
  const dbPath = join(tmpdir(), `finance-migrate-${process.pid}.db`);
  const jsonPath = dbPath.slice(0, -3) + '.json';
  const legacy = { ...store.emptyDb(), history: [{ id: 'mig1', month: '2026-06', amount: 777 }] };
  writeFileSync(jsonPath, JSON.stringify(legacy));
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { load } from '${ROOT.replace(/'/g, "\\'")}/lib/store.js';
      const db = load();
      console.log(JSON.stringify({ amount: db.history?.[0]?.amount, count: db.history?.length }));
    `], { env: { ...process.env, STORE_FILE: dbPath }, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop() || '{}');
    assert.equal(r.amount, 777, '舊 json 的資料要完整搬進 SQLite');
    assert.equal(readFileSync(jsonPath, 'utf8').includes('777'), true, '原 store.json 保留不動（備份）');
  } finally {
    for (const f of [dbPath, dbPath + '.bak', dbPath + '-wal', dbPath + '-shm', jsonPath]) { try { rmSync(f); } catch { /* 可能不存在 */ } }
  }
});

test('搬家重搬規則（Codex#8-1）：db 沒寫過→安全重搬；兩邊都寫過→fail closed 不自動覆蓋', () => {
  const dbPath = join(tmpdir(), `finance-remigrate-${process.pid}.db`);
  const jsonPath = dbPath.slice(0, -3) + '.json';
  const runChild = (/** @type {string} */ code) => execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { env: { ...process.env, STORE_FILE: dbPath }, encoding: 'utf8' });
  const IMPORT = `import { load, save, emptyDb } from '${ROOT.replace(/'/g, "\\'")}/lib/store.js';`;
  try {
    // 步驟1：首次搬家（json 標記 A）
    writeFileSync(jsonPath, JSON.stringify({ ...store.emptyDb(), history: [{ id: 'A', month: '2026-01', amount: 1 }] }));
    runChild(`${IMPORT} load();`);
    // 步驟2：db「沒被寫過」、json 變新（標記 B）→ 應安全重搬、以 json 為準
    writeFileSync(jsonPath, JSON.stringify({ ...store.emptyDb(), history: [{ id: 'B', month: '2026-02', amount: 2 }] }));
    const out1 = runChild(`${IMPORT} console.log(JSON.stringify(load().history.map(h=>h.id)));`);
    assert.deepEqual(JSON.parse(out1.trim().split('\n').pop() || '[]'), ['B'], 'db 未寫過時應以較新的 json 重搬');
    // 步驟3：db 被寫過（新增 C）、json 又變新（標記 D）→ 兩邊都有新資料，必須 fail closed
    runChild(`${IMPORT} const db = load(); db.history.push({ id: 'C', month: '2026-03', amount: 3 }); save(db);`);
    writeFileSync(jsonPath, JSON.stringify({ ...store.emptyDb(), history: [{ id: 'D', month: '2026-04', amount: 4 }] }));
    let threw = false, msg = '';
    try { runChild(`${IMPORT} load();`); }
    catch (e) { threw = true; msg = String(/** @type {any} */ (e).stderr || e); }
    assert.ok(threw, '兩邊都改過時不可自動覆蓋（會遺失其中一邊）——必須停下來請使用者選');
    assert.ok(/store\.json.*store\.db|二選一/s.test(msg), '錯誤訊息要給使用者明確的二選一指引');
  } finally {
    for (const f of [dbPath, dbPath + '.bak', dbPath + '-wal', dbPath + '-shm', jsonPath]) { try { rmSync(f); } catch { /* 可能不存在 */ } }
  }
});

test('搬家 settings 清理（Codex#8-2）：舊 json 的 usdTwd 壞值→剝除補預設，不污染計算', () => {
  const dbPath = join(tmpdir(), `finance-migbad-${process.pid}.db`);
  const jsonPath = dbPath.slice(0, -3) + '.json';
  const legacy = { ...store.emptyDb(), settings: { ...store.emptyDb().settings, usdTwd: 'oops' } };
  writeFileSync(jsonPath, JSON.stringify(legacy));
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { load } from '${ROOT.replace(/'/g, "\\'")}/lib/store.js';
      console.log(JSON.stringify({ usdTwd: load().settings.usdTwd }));
    `], { env: { ...process.env, STORE_FILE: dbPath }, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop() || '{}');
    assert.equal(r.usdTwd, 32, '壞的 usdTwd 應被剝除、由預設 32 接手（不可留字串）');
  } finally {
    for (const f of [dbPath, dbPath + '.bak', dbPath + '-wal', dbPath + '-shm', jsonPath]) { try { rmSync(f); } catch { /* 可能不存在 */ } }
  }
});

test('fail-closed 每次都擋（自審r2-H1）：搬家失敗後重試不可拿到空資料庫', () => {
  const dbPath = join(tmpdir(), `finance-failclosed-${process.pid}.db`);
  const jsonPath = dbPath.slice(0, -3) + '.json';
  writeFileSync(jsonPath, '{ 這不是合法 JSON');   // 舊檔損毀＋新庫不存在 → 首次搬家必失敗
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { load } from '${ROOT.replace(/'/g, "\\'")}/lib/store.js';
      let first = null, second = null;
      try { load(); } catch (e) { first = e.message; }
      try { load(); } catch (e) { second = e.message; }
      console.log(JSON.stringify({ firstThrew: !!first, secondThrew: !!second }));
    `], { env: { ...process.env, STORE_FILE: dbPath }, encoding: 'utf8' });
    const r = JSON.parse(out.trim().split('\n').pop() || '{}');
    assert.equal(r.firstThrew, true, '第一次要擋');
    assert.equal(r.secondThrew, true, '第二次也要擋（修前：第二次會拿到空資料庫繼續運作）');
  } finally {
    for (const f of [dbPath, dbPath + '.bak', dbPath + '-wal', dbPath + '-shm', jsonPath]) { try { rmSync(f); } catch { /* 可能不存在 */ } }
  }
});

test('統一錯誤處理：壞的 JSON body → 乾淨 JSON 400，不洩漏伺服器路徑', async () => {
  const res = await fetch(base + '/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{bad json',
  });
  assert.equal(res.status, 400);
  const ct = res.headers.get('content-type') || '';
  assert.ok(ct.includes('application/json'), '應回 JSON 而非 HTML 堆疊');
  const body = await res.text();
  assert.ok(!/node_modules|server\.js|\/Users\//.test(body), '不可洩漏伺服器檔案路徑');
});

test('IB 同步幣別牆（Codex#7）：未支援幣別跳過並回報，不寫進資料', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  const fake = async () => ({
    positions: [
      { symbol: 'CSPX', currency: 'USD', quantity: 10, marketPrice: 500, avgCost: 480 },
      { symbol: 'VWCE', currency: 'EUR', quantity: 5, marketPrice: 100, avgCost: 90 },   // 未支援 → 跳過
    ],
    cashByCurrency: { USD: 1000, EUR: 200 },   // EUR 現金 → 跳過
    equity: { stock: 5000, cash: 1000 }, income: null, trades: [], account: 'TEST', period: {},
  });
  const r = await syncIb(/** @type {any} */ (fake));
  assert.deepEqual(r.skippedCurrencies, ['VWCE(EUR)', '現金(EUR)'], '未支援幣別要明確回報');
  const db = store.load();
  assert.ok(!(db.holdings || []).some((h) => h.symbol === 'VWCE'), 'EUR 持股不可寫入（會被錯誤匯率計價）');
  assert.ok((db.holdings || []).some((h) => h.symbol === 'CSPX' && h.currency === 'USD'), 'USD 持股照常同步');
  assert.ok(!(db.accounts || []).some((a) => a.ibCashCur === 'EUR'), 'EUR 現金帳戶不可建立');
  assert.ok((db.accounts || []).some((a) => a.ibCashCur === 'USD' && a.balance === 1000), 'USD 現金照常更新');
});

test('IB 現金幣別從報表消失 → 歸零，淨資產不虛增（Codex r4#3；r5#2 收緊判準）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  // 報表的 Cash Report 有「真實幣別明細」（GBP 還在），但 USD 已提光、不再列——這才可以歸零。
  // （r5#2：光有區塊不夠，要有明細列在場才證明「沒列＝真的沒了」而不是「報表不完整」）
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: { GBP: 50 }, hasCashReport: true, hasCashDetail: true, equity: null, income: null, trades: [], account: 'T', period: {} })));
  const acc = store.load().accounts?.find(a => a.ibCashCur === 'USD');
  assert.equal(acc?.balance, 0, '報表不再列這個幣別＝現金已清空，帳上不可殘留舊餘額');
  assert.equal(r.cashZeroed, 1, '要回報歸零了幾個幣別');
});

test('Cash Report 只有 BASE_SUMMARY 彙總列（無任何幣別明細）→ 保留舊值＋回報，不可歸零（Codex r5#2）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  // 區塊在、明細空（部分報表/精簡設定的長相）——舊判準「區塊存在就歸零」會把真實現金誤清
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: true, hasCashDetail: false, equity: null, income: null, trades: [], account: 'T', period: {} })));
  assert.equal(store.load().accounts?.find(a => a.ibCashCur === 'USD')?.balance, 1000, '沒有明細＝沒資料，保留舊值');
  assert.equal(r.cashZeroed, 0);
  assert.equal(r.cashDetailMissing, true, '要回報「有區塊沒明細」讓使用者看得見異常');
});

test('ib.js 解析器旗標語意：只有 BASE_SUMMARY → hasCashReport:true 而 hasCashDetail:false（中間那棒也要考）', async () => {
  const { parseStatement } = await import('../lib/ib.js');
  const mk = (/** @type {any[]} */ rows) => parseStatement({ FlexQueryResponse: { FlexStatements: { FlexStatement: {
    CashReport: { CashReportCurrency: rows } } } } });
  const onlySummary = mk([{ currency: 'BASE_SUMMARY', endingCash: 1234 }]);
  assert.equal(onlySummary.hasCashReport, true);
  assert.equal(onlySummary.hasCashDetail, false, '彙總列不算明細——據此歸零就會誤清真實現金');
  assert.deepEqual(onlySummary.cashByCurrency, {});
  const withDetail = mk([{ currency: 'BASE_SUMMARY', endingCash: 1234 }, { currency: 'USD', endingCash: 1000 }]);
  assert.equal(withDetail.hasCashDetail, true);
  assert.deepEqual(withDetail.cashByCurrency, { USD: 1000 });
});

test('Cash Report 區塊整個缺失 → 保留舊值＋回報（缺資料 ≠ 現金為 0，Codex r4#3）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  // 沒有 Cash Report 區塊（Flex 漏勾/查詢失敗）→ 不可硬歸零，那會誤清真實餘額
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: false, equity: null, income: null, trades: [], account: 'T', period: {} })));
  const acc = store.load().accounts?.find(a => a.ibCashCur === 'USD');
  assert.equal(acc?.balance, 1000, '整個區塊缺失＝沒資料，保留舊值不誤清');
  assert.equal(r.cashZeroed, 0);
  assert.equal(r.cashReportMissing, true, '要回報「這次沒拿到現金資料」讓使用者看得見異常');
});

test('有 Cash Report、幣別仍在 → 照常更新，不誤歸零（保護不可誤傷正常情況）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: { USD: 1500 }, hasCashReport: true, equity: null, income: null, trades: [], account: 'T', period: {} })));
  assert.equal(store.load().accounts?.find(a => a.ibCashCur === 'USD')?.balance, 1500, '有出現的幣別照常更新');
  assert.equal(r.cashZeroed, 0);
});

test('櫃檯也擋缺必填（Codex#11-1）：save() 遇缺 month 的 history 當場 throw', () => {
  const bad = { ...store.emptyDb(), history: [{ id: 'x', amount: 100 }] };
  assert.throws(() => store.save(/** @type {any} */ (bad)), /month/, '任何寫入路徑都不可能塞進缺主鍵欄的資料');
});

test('strip 模式：必填 month「有值但格式錯」整筆濾除，不只刪欄位（Codex#12-1）', async () => {
  const { sanitizeDbForWrite } = await import('../lib/schema.js');
  // 每個集合放一筆合法 + 一筆「month 存在但壞」（字串壞格式、數字），壞的要整筆消失、不能只剩缺 month 的殘骸
  const input = {
    ...store.emptyDb(),
    history: [{ id: 'ok', month: '2026-07', amount: 1 }, { id: 'bad1', month: 'not-a-month', amount: 2 }, { id: 'bad2', month: 202607, amount: 3 }],
    portfolioSnapshots: [{ id: 'ok', month: '2026-07', cost: 1, value: 2 }, { id: 'bad', month: 202607, cost: 1, value: 2 }],
    snapshots: [{ id: 'ok', month: '2026-07', netWorth: 1 }, { id: 'bad', month: 'xxxx', netWorth: 1 }]
  };
  const out = sanitizeDbForWrite(/** @type {any} */ (input), { mode: 'strip' });
  // 壞筆整筆濾除：只留合法筆，且留下的每一筆都必有合法 month（不可有「刪了 month 的殘骸」）
  for (const col of ['history', 'portfolioSnapshots', 'snapshots']) {
    assert.equal(out[col].length, 1, `${col}：壞 month 筆應整筆濾除，只剩 1 筆合法`);
    assert.equal(out[col][0].id, 'ok', `${col}：留下的是合法筆`);
    assert.ok(out[col].every((/** @type {any} */ r) => /^\d{4}-\d{2}$/.test(r.month)), `${col}：不可留下缺/壞 month 的殘骸`);
  }
});

test('IB 錯誤口徑（Codex#11-2）：fetchFlex 類錯誤標 400、內部錯誤不標', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  const failFetch = async () => { throw new Error('IB 連線失敗 (HTTP 500)'); };
  let caught = null;
  try { await syncIb(/** @type {any} */ (failFetch)); } catch (e) { caught = /** @type {any} */ (e); }
  assert.ok(caught, '要拋錯');
  assert.equal(caught.status, 400, 'IB 連線類＝使用者層錯誤，路由要能原味回應');
  assert.match(caught.message, /IB 連線失敗/, '訊息保留原味');
});

test('市場端點防崩：/api/cape 一律優雅回應（外部失敗走手動值退路）', async () => {
  const res = await fetch(base + '/api/cape');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok('value' in j);
});

test('r6#1｜只有 BASE_SUMMARY＋基準幣別可判定 → 以彙總入帳（原子取代），不再永遠沿用舊值', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(), accounts: [
    { id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 },
    { id: 'a2', name: 'IBKR GBP 現金', type: 'cash', class: '現金', currency: 'GBP', ibCashCur: 'GBP', balance: 50 },
  ] });
  // 合法的「只有彙總列」報表（Codex r6#1）：基準幣別總額本來就住在 BASE_SUMMARY
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: true, hasCashDetail: false,
    baseCurrency: 'USD', baseSummaryCash: 500, statementCount: 1,
    equity: null, income: null, trades: [], account: 'T', period: {} })));
  const accs = store.load().accounts || [];
  assert.equal(accs.find(a => a.ibCashCur === 'USD')?.balance, 500, '基準幣別以彙總金額入帳（舊值 1000 不可殘留）');
  assert.equal(accs.find(a => a.ibCashCur === 'GBP')?.balance, 0, '其他幣別歸零＝原子取代，避免與彙總重複計算');
  assert.equal(r.cashFromSummary, true);
  assert.equal(r.cashCollapsed, 1, '折疊記在 cashCollapsed（Codex r7#2）——這不是「提領/轉走」');
  assert.equal(r.cashZeroed, 0, '真歸零與折疊分開，前端才不會同時說兩句矛盾的話');
  assert.equal(r.cashDetailMissing, false, '拿到可用資料就不再掛「缺明細」警告');
});

test('r6#1｜首次同步＋只有彙總列 → 直接建立基準幣別現金帳戶（Codex 實測的原始情境）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb() });
  await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: true, hasCashDetail: false,
    baseCurrency: 'USD', baseSummaryCash: 500, statementCount: 1,
    equity: null, income: null, trades: [], account: 'T', period: {} })));
  assert.equal(store.load().accounts?.find(a => a.ibCashCur === 'USD')?.balance, 500, '以前這裡完全不會建立現金帳戶');
});

test('r6#1｜只有彙總列但基準幣別判定不了 → 維持 r5#2 保守路線（保留舊值＋警告）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: true, hasCashDetail: false,
    baseCurrency: '', baseSummaryCash: 500, statementCount: 1,
    equity: null, income: null, trades: [], account: 'T', period: {} })));
  assert.equal(store.load().accounts?.find(a => a.ibCashCur === 'USD')?.balance, 1000, '判定不了＝真的沒把握，保留舊值');
  assert.equal(r.cashDetailMissing, true);
  assert.equal(r.cashFromSummary, false);
});

test('r6#2｜多帳戶報表 → 400 整包拒絕，不寫入任何東西（現金/淨值只剩最後帳戶＝默默算錯）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  await assert.rejects(() => syncIb(/** @type {any} */ (async () => ({
    positions: [{ symbol: 'CSPX', currency: 'USD', quantity: 1, marketPrice: 500 }],
    cashByCurrency: { USD: 200 }, hasCashReport: true, hasCashDetail: true, statementCount: 2, accountCount: 2,
    equity: null, income: null, trades: [], account: 'B', period: {} }))), /個帳戶/);
  const back = store.load();
  assert.equal(back.accounts?.find(a => a.ibCashCur === 'USD')?.balance, 1000, '擋下＝資料一個字都不動');
  assert.ok(!(back.holdings || []).some(h => h.symbol === 'CSPX'));
});

test('r6#1/#2｜ib.js 解析器：BASE_SUMMARY 金額留底、AccountInformation 給基準幣別、statementCount 誠實回報', async () => {
  const { parseStatement } = await import('../lib/ib.js');
  const one = parseStatement({ FlexQueryResponse: { FlexStatements: { FlexStatement: {
    AccountInformation: { currency: 'usd' },
    CashReport: { CashReportCurrency: [{ currency: 'BASE_SUMMARY', endingCash: 500 }] } } } } });
  assert.equal(one.baseCurrency, 'USD');
  assert.equal(one.baseSummaryCash, 500);
  assert.equal(one.hasCashDetail, false);
  assert.equal(one.statementCount, 1);
  const two = parseStatement({ FlexQueryResponse: { FlexStatements: { FlexStatement: [
    { CashReport: { CashReportCurrency: [{ currency: 'USD', endingCash: 100 }] } },
    { CashReport: { CashReportCurrency: [{ currency: 'USD', endingCash: 200 }] } },
  ] } } });
  assert.equal(two.statementCount, 2, '多帳戶要誠實回報，讓同步端擋下');
});


test('r7#2｜基準幣別判定得出但不支援（EUR）→ 保留舊值＋明確回報「幣別不支援」而非「缺欄位」', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: true, hasCashDetail: false,
    baseCurrency: 'EUR', baseSummaryCash: 500, statementCount: 1, accountCount: 1,
    equity: null, income: null, trades: [], account: 'T', period: {} })));
  assert.equal(store.load().accounts?.find(a => a.ibCashCur === 'USD')?.balance, 1000, '不支援＝不可入帳，保留舊值');
  assert.equal(r.cashBaseUnsupported, 'EUR', '原因要說對：是幣別不支援，不是缺 Account Information');
  assert.equal(r.cashDetailMissing, false);
});

test('r7#3｜多 statement 的訊息分流：多帳戶說「多帳戶」、單帳戶 bundle 說「多份報表」（都拒絕）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb() });
  const mk = (/** @type {number} */ stmts, /** @type {number} */ accts) => (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: false, hasCashDetail: false,
    statementCount: stmts, accountCount: accts,
    equity: null, income: null, trades: [], account: 'T', period: {} }));
  await assert.rejects(() => syncIb(/** @type {any} */ (mk(2, 2))), /個帳戶/);
  await assert.rejects(() => syncIb(/** @type {any} */ (mk(3, 1))), /份報表/, '同帳戶的模型 bundle 要講對病因，使用者才修得對地方');
});

test('r7#3｜ib.js 解析器：accountCount＝去重帳戶數（節點數≠帳戶數）', async () => {
  const { parseStatement } = await import('../lib/ib.js');
  const r = parseStatement({ FlexQueryResponse: { FlexStatements: { FlexStatement: [
    { accountId: 'U111' }, { accountId: 'U111' }, { accountId: 'U222' },
  ] } } });
  assert.equal(r.statementCount, 3);
  assert.equal(r.accountCount, 2, '同帳戶多 statement 只算一個帳戶');
});

test('r8#1｜基準幣別齊全、彙總金額缺失 → 保留舊值＋cashSummaryMissing（不誤說「缺 Account Information」）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: {}, hasCashReport: true, hasCashDetail: false,
    baseCurrency: 'USD', baseSummaryCash: null, statementCount: 1, accountCount: 1,
    equity: null, income: null, trades: [], account: 'T', period: {} })));
  assert.equal(store.load().accounts?.find(a => a.ibCashCur === 'USD')?.balance, 1000, '金額缺失＝沒把握，保留舊值');
  assert.equal(r.cashSummaryMissing, true, '病因要說對：是彙總列缺金額欄，不是缺 Account Information');
  assert.equal(r.cashDetailMissing, false);
  assert.equal(r.cashFromSummary, false);
});

test('r9#1｜金額欄嚴格取值：空白/缺欄/非法/只有期初 一律不當 0（解析層五情境）', async () => {
  const { parseStatement } = await import('../lib/ib.js');
  const mk = (/** @type {any[]} */ rows) => parseStatement({ FlexQueryResponse: { FlexStatements: { FlexStatement: {
    AccountInformation: { currency: 'USD' }, CashReport: { CashReportCurrency: rows } } } } });
  // ①彙總列金額空白：Number('')=0 的陷阱——不可變成「彙總=0 → 清空現金」
  assert.equal(mk([{ currency: 'BASE_SUMMARY', endingCash: '' }]).baseSummaryCash, null, '空白＝沒有金額，不是零');
  // ②明細列缺金額欄
  const r2 = mk([{ currency: 'USD' }]);
  assert.deepEqual(r2.cashByCurrency, {}, '缺金額不可寫成 0');
  assert.equal(r2.cashDetailIncomplete, true);
  // ③非法金額
  const r3 = mk([{ currency: 'USD', endingCash: 'abc' }]);
  assert.deepEqual(r3.cashByCurrency, {});
  assert.equal(r3.cashDetailIncomplete, true, '非法金額＝明細不完整，不可觸發歸零');
  // ④只有期初 startingCash：期初不是目前現金
  const r4 = mk([{ currency: 'USD', startingCash: 500 }]);
  assert.deepEqual(r4.cashByCurrency, {}, '不可拿期初餘額冒充期末');
  // ⑤混合：有效列照收、無效列標不完整
  const r5 = mk([{ currency: 'USD', endingCash: 100 }, { currency: 'GBP', endingCash: '' }]);
  assert.deepEqual(r5.cashByCurrency, { USD: 100 });
  assert.equal(r5.cashDetailIncomplete, true);
  assert.equal(r5.hasCashDetail, true);
});

test('r9#1｜同步層：明細不完整 → 讀得到的更新、讀不到的沿用舊值、絕不歸零', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  store.save({ ...store.emptyDb(), accounts: [
    { id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 },
    { id: 'a2', name: 'IBKR GBP 現金', type: 'cash', class: '現金', currency: 'GBP', ibCashCur: 'GBP', balance: 50 },
  ] });
  const r = await syncIb(/** @type {any} */ (async () => ({
    positions: [], cashByCurrency: { USD: 200 }, hasCashReport: true, hasCashDetail: true, cashDetailIncomplete: true,
    statementCount: 1, accountCount: 1, equity: null, income: null, trades: [], account: 'T', period: {} })));
  const accs = store.load().accounts || [];
  assert.equal(accs.find(a => a.ibCashCur === 'USD')?.balance, 200, '有效幣別照常更新');
  assert.equal(accs.find(a => a.ibCashCur === 'GBP')?.balance, 50, 'GBP 金額讀不到＝沿用舊值，不可被「沒出現就歸零」誤清');
  assert.equal(r.cashZeroed, 0);
  assert.equal(r.cashDetailIncomplete, true, '要回報讓前端說明');
});

test('r9#1｜全管線：彙總列金額空白 → cashSummaryMissing、既有現金原封不動（Codex 實測情境）', async () => {
  const { syncIb } = await import('../lib/services/ib-sync.js');
  const { parseStatement } = await import('../lib/ib.js');
  store.save({ ...store.emptyDb(),
    accounts: [{ id: 'a1', name: 'IBKR USD 現金', type: 'cash', class: '現金', currency: 'USD', ibCashCur: 'USD', balance: 1000 }] });
  const parsed = parseStatement({ FlexQueryResponse: { FlexStatements: { FlexStatement: {
    AccountInformation: { currency: 'USD' }, CashReport: { CashReportCurrency: [{ currency: 'BASE_SUMMARY', endingCash: '' }] } } } } });
  const r = await syncIb(/** @type {any} */ (async () => parsed));
  assert.equal(store.load().accounts?.find(a => a.ibCashCur === 'USD')?.balance, 1000, '修正前這裡會被寫成 0');
  assert.equal(r.cashSummaryMissing, true);
  assert.equal(r.cashFromSummary, false);
});

test('自主體檢｜匯入列含 null/非物件 → 以 skipped 計，不可炸 500 毒整批', async () => {
  const card = await (await fetch(base + '/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '測試卡', type: 'credit', issuer: '台新' }) })).json();
  const res = await fetch(`${base}/api/cards/${card.id}/statement/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactions: [null, 'junk', { date: '2026-07-01', amount: 100, desc: '好店', store: '好店', category: '飲食', subcategory: '', stmtRef: `${card.id}|2026-07-01|100|好店` }] }) });
  assert.equal(res.status, 200, '不可 500');
  const r = await res.json();
  assert.equal(r.imported, 1, '合法列照常匯入');
  assert.equal(r.skipped, 2, '壞列以 skipped 誠實回報');
  await fetch(`${base}/api/cards/${card.id}`, { method: 'DELETE' });
});

test('自主體檢｜uid 唯一性：同毫秒連呼不碰撞（syncIb 一次建多檔持股不共用 id）', async () => {
  const { uid } = await import('../lib/store.js');
  const ids = Array.from({ length: 1000 }, () => uid());
  assert.equal(new Set(ids).size, 1000, '1000 次連呼必須全部唯一（否則 deleteItem 的 filter 會多刪）');
});

test('自主體檢｜匯入備份 fail-closed：自訂分類樹/店名規則型別壞 → 400，不可靜默剝除回 200', async () => {
  const bad = (patch) => fetch(base + '/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { usdTwd: 32, ...patch } }) }).then(r => r.status);
  assert.equal(await bad({ expenseTree: 'oops' }), 400, 'expenseTree 非物件要擋（否則自訂分類樹默默消失）');
  assert.equal(await bad({ storeRules: [] }), 400, 'storeRules 陣列要擋（手做店名規則默默消失）');
  assert.equal(await bad({ categoryAliases: 'x' }), 400);
  assert.equal(await bad({ subAliases: 3 }), 400);
});
