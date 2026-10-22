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
const { run, parseArgs, checkSeats, extractCommandSpec, defaultWhich } = require('../tools/preflight.js');
const { runInCopy, unfilled } = require('./helpers/kit-copy.js');

test('① parseArgs 與 extractCommandSpec：合法參數與壞參數分類', () => {
  assert.deepEqual(parseArgs([]), { change: undefined, base: undefined, skipDownstream: false, skipSeats: false });
  assert.deepEqual(parseArgs(['115', '--base', 'origin/main', '--skip-downstream', '--skip-seats']), {
    change: '115',
    base: 'origin/main',
    skipDownstream: true,
    skipSeats: true,
  });
  for (const bad of [['--base'], ['--base', '--skip-seats'], ['--unknown'], ['1', '2']]) {
    assert.ok(parseArgs(bad).error, `應拒收壞參數：${bad.join(' ')}`);
    assert.equal(run(bad).code, 2);
  }
  assert.deepEqual(extractCommandSpec('codex exec --cd {reviewTree}'), { bin: 'codex', usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('cd {reviewTree} && claude -p --model {model}'), { bin: 'claude', usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('cd {scanTree} && GEMINI_EFFORT={effort} gemini -p -m {model}'), { bin: 'gemini', usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('/custom/dir/gemini -p'), { bin: '/custom/dir/gemini', usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('cd {reviewTree}'), { bin: null, usesGrokExec: false });
  assert.deepEqual(extractCommandSpec('node tools/review-launch.js --grok-exec --mode scan --cwd {scanTree}'), { bin: 'grok', usesGrokExec: true });
  assert.deepEqual(extractCommandSpec('未設定'), { bin: null, usesGrokExec: false });
});

test('② 開工前模式（4 項）與送審前模式（6 項）：串接各子工具，任一項非 0 時總退出碼為 2 但其餘照跑', () => {
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
  const preWork = run(['--base', 'HEAD~1'], { runners: fakeRunners() });
  assert.equal(preWork.code, 0);
  assert.deepEqual(called, ['pending', 'backlog:--base HEAD~1', 'downstream', 'seats']);
  assert.match(preWork.lines.join('\n'), /開工前模式｜共 4 項/u);

  // (b) 送審前模式：跑 6 項
  called.length = 0;
  const preReview = run(['115', '--base', 'HEAD~1'], { runners: fakeRunners() });
  assert.equal(preReview.code, 0);
  assert.deepEqual(called, ['pending', 'backlog:--base HEAD~1', 'downstream', 'stale:--base HEAD~1', 'risk:115', 'seats']);
  assert.match(preReview.lines.join('\n'), /送審前模式（變更 115）｜共 6 項/u);

  // (c) 中途有子工具退 2 時，後面子工具仍照跑，且總退出碼為 2
  called.length = 0;
  const partialFail = run(['--skip-seats'], { runners: fakeRunners('pending') });
  assert.equal(partialFail.code, 2);
  assert.deepEqual(called, ['pending', 'backlog:', 'downstream']);

  // (d) 中途有子工具拋錯時，該節記為退 2、總退出碼為 2，且後面子工具仍照跑（r4 Finding 1）
  called.length = 0;
  const thrownRun = run(['--skip-seats'], {
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
  const badShapeRun = run(['--skip-seats'], {
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

test('③ checkSeats 與 defaultWhich：4 家 AI 座位檢核、保留明確路徑、同人雙角色命令聯集，且盒外憑證只 lstatSync 絕不讀取或輸出內容', () => {
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
    assert.ok(okRes.seats.every((s) => s.ok), '4 家 CLI 與 Grok auth.json 皆就緒');
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
