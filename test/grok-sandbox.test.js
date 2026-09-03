// @ts-check
// Grok 沙箱的考題（2026-08-22，William 裁示 B）。
//
// 這支考的是**圍欄本身**：用 scripts/grok-sandbox.sb 啟動的程式，做不到它不該做的事、做得到它該做的事。
// 探針用的是 `cat`／`ls`／`curl`——它們**確定會嘗試**；不用 grok 當探針，因為 grok 會「選擇」不做，那不是圍欄。
//
// ⚠️ 誠實劃界：
// ・只在 macOS 跑得了（sandbox-exec 是 macOS 專有）。CI 是 Linux → **明確 skip**，不假綠、不假紅。
//   真正的強制點不在這裡，在 scripts/grok-scan.js：每次掃描前必跑金絲雀，任一隻活著就不掃（fail-closed）。
// ・證明的是「列出的這幾種形狀擋得住」，不證明沒有別的洞。
// ・突變實測（2026-08-22）：拿掉「家目錄全拒」→ 4 隻活；拿掉「網路全拒」→ 1 隻活；整檔換成 allow default → 5 隻活。
//   金絲雀自己的兩個假紅也記在這裡：①status 為 null（被殺）曾被當成「擋住」；②探針用 -I 在沙箱外本來就失敗。
//   兩個都修了——金絲雀要先證明自己會叫，才能拿來證明圍欄。
// ・紅燈本身的突變實測（2026-09-03，第二輪稽核第 1 條）：拿掉 mustFail 的 dead++ → 「金絲雀會叫」題紅；
//   退出碼映射把 1 改成 0 → 同題紅；套不上時不再 fail-closed（回 0）→ 「fail-closed」題紅。用的是可注入的寬鬆／壞掉設定檔。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCanary, runInSandbox, isBlocked, canApplySandbox, PROFILE, BOX_ROOT } from '../scripts/grok-sandbox-canary.js';

// ⚠️ 不是「darwin＋有 sandbox-exec」就能跑：巢狀沙箱環境（Codex 的審查樹）apply 會退 71——r2 版因此三關紅、
//    而反面題把 71 當「禁區擋住」假綠（Codex r3 #1）。一律用能力探測決定 skip，反面題一律走 isBlocked()。
const CAP = (() => { const d = mkdtempSync(join(BOX_ROOT, 'grok-sandbox-cap-')); try { return canApplySandbox(d); } finally { rmSync(d, { recursive: true, force: true }); } })();
const CAN_SANDBOX = CAP.ok;
const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const SKIP = `這台套不上沙箱：${CAP.why}（強制點在 scripts/grok-scan.js 的掃描前金絲雀，它會 fail-closed）`;

/** 建一個最小盒子（在 /private/tmp，不在家目錄底下——沙箱設定放行的是盒子路徑）。 */
function tmpBox() {
  const d = mkdtempSync(join(BOX_ROOT, 'grok-sandbox-test-'));
  writeFileSync(join(d, 'hello.txt'), 'HELLO-FROM-BOX\n');
  return d;
}

test('沙箱｜金絲雀：列出的禁區全部擋住、正面案例通過（退出碼 0）', async (t) => {
  if (!CAN_SANDBOX) { t.skip(SKIP); return; }
  const box = tmpBox();
  try {
    const { code, lines } = await runCanary(box);
    assert.equal(code, 0, '金絲雀結果：\n' + lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('擋住') && l.includes('假機密')), '至少要有「假機密被擋住」這一條');
    assert.ok(lines.some((l) => l.includes('通過') && l.includes('盒子')), '至少要有「盒子裡的檔讀得到」這一條');
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('沙箱｜家目錄底下的真實路徑（Desktop＝repo 與 store.db 住的地方、.ssh、.gitconfig、真 ~/.grok）在盒子裡讀不到（不靠金絲雀的假檔；Grok 掃描抓到舊題名寫「data/」但 argv 是 Desktop）', (t) => {
  if (!CAN_SANDBOX) { t.skip(SKIP); return; }
  const box = tmpBox();
  const home = homedir();
  try {
    for (const [label, argv] of /** @type {[string, string[]][]} */ ([
      ['~/Desktop（repo 與 store.db 住這底下）', ['/bin/ls', join(home, 'Desktop')]],
      ['~/.ssh', ['/bin/ls', join(home, '.ssh')]],
      ['~/.gitconfig', ['/bin/cat', join(home, '.gitconfig')]],
      ['真 ~/.grok（不在沙箱裡）', ['/bin/ls', join(home, '.grok')]],
    ])) {
      const r = runInSandbox(box, argv);
      // 一律走 isBlocked()：status 71（沙箱沒套上）與 null（被殺）都不算擋住
      assert.ok(isBlocked(r, '\u0000never'), `${label} 在沙箱裡沒有被擋住（status ${r.status}）`);
      assert.ok(!(r.stdout || '').trim(), `${label} 在沙箱裡有輸出：${(r.stdout || '').slice(0, 80)}`);
    }
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('沙箱｜盒子裡跑得了 node 與 git（中間路的承諾：它能在盒子裡跑考題）', (t) => {
  if (!CAN_SANDBOX) { t.skip(SKIP); return; }
  const box = tmpBox();
  try {
    const n = runInSandbox(box, [process.execPath, '-e', 'console.log("NODE-OK")']);
    assert.equal(n.status, 0, `node 在沙箱裡跑不起來：${(n.stderr || '').slice(0, 120)}`);
    assert.ok((n.stdout || '').includes('NODE-OK'));
    // git 本身要跑得起來
    const v = runInSandbox(box, ['/usr/bin/git', '--version']);
    assert.equal(v.status, 0, `git 在沙箱裡跑不起來：${(v.stderr || '').slice(0, 120)}`);
    // HOME 指進盒子：git 找的是盒子裡的 .gitconfig（不存在），**不是**真的 ~/.gitconfig。
    // `--global --list` 找不到檔會退 128 並指名它找的路徑——那個路徑必須在盒子裡，而且輸出不得含真設定。
    const g = runInSandbox(box, ['/usr/bin/git', 'config', '--global', '--list']);
    assert.ok((g.stderr || '').includes(box) || g.status === 0, `git 找的不是盒子裡的設定：${(g.stderr || '').slice(0, 160)}`);
    assert.ok(!(g.stdout || '').includes('user.email'), 'git 讀到了真的全域設定——HOME 沒有被指進盒子');
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('沙箱｜設定檔的承重規則還在（被刪掉時金絲雀會叫，這題讓「刪掉」本身先紅；平台無關，CI 也跑）', () => {
  const sb = readFileSync(PROFILE, 'utf8').replace(/;;[^\n]*/g, '');   // 剝註解——註解裡的字不算數
  // r2：deny-default＋system.sb 是骨架；沒有這兩行就退回 r1 那種列舉式的洞
  assert.match(sb, /\(deny default\)/, '少了 (deny default)——退回列舉式 deny，Codex r2 實證那不是封閉邊界');
  assert.match(sb, /\(import "system\.sb"\)/, '少了 (import "system.sb")——deny default 下程式起不來');
  // r3：真 ~/.grok **完全不進沙箱**——設定檔裡不可以再出現 GROK_INSTALL 這個參數
  assert.doesNotMatch(sb, /GROK_INSTALL/, '設定檔又把真 ~/.grok 放進沙箱——r2 放行整棵唯讀被抓到：歷史 sessions 仍可讀');
  // r3 收窄：/opt/homebrew/lib（全域 npm＝使用者程式碼）與 /Library/Developer 整棵不可放行
  assert.doesNotMatch(sb, /\(subpath "\/opt\/homebrew\/lib"\)/, '放行了 /opt/homebrew/lib——裡面是全域 npm 套件');
  assert.doesNotMatch(sb, /\(subpath "\/Library\/Developer"\)/, '放行了整棵 /Library/Developer——只需要 CommandLineTools');
  // 網路：只准轉送器 port；不可有 localhost:* 的 outbound（理財 app 的 4321 吐真實餘額）
  assert.match(sb, /\(allow network-outbound \(remote tcp \(string-append "localhost:" \(param "RELAY_PORT"\)\)\)\)/, '少了「只准連轉送器 port」');
  assert.doesNotMatch(sb, /\(allow network-outbound[^\n]*"localhost:\*"/, '放行了 localhost:* outbound——盒內程式連得到本機理財 app');
  assert.doesNotMatch(sb, /\(allow network-outbound\s+\(remote (tcp|ip) "\*/, '放行了任意對外網路');
  // Grok 第一次正式掃描抓到：放行 mDNSResponder 的 unix socket＝盒內能解析任意網域＝DNS 查詢名是外送通道
  assert.doesNotMatch(sb, /\(allow network-outbound[^\n]*unix-socket/, '放行了 unix-socket outbound（mDNSResponder＝DNS 外送通道）');
  assert.doesNotMatch(sb, /^\s*\(allow[^\n]*mDNSResponder/m, '放行了 mDNSResponder——盒內就能解析任意網域');
  // r6 #1：/usr/local 明確拒（讀＋執行）在檔尾（後面的規則蓋前面的）
  assert.match(sb, /\(deny file-read\* process-exec\* \(subpath "\/usr\/local"\)\)/, '少了 /usr/local 的明確 deny——放行整棵 /usr 會把 pkg 裝的第二顆 node 帶進來');
  // setpgid（82）**不可以**擋：grok 的工具靠它起子行程，擋了就 spawn EPERM、盒子裡一條指令都跑不了（煙霧測試實際踩到）
  assert.doesNotMatch(sb, /\(deny syscall-unix[^\n]*\(syscall-number 82\)/, '擋了 setpgid——grok 的 run_terminal_command 會整個起不來');
  // 反面：不可以有把圍欄拆掉的行
  assert.doesNotMatch(sb, /\(allow default\)/, '設定檔回到 allow default');
  assert.doesNotMatch(sb, /\(allow file-read\*[^\n]*\(subpath "\/"\)/, '設定檔放行了整個檔案系統');
  assert.doesNotMatch(sb, /\(allow file-read\*[^\n]*\(subpath "\/Users"\)/, '設定檔放行了 /Users');
});

test('轉送器｜目的地寫死、不從請求取——**行為題**：外來 Host／X-Upstream／absolute-form URL 都改不了 host/port（平台無關，CI 也跑）', async () => {
  const { upstreamOptions } = await import('../scripts/grok-relay.js');
  const attacks = [
    { url: '/v1/responses', headers: { host: 'elsewhere.example' } },
    { url: '/v1/responses', headers: { 'x-upstream': 'elsewhere.example', 'x-forwarded-host': 'elsewhere.example' } },
    { url: 'http://elsewhere.example/v1/responses?x=1', headers: {} },
    { url: 'https://elsewhere.example:8443/v1/responses', headers: { host: 'elsewhere.example:8443' } },
  ];
  for (const a of attacks) {
    const o = upstreamOptions({ method: 'POST', ...a });
    assert.equal(o.host, 'cli-chat-proxy.grok.com', `host 被請求改走了：${JSON.stringify(a)}`);
    assert.equal(o.port, 443, `port 被請求改走了：${JSON.stringify(a)}`);
    assert.equal(o.headers.host, 'cli-chat-proxy.grok.com', `Host header 沒被蓋掉：${JSON.stringify(a)}`);
    assert.ok(String(o.path).startsWith('/'), `absolute-form URL 沒被剝成 path：${o.path}`);
    assert.ok(!String(o.path).includes('elsewhere.example'), `path 還帶著別處的主機名：${o.path}`);
  }
  // 正常請求照過（純轉送模式：沒有 realBearer 就不動 Authorization）
  const ok = upstreamOptions({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer x' } });
  assert.equal(ok.path, '/v1/models');
  assert.equal(ok.headers.authorization, 'Bearer x', '正常 header 被剝掉了');
});

test('轉送器｜r6 #5 broker 權限收窄——**行為題**：錯 nonce／錯 method／錯 path／缺 Authorization 全部拒；只有「本掃假值精確相等＋白名單形狀」才換真 token（平台無關，CI 也跑）', async () => {
  const { rejectReason, upstreamOptions, DUMMY_BEARER_PREFIX, ALLOWED_REQUESTS } = await import('../scripts/grok-relay.js');
  const nonce = DUMMY_BEARER_PREFIX + 'a'.repeat(48);
  const good = { method: 'POST', url: '/v1/responses', headers: { authorization: `Bearer ${nonce}` } };
  assert.equal(rejectReason(good, nonce), null, '正常請求被拒');
  // Codex r6 的純函式反例：DELETE /v1/not-a-scan＋前綴假值——r5 會換真 token
  const bad = [
    { ...good, method: 'DELETE', url: '/v1/not-a-scan' },
    { ...good, method: 'DELETE', url: '/v1/not-a-scan', headers: { authorization: `Bearer ${DUMMY_BEARER_PREFIX}other-scan` } },
    { ...good, headers: { authorization: `Bearer ${DUMMY_BEARER_PREFIX}other-scan` } },            // 前綴對、值不對
    { ...good, headers: { authorization: `Bearer ${DUMMY_BEARER_PREFIX}${'b'.repeat(48)}` } },   // 上一掃的假值
    { ...good, headers: { authorization: 'Bearer SOME-OTHER-REAL-LOOKING-TOKEN' } },            // 自編 bearer：也不轉
    { ...good, headers: {} },                                                                     // 缺 Authorization
    { ...good, url: '/v1/responses/../admin' },
    { ...good, method: 'GET' },                                                                   // 對 path、錯 method
    { ...good, url: '/v1/sessions/not-a-uuid/signals' },
    { ...good, url: '/v1/bundle/archive', method: 'GET' },                                       // 刻意不放的遠端 bundle
    { ...good, url: 'http://elsewhere.example/v1/admin' },
  ];
  for (const b of bad) assert.ok(rejectReason(b, nonce), `該拒沒拒：${b.method} ${b.url} ${JSON.stringify(b.headers)}`);
  // 白名單每一形狀都過；query 不擋
  for (const a of ALLOWED_REQUESTS) {
    const path = a.path.source.replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace('[0-9a-f-]{36}', '0ed1fd13-5d15-4f01-9a1e-2d9cb2f1f111');
    assert.equal(rejectReason({ method: a.method, url: `${path}?x=1`, headers: { authorization: `Bearer ${nonce}` } }, nonce), null, `白名單形狀被拒：${a.method} ${path}`);
  }
  // 通過之後才換真 token；換的是整個值
  const o = upstreamOptions(good, 'REAL-TOKEN');
  assert.equal(o.headers.authorization, 'Bearer REAL-TOKEN');
});

test('轉送器｜r6 #5 broker 模式沒給 --dummy-file 就不啟動；給了就只認它——**行為題**：真的起一個、打三種請求看狀態碼（平台無關，CI 也跑）', async () => {
  const { startRelay, DUMMY_BEARER_PREFIX } = await import('../scripts/grok-relay.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'relay-broker-'));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ k: { key: 'REAL-TOKEN-0123456789abcdef' } }));
  assert.throws(() => startRelay(0, { authDir: dir }), /dummy-file/, 'broker 模式沒給假值檔竟然起來了——無從精確比對');
  writeFileSync(join(dir, 'dummy'), `${DUMMY_BEARER_PREFIX}short\n`);
  assert.throws(() => startRelay(0, { authDir: dir, dummyFile: join(dir, 'dummy') }), /形狀不對/, '太短的假值被接受了');
  const nonce = DUMMY_BEARER_PREFIX + 'c'.repeat(48);
  writeFileSync(join(dir, 'dummy'), `${nonce}\n`);
  const server = startRelay(0, { authDir: dir, dummyFile: join(dir, 'dummy') });
  try {
    await new Promise((ok) => server.once('listening', ok));
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    const status = async (/** @type {string} */ method, /** @type {string} */ path, /** @type {string | undefined} */ auth) =>
      (await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: auth ? { authorization: auth } : {} })).status;
    assert.equal(await status('GET', '/v1/models', `Bearer ${DUMMY_BEARER_PREFIX}other-scan`), 403, '錯 nonce 沒被拒');
    assert.equal(await status('DELETE', '/v1/not-a-scan', `Bearer ${nonce}`), 403, '錯形狀沒被拒');
    assert.equal(await status('GET', '/v1/models', undefined), 403, '缺 Authorization 沒被拒');
    // 對的那種會真的往上游連——這題不連外網，只驗「不是 403」（上游連不到＝502）
    assert.notEqual(await status('GET', '/v1/models', `Bearer ${nonce}`), 403, '對的請求被拒了');
  } finally { server.close(); }
});

test('轉送器｜只綁 127.0.0.1——**行為題**：真的起一個、看它 listen 的位址（平台無關，CI 也跑）', async () => {
  const { startRelay } = await import('../scripts/grok-relay.js');
  const server = startRelay(0);   // port 0＝隨機
  try {
    await new Promise((ok) => server.once('listening', ok));
    const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
    assert.equal(addr.address, '127.0.0.1', `轉送器 listen 在 ${addr.address}——外面的機器連得到`);
  } finally { server.close(); }
});

test('金絲雀自己｜isBlocked：status 為 null（被殺／ENOBUFS／逾時）不算擋住——第一版的假紅（平台無關，CI 也跑）', () => {
  // 真擋住：非 0 數字、沒洩漏
  assert.equal(isBlocked({ status: 1, stdout: '' }, 'SECRET'), true);
  assert.equal(isBlocked({ status: 126, stdout: 'Operation not permitted' }, 'SECRET'), true);
  // 沒擋住：成功了
  assert.equal(isBlocked({ status: 0, stdout: '' }, 'SECRET'), false);
  // 沒擋住：退出碼非 0 但暗號洩漏了（例如 cat 讀到了又因別的原因失敗）
  assert.equal(isBlocked({ status: 1, stdout: 'CANARY-SECRET-x' }, 'CANARY-SECRET-x'), false);
  // ⭐ 金絲雀自己壞了：status null 一律不算擋住（突變⑤實測：改回 `r.status !== 0` 這裡會假綠）
  assert.equal(isBlocked({ status: null, stdout: '' }, 'SECRET'), false, 'status null 被當成擋住＝金絲雀被殺時會假報「沙箱有效」');
  assert.equal(isBlocked({ status: null, stdout: null }, 'SECRET'), false);
});

// ============================================================================
// 紅燈自己也要有考題（2026-09-02 第二輪稽核第 1 條）：金絲雀的計分器與退出碼映射原本零考題——
// 沙箱靜靜失效時它仍回 0、仍印「可以掃」，Grok 就在沒有圍欄的情況下發射。
// 做法＝把沙箱設定檔做成可注入，拿一份**故意寬鬆**的設定跑同一支金絲雀：它必須叫（退 1）；
// 拿一份**套不上**的設定：它必須 fail-closed（退 2），不是「擋住」也不是 0。
// ============================================================================

test('沙箱｜金絲雀會叫：換成「全部放行」的設定檔 ⇒ 退出碼 1、至少一隻「活著」（計分器不是散文）', async (t) => {
  if (!CAN_SANDBOX) { t.skip(SKIP); return; }
  const box = tmpBox();
  const loose = join(box, 'loose.sb');
  writeFileSync(loose, '(version 1)\n(allow default)\n');
  try {
    const { code, lines, dead } = await runCanary(box, { profile: loose });
    assert.equal(code, 1, '寬鬆設定下金絲雀竟然沒叫：\n' + lines.join('\n'));
    const alive = lines.filter((l) => l.includes('🟢 活著')).length;
    assert.ok(alive >= 1, '要有至少一隻被標成「活著」：\n' + lines.join('\n'));
    // ⚠️ 只看總 code 不夠（Codex #551 r2 High）：gh／node 兩支直接探針各自會 dead++，拿掉**通用**計分器
    //    （mustFail 的 dead++）總分仍是 1。所以釘「每一隻活著都有計分」：dead 必須等於活著的隻數
    //    （對照組不活的 +1000 這條路在寬鬆設定下走不到——它們在沙箱外本來就活）。
    assert.ok(!lines.some((l) => l.startsWith('⛔')), '寬鬆設定下不該有對照組不活：\n' + lines.join('\n'));
    assert.equal(dead, alive, `活著 ${alive} 隻但只計了 ${dead} 分——有探針的活著沒被計分`);
    // 對照：同一個盒子換回正式設定檔要是 0——證明差別只在設定檔（不是盒子壞了）
    const ctl = await runCanary(box);
    assert.equal(ctl.code, 0, '同一個盒子用正式設定檔應全擋住：\n' + ctl.lines.join('\n'));
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('沙箱｜金絲雀 fail-closed：設定檔套不上（語法壞掉）⇒ 退出碼 2、第一行是 ⛔（不是 0、也不算「擋住」）', async (t) => {
  if (!CAN_SANDBOX) { t.skip(SKIP); return; }
  const box = tmpBox();
  const bad = join(box, 'bad.sb');
  writeFileSync(bad, '(version 1)\n(this is not a sandbox profile\n');
  try {
    const { code, lines } = await runCanary(box, { profile: bad });
    assert.equal(code, 2, '套不上的設定檔必須退 2（fail-closed）：\n' + lines.join('\n'));
    assert.ok(lines[0]?.startsWith('⛔'), '第一行要說明為什麼不掃：' + lines[0]);
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('沙箱｜接線：正式掃描（scripts/grok-scan.js）不傳 profile、真 grok 發射用寫死的 PROFILE（可注入設定檔只給考題）', () => {
  // Grok #551 掃到：「正式掃描不傳」原本只是註解。這題用原始碼比對釘住——日後有人改成 profile: process.env.… 就紅。
  const src = readFileSync(join(SCRIPTS_DIR, 'grok-scan.js'), 'utf8');
  // 正式碼寫成 `(deps.runCanary ?? runCanary)(box, { relayPort })`（可注入假金絲雀），所以要吃 `runCanary)(box, …` 這個形狀
  const calls = src.match(/runCanary\)?\(\s*box[^)]*\)/g) || [];
  assert.ok(calls.length >= 1, 'grok-scan.js 要真的呼叫 runCanary');
  for (const c of calls) assert.ok(!/profile/.test(c), `正式掃描的 runCanary 不可傳 profile：${c}`);
  // 只看**傳給沙箱函式的選項**（不是整檔禁字——grok-scan.js 別處本來就有 profile 這個詞）
  for (const c of src.match(/(runInSandbox|canApplySandbox)\)?\([^)]*\)/g) || []) assert.ok(!/\bprofile\b/.test(c), `正式掃描不可對沙箱函式傳 profile：${c}`);
  assert.match(src, /'-f',\s*PROFILE\b/, '真 grok 發射必須用寫死的 PROFILE');
});
