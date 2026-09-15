// 守跨變更試合併閘（規矩 H4）。原專案：兩支各自全綠、合起來紅，一個晚上兩次，平台看不到。
//
// 守得到的：
//   ①分類只看死法：文字衝突＝1、三關紅＝1、執行不起來（起不來、被殺、126／127、試合併失敗卻沒有未合併檔案）＝2；
//   ②有一筆執行不起來就整輪退 2，但已確定的阻擋要照樣點名；結果形狀不對＝2；
//   ③沒有其他以主幹為底的開著變更＝0；只算以設定裡主幹為底的、排除自己；
//   ④三關指令沒登記、主幹名沒填、不在版本控制樹裡、本機沒有那些版本、平台問不到＝2；
//   ⑤準備指令有登記就先跑，失敗＝執行不起來；三關逐條跑、第一條紅就停；
//   ⑥所有外部指令的環境都清掉 GIT_ 那一族（規矩 E4）；臨時樹不管哪條路出去都清掉；
//   ⑦真的用一個臨時倉庫跑一遍：相容的支＝綠、衝突的支＝1、一支的檢查擋掉另一支的內容＝1。
//
// ⚠️ 守不到的：兩支合起來語意矛盾但三關沒覆蓋到的地方；主幹在試合併之後又前進；
//    臨時樹的執行環境跟合併後的相依清單一不一致——那是準備指令與三關指令自己的責任
//    （原專案為此寫了二百五十行套件管理器專用的核對，沒搬）；開著的變更清單有沒有少給。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gateRun, evaluate, cantRunSignal, checksOf, runCommand } = require('../tools/gates/check-cross-merge.js');
const { PlatformError } = require('../tools/platform.js');
const { gitEnv } = require('../tools/git-env.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const ok = (id) => ({ id, ok: true, why: '' });
const bad = (id, kind) => ({ id, ok: false, kind, why: `${kind} 的原因` });

test('①②分類只看死法；執行不起來整輪退 2 但已確定的阻擋要點名；形狀不對＝2', () => {
  assert.equal(evaluate([ok('8'), ok('9')]).code, 0);
  assert.equal(evaluate([ok('8'), bad('9', 'conflict')]).code, 1);
  assert.equal(evaluate([bad('9', 'red')]).code, 1);
  const mixed = evaluate([bad('8', 'red'), bad('9', 'cantRun')]);
  assert.equal(mixed.code, 2, '執行不起來＝下不了定論');
  assert.match(mixed.message, /已確定的阻擋（三關紅）/u, '已確定的紅不因下不了定論而消失');
  for (const shape of ['x', [null], [{ id: '8' }], [{ id: '8', ok: true, why: '', kind: 'red' }], [{ id: '8', ok: false, why: '' }], [{ id: '8', ok: false, why: '', kind: '別的' }], [{ id: '', ok: true, why: '' }]]) {
    assert.equal(evaluate(shape).code, 2, JSON.stringify(shape));
  }
  // 死法字串出現在 why 裡不影響分類
  assert.equal(evaluate([{ id: '8', ok: false, kind: 'red', why: '文字衝突 這幾個字剛好在測試輸出裡' }]).code, 1);
});

test('③沒有其他開著的變更＝0；只算以設定裡主幹為底的、排除自己', () => {
  assert.equal(evaluate([]).code, 0);
  const platform = { ask: (op) => (op === 'change' ? { id: '7', headSha: 'a', baseBranch: '主線' } : [{ id: '7', headSha: 'a', baseBranch: '主線' }, { id: '8', headSha: 'b', baseBranch: 'topic' }]) };
  const r = gateRun('7', { settings: { mainBranch: '主線', checks: { commands: [['true']] } }, platform, repo: { root: () => { throw new Error('不該走到這裡'); } } });
  assert.equal(r.code, 0, '自己與非主幹底的都不算＝沒有其他變更');
});

test('④設定沒填、不在樹裡、本機沒有版本、平台問不到＝2；不是平台的錯就炸出去', () => {
  const platform = { ask: (op) => (op === 'change' ? { id: '7', headSha: 'aaa', baseBranch: 'main' } : [{ id: '8', headSha: 'bbb', baseBranch: 'main' }]) };
  const base = { mainBranch: 'main', checks: { commands: [['true']] } };
  assert.equal(gateRun('7', { settings: { ...base, mainBranch: '未設定' }, platform }).code, 2);
  assert.equal(gateRun('7', { settings: { ...base, checks: { commands: [['未設定']] } }, platform }).code, 2, '沒登記三關＝不放行');
  assert.equal(gateRun('7', { settings: { ...base, checks: {} }, platform }).code, 2);
  assert.equal(gateRun('7', { settings: base, platform, repo: { root: () => null } }).code, 2, '不在樹裡');
  const noSha = gateRun('7', { settings: base, platform, repo: { root: () => '/r', has: () => false } });
  assert.equal(noSha.code, 2);
  assert.match(noSha.lines.join('\n'), /先把它們抓下來/u);
  assert.equal(gateRun('7', { settings: base, platform: { ask() { throw new PlatformError('x'); } } }).code, 2);
  assert.equal(gateRun(undefined, { settings: base, platform }).code, 2);
  assert.throws(() => gateRun('7', { settings: base, platform: { ask() { throw new TypeError('程式寫錯'); } } }), TypeError);
});

test('cantRunSignal：起不來、被殺、126／127＝執行不起來；其餘非零＝跑得起來的紅', () => {
  assert.ok(cantRunSignal({ status: null, error: 'ENOENT' }));
  assert.ok(cantRunSignal({ status: null, signal: 'SIGKILL' }));
  assert.ok(cantRunSignal({ status: 127 }));
  assert.ok(cantRunSignal({ status: 126 }));
  assert.equal(cantRunSignal({ status: 1 }), null);
  assert.equal(cantRunSignal({ status: 2 }), null);
});

test('checksOf：準備指令填「無」或未設定＝不跑；三關至少一條；登記裡混一條壞的＝整個不算數', () => {
  assert.equal(checksOf({}), null);
  assert.equal(checksOf({ checks: { commands: [['未設定']] } }), null);
  for (const mixed of [[['a'], ['未設定']], [['a'], []], [['a'], 'b'], [['a'], ['']]]) assert.equal(checksOf({ checks: { commands: mixed } }), null, JSON.stringify(mixed));
  assert.equal(checksOf({ checks: { prepareWorktree: [''], commands: [['a']] } }), null, '準備指令形狀錯也不算數');
  assert.deepEqual(checksOf({ checks: { prepareWorktree: ['無'], commands: [['a'], ['b']] } }), { prepare: null, commands: [['a'], ['b']] });
  assert.deepEqual(checksOf({ checks: { prepareWorktree: ['npm', 'ci'], commands: [['a']] } }).prepare, ['npm', 'ci']);
});

test('⑥預設執行器清掉 GIT_ 那一族環境變數（規矩 E4；起不來回 status null）', () => {
  const prev = process.env.GIT_DIR;
  process.env.GIT_DIR = '/no/such/dir';
  try {
    const r = runCommand([process.execPath, '-e', 'process.stdout.write(String("GIT_DIR" in process.env))'], os.tmpdir());
    assert.equal(r.stdout, 'false', '子行程不可以看到 GIT_DIR');
  } finally { if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev; }
  assert.equal(runCommand(['/no/such/binary-for-test'], os.tmpdir()).status, null);
});

/** 建一個臨時倉庫：主幹一顆、三支分支——相容、文字衝突、規則擋內容。回各分支的 sha 與根路徑。 */
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-merge-repo-'));
  const git = (...args) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...gitEnv(), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}：${r.stderr}`); return r.stdout.trim(); };
  const write = (f, s) => fs.writeFileSync(path.join(root, f), s);
  git('init', '-q', '-b', 'main');
  // 身分寫進倉庫自己的設定（搬家前準備）：閘在臨時工作樹裡 git merge 用的是清過 GIT_ 的環境，
  // 上面那幾個 GIT_AUTHOR／COMMITTER 變數到不了它；雲端 Linux 機器沒有全域身分時合併會失敗。臨時工作樹共用這份設定。
  git('config', 'user.name', 't'); git('config', 'user.email', 't@x');
  // 三關＝這支腳本：規則檔說不准的字不可以出現在內容檔裡
  write('check.js', "const fs=require('fs');const rule=fs.readFileSync('rule.txt','utf8').trim();const body=fs.readFileSync('body.txt','utf8');if(rule&&body.includes(rule)){console.error('rule '+rule+' forbids body');process.exit(1)}console.log('ok')");
  write('rule.txt', '\n'); write('body.txt', 'hello\n'); write('other.txt', 'x\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  const main = git('rev-parse', 'HEAD');
  const branch = (name, edits) => { git('checkout', '-q', '-b', name, main); for (const [f, s] of edits) write(f, s); git('add', '.'); git('commit', '-q', '-m', name); const sha = git('rev-parse', 'HEAD'); git('checkout', '-q', 'main'); return sha; };
  const self = branch('self', [['body.txt', 'hello world\n']]);            // 本支：內容檔加了 world
  const compatible = branch('compatible', [['other.txt', 'y\n']]);        // 相容：動別的檔
  const conflict = branch('conflict', [['body.txt', 'goodbye\n']]);       // 文字衝突：同一行
  const forbids = branch('forbids', [['rule.txt', 'world\n']]);           // 規則擋內容：沒有檔案衝突，合起來三關紅
  return { root, self, compatible, conflict, forbids };
}

test('⑦真的跑一遍：相容＝綠、文字衝突＝1、一支的規則擋掉另一支的內容＝1（平台看不到的那種）', () => {
  const repo = tempRepo();
  try {
    const settings = { mainBranch: 'main', checks: { prepareWorktree: ['無'], commands: [[process.execPath, 'check.js']] } };
    const platformFor = (others) => ({ ask: (op) => (op === 'change' ? { id: 'self', headSha: repo.self, baseBranch: 'main' } : others.map(([id, sha]) => ({ id, headSha: sha, baseBranch: 'main' }))) });
    const green = gateRun('self', { settings, platform: platformFor([['compatible', repo.compatible]]), cwd: repo.root });
    assert.equal(green.code, 0, green.lines.join('\n'));
    const c = gateRun('self', { settings, platform: platformFor([['conflict', repo.conflict]]), cwd: repo.root });
    assert.equal(c.code, 1, c.lines.join('\n'));
    assert.match(c.lines.join('\n'), /文字衝突/u);
    const f = gateRun('self', { settings, platform: platformFor([['forbids', repo.forbids]]), cwd: repo.root });
    assert.equal(f.code, 1, f.lines.join('\n'));
    assert.match(f.lines.join('\n'), /三關指令紅了/u, '沒有檔案衝突、各自都綠，合起來才紅——這道閘存在的理由');
    // 三支一起：兩支壞的都要點名
    const all = gateRun('self', { settings, platform: platformFor([['compatible', repo.compatible], ['conflict', repo.conflict], ['forbids', repo.forbids]]), cwd: repo.root });
    assert.equal(all.code, 1);
    assert.match(all.lines.join('\n'), /conflict/u); assert.match(all.lines.join('\n'), /forbids/u);
    // 臨時樹要清掉：倉庫的 worktree 清單只剩主樹
    const wt = spawnSync('git', ['worktree', 'list'], { cwd: repo.root, encoding: 'utf8', env: gitEnv() }).stdout.trim().split('\n');
    assert.equal(wt.length, 1, `臨時樹沒清乾淨：\n${wt.join('\n')}`);
    // 三關起不來＝2，不是 1
    const cant = gateRun('self', { settings: { ...settings, checks: { commands: [['/no/such/check-binary']] } }, platform: platformFor([['compatible', repo.compatible]]), cwd: repo.root });
    assert.equal(cant.code, 2, cant.lines.join('\n'));
    // 準備指令失敗＝2
    const prepFail = gateRun('self', { settings: { ...settings, checks: { prepareWorktree: [process.execPath, '-e', 'process.exit(3)'], commands: [['true']] } }, platform: platformFor([['compatible', repo.compatible]]), cwd: repo.root });
    assert.equal(prepFail.code, 2);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test('真的跑一遍指令（空白設定的複本，不讀本倉庫那份）：設定未填，退 2', () => {
  assert.equal(runInCopy('tools/gates/check-cross-merge.js', ['7']).status, 2);
  assert.equal(runInCopy('tools/gates/check-cross-merge.js').status, 2);
});
