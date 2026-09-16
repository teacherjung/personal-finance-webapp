#!/usr/bin/env node
// 禁區攔截器的固定複本（規矩 B1；裁示 6a＋7b）：從專案**已合併進主幹**的一個版本抽出攔截器跑起來會讀到的那幾個檔，
// 寫進一個版本控制以外的目錄，算出指紋，印出一組貼進 Codex 全域鉤子檔的接線（複本路徑與指紋都寫死在指令裡）。
//
// 為什麼：Codex 的全域鉤子套到每一個 session，不能靠「當下在哪個專案」找攔截器，所以讀一份固定複本（裁示 6a）。
// 但 Codex 的「信任」只記鉤子那一行指令的雜湊，指令引用的檔案不在信任範圍內——複本被改＝不必重按信任就生效，
// 而且沒有人看得到。所以指令裡寫死指紋：複本的指紋對不上就退 2（所有 mcp__ 工具都擋、看得見的失敗），
// 要改清單＝重抽複本＋換一行新指令＋裁示者重按信任，負擔跟今天一樣（裁示 7b）。
//
// 分工：指令的**文字**只有一份＝templates/hook-codex-global.json（**從同一個版本讀**，這支只把三個佔位換掉）；
// 判斷只有一份＝tools/forbidden-tools.js。這支**不碰**家目錄的 .codex 或 .claude（不讀、不寫；複本也不准放在那兩個目錄底下）：
// 貼上與按信任是人的事。
//
// 用法：node tools/guard-copy.js --from <已合併進主幹的版本> --to <絕對路徑的空目錄> [--deny-probe <照清單該擋的假工具名>]
//   標準輸出＝要貼的那一組接線（JSON）；標準錯誤＝人讀的摘要。
//   退 0＝寫好而且自我試跑過；退 2＝拒絕（什麼都沒寫）；
//   退 1＝寫了東西但沒成功（自我試跑沒過、或寫到一半出錯）：標準輸出是空的、沒有東西可以貼，目的地可能留有複本或半份，
//   這支不刪它——看完自己刪，下次換一個新的空目錄。
//
// 裝與換只有一條順序（專案裡要看得到：套件的 README 不跟著搬進專案；README 第 3 步是同一份順序的抄本）：
//   ⓪先確認禁區清單（settings.json 的 forbidden.deny）裡有一個刻意放的無害測試工具：它要是 Codex 連得到的伺服器上真的存在的 mcp__ 工具，就算真的執行了也不會動到禁區、不會造成任何改變，而且不可以是禁區連接器（forbidden.servers）上的任何工具——連唯讀的查詢也不行；原本還有別的攔截組並存時，挑一個只有這份清單擋、別組不擋的名字。套件帶了一支現成的＝tools/canary-server.js（掛上去只回一句 pong，什麼都不做），工具名 mcp__guard_canary__ping，兩家 AI 各登記一次的做法見 templates/canary-install.md。清單上還沒有就先加、合併，再從①開始——沒有就停下來，不可以拿任何別的工具代替。
//   ①先 git fetch，在專案裡跑 node tools/guard-copy.js --from <已合併進主幹的版本> --to <新的空目錄>（建議家目錄底下固定的地方，例如 ~/.local/share/ai-collab-kit/guard/<版本碼前幾碼>）。
//   ②關掉所有 Codex 視窗（改鉤子檔到按下信任之間，改過的那一組是停用的：Codex 對沒信任的鉤子一聲不吭地跳過，這段時間不能有 Codex 在跑）。
//   ③編輯家目錄 .codex/hooks.json：第一次裝＝把印出的那一組加到 hooks.PreToolUse 最後面（原本有別的攔截組就讓它們並存）；換新複本＝在原位置換掉舊複本那一組。
//   ④開 Codex、按信任。
//   ⑤在 Codex 叫⓪那個無害測試工具：要看到被擋，而且擋的理由是這一組的（理由含「在拒絕清單上」；「固定複本不在、被改過…（指紋對不上）」那一句不算，那是複本壞了）。叫一般工具照常能用證明不了什麼（鉤子沒跑時它也能用）。
//   ⑥⑤沒看到這一組的拒絕＝關掉 Codex、把原來那一組放回去（換新複本時舊複本目錄還在）、按信任，再查原因；⑤過了、而且是換新複本，這時才刪舊的複本目錄（先 chmod -R u+w；先刪會讓舊那一組把所有 mcp__ 工具全擋）。
//   之後要拆掉並存的別的攔截組：同樣先關 Codex、刪那一組、對剩下的按信任（位置變了），再做一次⑤。
//   要重抽的時候＝settings.json 的 forbidden 那一塊、tools/forbidden-tools.js、tools/settings-data.js、tools/package.json、或 templates/hook-codex-global.json 那一組合併了改動：照⓪〜⑥重做；不重抽＝Codex 照抽的那個版本判，沒有機器提醒。
//   ⚠️ 任何會動到禁區的真工具，不論在不在清單上、不論攔截器擋不擋得住，一律絕不可以叫來試；驗收只准用⓪那個無害測試工具。
//
// 誠實劃界：指紋只蓋複本裡的檔，不蓋 node 本身、shasum 本身、PATH 找到哪一支 node（登入設定改了 PATH 就換了一支）；
// 檢查與執行之間的極短空檔被換檔擋不住（防的是漂移與誤改，不是本機有人蓄意競速）；
// 「已合併」看的是本機的 origin/<主幹> 追蹤參照（先 fetch）；自我試跑是在這支的環境裡跑，Codex 起鉤子的環境不一定一樣。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('./git-env.js');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_REL = 'templates/hook-codex-global.json';
/**
 * 攔截器跑起來會讀到的每一個檔，照位元組順序排好（shasum 照這個順序算，這裡也照這個順序算）。
 * settings.json 在複本裡只留 forbidden 那一塊（攔截器只讀那一塊；別的欄位改了不必重抽、也不必重按信任）。
 * tools/package.json 是 Node 自己讀的（決定照 CommonJS 載入），程式層追蹤看不到，所以考題另外用行為證明。
 * 「讀到的＝這一份」由 tests/guard-copy.test.js 的載入追蹤盯著：攔截器多 require 一支檔，那題就紅。
 */
const COPY_FILES = ['settings.json', 'tools/forbidden-tools.js', 'tools/package.json', 'tools/settings-data.js'];
const PLACEHOLDERS = ['{copyDir}', '{files}', '{fingerprint}'];
const UNSET = '未設定';
/** 自我試跑用的無害假名：依序試，有一個被乾淨地放行就算過（專案清單剛好擋到其中一個也不會誤判安裝失敗）。 */
const ALLOW_PROBES = ['mcp__guard_copy_selftest__noop', 'mcp__guard_copy_selftest__ping', 'mcp__kit_selftest_zz__hello'];
/** 暫存區：作業系統會清，複本放那裡哪天被清掉＝所有 mcp__ 工具突然全擋。 */
const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];
/** 放不進單引號的字元：單引號本身與控制字元（會把指令切壞）。 */
const unquotable = (p) => [...p].some((ch) => ch === "'" || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 指紋＝對「每個檔一行：<該檔的 sha256>兩個空白<相對路徑>換行」整段再取 sha256。
 * 這正是 `shasum -a 256 <檔…> | shasum -a 256` 印出的東西（前半段），所以鉤子指令不必信任 node 就能自己算。
 * @param {(rel: string) => Buffer} readFile
 */
function fingerprint(readFile) {
  return sha256(Buffer.from(COPY_FILES.map((rel) => `${sha256(readFile(rel))}  ${rel}\n`).join(''), 'utf8'));
}

const fingerprintDir = (dir) => fingerprint((rel) => fs.readFileSync(path.join(dir, rel)));

class Refusal extends Error {}

/**
 * 最近一層已存在的上層目錄的真實路徑，接回還不存在的那一截（/tmp 與 /private/tmp 這類別名要先解開再比）。
 * 用 native 版：不分大小寫的磁碟上 ~/.CODEX 跟 ~/.codex 是同一個目錄，native 會還原成磁碟上的寫法。
 */
function realish(p) {
  let existing = p;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  return path.join(fs.realpathSync.native(existing), path.relative(existing, p));
}

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
/**
 * 不分大小寫比：不分大小寫的磁碟上 ~/.CODEX 就是 ~/.codex，而還不存在的那一截 native 版還原不了大小寫
 * （裁示批 r1 B3：第一次建立 .CODEX 就擋不住）。分大小寫的磁碟上多擋了 ~/.CODEX 這種名字，無害。
 */
const insideAnyCase = (child, parent) => inside(child.toLowerCase(), parent.toLowerCase());
/** 工具名的合法字元（跟攔截器同一套）：不合法的名字攔截器本來就一律擋，拿來當試跑的「該擋的名字」證明不了清單。 */
const PROBE_NAME = /^mcp__[A-Za-z0-9_.-]{1,195}$/u;

/** 目的地的檢查；回真實路徑。任何一條不過就拒絕（此時什麼都還沒寫）。 */
function checkTarget(to, { home = os.homedir(), allowTemp = false } = {}) {
  if (typeof to !== 'string' || !path.isAbsolute(to)) throw new Refusal('--to 要給絕對路徑（鉤子在任何目錄執行，相對路徑沒有意義）');
  const real = realish(path.normalize(to));
  if (unquotable(real)) throw new Refusal('複本路徑含單引號或控制字元，放不進鉤子指令');
  for (const d of ['.codex', '.claude']) {
    if (insideAnyCase(real, realish(path.join(home, d)))) throw new Refusal(`複本不可以放在家目錄的 ${d} 底下：那是 AI 平台自己的設定目錄，這支工具不碰`);
  }
  if (!allowTemp) {
    for (const t of [os.tmpdir(), ...TEMP_ROOTS]) {
      if (fs.existsSync(t) && insideAnyCase(real, realish(t))) {
        throw new Refusal(`複本不可以放在暫存區（${t}）：作業系統會清，清掉那天所有 mcp__ 工具會突然全擋。建議放在家目錄底下一個固定的地方，例如 ~/.local/share/ai-collab-kit/guard/<版本碼前幾碼>`);
      }
    }
  }
  if (fs.existsSync(real) && (!fs.statSync(real).isDirectory() || fs.readdirSync(real).length)) {
    throw new Refusal('目的地已經有東西：這支從不覆寫。每抽一次就給一個新的空目錄（舊的複本在新指令按下信任之前還在擋）');
  }
  let existing = real;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  // 只有 git 明確說「不是倉庫」才算在倉庫以外；其餘任何錯（叫不起、權限、擁有者不符）一律拒絕
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree', '--is-inside-git-dir'], { cwd: existing, env: { ...gitEnv(), LC_ALL: 'C' }, encoding: 'utf8' });
  if (git.error) throw new Refusal(`叫不起 git，無法確認目的地不在版本控制目錄裡（${git.error.code}）`);
  if (git.status === 0) throw new Refusal('目的地在版本控制目錄裡：固定複本要放在任何倉庫以外（切分支、拉新版會改到它）');
  if (!/not a git repository/u.test(git.stderr)) throw new Refusal(`無法確認目的地不在版本控制目錄裡（${git.stderr.trim().slice(0, 200)}）`);
  return real;
}

/**
 * 從版本控制讀出複本內容與接線範本（不讀工作樹：沒提交的改動不可能進複本、也不可能改到要按信任的那一行）。
 * 那個版本必須已經在 origin/<主幹> 裡：只要求「提交過」的話，本機沒推、沒審的提交照樣進得來。
 */
function extract(ref, root = ROOT) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Refusal('--from 要給一個版本（分支名或提交碼）');
  const git = (args, encoding) => spawnSync('git', args, { cwd: root, env: gitEnv(), encoding, maxBuffer: 64 * 1024 * 1024 });
  const rev = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 'utf8');
  if (rev.error) throw new Refusal(`叫不起 git（${rev.error.code}）`);
  if (rev.status !== 0) throw new Refusal(`「${ref}」不是這個倉庫裡的一個版本`);
  const commit = rev.stdout.trim();
  const show = (rel) => {
    const r = git(['show', `${commit}:./${rel}`], 'buffer');
    if (r.status !== 0) throw new Refusal(`版本 ${commit.slice(0, 12)} 裡沒有 ${rel}`);
    return r.stdout;
  };
  const files = new Map(COPY_FILES.map((rel) => [rel, show(rel)]));
  let settings;
  try { settings = JSON.parse(files.get('settings.json').toString('utf8')); } catch { throw new Refusal('那個版本的 settings.json 不是合法的 JSON'); }
  const main = settings && settings.mainBranch;
  if (typeof main !== 'string' || !main || main === UNSET) throw new Refusal('那個版本的設定沒填主幹分支名：確認不了它合併了沒有');
  const tracking = `refs/remotes/origin/${main}`;
  if (git(['rev-parse', '--verify', '--quiet', tracking], 'utf8').status !== 0) throw new Refusal(`本機沒有 origin/${main}：先 git fetch 再抽`);
  if (git(['merge-base', '--is-ancestor', commit, tracking], 'utf8').status !== 0) {
    throw new Refusal(`版本 ${commit.slice(0, 12)} 還不在 origin/${main} 裡：只抽已經合併的版本（先 git fetch；還沒合併就等合併）`);
  }
  const f = settings.forbidden;
  if (!f || typeof f !== 'object' || Array.isArray(f) || !f.name || f.name === UNSET) {
    throw new Refusal('那個版本的禁區清單還沒填：裝上去只會把所有 mcp__ 工具全部擋掉，先填清單、合併之後再抽');
  }
  files.set('settings.json', Buffer.from(`${JSON.stringify({ forbidden: f }, null, 2)}\n`, 'utf8'));
  return { commit, files, template: show(TEMPLATE_REL).toString('utf8'), tracking: `origin/${main}` };
}

/** 範本的那一組接線，三個佔位換掉；範本的佔位不是剛好各一個＝範本壞了，拒絕。 */
function hookGroup({ copyDir, fp }, templateText) {
  let doc;
  try { doc = JSON.parse(templateText); } catch { throw new Refusal('接線範本不是合法的 JSON'); }
  const group = doc && doc.hooks && doc.hooks.PreToolUse && doc.hooks.PreToolUse[0];
  const command = group && group.hooks && group.hooks[0] && group.hooks[0].command;
  if (typeof command !== 'string') throw new Refusal('接線範本裡找不到那一條指令');
  // 整組的形狀也要對：matcher 不是 ^mcp__、不是指令型、多出別的組或別的鉤子＝印出來的那一組不會照預期攔（裁示批 r1 T2）
  if (doc.hooks.PreToolUse.length !== 1 || group.matcher !== '^mcp__' || group.hooks.length !== 1 || group.hooks[0].type !== 'command') {
    throw new Refusal('接線範本那一組的形狀不對（要剛好一組、matcher 是 ^mcp__、剛好一條指令型鉤子）');
  }
  for (const ph of PLACEHOLDERS) {
    if (command.split(ph).length !== 2) throw new Refusal(`範本的指令裡「${ph}」不是剛好一個`);
  }
  const filled = command.replace('{copyDir}', () => copyDir).replace('{files}', () => COPY_FILES.join(' ')).replace('{fingerprint}', () => fp);
  return { matcher: group.matcher, hooks: [{ ...group.hooks[0], command: filled }] };
}

const runHook = (command, tool) => spawnSync('/bin/sh', ['-lc', command], { cwd: os.tmpdir(), input: JSON.stringify({ tool_name: tool }), encoding: 'utf8' });

/**
 * 照 Codex 的起法（/bin/sh -lc）真的跑那一行指令，任一項不符就回失敗原因：
 *   ①無害假名要**放行**：退 0、兩個輸出都空的（依序試幾個，有一個過就算；清單壞到什麼都擋、登入設定往輸出印字，都在這裡露出來）；
 *   ②照清單該擋的假名要**擋**：退 2、錯誤輸出是拒絕的形狀（依序試幾個；攔截器被改成什麼都放，這裡露出來）；
 *   ③指紋檢查要真的在：同一行指令指向一份改過一個位元組的副本，要退 2 而且是指紋那一句。
 * 全程只跑指令、不把複本裡的程式載進這支（驗的就是鉤子實際會走的那一條路）。
 */
function selfTest({ copyDir, fp, template, forbidden, denyProbe = null }) {
  const command = hookGroup({ copyDir, fp }, template).hooks[0].command;
  const show = (r) => `退 ${r.status}；標準輸出「${r.stdout.slice(0, 120)}」；錯誤輸出「${r.stderr.slice(0, 200)}」`;

  let allowName = null;
  let lastAllow = null;
  for (const name of ALLOW_PROBES) {
    lastAllow = runHook(command, name);
    if (lastAllow.status === 0 && lastAllow.stdout === '' && lastAllow.stderr === '') { allowName = name; break; }
  }
  if (!allowName) return `無害的假名一個都沒有被乾淨地放行（最後一次：${show(lastAllow)}）——清單壞到什麼都擋、或登入設定往標準輸出印字（要先讓它安靜）`;

  // 有給 --deny-probe 就只試那一個（給了卻不擋＝失敗，不改試別的）；沒給就從清單自動產生
  const denyCandidates = denyProbe ? [denyProbe] : autoDenyProbes(forbidden);
  let denied = false;
  let lastDeny = null;
  for (const name of denyCandidates) {
    lastDeny = runHook(command, name);
    let shape = false;
    try { shape = JSON.parse(lastDeny.stderr.trim()).hookSpecificOutput.permissionDecision === 'deny'; } catch { /* 不是拒絕形狀 */ }
    if (lastDeny.status === 2 && lastDeny.stdout === '' && shape) { denied = true; break; }
  }
  if (!denied) return `照清單該擋的假名沒有一個被擋成退 2（試了 ${denyCandidates.length} 個${lastDeny ? `；最後一次：${show(lastDeny)}` : ''}）——攔截器被改成什麼都放、或清單沒有有效規則`;

  const dup = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-copy-selftest-'));
  try {
    for (const rel of COPY_FILES) {
      fs.mkdirSync(path.dirname(path.join(dup, rel)), { recursive: true });
      fs.copyFileSync(path.join(copyDir, rel), path.join(dup, rel));
      fs.chmodSync(path.join(dup, rel), 0o644);
    }
    fs.appendFileSync(path.join(dup, 'settings.json'), ' ');
    const tampered = runHook(hookGroup({ copyDir: dup, fp }, template).hooks[0].command, allowName);
    if (tampered.status !== 2 || !/指紋對不上/u.test(tampered.stderr)) return `指紋檢查沒有作用：改過一個位元組的副本沒有被擋（${show(tampered)}）`;
  } finally {
    fs.rmSync(dup, { recursive: true, force: true });   // 只刪自己剛建的試跑副本
  }
  return null;
}

/** 從清單自動產生「照清單該擋」的試跑名字：連接器、第一組動詞＋名詞、逐字拒絕清單。只有樣式規則的清單產不出來（要 --deny-probe）。 */
function autoDenyProbes(forbidden) {
  const f = forbidden;
  return [
    ...(Array.isArray(f.servers) ? f.servers.map((srv) => `mcp__${srv}__guard_copy_selftest_probe`) : []),
    ...(Array.isArray(f.verbs) && Array.isArray(f.nouns) && f.verbs[0] && f.nouns[0] ? [`mcp__guard_copy_selftest__${f.verbs[0]}_${f.nouns[0]}`] : []),
    ...(Array.isArray(f.deny) ? f.deny : []),
  ].filter((n) => typeof n === 'string' && PROBE_NAME.test(n));
}

function build({ from, to, root = ROOT, home, allowTemp = false, runSelfTest = true, denyProbe = null }) {
  if (denyProbe !== null && (typeof denyProbe !== 'string' || !PROBE_NAME.test(denyProbe))) {
    throw new Refusal('--deny-probe 要是合法的假工具名（mcp__ 開頭、只用英數與 _ . -）：不合法的名字攔截器本來就擋，證明不了清單');
  }
  const copyDir = checkTarget(to, { home, allowTemp });
  const { commit, files, template, tracking } = extract(from, root);
  const forbiddenBlock = JSON.parse(files.get('settings.json').toString('utf8')).forbidden;
  // 只看「清單有沒有這幾種欄位」，不看合不合文法：壞掉的清單要走到試跑，由「無害名字也被擋、設定壞掉」那一句露出來
  const f = forbiddenBlock;
  const hasAutoSource = (Array.isArray(f.servers) && f.servers.length) || (Array.isArray(f.verbs) && f.verbs[0] && Array.isArray(f.nouns) && f.nouns[0]) || (Array.isArray(f.deny) && f.deny.length);
  if (runSelfTest && !denyProbe && !hasAutoSource) {
    throw new Refusal('這份清單只靠樣式規則（沒有連接器、動詞＋名詞、逐字拒絕清單），工具自己想不出該擋的試跑名字：用 --deny-probe 給一個照清單該擋的假工具名（只當字串餵給攔截器）');
  }
  hookGroup({ copyDir, fp: '0'.repeat(64) }, template);   // 先驗範本，範本壞了就什麼都不寫
  fs.mkdirSync(copyDir, { recursive: true });
  for (const rel of COPY_FILES) {
    fs.mkdirSync(path.dirname(path.join(copyDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(copyDir, rel), files.get(rel), { flag: 'wx', mode: 0o444 });
  }
  const fp = fingerprintDir(copyDir);   // 從磁碟讀回來算：算的就是鉤子會看到的位元組
  const group = hookGroup({ copyDir, fp }, template);
  const failure = runSelfTest ? selfTest({ copyDir, fp, template, forbidden: forbiddenBlock, denyProbe }) : null;
  return { commit, tracking, copyDir, fp, group, failure };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]];
    const key = { '--from': 'from', '--to': 'to', '--deny-probe': 'denyProbe' }[k];
    if (!key || v === undefined || out[key] !== undefined) return null;
    out[key] = v;
  }
  return out.from && out.to ? out : null;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write('用法：node tools/guard-copy.js --from <已合併進主幹的版本> --to <絕對路徑的空目錄> [--deny-probe <照清單該擋的假工具名>]\n');
    return 2;
  }
  let r;
  // 暫存區放行只給考題用（考題只能在暫存區裡建目錄）；實際安裝不要設它
  try { r = build({ ...args, allowTemp: env.KIT_GUARD_COPY_ALLOW_TEMP === '1' }); } catch (e) {
    if (e instanceof Refusal) { process.stderr.write(`拒絕：${e.message}（什麼都沒寫）\n`); return 2; }
    process.stderr.write(`寫入或試跑途中出錯（${(e && (e.code || e.message)) || '不明'}）：目的地可能留有半份，看完自己刪，下次換一個新的空目錄。沒有東西可以貼。\n`);
    return 1;
  }
  const summary = [`來源版本：${r.commit}（已在 ${r.tracking} 裡）`, `複本：${r.copyDir}`, `指紋：${r.fp}`];
  if (r.failure) {
    // 沒過就不印接線：標準輸出是空的，沒有東西可以貼
    process.stderr.write([...summary, `自我試跑沒過（${r.failure}）：不印接線。複本留著給人看，看完自己刪（先 chmod -R u+w 再刪）。`, ''].join('\n'));
    return 1;
  }
  process.stdout.write(`${JSON.stringify(r.group, null, 2)}\n`);
  process.stderr.write([...summary, '自我試跑：過（/bin/sh -lc：無害假名放行、該擋的假名退 2、改過一個位元組的副本退 2）。',
    '接下來（人做，這支不碰家目錄的 .codex；完整順序＝本檔檔頭⓪〜⑥）：先確認禁區清單裡有刻意放的無害測試工具（真的存在、執行了也無害、不可以是禁區連接器上的工具——連唯讀的也不行；套件帶了一支現成的：tools/canary-server.js，名字 mcp__guard_canary__ping，裝法見 templates/canary-install.md；沒有就停下來先加、合併、重抽，不可以拿別的工具代替）→ 關掉所有 Codex 視窗 → 第一次裝＝把上面那一組加到家目錄 .codex/hooks.json 的 hooks.PreToolUse 最後面；換新複本＝在原位置換掉舊複本那一組 → 開 Codex 按信任 → 叫那個無害測試工具，要看到這一組的拒絕理由（含「在拒絕清單上」）→ 沒看到就先關掉所有 Codex 視窗、把原來那一組放回去、開 Codex 按信任、再查；看到了、而且是換新複本，才刪舊的複本目錄。⚠️ 任何會動到禁區的真工具，不論在不在清單上、不論攔截器擋不擋得住，一律絕不可以叫來試；驗收只准用清單上刻意放的無害測試工具，沒有就停下來先加。', ''].join('\n'));
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { COPY_FILES, PLACEHOLDERS, ALLOW_PROBES, TEMP_ROOTS, autoDenyProbes, fingerprint, fingerprintDir, checkTarget, extract, hookGroup, selfTest, build, main, Refusal };
