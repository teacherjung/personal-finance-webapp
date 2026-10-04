// @ts-check
// 自動讀取預算是專案指示鏈合計；詳細規則以一般文件名稱路由，避免根入口被截斷。
// 入口是否遮住共同規則取決於檔案存在，不取決於是否進版控；因此連被忽略檔也要查。
// git ls-files 的 --exclude-standard 會漏掉這一類，故此存在性檢查刻意走訪目錄。
// 這不同於 production 程式的架構掃描；劃界記在雲端與安全契約「解析器資源上限與行程隔離」。
// 不讀被掃檔案內容、不跟隨目錄 symlink；其他被忽略目錄裡的舊專案副本仍會被報出。
// 外部相依與巢狀工作樹有自己的規則入口，不屬於這棵專案的檔案。
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('共同入口不超過 28,000 UTF-8 bytes，保留預設 32 KiB 指示鏈的餘裕', () => {
  const bytes = readFileSync(join(ROOT, 'AGENTS.md')).byteLength;
  assert.ok(bytes > 0 && bytes <= 28_000, `AGENTS.md 實得 ${bytes} bytes；須在 1–28,000 bytes 內，細節請搬到路由文件。`);
});

test('專案不得有 CLAUDE.md 或 CLAUDE.local.md，包含 .claude 與未追蹤檔', () => {
  const forbidden = [];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(ROOT, path);
      if (/^claude(?:\.local)?\.md$/i.test(entry.name)) forbidden.push(rel);
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules' && rel !== '.claude/worktrees') walk(path);
    }
  }
  walk(ROOT);
  assert.deepEqual(forbidden, [], `這些入口會妨礙 Claude 自動讀共同入口：${forbidden.join('、')}`);
});

test('檔名檢查的邊界：獨立工作樹誘餌不誤擋，專案入口與忽略檔仍會被擋', (t) => {
  // 在樹外造純檔案夾具，不建 Git 倉庫、不碰真實工作樹；子行程只跑上面的檔名題。
  const fixture = mkdtempSync(join(tmpdir(), 'agents-entry-scope-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const put = (path, content) => {
    const file = join(fixture, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  put('package.json', '{"type":"module"}');
  put('AGENTS.md', '# Synthetic project rules\n');
  put('test/agents-entry.test.js', '');
  copyFileSync(fileURLToPath(import.meta.url), join(fixture, 'test/agents-entry.test.js'));
  put('.gitignore', 'tmp/\n.claude/worktrees/\n');
  put('.claude/worktrees/_probe/CLAUDE.md', '# Another worktree\n');
  const run = () => spawnSync(process.execPath,
    ['--test', '--test-reporter=spec', '--test-name-pattern=^專案不得有', 'test/agents-entry.test.js'],
    { cwd: fixture, env: { PATH: process.env.PATH, HOME: fixture }, encoding: 'utf8', timeout: 10000 });
  const excluded = run();
  assert.equal(excluded.status, 0, excluded.stdout + excluded.stderr);
  assert.match(excluded.stdout, /專案不得有/);
  for (const forbidden of ['.claude/CLAUDE.md', 'tmp/CLAUDE.local.md']) {
    put(forbidden, '# Forbidden project entry\n');
    const found = run();
    assert.equal(found.status, 1, found.stdout + found.stderr);
    assert.ok((found.stdout + found.stderr).includes(forbidden), `沒有回報 ${forbidden}`);
    assert.match(found.stdout + found.stderr, /ERR_ASSERTION/);
    rmSync(join(fixture, forbidden));
  }
});
