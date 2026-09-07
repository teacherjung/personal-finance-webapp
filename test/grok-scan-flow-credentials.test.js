// @ts-check
// `grok-scan.js` 主流程行為考題（同族五支之一）：憑證與盒內最小家：refresh、manifest、DLP 針、上限與假值。
//
// ⚠️ 這一族**共用夾具**在 `test/helpers/grok-scan-flow-fixtures.js`（射程、劃界與「為什麼拆」都寫在那裡）。
// 同族的其他幾支：`grok-scan-flow-preflight.test.js`、`grok-scan-flow-breach.test.js`、`grok-scan-flow-incident.test.js`、`grok-scan-flow-redaction.test.js`。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DUMMY_BEARER_PREFIX } from '../scripts/grok-auth-refresh.js';
import { GROK_HOME_MANIFEST, SESSION_CAPS, runScan } from '../scripts/grok-scan.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXPECTED_BOX_AUTH_FIELDS, SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeAuth, fakeCanary, fakeGrok, fakeRelay, isolated, promptFile, quiet, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);

test('runScan｜盒內最小家 manifest：config.toml／agent_id **不帶進盒子**；auth.json 只含固定欄位；審查 smoke 要有工具足跡', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'config.toml'), 'stale = "CONFIG-STALE-VALUE"\n'); writeFileSync(join(inst, 'agent_id'), 'AGENT-ID-STALE');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, '( printf "LS=[%s] " "$(ls "$GROK_HOME" | tr \'\\n\' \' \')"; cat "$GROK_HOME/config.toml" "$GROK_HOME/agent_id" "$GROK_HOME/auth.json" 2>/dev/null ) | tr \'\\n\' \' \'; $1'));
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const reply = readFileSync(out, 'utf8');
  assert.ok(!reply.includes('CONFIG-STALE'), 'config.toml 進了盒子');
  assert.ok(!reply.includes('AGENT-ID-STALE'), 'agent_id 進了盒子');
  const ls = /LS=\[([^\]]*)\]/.exec(reply)?.[1] || '';
  assert.deepEqual(ls.trim().split(/\s+/).sort(), [...GROK_HOME_MANIFEST.topLevelEntries], `盒內 grok-home 的檔不是 manifest 宣告的最小家：${ls}`);
  const json = /\{.*\}/.exec(reply)?.[0] || '';
  const entry = Object.values(JSON.parse(json))[0];
  assert.deepEqual(Object.keys(/** @type {object} */ (entry)).sort(), EXPECTED_BOX_AUTH_FIELDS, '盒內 auth.json 的欄位不是固定白名單');
  assert.ok(!reply.includes('fake-owner@example.test'), 'email 進了盒子');
  assert.match(r.summary.join('\n'), /足跡 [1-9]\d* 筆/, '審查能力 smoke 沒有看到工具足跡');
});

test('runScan｜盒內最小家 manifest 接線：refresh 後若 auth.json 多出白名單外欄位 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, {
    ...quiet,
    ...iso,
    repo: repo.dir,
    ...withGrok(fakeGrok()),
    relayScript: fakeRelay('ok'),
    afterGrokHomeAuthWrite: (grokHome) => {
      const p = join(grokHome, 'auth.json');
      const auth = JSON.parse(readFileSync(p, 'utf8'));
      const entry = /** @type {Record<string, unknown>} */ (Object.values(auth)[0]);
      entry.principal_id = 'BOX-BYPASS-FIELD-0123456789';
      writeFileSync(p, JSON.stringify(auth), { mode: 0o600 });
    },
  });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /manifest 不符/);
  assert.match(r.summary.join('\n'), /auth\.json 欄位/);
});

test('runScan｜r5 #1：失敗路徑全丟棄——grok 非 0 且把 token 寫進 stderr 與 session，結果包與 summary 都不得有 token', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: 'REAL-TOKEN-SHOULD-NEVER-LEAK-0123456789' }));
  const inst = fakeGrok({ status: 1 });
  // 假 grok：把「真 token」（它其實拿不到——盒內是 DUMMY；這裡直接寫字串模擬最壞情況）寫進 stderr 與 session，然後退 1
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'echo REAL-TOKEN-SHOULD-NEVER-LEAK-0123456789 >&2; echo REAL-TOKEN-SHOULD-NEVER-LEAK-0123456789 > "$ws/fake-session/updates.jsonl"; $1'));
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  const everything = logs.join('\n') + r.summary.join('\n') + readdirSync(iso.resultsRoot, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => readFileSync(join(f.parentPath ?? f.path, f.name), 'utf8')).join('\n');
  assert.ok(!everything.includes('REAL-TOKEN-SHOULD-NEVER-LEAK'), '失敗路徑還是把 Grok 可控的輸出（stderr／session）留在 log 或結果包裡');
  assert.ok(!existsSync(join(iso.resultsRoot)) || !readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).includes('sessions/')), '失敗路徑還是把 sessions 抄進結果包');
});

test('runScan｜r5 #1：成功路徑、token 藏在巢狀 terminal/call-*.log → DLP 遞迴抓到、1、sessions 不留', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: 'REAL-TOKEN-IN-NESTED-LOG-0123456789' }));
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'mkdir -p "$ws/fake-session/terminal"; echo REAL-TOKEN-IN-NESTED-LOG-0123456789 > "$ws/fake-session/terminal/call-1.log"; $1'));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /去機密.*terminal\/call-1\.log/);
  assert.ok(!readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).includes('call-1.log')), '巢狀日誌還是進了結果包');
});

test('runScan｜r5 #3：假 grok 留一個背景 writer（stdio 關閉、主程序退 0）→ runScan 回來時整個程序群組已死', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  // 背景 writer：每 100ms 往 $GROK_HOME/sessions 寫一行，stdio 全關、setsid 不用（它本來就在 grok 的群組裡）
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, '( while :; do echo alive >> "$GROK_HOME/sessions/bg.txt"; sleep 0.1; done ) >/dev/null 2>&1 </dev/null & echo $! > "$GROK_HOME/bg.pid"; $1'));
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.notEqual(r.code, 2, r.summary.join('\n'));
  // 盒子已清，bg.pid 拿不到了——改用 ps 找那個 while 迴圈：盒子路徑出現在任何活程序的命令列＝還活著
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  const ps = execFileSync('/bin/ps', ['-axo', 'command'],
    // ⚠️ maxBuffer 要放大：平行跑的 xlsx 隔離考題會起一個命令列夾著大段 base64 的子行程，
    //    `ps -axo command` 的輸出因此可以衝破預設的 1MB ⇒ ENOBUFS ⇒ 本題間歇紅（與受測邏輯無關）。
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.ok(!ps.includes(box), `runScan 回來後還有程序帶著盒子路徑在跑：${ps.split('\n').filter((l) => l.includes(box)).join(' | ').slice(0, 200)}`);
});

test('runScan｜**不注入**時，走到的那一支會印出真探針詞彙的行（擋得住「接線被拿掉或換成空殼」）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 為什麼要有這一題：`deps.runCanary ?? runCanary` 是個接縫，而本檔其餘的題都注入假金絲雀
  //    ⇒ 沒有別的題會問「不注入時走到哪一支」。把那個 `??` 的預設換成不印探針行的空殼，其餘全檔照樣綠。
  //    這一題只跑一次真的，不是每一道走到第②步的題各跑一次。
  // ⚠️ **誠實劃界——它守得住什麼、守不住什麼**：
  //    ・守得住：fallback 被拿掉、或換成不印那些行的空殼。
  //    ・**守不住**：換成一支**完全不跑探針、只偽造同形文字**的替身——那樣它照樣綠。
  //      「同等強度的身分證據」三條路都不通——比函式身分是在測常數不是測呼叫點、誘餌目錄在 `finally` 就清掉
  //      觀察不到、拿耗時當門檻會 flaky——所以照家規改口，不把這一題稱為「真金絲雀接線的守門」。
  //    ・也不證明沙箱真的有效（那是 test/grok-sandbox.test.js 的事），不涵蓋 CLI 入口那一行。
  const repo = tinyRepo(); const iso = isolated();
  const { runCanary: _dropped, ...noCanary } = iso;   // 刻意不注入金絲雀
  void _dropped;
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...noCanary, repo: repo.dir, ...withGrok(fakeGrok({ status: 1 })), relayScript: fakeRelay('ok') });
  const s = r.summary.join('\n');
  assert.ok(/🔴 擋住｜/.test(s) && /✅ 通過｜/.test(s), `summary 裡沒有真金絲雀的探針行——正式路徑可能沒接著真的那一支：${s.slice(0, 200)}`);
});

test('runScan｜金絲雀非 0 就不掃：退 1（沙箱是假的）與退 2（跑不了／對照組不活）各自的訊息都要說得出來', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 為什麼非注入不可：真金絲雀在正常情況下回 0——它自己也會退 2（搶不到剪貼簿鎖、對照組不活、沙箱套不上），
  //    但那幾種都 flaky、當不了考題，所以「金絲雀說不行時 runScan 怎麼辦」只有注入才問得出來。
  // ⚠️ 這一題**需要**沙箱 guard，雖然注入點本身與平台無關：`--version` 檢查在金絲雀**之前**就已經在沙箱裡跑，
  //    非 macOS 會先死在那裡、走不到注入點（實測 CI 兩個 Node job 都紅）。
  // ⚠️ 「退 2＋訊息對」還不夠：`failAndClean` 是先清盒子再回傳，所以**漏掉那個 `return`**時訊息照樣在 summary 裡、
  //    掃描繼續往下跑、再因為盒子已被清掉而退 2——兩個斷言都會過（實測：拿掉 return，本題仍綠）。
  //    ⚠️ 釘「掃描開始那一行不可出現」也不夠：漏 return 的實況是**走不到那一行**（它死在轉送器起不來），
  //    所以那條斷言同樣抓不到（也實測過）。真正分得出來的是**「不掃」之後還有沒有動作**——
  //    正常收場時那一行就是最後一行；漏 return 時它後面還會冒出 DLP 與轉送器的行。
  const repo = tinyRepo();
  for (const [code, re] of /** @type {[1|2, RegExp][]} */ ([[1, /沙箱是假的/], [2, /跑不了沙箱／對照組不活/]])) {
    const logs = /** @type {string[]} */ ([]);
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), runCanary: fakeCanary(code), repo: repo.dir, ...withGrok(fakeGrok()) });
    assert.equal(r.code, 2, `金絲雀回 ${code} 時沒有退 2：${r.summary.join('\n')}`);
    assert.match(r.summary.join('\n'), re, `金絲雀回 ${code} 時的訊息分不出是哪一種`);
    const stopped = logs.findIndex((l) => l.startsWith('⛔ 金絲雀：'));
    assert.notEqual(stopped, -1, `金絲雀回 ${code} 時沒印出「不掃」那一行：${logs.join(' | ').slice(0, 300)}`);
    assert.equal(stopped, logs.length - 1, `金絲雀回 ${code} 說了「不掃」，後面卻還有動作＝其實還在掃：${logs.slice(stopped + 1).join(' | ').slice(0, 300)}`);
  }
});

test('runScan｜r6 #6：DLP 真相來源（authDir/auth.json）在掃描中途讀不到 → 2、不保存（原本 catch 成空集合＝fail-open）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
  let pulled = false;
  // 金絲雀的第一行 log 出現時（refresh 已做完、DLP 還沒讀）把真相來源抽掉。
  // ⚠️ 本題把「金絲雀印出第一行」當**時序鉤子**，所以就地注入一支會印那個記號的假金絲雀——
  //    讓這個依賴看得見，而不是靠 isolated() 的預設值碰巧滿足它。
  const log = (/** @type {string} */ m) => { if (!pulled && m.includes('🔴')) { pulled = true; rmSync(join(iso.authDir, 'auth.json')); } };
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log, ...iso, runCanary: fakeCanary(0, ['🔴 假探針（本題拿它當時序鉤子）']), repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(pulled, true, '考題沒抽到檔（時序變了？）');
  assert.equal(r.code, 2, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /DLP 真相來源/);
  assert.equal(readdirSync(iso.resultsRoot).flatMap((d) => readdirSync(join(iso.resultsRoot, d))).includes('sessions'), false, '真相來源讀不到還保存了 sessions');
});

test('runScan｜r6 #6：DLP 針按欄位取、不按內容形狀——email／日期形狀 token 出現在回覆＝1；給了盒子的值與枚舉詞不算針；已在材料裡的針剔除並記錄', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  // ① email（24 字以下、不是 token 形狀）出現在回覆 → 1
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
    const inst = fakeGrok({ reply: 'owner is fake-owner@example.test' });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `email 外流沒被當事故：${r.summary.join('\n')}`);
  }
  // ② 以 ISO 日期開頭的 credential（r5 會被「時間戳形狀」排除）→ 現在按欄位取，照抓
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: '2026-01-01T00:00:00Z-LOOKS-LIKE-A-DATE-BUT-IS-A-TOKEN' }));
    const inst = fakeGrok({ reply: 'leak 2026-01-01T00:00:00Z-LOOKS-LIKE-A-DATE-BUT-IS-A-TOKEN' });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `日期形狀的 token 外流沒被當事故：${r.summary.join('\n')}`);
  }
  // ③ 給了盒子的值不算針、不管真檔裡還叫什麼欄位：principal_id 的值＝user_id（真檔實際如此）；枚舉欄位 principal_type 不算針
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ extra: { principal_id: '0ed1fd13-5d15-4f01-9a1e-2d9cb2f1f111', principal_type: 'User' } }));
    const inst = fakeGrok({ reply: 'User 0ed1fd13-5d15-4f01-9a1e-2d9cb2f1f111 wrote this' });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, `給了盒子的 user_id／枚舉詞被當成針：${r.summary.join('\n')}`);
  }
  // ④ 但 team_id（沒給盒子、跟 user_id 不同值）出現在回覆 → 1
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ extra: { team_id: '7777aaaa-5d15-4f01-9a1e-2d9cb2f1f222' } }));
    const inst = fakeGrok({ reply: 'team 7777aaaa-5d15-4f01-9a1e-2d9cb2f1f222' });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `team_id 外流沒被當事故：${r.summary.join('\n')}`);
  }
  // ⑥ 針不在材料（diff）裡、但在 head 樹裡（例：名字在 AGENTS.md）→ 也剔除；回覆含它 → 0（空 diff 煙霧測試實際踩到）
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ extra: { team_id: 'TREE-ONLY-PUBLIC-VALUE' } }));
    const inst = fakeGrok({ reply: 'saw TREE-ONLY-PUBLIC-VALUE in the tree' });
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, `樹裡本來就有的值被當成針：${r.summary.join('\n')}`);
    assert.ok(logs.some((l) => l.includes('不採用')), '剔除樹裡已有的針時沒有記錄');
  }
  // ⑤ first_name「測試用」在指示檔裡本來就有 → 針剔除、有 log；回覆含它 → 0
  {
    const iso = isolated(); mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
    const inst = fakeGrok({ reply: 'FAKE-REPLY 測試用' });
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, r.summary.join('\n'));
    assert.ok(logs.some((l) => l.includes('不採用')), '剔除材料裡已有的針時沒有記錄');
  }
});

test('runScan｜r6 #3：sessions 上限——檔數超過 → 2 且不保存；單檔超過 → 2 且不保存（父程序不再無界 readFileSync）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  for (const [label, shell, re] of /** @type {[string, string, RegExp][]} */ ([
    ['檔數', `i=0; while [ $i -le ${SESSION_CAPS.files} ]; do : > "$GROK_HOME/sessions/f$i"; i=$((i+1)); done; $1`, /檔數超過/],
    ['單檔', `/bin/dd if=/dev/zero of="$GROK_HOME/sessions/big" bs=1048576 count=${Math.ceil(SESSION_CAPS.fileBytes / 1048576) + 1} 2>/dev/null; $1`, /單檔超過/],
  ])) {
    const iso = isolated();
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, shell));
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 2, `${label}：${r.summary.join('\n')}`);
    assert.match(r.summary.join('\n'), re, label);
    assert.equal(readdirSync(iso.resultsRoot).flatMap((d) => readdirSync(join(iso.resultsRoot, d))).includes('sessions'), false, `${label}超限還保存了 sessions`);
    const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
    assert.ok(box && !existsSync(box), `${label}：盒子沒清`);
  }
});

test('runScan｜r6 #3：ulimit 真的套在盒內——假 grok 印 ulimit -f 並試寫 80MB，檔案被截在 64MB', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m,
    'printf "ULIMIT-F=%s " "$(ulimit -f)"; ( /bin/dd if=/dev/zero of="$GROK_HOME/big" bs=1048576 count=80 ) >/dev/null 2>&1; printf "BIG=%s " "$(/usr/bin/stat -f %z "$GROK_HOME/big")"; $1'));
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const reply = readFileSync(out, 'utf8');
  assert.match(reply, /ULIMIT-F=65536 /, `盒內 ulimit -f 不是 64MB：${reply.slice(0, 120)}`);
  assert.match(reply, /BIG=67108864 /, `80MB 的寫入沒被截在 64MB：${reply.slice(0, 120)}`);
});

test('runScan｜r6 #5：假值走 0600 檔給轉送器（不走 argv／env）、盒內 auth.json 的 key 就是那個值、掃完假值檔清掉', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'cat "$GROK_HOME/auth.json"; $1'));
  // 假轉送器：把 --dummy-file 的內容抄到自己目錄（考題之後比對），檔不在或形狀不對就不 READY
  const rd = mkdtempSync(join(tmpdir(), 'fake-relay-dummy-')); const relayScript = join(rd, 'relay.js');
  writeFileSync(relayScript, `const fs=require('node:fs');const i=process.argv.indexOf('--dummy-file');const f=i>=0?process.argv[i+1]:'';
if(!f||!fs.existsSync(f)||(fs.statSync(f).mode&0o077)!==0){process.exit(1)}
const v=fs.readFileSync(f,'utf8').trim();if(!v.startsWith('${DUMMY_BEARER_PREFIX}')||v.length<${DUMMY_BEARER_PREFIX.length}+32){process.exit(1)}
fs.writeFileSync(${JSON.stringify(join(rd, 'seen.txt'))},v);process.stdout.write('READY 1\\n');setInterval(()=>{},1000);`);
  const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const seen = readFileSync(join(rd, 'seen.txt'), 'utf8');
  assert.ok(readFileSync(out, 'utf8').includes(`"key":"${seen}"`), '盒內 auth.json 的 key 不等於轉送器拿到的假值');
  assert.ok(!readdirSync(iso.authDir).some((n) => n.startsWith('dummy-bearer')), '掃完假值檔還留在 authDir');
});
