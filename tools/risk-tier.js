#!/usr/bin/env node
// 合併前風險分級（規矩 D4）：依這支PR動到的檔案，照專案設定的風險表先算高／中／低，並印出這一級在複審與掃描分級表上的那一列。
//
// 為什麼：審多深、掃不掃照風險級別查表（F2、G1），級別要是每次由送審的人自己估，就回到原專案 PFW #655 那樣各輪各估各的。
// 先由機器依檔案算，實作者只能往重調、複審者第 1 輪核實、裁示者往上往下都可以改（D4）。
//
// 跟合併後的驗收分級（tools/acceptance-tier.js）是兩張不同的表、方向也不同：同一個檔對驗收可能最輕、對風險卻是高（例如工具）。
// 「這支動到哪些檔」兩支共用同一份算法（changedPaths），不各算各的；「一個檔算哪一級」不共用：一個檔對上幾個家族，這裡取最重的。
//
// 守不到的：內容碰不碰到升級條件（要讀內容才知道，這支只印出條件提醒）；有沒有照印出來的級別送審；
// 「只升不降」：它只看這支當下動到的檔、不記前幾輪算過的級別，拿掉一個高風險的檔就會印出比較輕的級別。
// 退出碼：0＝算出來了／2＝算不出來（風險表沒填好、平台問不到、沒有路徑）。⚠️ 不是閘。
// 指令列在輸出後面印 D4（級別怎麼定）、F2（審多深）、G1（掃不掃）、F12（快速通道）的原文：送審前要用的就是這幾條。只多印，不改退出碼。
//
// 也判這一支能不能走「快速通道（AI）」（F12；擁有者 2026-10-13 裁）：每個路徑都要在專案設定 fastLane.ai 的清單上——
// files 上的整檔改什麼都收、commentOnly 上的只改註解才收、never 上的一律不收；有一個路徑不收，整支就不走。
// 「只改註解」用保守的規則判（他裁選 a，不引進外部的程式解析器）：只認 // 開頭的整行註解——改到的每一行，改前在舊版、改後在新版
// 都要是；行裡不准有 */（落在別人的區塊裡會把區塊收掉），給機器讀的（帶 @、# 指示、eslint、istanbul 這類工具名）不收，行中夾著 CR、U+2028、U+2029 的不收
// （JavaScript 在那裡也換行，// 後面就成了程式）；兩版都要是同一種一般檔案（新增、刪除、改名、改權限、符號連結、子模組都不收）。
// 為什麼不收 /* … */ 區塊註解：判一行在不在區塊裡、區塊在哪裡收尾，等於重做 JavaScript 怎麼讀程式，複審與掃描一輪輪鑽出新寫法
// （#96 r1 行中換行字元、r3 符號連結、掃描 1-1 一行 /*/）；答過連三輪自問表後收成只認這一種寫法。
// 版本內容讀本機 git（主幹那一版與受審版本的共同祖先 → 受審版本）；本機沒有那兩個版本＝判不出、不走。
// ⚠️ 判「只改註解」守不到的：多行字串或範本字串裡剛好長得像 // 註解的一行（會被當成註解收下）；程式把自己的原始碼當資料讀
//    （例如考題讀工具的檔頭）——這些靠輕審那一輪的複審者核、雲端三關照跑。這道判斷防的是把改程式誤當成改註解的手誤。
'use strict';
const { ask, PlatformError } = require('./platform.js');
const { read: readSettings } = require('./settings-data.js');
const { changedPaths } = require('./acceptance-tier.js');
const { RISK_TIERS } = require('./build-settings.js');
const { ruleFooter } = require('./build-rules.js');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('./git-env.js');

/** 送審前印的那幾條（按需印條文）。 */
const RULES_SHOWN = ['D4', 'F2', 'G1', 'F12'];
const UNSET = '未設定';

/**
 * 讀設定裡的風險表；形狀不對＝null。
 * ⚠️ 有一筆壞就整張不算、不濾掉（跟驗收分級表同一個理由：濾掉一筆＝那一族靜靜落到「沒列到」）；
 *    不過這裡沒列到的一律算高（D4：判不出＝高），所以濾掉只會變重——仍然不濾，壞表就該被看見。
 */
function riskTableOf(settings) {
  const r = settings.risk || {};
  if (!Array.isArray(r.families) || !r.families.length) return null;
  const families = [];
  for (const f of r.families) {
    if (!f || typeof f.pattern !== 'string' || !f.pattern.startsWith('^') || !RISK_TIERS.includes(f.tier)) return null;
    let re;
    try { re = new RegExp(f.pattern, 'u'); } catch { return null; }
    families.push({ re, tier: f.tier });
  }
  const raise = Array.isArray(r.raise) ? r.raise.filter((x) => typeof x === 'string' && x.trim() && x !== '未設定') : [];
  return { families, raise };
}

/**
 * 純判斷層：每個檔在**所有**對上的家族裡取最重的那一級（不是第一個對上的），沒對上的＝高；整支取最重的。
 * 為什麼不沿用驗收分級的 classify：那邊每個檔取第一個對上的家族，表的列一重疊（例如 ^docs/ 低、^docs/contracts/ 高），
 * 換一下順序級別就變輕——驗收分級可以讓表的人自己排順序，風險分級不行（#32 r2）：表上寫明是高的檔，不可以因為排在後面就算低。
 */
function classifyRisk(paths, table) {
  const rank = (t) => RISK_TIERS.indexOf(t);
  const hits = paths.map((p) => {
    const tiers = table.families.filter((f) => f.re.test(p)).map((f) => f.tier);
    if (!tiers.length) return { path: p, tier: RISK_TIERS[0], known: false };
    return { path: p, tier: tiers.reduce((a, b) => (rank(b) < rank(a) ? b : a)), known: true };
  });
  const level = RISK_TIERS.find((t) => hits.some((h) => h.tier === t)) || null;
  return { level, hits, unknown: hits.filter((h) => !h.known).map((h) => h.path) };
}

/**
 * 讀「快速通道（AI）」的清單（F12）。三張都要有：files、commentOnly、never（never 可以是空陣列＝明說沒有要排除的）。
 * 有一張含「未設定」或整段沒登記＝null（專案沒登記、不走）；形狀不對＝{ broken: 一句原因 }（不走，而且要說出來）。
 */
function fastLaneTableOf(settings) {
  const ai = ((settings || {}).fastLane || {}).ai;
  if (ai === undefined) return null;
  if (!ai || typeof ai !== 'object' || Array.isArray(ai)) return { broken: 'fastLane.ai 不是物件' };
  const table = {};
  for (const key of ['files', 'commentOnly', 'never']) {
    const list = ai[key];
    if (!Array.isArray(list)) return { broken: `fastLane.ai.${key} 不是陣列` };
    if (list.includes(UNSET)) return null;
    table[key] = [];
    for (const pattern of list) {
      if (typeof pattern !== 'string' || !pattern.startsWith('^')) return { broken: `fastLane.ai.${key} 有一筆樣式沒以 ^ 開頭（${JSON.stringify(pattern)}）` };
      try { table[key].push(new RegExp(pattern, 'u')); } catch { return { broken: `fastLane.ai.${key} 有一筆不是合法正規式（${pattern}）` }; }
    }
  }
  return table;
}

/** 本機跑 git（先清掉 GIT_ 那一族，E4）：{ ok, out }。 */
function gitIn(cwd) {
  return (args) => {
    const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { ok: !r.error && r.status === 0, out: r.stdout || '' };
  };
}

// 型別、工具指示這類給機器讀的註解（K3 第 2 種）：改了可能改到檢查的行為，不算「只改說明」
const MACHINE_COMMENT = /@|^\/\/\s*#|\b(eslint|jshint|jscs|istanbul|c8|prettier|tslint|globals?)\b/iu;
// 這一版的第 i 行（從 0 算）是不是 // 開頭的整行註解；判不準的一律不是。
// 只認這一種寫法：區塊註解要判在不在區塊裡、哪裡收尾，等於重做 JavaScript 怎麼讀程式（#96 掃描 1-1 之後收窄）。
function wholeLineComment(lines, i) {
  const raw = String(lines[i] === undefined ? '' : lines[i]).replace(/\r$/u, '');   // CRLF 檔的行尾那一個 CR 不算
  // git 只用 LF 分行，JavaScript 在 CR、U+2028、U+2029 也會換行：// 註解在那裡就結束、後面可以是程式（Codex #96 r1 R1）
  if (/[\r\u2028\u2029]/u.test(raw)) return false;
  const t = raw.trim();
  // 行裡有 */：這一行要是落在別人的區塊註解裡，會把區塊提早收掉、後面變成程式，不收（/* 在 // 註解裡什麼都不做，不用擋）；
  // 空行落到這裡也是不收（多行字串裡的空行是字串的一部分）
  return t.startsWith('//') && !t.includes('*/') && !MACHINE_COMMENT.test(t);
}

/**
 * 讀 git diff -U0 的輸出：改掉的行（舊版的行號，從 0 算）與加上的行（新版的行號）。
 * 標頭裡有權限、新增、刪除、改名、二進位的字樣＝{ error }；一個區塊都沒有＝{ error }（例如只改了權限）。
 */
function changedLinesOf(diff) {
  const lines = String(diff).split('\n');
  let i = 0;
  for (; i < lines.length && !lines[i].startsWith('@@'); i += 1) {
    if (/^(old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|Binary files|GIT binary patch)/u.test(lines[i])) {
      return { error: '改的不只是內容（權限、新增、刪除、改名或二進位）' };
    }
  }
  if (i >= lines.length) return { error: '沒有改到任何一行' };
  const removed = [];
  const added = [];
  while (i < lines.length) {
    if (lines[i] === '' && i === lines.length - 1) break;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[i]);
    if (!m) return { error: '改動的格式讀不懂' };
    const [oldStart, newStart] = [Number(m[1]), Number(m[3])];
    const [oldCount, newCount] = [m[2] === undefined ? 1 : Number(m[2]), m[4] === undefined ? 1 : Number(m[4])];
    i += 1;
    let o = 0;
    let n = 0;
    while (o < oldCount || n < newCount) {
      const l = lines[i];
      if (l === undefined) return { error: '改動的格式讀不懂' };
      if (l.startsWith('\\')) { i += 1; continue; }
      if (l.startsWith('-') && o < oldCount) { removed.push(oldStart - 1 + o); o += 1; }
      else if (l.startsWith('+') && n < newCount) { added.push(newStart - 1 + n); n += 1; }
      else return { error: '改動的格式讀不懂' };
      i += 1;
    }
    while (i < lines.length && lines[i].startsWith('\\')) i += 1;
  }
  return { removed, added };
}

/** 一個檔從 base 到 head 是不是只改了註解：{ ok } 或 { ok: false, why }。 */
function commentOnlyFile(file, { git, base, head }) {
  if (!/\.(c|m)?js$/u.test(file)) return { ok: false, why: '只會判 JavaScript 的註解' };
  // 兩版都要是一般檔案：符號連結的內容是它指去哪裡，指向路徑剛好以 // 開頭就會被當成註解（Codex #96 r3 R5）；子模組也不收
  const modeOf = (rev) => {
    const r = git(['ls-tree', '--full-tree', rev, '--', file]);
    const m = r.ok ? /^(\d{6}) blob /u.exec(r.out) : null;
    return m ? m[1] : null;
  };
  const [modeBefore, modeAfter] = [modeOf(base), modeOf(head)];
  if (!['100644', '100755'].includes(modeBefore) || modeAfter !== modeBefore) return { ok: false, why: '不是兩版都同樣是一般檔案（符號連結、子模組、新增刪除或改了權限）' };
  const before = git(['cat-file', 'blob', `${base}:${file}`]);
  const after = git(['cat-file', 'blob', `${head}:${file}`]);
  if (!before.ok || !after.ok) return { ok: false, why: '讀不到檔案內容' };
  const diff = git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', base, head, '--', file]);
  if (!diff.ok) return { ok: false, why: '讀不到改動' };
  const changed = changedLinesOf(diff.out);
  if (changed.error) return { ok: false, why: changed.error };
  const oldLines = before.out.split('\n');
  const newLines = after.out.split('\n');
  const badOld = changed.removed.find((k) => !wholeLineComment(oldLines, k));
  if (badOld !== undefined) return { ok: false, why: `舊版第 ${badOld + 1} 行不是判得出的整行註解` };
  const badNew = changed.added.find((k) => !wholeLineComment(newLines, k));
  if (badNew !== undefined) return { ok: false, why: `新版第 ${badNew + 1} 行不是判得出的整行註解` };
  return { ok: true };
}

/**
 * 這一支能不能走「快速通道（AI）」（F12）：{ ok, off?, reasons, files, comments }。
 * 每個路徑：never 上的不收 → files 上的收 → commentOnly 上的要只改註解才收 → 其餘不收。有一個不收，整支不走。
 */
function fastLaneAI(paths, table, { git, base, head }) {
  if (!table) return { ok: false, off: true, reasons: ['專案設定沒登記 fastLane.ai'] };
  if (table.broken) return { ok: false, reasons: [`專案設定的 fastLane.ai 壞了：${table.broken}`] };
  const reasons = [];
  const files = [];
  const comments = [];
  let mergeBase = null;
  for (const p of paths) {
    if (table.never.some((re) => re.test(p))) { reasons.push(`${p} 在一律不收的清單上`); continue; }
    if (table.files.some((re) => re.test(p))) { files.push(p); continue; }
    if (!table.commentOnly.some((re) => re.test(p))) { reasons.push(`${p} 不在清單上`); continue; }
    if (mergeBase === null) {
      const found = base && head ? git(['merge-base', base, head]) : { ok: false };
      mergeBase = found.ok ? found.out.trim() : '';
    }
    if (!mergeBase) { reasons.push(`${p}：本機找不到主幹與受審版本的共同祖先（先 git fetch），判不出`); continue; }
    const r = commentOnlyFile(p, { git, base: mergeBase, head });
    if (r.ok) comments.push(p); else reasons.push(`${p}：${r.why}`);
  }
  return { ok: reasons.length === 0, reasons, files, comments };
}

function run(changeId, { settings = readSettings(), platform = { ask }, git = gitIn(process.cwd()) } = {}) {
  if (!changeId) return { code: 2, lines: ['用法：node tools/risk-tier.js <變更編號>'] };
  const table = riskTableOf(settings);
  if (!table) return { code: 2, lines: [`專案設定裡的風險表沒填好（risk.families 要有，每一筆的樣式以 ^ 開頭、是合法正規式，級別只能是 ${RISK_TIERS.join('／')}）：算不出來。`] };
  const got = changedPaths(changeId, { settings, platform, what: '風險分級' });
  if (got.error) return { code: 2, lines: got.error };
  const { paths, countNote } = got;
  const r = classifyRisk(paths, table);
  const lines = [`風險分級｜變更 ${changeId}：${r.level}（依檔案先算；動到 ${paths.length} 個路徑）${countNote}`];
  for (const id of RISK_TIERS) {
    const hit = r.hits.filter((h) => h.tier === id && h.known).map((h) => h.path);
    if (hit.length) lines.push(`  ・${id}：${hit.join('、')}`);
  }
  if (r.unknown.length) lines.push(`  ⚠️ 沒列在風險表上的路徑，一律算高（D4：判不出＝高）：${r.unknown.join('、')}——改表的人要核對它們該屬哪一級。`);
  const row = (settings.reviewTiers || {})[r.level];
  if (row) lines.push(`  照複審與掃描分級表（${r.level}）：全審 ${row.full}；只核差異 ${row.diffOnly}；通過後照 F6 回頭改的那一輪 ${row.afterPassFix}；掃描 ${row.scan}`);
  else lines.push(`  ⚠️ 複審與掃描分級表沒有「${r.level}」那一列：全審幾輪、掃不掃查不到。`);
  const laneTable = fastLaneTableOf(settings);
  let baseTip = null;
  if (laneTable && !laneTable.broken && paths.some((p) => laneTable.commentOnly.some((re) => re.test(p)))) {
    try { baseTip = platform.ask('branchSha', { branch: got.baseBranch }, { settings }).sha; } catch (e) {
      if (!(e instanceof PlatformError || (e && e.name === 'PlatformError'))) throw e;
    }
  }
  const lane = fastLaneAI(paths, laneTable, { git, base: baseTip, head: got.headSha });
  if (lane.ok) {
    const what = [lane.files.length ? `清單上的檔 ${lane.files.join('、')}` : '', lane.comments.length ? `只改註解的 ${lane.comments.join('、')}` : ''].filter(Boolean).join('；');
    lines.push(`  快速通道（AI）：可以（${what}）——複審者第 1 輪起只核差異、不掃描，取代上面那一列的全審與掃描；連兩輪沒「通過」，下一輪起照上面那一級走一般流程（F12）。`);
  } else if (lane.off) {
    lines.push('  快速通道（AI）：專案設定沒登記清單（fastLane.ai），不走（F12）。');
  } else {
    const shown = lane.reasons.slice(0, 5).join('；');
    const more = lane.reasons.length > 5 ? `；另有 ${lane.reasons.length - 5} 個路徑也不收` : '';
    lines.push(`  快速通道（AI）：不走——${shown}${more}（F12：判不出就照一般流程）。`);
  }
  lines.push(table.raise.length
    ? `  內容碰到任一條升級條件，整支就算高（${table.raise.join('；')}）；實作者只能往重調，往下只有裁示者能改；每次送審重算、只升不降，這支工具不記前幾輪的級別（D4）。`
    : '  ⚠️ 專案設定沒填升級條件：內容要不要往重調，只能靠實作者與複審者自己判斷（D4）。');
  return { code: 0, lines, result: { ...r, head: got.headSha, fastLaneAI: lane.ok } };   // head：算的是哪一個版本（送審產生器拿去跟受審版本對）；fastLaneAI：能不能走快速通道（AI）
}

if (require.main === module) {
  let result;
  try { result = run(process.argv[2]); } catch (e) { result = { code: 2, lines: [`風險分級：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——算不出來。`] }; }
  process.stdout.write(`${[...result.lines, ...ruleFooter(RULES_SHOWN)].join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { run, riskTableOf, classifyRisk, fastLaneTableOf, fastLaneAI, commentOnlyFile, changedLinesOf, wholeLineComment, gitIn, RULES_SHOWN };
