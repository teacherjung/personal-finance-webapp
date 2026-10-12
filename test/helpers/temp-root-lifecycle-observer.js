// @ts-check
// 觀察實際建立結果，避免漏登記的根也從「待清清單」與證據一起消失。
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { after, afterEach } from 'node:test';
import { join, sep } from 'node:path';

const log = process.env.FIXTURE_LIFECYCLE_LOG;
const scope = process.env.FIXTURE_LIFECYCLE_SCOPE;

if (log && scope && process.env.NODE_TEST_CONTEXT?.startsWith('child')) {
  const original = fs.mkdtempSync;
  const originalWrite = fs.writeFileSync;
  const control = original(join(scope, 'unregistered-'));
  const sentinel = join(control, 'sentinel.txt');
  const value = process.env.FIXTURE_LIFECYCLE_CONTROL_VALUE;
  if (!value) throw new Error('Missing exclusive lifecycle control value');
  fs.writeFileSync(sentinel, value);
  const record = (/** @type {object} */ event) => fs.appendFileSync(log, JSON.stringify(event) + '\n');
  record({ control, sentinel });
  const roots = /** @type {string[]} */ ([]);
  fs.mkdtempSync = (prefix, options) => {
    const result = original(prefix, options);
    const root = String(result);
    roots.push(root);
    record({ root });
    return result;
  };
  syncBuiltinESMExports();

  let failed = false;
  fs.writeFileSync = (path, data, options) => {
    const name = String(path);
    if (process.env.FIXTURE_LIFECYCLE_FAIL === 'victim-write'
      && name.startsWith(join(scope, 'victim-')) && name.endsWith(sep + 'store.db') && !failed) {
      failed = true;
      record({ failureAfterRoots: roots.filter((p) => fs.existsSync(p)).length });
      throw new Error('Deliberate fixture lifecycle failure after creation');
    }
    return originalWrite(path, data, options);
  };
  syncBuiltinESMExports();
  afterEach(() => {
    // 能力探測可能先建立又立即收掉根；故意失敗要等受測夾具確實在場。
    const present = roots.filter((root) => root.startsWith(scope + sep) && fs.existsSync(root));
    record({ afterEachObserved: true, fixtureRootsPresent: present.length });
    if (process.env.FIXTURE_LIFECYCLE_FAIL === '1' && present.length && !failed) {
      failed = true;
      record({ failureAfterRoots: present.length });
      throw new Error('Deliberate fixture lifecycle failure after creation');
    }
  });
  // --import 先於考題載入，所以此 hook 在考題自己的 after 收尾之前執行。
  after(() => {
    const root = roots.find((p) => p.startsWith(scope + sep) && fs.existsSync(p));
    if (root) {
      const link = join(root, 'lifecycle-control-link');
      fs.symlinkSync(control, link);
      record({ link, linkedRoot: root });
    }
    fs.mkdtempSync = original;
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  });
}
