// 守開工與送審前體檢總表（tools/preflight.js）：
//   ①參數解析：不給編號＝開工前模式（待裁、待辦、下游落後、AI 座位 4 項）；給編號＝送審前模式（加跑舊文字掃描與風險分級共 6 項）；
//     支援 --base、--skip-downstream、--skip-seats；不認得的旗標或多給位置參數＝退 2；
//   ②總退出碼：全部子項目退 0 才退 0；任一子項目退非 0（或拋錯）時總退出碼為 2，但後續子項目仍照常跑完印出；
//   ③AI 座位體檢（checkSeats）：從 reviewers 與 scanner 收集座位、辨識一般指令與 --grok-exec 沙盒指令；
//     只驗執行檔與 Grok 盒外 auth.json 一般檔案存在（連結檔不算），絕不讀取或輸出 auth.json 裡的私密內容；
//   ④真的跑一遍指令（空白設定的複本）：設定未填時退 2；
//   ⑤真 CLI 長輸出經管線與普通檔案 fd 逐位元組一致（避免超過 64 KiB 管線緩衝未排空即截斷尾段），且 EPIPE 退 2。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitEnv } = require('../tools/git-env.js');
const { run, parseArgs, checkOpenChanges, checkSeats, probeSeats, summarizeProbeFailure, extractCommandSpec, defaultWhich } = require('../tools/preflight.js');
const { runInCopy, unfilled } = require('./helpers/kit-copy.js');

test('① parseArgs 與 extractCommandSpec：合法參數與壞參數分類', async () => {
  assert.deepEqual(parseArgs([]), { change: undefined, base: undefined, skipDownstream: false, skipSeats: false });
  assert.deepEqual(parseArgs(['115', '--base', 'origin/main', '--skip-downstream', '--skip-seats']), {
    change: '115',
    base: 'origin/main',
    skipDownstream: true,
    skipSeats: true,
  });
  assert.deepEqual(parseArgs(['--probe']), { change: undefined, base: undefined, skipDownstream: false, skipSeats: false, probe: '*' });
  assert.deepEqual(parseArgs(['--probe', 'Codex']), { change: undefined, base: undefined, skipDownstream: false, skipSeats: false, probe: 'Codex' });
  assert.deepEqual(parseArgs(['134', '--probe=Grok']), { change: '134', base: undefined, skipDownstream: false, skipSeats: false, probe: 'Grok' });
  for (const bad of [['--base'], ['--base', '--skip-seats'], ['--unknown'], ['1', '2'], ['--probe='], ['--probe', '--skip-seats']]) {
    assert.ok(parseArgs(bad).error, `應拒收壞參數：${bad.join(' ')}`);
    assert.equal((await run(bad)).code, 2);
  }
  assert.deepEqual(extractCommandSpec('codex exec --cd {reviewTree}'), { bin: 'codex', usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('cd {reviewTree} && claude -p --model {model}'), { bin: 'claude', usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('cd {scanTree} && GEMINI_EFFORT={effort} gemini -p -m {model}'), { bin: 'gemini', usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('/custom/dir/gemini -p'), { bin: '/custom/dir/gemini', usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('cd {reviewTree}'), { bin: null, usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('node tools/review-launch.js --grok-exec --mode scan --cwd {scanTree}'), { bin: 'grok', usesGrokExec: true });
  assert.deepEqual(extractCommandSpec('未設定'), { bin: null, usesGrokExec: false });
});

test('② 開工前模式（4 項）與送審前模式（6 項）：串接各子工具，任一項非 0 時總退出碼為 2 但其餘照跑', async () => {
  const called = [];
  const fakeRunners = (failId = null) => ({
    pendingRulings: () => { called.push('pending'); return { code: failId === 'pending' ? 2 : 0, lines: ['pending-line'] }; },
    backlogTouch: ({ argv }) => { called.push(`backlog:${argv.join(' ')}`); return { code: 0, lines: ['backlog-line'] }; },
    downstreamLag: () => { called.push('downstream'); return { code: failId === 'downstream' ? 2 : 0, lines: ['downstream-line'] }; },
    staleText: (argv) => { called.push(`stale:${argv.join(' ')}`); return { code: 0, lines: ['stale-line'] }; },
    riskTier: (id) => { called.push(`risk:${id}`); return { code: 0, lines: [`risk-line-${id}`] }; },
    seats: () => { called.push('seats'); return { code: 0, lines: ['seats-line'] }; },
  });

  // (a) 開工前模式：跑 4 項
  const preWork = await run(['--base', 'HEAD~1'], { runners: fakeRunners() });
  assert.equal(preWork.code, 0);
  assert.deepEqual(called, ['pending', 'backlog:--base HEAD~1', 'downstream', 'seats']);
  assert.match(preWork.lines.join('\n'), /開工前模式｜共 4 項/u);

  // (b) 送審前模式：跑 6 項
  called.length = 0;
  const preReview = await run(['115', '--base', 'HEAD~1'], { runners: fakeRunners() });
  assert.equal(preReview.code, 0);
  assert.deepEqual(called, ['pending', 'backlog:--base HEAD~1', 'downstream', 'stale:--base HEAD~1', 'risk:115', 'seats']);
  assert.match(preReview.lines.join('\n'), /送審前模式（變更 115）｜共 6 項/u);

  // (c) 中途有子工具退 2 時，後面子工具仍照跑，且總退出碼為 2
  called.length = 0;
  const partialFail = await run(['--skip-seats'], { runners: fakeRunners('pending') });
  assert.equal(partialFail.code, 2);
  assert.deepEqual(called, ['pending', 'backlog:', 'downstream']);

  // (d) 中途有子工具拋錯時，該節記為退 2、總退出碼為 2，且後面子工具仍照跑（r4 Finding 1）
  called.length = 0;
  const thrownRun = await run(['--skip-seats'], {
    runners: {
      ...fakeRunners(),
      pendingRulings: () => { called.push('pending-throw'); throw new Error('子工具炸了'); },
    },
  });
  assert.equal(thrownRun.code, 2);
  assert.equal(thrownRun.sections[0].code, 2);
  assert.match(thrownRun.lines.join('\n'), /未預期錯誤（子工具炸了）——算不出來/u);
  assert.deepEqual(called, ['pending-throw', 'backlog:', 'downstream']);

  // (e) 中途有子工具回傳壞形狀時，該節記為退 2、總退出碼為 2，且後面子工具仍照跑
  called.length = 0;
  const badShapeRun = await run(['--skip-seats'], {
    runners: {
      ...fakeRunners(),
      pendingRulings: () => { called.push('pending-null'); return null; },
    },
  });
  assert.equal(badShapeRun.code, 2);
  assert.equal(badShapeRun.sections[0].code, 2);
  assert.match(badShapeRun.lines.join('\n'), /回傳格式不對——算不出來/u);
  assert.deepEqual(called, ['pending-null', 'backlog:', 'downstream']);
});

test('③ checkSeats 與 defaultWhich：AI 座位體檢、保留明確路徑、同人雙角色命令聯集，且盒外憑證只 lstatSync 絕不讀取或輸出內容', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-preflight-test-'));
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    for (const name of ['claude', 'codex', 'gemini', 'grok']) {
      const p = path.join(binDir, name);
      fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 });
    }
    assert.equal(defaultWhich('codex', { env: { PATH: binDir }, homedir: tmp }), path.join(binDir, 'codex'));
    assert.equal(defaultWhich('no-such-cli', { env: { PATH: binDir }, homedir: tmp }), null);
    assert.equal(defaultWhich(path.join(tmp, 'no-such-dir', 'gemini'), { env: { PATH: binDir }, homedir: tmp }), null, '帶明確路徑時只查該路徑，不拿 PATH 同名檔冒充');

    const secretMarker = 'SUPER-SECRET-GROK-BEARER-DO-NOT-READ';
    const grokDir = path.join(tmp, '.grok');
    const grokBinDir = path.join(grokDir, 'bin');
    fs.mkdirSync(grokBinDir, { recursive: true });
    const grokFixedBin = path.join(grokBinDir, 'grok');
    fs.writeFileSync(grokFixedBin, '#!/bin/sh\n', { mode: 0o755 });
    const authFile = path.join(grokDir, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ key: secretMarker }), { mode: 0o600 });

    let lstatCalls = 0;
    let readCalls = 0;
    const denyRead = (target) => {
      if (String(target) === authFile) readCalls += 1;
      throw new Error(`禁止讀取憑證檔內容：${target}`);
    };
    const spyFs = {
      ...fs,
      lstatSync: (p, ...rest) => {
        if (String(p) === authFile) lstatCalls += 1;
        return fs.lstatSync(p, ...rest);
      },
      readFileSync: denyRead,
      readFile: denyRead,
      openSync: denyRead,
      open: denyRead,
      createReadStream: denyRead,
    };

    const settings = {
      defaultDivision: { implementer: 'Gemini', reviewer: 'Codex' },
      reviewers: [
        { participant: 'Claude', source: 'Claude Code', strongest: 'claude-opus-4-7', maxEffort: 'xhigh', command: 'claude -p' },
        { participant: 'Codex', source: 'Codex CLI', strongest: 'gpt-5.4', maxEffort: 'xhigh', command: 'codex exec' },
        { participant: 'Gemini', source: 'Gemini CLI', strongest: 'gemini-3.1-pro-preview', maxEffort: 'high', command: 'gemini -p' },
        { participant: 'Grok', source: 'Grok CLI', strongest: 'grok-4.7', maxEffort: 'xhigh', command: 'node tools/review-launch.js --grok-exec --mode review' },
      ],
      scanner: {
        participant: 'Grok',
        tool: 'Grok CLI',
        source: 'Grok CLI',
        strongest: 'grok-4.7',
        maxEffort: 'xhigh',
        command: 'node tools/review-launch.js --grok-exec --mode scan',
      },
    };

    const okRes = checkSeats(settings, {
      which: (b) => defaultWhich(b, { env: { PATH: binDir }, homedir: tmp, fsImpl: spyFs }),
      authFile,
      fsImpl: spyFs,
    });
    assert.equal(okRes.code, 0);
    assert.equal(okRes.seats.length, 4);
    assert.ok(okRes.seats.every((s) => s.ok), '各家 CLI 與 Grok auth.json 皆就緒');
    assert.equal(okRes.seats.find((s) => s.participant === 'Grok').binPath, grokFixedBin, '--grok-exec 座位對應 ~/.grok/bin/grok 固定執行檔');
    assert.ok(lstatCalls > 0, '有執行 lstatSync 檢查狀態');
    assert.equal(readCalls, 0, '絕不呼叫任何檔案讀取 API 讀取 auth.json 內容');
    assert.equal(okRes.lines.join('\n').includes(secretMarker), false, '絕不可讀取或印出 auth.json 內的憑證內容');

    // --grok-exec 座位固定走 ~/.grok/bin/grok：即使 PATH 有同名 grok，固定執行檔缺席仍必須報未就緒（r2 Finding 1）
    const missingFixedGrokBinRes = checkSeats(settings, {
      which: (b) => defaultWhich(b, { env: { PATH: binDir }, homedir: tmp }),
      authFile,
      grokBin: path.join(tmp, 'missing-grok-home', '.grok', 'bin', 'grok'),
    });
    const missingFixedGrokSeat = missingFixedGrokBinRes.seats.find((s) => s.participant === 'Grok');
    assert.equal(missingFixedGrokSeat.binPath, null, '~/.grok/bin/grok 不存在時不可被 PATH 同名 grok 假綠');
    assert.equal(missingFixedGrokSeat.ok, false);

    // 指定了不存在的絕對路徑時，即使 PATH 有同名 gemini 也必須報未就緒（Finding 2）
    const badPathRes = checkSeats({
      ...settings,
      reviewers: [
        { participant: 'Gemini', source: 'Gemini CLI', strongest: 'gemini-3.1-pro-preview', maxEffort: 'high', command: `${path.join(tmp, 'no-such-dir', 'gemini')} -p` },
      ],
      scanner: { tool: '無' },
    }, {
      which: (b) => defaultWhich(b, { env: { PATH: binDir }, homedir: tmp }),
      authFile,
    });
    assert.equal(badPathRes.seats[0].ok, false, '明確路徑不存在時不可因 PATH 同名執行檔而報就緒');

    // 同一參與者複審用一般指令（grok -p）、掃描用 --grok-exec 時，仍必須檢查盒外憑證檔（Finding 3）
    const splitRoleRes = checkSeats({
      defaultDivision: { implementer: 'Gemini', reviewer: 'Grok' },
      reviewers: [
        { participant: 'Grok', source: 'Grok CLI', strongest: 'grok-4.7', maxEffort: 'xhigh', command: 'grok -p' },
      ],
      scanner: {
        participant: 'Grok',
        tool: 'Grok CLI',
        source: 'Grok CLI',
        strongest: 'grok-4.7',
        maxEffort: 'xhigh',
        command: 'node tools/review-launch.js --grok-exec --mode scan',
      },
    }, {
      which: (b) => defaultWhich(b, { env: { PATH: binDir }, homedir: tmp }),
      authFile: path.join(tmp, 'missing-auth.json'),
    });
    assert.equal(splitRoleRes.seats[0].usesGrokExec, true, '同名座位其中一角走 --grok-exec 時必須驗憑證檔');
    assert.equal(splitRoleRes.seats[0].authReady, false);
    assert.equal(splitRoleRes.seats[0].ok, false);

    // 符號連結的 auth.json 不算一般檔案
    const linkAuth = path.join(tmp, 'link-auth.json');
    fs.symlinkSync(authFile, linkAuth);
    const linkRes = checkSeats(settings, {
      which: (b) => defaultWhich(b, { env: { PATH: binDir }, homedir: tmp }),
      authFile: linkAuth,
    });
    const grokSeat = linkRes.seats.find((s) => s.participant === 'Grok');
    assert.equal(grokSeat.authReady, false);
    assert.equal(grokSeat.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('④ 真的跑一遍指令（空白設定的複本）：設定未填，退 2', () => {
  assert.equal(runInCopy('tools/preflight.js', ['--skip-downstream', '--skip-seats']).status, 2);
});

test('⑤ 真 CLI 長輸出經管線與普通檔案 fd 逐位元組一致；成功退 0、管線寫入錯誤（EPIPE）退 2', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-pipe-'));
  try {
    const kitRoot = path.join(__dirname, '..');
    fs.cpSync(path.join(kitRoot, 'tools'), path.join(dir, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(kitRoot, 'rules.json'), path.join(dir, 'rules.json'));
    const env = gitEnv();
    delete env.NODE_TEST_CONTEXT;
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
    spawnSync('git', ['config', 'user.email', 't@e.st'], { cwd: dir, env });
    spawnSync('git', ['config', 'user.name', 'T'], { cwd: dir, env });
    fs.writeFileSync(path.join(dir, 'BACKLOG.md'), '# 待辦\n\n- 哨兵待辦項目（TAIL_BACKLOG_SENTINEL_9999）｜settings.json｜當動到設定時\n');
    spawnSync('git', ['add', 'BACKLOG.md', 'tools/preflight.js'], { cwd: dir, env });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env });
    spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir, env });

    const comments = Array.from({ length: 1200 }, (_, i) => ({
      id: String(100000 + i),
      author: 'ai-acct',
      createdAt: new Date(Date.UTC(2026, 8, 13, 0, Math.floor(i / 60), i % 60)).toISOString(),
      change: String((i % 20) + 1),
      body: `## ❓ 待裁（2026-09-13）：體檢總表長輸出管線完整性第 ${String(i + 1).padStart(4, '0')} 題（避免超過 64 KiB 管線緩衝未排空即 process.exit 截斷尾段）\n選項：甲／乙\n建議：甲`,
    }));
    fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify(comments));
    fs.writeFileSync(path.join(dir, 'dump-comments.js'), "const fs = require('node:fs'); process.stdout.write(fs.readFileSync('comments.json'));\n");
    const baseSettings = unfilled();
    const settings = {
      ...baseSettings,
      owner: 'Boss',
      participants: [
        { role: '裁示者（人）', id: 'Boss', account: 'boss-acct' },
        { role: 'AI 甲', id: 'Alpha', account: 'ai-acct' },
      ],
      mainBranch: 'main',
      backlog: { file: 'BACKLOG.md', section: '# 待辦' },
      platform: {
        ...baseSettings.platform,
        name: 'Fake',
        project: 'fake/repo',
        clearEnv: [],
        operations: {
          ...baseSettings.platform.operations,
          allComments: [process.execPath, 'dump-comments.js'],
        },
      },
    };
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    const cli = path.join(dir, 'tools/preflight.js');
    const cliArgs = ['--skip-downstream', '--skip-seats'];

    // 1. 普通檔案 fd 對照組
    const outFile = path.join(dir, 'out.txt');
    const fd = fs.openSync(outFile, 'w');
    let fileRes;
    try {
      fileRes = spawnSync(process.execPath, [cli, ...cliArgs], { cwd: dir, env, stdio: ['ignore', fd, 'pipe'] });
    } finally {
      fs.closeSync(fd);
    }
    assert.equal(fileRes.status, 0, fileRes.stderr && fileRes.stderr.toString('utf8'));
    const fileBytes = fs.readFileSync(outFile);
    assert.ok(fileBytes.length > 65536 * 2, `合成輸出需明顯大於 64 KiB 管線緩衝（實際 ${fileBytes.length} 位元組）`);
    const fileText = fileBytes.toString('utf8');
    assert.match(fileText, /體檢總表長輸出管線完整性第 1200 題/u);
    assert.match(fileText, /=== \[2\/2\] 開工印待辦（F6） ===/u, '檔案輸出尾端需含最後一節開工印待辦');
    assert.match(fileText, /TAIL_BACKLOG_SENTINEL_9999/u, '檔案輸出尾端需含待辦哨兵');

    // 2. 管線（pipe）輸出：必須與普通檔案 fd 逐位元組完全一致，不可在 65,536 位元組處截斷尾段
    const pipeRes = spawnSync(process.execPath, [cli, ...cliArgs], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(pipeRes.status, 0, pipeRes.stderr && pipeRes.stderr.toString('utf8'));
    assert.equal(pipeRes.stdout.length, fileBytes.length, `管線輸出位元組數（${pipeRes.stdout.length}）與檔案 fd（${fileBytes.length}）不一致`);
    assert.equal(Buffer.compare(pipeRes.stdout, fileBytes), 0, '管線輸出與檔案 fd 必須逐位元組完全相同');
    assert.match(pipeRes.stdout.toString('utf8'), /=== \[2\/2\] 開工印待辦（F6） ===/u, '管線輸出不得丟失末尾待辦節');
    assert.match(pipeRes.stdout.toString('utf8'), /TAIL_BACKLOG_SENTINEL_9999/u, '管線輸出不得丟失末尾待辦哨兵');

    // 3. 下游提早關閉管線（EPIPE）：必須退 2，不可假綠退 0 或未處理錯誤退 1
    const epipeExit = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...cliArgs], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let errOut = '';
      child.stderr.on('data', (chunk) => { errOut += chunk.toString('utf8'); });
      child.stdout.once('data', () => { child.stdout.destroy(); });
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, errOut }));
    });
    assert.equal(epipeExit.signal, null);
    assert.equal(epipeExit.code, 2, `下游提早關閉管線（EPIPE）應退 2（實際 code=${epipeExit.code}, stderr=${epipeExit.errOut}）`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⑥ C1 開啟支數提醒（checkOpenChanges）與 AI 座位十秒點火試跑（probeSeats / --probe）', async () => {
  // 1. checkOpenChanges：0 支、1 支（未達上限）、>=2 支（含草稿印 C1 黃燈提醒，只列不擋退 0）、平台失敗退 2，且呼叫簽章為 ask('openChanges', {}, { settings })
  let askCall = null;
  const fakeSettings = { platform: { project: 'fake/repo' } };
  const zeroOpen = checkOpenChanges({
    settings: fakeSettings,
    platform: {
      ask: (opName, args, opts) => {
        askCall = { opName, args, opts };
        return [];
      },
    },
  });
  assert.equal(zeroOpen.code, 0);
  assert.equal(askCall.opName, 'openChanges');
  assert.deepEqual(askCall.args, {});
  assert.equal(askCall.opts.settings, fakeSettings);
  assert.match(zeroOpen.lines[0], /目前開啟 0 支（未達 2 支上限；只列不擋）/u);

  const oneOpen = checkOpenChanges({ platform: { ask: () => [{ id: '134', isDraft: true }] } });
  assert.equal(oneOpen.code, 0);
  assert.match(oneOpen.lines[0], /目前開啟 1 支（#134（草稿））（未達 2 支上限；只列不擋）/u);

  const twoOpen = checkOpenChanges({
    platform: { ask: () => [{ id: '134', isDraft: false }, { id: '135', isDraft: true }] },
  });
  assert.equal(twoOpen.code, 0);
  assert.match(twoOpen.lines[0], /⚠️ 目前已開啟 2 支（#134、#135（草稿）），已達或超過 C1/u);

  const errOpen = checkOpenChanges({ platform: { ask: () => { throw new Error('網路斷線'); } } });
  assert.equal(errOpen.code, 2);
  assert.match(errOpen.lines[0], /問不到平台開啟中變更清單（網路斷線）——算不出來/u);

  // 2. probeSeats：成功輸出經 prepareVerdict 核驗通過、失敗輸出固定白名單分類且不洩漏短權杖或個資、指定未知座位退 2
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-probe-unit-'));
  try {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    for (const name of ['codex', 'claude']) {
      fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\n', { mode: 0o755 });
    }
    const settings = {
      participants: [
        { role: '裁示者（人）', id: 'Boss', account: 'boss' },
        { role: 'AI 甲', id: 'Codex', account: 'ai' },
        { role: 'AI 乙', id: 'Claude', account: 'ai' },
      ],
      defaultDivision: { implementer: 'Claude', reviewer: 'Codex' },
      platform: { project: 'fake/repo' },
      reviewers: [
        {
          participant: 'Codex',
          source: 'codex CLI',
          strongest: 'gpt-6-astra',
          maxEffort: 'max',
          command: 'codex exec -m {model} -c model_reasoning_effort=\'"max"\' -C {reviewTree} -o {outFile} - < {promptFile}',
        },
        {
          participant: 'Claude',
          source: 'Claude CLI',
          strongest: 'claude-fable-5-1',
          maxEffort: 'max',
          command: 'cd {reviewTree} && claude -p "$(cat {promptFile})" --model {model} --effort {effort} --verbose --output-format json > {outFile}',
        },
      ],
      scanner: { tool: '無' },
    };

    const which = (b) => defaultWhich(b, { env: { PATH: binDir }, homedir: tmp });

    // (a) 指定不存在的座位應退 2
    const unknownSeat = await probeSeats(settings, { seatFilter: 'NoSuchAI', which });
    assert.equal(unknownSeat.code, 2);
    assert.match(unknownSeat.lines[0], /找不到已登記的座位「NoSuchAI」/u);

    // (b) Codex 點火通過（提取 prompt 內的標準標頭寫入 outFile）、Claude 點火失敗（含 email 與短敏感值，確認白名單摘要完全不回顯原始敏感值，N4）
    const probeRes = await probeSeats(settings, {
      seatFilter: '*',
      which,
      spawnSyncImpl: (_bin, args) => {
        const cmdStr = args[1];
        const outMatch = /-o\s+([^\s]+)\s+-|(?:>\s*([^\s]+)$)/u.exec(cmdStr);
        const promptMatch = /<\s*([^\s]+)$|\$\(cat\s+([^)]+)\)/u.exec(cmdStr);
        const outFile = outMatch && (outMatch[1] || outMatch[2]);
        const promptFile = promptMatch && (promptMatch[1] || promptMatch[2]);
        if (cmdStr.includes('codex exec')) {
          const promptLines = fs.readFileSync(promptFile, 'utf8').split('\n').slice(1);
          fs.writeFileSync(outFile, promptLines.join('\n'));
          return { status: 0, stdout: '', stderr: '' };
        }
        fs.writeFileSync(outFile, JSON.stringify([
          { type: 'system', subtype: 'init' },
          {
            type: 'result',
            is_error: true,
            result: 'OAuth session expired for privateperson@example.invalid; refresh_token=private123',
          },
        ]));
        return { status: 1, stdout: '', stderr: '' };
      },
    });
    assert.equal(probeRes.code, 0);
    assert.equal(probeRes.probes.length, 2);
    assert.equal(probeRes.probes[0].participant, 'Codex');
    assert.equal(probeRes.probes[0].ok, true);
    assert.equal(probeRes.probes[1].participant, 'Claude');
    assert.equal(probeRes.probes[1].ok, false);
    const joinedLines = probeRes.lines.join('\n');
    assert.match(joinedLines, /Codex.*🟢 點火通過.*prepareVerdict/u);
    assert.match(joinedLines, /Claude.*🔴 點火失敗.*認證失敗（OAuth 或權杖已過期/u);
    assert.equal(joinedLines.includes('privateperson@example.invalid'), false, '白名單診斷摘要不得洩漏 email');
    assert.equal(joinedLines.includes('private123'), false, '白名單診斷摘要不得洩漏短權杖');
    assert.equal(probeRes.probes[1].reason.includes('privateperson@example.invalid'), false);
    assert.equal(probeRes.probes[1].reason.includes('private123'), false);
    assert.match(
      summarizeProbeFailure({ status: 1, stdout: '', stderr: '_ApiError [Error]: {\n  "message": "Your prepayment credits are depleted. account=secret999"\n}' }, '', null),
      /API 額度或預付餘額不足（HTTP 402/u,
    );
    assert.equal(
      summarizeProbeFailure({ status: 1, stdout: '', stderr: 'unexpected raw secret=my_short_pw_99' }, '', null).includes('my_short_pw_99'),
      false,
      '未知錯誤亦不得回顯原始 stderr',
    );

    // (c) N3：僅登記為掃描者（scanner-only）的座位，點火應準備合法 40-hex scan.json、送出 🔍 提示並以 prepareScan 核驗通過
    let observedScanMeta = null;
    const grokDir = path.join(tmp, '.grok');
    const grokBinDir = path.join(grokDir, 'bin');
    fs.mkdirSync(grokBinDir, { recursive: true });
    const fakeGrokBin = path.join(grokBinDir, 'grok');
    const fakeAuthFile = path.join(grokDir, 'auth.json');
    fs.writeFileSync(fakeGrokBin, '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(fakeAuthFile, '{"key":"dummy"}');
    const scannerOnlySettings = {
      participants: [
        { role: '裁示者（人）', id: 'Boss', account: 'boss' },
        { role: 'AI 掃描', id: 'Grok', account: 'ai' },
      ],
      defaultDivision: { implementer: 'Boss', reviewer: 'Boss' },
      platform: { project: 'fake/repo' },
      reviewers: [],
      scanner: {
        participant: 'Grok',
        tool: 'Grok 4.7',
        source: 'Grok CLI',
        strongest: 'grok-4.7',
        maxEffort: 'xhigh',
        command: 'node tools/review-launch.js --grok-exec --mode scan --cwd {scanTree} --prompt-file {promptFile} --out-file {outFile} --model {model} --effort {effort}',
      },
    };
    const scanProbeRes = await probeSeats(scannerOnlySettings, {
      seatFilter: 'Grok',
      env: { PATH: process.env.PATH },
      homedir: tmp,
      authFile: fakeAuthFile,
      grokBin: fakeGrokBin,
      spawnSyncImpl: (_bin, args) => {
        const cmdStr = args[1];
        const outFile = /--out-file\s+([^\s]+)/u.exec(cmdStr)[1];
        const promptFile = /--prompt-file\s+([^\s]+)/u.exec(cmdStr)[1];
        const scanJsonPath = path.join(path.dirname(outFile), 'scan.json');
        observedScanMeta = JSON.parse(fs.readFileSync(scanJsonPath, 'utf8'));
        const promptLines = fs.readFileSync(promptFile, 'utf8').split('\n').slice(1);
        fs.writeFileSync(outFile, promptLines.join('\n'));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(scanProbeRes.code, 0);
    assert.ok(observedScanMeta && /^[0-9a-f]{40}$/u.test(observedScanMeta.base) && observedScanMeta.base === observedScanMeta.head, 'scanner-only 點火必須寫入含 40-hex base/head 的 scan.json');
    assert.equal(scanProbeRes.probes[0].ok, true);
    assert.match(scanProbeRes.lines.join('\n'), /Grok.*🟢 點火通過.*prepareScan/u);

    // (d) N2：現有 PATH 優先於後備目錄（.local/bin），靜態體檢 checkSeats 與動態點火 probeSeats 必須命中同一支 CLI
    const pathFrontDir = path.join(tmp, 'path-front');
    const fallbackLocalBin = path.join(tmp, '.local', 'bin');
    fs.mkdirSync(pathFrontDir, { recursive: true });
    fs.mkdirSync(fallbackLocalBin, { recursive: true });
    const markerPath = path.join(tmp, 'which-cli-ran.txt');
    const frontCli = path.join(pathFrontDir, 'codex');
    const fallbackCli = path.join(fallbackLocalBin, 'codex');
    // 前置 CLI：寫入 front 並把標準通過內容寫進 -o 指定檔案
    fs.writeFileSync(
      frontCli,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(markerPath)}, 'front');
const outIdx = process.argv.indexOf('-o');
const outFile = process.argv[outIdx + 1];
const prompt = fs.readFileSync(0, 'utf8').split('\\n').slice(1).join('\\n');
fs.writeFileSync(outFile, prompt);
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      fallbackCli,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(markerPath)}, 'fallback');
process.exit(1);
`,
      { mode: 0o755 },
    );
    const customEnv = { ...process.env, PATH: `${pathFrontDir}${path.delimiter}${process.env.PATH || ''}` };
    const singleCodexSettings = {
      ...settings,
      reviewers: [settings.reviewers[0]],
    };
    const staticOrderCheck = checkSeats(singleCodexSettings, { env: customEnv, homedir: tmp });
    assert.equal(staticOrderCheck.seats[0].binPath, frontCli, 'checkSeats 應優先選中現有 PATH 最前面的 CLI');
    const realOrderProbe = await probeSeats(singleCodexSettings, {
      seatFilter: 'Codex',
      env: customEnv,
      homedir: tmp,
    });
    assert.equal(realOrderProbe.probes[0].ok, true);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), 'front', 'probeSeats 實際執行的必須與 checkSeats 同一支前置 CLI');

    // (e) N1：點火逾時必須一併終止 /bin/sh 底下的子程序群組（含忽略 SIGTERM 的子程序），回傳「執行逾時」時已終止且不再寫入標記
    const timeoutMarker = path.join(tmp, 'late-write-after-timeout.txt');
    const timeoutPidFile = path.join(tmp, 'timeout-child.pid');
    fs.writeFileSync(
      frontCli,
      `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(timeoutPidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(timeoutMarker)}, 'escaped');
  process.exit(0);
}, 1600);
`,
      { mode: 0o755 },
    );
    const timeoutProbe = await probeSeats(singleCodexSettings, {
      seatFilter: 'Codex',
      env: customEnv,
      homedir: tmp,
      timeoutMs: 800,
      graceMs: 80,
    });
    assert.equal(fs.existsSync(timeoutPidFile), true, '逾時測試的合成 CLI 應已啟動並寫出就緒 PID');
    const timeoutChildPid = Number(fs.readFileSync(timeoutPidFile, 'utf8'));
    let timeoutChildAlive = false;
    try { process.kill(timeoutChildPid, 0); timeoutChildAlive = true; } catch { /* expected ESRCH */ }
    assert.equal(timeoutChildAlive, false, 'probeSeats 回傳時忽略 SIGTERM 的逾時子程序必須已被 SIGKILL 終止');
    assert.equal(timeoutProbe.probes[0].ok, false);
    assert.equal(timeoutProbe.probes[0].reason, '執行逾時');
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(fs.existsSync(timeoutMarker), false, '逾時收尾後子程序群組必須已被終止，不得在函式回傳後繼續寫檔');

    // (f) N1（續）：巢狀 runGrokChild（忽略 SIGTERM 的內層 detached 程序群組，且外層監督程序同步忙碌 1800ms 暫時無法回應 SIGTERM）於逾時或取消收尾時必須一併終止內層群組；若無法確認內層清空則標記未完成收尾、保留暫存樹並停止下一座位
    const nestedTicks = path.join(tmp, 'nested-grok.ticks');
    const nestedPidFile = path.join(tmp, 'nested-grok.pid');
    const nestedSecondSeatMarker = path.join(tmp, 'nested-second-seat.txt');
    const nestedChildScript = path.join(tmp, 'nested-grok-child.cjs');
    const nestedWrapperScript = path.join(tmp, 'nested-grok-wrapper.cjs');
    const reviewLaunchPath = path.join(__dirname, '..', 'tools', 'review-launch.js');
    const claudeNestedCli = path.join(pathFrontDir, 'claude');
    fs.writeFileSync(
      claudeNestedCli,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(nestedSecondSeatMarker)}, 'ran');\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      nestedChildScript,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(nestedPidFile)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        `setInterval(() => fs.appendFileSync(${JSON.stringify(nestedTicks)}, Date.now() + '\\n'), 30);`,
        'setTimeout(() => process.exit(0), 8000);',
      ].join('\n'),
    );
    fs.writeFileSync(
      nestedWrapperScript,
      [
        "const fs = require('node:fs');",
        `const { runGrokChild } = require(${JSON.stringify(reviewLaunchPath)});`,
        `runGrokChild(process.execPath, [${JSON.stringify(nestedChildScript)}], { env: process.env }, { wallMs: 7000 }).then((r) => { process.exitCode = r.status; });`,
        'const waitPid = setInterval(() => {',
        `  if (fs.existsSync(${JSON.stringify(nestedPidFile)})) {`,
        '    clearInterval(waitPid);',
        '    const busyUntil = Date.now() + 1800;',
        '    while (Date.now() < busyUntil) {}',
        '  }',
        '}, 10);',
      ].join('\n'),
    );
    fs.writeFileSync(
      frontCli,
      `#!/bin/sh\nexec "${process.execPath}" "${nestedWrapperScript}"\n`,
      { mode: 0o755 },
    );
    const countLines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length : 0);
    const nestedTimeoutProbe = await probeSeats(singleCodexSettings, {
      seatFilter: 'Codex',
      env: customEnv,
      homedir: tmp,
      timeoutMs: 900,
      graceMs: 120,
    });
    const ticksAtReturn = countLines(nestedTicks);
    const nestedPid = fs.existsSync(nestedPidFile) ? Number(fs.readFileSync(nestedPidFile, 'utf8')) : null;
    assert.ok(nestedPid && nestedPid > 1, '巢狀內層程序在逾時前應已啟動並寫出就緒 PID');
    await new Promise((r) => setTimeout(r, 300));
    const ticksAfterWait = countLines(nestedTicks);
    let nestedStillAlive = false;
    if (nestedPid) {
      try { process.kill(nestedPid, 0); nestedStillAlive = true; } catch { /* expected ESRCH */ }
      try { process.kill(-nestedPid, 'SIGKILL'); } catch { /* cleanup if needed */ }
    }
    assert.equal(nestedTimeoutProbe.probes[0].ok, false);
    assert.equal(nestedTimeoutProbe.probes[0].reason, '執行逾時');
    assert.equal(nestedStillAlive, false, '外層監督程序同步忙碌遭 SIGKILL 時，巢狀 runGrokChild 內層程序在 probeSeats 回傳時亦必須已終止');
    assert.equal(ticksAfterWait, ticksAtReturn, 'probeSeats 回傳後巢狀內層程序不得再新增任何標記');

    // (f-2) 外層監督程序同步忙碌 1800ms 期間收到 SIGINT 取消：必須回 130、終止內層群組、停止第二座位
    try { fs.unlinkSync(nestedPidFile); } catch { /* ignore */ }
    try { fs.unlinkSync(nestedTicks); } catch { /* ignore */ }
    try { fs.unlinkSync(nestedSecondSeatMarker); } catch { /* ignore */ }
    const twoSeatNestedSettings = {
      ...settings,
      reviewers: [settings.reviewers[0], settings.reviewers[1]],
    };
    const prevNestedExitCode = process.exitCode;
    let nestedCancelRes;
    try {
      const nestedCancelPromise = probeSeats(twoSeatNestedSettings, {
        seatFilter: '*',
        env: customEnv,
        homedir: tmp,
        timeoutMs: 8000,
        graceMs: 120,
      });
      for (let i = 0; i < 200 && !fs.existsSync(nestedPidFile); i += 1) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(fs.existsSync(nestedPidFile), true, '巢狀取消測試的內層程序應已寫出就緒 PID');
      await new Promise((r) => setTimeout(r, 30));
      process.emit('SIGINT', 'SIGINT');
      nestedCancelRes = await nestedCancelPromise;
    } finally {
      process.exitCode = prevNestedExitCode;
    }
    const cancelNestedPid = Number(fs.readFileSync(nestedPidFile, 'utf8'));
    const cancelTicksAtReturn = countLines(nestedTicks);
    let cancelNestedAlive = false;
    try { process.kill(cancelNestedPid, 0); cancelNestedAlive = true; } catch { /* expected ESRCH */ }
    try { process.kill(-cancelNestedPid, 'SIGKILL'); } catch { /* cleanup if needed */ }
    await new Promise((r) => setTimeout(r, 250));
    const cancelTicksAfterWait = countLines(nestedTicks);
    assert.equal(nestedCancelRes.code, 130);
    assert.equal(nestedCancelRes.cancelled, true);
    assert.equal(nestedCancelRes.probes.length, 1, '取消後不得啟動第二座位');
    assert.equal(fs.existsSync(nestedSecondSeatMarker), false, '取消後第二座位不得被執行');
    assert.equal(cancelNestedAlive, false, '外層監督程序忙碌期間取消回傳時，內層 runGrokChild 程序必須已終止');
    assert.equal(cancelTicksAfterWait, cancelTicksAtReturn, '取消回傳後內層程序不得再新增標記');

    // (f-3) 當內層群組無法確認清空時（例如收尾期限內內層仍存活），逾時路徑必須標記 cleanupFailed、保留點火樹並停止第二座位
    try { fs.unlinkSync(nestedPidFile); } catch { /* ignore */ }
    try { fs.unlinkSync(nestedTicks); } catch { /* ignore */ }
    try { fs.unlinkSync(nestedSecondSeatMarker); } catch { /* ignore */ }
    const unconfirmedNestedRes = await probeSeats(twoSeatNestedSettings, {
      seatFilter: '*',
      env: customEnv,
      homedir: tmp,
      timeoutMs: 700,
      graceMs: 40,
      cleanupMs: 120,
      kill: (targetPid, sig) => {
        const innerP = fs.existsSync(nestedPidFile) ? Number(fs.readFileSync(nestedPidFile, 'utf8')) : 0;
        if (innerP > 1 && targetPid === -innerP && sig === 0) return true;
        return process.kill(targetPid, sig);
      },
    });
    const unconfirmedInnerPid = fs.existsSync(nestedPidFile) ? Number(fs.readFileSync(nestedPidFile, 'utf8')) : null;
    if (unconfirmedInnerPid) {
      try { process.kill(-unconfirmedInnerPid, 'SIGKILL'); } catch { /* cleanup */ }
    }
    try {
      assert.equal(unconfirmedNestedRes.cleanupFailed, true, '內層群組無法確認清空時頂層結果應標記 cleanupFailed');
      assert.equal(unconfirmedNestedRes.probes.length, 1, '內層群組無法確認清空時必須立即停止第二座位');
      assert.equal(unconfirmedNestedRes.probes[0].cleanupFailed, true);
      assert.match(unconfirmedNestedRes.probes[0].reason, /子程序群組未完成收尾/u);
      assert.equal(fs.existsSync(nestedSecondSeatMarker), false, '內層群組未完成收尾時不得啟動第二座位');
      assert.ok(unconfirmedNestedRes.probes[0].probeRoot && fs.existsSync(unconfirmedNestedRes.probes[0].probeRoot), '內層群組未完成收尾時必須保留暫存點火樹供查');
    } finally {
      if (unconfirmedNestedRes.probes[0] && unconfirmedNestedRes.probes[0].probeRoot) {
        fs.rmSync(unconfirmedNestedRes.probes[0].probeRoot, { recursive: true, force: true });
      }
    }

    // (g) N1（續）：外層點火收到單一主程序（pid）或整組（-pid）之 SIGINT／SIGTERM 取消時，必須退出 130／143、終止受管 CLI，且停止同座位下一角色與下一座位
    const cancelTicks = path.join(tmp, 'cancel-cli.ticks');
    const cancelPidFile = path.join(tmp, 'cancel-cli.pid');
    const firstSeatScanMarker = path.join(tmp, 'cancel-first-seat-scan-ran.txt');
    const secondSeatMarker = path.join(tmp, 'cancel-second-seat-ran.txt');
    const cancelOuterScript = path.join(tmp, 'cancel-outer.cjs');
    const preflightPath = path.join(__dirname, '..', 'tools', 'preflight.js');
    const claudeCancelCli = path.join(pathFrontDir, 'claude');
    fs.writeFileSync(
      frontCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "if (process.argv.includes('--scan-role')) {",
        `  fs.writeFileSync(${JSON.stringify(firstSeatScanMarker)}, 'ran');`,
        '  process.exit(0);',
        '}',
        `fs.appendFileSync(${JSON.stringify(cancelTicks)}, Date.now() + '\\n');`,
        `fs.writeFileSync(${JSON.stringify(cancelPidFile)}, String(process.pid));`,
        `setInterval(() => fs.appendFileSync(${JSON.stringify(cancelTicks)}, Date.now() + '\\n'), 30);`,
        'setTimeout(() => process.exit(0), 6000);',
      ].join('\n'),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      claudeCancelCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(secondSeatMarker)}, 'ran');`,
        'process.exit(0);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const twoSeatCancelSettings = {
      ...settings,
      reviewers: [settings.reviewers[0], settings.reviewers[1]],
      scanner: {
        participant: 'Codex',
        tool: 'Codex CLI',
        source: 'codex CLI',
        strongest: 'gpt-6-astra',
        maxEffort: 'max',
        command: 'codex exec --scan-role -m {model} -C {scanTree} -o {outFile} - < {promptFile}',
      },
    };
    fs.writeFileSync(
      cancelOuterScript,
      [
        `const { run, checkSeats, probeSeats } = require(${JSON.stringify(preflightPath)});`,
        `const settings = ${JSON.stringify(twoSeatCancelSettings)};`,
        `const env = ${JSON.stringify(customEnv)};`,
        `const homedir = ${JSON.stringify(tmp)};`,
        '(async () => {',
        "  const res = await run(['--skip-downstream', '--probe'], {",
        '    settings,',
        '    runners: {',
        "      pendingRulings: () => ({ code: 0, lines: ['pending-ok'] }),",
        "      backlogTouch: () => ({ code: 0, lines: ['backlog-ok'] }),",
        '      seats: (s) => checkSeats(s, { env, homedir }),',
        '      probeSeats: (s, opts) => probeSeats(s, { ...opts, env, homedir, timeoutMs: 3000 }),',
        '    },',
        '  });',
        '  process.exitCode = res.code;',
        '  process.stdout.write(JSON.stringify(res));',
        '})();',
      ].join('\n'),
    );
    const { spawn: spawnAsync } = require('node:child_process');
    for (const cancelMode of [
      { label: '單一主程序 SIGINT (pid)', toGroup: false, sig: 'SIGINT', expectedCode: 130 },
      { label: '單一主程序 SIGTERM (pid)', toGroup: false, sig: 'SIGTERM', expectedCode: 143 },
      { label: '群組 SIGINT (-pid)', toGroup: true, sig: 'SIGINT', expectedCode: 130 },
      { label: '群組 SIGTERM (-pid)', toGroup: true, sig: 'SIGTERM', expectedCode: 143 },
    ]) {
      try { fs.unlinkSync(cancelPidFile); } catch { /* ignore */ }
      try { fs.unlinkSync(cancelTicks); } catch { /* ignore */ }
      try { fs.unlinkSync(firstSeatScanMarker); } catch { /* ignore */ }
      try { fs.unlinkSync(secondSeatMarker); } catch { /* ignore */ }
      const cancelJob = spawnAsync(process.execPath, [cancelOuterScript], {
        env: customEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let cancelStdout = '';
      cancelJob.stdout.on('data', (d) => { cancelStdout += d.toString('utf8'); });
      const cancelJobExit = new Promise((r) => cancelJob.once('exit', (code, signal) => r({ code, signal })));
      for (let i = 0; i < 150 && !fs.existsSync(cancelPidFile); i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(fs.existsSync(cancelPidFile), true, `${cancelMode.label}：合成 CLI 應已啟動並寫出就緒 PID`);
      process.kill(cancelMode.toGroup ? -cancelJob.pid : cancelJob.pid, cancelMode.sig);
      const exitInfo = await cancelJobExit;
      const cancelTicksBefore = countLines(cancelTicks);
      await new Promise((r) => setTimeout(r, 400));
      const cancelTicksAfter = countLines(cancelTicks);
      const cancelChildPid = Number(fs.readFileSync(cancelPidFile, 'utf8'));
      let cancelChildAlive = false;
      try { process.kill(cancelChildPid, 0); cancelChildAlive = true; } catch { /* expected ESRCH */ }
      try { process.kill(cancelChildPid, 'SIGKILL'); } catch { /* cleanup */ }
      assert.equal(cancelChildAlive, false, `${cancelMode.label}：外層點火結束時，detached CLI 子程序必須已一併終止`);
      assert.equal(cancelTicksAfter, cancelTicksBefore, `${cancelMode.label}：外層點火結束後 CLI 子程序不得繼續寫入標記`);
      assert.equal(fs.existsSync(firstSeatScanMarker), false, `${cancelMode.label}：第一座位取消後不得繼續啟動同座位下一角色（掃描）`);
      assert.equal(fs.existsSync(secondSeatMarker), false, `${cancelMode.label}：第一座位取消後不得繼續啟動第二座位`);
      assert.equal(exitInfo.code, cancelMode.expectedCode, `${cancelMode.label}：CLI 退出碼必須為 ${cancelMode.expectedCode}`);
      const parsedOut = JSON.parse(cancelStdout);
      assert.equal(parsedOut.code, cancelMode.expectedCode, `${cancelMode.label}：run() 回傳碼必須保留 ${cancelMode.expectedCode}`);
      assert.match(parsedOut.lines.join('\n'), /執行已取消/u, `${cancelMode.label}：輸出應記錄執行已取消`);
    }

    // (h) N6：點火必須清掉 GIT_* 選倉環境變數與 platform.clearEnv，使 CLI 內部 Git 指向隔離點火樹而非外部 GIT_DIR
    const decoyRepo = path.join(tmp, 'decoy-git-repo');
    fs.mkdirSync(decoyRepo, { recursive: true });
    const { spawnSync: realSpawnSync } = require('node:child_process');
    realSpawnSync('git', ['init', '-q', decoyRepo], { env: gitEnv(), encoding: 'utf8' });
    const observedEnvFile = path.join(tmp, 'observed-git-env.json');
    fs.writeFileSync(
      frontCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const { spawnSync } = require('node:child_process');",
        'const args = process.argv.slice(2);',
        "const cwd = args[args.indexOf('-C') + 1];",
        "const outFile = args[args.indexOf('-o') + 1];",
        "const r = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, env: process.env, encoding: 'utf8' });",
        `fs.writeFileSync(${JSON.stringify(observedEnvFile)}, JSON.stringify({ cwd, gitDir: (r.stdout || '').trim(), ghRepo: process.env.GH_REPO || null }));`,
        "const prompt = fs.readFileSync(0, 'utf8').split('\\n').slice(1).join('\\n');",
        'fs.writeFileSync(outFile, prompt);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const envWithPoison = {
      ...customEnv,
      GIT_DIR: path.join(decoyRepo, '.git'),
      GIT_WORK_TREE: decoyRepo,
      GH_REPO: 'poison/repo',
    };
    const envProbeRes = await probeSeats(
      { ...singleCodexSettings, platform: { clearEnv: ['GH_REPO'] } },
      { seatFilter: 'Codex', env: envWithPoison, homedir: tmp },
    );
    assert.equal(envProbeRes.probes[0].ok, true);
    const observedEnv = JSON.parse(fs.readFileSync(observedEnvFile, 'utf8'));
    assert.equal(observedEnv.gitDir, path.join(observedEnv.cwd, '.git'), 'CLI 內部 Git 必須指向隔離點火樹的 .git，不得受繼承 GIT_DIR 影響');
    assert.equal(observedEnv.ghRepo, null, 'platform.clearEnv 指定的環境變數必須在點火時清除');

    // (i) N7：臨時提交停用簽名（不受全域 commit.gpgsign=true 阻擋），且當 git init 失敗且 TMPDIR 位於外層 Git 倉庫內時，不可執行 git config 汙染外層倉庫
    const fakeGitDir = path.join(tmp, 'fake-git-bin');
    fs.mkdirSync(fakeGitDir, { recursive: true });
    const realGitPath = realSpawnSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
    const cliRanMarker = path.join(tmp, 'n7-cli-ran.txt');
    fs.writeFileSync(
      frontCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(cliRanMarker)}, 'ran');`,
        'const args = process.argv.slice(2);',
        "const outFile = args[args.indexOf('-o') + 1];",
        "const prompt = fs.readFileSync(0, 'utf8').split('\\n').slice(1).join('\\n');",
        'fs.writeFileSync(outFile, prompt);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const fakeGitBin = path.join(fakeGitDir, 'git');
    fs.writeFileSync(
      fakeGitBin,
      [
        `#!${process.execPath}`,
        "const { spawnSync } = require('node:child_process');",
        'const args = process.argv.slice(2);',
        "if (process.env.FAKE_GIT_MODE === 'fail') process.exit(127);",
        "if (process.env.FAKE_GIT_MODE === 'fail-init-only' && args[0] === 'init') process.exit(1);",
        "const actual = args[0] === 'commit' ? ['-c', 'commit.gpgsign=true', '-c', 'gpg.program=/usr/bin/false', ...args] : args;",
        `const r = spawnSync(${JSON.stringify(realGitPath)}, actual, { env: process.env, encoding: 'utf8' });`,
        "process.stdout.write(r.stdout || '');",
        "process.stderr.write(r.stderr || '');",
        'process.exit(r.status === null ? 1 : r.status);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const signingEnv = {
      ...customEnv,
      PATH: `${fakeGitDir}${path.delimiter}${customEnv.PATH}`,
      FAKE_GIT_MODE: 'signing',
    };
    try { fs.unlinkSync(cliRanMarker); } catch { /* ignore */ }
    const signingProbe = await probeSeats(singleCodexSettings, {
      seatFilter: 'Codex',
      env: signingEnv,
      homedir: tmp,
    });
    assert.equal(signingProbe.probes[0].ok, true, '停用臨時提交簽名後，即使全域設了 commit.gpgsign=true 亦應建樹成功並通過點火');
    assert.equal(fs.existsSync(cliRanMarker), true);

    try { fs.unlinkSync(cliRanMarker); } catch { /* ignore */ }
    const outerRepoTmp = path.join(tmp, 'outer-repo-tmpdir');
    fs.mkdirSync(outerRepoTmp, { recursive: true });
    realSpawnSync(realGitPath, ['init', '-q', outerRepoTmp], { env: gitEnv(), encoding: 'utf8' });
    realSpawnSync(realGitPath, ['config', '--local', 'user.name', 'OuterKeepName'], { cwd: outerRepoTmp, env: gitEnv(), encoding: 'utf8' });
    realSpawnSync(realGitPath, ['config', '--local', 'user.email', 'outer-keep@example.com'], { cwd: outerRepoTmp, env: gitEnv(), encoding: 'utf8' });
    const prevTmpDir = process.env.TMPDIR;
    process.env.TMPDIR = outerRepoTmp;
    let failInitOnlyProbe;
    try {
      failInitOnlyProbe = await probeSeats(singleCodexSettings, {
        seatFilter: 'Codex',
        env: { ...signingEnv, FAKE_GIT_MODE: 'fail-init-only', TMPDIR: outerRepoTmp },
        homedir: tmp,
      });
    } finally {
      if (prevTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpDir;
    }
    assert.equal(failInitOnlyProbe.probes[0].ok, false, 'git init 失敗時必須判為點火失敗');
    assert.match(failInitOnlyProbe.probes[0].reason, /建立隔離點火 Git 樹失敗/u);
    assert.equal(fs.existsSync(cliRanMarker), false, 'git init 失敗時絕不可啟動 CLI');
    const outerNameAfter = realSpawnSync(realGitPath, ['config', '--local', '--get', 'user.name'], { cwd: outerRepoTmp, env: gitEnv(), encoding: 'utf8' }).stdout.trim();
    const outerEmailAfter = realSpawnSync(realGitPath, ['config', '--local', '--get', 'user.email'], { cwd: outerRepoTmp, env: gitEnv(), encoding: 'utf8' }).stdout.trim();
    assert.equal(outerNameAfter, 'OuterKeepName', 'git init 失敗時不得執行 git config 覆寫外層倉庫的 user.name');
    assert.equal(outerEmailAfter, 'outer-keep@example.com', 'git init 失敗時不得執行 git config 覆寫外層倉庫的 user.email');

    // (j) N8：同一座位同時登記於 reviewers 與 scanner 時，probeSeats 必須逐一實測 review 與 scan 兩條命令，任一角色命令失敗即判該座位點火失敗
    const dualRoleSettings = {
      participants: [
        { role: '裁示者（人）', id: 'Boss', account: 'boss' },
        { role: 'AI 雙棲', id: 'Grok', account: 'ai' },
      ],
      defaultDivision: { implementer: 'Boss', reviewer: 'Grok' },
      platform: { project: 'fake/repo' },
      reviewers: [
        {
          participant: 'Grok',
          tool: 'Grok 4.7',
          source: 'Grok CLI',
          strongest: 'grok-4.7',
          maxEffort: 'xhigh',
          command: 'node tools/review-launch.js --grok-exec --mode review --cwd {reviewTree} --add-dir {mutationCopy} --prompt-file {promptFile} --out-file {outFile} --model {model} --effort {effort}',
        },
      ],
      scanner: {
        participant: 'Grok',
        tool: 'Grok 4.7',
        source: 'Grok CLI',
        strongest: 'grok-4.7',
        maxEffort: 'xhigh',
        command: 'node tools/review-launch.js --grok-exec --mode scan --cwd {scanTree} --prompt-file {promptFile} --out-file {outFile} --model {model} --effort {effort}',
      },
    };
    const dualCalledModes = [];
    const dualBothPass = await probeSeats(dualRoleSettings, {
      seatFilter: 'Grok',
      env: { PATH: process.env.PATH },
      homedir: tmp,
      authFile: fakeAuthFile,
      grokBin: fakeGrokBin,
      spawnSyncImpl: (_bin, args) => {
        const cmdStr = args[1];
        const mode = /--mode\s+(review|scan)\b/u.exec(cmdStr)[1];
        dualCalledModes.push(mode);
        const outFile = /--out-file\s+([^\s]+)/u.exec(cmdStr)[1];
        const promptFile = /--prompt-file\s+([^\s]+)/u.exec(cmdStr)[1];
        fs.writeFileSync(path.join(path.dirname(outFile), 'execution.json'), JSON.stringify({ mode }), { flag: 'wx' });
        const promptLines = fs.readFileSync(promptFile, 'utf8').split('\n').slice(1);
        fs.writeFileSync(outFile, promptLines.join('\n'));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(dualCalledModes, ['review', 'scan'], '雙棲座位點火必須依序實測 review 與 scan 兩條啟動命令');
    assert.equal(dualBothPass.probes[0].ok, true);
    assert.match(dualBothPass.lines.join('\n'), /Grok.*🟢 點火通過.*prepareVerdict＋prepareScan/u);

    const dualScanFail = await probeSeats(dualRoleSettings, {
      seatFilter: 'Grok',
      env: { PATH: process.env.PATH },
      homedir: tmp,
      authFile: fakeAuthFile,
      grokBin: fakeGrokBin,
      spawnSyncImpl: (_bin, args) => {
        const cmdStr = args[1];
        const mode = /--mode\s+(review|scan)\b/u.exec(cmdStr)[1];
        const outFile = /--out-file\s+([^\s]+)/u.exec(cmdStr)[1];
        const promptFile = /--prompt-file\s+([^\s]+)/u.exec(cmdStr)[1];
        if (mode === 'scan') {
          return { status: 7, stdout: '', stderr: 'scan command broken' };
        }
        const promptLines = fs.readFileSync(promptFile, 'utf8').split('\n').slice(1);
        fs.writeFileSync(outFile, promptLines.join('\n'));
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(dualScanFail.probes[0].ok, false, '雙棲座位若複審通過但掃描命令失敗，必須判為點火失敗');
    assert.equal(dualScanFail.probes[0].status, 7);
    assert.match(dualScanFail.probes[0].reason, /［掃描］/u);

    const dualReviewFail = await probeSeats(dualRoleSettings, {
      seatFilter: 'Grok',
      env: { PATH: process.env.PATH },
      homedir: tmp,
      authFile: fakeAuthFile,
      grokBin: fakeGrokBin,
      spawnSyncImpl: (_bin, args) => {
        const cmdStr = args[1];
        const mode = /--mode\s+(review|scan)\b/u.exec(cmdStr)[1];
        if (mode === 'review') {
          return { status: 5, stdout: '', stderr: 'review command broken' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(dualReviewFail.probes[0].ok, false, '雙棲座位若複審命令失敗，必須判為點火失敗');
    assert.equal(dualReviewFail.probes[0].status, 5);
    assert.match(dualReviewFail.probes[0].reason, /［複審］/u);

    // (k) run(['--probe', 'Codex']) 串接 checkOpenChanges 與 probeSeats
    const fullProbeRun = await run(['--skip-downstream', '--probe', 'Codex'], {
      runners: {
        pendingRulings: () => ({ code: 0, lines: ['pending-ok'] }),
        openChanges: () => ({ code: 0, lines: ['進行中變更（C1）：⚠️ 目前已開啟 2 支'] }),
        backlogTouch: () => ({ code: 0, lines: ['backlog-ok'] }),
        seats: () => ({ code: 0, lines: ['seats-static-ok'], seats: [{ participant: 'Codex', ok: true }] }),
        probeSeats: (_s, { seatFilter }) => ({ code: 0, lines: [`probe-ran:${seatFilter}`], probes: [{ participant: 'Codex', ok: true }] }),
      },
    });
    assert.equal(fullProbeRun.code, 0);
    assert.match(fullProbeRun.lines.join('\n'), /進行中變更（C1）：⚠️ 目前已開啟 2 支/u);
    assert.match(fullProbeRun.lines.join('\n'), /probe-ran:Codex/u);

    // (l) N1（續）：shell 先退出、後代仍持有管線或已關閉管線時，從 exit 即啟動收尾（不假通過、不無限等待），且收尾期限內無法確認清空時明確報失敗、保留暫存樹並停止後續座位
    const pipeHolderPidFile = path.join(tmp, 'pipe-holder.pid');
    const pipeHolderTicks = path.join(tmp, 'pipe-holder.ticks');
    const pipeHolderChild = path.join(tmp, 'pipe-holder-child.cjs');
    fs.writeFileSync(
      pipeHolderChild,
      [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(pipeHolderPidFile)}, String(process.pid));`,
        `setInterval(() => fs.appendFileSync(${JSON.stringify(pipeHolderTicks)}, Date.now() + '\\n'), 30);`,
        'setTimeout(() => process.exit(0), 6000);',
      ].join('\n'),
    );
    fs.writeFileSync(
      frontCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        `spawn(process.execPath, [${JSON.stringify(pipeHolderChild)}], { stdio: 'inherit' });`,
        `const until = Date.now() + 2500; while (!fs.existsSync(${JSON.stringify(pipeHolderPidFile)}) && Date.now() < until) {}`,
        'process.exit(1);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const tPipeStart = Date.now();
    const openPipeRes = await probeSeats(singleCodexSettings, {
      seatFilter: 'Codex',
      env: customEnv,
      homedir: tmp,
      timeoutMs: 5000,
      graceMs: 80,
      cleanupMs: 1200,
    });
    const pipeElapsed = Date.now() - tPipeStart;
    assert.ok(pipeElapsed < 3500, `shell 先退出但後代仍持管線時應從 exit 立即啟動收尾，不等滿 timeoutMs（實際 ${pipeElapsed}ms）`);
    assert.equal(openPipeRes.probes[0].ok, false);
    const pipeHolderPid = Number(fs.readFileSync(pipeHolderPidFile, 'utf8'));
    let pipeHolderAlive = false;
    try { process.kill(pipeHolderPid, 0); pipeHolderAlive = true; } catch { /* expected ESRCH */ }
    assert.equal(pipeHolderAlive, false, '持有管線的後代程序於回傳時必須已終止');
    const pipeTicksBefore = countLines(pipeHolderTicks);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(countLines(pipeHolderTicks), pipeTicksBefore, '回傳後持有管線的後代不得再新增標記');

    const closedPipePidFile = path.join(tmp, 'closed-pipe.pid');
    const closedPipeTicks = path.join(tmp, 'closed-pipe.ticks');
    const closedPipeChild = path.join(tmp, 'closed-pipe-child.cjs');
    fs.writeFileSync(
      closedPipeChild,
      [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(closedPipePidFile)}, String(process.pid));`,
        `setInterval(() => fs.appendFileSync(${JSON.stringify(closedPipeTicks)}, Date.now() + '\\n'), 30);`,
        'setTimeout(() => process.exit(0), 6000);',
      ].join('\n'),
    );
    fs.writeFileSync(
      frontCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        'const args = process.argv.slice(2);',
        "const outFile = args[args.indexOf('-o') + 1];",
        "const prompt = fs.readFileSync(0, 'utf8').split('\\n').slice(1).join('\\n');",
        'fs.writeFileSync(outFile, prompt);',
        `const bg = spawn(process.execPath, [${JSON.stringify(closedPipeChild)}], { stdio: 'ignore' });`,
        'bg.unref();',
        `const until = Date.now() + 2500; while (!fs.existsSync(${JSON.stringify(closedPipePidFile)}) && Date.now() < until) {}`,
        'process.exit(0);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const closedPipeRes = await probeSeats(singleCodexSettings, {
      seatFilter: 'Codex',
      env: customEnv,
      homedir: tmp,
      timeoutMs: 4000,
      graceMs: 80,
      cleanupMs: 1200,
    });
    assert.equal(closedPipeRes.probes[0].ok, true);
    const closedPipePid = Number(fs.readFileSync(closedPipePidFile, 'utf8'));
    let closedPipeAlive = false;
    try { process.kill(closedPipePid, 0); closedPipeAlive = true; } catch { /* expected ESRCH */ }
    assert.equal(closedPipeAlive, false, '即使後代已關閉管線（close 先觸發），成功路徑亦必須清理群組殘留背景程序後才回傳');
    const closedTicksBefore = countLines(closedPipeTicks);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(countLines(closedPipeTicks), closedTicksBefore);

    // 收尾期限內無法確認清空（ECLEANUP）：報失敗、停止後續座位且不提早刪除暫存樹
    try { fs.unlinkSync(secondSeatMarker); } catch { /* ignore */ }
    fs.writeFileSync(
      frontCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        "const outFile = args[args.indexOf('-o') + 1];",
        "const prompt = fs.readFileSync(0, 'utf8').split('\\n').slice(1).join('\\n');",
        'fs.writeFileSync(outFile, prompt);',
        'process.exit(0);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const stuckRes = await probeSeats(
      { ...settings, reviewers: [settings.reviewers[0], settings.reviewers[1]] },
      {
        seatFilter: '*',
        env: customEnv,
        homedir: tmp,
        graceMs: 20,
        cleanupMs: 80,
        kill: (targetPid, sig) => {
          if (targetPid < 0 && sig === 0) return true;
          return process.kill(targetPid, sig);
        },
      },
    );
    try {
      assert.equal(stuckRes.probes.length, 1, '無法確認群組清空時必須立即停止後續座位');
      assert.equal(stuckRes.probes[0].ok, false, '無法確認群組清空時不得假通過');
      assert.equal(stuckRes.probes[0].reason, '子程序群組未完成收尾');
      assert.equal(stuckRes.probes[0].cleanupFailed, true);
      assert.equal(fs.existsSync(secondSeatMarker), false, '無法確認群組清空時不得啟動第二座位');
      assert.ok(stuckRes.probes[0].probeRoot && fs.existsSync(stuckRes.probes[0].probeRoot), '無法確認群組清空時不得提早刪除暫存樹');
    } finally {
      if (stuckRes.probes[0] && stuckRes.probes[0].probeRoot) {
        fs.rmSync(stuckRes.probes[0].probeRoot, { recursive: true, force: true });
      }
    }

    // (m) N1（續）：收尾期間收到取消與重複取消訊號時，保留首個取消退出碼、只結算一次、停止後續座位且不殘留監聽器
    const cleanupCancelPidFile = path.join(tmp, 'cleanup-cancel.pid');
    const cleanupCancelChild = path.join(tmp, 'cleanup-cancel-child.cjs');
    try { fs.unlinkSync(secondSeatMarker); } catch { /* ignore */ }
    fs.writeFileSync(
      cleanupCancelChild,
      [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        `fs.writeFileSync(${JSON.stringify(cleanupCancelPidFile)}, String(process.pid));`,
        'setTimeout(() => process.exit(0), 5000);',
      ].join('\n'),
    );
    fs.writeFileSync(
      frontCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        `const bg = spawn(process.execPath, [${JSON.stringify(cleanupCancelChild)}], { stdio: 'ignore' });`,
        'bg.unref();',
        `const until = Date.now() + 2500; while (!fs.existsSync(${JSON.stringify(cleanupCancelPidFile)}) && Date.now() < until) {}`,
        'process.exit(1);',
      ].join('\n'),
      { mode: 0o755 },
    );
    const sigintCountBefore = process.listenerCount('SIGINT');
    const sigtermCountBefore = process.listenerCount('SIGTERM');
    const prevExitCode = process.exitCode;
    let cleanupCancelRes;
    try {
      const p = probeSeats(
        { ...settings, reviewers: [settings.reviewers[0], settings.reviewers[1]] },
        {
          seatFilter: '*',
          env: customEnv,
          homedir: tmp,
          timeoutMs: 4000,
          graceMs: 300,
          cleanupMs: 1500,
        },
      );
      for (let i = 0; i < 150 && !fs.existsSync(cleanupCancelPidFile); i += 1) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.equal(fs.existsSync(cleanupCancelPidFile), true, '收尾期間取消測試的背景程序應已啟動並寫出就緒 PID');
      await new Promise((r) => setTimeout(r, 40));
      process.emit('SIGINT', 'SIGINT');
      process.emit('SIGTERM', 'SIGTERM');
      cleanupCancelRes = await p;
      assert.equal(process.exitCode, 130, '首個取消訊號 SIGINT 應將 process.exitCode 設為 130，不被後續 SIGTERM 覆寫');
    } finally {
      process.exitCode = prevExitCode;
    }
    assert.equal(cleanupCancelRes.code, 130);
    assert.equal(cleanupCancelRes.cancelled, true);
    assert.equal(cleanupCancelRes.cancelSignal, 'SIGINT');
    assert.equal(cleanupCancelRes.probes.length, 1);
    assert.equal(cleanupCancelRes.probes[0].reason, '執行已取消');
    assert.equal(fs.existsSync(secondSeatMarker), false, '收尾期間取消後不得啟動第二座位');
    const bgPid = Number(fs.readFileSync(cleanupCancelPidFile, 'utf8'));
    let bgAlive = false;
    try { process.kill(bgPid, 0); bgAlive = true; } catch { /* expected ESRCH */ }
    assert.equal(bgAlive, false, '收尾期間取消完成後背景子程序必須已終止');
    assert.equal(process.listenerCount('SIGINT'), sigintCountBefore, '不得殘留 SIGINT 監聽器');
    assert.equal(process.listenerCount('SIGTERM'), sigtermCountBefore, '不得殘留 SIGTERM 監聽器');

    // 補齊收件核驗與非零退出碼突變攔截：review 壞標頭、scan 壞標頭、以及寫出合法結論但退出碼非 0 皆必須判為失敗
    const badReviewHeaderProbe = await probeSeats(singleCodexSettings, {
      seatFilter: 'Codex',
      env: customEnv,
      homedir: tmp,
      spawnSyncImpl: (_bin, args) => {
        const outFile = /-o\s+([^\s]+)/u.exec(args[1])[1];
        fs.writeFileSync(outFile, '這不是合規複審標頭\n\n### 本輪實際用的設定\n- 測試\n\n### 清單逐項結果\n- 零發現\n');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(badReviewHeaderProbe.probes[0].ok, false, '複審點火輸出壞標頭時必須判為點火失敗');
    assert.match(badReviewHeaderProbe.probes[0].reason, /輸出第一行不是合規標頭/u);

    const badScanHeaderProbe = await probeSeats(scannerOnlySettings, {
      seatFilter: 'Grok',
      env: { PATH: process.env.PATH },
      homedir: tmp,
      authFile: fakeAuthFile,
      grokBin: fakeGrokBin,
      spawnSyncImpl: (_bin, args) => {
        const outFile = /--out-file\s+([^\s]+)/u.exec(args[1])[1];
        fs.writeFileSync(outFile, '這不是合規掃描標頭\n\n### 驗了什麼\n- 測試\n\n### 發現\n- 零發現\n');
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(badScanHeaderProbe.probes[0].ok, false, '掃描點火輸出壞標頭時必須判為點火失敗');
    assert.match(badScanHeaderProbe.probes[0].reason, /輸出第一行不是合規標頭/u);

    const validBodyNonZeroProbe = await probeSeats(singleCodexSettings, {
      seatFilter: 'Codex',
      env: customEnv,
      homedir: tmp,
      spawnSyncImpl: (_bin, args) => {
        const outFile = /-o\s+([^\s]+)/u.exec(args[1])[1];
        const promptFile = /<\s+([^\s]+)/u.exec(args[1])[1];
        const promptLines = fs.readFileSync(promptFile, 'utf8').split('\n').slice(1);
        fs.writeFileSync(outFile, promptLines.join('\n'));
        return { status: 3, stdout: '', stderr: '' };
      },
    });
    assert.equal(validBodyNonZeroProbe.probes[0].ok, false, '即使輸出檔含合法結論正文，CLI 退出碼非 0 時仍必須判為點火失敗');
    assert.equal(validBodyNonZeroProbe.probes[0].status, 3);

    // (n) N1（續）：真控制終端機（setsid＋TIOCSCTTY）與 TIOCSWINSZ 視窗縮放（SIGWINCH）驗證——縮放不得誤判取消、不殺 CLI
    const pythonBin = defaultWhich('python3');
    assert.ok(pythonBin, '測試環境應具備 python3 以執行真 PTY TIOCSWINSZ 驗證');
    const ptyReadyFile = path.join(tmp, 'pty-cli.ready');
    const ptySettingsFile = path.join(tmp, 'pty-settings.json');
    fs.writeFileSync(
      frontCli,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        "const outFile = args[args.indexOf('-o') + 1];",
        "const prompt = fs.readFileSync(0, 'utf8').split('\\n').slice(1).join('\\n');",
        `fs.writeFileSync(${JSON.stringify(ptyReadyFile)}, String(process.pid));`,
        'setTimeout(() => {',
        '  fs.writeFileSync(outFile, prompt);',
        '  process.exit(0);',
        '}, 220);',
      ].join('\n'),
      { mode: 0o755 },
    );
    fs.writeFileSync(ptySettingsFile, JSON.stringify({
      ...singleCodexSettings,
      owner: 'Boss',
      mainBranch: 'main',
      backlog: { file: 'BACKLOG.md', section: '# 待辦' },
    }));
    const ptyHarness = path.join(tmp, 'pty-harness.py');
    fs.writeFileSync(
      ptyHarness,
      [
        'import fcntl, json, os, pty, select, struct, subprocess, sys, termios, time',
        'master, slave = pty.openpty()',
        'fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))',
        'resize = os.environ.get("DO_RESIZE") == "1"',
        'ready_file = os.environ["PTY_READY_FILE"]',
        'cmd = [os.environ["NODE_BIN"], os.environ["RUNNER_JS"]]',
        'def setup_ctty():',
        '    os.setsid()',
        '    try:',
        '        fcntl.ioctl(0, termios.TIOCSCTTY, 0)',
        '    except OSError:',
        '        pass',
        'proc = subprocess.Popen(cmd, stdin=slave, stdout=slave, stderr=slave, close_fds=True, preexec_fn=setup_ctty)',
        'os.close(slave)',
        'chunks = []',
        'resized = False',
        'while True:',
        '    if resize and not resized and os.path.exists(ready_file):',
        '        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 132, 0, 0))',
        '        resized = True',
        '    r, _, _ = select.select([master], [], [], 0.02)',
        '    if r:',
        '        try:',
        '            data = os.read(master, 4096)',
        '            if data:',
        '                chunks.append(data)',
        '        except OSError:',
        '            pass',
        '    if proc.poll() is not None:',
        '        break',
        'while True:',
        '    r, _, _ = select.select([master], [], [], 0.02)',
        '    if not r:',
        '        break',
        '    try:',
        '        data = os.read(master, 4096)',
        '        if not data:',
        '            break',
        '        chunks.append(data)',
        '    except OSError:',
        '        break',
        'os.close(master)',
        'sys.stdout.write(json.dumps({"code": proc.returncode, "resized": resized, "out": b"".join(chunks).decode("utf-8", "replace")}))',
      ].join('\n'),
    );
    const ptyRunnerJs = path.join(tmp, 'pty-runner.cjs');
    fs.writeFileSync(
      ptyRunnerJs,
      [
        `const { probeSeats } = require(${JSON.stringify(preflightPath)});`,
        `const settings = ${JSON.stringify(singleCodexSettings)};`,
        '(async () => {',
        `  const res = await probeSeats(settings, { seatFilter: 'Codex', env: ${JSON.stringify(customEnv)}, homedir: ${JSON.stringify(tmp)}, timeoutMs: 3000 });`,
        '  process.exitCode = res.code;',
        "  process.stdout.write(res.lines.join('\\n') + '\\n');",
        '})();',
      ].join('\n'),
    );
    for (const doResize of ['0', '1']) {
      try { fs.unlinkSync(ptyReadyFile); } catch { /* ignore */ }
      const ptyRes = realSpawnSync(pythonBin, [ptyHarness], {
        env: {
          ...customEnv,
          DO_RESIZE: doResize,
          PTY_READY_FILE: ptyReadyFile,
          NODE_BIN: process.execPath,
          RUNNER_JS: ptyRunnerJs,
        },
        encoding: 'utf8',
      });
      assert.equal(ptyRes.status, 0, `PTY 測試腳本（DO_RESIZE=${doResize}）應正常結束：${ptyRes.stderr}`);
      const ptyParsed = JSON.parse(ptyRes.stdout);
      if (doResize === '1') {
        assert.equal(ptyParsed.resized, true, 'DO_RESIZE=1 時必須在合成 CLI 就緒後實際執行 TIOCSWINSZ 縮放');
      }
      assert.equal(ptyParsed.code, 0, `真 PTY（DO_RESIZE=${doResize}）退出碼必須為 0，不可誤判取消（實際 ${ptyParsed.code}）：${ptyParsed.out}`);
      assert.match(ptyParsed.out, /🟢 點火通過/u, `真 PTY（DO_RESIZE=${doResize}）應正常點火通過`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
