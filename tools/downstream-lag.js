#!/usr/bin/env node
// 下游落後：在套件這邊，替設定裡登記的每個使用專案印出它落後套件主幹多少——落後幾支（其中動到共用路徑幾支）、
// 哪些共用檔跟套件主幹不同、它的設定比套件主幹的空白範本少了（或多了）哪些欄位與機器列。
//
// 為什麼：使用專案從套件的一個固定版本取檔，之後套件又合了好幾支；兩邊都沒有東西說「落後多少、差在哪」，
// 要量就得派人逐檔比（稽核 2026-10-06：理財落後 28 支、12 支動到共用路徑，量一次派了 10 個代理）。
// 擁有者 2026-10-07 裁「現在就做。（建議）」（原本的待辦條件是「有第二個使用專案之後」）：只列不擋、開工時手動跑、不排程。
// 方向是套件讀使用專案（使用專案是公開的、套件是私有的，反過來讀不到）；套件這一邊讀本機版本控制，使用專案那一邊經平台介面。
//
// 使用專案記的套件版本從哪來：它主幹上有 kit-lock.json 就讀它的 version（形狀照 kit-lock.js 驗）；還沒裝的，讀設定 downstream 裡
// 那一筆人填的 versionWithoutLock 與出處。刻意不去使用專案的說明文件裡用正規式抓版本碼：那是散文、很脆（稽核反駁者的建議），
// 而且同步一恢復第一件事就是裝 kit-lock.json，之後這兩格就不再用。
//
// ⚠️ 守不到的：
//   ①版本碼是使用專案自己記的（kit-lock.json、或設定裡人填的）：記錯了，落後數跟著錯；這裡只核它在不在套件主幹的歷史上；
//   ②共用檔比的是內容雜湊：同一份內容搬到共用路徑外看不到；「專案改過」是拿它跟它記的那一版比出來的，記的版本錯就判錯；
//   ③套件主幹以平台說的那一顆為準，本機沒有那一顆（沒 fetch）就算不出來；
//   ④設定只比欄位名（鍵的路徑，陣列不往裡看）與機器列的名字，不比值；
//   ⑤落後的支數是套件主幹上的提交數（套件一支PR壓成一顆提交，H5）；有人直接推上主幹的也算一支；
//   ⑥檔案清單與逐檔內容是分兩次問平台的：下游分支在兩次之間剛更新，讀到的內容會跟清單對不上——每個讀回的檔都拿內容算 blob 雜湊
//     跟清單裡那一格比，對不上＝退 2 叫人重跑（#60 r1 R2）；清單本身跟同一瞬間的分支頂端對不對，這裡量不到；
//   ⑦本機 git 的輸出只信 --format 指定的欄位、log 一律帶 --no-show-signature（開了 log.showSignature 時簽章診斷會混進標準輸出被算成支數，#60 r3 R1）
//     與 --encoding=UTF-8（i18n.logOutputEncoding 設成別的編碼時題名變亂碼，#60 r4 R1）；別的會改輸出的使用者設定（例如包一層的 git 啟動器）沒逐一量。
// 退出碼：0＝印出來了（含沒有落後、沒有登記任何使用專案）；2＝有一個以上算不出來（那一筆設定寫壞、平台問不到、版本碼不在套件主幹上、
// 讀到的檔跟清單雜湊對不上、本機沒有主幹那一顆、參數不對）——算得出來的照印；只有整塊 downstream 的形狀壞掉才一個都不算（#60 r1 R1）。⚠️ 不是閘。
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { ask, PlatformError } = require('./platform.js');
const { read: readSettings } = require('./settings-data.js');
const { gitEnv } = require('./git-env.js');
const { LOCK_FILE, SHARED_PATHS, underShared, validateLock, LockError } = require('./kit-lock.js');

const UNSET = '未設定';
const ROOT = path.join(__dirname, '..');
const TEMPLATE = 'tests/helpers/unfilled-settings.json';
const SETTINGS = 'settings.json';
const HEX40 = /^[0-9a-f]{40}$/u;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH = /^[A-Za-z0-9._/-]+$/u;

class LagError extends Error {}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new LagError(`git 起不來：${r.error.message}`);
  return r;
}
function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new LagError(`git ${args[0]} 退 ${r.status}：${(r.stderr || '').trim() || '（沒有訊息）'}`);
  return r.stdout;
}

/** 設定裡登記的使用專案（原樣、還沒逐筆驗）；整塊的形狀壞掉才丟 LagError。沒有這一塊或清單空的＝沒有登記。 */
function projectsOf(settings) {
  const d = settings.downstream;
  if (d === undefined) return [];
  if (!d || typeof d !== 'object' || !Array.isArray(d.projects)) throw new LagError('設定的 downstream 要是物件、裡面的 projects 要是陣列');
  return d.projects;
}

/**
 * 一筆登記的形狀；寫壞丟 LagError（不猜）。逐筆驗、不在整批 map 裡驗：一筆寫壞只讓那一筆退 2，其餘照算（#60 r1 R1：
 * 原本整批 map 一丟錯就整個 run 停、別的專案一行都沒印）。
 */
function validateProject(p, i) {
  const where = `downstream.projects[${i}]`;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new LagError(`${where} 要是物件`);
  for (const k of ['name', 'repo', 'branch']) {
    if (typeof p[k] !== 'string' || !p[k].trim() || p[k] === UNSET) throw new LagError(`${where}.${k} 沒填`);
  }
  if (!REPO.test(p.repo)) throw new LagError(`${where}.repo「${p.repo}」要是「帳號/倉庫名」`);
  if (!BRANCH.test(p.branch)) throw new LagError(`${where}.branch「${p.branch}」不是正常的分支名`);
  const fallback = p.versionWithoutLock;
  if (fallback !== undefined && fallback !== UNSET && !HEX40.test(String(fallback))) throw new LagError(`${where}.versionWithoutLock 要是 40 位小寫十六進位的套件版本碼（或「未設定」）`);
  return { name: p.name, repo: p.repo, branch: p.branch, fallback: fallback === UNSET ? undefined : fallback, fallbackFrom: p.versionWithoutLockFrom };
}

/** 某一顆版本上共用路徑底下的每一個檔：路徑 → 內容雜湊。 */
function kitFiles(root, sha) {
  const out = gitOut(root, ['ls-tree', '-r', '-z', sha, '--', ...SHARED_PATHS]);
  const map = new Map();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [, type, blob] = rec.slice(0, tab).split(' ');
    if (type === 'blob') map.set(rec.slice(tab + 1), blob);
  }
  return map;
}

/** 讀回來的檔內容算 blob 雜湊（跟 ls-tree、平台檔案清單裡的那一格同一種）。 */
function blobSha(root, content) {
  const r = spawnSync('git', ['hash-object', '--stdin'], { cwd: root, env: gitEnv(), encoding: 'utf8', input: content });
  if (r.error || r.status !== 0) throw new LagError(`算不出讀回來的檔的雜湊：${r.error ? r.error.message : (r.stderr || '').trim()}`);
  return r.stdout.trim();
}

/**
 * 從下游讀一個檔，並核它跟這次檔案清單裡那一格的雜湊對得上：檔案清單與逐檔內容是兩次問平台，下游分支在中間剛更新就會拼出兩個時點的錯診斷
 *（#60 r1 R2）；對不上就退 2 叫人重跑，不拼。
 */
function readConsistent(p, file, theirs, { root, settings, platform }) {
  const content = platform.ask('repoFile', { repo: p.repo, ref: p.branch, path: file }, { settings }).content;
  const got = blobSha(root, content);
  if (got !== theirs.get(file)) throw new LagError(`它的 ${file} 讀到的內容跟這次檔案清單裡的雜湊對不上（清單 ${String(theirs.get(file)).slice(0, 7)}、內容 ${got.slice(0, 7)}）：下游分支在兩次讀取之間更新了，重跑一次`);
  return content;
}

/** 鍵的路徑（陣列不往裡看；⑨ 也是這樣看形狀）。 */
function keyPaths(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out = [];
  for (const k of Object.keys(value)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(p, ...keyPaths(value[k], p));
  }
  return out;
}
const machineNames = (s) => (Array.isArray(s && s.machines) ? s.machines.map((m) => (m && typeof m.name === 'string' ? m.name : '')).filter(Boolean) : []);
const minus = (a, b) => { const set = new Set(b); return a.filter((x) => !set.has(x)); };

/** 一個使用專案算一份；算不出來丟 LagError 或 PlatformError，由呼叫端印原因。 */
function lagOf(p, { root, settings, platform, kitHead, template }) {
  const tree = platform.ask('repoTree', { repo: p.repo, ref: p.branch }, { settings });
  const theirs = new Map(tree.map((x) => [x.path, x.sha]));
  let version;
  let from;
  let exceptions = [];
  if (theirs.has(LOCK_FILE)) {
    let lock;
    try { lock = JSON.parse(readConsistent(p, LOCK_FILE, theirs, { root, settings, platform })); }
    catch (e) { if (e instanceof SyntaxError) throw new LagError(`它的 ${LOCK_FILE} 不是合法的 JSON`); throw e; }
    try { validateLock(lock); } catch (e) { if (e instanceof LockError) throw new LagError(`它的 ${e.message}`); throw e; }
    version = lock.version;
    from = `它的 ${LOCK_FILE}（同步日 ${lock.syncedAt}）`;
    exceptions = lock.exceptions;
  } else if (p.fallback) {
    version = p.fallback;
    from = `設定裡人填的（它還沒裝 ${LOCK_FILE}）：${p.fallbackFrom || '出處沒寫'}`;
  } else {
    throw new LagError(`它還沒裝 ${LOCK_FILE}，設定裡也沒填 versionWithoutLock：不知道它停在套件哪一版`);
  }
  if (git(root, ['cat-file', '-e', `${version}^{commit}`]).status !== 0) throw new LagError(`它記的套件版本 ${version.slice(0, 7)} 本機找不到（先 git fetch；還是找不到＝那不是套件的版本）`);
  if (git(root, ['merge-base', '--is-ancestor', version, kitHead]).status !== 0) throw new LagError(`它記的套件版本 ${version.slice(0, 7)} 不在套件主幹的歷史上：不是從主幹取的檔，落後數算不出來`);
  // --no-show-signature：使用者的 git 設定開了 log.showSignature、範圍裡有簽過章的提交（GitHub 壓成的合併提交都有簽）時，
  // 簽章診斷會混進標準輸出、每一行都被算成一支（#60 r3 R1）；--encoding=UTF-8：i18n.logOutputEncoding 設成別的編碼時，
  // 題名會照那個編碼吐出來、這裡一律當 UTF-8 讀就成亂碼（#60 r4 R1）；--format 只印這兩欄。量過的只有這兩種設定，別的沒逐一量
  const LOG = ['log', '--no-show-signature', '--encoding=UTF-8', '--format=%h %s'];
  const behind = gitOut(root, [...LOG, `${version}..${kitHead}`]).split('\n').filter(Boolean);
  const behindShared = gitOut(root, [...LOG, `${version}..${kitHead}`, '--', ...SHARED_PATHS]).split('\n').filter(Boolean);

  const kitNow = kitFiles(root, kitHead);
  const kitThen = kitFiles(root, version);
  const theirsShared = new Map([...theirs].filter(([f]) => underShared(f)));
  const exc = new Map(exceptions.map((x) => [x.path, x]));
  const note = (f) => (exc.has(f) ? `；記了例外：${exc.get(f).who}，${exc.get(f).why}` : '');
  const differ = [];
  const onlyKit = [];
  const onlyTheirs = [];
  for (const [f, blob] of kitNow) {
    if (!theirsShared.has(f)) onlyKit.push(`${f}（${kitThen.has(f) ? '它那邊沒有，它記的版本有＝它刪掉了' : '套件後來加的'}${note(f)}）`);
    else if (theirsShared.get(f) !== blob) differ.push(`${f}（${theirsShared.get(f) === kitThen.get(f) ? '套件後來改了' : '它改過：跟它記的那一版也不同'}${note(f)}）`);
  }
  for (const f of theirsShared.keys()) {
    if (!kitNow.has(f)) onlyTheirs.push(`${f}（${kitThen.has(f) ? '套件後來刪了' : '它自己加的'}${note(f)}）`);
  }

  let settingsLines;
  if (!theirs.has(SETTINGS)) {
    settingsLines = [`  設定：它主幹上沒有 ${SETTINGS}`];
  } else {
    let ours;
    try { ours = JSON.parse(readConsistent(p, SETTINGS, theirs, { root, settings, platform })); }
    catch (e) { if (e instanceof SyntaxError) throw new LagError(`它的 ${SETTINGS} 不是合法的 JSON`); throw e; }
    const want = keyPaths(template);
    const have = keyPaths(ours);
    const missKeys = minus(want, have);
    const extraKeys = minus(have, want);
    const missRows = minus(machineNames(template), machineNames(ours));
    const extraRows = minus(machineNames(ours), machineNames(template));
    settingsLines = [`  設定（跟套件主幹的空白範本比，只比欄位名與機器列名，不比值）：少 ${missKeys.length} 個欄位、多 ${extraKeys.length} 個；機器列少 ${missRows.length} 列、多 ${extraRows.length} 列`];
    for (const [label, xs] of [['少的欄位', missKeys], ['多的欄位（套件已拿掉或它自己加的）', extraKeys], ['少的機器列', missRows], ['多的機器列', extraRows]]) {
      for (const x of xs) settingsLines.push(`    ・${label}：${x}`);
    }
  }
  return [
    `${p.name}（${p.repo} 的 ${p.branch}）：記的套件版本 ${version.slice(0, 7)}，來源＝${from}`,
    `  落後 ${behind.length} 支（其中動到共用路徑 ${behindShared.length} 支）${behindShared.length ? '：' : ''}`,
    ...behindShared.map((l) => `    ・${l}`),
    `  共用檔（${SHARED_PATHS.join('、')}）：不同 ${differ.length} 個、只在套件 ${onlyKit.length} 個、只在它那邊 ${onlyTheirs.length} 個`,
    ...differ.map((x) => `    ・不同：${x}`),
    ...onlyKit.map((x) => `    ・只在套件：${x}`),
    ...onlyTheirs.map((x) => `    ・只在它那邊：${x}`),
    ...settingsLines,
  ];
}

function run({ settings = readSettings(), platform = { ask }, root = ROOT } = {}) {
  let projects;
  try { projects = projectsOf(settings); } catch (e) { if (e instanceof LagError) return { code: 2, lines: [`下游落後：${e.message}——算不出來。`] }; throw e; }
  if (!projects.length) return { code: 0, lines: ['下游落後：設定的 downstream 沒有登記任何使用專案，沒有東西要比。'] };
  // 每一筆先逐筆驗形狀、錯的記下來；一筆都不合格就不去問平台（設定全壞不該打平台）；有合格的才往下
  const checked = projects.map((raw, i) => {
    try { return { p: validateProject(raw, i) }; } catch (e) { if (e instanceof LagError) return { err: e.message, i }; throw e; }
  });
  if (!checked.some((c) => c.p)) return { code: 2, lines: checked.map((c) => `downstream.projects[${c.i}]：算不出來——${c.err}`) };
  const main = settings.mainBranch;
  if (typeof main !== 'string' || !main.trim() || main === UNSET) return { code: 2, lines: ['下游落後：設定的 mainBranch 沒填，不知道套件主幹是哪一條——算不出來。'] };
  let kitHead;
  try { kitHead = platform.ask('branchSha', { branch: main }, { settings }).sha; } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) return { code: 2, lines: [`下游落後：問不到平台套件主幹指到哪一顆（${e.message}）——算不出來。`] };
    throw e;
  }
  if (!HEX40.test(kitHead) || git(root, ['cat-file', '-e', `${kitHead}^{commit}`]).status !== 0) {
    return { code: 2, lines: [`下游落後：套件主幹在平台上是 ${String(kitHead).slice(0, 7)}，本機沒有這一顆——先 git fetch 再跑。`] };
  }
  let template;
  try { template = JSON.parse(gitOut(root, ['show', `${kitHead}:${TEMPLATE}`])); } catch (e) {
    return { code: 2, lines: [`下游落後：讀不到套件主幹的空白範本 ${TEMPLATE}（${e.message}）——算不出來。`] };
  }
  const lines = [`下游落後｜套件主幹 ${main}＝${kitHead.slice(0, 7)}｜登記 ${projects.length} 個使用專案（只列不擋、不是排程）`];
  let code = 0;
  for (const c of checked) {
    if (c.err) { code = 2; lines.push(`downstream.projects[${c.i}]：算不出來——${c.err}`); continue; }
    const p = c.p;
    try {
      lines.push(...lagOf(p, { root, settings, platform, kitHead, template }));
    } catch (e) {
      if (!(e instanceof LagError || e instanceof PlatformError || (e && e.name === 'PlatformError'))) throw e;
      code = 2;
      lines.push(`${p.name}（${p.repo} 的 ${p.branch}）：算不出來——${e.message}`);
    }
  }
  return { code, lines };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let result;
  if (argv.length) result = { code: 2, lines: [`下游落後不收任何參數（收到：${argv.join(' ')}）：它一律比設定裡登記的每個使用專案。用法：node tools/downstream-lag.js`] };
  else {
    try { result = run(); } catch (e) { result = { code: 2, lines: [`下游落後：沒有預期到的錯誤（${(e && e.message) || '不明'}）——算不出來。`] }; }
  }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { run, projectsOf, validateProject, keyPaths, lagOf, blobSha, LagError };
