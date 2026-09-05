#!/usr/bin/env node
// @ts-check
// **合併後驗收分級**（William 2026-09-06 協作系統體檢第 5 題裁示分級，落點＝PR #573 裡他的留言）。
//
// ## 這支在解什麼
//
// 合併之後要不要請 William 重啟 App 走一遍核心流程，看的是這支 PR 動到哪些路徑家族。分級的**正本住這裡**
// （路徑家族表 RULES＋每一級的動作 TIERS），不住散文：散文清單沒有考題會為它紅，表住程式、考題**逐條**釘每一條規則的級別，漂了就紅。
// 沿革與量到的數字在 PR #573 的說明，這裡只寫機制。
//
// ## 用法
//   node scripts/acceptance-tier.js <PR 編號>            # 用 gh 分頁讀該 PR 動到的檔案（含改名前的舊路徑）
//     ⚠️ repo **與站台**都釘在目前目錄的 origin（GH_REPO／GH_HOST 蓋不掉）；PR 編號＝origin 那個 repo 的編號——
//        origin 若是 fork，查的就是 fork 上的同號 PR、不是上游，跑之前自己確認 origin 指誰。
//   node scripts/acceptance-tier.js --paths a.js b.md   # 直接給路徑（考題與離線用）
// 退出碼：0＝算出來了（印級別、命中、動作）；2＝算不出來（gh 失敗／回傳不是預期形狀／檔數對不上 PR 的檔數／沒有路徑）→ 老實說算不出來，不猜。
// ⚠️ 這**不是合併閘**：它不擋任何事，只把「合併後該做什麼」算給執行者看；合併步驟「回報合併結果與驗收分級」那一步照它印的做。
//
// ## 規矩（考題釘住）
// 1. **動作累積**：同一支命中幾級就做幾級的動作（db/＋package-lock＋lib/ ＝ 套 SQL、裝相依、重啟走流程三件都做）；
//    回報的「級別」寫最重的那級（同重時照 ORDER 的固定順序，不看路徑順序；只命中 F 就寫 F）。只取最重一級會把其他必要動作吃掉。
//    命中 B（相依）一定連帶列出 C：裝完不重啟載不到新套件，B 的動作不可以停在「裝完」。
// 2. **沒列到的路徑一律當「要重啟」**（fail-closed，程式裡叫 unknown）並列出來——不確定就往重的算，不預設免驗。
//    「沒列到」包含新目錄**與 scripts/ 裡沒點名的新腳本**（E 的腳本是明確名單，不是 check-* 這種寬鬆形狀——
//    寬鬆形狀會把未來被啟動流程掛上的新腳本靜靜當成不需驗收）。
//
// ## 誠實劃界
// 分級減少的是**不必要的重啟**；純 lib/ 的口徑變更人眼本來也走不到（匯率預設值、SEC 科目對應），那一塊靠
// 考題與 CI 接，不因分級而多或少。表是路徑家族的判斷，不是行為證明——新家族出現時它會落到「要重啟」並被列出，
// 由改表的那支 PR 補進去；`public/` 那一級「重新整理就好」的前提是沒有 service worker，那個前提由考題守著。
import { execFileSync } from 'node:child_process';
import { isMainModule } from '../lib/is-main.js';
import { gitEnv } from '../lib/git-env.js';

/**
 * 每一級的名字與合併後該做的動作。輕重與同重時的先後由 ORDER 決定（固定順序，不看路徑順序）。
 * F 是**橫向**的（工具安全設定）：不參與「最重」比較（只命中 F 時級別才寫 F），但動作一定要印——它跟重啟無關，重啟修不好它。
 * 每一級的動作都要能**獨立照做**：不可以寫「做某某級」而不把那一級列出來（B 連帶 C 由 classify 保證）。
 */
export const TIERS = /** @type {const} */ ({
  A: { name: '資料庫結構', action: '重啟套不上：照 docs/C6-部署與對抗審查-操作手冊.md 在 Supabase SQL Editor 重跑整份 db/supabase-schema.sql（冪等），再照那份手冊驗；同支若也命中 C，本機 LOCAL 照 C 做。' },
  B: { name: '相依套件', action: '先裝再重啟：桌面捷徑「重啟理財網頁」只在 pull 到動 package*.json 的版本時才自動 npm install；主目錄已是最新版（沒有 pull）就在主目錄手動 npm install；裝完做下一行 C 的動作（命中 B 時 C 一定連帶列出）。' },
  C: { name: '要重啟＋走核心流程', action: 'William 重啟 App、以實際操作走完最核心的一條流程（PR 說明「怎麼驗收」那三句）；HOSTED 等 Render 重新部署後在線上走同一條。' },
  D: { name: '只動前端', action: '重新整理頁面、看一眼「怎麼驗收」三句寫的畫面即可，不必重啟（沒有 service worker，express.static 直接供應）。' },
  P: { name: '原型', action: 'prototype/ 不由 server.js 供應：要看就開原型自己的預覽，不重啟理財 App。' },
  E: { name: '不需驗收', action: '回報寫「不需驗收：只動了 …」。' },
  F: { name: '工具安全設定', action: '不是重啟：.codex/hooks.json／.claude/settings.json 的 matcher 或指令一改，Codex 的信任雜湊就失效、hook 標成 Modified 並停止執行（AGENTS「錢的絕對邊界」節 Codex 側那條）——William 要在 Codex 介面 /hooks 對該檔重新按「信任」，家目錄那份要手動同步；驗＝test/codex-money-hook 的身分互鎖與成對驗。' },
});

/** @typedef {keyof typeof TIERS} Tier */

/** 回報級別的固定順序（最重在前；同重的 D／P 也照這個順序，不看 gh 回傳的路徑順序）；F 橫向不在內。 */
export const ORDER = /** @type {Tier[]} */ (['A', 'B', 'C', 'D', 'P', 'E']);

/**
 * 路徑家族表：**由上往下第一個命中的算**（所以啟動會跑的 scripts/check-node-version.js 排在「只在合併程序跑的明確名單」前面）。
 * 每一條的級別都由 test/acceptance-tier.test.js 的 RULE_SAMPLES 逐條釘住（多一條、換一級都會紅）。
 * 沒命中＝未知＝當 C（見檔頭「沒列到的路徑一律當『要重啟』」）。
 * @type {[Tier, RegExp][]}
 */
export const RULES = [
  ['F', /^\.codex\/hooks\.json$/],
  ['F', /^\.claude\/settings\.json$/],
  ['A', /^db\//],
  ['B', /^package(-lock)?\.json$/],
  ['C', /^lib\//],
  ['C', /^server\.js$/],
  ['C', /^start\.command$/],
  ['C', /^\.node-version$/],
  ['C', /^render\.yaml$/],
  ['C', /^data\/seed\.json$/],
  ['C', /^scripts\/check-node-version\.js$/],          // start.command 每次啟動都跑它——壞了 App 起不來
  ['D', /^public\//],
  ['D', /^public-site\//],                             // HOSTED 公開站（server.js 用 express.static 供應）
  ['P', /^prototype\//],
  ['E', /^test\//],
  ['E', /^test-doubles\//],
  ['E', /^docs\//],
  ['E', /^[^/]+\.md$/],
  ['E', /^\.github\//],                                // 含 CI 設定：影響的是合併程序，由合併閘與 CI 自己驗
  // 只在合併程序／審查／驗證裡跑的腳本：**明確名單**，新腳本不會自動落到 E（會當未知→C，由改表的人核對它是不是啟動時會跑）
  ['E', /^scripts\/(check-ci-really-ran|check-cross-pr-merge|check-pr-collab-fields|check-pr-merge-gate|check-review-verdicts|check-worktree-integrity|audit-grok-scan|grok-scan|grok-relay|grok-auth-refresh|grok-sandbox-canary|sync-pr-base-version|c6-adversarial|acceptance-tier)\.js$/],
  ['E', /^scripts\/grok-sandbox\.sb$/],
  ['E', /^scripts\/git-hooks\//],
  ['E', /^(eslint\.config\.js|jsconfig\.json|mutate\.sh|\.gitignore)$/],
  ['E', /^\.claude\/launch\.json$/],
];

/**
 * @param {string} path
 * @returns {{tier: Tier, known: boolean}}
 */
export function tierOf(path) {
  for (const [tier, re] of RULES) if (re.test(path)) return { tier, known: true };
  return { tier: 'C', known: false };
}

/**
 * 把一支 PR 動到的路徑算成級別與動作。
 * @param {string[]} paths
 * @returns {{level: Tier, hits: {path: string, tier: Tier, known: boolean}[], unknown: string[], actions: {tier: Tier, action: string}[], toolSecurity: boolean}}
 */
export function classify(paths) {
  const hits = paths.map((p) => ({ path: p, ...tierOf(p) }));
  const unknown = hits.filter((h) => !h.known).map((h) => h.path);
  const present = new Set(hits.map((h) => h.tier));
  const toolSecurity = present.has('F');
  const level = ORDER.find((t) => present.has(t)) ?? (toolSecurity ? 'F' : 'E');
  const effective = new Set(present);
  if (effective.has('B')) effective.add('C');   // 裝完相依不重啟載不到：B 一定連帶 C（動作要能獨立照做）
  const order = /** @type {Tier[]} */ (['F', ...ORDER.filter((t) => t !== 'E')]);
  const actions = order.filter((t) => effective.has(t)).map((t) => ({ tier: t, action: TIERS[t].action }));
  // E 的動作（回報「不需驗收」）只在真的沒有任何 A–D／P 動作、而且 E 真的被命中（或根本沒路徑）時才列；只命中 F 就只有 F。
  if (!actions.some((a) => a.tier !== 'F') && (present.has('E') || present.size === 0)) actions.push({ tier: 'E', action: TIERS.E.action });
  return { level, hits, unknown, actions, toolSecurity };
}

/**
 * 把 `gh api --paginate --slurp repos/…/pulls/N/files` 的輸出（頁的陣列、每頁是檔案物件陣列）轉成路徑清單：
 * filename 一定收；有 previous_filename（renamed／copied）也收（去重）。形狀不對就丟——由 main 轉成退出碼 2：
 * 每筆要有非空 filename 與 status；status 是 renamed 時 previous_filename 必須是非空字串；有 previous_filename 就必須是非空字串。
 * `expectEntries`＝PR 自報的檔數（gh pr view 的 changedFiles）：筆數對不上就丟——GitHub 這個端點最多只回 3000 筆，
 * 分頁越不過那個上限，對不上＝清單不完整，不可以拿殘缺清單算出一個看起來很輕的級別。
 * @param {string} json
 * @param {{expectEntries?: number}} [opts]
 * @returns {string[]}
 */
export function prFilesFromApi(json, { expectEntries } = {}) {
  const pages = JSON.parse(json);
  if (!Array.isArray(pages)) throw new Error('gh api 回傳不是陣列');
  const out = new Set();
  let entries = 0;
  for (const page of pages) {
    if (!Array.isArray(page)) throw new Error('gh api 的頁不是陣列');
    for (const f of page) {
      if (!f || typeof f !== 'object' || typeof f.filename !== 'string' || !f.filename) throw new Error('檔案物件缺 filename');
      if (typeof f.status !== 'string' || !f.status) throw new Error(`檔案物件缺 status：${f.filename}`);
      const hasPrev = 'previous_filename' in f;
      if (hasPrev && (typeof f.previous_filename !== 'string' || !f.previous_filename)) throw new Error(`previous_filename 不是非空字串：${f.filename}`);
      if (f.status === 'renamed' && !hasPrev) throw new Error(`renamed 卻沒有 previous_filename：${f.filename}`);
      entries += 1;
      out.add(f.filename);
      if (hasPrev) out.add(f.previous_filename);
    }
  }
  if (expectEntries !== undefined) {
    if (!Number.isInteger(expectEntries) || expectEntries < 0) throw new Error(`PR 自報的檔數不是整數：${expectEntries}`);
    if (entries !== expectEntries) throw new Error(`檔案清單不完整或對不上（API 給 ${entries} 筆、PR 共 ${expectEntries} 筆；這個端點最多只回 3000 筆）`);
  }
  return [...out];
}

/** 一段 owner 或 repo 名：只收字母、數字、`_`、`.`、`-`；另外 `.`／`..` 段在下面單獨擋。 */
const SEG = '[A-Za-z0-9_.-]+';
/** 網址形：`scheme://[userinfo@]host[:port]/owner/repo`——**逐字白名單**，含 %、?、#、多餘路徑段的一律不匹配。 */
const URL_FORM = new RegExp(`^(https?|ssh|git)://(?:[^@/\\s]+@)?([A-Za-z0-9.-]+)(?::(\\d+))?/(${SEG})/(${SEG})$`);
/** scp 形：`[user@]host:owner/repo`——冒號後一律是路徑、沒有 port 文法。 */
const SCP_FORM = new RegExp(`^(?:[^@/\\s]+@)?([A-Za-z0-9.-]+):(${SEG})/(${SEG})$`);
/** 形狀不合時的訊息——**刻意不回聲 origin 原文**（https remote 常內嵌 PAT／密碼，印出來會帶進終端、紀錄與貼文；#573 r7 High②）。 */
const SHAPE_MSG = 'origin 不是能逐字釘住的 owner/repo 網址（只收 https／http／ssh／git:// 或 scp 形、路徑剛好 owner/repo 兩段、不含 %／?／#／「.」「..」段；為了不帶出內嵌憑證，這裡不印 origin 原文）';

/**
 * repo 身分（站台＋owner/repo）釘在目前目錄的 origin——不用 gh 的 `{owner}/{repo}` 佔位、也不省略站台：
 * 佔位會被 GH_REPO 導向別的 repo（#573 r4）、沒明講站台會被 GH_HOST 導向別站（#573 r5），而 gitEnv() 只清 GIT_*。
 * **逐字白名單、不正規化**（#573 r6／r7）：一條寬鬆正規式會把 https 的 port 靜靜丟掉、把 scp 的數字路徑段吞成 port；
 * 改用 WHATWG URL 又會把 `%2e%2e`、`?x=1`、`#frag` 正規化掉——Git 送給遠端的是原文，我們卻查到另一個 slug 的同號 PR。
 * 所以：只有**原文**剛好長成 `scheme://[user@]host[:port]/owner/repo(.git)` 或 `[user@]host:owner/repo(.git)` 才收，
 * 其餘一律丟（退 2）、不猜；http(s) 明講**非預設** port＝API 也在那個 port、gh 的 --hostname 拒收冒號釘不住 → 也丟；
 * ssh:// 的 port 是 SSH 的、跟 API 端點無關 → 不看。錯誤訊息不含 origin 原文。
 * @param {string} [cwd]
 * @returns {{host: string, slug: string}}
 */
export function originRepo(cwd = process.cwd()) {
  const raw = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', stdio: 'pipe', env: gitEnv() }).trim();
  const url = raw.replace(/\/+$/, '').replace(/\.git$/, '');
  const m = url.match(URL_FORM);
  let host, port, owner, repo;
  if (m) {
    [, , host, port, owner, repo] = m;
    const scheme = m[1];
    const defaultPort = scheme === 'https' ? '443' : scheme === 'http' ? '80' : null;
    if (port && /^https?$/.test(scheme) && port !== defaultPort) throw new Error(`origin 明講了非預設 port（${port}），gh 釘不住那個 endpoint、不改查預設 port 的同號 PR`);
  } else {
    const s = url.match(SCP_FORM);
    if (!s) throw new Error(SHAPE_MSG);
    [, host, owner, repo] = s;
  }
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') throw new Error(SHAPE_MSG);
  return { host, slug: `${owner}/${repo}` };
}

/** 給合併步驟「回報合併結果與驗收分級」那一步照抄的報告。 @param {string[]} paths */
export function report(paths) {
  const r = classify(paths);
  const lines = [
    `驗收分級：${r.level}（${TIERS[r.level].name}）${r.toolSecurity && r.level !== 'F' ? '；另有 F（工具安全設定）動作' : ''}`,
    `命中：${r.hits.map((h) => `${h.path}→${h.tier}${h.known ? '' : '（未列到，當 C）'}`).join('、') || '（沒有路徑）'}`,
    '動作（累積，命中幾級做幾級）：',
    ...r.actions.map((a) => `  ・${a.tier}：${a.action}`),
  ];
  if (r.unknown.length) lines.push(`⚠️ 未列到的路徑（fail-closed，一律當 C）：${r.unknown.join('、')}——若真的不必重啟，改 scripts/acceptance-tier.js 的 RULES 並補考題。`);
  return lines.join('\n');
}

/** @param {string[]} argv */
export function main(argv) {
  let paths;
  if (argv[0] === '--paths') {
    paths = argv.slice(1);
  } else if (argv[0] && /^\d+$/.test(argv[0])) {
    // ⚠️ 不用 `gh pr view --json files`：它只給前 100 筆、改名只給新路徑（#573 r3 Codex 實測）。
    //    走 REST 的 pulls/<N>/files 分頁全拿，改名把 previous_filename 也算進去（舊的 runtime 路徑被拿掉也是 runtime 變更）；
    //    再拿 PR 自報的檔數（changedFiles）對筆數——端點上限 3000 筆，對不上就退 2（#573 r4）。站台與 repo 一律明講，不靠 gh 猜。
    try {
      const { host, slug } = originRepo();
      const opts = { encoding: /** @type {const} */ ('utf8'), stdio: /** @type {const} */ ('pipe'), env: gitEnv(), maxBuffer: 1e8 };
      const total = execFileSync('gh', ['pr', 'view', argv[0], '-R', `${host}/${slug}`, '--json', 'changedFiles', '--jq', '.changedFiles'], opts).trim();
      if (!/^\d+$/.test(total)) throw new Error(`gh 回的 PR 檔數不是整數：${JSON.stringify(total)}`);
      const out = execFileSync('gh', ['api', '--paginate', '--slurp', '--hostname', host, `repos/${slug}/pulls/${argv[0]}/files?per_page=100`], opts);
      paths = prFilesFromApi(out, { expectEntries: Number(total) });
    } catch (e) {
      console.error(`驗收分級：算不出來（gh 讀不到 PR #${argv[0]} 的檔案清單、回傳不是預期形狀、或檔數對不上：${/** @type {any} */ (e)?.message}）——不猜，先把 gh 弄好再跑。`);
      return 2;
    }
  } else {
    console.error('用法：node scripts/acceptance-tier.js <PR 編號>｜--paths <路徑…>');
    return 2;
  }
  if (!paths.length) { console.error('驗收分級：算不出來（沒有任何路徑）。'); return 2; }
  console.log(report(paths));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
