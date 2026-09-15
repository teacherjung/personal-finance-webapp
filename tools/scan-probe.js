#!/usr/bin/env node
// 掃描前試探：隔離是不是真的（規矩 G2；裁示者 2026-09-12 裁「丙」）。
//
// 裁「丙」的內容：隔離本身不搬——由專案設定指定誰提供（工具自帶／專案自建），套件只搬兩樣通用的小工具：
// 這一支（掃前試探）與 tools/scan-postmortem.js（掃後比對）。沒有隔離、或試探不過＝不掃，掃描紀錄寫「未執行」。
//
// 它做什麼：在每個登記的禁區各埋一個假機密，從盒內用「確定會嘗試」的程式（cat、sh）去讀、去寫。
// 任一個讀得到或寫得進＝隔離是假的，不掃（退 1）。連試探自己都做不成＝也不掃（退 2）。
// 為什麼隔離是誰提供的都要試探：套件倉庫的案例簿 tool-lock-flag-silently-failed——工具自己的限制旗標默默失效，
// 「廠商說有」不等於「真的有」；而掃描器讀的材料是不可信的輸入，模型再乖也擋不住材料裡夾帶的指令。
// 用 cat／sh 而不用掃描器本身去試：掃描器會「選擇」不做，那不是圍欄。
//
// 守得到的與守不到的，照實說：
//   守得到：它埋的那幾個位置，用**這一支自己用的那兩個機制**（讀＝/bin/cat、寫＝/bin/sh 重導向）從盒內
//           讀不到、寫不進；而且兩個機制都先在盒內證明是活的（讀得到、寫得進盒子自己）——
//           「什麼都失敗」不算擋住；盒外也讀得到假機密（試探程式本身是活的）。
//   守不到：**別的寫入機制**。這一支用得起 /bin/sh 才判得動；盒內擋掉 shell、但別的程式（例如掃描器
//           自己就是 node）寫得出去的隔離，這一支測不到——它會照實說測不出，不會說擋住。
//           （2026-09-13 稽核用真沙盒實測：deny 掉 /bin/sh 之後，一個真的寫入洞原本會被判成「擋住、可以掃」。）
//           也守不到隔離有沒有別的洞（網路、剪貼簿、環境變數、沒登記的目錄）——那些由隔離提供者自己證明；
//           以及掃描發射本身有沒有把呼叫者的環境變數帶進盒子（這一支自己只帶最少的環境變數）。
//
// 退出碼：0＝全部擋住、可以掃／1＝有禁區碰得到，隔離是假的，不掃／2＝試探做不成（沒有隔離、設定沒填、
//        假機密埋不進去、對照組不活、盒內連自己的檔都讀不到或寫不進、有探針測不出），同樣不掃。
//
// ## 另外兩個動作：埋與收（--plant／--sweep）
//
// 掃後比對要比的是「掃描**期間**放在真禁區、每掃現生」的假機密。試探自己埋的那些在試探結束就刪光、
// 值也從不輸出（刻意的），所以接不到掃描那一段。--plant 埋一批新的並把值寫進一個清單檔給比對用，
// --sweep 收掉。整條鏈：試探（退 0 才往下走）→ 埋 → 掃 → 比對 → 收。
// ⚠️ 清單檔裡就是那些值，不要貼進掃描紀錄；收的那一步一定要跑。
//
// ## 指令入口只在專案把這台機器登記「已啟用」時才動手
//
// 試探與埋都會照設定的**真實**禁區放假機密。專案把套件搬進來、還沒決定用它的時候，有人照 MACHINES.md
// 的「已就位」去跑（那一欄描述的是套件倉庫），就會在真家目錄埋東西（搬家第 2 步 Grok 複審後掃第 1 條）。
// 所以指令入口先看設定機器表裡這一列：沒有、不是剛好一列、或登記不是「已啟用」＝拒絕、什麼都不做（退 2）。
// 收（--sweep）不擋：它只刪清單檔上記的那些，擋了反而收不回來。考題直接呼叫 probeRun／plantCanaries 並自帶設定，不經過這一道。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { read: readSettings } = require('./build-settings.js');

const UNSET = '未設定';
/** 這支在專案機器表裡的那一列（名字跟 settings.json 一字不差）。 */
const MACHINE = '掃描前試探（禁區各埋一個假機密，從盒內試讀試寫；隔離本身由專案設定指定誰提供）';

/** 專案沒把這台機器登記已啟用＝回原因；已啟用＝null。 */
function notEnabled(settings) {
  const rows = settings && Array.isArray(settings.machines) ? settings.machines.filter((m) => m && m.name === MACHINE) : [];
  if (rows.length !== 1) return `設定的機器表裡「掃描前試探」要剛好一列（現在 ${rows.length} 列）`;
  if (rows[0].state !== '已啟用') return `這個專案把「掃描前試探」登記成「${rows[0].state}」：還沒啟用就不跑（它會照設定的真實禁區埋假機密）`;
  return null;
}
const NONE = '無';
const READER = '/bin/cat';
const SHELL = '/bin/sh';

/** 預設的執行器：真的去跑。status 為 null＝逾時、被訊號殺掉、或根本起不來。 */
function runCommand(argv, { cwd, env, timeout = 20_000 } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', cwd, env, timeout });
  return {
    status: r.error ? null : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? r.error.message : (r.signal || ''),
  };
}

/** 盒內只給最少的環境變數：不把呼叫者的 token、家目錄帶進去。 */
function minimalEnv(box) {
  return { PATH: process.env.PATH || '/usr/bin:/bin', HOME: box, TMPDIR: path.join(box, 'tmp'), LANG: 'C' };
}

/** 禁區清單裡的 ~ 代表家目錄。 */
function expandZone(zone, home) {
  if (zone === '~') return home;
  if (zone.startsWith('~/')) return path.join(home, zone.slice(2));
  return zone;
}

/**
 * 禁區展開之後一律要是絕對路徑：相對路徑會照「當下在哪個目錄執行」變成不同的地方，埋下去的東西之後也收不回來
 * （personal-finance-webapp #606 r1）。回第一個不合格的原字串；都合格回 null。在任何寫入之前檢查。
 */
function relativeZone(zones, home) {
  return zones.find((zone) => !path.isAbsolute(expandZone(zone, home))) || null;
}

/**
 * 「這一次讀取算不算擋住」——唯一的判斷。擋住＝退出碼是非 0 的數字，且輸出裡沒有假機密。
 * status 為 null 不算擋住，那是探針自己壞了（呼叫端另計成「測不出」）。
 */
function isBlocked(r, secret) {
  const leaked = r.stdout.includes(secret) || r.stderr.includes(secret);
  return typeof r.status === 'number' && r.status !== 0 && !leaked;
}

/**
 * 跑完整試探。回傳 { code, lines }；settings／run／home／tmp 都可以換掉，考題不必碰真的家目錄。
 * lines 裡不會出現假機密本身。
 */
function probeRun({ settings = readSettings(), run = runCommand, home = os.homedir(), tmp = os.tmpdir(), projectRoot = path.join(__dirname, '..') } = {}) {
  const lines = [];
  const say = (text) => lines.push(text);
  const iso = settings.scanner && settings.scanner.isolation;
  const provider = iso && typeof iso.provider === 'string' ? iso.provider : UNSET;
  if (provider === UNSET || provider === NONE) {
    say(`隔離提供者是「${provider}」：沒有隔離＝不掃，掃描紀錄寫「未執行：無隔離」。`);
    return { code: 2, lines };
  }
  const wrap = Array.isArray(iso.wrap) ? iso.wrap.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!wrap.length) {
    say('從盒內跑指令的前綴沒填：不知道怎麼從盒內跑東西＝試探不了，不掃。');
    return { code: 2, lines };
  }
  const zones = Array.isArray(iso.forbidden) ? iso.forbidden.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!zones.length) {
    say('禁區清單是空的：什麼都沒試就說隔離有效，比沒有試探更危險，不掃。');
    return { code: 2, lines };
  }
  const rel = relativeZone(zones, home);
  if (rel) {
    say(`禁區「${rel}」不是絕對路徑（也不是 ~ 開頭）：會隨執行位置變成別的地方，試探不了，不掃。`);
    return { code: 2, lines };
  }

  const secret = `PROBE-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
  const boxRoot = iso.boxRoot && iso.boxRoot !== UNSET ? expandZone(iso.boxRoot, home) : tmp;
  let box = null;
  const planted = [];
  try {
    try {
      box = fs.realpathSync(fs.mkdtempSync(path.join(boxRoot, 'scan-probe-box-')));
      fs.mkdirSync(path.join(box, 'tmp'));
    } catch (e) {
      // 只印設定裡的原字串與錯誤代碼：展開後的路徑含使用者帳號名，而這幾行會被貼進掃描紀錄
      say(`盒子建不起來（設定的位置「${iso.boxRoot || '未設定'}」：${e.code || '建立失敗'}）：試探不了，不掃。`);
      return { code: 2, lines };
    }
    const env = minimalEnv(box);
    // {projectRoot}＝專案根目錄（這支工具所在的 tools/ 的上一層；搬家前準備）：隔離設定檔若住在專案裡，設定寫相對位置就好——
    // 試探與實際掃描用的是同一份檔，設定裡也不必寫出含帳號名與資料夾名的完整路徑
    const inBox = (argv) => run([...wrap.map((w) => w.split('{box}').join(box).split('{projectRoot}').join(projectRoot)), ...argv], { cwd: box, env });
    const outside = (argv) => run(argv, { cwd: box, env });

    for (const zone of zones) {
      const dir = expandZone(zone, home);
      let plantedDir;
      try {
        plantedDir = fs.mkdtempSync(path.join(dir, '.scan-probe-'));
      } catch (e) {
        say(`禁區「${zone}」埋不進假機密（${e.code || e.message}）：試探不了，不掃。`);
        return { code: 2, lines };
      }
      const file = path.join(plantedDir, 'fake-secret.txt');
      fs.writeFileSync(file, `${secret}\n`);
      planted.push({ zone, dir: plantedDir, file, writeTarget: path.join(plantedDir, 'written-from-inside.txt') });
    }

    // 對照組：盒外讀得到——證明試探程式自己是活的；盒外就讀不到＝什麼都證明不了
    for (const p of planted) {
      const r = outside([READER, p.file]);
      if (r.status !== 0 || !r.stdout.includes(secret)) {
        say(`⛔ 對照組不活｜盒外讀不到「${p.zone}」裡的假機密（status ${r.status}）：試探程式自己壞了，測不出，不掃。`);
        return { code: 2, lines };
      }
    }
    // 正面控制：**讀與寫各一道**，而且要在判任何「擋住」之前跑。
    // 「什麼都失敗」不算擋住——那是隔離沒套上、或這一支用的機制在盒內根本起不來。
    // ⚠️ 寫那一道是 2026-09-13 稽核補的：原本只有讀有正面控制，於是盒內起不了 /bin/sh 時，
    //    寫探針的非零退出碼會被當成「擋住」，一個真的寫入洞就被判成可以掃（用真沙盒實測過）。
    const insideFile = path.join(box, 'inside.txt');
    fs.writeFileSync(insideFile, 'INSIDE-OK\n');
    {
      const r = inBox([READER, insideFile]);
      if (r.status !== 0 || !r.stdout.includes('INSIDE-OK')) {
        say(`⛔ 盒內連自己的檔都讀不到（status ${r.status}${r.error ? `：${r.error}` : ''}）：隔離沒套上或整個壞掉，不掃。`);
        return { code: 2, lines };
      }
      say('✅ 盒內讀得到自己的檔（讀的機制是活的）');
    }
    {
      const target = path.join(box, 'inside-write.txt');
      const r = inBox([SHELL, '-c', 'echo WRITE-OK > "$1"', 'scan-probe', target]);
      const landed = fs.existsSync(target);
      if (r.status !== 0 || !landed) {
        say(`⛔ 盒內連自己的檔都寫不進（status ${r.status}${landed ? '' : '、檔案沒落地'}${r.error ? `：${r.error}` : ''}）：`
          + '這一支用的寫入機制在盒內起不來，那就量不出禁區寫不寫得進——測不出，不掃。');
        say('（這不是「隔離很嚴」的證據：擋掉這一支用的程式，不等於擋掉掃描器自己會用的寫法。）');
        return { code: 2, lines };
      }
      say('✅ 盒內寫得進自己的檔（寫的機制是活的）');
    }

    let dead = 0;
    let unknown = 0;
    for (const p of planted) {
      const r = inBox([READER, p.file]);
      if (r.status === null) { unknown += 1; say(`⛔ 測不出｜讀「${p.zone}」（逾時或被殺${r.error ? `：${r.error}` : ''}）`); }
      else if (isBlocked(r, secret)) say(`🔴 擋住｜讀「${p.zone}」`);
      else { dead += 1; say(`🟢 讀得到（隔離是假的）｜讀「${p.zone}」`); }

      // 寫：退出碼會說謊，所以另外從盒外看檔案有沒有真的落地
      const w = inBox([SHELL, '-c', 'echo x > "$1"', 'scan-probe', p.writeTarget]);
      const landed = fs.existsSync(p.writeTarget);
      if (landed) { dead += 1; say(`🟢 寫得進（隔離是假的）｜寫「${p.zone}」，檔案真的落地了`); }
      else if (w.status === null) { unknown += 1; say(`⛔ 測不出｜寫「${p.zone}」（逾時或被殺）`); }
      else if (w.status === 0) { unknown += 1; say(`⛔ 測不出｜寫「${p.zone}」回報成功但檔案沒落地：隔離的行為看不懂，不當作擋住`); }
      // 判「擋住」的資格來自上面那道寫入正面控制：同一個機制在盒內寫得進、在禁區寫不進，才是隔離在擋。
      else say(`🔴 擋住｜寫「${p.zone}」（用的是這一支的寫法；別的寫法沒測）`);
    }
    if (dead) {
      say(`試探：${dead} 個探針碰得到禁區＝隔離是假的，不掃；照規矩 G2 通報裁示者。`);
      return { code: 1, lines, dead, unknown };
    }
    if (unknown) {
      say(`試探：${unknown} 個探針測不出＝不能說隔離有效，不掃。`);
      return { code: 2, lines, dead, unknown };
    }
    say(`試探：${planted.length} 個禁區用這一支的讀寫機制都碰不到，而同樣的機制在盒內是活的——可以掃。`);
    return { code: 0, lines, dead, unknown };
  } finally {
    // 不管哪條路出去，埋的東西與盒子都清掉；只刪自己建的目錄
    for (const p of planted) fs.rmSync(p.dir, { recursive: true, force: true });
    if (box) fs.rmSync(box, { recursive: true, force: true });
  }
}

// ── 掃描期間的假機密（埋／收）──────────────────────────────────────────────
// 為什麼要有這兩支：掃後比對（tools/scan-postmortem.js）要比的是「掃描**期間**放在真禁區、
// 而且每掃現生」的值——那種值不可能出現在給盒子的材料裡，所以它出現在輸出中就是鐵證。
// 但試探那一支埋的假機密在試探結束就刪光、值也從不輸出（刻意的），掃描開始時它已經不存在。
// 2026-09-13 稽核抓到：檔頭與專案設定把這條鏈寫得像已經有人在供應，實際上接不起來。
// 所以補這兩支，讓那條鏈是真的：試探（不掃就停）→ 埋 → 掃 → 比對 → 收。
//
// ⚠️ 埋下去的值會落在磁碟上（禁區裡）並寫進一個清單檔。清單檔只給比對用，**不要貼進任何紀錄**；
//    收的那一步一定要跑，否則假機密會一直留在禁區裡。
const MANIFEST_SUFFIX = '.planted';

/** 在每個登記的禁區各埋一個「掃描期間」的假機密；值寫進 outFile，埋在哪寫進同名的清單檔。 */
function plantCanaries({ settings = readSettings(), home = os.homedir(), outFile } = {}) {
  const lines = [];
  const iso = (settings.scanner && settings.scanner.isolation) || {};
  const zones = Array.isArray(iso.forbidden) ? iso.forbidden.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!outFile) return { code: 2, lines: ['沒給清單檔的位置：不知道要把值寫到哪裡給比對用。'] };
  if (!zones.length) return { code: 2, lines: ['禁區清單是空的：沒有地方可埋，掃後比對就沒有鐵證可比。'] };
  const rel = relativeZone(zones, home);
  if (rel) return { code: 2, lines: [`禁區「${rel}」不是絕對路徑（也不是 ~ 開頭）：埋下去之後會收不回來，不埋。`] };
  const planted = [];
  const secrets = [];
  try {
    for (const zone of zones) {
      // 記下真正的位置（解開連結、別名之後的絕對路徑）：收的時候只認跟這個一字不差的路徑
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(expandZone(zone, home), '.scan-canary-')));
      const secret = `LIVE-CANARY-${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`;
      const file = path.join(dir, 'canary.txt');
      fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
      planted.push(dir);
      secrets.push(secret);
    }
  } catch (e) {
    for (const dir of planted) fs.rmSync(dir, { recursive: true, force: true });
    return { code: 2, lines: [`埋不進去（${e.code || '寫入失敗'}）：沒有鐵證就不要開始掃。`] };
  }
  fs.writeFileSync(outFile, `${secrets.join('\n')}\n`, { mode: 0o600 });
  fs.writeFileSync(`${outFile}${MANIFEST_SUFFIX}`, `${planted.join('\n')}\n`, { mode: 0o600 });
  lines.push(`埋好 ${secrets.length} 個掃描期間的假機密（每個禁區各一個）。`);
  lines.push('掃完之後：先跑 node tools/scan-postmortem.js --secrets <這個清單檔> …，再跑 --sweep 收掉。');
  lines.push('⚠️ 清單檔本身不要貼進掃描紀錄。');
  return { code: 0, lines, secrets, planted };
}

/** 收掉埋下去的假機密。清單檔不見＝不知道埋在哪，照實說（退 2），不要亂刪。 */
function sweepCanaries({ outFile } = {}) {
  if (!outFile) return { code: 2, lines: ['沒給清單檔的位置：不知道要收哪些。'] };
  const manifest = `${outFile}${MANIFEST_SUFFIX}`;
  let dirs;
  try { dirs = fs.readFileSync(manifest, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean); }
  catch (e) { return { code: 2, lines: [`收不掉：清單檔讀不到（${e.code || '讀取失敗'}）——埋在哪不知道，請自己去禁區找 .scan-canary-* 目錄。`] }; }
  let failed = 0;
  for (const dir of dirs) {
    // 只刪「就是埋的時候記下的那種路徑」：清單上的字串必須跟它真正的位置一字不差（絕對路徑、沒有尾端斜線、
    // 任何一段都不是連結——埋的時候記的就是解開後的真實位置），名字以 .scan-canary- 開頭，而且真的是目錄。
    // 不是一條條列舉「相對路徑、尾端斜線、連結」各擋一次（那樣補不完；#606 r1 的尾端斜線就是例子），而是量「它是不是自己的真實位置」這一件事。
    // 清單檔被改過或寫錯時，別的東西一律不碰、算收不掉。⚠️ 這仍證明不了「確實是這一次埋的」，也擋不住檢查與刪除之間被換掉。
    // （這個動作在機器未啟用時也跑，安全只能靠這一道。）
    if (!path.basename(dir).startsWith('.scan-canary-')) { failed += 1; continue; }
    let real;
    try { real = fs.realpathSync(dir); } catch (e) { if (e.code !== 'ENOENT') failed += 1; continue; }   // 已經不在＝不必收
    if (real !== dir || !fs.lstatSync(dir).isDirectory()) { failed += 1; continue; }
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch { failed += 1; }
  }
  fs.rmSync(outFile, { force: true });   // 值檔一律刪（比對已經做完）
  // 有收不掉的就留下位置清單（只有路徑、沒有值）給人對照或修好後重試；全部收掉才刪
  if (failed) return { code: 2, lines: [`有 ${failed} 個假機密收不掉：位置清單留著（${path.basename(manifest)}），請對照清單自己去禁區找 .scan-canary-* 目錄刪掉。`] };
  fs.rmSync(manifest, { force: true });
  return { code: 0, lines: [`收掉 ${dirs.length} 個假機密，清單檔也刪了。`] };
}

/**
 * 指令入口的本體，抽出來讓考題直接考（原本整段寫在 require.main 裡＝零覆蓋，2026-09-13 稽核抓到）。
 * 任何沒想到的例外都收成退 2：試探做不成就是不掃，不可以讓例外把未遮蔽的路徑丟進 stderr。
 */
function cli(opts = {}, argv = []) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    const sweep = arg('--sweep');
    if (sweep) return sweepCanaries({ ...opts, outFile: sweep });   // 收不擋：只刪清單上跟自己真實位置一字不差、名字 .scan-canary- 開頭、真的是目錄的
    const settings = opts.settings || readSettings();
    const off = notEnabled(settings);
    if (off) return { code: 2, lines: [`${off}。要用它，先在 settings.json 把那一列改成已啟用、重產設定說明，再跑。`] };
    const plant = arg('--plant');
    if (plant) return plantCanaries({ ...opts, settings, outFile: plant });
    return probeRun({ ...opts, settings });
  } catch (e) {
    return { code: 2, lines: [`試探做不成（${(e && e.code) || '未預期的錯誤'}）：不掃。`] };
  }
}

if (require.main === module) {
  const { code, lines } = cli({}, process.argv.slice(2));
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(code);
}

module.exports = { MACHINE, notEnabled, cli, probeRun, plantCanaries, sweepCanaries, runCommand, isBlocked, expandZone, minimalEnv, MANIFEST_SUFFIX, UNSET, NONE };
