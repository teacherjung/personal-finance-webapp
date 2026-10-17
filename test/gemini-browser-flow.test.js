import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { browserClient } from '../scripts/gemini-browser-client.js';
import { leaseMessage, sha256 } from '../scripts/gemini-browser-protocol.js';
import { writeOnce, readMail, mailExists, SOURCE_FILES } from '../scripts/gemini-browser-files.js';
import { checkBrowserArtifacts, renderBrowserLauncher, renderBrowserCuaLoader } from '../scripts/gemini-browser-runner.js';
import { material, answer, observation, jobFixture } from './helpers/gemini-browser-fixture.js';

test('盒內持有請求到回覆的整輪；額外回覆、無回覆及壞來源不能終結成功', async () => {
  for (const variant of ['good', 'replay', 'missing', 'bad-source']) {
    const input = new PassThrough(), output = [];
    input.write(JSON.stringify({ kind: 'start', material: material() }) + '\n');
    const running = browserClient(input, line => {
      const frame = JSON.parse(line); output.push(frame);
      if (frame.kind === 'request') {
        const p = frame.packet, o = observation(p);
        if (variant === 'bad-source') o.complete = false;
        const reply = JSON.stringify({ kind: 'reply', response: answer(p), observation: o }) + '\n';
        input.end(variant === 'missing' ? '' : variant === 'replay' ? reply + reply : reply);
      }
    });
    if (variant === 'good') { await running; assert.equal(output.length, 2); assert.equal(output[1].result.answer.findings.length, 1); }
    else await assert.rejects(running);
  }
});
test('lease 必須回答新 challenge；只核准一次且先消耗後才接受捕獲', () => {
  const j = jobFixture();
  try {
    const claim = leaseMessage(j.descriptor, 'c'.repeat(32), 'd'.repeat(64), 'claim');
    writeOnce(j.dir, 'claim.json', claim); j.lease.tick();
    assert.deepEqual(readMail(j.dir, 'claim-ack.json'), { ...claim, stage: 'claimed' });
    const ready = { ...leaseMessage(j.descriptor, claim.instance, 'e'.repeat(64), 'ready'), tabId: 'test-owned', temporary: true, initialResponses: 0, selected: 'Open mode picker, currently Argon High' };
    writeOnce(j.dir, 'ready.json', ready); j.lease.tick();
    assert.equal(j.lease.state, 'SUBMIT_AUTHORIZED'); assert.equal(readMail(j.dir, 'permit.json').challenge, ready.challenge);
    assert.throws(() => writeOnce(j.dir, 'ready.json', ready));
    writeOnce(j.dir, 'capture.json', { instance: claim.instance, observation: observation(j.packet) });
    writeOnce(j.dir, 'submitted.json', { instance: claim.instance, tabId: ready.tabId, submissions: 1 });
    writeOnce(j.dir, 'response.txt', answer(j.packet));
    writeOnce(j.dir, 'quiescent.json', { instance: claim.instance, tabClosed: true, failed: false });
    assert.throws(() => j.lease.tick()); assert.notEqual(j.lease.state, 'CAPTURED');
  } finally { j.cleanup(); }
});
test('中止與晚到回覆不被採用；盒外專屬假值與新機密形狀守門', () => {
  const j = jobFixture();
  try {
    writeOnce(j.dir, 'aborted.json', { adopted: false });
    writeOnce(j.dir, 'capture.json', { instance: 'x', observation: observation(j.packet) });
    assert.throws(() => j.lease.tick(), /ABORTED/); assert.equal(mailExists(j.dir, 'receipt.json'), false);
    checkBrowserArtifacts([Buffer.from(answer(j.packet))], 'synthetic-secret', material().text);
    assert.throws(() => checkBrowserArtifacts([Buffer.from('synthetic-secret')], 'synthetic-secret', material().text), /CANARY_LEAK/);
    assert.throws(() => checkBrowserArtifacts([Buffer.from('flexToken":"new-secret-123456"')], 'synthetic-secret', material().text), /SECRET_SHAPE/);
    writeFileSync(join(j.dir, 'outside-canary.txt'), 'synthetic-secret');
  } finally { j.cleanup(); }
});

test('根發射器在匯入前核固定設定、node、提示及執行來源；缺集合或自改釘值不能追認', () => {
  for (const target of ['runner', 'cua']) for (const variant of ['good', 'source', 'node', 'prompt', 'config', 'duplicate', 'missing-source', ...(target === 'runner' ? ['flags', 'loader'] : [])]) {
    const dir = realpathSync(mkdtempSync('/private/tmp/browser-bootstrap-test-'));
    try {
      const providerRoot = join(dir, 'provider'), promptFile = join(dir, 'prompt.txt'), marker = join(dir, 'IMPORTED');
      const script = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'yes'); export async function runBrowserScan(d) { if(d.pins.length!==5)throw Error('pins'); return {status:'SYNTHETIC',runId:'fake',receipt:'fake'}; }`;
      const providerFiles = SOURCE_FILES.map(path => {
        const bytes = ['scripts/gemini-browser-runner.js', 'scripts/gemini-browser-cua.js'].includes(path) ? script
          : path === 'scripts/gemini-browser-files.js' ? 'export function configureBrowserOwner(uid) { if(!Number.isSafeInteger(uid))throw Error("uid"); }'
          : path === 'package.json' ? '{"type":"module"}' : '';
        mkdirSync(dirname(join(providerRoot, path)), { recursive: true }); writeFileSync(join(providerRoot, path), bytes, { mode: 0o600 });
        return { path, mode: '100644', sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) };
      });
      writeFileSync(promptFile, 'synthetic prompt', { mode: 0o600 });
      const d = { purpose: 'qualification', providerRoot, providerHead: 'a'.repeat(40), providerFiles,
        repo: dir, base: 'b'.repeat(40), head: 'c'.repeat(40), promptFile, promptSha256: sha256('synthetic prompt'),
        node: realpathSync(process.execPath), nodeSha256: sha256(readFileSync(process.execPath)), qualification: null };
      if (variant === 'node') d.nodeSha256 = '0'.repeat(64);
      if (variant === 'missing-source') d.providerFiles = d.providerFiles.slice(1);
      let config = JSON.stringify(d) + '\n';
      if (variant === 'duplicate') config = config.replace('{', '{"purpose":"qualification",');
      const configFile = join(dir, 'deployment.json'), launcher = join(dir, 'launcher.mjs'), loader = join(dir, 'cua.mjs');
      writeFileSync(configFile, config, { mode: 0o600 });
      writeFileSync(loader, renderBrowserCuaLoader(configFile, sha256(config), providerRoot), { mode: 0o600 });
      writeFileSync(launcher, renderBrowserLauncher(configFile, sha256(config), providerRoot, { path: loader, sha256: sha256(readFileSync(loader)) }), { mode: 0o600 });
      if (variant === 'loader') writeFileSync(loader, 'throw Error("changed loader");');
      if (variant === 'source') writeFileSync(join(providerRoot, 'scripts/gemini-browser-client.js'), 'throw Error("unverified import");');
      if (variant === 'prompt') writeFileSync(promptFile, 'changed');
      if (variant === 'config') writeFileSync(configFile, JSON.stringify({ ...d, nodeSha256: '0'.repeat(64) }) + '\n');
      const r = spawnSync(process.execPath, [target === 'runner' ? launcher : loader, ...(variant === 'flags' ? ['--force'] : [])], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
      assert.equal(r.status, variant === 'good' ? 0 : 1, `${target}/${variant}: ${r.stderr}`);
      assert.equal(existsSync(marker), variant === 'good', `${target}/${variant}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
