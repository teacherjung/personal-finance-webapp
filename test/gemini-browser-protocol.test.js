import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBrowserPacket, validateBrowserReply, ATTACHMENT_CAP, sha256 } from '../scripts/gemini-browser-protocol.js';
import { material, answer, observation } from './helpers/gemini-browser-fixture.js';

test('完整材料、尾碼與唯一場次綁定；純準備不預填 findings', () => {
  const m = material(), p = prepareBrowserPacket(m), q = prepareBrowserPacket(m);
  assert.ok(p.attachmentText.includes(JSON.stringify(JSON.parse(m.text))));
  assert.ok(p.attachmentText.endsWith(p.tailChallenge)); assert.ok(p.attachmentText.indexOf(p.tailChallenge) > p.attachmentText.indexOf(m.head));
  assert.notEqual(p.tailChallenge, q.tailChallenge); assert.notEqual(p.binding.scanId, q.binding.scanId);
  assert.equal(p.attachmentText.includes('\n'), false); assert.equal(p.manifest.attachment.bytes, Buffer.byteLength(p.attachmentText));
  assert.ok(p.attachmentText.includes('exactly one fenced JSON code block'));
  assert.ok(p.controlPrompt.includes('exactly one fenced JSON code block'));
  assert.equal(p.attachmentText.includes('without Markdown'), false);
  const raw = Buffer.from(answer(p)), result = validateBrowserReply(raw, observation(p), p);
  assert.equal(result.answer.findings.length, 1); assert.equal(result.sourceKind, 'browser-codeblock-ui/v1');
  assert.equal(result.receiverConsumptionVerified, false);
  assert.throws(() => prepareBrowserPacket({ ...m, sha256: '0'.repeat(64) }));
  const obj = JSON.parse(m.text); obj.prompt = 'a'.repeat(ATTACHMENT_CAP);
  const large = JSON.stringify(obj); assert.throws(() => prepareBrowserPacket({ ...m, text: large, sha256: sha256(large) }), /ATTACHMENT_SIZE/);
});
test('來源觀測不能由模型自報取代；錯模式、非臨時、雙回覆與未完成都拒收', () => {
  const p = prepareBrowserPacket(material()), raw = Buffer.from(answer(p)), o = observation(p);
  for (const [key, value] of Object.entries({ schema: 'native', scanId: 'wrong', origin: 'https://example.com',
    tabId: '../old', initialResponses: 1, submissions: 2, finalResponses: 2, temporaryBefore: false, temporaryAfter: false,
    selectedBefore: 'Auto', selectedAfter: 'Pro', details: 'Used Flash', detailsSource: 'model-text', complete: false, regenerations: 1,
    requestSha256: '0'.repeat(64), responseSha256: '0'.repeat(64), responseBytes: 0, bodySource: 'whole-container', renderedSha256: 'wrong', renderedBytes: 0, snapshotSha256: 'wrong' })) {
    assert.throws(() => validateBrowserReply(raw, { ...o, [key]: value }, p), key);
  }
  assert.throws(() => validateBrowserReply(raw, { ...o, trusted: true }, p));
  assert.throws(() => validateBrowserReply(raw, { ...o, schema: 'browser-attachment-ui/v1' }, p));
});
test('只收完整嚴格 JSON：前後文、串接、重複鍵、UTF-8 破損、假工具與錯尾碼拒收', () => {
  const p = prepareBrowserPacket(material()), good = answer(p);
  const bad = ['prefix' + good, good + 'suffix', good + good, '```json\n' + good + '\n```',
    good.replace('{', '{"scanId":"duplicate",'), good.replace(p.tailChallenge, '0'.repeat(64)),
    JSON.stringify({ ...JSON.parse(good), tool: { command: 'read credentials', url: 'https://evil.test' } }),
    good.replace('"line":1', '"line":90000')];
  for (const text of bad) assert.throws(() => validateBrowserReply(Buffer.from(text), observation(p, text), p));
  assert.throws(() => validateBrowserReply(Buffer.from([255]), observation(p, 'x'), p));
});
