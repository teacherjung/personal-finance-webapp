// 守合併指令（規矩 A5、H1；裁示者 2026-09-12 裁「丙′」）。
//
// 守得到的：
//   ①沒有任何一道閘登記成「已啟用」＝不放行（fail-closed）——一支什麼都沒檢查就按合併鍵的
//     指令比沒有這支指令更危險；
//   ②主幹分支名還沒填＝不放行；
//   ③閘照登記的順序跑，**任一道非零就停在那裡**，後面的閘不跑、合併鍵不按；
//   ④全綠才執行合併；合併指令沒登記＝停下來，不自己猜平台怎麼合；
//   ⑤合併指令回非零＝照實說「先查那支變更的狀態再決定，不要重跑」；
//   ⑥**預設執行器**：閘起不來（找不到指令）或被訊號殺掉＝退出碼 2，不是 0——「跑不起來」不等於
//     「檢查過了」。這一格 2026-09-13 稽核前零覆蓋（八題全部注入假執行器），端到端重現過：
//     把不存在的指令登記成已啟用的閘，只要 runCommand 回 0，合併鍵就真的被按下去；
//   ⑦按完合併鍵印的結論，量詞只蓋到這一趟真的跑過的那幾道閘；
//   ⑧**版本鎖**（搬家驗屋 09-13）：開跑前記下變更的版本、按鍵前再讀一次，不一樣＝不按（原本五道閘各自重讀、
//     彼此不比對，跑閘途中推上來的新版本照樣被合併）；問不到版本＝不放行；
//   ⑨**合併指令的記號**：{change}、{sha}、{project}、{reviewer}（說明的「獨立審查者」欄）、{merger}（--merger 自報、
//     要是登記過的參與者）；認不得的記號、該填填不出來＝不放行；跑閘前驗得了的先驗；沒帶誰審誰合／版本要提醒；
//   ⑩閘退 1＝擋下（退 1）；退 2 或其他非零（含起不來）＝查不清楚（退 2），不叫人去找「紅的是哪一題」；
//   ⑪按合併鍵那一步也清掉 platform.clearEnv 登記的變數；合併指令裡沒有 {change}＝不放行（搬家前準備）。
//
// ⚠️ 守不到的，照實說：它擋不住「不用這支指令、直接按平台的合併鍵」——要擋那個只有平台級的
//    分支保護。也不驗那幾道閘自己對不對（那是各道閘自己的考題）。{merger} 是自報的：驗得到「是登記過的參與者」，
//    驗不到「真的是他」。版本鎖只比頭尾兩次：途中被推了新版又推回原版，看不出來。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeRun: realMergeRun, runCommand, parseArgs, UNSET, ENABLED } = require('../tools/merge.js');

const HEAD = 'a'.repeat(40);
const PEOPLE = [{ role: 'AI 甲', id: 'Alpha' }, { role: 'AI 乙', id: 'Beta' }];
/** 假平台：change 依序回 shas 裡的版本（用完就一直回最後一個）；記下被問了什麼。 */
function fakePlatform({ shas = [HEAD], body = '實作者：Alpha\n獨立審查者：Beta\n', fail = [] } = {}) {
  const asked = [];
  return {
    asked,
    ask(op, args) {
      asked.push(op);
      const n = asked.filter((x) => x === 'change').length;
      if (fail.includes(n)) { const e = new Error('問不到'); e.name = 'PlatformError'; throw e; }
      return { id: args.change, headSha: shas[Math.min(n, shas.length) - 1], body };
    },
  };
}
/** 沒特別給平台的題，一律用一個版本不變的假平台（這支指令現在一定會問平台版本）。 */
const mergeRun = (id, opts = {}) => realMergeRun(id, { platform: fakePlatform(), ...opts });

function settingsWith(gates, extra = {}) {
  return {
    mainBranch: 'main',
    gates,
    participants: PEOPLE,
    mergeCommand: { command: 'platform', args: ['merge', '{change}'] },
    ...extra,
  };
}

const gate = (name, state = ENABLED) => ({ name, command: 'node', args: [`gates/${name}.js`], state });

/** 記下跑過哪些指令的假執行器；codes 決定第幾次回什麼退出碼。 */
function fakeRunner(codes) {
  const calls = [];
  return {
    calls,
    run(command, args) {
      calls.push([command, ...args].join(' '));
      const code = codes.shift();
      return { code: code === undefined ? 0 : code, output: code ? '假裝壞掉了' : '' };
    },
  };
}

test('沒有任何一道閘啟用就不放行', () => {
  const { run, calls } = fakeRunner([]);
  const result = mergeRun('7', { settings: settingsWith([gate('甲', '未移植')]), run });
  assert.equal(result.code, 2, '零道啟用的閘應該是不放行');
  assert.equal(calls.length, 0, '不放行的時候不該跑任何東西');
  assert.match(result.lines.join('\n'), /沒有任何一道閘/u);
});

test('主幹分支名還沒填就不放行', () => {
  const { run } = fakeRunner([]);
  const result = mergeRun('7', { settings: settingsWith([gate('甲')], { mainBranch: UNSET }), run });
  assert.equal(result.code, 2);
  assert.match(result.lines.join('\n'), /主幹分支名/u);
});

test('沒給變更編號就不放行', () => {
  const { run } = fakeRunner([]);
  assert.equal(mergeRun(undefined, { settings: settingsWith([gate('甲')]), run }).code, 2);
});

test('閘照順序跑，第一道紅就停，後面的閘與合併鍵都不動', () => {
  const { run, calls } = fakeRunner([0, 1]);
  const result = mergeRun('7', { settings: settingsWith([gate('甲'), gate('乙'), gate('丙')]), run });
  assert.equal(result.code, 1);
  assert.deepEqual(calls, ['node gates/甲.js 7', 'node gates/乙.js 7'], '應該停在第二道，第三道與合併都不跑');
  assert.match(result.lines.join('\n'), /擋下來了/u);
});

test('每一道都綠才按合併鍵', () => {
  const { run, calls } = fakeRunner([0, 0]);
  const result = mergeRun('7', { settings: settingsWith([gate('甲'), gate('乙')]), run });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, ['node gates/甲.js 7', 'node gates/乙.js 7', 'platform merge 7']);
});

test('預設執行器：閘起不來＝退出碼 2，不是 0（跑不起來不等於檢查過了）', () => {
  const missing = runCommand('/no/such/gate-binary-for-test', ['x']);
  assert.equal(missing.code, 2, '找不到指令要回 2');
  assert.notEqual(missing.code, 0);
  const killed = runCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGKILL")']);
  assert.equal(killed.code, 2, '被訊號殺掉要回 2');
  assert.equal(runCommand(process.execPath, ['-e', 'process.exit(3)']).code, 3, '真的退出碼要照傳');
  assert.equal(runCommand(process.execPath, ['-e', 'process.exit(0)']).code, 0);
});

test('預設執行器清掉 GIT_ 那一族：閘的子行程看不到 GIT_DIR（規矩 E4；r1 High①）', () => {
  const prev = process.env.GIT_DIR; process.env.GIT_DIR = '/no/such/repo';
  try {
    const r = runCommand(process.execPath, ['-e', 'process.stdout.write(String("GIT_DIR" in process.env))']);
    assert.equal(r.output, 'false');
  } finally { if (prev === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev; }
});

test('端到端：node 在、閘的 JS 檔不在＝查不清楚（退 2），不是擋下（搬家修正 r1 B3：原重現的形狀）', () => {
  const missing = require('node:path').join(require('node:os').tmpdir(), `no-such-gate-${process.pid}.js`);
  const raw = require('node:child_process').spawnSync(process.execPath, [missing], { encoding: 'utf8' });
  assert.equal(raw.status, 1, '前提：node 跑不存在的檔就是退 1——跟閘判定擋下同一個碼');
  const settings = settingsWith([{ name: '檔案不在的閘', command: 'node', args: [missing], state: ENABLED }]);
  const result = mergeRun('7', { settings });   // 真的預設執行器
  assert.equal(result.code, 2, result.lines.join('\n'));
  assert.match(result.lines.join('\n'), /閘的檔案不在或讀不到/u);
  assert.doesNotMatch(result.lines.join('\n'), /紅的是哪一題/u);
  const real = require('node:path').join(require('node:os').tmpdir(), `real-gate-${process.pid}.js`);
  require('node:fs').writeFileSync(real, 'process.exit(1)');
  try {
    const blocked = mergeRun('7', { settings: settingsWith([{ name: '真的判擋下的閘', command: 'node', args: [real], state: ENABLED }]) });
    assert.equal(blocked.code, 1, '對照組：檔在、閘自己退 1＝擋下');
  } finally { require('node:fs').rmSync(real, { force: true }); }
});

test('端到端：用真的預設執行器跑一道不存在的閘，不放行也不按合併鍵', () => {
  const settings = settingsWith([{ name: '不存在的閘', command: '/no/such/gate-binary-for-test', args: [], state: ENABLED }]);
  const result = mergeRun('7', { settings });   // 不注入 run＝走真的 runCommand
  assert.equal(result.code, 2, '起不來的閘＝查不清楚（退 2），不是判定擋下');
  assert.match(result.lines.join('\n'), /查不清楚或根本起不來/u);
  assert.doesNotMatch(result.lines.join('\n'), /紅的是哪一題/u, '沒有紅的那一題可以找');
  assert.doesNotMatch(result.lines.join('\n'), /合併已執行/u);
});

test('按完合併鍵的結論，量詞只蓋這一趟真的跑過的閘', () => {
  const { run } = fakeRunner([0, 0]);
  const result = mergeRun('7', { settings: settingsWith([gate('甲'), gate('乙', '未移植'), gate('丙', '已安裝未啟用')]), run });
  assert.equal(result.code, 0);
  const text = result.lines.join('\n');
  assert.doesNotMatch(text, /每一道閘都綠/u, '不可以用蓋到全體的量詞');
  assert.match(text, /這一趟要跑的 1 道閘都綠/u);
  assert.match(text, /另有 2 道登記了但沒啟用/u);
});

test('沒登記啟用的閘不會被跑，但會被列出來提醒', () => {
  const { run, calls } = fakeRunner([0]);
  const result = mergeRun('7', { settings: settingsWith([gate('甲'), gate('乙', '已安裝未啟用')]), run });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, ['node gates/甲.js 7', 'platform merge 7']);
  assert.match(result.lines.join('\n'), /還沒啟用、這一趟不會跑：乙/u);
});

test('合併指令沒登記就停下來，不自己猜平台怎麼合', () => {
  const { run, calls } = fakeRunner([0]);
  const result = mergeRun('7', {
    settings: settingsWith([gate('甲')], { mergeCommand: { command: UNSET, args: [] } }),
    run,
  });
  assert.equal(result.code, 2);
  assert.deepEqual(calls, ['node gates/甲.js 7'], '閘照跑，但不執行合併');
});

test('合併指令回非零時照實說「先查狀態、不要重跑」', () => {
  const { run } = fakeRunner([0, 1]);
  const result = mergeRun('7', { settings: settingsWith([gate('甲')]), run });
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /先去查那支變更現在的狀態再決定，不要重跑/u);
});

test('⑧版本鎖：跑閘途中版本變了＝不按合併鍵（退 2）；頭尾一致才按', () => {
  const moved = fakePlatform({ shas: [HEAD, 'b'.repeat(40)] });
  const { run, calls } = fakeRunner([0, 0]);
  const r = realMergeRun('7', { settings: settingsWith([gate('甲'), gate('乙')]), run, platform: moved });
  assert.equal(r.code, 2);
  assert.deepEqual(calls, ['node gates/甲.js 7', 'node gates/乙.js 7'], '閘照跑，但合併鍵不按');
  assert.match(r.lines.join('\n'), /跑閘途中版本變了/u);
  assert.deepEqual(moved.asked, ['change', 'change'], '開跑前讀一次、按鍵前再讀一次');
  const same = fakePlatform({ shas: [HEAD, HEAD] });
  const ok = fakeRunner([0, 0]);
  assert.equal(realMergeRun('7', { settings: settingsWith([gate('甲')]), run: ok.run, platform: same }).code, 0, '對照組：版本沒變就照常合併');
  assert.deepEqual(ok.calls, ['node gates/甲.js 7', 'platform merge 7']);
});

test('⑧問不到版本＝不放行：開跑前問不到就不跑閘；按鍵前問不到就不按', () => {
  const first = fakeRunner([]);
  const r1 = realMergeRun('7', { settings: settingsWith([gate('甲')]), run: first.run, platform: fakePlatform({ fail: [1] }) });
  assert.equal(r1.code, 2);
  assert.deepEqual(first.calls, [], '連要驗哪一版都不知道，閘也不跑');
  const second = fakeRunner([0]);
  const r2 = realMergeRun('7', { settings: settingsWith([gate('甲')]), run: second.run, platform: fakePlatform({ fail: [2] }) });
  assert.equal(r2.code, 2);
  assert.deepEqual(second.calls, ['node gates/甲.js 7'], '閘跑了，但核不了版本就不按');
});

test('⑨記號：{sha}、{project}、{reviewer}、{merger} 都填進合併指令（誰審、誰合、只合這一版）', () => {
  const args = ['merge', '{change}', '-R', '{project}', '--match-head-commit', '{sha}', '--body', 'Reviewed-By: {reviewer}\nMerged-By: {merger}'];
  const settings = settingsWith([gate('甲')], { platform: { project: 'owner/repo' }, mergeCommand: { command: 'platform', args } });
  const { run, calls } = fakeRunner([0]);
  const r = realMergeRun('7', { settings, run, platform: fakePlatform(), merger: 'alpha' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.equal(calls[1], `platform merge 7 -R owner/repo --match-head-commit ${HEAD} --body Reviewed-By: Beta\nMerged-By: Alpha`);
  assert.doesNotMatch(r.lines.join('\n'), /⚠️ 合併指令沒有帶/u, '都帶了就不提醒');
  const plain = mergeRun('7', { settings: settingsWith([gate('甲')]), run: fakeRunner([0]).run });
  assert.match(plain.lines.join('\n'), /沒有帶 \{reviewer\}／\{merger\}/u, '沒帶誰審誰合要提醒');
  assert.match(plain.lines.join('\n'), /沒有帶 \{sha\}/u, '沒帶版本要提醒');
});

test('⑨記號填不出來就不放行；跑閘前驗得了的先驗', () => {
  const withArgs = (args, extra = {}) => settingsWith([gate('甲')], { platform: { project: 'owner/repo' }, mergeCommand: { command: 'platform', args }, ...extra });
  const cases = [
    ['沒報合併者', withArgs(['merge', '{change}', '{merger}']), {}, /沒有用 --merger 報名字/u],
    ['合併者不是登記過的參與者', withArgs(['merge', '{change}', '{merger}']), { merger: 'Mallory' }, /不是登記過的參與者/u],
    ['認不得的記號', withArgs(['merge', '{change}', '--match-head-commit', '{hash}']), {}, /認不得的記號：\{hash\}/u],
    ['專案名沒填', withArgs(['merge', '{change}', '{project}'], { platform: { project: UNSET } }), {}, /platform\.project 還沒填/u],
  ];
  for (const [why, settings, opts, re] of cases) {
    const { run, calls } = fakeRunner([0]);
    const r = mergeRun('7', { settings, run, ...opts });
    assert.equal(r.code, 2, why);
    assert.deepEqual(calls, [], `${why}：跑閘前就該停`);
    assert.match(r.lines.join('\n'), re, why);
  }
  // 審查者要讀變更說明，只能在按鍵前驗：讀不出來＝閘跑了、鍵不按
  const { run, calls } = fakeRunner([0]);
  const r = realMergeRun('7', { settings: withArgs(['merge', '{change}', '{reviewer}']), run, platform: fakePlatform({ body: '實作者：Alpha\n' }) });
  assert.equal(r.code, 2);
  assert.deepEqual(calls, ['node gates/甲.js 7']);
  assert.match(r.lines.join('\n'), /讀不出一位登記過的參與者/u);
});

test('⑩閘退 1＝擋下（退 1）；退 2 或其他非零＝查不清楚（退 2）', () => {
  for (const [gateCode, want, re] of [[1, 1, /擋下來了/u], [2, 2, /查不清楚或根本起不來/u], [127, 2, /查不清楚或根本起不來/u]]) {
    const { run, calls } = fakeRunner([gateCode]);
    const r = mergeRun('7', { settings: settingsWith([gate('甲'), gate('乙')]), run });
    assert.equal(r.code, want, `閘退 ${gateCode}`);
    assert.deepEqual(calls, ['node gates/甲.js 7'], `閘退 ${gateCode}：停在那一道`);
    assert.match(r.lines.join('\n'), re);
  }
});

test('指令列：編號與 --merger 的位置不拘', () => {
  assert.deepEqual(parseArgs(['7', '--merger', 'Beta']), { changeId: '7', merger: 'Beta' });
  assert.deepEqual(parseArgs(['--merger', 'Beta', '7']), { changeId: '7', merger: 'Beta' });
  assert.deepEqual(parseArgs([]), { changeId: undefined, merger: undefined });
});

test('⑨GitHub 範本的合併指令真的填得完：誰審、誰合兩行＋只合核過的那一版，沒有殘留記號', () => {
  const doc = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'templates', 'platform-github.json'), 'utf8'));
  const settings = settingsWith([gate('甲')], { platform: { project: 'owner/repo' }, mergeCommand: doc.mergeCommand });
  const { run, calls } = fakeRunner([0]);
  const r = realMergeRun('7', { settings, run, platform: fakePlatform(), merger: 'Alpha' });
  assert.equal(r.code, 0, r.lines.join('\n'));
  assert.doesNotMatch(calls[1], /\{[a-z]+\}/u, `展開後還有記號：${calls[1]}`);
  assert.match(calls[1], new RegExp(`--match-head-commit ${HEAD}`, 'u'));
  assert.match(calls[1], /--body Reviewed-By: Beta\nMerged-By: Alpha$/u);
});

test('⑪合併指令沒有 {change}＝不放行，閘都不跑（搬家前準備）', () => {
  const { run, calls } = fakeRunner([0]);
  const r = mergeRun('7', { settings: settingsWith([gate('甲')], { mergeCommand: { command: 'platform', args: ['merge', '--squash'] } }), run });
  assert.equal(r.code, 2);
  assert.deepEqual(calls, [], '跑閘之前就該停');
  assert.match(r.lines.join('\n'), /沒有 \{change\}/u);
});

test('⑪真的預設執行器：按合併鍵時清掉 platform.clearEnv 登記的變數，其他照留（搬家前準備）', () => {
  const prev = { A: process.env.KIT_PICK_SITE_TEST, B: process.env.KIT_KEEP_TEST };
  process.env.KIT_PICK_SITE_TEST = 'other.example';
  process.env.KIT_KEEP_TEST = 'keep';
  try {
    const probe = 'process.stdout.write(JSON.stringify({ pick: "KIT_PICK_SITE_TEST" in process.env, keep: process.env.KIT_KEEP_TEST || null }))';
    const r = runCommand(process.execPath, ['-e', probe], { clearEnv: ['KIT_PICK_SITE_TEST'] });
    assert.deepEqual(JSON.parse(r.output), { pick: false, keep: 'keep' });
    // mergeRun 真的把 clearEnv 傳到按鍵那一步（假執行器記下收到的選項）
    let seen = null;
    const settings = settingsWith([gate('甲')], { platform: { clearEnv: ['KIT_PICK_SITE_TEST'] } });
    realMergeRun('7', { settings, platform: fakePlatform(), run: (cmd, args, opts) => { if (cmd === 'platform') seen = opts; return { code: 0, output: '' }; } });
    assert.deepEqual(seen, { clearEnv: ['KIT_PICK_SITE_TEST'] }, '按鍵那一步要帶著專案登記的清單');
  } finally {
    for (const [k, v] of [['KIT_PICK_SITE_TEST', prev.A], ['KIT_KEEP_TEST', prev.B]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
