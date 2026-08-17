// @ts-check
// Grok 掃後驗屍的考題（2026-08-17）。起因＝真實事故：鎖工具旗標同版本非決定性靜默失效
// （#477 連兩掃各 54／56 次終端呼叫，此前五掃全乾淨）——旗標只能當第一層，
// 可靠的圍欄＝掃完機械稽核日誌。方向要 fail-closed：查不清楚一律當越界。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditSessionDir, latestSessionDir } from '../scripts/audit-grok-scan.js';

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

test('⭐ 壞行夾在好行中間＝跳過壞行、好行照算（工具藏在好行仍抓得到）', () => {
  const d = tmp();
  writeFileSync(join(d, 'updates.jsonl'),
    'garbage\n{"name":"grep","arguments":{"pattern":"x"}}\nalso-garbage\n');
  const r = auditSessionDir(d);
  assert.equal(r.code, 1, r.why);
  assert.equal(r.calls.grep, 1);
});

test('⭐ --workspace 解析｜用 encodeURIComponent(cwd) 找最新 session', () => {
  const root = tmp();
  const cwd = '/private/tmp/some workspace/掃描區';
  const ws = join(root, encodeURIComponent(cwd));
  mkdirSync(ws, { recursive: true });
  const old = join(ws, 'session-old'); const neu = join(ws, 'session-new');
  mkdirSync(old); mkdirSync(neu);
  writeFileSync(join(old, 'updates.jsonl'), '{"name":"run_terminal_command","arguments":{}}\n');
  writeFileSync(join(neu, 'updates.jsonl'), '{"type":"result"}\n');
  const t0 = Date.parse('2026-01-01T00:00:00Z') / 1000;
  utimesSync(old, t0, t0);                                  // 舊 session 時間戳退到過去
  const { dir, why } = latestSessionDir(cwd, root);
  assert.equal(dir, neu, why);
  assert.equal(auditSessionDir(/** @type {string} */ (dir)).code, 0);
});

test('⭐ --workspace 解析｜workspace 不存在 → null（主程式據此退 2）', () => {
  const { dir } = latestSessionDir('/no/such/cwd', tmp());
  assert.equal(dir, null);
});
