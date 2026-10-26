import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

const source = fileURLToPath(new URL('../', import.meta.url));
for (const entry of ['expense', 'income', 'recipes', 'bank', 'text', 'transfer']) {
  for (const mode of ['normal', 'populated', 'other', 'other-error', 'closed', 'hash', 'hash-entry', 'navigate-return', 'root', 'view', 'background', 'stale-button', 'retry', 'cross-old-first', 'cross-new-first', 'cross-new-error', 'same-old-first', 'same-new-first', 'same-new-error']) {
    test(`設定管理初載｜${entry}/${mode}`, t => {
      const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'settings-entry-')));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const result = spawnSync(process.execPath, [join(source, 'test/helpers/settings-manager-entry-case.js')], {
        cwd: root, env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root,
          SETTINGS_ENTRY_SOURCE: source, SETTINGS_ENTRY: entry, SETTINGS_ENTRY_MODE: mode },
        encoding: 'utf8', timeout: 30000, maxBuffer: 2e6,
      });
      assert.equal(result.status, 0, '設定管理初載：' + result.stdout + result.stderr);
      assert.match(result.stdout, /SETTINGS_ENTRY_CASE_PASSED/);
    });
  }
}
