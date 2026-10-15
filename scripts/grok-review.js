#!/usr/bin/env node
// @ts-check
// 隔離傳輸不代表完成複審；正式結論仍須由 Grok 產生、逐字發布，再經 F7 核對。
// 本前端不提供 GitHub 寫入能力，也不判斷發現是否屬實；runner 的圍欄由 grok-scan.js 負責。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../lib/git-env.js';
import { isMainModule } from '../lib/is-main.js';
import launcher from '../tools/review-launch.js';
import platform from '../tools/platform.js';
import collab from '../tools/gates/check-collab-fields.js';
import pending from '../tools/pending-rulings.js';
import riskTier from '../tools/risk-tier.js';
import reviewVerdicts from '../tools/gates/check-review-verdicts.js';
import { repoLabelFrom, REVIEW_MODEL_FLOOR, reviewModelsQualified, runScan } from './grok-scan.js';

const SHA = /^[a-f0-9]{40}$/u;
const MODEL = /^[A-Za-z0-9._-]+$/u;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** @returns {never} */
const stop = (message) => { throw new Error(`${message}；請重新核對送審產生器的 launch.json、提示與設定，再重跑 scripts/grok-review.js。`); };
/** @type {(ok: unknown, message: string) => asserts ok} */
const demand = (ok, message) => { if (!ok) stop(message); };
const read = (file) => { demand(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), '材料必須是一般檔案'); return readFileSync(file, 'utf8'); };

export function reviewGit(cwd, args) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  demand(!result.error && result.status === 0, '版本核對指令失敗');
  return result.stdout.trimEnd();
}

/** 拒收事實格以外的加料；格內人工理由是否夾帶指令，仍由發審者依 F3 對公開 PR 核實。 */
export function promptValues(template, prompt) {
  const part = launcher.promptPart(template);
  demand(part !== null, '送審範本缺少正文');
  let at = 0;
  let slotIndex = 0;
  let pattern = '^';
  const keys = [];
  for (const match of part.matchAll(/<[^<>\n]+>/gu)) {
    pattern += escapeRe(part.slice(at, match.index));
    const [slot, key] = launcher.FILL[slotIndex++] || [];
    demand(slot === match[0], '送審範本與格子表不符');
    pattern += key === null ? escapeRe(slot) : '([\\s\\S]*?)';
    if (key !== null) keys.push(key);
    at = match.index + match[0].length;
  }
  demand(slotIndex === launcher.FILL.length, '送審範本格數不符');
  const matched = new RegExp(pattern + escapeRe(part.slice(at)) + '$', 'u').exec(prompt);
  demand(matched !== null, '送審提示含範本事實格以外的改動');
  const values = {};
  keys.forEach((key, i) => {
    const value = matched[i + 1];
    demand(value.trim() !== '', '送審提示有空事實格');
    demand(!Object.hasOwn(values, key) || values[key] === value, '送審提示重複事實不一致');
    values[key] = value;
  });
  return values;
}

function credentialFree(text) {
  demand(!/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}|\bsk-[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text), '送審材料疑似含憑證');
}

/** 已公開材料也可能殘留個人路徑；此檢查不聲稱能辨識任意編碼的機密。 */
export function publicMaterial(text) {
  credentialFree(text);
  demand(!/(?:file:\/\/|\/(?:Users|home|private|tmp)\/|\/var\/folders\/)/u.test(text), '送審材料仍含本機絕對路徑');
  return text;
}

/** 僅投影獨立反引號內的完整路徑；無法界定的路徑留給 publicMaterial 拒收，不猜它在哪裡結束。 */
export function projectPublicBody(record, url) {
  const original = record.body;
  credentialFree(original);
  let omittedPathCount = 0;
  const body = original.replace(/(?<!`)`((?:file:\/\/|\/(?:Users|home|private|tmp)\/|\/var\/folders\/)[^`\r\n]*)`(?!`)/gu, (_match, path) => {
    omittedPathCount++;
    const kind = path.startsWith('file://') ? 'file URL' : path.split('/')[1];
    return '`[本機絕對路徑已隱去：' + kind + ' 類]`';
  });
  return omittedPathCount ? { ...record, body, privacyProjection: { kind: '隱私投影，非原文', url,
    originalBodySha256: hash(original), projectedBodySha256: hash(body), omittedPathCount } } : record;
}

export function prepareReview(args, { git = reviewGit, ask = platform.ask } = {}) {
  const { model, effort, reviewTree, mutationCopy, promptFile, outFile, change, project } = args;
  demand(MODEL.test(model || '') && MODEL.test(effort || '') && !/auto/iu.test(`${model} ${effort}`), '必須明確指定模型與推理');
  demand(/^[1-9][0-9]*$/u.test(String(change)) && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(project || ''), '專案或變更編號無效');
  const folder = realpathSync(dirname(resolve(promptFile)));
  const record = JSON.parse(read(join(folder, 'launch.json')));
  demand(record && record.reviewer === 'Grok' && String(record.change) === String(change), 'launch 身分或變更不符');
  demand(Number.isSafeInteger(record.round) && record.round > 0 && SHA.test(record.head) && SHA.test(record.base), 'launch 版本或輪次無效');
  const expected = { tree: reviewTree, mutation: mutationCopy, promptFile, outFile };
  for (const [key, value] of Object.entries(expected)) {
    demand(typeof value === 'string' && resolve(record[key]) === resolve(value), `launch 的 ${key} 路徑不符`);
  }
  demand(resolve(promptFile) === join(folder, 'prompt.md') && resolve(outFile) === join(folder, 'output.log')
    && realpathSync(reviewTree) === join(folder, 'tree') && realpathSync(mutationCopy) === join(folder, 'mutation'), '送審路徑不是同一輪的隔離樹');
  demand(!existsSync(outFile) && !existsSync(`${outFile}.receipt.json`), '本輪輸出已存在，不可覆寫或重用');
  const root = realpathSync(record.root);
  demand(realpathSync(git(root, ['rev-parse', '--show-toplevel'])) === root, 'launch 倉庫根目錄不符');
  demand(repoLabelFrom(git(root, ['remote', 'get-url', 'origin'])) === project, '倉庫遠端與專案不符');
  const common = realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  for (const tree of [reviewTree, mutationCopy]) {
    demand(realpathSync(git(tree, ['rev-parse', '--show-toplevel'])) === realpathSync(tree), '審查副本不是倉庫根目錄');
    demand(realpathSync(git(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) === common, '審查副本不是同一倉庫');
    demand(git(tree, ['rev-parse', 'HEAD']) === record.head && git(tree, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD', '審查副本未固定在受審版本');
    demand(git(tree, ['status', '--porcelain', '--untracked-files=all']) === '', '審查副本不乾淨');
  }
  for (const sha of [record.base, record.head]) demand(git(root, ['rev-parse', '--verify', `${sha}^{commit}`]) === sha, '受審版本或基底不存在');
  const settings = JSON.parse(git(root, ['show', `${record.head}:settings.json`]));
  demand(settings.platform?.project === project, '受審設定的專案不符');
  const roles = collab.rolesOf(settings).usable;
  demand(roles.includes('Grok'), '受審設定未登記 Grok 參與者');
  const reviewer = settings.reviewers?.find((item) => item.participant === 'Grok');
  demand(reviewer?.source === 'Grok CLI' && reviewer.strongest === model && reviewer.maxEffort === effort, '受審設定的 Grok 模型、推理或來源不符');
  const template = git(root, ['show', `${record.head}:templates/review-request.md`]) + '\n';
  const original = read(promptFile);
  const values = promptValues(template, original);
  const same = { project, change: String(change), reviewer: 'Grok', source: 'Grok CLI', head: record.head,
    headShort: record.head.slice(0, 7), base: record.base, round: String(record.round), reviewTree, mutationCopy };
  for (const [key, value] of Object.entries(same)) demand(values[key] === value, `提示的 ${key} 與 launch 不符`);
  demand(values.implementer !== 'Grok' && ['高', '中', '低'].includes(values.tier), '角色分離或風險不符');
  demand(values.fullDiff === `git diff ${record.base}...${record.head}`, '整支差異版本不符');
  let previousHead;
  if (values.roundDiff !== '沒有') {
    const match = /^git diff ([a-f0-9]{40})\.\.([a-f0-9]{40})$/u.exec(values.roundDiff);
    demand(match && match[2] === record.head, '上一輪差異版本無效');
    previousHead = match[1];
    demand(git(root, ['rev-parse', '--verify', `${previousHead}^{commit}`]) === previousHead, '上一輪版本不存在');
  }
  const rl = settings.reviewLaunch;
  demand(values.copyTest === launcher.substitute(rl.copyTest, { mutationCopy }, '考題指令').text
    && values.postComment === launcher.substitute(rl.postComment, { project, change }, '貼文指令').text
    && values.changeLink === launcher.substitute(rl.changeLink, { project, change }, '變更連結').text, '送審指令或連結不符設定');
  const current = ask('change', { change: String(change) }, { settings });
  demand(current.id === String(change) && current.headSha === record.head && current.baseBranch === values.baseBranch && current.state === 'OPEN', '平台上的變更或版本已移動');
  demand(collab.canonicalRole(collab.fieldValue(current.body, '複審者'), roles) === 'Grok'
    && collab.canonicalRole(collab.fieldValue(current.body, '實作者'), roles) === values.implementer, '平台分工與送審提示不符');
  const base = ask('branchSha', { branch: current.baseBranch }, { settings });
  demand(base.sha === record.base, '平台基底已移動');
  const comments = ask('comments', { change: String(change) }, { settings });
  const rounds = launcher.roundsOf(comments, 'Grok', 'Grok CLI', roles);
  demand(rounds.round === record.round, '平台上的複審輪次已移動');
  const previous = rounds.previous ? launcher.substitute(rl.commentLink, { project, change, comment: rounds.previous.c.id }, '留言連結').text : '沒有';
  demand(values.previous === previous, '上一輪結論連結不符');
  if (rounds.previous) demand(previousHead === git(root, ['rev-parse', '--verify', `${rounds.previous.h.sha}^{commit}`]), '上一輪差異不對應前輪結論');
  else demand(previousHead === undefined, '首輪不得帶不明來源的前輪差異');
  const decider = pending.deciderOf(settings);
  demand(decider, '裁示者未登記，無法核對相關裁示');
  const rulings = pending.evaluate(ask('allComments', {}, { settings }), decider);
  demand(!rulings.unsure, '平台相關裁示無法核對');
  const related = /** @type {Array<{ ask: {change: string, id: string, body: string}, by: {change: string, id: string, body: string} }>} */ (rulings.ruled)
    .filter((item) => String(item.ask.change) === String(change));
  const links = related.map((item) => launcher.substitute(rl.commentLink,
    { project, change: item.by.change, comment: item.by.id }, '裁示連結').text);
  demand(values.rulings === (links.length ? links.join('、') : '沒有'), '相關裁示不符官方配對');
  const risk = riskTier.run(change, { settings, platform: { ask }, git: (command) => {
    try { return { ok: true, out: git(root, command) }; } catch { return { ok: false, out: '' }; }
  } });
  const computed = risk.result;
  demand(risk.code === 0 && computed && computed.head === record.head, '官方風險級別算不出來或版本已移動');
  const verdicts = reviewVerdicts.evaluate(comments, record.head, 'Grok', roles);
  demand(!verdicts.unsure, '平台結論時間無法核對');
  const state = rounds.previous ? verdicts.reviewers[`Grok（${rounds.previous.h.source}）`] : null;
  const passed = Boolean(state) && !state.blocking && state.round === rounds.previous.h.round;
  const lane = computed.fastLaneAI === true;
  const exhausted = lane && launcher.twoMissesInARow(comments, 'Grok', 'Grok CLI', roles);
  const tierWhy = !lane ? '照表算的'
    : exhausted ? '照表算的；這一支原本走快速通道（AI），這一位已經連兩輪沒「通過」，這一輪起照這一級走一般流程（F12）'
      : '照表算的；分級腳本判這一支走快速通道（AI）：第 1 輪起只核差異、不掃描（F12）';
  if (values.tierWhy.startsWith('照表算的')) {
    demand(values.tier === computed.level && values.tierWhy === tierWhy, '自動風險級別或理由不符官方演算');
  }
  // D4／F2 允許人工調級或改回全審；理由內容與誰改的宣告，沿用 F3 由發審者核對，不替它背書。
  const scope = lane && !exhausted ? '只核差異' : launcher.scopeOf(settings.reviewTiers?.[values.tier], record.round, passed);
  demand(scope, '官方審查範圍算不出來');
  demand(values.scope === scope || (values.scope.startsWith('全審') && values.scope.slice(2).trim() !== ''), '預設審查範圍不符官方演算；人工改回全審須依範本註明');
  const projectComment = (comment) => projectPublicBody(comment, launcher.substitute(rl.commentLink,
    { project, change: comment.change || change, comment: comment.id }, '公開留言連結').text);
  const context = { change: projectPublicBody(current, values.changeLink), comments: comments.map(projectComment),
    checks: ask('checks', { sha: record.head }, { settings }), changedFiles: ask('changedFiles', { change: String(change) }, { settings }),
    relatedRulings: related.map((item) => ({ ask: projectComment(item.ask), by: projectComment(item.by) })) };
  const converted = { ...values, reviewTree: '.', mutationCopy: '../mutation',
    copyTest: values.copyTest.split(mutationCopy).join('../mutation'), fullDiff: 'cat ../full.diff',
    roundDiff: previousHead ? 'cat ../round.diff' : '沒有',
    postComment: '隔離盒沒有 GitHub 憑證，本輪在盒內無法貼文' };
  let prompt = launcher.fill(template, converted);
  prompt = prompt.replace(`git show ${record.base}:RULES.md`, 'cat ../base/RULES.md');
  prompt = prompt.replace('開始前先核對審查樹的版本是不是上面這個完整版本；不是就停下來，在回報裡說明。',
    '開始前以 ../review-manifest.json 核對上列版本與各材料的雜湊；不符就停下來，在回報裡說明。盒內是外層從指定 commit 匯出的材料，沒有原倉庫的 .git；版本與差異由外層核對及提供，不宣稱在盒內執行原倉庫的 git 指令。');
  prompt += `\n\n## 公開平台材料（隱私投影，非原文）\n\n${JSON.stringify(context, null, 2)}\n`;
  publicMaterial(prompt);
  return { record, root, prompt, originalSha256: hash(original), contextSha256: hash(JSON.stringify(context)),
    review: { project, change: String(change), reviewer: 'Grok', source: 'Grok CLI', round: record.round, ...(previousHead ? { previousHead } : {}) } };
}

export function validateReply(reply, expected) {
  demand(typeof reply === 'string' && reply.trim() !== '', '安全 runner 未提供 Grok 原文');
  const header = new RegExp('^🤖 Grok｜來源：Grok CLI｜審 `'+ expected.head.slice(0, 7) + '`｜r' + expected.round + '｜結論：(通過|需修改後再審|不可合併)$', 'u');
  const lines = reply.split(/\r?\n/u);
  demand(header.test(lines[0]), 'Grok 原文的身分、版本、輪次或結論標頭不符');
  demand(lines.filter((line) => /^🤖/u.test(line)).length === 1, 'Grok 原文有多個結論標頭');
  for (const heading of ['### 本輪實際用的設定', '### 清單逐項結果', '### 發現']) demand(lines.includes(heading), 'Grok 原文缺正式結論小標');
  demand(lines.some((line) => line.trim() === '未貼'), 'Grok 原文未如實標示未貼');
  publicMaterial(reply);
  return reply;
}

export async function runReview(args, { git = reviewGit, ask = platform.ask, runner = runScan } = {}) {
  let temp;
  try {
    const ready = prepareReview(args, { git, ask });
    temp = mkdtempSync(join(dirname(resolve(args.promptFile)), 'grok-review-'));
    const material = join(temp, 'materials.md');
    writeFileSync(material, ready.prompt, { mode: 0o600, flag: 'wx' });
    const result = await runner({ purpose: 'review', repo: ready.root, base: ready.record.base, head: ready.record.head,
      promptFile: material, model: args.model, effort: args.effort, review: ready.review });
    if (result.code !== 0) return { code: result.code === 1 ? 1 : 2, lines: ['正式複審未完成：安全 runner 非零；依隔離程序處理並重跑，不產生結論。'] };
    const got = result.review;
    demand(got && got.head === ready.record.head && got.base === ready.record.base && got.source === 'Grok CLI'
      && got.model === args.model && got.effort === args.effort && /^[a-f0-9]{64}$/u.test(got.manifestSha256)
      && typeof got.recipe === 'string' && got.recipe.length > 0 && typeof got.resultsDir === 'string' && got.resultsDir.length > 0, '安全 runner 的複審收據不符');
    demand(got.modelFloor === REVIEW_MODEL_FLOOR && got.modelQualified === true && reviewModelsQualified(got.observedModels), '安全 runner 的模型資格收據不符');
    const reply = validateReply(got.reply, { head: ready.record.head, round: ready.record.round });
    demand(got.replySha256 === hash(reply), '安全 runner 原文雜湊不符');
    const receipt = { project: args.project, change: String(args.change), head: ready.record.head, base: ready.record.base,
      reviewer: 'Grok', source: 'Grok CLI', round: ready.record.round, model: args.model, effort: args.effort,
      observedModels: [...got.observedModels], modelFloor: got.modelFloor, modelQualified: got.modelQualified,
      providerSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
      runnerSha256: hash(readFileSync(new URL('./grok-scan.js', import.meta.url))),
      originalPromptSha256: ready.originalSha256, materialSha256: hash(ready.prompt), publicContextSha256: ready.contextSha256,
      replySha256: got.replySha256, manifestSha256: got.manifestSha256, runnerRecipe: got.recipe, resultsDir: got.resultsDir, posted: false };
    writeFileSync(`${args.outFile}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    writeFileSync(args.outFile, reply, { flag: 'wx', mode: 0o600 });
    return { code: 0, lines: ['Grok 原文與收據已保存，尚未貼文；由外層逐字代貼並依 F7 核對，退出零不代表通過。'], receipt };
  } catch (error) {
    return { code: 2, lines: [`正式複審未完成：${error instanceof Error ? error.message : '讀取或驗證失敗'}；不產生正式通過。`] };
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

export function parseReviewArgs(argv) {
  const flags = { '--model': 'model', '--effort': 'effort', '--review-tree': 'reviewTree', '--mutation-copy': 'mutationCopy',
    '--prompt-file': 'promptFile', '--out-file': 'outFile', '--change': 'change', '--project': 'project' };
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    demand(key && !Object.hasOwn(args, key) && argv[i + 1] && !argv[i + 1].startsWith('--'), '命令列參數不符');
    args[key] = argv[i + 1];
  }
  demand(Object.keys(args).length === Object.keys(flags).length, '命令列缺少必要參數');
  return args;
}

if (isMainModule(import.meta.url)) {
  let result;
  try { result = await runReview(parseReviewArgs(process.argv.slice(2))); }
  catch { result = { code: 2, lines: ['請核對八項命令列參數，再重跑 scripts/grok-review.js。'] }; }
  process.stdout.write(result.lines.join('\n') + '\n');
  process.exitCode = result.code;
}
