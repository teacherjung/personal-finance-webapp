// 「送給 AI 之前先問我一次」開關的**完整來回**：PUT 存進去 → GET 讀回來。
//
// 這一題的由來（#455 r1#3 後半，Codex 抓到）：`test/settings-value-kinds.test.js` 只呼叫
// sanitizer 純函式——把「sanitize 之後真的寫進資料庫、投影之後真的送回瀏覽器」整段刪掉，
// 那些題照樣全綠。而這顆開關的意義就是「下一次上傳讀到什麼」：來回斷掉＝畫面上的開關
// 是裝飾品，帳單照樣直接外送。所以這題走**真的 HTTP**（同 test/server.test.js 的手法）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

// 必須在 import server.js「之前」設好（store.js 在載入時就決定檔案路徑）
const TEST_STORE = join(tmpdir(), `finance-settings-rt-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;

after(() => {
  server.close();
  for (const suffix of ['', '-wal', '-shm', '.bak']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* 沒有就算了 */ }
  }
});

const getSettings = async () => (await (await fetch(`${base}/settings`)).json());
const putSettings = (body) => fetch(`${base}/settings`, {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('開關來回｜PUT true → GET 讀回 true；PUT false → 讀回 false（真的存了、真的回得來）', async () => {
  assert.equal((await getSettings()).aiAskBeforeSend, false, '出廠預設＝false（不問、直接送）');
  assert.equal((await putSettings({ aiAskBeforeSend: true })).status, 200);
  assert.equal((await getSettings()).aiAskBeforeSend, true,
    '★存了 true 要讀得回 true——這一段斷掉，畫面上的開關就是裝飾品、帳單照樣直接外送');
  assert.equal((await putSettings({ aiAskBeforeSend: false })).status, 200);
  assert.equal((await getSettings()).aiAskBeforeSend, false, '★關回去也要真的關（只驗 true 會漏掉半邊）');
});

test('開關來回｜非布林被櫃檯剝掉：既有值不被壞值蓋掉', async () => {
  await putSettings({ aiAskBeforeSend: true });
  assert.equal((await putSettings({ aiAskBeforeSend: 'false' })).status, 200,
    '壞型別整包不炸（其他欄位照存）——但那一欄要被剝掉');
  assert.equal((await getSettings()).aiAskBeforeSend, true,
    '★字串 "false" 不可以把使用者開好的 true 蓋掉——truthy/falsy 都不是布林');
  await putSettings({ aiAskBeforeSend: false });   // 收尾：還原預設
});
