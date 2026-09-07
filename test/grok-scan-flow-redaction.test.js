// @ts-check
// `grok-scan.js` 主流程行為考題（同族五支之一）：關門：任何文字出去之前的清洗與遮蔽。
//
// ⚠️ 這一族**共用夾具**在 `test/helpers/grok-scan-flow-fixtures.js`（射程、劃界與「為什麼拆」都寫在那裡）。
// 同族的其他幾支：`grok-scan-flow-preflight.test.js`、`grok-scan-flow-credentials.test.js`、`grok-scan-flow-breach.test.js`、`grok-scan-flow-incident.test.js`。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { BOX_ROOT, PROFILE } from '../scripts/grok-sandbox-canary.js';
import { escapeForms, hitProfile, nearestKnown, redactWindow, runScan, shapeHitsIn } from '../scripts/grok-scan.js';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PEM_BEGIN, ROOT, SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeAuth, fakeGrok, fakeRelay, isolated, keep, promptFile, quiet, readIncident, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);

test('關門｜任何文字進公開摘要／進事故檔之前都要先清洗（四種出口一起考）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題守的是**做法**不是單一出口：前三輪每一輪都被抓到「又一個沒遮到的出口」
  //    （自我重疊的機密、命中本身包住機密、深層路徑的錯誤訊息、提示檔的檔名）。
  //    William 2026-09-01 裁示改成關門：所有文字走同一支清洗。所以這一題挑**四個不同的出口**一起打，
  //    任何一個沒走那道門就會紅。
  const REAL = 'REAL-LOW-ENTROPY-NAME';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // 出口④：提示檔的**檔名**含機密
  const pd = keep(mkdtempSync(join(tmpdir(), 'fake-prompt-')));
  const pf = join(pd, `${REAL}.txt`); writeFileSync(pf, '【界線】測試用\n');
  // 出口②：形狀命中**本身包住**那個機密（值就是它）
  const inst = fakeGrok({ reply: `{"flex${'Token'}": "${REAL}-padding-to-8"}` });
  // 出口③：Grok 用機密當目錄名、疊到超過深度上限 ⇒ 錯誤訊息會逐字帶出那個路徑
  const deep = Array.from({ length: 14 }, (_, i) => (i === 0 ? REAL : `d${i}`)).join('/');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `mkdir -p "$ws/fake-session/${deep}"; printf 'x\n' > "$ws/fake-session/${deep}/x.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: pf }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.notEqual(r.code, 0, `這一題要走到事故或退 2 才量得到東西：${r.summary.join('\n')}`);
  assert.equal(r.summary.join('\n').includes(REAL), false, `公開摘要漏出機密：${r.summary.join('\n').slice(0, 300)}`);
  // 有留事故包的話，整包也不准有
  for (const d of readdirSync(iso.resultsRoot)) for (const f of readdirSync(join(iso.resultsRoot, d))) {
    assert.equal(readFileSync(join(iso.resultsRoot, d, f), 'utf8').includes(REAL), false, `${f} 漏出機密`);
  }
});

test('關門｜事故檔整份寫出前要再過一次清洗：提示檔路徑這種「沒人各自遮」的欄位才擋得住', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題挑的是**只有最後那道門擋得到**的欄位：`promptFile` 路徑沒有經過任何一個各自的遮蔽器。
  //    （我第一版把它跟別的出口混在同一題，結果那次跑出來是退 2、根本沒有事故包，
  //     於是「事故檔不過關門」的突變照樣綠＝空包彈。）
  const REAL = 'REAL-LOW-ENTROPY-NAME';
  const SECRET = 'LIVE-CANARY-PACK-0123456789';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const pd = keep(mkdtempSync(join(tmpdir(), 'fake-prompt-')));
  const pf = join(pd, `${REAL}.txt`); writeFileSync(pf, '【界線】測試用\n');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: pf }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `洩漏：${SECRET}` })), relayScript: fakeRelay('ok'), liveSecret: SECRET });
  assert.equal(r.code, 1, `這一題要走到事故才有事故包：${r.summary.join('\n')}`);
  const { json, raw } = readIncident(iso.resultsRoot);
  assert.ok(json.hits.some((/** @type {{family: string}} */ h) => h.family === 'live'), '沒有暗號族命中＝這一題量不到東西');
  assert.equal(raw.includes(REAL), false, '提示檔路徑裡的機密進了事故包（整份清洗那道門沒生效）');
  assert.equal(raw.includes(SECRET), false, '事故包裡有暗號原文');
});

test('關門｜警報器也要認得跳脫形：三條成功出口（回覆／內容／檔名）都必須退 1', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Codex #535 r5：我 r4 只把跳脫形加進**清洗字典**（出口那道門），沒加進 `leaksIn`（警報器）
  //    ⇒ 跳脫形根本不算外洩、掃描退 0、`--out` 照寫、sessions 照存，那個表示還原得回原文。
  //    **門關好了但警報器是聾的，等於沒關。** 三條成功出口各考一次。
  const REAL = 'SYNTHETIC-"QUOTE"-BACK\\SLASH-0123456789';
  const [, ESC] = escapeForms(REAL);   // 日誌／回覆裡真正會出現的那一形
  assert.notEqual(ESC, REAL, '這根針沒有跳脫形＝這一題量不到東西');
  const repo = tinyRepo();

  // 出口①：只在**回覆**裡放跳脫形
  {
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const out = join(keep(mkdtempSync(join(tmpdir(), 'out-'))), 'reply.txt');
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `輸出：${ESC}` })), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `回覆裡的跳脫形沒被當外洩：${r.summary.join('\n')}`);
    assert.ok(!existsSync(out), '判事故了卻還是寫了 --out');
  }
  // 出口②：只在 session 檔的**內容**裡放跳脫形
  {
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf '%s\n' '{"type":"tool_started","x":"${ESC.replace(/'/g, "'\\''")}"}' > "$ws/fake-session/leak.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `session 內容裡的跳脫形沒被當外洩：${r.summary.join('\n')}`);
    assert.ok(!readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).includes('sessions/')), '判事故了卻還是留了 sessions');
  }
  // 出口③：只在 session 的**檔名**裡放跳脫形（檔名不能有 `/`，用不含斜線的那一形）
  {
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf 'x\n' > "$ws/fake-session/${ESC.replace(/(["\\$`])/g, '\\$&')}.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, `檔名裡的跳脫形沒被當外洩：${r.summary.join('\n')}`);
  }
});

test('關門｜門要在第一句話出去之前上膛：DLP 字典就緒前的錯誤訊息也不准帶出 auth 實值', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Codex #535 r7：`scrubSecrets` 原本要等到 DLP 針那段（在後面很多行）才有內容，
  //    但憑證 refresh 的錯誤訊息在那之前就會走 `fail → say` 進公開摘要 ⇒ fail-closed 擋得住掃描，
  //    **擋不住那句話被抄進 PR 描述**。門有了但還沒上膛，等於沒有。
  //    ⚠️ 射程講清楚：守的是這個階段**列出來的這幾條**錯誤路徑，不是「每一條」——
  //       原本那樣寫超過實際射程（Codex #535 r8）。含兩條**隱式**的解析例外：
  //       Node 原生的 SyntaxError 會把輸入前綴印進 message，只擋自己寫的訊息是擋不到的。
  //    ⚠️ 斷言也要擋**前綴**，不是只擋完整值：洩漏出去的往往只是開頭幾個字。
  const EARLY = 'SYNTHETIC-EARLY-VALUE-SECRET-0123456789';
  // ⚠️ 對照組（兩個）：
  //   ①這個 runtime 的原生解析訊息真的會帶出前綴，否則壞 JSON 那一格是空包彈。
  //   ②`Date.parse` 真的收得下帶括號註解的髒值，否則「Date.parse 收得下的髒值」那一格也是空包彈。
  assert.ok(Number.isFinite(Date.parse(`2026-01-01 (${EARLY})`)), 'Date.parse 不收這一形＝那一格量不到東西，換夾具');
  try { JSON.parse(`{"broken": ${EARLY}}`); assert.fail('夾具竟然解析成功'); }
  catch (e) { assert.ok(/** @type {Error} */ (e).message.includes(EARLY.slice(0, 8)), '這個 runtime 的原生訊息不含前綴＝壞 JSON 那一格量不到東西，換夾具'); }
  const repo = tinyRepo();
  for (const [label, auth, want] of /** @type {[string, string, RegExp][]} */ ([
    ['issuer 不合法', fakeAuth({ issuer: EARLY }), /不等於釘住的/],
    ['client_id 不合法', fakeAuth({ clientId: EARLY }), /oidc_client_id/],
    ['進盒欄位格式不對', fakeAuth({ extra: { user_id: EARLY } }), /格式不對|不等於釘住的|鍵名/],
    // 隱式：壞掉的 auth JSON ⇒ 原生 SyntaxError 會帶出內容前綴
    // ⚠️ 夾具要用**未加引號的 token**：`{"a": "值"`（未閉合字串）那種在 Node v26 的原生訊息
    //    只有 `Expected ',' or '}'`、**不含值**，考題會變成量不到東西的空包彈（Codex #535 r9 抓到）。
    ['auth.json 不是合法 JSON', `{"broken": ${EARLY}}`, /不是合法 JSON|讀不出來/],
    // 走 `log` 不走 `say` 的那條：expires_at 只驗過「是非空字串」，壞值原本會被原文印進 log
    ['expires_at 不是合法時間', fakeAuth({ extra: { expires_at: EARLY } }), /expires_at|格式不對|不等於釘住的/],
    // ⚠️ `Date.parse` 會把括號裡的文字當註解吃掉 ⇒ 只驗「解析得出時間」擋不住這一形（Codex #535 r10）
    ['expires_at 是 Date.parse 收得下的髒值', fakeAuth({ extra: { expires_at: `2026-01-01 (${EARLY})` } }), /expires_at|格式不對|不等於釘住的/],
  ])) {
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), auth);
    // ⚠️ **連 raw log 一起收**：有些路徑走的是 `log` 不是 `fail → say`，只看 summary 量不到（Codex #535 r9）
    const logs = /** @type {string[]} */ ([]);
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...iso, log: (m) => logs.push(m), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    const out = [...r.summary, ...logs].join('\n');
    assert.equal(r.code, 2, `${label}：沒有 fail-closed：${out}`);
    assert.match(out, want, `${label}：走的不是預期那條路＝這一格量不到東西`);
    // 完整值的每一種表示都不准出現；**前綴也不准**（原生解析錯誤洩的就是前綴）
    for (const form of escapeForms(EARLY)) assert.equal(out.includes(form), false, `${label}：公開摘要帶出了 auth 實值（長 ${form.length}）`);
    for (let n = 8; n <= EARLY.length; n++) assert.equal(out.includes(EARLY.slice(0, n)), false, `${label}：公開摘要帶出了 auth 實值的前 ${n} 個字`);
  }
  // 第五條：**refresh 回應**不是合法 JSON。這條特別要緊——回應裡可能是**還沒進字典的新值**
  //（Codex #535 r8 點名），所以連「事後才建字典」都救不了它，只能不回顯。
  {
    const NEW = 'SYNTHETIC-FRESH-TOKEN-FROM-SERVER-0123456789';
    const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true });
    writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ expiresInMs: -1000 }));   // 已過期 ⇒ 會去 refresh
    const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(`Unexpected token 'S', "${NEW}" is not valid JSON`); } });
    const logs = /** @type {string[]} */ ([]);
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...iso, log: (m) => logs.push(m), fetchImpl: badJson, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    const out = [...r.summary, ...logs].join('\n');
    assert.equal(r.code, 2, `refresh 回應壞掉時沒有 fail-closed：${out}`);
    assert.match(out, /不是合法 JSON|refresh/, '走的不是預期那條路＝這一格量不到東西');
    for (let n = 8; n <= NEW.length; n++) assert.equal(out.includes(NEW.slice(0, n)), false, `refresh 回應：公開摘要帶出了伺服器回來的新值的前 ${n} 個字`);
  }
});

test('關門｜兩次讀 auth 之間被換掉：DLP 來源那格也不可以回顯檔案內容', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 我原本把這一格記成「今天走不到」——**不成立**（Codex #535 r9）：
  //    `refreshSandboxAuth` 讀一次、DLP 針那段再讀一次，中間隔著 manifest／版本／盒子／金絲雀／diff。
  //    既有的 `afterGrokHomeAuthWrite` 鉤子就落在兩次讀取之間，測試可以在那裡把檔案換成壞的，
  //    穩定走到那個 catch。所以那是**競態**、不是不可達，註解要照這樣寫。
  const MID = 'SYNTHETIC-MIDSWAP-VALUE-0123456789';
  try { JSON.parse(`{"broken": ${MID}}`); assert.fail('夾具竟然解析成功'); }
  catch (e) { assert.ok(/** @type {Error} */ (e).message.includes(MID.slice(0, 8)), '這個 runtime 的原生訊息不含前綴＝這一題量不到東西'); }
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth());
  const logs = /** @type {string[]} */ ([]);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, {
    ...iso, log: (m) => logs.push(m), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok'),
    // 兩次讀取之間把檔案換成「原生訊息會帶出前綴」的壞 JSON
    afterGrokHomeAuthWrite: () => writeFileSync(join(iso.authDir, 'auth.json'), `{"broken": ${MID}}`),
  });
  const out = [...r.summary, ...logs].join('\n');
  assert.equal(r.code, 2, `DLP 來源壞掉時沒有 fail-closed：${out}`);
  assert.match(out, /DLP 真相來源/, '走的不是那條路＝這一題量不到東西');
  for (let n = 8; n <= MID.length; n++) assert.equal(out.includes(MID.slice(0, n)), false, `公開輸出帶出了檔案內容的前 ${n} 個字`);
});

test('關門｜上下文視窗要用同一份表示清單：已是跳脫形的針不可以從 context 還原得回來', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Grok 複審後掃 2026-09-01 抓到的第四條出口：`redactWindow` 原本只餵**原文**針，
  //    但日誌裡的針常常已經是跳脫形 ⇒ 視窗不會把它標成要遮的區間；接著整包再序列化一次，
  //    檔裡變成更深一層，連最後那道門的字典也涵蓋不到，`hits[].context` 就帶著可還原的針。
  //    事故照樣會判（所以不寫 --out、不留 sessions），但**證據包本身漏了**。
  const REAL = 'SYNTHETIC-"QUOTE"-CONTEXT-0123456789';
  // ⚠️ 要用**第二層**跳脫形（JSONL 裡再嵌一層 JSON 就是這一形）：
  //    第一層的話，整包序列化之後剛好變成第二層、還在清洗字典的涵蓋範圍內，
  //    最後那道門會接住 ⇒ 這一題就量不到「視窗只餵原文」這個病（我第一版就是這樣，突變沒轉紅）。
  const [, ESC1, ESC] = escapeForms(REAL);
  assert.ok(ESC !== ESC1 && ESC1 !== REAL, '這根針的三種表示沒有互異＝這一題量不到東西');
  const planted = `${PEM_BEGIN('RSA')}\nMIIECTXWINDOW${'Z'.repeat(50)}\n`;
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // 形狀命中旁邊就放那根針的跳脫形 ⇒ 它一定落在 context 的視窗裡
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `旁邊有 ${ESC} 然後 ${planted} 結束` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const shape = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'shape');
  assert.ok(shape.length >= 1 && shape.some((/** @type {{context?: string}} */ h) => h.context), '沒有帶 context 的形狀命中＝這一題量不到東西');
  // ⚠️ 斷言要看**parse 回來的語意值**，而且要比對**所有表示**：
  //    漏出去的那一形在檔案裡是第三層，raw 只比對 0–2 層會漏掉它（我第一版就是這樣，突變沒轉紅）。
  //    parse 一次之後它退回第二層，跟 escapeForms 的第三格對得上。
  const forms = escapeForms(REAL);
  const walk = (/** @type {unknown} */ v) => {
    if (typeof v === 'string') for (const f of forms) assert.equal(v.includes(f), false, `parse 回來的欄位裡還留著針的某一種表示（長 ${f.length}）`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(raw));
});

test('關門｜不誤傷：某個表示本來就在給盒子的材料裡時，引用它不算外洩', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 判準放寬到「各種表示」之後，反方向的風險是**誤報**：Grok 引用我們自己給它的材料就被判事故。
  //    既有那道「針已在材料裡就不採用」要一起套到表示層，這一題釘住它。
  const REAL = 'SYNTHETIC-"QUOTE"-IN-MATERIALS-0123456789';
  const [, ESC] = escapeForms(REAL);
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // 指示檔裡就有那個表示 ⇒ 它是「給盒子的東西」，Grok 抄回來不算外洩
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(`參考：${ESC}\n`) }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `我抄一次：${ESC}` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, `引用公開材料被誤判成外洩：${r.summary.join('\n')}`);
});

test('關門｜帶跳脫字元的機密：事故檔的**各種序列化表示**都不准留（parse 回來也要乾淨）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Codex #535 r4：事故檔是先 JSON.stringify 再過門的，針裡有 `"`／反斜線時，
  //    序列化後的文字不再逐字含原文 ⇒ 門命不中，而 JSON.parse 回來還原得出完整機密。
  //    所以斷言要**兩種都驗**：raw 文字不含各種表示，parse 後的語意值也不含。
  const REAL = 'SYNTHETIC-"QUOTE"-BACK\\SLASH-0123456789';
  const SECRET = 'LIVE-CANARY-ESCAPED-0123456789';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // ⚠️ 機密要放在**真的會原樣進事故檔的欄位**——`promptFile` 路徑就是那一格。
  //    我第一版只把它放進回覆，但回覆原文根本不進事故檔 ⇒ 有沒有轉義形都一樣過＝空包彈。
  const pd = keep(mkdtempSync(join(tmpdir(), 'fake-prompt-')));
  const pf = join(pd, `${REAL}.txt`); writeFileSync(pf, '【界線】測試用\n');
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: pf }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `洩漏：${SECRET}` })), relayScript: fakeRelay('ok'), liveSecret: SECRET });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { raw } = readIncident(iso.resultsRoot);
  for (const form of escapeForms(REAL)) assert.equal(raw.includes(form), false, `事故檔留下了機密的某一種序列化表示（長 ${form.length}）`);
  // 語意層：整份 parse 回來，任何字串欄位都不准還原出那個值
  const walk = (/** @type {unknown} */ v) => {
    if (typeof v === 'string') assert.equal(v.includes(REAL), false, 'parse 回來還原得出完整機密');
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(JSON.parse(raw));
  assert.equal(r.summary.join('\n').includes(REAL), false, '公開摘要也留下了機密');
});

test('關門｜機密只出現在 session 檔名、內容無害時，也要算事故（第三個出口）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ Codex #535 r4：驗屍原本只比對檔案**內容**，所以「只有檔名帶機密」會一路走到成功路徑，
  //    把原始檔名接進結果包落盤——那是 say() 與 writeIncident() 以外的第三個出口。
  const REAL = 'SYNTHETIC-FILENAME-DLP-0123456789';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const inst = fakeGrok();   // 回覆與檔案內容都無害
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf 'harmless\n' > "$ws/fake-session/${REAL}.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, `只有檔名帶機密時沒有判成事故：${r.summary.join('\n')}`);
  assert.equal(r.summary.join('\n').includes(REAL), false, '公開摘要回聲了檔名裡的機密');
  // 結果樹裡**任何一段路徑或內容**都不准含那個值
  for (const f of readdirSync(iso.resultsRoot, { recursive: true, withFileTypes: true })) {
    const full = join(f.parentPath ?? f.path, f.name);
    assert.equal(full.includes(REAL), false, `結果包留下了帶機密的路徑：${f.name}`);
    if (f.isFile()) assert.equal(readFileSync(full, 'utf8').includes(REAL), false, `${f.name} 內容含機密`);
  }
});

test('關門｜清洗要把重疊區間接成一整段：機密自我重疊時，公開摘要不可以留下殘段', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這一題守的是**關門那支清洗函式**（不是視窗那支）。
  //    ⚠️ 病不在「起點漏掃」而在**殘段**：機密是 16 個 A、文字裡有 24 個 A 時，換掉第一段之後
  //    剩下的 8 個 A **本身不構成完整機密**，再怎麼往下找都找不到。所以要把重疊的區間先接成一整段再拿掉。
  //    （我第一版寫成「每次前進 1 個字」，那只解決起點、解決不了殘段，考題當場打臉。）
  const REAL = 'A'.repeat(16);                      // 自我重疊的 DLP 針
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  // 讓 Grok 用「更長的同一個字元」當目錄名、疊過深度上限 ⇒ 錯誤訊息會帶出那串字，走 fail → say
  const deep = Array.from({ length: 14 }, (_, i) => (i === 0 ? 'A'.repeat(24) : `d${i}`)).join('/');
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `mkdir -p "$ws/fake-session/${deep}"; printf 'x\n' > "$ws/fake-session/${deep}/x.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  const out = r.summary.join('\n');
  assert.match(out, /深度|讀不完/, `這一題要走到「sessions 讀不完」那條路才量得到東西：${out.slice(0, 300)}`);
  assert.equal(out.includes('A'.repeat(8)), false, `公開摘要留下了自我重疊機密的半截：${out.slice(0, 300)}`);
});

test('關門｜形狀命中本身包住已知機密時，連雜湊都不給（否則就是「固定前綴＋低熵值」的可查表雜湊）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const REAL = 'REAL-LOW-ENTROPY-NAME';
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `{"flex${'Token'}": "${REAL}-padding"}` })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  const { json, raw } = readIncident(iso.resultsRoot);
  const shape = json.hits.filter((/** @type {{family: string}} */ h) => h.family === 'shape');
  assert.ok(shape.length >= 1, `這一題要有形狀命中才量得到東西：${JSON.stringify(json.hits)}`);
  for (const h of shape) assert.deepEqual(Object.keys(h).sort(), ['charOffset', 'family', 'len', 'where'], '命中含已知機密，卻還是寫了雜湊／上下文');
  assert.equal(raw.includes(REAL), false, '事故包漏出機密');
});

test('redactWindow｜機密自我重疊時，每一個起點都要遮到（純函式，平台無關，CI 也跑）', () => {
  // ⚠️ Codex r3：原本每找到一次就前進 v.length，自我重疊的機密會漏掉後面的起點，
  //    剩下的半截照樣是可辨識的片段。
  const secret = 'A'.repeat(16);
  const text = `${'A'.repeat(24)}HITHITHIT尾巴`;
  const w = redactWindow(text, text.indexOf('HITHITHIT'), 9, [secret], 100);
  assert.equal(w.includes('A'.repeat(8)), false, `自我重疊的機密留下了半截：${w.slice(0, 60)}`);
});

test('nearestKnown｜兩臂比較：同一把鑰匙被截斷 vs 同標頭但無關（純函式，平台無關，CI 也跑）', () => {
  // ⚠️ 這一題刻意寫成**兩臂比較**，不是單臂門檻：單臂門檻是我自己挑的數字，證明不了它分得開兩種情形。
  const treeKey = `${PEM_BEGIN('RSA')}\n${Array.from({ length: 8 }, (_, i) => `MIIETREEARM${String.fromCharCode(65 + i).repeat(45)}`).join('\n')}\n`;
  const known = new Set(shapeHitsIn(treeKey));
  assert.equal(known.size, 1, '夾具沒產生排除項＝這一題量不到東西');
  const truncated = shapeHitsIn(treeKey.slice(0, Math.floor(treeKey.length * 0.55)))[0];
  const unrelated = shapeHitsIn(`${PEM_BEGIN('RSA')}\n${Array.from({ length: 8 }, (_, i) => `MIIEOTHERARM${String.fromCharCode(97 + i).repeat(46)}`).join('\n')}\n`)[0];
  assert.ok(truncated && unrelated, '兩臂夾具沒都命中');
  const a = nearestKnown(truncated, known, ''), b = nearestKnown(unrelated, known, '');
  const ratio = (/** @type {{prefixLen: number, hitLen: number}} */ n) => n.prefixLen / n.hitLen;
  assert.ok(ratio(a) > 0.9, `截斷臂沒被認出同源：${JSON.stringify(a)}`);
  assert.ok(ratio(b) < 0.3, `無關臂被誤認成同源：${JSON.stringify(b)}`);
  assert.ok(ratio(a) - ratio(b) > 0.5, '兩臂拉不開＝這個判別式交付不了它的承諾');
});

test('hitProfile｜「標頭＋一堆空白」那個自承的誤報族要看得出來（純函式，平台無關，CI 也跑）', () => {
  // 破口正則的字元類含 \s 與 \\，所以「標頭＋32 個空白」也算命中。最長連續 b64 片段能否證它不是鑰匙？
  const noisy = shapeHitsIn(`${PEM_BEGIN('DSA')}${' '.repeat(40)}`)[0];
  const real = shapeHitsIn(`${PEM_BEGIN('DSA')}\n${'M'.repeat(64)}`)[0];
  assert.ok(noisy && real, '夾具沒都命中');
  assert.ok(hitProfile(noisy).maxB64Run < 10, `空白那族的最長 b64 片段太長：${JSON.stringify(hitProfile(noisy))}`);
  assert.ok(hitProfile(real).maxB64Run >= 60, `真 body 的最長 b64 片段太短：${JSON.stringify(hitProfile(real))}`);
  // ⚠️ 只否證一個方向：maxB64Run 大**不代表**是真外洩（真假鑰匙的 body 都是 base64）。
});

test('redactWindow｜命中換成佔位符、已知機密遮掉、周圍的字要留著（純函式，平台無關，CI 也跑）', () => {
  const secret = 'ANOTHER-KNOWN-SECRET';
  const text = `前面說了${secret}然後 HITHITHIT 後面還有話`;
  const w = redactWindow(text, text.indexOf('HITHITHIT'), 9, [secret], 50);
  assert.equal(w.includes('HITHITHIT'), false, '命中沒被換掉');
  assert.equal(w.includes(secret), false, '視窗裡的已知機密沒被遮掉');
  assert.ok(w.includes('‹命中 9 字，內容不留›'), '佔位符不對');
  assert.ok(w.includes('前面說了') && w.includes('後面還有話'), '周圍的字沒留＝判不出真假');
});

test('runScan｜Grok 掃描抓到：沒掃成（退 2）不在 ~/.grok-scan-results 留任何目錄；事故（退 1）留 launch.json＋incident.json、不留 sessions', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  {
    const iso = isolated();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ status: 1 })), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 2);
    assert.deepEqual(readdirSync(iso.resultsRoot), [], '退 2 還在結果根留了目錄');
  }
  {
    const iso = isolated();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: 'LIVE-CANARY-X-0123456789' })), relayScript: fakeRelay('ok'), liveSecret: 'LIVE-CANARY-X-0123456789' });
    assert.equal(r.code, 1);
    const dirs = readdirSync(iso.resultsRoot); assert.equal(dirs.length, 1, '事故應留一個結果目錄當證據');
    const dir = join(iso.resultsRoot, dirs[0]);
    assert.deepEqual(readdirSync(dir).sort(), ['incident.json', 'launch.json'], '事故包的內容物變了');
    // ⚠️ 檔名清單證明不了「沒有把命中內容寫上磁碟」——逐檔掃內容才算。本例的命中就是暗號本身。
    for (const f of readdirSync(dir)) assert.equal(readFileSync(join(dir, f), 'utf8').includes('LIVE-CANARY-X-0123456789'), false, `${f} 裡有命中內容`);
  }
});

// ── 盒子禁區檢查要有考題（2026-09-02 第二輪稽核第 3 條）：哪天 .gitignore 漏一條、或有人 git add -f 把 store.db
//    收進 commit，git archive 就會把它帶進盒子；那道最後檢查若被改壞不會有任何考題叫——Grok 就在盒裡讀到完整帳務資料庫。
test('runScan｜git archive 帶出 data/store.db → 盒子禁區檢查退 2、明說是哪個檔（不是散文）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }   // 建盒子用 APFS clone，只在 macOS 考得到
  const repo = tinyRepo({ firstCommitFiles: { 'data/store.db': 'NOT-A-REAL-DB-JUST-A-MARKER\n' } });
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()) });
  assert.equal(r.code, 2, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /盒子裡出現不該有的檔：data\/store\.db/);
});

// ── 正式掃描用的沙箱設定＝寫死的 PROFILE（Codex #551 r4：字串比對題被等價寫法繞過 ⇒ 改成行為證據）──
test('runScan｜正式掃描用的沙箱設定＝寫死的 PROFILE、金絲雀不收 profile（行為證據：記錄實際收到的選項＋launch.json 的實際 argv＋盒內真的讀不到盒外）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ① 假金絲雀把它實際收到的選項記下來——不管正式碼用什麼寫法組選項，傳進來的值騙不了人
  /** @type {any[]} */ const seen = [];
  const recordingCanary = async (/** @type {string} */ _box, /** @type {any} */ opt) => { seen.push({ ...(opt ?? {}) }); return { code: 0, lines: ['（記錄型假金絲雀）'] }; };
  // ② 假 grok 在盒內試讀「盒外」的標記檔（/private/tmp 底下另一個目錄＝正式設定的禁區）；讀到就印出來、讀不到印 BLOCKED
  const probeDir = keep(mkdtempSync(join(BOX_ROOT, 'grok-flow-probe-')));
  const marker = join(probeDir, 'marker.txt'); const secret = `OUTSIDE-MARKER-${randomUUID()}`; writeFileSync(marker, secret + '\n');
  const inst = fakeGrok();
  const bin = join(inst, 'bin', 'grok'); const origScript = readFileSync(bin, 'utf8');
  assert.ok(origScript.includes('# REPLY-LINE'), 'fakeGrok 的回覆行標記不見了，這題的注入點失效');
  // ⚠️ 正向對照（Codex #551 r5）：同一條指令、同一個目標，先在沙箱外跑一次，必須讀到標記——
  //    否則路徑打錯、cat 起不來、權限先壞掉，盒內的「失敗」都會被誤當成沙箱擋住。
  const control = spawnSync('/bin/cat', [marker], { encoding: 'utf8' });
  assert.equal(control.status, 0, `對照組：沙箱外 cat 標記檔失敗（status ${control.status}：${(control.stderr || '').trim()}）`);
  assert.ok(control.stdout.includes(secret), '對照組：沙箱外必須讀得到標記內容');
  // 盒內失敗時把 cat 的錯誤訊息帶回來：要的是 Seatbelt 的「Operation not permitted」，不是「No such file」
  writeFileSync(bin, origScript.replace(/^printf '%s' .*# REPLY-LINE$/m,
    `if out=$(/bin/cat "${marker}" 2>&1); then printf 'PROBE-READ-OK:%s' "$out"; else printf 'PROBE-BLOCKED:%s' "$out"; fi # REPLY-LINE`));
  const iso = { ...isolated(), runCanary: recordingCanary };
  const out = join(keep(mkdtempSync(join(tmpdir(), 'fake-out-'))), 'reply.txt');
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst) });
  assert.equal(r.code, 0, r.summary.join('\n'));
  // 金絲雀：不得收到 profile 這個鍵（連 undefined 都不行——鍵存在＝正式路徑有人在組這個選項）
  assert.equal(seen.length, 1, '正式掃描應恰好叫金絲雀一次');
  assert.ok(!Object.hasOwn(seen[0], 'profile'), `正式掃描把 profile 傳給了金絲雀：${JSON.stringify(seen[0])}`);
  // 真 grok 發射：實際用的 argv 記在結果包的 launch.json；-f 後面必須是 repo 那份 grok-sandbox.sb
  const packs = readdirSync(iso.resultsRoot); assert.equal(packs.length, 1, '應恰好留一個結果包');
  const launch = JSON.parse(readFileSync(join(iso.resultsRoot, packs[0], 'launch.json'), 'utf8'));
  assert.equal(launch.sbArgv?.[0], '-f', `launch.json 的 sbArgv 形狀變了：${JSON.stringify(launch.sbArgv)}`);
  assert.equal(realpathSync(String(launch.sbArgv[1])), realpathSync(PROFILE), `真 grok 發射用的不是寫死的 PROFILE：${launch.sbArgv[1]}`);
  // 而且那份設定真的關得住：盒內的假 grok 讀不到盒外的標記
  const reply = readFileSync(out, 'utf8');
  assert.ok(reply.startsWith('PROBE-BLOCKED:'), `盒內探針沒回報被擋：${reply.slice(0, 120)}`);
  assert.match(reply, /Operation not permitted|Permission denied/, `失敗原因必須是沙箱拒絕，不是別的（實際：${reply.slice(0, 160)}）`);
  assert.ok(!reply.includes(secret), '盒內讀到了盒外的標記＝實際套的沙箱設定比正式的鬆');
  // ③ 剝掉註解後的結構釘子：組 sbArgv 那一句不得看環境變數／參數（env ?? PROFILE 這種寫法在 env 沒設時行為一樣，行為題量不到）
  const src = readFileSync(join(ROOT, 'scripts', 'grok-scan.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const m = /const sbArgv = \[([\s\S]*?)\];/.exec(src); assert.ok(m, 'grok-scan.js 找不到 const sbArgv = [...]');
  assert.match(m[1], /^\s*'-f',\s*PROFILE\s*,/, `sbArgv 的第一對必須是 '-f', PROFILE：${m[1].trim().slice(0, 80)}`);
  assert.ok(!/process\.env|\benv\b|argv|\?\?/.test(m[1]), `sbArgv 不得由環境變數／參數／退路決定：${m[1].trim().slice(0, 120)}`);
});
