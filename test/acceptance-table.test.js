// @ts-check
// 驗收分級表的守表題（搬家第 6 步，2026-09-17）：分級的正本＝根目錄 settings.json 的 acceptance（路徑家族表＋每一級的動作），
// 算的是套件的 tools/acceptance-tier.js（RULES H6；只算不擋）。套件自己的考題只守「怎麼算」（tests/acceptance-tier.test.js），
// **不守本專案的表填得對不對**——而套件的讀表器對「有一筆壞就整張不算」，壞掉的表看起來像沒填、級別會整個失效。
// 所以本專案要自己釘：每一條家族配一個代表路徑、級別逐條釘住；每個追蹤檔都命中某條家族；D 級「重新整理就好」的前提還在；
// F 的位置照 William 裁示（搬家第 3 題 a：工具安全設定印在第一行）；B 的動作含 C 全文（裝完不可以停在那裡）。
// 切換前這些題住 test/acceptance-tier.test.js（釘的是舊腳本裡的 RULES／TIERS），第 6 步隨舊腳本退役、改讀設定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../lib/git-env.js';
import { injectDirtyGitEnv, assertChildGitEnvClean } from './helpers/dirty-git-env.js';
import { visible } from './helpers/markdown-visible.js';
import { classify, tableOf } from '../tools/acceptance-tier.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');
const settings = JSON.parse(read('settings.json'));
const table = tableOf(settings);
const tierId = (/** @type {string} */ letter) => {
  const t = settings.acceptance.tiers.find((x) => x.id.startsWith(letter));
  assert.ok(t, `settings.json 的 acceptance.tiers 沒有 ${letter} 這一級`);
  return t.id;
};
const tierOf = (/** @type {string} */ p) => classify([p], table).hits[0];

test('分級表讀得起來（套件對「有一筆壞就整張不算」：這題紅＝整張表失效、每一支都算不出級別）', () => {
  assert.ok(table, 'tools/acceptance-tier.js 的 tableOf() 對 settings.json 回 null——家族樣式沒錨定、級別名對不上、或正規式壞了');
  for (const f of settings.acceptance.families) assert.ok(f.pattern.startsWith('^'), `${f.pattern} 沒有錨在開頭（會命中路徑中段）`);
  for (const t of settings.acceptance.tiers) assert.ok(t.action.length > 10, `${t.id} 沒有動作`);
});

test('⭐ 每一條家族的級別逐條釘住：多一條、少一條、或把任何一條換到別級（例：render.yaml C→E），這題要紅', () => {
  /** 與 settings.acceptance.families **同序**，每條一個代表路徑；新增家族就得在這裡補一行（長度對不上就紅）。 @type {[string, string][]} */
  const FAMILY_SAMPLES = [
    ['F', '.codex/hooks.json'], ['F', '.claude/settings.json'], ['F', 'settings.json'], ['F', 'tools/forbidden-tools.js'],
    ['F', 'tools/package.json'], ['F', 'templates/hook-codex-global.json'], ['F', '.mcp.json'], ['F', 'tools/canary-server.js'],
    ['A', 'db/supabase-schema.sql'],
    ['B', 'package-lock.json'],
    ['C', 'lib/store.js'], ['C', 'server.js'], ['C', 'start.command'], ['C', '.node-version'], ['C', 'render.yaml'], ['C', 'scripts/check-node-version.js'],
    ['D', 'public/app.js'], ['D', 'public-site/index.html'],
    ['P', 'prototype/forest-ui-lab/index.html'],
    ['E', 'test/x.test.js'], ['E', 'test-doubles/x.js'], ['E', 'docs/contracts/README.md'], ['E', 'AGENTS.md'], ['E', '.github/workflows/ci.yml'],
    ['E', 'data/seed.json'],   // 只在空庫首次啟動時種進去，重啟驗不到（Grok #573 掃後）
    ['E', 'scripts/grok-scan.js'], ['E', 'scripts/grok-sandbox.sb'], ['E', 'scripts/git-hooks/pre-push'], ['E', 'eslint.config.js'], ['E', '.claude/launch.json'],
    ['E', 'tools/merge.js'], ['E', 'tests/merge.test.js'], ['E', 'templates/pre-push'], ['E', 'rules.json'],
  ];
  const families = settings.acceptance.families;
  assert.equal(FAMILY_SAMPLES.length, families.length, 'families 與 FAMILY_SAMPLES 條數不同——新增／刪除家族要同步這張表');
  FAMILY_SAMPLES.forEach(([letter, sample], i) => {
    const re = new RegExp(families[i].pattern, 'u');
    assert.ok(re.test(sample), `第 ${i + 1} 條 ${families[i].pattern} 對不上樣本 ${sample}——兩張表的順序漂了`);
    assert.equal(families[i].tier, tierId(letter), `第 ${i + 1} 條（${sample}）的級別被換成 ${families[i].tier}，釘的是 ${letter}`);
    const hit = tierOf(sample);
    assert.ok(hit.known && hit.tier === tierId(letter), `${sample} 被更上面的家族先攔走了（算成 ${hit.tier}）`);
  });
  assert.equal(tierOf('package.json').tier, tierId('B'));
  // E 的腳本必須是明確名單：scripts/ 裡沒點名的新腳本＝沒列到（當 unknownTier）——寬鬆的 check-* 會把未來被啟動流程掛上的新腳本靜靜當成不需驗收（#573 r3）
  assert.equal(tierOf('scripts/check-node-version.js').tier, tierId('C'), 'start.command 每次啟動都跑它，壞了 App 起不來');
  assert.equal(tierOf('scripts/check-review-verdicts.js').tier, tierId('E'));
  assert.deepEqual(tierOf('scripts/check-runtime-health.js'), { path: 'scripts/check-runtime-health.js', tier: settings.acceptance.unknownTier, known: false });
});

test('⭐ 級別順序照 William 裁示：F（工具安全設定）排第一（搬家第 3 題 a：錢的邊界不可以排在最後被略過）；沒列到的路徑當 C；B 的動作含 C 全文', () => {
  const ids = settings.acceptance.tiers.map((t) => t.id);
  assert.equal(ids[0], tierId('F'), `acceptance.tiers 第一級是 ${ids[0]}，裁示是 F 印在第一行`);
  assert.deepEqual(ids.map((x) => x[0]), ['F', 'A', 'B', 'C', 'D', 'P', 'E'], '級別順序變了（最重在前；D／P 同重照這個順序）');
  assert.equal(settings.acceptance.unknownTier, tierId('C'), '沒列到的路徑要當 C（fail-closed：要重啟走核心流程）');
  const B = settings.acceptance.tiers.find((t) => t.id === tierId('B')).action;
  const C = settings.acceptance.tiers.find((t) => t.id === tierId('C')).action;
  assert.ok(B.includes(C), 'B（相依套件）的動作沒有含 C 的全文——套件只印命中那幾級的動作，「裝完做 C」不可以是沒展開的指示（#573 r4）');
  // F 單獨命中＝級別 F、動作只有 F；F＋E＝級別 F（第一行）、E 的動作也印
  const f = classify(['.codex/hooks.json'], table);
  assert.equal(f.level, tierId('F')); assert.deepEqual(f.actions.map((a) => a.tier), [tierId('F')]);
  const fe = classify(['.claude/settings.json', 'AGENTS.md'], table);
  assert.equal(fe.level, tierId('F')); assert.deepEqual(fe.actions.map((a) => a.tier), [tierId('F'), tierId('E')]);
  const dp = classify(['public/x.js', 'prototype/x.html'], table);
  assert.equal(dp.level, tierId('D'), '同重的 D 與 P 照表的順序，不看路徑順序');
  // D＋E：級別 D，兩級的動作都印（套件不像舊腳本只列 D；E 的動作文字自己說「另有其他級就當這行不算」——Grok #613 掃後列出的差異，照實釘）
  const de = classify(['public/x.js', 'AGENTS.md'], table);
  assert.equal(de.level, tierId('D'));
  assert.deepEqual(de.actions.map((a) => a.tier), [tierId('D'), tierId('E')]);
  // E 的動作文字要有**逐字**那一句條件句（Codex #613 r4 Medium①：只找關鍵字，「不算數」反轉成「也算數」照樣綠）——釘 D＋E 結果裡那條 E 動作
  const eInDE = de.actions.find((a) => a.tier === tierId('E'));
  assert.ok(eInDE, 'D＋E 的結果裡沒有 E 那條動作');
  assert.equal(eActionProblem(eInDE.action), null, eActionProblem(eInDE.action) ?? '');
  // 保存：反轉、刪句都要被這條判準抓到（判準是同一個函式，不是另抄一份）
  assert.ok(eActionProblem(eInDE.action.replace('這一行不算數', '這一行也算數')), '「不算數」反轉成「也算數」沒被抓到');
  assert.ok(eActionProblem(eInDE.action.replace(`${E_CLAUSE}；`, '')), '整句刪掉沒被抓到');
});

/** E 級動作文字裡那句「另有其他級時這一行不算」的逐字契約（有限、明確的文字契約，不判語意）。 */
const E_CLAUSE = '同支若另列了其他級的動作，照那些做、這一行不算數';
/** @param {string} action */
function eActionProblem(action) {
  return action.includes(E_CLAUSE) ? null : `E 的動作文字少了逐字那一句「${E_CLAUSE}」——套件會把 E 也印出來，靠這句避免被誤讀成不必驗收；實際：${action}`;
}

/** 追蹤檔清單：走 gitEnv()、先驗子行程成功再解析（git 讀不到 repo 時不可以把空輸出當成「零檔案」而全綠——#573 r3）。 */
function trackedFiles() {
  // core.quotePath=false：非 ASCII 檔名不要被印成八進位逃逸（否則對不到表）
  const r = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files'], { cwd: ROOT, encoding: 'utf8', env: gitEnv() });
  assert.equal(r.status, 0, `git ls-files 失敗（${r.stderr}）——這題不能在 git 讀不到 repo 時靜靜通過`);
  const files = r.stdout.split('\n').filter(Boolean);
  assert.ok(files.length > 50, `追蹤檔只有 ${files.length} 個——不像這個 repo，git 可能讀到別的地方`);
  return files;
}

test('現況對照：目前 repo 追蹤的每一個檔案都落在某一級（沒有未列到的），新家族出現時這題會紅、逼人補表', () => {
  const unknown = trackedFiles().filter((f) => !tierOf(f).known);
  assert.deepEqual(unknown, [], `這些追蹤檔案沒有級別（會被當 C）：${unknown.slice(0, 10).join('、')}`);
});

// 會 spawn 子行程的呼叫點各兩種 GIT_* 題（test/git-env.test.js 檔頭的規矩；射程對照在 test/helpers/dirty-git-env.js）
test('⭐ trackedFiles｜題①：髒 GIT_* 環境下答案仍正確', () => {
  const restore = injectDirtyGitEnv();
  try { assert.ok(trackedFiles().some((f) => f === 'server.js'), '髒環境下 git 讀到別的 repo（或空）——清法沒生效'); } finally { restore(); }
});

test('⭐ trackedFiles｜題②：假 git 直接看子行程環境，不可以有任何 GIT_*', () => {
  assertChildGitEnvClean(assert, 'acceptance-table 考題的 trackedFiles()', () => trackedFiles());
});

test('⭐ D 級「重新整理就好」的前提：public/ 與 public-site/ 沒有 service worker——有人加了註冊，這題要紅、逼人改 D 的動作', () => {
  // -F：逐字比對，不然 `sw.js` 的 `.` 是任意字元、會誤中 swXjs 之類的子字串（Grok #573 掃後）
  const out = spawnSync('grep', ['-rlF', '-e', 'serviceWorker', '-e', 'sw.js', join(ROOT, 'public'), join(ROOT, 'public-site')], { encoding: 'utf8' });
  assert.ok(out.status === 0 || out.status === 1, `grep 自己失敗了（${out.stderr}）——這題不能在掃不到目錄時靜靜通過`);
  const hits = out.stdout.split('\n').filter(Boolean);
  assert.deepEqual(hits, [], `前端出現 service worker 的跡象：${hits.join('、')}——「重新整理就好」不再成立，D 級的動作要改`);
});

/** 2026-09-18 搬家第 7 步刪掉的五支舊合併閘：合併路徑（工作流、鉤子、執行器、閘本體、package script、登記的閘）不得再叫它們。 */
const RETIRED_GATES = /scripts\/check-(?:ci-really-ran|cross-pr-merge|pr-collab-fields|pr-merge-gate|review-verdicts)\b/;

/**
 * `package.json` 裡哪些 script **跑得到**這兩支（含經 `npm run` 轉手的別名鏈，一路追）——只掃字面的話，
 * 加一個別名再在 CI 寫 `npm run <別名>` 就把工具變成閘（#579 r3 Medium③）。
 * @param {Record<string, string>} scripts
 */
function reachingScripts(scripts) {
  const reaching = new Set(Object.keys(scripts).filter((k) => /pending-rulings|acceptance-tier/.test(scripts[k])));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, cmd] of Object.entries(scripts)) {
      if (reaching.has(name)) continue;
      for (const m of String(cmd).matchAll(/(?:npm|pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)/g)) {
        if (reaching.has(m[1])) { reaching.add(name); grew = true; break; }
      }
    }
  }
  return [...reaching].sort();
}

test('⭐ 待裁清單與驗收分級都不是閘：CI 設定、pre-push、package.json 的 script（含別名鏈）、settings.json 的 gates、tools/merge.js 都不可以叫它們（接進「非零就擋」的地方就變成閘）', () => {
  const dir = join(ROOT, '.github/workflows');
  const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join('.github/workflows', f));
  assert.ok(workflows.length >= 2, '掃不到 workflow＝這題變空包彈（目錄名或副檔名改了？）');
  // 閘本體（tools/gates/*.js）與執行器也在射程內（第 7 步補：手冊沒寫檔名 ≠ 閘腳本沒接）；同一組檔案也不得再叫第 7 步刪掉的五支舊閘
  const gateFiles = readdirSync(join(ROOT, 'tools/gates')).filter((f) => f.endsWith('.js')).map((f) => join('tools/gates', f));
  assert.ok(gateFiles.length >= 5, `tools/gates 只列到 ${gateFiles.length} 支——掃不到閘本體，這題變空包彈`);
  for (const f of [...workflows, 'scripts/git-hooks/pre-push', 'tools/merge.js', 'tools/run-checks.js', ...gateFiles]) {
    const txt = read(f);
    assert.doesNotMatch(txt, /pending-rulings|acceptance-tier/, `${f} 叫了待裁清單或分級工具＝它變成一道會因為沒有網路或沒有權杖而擋人的閘`);
    assert.doesNotMatch(txt, RETIRED_GATES, `${f} 還在叫 2026-09-18 第 7 步刪掉的舊閘腳本（切換日起合併路徑只有 tools/gates）`);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(reachingScripts(/** @type {Record<string, string>} */ (pkg.scripts ?? {})), [], 'package.json 有 script 跑得到這兩支——CI 或 pre-push 只要寫 `npm run <別名>` 就把它變成閘，而字面掃描看不到');
  assert.doesNotMatch(JSON.stringify(pkg.scripts ?? {}), RETIRED_GATES, 'package.json 的 script 還在叫第 7 步刪掉的舊閘');
  for (const g of settings.gates) {
    const line = [g.command, ...(g.args ?? [])].join(' ');
    assert.doesNotMatch(line, /pending-rulings|acceptance-tier/, `settings.json 登記的閘「${g.name}」叫了它＝合併指令會跑它、退出碼 2 變成擋人`);
    assert.doesNotMatch(line, RETIRED_GATES, `settings.json 登記的閘「${g.name}」指到第 7 步刪掉的舊閘＝合併指令會起不了它`);
  }
  // 三關真正執行的是 settings.json 的 checks.commands（鉤子與 CI 都只呼叫 tools/run-checks.js，字面上永遠掃不到）——
  // 把工具加進這裡，推送前與雲端就會跑它、沒網路或沒權杖退 2＝變成閘（Grok #613 掃後①）
  const commands = settings.checks?.commands;
  assert.ok(Array.isArray(commands) && commands.length >= 3, 'settings.json 的 checks.commands 不是至少三關的清單——這題變空包彈（三關搬家了？）');
  for (const cmd of commands) {
    assert.doesNotMatch([cmd].flat().join(' '), /pending-rulings|acceptance-tier/, `settings.json 的 checks.commands 有一關叫了它（${[cmd].flat().join(' ')}）＝推送前鉤子與 CI 都會跑它、退出碼 2 變成擋人`);
  }
  assert.doesNotMatch([settings.checks?.prepareWorktree ?? []].flat().join(' '), /pending-rulings|acceptance-tier/, 'settings.json 的 checks.prepareWorktree 叫了它＝跨變更試合併閘備樹時會跑它');
});

/**
 * CLAUDE.md「開工前」那一節的編號步驟裡，要有一步叫套件的待裁清單工具、不帶參數、不指舊路徑。
 * 讀的是**有效文字**（visible() 剝掉 HTML 註解與圍欄）、只看那一節的編號步驟——Codex #613 r4 Low②：讀原文的話，整步藏進註解仍全綠。
 * @param {string} text
 * @returns {string | null} 問題（null＝合格）
 */
function claudeStartupStepProblem(text) {
  const lines = visible(text).split('\n');
  const from = lines.findIndex((l) => /^## 開工前\s*$/.test(l));
  if (from < 0) return 'CLAUDE.md（剝掉註解與圍欄後）找不到標題行「## 開工前」';
  const next = lines.findIndex((l, i) => i > from && /^## /.test(l));
  const steps = lines.slice(from + 1, next < 0 ? lines.length : next).filter((l) => /^\d+\.\s/.test(l));
  if (steps.length < 3) return `「開工前」那一節（剝掉註解與圍欄後）只剩 ${steps.length} 個編號步驟——步驟被藏起來或搬走了`;
  const hit = steps.filter((l) => /pending-rulings/.test(l));
  if (!hit.length) return '「開工前」的編號步驟裡沒有一步提到待裁清單工具（藏進註解、圍欄或搬出那一節都算沒有）';
  if (!hit.some((l) => l.includes('`node tools/pending-rulings.js`'))) return `要寫出跑法 \`node tools/pending-rulings.js\`（不帶參數），實際：${hit.join(' / ')}`;
  for (const l of lines) {
    if (/scripts\/pending-rulings/.test(l)) return `CLAUDE.md 還指到已刪的舊工具：${l}`;
    if (/pending-rulings\.js\s+-{1,2}\w/.test(l)) return `CLAUDE.md 叫待裁清單工具時帶了參數（套件不收、會退 2）：${l}`;
  }
  return null;
}

test('⭐ 文件｜CLAUDE.md「開工前」的編號步驟裡叫的是套件的待裁清單工具、不帶參數、不指舊路徑；讀有效文字（藏進註解不算）', () => {
  const claude = read('CLAUDE.md');
  assert.equal(claudeStartupStepProblem(claude), null, claudeStartupStepProblem(claude) ?? '');
  // 保存：同一個判準要抓得到這幾種改法（不是另抄一份）
  const stepLine = visible(claude).split('\n').find((l) => /^\d+\.\s/.test(l) && /pending-rulings/.test(l)) ?? '';
  assert.ok(stepLine && claude.includes(stepLine), '對照斷言：那一步在真檔裡逐字找得到（下面的夾具靠它定位）');
  assert.ok(claudeStartupStepProblem(claude.replace(stepLine, `<!--\n${stepLine}\n-->`)), '整步藏進 HTML 註解沒被抓到（r4 Low②）');
  assert.ok(claudeStartupStepProblem(claude.replace(stepLine, `\`\`\`\n${stepLine}\n\`\`\``)), '整步放進圍欄沒被抓到');
  assert.ok(claudeStartupStepProblem(claude.replace(stepLine, '')), '整步刪掉沒被抓到');
  assert.ok(claudeStartupStepProblem(claude.replace('`node tools/pending-rulings.js`', '`node tools/pending-rulings.js --all`')), '帶回 --all 沒被抓到');
  assert.ok(claudeStartupStepProblem(claude.replace('`node tools/pending-rulings.js`', '`node scripts/pending-rulings.js`')), '改指舊路徑沒被抓到');
});

test('⭐ 文件｜AGENTS 附則寫出分級的跑法、只指路不抄分級表；PR 範本「怎麼驗收」只指路、固定小標只認真正的標題行', () => {
  const agents = read('AGENTS.md');
  const at = agents.indexOf('\n## 本專案協作附則');
  assert.ok(at >= 0, '找不到 AGENTS.md「本專案協作附則」那一節——這題變空包彈');
  const mentions = agents.slice(at + 1).split('\n').filter((l) => /tools\/acceptance-tier\.js/.test(l));
  assert.ok(mentions.some((l) => l.includes('`node tools/acceptance-tier.js <編號>`')), '附則要寫出跑法 `node tools/acceptance-tier.js <編號>`（RULES H6），不是只提檔名');
  assert.ok(mentions.some((l) => /照它印的做/.test(l)), '附則要叫執行者照工具印的做');
  for (const l of mentions) assert.doesNotMatch(l, /動作累積|最重|一律當|db\/|package-lock|命中幾級/, '附則提到分級工具的那一行又在抄分級的算法或家族清單——只准指到工具與設定');
  // 固定小標只認真正的標題行：先用 visible() 剝掉 HTML 註解與圍欄再逐行找（Codex #611 r2／r3：indexOf 或只認欄首反引號的正則都留活口）
  const lines = visible(read('.github/pull_request_template.md')).split('\n');
  const from = lines.findIndex((l) => /^## 怎麼驗收\s*$/.test(l));
  const to = lines.findIndex((l) => /^### 複審後掃\s*$/.test(l));
  assert.ok(from >= 0 && to > from, `PR 範本（剝掉註解與圍欄後）找不到標題行「## 怎麼驗收」（${from}）或它後面的「### 複審後掃」（${to}）`);
  const section = lines.slice(from, to).join('\n');
  assert.match(section, /tools\/acceptance-tier\.js/, 'PR 範本「怎麼驗收」沒指到分級工具');
  assert.doesNotMatch(section, /只動 E 級|取最重|由上往下|E 級：|不需驗收/, 'PR 範本又在抄級名、分級表或算法（#573 r4／r5）——只准指路');
});
