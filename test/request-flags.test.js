// @ts-check
// 請求旗標一律嚴格（William 2026-09-05 裁示）：body 送來的開關，只有**真正的 `true`** 才算「打開」。
//
// 為什麼要有這一份：同一族開關原本三種口徑（`!!x`／`x === true`／`if (x)`），寬鬆那幾個連字串 'false'
// 都算打開。其中一個開關管的是「同一家店的其他筆一起改分類」——誤開會一次改到很多筆，而畫面只會回報成功。
//
// 守兩層，射程各自寫清楚：
//   ①行為題：每個開關各一題——送「看起來像開、但不是 true」的值時，那個動作**真的沒發生**；
//     每題的對照組要證明送真正的 true 時那個動作**真的會發生**（只驗 HTTP 200 等於沒驗，見鐵則 9）。
//   ②形狀題：`lib/routes/` 底下遞迴的每一支 `.js`，本族開關名只能用 `=== true`／`!== true` 讀；
//     判定用解析器看語法樹，所以註解裡寫什麼都不算數（括號包住的等價寫法算合格）。
//     **這道網只看寫法、不看語意**，兩個已知盲區寫在這裡，不要拿它當保證：
//       ・控制流不看：`if (x !== true) 做事()` 形狀合格、意思卻相反——那種只有行為題抓得到。
//       ・取值寫法只認「`req.body`／`req.query` 直接取名」：先解構成區域變數、用中括號取值、
//         先存成別的變數再判斷，都看不到；新開關名沒加進名單也看不到（名單被拿掉既有名字這一種，
//         由「跟 true 嚴格比的欄位一定要在名單裡」那一行反向對帳擋）。
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
  /** 這題要看得到「還原」：先種一個自訂顯示名＋原文層學習規則，還原時它們要消失。 */
  const seedRenamed = async () => {
    await seed();
    const db = await getDb();
    for (const t of db.transactions) if (t.id === 'f1') t.note = '我取的名字';
    db.learnedCategories = { ...db.learnedCategories, [A]: { name: '我取的名字', category: '飲食', subcategory: '咖啡' } };
    await saveDb(db);
    assert.ok((await GET('/learned'))[A], '前提：原文層那條學習規則要先種得進去，還原才有東西可以清');
  };
  /** @param {string} id */
  const row = async (id) => (await GET('/db')).transactions.find((/** @type {any} */ t) => t.id === id);

  await seedRenamed();
  const loose = await POST('/statement/rename-store', { orig: A, reset: 1 });
  assert.equal(loose.status, 400, '不是 true 就不是「還原」，而是一般改名——沒給顯示名要擋下來');
  assert.equal((await row('f1')).note, '我取的名字', '擋下來就不可以動到那一筆的顯示名');
  assert.ok((await GET('/learned'))[A], '擋下來就不可以清掉原文層那條學習規則');

  await seedRenamed();
  const strict = await POST('/statement/rename-store', { orig: A, reset: true });
  assert.equal(strict.status, 200, '對照組：真的送 true 時要還原得成');
  assert.equal((await row('f1')).note, '星巴克', '對照組：顯示名要換回自動判斷的名字（只驗狀態碼證明不了有做事）');
  assert.ok(!(await GET('/learned'))[A], '對照組：原文層那條學習規則要被清掉');
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
  /** 這題要看得到「預覽算了東西」：身分鑰匙故意留成帳單原文（沒收斂成品牌），整理才會有得改。 */
  const seedUnnormalized = async () => {
    await seed();
    const db = await getDb();
    for (const t of db.transactions) { t.storeKey = t.id === 'f1' ? A : B; t.note = '我取的名字'; }
    await saveDb(db);
    assert.notEqual(A, storeKeyOf(A), '前提：原文與品牌鑰匙要不一樣，整理才有得算');
  };
  /** @returns {Promise<string[]>} */
  const keys = async () => (await GET('/db')).transactions.map((/** @type {any} */ t) => t.storeKey);

  await seedUnnormalized();
  const loose = await POST('/statement/normalize-branches', { dryRun: 1 });
  assert.equal(loose.status, 400, '不是 true 就不是預覽；這條維護後門不可以被「像開」的值打開');
  assert.deepEqual(await keys(), [A, B], '被擋下就一個字都不可以改');

  await seedUnnormalized();
  const res = await POST('/statement/normalize-branches', { dryRun: true });
  assert.equal(res.status, 200, '對照組：真的送 true 時要預覽得到');
  const strict = await res.json();
  assert.ok(strict.keyChanged > 0 && strict.changes?.length > 0,
    `對照組：預覽要真的算出東西來（實際 ${JSON.stringify(strict).slice(0, 120)}）——只驗狀態碼證明不了有做事`);
  assert.deepEqual(await keys(), [A, B], '對照組：預覽就是不可以寫進去');
});

/** 本族開關名：新開關要加進來，這道網才看得到它。 */
const FLAG_NAMES = ['force', 'dryRun', 'reset', 'clearAll', 'clearBrand', 'applyAll', 'stream', 'useAi'];

/** `lib/routes/` 底下遞迴的每一支 .js（相對路徑）。 @param {URL} dir @param {string} [prefix] @returns {string[]} */
function routeFiles(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...routeFiles(new URL(e.name + '/', dir), prefix + e.name + '/'));
    else if (e.name.endsWith('.js')) out.push(prefix + e.name);
  }
  return out;
}

test('形狀題：lib/routes 底下這一族開關一律 === true／!== true 讀（解析器判定，註解裡寫什麼都不算數）', () => {
  const dir = new URL('../lib/routes/', import.meta.url);
  const files = routeFiles(dir);
  assert.ok(files.length >= 3, `路由目錄只掃到 ${files.length} 支檔案，掃描集合壞了`);
  /** 括號不改變語意：`(x) === true` 與 `x === (true)` 都算嚴格。 @param {ts.Node} n */
  const inner = (n) => { let x = n; while (ts.isParenthesizedExpression(x)) x = x.expression; return x; };
  /** @param {ts.Node} n */
  const outer = (n) => { let x = n; while (x.parent && ts.isParenthesizedExpression(x.parent)) x = x.parent; return x; };
  /** @type {string[]} */
  const loose = [];
  /** @type {Record<string, number>} 每個開關名各被看到幾次——名單或掃描退化時抓得到 */
  const seen = Object.fromEntries(FLAG_NAMES.map((n) => [n, 0]));
  /** @type {Set<string>} 任何「拿 body 欄位跟 true 嚴格比」的欄位名（不看名單）——名單被拿掉一個名字時抓得到 */
  const strictish = new Set();
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    /** @param {ts.Node} node */
    const walk = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        const root = node.expression.getText(sf).replace(/\s/g, '');
        if (root === 'req.body' || root === 'req.query') {
          const self = outer(node), p = self.parent;
          const strict = ts.isBinaryExpression(p)
            && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(p.operatorToken.kind)
            && inner(p.left === self ? p.right : p.left).kind === ts.SyntaxKind.TrueKeyword;
          if (strict) strictish.add(node.name.text);
          if (FLAG_NAMES.includes(node.name.text)) {
            seen[node.name.text]++;
            if (!strict) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              loose.push(`${f}:${line + 1} ${node.getText(sf)}`);
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  // 逐名檢查而不是看總數：總數夠大掩蓋得住「其中一個名字再也對不到」（改寫法、改端點、名單打錯字）。
  assert.deepEqual(Object.entries(seen).filter(([, n]) => n === 0).map(([k]) => k), [],
    '名單裡有開關名在路由裡一個讀取點都找不到——不是那個端點沒了（請一起改名單），就是它改成了這道網看不到的寫法');
  // 反向對帳：跟 true 嚴格比的欄位就是開關，一定要在名單裡。名單被拿掉一個名字時，
  // 逐名檢查看不到（它不再被掃），但那個讀取點還在原地 ⇒ 這一行會紅。
  assert.deepEqual([...strictish].filter((k) => !FLAG_NAMES.includes(k)), [],
    '路由裡有欄位在跟 true 嚴格比，卻不在名單裡——它是本族開關就加進 FLAG_NAMES，否則逐名那道網會漏看它');
  assert.deepEqual(loose, [],
    '這些讀取點的**寫法**不是嚴格比較（`!!x`、直接當條件都算）。⚠️ 這一題只看寫法：`if (x !== true) 做事()`'
    + ' 這種形狀合格、意思相反的寫法它分不出來，那要靠同檔的行為題。');
});
