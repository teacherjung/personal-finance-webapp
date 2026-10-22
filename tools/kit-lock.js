// 共用檔清單（釘住套件版本）：使用專案根目錄一份 kit-lock.json，記下同步時取的是套件哪一版、那一版每個共用檔的權限＋blob＋路徑。
// 協作套件的檔只在套件改（規矩 D5）：使用專案不改、不刪，也不在共用路徑底下加檔；要改就去套件改，合併後整批同步回來。
//
// 為什麼（擁有者 2026-10-15 裁 A：「一律不能改，沒有例外」）：原專案 #641 在專案就地改了 6 個共用檔、PR 說明與留言沒有一處提到套件，
//   兩邊約 34 小時內容不同；#643 標題是同步、實際逐段挑著搬，做出套件從沒有過的版本。2026-09-29 立的「先在專案改要記例外」從沒被用過，
//   2026-10-14 隔離重現又量到它的洞：記了例外再照舊法整批覆蓋、跑 --write，專案的改動被換掉、例外被清掉，--check 照樣全綠。
// 為什麼同步改成一個指令（--sync），不再是「手動刪檔解包、事後 --write」：事後寫清單時，覆蓋已經發生了，專案自己的改動在那之前就沒了；
//   要擋「覆蓋掉專案的改動」，檢查與換檔必須在同一個指令裡、檢查在任何刪除之前。預設只檢查（預演），加 --apply 才換檔。
// 為什麼同步前要分開查已提交、暫存區、工作樹、沒追蹤、被忽略：換檔會整個刪掉共用路徑；同步前確認這五處都跟清單一樣，
//   刪掉的東西已提交的版本（HEAD）都還有，換到一半失敗也能從 HEAD 整個還原。
// 為什麼還要查共用路徑的上一層是不是連結、裡面有沒有別的倉庫的 .git、大小寫不同的同名路徑、跳過工作樹的標記、專案會忽略的新檔、
//   新清單寫不寫得進去：這幾種 git 的路徑比對看不到，刪檔卻會穿過去或碰到，或換到一半才失敗（2026-10-15 送審前自審與 #106 r1 複審
//   實際重現：上一層是連結時刪到連結目標裡專案自己的檔、已追蹤的資料夾裡另開的倉庫被整個刪掉，都還原不回來）。
// 為什麼要核清單出自套件（雙向、用套件舊版自己的共用路徑）、兩個版本都在套件主幹上、只往前、跑的是那一版的工具：清單可以被手改
//   （絆線不是鎖），手改過的清單（改一筆或少一筆）會讓「專案改過的」看起來沒改；沒審過的本機提交不該被同步進專案；往回同步會把
//   錢的攔截器換回舊版；共用路徑（SHARED_PATHS）寫在這支工具裡、各版可能不同，用別版的工具同步，換的範圍就跟那一版對不上。
//
// 守到哪裡（tests/kit-lock.test.js 釘）：--check 拿清單每一筆跟工作樹比權限＋blob，多出來、少掉、改內容、改權限各自紅並指名路徑；
//   清單不在、壞掉或形狀不對、舊格式留下的例外段還有內容、git 失敗＝退 2（不猜）。
//   --sync：上面那些全部成立才換；任何一樣不成立＝退 1、一個檔都不動、清單不動。--apply 換完再比一次工作樹＝套件新那一版，
//   對不上、刪檔解包失敗、或換完寫清單失敗＝退 2 並印照貼就能跑的還原指令（路徑有空白、$、單引號也照字面）。
//   --write：只用在第一次裝（工作樹上、或這棵樹的歷史裡出現過清單＝拒寫），工作樹要剛好等於套件那一版。
//   --touch：列出給的路徑裡哪些落在共用路徑（大小寫不分、../ 與 ./ 先整理），命中退 1；只列，沒接進任何閘。
//   --sync、--write 每次都印一行固定提醒：攔截器相關的 5 樣，動到任一樣合併後要換複本、重按信任；
//   --sync 另在有命中時印三種非阻擋預檢提醒（只提醒不擋）：①同一倉庫其他工作樹有未提交改動或尚未併入目前 HEAD 的提交、
//   ②套件這一版刪掉的共用檔仍被專案自己的追蹤檔引用、③套件這一版改動的範本在專案裡有對應抄出去的檔案（COPIED_TEMPLATES）。
// 為什麼攔截器提醒是固定的一行、不判斷這次動到沒有（擁有者 2026-09-29 裁 a）：複審 r1〜r4 連四輪在「自動判斷動到沒有」這一族抓到問題
//   （推算與直接量各有漏的情境）；原專案的釘指紋等式題在指紋變了卻沒重印那一行時本來就會紅。這次要不要換，由實作者看這支 PR 對主幹的差異告訴擁有者。
// ⚠️ 擋不住的：同一支 PR 連清單、這支工具或考題一起改（絆線不是鎖；改動留在 diff 裡給複審者看）；
//   --check 不驗清單裡的版本碼與 blob 真的出自套件（使用專案的雲端讀不到私有的套件；--sync、--write 那一刻有驗，之後手改清單就只剩複審）；
//   不走 --sync、自己動手刪檔解包（有寫入權限就做得到，這不是作業系統的防寫）；--sync 檢查之後、換檔之前另一個行程改了共用路徑
//   （檢查與換檔之間只隔套件的打包）；別台電腦上還沒推的改動（本機同一倉庫其他工作樹只印提醒不擋）；套件那邊有沒有新的（要讀得到套件）；
//   套件主幹只認本機套件倉庫的 origin 遠端與那一版設定裡的主幹名（存心造一條假遠端分支擋不住）；
//   --check 看不到被 .gitignore 忽略的檔、大小寫不同的同名路徑（--sync 看得到）；SHARED_PATHS 以外的檔（COPIED_TEMPLATES 以外或只印提醒未人工對照的）；
//   退場共用檔若用動態拼接路徑引用則字面搜尋看不到；
//   settings.json（專案自己的值，連同 forbidden 那一塊都不在清單）；--touch 只看給它的路徑，專案裡指進共用路徑的連結看不到；
//   git 看不到的東西（空資料夾、FIFO）換檔時會一起刪；共用範圍縮小的那一版（舊清單有現在工具不認的路徑）要另寫遷移，現在會退 2；
//   各機器換行轉換或 filter 設定不同時，blob 可能對不上（假紅；套件共用檔目前沒有 CR、也沒有 .gitattributes）；
//   權限照磁碟判（擁有者的執行位元，跟 git 一樣），不看 core.fileMode；--check 分不出「專案多改了」還是「套件有新的沒跟上」。
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
const MACHINE = '共用檔清單（釘住套件版本；套件的檔只在套件改，同步前先查專案有沒有自己改過）';
/**
 * 共用檔＝README「搬進一個專案」第 1 步要取的路徑。README 那一步另列了一份給人看，兩份沒有考題比對：改一邊要同一支改另一邊。
 * ⚠️ 這一行的寫法要維持一行、單引號：--sync 從套件舊版的這支工具用 sharedPathsIn 讀它（考題釘著）。
 */
const SHARED_PATHS = ['tools', 'tests', 'templates', 'rules.json', 'RULES.md', 'MACHINES.md', 'GLOSSARY.md', 'docs/money-guard-two-pattern-tables.md', 'cases/DIGEST.md'];
/** 這支工具在套件裡的路徑：--sync、--write 要核跑的這一份跟套件那一版的同一個檔一樣。 */
const SELF_REL = 'tools/kit-lock.js';
/** 進錢的攔截器指紋的共用檔＝guard-copy.js 的 COPY_FILES 扣掉 settings.json（那份是專案自己的值、不在清單）。 */
const FINGERPRINT_SHARED = COPY_FILES.filter((p) => underShared(p));
/** Codex 全域層的接線範本：改了要照 guard-copy.js 檔頭⓪〜⑥重抽、重按信任（它不進指紋，所以另列）；跟 guard-copy.js 的 TEMPLATE_REL 同一個，考題釘著。 */
const CODEX_TEMPLATE = 'templates/hook-codex-global.json';
const HEX40 = /^[0-9a-f]{40}$/u;
const REPO = /^[^\s/]+\/[^\s/]+$/u;
const MODES = new Set(['100644', '100755', '120000']);
const LINE_BREAK = /[\n\r\u0085\u2028\u2029\v\f]/u;
const BIG = 256 * 1024 * 1024;
const USAGE = `用法：node tools/kit-lock.js --check
      node tools/kit-lock.js --touch [<要改的路徑>…]
      node <套件>/tools/kit-lock.js --sync --root <使用專案的根目錄> --kit <套件> --version <套件版本碼> [--apply] [--repo <帳號/倉庫名>] [--date YYYY-MM-DD]
      node tools/kit-lock.js --write --kit <本機套件倉庫的路徑> --version <套件版本碼> --repo <帳號/倉庫名> [--date YYYY-MM-DD]（只用在第一次裝）
（--root <目錄>：指定哪一棵樹；預設是這支工具所在的那棵樹）`;

/** 清單或環境的問題（不在、壞掉、形狀不對、git 起不來、版本找不到或不在主幹上、工作樹跟套件對不上）：一律不猜、退 2。 */
class LockError extends Error {}

function underShared(rel, paths = SHARED_PATHS) {
  return paths.some((s) => rel === s || rel.startsWith(`${s}/`));
}

/** 大小寫不分時落在共用路徑上（大小寫不分的磁碟上 Tools/a.js 就是 tools/a.js）。 */
function underSharedFolded(rel) {
  const l = rel.toLowerCase();
  return SHARED_PATHS.some((s) => { const k = s.toLowerCase(); return l === k || l.startsWith(`${k}/`); });
}

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new LockError(`git 起不來：${r.error.message}`);
  if (r.status !== 0) throw new LockError(`git ${args[0]} 退 ${r.status}：${(r.stderr || '').trim() || '（沒有訊息）'}`);
  return r.stdout;
}

/** 回 true／false 的 git（merge-base --is-ancestor、cat-file -e 這類）：退 0＝是、退 1＝不是，其餘＝退 2。 */
function gitYes(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
  if (r.error) throw new LockError(`git 起不來：${r.error.message}`);
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new LockError(`git ${args[0]} 退 ${r.status}：${(r.stderr || '').trim() || '（沒有訊息）'}`);
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

/** git ls-tree -r -z 的輸出 → [{mode, blob, path}]；子模組（gitlink）或別的型別＝退 2。where 只用在訊息。 */
function parseTree(out, where) {
  return out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' ');
    const rel = line.slice(tab + 1);
    if (type !== 'blob' || !MODES.has(mode)) throw new LockError(`${where}的 ${rel} 是 ${type}（${mode}）：清單只收一般檔案與連結`);
    if (LINE_BREAK.test(rel)) throw new LockError(`${where}的 ${JSON.stringify(rel)}：檔名含換行，清單不收`);
    return { mode, blob, path: rel };
  }).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** 版本碼 → 完整的提交碼；本機套件倉庫找不到＝退 2。 */
function resolveKit(kit, version) {
  if (typeof version !== 'string' || !/^[0-9a-f]{7,40}$/u.test(version)) throw new LockError('--version 要給套件的版本碼（7〜40 位小寫十六進位）');
  if (typeof kit !== 'string' || !fs.existsSync(kit)) throw new LockError('要給 --kit <本機套件倉庫的路徑>：清單的內容從套件那一版取，不從這棵樹抄');
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${version}^{commit}`], { cwd: kit, env: gitEnv(), encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new LockError(`本機套件倉庫（${kit}）裡找不到版本 ${version}：複本可能還沒 fetch（先 git -C <套件> fetch），或版本碼打錯`);
  return r.stdout.trim();
}

/** 套件某一版的這支工具裡寫的共用路徑（那一版的範圍）：從那一行 `const SHARED_PATHS = [...]` 讀；讀不到＝退 2。 */
function sharedPathsIn(source, where) {
  const m = /^const SHARED_PATHS = \[([^\]\n]*)\];$/mu.exec(source);
  const items = m ? m[1].split(',').map((x) => x.trim()) : [];
  if (!m || !items.length || items.some((x) => !/^'[^'\\]+'$/u.test(x))) throw new LockError(`${where}的 ${SELF_REL} 讀不出 SHARED_PATHS 那一行：不是這支工具認得的套件版本`);
  return items.map((x) => x.slice(1, -1));
}

/** 套件那一版的共用檔（清單內容的唯一來源）；scope＝要列的共用路徑（預設是這支工具的）。 */
function kitEntries(kit, version, scope = SHARED_PATHS) {
  const sha = resolveKit(kit, version);
  const list = parseTree(git(kit, ['ls-tree', '-r', '-z', '--full-tree', sha, '--', ...scope]), `套件 ${sha}`);
  if (!list.length) throw new LockError(`套件 ${sha} 在共用路徑底下一個檔都沒有：版本碼對嗎？`);
  return { sha, list };
}

/** 套件主幹：origin/<那一版設定裡的 mainBranch>（從那一版已提交的 settings.json 讀，不讀工作樹）；本機沒有那個遠端分支＝退 2。 */
function kitMain(kit, sha) {
  let main;
  try { main = JSON.parse(git(kit, ['show', `${sha}:settings.json`])).mainBranch; } catch (e) { throw new LockError(`讀不到套件 ${sha.slice(0, 7)} 的 settings.json（要它的 mainBranch 才知道主幹叫什麼）：${e.message}`); }
  if (typeof main !== 'string' || !/^[^\s~^:?*[\\]+$/u.test(main)) throw new LockError(`套件 ${sha.slice(0, 7)} 的 settings.json 的 mainBranch 不是分支名`);
  const ref = `refs/remotes/origin/${main}`;
  if (!gitYes(kit, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) throw new LockError(`本機套件倉庫沒有 origin/${main}：先 git -C <套件> fetch，再重跑`);
  return { main, ref };
}

/**
 * 要同步進專案的那一版：除了 kitEntries，還要在套件主幹上，而且跑的這支工具＝那一版的 tools/kit-lock.js
 * （共用路徑寫在工具裡，用別版的工具同步，換的範圍就跟那一版對不上）。回 { sha, list, main, ref }。
 */
function kitVersion(kit, version) {
  const got = kitEntries(kit, version);
  const { main, ref } = kitMain(kit, got.sha);
  if (!gitYes(kit, ['merge-base', '--is-ancestor', got.sha, ref])) throw new LockError(`套件版本 ${got.sha.slice(0, 7)} 不在套件主幹（origin/${main}）上：只同步合併過的版本；剛合併的先 git -C <套件> fetch 再重跑`);
  const self = got.list.find((e) => e.path === SELF_REL);
  if (!self) throw new LockError(`套件 ${got.sha.slice(0, 7)} 沒有 ${SELF_REL}：不是這支工具認得的套件版本`);
  const mine = git(kit, ['hash-object', '--', __filename]).trim();
  if (mine !== self.blob) throw new LockError(`跑的這一份 ${SELF_REL} 跟套件 ${got.sha.slice(0, 7)} 那一版的不一樣：用套件那一版的工具跑（node <套件>/tools/kit-lock.js …，套件那棵樹要在這一版、而且這個檔沒改過）`);
  return { ...got, main, ref };
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

function exactKeys(obj, keys, what, optional = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new LockError(`${LOCK_FILE} 形狀不對：${what} 要是物件`);
  const have = Object.keys(obj).filter((k) => !optional.includes(k)).sort().join(',');
  const want = [...keys].sort().join(',');
  if (have !== want) throw new LockError(`${LOCK_FILE} 形狀不對：${what} 的欄位要剛好是 ${keys.join('、')}（現在：${have || '（空）'}）`);
}

function sortedUnique(paths, what) {
  for (let i = 1; i < paths.length; i += 1) {
    if (!(paths[i - 1] < paths[i])) throw new LockError(`${LOCK_FILE} 形狀不對：${what} 要照路徑排序、不重複（「${paths[i - 1]}」之後是「${paths[i]}」）`);
  }
}

/**
 * 清單的形狀，逐欄驗；驗不過就丟 LockError（不猜、不補）。
 * exceptions：2026-10-15 以前寫的清單都帶這一欄；空陣列照收（下一次 --sync 寫的清單就沒有這一欄），有內容＝例外已取消、退 2。
 */
function validateLock(lock) {
  exactKeys(lock, ['repo', 'version', 'syncedAt', 'entries'], '清單', ['exceptions']);
  if (!REPO.test(plain(lock.repo, 'repo'))) throw new LockError(`${LOCK_FILE} 形狀不對：repo 要是「帳號/倉庫名」`);
  if (!HEX40.test(plain(lock.version, 'version'))) throw new LockError(`${LOCK_FILE} 形狀不對：version 要是 40 位小寫十六進位的套件版本碼`);
  dateField(lock.syncedAt, 'syncedAt');
  if (!Array.isArray(lock.entries)) throw new LockError(`${LOCK_FILE} 形狀不對：entries 要是陣列`);
  lock.entries.forEach((e, i) => {
    exactKeys(e, ['mode', 'blob', 'path'], `entries[${i}]`);
    if (!MODES.has(e.mode)) throw new LockError(`${LOCK_FILE} 形狀不對：entries[${i}].mode「${e.mode}」不是 100644、100755 或 120000`);
    if (typeof e.blob !== 'string' || !HEX40.test(e.blob)) throw new LockError(`${LOCK_FILE} 形狀不對：entries[${i}].blob 要是 40 位小寫十六進位`);
    pathField(e.path, `entries[${i}].path`);
  });
  sortedUnique(lock.entries.map((e) => e.path), 'entries');
  if ('exceptions' in lock) {
    if (!Array.isArray(lock.exceptions)) throw new LockError(`${LOCK_FILE} 形狀不對：exceptions（舊格式留下的欄）要是空陣列`);
    if (lock.exceptions.length) {
      throw new LockError(`${LOCK_FILE} 的 exceptions 還有 ${lock.exceptions.length} 筆：例外已經取消（擁有者 2026-10-15，規矩 D5）——協作套件的檔只在套件改。先把這些改動搬到套件（或在這裡改回清單那一版），再把這一欄拿掉`);
    }
  }
  return lock;
}

function readLock(root = ROOT) {
  const file = path.join(root, LOCK_FILE);
  if (!fs.existsSync(file)) throw new LockError(`沒有 ${LOCK_FILE}：這棵樹沒帶共用檔清單（套件倉庫自己是上游；使用專案第一次裝跑 --write 建）`);
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

const CHECK_FIX = '協作套件的檔只在套件改（規矩 D5）：在這裡改回清單那一版（改過的從主幹取回、多出來的移出共用路徑、少掉的補回），要改就去套件改、合併後用 --sync 整批同步回來；改完重跑 node tools/kit-lock.js --check';

function check(root = ROOT) {
  const lock = readLock(root);
  const diffs = compare(entries(root), lock.entries);
  const problems = diffs.map((d) => `${d.path}：${d.kind}`);
  return { ok: problems.length === 0, problems, fix: CHECK_FIX, repo: lock.repo, version: lock.version, syncedAt: lock.syncedAt, count: lock.entries.length, diffs };
}

/** --touch 的路徑：反斜線當斜線、先整理 ./ 與 ../；絕對路徑、跑出專案、空的、含換行、git 加了引號的＝退 2。回整理過的相對路徑。 */
function normalizeTouch(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\u0000') || LINE_BREAK.test(raw)) throw new LockError(`--touch 的路徑不能是空的或含換行：${JSON.stringify(raw)}`);
  if (raw.startsWith('"')) throw new LockError(`--touch 的路徑看起來是 git 加了引號、把中文寫成 \\ooo 的那種：用 git -c core.quotepath=false 重列一次再給：${raw}`);
  const s = raw.replace(/\\/gu, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/u.test(s)) throw new LockError(`--touch 要給相對於專案根目錄的路徑：${raw}`);
  const n = path.posix.normalize(s).replace(/\/+$/u, '');
  if (n === '.' || n === '' || n === '..' || n.startsWith('../')) throw new LockError(`--touch 的路徑要落在專案裡、而且是具體的檔或資料夾：${raw}`);
  return n;
}

/** 落在共用路徑上嗎：大小寫不分；給的是資料夾、裡面有共用路徑也算。 */
function touchesShared(rel) {
  const l = rel.toLowerCase();
  return underSharedFolded(rel) || SHARED_PATHS.some((s) => s.toLowerCase().startsWith(`${l}/`));
}

/** 開工時：這一支打算改的路徑，哪些是協作套件的檔、哪些是清單本身（只由 --sync／--write 寫）、哪些是專案自己的。 */
function touch(paths) {
  const list = paths.map(normalizeTouch);
  const isLock = (p) => p.toLowerCase() === LOCK_FILE;
  return { shared: list.filter(touchesShared), lock: list.filter(isLock), own: list.filter((p) => !touchesShared(p) && !isLock(p)) };
}

/** 已提交的那一份（HEAD）在共用路徑底下的檔。 */
function headEntries(root) {
  return parseTree(git(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD', '--', ...SHARED_PATHS]), '這棵樹已提交的版本');
}

const STATUS_WHAT = { '??': '沒追蹤的檔', '!!': '被忽略的檔（.gitignore、.git/info/exclude 或全域忽略；例如系統產生的 .DS_Store）' };

/** 共用路徑底下還沒提交的東西：暫存區或工作樹有改、沒追蹤、被忽略，各一行。 */
function uncommitted(root) {
  const out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', ...SHARED_PATHS]).split('\0');
  const found = [];
  for (let i = 0; i < out.length; i += 1) {
    const rec = out[i];
    if (!rec) continue;
    const xy = rec.slice(0, 2);
    const rel = rec.slice(3);
    if (/[RC]/u.test(xy)) i += 1;   // 改名與複製後面多一段原路徑
    const what = STATUS_WHAT[xy] || `還沒提交的改動（git status：${xy.replace(/ /gu, '·')}）`;
    found.push({ path: rel, what });
  }
  return found;
}

/** 共用路徑的上一層（資料夾那幾段）是連結或不是資料夾：刪檔會穿過連結刪到別處。回每一處一行。 */
function parentHazards(root) {
  const out = [];
  for (const p of SHARED_PATHS) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i += 1) {
      const rel = segs.slice(0, i).join('/');
      let st;
      try { st = fs.lstatSync(path.join(root, rel)); } catch { break; }
      if (st.isSymbolicLink() || !st.isDirectory()) { out.push(`${rel}：是${st.isSymbolicLink() ? '連結' : '檔案、不是資料夾'}，共用路徑 ${p} 在它底下——換檔會穿過它刪到別處，先改回一般資料夾`); break; }
    }
  }
  return out;
}

/**
 * 名字在某種磁碟上會被 git 當成 .git：大小寫不分（.GIT）、Mac 會略過的看不見字元、Windows 會去掉的結尾點與空白、Windows 的短檔名（GIT~1）。
 * 寧可多擋：r2 複審實際重現大小寫不分的磁碟上 .GIT 照樣是倉庫紀錄，r1 修的只比小寫。
 */
const IGNORABLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu;
function gitLikeName(name) {
  const n = name.replace(IGNORABLE, '').toLowerCase().replace(/[. ]+$/u, '');
  return n === '.git' || /^git~\d+$/u.test(n);
}

/**
 * 共用路徑底下（不跟著連結走）任何一層名字像 .git 的資料夾或檔：另一個倉庫的紀錄。外層 git 的 status、ls-files 都不列它，
 * 換檔卻會整個刪掉，而且不在 HEAD 裡、還原不回來（2026-10-15 #106 r1、r2 複審實際重現：已追蹤的 tools/ 裡另開倉庫）。
 */
function nestedGit(root) {
  const out = [];
  const walk = (rel) => {
    let st;
    try { st = fs.lstatSync(path.join(root, rel)); } catch { return; }
    if (gitLikeName(path.posix.basename(rel))) { out.push(rel); return; }
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    for (const name of fs.readdirSync(path.join(root, rel))) walk(`${rel}/${name}`);
  };
  for (const p of SHARED_PATHS) walk(p);
  return out.sort();
}

/** 新清單寫得進去嗎：先寫同一層的暫存檔再整個換上去，要的是專案根目錄可寫（換完才發現寫不進去就來不及了）。 */
function lockWritable(root) {
  try { fs.accessSync(root, fs.constants.W_OK); return true; } catch { return false; }
}

/**
 * 寫清單：先在同一層寫好暫存檔、再一次換名蓋上去。寫到一半失敗時正式清單還是原來那一份、暫存檔清掉
 * （#106 r2 複審實際重現：直接覆寫時寫到一半失敗，清單被截斷、還原指令又不含它）。
 */
function saveLockFile(root, lock) {
  const file = path.join(root, LOCK_FILE);
  const tmp = path.join(root, `.${LOCK_FILE}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉就留著：它不在共用路徑、也不是清單本身 */ }
    throw e;
  }
}

/** 大小寫不同、但在大小寫不分的磁碟上就是共用路徑的那些路徑（已提交、暫存、沒追蹤、被忽略都算）：換檔會一起刪掉。 */
function caseTwins(root) {
  const head = git(root, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', 'HEAD']).split('\0');
  const work = git(root, ['ls-files', '-z', '--cached', '--others', '--', ...SHARED_PATHS.map((p) => `:(icase)${p}`)]).split('\0');
  return [...new Set([...head, ...work])].filter((p) => p && underSharedFolded(p) && !underShared(p)).sort();
}

/** 共用路徑底下標了跳過工作樹或假設沒改的檔：git 看不到它們的改動，換檔後也提交不進去。 */
function hiddenFlags(root) {
  return git(root, ['ls-files', '-v', '-z', '--', ...SHARED_PATHS]).split('\0').filter(Boolean)
    .filter((rec) => rec[0] === 'S' || /[a-z]/u.test(rec[0])).map((rec) => rec.slice(2)).sort();
}

/** 套件這一版要放進來、專案現在還沒追蹤、卻會被專案的忽略規則忽略的檔：解開後 git 看不到，換檔會停在半路。 */
function ignoredTargets(root, target, head) {
  const tracked = new Set(head.map((e) => e.path));
  const fresh = target.list.map((e) => e.path).filter((p) => !tracked.has(p));
  if (!fresh.length) return [];
  const r = spawnSync('git', ['check-ignore', '-z', '--no-index', '--stdin'], { cwd: root, env: gitEnv(), encoding: 'utf8', input: `${fresh.join('\0')}\0` });
  if (r.error) throw new LockError(`git 起不來：${r.error.message}`);
  if (r.status === 1) return [];
  if (r.status !== 0) throw new LockError(`git check-ignore 退 ${r.status}：${(r.stderr || '').trim() || '（沒有訊息）'}`);
  return r.stdout.split('\0').filter(Boolean).sort();
}

const SYNC_KIND = { 少掉: '少了這個檔', 內容不同: '內容跟清單不同', 權限不同: '權限跟清單不同', 多出來: '多出清單沒有的檔' };
const LOCK_KIND = { 少掉: '清單少列了這個檔', 內容不同: '內容跟清單記的不同', 權限不同: '權限跟清單記的不同', 多出來: '那一版沒有、清單卻列了' };

/**
 * 換檔之前的檢查。回不成立的每一條（空陣列＝可以換）；清單或環境的問題丟 LockError。
 * 清單出自套件：清單整份（不多不少）等於套件那一版在「那一版的共用路徑」底下的 ls-tree（版本在主幹上、在要同步那一版之前，sync 先核過）。
 */
function precheck(root, prev, prevSha, kit, target) {
  const problems = [];
  const short = prev.version.slice(0, 7);
  const oldScope = sharedPathsIn(git(kit, ['show', `${prevSha}:${SELF_REL}`]), `套件 ${short} `);
  const old = parseTree(git(kit, ['ls-tree', '-r', '-z', '--full-tree', prevSha, '--', ...oldScope]), `套件 ${prevSha}`);
  for (const d of compare(prev.entries, old)) problems.push(`${d.path}：${LOCK_KIND[d.kind]}——跟套件 ${short} 那一版對不上（清單被手改過？）`);
  problems.push(...parentHazards(root));
  for (const p of nestedGit(root)) problems.push(`${p}：共用路徑底下另有一個倉庫的 git 紀錄——外層 git 看不到它，換檔會整個刪掉、還原不回來；先搬出共用路徑`);
  if (!lockWritable(root)) problems.push(`${LOCK_FILE}：專案根目錄寫不進去（權限）——換完檔要在這裡寫新清單，先讓它寫得進去`);
  for (const p of caseTwins(root)) problems.push(`${p}：只差大小寫的同名路徑——在大小寫不分的磁碟上它就是共用路徑，換檔會一起刪掉`);
  for (const p of hiddenFlags(root)) problems.push(`${p}：標了跳過工作樹或假設沒改（git update-index），git 看不到它的改動——先拿掉標記（--no-skip-worktree／--no-assume-unchanged）`);
  const head = headEntries(root);
  for (const p of ignoredTargets(root, target, head)) problems.push(`${p}：套件這一版要放進來的檔，會被專案的忽略規則忽略——解開後 git 看不到、換檔會停在半路；先改專案的忽略規則`);
  for (const d of compare(head, prev.entries)) problems.push(`${d.path}：已提交的版本${SYNC_KIND[d.kind]}`);
  for (const u of uncommitted(root)) problems.push(`${u.path}：${u.what}`);
  for (const d of compare(entries(root), prev.entries)) problems.push(`${d.path}：工作樹上${SYNC_KIND[d.kind]}`);
  return [...new Set(problems)];
}

const WRITE_KIND = { 多出來: '套件這一版新加', 少掉: '套件這一版刪掉', 內容不同: '內容不同', 權限不同: '權限不同' };
const STEP3 = '照 README「搬進一個專案」第 3 步：Claude 側＝④（同一支PR重印釘指紋那一行，合併後每台機器補複本、按測試鈕）；Codex 全域層＝⓪〜⑥（先關掉所有 Codex、重抽、按信任、按測試鈕）';
const FIXED = `提醒（固定）：這支同步若動到 ${[...FINGERPRINT_SHARED, 'settings.json 的 forbidden 那一塊', CODEX_TEMPLATE].join('、')} 任一樣，合併後要換複本、重按信任——${STEP3}；這次有沒有動到，看這支 PR 對主幹的 git diff`;
const SYNC_STOP = '同步停下來了，一個檔都沒動、清單也沒動：上面這些會被整批換檔蓋掉、刪掉，或讓換檔停在半路（規矩 D5）。專案自己的改動先告訴擁有者：要留的先搬到協作套件、合併後再同步，不要的改回清單那一版（刪任何東西先問擁有者）；沒追蹤或被忽略的檔先移出共用路徑；連結、大小寫、標記、忽略規則照上面那一行說的改。改完重跑同一行 --sync';

/** 換到一半失敗時的還原：已提交的版本有的共用路徑從 HEAD 取回（git checkout 遇到 HEAD 沒有的路徑會退非零，所以只列有的），再清掉共用路徑底下多出來的。 */
function restoreCommands(previous) {
  const tracked = SHARED_PATHS.filter((p) => previous.entries.some((e) => e.path === p || e.path.startsWith(`${p}/`)));
  return [['checkout', 'HEAD', '--', ...tracked], ['clean', '-fdx', '--', ...SHARED_PATHS]];
}

/** 給 shell 的字：只有字母、數字與 _ / . , : = - 照原樣，其餘包單引號——裡面的 $、反引號、空白都照字面（JSON 的雙引號擋不住 shell 展開；#106 r1 複審抓到）。 */
const shellQuote = (s) => (/^[A-Za-z0-9_/.,:=-]+$/u.test(String(s)) ? String(s) : `'${String(s).replace(/'/gu, "'\\''")}'`);

/** 照貼就能跑的還原指令，一行一條。 */
function restoreLines(root, previous) {
  return restoreCommands(previous).map((args) => ['git', '-C', root, ...args].map(shellQuote).join(' '));
}

function restoreHint(root, previous) {
  return `工作樹已經動過。同步前已確認共用路徑底下的東西都跟已提交的版本一樣、也沒有沒追蹤或被忽略的檔，可以整個還原（在終端機照貼這兩行）：\n${restoreLines(root, previous).join('\n')}`;
}

/** 套件那一版共用路徑的 tar（只含那一版真的有的共用路徑；git archive 遇到不存在的路徑會退非零）。 */
function kitArchive(kit, target) {
  const present = SHARED_PATHS.filter((p) => target.list.some((e) => e.path === p || e.path.startsWith(`${p}/`)));
  const r = spawnSync('git', ['archive', '--format=tar', target.sha, '--', ...present], { cwd: kit, env: gitEnv(), maxBuffer: BIG });
  if (r.error) throw new LockError(`git 起不來：${r.error.message}`);
  if (r.status !== 0) throw new LockError(`git archive 退 ${r.status}：${String(r.stderr || '').trim() || '（沒有訊息）'}`);
  return r.stdout;
}

/** 整批換：先刪掉共用路徑（git archive 只新增與覆蓋、不會刪），再解開套件那一版，最後比一次工作樹＝那一版。 */
function replace(root, target, archive, previous) {
  const hazards = [...parentHazards(root), ...nestedGit(root).map((p) => `${p}：另一個倉庫的 git 紀錄`)];
  if (hazards.length) throw new LockError(`動手之前又查了一次，共用路徑不對（一個檔都還沒動）：${hazards.join('；')}`);
  try {
    for (const p of SHARED_PATHS) fs.rmSync(path.join(root, p), { recursive: true, force: true });
  } catch (e) {
    throw new LockError(`刪共用路徑時失敗（${(e && e.code) || (e && e.message) || '不明'}）。${restoreHint(root, previous)}`);
  }
  const r = spawnSync('tar', ['-x', '-f', '-', '-C', root], { input: archive, maxBuffer: BIG });
  if (r.error || r.status !== 0) throw new LockError(`解開套件那一版失敗（tar ${r.error ? r.error.message : `退 ${r.status}：${String(r.stderr || '').trim()}`}）。${restoreHint(root, previous)}`);
  const after = compare(entries(root), target.list);
  if (after.length) throw new LockError(`解開之後工作樹跟套件 ${target.sha.slice(0, 7)} 還有 ${after.length} 個對不上：${after.slice(0, 5).map((d) => `${d.path}：${d.kind}`).join('、')}。${restoreHint(root, previous)}`);
}

const COPIED_TEMPLATES = [
  { template: 'templates/ci-github.yml', target: '.github/workflows/ci.yml' },
  { template: 'templates/collab-fields-github.yml', target: '.github/workflows/collab-fields.yml' },
  { template: 'templates/pr-body.md', target: '.github/pull_request_template.md' },
  { template: 'templates/pre-push', target: '.githooks/pre-push' },
];

/** 同一倉庫其他工作樹衝突預檢（只提醒不擋）：列出有未提交改動或尚未併入目前 HEAD 的其他工作樹，防同步與其他 AI 工作線撞車。 */
function worktreeWarnings(root) {
  let rootReal;
  try { rootReal = fs.realpathSync(root); } catch { rootReal = path.resolve(root); }
  const blocks = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter((b) => b.replace(/\0/gu, '').trim());
  const items = [];
  for (const block of blocks) {
    const f = {};
    for (const l of block.split('\0').filter(Boolean)) {
      const i = l.indexOf(' ');
      if (i < 0) f[l] = true;
      else f[l.slice(0, i)] = l.slice(i + 1);
    }
    if (f.bare || typeof f.worktree !== 'string' || !f.worktree) continue;
    let wtReal;
    try { wtReal = fs.realpathSync(f.worktree); } catch { wtReal = path.resolve(f.worktree); }
    if (wtReal === rootReal || !fs.existsSync(f.worktree)) continue;
    const isUnborn = typeof f.HEAD === 'string' && /^0+$/u.test(f.HEAD);
    const label = typeof f.branch === 'string' && f.branch
      ? `分支 ${f.branch.replace(/^refs\/heads\//u, '')}${isUnborn ? '，尚無提交' : ''}`
      : `分離 HEAD ${typeof f.HEAD === 'string' && !isUnborn ? f.HEAD.slice(0, 7) : '不明'}`;
    const r = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: f.worktree, env: gitEnv(), encoding: 'utf8', maxBuffer: BIG });
    if (r.error || r.status !== 0) {
      items.push(`  ・工作樹 ${f.worktree}（${label}）：無法讀取狀態（git status 退 ${r.status ?? '錯誤'}）`);
      continue;
    }
    const recs = r.stdout.split('\0');
    const dirtyPaths = [];
    for (let i = 0; i < recs.length; i += 1) {
      const rec = recs[i];
      if (!rec) continue;
      const xy = rec.slice(0, 2);
      const rel = rec.slice(3);
      if (/[RC]/u.test(xy)) i += 1;
      dirtyPaths.push(rel);
    }
    const sharedDirty = dirtyPaths.filter((p) => touchesShared(p) || p.toLowerCase() === LOCK_FILE);
    const parts = [];
    if (dirtyPaths.length) {
      parts.push(`有 ${dirtyPaths.length} 處未提交改動${sharedDirty.length ? `（含共用路徑：${sharedDirty.slice(0, 5).join('、')}）` : ''}`);
    }
    if (!isUnborn && typeof f.HEAD === 'string' && HEX40.test(f.HEAD)) {
      const mb = spawnSync('git', ['merge-base', '--is-ancestor', f.HEAD, 'HEAD'], { cwd: root, env: gitEnv(), encoding: 'utf8' });
      if (mb.status === 1) parts.push('有尚未併入目前 HEAD 的提交');
      else if (mb.error || mb.status !== 0) parts.push(`無法比對提交歷史（git merge-base 退 ${mb.status ?? '錯誤'}）`);
    }
    if (parts.length) items.push(`  ・工作樹 ${f.worktree}（${label}）：${parts.join('，且')}`);
  }
  return items.length ? ['提醒（其他工作樹）：查到同一倉庫的其他工作樹有未提交改動或未合併提交（小心與其他工作線衝突）：', ...items] : [];
}

/** 退場共用檔引用預檢（只提醒不擋）：套件這一版刪掉的共用檔，若專案自己的追蹤檔還有字面引用，列出檔名與行號。 */
function retiredRefWarnings(root, targetList, prevEntries) {
  const removed = compare(targetList, prevEntries).filter((d) => d.kind === '少掉').map((d) => d.path);
  if (!removed.length) return [];
  const ownFiles = git(root, ['ls-files', '-z']).split('\0').filter((p) => p && !underShared(p) && p !== LOCK_FILE).sort();
  if (!ownFiles.length) return [];
  const patterns = removed.map((delPath) => ({
    delPath,
    re: new RegExp(`(?<![A-Za-z0-9_-])${delPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![A-Za-z0-9_.-])`, 'u'),
  }));
  const hits = [];
  for (const ownPath of ownFiles) {
    const full = path.join(root, ownPath);
    let raw;
    try {
      const st = fs.lstatSync(full);
      if (!st.isFile()) continue;
      raw = fs.readFileSync(full, 'utf8');
    } catch { continue; }
    if (raw.includes('\u0000')) continue;
    const lines = raw.replace(/\r\n?/gu, '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const { delPath, re } of patterns) {
        if (re.test(lines[i])) hits.push(`  ・${ownPath}:${i + 1}（引用已刪共用檔 ${delPath}）`);
      }
    }
  }
  return hits.length ? ['提醒（退場共用檔引用）：套件這一版刪掉的共用檔仍被專案自己的檔案引用（同步後可能壞掉，請一併更新）：', ...hits] : [];
}

/** 範本對照提醒（只提醒不擋）：套件這一版改動了範本，且專案裡有對應抄出去的檔案（不在共用路徑）時列出對照。 */
function copiedTemplateWarnings(root, targetList, prevEntries) {
  const changes = compare(targetList, prevEntries);
  const items = [];
  for (const { template, target } of COPIED_TEMPLATES) {
    const ch = changes.find((d) => d.path === template);
    if (ch && fs.existsSync(path.join(root, target))) {
      items.push(`  ・${template}（${WRITE_KIND[ch.kind]}）→ 請對照專案的 ${target}`);
    }
  }
  return items.length ? ['提醒（範本對照）：套件這一版改動了範本，且專案裡有對應抄出去的檔案（不在共用路徑，請人工對照更新）：', ...items] : [];
}

function syncWarnings(root, previous, target) {
  return [
    ...worktreeWarnings(root),
    ...retiredRefWarnings(root, target.list, previous.entries),
    ...copiedTemplateWarnings(root, target.list, previous.entries),
  ];
}

function changeLines(list, previous) {
  const changes = compare(list, previous.entries);
  return [`跟上一份清單（${previous.version.slice(0, 7)}，${previous.syncedAt}）比：套件這一版有 ${changes.length} 個共用檔不一樣`, ...changes.map((d) => `  ・${d.path}：${WRITE_KIND[d.kind]}`)];
}

/**
 * 同步（已經有清單的使用專案升到套件的另一版）：先查、查過才換。apply＝false 只檢查（預演）；true 才刪共用路徑、解開那一版、寫新清單。
 * 回 { ok, lines, lock }；ok＝false 表示查到會被蓋掉或刪掉的東西，什麼都沒動。
 */
function sync(root = ROOT, { kit, version, date, repo, apply = false } = {}) {
  const prefix = git(root, ['rev-parse', '--show-prefix']).trim();
  if (prefix) throw new LockError(`--root 要是使用專案倉庫的最上層（現在在它的 ${prefix} 底下）`);
  const previous = readLock(root);
  const target = kitVersion(kit, version);
  const short = previous.version.slice(0, 7);
  let prevSha;
  try { prevSha = resolveKit(kit, previous.version); } catch (e) {
    if (e instanceof LockError) throw new LockError(`清單記的套件版本 ${short} 在本機套件倉庫找不到，核不了清單是不是出自套件：${e.message}`);
    throw e;
  }
  // 要同步的那一版在主幹上（kitVersion 核過）＋清單記的在它之前＝清單記的也在主幹上
  if (!gitYes(kit, ['merge-base', '--is-ancestor', prevSha, target.sha])) {
    throw new LockError(`清單記的套件 ${short} 不在要同步的 ${target.sha.slice(0, 7)} 之前：往回同步、清單指到沒合併的版本（清單被手改過？），或不在同一條線上——只從主幹往前同步`);
  }
  const repoName = repo || previous.repo;
  if (typeof repoName !== 'string' || !REPO.test(repoName)) throw new LockError('--repo 要是「帳號/倉庫名」');
  const syncedAt = date || localDate();
  if (!realDate(syncedAt)) throw new LockError('--date 要是真的日子（YYYY-MM-DD）');
  const lock = validateLock({ repo: repoName, version: target.sha, syncedAt, entries: target.list });
  const archive = apply ? kitArchive(kit, target) : null;
  const blockers = precheck(root, previous, prevSha, kit, target);
  if (blockers.length) return { ok: false, lines: [`同步前檢查：查到 ${blockers.length} 處不能直接換（清單記的是套件 ${previous.version.slice(0, 7)}）`, ...blockers.map((b) => `  ・${b}`), SYNC_STOP] };
  const lines = ['同步前檢查：清單出自套件那一版，已提交、暫存區、工作樹都跟清單一樣，共用路徑底下沒有沒追蹤或被忽略的檔', ...changeLines(target.list, previous), ...syncWarnings(root, previous, target)];
  if (!apply) {
    lines.push(`預演：沒有動任何檔。確認後在同一行加 --apply 才換檔（換成套件 ${target.sha.slice(0, 7)}）`);
    return { ok: true, lines };
  }
  replace(root, target, archive, previous);
  try {
    saveLockFile(root, lock);
  } catch (e) {
    throw new LockError(`共用檔已經換成套件 ${target.sha.slice(0, 7)}，寫新清單卻失敗（${(e && e.code) || (e && e.message) || '不明'}），清單還是舊的那一版。${restoreHint(root, previous)}`);
  }
  lines.push(FIXED, `寫好 ${LOCK_FILE}：套件 ${repoName} ${target.sha}（${syncedAt}），${target.list.length} 筆`);
  return { ok: true, lines, lock };
}

/** 這棵樹的歷史裡（HEAD 往回）出現過清單嗎；還沒有任何提交＝沒有。 */
function lockInHistory(root) {
  if (!gitYes(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) return false;
  return git(root, ['rev-list', '-1', 'HEAD', '--', LOCK_FILE]).trim() !== '';
}

/** 第一次裝：清單內容從本機套件倉庫的那一版取；已經有、或歷史裡有過清單＝拒寫（之後用 --sync）；工作樹跟那一版不一樣＝拒寫。 */
function write(root = ROOT, { version, repo, date, kit } = {}) {
  if (fs.existsSync(path.join(root, LOCK_FILE))) throw new LockError(`已經有 ${LOCK_FILE}：--write 只用在第一次裝；之後同步用 --sync（先查專案有沒有自己改過的共用檔，查過才換檔）`);
  // 刪掉清單（連提交一起）再跑 --write＝繞過 --sync 的同步前檢查：歷史裡出現過清單就不算第一次裝
  if (lockInHistory(root)) throw new LockError(`這棵樹的歷史裡有過 ${LOCK_FILE}：不是第一次裝，同步用 --sync（清單被刪了就先從歷史取回；真的要重裝先問擁有者）`);
  const { sha, list } = kitVersion(kit, version);
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new LockError('第一次寫清單要給 --repo <帳號/倉庫名>');
  const syncedAt = date || localDate();
  if (!realDate(syncedAt)) throw new LockError('--date 要是真的日子（YYYY-MM-DD）');
  const drift = compare(entries(root), list);
  if (drift.length) {
    throw new LockError([
      `工作樹跟套件 ${sha} 有 ${drift.length} 個共用檔不一樣——沒寫清單：`,
      ...drift.map((d) => `  ・${d.path}：${d.kind}`),
      '第一次裝要整批取同一版：先刪掉共用路徑再解開套件那一版（git archive 只新增與覆蓋、不會刪），共用路徑底下不放專案自己的檔，再重跑 --write。',
    ].join('\n'));
  }
  const lock = validateLock({ repo, version: sha, syncedAt, entries: list });
  saveLockFile(root, lock);
  return { lock, lines: [`第一次寫清單：套件 ${sha.slice(0, 7)} 有 ${list.length} 個共用檔`, FIXED, `寫好 ${LOCK_FILE}：套件 ${repo} ${sha}（${syncedAt}），${list.length} 筆`] };
}

/** 帶不帶只看設定的登記；清單在不在只拿來對帳（跟案例簿那一列同一種開關）。 */
function declaration(machines, lockPresent) {
  const rows = Array.isArray(machines) ? machines.filter((m) => m && m.name === MACHINE) : [];
  if (rows.length !== 1) return { run: true, problem: `機器表裡「${MACHINE}」要剛好一列（現在 ${rows.length} 列）`, reason: null };
  const { state } = rows[0];
  if (state === '已啟用') {
    return lockPresent ? { run: true, problem: null, reason: null }
      : { run: true, problem: `「${MACHINE}」登記已啟用，${LOCK_FILE} 卻不在：第一次裝跑 node tools/kit-lock.js --write --kit <本機套件倉庫> --version <套件版本碼> --repo <帳號/倉庫名> 建清單；不帶清單就把這一列改回已安裝未啟用`, reason: null };
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

const MODE_FLAGS = ['--check', '--write', '--sync', '--touch'];
const TAKES = { check: [], touch: [], write: ['version', 'repo', 'date', 'kit'], sync: ['version', 'repo', 'date', 'kit', 'apply'] };

function parseArgs(argv) {
  const out = { mode: null, version: null, repo: null, date: null, kit: null, root: null, apply: null, paths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new LockError(`${a} 後面要接值`); return argv[i]; };
    if (MODE_FLAGS.includes(a)) { if (out.mode) throw new LockError(`${MODE_FLAGS.join('、')} 只能給一個`); out.mode = a.slice(2); }
    else if (a === '--version') out.version = next();
    else if (a === '--repo') out.repo = next();
    else if (a === '--date') out.date = next();
    else if (a === '--kit') out.kit = next();
    else if (a === '--root') out.root = next();
    else if (a === '--apply') out.apply = true;
    else if (a.startsWith('-')) throw new LockError(`看不懂的參數：${a}`);
    else out.paths.push(a);
  }
  if (!out.mode) throw new LockError(`要給 ${MODE_FLAGS.join('、')} 其中一個`);
  const extra = ['version', 'repo', 'date', 'kit', 'apply'].filter((k) => out[k] !== null && !TAKES[out.mode].includes(k));
  if (extra.length) throw new LockError(`--${out.mode} 不收 ${extra.map((k) => `--${k}`).join('、')}`);
  if (out.paths.length && out.mode !== 'touch') throw new LockError(`只有 --touch 收路徑（多了：${out.paths.join(' ')}）`);
  return out;
}

function touchLines(root, paths) {
  const upstream = fs.existsSync(path.join(root, LOCK_FILE)) ? [] : [`（這棵樹沒有 ${LOCK_FILE}：要是在協作套件倉庫自己（上游）跑，這些檔本來就在這裡改）`];
  if (!paths.length) return { code: 0, lines: ['共用路徑（協作套件的檔，只在套件改；規矩 D5）：', ...SHARED_PATHS.map((p) => `  ・${p}`), '開工時把這一支要改的路徑接在 --touch 後面，列出哪些落在這裡', ...upstream] };
  const r = touch(paths);
  const lines = [`開工查共用檔：給了 ${paths.length} 個路徑，${r.shared.length} 個落在協作套件的檔${r.lock.length ? `、${r.lock.length} 個是清單本身` : ''}`];
  for (const p of r.shared) lines.push(`  ・套件的：${p}`);
  for (const p of r.lock) lines.push(`  ・清單本身：${p}（只由 --sync／--write 寫，不手改）`);
  for (const p of r.own) lines.push(`  ・專案的：${p}`);
  if (r.shared.length || r.lock.length) lines.push('落在套件的那幾個不在這裡改（規矩 D5）：告訴擁有者，由他指派誰去協作套件改，合併後用 --sync 整批同步回來；專案自己的照常改');
  return { code: r.shared.length || r.lock.length ? 1 : 0, lines: [...lines, ...upstream] };
}

function main(argv = process.argv.slice(2)) {
  let a;
  try { a = parseArgs(argv); } catch (e) { return { code: 2, lines: [e.message, USAGE] }; }
  const root = a.root ? path.resolve(a.root) : ROOT;
  const kit = a.kit && path.resolve(a.kit);
  try {
    if (a.mode === 'touch') return touchLines(root, a.paths);
    if (a.mode === 'write') return { code: 0, lines: write(root, { ...a, kit }).lines };
    if (a.mode === 'sync') { const r = sync(root, { ...a, kit, apply: a.apply === true }); return { code: r.ok ? 0 : 1, lines: r.lines }; }
    const r = check(root);
    const lines = [`共用檔清單｜套件 ${r.repo} ${r.version.slice(0, 7)}（${r.syncedAt}）：${r.count} 筆；工作樹跟清單不一樣的 ${r.diffs.length} 個`];
    if (r.ok) { lines.push('全部相同。'); return { code: 0, lines }; }
    for (const p of r.problems) lines.push(`  ・${p}`);
    lines.push(r.fix);
    return { code: 1, lines };
  } catch (e) {
    // 1 只留給「查到不一樣」（--check 的工作樹對不上清單、--sync 查到會被蓋掉的東西、--touch 落在套件的檔）；其餘一律退 2（清單或環境的問題，不猜）
    if (e instanceof LockError) return { code: 2, lines: [e.message] };
    return { code: 2, lines: [`共用檔清單：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——算不出來`] };
  }
}

if (require.main === module) {
  const r = main();
  process.stdout.write(`${r.lines.join('\n')}\n`);
  process.exit(r.code);
}

module.exports = { LOCK_FILE, MACHINE, SHARED_PATHS, SELF_REL, COPIED_TEMPLATES, underShared, underSharedFolded, touchesShared, normalizeTouch, touch, sharedPathsIn, FINGERPRINT_SHARED, CODEX_TEMPLATE, FIXED, LockError, entries, headEntries, uncommitted, parentHazards, caseTwins, hiddenFlags, kitEntries, kitVersion, readLock, validateLock, compare, check, precheck, worktreeWarnings, retiredRefWarnings, copiedTemplateWarnings, syncWarnings, restoreCommands, restoreLines, nestedGit, gitLikeName, sync, write, declaration, parseArgs, main };
