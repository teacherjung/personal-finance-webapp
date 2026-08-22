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
  // 寫入 deny-default
  assert.match(sb, /\(deny file-write\*\)/, '少了「寫入全域 deny」——第一版就是漏了這條，Grok 能寫 store.db');
  // 讀取的列舉 deny：每一個位置各自要在（一行含多個 subpath，所以逐一查 subpath、不查整行）
  for (const where of ['(param "HOME")', '"/private/tmp"', '"/private/var/folders"', '"/Library/Keychains"', '"/Users/Shared"', '"/Volumes"']) {
    assert.ok(new RegExp(`\\(deny file-read\\*[^)]*\\(subpath ${where.replace(/[()"/]/g, '\\$&')}\\)`).test(sb) || sb.includes(`(subpath ${where})`) && /\(deny file-read\*/.test(sb),
      `讀取 deny 少了 ${where}（#495 那次 Grok 正是 cd 進 /private/tmp 的審查樹）`);
  }
  // 網路 deny-default＋只准 localhost
  assert.match(sb, /\(deny network\*\)/, '少了「網路全拒」');
  assert.match(sb, /\(allow network-outbound \(remote tcp "localhost:\*"\)\)/, '少了 localhost 放行（轉送器會連不上）');
  // IPC：至少剪貼簿那條（它是突變驗證過唯一單獨有效的）
  assert.match(sb, /com\.apple\.pasteboard\.1/, '少了剪貼簿 deny（突變實測：拿掉它剪貼簿金絲雀就活）');
  // 反面：不可以有把圍欄拆掉的行
  assert.doesNotMatch(sb, /\(allow file-read\*[^\n]*\(subpath \(param "HOME"\)\)/, '設定檔放行了整個家目錄');
  assert.doesNotMatch(sb, /\(allow file-write\*[^\n]*\(subpath \(param "HOME"\)\)/, '設定檔放行了寫整個家目錄');
  assert.doesNotMatch(sb, /\(allow network-outbound\s+\(remote (tcp|ip) "\*/, '設定檔放行了任意對外網路');
});

test('沙箱｜轉送器的目的地寫死、不從請求取（唯一的安全性質，要釘住）', () => {
  const js = readFileSync(join(process.cwd(), 'scripts', 'grok-relay.js'), 'utf8');
  assert.ok(js.includes("const UPSTREAM_HOST = 'cli-chat-proxy.grok.com'"), '轉送器的 UPSTREAM_HOST 不是寫死的常數');
  assert.ok(js.includes("server.listen(port, '127.0.0.1'"), '轉送器沒有綁在 127.0.0.1——外面的機器連得到');
  assert.ok(!/req\.headers\[['"]host['"]\]\s*\|\|/.test(js) && !/UPSTREAM_HOST\s*=\s*req/.test(js), '轉送器從請求取目的地——那就不是單向的了');
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
