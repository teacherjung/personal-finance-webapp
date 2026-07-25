// 個股研究頁 P2：research 深層資料契約、同代號唯一性與備份匯入 fail-closed。
// STORE_FILE 指向暫存 SQLite，所有資料皆為合成資料，絕不碰真實 store。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { once } from 'node:events';

const TEST_STORE = join(tmpdir(), `finance-stock-research-p2-${process.pid}.db`);
process.env.STORE_FILE = TEST_STORE;

const {
  pickWritable, validateImportItem, sanitizeDbForWrite, duplicateResearchSymbols
} = await import('../lib/schema.js');
const store = await import('../lib/store.js');
const { app } = await import('../server.js');
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}/api`;

after(() => {
  server.close();
  for (const suffix of ['', '.bak', '-wal', '-shm', '.json']) {
    try { rmSync(TEST_STORE + suffix); } catch { /* 可能不存在 */ }
  }
});

/** @param {string} path @param {string} method @param {any} body */
async function send(path, method, body) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

function fullResearch(symbol = ' aapl ') {
  return {
    symbol,
    thesis: '服務營收與生態系黏著度能支撐長期現金流',
    metrics: '服務營收成長、毛利率、回購',
    risks: '估值與市場風險',
    status: 'valid',
    lastReviewedAt: '2026-07-24',
    scorecard: {
      business: 4,
      financial: 5,
      valuation: 0,
      evidence: 3,
      risk: 4,
      reasons: {
        business: '生態系黏著度仍高',
        financial: '現金流穩健',
        valuation: '估值沒有安全邊際',
        evidence: '服務成長支持',
        risk: '部位仍在上限內'
      }
    },
    valuationScenarios: {
      currency: 'USD',
      asOf: '2026-07-24',
      method: '情境估值',
      bear: 160,
      base: 205,
      bull: 250,
      assumptions: '手動填寫'
    },
    catalysts: [{ id: 'c1', text: '服務營收加速', horizon: '2026 H2', status: 'watching' }],
    thesisBreakers: [{ id: 'b1', text: '服務營收連續兩季低於預期', status: 'watching' }],
    watchMetrics: [{ id: 'm1', label: '服務營收成長率', unit: '%', value: null, period: '2026 Q2', source: '手動' }],
    sources: [{ id: 's1', label: '2026 Q2 10-Q', url: 'https://example.com/report', asOf: '2026-07-24' }],
    checkpoints: [
      { date: '2026-07', note: '舊月份格式仍合法' },
      { date: '2026-07-24', note: '新完整日期也合法' }
    ],
    scoreHistory: [{
      date: '2026-07-24',
      total: 68,
      scores: { business: 4, financial: 5, valuation: 0, evidence: 3, risk: 4 }
    }]
  };
}

test('research 深層契約：完整新資料可寫、代號正規化，0 分與缺值 null 都保留', () => {
  const { value, errors } = pickWritable('research', fullResearch());
  assert.deepEqual(errors, []);
  assert.equal(value.symbol, 'AAPL');
  assert.equal(value.scorecard.valuation, 0, '0 分是合法評分，不可當未填');
  assert.equal(value.watchMetrics[0].value, null, '缺指標值用 null，不可偷偷改成 0');
  assert.equal(value.checkpoints[0].date, '2026-07', '舊 YYYY-MM 檢查點保持合法');
  assert.equal(value.checkpoints[1].date, '2026-07-24');
});

test('research 深層契約：舊筆沒有新欄位仍合法，不需搬家', () => {
  const old = {
    id: 'old-r',
    symbol: 'googl',
    thesis: '既有論點',
    metrics: '既有指標',
    risks: '既有風險',
    checkpoints: [{ date: '2026-07', note: '舊資料' }]
  };
  const checked = validateImportItem('research', old);
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.item.symbol, 'GOOGL');
  assert.deepEqual(checked.item.checkpoints, old.checkpoints);
});

test('research 深層契約：錯狀態、假日期、越界分數、非物件元素與 javascript URL 全部明確報錯', () => {
  const bad = fullResearch();
  bad.status = 'valid-ish';
  bad.lastReviewedAt = '2026-02-30';
  bad.scorecard.business = 6;
  bad.valuationScenarios.currency = 'EUR';
  bad.catalysts = [null];
  bad.thesisBreakers[0].status = 'broken';
  bad.sources[0].url = 'javascript:alert(1)';
  bad.scoreHistory[0].scores.risk = -1;
  const { errors } = pickWritable('research', bad);
  for (const path of [
    'status', 'lastReviewedAt', 'scorecard.business', 'valuationScenarios.currency',
    'catalysts[0]', 'thesisBreakers[0].status', 'sources[0].url', 'scoreHistory[0].scores.risk'
  ]) assert.ok(errors.includes(path), `應點名 ${path}，實際：${errors.join(', ')}`);
});

test('research 深層契約：原型鍵與巢狀未知鍵不能穿過資料牆', () => {
  const bad = JSON.parse('{"symbol":"constructor","scorecard":{"business":4,"__proto__":{"polluted":true}}}');
  const { errors } = pickWritable('research', bad);
  assert.ok(errors.includes('symbol'));
  assert.ok(errors.includes('scorecard.__proto__'));
  assert.equal({}.polluted, undefined);
});

test('store.save 最後櫃檯：巢狀壞資料在 throw 模式擋下；strip 只清壞欄、保留合法研究', () => {
  const bad = fullResearch('MSFT');
  bad.sources[0].url = 'javascript:alert(1)';
  const db = { ...store.emptyDb(), research: [bad] };
  assert.throws(() => sanitizeDbForWrite(db, { mode: 'throw' }), /sources\[0\]\.url/);
  const stripped = sanitizeDbForWrite(db, { mode: 'strip' });
  assert.equal(stripped.research.length, 1);
  assert.equal(stripped.research[0].symbol, 'MSFT');
  assert.equal('url' in stripped.research[0].sources[0], false);
});

test('研究集合的同代號判斷：忽略大小寫與前後空白，不把不同代號誤判重複', () => {
  assert.deepEqual(duplicateResearchSymbols([
    { symbol: 'AAPL' }, { symbol: ' aapl ' }, { symbol: 'GOOGL' }
  ]), ['AAPL']);
  assert.deepEqual(duplicateResearchSymbols([{ symbol: 'AAPL' }, { symbol: 'GOOGL' }]), []);
  const duplicateDb = {
    ...store.emptyDb(),
    research: [{ symbol: 'AAPL', thesis: '版本一' }, { symbol: ' aapl ', thesis: '版本二' }]
  };
  assert.throws(
    () => sanitizeDbForWrite(duplicateDb, { mode: 'throw' }),
    /research 有重複代號：AAPL/,
    '最後櫃檯不可放過重複研究'
  );
  assert.throws(
    () => sanitizeDbForWrite(duplicateDb, { mode: 'strip' }),
    /research 有重複代號：AAPL/,
    '搬家也不可任選一筆研究丟棄'
  );
});

test('POST /api/research：合法研究可新增；同代號不同大小寫回 400 且不多寫一筆', async () => {
  store.save({ ...store.emptyDb(), research: [] });
  const first = await send('/research', 'POST', fullResearch(' aapl '));
  assert.equal(first.response.status, 200);
  assert.equal(first.body.symbol, 'AAPL');

  const duplicate = await send('/research', 'POST', { symbol: 'AaPl', thesis: '另一份' });
  assert.equal(duplicate.response.status, 400);
  assert.match(duplicate.body.error, /已有研究資料.*改用編輯/);
  assert.equal(store.load().research.length, 1, '重複 POST 不能留下第二筆');
});

test('PUT /api/research：改代號撞到另一筆回 400，兩筆原資料保持不變', async () => {
  store.save({ ...store.emptyDb(), research: [
    { id: 'r-a', symbol: 'AAPL', thesis: '蘋果' },
    { id: 'r-g', symbol: 'GOOGL', thesis: '谷歌' }
  ] });
  const result = await send('/research/r-g', 'PUT', { symbol: ' aapl ', thesis: '不該寫入' });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /已有研究資料/);
  assert.deepEqual(store.load().research.map(r => [r.symbol, r.thesis]), [
    ['AAPL', '蘋果'], ['GOOGL', '谷歌']
  ]);
});

test('CRUD 壞巢狀資料：回 400 且不寫入', async () => {
  store.save({ ...store.emptyDb(), research: [] });
  const bad = fullResearch('MSFT');
  bad.scorecard.business = '5';
  const result = await send('/research', 'POST', bad);
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /scorecard\.business/);
  assert.equal(store.load().research.length, 0);
});

test('/api/import：同代號重複或壞巢狀欄位都整份 400，既有資料不被覆蓋', async () => {
  const baseline = { id: 'keep', symbol: 'KEEP', thesis: '必須保留' };
  store.save({ ...store.emptyDb(), research: [baseline] });

  const duplicateBackup = {
    ...store.emptyDb(),
    research: [{ id: 'a', symbol: 'AAPL' }, { id: 'b', symbol: ' aapl ' }]
  };
  const duplicate = await send('/import', 'POST', duplicateBackup);
  assert.equal(duplicate.response.status, 400);
  assert.match(duplicate.body.error, /同一代號重複.*AAPL/);
  assert.deepEqual(store.load().research, [baseline]);

  const invalidBackup = { ...store.emptyDb(), research: [fullResearch('MSFT')] };
  invalidBackup.research[0].sources[0].url = 'javascript:alert(1)';
  const invalid = await send('/import', 'POST', invalidBackup);
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.body.error, /sources\[0\]\.url/);
  assert.deepEqual(store.load().research, [baseline]);
});
