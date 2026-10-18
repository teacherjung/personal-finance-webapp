// 只替換 OS／程序／網頁邊界；原樣 runner 的串流檢查、lease 與本機刪除照跑，不證明真沙盒或真網頁。
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as protocol from '../../scripts/gemini-browser-protocol.js';
import * as files from '../../scripts/gemini-browser-files.js';
import { material, answer, observation, responseArtifacts } from './gemini-browser-fixture.js';

const variant = process.argv[2];
// Node 的測試探索也會直接載入 helpers；只有指定情境的子程序才執行夾具。
if (variant === undefined) process.exit(0);
assert.ok(['known', 'stderr-canary', 'stderr-lease', 'stderr-shape', 'early-cancel', 'bad-claim', 'foreign-quiescence'].includes(variant));
const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'gemini-runner-behavior-'))), jobs = join(root, 'jobs');
const original = material(), parsed = JSON.parse(original.text);
parsed.prompt += JSON.stringify({ flexToken: 'synthetic-material-fixture' });
const text = JSON.stringify(parsed), input = { ...original, text, sha256: protocol.sha256(text) };
const context = vm.createContext({ Buffer, TextDecoder, process, setTimeout, clearTimeout });
const runner = new URL('../../scripts/gemini-browser-runner.js', import.meta.url).href;
const sourceSha = '2'.repeat(64), instance = 'c'.repeat(32);
let child, box, packet, marker, job, artifactChecksReached = false, killed = 0;

function stderrInPieces(value) {
  for (const byte of Buffer.from(value)) child.stderr.write(Buffer.from([byte]));
}
function provideAdapterEvidence(dir, d) {
  job = dir;
  const put = (name, value) => files.writeOnce(dir, name, value);
  const claim = protocol.leaseMessage(d, instance, 'd'.repeat(64), 'claim');
  if (variant === 'bad-claim') claim.lease = '0'.repeat(64);
  put('claim.json', claim);
  if (['early-cancel', 'bad-claim', 'foreign-quiescence'].includes(variant)) {
    put('cancel.json', { instance });
    put('quiescent.json', { instance: variant === 'foreign-quiescence' ? 'f'.repeat(32) : instance, tabClosed: false, failed: true });
    return;
  }
  const upload = { ...protocol.leaseMessage(d, instance, 'e'.repeat(64), 'upload-request'), tabId: 'test-owned',
    temporary: true, initialResponses: 0, selected: protocol.SELECTED, initialAttachments: 0, attachment: d.manifest.attachment };
  put('upload-request.json', upload); put('upload-consumed.json', { ...upload, stage: 'upload-once' });
  const uploaded = { instance, tabId: 'test-owned', uploads: 1, attachment: d.manifest.attachment };
  put('upload-attempted.json', uploaded); put('uploaded.json', uploaded);
  const ready = { ...protocol.leaseMessage(d, instance, 'f'.repeat(64), 'ready'), tabId: 'test-owned', temporary: true,
    initialResponses: 0, selected: protocol.SELECTED, attachmentReady: true };
  put('ready.json', ready); put('consumed.json', { ...ready, stage: 'submit-once' });
  put('submitted.json', { instance, tabId: 'test-owned', submissions: 1 });
  const raw = answer(packet), artifacts = responseArtifacts(raw);
  put('response.txt', raw); put('response-rendered.txt', artifacts.rendered); put('response-dom.json', artifacts.dom);
  put('capture.json', { instance, observation: observation(packet, raw) });
  put('quiescent.json', { instance, tabClosed: true, failed: false });
  if (variant === 'stderr-canary') stderrInPieces(marker);
  if (variant === 'stderr-lease') stderrInPieces(d.lease);
  if (variant === 'stderr-shape') stderrInPieces(JSON.stringify({ flexToken: 'synthetic-unknown-fixture' }));
  if (variant === 'known') stderrInPieces('合成程序完成，分段不改變字元。');
}

const module = new vm.SourceTextModule(fs.readFileSync(new URL(runner), 'utf8'),
  { context, identifier: runner, initializeImportMeta(meta, m) { meta.url = m.identifier; } });
await module.link(async (specifier, ref) => {
  const id = specifier.startsWith('node:') ? specifier : new URL(specifier, ref.identifier).href;
  const real = await import(id), value = { ...real };
  if (specifier === 'node:fs') value.mkdtempSync = () => { box = fs.mkdtempSync(join(root, 'box-')); return box; };
  if (specifier === 'node:child_process') value.spawn = () => {
    child = new EventEmitter();
    Object.assign(child, { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => child.emit('close', 0) });
    child.stdin.on('data', bytes => {
      const event = JSON.parse(bytes.toString());
      if (event.kind === 'start') {
        packet = protocol.prepareBrowserPacket(event.material);
        const bytes = Buffer.from(JSON.stringify({ kind: 'request', packet }) + '\n');
        for (let at = 0; at < bytes.length; at += 17) child.stdout.write(bytes.subarray(at, at + 17));
      } else {
        assert.equal(event.kind, 'reply');
        const result = protocol.validateBrowserReply(Buffer.from(event.response), event.observation, packet);
        child.stdout.write(JSON.stringify({ kind: 'result', result }) + '\n'); child.emit('close', 0);
      }
    });
    return child;
  };
  if (specifier === './gemini-browser-files.js') Object.assign(value, {
    JOB_ROOT: jobs, sourceDigest: () => ({ sha256: sourceSha }),
    writeOnce: (dir, name, data) => {
      real.writeOnce(dir, name, data);
      if (name === 'outside-canary.txt') marker = data;
      if (name === 'descriptor.json') provideAdapterEvidence(dir, data);
    },
  });
  if (specifier === './gemini-native-runner.js') Object.assign(value, { snapshotPinnedSources: () => [], verifyPinnedSourcesUnchanged: () => {} });
  if (specifier === './gemini-scan.js') Object.assign(value, {
    verifyProvider: () => ({ digest: '3'.repeat(64) }), buildScanMaterials: () => ({ text, materialSha256: input.sha256 }),
  });
  if (specifier === './gemini-browser-canary.js') value.browserCanary = async () => ({ code: 0 });
  if (specifier === './grok-scan.js') Object.assign(value, {
    killGroupAndWait: async () => { killed++; child.emit('close', 0); }, sweepEscapees: () => 0,
    readSessionsOnce: path => { artifactChecksReached = true; return real.readSessionsOnce(path); },
  });
  return new vm.SyntheticModule(Object.keys(value), function () {
    for (const key of Object.keys(value)) this.setExport(key, value[key]);
  }, { context, identifier: id });
});

try {
  await module.evaluate();
  const pins = ['wrapper', 'deployment', 'prompt', 'node', 'cua-loader'].map(name => ({ name,
    path: name === 'node' ? fs.realpathSync(process.execPath) : '/synthetic/' + name, sha256: '1'.repeat(64) }));
  const run = module.namespace.runBrowserScan({ purpose: 'qualification', providerHead: 'a'.repeat(40), repo: '/synthetic/repo',
    base: input.base, head: input.head, promptFile: '/synthetic/prompt', pins, qualification: null });
  if (variant === 'known') {
    const result = await run; assert.equal(result.status, 'PUBLISHED'); assert.equal(result.cleanup.boxRemoved, true);
    assert.equal(files.readMail(job, 'receipt.json').responseSha256, protocol.sha256(answer(packet)));
  } else {
    await assert.rejects(run, /GEMINI_BROWSER_FAILED/);
    const failed = files.readMail(job, 'failure.json');
    assert.equal(failed.error, variant === 'stderr-shape' ? 'GEMINI_BROWSER_SECRET_SHAPE'
      : variant.startsWith('stderr-') ? 'GEMINI_BROWSER_CANARY_LEAK' : 'GEMINI_BROWSER_ABORTED');
    assert.equal(fs.existsSync(join(job, 'receipt.json')), false);
    assert.equal(failed.cleaned, !['bad-claim', 'foreign-quiescence'].includes(variant));
  }
  assert.ok(killed > 0);
  assert.equal(artifactChecksReached, variant === 'known' || variant.startsWith('stderr-'));
  const retained = ['bad-claim', 'foreign-quiescence'].includes(variant);
  assert.equal(fs.existsSync(box), retained); assert.equal(fs.existsSync(join(jobs, 'active')), retained);
  if (variant === 'early-cancel' || retained) {
    for (const name of ['claim-ack.json', 'upload-permit.json', 'permit.json']) assert.equal(fs.existsSync(join(job, name)), false);
  }
  process.stdout.write('RUNNER-BEHAVIOR-OK ' + variant);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
