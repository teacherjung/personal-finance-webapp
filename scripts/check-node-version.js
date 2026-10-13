// @ts-check
import { readFileSync } from 'node:fs';
import { isMainModule } from '../lib/is-main.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const supportedRange = String(pkg.engines?.node || '');
const engineMatch = supportedRange.match(/^\^(\d+\.\d+\.\d+) \|\| >=(\d+\.\d+\.\d+)$/);
if (!engineMatch) throw new Error('package.json 的 engines.node 必須使用「^主版.次版.修正版 || >=主版.次版.修正版」格式');
export const MIN_NODE_VERSION = engineMatch[1];
const NEXT_NODE_VERSION = engineMatch[2];

/** @param {string} value @returns {[number, number, number] | null} */
export function parseNodeVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** @param {string} value */
export function isSupportedNodeVersion(value) {
  // parse 可讀預發行標記；engines 的正式版本範圍不因此納入預發行版。
  if (String(value).split('+')[0].includes('-')) return false;
  const current = parseNodeVersion(value);
  const minimum = parseNodeVersion(MIN_NODE_VERSION);
  const next = parseNodeVersion(NEXT_NODE_VERSION);
  if (!current || !minimum || !next) return false;
  const floor = current[0] === minimum[0] ? minimum : next;
  for (let i = 0; i < floor.length; i++) {
    if (current[i] !== floor[i]) return current[i] > floor[i];
  }
  return true;
}

const isMain = isMainModule(import.meta.url);

if (isMain && !isSupportedNodeVersion(process.versions.node)) {
  console.error(
    `無法啟動：這個 app 支援 Node.js ${supportedRange}（不支援 Node 23），` +
    `目前是 v${process.versions.node}。\n` +
    '請先到 https://nodejs.org 安裝新版 Node.js，再重新雙擊 start.command。'
  );
  process.exitCode = 1;
}
