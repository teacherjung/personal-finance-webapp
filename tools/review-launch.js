#!/usr/bin/env node
// 送審產生器（規矩 F1、F3、F11）：把送審提示的事實格填好、開兩棵固定在受審版本的樹（審查樹、突變副本）、
// 印出整行啟動指令；審完用 --close 先核兩棵樹乾淨、HEAD 沒變，再收掉。
//
// 為什麼：送審提示的事實格（版本碼、輪次、上一輪結論、兩條路徑、三條指令、來源字串）原本每輪手抄，啟動指令要從設定第十一節抄模型與推理；
// 案例簿已有兩起手填出錯（review-prompt-derivation-slip 漏改四處、燒掉一輪；heredoc-eaten-empty-prompt 空提示跑一輪），
// 而 Codex 的推理沒帶就照它自己的設定檔預設跑，從外面看不出來。擁有者 2026-10-07 裁第 2 批的三台提前做，這是其中第二台。
//
// 格子照範本出現的**順序**填（FILL 那張表），不照字面換：同一個尖括號字樣在不同位置意思不同（<識別值> 一處是複審者、一處是實作者）。
// 範本的格子一改，「範本的格子跟產生器的表一一對上」那一題就紅。只留 <三選一> 給複審者填。
// 啟動指令的正本在專案設定（reviewers 每一位的 command），這裡只替換記號；替換進去的值只收不用加引號的字元，
// 路徑有空白就不產生——樣板自己已經寫了引號，這裡再包一層就會壞掉。
// 樹開在系統暫存區（或 --dir 指定的地方）：README 寫明 Codex 的沙箱准寫暫存區，突變副本放那裡它才改得到。
//
// ⚠️ 守不到的：
//   ①不擋也不驗：印出來之後有沒有照用、提示有沒有再被手改、複審者實際用的模型與推理（只有它自報）都看不到——F1、F3、F11 仍靠自覺；
//   ②印的事實是平台與 git 那一刻給的：之後又推了新版本，印出來的就過期（收樹時核 HEAD 沒變，但不會重新產生）；
//   ③風險級別只印分級腳本照檔案算的那一級；實作者往重調、裁示者改級，要自己改提示的風險級別與本輪範圍兩格（範圍照分級表跟著級別重查）；
//   ④「相關裁示」只列問在本支、配到的 ⚖️（判斷用待裁清單工具那一份），對話裡講過、沒貼留痕的列不到；
//   ⑤收樹只核兩棵樹（狀態不看被忽略的檔）；複審者在暫存區另建的東西只列出比開樹晚的第一層、不刪，也不保證列齊（別的程式同時寫的也會被列進來）。
// 退出碼：0＝做好了；1＝收樹時核到樹不乾淨、HEAD 變了或上了鎖而沒收，或收到一半（要人看）；2＝做不了（設定沒填、平台問不到、git 出錯、路徑不安全、範本對不上、參數不對）。⚠️ 不是閘。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ask, PlatformError } = require('./platform.js');
const { read: readSettings } = require('./settings-data.js');
const { gitEnv } = require('./git-env.js');
const { parseInstant } = require('./time-point.js');
const { fieldValue, canonicalRole, rolesOf } = require('./gates/check-collab-fields.js');
const { headerOf, evaluate: evaluateVerdicts } = require('./gates/check-review-verdicts.js');
const { evaluate: evaluateRulings, deciderOf } = require('./pending-rulings.js');
const { run: riskRun } = require('./risk-tier.js');

const UNSET = '未設定';
const TEMPLATE = path.join(__dirname, '..', 'templates', 'review-request.md');
const USAGE = `用法：node tools/review-launch.js <變更編號> --reviewer <複審者識別值> [--dir <放樹的資料夾>]
      node tools/review-launch.js --close <變更編號> [--dir <放樹的資料夾>]`;

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
const SLOT = /<[^<>\n]+>/gu;
const TOKEN = /\{([A-Za-z]+)\}/gu;
/** 替換進指令的值只收這些字元：不用加引號、殼也不會拆開或展開它。 */
const SAFE = /^[A-Za-z0-9._/:@+=,-]+$/u;

class LaunchError extends Error {}

/** 範本「以下整段就是送出去的提示」那一段＝第一條整行只有 --- 的分隔線之後。找不到＝null。 */
function promptPart(template) {
  const lines = String(template).replace(/\r\n?/g, '\n').split('\n');
  const i = lines.indexOf('---');
  return i < 0 ? null : lines.slice(i + 1).join('\n').replace(/^\n+/u, '');
}

/** 照 FILL 的順序把格子換成值。範本的格子跟表不是一一對上＝不產生（範本改了，產生器要一起改）。 */
function fill(template, values) {
  const part = promptPart(template);
  if (part === null) throw new LaunchError('範本找不到分隔線「---」：不知道哪一段是送出去的提示');
  const slots = part.match(SLOT) || [];
  const expected = FILL.map(([slot]) => slot);
  const bad = slots.findIndex((s, i) => s !== expected[i]);
  if (slots.length !== expected.length || bad >= 0) {
    const at = bad >= 0 ? bad : Math.min(slots.length, expected.length);
    throw new LaunchError(`範本的格子跟產生器的表對不上（範本 ${slots.length} 格、表 ${expected.length} 格；第 ${at + 1} 格範本是「${slots[at] || '（沒有）'}」、表是「${expected[at] || '（沒有）'}」）：範本改了，產生器要一起改`);
  }
  for (const [slot, key] of FILL) {
    if (key !== null && (values[key] === undefined || values[key] === null || String(values[key]).trim() === '')) throw new LaunchError(`「${slot}」那一格（${key}）沒有值`);
  }
  let i = 0;
  return part.replace(SLOT, (slot) => { const key = FILL[i++][1]; return key === null ? slot : String(values[key]); });
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

function askPlatform(platform, settings, op, args) {
  try { return platform.ask(op, args, { settings }); } catch (e) {
    if (e instanceof PlatformError || (e && e.name === 'PlatformError')) throw new LaunchError(`問不到平台（${op}：${e.message}）`);
    throw e;
  }
}

/** 啟動指令樣板認得的記號（launch 裡 tokens 那一張，順序無關）。 */
const COMMAND_TOKENS = ['model', 'effort', 'reviewTree', 'mutationCopy', 'promptFile', 'outFile', 'change', 'project'];
/** 設定裡填了的樣板逐一核：登記了的複審者兩格都有、記號都認得、啟動指令帶著模型與推理。回問題清單；沒登記的不核（新專案還沒填）。 */
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
    for (const t of ['model', 'effort']) if (!used.includes(t)) out.push(`「${r.participant}」的啟動指令樣板沒帶 {${t}}`);
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
function launch(changeArg, reviewerArg, { settings = readSettings(), platform = { ask }, cwd = process.cwd(), dir: dirArg = os.tmpdir(), template = null, now = () => new Date() } = {}) {
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
  if (!used.has('model') || !used.has('effort')) throw new LaunchError(`「${reviewer}」的啟動指令樣板沒帶 {model} 或 {effort}：漏帶時複審者照它自己的預設跑，從外面看不出來（F11）`);
  const decider = deciderOf(settings);
  if (!decider) throw new LaunchError('專案設定裡的裁示者識別值或貼文帳號還沒填：算不出相關裁示');
  const tpl = template === null ? fs.readFileSync(TEMPLATE, 'utf8') : template;

  const change = askPlatform(platform, settings, 'change', { change: String(changeArg) });
  const id = change.id;
  const head = change.headSha;
  const named = canonicalRole(fieldValue(change.body, '複審者'), usable);
  if (named !== reviewer) throw new LaunchError(`PR說明的「複審者」欄是「${named || '讀不出'}」，不是 ${reviewer}：這一輪的通過不會算數（F5 只認說明裡指定的那一位）`);
  const implementer = canonicalRole(fieldValue(change.body, '實作者'), usable);
  if (!implementer) throw new LaunchError('PR說明的「實作者」欄讀不出一位登記過的參與者');
  const base = askPlatform(platform, settings, 'branchSha', { branch: change.baseBranch }).sha;
  const comments = askPlatform(platform, settings, 'comments', { change: id });
  const all = askPlatform(platform, settings, 'allComments', {});
  const rulings = evaluateRulings(all, decider);
  if (rulings.unsure) throw new LaunchError(`相關裁示算不出來（${rulings.unsure}）`);
  const risk = riskRun(id, { settings, platform });
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
  const scope = scopeOf((settings.reviewTiers || {})[tier], round, passed);
  if (!scope) throw new LaunchError(`複審與掃描分級表「${tier}」那一列讀不出第 ${round} 輪該全審還是只核差異`);
  const commentLink = (changeId, comment) => substitute(rl.commentLink, { project, change: changeId, comment }, '留言網址樣板').text;
  const related = rulings.ruled.filter((x) => String(x.ask.change) === String(id)).map((x) => commentLink(x.by.change, x.by.id));

  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  const fetched = gitOk(root, ['fetch', '--quiet']);
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
    tier, tierWhy: '照表算的', scope,
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
  const before = new Set(lockedTrees(root).keys());
  fs.mkdirSync(folder, { recursive: true });
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
    fs.writeFileSync(promptFile, prompt);
    fs.writeFileSync(path.join(folder, 'launch.json'), `${JSON.stringify(record, null, 1)}\n`);
  } catch (e) {
    // 開到一半失敗：只收這一次自己開的樹與資料夾，不留半套（下一次才不會被「已經在了」或「已登記但不見了」擋住）。
    // 「這一次開的」＝開樹前沒有、現在登記在這個資料夾底下的每一棵：也收得到 git worktree add 已經建好樹、
    // 卻因為掛鉤失敗而退非零的那一棵（#49 r2 R2）；開樹前就登記著的（就算路徑在這底下）不是這一次的，不動。
    // 不用整個倉庫的 git worktree prune：別棵暫時不在原位的樹（例如外接碟沒接上）會被一起清掉登記與索引（#49 r1 R1）
    let registered = created;
    try { registered = [...lockedTrees(root).keys()].filter((t) => t.startsWith(`${folder}${path.sep}`) && !before.has(t)); } catch { /* 讀不到登記就只收確定開成的那幾棵 */ }
    for (const t of new Set([...created, ...registered])) gitOk(root, ['worktree', 'remove', '--force', t]);
    fs.rmSync(folder, { recursive: true, force: true });
    throw e;
  }
  const lines = [
    `送審產生器｜變更 ${id}｜複審者 ${reviewer}（來源 ${entry.source}）｜r${round}｜受審 ${head.slice(0, 7)}｜基底 ${change.baseBranch} 的 ${base.slice(0, 7)}`,
    `  風險級別：${tier}（照表算的；要往重調或裁示者改級，提示的風險級別與本輪範圍兩格要一起照分級表改）；本輪範圍：${scope}`,
    `  上一輪的結論：${values.previous}；相關裁示：${values.rulings}`,
    `  審查樹：${tree}（HEAD ${head.slice(0, 7)}）`,
    `  突變副本：${mutation}（HEAD ${head.slice(0, 7)}）`,
    `  送審提示：${promptFile}（照 templates/review-request.md 填好，只留 <三選一> 給複審者）`,
    fetched ? null : '  ⚠️ git fetch 沒成功：本機已經有這兩顆版本，照樣開了樹。',
    `啟動指令（模型 ${entry.strongest}、推理 ${entry.maxEffort}；不開的自動模式：${entry.autoMode}）：`,
    command,
    `跑完：退出碼 0 不代表通過、也不代表結論已經貼上去——先跑查複審結論的那道閘、看它印的現況（F7）。審完收樹：node tools/review-launch.js --close ${id}${dir === realDir(os.tmpdir()) ? '' : ` --dir ${dir}`}`,
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

/**
 * 收樹：還沒收的每一棵都在、HEAD 沒變、狀態乾淨、沒上鎖才動手；有一棵不對就全部留著給人看。
 * 一棵一棵移除，每收好一棵就記進紀錄：收到一半失敗時照實說哪一棵收了、哪一棵沒有，重跑只處理還沒收的（#49 r1 R5）。
 */
/** 移除一棵樹；回 null＝成功，否則回原因。考題換掉它，才考得到「第二棵移除失敗」那一條路。 */
function removeTree(root, t) {
  const r = spawnSync('git', ['worktree', 'remove', t], { cwd: root, env: gitEnv(), encoding: 'utf8' });
  return r.error || r.status !== 0 ? ((r.error && r.error.message) || (r.stderr || '').trim() || `退 ${r.status}`) : null;
}

function close(changeArg, { settings = readSettings(), dir: dirArg = os.tmpdir(), leftoverRoots = [os.tmpdir(), '/tmp'], remove = removeTree } = {}) {
  const dir = realDir(dirArg);
  const project = settings.platform && settings.platform.project;
  if (!filled(project)) throw new LaunchError('專案設定的 platform.project 還沒填：找不到樹放在哪');
  const re = folderRe(slugOf(project), String(changeArg).replace(/[^A-Za-z0-9._-]/gu, ''));
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { throw new LaunchError(`讀不了 ${dir}（${e.code || e.message}）`); }
  const open = entries.filter((n) => re.test(n)).map((n) => path.join(dir, n)).filter((f) => {
    try { return !JSON.parse(fs.readFileSync(path.join(f, 'launch.json'), 'utf8')).closedAt; } catch { return false; }
  });
  if (!open.length) throw new LaunchError(`在 ${dir} 底下找不到變更 ${changeArg} 還開著的審查樹（review-${slugOf(project)}-${changeArg}-r*）`);
  const lines = [];
  let refused = false;
  for (const folder of open) {
    const recFile = path.join(folder, 'launch.json');
    const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
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
      const st = gitOk(t, ['status', '--porcelain']) ? git(t, ['status', '--porcelain']) : null;
      if (st === null) problems.push(`${what}的狀態讀不出`);
      else if (st) problems.push(`${what}不乾淨：${st.split('\n').slice(0, 5).join('；')}${st.split('\n').length > 5 ? '…' : ''}`);
    }
    const already = rec.removed.length ? `（先前已收：${rec.removed.map((t) => (t === rec.tree ? '審查樹' : '突變副本')).join('、')}）` : '';
    if (problems.length) {
      refused = true;
      lines.push(`沒收 r${rec.round}（${folder}）${already}：`, ...problems.map((p) => `  ・${p}`), `  還沒收的${todo.map(([w]) => w).join('、')}都留著；看完要收就自己 git worktree remove（突變副本有改過的檔要加 --force）。`);
      continue;
    }
    let failed = null;
    for (const [what, t] of todo.filter(([, x]) => !rec.removed.includes(x))) {
      const why = remove(rec.root, t);
      if (why) { failed = `${what}移除失敗：${why}`; break; }
      rec.removed.push(t);
      save();
    }
    if (failed) {
      refused = true;
      const done = rec.removed.map((t) => (t === rec.tree ? '審查樹' : '突變副本'));
      lines.push(`收到一半 r${rec.round}（${folder}）：${done.length ? `已收 ${done.join('、')}；` : ''}${failed}。紀錄已記下收了哪幾棵，排除原因後重跑只會收剩下的。`);
      continue;
    }
    rec.closedAt = new Date().toISOString();
    save();
    lines.push(`收好 r${rec.round}${already}：兩棵樹的 HEAD 都還是 ${rec.head.slice(0, 7)}、都乾淨，已移除（提示與輸出檔留在 ${folder}）。`);
    const { groups, unreadable } = freshEntries(leftoverRoots, folder, Date.parse(rec.startedAt), re);
    for (const u of unreadable) lines.push(`  ⚠️ 讀不了 ${u}，那裡比開樹晚的沒列`);
    for (const g of groups) {
      lines.push(`  ${g.root} 第一層比開樹晚的 ${g.paths.length} 筆（新的在前；只列、不刪；可能是複審者另建的，也可能是別的程式同時寫的）：`);
      for (const p of g.paths.slice(0, 10)) lines.push(`    ${p}`);
      if (g.paths.length > 10) lines.push(`    另有 ${g.paths.length - 10} 筆沒列`);
    }
  }
  return { code: refused ? 1 : 0, lines };
}

function parseArgs(argv) {
  const out = { change: undefined, reviewer: undefined, close: undefined, dir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--reviewer' || a === '--close' || a === '--dir') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} 後面要接值` };
      out[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('--')) return { error: `不認得的參數：${a}` };
    else if (out.change === undefined) out.change = a;
    else return { error: `多給了一個參數：${a}` };
  }
  if (out.close !== undefined) return out.change === undefined && out.reviewer === undefined ? out : { error: '--close 只收變更編號（和 --dir）' };
  if (out.change === undefined || out.reviewer === undefined) return { error: '要給變更編號與 --reviewer' };
  return out;
}

function main(argv, opts = {}) {
  const a = parseArgs(argv);
  if (a.error) return { code: 2, lines: [a.error, USAGE] };
  const dir = a.dir || opts.dir;
  try {
    if (a.close !== undefined) return close(a.close, { ...opts, ...(dir ? { dir } : {}) });
    return launch(a.change, a.reviewer, { ...opts, ...(dir ? { dir } : {}) });
  } catch (e) {
    if (e instanceof LaunchError) return { code: 2, lines: [`送審產生器：${e.message}——${a.close !== undefined ? '沒有收' : '沒有產生'}。`] };
    throw e;
  }
}

if (require.main === module) {
  let result;
  try { result = main(process.argv.slice(2)); } catch (e) { result = { code: 2, lines: [`送審產生器：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——沒有產生。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { main, launch, close, fill, promptPart, substitute, scopeOf, roundsOf, parseArgs, templateProblems, freshEntries, lockedTrees, FILL, SAFE, COMMAND_TOKENS, LaunchError };
