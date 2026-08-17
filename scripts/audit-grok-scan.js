#!/usr/bin/env node
// @ts-check
// **Grok 掃後驗屍**（William 2026-08-17 拍板「一定要有制度確保、不靠運氣」）。
//
// ## 它在解什麼
//
// Grok 預審的呼叫紀律要求鎖工具（AGENTS「Grok 的邊界」節），但 2026-08-17 實測：
// **同版本（1.0.3 執行檔未變）、同旗標，鎖工具會「非決定性靜默失效」**——此前五次掃描
// 日誌全零工具呼叫，#477 連兩掃卻各跑 54／56 次終端呼叫（足跡到主目錄與兩棵工作樹；
// 金絲雀實測其內建 `workspace` 沙箱也擋不住讀檔）。旗標與沙箱都只能當第一層；
// **可靠的圍欄＝掃完機械稽核它自己的本機日誌**：有任何工具呼叫＝該掃作廢（照條款記漏跑）。
//
// ## 用法（掃描後立刻跑，結果寫進證據的配方聲明）
//
//   node scripts/audit-grok-scan.js <sessionDir>
//   node scripts/audit-grok-scan.js --workspace <掃描時的 --cwd 路徑>   ← 自動找該 workspace 最新 session
//
// 退出碼：
//   0＝乾淨（日誌可讀、零工具呼叫）→ 配方聲明記「驗屍 0（session <id>）」
//   1＝**越界**（有工具呼叫；列出工具與次數）→ 該掃作廢、照條款記漏跑或鎖工具重掃
//   2＝**查不清楚**（session 找不到／日誌缺失／無任何可解析行）→ fail-closed，當越界處理
//
// ## 誠實劃界
//
// ・它讀的是 Grok CLI 自己寫的日誌（`~/.grok/sessions/<workspace>/<session>/*.jsonl`）——
//   CLI 若不寫日誌或換格式，這裡會退 2（fail-closed），不會假綠；但**驗不了日誌本身的誠實**
//   （CLI 蓄意漏記工具呼叫＝驗不到）。它防的是「旗標靜默失效」這型實測發生過的事故，
//   不是防供應商作惡——與整條預審線的信任模型一致。
// ・工具呼叫的判準＝日誌物件同時帶 `name` 與（`arguments` 或 `input`）——與 2026-08-17
//   兩次事故的實際日誌形狀一致；`name` 為 user／assistant／system 這類訊息角色者不算。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isMainModule } from '../lib/is-main.js';

/** 訊息角色不是工具（日誌裡 `name` 欄也會出現在對話物件上）。 */
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'tool']);

/**
 * 遞迴走訪一個 JSON 值，統計工具呼叫。
 * @param {any} node @param {Record<string, number>} calls
 */
function walk(node, calls) {
  if (Array.isArray(node)) { for (const v of node) walk(v, calls); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.name === 'string' && !MESSAGE_ROLES.has(node.name)
      && (Object.hasOwn(node, 'arguments') || Object.hasOwn(node, 'input'))) {
    calls[node.name] = (calls[node.name] || 0) + 1;
  }
  for (const v of Object.values(node)) walk(v, calls);
}

/**
 * 稽核一個 session 目錄。
 * @param {string} sessionDir
 * @returns {{ code: 0|1|2, calls: Record<string, number>, parsed: number, why: string }}
 */
export function auditSessionDir(sessionDir) {
  /** @type {Record<string, number>} */ const calls = {};
  let parsed = 0;
  if (!existsSync(sessionDir)) return { code: 2, calls, parsed, why: `session 目錄不存在：${sessionDir}` };
  /** @type {string[]} */ let files;
  try {
    files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    return { code: 2, calls, parsed, why: `讀不了 session 目錄：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!files.length) return { code: 2, calls, parsed, why: '目錄裡沒有任何 .jsonl 日誌（CLI 沒寫日誌或換了格式）' };
  for (const f of files) {
    /** @type {string} */ let text;
    try { text = readFileSync(join(sessionDir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { walk(JSON.parse(line), calls); parsed++; } catch { /* 壞行跳過；全壞由 parsed=0 收口 */ }
    }
  }
  if (parsed === 0) return { code: 2, calls, parsed, why: '日誌存在但無任何可解析行——查不清楚就當越界（fail-closed）' };
  const n = Object.values(calls).reduce((a, b) => a + b, 0);
  if (n > 0) return { code: 1, calls, parsed, why: `越界：${n} 次工具呼叫` };
  return { code: 0, calls, parsed, why: '乾淨（零工具呼叫）' };
}

/**
 * 由掃描時的 `--cwd` 路徑找該 workspace 最新的 session 目錄。
 * `~/.grok/sessions/` 底下的 workspace 目錄名＝encodeURIComponent(cwd)（2026-08-17 實測形狀）。
 * @param {string} workspaceCwd @param {string} [sessionsRoot] 測試用；預設 ~/.grok/sessions
 * @returns {{ dir: string|null, why: string }}
 */
export function latestSessionDir(workspaceCwd, sessionsRoot) {
  const root = sessionsRoot || join(homedir(), '.grok', 'sessions');
  const wsDir = join(root, encodeURIComponent(workspaceCwd));
  if (!existsSync(wsDir)) return { dir: null, why: `找不到 workspace 日誌目錄：${wsDir}` };
  /** @type {{ d: string, t: number }[]} */ const cands = [];
  for (const name of readdirSync(wsDir)) {
    const full = join(wsDir, name);
    try { if (statSync(full).isDirectory()) cands.push({ d: full, t: statSync(full).mtimeMs }); } catch { /* 忽略 */ }
  }
  if (!cands.length) return { dir: null, why: `workspace 目錄裡沒有任何 session：${wsDir}` };
  cands.sort((a, b) => b.t - a.t);
  return { dir: cands[0].d, why: '' };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @type {string|null} */ let target = null;
  if (args[0] === '--workspace' && args[1]) {
    const { dir, why } = latestSessionDir(args[1], process.env.GROK_SESSIONS_ROOT || undefined);
    if (!dir) { console.log(`驗屍：**查不清楚**（${why}）——fail-closed，當越界處理`); process.exit(2); }
    target = dir;
  } else if (args[0] && args[0] !== '--workspace') {
    target = args[0];
  } else {
    console.log('用法：audit-grok-scan.js <sessionDir> ｜ --workspace <掃描時的 cwd>');
    process.exit(2);
  }
  const r = auditSessionDir(target);
  const id = target.split('/').filter(Boolean).pop();
  if (r.code === 0) console.log(`驗屍 ✅ 乾淨（session ${id}；可解析行 ${r.parsed}、零工具呼叫）`);
  else if (r.code === 1) console.log(`驗屍 ❌ 越界（session ${id}）：${Object.entries(r.calls).map(([k, v]) => `${k}×${v}`).join('、')}\n→ 該掃作廢：照 AGENTS「Grok 的邊界」條款記漏跑、或鎖工具重掃後再驗一次`);
  else console.log(`驗屍 ⚠️ 查不清楚（session ${id}）：${r.why}\n→ fail-closed 當越界處理`);
  process.exit(r.code);
}
