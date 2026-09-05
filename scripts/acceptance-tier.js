#!/usr/bin/env node
// @ts-check
// **合併後驗收分級**（William 2026-09-06 協作系統體檢第 5 題裁示分級，落點＝PR #573 裡他的留言）。
//
// ## 這支在解什麼
//
// 合併之後要不要請 William 重啟 App 走一遍核心流程，原本三處寫法互相矛盾（AGENTS 寫每支都要、合併步驟
// 早有分級、「標準全流程」又說只有高風險才實測）。體檢量到最近兩個 20 支的窗口各有 8／11 支完全沒動 app，
// 卻名義上要他重啟 20 次。分級的**正本住這裡**（路徑家族表 RULES＋每一級的動作 TIERS），不住散文——
// 第 8 步的散文清單在 #573 r2 被 Codex 用「把 public/ 移到不需驗收」的突變證明沒有任何考題會紅；
// 表住程式、考題釘表，漂了就紅。
//
// ## 用法
//   node scripts/acceptance-tier.js <PR 編號>            # 用 gh 讀該 PR 動到的檔案
//   node scripts/acceptance-tier.js --paths a.js b.md   # 直接給路徑（考題與離線用）
// 退出碼：0＝算出來了（印級別、命中、動作）；2＝算不出來（gh 失敗／沒有路徑）→ 老實說算不出來，不猜。
// ⚠️ 這**不是合併閘**：它不擋任何事，只把「合併後該做什麼」算給執行者看；合併步驟第 8 步照它印的做。
//
// ## 兩條規矩（考題釘住）
// 1. **動作累積**：同一支命中幾級就做幾級的動作（db/＋package-lock＋lib/ ＝ 套 SQL、裝相依、重啟走流程三件都做）；
//    回報的「級別」寫最重的那級。只取最重一級會把其他必要動作吃掉（#573 r2 High①）。
// 2. **沒列到的路徑一律當「要重啟」**（fail-closed）並列出來——不確定就往重的算，不預設免驗（#573 r1 High②）。
//
// ## 誠實劃界
// 分級減少的是**不必要的重啟**；純 lib/ 的口徑變更人眼本來也走不到（匯率預設值、SEC 科目對應），那一塊靠
// 考題與 CI 接，不因分級而多或少。表是路徑家族的判斷，不是行為證明——新家族出現時它會落到「要重啟」並被列出，
// 由改表的那支 PR 補進去。
import { execFileSync } from 'node:child_process';
import { isMainModule } from '../lib/is-main.js';
import { gitEnv } from '../lib/git-env.js';

/**
 * 每一級的名字、輕重（rank 越大越重；回報取最重）、與合併後該做的動作。
 * F 是**橫向**的（工具安全設定）：不參與「最重」比較，但動作一定要印——它跟重啟無關，重啟修不好它。
 */
export const TIERS = /** @type {const} */ ({
  A: { name: '資料庫結構', rank: 5, action: '重啟套不上：照 docs/C6-部署與對抗審查-操作手冊.md 在 Supabase SQL Editor 重跑整份 db/supabase-schema.sql（冪等），再照那份手冊驗；同支若也命中 C，本機 LOCAL 照 C 做。' },
  B: { name: '相依套件', rank: 4, action: '先裝再重啟：桌面捷徑「重啟理財網頁」只在 pull 到動 package*.json 的版本時才自動 npm install；主目錄已是最新版（沒有 pull）就在主目錄手動 npm install；裝完做 C。' },
  C: { name: '要重啟＋走核心流程', rank: 3, action: 'William 重啟 App、以實際操作走完最核心的一條流程（PR 說明「怎麼驗收」那三句）；HOSTED 等 Render 重新部署後在線上走同一條。' },
  D: { name: '只動前端', rank: 2, action: '重新整理頁面、看一眼「怎麼驗收」三句寫的畫面即可，不必重啟（沒有 service worker，express.static 直接供應）。' },
  P: { name: '原型', rank: 2, action: 'prototype/ 不由 server.js 供應：要看就開原型自己的預覽，不重啟理財 App。' },
  E: { name: '不需驗收', rank: 1, action: '回報寫「不需驗收：只動了 …」。' },
  F: { name: '工具安全設定', rank: 0, action: '不是重啟：.codex/hooks.json／.claude/settings.json 的 matcher 或指令一改，Codex 的信任雜湊就失效、hook 標成 Modified 並停止執行（AGENTS「錢的絕對邊界」節 Codex 側那條）——William 要在 Codex 介面 /hooks 對該檔重新按「信任」，家目錄那份要手動同步；驗＝test/codex-money-hook 的身分互鎖與成對驗。' },
});

/** @typedef {keyof typeof TIERS} Tier */

/**
 * 路徑家族表：**由上往下第一個命中的算**（所以啟動會跑的 scripts/check-node-version.js 排在「只在合併程序跑的 check-*」前面）。
 * 沒命中＝未知＝當 C（見檔頭第 2 條）。
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
  ['E', /^scripts\/(check-[^/]+\.js|grok-[^/]+|audit-[^/]+\.js|sync-pr-base-version\.js|c6-adversarial\.js)$/],   // 只在合併程序／審查／驗證裡跑的
  ['E', /^scripts\/git-hooks\//],
  ['E', /^(eslint\.config\.js|jsconfig\.json|mutate\.sh|\.gitignore)$/],
  ['E', /^\.claude\/launch\.json$/],
  ['E', /^scripts\/acceptance-tier\.js$/],             // 本支自己：只影響這份報告怎麼算
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
  const ranked = /** @type {Tier[]} */ ([...present].filter((t) => t !== 'F')).sort((a, b) => TIERS[b].rank - TIERS[a].rank);
  const level = ranked[0] ?? 'E';
  const order = /** @type {Tier[]} */ (['F', 'A', 'B', 'C', 'D', 'P']);
  const actions = order.filter((t) => present.has(t)).map((t) => ({ tier: t, action: TIERS[t].action }));
  if (!actions.some((a) => a.tier !== 'F')) actions.push({ tier: 'E', action: TIERS.E.action });
  return { level, hits, unknown, actions, toolSecurity };
}

/** 給合併步驟第 8 步照抄的報告。 @param {string[]} paths */
export function report(paths) {
  const r = classify(paths);
  const lines = [
    `驗收分級：${r.level}（${TIERS[r.level].name}）${r.toolSecurity ? '；另有 F（工具安全設定）動作' : ''}`,
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
    try {
      const out = execFileSync('gh', ['pr', 'view', argv[0], '--json', 'files', '--jq', '.files[].path'], { encoding: 'utf8', stdio: 'pipe', env: gitEnv() });
      paths = out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch (e) {
      console.error(`驗收分級：算不出來（gh 讀不到 PR #${argv[0]} 的檔案清單：${/** @type {any} */ (e)?.message}）——不猜，先把 gh 弄好再跑。`);
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
