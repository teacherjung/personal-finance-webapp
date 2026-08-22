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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runCanary, runInSandbox, isBlocked, PROFILE } from '../scripts/grok-sandbox-canary.js';

const CAN_SANDBOX = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const SKIP = 'sandbox-exec 只在 macOS 有；這台跑不了沙箱（強制點在 scripts/grok-scan.js 的掃描前金絲雀）';

/** 建一個最小盒子（在 /private/tmp，不在家目錄底下——沙箱設定放行的是盒子路徑）。 */
function tmpBox() {
  const d = mkdtempSync('/private/tmp/grok-sandbox-test-');
  writeFileSync(join(d, 'hello.txt'), 'HELLO-FROM-BOX\n');
  return d;
}

test('沙箱｜金絲雀：列出的禁區全部擋住、正面案例通過（退出碼 0）', (t) => {
  if (!CAN_SANDBOX) { t.skip(SKIP); return; }
  const box = tmpBox();
  try {
    const { code, lines } = runCanary(box);
    assert.equal(code, 0, '金絲雀結果：\n' + lines.join('\n'));
    assert.ok(lines.some((l) => l.includes('擋住') && l.includes('假機密')), '至少要有「假機密被擋住」這一條');
    assert.ok(lines.some((l) => l.includes('通過') && l.includes('盒子')), '至少要有「盒子裡的檔讀得到」這一條');
  } finally { rmSync(box, { recursive: true, force: true }); }
});

test('沙箱｜真正的 repo 禁區：data/ 目錄、.ssh、.gitconfig 在盒子裡讀不到（不靠金絲雀的假檔）', (t) => {
  if (!CAN_SANDBOX) { t.skip(SKIP); return; }
  const box = tmpBox();
  const home = homedir();
  try {
    for (const [label, argv] of /** @type {[string, string[]][]} */ ([
      ['repo 的 data/ 目錄', ['/bin/ls', join(home, 'Desktop')]],   // store.db 住在 Desktop 底下的 repo；Desktop 本身就該擋
      ['~/.ssh', ['/bin/ls', join(home, '.ssh')]],
      ['~/.gitconfig', ['/bin/cat', join(home, '.gitconfig')]],
    ])) {
      const r = runInSandbox(box, argv);
      assert.ok(typeof r.status === 'number' && r.status !== 0, `${label} 在沙箱裡居然讀得到（status ${r.status}）`);
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
  // 安裝樹唯讀：只能有 file-read* 指向 GROK_INSTALL，不能有 file-write*
  assert.match(sb, /\(allow file-read\* \(subpath \(param "GROK_INSTALL"\)\)\)/, '少了 grok 安裝樹的唯讀放行');
  assert.doesNotMatch(sb, /file-write\*[^\n]*GROK_INSTALL/, '安裝樹被放行寫入——r2 #2 升級鏈：沙箱裡改 bin/grok、下次在沙箱外執行');
  // 網路：只准轉送器 port；不可有 localhost:* 的 outbound（理財 app 的 4321 吐真實餘額）
  assert.match(sb, /\(allow network-outbound \(remote tcp \(string-append "localhost:" \(param "RELAY_PORT"\)\)\)\)/, '少了「只准連轉送器 port」');
  assert.doesNotMatch(sb, /\(allow network-outbound[^\n]*"localhost:\*"/, '放行了 localhost:* outbound——盒內程式連得到本機理財 app');
  assert.doesNotMatch(sb, /\(allow network-outbound\s+\(remote (tcp|ip) "\*/, '放行了任意對外網路');
  // 反面：不可以有把圍欄拆掉的行
  assert.doesNotMatch(sb, /\(allow default\)/, '設定檔回到 allow default');
  assert.doesNotMatch(sb, /\(allow file-read\*[^\n]*\(subpath "\/"\)/, '設定檔放行了整個檔案系統');
  assert.doesNotMatch(sb, /\(allow file-read\*[^\n]*\(subpath "\/Users"\)/, '設定檔放行了 /Users');
});

test('轉送器｜目的地寫死、不從請求取——**行為題**：惡意 Host／X-Upstream／absolute-form URL 都改不了 host/port（平台無關，CI 也跑）', async () => {
  const { upstreamOptions } = await import('../scripts/grok-relay.js');
  const attacks = [
    { url: '/v1/responses', headers: { host: 'evil.example' } },
    { url: '/v1/responses', headers: { 'x-upstream': 'evil.example', 'x-forwarded-host': 'evil.example' } },
    { url: 'http://evil.example/v1/responses?x=1', headers: {} },
    { url: 'https://evil.example:8443/v1/responses', headers: { host: 'evil.example:8443' } },
  ];
  for (const a of attacks) {
    const o = upstreamOptions({ method: 'POST', ...a });
    assert.equal(o.host, 'cli-chat-proxy.grok.com', `host 被請求改走了：${JSON.stringify(a)}`);
    assert.equal(o.port, 443, `port 被請求改走了：${JSON.stringify(a)}`);
    assert.equal(o.headers.host, 'cli-chat-proxy.grok.com', `Host header 沒被蓋掉：${JSON.stringify(a)}`);
    assert.ok(String(o.path).startsWith('/'), `absolute-form URL 沒被剝成 path：${o.path}`);
    assert.ok(!String(o.path).includes('evil.example'), `path 還帶著攻擊者的主機名：${o.path}`);
  }
  // 正常請求照過
  const ok = upstreamOptions({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer x' } });
  assert.equal(ok.path, '/v1/models');
  assert.equal(ok.headers.authorization, 'Bearer x', '正常 header 被剝掉了（登入憑證要原樣過）');
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
