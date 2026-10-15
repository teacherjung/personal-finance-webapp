// @ts-check
// 只用合成 root／子對話與 stdout；不讀真 session、不呼叫 CLI。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { finalSelectionFailureCode, selectFinalReply, verifyFinalSelection } from '../scripts/grok-final-reply.js';

const workspace = '/synthetic/box/src';
const session = '00000000-0000-4000-8000-000000000001';
const path = encodeURIComponent(workspace) + '/' + session + '/chat_history.jsonl';
const final = '🤖 合成完整回覆🙂\n未貼\n';
const row = (content = final) => ({ type: 'assistant', content, model_id: 'grok-4.7', model_fingerprint: 'synthetic', reasoning_effort: 'xhigh' });
const bytes = (rows = [row()]) => Buffer.from(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
const files = () => new Map([[path, bytes()]]);
const select = (f = files(), out = final, version = '1.0.46') => selectFinalReply(f, workspace, out, version);
const hash = value => createHash('sha256').update(value).digest('hex');

test('最後 root assistant 的完整原字串、stdout 與 Unicode byte range 分列保存', () => {
  const prefix = '進度🙂\n', stdout = prefix + final + '\n';
  const f = files();
  f.set(path, bytes([{ type: 'user', content: '合成問題' }, row()]));
  let got;
  assert.doesNotThrow(() => { got = select(f, stdout); }, '合法完整 root final 不得因字元偏移或丟失 stdout 而被拒收');
  assert.equal(got.reply, final); assert.equal(got.stdout, stdout);
  assert.equal(got.replySha256, hash(final)); assert.equal(got.stdoutSha256, hash(stdout));
  assert.equal(got.selection.byteStart, Buffer.byteLength(prefix));
  assert.equal(got.selection.byteEnd, Buffer.byteLength(prefix + final));
  assert.equal(got.selection.stdoutBytes, Buffer.byteLength(stdout));
  assert.equal(got.selection.replyBytes, Buffer.byteLength(final));
  assert.equal(got.selection.encoding, 'decoded-stdout-utf8');
  assert.equal(got.selection.transcriptSha256, hash(f.get(path)));
  assert.equal(got.selection.rowIndex, 1); assert.equal(got.selection.rowCount, 2);
  assert.equal(verifyFinalSelection(got), got);
  assert.equal(f.get(path).toString(), bytes([{ type: 'user', content: '合成問題' }, row()]).toString());
});

test('不裁前言、不修 CRLF、不把 header 當選取起點', () => {
  const content = '還沒有貼出\r\n\r\n' + final;
  const f = new Map([[path, bytes([row(content)])]]);
  assert.equal(select(f, '處理中\n' + content).reply, content);
});

for (const [name, change] of [
  ['零 root', f => f.clear()],
  ['錯 workspace', f => { f.set(path.replace(encodeURIComponent(workspace), encodeURIComponent('/other/src')), f.get(path)); f.delete(path); }],
  ['多 root session', f => f.set(path.replace(session, '00000000-0000-4000-8000-000000000002'), bytes())],
  ['另一 root 僅有工具紀錄', f => f.set(path.replace(session, '00000000-0000-4000-8000-000000000002').replace('chat_history', 'updates'), Buffer.from('{}\n'))],
  ['非 UUID session', f => { f.set(path.replace(session, 'latest'), f.get(path)); f.delete(path); }],
  ['只有子對話', f => { f.set(path.replace('/chat_history', '/child/chat_history'), f.get(path)); f.delete(path); }],
  ['缺 transcript', f => { f.clear(); f.set(path.replace('chat_history', 'updates'), Buffer.from('{}\n')); }],
  ['壞 JSON', f => f.set(path, Buffer.from('{bad}\n'))],
  ['前列 JSON 壞而末列合法', f => f.set(path, Buffer.concat([Buffer.from('{bad}\n'), bytes()]))],
  ['空內容', f => f.set(path, Buffer.alloc(0))],
  ['末列截斷', f => f.set(path, Buffer.concat([bytes(), Buffer.from('{"type":')]))],
  ['缺終止換行', f => f.set(path, bytes().subarray(0, -1))],
  ['尾端空列', f => f.set(path, Buffer.concat([bytes(), Buffer.from('\n')]))],
  ['非法 UTF8', f => f.set(path, Buffer.concat([Buffer.from([255]), bytes()]))],
  ['最後 user 不能往前找 assistant', f => f.set(path, bytes([row(), { type: 'user', content: final }]))],
  ['最後 tool 假 content', f => f.set(path, bytes([{ ...row(), type: 'tool' }]))],
  ['最後 reasoning 假 content', f => f.set(path, bytes([{ ...row(), type: 'reasoning' }]))],
  ['tool_calls 即使空陣列', f => f.set(path, bytes([{ ...row(), tool_calls: [] }]))],
  ['assistant reasoning 欄不可混入', f => f.set(path, bytes([{ ...row(), reasoning: final }]))],
  ['未知完成欄', f => f.set(path, bytes([{ ...row(), complete: false }]))],
  ['缺固定 metadata', f => { const r = row(); delete r.model_fingerprint; f.set(path, bytes([r])); }],
  ['非字串 metadata', f => f.set(path, bytes([{ ...row(), model_fingerprint: null }]))],
  ['content 陣列', f => f.set(path, bytes([{ ...row(), content: [final] }]))],
  ['content 空', f => f.set(path, bytes([row('')]))],
  ['content 孤立 surrogate', f => f.set(path, bytes([row('\ud800')]))],
]) test(`來源無法證明完整 root final 即拒收：${name}`, () => {
  const f = files(); change(f); assert.throws(() => select(f), /GROK_FINAL_SELECTION_INVALID/);
});

test('子對話或工具的合成 header 不能替換 root 末列', () => {
  const f = files();
  f.set(path.replace('/chat_history', '/children/other/chat_history'), bytes([row('子對話結論')]));
  f.set(path.replace('chat_history', 'updates'), bytes([{ type: 'tool_result', content: '工具結論' }]));
  assert.equal(select(f).reply, final);
  assert.throws(() => select(f, '子對話結論'), /GROK_FINAL_SELECTION_INVALID/);
});

for (const [name, stdout] of [
  ['不存在', '別的文字'], ['重複', final + final], ['只剩部分', final.slice(1)],
  ['改行尾', final.replaceAll('\n', '\r\n')], ['額外 footer', final + '其他輸出'],
  ['多餘換行', final + '\n\n'], ['非 final 機器人標記', '進度中的 🤖 標記\n' + final],
]) test(`stdout 必須唯一逐字承載 final：${name}`, () => assert.throws(() => select(files(), stdout), /GROK_FINAL_SELECTION_INVALID/));

test('不把前一份可用 transcript 當成新 CLI 的格式證據', () => assert.throws(() => select(files(), final, '1.0.47'), /GROK_FINAL_SELECTION_INVALID/));

for (const [name, change] of [
  ['stdout hash', g => { g.stdoutSha256 = '0'.repeat(64); }],
  ['final hash', g => { g.replySha256 = '0'.repeat(64); }],
  ['final 文字且自算 hash', g => { g.reply = '假 final'; g.replySha256 = hash(g.reply); }],
  ['字元 offset', g => { g.selection.byteStart = '進度🙂\n'.length; g.selection.byteEnd = g.selection.byteStart + Buffer.byteLength(final); }],
  ['range end', g => g.selection.byteEnd++], ['stdout 長度', g => g.selection.stdoutBytes++],
  ['final 長度', g => g.selection.replyBytes++], ['前一列', g => g.selection.rowIndex--],
  ['零列', g => { g.selection.rowCount = 0; g.selection.rowIndex = -1; }],
  ['未知 schema', g => { g.selection.schema = 'unknown'; }], ['非 JSONL', g => { g.selection.transcriptPath = 'elsewhere'; }],
  ['缺原文來源 hash', g => { g.selection.transcriptSha256 = ''; }], ['未知收據欄', g => { g.selection.extra = true; }],
]) test(`收件者重驗完整選取綁定：${name}`, () => {
  const got = select(files(), '進度🙂\n' + final); change(got);
  assert.throws(() => verifyFinalSelection(got), /GROK_FINAL_SELECTION_INVALID/);
});

test('非法 UTF-8 在合法 JSON content 內仍拒收，不以替代字元配對 stdout', () => {
  const f = new Map([[path, Buffer.concat([Buffer.from('{"type":"assistant","content":"'), Buffer.from([255]),
    Buffer.from('","model_id":"grok-4.7","model_fingerprint":"synthetic","reasoning_effort":"xhigh"}\n')])]]);
  assert.throws(() => select(f, '\ufffd'), /GROK_FINAL_SELECTION_INVALID/);
});

test('即使 range 指到第二個無標記 final，收據也不能掩蓋重複全文', () => {
  const content = '完整純文字回覆';
  const got = select(new Map([[path, bytes([row(content)])]]), content);
  got.stdout = content + content; got.stdoutSha256 = hash(got.stdout);
  got.selection.byteStart = Buffer.byteLength(content); got.selection.byteEnd = Buffer.byteLength(got.stdout);
  got.selection.stdoutBytes = Buffer.byteLength(got.stdout);
  assert.throws(() => verifyFinalSelection(got), /GROK_FINAL_SELECTION_INVALID/);
});


// 每題另造輸入；預期碼是失敗位置，不改哪種輸入可以通過。
for (const [code, run] of [
  ['VERSION_WORKSPACE', () => select(files(), final, 'unknown')],
  ['ROOT_CARDINALITY', () => select(new Map())],
  ['ROOT_ID', () => select(new Map([[path.replace(session, 'not-a-session'), bytes()]]))],
  ['TRANSCRIPT_MISSING', () => select(new Map([[path.replace('chat_history', 'updates'), bytes()]]))],
  ['TRANSCRIPT_UTF8', () => select(new Map([[path, Buffer.from([255])]]))],
  ['TRANSCRIPT_TERMINATION', () => select(new Map([[path, bytes().subarray(0, -1)]]))],
  ['TRANSCRIPT_JSON', () => select(new Map([[path, Buffer.from('{SYNTHETIC-PRIVATE-KEY-NAME}\n')]]))],
  ['FINAL_OBJECT', () => select(new Map([[path, bytes([null])]]))],
  ['FINAL_KEYS', () => select(new Map([[path, bytes([{ ...row(), 'SYNTHETIC-PRIVATE-KEY-NAME': 'private-value' }])]]))],
  ['FINAL_ROLE_METADATA', () => select(new Map([[path, bytes([{ ...row(), model_fingerprint: 17 }])]]))],
  ['FINAL_CONTENT', () => select(new Map([[path, bytes([row('')])]]))],
  ['STDOUT_TEXT', () => select(files(), '')],
  ['EXACT_MATCH', () => select(files(), 'SYNTHETIC-PRIVATE-STDOUT')],
  ['UNIQUE_MATCH', () => select(files(), final + final)],
  ['TRAILING_STDOUT', () => select(files(), final + 'SYNTHETIC-PRIVATE-FOOTER')],
  ['PREFIX_MARKER', () => select(files(), '🤖 SYNTHETIC-PRIVATE-PREFIX' + final)],
  ['SELECTION_RECEIPT', () => { const got = select(); got.stdoutSha256 = 'bad'; return verifyFinalSelection(got); }],
  ['UNKNOWN', () => { const f = files(); f.keys = () => { throw new Error('/synthetic/private/path'); }; return select(f); }],
]) test(`有限診斷碼：${code}`, () => {
  assert.throws(run, error => {
    assert.equal(error.message, 'GROK_FINAL_SELECTION_INVALID');
    assert.equal(finalSelectionFailureCode(error), code);
    assert.deepEqual(Object.keys(error), []);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('診斷投影不讀外來 Error 屬性，也不接受偽造的合法碼、任意碼或非字串', () => {
  const sentinel = '/synthetic/private/path-SENTINEL';
  for (const error of [null, undefined, 17, sentinel, 'ROOT_ID', new Error(sentinel),
    { code: 'ROOT_ID' }, { code: 17 }, { code: sentinel }, { stage: 'ROOT_ID' },
    Object.assign(new Error(sentinel), { code: 'ROOT_ID', stack: sentinel }),
    new Proxy({}, { get() { throw new Error(sentinel); } })]) {
    assert.equal(finalSelectionFailureCode(error), 'UNKNOWN');
  }
  let failure;
  try { select(new Map()); } catch (error) { failure = error; }
  assert.ok(failure);
  failure.code = sentinel; failure.message = sentinel; failure.stack = sentinel;
  assert.equal(finalSelectionFailureCode(failure), 'ROOT_CARDINALITY');
});
