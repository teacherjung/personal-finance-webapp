import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserClient } from '../scripts/gemini-browser-client.js';
import { leaseMessage } from '../scripts/gemini-browser-protocol.js';
import { writeOnce, readMail, mailExists } from '../scripts/gemini-browser-files.js';
import { checkBrowserArtifacts } from '../scripts/gemini-browser-runner.js';
import { material, answer, observation, jobFixture } from './helpers/gemini-browser-fixture.js';

test('盒內持有請求到回覆的整輪；額外回覆、無回覆及壞來源不能終結成功', async () => {
  for (const variant of ['good', 'replay', 'missing', 'bad-source']) {
    const input = new PassThrough(), output = [];
    input.write(JSON.stringify({ kind: 'start', material: material() }) + '\n');
    const running = browserClient(input, line => {
      const frame = JSON.parse(line); output.push(frame);
      if (frame.kind === 'request') {
        const p = frame.packet, o = observation(p);
        if (variant === 'bad-source') o.complete = false;
        const reply = JSON.stringify({ kind: 'reply', response: answer(p), observation: o }) + '\n';
        input.end(variant === 'missing' ? '' : variant === 'replay' ? reply + reply : reply);
      }
    });
    if (variant === 'good') { await running; assert.equal(output.length, 2); assert.equal(output[1].result.answer.findings.length, 1); }
    else await assert.rejects(running);
  }
});
test('lease 必須回答新 challenge；只核准一次且先消耗後才接受捕獲', () => {
  const j = jobFixture();
  try {
    const claim = leaseMessage(j.descriptor, 'c'.repeat(32), 'd'.repeat(64), 'claim');
    writeOnce(j.dir, 'claim.json', claim); j.lease.tick();
    assert.deepEqual(readMail(j.dir, 'claim-ack.json'), { ...claim, stage: 'claimed' });
    const ready = { ...leaseMessage(j.descriptor, claim.instance, 'e'.repeat(64), 'ready'), tabId: 'test-owned', temporary: true, initialResponses: 0, selected: 'Open mode picker, currently Argon High' };
    writeOnce(j.dir, 'ready.json', ready); j.lease.tick();
    assert.equal(j.lease.state, 'SUBMIT_AUTHORIZED'); assert.equal(readMail(j.dir, 'permit.json').challenge, ready.challenge);
    assert.throws(() => writeOnce(j.dir, 'ready.json', ready));
    writeOnce(j.dir, 'capture.json', { instance: claim.instance, observation: observation(j.packet) });
    writeOnce(j.dir, 'submitted.json', { instance: claim.instance, tabId: ready.tabId, submissions: 1 });
    writeOnce(j.dir, 'response.txt', answer(j.packet));
    writeOnce(j.dir, 'quiescent.json', { instance: claim.instance, tabClosed: true, failed: false });
    assert.throws(() => j.lease.tick()); assert.notEqual(j.lease.state, 'CAPTURED');
  } finally { j.cleanup(); }
});
test('中止與晚到回覆不被採用；盒外專屬假值與新機密形狀守門', () => {
  const j = jobFixture();
  try {
    writeOnce(j.dir, 'aborted.json', { adopted: false });
    writeOnce(j.dir, 'capture.json', { instance: 'x', observation: observation(j.packet) });
    assert.throws(() => j.lease.tick(), /ABORTED/); assert.equal(mailExists(j.dir, 'receipt.json'), false);
    checkBrowserArtifacts([Buffer.from(answer(j.packet))], 'synthetic-secret', material().text);
    assert.throws(() => checkBrowserArtifacts([Buffer.from('synthetic-secret')], 'synthetic-secret', material().text), /CANARY_LEAK/);
    assert.throws(() => checkBrowserArtifacts([Buffer.from('flexToken":"new-secret-123456"')], 'synthetic-secret', material().text), /SECRET_SHAPE/);
    writeFileSync(join(j.dir, 'outside-canary.txt'), 'synthetic-secret');
  } finally { j.cleanup(); }
});
