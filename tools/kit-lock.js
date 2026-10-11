// 共用檔清單（釘住套件版本）：使用專案根目錄一份 kit-lock.json，記下同步時取的是套件哪一版、那一版每個共用檔的權限＋blob＋路徑，
// 以及「專案自己先改了套件的檔」的例外（哪個檔、為什麼、誰負責搬回套件、從哪天起）。
//
// 為什麼（擁有者 2026-09-29 裁）：套件的檔預設在套件改、再同步回專案；專案先改只當記錄過的例外，記錄要機器比對。原專案 #641 在專案
// 就地改了 6 個共用檔，PR 說明與留言沒有一處提到套件，是後來有人手動比對兩份程式才發現、套件約 34 小時後才補上——沒有任何機器在看
// 「專案有沒有改到套件的檔」；同步到哪一版也只記在文字裡，機器讀不到。
// 為什麼 --write 要讀套件本身（2026-09-29 自審抓到）：照 git archive 解開的同步只會新增與覆蓋、不會刪，工作樹可能留著套件已經刪掉的檔、
// 或專案自己多放的檔；拿工作樹當「套件那一版」寫清單，例外會靜靜消失。所以清單的內容一律從套件那一版取，工作樹跟它不一樣又沒記例外＝拒寫。
//
// 守到哪裡（tests/kit-lock.test.js 釘）：--check 拿清單每一筆跟工作樹比權限＋blob；多出來、少掉、改內容、改權限的檔，每一個都要有一筆
//   例外對上（路徑一字不差，大小寫也算）；例外指的檔已經跟清單一樣、或根本不存在＝紅；清單不在、壞掉或形狀不對、git 失敗＝退 2（不猜）。
//   --write 從本機套件倉庫的那一版取清單內容（版本不在＝退 2），工作樹跟它不一樣的每個檔都要在上一份清單裡有例外，沒有＝拒寫；
//   印出跟上一份差在哪、保留與清掉了哪些例外，外加一行固定提醒：列出攔截器相關的 5 樣，動到任一樣合併後要換複本、重按信任。
// 為什麼提醒是固定的一行、不判斷這次動到沒有（擁有者 2026-09-29 裁 a）：複審 r1〜r4 連四輪在「自動判斷動到沒有」這一族抓到問題
//   （推算與直接量各有漏的情境）；原專案的釘指紋等式題在指紋變了卻沒重印那一行時本來就會紅。這次要不要換，由實作者看這支 PR 對主幹的差異告訴擁有者。
// ⚠️ 擋不住的：同一支 PR 連清單、這支工具或考題一起改（絆線不是鎖；改動留在 diff 裡給複審者看）；
//   --check 不驗清單裡的版本碼與 blob 真的出自套件（使用專案的雲端讀不到私有的套件；--write 那一刻有驗，之後手改清單就只剩複審）；
//   套件那邊有沒有新的（要讀得到套件）；被 .gitignore 忽略的檔；SHARED_PATHS 以外的檔（例如從範本抄出來的 .github/workflows）；
//   settings.json（專案自己的值，連同 forbidden 那一塊都不在清單）；例外的 why／who 只驗非空單行，是不是真的負責人不驗；
//   各機器換行轉換或 filter 設定不同時，blob 可能對不上（假紅；套件共用檔目前沒有 CR、也沒有 .gitattributes）；
//   權限照磁碟判（擁有者的執行位元，跟 git 一樣），不看 core.fileMode；分不出「專案多改了」還是「套件有新的沒跟上」。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('./git-env.js');
const { COPY_FILES } = require('./guard-copy.js');
const { realDate } = require('./pending-rulings.js');

const ROOT = path.join(__dirname, '..');
const LOCK_FILE = 'kit-lock.json';
/** 機器表那一列的名字（settings.json 的 machines；考題拿它決定帶不帶）。 */
const MACHINE = '共用檔清單（釘住套件版本；專案改到套件的檔要記例外）';
/** 共用檔＝README「搬進一個專案」第 1 步要取的路徑。README 那一步另列了一份給人看，兩份沒有考題比對：改一邊要同一支改另一邊。 */
const SHARED_PATHS = ['tools', 'tests', 'templates', 'rules.json', 'RULES.md', 'MACHINES.md', 'GLOSSARY.md', 'docs/money-guard-two-pattern-tables.md', 'cases/DIGEST.md'];
/** 進錢的攔截器指紋的共用檔＝guard-copy.js 的 COPY_FILES 扣掉 settings.json（那份是專案自己的值、不在清單）。 */
const FINGERPRINT_SHARED = COPY_FILES.filter((p) => underShared(p));
/** Codex 全域層的接線範本：改了要照 guard-copy.js 檔頭⓪〜⑥重抽、重按信任（它不進指紋，所以另列）；跟 guard-copy.js 的 TEMPLATE_REL 同一個，考題釘著。 */
const CODEX_TEMPLATE = 'templates/hook-codex-global.json';
const HEX40 = /^[0-9a-f]{40}$/u;
const REPO = /^[^\s/]+\/[^\s/]+$/u;
const MODES = new Set(['100644', '100755', '120000']);
const LINE_BREAK = /[\n\r\u0085\u2028\u2029\v\f]/u;
const USAGE = `用法：node tools/kit-lock.js --check
      node tools/kit-lock.js --write --kit <本機套件倉庫的路徑> --version <套件版本碼> [--repo <帳號/倉庫名>] [--date YYYY-MM-DD]
（--root <目錄>：考題用，指定哪一棵樹；預設是這支工具所在的那棵樹）`;

/** 清單或環境的問題（不在、壞掉、形狀不對、git 起不來、版本找不到、工作樹跟套件對不上又沒例外）：一律不猜、退 2。 */
class LockError extends Error {}

function underShared(rel) {
  return SHARED_PATHS.some((s) => rel === s || rel.startsWith(`${s}/`));
}

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new LockError(`git 起不來：${r.error.message}`);
  if (r.status !== 0) throw new LockError(`git ${args[0]} 退 ${r.status}：${(r.stderr || '').trim() || '（沒有訊息）'}`);
  return r.stdout;
}

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 共用路徑底下工作樹上的每一個路徑：已追蹤＋未追蹤但沒被忽略（被忽略的看不到）；排序、去重。 */
function sharedFiles(root) {
  const present = SHARED_PATHS.filter((p) => fs.existsSync(path.join(root, p)));
  if (!present.length) return [];
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...present]);
  const rels = [...new Set(out.split('\0').filter(Boolean))].sort();
  for (const rel of rels) {
    if (LINE_BREAK.test(rel)) throw new LockError(`${JSON.stringify(rel)}：檔名含換行，清單不收`);
  }
  return rels;
}

/** 工作樹現況：每個共用檔的 {mode, blob, path}；索引裡有、工作樹上沒有的檔不進來（compare 會列成少掉）。 */
function entries(root = ROOT) {
  const rels = sharedFiles(root);
  const stats = rels.map((rel) => { try { return fs.lstatSync(path.join(root, rel)); } catch { return null; } });
  stats.forEach((st, i) => {
    if (st && st.isDirectory()) throw new LockError(`${rels[i]}：共用路徑底下有子模組或巢狀倉庫，清單不收`);
    if (st && !st.isFile() && !st.isSymbolicLink()) throw new LockError(`${rels[i]}：不是一般檔案也不是連結，清單不收`);
  });
  const regular = rels.filter((rel, i) => stats[i] && stats[i].isFile());
  const hashes = regular.length ? git(root, ['hash-object', '--stdin-paths'], `${regular.join('\n')}\n`).trim().split('\n') : [];
  if (hashes.length !== regular.length) throw new LockError(`git hash-object 回了 ${hashes.length} 個雜湊、要 ${regular.length} 個`);
  const blobOf = new Map(regular.map((rel, i) => [rel, hashes[i]]));
  const out = [];
  rels.forEach((rel, i) => {
    const st = stats[i];
    if (!st) return;
    if (st.isSymbolicLink()) {
      out.push({ mode: '120000', blob: git(root, ['hash-object', '--stdin'], fs.readlinkSync(path.join(root, rel))).trim(), path: rel });
      return;
    }
    // 跟 git 一樣只看擁有者的執行位元（0o100）
    out.push({ mode: (st.mode & 0o100) ? '100755' : '100644', blob: blobOf.get(rel), path: rel });
  });
  return out;
}

/** 套件那一版的共用檔（清單內容的唯一來源）：版本在本機套件倉庫找不到＝退 2。 */
function kitEntries(kit, version) {
  if (typeof version !== 'string' || !/^[0-9a-f]{7,40}$/u.test(version)) throw new LockError('--version 要給套件的版本碼（7〜40 位小寫十六進位）');
  if (typeof kit !== 'string' || !fs.existsSync(kit)) throw new LockError('--write 要給 --kit <本機套件倉庫的路徑>：清單的內容從套件那一版取，不從這棵樹抄');
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${version}^{commit}`], { cwd: kit, env: gitEnv(), encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new LockError(`本機套件倉庫（${kit}）裡找不到版本 ${version}：複本可能還沒 fetch（先 git -C <套件> fetch），或版本碼打錯`);
  const sha = r.stdout.trim();
  const out = git(kit, ['ls-tree', '-r', '-z', '--full-tree', sha, '--', ...SHARED_PATHS]);
  const list = out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' ');
    const rel = line.slice(tab + 1);
    if (type !== 'blob' || !MODES.has(mode)) throw new LockError(`套件 ${sha} 的 ${rel} 是 ${type}（${mode}）：清單只收一般檔案與連結`);
    return { mode, blob, path: rel };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
  if (!list.length) throw new LockError(`套件 ${sha} 在共用路徑底下一個檔都沒有：版本碼對嗎？`);
  return { sha, list };
}

function plain(value, what) {
  if (typeof value !== 'string' || value.trim() === '') throw new LockError(`${LOCK_FILE} 形狀不對：${what} 要是非空字串`);
  if (LINE_BREAK.test(value) || value !== value.trim()) throw new LockError(`${LOCK_FILE} 形狀不對：${what} 不可以有換行或前後空白`);
  return value;
}

function dateField(value, what) {
  if (!realDate(plain(value, what))) throw new LockError(`${LOCK_FILE} 形狀不對：${what} 要是真的日子（YYYY-MM-DD）`);
  return value;
}

function pathField(value, what) {
  plain(value, what);
  if (value.startsWith('/') || value.split('/').some((seg) => seg === '' || seg === '.' || seg === '..') || value.includes('\u0000')) {
    throw new LockError(`${LOCK_FILE} 形狀不對：${what}「${value}」不是正常的相對路徑`);
  }
  if (!underShared(value)) throw new LockError(`${LOCK_FILE} 形狀不對：${what}「${value}」不在共用路徑底下（${SHARED_PATHS.join('、')}）`);
  return value;
}

function exactKeys(obj, keys, what) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new LockError(`${LOCK_FILE} 形狀不對：${what} 要是物件`);
  const have = Object.keys(obj).sort().join(',');
  const want = [...keys].sort().join(',');
  if (have !== want) throw new LockError(`${LOCK_FILE} 形狀不對：${what} 的欄位要剛好是 ${keys.join('、')}（現在：${have || '（空）'}）`);
}

function sortedUnique(paths, what) {
  for (let i = 1; i < paths.length; i += 1) {
    if (!(paths[i - 1] < paths[i])) throw new LockError(`${LOCK_FILE} 形狀不對：${what} 要照路徑排序、不重複（「${paths[i - 1]}」之後是「${paths[i]}」）`);
  }
}

/** 清單的形狀，逐欄驗；驗不過就丟 LockError（不猜、不補）。 */
function validateLock(lock) {
  exactKeys(lock, ['repo', 'version', 'syncedAt', 'entries', 'exceptions'], '清單');
  if (!REPO.test(plain(lock.repo, 'repo'))) throw new LockError(`${LOCK_FILE} 形狀不對：repo 要是「帳號/倉庫名」`);
  if (!HEX40.test(plain(lock.version, 'version'))) throw new LockError(`${LOCK_FILE} 形狀不對：version 要是 40 位小寫十六進位的套件版本碼`);
  dateField(lock.syncedAt, 'syncedAt');
  if (!Array.isArray(lock.entries)) throw new LockError(`${LOCK_FILE} 形狀不對：entries 要是陣列`);
  if (!Array.isArray(lock.exceptions)) throw new LockError(`${LOCK_FILE} 形狀不對：exceptions 要是陣列`);
  lock.entries.forEach((e, i) => {
    exactKeys(e, ['mode', 'blob', 'path'], `entries[${i}]`);
    if (!MODES.has(e.mode)) throw new LockError(`${LOCK_FILE} 形狀不對：entries[${i}].mode「${e.mode}」不是 100644、100755 或 120000`);
    if (typeof e.blob !== 'string' || !HEX40.test(e.blob)) throw new LockError(`${LOCK_FILE} 形狀不對：entries[${i}].blob 要是 40 位小寫十六進位`);
    pathField(e.path, `entries[${i}].path`);
  });
  sortedUnique(lock.entries.map((e) => e.path), 'entries');
  lock.exceptions.forEach((x, i) => {
    exactKeys(x, ['path', 'why', 'who', 'since'], `exceptions[${i}]`);
    pathField(x.path, `exceptions[${i}].path`);
    plain(x.why, `exceptions[${i}].why`);
    plain(x.who, `exceptions[${i}].who`);
    dateField(x.since, `exceptions[${i}].since`);
  });
  sortedUnique(lock.exceptions.map((x) => x.path), 'exceptions');
  return lock;
}

function readLock(root = ROOT) {
  const file = path.join(root, LOCK_FILE);
  if (!fs.existsSync(file)) throw new LockError(`沒有 ${LOCK_FILE}：這棵樹沒帶共用檔清單（套件倉庫自己是上游；使用專案同步後跑 --write 建）`);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new LockError(`${LOCK_FILE} 讀不成 JSON：${e.message}`); }
  return validateLock(parsed);
}

/** 第一份對第二份：少掉、內容不同、權限不同、多出來；照路徑排序。 */
function compare(current, locked) {
  const cur = new Map(current.map((e) => [e.path, e]));
  const old = new Map(locked.map((e) => [e.path, e]));
  const diffs = [];
  for (const [p, e] of old) {
    const c = cur.get(p);
    if (!c) diffs.push({ path: p, kind: '少掉' });
    else if (c.blob !== e.blob) diffs.push({ path: p, kind: '內容不同' });
    else if (c.mode !== e.mode) diffs.push({ path: p, kind: '權限不同' });
  }
  for (const p of cur.keys()) if (!old.has(p)) diffs.push({ path: p, kind: '多出來' });
  return diffs.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function check(root = ROOT) {
  const lock = readLock(root);
  const current = entries(root);
  const diffs = compare(current, lock.entries);
  const excepted = new Set(lock.exceptions.map((x) => x.path));
  const differing = new Set(diffs.map((d) => d.path));
  const known = new Set([...current.map((e) => e.path), ...lock.entries.map((e) => e.path)]);
  const problems = [];
  for (const d of diffs) {
    if (!excepted.has(d.path)) {
      problems.push(`${d.path}：${d.kind}，清單裡沒有這一筆例外——套件的檔預設在套件改再同步；真的要在這裡先改，把它記進 ${LOCK_FILE} 的 exceptions（path、why、who、since），之後搬回套件`);
    }
  }
  for (const x of lock.exceptions) {
    if (differing.has(x.path)) continue;
    problems.push(known.has(x.path)
      ? `${x.path}：例外過期——這個檔已經跟清單一樣（搬回套件同步過了？），把這一筆例外拿掉`
      : `${x.path}：例外指到的檔不在工作樹、也不在清單（路徑打錯了？大小寫也算）`);
  }
  return { ok: problems.length === 0, problems, repo: lock.repo, version: lock.version, syncedAt: lock.syncedAt, count: lock.entries.length, diffs, exceptions: lock.exceptions };
}

const WRITE_KIND = { 多出來: '套件這一版新加', 少掉: '套件這一版刪掉', 內容不同: '內容不同', 權限不同: '權限不同' };
const STEP3 = '照 README「搬進一個專案」第 3 步：Claude 側＝④（同一支PR重印釘指紋那一行，合併後每台機器補複本、按測試鈕）；Codex 全域層＝⓪〜⑥（先關掉所有 Codex、重抽、按信任、按測試鈕）';

/** 同步完跑：清單內容從本機套件倉庫的那一版取；工作樹跟它不一樣又沒有例外＝拒寫。 */
function write(root = ROOT, { version, repo, date, kit } = {}) {
  const { sha, list } = kitEntries(kit, version);
  const file = path.join(root, LOCK_FILE);
  const previous = fs.existsSync(file) ? readLock(root) : null;
  const repoName = repo || (previous && previous.repo);
  if (typeof repoName !== 'string' || !REPO.test(repoName)) throw new LockError('第一次寫清單要給 --repo <帳號/倉庫名>');
  const syncedAt = date || localDate();
  if (!realDate(syncedAt)) throw new LockError('--date 要是真的日子（YYYY-MM-DD）');
  const drift = compare(entries(root), list);
  const prevEx = new Map((previous ? previous.exceptions : []).map((x) => [x.path, x]));
  const unexplained = drift.filter((d) => !prevEx.has(d.path));
  if (unexplained.length) {
    throw new LockError([
      `工作樹跟套件 ${sha} 有 ${unexplained.length} 個共用檔不一樣，上一份清單也沒記例外——沒寫清單：`,
      ...unexplained.map((d) => `  ・${d.path}：${d.kind}`),
      '同步要整批換：先刪掉共用路徑再解開套件那一版（git archive 只新增與覆蓋、不會刪）；真的是專案先改的，先把它記成例外再寫。',
    ].join('\n'));
  }
  const drifting = new Set(drift.map((d) => d.path));
  const kept = (previous ? previous.exceptions : []).filter((x) => drifting.has(x.path));
  const cleared = (previous ? previous.exceptions : []).filter((x) => !drifting.has(x.path));
  const lines = [];
  if (previous) {
    const changes = compare(list, previous.entries);
    lines.push(`跟上一份清單（${previous.version.slice(0, 7)}，${previous.syncedAt}）比：套件這一版有 ${changes.length} 個共用檔不一樣`);
    for (const d of changes) lines.push(`  ・${d.path}：${WRITE_KIND[d.kind]}`);
  } else {
    lines.push(`第一次寫清單：套件 ${sha.slice(0, 7)} 有 ${list.length} 個共用檔`);
  }
  lines.push(`提醒（固定）：這支同步若動到 ${[...FINGERPRINT_SHARED, 'settings.json 的 forbidden 那一塊', CODEX_TEMPLATE].join('、')} 任一樣，合併後要換複本、重按信任——${STEP3}；這次有沒有動到，看這支 PR 對主幹的 git diff`);
  if (kept.length) lines.push(`例外保留 ${kept.length} 筆（工作樹仍跟套件這一版不同）：${kept.map((x) => `${x.path}（${x.who}）`).join('、')}`);
  if (cleared.length) lines.push(`例外清掉 ${cleared.length} 筆（工作樹已跟套件這一版相同）：${cleared.map((x) => x.path).join('、')}——改動若還沒搬回套件，就是在這次同步被換掉了，看 git diff 確認`);
  const lock = validateLock({ repo: repoName, version: sha, syncedAt, entries: list, exceptions: kept });
  fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  lines.push(`寫好 ${LOCK_FILE}：套件 ${repoName} ${sha}（${syncedAt}），${list.length} 筆、例外 ${kept.length} 筆`);
  return { lock, lines };
}

/** 帶不帶只看設定的登記；清單在不在只拿來對帳（跟案例簿那一列同一種開關）。 */
function declaration(machines, lockPresent) {
  const rows = Array.isArray(machines) ? machines.filter((m) => m && m.name === MACHINE) : [];
  if (rows.length !== 1) return { run: true, problem: `機器表裡「${MACHINE}」要剛好一列（現在 ${rows.length} 列）`, reason: null };
  const { state } = rows[0];
  if (state === '已啟用') {
    return lockPresent ? { run: true, problem: null, reason: null }
      : { run: true, problem: `「${MACHINE}」登記已啟用，${LOCK_FILE} 卻不在：同步後跑 node tools/kit-lock.js --write --kit <本機套件倉庫> --version <套件版本碼> --repo <帳號/倉庫名> 建清單；不帶清單就把這一列改回已安裝未啟用`, reason: null };
  }
  if (state === '已安裝未啟用') {
    return lockPresent ? { run: true, problem: `「${MACHINE}」登記已安裝未啟用，${LOCK_FILE} 卻在：清單建好了就把這一列改成已啟用（改完跑 node tools/build-settings.js）`, reason: null }
      : { run: false, problem: null, reason: `settings.json 把「${MACHINE}」登記成已安裝未啟用（還沒建清單），${LOCK_FILE} 也確實不在` };
  }
  if (state === '未移植') {
    return lockPresent ? { run: true, problem: `「${MACHINE}」登記未移植，${LOCK_FILE} 卻在：套件倉庫自己是上游、不帶清單；使用專案要帶就改登記已啟用`, reason: null }
      : { run: false, problem: null, reason: `settings.json 把「${MACHINE}」登記成未移植（套件倉庫自己是上游，沒有清單），${LOCK_FILE} 也確實不在` };
  }
  return { run: true, problem: `「${MACHINE}」只能登記已啟用、已安裝未啟用或未移植，現在是「${state}」`, reason: null };
}

function parseArgs(argv) {
  const out = { mode: null, version: null, repo: null, date: null, kit: null, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new LockError(`${a} 後面要接值`); return argv[i]; };
    if (a === '--check' || a === '--write') { if (out.mode) throw new LockError('--check 與 --write 只能給一個'); out.mode = a.slice(2); }
    else if (a === '--version') out.version = next();
    else if (a === '--repo') out.repo = next();
    else if (a === '--date') out.date = next();
    else if (a === '--kit') out.kit = next();
    else if (a === '--root') out.root = next();
    else throw new LockError(`看不懂的參數：${a}`);
  }
  if (!out.mode) throw new LockError('要給 --check 或 --write');
  if (out.mode === 'check') {
    const extra = ['version', 'repo', 'date', 'kit'].filter((k) => out[k] !== null);
    if (extra.length) throw new LockError(`--check 不收 ${extra.map((k) => `--${k}`).join('、')}（那是 --write 用的）`);
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  let a;
  try { a = parseArgs(argv); } catch (e) { return { code: 2, lines: [e.message, USAGE] }; }
  const root = a.root ? path.resolve(a.root) : ROOT;
  try {
    if (a.mode === 'write') return { code: 0, lines: write(root, { ...a, kit: a.kit && path.resolve(a.kit) }).lines };
    const r = check(root);
    const lines = [`共用檔清單｜套件 ${r.repo} ${r.version.slice(0, 7)}（${r.syncedAt}）：${r.count} 筆；工作樹跟清單不一樣的 ${r.diffs.length} 個、例外 ${r.exceptions.length} 筆`];
    for (const x of r.exceptions) lines.push(`  例外：${x.path}（${x.who}，${x.since} 起）：${x.why}`);
    if (r.ok) { lines.push(r.diffs.length ? '不一樣的每一個都有例外對上。' : '全部相同。'); return { code: 0, lines }; }
    for (const p of r.problems) lines.push(`  ・${p}`);
    return { code: 1, lines };
  } catch (e) {
    // 1 只留給「工作樹跟清單對不上」；其餘一律退 2（清單或環境的問題，不猜）
    if (e instanceof LockError) return { code: 2, lines: [e.message] };
    return { code: 2, lines: [`共用檔清單：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——算不出來`] };
  }
}

if (require.main === module) {
  const r = main();
  process.stdout.write(`${r.lines.join('\n')}\n`);
  process.exit(r.code);
}

module.exports = { LOCK_FILE, MACHINE, SHARED_PATHS, underShared, FINGERPRINT_SHARED, CODEX_TEMPLATE, LockError, entries, kitEntries, readLock, validateLock, compare, check, write, declaration, parseArgs, main };
