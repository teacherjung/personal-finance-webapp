// @ts-check
// 真考卷閘的行為考題：skipped 不是綠、冒名的同名 check 不算數、空窗與舊場次重跑都要被擋
//（設計依據見 scripts/check-ci-really-ran.js 檔頭；r1 高①②＝身分過濾與排序鍵的來歷）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateGate, isCheckRunList, isRequiredList } from '../scripts/check-ci-really-ran.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'check-ci-really-ran.js');

const NODE_JOB = '上線用的 Node（.node-version）';
const COLLAB_JOB = '協作欄位（實作者 ≠ 獨立審查者）';
const ACTIONS_APP = 15368;   // GitHub Actions 的 App id（考題常數；正式路徑從分支保護現場讀）
const REQ = [{ context: NODE_JOB, appId: ACTIONS_APP }, { context: COLLAB_JOB, appId: ACTIONS_APP }];

/** @param {string} name @param {string|null} conclusion @param {{at?:string, app?:number|null}} [o] @returns {import('../scripts/check-ci-really-ran.js').CheckRun} */
const run = (name, conclusion, o = {}) => ({
  name, conclusion,
  status: conclusion === null ? 'in_progress' : 'completed',
  completed_at: conclusion === null ? null : (o.at ?? '2026-08-15T00:00:00Z'),
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

test('真考卷閘｜同刻並列（r2）：completed_at 平手且結論不一致＝fail-closed，兩種陣列順序都擋', () => {
  // API 精度到秒、沒有欄位有「同刻誰晚」的契約保證（id 只承諾唯一）——同刻交集語意：
  // 最大 completed_at 的所有場次必須全 success；success＋skipped 並列＝結論不明＝擋。
  for (const order of [['skipped', 'success'], ['success', 'skipped']]) {
    const r = evaluateGate([
      run(NODE_JOB, /** @type {string} */ (order[0]), { at: '2026-08-15T01:00:00Z' }),
      run(NODE_JOB, /** @type {string} */ (order[1]), { at: '2026-08-15T01:00:00Z' }),
      run(COLLAB_JOB, 'success'),
    ], false, REQ);
    assert.equal(r.code, 1, `並列 ${order.join('+')} ＝不明＝擋（陣列順序不可承重）`);
  }
  // 對照：同刻全 success＝放行（例：重跑兩次都綠）
  const ok = evaluateGate([
    run(NODE_JOB, 'success', { at: '2026-08-15T01:00:00Z' }),
    run(NODE_JOB, 'success', { at: '2026-08-15T01:00:00Z' }),
    run(COLLAB_JOB, 'success'),
  ], false, REQ);
  assert.equal(ok.code, 0, ok.reason);
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

test('真考卷閘｜形狀驗證 fail-closed：completed_at 是承重欄、垃圾值不可混進排序（r2 新中①）', () => {
  assert.equal(isCheckRunList([{ name: 'x', status: 'completed', conclusion: 'success', completed_at: '2026-08-15T00:00:00Z', app_id: 15368 }]), true);
  assert.equal(isCheckRunList([{ name: 'x', status: 'in_progress', conclusion: null, completed_at: null, app_id: null }]), true);
  for (const bad of [null, {}, [{}],
    [{ name: 1, status: 'completed', conclusion: null, completed_at: null, app_id: null }],
    [{ name: 'x', status: 'completed', conclusion: 'success', app_id: null }],                                  // 缺 completed_at
    [{ name: 'x', status: 'completed', conclusion: 'success', completed_at: 42, app_id: null }],                // 數字
    [{ name: 'x', status: 'completed', conclusion: 'success', completed_at: 'z', app_id: null }],               // 垃圾字串
    [{ name: 'x', status: 'completed', conclusion: null, completed_at: '2026-08-15T00:00:00Z', app_id: null }], // completed 卻沒結論
    [{ name: 'x', status: 'in_progress', conclusion: null, completed_at: '2026-08-15T00:00:00Z', app_id: null }], // 沒跑完卻有時間
    [{ name: 'x', status: 'completed', conclusion: 'success', completed_at: '2026-08-15T00:00:00Z', app_id: '15368' }]]) {
    assert.equal(isCheckRunList(/** @type {any} */ (bad)), false, `${JSON.stringify(bad)} 要被形狀驗證拒絕`);
  }
  assert.equal(isRequiredList([{ context: 'x', appId: 15368 }, { context: 'y', appId: null }]), true);
  for (const bad of [null, [{}], [{ context: '', appId: 1 }], [{ context: 'x', appId: '15368' }]]) {
    assert.equal(isRequiredList(/** @type {any} */ (bad)), false, `${JSON.stringify(bad)} 要被名單形狀驗證拒絕`);
  }
});

// ---- 端到端（假 gh，走真的 PATH 解析；merge-gate r3 同款）---------------------------------
// 假 gh 對**完整 argv 整串比對**：腳本呼叫 gh 的形狀（--paginate、per_page、jq 的投影欄位
// completed_at／app.id、分支保護端點）是契約的一部分——任何漂移（jq 換回 started_at、拿掉
// --paginate、名單改硬編＝根本不打保護端點）＝假 gh 退出 65 或劇本對不上＝考題紅（r2#1/#2 的
// 「CLI 接縫無守門」正是這裡在關）。

const VIEW_ARGV = 'pr view 999 --json headRefOid,autoMergeRequest';
const PROT_ARGV = "api repos/{owner}/{repo}/branches/main/protection/required_status_checks --jq [.checks[] | { context, appId: (if (.app_id // -1) < 0 then null else .app_id end) }]";
const SHA = 'a'.repeat(40);
const RUNS_ARGV = `api --paginate repos/{owner}/{repo}/commits/${SHA}/check-runs?per_page=100 --jq [.check_runs[] | { name, status, conclusion, completed_at, app_id: (.app.id // null) }]`;

/** @param {{ view?: object, prot?: string, pages?: string }} sc */
function runCli(sc) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-cirr-'));
  writeFileSync(join(dir, 'gh'),
    '#!/bin/sh\n'
    + 'if [ "$1 $2" = "pr view" ]; then\n'
    + '  if [ "$*" != "$GH_EXPECT_VIEW" ]; then echo "fake gh: unexpected view argv: $*" >&2; exit 65; fi\n'
    + '  printf %s "$GH_VIEW"; exit 0\n'
    + 'fi\n'
    + 'if [ "$1" = "api" ] && [ "$2" != "--paginate" ]; then\n'
    + '  if [ "$*" != "$GH_EXPECT_PROT" ]; then echo "fake gh: unexpected protection argv: $*" >&2; exit 65; fi\n'
    + '  printf %s "$GH_PROT"; exit 0\n'
    + 'fi\n'
    + 'if [ "$1 $2" = "api --paginate" ]; then\n'
    + '  if [ "$*" != "$GH_EXPECT_RUNS" ]; then echo "fake gh: unexpected check-runs argv: $*" >&2; exit 65; fi\n'
    + '  printf %s "$GH_PAGES"; exit 0\n'
    + 'fi\n'
    + 'exit 64\n');
  chmodSync(join(dir, 'gh'), 0o755);
  return spawnSync(process.execPath, [SCRIPT, '999'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
      GH_EXPECT_VIEW: VIEW_ARGV, GH_EXPECT_PROT: PROT_ARGV, GH_EXPECT_RUNS: RUNS_ARGV,
      GH_VIEW: JSON.stringify(sc.view ?? { headRefOid: SHA, autoMergeRequest: null }),
      GH_PROT: sc.prot ?? '[]',
      GH_PAGES: sc.pages ?? '' },
  });
}

const PROT2 = JSON.stringify([{ context: NODE_JOB, appId: ACTIONS_APP }, { context: COLLAB_JOB, appId: ACTIONS_APP }]);
/** @param {object[]} arr */
const page = (arr) => JSON.stringify(arr);
const okRun = (/** @type {string} */ name) => ({ name, status: 'completed', conclusion: 'success', completed_at: '2026-08-15T01:00:00Z', app_id: ACTIONS_APP });

test('閘·端到端｜快樂路徑：保護兩格＋兩場真 success → 退出碼 0（argv 整串鎖住 jq 投影與 --paginate）', () => {
  const r = runCli({ prot: PROT2, pages: page([okRun(NODE_JOB), okRun(COLLAB_JOB)]) });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('閘·端到端｜名單真的來自分支保護（r2#1）：保護多一格「新來的門」→ 退出碼 2（硬編名單＝這裡綠不了）', () => {
  const prot3 = JSON.stringify([{ context: NODE_JOB, appId: ACTIONS_APP }, { context: COLLAB_JOB, appId: ACTIONS_APP }, { context: '新來的門', appId: ACTIONS_APP }]);
  const r = runCli({ prot: prot3, pages: page([okRun(NODE_JOB), okRun(COLLAB_JOB)]) });
  assert.equal(r.status, 2, '保護新增 required check 必須被驗到——名單若硬編兩個名字，這一格會退 0＝假綠');
});

test('閘·端到端｜app 身分經 CLI 進判斷層（r2#1）：保護釘 15368、場次是別的 App → 退出碼 2', () => {
  const spoof = { name: NODE_JOB, status: 'completed', conclusion: 'success', completed_at: '2026-08-15T01:00:00Z', app_id: 99999 };
  const r = runCli({ prot: PROT2, pages: page([spoof, okRun(COLLAB_JOB)]) });
  assert.equal(r.status, 2, '冒名場次不是正牌——appId 若在接縫被降成 null，這一格會退 0＝假綠');
});

test('閘·端到端｜分頁合併真的發生（r2#2）：required 的 success 在第二頁 → 退出碼 0；只讀第一頁＝會退 2', () => {
  const pages = page([okRun(NODE_JOB)]) + '\n' + page([okRun(COLLAB_JOB)]);
  const r = runCli({ prot: PROT2, pages });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('閘·端到端｜skipped 與 auto-merge 走完整 CLI：各退 1', () => {
  const skipped = { name: NODE_JOB, status: 'completed', conclusion: 'skipped', completed_at: '2026-08-15T02:00:00Z', app_id: ACTIONS_APP };
  const r1 = runCli({ prot: PROT2, pages: page([okRun(NODE_JOB), skipped, okRun(COLLAB_JOB)]) });
  assert.equal(r1.status, 1, '最新 skipped＝退 1');
  const r2 = runCli({ view: { headRefOid: SHA, autoMergeRequest: { enabledAt: 'x' } }, prot: PROT2, pages: page([okRun(NODE_JOB), okRun(COLLAB_JOB)]) });
  assert.equal(r2.status, 1, 'auto-merge 開著＝退 1');
});

test('閘·端到端｜fail-closed 三態：保護回錯形狀／check runs 錯形狀／sha 讀不到 → 都退 2', () => {
  assert.equal(runCli({ prot: '{}', pages: page([okRun(NODE_JOB), okRun(COLLAB_JOB)]) }).status, 2);
  assert.equal(runCli({ prot: PROT2, pages: '[{"name":"x"}]' }).status, 2);
  assert.equal(runCli({ view: { headRefOid: 'short', autoMergeRequest: null }, prot: PROT2, pages: '' }).status, 2);
});