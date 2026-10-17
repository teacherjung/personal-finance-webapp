import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { prepareBrowserPacket, requestDigest, validateManifest, validateBrowserReply, leaseMessage, SELECTED, sha256 } from '../scripts/gemini-browser-protocol.js';
import { beginBrowserScan, uploadBrowserScan, submitBrowserScan, cancelBrowserScan } from '../scripts/gemini-browser-cua.js';
import { readMail, writeOnce, mailExists } from '../scripts/gemini-browser-files.js';
import { material, answer, observation, jobFixture, browserFixture } from './helpers/gemini-browser-fixture.js';

test('單附件請求分別綁定完整材料、檔名、媒體型別與短提示，尾碼只在附件末尾', () => {
  const p = prepareBrowserPacket(material());
  assert.equal(p.attachmentText.endsWith(p.tailChallenge), true);
  assert.equal(p.controlPrompt.includes(p.tailChallenge), false);
  assert.ok(p.controlPrompt.includes(p.manifest.attachment.name));
  assert.equal(p.attachmentText.includes('Do not use apps, skills, files,'), false);
  assert.equal(p.manifest.attachment.sha256, sha256(p.attachmentText));
  assert.equal(p.manifest.control.sha256, sha256(p.controlPrompt));
  assert.equal(p.requestSha256, requestDigest(p.manifest));
  for (const key of ['sha256', 'bytes']) {
    const changed = structuredClone(p.manifest); changed.attachment[key] = key === 'bytes' ? changed.attachment.bytes + 1 : '0'.repeat(64);
    assert.notEqual(requestDigest(changed), p.requestSha256);
  }
  assert.throws(() => validateManifest({ ...p.manifest, path: '/synthetic/file' }));
  for (const name of ['../elsewhere.txt', '/synthetic/file.txt', 'different.txt']) assert.throws(() => requestDigest({ ...p.manifest, attachment: { ...p.manifest.attachment, name } }));
  const raw = Buffer.from(answer(p));
  for (const patch of [{ name: 'wrong.txt' }, { count: 2 }, { ready: false }, { uploads: 2 }, { localSha256: '0'.repeat(64) }]) {
    const o = observation(p); assert.throws(() => validateBrowserReply(raw, { ...o, attachment: { ...o.attachment, ...patch } }, p));
  }
});

test('沒有有效上傳許可即零 chooser；錯附件綁定與舊挑戰不授權', async () => {
  for (const variant of ['changed-request', 'old-challenge', 'dead-runner']) {
    const j = jobFixture(), b = browserFixture(j); j.serve();
    try {
      await beginBrowserScan(b.browser, j.runId); j.stop();
      if (variant === 'dead-runner') {
        await assert.rejects(uploadBrowserScan(j.runId), /NO_LIVE_RUNNER/);
      } else {
        const claim = readMail(j.dir, 'claim.json');
        const request = { ...leaseMessage(j.descriptor, claim.instance, variant === 'old-challenge' ? claim.challenge : 'f'.repeat(64), 'upload-request'),
          tabId: 'test-owned', temporary: true, initialResponses: 0, selected: SELECTED, initialAttachments: 0,
          attachment: { ...j.packet.manifest.attachment, ...(variant === 'changed-request' ? { sha256: '0'.repeat(64) } : {}) } };
        writeOnce(j.dir, 'upload-request.json', request); assert.throws(() => j.lease.tick(), /UPLOAD_REQUEST/);
        assert.equal(mailExists(j.dir, 'upload-permit.json'), false); await cancelBrowserScan(j.runId);
      }
      assert.equal(b.calls.filter(c => c[0] === 'filechooser').length, 0); assert.equal(b.state.uploads, 0); assert.equal(b.state.sent, 0);
    } finally { j.cleanup(); }
  }
});

test('附件被換內容或改為同內容符號連結，首次 UI 前拒收；上傳後變更也零 Submit', async () => {
  for (const variant of ['content', 'symlink', 'after-upload']) {
    const j = jobFixture(), b = browserFixture(j); j.serve();
    try {
      const path = join(j.dir, j.packet.manifest.attachment.name);
      if (variant === 'content') writeFileSync(path, 'different');
      if (variant === 'symlink') { const target = join(j.dir, 'same-content.txt'); writeFileSync(target, readFileSync(path), { mode: 0o600 }); rmSync(path); symlinkSync(target, path); }
      if (variant === 'after-upload') {
        await beginBrowserScan(b.browser, j.runId); await uploadBrowserScan(j.runId); writeFileSync(path, 'different');
        await assert.rejects(submitBrowserScan(j.runId));
      } else { await assert.rejects(beginBrowserScan(b.browser, j.runId)); assert.deepEqual(b.calls, []); }
      assert.equal(b.state.sent, 0); assert.equal(mailExists(j.dir, 'submitted.json'), false);
    } finally { j.cleanup(); }
  }
});

test('準備、上傳與送出分階段，先消耗許可再單次 chooser，重入不重傳', async () => {
  const j = jobFixture(), b = browserFixture(j); j.serve();
  try {
    assert.equal((await beginBrowserScan(b.browser, j.runId)).state, 'PREPARED'); assert.equal(b.state.uploads, 0); assert.equal(b.state.sent, 0);
    assert.equal((await uploadBrowserScan(j.runId)).state, 'UPLOADED'); assert.equal(b.state.uploads, 1); assert.equal(b.state.sent, 0);
    await assert.rejects(uploadBrowserScan(j.runId), /UPLOAD_ORDER/);
    const chooser = b.calls.findIndex(c => c[0] === 'filechooser'), click = b.calls.findIndex(c => c[0] === 'click' && c[1].endsWith('menuitem:Upload files. Documents, data, code files'));
    assert.ok(chooser >= 0 && click > chooser);
    assert.equal((await submitBrowserScan(j.runId)).state, 'SUBMITTED'); assert.equal(b.state.sent, 1);
    await assert.rejects(submitBrowserScan(j.runId), /SUBMIT_ORDER/); await cancelBrowserScan(j.runId);
  } finally { j.cleanup(); }
});

test('上傳呼叫晚於取消才返回，零後續 UI、零送出且關頁；關頁失敗不報靜止', async () => {
  for (const closeFails of [false, true]) {
    const j = jobFixture(), b = browserFixture(j, { afterUpload: () => writeOnce(j.dir, 'cancel.json', {}) }); j.serve();
    try {
      await beginBrowserScan(b.browser, j.runId);
      if (closeFails) b.tab.close = async () => { throw Error('synthetic close failure'); };
      await assert.rejects(uploadBrowserScan(j.runId));
      assert.equal(b.state.uploads, 1); assert.equal(b.state.sent, 0); assert.equal(mailExists(j.dir, 'uploaded.json'), false);
      assert.equal(mailExists(j.dir, 'quiescent.json'), !closeFails); assert.equal(mailExists(j.dir, 'ready.json'), false);
      await assert.rejects(uploadBrowserScan(j.runId), /UPLOAD_ORDER/);
    } finally { j.cleanup(); }
  }
});

test('上傳完成後檔名不符、仍載入或附件不唯一都不產生 Submit 許可', async () => {
  for (const changed of [{ attachmentName: 'wrong.txt' }, { loading: true }, { attachmentCount: 2 }]) {
    const j = jobFixture(), b = browserFixture(j); j.serve();
    try {
      await beginBrowserScan(b.browser, j.runId); await uploadBrowserScan(j.runId); Object.assign(b.state, changed);
      await assert.rejects(submitBrowserScan(j.runId), /UI_STATE/);
      assert.equal(b.state.sent, 0); assert.equal(mailExists(j.dir, 'permit.json'), false); assert.equal(b.state.closed, true);
    } finally { j.cleanup(); }
  }
});

test('同內容替換附件 inode 與 Submit 許可後改檔名都被送出前核對攔住', async () => {
  for (const variant of ['identity', 'after-ready-name']) {
    const j = jobFixture(), b = browserFixture(j); j.serve();
    try {
      await beginBrowserScan(b.browser, j.runId); await uploadBrowserScan(j.runId);
      if (variant === 'identity') {
        const original = join(j.dir, j.packet.manifest.attachment.name), replacement = join(j.dir, 'replacement.txt');
        writeFileSync(replacement, readFileSync(original), { mode: 0o600 }); renameSync(replacement, original);
      } else {
        const originalRole = b.tab.playwright.getByRole;
        b.tab.playwright.getByRole = (role, options) => {
          const locator = originalRole(role, options);
          if (role !== 'main') return locator;
          const originalLocator = locator.locator;
          locator.locator = selector => {
            const nested = originalLocator(selector);
            if (selector === 'input-area-v2') {
              const evaluate = nested.evaluate;
              nested.evaluate = async (...args) => {
                if (mailExists(j.dir, 'permit.json')) b.state.attachmentName = 'changed-after-ready.txt';
                return evaluate(...args);
              };
            }
            return nested;
          };
          return locator;
        };
      }
      await assert.rejects(submitBrowserScan(j.runId), variant === 'identity' ? /SOURCE_CHANGED/ : /PRECONDITION/);
      assert.equal(b.state.sent, 0); assert.equal(b.state.closed, true);
      if (variant === 'after-ready-name') assert.equal(mailExists(j.dir, 'permit.json'), true);
    } finally { j.cleanup(); }
  }
});

test('未消耗上傳許可，runner 不簽發 Submit；成功上傳不能省略消耗紀錄', () => {
  const j = jobFixture();
  try {
    const claim = leaseMessage(j.descriptor, 'a'.repeat(32), 'b'.repeat(64), 'claim');
    writeOnce(j.dir, 'claim.json', claim); j.lease.tick();
    const request = { ...leaseMessage(j.descriptor, claim.instance, 'c'.repeat(64), 'upload-request'), tabId: 'test-owned', temporary: true,
      initialResponses: 0, selected: SELECTED, initialAttachments: 0, attachment: j.packet.manifest.attachment };
    writeOnce(j.dir, 'upload-request.json', request); j.lease.tick();
    writeOnce(j.dir, 'uploaded.json', { instance: claim.instance, tabId: request.tabId, uploads: 1, attachment: j.packet.manifest.attachment });
    writeOnce(j.dir, 'ready.json', { ...leaseMessage(j.descriptor, claim.instance, 'd'.repeat(64), 'ready'), tabId: request.tabId,
      temporary: true, initialResponses: 0, selected: SELECTED, attachmentReady: true });
    assert.throws(() => j.lease.tick()); assert.equal(mailExists(j.dir, 'permit.json'), false);
  } finally { j.cleanup(); }
});
