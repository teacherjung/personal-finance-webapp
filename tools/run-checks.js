#!/usr/bin/env node
// 三關執行器（規矩 E2、E3）：照專案設定登記的順序跑三關，任一非零就停。推送前鉤子與雲端範本都呼叫它。
//
// 為什麼要有一支：鉤子（sh）與雲端（yml）各自寫一遍三關，兩份就會漂。三關命令的正本只有一份（settings.json
// 的 checks.commands），這支讀它、兩邊都呼叫這支。
//
// 兩件事夾在三關前後（原專案的裸倉庫事故）：跑之前與跑完之後各驗一次「這棵樹還是不是工作樹、根目錄是不是這裡、索引在不在」，
// 外加「倉庫設定前後內容有沒有不同」（比對設定檔的位元組）——考題各跑各的子行程、順序不保證，某一題把倉庫寫壞
// 這件事只有跑完再驗一次才抓得到；而寫壞共用設定時從這棵樹看生效值可能照樣健康，所以直接比「前後內容有沒有不同」。
// 所有外部指令的環境先清掉 GIT_ 那一族（規矩 E4）。
//
// 退出碼：0＝全綠／1＝有一關紅（或跑完樹壞了）／2＝三關沒登記、不在工作樹裡、指令起不來。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { read: readSettings } = require('./settings-data.js');
const { gitEnv } = require('./git-env.js');

const UNSET = '未設定';

function runCommand(argv, cwd) {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
  return { status: r.error ? null : r.status, error: r.error ? r.error.message : '' };
}

/**
 * 這棵樹還是工作樹嗎？回 'ok'／'bare'／'not-a-repo'／'wrong-tree'／'index-unusable'。
 * wrong-tree＝版本控制認的工作樹根目錄不是這裡：樹被指到別處（例如設定裡的 core.worktree），或不在專案根目錄跑。
 * 搬家驗屋 09-13：原本只查裸倉庫；樹被指到別處時照樣回報三關全綠，而依賴版本控制的考題量的是另一棵樹。
 * index-unusable＝倉庫有提交，這棵樹自己的**索引檔卻不存在**，或 git 讀不了索引：索引不見時 git ls-files 不報錯、
 *   只回空清單，靠它掃全樹的考題會掃到零個檔然後回報零違規。**索引存在但是空的**（例如暫存刪除了全部檔案）是合法狀態
 *   （搬家前準備 r2 B2）。
 * ⚠️ 這裡只問 Git 對**這棵樹**怎麼判（生效值），不自己解讀設定檔：搬家前準備 r2〜r3 試過直讀共用設定判「別棵樹會不會壞」，
 *   連兩輪都在重做 Git 讀設定的規則（擴充何時生效、include、最後一筆、條件式 include）而且每輪都誤擋正常形狀。
 *   「三關跑的時候有沒有把共用設定寫壞」改由 configFingerprint 前後比對直接量（見 runChecks）。
 */
function treeState(run, cwd) {
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  const bare = git('rev-parse', '--is-bare-repository');
  if (bare.error || bare.status !== 0) return 'not-a-repo';
  if (bare.stdout.trim() !== 'false') return 'bare';
  const top = git('rev-parse', '--show-toplevel');
  if (top.error || top.status !== 0) return 'not-a-repo';
  // 兩邊都解開符號連結再比（暫存目錄常經過一層連結）；根目錄不存在＝被指到不存在的地方
  let here;
  let root;
  try { here = fs.realpathSync(cwd); } catch { return 'not-a-repo'; }
  try { root = fs.realpathSync(top.stdout.trim()); } catch { return 'wrong-tree'; }
  if (root !== here) return 'wrong-tree';
  // 有提交才要求這棵樹自己的索引檔存在、而且 git 讀得了（剛 init、還沒提交的倉庫本來就沒有索引；空索引是合法的）
  if (git('rev-parse', '--verify', '-q', 'HEAD').status === 0) {
    const indexPath = git('rev-parse', '--path-format=absolute', '--git-path', 'index');
    if (indexPath.status !== 0 || !fs.existsSync(indexPath.stdout.trim()) || git('ls-files').status !== 0) return 'index-unusable';
  }
  return 'ok';
}

/**
 * 倉庫設定的指紋：**共用設定檔**與**這棵樹自己的 config.worktree** 的原始位元組（不存在記成 null）。
 * 三關前後各取一次、內容不一樣＝擋（原專案 08-09 事故：考題帶著推送前鉤子的 GIT_DIR
 * 跑 git init，把 bare = true 寫進共用設定——那一刻從這棵樹看生效值可能照樣健康，別的樹卻全部打不開）。
 * 只比前後內容，不判讀內容合不合 Git 的規則（那是 Git 的事，重做它追不上；搬家前準備 r3）。
 * ⚠️ 守不到的：三關開始之前就已經壞掉的共用設定（這棵樹生效值健康時看不出來）；include 引進的其他檔被改；
 *   中途改了又完整還原（前後內容一樣）；只改檔案中繼資料；物件、refs、鉤子等設定以外的損壞（這不是 fsck）；
 *   同一段時間有別的工作階段改了倉庫設定（會紅，訊息照實說去查是誰改的）。
 *   ⚠️ 會改 Git 設定的**合法**準備步（例如安裝鉤子的工具會設 core.hooksPath、初次 submodule／稀疏設定）放進三關裡跑，第一次會紅：
 *   那類準備要在三關之外先做完（搬家前準備 r4 T2）。
 */
function configFingerprint(cwd) {
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  const common = git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const perTree = git('rev-parse', '--path-format=absolute', '--git-path', 'config.worktree');
  if (common.status !== 0 || perTree.status !== 0) return null;
  const read = (file) => { try { return fs.readFileSync(file).toString('base64'); } catch { return null; } };
  return JSON.stringify({ shared: read(path.join(common.stdout.trim(), 'config')), worktree: read(perTree.stdout.trim()) });
}

function runChecks({ settings = readSettings(), run = runCommand, cwd = process.cwd(), tree = treeState, fingerprint = configFingerprint } = {}) {
  const lines = [];
  const raw = settings.checks && settings.checks.commands;
  if (!Array.isArray(raw) || !raw.length) return { code: 2, lines: ['專案設定裡沒有登記三關指令：什麼都沒跑就放行，比不跑更危險。'] };
  // 逐筆驗、不濾掉（r1 Medium⑪）：登記裡有一條是「未設定」、空陣列或形狀錯，代表有一關還沒接好——
  // 靜靜濾掉等於讓那一關消失。要停用某一關就把它從登記拿掉，不要用壞資料代表停用。
  const badAt = raw.findIndex((x) => !Array.isArray(x) || !x.length || x.some((a) => typeof a !== 'string' || !a) || x[0] === UNSET);
  if (badAt !== -1) return { code: 2, lines: [`三關登記的第 ${badAt + 1} 條是「未設定」、空的或形狀不對：有一關還沒接好，不放行（要停用就從登記拿掉）。`] };
  const cmds = raw;
  const before = tree(run, cwd);
  const BEFORE = {
    bare: '這棵樹在跑三關之前就已經是裸倉庫了：先還原再推。',
    'wrong-tree': '版本控制認的工作樹根目錄不是這裡（樹被指到別處，或不是在專案根目錄跑）：三關量到的會是別棵樹，不放行。',
    'index-unusable': '倉庫有提交，這棵樹的索引檔卻不見了或 git 讀不了：靠它掃全樹的考題會掃到零個檔然後回報零違規，不放行。索引檔不見時用 git read-tree HEAD 重建（索引在但壞了，先備份再處理）。',
  };
  if (before !== 'ok') return { code: 2, lines: [BEFORE[before] || '這裡不是版本控制的工作樹。'] };
  const printBefore = fingerprint(cwd);
  for (const [i, cmd] of cmds.entries()) {
    lines.push(`第 ${i + 1} 關：${cmd.join(' ')}`);
    const r = run(cmd, cwd);
    if (r.status === null) return { code: 2, lines: [...lines, `第 ${i + 1} 關起不來（${r.error || '沒有退出碼'}）：拿不到判決，不放行。`] };
    if (r.status !== 0) return { code: 1, lines: [...lines, `第 ${i + 1} 關紅了（退出碼 ${r.status}）。修好再推。`] };
  }
  const after = tree(run, cwd);
  const AFTER = {
    'wrong-tree': '三關跑完之後這棵樹被指到別處了（跑之前是好的）：有一題改了倉庫設定，先還原、再查是哪一題。',
    'index-unusable': '三關跑完之後這棵樹的索引檔不見了或讀不了（跑之前是好的）：有一題弄壞了索引，先重建、再查是哪一題。',
  };
  if (after !== 'ok') return { code: 1, lines: [...lines, AFTER[after] || '三關跑完之後這棵樹不是工作樹了（跑之前是好的）：有一題把倉庫弄壞了，先還原、再查是哪一題。'] };
  if (fingerprint(cwd) !== printBefore) {
    return { code: 1, lines: [...lines, '三關跑的過程中，倉庫的共用設定或這棵樹自己的設定被改了：從這棵樹看也許還健康，別的樹（含主目錄）可能已經打不開。先看設定檔改了什麼、還原，再查是哪一題（或是不是同一段時間有別的工作階段在改）。'] };
  }
  return { code: 0, lines: [...lines, `三關全綠（${cmds.length} 關）。`] };
}

if (require.main === module) {
  let result;
  try { result = runChecks(); } catch (e) { result = { code: 2, lines: [`三關執行器：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——不放行。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { runChecks, runCommand, treeState, configFingerprint };
