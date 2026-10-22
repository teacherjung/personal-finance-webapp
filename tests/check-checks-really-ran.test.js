// 守真考卷閘（規矩 H3）。原專案量到的事：被「跳過」的場次在平台上算滿足必過檢查，
// 重跑舊場次又會再蓋一筆跳過，而自動合併只看平台的綠燈。畫面全綠、考卷沒跑。
//
// 守得到的：
//   ①自動合併開著＝擋；②必過名單是空的＝退 2（查不到不是安全）；
//   ③名單上的檢查在那顆版本上找不到正牌場次＝退 2；④還在跑＝擋；
//   ⑤最新那一刻的結論不是成功（跳過、失敗、取消）＝擋；
//   ⑥**同一刻並列**時，只要有一場不是成功就當不明、擋下來（不去猜平台沒承諾的順序）；
//   ⑦**身分**：必過檢查釘了產生者時，別人貼的同名成功不算數；名單說不限才放寬；
//   ⑧平台問不到、主幹名沒填、沒給編號＝退 2，不是退 0；
//   ⑨問場次時用的是這一支的頭，不是別顆版本；
//   ⑩完成了的場次要有合法的完成時間與非空結論，否則退 2（r1 High②：null 或亂字在字典序裡會排到日期後面，
//     一場沒有時間的成功會蓋掉真的失敗）；時間用時間值比，不同時區的合法寫法要排對。
//
// ⚠️ 守不到的：平台回的答案是不是真的；場次清單**有沒有少給**（分頁是那條登記指令的責任，
//    少給會讓「找不到正牌場次」變成退 2、或讓最新那一場被漏掉，方向前者保守、後者危險，照實寫在這裡）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { gateRun, evaluate, parseCliArgs, DEFAULT_WAIT_MS, DEFAULT_POLL_MS } = require('../tools/gates/check-checks-really-ran.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy } = require('./helpers/kit-copy.js');

const run = (over = {}) => ({ name: '三關', status: 'completed', conclusion: 'success', completedAt: '2026-09-13T01:00:00Z', producer: 'ci', ...over });
const need = (over = {}) => ({ name: '三關', producer: 'ci', ...over });

test('都真的跑過且成功、自動合併關著＝放行', () => {
  assert.equal(evaluate([run()], false, [need()]).code, 0);
});

test('自動合併開著＝擋', () => {
  const r = evaluate([run()], true, [need()]);
  assert.equal(r.code, 1);
  assert.match(r.reason, /自動合併/u);
});

test('必過名單是空的＝退 2（查不到不是安全）', () => {
  assert.equal(evaluate([run()], false, []).code, 2);
  assert.equal(evaluate([run()], false, undefined).code, 2);
});

test('找不到正牌場次＝退 2；還在跑＝擋，而且理由要說是「還在跑」', () => {
  assert.equal(evaluate([], false, [need()]).code, 2);
  assert.equal(evaluate([run({ name: '別的檢查' })], false, [need()]).code, 2);
  // ⚠️ 這裡一定要斷言**理由**：沒完成的場次結論本來就不是成功，所以就算把「還在跑」那道拿掉，
  //    退出碼仍然是 1，只是理由變成「結論不是成功」。只看退出碼的話這一題永遠綠（突變驗過）。
  const running = evaluate([run({ status: 'in_progress', conclusion: null, completedAt: null })], false, [need()]);
  assert.equal(running.code, 1);
  assert.match(running.reason, /還有場次在跑/u, '理由要說是還在跑，不是說結論不對——那會叫人去重跑一個其實正在跑的東西');
  // 有一場已經成功、另一場還在跑：也要說「還在跑」，不可以看到成功就放行
  const mixed = evaluate([run(), run({ status: 'in_progress', conclusion: null, completedAt: null })], false, [need()]);
  assert.equal(mixed.code, 1);
  assert.match(mixed.reason, /還有場次在跑/u);
});

test('最新那一刻的結論不是成功就擋：跳過、失敗、取消都算', () => {
  for (const conclusion of ['skipped', 'failure', 'cancelled', 'neutral']) {
    const r = evaluate([run({ conclusion })], false, [need()]);
    assert.equal(r.code, 1, conclusion);
    assert.match(r.reason, new RegExp(conclusion, 'u'));
  }
});

test('只看最新那一刻：舊的失敗不影響，新的失敗要擋', () => {
  const older = run({ conclusion: 'failure', completedAt: '2026-09-13T00:00:00Z' });
  assert.equal(evaluate([older, run()], false, [need()]).code, 0, '舊的失敗、新的成功＝放行');
  const newerBad = run({ conclusion: 'skipped', completedAt: '2026-09-13T02:00:00Z' });
  assert.equal(evaluate([run(), newerBad], false, [need()]).code, 1, '新的是跳過＝擋');
});

test('⑩完成了卻沒有合法時間或結論＝退 2；不可以讓沒有時間的成功蓋掉真的失敗', () => {
  const failed = run({ conclusion: 'failure', completedAt: '2026-09-13T20:00:00Z' });
  for (const bad of [null, 'not-a-time', '', undefined, '2026-09-13', '2026-09-13T20:00:00']) {
    const ghost = run({ conclusion: 'success', completedAt: bad });
    const r = evaluate([failed, ghost], false, [need()]);
    assert.equal(r.code, 2, `completedAt=${JSON.stringify(bad)} 應該是查不清楚，不是放行`);
    assert.match(r.reason, /不合契約/u);
  }
  const noConclusion = run({ conclusion: null });
  assert.equal(evaluate([noConclusion], false, [need()]).code, 2, '完成了卻沒有結論也是不合契約');
});

test('⑩沒帶時區的完成時間不收＝退 2；同一份資料在不同執行時區判一樣（r3 High①）', () => {
  const failed = run({ conclusion: 'failure', completedAt: '2026-09-13T02:00:00Z' });
  const noTz = run({ conclusion: 'success', completedAt: '2026-09-13T03:00:00' });
  assert.equal(evaluate([failed, noTz], false, [need()]).code, 2, '沒時區的成功不可以被當成比較晚');
  const impossible = run({ conclusion: 'success', completedAt: '2026-02-30T03:00:00Z' });
  assert.equal(evaluate([run({ conclusion: 'failure', completedAt: '2026-03-01T02:00:00Z' }), impossible], false, [need()]).code, 2,
    '不存在的日子（轉換器會進位成 3 月 2 日）不可以被當成比較晚的成功（r4 Medium①）');
  const script = `const { evaluate } = require(${JSON.stringify(require.resolve('../tools/gates/check-checks-really-ran.js'))});
    const r = (o) => ({ name: '三關', status: 'completed', conclusion: 'success', completedAt: '2026-09-13T01:00:00Z', producer: 'ci', ...o });
    const need = { name: '三關', producer: 'ci' };
    process.stdout.write(JSON.stringify([
      evaluate([r({ conclusion: 'failure', completedAt: '2026-09-13T02:00:00Z' }), r({ completedAt: '2026-09-13T03:00:00' })], false, [need]).code,
      evaluate([r({ conclusion: 'failure', completedAt: '2026-09-13T02:00:00Z' }), r({ completedAt: '2026-09-13T03:00:00Z' })], false, [need]).code,
    ]));`;
  const outs = ['UTC', 'Asia/Taipei'].map((tz) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, TZ: tz } }).stdout);
  assert.equal(outs[0], outs[1], `兩個時區判決不同：${outs.join(' | ')}`);
  assert.deepEqual(JSON.parse(outs[0]), [2, 0]);
});

test('⑩時間用時間值比：不同時區的合法寫法要排對', () => {
  const failedUtc = run({ conclusion: 'failure', completedAt: '2026-09-13T01:00:00Z' });
  const laterButLexSmaller = run({ conclusion: 'success', completedAt: '2026-09-13T00:30:00-01:00' });   // ＝01:30Z，比失敗晚
  assert.equal(evaluate([failedUtc, laterButLexSmaller], false, [need()]).code, 0, '01:30Z 的成功比 01:00Z 的失敗晚，應放行');
  const earlierButLexBigger = run({ conclusion: 'success', completedAt: '2026-09-13T02:00:00+02:00' });   // ＝00:00Z，比失敗早
  assert.equal(evaluate([failedUtc, earlierButLexBigger], false, [need()]).code, 1, '00:00Z 的成功比 01:00Z 的失敗早，最新是失敗');
  const sameInstant = run({ conclusion: 'skipped', completedAt: '2026-09-13T03:00:00+02:00' });   // ＝01:00Z，跟失敗同刻
  assert.equal(evaluate([run({ completedAt: '2026-09-13T01:00:00Z' }), sameInstant], false, [need()]).code, 1, '同一刻不同寫法也算並列');
});

test('同一刻並列：只要有一場不是成功就當不明、擋下來', () => {
  const tiedGood = run({ conclusion: 'success' });
  const tiedBad = run({ conclusion: 'skipped' });   // 完成時間一樣
  assert.equal(tiedGood.completedAt, tiedBad.completedAt, '這一題的前提：兩場同刻');
  const r = evaluate([tiedGood, tiedBad], false, [need()]);
  assert.equal(r.code, 1, '同刻結論不一致不可以放行——平台沒承諾誰比較晚');
  assert.match(r.reason, /同一刻結論不一致/u);
});

test('身分：必過檢查釘了產生者時，別人貼的同名成功不算數', () => {
  const impostor = run({ producer: 'someone-else' });
  assert.equal(evaluate([impostor], false, [need({ producer: 'ci' })]).code, 2, '只有冒名的場次＝找不到正牌＝退 2');
  assert.equal(evaluate([impostor], false, [need({ producer: null })]).code, 0, '名單說不限才放寬');
  assert.equal(evaluate([impostor, run()], false, [need({ producer: 'ci' })]).code, 0, '有正牌的就看正牌');
  // 冒名的那場比較晚也不可以蓋過正牌的判斷
  const lateImpostorBad = run({ producer: 'someone-else', conclusion: 'failure', completedAt: '2026-09-13T09:00:00Z' });
  assert.equal(evaluate([run(), lateImpostorBad], false, [need({ producer: 'ci' })]).code, 0, '別人的場次不該影響判斷');
});

test('每一條必過檢查都要各自成立，不是有一條過就算過', () => {
  const runs = [run(), run({ name: '第二關', conclusion: 'failure', producer: 'ci' })];
  assert.equal(evaluate(runs, false, [need(), need({ name: '第二關' })]).code, 1);
  assert.equal(evaluate([run()], false, [need(), need({ name: '沒跑過的關' })]).code, 2);
});

/** 假平台：照 answers 回答，並記下被問了什麼。 */
function fakePlatform(answers) {
  const asked = [];
  return {
    asked,
    ask(op, args) {
      asked.push([op, args]);
      const a = answers[op];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new PlatformError(`測試沒給 ${op} 的答案`);
      return a;
    },
  };
}
const settings = { mainBranch: 'main' };
const change = (over = {}) => ({ headSha: 'abc123', autoMergeOn: false, ...over });

test('問場次用的是這一支的頭，讀名單用的是設定裡的主幹', () => {
  const platform = fakePlatform({ change: change({ headSha: 'deadbeef' }), requiredChecks: [need()], checks: [run()] });
  assert.equal(gateRun('7', { settings: { mainBranch: '主線' }, platform }).code, 0);
  const asked = Object.fromEntries(platform.asked);
  assert.deepEqual(asked.checks, { sha: 'deadbeef' }, '要問這一支的頭');
  assert.deepEqual(asked.requiredChecks, { branch: '主線' }, '要讀設定裡的主幹，不是寫死的 main');
});

test('還在跑時自動輪詢等待（方案 A）：轉完正式還在跑的場次完成後自動放行；逾時＝1；等待途中換版本或問不到平台＝2；失敗結論不空等', () => {
  // 1. 第一輪還在跑、第二輪完成且成功＝放行
  let checkCalls = 0;
  let clock = 1000;
  const slept = [];
  const p1 = {
    ask(op) {
      if (op === 'change') return change({ headSha: 'abc123' });
      if (op === 'requiredChecks') return [need()];
      if (op === 'checks') {
        checkCalls += 1;
        return checkCalls === 1
          ? [run({ status: 'in_progress', conclusion: null, completedAt: null })]
          : [run()];
      }
      throw new PlatformError(`unexpected ${op}`);
    },
  };
  const r1 = gateRun('7', {
    settings,
    platform: p1,
    waitMs: 15000,
    pollMs: 5000,
    now: () => clock,
    sleep: (ms) => { slept.push(ms); clock += ms; },
  });
  assert.equal(r1.code, 0, r1.lines.join('\n'));
  assert.deepEqual(slept, [5000]);
  assert.match(r1.lines.join('\n'), /輪詢等待 1 次/u);

  // 2. 一直還在跑到逾時＝退 1（理由仍是還有場次在跑）
  let clock2 = 0;
  const slept2 = [];
  const p2 = {
    ask(op) {
      if (op === 'change') return change({ headSha: 'abc123' });
      if (op === 'requiredChecks') return [need()];
      return [run({ status: 'in_progress', conclusion: null, completedAt: null })];
    },
  };
  const r2 = gateRun('7', {
    settings,
    platform: p2,
    waitMs: 12000,
    pollMs: 5000,
    now: () => clock2,
    sleep: (ms) => { slept2.push(ms); clock2 += ms; },
  });
  assert.equal(r2.code, 1);
  assert.deepEqual(slept2, [5000, 5000, 2000]);
  assert.match(r2.lines.join('\n'), /還有場次在跑.*輪詢等待 3 次/u);

  // 3. 等待途中版本變了＝立刻退 2 不放行
  let changeCalls = 0;
  let clock3 = 0;
  const p3 = {
    ask(op) {
      if (op === 'change') {
        changeCalls += 1;
        return change({ headSha: changeCalls === 1 ? 'abc123' : 'def456' });
      }
      if (op === 'requiredChecks') return [need()];
      return [run({ status: 'in_progress', conclusion: null, completedAt: null })];
    },
  };
  const r3 = gateRun('7', {
    settings,
    platform: p3,
    waitMs: 10000,
    pollMs: 5000,
    now: () => clock3,
    sleep: (ms) => { clock3 += ms; },
  });
  assert.equal(r3.code, 2);
  assert.match(r3.lines.join('\n'), /等待必過檢查完成期間版本變了/u);

  // 3b. 等待途中問不到平台（輪詢第二次查詢拋 PlatformError）＝立刻退 2 不放行（r3 Finding 1）
  for (const failOp of ['change', 'checks']) {
    let pollStep = 0;
    let clock3b = 0;
    const p3b = {
      ask(op) {
        if (op === 'requiredChecks') return [need()];
        if (op === 'change') {
          pollStep += 1;
          if (pollStep >= 2 && failOp === 'change') throw new PlatformError('輪詢期間平台中斷');
          return change({ headSha: 'abc123' });
        }
        if (op === 'checks') {
          if (pollStep >= 2 && failOp === 'checks') throw new PlatformError('輪詢期間查場次中斷');
          return [run({ status: 'in_progress', conclusion: null, completedAt: null })];
        }
        throw new PlatformError(`unexpected ${op}`);
      },
    };
    const r3b = gateRun('7', {
      settings,
      platform: p3b,
      waitMs: 10000,
      pollMs: 5000,
      now: () => clock3b,
      sleep: (ms) => { clock3b += ms; },
    });
    assert.ok(pollStep >= 2, `${failOp} 確實進入第二次輪詢查詢`);
    assert.equal(r3b.code, 2, `輪詢期間 ${failOp} 查詢失敗必須退 2`);
    assert.match(r3b.lines.join('\n'), /問不到平台.*不放行/u);
  }

  // 4. 已經完成的失敗結論不輪詢空等
  const slept4 = [];
  const p4 = fakePlatform({ change: change(), requiredChecks: [need()], checks: [run({ conclusion: 'failure' })] });
  const r4 = gateRun('7', { settings, platform: p4, waitMs: 10000, pollMs: 5000, sleep: (ms) => slept4.push(ms) });
  assert.equal(r4.code, 1);
  assert.deepEqual(slept4, []);

  // 5. CLI 參數解析：預設等待 300000ms（輪詢間隔 5000ms）；--no-wait＝0；--wait-ms 指定毫秒；壞參數回 error
  assert.equal(DEFAULT_WAIT_MS, 300000);
  assert.equal(DEFAULT_POLL_MS, 5000);
  assert.deepEqual(parseCliArgs(['7']), { changeId: '7', waitMs: 300000 });
  assert.deepEqual(parseCliArgs(['7', '--no-wait']), { changeId: '7', waitMs: 0 });
  assert.deepEqual(parseCliArgs(['7', '--wait-ms', '12000']), { changeId: '7', waitMs: 12000 });
  assert.ok(parseCliArgs([]).error);
  assert.ok(parseCliArgs(['7', '--wait-ms', 'abc']).error);
  assert.ok(parseCliArgs(['7', '--unknown']).error);
  assert.ok(parseCliArgs(['7', '8']).error);
});

test('平台問不到＝退 2，絕不是退 0', () => {
  for (const answers of [
    { change: new PlatformError('沒登記') },
    { change: change(), requiredChecks: new PlatformError('形狀不合') },
    { change: change(), requiredChecks: [need()], checks: new PlatformError('指令壞了') },
  ]) {
    const r = gateRun('7', { settings, platform: fakePlatform(answers) });
    assert.equal(r.code, 2);
    assert.match(r.lines.join('\n'), /查不到就不是安全/u);
  }
});

test('主幹名沒填、沒給編號＝退 2，而且不會去問平台', () => {
  for (const bad of [{ mainBranch: '未設定' }, {}, { mainBranch: '' }]) {
    const platform = fakePlatform({ change: change(), requiredChecks: [need()], checks: [run()] });
    const r = gateRun('7', { settings: bad, platform });
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.match(r.lines.join('\n'), /主幹分支名/u);
    assert.equal(platform.asked.length, 0);
  }
  const platform = fakePlatform({ change: change(), requiredChecks: [need()], checks: [run()] });
  assert.equal(gateRun(undefined, { settings, platform }).code, 2);
  assert.equal(platform.asked.length, 0);
});

test('平台丟的不是平台的錯，就讓它炸出去', () => {
  assert.throws(() => gateRun('7', { settings, platform: fakePlatform({ change: new TypeError('程式寫錯') }) }), TypeError);
});

test('真的跑一遍指令（空白設定的複本，不讀本倉庫那份）：還沒填設定，退 2 不放行', () => {
  const r = runInCopy('tools/gates/check-checks-really-ran.js', ['7']);
  assert.equal(r.status, 2);
  assert.equal(runInCopy('tools/gates/check-checks-really-ran.js').status, 2);
});
