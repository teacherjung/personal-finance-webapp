// @ts-check
// 入口只由釘住的盒外部署呼叫；CUA 交接是資料搬運，不讓回覆決定工具、路徑或第二次送出。
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SOURCE_ROOT, SOURCE_FILES, JOB_ROOT, privateDirectory, readMail, readBoundedFile, writeOnce, mailExists, sourceDigest, browserError } from './gemini-browser-files.js';
import { prepareBrowserPacket, validateBrowserReply, validateLease, fields, PROMPT_CAP, REPLY_CAP, MODEL, EFFORT, sha256, SELECTED } from './gemini-browser-protocol.js';
import { parseUniqueJson } from './gemini-native-protocol.js';
import { snapshotPinnedSources, verifyPinnedSourcesUnchanged } from './gemini-native-runner.js';
import { buildScanMaterials, verifyProvider } from './gemini-scan.js';
import { sandboxEnv } from './grok-sandbox-canary.js';
import { BROWSER_PROFILE, browserCanary } from './gemini-browser-canary.js';
import { killGroupAndWait, sweepEscapees, shapeHitsIn, escapeForms, readSessionsOnce } from './grok-scan.js';
import { isMainModule } from '../lib/is-main.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const random = n => randomBytes(n).toString('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const WORKER_FILES = ['scripts/gemini-browser-client.js', 'scripts/gemini-browser-protocol.js', 'scripts/gemini-native-protocol.js', 'lib/is-main.js'];
const WALL_MS = 15 * 60000;

// 這一層沒有 UI 能力；新鮮 challenge 證活動控制流程，不宣稱抵抗可改整個可信檔案域的同 UID 操作者。
export class BrowserLease {
  constructor(dir, descriptor, check) {
    this.dir = dir; this.d = descriptor; this.check = check; this.state = 'WAIT_CLAIM';
    this.instance = ''; this.permit = null; this.started = performance.now();
  }
  active() {
    if (performance.now() - this.started > WALL_MS || Date.now() >= this.d.expiresAt
      || mailExists(this.dir, 'cancel.json') || mailExists(this.dir, 'adapter-failed.json') || mailExists(this.dir, 'aborted.json')) browserError('ABORTED');
    this.check();
  }
  tick() {
    this.active();
    if (this.state === 'WAIT_CLAIM' && mailExists(this.dir, 'claim.json')) {
      const claim = validateLease(readMail(this.dir, 'claim.json'), this.d, 'claim');
      this.instance = claim.instance; this.state = 'CLAIMED';
      writeOnce(this.dir, 'claim-ack.json', { ...claim, stage: 'claimed' });
    }
    if (this.state === 'CLAIMED' && mailExists(this.dir, 'ready.json')) {
      const ready = readMail(this.dir, 'ready.json');
      fields(ready, ['runId', 'lease', 'requestSha256', 'instance', 'challenge', 'stage', 'tabId', 'temporary', 'initialResponses', 'selected']);
      const { tabId, temporary, initialResponses, selected, ...message } = ready;
      validateLease(message, this.d, 'ready');
      if (ready.instance !== this.instance || !/^[a-zA-Z0-9-]{1,128}$/.test(tabId) || temporary !== true
        || initialResponses !== 0 || selected !== SELECTED || ready.challenge === readMail(this.dir, 'claim.json').challenge) browserError('READY');
      this.state = 'SUBMIT_AUTHORIZED';
      this.permit = { ...ready, stage: 'submit-once' };
      writeOnce(this.dir, 'permit.json', this.permit);
    }
    if (this.state === 'SUBMIT_AUTHORIZED' && mailExists(this.dir, 'capture.json')) {
      if (!equal(readMail(this.dir, 'consumed.json'), this.permit)) browserError('CONSUMPTION');
      const submitted = readMail(this.dir, 'submitted.json');
      fields(submitted, ['instance', 'tabId', 'submissions']);
      if (submitted.instance !== this.instance || submitted.tabId !== this.permit.tabId || submitted.submissions !== 1) browserError('SUBMISSION');
      const captured = readMail(this.dir, 'capture.json');
      fields(captured, ['instance', 'observation']);
      if (captured.instance !== this.instance || captured.observation.tabId !== this.permit.tabId) browserError('CAPTURE');
      if (!mailExists(this.dir, 'quiescent.json')) return null;
      this.requireQuiescent(false); this.state = 'CAPTURED';
      return { raw: readBoundedFile(join(this.dir, 'response.txt'), REPLY_CAP), observation: captured.observation };
    }
    return null;
  }
  requireQuiescent(failureAllowed) {
    const q = readMail(this.dir, 'quiescent.json');
    fields(q, ['instance', 'tabClosed', 'failed']);
    if (q.instance !== this.instance || typeof q.failed !== 'boolean' || (!failureAllowed && q.failed)
      || (this.permit && q.tabClosed !== true) || typeof q.tabClosed !== 'boolean') browserError('QUIESCENCE');
  }
}

export function checkBrowserArtifacts(buffers, marker, materialText) {
  const known = new Set(shapeHitsIn(materialText));
  for (const bytes of buffers) {
    const text = bytes.toString('utf8');
    if (escapeForms(marker).some(secret => text.includes(secret))) browserError('CANARY_LEAK');
    if (shapeHitsIn(text).some(hit => !known.has(hit))) browserError('SECRET_SHAPE');
  }
}

function childFrames(child) {
  const frames = [], chunks = [];
  let buffer = Buffer.alloc(0), size = 0, error = null, exited = false, exitCode = null;
  const cap = (PROMPT_CAP + REPLY_CAP) * 8;
  child.stdout.on('data', bytes => {
    try {
      chunks.push(bytes); size += bytes.length;
      if (size > cap) browserError('CHILD_OUTPUT');
      buffer = Buffer.concat([buffer, bytes]);
      let pos;
      while ((pos = buffer.indexOf(10)) >= 0) {
        frames.push(parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, pos))));
        buffer = buffer.subarray(pos + 1);
        if (frames.length > 2) browserError('CHILD_REPLAY');
      }
    } catch (e) { error = e; child.kill('SIGKILL'); }
  });
  child.stderr.on('data', bytes => { chunks.push(bytes); size += bytes.length; if (size > cap) { error = Error('GEMINI_BROWSER_CHILD_OUTPUT'); child.kill('SIGKILL'); } });
  child.on('error', e => { error = e; });
  child.stdin.on('error', e => { error = e; });
  child.on('close', code => { exited = true; exitCode = code; });
  return {
    frames, chunks,
    check() { if (error) throw error; },
    waiting() { if (error) throw error; if (exited) browserError('CHILD_EXIT'); },
    finished() { if (error) throw error; return exited && exitCode === 0 && buffer.length === 0 && frames.length === 2; },
    ended() { return exited; },
  };
}

// 部署物件出自已釘住的盒外 wrapper；沒有 CLI/環境變數補值，也不從模型回覆建立部署。
export async function runBrowserScan(deployment) {
  fields(deployment, ['purpose', 'providerHead', 'repo', 'base', 'head', 'promptFile', 'pins', 'qualification']);
  if (!['qualification', 'scan'].includes(deployment.purpose)) browserError('PURPOSE');
  for (const key of ['providerHead', 'base', 'head']) if (!/^[a-f0-9]{40}$/.test(deployment[key])) browserError('REVISION');
  const pinsBefore = snapshotPinnedSources(deployment.pins);
  for (const name of ['wrapper', 'deployment', 'prompt', 'node']) if (!deployment.pins.some(p => p.name === name)) browserError('DEPLOYMENT_PINS');
  if (!deployment.pins.some(p => p.name === 'node' && p.path === realpathSync(process.execPath))) browserError('NODE_PIN');
  if (!deployment.pins.some(p => p.name === 'prompt' && p.path === deployment.promptFile)) browserError('PROMPT_PIN');
  const provider = verifyProvider(SOURCE_ROOT, deployment.providerHead);
  const sources = sourceDigest(SOURCE_ROOT, SOURCE_FILES);
  const materials = buildScanMaterials({ ...deployment, outFile: '' });
  const material = { text: materials.text, sha256: materials.materialSha256, base: deployment.base, head: deployment.head };
  // 在建盒與探針之前檢查容量；不裁斷完整材料來湊成功。
  prepareBrowserPacket(material);
  if (deployment.purpose === 'scan') {
    const settings = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(readBoundedFile(join(SOURCE_ROOT, 'settings.json'), 2 * 1024 * 1024)));
    if (settings.scanner.strongest !== MODEL || settings.scanner.maxEffort !== EFFORT
      || !settings.scanner.tool.includes('gemini-browser-runner.js')) browserError('REGISTRATION');
    const q = deployment.qualification;
    fields(q, ['path', 'sha256']);
    const bytes = readBoundedFile(q.path);
    if (sha256(bytes) !== q.sha256) browserError('QUALIFICATION_HASH');
    const receipt = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (receipt.purpose !== 'qualification' || receipt.status !== 'PUBLISHED' || receipt.sourceSha256 !== sources.sha256
      || receipt.promptBytes < PROMPT_CAP || receipt.providerHead !== deployment.providerHead) browserError('QUALIFICATION');
  } else if (deployment.qualification !== null) browserError('QUALIFICATION');
  try { mkdirSync(JOB_ROOT, { mode: 0o700 }); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e; }
  privateDirectory(JOB_ROOT);
  const lock = join(JOB_ROOT, 'active');
  mkdirSync(lock, { mode: 0o700 });
  const runId = random(16), job = join(JOB_ROOT, runId);
  mkdirSync(job, { mode: 0o700 });
  writeOnce(lock, 'owner.json', { runId });
  const box = realpathSync(mkdtempSync('/private/tmp/gemini-browser-box-'));
  const marker = 'browser-canary-' + random(32);
  writeOnce(job, 'outside-canary.txt', marker);
  let child, wire, lease, packet, failure = null, interrupted = false, cleaned = false, groupEmpty = false;
  const abort = () => { interrupted = true; };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  const started = performance.now();
  const check = () => {
    if (interrupted || performance.now() - started > WALL_MS) browserError('TIMEOUT_OR_CANCEL');
    if (sourceDigest(SOURCE_ROOT, SOURCE_FILES).sha256 !== sources.sha256) browserError('SOURCE_CHANGED');
    verifyPinnedSourcesUnchanged(deployment.pins, pinsBefore);
  };
  try {
    for (const path of WORKER_FILES) {
      mkdirSync(dirname(join(box, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(box, path), readBoundedFile(join(SOURCE_ROOT, path)), { mode: 0o600, flag: 'wx' });
    }
    writeFileSync(join(box, 'package.json'), '{"type":"module"}', { mode: 0o600, flag: 'wx' });
    const pre = await browserCanary(box, job, marker);
    writeOnce(job, 'precanary.json', pre);
    if (pre.code !== 0) browserError('PRECANARY');
    check();
    child = spawn('/usr/bin/sandbox-exec', ['-f', BROWSER_PROFILE, '-D', `SCAN_DIR=${box}`, process.execPath, join(box, 'scripts/gemini-browser-client.js')],
      { cwd: box, env: sandboxEnv(box), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    wire = childFrames(child);
    child.stdin.write(JSON.stringify({ kind: 'start', material }) + '\n');
    while (!wire.frames.length) { check(); wire.waiting(); await pause(); }
    fields(wire.frames[0], ['kind', 'packet']);
    if (wire.frames[0].kind !== 'request') browserError('CHILD_REQUEST');
    packet = prepareBrowserPacket(material, { scanId: wire.frames[0].packet.binding.scanId, tailChallenge: wire.frames[0].packet.tailChallenge });
    if (!equal(packet, wire.frames[0].packet) || wire.frames.length !== 1) browserError('CHILD_REQUEST');
    writeOnce(job, 'prompt.txt', packet.prompt);
    const descriptor = { schema: 'browser-job/v1', runId, lease: random(32), sourceSha256: sources.sha256,
      requestSha256: packet.promptSha256, requestBytes: packet.promptBytes, scanId: packet.binding.scanId,
      pid: process.pid, expiresAt: Date.now() + Math.floor(Math.max(0, WALL_MS - (performance.now() - started))) };
    writeOnce(job, 'descriptor.json', descriptor);
    lease = new BrowserLease(job, descriptor, () => { check(); wire.waiting();
      if (wire.frames.length !== 1 || sha256(readBoundedFile(join(job, 'prompt.txt'))) !== packet.promptSha256) browserError('REQUEST_CHANGED');
    });
    process.stdout.write(JSON.stringify({ state: 'HANDOFF_READY', runId, purpose: deployment.purpose }) + '\n');
    let capture;
    while (!(capture = lease.tick())) await pause();
    const result = validateBrowserReply(capture.raw, capture.observation, packet);
    child.stdin.end(JSON.stringify({ kind: 'reply', response: new TextDecoder('utf-8', { fatal: true }).decode(capture.raw), observation: capture.observation }) + '\n');
    while (!wire.ended()) { check(); wire.check(); await pause(); }
    if (!wire.finished() || !equal(wire.frames[1], { kind: 'result', result })) browserError('CHILD_RESULT');
    await killGroupAndWait(child.pid ?? null); groupEmpty = true;
    const sweepLog = []; const escaped = sweepEscapees(box, line => sweepLog.push(line));
    if (escaped) browserError('ESCAPED_CHILD');
    const post = await browserCanary(box, job, marker);
    writeOnce(job, 'postcanary.json', post);
    if (post.code !== 0) browserError('POSTCANARY');
    check();
    if (readBoundedFile(join(job, 'outside-canary.txt')).toString() !== marker || mailExists(job, 'forbidden-write.txt')) browserError('CANARY_CHANGED');
    const sessionFiles = readSessionsOnce(box);
    if (sessionFiles.odd?.length) browserError('BOX_FILES');
    for (const path of WORKER_FILES) if (!sessionFiles.files.get(path)?.equals(readBoundedFile(join(SOURCE_ROOT, path)))) browserError('WORKER_CHANGED');
    const artifacts = [...wire.chunks, capture.raw, Buffer.from(JSON.stringify(capture.observation)), Buffer.from([...sessionFiles.files.keys()].join('\n')), ...sessionFiles.files.values()];
    checkBrowserArtifacts(artifacts, marker, material.text);
    checkBrowserArtifacts(artifacts, descriptor.lease, material.text);
    if (verifyProvider(SOURCE_ROOT, deployment.providerHead).digest !== provider.digest
      || buildScanMaterials({ ...deployment, outFile: '' }).materialSha256 !== material.sha256) browserError('SOURCE_CHANGED');
    lease.requireQuiescent(false);
    rmSync(box, { recursive: true, force: true }); cleaned = true;
    const receipt = { schema: 'browser-scan/v1', status: 'PUBLISHED', purpose: deployment.purpose,
      formalScan: deployment.purpose === 'scan', runId, base: deployment.base, head: deployment.head,
      providerHead: deployment.providerHead, providerDigest: provider.digest, sourceSha256: sources.sha256,
      promptBytes: packet.promptBytes, promptSha256: packet.promptSha256, materialSha256: material.sha256,
      ...result, observation: capture.observation, cleanup: { groupEmpty: true, escapeSweep: 'best-effort', sweepLog, boxRemoved: true, cuaQuiescent: true, ownTabClosed: true } };
    writeOnce(job, 'receipt.json', receipt);
    rmSync(lock, { recursive: true });
    return { receipt: join(job, 'receipt.json'), ...receipt };
  } catch (e) { failure = e; }
  finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (failure) {
      writeOnce(job, 'aborted.json', { status: 'ABORTED', adopted: false });
      if (child) { try { await killGroupAndWait(child.pid ?? null); groupEmpty = true; } catch { /* 保留盒子與 active，收尾不確定不放下一掃。 */ } }
      let quiescent = !mailExists(job, 'claim.json');
      if (!quiescent && lease) {
        const end = performance.now() + 15000;
        while (!mailExists(job, 'quiescent.json') && performance.now() < end) await pause();
        try { lease.requireQuiescent(true); quiescent = true; } catch { /* 只有固定 adapter 的靜止回報可解鎖。 */ }
      }
      if (quiescent && (!child || (groupEmpty && wire?.ended()))) {
        const escapeLog = []; const escaped = sweepEscapees(box, line => escapeLog.push(line));
        if (!escaped && !escapeLog.length) { rmSync(box, { recursive: true, force: true }); cleaned = true; rmSync(lock, { recursive: true }); }
      }
      writeOnce(job, 'failure.json', { status: 'FAILED', formalScan: false, cleaned, error: String(failure).match(/GEMINI_BROWSER_[A-Z_]+/)?.[0] ?? 'GEMINI_BROWSER_REJECTED' });
    }
  }
  throw Error(`GEMINI_BROWSER_FAILED runId=${runId} cleaned=${cleaned}`);
}

if (isMainModule(import.meta.url)) {
  process.stderr.write('GEMINI_BROWSER_PINNED_WRAPPER_REQUIRED\n'); process.exitCode = 78;
}
