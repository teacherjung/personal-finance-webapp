import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childFrames, checkBrowserArtifacts } from '../scripts/gemini-browser-runner.js';
import { FRAME_CAP } from '../scripts/gemini-browser-protocol.js';

function childFixture() {
  const child = new EventEmitter(); let kills = 0;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { kills++; } });
  return { child, wire: childFrames(child), kills: () => kills };
}

test('兩流各自拼回原 bytes，多位元組與跨段洩漏不受事件交錯影響', () => {
  const { child, wire } = childFixture();
  const stdout = Buffer.from(JSON.stringify({ text: '測試☃', flexToken: 'synthetic-stream-secret' }) + '\n{}\n');
  const stderr = Buffer.from('synthetic-canary-只在這裡');
  for (let i = 0; i < Math.max(stdout.length, stderr.length); i++) {
    if (i < stdout.length) child.stdout.write(stdout.subarray(i, i + 1));
    if (i < stderr.length) child.stderr.write(stderr.subarray(i, i + 1));
  }
  child.emit('close', 0);
  assert.equal(wire.finished(), true); assert.equal(wire.frames[0].text, '測試☃');
  assert.deepEqual(wire.artifacts(), [stdout, stderr]);
  assert.throws(() => checkBrowserArtifacts(wire.artifacts(), 'synthetic-canary-只在這裡', stdout.toString()), /CANARY_LEAK/);
  assert.throws(() => checkBrowserArtifacts(wire.artifacts(), 'not-in-stream', '{}'), /SECRET_SHAPE/);
});

test('兩流合計達容量可留存，超過一 byte 即終止且不能完成', () => {
  const { child, wire, kills } = childFixture();
  child.stdout.write(Buffer.from('{}\n{}\n')); child.stderr.write(Buffer.alloc(FRAME_CAP - 6, 32));
  wire.check(); assert.equal(wire.artifacts().reduce((n, x) => n + x.length, 0), FRAME_CAP); assert.equal(kills(), 0);
  child.stderr.write(Buffer.from('x')); assert.equal(kills(), 1);
  assert.throws(() => wire.check(), /CHILD_OUTPUT/); assert.throws(() => wire.finished(), /CHILD_OUTPUT/);
});

test('正式 runner 檢查完整串流與早取消清理，不以輔助函式通過代替接線', () => {
  const helper = fileURLToPath(new URL('./helpers/gemini-browser-runner-fixture.js', import.meta.url));
  for (const variant of ['known', 'stderr-canary', 'stderr-lease', 'stderr-shape', 'early-cancel', 'bad-claim', 'foreign-quiescence']) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', helper, variant],
      { encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.status, 0, variant + '\n' + result.stdout + result.stderr);
    assert.ok(result.stdout.endsWith('RUNNER-BEHAVIOR-OK ' + variant), variant);
  }
});
