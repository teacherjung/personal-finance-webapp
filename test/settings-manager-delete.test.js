import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

const source = fileURLToPath(new URL('../', import.meta.url));
for (const manager of ['bank', 'text']) {
  for (const mode of ['normal', 'cancel', 'cancel-retry', 'confirm-window', 'confirm-hash', 'confirm-reenter', 'double', 'other', 'other-error', 'closed', 'hash', 'hash-before', 'row-before', 'root', 'navigate-return', 'background', 'stale-row', 'successive', 'unknown-written', 'unknown-unwritten', 'read-failure', 'read-other', 'read-hash']) {
    test(`設定管理刪除｜${manager}/${mode}`, t => {
      const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'settings-delete-')));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const result = spawnSync(process.execPath, [join(source, 'test/helpers/settings-manager-delete-case.js')], {
        cwd: root, env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root,
          SETTINGS_DELETE_SOURCE: source, SETTINGS_DELETE_MANAGER: manager, SETTINGS_DELETE_MODE: mode },
        encoding: 'utf8', timeout: 30000, maxBuffer: 2e6,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /SETTINGS_DELETE_CASE_PASSED/);
    });
  }
}
