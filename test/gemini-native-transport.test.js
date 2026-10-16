import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { writeNativeInput, collectNativeProcess } from '../scripts/gemini-native-transport.js';
import { encodeNativeInput, sha256, validateNativeStream } from '../scripts/gemini-native-protocol.js';
import { prepareNativePacket } from '../scripts/gemini-native-runner.js';
import { killGroupAndWait } from '../scripts/grok-scan.js';
import { FILES, MODEL, streamBytes, streamEvents } from './helpers/gemini-native-fixture.js';
const fixture = fileURLToPath(new URL('./helpers/gemini-native-fixture.js', import.meta.url));

test('夾具被整批考題直接載入時不等待輸入也不輸出合成答案', () => {
  const result = spawnSync(process.execPath, [fixture], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});

async function withChild(mode, fn, extra = []) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-transport-'))), marker = join(dir, 'child.pid');
  const child = spawn(process.execPath, [fixture, mode, marker, ...extra], { cwd: dir, detached: true,
    env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  try { return await fn(child, marker); }
  finally { await killGroupAndWait(child.pid); rmSync(dir, { recursive: true, force: true }); }
}
const options = () => ({ signal: new AbortController().signal, wallMs: 5000 });
test('背壓與 EOF：真合成子程序收到完整大筆 Unicode 輸入', async () => {
  const input = encodeNativeInput('完整🌲\\"\n'.repeat(200_000));
  const result = await withChild('echo', child => collectNativeProcess(child, input.bytes, options()));
  assert.deepEqual(JSON.parse(result.stdout), { bytes: input.bytes.length, sha256: input.inputSha256, eof: true });
  assert.equal(result.groupCleared, true); assert.equal(result.escapedProcessesVerified, false);
  assert.equal(result.inputWriteCompleted, true); assert.equal(result.receiverConsumptionVerified, false);
});
test('完整合成流程：材料到子程序再回結構化答案，仍不算正式掃描', async () => {
  const text = JSON.stringify({ files: FILES, diff: 'synthetic', prompt: 'synthetic' });
  const packet = prepareNativePacket({ text, materialSha256: sha256(text) }, { scanId: 'synthetic-flow', model: MODEL });
  const result = await withChild('stream', child => collectNativeProcess(child, packet.bytes, options()));
  const accepted = validateNativeStream(result, packet);
  assert.equal(accepted.candidateAnswer.findings[0].path, FILES[0].path); assert.equal(accepted.formalScan, false);
});
test('小筆輸入只讀前綴並複寫 binding 交空 findings，尾端挑戰仍拒收', async () => {
  const text = JSON.stringify({ files: FILES, diff: 'synthetic NEEDLE_UNREAD', prompt: 'synthetic' });
  const packet = prepareNativePacket({ text, materialSha256: sha256(text) }, { scanId: 'synthetic-prefix', model: MODEL });
  const prefixLength = packet.bytes.indexOf(Buffer.from(',\\"material\\":'));
  assert.ok(prefixLength > 0); assert.ok(packet.bytes.length < 4096);
  await withChild('prefix', async (child, marker) => {
    const result = await collectNativeProcess(child, packet.bytes, options());
    assert.equal(result.code, 0); assert.equal(result.timedOut, false); assert.equal(result.capped, false);
    assert.equal(result.stderr.length, 0); assert.equal(result.inputWriteCompleted, true);
    const consumed = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(consumed.consumed, prefixLength); assert.equal(consumed.scanId, packet.binding.scanId);
    assert.equal(consumed.sawNeedle, false);
    assert.equal(JSON.parse(result.stdout.toString().trimEnd().split('\n').at(-1)).result.structured_output.findings.length, 0);
    await assert.rejects(async () => validateNativeStream(result, packet), /GEMINI_NATIVE_TAIL_CHALLENGE/);
    assert.equal(consumed.sawTail, false);
  }, [String(prefixLength)]);
});
test('上一場的尾端挑戰不能用於同材料與同 binding 的新場次', () => {
  const text = JSON.stringify({ files: FILES, diff: 'synthetic', prompt: 'synthetic' });
  const args = { scanId: 'synthetic-replay', model: MODEL };
  const first = prepareNativePacket({ text, materialSha256: sha256(text) }, args);
  const second = prepareNativePacket({ text, materialSha256: sha256(text) }, args);
  assert.deepEqual(first.binding, second.binding); assert.notEqual(first.tailChallenge, second.tailChallenge);
  const events = streamEvents(first.binding, first.schema, first.tailChallenge);
  events.at(-1).result.structured_output.findings = [];
  const result = { stdout: streamBytes(events), stderr: Buffer.alloc(0), code: 0, timedOut: false, capped: false };
  assert.deepEqual(validateNativeStream(result, first).candidateAnswer.findings, []);
  assert.throws(() => validateNativeStream(result, second), /GEMINI_NATIVE_TAIL_CHALLENGE/);
});
test('輸入管線完成前的寫入錯誤會拒收', async () => {
  const destination = new Writable({ write(chunk, encoding, callback) { callback(Error('synthetic failure')); } });
  await assert.rejects(writeNativeInput(destination, Buffer.from('synthetic'), options()), /STDIN_FAILED/);
});
test('寫入尚未完成時關閉 stdin 會拒收，不證明接收端完整消耗', async () => {
  await withChild('early', async child => {
    await assert.rejects(collectNativeProcess(child, Buffer.alloc(3_000_000, 120), options()), /GEMINI_NATIVE_(STDIN_FAILED|CLEANUP_UNCERTAIN)/);
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  });
});
test('stdout 與 stderr 的合計上限會終止程序', async () => {
  await withChild('overflow', child => assert.rejects(collectNativeProcess(child, Buffer.from('synthetic'), options()), /OUTPUT_SIZE/));
});
test('外層時限生效且已知程序群清空', async () => {
  await withChild('hang', async child => {
    await assert.rejects(collectNativeProcess(child, Buffer.from('synthetic'), { ...options(), wallMs: 100 }), /TIMEOUT/);
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  });
});
test('close 永不抵達時會拒收；不能只等已知程序群清空', async () => {
  await withChild('hang', async child => {
    // 借用本題建立的真程序群與管線，但不把 close 轉送給收集器，模擬仍被持有的 pipe。
    const facade = Object.assign(new EventEmitter(), {
      pid: child.pid, stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
    });
    let childClosed = false;
    child.once('close', () => { childClosed = true; });
    const pending = collectNativeProcess(facade, Buffer.from('synthetic'), { ...options(), wallMs: 200 });
    let deadline;
    const bounded = new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(Error('TEST_CLOSE_DEADLINE')), 18_000);
    });
    try {
      await assert.rejects(Promise.race([pending, bounded]), /GEMINI_NATIVE_CLEANUP_UNCERTAIN/);
      assert.equal(childClosed, true);
      assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
    } finally {
      clearTimeout(deadline);
      // 突變拿掉收尾時限時，仍讓被測 promise 結束，避免考題留下懸掛的收集器。
      facade.emit('close', null, 'SIGKILL');
      await pending.catch(() => {});
    }
  });
});
test('執行中 abort 會中斷，已退出的程序不保留成功輸出', async () => {
  await withChild('hang', async child => {
    const controller = new AbortController();
    const result = collectNativeProcess(child, Buffer.from('synthetic'), { signal: controller.signal, wallMs: 5000 });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(result, /ABORTED/); assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  });
});
test('同群孫程序真的建立後也被收尾；不拿未建立的程序冒充清理證明', async () => {
  await withChild('group', async (child, marker) => {
    const controller = new AbortController();
    const result = collectNativeProcess(child, Buffer.from('synthetic'), { signal: controller.signal, wallMs: 5000 });
    const checked = result.then(() => null, error => error);
    for (let i = 0; i < 100 && !existsSync(marker); i++) await delay(10);
    assert.equal(existsSync(marker), true);
    const grandchild = Number(readFileSync(marker, 'utf8')); assert.ok(grandchild > 1); process.kill(grandchild, 0);
    controller.abort(); assert.match((await checked).message, /ABORTED/);
    assert.throws(() => process.kill(grandchild, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(-child.pid, 0), { code: 'ESRCH' });
  });
});
