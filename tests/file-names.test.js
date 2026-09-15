// 守檔名（規矩 E6）：版本控制追蹤的每一個路徑，只用英文字母、數字、半形符號。
//
// 為什麼：原專案的中文檔名讓掃描器跳過過整個檔（套件倉庫的案例簿 scanner-skipped-non-ascii-paths）；
// 路徑一有非 ASCII，工具鏈裡每一環都可能各自出錯，而且錯得靜靜的。
// 守得到的：已追蹤路徑含非可見 ASCII（含空白）就紅；例外名單**寫死在這裡**（規矩 E7）、只出不進，本倉庫是空的。
// ⚠️ 守不到的：未追蹤的檔；名字對不對得起內容。列檔走清過 GIT_ 的環境（規矩 E4）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');

const ROOT = path.join(__dirname, '..');
/** 既有的例外，只出不進（本倉庫沒有）。 */
const FROZEN_EXCEPTIONS = [];
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;

test('已追蹤的每一個路徑只用英文字母、數字、半形符號（例外名單只出不進）', () => {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', env: gitEnv() });
  assert.equal(r.status, 0, `列不出追蹤的檔：${r.stderr}`);
  const files = r.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 20, `只列到 ${files.length} 個檔：這一題自己的前提變了`);
  const bad = files.filter((f) => !VISIBLE_ASCII.test(f) && !FROZEN_EXCEPTIONS.includes(f));
  assert.deepEqual(bad, [], `這些路徑含非 ASCII 或空白：\n${bad.join('\n')}`);
  for (const f of FROZEN_EXCEPTIONS) assert.ok(files.includes(f), `例外名單裡的 ${f} 已經不在了：把它從名單拿掉（只出不進）`);
});
