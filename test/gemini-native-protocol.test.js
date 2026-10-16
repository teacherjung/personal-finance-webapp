import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeNativeInput, parseUniqueJson, findingsSchema, validateNativeStream, MAX_MATERIAL_BYTES, OUTPUT_CAP, RESPONSE_CAP } from '../scripts/gemini-native-protocol.js';
import { MODEL, BINDING, FILES, streamEvents, streamBytes } from './helpers/gemini-native-fixture.js';
const validate = (events = streamEvents(), overrides = {}) => validateNativeStream({ stdout: streamBytes(events), stderr: Buffer.alloc(0), code: 0, timedOut: false, capped: false, ...overrides },
  { model: MODEL, schema: findingsSchema(BINDING), binding: BINDING, files: FILES });

test('完整 Unicode 與跳脫內容編成單筆 NDJSON，超限或不完整 UTF-16 拒收', () => {
  const content = '中文🌲\\"\n'.repeat(5000), packet = encodeNativeInput(content);
  assert.equal(JSON.parse(packet.bytes).message.content, content);
  assert.equal(packet.bytes.filter(v => v === 10).length, 1);
  assert.equal(packet.materialBytes, Buffer.byteLength(content));
  assert.throws(() => encodeNativeInput('x'.repeat(MAX_MATERIAL_BYTES + 1)));
  assert.throws(() => encodeNativeInput('\ud800'));
  assert.throws(() => encodeNativeInput(''));
});
test('JSON 鍵先解碼再去重，深度與非有限數字有上限', () => {
  assert.deepEqual(parseUniqueJson('{"a":[true,null,-2.5e2,"text"]}'), { a: [true, null, -250, 'text'] });
  for (const text of ['{"a":1,"\\u0061":2}', '{"a":{"b":0,"b":1}}', '1e999', '[1,]', 'true false', '"\\ud800"', '['.repeat(66) + '0' + ']'.repeat(66)]) assert.throws(() => parseUniqueJson(text));
});
test('答案只採結構化欄位；一般 response 不解析也不回填', () => {
  const result = validate();
  assert.equal(result.answer.findings[0].line, 1);
  assert.equal(result.authority, 'STRUCTURED_OUTPUT_ONLY'); assert.equal(result.formalScan, false);
  const empty = streamEvents(); empty.at(-1).result.structured_output.findings = [];
  assert.deepEqual(validate(empty).answer.findings, []);
  const misleading = streamEvents(); misleading.at(-1).result.response = JSON.stringify({ findings: [] });
  assert.equal(validate(misleading).answer.findings.length, 1);
});
const cases = [
  ['缺結構化答案', e => { delete e.at(-1).result.structured_output; }],
  ['多答案欄位', e => { e.at(-1).result.structured_output.extra = true; }],
  ['錯材料綁定', e => { e.at(-1).result.structured_output.materialSha256 = 'b'.repeat(64); }],
  ['錯掃描身分', e => { e.at(-1).result.structured_output.scanId = 'other'; }],
  ['材料外路徑', e => { e.at(-1).result.structured_output.findings[0].path = '../outside.js'; }],
  ['路徑原型名稱', e => { e.at(-1).result.structured_output.findings[0].path = '__proto__'; }],
  ['超過行數', e => { e.at(-1).result.structured_output.findings[0].line = 2; }],
  ['零行', e => { e.at(-1).result.structured_output.findings[0].line = 0; }],
  ['錯側', e => { e.at(-1).result.structured_output.findings[0].side = 'old'; }],
  ['空問題機制', e => { e.at(-1).result.structured_output.findings[0].mechanism = ''; }],
  ['錯分級', e => { e.at(-1).result.structured_output.findings[0].severity = 'fine'; }],
  ['錯模型', e => { e[0].init.model = 'gemini-other'; }],
  ['錯對話', e => { e.at(-1).result.conversation_id = 'other'; }],
  ['額外回合', e => { e.at(-1).result.num_turns = 2; }],
  ['外部工具', e => { e[2].step_update.step_type = 'run_command'; }],
  ['工具欄位', e => { e[2].step_update.tool_name = 'read_file'; }],
  ['未知事件', e => { e[2].event = 'unknown'; }],
  ['未知初始化欄位', e => { e[0].init.unknown = 1; }],
  ['重複初始化', e => e.splice(1, 0, structuredClone(e[0]))],
  ['重複結果', e => e.push(structuredClone(e.at(-1)))],
  ['缺 finish', e => e.splice(3, 1)],
  ['finish 非末尾', e => e.splice(4, 0, { event: 'step_update', step_update: { ...e[3].step_update, step_index: 3, step_type: 'checkpoint' } })],
  ['未完成 step', e => { e[2].step_update.state = 'ACTIVE'; }],
  ['重新打開 step', e => e.splice(3, 0, structuredClone(e[2]))],
  ['多個 agent answer', e => e.splice(3, 0, { event: 'step_update', step_update: { ...e[2].step_update, step_index: 2 } })],
  ['finish 非 DONE', e => { e[3].step_update.state = 'ACTIVE'; }],
  ['負時間', e => { e[3].step_update.duration_seconds = -1; }],
  ['錯 schema 型別', e => { e.at(-1).result.json_schema.additionalProperties = 0; }],
  ['錯初始化 schema', e => { e[0].init.json_schema = {}; }],
  ['一般文字超限', e => { e.at(-1).result.response = 'x'.repeat(RESPONSE_CAP + 1); }],
  ['錯結果狀態', e => { e.at(-1).result.status = 'ERROR'; }],
];
for (const [name, change] of cases) test(`拒收：${name}`, () => { const e = streamEvents(); change(e); assert.throws(() => validate(e)); });
for (const overrides of [{ code: 3 }, { timedOut: true }, { capped: true }, { stderr: Buffer.from('[agy] print timeout after 2m0s with turn in progress; returning partial output\n') }, { stdout: Buffer.alloc(OUTPUT_CAP + 1) }, { stdout: Buffer.from([0xff, 10]) }]) {
  test(`不完整程序結果拒收：${Object.keys(overrides)[0]}`, () => assert.throws(() => validate(undefined, overrides)));
}
test('原始 NDJSON 的重複鍵與缺 EOF 分隔符不可被前處理掩蓋', () => {
  const bytes = streamBytes(streamEvents());
  assert.throws(() => validate(undefined, { stdout: Buffer.from(bytes.toString().replace('"num_turns":1', '"num_turns":2,"num_turns":1')) }));
  assert.throws(() => validate(undefined, { stdout: bytes.subarray(0, -1) }));
});
test('同一 agent step 的 ACTIVE 增量後接 DONE 可採用', () => {
  const e = streamEvents(); e.splice(2, 0, { event: 'step_update', step_update: { ...e[2].step_update, state: 'ACTIVE' } });
  assert.equal(validate(e).answer.findings.length, 1);
});
