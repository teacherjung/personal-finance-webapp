// @ts-check
import { readFileSync } from 'node:fs';
import { isMainModule } from '../lib/is-main.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const engineMatch = String(pkg.engines?.node || '').match(/^>=(\d+\.\d+\.\d+)$/);
if (!engineMatch) throw new Error('package.json 的 engines.node 必須使用「>=主版.次版.修正版」格式');
export const MIN_NODE_VERSION = engineMatch[1];

/** @param {string} value @returns {[number, number, number] | null} */
export function parseNodeVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @param {string} value */
export function isSupportedNodeVersion(value) {
  const current = parseNodeVersion(value);
  const minimum = parseNodeVersion(MIN_NODE_VERSION);
  if (!current || !minimum) return false;
  for (let i = 0; i < minimum.length; i++) {
    if (current[i] !== minimum[i]) return current[i] > minimum[i];
  }
  return true;
}

const isMain = isMainModule(import.meta.url);

if (isMain && !isSupportedNodeVersion(process.versions.node)) {
  console.error(
    `無法啟動：這個 app 需要 Node.js ${MIN_NODE_VERSION} 或更新版本，` +
    `目前是 v${process.versions.node}。\n` +
    '請先到 https://nodejs.org 安裝新版 Node.js，再重新雙擊 start.command。'
  );
  process.exitCode = 1;
}
