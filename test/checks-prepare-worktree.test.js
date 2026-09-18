// @ts-check
// settings.json 的 checks.prepareWorktree（跨變更試合併閘備臨時樹的那一句）的行為題——2026-09-18 搬家第 7 步，
// 接替舊 test/cross-pr-merge.test.js 裡 lock↔node_modules 那一族的意圖：
//   臨時樹裡已經有 node_modules（目錄、連結、甚至斷掉的連結）＝退 3、**npm 一次都不叫**（不然 npm ci 會順著連結清掉別棵樹的套件
//   ＝CLAUDE.md 那條 2026-08-02 事故）；沒有＝跑 `npm ci --prefer-offline --no-audit --no-fund`。
// 套件考題只驗閘怎麼用這句（套件 tests/check-cross-merge.test.js），不驗本專案填的這句對不對——這裡用拋棄式目錄＋假 npm
// 真的把那句 `sh -c` 跑一遍。子行程用 gitEnv()（這句最後會 exec npm，npm 可能再去 spawn git），所以照 test/git-env.test.js 檔頭的規矩
// 有兩種 GIT_* 題（髒環境下答案不變、子行程看不到任何 GIT_*）。
// ⚠️ 證不到的：真 npm ci 裝得起來（那是網路與 lock 的事，合併時閘會真跑）；也證不到閘真的用了這句（那是套件考題的射程）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../lib/git-env.js';
import { injectDirtyGitEnv } from './helpers/dirty-git-env.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const settings = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8'));
const prep = /** @type {string[]} */ (settings.checks?.prepareWorktree);

test('形狀：sh -c 一句；句子裡有 npm ci --prefer-offline 與「已有 node_modules 就退 3」那段', () => {
  assert.ok(Array.isArray(prep) && prep.length === 3 && prep[0] === 'sh' && prep[1] === '-c',
    `settings.json 的 checks.prepareWorktree 不是 ['sh', '-c', 句子]：${JSON.stringify(prep)}`);
  assert.match(prep[2], /npm ci --prefer-offline/, '句子沒有 npm ci --prefer-offline');
  assert.match(prep[2], /exit 3/, '句子沒有「已有 node_modules 就退 3」那段');
});

/**
 * 在拋棄式目錄裡把那句真的跑一遍：PATH 最前面放一支假 npm（把收到的參數寫進記號檔、退 0），
 * setup 先佈置臨時樹，然後在臨時樹裡跑 prepareWorktree。回傳退出碼、stderr、假 npm 收到的參數（沒被叫＝null）。
 * @param {(tree: string, dir: string) => void} setup
 */
function runPrep(setup) {
  const dir = mkdtempSync(join(tmpdir(), 'pfw-prep-'));
  try {
    const bin = join(dir, 'fake-bin');
    mkdirSync(bin);
    const marker = join(dir, 'npm-called.txt');
    const envMarker = join(dir, 'npm-git-env.txt');
    // 假 npm：記下參數，另外把它看得到的 GIT_* 環境變數逐行記下（GIT_* 兩種題的第②種要看這個）
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\nenv | grep '^GIT_' > ${JSON.stringify(envMarker)} || true\nexit 0\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const tree = join(dir, 'tree');
    mkdirSync(tree);
    setup(tree, dir);
    const r = spawnSync(prep[0], prep.slice(1), { cwd: tree, encoding: 'utf8', env: { ...gitEnv(), PATH: `${bin}:${process.env.PATH ?? ''}` } });
    const called = existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : null;
    const gitVars = existsSync(envMarker) ? readFileSync(envMarker, 'utf8').split('\n').filter(Boolean) : null;
    return { status: r.status, stderr: String(r.stderr ?? ''), called, gitVars };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('⭐ 臨時樹已有 node_modules 目錄＝退 3、npm 一次都沒被叫、stderr 說明原因', () => {
  const r = runPrep((tree) => mkdirSync(join(tree, 'node_modules')));
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.called, null, `npm 被叫了：${r.called}`);
  assert.match(r.stderr, /node_modules/, '沒有說明是 node_modules 擋的');
});

test('⭐ node_modules 是指向別處的連結＝一樣退 3、不跑 npm ci（順著連結清掉別棵樹的套件＝事故）', () => {
  const r = runPrep((tree, dir) => {
    mkdirSync(join(dir, 'other-node_modules'));
    symlinkSync(join(dir, 'other-node_modules'), join(tree, 'node_modules'));
  });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.called, null, `npm 被叫了：${r.called}`);
});

test('⭐ 斷掉的連結也算「有」（-e 看不到、-L 看得到）＝退 3', () => {
  const r = runPrep((tree, dir) => symlinkSync(join(dir, 'does-not-exist'), join(tree, 'node_modules')));
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.called, null, `npm 被叫了：${r.called}`);
});

test('對照組：沒有 node_modules＝真的去叫 npm ci --prefer-offline --no-audit --no-fund（假 npm 記下的參數逐字）', () => {
  const r = runPrep(() => {});
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.called, ['ci', '--prefer-offline', '--no-audit', '--no-fund'], '前三題「沒叫 npm」要有這一題撐著，不然假 npm 根本沒被接上也會全綠');
});

// 會 spawn 子行程的呼叫點各兩種 GIT_* 題（test/git-env.test.js 檔頭的規矩；射程對照在 test/helpers/dirty-git-env.js）：
// 這句最後 exec npm，npm 可能再去 spawn git；GIT_DIR 漏進去＝git 讀到別的倉庫（2026-08-09 事故的形狀）。
test('⭐ GIT_* 題①：髒 GIT_* 環境下答案仍正確（已有 node_modules 照樣退 3、沒有照樣叫 npm ci）', () => {
  const restore = injectDirtyGitEnv();
  try {
    assert.equal(runPrep((tree) => mkdirSync(join(tree, 'node_modules'))).status, 3);
    assert.deepEqual(runPrep(() => {}).called, ['ci', '--prefer-offline', '--no-audit', '--no-fund']);
  } finally { restore(); }
});

test('⭐ GIT_* 題②：假 npm 直接看子行程環境，不可以有任何 GIT_*', () => {
  const restore = injectDirtyGitEnv();
  try {
    const r = runPrep(() => {});
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.gitVars, [], `交給 npm 的環境裡漏了 GIT_*：${r.gitVars}`);
  } finally { restore(); }
});
