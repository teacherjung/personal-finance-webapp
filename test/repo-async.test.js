// @ts-check
// C4a（repo 櫃檯 async 化）的守約考題：LOCAL 模式行為必須與同步版 100% 等價。
//
// 為什麼要有這檔：C0 的 Codex 複審點名「async 切換與 stale-overwrite 是比 import 數量更大的風險」——
// 櫃檯改 async 後，理論上每個 await 都是潛在的交錯點。LOCAL 不交錯的根據是：
// 底層 SQLite 是同步的、getDb/saveDb 函式體內沒有真正的 await 點，呼叫後只隔一個 microtask，
// 而 Node 在清空 microtask queue 之前不會處理下一個 HTTP 請求——所以「await getDb() → 改 →
// await saveDb()」這條鏈對其他請求而言仍是不可分割的（見 lib/repo.js 檔頭）。
// 這裡用真的 HTTP 並發把這件事釘死：若未來有人在櫃檯或 handler 的讀寫之間夾進真正的外部 IO await，
// 這些考題會開始失敗——那正是要抓的回歸。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

// 必須在 import server.js「之前」設好（store.js 在載入時就決定檔案路徑）
const TEST_STORE = join(tmpdir(), `finance-test-repo-async-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const repo = await import('../lib/repo.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;

const GET = async (/** @type {string} */ p) => (await fetch(base + p)).json();
const POST = async (/** @type {string} */ p, /** @type {any} */ body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

after(() => {
  server.close();
  for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

test('櫃檯簽名鎖：全部讀寫函式回 Promise（C4b Postgres adapter 的前提，不可改回同步）', async () => {
  // 只驗簽名不驗值——這是給「未來好心把它改回同步」的人的絆索：C4b 的 Postgres client 必然 async，
  // 呼叫端已全面 await，簽名退回同步會讓 HOSTED 模式無路可走。
  for (const name of ['getDb', 'saveDb', 'getCollection', 'addItem', 'updateItem', 'deleteItem', 'replaceCollection', 'getSettings', 'updateSettings']) {
    assert.equal(/** @type {any} */ (repo)[name].constructor.name, 'AsyncFunction', `${name} 必須是 async function`);
  }
  const db = await repo.getDb();
  assert.ok(db && typeof db === 'object' && db.settings, 'await getDb() 要拿到整包 db');
});

test('await saveDb 之後立即 getDb：讀到剛寫的值（寫入完成才 resolve，不是 fire-and-forget）', async () => {
  const db = await repo.getDb();
  const marker = `c4a-marker-${Date.now()}`;
  db.settings = { ...db.settings, c4aMarker: marker };
  await repo.saveDb(db);
  const fresh = await repo.getDb();
  assert.equal(/** @type {any} */ (fresh.settings).c4aMarker, marker);
});

test('HTTP 並發寫入不互蓋：兩個同時進來的新增請求，兩筆都要活著（stale-overwrite 守門）', async () => {
  // 同步版時代這件事天然成立（handler 從頭同步跑到尾）；async 版成立的根據是 microtask 連續性。
  // 若櫃檯或 handler 的「讀→改→寫」之間混進真正的外部 IO await，後進請求會讀到舊快照、
  // 寫回時把先進請求的那筆吃掉——這條考題就會抓到（少一筆）。
  const mk = (/** @type {string} */ note) => ({ date: '2026-07-27', type: 'expense', category: '其他', amount: 111, note });
  const [r1, r2] = await Promise.all([POST('/transactions', mk('並發甲')), POST('/transactions', mk('並發乙'))]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const txs = await GET('/transactions');
  const notes = txs.map((/** @type {any} */ t) => t.note);
  assert.ok(notes.includes('並發甲'), '第一筆並發寫入不可被蓋掉');
  assert.ok(notes.includes('並發乙'), '第二筆並發寫入不可被蓋掉');
});

test('HTTP 並發「寫＋讀」：讀不到半套狀態（新增與清單同時打，清單回應必是合法陣列）', async () => {
  const mk = (/** @type {string} */ note) => ({ date: '2026-07-27', type: 'expense', category: '其他', amount: 222, note });
  const [w, list] = await Promise.all([POST('/transactions', mk('並發丙')), GET('/transactions')]);
  assert.equal(w.status, 200);
  assert.ok(Array.isArray(list), '並發讀取要回合法清單（不可炸、不可回半包）');
  const after2 = await GET('/transactions');
  assert.ok(after2.some((/** @type {any} */ t) => t.note === '並發丙'), '寫入完成後必可讀到');
});

test('HTTP 並發的 getDb…saveDb：兩個同時進來的「改帳單年月」請求，兩批都要改到', async () => {
  // 題名關鍵字「HTTP 並發寫入不互蓋」那一題打的新增端點走櫃檯自己的寫入（addItem→mutate），
  // LOCAL 下讀改寫整段在櫃檯裡同步跑完，碰不到 getDb…saveDb 這一對。這一題換成呼叫端自己
  // `await getDb()` → 改 → `await saveDb()` 的端點（setBatchMonth）：讀改寫之間若夾進真正的外部 IO await
  // （櫃檯的 saveDb 裡或 handler 裡都算），後到的請求會拿舊快照寫回，把先到的那一批改回去。
  // 本題擋不住：夾進去的 await 短到兩個請求沒有真的交錯時，本題照樣綠。
  const tag = `c4a-batch-${process.pid}`;
  const A = `${tag}-a`, B = `${tag}-b`;
  const mk = (/** @type {string} */ batch, /** @type {string} */ note) => ({
    date: '2026-07-27', type: 'expense', category: '其他', amount: 333, note, source: 'stmt', ledger: 'card', importBatch: batch,
  });
  const ta = await repo.addItem('transactions', mk(A, '批次甲'));
  const tb = await repo.addItem('transactions', mk(B, '批次乙'));
  const stmtMonthOf = async (/** @type {string} */ id) =>
    (await repo.getDb()).transactions.find((/** @type {any} */ t) => t.id === id)?.stmtMonth;
  // 對照：兩批起點都沒有年月，「兩批都改到」才證得出兩次寫入都真的落庫
  assert.equal(await stmtMonthOf(ta.id), undefined);
  assert.equal(await stmtMonthOf(tb.id), undefined);
  const [ra, rb] = await Promise.all([
    POST('/statement/batch/month', { batchId: A, month: '2026-01' }),
    POST('/statement/batch/month', { batchId: B, month: '2026-02' }),
  ]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  assert.equal(await stmtMonthOf(ta.id), '2026-01', '甲批的年月不可被另一個請求的舊快照蓋回去');
  assert.equal(await stmtMonthOf(tb.id), '2026-02', '乙批的年月不可被另一個請求的舊快照蓋回去');
});
