// @ts-check
// 真考卷閘的行為考題：skipped 不是綠、空窗與舊場次重跑都要被擋（設計依據見 scripts/check-ci-really-ran.js 檔頭）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { evaluateGate, isCheckRunList, REQUIRED_CHECK_NAMES } from '../scripts/check-ci-really-ran.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_JOB = '上線用的 Node（.node-version）';
const COLLAB_JOB = '協作欄位（實作者 ≠ 獨立審查者）';

/** @param {string} name @param {string|null} conclusion @param {string} [at] @returns {import('../scripts/check-ci-really-ran.js').CheckRun} */
const run = (name, conclusion, at = '2026-08-15T00:00:00Z') =>
  ({ name, conclusion, status: conclusion === null ? 'in_progress' : 'completed', started_at: at });

test('真考卷閘｜兩個 required 都真 success＋auto-merge 關＝放行', () => {
  const r = evaluateGate([run(NODE_JOB, 'success'), run(COLLAB_JOB, 'success')], false);
  assert.equal(r.code, 0, r.reason);
});

test('真考卷閘｜skipped 不是綠：草稿期跳過的場次不放行（GitHub 視同滿足、這裡不買帳）', () => {
  const r = evaluateGate([run(NODE_JOB, 'skipped'), run(COLLAB_JOB, 'success')], false);
  assert.equal(r.code, 1);
  assert.ok(r.reason.includes('skipped'), '★理由要點名 skipped＝草稿跳過');
});

test('真考卷閘｜同名多場次取最新：真跑成功後被舊草稿場次重跑蓋 skipped＝擋（Grok 預審【高】②）', () => {
  // 真跑 success（早）→ Re-run 舊草稿場次用凍結的 draft:true payload 再蓋一筆 skipped（晚）
  const r = evaluateGate([
    run(NODE_JOB, 'success', '2026-08-15T01:00:00Z'),
    run(NODE_JOB, 'skipped', '2026-08-15T02:00:00Z'),
    run(COLLAB_JOB, 'success'),
  ], false);
  assert.equal(r.code, 1, '最新場次是 skipped＝required check 的實況、不可拿舊 success 頂');
  // 反向：skipped（早）→ 轉正式真跑 success（晚）＝放行
  const ok = evaluateGate([
    run(NODE_JOB, 'skipped', '2026-08-15T01:00:00Z'),
    run(NODE_JOB, 'success', '2026-08-15T02:00:00Z'),
    run(COLLAB_JOB, 'success'),
  ], false);
  assert.equal(ok.code, 0, ok.reason);
});

test('真考卷閘｜空窗防線：required check 一場都沒有＝fail-closed 退 2；還在跑＝退 1 等它', () => {
  const none = evaluateGate([run(COLLAB_JOB, 'success')], false);
  assert.equal(none.code, 2, '轉正式後 run 還沒建立的空窗＝查不到＝不安全');
  const running = evaluateGate([run(NODE_JOB, null), run(COLLAB_JOB, 'success')], false);
  assert.equal(running.code, 1, '在跑＝等，不是紅也不是綠');
});

test('真考卷閘｜auto-merge 開著＝直接擋（空窗洞的自動化版本，人手都不用按）', () => {
  const r = evaluateGate([run(NODE_JOB, 'success'), run(COLLAB_JOB, 'success')], true);
  assert.equal(r.code, 1);
  assert.ok(r.reason.includes('auto-merge'));
});

test('真考卷閘｜failure／cancelled 一律不放行（cancel-in-progress 取消的場次不是綠）', () => {
  for (const c of ['failure', 'cancelled', 'timed_out']) {
    assert.equal(evaluateGate([run(NODE_JOB, c), run(COLLAB_JOB, 'success')], false).code, 1, `conclusion=${c} 要擋`);
  }
});

test('真考卷閘｜形狀驗證 fail-closed：合法但錯形的 JSON 不可幻化成放行', () => {
  assert.equal(isCheckRunList([{ name: 'x', status: 'completed', conclusion: 'success' }]), true);
  for (const bad of [null, {}, [{}], [{ name: 1, status: 'completed', conclusion: null }], [{ name: 'x', status: 'completed', conclusion: 7 }]]) {
    assert.equal(isCheckRunList(/** @type {any} */ (bad)), false, `${JSON.stringify(bad)} 要被形狀驗證拒絕`);
  }
});

test('真考卷閘｜REQUIRED_CHECK_NAMES 與 workflow 的 job name 機械互扣（改名必紅、兩邊一起改）', () => {
  /** @type {string[]} */
  const jobNames = [];
  for (const f of ['ci.yml', 'collab-fields.yml']) {
    for (const m of readFileSync(join(ROOT, '.github/workflows', f), 'utf8').matchAll(/^[ \t]{2,8}name:\s*(.+)$/gm)) jobNames.push(m[1].trim());
  }
  for (const name of REQUIRED_CHECK_NAMES) {
    assert.ok(jobNames.includes(name), `閘名單裡的「${name}」不在 workflow 的 job name 裡——改名要兩邊一起`);
  }
  assert.ok(!REQUIRED_CHECK_NAMES.includes('開發機的 Node（最新版，前瞻｜不擋部署）'),
    'dev-machine 是前瞻燈不是門（continue-on-error）——不可以被拉進 required 名單');
});
