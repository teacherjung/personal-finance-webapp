// @ts-check
// 請求旗標一律嚴格（William 2026-09-05 裁示）：body 送來的開關，只有**真正的 `true`** 才算「打開」。
//
// 為什麼要有這一份：同一族開關原本三種口徑（`!!x`／`x === true`／`if (x)`），寬鬆那幾個連字串 'false'
// 都算打開。其中一個開關管的是「同一家店的其他筆一起改分類」——誤開會一次改到很多筆，而畫面只會回報成功。
//
// 守兩層，射程各自寫清楚：
//   ①行為題：送「看起來像開、但不是 true」的值時，那個動作**真的沒發生**（五個點各一題：整批傳播、
//     還原自動判斷、清品牌規則、清空全部略過、預覽）。
//   ②形狀題：`lib/routes/` 底下，本族開關名一律只能用 `=== true`／`!== true` 讀；用解析器看語法樹，
//     所以註解裡寫什麼都不算數。**射程邊界**：只認「`req.body`／`req.query` 直接取名」這一種寫法——
//     先解構成區域變數再判斷，這道網看不到（新端點若那樣寫，靠行為題與複審擋）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, readdirSync } from 'node:fs';
import { once } from 'node:events';
import ts from 'typescript';

const TEST_STORE = join(tmpdir(), `finance-strict-flags-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const { app } = await import('../server.js');
const { getDb, saveDb } = await import('../lib/repo.js');
const { storeKeyOf } = await import('../lib/statement.js');

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;
/** @param {string} p @param {any} [body] */
const POST = (p, body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
/** @param {string} p */
const GET = async (p) => (await fetch(base + p)).json();

after(() => {
  server.close();
  for (const suf of ['', '.bak', '-wal', '-shm']) { try { rmSync(TEST_STORE + suf); } catch { /* 可能不存在 */ } }
});

/** 同品牌兩家分店（storeKeyOf 收斂成同一把鑰匙），用來看「整批傳播／品牌規則」有沒有真的發生。 */
const A = '星巴克內湖店', B = '星巴克南港店';
/** @param {string} id @param {string} orig @param {string} cat @param {string} sub */
const tx = (id, orig, cat, sub) => ({
  id, date: '2026-07-01', type: 'expense', category: cat, subcategory: sub, amount: 100,
  note: orig, storeKey: storeKeyOf(orig), source: 'stmt', stmtRef: `c1|2026-07-01|100|${orig}`, ledger: 'card',
});

/** 每題自己鋪夾具：兩家分店各一筆，品牌層學過一條分類規則。 */
async function seed() {
  const db = await getDb();
  db.transactions = [tx('f1', A, '飲食', '咖啡'), tx('f2', B, '娛樂', '電影')];
  db.learnedCategories = { [storeKeyOf(A)]: { category: '飲食', subcategory: '咖啡' } };
  db.settings = { ...db.settings, healthDismissed: { 'probe-1': { at: '2026-07-01' } } };
  await saveDb(db);
  assert.equal(storeKeyOf(A), storeKeyOf(B), '前提：這兩個原文要收斂成同一把品牌鑰匙，整批傳播才觀察得到');
}

test('整批改分類的開關：送 \'false\' 這種「像開但不是 true」的值 → 只改本筆、不傳播；送 true 才傳播', async () => {
  await seed();
  const loose = await (await POST('/statement/rename-store',
    { orig: A, name: A, category: '生活', subcategory: '日用品', applyAll: 'false' })).json();
  assert.equal(loose.applied, null, `不是 true 就不可以整批改（實際回 ${JSON.stringify(loose.applied)}）`);
  assert.equal((await GET('/db')).transactions.find((/** @type {any} */ t) => t.id === 'f2').category, '娛樂',
    '另一家分店那筆不可以被動到');

  await seed();
  const strict = await (await POST('/statement/rename-store',
    { orig: A, name: A, category: '生活', subcategory: '日用品', applyAll: true })).json();
  assert.ok(strict.applied && strict.applied.changed > 0, '對照組：真的送 true 時要傳播得到（否則上面那半是空包彈）');
  assert.equal((await GET('/db')).transactions.find((/** @type {any} */ t) => t.id === 'f2').category, '生活',
    '對照組：另一家分店那筆要跟著改');
});

test('還原自動判斷的開關：送 1 → 當成一般改名、因為沒給顯示名而擋下（資料不動）；送 true 才還原', async () => {
  await seed();
  const loose = await POST('/statement/rename-store', { orig: A, reset: 1 });
  assert.equal(loose.status, 400, '不是 true 就不是「還原」，而是一般改名——沒給顯示名要擋下來');
  assert.equal((await GET('/db')).transactions.find((/** @type {any} */ t) => t.id === 'f1').category, '飲食',
    '擋下來就不可以動到任何一筆');

  const strict = await POST('/statement/rename-store', { orig: A, reset: true });
  assert.equal(strict.status, 200, '對照組：真的送 true 時要還原得成（否則上面那半是空包彈）');
});

test('清掉品牌規則的開關：送 1 → 品牌規則留著並回報給前端；送 true 才真的清掉', async () => {
  await seed();
  const loose = await (await POST('/statement/rename-store', { orig: A, reset: true, clearBrand: 1 })).json();
  assert.ok(loose.brandRule, '不是 true 就不可以清品牌規則——要留著並回報，讓使用者自己決定');
  assert.ok((await GET('/learned'))[storeKeyOf(A)], '品牌層那條學習規則要還在');

  await seed();
  const strict = await (await POST('/statement/rename-store', { orig: A, reset: true, clearBrand: true })).json();
  assert.equal(strict.brandRule, null, '對照組：真的送 true 時要清掉（否則上面那半是空包彈）');
  assert.ok(!(await GET('/learned'))[storeKeyOf(A)], '對照組：品牌層那條規則要不見');
});

test('清空全部略過的開關：送 \'x\' → 不清空（當成缺項目編號擋下）；送 true 才清空', async () => {
  await seed();
  const loose = await POST('/statement/health/dismiss', { clearAll: 'x' });
  assert.equal(loose.status, 400, '不是 true 就不是「清空全部」，而是缺了項目編號');
  assert.deepEqual(Object.keys((await GET('/db')).settings.healthDismissed), ['probe-1'], '略過清單不可以被清掉');

  const strict = await (await POST('/statement/health/dismiss', { clearAll: true })).json();
  assert.equal(strict.ok, true, '對照組：真的送 true 時要清得掉（否則上面那半是空包彈）');
  assert.deepEqual(Object.keys((await GET('/db')).settings.healthDismissed), [], '對照組：略過清單要空掉');
});

test('預覽的開關：送 1 → 不當成預覽（落到「維護端點要明確帶 force:true」那道擋）；送 true 才預覽', async () => {
  await seed();
  const loose = await POST('/statement/normalize-branches', { dryRun: 1 });
  assert.equal(loose.status, 400, '不是 true 就不是預覽；這條維護後門不可以被「像開」的值打開');

  const strict = await POST('/statement/normalize-branches', { dryRun: true });
  assert.equal(strict.status, 200, '對照組：真的送 true 時要預覽得到（否則上面那半是空包彈）');
});

/** 本族開關名：新開關要加進來，這道網才看得到它。 */
const FLAG_NAMES = ['force', 'dryRun', 'reset', 'clearAll', 'clearBrand', 'applyAll', 'stream', 'useAi'];

test('形狀題：lib/routes 底下這一族開關一律 === true／!== true 讀（解析器判定，註解裡寫什麼都不算數）', () => {
  const dir = new URL('../lib/routes/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 3, `路由目錄只掃到 ${files.length} 支檔案，掃描集合壞了`);
  /** @type {string[]} */
  const loose = [];
  let seen = 0;
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    /** @param {ts.Node} node */
    const walk = (node) => {
      if (ts.isPropertyAccessExpression(node) && FLAG_NAMES.includes(node.name.text)) {
        const root = node.expression.getText(sf).replace(/\s/g, '');
        if (root === 'req.body' || root === 'req.query') {
          seen++;
          const p = node.parent;
          const strict = ts.isBinaryExpression(p)
            && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)
            && (p.left === node ? p.right : p.left).kind === ts.SyntaxKind.TrueKeyword;
          if (!strict) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
            loose.push(`${f}:${line + 1} ${node.getText(sf)}`);
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  assert.ok(seen >= 6, `只找到 ${seen} 個本族開關的讀取點——掃描或名單壞了，這題會靜靜變空包彈`);
  assert.deepEqual(loose, [], '這些開關讀得太寬鬆（`!!x` 或直接當條件都算）：只有真正的 true 才可以算打開');
});
