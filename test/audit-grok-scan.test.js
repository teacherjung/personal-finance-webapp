// @ts-check
// Grok 掃後驗屍的考題（2026-08-17）。起因＝真實事故：鎖工具旗標同版本非決定性靜默失效
// （#477 連兩掃各 54／56 次終端呼叫，此前五掃全乾淨）——旗標只能當第一層，
// 可靠的圍欄＝掃完機械稽核日誌。方向要 fail-closed：查不清楚一律當越界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditSessionDir, allSessionDirs } from '../scripts/audit-grok-scan.js';
import { execFileSync } from 'node:child_process';

const tmp = () => mkdtempSync(join(tmpdir(), 'autopsy-'));

test('⭐ 乾淨 session（有可解析行、零工具呼叫）→ 0', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'),
    '{"type":"message","name":"assistant","content":"回答"}\n{"type":"result","body":"ok"}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 0, r.why);
  assert.equal(r.parsed, 2);
});

test('⭐ 有工具呼叫（含巢狀）→ 1，且列得出工具與次數', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'),
    '{"step":{"tool":{"name":"run_terminal_command","arguments":{"command":"ls /"}}}}\n'
    + '{"name":"read_file","input":{"path":"/etc/hosts"}}\n'
    + '{"name":"run_terminal_command","arguments":{"command":"pwd"}}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
  assert.equal(r.calls.run_terminal_command, 2);
  assert.equal(r.calls.read_file, 1);
});

test('⭐ 訊息角色的 name 不算工具（user／assistant 帶 input 也不誤殺）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'),
    '{"name":"user","input":"請審查"}\n{"name":"assistant","arguments":"不是工具"}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 0, r.why);
});

test('⭐ fail-closed｜目錄不存在 → 2', () => {
  const r = auditSessionDir(join(tmp(), 'no-such-dir'));
  assert.equal(r.code, 2, r.why);
});

test('⭐ fail-closed｜沒有任何 .jsonl → 2（CLI 沒寫日誌不可當乾淨）', () => {
  const d = tmp();
  writeFileSync(join(d, 'notes.txt'), 'hi');
  const r = auditSessionDir(d);
  assert.equal(r.code, 2, r.why);
});

test('⭐ fail-closed｜日誌存在但全是壞行 → 2（查不清楚不可當乾淨）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'), 'not json\n{broken\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 2, r.why);
});

test('⭐ 壞行夾在好行中間＝抓到工具照樣退 1（越界優先於「查不清楚」）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'),
    'garbage\n{"name":"grep","arguments":{"pattern":"x"}}\nalso-garbage\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
  assert.equal(r.calls.grep, 1);
});

test('⭐ --workspace｜稽核全部 session：較新的乾淨 session 蓋不掉舊的越界（CLI 退 1）', () => {
  // 作廢預審 F3：只驗 mtime 最新＝越界日誌會被之後的乾淨 session 洗掉。改稽核全部。
  const root = tmp();
  const cwd = '/private/tmp/some workspace/掃描區';
  const ws = join(root, encodeURIComponent(cwd));
  mkdirSync(ws, { recursive: true });
  const old = join(ws, 'session-old'); const neu = join(ws, 'session-new');
  mkdirSync(old); mkdirSync(neu);
  writeFileSync(join(old, 'updates.jsonl'), '{"name":"run_terminal_command","arguments":{}}\n');
  writeFileSync(join(neu, 'updates.jsonl'), '{"type":"result"}\n');
  const t0 = Date.parse('2026-01-01T00:00:00Z') / 1000;
  utimesSync(old, t0, t0);
  const { dirs } = allSessionDirs(cwd, root);
  assert.equal(dirs.length, 2);
  let code = 0;
  try { execFileSync(process.execPath, ['scripts/audit-grok-scan.js', '--workspace', cwd, '--sessions-root', root], { encoding: 'utf8' }); }
  catch (e) { code = /** @type {any} */ (e).status; }
  assert.equal(code, 1, '越界 session 必須讓整體退 1，不能被較新的乾淨 session 洗掉');
});

test('⭐ --workspace｜workspace 不存在 → CLI 退 2（主路徑行為題）', () => {
  let code = 0;
  try { execFileSync(process.execPath, ['scripts/audit-grok-scan.js', '--workspace', '/no/such/cwd', '--sessions-root', tmp()], { encoding: 'utf8' }); }
  catch (e) { code = /** @type {any} */ (e).status; }
  assert.equal(code, 2, '找不到 workspace 必須 fail-closed 退 2');
});

test('⭐ fail-closed｜乾淨行旁邊有壞行 → 2（部分可讀不可以洗成乾淨；作廢預審 F1）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'), '{"type":"result"}\ntruncated-tool-line{{{\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 2, r.why);
});

test('⭐ fail-closed｜空 .jsonl（有檔零行）→ 2', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'), '');
  const r = auditSessionDir(d);
  assert.equal(r.code, 2, r.why);
});

test('⭐ 判準｜陣列裡的工具呼叫抓得到（tool_calls: [...]）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'), '{"tool_calls":[{"name":"web_search","args":{"q":"x"}}]}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
  assert.equal(r.calls.web_search, 1);
});

test('⭐ 判準｜name:"tool" 帶參數＝照算（寧可誤殺；params 鍵也認）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'), '{"name":"tool","params":{"x":1}}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
});

test('⭐ 判準第二腿｜events.jsonl 形狀（type:tool_started＋tool_name、無 name 無四鍵）照樣抓到', () => {
  // 作廢二掃 F1/F2＋真日誌實測（tool_name 108 次、tool_started 27 次）：單靠 name+四鍵，
  // updates/chat_history 缺席、只剩 events.jsonl 時越界會被洗成 0。
  const d = tmp();
  writeFileSync(join(d, 'events.jsonl'),
    '{"type":"tool_started","tool_name":"run_terminal_command","ts":1}\n{"type":"tool_completed","tool_name":"run_terminal_command","ts":2}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
  assert.ok(r.calls.run_terminal_command >= 1);
});

test('⭐ 多檔 session｜乾淨 updates＋越界 events ＝ 1（不能只讀一份檔）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'), '{"type":"result"}\n');
  writeFileSync(join(d, 'events.jsonl'), '{"type":"tool_started","tool_name":"grep"}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
});

test('⭐ CLI 主路徑｜positional sessionDir 的退出碼（乾淨 0／越界 1）', () => {
  const clean = tmp();
  writeFileSync(join(clean, 'updates.jsonl'), '{"type":"result"}\n');
  const out = execFileSync(process.execPath, ['scripts/audit-grok-scan.js', clean], { encoding: 'utf8' });
  assert.ok(/乾淨/.test(out));
  const bad = tmp();
  writeFileSync(join(bad, 'updates.jsonl'), '{"name":"grep","arguments":{}}\n');
  let code = 0;
  try { execFileSync(process.execPath, ['scripts/audit-grok-scan.js', bad], { encoding: 'utf8' }); }
  catch (e) { code = /** @type {any} */ (e).status; }
  assert.equal(code, 1);
});

test('⭐ 原型鍵鐵則｜__proto__／constructor／toString 當工具名照樣退 1', () => {
  // #479 r1 High②：普通物件當計數器，這三個名字會寫不進去或算出 NaN＝越界洗成乾淨。
  for (const evil of ['__proto__', 'constructor', 'toString']) {
    const d = tmp();
    writeFileSync(join(d, 'updates.jsonl'), `{"name":${JSON.stringify(evil)},"arguments":{}}\n`);
    const r = auditSessionDir(d);
    assert.equal(r.code, 1, `${evil}：${r.why}`);
  }
});

test('⭐ 判準第三腿｜backend_tool_call 真實形狀（kind.tool_type、無 name 無 tool_name）退 1', () => {
  // #479 r1 High①：真日誌實測 5 筆頂層 backend_tool_call；原兩條腿全抓不到。
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'),
    '{"type":"backend_tool_call","kind":{"tool_type":"web_search","action":{"type":"search","query":"x","sources":[]}}}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
  assert.ok(r.calls.web_search >= 1);
});

test('⭐ 判準第二腿承重｜只有 tool_completed（無 started、無 name 腿）也要退 1', () => {
  // #479 r1 Medium：原 fixture started+completed 同在＝縮成只認 tool_started 仍全綠。
  const d = tmp();
  writeFileSync(join(d, 'events.jsonl'), '{"type":"tool_completed","tool_name":"read_file"}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
});

test('⭐ --workspace｜dangling session entry（stat 失敗）＝查不清楚、不可洗成乾淨', () => {
  const root = tmp();
  const cwd = '/private/tmp/ws-with-dangling';
  const ws = join(root, encodeURIComponent(cwd));
  mkdirSync(ws, { recursive: true });
  const good = join(ws, 'session-ok');
  mkdirSync(good);
  writeFileSync(join(good, 'updates.jsonl'), '{"type":"result"}\n');
  symlinkSync(join(ws, 'no-such-target'), join(ws, 'session-dangling'));
  let code = 0;
  try { execFileSync(process.execPath, ['scripts/audit-grok-scan.js', '--workspace', cwd, '--sessions-root', root], { encoding: 'utf8' }); }
  catch (e) { code = /** @type {any} */ (e).status; }
  assert.equal(code, 2, 'dangling entry 必須 fail-closed 退 2');
});

test('⭐ 判準第四腿｜tool_result／toolCallId 單獨在場（無 companion）也退 1', () => {
  for (const line of ['{"type":"tool_result","tool_call_id":"abc123","output":"ok"}', '{"kind":"session/update","toolCallId":"xyz789"}']) {
    const d = tmp();
    writeFileSync(join(d, 'updates.jsonl'), line + '\n');
    const r = auditSessionDir(d);
    assert.equal(r.code, 1, `${line.slice(0, 40)}：${r.why}`);
  }
});

test('⭐ 判準第五腿｜_meta 帶 "x.ai/tool" 鍵單獨在場也退 1', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'), '{"kind":"text","_meta":{"x.ai/tool":{"id":1}}}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
});

test('⭐ terminal 容器｜一行乾淨 JSONL＋terminal/call-*.log ＝ 1（容器即足跡）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'), '{"type":"result"}\n');
  mkdirSync(join(d, 'terminal'));
  writeFileSync(join(d, 'terminal', 'call-001.log'), 'ls output...');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
  assert.equal(r.calls['terminal/call-log'], 1);
});

test('⭐ fail-closed｜無效 UTF-8 位元組 → 2（U+FFFD 靜默替換會讓足跡隱身）', () => {
  const d = tmp();
  const good = Buffer.from('{"name":"grep","arguments":{}}\n', 'utf8');
  const evil = Buffer.concat([Buffer.from('{"na', 'utf8'), Buffer.from([0xff]), Buffer.from('me":"grep","arguments":{}}\n', 'utf8')]);
  writeFileSync(join(d, 'updates.jsonl'), Buffer.concat([evil]));
  const r = auditSessionDir(d);
  assert.equal(r.code, 2, r.why);
  void good;
});

test('⭐ fail-closed｜workspace 目錄無法列舉 → CLI 退 2 不是 1', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root 不受權限限制'); return; }
  const root = tmp();
  const cwd = '/private/tmp/ws-unlistable';
  const ws = join(root, encodeURIComponent(cwd));
  mkdirSync(ws, { recursive: true, mode: 0o111 });
  let code = 0;
  try { execFileSync(process.execPath, ['scripts/audit-grok-scan.js', '--workspace', cwd, '--sessions-root', root], { encoding: 'utf8' }); }
  catch (e) { code = /** @type {any} */ (e).status; }
  assert.equal(code, 2, '列舉失敗必須是「查不清楚」，不是「已確認越界」');
});

test('⭐ 判準第六腿｜task_snapshot 真形狀（_x.ai/session/update、無前五腿任何鍵）單獨退 1', () => {
  // #479 r3 High：真日誌 3 筆實測——bash 任務快照帶 command，前五腿全抓不到。
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'),
    '{"timestamp":1,"method":"_x.ai/session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"task_completed","task_snapshot":{"task_id":"call-abc-1","kind":"bash","command":"ls -la /tmp","completed":true}}}}\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
  assert.ok(r.calls.bash >= 1, JSON.stringify(r.calls));
});
