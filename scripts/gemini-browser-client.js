// @ts-check
// 盒內持有一次請求到終態；不把任何模型文字解讀成下一個工具動作。
import { prepareBrowserPacket, validateBrowserReply, fields, FRAME_CAP } from './gemini-browser-protocol.js';
import { parseUniqueJson } from './gemini-native-protocol.js';
import { isMainModule } from '../lib/is-main.js';

export async function browserClient(input, output) {
  let state = 'START', buffered = Buffer.alloc(0), packet;
  for await (const bytes of input) {
    buffered = Buffer.concat([buffered, bytes]);
    if (buffered.length > FRAME_CAP) throw Error('GEMINI_BROWSER_CLIENT_SIZE');
    let newline;
    while ((newline = buffered.indexOf(10)) >= 0) {
      const line = buffered.subarray(0, newline); buffered = buffered.subarray(newline + 1);
      const event = parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(line));
      if (state === 'START') {
        fields(event, ['kind', 'material']);
        if (event.kind !== 'start') throw Error('GEMINI_BROWSER_CLIENT_ORDER');
        packet = prepareBrowserPacket(event.material);
        state = 'WAITING_REPLY';
        output(JSON.stringify({ kind: 'request', packet }) + '\n');
      } else if (state === 'WAITING_REPLY') {
        fields(event, ['kind', 'response', 'observation']);
        if (event.kind !== 'reply' || typeof event.response !== 'string') throw Error('GEMINI_BROWSER_CLIENT_ORDER');
        const result = validateBrowserReply(Buffer.from(event.response), event.observation, packet);
        state = 'DONE'; output(JSON.stringify({ kind: 'result', result }) + '\n');
      } else throw Error('GEMINI_BROWSER_CLIENT_REPLAY');
    }
  }
  if (state !== 'DONE' || buffered.length) throw Error('GEMINI_BROWSER_CLIENT_INCOMPLETE');
}
if (isMainModule(import.meta.url)) {
  try { await browserClient(process.stdin, value => process.stdout.write(value)); }
  catch { process.stderr.write('GEMINI_BROWSER_CLIENT_REJECTED\n'); process.exitCode = 1; }
}
