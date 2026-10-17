// @ts-check
// 盒外信箱只接受固定檔名；原子公布讓讀者不會把半份 JSON 當成完成收件。
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, fsyncSync, realpathSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseUniqueJson, sha256 } from './gemini-native-protocol.js';
import { isMainModule } from '../lib/is-main.js';

export const browserError = code => { throw Error(`GEMINI_BROWSER_${code}`); };
export const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let expectedOwner = -1;
export let JOB_ROOT = '';
// 固定 loader 或普通 Node runner 提供部署擁有者；瀏覽器宿主不必取得 process 能力。
export function configureBrowserOwner(uid) {
  if (!Number.isSafeInteger(uid) || uid < 0 || (expectedOwner !== -1 && expectedOwner !== uid)) browserError('OWNER');
  expectedOwner = uid; JOB_ROOT = `/private/tmp/gemini-browser-jobs-${uid}`;
}
export const SOURCE_FILES = [
  'scripts/gemini-browser-files.js', 'scripts/gemini-browser-protocol.js', 'scripts/gemini-browser-client.js',
  'scripts/gemini-browser-runner.js', 'scripts/gemini-browser-cua.js', 'scripts/gemini-browser-canary.js',
  'scripts/gemini-browser-sandbox.sb', 'scripts/gemini-native-protocol.js', 'scripts/gemini-native-runner.js',
  'scripts/gemini-scan.js', 'scripts/grok-sandbox-canary.js', 'scripts/grok-sandbox.sb', 'scripts/grok-scan.js',
  'scripts/gemini-auth.js', 'scripts/gemini-client.js', 'scripts/gemini-relay.js', 'scripts/grok-auth-refresh.js',
  'scripts/grok-relay.js', 'scripts/grok-final-reply.js', 'scripts/audit-grok-scan.js',
  'lib/is-main.js', 'lib/git-env.js', 'package.json',
];
const identity = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.nlink].join(':');

export function privateDirectory(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || resolve(path) !== path || realpathSync(path) !== path) browserError('DIRECTORY');
  const s = lstatSync(path);
  if (!s.isDirectory() || s.uid !== expectedOwner || (s.mode & 0o077)) browserError('DIRECTORY');
  return path;
}

export function readBoundedFile(path, cap = 256 * 1024) {
  let fd;
  try {
    if (resolve(path) !== path || realpathSync(path) !== path) browserError('FILE_PATH');
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(expectedOwner)
      || (before.mode & 0o022n) || before.size > BigInt(cap)) browserError('FILE');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true });
    if (identity(before) !== identity(opened)) browserError('FILE_CHANGED');
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
    if (bytes.length !== Number(after.size) || bytes.length > cap || identity(after) !== identity(opened)
      || identity(after) !== identity(lstatSync(path, { bigint: true }))) browserError('FILE_CHANGED');
    return bytes;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function mailboxPath(dir, name) {
  privateDirectory(dir);
  if (!/^[a-z][a-z0-9-]*\.(json|txt|jpg)$/.test(name)) browserError('MAILBOX_NAME');
  return join(dir, name);
}
export const readMail = (dir, name) => parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(readBoundedFile(mailboxPath(dir, name))));

export function writeOnce(dir, name, value) {
  const path = mailboxPath(dir, name), lock = path + '.lock';
  mkdirSync(lock, { mode: 0o700 });
  const temp = join(dir, '.write-' + randomBytes(16).toString('hex'));
  let fd;
  try {
    try { lstatSync(path); browserError('EXISTS'); } catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e; }
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temp, { force: true }); }
}

export function jobDirectory(runId) {
  if (!/^[a-f0-9]{32}$/.test(runId)) browserError('RUN_ID');
  privateDirectory(JOB_ROOT);
  return privateDirectory(join(JOB_ROOT, runId));
}

export function mailExists(dir, name) {
  try { lstatSync(mailboxPath(dir, name)); return true; }
  catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return false; throw e; }
}

export function sourceDigest(root, paths) {
  if (typeof root !== 'string' || realpathSync(root) !== root || !Array.isArray(paths) || !paths.length) browserError('SOURCE');
  const rows = paths.map(path => {
    if (typeof path !== 'string' || (path !== 'package.json' && !/^(?:scripts|lib)\/[a-z0-9-]+\.(?:js|sb)$/.test(path))) browserError('SOURCE_PATH');
    const bytes = readBoundedFile(join(root, path), 2 * 1024 * 1024);
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  });
  return { rows, sha256: sha256(JSON.stringify(rows)) };
}

if (typeof process !== 'undefined' && isMainModule(import.meta.url)) { process.stderr.write('GEMINI_BROWSER_LIBRARY_ONLY\n'); process.exitCode = 78; }
