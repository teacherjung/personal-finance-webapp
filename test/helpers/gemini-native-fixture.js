// 合成夾具只接收測試程序提供的字串；沒有官方 CLI、認證或網路呼叫。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readSync, writeFileSync } from 'node:fs';
import { isMainModule } from '../../lib/is-main.js';
import { findingsSchema } from '../../scripts/gemini-native-protocol.js';

export const MODEL = 'gemini-3.8-flash-high';
export const BINDING = { scanId: 'synthetic-scan', materialSha256: 'a'.repeat(64) };
export const TAIL_CHALLENGE = 'b'.repeat(64);
export const FILES = [{ path: 'lib/synthetic.js', before: { text: 'return n > 0;\n' }, after: { text: 'return n >= 0;\n' } }];
export const finding = () => ({ severity: 'P2', path: 'lib/synthetic.js', side: 'after', line: 1,
  mechanism: 'The zero boundary is included.', reproduction: 'Call with zero; the result is true.' });
export function streamEvents(binding = BINDING, schema = findingsSchema(binding), tailChallenge = TAIL_CHALLENGE) {
  const cid = 'synthetic-conversation';
  const step = (i, type, extra = {}) => ({ event: 'step_update', step_update: {
    conversation_id: cid, step_index: i, state: 'DONE', step_type: type, ...extra,
  } });
  return [
    { event: 'init', conversation_id: cid, init: { model: MODEL, tools: ['finish'], json_schema: schema } },
    step(0, 'user_input'), step(1, 'agent_response', { text_delta: 'synthetic diagnostic' }),
    step(2, 'finish', { duration_seconds: 0.1 }),
    { event: 'result', result: { conversation_id: cid, status: 'SUCCESS', num_turns: 1,
      response: 'This text is deliberately not JSON.', structured_output: { ...binding, tailChallenge, findings: [finding()] }, json_schema: schema } },
  ];
}
export const streamBytes = events => Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n');

if (isMainModule(import.meta.url) && process.argv[2] !== undefined) {
  const [mode, marker, prefixLength] = process.argv.slice(2);
  if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'early') process.exit(0);
  else if (mode === 'prefix') {
    const bytes = Buffer.alloc(Number(prefixLength));
    let consumed = 0;
    while (consumed < bytes.length) {
      const count = readSync(0, bytes, consumed, bytes.length - consumed, null);
      if (!count) throw Error('synthetic prefix missing');
      consumed += count;
    }
    const encoded = bytes.toString().split('"content":"')[1];
    const content = JSON.parse('"' + encoded + '"');
    const payload = JSON.parse(content.split('\n').at(-1) + '}');
    const tail = /^INPUT_TAIL_CHALLENGE ([a-f0-9]{64})$/m.exec(content)?.[1];
    writeFileSync(marker, JSON.stringify({ consumed, scanId: payload.binding.scanId, sawTail: !!tail, sawNeedle: content.includes('NEEDLE_UNREAD') }));
    const events = streamEvents(payload.binding, payload.schema, tail || '0'.repeat(64));
    events.at(-1).result.structured_output.findings = [];
    process.stdout.write(streamBytes(events));
  }
  else if (mode === 'group') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
    writeFileSync(marker, String(child.pid)); setInterval(() => {}, 1000);
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (mode === 'overflow') {
      // 保持存活，讓考題量到上限觸發的終止，而非自然退出與收尾的競態。
      setInterval(() => {}, 1000);
      process.stdout.write(Buffer.alloc(200_000, 120)); process.stderr.write(Buffer.alloc(100_000, 120));
    }
    else if (mode === 'error') { process.stderr.write('synthetic error'); process.exitCode = 3; }
    else if (mode === 'stream') {
      const content = JSON.parse(bytes).message.content;
      const lines = content.split('\n');
      const payload = JSON.parse(lines.at(-2));
      const tail = /^INPUT_TAIL_CHALLENGE ([a-f0-9]{64})$/.exec(lines.at(-1))?.[1];
      process.stdout.write(streamBytes(streamEvents(payload.binding, payload.schema, tail)));
    } else process.stdout.write(JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), eof: true }));
  }
}
