// @ts-check
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';

const labDir = fileURLToPath(new URL('.', import.meta.url));
const tsc = fileURLToPath(new URL('../../node_modules/.bin/tsc', import.meta.url));

test('根層 npm test 也會實跑森林 UI 原型的型別校對', () => {
  const result = spawnSync(tsc, ['-p', 'jsconfig.json'], { cwd: labDir, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
