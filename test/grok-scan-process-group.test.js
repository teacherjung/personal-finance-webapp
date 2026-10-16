// @ts-check
// Node 的考題檔在獨立程序執行；本檔攔下所有 kill 與 timer，不向假 PID 送真訊號。
// 先記錄每個呼叫再核序列，避免未排定的 mock 錯被 helper 包住後讓負控假綠。
import test from 'node:test';
import assert from 'node:assert/strict';
import { killGroupAndWait } from '../scripts/grok-scan.js';

const PGID = 987654321;
const KILL = 'SIGKILL';
/** @typedef {{signal: 'SIGKILL' | 0, error?: Error} | {wait: number}} Step */
/** @param {string} code */
const fault = (code) => Object.assign(new Error(`synthetic ${code}`), { code });
/** @param {'SIGKILL' | 0} signal @param {Error} [error] @returns {Step} */
const call = (signal, error) => ({ signal, error });
/** @returns {Step} */
const wait = () => ({ wait: 50 });
/** @param {number} count @returns {Step[]} */
const living = (count) => Array.from({ length: count }, () => [call(KILL), call(0), wait()]).flat();
/** @param {Step} step */
const event = (step) => 'wait' in step ? ['wait', step.wait] : ['kill', -PGID, step.signal];

/**
 * @param {import('node:test').TestContext} t
 * @param {Step[]} script
 * @param {{expected?: Step[], pgid?: number | null}} [options]
 */
async function observe(t, script, { expected = script, pgid = PGID } = {}) {
  /** @type {unknown[][]} */ const events = [];
  let cursor = 0;
  t.mock.method(process, 'kill', (pid, signal) => {
    events.push(['kill', pid, signal]);
    assert.equal(pid, -PGID, 'mock 不准把其他目標交給真 kill');
    const step = script[cursor++];
    assert.ok(step && 'signal' in step, '出現未排定的 kill');
    assert.equal(signal, step.signal);
    if (step.error) throw step.error;
    return true;
  });
  t.mock.method(globalThis, 'setTimeout', (callback, ms) => {
    events.push(['wait', ms]);
    const step = script[cursor++];
    assert.ok(step && 'wait' in step, '出現未排定的等待');
    assert.equal(ms, step.wait);
    callback();
    return /** @type {ReturnType<typeof setTimeout>} */ ({});
  });
  /** @type {unknown} */ let failure;
  try { await killGroupAndWait(pgid); } catch (e) { failure = e; }
  assert.deepEqual(events, expected.map(event), 'helper 未走完預定序列，或多作了查詢／等待／破壞性訊號');
  assert.equal(cursor, expected.length);
  return { failure, waits: events.filter(([kind]) => kind === 'wait').length };
}

/** @param {unknown} failure @param {Error} cause */
function refused(failure, cause) {
  assert.ok(failure instanceof Error, '未知或失敗被當成群組已空');
  assert.equal(failure.cause, cause, '最早 cause 被後續錯誤洗掉');
}

for (const pgid of [null, 0]) test(`群組等待｜空目標 ${pgid} 不發訊號`, async (t) => {
  assert.equal((await observe(t, [], { pgid })).failure, undefined);
});

test('群組等待｜SIGKILL 直接 ESRCH 保留原成功線', async (t) => {
  assert.equal((await observe(t, [call(KILL, fault('ESRCH'))])).failure, undefined);
});

for (const code of ['EPERM', 'EINVAL']) test(`群組等待｜SIGKILL ${code} 立即拒絕，不查不等`, async (t) => {
  const first = fault(code);
  refused((await observe(t, [call(KILL, first)])).failure, first);
});

test('群組等待｜SIGKILL 成功後 signal0 ESRCH 不等待', async (t) => {
  assert.equal((await observe(t, [call(KILL), call(0, fault('ESRCH'))])).failure, undefined);
});

test('群組等待｜首個 signal0 非 EPERM 錯誤立即拒絕', async (t) => {
  const first = fault('EINVAL');
  refused((await observe(t, [call(KILL), call(0, first)])).failure, first);
});

test('群組等待｜unknown 等待後取得 ESRCH 才成功', async (t) => {
  const r = await observe(t, [call(KILL), call(0, fault('EPERM')), wait(), call(0, fault('ESRCH'))]);
  assert.equal(r.failure, undefined);
  assert.equal(r.waits, 1);
});

test('群組等待｜unknown 第三次重查取得 ESRCH，期間只查不殺', async (t) => {
  const r = await observe(t, [call(KILL), call(0, fault('EPERM')), wait(), call(0, fault('EPERM')), wait(), call(0, fault('EPERM')), wait(), call(0, fault('ESRCH'))]);
  assert.equal(r.failure, undefined);
  assert.equal(r.waits, 3);
});

test('群組等待｜持續 EPERM 到三次即拒絕，不能採用第四次 ESRCH', async (t) => {
  const first = fault('EPERM');
  const expected = [call(KILL), call(0, first), wait(), call(0, fault('EPERM')), wait(), call(0, fault('EPERM')), wait(), call(0, fault('EPERM'))];
  const r = await observe(t, [...expected, wait(), call(0, fault('ESRCH'))], { expected });
  refused(r.failure, first);
  assert.equal(r.waits, 3);
});

test('群組等待｜unknown 查到仍存在，立即拒絕而不再殺或等待', async (t) => {
  const first = fault('EPERM');
  const expected = [call(KILL), call(0, first), wait(), call(0)];
  refused((await observe(t, [...expected, wait(), call(0, fault('ESRCH'))], { expected })).failure, first);
});

for (const code of ['EINVAL', 'EIO']) test(`群組等待｜unknown 後 ${code} 保留首 EPERM cause`, async (t) => {
  const first = fault('EPERM');
  refused((await observe(t, [call(KILL), call(0, first), wait(), call(0, fault(code))])).failure, first);
});

test('群組等待｜197 個既有等待後可用最後三個 slot 取得 ESRCH', async (t) => {
  const r = await observe(t, [...living(197), call(KILL), call(0, fault('EPERM')), wait(), call(0, fault('EPERM')), wait(), call(0, fault('EPERM')), wait(), call(0, fault('ESRCH'))]);
  assert.equal(r.failure, undefined);
  assert.equal(r.waits, 200);
});

test('群組等待｜198 個既有等待後不足三 slot，立即拒絕而不部分重查', async (t) => {
  const first = fault('EPERM');
  const expected = [...living(198), call(KILL), call(0, first)];
  const r = await observe(t, [...expected, wait(), call(0, fault('ESRCH'))], { expected });
  refused(r.failure, first);
  assert.equal(r.waits, 198);
});

test('群組等待｜一直存在僅使用原 200 個等待 slot', async (t) => {
  const r = await observe(t, living(200));
  assert.ok(r.failure instanceof Error);
  assert.match(r.failure.message, /200 次等待/);
  assert.equal(r.waits, 200);
});
