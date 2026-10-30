#!/usr/bin/env node
// 送審產生器（規矩 F1、F3、F11）：把送審提示的事實格填好、開兩棵固定在受審版本的樹（審查樹、突變副本）、
// 印出整行啟動指令；無憑證／沙盒複審後可用 --post 先核兩棵樹乾淨、HEAD 沒變、標頭與小標合格，再由外殼代貼結論；審完用 --close 先核兩棵樹乾淨、HEAD 沒變，再收掉。
//
// 為什麼：送審提示的事實格（版本碼、輪次、上一輪結論、兩條路徑、三條指令、來源字串）原本每輪手抄，啟動指令要從設定第十一節抄模型與推理；
// 案例簿已有兩起手填出錯（review-prompt-derivation-slip 漏改四處、燒掉一輪；heredoc-eaten-empty-prompt 空提示跑一輪），
// 而 Codex 的推理沒帶就照它自己的設定檔預設跑，從外面看不出來。擁有者 2026-10-07 裁第 2 批的三台提前做，這是其中第二台。
//
// 格子照範本出現的**順序**填（FILL 那張表），不照字面換：同一個尖括號字樣在不同位置意思不同（<識別值> 一處是複審者、一處是實作者）。
// 範本的格子一改，「範本的格子跟產生器的表一一對上」那一題就紅。只留 <三選一> 給複審者填。
// 啟動指令的正本在專案設定（reviewers 每一位的 command），這裡只替換記號；替換進去的值只收不用加引號的字元，
// 路徑有空白就不產生——樣板自己已經寫了引號，這裡再包一層就會壞掉。
// 樹開在系統暫存區（或 --dir 指定的地方）：要放在複審者的沙箱寫得進的地方（README 寫明 Codex 的沙箱准寫暫存區），突變副本放那裡它才改得到。
//
// ⚠️ 守不到的：
//   ①不擋也不驗：印出來之後有沒有照用、提示有沒有再被手改、複審者實際用的模型與推理（只有它自報）都看不到——F1、F3、F11 仍靠自覺；
//   ②印的事實是平台與 git 那一刻給的：之後又推了新版本，印出來的就過期（收樹時核 HEAD 沒變，但不會重新產生）；
//   ③風險級別只印分級腳本照檔案算的那一級；實作者往重調、裁示者改級，要自己改提示的風險級別與本輪範圍兩格（範圍照分級表跟著級別重查）；
//     快速通道（AI）（F12）照分級腳本判的結果把本輪範圍印成只核差異，「這一位連兩輪沒通過」只看平台上這一位貼的結論標頭；
//   ④「相關裁示」只列問在本支、配到的 ⚖️（判斷用待裁清單工具那一份），對話裡講過、沒貼留痕的列不到；
//   ⑤收樹只核兩棵樹（狀態不看被忽略的檔）；複審者在暫存區另建的東西只列出比開樹晚的第一層、不刪，也不保證列齊（別的程式同時寫的也會被列進來）。
// 退出碼：0＝做好了；1＝代貼結論或收樹時核到樹不乾淨、HEAD 變了或上了鎖而沒貼／沒收，或收到一半（要人看）；2＝做不了（設定沒填、平台問不到、git 出錯、路徑不安全、範本對不上、結論格式不對或已貼過、參數不對）。⚠️ 不是閘。
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { ask, PlatformError } = require('./platform.js');
const { read: readSettings } = require('./settings-data.js');
const { gitEnv } = require('./git-env.js');
const { parseInstant } = require('./time-point.js');
const { fieldValue, canonicalRole, rolesOf } = require('./gates/check-collab-fields.js');
const { headerOf, missingHeadings, PASS_HEADINGS, evaluate: evaluateVerdicts } = require('./gates/check-review-verdicts.js');
const { evaluate: evaluateRulings, deciderOf, rulingLink, readPart } = require('./pending-rulings.js');
const { run: riskRun, gitIn } = require('./risk-tier.js');

const UNSET = '未設定';
const TEMPLATE = path.join(__dirname, '..', 'templates', 'review-request.md');
const SCAN_TEMPLATE = path.join(__dirname, '..', 'templates', 'scan-record.md');
const FILE_SLOT = '<你寫好的結論檔>';
const USAGE = `用法：node tools/review-launch.js <變更編號> --reviewer <複審者識別值> [--run] [--purge] [--dir <放樹的資料夾>]
      獨立續審另加：--continue-blocker <原阻擋網址> --owner-question <本人原題網址> --owner-approval <本人批准網址>
      node tools/review-launch.js --post <變更編號> [--round <輪次>] [--expect-head <版本碼>] [--expect-started-at <ISO時間>] [--file <結論檔>] [--dir <放樹的資料夾>]
      node tools/review-launch.js --close <變更編號> [--round <輪次>] [--expect-head <版本碼>] [--expect-started-at <ISO時間>] [--purge] [--dir <放樹的資料夾>]
      node tools/review-launch.js --scan <變更編號> [--scanner <掃描者識別值>] [--tier <高|中|低>] [--run] [--purge] [--dir <放樹的資料夾>]
      node tools/review-launch.js --scan-post <變更編號> [--expect-head <版本碼>] [--expect-started-at <ISO時間>] [--file <回覆檔>] [--dir <放樹的資料夾>]
      node tools/review-launch.js --scan-close <變更編號> [--expect-head <版本碼>] [--expect-started-at <ISO時間>] [--purge] [--dir <放樹的資料夾>]`;
const TIER_ORDER = ['高', '中', '低'];

/** 範本裡每一格照出現順序要填什麼；null＝留給複審者。 */
const FILL = [
  ['<倉庫>', 'project'], ['<編號>', 'change'], ['<識別值>', 'reviewer'],
  ['<連結>', 'changeLink'], ['<完整版本碼>', 'head'], ['<短碼>', 'headShort'],
  ['<主幹分支名>', 'baseBranch'], ['<版本碼>', 'base'], ['<輪次>', 'round'],
  ['<高／中／低>', 'tier'], ['<照表算的／實作者調重的，理由一句／裁示者改的，附裁示連結>', 'tierWhy'],
  ['<全審／只核差異>', 'scope'], ['<留言連結；第 1 輪寫「沒有」>', 'previous'], ['<留言連結；沒有寫「沒有」>', 'rulings'],
  ['<路徑>', 'reviewTree'], ['<路徑>', 'mutationCopy'],
  ['<指令；照專案設定「複審者的模型與怎麼起」那一節或專案說明寫的>', 'copyTest'],
  ['<指令>', 'fullDiff'], ['<指令；第 1 輪寫「沒有」>', 'roundDiff'], ['<識別值>', 'implementer'],
  ['<版本碼>', 'base'],
  ['<來源字串>', 'source'], ['<識別值>', 'reviewer'], ['<來源字串>', 'source'], ['<短碼>', 'headShort'],
  ['<輪次>', 'round'], ['<三選一>', null], ['<貼留言的指令>', 'postComment'],
];
/** 掃描範本（templates/scan-record.md 分隔線 --- 之後）每一格照出現順序要填什麼。 */
const SCAN_FILL = [
  ['<倉庫>', 'project'], ['<編號>', 'change'], ['<識別值>', 'scanner'],
  ['<連結>', 'changeLink'], ['<完整版本碼>', 'head'], ['<短碼>', 'headShort'],
  ['<主幹分支名>', 'baseBranch'], ['<版本碼>', 'base'], ['<高／中／低>', 'tier'],
  ['<留言連結>', 'passCommentLink'], ['<路徑>', 'scanTree'], ['<指令>', 'fullDiff'],
  ['<識別值>', 'implementer'], ['<識別值>', 'reviewer'],
  ['<識別值>', 'scanner'], ['<來源字串>', 'source'],
  ['<識別值>', 'scanner'], ['<來源字串>', 'source'], ['<短碼>', 'headShort'],
];
const SLOT = /<[^<>\n]+>/gu;
const TOKEN = /\{([A-Za-z]+)\}/gu;
/** 替換進指令的值只收這些字元（含非 ASCII 字母數字，如中文模型與推理名）：不用加引號、殼也不會拆開或展開它。 */
const SAFE = /^[\p{L}\p{N}._/:@+=,-]+$/u;
const SCAN_HEADER = /^[^\S\n]*(?:\*\*|__)?[^\S\n]*🔍\s*([A-Za-z]+)｜來源：([^｜\n]+)｜掃\s*`?([0-9a-fA-F]{7,40})`?(?:\*\*|__)?\s*$/u;

class LaunchError extends Error {}

/** 範本「以下整段就是送出去的提示」那一段＝第一條整行只有 --- 的分隔線之後。找不到＝null。 */
function promptPart(template) {
  const lines = String(template).replace(/\r\n?/g, '\n').split('\n');
  const i = lines.indexOf('---');
  return i < 0 ? null : lines.slice(i + 1).join('\n').replace(/^\n+/u, '');
}

/** 照 table（預設 FILL）的順序把格子換成值。範本的格子跟表不是一一對上＝不產生（範本改了，產生器要一起改）。 */
function fill(template, values, table = FILL) {
  const part = promptPart(template);
  if (part === null) throw new LaunchError('範本找不到分隔線「---」：不知道哪一段是送出去的提示');
  const slots = part.match(SLOT) || [];
  const expected = table.map(([slot]) => slot);
  const bad = slots.findIndex((s, i) => s !== expected[i]);
  if (slots.length !== expected.length || bad >= 0) {
    const at = bad >= 0 ? bad : Math.min(slots.length, expected.length);
    throw new LaunchError(`範本的格子跟產生器的表對不上（範本 ${slots.length} 格、表 ${expected.length} 格；第 ${at + 1} 格範本是「${slots[at] || '（沒有）'}」、表是「${expected[at] || '（沒有）'}」）：範本改了，產生器要一起改`);
  }
  for (const [slot, key] of table) {
    if (key !== null && (values[key] === undefined || values[key] === null || String(values[key]).trim() === '')) throw new LaunchError(`「${slot}」那一格（${key}）沒有值`);
  }
  let i = 0;
  return part.replace(SLOT, (slot) => { const key = table[i++][1]; return key === null ? slot : String(values[key]); });
}

/** 把樣板裡的 {記號} 換成值；認不得的記號、值裡有不安全的字元＝不產生。 */
function substitute(template, values, what) {
  const used = [...new Set([...String(template).matchAll(TOKEN)].map((m) => m[1]))];
  const unknown = used.filter((t) => !Object.hasOwn(values, t));
  if (unknown.length) throw new LaunchError(`${what}裡有認不得的記號：${unknown.map((t) => `{${t}}`).join('、')}（認得的只有 ${Object.keys(values).map((t) => `{${t}}`).join('、')}）`);
  for (const t of used) {
    if (!SAFE.test(String(values[t]))) throw new LaunchError(`${what}要填進 {${t}} 的值「${values[t]}」有空白或殼會另外解讀的字元：樣板自己寫了引號，這裡不另加，所以不產生（換一個不含這些字元的 --dir）`);
  }
  return { text: String(template).replace(TOKEN, (_, t) => String(values[t])), used };
}

/**
 * 本輪全審還是只核差異（照複審與掃描分級表那一列）。讀不懂那一列、或兩格都中／都不中＝null（不猜）。
 * 上一輪這一位給的是「通過」＝這一輪是通過之後回頭改的那一輪，照 afterPassFix（F2）。
 */
function scopeOf(row, round, previousPassed) {
  if (!row) return null;
  if (previousPassed) return ['全審', '只核差異'].includes(row.afterPassFix) ? row.afterPassFix : null;
  const hit = (cell) => {
    if (cell === '每一輪') return true;
    if (cell === '不適用') return false;
    let m = /^第 (\d+)〜(\d+) 輪$/u.exec(cell);
    if (m) return round >= Number(m[1]) && round <= Number(m[2]);
    m = /^第 (\d+) 輪起$/u.exec(cell);
    if (m) return round >= Number(m[1]);
    return undefined;
  };
  const full = hit(row.full);
  const diff = hit(row.diffOnly);
  if (full === undefined || diff === undefined || full === diff) return null;
  return full ? '全審' : '只核差異';
}

/**
 * 這一位已經在這支貼過的結論：取輪次最大的那則（同輪次取晚貼的）；沒有＝第 1 輪。
 * 同一位＝角色和來源字串都一樣（F5；跟結論閘同一個讀法）：同一個角色換了來源就是另一位，它的輪次與通過不算這一位的（#49 r1 R2）。
 */
function roundsOf(comments, reviewer, source, roles) {
  const time = (c) => { const v = parseInstant(c.createdAt); return v === null ? -Infinity : v; };
  const want = String(source).trim().replace(/\s+/gu, ' ');
  const mine = comments.map((c) => ({ c, h: headerOf(c.body, roles) })).filter((x) => x.h && x.h.role === reviewer && x.h.source === want);
  if (!mine.length) return { round: 1, previous: null };
  const last = mine.reduce((a, b) => ((b.h.round > a.h.round || (b.h.round === a.h.round && time(b.c) > time(a.c))) ? b : a));
  return { round: last.h.round + 1, previous: last };
}

/**
 * 這一位（角色＋來源字串，跟 roundsOf 同一個讀法）在這一支有沒有連續兩輪都沒「通過」（F12：快速通道（AI）連兩輪沒過，改走一般流程）。
 * 每一輪算不算「通過」照結論閘的判法，不另寫一套（Codex #96 r1 R2）：把那一輪這一位貼的結論單獨交給結論閘看——
 * 缺固定小標的「通過」不算、同一輪相反結論或對不同版本各給結論＝衝突、算阻擋；那一輪沒有一則算數的「通過」＝沒過。輪次要相鄰。
 */
function twoMissesInARow(comments, reviewer, source, roles) {
  const want = String(source).trim().replace(/\s+/gu, ' ');
  const rounds = new Map();
  for (const c of comments) {
    const h = headerOf(c.body, roles);
    if (!h || h.role !== reviewer || h.source !== want) continue;
    if (!rounds.has(h.round)) rounds.set(h.round, []);
    rounds.get(h.round).push(c);
  }
  const passedIn = (k) => {
    const state = evaluateVerdicts(rounds.get(k), '', reviewer, roles).reviewers[`${reviewer}（${want}）`];
    return Boolean(state) && !state.blocking;
  };
  return [...rounds.keys()].some((k) => rounds.has(k + 1) && !passedIn(k) && !passedIn(k + 1));
}

const sourceKey = (source) => String(source).trim().replace(/\s+/gu, ' ');
const bodyHash = (body) => crypto.createHash('sha256').update(body, 'utf8').digest('hex');
const CONTINUATION_PURPOSE = 'independent-blocker-continuation-v1';

/**
 * 本人逐字批准只解鎖原身分的歷史續審用途，不把第二個審查者升成主審。
 * 同帳號不能證明人類授權語意或另一場次的獨立性；發審者仍須讀原題及原話、核全新原生場次。
 */
function continuationBinding(change, comments, reviewer, refs, settings) {
  if (!refs || Object.keys(refs).sort().join() !== 'approval,blocker,question'
      || Object.values(refs).some((v) => typeof v !== 'string' || !v)) {
    throw new LaunchError('獨立續審須明確給本人原題、本人批准及原阻擋網址');
  }
  const { usable } = rolesOf(settings);
  const primary = canonicalRole(fieldValue(change.body, '複審者'), usable);
  const implementer = canonicalRole(fieldValue(change.body, '實作者'), usable);
  const entry = settings.reviewers.find((r) => r.participant === reviewer);
  const primaryEntry = settings.reviewers.find((r) => r.participant === primary);
  if (!primary || !implementer || primary === reviewer || primary === implementer || !entry || !primaryEntry
      || !/^[0-9a-f]{40}$/u.test(change.headSha) || change.state !== 'OPEN') {
    throw new LaunchError('獨立續審須保留另一位指定主審、實作者及開啟中 PR 的完整 HEAD');
  }
  const project = settings.platform.project;
  const commentUrl = (id) => substitute(settings.reviewLaunch.commentLink,
    { project, change: change.id, comment: id }, '留言網址樣板').text;
  const original = (url) => {
    const found = comments.filter((c) => commentUrl(c.id) === url);
    if (found.length !== 1) throw new LaunchError('獨立續審原件不是同倉庫同 PR 的唯一留言');
    return found[0];
  };
  const question = original(refs.question);
  const approval = original(refs.approval);
  const blocker = original(refs.blocker);
  const ruled = evaluateRulings(comments.map((c) => ({ ...c, change: change.id })), deciderOf(settings), settings);
  const pair = ruled.ruled.find((r) => String(r.ask.id) === String(question.id) && String(r.by.id) === String(approval.id));
  const approvalPart = readPart(approval.body);
  // D1 的配對只認錨點；這裡另核第一個網址的整串，不能借別倉庫的同名編號。
  const firstUrl = /https?:\/\/[^\s)>，,、；;。｜|）\]`'"]+/iu.exec(approvalPart);
  const quotes = approvalPart.split('\n').filter((line) => line.startsWith('原話（對話中，'));
  const quote = quotes.length === 1 && /^原話（對話中，([^\s，（）]+) 轉述）：\*\*「(.+)」\*\*[ \t]*$/u.exec(quotes[0]);
  if (ruled.unsure || !pair || !pair.by.ownerRuling || !firstUrl || firstUrl[0] !== refs.question
      || !quote || !usable.includes(quote[1]) || quote[2] !== `同意追加獨立 ${reviewer} 續審（建議）`
      || !readPart(question.body).includes(`保留 ${primary} 主審`)
      || !readPart(question.body).includes(`獨立 ${reviewer} 續審`)) {
    throw new LaunchError('獨立續審本人原題／逐字批准／指定主審不配對；不可借其他裁示解鎖');
  }
  const header = headerOf(blocker.body, usable);
  const source = sourceKey(entry.source);
  if (!header || !header.blocking || header.role !== reviewer || header.source !== source) {
    throw new LaunchError('獨立續審原阻擋的角色或來源與正式登記不符');
  }
  const verdicts = evaluateVerdicts(comments, change.headSha, primary, usable,
    { ownerRole: canonicalRole(settings.owner, usable) });
  // 不重寫 F7 事件消解規則。只採原閘逐事件指出的未解阻擋；訊息契約漂移時拒絕，不猜。
  const unresolvedPrefix = `${reviewer}（${source}） 在 r${header.round}（審 ${header.sha}，留言 ${blocker.id}）的結論是「`;
  if (verdicts.unsure || !verdicts.problems.some((p) => p.startsWith(unresolvedPrefix))) {
    throw new LaunchError('指定原阻擋未被原結論閘列為仍未解除；不開放獨立續審');
  }
  const primaryState = verdicts.reviewers[`${primary}（${sourceKey(primaryEntry.source)}）`];
  if (!primaryState || primaryState.blocking || !change.headSha.startsWith(primaryState.sha)) {
    throw new LaunchError('獨立續審須先取得指定主審對當版的正式通過');
  }
  const snapshot = (c) => ({ id: String(c.id), author: c.author, createdAt: c.createdAt, bodySha256: bodyHash(c.body) });
  return {
    purpose: CONTINUATION_PURPOSE, project, change: String(change.id), refs,
    primary, implementer, reviewer, source, model: entry.strongest, effort: entry.maxEffort, command: entry.command,
    head: change.headSha, baseBranch: change.baseBranch, round: roundsOf(comments, reviewer, entry.source, usable).round,
    question: snapshot(question), approval: snapshot(approval), blocker: { ...snapshot(blocker), ...header },
  };
}

/** 收件時排除的只能是本場完整自貼候選，否則新通過本身會把原阻擋消掉而無法核原用途。 */
function recheckContinuation(rec, change, comments, prepared, allowAlreadyPosted, settings, requireCandidate = false) {
  const binding = rec.continuation;
  if (!binding || binding.purpose !== CONTINUATION_PURPOSE) throw new LaunchError('獨立續審用途紀錄缺失或不明');
  const session = continuationSession(rec);
  if (parseInstant(rec.startedAt) === null || JSON.stringify(session) !== JSON.stringify(binding.session)) {
    throw new LaunchError('獨立續審基底、場次時間或路徑綁定已變；不收件');
  }
  const { usable } = rolesOf(settings);
  const candidates = comments.filter((c) => {
    const h = headerOf(c.body, usable);
    return h && h.role === rec.reviewer && h.source === binding.source && h.round === rec.round;
  });
  if (requireCandidate && candidates.length !== 1) throw new LaunchError('獨立續審貼後尚無唯一完整平台結論；保留現場，不記收據');
  let history = comments;
  if (candidates.length) {
    if (!allowAlreadyPosted || candidates.length !== 1 || !prepared
        || candidates[0].body !== prepared.body
        || !(parseInstant(candidates[0].createdAt) > parseInstant(rec.startedAt))) {
      throw new LaunchError('獨立續審自貼不是本場唯一、啟動後且完整正文一致的候選');
    }
    history = comments.filter((c) => c !== candidates[0]);
  }
  const actual = continuationBinding(change, history, rec.reviewer, binding.refs, settings);
  const facts = { ...binding };
  delete facts.session;
  if (JSON.stringify(actual) !== JSON.stringify(facts) || actual.round !== rec.round || actual.head !== rec.head) {
    throw new LaunchError('獨立續審原件、身分、來源、設定、HEAD 或輪次已變；不收件');
  }
}

function continuationSession(rec) {
  return Object.fromEntries(['base', 'root', 'tree', 'mutation', 'promptFile', 'outFile', 'startedAt'].map((k) => [k, rec[k]]));
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' });
  if (r.error) throw new LaunchError(`git 起不來：${r.error.message}`);
  if (r.status !== 0) throw new LaunchError(`git ${args.join(' ')} 退 ${r.status === null ? '（被殺掉）' : r.status}：${(r.stderr || '').trim() || '（沒有訊息）'}`);
  return r.stdout.trim();
}
/** 標頭裡的短碼展開成完整版本碼；本機沒有那一顆就照原樣（差異指令照樣跑得出錯誤，給複審者看見）。 */
const fullSha = (root, short) => (gitOk(root, ['rev-parse', '--verify', '--quiet', `${short}^{commit}`]) ? git(root, ['rev-parse', '--verify', `${short}^{commit}`]) : short);
const gitOk = (cwd, args) => { const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' }); return !r.error && r.status === 0; };

/** 放樹的資料夾取實體路徑（暫存區常經過連結，例如 /var → /private/var）：印出來的、寫進紀錄的、git 登記的都是同一個字串。 */
function realDir(d) {
  try { return fs.realpathSync(path.resolve(d)); } catch (e) { throw new LaunchError(`放樹的資料夾 ${d} 不在或讀不到（${e.code || e.message}）`); }
}
const filled = (v) => typeof v === 'string' && v.trim() !== '' && v !== UNSET;
const slugOf = (project) => String(project).replace(/[^A-Za-z0-9._-]/gu, '-');
const folderRe = (slug, id) => new RegExp(`^review-${slug.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-${id}-r(\\d+)$`, 'u');

const scanFolderRe = (slug, id) => new RegExp(`^scan-${slug.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-${id}$`, 'u');

function askPlatform(platform, settings, op, args) {
  try { return platform.ask(op, args, { settings }); } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) throw new LaunchError(`問不到平台（${op}：${e.message}）`);
    throw e;
  }
}

/** 啟動指令樣板認得的記號（launch 裡 tokens 那一張，順序無關）。 */
const COMMAND_TOKENS = ['model', 'effort', 'reviewTree', 'mutationCopy', 'promptFile', 'outFile', 'change', 'project'];
const SCAN_COMMAND_TOKENS = ['model', 'effort', 'scanTree', 'promptFile', 'outFile', 'change', 'project'];
/** 設定裡填了的樣板逐一核：登記了的複審者與掃描者格位都有、記號都認得、啟動指令帶著模型、推理與工作樹路徑。回問題清單；沒登記的不核（新專案還沒填）。 */
function templateProblems(settings) {
  const out = [];
  const tokensOf = (t) => [...String(t).matchAll(TOKEN)].map((m) => m[1]);
  for (const r of Array.isArray(settings.reviewers) ? settings.reviewers : []) {
    if (!r || !filled(r.participant)) continue;
    // 登記了一位複審者，產生器就要得到它的來源字串與啟動樣板（設定形狀那題對陣列只看「是陣列」，少一格看不出來）
    for (const k of ['source', 'command']) if (!filled(r[k])) out.push(`「${r.participant}」的 ${k} 還沒填`);
    if (!filled(r.command)) continue;
    const used = tokensOf(r.command);
    const bad = used.filter((t) => !COMMAND_TOKENS.includes(t));
    if (bad.length) out.push(`「${r.participant}」的啟動指令樣板有認不得的記號：${bad.join('、')}`);
    for (const t of ['model', 'effort', 'reviewTree']) if (!used.includes(t)) out.push(`「${r.participant}」的啟動指令樣板沒帶 {${t}}`);
    const scanCmd = filled(r.scanCommand) ? r.scanCommand : deriveScanCommand(r.command);
    const scanUsed = tokensOf(scanCmd);
    const scanBad = scanUsed.filter((t) => !SCAN_COMMAND_TOKENS.includes(t));
    if (scanBad.length) out.push(`「${r.participant}」轉換後的掃描啟動指令樣板有認不得的記號：${scanBad.join('、')}`);
    for (const t of ['model', 'effort', 'scanTree']) if (!scanUsed.includes(t)) out.push(`「${r.participant}」轉換後的掃描啟動指令樣板沒帶 {${t}}`);
  }
  const sc = settings.scanner || {};
  if (((filled(sc.participant) && sc.participant.trim() !== '無') || filled(sc.command)) && sc.tool !== '無') {
    for (const k of ['participant', 'strongest', 'maxEffort', 'source', 'command']) {
      if (!filled(sc[k])) out.push(`scanner.${k} 還沒填`);
    }
    if (filled(sc.command)) {
      const used = tokensOf(sc.command);
      const bad = used.filter((t) => !SCAN_COMMAND_TOKENS.includes(t));
      if (bad.length) out.push(`scanner.command 有認不得的記號：${bad.join('、')}`);
      for (const t of ['model', 'effort', 'scanTree']) if (!used.includes(t)) out.push(`scanner.command 沒帶 {${t}}`);
    }
  }
  const rl = settings.reviewLaunch || {};
  const allow = { changeLink: ['project', 'change'], commentLink: ['project', 'change', 'comment'], postComment: ['project', 'change'], copyTest: ['mutationCopy'] };
  for (const [k, ok] of Object.entries(allow)) {
    if (!filled(rl[k])) continue;
    const bad = tokensOf(rl[k]).filter((t) => !ok.includes(t));
    if (bad.length) out.push(`reviewLaunch.${k} 有認不得的記號：${bad.join('、')}（只認 ${ok.join('、')}）`);
  }
  return out;
}

/** 產生：所有平台與設定的事先問完、核完，才動 git 與磁碟（中途失敗不留半套樹）。 */
function launch(changeArg, reviewerArg, { settings = readSettings(), platform = { ask }, cwd = process.cwd(), dir: dirArg = os.tmpdir(), template = null, now = () => new Date(), continuation = null } = {}) {
  const dir = realDir(dirArg);
  const { usable } = rolesOf(settings);
  const reviewer = canonicalRole(reviewerArg, usable);
  if (!reviewer) throw new LaunchError(`--reviewer 給的「${reviewerArg || ''}」不是登記過的參與者（${usable.join('／') || '一個都沒登記'}）`);
  const entry = (Array.isArray(settings.reviewers) ? settings.reviewers : []).find((r) => r && r.participant === reviewer);
  if (!entry) throw new LaunchError(`專案設定的 reviewers 沒有「${reviewer}」那一列：不知道它用什麼模型、怎麼起`);
  for (const k of ['strongest', 'maxEffort', 'autoMode', 'source', 'command']) {
    if (!filled(entry[k])) throw new LaunchError(`專案設定裡「${reviewer}」那一列的 ${k} 還沒填`);
  }
  const rl = settings.reviewLaunch || {};
  for (const k of ['changeLink', 'commentLink', 'postComment', 'copyTest']) {
    if (!filled(rl[k])) throw new LaunchError(`專案設定的 reviewLaunch.${k} 還沒填`);
  }
  const project = settings.platform && settings.platform.project;
  if (!filled(project)) throw new LaunchError('專案設定的 platform.project 還沒填');
  const used = new Set([...entry.command.matchAll(TOKEN)].map((m) => m[1]));
  if (!used.has('model') || !used.has('effort') || !used.has('reviewTree')) throw new LaunchError(`「${reviewer}」的啟動指令樣板沒帶 {model}、{effort} 或 {reviewTree}：漏帶時複審者照預設跑或不在審查樹目錄下執行（F1、F11）`);
  const decider = deciderOf(settings);
  if (!decider) throw new LaunchError('專案設定裡的裁示者識別值或貼文帳號未填或不唯一（也請核對 owner）；修正 settings.json 後重跑：算不出相關裁示');
  const tpl = template === null ? fs.readFileSync(TEMPLATE, 'utf8') : template;

  const change = askPlatform(platform, settings, 'change', { change: String(changeArg) });
  const id = change.id;
  const head = change.headSha;
  const named = canonicalRole(fieldValue(change.body, '複審者'), usable);
  if (named !== reviewer && continuation === null) throw new LaunchError(`PR說明的「複審者」欄是「${named || '讀不出'}」，不是 ${reviewer}：這一輪的通過不會算數（F5 只認說明裡指定的那一位）`);
  const implementer = canonicalRole(fieldValue(change.body, '實作者'), usable);
  if (!implementer) throw new LaunchError('PR說明的「實作者」欄讀不出一位登記過的參與者');
  const base = askPlatform(platform, settings, 'branchSha', { branch: change.baseBranch }).sha;
  const comments = askPlatform(platform, settings, 'comments', { change: id });
  const binding = continuation === null ? null : continuationBinding(change, comments, reviewer, continuation, settings);
  const all = askPlatform(platform, settings, 'allComments', {});
  const rulings = evaluateRulings(all, decider, settings);
  if (rulings.unsure) throw new LaunchError(`相關裁示算不出來（${rulings.unsure}）`);
  // 先 fetch 再算風險：判「快速通道（AI）」要讀本機 git 的主幹與受審版本（F12），沒 fetch 會因為找不到版本而判成不走
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const fetched = gitOk(root, ['fetch', '--quiet']);
  const risk = riskRun(id, { settings, platform, git: gitIn(root) });
  if (risk.code !== 0) throw new LaunchError(`風險級別算不出來：${risk.lines.join(' ')}`);
  // 風險級別要是受審那一版的：產生提示的這幾秒裡有人推了新版本，算出來的級別與範圍就屬於另一版——拒絕、要求重跑（理財 #672 r3）
  if (risk.result.head !== head) throw new LaunchError(`產生送審提示期間這一支換了版本（受審 ${String(head).slice(0, 12)}，算風險時是 ${String(risk.result.head).slice(0, 12)}）：審查樹與風險範圍會對不上，重跑一次`);
  const tier = risk.result.level;
  const { round, previous } = roundsOf(comments, reviewer, entry.source, usable);
  // 上一輪算不算「通過」照結論閘的判斷，不另寫一套：缺固定小標的通過不算（F7；#49 r1 R3），同一輪相反結論或對不同版本各給結論＝衝突、算阻擋（#49 r2 R1）。
  // 閘合併後這一位最新的有效狀態要正好是最近貼的那一輪、而且不是阻擋，才照「通過後回頭改」那一格縮範圍。
  const verdicts = evaluateVerdicts(comments, head, reviewer, usable);
  if (verdicts.unsure) throw new LaunchError('這一支有結論留言的時間讀不出來：上一輪判不了');
  const state = previous ? verdicts.reviewers[`${reviewer}（${previous.h.source}）`] : null;
  const passed = Boolean(state) && !state.blocking && state.round === previous.h.round;
  // 快速通道（AI）（F12）：第 1 輪起只核差異；這一位連兩輪沒「通過」，這一輪起照這一級走一般流程
  const lane = risk.result.fastLaneAI === true;
  const exhausted = lane && twoMissesInARow(comments, reviewer, entry.source, usable);
  const scope = binding ? '全審' : lane && !exhausted ? '只核差異' : scopeOf((settings.reviewTiers || {})[tier], round, passed);
  if (!scope) throw new LaunchError(`複審與掃描分級表「${tier}」那一列讀不出第 ${round} 輪該全審還是只核差異`);
  const tierWhy = binding ? '照表算的；本人批准的獨立歷史阻擋續審強制全審' : !lane ? '照表算的'
    : exhausted ? '照表算的；這一支原本走快速通道（AI），這一位已經連兩輪沒「通過」，這一輪起照這一級走一般流程（F12）'
      : '照表算的；分級腳本判這一支走快速通道（AI）：第 1 輪起只核差異、不掃描（F12）';
  const commentLink = (changeId, comment) => substitute(rl.commentLink, { project, change: changeId, comment }, '留言網址樣板').text;
  const related = rulings.ruled.filter((x) => String(x.ask.change) === String(id)).map((x) =>
    rulingLink(x.by, commentLink(x.by.change, x.by.id)));
  if (binding) related.push(`本人原題 ${binding.refs.question}；本人批准 ${binding.refs.approval}；原阻擋 ${binding.refs.blocker}；保留 ${binding.primary} 主審，${reviewer} 獨立續審（人工核原話語意及全新場次）`);

  for (const [what, sha] of [['受審版本', head], ['基底', base]]) {
    if (!gitOk(root, ['cat-file', '-e', `${sha}^{commit}`])) throw new LaunchError(`本機倉庫沒有${what} ${sha}${fetched ? '' : '（git fetch 也沒成功）'}：開不了樹`);
  }
  const folder = path.join(dir, `review-${slugOf(project)}-${id}-r${round}`);
  const tree = path.join(folder, 'tree');
  const mutation = path.join(folder, 'mutation');
  const promptFile = path.join(folder, 'prompt.md');
  const outFile = path.join(folder, 'output.log');
  const tokens = { model: entry.strongest, effort: entry.maxEffort, reviewTree: tree, mutationCopy: mutation, promptFile, outFile, change: id, project };
  if (Object.keys(tokens).sort().join() !== [...COMMAND_TOKENS].sort().join()) throw new Error('COMMAND_TOKENS 跟這一張對不上（程式寫錯）');
  const command = substitute(entry.command, tokens, `「${reviewer}」的啟動指令樣板`).text;
  const values = {
    project, change: id, reviewer, implementer, source: entry.source, head, headShort: head.slice(0, 7), baseBranch: change.baseBranch, base, round,
    changeLink: substitute(rl.changeLink, { project, change: id }, 'PR 網址樣板').text,
    tier, tierWhy, scope,
    previous: previous ? commentLink(id, previous.c.id) : '沒有',
    rulings: related.length ? related.join('、') : '沒有',
    reviewTree: tree, mutationCopy: mutation,
    copyTest: substitute(rl.copyTest, { mutationCopy: mutation }, '副本跑考題指令').text,
    fullDiff: `git diff ${base}...${head}`,
    roundDiff: previous ? `git diff ${fullSha(root, previous.h.sha)}..${head}` : '沒有',
    postComment: substitute(rl.postComment, { project, change: id }, '貼結論的指令').text,
  };
  const prompt = fill(tpl, values);
  if (fs.existsSync(folder)) throw new LaunchError(`${folder} 已經在了：上一次的樹還沒收（先跑 --close ${id}），或這一輪已經送過`);

  const record = { change: id, reviewer, round, head, base, root, tree, mutation, promptFile, outFile, startedAt: now().toISOString() };
  if (binding) record.continuation = { ...binding, session: continuationSession(record) };
  const before = new Set(lockedTrees(root).keys());
  // 排他地建（不帶 recursive：已經在就丟 EEXIST）：上面那一次檢查跟這裡之間，另一個送審可能剛好建好同一輪的資料夾；
  // 帶 recursive 會接受別人的資料夾，下面開樹失敗時再把它整個刪掉（理財 #672 r4 第 1 條）。建成的才是自己的，失敗才收。
  try { fs.mkdirSync(folder); } catch (e) {
    if (e && e.code === 'EEXIST') throw new LaunchError(`${folder} 已經在了：另一個送審剛好在開同一輪，或上一次的樹還沒收（先跑 --close ${id}）`);
    throw e;
  }
  const created = [];
  try {
    git(root, ['worktree', 'add', '--detach', '-q', tree, head]);
    created.push(tree);
    git(root, ['worktree', 'add', '--detach', '-q', mutation, head]);
    created.push(mutation);
    for (const t of [tree, mutation]) {
      const got = git(t, ['rev-parse', 'HEAD']);
      if (got !== head) throw new LaunchError(`${t} 開出來是 ${got}，不是受審版本 ${head}`);
    }
    linkNodeModules(root, folder, [tree, mutation], record);
    try {
      fs.writeFileSync(promptFile, prompt);
      fs.writeFileSync(path.join(folder, 'launch.json'), `${JSON.stringify(record, null, 1)}\n`);
    } catch (writeErr) {
      throw new LaunchError(`寫入送審提示或紀錄失敗：${(writeErr && writeErr.message) || '不明錯誤'}`);
    }
  } catch (e) {
    // 開到一半失敗：只收這一次自己開的樹與資料夾，不留半套（下一次才不會被「已經在了」或「已登記但不見了」擋住）。
    // 「這一次開的」＝開樹前沒有、現在登記在這個資料夾底下的每一棵：也收得到 git worktree add 已經建好樹、
    // 卻因為掛鉤失敗而退非零的那一棵（#49 r2 R2）；開樹前就登記著的（就算路徑在這底下）不是這一次的，不動。
    // 不用整個倉庫的 git worktree prune：別棵暫時不在原位的樹（例如外接碟沒接上）會被一起清掉登記與索引（#49 r1 R1）
    let registered = created;
    try { registered = [...lockedTrees(root).keys()].filter((t) => t.startsWith(`${folder}${path.sep}`) && !before.has(t)); } catch { /* 讀不到登記就只收確定開成的那幾棵 */ }
    for (const t of new Set([...created, ...registered])) {
      unlinkNodeModules(t, record);
      gitOk(root, ['worktree', 'remove', '--force', t]);
    }
    fs.rmSync(folder, { recursive: true, force: true });
    throw e;
  }
  const lines = [
    `送審產生器｜變更 ${id}｜複審者 ${reviewer}（來源 ${entry.source}）｜r${round}｜受審 ${head.slice(0, 7)}｜基底 ${change.baseBranch} 的 ${base.slice(0, 7)}`,
    `  風險級別：${tier}（${!binding && lane && !exhausted
      ? '照表算的；這一支走快速通道（AI）：本輪範圍照 F12 只核差異、不照分級表，往重調或裁示者改級只改風險級別那一格'
      : '照表算的；要往重調或裁示者改級，提示的風險級別與本輪範圍兩格要一起照分級表改'}）；本輪範圍：${scope}`,
    binding ? `  用途：獨立歷史阻擋續審；保留 ${binding.primary} 主審，本輪強制全審。人工須核原話語意、獨立性及原生模型證據。` : lane ? `  快速通道（AI）：${exhausted ? '這一位已經連兩輪沒「通過」，這一輪起照這一級走一般流程（要掃的照 G1 掃）' : '分級腳本判可以，這一輪只核差異、不掃描'}（F12）` : null,
    `  上一輪的結論：${values.previous}；相關裁示：${values.rulings}`,
    `  審查樹：${tree}（HEAD ${head.slice(0, 7)}）`,
    `  突變副本：${mutation}（HEAD ${head.slice(0, 7)}）`,
    `  送審提示：${promptFile}（照 templates/review-request.md 填好，只留 <三選一> 給複審者）`,
    fetched ? null : '  ⚠️ git fetch 沒成功：本機已經有這兩顆版本，照樣開了樹。',
    `啟動指令（模型 ${entry.strongest}、推理 ${entry.maxEffort}；不開的自動模式：${entry.autoMode}）：`,
    command,
    `跑完：退出碼 0 不代表通過、也不代表結論已經貼上去——若複審者只輸出純文字結論（或文末寫「未貼」），跑 node tools/review-launch.js --post ${id}${dir === realDir(os.tmpdir()) ? '' : ` --dir ${dir}`} 先核樹與標頭再代貼；再跑查複審結論的那道閘、看它印的現況（F7）。審完收樹：node tools/review-launch.js --close ${id}${dir === realDir(os.tmpdir()) ? '' : ` --dir ${dir}`}`,
  ].filter((l) => l !== null);
  return { code: 0, lines, record, command, prompt };
}

/** 這個倉庫登記的每一棵樹 → 有沒有上鎖（git worktree list --porcelain；路徑照登記的原字串）。 */
function lockedTrees(root) {
  const out = new Map();
  let cur = null;
  for (const l of git(root, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (l.startsWith('worktree ')) { cur = l.slice(9); out.set(cur, false); } else if (cur && (l === 'locked' || l.startsWith('locked '))) out.set(cur, true);
  }
  return out;
}

function nativeRealpath(p) {
  return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

function isInsideDir(childPath, parentDir) {
  const rel = path.relative(parentDir, childPath);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function getGitManagementDirs(worktreeReal) {
  const concatRaw = (baseDir, rawTarget) => (
    rawTarget.startsWith(path.sep)
      ? rawTarget
      : `${baseDir.replace(/\/+$/u, '')}${path.sep}${rawTarget}`
  );
  const dotGitPath = path.join(worktreeReal, '.git');
  const dirs = [dotGitPath];
  const addDir = (d) => {
    if (d && !dirs.includes(d)) dirs.push(d);
  };
  let realDotGit;
  let st;
  try {
    realDotGit = nativeRealpath(dotGitPath);
    st = fs.statSync(realDotGit);
  } catch (e) {
    throw new LaunchError(`無法辨識工作樹的 .git 管理目錄（${dotGitPath}）：${(e && e.message) || '讀不到目標'}，拒絕啟動`);
  }
  addDir(realDotGit);

  let realGitDir;
  if (st.isFile()) {
    let content;
    try {
      content = fs.readFileSync(realDotGit, 'utf8');
    } catch (e) {
      throw new LaunchError(`無法讀取工作樹的 .git 檔案（${realDotGit}）：${(e && e.message) || '不明錯誤'}，拒絕啟動`);
    }
    const m = content.match(/^gitdir:\s*(.+)$/mu);
    if (!m || !m[1].trim()) {
      throw new LaunchError(`工作樹 .git 檔案缺少有效的 gitdir 設定（${realDotGit}），拒絕啟動`);
    }
    const gitDirSpec = m[1].trim();
    const rawGitDir = concatRaw(worktreeReal, gitDirSpec);
    try {
      realGitDir = nativeRealpath(rawGitDir);
      if (!fs.statSync(realGitDir).isDirectory()) {
        throw new Error('gitdir 不是資料夾');
      }
    } catch (e) {
      throw new LaunchError(`無法解析工作樹的 gitdir（${rawGitDir}）：${(e && e.message) || '讀不到目標'}，拒絕啟動`);
    }
    addDir(realGitDir);
  } else if (st.isDirectory()) {
    realGitDir = realDotGit;
  } else {
    throw new LaunchError(`工作樹的 .git 型別無效（${dotGitPath}），拒絕啟動`);
  }

  const commonFile = path.join(realGitDir, 'commondir');
  let commonLst = null;
  try {
    commonLst = fs.lstatSync(commonFile);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') {
      throw new LaunchError(`無法檢查工作樹的 commondir（${commonFile}）：${(e && e.message) || '不明錯誤'}，拒絕啟動`);
    }
  }
  if (commonLst) {
    let commonSpec;
    try {
      commonSpec = fs.readFileSync(commonFile, 'utf8').trim();
    } catch (e) {
      throw new LaunchError(`無法讀取工作樹的 commondir（${commonFile}）：${(e && e.message) || '不明錯誤'}，拒絕啟動`);
    }
    if (!commonSpec) {
      throw new LaunchError(`工作樹的 commondir 內容為空（${commonFile}），拒絕啟動`);
    }
    const rawCommon = concatRaw(realGitDir, commonSpec);
    let realCommon;
    try {
      realCommon = nativeRealpath(rawCommon);
      if (!fs.statSync(realCommon).isDirectory()) {
        throw new Error('commondir 不是資料夾');
      }
    } catch (e) {
      throw new LaunchError(`無法解析工作樹的 commondir（${rawCommon}）：${(e && e.message) || '讀不到目標'}，拒絕啟動`);
    }
    addDir(realCommon);
  }

  if (!gitOk(worktreeReal, ['rev-parse', '--git-dir', '--git-common-dir'])) {
    throw new LaunchError(`Git 無法辨識工作樹的 git-dir／git-common-dir（${worktreeReal}），拒絕啟動`);
  }
  const revLines = git(worktreeReal, ['rev-parse', '--git-dir', '--git-common-dir'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (revLines.length < 2) {
    throw new LaunchError(`Git 回傳的 git-dir／git-common-dir 不完整（${worktreeReal}），拒絕啟動`);
  }
  for (const line of revLines) {
    const rawRev = concatRaw(worktreeReal, line);
    let realRev;
    try {
      realRev = nativeRealpath(rawRev);
      if (!fs.statSync(realRev).isDirectory()) {
        throw new Error('不是資料夾');
      }
    } catch (e) {
      throw new LaunchError(`無法解析 Git 回報的管理目錄（${rawRev}）：${(e && e.message) || '讀不到目標'}，拒絕啟動`);
    }
    addDir(realRev);
  }
  return dirs;
}

function isGitManagementPath(candidatePath, worktreeReal, gitDirs = getGitManagementDirs(worktreeReal)) {
  for (const g of gitDirs) {
    if (candidatePath === g || isInsideDir(candidatePath, g)) return true;
  }
  const rel = path.relative(worktreeReal, candidatePath);
  if (rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
    if (rel.split(path.sep).includes('.git')) return true;
  }
  return false;
}

function resolveKernelPathInBoundary(startDirReal, rawPath, boundaryReal, { dotGitPath = null, topNodeModules = null } = {}) {
  const gitDirs = dotGitPath ? getGitManagementDirs(boundaryReal) : [];
  if (dotGitPath && !gitDirs.includes(dotGitPath)) gitDirs.push(dotGitPath);
  const isDotGit = (p) => gitDirs.length > 0 && isGitManagementPath(p, boundaryReal, gitDirs);
  let curDir = rawPath.startsWith(path.sep) ? path.sep : startDirReal;
  let enteredBoundary = !rawPath.startsWith(path.sep) && isInsideDir(curDir, boundaryReal);
  const queue = rawPath.split(path.sep).filter(Boolean);
  let hops = 0;
  const checkStep = (p) => {
    if (enteredBoundary) {
      if (!isInsideDir(p, boundaryReal)) {
        const err = new Error(`ESCAPED_BOUNDARY:${p}`);
        err.escapePath = p;
        throw err;
      }
    } else if (isInsideDir(p, boundaryReal)) {
      enteredBoundary = true;
    } else if (!isInsideDir(boundaryReal, p)) {
      const err = new Error(`ESCAPED_BOUNDARY:${p}`);
      err.escapePath = p;
      throw err;
    }
    if (enteredBoundary) {
      if (isDotGit(p)) {
        const err = new Error(`ESCAPED_DOTGIT:${p}`);
        err.escapePath = p;
        throw err;
      }
      if (topNodeModules && (p === topNodeModules || isInsideDir(p, topNodeModules))) {
        const err = new Error(`ESCAPED_TOP_NM:${p}`);
        err.escapePath = p;
        throw err;
      }
    }
  };
  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === '.') continue;
    if (seg === '..') {
      curDir = path.dirname(curDir);
      checkStep(curDir);
      continue;
    }
    const candidate = path.join(curDir, seg);
    let lst;
    try {
      lst = fs.lstatSync(candidate);
    } catch {
      const err = new Error(`ENOENT:${candidate}`);
      if (!enteredBoundary) {
        err.escapePath = path.join(candidate, ...queue);
      } else {
        err.missing = true;
      }
      throw err;
    }
    if (lst.isSymbolicLink()) {
      hops += 1;
      if (hops > 40) {
        const err = new Error('符號連結循環');
        err.loop = true;
        throw err;
      }
      const target = fs.readlinkSync(candidate);
      if (target.startsWith(path.sep)) {
        curDir = path.sep;
        enteredBoundary = false;
      }
      queue.unshift(...target.split(path.sep).filter(Boolean));
    } else {
      curDir = nativeRealpath(candidate);
      checkStep(curDir);
    }
  }
  const fullPath = rawPath.startsWith(path.sep) ? rawPath : `${startDirReal.replace(/\/+$/u, '')}${path.sep}${rawPath}`;
  const kernelFinal = nativeRealpath(fullPath);
  if (!enteredBoundary || curDir !== kernelFinal || !isInsideDir(kernelFinal, boundaryReal)) {
    const err = new Error(`ESCAPED_BOUNDARY:${kernelFinal}`);
    err.escapePath = kernelFinal;
    throw err;
  }
  if (isDotGit(kernelFinal)) {
    const err = new Error(`ESCAPED_DOTGIT:${kernelFinal}`);
    err.escapePath = kernelFinal;
    throw err;
  }
  if (topNodeModules && (kernelFinal === topNodeModules || isInsideDir(kernelFinal, topNodeModules))) {
    const err = new Error(`ESCAPED_TOP_NM:${kernelFinal}`);
    err.escapePath = kernelFinal;
    throw err;
  }
  let jsFinal;
  try {
    jsFinal = fs.realpathSync(fullPath);
  } catch {
    jsFinal = null;
  }
  if (jsFinal !== null && jsFinal !== kernelFinal) {
    if (
      !isInsideDir(jsFinal, boundaryReal)
      || isDotGit(jsFinal)
      || (topNodeModules && (jsFinal === topNodeModules || isInsideDir(jsFinal, topNodeModules)))
    ) {
      const err = new Error(`ESCAPED_BOUNDARY:${jsFinal}`);
      err.escapePath = jsFinal;
      throw err;
    }
  }
  return kernelFinal;
}

function traceSymlinkInSource(startDirReal, entryName, sourceDir, sourceWorktree) {
  const gitDirs = getGitManagementDirs(sourceWorktree);
  const isDotGit = (p) => isGitManagementPath(p, sourceWorktree, gitDirs);
  const isAllowed = (p) => isInsideDir(p, sourceDir) || isInsideDir(p, sourceWorktree);
  const isAncestorOfAllowed = (p) => isInsideDir(sourceDir, p) || isInsideDir(sourceWorktree, p);
  let curDir = startDirReal;
  let enteredAllowed = true;
  let wsRawRelTarget = null;
  const queue = [entryName];
  let hops = 0;

  const recordStep = (p) => {
    if (enteredAllowed) {
      if (!isAllowed(p)) {
        const err = new Error(`OUTSIDE_WORKTREE:${p}`);
        err.escapePath = p;
        throw err;
      }
    } else if (isAllowed(p)) {
      enteredAllowed = true;
    } else if (!isAncestorOfAllowed(p)) {
      const err = new Error(`OUTSIDE_WORKTREE:${p}`);
      err.escapePath = p;
      throw err;
    }
    if (enteredAllowed && isDotGit(p)) {
      const err = new Error(`OUTSIDE_WORKTREE:${p}`);
      err.escapePath = p;
      throw err;
    }
    if (enteredAllowed && isInsideDir(p, sourceWorktree) && !isInsideDir(p, sourceDir) && wsRawRelTarget === null) {
      const nextSeg = queue.find((s) => s !== '.');
      if (isInsideDir(sourceDir, p) && nextSeg) {
        const nextCandidate = path.join(p, nextSeg);
        if (isInsideDir(nextCandidate, sourceDir) || isInsideDir(sourceDir, nextCandidate)) {
          return;
        }
      }
      const relFromWt = path.relative(sourceWorktree, p);
      wsRawRelTarget = [relFromWt, ...queue].filter(Boolean).join(path.sep);
    }
  };

  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === '.') continue;
    if (seg === '..') {
      curDir = path.dirname(curDir);
      recordStep(curDir);
      continue;
    }
    const candidate = path.join(curDir, seg);
    let lst;
    try {
      lst = fs.lstatSync(candidate);
    } catch {
      const err = new Error(`BROKEN:${candidate}`);
      if (!enteredAllowed) {
        err.escapePath = path.join(candidate, ...queue);
      } else {
        err.broken = true;
      }
      throw err;
    }
    if (lst.isSymbolicLink()) {
      hops += 1;
      if (hops > 40) {
        const err = new Error(`ELOOP:${candidate}`);
        err.broken = true;
        throw err;
      }
      const target = fs.readlinkSync(candidate);
      if (target.startsWith(path.sep)) {
        curDir = path.sep;
        enteredAllowed = false;
      }
      queue.unshift(...target.split(path.sep).filter(Boolean));
    } else {
      curDir = nativeRealpath(candidate);
      recordStep(curDir);
    }
  }
  const fullPath = `${startDirReal.replace(/\/+$/u, '')}${path.sep}${entryName}`;
  const realTarget = nativeRealpath(fullPath);
  if (!enteredAllowed || curDir !== realTarget || !isAllowed(realTarget) || realTarget === sourceWorktree || isDotGit(realTarget)) {
    const err = new Error(`OUTSIDE_WORKTREE:${realTarget}`);
    err.escapePath = realTarget;
    throw err;
  }
  let jsTarget;
  try {
    jsTarget = fs.realpathSync(fullPath);
  } catch {
    jsTarget = null;
  }
  if (jsTarget !== null && jsTarget !== realTarget) {
    if (!isAllowed(jsTarget) || jsTarget === sourceWorktree || isDotGit(jsTarget)) {
      const err = new Error(`OUTSIDE_WORKTREE:${jsTarget}`);
      err.escapePath = jsTarget;
      throw err;
    }
  }
  return { realTarget, wsRawRelTarget };
}

function isRegisteredMainWorktreeNodeModulesLink(linkPath, realWt, mainWt, realMainWt) {
  if (!mainWt || !realMainWt || realWt === realMainWt) return false;
  if (
    gitOk(realWt, ['ls-files', '--error-unmatch', '--', 'node_modules'])
    || gitOk(realWt, ['cat-file', '-e', 'HEAD:node_modules'])
  ) {
    return false;
  }
  try {
    const lst = fs.lstatSync(linkPath);
    if (!lst.isSymbolicLink()) return false;
    const trimmed = String(fs.readlinkSync(linkPath) || '').replace(/[\\/]+$/u, '');
    if (!trimmed || path.basename(trimmed) !== 'node_modules') return false;
    const parentSpec = path.dirname(trimmed);
    let commonAnc = realWt;
    while (
      commonAnc !== path.dirname(commonAnc)
      && commonAnc !== realMainWt
      && !isInsideDir(realMainWt, commonAnc)
    ) {
      commonAnc = path.dirname(commonAnc);
    }
    if (path.isAbsolute(trimmed)) {
      if (trimmed.split(/[\\/]+/u).includes('..')) return false;
      if (nativeRealpath(parentSpec) !== realMainWt) return false;
      let cur = parentSpec;
      while (true) {
        if (fs.lstatSync(cur).isSymbolicLink()) return false;
        const realCur = nativeRealpath(cur);
        if (realCur === commonAnc || !isInsideDir(realCur, commonAnc)) break;
        const next = path.dirname(cur);
        if (next === cur) break;
        cur = next;
      }
      return true;
    }
    const segs = parentSpec.split(/[\\/]+/u);
    let cur = realWt;
    let wentDown = false;
    for (const seg of segs) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (wentDown) return false;
        const up = path.dirname(cur);
        if (up === cur || !isInsideDir(realWt, up)) return false;
        cur = up;
      } else {
        wentDown = true;
        const next = path.join(cur, seg);
        if (fs.lstatSync(next).isSymbolicLink() || !fs.statSync(next).isDirectory()) return false;
        if (next !== realMainWt && !isInsideDir(realMainWt, next)) return false;
        cur = next;
      }
    }
    return cur === realMainWt;
  } catch {
    return false;
  }
}

function findNodeModulesSource(root) {
  const worktrees = [root];
  let mainWt = null;
  let realMainWt = null;
  try {
    const firstLine = git(root, ['worktree', 'list', '--porcelain']).split('\n').find((l) => l.startsWith('worktree '));
    if (firstLine) {
      mainWt = firstLine.slice(9);
      realMainWt = nativeRealpath(mainWt);
      if (!worktrees.includes(mainWt)) worktrees.push(mainWt);
    }
  } catch { /* ignore */ }
  for (const wt of worktrees) {
    const c = path.join(wt, 'node_modules');
    let lst;
    try {
      lst = fs.lstatSync(c);
    } catch (e) {
      if (!e || e.code === 'ENOENT') continue;
      throw e;
    }
    if (!lst) continue;
    let realWt;
    let realNm;
    try {
      realWt = nativeRealpath(wt);
      realNm = nativeRealpath(c);
    } catch (e) {
      throw new LaunchError(`來源相依套件目錄連結無效（${c}）：${(e && e.message) || '讀不到目標'}`);
    }
    if (isRegisteredMainWorktreeNodeModulesLink(c, realWt, mainWt, realMainWt)) {
      continue;
    }
    if (!fs.statSync(realNm).isDirectory()) continue;
    if (!isInsideDir(realNm, realWt) || realNm === realWt || isInsideDir(realWt, realNm) || isGitManagementPath(realNm, realWt)) {
      throw new LaunchError(`來源相依套件目錄連結指向工作樹外或管理目錄（${c} -> ${realNm}），為保受審版本隔離拒絕啟動`);
    }
    try {
      resolveKernelPathInBoundary(realWt, 'node_modules', realWt, { dotGitPath: path.join(realWt, '.git') });
    } catch {
      throw new LaunchError(`來源相依套件目錄連結指向工作樹外或管理目錄（${c} -> ${realNm}），為保受審版本隔離拒絕啟動`);
    }
    return { sourceDir: realNm, worktreeDir: realWt };
  }
  return null;
}

function inspectNodeModulesTree(sourceDir, sourceWorktree) {
  const gitDirs = getGitManagementDirs(sourceWorktree);
  if (
    sourceDir === sourceWorktree
    || isInsideDir(sourceWorktree, sourceDir)
    || isGitManagementPath(sourceDir, sourceWorktree, gitDirs)
  ) {
    throw new LaunchError(`來源相依套件目錄不可為工作樹根目錄或 .git 管理目錄（${sourceDir}），為保受審版本隔離拒絕啟動`);
  }
  const dirs = [];
  const files = [];
  const links = [];
  const walk = (curDir) => {
    const entries = fs.readdirSync(curDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      const sp = path.join(curDir, ent.name);
      const relPath = path.relative(sourceDir, sp);
      if (ent.name === '.git' || isGitManagementPath(sp, sourceWorktree, gitDirs)) {
        throw new LaunchError(`相依套件內含 Git 管理目錄或檔案（${relPath}），為保受審版本隔離拒絕啟動`);
      }
      const lst = fs.lstatSync(sp);
      if (lst.isSymbolicLink()) {
        const rawTarget = fs.readlinkSync(sp);
        let traced;
        try {
          traced = traceSymlinkInSource(curDir, ent.name, sourceDir, sourceWorktree);
        } catch (err) {
          if (err && err.escapePath) {
            throw new LaunchError(`相依套件內含指向工作樹外的連結（${relPath} -> ${rawTarget}），為保受審版本隔離拒絕啟動`);
          }
          throw new LaunchError(`相依套件內含失效連結（${relPath} -> ${rawTarget}），拒絕啟動`);
        }
        const { realTarget, wsRawRelTarget } = traced;
        if (isInsideDir(realTarget, sourceDir) && wsRawRelTarget === null) {
          links.push({
            relPath,
            rawTarget,
            kind: 'internal',
            relTarget: path.relative(sourceDir, realTarget),
            wsRawRelTarget: null,
          });
        } else if (
          isInsideDir(realTarget, sourceWorktree)
          && realTarget !== sourceWorktree
          && !isGitManagementPath(realTarget, sourceWorktree, gitDirs)
        ) {
          links.push({
            relPath,
            rawTarget,
            kind: 'workspace',
            relTarget: path.relative(sourceWorktree, realTarget),
            wsRawRelTarget: wsRawRelTarget || path.relative(sourceWorktree, realTarget),
          });
        } else {
          throw new LaunchError(`相依套件內含指向工作樹外的連結（${relPath} -> ${rawTarget}），為保受審版本隔離拒絕啟動`);
        }
      } else if (lst.isDirectory()) {
        dirs.push(relPath);
        walk(sp);
      } else if (lst.isFile()) {
        const sha256 = lst.size <= 65536
          ? crypto.createHash('sha256').update(fs.readFileSync(sp)).digest('hex')
          : null;
        files.push({ relPath, size: lst.size, sha256 });
      }
    }
  };
  walk(sourceDir);
  return { dirs, files, links };
}

function resolveWorkspaceLinkTargetInTree(targetTreeReal, link) {
  const dotGitPath = path.join(targetTreeReal, '.git');
  const gitDirs = getGitManagementDirs(targetTreeReal);
  const topNodeModules = path.join(targetTreeReal, 'node_modules');
  const rawRel = link.wsRawRelTarget || link.relTarget;
  let realTargetInTree;
  try {
    realTargetInTree = resolveKernelPathInBoundary(targetTreeReal, rawRel, targetTreeReal, { dotGitPath, topNodeModules });
  } catch (err) {
    if (err && err.escapePath) {
      throw new LaunchError(`受審工作樹的本機套件連結目標指向工作樹外（${link.relPath} -> ${rawRel} -> ${err.escapePath}），為保受審版本隔離拒絕啟動`);
    }
    if (err && err.missing) {
      throw new LaunchError(`受審工作樹缺少本機套件連結目標（${link.relPath} -> ${rawRel}），拒絕啟動`);
    }
    throw new LaunchError(`受審工作樹的本機套件連結目標無法解析（${link.relPath} -> ${rawRel}）：${(err && err.message) || '不明錯誤'}，拒絕啟動`);
  }
  if (realTargetInTree === targetTreeReal || isGitManagementPath(realTargetInTree, targetTreeReal, gitDirs)) {
    throw new LaunchError(`受審工作樹的本機套件連結目標指向工作樹外或管理目錄（${link.relPath} -> ${rawRel} -> ${realTargetInTree}），為保受審版本隔離拒絕啟動`);
  }
  const visitedDirs = new Set();
  const verifyReachableInsideTree = (realDir) => {
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);
    let entries;
    try {
      entries = fs.readdirSync(realDir, { withFileTypes: true });
    } catch (e) {
      throw new LaunchError(`受審工作樹的本機套件目錄無法讀取（${link.relPath} -> ${path.relative(targetTreeReal, realDir)}）：${(e && e.message) || '不明錯誤'}，拒絕啟動`);
    }
    for (const ent of entries) {
      const ep = path.join(realDir, ent.name);
      if (ep === topNodeModules) continue;
      if (ent.name === '.git' || isGitManagementPath(ep, targetTreeReal, gitDirs)) {
        throw new LaunchError(`受審工作樹的本機套件內含指向工作樹外或管理目錄的連結（${link.relPath} -> ${path.relative(targetTreeReal, ep)}），為保受審版本隔離拒絕啟動`);
      }
      let realEp;
      try {
        realEp = resolveKernelPathInBoundary(realDir, ent.name, targetTreeReal, { dotGitPath });
      } catch (err) {
        if (err && err.escapePath) {
          throw new LaunchError(`受審工作樹的本機套件內含指向工作樹外的連結（${link.relPath} -> ${path.relative(targetTreeReal, ep)} -> ${err.escapePath}），為保受審版本隔離拒絕啟動`);
        }
        throw new LaunchError(`受審工作樹的本機套件內含失效連結（${link.relPath} -> ${path.relative(targetTreeReal, ep)}），拒絕啟動`);
      }
      if (realEp === targetTreeReal || isGitManagementPath(realEp, targetTreeReal, gitDirs)) {
        throw new LaunchError(`受審工作樹的本機套件內含指向工作樹外或管理目錄的連結（${link.relPath} -> ${path.relative(targetTreeReal, ep)} -> ${realEp}），為保受審版本隔離拒絕啟動`);
      }
      if (fs.statSync(realEp).isDirectory()) {
        verifyReachableInsideTree(realEp);
      }
      let jsEp;
      try {
        jsEp = fs.realpathSync(ep);
      } catch {
        jsEp = null;
      }
      if (jsEp !== null && jsEp !== realEp) {
        if (jsEp === targetTreeReal || isGitManagementPath(jsEp, targetTreeReal, gitDirs)) {
          throw new LaunchError(`受審工作樹的本機套件內含指向工作樹外或管理目錄的連結（${link.relPath} -> ${path.relative(targetTreeReal, ep)} -> ${jsEp}），為保受審版本隔離拒絕啟動`);
        }
        if (fs.statSync(jsEp).isDirectory()) {
          verifyReachableInsideTree(jsEp);
        }
      }
    }
  };
  if (fs.statSync(realTargetInTree).isDirectory()) {
    verifyReachableInsideTree(realTargetInTree);
  }
  return realTargetInTree;
}

function rewriteCopiedNodeModulesLinks(dstNm, targetTreeReal, links) {
  for (const link of links) {
    const dp = path.join(dstNm, link.relPath);
    if (link.kind === 'workspace') {
      const realTargetInTree = resolveWorkspaceLinkTargetInTree(targetTreeReal, link);
      try { fs.unlinkSync(dp); } catch { /* ignore */ }
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      fs.symlinkSync(realTargetInTree, dp);
    } else {
      const targetInStore = path.join(dstNm, link.relTarget);
      try { fs.unlinkSync(dp); } catch { /* ignore */ }
      fs.mkdirSync(path.dirname(dp), { recursive: true });
      fs.symlinkSync(targetInStore, dp);
    }
  }
}

function verifyCopiedNodeModulesTree(dstNm, inspected, targetTreeReal = null) {
  let rootSt;
  try { rootSt = fs.statSync(dstNm); } catch { rootSt = null; }
  if (!rootSt || !rootSt.isDirectory()) {
    throw new LaunchError(`複製相依套件（node_modules）失敗：目標目錄不存在（${dstNm}）`);
  }
  const realDstNm = nativeRealpath(dstNm);
  const dotGitPath = targetTreeReal ? path.join(targetTreeReal, '.git') : null;
  for (const d of inspected.dirs) {
    const dp = path.join(dstNm, d);
    let st;
    try { st = fs.lstatSync(dp); } catch { st = null; }
    if (!st || !st.isDirectory()) {
      throw new LaunchError(`複製相依套件（node_modules）不完整：缺少子目錄 ${d}`);
    }
  }
  for (const f of inspected.files) {
    const dp = path.join(dstNm, f.relPath);
    let st;
    try { st = fs.lstatSync(dp); } catch { st = null; }
    if (!st || !st.isFile() || st.size !== f.size) {
      throw new LaunchError(`複製相依套件（node_modules）不完整：缺少或大小不符 ${f.relPath}`);
    }
    if (f.sha256 !== null) {
      const gotHash = crypto.createHash('sha256').update(fs.readFileSync(dp)).digest('hex');
      if (gotHash !== f.sha256) {
        throw new LaunchError(`複製相依套件（node_modules）不完整：內容雜湊不符 ${f.relPath}`);
      }
    }
  }
  for (const l of inspected.links) {
    const dp = path.join(dstNm, l.relPath);
    let st;
    try { st = fs.lstatSync(dp); } catch { st = null; }
    if (!st || !st.isSymbolicLink() || !fs.existsSync(dp)) {
      throw new LaunchError(`複製相依套件（node_modules）不完整：缺少或連結失效 ${l.relPath}`);
    }
    let realLinkTarget;
    try {
      realLinkTarget = nativeRealpath(dp);
    } catch {
      throw new LaunchError(`複製相依套件（node_modules）不完整：缺少或連結失效 ${l.relPath}`);
    }
    if (l.kind === 'workspace') {
      if (targetTreeReal) {
        const expectedWsTarget = resolveWorkspaceLinkTargetInTree(targetTreeReal, l);
        let checkedWsTarget;
        try {
          checkedWsTarget = resolveKernelPathInBoundary(nativeRealpath(path.dirname(dp)), path.basename(dp), targetTreeReal, { dotGitPath });
        } catch {
          checkedWsTarget = null;
        }
        if (realLinkTarget !== expectedWsTarget || checkedWsTarget !== expectedWsTarget || !isInsideDir(realLinkTarget, targetTreeReal)) {
          throw new LaunchError(`複製相依套件（node_modules）工作區連結目標越界或不符：${l.relPath}`);
        }
      }
    } else {
      let checkedInternal;
      try {
        checkedInternal = resolveKernelPathInBoundary(nativeRealpath(path.dirname(dp)), path.basename(dp), realDstNm);
      } catch {
        checkedInternal = null;
      }
      if (checkedInternal !== realLinkTarget || !isInsideDir(realLinkTarget, realDstNm)) {
        throw new LaunchError(`複製相依套件（node_modules）內部連結越界：${l.relPath}`);
      }
    }
  }
}

function cloneNodeModulesForTree(source, targetTree, storeDir, inspected) {
  const realTree = nativeRealpath(targetTree);
  const wsTargets = new Map();
  for (const link of inspected.links) {
    if (link.kind === 'workspace') {
      wsTargets.set(link.relPath, resolveWorkspaceLinkTargetInTree(realTree, link));
    }
  }
  fs.mkdirSync(storeDir, { recursive: true });
  for (const d of inspected.dirs) {
    fs.mkdirSync(path.join(storeDir, d), { recursive: true });
  }
  for (const f of inspected.files) {
    const sp = path.join(source.sourceDir, f.relPath);
    const dp = path.join(storeDir, f.relPath);
    fs.copyFileSync(sp, dp, fs.constants.COPYFILE_FICLONE);
  }
  for (const link of inspected.links) {
    const dp = path.join(storeDir, link.relPath);
    if (link.kind === 'workspace') {
      fs.symlinkSync(wsTargets.get(link.relPath), dp);
    } else {
      fs.symlinkSync(path.join(storeDir, link.relTarget), dp);
    }
  }
  verifyCopiedNodeModulesTree(storeDir, inspected, realTree);
}

function validatePreexistingTreeNodeModules(treeDir) {
  const dst = path.join(treeDir, 'node_modules');
  let lst;
  try {
    lst = fs.lstatSync(dst);
  } catch (e) {
    if (!e || e.code === 'ENOENT') return false;
    throw e;
  }
  if (!lst) return false;
  let realTree;
  let realDst;
  try {
    realTree = nativeRealpath(treeDir);
    realDst = nativeRealpath(dst);
  } catch (e) {
    throw new LaunchError(`受審工作樹既存的相依套件目錄連結無效（${dst}）：${(e && e.message) || '讀不到目標'}，為保受審版本隔離拒絕啟動`);
  }
  if (
    !fs.statSync(realDst).isDirectory()
    || !isInsideDir(realDst, realTree)
    || realDst === realTree
    || isInsideDir(realTree, realDst)
    || isGitManagementPath(realDst, realTree)
  ) {
    throw new LaunchError(`受審工作樹既存的相依套件目錄連結指向工作樹外或管理目錄（${dst} -> ${realDst}），為保受審版本隔離拒絕啟動`);
  }
  try {
    resolveKernelPathInBoundary(realTree, 'node_modules', realTree, { dotGitPath: path.join(realTree, '.git') });
  } catch {
    throw new LaunchError(`受審工作樹既存的相依套件目錄連結指向工作樹外或管理目錄（${dst} -> ${realDst}），為保受審版本隔離拒絕啟動`);
  }
  const inspected = inspectNodeModulesTree(realDst, realTree);
  verifyCopiedNodeModulesTree(realDst, inspected, realTree);
  return true;
}

function linkNodeModules(root, folder, trees, rec = null) {
  const preexisting = new Set();
  for (const t of trees) {
    if (validatePreexistingTreeNodeModules(t)) {
      preexisting.add(t);
    }
  }
  const source = findNodeModulesSource(root);
  if (!source) return null;
  const inspected = inspectNodeModulesTree(source.sourceDir, source.worktreeDir);
  const byTree = {};
  if (rec) {
    rec.linkedNodeModules = source.sourceDir;
    if (!rec.linkedNodeModulesByTree || typeof rec.linkedNodeModulesByTree !== 'object') {
      rec.linkedNodeModulesByTree = {};
    }
  }
  for (const t of trees) {
    if (preexisting.has(t)) continue;
    const dst = path.join(t, 'node_modules');
    const storeDir = path.join(folder, 'deps', path.basename(t), 'node_modules');
    cloneNodeModulesForTree(source, t, storeDir, inspected);
    fs.symlinkSync(storeDir, dst, 'dir');
    const resolvedStore = nativeRealpath(storeDir);
    byTree[t] = resolvedStore;
    if (rec) rec.linkedNodeModulesByTree[t] = resolvedStore;
  }
  if (rec && Object.keys(rec.linkedNodeModulesByTree).length === 0) {
    delete rec.linkedNodeModules;
    delete rec.linkedNodeModulesByTree;
  }
  return Object.keys(byTree).length ? { sourceDir: source.sourceDir, byTree } : null;
}

function getExpectedNodeModulesTarget(t, rec) {
  if (!rec) return null;
  if (rec.linkedNodeModulesByTree && typeof rec.linkedNodeModulesByTree === 'object') {
    if (Object.prototype.hasOwnProperty.call(rec.linkedNodeModulesByTree, t)) {
      return rec.linkedNodeModulesByTree[t];
    }
    return null;
  }
  return rec.linkedNodeModules || null;
}

function hasIntactLinkedNodeModules(t, rec) {
  const expected = getExpectedNodeModulesTarget(t, rec);
  if (!expected) return false;
  const dst = path.join(t, 'node_modules');
  try {
    const st = fs.lstatSync(dst);
    if (!st.isSymbolicLink()) return false;
    return nativeRealpath(dst) === expected && fs.statSync(expected).isDirectory();
  } catch {
    return false;
  }
}

function treeStatus(t, rec = null) {
  if (!gitOk(t, ['status', '--porcelain'])) return null;
  const raw = git(t, ['status', '--porcelain']);
  const expected = getExpectedNodeModulesTarget(t, rec);
  if (!expected) return raw;
  if (!hasIntactLinkedNodeModules(t, rec)) {
    const lines = raw ? raw.split('\n') : [];
    if (!lines.some((l) => l.endsWith(' node_modules') || l.endsWith(' node_modules/'))) {
      lines.push('!! node_modules（掛載連結已遭移除、替換或改指他處）');
    }
    return lines.join('\n');
  }
  if (!raw) return '';
  return raw
    .split('\n')
    .filter((line) => line !== '?? node_modules' && line !== '?? node_modules/')
    .join('\n');
}

function unlinkNodeModulesSymlinkOnly(t, rec = null) {
  const dst = path.join(t, 'node_modules');
  try {
    const st = fs.lstatSync(dst);
    if (!st.isSymbolicLink()) return false;
    const expected = getExpectedNodeModulesTarget(t, rec);
    if (expected && nativeRealpath(dst) !== expected) return false;
    if (!expected && gitOk(t, ['ls-files', '--error-unmatch', 'node_modules'])) return false;
    fs.unlinkSync(dst);
    return true;
  } catch {
    return false;
  }
}

function restoreNodeModulesSymlink(t, rec = null) {
  const expected = getExpectedNodeModulesTarget(t, rec);
  if (!expected) return;
  const dst = path.join(t, 'node_modules');
  try {
    if (fs.existsSync(t) && !fs.existsSync(dst) && fs.existsSync(expected)) {
      fs.symlinkSync(expected, dst, 'dir');
    }
  } catch { /* ignore */ }
}

function removeNodeModulesStore(t, rec = null) {
  const expected = getExpectedNodeModulesTarget(t, rec);
  if (!expected || path.basename(expected) !== 'node_modules') return;
  try {
    const treeDepsDir = path.dirname(expected);
    const depsRoot = path.dirname(treeDepsDir);
    if (path.basename(depsRoot) === 'deps') {
      fs.rmSync(treeDepsDir, { recursive: true, force: true });
      try {
        if (fs.readdirSync(depsRoot).length === 0) {
          fs.rmSync(depsRoot, { recursive: true, force: true });
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function unlinkNodeModules(t, rec = null) {
  if (unlinkNodeModulesSymlinkOnly(t, rec)) {
    removeNodeModulesStore(t, rec);
  }
}

/**
 * 暫存區第一層比開樹晚的（只列、不刪），每個暫存區一組、新的排前面。自己那一層與它的上層不算：放樹的資料夾在暫存區裡時，上層的修改時間會跟著變。
 * 分組是因為系統暫存區平常就有別的程式在寫，混成一張表時複審者留在 /tmp 的東西會被擠到收合那一行裡（#49 r1 收樹時看到的）。
 */
function freshEntries(roots, folder, since, re) {
  const seen = new Set();
  const fresh = [];
  const groups = [];
  const unreadable = [];
  const mine = fs.realpathSync(folder);
  for (const r of roots) {
    let real;
    try { real = fs.realpathSync(r); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    let names;
    try { names = fs.readdirSync(real); } catch { unreadable.push(real); continue; }
    const group = [];
    for (const n of names) {
      if (n.startsWith('.') && n.endsWith('.lock')) continue;
      const p = path.join(real, n);
      if (p === mine || mine.startsWith(`${p}${path.sep}`) || re.test(n)) continue;
      try { const t = fs.lstatSync(p).mtimeMs; if (t >= since) group.push({ p, t }); } catch { /* 讀的當下被刪了 */ }
    }
    group.sort((a, b) => b.t - a.t || (a.p < b.p ? -1 : 1));
    if (group.length) groups.push({ root: real, paths: group.map((x) => x.p) });
    fresh.push(...group.map((x) => x.p));
  }
  return { fresh, groups, unreadable };
}

class DuplicateJsonKeyError extends Error {}

function parseUniqueJson(text) {
  // JSON.parse 會丟掉較早的同名欄位；先按物件範圍核對解碼後的鍵，再驗完整語法。
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const frame = stack.at(-1);
    if (ch === '"') {
      const start = i;
      for (i += 1; i < text.length; i += 1) {
        if (text[i] === '\\') i += 1;
        else if (text[i] === '"') break;
      }
      const value = JSON.parse(text.slice(start, i + 1));
      if (frame?.keys && frame.expectKey) {
        if (frame.keys.has(value)) throw new DuplicateJsonKeyError();
        frame.keys.add(value);
        frame.expectKey = false;
      }
    } else if (ch === '{') {
      stack.push({ keys: new Set(), expectKey: true });
    } else if (ch === '[') {
      stack.push({ keys: null });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',' && frame?.keys) {
      frame.expectKey = true;
    }
  }
  return JSON.parse(text);
}

function parseGrokStrictNDJSON(text, kindLabel) {
  const lines = text.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
  let sessionId = null;
  let finalResult = null;
  let lastEndTurnText = null;
  let foundResult = false;
  let initFound = false;

  for (const line of lines) {
    let event;
    try {
      event = parseUniqueJson(line);
      if (event === null || Array.isArray(event) || typeof event !== 'object') throw new Error();
    } catch (error) {
      if (error instanceof DuplicateJsonKeyError) return { error: `${kindLabel}重複鍵` };
      return { error: `${kindLabel}格式壞` };
    }

    if (foundResult) return { error: `${kindLabel}多 result 或尾隨事件` };

    if (event.type === 'system') {
      if (event.subtype === 'init') {
        if (initFound) return { error: `${kindLabel}多 system.init` };
        const sid = typeof event.session_id === 'string' ? event.session_id.trim() : '';
        if (!sid) return { error: `${kindLabel}缺 session_id` };
        sessionId = sid;
        initFound = true;
        continue;
      }
      if (event.subtype === 'compact_boundary') {
        if (!initFound) return { error: `${kindLabel}尚未初始化` };
        if (event.session_id !== sessionId) return { error: `${kindLabel}錯 session` };
        if (typeof event.uuid !== 'string' || !event.uuid) return { error: `${kindLabel}compact_boundary 缺 uuid` };
        const cm = event.compact_metadata;
        if (!cm || Array.isArray(cm) || typeof cm !== 'object') return { error: `${kindLabel}compact_boundary 缺 compact_metadata` };
        if (cm.trigger !== 'auto') return { error: `${kindLabel}compact_metadata.trigger 必須為 auto` };
        if (typeof cm.pre_tokens !== 'number' || !Number.isInteger(cm.pre_tokens) || cm.pre_tokens < 0) {
          return { error: `${kindLabel}compact_metadata.pre_tokens 必須為數字 (u64)` };
        }
        continue;
      }
      return { error: `${kindLabel}應拒絕未知的 system subtype` };
    }

    if (!initFound) return { error: `${kindLabel}缺 system.init` };
    if (event.session_id !== sessionId) return { error: `${kindLabel}錯 session` };

    if (event.type === 'assistant') {
      // 新對話活動使先前完成資格失效，避免未完成或子代理回覆借用舊正文。
      lastEndTurnText = null;
      if (event.parent_tool_use_id === null) {
        if (event.message && typeof event.message === 'object' && event.message.role === 'assistant' && event.message.stop_reason === 'end_turn') {
          let t = '';
          if (Array.isArray(event.message.content)) {
            for (const c of event.message.content) {
              if (c && c.type === 'text') {
                if (typeof c.text !== 'string') return { error: `${kindLabel}正文內容非字串` };
                t += c.text;
              }
            }
          }
          lastEndTurnText = t;
        }
      }
    } else if (event.type === 'user') {
      lastEndTurnText = null;
    } else if (event.type === 'result') {
      foundResult = true;
      finalResult = event;
    } else {
      return { error: `${kindLabel}end_turn 前後出現未知事件 ${event.type || '未知'}` };
    }
  }

  if (!foundResult) return { error: `${kindLabel}缺 result` };

  if (finalResult.subtype !== 'success' || finalResult.is_error !== false || finalResult.stop_reason !== 'end_turn') {
    if (finalResult.stop_reason === 'cancelled') return { error: `${kindLabel}cancelled` };
    return { error: `${kindLabel}截短/未知/缺result/執行失敗` };
  }

  const resText = typeof finalResult.result === 'string' ? finalResult.result.trim() : '';
  if (!resText) {
    return { error: `${kindLabel}最終正文為空` };
  }

  if (lastEndTurnText === null) {
    return { error: `${kindLabel}正文不一致（缺 assistant end_turn）` };
  } else if (lastEndTurnText !== finalResult.result) {
    return { error: `${kindLabel}最終正文不一致` };
  }

  return { success: true, text: finalResult.result };
}

function unwrapScanOutput(raw, kindLabel = '掃描回覆', forceGrok = false) {
  const text = String(raw ?? '');
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text;
  }

  let parsed = null;
  const ndLines = trimmed.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);
  if (ndLines.length > 0) {
    try {
      const frames = ndLines.map((l) => JSON.parse(l));
      const first = frames[0];
      const isGrok = forceGrok || (first && first.type === 'system' && first.subtype === 'init' && String(first.model || '').startsWith('grok-'));

      if (isGrok) {
        const strictParsed = parseGrokStrictNDJSON(trimmed, kindLabel);
        if (strictParsed.error) throw new LaunchError(strictParsed.error);
        return strictParsed.text;
      }
      parsed = frames.length === 1 ? frames[0] : frames;
    } catch (e) {
      if (e instanceof LaunchError) throw e;
      if (forceGrok) throw new LaunchError(`${kindLabel}格式壞或非合規 NDJSON`);
      // 降級
    }
  }

  if (parsed === null) {
    try {
      parsed = JSON.parse(trimmed);
      if (forceGrok) {
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.type === 'result' || Object.hasOwn(parsed, 'stop_reason'))) {
          const strictParsed = parseGrokStrictNDJSON(trimmed, kindLabel);
          if (strictParsed.error) throw new LaunchError(strictParsed.error);
          return strictParsed.text;
        }
        throw new LaunchError(`${kindLabel}非合規 NDJSON 格式`);
      }
    } catch (e) {
      if (e instanceof LaunchError) throw e;
      return text;
    }
  }

  const pickResult = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (obj.is_error === true || (obj.subtype !== undefined && obj.subtype !== 'success')) {
      throw new LaunchError(`${kindLabel} JSON 標示執行失敗（is_error 或非 success），不代貼`);
    }
    return typeof obj.result === 'string' ? obj.result : null;
  };
  if (Array.isArray(parsed)) {
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      const item = parsed[i];
      if (item && typeof item === 'object' && item.type === 'result') {
        const res = pickResult(item);
        if (res !== null) return res;
      }
    }
    return text;
  }
  const res = pickResult(parsed);
  return res !== null ? res : text;
}

/**
 * 只核已解包正文，不核CLI執行狀態；不再解析正文內的JSON：
 * 去除首尾空行，若最後一行單獨是「未貼」就剝掉；
 * 核第一行標頭（角色、來源、輪次、受審版本短碼）與「通過」的兩行固定小標（F4、F5、F7；擁有者照 F12 豁免小標）。
 */
function prepareVerdictBody(unwrapped, { reviewer, source, round, head, usable, ownerRole = null }) {
  const lines = String(unwrapped ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) throw new LaunchError('結論檔是空的');
  let strippedUnposted = false;
  if (lines[lines.length - 1].replace(/[ \t]+$/u, '') === '未貼') {
    strippedUnposted = true;
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  }
  if (!lines.length) throw new LaunchError('結論檔只有「未貼」，沒有結論內容');
  const body = `${lines.join('\n')}\n`;
  const h = headerOf(body, usable);
  if (!h) {
    throw new LaunchError('結論第一行不是合規標頭（照 templates/verdict-header.md：🤖 <識別值>｜來源：<來源字串>｜審 `<短碼>`｜r<輪次>｜結論：<三選一>；標頭前不可有前言或工具雜訊）');
  }
  if (h.role !== reviewer) throw new LaunchError(`結論標頭的角色是「${h.role}」，不是本輪複審者 ${reviewer}`);
  const wantSource = String(source).trim().replace(/\s+/gu, ' ');
  if (h.source !== wantSource) throw new LaunchError(`結論標頭的來源是「${h.source}」，不是設定登記的「${wantSource}」`);
  if (h.round !== round) throw new LaunchError(`結論標頭的輪次是 r${h.round}，不是本輪 r${round}`);
  if (!String(head).toLowerCase().startsWith(h.sha)) {
    throw new LaunchError(`結論標頭審的是 ${h.sha}，對不上本輪受審版本 ${String(head).slice(0, 7)}`);
  }
  if (!h.blocking && h.role !== ownerRole) {
    const miss = missingHeadings(body);
    if (miss.length) throw new LaunchError(`結論是「通過」但少了固定小標：${miss.join('、')}（F7：${PASS_HEADINGS.join('、')} 都要有）`);
  }
  return { body, header: h, strippedUnposted };
}

/**
 * 先核CLI封包再核正文的理由：避免自貼摘要例外吞掉執行失敗；正文不再解包，避免模型自寫JSON升格。
 */
function prepareVerdict(raw, opts) {
  const unwrapped = unwrapScanOutput(raw, '複審結論', opts.forceGrok || String(opts.source).includes('Grok'));
  return prepareVerdictBody(unwrapped, opts);
}

/**
 * 不開 shell 解析指令字串為參數陣列：支援單引號、雙引號（含 \" 與 \\ 跳脫）及引號外的反斜線跳脫；
 * 引號或跳脫未閉合時丟 LaunchError。
 */
function splitCommandArgs(text) {
  const args = [];
  let cur = '';
  let hasToken = false;
  let quote = null;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\') {
        if (i + 1 >= s.length) throw new LaunchError('reviewLaunch.postComment 的引號或跳脫字元沒有閉合');
        const next = s[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          cur += next;
          i += 1;
        } else {
          cur += ch;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= s.length) throw new LaunchError('reviewLaunch.postComment 的引號或跳脫字元沒有閉合');
      cur += s[i + 1];
      hasToken = true;
      i += 1;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (hasToken) {
        args.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (quote !== null) throw new LaunchError('reviewLaunch.postComment 的引號或跳脫字元沒有閉合');
  if (hasToken) args.push(cur);
  return args;
}

/** 原子寫回 JSON 紀錄（先寫同目錄唯一暫存檔再 rename，避免並發讀取看到半套內容）。 */
function writeJsonAtomic(filePath, obj) {
  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(obj, null, 1)}\n`, { flag: 'wx' });
  fs.renameSync(tmpFile, filePath);
}

function unlinkIfOwned(lockFile, token) {
  try {
    if (fs.readFileSync(lockFile, 'utf8') === token) {
      fs.unlinkSync(lockFile);
    }
  } catch { /* ignore */ }
}

/** 每輪排他鎖（post.lock）＋外層容器鎖協同：同輪並發呼叫 --post 時依序排隊，取得 post.lock 後必須一併取得容器外的 .<basename>.lock 並重驗容器 inode、post.lock 憑證與紀錄身分未在等待期間被刪除重建；釋放時僅刪除自己持有的鎖實例。 */
function withPostLock(folder, fn) {
  const lockFile = path.join(folder, 'post.lock');
  const containerLockFile = path.join(path.dirname(folder), `.${path.basename(folder)}.lock`);
  const readContainerStamp = () => {
    for (const name of ['launch.json', 'scan.json']) {
      const p = path.join(folder, name);
      if (fs.existsSync(p)) {
        try {
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          return `${name}:${j.round ?? ''}:${j.head ?? ''}:${j.startedAt ?? ''}`;
        } catch {
          return null;
        }
      }
    }
    return null;
  };
  let initialFolderIno = null;
  try { initialFolderIno = fs.lstatSync(folder).ino; } catch { /* ignore */ }
  const initialStamp = readContainerStamp();
  const lockToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}\n`;
  const containerToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}\n`;
  const deadline = Date.now() + 15000;
  let acquired = false;
  let containerAcquired = false;
  while (!acquired) {
    try {
      fs.writeFileSync(lockFile, lockToken, { flag: 'wx' });
      acquired = true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw new LaunchError(`建立代貼鎖失敗：${(e && (e.code || e.message)) || e}`);
      let ownerPid = 0;
      try { ownerPid = Number.parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10); } catch { /* 剛被釋放 */ }
      if (ownerPid > 0) {
        try { process.kill(ownerPid, 0); } catch (ke) {
          if (ke && ke.code === 'ESRCH') {
            throw new LaunchError(`發現殘留的代貼鎖 ${lockFile}（原持有程序 PID ${ownerPid} 已結束）：請先確認平台上是否已貼出結論，手動移除該鎖檔後再重試`);
          }
        }
      }
      if (Date.now() >= deadline) throw new LaunchError(`另一支代貼程序（PID ${ownerPid || '未知'}）持有 ${lockFile} 逾時，請稍後再試`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    try {
      fs.writeFileSync(containerLockFile, containerToken, { flag: 'wx' });
      containerAcquired = true;
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        let ownerPid = 0;
        try { ownerPid = Number.parseInt(fs.readFileSync(containerLockFile, 'utf8').trim(), 10); } catch { /* ignore */ }
        if (ownerPid > 0 && ownerPid !== process.pid) {
          try { process.kill(ownerPid, 0); } catch (ke) {
            if (ke && ke.code === 'ESRCH') {
              throw new LaunchError(`發現殘留的容器鎖 ${containerLockFile}（原持有程序 PID ${ownerPid} 已結束）：請先確認該容器狀態，手動移除該鎖檔後再重試`);
            }
          }
        }
        throw new LaunchError(`${folder} 正在被另一個程序操作：請稍後再試`);
      }
      throw new LaunchError(`建立容器鎖失敗：${(e && (e.code || e.message)) || e}`);
    }
    let currentFolderIno = null;
    try { currentFolderIno = fs.lstatSync(folder).ino; } catch { /* ignore */ }
    let currentPostLock = null;
    try { currentPostLock = fs.readFileSync(lockFile, 'utf8'); } catch { /* ignore */ }
    const currentStamp = readContainerStamp();
    if (
      currentPostLock !== lockToken
      || (initialFolderIno !== null && currentFolderIno !== initialFolderIno)
      || (initialStamp !== null && currentStamp !== initialStamp)
    ) {
      throw new LaunchError(`${folder} 正在被另一個程序操作：請稍後再試`);
    }
    return fn();
  } finally {
    if (containerAcquired) unlinkIfOwned(containerLockFile, containerToken);
    if (acquired) unlinkIfOwned(lockFile, lockToken);
  }
}

/** 容器級排他鎖（放在容器上層目錄，替換或清除容器時不會把鎖刪掉）：同容器並發開樹／替換／收樹／purge 時後到者立即退出，且若代貼鎖 post.lock 存在亦立即拒絕，釋放時僅刪除自己持有的鎖實例。 */
function withContainerLock(folder, busyMsg, fn) {
  const lockFile = path.join(path.dirname(folder), `.${path.basename(folder)}.lock`);
  const lockToken = `${process.pid}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}\n`;
  try {
    fs.writeFileSync(lockFile, lockToken, { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      let ownerPid = 0;
      try { ownerPid = Number.parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10); } catch { /* ignore */ }
      if (ownerPid > 0 && ownerPid !== process.pid) {
        try { process.kill(ownerPid, 0); } catch (ke) {
          if (ke && ke.code === 'ESRCH') {
            throw new LaunchError(`發現殘留的容器鎖 ${lockFile}（原持有程序 PID ${ownerPid} 已結束）：請先確認該容器狀態，手動移除該鎖檔後再重試`);
          }
        }
      }
      throw new LaunchError(busyMsg);
    }
    throw new LaunchError(`建立容器鎖失敗：${(e && (e.code || e.message)) || e}`);
  }
  try {
    if (fs.existsSync(path.join(folder, 'post.lock'))) {
      throw new LaunchError(busyMsg);
    }
    return fn();
  } finally {
    unlinkIfOwned(lockFile, lockToken);
  }
}

/** 執行貼結論指令（不開 shell；清掉 GIT_* 與 platform.clearEnv）。 */
function defaultRunPost(cmd, args, { clearEnv = [] } = {}) {
  const env = gitEnv();
  for (const k of Array.isArray(clearEnv) ? clearEnv : []) delete env[k];
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (r.error) throw new LaunchError(`貼結論指令起不來：${r.error.message}`);
  if (r.status !== 0) {
    const msg = `${r.stderr || ''}\n${r.stdout || ''}`.trim().slice(0, 200);
    throw new LaunchError(`貼結論指令退 ${r.status === null ? '（被殺掉）' : r.status}：${msg || '（沒有訊息）'}`);
  }
}

function matchesExpectHead(rec, expectHead) {
  if (expectHead === null || expectHead === undefined) return true;
  const want = String(expectHead).trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/u.test(want)) return false;
  const actual = typeof (rec && rec.head) === 'string' ? rec.head.trim().toLowerCase() : '';
  if (!actual) return false;
  if (want.length === 40) return actual === want;
  if (!actual.startsWith(want)) return false;
  if (rec && rec.root && fs.existsSync(rec.root)) {
    if (!gitOk(rec.root, ['rev-parse', '--verify', '--quiet', `${want}^{commit}`])) return false;
    const resolved = git(rec.root, ['rev-parse', '--verify', '--quiet', `${want}^{commit}`]).toLowerCase();
    return resolved === actual;
  }
  return true;
}

function formatHeadPair(actualHead, expectHead) {
  const actual = String(actualHead || '');
  const want = String(expectHead || '');
  const shortActual = actual.slice(0, 7);
  const shortWant = want.slice(0, 7);
  if (shortActual.toLowerCase() !== shortWant.toLowerCase()) return [shortActual, shortWant];
  return [actual, want];
}

/**
 * 外殼代貼結論（--post）：任何 AI 複審者只需輸出純文字結論（文末可單獨寫「未貼」），不需在盒內持有平台憑證。
 * 先核審查樹與突變副本都在、乾淨、HEAD 沒變、沒上鎖（不符退 1、不貼），再核結論檔、標頭與小標、平台版本與同輪未重複，通過才代貼並記下 postedAt。
 * 當一鍵模式（--run）傳入 allowAlreadyPosted: true 時，若複審者已依提示自行貼出唯一一則合規當輪結論，核驗無誤後承接該結果並記下 postedAt，不重複貼。
 */
function post(changeArg, { settings = readSettings(), platform = { ask }, dir: dirArg = os.tmpdir(), file: fileArg = null, runPost = defaultRunPost, now = () => new Date(), allowAlreadyPosted = false, expectRound = null, expectHead = null, expectStartedAt = null } = {}) {
  const dir = realDir(dirArg);
  const project = settings.platform && settings.platform.project;
  if (!filled(project)) throw new LaunchError('專案設定的 platform.project 還沒填：找不到樹放在哪');
  const rl = settings.reviewLaunch || {};
  if (!filled(rl.postComment)) throw new LaunchError('專案設定的 reviewLaunch.postComment 還沒填：不知道怎麼貼結論');
  const { usable } = rolesOf(settings);
  const ownerRole = canonicalRole(settings && settings.owner, usable);
  const cleanId = String(changeArg).replace(/[^A-Za-z0-9._-]/gu, '');
  const re = folderRe(slugOf(project), cleanId);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { throw new LaunchError(`讀不了 ${dir}（${e.code || e.message}）`); }
  const open = entries.filter((n) => re.test(n)).map((n) => path.join(dir, n)).filter((f) => {
    try { return !JSON.parse(fs.readFileSync(path.join(f, 'launch.json'), 'utf8')).closedAt; } catch { return false; }
  });
  let folder;
  if (expectRound !== null && expectRound !== undefined) {
    const targetFolder = path.join(dir, `review-${slugOf(project)}-${cleanId}-r${expectRound}`);
    if (!open.includes(targetFolder)) {
      throw new LaunchError(`在 ${dir} 底下找不到變更 ${changeArg} 本輪 r${expectRound} 還開著的審查樹（${path.basename(targetFolder)}）`);
    }
    folder = targetFolder;
  } else {
    if (!open.length) throw new LaunchError(`在 ${dir} 底下找不到變更 ${changeArg} 還開著的審查樹（review-${slugOf(project)}-${changeArg}-r*）`);
    if (open.length > 1) throw new LaunchError(`在 ${dir} 底下找到 ${open.length} 個還開著的審查資料夾（${open.map((f) => path.basename(f)).join('、')}）：請先整理到只剩本輪一個`);
    folder = open[0];
  }
  const recFile = path.join(folder, 'launch.json');
  return withPostLock(folder, () => {
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    if (String(rec.change) !== String(changeArg)) throw new LaunchError(`launch.json 記的變更編號是 ${rec.change}，不是參數給的 ${changeArg}`);
    if (expectRound !== null && expectRound !== undefined && rec.round !== expectRound) {
      throw new LaunchError(`launch.json 記的輪次是 r${rec.round}，不是本次啟動的 r${expectRound}`);
    }
    if (!matchesExpectHead(rec, expectHead)) {
      const [shownActual, shownWant] = formatHeadPair(rec.head, expectHead);
      throw new LaunchError(`launch.json 記的受審版本是 ${shownActual}，不是本次啟動的 ${shownWant}`);
    }
    if (expectStartedAt !== null && expectStartedAt !== undefined && rec.startedAt !== expectStartedAt) {
      throw new LaunchError(`launch.json 記的啟動時間是 ${rec.startedAt}，不是本次啟動的 ${expectStartedAt}`);
    }
    if (rec.closedAt) throw new LaunchError(`r${rec.round}（${folder}）已經在 ${rec.closedAt} 收樹，不代貼結論`);
    if (rec.postedAt) throw new LaunchError(`r${rec.round}（${folder}）已經在 ${rec.postedAt} 代貼過結論，不重複貼`);
    const entry = (Array.isArray(settings.reviewers) ? settings.reviewers : []).find((r) => r && r.participant === rec.reviewer);
    if (!entry || !filled(entry.source)) throw new LaunchError(`專案設定的 reviewers 找不到「${rec.reviewer}」或沒填 source`);

    const locks = lockedTrees(rec.root);
    const removed = Array.isArray(rec.removed) ? rec.removed : [];
    const problems = [];
    for (const [what, t] of [['審查樹', rec.tree], ['突變副本', rec.mutation]]) {
      if (removed.includes(t)) { problems.push(`${what}已經收掉了（代貼結論前兩棵樹都要還在、好核對乾淨與 HEAD）`); continue; }
      if (!fs.existsSync(t)) { problems.push(`${what}不見了（${t}）`); continue; }
      if (!locks.has(t)) problems.push(`${what}不在 git worktree 登記裡（${t}）`);
      else if (locks.get(t)) problems.push(`${what}上了鎖`);
      const h = gitOk(t, ['rev-parse', 'HEAD']) ? git(t, ['rev-parse', 'HEAD']) : null;
      if (h !== rec.head) problems.push(`${what}的 HEAD 是 ${h || '讀不出'}，不是受審版本 ${rec.head.slice(0, 7)}`);
      const st = treeStatus(t, rec);
      if (st === null) problems.push(`${what}的狀態讀不出`);
      else if (st) problems.push(`${what}不乾淨：${st.split('\n').slice(0, 5).join('；')}${st.split('\n').length > 5 ? '…' : ''}`);
    }
    if (problems.length) {
      return {
        code: 1,
        lines: [
          `沒貼 r${rec.round}（${folder}）：`,
          ...problems.map((p) => `  ・${p}`),
          '  審查樹與突變副本都要在、乾淨、HEAD 沒變、沒上鎖，才代貼結論。',
        ],
      };
    }

    const srcPath = fileArg ? path.resolve(fileArg) : rec.outFile;
    if (!filled(srcPath)) throw new LaunchError('找不到結論檔路徑');
    let st;
    try { st = fs.lstatSync(srcPath); } catch (e) { throw new LaunchError(`讀不到結論檔 ${srcPath}（${e.code || e.message}）`); }
    if (!st.isFile()) throw new LaunchError(`結論檔 ${srcPath} 不是一般檔案（不收連結或資料夾）`);
    const realSrc = fs.realpathSync(srcPath);
    for (const [what, t] of [['審查樹', rec.tree], ['突變副本', rec.mutation]]) {
      let realT;
      try { realT = fs.realpathSync(t); } catch { continue; }
      if (realSrc === realT || realSrc.startsWith(`${realT}${path.sep}`)) {
        throw new LaunchError(`結論檔不可放在${what}裡面（${realSrc}）`);
      }
    }
    const raw = fs.readFileSync(realSrc, 'utf8');
    // 先核執行封包，避免自貼摘要例外吞掉執行失敗；正文不再解包，避免模型自寫JSON升格。
    const unwrappedRaw = unwrapScanOutput(raw, '複審結論', String(entry.source).includes('Grok'));
    const vOpts = { reviewer: rec.reviewer, source: entry.source, round: rec.round, head: rec.head, usable, ownerRole };
    let prepared = null;
    let prepareErr = null;
    if (!allowAlreadyPosted) {
      prepared = prepareVerdictBody(unwrappedRaw, vOpts);
    } else {
      try {
        prepared = prepareVerdictBody(unwrappedRaw, vOpts);
      } catch (e) {
        if (e instanceof LaunchError) prepareErr = e;
        else throw e;
      }
    }

    const sub = substitute(rl.postComment, { project, change: rec.change }, '貼結論的指令');
    if (!sub.used.includes('change')) throw new LaunchError('reviewLaunch.postComment 沒帶 {change}：不知道要貼到哪一支');
    const parts = splitCommandArgs(sub.text);
    if (parts.length < 2 || !parts.includes(FILE_SLOT)) {
      throw new LaunchError(`reviewLaunch.postComment 要包含獨立的 ${FILE_SLOT} 佔位（例如 gh pr comment {change} -R {project} --body-file ${FILE_SLOT}）`);
    }

    const change = askPlatform(platform, settings, 'change', { change: String(rec.change) });
    if (change.headSha !== rec.head) {
      throw new LaunchError(`平台目前受審版本是 ${String(change.headSha).slice(0, 7)}，不是開樹時的 ${String(rec.head).slice(0, 7)}：版本已變，不代貼舊版結論`);
    }
    const named = canonicalRole(fieldValue(change.body, '複審者'), usable);
    if (named !== rec.reviewer && !Object.hasOwn(rec, 'continuation')) {
      throw new LaunchError(`PR說明的「複審者」欄目前是「${named || '讀不出'}」，不是開樹時的 ${rec.reviewer}：不代貼`);
    }
    const comments = askPlatform(platform, settings, 'comments', { change: rec.change });
    const continuationRecord = Object.hasOwn(rec, 'continuation') ? JSON.stringify(rec) : null;
    if (continuationRecord) recheckContinuation(rec, change, comments, prepared, allowAlreadyPosted, settings);
    const recheckBeforeReceipt = (allowCandidate, requireCandidate = false) => {
      if (!continuationRecord) return;
      const latest = JSON.parse(fs.readFileSync(recFile, 'utf8'));
      if (JSON.stringify(latest) !== continuationRecord) throw new LaunchError('獨立續審場次紀錄在收件期間已變；不覆寫');
      recheckContinuation(rec,
        askPlatform(platform, settings, 'change', { change: String(rec.change) }),
        askPlatform(platform, settings, 'comments', { change: rec.change }), prepared, allowCandidate, settings, requireCandidate);
    };
    const wantSource = String(entry.source).trim().replace(/\s+/gu, ' ');
    const roundComments = comments.filter((c) => {
      const h = headerOf(c.body, usable);
      return h && h.role === rec.reviewer && h.source === wantSource && h.round === rec.round;
    });
    if (roundComments.length > 0) {
      if (!allowAlreadyPosted) {
        throw new LaunchError(`平台上已經有 ${rec.reviewer}（${wantSource}）的 r${rec.round} 結論留言：不重複貼`);
      }
      if (roundComments.length > 1) {
        throw new LaunchError(`平台上已經有 ${roundComments.length} 則 ${rec.reviewer}（${wantSource}）的 r${rec.round} 結論留言：重複或衝突，不自動收尾`);
      }
      const normalizedComments = comments.map((c, idx) => (c && c.createdAt === undefined ? { ...c, createdAt: new Date(idx * 1000).toISOString() } : c));
      const evaluated = evaluateVerdicts(normalizedComments, rec.head, rec.reviewer, usable, { ownerRole });
      if (evaluated.unsure) {
        throw new LaunchError('平台上留言時間讀不出來或沒帶時區：不自動收尾');
      }
      const unvoidedMalformed = evaluated.problems.find((p) => p.includes('用了 🤖 記號、但標頭格式不合規'));
      if (unvoidedMalformed) {
        throw new LaunchError(`平台上出現未作廢的壞標頭 🤖 留言（${unvoidedMalformed.split('\n')[0]}）：不自動收尾`);
      }
      let platformPrepared;
      try {
        platformPrepared = prepareVerdict(roundComments[0].body, {
          reviewer: rec.reviewer,
          source: entry.source,
          round: rec.round,
          head: rec.head,
          usable,
          ownerRole,
        });
      } catch (e) {
        throw new LaunchError(`平台上已有的 r${rec.round} 結論留言不合規（${e.message}）：不自動收尾`);
      }
      if (platformPrepared.strippedUnposted) {
        throw new LaunchError(`平台上已有的 r${rec.round} 結論留言文末仍帶「未貼」：不自動收尾`);
      }
      if (prepared && prepared.body !== platformPrepared.body) {
        throw new LaunchError(`輸出檔的 r${rec.round} 結論與平台上已貼出的結論內容不一致：不自動收尾`);
      }
      if (!prepared && /🤖/u.test(unwrappedRaw)) {
        throw new LaunchError(`平台上已有 r${rec.round} 結論留言，但輸出檔另有不合規的 🤖 標頭內容（${prepareErr ? prepareErr.message : '格式不符'}）：不自動收尾`);
      }
      if (!prepared) {
        throw new LaunchError('輸出檔缺少完整合法結論，不能與平台正文核對：不自動收尾');
      }
      recheckBeforeReceipt(true, true);
      const latestRec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
      if (latestRec.head !== rec.head || latestRec.startedAt !== rec.startedAt || latestRec.closedAt) {
        throw new LaunchError('代貼期間容器紀錄已變更或已收樹，拒絕覆寫新紀錄');
      }
      rec.postedAt = now().toISOString();
      rec.verdict = platformPrepared.header.verdict;
      writeJsonAtomic(recFile, rec);
      return {
        code: 0,
        lines: [
          `已確認複審者自行貼出 r${rec.round} 結論｜變更 ${rec.change}｜複審者 ${rec.reviewer}（來源 ${wantSource}）｜審 ${rec.head.slice(0, 7)}｜結論：${platformPrepared.header.verdict}（不重複代貼）`,
          `  兩棵樹的 HEAD 都還是 ${rec.head.slice(0, 7)}、都乾淨；下一步跑結論閘確認，審完跑：node tools/review-launch.js --close ${rec.change}${dir === realDir(os.tmpdir()) ? '' : ` --dir ${dir}`}`,
        ],
        record: rec,
        header: platformPrepared.header,
        body: platformPrepared.body,
        selfPosted: true,
      };
    }
    if (prepareErr) throw prepareErr;

    const verdictFile = path.join(folder, `verdict-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.md`);
    fs.writeFileSync(verdictFile, prepared.body, { flag: 'wx' });
    const argv = parts.map((p) => (p === FILE_SLOT ? verdictFile : p));
    const clearEnv = Array.isArray(settings.platform && settings.platform.clearEnv) ? settings.platform.clearEnv : [];
    recheckBeforeReceipt(false);
    if (continuationRecord) {
      try {
        runPost(argv[0], argv.slice(1), { clearEnv });
        recheckBeforeReceipt(true, true);
      } catch (e) {
        if (!(e instanceof LaunchError)) throw e;
        return { code: 2, lines: [`獨立續審貼文已送出或結果不明：${e.message}。未記 postedAt、未收樹；先讀回平台核對，勿盲重貼。`] };
      }
    } else runPost(argv[0], argv.slice(1), { clearEnv });
    const latestRec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    if (latestRec.head !== rec.head || latestRec.startedAt !== rec.startedAt || latestRec.closedAt) {
      throw new LaunchError('代貼期間容器紀錄已變更或已收樹，拒絕覆寫新紀錄');
    }
    rec.postedAt = now().toISOString();
    rec.verdict = prepared.header.verdict;
    rec.verdictFile = verdictFile;
    writeJsonAtomic(recFile, rec);
    return {
      code: 0,
      lines: [
        `已代貼 r${rec.round} 結論｜變更 ${rec.change}｜複審者 ${rec.reviewer}（來源 ${wantSource}）｜審 ${rec.head.slice(0, 7)}｜結論：${prepared.header.verdict}${prepared.strippedUnposted ? '（已剝除文末「未貼」）' : ''}`,
        `  兩棵樹的 HEAD 都還是 ${rec.head.slice(0, 7)}、都乾淨；下一步跑結論閘確認，審完跑：node tools/review-launch.js --close ${rec.change}${dir === realDir(os.tmpdir()) ? '' : ` --dir ${dir}`}`,
      ],
      record: rec,
      header: prepared.header,
      body: prepared.body,
      argv,
    };
  });
}

/**
 * 收樹：還沒收的每一棵都在、HEAD 沒變、狀態乾淨、沒上鎖才動手；有一棵不對就全部留著給人看。
 * 一棵一棵移除，每收好一棵就記進紀錄：收到一半失敗時照實說哪一棵收了、哪一棵沒有，重跑只處理還沒收的（#49 r1 R5）。
 */
/** 移除一棵樹；回 null＝成功，否則回原因。考題換掉它，才考得到「第二棵移除失敗」那一條路。 */
function removeTree(root, t) {
  const r = spawnSync('git', ['worktree', 'remove', t], { cwd: root, env: gitEnv(), encoding: 'utf8' });
  return r.error || r.status !== 0 ? ((r.error && r.error.message) || (r.stderr || '').trim() || `退 ${r.status}`) : null;
}

function close(changeArg, { settings = readSettings(), dir: dirArg = os.tmpdir(), leftoverRoots = [os.tmpdir(), '/tmp'], remove = removeTree, purge = false, expectRound = null, expectHead = null, expectStartedAt = null } = {}) {
  const dir = realDir(dirArg);
  const project = settings.platform && settings.platform.project;
  if (!filled(project)) throw new LaunchError('專案設定的 platform.project 還沒填：找不到樹放在哪');
  const cleanId = String(changeArg).replace(/[^A-Za-z0-9._-]/gu, '');
  const re = folderRe(slugOf(project), cleanId);
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { throw new LaunchError(`讀不了 ${dir}（${e.code || e.message}）`); }
  const targetFolder = expectRound !== null && expectRound !== undefined
    ? path.join(dir, `review-${slugOf(project)}-${cleanId}-r${expectRound}`)
    : null;
  const allFolders = entries
    .filter((n) => re.test(n))
    .map((n) => path.join(dir, n))
    .filter((f) => !targetFolder || f === targetFolder)
    .filter((f) => {
      try { return Boolean(JSON.parse(fs.readFileSync(path.join(f, 'launch.json'), 'utf8'))); } catch { return false; }
    });
  const open = allFolders.filter((f) => {
    try { return !JSON.parse(fs.readFileSync(path.join(f, 'launch.json'), 'utf8')).closedAt; } catch { return false; }
  });
  if (!open.length && !(purge && allFolders.length)) {
    throw new LaunchError(`在 ${dir} 底下找不到變更 ${changeArg} 還開著的審查樹（review-${slugOf(project)}-${changeArg}-r*）`);
  }
  const lines = [];
  let refused = false;
  for (const folder of open) {
    withContainerLock(folder, `${folder} 正在被另一個程序操作：請稍後再試`, () => {
      const recFile = path.join(folder, 'launch.json');
      const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
      if (
        (expectRound !== null && expectRound !== undefined && rec.round !== expectRound)
        || !matchesExpectHead(rec, expectHead)
        || (expectStartedAt !== null && expectStartedAt !== undefined && rec.startedAt !== expectStartedAt)
      ) {
        refused = true;
        lines.push(`沒收 r${rec.round}（${folder}）：容器紀錄已非本次啟動的那一輪（輪次、版本或開始時間不符）。`);
        return;
      }
      const save = () => fs.writeFileSync(recFile, `${JSON.stringify(rec, null, 1)}\n`);
      rec.removed = Array.isArray(rec.removed) ? rec.removed : [];
      const todo = [['審查樹', rec.tree], ['突變副本', rec.mutation]].filter(([, t]) => !rec.removed.includes(t));
      const locks = lockedTrees(rec.root);
      const problems = [];
      for (const [what, t] of todo) {
        if (!fs.existsSync(t)) {
          // 目錄不在、git 也沒登記＝已經有人收過了（照上面的提示手動收的那一棵）；目錄不在但 git 還登記著＝被搬走或刪掉，要人看
          if (!locks.has(t)) { rec.removed.push(t); save(); lines.push(`  r${rec.round} 的${what}已經不在、git 也沒登記：當作收過。`); continue; }
          problems.push(`${what}不見了（${t}），git 還登記著`);
          continue;
        }
        if (locks.get(t)) problems.push(`${what}上了鎖（git worktree unlock 之後再收）`);
        const h = gitOk(t, ['rev-parse', 'HEAD']) ? git(t, ['rev-parse', 'HEAD']) : null;
        if (h !== rec.head) problems.push(`${what}的 HEAD 是 ${h || '讀不出'}，不是受審版本 ${rec.head.slice(0, 7)}`);
        const st = treeStatus(t, rec);
        if (st === null) problems.push(`${what}的狀態讀不出`);
        else if (st) problems.push(`${what}不乾淨：${st.split('\n').slice(0, 5).join('；')}${st.split('\n').length > 5 ? '…' : ''}`);
      }
      const already = rec.removed.length ? `（先前已收：${rec.removed.map((t) => (t === rec.tree ? '審查樹' : '突變副本')).join('、')}）` : '';
      if (problems.length) {
        refused = true;
        lines.push(`沒收 r${rec.round}（${folder}）${already}：`, ...problems.map((p) => `  ・${p}`), `  還沒收的${todo.map(([w]) => w).join('、')}都留著；看完要收就自己 git worktree remove（突變副本有改過的檔要加 --force）。`);
        return;
      }
      let failed = null;
      for (const [what, t] of todo.filter(([, x]) => !rec.removed.includes(x))) {
        const unlinked = unlinkNodeModulesSymlinkOnly(t, rec);
        let why;
        try {
          why = remove(rec.root, t);
        } catch (e) {
          if (unlinked) restoreNodeModulesSymlink(t, rec);
          throw e;
        }
        if (why) {
          if (unlinked) restoreNodeModulesSymlink(t, rec);
          failed = `${what}移除失敗：${why}`;
          break;
        }
        if (unlinked) removeNodeModulesStore(t, rec);
        rec.removed.push(t);
        save();
      }
      if (failed) {
        refused = true;
        const done = rec.removed.map((t) => (t === rec.tree ? '審查樹' : '突變副本'));
        lines.push(`收到一半 r${rec.round}（${folder}）：${done.length ? `已收 ${done.join('、')}；` : ''}${failed}。紀錄已記下收了哪幾棵，排除原因後重跑只會收剩下的。`);
        return;
      }
      rec.closedAt = new Date().toISOString();
      save();
      const { groups, unreadable } = freshEntries(leftoverRoots, folder, Date.parse(rec.startedAt), re);
      const freshCount = groups.reduce((sum, g) => sum + g.paths.length, 0);
      const freshNote = freshCount > 0 ? `；暫存區另有 ${freshCount} 筆比開樹晚` : '';
      lines.push(`收好 r${rec.round}${already}：兩棵樹的 HEAD 都還是 ${rec.head.slice(0, 7)}、都乾淨，已移除（提示與輸出檔留在 ${folder}${freshNote}）。`);
      for (const u of unreadable) lines.push(`  ⚠️ 讀不了 ${u}，那裡比開樹晚的沒列`);
      for (const g of groups) {
        lines.push(`  ${g.root} 第一層比開樹晚的 ${g.paths.length} 筆（新的在前；只列、不刪；可能是複審者另建的，也可能是別的程式同時寫的）：`);
        for (const p of g.paths.slice(0, 10)) lines.push(`    ${p}`);
        if (g.paths.length > 10) lines.push(`    另有 ${g.paths.length - 10} 筆沒列`);
      }
    });
  }
  if (!refused && purge) {
    const purgeProblems = [];
    const purgedNames = [];
    for (const folder of allFolders) {
      withContainerLock(folder, `${folder} 正在被另一個程序操作：請稍後再試`, () => {
        if (!fs.existsSync(path.join(folder, 'launch.json'))) return;
        const rec = JSON.parse(fs.readFileSync(path.join(folder, 'launch.json'), 'utf8'));
        const locks = lockedTrees(rec.root);
        let folderHasProblem = false;
        if (
          (expectRound !== null && expectRound !== undefined && rec.round !== expectRound)
          || !matchesExpectHead(rec, expectHead)
          || (expectStartedAt !== null && expectStartedAt !== undefined && rec.startedAt !== expectStartedAt)
        ) {
          purgeProblems.push(`${path.basename(folder)} 的容器紀錄已非本次啟動的那一輪（輪次、版本或開始時間不符）`);
          folderHasProblem = true;
        }
        if (!rec.closedAt) {
          purgeProblems.push(`${path.basename(folder)} 還沒收樹（缺少 closedAt）`);
          folderHasProblem = true;
        }
        for (const [what, t] of [['審查樹', rec.tree], ['突變副本', rec.mutation]]) {
          if (t && (fs.existsSync(t) || locks.has(t))) {
            purgeProblems.push(`${path.basename(folder)} 的${what}還在或仍登記在 git worktree（${t}）`);
            folderHasProblem = true;
          }
        }
        if (!folderHasProblem) {
          fs.rmSync(folder, { recursive: true, force: true });
          purgedNames.push(path.basename(folder));
        }
      });
    }
    if (purgeProblems.length) {
      lines.push('沒清除審查資料夾（--purge）：', ...purgeProblems.map((p) => `  ・${p}`));
      return { code: 1, lines };
    }
    lines.push(`已清除變更 ${changeArg} 已收樹的審查資料夾：${purgedNames.join('、')}`);
  }
  return { code: refused ? 1 : 0, lines };
}

function deriveScanCommand(reviewCmd) {
  if (!filled(reviewCmd)) return '';
  return String(reviewCmd)
    .replace(/--mode\s+review\b/gu, '--mode scan')
    .replace(/,[A-Za-z]+\([^()]*\{mutationCopy\}[^()]*\)|[A-Za-z]+\([^()]*\{mutationCopy\}[^()]*\),/gu, '')
    .replace(/,Bash\(gh pr comment \{change\} \*\)/gu, '')
    .replace(/\s+--[A-Za-z-]+\s+\{mutationCopy\}/gu, '')
    .replace(/\s+--verbose\b/gu, '')
    .replace(/\s+--output-format\s+json\b/gu, '')
    .replace(/,[^,'"\s]*\{mutationCopy\}[^,'"\s]*|[^,'"\s]*\{mutationCopy\}[^,'"\s]*,/gu, '')
    .replace(/請執行複審/gu, '請執行掃描')
    .replace(/\{reviewTree\}/gu, '{scanTree}');
}

function resolveScannerSpec(settings, scannerArg, usable) {
  const sc = (settings && settings.scanner) || {};
  if (sc.tool === '無') {
    throw new LaunchError('本專案沒有設定掃描者（PR說明的「### 複審後掃」下寫「未執行：本專案無掃描者」）');
  }
  const hasConfigured = filled(sc.participant) && sc.participant.trim() !== '無';
  const configuredScanner = hasConfigured ? canonicalRole(sc.participant, usable) : null;
  if (hasConfigured && !configuredScanner) {
    throw new LaunchError(`專案設定的 scanner.participant「${sc.participant || ''}」不是登記過的參與者`);
  }
  if (scannerArg === null || scannerArg === undefined) {
    if (!hasConfigured) {
      throw new LaunchError('本專案沒有設定掃描者（PR說明的「### 複審後掃」下寫「未執行：本專案無掃描者」）');
    }
    for (const k of ['strongest', 'maxEffort', 'source', 'command']) {
      if (!filled(sc[k])) throw new LaunchError(`專案設定的 scanner.${k} 還沒填`);
    }
    return {
      scanner: configuredScanner,
      strongest: sc.strongest,
      maxEffort: sc.maxEffort,
      source: sc.source,
      command: sc.command,
      origin: 'scanner',
    };
  }
  const want = canonicalRole(scannerArg, usable);
  if (!want) {
    throw new LaunchError(`--scanner 給的「${scannerArg || ''}」不是登記過的參與者（${usable.join('／') || '一個都沒登記'}）`);
  }
  if (configuredScanner === want && ['strongest', 'maxEffort', 'source', 'command'].every((k) => filled(sc[k]))) {
    return {
      scanner: want,
      strongest: sc.strongest,
      maxEffort: sc.maxEffort,
      source: sc.source,
      command: sc.command,
      origin: 'scanner',
    };
  }
  const revEntry = (Array.isArray(settings && settings.reviewers) ? settings.reviewers : []).find((r) => r && canonicalRole(r.participant, usable) === want);
  if (!revEntry) {
    throw new LaunchError(`--scanner 給的「${scannerArg}」既不是專案設定的預設掃描者，也不在 reviewers 清單裡：不知道它用什麼模型、怎麼起`);
  }
  for (const k of ['strongest', 'maxEffort', 'source']) {
    if (!filled(revEntry[k])) throw new LaunchError(`專案設定裡「${want}」那一列的 ${k} 還沒填`);
  }
  const rawCmd = filled(revEntry.scanCommand) ? revEntry.scanCommand : deriveScanCommand(revEntry.command);
  if (!filled(rawCmd)) throw new LaunchError(`專案設定裡「${want}」那一列的 command 還沒填`);
  return {
    scanner: want,
    strongest: revEntry.strongest,
    maxEffort: revEntry.maxEffort,
    source: revEntry.source,
    command: rawCmd,
    origin: 'reviewers',
  };
}

function scanLaunch(changeArg, { scanner: scannerArg = null, tier: tierArg = null, settings = readSettings(), platform = { ask }, cwd = process.cwd(), dir: dirArg = os.tmpdir(), template = null, now = () => new Date() } = {}) {
  const dir = realDir(dirArg);
  const { usable } = rolesOf(settings);
  const ownerRole = canonicalRole(settings && settings.owner, usable);
  if (tierArg !== null && tierArg !== undefined && !TIER_ORDER.includes(tierArg)) {
    throw new LaunchError(`--tier 給的「${tierArg}」不是高／中／低`);
  }
  const spec = resolveScannerSpec(settings, scannerArg, usable);
  const scanner = spec.scanner;
  const used = new Set([...spec.command.matchAll(TOKEN)].map((m) => m[1]));
  if (!used.has('model') || !used.has('effort') || !used.has('scanTree')) {
    const label = spec.origin === 'scanner' ? 'scanner.command' : `「${scanner}」的掃描啟動指令樣板`;
    throw new LaunchError(`${label} 沒帶 {model}、{effort} 或 {scanTree}：漏帶時掃描者照預設跑或不在掃描樹目錄下執行（G1）`);
  }
  const rl = settings.reviewLaunch || {};
  for (const k of ['changeLink', 'commentLink', 'postComment']) {
    if (!filled(rl[k])) throw new LaunchError(`專案設定的 reviewLaunch.${k} 還沒填`);
  }
  const project = settings.platform && settings.platform.project;
  if (!filled(project)) throw new LaunchError('專案設定的 platform.project 還沒填');
  const tpl = template === null ? fs.readFileSync(SCAN_TEMPLATE, 'utf8') : template;

  const change = askPlatform(platform, settings, 'change', { change: String(changeArg) });
  const id = change.id;
  const head = change.headSha;
  const reviewer = canonicalRole(fieldValue(change.body, '複審者'), usable);
  if (!reviewer) throw new LaunchError('PR說明的「複審者」欄讀不出一位登記過的參與者');
  if (ownerRole && reviewer === ownerRole) {
    throw new LaunchError('這一支複審者是擁有者（走快速通道（擁有者）），照 G1、F12 不掃描（PR說明的「### 複審後掃」下寫「未執行：快速通道（擁有者）」）');
  }
  const implementer = canonicalRole(fieldValue(change.body, '實作者'), usable);
  if (!implementer) throw new LaunchError('PR說明的「實作者」欄讀不出一位登記過的參與者');
  if (scanner === implementer || scanner === reviewer) {
    throw new LaunchError(`掃描者 ${scanner} 與本支實作者（${implementer}）或複審者（${reviewer}）重疊：G1 規定由第三個 AI 掃描`);
  }
  const base = askPlatform(platform, settings, 'branchSha', { branch: change.baseBranch }).sha;
  const comments = askPlatform(platform, settings, 'comments', { change: id });
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const fetched = gitOk(root, ['fetch', '--quiet']);
  const risk = riskRun(id, { settings, platform, git: gitIn(root) });
  if (risk.code !== 0) throw new LaunchError(`風險級別算不出來：${risk.lines.join(' ')}`);
  if (risk.result.head !== head) throw new LaunchError(`準備掃描期間這一支換了版本（目前 ${String(head).slice(0, 12)}，算風險時是 ${String(risk.result.head).slice(0, 12)}）：請重跑一次`);
  const fileTier = risk.result.level;
  const bodyTierRaw = (fieldValue(change.body, '風險級別') || ((/^[ \t]*(?:-[ \t]*)?(?:\*\*)?風險級別(?:\*\*)?[：:][ \t]*([^\n]+)/mu.exec(String(change.body || '')) || [])[1] || '')).trim();
  let bodyTier = null;
  if (bodyTierRaw) {
    const m = /^(高|中|低)/u.exec(bodyTierRaw);
    if (!m) throw new LaunchError(`PR說明的「風險級別」欄「${bodyTierRaw}」讀不出高／中／低`);
    bodyTier = m[1];
  }
  for (const [label, candidate] of [['PR說明的「風險級別」', bodyTier], ['--tier', tierArg]]) {
    if (candidate && TIER_ORDER.indexOf(candidate) > TIER_ORDER.indexOf(fileTier)) {
      throw new LaunchError(`風險級別只升不降（D4）：依檔案算是${fileTier}風險，${label}不可調輕為${candidate}風險`);
    }
  }
  const tier = [fileTier, bodyTier, tierArg].filter(Boolean).reduce((a, b) => (TIER_ORDER.indexOf(b) < TIER_ORDER.indexOf(a) ? b : a));
  const reviewerEntry = (Array.isArray(settings.reviewers) ? settings.reviewers : []).find((r) => r && r.participant === reviewer);
  const lane = risk.result.fastLaneAI === true;
  const exhausted = lane && reviewerEntry && filled(reviewerEntry.source) && twoMissesInARow(comments, reviewer, reviewerEntry.source, usable);
  if (lane && !exhausted) {
    throw new LaunchError('這一支走快速通道（AI），照 G1、F12 不掃描（PR說明的「### 複審後掃」下寫「未執行：快速通道（AI）」）');
  }
  const tierRow = (settings.reviewTiers || {})[tier];
  if (!tierRow || !filled(tierRow.scan)) throw new LaunchError(`複審與掃描分級表找不到「${tier}」風險的掃描規定`);
  if (tierRow.scan === '不掃') {
    throw new LaunchError(`這一支是${tier}風險，照分級表不掃描（PR說明的「### 複審後掃」下寫「未執行：${tier}風險，表定不掃」）`);
  }

  const verdicts = evaluateVerdicts(comments, head, reviewer, usable, { ownerRole });
  if (verdicts.unsure) throw new LaunchError('這一支有結論留言的時間讀不出來：判不了是否已通過複審');
  if (verdicts.problems.length > 0) {
    throw new LaunchError(`目前版本 ${head.slice(0, 7)} 還沒有指定複審者 ${reviewer} 的合格「通過」結論（或尚有阻擋結論）：G1 規定複審「通過」之後才起掃描`);
  }
  const time = (c) => { const v = parseInstant(c.createdAt); return v === null ? Infinity : v; };
  const passComments = comments
    .map((c) => ({ c, h: headerOf(c.body, usable) }))
    .filter((x) => x.h && x.h.role === reviewer && !x.h.blocking && (x.h.role === ownerRole || missingHeadings(x.c.body).length === 0) && String(head).toLowerCase().startsWith(x.h.sha))
    .sort((a, b) => time(a.c) - time(b.c));
  if (!passComments.length) throw new LaunchError(`找不到 ${reviewer} 對目前版本 ${head.slice(0, 7)} 的合格「通過」留言`);
  const passComment = passComments[0].c;
  const passCommentLink = substitute(rl.commentLink, { project, change: id, comment: passComment.id }, '留言網址樣板').text;

  for (const [what, sha] of [['要掃的版本', head], ['基底', base]]) {
    if (!gitOk(root, ['cat-file', '-e', `${sha}^{commit}`])) throw new LaunchError(`本機倉庫沒有${what} ${sha}${fetched ? '' : '（git fetch 也沒成功）'}：開不了掃描樹`);
  }
  const folder = path.join(dir, `scan-${slugOf(project)}-${String(id).replace(/[^A-Za-z0-9._-]/gu, '')}`);
  const tree = path.join(folder, 'tree');
  const promptFile = path.join(folder, 'prompt.md');
  const outFile = path.join(folder, 'output.log');
  const tokens = { model: spec.strongest, effort: spec.maxEffort, scanTree: tree, promptFile, outFile, change: id, project };
  if (Object.keys(tokens).sort().join() !== [...SCAN_COMMAND_TOKENS].sort().join()) throw new Error('SCAN_COMMAND_TOKENS 跟這一張對不上（程式寫錯）');
  const command = substitute(spec.command, tokens, `掃描者「${scanner}」的啟動指令樣板`).text;
  const values = {
    project, change: id, scanner, implementer, reviewer, source: spec.source,
    head, headShort: head.slice(0, 7), baseBranch: change.baseBranch, base, tier,
    changeLink: substitute(rl.changeLink, { project, change: id }, 'PR 網址樣板').text,
    passCommentLink,
    scanTree: tree,
    fullDiff: `git diff ${base}...${head}`,
  };
  const prompt = fill(tpl, values, SCAN_FILL);
  const canReplaceClosedScan = () => {
    try {
      if (fs.existsSync(path.join(folder, 'post.lock'))) return false;
      const prevScan = JSON.parse(fs.readFileSync(path.join(folder, 'scan.json'), 'utf8'));
      const prevLocks = prevScan && prevScan.root ? lockedTrees(prevScan.root) : new Map();
      return Boolean(
        prevScan
        && prevScan.closedAt
        && (!prevScan.tree || (!fs.existsSync(prevScan.tree) && !prevLocks.has(prevScan.tree)))
        && (prevScan.head !== head || !prevScan.postedAt),
      );
    } catch {
      return false;
    }
  };
  if (fs.existsSync(folder) && !canReplaceClosedScan()) {
    throw new LaunchError(`${folder} 已經在了：上一次的掃描樹還沒收（先跑 --scan-close ${id}），或這一支已經掃過`);
  }

  const record = {
    change: id, scanner, source: spec.source, reviewer, implementer, tier,
    head, base, passCommentId: passComment.id, passCommentLink,
    root, tree, promptFile, outFile, startedAt: now().toISOString(),
  };
  withContainerLock(
    folder,
    `${folder} 已經在了：另一個掃描剛好在開同一支，或上一次的掃描樹還沒收（先跑 --scan-close ${id}）`,
    () => {
      if (fs.existsSync(folder)) {
        if (!canReplaceClosedScan()) {
          throw new LaunchError(`${folder} 已經在了：另一個掃描剛好在開同一支，或上一次的掃描樹還沒收（先跑 --scan-close ${id}），或這一支已經掃過`);
        }
        fs.rmSync(folder, { recursive: true, force: true });
      }
      const before = new Set(lockedTrees(root).keys());
      try { fs.mkdirSync(folder); } catch (e) {
        if (e && e.code === 'EEXIST') throw new LaunchError(`${folder} 已經在了：另一個掃描剛好在開同一支，或上一次的掃描樹還沒收（先跑 --scan-close ${id}）`);
        throw e;
      }
      const created = [];
      try {
        git(root, ['worktree', 'add', '--detach', '-q', tree, head]);
        created.push(tree);
        const got = git(tree, ['rev-parse', 'HEAD']);
        if (got !== head) throw new LaunchError(`${tree} 開出來是 ${got}，不是要掃的版本 ${head}`);
        linkNodeModules(root, folder, [tree], record);
        try {
          fs.writeFileSync(promptFile, prompt);
          fs.writeFileSync(path.join(folder, 'scan.json'), `${JSON.stringify(record, null, 1)}\n`);
        } catch (writeErr) {
          throw new LaunchError(`寫入掃描提示或紀錄失敗：${(writeErr && writeErr.message) || '不明錯誤'}`);
        }
      } catch (e) {
        let registered = created;
        try { registered = [...lockedTrees(root).keys()].filter((t) => t.startsWith(`${folder}${path.sep}`) && !before.has(t)); } catch { /* ignore */ }
        for (const t of new Set([...created, ...registered])) {
          unlinkNodeModules(t, record);
          gitOk(root, ['worktree', 'remove', '--force', t]);
        }
        fs.rmSync(folder, { recursive: true, force: true });
        throw e;
      }
    },
  );
  const lines = [
    `掃描準備｜變更 ${id}｜掃描者 ${scanner}（來源 ${spec.source}）｜掃 ${head.slice(0, 7)}｜基底 ${change.baseBranch} 的 ${base.slice(0, 7)}`,
    `  風險級別：${tier}（分級表規定：${tierRow.scan}）｜依據的複審通過留言：${passCommentLink}`,
    `  掃描樹：${tree}（HEAD ${head.slice(0, 7)}）`,
    `  掃描提示：${promptFile}（照 templates/scan-record.md 填好）`,
    fetched ? null : '  ⚠️ git fetch 沒成功：本機已經有這兩顆版本，照樣開了掃描樹。',
    `啟動指令（模型 ${spec.strongest}、推理 ${spec.maxEffort}）：`,
    command,
    `跑完：跑 node tools/review-launch.js --scan-post ${id}${dir === realDir(os.tmpdir()) ? '' : ` --dir ${dir}`} 先核掃描樹乾淨與標頭（且不含 🤖）再代貼 🔍 掃描留言；收樹：node tools/review-launch.js --scan-close ${id}${dir === realDir(os.tmpdir()) ? '' : ` --dir ${dir}`}`,
  ].filter((l) => l !== null);
  return { code: 0, lines, record, command, prompt };
}

/**
 * 核對掃描回覆：若為 CLI 結構化 JSON 成功包裹（如 Claude `--output-format json` 的 `result` 欄位）先解開純文字；
 * 去除首尾空行，若最後一行單獨是「未貼」就剝掉；
 * 擋下最後正文全文含複審結論記號 🤖 的內容（以免觸發結論聯集閘壞標頭擋下）；
 * 擋下回覆自帶的「掃描時序」行（時序證據一律由 --scan-post 外殼依實際紀錄產生）；
 * 核第一行 🔍 標頭（角色、來源、掃描版本短碼）與後續內容非空，並在第二行補上 `> 掃描時序：...` 引用行。
 */
function prepareScan(raw, { scanner, source, head, usable, passCommentLink = null, startedAt = null, postedAt = null, base = null, forceGrok = false }) {
  const unwrapped = unwrapScanOutput(raw, '掃描回覆', forceGrok);
  const lines = String(unwrapped ?? '').replace(/\r\n?/g, '\n').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) throw new LaunchError('掃描回覆檔是空的');
  let strippedUnposted = false;
  if (lines[lines.length - 1].replace(/[ \t]+$/u, '') === '未貼') {
    strippedUnposted = true;
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  }
  if (!lines.length) throw new LaunchError('掃描回覆檔只有「未貼」，沒有掃描內容');
  if (/🤖/u.test(lines.join('\n'))) {
    throw new LaunchError('掃描回覆含有複審結論記號 🤖：結論聯集閘會把含 🤖 的非結論留言當成壞標頭擋下（F4、G1），請移除後再代貼');
  }
  const m = SCAN_HEADER.exec(lines[0]);
  if (!m) {
    throw new LaunchError('掃描回覆第一行不是合規標頭（格式：🔍 <識別值>｜來源：<來源字串>｜掃 `<短碼>`；標頭前不可有前言或工具雜訊）');
  }
  const role = canonicalRole(m[1], usable);
  if (!role || role !== scanner) throw new LaunchError(`掃描標頭的角色是「${m[1]}」，不是本支掃描者 ${scanner}`);
  const gotSource = m[2].trim().replace(/\s+/gu, ' ');
  const wantSource = String(source).trim().replace(/\s+/gu, ' ');
  if (gotSource !== wantSource) throw new LaunchError(`掃描標頭的來源是「${gotSource}」，不是設定登記的「${wantSource}」`);
  const sha = m[3].toLowerCase();
  if (!String(head).toLowerCase().startsWith(sha)) {
    throw new LaunchError(`掃描標頭掃的是 ${sha}，對不上要掃的版本 ${String(head).slice(0, 7)}`);
  }
  const rest = lines.slice(1);
  while (rest.length && rest[0].trim() === '') rest.shift();
  if (!rest.length) throw new LaunchError('掃描回覆只有標頭、沒有掃描內容（零發現請寫「- 零發現」）');
  if (rest.some((l) => /^[ \t]*>?[ \t]*(?:\*\*|__)?[ \t]*掃描時序/u.test(l))) {
    throw new LaunchError('掃描回覆不可自帶「掃描時序」行（時序證據一律由 --scan-post 外殼依實際紀錄產生）');
  }
  const timingLine = passCommentLink && startedAt && postedAt && base
    ? `> 掃描時序：依據複審留言 ${passCommentLink}｜準備 ${startedAt}｜代貼 ${postedAt}｜範圍 \`${String(base).slice(0, 7)}..${String(head).slice(0, 7)}\``
    : null;
  const outLines = [lines[0]];
  if (timingLine) {
    outLines.push(timingLine, '');
  } else {
    outLines.push('');
  }
  outLines.push(...rest);
  return {
    body: `${outLines.join('\n')}\n`,
    header: { role, source: gotSource, sha },
    strippedUnposted,
  };
}

function scanPost(changeArg, { settings = readSettings(), platform = { ask }, dir: dirArg = os.tmpdir(), file: fileArg = null, runPost = defaultRunPost, now = () => new Date(), expectHead = null, expectStartedAt = null } = {}) {
  const dir = realDir(dirArg);
  const project = settings.platform && settings.platform.project;
  if (!filled(project)) throw new LaunchError('專案設定的 platform.project 還沒填：找不到掃描樹放在哪');
  const rl = settings.reviewLaunch || {};
  if (!filled(rl.postComment)) throw new LaunchError('專案設定的 reviewLaunch.postComment 還沒填：不知道怎麼代貼掃描留言');
  const { usable } = rolesOf(settings);
  const folder = path.join(dir, `scan-${slugOf(project)}-${String(changeArg).replace(/[^A-Za-z0-9._-]/gu, '')}`);
  const recFile = path.join(folder, 'scan.json');
  if (!fs.existsSync(recFile)) throw new LaunchError(`在 ${dir} 底下找不到變更 ${changeArg} 的掃描紀錄（${folder}/scan.json）`);
  return withPostLock(folder, () => {
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    if (String(rec.change) !== String(changeArg)) throw new LaunchError(`scan.json 記的變更編號是 ${rec.change}，不是參數給的 ${changeArg}`);
    if (!matchesExpectHead(rec, expectHead)) {
      const [shownActual, shownWant] = formatHeadPair(rec.head, expectHead);
      throw new LaunchError(`scan.json 記的掃描版本是 ${shownActual}，不是本次啟動的 ${shownWant}`);
    }
    if (expectStartedAt !== null && expectStartedAt !== undefined && rec.startedAt !== expectStartedAt) {
      throw new LaunchError(`scan.json 記的啟動時間是 ${rec.startedAt}，不是本次啟動的 ${expectStartedAt}`);
    }
    if (rec.closedAt) throw new LaunchError(`掃描樹（${folder}）已經在 ${rec.closedAt} 收樹，不代貼掃描留言`);
    if (rec.postedAt) throw new LaunchError(`掃描樹（${folder}）已經在 ${rec.postedAt} 代貼過掃描留言，不重複貼`);

    const locks = lockedTrees(rec.root);
    const removed = Array.isArray(rec.removed) ? rec.removed : [];
    const problems = [];
    const t = rec.tree;
    if (removed.includes(t)) problems.push('掃描樹已經收掉了（代貼掃描留言前掃描樹要還在、好核對乾淨與 HEAD）');
    else if (!fs.existsSync(t)) problems.push(`掃描樹不見了（${t}）`);
    else {
      if (!locks.has(t)) problems.push(`掃描樹不在 git worktree 登記裡（${t}）`);
      else if (locks.get(t)) problems.push('掃描樹上了鎖');
      const h = gitOk(t, ['rev-parse', 'HEAD']) ? git(t, ['rev-parse', 'HEAD']) : null;
      if (h !== rec.head) problems.push(`掃描樹的 HEAD 是 ${h || '讀不出'}，不是要掃的版本 ${rec.head.slice(0, 7)}`);
      const st = treeStatus(t, rec);
      if (st === null) problems.push('掃描樹的狀態讀不出');
      else if (st) problems.push(`掃描樹不乾淨：${st.split('\n').slice(0, 5).join('；')}${st.split('\n').length > 5 ? '…' : ''}`);
    }
    if (problems.length) {
      return {
        code: 1,
        lines: [
          `沒貼掃描留言（${folder}）：`,
          ...problems.map((p) => `  ・${p}`),
          '  掃描樹要在、乾淨、HEAD 沒變、沒上鎖，才代貼掃描留言。',
        ],
      };
    }

    const srcPath = fileArg ? path.resolve(fileArg) : rec.outFile;
    if (!filled(srcPath)) throw new LaunchError('找不到掃描回覆檔路徑');
    let st;
    try { st = fs.lstatSync(srcPath); } catch (e) { throw new LaunchError(`讀不到掃描回覆檔 ${srcPath}（${e.code || e.message}）`); }
    if (!st.isFile()) throw new LaunchError(`掃描回覆檔 ${srcPath} 不是一般檔案（不收連結或資料夾）`);
    const realSrc = fs.realpathSync(srcPath);
    let realT = null;
    try { realT = fs.realpathSync(t); } catch { /* ignore */ }
    if (realT && (realSrc === realT || realSrc.startsWith(`${realT}${path.sep}`))) {
      throw new LaunchError(`掃描回覆檔不可放在掃描樹裡面（${realSrc}）`);
    }
    const raw = fs.readFileSync(realSrc, 'utf8');
    const nowIso = now().toISOString();
    const isGrok = String(rec.source).includes('Grok');
    const prepared = prepareScan(raw, {
      scanner: rec.scanner, source: rec.source, head: rec.head, usable,
      passCommentLink: rec.passCommentLink, startedAt: rec.startedAt, postedAt: nowIso, base: rec.base,
      forceGrok: isGrok
    });

    const sub = substitute(rl.postComment, { project, change: rec.change }, '貼留言的指令');
    if (!sub.used.includes('change')) throw new LaunchError('reviewLaunch.postComment 沒帶 {change}：不知道要貼到哪一支');
    const parts = splitCommandArgs(sub.text);
    if (parts.length < 2 || !parts.includes(FILE_SLOT)) {
      throw new LaunchError(`reviewLaunch.postComment 要包含獨立的 ${FILE_SLOT} 佔位`);
    }

    const change = askPlatform(platform, settings, 'change', { change: String(rec.change) });
    if (change.headSha !== rec.head) {
      throw new LaunchError(`平台目前版本是 ${String(change.headSha).slice(0, 7)}，不是開掃描樹時的 ${String(rec.head).slice(0, 7)}：版本已變，不代貼舊版掃描`);
    }
    const comments = askPlatform(platform, settings, 'comments', { change: rec.change });
    const wantSource = String(rec.source).trim().replace(/\s+/gu, ' ');
    const alreadyOnPlatform = comments.some((c) => {
      const firstLine = String(c.body || '').replace(/\r\n?/g, '\n').split('\n').find((l) => l.trim() !== '') || '';
      const m = SCAN_HEADER.exec(firstLine);
      if (!m) return false;
      const r = canonicalRole(m[1], usable);
      const s = m[2].trim().replace(/\s+/gu, ' ');
      return r === rec.scanner && s === wantSource && String(rec.head).toLowerCase().startsWith(m[3].toLowerCase());
    });
    if (alreadyOnPlatform) throw new LaunchError(`平台上已經有 ${rec.scanner}（${wantSource}）對 ${rec.head.slice(0, 7)} 的 🔍 掃描留言：不重複貼`);

    const replyFile = path.join(folder, `scan-reply-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.md`);
    fs.writeFileSync(replyFile, prepared.body, { flag: 'wx' });
    const argv = parts.map((p) => (p === FILE_SLOT ? replyFile : p));
    const clearEnv = Array.isArray(settings.platform && settings.platform.clearEnv) ? settings.platform.clearEnv : [];
    runPost(argv[0], argv.slice(1), { clearEnv });
    const latestRec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    if (latestRec.head !== rec.head || latestRec.startedAt !== rec.startedAt || latestRec.closedAt) {
      throw new LaunchError('代貼期間容器紀錄已變更或已收樹，拒絕覆寫新紀錄');
    }
    rec.postedAt = nowIso;
    rec.replyFile = replyFile;
    writeJsonAtomic(recFile, rec);
    return {
      code: 0,
      lines: [
        `已代貼掃描留言｜變更 ${rec.change}｜掃描者 ${rec.scanner}（來源 ${wantSource}）｜掃 ${rec.head.slice(0, 7)}${prepared.strippedUnposted ? '（已剝除文末「未貼」）' : ''}`,
        `  掃描樹的 HEAD 還是 ${rec.head.slice(0, 7)}、狀態乾淨；收樹跑：node tools/review-launch.js --scan-close ${rec.change}${dir === realDir(os.tmpdir()) ? '' : ` --dir ${dir}`}`,
      ],
      record: rec,
      header: prepared.header,
      body: prepared.body,
      argv,
    };
  });
}

function scanClose(changeArg, { settings = readSettings(), dir: dirArg = os.tmpdir(), leftoverRoots = [os.tmpdir(), '/tmp'], remove = removeTree, purge = false, expectHead = null, expectStartedAt = null } = {}) {
  const dir = realDir(dirArg);
  const project = settings.platform && settings.platform.project;
  if (!filled(project)) throw new LaunchError('專案設定的 platform.project 還沒填：找不到掃描樹放在哪');
  const cleanId = String(changeArg).replace(/[^A-Za-z0-9._-]/gu, '');
  const folder = path.join(dir, `scan-${slugOf(project)}-${cleanId}`);
  return withContainerLock(folder, `${folder} 正在被另一個程序操作：請稍後再試`, () => {
    const recFile = path.join(folder, 'scan.json');
    if (!fs.existsSync(recFile)) throw new LaunchError(`在 ${dir} 底下找不到變更 ${changeArg} 還開著的掃描樹（${ path.basename(folder) }）`);
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    if (
      !matchesExpectHead(rec, expectHead)
      || (expectStartedAt !== null && expectStartedAt !== undefined && rec.startedAt !== expectStartedAt)
    ) {
      return {
        code: 1,
        lines: [`沒收掃描樹（${folder}）：掃描容器紀錄已非本次啟動的那一輪（版本或開始時間不符）。`],
      };
    }
    if (rec.closedAt && !purge) throw new LaunchError(`在 ${dir} 底下找不到變更 ${changeArg} 還開著的掃描樹（${ path.basename(folder) } 已於 ${rec.closedAt} 收樹）`);
    const save = () => fs.writeFileSync(recFile, `${JSON.stringify(rec, null, 1)}\n`);
    rec.removed = Array.isArray(rec.removed) ? rec.removed : [];
    const t = rec.tree;
    const lines = [];
    if (!rec.closedAt) {
      const locks = lockedTrees(rec.root);
      const problems = [];
      if (!rec.removed.includes(t)) {
        if (!fs.existsSync(t)) {
          if (!locks.has(t)) { rec.removed.push(t); save(); lines.push('  掃描樹已經不在、git 也沒登記：當作收過。'); }
          else problems.push(`掃描樹不見了（${t}），git 還登記著`);
        } else {
          if (locks.get(t)) problems.push('掃描樹上了鎖（git worktree unlock 之後再收）');
          const h = gitOk(t, ['rev-parse', 'HEAD']) ? git(t, ['rev-parse', 'HEAD']) : null;
          if (h !== rec.head) problems.push(`掃描樹的 HEAD 是 ${h || '讀不出'}，不是要掃的版本 ${rec.head.slice(0, 7)}`);
          const st = treeStatus(t, rec);
          if (st === null) problems.push('掃描樹的狀態讀不出');
          else if (st) problems.push(`掃描樹不乾淨：${st.split('\n').slice(0, 5).join('；')}${st.split('\n').length > 5 ? '…' : ''}`);
        }
      }
      if (problems.length) {
        lines.push(`沒收掃描樹（${folder}）：`, ...problems.map((p) => `  ・${p}`), '  掃描樹留著；看完要收就自己 git worktree remove。');
        return { code: 1, lines };
      }
      if (!rec.removed.includes(t)) {
        const unlinked = unlinkNodeModulesSymlinkOnly(t, rec);
        let why;
        try {
          why = remove(rec.root, t);
        } catch (e) {
          if (unlinked) restoreNodeModulesSymlink(t, rec);
          throw e;
        }
        if (why) {
          if (unlinked) restoreNodeModulesSymlink(t, rec);
          lines.push(`沒收掃描樹（${folder}）：掃描樹移除失敗：${why}`);
          return { code: 1, lines };
        }
        if (unlinked) removeNodeModulesStore(t, rec);
        rec.removed.push(t);
        save();
      }
      rec.closedAt = new Date().toISOString();
      save();
      const re = scanFolderRe(slugOf(project), cleanId);
      const { groups, unreadable } = freshEntries(leftoverRoots, folder, Date.parse(rec.startedAt), re);
      const freshCount = groups.reduce((sum, g) => sum + g.paths.length, 0);
      const freshNote = freshCount > 0 ? `；暫存區另有 ${freshCount} 筆比開樹晚` : '';
      lines.push(`收好掃描樹：HEAD 還是 ${rec.head.slice(0, 7)}、狀態乾淨，已移除（提示與輸出檔留在 ${folder}${freshNote}）。`);
      for (const u of unreadable) lines.push(`  ⚠️ 讀不了 ${u}，那裡比開樹晚的沒列`);
      for (const g of groups) {
        lines.push(`  ${g.root} 第一層比開樹晚的 ${g.paths.length} 筆（新的在前；只列、不刪）：`);
        for (const p of g.paths.slice(0, 10)) lines.push(`    ${p}`);
        if (g.paths.length > 10) lines.push(`    另有 ${g.paths.length - 10} 筆沒列`);
      }
    }
    if (purge) {
      const locks = lockedTrees(rec.root);
      if (t && (fs.existsSync(t) || locks.has(t))) {
        lines.push('沒清除掃描資料夾（--purge）：', `  ・${path.basename(folder)} 的掃描樹還在或仍登記在 git worktree（${t}）`);
        return { code: 1, lines };
      }
      fs.rmSync(folder, { recursive: true, force: true });
      lines.push(`已清除變更 ${changeArg} 已收樹的掃描資料夾：${path.basename(folder)}`);
    }
    return { code: 0, lines };
  });
}

const GROK_PINNED_ISSUER = 'https://auth.x.ai';
const GROK_PINNED_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_DUMMY_BEARER_PREFIX = 'DUMMY-SCAN-TOKEN-';
const GROK_UPSTREAM_HOST = 'cli-chat-proxy.grok.com';
const GROK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GROK_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/u;
const GROK_BOX_FIELDS = Object.freeze({
  auth_mode: (v) => typeof v === 'string' && /^[a-z_]{1,16}$/u.test(v),
  user_id: (v) => typeof v === 'string' && GROK_UUID_RE.test(v),
  create_time: (v) => typeof v === 'string' && GROK_ISO_RE.test(v),
  expires_at: (v) => typeof v === 'string' && GROK_ISO_RE.test(v),
  oidc_issuer: (v) => v === GROK_PINNED_ISSUER,
  oidc_client_id: (v) => v === GROK_PINNED_CLIENT_ID,
});
const GROK_ENUM_FIELDS = Object.freeze(['principal_type']);
const GROK_ALLOWED_REQUESTS = Object.freeze([
  { method: 'GET', path: /^\/v1\/models$/u },
  { method: 'GET', path: /^\/v1\/settings$/u },
  { method: 'GET', path: /^\/v1\/feedback\/config$/u },
  { method: 'POST', path: /^\/v1\/responses$/u },
  { method: 'POST', path: /^\/v1\/sessions\/[0-9a-f-]{36}\/signals$/u },
  { method: 'POST', path: /^\/v1\/sessions\/[0-9a-f-]{36}\/turn-deltas$/u },
  { method: 'POST', path: /^\/v1\/traces$/u },
]);
const GROK_TOLERATED_REFUSALS = Object.freeze([
  'shape GET /v1/bundle/archive',
  'shape GET /v1/subagents/bundle',
  'shape GET /',
]);
const GROK_HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade', 'host']);

const GROK_SEATBELT_PROFILE = [
  '(version 1)',
  '(deny default)',
  '(import "system.sb")',
  '(allow process-fork) (allow signal) (allow sysctl-read)',
  '(allow process-exec*',
  '  (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System")',
  '  (subpath "/Library/Developer/CommandLineTools")',
  '  (subpath "/opt/homebrew/Cellar/ada-url/3.4.4")',
  '  (subpath "/opt/homebrew/Cellar/brotli/1.2.0")',
  '  (subpath "/opt/homebrew/Cellar/c-ares/1.34.6")',
  '  (subpath "/opt/homebrew/Cellar/hdrhistogram_c/0.11.9")',
  '  (subpath "/opt/homebrew/Cellar/icu4c@78/78.3")',
  '  (subpath "/opt/homebrew/Cellar/libnghttp2/1.69.0")',
  '  (subpath "/opt/homebrew/Cellar/libnghttp3/1.15.0")',
  '  (subpath "/opt/homebrew/Cellar/libngtcp2/1.22.1")',
  '  (subpath "/opt/homebrew/Cellar/libuv/1.52.1")',
  '  (subpath "/opt/homebrew/Cellar/llhttp/9.4.1")',
  '  (subpath "/opt/homebrew/Cellar/merve/1.2.2_1")',
  '  (subpath "/opt/homebrew/Cellar/nbytes/0.1.4")',
  '  (subpath "/opt/homebrew/Cellar/node/26.0.0")',
  '  (subpath "/opt/homebrew/Cellar/openssl@3/3.6.2")',
  '  (subpath "/opt/homebrew/Cellar/simdjson/4.6.4")',
  '  (subpath "/opt/homebrew/Cellar/simdutf/9.0.0")',
  '  (subpath "/opt/homebrew/Cellar/sqlite/3.53.1")',
  '  (subpath "/opt/homebrew/Cellar/uvwasi/0.0.23")',
  '  (subpath "/opt/homebrew/Cellar/zstd/1.5.7_1")',
  '  (subpath (param "SCAN_DIR")))',
  '(allow file-read*',
  '  (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System")',
  '  (subpath "/Library/Developer/CommandLineTools")',
  '  (subpath "/Library/Preferences/Logging") (subpath "/private/etc")',
  '  (subpath "/private/var/db/timezone") (subpath "/private/var/select")',
  '  (subpath "/opt/homebrew/etc/openssl@3")',
  '  (subpath "/opt/homebrew/Cellar/ada-url/3.4.4")',
  '  (subpath "/opt/homebrew/Cellar/brotli/1.2.0")',
  '  (subpath "/opt/homebrew/Cellar/c-ares/1.34.6")',
  '  (subpath "/opt/homebrew/Cellar/hdrhistogram_c/0.11.9")',
  '  (subpath "/opt/homebrew/Cellar/icu4c@78/78.3")',
  '  (subpath "/opt/homebrew/Cellar/libnghttp2/1.69.0")',
  '  (subpath "/opt/homebrew/Cellar/libnghttp3/1.15.0")',
  '  (subpath "/opt/homebrew/Cellar/libngtcp2/1.22.1")',
  '  (subpath "/opt/homebrew/Cellar/libuv/1.52.1")',
  '  (subpath "/opt/homebrew/Cellar/llhttp/9.4.1")',
  '  (subpath "/opt/homebrew/Cellar/merve/1.2.2_1")',
  '  (subpath "/opt/homebrew/Cellar/nbytes/0.1.4")',
  '  (subpath "/opt/homebrew/Cellar/node/26.0.0")',
  '  (subpath "/opt/homebrew/Cellar/openssl@3/3.6.2")',
  '  (subpath "/opt/homebrew/Cellar/simdjson/4.6.4")',
  '  (subpath "/opt/homebrew/Cellar/simdutf/9.0.0")',
  '  (subpath "/opt/homebrew/Cellar/sqlite/3.53.1")',
  '  (subpath "/opt/homebrew/Cellar/uvwasi/0.0.23")',
  '  (subpath "/opt/homebrew/Cellar/zstd/1.5.7_1"))',
  '(allow file-read-metadata)',
  '(allow file-read* file-write*',
  '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom")',
  '  (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") (literal "/dev/fd"))',
  '(allow file-ioctl (regex #"^/dev/"))',
  '(allow file-read* (subpath (param "SCAN_DIR")))',
  '(allow file-write*',
  '  (subpath (string-append (param "SCAN_DIR") "/grok-home"))',
  '  (subpath (string-append (param "SCAN_DIR") "/tmp"))',
  '  (subpath (string-append (param "SCAN_DIR") "/mutation")))',
  '(deny file-write*',
  '  (subpath (string-append (param "SCAN_DIR") "/worktree"))',
  '  (subpath (string-append (param "SCAN_DIR") "/mutation/.git"))',
  '  (literal (string-append (param "SCAN_DIR") "/prompt.md")))',
  '(allow network-outbound (remote tcp (string-append "localhost:" (param "RELAY_PORT"))))',
  '(allow network-bind (local tcp "localhost:*"))',
  '(allow network-inbound (local tcp "localhost:*"))',
  '(allow system-socket)',
  '(deny process-exec* (literal "/usr/bin/security"))',
  '(deny process-exec* (literal "/usr/bin/open"))',
  '(deny process-exec* (literal "/usr/bin/osascript"))',
  '(deny network-outbound (remote unix-socket))',
  '(deny mach-lookup (global-name-prefix ""))',
  '(deny file-read* process-exec* (subpath "/usr/local"))',
].join('\n');

function verifyGrokSeatbeltProfile(profile = GROK_SEATBELT_PROFILE) {
  if (typeof profile !== 'string' || !profile.startsWith('(version 1)\n(deny default)\n(import "system.sb")\n')) {
    return { ok: false, reason: 'Seatbelt 規則不是 (version 1) + (deny default) + (import "system.sb") 起手' };
  }
  if (profile.includes('(allow default)')) {
    return { ok: false, reason: 'Seatbelt 規則不可含 (allow default)' };
  }
  for (const forbidden of ['auth.json', '.grok', '/Users/', '/private/tmp', '/var/tmp', '/opt/homebrew/var', '/Library/Application Support']) {
    if (profile.includes(forbidden)) {
      return { ok: false, reason: `Seatbelt 規則不可放行宿主敏感或未列名路徑：${forbidden}` };
    }
  }
  if (profile.includes('(allow file-read* file-write* (subpath (param "SCAN_DIR")))')) {
    return { ok: false, reason: 'Seatbelt 規則不可放行整個 SCAN_DIR 寫入（worktree 與 mutation/.git 必須禁寫）' };
  }
  if (!profile.includes('(allow file-read* (subpath (param "SCAN_DIR")))')
      || !profile.includes('(deny file-write*')
      || !profile.includes('(subpath (string-append (param "SCAN_DIR") "/worktree"))')
      || !profile.includes('(subpath (string-append (param "SCAN_DIR") "/mutation/.git"))')) {
    return { ok: false, reason: 'Seatbelt 規則缺少 SCAN_DIR 唯讀與 worktree／mutation/.git 禁寫限制' };
  }
  const outboundMatches = profile.match(/\(allow\s+network-outbound[^)]*\)/gu) || [];
  if (outboundMatches.length !== 1 || !profile.includes('(allow network-outbound (remote tcp (string-append "localhost:" (param "RELAY_PORT"))))')) {
    return { ok: false, reason: 'Seatbelt 規則的 network-outbound 必須且只能限制為 localhost:RELAY_PORT' };
  }
  if (!profile.trimEnd().endsWith('(deny file-read* process-exec* (subpath "/usr/local"))')) {
    return { ok: false, reason: 'Seatbelt 規則檔尾必須明確拒絕 /usr/local 讀寫與執行' };
  }
  const policyLines = profile.split('\n').map(line => line.trim());
  for (const rule of [
    '(deny process-exec* (literal "/usr/bin/security"))',
    '(deny process-exec* (literal "/usr/bin/open"))',
    '(deny process-exec* (literal "/usr/bin/osascript"))',
    '(deny network-outbound (remote unix-socket))',
    '(deny mach-lookup (global-name-prefix ""))',
  ]) {
    if (!policyLines.includes(rule)) {
      return { ok: false, reason: 'Seatbelt 規則缺少直接執行、Mach 或檔案型 socket 拒絕限制' };
    }
  }
  return { ok: true };
}

function canApplySeatbelt(sandboxExec = '/usr/bin/sandbox-exec', spawnSyncImpl = spawnSync) {
  if (process.platform !== 'darwin') return false;
  const r = spawnSyncImpl(sandboxExec, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function runGrokSeatbeltProbe({ boxDir, relayPort, authFile = '', unallowedPort = 0, sandboxExec = '/usr/bin/sandbox-exec', spawnSyncImpl = spawnSync, profile = GROK_SEATBELT_PROFILE } = {}) {
  const staticCheck = verifyGrokSeatbeltProfile(profile);
  if (!staticCheck.ok) return staticCheck;
  if (!boxDir || !Number.isInteger(Number(relayPort)) || Number(relayPort) <= 0) {
    return { ok: false, reason: 'Seatbelt 預檢缺少有效的 boxDir 或 relayPort' };
  }
  if (!canApplySeatbelt(sandboxExec, spawnSyncImpl)) {
    return { ok: false, reason: 'Seatbelt 預檢無法套用（sandbox-exec 退非零）' };
  }
  const effectiveBadPort = Number(unallowedPort) > 0 && Number(unallowedPort) !== Number(relayPort)
    ? Number(unallowedPort)
    : (Number(relayPort) === 65534 ? 65533 : 65534);
  const probeTmpDir = path.join(boxDir, 'tmp');
  const probeWorktreeDir = path.join(boxDir, 'worktree');
  const probeMutGitDir = path.join(boxDir, 'mutation', '.git');
  const probeNearDir = path.join(boxDir, 'mutation', '.github');
  const probePrompt = path.join(boxDir, 'prompt.md');
  let promptCreated = false;
  const probeFile = path.join(probeTmpDir, '.probe-ok');
  const script = [
    'const fs = require("node:fs");',
    'const net = require("node:net");',
    'const path = require("node:path");',
    'if (fs.readFileSync(path.join(process.env.BOX_DIR, "tmp", ".probe-ok"), "utf8") !== "ok") process.exit(11);',
    'fs.writeFileSync(path.join(process.env.BOX_DIR, "tmp", ".probe-write"), "ok");',
    'const gitDir = path.join(process.env.BOX_DIR, "mutation", ".git");',
    'const original = fs.lstatSync(gitDir);',
    'if (!original.isDirectory() || original.isSymbolicLink()) process.exit(19);',
    'const aliases = [".git", ".GIT", ".gIt"].map(name => path.join(process.env.BOX_DIR, "mutation", name));',
    'for (const alias of aliases) {',
    '  const stat = fs.lstatSync(alias);',
    '  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== original.dev || stat.ino !== original.ino) process.exit(19);',
    '}',
    'for (const relative of ["mutation/.probe-write", "mutation/.github/.probe-write"]) fs.writeFileSync(path.join(process.env.BOX_DIR, relative), "ok");',
    'for (const ro of [path.join(process.env.BOX_DIR, "worktree", ".probe-ro"), ...aliases.map(dir => path.join(dir, ".probe-ro")), path.join(process.env.BOX_DIR, "prompt.md")]) {',
    '  if (fs.readFileSync(ro, "utf8") !== "probe-original") process.exit(20);',
    '  let blocked = false;',
    '  try { fs.writeFileSync(ro, "x"); } catch (error) { blocked = error.code === "EPERM" || error.code === "EACCES"; }',
    '  if (!blocked) process.exit(17);',
    '  if (fs.readFileSync(ro, "utf8") !== "probe-original") process.exit(20);',
    '}',
    'if (process.env.AUTH_FILE) {',
    '  let blocked = false;',
    '  try { fs.readFileSync(process.env.AUTH_FILE); } catch { blocked = true; }',
    '  if (!blocked) process.exit(12);',
    '}',
    'if (process.env.HOST_HOME) {',
    '  let blocked = false;',
    '  try { fs.readdirSync(process.env.HOST_HOME); } catch { blocked = true; }',
    '  if (!blocked) process.exit(13);',
    '}',
    'for (const p of ["/private/tmp", "/Users/Shared", "/usr/local", "/opt/homebrew/var", "/Library/Application Support"]) {',
    '  if (!fs.existsSync(p)) continue;',
    '  let blocked = false;',
    '  try { fs.readdirSync(p); } catch { blocked = true; }',
    '  if (!blocked) process.exit(14);',
    '}',
    'const badPort = Number(process.env.UNALLOWED_PORT || 0);',
    'if (!(badPort > 0)) process.exit(18);',
    'const s = net.connect({ host: "127.0.0.1", port: badPort });',
    's.on("connect", () => { s.destroy(); process.exit(15); });',
    's.on("error", () => { console.log("PROBE_PASS"); process.exit(0); });',
    'setTimeout(() => { s.destroy(); process.exit(16); }, 1000);',
  ].join('\n');
  try {
    fs.mkdirSync(probeTmpDir, { recursive: true });
    fs.mkdirSync(probeWorktreeDir, { recursive: true });
    fs.mkdirSync(probeMutGitDir, { recursive: true });
    fs.mkdirSync(probeNearDir, { recursive: true });
    fs.writeFileSync(probeFile, 'ok');
    fs.writeFileSync(path.join(probeWorktreeDir, '.probe-ro'), 'probe-original', { flag: 'wx' });
    fs.writeFileSync(path.join(probeMutGitDir, '.probe-ro'), 'probe-original', { flag: 'wx' });
    fs.writeFileSync(probePrompt, 'probe-original', { flag: 'wx' });
    promptCreated = true;
    const nodeExec = fs.realpathSync(process.execPath);
    const r = spawnSyncImpl(sandboxExec, [
      '-p', profile,
      '-D', `SCAN_DIR=${boxDir}`,
      '-D', `RELAY_PORT=${relayPort}`,
      nodeExec,
      '-e', script,
    ], {
      cwd: boxDir,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: probeTmpDir,
        TMPDIR: probeTmpDir,
        BOX_DIR: boxDir,
        AUTH_FILE: authFile || '',
        HOST_HOME: os.homedir(),
        UNALLOWED_PORT: String(effectiveBadPort),
      },
      encoding: 'utf8',
    });
    if (r.error || r.status !== 0 || String(r.stdout || '').trim() !== 'PROBE_PASS') {
      return { ok: false, reason: `沙盒隔離預檢未通過（退 ${r.status === null ? '信號中斷' : r.status}）` };
    }
    return { ok: true };
  } finally {
    if (promptCreated) fs.unlinkSync(probePrompt);
    for (const p of [probeTmpDir, probeWorktreeDir, path.join(boxDir, 'mutation')]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

function grokAuthNeedles(authJson) {
  const out = new Set();
  const givenToBox = new Set();
  const walk = (v, into) => {
    if (typeof v === 'string') { if (v) into.add(v); }
    else if (Array.isArray(v)) v.forEach((x) => walk(x, into));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, into));
  };
  for (const cred of Object.values(authJson || {})) {
    if (!cred || typeof cred !== 'object') continue;
    for (const [k, v] of Object.entries(cred)) {
      if (Object.hasOwn(GROK_BOX_FIELDS, k)) walk(v, givenToBox);
      else if (!GROK_ENUM_FIELDS.includes(k)) walk(v, out);
    }
  }
  for (const v of givenToBox) out.delete(v);
  return [...out];
}

async function prepareGrokBoxAuth(authFile, { fetchImpl = globalThis.fetch, now = Date.now, earlySecs = 4200, pins = { issuer: GROK_PINNED_ISSUER, clientId: GROK_PINNED_CLIENT_ID }, dummyBearer: givenDummy = null } = {}) {
  if (!authFile || !fs.existsSync(authFile) || !fs.lstatSync(authFile).isFile()) {
    throw new LaunchError('Grok 認證檔不存在或不是一般檔案（拒絕收連結）');
  }
  let all;
  try { all = JSON.parse(fs.readFileSync(authFile, 'utf8')); }
  catch { throw new LaunchError('Grok 認證檔不是合法 JSON（內容不回顯）'); }
  const entries = Object.entries(all || {});
  if (entries.length !== 1) throw new LaunchError(`Grok 認證檔應恰有一個登入項，實際 ${entries.length}`);
  const [entryKey, cred] = entries[0];
  if (!cred || typeof cred !== 'object') throw new LaunchError('Grok 認證檔登入項格式不對');
  for (const need of ['oidc_issuer', 'oidc_client_id', 'refresh_token', 'expires_at', 'key']) {
    if (typeof cred[need] !== 'string' || !cred[need]) throw new LaunchError(`Grok 認證檔缺 ${need}`);
  }
  if (cred.oidc_issuer !== pins.issuer) throw new LaunchError(`Grok 認證檔的 oidc_issuer 不等於釘住的「${pins.issuer}」`);
  if (cred.oidc_client_id !== pins.clientId) throw new LaunchError('Grok 認證檔的 oidc_client_id 不等於釘住的值');
  if (!GROK_ISO_RE.test(String(cred.expires_at))) throw new LaunchError('Grok 認證檔的 expires_at 不是合法 ISO 時間');
  const expectedEntryKey = `${pins.issuer}::${pins.clientId}`;
  if (entryKey !== expectedEntryKey) throw new LaunchError('Grok 認證檔登入項鍵名不是釘住的 issuer::client_id');

  const expiresAtMs = Date.parse(String(cred.expires_at));
  let current = cred;
  let refreshed = false;
  if (!(expiresAtMs - now() > earlySecs * 1000)) {
    if (typeof fetchImpl !== 'function') throw new LaunchError('Grok 憑證快到期但無可用 fetch 進行續期');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(cred.refresh_token), client_id: pins.clientId });
    const r = await fetchImpl(`${pins.issuer}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!r || !r.ok) throw new LaunchError(`Grok 憑證 refresh 失敗（HTTP ${r ? r.status : '不明'}）`);
    let j;
    try { j = await r.json(); } catch { throw new LaunchError('Grok 憑證 refresh 回應不是合法 JSON'); }
    if (!j || typeof j.access_token !== 'string' || !j.access_token || !Number.isFinite(Number(j.expires_in))) {
      throw new LaunchError('Grok 憑證 refresh 回應缺 access_token 或 expires_in');
    }
    current = {
      ...cred,
      key: j.access_token,
      refresh_token: typeof j.refresh_token === 'string' && j.refresh_token ? j.refresh_token : cred.refresh_token,
      expires_at: new Date(now() + Number(j.expires_in) * 1000).toISOString(),
    };
    const tmp = `${authFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ [entryKey]: current }, null, 2), { mode: 0o600 });
    const fd = fs.openSync(tmp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, authFile);
    refreshed = true;
  }

  const forBox = {};
  for (const [k, check] of Object.entries(GROK_BOX_FIELDS)) {
    const ok = k === 'oidc_issuer' ? current[k] === pins.issuer : k === 'oidc_client_id' ? current[k] === pins.clientId : check(current[k]);
    if (!ok) throw new LaunchError(`Grok 認證檔的 ${k} 格式不合白名單規範`);
    forBox[k] = current[k];
  }
  const dummyBearer = givenDummy || `${GROK_DUMMY_BEARER_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
  if (!dummyBearer.startsWith(GROK_DUMMY_BEARER_PREFIX) || dummyBearer.length < GROK_DUMMY_BEARER_PREFIX.length + 32) {
    throw new LaunchError('Grok 盒內假權杖格式不合規範');
  }
  forBox.key = dummyBearer;
  const needles = grokAuthNeedles({ [entryKey]: current });
  return {
    forBox: { [entryKey]: forBox },
    realBearer: String(current.key),
    dummyBearer,
    needles,
    refreshed,
    expiresAt: String(current.expires_at),
  };
}

function grokRelayRejectReason(req, dummyBearer) {
  const url = String((req && req.url) || '');
  if (!url.startsWith('/') || url.startsWith('//') || /[\r\n\0]/u.test(url)) {
    return { code: 'bad-target', why: '路徑不是相對根路徑' };
  }
  if (url.length > 2048) {
    return { code: 'path-too-long', why: '路徑過長' };
  }
  const pathname = url.split('?')[0];
  const method = String((req && req.method) || '').toUpperCase();
  if (!GROK_ALLOWED_REQUESTS.some((r) => r.method === method && r.path.test(pathname))) {
    return { code: 'shape', why: '不在允許端點白名單' };
  }
  const auth = req && req.headers && req.headers.authorization;
  if (!dummyBearer || auth !== `Bearer ${dummyBearer}`) {
    return { code: 'auth', why: '缺少或盒內假權杖不符' };
  }
  return null;
}

function isGrokToleratedRefusal(code, method, fullPath) {
  return GROK_TOLERATED_REFUSALS.includes(`${code} ${String(method || '').toUpperCase()} ${fullPath}`);
}

async function startGrokRelay({ realBearer, dummyBearer, upstreamHost = GROK_UPSTREAM_HOST, requestImpl = https.request } = {}) {
  if (typeof realBearer !== 'string' || realBearer.length < 8) throw new LaunchError('受控認證通道缺少有效的真實權杖');
  if (typeof dummyBearer !== 'string' || !dummyBearer.startsWith(GROK_DUMMY_BEARER_PREFIX) || dummyBearer.length < GROK_DUMMY_BEARER_PREFIX.length + 32) {
    throw new LaunchError('受控認證通道缺少合規的盒內假權杖');
  }
  const blockingRefusals = [];
  const toleratedRefusals = [];
  const forwarded = [];
  const sockets = new Set();
  const upReqs = new Set();
  const upResps = new Set();
  let isClosed = false;
  let failed = false;
  let closePromise;

  const server = http.createServer((req, res) => {
    if (req.method === 'CONNECT') {
      blockingRefusals.push('connect CONNECT');
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('relay: CONNECT not supported');
      return;
    }
    const rej = grokRelayRejectReason(req, dummyBearer);
    if (rej) {
      const method = String(req.method || '').toUpperCase();
      const fullPath = String(req.url || '');
      const key = `${rej.code} ${method} ${fullPath}`;
      if (isGrokToleratedRefusal(rej.code, method, fullPath)) toleratedRefusals.push(key);
      else blockingRefusals.push(key);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`relay: refused (${rej.why})`);
      req.resume();
      return;
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (!GROK_HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    }
    headers.host = upstreamHost;
    headers.authorization = `Bearer ${realBearer}`;
    const pathname = String(req.url || '').split('?')[0];
    forwarded.push(`${String(req.method || '').toUpperCase()} ${pathname}`);
    let up;
    try { up = requestImpl({
      host: upstreamHost,
      port: 443,
      method: req.method,
      path: req.url,
      headers,
      timeout: 300000,
    }, (upRes) => {
      upResps.add(upRes);
      upRes.once('aborted', () => { if (!isClosed) failed = true; });
      upRes.once('error', () => { if (!isClosed) failed = true; });
      upRes.once('close', () => upResps.delete(upRes));
      const out = {};
      for (const [k, v] of Object.entries(upRes.headers || {})) {
        if (!GROK_HOP_HEADERS.has(k.toLowerCase()) && v !== undefined) out[k] = v;
      }
      res.writeHead(upRes.statusCode || 502, out);
      upRes.pipe(res);
    }); } catch {
      failed = true;
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('relay: upstream unreachable');
      req.resume();
      return;
    }
    upReqs.add(up);
    up.once('close', () => upReqs.delete(up));
    up.on('error', () => {
      if (!isClosed) failed = true;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('relay: upstream unreachable');
    });
    up.once('timeout', () => { failed = true; up.destroy(); });
    req.pipe(up);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('error', () => { failed = true; });
  server.on('close', () => { if (!isClosed) failed = true; });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return {
    server,
    port,
    blockingRefusals,
    toleratedRefusals,
    forwarded,
    get failed() { return failed; },
    close: () => {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve, reject) => {
        isClosed = true;
        const timer = setTimeout(() => reject(new Error('relay cleanup timeout')), GROK_CLEANUP_MS);
        try {
          for (const s of sockets) s.destroy();
          for (const r of upReqs) r.destroy();
          for (const r of upResps) r.destroy();
          sockets.clear();
          upReqs.clear();
          upResps.clear();
          server.close(error => {
            clearTimeout(timer);
            if (error) reject(new Error('relay cleanup failed')); else resolve();
          });
        } catch {
          clearTimeout(timer);
          reject(new Error('relay cleanup failed'));
        }
      });
      return closePromise;
    },
  };
}

function parseGrokExecArgs(argv) {
  const out = { mode: undefined, cwd: undefined, mutationCopy: undefined, model: undefined, effort: undefined, promptFile: undefined, outFile: undefined };
  const flagMap = {
    '--mode': 'mode',
    '--cwd': 'cwd',
    '--mutation-copy': 'mutationCopy',
    '--model': 'model',
    '--reasoning-effort': 'effort',
    '--prompt-file': 'promptFile',
    '--out': 'outFile',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!Object.hasOwn(flagMap, a)) return { error: `Grok 隔離執行不認得的參數：${a}` };
    const k = flagMap[a];
    if (out[k] !== undefined) return { error: `Grok 隔離執行重複給了參數：${a}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) return { error: `Grok 隔離執行 ${a} 後面要接值` };
    out[k] = v;
    i += 1;
  }
  for (const [flag, k] of [['--mode', 'mode'], ['--cwd', 'cwd'], ['--model', 'model'], ['--reasoning-effort', 'effort'], ['--prompt-file', 'promptFile'], ['--out', 'outFile']]) {
    if (!filled(out[k])) return { error: `Grok 隔離執行缺少必填參數 ${flag}` };
  }
  if (out.mode !== 'scan' && out.mode !== 'review') return { error: 'Grok 隔離執行 --mode 只能是 scan 或 review' };
  if (out.mode === 'review' && !filled(out.mutationCopy)) return { error: 'Grok 隔離執行 --mode review 必須提供 --mutation-copy' };
  if (out.mode === 'scan' && out.mutationCopy !== undefined) return { error: 'Grok 隔離執行 --mode scan 不可提供 --mutation-copy' };
  return out;
}

function snapshotTreeState(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return null;
  try {
    const rootStat = fs.lstatSync(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const hash = crypto.createHash('sha256');
    const walk = (curDir, relPrefix) => {
      const names = fs.readdirSync(curDir).sort();
      for (const name of names) {
        const full = path.join(curDir, name);
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) {
          hash.update(`L:${rel}:${fs.readlinkSync(full)}\n`);
        } else if (st.isDirectory()) {
          hash.update(`D:${rel}\n`);
          walk(full, rel);
        } else if (st.isFile()) {
          const fileHash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
          hash.update(`F:${rel}:${st.mode & 0o777}:${st.size}:${fileHash}\n`);
        } else {
          hash.update(`X:${rel}:${st.mode}\n`);
        }
      }
    };
    walk(rootDir, '');
    return hash.digest('hex');
  } catch {
    return null;
  }
}

function materializeIsolatedGitRepo(srcTree, destTree, { rootRepo = null, baseSha = null, headSha = null, extraShas = [], copySpawn = spawnSync } = {}) {
  // 來源歷史可被 replace/grafts 改寫；複製前拒收，而非改動宿主設定來猜原歷史。
  for (const source of new Set([srcTree, rootRepo].filter(Boolean))) {
    let polluted;
    try {
      polluted = Boolean(git(source, ['for-each-ref', '--format=%(refname)', 'refs/replace/']).trim());
      const graftPath = path.resolve(source, git(source, ['rev-parse', '--git-path', 'info/grafts']));
      try {
        fs.lstatSync(graftPath);
        polluted = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    } catch {
      throw new LaunchError('無法核對來源歷史替換狀態');
    }
    if (polluted) throw new LaunchError('來源含歷史替換（replace/grafts），拒絕建立審查材料');
  }
  const resolveCommit = (repoDir, rev) => (repoDir && rev && gitOk(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    ? git(repoDir, ['rev-parse', '--verify', `${rev}^{commit}`])
    : null);
  const targetHead = resolveCommit(srcTree, headSha || 'HEAD') || resolveCommit(rootRepo, headSha);
  if (!targetHead) throw new LaunchError('無法解析受審版本 HEAD');

  const wantedSet = new Set([targetHead]);
  for (const rev of [baseSha, ...(Array.isArray(extraShas) ? extraShas : [])]) {
    if (!rev) continue;
    const resolved = resolveCommit(srcTree, rev) || resolveCommit(rootRepo, rev);
    if (!resolved) throw new LaunchError(`無法解析隔離工作樹所需提交：${rev}`);
    wantedSet.add(resolved);
  }
  const wantedShas = [...wantedSet];

  git(srcTree, ['init', '--quiet', '-b', 'main', destTree]);
  git(destTree, ['config', 'user.name', 'scanner']);
  git(destTree, ['config', 'user.email', 'scanner@localhost']);

  const inSrc = wantedShas.filter((sha) => gitOk(srcTree, ['cat-file', '-e', `${sha}^{commit}`]));
  if (inSrc.length > 0) {
    git(destTree, [
      '-c', 'protocol.file.allow=always',
      'fetch', '--no-tags', '--quiet',
      '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack',
      `file://${srcTree}`,
      ...inSrc,
    ]);
  }
  const missing = wantedShas.filter((sha) => !gitOk(destTree, ['cat-file', '-e', `${sha}^{commit}`]));
  if (missing.length > 0 && rootRepo) {
    const inRoot = missing.filter((sha) => gitOk(rootRepo, ['cat-file', '-e', `${sha}^{commit}`]));
    if (inRoot.length > 0) {
      git(destTree, [
        '-c', 'protocol.file.allow=always',
        'fetch', '--no-tags', '--quiet',
        '--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack',
        `file://${rootRepo}`,
        ...inRoot,
      ]);
    }
  }

  git(destTree, ['checkout', '--detach', '--quiet', targetHead]);
  const resolvedBase = resolveCommit(destTree, baseSha);
  if (resolvedBase) {
    git(destTree, ['update-ref', 'refs/remotes/origin/main', resolvedBase]);
  }
  for (let i = 0; i < wantedShas.length; i += 1) {
    const sha = wantedShas[i];
    if (!gitOk(destTree, ['cat-file', '-e', `${sha}^{commit}`])) {
      throw new LaunchError(`隔離工作樹缺少所需提交：${sha}`);
    }
    git(destTree, ['update-ref', `refs/keep/wanted-${i}`, sha]);
  }
  git(destTree, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
  git(destTree, ['repack', '-a', '-d', '--quiet']);
  git(destTree, ['prune', '--expire=now']);
  try { fs.rmSync(path.join(destTree, '.git', 'FETCH_HEAD'), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(destTree, '.git', 'logs'), { recursive: true, force: true }); } catch { /* ignore */ }
  for (const sha of wantedShas) {
    if (!gitOk(destTree, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`])) {
      throw new LaunchError(`清理後隔離工作樹遺失所需提交：${sha}`);
    }
  }

  const dstPreexisting = validatePreexistingTreeNodeModules(destTree);
  const nodeModulesSrc = path.join(srcTree, 'node_modules');
  let srcNmStat = null;
  try {
    srcNmStat = fs.lstatSync(nodeModulesSrc);
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw e;
  }
  if (!dstPreexisting && srcNmStat) {
    let realNodeModulesSrc;
    try {
      realNodeModulesSrc = nativeRealpath(nodeModulesSrc);
      if (!fs.statSync(realNodeModulesSrc).isDirectory()) {
        throw new LaunchError(`隔離工作樹的 node_modules 不是資料夾：${nodeModulesSrc}`);
      }
    } catch (e) {
      if (e instanceof LaunchError) throw e;
      throw new LaunchError(`隔離工作樹的 node_modules 無法解析（${nodeModulesSrc}）：${(e && e.message) || '不明錯誤'}`);
    }
    const realSrcTree = nativeRealpath(srcTree);
    const realDestTree = nativeRealpath(destTree);
    const allowedContainerDeps = path.join(path.dirname(realSrcTree), 'deps');
    let inspectWorktree = realSrcTree;
    let mainWtForIso = null;
    let realMainWtForIso = null;
    try {
      const firstLine = git(srcTree, ['worktree', 'list', '--porcelain']).split('\n').find((l) => l.startsWith('worktree '));
      if (firstLine) {
        mainWtForIso = firstLine.slice(9);
        realMainWtForIso = nativeRealpath(mainWtForIso);
      }
    } catch { /* ignore */ }
    if (isRegisteredMainWorktreeNodeModulesLink(nodeModulesSrc, realSrcTree, mainWtForIso, realMainWtForIso)) {
      inspectWorktree = realMainWtForIso;
    }
    if (
      (!isInsideDir(realNodeModulesSrc, inspectWorktree) && !isInsideDir(realNodeModulesSrc, allowedContainerDeps))
      || realNodeModulesSrc === inspectWorktree
      || isInsideDir(inspectWorktree, realNodeModulesSrc)
      || isGitManagementPath(realNodeModulesSrc, inspectWorktree)
    ) {
      throw new LaunchError(`隔離工作樹的 node_modules 指向工作樹外或管理目錄（${realNodeModulesSrc}），拒絕複製`);
    }
    if (isInsideDir(realNodeModulesSrc, inspectWorktree)) {
      try {
        resolveKernelPathInBoundary(inspectWorktree, 'node_modules', inspectWorktree, { dotGitPath: path.join(inspectWorktree, '.git') });
      } catch {
        throw new LaunchError(`隔離工作樹的 node_modules 指向工作樹外或管理目錄（${realNodeModulesSrc}），拒絕複製`);
      }
    }
    const inspected = inspectNodeModulesTree(realNodeModulesSrc, inspectWorktree);
    const dstNm = path.join(destTree, 'node_modules');
    const cpArgs = process.platform === 'darwin' ? ['-cRP', realNodeModulesSrc, dstNm] : ['-RP', realNodeModulesSrc, dstNm];
    const cpRes = copySpawn('cp', cpArgs, { encoding: 'utf8' });
    if (!cpRes || cpRes.error || cpRes.status !== 0 || cpRes.signal) {
      const detail = !cpRes
        ? '無回傳結果'
        : cpRes.error
          ? (cpRes.error.code || cpRes.error.message || '啟動失敗')
          : cpRes.signal
            ? `訊號 ${cpRes.signal}`
            : `退 ${cpRes.status}`;
      const stderrMsg = cpRes && typeof cpRes.stderr === 'string' && cpRes.stderr.trim() ? `：${cpRes.stderr.trim()}` : '';
      throw new LaunchError(`隔離工作樹複製 node_modules 失敗（${detail}${stderrMsg}）`);
    }
    rewriteCopiedNodeModulesLinks(dstNm, realDestTree, inspected.links);
    verifyCopiedNodeModulesTree(dstNm, inspected, realDestTree);
  }
  return targetHead;
}

const GROK_WALL_MS = 60 * 60 * 1000;
const GROK_CLEANUP_MS = 10000;

// 診斷不可序列化子程序回覆：只投影內容無關的觀測欄位。
function grokDiagnostic(value = {}) {
  const triggers = ['record_failed', 'spawn_failed', 'child_exit', 'deadline', 'cancelled', 'relay_problem'];
  const vetoes = ['none', 'deadline', 'cancelled', 'relay_problem'];
  const states = ['empty', 'alive', 'unknown'];
  return {
    trigger: triggers.includes(value.trigger) ? value.trigger : 'unknown',
    vetoTrigger: vetoes.includes(value.vetoTrigger) ? value.vetoTrigger : 'unknown',
    childExitCode: Number.isInteger(value.childExitCode) && value.childExitCode >= 0 && value.childExitCode <= 255 ? value.childExitCode : null,
    childSignalled: typeof value.childSignalled === 'boolean' ? value.childSignalled : null,
    groupState: states.includes(value.groupState) ? value.groupState : 'unknown',
    pipesClosed: typeof value.pipesClosed === 'boolean' ? value.pipesClosed : null,
    cleanupFailed: typeof value.cleanupFailed === 'boolean' ? value.cleanupFailed : null,
    elapsedMs: Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : null,
  };
}

// exit 與 close 分開：後代可持有管線，不能用 close 當作開始收尾的條件。
async function runGrokChild(command, args, options, deps = {}) {
  const wallMs = deps.wallMs ?? GROK_WALL_MS;
  const cleanupMs = deps.cleanupMs ?? GROK_CLEANUP_MS;
  const kill = deps.kill || process.kill.bind(process);
  const startedAt = Date.now();
  const deadline = startedAt + wallMs;
  const beforeSpawn = trigger => ({ status: 2, stdout: '', groupEmpty: true, startedAt, deadline,
    diagnostic: grokDiagnostic({ trigger, vetoTrigger: trigger === 'cancelled' ? 'cancelled' : 'none', groupState: 'empty', pipesClosed: true, cleanupFailed: false, elapsedMs: Math.max(0, Date.now() - startedAt) }) });
  if (deps.signal?.aborted) return beforeSpawn('cancelled');
  try { deps.onStart?.({ startedAt, deadline, wallMs, cleanupMs }); }
  catch { return beforeSpawn('record_failed'); }
  let child;
  try { child = (deps.spawnChild || spawn)(command, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return beforeSpawn('spawn_failed'); }
  const pid = child.pid;
  const trustedPid = Number.isSafeInteger(pid) && pid > 1;
  let stdout = '';
  let stderr = '';
  let closed = false;
  let invalid = false;
  let finishing = false;
  let trigger = null;
  let vetoTrigger = null;
  let childExitCode = null;
  let childSignalled = null;
  let cleanupFailed = false;
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', data => { stdout += data; });
  child.stderr?.on('data', data => { stderr += data; });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  function groupState() {
    if (!trustedPid) return 'unknown';
    try { kill(-pid, 0); return 'alive'; }
    catch (error) { return error.code === 'ESRCH' ? 'empty' : 'unknown'; }
  }
  function signalGroup(signal) {
    try { kill(-pid, signal); return true; }
    catch (error) { return error.code === 'ESRCH'; }
  }
  async function finish(status) {
    if (finishing) return;
    finishing = true;
    const cleanupDeadline = Date.now() + cleanupMs;
    let state = groupState();
    if (state === 'alive' && !signalGroup('SIGTERM')) { invalid = true; cleanupFailed = true; }
    const forceAt = Date.now() + Math.min(250, cleanupMs / 2);
    let forced = false;
    while (state === 'alive' && Date.now() < cleanupDeadline) {
      if (!forced && Date.now() >= forceAt) {
        forced = true;
        if (!signalGroup('SIGKILL')) { invalid = true; cleanupFailed = true; }
      }
      await delay(20);
      state = groupState();
    }
    while (!closed && Date.now() < cleanupDeadline) await delay(20);
    const groupEmpty = state === 'empty';
    if (!groupEmpty || !closed) { invalid = true; cleanupFailed = true; }
    clearTimeout(timer);
    clearInterval(watch);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    deps.signal?.removeEventListener('abort', cancel);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    settle({ status: invalid || status === null ? 2 : status, stdout, stderr, pid, groupEmpty, startedAt, deadline,
      diagnostic: grokDiagnostic({ trigger, vetoTrigger: vetoTrigger ?? 'none', childExitCode, childSignalled, groupState: state, pipesClosed: closed, cleanupFailed, elapsedMs: Math.max(0, Date.now() - startedAt) }) });
  }
  function cancel(reason) {
    const observed = typeof reason === 'string' && !['SIGINT', 'SIGTERM'].includes(reason) ? reason : 'cancelled';
    trigger ??= observed;
    // exit 先開始清理時，不能讓它遮住稍後的首個否決觀測。
    if (observed !== 'spawn_failed') vetoTrigger ??= observed;
    invalid = true;
    void finish(2);
  }
  const timer = setTimeout(() => cancel('deadline'), Math.max(0, deadline - Date.now()));
  const watch = setInterval(() => {
    try { if (deps.failed?.()) cancel('relay_problem'); } catch { cancel('relay_problem'); }
  }, 25);
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  deps.signal?.addEventListener('abort', cancel, { once: true });
  child.once('error', () => { trigger ??= 'spawn_failed'; invalid = true; void finish(2); });
  child.once('exit', (status, signal) => { childExitCode = status; childSignalled = Boolean(signal); trigger ??= 'child_exit'; void finish(status); });
  child.once('close', status => { closed = true; void finish(status); });
  if (deps.signal?.aborted) cancel();
  else if (!trustedPid) cancel('spawn_failed');
  return done;
}

async function runGrokExec(argv, deps = {}) {
  const removeBox = deps.removeBox || fs.rmSync;
  const parsed = parseGrokExecArgs(argv);
  if (parsed.error) return { code: 2, lines: [`送審產生器（Grok 隔離執行）：${parsed.error}——拒絕啟動。`] };

  const cwdPath = path.resolve(parsed.cwd);
  const promptPath = path.resolve(parsed.promptFile);
  const outPath = path.resolve(parsed.outFile);
  const mutationPath = parsed.mutationCopy ? path.resolve(parsed.mutationCopy) : null;
  if (!fs.existsSync(cwdPath) || !fs.lstatSync(cwdPath).isDirectory()) {
    return { code: 2, lines: ['送審產生器（Grok 隔離執行）：--cwd 工作樹不存在或不是資料夾——拒絕啟動。'] };
  }
  if (mutationPath && (!fs.existsSync(mutationPath) || !fs.lstatSync(mutationPath).isDirectory())) {
    return { code: 2, lines: ['送審產生器（Grok 隔離執行）：--mutation-copy 突變副本不存在或不是資料夾——拒絕啟動。'] };
  }
  if (!fs.existsSync(promptPath) || !fs.lstatSync(promptPath).isFile()) {
    return { code: 2, lines: ['送審產生器（Grok 隔離執行）：--prompt-file 提示檔不存在或不是一般檔案——拒絕啟動。'] };
  }

  const authFile = deps.authFile || path.join(os.homedir(), '.grok', 'auth.json');
  const grokBin = deps.grokBin || path.join(os.homedir(), '.grok', 'bin', 'grok');
  const sandboxExec = deps.sandboxExec || '/usr/bin/sandbox-exec';
  const profile = deps.profile || GROK_SEATBELT_PROFILE;
  const probeFn = deps.probeFn || runGrokSeatbeltProbe;

  let authInfo;
  try {
    authInfo = await prepareGrokBoxAuth(authFile, deps.authOpts || {});
  } catch (e) {
    return { code: 2, lines: [`送審產生器（Grok 隔離執行）：${(e && e.message) || '憑證準備失敗'}——拒絕啟動。`] };
  }

  let relay = null;
  let boxDir = null;
  // 子程序退出後仍有非同步資源要收；取消資格必須保留到結果落地前。
  const cancellation = new AbortController();
  const cancelExecution = () => cancellation.abort();
  process.on('SIGINT', cancelExecution);
  process.on('SIGTERM', cancelExecution);
  deps.signal?.addEventListener('abort', cancelExecution, { once: true });
  if (deps.signal?.aborted) cancelExecution();
  const execute = async () => {
    if (cancellation.signal.aborted) return { code: 2, lines: ['送審產生器（Grok 隔離執行）：已取消——未寫出結果。'] };
    relay = await startGrokRelay({
      realBearer: authInfo.realBearer,
      dummyBearer: authInfo.dummyBearer,
      upstreamHost: deps.upstreamHost || GROK_UPSTREAM_HOST,
      requestImpl: deps.requestImpl || https.request,
    });
    const rawBox = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-grok-box-'));
    boxDir = fs.realpathSync(rawBox);

    const probeGuardServer = net.createServer();
    const probeSockets = new Set();
    probeGuardServer.on('connection', (s) => {
      probeSockets.add(s);
      s.once('close', () => probeSockets.delete(s));
    });
    await new Promise((r) => probeGuardServer.listen(0, '127.0.0.1', r));
    let probe;
    try {
      const unallowedPort = probeGuardServer.address().port;
      probe = probeFn({
        boxDir,
        relayPort: relay.port,
        authFile,
        unallowedPort,
        sandboxExec,
        profile,
      });
    } finally {
      for (const s of probeSockets) s.destroy();
      await new Promise((r) => probeGuardServer.close(() => r()));
    }
    if (!probe || !probe.ok) {
      return { code: 2, lines: [`送審產生器（Grok 隔離執行）：${(probe && probe.reason) || '沙盒隔離預檢未通過'}——拒絕啟動。`] };
    }

    const metaDir = path.dirname(outPath);
    let recMeta = null;
    const metaName = parsed.mode === 'scan' ? 'scan.json' : 'launch.json';
    const mf = path.join(metaDir, metaName);
    if (fs.existsSync(mf)) {
      try { recMeta = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { /* ignore */ }
    }

    let promptText = fs.readFileSync(promptPath, 'utf8');
    // 排除範圍只認本次讀入的原提示；附加差異或路徑改寫不得擴張例外。
    const activeNeedles = authInfo.needles.filter((needle) => !promptText.includes(needle));
    if (parsed.mode === 'scan') {
      if (!recMeta || !/^[0-9a-fA-F]{40}$/.test(recMeta.base) || !/^[0-9a-fA-F]{40}$/.test(recMeta.head)) {
        return { code: 2, lines: ['送審產生器（Grok 隔離執行）：掃描模式缺少合法的 scan.json (需含 40-hex base/head)——拒絕啟動。'] };
      }
      const rootRepo = recMeta.root;
      if (!rootRepo || !fs.existsSync(rootRepo)) {
        return { code: 2, lines: ['送審產生器（Grok 隔離執行）：掃描模式來源倉庫不存在——拒絕啟動。'] };
      }
      if (!gitOk(rootRepo, ['rev-parse', '--verify', `${recMeta.base}^{commit}`]) || !gitOk(rootRepo, ['rev-parse', '--verify', `${recMeta.head}^{commit}`])) {
        return { code: 2, lines: ['送審產生器（Grok 隔離執行）：掃描模式來源倉庫缺少基底或受審版本——拒絕啟動。'] };
      }
      const currentCwdHead = git(cwdPath, ['rev-parse', 'HEAD']);
      if (currentCwdHead !== recMeta.head) {
        return { code: 2, lines: ['送審產生器（Grok 隔離執行）：掃描樹 HEAD 與 scan.json 不符——拒絕啟動。'] };
      }
    }

    const promptShas = [...promptText.matchAll(/\bdiff\s+([0-9a-fA-F]{7,40})\.\.([0-9a-fA-F]{7,40})\b/gu)]
      .flatMap((m) => [m[1], m[2]]);

    const boxWorktree = path.join(boxDir, 'worktree');
    const boxMutation = mutationPath ? path.join(boxDir, 'mutation') : null;
    const copySpawn = deps.copySpawn || spawnSync;
    try {
      materializeIsolatedGitRepo(cwdPath, boxWorktree, {
        rootRepo: recMeta && recMeta.root,
        baseSha: recMeta && recMeta.base,
        headSha: recMeta && recMeta.head,
        extraShas: promptShas,
        copySpawn,
      });
      if (mutationPath && boxMutation) {
        materializeIsolatedGitRepo(mutationPath, boxMutation, {
          rootRepo: recMeta && recMeta.root,
          baseSha: recMeta && recMeta.base,
          headSha: recMeta && recMeta.head,
          extraShas: promptShas,
          copySpawn,
        });
      }
    } catch (e) {
      return { code: 2, lines: [`送審產生器（Grok 隔離執行）：${(e && e.message) || '建立隔離工作樹失敗'}——拒絕啟動。`] };
    }
    const beforeWorktreeSnap = snapshotTreeState(boxWorktree);
    const beforeMutationGitSnap = boxMutation ? snapshotTreeState(path.join(boxMutation, '.git')) : null;
    if (!beforeWorktreeSnap || (boxMutation && !beforeMutationGitSnap)) {
      return { code: 2, lines: ['送審產生器（Grok 隔離執行）：無法建立盒內工作樹初始快照——拒絕啟動。'] };
    }

    const grokHome = path.join(boxDir, 'grok-home');
    const grokBinDir = path.join(grokHome, 'bin');
    const grokDotDir = path.join(grokHome, '.grok');
    const grokTmpDir = path.join(boxDir, 'tmp');
    fs.mkdirSync(grokBinDir, { recursive: true });
    fs.mkdirSync(grokDotDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(grokTmpDir, { recursive: true });
    fs.writeFileSync(path.join(grokDotDir, 'auth.json'), `${JSON.stringify(authInfo.forBox, null, 2)}\n`, { mode: 0o600 });

    const boxGrokBin = path.join(grokBinDir, 'grok');
    if (!deps.spawnGrok) {
      if (!fs.existsSync(grokBin)) {
        return { code: 2, lines: ['送審產生器（Grok 隔離執行）：找不到 Grok CLI 執行檔——拒絕啟動。'] };
      }
      const realGrokBin = fs.realpathSync(grokBin);
      try {
        fs.copyFileSync(realGrokBin, boxGrokBin, fs.constants.COPYFILE_FICLONE);
      } catch {
        fs.copyFileSync(realGrokBin, boxGrokBin);
      }
      fs.chmodSync(boxGrokBin, 0o755);
    }

    const realCwd = realDir(cwdPath);
    for (const fromPath of [realCwd, cwdPath]) {
      if (fromPath) promptText = promptText.split(fromPath).join(boxWorktree);
    }
    if (mutationPath && boxMutation) {
      const realMut = realDir(mutationPath);
      for (const fromMut of [realMut, mutationPath]) {
        if (fromMut) promptText = promptText.split(fromMut).join(boxMutation);
      }
    }
    const boxPromptFile = path.join(boxDir, 'prompt.md');
    fs.writeFileSync(boxPromptFile, promptText);

    if (parsed.mode === 'scan') {
      const diffHeader = `\n\n=== 掃描材料 (git diff ${recMeta.base}...${recMeta.head}) ===\n`;
      fs.appendFileSync(boxPromptFile, diffHeader);
      const diffFd = fs.openSync(boxPromptFile, 'a');
      try {
        await new Promise((resolve, reject) => {
          const gitDiff = spawn('git', ['diff', '--no-ext-diff', '--no-textconv', `${recMeta.base}...${recMeta.head}`], {
            cwd: recMeta.root,
            env: gitEnv(),
            stdio: ['ignore', diffFd, 'ignore'],
          });
          gitDiff.on('error', reject);
          gitDiff.on('close', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`git diff 退 ${code || signal}`));
          });
        });
      } catch (e) {
        return { code: 2, lines: [`送審產生器（Grok 隔離執行）：掃描模式產生差異失敗（${e.message}）——拒絕啟動。`] };
      } finally {
        fs.closeSync(diffFd);
      }
    }

    const instruction = parsed.mode === 'scan'
      ? `先使用 read_file 讀取盒內絕對路徑提示檔 ${boxPromptFile}，可分段直到讀完，並依該提示內容與附加之 git diff 材料工作。請僅使用提供之工具進行檢查，絕不可嘗試執行終端或測試指令。直接在目前工作目錄照做，只輸出最終掃描留言正文（第一行必須是 🔍 標頭，不要輸出任何前言或後記）。`
      : `先使用 read_file 讀取盒內絕對路徑提示檔 ${boxPromptFile}，可分段直到讀完，並依該提示內容工作。請直接在目前工作目錄照做，只輸出最終複審結論正文（第一行必須是 🤖 標頭，文末單獨一行寫「未貼」）。`;

    const grokArgs = [
      '--sandbox', 'off',
      '--no-subagents',
      '--output-format', 'streaming-messages-json'
    ];
    if (parsed.mode === 'scan') {
      grokArgs.push(
        '--tools', 'read_file,grep,list_dir',
        '--disallowed-tools', 'search_tool,use_tool',
        '--allow', 'Read(*)',
        '--allow', 'Grep(*)',
        '--allow', 'Glob(*)'
      );
    } else {
      grokArgs.push(
        '--allow', 'Bash(*)',
        '--allow', 'Read(*)',
        '--allow', 'Edit(*)',
        '--allow', 'Write(*)',
        '--allow', 'Grep(*)',
        '--allow', 'Glob(*)'
      );
    }
    grokArgs.push(
      '-m', parsed.model,
      '--reasoning-effort', parsed.effort,
      '-p', instruction,
    );
    const childEnv = {
      HOME: grokHome,
      TMPDIR: grokTmpDir,
      PATH: `${grokBinDir}:/opt/homebrew/Cellar/node/26.0.0/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${relay.port}/v1`,
      LANG: process.env.LANG || 'en_US.UTF-8',
    };

    const runResult = deps.spawnGrok
      ? await deps.spawnGrok({
        sandboxExec,
        profile,
        boxDir,
        boxWorktree,
        boxMutation,
        boxPromptFile,
        boxGrokBin,
        relayPort: relay.port,
        grokArgs,
        env: childEnv,
      })
      : await runGrokChild(sandboxExec, [
          '-p', profile,
          '-D', `SCAN_DIR=${boxDir}`,
          '-D', `RELAY_PORT=${relay.port}`,
          boxGrokBin,
          ...grokArgs,
        ], {
          cwd: boxWorktree,
          env: childEnv,
        }, {
          spawnChild: deps.spawnChild,
          signal: cancellation.signal,
          failed: () => relay.failed || relay.blockingRefusals.length > 0,
          onStart: limits => fs.writeFileSync(path.join(metaDir, 'execution.json'), JSON.stringify({
            ...limits, mode: parsed.mode, model: parsed.model, effort: parsed.effort,
          }, null, 2), { flag: 'wx' }),
        });

    if (runResult.status !== 0) {
      return { code: 2, lines: [`送審產生器（Grok 隔離執行）：Grok 退 ${runResult.status}——未寫出結果。`, `執行觀測：${JSON.stringify(grokDiagnostic(runResult.diagnostic))}`] };
    }
    if (relay.failed) return { code: 2, lines: ['送審產生器（Grok 隔離執行）：受控認證通道失效——未寫出結果。'] };
    if (relay.blockingRefusals.length > 0) {
      return { code: 2, lines: [`送審產生器（Grok 隔離執行）：受控認證通道攔截到 ${relay.blockingRefusals.length} 筆未授權請求——已拒絕寫出結果。`] };
    }
    // 盒外絕不對盒內目錄執行 git（防 .git/config 的 core.fsmonitor 等設定在宿主權限下被觸發）：
    // 直接以純檔案系統 lstat + SHA-256 快照比對整個 boxWorktree（含 .git）及 boxMutation/.git 是否一字未改
    const afterWorktreeSnap = snapshotTreeState(boxWorktree);
    const afterMutationGitSnap = boxMutation ? snapshotTreeState(path.join(boxMutation, '.git')) : null;
    if (afterWorktreeSnap !== beforeWorktreeSnap || (boxMutation && afterMutationGitSnap !== beforeMutationGitSnap)) {
      return { code: 2, lines: ['送審產生器（Grok 隔離執行）：執行後盒內工作樹或 .git 狀態被改動（違反唯讀邊界）——已拒絕寫出結果。'] };
    }
    const rawOutput = String(runResult.stdout || '');
    if (activeNeedles.some((n) => rawOutput.includes(n))) {
      return { code: 2, lines: ['送審產生器（Grok 隔離執行）：輸出疑似含真實憑證或私密欄位（DLP 攔截）——已拒絕寫出結果。', '拒收階段：dlp_raw'] };
    }
    const ndLines = rawOutput.split(/\r?\n/u).map((l) => l.trim()).filter(Boolean);

    function findNeedleInObj(obj, needles) {
      if (typeof obj === 'string') {
        if (needles.some((n) => obj.includes(n))) return true;
      } else if (Array.isArray(obj)) {
        for (const v of obj) {
          if (findNeedleInObj(v, needles)) return true;
        }
      } else if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (needles.some((n) => k.includes(n)) || findNeedleInObj(v, needles)) return true;
        }
      }
      return false;
    }

    for (const line of ndLines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (findNeedleInObj(obj, activeNeedles)) {
        return { code: 2, lines: ['送審產生器（Grok 隔離執行）：輸出疑似含真實憑證或私密欄位（DLP 攔截）——已拒絕寫出結果。', '拒收階段：dlp_decoded'] };
      }
    }
    const strictParsed = parseGrokStrictNDJSON(rawOutput, 'Grok 執行');
    if (strictParsed.error) {
       return { code: 2, lines: [`送審產生器（Grok 隔離執行）：${strictParsed.error}——已拒絕寫出結果。`] };
    }

    const cleanedOutput = stripGrokPreamble(rawOutput, parsed.mode);
    try {
      await relay.close();
      relay = null;
      removeBox(boxDir, { recursive: true, force: true });
      boxDir = null;
    } catch {
      return { code: 2, lines: ['送審產生器（Grok 隔離執行）：本次資源收尾失敗——未寫出結果。'] };
    }
    if (cancellation.signal.aborted) return { code: 2, lines: ['送審產生器（Grok 隔離執行）：已取消——未寫出結果。'] };
    fs.writeFileSync(outPath, cleanedOutput);
    return { code: 0, lines: [] };
  };
  let result;
  let originalError;
  let didThrow = false;
  let cleanupFailed = false;
  try {
    result = await execute();
  } catch (error) {
    originalError = error;
    didThrow = true;
  } finally {
    if (relay) {
      try { await relay.close(); } catch { cleanupFailed = true; }
    }
    if (boxDir) {
      try { removeBox(boxDir, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
    process.removeListener('SIGINT', cancelExecution);
    process.removeListener('SIGTERM', cancelExecution);
    deps.signal?.removeEventListener('abort', cancelExecution);
  }
  if (cleanupFailed) return { code: 2, lines: ['送審產生器（Grok 隔離執行）：本次資源收尾失敗——未寫出結果。'] };
  // throw undefined 等 falsy 值也必須傳回；清理失敗則優先拒收。
  if (didThrow) throw originalError;
  return result;
}

function stripGrokPreamble(rawOutput) {
  return String(rawOutput ?? '');
}

/** 執行複審／掃描啟動指令（清掉 GIT_* 與 platform.clearEnv；以 record.root 為工作目錄跑 shell 指令）。 */
function defaultRunExec(command, { record, clearEnv = [] } = {}) {
  const env = gitEnv();
  for (const k of Array.isArray(clearEnv) ? clearEnv : []) delete env[k];
  const cwd = (record && record.root) || process.cwd();
  const r = spawnSync('/bin/sh', ['-c', command], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) throw new LaunchError(`啟動指令起不來：${r.error.message}`);
  if (r.status !== 0) {
    const msg = `${r.stderr || ''}\n${r.stdout || ''}`.trim().slice(0, 300);
    throw new LaunchError(`啟動指令退 ${r.status === null ? '（被殺掉）' : r.status}：${msg || '（沒有訊息）'}`);
  }
}

function parseArgs(argv) {
  const out = { change: undefined, reviewer: undefined, close: undefined, post: undefined, scan: undefined, scanner: undefined, tier: undefined, scanPost: undefined, scanClose: undefined, file: undefined, dir: undefined };
  const flagMap = {
    '--reviewer': 'reviewer',
    '--close': 'close',
    '--post': 'post',
    '--file': 'file',
    '--dir': 'dir',
    '--scan': 'scan',
    '--scanner': 'scanner',
    '--tier': 'tier',
    '--scan-post': 'scanPost',
    '--scan-close': 'scanClose',
    '--round': 'round',
    '--expect-head': 'expectHead',
    '--expect-started-at': 'expectStartedAt',
    '--continue-blocker': 'continueBlocker',
    '--owner-question': 'ownerQuestion',
    '--owner-approval': 'ownerApproval',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (Object.hasOwn(flagMap, a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} 後面要接值` };
      if (['--continue-blocker', '--owner-question', '--owner-approval'].includes(a) && out[flagMap[a]] !== undefined) {
        return { error: `獨立續審旗標不可重複：${a}` };
      }
      out[flagMap[a]] = v;
      i += 1;
    } else if (a === '--run') out.run = true;
    else if (a === '--purge') out.purge = true;
    else if (a.startsWith('--')) return { error: `不認得的參數：${a}` };
    else if (out.change === undefined) out.change = a;
    else return { error: `多給了一個參數：${a}` };
  }
  const modes = ['close', 'post', 'scan', 'scanPost', 'scanClose'].filter((k) => out[k] !== undefined);
  const continuationKeys = ['continueBlocker', 'ownerQuestion', 'ownerApproval'];
  if (continuationKeys.some((k) => out[k] !== undefined)) {
    if (modes.length || continuationKeys.some((k) => out[k] === undefined)) {
      return { error: '獨立續審只用於備審，須一起給 --continue-blocker、--owner-question、--owner-approval；收件依固定場次重核' };
    }
    if (out.purge) return { error: '獨立續審不自動 purge；保留場次供原件與收據核對' };
    out.continuation = { question: out.ownerQuestion, approval: out.ownerApproval, blocker: out.continueBlocker };
  }
  if (modes.length > 1) return { error: '一次只能指定一種模式（--close、--post、--scan、--scan-post、--scan-close）' };
  if (out.purge && !out.run && out.close === undefined && out.scanClose === undefined) {
    return { error: '--purge 只能配 --close、--scan-close 或 --run 用' };
  }
  if (out.round !== undefined) {
    if (out.close === undefined && out.post === undefined) return { error: '--round 只能配 --close 或 --post 用' };
    if (!/^[1-9]\d*$/u.test(out.round)) return { error: '--round 要是正整數' };
    out.expectRound = Number.parseInt(out.round, 10);
  }
  if (out.expectHead !== undefined) {
    if (out.close === undefined && out.post === undefined && out.scanClose === undefined && out.scanPost === undefined) {
      return { error: '--expect-head 只能配 --close、--post、--scan-close 或 --scan-post 用' };
    }
    if (!/^[0-9a-fA-F]{7,40}$/u.test(out.expectHead)) return { error: '--expect-head 要是 7〜40 碼十六進位版本碼' };
    out.expectHead = out.expectHead.toLowerCase();
  }
  if (out.expectStartedAt !== undefined) {
    if (out.close === undefined && out.post === undefined && out.scanClose === undefined && out.scanPost === undefined) {
      return { error: '--expect-started-at 只能配 --close、--post、--scan-close 或 --scan-post 用' };
    }
    if (parseInstant(out.expectStartedAt) === null) return { error: '--expect-started-at 要是帶時區的合法 ISO 時間' };
  }
  if (out.close !== undefined) {
    return out.change === undefined && out.reviewer === undefined && out.scanner === undefined && out.tier === undefined && out.file === undefined && !out.run
      ? out : { error: '--close 只收變更編號（和選填的 --round、--expect-head、--expect-started-at、--purge、--dir）' };
  }
  if (out.post !== undefined) {
    return out.change === undefined && out.reviewer === undefined && out.scanner === undefined && out.tier === undefined && !out.run && !out.purge
      ? out : { error: '--post 只收變更編號（和選填的 --round、--expect-head、--expect-started-at、--file、--dir）' };
  }
  if (out.scan !== undefined) {
    return out.change === undefined && out.reviewer === undefined && out.file === undefined
      ? out : { error: '--scan 只收變更編號（和選填的 --scanner、--tier、--run、--purge、--dir）' };
  }
  if (out.scanPost !== undefined) {
    return out.change === undefined && out.reviewer === undefined && out.scanner === undefined && out.tier === undefined && !out.run && !out.purge
      ? out : { error: '--scan-post 只收變更編號（和選填的 --expect-head、--expect-started-at、--file、--dir）' };
  }
  if (out.scanClose !== undefined) {
    return out.change === undefined && out.reviewer === undefined && out.scanner === undefined && out.tier === undefined && out.file === undefined && !out.run
      ? out : { error: '--scan-close 只收變更編號（和選填的 --expect-head、--expect-started-at、--purge、--dir）' };
  }
  if (out.scanner !== undefined) return { error: '--scanner 只能配 --scan 用' };
  if (out.tier !== undefined) return { error: '--tier 只能配 --scan 用' };
  if (out.file !== undefined) return { error: '--file 只能配 --post 或 --scan-post 用' };
  if (out.change === undefined || out.reviewer === undefined) return { error: '要給變更編號與 --reviewer' };
  return out;
}

function main(argv, opts = {}) {
  const a = parseArgs(argv);
  if (a.error) return { code: 2, lines: [a.error, USAGE] };
  const dir = a.dir || opts.dir;
  const purge = Boolean(a.purge || opts.purge);
  const expectOpts = {
    ...(a.expectRound !== undefined ? { expectRound: a.expectRound } : {}),
    ...(a.expectHead !== undefined ? { expectHead: a.expectHead } : {}),
    ...(a.expectStartedAt !== undefined ? { expectStartedAt: a.expectStartedAt } : {}),
  };
  try {
    if (a.close !== undefined) return close(a.close, { ...opts, ...expectOpts, ...(dir ? { dir } : {}), ...(purge ? { purge: true } : {}) });
    if (a.post !== undefined) return post(a.post, { ...opts, ...expectOpts, ...(dir ? { dir } : {}), ...(a.file ? { file: a.file } : {}) });
    if (a.scan !== undefined) {
      const launched = scanLaunch(a.scan, { ...opts, ...(a.scanner ? { scanner: a.scanner } : {}), ...(a.tier ? { tier: a.tier } : {}), ...(dir ? { dir } : {}) });
      if (!a.run || launched.code !== 0) return launched;
      const s = opts.settings || readSettings();
      const clearEnv = Array.isArray(s.platform && s.platform.clearEnv) ? s.platform.clearEnv : [];
      const runExec = opts.runExec || defaultRunExec;
      const folder = path.dirname(launched.record.promptFile);
      try {
        runExec(launched.command, { record: launched.record, clearEnv });
      } catch (e) {
        if (e instanceof LaunchError) {
          return { code: 1, lines: [...launched.lines, `執行掃描啟動指令失敗：${e.message}（掃描樹與輸出檔留在 ${folder} 供檢查，未代貼、未收樹）`] };
        }
        throw e;
      }
      let posted;
      try {
        posted = scanPost(launched.record.change, {
          ...opts,
          ...(dir ? { dir } : {}),
          expectHead: launched.record.head,
          expectStartedAt: launched.record.startedAt,
        });
      } catch (e) {
        if (e instanceof LaunchError) {
          return { code: 2, lines: [...launched.lines, `送審產生器：${e.message}——沒有貼（掃描樹與輸出檔留在 ${folder}，未收樹）。`] };
        }
        throw e;
      }
      if (posted.code !== 0) return { code: posted.code, lines: [...launched.lines, ...posted.lines] };
      let closed;
      try {
        closed = scanClose(launched.record.change, {
          ...opts,
          ...(dir ? { dir } : {}),
          ...(purge ? { purge: true } : {}),
          expectHead: launched.record.head,
          expectStartedAt: launched.record.startedAt,
        });
      } catch (e) {
        if (e instanceof LaunchError) {
          const resolvedDir = path.dirname(folder);
          const retryCmd = `node tools/review-launch.js --scan-close ${launched.record.change} --expect-head ${launched.record.head} --expect-started-at ${launched.record.startedAt}${purge ? ' --purge' : ''}${dir ? ` --dir ${resolvedDir}` : ''}`;
          return {
            code: 2,
            lines: [
              ...launched.lines,
              ...posted.lines,
              `送審產生器：已貼，收尾失敗（${e.message}）——沒有收（掃描樹與輸出檔留在 ${folder}，可重跑 ${retryCmd}）。`,
            ],
          };
        }
        throw e;
      }
      return {
        code: closed.code,
        lines: [...launched.lines, ...posted.lines, ...closed.lines],
        record: posted.record,
        header: posted.header,
        body: posted.body,
        command: launched.command,
        prompt: launched.prompt,
      };
    }
    if (a.scanPost !== undefined) return scanPost(a.scanPost, { ...opts, ...expectOpts, ...(dir ? { dir } : {}), ...(a.file ? { file: a.file } : {}) });
    if (a.scanClose !== undefined) return scanClose(a.scanClose, { ...opts, ...expectOpts, ...(dir ? { dir } : {}), ...(purge ? { purge: true } : {}) });
    const launched = launch(a.change, a.reviewer, { ...opts, ...(a.continuation ? { continuation: a.continuation } : {}), ...(dir ? { dir } : {}) });
    if (!a.run || launched.code !== 0) return launched;
    const s = opts.settings || readSettings();
    const clearEnv = Array.isArray(s.platform && s.platform.clearEnv) ? s.platform.clearEnv : [];
    const runExec = opts.runExec || defaultRunExec;
    const folder = path.dirname(launched.record.promptFile);
    try {
      if (Object.hasOwn(launched.record, 'continuation')) {
        const saved = JSON.parse(fs.readFileSync(path.join(folder, 'launch.json'), 'utf8'));
        if (JSON.stringify(saved) !== JSON.stringify(launched.record)) throw new LaunchError('獨立續審場次在模型啟動前已變');
        recheckContinuation(launched.record,
          askPlatform(opts.platform || { ask }, s, 'change', { change: String(launched.record.change) }),
          askPlatform(opts.platform || { ask }, s, 'comments', { change: launched.record.change }), null, false, s);
      }
      runExec(launched.command, { record: launched.record, clearEnv });
    } catch (e) {
      if (e instanceof LaunchError) {
        return { code: 1, lines: [...launched.lines, `執行複審啟動指令失敗：${e.message}（審查樹與輸出檔留在 ${folder} 供檢查，未代貼、未收樹）`] };
      }
      throw e;
    }
    let posted;
    try {
      posted = post(launched.record.change, {
        ...opts,
        ...(dir ? { dir } : {}),
        allowAlreadyPosted: true,
        expectRound: launched.record.round,
        expectHead: launched.record.head,
        expectStartedAt: launched.record.startedAt,
      });
    } catch (e) {
      if (e instanceof LaunchError) {
        return { code: 2, lines: [...launched.lines, `送審產生器：${e.message}——沒有貼（審查樹與輸出檔留在 ${folder}，未收樹）。`] };
      }
      throw e;
    }
    if (posted.code !== 0) return { code: posted.code, lines: [...launched.lines, ...posted.lines] };
    let closed;
    try {
      closed = close(launched.record.change, {
        ...opts,
        ...(dir ? { dir } : {}),
        ...(purge ? { purge: true } : {}),
        expectRound: launched.record.round,
        expectHead: launched.record.head,
        expectStartedAt: launched.record.startedAt,
      });
    } catch (e) {
      if (e instanceof LaunchError) {
        const resolvedDir = path.dirname(folder);
        const retryCmd = `node tools/review-launch.js --close ${launched.record.change} --round ${launched.record.round} --expect-head ${launched.record.head} --expect-started-at ${launched.record.startedAt}${purge ? ' --purge' : ''}${dir ? ` --dir ${resolvedDir}` : ''}`;
        return {
          code: 2,
          lines: [
            ...launched.lines,
            ...posted.lines,
            `送審產生器：已貼，收尾失敗（${e.message}）——沒有收（審查樹與輸出檔留在 ${folder}，可重跑 ${retryCmd}）。`,
          ],
        };
      }
      throw e;
    }
    return {
      code: closed.code,
      lines: [...launched.lines, ...posted.lines, ...closed.lines],
      record: posted.record,
      header: posted.header,
      body: posted.body,
      command: launched.command,
      prompt: launched.prompt,
    };
  } catch (e) {
    if (e instanceof LaunchError) {
      const action = (a.close !== undefined || a.scanClose !== undefined)
        ? '沒有收'
        : (a.post !== undefined || a.scanPost !== undefined)
          ? '沒有貼'
          : '沒有產生';
      return { code: 2, lines: [`送審產生器：${e.message}——${action}。`] };
    }
    throw e;
  }
}

if (require.main === module) {
  const rawArgv = process.argv.slice(2);
  if (rawArgv[0] === '--grok-exec') {
    runGrokExec(rawArgv.slice(1)).then(
      (result) => {
        if (result.lines && result.lines.length) process.stderr.write(`${result.lines.join('\n')}\n`);
        process.exit(result.code);
      },
      (e) => {
        process.stderr.write(`送審產生器（Grok 隔離執行）：${(e && e.message) || '不明錯誤'}——拒絕啟動。\n`);
        process.exit(2);
      },
    );
  } else {
    let result;
    try { result = main(rawArgv); } catch (e) { result = { code: 2, lines: [`送審產生器：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——沒有產生。`] }; }
    process.stdout.write(`${result.lines.join('\n')}\n`);
    process.exit(result.code);
  }
}

module.exports = { main, launch, close, post, scanLaunch, scanPost, scanClose, deriveScanCommand, resolveScannerSpec, stripGrokPreamble, prepareVerdict, prepareScan, unwrapScanOutput, splitCommandArgs, defaultRunPost, defaultRunExec, fill, promptPart, substitute, scopeOf, roundsOf, twoMissesInARow, parseArgs, templateProblems, freshEntries, lockedTrees, runGrokExec, runGrokChild, GROK_WALL_MS, GROK_CLEANUP_MS, parseGrokExecArgs, materializeIsolatedGitRepo, snapshotTreeState, prepareGrokBoxAuth, grokAuthNeedles, startGrokRelay, grokRelayRejectReason, isGrokToleratedRefusal, runGrokSeatbeltProbe, verifyGrokSeatbeltProfile, canApplySeatbelt, GROK_SEATBELT_PROFILE, GROK_ALLOWED_REQUESTS, GROK_TOLERATED_REFUSALS, GROK_BOX_FIELDS, GROK_PINNED_ISSUER, GROK_PINNED_CLIENT_ID, GROK_DUMMY_BEARER_PREFIX, FILL, SCAN_FILL, SCAN_TEMPLATE, SCAN_HEADER, FILE_SLOT, SAFE, COMMAND_TOKENS, SCAN_COMMAND_TOKENS, LaunchError };
