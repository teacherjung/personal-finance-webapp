// @ts-check
// 自動讀取預算是專案指示鏈合計；詳細規則以一般文件名稱路由，避免根入口被截斷。
// 檔名檢查包含未追蹤與被忽略的專案檔；不讀檔案內容、不跟隨目錄 symlink。
// 外部相依與巢狀工作樹有自己的規則入口，不屬於這棵專案的檔案。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
