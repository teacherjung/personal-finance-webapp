// 合成夾具只接收測試程序提供的字串；沒有官方 CLI、認證或網路呼叫。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isMainModule } from '../../lib/is-main.js';
import { findingsSchema } from '../../scripts/gemini-native-protocol.js';

export const MODEL = 'gemini-3.8-flash-high';
export const BINDING = { scanId: 'synthetic-scan', materialSha256: 'a'.repeat(64) };
export const FILES = [{ path: 'lib/synthetic.js', before: { text: 'return n > 0;\n' }, after: { text: 'return n >= 0;\n' } }];
export const finding = () => ({ severity: 'P2', path: 'lib/synthetic.js', side: 'after', line: 1,
  mechanism: 'The zero boundary is included.', reproduction: 'Call with zero; the result is true.' });
export function streamEvents(binding = BINDING, schema = findingsSchema(binding)) {
  const cid = 'synthetic-conversation';
  const step = (i, type, extra = {}) => ({ event: 'step_update', step_update: {
    conversation_id: cid, step_index: i, state: 'DONE', step_type: type, ...extra,
  } });
  return [
    { event: 'init', conversation_id: cid, init: { model: MODEL, tools: ['finish'], json_schema: schema } },
    step(0, 'user_input'), step(1, 'agent_response', { text_delta: 'synthetic diagnostic' }),
    step(2, 'finish', { duration_seconds: 0.1 }),
    { event: 'result', result: { conversation_id: cid, status: 'SUCCESS', num_turns: 1,
      response: 'This text is deliberately not JSON.', structured_output: { ...binding, findings: [finding()] }, json_schema: schema } },
  ];
}
export const streamBytes = events => Buffer.from(events.map(e => JSON.stringify(e)).join('\n') + '\n');

if (isMainModule(import.meta.url) && process.argv[2] !== undefined) {
  const [mode, marker] = process.argv.slice(2);
  if (mode === 'hang') setInterval(() => {}, 1000);
  else if (mode === 'early') process.exit(0);
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
      const payload = JSON.parse(content.split('\n').at(-1));
      process.stdout.write(streamBytes(streamEvents(payload.binding, payload.schema)));
    } else process.stdout.write(JSON.stringify({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), eof: true }));
  }
}
