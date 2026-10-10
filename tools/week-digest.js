#!/usr/bin/env node
// 本週成果產生器（規矩 J5）：最近七天合併進主幹的 PR，照日期列成共用進度摘要「本週成果」那一節的形狀；
// 不帶 --write 只印到標準輸出，帶 --file <摘要> --write 才把那一節換掉（只換那一節，前後的節一個字不動）。
//
// 為什麼：擁有者 2026-10-07 裁「三件都做」的第二件——「本週成果」原本靠人手抄，三條線各寫各的、格式會漂、
// 做完的事也會漏（另一個工作階段曾把自己那一則蓋回舊格式；進度摘要檢查抓得到形狀、抓不到漏寫）。
// 合併紀錄本來就在平台上，機器照它產生，人只負責各線那一則的現況；沒有 PR 的成果寫在各線的「做了什麼」。
//
// 守得到的：
//   ①只算合併進主幹（--main，預設 main）、merged_at 在最近 --days 天（預設 7）之內的 PR；關掉沒合併的不算；
//   ②日期用台北時間歸日（摘要裡的時間都是台北）；
//   ③形狀跟 tools/check-progress-summary.js 認的一樣：「- 月/日」加「  - 專案：標題——已合併（#N）」；日期新的在前，
//     同一天照 --repos 登記的順序分專案、同專案照合併時間；標題裡的換行與多餘空白收掉；
//   ④驗收留痕：那支 PR 的留言用待裁清單工具同一套判斷（tools/pending-rulings.js 的 evaluate：第一行「## ✅ 驗收（YYYY-MM-DD）：標題」、
//     真的日曆日、原話那一行、登記過的貼文帳號；r1 R2），採計的最後一則的日期加成「；月/日 已驗收」；留言讀齊每一頁（r1 R3）；--no-acceptance 不問；
//   ⑤--write 只換那一節（從「## 本週成果」那一行到下一個同級或更高的標題之前；# 前面 0〜3 個空白也算標題），分隔線留著；
//     找不到那一節、出現兩次、或那一節裡有不是產生器寫的行（標題寫歪了、有人手改；分不出結尾）＝退 2、檔案不動；
//     檔在問完平台之後才讀、讀完立刻寫（r1 R1：先讀再問平台、最後寫回舊快照，會把別的工作階段這段時間改的其他節蓋掉）；
//   ⑥問平台固定問 github.com、先清掉選主機／選倉庫／指向別倉庫的環境變數；分頁：一頁滿 100 筆且最舊的還在窗內才翻下一頁，
//     翻到上限還沒到窗口邊界＝退 2、不寫（r1 R4：不拿不完整的清單換掉那一節）；
//   ⑦沒有合併紀錄的一週也印成檢查認得的形狀（今天的日期行加一個子項目；r1 R5）。
// ⚠️ 守不到的：沒有 PR 的成果（手寫的，放各線那一則）；標題寫得對不對；台北以外的時區；驗收留痕的內容真不真（只認形狀與帳號）；
//   讀檔到寫檔那一瞬間別人同時寫（只縮到最短，沒有鎖）；gh 沒裝或沒登入＝退 2（不猜）；--write 之後要不要提交那份摘要（倉庫外的檔，由更新摘要的人提交）。
// 退出碼：0＝做好了／2＝做不了（參數不對、gh 退非零或回的不是 JSON、檔讀不到、那一節找不到或重複）。⚠️ 不是閘。
'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('./git-env.js');
const { parseInstant } = require('./time-point.js');
const { evaluate: evaluateTraces, deciderOf } = require('./pending-rulings.js');
const { read: readSettings } = require('./settings-data.js');

const DAYS = 7;
const TZ = 'Asia/Taipei';
const HEADING = '## 本週成果';
const HOST = 'github.com';
const PAGE = 100;
// 翻頁上限：翻到這裡還沒到窗口邊界＝清單不完整，退 2 不寫（r1 R4）
const MAX_PAGES = 50;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** 跟進度摘要檢查同一套：清版本控制的環境變數，再清 gh 選主機、選倉庫的。 */
function ghEnv(env = process.env) {
  const out = gitEnv(env);
  for (const key of ['GH_HOST', 'GH_REPO', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete out[key];
  return out;
}

function runGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', env: ghEnv(), maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

class ToolError extends Error {}

/** 問平台一個 JSON 陣列；退非零、不是 JSON、不是陣列＝ToolError（退 2，不猜）。 */
function askArray(runner, apiPath) {
  const r = runner(['api', '--hostname', HOST, apiPath]);
  if (r.status !== 0) throw new ToolError(`問平台失敗（gh 退 ${r.status}）：${apiPath}${r.stderr ? `\n${r.stderr.trim()}` : ''}`);
  let data;
  try { data = JSON.parse(r.stdout); } catch { throw new ToolError(`平台回的不是 JSON：${apiPath}`); }
  if (!Array.isArray(data)) throw new ToolError(`平台回的不是清單：${apiPath}`);
  return data;
}

/** 台北時間的「月/日」。 */
function dayOf(ms, tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('month')}/${get('day')}`;
}

/**
 * 平台回的 PR 清單（closed、照 updated 新到舊）→ 合併進主幹、merged_at 在 [now − days, now] 之內的那幾支。
 * 回 { number, title, mergedMs }；merged_at 讀不出時間＝不算。
 */
function mergedWithin(list, { nowMs, days = DAYS, mainBranch = 'main' }) {
  const since = nowMs - days * 86400000;
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object' || typeof p.merged_at !== 'string') continue;
    if (!p.base || p.base.ref !== mainBranch) continue;
    const ms = parseInstant(p.merged_at);
    if (ms === null || ms < since || ms > nowMs) continue;
    out.push({ number: Number(p.number), title: String(p.title || ''), mergedMs: ms });
  }
  return out;
}

/** 平台回的留言（GitHub 原樣）→ 待裁清單工具的形狀。 */
const traceShape = (c, change) => ({ id: String(c && c.id), author: c && c.user ? c.user.login : undefined, body: c ? c.body : '', createdAt: c ? c.created_at : undefined, change: String(change) });

/**
 * 驗收留痕用待裁清單工具同一套判斷（r1 R2：另造一套較寬的判準，會把格式示例、寫壞的日期、沒登記的帳號都當成已驗收）：
 * 採計的最後一則的日期「月/日」；沒有＝null；留言的時間讀不出＝ToolError（不猜）。comments＝待裁清單工具的形狀。
 */
function acceptedDate(comments, decider) {
  const r = evaluateTraces(comments, decider);
  if (r.unsure) throw new ToolError(`驗收留痕判不了：${r.unsure}`);
  const accepted = r.accepted || [];
  if (!accepted.length) return null;
  const last = accepted[accepted.length - 1];
  return `${last.date.slice(5, 7)}/${last.date.slice(8, 10)}`;
}

const tidy = (title) => title.replace(/\s+/gu, ' ').trim();

/** items＝{ alias, number, title, mergedMs, accepted }；order＝--repos 登記的順序；nowMs＝空的那一週要印哪一天。回那一節的行（檢查認得的形狀）。 */
function render(items, { order = [], nowMs = Date.now(), days = DAYS } = {}) {
  if (!items.length) return [`- ${dayOf(nowMs)}`, `  - 最近 ${days} 天沒有合併進主幹的 PR`];
  const rank = (alias) => { const i = order.indexOf(alias); return i < 0 ? order.length : i; };
  const byDay = new Map();
  for (const it of items) {
    const day = dayOf(it.mergedMs);
    if (!byDay.has(day)) byDay.set(day, { newest: it.mergedMs, items: [] });
    const d = byDay.get(day);
    d.newest = Math.max(d.newest, it.mergedMs);
    d.items.push(it);
  }
  const byDate = [...byDay.entries()].sort((a, b) => b[1].newest - a[1].newest);
  const lines = [];
  for (const [day, d] of byDate) {
    lines.push(`- ${day}`);
    d.items.sort((a, b) => rank(a.alias) - rank(b.alias) || a.mergedMs - b.mergedMs);
    for (const it of d.items) {
      const mark = it.accepted ? `；${it.accepted} 已驗收` : '';
      lines.push(`  - ${it.alias}：${tidy(it.title)}——已合併（#${it.number}${mark}）`);
    }
  }
  return lines;
}

/** 那一節到哪裡結束：下一個同級或更高的標題（跟 Markdown 一樣，# 前面 0〜3 個空白也算標題、# 後面要空一格或直接換行）。 */
const BOUNDARY = /^ {0,3}#{1,2}(?:[ \t]|$)/u;
/**
 * 那一節只准機器寫（摘要檔頭：「不要手改那一節」），舊內容就只會有產生器自己寫的四種行：空行、分隔線、「- 月/日」、「  - …」。
 * 有任何別的行＝分不出那一節到哪裡結束（例如標題寫歪了：「##已結束」沒空格、四個空白或定位字元開頭、# 後面是全形空白或不斷行空白、
 * 全形的＃），照舊吞到下一個合格的標題會把中間那一節刪掉，所以整份不寫（理財 #672 r1 第 2 條、r2 第 1 條）。
 * 不去一種一種認「像標題的寫法」——那認不完（r2 就是 r1 漏掉的全形空白）；只認自己寫得出來的形狀，其餘一律拒寫。
 */
const OWN_LINE = /^(?:[ \t]*|-{3,}[ \t]*|- \d{2}\/\d{2}[ \t]*| {2}- .*)$/u;

/**
 * 只換「## 本週成果」那一節：從標題行的下一行到下一個同級或更高的標題（BOUNDARY）之前；分隔線（---）留著；換行先統一成 LF。
 * 回換好的整份文字；找不到、或那一節出現兩次回 null；那一節裡有不是產生器寫的行回 { suspect：第幾行, line }。後兩種都不寫。
 */
function replaceSection(text, bodyLines) {
  const lines = String(text).replace(/\r\n?/gu, '\n').split('\n');
  const heads = lines.map((l, i) => (l.startsWith(HEADING) ? i : -1)).filter((i) => i >= 0);
  if (heads.length !== 1) return null;
  const h = heads[0];
  let n = h + 1;
  while (n < lines.length && !BOUNDARY.test(lines[n])) n += 1;
  const old = lines.slice(h + 1, n);
  const bad = old.findIndex((l) => !OWN_LINE.test(l));
  if (bad >= 0) return { suspect: h + 2 + bad, line: old[bad] };
  const keepRule = old.some((l) => /^-{3,}\s*$/u.test(l));
  const fresh = ['', ...bodyLines, '', ...(keepRule ? ['---', ''] : [])];
  return [...lines.slice(0, h + 1), ...fresh, ...lines.slice(n)].join('\n');
}

function parseRepos(spec) {
  const repos = Object.create(null);
  const order = [];
  for (const part of String(spec).split(',')) {
    const i = part.indexOf('=');
    const alias = i < 0 ? '' : part.slice(0, i).trim();
    const repo = i < 0 ? '' : part.slice(i + 1).trim();
    if (!alias || !REPO.test(repo)) throw new ToolError(`--repos 的寫法要是「別名=owner/repo」、逗號分隔：認不出「${part}」`);
    repos[alias] = repo;
    order.push(alias);
  }
  return { repos, order };
}

function parseArgs(argv) {
  const opts = { repos: null, order: [], days: DAYS, nowMs: null, mainBranch: 'main', file: null, write: false, acceptance: true, settings: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new ToolError(`${a} 後面要接值`); return argv[i]; };
    if (a === '--repos') { const r = parseRepos(next()); opts.repos = r.repos; opts.order = r.order; }
    else if (a === '--days') { const d = Number(next()); if (!Number.isInteger(d) || d < 1 || d > 60) throw new ToolError('--days 要是 1〜60 的整數'); opts.days = d; }
    else if (a === '--now') { const ms = parseInstant(next()); if (ms === null) throw new ToolError('--now 要是帶時區的時間（例如 2026-10-09T10:00:00+08:00）'); opts.nowMs = ms; }
    else if (a === '--main') opts.mainBranch = next();
    else if (a === '--file') opts.file = next();
    else if (a === '--write') opts.write = true;
    else if (a === '--no-acceptance') opts.acceptance = false;
    else if (a === '--settings') opts.settings = next();
    else throw new ToolError(`不認得的參數：${a}`);
  }
  if (!opts.repos) throw new ToolError('要帶 --repos 別名=owner/repo[,…]');
  if (opts.write && !opts.file) throw new ToolError('--write 要配 --file <摘要檔>');
  return opts;
}

/** 一個倉庫：照 updated 新到舊翻頁，直到一頁不滿、或最舊的那一筆已經早於窗口；翻到上限還沒到邊界＝ToolError（清單不完整，不寫）。 */
function fetchMerged(runner, repo, opts) {
  const since = opts.nowMs - opts.days * 86400000;
  const all = [];
  let done = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const list = askArray(runner, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE}&page=${page}`);
    all.push(...list);
    if (list.length < PAGE) { done = true; break; }
    const oldest = parseInstant(String(list[list.length - 1].updated_at || ''));
    if (oldest === null || oldest < since) { done = true; break; }
  }
  if (!done) throw new ToolError(`${repo} 翻了 ${MAX_PAGES} 頁還沒翻到窗口邊界，清單不完整，不拿它換那一節`);
  return mergedWithin(all, opts);
}

/** 一支 PR 的留言讀齊每一頁（r1 R3：只讀第一頁會漏掉後貼的驗收）。 */
function fetchComments(runner, repo, number) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const list = askArray(runner, `repos/${repo}/issues/${number}/comments?per_page=${PAGE}&page=${page}`);
    all.push(...list);
    if (list.length < PAGE) return all;
  }
  throw new ToolError(`${repo}#${number} 的留言翻了 ${MAX_PAGES} 頁還沒讀完，不猜驗收`);
}

function run(argv, { runner = runGh, out = process.stdout, err = process.stderr, settings = null } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { if (e instanceof ToolError) { err.write(`本週成果產生器：${e.message}\n`); return 2; } throw e; }
  if (opts.nowMs === null) opts.nowMs = Date.now();
  // 先確認檔讀得到、那一節在；內容要等問完平台再讀（r1 R1）
  if (opts.file) {
    let probe;
    try { probe = fs.readFileSync(opts.file, 'utf8'); } catch (e) { err.write(`本週成果產生器：讀不到 ${opts.file}（${e.message}）\n`); return 2; }
    if (opts.write && replaceSection(probe, []) === null) { err.write(`本週成果產生器：${opts.file} 裡找不到唯一的「${HEADING}」那一節，沒有寫\n`); return 2; }
  }
  let decider = null;
  if (opts.acceptance) {
    let data;
    try { data = settings || (opts.settings ? JSON.parse(fs.readFileSync(opts.settings, 'utf8')) : readSettings()); } catch (e) { err.write(`本週成果產生器：讀不到設定（${e.message}）\n`); return 2; }
    decider = deciderOf(data);
    if (!decider) { err.write('本週成果產生器：設定裡的裁示者識別值或貼文帳號還沒填，判不了驗收留痕（要略過驗收帶 --no-acceptance）\n'); return 2; }
  }
  const items = [];
  const counts = [];
  try {
    for (const alias of opts.order) {
      const repo = opts.repos[alias];
      const merged = fetchMerged(runner, repo, opts);
      counts.push(`${alias} ${merged.length} 支`);
      for (const m of merged) {
        const accepted = opts.acceptance ? acceptedDate(fetchComments(runner, repo, m.number).map((c) => traceShape(c, m.number)), decider) : null;
        items.push({ alias, number: m.number, title: m.title, mergedMs: m.mergedMs, accepted });
      }
    }
  } catch (e) { if (e instanceof ToolError) { err.write(`本週成果產生器：${e.message}\n`); return 2; } throw e; }
  const lines = render(items, { order: opts.order, nowMs: opts.nowMs, days: opts.days });
  err.write(`本週成果產生器｜最近 ${opts.days} 天合併進 ${opts.mainBranch} 的：${counts.join('、')}（共 ${items.length} 支；問了 ${HOST}）\n`);
  if (!opts.write) { out.write(`${lines.join('\n')}\n`); return 0; }
  // 問完平台才讀檔、讀完立刻寫：別的工作階段這段時間改的其他節才不會被舊快照蓋掉（r1 R1）
  let text;
  try { text = fs.readFileSync(opts.file, 'utf8'); } catch (e) { err.write(`本週成果產生器：讀不到 ${opts.file}（${e.message}）\n`); return 2; }
  const next = replaceSection(text, lines);
  if (next === null) { err.write(`本週成果產生器：${opts.file} 裡找不到唯一的「${HEADING}」那一節，沒有寫\n`); return 2; }
  if (typeof next !== 'string') {
    err.write(`本週成果產生器：${opts.file} 第 ${next.suspect} 行「${next.line.trim().slice(0, 40)}」不是產生器寫的形狀（那一節只准機器寫；常見是下一節的標題寫歪了——# 前面最多三個半形空白、# 後面要空一個半形空白——或有人手改）：分不出那一節到哪裡結束，沒有寫；改好那一行再跑\n`);
    return 2;
  }
  fs.writeFileSync(opts.file, next);
  out.write(`已把 ${opts.file} 的「${HEADING}」那一節換成 ${lines.length} 行（其餘的節沒動；記得提交那份檔）\n`);
  return 0;
}

if (require.main === module) process.exit(run(process.argv.slice(2)));

module.exports = { run, parseArgs, parseRepos, mergedWithin, dayOf, render, replaceSection, acceptedDate, traceShape, fetchMerged, fetchComments, ghEnv, DAYS, HEADING, TZ, MAX_PAGES };
