import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshotPinnedSources, verifyPinnedSourcesUnchanged, prepareNativePacket, runGeminiNativeScan } from '../scripts/gemini-native-runner.js';
import { sha256 } from '../scripts/gemini-native-protocol.js';
import { FILES, MODEL } from './helpers/gemini-native-fixture.js';

test('正式入口在讀來源、認證與啟動之前拒絕；旗標與環境不能開門', () => {
  let touched = false;
  const args = new Proxy({}, { get() { touched = true; throw Error('unexpected access'); } });
  assert.throws(() => runGeminiNativeScan(args), /GEMINI_NATIVE_AUTH_POLICY_REQUIRED/);
  assert.equal(touched, false);
  const child = spawnSync(process.execPath, ['scripts/gemini-native-runner.js', '--enable', '--authorize'], {
    cwd: new URL('..', import.meta.url), env: { PATH: '/usr/bin:/bin', GEMINI_NATIVE_ENABLED: 'true' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(child.status, 78); assert.equal(child.stdout, '');
  assert.equal(child.stderr, 'GEMINI_NATIVE_AUTH_POLICY_REQUIRED\n');
});
test('來源固定檔前後核對；操作確實執行且新種內容被改時拒收', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-source-')));
  const path = join(dir, 'source.js');
  try {
    writeFileSync(path, 'synthetic-one', { mode: 0o600 });
    const pins = [{ name: 'synthetic-source', path, sha256: sha256('synthetic-one') }];
    const before = snapshotPinnedSources(pins);
    assert.deepEqual(verifyPinnedSourcesUnchanged(pins, before), before);
    writeFileSync(path, 'synthetic-two'); assert.equal(readFileSync(path, 'utf8'), 'synthetic-two');
    assert.throws(() => verifyPinnedSourcesUnchanged(pins, before));
    writeFileSync(path, 'synthetic-one');
    assert.throws(() => verifyPinnedSourcesUnchanged(pins, before), /SOURCE_CHANGED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('來源不接受符號連結、硬連結、可共同寫入檔及不符雜湊', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gemini-source-'))), path = join(dir, 'source.js');
  const pin = p => [{ name: 'source', path: p, sha256: sha256('synthetic') }];
  try {
    writeFileSync(path, 'synthetic', { mode: 0o600 });
    symlinkSync(path, join(dir, 'link.js')); assert.throws(() => snapshotPinnedSources(pin(join(dir, 'link.js'))));
    symlinkSync(dir, join(dir, 'nested')); assert.throws(() => snapshotPinnedSources(pin(join(dir, 'nested', 'source.js'))));
    chmodSync(path, 0o622); assert.throws(() => snapshotPinnedSources(pin(path))); chmodSync(path, 0o600);
    assert.throws(() => snapshotPinnedSources([{ ...pin(path)[0], sha256: '0'.repeat(64) }]));
    linkSync(path, join(dir, 'hard.js')); assert.throws(() => snapshotPinnedSources(pin(path)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('材料 hash 與正式 findings schema 帶入完整輸入，沒有預填答案', () => {
  const text = JSON.stringify({ files: FILES, diff: 'synthetic diff', prompt: 'synthetic prompt' });
  const packet = prepareNativePacket({ text, materialSha256: sha256(text) }, { scanId: 'synthetic', model: MODEL });
  const wire = JSON.parse(packet.bytes), payload = JSON.parse(wire.message.content.split('\n').at(-1));
  assert.deepEqual(payload.material.files, FILES); assert.deepEqual(payload.schema, packet.schema);
  assert.equal(payload.binding.materialSha256, sha256(text)); assert.equal('findings' in payload, false);
  assert.equal(packet.formalScan, false);
  assert.throws(() => prepareNativePacket({ text, materialSha256: '0'.repeat(64) }, { scanId: 'synthetic', model: MODEL }));
});
