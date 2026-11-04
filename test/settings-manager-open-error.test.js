import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitEnv } from '../lib/git-env.js';

// fetch 與 DOM 為合成替身；本卷不提供 HTTP、資料庫保存或原生版面證據。
const source = fileURLToPath(new URL('../', import.meta.url));
for (const entry of ['expense', 'income', 'recipes', 'bank', 'text', 'transfer']) {
  test(`設定管理同步開窗例外｜無 TCP｜${entry}`, t => {
    const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'settings-open-error-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [join(source, 'test/helpers/settings-manager-open-error-case.js')], {
      cwd: root,
      env: { ...gitEnv(), NOTEASY_HOSTED: '', STORE_FILE: join(root, 'synthetic.db'), TMPDIR: root,
        SETTINGS_OPEN_ERROR_SOURCE: source, SETTINGS_OPEN_ERROR_ENTRY: entry },
      encoding: 'utf8', timeout: 30000, maxBuffer: 2e6,
    });
    assert.equal(result.status, 0, '設定管理同步開窗例外：' + result.stdout + result.stderr);
    assert.match(result.stdout, /SETTINGS_OPEN_ERROR_CASE_PASSED/);
  });
}
