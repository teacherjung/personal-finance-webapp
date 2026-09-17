// GitHub 分支保護與 workflow 的接縫（2026-09-17 搬家第 5 步從 `test/collab-invariant-docs.test.js` 拆出來）。
//
// ## 這個檔案在防什麼
//
// 分支保護的 required check 是**按 job 名稱字串**比對的：名字改了、GitHub 設定與 `docs/github-branch-protection-setup.md`
// 沒跟著改＝等一個永遠不會出現的 check＝**永遠卡住合併**。所以①job 名要跨 workflow 唯一、②文件裡要逐字找得到每一個。
// 另一件是 2026-08-02 實測換來的那一課：單一身分下 `enforce_admins` 的「逃生門」與「強制力」是同一個開關——文件要記著。
//
// ⚠️ 誠實劃界：本檔讀的是 repo 裡的檔案，證明不了 GitHub 那邊的設定真的長這樣（那要上網站看）。
// 倉庫根＝本檔往上一層（本檔住 `test/` 第一層）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');
const WF_DIR = '.github/workflows';

test('分支保護｜job 名稱跨 workflow 唯一，且與文件逐字相同', () => {
  // ⚠️ 這題防兩個會「永遠卡住合併」的坑：
  //    ①required check 按**名稱字串**比對——改了 name 沒改分支保護＝等一個永遠不會出現的 check。
  //    ②GitHub 要求 required job name 在所有 workflow 之間唯一，否則有歧義（Codex #382 r2 Low）。
  const doc = read('docs/github-branch-protection-setup.md');
  // ⚠️ **這裡刻意不解析 YAML**（Codex #382 r4 Low；那支迷你讀取器已於 #586 刪除）：它只夠讀我們自己寫的
  //    `collab-fields.yml`（不支援 `run: |` 多行純量、anchor…）。拿它去掃**所有** workflow，
  //    等於哪天有人在無關的 workflow 寫了一個 `run: |`，整套測試就紅——
  //    考題不該對它管不著的檔案設下格式限制。名稱盤點只要「job 層的 name:」，用正則就夠。
  /** @type {string[]} */
  const names = [];
  for (const f of readdirSync(join(ROOT, WF_DIR)).filter((f) => /\.ya?ml$/.test(f))) {
    // 縮排不寫死四格（Codex #382 r5 Low）：合法 YAML 可以用別的縮排。
    // `- name:`（step 的名字）因為 `name:` 前面有 `-` 而自然不會命中——只有 job 層的 key 會。
    for (const m of read(`${WF_DIR}/${f}`).matchAll(/^[ \t]{2,8}name:\s*(.+)$/gm)) names.push(m[1].trim());
  }
  assert.ok(names.length >= 3, `只解析到 ${names.length} 個 job 名稱，預期至少 3 個：${names.join('｜')}`);
  assert.deepEqual([...new Set(names)].sort(), [...names].sort(),
    `有跨 workflow 撞名的 job：${names.join('｜')}\nGitHub 的 required check 按名稱比對，撞名會產生歧義並可能卡住合併。`);
  for (const n of names) {
    assert.ok(doc.includes(n),
      `分支保護文件裡找不到 job 名稱「${n}」。\n`
      + '兩邊名稱走散時，required check 會變成「等一個永遠不會出現的 check」＝永遠卡住合併。');
  }
});

test('分支保護文件要記下「enforce_admins 必須開」與它的理由', () => {
  const doc = read('docs/github-branch-protection-setup.md');
  assert.ok(doc.includes('enforce_admins'), '文件沒提 enforce_admins');
  assert.ok(/逃生門.*強制力|強制力.*逃生門/.test(doc),
    '文件沒記下那一課：**單一身分下，逃生門與強制力是同一個開關**。\n'
    + '關掉 enforce_admins 不只 William 能繞過——三方共用同一個 token，'
    + '等於我們每天的每一次操作都在繞過，規則零強制力。實測當場打臉過（兩個空 commit 直接進 main）。');
});
