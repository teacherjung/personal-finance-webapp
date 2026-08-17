#!/usr/bin/env node
// @ts-check
// **Grok 掃後驗屍**（William 2026-08-17 拍板「一定要有制度確保、不靠運氣」）。
//
// ## 它在解什麼
//
// Grok 預審的呼叫紀律要求鎖工具（AGENTS「Grok 的邊界」節），但 2026-08-17 實測：
// **同版本（1.0.3 執行檔未變）、同旗標，鎖工具會「非決定性靜默失效」**——此前五次掃描
// 日誌全零工具足跡，#477 連兩掃卻各跑 54／56 次終端呼叫（足跡到主目錄與兩棵工作樹；
// 金絲雀實測其內建 `workspace` 沙箱也擋不住讀檔）。旗標與沙箱都只能當第一層；
// **可靠的圍欄＝掃完機械稽核它自己的本機日誌**：有任何工具呼叫＝該掃作廢（照條款記漏跑）。
//
// ## 用法（掃描後立刻跑，結果寫進證據的配方聲明）
//
//   node scripts/audit-grok-scan.js <sessionDir>
//   node scripts/audit-grok-scan.js --workspace <掃描時的 --cwd 路徑>   ← 稽核該 workspace 全部 session（配方＝每掃開全新目錄）
//
// 退出碼：
//   0＝乾淨（日誌可讀、零工具足跡）→ 配方聲明記「驗屍 0（session <id>）」
//   1＝**越界**（有工具呼叫；列出工具與次數）→ 該掃作廢、照條款記漏跑或鎖工具重掃
//   2＝**查不清楚**（session 找不到／日誌缺失／無任何可解析行）→ fail-closed，當越界處理
//
// ## 誠實劃界
//
// ・它讀的是 Grok CLI 自己寫的日誌（`~/.grok/sessions/<workspace>/<session>/*.jsonl`）——
//   CLI 若不寫日誌或換格式，這裡會退 2（fail-closed），不會假綠；但**驗不了日誌本身的誠實**
//   （CLI 蓄意漏記工具呼叫＝驗不到）。它防的是「旗標靜默失效」這型實測發生過的事故，
//   不是防供應商作惡——與整條預審線的信任模型一致。
// ・足跡判準＝**逐腿列舉如下**（刻意不寫腿數——寫死的數字自己會漂；全部來自真日誌實測、#479 逐輪補齊；含整檔 .json 與 signals 計數器）：
//   ①`name`＋（arguments/input/args/params 任一鍵；訊息角色 user/assistant/system 不算、`tool` 照算）
//   ②字串 `tool_name`（events 的 tool_started/completed）③字串 `tool_type`（backend_tool_call 的 kind）
//   ④字串 `tool_call_id`／`toolCallId`（工具結果與識別碼）⑤`_meta` 帶 "x.ai/tool" 鍵
//   ⑥物件值 `task_snapshot`（_x.ai/session/update 的 bash 任務快照）
//   ＋session 子目錄 `terminal/call-*.log` 容器。任一腿命中＝足跡在場，不靠 companion 冗餘。
//   判準仍屬列舉性＝格式大漂時靠版本釘（CLI 版本不同＝當未跑）收口。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { isMainModule } from '../lib/is-main.js';

/** 訊息角色不是工具（日誌裡 `name` 欄也會出現在對話物件上）。 */
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);   // ⚠️ 刻意不收 'tool'：{name:'tool',arguments:…} 寧可誤殺（fail-closed），訊息型誤殺的代價只是重掃

/**
 * 遞迴走訪一個 JSON 值，統計工具呼叫。
 * @param {any} node @param {Record<string, number>} calls
 */
function walk(node, calls) {
  if (Array.isArray(node)) { for (const v of node) walk(v, calls); return; }
  if (!node || typeof node !== 'object') return;
  if (typeof node.name === 'string' && !MESSAGE_ROLES.has(node.name)
      && ['arguments', 'input', 'args', 'params'].some((k) => Object.hasOwn(node, k))) {
    calls[node.name] = (calls[node.name] || 0) + 1;
  }
  // 第二條腿（作廢二掃 F1/F2、真日誌實測）：events.jsonl 的工具足跡長 {type:"tool_started", tool_name:…}
  // ——沒有 name 也沒有四鍵。帶字串 tool_name 的物件一律照算（寧可誤殺；lifecycle 事件造成的
  // 重複計數無妨——驗屍只問「有沒有」，不問「幾次」，輸出叫「足跡」不叫「呼叫」）。
  if (typeof node.tool_name === 'string' && node.tool_name) {
    calls[node.tool_name] = (calls[node.tool_name] || 0) + 1;
  }
  // 第三條腿（#479 r1 High①、真日誌實測 5 筆）：backend 工具長
  // {type:"backend_tool_call", kind:{tool_type:"web_search", action:{…}}}——kind 物件帶字串
  // tool_type、沒有 name 也沒有 tool_name。帶字串 tool_type 的物件一律照算。
  if (typeof node.tool_type === 'string' && node.tool_type) {
    calls[node.tool_type] = (calls[node.tool_type] || 0) + 1;
  }
  // 第四條腿（#479 r2 High①、真日誌 142＋872 筆）：{type:"tool_result", tool_call_id:…} 與
  // 帶 toolCallId 的 session/update 物件——工具結果／識別碼本身就是足跡，不靠 companion。
  if ((typeof node.tool_call_id === 'string' && node.tool_call_id)
      || (typeof node.toolCallId === 'string' && node.toolCallId)) {
    calls['tool_call'] = (calls['tool_call'] || 0) + 1;
  }
  // 第六條腿（#479 r3 High、真日誌 3 筆）：_x.ai/session/update 的 params.update.task_snapshot
  // ——bash 任務快照（kind:"bash"、task_id:"call-…"、command:…），沒有任何前五腿認得的鍵。
  // 帶物件值 task_snapshot 的物件一律照算（名記 snapshot.kind 或 task_snapshot）。
  if (node.task_snapshot && typeof node.task_snapshot === 'object' && !Array.isArray(node.task_snapshot)) {
    const kind = typeof (/** @type {any} */ (node.task_snapshot).kind) === 'string' && (/** @type {any} */ (node.task_snapshot).kind)
      ? String((/** @type {any} */ (node.task_snapshot)).kind) : 'task_snapshot';
    calls[kind] = (calls[kind] || 0) + 1;
  }
  // 第五條腿（#479 r2 High①、真日誌 284 筆）：_meta 帶 "x.ai/tool" 鍵的 metadata 物件。
  if (node._meta && typeof node._meta === 'object' && !Array.isArray(node._meta)
      && Object.hasOwn(node._meta, 'x.ai/tool')) {
    calls['x.ai/tool'] = (calls['x.ai/tool'] || 0) + 1;
  }
  for (const v of Object.values(node)) walk(v, calls);
}

/**
 * 稽核一個 session 目錄。
 * @param {string} sessionDir
 * @returns {{ code: 0|1|2, calls: Record<string, number>, parsed: number, why: string }}
 */
export function auditSessionDir(sessionDir) {
  // ⚠️ 原型鍵鐵則（#479 r1 High②）：工具名當 key，__proto__／constructor／toString 會在普通物件上
  //    寫不進去或算出 NaN ⇒ 越界被洗成乾淨。null-prototype 物件沒有這些繼承鍵。
  /** @type {Record<string, number>} */ const calls = Object.create(null);
  let parsed = 0;
  if (!existsSync(sessionDir)) return { code: 2, calls, parsed, why: `session 目錄不存在：${sessionDir}` };
  /** @type {string[]} */ let files;
  /** @type {string[]} */ let jsonFiles;
  try {
    const all = readdirSync(sessionDir);
    files = all.filter((f) => f.endsWith('.jsonl'));
    jsonFiles = all.filter((f) => f.endsWith('.json'));   // #479 r4：signals.json 等整檔 JSON 也有足跡
  } catch (e) {
    return { code: 2, calls, parsed, why: `讀不了 session 目錄：${e instanceof Error ? e.message : String(e)}` };
  }
  const noJsonl = !files.length;   // #479 r7：不提前 return——signals／terminal 若已確認越界，1 優先於 2
  let dirty = 0;   // 壞行／讀不了的檔＝「查不清楚」的證據（#478 預審 F1：部分可讀不可以洗成乾淨）
  for (const f of files) {
    /** @type {string} */ let text;
    // ⚠️ fatal 解碼（#479 r2 High②）：'utf8' 讀檔會把無效位元組靜默換成 U+FFFD——鍵名被變形後
    //    仍是合法 JSON、足跡就此隱身。無效編碼＝查不清楚，不是乾淨。
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(sessionDir, f))); }
    catch { dirty++; continue; }
    let sawLine = false;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      sawLine = true;
      try {
        const v = JSON.parse(line);
        // #479 r7：行解析成 primitive／陣列＝不是已知日誌形狀＝損毀（fail-closed）；
        // 物件照走全部腿（刻意不寫腿數；陣列裡的足跡由物件行的巢狀陣列涵蓋，獨立陣列行一律當損毀）。
        if (!v || typeof v !== 'object' || Array.isArray(v)) dirty++;
        else walk(v, calls);
        parsed++;
      } catch { dirty++; }
    }
    if (!sawLine) dirty++;   // 空 .jsonl（有檔零行）＝同樣查不清楚
  }
  // 整檔 JSON（#479 r4 High、真日誌實測 signals.json 帶 toolCallCount/toolsUsed）：
  // 走同一套腿，另加 signals 腿——數字 toolCallCount>0 或非空 toolsUsed 陣列＝足跡。
  for (const f of jsonFiles) {
    /** @type {any} */ let obj;
    try { obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(sessionDir, f)))); parsed++; }
    catch { dirty++; continue; }
    // #479 r6＋r8：形狀先驗（primitive／陣列＝查不清楚），再走訪——走訪與欄位檢查包 try：
    // 過深巢狀會讓 walk 爆遞迴（RangeError），裸拋＝行程退 1 冒充「已確認越界」。
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { dirty++; continue; }
    try {
      walk(obj, calls);
    } catch { dirty++; continue; }
    if (obj && typeof obj === 'object') {
      // #479 r5：欄位在場但型別不對＝查不清楚（fail-closed），不可靜默略過。
      if (Object.hasOwn(obj, 'toolCallCount')) {
        // 計數必須是非負整數（#479 r6：小數＝資料損毀＝查不清楚，不是「已確認越界」）
        if (typeof obj.toolCallCount === 'number' && Number.isInteger(obj.toolCallCount) && obj.toolCallCount >= 0) {
          if (obj.toolCallCount > 0) calls['toolCallCount'] = (calls['toolCallCount'] || 0) + obj.toolCallCount;
        } else dirty++;
      }
      if (Object.hasOwn(obj, 'toolsUsed')) {
        if (Array.isArray(obj.toolsUsed)) {
          for (const t of obj.toolsUsed) {
            if (typeof t === 'string' && t) calls[t] = (calls[t] || 0) + 1;
            else dirty++;   // 陣列元素不是非空字串＝同樣查不清楚
          }
        } else dirty++;
      }
    }
  }
  // terminal/ 容器（#479 r2 High①、真日誌 12 例全數對應越界 session）：終端呼叫的原始輸出
  // 存成 session 子目錄 terminal/call-*.log——容器在場＝足跡在場，不靠 JSONL companion。
  try {
    const termDir = join(sessionDir, 'terminal');
    if (existsSync(termDir)) {
      const logs = readdirSync(termDir).filter((f) => /^call-.*\.log$/.test(f));
      if (logs.length) calls['terminal/call-log'] = (calls['terminal/call-log'] || 0) + logs.length;
    }
  } catch { dirty++; }
  const n = Object.values(calls).reduce((a, b) => a + b, 0);
  if (n > 0) return { code: 1, calls, parsed, why: `越界：${n} 筆工具足跡` };   // 抓到工具＝越界優先於髒（足跡＝含 lifecycle 重複，不去重）
  if (noJsonl) return { code: 2, calls, parsed, why: '目錄裡沒有任何 .jsonl 日誌（CLI 沒寫日誌或換了格式）' };
  if (dirty > 0) return { code: 2, calls, parsed, why: `日誌有 ${dirty} 處讀不懂（壞行／純值行／讀不了的檔／空檔）——查不清楚就當越界（fail-closed）` };
  if (parsed === 0) return { code: 2, calls, parsed, why: '日誌存在但無任何可解析行——查不清楚就當越界（fail-closed）' };
  return { code: 0, calls, parsed, why: '乾淨（零工具足跡）' };
}

/**
 * 由掃描時的 `--cwd` 路徑列出該 workspace **全部** session 目錄（配方＝每掃全新工作目錄）。
 * `~/.grok/sessions/` 底下的 workspace 目錄名＝encodeURIComponent(cwd)（2026-08-17 實測形狀）。
 * @param {string} workspaceCwd @param {string} [sessionsRoot] 測試用；預設 ~/.grok/sessions
 * @returns {{ dirs: string[], unreadable: number, why: string }}
 */
export function allSessionDirs(workspaceCwd, sessionsRoot) {
  const root = sessionsRoot || join(homedir(), '.grok', 'sessions');
  const wsDir = join(root, encodeURIComponent(workspaceCwd));
  if (!existsSync(wsDir)) return { dirs: /** @type {string[]} */ ([]), unreadable: 0, why: `找不到 workspace 日誌目錄：${wsDir}` };
  /** @type {string[]} */ const dirs = [];
  let unreadable = 0;   // stat 失敗＝查不清楚的證據（#479 r1 Medium：忽略會把 dangling entry 洗成乾淨）
  /** @type {string[]} */ let names;
  try { names = readdirSync(wsDir); }
  catch { return { dirs, unreadable: 1, why: `workspace 目錄無法列舉（權限或損毀）：${wsDir}` }; }   // #479 r2 Medium：裸拋會以 exit 1 冒充「已確認越界」
  for (const name of names) {
    const full = join(wsDir, name);
    try { if (statSync(full).isDirectory()) dirs.push(full); } catch { unreadable++; }
  }
  if (!dirs.length && !unreadable) return { dirs, unreadable, why: `workspace 目錄裡沒有任何 session：${wsDir}` };
  return { dirs, unreadable, why: unreadable ? `有 ${unreadable} 個 session entry 無法判讀（stat 失敗）` : '' };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  /** @type {string|null} */ let target = null;
  if (args[0] === '--workspace' && args[1]) {
    // ⚠️ 稽核該工作區**全部** session（#478 預審 F3：只驗 mtime 最新＝較新的乾淨 session 會
    //    蓋掉越界日誌）。配方要求每次掃描用全新工作目錄＝這裡的全部就是那一次的全部。
    const rootFlag = args.indexOf('--sessions-root');
    const { dirs, unreadable, why } = allSessionDirs(args[1], rootFlag > -1 ? args[rootFlag + 1] : undefined);
    if (!dirs.length) { console.log(`驗屍：**查不清楚**（${why || '無 session'}）——fail-closed，當越界處理`); process.exit(2); }
    let worst = unreadable ? 2 : 0;
    if (unreadable) console.log(`驗屍 ⚠️ ${why}——fail-closed，這些 entry 當越界處理`);
    for (const d of dirs) {
      const r = auditSessionDir(d);
      const id = d.split('/').filter(Boolean).pop();
      if (r.code === 1) console.log(`驗屍 ❌ 越界（session ${id}）：${Object.entries(r.calls).map(([k, v]) => `${k}×${v}`).join('、')}`);
      else if (r.code === 2) console.log(`驗屍 ⚠️ 查不清楚（session ${id}）：${r.why}`);
      else console.log(`驗屍 ✅ 乾淨（session ${id}；可解析行 ${r.parsed}）`);
      worst = Math.max(worst, r.code === 1 ? 3 : r.code);   // 越界最重（3>2），最後折回 1
    }
    const code = worst === 3 ? 1 : /** @type {0|2} */ (worst);
    if (code === 1) console.log('→ 有 session 越界＝該掃作廢：照 AGENTS「Grok 的邊界」條款記漏跑、或鎖工具重掃後再驗');
    else if (code === 2) console.log('→ 有 session 查不清楚＝fail-closed 當越界處理');
    process.exit(code);
  } else if (args[0] && args[0] !== '--workspace') {
    target = args[0];
  } else {
    console.log('用法：audit-grok-scan.js <sessionDir> ｜ --workspace <掃描時的 cwd>');
    process.exit(2);
  }
  const r = auditSessionDir(target);
  const id = target.split('/').filter(Boolean).pop();
  if (r.code === 0) console.log(`驗屍 ✅ 乾淨（session ${id}；可解析行 ${r.parsed}、零工具足跡）`);
  else if (r.code === 1) console.log(`驗屍 ❌ 越界（session ${id}）：${Object.entries(r.calls).map(([k, v]) => `${k}×${v}`).join('、')}\n→ 該掃作廢：照 AGENTS「Grok 的邊界」條款記漏跑、或鎖工具重掃後再驗一次`);
  else console.log(`驗屍 ⚠️ 查不清楚（session ${id}）：${r.why}\n→ fail-closed 當越界處理`);
  process.exit(r.code);
}
