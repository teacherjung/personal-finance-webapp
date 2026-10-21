// @ts-check
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEXT_BYTES = 64 * 1024;

/** @param {string} text */
function bounded(text) {
  const bytes = Buffer.from(text);
  return { text: bytes.subarray(0, TEXT_BYTES).toString('utf8'), bytes: bytes.length,
    truncated: bytes.length > TEXT_BYTES, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * 驗證拒收後仍要清夾具；另存有界診斷以免 finally 連原因一起消失。
 * 截短欄位不能重建完整輸出；本函式不替呼叫端過濾公開文字。
 * @param {{code: number|null, signal: string|null, output: string, report: string}} result
 * @param {any[]} events
 * @param {unknown} error
 */
export function saveLifecycleFailure(result, events, error) {
  const roots = events.filter(event => typeof event.root === 'string')
    .map(event => ({ root: event.root, exists: existsSync(event.root) }));
  const record = {
    version: 1,
    child: { code: result.code, signal: result.signal },
    output: bounded(result.output), report: bounded(result.report),
    events: bounded(JSON.stringify(events)), roots: bounded(JSON.stringify(roots)),
    verification: bounded(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
  };
  const directory = mkdtempSync(join(tmpdir(), 'fixture-lifecycle-failure-'));
  try {
    chmodSync(directory, 0o700);
    const file = join(directory, 'evidence.json');
    writeFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
    return file;
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
