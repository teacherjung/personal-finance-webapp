#!/usr/bin/env node
// 合併指令：依序跑完登記的每一道閘，任一道紅就停，全綠才按合併鍵。
//
// 裁示者 2026-09-12 裁「丙′」：閘照舊在本機跑，但包成這一支指令。理由（實作者的操作化）：
// 這幾道閘問的是「合併那一刻」的狀態——有沒有未撤銷的阻擋、有沒有別支疊在上面、其他開著的
// 變更合起來會不會撞、必要檢查是不是真的跑過。推送時跑出來的結果到合併那一刻已經過期，
// 所以「推上去就自動跑」不是同一件事；要做對得上平台的合併佇列，那是另一件工程。
//
// 這支指令擋得住什麼、擋不住什麼，照實說：
//   擋得住：忘了跑其中一道、跑了沒看退出碼、紅了還往下走；跑閘途中被推了新版本（開跑前記下版本、按鍵前再核一次，
//     合併指令帶 {sha} 時平台也會替你擋最後一刻的新版本——搬家驗屋 09-13 補的）。
//   合併紀錄寫得出誰審、誰合：合併指令認 {reviewer}（說明的「獨立審查者」欄）與 {merger}（--merger 自報）。
//   擋不住：**不用這支指令、直接按平台的合併鍵**。要擋那個只有平台級的分支保護。
//     {merger} 是自報的：驗得到「是登記過的參與者」，驗不到「真的是他」。版本只比頭尾兩次，途中推了新版又推回原版看不出來。
//
// ⚠️ 沒有任何一道閘登記成「已啟用」時，這支指令**不放行**（退出碼 2）。
//    一支什麼都沒檢查就按下合併鍵的指令，比沒有這支指令更危險。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { read: readSettings } = require('./build-settings.js');
const { gitEnv } = require('./git-env.js');
const { ask, PlatformError } = require('./platform.js');
const { fieldValue, canonicalRole, rolesOf } = require('./gates/check-collab-fields.js');

const UNSET = '未設定';
const ENABLED = '已啟用';
/** 合併指令認得的記號。其餘任何 {小寫字} 留在指令裡＝不放行（原樣送出去的記號，平台會當成字面文字）。 */
const TOKENS = ['change', 'sha', 'project', 'reviewer', 'merger'];

/**
 * 預設的執行器：真的去跑那道閘。回傳退出碼與輸出，方便考題換掉。
 * ⚠️ 閘**起不來**（找不到指令、沒有執行權）與**被訊號殺掉／逾時**都回 2，不是 0——
 *    「跑不起來」不等於「檢查過了」。這兩條路 2026-09-13 稽核前零覆蓋：改成回 0，
 *    一道根本不存在的閘會被當成綠燈，一路按下合併鍵（端到端重現過）。
 */
function runCommand(command, args, { clearEnv = [] } = {}) {
  // node 本身在、閘的檔案不在：node 會退 1，跟「閘判定擋下」同一個碼（搬家修正 r1 B3）。跑之前先看檔在不在。
  // ⚠️ 只擋得住「檔案不在或讀不到」；檔在、但載入就崩（語法錯、相依缺）node 一樣退 1，這裡分不出來。
  if (path.basename(command) === 'node' && typeof args[0] === 'string' && /\.c?js$/u.test(args[0])) {
    try { fs.accessSync(path.resolve(args[0]), fs.constants.R_OK); }
    catch { return { code: 2, output: `閘的檔案不在或讀不到：${args[0]}（在 ${process.cwd()} 底下找的；合併指令要在專案根目錄跑）` }; }
  }
  // 環境先清 GIT_ 那一族（規矩 E4；r1 High①）：閘會叫 git，繼承來的 GIT_DIR 會讓它們查到別棵倉庫
  // 按合併鍵那一步另外清掉專案登記的選倉環境變數（platform.clearEnv；搬家前準備）：
  // 平台動作問資料時本來就清，合併指令原本沒清——環境裡一個選站台的變數就能把合併導到別的站
  const env = gitEnv();
  for (const key of clearEnv) delete env[key];
  const result = spawnSync(command, args, { encoding: 'utf8', env });
  if (result.error) return { code: 2, output: String(result.error.message) };
  return { code: result.status === null ? 2 : result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

/** 讀這支變更現在的版本與說明；問不到回 null（呼叫端當查不清楚）。 */
function readChange(changeId, settings, platform) {
  try {
    const c = platform.ask('change', { change: String(changeId) }, { settings });
    return c && typeof c.headSha === 'string' && c.headSha ? c : null;
  } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) return null;
    throw e;
  }
}

/**
 * 跑完流程。回傳 { code, lines }；code 0＝已合併，1＝有閘擋下，2＝連判斷都做不到（fail-closed）。
 * settings／run／platform 都可以換掉，考題就不必真的去動平台。
 * merger＝這一趟按合併鍵的那一方自報的識別值（合併指令用了 {merger} 才必填）。
 */
function mergeRun(changeId, { settings = readSettings(), run = runCommand, platform = { ask }, merger } = {}) {
  const lines = [];
  const say = (text) => lines.push(text);

  if (!changeId) {
    say('用法：node tools/merge.js <變更編號> [--merger <按合併鍵那一方的識別值>]');
    return { code: 2, lines };
  }
  if (!settings.mainBranch || settings.mainBranch === UNSET) {
    say(`專案設定裡的主幹分支名還是「${UNSET}」：不知道要合併到哪裡，不放行。`);
    return { code: 2, lines };
  }
  const gates = Array.isArray(settings.gates) ? settings.gates : [];
  const enabled = gates.filter((gate) => gate.state === ENABLED);
  if (enabled.length === 0) {
    say(`專案設定裡沒有任何一道閘登記成「${ENABLED}」：一支什麼都沒檢查就按合併鍵的指令比沒有更危險，不放行。`);
    say('要嘛把閘搬進來並登記啟用，要嘛照規矩本文 H1 用人工逐道跑完再自己按鍵。');
    return { code: 2, lines };
  }

  // 合併指令裡用到的記號，跑閘之前先驗得了的先驗（別讓人跑完好幾分鐘的閘，才發現少給一個名字）
  const merge = settings.mergeCommand;
  const mergeArgs = merge && Array.isArray(merge.args) ? merge.args.map(String) : [];
  const used = new Set(mergeArgs.flatMap((a) => [...a.matchAll(/\{([a-z]+)\}/gu)].map((m) => m[1])));
  if (merge && merge.command && merge.command !== UNSET && !used.has('change')) {
    say('合併指令裡沒有 {change}：它不知道要合哪一支（有些平台工具不給編號時會去合「目前分支」那一支），不放行。');
    return { code: 2, lines };
  }
  const unknown = [...used].filter((t) => !TOKENS.includes(t));
  if (unknown.length) {
    say(`合併指令裡有認不得的記號：${unknown.map((t) => `{${t}}`).join('、')}（認得的只有 ${TOKENS.map((t) => `{${t}}`).join('、')}）——原樣送出去就是字面文字，不放行。`);
    return { code: 2, lines };
  }
  const { usable } = rolesOf(settings);
  let mergerId = null;
  if (used.has('merger')) {
    mergerId = canonicalRole(merger, usable);
    if (!mergerId) {
      say(`合併指令要寫「誰合」（{merger}），但這一趟${merger ? `報的「${merger}」不是登記過的參與者（${usable.join('／') || '一個都沒登記'}）` : '沒有用 --merger 報名字'}：不放行。`);
      return { code: 2, lines };
    }
  }
  const project = settings.platform && settings.platform.project;
  if (used.has('project') && (typeof project !== 'string' || !project.trim() || project === UNSET)) {
    say('合併指令用了 {project}，但專案設定的 platform.project 還沒填：不知道要合進哪個倉庫，不放行。');
    return { code: 2, lines };
  }
  if (!used.has('reviewer') || !used.has('merger')) {
    say('⚠️ 合併指令沒有帶 {reviewer}／{merger}：合併紀錄會留不下誰審、誰合（規矩 H5）。');
  }
  if (!used.has('sha')) {
    say('⚠️ 合併指令沒有帶 {sha}：按鍵前會再核一次版本，但核完到平台真的合併之間若又被推了新版本，平台不會替你擋。');
  }

  const notEnabled = gates.filter((gate) => gate.state !== ENABLED);
  if (notEnabled.length) {
    say(`⚠️ 這幾道閘還沒啟用、這一趟不會跑：${notEnabled.map((g) => g.name).join('、')}`);
  }

  // 先記下「這一趟驗的是哪一版」：跑閘途中有人推了新版本，後面的閘看到的就不是前面那幾道驗過的那一版
  const before = readChange(changeId, settings, platform);
  if (!before) {
    say(`問不到變更 ${changeId} 現在是哪一版：連要驗哪一版都不知道，不放行。`);
    return { code: 2, lines };
  }
  say(`要合併的變更：${changeId}（版本 ${before.headSha.slice(0, 12)}）；主幹：${settings.mainBranch}；要跑 ${enabled.length} 道閘。`);
  for (const [index, gate] of enabled.entries()) {
    const argv = [...gate.args, String(changeId)];
    const { code, output } = run(gate.command, argv);
    say(`第 ${index + 1} 道｜${gate.name}｜退出碼 ${code}`);
    if (code !== 0) {
      const tail = output.trim().split('\n').slice(-5).join('\n');
      if (tail) say(tail);
      if (code === 1) {
        say('這一道擋下來了，停在這裡、沒有按合併鍵。先問「紅的是哪一題」，不要跳過。');
        return { code: 1, lines };
      }
      // 閘的約定：1＝擋下、2＝查不清楚；其餘非零（含起不來）一律當查不清楚——沒有「紅的那一題」可以找
      say('這一道查不清楚或根本起不來（不是判定擋下），停在這裡、沒有按合併鍵。先看上面那幾行它為什麼判不了。');
      return { code: 2, lines };
    }
  }

  if (!merge || !merge.command || merge.command === UNSET) {
    say(`每一道閘都綠了，但專案設定裡沒有登記合併指令（mergeCommand）：不自己猜平台怎麼合，停在這裡。`);
    return { code: 2, lines };
  }
  // 按鍵前再核一次版本（搬家驗屋 09-13：原本五道閘各自重讀、彼此不比對，按鍵前也不讀，推上來的新版本照樣被合併）
  const after = readChange(changeId, settings, platform);
  if (!after) {
    say(`閘都綠了，但按鍵前問不到變更 ${changeId} 現在是哪一版：核不了就不按。`);
    return { code: 2, lines };
  }
  if (after.headSha !== before.headSha) {
    say(`跑閘途中版本變了：開始時是 ${before.headSha.slice(0, 12)}、現在是 ${after.headSha.slice(0, 12)}。新版本沒有被這一趟驗過，沒有按合併鍵；整條從頭重跑。`);
    return { code: 2, lines };
  }
  const values = { change: String(changeId), sha: after.headSha, project, merger: mergerId };
  if (used.has('reviewer')) {
    values.reviewer = canonicalRole(fieldValue(after.body, '獨立審查者'), usable);
    if (!values.reviewer) {
      say('合併指令要寫「誰審」（{reviewer}），但變更說明的「獨立審查者」欄讀不出一位登記過的參與者：不放行。');
      return { code: 2, lines };
    }
  }
  const argv = mergeArgs.map((arg) => arg.replace(/\{([a-z]+)\}/gu, (_, t) => values[t]));
  const clearEnv = Array.isArray((settings.platform || {}).clearEnv) ? settings.platform.clearEnv.filter((k) => typeof k === 'string' && k) : [];
  const { code, output } = run(merge.command, argv, { clearEnv });
  const tail = output.trim().split('\n').slice(-5).join('\n');
  if (tail) say(tail);
  if (code !== 0) {
    say(`合併指令回了非零（${code}）：先去查那支變更現在的狀態再決定，不要重跑。`);
    return { code: 1, lines };
  }
  // 量詞只能蓋到這一趟真的跑過的那幾道——登記了但沒啟用的閘沒跑，不可以被這句話蓋進去
  // （2026-09-13 稽核抓到原本寫「每一道閘都綠」）。
  const skipped = gates.length - enabled.length;
  say(`這一趟要跑的 ${enabled.length} 道閘都綠、合併已執行${skipped ? `（另有 ${skipped} 道登記了但沒啟用，這一趟沒跑）` : ''}。`
    + '接著照規矩本文 H6 跑分級腳本、照它印的做驗收。');
  return { code: 0, lines };
}

/** 指令列：<變更編號> [--merger <識別值>]。 */
function parseArgs(argv) {
  const out = { changeId: undefined, merger: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--merger') { out.merger = argv[i + 1]; i += 1; }
    else if (out.changeId === undefined) out.changeId = argv[i];
  }
  return out;
}

if (require.main === module) {
  const { changeId, merger } = parseArgs(process.argv.slice(2));
  let result;
  try { result = mergeRun(changeId, { merger }); }
  catch (e) { result = { code: 2, lines: [`合併指令：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——沒有按合併鍵。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { mergeRun, runCommand, parseArgs, UNSET, ENABLED, TOKENS };
