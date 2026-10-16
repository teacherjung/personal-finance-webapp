// @ts-check
// 呼叫者擁有已隔離、detached 的子程序。此模組不選來源、不啟動程序、不授予認證。
import { isMainModule } from '../lib/is-main.js';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_WIRE_BYTES, OUTPUT_CAP, NATIVE_LIMITS } from './gemini-native-protocol.js';
import { killGroupAndWait } from './grok-scan.js';

/** @param {import('node:stream').Writable} destination @param {Buffer} bytes @param {{signal?:AbortSignal}} options */
export async function writeNativeInput(destination, bytes, { signal } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_WIRE_BYTES) throw Error('GEMINI_NATIVE_STDIN_SIZE');
  if (!(signal instanceof AbortSignal)) throw Error('GEMINI_NATIVE_LIFETIME_REQUIRED');
  try { await pipeline(Readable.from([bytes]), destination, { signal }); }
  catch { throw Error(signal.aborted ? 'GEMINI_NATIVE_ABORTED' : 'GEMINI_NATIVE_STDIN_FAILED'); }
}

// 收尾只證明已知程序群清空；離群程序與 OS 隔離必須由未完成的正式發射器另驗。
/** @param {import('node:child_process').ChildProcessWithoutNullStreams} child @param {Buffer} bytes @param {{signal?:AbortSignal,wallMs?:number}} options */
export async function collectNativeProcess(child, bytes, { signal, wallMs = NATIVE_LIMITS.wallMs } = {}) {
  const pid = child?.pid;
  if (!(signal instanceof AbortSignal) || !Number.isSafeInteger(wallMs) || wallMs < 1 || wallMs > NATIVE_LIMITS.wallMs
    || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1 || !child.stdin || !child.stdout || !child.stderr) throw Error('GEMINI_NATIVE_PROCESS_CONTRACT');
  const controller = new AbortController();
  const chunks = { stdout: [], stderr: [] };
  let size = 0, reason = '', cleanup, cleanupError;
  const terminate = code => {
    if (!reason) reason = code;
    controller.abort();
    cleanup ??= killGroupAndWait(pid).then(() => true, error => { cleanupError = error; return false; });
  };
  const read = name => chunk => {
    if (reason) return;
    size += chunk.length;
    if (size > OUTPUT_CAP) { terminate('OUTPUT_SIZE'); return; }
    chunks[name].push(Buffer.from(chunk));
  };
  const onOut = read('stdout'), onErr = read('stderr');
  const onAbort = () => terminate('ABORTED');
  const onError = () => terminate('PROCESS_ERROR');
  let resolveClose;
  const closed = new Promise(resolve => { resolveClose = resolve; });
  const onClose = (code, childSignal) => resolveClose({ code, signal: childSignal });
  child.stdout.on('data', onOut); child.stderr.on('data', onErr);
  child.on('error', onError); child.once('close', onClose);
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => terminate('TIMEOUT'), wallMs);
  let closeTimer;
  try {
    if (signal.aborted) onAbort();
    const writing = writeNativeInput(child.stdin, bytes, { signal: controller.signal }).catch(() => terminate('STDIN_FAILED'));
    // close 包含管線 EOF。若繼承 pipe 的離群程序讓 close 不來，拒收並回報清理不確定。
    const boundedClose = new Promise(resolve => {
      closeTimer = setTimeout(() => { terminate('CLOSE_TIMEOUT'); resolve(null); }, wallMs + 12_000);
    });
    const result = await Promise.race([closed, boundedClose]);
    controller.abort(); await writing;
    cleanup ??= killGroupAndWait(pid).then(() => true, error => { cleanupError = error; return false; });
    const groupCleared = await cleanup;
    if (!groupCleared || !result) throw Error('GEMINI_NATIVE_CLEANUP_UNCERTAIN', { cause: cleanupError });
    if (reason) throw Error(`GEMINI_NATIVE_${reason}`);
    return { ...result, stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr),
      timedOut: false, capped: false, groupCleared: true, escapedProcessesVerified: false, formalScan: false };
  } finally {
    clearTimeout(timer); clearTimeout(closeTimer); signal.removeEventListener('abort', onAbort);
    child.stdout.off('data', onOut); child.stderr.off('data', onErr); child.off('error', onError); child.off('close', onClose);
  }
}

if (isMainModule(import.meta.url)) {
  process.stderr.write('GEMINI_NATIVE_LIBRARY_ONLY\n'); process.exitCode = 2;
}
