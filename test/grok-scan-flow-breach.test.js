// @ts-check
// `grok-scan.js` 主流程行為考題（同族五支之一）：破口偵測：已知來源、排除集合、事故形狀，與幾支純函式。
//
// ⚠️ 這一族**共用夾具**在 `test/helpers/grok-scan-flow-fixtures.js`（射程、劃界與「為什麼拆」都寫在那裡）。
// 同族的其他幾支：`grok-scan-flow-preflight.test.js`、`grok-scan-flow-credentials.test.js`、`grok-scan-flow-incident.test.js`、`grok-scan-flow-redaction.test.js`。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { authNeedles, boxEntryKey } from '../scripts/grok-auth-refresh.js';
import { escapeForms, knownShapeHitsFromTree, runScan, shapeHitsIn, stripLineMarkers } from '../scripts/grok-scan.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_ENV, PEM_BEGIN, ROOT, SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeAuth, fakeGrok, fakeRelay, isolated, noFetch, promptFile, quiet, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);

test('readSessionsOnce｜r7：sessions 根目錄或中介目錄是 symlink → 當捷徑（odd）、不跟過去讀盒外（純函式，平台無關，CI 也跑）', async () => {
  const { readSessionsOnce } = await import('../scripts/grok-scan.js');
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  // ① 根目錄本身是指向盒外的 symlink
  {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-'));
    execFileSync('ln', ['-s', outside, join(home, 'sessions')]);
    const r = readSessionsOnce(join(home, 'sessions'));
    assert.deepEqual(r.odd, ['.'], '根目錄是捷徑沒被當成捷徑');
    assert.equal(r.files.size, 0, '跟著根目錄捷徑讀到盒外的檔');
  }
  // ② 中介目錄是 symlink
  {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-')); mkdirSync(join(home, 'sessions'));
    execFileSync('ln', ['-s', outside, join(home, 'sessions', 'ws')]);
    const r = readSessionsOnce(join(home, 'sessions'));
    assert.deepEqual(r.odd, ['ws']);
    assert.equal(r.files.size, 0);
  }
  // ③ 正常樹照讀
  {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-')); mkdirSync(join(home, 'sessions', 'ws'), { recursive: true }); writeFileSync(join(home, 'sessions', 'ws', 'a.jsonl'), 'x');
    const r = readSessionsOnce(join(home, 'sessions'));
    assert.deepEqual(r.odd, []); assert.deepEqual([...r.files.keys()], ['ws/a.jsonl']);
  }
});

test('runScan｜r7：假 grok 把整個 sessions 目錄換成指向盒外的 symlink → 1（事故）、盒外內容不進結果包', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const inst = fakeGrok();
  // 盒外目標放在假安裝樹裡（沙箱裡 ln -s 的目標不需要讀得到，symlink 本身寫在盒內就行）
  const outside = mkdtempSync(join(tmpdir(), 'outside-sessions-')); writeFileSync(join(outside, 'leak.txt'), 'OUTSIDE-SESSIONS-SECRET');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `rm -rf "$GROK_HOME/sessions"; /bin/ln -s ${JSON.stringify(outside)} "$GROK_HOME/sessions"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /捷徑/);
  const all = readdirSync(iso.resultsRoot).flatMap((d) => readdirSync(join(iso.resultsRoot, d)));
  assert.ok(!all.includes('sessions'), '事故還保存了 sessions');
});

test('憑證｜r7（Codex #1）：auth.json 的外層鍵名不是釘住的 issuer::client_id → 不重建、不掃；鍵名不進 DLP 的「給了盒子」集合（純函式，CI 也跑）', async () => {
  const { refreshSandboxAuth } = await import('../scripts/grok-auth-refresh.js');
  const dir = mkdtempSync(join(tmpdir(), 'auth-key-'));
  const cred = JSON.parse(fakeAuth())[boxEntryKey()];
  // 鍵名是 email → 拒
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ 'owner@example.test': cred }));
  await assert.rejects(() => refreshSandboxAuth(dir, { fetchImpl: noFetch }), /鍵名/, 'email 當鍵名被接受了——它會原樣進盒子');
  // 鍵名對 → 過，且盒內那份的鍵名就是釘住的形狀
  writeFileSync(join(dir, 'auth.json'), fakeAuth());
  const a = await refreshSandboxAuth(dir, { fetchImpl: noFetch });
  assert.deepEqual(Object.keys(a.forBox), [boxEntryKey()]);
  // 鍵名若含身分字串，authNeedles 不會因為「鍵名給了盒子」而排除同值的針
  const needles = authNeedles({ 'fake-owner@example.test': { ...cred, email: 'fake-owner@example.test' } });
  assert.ok(needles.includes('fake-owner@example.test'), '鍵名同值的 email 被排除出針了');
});

test('憑證｜DLP 針收集：toString／constructor 這類原型繼承名不可被當成 BOX_FIELDS', () => {
  const auth = JSON.parse(fakeAuth());
  const cred = auth[boxEntryKey()];
  cred.toString = 'TOSTRING-SHOULD-BE-A-DLP-NEEDLE';
  cred.constructor = 'CONSTRUCTOR-SHOULD-BE-A-DLP-NEEDLE';
  const needles = authNeedles(auth);
  assert.ok(needles.includes('TOSTRING-SHOULD-BE-A-DLP-NEEDLE'), 'toString 被當成盒內白名單欄位，沒有進 DLP 針');
  assert.ok(needles.includes('CONSTRUCTOR-SHOULD-BE-A-DLP-NEEDLE'), 'constructor 被當成盒內白名單欄位，沒有進 DLP 針');
});

test('runScan｜r7（Codex #2）：轉送器拒絕了不在白名單的請求 → 掃描退 2（吵），不靠 grok 的退出碼；刻意擋的 bundle/archive → 容許、只記錄', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const real = fileURLToPath(new URL('../scripts/grok-relay.js', import.meta.url));
  for (const [label, path, want] of /** @type {[string, string, 0|2][]} */ ([['白名單外', '/v1/not-in-allowlist', 2], ['刻意擋的', '/v1/bundle/archive', 0], ['刻意擋的（subagents）', '/v1/subagents/bundle', 0]])) {
    const iso = isolated(); const inst = fakeGrok();
    // 假 grok 用盒內 curl 打本掃轉送器（port 從 env 來）；grok 自己仍退 0
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `/usr/bin/curl -s -o /dev/null -m 5 "\${GROK_CLI_CHAT_PROXY_BASE_URL%/v1}${path}" -H "Authorization: Bearer $(sed -n 's/.*"key":"\\([^"]*\\)".*/\\1/p' "$GROK_HOME/auth.json")"; $1`));
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: real });
    assert.equal(r.code, want, `${label}：${r.summary.join('\n')}`);
    if (want === 2) assert.match(r.summary.join('\n'), /轉送器拒絕了 1 個不在白名單/, label);
    else assert.ok(logs.some((l) => l.includes('刻意擋的形狀') && l.includes(`GET ${path}`)), `${label}：沒記錄被容許的拒絕`);
  }
});

test('runScan｜驗屍的破口線索若已在材料裡（受掃 diff 自己含私鑰字面、head 樹裡沒有）→ 不算事故；材料裡沒有的同形狀仍是 1（#500 第一次正式掃描誤中自己；材料那條路）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 假鑰要落在「**只有材料有、樹裡沒有**」的位置，否則樹那條排除路會把這題一起變綠＝兩道護欄互相遮蔽
  //    （原版把它 commit 進 head，於是材料那條整個壞掉這題也照樣綠——Codex #530 r1 用突變證明過）。
  //    做法：base 有這個檔、head **刪掉**它 ⇒ 內容以 `-` 開頭的行出現在 diff 裡、而 head 樹裡沒有。
  //    diff 行首那個記號正是 `unprefixed` 那半在還原的東西，所以這題也順便守著它。
  const keyLines = [PEM_BEGIN('RSA'), 'MIIEFAKEFIXTUREKEYBODYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '-----END RSA PRIVATE KEY-----'];
  const repo = tinyRepo({ firstCommitFiles: { 'fixture.txt': `a test fixture key:\n${keyLines.join('\n')}\n` } });
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8', env: CLEAN_ENV });
  git(['rm', '-q', 'fixture.txt']); git(['commit', '-q', '-m', 'drop fixture']);
  const head3 = git(['rev-parse', 'HEAD']).trim();
  const prompt = promptFile();
  const fakeKeyJson = keyLines.join('\\n');                 // 日誌是 JSON：換行成字面 \n
  const fakeKeyJson2 = keyLines.join('\\\\n');              // 巢狀 JSON：再轉義一層
  for (const [label, sessionLine, want] of /** @type {[string, string, 0|1][]} */ ([
    ['材料裡那把假鑰以 JSON 字串形式出現在日誌（換行成字面 \\n）', `printf '%s\\n' '{"type":"assistant","content":"${fakeKeyJson}"}'`, 0],
    ['材料裡那把假鑰以巢狀 JSON（雙重轉義）出現在日誌', `printf '%s\\n' '{"type":"assistant","content":"{\\"k\\":\\"${fakeKeyJson2}\\"}"}'`, 0],
    ['只有標頭、沒內容（題名／註解）', `printf '%s\\n' '{"type":"assistant","content":"see BEGIN RSA PRIVATE KEY in test name"}'`, 0],
    ['同標頭、不同內容的外部私鑰（r10：材料有標頭也不能放過）', `printf '%s\\n' '{"type":"assistant","content":"outside: ${PEM_BEGIN('RSA')}\\nMIIEOUTSIDEKEYBODYBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB\\n-----END RSA PRIVATE KEY-----"}'`, 1],
    // body 刻意是**明顯的假值**：原本那串 `b3BlbnNzaC1rZXktdjEA…AAAAtzc2g` 是每一把未加密 ed25519 私鑰
    //   **逐字相同的真開頭**（用格式常數重算，沒有產生任何真鑰匙：未加密 OpenSSH 的固定段 39 bytes
    //   ⇒ base64 前 **52** 個字元完全決定；ed25519 再加公鑰段的長度欄與識別字後固定段 62 bytes
    //   ⇒ 前 **80** 個字元完全決定。而那串是 67 個字元、落在完全決定的範圍內 ⇒ 它是任何真 ed25519
    //   私鑰的合法前綴，實測 startsWith 為真）。精確比對下無害，但只要哪天有人把樹那半
    //   放寬成前綴，它就變成一條「被截短的真 SSH 私鑰一律當本來就給它的東西」的路。本題只需要「一種
    //   材料裡沒有的 kind」，換掉不影響它在守的行為。
    // ⚠️ 本題**沒有**在守「OPENSSH 這個 kind 走得到」（改成 RSA 它照樣綠）——四種 kind 都被偵測器認得，
    //   是由 題名關鍵字「源碼都不留破口形狀的字面」那一題釘的。
    ['材料裡沒有的同形狀', `printf '%s\\n' '{"type":"assistant","content":"${PEM_BEGIN('OPENSSH')}\\nMIIEOPENSSHKEYBODYDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD\\n"}'`, 1],
  ])) {
    const iso = isolated(); const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `${sessionLine} >> "$ws/fake-session/updates.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: head3, promptFile: prompt }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, want, `${label}：${r.summary.join('\n')}`);
  }
});

/** 一把「真實長度」的假鑰：標頭＋8 行 64 字 base64＋結尾，真換行（不是 JS 字面的 \n） */
const PEM_LINES = [PEM_BEGIN('RSA'), ...Array.from({ length: 8 }, (_, i) => `MIIETREEONLYKEYBODY${String.fromCharCode(65 + i).repeat(45)}`), '-----END RSA PRIVATE KEY-----'];
const PEM_TEXT = PEM_LINES.join('\n') + '\n';

test('runScan｜破口形狀只在 head 樹裡、不在 diff 裡 → 不算事故（#516 的假事故）；樹裡沒有的同形狀仍是 1', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // 假鑰 commit 在 base **之前** ⇒ 在 head 樹裡、不在 base..head 的 diff 裡＝不在材料裡。
  // 2026-08-26 #516 就是這個形狀：受掃檔自己含假鑰 fixture，grok 讀了它就被判成「沙箱破了」。
  const repo = tinyRepo({ firstCommitFiles: { 'fixture-key.pem': PEM_TEXT } });
  const inTreeJson = PEM_LINES.join('\\n');        // 日誌是 JSON：真換行成字面 \n
  // 讀檔工具會在第 1 行與每 10 行插 `N→`；這裡刻意讓記號落在鑰匙區間內
  const withMarkers = PEM_LINES.map((l, i) => (i === 0 || (i + 1) % 10 === 0 ? `${i + 1}→${l}` : l)).join('\\n');
  for (const [label, sessionLine, want] of /** @type {[string, string, 0|1][]} */ ([
    ['樹裡那把鑰匙原樣回錄（cat 形）', `printf '%s\\n' '{"type":"assistant","content":"${inTreeJson}"}'`, 0],
    ['樹裡那把鑰匙帶讀檔工具的行號記號回錄', `printf '%s\\n' '{"type":"assistant","content":"${withMarkers}"}'`, 0],
    ['同標頭、不同內容（樹裡沒有這一把）', `printf '%s\\n' '{"type":"assistant","content":"${PEM_BEGIN('RSA')}\\nMIIEOUTSIDEKEYBODYZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ\\n"}'`, 1],
    ['只有標頭、沒內容（題名／註解）', `printf '%s\\n' '{"type":"assistant","content":"see BEGIN RSA PRIVATE KEY in test name"}'`, 0],
    // 樹那半刻意用**精確比對**：放寬成子字串包含就等於允許「真外洩剛好是某條 fixture 的前綴」被排除。
    // 這一案把樹裡那把鑰匙截成前綴（少了尾巴幾行）⇒ 逐字對不上 ⇒ 仍要報事故。
    ['樹裡那把鑰匙被截成前綴（日誌中段截斷的形狀）', `printf '%s\\n' '{"type":"assistant","content":"${PEM_LINES.slice(0, 4).join('\\n')}"}'`, 1],
  ])) {
    const iso = isolated(); const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `${sessionLine} >> "$ws/fake-session/updates.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, want, `${label}：${r.summary.join('\n')}`);
  }
});

test('runScan｜假 grok 先把鑰匙形狀寫進盒內 src、再把同一串回錄 → 仍是 1（已知來源不採信盒子裡的磁碟）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 這題不是驗新功能，是**釘住來源不准換成 `<box>/src`**：盒子對 grok 是可寫的（profile 放行整個 SCAN_DIR），
  //    任何從盒內磁碟建已知集合的實作，都會讓破出沙箱的 grok 把自己的外洩登記成「本來就給它的東西」。
  const repo = tinyRepo(); const iso = isolated(); const inst = fakeGrok();
  const planted = PEM_LINES.join('\\n');
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8')
    .replace(/^(printf '%s' .*# REPLY-LINE)$/m,
      `printf '%s\\n' '${planted}' > ./planted-key.pem; printf '%s\\n' '{"type":"assistant","content":"${planted}"}' >> "$ws/fake-session/updates.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, `盒內自己種的鑰匙不該讓驗屍放行：${r.summary.join('\n')}`);
});

test('runScan｜事故訊息要帶得出族別與筆數，而且**完整命中值不回聲**（退 1 不留 sessions，事後只剩這行）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // 退 1 不留 sessions ⇒ 事後能拿來分辨「真破口」與「#516 式假事故」的只有這行字。
  // 而 repo 是公開的、失敗原因會被抄進 PR 描述 ⇒ 命中內容不可以回聲進去。
  {
    const liveSecret = 'LIVE-CANARY-BRIEF-77c1e0'; const iso = isolated(); const repo = tinyRepo();
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `saw ${liveSecret}` })), relayScript: fakeRelay('ok'), liveSecret });
    const s = r.summary.join('\n');
    assert.equal(r.code, 1, s);
    assert.match(s, /暗號 1 條/, '沒帶出「命中的是暗號那一族、幾條」');
    assert.match(s, /形狀 0 條/, '沒帶出形狀那族的筆數');
    assert.equal(s.includes(liveSecret), false, '事故訊息把暗號本身印出來了——那會被抄進公開的 PR 描述');
    // ⚠️ 斷言涵蓋的就是「**完整**命中值不回聲」；只洩前綴這題抓不到——題名與註解都照這個射程寫。
    assert.match(s, /形狀那族＝剝完行號記號後仍不在本次排除集合裡/, '尾句改回「不在 head 樹裡」那種不成立的話也不會紅');
  }
  {
    // 形狀那族：樹裡沒有的私鑰形狀 → 要帶出筆數與長度，同樣不得出現內容
    const body = 'MIIEBRIEFSHAPEKEYBODY' + 'W'.repeat(50);
    const iso = isolated(); const repo = tinyRepo(); const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf '%s\\n' '{"type":"assistant","content":"${PEM_BEGIN('RSA')}\\n${body}"}' >> "$ws/fake-session/updates.jsonl"; $1`));
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    const s = r.summary.join('\n');
    assert.equal(r.code, 1, s);
    assert.match(s, /形狀 1 條/, '沒帶出形狀那族的筆數');
    assert.match(s, /形狀長度 \d+/, '沒帶出形狀命中的長度');
    assert.equal(s.includes(body), false, '事故訊息把命中內容印出來了');
  }
});

test('runScan｜暗號帶正則元字元也照樣抓得到（字面搜尋，不編譯成正則）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // `[` 會讓 new RegExp 當場丟、`.` 會大量誤中、`$` 反而找不到自己。正式路徑的暗號是 base36 碰不到，
  // 但這一格是可注入的，宣稱「字面搜尋」就要有題撐著（Codex #530 r5：改回 new RegExp 時四題活金絲雀題全綠）。
  const liveSecret = 'LIVE-CANARY-[meta].$^(regex)-9f2c4a7b';
  const iso = isolated(); const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `leaked: ${liveSecret}` })), relayScript: fakeRelay('ok'), liveSecret });
  assert.equal(r.code, 1, `帶元字元的暗號沒被抓到（或整支炸掉）：${r.summary.join('\n')}`);
});

test('runScan｜活金絲雀的暗號逐字 commit 在受掃樹裡，出現在回覆仍是 1（排除只作用在形狀那一族）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const liveSecret = 'LIVE-CANARY-TREE-9f2c4a7b1e';
  const repo = tinyRepo({ firstCommitFiles: { 'canary-lookalike.txt': liveSecret + '\n' } });
  const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ reply: `I read your store.db: ${liveSecret}` })), relayScript: fakeRelay('ok'), liveSecret });
  assert.equal(r.code, 1, `暗號被樹來源排除掉了——那是唯一不可偽造的那根針：${r.summary.join('\n')}`);
});

test('knownShapeHitsFromTree｜建不出來一律 throw，不回空集合（純函式，平台無關，CI 也跑）', () => {
  const repo = tinyRepo();
  // 這題直接打純函式：失敗形狀與訊息不必經過整條掃描流程就驗得到（接線由下一題跨平台驗）。
  assert.throws(() => knownShapeHitsFromTree(repo.dir, 'f'.repeat(40)), /ls-tree/, '查不到的 head 應該 throw');
  // 回空集合＝安靜退化成修法之前的行為，比丟例外糟：那會讓 #516 的假事故重新出現而沒人知道
  const ok = knownShapeHitsFromTree(repo.dir, repo.head);
  assert.equal(ok.hits.size, 0, 'tinyRepo 的樹裡沒有鑰匙形狀，這裡不該有命中');
  assert.ok(ok.blobs >= 2, `blob 數不對：${ok.blobs}`);
});

test('knownShapeHitsFromTree｜非 ASCII 檔名的 blob 也要讀到（`-z`；不然掃描器會靜靜跳過中文檔名）', () => {
  // 這個 repo 本來就有中文檔名。git 預設會把非 ASCII 路徑輸出成八進位轉義並加引號，
  // 沒有 -z 的話那些檔會查不到而被**靜靜跳過**——排除集合少一塊、引用到就誤報事故。
  const key = `${PEM_BEGIN('RSA')}\n${'MIIECJKNAMEKEYBODY' + 'Q'.repeat(50)}\n`;
  const repo = tinyRepo({ firstCommitFiles: { '中文檔名-鑰匙.pem': key } });
  const r = knownShapeHitsFromTree(repo.dir, repo.head);
  assert.equal(r.hits.size > 0, true, '非 ASCII 檔名的 blob 沒被讀到＝那個檔的形狀不在排除集合裡');
  assert.deepEqual([...r.bySource.keys()], ['中文檔名-鑰匙.pem'], `來源檔名不對：${[...r.bySource.keys()]}`);
});

test('knownShapeHitsFromTree｜超過單檔上限的 blob 要跳過，**而且要說出跳了誰**（涵蓋缺口不可以悄悄發生）', () => {
  // ⚠️ 這題釘的是「缺口看得見」，不是「缺口不存在」：跳過本身是刻意的（三形階梯會做兩次 JSON.stringify），
  //    但跳過的檔案形狀不進排除集合 ⇒ grok 引用到它就會誤報事故。所以跳了誰一定要能被印出來。
  // ⚠️ 用**注入的小門檻**而不是真的 16 MiB 檔：CI 上 `node --test` 多檔並行，
  //    真的大檔會配置數十 MB、把隔壁計時型考題壓過門檻（實測本支 2/2 紅、同時段重跑 main 綠）。
  const body = 'M'.repeat(200);
  const repo = tinyRepo({ firstCommitFiles: { 'big-key.pem': `${PEM_BEGIN('RSA')}\n${body}\n` } });
  const r = knownShapeHitsFromTree(repo.dir, repo.head, 64);
  assert.deepEqual(r.skippedBig, ['big-key.pem'], '跳過的大檔沒有被列出來＝呼叫端印不出缺口');
  assert.equal(r.hits.size, 0, '大檔的形狀不該進排除集合（跳過就是跳過；方向是誤報，不是靜靜放行）');
});

test('knownShapeHitsFromTree｜非 blob 的樹項目要跳過（gitlink＝物件不在這個 repo 裡，不跳過就會 throw）', () => {
  const repo = tinyRepo();
  const git = (/** @type {string[]} */ a) => execFileSync('git', ['-C', repo.dir, ...a], { encoding: 'utf8', env: CLEAN_ENV });
  // 直接寫一個 gitlink 進索引：它的 oid 指向一顆**這個 repo 裡沒有**的 commit
  git(['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},sub`]);
  git(['commit', '-q', '-m', 'gitlink']);
  const head = git(['rev-parse', 'HEAD']).trim();
  assert.doesNotThrow(() => knownShapeHitsFromTree(repo.dir, head), '沒跳過非 blob ⇒ cat-file 會查不到那顆物件而失敗');
});

test('runScan｜排除集合的記帳要印出來：blob 數、命中數、跳過的大檔（含「等 N 個」）——缺口要看得見', async () => {
  // ⚠️ 純函式題只證明「回傳值裡有 skippedBig」；把**呼叫端那條記帳**整行拿掉、或只拿掉「等 N 個」，
  //    純函式題都還是綠的（Codex #530 r5 用定點突變證明）。所以這一題直接驗注入的 log 收到的字串。
  const big = 'M'.repeat(200);   // 搭配注入的小門檻（理由同上：不要在 CI 上配置大塊記憶體）
  const files = Object.fromEntries(['big1.pem', 'big2.pem', 'big3.pem', 'big4.pem'].map((n) => [n, `${PEM_BEGIN('RSA')}\n${big}\n`]));
  const repo = tinyRepo({ firstCommitFiles: files });
  /** @type {string[]} */ const logs = [];
  // ⚠️ 故意讓它在**雜湊檢查**就退場（給錯的 expectedSha256）：記帳那行在更早就印了，
  //    而這樣就不會起轉送器、不會跑沙箱——本題只看那一行，不該把整條掃描流程拖進來。
  await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, grokInstall: fakeGrok(), expectedSha256: '0'.repeat(64), maxBlobBytes: 64 });
  const line = logs.find((l) => l.startsWith('（破口已知來源：'));
  assert.ok(line, `記帳那行沒印出來：${logs.slice(0, 3).join(' / ')}`);
  // ⚠️ 用 \d+ 會放過「把數字硬編成任意值」——這裡驗真正的數字：
  //    tinyRepo 的第一顆 commit＝a.txt＋tree-only.txt＋四個大檔＝6 個 blob；大檔全跳過 ⇒ 形狀命中 0 條。
  assert.match(line, /head 樹 6 個 blob/, 'blob 數不對（或只印了外形）');
  assert.match(line, /形狀命中 0 條/, '命中數不對（大檔跳過了就不該有命中）');
  assert.match(line, /4 個超過單檔上限沒讀/, '沒印跳過幾個大檔');
  assert.match(line, /等 4 個/, '跳過清單被截成前三個卻沒說還有更多');
});

test('runScan｜已知來源（head 樹）建不出來 → 退 2 並指名是它，不安靜退回「只認材料」（接線；建盒子之前就退，平台無關）', async () => {
  const repo = tinyRepo();
  // 通過寫死 SHA 的格式檢查、但這個 repo 裡沒有這顆 commit
  const r = await runScan({ base: repo.base, head: 'f'.repeat(40), promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /已知來源/, '退 2 了但沒說是「已知來源建不出來」——分不出是哪一種失敗');
});

test('runScan｜比對強度：命中「以某條已知命中開頭」也不得被排除（放寬的危險方向）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ⚠️ 放寬有兩個方向，危險程度差很多：
  //   ・`known.startsWith(hit)`（命中是已知命中的前綴）＝截斷那一族；
  //   ・`hit.startsWith(known)`（命中**以**已知命中開頭）＝**更危險**：一條短的已知命中會把所有
  //     以它開頭的東西一起吞掉，而最短的合法命中只有 58 個字元、其中可以一個酬載字元都沒有
  //     （`{32,}` 的字元類含空白與反斜線＝長度下限、不是熵下限）。
  //   Codex #531 r1 抓到我原本只對前者做了突變、後者沒有題守著。
  // 做法：樹裡放一把鑰匙，日誌裡送「同一把鑰匙**再接上**更多酬載」——它以樹裡那條開頭，仍必須是事故。
  const repo = tinyRepo({ firstCommitFiles: { 'fixture-key.pem': PEM_TEXT } });
  // ⚠️ 要延長的是**命中本身**，所以接在 END 之前：`-----END` 裡的 `-` 不在破口正則的字元類裡，
  //    接在它後面命中會在那裡截斷，送出去的其實就是樹裡那條本身（第一版就是這樣，未突變也紅）。
  const extended = PEM_LINES.slice(0, -1).join('\\n') + '\\n' + 'MIIEEXTENDEDBEYONDTHEFIXTURE' + 'V'.repeat(40);
  const iso = isolated(); const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `printf '%s\\n' '{"type":"assistant","content":"${extended}"}' >> "$ws/fake-session/updates.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, `以已知命中開頭的更長命中被排除了——那是放寬裡最危險的方向：${r.summary.join('\n')}`);
});

/**
 * flexToken 那條腿的夾具：鍵名**執行時才拼**。
 * 直接寫字面會讓題名關鍵字「源碼都不留破口形狀的字面」那一題轉紅——那是既有的假事故防線，
 * 不可以為了寫這一題而放寬它。
 */
const FLEX_KV = (/** @type {string} */ val) => `"flex${'Token'}": ${JSON.stringify(val)}`;
const FLEX_VAL = 'SECRET-VALUE-1234567890';

test('BREACH_SHAPES｜flexToken 腿在 JSON 轉義形下也要認得（純函式，平台無關，CI 也跑）', () => {
  // 為什麼要有這一題：這條腿掃的是 grok 的 session 日誌，而那是 **JSONL**——原文的 `"` 在檔案裡是 `\"`。
  // 舊寫法要求 `flexToken` 後面緊跟一個**字面**的 `"` ⇒ 真的 flexToken 外洩到日誌裡**一條都認不得**，
  // 而且沒有第二道網（DLP 針只取自沙箱 auth.json，不含 flexToken）＝靜靜放過。
  assert.ok(FLEX_KV('x').includes('flex' + 'Token'), '夾具沒拼出鍵名');                       // 反空包彈
  assert.ok(FLEX_KV(FLEX_VAL).includes(FLEX_VAL), '夾具沒帶值');
  const material = `  ib: {\n${FLEX_KV(FLEX_VAL)}\n  }\n`;
  // ⚠️ 夾具**不可以**用 escapeForms 生（Codex #534 r1 的突變：讓它第三格重複第二格，這一題照樣綠
  //    ＝拿受測函式自己當 oracle）。這裡就地把三形算出來，再單獨斷言階梯本身逐字相同。
  const d0 = material, d1 = JSON.stringify(d0).slice(1, -1), d2 = JSON.stringify(d1).slice(1, -1);
  assert.notEqual(d1, d2, '就地算的兩形一樣＝夾具自己壞了，後面量不到東西');
  assert.deepEqual(escapeForms(material), [d0, d1, d2], 'escapeForms 的三形跟就地算的對不上');
  assert.equal(shapeHitsIn(d0).length, 1, '原文形（對照組：修法前後都該是 1）');
  assert.equal(shapeHitsIn(d1).length, 1, 'JSON 轉一層認不得——日誌走的就是這一形');
  assert.equal(shapeHitsIn(d2).length, 1, 'JSON 轉兩層認不得（同一檔裡兩種深度都出現過）');
  // 命中要**逐字結束在值本身**：只換引號、不擋轉義殘渣的話，命中會多吃反斜線 ⇒ 這一行轉紅
  assert.ok(shapeHitsIn(d1)[0].endsWith(FLEX_VAL), `命中夾帶了值以外的轉義殘渣：${JSON.stringify(shapeHitsIn(d1)[0].slice(-12))}`);
  // 真日誌長相：JSONL 一行、內容還帶讀檔工具的行號記號
  const line = JSON.stringify({ type: 'tool_result', content: `280→${material}` });
  const got = shapeHitsIn(stripLineMarkers(line));
  assert.equal(got.length, 1, '真 JSONL 一行（含行號記號）抓不到');
  // 對稱：日誌形的命中必須逐字落在排除側同一把階梯算出的集合裡，否則修完會變成下一次假事故
  const known = new Set([d0, d1, d2].flatMap((f) => shapeHitsIn(f)));
  for (const h of got) assert.ok(known.has(h), '日誌命中跟排除側對不上＝假事故');
});

test('BREACH_SHAPES｜值沒有收尾引號時，命中長度不可以由「上下文」決定（純函式，平台無關，CI 也跑）', () => {
  // ⚠️ 這一題守的是**修法自己會製造的假事故**：值那格若只擋引號、不擋換行，沒有收尾引號的文字
  //    （散文、表格、註解、grep 只列命中行——本專案天天在寫）會讓命中一路吃到「下一個引號」為止。
  //    於是同一段無害文字，在材料裡與在日誌裡算出**不同長度的字串**、精確比對的排除對不上 ⇒ 事故。
  //    這種文字最先出現的地方就是講這條腿的 PR 描述與註解本身。
  const one = `  一層  flex${'Token'}\\": \\"${FLEX_VAL}      舊 0 條／新 1 條   ← 病灶\n`;
  const withMore = one + `  兩層  flex${'Token'}\\\\\\": SOMETHING\n`;
  assert.ok(one.includes(FLEX_VAL) && withMore.includes(FLEX_VAL), '夾具沒帶值');   // 反空包彈
  const a = shapeHitsIn(one), b = shapeHitsIn(withMore);
  assert.equal(a.length, 1, '這段文字本來就該命中（不然本題量不到東西）');
  assert.equal(b.length, 1, '加上後文之後命中數變了');
  assert.equal(a[0], b[0], `同一段文字因為後文不同而算出不同命中＝排除必然對不上＝假事故：${a[0].length} vs ${b[0].length}`);
  assert.ok(!a[0].includes('\n'), '命中跨行了——視窗不是行內局部');
});

test('考題檔｜這一族**每一支**源碼都不留破口形狀的字面（純函式，平台無關，CI 也跑）', () => {
  // 為什麼要有這一題：#516（2026-08-26）與 #530（2026-08-30）兩支的複審後掃都判事故、兩次都靠
  // William 裁示「視為誤判」放行。⚠️ 分層講：**這一類**假事故的成因清楚——本檔的字面假鑰被引用時
  // 換了呈現、逐字對不上；但**那兩次具體命中了什麼**至今未定（現場被護欄自己刪掉：退 1 不留 sessions）。
  // 字面一旦回來，下一支動到本檔的 PR 又可能掃不乾淨——
  // 而複審後掃**不在任何合併閘的射程裡**（`scripts/check-*.js` 那幾道與 workflows 都不讀它的退出碼），
  // 漏掉不會有東西擋人——所以這件事只能靠這一題自己守。
  // ⚠️ 誠實劃界（三條）：
  //   ①看的是**這一族**，不是整棵樹：別的檔案新增假鑰它抓不到。全樹那條靠 runScan 的記帳行
  //     （會列出「來自 <檔>×<n>」）看得見，那是**看得見、不是擋得住**。
  //   ②只看**源碼**：考題執行後的值若進了 grok 的日誌仍會判事故——那本來就該判事故。
  //   ③掃描讀的是**已 commit** 的 blob，這一題讀的是工作區的檔；未 commit 的改動兩邊會不一致。
  // ⚠️ 2026-09-08 拆檔之後，這一題**不可以再只看自己那一支**（`import.meta.url`）：同族拆成五支＋一支共用夾具，
  //    只看自己等於其餘五支從此無人看管——那正是「靜靜通過」。改成掃**整族**（檔名前綴 + 共用夾具）。
  const dir = join(ROOT, 'test');
  const family = readdirSync(dir).filter((f) => /^grok-scan-flow-.*\.test\.js$/.test(f)).map((f) => join('test', f));
  family.push(join('test/helpers', 'grok-scan-flow-fixtures.js'));
  // 空包彈保險絲：檔名規則哪天改了（或整族被搬走），這一題不可以靜靜變成掃 0 個檔案。
  // ⚠️ **驗的是成員身分、不是數量**（#581 r1）：只驗「至少幾個」的話，把某一支改名到前綴之外、
  //    同時另外多一支符合前綴的檔案，數量還是夠，而那支被改名的檔就沒人看管了。
  //    ⇒ 五支同族的名字寫死在這裡：要拆分或改名，**必先來改這一行**（變更必經考題）。
  const EXPECTED = ['preflight', 'credentials', 'breach', 'incident', 'redaction']
    .map((k) => `test/grok-scan-flow-${k}.test.js`)
    .concat('test/helpers/grok-scan-flow-fixtures.js');
  for (const want of EXPECTED) {
    assert.ok(family.includes(want), `這一族少了 ${want}——改名或拆分了？這一題要跟著改（不然那一支從此沒人掃）`);
  }
  assert.deepEqual(family.slice().sort(), EXPECTED.slice().sort(),
    '掃到的檔案集合跟寫死的名單對不上——多一支符合前綴的檔案也要來這裡登記，不然它可能是用來湊數的');
  for (const rel of family) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.deepEqual(shapeHitsIn(src), [], `${rel} 源碼含破口形狀命中——Grok 讀到它就可能判假事故`);
    for (const form of [JSON.stringify(src), JSON.stringify(JSON.stringify(src))]) {
      assert.deepEqual(shapeHitsIn(form), [], `${rel} 源碼的 JSON 轉義形含破口形狀命中（日誌是 JSONL，走的是這一形）`);
    }
    // 比「有沒有命中」寬一點的規則，因為它是人記得住的那一版：不寫具體 kind 的字面標頭
    assert.equal(/-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/.test(src), false, `${rel} 出現字面標頭——請改用 PEM_BEGIN(kind) 執行時拼`);
  }
  // helper 自己要對：四種 kind 都要被偵測器認得，否則「改用 helper」等於把某些題悄悄變成不再命中
  for (const kind of /** @type {const} */ (['RSA', 'OPENSSH', 'EC', 'DSA'])) {
    assert.equal(shapeHitsIn(`${PEM_BEGIN(kind)}\n${'A'.repeat(40)}`).length, 1, `PEM_BEGIN('${kind}') 拼出來的標頭偵測器認不得`);
    // ⚠️ 上一行單獨是空包彈：helper 若忽略 kind、一律回 RSA，四種都還是命中 1（Codex #531 r1 實測）。
    //    要驗的是「kind 真的有進到標頭裡」。
    assert.equal(PEM_BEGIN(kind).includes(kind), true, `PEM_BEGIN('${kind}') 沒有把 kind 放進標頭——helper 忽略參數了`);
    // ⚠️ 只驗 includes 仍是空包彈：「固定產生 RSA 標頭、把 kind 接在尾端」也會過（Codex #531 r2 實測）。
    //    再驗兩件事：結尾要正確（接在尾端就會壞），且**不得混進別的 kind**（固定 RSA 就會壞）。
    assert.equal(PEM_BEGIN(kind).endsWith(' PRIVATE KEY-----'), true, `PEM_BEGIN('${kind}') 的結尾不對——kind 可能被接在尾端`);
    for (const other of ['RSA', 'OPENSSH', 'EC', 'DSA'].filter((k) => k !== kind)) {
      assert.equal(PEM_BEGIN(kind).includes(other), false, `PEM_BEGIN('${kind}') 裡混進了 ${other}——helper 可能固定回某一種`);
    }
  }
});

test('stripLineMarkers｜剝掉讀檔工具的行號記號（純函式，平台無關，CI 也跑）', () => {
  assert.equal(stripLineMarkers('1→abc\n10→def'), 'abc\ndef', '原文換行的記號沒剝掉');
  assert.equal(stripLineMarkers('x\\n12→abc'), 'x\\nabc', 'JSONL 的字面 \\n 前綴沒認出來');
  assert.equal(stripLineMarkers('見 12→ 那格'), '見 12→ 那格', '沒有換行前綴的數字不可以被當成行號吃掉');
  // ⚠️ 反斜線串要從**頭**認起：5 個以上時 `{1,4}` 會從第 2 個起算而誤剝（Codex #530 r1 抓到）
  assert.equal(stripLineMarkers('a\\\\\\\\\\n12→b'), 'a\\\\\\\\\\n12→b', '從反斜線串中段開始比對＝誤剝');
  // ⚠️ 誠實劃界：正文裡字面的 `\n12→` 與真記號分不出來，這一格照實斷言「會被剝掉」，不假裝守得住
  assert.equal(stripLineMarkers('x\\n12→y'), 'x\\ny', '這是已知的過度剝除，改行為要連同註解的劃界一起改');
  // `→` 不在破口正則的字元類裡：記號落在 `{32,}` **湊滿之前**時整條不匹配＝真鑰匙靜靜放行，剝完才看得見。
  // ⚠️ 條件是「湊滿之前」，**不是**「標頭之後」——先湊滿 32 個合法字元、記號落在那之後仍然命中（Codex #530 r8 的反例）。
  const keyWithMarker = `${PEM_BEGIN('RSA')}\n10→${'MIIEREALKEYBODY' + 'A'.repeat(50)}`;
  assert.equal(shapeHitsIn(keyWithMarker).length, 0, '前提變了：帶記號時本來就抓得到，這題的理由要重寫');
  assert.equal(shapeHitsIn(stripLineMarkers(keyWithMarker)).length, 1, '剝完仍抓不到＝靜默漏放沒被修掉');
});
