#!/usr/bin/env node
// 舊文字掃描（規矩 K5）：把這支刪掉或改掉的字串拿去搜整個倉庫，列出還出現在哪裡；只列不擋。
//
// 為什麼：改了行為，考題會自己紅、逼你改；契約、規矩文件、畫面文字、註解不會紅，漏了就變成假話。
// 原專案 #641〜#657 共 197 條複審發現裡，82 條（42%）是這一類，是最大的一類；PFW #655 第二輪唯一擋合併的，
// 就是契約裡一句被這次改動變成假話的句子，而那句話裡的字正是第一版刪掉的。裁示者 2026-10-03 選「A」：
// 實作者送審前跑這支、逐條看，只列不擋。
//
// 抓哪些字串：
//   ①刪掉或改名的檔，它的舊路徑（與看得出是檔名的舊檔名）——還在指它的路標、指令都會變成假話；
//   從刪掉的行裡取：②引號或反引號框住的字（「」『』“”"'`）；③連續 4 個以上的漢字；④看得出是程式名字的英數字（含底線、連字號、點，或大小寫駝峰）。
//   新增的行裡用同一種抓法抓出一模一樣的字串＝作者自己留著用，不列（只是包含它的不算：loadUser 改成 loadUserById 照樣列 loadUser）。
// 兩邊都看已提交的版本：差異是基準到 HEAD 的三點差異（基準之後主幹自己的改動不算），搜的是 HEAD 那一版的已追蹤檔（工作樹裡還沒提交的改動、沒追蹤的檔都不算）。
// 守不到的：只抓字面相同的——意思變了但用字沒變、或換了說法的，抓不到；常見的字會列出不相干的位置，要人判斷。
//
// 退出碼：0＝掃完了（有沒有命中都是 0）／2＝掃不了（不在倉庫裡、基準版本找不到、git 出錯）。⚠️ 不是閘。
'use strict';
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('./git-env.js');
const { read: readSettings } = require('./settings-data.js');

// 一次最多搜幾個字串、每個字串最多列幾處；超過的照實印出還剩多少，不靜靜截掉
const MAX_PHRASES = 300;
const MAX_HITS = 10;

const QUOTED = /「([^」\n]{2,40})」|『([^』\n]{2,40})』|“([^”\n]{2,40})”/gu;
const ASCII_QUOTES = '"\'`';
const HAN = /\p{Script=Han}{4,60}/gu;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*/gu;
/** 看得出是程式名字：至少 6 個字元，而且帶底線、連字號、點，或小寫後面接大寫（駝峰）。一般英文單字不算。 */
const looksLikeName = (w) => w.length >= 6 && (/[_.-]/u.test(w) || /[a-z][A-Z]/u.test(w));

function git(args, { cwd, input } = {}) {
  return spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
}

/**
 * 讀 git diff --unified=0 的輸出，分出刪掉的行與新增的行。檔頭（diff --git 到第一個 @@ 之間，含 ---／+++ 那兩行）不算；
 * 內容本身以 -- 開頭的行（SQL、Lua 的註解）在差異裡長得像 ---，所以只在檔頭裡才跳過。
 */
function parseDiff(text) {
  const removed = [];
  const added = [];
  let inHeader = false;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) { inHeader = true; continue; }
    if (line.startsWith('@@')) { inHeader = false; continue; }
    if (inHeader) continue;
    if (line.startsWith('-')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return { removed, added };
}

/** 刪掉或改名的檔：舊路徑，加上看得出是檔名的舊檔名（太短太常見的檔名不單獨搜）。來源是 git diff --name-status -M。 */
function pathPhrases(nameStatus) {
  const out = [];
  for (const line of String(nameStatus).split('\n')) {
    const cols = line.split('\t');
    if (!/^[DR]/u.test(cols[0] || '') || !cols[1]) continue;
    out.push(cols[1]);
    const base = cols[1].split('/').pop();
    if (base !== cols[1] && looksLikeName(base)) out.push(base);
  }
  return out;
}

/**
 * 半形引號（" ' `）由左往右一對一對配，跟程式語言讀字串一樣：配到的內容 4〜60 個字才算。
 * 不用一條正規式去找，是因為正規式在短字串（例如 '7'）配不上之後，會從它的收尾引號重新開始，
 * 把「這段收尾引號到下一段開頭引號」之間的程式框進來、還吃掉下一段字串的開頭引號。
 */
function asciiQuoted(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const q = line[i];
    if (!ASCII_QUOTES.includes(q)) { i++; continue; }
    const end = line.indexOf(q, i + 1);
    if (end < 0) break;
    const t = line.slice(i + 1, end);
    if (t.length >= 4 && t.length <= 60) out.push(t);
    i = end + 1;
  }
  return out;
}

/** 一行裡用三種抓法抓出的字串（照出現順序，可能重複）。 */
function extract(line) {
  const out = [];
  for (const m of line.matchAll(QUOTED)) out.push(m.slice(1).find((x) => x !== undefined));
  out.push(...asciiQuoted(line));
  for (const m of line.matchAll(HAN)) out.push(m[0]);
  for (const m of line.matchAll(IDENT)) if (looksLikeName(m[0])) out.push(m[0]);
  return out;
}

/** 從刪掉的行取候選字串，照第一次出現的順序、不重複；新增的行裡用同一種抓法抓出一模一樣的字串＝作者自己留著用，不算。 */
function phrasesOf(removed, added, extra = []) {
  const kept = new Set(added.flatMap(extract).map((x) => x.trim()));
  const seen = new Set();
  const out = [];
  for (const p of [...extra, ...removed.flatMap(extract)]) {
    const t = String(p).trim();
    if (!t || seen.has(t) || kept.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 一次 git grep 搜 HEAD 那一版的全部字串，再把每一行分回它命中的字串。 */
function searchAll(phrases, cwd, runGit = git) {
  const hits = new Map(phrases.map((p) => [p, []]));
  if (!phrases.length) return { hits };
  const r = runGit(['grep', '-n', '-I', '-F', '--no-color', '-f', '-', 'HEAD'], { cwd, input: `${phrases.join('\n')}\n` });
  // git grep 沒找到任何一處＝退 1、什麼都沒印，不是錯誤；其餘非零（含被訊號殺掉、超過輸出上限的 null）都是錯誤，不可以當成沒命中
  if (r.status === 1 && !r.stdout && !(r.stderr || '').trim()) return { hits };
  if (r.status !== 0) return { error: `git grep 出錯（退出碼 ${r.status}）：${(r.stderr || '').trim().split('\n')[0]}` };
  for (const line of r.stdout.split('\n')) {
    const m = /^HEAD:(.*?):(\d+):(.*)$/u.exec(line);
    if (!m) continue;
    for (const p of phrases) if (m[3].includes(p)) hits.get(p).push({ file: m[1], line: Number(m[2]), text: m[3].trim() });
  }
  return { hits };
}

function run(args = [], { settings = readSettings(), cwd = process.cwd(), runGit = git, maxPhrases = MAX_PHRASES } = {}) {
  let base = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--base' && args[i + 1]) base = args[++i];
    else if (args[i] === '--base') return { code: 2, lines: ['用法：node tools/stale-text.js [--base <基準版本>]（--base 後面要接基準版本）'] };
    else return { code: 2, lines: [`用法：node tools/stale-text.js [--base <基準版本>]（不認得「${args[i]}」）`] };
  }
  if (!base) {
    if (!settings.mainBranch || settings.mainBranch === '未設定') return { code: 2, lines: ['專案設定的主幹分支名沒填，又沒給 --base：不知道跟哪一版比，掃不了。'] };
    base = `origin/${settings.mainBranch}`;
  }
  const top = runGit(['rev-parse', '--show-toplevel'], { cwd });
  if (top.status !== 0) return { code: 2, lines: ['這裡不在版本控制的倉庫裡：掃不了。'] };
  const root = top.stdout.trim();
  if (runGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root }).status !== 0) {
    return { code: 2, lines: [`找不到基準版本「${base}」（要先 git fetch？）：掃不了。`] };
  }
  const diff = runGit(['diff', '--no-color', '--no-ext-diff', '-M', '--unified=0', `${base}...HEAD`], { cwd: root });
  if (diff.status !== 0) return { code: 2, lines: [`git diff 出錯（退出碼 ${diff.status}）：${(diff.stderr || '').trim().split('\n')[0]}`] };
  const names = runGit(['diff', '--no-color', '--name-status', '-M', `${base}...HEAD`], { cwd: root });
  if (names.status !== 0) return { code: 2, lines: [`git diff 出錯（退出碼 ${names.status}）：${(names.stderr || '').trim().split('\n')[0]}`] };
  const { removed, added } = parseDiff(diff.stdout);
  const all = phrasesOf(removed, added, pathPhrases(names.stdout));
  const phrases = all.slice(0, maxPhrases);
  const found = searchAll(phrases, root, runGit);
  if (found.error) return { code: 2, lines: [`舊文字掃描：${found.error}——掃不了。`] };
  const live = phrases.filter((p) => found.hits.get(p).length);
  const lines = [`舊文字掃描｜${base}...HEAD：刪掉或改掉的字串 ${all.length} 個，其中 ${live.length} 個還出現在倉庫裡（只列不擋，K5）`];
  if (all.length > phrases.length) lines.push(`  ⚠️ 字串太多，只搜了前 ${phrases.length} 個；另有 ${all.length - phrases.length} 個沒搜（可以用更近的 --base 分段掃）`);
  for (const p of live) {
    const h = found.hits.get(p);
    lines.push(`「${p}」還出現在 ${h.length} 處：`);
    for (const x of h.slice(0, MAX_HITS)) lines.push(`  ${x.file}:${x.line}：${x.text.slice(0, 100)}`);
    if (h.length > MAX_HITS) lines.push(`  …另有 ${h.length - MAX_HITS} 處沒列`);
  }
  lines.push('逐條看：還在講舊行為的活文字就改（K5：契約、註解、題名、路標，連同規矩文件、畫面文字、驗收步驟）；不用改的在「PR說明」寫一行理由。只抓字面相同的，意思變了用字沒變的抓不到。');
  return { code: 0, lines, result: { phrases: all, live } };
}

if (require.main === module) {
  let result;
  try { result = run(process.argv.slice(2)); } catch (e) { result = { code: 2, lines: [`舊文字掃描：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——掃不了。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { run, parseDiff, phrasesOf, pathPhrases, extract, searchAll, looksLikeName, MAX_PHRASES, MAX_HITS };
