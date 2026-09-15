// 守掃描前試探（規矩 G2；裁示者 2026-09-12 裁「丙」：隔離不搬、只搬試探與比對）。
//
// 守得到的：
//   ①沒有隔離提供者／前綴沒填／禁區清單空＝退 2、什麼都不跑（什麼都沒試就說有效，比沒有試探更危險）；
//   ②對照組不活（盒外就讀不到假機密）＝退 2；盒內連自己的檔都讀不到或寫不進＝退 2（「全部失敗」不算擋住）；
//     ⚠️ 寫那一道的正面控制是 2026-09-13 稽核補的：盒內起不了 /bin/sh 時，寫探針的非零退出碼原本會被
//     當成「擋住」，一個真的寫入洞就被判成可以掃（稽核用真沙盒實測）。本檔最後一題釘住這一格。
//   ③任一禁區從盒內讀得到＝退 1；退出碼非零但輸出裡帶著假機密＝仍算讀得到；
//   ④寫進禁區：檔案真的落地＝退 1，不看退出碼；
//   ⑤探針逾時或被殺＝測不出＝退 2，不算擋住；
//   ⑥用一個真的會拒絕盒外路徑的假隔離跑一遍＝退 0，同一支假隔離開漏水模式＝退 1（證明試探會叫）；
//   ⑦不管哪條路出去，埋的假機密與盒子都清掉；印出來的每一行都不含假機密；
//   ⑧**指令入口**（cli）：例外收成退 2，不放行、也不把路徑丟出去；真的跑一遍指令會退非零（本倉庫沒設隔離）；
//   ⑨盒內環境變數是白名單重建的：呼叫者的 token 與家目錄不進盒（檔頭對這件事有宣稱，2026-09-13 前沒有考題撐）；
//   ⑩**埋與收**：埋出來的值真的落在每個禁區、寫進清單檔、每次都不一樣；收得乾淨；清單檔不見就照實說、不亂刪。
//     這一段補的是掃後比對接不到的那一截（掃描期間的假機密原本沒有任何東西會產）。
//
// ⚠️ 守不到的：隔離有沒有別的洞（它只試登記的那幾個目錄）；正式的隔離提供者到底有沒有效——那要在每個專案裡真的跑一次。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MACHINE, cli, probeRun, plantCanaries, sweepCanaries, runCommand, isBlocked, expandZone, minimalEnv, MANIFEST_SUFFIX, UNSET, NONE } = require('../tools/scan-probe.js');
const { runInCopy, unfilled } = require('./helpers/kit-copy.js');
const { gitEnv } = require('../tools/git-env.js');


const FAKE = path.join(__dirname, 'helpers', 'fake-isolation.js');

function tempZone() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scan-probe-zone-'));
}
function settingsWith(isolation) {
  return { scanner: { isolation } };
}
function honest(zones, extra = {}) {
  return settingsWith({ provider: '專案自建', wrap: [process.execPath, FAKE, '{box}'], boxRoot: UNSET, forbidden: zones, ...extra });
}
const plantedIn = (zone) => fs.readdirSync(zone).filter((n) => n.startsWith('.scan-probe-'));

/**
 * 假執行器：記下每一次的 argv 與 opts；reply 決定回什麼。
 * ⚠️ 兩道盒內正面控制（讀 inside.txt、寫 inside-write.txt）由這裡預設滿足，
 *    否則每一題都得自己重寫一遍那兩格；要考正面控制本身的題自己覆寫 reply。
 */
function fakeRunner(reply) {
  const calls = [];
  const opts = [];
  return {
    calls,
    opts,
    run(argv, o) {
      calls.push(argv);
      opts.push(o);
      const base = { status: 0, stdout: '', stderr: '', error: '' };
      const name = path.basename(argv[argv.length - 1] || '');
      if (name === 'inside.txt') return { ...base, stdout: 'INSIDE-OK' };
      if (name === 'inside-write.txt') { fs.writeFileSync(argv[argv.length - 1], 'WRITE-OK\n'); return base; }
      return { ...base, ...reply(argv, calls.length) };
    },
  };
}
const readSecretFromArgv = (argv) => { const f = argv.find((a) => path.basename(a) === 'fake-secret.txt'); return f ? fs.readFileSync(f, 'utf8').trim() : ''; };

test('沒有隔離提供者、前綴沒填、禁區清單空：都退 2、什麼都不跑', () => {
  for (const iso of [
    undefined,
    { provider: UNSET, wrap: ['x'], forbidden: ['~'] },
    { provider: NONE, wrap: ['x'], forbidden: ['~'] },
    { provider: '專案自建', wrap: [], forbidden: ['~'] },
    { provider: '專案自建', wrap: ['x'], forbidden: [] },
  ]) {
    const { run, calls } = fakeRunner(() => ({}));
    const r = probeRun({ settings: settingsWith(iso), run });
    assert.equal(r.code, 2, JSON.stringify(iso));
    assert.equal(calls.length, 0, '退 2 的時候不該跑任何東西');
  }
});

test('禁區清單的 ~ 代表家目錄', () => {
  assert.equal(expandZone('~', '/h'), '/h');
  assert.equal(expandZone('~/x', '/h'), path.join('/h', 'x'));
  assert.equal(expandZone('/abs', '/h'), '/abs');
});

test('isBlocked：非零退出碼且輸出無假機密才算擋住；null 不算；帶著機密不算', () => {
  assert.equal(isBlocked({ status: 1, stdout: '', stderr: '' }, 'S'), true);
  assert.equal(isBlocked({ status: 0, stdout: '', stderr: '' }, 'S'), false);
  assert.equal(isBlocked({ status: null, stdout: '', stderr: '' }, 'S'), false);
  assert.equal(isBlocked({ status: 1, stdout: 'S', stderr: '' }, 'S'), false);
  assert.equal(isBlocked({ status: 1, stdout: '', stderr: 'xxS' }, 'S'), false);
});

test('對照組不活（盒外就讀不到）：退 2', () => {
  const zone = tempZone();
  try {
    const { run } = fakeRunner(() => ({ status: 1 }));
    const r = probeRun({ settings: honest([zone]), run, home: zone });
    assert.equal(r.code, 2);
    assert.match(r.lines.join('\n'), /對照組不活/u);
  } finally { fs.rmSync(zone, { recursive: true, force: true }); }
});

test('盒內連自己的檔都讀不到：退 2，不算擋住', () => {
  const zone = tempZone();
  try {
    const { run } = fakeRunner(() => ({}));
    // 覆寫：這一題就是要考「盒內讀不到自己的檔」，所以連正面控制都讓它失敗
    const r = probeRun({
      settings: honest([zone]),
      run: (argv) => (argv[0] === process.execPath ? { status: 1, stdout: '', stderr: '', error: '' } : { status: 0, stdout: readSecretFromArgv(argv), stderr: '', error: '' }),
    });
    void run;
    assert.equal(r.code, 2);
    assert.match(r.lines.join('\n'), /盒內連自己的檔都讀不到/u);
    assert.doesNotMatch(r.lines.join('\n'), /🟢|🔴/u, '沒跑到探針就不該有探針的判定');
  } finally { fs.rmSync(zone, { recursive: true, force: true }); }
});

test('退出碼非零但輸出帶著假機密：仍算讀得到，退 1；印出來的行不含假機密', () => {
  const zone = tempZone();
  let secret = '';
  try {
    const { run } = fakeRunner((argv) => {
      const s = readSecretFromArgv(argv); if (s) secret = s;
      if (argv[0] !== process.execPath) return { status: 0, stdout: s };            // 盒外對照
      if (argv.some((a) => path.basename(a) === 'fake-secret.txt')) return { status: 1, stderr: `error: ${s}` };   // 看起來擋住、其實漏了
      return { status: 1 };
    });
    const r = probeRun({ settings: honest([zone]), run });
    assert.equal(r.code, 1);
    assert.ok(secret.length > 10, '假執行器應該讀得到埋的假機密');
    assert.ok(!r.lines.join('\n').includes(secret), '假機密不可以被印出來');
    assert.match(r.lines.join('\n'), /讀得到（隔離是假的）/u);
  } finally { fs.rmSync(zone, { recursive: true, force: true }); }
});

test('寫進禁區的檔案真的落地：退 1，不看退出碼', () => {
  const zone = tempZone();
  try {
    const { run } = fakeRunner((argv) => {
      if (argv[0] !== process.execPath) return { status: 0, stdout: readSecretFromArgv(argv) };
      const target = argv.find((a) => path.basename(a) === 'written-from-inside.txt');
      if (target) { fs.writeFileSync(target, 'x\n'); return { status: 1 }; }   // 說失敗、其實寫進去了
      return { status: 1 };
    });
    const r = probeRun({ settings: honest([zone]), run });
    assert.equal(r.code, 1);
    assert.match(r.lines.join('\n'), /寫得進（隔離是假的）/u);
    assert.deepEqual(plantedIn(zone), [], '埋的東西要清掉');
  } finally { fs.rmSync(zone, { recursive: true, force: true }); }
});

test('探針逾時或被殺：測不出＝退 2，不算擋住', () => {
  const zone = tempZone();
  try {
    const { run } = fakeRunner((argv) => {
      if (argv[0] !== process.execPath) return { status: 0, stdout: readSecretFromArgv(argv) };
      if (argv.some((a) => path.basename(a) === 'fake-secret.txt')) return { status: null, error: 'ETIMEDOUT' };
      return { status: 1 };
    });
    const r = probeRun({ settings: honest([zone]), run });
    assert.equal(r.code, 2);
    assert.match(r.lines.join('\n'), /測不出/u);
  } finally { fs.rmSync(zone, { recursive: true, force: true }); }
});

test('真的跑一遍：會拒絕盒外路徑的假隔離＝退 0；同一支開漏水模式＝退 1（試探會叫）；兩種都清乾淨', () => {
  const zone = tempZone();
  const boxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-probe-root-'));
  try {
    const ok = probeRun({ settings: honest([zone], { boxRoot }) });
    assert.equal(ok.code, 0, ok.lines.join('\n'));
    assert.match(ok.lines.join('\n'), /可以掃/u);
    assert.deepEqual(plantedIn(zone), []);
    assert.deepEqual(fs.readdirSync(boxRoot), [], '盒子要清掉');

    const leaky = probeRun({ settings: settingsWith({ provider: '專案自建', wrap: [process.execPath, FAKE, '{box}', '--leaky'], boxRoot, forbidden: [zone] }) });
    assert.equal(leaky.code, 1, leaky.lines.join('\n'));
    assert.match(leaky.lines.join('\n'), /讀得到（隔離是假的）/u);
    assert.match(leaky.lines.join('\n'), /寫得進（隔離是假的）/u);
    assert.deepEqual(plantedIn(zone), []);
    assert.deepEqual(fs.readdirSync(boxRoot), []);
  } finally {
    fs.rmSync(zone, { recursive: true, force: true });
    fs.rmSync(boxRoot, { recursive: true, force: true });
  }
});

test('禁區不存在：埋不進去＝退 2', () => {
  const { run } = fakeRunner(() => ({}));
  const r = probeRun({ settings: honest([path.join(os.tmpdir(), 'no-such-zone-' + process.pid)]), run });
  assert.equal(r.code, 2);
  assert.match(r.lines.join('\n'), /埋不進假機密/u);
});

test('寫探針回報成功但檔案沒落地：測不出＝退 2，不當作擋住也不當作寫得進', () => {
  const zone = tempZone();
  try {
    const { run } = fakeRunner((argv) => {
      if (argv[0] !== process.execPath) return { status: 0, stdout: readSecretFromArgv(argv) };
      if (argv.some((a) => path.basename(a) === 'written-from-inside.txt')) return { status: 0 };   // 說成功、其實沒寫
      return { status: 1 };
    });
    const r = probeRun({ settings: honest([zone]), run });
    assert.equal(r.code, 2);
    assert.match(r.lines.join('\n'), /回報成功但檔案沒落地/u);
  } finally { fs.rmSync(zone, { recursive: true, force: true }); }
});

test('盒內起不了寫入機制：判「測不出、不掃」，不可以判成「擋住、可以掃」（2026-09-13 稽核抓到的假綠）', () => {
  const zone = tempZone();
  const boxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-probe-root-'));
  try {
    // 先證明這個模式下「寫其實通得過」＝洞是真的：繞過被擋的 shell，直接寫進禁區
    const target = path.join(zone, 'hole.txt');
    fs.writeFileSync(target, 'x\n');
    assert.ok(fs.existsSync(target), '對照：這個情境下禁區其實寫得進');
    fs.rmSync(target, { force: true });

    const r = probeRun({
      settings: settingsWith({ provider: '專案自建', wrap: [process.execPath, FAKE, '{box}', '--no-shell'], boxRoot, forbidden: [zone] }),
    });
    const text = r.lines.join('\n');
    assert.equal(r.code, 2, `應該是測不出（不掃），實際 ${r.code}：\n${text}`);
    assert.match(text, /寫入機制在盒內起不來/u);
    assert.doesNotMatch(text, /可以掃/u, '絕不可以放行');
    assert.doesNotMatch(text, /🔴 擋住｜寫/u, '寫不進不可以被判成擋住——那個機制根本沒跑起來');
    assert.deepEqual(plantedIn(zone), [], '埋的東西要清掉');
    assert.deepEqual(fs.readdirSync(boxRoot), [], '盒子要清掉');
  } finally {
    fs.rmSync(zone, { recursive: true, force: true });
    fs.rmSync(boxRoot, { recursive: true, force: true });
  }
});

test('盒子建不起來時，錯誤訊息不印展開後的家目錄絕對路徑', () => {
  const { run } = fakeRunner(() => ({}));
  const r = probeRun({
    settings: settingsWith({ provider: '專案自建', wrap: [process.execPath, FAKE, '{box}'], boxRoot: '~/no-such-box-dir-for-test', forbidden: ['~'] }),
    run,
    home: '/Users/someone',
  });
  assert.equal(r.code, 2);
  const text = r.lines.join('\n');
  assert.doesNotMatch(text, /\/Users\/someone/u, '展開後的家目錄路徑不可以進掃描紀錄');
  assert.match(text, /no-such-box-dir-for-test/u, '設定裡的原字串照印，才看得出是哪一格沒設好');
});

test('盒內的環境變數是白名單重建的：呼叫者的 token 與家目錄不進盒', () => {
  const prev = { ...process.env };
  process.env.GITHUB_TOKEN = 'SENTINEL-GH-DO-NOT-LEAK';
  process.env.ANTHROPIC_API_KEY = 'SENTINEL-AN-DO-NOT-LEAK';
  try {
    const env = minimalEnv('/box');
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR'], '只有這四個鍵；要加就得先改這一題');
    assert.equal(env.HOME, '/box', '家目錄指進盒子，不是真的家目錄');
    assert.ok(!Object.values(env).some((v) => String(v).includes('SENTINEL-')), '呼叫者的哨兵不可以進盒');
    assert.notEqual(env.HOME, os.homedir());
  } finally {
    for (const k of ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});

test('呼叫點真的用了那份白名單環境變數（不是只有函式對）', () => {
  const zone = tempZone();
  try {
    const { run, opts } = fakeRunner(() => ({ status: 1 }));
    probeRun({
      settings: honest([zone]),
      run: (argv, o) => { const r = run(argv, o); return argv[0] === process.execPath ? r : { status: 0, stdout: readSecretFromArgv(argv), stderr: '', error: '' }; },
    });
    const boxCalls = opts.filter(Boolean).filter((o) => o.env);
    assert.ok(boxCalls.length > 0, '盒內的每一次呼叫都要帶 env');
    for (const o of boxCalls) {
      assert.deepEqual(Object.keys(o.env).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
      assert.notEqual(o.env.HOME, os.homedir(), '盒內的家目錄不可以是真的家目錄');
    }
  } finally { fs.rmSync(zone, { recursive: true, force: true }); }
});

test('預設執行器：指令起不來＝status null（呼叫端當測不出），不是 0', () => {
  const missing = runCommand(['/no/such/probe-binary-for-test']);
  assert.equal(missing.status, null, '起不來要回 null，呼叫端才會判測不出');
  assert.equal(isBlocked(missing, 'S'), false, 'null 不算擋住');
  assert.equal(runCommand([process.execPath, '-e', 'process.exit(4)']).status, 4);
});

test('指令入口：例外收成退 2，訊息不帶路徑；真的跑一遍指令不會放行', () => {
  const boom = cli({ settings: { machines: [{ name: MACHINE, state: '已啟用' }], get scanner() { throw Object.assign(new Error('/Users/someone/secret'), { code: 'EBOOM' }); } } });
  assert.equal(boom.code, 2);
  assert.match(boom.lines.join('\n'), /EBOOM/u);
  assert.ok(!boom.lines.join('\n').includes('/Users/someone'), '例外訊息不可以帶路徑');

  const r = runInCopy('tools/scan-probe.js');
  assert.equal(r.status, 2, '空白設定的複本：沒設隔離＝不掃（不讀本倉庫那份——填了真設定會在真禁區埋假機密）');
  assert.match(`${r.stdout || ''}`, /沒有隔離/u);
});

test('埋與收：值落在每個禁區、寫進清單檔、每次都不一樣；收完一個都不留', () => {
  const zoneA = tempZone();
  const zoneB = tempZone();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-canary-out-'));
  const out = path.join(work, 'live-secrets.txt');
  try {
    const settings = settingsWith({ provider: '專案自建', wrap: ['x'], boxRoot: UNSET, forbidden: [zoneA, zoneB] });
    const planted = plantCanaries({ settings, outFile: out });
    assert.equal(planted.code, 0, planted.lines.join('\n'));
    assert.equal(planted.secrets.length, 2, '每個禁區各一個');
    assert.equal(new Set(planted.secrets).size, 2, '兩個禁區的值不可以一樣');

    // 值真的在禁區的磁碟上，而且清單檔拿得到（掃後比對就是靠這個檔）
    const fromFile = fs.readFileSync(out, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
    assert.deepEqual(fromFile, planted.secrets);
    for (const [i, zone] of [zoneA, zoneB].entries()) {
      const dirs = fs.readdirSync(zone).filter((n) => n.startsWith('.scan-canary-'));
      assert.equal(dirs.length, 1, `${zone} 應該剛好埋了一個`);
      assert.match(fs.readFileSync(path.join(zone, dirs[0], 'canary.txt'), 'utf8'), new RegExp(planted.secrets[i], 'u'));
    }
    assert.ok(fs.existsSync(`${out}${MANIFEST_SUFFIX}`), '要留下埋在哪的清單，收的時候才知道刪什麼');

    // 再埋一次：值不可以重複（不然「每掃現生」就是假的）
    const out2 = path.join(work, 'second.txt');
    const again = plantCanaries({ settings, outFile: out2 });
    assert.equal(again.code, 0);
    assert.equal(new Set([...planted.secrets, ...again.secrets]).size, 4, '兩次埋出來的值必須全部不同');
    assert.equal(sweepCanaries({ outFile: out2 }).code, 0);

    const swept = sweepCanaries({ outFile: out });
    assert.equal(swept.code, 0, swept.lines.join('\n'));
    for (const zone of [zoneA, zoneB]) {
      assert.deepEqual(fs.readdirSync(zone).filter((n) => n.startsWith('.scan-canary-')), [], '收完不可以留在禁區裡');
    }
    assert.ok(!fs.existsSync(out) && !fs.existsSync(`${out}${MANIFEST_SUFFIX}`), '清單檔與值檔都要刪掉');
  } finally {
    for (const d of [zoneA, zoneB, work]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('埋：禁區清單空的、沒給清單檔位置、埋不進去，都退 2（沒有鐵證就不要開始掃）', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-canary-out-'));
  try {
    const base = { provider: '專案自建', wrap: ['x'], boxRoot: UNSET };
    assert.equal(plantCanaries({ settings: settingsWith({ ...base, forbidden: [] }), outFile: path.join(work, 'a.txt') }).code, 2);
    assert.equal(plantCanaries({ settings: settingsWith({ ...base, forbidden: ['/tmp'] }) }).code, 2);
    const bad = plantCanaries({
      settings: settingsWith({ ...base, forbidden: [path.join(os.tmpdir(), 'no-such-zone-' + process.pid)] }),
      outFile: path.join(work, 'b.txt'),
    });
    assert.equal(bad.code, 2);
    assert.match(bad.lines.join('\n'), /埋不進去/u);
    assert.ok(!fs.existsSync(path.join(work, 'b.txt')), '埋失敗就不該留下半份清單檔');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('收：清單檔不見就照實說、不亂刪', () => {
  const zone = tempZone();
  try {
    fs.mkdirSync(path.join(zone, '.scan-canary-someone-elses'));
    const r = sweepCanaries({ outFile: path.join(zone, 'no-such-list.txt') });
    assert.equal(r.code, 2);
    assert.match(r.lines.join('\n'), /清單檔讀不到/u);
    assert.ok(fs.existsSync(path.join(zone, '.scan-canary-someone-elses')), '不知道埋在哪就不可以動別人的東西');
    assert.equal(sweepCanaries({}).code, 2);
  } finally { fs.rmSync(zone, { recursive: true, force: true }); }
});

test('整條鏈接得起來：埋出來的值餵給掃後比對，混進輸出就判事故', () => {
  const zone = tempZone();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-chain-'));
  const out = path.join(work, 'live.txt');
  try {
    const planted = plantCanaries({
      settings: settingsWith({ provider: '專案自建', wrap: ['x'], boxRoot: UNSET, forbidden: [zone] }),
      outFile: out,
    });
    assert.equal(planted.code, 0);
    const { compare } = require('../tools/scan-postmortem.js');
    const secrets = fs.readFileSync(out, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
    const leaked = compare({ secrets, outputs: [{ where: '回覆', text: `我讀到了 ${planted.secrets[0]}` }] });
    assert.equal(leaked.code, 1, '掃描期間的假機密出現在回覆裡＝破口＝事故');
    assert.ok(!leaked.lines.join('\n').includes(planted.secrets[0]));
    assert.equal(compare({ secrets, outputs: [{ where: '回覆', text: '一切正常' }] }).code, 0);
  } finally {
    sweepCanaries({ outFile: out });
    for (const d of [zone, work]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('前綴裡的 {projectRoot} 換成專案根目錄：隔離設定檔住在專案裡時不必寫完整路徑（搬家前準備）', () => {
  const zone = tempZone();
  const boxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-probe-root-'));
  const noRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-probe-noroot-'));
  try {
    const rel = path.relative(path.join(__dirname, '..'), FAKE);
    const withToken = settingsWith({ provider: '專案自建', wrap: [process.execPath, `{projectRoot}/${rel}`, '{box}'], boxRoot, forbidden: [zone] });
    const ok = probeRun({ settings: withToken });
    assert.equal(ok.code, 0, `記號換成專案根目錄、找得到假隔離＝照常試探：\n${ok.lines.join('\n')}`);
    // 對照組：專案根目錄給錯＝那支檔找不到＝測不出（不是靜靜當成擋住）
    const wrongRoot = probeRun({ settings: withToken, projectRoot: noRoot });
    assert.equal(wrongRoot.code, 2, wrongRoot.lines.join('\n'));
    assert.deepEqual(plantedIn(zone), []);
    assert.deepEqual(fs.readdirSync(boxRoot), [], '盒子要清掉');
  } finally {
    fs.rmSync(zone, { recursive: true, force: true });
    fs.rmSync(boxRoot, { recursive: true, force: true });
    fs.rmSync(noRoot, { recursive: true, force: true });
  }
});

test('指令入口：專案沒把這台機器登記已啟用就不跑——試探與埋都什麼都不做；收照樣能收（搬家第 2 步 Grok 複審後掃）', () => {
  const zone = tempZone();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-canary-out-'));
  try {
    const iso = { provider: '專案自建', wrap: [process.execPath, FAKE, '{box}'], boxRoot: UNSET, forbidden: [zone] };
    const withState = (machines) => ({ machines, scanner: { isolation: iso } });
    const cases = [
      ['登記已安裝未啟用', [{ name: MACHINE, state: '已安裝未啟用' }]],
      ['登記未移植', [{ name: MACHINE, state: '未移植' }]],
      ['沒有這一列', [{ name: '掃描前試探', state: '已啟用' }]],
      ['這一列重複', [{ name: MACHINE, state: '已啟用' }, { name: MACHINE, state: '已啟用' }]],
      ['沒有機器表', undefined],
    ];
    for (const [why, machines] of cases) {
      const out = path.join(work, 'x.txt');
      for (const argv of [[], ['--plant', out]]) {
        // 試探會在禁區埋了又收（最後看是空的），所以另外用假執行器數「有沒有動手跑盒內指令」
        const { run, calls } = fakeRunner(() => ({}));
        const r = cli({ settings: withState(machines), run }, argv);
        assert.equal(calls.length, 0, `${why}（${argv.join(' ') || '試探'}）：一個盒內指令都不可以跑`);
        assert.equal(r.code, 2, `${why}（${argv.join(' ') || '試探'}）：要拒絕`);
        assert.match(r.lines.join('\n'), /掃描前試探/u, `${why}：訊息要講是哪一台`);
        assert.deepEqual(fs.readdirSync(zone), [], `${why}（${argv.join(' ') || '試探'}）：禁區裡什麼都不可以有`);
        assert.ok(!fs.existsSync(out), `${why}：不可以留下清單檔`);
      }
    }
    // 對照組：同一份設定登記已啟用，跨過閘、開始執行探針；埋真的會動手（證明上面的「什麼都沒做」是這一道擋的）
    const live = fakeRunner(() => ({ status: 1, stdout: '', stderr: 'Operation not permitted' }));
    cli({ settings: withState([{ name: MACHINE, state: '已啟用' }]), run: live.run }, []);
    assert.ok(live.calls.length > 0, '對照組：已啟用時跨過閘、開始執行探針（至少叫了一次指令；這個假執行器讓盒外對照不活，所以沒走到盒內那一步）');
    const planted = cli({ settings: withState([{ name: MACHINE, state: '已啟用' }]) }, ['--plant', path.join(work, 'ok.txt')]);
    assert.equal(planted.code, 0, planted.lines.join('\n'));
    assert.equal(fs.readdirSync(zone).filter((n) => n.startsWith('.scan-canary-')).length, 1, '對照組：已啟用就真的埋了');
    // 收不擋：機器改成未啟用之後，已經埋的照樣收得回來
    const swept = cli({ settings: withState([{ name: MACHINE, state: '已安裝未啟用' }]) }, ['--sweep', path.join(work, 'ok.txt')]);
    assert.equal(swept.code, 0, swept.lines.join('\n'));
    assert.deepEqual(fs.readdirSync(zone), [], '收完禁區是空的');
    // 名字要跟設定的機器表那一列一字不差（改名時兩邊一起改）
    assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'settings.json'), 'utf8')).machines.filter((m) => m.name === MACHINE).length, 1, '本倉庫設定的機器表要剛好有這一列');
  } finally {
    for (const d of [zone, work]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('真的跑一遍指令（讀複本自己的 settings.json）：機器未啟用＝試探與埋都不碰禁區；已啟用＝真的會碰（接鉤子前批預審）', () => {
  const zone = tempZone();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-canary-out-'));
  const PAST = new Date('2001-02-03T04:05:06Z');
  try {
    const settingsFor = (state) => {
      const s = unfilled();
      const row = s.machines.find((m) => m.name === MACHINE);
      assert.ok(row, '前提：空白設定裡有這一列');
      row.state = state;
      s.scanner.isolation = { provider: '專案自建', wrap: [process.execPath, FAKE, '{box}'], boxRoot: UNSET, forbidden: [zone] };
      return s;
    };
    const out = path.join(work, 'live.txt');
    for (const argv of [[], ['--plant', out]]) {
      fs.utimesSync(zone, PAST, PAST);
      const r = runInCopy('tools/scan-probe.js', argv, { settings: settingsFor('已安裝未啟用') });
      assert.equal(r.status, 2, `未啟用（${argv.join(' ') || '試探'}）：${r.stdout}`);
      assert.match(r.stdout, /掃描前試探/u);
      assert.equal(fs.statSync(zone).mtimeMs, PAST.getTime(), `未啟用（${argv.join(' ') || '試探'}）：禁區一次都不可以被寫（埋了又收也算）`);
      assert.ok(!fs.existsSync(out), '未啟用：不可以留下清單檔');
    }
    // 對照組：同一份設定改成已啟用，試探與埋真的會碰禁區（證明上面的「沒被寫」是這一道擋的，不是這個環境寫不進去）
    fs.utimesSync(zone, PAST, PAST);
    const probe = runInCopy('tools/scan-probe.js', [], { settings: settingsFor('已啟用') });
    assert.notEqual(fs.statSync(zone).mtimeMs, PAST.getTime(), `對照組：已啟用時試探真的在禁區埋過（${probe.stdout}）`);
    const planted = runInCopy('tools/scan-probe.js', ['--plant', out], { settings: settingsFor('已啟用') });
    assert.equal(planted.status, 0, planted.stdout);
    assert.equal(fs.readdirSync(zone).filter((n) => n.startsWith('.scan-canary-')).length, 1, '對照組：已啟用就真的埋了');
    assert.equal(sweepCanaries({ outFile: out }).code, 0);
  } finally {
    for (const d of [zone, work]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('收：只刪絕對路徑、名字 .scan-canary- 開頭、真的是目錄的；相對路徑、名字不對、一般檔案、連結一律不碰、算收不掉', () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-canary-out-')));
  try {
    const sweepVia = (entries, cwd = work) => {
      const out = path.join(work, `list-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(out, 'x\n');
      fs.writeFileSync(`${out}${MANIFEST_SUFFIX}`, `${entries.join('\n')}\n`);
      // 從固定的工作目錄起子行程跑指令入口（相對路徑要有一個確定的起點，才考得到「相對路徑不刪」）
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'scan-probe.js'), '--sweep', out], { cwd, encoding: 'utf8', env: gitEnv() });
      return r;
    };
    // 相對路徑：真的存在、名字也對，照樣不刪
    const relDir = path.join(work, 'relative', '.scan-canary-keep');
    fs.mkdirSync(relDir, { recursive: true });
    fs.writeFileSync(path.join(relDir, 'important.txt'), 'x');
    const rel = sweepVia(['relative/.scan-canary-keep']);
    assert.equal(rel.status, 2, rel.stdout);
    assert.ok(fs.existsSync(path.join(relDir, 'important.txt')), '相對路徑不可以刪（就算名字對、也真的存在）');
    // 名字不對的絕對路徑
    const keep = path.join(work, 'not-a-canary-project-data');
    fs.mkdirSync(keep);
    fs.writeFileSync(path.join(keep, 'important.txt'), 'x');
    assert.equal(sweepVia([keep]).status, 2);
    assert.ok(fs.existsSync(path.join(keep, 'important.txt')), '名字不是 .scan-canary- 開頭的不可以刪');
    // 名字對但不是目錄：一般檔案、連結
    const plainFile = path.join(work, '.scan-canary-ordinary-file');
    fs.writeFileSync(plainFile, 'x');
    assert.equal(sweepVia([plainFile]).status, 2);
    assert.ok(fs.existsSync(plainFile), '一般檔案不可以刪');
    const linkTarget = path.join(work, 'link-target');
    fs.mkdirSync(linkTarget);
    fs.writeFileSync(path.join(linkTarget, 'important.txt'), 'x');
    const link = path.join(work, '.scan-canary-link');
    fs.symlinkSync(linkTarget, link);
    assert.equal(sweepVia([link]).status, 2);
    assert.ok(fs.lstatSync(link).isSymbolicLink() && fs.existsSync(path.join(linkTarget, 'important.txt')), '連結不可以刪、連結指到的東西也不可以動');
    // 對照組：合法的絕對路徑目錄照樣收掉、退 0；已經不在的不算失敗
    const canary = path.join(work, '.scan-canary-abc');
    fs.mkdirSync(canary);
    const ok = sweepVia([canary, path.join(work, '.scan-canary-already-gone')]);
    assert.equal(ok.status, 0, ok.stdout);
    assert.ok(!fs.existsSync(canary), '對照組：名字對、絕對路徑、真的是目錄＝收掉');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('埋與收接得起來、而且只收自己真實位置上的：禁區寫成相對路徑＝試探與埋都拒絕、零寫入；禁區經過連結別名＝照樣收得回來；清單上帶尾端斜線或經過連結的路徑一律不刪（#606 r1）', () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-canary-round-')));
  const PAST = new Date('2001-02-03T04:05:06Z');
  try {
    const realZone = path.join(work, 'real-zone');
    fs.mkdirSync(realZone);
    const alias = path.join(work, 'alias-zone');
    fs.symlinkSync(realZone, alias);
    const settingsFor = (forbidden) => {
      const st = unfilled();
      st.machines.find((m) => m.name === MACHINE).state = '已啟用';
      st.scanner.isolation = { provider: '專案自建', wrap: [process.execPath, FAKE, '{box}'], boxRoot: UNSET, forbidden };
      return st;
    };
    const tool = path.join(__dirname, '..', 'tools', 'scan-probe.js');
    const inCopy = (argv, settings) => runInCopy('tools/scan-probe.js', argv, { settings });

    // 相對禁區：從固定目錄起跑，那個目錄一次都不可以被寫
    const cwdDir = path.join(work, 'cwd');
    fs.mkdirSync(path.join(cwdDir, 'zone'), { recursive: true });
    for (const argv of [[], ['--plant', path.join(work, 'rel.txt')]]) {
      fs.utimesSync(path.join(cwdDir, 'zone'), PAST, PAST);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-copy-rel-'));
      try {
        fs.cpSync(path.join(__dirname, '..', 'tools'), path.join(dir, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settingsFor(['zone'])));
        const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'scan-probe.js'), ...argv], { cwd: cwdDir, encoding: 'utf8', env: gitEnv() });
        assert.equal(r.status, 2, `相對禁區（${argv.join(' ') || '試探'}）：${r.stdout}`);
        assert.match(r.stdout, /不是絕對路徑/u);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      assert.equal(fs.statSync(path.join(cwdDir, 'zone')).mtimeMs, PAST.getTime(), `相對禁區（${argv.join(' ') || '試探'}）：一次都不可以寫進去`);
      assert.ok(!fs.existsSync(path.join(work, 'rel.txt')), '相對禁區：不可以留下清單檔');
    }

    // 經過連結別名的禁區：埋記下真實位置，收得回來
    const out = path.join(work, 'alias.txt');
    const planted = inCopy(['--plant', out], settingsFor([alias]));
    assert.equal(planted.status, 0, planted.stdout);
    const recorded = fs.readFileSync(`${out}${MANIFEST_SUFFIX}`, 'utf8').trim();
    assert.ok(recorded.startsWith(`${realZone}${path.sep}.scan-canary-`), `清單記的是解開連結後的真實位置：${recorded}`);
    const swept = spawnSync(process.execPath, [tool, '--sweep', out], { cwd: work, encoding: 'utf8', env: gitEnv() });
    assert.equal(swept.status, 0, swept.stdout);
    assert.deepEqual(fs.readdirSync(realZone), [], '埋的東西收乾淨');

    // 清單被改成奇怪的寫法：一律不刪（哨兵檔要還在），而且收不掉時位置清單留著
    const target = path.join(work, 'important-directory');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'sentinel'), 'x');
    const link = path.join(work, '.scan-canary-link');
    fs.symlinkSync(target, link);
    const realCanary = path.join(realZone, '.scan-canary-real');
    fs.mkdirSync(realCanary);
    fs.writeFileSync(path.join(realCanary, 'canary.txt'), 'x');
    const sweepWith = (entries) => {
      const f = path.join(work, `odd-${Math.random().toString(36).slice(2)}.txt`);
      fs.writeFileSync(f, 'x\n');
      fs.writeFileSync(`${f}${MANIFEST_SUFFIX}`, `${entries.join('\n')}\n`);
      const r = spawnSync(process.execPath, [tool, '--sweep', f], { cwd: work, encoding: 'utf8', env: gitEnv() });
      return { r, manifestKept: fs.existsSync(`${f}${MANIFEST_SUFFIX}`) };
    };
    for (const [why, entry] of [
      ['連結加尾端斜線', `${link}/`],
      ['連結加兩個尾端斜線', `${link}//`],
      ['經過連結別名的父目錄', path.join(alias, '.scan-canary-real')],
      ['真的目錄但帶尾端斜線', `${realCanary}/`],
    ]) {
      const { r, manifestKept } = sweepWith([entry]);
      assert.equal(r.status, 2, `${why}：要算收不掉（${r.stdout}）`);
      assert.ok(fs.existsSync(path.join(target, 'sentinel')), `${why}：連結指到的目錄不可以被刪`);
      assert.ok(fs.existsSync(path.join(realCanary, 'canary.txt')), `${why}：不是一字不差的路徑不可以刪`);
      assert.ok(manifestKept, `${why}：收不掉時位置清單要留著`);
    }
    // 對照組：一字不差的真實位置照樣收
    const { r: ok, manifestKept } = sweepWith([realCanary]);
    assert.equal(ok.status, 0, ok.stdout);
    assert.ok(!fs.existsSync(realCanary), '對照組：一字不差的真實位置收掉');
    assert.ok(!manifestKept, '對照組：全部收掉時位置清單刪掉');
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
