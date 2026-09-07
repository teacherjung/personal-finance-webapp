// @ts-check
// `grok-scan.js` 主流程行為考題（同族五支之一）：跑得動嗎：版本、指紋、轉送器、正常路徑，與每一條失敗出口。
//
// ⚠️ 這一族**共用夾具**在 `test/helpers/grok-scan-flow-fixtures.js`（射程、劃界與「為什麼拆」都寫在那裡）。
// 同族的其他幾支：`grok-scan-flow-credentials.test.js`、`grok-scan-flow-breach.test.js`、`grok-scan-flow-incident.test.js`、`grok-scan-flow-redaction.test.js`。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DUMMY_BEARER_PREFIX, PINNED_CLIENT_ID, PINNED_ISSUER } from '../scripts/grok-auth-refresh.js';
import { EXPECTED_GROK_VERSION, runScan } from '../scripts/grok-scan.js';
import { assertChildGitEnvCleanAsync, injectDirtyGitEnv } from './helpers/dirty-git-env.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PEM_BEGIN, SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeAuth, fakeGrok, fakeRelay, isolated, noFetch, promptFile, quiet, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);

test('runScan｜base／head 不是寫死 SHA → 2（條款：不可用會移動的名稱）', async () => {
  const r = await runScan({ base: 'origin/main', head: 'HEAD', promptFile: promptFile() }, { ...quiet, ...isolated(), ...withGrok(fakeGrok()) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /寫死的 SHA/);
});

test('runScan｜grok 版本不符 → 2（條款：版本不同＝當未跑；轉送器目的地是從該版本 strings 出來的）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }   // r4：--version 改在沙箱內跑
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ version: 'grok 9.9.9' })) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /版本不符/);
});

test('釘值｜EXPECTED_GROK_VERSION／EXPECTED_GROK_SHA256 是獨立寫死的 fixture（改常數要連這裡一起改；倒回舊版就紅）', async () => {
  // 為什麼不從常數推：fake grok 的 --version 印的就是常數，那樣的題只證明「相對當下常數精確比對」，證明不了釘的是哪一版。
  const { EXPECTED_GROK_SHA256 } = await import('../scripts/grok-scan.js');
  assert.equal(EXPECTED_GROK_VERSION, '1.0.13', 'grok CLI 1.0.13（2026-09-05 重驗轉送器目的地後升的）');
  assert.equal(EXPECTED_GROK_SHA256, '8669e0fdadceec25b8c159c355f427ffbd82583525d774b6ab1522197ea83b80', 'grok-1.0.13-macos-aarch64 的 sha256');
});

test('runScan｜版本要**精確等於**，前綴不算（r2：wrapper 印 "grok 1.0.3-other" 就能過 startsWith）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }   // r4：--version 改在沙箱內跑
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ version: EXPECTED_GROK_VERSION + '-evil' })) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /版本不符/);
});

test('runScan｜執行檔 sha256 不符 → 2，而且**不執行它**（r4 #5：版本字串是被檢者自己印的，wrapper 印對字串就過）', async () => {
  const repo = tinyRepo();
  const inst = fakeGrok();
  // 給一個錯的 hash；假 grok 若被執行會在安裝樹留下記號——斷言它沒被執行
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace('#!/bin/sh', '#!/bin/sh\ntouch "$(dirname "$0")/../EXECUTED"'));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, grokInstall: inst, expectedSha256: '0'.repeat(64) });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /sha256 不符/);
  assert.ok(!existsSync(join(inst, 'EXECUTED')), 'hash 不符的執行檔還是被執行了');
});

test('runScan｜grok --version 本身失敗 → 2（不是靜靜當作版本對）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }   // r4：--version 改在沙箱內跑
  const repo = tinyRepo();
  const d = mkdtempSync(join(tmpdir(), 'fake-grok-bad-')); mkdirSync(join(d, 'bin')); mkdirSync(join(d, 'sessions')); writeFileSync(join(d, 'auth.json'), fakeAuth());
  writeFileSync(join(d, 'bin', 'grok'), '#!/bin/sh\nexit 3\n'); chmodSync(join(d, 'bin', 'grok'), 0o755);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(d) });
  assert.equal(r.code, 2);
});

test('runScan｜node_modules 是 symlink（工作樹形狀）→ clone 後盒子裡必須是真目錄，不是 symlink', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // 把 tinyRepo 的 node_modules 換成 symlink 指向別處（模擬 AGENTS 規定的工作樹形狀）
  const repo = tinyRepo();
  const real = mkdtempSync(join(tmpdir(), 'real-nm-'));
  mkdirSync(join(real, 'eslint')); writeFileSync(join(real, 'eslint', 'package.json'), '{}');
  rmSync(join(repo.dir, 'node_modules'), { recursive: true });
  execFileSync('ln', ['-s', real, join(repo.dir, 'node_modules')]);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  // 會在轉送器那步退 2（假轉送器故意死）——但**不是**在 node_modules 那步退
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.summary.join('\n'), /node_modules/, 'symlink 的 node_modules 沒被正確 clone 成真目錄（cp -Rc 對 symlink operand 不跟隨＝Codex r1 實測）');
  assert.match(r.summary.join('\n'), /轉送器/);
});

test('runScan｜轉送器沒 READY 就死 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /轉送器沒有 READY/);
});

test('runScan｜轉送器 READY 之後、grok 結束前死掉 → 2（r2：r1 寫成 relayDead && grok≠0，假 grok 回 0 就放過）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  // 假 grok 睡 1 秒再回 0；假轉送器 READY 後 200ms 死——grok 結束時轉送器已死，必須退 2
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, "sleep 1; $1"));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('die-after-ready') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /轉送器在掃描結束前死了/);
});

test('runScan｜正常路徑：→ 0；盒子（含憑證副本）掃完清掉、結果包只留 launch.json＋sessions、真安裝樹沒被寫', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const inst = fakeGrok();
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 0, r.summary.join('\n'));
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  // r3：盒子（含憑證副本）掃完必須**不在**；結果包（去機密）必須在
  assert.ok(!existsSync(box), `盒子掃完還留在 /private/tmp（裡面有 auth.json 副本）：${box}`);
  const resultsLine = r.summary.find((l) => l.includes('結果包=')) || '';
  const resultsDir = /結果包=([^（]+)/.exec(resultsLine)?.[1];
  assert.ok(resultsDir && existsSync(join(resultsDir, 'launch.json')), '結果包裡沒有 launch.json');
  assert.ok(resultsDir && existsSync(join(resultsDir, 'sessions')), '結果包裡沒有 sessions/');
  assert.ok(resultsDir && !existsSync(join(resultsDir, 'auth.json')), '結果包裡有 auth.json——憑證不該留在結果包');
  assert.ok(!existsSync(join(inst, 'sessions', 'fake-session')) && readdirSync(join(inst, 'sessions')).length === 0, '真安裝樹的 sessions/ 被寫了——GROK_HOME 沒有指進盒子');
});

test('runScan｜審查能力 smoke：零工具足跡 → 2 且不保存（chat-only 回覆不能冒充複審）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(fakeGrok({ noToolFootprint: true })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /沒有任何工具足跡/);
  assert.deepEqual(readdirSync(iso.resultsRoot), [], '零工具足跡還保存了結果包');
});

test('runScan｜grok 退出碼非 0 → 2（第一版只印出來、照樣退 0）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ status: 1 })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /grok 沒有正常結束/);
});

test('runScan｜grok 退 0 但回覆是空的 → 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ reply: '' })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /回覆是空的/);
});

test('runScan｜grok 正常、但零 session 日誌 → 2（第一版 dirs=[] 直接走到 exit 0——Codex r1 實測）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok({ noSession: true })), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /找不到這次的 session 日誌/);
});

test('runScan｜鐵則 11：髒的 GIT_* 環境下 git archive／diff 仍對（答案題）＋子行程實收環境乾淨（探針題）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const restore = injectDirtyGitEnv();
  try {
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, '髒 GIT_* 環境讓 runScan 壞掉：' + r.summary.join('\n'));
  } finally { restore(); }
  await assertChildGitEnvCleanAsync(assert, 'grok-scan 的 git archive／diff', async () => {
    await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') });
  });
});

test('runScan｜發射紀錄 launch.json 留在結果包（事後能分辨「旗標失效」與「沒帶旗標」；盒子本身已清）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  /** @type {string[]} */ const logs = [];
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  const resultsDir = /結果包=([^（]+)/.exec(r.summary.find((l) => l.includes('結果包=')) || '')?.[1];
  assert.ok(resultsDir, '沒印結果包路徑');
  const launch = JSON.parse(readFileSync(join(resultsDir, 'launch.json'), 'utf8'));
  assert.ok(launch.sbArgv.includes('-f'), '發射紀錄沒有沙箱參數');
  assert.ok(launch.grokArgv.includes('--always-approve'), '少了 --always-approve：盒內跑指令會停在權限確認、-p 模式整輪取消、退 0 只印旁白（第四次正式掃描實際發生）');
  assert.ok(launch.grokArgv.includes('--disable-web-search') && launch.grokArgv.includes('--no-subagents'), '發射紀錄沒有 grok 旗標');
  assert.equal(launch.env.HOME, box, '發射紀錄的 env.HOME 不是盒子');
  assert.equal(launch.env.GROK_HOME, join(box, 'grok-home'), '發射紀錄的 env.GROK_HOME 不是盒內副本');
  assert.match(launch.profileSha256, /^[0-9a-f]{64}$/);
  assert.ok(!('GITHUB_TOKEN' in launch.env) && !('ANTHROPIC_API_KEY' in launch.env), 'env 白名單漏了 token 類變數');
});

test('runScan｜每一條失敗出口都清盒子：轉送器沒 READY／grok 非 0／零 session 三條，盒子掃完都不在', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const cases = [
    ['轉送器沒 READY', { ...withGrok(fakeGrok()), relayScript: fakeRelay('die-before-ready') }],
    ['grok 非 0', { ...withGrok(fakeGrok({ status: 1 })), relayScript: fakeRelay('ok') }],
    ['零 session', { ...withGrok(fakeGrok({ noSession: true })), relayScript: fakeRelay('ok') }],
  ];
  for (const [name, extra] of /** @type {[string, object][]} */ (cases)) {
    const repo = tinyRepo();
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, ...extra });
    assert.equal(r.code, 2, `${name}：該退 2`);
    const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
    assert.ok(box, `${name}：沒印盒子路徑`);
    assert.ok(!existsSync(box), `${name}：失敗後盒子（含 auth.json 副本）還留在 ${box}`);
  }
});

test('runScan｜驗屍查到破口線索（日誌裡出現私鑰標頭這種盒子外才有的形狀）→ 1＝事故，不是 2', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  // 假 grok 把一段「BEGIN RSA PRIVATE KEY」寫進 session 日誌——模擬「它讀到了盒子外的東西並回錄」。
  // 不用活金絲雀的暗號：那要在正式程式留測試鉤子把暗號塞進盒子，鉤子本身就是洞。驗屍認得的另一種形狀同樣走 code 1。
  const inst = fakeGrok();
  const before = readFileSync(join(inst, 'bin', 'grok'), 'utf8');
  const after = before.replace(/^(printf '%s' .*# REPLY-LINE)$/m,
    `printf '%s\\n' '{"type":"assistant","content":"${PEM_BEGIN('RSA')}\\\\nMIIEOUTSIDEKEYBODYCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC\\\\n-----END RSA PRIVATE KEY-----"}' >> "$ws/fake-session/updates.jsonl"; $1`);   // r10：要含內容，光標頭不是鑰匙
  assert.notEqual(after, before, '假 grok 改寫沒套上');
  writeFileSync(join(inst, 'bin', 'grok'), after);
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...isolated(), repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /沙箱破了/);
});

test('runScan｜--out 指到寫不進去的地方 → 退 2 且盒子仍清掉（r4 #4：r3 版在那裡 throw、盒子留著）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  /** @type {string[]} */ const logs = [];
  let threw = false;
  let r;
  try {
    r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: '/no/such/dir/reply.txt' }, { log: (m) => logs.push(m), ...isolated(), repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  } catch { threw = true; }
  const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
  assert.ok(box, '沒印盒子路徑');
  assert.ok(!existsSync(box), `--out 寫失敗後盒子（含 auth.json 副本）還留在 ${box}`);
  // 允許 throw 或退 2——重點是盒子不在；但不可以退 0
  if (!threw) assert.notEqual(r?.code, 0, '--out 寫失敗還退 0');
});

test('runScan｜去機密（r5 broker 之後）：①grok 把盒內 auth.json 整個印進回覆＝只有 DUMMY、真 token 不在盒子、不算事故；②真 token 字面出現在回覆＝1、--out 不寫、sessions 不留', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const REAL = 'REAL-TOKEN-NEVER-IN-BOX-0123456789abcdef';
  // ① 盒內 auth.json 印進回覆：broker 讓盒內只有 DUMMY——回覆裡有 DUMMY、沒有真 token、code 0
  {
    const repo = tinyRepo(); const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'cat "$GROK_HOME/auth.json"; $1'));
    const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, r.summary.join('\n'));
    const reply = readFileSync(out, 'utf8');
    assert.ok(reply.includes(DUMMY_BEARER_PREFIX), '盒內 auth.json 的 key 不是 DUMMY——broker 沒生效');
    assert.ok(!reply.includes(REAL), '真 token 進了盒子');
  }
  // ② 真 token 字面出現在回覆（模擬任何別的洩漏路徑）→ DLP 抓到＝1
  {
    const repo = tinyRepo(); const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ key: REAL }));
    const inst = fakeGrok({ reply: `leaked: ${REAL}` });
    const out = join(mkdtempSync(join(tmpdir(), 'out-')), 'reply.txt');
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(), outFile: out }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 1, r.summary.join('\n'));
    assert.match(r.summary.join('\n'), /去機密/);
    assert.ok(!existsSync(out), '憑證洩漏時 --out 還是寫了');
    assert.ok(!readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).includes('sessions/')), '憑證洩漏時 sessions 還是進了結果包');
  }
});

test('runScan｜憑證：盒內 auth.json **沒有 refresh_token**；還新＝不 refresh；到期＝父程序 refresh 並原子寫回；refresh 失敗＝不掃、舊檔原樣（r4 #3 由構造消失）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  // ① 還新：不呼叫 fetch；盒內 auth.json 沒有 refresh_token（假 grok 把它 cat 進回覆來驗）
  {
    const repo = tinyRepo(); const iso = isolated();
    const inst = fakeGrok();
    writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, 'grep -c refresh_token "$GROK_HOME/auth.json" > "$GROK_HOME/has-refresh"; $1'));
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, r.summary.join('\n'));
    // 盒子已清；從假 grok 留在 sessions 的檔看不到 has-refresh——改用 launch.json 以外的證據：盒內 auth 是 forBox（去掉 refresh_token）
    // 直接驗 refreshSandboxAuth 的回傳形狀
    const { refreshSandboxAuth } = await import('../scripts/grok-auth-refresh.js');
    const a = await refreshSandboxAuth(iso.authDir, { fetchImpl: noFetch });
    assert.equal(a.refreshed, false);
    assert.ok(!JSON.stringify(a.forBox).includes('refresh_token'), '給盒子的版本還含 refresh_token');
    // r5 broker：盒內的 key 是假的（DUMMY 前綴），真 access token 不進盒子
    assert.ok(!JSON.stringify(a.forBox).includes('ACCESS-TOKEN-VALUE'), '真 access token 進了盒子——broker 沒生效');
    assert.ok(JSON.stringify(a.forBox).includes(DUMMY_BEARER_PREFIX), '盒內 key 不是 DUMMY');
  }
  // ② 到期：父程序 refresh（假 fetch 回新 token＋新 refresh_token），authDir 原子寫回；盒內拿到新 access token
  {
    const repo = tinyRepo(); const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ expiresInMs: -1000 }));
    let calls = 0;
    const okFetch = /** @type {typeof fetch} */ (async (u, init) => { calls++; assert.equal(String(u), `${PINNED_ISSUER}/oauth2/token`, 'refresh 沒送到釘住的 issuer'); const b = String(init?.body); assert.match(b, /grant_type=refresh_token/); assert.match(b, /REFRESH-TOKEN-VALUE/); assert.ok(b.includes(`client_id=${PINNED_CLIENT_ID}`), 'client_id 不是釘住的'); return new Response(JSON.stringify({ access_token: 'NEW-ACCESS-0123456789abcdef', refresh_token: 'NEW-REFRESH-0123456789abcdef', expires_in: 21600 }), { status: 200 }); });
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, fetchImpl: okFetch, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 0, r.summary.join('\n'));
    assert.equal(calls, 1, 'refresh 該恰好呼叫一次');
    const saved = readFileSync(join(iso.authDir, 'auth.json'), 'utf8');
    assert.match(saved, /NEW-ACCESS/); assert.match(saved, /NEW-REFRESH/);
    assert.doesNotMatch(saved, /REFRESH-TOKEN-VALUE-0123/, '舊的 refresh_token 沒被輪替掉');
  }
  // ③ 到期但 refresh 失敗（HTTP 401）：不掃（2）、authDir 原樣、盒子清掉
  {
    const repo = tinyRepo(); const iso = isolated();
    mkdirSync(iso.authDir, { recursive: true }); const before = fakeAuth({ expiresInMs: -1000 }); writeFileSync(join(iso.authDir, 'auth.json'), before);
    const badFetch = /** @type {typeof fetch} */ (async () => new Response('nope', { status: 401 }));
    /** @type {string[]} */ const logs = [];
    const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { log: (m) => logs.push(m), ...iso, fetchImpl: badFetch, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
    assert.equal(r.code, 2);
    assert.match(r.summary.join('\n'), /refresh 失敗/);
    assert.equal(readFileSync(join(iso.authDir, 'auth.json'), 'utf8'), before, 'refresh 失敗卻動了 authDir');
    const box = (logs.find((l) => l.startsWith('盒子：')) || '').slice('盒子：'.length);
    assert.ok(box && !existsSync(box), 'refresh 失敗後盒子沒清');
  }
});

test('runScan｜confused deputy：盒內 sessions 裡的 symlink 不被父程序跟隨（r4 #1）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo();
  const iso = isolated();
  // 盒外放一個機密檔；假 grok 在 sessions 裡放一個指向它的 symlink
  const outside = mkdtempSync(join(tmpdir(), 'outside-')); writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET-CONTENT');
  const inst = fakeGrok();
  writeFileSync(join(inst, 'bin', 'grok'), readFileSync(join(inst, 'bin', 'grok'), 'utf8').replace(/^(printf '%s' .*# REPLY-LINE)$/m, `ln -s "${join(outside, 'secret.txt')}" "$ws/fake-session/leak.jsonl"; $1`));
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, repo: repo.dir, ...withGrok(inst), relayScript: fakeRelay('ok') });
  // 日誌區出現 symlink＝Grok 在放捷徑＝事故（1），而且 sessions 不得進結果包
  assert.equal(r.code, 1, r.summary.join('\n'));
  assert.match(r.summary.join('\n'), /非 regular file/);
  const leaked = readdirSync(iso.resultsRoot, { recursive: true }).some((f) => String(f).endsWith('leak.jsonl') || String(f).includes('OUTSIDE-SECRET'));
  assert.ok(!leaked, '父程序跟隨了盒內 symlink、把盒外內容抄進結果包');
  // 盒外那個機密檔的內容也不可以出現在結果包的任何檔裡（含新增的 incident.json）
  for (const f of readdirSync(iso.resultsRoot, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) assert.ok(!readFileSync(join(f.parentPath ?? f.path, f.name), 'utf8').includes('OUTSIDE-SECRET'), `結果包 ${f.name} 裡有盒外內容`);
  }
  // ⚠️ 這條事故路徑（odd）也要留指紋：它跟破口那條一樣，原本什麼都不留就回傳了
  const oddDirs = readdirSync(iso.resultsRoot);
  assert.equal(oddDirs.length, 1, 'odd 事故沒留結果目錄');
  const oddInc = join(iso.resultsRoot, oddDirs[0], 'incident.json');
  assert.ok(existsSync(oddInc), 'odd 事故沒留 incident.json');
  assert.equal(JSON.parse(readFileSync(oddInc, 'utf8')).hits[0].family, 'odd');
});

test('runScan｜r5 #2：auth.json 的 issuer 被改成別的網址 → 不 refresh、不掃（refresh_token 絕不送去非釘住的地方）', async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(); const iso = isolated();
  mkdirSync(iso.authDir, { recursive: true }); writeFileSync(join(iso.authDir, 'auth.json'), fakeAuth({ issuer: 'https://elsewhere.example', expiresInMs: -1000 }));
  let called = false;
  const spyFetch = /** @type {typeof fetch} */ (async () => { called = true; return new Response('{}', { status: 200 }); });
  const r = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile() }, { ...quiet, ...iso, fetchImpl: spyFetch, repo: repo.dir, ...withGrok(fakeGrok()), relayScript: fakeRelay('ok') });
  assert.equal(r.code, 2);
  assert.match(r.summary.join('\n'), /不等於釘住的/);
  assert.equal(called, false, 'refresh_token 被送去別處的 issuer 了');
});
