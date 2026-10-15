// @ts-check
// 本題只使用自有假安裝、假 auth、假 relay、假金絲雀；不連模型、不讀使用者憑證。
// git 沙盒沿用 helpers/grok-scan-flow-fixtures.js 的從零環境；Seatbelt 能力由該夾具探測。
// 對本題捕捉到的假 grok 子程序群組注入 EPERM／ESRCH，其他 PID 仍交原方法。
// 這只驗收尾控制流，不證明原全測的卡住原因、沙箱或真模型能力。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { runScan } from '../scripts/grok-scan.js';
import { SANDBOX_OK, SKIP_AFTER_CANARY, cleanupTempRoots, fakeGrok, fakeRelay, isolated, promptFile, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);
const identity = { project: 'owner/repo', change: '17', reviewer: 'Grok', source: 'Grok CLI', round: 1 };
const cases = [
  { name: 'main 與 finally 群組皆拒絕，relay 真 close、保盒且不讀', group: 'all' },
  { name: 'main 群組拒絕後 finally ESRCH，清盒但保留原錯', group: 'first' },
  { name: 'ESRCH 成功線仍交付正式結果、收 relay 與盒子', group: 'none' },
  { name: '正式結果暫寫後 finally 群組拒絕，撤銷成功產物', group: 'final' },
  { name: '群組拒絕並遇 relay/live 清理錯，其餘仍收且原錯保留', group: 'all', fault: 'relay-live' },
  { name: 'relay 未 close 的等待有界且不得交付正式結果', group: 'none', fault: 'relay-timeout' },
  { name: 'dummy 清理錯不跳過盒子與 handler，也撤銷正式結果', group: 'none', fault: 'dummy' },
  { name: 'live 清理錯不跳過 dummy 與 handler，也撤銷正式結果', group: 'none', fault: 'live' },
  { name: 'box 清理錯仍卸 handler 並撤銷正式結果', group: 'none', fault: 'box' },
  { name: '事故指紋寫出後 finally 拒絕，保留去機密事故證據', group: 'final', incident: true },
];

for (const scenario of cases) test(`runScan 收尾｜${scenario.name}`, { timeout: 20000 }, async (t) => {
  if (!SANDBOX_OK) { t.skip(SKIP_AFTER_CANARY); return; }
  const repo = tinyRepo(), iso = isolated(), relayScript = fakeRelay();
  const liveSecret = 'SYNTHETIC-LIVE-SECRET-FOR-CLEANUP-ONLY';
  const inst = fakeGrok({ model: 'grok-4.7', reply: scenario.incident ? liveSecret : 'FAKE-REPLY' });
  const originalSpawn = childProcess.spawn, originalKill = process.kill, originalRm = fs.rmSync;
  /** @type {import('node:child_process').ChildProcess | undefined} */ let relay;
  /** @type {number | undefined} */ let ownedPgid;
  let box = '', relayStops = 0, relayClosed = false, liveRemovals = 0, dummyRemovals = 0, boxRemovals = 0;
  let groupCalls = 0, groupFailures = 0, boxReadsAfterRefusal = 0, reviewWritten = false, incidentWritten = false;
  const groupError = Object.assign(new Error('synthetic-private-group-refusal'), { code: 'EPERM' });
  const finalGroupError = Object.assign(new Error('synthetic-private-final-group-refusal'), { code: 'EPERM' });
  const initialTerm = process.listenerCount('SIGTERM'), initialInt = process.listenerCount('SIGINT');
  t.mock.method(childProcess, 'spawn', (command, argv, options) => {
    const child = originalSpawn(command, argv, options);
    if (command === '/bin/sh' && argv?.includes('grok-scan-sh')) ownedPgid = child.pid;
    if (argv?.[0] === relayScript) {
      relay = child;
      child.once('close', () => { relayClosed = true; });
      const kill = child.kill.bind(child);
      t.mock.method(child, 'kill', (signal) => {
        relayStops++;
        if (scenario.fault === 'relay-live') throw new Error('synthetic-private-relay-failure');
        if (scenario.fault === 'relay-timeout') return true;
        return kill(signal);
      });
    }
    return child;
  });
  t.mock.method(process, 'kill', (pid, signal) => {
    if (ownedPgid !== undefined && pid === -ownedPgid) {
      groupCalls++;
      if (scenario.group === 'all' || (scenario.group === 'first' && groupCalls === 1) || (scenario.group === 'final' && groupCalls > 1)) {
        groupFailures++;
        throw groupCalls === 1 ? groupError : finalGroupError;
      }
      // 假 grok 已從 close 返回；本題只控制群組查詢答案，不殺其他程序。
      throw Object.assign(new Error('synthetic empty group'), { code: 'ESRCH' });
    }
    return originalKill.call(process, pid, signal);
  });
  t.mock.method(fs, 'rmSync', (path, options) => {
    if (String(path).startsWith(iso.liveRoot + '/')) {
      liveRemovals++;
      if (scenario.fault === 'live' || scenario.fault === 'relay-live') throw new Error('synthetic-private-live-failure');
    }
    if (String(path).startsWith(iso.authDir + '/dummy-bearer.')) {
      dummyRemovals++;
      if (scenario.fault === 'dummy') throw new Error('synthetic-private-dummy-failure');
    }
    if (path === box) {
      boxRemovals++;
      if (scenario.fault === 'box') throw new Error('synthetic-private-box-failure');
    }
    return originalRm(path, options);
  });
  for (const method of ['readFileSync', 'readdirSync', 'openSync']) {
    const original = fs[method].bind(fs);
    t.mock.method(fs, method, (path, ...args) => {
      if (groupFailures && box && (String(path) === box || String(path).startsWith(box + '/'))) boxReadsAfterRefusal++;
      return original(path, ...args);
    });
  }
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (path, data, options) => {
    const result = originalWrite(path, data, options);
    if (String(path).startsWith(iso.resultsRoot + '/') && String(path).endsWith('/review-result.json')) reviewWritten = true;
    if (String(path).startsWith(iso.resultsRoot + '/') && String(path).endsWith('/incident.json')) incidentWritten = true;
    return result;
  });
  syncBuiltinESMExports();
  try {
    let failure;
    let result;
    try {
      result = await runScan({ base: repo.base, head: repo.head, promptFile: promptFile(),
        purpose: 'review', model: 'grok-4.7', effort: 'xhigh', review: identity }, {
        ...iso, repo: repo.dir, ...withGrok(inst), relayScript, liveSecret,
        log: (line) => { if (line.startsWith('盒子：')) box = line.slice('盒子：'.length); },
      });
    } catch (error) { failure = error; }
    assert.ok(relay && ownedPgid && box && groupCalls >= 2, '未走完本題的假子程序與兩次群組等待');
    assert.ok(relayStops > 0, '群組拒絕讓 relay 收尾被跳過');
    if (!scenario.fault?.startsWith('relay-')) assert.equal(relayClosed, true, '函式已返回但本場 relay 尚未 close');
    assert.ok(liveRemovals > 0 && dummyRemovals > 0, '盒外資源收尾被跳過');
    assert.equal(boxReadsAfterRefusal, 0, '群組拒絕後又讀盒子');
    const keepBox = scenario.group === 'all' || scenario.group === 'final';
    assert.equal(boxRemovals, keepBox ? 0 : 1, '群組空判準與清盒不一致');
    assert.equal(fs.existsSync(box), keepBox || scenario.fault === 'box');
    if (scenario.fault !== 'live' && scenario.fault !== 'relay-live') assert.deepEqual(fs.readdirSync(iso.liveRoot), []);
    if (scenario.fault !== 'dummy') assert.equal(fs.readdirSync(iso.authDir).some((name) => name.startsWith('dummy-bearer.')), false);
    assert.equal(process.listenerCount('SIGTERM'), initialTerm);
    assert.equal(process.listenerCount('SIGINT'), initialInt);
    if (scenario.group === 'none' && !scenario.fault) {
      assert.equal(failure, undefined);
      assert.equal(result?.code, 0);
      assert.equal(reviewWritten, true);
      assert.ok(result?.review);
      assert.equal(fs.existsSync(join(result.review.resultsDir, 'review-result.json')), true);
    } else {
      assert.ok(failure instanceof Error, '清理失敗被當作正常結果');
      assert.equal(result, undefined);
      assert.equal(failure.message.includes('synthetic-private'), false, '公開訊息帶出原例外');
      if (groupFailures) { assert.ok(failure.cause instanceof Error); assert.equal(failure.cause.cause, scenario.group === 'final' ? finalGroupError : groupError, '最早群組原因被後續清理錯覆蓋'); }
      if (scenario.fault === 'relay-live') assert.deepEqual(failure.cleanupStages, ['group', 'relay', 'live']);
      const files = fs.readdirSync(iso.resultsRoot, { recursive: true }).map(String);
      assert.equal(files.some((name) => /review-(result|manifest)\.json$/.test(name)), false, '收尾失敗仍留下正式結果');
      if (scenario.incident) {
        assert.equal(incidentWritten, true, '沒有真的走到事故寫入');
        assert.ok(files.some((name) => name.endsWith('/incident.json')), '收尾錯把事故證據抹掉');
        assert.equal(reviewWritten, false);
      } else {
        assert.deepEqual(files, []);
        if (scenario.group === 'final' || scenario.fault && scenario.group === 'none') assert.equal(reviewWritten, true, '未走到成功產物暫寫，撤銷題無效');
      }
    }
  } finally {
    // 即使被測程式漏清，也只收本題持有的 handle；合成子程序確定停了才移除刻意保留的盒子。
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (relay && !relayClosed) {
      const closed = new Promise((resolve) => relay.once('close', resolve));
      relay.kill('SIGKILL');
      await closed;
    }
    if (box) originalRm(box, { recursive: true, force: true });
  }
});
