#!/usr/bin/env node
// 平台介面：閘要問平台的每一個問題，都只透過這一支。
//
// 為什麼需要它（2026-09-13 量出來的）：原專案那七支閘全部直接呼叫 GitHub 的指令列工具，
// 合計三千多行、裡面散著讀變更、列變更、讀留言、讀檢查場次那些呼叫。照搬等於把套件釘死在一個平台上，
// 而這個套件的整個賣點是搬得動。但實際量過，它們只用到平台的**九個動作**——所以不是搬三千行，
// 是定九個問題。（2026-09-14 加第十個 allComments：待裁清單要掃整個專案的留言，題目所屬的變更關了，題目還在——
// 搬家驗屋抓到只掃開著的變更，真語料 12 題裡 4 題會從清單消失。）
//
// ## 分工：套件定問題，專案定怎麼問
//
// 套件定的是「問什麼」與「答案長什麼樣」（下面的 OPERATIONS）。每個專案在 settings.json 的
// platform.operations 底下，替每個問題填一條指令；那條指令要把答案印成**這裡規定的那個形狀的 JSON**。
// 翻譯是專案的事，套件不碰任何平台的語彙。
//
// ⚠️ 這樣切的代價，照實說：翻譯寫錯是專案自己的責任，套件驗不到「答案是不是真的」——
//    它只驗**形狀**（欄位齊不齊、型別對不對、單行非空）。形狀對但內容造假，這裡擋不住。
//    這跟原專案那些閘的處境一樣：它們也只能相信平台回的東西。
//
// ## 一律 fail-closed
//
// 沒登記那個動作、指令跑不起來、被訊號殺掉、退出碼非零、印出來的不是 JSON、形狀不合——
// 全部當「查不到」丟例外，讓呼叫的閘退 2。**絕不回一個空陣列假裝問過了**：
// 空陣列會讓「沒有未撤銷的阻擋」「沒有別支疊在上面」這種判斷靜靜變成通過（規矩 E5）。
'use strict';
const { spawnSync } = require('node:child_process');
const { read: readSettings } = require('./settings-data.js');
const { gitEnv } = require('./git-env.js');

const UNSET = '未設定';
// 會讓一個欄位跑出它該待的位置的字元。⚠️ 這一組必須跟資料契約那一份**完全一樣**；
// 這裡沒有直接引用，是為了不讓平台層去相依案例簿的產生器。
// tests/platform.test.js 有一題拿兩邊逐字元對帳，漂了就紅。
const LINE_BREAK = new RegExp('[\\n\\r\\u0085\\u2028\\u2029\\v\\f]', 'u');

/** 欄位型別：套件只認這幾種，形狀表就只靠它們描述。 */
const LINE = 'line';        // 單行非空字串
const TEXT = 'text';        // 可以多行、可以空（變更說明、留言內文）
const BOOL = 'bool';
const MAYBE = 'maybe-line'; // 單行字串或 null（例如還沒有結論的檢查）

/**
 * 套件會問平台的每一個問題。
 * kind：object＝答案是一個物件；list＝答案是一個陣列；action＝不要答案，只看有沒有做成。
 * params：指令樣板裡可以用的替換記號。
 */
const OPERATIONS = {
  change: {
    kind: 'object',
    params: ['change'],
    what: '讀一支變更的基本資料',
    // changedFileCount：平台自報這支動了幾個檔（數字寫成字串），沒有就 null——驗收分級拿它對帳清單有沒有少給
    shape: { id: LINE, title: LINE, body: TEXT, baseBranch: LINE, headBranch: LINE, headSha: LINE, state: LINE, isDraft: BOOL, isCrossRepo: BOOL, autoMergeOn: BOOL, changedFileCount: MAYBE, author: LINE },
  },
  openChanges: {
    kind: 'list',
    params: [],
    what: '列出目前開著的每一支變更（⚠️ 必須是全部，分頁要在這條指令裡處理完；套件驗不到少給了幾支）',
    shape: { id: LINE, baseBranch: LINE, headBranch: LINE, headSha: LINE, isDraft: BOOL, author: LINE },
  },
  comments: {
    kind: 'list',
    params: ['change'],
    what: '讀一支變更底下的留言（結論、裁示、撤回都靠它）',
    shape: { id: LINE, author: LINE, body: TEXT, createdAt: LINE },
  },
  allComments: {
    kind: 'list',
    params: [],
    what: '讀整個專案的每一則一般留言，各帶它所屬的變更編號（⚠️ 必須是全部、含已關的變更，分頁要在這條指令裡處理完）',
    // change：這則留言掛在哪一支變更底下。待裁清單靠它把「問」與「裁」配起來，不管那一支還開不開著。
    shape: { id: LINE, author: LINE, body: TEXT, createdAt: LINE, change: LINE },
  },
  changedFiles: {
    kind: 'list',
    params: ['change'],
    what: '讀一支變更動了哪些檔',
    // previousPath：改名或複製前的舊路徑，沒有就是 null——分級要連舊路徑一起看
    shape: { path: LINE, status: LINE, previousPath: MAYBE },
  },
  checks: {
    kind: 'list',
    params: ['sha'],
    what: '讀某一顆版本上跑過的檢查場次（⚠️ 必須是全部，分頁要在這條指令裡處理完）',
    // completedAt：完成時間，還沒完成就是 null。用來判「哪一場是最新的」。
    // producer：這一場是誰產生的（平台的應用識別值）。必過檢查釘了產生者時，別人貼的同名成功不算數。
    shape: { name: LINE, status: LINE, conclusion: MAYBE, completedAt: MAYBE, producer: MAYBE },
  },
  requiredChecks: {
    kind: 'list',
    params: ['branch'],
    what: '讀主幹設了哪些必過檢查（名單的正本在平台上，不另抄一份會漂的）',
    // producer：只認這個產生者貼的場次；null＝平台自己允許任何來源（那是平台的選擇，不是閘放寬）。
    shape: { name: LINE, producer: MAYBE },
  },
  branchSha: {
    kind: 'object',
    params: ['branch'],
    what: '讀一個分支現在指到哪一顆',
    shape: { sha: LINE },
  },
  markReady: { kind: 'action', params: ['change'], what: '把一支變更從草稿轉成正式' },
  merge: { kind: 'action', params: ['change'], what: '按下合併鍵' },
};

/**
 * 預設執行器。起不來或被訊號殺掉都回 status null——呼叫端一律當查不到。
 * ⚠️ 環境先清掉 GIT_ 那一族（規矩 E4）：平台工具會自己再去叫 git，繼承來的 GIT_DIR 指到另一棵倉庫時，
 *    問到的是**那一棵**的變更與留言，而輸出看起來完全正常（里程碑 3 r1 High①，PFW 原版早就防過）。
 *    GITHUB_、GH_TOKEN 不是 GIT_ 前綴，不受影響。
 */
function runCommand(command, args, { clearEnv = [] } = {}) {
  // 除了 GIT_ 那一族，專案還可以登記「平台工具自己的選倉環境變數」一起清掉（r2 High①：GH_REPO 一設，
  // 同一條指令就問到別的倉庫，退出碼 0、輸出看起來完全正常）。認證用的變數不在清單上就留著。
  const env = gitEnv();
  for (const key of clearEnv) delete env[key];
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env });
  if (r.error) return { status: null, stdout: '', stderr: String(r.error.message) };
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

class PlatformError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformError';
  }
}

function checkField(value, type, where) {
  if (type === BOOL) {
    if (typeof value !== 'boolean') throw new PlatformError(`${where} 不是是非值（拿到 ${JSON.stringify(value)}）`);
    return;
  }
  if (type === MAYBE && value === null) return;
  if (typeof value !== 'string') throw new PlatformError(`${where} 不是字串（拿到 ${JSON.stringify(value)}）`);
  if (type === TEXT) return;
  if (value.trim() === '') throw new PlatformError(`${where} 是空的`);
  if (LINE_BREAK.test(value)) throw new PlatformError(`${where} 裡有換行：這一格應該是單行的`);
}

/** 驗一個答案的形狀。多出來的欄位一律拒收——多一個欄位通常代表翻譯對錯了問題。 */
function checkShape(value, shape, where) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlatformError(`${where} 不是一個物件`);
  }
  // 用 hasOwn 不用 in：in 會沿原型鏈找，「constructor」「toString」會被當成約定過的欄位（r1 Low⑰）
  for (const [field, type] of Object.entries(shape)) {
    if (!Object.hasOwn(value, field)) throw new PlatformError(`${where} 少了「${field}」這一格`);
    checkField(value[field], type, `${where} 的「${field}」`);
  }
  const extra = Object.keys(value).filter((k) => !Object.hasOwn(shape, k));
  if (extra.length) throw new PlatformError(`${where} 多了沒約定的欄位：${extra.join('、')}`);
}

/**
 * 把指令樣板裡的記號換掉。用不到的參數、沒填的參數都當錯，不默默跑一條半成品的指令。
 * 另有一個全域記號 {project}＝專案設定的 platform.project（例如「擁有者/倉庫名」）：用了它就等於把身分釘死在
 * 指令裡，不再由環境變數決定問哪個倉庫（r2 High①）。樣板用了 {project} 而設定沒填＝丟錯。
 */
function fill(parts, params, args, opName, project) {
  const allowed = new Set(params);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new PlatformError(`動作「${opName}」不吃參數 ${key}`);
  }
  for (const key of params) {
    const v = args[key];
    if (typeof v !== 'string' || v.trim() === '') throw new PlatformError(`動作「${opName}」少了參數 ${key}`);
  }
  const used = new Set();
  const out = parts.map((part) => {
    let s = String(part);
    if (s.includes('{project}')) {
      if (typeof project !== 'string' || !project.trim() || project === UNSET) throw new PlatformError(`動作「${opName}」的指令用了 {project}，但專案設定的 platform.project 還沒填：不知道要問哪個倉庫，不放行`);
      s = s.split('{project}').join(project);
    }
    for (const key of params) {
      const token = `{${key}}`;
      if (s.includes(token)) { used.add(key); s = s.split(token).join(args[key]); }
    }
    return s;
  });
  const missing = params.filter((k) => !used.has(k));
  if (missing.length) {
    throw new PlatformError(`動作「${opName}」登記的指令沒有用到 ${missing.map((k) => `{${k}}`).join('、')}：那條指令問的不是我要問的那一支`);
  }
  return out;
}

/**
 * 問平台一個問題。查不到一律丟 PlatformError（呼叫的閘要讓它變成退 2）。
 * @param {string} opName OPERATIONS 裡的名字
 * @param {object} args 參數（change／sha／branch）
 */
function ask(opName, args = {}, { settings = readSettings(), run = runCommand } = {}) {
  const op = OPERATIONS[opName];
  if (!op) throw new PlatformError(`沒有「${opName}」這個動作`);
  const platform = settings.platform || {};
  const registered = (platform.operations || {})[opName];
  if (!Array.isArray(registered) || registered.length === 0 || registered[0] === UNSET) {
    throw new PlatformError(`專案設定裡沒有登記「${opName}」（${op.what}）：問不到就不放行，不假裝問過了。`);
  }
  const argv = fill(registered, op.params, args, opName, platform.project);
  const clearEnv = Array.isArray(platform.clearEnv) ? platform.clearEnv.filter((k) => typeof k === 'string' && k) : [];
  const { status, stdout, stderr } = run(argv[0], argv.slice(1), { clearEnv });
  if (status === null) throw new PlatformError(`動作「${opName}」的指令起不來或被殺掉：${String(stderr).trim().slice(0, 120)}`);
  if (status !== 0) throw new PlatformError(`動作「${opName}」的指令退了 ${status}：${String(stderr).trim().slice(0, 120)}`);
  if (op.kind === 'action') return null;

  if (op.kind === 'list') {
    const items = parseList(stdout, opName);
    items.forEach((item, i) => checkShape(item, op.shape, `「${opName}」第 ${i + 1} 筆`));
    return items;
  }
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { throw new PlatformError(`動作「${opName}」印出來的不是 JSON：翻譯那一段沒寫對，問不到就不放行`); }
  checkShape(parsed, op.shape, `「${opName}」的答案`);
  return parsed;
}

/**
 * 把清單型動作的輸出讀成一個陣列。**兩種寫法都收**：
 *   ①一整個 JSON 陣列（最單純的情況）；
 *   ②一行一個 JSON 陣列（分頁時很常見）——全部接起來。
 *
 * 為什麼要收第二種（2026-09-13 第一次拿真平台試出來的）：常見的平台工具在分頁時是
 * **每一頁各印一個陣列**，而它把「取值」跟「把各頁併成一個」做成互斥的兩個選項，
 * 於是沒有辦法只用它本身就印出單一 JSON。不收第二種的話，專案就被逼著再裝一個外部工具來合併——
 * 那是把套件的門檻推高，不是把它變嚴。
 *
 * ⚠️ 仍然很嚴：每一行都要是合格的 JSON 陣列，有一行不是就整個當查不到；每一筆還是要過形狀檢查。
 * ⚠️ 照實說：這不能證明**頁數收齊了**。少給幾頁這裡看不出來——那是那條登記指令自己的責任。
 */
function parseList(stdout, opName) {
  const whole = (() => { try { return { ok: true, value: JSON.parse(stdout) }; } catch { return { ok: false }; } })();
  if (whole.ok) {
    if (!Array.isArray(whole.value)) throw new PlatformError(`動作「${opName}」的答案不是一個陣列`);
    return whole.value;
  }
  const lines = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw new PlatformError(`動作「${opName}」什麼都沒印出來：問不到就不放行`);
  const out = [];
  for (const [i, line] of lines.entries()) {
    let page;
    try { page = JSON.parse(line); }
    catch { throw new PlatformError(`動作「${opName}」第 ${i + 1} 行不是 JSON：翻譯那一段沒寫對，問不到就不放行`); }
    if (!Array.isArray(page)) throw new PlatformError(`動作「${opName}」第 ${i + 1} 行不是一個陣列`);
    out.push(...page);
  }
  return out;
}

/** 這個專案把每個動作都填齊了沒。閘開跑前先問這個，缺哪個一次講完。 */
function missingOperations(settings = readSettings()) {
  const registered = (settings.platform || {}).operations || {};
  return Object.keys(OPERATIONS).filter((name) => {
    const v = registered[name];
    return !Array.isArray(v) || v.length === 0 || v[0] === UNSET;
  });
}

if (require.main === module) {
  const missing = missingOperations();
  const total = Object.keys(OPERATIONS).length;
  const lines = [`平台介面共 ${total} 個動作，這個專案還沒登記 ${missing.length} 個。`];
  for (const [name, op] of Object.entries(OPERATIONS)) {
    lines.push(`${missing.includes(name) ? '✗ 未登記' : '✓ 已登記'}｜${name}｜${op.what}`);
  }
  if (missing.length) lines.push('沒登記的動作被問到時一律丟錯、不放行——不會回一個空答案假裝問過了。');
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(missing.length ? 2 : 0);
}

module.exports = { ask, missingOperations, runCommand, checkShape, parseList, OPERATIONS, PlatformError, LINE_BREAK, UNSET };
