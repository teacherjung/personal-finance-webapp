import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIN_NODE_VERSION,
  isSupportedNodeVersion,
  parseNodeVersion
} from '../scripts/check-node-version.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('Node 版本檢查守住 22.13.0 邊界', () => {
  assert.equal(isSupportedNodeVersion('22.12.9'), false);
  assert.equal(isSupportedNodeVersion('v22.13.0'), true);
  assert.equal(isSupportedNodeVersion('22.13.1'), true);
  assert.equal(isSupportedNodeVersion('23.0.0'), true);
  assert.equal(isSupportedNodeVersion('21.99.99'), false);
});

test('Node 版本格式異常時拒絕，不可誤判成可啟動', () => {
  assert.deepEqual(parseNodeVersion('v22.13.0'), [22, 13, 0]);
  assert.deepEqual(parseNodeVersion('22.13.0-nightly'), [22, 13, 0]);
  assert.equal(parseNodeVersion('22.13'), null);
  assert.equal(isSupportedNodeVersion('unknown'), false);
});

test('package.json 的 engines 與啟動檢查共用同一最低版本', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines?.node, `>=${MIN_NODE_VERSION}`);
});
