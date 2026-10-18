// @ts-check
// 靜態材料掃描；Gemini 不在盒內執行考題。時機／once 閘由正式發射流程負責。
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, linkSync, fsyncSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../lib/git-env.js';
import { isMainModule } from '../lib/is-main.js';
import { runCanary, sandboxEnv, PROFILE, BOX_ROOT } from './grok-sandbox-canary.js';
import { killGroupAndWait, sweepEscapees, freePort, readSessionsOnce, escapeForms, shapeMatchesIn, stripLineMarkers } from './grok-scan.js';
import { loadGeminiAuth } from './gemini-auth.js';
import { startGeminiRelay } from './gemini-relay.js';
import { validateResult, MAX_MATERIAL_BYTES, MAX_RESPONSE_BYTES } from './gemini-client.js';

const GEMINI_WALL_MS = 50 * 60_000;

// clientSourceRoot 只由已固定盒外發射器給定；CLI 沒有來源旗標，正式呼叫必填。
/** @typedef {{repo:string,base:string,head:string,promptFile:string,outFile:string,model:string,providerHead:string,clientSourceRoot?:string}} ScanArgs */
/** @typedef {(repo:string,args:string[],input?:Buffer)=>Buffer} GitReader */
/** @typedef {{path:string,mode:string,type:string,oid:string}} TreeEntry */
/** @typedef {import('./gemini-auth.js').GeminiAuth} GeminiAuth */
/** @typedef {import('./gemini-client.js').MaterialManifest} MaterialManifest */
/** @typedef {import('./gemini-relay.js').GeminiRelay} GeminiRelay */
/** @typedef {{status:number|null,signal:string|null,stdout:Buffer,stderr:Buffer}} ChildResult */
/** @typedef {(file:string,argv:string[],options:{cwd:string,env:NodeJS.ProcessEnv,detached:boolean,stdio:['ignore','pipe','pipe']})=>import('node:child_process').ChildProcessByStdio<null,import('node:stream').Readable,import('node:stream').Readable>} ScanSpawn */
/** @typedef {(root:string,caps?:{files:number,depth:number,fileBytes:number,totalBytes:number})=>ReturnType<typeof readSessionsOnce>} SessionReader */
/** @typedef {{git?:GitReader,providerRoot?:string,killGroupAndWait?:(pid:number|null)=>Promise<void>,sweepEscapees?:typeof sweepEscapees,boxRoot?:string,liveRoot?:string,freePort?:()=>Promise<number>,runCanary?:typeof runCanary,loadAuth?:(options:{clientSourceRoot:string})=>Promise<GeminiAuth>,startRelay?:(config:import('./gemini-relay.js').RelayConfig)=>Promise<GeminiRelay>,processCount?:()=>number,spawn?:ScanSpawn,wallMs?:number,readSessionsOnce?:SessionReader}} ScanDeps */

const PROVIDER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_CAP = 8 * 1024 * 1024;
const MATERIAL_SCOPE = '完整 diff、每個 changed path 的前後文字與提示；未在盒內執行考題';
/** @param {string | Uint8Array} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {Buffer} bytes */
const blobSha = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
class ScanError extends Error {
  /** @param {string} code @param {boolean} [incident] */
  constructor(code, incident = false) { super(`GEMINI_SCAN_${code}`); this.code = code; this.incident = incident; }
}
/** @param {string} code @param {boolean} [incident] @returns {never} */
const stop = (code, incident = false) => { throw new ScanError(code, incident); };
/** @param {Buffer} bytes @returns {string} */
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** @type {GitReader} */
export function runGit(repo, args, input) {
  const result = spawnSync('git', ['--no-replace-objects', '-C', repo, ...args], { env: gitEnv(), input, maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
  if (result.status !== 0 || result.error || result.signal || !Buffer.isBuffer(result.stdout)) stop('GIT');
  return result.stdout;
}

/** @param {string} path @param {number} cap */
function readRegular(path, cap) {
  let fd;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > cap) stop('INPUT');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) stop('INPUT');
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > cap) stop('INPUT');
    return { bytes, mode: (stat.mode & 0o111) ? '100755' : '100644' };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** @param {string} path @returns {string} */
function validPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || /[\r\n\t]/.test(path)
    || [...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    || path.split('/').some(p => !p || p === '.' || p === '..')) stop('PATH');
  const lower = path.toLowerCase(), parts = lower.split('/');
  if (parts.some(p => ['.git', 'node_modules', '.gemini', '.grok', '.ssh', '.aws'].includes(p))
    || ['data/store.json', 'data/store.db'].includes(lower) || lower.endsWith('.bak')
    || (lower.startsWith('data/') && lower.includes('backup')) || parts.some(p => /^\.env(?:\.(?:local|production|development|test)(?:\.local)?)?$/.test(p))) stop('FORBIDDEN_PATH');
  return path;
}

/** @param {Buffer} bytes @returns {Map<string,TreeEntry>} */
function parseTree(bytes) {
  const text = utf8(bytes), entries = new Map();
  if (text && !text.endsWith('\0')) stop('TREE');
  for (const record of text.split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(record);
    if (!m || entries.has(m[4])) stop('TREE');
    validPath(m[4]); entries.set(m[4], { path: m[4], mode: m[1], type: m[2], oid: m[3] });
  }
  return entries;
}

/** @param {string} repo @param {GitReader} git */
function rootMatches(repo, git) {
  if (realpathSync(utf8(git(repo, ['rev-parse', '--show-toplevel'])).trim()) !== realpathSync(repo)) stop('ROOT');
}

/** @param {string} root @param {string} head @param {{git?:GitReader}} [options] */
export function verifyProvider(root, head, { git = runGit } = {}) {
  try {
    rootMatches(root, git);
    if (utf8(git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== head
      || git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length !== 0) stop('PROVIDER');
    const tree = parseTree(git(root, ['ls-tree', '-r', '-z', '--full-tree', head]));
    if (!tree.size) stop('PROVIDER');
    const files = [], payloads = new Map();
    for (const entry of [...tree.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) stop('PROVIDER');
      const read = readRegular(join(root, entry.path), 64 * 1024 * 1024);
      if (read.mode !== entry.mode || blobSha(read.bytes) !== entry.oid) stop('PROVIDER');
      files.push({ path: entry.path, mode: entry.mode, blob: entry.oid, bytes: read.bytes.length, sha256: sha256(read.bytes) });
      if (['scripts/gemini-client.js', 'lib/is-main.js', 'package.json', 'scripts/grok-sandbox.sb'].includes(entry.path)) payloads.set(entry.path, read.bytes);
    }
    if (payloads.size !== 4) stop('PROVIDER');
    return { head, files, digest: sha256(JSON.stringify(files)), payloads };
  } catch { stop('PROVIDER'); }
}

/** @param {string} repo @param {TreeEntry[]} entries @param {GitReader} git */
function readBlobs(repo, entries, git) {
  const ids = [...new Set(entries.map(e => e.oid))], blobs = new Map();
  if (!ids.length) return blobs;
  const raw = git(repo, ['cat-file', '--batch'], Buffer.from(ids.join('\n') + '\n'));
  let off = 0;
  for (const id of ids) {
    const nl = raw.indexOf(10, off), header = nl < 0 ? '' : raw.toString('ascii', off, nl);
    const m = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (!m || m[1] !== id || !Number.isSafeInteger(Number(m[2]))) stop('BLOB');
    const size = Number(m[2]), start = nl + 1, end = start + size;
    if (size > MAX_MATERIAL_BYTES || end >= raw.length || raw[end] !== 10) stop('BLOB');
    const bytes = raw.subarray(start, end);
    if (blobSha(bytes) !== id || bytes.includes(0)) stop('BLOB');
    const text = utf8(bytes); if (!/** @type {import('./gemini-client.js').WellFormedString} */ (text).isWellFormed()) stop('BLOB');
    blobs.set(id, { text, sha256: sha256(bytes) }); off = end + 1;
  }
  if (off !== raw.length) stop('BLOB');
  return blobs;
}

/** @param {ScanArgs} args @param {{git?:GitReader}} [options] */
export function buildScanMaterials(args, { git = runGit } = {}) {
  try {
    rootMatches(args.repo, git);
    for (const revision of [args.base, args.head]) if (utf8(git(args.repo, ['rev-parse', '--verify', `${revision}^{commit}`])).trim() !== revision) stop('COMMIT');
    const flags = ['--no-ext-diff', '--no-textconv', '--no-renames'];
    const names = utf8(git(args.repo, ['diff', ...flags, '--name-only', '-z', args.base, args.head, '--']));
    if (!names.endsWith('\0')) stop('MATERIAL_PATHS');
    const paths = names.split('\0').filter(Boolean); if (!paths.length || new Set(paths).size !== paths.length) stop('MATERIAL_PATHS');
    paths.forEach(validPath);
    const before = parseTree(git(args.repo, ['ls-tree', '-r', '-z', '--full-tree', args.base]));
    const after = parseTree(git(args.repo, ['ls-tree', '-r', '-z', '--full-tree', args.head]));
    const selected = [];
    for (const path of paths) {
      const entries = [before.get(path), after.get(path)].filter(e => e !== undefined);
      if (!entries.length || entries.some(e => e.type !== 'blob' || !['100644', '100755'].includes(e.mode))) stop('MATERIAL_TYPE');
      selected.push(...entries);
    }
    const blobs = readBlobs(args.repo, selected, git);
    const version = (entry) => entry ? { mode: entry.mode, blob: entry.oid, ...blobs.get(entry.oid) } : null;
    const files = paths.map(path => ({ path, before: version(before.get(path)), after: version(after.get(path)) }));
    const diff = utf8(git(args.repo, ['diff', ...flags, '--binary', '--full-index', args.base, args.head, '--']));
    const prompt = utf8(readRegular(args.promptFile, MAX_MATERIAL_BYTES).bytes);
    if (!prompt.trim() || diff.includes('\0')) stop('MATERIAL');
    const text = JSON.stringify({ scope: MATERIAL_SCOPE, base: args.base, head: args.head, providerHead: args.providerHead, prompt, diff, files });
    const materialBytes = Buffer.byteLength(text); if (materialBytes > MAX_MATERIAL_BYTES) stop('MATERIAL_SIZE');
    return { text, materialBytes, materialSha256: sha256(text), shapeSources: [prompt, diff, ...files.flatMap(f => [f.before?.text, f.after?.text].filter(t => t !== undefined))], files: files.map(f => ({ path: f.path, before: f.before && { mode: f.before.mode, blob: f.before.blob, sha256: f.before.sha256 }, after: f.after && { mode: f.after.mode, blob: f.after.blob, sha256: f.after.sha256 } })) };
  } catch (error) { if (error instanceof ScanError) throw error; stop('MATERIAL'); }
}

/** @param {ScanArgs} args */
function validateArgs(args) {
  const keys = ['repo', 'base', 'head', 'promptFile', 'outFile', 'model', 'providerHead'];
  if (!args || keys.some(k => typeof args[k] !== 'string' || !args[k])
    || Object.keys(args).some(k => !keys.includes(k) && k !== 'clientSourceRoot') || ['base', 'head', 'providerHead'].some(k => !/^[a-f0-9]{40}$/.test(args[k]))
    || !/^gemini-[a-z0-9][a-z0-9._-]{0,127}$/.test(args.model)) stop('ARGS');
}

/** @param {GeminiAuth} auth @returns {string[]} */
function needled(auth) {
  const needles = auth.dlpNeedles();
  if (!Array.isArray(needles) || !needles.length || needles.some(n => typeof n !== 'string' || n.length < 4)) stop('DLP_SOURCE');
  return needles.flatMap(escapeForms);
}

function processCount() {
  const r = spawnSync('/bin/ps', ['-u', String(process.getuid?.() ?? 0), '-o', 'pid='], { env: gitEnv(), encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) stop('PROCESS_COUNT');
  const lines = r.stdout.split('\n').filter(s => s.trim());
  if (!lines.length || lines.some(s => !/^\s*\d+\s*$/.test(s))) stop('PROCESS_COUNT');
  return lines.length;
}

// 先準備完整檔，再以不可覆寫的 hard link 公布；結果檔最後出現，不能指向半寫的內容。
/** @param {Buffer} bytes @param {object} receipt @param {string} outFile */
function publish(bytes, receipt, outFile) {
  const suffix = '.partial-' + randomBytes(16).toString('hex');
  const resultTemp = outFile + suffix, receiptFile = outFile + '.receipt.json', receiptTemp = receiptFile + suffix;
  let receiptLinked = false, resultLinked = false;
  const durable = (path, data) => { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); } };
  try {
    durable(resultTemp, bytes); durable(receiptTemp, JSON.stringify(receipt, null, 2) + '\n');
    linkSync(receiptTemp, receiptFile); receiptLinked = true;
    linkSync(resultTemp, outFile); resultLinked = true;
  } catch { if (receiptLinked && !resultLinked) rmSync(receiptFile); stop('OUTPUT'); }
  finally { for (const path of [resultTemp, receiptTemp]) rmSync(path, { force: true }); }
}

/** @param {ScanArgs} args @param {ScanDeps} [deps] */
export async function runGeminiScan(args, deps = {}) {
  let box, liveDir, stopped = false, interrupted = false, pre, material, output, receipt;
  /** @type {GeminiRelay|undefined} */ let relay;
  /** @type {number|undefined} */ let pid;
  /** @type {GeminiAuth} */ let auth;
  /** @type {MaterialManifest} */ let manifest;
  /** @type {string[]} */ let forms = [];
  /** @type {ChildResult} */ let childResult;
  /** @type {((code:string)=>void)|undefined} */ let stopChild;
  /** @type {ScanError|undefined} */ let failure;
  let streamIncident = false, sweepCount = 0;
  /** @type {string[]} */ const failures = [];
  /** @param {ScanError} error */
  const rememberFailure = error => { failures.push(error.code); if (!failure || (!failure.incident && error.incident)) failure = error; };
  const git = deps.git ?? runGit, provider = deps.providerRoot ?? PROVIDER_ROOT;
  const kill = deps.killGroupAndWait ?? killGroupAndWait, sweep = deps.sweepEscapees ?? sweepEscapees;
  const startedAt = new Date().toISOString();
  const checkSignal = () => { if (interrupted) stop('SIGNAL'); };
  const emergency = () => { interrupted = true; stopChild?.('SIGNAL'); };
  process.on('SIGTERM', emergency); process.on('SIGINT', emergency);
  const finishProcesses = async () => {
    if (stopped) return;
    await kill(pid ?? null);
    if (box && pid) {
      const messages = [];
      sweepCount = sweep(box, message => messages.push(message));
      if (!Number.isSafeInteger(sweepCount) || sweepCount < 0 || (messages.length && sweepCount === 0)) stop('CLEANUP');
    }
    stopped = true;
  };
  try {
    if (typeof args?.clientSourceRoot !== 'string' || !args.clientSourceRoot) stop('CLIENT_SOURCE');
    validateArgs(args); pre = verifyProvider(provider, args.providerHead, { git });
    material = buildScanMaterials(args, { git });
    box = realpathSync(mkdtempSync(join(deps.boxRoot ?? BOX_ROOT, 'gemini-scan-')));
    for (const dir of ['scripts', 'lib', 'tmp', 'results']) mkdirSync(join(box, dir), { mode: 0o700 });
    for (const path of ['scripts/gemini-client.js', 'lib/is-main.js', 'package.json']) writeFileSync(join(box, path), pre.payloads.get(path), { flag: 'wx', mode: 0o600 });
    const port = await (deps.freePort ?? freePort)(); checkSignal();
    const canary = await (deps.runCanary ?? runCanary)(box, { relayPort: port }); checkSignal();
    if (canary.code !== 0 || !Array.isArray(canary.lines) || !canary.lines.length) stop('CANARY');
    try { auth = await (deps.loadAuth ?? loadGeminiAuth)({ clientSourceRoot: args.clientSourceRoot }); }
    catch (error) { if (error instanceof Error && error.message === 'GEMINI_AUTH_CLIENT_SOURCE') stop('CLIENT_SOURCE'); throw error; }
    checkSignal();
    const quota = auth.quota();
    if (!Array.isArray(quota)) stop('QUOTA');
    const available = quota.filter(q => q.modelId === args.model);
    if (available.length !== 1 || !Number.isFinite(available[0].remainingFraction) || available[0].remainingFraction <= 0 || available[0].remainingFraction > 1) stop('QUOTA');
    forms = needled(auth);
    if (forms.some(n => material.text.includes(n))) stop('MATERIAL_DLP', true);
    const liveSecret = 'GEMINI-LIVE-' + randomBytes(32).toString('hex'); forms.push(...escapeForms(liveSecret));
    liveDir = mkdtempSync(join(deps.liveRoot ?? homedir(), '.gemini-live-canary-'));
    writeFileSync(join(liveDir, 'store.db'), liveSecret + '\n', { flag: 'wx', mode: 0o600 });
    const scanId = randomBytes(16).toString('hex'), nonce = randomBytes(32).toString('hex');
    manifest = { schema: 'gemini-scan-material/v1', scanId, base: args.base, head: args.head, model: args.model, thinking: 'HIGH', materialSha256: material.materialSha256, materialBytes: material.materialBytes };
    const manifestBytes = Buffer.from(JSON.stringify(manifest) + '\n');
    if (forms.some(n => manifestBytes.includes(n))) stop('MATERIAL_DLP', true);
    writeFileSync(join(box, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(box, 'materials.txt'), material.text, { flag: 'wx', mode: 0o600 });
    relay = await (deps.startRelay ?? startGeminiRelay)({ nonce, port, scanId, model: args.model, thinking: 'HIGH', materialSha256: material.materialSha256, materialBytes: material.materialBytes, project: auth.project, getAccessToken: auth.getAccessToken });
    if (relay.port !== port || relay.url !== `http://127.0.0.1:${port}/generate` || relay.snapshot().failed) stop('RELAY');
    const count = (deps.processCount ?? processCount)(); if (!Number.isSafeInteger(count) || count < 1) stop('PROCESS_COUNT');
    const ulimits = `ulimit -f ${64 * 1024} -u ${count + 256} -t 1800 || exit 97`;
    const sbArgv = ['-f', PROFILE, '-D', `SCAN_DIR=${box}`, '-D', `RELAY_PORT=${port}`];
    const clientArgv = [process.execPath, join(box, 'scripts/gemini-client.js'), '--manifest', join(box, 'manifest.json'), '--materials', join(box, 'materials.txt'), '--out', join(box, 'results/result.json'), '--endpoint', relay.url, '--nonce', nonce];
    const argv = ['-c', `${ulimits}; exec /usr/bin/sandbox-exec "$@"`, 'gemini-scan-sh', ...sbArgv, ...clientArgv];
    const activeRelay = relay;
    childResult = await new Promise((resolveChild) => {
      let finished = false;
      /** @type {string|undefined} */ let terminationReason;
      /** @type {NodeJS.Timeout|undefined} */ let timer = undefined, monitor = undefined;
      const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 }, tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      /** @param {{status:number|null,signal:string|null}} result */
      const finish = (result) => { if (finished) return; finished = true; clearTimeout(timer); clearInterval(monitor); stopChild = undefined; resolveChild({ ...result, ...(terminationReason ? { status: null, signal: terminationReason } : {}), stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr) }); };
      stopChild = (code) => { if (terminationReason || finished) return; terminationReason = code; kill(pid ?? null).then(() => finish({ status: null, signal: code }), () => finish({ status: null, signal: 'CLEANUP' })); };
      const child = (deps.spawn ?? spawn)('/bin/sh', argv, { cwd: box, env: sandboxEnv(box), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      pid = child.pid;
      for (const channel of ['stdout', 'stderr']) child[channel].on('data', data => {
        const bytes = Buffer.from(data); sizes[channel] += bytes.length;
        try {
          forms = [...new Set([...forms, ...needled(auth)])];
          const joined = Buffer.concat([tails[channel], bytes]);
          if (forms.some(n => joined.includes(n))) { streamIncident = true; stopChild?.('DLP'); }
          const overlap = Math.max(...forms.map(n => Buffer.byteLength(n))) - 1;
          tails[channel] = Buffer.from(joined.subarray(Math.max(0, joined.length - overlap)));
        } catch { stopChild?.('DLP_SOURCE'); }
        if (sizes[channel] > OUTPUT_CAP) { stopChild?.('OUTPUT_SIZE'); return; }
        chunks[channel].push(bytes);
      });
      child.once('error', () => finish({ status: null, signal: 'CHILD' }));
      child.once('close', (status, signal) => finish({ status, signal }));
      const wallMs = deps.wallMs ?? GEMINI_WALL_MS;
      if (!pid || !Number.isSafeInteger(wallMs) || wallMs < 1 || wallMs > GEMINI_WALL_MS) { stopChild('CHILD'); return; }
      timer = setTimeout(() => stopChild?.('TIMEOUT'), wallMs);
      monitor = setInterval(() => { try { if (activeRelay.snapshot().failed) stopChild?.('RELAY'); } catch { stopChild?.('RELAY'); } }, 25);
    });
    await finishProcesses(); await relay.close();
    const trusted = relay.snapshot();
    const known = new Set();
    for (const candidate of [material.text, ...material.shapeSources]) for (const form of escapeForms(candidate)) for (const hit of shapeMatchesIn(form)) known.add(hit.hit);
    /** @param {Buffer[]} raw */
    const inspectEvidence = raw => {
      // 已取得的證據先記帳；後續列名／讀檔失敗不能抹掉已命中的事故。
      if (forms.some(n => material.text.includes(n)) || raw.some(bytes => forms.some(n => bytes.includes(n)))) rememberFailure(new ScanError('DLP', true));
      for (const bytes of raw) {
        try {
          if (shapeMatchesIn(stripLineMarkers(utf8(bytes))).some(h => !known.has(h.hit) && !material.text.includes(h.hit))) rememberFailure(new ScanError('BREACH', true));
        } catch { rememberFailure(new ScanError('INCOMPLETE')); }
      }
    };
    const independent = [childResult.stdout, childResult.stderr, Buffer.from(JSON.stringify(trusted.response ?? null)), Buffer.from(trusted.response?.reply ?? '')];
    inspectEvidence(independent);
    forms = [...new Set([...forms, ...needled(auth)])];
    inspectEvidence(independent);
    // 根捷徑必須在列名之前拒絕；保留既有 reader 的檔案系統競態射程。
    const resultRoot = join(box, 'results'), resultStat = lstatSync(resultRoot);
    if (!resultStat.isDirectory() || resultStat.isSymbolicLink() || realpathSync(resultRoot) !== resultRoot || realpathSync(box) !== box) stop('ODD_OUTPUT', true);
    const names = readdirSync(resultRoot, { encoding: 'buffer', withFileTypes: true });
    inspectEvidence(names.map(e => e.name));
    // 內容只讀這一趟；查核與保存共用這些 bytes，列名不讀內容。
    const snap = (deps.readSessionsOnce ?? /** @type {SessionReader} */ (readSessionsOnce))(resultRoot, { files: 2, depth: 1, fileBytes: MAX_RESPONSE_BYTES, totalBytes: MAX_RESPONSE_BYTES });
    inspectEvidence([...snap.odd.map(s => Buffer.from(s)), ...[...snap.files.keys()].map(s => Buffer.from(s)), ...snap.files.values()]);
    if (failure) throw failure;
    if (snap.odd.length) stop('ODD_OUTPUT', true);
    if (names.length !== 1 || !names[0].isFile() || utf8(names[0].name) !== 'result.json') stop('RESULT');
    checkSignal();
    if (childResult.status !== 0 || childResult.signal || trusted.failed || trusted.requestCount !== 1) stop('EXECUTION');
    if (snap.files.size !== 1 || !snap.files.has('result.json')) stop('RESULT');
    output = snap.files.get('result.json');
    if (!output) stop('RESULT');
    const result = validateResult(JSON.parse(utf8(output)), manifest);
    if (!output.equals(Buffer.from(JSON.stringify(trusted.response) + '\n')) || JSON.stringify(result) !== JSON.stringify(trusted.response)) stop('RESULT');
    if (!readRegular(join(box, 'materials.txt'), MAX_MATERIAL_BYTES).bytes.equals(Buffer.from(material.text))
      || !readRegular(join(box, 'manifest.json'), 16384).bytes.equals(manifestBytes)) stop('MATERIAL_CHANGED');
    receipt = { schema: 'gemini-scan-receipt/v1', completionCheck: 'matching output bytes required', base: args.base, head: args.head, providerHead: args.providerHead, providerDigest: pre.digest, providerFiles: pre.files, model: args.model, thinking: 'HIGH', scanId, materialScope: MATERIAL_SCOPE, materialSha256: material.materialSha256, materialBytes: material.materialBytes, materialFiles: material.files, profileSha256: sha256(pre.payloads.get('scripts/grok-sandbox.sb')), canary: { code: 0, checks: canary.lines.length }, requestCount: trusted.requestCount, processCleanup: { groupStopped: true, swept: sweepCount, limitation: 'lsof sweep is best-effort; no claim that all IPC or escaped processes are contained' }, outputSha256: sha256(output), startedAt, endedAt: new Date().toISOString() };
    if (forms.some(n => JSON.stringify(receipt).includes(n))) stop('DLP', true);
  } catch (error) { rememberFailure(error instanceof ScanError ? error : new ScanError('INCOMPLETE')); }
  finally {
    try { await finishProcesses(); } catch { rememberFailure(new ScanError('CLEANUP')); }
    try { await relay?.close(); } catch { rememberFailure(new ScanError('CLEANUP')); }
    try { if (pre && verifyProvider(provider, args.providerHead, { git }).digest !== pre.digest) stop('PROVIDER'); } catch { rememberFailure(new ScanError('PROVIDER')); }
    try { if (liveDir) rmSync(liveDir, { recursive: true, force: true }); if (box && stopped) rmSync(box, { recursive: true, force: true }); } catch { rememberFailure(new ScanError('CLEANUP')); }
    process.off('SIGTERM', emergency); process.off('SIGINT', emergency);
  }
  if (streamIncident) rememberFailure(new ScanError('DLP', true));
  if (interrupted) rememberFailure(new ScanError('SIGNAL'));
  const finalFailure = /** @type {ScanError|undefined} */ (failure);
  if (finalFailure || !output || !receipt) return { code: finalFailure?.incident ? 1 : 2, summary: [finalFailure?.code === 'CLIENT_SOURCE' ? 'GEMINI_SCAN_CLIENT_SOURCE：缺可信官方來源定位；請使用已固定的盒外發射器。' : `GEMINI_SCAN_${finalFailure?.code ?? 'INCOMPLETE'}：未完成；核對固定來源與隔離收據後重新準備。`], reasons: [...new Set(failures)] };
  try { publish(output, receipt, args.outFile); } catch { return { code: 2, summary: ['GEMINI_SCAN_OUTPUT：未保存結果；核對輸出位置與既有檔。'] }; }
  return { code: 0, summary: ['Gemini 靜態材料回覆及掃後核對完成；未在盒內執行考題，也不是正式複審結論。'], receipt };
}

/** @param {string[]} args @returns {ScanArgs} */
export function parseScanArgs(args) {
  const names = { '--repo': 'repo', '--base': 'base', '--head': 'head', '--prompt': 'promptFile', '--out': 'outFile', '--model': 'model', '--provider-head': 'providerHead' }, result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i]], value = args[i + 1];
    if (!Object.hasOwn(names, args[i]) || Object.hasOwn(result, key) || !value || value.startsWith('--')) stop('ARGS');
    result[key] = value;
  }
  validateArgs(/** @type {ScanArgs} */ (result)); return /** @type {ScanArgs} */ (result);
}

if (isMainModule(import.meta.url)) {
  try {
    const args = parseScanArgs(process.argv.slice(2)), result = await runGeminiScan(args);
    process.stdout.write(JSON.stringify({ code: result.code, summary: result.summary, ...(result.code === 0 ? { receiptFile: basename(args.outFile) + '.receipt.json' } : {}) }) + '\n');
    process.exitCode = result.code;
  } catch { process.stderr.write('GEMINI_SCAN_ARGS：核對必要固定參數後重新準備。\n'); process.exitCode = 2; }
}
