// @ts-check
// 協作欄位閘的**真 CLI 出口**考題（2026-09-08 補；比照 `test/review-verdicts-cli.test.js`）。
//
// ⚠️ 為什麼非要有這一支：拿掉「基準版本」那一欄之前，`main()` **一題都沒有**——
// 把整段判斷換成「永遠放行」，全卷照樣全綠（實測 3,476 題 0 fail）。
// 那道閘是分支保護的 required check、`enforce_admins` 又是開的，所以它一旦靜靜放行，
// 「實作者不按自己的合併鍵」就只剩一句話。**退出碼才是這支腳本對外的介面**，不是它的內部函式。
//
// ⚠️ 誠實劃界：這一支證明「入口會依判斷結果給出對的退出碼」，
// 證明不了「判斷本身涵蓋得夠廣」（那是 `test/collab-invariant-docs.test.js` 那一族的事）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_FIELDS } from '../scripts/check-pr-collab-fields.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/check-pr-collab-fields.js');

/** 造一支假的 `gh`，讓腳本走完整的真實路徑（不是 stub 掉它的內部函式）。 */
function withFakeGh(/** @type {string} */ stdout, { exitCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'collab-gh-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${exitCode}\n`);
  chmodSync(gh, 0o755);
  return spawnSync(process.execPath, [SCRIPT, '999'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
}

// ⚠️ 今天的 fetchPr 還會驗 headRefOid 的形狀（那是「基準版本」那一欄留下的），所以夾具要帶著它；
// 多給一個欄位對拿掉之後的版本也無害。
const HEAD = 'aabbccdd11223344556677889900aabbccddeeff';
const payload = (/** @type {string} */ body) => JSON.stringify({ body, headRefOid: HEAD });


/** 一份「該過」的 PR 說明：每一個必填欄位都填、實作者 ≠ 獨立審查者。 */
const goodBody = (/** @type {Record<string, string>} */ over = {}) => {
  // ⚠️ 「基準版本」今天還要求逐字等於 head（那一欄拿掉之後，它就不在 REQUIRED_FIELDS 裡、這一格自然不會被用到）。
  const v = { 實作者: 'Claude', 獨立審查者: 'Codex', 基準版本: HEAD, ...over };
  return REQUIRED_FIELDS.map((f) => `- **${f}**：${v[f] ?? '有寫'}`).join('\n');
};
test('⭐ CLI｜必填欄位齊全、實作者 ≠ 獨立審查者 → exit 0', () => {
  const r = withFakeGh(payload(goodBody()));
  assert.equal(r.status, 0, `預期 0，實得 ${r.status}\n${r.stdout}${r.stderr}`);
});

test('⭐ CLI｜實作者＝獨立審查者 → exit **1**（這是整道閘存在的全部理由）', () => {
  const r = withFakeGh(payload(goodBody({ 獨立審查者: 'Claude' })));
  assert.equal(r.status, 1, `自審被放行了。實得 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /未通過/);
});

test('⭐ CLI｜缺任何一個必填欄位 → exit 1（逐欄各驗一次，不抽樣）', () => {
  for (const missing of REQUIRED_FIELDS) {
    const body = REQUIRED_FIELDS.filter((f) => f !== missing)
      .map((f) => `- **${f}**：${f === '獨立審查者' ? 'Codex' : 'Claude'}`).join('\n');
    const r = withFakeGh(payload(body));
    assert.equal(r.status, 1, `缺「${missing}」被放行了。實得 ${r.status}\n${r.stderr}`);
  }
});

test('⭐ CLI｜模板原封不動送出去 → exit 1（填寫說明都在 HTML 註解裡）', () => {
  const tpl = readFileSync(join(ROOT, '.github/pull_request_template.md'), 'utf8');
  const r = withFakeGh(payload(tpl));
  assert.equal(r.status, 1, `空模板被判成「欄位齊全」＝這道閘等於沒有。實得 ${r.status}\n${r.stdout}`);
});

test('⭐ CLI｜gh 查不到（非零退出）→ exit **2**（fail-closed：查不到不等於安全）', () => {
  const r = withFakeGh('', { exitCode: 1 });
  assert.equal(r.status, 2, `預期 2，實得 ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /查不清楚/);
});

test('CLI｜沒給 PR 編號 → exit 2 並印用法（不連網）', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /用法/);
});

