// @ts-check
// 真考卷閘的行為考題：skipped 不是綠、冒名的同名 check 不算數、空窗與舊場次重跑都要被擋
//（設計依據見 scripts/check-ci-really-ran.js 檔頭；r1 高①②＝身分過濾與排序鍵的來歷）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate, isCheckRunList, isRequiredList } from '../scripts/check-ci-really-ran.js';

const NODE_JOB = '上線用的 Node（.node-version）';
const COLLAB_JOB = '協作欄位（實作者 ≠ 獨立審查者）';
const ACTIONS_APP = 15368;   // GitHub Actions 的 App id（考題常數；正式路徑從分支保護現場讀）
const REQ = [{ context: NODE_JOB, appId: ACTIONS_APP }, { context: COLLAB_JOB, appId: ACTIONS_APP }];

let seq = 0;
/** @param {string} name @param {string|null} conclusion @param {{at?:string, app?:number|null, id?:number}} [o] @returns {import('../scripts/check-ci-really-ran.js').CheckRun} */
const run = (name, conclusion, o = {}) => ({
  name, conclusion,
  status: conclusion === null ? 'in_progress' : 'completed',
  completed_at: conclusion === null ? null : (o.at ?? '2026-08-15T00:00:00Z'),
  id: o.id ?? ++seq,
  app_id: o.app === undefined ? ACTIONS_APP : o.app,
});

test('真考卷閘｜兩個 required 都真 success＋auto-merge 關＝放行', () => {
  const r = evaluateGate([run(NODE_JOB, 'success'), run(COLLAB_JOB, 'success')], false, REQ);
  assert.equal(r.code, 0, r.reason);
});

test('真考卷閘｜skipped 不是綠：草稿期跳過的場次不放行（GitHub 視同滿足、這裡不買帳）', () => {
  const r = evaluateGate([run(NODE_JOB, 'skipped'), run(COLLAB_JOB, 'success')], false, REQ);
  assert.equal(r.code, 1);
  assert.ok(r.reason.includes('skipped'), '★理由要點名 skipped＝草稿跳過');
});

test('真考卷閘｜冒名不算數（r1 高①）：別的 App 貼同名 success 不能替真考卷放行', () => {
  // 只有冒名場次＝找不到正牌＝fail-closed 退 2
  const spoofOnly = evaluateGate([run(NODE_JOB, 'success', { app: 99999 }), run(COLLAB_JOB, 'success')], false, REQ);
  assert.equal(spoofOnly.code, 2, '冒名 App 的同名 success 不是正牌場次');
  // 冒名 success（較晚）＋正牌 skipped（較早）＝看正牌＝拒
  const spoofPlus = evaluateGate([
    run(NODE_JOB, 'skipped', { at: '2026-08-15T01:00:00Z' }),
    run(NODE_JOB, 'success', { at: '2026-08-15T02:00:00Z', app: 99999 }),
    run(COLLAB_JOB, 'success'),
  ], false, REQ);
  assert.equal(spoofPlus.code, 1, '正牌最新是 skipped＝拒；冒名的 success 不得參與排序');
  // 保護自己寫 appId=null＝任何來源都算（那是保護的選擇）
  const anyApp = evaluateGate([run(NODE_JOB, 'success', { app: 99999 }), run(COLLAB_JOB, 'success')], false,
    [{ context: NODE_JOB, appId: null }, { context: COLLAB_JOB, appId: ACTIONS_APP }]);
  assert.equal(anyApp.code, 0, anyApp.reason);
});

test('真考卷閘｜required 名單動態（r1 高①）：空名單＝fail-closed；名單多一條就多驗一條', () => {
  assert.equal(evaluateGate([run(NODE_JOB, 'success')], false, []).code, 2, '保護名單空＝不安全');
  const extra = [...REQ, { context: '新來的門', appId: ACTIONS_APP }];
  const r = evaluateGate([run(NODE_JOB, 'success'), run(COLLAB_JOB, 'success')], false, extra);
  assert.equal(r.code, 2, '保護新增 required check 時不得靜默漏查');
});

test('真考卷閘｜同名多場次取最新（completed_at＋id，r1 高②）：真跑成功後被舊草稿場次重跑蓋 skipped＝擋', () => {
  const r = evaluateGate([
    run(NODE_JOB, 'success', { at: '2026-08-15T01:00:00Z' }),
    run(NODE_JOB, 'skipped', { at: '2026-08-15T02:00:00Z' }),
    run(COLLAB_JOB, 'success'),
  ], false, REQ);
  assert.equal(r.code, 1, '最新場次是 skipped＝required check 的實況、不可拿舊 success 頂');
  const ok = evaluateGate([
    run(NODE_JOB, 'skipped', { at: '2026-08-15T01:00:00Z' }),
    run(NODE_JOB, 'success', { at: '2026-08-15T02:00:00Z' }),
    run(COLLAB_JOB, 'success'),
  ], false, REQ);
  assert.equal(ok.code, 0, ok.reason);
});

test('真考卷閘｜非單調時間（r1 高②實測）：completed_at 同刻以 id 決勝、陣列順序不可承重', () => {
  // 兩場 completed_at 相同、**skipped 排在陣列前面**（id 較大＝較晚建立）：
  // 若拿掉 id 決勝，穩定排序會讓陣列末位的 success 勝出＝假綠——這一格逼 id 真的承重。
  const r = evaluateGate([
    run(NODE_JOB, 'skipped', { at: '2026-08-15T01:00:00Z', id: 200 }),
    run(NODE_JOB, 'success', { at: '2026-08-15T01:00:00Z', id: 100 }),
    run(COLLAB_JOB, 'success'),
  ], false, REQ);
  assert.equal(r.code, 1, 'completed_at 平手＝id 大者為準（全域遞增＝晚建立）；陣列順序不算數');
});

test('真考卷閘｜空窗防線：正牌一場都沒有＝fail-closed 退 2；任一場還在跑＝退 1 等它', () => {
  const none = evaluateGate([run(COLLAB_JOB, 'success')], false, REQ);
  assert.equal(none.code, 2, '轉正式後 run 還沒建立的空窗＝查不到＝不安全');
  // 舊 success 已完成＋新場次在跑（例：轉正式後的真考卷正在跑）：**必須等**、不可拿舊綠搶跑放行——
  // 若拿掉「在跑＝等」檢查，這一格會變 code 0（舊 success 勝出）＝假綠承重域。
  const running = evaluateGate([
    run(NODE_JOB, 'success', { at: '2026-08-15T01:00:00Z' }),
    run(NODE_JOB, null),
    run(COLLAB_JOB, 'success'),
  ], false, REQ);
  assert.equal(running.code, 1, '有場次在跑＝等（不可拿已完成的舊 success 搶跑放行）');
  assert.ok(running.reason.includes('還在跑'), '★理由要是「等」、不是誤判成紅');
});

test('真考卷閘｜auto-merge 開著＝直接擋（空窗洞的自動化版本，人手都不用按）', () => {
  const r = evaluateGate([run(NODE_JOB, 'success'), run(COLLAB_JOB, 'success')], true, REQ);
  assert.equal(r.code, 1);
  assert.ok(r.reason.includes('auto-merge'));
});

test('真考卷閘｜failure／cancelled 一律不放行（cancel-in-progress 取消的場次不是綠）', () => {
  for (const c of ['failure', 'cancelled', 'timed_out']) {
    assert.equal(evaluateGate([run(NODE_JOB, c), run(COLLAB_JOB, 'success')], false, REQ).code, 1, `conclusion=${c} 要擋`);
  }
});

test('真考卷閘｜形狀驗證 fail-closed：合法但錯形的 JSON 不可幻化成放行', () => {
  assert.equal(isCheckRunList([{ name: 'x', status: 'completed', conclusion: 'success', completed_at: 'z', id: 1, app_id: 15368 }]), true);
  for (const bad of [null, {}, [{}], [{ name: 1, status: 'completed', conclusion: null, id: 1, app_id: null }],
    [{ name: 'x', status: 'completed', conclusion: 'success', id: '1', app_id: null }],
    [{ name: 'x', status: 'completed', conclusion: 'success', id: 1, app_id: '15368' }]]) {
    assert.equal(isCheckRunList(/** @type {any} */ (bad)), false, `${JSON.stringify(bad)} 要被形狀驗證拒絕`);
  }
  assert.equal(isRequiredList([{ context: 'x', appId: 15368 }, { context: 'y', appId: null }]), true);
  for (const bad of [null, [{}], [{ context: '', appId: 1 }], [{ context: 'x', appId: '15368' }]]) {
    assert.equal(isRequiredList(/** @type {any} */ (bad)), false, `${JSON.stringify(bad)} 要被名單形狀驗證拒絕`);
  }
});
