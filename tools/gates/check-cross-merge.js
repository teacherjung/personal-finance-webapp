#!/usr/bin/env node
// 跨變更試合併閘（規矩 H4）：把每一支以主幹為底、開著的變更，真的跟這一支合起來跑三關。
//
// 為什麼：「兩支各自全綠」不等於「合起來全綠」。原專案一個晚上撞了兩次，形狀一樣——一支加的規則
// 禁止了另一支的內容；兩支沒改到同一行，平台不顯示衝突、各自的檢查都綠，合併第二支的當下主幹就紅了。
// 「記得合併前做試合併」跟「記得填欄位」是同一種規則：被忘記的那一次不會有任何徵兆，所以做成閘。
//
// 它讓裁示者不必自己想「這支跟那支會不會撞」。
//
// 三種結果，分類只看結構化的死法（kind），不嗅文字（原專案實測：測試輸出裡剛好出現「衝突」兩字就被分錯類）：
//   conflict＝文字衝突（平台自己看得到）；red＝合起來三關紅（平台看不到，這道閘存在的理由）；
//   cantRun＝拿不到可信的判決（試合併失敗卻沒有未合併的檔案、三關起不來、被訊號殺掉、126／127）＝整輪退 2，
//   不推定成因、不冒充「合起來會壞」。
//
// 比原專案少了什麼（照實說）：原專案有二百五十行專門核對合併後的套件清單跟臨時樹裡已裝的套件一不一致
// ——因為它用連結把發起樹的套件目錄借給臨時樹，借來的可能是舊的。這裡不借：臨時樹的準備指令由專案
// 登記（例如在臨時樹裡重新安裝），三關指令自己保證執行環境跟合併後的樹一致。慢一點，但不會拿舊套件
// 跑出假結果，也不用替某一種套件管理器寫核對。
//
// 所有外部指令走同一個入口、環境先清掉版本控制那一族變數（規矩 E4）：這支不是唯讀的，它會建立
// 與移除工作樹，繼承來的 GIT_DIR 會讓這些動作落在別的倉庫上。
//
// 退出碼：0＝沒有其他開著的變更、或每一支合起來都綠／1＝有一支合起來會壞／2＝查不清楚（一律不放行）。
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ask, PlatformError } = require('../platform.js');
const { read: readSettings } = require('../settings-data.js');
const { gitEnv } = require('../git-env.js');

const UNSET = '未設定';
const NONE = '無';

/** 唯一的外部指令入口：明確指定工作目錄、環境先清 GIT_ 那一族。 */
function runCommand(argv, cwd) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  return { status: r.error ? null : r.status, signal: r.signal || null, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.message : '' };
}

/** 把一次失敗壓成一行：頭尾都留、截中段（死因可能在第一行，也可能在最後一行）。 */
function detail(r) {
  const clip = (s) => (s.length <= 300 ? s : `${s.slice(0, 150)} …（截掉中段）… ${s.slice(-150)}`);
  const tail = (s, n) => {
    const lines = String(s || '').split('\n').filter(Boolean);
    const kept = lines.length <= n ? lines : [lines[0], `…（略 ${lines.length - n} 行）…`, ...lines.slice(-(n - 1))];
    return clip(kept.join(' / '));
  };
  const out = tail(r.stdout, 3);
  const err = tail(r.stderr, 8);
  return [out, err && `stderr：${err}`].filter(Boolean).join('｜') || r.error || '（沒有留下任何輸出）';
}

/** 「執行不起來」的判準：拿不到數字退出碼（起不來、被訊號殺掉）、或 126／127。是＝回症狀，不是＝null。 */
function cantRunSignal(r) {
  if (typeof r.status !== 'number') return r.error || (r.signal ? `被 ${r.signal} 終止` : '沒有退出碼');
  return r.status === 126 || r.status === 127 ? `退出碼 ${r.status}` : null;
}

/** 純判斷層：把每一支的結果彙整成退出碼與訊息。結果的形狀不對＝這一輪不可信＝退 2。 */
function evaluate(results) {
  if (!Array.isArray(results)) return { code: 2, message: '跨變更試合併：結果不是清單，這一輪不可信。' };
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const okShape = r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string' && r.id
      && typeof r.ok === 'boolean' && typeof r.why === 'string'
      && (r.ok ? !('kind' in r) : ['conflict', 'red', 'cantRun'].includes(r.kind));
    if (!okShape) return { code: 2, message: `跨變更試合併：第 ${i + 1} 筆結果的形狀不對，這一輪不可信（有別的東西在餵結果、或程式被改壞）。` };
  }
  const bad = results.filter((r) => !r.ok);
  const list = (xs) => xs.map((r) => `  ・${r.id}：${r.why}`).join('\n');
  if (bad.some((r) => r.kind === 'cantRun')) {
    const confirmed = bad.filter((r) => r.kind !== 'cantRun');
    return {
      code: 2,
      message: '跨變更試合併：查不清楚——有步驟執行不起來（試合併失敗卻沒有未合併的檔案、三關起不來、被訊號殺掉、126／127），這一輪下不了定論\n'
        + list(bad) + '\n  成因這裡不推定：可能是臨時樹的環境、可能是兩支合出來弄壞了指令會用到的檔、也可能是指令自己以 126／127 收場。先從主目錄重跑一次對照。'
        + (confirmed.length ? `\n  ⚠️ 上列另有本輪已確定的阻擋（${[...new Set(confirmed.map((r) => (r.kind === 'conflict' ? '文字衝突' : '三關紅')))].join('、')}），不因下不了定論而失效。` : ''),
    };
  }
  if (!bad.length) {
    return { code: 0, message: results.length ? `跨變更試合併：與 ${results.length} 支開著的變更合起來都是綠的（${results.map((r) => r.id).join('、')}）。` : '跨變更試合併：目前沒有其他以主幹為底的開著變更，不需要試。' };
  }
  return {
    code: 1,
    message: '跨變更試合併：合起來會壞\n' + list(bad)
      + (bad.some((r) => r.kind === 'conflict') ? '\n  ⚠️ 文字衝突：平台自己看得到；這道閘的價值是現在就告訴你。' : '')
      + (bad.some((r) => r.kind === 'red') ? '\n  ⚠️ 合起來三關紅：平台看不到——各自的檢查都綠、也沒有檔案衝突，合併第二支的當下主幹就紅了。通常是一支的護欄擋掉了另一支的內容。量時間或記憶體的考題在機器忙時會假紅：紅了只准重跑一次（規矩 H4）。' : ''),
  };
}

/** 真的版本控制操作，集中在一個物件裡讓考題能整個換掉。 */
function realRepo(run) {
  return {
    root: (cwd) => { const r = run(['git', 'rev-parse', '--show-toplevel'], cwd); return r.status === 0 ? r.stdout.trim() : null; },
    has: (root, sha) => run(['git', 'cat-file', '-e', `${sha}^{commit}`], root).status === 0,
    worktreeAdd: (root, dir, sha) => run(['git', 'worktree', 'add', '--detach', '-q', dir, sha], root),
    /** 回 { ok } 或 { ok:false, unmerged:[…] } 或 { ok:false, unmerged:null, detail }（失敗卻沒有未合併檔案） */
    merge: (dir, sha) => {
      const r = run(['git', 'merge', '--no-edit', '-q', sha], dir);
      if (r.status === 0) return { ok: true };
      const u = run(['git', 'ls-files', '-u'], dir);
      const files = u.status === 0 ? [...new Set(u.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('\t').pop()))] : [];
      return files.length ? { ok: false, unmerged: files } : { ok: false, unmerged: null, detail: detail(r) };
    },
    worktreeRemove: (root, dir) => { run(['git', 'worktree', 'remove', '--force', dir], root); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** 在拋棄式工作樹裡把 other 合進 self，跑準備指令與三關。回一筆結果（失敗必帶 kind）。 */
function tryMerge({ repo, run, root, selfSha, otherSha, otherId, prepare, commands }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cross-merge-${otherId}-`));
  try {
    const add = repo.worktreeAdd(root, dir, selfSha);
    if (add.status !== 0) return { id: otherId, ok: false, kind: 'cantRun', why: `建不出臨時樹：${detail(add)}` };
    const m = repo.merge(dir, otherSha);
    if (!m.ok) {
      if (m.unmerged) return { id: otherId, ok: false, kind: 'conflict', why: `文字衝突，合併就過不去（${m.unmerged.slice(0, 5).join('、')}）` };
      return { id: otherId, ok: false, kind: 'cantRun', why: `試合併失敗、也沒有留下未合併的檔案——沒有取得可判讀的衝突結果：${m.detail}` };
    }
    if (prepare) {
      const p = run(prepare, dir);
      if (p.status !== 0) return { id: otherId, ok: false, kind: 'cantRun', why: `臨時樹的準備指令失敗（${cantRunSignal(p) || `退出碼 ${p.status}`}）：${detail(p)}` };
    }
    for (const [i, cmd] of commands.entries()) {
      const r = run(cmd, dir);
      if (r.status === 0) continue;
      const sig = cantRunSignal(r);
      if (sig !== null) return { id: otherId, ok: false, kind: 'cantRun', why: `第 ${i + 1} 條三關指令執行不起來（症狀：${sig}）：${detail(r)}` };
      return { id: otherId, ok: false, kind: 'red', why: `合起來之後第 ${i + 1} 條三關指令紅了（退出碼 ${r.status}）：${detail(r)}` };
    }
    return { id: otherId, ok: true, why: '' };
  } finally {
    try { repo.worktreeRemove(root, dir); } catch { /* 盡力清乾淨 */ }
  }
}

/** 讀設定裡的三關。沒填、或登記裡有壞條目＝null（r1 Medium⑪：不濾掉，壞一條就整個不算數）。 */
function checksOf(settings) {
  const c = settings.checks || {};
  const isArgv = (x) => Array.isArray(x) && x.length > 0 && x.every((a) => typeof a === 'string' && a) && x[0] !== UNSET;
  if (!Array.isArray(c.commands) || !c.commands.length || !c.commands.every(isArgv)) return null;
  const p = c.prepareWorktree;
  if (p === undefined || (Array.isArray(p) && p.length === 1 && (p[0] === UNSET || p[0] === NONE))) return { prepare: null, commands: c.commands };
  if (!isArgv(p)) return null;
  return { prepare: p, commands: c.commands };
}

function gateRun(changeId, { settings = readSettings(), platform = { ask }, run = runCommand, repo = realRepo(run), cwd = process.cwd() } = {}) {
  if (!changeId) return { code: 2, lines: ['用法：node tools/gates/check-cross-merge.js <變更編號>'] };
  const mainBranch = settings.mainBranch;
  if (!mainBranch || mainBranch === UNSET) return { code: 2, lines: [`專案設定裡的主幹分支名還是「${UNSET}」：不知道哪些變更算以主幹為底，不放行。`] };
  const checks = checksOf(settings);
  if (!checks) return { code: 2, lines: ['專案設定裡沒有登記三關指令：什麼都沒跑就說合起來是綠的，比不跑更危險，不放行。'] };
  let self;
  let open;
  try {
    self = platform.ask('change', { change: String(changeId) }, { settings });
    open = platform.ask('openChanges', {}, { settings });
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) return { code: 2, lines: [`跨變更試合併閘：問不到平台（${e.message}）——查不到一律當未通過。`] };
    throw e;
  }
  const others = open.filter((c) => c.id !== self.id && c.baseBranch === mainBranch).sort((a, b) => a.id.localeCompare(b.id));
  if (!others.length) return { code: 0, lines: [evaluate([]).message] };
  const root = repo.root(cwd);
  if (!root) return { code: 2, lines: ['這裡不是版本控制的工作樹：不知道要在哪棵樹上試合併，不放行。'] };
  const missing = [self, ...others].filter((c) => !repo.has(root, c.headSha));
  if (missing.length) return { code: 2, lines: [`本機沒有這幾支的版本（${missing.map((c) => c.id).join('、')}）：先把它們抓下來再跑，查不到不放行。`] };
  const results = others.map((o) => tryMerge({ repo, run, root, selfSha: self.headSha, otherSha: o.headSha, otherId: o.id, prepare: checks.prepare, commands: checks.commands }));
  const v = evaluate(results);
  return { code: v.code, lines: v.message.split('\n') };
}

if (require.main === module) {
  let result;
  try { result = gateRun(process.argv[2]); }
  catch (e) { result = { code: 2, lines: [`跨變更試合併閘：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——不放行。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { gateRun, evaluate, tryMerge, cantRunSignal, detail, checksOf, runCommand, realRepo };
