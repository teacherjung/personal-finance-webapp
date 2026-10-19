// 收集器的確定分段題；正式 review 拒收接線另由流程題驗證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { collectDecodedOutput } from '../scripts/grok-scan.js';
const outputHint = "核對 scripts/grok-scan.js 的 collectDecodedOutput；重跑 node --test test/grok-output-cap.test.js";


test('分通道 UTF-16 容量：中文字與非 BMP 字元按碼元計算', () => {
  const output = collectDecodedOutput(3);
  output.append('stdout', '中🙂');
  output.append('stderr', '中🙂');
  assert.deepEqual(output.snapshot(), { stdout: '中🙂', stderr: '中🙂', truncated: false }, outputHint);
  assert.equal(Buffer.byteLength('中🙂'), 7, outputHint);
});

for (const channel of ['stdout', 'stderr']) {
  for (const chunks of [['abcde'], ['ab', 'cde'], ['abcd', 'e']]) {
    test(`最後非空段超限即拒收｜${channel}｜${chunks.map(x => x.length).join('+')}`, () => {
      const output = collectDecodedOutput(4);
      for (const chunk of chunks) output.append(channel, chunk);
      const expected = chunks.length === 1 ? '' : chunks[0];
      assert.equal(output.snapshot()[channel], expected, outputHint);
      assert.equal(output.snapshot().truncated, true, outputHint);
      output.append(channel, 'later');
      assert.equal(output.snapshot()[channel], expected, outputHint);
      assert.equal(output.snapshot().truncated, true, outputHint);
    });
  }
}

test('恰等上限及空段不算超限；兩通道不合併計數', () => {
  const output = collectDecodedOutput(4);
  for (const channel of ['stdout', 'stderr']) {
    output.append(channel, 'ab'); output.append(channel, 'cd'); output.append(channel, '');
  }
  assert.deepEqual(output.snapshot(), { stdout: 'abcd', stderr: 'abcd', truncated: false }, outputHint);
});

test('解碼器跨原始位元組分段仍保留完整中文及 emoji', async () => {
  const input = new PassThrough(), output = collectDecodedOutput(3);
  input.setEncoding('utf8');
  input.on('data', chunk => output.append('stdout', chunk));
  const ended = new Promise(resolve => input.on('end', resolve));
  const bytes = Buffer.from('中🙂');
  input.write(bytes.subarray(0, 2)); input.write(bytes.subarray(2, 5)); input.end(bytes.subarray(5));
  await ended;
  assert.deepEqual(output.snapshot(), { stdout: '中🙂', stderr: '', truncated: false }, outputHint);
});

 test('跨段非 BMP 字元依碼元上限拒收', () => {
  const output = collectDecodedOutput(2);
  output.append('stdout', '中'); output.append('stdout', '🙂');
  assert.deepEqual(output.snapshot(), { stdout: '中', stderr: '', truncated: true }, outputHint);
});

test('任一通道超限後，空段及另一通道都不解除整場拒收', () => {
  const output = collectDecodedOutput(2);
  output.append('stdout', 'abc'); output.append('stdout', '');
  assert.deepEqual(output.snapshot(), { stdout: '', stderr: '', truncated: true }, outputHint);
  output.append('stderr', 'a');
  assert.deepEqual(output.snapshot(), { stdout: '', stderr: '', truncated: true }, outputHint);
});
