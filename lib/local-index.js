// @ts-check
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 只派生公有 index；不接收資料檔位置，也不接管宿主的監聽或信號。 @param {string} publicDir */
export function createLocalIndex(publicDir) {
  const source = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const target = '<div class="foot-note">資料存於本機<br><code>data/store.db</code></div>';
  if (source.split(target).length !== 2) throw new Error('LOCAL 側欄投影目標必須恰有一處');
  const projected = source.replace(target, target.replace('data/store.db', 'SQLite 資料庫'));
  const owned = mkdtempSync(join(tmpdir(), 'finance-local-index-'));
  const cleanup = () => {
    try { rmSync(owned, { recursive: true, force: true }); }
    catch { /* exit 只能盡力同步清理；異常終止亦可能留下公有投影。 */ }
  };
  try {
    writeFileSync(join(owned, 'index.html'), projected, { flag: 'wx', mode: 0o600 });
    process.once('exit', cleanup);
    return owned;
  } catch (error) {
    cleanup();
    throw error;
  }
}
