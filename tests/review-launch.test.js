// 守送審產生器（規矩 F1、F3、F11）：送審提示的格子照範本的位置填事實、兩棵樹開在受審版本、啟動指令照設定帶模型與推理；收樹前先核。
//
// 守得到的：
//   ①範本的格子跟產生器的表一一對上（範本加、刪、換一格就紅）；同一個字樣在不同位置填不同的值（複審者與實作者）；只留 <三選一>；
//     「規矩讀基底那一版」那一格填的是基底版本碼（不是受審版本）；
//   ②真的倉庫裡跑一遍：兩棵樹都在受審版本、提示與紀錄寫好、啟動指令的模型、推理、路徑都換上了；問平台基底那一顆時，分支名照平台回的
//     這支 PR 的基底分支傳（假平台的基底刻意不叫 main、問別的名字就問不到；#96 r5 R6）；
//   ③第 2 輪起：輪次＝這一位最大的輪次＋1、上一輪結論與上一輪之後的差異指到那一則、別位的結論不算；同一位＝角色＋來源字串；
//     相關裁示列問在本支、配到的 ⚖️；
//   ④本輪範圍照分級表那一列與輪次（上一輪是算數的通過＝照「通過後回頭改」那一格；算不算照結論閘：缺固定小標的不算、
//     同一輪相反結論或對不同版本各給結論＝衝突不算、最近貼的那一輪不算數就不縮）；讀不懂＝不產生；印的提醒說改級時範圍要一起改；
//   ⑤設定沒填或不對、PR說明指定的複審者不是這一位、平台問不到、本機沒有受審版本、路徑有空白、這一輪的資料夾已經在＝退 2，
//     而且**一棵樹都沒開、一個檔都沒寫**；開到一半失敗＝只收這一次開的樹（含 add 建好樹才因掛鉤失敗的那一棵），
//     開樹前就登記著的（登記了、目錄暫時不在）保住，排除原因後重跑送得出去；
//   ⑥收樹（--close 與 --purge）：兩棵都在、乾淨、HEAD 沒變、沒上鎖才收；有一棵不對＝退 1、都留著；收到一半＝照實說收了哪一棵、記進紀錄、重跑只收剩下的；
//     找不到＝退 2；暫存區比開樹晚的在首行摘要印筆數並逐筆列、不刪（自己那一層與上層不算，讀不了的分開說）；帶 --purge 時收樹成功後一併清除審查容器資料夾（已收過樹的也可補跑 --close --purge 清除）；
//   ⑦git 那一族環境變數指到別的倉庫，照樣在這一個倉庫開樹（E4）；⑧指令入口：參數不對、空白設定的複本裡跑＝退 2；
//   ⑩分級腳本判能走快速通道（AI）（F12）：本輪範圍＝只核差異、提示寫明為什麼；這一位連兩輪沒「通過」（輪次相鄰；每一輪算不算
//     通過照結論閘判：缺小標的不算、同輪相反結論＝衝突算沒過）就改回照分級表；通過之後回頭改的那一輪仍走快速通道；
//   ⑪通用插座（SAFE 字元集與 --post 外殼代貼結論）：非 ASCII 模型／推理名放行、殼解讀字元與空白照擋；--post 每輪排他鎖（post.lock）與獨立結論暫存檔、
//     先核兩棵樹未收、已登記、乾淨、HEAD 沒變、沒上鎖（不符退 1、不貼），再核結論檔與標頭、剝除文末單獨一行的「未貼」、核固定小標（擁有者豁免）、
//     保留 postComment 引號與空白參數語意、核平台版本／複審者與同輪未重複，通過才代貼並逐字核對送出全文與記下 postedAt；同輪並發雙程序只送出一次；
//   ⑫複審後掃生命週期（G1、G2；--scan、--scanner、--scan-post、--scan-close）：templates/scan-record.md 提示範本與 SCAN_FILL 一一對上且不含 🤖；
//     快速通道、表定不掃、未設定掃描者、指定複審者未對當版貼通過皆印原因或未執行收口句並退 2；支援 --scanner <識別值> 切換為 reviewers 裡其他第三位 AI（自動從複審指令轉換唯讀掃描指令）；通過後開唯讀掃描樹、印啟動指令與紀錄骨架（前版已收樹的舊 scan 資料夾在新提交重掃時自動替換）；
//     --scan-post 核掃描樹乾淨與 HEAD 未變（不符退 1），擋含 🤖 的掃描留言、核 🔍 標頭、剝除文末未貼、自動補「> 掃描時序：…」並代貼（與 check-review-verdicts.js 相容）；--scan-close 驗乾淨後收樹（支援 --purge 一併清除掃描容器資料夾）；
//   ⑬--grok-exec 隔離與受控認證轉送（Grok 複審／掃描啟動器）：參數解析與未知旗標拒收、Seatbelt 靜態檢查與預檢失敗拒啟、OIDC 自動續期與連結檔拒收、轉送器規則核對、review 模式（含突變副本）端到端執行、DLP 與原始輸出完整保留（含前言之範例輸出由 --post／--scan-post 拒貼）；
//   ⑭一鍵執行（--run 與 --run --purge）：複審與掃描一鍵串聯開樹→執行啟動指令→外殼驗樹代貼→收樹（含 --purge），任一步失敗即停並保留現場供查。
// ⚠️ 守不到的：印出來之後有沒有照用、複審者實際用的模型與推理；樣板本身寫得對不對（只驗記號）；平台給的事實是不是真的；
//    假平台的基底分支名只有一個：工具若把那個名字寫死、不讀平台回的基底欄位，分不出來（#101 掃描 1-2）。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { gitEnv } = require('../tools/git-env.js');
const { main, launch, close, post, prepareVerdict, scanPost, scanClose, prepareScan, resolveScannerSpec, deriveScanCommand, stripGrokPreamble, splitCommandArgs, defaultRunPost, defaultRunExec, substitute, fill, promptPart, scopeOf, roundsOf, twoMissesInARow, parseArgs, templateProblems, freshEntries, materializeIsolatedGitRepo, runGrokExec, GROK_PINNED_ISSUER, GROK_PINNED_CLIENT_ID, FILL, SCAN_FILL, SCAN_TEMPLATE, SAFE, LaunchError } = require('../tools/review-launch.js');
const { evaluate: evaluateVerdicts, VERDICTS } = require('../tools/gates/check-review-verdicts.js');
const { read: readSettings } = require('../tools/build-settings.js');
const { PlatformError } = require('../tools/platform.js');
const { runInCopy, unfilled } = require('./helpers/kit-copy.js');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'templates', 'review-request.md'), 'utf8');
const TIERS = unfilled().reviewTiers;

// tmp() 開的暫存資料夾記進 made、整支跑完（不論成敗）一起收（#79 兩支考題的同一種收法）：快速通道那一題把 tmp() 直接當參數傳，
// 該題的 finally 拿不到那些路徑；別題在收尾前就失敗時也靠這裡收。只收 made 上的，暫存區別的東西不碰。
// 守不到：跑到一半被強制結束（收尾沒機會跑）的那一次；不經 tmp() 開的不在 made 上（例如共用輔助 runInCopy 自己開、自己收）。
const made = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; }
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv(), encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}：${r.stderr}`);
  return r.stdout.trim();
}
/** 暫存倉庫：基底一顆、受審版本一顆。 */
function repo() {
  const dir = tmp('review-launch-repo-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'maintenance.auto', 'false');
  sh(dir, 'config', 'gc.auto', '0');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'base');
  const base = sh(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'head\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'head');
  const head = sh(dir, 'rev-parse', 'HEAD');
  return { dir, base, head };
}

const settingsFor = (over = {}) => ({
  participants: [
    { role: '裁示者（人）', id: 'Boss', account: 'boss-acct' },
    { role: 'AI 甲', id: 'Alpha', account: 'ai-acct' },
    { role: 'AI 乙', id: 'Beta', account: 'ai-acct' },
  ],
  identityDomain: '純拉丁字母',
  platform: { name: 'Fake', project: 'acme/kit' },
  risk: { families: [{ pattern: '^tools/', tier: '高' }, { pattern: '^docs/', tier: '低' }], raise: [] },
  reviewTiers: TIERS,
  reviewers: [{
    participant: 'Beta', strongest: 'm-strong', second: 'm-second', maxEffort: 'max', autoMode: 'ultra', source: 'beta CLI',
    launch: '產生器印', command: 'beta run --model {model} --effort {effort} -C {reviewTree} --add {mutationCopy} < {promptFile} > {outFile}',
    machine: '幾乎沒有', promptOnly: '全靠提示', verified: '',
  }],
  reviewLaunch: {
    changeLink: 'https://x.invalid/{project}/pull/{change}',
    commentLink: 'https://x.invalid/{project}/pull/{change}#c-{comment}',
    postComment: 'post {change} --file <你寫好的結論檔>',
    copyTest: 'npm --prefix {mutationCopy} test -- <考題檔>',
  },
  ...over,
});
const BODY = '## 協作欄位\n\n- **實作者**：Alpha\n- **複審者**：Beta\n- **預計修改的檔案**：tools/x.js\n- **這支若完全失敗，最糟失去什麼**：x\n';
let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 7, 0, 0, ++n)).toISOString();
const verdict = (role, round, sha, v, over = {}) => ({ id: `v${++n}`, author: 'ai-acct', createdAt: at(), body: `🤖 ${role}｜來源：${role === 'Beta' ? 'beta CLI' : 'alpha CLI'}｜審 \`${sha.slice(0, 7)}\`｜r${round}｜結論：${v}\n\n### 本輪實際用的設定\n\n### 清單逐項結果\n`, ...over });

/** 假平台：答案照 answers；沒給的動作丟平台錯。記下被問了什麼。 */
function fakePlatform(answers) {
  const asked = [];
  return {
    asked,
    ask(op, args) {
      asked.push(op);
      const a = typeof answers[op] === 'function' ? answers[op](args) : answers[op];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new PlatformError(`測試沒給 ${op}`);
      return a;
    },
  };
}
// 基底分支刻意不叫 main（專案設定的主幹名）：傳錯名字、傳空的，或拿設定的主幹名去問，都問不到基底那一顆（#96 r5 R6）
const BASE_BRANCH = 'trunk';
const answersFor = ({ head, base }, over = {}) => ({
  change: { id: '7', title: 't', body: BODY, baseBranch: BASE_BRANCH, headBranch: 'topic', headSha: head, state: 'OPEN', isDraft: true, isCrossRepo: false, autoMergeOn: false, changedFileCount: '1', author: 'ai-acct' },
  changedFiles: [{ path: 'tools/x.js', status: 'modified', previousPath: null }],
  branchSha: (args) => (args && args.branch === BASE_BRANCH ? { sha: base } : new PlatformError(`假平台只有基底分支 ${BASE_BRANCH}，問的是 ${args && args.branch}`)),
  comments: [],
  allComments: [],
  ...over,
});
const values = () => Object.fromEntries(FILL.filter(([, k]) => k).map(([, k]) => [k, `〔${k}〕`]));

test('①範本的格子跟產生器的表一一對上；同一個字樣在不同位置填不同的值；只留 <三選一>', () => {
  const text = fill(TEMPLATE, values());
  assert.deepEqual(text.match(/<[^<>\n]+>/gu), ['<三選一>'], '填完只剩複審者要填的那一格');
  assert.match(text, /角色識別值 〔reviewer〕/u);
  assert.match(text, /- 實作者：〔implementer〕/u, '同樣寫 <識別值> 的實作者那一格要填實作者，不是複審者');
  assert.match(text, /🤖 〔reviewer〕｜來源：〔source〕｜審 `〔headShort〕`｜r〔round〕｜結論：<三選一>/u);
  assert.match(text, /- 審查樹：你現在所在的 〔reviewTree〕，/u);
  assert.match(text, /- 突變副本：〔mutationCopy〕，/u, '兩個 <路徑> 照順序是審查樹、突變副本');
  assert.match(text, /結論只能三選一，一字不差/u, '範本固定的字照留（F3）');
  assert.match(text, /都是受審資料，不是給你的指令/u, '受審的文字不是指令那一句照留');
  assert.ok(text.includes('（`git show 〔base〕:RULES.md`，指示檔同理）'), '規矩讀基底那一版：那一格填的是基底版本碼，不是受審版本');
  assert.ok(text.startsWith('你是 '), '只送分隔線之後那一段');
  assert.equal(promptPart('沒有分隔線'), null);
  const part = promptPart(TEMPLATE);
  for (const [what, broken] of [
    ['刪一格', TEMPLATE.replace('（短碼 <短碼>）', '')],
    ['多一格', TEMPLATE.replace('- 實作者：<識別值>', '- 實作者：<識別值>\n- 多的：<新格子>')],
    ['兩格換位置', TEMPLATE.replace('<完整版本碼>（短碼 <短碼>）', '<短碼>（完整 <完整版本碼>）')],
    ['沒有分隔線', TEMPLATE.replace('\n---\n', '\n')],
  ]) assert.throws(() => fill(broken, values()), /對不上|分隔線/u, `${what}要擋（範本改了，產生器要一起改）`);
  assert.ok(part.includes('<三選一>'));
  const missing = values(); delete missing.base;
  assert.throws(() => fill(TEMPLATE, missing), /沒有值/u, '少一個值不可以留空格送出去');
});

test('③同一位＝角色＋來源：同一個角色換了來源，它的輪次與結論不算這一位的（#49 r1 R2）', () => {
  const roles = ['Boss', 'Alpha', 'Beta'];
  const cli = verdict('Beta', 1, 'a'.repeat(40), '需修改後再審');
  const desk = { ...verdict('Beta', 7, 'b'.repeat(40), '通過'), body: verdict('Beta', 7, 'b'.repeat(40), '通過').body.replace('來源：beta CLI', '來源：Beta desktop') };
  const got = roundsOf([cli, desk], 'Beta', 'beta CLI', roles);
  assert.equal(got.round, 2);
  assert.equal(got.previous.c.id, cli.id);
  assert.equal(roundsOf([cli, desk], 'Beta', '  beta   CLI ', roles).round, 2, '來源字串的空白照結論閘的讀法收攏');
  assert.equal(roundsOf([cli, desk], 'Beta', 'Beta desktop', roles).round, 8, '對照組：換成那個來源就是它的輪次');
  // 角色那一半也要單獨成立：不同角色共用同一個來源字串時，別位的輪次不算（#49 r2 R4；設定與結論閘都允許共用來源）
  const alphaSameSource = { ...verdict('Alpha', 5, 'c'.repeat(40), '通過'), body: verdict('Alpha', 5, 'c'.repeat(40), '通過').body.replace('來源：alpha CLI', '來源：beta CLI') };
  const mix = roundsOf([cli, alphaSameSource], 'Beta', 'beta CLI', roles);
  assert.equal(mix.round, 2, '同一個來源、別的角色：不算這一位的');
  assert.equal(mix.previous.c.id, cli.id);
});

test('④缺兩個固定小標的「通過」不算數，不可以把這一輪縮成「通過後回頭改」那一格（#49 r1 R3）', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  try {
    const s = settingsFor({ risk: { families: [{ pattern: '^lib/', tier: '中' }], raise: [] } });
    const files = [{ path: 'lib/x.js', status: 'modified', previousPath: null }];
    const r1 = verdict('Beta', 1, r.base, '需修改後再審');
    const bare = { ...verdict('Beta', 2, r.base, '通過'), body: `🤖 Beta｜來源：beta CLI｜審 \`${r.base.slice(0, 7)}\`｜r2｜結論：通過\n\n沒有固定小標` };
    const one = launch('7', 'Beta', { settings: s, platform: fakePlatform(answersFor(r, { changedFiles: files, comments: [r1, bare] })), cwd: r.dir, dir, template: TEMPLATE });
    assert.match(one.prompt, /輪次：r3\n/u);
    assert.match(one.prompt, /本輪範圍：全審（/u, '缺小標的通過不算：照中風險第 3 輪＝全審');
    close('7', { settings: s, dir, leftoverRoots: [] });
    fs.rmSync(path.join(dir, 'review-acme-kit-7-r3'), { recursive: true, force: true });
    // 更早的一輪有合格的通過、最近貼的那一輪的通過缺小標：最近那一輪不算數，就不當成「通過後回頭改」（保守：照常分級）
    const okEarlier = verdict('Beta', 1, r.base, '通過');
    const mixed = launch('7', 'Beta', { settings: s, platform: fakePlatform(answersFor(r, { changedFiles: files, comments: [okEarlier, bare] })), cwd: r.dir, dir, template: TEMPLATE });
    assert.match(mixed.prompt, /輪次：r3\n/u);
    assert.match(mixed.prompt, /本輪範圍：全審（/u, '最近貼的那一輪不算數：照中風險第 3 輪＝全審');
    close('7', { settings: s, dir, leftoverRoots: [] });
    const good = verdict('Beta', 3, r.head, '通過');
    const two = launch('7', 'Beta', { settings: s, platform: fakePlatform(answersFor(r, { changedFiles: files, comments: [r1, bare, good] })), cwd: r.dir, dir, template: TEMPLATE });
    assert.match(two.prompt, new RegExp(`本輪範圍：${TIERS.中.afterPassFix}（`, 'u'), '對照組：合格的通過之後照「通過後回頭改」那一格');
    close('7', { settings: s, dir, leftoverRoots: [] });
    // 同一輪先擋後過、或同一輪對兩個版本各給通過：結論閘判衝突（算阻擋），不可以縮範圍（#49 r2 R1）
    for (const [what, third] of [
      ['同一輪先擋後過', [verdict('Beta', 4, r.base, '需修改後再審'), verdict('Beta', 4, r.base, '通過')]],
      ['同一輪對兩個版本各給通過', [verdict('Beta', 4, r.base, '通過'), verdict('Beta', 4, r.head, '通過')]],
    ]) {
      const res = launch('7', 'Beta', { settings: s, platform: fakePlatform(answersFor(r, { changedFiles: files, comments: [r1, bare, good, ...third] })), cwd: r.dir, dir, template: TEMPLATE });
      assert.match(res.prompt, /輪次：r5\n/u, what);
      assert.match(res.prompt, /本輪範圍：全審（/u, `${what}：衝突不算通過，照中風險第 5 輪＝全審`);
      close('7', { settings: s, dir, leftoverRoots: [] });
      fs.rmSync(path.join(dir, 'review-acme-kit-7-r5'), { recursive: true, force: true });   // 收樹刻意留提示與輸出檔；兩個情形都是第 5 輪
    }
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('④本輪範圍照分級表那一列與輪次；上一輪是通過＝照「通過後回頭改」那一格；讀不懂＝null', () => {
  assert.equal(scopeOf(TIERS.高, 1, false), '全審');
  assert.equal(scopeOf(TIERS.高, 12, false), '全審');
  assert.equal(scopeOf(TIERS.中, 7, false), '全審');
  assert.equal(scopeOf(TIERS.中, 8, false), '只核差異');
  assert.equal(scopeOf(TIERS.低, 3, false), '全審');
  assert.equal(scopeOf(TIERS.低, 4, false), '只核差異');
  assert.equal(scopeOf(TIERS.高, 3, true), TIERS.高.afterPassFix, '通過之後回頭改的那一輪照表');
  assert.equal(scopeOf(TIERS.中, 3, true), TIERS.中.afterPassFix);
  assert.equal(scopeOf({ full: '看情況', diffOnly: '不適用' }, 1, false), null, '讀不懂不猜');
  assert.equal(scopeOf({ full: '每一輪', diffOnly: '第 1 輪起' }, 1, false), null, '兩格都中＝判不了');
  assert.equal(scopeOf(undefined, 1, false), null);
});

test('②真的倉庫裡跑一遍：兩棵樹都在受審版本、提示與紀錄寫好、啟動指令換上模型、推理與路徑', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  try {
    const platform = fakePlatform(answersFor(r));
    const out = launch('7', 'Beta', { settings: settingsFor(), platform, cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(out.code, 0, out.lines.join('\n'));
    const folder = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r1');
    const tree = path.join(folder, 'tree');
    const mutation = path.join(folder, 'mutation');
    for (const t of [tree, mutation]) assert.equal(sh(t, 'rev-parse', 'HEAD'), r.head, `${t} 要在受審版本`);
    const prompt = fs.readFileSync(path.join(folder, 'prompt.md'), 'utf8');
    for (const s of [`受審版本：${r.head}（短碼 ${r.head.slice(0, 7)}）`, `基底：${BASE_BRANCH} 的 ${r.base}`, '輪次：r1', '風險級別：高（照表算的）', '本輪範圍：全審（', '上一輪的結論：沒有', '相關裁示：沒有',
      `審查樹：你現在所在的 ${tree}，`, `突變副本：${mutation}，`, `在副本裡跑考題：npm --prefix ${mutation} test -- <考題檔>`, `看整支的差異：git diff ${r.base}...${r.head}`, '看上一輪之後的差異：沒有', '實作者：Alpha',
      `\`git show ${r.base}:RULES.md\``,
      'PR：https://x.invalid/acme/kit/pull/7', '（post 7 --file <你寫好的結論檔>）', `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：<三選一>`]) {
      assert.ok(prompt.includes(s), `提示裡要有「${s}」`);
    }
    assert.equal(out.command, `beta run --model m-strong --effort max -C ${tree} --add ${mutation} < ${path.join(folder, 'prompt.md')} > ${path.join(folder, 'output.log')}`);
    assert.ok(out.lines.includes(out.command), '整行指令要印出來');
    assert.ok(out.lines.some((l) => l.includes(`--close 7 --dir ${fs.realpathSync(dir)}`)), '用了 --dir 開樹，印的收樹指令也要帶同一個 --dir');
    const rec = JSON.parse(fs.readFileSync(path.join(folder, 'launch.json'), 'utf8'));
    assert.equal(rec.head, r.head); assert.equal(rec.round, 1); assert.equal(rec.tree, tree);
    assert.deepEqual([...new Set(platform.asked)].sort(), ['allComments', 'branchSha', 'change', 'changedFiles', 'comments']);
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('③第 2 輪起：輪次、上一輪結論、上一輪之後的差異；別位的結論不算；相關裁示列問在本支、配到的 ⚖️', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  try {
    const mine1 = verdict('Beta', 1, r.base, '需修改後再審');
    const other = verdict('Alpha', 5, r.base, '通過');
    const ask = { id: 'q1', author: 'ai-acct', createdAt: at(), change: '7', body: '## ❓ 待裁（2026-10-07）：要不要做\n選項：a／b' };
    const ruling = { id: 'k1', author: 'boss-acct', createdAt: at(), change: '9', body: '## ⚖️ Boss 裁示（2026-10-07）：做\n原話（對話中，Alpha 轉述）：**「a」**\n原 ❓：https://x#q1' };
    const elsewhere = { id: 'q2', author: 'ai-acct', createdAt: at(), change: '8', body: '## ❓ 待裁（2026-10-07）：別支的題\n選項：a／b' };
    const elseRuling = { id: 'k2', author: 'boss-acct', createdAt: at(), change: '8', body: '## ⚖️ Boss 裁示（2026-10-07）：做\n原話（對話中，Alpha 轉述）：**「a」**\n原 ❓：https://x#q2' };
    const platform = fakePlatform(answersFor(r, { comments: [mine1, other], allComments: [ask, ruling, elsewhere, elseRuling] }));
    const out = launch('7', 'Beta', { settings: settingsFor(), platform, cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(out.code, 0, out.lines.join('\n'));
    assert.match(out.prompt, /輪次：r2\n/u, '別位的 r5 不算，這一位上一輪是 r1');
    assert.ok(out.prompt.includes(`上一輪的結論：https://x.invalid/acme/kit/pull/7#c-${mine1.id}`));
    assert.ok(out.prompt.includes(`看上一輪之後的差異：git diff ${r.base}..${r.head}`), '短碼要展開成完整版本碼');
    assert.ok(out.prompt.includes('相關裁示：https://x.invalid/acme/kit/pull/9#c-k1'), '問在本支、答在別支的裁示要列，網址指到答的那一支');
    assert.ok(!out.prompt.includes('#c-k2'), '別支的題的裁示不列');
    assert.ok(fs.existsSync(path.join(fs.realpathSync(dir), 'review-acme-kit-7-r2', 'tree')));
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('⑤設定沒填或不對、PR說明指定的不是這一位、平台問不到、本機沒有版本、路徑有空白、資料夾已在＝退 2，一棵樹都沒開', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  const spacedRoot = tmp('review-launch-sp-');
  const spaced = path.join(spacedRoot, '有 空白');
  fs.mkdirSync(spaced);
  try {
    const s = settingsFor();
    const rv = (patch) => settingsFor({ reviewers: [{ ...s.reviewers[0], ...patch }] });
    const cases = [
      ['--reviewer 不是登記的參與者', { reviewer: 'Nobody' }],
      ['reviewers 沒有這一位', { settings: settingsFor({ reviewers: [] }) }],
      ['模型沒填', { settings: rv({ strongest: '未設定' }) }],
      ['來源字串沒填', { settings: rv({ source: '' }) }],
      ['樣板沒帶推理', { settings: rv({ command: 'beta run --model {model} -C {reviewTree}' }) }],
      ['樣板沒帶審查樹路徑', { settings: rv({ command: 'beta run --model {model} --effort {effort}' }) }],
      ['樣板有認不得的記號', { settings: rv({ command: 'beta run --model {model} --effort {effort} -C {reviewTree} {oops}' }) }],
      ['送審產生器那一塊沒填', { settings: settingsFor({ reviewLaunch: { ...s.reviewLaunch, copyTest: '未設定' } }) }],
      ['倉庫身分沒填', { settings: settingsFor({ platform: { name: 'Fake', project: '未設定' } }) }],
      ['裁示者沒填', { settings: settingsFor({ participants: s.participants.map((p) => (p.id === 'Boss' ? { ...p, account: '未設定' } : p)) }) }],
      ['PR說明指定的複審者是別位', { answers: { change: { ...answersFor(r).change, body: BODY.replace('複審者**：Beta', '複審者**：Alpha') } } }],
      ['PR說明讀不出實作者', { answers: { change: { ...answersFor(r).change, body: BODY.replace('- **實作者**：Alpha\n', '') } } }],
      ['平台問不到 change', { answers: { change: new PlatformError('x') } }],
      ['平台問不到 branchSha', { answers: { branchSha: new PlatformError('x') } }],
      ['平台問不到 comments', { answers: { comments: new PlatformError('x') } }],
      ['平台問不到 allComments', { answers: { allComments: new PlatformError('x') } }],
      ['風險級別算不出', { answers: { changedFiles: new PlatformError('x') } }],
      ['分級表讀不懂', { settings: settingsFor({ reviewTiers: { ...TIERS, 高: { ...TIERS.高, full: '看情況' } } }) }],
      ['本機沒有受審版本', { answers: { change: { ...answersFor(r).change, headSha: 'f'.repeat(40) } } }],
      // 產生提示期間這一支換了版本（理財 #672 r3）：算風險時已經是另一版、或讀檔案清單前後版本不同
      ['算風險時已經換版', { answers: { change: (() => { let n = 0; return () => ({ ...answersFor(r).change, headSha: n++ === 0 ? r.head : r.base }); })() } }],
      ['讀檔案清單前後換版', { answers: { change: (() => { let n = 0; return () => ({ ...answersFor(r).change, headSha: n++ < 2 ? r.head : r.base }); })() } }],
      ['路徑有空白', { dir: spaced }],
      ['放樹的資料夾不在', { dir: path.join(spaced, '沒有這一層') }],
    ];
    for (const [what, c] of cases) {
      const platform = fakePlatform({ ...answersFor(r), ...(c.answers || {}) });
      const res = main(['7', '--reviewer', c.reviewer || 'Beta'], { settings: c.settings || s, platform, cwd: r.dir, dir: c.dir || dir, template: TEMPLATE });
      assert.equal(res.code, 2, `${what}：${res.lines.join('\n')}`);
      assert.match(res.lines.join('\n'), /沒有產生/u, what);
      assert.deepEqual(fs.readdirSync(dir), [], `${what}：一個資料夾都不可以留`);
      assert.deepEqual(fs.readdirSync(spaced), [], `${what}：一個資料夾都不可以留`);
      assert.ok(!/review-acme-kit/u.test(sh(r.dir, 'worktree', 'list')), `${what}：不可以開樹`);
    }
    fs.mkdirSync(path.join(dir, 'review-acme-kit-7-r1'));
    const again = main(['7', '--reviewer', 'Beta'], { settings: s, platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(again.code, 2); assert.match(again.lines.join('\n'), /已經在了/u, '這一輪的資料夾已在＝不覆蓋');
    assert.throws(() => launch('7', 'Beta', { settings: s, platform: fakePlatform(answersFor(r, { comments: new TypeError('程式寫錯了') })), cwd: r.dir, dir, template: TEMPLATE }), TypeError, '平台以外的錯照樣炸出去');
  } finally {
    for (const d of [dir, spacedRoot, r.dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('⑤開到一半失敗：剛開的那一棵收回去、資料夾不留', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  try {
    // 先在突變副本的位置登記一棵、再把資料夾刪掉：第二棵開不起來（「已登記但不見了」），第一棵已經開好了
    const folder = path.join(dir, 'review-acme-kit-7-r1');
    sh(r.dir, 'worktree', 'add', '--detach', '-q', path.join(folder, 'mutation'), r.base);
    fs.rmSync(folder, { recursive: true, force: true });
    const res = main(['7', '--reviewer', 'Beta'], { settings: settingsFor(), platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(res.code, 2, res.lines.join('\n'));
    assert.ok(!fs.existsSync(folder), '資料夾要收掉');
    const list = sh(r.dir, 'worktree', 'list', '--porcelain');
    assert.ok(!list.includes(path.join(fs.realpathSync(dir), 'review-acme-kit-7-r1', 'tree')), '已經開好的審查樹要收回去');
    assert.ok(list.includes(path.join(folder, 'mutation')), '不是這一次開的那一棵（登記了、目錄暫時不在）的登記要保住：不可以整個倉庫 prune（#49 r1 R1）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('⑥收樹：乾淨才收；不乾淨或 HEAD 變了＝退 1、兩棵都留；找不到＝退 2；暫存區比開樹晚的只列不刪', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  const leftovers = tmp('review-launch-left-');
  const ndRoot = tmp('review-launch-nd-');
  try {
    const s = settingsFor();
    const open = () => launch('7', 'Beta', { settings: s, platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    const folder = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r1');
    open();
    fs.writeFileSync(path.join(folder, 'tree', 'a.txt'), 'changed\n');
    let res = close('7', { settings: s, dir, leftoverRoots: [leftovers] });
    assert.equal(res.code, 1, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /審查樹不乾淨/u);
    assert.ok(fs.existsSync(path.join(folder, 'tree')) && fs.existsSync(path.join(folder, 'mutation')), '兩棵都留著給人看');
    sh(path.join(folder, 'tree'), 'checkout', '-q', '--', 'a.txt');
    sh(path.join(folder, 'mutation'), 'checkout', '-q', '--detach', r.base);
    res = close('7', { settings: s, dir, leftoverRoots: [leftovers] });
    assert.equal(res.code, 1); assert.match(res.lines.join('\n'), /突變副本的 HEAD 是/u, 'HEAD 變了也不收');
    sh(path.join(folder, 'mutation'), 'checkout', '-q', '--detach', r.head);
    fs.renameSync(path.join(folder, 'tree'), path.join(folder, 'tree-moved'));
    res = close('7', { settings: s, dir, leftoverRoots: [leftovers] });
    assert.equal(res.code, 1); assert.match(res.lines.join('\n'), /審查樹不見了.*git 還登記著/u, '樹被搬走、git 還登記著：照實說不見了、不收');
    fs.renameSync(path.join(folder, 'tree-moved'), path.join(folder, 'tree'));
    fs.writeFileSync(path.join(leftovers, 'reviewer-made.json'), '{}');
    const notDir = path.join(ndRoot, 'not-a-dir.txt');
    fs.writeFileSync(notDir, 'x');
    res = close('7', { settings: s, dir, leftoverRoots: [leftovers, notDir] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    for (const t of ['tree', 'mutation']) assert.ok(!fs.existsSync(path.join(folder, t)), `${t} 要收掉`);
    assert.ok(!sh(r.dir, 'worktree', 'list').includes(folder), 'git 那邊也要移除登記');
    assert.ok(JSON.parse(fs.readFileSync(path.join(folder, 'launch.json'), 'utf8')).closedAt, '紀錄標成收過');
    assert.ok(fs.existsSync(path.join(folder, 'prompt.md')), '提示與輸出檔留著');
    const text = res.lines.join('\n');
    assert.match(res.lines[0], /；暫存區另有 1 筆比開樹晚/u, `首行摘要應印比開樹晚的筆數：\n${text}`);
    const planted = path.join(fs.realpathSync(leftovers), 'reviewer-made.json');
    assert.ok(res.lines.includes(`    ${planted}`), `比開樹晚的要逐筆列出來（整行比，#49 r1 R4）：\n${text}`);
    assert.ok(res.lines.includes(`  ${fs.realpathSync(leftovers)} 第一層比開樹晚的 1 筆（新的在前；只列、不刪；可能是複審者另建的，也可能是別的程式同時寫的）：`), `每個暫存區一組、寫出筆數：\n${text}`);
    assert.ok(res.lines.includes(`  ⚠️ 讀不了 ${fs.realpathSync(notDir)}，那裡比開樹晚的沒列`), '讀不了的那一處照實說、其餘照列（不在收到一半時崩掉）');
    assert.ok(fs.existsSync(planted), '只列、不刪');
    const none = main(['--close', '7'], { settings: s, dir });
    assert.equal(none.code, 2); assert.match(none.lines.join('\n'), /找不到.*沒有收/u, '收過的不再收；找不到＝退 2');
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    for (const d of [dir, leftovers, ndRoot, r.dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('⑦git 那一族環境變數指到別的倉庫，照樣在這一個倉庫開樹（E4）', () => {
  const r = repo();
  const decoy = repo();
  const dir = tmp('review-launch-out-');
  const saved = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(decoy.dir, '.git');
    const out = launch('7', 'Beta', { settings: settingsFor(), platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(out.code, 0, out.lines.join('\n'));
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
  try {
    assert.ok(sh(r.dir, 'worktree', 'list').includes('review-acme-kit-7-r1'), '樹要開在這一個倉庫');
    assert.ok(!sh(decoy.dir, 'worktree', 'list').includes('review-acme-kit'), '誘餌倉庫不可以多出樹');
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    for (const d of [dir, r.dir, decoy.dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('⑧指令入口：參數不對＝退 2；空白設定的複本裡跑＝退 2 不產生', () => {
  for (const bad of [
    [], ['7'], ['--reviewer', 'Beta'], ['7', '--reviewer'], ['7', '--reviewer', 'Beta', '--oops'], ['7', '8', '--reviewer', 'Beta'],
    ['--close'], ['--close', '7', '--reviewer', 'Beta'], ['--close', '7', '--post', '7'], ['--close', '7', '--file', 'x'], ['--close', '7', '--tier', '高'],
    ['--post'], ['--post', '7', '--reviewer', 'Beta'], ['--post', '7', '8'], ['7', '--reviewer', 'Beta', '--file', 'x'], ['7', '--reviewer', 'Beta', '--tier', '高'],
    ['--scan'], ['--scan', '7', '--reviewer', 'Beta'], ['--scan', '7', '--file', 'x'], ['--scan-post'], ['--scan-close'],
    ['--scan-post', '7', '--scanner', 'Beta'], ['--scan-post', '7', '--tier', '高'], ['--scan-close', '7', '--file', 'x'], ['--scan-close', '7', '--tier', '高'],
    ['--close', '7', '--run'], ['--post', '7', '--run'], ['--post', '7', '--purge'],
    ['7', '--reviewer', 'Beta', '--purge'], ['--scan', '7', '--purge'],
    ['--scan-post', '7', '--run'], ['--scan-post', '7', '--purge'], ['--scan-close', '7', '--run'],
  ]) {
    assert.ok(parseArgs(bad).error, JSON.stringify(bad));
    assert.equal(main(bad).code, 2, JSON.stringify(bad));
  }
  assert.match(parseArgs(['--oops', '--reviewer', 'Beta']).error, /不認得的參數：--oops/u, '不認得的旗標不可以被當成變更編號');
  assert.deepEqual(parseArgs(['7', '--reviewer', 'Beta', '--dir', '/x']), { change: '7', reviewer: 'Beta', close: undefined, post: undefined, scan: undefined, scanner: undefined, tier: undefined, scanPost: undefined, scanClose: undefined, file: undefined, dir: '/x' });
  assert.deepEqual(parseArgs(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', '/x']), { change: '7', reviewer: 'Beta', close: undefined, post: undefined, scan: undefined, scanner: undefined, tier: undefined, scanPost: undefined, scanClose: undefined, file: undefined, dir: '/x', run: true, purge: true });
  assert.deepEqual(parseArgs(['--post', '7', '--file', '/tmp/v.md', '--dir', '/x']), { change: undefined, reviewer: undefined, close: undefined, post: '7', scan: undefined, scanner: undefined, tier: undefined, scanPost: undefined, scanClose: undefined, file: '/tmp/v.md', dir: '/x' });
  assert.deepEqual(parseArgs(['--scan', '7', '--scanner', 'Beta', '--tier', '高', '--dir', '/x']), { change: undefined, reviewer: undefined, close: undefined, post: undefined, scan: '7', scanner: 'Beta', tier: '高', scanPost: undefined, scanClose: undefined, file: undefined, dir: '/x' });
  assert.deepEqual(parseArgs(['--scan', '7', '--run', '--purge', '--dir', '/x']), { change: undefined, reviewer: undefined, close: undefined, post: undefined, scan: '7', scanner: undefined, tier: undefined, scanPost: undefined, scanClose: undefined, file: undefined, dir: '/x', run: true, purge: true });
  assert.deepEqual(parseArgs(['--close', '7', '--purge', '--dir', '/x']), { change: undefined, reviewer: undefined, close: '7', post: undefined, scan: undefined, scanner: undefined, tier: undefined, scanPost: undefined, scanClose: undefined, file: undefined, dir: '/x', purge: true });
  assert.deepEqual(parseArgs(['--scan-close', '7', '--purge', '--dir', '/x']), { change: undefined, reviewer: undefined, close: undefined, post: undefined, scan: undefined, scanner: undefined, tier: undefined, scanPost: undefined, scanClose: '7', file: undefined, dir: '/x', purge: true });
  const r = runInCopy('tools/review-launch.js', ['7', '--reviewer', 'Codex']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /沒有產生/u);
  assert.equal(runInCopy('tools/review-launch.js').status, 2, '沒給參數也要退 2');
  assert.equal(runInCopy('tools/review-launch.js', ['--close', '7']).status, 2, '空白設定收樹也退 2');
  const p = runInCopy('tools/review-launch.js', ['--post', '7']);
  assert.equal(p.status, 2, p.stdout + p.stderr);
  assert.match(p.stdout, /沒有貼/u, '空白設定代貼也退 2');
});

test('⑨設定裡填了的樣板逐一核：記號都認得、啟動指令帶模型、推理與工作樹路徑；本倉庫那一份要過', () => {
  assert.deepEqual(templateProblems(readSettings()), [], '本倉庫 settings.json 的樣板');
  assert.deepEqual(templateProblems(unfilled()), [], '空白範本（沒填的不核）');
  const s = settingsFor();
  assert.deepEqual(templateProblems(s), []);
  const bad = settingsFor({
    reviewers: [{ ...s.reviewers[0], command: 'run {model} {oops}' }],
    scanner: { participant: 'Beta', strongest: 'm', maxEffort: 'max', source: 'beta CLI', command: 'scan {model} --effort {effort}' },
    reviewLaunch: { ...s.reviewLaunch, changeLink: 'x/{comment}' },
  });
  const got = templateProblems(bad).join('\n');
  assert.match(got, /認不得的記號：oops/u);
  assert.match(got, /沒帶 \{effort\}/u);
  assert.match(got, /沒帶 \{reviewTree\}/u);
  assert.match(got, /scanner\.command 沒帶 \{scanTree\}/u);
  assert.match(got, /reviewLaunch\.changeLink 有認不得的記號：comment/u);
  const noSource = settingsFor({ reviewers: [{ ...s.reviewers[0], source: '未設定' }] });
  assert.match(templateProblems(noSource).join('\n'), /「Beta」的 source 還沒填/u, '登記了的複審者少一格要看得出來');
  const badDerivedScan = settingsFor({
    reviewers: [{ ...s.reviewers[0], scanCommand: 'scan {model} {effort} {mutationCopy}' }],
  });
  const gotScan = templateProblems(badDerivedScan).join('\n');
  assert.match(gotScan, /「Beta」轉換後的掃描啟動指令樣板有認不得的記號：mutationCopy/u);
  assert.match(gotScan, /「Beta」轉換後的掃描啟動指令樣板沒帶 \{scanTree\}/u);
  const disabledByParticipant = settingsFor({
    scanner: { participant: '無', tool: '未設定', strongest: '未設定', maxEffort: '未設定', source: '未設定', command: '未設定' },
  });
  assert.deepEqual(templateProblems(disabledByParticipant), [], 'scanner.participant 填「無」時不要求填 scanner 啟動欄位');
  assert.throws(
    () => resolveScannerSpec(disabledByParticipant, null, [{ id: 'Alpha' }, { id: 'Beta' }]),
    /本專案沒有設定掃描者/u,
    'scanner.participant 填「無」時 resolveScannerSpec 視為未設定掃描者',
  );
  const disabledByTool = settingsFor({
    scanner: { participant: 'Beta', tool: '無', strongest: '未設定', maxEffort: '未設定', source: '未設定', command: '未設定' },
  });
  assert.deepEqual(templateProblems(disabledByTool), [], 'scanner.tool 填「無」時不要求填 scanner 啟動欄位');
});

test('⑥暫存區清單：比開樹晚的列出、早的不列；自己那一層與它的上層不算；讀不了的分開回報（#49 r1 R4）', () => {
  const root = tmp('review-launch-fresh-');
  try {
    const since = Date.now() - 60_000;
    const base = path.join(root, 'base');
    const folder = path.join(base, 'review-acme-kit-7-r1');
    fs.mkdirSync(folder, { recursive: true });
    const old = path.join(root, 'old.txt');
    fs.writeFileSync(old, 'x');
    fs.utimesSync(old, new Date(since - 60_000), new Date(since - 60_000));
    const made = path.join(root, 'reviewer-made');
    fs.mkdirSync(made);
    const notDir = path.join(root, 'old.txt');
    const re = /^review-acme-kit-7-r(\d+)$/u;
    const got = freshEntries([root, base, notDir, path.join(root, '沒有這個')], folder, since, re);
    const real = (p) => fs.realpathSync(p);
    assert.ok(got.fresh.includes(real(made)), '比開樹晚的要列');
    assert.ok(!got.fresh.includes(real(old)), '比開樹早的不列');
    assert.ok(!got.fresh.includes(real(base)), '上層（放樹的資料夾）不列：它的修改時間跟著變');
    assert.ok(!got.fresh.includes(real(folder)), '自己那一層不列');
    assert.deepEqual(got.unreadable, [real(notDir)], '讀不了的分開回報；不在的不算讀不了');
    const newer = path.join(root, 'zz-newer');   // 名字照字母排在後面、時間比較新：排錯順序才看得出來
    fs.mkdirSync(newer);
    fs.utimesSync(made, new Date(since + 1000), new Date(since + 1000));
    fs.utimesSync(newer, new Date(since + 5000), new Date(since + 5000));
    const again = freshEntries([root], folder, since, re);
    assert.deepEqual(again.groups.map((g) => g.root), [real(root)], '一個暫存區一組');
    assert.deepEqual(again.groups[0].paths.slice(0, 2), [real(newer), real(made)], '新的排前面');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('⑥收樹：上了鎖的不動；收到一半照實記下哪一棵收了，重跑只收剩下的（#49 r1 R5）', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  try {
    const s = settingsFor();
    launch('7', 'Beta', { settings: s, platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    const folder = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r1');
    const tree = path.join(folder, 'tree');
    const mutation = path.join(folder, 'mutation');
    sh(r.dir, 'worktree', 'lock', mutation);
    let res = close('7', { settings: s, dir, leftoverRoots: [] });
    assert.equal(res.code, 1, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /突變副本上了鎖/u);
    assert.ok(fs.existsSync(tree) && fs.existsSync(mutation), '上了鎖就一棵都不動');
    sh(r.dir, 'worktree', 'unlock', mutation);
    let calls = 0;
    const flaky = (root, t) => { calls += 1; if (t === mutation) return '假的失敗'; return spawnSync('git', ['worktree', 'remove', t], { cwd: root, env: gitEnv() }).status === 0 ? null : '真的失敗'; };
    res = close('7', { settings: s, dir, leftoverRoots: [], remove: flaky });
    assert.equal(res.code, 1, res.lines.join('\n'));
    const text = res.lines.join('\n');
    assert.match(text, /收到一半.*已收 審查樹；突變副本移除失敗：假的失敗/u, '已經收了的要照實說，不可以說成沒收');
    assert.ok(!fs.existsSync(tree) && fs.existsSync(mutation));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'launch.json'), 'utf8')).removed, [tree], '紀錄記下收了哪一棵');
    res = close('7', { settings: s, dir, leftoverRoots: [] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /先前已收：審查樹/u, '重跑只收剩下的那一棵');
    assert.ok(!fs.existsSync(mutation));
    assert.equal(calls, 2);
    // 照「沒收」的提示自己 git worktree remove 掉一棵之後，重跑要能收完剩下的，不可以一直說不見了
    launch('7', 'Beta', { settings: s, platform: fakePlatform(answersFor(r, { comments: [verdict('Beta', 1, r.head, '需修改後再審')] })), cwd: r.dir, dir, template: TEMPLATE });
    const folder2 = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r2');
    fs.writeFileSync(path.join(folder2, 'mutation', 'a.txt'), 'reviewer left this\n');
    assert.equal(close('7', { settings: s, dir, leftoverRoots: [] }).code, 1, '副本被留了改動＝不收');
    sh(r.dir, 'worktree', 'remove', '--force', path.join(folder2, 'mutation'));
    res = close('7', { settings: s, dir, leftoverRoots: [] });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /突變副本已經不在、git 也沒登記：當作收過/u);
    assert.ok(!fs.existsSync(path.join(folder2, 'tree')), '剩下的審查樹照樣收');
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('⑤git worktree add 已經建好樹才因掛鉤失敗退非零：那一棵的登記也收掉，排除原因後重跑能送（#49 r2 R2）', () => {
  for (const which of ['tree', 'mutation']) {
    const r = repo();
    const dir = tmp('review-launch-out-');
    const hooks = tmp('review-launch-hooks-');
    try {
      const hook = path.join(hooks, 'post-checkout');
      fs.writeFileSync(hook, `#!/bin/sh\ncase "$PWD" in */${which}) exit 42;; esac\nexit 0\n`, { mode: 0o755 });
      sh(r.dir, 'config', 'core.hooksPath', hooks);
      const opts = { settings: settingsFor(), platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE };
      const res = main(['7', '--reviewer', 'Beta'], opts);
      assert.equal(res.code, 2, `${which}：${res.lines.join('\n')}`);
      assert.ok(!sh(r.dir, 'worktree', 'list', '--porcelain').includes('review-acme-kit-7-r1'), `${which}：掛鉤失敗的那一棵的登記也要收掉`);
      assert.deepEqual(fs.readdirSync(dir), [], `${which}：資料夾不留`);
      fs.rmSync(hook);
      const again = main(['7', '--reviewer', 'Beta'], opts);
      assert.equal(again.code, 0, `${which}：排除原因後重跑要送得出去：${again.lines.join('\n')}`);
    } finally {
      spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
      for (const d of [dir, hooks, r.dir]) fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

test('③改級的提醒：印出來的那一行說風險級別與本輪範圍兩格要一起改（#49 r2 R3）', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  try {
    const out = launch('7', 'Beta', { settings: settingsFor(), platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    assert.ok(out.lines.some((l) => l.includes('風險級別與本輪範圍兩格要一起照分級表改')), out.lines.join('\n'));
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('⑤b產生送審提示期間換版：訊息說清楚是哪兩版、要重跑，一棵樹都沒開（理財 #672 r3）', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  try {
    let n = 0;
    const platform = fakePlatform({ ...answersFor(r), change: () => ({ ...answersFor(r).change, headSha: n++ === 0 ? r.head : r.base }) });
    const res = main(['7', '--reviewer', 'Beta'], { settings: settingsFor(), platform, cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(res.code, 2, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), new RegExp(`產生送審提示期間這一支換了版本（受審 ${r.head.slice(0, 12)}，算風險時是 ${r.base.slice(0, 12)}）`, 'u'));
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.ok(!/review-acme-kit/u.test(sh(r.dir, 'worktree', 'list')), '不可以開樹');
  } finally { for (const d of [r.dir, dir]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('⑤c同一輪兩個送審交錯：後到的那一個（先看到不在、別人才建好）退 2，不可以刪掉別人建好的樹、提示與輸出（理財 #672 r4 第 1 條）', () => {
  const r = repo();
  const dir = tmp('review-launch-out-');
  const realExists = fs.existsSync;
  try {
    const s = settingsFor();
    // 先讓 B 正常開完
    const b = main(['7', '--reviewer', 'Beta'], { settings: s, platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(b.code, 0, b.lines.join('\n'));
    const folder = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r1');   // 工具用的是真實路徑（/var 與 /private/var）
    fs.writeFileSync(path.join(folder, 'output.log'), 'B 的專屬輸出\n');
    const listBefore = sh(r.dir, 'worktree', 'list', '--porcelain');
    // A：檢查「在不在」那一刻還不在（B 是在那之後才建好的）
    fs.existsSync = (p) => (String(p) === folder ? false : realExists(p));
    const a = main(['7', '--reviewer', 'Beta'], { settings: s, platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    fs.existsSync = realExists;
    assert.equal(a.code, 2, a.lines.join('\n'));
    assert.match(a.lines.join('\n'), /已經在了：另一個送審剛好在開同一輪/u);
    assert.equal(fs.readFileSync(path.join(folder, 'output.log'), 'utf8'), 'B 的專屬輸出\n', 'B 的輸出還在');
    for (const f of ['tree', 'mutation', 'prompt.md', 'launch.json']) assert.ok(realExists(path.join(folder, f)), `B 的 ${f} 還在`);
    assert.equal(sh(r.dir, 'worktree', 'list', '--porcelain'), listBefore, 'B 的兩棵樹登記沒被動');
  } finally {
    fs.existsSync = realExists;
    for (const d of [r.dir, dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

/** 暫存倉庫：tools/x.js 的基底一顆、只改了註解的受審版本一顆（分級腳本會判能走快速通道（AI））。 */
function commentRepo() {
  const dir = tmp('review-launch-lane-');
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'maintenance.auto', 'false');
  sh(dir, 'config', 'gc.auto', '0');
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'x.js'), "'use strict';\n// 說明\nmodule.exports = 1;\n");
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'base');
  const base = sh(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'tools', 'x.js'), "'use strict';\n// 改過的說明\nmodule.exports = 1;\n");
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'head');
  const head = sh(dir, 'rev-parse', 'HEAD');
  return { dir, base, head };
}
const LANE_SETTINGS = { fastLane: { ai: { files: [], commentOnly: ['^tools/.+\\.js$'], never: [] } } };

test('⑩快速通道（AI）：第 1 輪起只核差異、提示寫明為什麼；連兩輪沒「通過」改回照分級表；通過後回頭改的那一輪仍走', () => {
  const r = commentRepo();
  const dir = tmp('review-launch-out-');
  const cleanup = () => spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
  try {
    let out = launch('7', 'Beta', { settings: settingsFor(LANE_SETTINGS), platform: fakePlatform(answersFor(r)), cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(out.code, 0, out.lines.join('\n'));
    assert.ok(out.prompt.includes('風險級別：高（照表算的；分級腳本判這一支走快速通道（AI）：第 1 輪起只核差異、不掃描（F12））'), out.prompt);
    assert.ok(out.prompt.includes('本輪範圍：只核差異（'), '高風險照表要全審，走快速通道（AI）第 1 輪就只核差異');
    assert.ok(out.lines.includes('  快速通道（AI）：分級腳本判可以，這一輪只核差異、不掃描（F12）'), out.lines.join('\n'));
    assert.ok(out.lines.some((l) => l.includes('本輪範圍照 F12 只核差異、不照分級表，往重調或裁示者改級只改風險級別那一格')), '改級提醒不能叫人把範圍改回照分級表（#96 掃描 2-2）');

    // 對照組：同一支、沒登記清單＝照表全審
    out = launch('7', 'Beta', { settings: settingsFor(), platform: fakePlatform(answersFor(r)), cwd: r.dir, dir: tmp('review-launch-out-'), template: TEMPLATE });
    assert.ok(out.prompt.includes('風險級別：高（照表算的）') && out.prompt.includes('本輪範圍：全審（'), '沒登記清單就照分級表');

    // 連兩輪沒「通過」：第 3 輪起照分級表（高＝全審）
    const misses = [verdict('Beta', 1, r.head, '需修改後再審'), verdict('Beta', 2, r.head, '需修改後再審')];
    out = launch('7', 'Beta', { settings: settingsFor(LANE_SETTINGS), platform: fakePlatform(answersFor(r, { comments: misses })), cwd: r.dir, dir: tmp('review-launch-out-'), template: TEMPLATE });
    assert.match(out.prompt, /輪次：r3\n/u);
    assert.ok(out.prompt.includes('本輪範圍：全審（'), out.prompt);
    assert.ok(out.prompt.includes('這一位已經連兩輪沒「通過」，這一輪起照這一級走一般流程（F12）'), out.prompt);

    // 兩輪都阻擋之後，同一輪補一則「通過」（缺小標的、或小標齊全但跟阻擋同輪＝衝突）：結論閘都還擋著，第 3 輪照分級表（Codex #96 r1 R2）
    const bareLate = verdict('Beta', 2, r.head, '通過', { body: `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r2｜結論：通過\n` });
    for (const late of [bareLate, verdict('Beta', 2, r.head, '通過')]) {
      const blockedThenLate = [verdict('Beta', 1, r.head, '需修改後再審'), verdict('Beta', 2, r.head, '需修改後再審'), late];
      out = launch('7', 'Beta', { settings: settingsFor(LANE_SETTINGS), platform: fakePlatform(answersFor(r, { comments: blockedThenLate })), cwd: r.dir, dir: tmp('review-launch-out-'), template: TEMPLATE });
      assert.ok(out.prompt.includes('本輪範圍：全審（'), `同輪補上的「通過」不能解除兩輪的上限：\n${out.prompt}`);
    }
    // 第 1 輪沒過、第 2 輪通過：之後回頭改的第 3 輪仍走快速通道（不是「連兩輪沒過」）
    const passed = [verdict('Beta', 1, r.head, '需修改後再審'), verdict('Beta', 2, r.head, '通過')];
    out = launch('7', 'Beta', { settings: settingsFor(LANE_SETTINGS), platform: fakePlatform(answersFor(r, { comments: passed })), cwd: r.dir, dir: tmp('review-launch-out-'), template: TEMPLATE });
    assert.ok(out.prompt.includes('本輪範圍：只核差異（'), out.prompt);
  } finally {
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(r.dir, { recursive: true, force: true });
  }
});

test('⑩連兩輪沒「通過」：輪次要相鄰、每輪算不算通過照結論閘（缺小標不算、同輪相反＝衝突）；別位或換了來源的不算', () => {
  const roles = ['Alpha', 'Beta'];
  const sha = 'a'.repeat(40);
  const miss = (round) => verdict('Beta', round, sha, '需修改後再審');
  const pass = (round) => verdict('Beta', round, sha, '通過');
  assert.equal(twoMissesInARow([miss(1), miss(2)], 'Beta', 'beta CLI', roles), true);
  assert.equal(twoMissesInARow([miss(1), pass(2)], 'Beta', 'beta CLI', roles), false);
  assert.equal(twoMissesInARow([miss(1), miss(3)], 'Beta', 'beta CLI', roles), false, '輪次不相鄰不算連兩輪');
  assert.equal(twoMissesInARow([miss(1), miss(2), pass(2)], 'Beta', 'beta CLI', roles), true, '同一輪先阻擋、後通過＝相反結論、衝突，照結論閘算沒過（Codex #96 r1 R2）');
  const bare = (round) => verdict('Beta', round, sha, '通過', { body: `🤖 Beta｜來源：beta CLI｜審 \`${sha.slice(0, 7)}\`｜r${round}｜結論：通過\n` });
  assert.equal(twoMissesInARow([miss(1), miss(2), bare(3)], 'Beta', 'beta CLI', roles), true, '缺固定小標的「通過」不算數，前兩輪照樣是連兩輪沒過');
  assert.equal(twoMissesInARow([miss(1), bare(2)], 'Beta', 'beta CLI', roles), true, '那一輪只有缺小標的「通過」＝沒有算數的通過');
  assert.equal(twoMissesInARow([miss(1), pass(2), miss(3)], 'Beta', 'beta CLI', roles), false, '對照組：中間那一輪是算數的通過');
  assert.equal(twoMissesInARow([miss(1), verdict('Alpha', 2, sha, '需修改後再審')], 'Beta', 'beta CLI', roles), false, '別位的不算');
  assert.equal(twoMissesInARow([miss(1), miss(2)], 'Beta', 'beta 新來源', roles), false, '換了來源就是另一位');
});

test('指定裁示者的發審索引顯示指派來源，壞設定在開樹前拒絕', () => {
  const f = require('./helpers/ruling-assignment-fixture.js').fixture();
  const s = settingsFor({ owner: 'Boss', rulingAssignments: f.settings.rulingAssignments });
  s.participants.push(f.settings.participants[2]);
  const r = repo(), dir = tmp('review-assignment-out-');
  const platform = fakePlatform(answersFor(r, { allComments: f.comments }));
  const out = launch('7', 'Beta', { settings: s, platform, cwd: r.dir, dir, template: TEMPLATE });
  assert.ok(out.prompt.includes(`指定裁示者 Delta（engineering；指派來源 ${f.settings.rulingAssignments[0].source}）：https://x.invalid/acme/kit/pull/7#c-a`));
  close('7', { settings: s, dir, leftoverRoots: [] });
  s.rulingAssignments = null;
  const rejectedDir = tmp('review-assignment-rejected-');
  assert.throws(() => launch('7', 'Beta', { settings: s, platform, cwd: r.dir, dir: rejectedDir, template: TEMPLATE }), /相關裁示算不出來/u);
  assert.deepEqual(fs.readdirSync(rejectedDir), []);
});

test('⑪SAFE 字元集：接受非 ASCII 字母數字（如中文模型與推理名），仍拒絕空白、控制字元與殼會解讀的字元', () => {
  for (const ok of ['xhigh', '最高', '高', '假的最強', 'gemini-3.1-pro', '模型_4.7@v1+max']) {
    assert.ok(SAFE.test(ok), `要接受「${ok}」`);
    assert.equal(substitute('run --model {model}', { model: ok }, '樣板').text, `run --model ${ok}`);
  }
  for (const bad of ['', '有 空白', 'a\nb', 'a\tb', 'a;b', 'a|b', 'a&b', 'a$b', 'a`b', 'a"b', "a'b", 'a(b)', 'a<b', 'a>b']) {
    assert.ok(!SAFE.test(bad), `要拒絕「${JSON.stringify(bad)}」`);
    assert.throws(() => substitute('run --model {model}', { model: bad }, '樣板'), /空白或殼會另外解讀的字元/u);
  }
});

test('⑪prepareVerdict：剝除首尾空行與文末單獨一行的「未貼」；核對角色、來源、輪次、版本短碼與固定小標（擁有者豁免）', () => {
  const roles = ['Boss', 'Alpha', 'Beta'];
  const head = '0123456789abcdef0123456789abcdef01234567';
  const baseOpts = { reviewer: 'Beta', source: 'beta CLI', round: 1, head, usable: roles, ownerRole: 'Boss' };
  const passBody = `\n\n🤖 Beta｜來源：beta CLI｜審 \`0123456\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- 未貼這兩個字在內文裡不剝\n\n未貼  \n\n`;
  const got = prepareVerdict(passBody, baseOpts);
  assert.equal(got.strippedUnposted, true);
  assert.equal(got.header.verdict, '通過');
  assert.ok(!got.body.trimEnd().endsWith('未貼'), '文末單獨一行的「未貼」要剝掉');
  assert.ok(got.body.includes('未貼這兩個字在內文裡不剝'), '內文裡的字不碰');

  const direct = prepareVerdict(`🤖 Beta｜來源：beta CLI｜審 \`0123456\`｜r1｜結論：需修改後再審\n\n- R1\n`, baseOpts);
  assert.equal(direct.strippedUnposted, false);
  assert.equal(direct.header.verdict, '需修改後再審');

  // 擁有者走快速通道（擁有者）（F12）豁免兩行固定小標
  const ownerPass = prepareVerdict(`🤖 Boss｜來源：boss UI｜審 \`0123456\`｜r1｜結論：通過\n\n通過\n未貼\n`, { ...baseOpts, reviewer: 'Boss', source: 'boss UI' });
  assert.equal(ownerPass.header.verdict, '通過');

  for (const [what, raw, re] of [
    ['空字串', '  \n\n ', /結論檔是空的/u],
    ['只有未貼', '\n未貼\n', /只有「未貼」/u],
    ['標頭前有前言', `前言\n🤖 Beta｜來源：beta CLI｜審 \`0123456\`｜r1｜結論：需修改後再審\n`, /第一行不是合規標頭/u],
    ['角色不符', `🤖 Alpha｜來源：beta CLI｜審 \`0123456\`｜r1｜結論：需修改後再審\n`, /角色是「Alpha」，不是本輪複審者 Beta/u],
    ['來源不符', `🤖 Beta｜來源：other CLI｜審 \`0123456\`｜r1｜結論：需修改後再審\n`, /來源是「other CLI」，不是設定登記的「beta CLI」/u],
    ['輪次不符', `🤖 Beta｜來源：beta CLI｜審 \`0123456\`｜r2｜結論：需修改後再審\n`, /輪次是 r2，不是本輪 r1/u],
    ['版本短碼不符', `🤖 Beta｜來源：beta CLI｜審 \`fedcba9\`｜r1｜結論：需修改後再審\n`, /審的是 fedcba9，對不上本輪受審版本 0123456/u],
    ['通過缺固定小標', `🤖 Beta｜來源：beta CLI｜審 \`0123456\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n`, /少了固定小標：### 清單逐項結果/u],
  ]) {
    assert.throws(() => prepareVerdict(raw, baseOpts), re, what);
  }
});

test('⑪外殼代貼結論（--post）：先核兩棵樹未收／已登記／乾淨／HEAD／沒上鎖，再核標頭、引號參數與平台狀態，剝除「未貼」後逐字代貼並記下 postedAt', () => {
  const r = repo();
  const dir = tmp('review-launch-post-');
  const extDir = tmp('review-launch-ext-');
  try {
    const s = settingsFor({ owner: 'Boss' });
    const platform = fakePlatform(answersFor(r));
    const launched = launch('7', 'Beta', { settings: s, platform, cwd: r.dir, dir, template: TEMPLATE });
    assert.equal(launched.code, 0, launched.lines.join('\n'));
    const folder = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r1');
    const recFile = path.join(folder, 'launch.json');
    const recOrig = fs.readFileSync(recFile, 'utf8');
    const expectedBody = `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- m-strong / max\n\n### 清單逐項結果\n- 全過\n`;
    const validPass = `\n${expectedBody}\n未貼  \n\n`;
    fs.writeFileSync(path.join(folder, 'output.log'), validPass);

    // ① 審查樹或突變副本不乾淨、HEAD 變了、上了鎖、紀錄標已收、或不在 git worktree 登記裡＝退 1，而且絕對不呼叫 runPost
    const calls = [];
    const recordPost = (cmd, args) => {
      const sentBody = fs.readFileSync(args.at(-1), 'utf8');
      calls.push({ cmd, args, sentBody });
    };
    fs.writeFileSync(path.join(folder, 'tree', 'a.txt'), 'dirty\n');
    let res = main(['--post', '7', '--dir', dir], { settings: s, platform, runPost: recordPost });
    assert.equal(res.code, 1, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /審查樹不乾淨/u);
    assert.equal(calls.length, 0, '樹不乾淨時不可呼叫貼結論指令');
    sh(path.join(folder, 'tree'), 'checkout', '-q', '--', 'a.txt');

    sh(path.join(folder, 'mutation'), 'checkout', '-q', '--detach', r.base);
    res = main(['--post', '7', '--dir', dir], { settings: s, platform, runPost: recordPost });
    assert.equal(res.code, 1);
    assert.match(res.lines.join('\n'), /突變副本的 HEAD 是/u);
    assert.equal(calls.length, 0);
    sh(path.join(folder, 'mutation'), 'checkout', '-q', '--detach', r.head);

    sh(r.dir, 'worktree', 'lock', path.join(folder, 'mutation'));
    res = main(['--post', '7', '--dir', dir], { settings: s, platform, runPost: recordPost });
    assert.equal(res.code, 1);
    assert.match(res.lines.join('\n'), /突變副本上了鎖/u);
    assert.equal(calls.length, 0);
    sh(r.dir, 'worktree', 'unlock', path.join(folder, 'mutation'));

    const recParsed = JSON.parse(recOrig);
    fs.writeFileSync(recFile, `${JSON.stringify({ ...recParsed, removed: [recParsed.mutation] }, null, 1)}\n`);
    res = main(['--post', '7', '--dir', dir], { settings: s, platform, runPost: recordPost });
    assert.equal(res.code, 1);
    assert.match(res.lines.join('\n'), /突變副本已經收掉了/u);
    assert.equal(calls.length, 0);
    fs.writeFileSync(recFile, recOrig);

    const extClone = path.join(extDir, 'unregistered-clone');
    sh(r.dir, 'clone', '-q', r.dir, extClone);
    sh(extClone, 'checkout', '-q', '--detach', r.head);
    fs.writeFileSync(recFile, `${JSON.stringify({ ...recParsed, mutation: extClone }, null, 1)}\n`);
    res = main(['--post', '7', '--dir', dir], { settings: s, platform, runPost: recordPost });
    assert.equal(res.code, 1);
    assert.match(res.lines.join('\n'), /突變副本不在 git worktree 登記裡/u);
    assert.equal(calls.length, 0);
    fs.writeFileSync(recFile, recOrig);

    // ② 結論檔放在審查樹或突變副本裡面、或是連結／資料夾＝退 2，不貼
    const inTree = path.join(folder, 'tree', 'a.txt');
    res = main(['--post', '7', '--file', inTree, '--dir', dir], { settings: s, platform, runPost: recordPost });
    assert.equal(res.code, 2, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /不可放在審查樹裡面/u);

    const sym = path.join(extDir, 'sym.md');
    fs.symlinkSync(path.join(folder, 'output.log'), sym);
    res = main(['--post', '7', '--file', sym, '--dir', dir], { settings: s, platform, runPost: recordPost });
    assert.equal(res.code, 2);
    assert.match(res.lines.join('\n'), /不是一般檔案/u);
    assert.equal(calls.length, 0);

    // ③ 平台受審版本已變、PR 說明複審者被改掉、或平台上已有同輪結論＝退 2，不貼
    const changedHeadPlatform = fakePlatform(answersFor(r, { change: { ...answersFor(r).change, headSha: r.base } }));
    res = main(['--post', '7', '--dir', dir], { settings: s, platform: changedHeadPlatform, runPost: recordPost });
    assert.equal(res.code, 2);
    assert.match(res.lines.join('\n'), /版本已變，不代貼舊版結論/u);

    const changedReviewerPlatform = fakePlatform(answersFor(r, {
      change: { ...answersFor(r).change, body: answersFor(r).change.body.replace('**複審者**：Beta', '**複審者**：Alpha') },
    }));
    res = main(['--post', '7', '--dir', dir], { settings: s, platform: changedReviewerPlatform, runPost: recordPost });
    assert.equal(res.code, 2);
    assert.match(res.lines.join('\n'), /PR說明的「複審者」欄目前是「Alpha」，不是開樹時的 Beta：不代貼/u);

    const dupOnPlatform = fakePlatform(answersFor(r, { comments: [verdict('Beta', 1, r.head, '通過')] }));
    res = main(['--post', '7', '--dir', dir], { settings: s, platform: dupOnPlatform, runPost: recordPost });
    assert.equal(res.code, 2);
    assert.match(res.lines.join('\n'), /平台上已經有 Beta（beta CLI）的 r1 結論留言：不重複貼/u);
    assert.equal(calls.length, 0);

    // ④ postComment 樣板沒帶 {change}、沒帶獨立的 <你寫好的結論檔>、或引號未閉合＝退 2；splitCommandArgs 保留單雙引號與空白參數
    assert.deepEqual(
      splitCommandArgs('post 7 -R "acme/kit" --label \'needs review\' --tag "a \\"quoted\\" tag" --path /tmp/my\\ dir --file "<你寫好的結論檔>"'),
      ['post', '7', '-R', 'acme/kit', '--label', 'needs review', '--tag', 'a "quoted" tag', '--path', '/tmp/my dir', '--file', '<你寫好的結論檔>'],
    );
    assert.throws(() => splitCommandArgs('post 7 -R "acme/kit'), /引號或跳脫字元沒有閉合/u);
    assert.throws(() => splitCommandArgs('post 7 \\'), /引號或跳脫字元沒有閉合/u);

    const noChangeSettings = settingsFor({ owner: 'Boss', reviewLaunch: { ...s.reviewLaunch, postComment: 'post -R {project} --file <你寫好的結論檔>' } });
    res = main(['--post', '7', '--dir', dir], { settings: noChangeSettings, platform, runPost: recordPost });
    assert.equal(res.code, 2);
    assert.match(res.lines.join('\n'), /reviewLaunch\.postComment 沒帶 \{change\}/u);

    const noFileSettings = settingsFor({ owner: 'Boss', reviewLaunch: { ...s.reviewLaunch, postComment: '假的貼法 {change}' } });
    res = main(['--post', '7', '--dir', dir], { settings: noFileSettings, platform, runPost: recordPost });
    assert.equal(res.code, 2);
    assert.match(res.lines.join('\n'), /要包含獨立的 <你寫好的結論檔> 佔位/u);

    const unclosedQuoteSettings = settingsFor({ owner: 'Boss', reviewLaunch: { ...s.reviewLaunch, postComment: 'post {change} -R "{project} --file <你寫好的結論檔>' } });
    res = main(['--post', '7', '--dir', dir], { settings: unclosedQuoteSettings, platform, runPost: recordPost });
    assert.equal(res.code, 2);
    assert.match(res.lines.join('\n'), /引號或跳脫字元沒有閉合/u);
    assert.equal(calls.length, 0);

    // ⑤ 發現死程序殘留鎖（post.lock 的 PID 已不存在）＝退 2、保留殘留鎖不自動刪除、零貼文；手動移除殘留鎖後正常代貼（含單雙引號與帶空白參數樣板、預設讀 outFile、自動剝除文末「未貼」、逐字比對送出全文）
    let deadPid = 999999;
    while (deadPid > 200000) {
      try { process.kill(deadPid, 0); deadPid -= 1; } catch (e) { if (e && e.code === 'ESRCH') break; deadPid -= 1; }
    }
    const lockFile = path.join(folder, 'post.lock');
    fs.writeFileSync(lockFile, `${deadPid}\n`);
    const quotedSettings = settingsFor({
      owner: 'Boss',
      reviewLaunch: {
        ...s.reviewLaunch,
        postComment: 'post {change} -R "{project}" --label \'needs review\' --tag "a \\"quoted\\" tag" --path /tmp/my\\ dir --file "<你寫好的結論檔>"',
      },
    });
    res = main(['--post', '7', '--dir', dir], { settings: quotedSettings, platform, runPost: recordPost });
    assert.equal(res.code, 2);
    assert.match(res.lines.join('\n'), /發現殘留的代貼鎖 .*（原持有程序 PID .* 已結束）/u);
    assert.equal(calls.length, 0, '遇殘留鎖時不可呼叫貼結論指令');
    assert.ok(fs.existsSync(lockFile), '遇殘留鎖時不可非原子自動刪除 post.lock');
    fs.unlinkSync(lockFile);

    res = main(['--post', '7', '--dir', dir], { settings: quotedSettings, platform, runPost: recordPost });
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.match(res.lines.join('\n'), /已代貼 r1 結論.*結論：通過（已剝除文末「未貼」）/u);
    assert.equal(calls.length, 1);
    const recAfter = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    assert.ok(recAfter.postedAt, 'launch.json 記下 postedAt');
    assert.equal(recAfter.verdict, '通過');
    assert.ok(recAfter.verdictFile.startsWith(path.join(folder, 'verdict-')), '結論暫存檔為每輪每次獨立檔名');
    assert.deepEqual(calls[0].cmd, 'post');
    assert.deepEqual(calls[0].args, [
      '7', '-R', 'acme/kit', '--label', 'needs review', '--tag', 'a "quoted" tag', '--path', '/tmp/my dir', '--file', recAfter.verdictFile,
    ]);
    assert.equal(calls[0].sentBody, expectedBody, '送給貼結論指令的檔案內容須與期望全文逐字一致');
    assert.equal(fs.readFileSync(recAfter.verdictFile, 'utf8'), expectedBody, '暫存檔全文須與期望全文逐字一致');
    assert.ok(!fs.existsSync(path.join(folder, 'post.lock')), '代貼完成後釋放 post.lock');

    // ⑥ 同一輪重複跑 --post＝退 2，不重複呼叫
    const dupLocal = main(['--post', '7', '--dir', dir], { settings: quotedSettings, platform, runPost: recordPost });
    assert.equal(dupLocal.code, 2);
    assert.match(dupLocal.lines.join('\n'), /已經在 .* 代貼過結論，不重複貼/u);
    assert.equal(calls.length, 1);

    // ⑦ 代貼後照常 --close 收樹
    const closed = close('7', { settings: s, dir, leftoverRoots: [] });
    assert.equal(closed.code, 0, closed.lines.join('\n'));
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    for (const d of [dir, extDir, r.dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('⑪同輪並行代貼（--post）：每輪排他鎖、殘留鎖拒收與獨立暫存檔保證只送出一次，且不會誤刪持有者的鎖', async () => {
  const r = repo();
  const dir = tmp('review-launch-race-');
  const ext = tmp('review-launch-race-ext-');
  const s = settingsFor({ owner: 'Boss' });
  const answers = answersFor(r);
  const launched = launch('7', 'Beta', { settings: s, platform: fakePlatform(answers), cwd: r.dir, dir, template: TEMPLATE });
  assert.equal(launched.code, 0, launched.lines.join('\n'));
  const folder = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r1');
  const lockFile = path.join(folder, 'post.lock');
  const expectedA = `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：需修改後再審\n\n### 本輪實際用的設定\n- A-original\n\n### 清單逐項結果\n- A-original\n`;
  const expectedB = `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- B-original\n\n### 清單逐項結果\n- B-original\n`;
  const fileA = path.join(ext, 'A.md');
  const fileB = path.join(ext, 'B.md');
  fs.writeFileSync(fileA, `${expectedA}\n未貼\n`);
  fs.writeFileSync(fileB, `${expectedB}\n未貼\n`);

  // (a) 固定交錯點 1：兩個程序處理同一舊殘留鎖（A 讀到死 PID 後暫停，期間舊鎖已除且 B 取得新鎖進入 runPost；A 恢復後不得刪掉 B 的鎖，也不能再送出一則）
  let deadPid = 999999;
  while (deadPid > 200000) {
    try { process.kill(deadPid, 0); deadPid -= 1; } catch (e) { if (e && e.code === 'ESRCH') break; deadPid -= 1; }
  }
  fs.writeFileSync(lockFile, `${deadPid}\n`);

  function staleWorkerMain() {
    const wfs = require('node:fs');
    const wpath = require('node:path');
    const o = JSON.parse(process.argv[2]);
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    if (o.tag === 'A') {
      const origRead = wfs.readFileSync;
      let hooked = false;
      wfs.readFileSync = function patchedRead(p, ...rest) {
        const res = origRead.call(this, p, ...rest);
        if (!hooked && String(p).endsWith('post.lock')) {
          hooked = true;
          wfs.writeFileSync(wpath.join(o.ext, 'stale-a-read-pid'), '1');
          const bInPost = wpath.join(o.ext, 'stale-b-in-runpost');
          const until = Date.now() + 10000;
          while (!wfs.existsSync(bInPost)) {
            if (Date.now() > until) throw new Error('timeout waiting for B to acquire new lock');
            sleep(10);
          }
        }
        return res;
      };
    } else {
      const aRead = wpath.join(o.ext, 'stale-a-read-pid');
      const until = Date.now() + 10000;
      while (!wfs.existsSync(aRead)) {
        if (Date.now() > until) throw new Error('timeout waiting for A to read stale PID');
        sleep(10);
      }
      try { wfs.unlinkSync(o.lockFile); } catch { /* removed */ }
    }
    const { main: runMain } = require('review-launch.js');
    const res = runMain(['--post', '7', '--dir', o.dir, '--file', o.file], {
      settings: o.settings,
      platform: {
        ask(op) {
          if (op === 'change') return o.change;
          if (op === 'comments') return [];
          throw new Error(`unexpected op: ${op}`);
        },
      },
      runPost(_cmd, args) {
        if (o.tag === 'B') {
          wfs.writeFileSync(wpath.join(o.ext, 'stale-b-in-runpost'), '1');
          const aDone = wpath.join(o.ext, 'stale-a-done');
          const until = Date.now() + 10000;
          while (!wfs.existsSync(aDone)) {
            if (Date.now() > until) break;
            sleep(10);
          }
          if (!wfs.existsSync(o.lockFile)) throw new Error('B lock was deleted by A');
        }
        const body = wfs.readFileSync(args.at(-1), 'utf8');
        wfs.appendFileSync(wpath.join(o.ext, 'stale-posts.jsonl'), `${JSON.stringify({ tag: o.tag, body })}\n`);
      },
    });
    if (o.tag === 'A') wfs.writeFileSync(wpath.join(o.ext, 'stale-a-done'), '1');
    process.stdout.write(`${JSON.stringify({ tag: o.tag, code: res.code, verdict: res.header ? res.header.verdict : null, lines: res.lines })}\n`);
    process.exitCode = res.code;
  }

  const staleWorkerFile = path.join(ext, 'stale-worker.js');
  fs.writeFileSync(staleWorkerFile, `(${staleWorkerMain.toString()})();\n`);
  const workerEnv = { ...gitEnv(), NODE_PATH: path.join(__dirname, '..', 'tools') };
  const runStaleWorker = (tag, file) => new Promise((resolve, reject) => {
    const payload = { tag, ext, dir, lockFile, settings: s, change: answers.change, file };
    const p = spawn(process.execPath, [staleWorkerFile, JSON.stringify(payload)], { env: workerEnv });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr, out: stdout.trim() ? JSON.parse(stdout.trim()) : null }));
  });

  // (b) 固定交錯點 2：一般同輪雙程序並發（A 持鎖在 runPost 內、B 後到排隊等候，A 完成後 B 重讀 launch.json 拒絕重貼）
  function workerMain() {
    const wfs = require('node:fs');
    const wpath = require('node:path');
    const o = JSON.parse(process.argv[2]);
    const { main: runMain } = require('review-launch.js');
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    if (o.tag === 'B') {
      const aEntered = wpath.join(o.ext, 'a-entered-runpost');
      const until = Date.now() + 10000;
      while (!wfs.existsSync(aEntered)) {
        if (Date.now() > until) throw new Error('timeout waiting for A to enter runPost');
        sleep(10);
      }
      wfs.writeFileSync(wpath.join(o.ext, 'b-calling-post'), '1');
    }
    const res = runMain(['--post', '7', '--dir', o.dir, '--file', o.file], {
      settings: o.settings,
      platform: {
        ask(op) {
          if (op === 'change') return o.change;
          if (op === 'comments') return [];
          throw new Error(`unexpected op: ${op}`);
        },
      },
      runPost(_cmd, args) {
        if (o.tag === 'A') {
          wfs.writeFileSync(wpath.join(o.ext, 'a-entered-runpost'), '1');
          const bCalling = wpath.join(o.ext, 'b-calling-post');
          const until = Date.now() + 10000;
          while (!wfs.existsSync(bCalling)) {
            if (Date.now() > until) throw new Error('timeout waiting for B to call post');
            sleep(10);
          }
          sleep(80);
        }
        const body = wfs.readFileSync(args.at(-1), 'utf8');
        wfs.appendFileSync(wpath.join(o.ext, 'posts.jsonl'), `${JSON.stringify({ tag: o.tag, body })}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify({ tag: o.tag, code: res.code, verdict: res.header ? res.header.verdict : null, lines: res.lines })}\n`);
    process.exitCode = res.code;
  }

  const workerFile = path.join(ext, 'worker.js');
  fs.writeFileSync(workerFile, `(${workerMain.toString()})();\n`);
  const runWorker = (tag, file) => new Promise((resolve, reject) => {
    const payload = { tag, ext, dir, settings: s, change: answers.change, file };
    const p = spawn(process.execPath, [workerFile, JSON.stringify(payload)], { env: workerEnv });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr, out: stdout.trim() ? JSON.parse(stdout.trim()) : null }));
  });

  try {
    const [staleA, staleB] = await Promise.all([runStaleWorker('A', fileA), runStaleWorker('B', fileB)]);
    assert.equal(staleA.code, 2, `staleA should reject stale lock; got ${JSON.stringify(staleA)}`);
    assert.match(staleA.out.lines.join('\n'), /發現殘留的代貼鎖/u);
    assert.equal(staleB.code, 0, `staleB stderr: ${staleB.stderr}`);
    const stalePosts = fs.readFileSync(path.join(ext, 'stale-posts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(stalePosts.length, 1, '殘留鎖交錯時全程只可送出一則');
    assert.equal(stalePosts[0].tag, 'B');
    assert.equal(stalePosts[0].body, expectedB);

    // 重設 postedAt 以驗證一般同輪並發排隊
    const recFile = path.join(folder, 'launch.json');
    const recReset = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    delete recReset.postedAt;
    delete recReset.verdict;
    delete recReset.verdictFile;
    fs.writeFileSync(recFile, `${JSON.stringify(recReset, null, 1)}\n`);

    const [resA, resB] = await Promise.all([runWorker('A', fileA), runWorker('B', fileB)]);
    assert.equal(resA.code, 0, `A stderr: ${resA.stderr}`);
    assert.equal(resA.out.verdict, '需修改後再審');
    assert.equal(resB.code, 2, `B should be rejected after A posts; got ${JSON.stringify(resB)}`);
    assert.match(resB.out.lines.join('\n'), /已經在 .* 代貼過結論，不重複貼/u);

    const posts = fs.readFileSync(path.join(ext, 'posts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(posts.length, 1, '同輪並行 --post 只可送出一則結論');
    assert.equal(posts[0].tag, 'A');
    assert.equal(posts[0].body, expectedA, '送出全文須與 A 核對通過的結論逐字一致，不可被 B 覆寫');

    const recAfter = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    assert.equal(recAfter.verdict, '需修改後再審');
    assert.equal(fs.readFileSync(recAfter.verdictFile, 'utf8'), expectedA);
  } finally {
    close('7', { settings: s, dir, leftoverRoots: [] });
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    for (const d of [dir, ext, r.dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('⑪defaultRunPost：不開 shell 直接執行，並清掉整個 GIT_* 家族與 clearEnv；失敗或起不來丟 LaunchError', () => {
  const d = tmp('review-launch-runpost-');
  const out = path.join(d, 'env.json');
  const savedGit = process.env.GIT_DIR;
  const savedIdx = process.env.GIT_INDEX_FILE;
  const savedCustom = process.env.SECRET_TOKEN_FOR_TEST;
  try {
    process.env.GIT_DIR = '/decoy/git';
    process.env.GIT_INDEX_FILE = '/decoy/index';
    process.env.SECRET_TOKEN_FOR_TEST = 'should-be-cleared';
    defaultRunPost(process.execPath, [
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ git: Object.keys(process.env).filter((k) => k.startsWith("GIT_")), token: process.env.SECRET_TOKEN_FOR_TEST || null }))',
      out,
    ], { clearEnv: ['SECRET_TOKEN_FOR_TEST'] });
    const got = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(got, { git: [], token: null });
    assert.throws(() => defaultRunPost(process.execPath, ['-e', 'console.error("貼失敗"); process.exit(3)']), /貼結論指令退 3：貼失敗/u);
    assert.throws(() => defaultRunPost(path.join(d, 'no-such-bin'), []), /貼結論指令起不來/u);
  } finally {
    if (savedGit === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGit;
    if (savedIdx === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = savedIdx;
    if (savedCustom === undefined) delete process.env.SECRET_TOKEN_FOR_TEST; else process.env.SECRET_TOKEN_FOR_TEST = savedCustom;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('⑫複審後掃生命週期（G1、G2）：templates/scan-record.md 提示範本與 SCAN_FILL 一一對上且不含 🤖；--scan／--scan-post／--scan-close 與結論閘相容', () => {
  const scanTpl = fs.readFileSync(SCAN_TEMPLATE, 'utf8');
  assert.ok(!scanTpl.includes('🤖'), 'templates/scan-record.md 不可含字面上的 🤖，以免誤觸結論閘');
  const dummy = Object.fromEntries(SCAN_FILL.map(([, k], i) => [k, `VAL_${i}_${k}`]));
  const filled = fill(scanTpl, dummy, SCAN_FILL);
  for (const [, k] of Object.entries(dummy)) assert.ok(filled.includes(k), `掃描提示範本漏掉 ${k}`);
  assert.match(
    filled,
    new RegExp(`這一支的實作者：\`${dummy.implementer}\`；複審者：\`${dummy.reviewer}\``, 'u'),
    '掃描提示的實作者與複審者位置必須正確',
  );
  assert.throws(() => fill(`${scanTpl}\n<多一格>`, dummy, SCAN_FILL), /範本的格子跟產生器的表對不上/u);

  const r = repo();
  const dir = tmp('scan-launch-out-');
  const scannerCfg = {
    participant: 'Gamma',
    launch: '由掃描發射者執行 tools/review-launch.js --scan',
    assignedBy: '專案設定',
    tieBreaker: '由實作者發起',
    fallback: '未執行：<原因>',
    strongest: 'grok-strong',
    maxEffort: 'xhigh',
    source: 'Grok CLI',
    command: 'grok --cwd {scanTree} --model {model} --reasoning-effort {effort} --permission-mode plan --sandbox read-only --prompt-file {promptFile} > {outFile}',
  };
  const s = settingsFor({
    participants: [
      ...settingsFor().participants,
      { role: 'AI 丙', id: 'Gamma', account: 'ai-acct' },
    ],
    owner: 'Boss',
    scanner: scannerCfg,
  });
  const baseAns = answersFor(r);
  const usable = s.participants.map((p) => p.id);

  try {
    // (a) 未設定掃描者或 scanner.command 沒帶 {scanTree} → 退 2、不開樹
    const noScanner = main(['--scan', '7', '--dir', dir], {
      settings: settingsFor({ scanner: { ...unfilled().scanner } }),
      platform: fakePlatform(baseAns),
      cwd: r.dir,
    });
    assert.equal(noScanner.code, 2);
    assert.match(noScanner.lines.join('\n'), /未執行：本專案無掃描者/u);

    const noScanTree = main(['--scan', '7', '--dir', dir], {
      settings: { ...s, scanner: { ...scannerCfg, command: 'grok --model {model} --reasoning-effort {effort}' } },
      platform: fakePlatform(baseAns),
      cwd: r.dir,
    });
    assert.equal(noScanTree.code, 2);
    assert.match(noScanTree.lines.join('\n'), /scanner\.command 沒帶 \{model\}、\{effort\} 或 \{scanTree\}/u);

    for (const overlap of ['Alpha', 'Beta']) {
      const overlapRes = main(['--scan', '7', '--dir', dir], {
        settings: { ...s, scanner: { ...scannerCfg, participant: overlap } },
        platform: fakePlatform(baseAns),
        cwd: r.dir,
      });
      assert.equal(overlapRes.code, 2);
      assert.match(overlapRes.lines.join('\n'), /與本支實作者.*或複審者.*重疊：G1 規定由第三個 AI 掃描/u);
    }

    // (b) 快速通道（擁有者／AI） → 印未執行：快速通道（擁有者／AI），即使 PR 說明填了「風險級別：高」或帶 `--tier 高` 亦不取消快速通道（AI）（#114 r2 R7）
    const ownerBody = BODY.replace('- **複審者**：Beta', '- **複審者**：Boss');
    const fastOwner = main(['--scan', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform({ ...baseAns, change: { ...baseAns.change, body: ownerBody } }),
      cwd: r.dir,
    });
    assert.equal(fastOwner.code, 2);
    assert.match(fastOwner.lines.join('\n'), /未執行：快速通道（擁有者）/u);

    const cr = commentRepo();
    const sLane = { ...s, ...LANE_SETTINGS };
    const crAns = answersFor(cr, {
      change: { ...answersFor(cr).change, body: `${BODY}- **風險級別**：高\n` },
      comments: [verdict('Beta', 1, cr.head, '通過', { id: 'pass-lane', createdAt: '2026-10-19T12:00:00Z' })],
    });
    const fastAi = main(['--scan', '7', '--tier', '高', '--dir', dir], {
      settings: sLane,
      platform: fakePlatform(crAns),
      cwd: cr.dir,
    });
    assert.equal(fastAi.code, 2);
    assert.match(fastAi.lines.join('\n'), /未執行：快速通道（AI）/u);
    assert.deepEqual(fs.readdirSync(dir), [], '快速通道（AI）不開掃描樹');

    // (c) 低風險表定不掃 → 印未執行：低風險，表定不掃；但若依 D4 調重（--tier 高／中 或 PR 說明「風險級別」調重）則放行開樹，若企圖調輕則拒絕
    const lowFiles = [{ path: 'docs/x.md', status: 'modified', previousPath: null }];
    const lowRisk = main(['--scan', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform({ ...baseAns, changedFiles: lowFiles }),
      cwd: r.dir,
    });
    assert.equal(lowRisk.code, 2);
    assert.match(lowRisk.lines.join('\n'), /未執行：低風險，表定不掃/u);

    const passComment = verdict('Beta', 1, r.head, '通過', { id: 'pass99', createdAt: '2026-10-19T12:00:00Z' });
    const withPass = { ...baseAns, comments: [passComment] };

    // 企圖把高風險（tools/x.js）調輕為低風險（--tier 低 或 PR 說明風險級別：低）→ 違反 D4 只升不降，退 2
    const downgradeCli = main(['--scan', '7', '--tier', '低', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      cwd: r.dir,
    });
    assert.equal(downgradeCli.code, 2);
    assert.match(downgradeCli.lines.join('\n'), /風險級別只升不降（D4）：依檔案算是高風險，--tier不可調輕為低風險/u);

    const downgradeBody = main(['--scan', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform({ ...withPass, change: { ...withPass.change, body: `${BODY}- **風險級別**：低\n` } }),
      cwd: r.dir,
    });
    assert.equal(downgradeBody.code, 2);
    assert.match(downgradeBody.lines.join('\n'), /風險級別只升不降（D4）：依檔案算是高風險，PR說明的「風險級別」不可調輕為低風險/u);

    const badTierCli = main(['--scan', '7', '--tier', '極高', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      cwd: r.dir,
    });
    assert.equal(badTierCli.code, 2);
    assert.match(badTierCli.lines.join('\n'), /--tier 給的「極高」不是高／中／低/u);

    // 依檔案算低風險（docs/x.md），但透過 PR 說明「風險級別：高（碰到判準升級條件）」或 `--tier 中` 往重調 → 退 0、照調重後的級別開掃描樹
    const escalatedDir = tmp('scan-escalated-');
    const escalatedByBody = main(['--scan', '7', '--dir', escalatedDir], {
      settings: s,
      platform: fakePlatform({
        ...withPass,
        changedFiles: lowFiles,
        change: { ...withPass.change, body: `${BODY}- **風險級別**：高（碰到判準升級條件）\n` },
      }),
      cwd: r.dir,
    });
    assert.equal(escalatedByBody.code, 0, escalatedByBody.lines.join('\n'));
    assert.equal(escalatedByBody.record.tier, '高');
    assert.match(escalatedByBody.prompt, /風險級別：高/u);
    assert.equal(main(['--scan-close', '7', '--dir', escalatedDir], { settings: s }).code, 0);
    fs.rmSync(escalatedDir, { recursive: true, force: true });

    const escalatedCliDir = tmp('scan-escalated-cli-');
    const escalatedByCli = main(['--scan', '7', '--tier', '中', '--dir', escalatedCliDir], {
      settings: s,
      platform: fakePlatform({ ...withPass, changedFiles: lowFiles }),
      cwd: r.dir,
    });
    assert.equal(escalatedByCli.code, 0, escalatedByCli.lines.join('\n'));
    assert.equal(escalatedByCli.record.tier, '中');
    assert.match(escalatedByCli.prompt, /風險級別：中/u);
    assert.equal(main(['--scan-close', '7', '--dir', escalatedCliDir], { settings: s }).code, 0);
    fs.rmSync(escalatedCliDir, { recursive: true, force: true });

    // (d) 指定複審者尚未對當版貼通過 → 拒絕開樹
    const noPass = main(['--scan', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform(baseAns),
      cwd: r.dir,
    });
    assert.equal(noPass.code, 2);
    assert.match(noPass.lines.join('\n'), /還沒有指定複審者 Beta 的合格「通過」結論/u);

    // (e) 指定複審者已對當版貼通過 → 退 0、開唯讀掃描樹、寫 prompt.md 與 scan.json
    const ok = main(['--scan', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      cwd: r.dir,
    });
    assert.equal(ok.code, 0, ok.lines.join('\n'));
    assert.match(ok.prompt, /這一支的實作者：`Alpha`；複審者：`Beta`/u, '掃描提示的實作者與複審者填對角色');
    const folder = path.dirname(ok.record.promptFile);
    assert.ok(fs.existsSync(path.join(ok.record.tree, 'a.txt')), '唯讀掃描樹已開出');
    assert.ok(fs.existsSync(ok.record.promptFile) && fs.existsSync(path.join(folder, 'scan.json')), '提示檔與 scan.json 已寫出');
    assert.match(ok.command, /^grok --cwd .* --model grok-strong --reasoning-effort xhigh/u);

    // (f) prepareScan 與 --scan-post：禁含 🤖、禁自帶「掃描時序」、驗 🔍 標頭角色／來源／短碼、驗樹乾淨／HEAD／未鎖、驗平台版本／未重複
    for (const [what, badRaw, re] of [
      ['含 🤖', `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n內文誤帶 🤖 記號\n未貼\n`, /掃描回覆含有複審結論記號 🤖/u],
      ['角色不符', `🔍 Wrong｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n內容\n`, /掃描標頭的角色是「Wrong」/u],
      ['來源不符', `🔍 Gamma｜來源：other CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n內容\n`, /掃描標頭的來源是「other CLI」，不是設定登記的「Grok CLI」/u],
      ['短碼不符', `🔍 Gamma｜來源：Grok CLI｜掃 \`deadbee\`\n\n內容\n`, /掃描標頭掃的是 deadbee，對不上要掃的版本/u],
      ['自帶掃描時序引用行', `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n> 掃描時序：偽造的時序\n\n- 零發現\n`, /掃描回覆不可自帶「掃描時序」行/u],
      ['內文夾帶掃描時序行', `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n- 零發現\n掃描時序：偽造\n`, /掃描回覆不可自帶「掃描時序」行/u],
    ]) {
      assert.throws(
        () => prepareScan(badRaw, {
          scanner: 'Gamma', source: 'Grok CLI', head: r.head, usable,
          passCommentLink: 'https://x.invalid/c1', startedAt: '2026-10-19T12:01:00Z', postedAt: '2026-10-19T12:02:00Z', base: r.base,
        }),
        re,
        what,
      );
    }

    const validReply = [
      `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\``,
      '',
      '### 本次實際用的設定',
      '- 模型：grok-strong',
      '- 推理強度：xhigh',
      '',
      '### 掃描結果',
      '- 零發現',
      '未貼',
      '',
    ].join('\n');
    fs.writeFileSync(ok.record.outFile, validReply);

    let postCalls = 0;
    const countPost = () => { postCalls += 1; };

    // 弄髒掃描樹 → --scan-post 退 1、不貼
    fs.writeFileSync(path.join(ok.record.tree, 'a.txt'), 'dirty\n');
    const dirtyPost = main(['--scan-post', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), runPost: countPost });
    assert.equal(dirtyPost.code, 1);
    assert.match(dirtyPost.lines.join('\n'), /掃描樹不乾淨/u);
    assert.equal(postCalls, 0, '掃描樹不乾淨時不可呼叫 runPost');
    sh(ok.record.tree, 'checkout', '-q', '--', 'a.txt');

    // 掃描樹 HEAD 被改掉 → --scan-post 退 1、不貼
    sh(ok.record.tree, 'checkout', '-q', '--detach', r.base);
    const headChangedPost = main(['--scan-post', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), runPost: countPost });
    assert.equal(headChangedPost.code, 1);
    assert.match(headChangedPost.lines.join('\n'), /掃描樹的 HEAD 是/u);
    assert.equal(postCalls, 0, '掃描樹 HEAD 變了時不可呼叫 runPost');
    sh(ok.record.tree, 'checkout', '-q', '--detach', r.head);

    // 掃描樹上了鎖 → --scan-post 退 1、不貼
    sh(r.dir, 'worktree', 'lock', ok.record.tree);
    const lockedPost = main(['--scan-post', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), runPost: countPost });
    assert.equal(lockedPost.code, 1);
    assert.match(lockedPost.lines.join('\n'), /掃描樹上了鎖/u);
    assert.equal(postCalls, 0, '掃描樹上鎖時不可呼叫 runPost');
    sh(r.dir, 'worktree', 'unlock', ok.record.tree);

    // 回覆檔自帶 `> 掃描時序：`、來源不符或短碼不符 → --scan-post 退 2、不貼
    for (const [what, badText, re] of [
      ['自帶掃描時序', `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n> 掃描時序：依據複審留言 偽造\n\n- 零發現\n`, /掃描回覆不可自帶「掃描時序」行/u],
      ['標頭來源不符', `🔍 Gamma｜來源：other CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n- 零發現\n`, /掃描標頭的來源是「other CLI」/u],
      ['標頭短碼不符', `🔍 Gamma｜來源：Grok CLI｜掃 \`deadbee\`\n\n- 零發現\n`, /掃描標頭掃的是 deadbee/u],
    ]) {
      fs.writeFileSync(ok.record.outFile, badText);
      const badPost = main(['--scan-post', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), runPost: countPost });
      assert.equal(badPost.code, 2, what);
      assert.match(badPost.lines.join('\n'), re, what);
      assert.equal(postCalls, 0, `${what}：不可呼叫 runPost`);
    }
    fs.writeFileSync(ok.record.outFile, validReply);

    // 平台版本已變 → --scan-post 退 2、不貼
    const platformHeadChanged = main(['--scan-post', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform({ ...withPass, change: { ...withPass.change, headSha: r.base } }),
      runPost: countPost,
    });
    assert.equal(platformHeadChanged.code, 2);
    assert.match(platformHeadChanged.lines.join('\n'), /版本已變，不代貼舊版掃描/u);
    assert.equal(postCalls, 0, '平台版本已變時不可呼叫 runPost');

    // 平台上已有同版本掃描留言 → --scan-post 退 2、不貼
    const platformDupScan = main(['--scan-post', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform({
        ...withPass,
        comments: [
          passComment,
          { id: 'scan-existing', author: 'ai-acct', createdAt: '2026-10-19T12:03:00Z', body: `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n- 零發現\n` },
        ],
      }),
      runPost: countPost,
    });
    assert.equal(platformDupScan.code, 2);
    assert.match(platformDupScan.lines.join('\n'), /平台上已經有 Gamma（Grok CLI）對 .* 的 🔍 掃描留言：不重複貼/u);
    assert.equal(postCalls, 0, '平台上已有同版掃描留言時不可呼叫 runPost');

    let postedBody = null;
    const postRes = main(['--scan-post', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      runPost(_cmd, args) {
        postCalls += 1;
        postedBody = fs.readFileSync(args.at(-1), 'utf8');
      },
    });
    assert.equal(postRes.code, 0, postRes.lines.join('\n'));
    assert.equal(postCalls, 1);
    assert.ok(postedBody, '應呼叫 runPost 送出掃描留言');
    assert.ok(!postedBody.includes('🤖'), '送出的掃描留言不含 🤖');
    assert.ok(!postedBody.trim().endsWith('未貼'), '文末單獨一行的未貼已剝除');
    const postedLines = postedBody.split('\n');
    assert.equal(postedLines[0], `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\``);
    assert.match(postedLines[1], /^> 掃描時序：依據複審留言 https:\/\/x\.invalid\/acme\/kit\/pull\/7#c-pass99｜準備 /u);

    // 驗證貼上 🔍 掃描留言後，結論聯集閘 evaluateVerdicts 完全相容、不會誤判成壞標頭結論
    const gateRes = evaluateVerdicts([
      passComment,
      { id: 'scan100', author: 'ai-acct', createdAt: '2026-10-19T12:05:00Z', body: postedBody },
    ], r.head, 'Beta', usable, { ownerRole: s.owner });
    assert.deepEqual(gateRes.problems, [], `結論閘應放行含 🔍 掃描留言的 PR：${JSON.stringify(gateRes)}`);
    assert.deepEqual(gateRes.warnings, []);

    // 重複代貼同版掃描留言 → 退 2、不重複呼叫 runPost
    const dupPost = main(['--scan-post', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), runPost: countPost });
    assert.equal(dupPost.code, 2);
    assert.match(dupPost.lines.join('\n'), /已經在 .* 代貼過掃描留言/u);
    assert.equal(postCalls, 1);

    // (g) --scan-close：樹髒或 HEAD 變了退 1，乾淨退 0 並收掉掃描樹
    fs.writeFileSync(path.join(ok.record.tree, 'a.txt'), 'dirty\n');
    const dirtyClose = main(['--scan-close', '7', '--dir', dir], { settings: s });
    assert.equal(dirtyClose.code, 1);
    assert.match(dirtyClose.lines.join('\n'), /掃描樹不乾淨/u);
    sh(ok.record.tree, 'checkout', '-q', '--', 'a.txt');

    sh(ok.record.tree, 'checkout', '-q', '--detach', r.base);
    const headClose = main(['--scan-close', '7', '--dir', dir], { settings: s });
    assert.equal(headClose.code, 1);
    assert.match(headClose.lines.join('\n'), /掃描樹的 HEAD 是/u);
    sh(ok.record.tree, 'checkout', '-q', '--detach', r.head);

    const scanLeftoverDir = tmp('scan-leftover-');
    const freshLeftover = path.join(scanLeftoverDir, 'fresh-item');
    fs.writeFileSync(freshLeftover, 'x');
    const futureTime = new Date(Date.parse(ok.record.startedAt) + 60_000);
    fs.utimesSync(freshLeftover, futureTime, futureTime);
    const okClose = main(['--scan-close', '7', '--dir', dir], { settings: s, leftoverRoots: [scanLeftoverDir] });
    fs.rmSync(scanLeftoverDir, { recursive: true, force: true });
    assert.equal(okClose.code, 0, okClose.lines.join('\n'));
    assert.match(okClose.lines.join('\n'), /收好掃描樹：.*；暫存區另有 1 筆比開樹晚/u);
    assert.ok(!fs.existsSync(ok.record.tree), '掃描樹已收掉');
    assert.ok(JSON.parse(fs.readFileSync(path.join(folder, 'scan.json'), 'utf8')).closedAt, 'scan.json 已記 closedAt');

    // 同版本已貼過且已收樹 → 重跑 --scan 仍拒絕「已經在了」
    const sameHeadRescan = main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), cwd: r.dir });
    assert.equal(sameHeadRescan.code, 2);
    assert.match(sameHeadRescan.lines.join('\n'), /已經在了/u);

    // 推了新提交（head2）並有新通過結論 → --scan 自動替換前版已收樹的舊 scan 資料夾，無需手刪；再跑 --scan-close --purge 一併刪容器
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'head2\n');
    sh(r.dir, 'add', '-A'); sh(r.dir, 'commit', '-q', '-m', 'head2');
    const head2 = sh(r.dir, 'rev-parse', 'HEAD');
    const pass2 = verdict('Beta', 2, head2, '通過', { id: 'pass100', createdAt: '2026-10-19T12:10:00Z' });
    const withPass2 = { ...baseAns, change: { ...baseAns.change, headSha: head2 }, comments: [passComment, pass2] };
    const rescan2 = main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass2), cwd: r.dir });
    assert.equal(rescan2.code, 0, `換新提交後重掃應自動替換前版已收樹的舊容器：${rescan2.lines.join('\n')}`);
    assert.equal(rescan2.record.head, head2);
    const purgeClose = main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s });
    assert.equal(purgeClose.code, 0, purgeClose.lines.join('\n'));
    assert.ok(!fs.existsSync(folder), '--scan-close --purge 應一併清除掃描容器資料夾');
    sh(r.dir, 'reset', '--hard', '-q', r.head);

    // (h) --scanner <識別值>：4 家 AI 隨時切換掃描者（deriveScanCommand 與 resolveScannerSpec）
    assert.equal(
      deriveScanCommand("cd {reviewTree} && claude -p \"$(cat {promptFile})\" --model {model} --effort {effort} --permission-mode dontAsk --setting-sources user,project --add-dir {mutationCopy} --verbose --output-format json --allowedTools 'Read,Grep,Glob,Bash(node --test *),Bash(npm --prefix {mutationCopy} test *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git rev-parse HEAD),Bash(git -C {mutationCopy} rev-parse HEAD),Bash(git -C {mutationCopy} status --porcelain),Bash(git -C {mutationCopy} diff),Bash(gh pr view *),Bash(gh pr diff *),Bash(gh pr checks *),Bash(gh run view *),Bash(gh run list *),Bash(gh pr comment {change} *),Edit(/{mutationCopy}/**),Workflow' --disallowedTools 'Write,Edit(/{reviewTree}/**)' < /dev/null > {outFile}"),
      "cd {scanTree} && claude -p \"$(cat {promptFile})\" --model {model} --effort {effort} --permission-mode dontAsk --setting-sources user,project --allowedTools 'Read,Grep,Glob,Bash(node --test *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git rev-parse HEAD),Bash(gh pr view *),Bash(gh pr diff *),Bash(gh pr checks *),Bash(gh run view *),Bash(gh run list *),Workflow' --disallowedTools 'Write,Edit(/{scanTree}/**)' < /dev/null > {outFile}",
    );
    assert.equal(
      deriveScanCommand('codex exec -C {reviewTree} --add-dir {mutationCopy} -s read-only -m {model} -c model_reasoning_effort={effort} -o {outFile} - < {promptFile}'),
      'codex exec -C {scanTree} -s read-only -m {model} -c model_reasoning_effort={effort} -o {outFile} - < {promptFile}',
    );
    assert.equal(
      deriveScanCommand('node tools/review-launch.js --grok-exec --mode review --cwd {reviewTree} --mutation-copy {mutationCopy} --model {model} --reasoning-effort {effort} --prompt-file {promptFile} --out {outFile}'),
      'node tools/review-launch.js --grok-exec --mode scan --cwd {scanTree} --model {model} --reasoning-effort {effort} --prompt-file {promptFile} --out {outFile}',
    );
    assert.equal(
      deriveScanCommand('(cd {reviewTree} && gemini -m {model} --approval-mode plan --include-directories {reviewTree},{mutationCopy} -p "請執行複審（推理強度：{effort}）" < {promptFile}) > {outFile}'),
      '(cd {scanTree} && gemini -m {model} --approval-mode plan --include-directories {scanTree} -p "請執行掃描（推理強度：{effort}）" < {promptFile}) > {outFile}',
    );

    // 若本倉庫 settings.json 登記了 3 位以上複審者（如 Claude、Codex、Grok、Gemini），逐一以實際設定走 main --scan --scanner 並一路走到 --scan-post 與 --scan-close
    const realS = readSettings();
    const realReviewers = Array.isArray(realS.reviewers) ? realS.reviewers.filter((rev) => rev && rev.participant) : [];
    if (realReviewers.length >= 3 && (!realS.scanner || realS.scanner.tool !== '無')) {
      for (const rev of realReviewers) {
        const target = rev.participant;
        const others = realReviewers.filter((x) => x.participant !== target);
        const impl = others[0].participant;
        const revr = others[1];
        const bodyForTarget = BODY.replace('- **實作者**：Alpha', `- **實作者**：${impl}`).replace('- **複審者**：Beta', `- **複審者**：${revr.participant}`);
        const passForTarget = verdict(revr.participant, 1, r.head, '通過', {
          id: `pass-${target}`,
          createdAt: '2026-10-19T12:00:00Z',
          body: `🤖 ${revr.participant}｜來源：${revr.source}｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n`,
        });
        const realPlatform = fakePlatform({
          ...baseAns,
          change: { ...baseAns.change, body: bodyForTarget },
          comments: [passForTarget],
        });
        const realDirTmp = tmp(`scan-real-${target}-`);
        const realOut = main(['--scan', '7', '--scanner', target, '--dir', realDirTmp], {
          settings: realS,
          platform: realPlatform,
          cwd: r.dir,
        });
        assert.equal(realOut.code, 0, `${target} 實際設定切換掃描失敗：${realOut.lines.join('\n')}`);
        assert.equal(realOut.record.scanner, target);
        assert.ok(!realOut.command.includes('{mutationCopy}') && !realOut.command.includes('{reviewTree}'), `${target} 掃描指令不可殘留未替換記號`);
        assert.ok(!/git -C\s+(?:rev-parse|status|diff)/u.test(realOut.command), `${target} 掃描指令不可留下失去路徑的 git -C`);
        assert.ok(!/--output-format\s+json\b/u.test(realOut.command), `${target} 掃描指令應輸出純文字而非 JSON 包裹`);

        const cleanMarkdown = `🔍 ${target}｜來源：${realOut.record.source}｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- 模型：${rev.strongest}\n\n### 掃描結果\n- 零發現\n未貼\n`;
        if (target === 'Claude') {
          // 若舊設定或外部呼叫產生 Claude JSON 包裹：失敗 JSON 拒貼、成功 JSON 自動解開 result 並完成代貼
          fs.writeFileSync(realOut.record.outFile, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: cleanMarkdown }));
          const errJsonPost = main(['--scan-post', '7', '--dir', realDirTmp], { settings: realS, platform: realPlatform, runPost() {} });
          assert.equal(errJsonPost.code, 2);
          assert.match(errJsonPost.lines.join('\n'), /掃描回覆 JSON 標示執行失敗/u);
          fs.writeFileSync(realOut.record.outFile, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: cleanMarkdown }));
        } else {
          fs.writeFileSync(realOut.record.outFile, cleanMarkdown);
        }
        let postedForTarget = null;
        const realPostRes = main(['--scan-post', '7', '--dir', realDirTmp], {
          settings: realS,
          platform: realPlatform,
          runPost(_cmd, args) { postedForTarget = fs.readFileSync(args.at(-1), 'utf8'); },
        });
        assert.equal(realPostRes.code, 0, `${target} --scan-post 失敗：${realPostRes.lines.join('\n')}`);
        assert.match(postedForTarget, new RegExp(`^🔍 ${target}｜來源：${realOut.record.source}｜掃 `, 'u'));
        assert.equal(main(['--scan-close', '7', '--dir', realDirTmp], { settings: realS }).code, 0);
        fs.rmSync(realDirTmp, { recursive: true, force: true });
      }
    }

    const sWithDelta = {
      ...s,
      participants: [
        ...s.participants,
        { role: 'AI 丁', id: 'Delta', account: 'ai-acct' },
      ],
      reviewers: [
        ...s.reviewers,
        {
          participant: 'Delta',
          strongest: 'delta-pro',
          maxEffort: 'high',
          source: 'Delta CLI',
          command: 'codex exec -C {reviewTree} --add-dir {mutationCopy} -s read-only -m {model} -c model_reasoning_effort={effort} -o {outFile} - < {promptFile}',
        },
      ],
    };
    const usableDelta = sWithDelta.participants.map((p) => p.id);
    assert.throws(() => resolveScannerSpec(sWithDelta, 'NoSuchAI', usableDelta), /--scanner 給的「NoSuchAI」不是登記過的參與者/u);
    assert.throws(() => resolveScannerSpec(sWithDelta, 'Boss', usableDelta), /--scanner 給的「Boss」既不是專案設定的預設掃描者，也不在 reviewers 清單裡/u);

    const switchOverlap = main(['--scan', '7', '--scanner', 'Beta', '--dir', dir], {
      settings: sWithDelta,
      platform: fakePlatform(withPass),
      cwd: r.dir,
    });
    assert.equal(switchOverlap.code, 2);
    assert.match(switchOverlap.lines.join('\n'), /掃描者 Beta 與本支實作者（Alpha）或複審者（Beta）重疊/u);

    const switchDir = tmp('scan-switch-out-');
    const switched = main(['--scan', '7', '--scanner', 'Delta', '--dir', switchDir], {
      settings: sWithDelta,
      platform: fakePlatform(withPass),
      cwd: r.dir,
    });
    assert.equal(switched.code, 0, switched.lines.join('\n'));
    assert.equal(switched.record.scanner, 'Delta');
    assert.equal(switched.record.source, 'Delta CLI');
    assert.match(switched.command, /^codex exec -C .* -s read-only -m delta-pro -c model_reasoning_effort=high/u);
    assert.ok(!switched.command.includes('mutation'), '切換後的掃描指令不可殘留突變副本參數');
    fs.writeFileSync(
      switched.record.outFile,
      `🔍 Delta｜來源：Delta CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- 模型：delta-pro\n\n### 掃描結果\n- 零發現\n未貼\n`,
    );
    let switchedPosted = null;
    const switchedPostRes = main(['--scan-post', '7', '--dir', switchDir], {
      settings: sWithDelta,
      platform: fakePlatform(withPass),
      runPost(_cmd, args) { switchedPosted = fs.readFileSync(args.at(-1), 'utf8'); },
    });
    assert.equal(switchedPostRes.code, 0, switchedPostRes.lines.join('\n'));
    assert.match(switchedPosted, /^🔍 Delta｜來源：Delta CLI｜掃 /u);
    assert.equal(main(['--scan-close', '7', '--dir', switchDir], { settings: sWithDelta }).code, 0);
    fs.rmSync(switchDir, { recursive: true, force: true });
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    for (const d of [dir, r.dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('Grok 隔離執行（--grok-exec）：參數檢查、OIDC 續期與白名單重建、轉送器拒收與預檢失敗拒啟', async () => {
  const {
    parseGrokExecArgs,
    prepareGrokBoxAuth,
    grokRelayRejectReason,
    verifyGrokSeatbeltProfile,
    runGrokSeatbeltProbe,
    runGrokExec,
    GROK_SEATBELT_PROFILE,
    GROK_PINNED_ISSUER,
    GROK_PINNED_CLIENT_ID,
  } = require('../tools/review-launch.js');

  // (a) 參數檢查
  for (const bad of [
    [],
    ['--mode', 'scan', '--cwd', '/tmp', '--model', 'g', '--reasoning-effort', 'h', '--prompt-file', '/tmp/p'],
    ['--mode', 'other', '--cwd', '/tmp', '--model', 'g', '--reasoning-effort', 'h', '--prompt-file', '/tmp/p', '--out', '/tmp/o'],
    ['--mode', 'review', '--cwd', '/tmp', '--model', 'g', '--reasoning-effort', 'h', '--prompt-file', '/tmp/p', '--out', '/tmp/o'],
    ['--mode', 'scan', '--cwd', '/tmp', '--mutation-copy', '/tmp/m', '--model', 'g', '--reasoning-effort', 'h', '--prompt-file', '/tmp/p', '--out', '/tmp/o'],
    ['--mode', 'scan', '--mode', 'scan', '--cwd', '/tmp', '--model', 'g', '--reasoning-effort', 'h', '--prompt-file', '/tmp/p', '--out', '/tmp/o'],
    ['--unknown', '1'],
  ]) {
    assert.ok(parseGrokExecArgs(bad).error, `應拒收壞參數：${bad.join(' ')}`);
  }

  // (b) Seatbelt 規則靜態檢查與預檢失敗拒啟
  assert.equal(verifyGrokSeatbeltProfile(GROK_SEATBELT_PROFILE).ok, true);
  assert.equal(runGrokSeatbeltProbe({ boxDir: '/tmp', relayPort: 54321, spawnSyncImpl: () => ({ status: 71, stdout: '', stderr: 'Operation not permitted' }) }).ok, false);

  // (c) OIDC 快到期自動續期與壞欄拒收
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ack-grok-exec-test-')));
  const r = repo();
  try {
    const authFile = path.join(tmp, 'auth.json');
    const entryKey = `${GROK_PINNED_ISSUER}::${GROK_PINNED_CLIENT_ID}`;
    const expiredAuth = {
      [entryKey]: {
        auth_mode: 'oidc',
        user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        create_time: '2026-10-19T00:00:00.000Z',
        expires_at: '2026-10-19T00:10:00.000Z',
        oidc_issuer: GROK_PINNED_ISSUER,
        oidc_client_id: GROK_PINNED_CLIENT_ID,
        key: 'OLD-KEY-SECRET-1111',
        refresh_token: 'OLD-REFRESH-SECRET-2222',
      },
    };
    fs.writeFileSync(authFile, JSON.stringify(expiredAuth, null, 2), { mode: 0o600 });
    const refreshed = await prepareGrokBoxAuth(authFile, {
      now: () => Date.parse('2026-10-19T00:05:00.000Z'),
      fetchImpl: async (url) => {
        assert.equal(url, `${GROK_PINNED_ISSUER}/oauth2/token`);
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'NEW-KEY-SECRET-3333', refresh_token: 'NEW-REFRESH-SECRET-4444', expires_in: 7200 }),
        };
      },
    });
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshed.realBearer, 'NEW-KEY-SECRET-3333');
    assert.equal(refreshed.forBox[entryKey].key, refreshed.dummyBearer);
    assert.equal(refreshed.forBox[entryKey].refresh_token, undefined);

    // 連結檔 auth.json 一律拒收
    const linkAuth = path.join(tmp, 'link-auth.json');
    fs.symlinkSync(authFile, linkAuth);
    await assert.rejects(() => prepareGrokBoxAuth(linkAuth), /一般檔案/);

    // 轉送器規則核對
    assert.equal(grokRelayRejectReason({ method: 'GET', url: '/v1/models', headers: { authorization: `Bearer ${refreshed.dummyBearer}` } }, refreshed.dummyBearer), null);
    assert.equal(grokRelayRejectReason({ method: 'GET', url: '/v1/models', headers: { authorization: 'Bearer NEW-KEY-SECRET-3333' } }, refreshed.dummyBearer).code, 'auth');

    // (d) review 模式（含突變副本）端到端驗證，且盒內不含其他本機分支物件（r5 R1 路徑 B）、保留非祖先上一輪提交差異（r6 R1）
    sh(r.dir, 'checkout', '-qb', 'unsubmitted-local');
    fs.writeFileSync(path.join(r.dir, 'private-branch.txt'), 'SYNTHETIC-UNSUBMITTED-R5\n');
    sh(r.dir, 'add', '.');
    const unrelatedSha = sh(r.dir, 'commit', '-qm', 'unsubmitted') || sh(r.dir, 'rev-parse', 'HEAD');
    // 建立非祖先的上一輪提交 P
    sh(r.dir, 'checkout', '-q', '--detach', r.base);
    fs.writeFileSync(path.join(r.dir, 'a.txt'), 'prev-round-diverged\n');
    sh(r.dir, 'add', 'a.txt');
    const prevRoundSha = sh(r.dir, 'commit', '-qm', 'prev-round') || sh(r.dir, 'rev-parse', 'HEAD');
    sh(r.dir, 'checkout', '-q', 'main');
    const mutDir = path.join(tmp, 'mutation');
    fs.mkdirSync(mutDir);
    sh(r.dir, 'clone', '--quiet', r.dir, mutDir);
    const promptFile = path.join(tmp, 'prompt.md');
    const outFile = path.join(tmp, 'out.md');
    fs.writeFileSync(
      promptFile,
      `審查樹：${r.dir}\n突變副本：${mutDir}\ngit -C ${r.dir} diff ${r.base}..${r.head}\ngit -C ${r.dir} diff ${prevRoundSha}..${r.head}\n`,
    );
    const revRun = await runGrokExec([
      '--mode', 'review',
      '--cwd', r.dir,
      '--mutation-copy', mutDir,
      '--model', 'grok-4.7',
      '--reasoning-effort', 'xhigh',
      '--prompt-file', promptFile,
      '--out', outFile,
    ], {
      authFile,
      authOpts: { now: () => Date.parse('2026-10-19T00:05:00.000Z') },
      probeFn: () => ({ ok: true }),
      spawnGrok: async ({ boxWorktree, boxMutation, boxPromptFile, grokArgs }) => {
        const pTxt = fs.readFileSync(boxPromptFile, 'utf8');
        assert.ok(pTxt.includes(boxWorktree) && pTxt.includes(boxMutation), '提示檔內審查樹與突變副本路徑皆已改寫為盒內路徑');
        assert.ok(grokArgs.at(-1).includes(pTxt), '-p 指令直接帶入完整提示全文，避免跨目錄讀檔卡住');
        const leak = spawnSync('git', ['-C', boxWorktree, 'show', `${unrelatedSha}:private-branch.txt`], { env: gitEnv(), encoding: 'utf8' });
        assert.notEqual(leak.status, 0, '盒內工作樹不可含未送審本機分支物件');
        const prevDiff = sh(boxWorktree, 'diff', `${prevRoundSha}..${r.head}`);
        assert.match(prevDiff, /-prev-round-diverged/u, '盒內工作樹必須保留非祖先的上一輪提交並可比對跨輪差異');
        // 盒內突變副本的工作區可改檔，盒內審查樹與兩邊 .git 保持不變
        fs.writeFileSync(path.join(boxMutation, 'a.txt'), 'mutated\n');
        return { status: 0, stdout: '🤖 Grok｜來源：Grok CLI｜審 `1234567`｜r1｜結論：通過\n### 本輪實際用的設定\n- ok\n### 清單逐項結果\n- 零發現\n未貼\n', stderr: '' };
      },
    });
    assert.equal(revRun.code, 0, revRun.lines.join('\n'));
    assert.match(fs.readFileSync(outFile, 'utf8'), /^🤖 Grok｜來源：Grok CLI/u, '通過 DLP 後完整寫出正式輸出');

    // stripGrokPreamble 保留完整原始輸出供追查，不裁切任何同行或跨行前言（標頭前若有非空白前言，一律交由 --post／--scan-post 拒貼）
    const sameLineScan = '我現在直接用 git 檢視差異並完成掃描。🔍 Grok｜來源：Grok CLI｜掃 `1234567`\n- 零發現\n';
    const multiLineScan = '1. 真正發現：工具仍有待修問題（合成範例）。\n以下僅展示零發現的格式：\n```text\n🔍 Grok｜來源：Grok CLI｜掃 `1234567`\n- 零發現\n```';
    assert.equal(stripGrokPreamble(sameLineScan, 'scan'), sameLineScan, '同行緊貼前言不剝除，保留原樣交由 --scan-post 拒收');
    assert.equal(stripGrokPreamble(multiLineScan, 'scan'), multiLineScan, '跨行前言含圍欄零發現範例不剝除，保留原始發現交由 --scan-post 拒收');
    for (const v of Object.keys(VERDICTS)) {
      const sameLineReview = `我現在開始複審。🤖 Grok｜來源：Grok CLI｜審 \`1234567\`｜r1｜結論：${v}\n`;
      const multiLineReview = `審查尚未完成。下面只是格式範例，請勿代貼：\n\`\`\`text\n🤖 Grok｜來源：Grok CLI｜審 \`1234567\`｜r1｜結論：${v}\n\`\`\`\n`;
      assert.equal(stripGrokPreamble(sameLineReview, 'review'), sameLineReview, `同行前言＋${v} 不剝除`);
      assert.equal(stripGrokPreamble(multiLineReview, 'review'), multiLineReview, `跨行前言＋${v} 不剝除`);
    }
    for (const leaky of [
      '誤帶 🤖 記號的前言。🔍 Grok｜來源：Grok CLI｜掃 `1234567`\n- 零發現\n',
      '誤帶 🤖 記號的前言。\n🔍 Grok｜來源：Grok CLI｜掃 `1234567`\n- 零發現\n',
    ]) {
      assert.equal(
        stripGrokPreamble(leaky, 'scan'),
        leaky,
        'scan 模式若標頭前含有 🤖 保留原樣讓 --scan-post 攔截',
      );
    }

    // 端到端（runGrokExec → --post）：含前言的圍欄／引用／清單「通過」範例、同行矛盾標頭、首行非正式結論詞或壞標頭一律保留原始輸出至 outFile 並由 --post 拒貼（不留下 postedAt 成功紀錄）；正常正式輸出（通過或不可合併）可完成代貼
    for (const [label, rawStdout, expectPostCode, expectVerdict, expectGateProblems] of [
      [
        '跨行前言含圍欄通過範例＋審查尚未完成（#115 掃描第 1 項重評重現）',
        (_h, _s, p) => `審查尚未完成。下面只是格式範例，請勿代貼：\n\`\`\`text\n${p}\`\`\`\n實際結果：仍有問題，需修改後再審。`,
        2,
        null,
        null,
      ],
      [
        '首行非正式結論詞＋內文通過範例（r4 R5）',
        (h, s, p) => `🤖 Beta｜來源：beta CLI｜審 \`${h}\`｜r1｜結論：不同意（建議撤回或重開）${s}\n下列通過範例不可當結論：\n\`\`\`text\n${p}\`\`\`\n`,
        2,
        null,
        null,
      ],
      [
        '首行不可合併漏來源欄＋圍欄通過範例（r7 R8）',
        (h, s, p) => `🤖 Beta｜審 \`${h}\`｜r1｜結論：不可合併${s}\n以下通過範例不可當作本輪結論：\n\`\`\`text\n${p}\`\`\`\n`,
        2,
        null,
        null,
      ],
      [
        '首行不可合併來源欄用半形冒號 來源:＋圍欄通過範例（r7 R8）',
        (h, s, p) => `🤖 Beta｜來源: beta CLI｜審 \`${h}\`｜r1｜結論：不可合併${s}\n以下通過範例不可當作本輪結論：\n\`\`\`text\n${p}\`\`\`\n`,
        2,
        null,
        null,
      ],
      [
        '兩段同行進度句各帶矛盾標頭：前段通過＋後段不可合併（r6 R7）',
        (h, s, p) => `我現在開始複審。${p}\n進一步核對後更新結論。🤖 Beta｜來源：beta CLI｜審 \`${h}\`｜r1｜結論：不可合併${s}`,
        2,
        null,
        null,
      ],
      [
        '跨行前言含 > 引用通過範例＋獨立行不可合併（r5 R6 引用案例：拒貼保留原始輸出）',
        (h, s, p) => `以下是不可採用的通過範例：\n> ${p.split('\n')[0]}\n\n🤖 Beta｜來源：beta CLI｜審 \`${h}\`｜r1｜結論：不可合併${s}`,
        2,
        null,
        null,
      ],
      [
        '跨行前言含 - 清單通過範例＋獨立行不可合併（r5 R6 清單案例：拒貼保留原始輸出）',
        (h, s, p) => `以下是不可採用的通過範例：\n- ${p.split('\n')[0]}\n\n🤖 Beta｜來源：beta CLI｜審 \`${h}\`｜r1｜結論：不可合併${s}`,
        2,
        null,
        null,
      ],
      [
        '首行不可合併＋內文通過範例（r4 R5）',
        (h, s, p) => `🤖 Beta｜來源：beta CLI｜審 \`${h}\`｜r1｜結論：不可合併${s}\n下列同輪錯誤通過範例不可當成本輪結論：\n\`\`\`text\n${p}\`\`\`\n`,
        0,
        '不可合併',
        true,
      ],
      [
        '正常正式通過輸出（可含開頭空行與文末未貼）',
        (_h, _s, p) => `\n${p}未貼\n`,
        0,
        '通過',
        false,
      ],
    ]) {
      const caseDir = fs.mkdtempSync(path.join(tmp, 'post-r5-r8-'));
      const sCase = settingsFor({ owner: 'Boss' });
      const platformCase = fakePlatform(answersFor(r));
      const launchCase = launch('7', 'Beta', { settings: sCase, platform: platformCase, cwd: r.dir, dir: caseDir, template: TEMPLATE });
      assert.equal(launchCase.code, 0, `${label} launch: ${launchCase.lines.join('\n')}`);
      const sectionsCase = '\n\n### 本輪實際用的設定\n- 合成測試\n\n### 清單逐項結果\n- 合成測試\n';
      const passExampleCase = `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過${sectionsCase}`;
      const stdoutText = rawStdout(r.head.slice(0, 7), sectionsCase, passExampleCase);
      const execCase = await runGrokExec([
        '--mode', 'review',
        '--cwd', launchCase.record.tree,
        '--mutation-copy', launchCase.record.mutation,
        '--model', 'grok-4.7',
        '--reasoning-effort', 'xhigh',
        '--prompt-file', launchCase.record.promptFile,
        '--out', launchCase.record.outFile,
      ], {
        authFile,
        authOpts: { now: () => Date.parse('2026-10-19T00:05:00.000Z') },
        probeFn: () => ({ ok: true }),
        spawnGrok: async () => ({ status: 0, stdout: stdoutText, stderr: '' }),
      });
      assert.equal(execCase.code, 0, `${label} runGrokExec`);
      assert.equal(fs.readFileSync(launchCase.record.outFile, 'utf8'), stdoutText, `${label} outFile 必須完整保留原始輸出供追查`);
      let sentCase = null;
      const postCase = main(['--post', '7', '--dir', caseDir], {
        settings: sCase,
        platform: platformCase,
        runPost(_cmd, args) { sentCase = fs.readFileSync(args.at(-1), 'utf8'); },
      });
      assert.equal(postCase.code, expectPostCode, `${label} --post code: ${postCase.lines.join('\n')}`);
      const launchMetaAfter = JSON.parse(fs.readFileSync(path.join(path.dirname(launchCase.record.outFile), 'launch.json'), 'utf8'));
      if (expectPostCode !== 0) {
        assert.equal(sentCase, null, `${label} 應拒貼`);
        assert.equal(launchMetaAfter.postedAt, undefined, `${label} 拒貼時不可寫入 postedAt`);
      } else {
        assert.equal(postCase.header.verdict, expectVerdict, `${label} 代貼結論應為 ${expectVerdict}`);
        assert.ok(typeof launchMetaAfter.postedAt === 'string', `${label} 成功代貼時寫入 postedAt`);
        const gateCase = evaluateVerdicts(
          [{ id: 'r5-r8-comment', author: 'ai-acct', createdAt: '2026-10-19T12:00:00Z', body: sentCase }],
          r.head,
          'Beta',
          ['Boss', 'Alpha', 'Beta'],
          { ownerRole: 'Boss' },
        );
        if (expectGateProblems) {
          assert.ok(gateCase.problems.length > 0, `${label} 結論聯集閘必須維持阻擋、problems 不可為空`);
        } else {
          assert.deepEqual(gateCase.problems, [], `${label} 正常正式通過輸出應通過結論聯集閘`);
        }
      }
      assert.equal(close('7', { settings: sCase, dir: caseDir, leftoverRoots: [] }).code, 0, `${label} close`);
    }

    // 端到端（runGrokExec → --scan-post）：前文有發現且後面附圍欄「零發現」範例時拒貼、不留 postedAt 並保留完整原始輸出；正常正式掃描輸出可完成代貼
    for (const [scanLabel, scanRawFn, expectScanCode] of [
      [
        '前文含真正發現＋圍欄零發現格式範例（#115 掃描第 1 項重評重現）',
        (h) => `1. 真正發現：工具仍有待修問題（合成範例）。\n以下僅展示零發現的格式：\n\`\`\`text\n🔍 Gamma｜來源：Grok CLI｜掃 \`${h}\`\n- 零發現\n\`\`\``,
        2,
      ],
      [
        '正常正式掃描輸出（可含開頭空行與文末未貼）',
        (h) => `\n🔍 Gamma｜來源：Grok CLI｜掃 \`${h}\`\n\n### 掃描結果\n- 零發現\n未貼\n`,
        0,
      ],
    ]) {
      const scanCaseDir = fs.mkdtempSync(path.join(tmp, 'scan-post-e2e-'));
      const sScanCase = settingsFor({
        participants: [
          ...settingsFor().participants,
          { role: 'AI 丙', id: 'Gamma', account: 'ai-acct' },
        ],
        owner: 'Boss',
        scanner: {
          participant: 'Gamma',
          launch: '由掃描發射者執行 tools/review-launch.js --scan',
          assignedBy: '專案設定',
          tieBreaker: '由實作者發起',
          fallback: '未執行：<原因>',
          strongest: 'grok-4.7',
          maxEffort: 'xhigh',
          source: 'Grok CLI',
          command: 'node tools/review-launch.js --grok-exec --mode scan --cwd {scanTree} --model {model} --reasoning-effort {effort} --prompt-file {promptFile} --out {outFile}',
        },
      });
      const passCommentForScan = verdict('Beta', 1, r.head, '通過', { id: 'pass-scan-e2e', createdAt: '2026-10-19T12:00:00Z' });
      const platformScanCase = fakePlatform(answersFor(r, { comments: [passCommentForScan] }));
      const scanLaunchRes = main(['--scan', '7', '--dir', scanCaseDir], { settings: sScanCase, platform: platformScanCase, cwd: r.dir });
      assert.equal(scanLaunchRes.code, 0, `${scanLabel} --scan: ${scanLaunchRes.lines.join('\n')}`);
      const scanStdout = scanRawFn(r.head.slice(0, 7));
      const scanExecRes = await runGrokExec([
        '--mode', 'scan',
        '--cwd', scanLaunchRes.record.tree,
        '--model', 'grok-4.7',
        '--reasoning-effort', 'xhigh',
        '--prompt-file', scanLaunchRes.record.promptFile,
        '--out', scanLaunchRes.record.outFile,
      ], {
        authFile,
        authOpts: { now: () => Date.parse('2026-10-19T00:05:00.000Z') },
        probeFn: () => ({ ok: true }),
        spawnGrok: async () => ({ status: 0, stdout: scanStdout, stderr: '' }),
      });
      assert.equal(scanExecRes.code, 0, `${scanLabel} runGrokExec`);
      assert.equal(fs.readFileSync(scanLaunchRes.record.outFile, 'utf8'), scanStdout, `${scanLabel} outFile 必須完整保留原始輸出供追查`);
      let sentScanBody = null;
      const scanPostRes = main(['--scan-post', '7', '--dir', scanCaseDir], {
        settings: sScanCase,
        platform: platformScanCase,
        runPost(_cmd, args) { sentScanBody = fs.readFileSync(args.at(-1), 'utf8'); },
      });
      assert.equal(scanPostRes.code, expectScanCode, `${scanLabel} --scan-post: ${scanPostRes.lines.join('\n')}`);
      const scanMetaAfter = JSON.parse(fs.readFileSync(path.join(path.dirname(scanLaunchRes.record.outFile), 'scan.json'), 'utf8'));
      if (expectScanCode !== 0) {
        assert.equal(sentScanBody, null, `${scanLabel} 應拒貼，不可把範例誤貼成零發現`);
        assert.equal(scanMetaAfter.postedAt, undefined, `${scanLabel} 拒貼時不可寫入 postedAt`);
      } else {
        assert.ok(sentScanBody && sentScanBody.startsWith(`🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\``), `${scanLabel} 正常正式掃描輸出應完成代貼`);
        assert.match(sentScanBody, /\n> 掃描時序：依據複審留言 /u, `${scanLabel} 代貼應補上掃描時序`);
        assert.ok(typeof scanMetaAfter.postedAt === 'string', `${scanLabel} 成功代貼時寫入 postedAt`);
      }
      assert.equal(main(['--scan-close', '7', '--dir', scanCaseDir], { settings: sScanCase }).code, 0, `${scanLabel} --scan-close`);
    }

    // 前言若含真實憑證針（NEW-KEY-SECRET-3333），DLP 直接攔截並退 2
    const dlpOut = path.join(tmp, 'dlp-out.md');
    const dlpRun = await runGrokExec([
      '--mode', 'scan',
      '--cwd', r.dir,
      '--model', 'grok-4.7',
      '--reasoning-effort', 'xhigh',
      '--prompt-file', promptFile,
      '--out', dlpOut,
    ], {
      authFile,
      authOpts: { now: () => Date.parse('2026-10-19T00:05:00.000Z') },
      probeFn: () => ({ ok: true }),
      spawnGrok: async () => ({
        status: 0,
        stdout: '前言洩漏 NEW-KEY-SECRET-3333\n🔍 Grok｜來源：Grok CLI｜掃 `1234567`\n- 零發現\n',
        stderr: '',
      }),
    });
    assert.equal(dlpRun.code, 2, '前言含憑證針必須被 DLP 攔截');
    assert.equal(fs.existsSync(dlpOut), false);

    // (e) 盒內若改動 .git/config（如寫入 core.fsmonitor），盒外收尾絕不執行該腳本且退 2 拒寫輸出（r5 R1 路徑 A）
    const marker = path.join(tmp, 'outside-box-marker.txt');
    const badOut = path.join(tmp, 'bad-out.md');
    const fsmonitorRun = await runGrokExec([
      '--mode', 'scan',
      '--cwd', r.dir,
      '--model', 'grok-4.7',
      '--reasoning-effort', 'xhigh',
      '--prompt-file', promptFile,
      '--out', badOut,
    ], {
      authFile,
      authOpts: { now: () => Date.parse('2026-10-19T00:05:00.000Z') },
      probeFn: () => ({ ok: true }),
      spawnGrok: async ({ boxWorktree }) => {
        const hook = path.join(boxWorktree, '.git', 'r5-fsmonitor.sh');
        fs.writeFileSync(hook, `#!/bin/sh\nprintf 'SYNTHETIC-HOST-EXECUTION' > '${marker}'\nprintf 'token\\000'\n`, { mode: 0o700 });
        sh(boxWorktree, 'config', 'core.fsmonitor', hook);
        return { status: 0, stdout: '🔍 Grok｜來源：Grok CLI｜掃 `1234567`\n- 零發現\n', stderr: '' };
      },
    });
    assert.equal(fs.existsSync(marker), false, '盒外收尾絕不可執行盒內 .git/config 的 core.fsmonitor');
    assert.equal(fsmonitorRun.code, 2);
    assert.equal(fs.existsSync(badOut), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('⑭一鍵執行（--run）與收樹清除容器（--purge）：複審與掃描一鍵開樹→執行→驗樹代貼→收樹（含 --purge），任一步失敗即停並保留現場供查', async () => {
  const r = repo();
  const dir = tmp('review-launch-run-');
  const scannerCfg = {
    participant: 'Gamma',
    launch: '由掃描發射者執行 tools/review-launch.js --scan',
    assignedBy: '專案設定',
    tieBreaker: '由實作者發起',
    fallback: '未執行：<原因>',
    strongest: 'grok-strong',
    maxEffort: 'xhigh',
    source: 'Grok CLI',
    command: 'grok --cwd {scanTree} --model {model} --reasoning-effort {effort} --prompt-file {promptFile} > {outFile}',
  };
  const s = settingsFor({
    participants: [
      ...settingsFor().participants,
      { role: 'AI 丙', id: 'Gamma', account: 'ai-acct' },
    ],
    owner: 'Boss',
    scanner: scannerCfg,
  });
  const baseAns = answersFor(r);

  // (a) defaultRunExec：清 GIT_* 與 clearEnv、以 record.root 為工作目錄執行 shell 指令，非零退出丟 LaunchError
  const envOut = path.join(dir, 'exec-env.json');
  const savedGit = process.env.GIT_DIR;
  const savedCustom = process.env.SECRET_EXEC_TOKEN;
  try {
    process.env.GIT_DIR = '/decoy/git';
    process.env.SECRET_EXEC_TOKEN = 'secret';
    defaultRunExec(
      `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ cwd: process.cwd(), git: Object.keys(process.env).filter((k) => k.startsWith("GIT_")), token: process.env.SECRET_EXEC_TOKEN || null }))' ${JSON.stringify(envOut)}`,
      { record: { root: r.dir }, clearEnv: ['SECRET_EXEC_TOKEN'] },
    );
    const gotEnv = JSON.parse(fs.readFileSync(envOut, 'utf8'));
    assert.equal(fs.realpathSync(gotEnv.cwd), fs.realpathSync(r.dir));
    assert.deepEqual(gotEnv.git, []);
    assert.equal(gotEnv.token, null);
    assert.throws(
      () => defaultRunExec(`${JSON.stringify(process.execPath)} -e 'console.error("exec boom"); process.exit(5)'`, { record: { root: r.dir } }),
      /啟動指令退 5：exec boom/u,
    );
  } finally {
    if (savedGit === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGit;
    if (savedCustom === undefined) delete process.env.SECRET_EXEC_TOKEN; else process.env.SECRET_EXEC_TOKEN = savedCustom;
    fs.rmSync(envOut, { force: true });
  }

  try {
    // (b) 複審 --run：啟動指令失敗 → 退 1、不呼叫 runPost、保留審查樹與容器供查
    let postCalls = 0;
    const failExecRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(baseAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec() { throw new (require('../tools/review-launch.js').LaunchError)('啟動指令退 7：模擬失敗'); },
      runPost() { postCalls += 1; },
    });
    assert.equal(failExecRes.code, 1);
    assert.match(failExecRes.lines.join('\n'), /執行複審啟動指令失敗.*未代貼、未收樹/u);
    assert.equal(postCalls, 0);
    const reviewFolder = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r1');
    assert.ok(fs.existsSync(path.join(reviewFolder, 'tree')), '啟動失敗時審查樹應留著供查');

    // 先收樹（不帶 --purge），再補跑 --close 7 --purge 驗證已收樹的容器也能一併清除
    assert.equal(main(['--close', '7', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);
    assert.ok(fs.existsSync(reviewFolder), '未帶 --purge 時容器仍留著');
    const latePurge = main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] });
    assert.equal(latePurge.code, 0, latePurge.lines.join('\n'));
    assert.match(latePurge.lines.join('\n'), /已清除變更 7 已收樹的審查資料夾：review-acme-kit-7-r1/u);
    assert.ok(!fs.existsSync(reviewFolder), '補跑 --close --purge 後容器已清除');

    // (c) 複審 --run --purge 正常完成：一鍵開樹→執行→代貼→收樹並清除容器
    let postedReviewBody = null;
    const okReviewRun = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(baseAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        fs.writeFileSync(
          record.outFile,
          `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
        );
      },
      runPost(_cmd, args) {
        postCalls += 1;
        postedReviewBody = fs.readFileSync(args.at(-1), 'utf8');
      },
    });
    assert.equal(okReviewRun.code, 0, okReviewRun.lines.join('\n'));
    assert.equal(postCalls, 1);
    assert.match(postedReviewBody, /^🤖 Beta｜來源：beta CLI｜審 `/u);
    assert.ok(!fs.existsSync(reviewFolder), '複審 --run --purge 成功後審查容器已自動清除');

    // (d) 掃描 --scan --run --purge 正常完成：一鍵開掃描樹→執行→代貼 🔍 留言→收樹並清除容器
    const passComment = verdict('Beta', 1, r.head, '通過', { id: 'pass-run', createdAt: '2026-10-19T12:00:00Z' });
    const withPass = { ...baseAns, comments: [passComment] };
    let scanPostCalls = 0;
    let postedScanBody = null;
    const okScanRun = main(['--scan', '7', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      cwd: r.dir,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        fs.writeFileSync(
          record.outFile,
          `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
        );
      },
      runPost(_cmd, args) {
        scanPostCalls += 1;
        postedScanBody = fs.readFileSync(args.at(-1), 'utf8');
      },
    });
    assert.equal(okScanRun.code, 0, okScanRun.lines.join('\n'));
    assert.equal(scanPostCalls, 1);
    assert.match(postedScanBody, /^🔍 Gamma｜來源：Grok CLI｜掃 `/u);
    assert.match(postedScanBody, /\n> 掃描時序：依據複審留言 /u);
    const scanFolder = path.join(fs.realpathSync(dir), 'scan-acme-kit-7');
    assert.ok(!fs.existsSync(scanFolder), '掃描 --scan --run --purge 成功後掃描容器已自動清除');

    // (e) R2：複審 --run --purge 自行貼文成功路徑（含輸出檔同正文、輸出檔僅寫摘要連結，以及矛盾／重複留言拒收）
    let selfPostCalls = 0;
    const dynamicComments = [];
    const selfPostAns = {
      ...baseAns,
      comments: () => [...dynamicComments],
    };
    const validSelfVerdict = `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n`;
    const selfPostedSameOut = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        dynamicComments.push({ id: 'self-1', author: 'ai-acct', createdAt: '2026-10-20T00:00:00Z', body: validSelfVerdict });
        fs.writeFileSync(record.outFile, validSelfVerdict);
      },
      runPost() { selfPostCalls += 1; },
    });
    assert.equal(selfPostedSameOut.code, 0, selfPostedSameOut.lines.join('\n'));
    assert.equal(selfPostCalls, 0, '自行貼文成功時外殼不重複呼叫 runPost');
    assert.match(selfPostedSameOut.lines.join('\n'), /已確認複審者自行貼出 r1 結論.*（不重複代貼）/u);
    assert.ok(!fs.existsSync(reviewFolder), '自行貼文成功後 --run --purge 已正常收樹並清除容器');

    // 自行貼文成功且輸出檔只寫簡短回報／摘要（不含 🤖 標頭）
    dynamicComments.length = 0;
    const selfPostedSummaryOut = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        dynamicComments.push({
          id: 'self-2',
          author: 'ai-acct',
          createdAt: '2026-10-20T00:00:00Z',
          body: `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：需修改後再審\n\n- R1\n`,
        });
        fs.writeFileSync(record.outFile, '已貼：#7 r1（詳見 PR 留言）\n');
      },
      runPost() { selfPostCalls += 1; },
    });
    assert.equal(selfPostedSummaryOut.code, 0, selfPostedSummaryOut.lines.join('\n'));
    assert.equal(selfPostCalls, 0);
    assert.ok(!fs.existsSync(reviewFolder), '自行貼文且輸出摘要時 --run --purge 亦正常收樹並清除容器');

    // 自行貼文但輸出檔寫了矛盾的 🤖 結論 → 退 2、不收樹、保留容器
    dynamicComments.length = 0;
    const conflictOut = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        dynamicComments.push({ id: 'self-3', author: 'ai-acct', createdAt: '2026-10-20T00:00:00Z', body: validSelfVerdict });
        fs.writeFileSync(record.outFile, `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：需修改後再審\n\n- R1\n`);
      },
      runPost() { selfPostCalls += 1; },
    });
    assert.equal(conflictOut.code, 2);
    assert.match(conflictOut.lines.join('\n'), /輸出檔的 r1 結論與平台上已貼出的結論內容不一致/u);
    assert.ok(fs.existsSync(path.join(reviewFolder, 'tree')), '結論矛盾時應保留審查樹供查');
    assert.equal(main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);

    // 自行貼出重複同輪留言 → 退 2、不收樹
    dynamicComments.length = 0;
    const dupOut = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        dynamicComments.push(
          { id: 'self-4a', author: 'ai-acct', createdAt: '2026-10-20T00:00:00Z', body: validSelfVerdict },
          { id: 'self-4b', author: 'ai-acct', createdAt: '2026-10-20T00:00:01Z', body: validSelfVerdict },
        );
        fs.writeFileSync(record.outFile, validSelfVerdict);
      },
      runPost() { selfPostCalls += 1; },
    });
    assert.equal(dupOut.code, 2);
    assert.match(dupOut.lines.join('\n'), /重複或衝突，不自動收尾/u);
    assert.equal(main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);

    // 歷史有壞標頭但已被後續留言正式寫「作廢上一則：<id>」→ 自行貼文仍能正常收尾（r2 R2）；未作廢壞標頭則拒收
    dynamicComments.length = 0;
    dynamicComments.push(
      { id: 'bad-0', author: 'ai-acct', createdAt: '2026-10-19T23:50:00Z', body: '🤖 Beta｜審 `deadbee`｜r1｜結論：通過（缺來源欄壞標頭）\n' },
      {
        id: 'voided-1',
        author: 'ai-acct',
        createdAt: '2026-10-19T23:55:00Z',
        body: `🤖 Beta｜來源：beta CLI｜審 \`${r.base.slice(0, 7)}\`｜r1｜結論：需修改後再審\n作廢上一則：bad-0\n\n- R1\n`,
      },
    );
    const voidedHistoryOut = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        dynamicComments.push({
          id: 'self-r2-ok',
          author: 'ai-acct',
          createdAt: '2026-10-20T00:05:00Z',
          body: `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r2｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n`,
        });
        fs.writeFileSync(record.outFile, '已貼：#7 r2（詳見 PR 留言）\n');
      },
      runPost() { selfPostCalls += 1; },
    });
    assert.equal(voidedHistoryOut.code, 0, voidedHistoryOut.lines.join('\n'));
    assert.equal(selfPostCalls, 0);
    assert.match(voidedHistoryOut.lines.join('\n'), /已確認複審者自行貼出 r2 結論.*（不重複代貼）/u);
    assert.ok(!fs.existsSync( path.join(fs.realpathSync(dir), 'review-acme-kit-7-r2')), '歷史壞標頭已作廢時 r2 --run --purge 正常收尾清除容器');

    dynamicComments.length = 0;
    dynamicComments.push(
      { id: 'bad-unvoided', author: 'ai-acct', createdAt: '2026-10-19T23:50:00Z', body: '🤖 Beta｜審 `deadbee`｜r1｜結論：通過（未作廢壞標頭）\n' },
    );
    const unvoidedBadOut = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        dynamicComments.push({ id: 'self-with-unvoided', author: 'ai-acct', createdAt: '2026-10-20T00:05:00Z', body: validSelfVerdict });
        fs.writeFileSync(record.outFile, '已貼：#7 r1\n');
      },
      runPost() { selfPostCalls += 1; },
    });
    assert.equal(unvoidedBadOut.code, 2);
    assert.match(unvoidedBadOut.lines.join('\n'), /未作廢的壞標頭 🤖 留言.*不自動收尾/u);
    assert.equal(main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);

    // CLI JSON 輸出包裹（如 Claude --output-format json）：自行貼文成功且 JSON result 含同一份完整結論或摘要時 --run --purge 正常收尾；矛盾或 is_error 則退 2（r3 R2）
    dynamicComments.length = 0;
    const jsonSelfSameOut = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        dynamicComments.push({ id: 'self-json-1', author: 'ai-acct', createdAt: '2026-10-20T00:10:00Z', body: validSelfVerdict });
        fs.writeFileSync(record.outFile, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: validSelfVerdict }));
      },
      runPost() { selfPostCalls += 1; },
    });
    assert.equal(jsonSelfSameOut.code, 0, jsonSelfSameOut.lines.join('\n'));
    assert.equal(selfPostCalls, 0);
    assert.ok(!fs.existsSync(reviewFolder), 'JSON 包裹同正文自貼成功後 --run --purge 已正常收樹並清除容器');

    dynamicComments.length = 0;
    const jsonSelfConflictOut = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        dynamicComments.push({ id: 'self-json-conflict', author: 'ai-acct', createdAt: '2026-10-20T00:10:00Z', body: validSelfVerdict });
        fs.writeFileSync(
          record.outFile,
          JSON.stringify([{ type: 'system' }, { type: 'result', subtype: 'success', is_error: false, result: `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：需修改後再審\n\n- R1\n` }]),
        );
      },
      runPost() { selfPostCalls += 1; },
    });
    assert.equal(jsonSelfConflictOut.code, 2);
    assert.match(jsonSelfConflictOut.lines.join('\n'), /輸出檔的 r1 結論與平台上已貼出的結論內容不一致/u);
    assert.equal(main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);

    // r3 R1：r1 的 --run --purge 在代貼期間（r1 結論已在平台可見），另一程序正式開出 r2 並寫入唯一輸出；r1 收尾只關 r1，r2 的樹、Git 登記與唯一輸出逐字保留
    dynamicComments.length = 0;
    const r2Folder = path.join(fs.realpathSync(dir), 'review-acme-kit-7-r2');
    let r2LaunchRes = null;
    const r1RunWithConcurrentR2 = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(selfPostAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        fs.writeFileSync(
          record.outFile,
          `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：需修改後再審\n\n- R1\n未貼\n`,
        );
      },
      runPost(_cmd, args) {
        const body = fs.readFileSync(args.at(-1), 'utf8');
        dynamicComments.push({ id: 'r1-posted', author: 'ai-acct', createdAt: '2026-10-20T00:20:00Z', body });
        r2LaunchRes = launch('7', 'Beta', { settings: s, platform: fakePlatform(selfPostAns), cwd: r.dir, dir, template: TEMPLATE });
        fs.writeFileSync(path.join(r2Folder, 'output.log'), 'R2 專屬唯一合成輸出\n');
      },
    });
    assert.equal(r1RunWithConcurrentR2.code, 0, r1RunWithConcurrentR2.lines.join('\n'));
    assert.equal(r2LaunchRes && r2LaunchRes.code, 0, r2LaunchRes ? r2LaunchRes.lines.join('\n') : 'r2 launch did not run');
    assert.ok(!fs.existsSync(reviewFolder), 'r1 自身的容器已收樹並清除');
    assert.ok(fs.existsSync(path.join(r2Folder, 'tree')), 'r2 的審查樹保留');
    assert.ok(fs.existsSync(path.join(r2Folder, 'mutation')), 'r2 的突變副本保留');
    assert.equal(fs.readFileSync(path.join(r2Folder, 'output.log'), 'utf8'), 'R2 專屬唯一合成輸出\n', 'r2 的唯一輸出逐字保留');
    const wtListAfterR1 = sh(r.dir, 'worktree', 'list', '--porcelain');
    assert.ok(wtListAfterR1.includes(path.join(r2Folder, 'tree')), 'r2 審查樹的 Git 工作樹登記仍在');
    assert.ok(wtListAfterR1.includes(path.join(r2Folder, 'mutation')), 'r2 突變副本的 Git 工作樹登記仍在');
    assert.equal(main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);
    assert.ok(!fs.existsSync(r2Folder));

    // (f) R1：替換已收樹掃描容器與代貼／容器鎖協同的確定性交錯考題
    // 交錯 1：A 已通過進鎖前的 canReplaceClosedScan 初檢、正要寫入容器鎖檔時，B 先完成替換並寫入 output.log；A 進鎖後靠鎖內 canReplaceClosedScan 重驗退 2、不刪 B
    assert.equal(main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), cwd: r.dir }).code, 0);
    assert.equal(main(['--scan-close', '7', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);
    const realWriteFileSync = fs.writeFileSync;
    const scanContainerLockPath = path.join(fs.realpathSync(dir), '.scan-acme-kit-7.lock');
    let bRes1 = null;
    let hookedLockWrite = false;
    try {
      fs.writeFileSync = (p, data, ...rest) => {
        if (!hookedLockWrite && String(p) === scanContainerLockPath) {
          hookedLockWrite = true;
          bRes1 = main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), cwd: r.dir });
          realWriteFileSync(path.join(scanFolder, 'output.log'), 'B 先完成替換的唯一合成值\n');
        }
        return realWriteFileSync(p, data, ...rest);
      };
      const aRes1 = main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), cwd: r.dir });
      fs.writeFileSync = realWriteFileSync;
      assert.equal(bRes1 && bRes1.code, 0, bRes1 ? bRes1.lines.join('\n') : 'B did not run');
      assert.equal(aRes1.code, 2, aRes1.lines.join('\n'));
      assert.match(aRes1.lines.join('\n'), /已經在了/u);
      assert.equal(fs.readFileSync(path.join(scanFolder, 'output.log'), 'utf8'), 'B 先完成替換的唯一合成值\n', 'B 的輸出逐字保留');
      assert.ok(fs.existsSync(path.join(scanFolder, 'tree')), 'B 的掃描樹仍在');
      assert.ok(sh(r.dir, 'worktree', 'list', '--porcelain').includes(path.join(scanFolder, 'tree')), 'B 的 Git 工作樹登記一致');
    } finally {
      fs.writeFileSync = realWriteFileSync;
    }

    // 交錯 2：A 已取得容器鎖準備刪除舊容器時，B 並發呼叫 --scan → B 立即退 2，A 完成建立並保留新樹與輸出
    assert.equal(main(['--scan-close', '7', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);
    const realRmSync = fs.rmSync;
    let bRes2 = null;
    let hookedRm = false;
    try {
      fs.rmSync = (target, opts) => {
        if (!hookedRm && String(target) === scanFolder) {
          hookedRm = true;
          bRes2 = main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), cwd: r.dir });
        }
        return realRmSync(target, opts);
      };
      const aRes2 = main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), cwd: r.dir });
      fs.rmSync = realRmSync;
      assert.equal(aRes2.code, 0, aRes2.lines.join('\n'));
      assert.equal(bRes2 && bRes2.code, 2, bRes2 ? bRes2.lines.join('\n') : 'B did not run');
      assert.match(bRes2.lines.join('\n'), /已經在了：另一個掃描剛好在開同一支/u);
      fs.writeFileSync(path.join(scanFolder, 'output.log'), 'A 鎖內建立的唯一合成值\n');
      assert.equal(fs.readFileSync(path.join(scanFolder, 'output.log'), 'utf8'), 'A 鎖內建立的唯一合成值\n');
      assert.ok(fs.existsSync(path.join(scanFolder, 'tree')), 'A 的掃描樹仍在');
    } finally {
      fs.rmSync = realRmSync;
    }

    // 交錯 3（r2 R1）：A 正在執行 --scan-post 的 runPost（持有 post.lock）時，B 嘗試 --scan-close --purge 或重跑 --scan 皆立即退 2，不可刪樹或覆寫 scan.json
    fs.writeFileSync(
      path.join(scanFolder, 'output.log'),
      `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
    );
    let midCloseRes = null;
    let midLaunchRes = null;
    const scanPostInterleaved = main(['--scan-post', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      runPost() {
        midCloseRes = main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] });
        midLaunchRes = main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), cwd: r.dir });
      },
    });
    assert.equal(scanPostInterleaved.code, 0, scanPostInterleaved.lines.join('\n'));
    assert.equal(midCloseRes && midCloseRes.code, 2, midCloseRes ? midCloseRes.lines.join('\n') : 'midClose did not run');
    assert.match(midCloseRes.lines.join('\n'), /正在被另一個程序操作/u);
    assert.equal(midLaunchRes && midLaunchRes.code, 2, midLaunchRes ? midLaunchRes.lines.join('\n') : 'midLaunch did not run');
    assert.match(midLaunchRes.lines.join('\n'), /已經在了/u);
    const finalScanJson = JSON.parse(fs.readFileSync(path.join(scanFolder, 'scan.json'), 'utf8'));
    assert.ok(typeof finalScanJson.postedAt === 'string', 'A 完成代貼後 scan.json 正常寫入 postedAt');
    assert.equal(finalScanJson.closedAt, undefined, 'B 的並發 close --purge 被擋下、未寫入 closedAt');

    // 交錯 4（容器操作已持鎖→代貼後到）：先將 scan.json 改回未貼狀態，確認 A 在 --scan-close 持有容器鎖期間，B 呼叫 --scan-post 是因容器鎖退 2（而非已貼過）
    delete finalScanJson.postedAt;
    fs.writeFileSync(path.join(scanFolder, 'scan.json'), `${JSON.stringify(finalScanJson, null, 2)}\n`);
    let latePostDuringClose = null;
    const closeWithLatePost = scanClose('7', {
      settings: s,
      dir,
      leftoverRoots: [],
      purge: true,
      remove(root, t) {
        latePostDuringClose = main(['--scan-post', '7', '--dir', dir], {
          settings: s,
          platform: fakePlatform(withPass),
          runPost() {},
        });
        return spawnSync('git', ['worktree', 'remove', t], { cwd: root, env: gitEnv(), encoding: 'utf8' }).status === 0 ? null : 'remove fail';
      },
    });
    assert.equal(closeWithLatePost.code, 0, closeWithLatePost.lines.join('\n'));
    assert.equal(latePostDuringClose && latePostDuringClose.code, 2, latePostDuringClose ? latePostDuringClose.lines.join('\n') : 'latePost did not run');
    assert.match(latePostDuringClose.lines.join('\n'), /正在被另一個程序操作/u);
    assert.ok(!fs.existsSync(scanFolder));

    // (g) r4 R1：平台正規化編號（例如輸入 '007'、平台回 id: '7'）時，複審與掃描的 --run --purge 全程沿用正規化編號，不會找錯容器
    const normReviewRes = main(['007', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(baseAns),
      cwd: r.dir,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        fs.writeFileSync(
          record.outFile,
          `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
        );
      },
      runPost() {},
    });
    assert.equal(normReviewRes.code, 0, normReviewRes.lines.join('\n'));
    assert.ok(!fs.existsSync(reviewFolder), '前導零編號 007 經正規化為 7 後，複審一鍵執行與收樹清除成功');

    const normScanRes = main(['--scan', '007', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      cwd: r.dir,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        fs.writeFileSync(
          record.outFile,
          `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
        );
      },
      runPost() {},
    });
    assert.equal(normScanRes.code, 0, normScanRes.lines.join('\n'));
    assert.ok(!fs.existsSync(scanFolder), '前導零編號 007 經正規化為 7 後，掃描一鍵執行與收樹清除成功');

    // (h) r4 R2 與 r5 R1：--run 已完成代貼，但收尾 close / scanClose 拋 LaunchError（如容器鎖被占）時，必須保留已開樹與已貼出訊息、明確回報「已貼，收尾失敗——沒有收」並給出帶本輪身分限制的重跑指令；即使後來已開出新一輪並有唯一輸出，照提示重跑也只收舊輪、不誤傷新輪
    for (const badFlags of [
      ['7', '--reviewer', 'Beta', '--round', '1'],
      ['--close', '7', '--round', '0'],
      ['--close', '7', '--round', 'abc'],
      ['7', '--reviewer', 'Beta', '--expect-head', '1234567'],
      ['--close', '7', '--expect-head', 'xyz'],
      ['7', '--reviewer', 'Beta', '--expect-started-at', '2026-10-20T00:00:00.000Z'],
      ['--close', '7', '--expect-started-at', 'not-a-date'],
    ]) {
      assert.equal(main(badFlags, { settings: s }).code, 2, `應拒收壞旗標組合：${badFlags.join(' ')}`);
    }

    const revLockPath = path.join(fs.realpathSync(dir), '.review-acme-kit-7-r1.lock');
    let revCloseFailPostCalls = 0;
    let revOutTxt = '';
    try {
      const revRunCloseFail = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
        settings: s,
        platform: fakePlatform(baseAns),
        cwd: r.dir,
        template: TEMPLATE,
        leftoverRoots: [],
        runExec(_cmd, { record }) {
          fs.writeFileSync(
            record.outFile,
            `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
          );
        },
        runPost() {
          revCloseFailPostCalls += 1;
          // 模擬代貼完成後、進入 close 前，容器鎖被另一程序持有
          fs.writeFileSync(revLockPath, '999999\n');
        },
      });
      assert.equal(revRunCloseFail.code, 2, revRunCloseFail.lines.join('\n'));
      assert.equal(revCloseFailPostCalls, 1, '代貼確實已執行一次');
      revOutTxt = revRunCloseFail.lines.join('\n');
      assert.match(revOutTxt, /送審產生器｜變更 7｜複審者 Beta/u, '保留啟動成功輸出');
      assert.match(revOutTxt, /已代貼 r1 結論｜變更 7/u, '保留已貼出結論輸出');
      assert.match(revOutTxt, /送審產生器：已貼，收尾失敗.*沒有收/u, '明確回報已貼但收尾失敗，不誤報「沒有產生」');
      assert.doesNotMatch(revOutTxt, /沒有產生/u, '不誤報沒有產生');
      const revRecAfterFail = JSON.parse(fs.readFileSync(path.join(reviewFolder, 'launch.json'), 'utf8'));
      assert.ok(typeof revRecAfterFail.postedAt === 'string', 'launch.json 已記下 postedAt');
      assert.equal(revRecAfterFail.closedAt, undefined, '收尾失敗時未寫入 closedAt');
      assert.ok(fs.existsSync(path.join(reviewFolder, 'tree')), '工作樹仍留在現場供補跑 --close');
    } finally {
      fs.rmSync(revLockPath, { force: true });
    }
    // 測試 close 與 post 的 expectHead / expectStartedAt 防呆：傳入不符的 expectHead 或 expectStartedAt 應拒收、不誤動後來的容器
    assert.throws(() => post('7', { settings: s, dir, expectHead: 'deadbeef' }), /不是本次啟動的/u);
    assert.throws(() => post('7', { settings: s, dir, expectStartedAt: '1999-01-01T00:00:00.000Z' }), /不是本次啟動的/u);
    const mismatchRevHead = close('7', { settings: s, dir, leftoverRoots: [], purge: true, expectRound: 1, expectHead: 'deadbeef' });
    assert.equal(mismatchRevHead.code, 1);
    assert.match(mismatchRevHead.lines.join('\n'), /不符/u);
    const mismatchRevStart = close('7', { settings: s, dir, leftoverRoots: [], purge: true, expectRound: 1, expectStartedAt: '1999-01-01T00:00:00.000Z' });
    assert.equal(mismatchRevStart.code, 1);
    assert.match(mismatchRevStart.lines.join('\n'), /不符/u);
    assert.ok(fs.existsSync(path.join(reviewFolder, 'tree')), '不符時複審樹分毫未動');

    // r5 R1（複審）：r1 收尾失敗解除鎖後，先開出 r2 並寫入唯一輸出 R5_ONLY_RESULT_871，再照 r1 錯誤訊息印出的恢復指令重跑 → 只收 r1，r2 的兩棵樹、Git 登記與唯一輸出逐字保留
    const r1PassForR2 = verdict('Beta', 1, r.head, '需修改後再審', { id: 'r1-for-r5', createdAt: '2026-10-20T01:00:00Z' });
    const r2LaunchAfterR1Fail = launch('7', 'Beta', {
      settings: s,
      platform: fakePlatform({ ...baseAns, comments: [r1PassForR2] }),
      cwd: r.dir,
      dir,
      template: TEMPLATE,
    });
    assert.equal(r2LaunchAfterR1Fail.code, 0, r2LaunchAfterR1Fail.lines.join('\n'));
    fs.writeFileSync(path.join(r2Folder, 'output.log'), 'R5_ONLY_RESULT_871\n');
    const revRetryMatch = /可重跑 node tools\/review-launch\.js ([^）。]+)）/u.exec(revOutTxt);
    assert.ok(revRetryMatch, `應從錯誤訊息擷取恢復指令：${revOutTxt}`);
    const revRetryArgs = revRetryMatch[1].trim().split(/\s+/u);
    const revRetryRes = main(revRetryArgs, { settings: s, leftoverRoots: [] });
    assert.equal(revRetryRes.code, 0, revRetryRes.lines.join('\n'));
    assert.ok(!fs.existsSync(reviewFolder), '照恢復指令重跑後 r1 審查容器已收樹並清除');
    assert.ok(fs.existsSync(path.join(r2Folder, 'tree')), 'r2 審查樹保留');
    assert.ok(fs.existsSync(path.join(r2Folder, 'mutation')), 'r2 突變副本保留');
    assert.equal(fs.readFileSync(path.join(r2Folder, 'output.log'), 'utf8'), 'R5_ONLY_RESULT_871\n', 'r2 唯一輸出逐字保留');
    const wtListAfterRevRetry = sh(r.dir, 'worktree', 'list', '--porcelain');
    assert.ok(wtListAfterRevRetry.includes(path.join(r2Folder, 'tree')), 'r2 審查樹 Git 登記仍在');
    assert.ok(wtListAfterRevRetry.includes(path.join(r2Folder, 'mutation')), 'r2 突變副本 Git 登記仍在');
    assert.equal(main(['--close', '7', '--round', '2', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);
    assert.ok(!fs.existsSync(r2Folder));

    let scanCloseFailPostCalls = 0;
    let scanOutTxt = '';
    try {
      const scanRunCloseFail = main(['--scan', '7', '--run', '--purge', '--dir', dir], {
        settings: s,
        platform: fakePlatform(withPass),
        cwd: r.dir,
        leftoverRoots: [],
        now: () => new Date('2026-10-20T02:00:00.000Z'),
        runExec(_cmd, { record }) {
          fs.writeFileSync(
            record.outFile,
            `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
          );
        },
        runPost() {
          scanCloseFailPostCalls += 1;
          fs.writeFileSync(scanContainerLockPath, '999999\n');
        },
      });
      assert.equal(scanRunCloseFail.code, 2, scanRunCloseFail.lines.join('\n'));
      assert.equal(scanCloseFailPostCalls, 1, '掃描代貼確實已執行一次');
      scanOutTxt = scanRunCloseFail.lines.join('\n');
      assert.match(scanOutTxt, /掃描準備｜變更 7｜掃描者 Gamma/u, '保留掃描啟動成功輸出');
      assert.match(scanOutTxt, /已代貼掃描留言｜變更 7/u, '保留掃描已貼出輸出');
      assert.match(scanOutTxt, /送審產生器：已貼，收尾失敗.*沒有收/u, '明確回報掃描已貼但收尾失敗');
      assert.doesNotMatch(scanOutTxt, /沒有產生/u, '不誤報沒有產生');
      const scanRecAfterFail = JSON.parse(fs.readFileSync(path.join(scanFolder, 'scan.json'), 'utf8'));
      assert.ok(typeof scanRecAfterFail.postedAt === 'string', 'scan.json 已記下 postedAt');
      assert.equal(scanRecAfterFail.closedAt, undefined, '收尾失敗時未寫入 closedAt');
      assert.ok(fs.existsSync(path.join(scanFolder, 'tree')), '掃描樹仍留在現場供補跑 --scan-close');
    } finally {
      fs.rmSync(scanContainerLockPath, { force: true });
    }
    // 測試 scanClose 與 scanPost 的 expectHead / expectStartedAt 防呆：傳入不符的 expectHead 或 expectStartedAt 應拒收、不誤動後來的掃描容器
    assert.throws(() => scanPost('7', { settings: s, dir, expectHead: 'deadbeef' }), /不是本次啟動的/u);
    assert.throws(() => scanPost('7', { settings: s, dir, expectStartedAt: '1999-01-01T00:00:00.000Z' }), /不是本次啟動的/u);
    const mismatchScanHead = scanClose('7', { settings: s, dir, leftoverRoots: [], purge: true, expectHead: 'deadbeef' });
    assert.equal(mismatchScanHead.code, 1);
    assert.match(mismatchScanHead.lines.join('\n'), /不符/u);
    const mismatchScanStart = scanClose('7', { settings: s, dir, leftoverRoots: [], purge: true, expectStartedAt: '1999-01-01T00:00:00.000Z' });
    assert.equal(mismatchScanStart.code, 1);
    assert.match(mismatchScanStart.lines.join('\n'), /不符/u);
    assert.ok(fs.existsSync(path.join(scanFolder, 'tree')), '不符時掃描樹分毫未動');

    // r5 R1（掃描）：擷取舊掃描失敗的恢復指令；若舊掃描已收樹且新掃描已替換容器並寫入唯一輸出，再執行舊恢復指令應退 1、保留新掃描樹與唯一輸出
    const scanRetryMatch = /可重跑 node tools\/review-launch\.js ([^）。]+)）/u.exec(scanOutTxt);
    assert.ok(scanRetryMatch, `應從掃描錯誤訊息擷取恢復指令：${scanOutTxt}`);
    const scanRetryArgs = scanRetryMatch[1].trim().split(/\s+/u);
    assert.equal(main(['--scan-close', '7', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);
    // 重置 postedAt 模擬可替換狀態並啟動新一次掃描（startedAt 為 03:00）
    const oldScanRec = JSON.parse(fs.readFileSync(path.join(scanFolder, 'scan.json'), 'utf8'));
    delete oldScanRec.postedAt;
    fs.writeFileSync(path.join(scanFolder, 'scan.json'), `${JSON.stringify(oldScanRec, null, 2)}\n`);
    assert.equal(main(['--scan', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      cwd: r.dir,
      now: () => new Date('2026-10-20T03:00:00.000Z'),
    }).code, 0);
    fs.writeFileSync(path.join(scanFolder, 'output.log'), 'R5_SCAN2_ONLY_RESULT\n');
    const staleScanRetryRes = main(scanRetryArgs, { settings: s, leftoverRoots: [] });
    assert.equal(staleScanRetryRes.code, 1, staleScanRetryRes.lines.join('\n'));
    assert.match(staleScanRetryRes.lines.join('\n'), /不符/u);
    assert.ok(fs.existsSync(path.join(scanFolder, 'tree')), '新掃描樹保留');
    assert.equal(fs.readFileSync(path.join(scanFolder, 'output.log'), 'utf8'), 'R5_SCAN2_ONLY_RESULT\n', '新掃描唯一輸出逐字保留');
    assert.ok(sh(r.dir, 'worktree', 'list', '--porcelain').includes(path.join(scanFolder, 'tree')), '新掃描樹 Git 登記仍在');

    // (i) r5 R2（交錯 5）：收樹者已讀到「沒有 post.lock」之後，舊代貼程序才在舊容器內建好 post.lock 並暫停在取得外層容器鎖之前；
    //     接著舊容器被清除、新容器重建、新代貼程序取得新鎖進入 runPost；此時讓舊代貼程序恢復，舊程序必須退 2、零送出，且不得刪掉新代貼程序持有的 post.lock 與容器鎖
    const raceCoord = tmp('review-launch-r5-r2-');
    const oldCreatedLockMarker = path.join(raceCoord, 'old-created-lock');
    const resumeOldMarker = path.join(raceCoord, 'resume-old');
    const oldDoneFile = path.join(raceCoord, 'old-done.json');
    fs.writeFileSync(
      path.join(scanFolder, 'output.log'),
      `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- old-proc\n\n### 掃描結果\n- 零發現\n未貼\n`,
    );
    const oldWorkerScript = `
      const fs = require('node:fs');
      const path = require('node:path');
      const cfg = JSON.parse(process.argv[1]);
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const origWrite = fs.writeFileSync;
      let hooked = false;
      fs.writeFileSync = function patchedWrite(p, data, ...rest) {
        const res = origWrite.call(this, p, data, ...rest);
        if (!hooked && String(p).endsWith(path.sep + 'post.lock')) {
          hooked = true;
          origWrite.call(this, cfg.oldCreatedLockMarker, '1');
          const deadline = Date.now() + 10000;
          while (!fs.existsSync(cfg.resumeOldMarker)) {
            if (Date.now() > deadline) throw new Error('timeout waiting for resumeOldMarker');
            sleep(10);
          }
        }
        return res;
      };
      const { main } = require(cfg.modulePath);
      let postCalls = 0;
      const res = main(['--scan-post', '7', '--dir', cfg.dir], {
        settings: cfg.settings,
        platform: {
          ask(op) {
            if (op === 'change') return cfg.withPass.change;
            if (op === 'comments') return cfg.withPass.comments;
            throw new Error('unexpected op: ' + op);
          },
        },
        runPost() { postCalls += 1; },
      });
      origWrite.call(fs, cfg.oldDoneFile, JSON.stringify({ code: res.code, lines: res.lines, postCalls }));
    `;
    const realExistsSync = fs.existsSync;
    let spawnedOldWorker = false;
    try {
      fs.existsSync = function patchedExists(p) {
        const ex = realExistsSync.call(this, p);
        if (!spawnedOldWorker && String(p) === path.join(scanFolder, 'post.lock') && ex === false) {
          spawnedOldWorker = true;
          spawn(
            process.execPath,
            [
              '-e',
              oldWorkerScript,
              JSON.stringify({
                modulePath: path.resolve(__dirname, '../tools/review-launch.js'),
                dir,
                settings: s,
                withPass,
                oldCreatedLockMarker,
                resumeOldMarker,
                oldDoneFile,
              }),
            ],
            { stdio: 'ignore' },
          );
          const deadline = Date.now() + 10000;
          while (!realExistsSync.call(fs, oldCreatedLockMarker)) {
            if (Date.now() > deadline) throw new Error('timeout waiting for oldCreatedLockMarker');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return ex;
      };
      const purgeOldRes = scanClose('7', { settings: s, dir, leftoverRoots: [], purge: true });
      fs.existsSync = realExistsSync;
      assert.equal(purgeOldRes.code, 0, purgeOldRes.lines.join('\n'));
      assert.ok(spawnedOldWorker, '應在收樹者讀完 post.lock 不存在後啟動舊代貼程序建立 post.lock');
      assert.ok(!fs.existsSync(scanFolder), '舊掃描容器已被清除');
    } finally {
      fs.existsSync = realExistsSync;
    }
    // 重建新掃描容器（startedAt = 04:00）
    const newScanLaunchRes = main(['--scan', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      cwd: r.dir,
      now: () => new Date('2026-10-20T04:00:00.000Z'),
    });
    assert.equal(newScanLaunchRes.code, 0, newScanLaunchRes.lines.join('\n'));
    fs.writeFileSync(
      path.join(scanFolder, 'output.log'),
      `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- new-proc\n\n### 掃描結果\n- 零發現\n未貼\n`,
    );
    let newScanPostCalls = 0;
    const newScanPostRes = main(['--scan-post', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform(withPass),
      now: () => new Date('2026-10-20T04:05:00.000Z'),
      runPost() {
        newScanPostCalls += 1;
        // 新代貼程序已進入 runPost 並持有新 post.lock 與容器鎖；現在喚醒舊代貼程序並等待它完全結束
        fs.writeFileSync(resumeOldMarker, '1');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(oldDoneFile)) {
          if (Date.now() > deadline) throw new Error('timeout waiting for oldDoneFile');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        assert.ok(fs.existsSync(path.join(scanFolder, 'post.lock')), '舊代貼程序結束後，新代貼程序的 post.lock 仍在（未被舊程序誤刪）');
        assert.ok(fs.existsSync(scanContainerLockPath), '舊代貼程序結束後，新代貼程序的容器鎖仍在');
      },
    });
    assert.equal(newScanPostRes.code, 0, newScanPostRes.lines.join('\n'));
    assert.equal(newScanPostCalls, 1, '新代貼程序正常送出一次');
    const oldDone = JSON.parse(fs.readFileSync(oldDoneFile, 'utf8'));
    assert.equal(oldDone.code, 2, oldDone.lines.join('\n'));
    assert.equal(oldDone.postCalls, 0, '舊代貼程序不可穿過新鎖送出');
    assert.match(oldDone.lines.join('\n'), /正在被另一個程序操作/u);
    const finalNewScanJson = JSON.parse(fs.readFileSync(path.join(scanFolder, 'scan.json'), 'utf8'));
    assert.equal(finalNewScanJson.startedAt, '2026-10-20T04:00:00.000Z', 'scan.json 維持新容器身分');
    assert.equal(finalNewScanJson.postedAt, '2026-10-20T04:05:00.000Z', 'scan.json 記下新代貼時間');
    assert.equal(main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);

    // (j) r6 R1：--expect-head 支援 7〜40 碼大小寫版本碼（短碼經 git rev-parse 解析為唯一完整版本），四個入口（--post、--close、--scan-post、--scan-close）合法形式與錯版對照（含前 7 碼相同但完整碼不同的錯誤訊息不印出兩個相同短碼）
    const shortLower = r.head.slice(0, 7).toLowerCase();
    const shortUpper = r.head.slice(0, 7).toUpperCase();
    const fullUpper = r.head.toUpperCase();
    const samePrefixWrongFull = `${r.head.slice(0, 7)}${r.head.slice(7).replace(/./gu, (ch) => (ch === 'a' ? 'b' : 'a'))}`;

    for (const validHead of [shortLower, shortUpper, fullUpper]) {
      assert.equal(launch('7', 'Beta', { settings: s, platform: fakePlatform(baseAns), cwd: r.dir, dir, template: TEMPLATE }).code, 0);
      fs.writeFileSync(
        path.join(reviewFolder, 'output.log'),
        `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
      );
      let postCount = 0;
      const postRes = main(['--post', '7', '--round', '1', '--expect-head', validHead, '--dir', dir], {
        settings: s,
        platform: fakePlatform(baseAns),
        runPost() { postCount += 1; },
      });
      assert.equal(postRes.code, 0, `--post 接受合法 --expect-head (${validHead})：${postRes.lines.join('\n')}`);
      assert.equal(postCount, 1);

      // 對照：同前 7 碼但後段不同的錯版，錯誤訊息必須顯示完整碼以區分兩者（不可印成兩個相同的 7 碼）
      const recForMismatch = JSON.parse(fs.readFileSync(path.join(reviewFolder, 'launch.json'), 'utf8'));
      delete recForMismatch.postedAt;
      fs.writeFileSync(path.join(reviewFolder, 'launch.json'), `${JSON.stringify(recForMismatch, null, 2)}\n`);
      const wrongSamePrefixPost = main(['--post', '7', '--round', '1', '--expect-head', samePrefixWrongFull, '--dir', dir], {
        settings: s,
        platform: fakePlatform(baseAns),
        runPost() { throw new Error('不應送出'); },
      });
      assert.equal(wrongSamePrefixPost.code, 2);
      assert.match(wrongSamePrefixPost.lines.join('\n'), new RegExp(`受審版本是 ${r.head}，不是本次啟動的 ${samePrefixWrongFull.toLowerCase()}`, 'u'));

      const wrongCloseRes = main(['--close', '7', '--round', '1', '--expect-head', samePrefixWrongFull, '--purge', '--dir', dir], {
        settings: s,
        leftoverRoots: [],
      });
      assert.equal(wrongCloseRes.code, 1);
      assert.ok(fs.existsSync(path.join(reviewFolder, 'tree')), '錯版時審查樹保留');

      const closeRes = main(['--close', '7', '--round', '1', '--expect-head', validHead, '--purge', '--dir', dir], {
        settings: s,
        leftoverRoots: [],
      });
      assert.equal(closeRes.code, 0, `--close 接受合法 --expect-head (${validHead})：${closeRes.lines.join('\n')}`);
      assert.ok(!fs.existsSync(reviewFolder));

      assert.equal(main(['--scan', '7', '--dir', dir], { settings: s, platform: fakePlatform(withPass), cwd: r.dir }).code, 0);
      fs.writeFileSync(
        path.join(scanFolder, 'output.log'),
        `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
      );
      const wrongScanPost = main(['--scan-post', '7', '--expect-head', samePrefixWrongFull, '--dir', dir], {
        settings: s,
        platform: fakePlatform(withPass),
        runPost() { throw new Error('不應送出'); },
      });
      assert.equal(wrongScanPost.code, 2);
      assert.match(wrongScanPost.lines.join('\n'), new RegExp(`掃描版本是 ${r.head}，不是本次啟動的 ${samePrefixWrongFull.toLowerCase()}`, 'u'));

      let scanPostCount = 0;
      const scanPostRes = main(['--scan-post', '7', '--expect-head', validHead, '--dir', dir], {
        settings: s,
        platform: fakePlatform(withPass),
        runPost() { scanPostCount += 1; },
      });
      assert.equal(scanPostRes.code, 0, `--scan-post 接受合法 --expect-head (${validHead})：${scanPostRes.lines.join('\n')}`);
      assert.equal(scanPostCount, 1);

      const wrongScanClose = main(['--scan-close', '7', '--expect-head', samePrefixWrongFull, '--purge', '--dir', dir], {
        settings: s,
        leftoverRoots: [],
      });
      assert.equal(wrongScanClose.code, 1);
      assert.ok(fs.existsSync(path.join(scanFolder, 'tree')), '錯版時掃描樹保留');

      const scanCloseRes = main(['--scan-close', '7', '--expect-head', validHead, '--purge', '--dir', dir], {
        settings: s,
        leftoverRoots: [],
      });
      assert.equal(scanCloseRes.code, 0, `--scan-close 接受合法 --expect-head (${validHead})：${scanCloseRes.lines.join('\n')}`);
      assert.ok(!fs.existsSync(scanFolder));
    }

    // (k) r6 R2：--dir 為含空白的 symlink 別名、指向不含空白的實體安全目錄 → 收尾失敗時印出的恢復指令以實體安全目錄呈現，經 splitCommandArgs 拆解後重跑成功收尾
    const aliasParent = tmp('review-launch-r6-r2-');
    const aliasWithSpaces = path.join(aliasParent, 'alias with spaces');
    fs.symlinkSync(dir, aliasWithSpaces, 'dir');

    let aliasRevOut = '';
    try {
      const aliasRevFail = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', aliasWithSpaces], {
        settings: s,
        platform: fakePlatform(baseAns),
        cwd: r.dir,
        template: TEMPLATE,
        leftoverRoots: [],
        runExec(_cmd, { record }) {
          fs.writeFileSync(
            record.outFile,
            `🤖 Beta｜來源：beta CLI｜審 \`${r.head.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
          );
        },
        runPost() {
          fs.writeFileSync(revLockPath, '999999\n');
        },
      });
      assert.equal(aliasRevFail.code, 2, aliasRevFail.lines.join('\n'));
      aliasRevOut = aliasRevFail.lines.join('\n');
    } finally {
      fs.rmSync(revLockPath, { force: true });
    }
    const aliasRevCmdMatch = /可重跑 node tools\/review-launch\.js ([^）。]+)）/u.exec(aliasRevOut);
    assert.ok(aliasRevCmdMatch, `應擷取複審恢復指令：${aliasRevOut}`);
    const aliasRevParsed = splitCommandArgs(aliasRevCmdMatch[1].trim());
    const aliasRevRetry = main(aliasRevParsed, { settings: s, leftoverRoots: [] });
    assert.equal(aliasRevRetry.code, 0, `含空白別名複審恢復指令重跑應成功：${aliasRevRetry.lines.join('\n')}`);
    assert.ok(!fs.existsSync(reviewFolder), '複審容器已收樹並清除');

    let aliasScanOut = '';
    try {
      const aliasScanFail = main(['--scan', '7', '--run', '--purge', '--dir', aliasWithSpaces], {
        settings: s,
        platform: fakePlatform(withPass),
        cwd: r.dir,
        leftoverRoots: [],
        runExec(_cmd, { record }) {
          fs.writeFileSync(
            record.outFile,
            `🔍 Gamma｜來源：Grok CLI｜掃 \`${r.head.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
          );
        },
        runPost() {
          fs.writeFileSync(scanContainerLockPath, '999999\n');
        },
      });
      assert.equal(aliasScanFail.code, 2, aliasScanFail.lines.join('\n'));
      aliasScanOut = aliasScanFail.lines.join('\n');
    } finally {
      fs.rmSync(scanContainerLockPath, { force: true });
    }
    const aliasScanCmdMatch = /可重跑 node tools\/review-launch\.js ([^）。]+)）/u.exec(aliasScanOut);
    assert.ok(aliasScanCmdMatch, `應擷取掃描恢復指令：${aliasScanOut}`);
    const aliasScanParsed = splitCommandArgs(aliasScanCmdMatch[1].trim());
    const aliasScanRetry = main(aliasScanParsed, { settings: s, leftoverRoots: [] });
    assert.equal(aliasScanRetry.code, 0, `含空白別名掃描恢復指令重跑應成功：${aliasScanRetry.lines.join('\n')}`);
    assert.ok(!fs.existsSync(scanFolder), '掃描容器已收樹並清除');

    // (l) 專案相依套件（node_modules）自動準備、工作區連結重綁、防掉包驗樹、收樹內容保存與隔離複製驗退碼（R1〜R4）
    const sharedPkgDir = path.join(r.dir, 'packages', 'shared');
    fs.mkdirSync(sharedPkgDir, { recursive: true });
    fs.writeFileSync(path.join(sharedPkgDir, 'package.json'), '{"name":"ws-shared","type":"module","main":"index.js"}\n');
    fs.writeFileSync(path.join(sharedPkgDir, 'index.js'), 'export const wsValue = "HEAD_VALUE";\n');
    fs.writeFileSync(path.join(r.dir, '.gitignore'), 'node_modules\n');
    sh(r.dir, 'add', 'packages/shared/package.json', 'packages/shared/index.js', '.gitignore');
    sh(r.dir, 'commit', '-q', '-m', 'add workspace package and gitignore node_modules');
    const wsHead = sh(r.dir, 'rev-parse', 'HEAD');
    // 主工作樹把 packages/shared/index.js 改成未提交的 BASE_VALUE，驗證審查樹與突變副本載入 ws-shared 時讀到受審 HEAD_VALUE 而非主目錄 BASE_VALUE
    fs.writeFileSync(path.join(sharedPkgDir, 'index.js'), 'export const wsValue = "BASE_VALUE";\n');

    const depDir = path.join(r.dir, 'node_modules', 'fake-dep');
    fs.mkdirSync(depDir, { recursive: true });
    const pkgJsonContent = '{"name":"fake-dep","type":"module","main":"index.js"}\n';
    const revSeedContent = 'export const depValue = "REV_SEED_CONTENT_KEEP_EXACT";\n';
    fs.writeFileSync(path.join(depDir, 'package.json'), pkgJsonContent);
    fs.writeFileSync(path.join(depDir, 'index.js'), revSeedContent);
    const wsLinkInMain = path.join(r.dir, 'node_modules', 'ws-shared');
    fs.symlinkSync('../packages/shared', wsLinkInMain, 'dir');

    const implWt = path.join(tmp('review-launch-impl-wt-'), 'wt');
    sh(r.dir, 'worktree', 'add', '--detach', '-q', implWt, wsHead);
    const wsAns = {
      ...baseAns,
      change: { id: '7', headSha: wsHead, baseBranch: 'main', changedFileCount: '2', body: '實作者：Alpha\n複審者：Beta\n' },
      branchSha: { sha: r.base },
      changedFiles: [{ path: 'a.txt', additions: 1, deletions: 0 }, { path: 'packages/shared/index.js', additions: 1, deletions: 0 }],
      comments: [],
    };
    const wsWithPass = {
      ...wsAns,
      comments: [
        {
          id: '501',
          createdAt: '2026-10-20T00:00:00Z',
          body: `🤖 Beta｜來源：beta CLI｜審 \`${wsHead.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n`,
        },
      ],
    };

    let revPostCount = 0;
    const depRevRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(wsAns),
      cwd: implWt,
      template: TEMPLATE,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        for (const [label, targetCwd] of [['tree', record.tree], ['mutation', record.mutation]]) {
          const probe = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              'const m = await import("fake-dep"); const w = await import("ws-shared"); if (m.depValue !== "REV_SEED_CONTENT_KEEP_EXACT" || w.wsValue !== "HEAD_VALUE") process.exit(1);',
            ],
            { cwd: targetCwd, env: gitEnv(), encoding: 'utf8' },
          );
          if (probe.status !== 0) {
            throw new LaunchError(`${label} 載入相依套件失敗（退 ${probe.status}）：${(probe.stderr || '').trim()}`);
          }
        }
        // R2：只改突變副本的 node_modules 內容，不得影響主目錄與唯讀審查樹
        fs.writeFileSync(
          path.join(record.mutation, 'node_modules', 'fake-dep', 'index.js'),
          'export const depValue = "MUTATED_ONLY_IN_MUTATION";\n',
        );
        assert.equal(fs.readFileSync(path.join(depDir, 'index.js'), 'utf8'), revSeedContent, '寫入突變副本 node_modules 不得汙染主目錄來源');
        assert.equal(
          fs.readFileSync(path.join(record.tree, 'node_modules', 'fake-dep', 'index.js'), 'utf8'),
          revSeedContent,
          '寫入突變副本 node_modules 不得汙染唯讀審查樹',
        );
        fs.writeFileSync(
          record.outFile,
          `🤖 Beta｜來源：beta CLI｜審 \`${wsHead.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
        );
      },
      runPost() { revPostCount += 1; },
    });
    assert.equal(depRevRes.code, 0, `複審 --run 應自動準備獨立 node_modules、重綁工作區連結並完成代貼與收樹：${depRevRes.lines.join('\n')}`);
    assert.equal(revPostCount, 1);
    assert.ok(!fs.existsSync(reviewFolder), '複審容器應已收樹並清除');
    assert.equal(fs.readFileSync(path.join(depDir, 'index.js'), 'utf8'), revSeedContent, 'R3：收樹與 --purge 後主目錄 node_modules 檔案內容必須逐字完好');

    // R3：開樹且依賴掛載完成後，寫入提示檔失敗觸發回滾時，必須確認掛載已發生、回滾已清乾淨，且主目錄 node_modules 內容逐字完好
    const rollbackSeedContent = 'export const depValue = "ROLLBACK_SEED_CONTENT_KEEP_EXACT";\n';
    fs.writeFileSync(path.join(depDir, 'index.js'), rollbackSeedContent);
    let revRollbackAfterLinkCount = 0;
    const origWriteFileSync = fs.writeFileSync;
    try {
      fs.writeFileSync = function patchedWriteFileSync(filePath, data, options) {
        if (typeof filePath === 'string' && filePath === path.join(reviewFolder, 'prompt.md')) {
          assert.ok(fs.lstatSync(path.join(reviewFolder, 'tree', 'node_modules')).isSymbolicLink(), 'R3：回滾前 tree/node_modules 應已掛載');
          assert.ok(fs.lstatSync(path.join(reviewFolder, 'mutation', 'node_modules')).isSymbolicLink(), 'R3：回滾前 mutation/node_modules 應已掛載');
          assert.ok(fs.existsSync(path.join(reviewFolder, 'deps', 'tree', 'node_modules', 'fake-dep', 'index.js')), 'R3：回滾前獨立依賴複本應已建立');
          revRollbackAfterLinkCount += 1;
          throw new Error('simulated prompt write failure after linkNodeModules');
        }
        return origWriteFileSync.call(this, filePath, data, options);
      };
      const rollbackRevRes = main(['7', '--reviewer', 'Beta', '--dir', dir], {
        settings: s,
        platform: fakePlatform(wsAns),
        cwd: implWt,
        template: TEMPLATE,
        leftoverRoots: [],
      });
      assert.equal(rollbackRevRes.code, 2, 'R3：寫入提示檔失敗應退 2');
    } finally {
      fs.writeFileSync = origWriteFileSync;
    }
    assert.equal(revRollbackAfterLinkCount, 1, 'R3：必須在依賴掛載完成後才觸發回滾');
    assert.ok(!fs.existsSync(reviewFolder), 'R3：回滾後複審容器應已移除');
    assert.ok(!sh(r.dir, 'worktree', 'list', '--porcelain').includes(reviewFolder), 'R3：回滾後不應殘留工作樹登記');
    assert.equal(fs.readFileSync(path.join(depDir, 'index.js'), 'utf8'), rollbackSeedContent, 'R3：開樹異常回滾後主目錄 node_modules 檔案內容必須逐字完好');

    let scanRollbackAfterLinkCount = 0;
    try {
      fs.writeFileSync = function patchedScanWriteFileSync(filePath, data, options) {
        if (typeof filePath === 'string' && filePath === path.join(scanFolder, 'prompt.md')) {
          assert.ok(fs.lstatSync(path.join(scanFolder, 'tree', 'node_modules')).isSymbolicLink(), 'R3：掃描回滾前 tree/node_modules 應已掛載');
          assert.ok(fs.existsSync(path.join(scanFolder, 'deps', 'tree', 'node_modules', 'fake-dep', 'index.js')), 'R3：掃描回滾前獨立依賴複本應已建立');
          scanRollbackAfterLinkCount += 1;
          throw new Error('simulated scan prompt write failure after linkNodeModules');
        }
        return origWriteFileSync.call(this, filePath, data, options);
      };
      const rollbackScanRes = main(['--scan', '7', '--dir', dir], {
        settings: s,
        platform: fakePlatform(wsWithPass),
        cwd: implWt,
        leftoverRoots: [],
      });
      assert.equal(rollbackScanRes.code, 2, 'R3：掃描寫入提示檔失敗應退 2');
    } finally {
      fs.writeFileSync = origWriteFileSync;
    }
    assert.equal(scanRollbackAfterLinkCount, 1, 'R3：掃描必須在依賴掛載完成後才觸發回滾');
    assert.ok(!fs.existsSync(scanFolder), 'R3：回滾後掃描容器應已移除');
    assert.ok(!sh(r.dir, 'worktree', 'list', '--porcelain').includes(scanFolder), 'R3：掃描回滾後不應殘留工作樹登記');
    assert.equal(fs.readFileSync(path.join(depDir, 'index.js'), 'utf8'), rollbackSeedContent, 'R3：掃描開樹異常回滾後主目錄 node_modules 檔案內容必須逐字完好');

    // R5：收樹（close / scanClose）中途 git worktree remove 失敗時，應還原掛載連結並保留未收工作樹的獨立依賴，排除原因後重試可正常收完（退 0）
    const retryRevLaunch = main(['7', '--reviewer', 'Beta', '--dir', dir], {
      settings: s,
      platform: fakePlatform(wsAns),
      cwd: implWt,
      template: TEMPLATE,
      leftoverRoots: [],
    });
    assert.equal(retryRevLaunch.code, 0);
    const retryRevClose1 = close('7', {
      settings: s,
      dir,
      leftoverRoots: [],
      remove(rootDir, t) {
        if (t === retryRevLaunch.record.mutation) {
          sh(rootDir, 'worktree', 'lock', t);
        }
        const rm = spawnSync('git', ['worktree', 'remove', t], { cwd: rootDir, env: gitEnv(), encoding: 'utf8' });
        return rm.status === 0 ? null : (rm.stderr || 'remove failed').trim();
      },
    });
    assert.equal(retryRevClose1.code, 1, 'R5：突變副本移除失敗時 close 應退 1');
    assert.ok(fs.lstatSync(path.join(reviewFolder, 'mutation', 'node_modules')).isSymbolicLink(), 'R5：移除失敗時應還原 mutation/node_modules 連結');
    assert.ok(fs.existsSync(path.join(reviewFolder, 'deps', 'mutation', 'node_modules', 'fake-dep', 'index.js')), 'R5：移除失敗時不得預先刪掉未收工作樹的獨立依賴');
    sh(r.dir, 'worktree', 'unlock', retryRevLaunch.record.mutation);
    const retryRevClose2 = main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] });
    assert.equal(retryRevClose2.code, 0, `R5：解除鎖定後重試 --close --purge 應退 0：${retryRevClose2.lines.join('\n')}`);
    assert.ok(!fs.existsSync(reviewFolder), 'R5：重試成功後複審容器應已清除');

    const retryScanLaunch = main(['--scan', '7', '--dir', dir], {
      settings: s,
      platform: fakePlatform(wsWithPass),
      cwd: implWt,
      leftoverRoots: [],
    });
    assert.equal(retryScanLaunch.code, 0);
    const retryScanClose1 = scanClose('7', {
      settings: s,
      dir,
      leftoverRoots: [],
      remove(rootDir, t) {
        sh(rootDir, 'worktree', 'lock', t);
        const rm = spawnSync('git', ['worktree', 'remove', t], { cwd: rootDir, env: gitEnv(), encoding: 'utf8' });
        return rm.status === 0 ? null : (rm.stderr || 'remove failed').trim();
      },
    });
    assert.equal(retryScanClose1.code, 1, 'R5：掃描樹移除失敗時 scanClose 應退 1');
    assert.ok(fs.lstatSync(path.join(scanFolder, 'tree', 'node_modules')).isSymbolicLink(), 'R5：掃描樹移除失敗時應還原 tree/node_modules 連結');
    assert.ok(fs.existsSync(path.join(scanFolder, 'deps', 'tree', 'node_modules', 'fake-dep', 'index.js')), 'R5：掃描樹移除失敗時不得預先刪掉獨立依賴');
    sh(r.dir, 'worktree', 'unlock', retryScanLaunch.record.tree);
    const retryScanClose2 = main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] });
    assert.equal(retryScanClose2.code, 0, `R5：解除鎖定後重試 --scan-close --purge 應退 0：${retryScanClose2.lines.join('\n')}`);
    assert.ok(!fs.existsSync(scanFolder), 'R5：重試成功後掃描容器應已清除');
    assert.equal(fs.readFileSync(path.join(depDir, 'index.js'), 'utf8'), rollbackSeedContent, 'R5：收樹失敗重試後主目錄 node_modules 內容必須逐字完好');

    const scanSeedContent = 'export const depValue = "SCAN_SEED_CONTENT_KEEP_EXACT";\n';
    fs.writeFileSync(path.join(depDir, 'index.js'), scanSeedContent);
    let scanPostCount = 0;
    const depScanRes = main(['--scan', '7', '--run', '--purge', '--dir', dir], {
      settings: s,
      platform: fakePlatform(wsWithPass),
      cwd: implWt,
      leftoverRoots: [],
      runExec(_cmd, { record }) {
        const probe = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            'const m = await import("fake-dep"); const w = await import("ws-shared"); if (m.depValue !== "SCAN_SEED_CONTENT_KEEP_EXACT" || w.wsValue !== "HEAD_VALUE") process.exit(1);',
          ],
          { cwd: record.tree, env: gitEnv(), encoding: 'utf8' },
        );
        if (probe.status !== 0) {
          throw new LaunchError(`scanTree 載入相依套件失敗（退 ${probe.status}）：${(probe.stderr || '').trim()}`);
        }
        fs.writeFileSync(
          record.outFile,
          `🔍 Gamma｜來源：Grok CLI｜掃 \`${wsHead.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
        );
      },
      runPost() { scanPostCount += 1; },
    });
    assert.equal(depScanRes.code, 0, `掃描 --run 應自動準備 node_modules 並完成代貼與收樹：${depScanRes.lines.join('\n')}`);
    assert.equal(scanPostCount, 1);
    assert.ok(!fs.existsSync(scanFolder), '掃描容器應已收樹並清除');
    assert.equal(fs.readFileSync(path.join(depDir, 'index.js'), 'utf8'), scanSeedContent, 'R3：掃描收樹與 --purge 後主目錄 node_modules 檔案內容必須逐字完好');

    // R1：專案 .gitignore 含 node_modules 時，把掛好的連結換成普通目錄（內含唯一現場證據）或改指其他目錄，
    //     複審與掃描的代貼與收樹皆須退 1、代貼 0 次、保留容器與唯一證據
    const altTargetDir = tmp('review-launch-alt-nm-');
    try {
      let r1RevPosts = 0;
      const tamperDirRevRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
        settings: s,
        platform: fakePlatform(wsAns),
        cwd: implWt,
        template: TEMPLATE,
        leftoverRoots: [],
        runExec(_cmd, { record }) {
          const nm = path.join(record.tree, 'node_modules');
          fs.unlinkSync(nm);
          fs.mkdirSync(nm);
          fs.writeFileSync(path.join(nm, 'evidence.txt'), 'UNIQUE_REVIEW_EVIDENCE=KEEP_ME\n');
          fs.writeFileSync(
            record.outFile,
            `🤖 Beta｜來源：beta CLI｜審 \`${wsHead.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
          );
        },
        runPost() { r1RevPosts += 1; },
      });
      assert.equal(tamperDirRevRes.code, 1, 'R1：.gitignore 忽略 node_modules 時掉包為普通目錄應退 1 拒貼');
      assert.equal(r1RevPosts, 0, 'R1：掉包後代貼次數必須為 0');
      assert.equal(
        fs.readFileSync(path.join(reviewFolder, 'tree', 'node_modules', 'evidence.txt'), 'utf8'),
        'UNIQUE_REVIEW_EVIDENCE=KEEP_ME\n',
        'R1：--run --purge 失敗時不得刪掉掉包目錄內的現場證據',
      );
      const tamperCloseRevRes = main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] });
      assert.equal(tamperCloseRevRes.code, 1, 'R1：--close --purge 遇掉包目錄應退 1 拒收');
      assert.equal(
        fs.readFileSync(path.join(reviewFolder, 'tree', 'node_modules', 'evidence.txt'), 'utf8'),
        'UNIQUE_REVIEW_EVIDENCE=KEEP_ME\n',
        'R1：--close --purge 拒收後現場證據仍須保留',
      );
      // 測試改指其他目錄同樣拒貼拒收
      fs.rmSync(path.join(reviewFolder, 'tree', 'node_modules'), { recursive: true, force: true });
      fs.symlinkSync(altTargetDir, path.join(reviewFolder, 'tree', 'node_modules'), 'dir');
      assert.equal(main(['--post', '7', '--dir', dir], { settings: s, platform: fakePlatform(wsAns), runPost() { r1RevPosts += 1; } }).code, 1);
      assert.equal(r1RevPosts, 0);
      assert.equal(main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 1);
      // 還原正確連結後收樹清除
      fs.unlinkSync(path.join(reviewFolder, 'tree', 'node_modules'));
      fs.symlinkSync(path.join(reviewFolder, 'deps', 'tree', 'node_modules'), path.join(reviewFolder, 'tree', 'node_modules'), 'dir');
      assert.equal(main(['--close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);

      let r1ScanPosts = 0;
      const tamperScanRes = main(['--scan', '7', '--run', '--purge', '--dir', dir], {
        settings: s,
        platform: fakePlatform(wsWithPass),
        cwd: implWt,
        leftoverRoots: [],
        runExec(_cmd, { record }) {
          const nm = path.join(record.tree, 'node_modules');
          fs.unlinkSync(nm);
          fs.mkdirSync(nm);
          fs.writeFileSync(path.join(nm, 'scan-evidence.txt'), 'UNIQUE_SCAN_EVIDENCE=KEEP_ME\n');
          fs.writeFileSync(
            record.outFile,
            `🔍 Gamma｜來源：Grok CLI｜掃 \`${wsHead.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
          );
        },
        runPost() { r1ScanPosts += 1; },
      });
      assert.equal(tamperScanRes.code, 1, 'R1：掃描樹 .gitignore 忽略 node_modules 時掉包為普通目錄應退 1 拒貼');
      assert.equal(r1ScanPosts, 0);
      assert.equal(
        fs.readFileSync(path.join(scanFolder, 'tree', 'node_modules', 'scan-evidence.txt'), 'utf8'),
        'UNIQUE_SCAN_EVIDENCE=KEEP_ME\n',
      );
      assert.equal(main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 1);
      assert.equal(
        fs.readFileSync(path.join(scanFolder, 'tree', 'node_modules', 'scan-evidence.txt'), 'utf8'),
        'UNIQUE_SCAN_EVIDENCE=KEEP_ME\n',
      );
      fs.rmSync(path.join(scanFolder, 'tree', 'node_modules'), { recursive: true, force: true });
      fs.symlinkSync(altTargetDir, path.join(scanFolder, 'tree', 'node_modules'), 'dir');
      assert.equal(main(['--scan-post', '7', '--dir', dir], { settings: s, platform: fakePlatform(wsWithPass), runPost() { r1ScanPosts += 1; } }).code, 1);
      assert.equal(r1ScanPosts, 0);
      assert.equal(main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 1);

      // BACKLOG.md 第 91 行負例：掃描樹就算連結已還原、同 HEAD 且乾淨，若不在原倉庫 git worktree 登記中，scanPost 仍須拒貼
      fs.unlinkSync(path.join(scanFolder, 'tree', 'node_modules'));
      fs.symlinkSync(path.join(scanFolder, 'deps', 'tree', 'node_modules'), path.join(scanFolder, 'tree', 'node_modules'), 'dir');
      const unregScanTree = path.join(altTargetDir, 'unregistered-scan-tree');
      sh(altTargetDir, 'clone', '-q', r.dir, unregScanTree);
      sh(unregScanTree, 'checkout', '--detach', '-q', wsHead);
      const scanRecPath = path.join(scanFolder, 'scan.json');
      const origScanRecText = fs.readFileSync(scanRecPath, 'utf8');
      const mutatedScanRec = JSON.parse(origScanRecText);
      mutatedScanRec.tree = unregScanTree;
      delete mutatedScanRec.linkedNodeModulesByTree;
      delete mutatedScanRec.linkedNodeModules;
      fs.writeFileSync(scanRecPath, `${JSON.stringify(mutatedScanRec, null, 1)}\n`);
      const unregPostRes = main(['--scan-post', '7', '--dir', dir], {
        settings: s,
        platform: fakePlatform(wsWithPass),
        runPost() { r1ScanPosts += 1; },
      });
      assert.equal(unregPostRes.code, 1, '未登記於原倉庫 git worktree 的乾淨同 HEAD 掃描樹應拒貼');
      assert.match(unregPostRes.lines.join('\n'), /不在 git worktree 登記裡/u);
      assert.equal(r1ScanPosts, 0);
      fs.writeFileSync(scanRecPath, origScanRecText);
      assert.equal(main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);

      // R2 外部連結防呆（一）：若來源 node_modules 內含指向工作樹外的連結，應明確拒絕啟動
      const extLinkPath = path.join(r.dir, 'node_modules', 'ext-escape');
      fs.symlinkSync(altTargetDir, extLinkPath, 'dir');
      try {
        const extRes = main(['7', '--reviewer', 'Beta', '--dir', dir], {
          settings: s,
          platform: fakePlatform(wsAns),
          cwd: implWt,
          template: TEMPLATE,
          leftoverRoots: [],
        });
        assert.equal(extRes.code, 2, '指向工作樹外的依賴連結應退 2 拒絕啟動');
        assert.match(extRes.lines.join('\n'), /指向工作樹外的連結/u);
      } finally {
        fs.unlinkSync(extLinkPath);
      }

      // R2 外部連結防呆（二）：來源工作樹的 packages/shared 是普通目錄，但受審提交把 packages/shared（或其內部檔案）改成指向樹外的符號連結時，
      //     必須在重綁與核驗時識破並退 2 拒絕啟動，防止審查樹與突變副本透過工作區連結共用或覆寫樹外檔案
      const extSharedTarget = path.join(altTargetDir, 'ext-shared-pkg');
      fs.mkdirSync(extSharedTarget, { recursive: true });
      fs.writeFileSync(path.join(extSharedTarget, 'package.json'), '{"name":"ws-shared","type":"module","main":"index.js"}\n');
      fs.writeFileSync(path.join(extSharedTarget, 'index.js'), 'export const wsValue = "EXTERNAL_UNREVIEWED";\n');
      sh(implWt, 'rm', '-rf', 'packages/shared');
      fs.mkdirSync(path.join(implWt, 'packages'), { recursive: true });
      fs.symlinkSync(extSharedTarget, path.join(implWt, 'packages', 'shared'), 'dir');
      sh(implWt, 'add', 'packages/shared');
      sh(implWt, 'commit', '-q', '-m', 'replace workspace package with external symlink');
      const badWsHead = sh(implWt, 'rev-parse', 'HEAD');
      sh(implWt, 'checkout', '--detach', '-q', wsHead);
      const badWsAns = {
        ...wsAns,
        change: { ...wsAns.change, headSha: badWsHead },
      };
      const badWsRevRes = main(['7', '--reviewer', 'Beta', '--dir', dir], {
        settings: s,
        platform: fakePlatform(badWsAns),
        cwd: implWt,
        template: TEMPLATE,
        leftoverRoots: [],
      });
      assert.equal(badWsRevRes.code, 2, 'R2：受審提交將工作區套件改為樹外連結時應退 2 拒絕啟動');
      assert.match(badWsRevRes.lines.join('\n'), /本機套件連結目標指向工作樹外/u);
      assert.ok(!fs.existsSync(reviewFolder), 'R2：拒啟回滾後不應留下複審容器');
      assert.equal(
        fs.readFileSync(path.join(extSharedTarget, 'index.js'), 'utf8'),
        'export const wsValue = "EXTERNAL_UNREVIEWED";\n',
        'R2：樹外目錄內容不得被動到',
      );

      // R2 外部連結防呆（三）：間接外部連結（packages/shared/src -> ../../internal-bridge，而 internal-bridge/index.js 指向樹外）
      sh(implWt, 'checkout', '--detach', '-q', wsHead);
      fs.mkdirSync(path.join(implWt, 'internal-bridge'), { recursive: true });
      fs.symlinkSync(path.join(extSharedTarget, 'index.js'), path.join(implWt, 'internal-bridge', 'index.js'));
      fs.symlinkSync('../../internal-bridge', path.join(implWt, 'packages', 'shared', 'src'), 'dir');
      fs.writeFileSync(path.join(implWt, 'packages', 'shared', 'index.js'), 'export { wsValue } from "./src/index.js";\n');
      sh(implWt, 'add', 'internal-bridge/index.js', 'packages/shared/src', 'packages/shared/index.js');
      sh(implWt, 'commit', '-q', '-m', 'indirect external symlink via internal directory link');
      const indirectExtHead = sh(implWt, 'rev-parse', 'HEAD');
      sh(implWt, 'checkout', '--detach', '-q', wsHead);
      let indirectPosts = 0;
      const indirectExtRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
        settings: s,
        platform: fakePlatform({ ...wsAns, change: { ...wsAns.change, headSha: indirectExtHead } }),
        cwd: implWt,
        template: TEMPLATE,
        leftoverRoots: [],
        runPost() { indirectPosts += 1; },
      });
      assert.equal(indirectExtRes.code, 2, 'R2：經樹內目錄連結二階指向樹外時應退 2 拒絕啟動');
      assert.match(indirectExtRes.lines.join('\n'), /本機套件內含指向工作樹外的連結/u);
      assert.equal(indirectPosts, 0, 'R2：間接外部連結拒啟時代貼次數必須為 0');
      assert.ok(!fs.existsSync(reviewFolder), 'R2：間接外部連結拒啟回滾後不應留下複審容器');

      // R2 外部連結防呆（四）：巢狀 node_modules 指向樹外（packages/shared/node_modules -> 樹外目錄）
      sh(implWt, 'checkout', '--detach', '-q', wsHead);
      fs.symlinkSync(extSharedTarget, path.join(implWt, 'packages', 'shared', 'node_modules'), 'dir');
      sh(implWt, 'add', '-f', 'packages/shared/node_modules');
      sh(implWt, 'commit', '-q', '-m', 'nested node_modules symlink to outside');
      const nestedNmExtHead = sh(implWt, 'rev-parse', 'HEAD');
      sh(implWt, 'checkout', '--detach', '-q', wsHead);
      let nestedNmPosts = 0;
      const nestedNmExtRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
        settings: s,
        platform: fakePlatform({ ...wsAns, change: { ...wsAns.change, headSha: nestedNmExtHead } }),
        cwd: implWt,
        template: TEMPLATE,
        leftoverRoots: [],
        runPost() { nestedNmPosts += 1; },
      });
      assert.equal(nestedNmExtRes.code, 2, 'R2：工作區套件內巢狀 node_modules 指向樹外時應退 2 拒絕啟動');
      assert.match(nestedNmExtRes.lines.join('\n'), /本機套件內含指向工作樹外的連結/u);
      assert.equal(nestedNmPosts, 0, 'R2：巢狀 node_modules 拒啟時代貼次數必須為 0');
      assert.ok(!fs.existsSync(reviewFolder), 'R2：巢狀 node_modules 拒啟回滾後不應留下複審容器');

      // R2 外部連結防呆（五）：工作樹內 symlink + .. 誘餌逃逸（packages/shared/src -> ../bridge/../leak，其中 packages/bridge -> deep/shared、packages/deep/leak -> 樹外，另設樹內 packages/leak 誘餌）
      sh(implWt, 'checkout', '--detach', '-q', wsHead);
      fs.mkdirSync(path.join(implWt, 'packages', 'deep', 'shared'), { recursive: true });
      fs.writeFileSync(path.join(implWt, 'packages', 'deep', 'shared', '.keep'), '\n');
      fs.mkdirSync(path.join(implWt, 'packages', 'leak'), { recursive: true });
      fs.writeFileSync(path.join(implWt, 'packages', 'leak', 'index.js'), 'export const wsValue = "IN_TREE_DECOY";\n');
      fs.symlinkSync('deep/shared', path.join(implWt, 'packages', 'bridge'), 'dir');
      fs.symlinkSync(extSharedTarget, path.join(implWt, 'packages', 'deep', 'leak'), 'dir');
      fs.symlinkSync('../bridge/../leak', path.join(implWt, 'packages', 'shared', 'src'), 'dir');
      fs.writeFileSync(path.join(implWt, 'packages', 'shared', 'index.js'), 'export { wsValue } from "./src/index.js";\n');
      sh(
        implWt,
        'add',
        'packages/deep/shared/.keep',
        'packages/leak/index.js',
        'packages/bridge',
        'packages/deep/leak',
        'packages/shared/src',
        'packages/shared/index.js',
      );
      sh(implWt, 'commit', '-q', '-m', 'symlink plus dotdot escape with in-tree decoy');
      const dotdotExtHead = sh(implWt, 'rev-parse', 'HEAD');
      sh(implWt, 'checkout', '--detach', '-q', wsHead);
      let dotdotExtPosts = 0;
      const dotdotExtRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
        settings: s,
        platform: fakePlatform({ ...wsAns, change: { ...wsAns.change, headSha: dotdotExtHead } }),
        cwd: implWt,
        template: TEMPLATE,
        leftoverRoots: [],
        runPost() { dotdotExtPosts += 1; },
      });
      assert.equal(dotdotExtRes.code, 2, 'R2：工作樹內 symlink + .. 穿越指向樹外時應退 2 拒絕啟動');
      assert.match(dotdotExtRes.lines.join('\n'), /本機套件內含指向工作樹外的連結/u);
      assert.equal(dotdotExtPosts, 0, 'R2：symlink + .. 拒啟時代貼次數必須為 0');
      assert.ok(!fs.existsSync(reviewFolder), 'R2：symlink + .. 拒啟回滾後不應留下複審容器');
      assert.equal(
        fs.readFileSync(path.join(extSharedTarget, 'index.js'), 'utf8'),
        'export const wsValue = "EXTERNAL_UNREVIEWED";\n',
        'R2：樹外目錄內容不得被動到',
      );

      // R2 外部連結防呆（六）：node_modules 內相對連結含 symlink + .. 穿過工作區連結指向樹外（node_modules/fake-dep/alias.js -> ../ws-shared/../payload.js，且設 node_modules/payload.js 誘餌）
      const nmDecoyPayload = path.join(r.dir, 'node_modules', 'payload.js');
      const nmAliasLink = path.join(depDir, 'alias.js');
      const wsPayloadInMain = path.join(r.dir, 'packages', 'payload.js');
      fs.writeFileSync(nmDecoyPayload, 'export const payload = "NM_DECOY";\n');
      fs.writeFileSync(wsPayloadInMain, 'export const payload = "MAIN_SAFE_PAYLOAD";\n');
      fs.symlinkSync('../ws-shared/../payload.js', nmAliasLink);
      try {
        sh(implWt, 'checkout', '--detach', '-q', wsHead);
        fs.symlinkSync(path.join(extSharedTarget, 'index.js'), path.join(implWt, 'packages', 'payload.js'));
        sh(implWt, 'add', 'packages/payload.js');
        sh(implWt, 'commit', '-q', '-m', 'workspace payload symlink to outside via nm bridge dotdot');
        const nmDotdotExtHead = sh(implWt, 'rev-parse', 'HEAD');
        sh(implWt, 'checkout', '--detach', '-q', wsHead);
        let nmDotdotPosts = 0;
        const nmDotdotRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
          settings: s,
          platform: fakePlatform({ ...wsAns, change: { ...wsAns.change, headSha: nmDotdotExtHead } }),
          cwd: implWt,
          template: TEMPLATE,
          leftoverRoots: [],
          runPost() { nmDotdotPosts += 1; },
        });
        assert.equal(nmDotdotRes.code, 2, 'R2：node_modules 內相對連結經 symlink + .. 穿過工作區連結指向樹外時應退 2 拒絕啟動');
        assert.match(nmDotdotRes.lines.join('\n'), /指向工作樹外/u);
        assert.equal(nmDotdotPosts, 0, 'R2：node_modules symlink + .. 拒啟時代貼次數必須為 0');
        assert.ok(!fs.existsSync(reviewFolder), 'R2：node_modules symlink + .. 拒啟回滾後不應留下複審容器');
      } finally {
        fs.rmSync(nmAliasLink, { force: true });
        fs.rmSync(nmDecoyPayload, { force: true });
        fs.rmSync(wsPayloadInMain, { force: true });
      }

      // R2 控制組（七）：安全的樹內目錄連結（含工作區入口本身帶 symlink + ..、內部 symlink + .. 樹內路徑與循環連結防呆）應正常放行，且寫入突變副本不會影響審查樹或主目錄
      sh(implWt, 'checkout', '--detach', '-q', wsHead);
      fs.mkdirSync(path.join(implWt, 'safe-internal-src'), { recursive: true });
      fs.writeFileSync(path.join(implWt, 'safe-internal-src', 'real.js'), 'export const wsValue = "COMMITTED_SAFE";\n');
      fs.symlinkSync('../packages/shared', path.join(implWt, 'safe-internal-src', 'back-loop'), 'dir');
      fs.mkdirSync(path.join(implWt, 'packages', 'deep', 'shared'), { recursive: true });
      fs.writeFileSync(path.join(implWt, 'packages', 'deep', 'shared', '.keep'), '\n');
      fs.mkdirSync(path.join(implWt, 'packages', 'deep', 'safe-dotdot'), { recursive: true });
      fs.writeFileSync(path.join(implWt, 'packages', 'deep', 'safe-dotdot', 'real.txt'), 'COMMITTED_SAFE_DOTDOT\n');
      fs.mkdirSync(path.join(implWt, 'packages', 'safe-dotdot'), { recursive: true });
      fs.writeFileSync(path.join(implWt, 'packages', 'safe-dotdot', 'real.txt'), 'LEXICAL_DECOY_WRONG\n');
      fs.mkdirSync(path.join(implWt, '..pkg'), { recursive: true });
      fs.writeFileSync(path.join(implWt, '..pkg', 'data.txt'), 'DOTS_SAFE_VALUE\n');
      fs.symlinkSync('deep/shared', path.join(implWt, 'packages', 'bridge'), 'dir');
      fs.symlinkSync('../../safe-internal-src', path.join(implWt, 'packages', 'shared', 'src'), 'dir');
      fs.symlinkSync('../bridge/../safe-dotdot', path.join(implWt, 'packages', 'shared', 'dotdot-src'), 'dir');
      fs.writeFileSync(path.join(implWt, 'packages', 'shared', 'index.js'), 'export { wsValue } from "./src/real.js";\n');
      sh(
        implWt,
        'add',
        'safe-internal-src/real.js',
        'safe-internal-src/back-loop',
        'packages/deep/shared/.keep',
        'packages/deep/safe-dotdot/real.txt',
        'packages/safe-dotdot/real.txt',
        '..pkg/data.txt',
        'packages/bridge',
        'packages/shared/src',
        'packages/shared/dotdot-src',
        'packages/shared/index.js',
      );
      sh(implWt, 'commit', '-q', '-m', 'safe internal directory symlink with dotdot, dotprefix, and cycle');
      const safeInternalHead = sh(implWt, 'rev-parse', 'HEAD');
      sh(implWt, 'checkout', '--detach', '-q', wsHead);

      // 在主工作樹也準備對應的 packages/bridge -> deep/shared、node_modules/ws-dotdot-entry -> ../packages/bridge/../safe-dotdot 與 node_modules/ws-dotprefix -> ../..pkg
      const mainDeepShared = path.join(r.dir, 'packages', 'deep', 'shared');
      const mainDeepDotdot = path.join(r.dir, 'packages', 'deep', 'safe-dotdot');
      const mainDecoyDotdot = path.join(r.dir, 'packages', 'safe-dotdot');
      const mainDotPrefixDir = path.join(r.dir, '..pkg');
      const mainBridgeLink = path.join(r.dir, 'packages', 'bridge');
      const mainWsDotdotEntry = path.join(r.dir, 'node_modules', 'ws-dotdot-entry');
      const mainWsDotPrefixEntry = path.join(r.dir, 'node_modules', 'ws-dotprefix');
      fs.mkdirSync(mainDeepShared, { recursive: true });
      fs.mkdirSync(mainDeepDotdot, { recursive: true });
      fs.writeFileSync(path.join(mainDeepDotdot, 'real.txt'), 'MAIN_SAFE_DOTDOT\n');
      fs.mkdirSync(mainDecoyDotdot, { recursive: true });
      fs.writeFileSync(path.join(mainDecoyDotdot, 'real.txt'), 'MAIN_LEXICAL_DECOY\n');
      fs.mkdirSync(mainDotPrefixDir, { recursive: true });
      fs.writeFileSync(path.join(mainDotPrefixDir, 'data.txt'), 'MAIN_DOTS_SAFE\n');
      fs.symlinkSync('deep/shared', mainBridgeLink, 'dir');
      fs.symlinkSync('../packages/bridge/../safe-dotdot', mainWsDotdotEntry, 'dir');
      fs.symlinkSync('../..pkg', mainWsDotPrefixEntry, 'dir');
      try {
        let safeInternalPosts = 0;
        const safeInternalRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
          settings: s,
          platform: fakePlatform({ ...wsAns, change: { ...wsAns.change, headSha: safeInternalHead } }),
          cwd: implWt,
          template: TEMPLATE,
          leftoverRoots: [],
          runExec(_cmd, { record }) {
            for (const targetCwd of [record.tree, record.mutation]) {
              const probe = spawnSync(
                process.execPath,
                ['--input-type=module', '-e', 'const w = await import("ws-shared"); if (w.wsValue !== "COMMITTED_SAFE") process.exit(1);'],
                { cwd: targetCwd, env: gitEnv(), encoding: 'utf8' },
              );
              assert.equal(probe.status, 0, 'R2 控制組：安全內部連結應載入 COMMITTED_SAFE');
              assert.equal(
                fs.readFileSync(path.join(targetCwd, 'node_modules', 'ws-shared', 'dotdot-src', 'real.txt'), 'utf8'),
                'COMMITTED_SAFE_DOTDOT\n',
                'R2 控制組：安全樹內 symlink + .. 應讀到核心展開後的 COMMITTED_SAFE_DOTDOT',
              );
              assert.equal(
                fs.readFileSync(path.join(targetCwd, 'node_modules', 'ws-dotdot-entry', 'real.txt'), 'utf8'),
                'COMMITTED_SAFE_DOTDOT\n',
                'R2 控制組：工作區入口本身含 symlink + .. 時應重綁並讀到受審版 COMMITTED_SAFE_DOTDOT',
              );
              assert.equal(
                fs.readFileSync(path.join(targetCwd, 'node_modules', 'ws-dotprefix', 'data.txt'), 'utf8'),
                'DOTS_SAFE_VALUE\n',
                'R2 控制組：合法雙點前綴目錄 ..pkg 應重綁並讀到受審版 DOTS_SAFE_VALUE',
              );
            }
            // 寫入突變副本的內部連結目標，確認審查樹仍讀到 COMMITTED_SAFE，再還原突變副本以通過乾淨檢查
            const mutRealFile = path.join(record.mutation, 'node_modules', 'ws-shared', 'src', 'real.js');
            const origMutReal = fs.readFileSync(mutRealFile, 'utf8');
            fs.writeFileSync(mutRealFile, 'export const wsValue = "MUTATED_INTERNAL";\n');
            const mutDotdotFile = path.join(record.mutation, 'node_modules', 'ws-dotdot-entry', 'real.txt');
            const origMutDotdot = fs.readFileSync(mutDotdotFile, 'utf8');
            fs.writeFileSync(mutDotdotFile, 'MUTATED_DOTDOT\n');
            const treeCheck = spawnSync(
              process.execPath,
              ['--input-type=module', '-e', 'const w = await import("ws-shared"); if (w.wsValue !== "COMMITTED_SAFE") process.exit(1);'],
              { cwd: record.tree, env: gitEnv(), encoding: 'utf8' },
            );
            assert.equal(treeCheck.status, 0, 'R2 控制組：改寫突變副本內部連結目標不得影響唯讀審查樹');
            assert.equal(
              fs.readFileSync(path.join(record.tree, 'node_modules', 'ws-dotdot-entry', 'real.txt'), 'utf8'),
              'COMMITTED_SAFE_DOTDOT\n',
              'R2 控制組：改寫突變副本入口 symlink + .. 目標不得影響唯讀審查樹',
            );
            fs.writeFileSync(mutRealFile, origMutReal);
            fs.writeFileSync(mutDotdotFile, origMutDotdot);
            fs.writeFileSync(
              record.outFile,
              `🤖 Beta｜來源：beta CLI｜審 \`${safeInternalHead.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
            );
          },
          runPost() { safeInternalPosts += 1; },
        });
        assert.equal(safeInternalRes.code, 0, `R2 控制組：安全樹內目錄連結應成功執行並收樹：${safeInternalRes.lines.join('\n')}`);
        assert.equal(safeInternalPosts, 1, 'R2 控制組：代貼次數應為 1');
        assert.ok(!fs.existsSync(reviewFolder), 'R2 控制組：完成後容器應已清除');

        // 驗證工作區入口本身含 symlink + .. 與雙點前綴目錄 ..pkg 時，掃描（--scan）、直接 materializeIsolatedGitRepo 皆可正常完成
        const safeScanWithPass = {
          ...wsAns,
          change: { ...wsAns.change, headSha: safeInternalHead },
          comments: [
            {
              id: '502',
              createdAt: '2026-10-20T00:00:00Z',
              body: `🤖 Beta｜來源：beta CLI｜審 \`${safeInternalHead.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n`,
            },
          ],
        };
        const safeDotdotScanLaunch = main(['--scan', '7', '--dir', dir], {
          settings: s,
          platform: fakePlatform(safeScanWithPass),
          cwd: implWt,
          leftoverRoots: [],
        });
        assert.equal(safeDotdotScanLaunch.code, 0, `R2 控制組：含 symlink + .. 與 ..pkg 入口之 --scan 應退 0：${safeDotdotScanLaunch.lines.join('\n')}`);
        const isoDotdotDest = path.join(altTargetDir, 'iso-dotdot-ok');
        materializeIsolatedGitRepo(safeDotdotScanLaunch.record.tree, isoDotdotDest, {
          rootRepo: r.dir,
          baseSha: r.base,
          headSha: safeInternalHead,
        });
        assert.equal(
          fs.readFileSync(path.join(isoDotdotDest, 'node_modules', 'ws-dotdot-entry', 'real.txt'), 'utf8'),
          'COMMITTED_SAFE_DOTDOT\n',
          'R2 控制組：materializeIsolatedGitRepo 複製含 symlink + .. 入口後應讀到 COMMITTED_SAFE_DOTDOT',
        );
        assert.equal(
          fs.readFileSync(path.join(isoDotdotDest, 'node_modules', 'ws-dotprefix', 'data.txt'), 'utf8'),
          'DOTS_SAFE_VALUE\n',
          'R2 控制組：materializeIsolatedGitRepo 複製含 ..pkg 雙點前綴入口後應讀到 DOTS_SAFE_VALUE',
        );
        const isoDotdotDirect = path.join(altTargetDir, 'iso-dotdot-direct-ok');
        materializeIsolatedGitRepo(r.dir, isoDotdotDirect, {
          rootRepo: r.dir,
          baseSha: r.base,
          headSha: safeInternalHead,
        });
        assert.equal(
          fs.readFileSync(path.join(isoDotdotDirect, 'node_modules', 'ws-dotdot-entry', 'real.txt'), 'utf8'),
          'COMMITTED_SAFE_DOTDOT\n',
          'R2 控制組：直接對含原始 ../packages/bridge/../safe-dotdot 之來源樹執行 materializeIsolatedGitRepo 亦應讀到 COMMITTED_SAFE_DOTDOT',
        );
        assert.equal(
          fs.readFileSync(path.join(isoDotdotDirect, 'node_modules', 'ws-dotprefix', 'data.txt'), 'utf8'),
          'DOTS_SAFE_VALUE\n',
          'R2 控制組：直接對含原始 ../..pkg 之來源樹執行 materializeIsolatedGitRepo 亦應讀到 DOTS_SAFE_VALUE',
        );
        assert.equal(main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);
      } finally {
        fs.rmSync(mainWsDotPrefixEntry, { force: true });
        fs.rmSync(mainWsDotdotEntry, { force: true });
        fs.rmSync(mainBridgeLink, { force: true });
        fs.rmSync(mainDotPrefixDir, { recursive: true, force: true });
        fs.rmSync(path.join(r.dir, 'packages', 'deep'), { recursive: true, force: true });
        fs.rmSync(mainDecoyDotdot, { recursive: true, force: true });
      }

      // (八) 來源 node_modules 指向 .git、工作樹根目錄、或含 symlink + .. 之 gitdir／commondir 及目錄型 .git/commondir 時，複審、掃描與隔離複製皆須退 2 拒啟且不得複製 config
      const mainNm = path.join(r.dir, 'node_modules');
      const mainDotGit = path.join(r.dir, '.git');
      const mainGitConfigPath = path.join(mainDotGit, 'config');
      const origGitConfig = fs.readFileSync(mainGitConfigPath, 'utf8');
      const backupMainNm = path.join(altTargetDir, 'backup-main-node-modules');
      const backupDotGit = path.join(altTargetDir, 'backup-main-dotgit');
      fs.renameSync(mainNm, backupMainNm);
      fs.writeFileSync(mainGitConfigPath, `${origGitConfig}\n# SYNTHETIC_GIT_CONFIG_SECRET_9999\n`);
      fs.cpSync(mainDotGit, backupDotGit, { recursive: true });
      try {
        const assertRejectedGitSource = (label, targetRel) => {
          fs.symlinkSync(targetRel, mainNm, 'dir');
          try {
            let badExecCalled = false;
            let badPosts = 0;
            const badRevRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
              settings: s,
              platform: fakePlatform(wsAns),
              cwd: r.dir,
              template: TEMPLATE,
              leftoverRoots: [],
              runExec() { badExecCalled = true; },
              runPost() { badPosts += 1; },
            });
            assert.equal(badRevRes.code, 2, `R2（${label}）：複審應退 2 拒絕啟動`);
            assert.equal(badExecCalled, false, `R2（${label}）：拒絕啟動時不得呼叫模型`);
            assert.equal(badPosts, 0, `R2（${label}）：拒絕啟動時代貼次數應為 0`);
            assert.ok(!fs.existsSync(reviewFolder), `R2（${label}）：回滾後不應殘留複審容器`);

            const badScanRes = main(['--scan', '7', '--run', '--purge', '--dir', dir], {
              settings: s,
              platform: fakePlatform(wsWithPass),
              cwd: r.dir,
              leftoverRoots: [],
              runExec() { badExecCalled = true; },
              runPost() { badPosts += 1; },
            });
            assert.equal(badScanRes.code, 2, `R2（${label}）：掃描應退 2 拒絕啟動`);
            assert.equal(badExecCalled, false, `R2（${label}）：掃描拒絕啟動時不得呼叫模型`);

            const badIsoDest = path.join(altTargetDir, `iso-bad-${Buffer.from(label).toString('hex').slice(0, 24)}`);
            assert.throws(
              () => materializeIsolatedGitRepo(r.dir, badIsoDest, {
                rootRepo: r.dir,
                baseSha: r.base,
                headSha: wsHead,
              }),
              /管理目錄|工作樹/u,
              `R2（${label}）：materializeIsolatedGitRepo 應拒絕複製`,
            );
            assert.ok(
              !fs.existsSync(path.join(badIsoDest, 'node_modules', 'config')),
              `R2（${label}）：不得將 .git/config 複製進 node_modules`,
            );
          } finally {
            fs.rmSync(mainNm, { force: true });
          }
        };

        assertRejectedGitSource('來源 node_modules -> .git', '.git');
        assertRejectedGitSource('來源 node_modules -> 工作樹根目錄', '.');

        // 配置 1：.git 檔案寫 gitdir: bridge/../admin，其中 bridge -> deep/leaf（實際 gitdir 為 deep/admin）
        const deepLeaf = path.join(r.dir, 'deep', 'leaf');
        const deepAdmin = path.join(r.dir, 'deep', 'admin');
        const topBridge = path.join(r.dir, 'bridge');
        fs.mkdirSync(deepLeaf, { recursive: true });
        fs.symlinkSync('deep/leaf', topBridge, 'dir');
        fs.renameSync(mainDotGit, deepAdmin);
        fs.writeFileSync(mainDotGit, 'gitdir: bridge/../admin\n');
        try {
          assertRejectedGitSource('gitfile 含 symlink + ..（bridge/../admin）', 'deep/admin');
        } finally {
          fs.rmSync(mainDotGit, { force: true });
          fs.renameSync(deepAdmin, mainDotGit);
          fs.rmSync(topBridge, { force: true });
          fs.rmSync(path.join(r.dir, 'deep'), { recursive: true, force: true });
        }

        // 配置 2：.git 檔案指 per-tree，其中 commondir 寫 bridge/../common，bridge -> ../deep/leaf（實際 commondir 為 deep/common）
        const perTreeDir = path.join(r.dir, 'per-tree');
        const deepCommon = path.join(r.dir, 'deep', 'common');
        fs.mkdirSync(path.join(r.dir, 'deep', 'leaf'), { recursive: true });
        fs.renameSync(mainDotGit, deepCommon);
        fs.mkdirSync(perTreeDir, { recursive: true });
        fs.copyFileSync(path.join(deepCommon, 'HEAD'), path.join(perTreeDir, 'HEAD'));
        fs.symlinkSync('../deep/leaf', path.join(perTreeDir, 'bridge'), 'dir');
        fs.writeFileSync(path.join(perTreeDir, 'commondir'), 'bridge/../common\n');
        fs.writeFileSync(mainDotGit, 'gitdir: per-tree\n');
        try {
          assertRejectedGitSource('gitfile + commondir 含 symlink + ..（bridge/../common）', 'deep/common');
        } finally {
          fs.rmSync(mainDotGit, { force: true });
          fs.renameSync(deepCommon, mainDotGit);
          fs.rmSync(perTreeDir, { recursive: true, force: true });
          fs.rmSync(path.join(r.dir, 'deep'), { recursive: true, force: true });
        }

        // 配置 3：.git 是目錄，其中 commondir 寫 ../deep/common（實際共享管理目錄為 deep/common）
        const dirCommon = path.join(r.dir, 'deep', 'common');
        fs.mkdirSync(path.join(r.dir, 'deep'), { recursive: true });
        fs.cpSync(mainDotGit, dirCommon, { recursive: true });
        fs.writeFileSync(path.join(mainDotGit, 'commondir'), '../deep/common\n');
        try {
          assertRejectedGitSource('目錄型 .git 含 commondir（../deep/common）', 'deep/common');
        } finally {
          fs.rmSync(path.join(mainDotGit, 'commondir'), { force: true });
          fs.rmSync(path.join(r.dir, 'deep'), { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(mainDotGit, { recursive: true, force: true });
        fs.cpSync(backupDotGit, mainDotGit, { recursive: true });
        fs.writeFileSync(mainGitConfigPath, origGitConfig);
        fs.renameSync(backupMainNm, mainNm);
      }

      // 配置 4 與 5（r9 正向控制）：當 gitdir 或目錄型 .git/commondir 含 symlink + .. 且其實際管理目錄在 deep/node_modules、
      // 但 path.resolve 詞法折疊位置恰好是工作樹根下的正常 node_modules 時，複審、掃描與隔離複製皆不得誤擋普通依賴
      const assertAllowedOrdinaryNm = (label) => {
        let okRevPosts = 0;
        const okRevRes = main(['7', '--reviewer', 'Beta', '--run', '--purge', '--dir', dir], {
          settings: s,
          platform: fakePlatform(wsAns),
          cwd: r.dir,
          template: TEMPLATE,
          leftoverRoots: [],
          runExec(_cmd, { record }) {
            assert.equal(
              fs.readFileSync(path.join(record.tree, 'node_modules', 'fake-dep', 'index.js'), 'utf8'),
              scanSeedContent,
              `R2 正例（${label}）：審查樹應正常掛載並讀到普通依賴`,
            );
            fs.writeFileSync(
              record.outFile,
              `🤖 Beta｜來源：beta CLI｜審 \`${wsHead.slice(0, 7)}\`｜r1｜結論：通過\n\n### 本輪實際用的設定\n- ok\n\n### 清單逐項結果\n- ok\n未貼\n`,
            );
          },
          runPost() { okRevPosts += 1; },
        });
        assert.equal(okRevRes.code, 0, `R2 正例（${label}）：複審應退 0 正常完成：${okRevRes.lines.join('\n')}`);
        assert.equal(okRevPosts, 1, `R2 正例（${label}）：複審應代貼 1 次`);

        let okScanPosts = 0;
        const okScanRes = main(['--scan', '7', '--run', '--purge', '--dir', dir], {
          settings: s,
          platform: fakePlatform(wsWithPass),
          cwd: r.dir,
          leftoverRoots: [],
          runExec(_cmd, { record }) {
            assert.equal(
              fs.readFileSync(path.join(record.tree, 'node_modules', 'fake-dep', 'index.js'), 'utf8'),
              scanSeedContent,
              `R2 正例（${label}）：掃描樹應正常掛載並讀到普通依賴`,
            );
            fs.writeFileSync(
              record.outFile,
              `🔍 Gamma｜來源：Grok CLI｜掃 \`${wsHead.slice(0, 7)}\`\n\n### 本次實際用的設定\n- ok\n\n### 掃描結果\n- 零發現\n未貼\n`,
            );
          },
          runPost() { okScanPosts += 1; },
        });
        assert.equal(okScanRes.code, 0, `R2 正例（${label}）：掃描應退 0 正常完成：${okScanRes.lines.join('\n')}`);
        assert.equal(okScanPosts, 1, `R2 正例（${label}）：掃描應代貼 1 次`);

        const okIsoDest = path.join(altTargetDir, `iso-ok-${Buffer.from(label).toString('hex').slice(0, 24)}`);
        materializeIsolatedGitRepo(r.dir, okIsoDest, {
          rootRepo: r.dir,
          baseSha: r.base,
          headSha: wsHead,
        });
        assert.equal(
          fs.readFileSync(path.join(okIsoDest, 'node_modules', 'fake-dep', 'index.js'), 'utf8'),
          scanSeedContent,
          `R2 正例（${label}）：materializeIsolatedGitRepo 應正常複製普通依賴`,
        );
      };

      // 配置 4：.git 檔案寫 gitdir: bridge/../node_modules（bridge -> deep/leaf，實際管理目錄為 deep/node_modules，詞法折疊位置為根目錄普通 node_modules）
      try {
        const posDeepLeaf = path.join(r.dir, 'deep', 'leaf');
        const posActualGit = path.join(r.dir, 'deep', 'node_modules');
        const posTopBridge = path.join(r.dir, 'bridge');
        fs.mkdirSync(posDeepLeaf, { recursive: true });
        fs.symlinkSync('deep/leaf', posTopBridge, 'dir');
        fs.renameSync(mainDotGit, posActualGit);
        fs.writeFileSync(mainDotGit, 'gitdir: bridge/../node_modules\n');
        assertAllowedOrdinaryNm('gitdir: bridge/../node_modules 詞法折疊至普通 node_modules');
      } finally {
        fs.rmSync(path.join(r.dir, 'bridge'), { force: true });
        fs.rmSync(mainDotGit, { recursive: true, force: true });
        fs.cpSync(backupDotGit, mainDotGit, { recursive: true });
        fs.rmSync(path.join(r.dir, 'deep'), { recursive: true, force: true });
      }

      // 配置 5：.git 為目錄，.git/bridge -> ../deep/nested/leaf，.git/commondir 寫 bridge/../../node_modules（實際共享管理目錄為 deep/node_modules，詞法折疊位置為根目錄普通 node_modules）
      try {
        const posNestedLeaf = path.join(r.dir, 'deep', 'nested', 'leaf');
        const posCommonGit = path.join(r.dir, 'deep', 'node_modules');
        fs.mkdirSync(posNestedLeaf, { recursive: true });
        fs.cpSync(mainDotGit, posCommonGit, { recursive: true });
        fs.symlinkSync('../deep/nested/leaf', path.join(mainDotGit, 'bridge'), 'dir');
        fs.writeFileSync(path.join(mainDotGit, 'commondir'), 'bridge/../../node_modules\n');
        assertAllowedOrdinaryNm('.git/commondir: bridge/../../node_modules 詞法折疊至普通 node_modules');
      } finally {
        fs.rmSync(mainDotGit, { recursive: true, force: true });
        fs.cpSync(backupDotGit, mainDotGit, { recursive: true });
        fs.rmSync(path.join(r.dir, 'deep'), { recursive: true, force: true });
      }

      // R4 與 BACKLOG.md 第 89 行：materializeIsolatedGitRepo 驗證 cp 退非零、啟動失敗、部分複製皆須拋錯並阻止 runGrokExec 啟動模型或代貼
      const isoScanLaunch = main(['--scan', '7', '--dir', dir], {
        settings: s,
        platform: fakePlatform(wsWithPass),
        cwd: implWt,
        leftoverRoots: [],
      });
      assert.equal(isoScanLaunch.code, 0);
      const isoDestOk = path.join(altTargetDir, 'iso-ok');
      materializeIsolatedGitRepo(isoScanLaunch.record.tree, isoDestOk, {
        rootRepo: r.dir,
        baseSha: r.base,
        headSha: wsHead,
        extraShas: [r.head],
      });
      assert.equal(
        spawnSync('git', ['cat-file', '-e', `${r.head}^{commit}`], { cwd: isoDestOk, env: gitEnv() }).status,
        0,
        '非祖先 extraShas 提交仍須保留在盒內物件庫',
      );
      const isoProbe = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', 'const m = await import("fake-dep"); const w = await import("ws-shared"); if (m.depValue !== "SCAN_SEED_CONTENT_KEEP_EXACT" || w.wsValue !== "HEAD_VALUE") process.exit(1);'],
        { cwd: isoDestOk, env: gitEnv(), encoding: 'utf8' },
      );
      assert.equal(isoProbe.status, 0, '盒內隔離工作樹應可正常載入一般依賴與工作區依賴');

      // 驗證 cp 退 42（含已完整複製檔案但退 42）、啟動失敗（ENOENT）、部分複製（退 0 但漏拷檔案）時 materializeIsolatedGitRepo 與 runGrokExec 皆拒絕啟動模型且不代貼
      const r4AuthFile = path.join(altTargetDir, 'r4-auth.json');
      const r4EntryKey = `${GROK_PINNED_ISSUER}::${GROK_PINNED_CLIENT_ID}`;
      fs.writeFileSync(
        r4AuthFile,
        JSON.stringify({
          [r4EntryKey]: {
            auth_mode: 'oidc',
            user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            create_time: '2026-10-19T00:00:00.000Z',
            expires_at: '2026-10-19T02:00:00.000Z',
            oidc_issuer: GROK_PINNED_ISSUER,
            oidc_client_id: GROK_PINNED_CLIENT_ID,
            key: 'R4-KEY-SECRET-9999',
            refresh_token: 'R4-REFRESH-SECRET-9999',
          },
        }),
        { mode: 0o600 },
      );
      const r4GrokBin = path.join(altTargetDir, 'fake-grok');
      fs.writeFileSync(r4GrokBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      for (const [caseLabel, fakeCopySpawn] of [
        [
          'cp 退 42（已複製但狀態碼非零）',
          (cmd, args) => {
            spawnSync(cmd, args, { encoding: 'utf8' });
            return { status: 42, signal: null, error: null, stdout: '', stderr: 'simulated cp failure' };
          },
        ],
        ['cp 起不來', () => ({ status: null, signal: null, error: Object.assign(new Error('spawn cp ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' })],
        [
          'cp 部分複製（退 0 但漏檔）',
          (_cmd, args) => {
            const dst = args[args.length - 1];
            fs.mkdirSync(path.join(dst, 'fake-dep'), { recursive: true });
            fs.writeFileSync(path.join(dst, 'fake-dep', 'package.json'), pkgJsonContent);
            // 故意漏拷 fake-dep/index.js 與 ws-shared
            return { status: 0, signal: null, error: null, stdout: '', stderr: '' };
          },
        ],
      ]) {
        assert.throws(
          () => materializeIsolatedGitRepo(isoScanLaunch.record.tree, path.join(altTargetDir, `iso-fail-${ Buffer.from(caseLabel).toString('hex') }`), {
            rootRepo: r.dir,
            baseSha: r.base,
            headSha: wsHead,
            copySpawn: fakeCopySpawn,
          }),
          /node_modules/u,
          `R4（${caseLabel}）：materializeIsolatedGitRepo 應拋出 LaunchError`,
        );
        let childCalled = false;
        let r4Posts = 0;
        const grokFailRes = await runGrokExec([
          '--mode', 'scan',
          '--cwd', isoScanLaunch.record.tree,
          '--model', 'grok-4.7',
          '--reasoning-effort', 'xhigh',
          '--prompt-file', isoScanLaunch.record.promptFile,
          '--out', isoScanLaunch.record.outFile,
        ], {
          authFile: r4AuthFile,
          authOpts: { now: () => Date.parse('2026-10-19T00:05:00.000Z') },
          grokBin: r4GrokBin,
          probeFn: () => ({ ok: true }),
          copySpawn: fakeCopySpawn,
          spawnGrok: async () => {
            childCalled = true;
            return { status: 0, stdout: `🔍 Gamma｜來源：Grok CLI｜掃 \`${wsHead.slice(0, 7)}\`\n\n- 零發現\n`, stderr: '' };
          },
        });
        assert.equal(grokFailRes.code, 2, `R4（${caseLabel}）：runGrokExec 應退 2 拒絕啟動`);
        assert.equal(childCalled, false, `R4（${caseLabel}）：不可啟動模型子程序`);
        const postAfterFail = main(['--scan-post', '7', '--dir', dir], {
          settings: s,
          platform: fakePlatform(wsWithPass),
          runPost() { r4Posts += 1; },
        });
        assert.notEqual(postAfterFail.code, 0, `R4（${caseLabel}）：未完成隔離準備時 --scan-post 不可代貼`);
        assert.equal(r4Posts, 0, `R4（${caseLabel}）：代貼次數必須為 0`);
      }
      assert.equal(main(['--scan-close', '7', '--purge', '--dir', dir], { settings: s, leftoverRoots: [] }).code, 0);
    } finally {
      fs.rmSync(altTargetDir, { recursive: true, force: true });
    }

    spawnSync('git', ['worktree', 'remove', '--force', implWt], { cwd: r.dir, env: gitEnv() });
  } finally {
    spawnSync('git', ['worktree', 'prune'], { cwd: r.dir, env: gitEnv() });
    for (const d of [dir, r.dir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

