// 伺服器端點的自動考試（B0）：這是階段 B 大改建的安全網——
// 之後把後端拆房間/換資料庫時，這些考題保證「對外行為完全不變」。
// 隔離原則：STORE_FILE 指向 os 暫存目錄的檔案（從 seed 複製），絕不碰真實 data/store.json。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

// 必須在 import server.js「之前」設好（store.js 在載入時就決定檔案路徑）
const TEST_STORE = join(tmpdir(), `finance-test-store-${process.pid}.json`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');   // 0＝隨機空埠，不會撞到 4321
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;

const GET = async (p) => (await fetch(base + p)).json();
const SEND = (method) => async (p, body) => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
});
const POST = SEND('POST'), PUT = SEND('PUT'), DELETE_ = SEND('DELETE');

after(() => {
  server.close();
  try { rmSync(TEST_STORE); rmSync(TEST_STORE + '.bak'); } catch { /* 沒有 .bak 也沒關係 */ }
});

test('GET /api/summary：回傳完整總覽（seed 資料）', async () => {
  const s = await GET('/summary');
  assert.equal(typeof s.netWorth, 'number');
  assert.ok(s.netWorth > 0);
  assert.ok(Array.isArray(s.reminders));
  assert.equal(typeof s.subscriptions.count, 'number');
});

test('交易 CRUD：新增→讀回→修改→刪除', async () => {
  const created = await (await POST('/transactions', {
    date: '2026-07-05', type: 'expense', category: '飲食', subcategory: '餐廳', amount: 120, note: '端點測試',
  })).json();
  assert.ok(created.id, '新增要回 id');
  const list1 = await GET('/transactions');
  assert.ok(list1.some((t) => t.id === created.id), '列表要包含新增的那筆');
  const updated = await (await PUT(`/transactions/${created.id}`, { category: '娛樂' })).json();
  assert.equal(updated.category, '娛樂');
  assert.equal(updated.amount, 120, '沒送的欄位要保留');
  await DELETE_(`/transactions/${created.id}`);
  const list2 = await GET('/transactions');
  assert.ok(!list2.some((t) => t.id === created.id), '刪除後列表不該再有');
});

test('PUT /api/settings：部分更新會合併、不會蓋掉其他設定', async () => {
  const before = await GET('/settings');
  const res = await (await PUT('/settings', { emergencyFundMonths: 9 })).json();
  assert.equal(res.emergencyFundMonths, 9);
  assert.equal(typeof res.ib, 'object', 'ib 設定要保留');
  assert.equal(res.usdTwd, before.usdTwd, '沒送的欄位要保留');
  await PUT('/settings', { emergencyFundMonths: before.emergencyFundMonths });   // 還原
});

test('POST /api/snapshot：記錄本月快照（本地日期，非 UTC）', async () => {
  const snap = await (await POST('/snapshot')).json();
  assert.match(snap.month, /^\d{4}-\d{2}$/);
  assert.match(snap.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(snap.date.startsWith(snap.month), '快照日期要落在快照月份內');
  assert.equal(typeof snap.netWorth, 'number');
});

test('自動學習：帳單交易改分類 → /api/learned 記住 → 可刪除', async () => {
  const tx = await (await POST('/transactions', {
    date: '2026-07-06', type: 'expense', category: '其他', subcategory: '未分類',
    amount: 50, note: '端點測試店', storeKey: '端點測試店', source: 'stmt',
  })).json();
  await PUT(`/transactions/${tx.id}`, { category: '娛樂', subcategory: '' });
  const learned = await GET('/learned');
  assert.equal(learned['端點測試店']?.category, '娛樂', '改分類要被學起來');
  await POST('/learned/delete', { key: '端點測試店' });
  const after2 = await GET('/learned');
  assert.ok(!('端點測試店' in after2), '刪除學習後不該再有');
  await DELETE_(`/transactions/${tx.id}`);
});

test('欄位白名單：白名單外的欄位（含企圖覆寫 id）寫入時被剝掉', async () => {
  const created = await (await POST('/transactions', {
    id: 'HACK-ID', date: '2026-07-07', type: 'expense', category: '飲食', amount: 10,
    evil: '不在白名單', leverage: 999,
  })).json();
  assert.notEqual(created.id, 'HACK-ID', 'id 由伺服器配發，不可被覆寫');
  assert.ok(!('evil' in created) && !('leverage' in created), '白名單外欄位不該被存起來');
  assert.equal(created.amount, 10, '合法欄位照常寫入');
  await DELETE_(`/transactions/${created.id}`);
});

test('欄位白名單：更新時白名單外欄位一樣被剝掉', async () => {
  const tx = await (await POST('/transactions', { date: '2026-07-08', type: 'expense', category: '飲食', amount: 20 })).json();
  const updated = await (await PUT(`/transactions/${tx.id}`, { amount: 30, hack: 'x' })).json();
  assert.equal(updated.amount, 30);
  assert.ok(!('hack' in updated), '白名單外欄位不該進資料');
  await DELETE_(`/transactions/${tx.id}`);
});

test('輸入防呆：batch/delete 缺批次代號 → 400（在寫檔前擋下）', async () => {
  const res = await POST('/statement/batch/delete', {});
  assert.equal(res.status, 400);
});

test('輸入防呆：改不存在的交易 → 404', async () => {
  const res = await PUT('/transactions/__不存在__', { category: '飲食' });
  assert.equal(res.status, 404);
});

test('設定白名單（Codex）：擋下 IB 同步擁有欄位與未知欄位、合法欄位照寫', async () => {
  const before = await GET('/settings');
  await PUT('/settings', {
    usdTwd: before.usdTwd,                              // 合法：照常寫入
    ib: { lastEquity: { stock: 99999, cash: -99999 }, flexQueryId: before.ib?.flexQueryId || '' },
    fxTwd: { GBP: 41.5, EVIL: 'x' },                    // GBP 數值收、EVIL 非數值剝掉
    evilTop: 1,                                         // 未知頂層欄位剝掉
  });
  const s = await GET('/settings');
  assert.ok(!('evilTop' in s), '未知頂層欄位不該寫入');
  assert.notEqual(s.ib?.lastEquity?.stock, 99999, 'lastEquity 屬 IB 同步、前端不可偽造（影響槓桿/斷頭）');
  assert.equal(s.fxTwd?.GBP, 41.5, '合法匯率照常寫入');
  assert.ok(!('EVIL' in (s.fxTwd || {})), 'fxTwd 非數值項要被剝掉');
  assert.ok('flexToken' in (s.ib || {}), 'ib 既有欄位保留');
});

test('匯入防呆（Codex）：集合型別錯誤 → 400，且不寫壞資料', async () => {
  const backup = await GET('/db');
  const res = await POST('/import', { settings: backup.settings, subscriptions: 'oops', holdings: 'oops' });
  assert.equal(res.status, 400);
  const sum = await GET('/summary');   // 確認沒被寫壞
  assert.equal(typeof sum.netWorth, 'number');
});

test('匯入正常：合法備份可還原、且還原後 summary 正常', async () => {
  const backup = await GET('/db');   // 用現有 db 當備份 → 冪等，不影響其他考題
  const res = await (await POST('/import', backup)).json();
  assert.equal(res.ok, true);
  const sum = await GET('/summary');
  assert.ok(sum.netWorth > 0);
});

test('隔離確認：測試用的是暫存資料檔，不是真實 store.json', () => {
  assert.ok(TEST_STORE.startsWith(tmpdir()), '資料檔必須在系統暫存目錄');
  assert.ok(!TEST_STORE.includes('榮祥森'), '不可指向專案資料夾');
});
