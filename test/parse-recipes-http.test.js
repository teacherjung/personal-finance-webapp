// @ts-check
// 規則卡管理端點的**真 HTTP** 封閉投影卷（Codex #513 r1#1：只直呼服務函式＝路由層被改成裸回 db 也全綠）。
// 起真的 server.js、隔離 STORE_FILE；在庫裡種一張帶「機密字面」的配方，直打端點斷言：
// 回應鍵集合**精確封閉**、整個 body 一個配方字面都不含；刪除端點錯 id／缺 id／正刪也走真 HTTP。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `finance-recipes-http-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { RECIPE_FORMAT_VERSION } = await import('../lib/parse-recipe.js');

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;

after(() => { server.close(); for (const suf of ['', '.bak', '.pre-ledger-migration.bak', '-wal', '-shm', '.json']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } } });

const SECRET_ANCHOR = 'MUTANT-SECRET-LAYOUT';
const SECRET_HEADER = 'MUTANT-SECRET-HEADER';
const recipe = () => ({
  formatVersion: RECIPE_FORMAT_VERSION, bank: '合成銀行',
  docAnchors: [SECRET_ANCHOR, '第二錨'], dateFormat: 'west-slash',
  refDate: { strategy: 'anchored-date', anchor: '結算基準日' },
  summary: { sections: [{ anchor: SECRET_ANCHOR, currency: 'TWD' }], endAnchor: '總計', balancePick: 'dollar-tagged' },
  detail: { rowIdent: 'acct-date', headerOut: '提領金額', headerIn: SECRET_HEADER, headerBalance: '結存餘額', headerNote: '附記', headerIgnore: ['單號'] },
});

test('GET /api/parse-recipes｜真 HTTP：鍵集合精確封閉、整個 body 不含任何配方字面', async () => {
  const db = await getDb();
  db.parseRecipes = [{ id: 'rcp-http', bank: '合成銀行', current: recipe(), previous: recipe(),
    graduateStreak: 2, graduated: false, suspect: false, rebirths: 1,
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', lastUsedAt: '2026-08-21T00:00:00.000Z' }];
  await saveDb(db);
  const res = await fetch(`${base}/api/parse-recipes`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const list = JSON.parse(text);
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['bank', 'createdAt', 'graduateStreak', 'graduated', 'hasPrevious', 'id', 'lastUsedAt', 'rebirths', 'suspect', 'updatedAt'].sort(), `★端點回應的鍵集合精確封閉（實得 ${text}）`);
  for (const literal of [SECRET_ANCHOR, SECRET_HEADER, 'docAnchors', 'headerIn', '結算基準日', '提領金額', 'current', 'previous']) {
    assert.ok(!text.includes(`"${literal}"`) && !text.includes(literal === 'current' || literal === 'previous' ? `"${literal}"` : literal), `★body 不含配方字面／內容欄：${literal}`);
  }
  assert.equal(list[0].hasPrevious, true);
  assert.equal(list[0].graduateStreak, 2);
});

test('POST /api/parse-recipes/delete｜真 HTTP：缺 id 400、錯 id 404（零改動）、正刪只刪那張', async () => {
  const db = await getDb();
  db.parseRecipes = [
    { id: 'rcp-a', bank: '合成銀行', current: recipe(), graduateStreak: 0, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' },
    { id: 'rcp-b', bank: '別家銀行', current: recipe(), graduateStreak: 0, graduated: false, suspect: false, rebirths: 0, createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' },
  ];
  await saveDb(db);
  const post = (/** @type {any} */ body) => fetch(`${base}/api/parse-recipes/delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ id: 'rcp-x' })).status, 404);
  assert.equal((await getDb()).parseRecipes.length, 2, '錯 id／缺 id＝零改動');
  const ok = await post({ id: 'rcp-b' });
  assert.equal(ok.status, 200);
  assert.deepEqual((await getDb()).parseRecipes.map((/** @type {any} */ r) => r.id), ['rcp-a'], '★只刪指定那張（不是陣列頭）');
});
