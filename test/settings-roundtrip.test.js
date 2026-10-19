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
const repo = await import('../lib/repo.js');
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

const incomeSample = n => ({periodBasis:'ib-flex-single-statement-v1',from:'20260115',to:'20260320',dividends:n,paymentInLieu:2,count:1,skippedNoFx:0,skippedNoCurrency:0,estimatedNoFx:0});
async function freshIncome(n) {
  const db=repo.emptyDb();db.settings.ib.income=incomeSample(n);await repo.saveDb(db);
  return structuredClone(db.settings.ib.income);
}
const restore = body => fetch(`${base}/import`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('收入來源來回｜LOCAL 匯出與還原恢復同份收入，普通 PUT 真寫其他欄但不能改收入', async () => {
  const original=await freshIncome(91.25);
  const exported=await fetch(`${base}/export`);assert.equal(exported.status,200);
  const backup=await exported.json();assert.deepEqual(backup.settings.ib.income,original);
  await freshIncome(43);
  const restored=await restore(backup);assert.equal(restored.status,200,await restored.text());
  assert.deepEqual((await getSettings()).ib.income,original);
  const put=await putSettings({allocationDriftPct:7.25,ib:{income:{...incomeSample(999),periodBasis:'forged'}}});
  assert.equal(put.status,200);
  const after=await getSettings();assert.equal(after.allocationDriftPct,7.25);assert.deepEqual(after.ib.income,original);
});

test('收入來源來回｜非法 skippedNoCurrency 還原剝除，不以零取代；數字保存容忍不擴大為換算資格', async () => {
  for(const value of ['0',null,0,2,-1,1.5,undefined]) {
    await freshIncome(73);
    const income={...incomeSample(29.5),skippedNoCurrency:value};
    if(value===undefined)delete income.skippedNoCurrency;
    const response=await restore({settings:{ib:{income},allocationDriftPct:8.25}});
    assert.equal(response.status,200,await response.text());
    const settings=await getSettings();assert.equal(settings.allocationDriftPct,8.25);assert.equal(settings.ib.income.dividends,29.5);
    if(typeof value==='number')assert.equal(settings.ib.income.skippedNoCurrency,value);
    else assert.equal(Object.hasOwn(settings.ib.income,'skippedNoCurrency'),false);
    assert.equal(settings.ib.income.periodBasis,'ib-flex-single-statement-v1');
  }
});

test('收入來源來回｜未知或壞期間的備份不取得資格，合法舊日期也不生成標記', async () => {
  for(const over of [{periodBasis:'future'},{to:'20260231'},{periodBasis:undefined}]) {
    await freshIncome(17);
    const response=await restore({settings:{ib:{income:{...incomeSample(63),...over}}}});
    assert.equal(response.status,200,await response.text());
    const income=(await getSettings()).ib.income;assert.equal(income.dividends,63);assert.equal(Object.hasOwn(income,'periodBasis'),false);
  }
});

test('收入來源來回｜直接櫃檯拒絕壞數值並保留本題原庫', async () => {
  for(const skippedNoCurrency of ['0',null]) {
    await freshIncome(37);
    const before=await repo.getDb();const next=structuredClone(before);next.settings.ib.income.skippedNoCurrency=skippedNoCurrency;
    await assert.rejects(()=>repo.saveDb(next),/skippedNoCurrency/);
    assert.deepEqual(await repo.getDb(),before);
  }
});
