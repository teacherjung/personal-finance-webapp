// 設定污染反證（搬家前準備）：專案填了真設定之後，整份考卷在「每一欄都填了」的設定底下跑，不可以碰到外面。
//
// 為什麼：套件搬進專案後，這份考卷會跟著專案的推送前檢查、雲端、跨變更臨時樹一起跑，而工具的預設參數讀的是
// 根目錄那份設定。哪一題（或它叫的工具）漏了自己帶設定，就會照真設定去問平台、跑三關、在禁區埋假機密、按合併鍵
// ——2026-09-13 端到端實際發生過（在真家目錄埋假機密約十次）。目前靠「在空白設定的複本裡跑指令入口」
// （tests/helpers/kit-copy.js）與審查守著，沒有機器保證；這一題就是那個機器。
//
// 做法：在暫存目錄搭一份套件複本，設定**每一欄都填成假的**——對外的指令（平台動作、合併指令、三關、隔離前綴）
// 換成只記錄、退 97 的錄音機，禁區與家目錄換成暫存目錄，PATH 最前面放一個只記錄的假 gh——整份考卷跑一遍。
// 要：全綠、錄音機零次、禁區與家目錄**零寫入**。對照組：同一份假設定直接跑一支工具，錄音機要真的記到（證明設定填得夠滿、
// 錄音機真的在錄）。
// 「零寫入」不是只看最後有沒有殘留（搬家前準備 r1 B1：原事故正是「埋進去再收乾淨」，最後一看是空的）：
// 禁區與家目錄一開始都是空的，所以任何**留下名字的**寫入（建檔、建目錄，就算之後刪掉）一定在它們的第一層新增過一筆——
// 那會改掉目錄自己的修改時間。⚠️ 不留名字的寫法看不到（例如 Linux 的 O_TMPFILE 建的無名檔；搬家前準備 r2 T1），
// 目前考卷沒有這種呼叫，要引入之前另補能觀測它的防線。
// 跑之前先把修改時間設成一個過去的固定值，跑完要一模一樣；再自己寫一筆又刪掉，確認這個檔案系統上真的看得出來（對照組）。
// 為什麼不在真樹上跑：真設定的禁區可能是絕對路徑（例如 /private/tmp），換家目錄護不到；而且那正是要防的事。
//
// ⚠️ 巢狀：複本裡的這一題與「誘餌倉庫」那題（也會整份考卷重跑）看到 KIT_NESTED_SUITE=1 就標成跳過，
//    免得無限巢狀；跳過在報告裡是 skipped，不是靜靜通過。
// 案例簿：複本**一律不帶** cases/、把那一列登記成未移植（不帶案例簿的專案的樣子）；案例簿考題只讀設定的機器表那一列、不叫外面，
//   所以巢狀那一輪固定走「不帶」那條路，而且這一題核對它真的走了（四題跳過、原因寫出來）。帶案例簿時的完整檢查由外層那一輪做
//   （套件自己的倉庫）；在不帶案例簿的專案裡，外層同樣是跳過。
// ⚠️ 守不到的：考題沒走到的分支；考題自己寫死、既不讀設定也不叫 gh 的外部呼叫；
//   假 gh 只攔「保留測試環境 PATH 的 gh 呼叫」——用絕對路徑叫 gh、或經過會重建 PATH 的 shell（例如 sh -lc）就攔不到，
//   這不是程序層級的禁止連網（r1 T2）；禁區與家目錄以外的地方被寫，這一題看不到。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const { OPERATIONS } = require('../tools/platform.js');
const { unfilled } = require('./helpers/kit-copy.js');
const { MACHINE: CASEBOOK, NOT_CARRIED_REASON } = require('../tools/build-casebook-index.js');

const ROOT = path.join(__dirname, '..');
const NESTED = process.env.KIT_NESTED_SUITE === '1';
/** 工具與考題從根目錄讀的那幾份（套件倉庫 README「搬進一個專案」第 1 步同一份清單）。 */
const ROOT_FILES = ['settings.json', 'rules.json', 'RULES.md', 'MACHINES.md', 'PROJECT-SETTINGS.md'];
const ROOT_DIRS = ['tools', 'tests', 'templates'];   // cases/ 刻意不帶（上面「案例簿」那段）

/** 只記錄、退 97 的錄音機（一條 argv）。 */
const recorder = (log, tag) => [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(tag)} + ' ' + process.argv.slice(1).join(' ') + '\\n'); process.exit(97)`];

/** 從空白設定出發，每一欄填成假的（形狀不變，settings.test ⑨ 盯著形狀）。 */
function fakeFilled({ log, box, zones }) {
  const s = unfilled();
  s.participants = s.participants.map((p, i) => ({ ...p, id: ['Boss', 'Alpha', 'Beta'][i] || `Extra${i}`, account: i === 0 ? 'boss-acct' : 'ai-acct' }));
  s.sources = [{ tool: '假的 CLI', string: 'CLI' }];
  for (const loc of s.locations) loc.where = '假的位置';
  s.mainBranch = 'main';
  s.mergeAuthorization = '假的授權';
  s.scanner = { tool: '假的掃描器', assignedBy: 'Alpha', tieBreak: '無', fallback: '無', isolation: { provider: '專案自建', wrap: [...recorder(log, 'isolation'), '{box}'], boxRoot: box, forbidden: zones } };
  s.platform = {
    name: 'Fake', project: 'fake/repo', clearEnv: ['GH_REPO'],
    operations: Object.fromEntries(Object.entries(OPERATIONS).map(([name, op]) => [name, [...recorder(log, `op:${name}`), ...op.params.map((p) => `{${p}}`)]])),
  };
  s.forbidden = { name: '錢', servers: ['broker-x'], allowlist: ['get_watchlist'], deny: ['mcp__o__x'], verbs: ['create', 'place'], nouns: ['order'], readPrefixes: ['get'], patterns: [] };
  s.acceptance = { tiers: [{ id: '重', action: '重啟' }, { id: '輕', action: '看一眼' }], families: [{ pattern: '^lib/', tier: '重' }, { pattern: '^docs/', tier: '輕' }], unknownTier: '重' };
  s.checks = { prepareWorktree: recorder(log, 'prepare'), commands: [recorder(log, 'check')], mainWorktree: '一般工作樹', indexAnchors: ['README.md'] };   // 準備指令也填成有動作的（r1 T1：填「無」＝這一格沒考到）；兩個選填登記也填成登記了的樣子
  s.gates = s.gates.map((g) => ({ ...g, state: '已啟用' }));
  s.mergeCommand = { command: process.execPath, args: [...recorder(log, 'merge').slice(1), '{change}', '--match-head-commit', '{sha}', '--body', 'Reviewed-By: {reviewer}\nMerged-By: {merger}'] };
  s.machines = s.machines.map((m) => {
    if (m.name === CASEBOOK) return { ...m, state: '未移植', verified: '' };   // 複本不帶案例簿
    return m.state === '未移植' ? m : { ...m, state: '已啟用', verified: '2026-09-15' };
  });
  return s;
}

test('整份考卷在「每一欄都填了假值」的設定底下跑：全綠，而且錄音機、禁區、家目錄都沒被碰到', { skip: NESTED ? '巢狀整卷裡不再巢狀' : false }, () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-filled-'));
  try {
    const copy = path.join(scratch, 'kit');
    const home = path.join(scratch, 'home');
    const bin = path.join(scratch, 'bin');
    const box = path.join(scratch, 'box');
    const zones = [path.join(scratch, 'zone-a'), path.join(scratch, 'zone-b')];
    const log = path.join(scratch, 'outside-calls.log');
    for (const d of [copy, home, bin, box, ...zones]) fs.mkdirSync(d, { recursive: true });
    // 修改時間設成過去的固定值：之後在第一層新增或刪除任何一筆都會把它改成「現在」
    const PAST = new Date('2001-02-03T04:05:06Z');
    const watched = [...zones, home];
    const stamp = (d) => fs.statSync(d).mtimeMs;
    for (const d of ROOT_DIRS) fs.cpSync(path.join(ROOT, d), path.join(copy, d), { recursive: true });
    for (const f of ROOT_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(copy, f));
    const settings = fakeFilled({ log, box, zones });
    fs.writeFileSync(path.join(copy, 'settings.json'), `${JSON.stringify(settings, null, 1)}\n`);
    for (const { file, patterns } of settings.ignoreLists) fs.writeFileSync(path.join(copy, file), `${patterns.join('\n')}\n`);
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\necho "gh $*" >> ${JSON.stringify(log)}\nexit 97\n`, { mode: 0o755 });

    const env = { ...gitEnv(), HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, KIT_NESTED_SUITE: '1' };
    delete env.NODE_TEST_CONTEXT;   // 不拿掉的話子行程的 node --test 不管紅不紅都退 0
    const sh = (args) => spawnSync(args[0], args.slice(1), { cwd: copy, env, encoding: 'utf8' });
    assert.ok(!fs.existsSync(path.join(copy, 'cases')), '前提：複本不帶案例簿');
    assert.deepEqual(settings.machines.filter((m) => m.name === CASEBOOK).map((m) => m.state), ['未移植'], '前提：複本把案例簿登記成不帶');
    const build = sh([process.execPath, 'tools/build-settings.js']);
    assert.equal(build.status, 0, `前提：假設定產得出設定說明（${build.stderr}）`);
    for (const step of [['git', 'init', '-q'], ['git', 'add', '-A']]) assert.equal(sh(step).status, 0, `前提：複本要是版本控制目錄（git ${step[1]}）`);

    for (const d of watched) fs.utimesSync(d, PAST, PAST);
    // 報告格式固定成 spec：下面數跳過原因靠的是報告文字（裁示批 r1 T1：換成別的格式會假紅）
    const r = sh([process.execPath, '--test', '--test-reporter=spec']);
    const failing = r.stdout.split('\n').filter((l) => /^✖|^not ok/u.test(l)).slice(0, 12).join('\n');
    assert.equal(r.status, 0, `填了假設定的整份考卷不是全綠：\n${failing}`);
    const skippedCasebook = r.stdout.split(NOT_CARRIED_REASON).length - 1;
    assert.equal(skippedCasebook, 4, `巢狀那一輪要走「不帶案例簿」那條路：四題跳過、各寫一次原因（實際 ${skippedCasebook} 次）`);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
    assert.equal(calls, '', `有考題照設定去叫了外面（平台、合併、三關、隔離或 gh）：\n${calls.split('\n').slice(0, 8).join('\n')}`);
    for (const d of watched) {
      const name = d === home ? '家目錄' : `禁區 ${path.basename(d)}`;
      assert.deepEqual(fs.readdirSync(d), [], `${name}被留下了東西`);
      assert.equal(stamp(d), PAST.getTime(), `${name}被寫過（第一層新增或刪除過東西，就算最後收乾淨了）`);
    }
    // 對照組：自己在禁區寫一筆又刪掉，修改時間要真的變——不然上面的「一模一樣」在這個檔案系統上證明不了什麼
    fs.writeFileSync(path.join(zones[0], 'control.txt'), 'x');
    fs.rmSync(path.join(zones[0], 'control.txt'));
    assert.deepEqual(fs.readdirSync(zones[0]), [], '對照組：寫了又刪，最後是空的');
    assert.notEqual(stamp(zones[0]), PAST.getTime(), '對照組：寫了又刪，修改時間要變（看不出來的話這一題的零寫入不成立）');

    // 對照組：同一份假設定直接跑一支會問平台的工具，錄音機要真的記到——不然上面的「零次」證明不了什麼
    const probe = sh([process.execPath, 'tools/pending-rulings.js']);
    assert.equal(probe.status, 2, `對照組：平台動作被錄音機退 97，工具要判問不到（${probe.stdout}）`);
    assert.match(fs.readFileSync(log, 'utf8'), /^op:allComments /mu, '對照組：錄音機要記到那一次平台動作');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
