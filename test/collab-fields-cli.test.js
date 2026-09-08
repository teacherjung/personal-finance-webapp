// @ts-check
// 協作欄位閘的**真 CLI 出口**考題（2026-09-08 補；比照 `test/review-verdicts-cli.test.js`）。
//
// ⚠️ 為什麼非要有這一支：2026-09-08 拿掉那個「要填目前 head」的欄位之前，`main()` **一題都沒有**——
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

// ⚠️ **夾具只准提供正式查詢真的會回的欄位**（#583 r1 Medium①）：上一版多給了一個 `headRefOid`，
// 於是「把已經刪掉的 head 形狀驗證放回 fetchPr」這種突變，在這一支考題裡是綠的（夾具替它補了那一欄），
// 真實 PR 卻會全部退 2＝必要檢查把合法 PR 全擋住。夾具跟正式查詢（`gh pr view --json body`）逐欄對齊。
const payload = (/** @type {string} */ body) => JSON.stringify({ body });


/** 一份「該過」的 PR 說明：每一個必填欄位都填、實作者 ≠ 獨立審查者。 */
const goodBody = (/** @type {Record<string, string>} */ over = {}) => {
  const v = { 實作者: 'Claude', 獨立審查者: 'Codex', ...over };
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

test('⭐ CLI｜gh 退 0 但回傳的形狀不對 → exit **2**（不是把它當成「沒填欄位」退 1）', () => {
  // ⚠️ 這一條與「查詢非零」共用同一個失敗出口，但**語意不同**：形狀壞掉是「查不清楚」，
  //    退 1 會被讀成「作者沒填」。仿的那一支（review-verdicts-cli）有這一格，上一版漏了（Grok #583 掃後 3）。
  for (const [bad, why] of [['null', '回傳 null'], ['{}', '缺 body'], ['{"body": 42}', 'body 不是字串'], ['不是 JSON', '根本不是 JSON']]) {
    const r = withFakeGh(bad);
    assert.equal(r.status, 2, `${why}：預期 2，實得 ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /查不清楚/);
  }
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

