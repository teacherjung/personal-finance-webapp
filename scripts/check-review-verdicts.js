#!/usr/bin/env node
// @ts-check
// **複審結論的聯集閘**（William 2026-08-02 定）。
//
// ## 這支在解什麼
//
// 2026-08-02 實測：#383 上出現**兩份都自稱「Claude 複審」的結論，而且相反**——
// 一份寫「通過，可以合併」，一份寫「需修改後再審」。GitHub 上兩則都顯示 `teacherjung`，
// **沒有任何辦法分辨誰寫的**（三方共用同一個帳號，而且每邊的桌面 session 還會各自
// 用 CLI 起另一個 session：Claude 桌面／Claude CLI／Codex 桌面／Codex CLI 至少四個）。
//
// 兩份其實都對，只是**照的地方不同**：一份查版面與結構（手機 flex、selector、sticky），
// 一份查金額口徑與資料列格數。危險的不是有兩份，是**看起來一樣有效而結論相反**，
// 於是「最後一則說通過」就變成事實上的放行。
//
// ## 兩條規則（本支實作的就是這兩條）
//
// ①**自報來歷**：每一則帶結論的複審留言，第一行必須是機器讀得懂的來歷標頭。
// ②**取聯集**：任何審查者的阻擋結論，在**同一個審查者**用更新的 commit 撤銷之前都有效。
//    「通過」**不會**抵銷另一個審查者的「需修改」——沒有「最後一則說了算」這種事。
//
// ## 誠實劃界
//
// 它讀的是**留言裡的自我宣告**，不是身分證明。一個要繞過它的協作者，
// 直接改頭標裡的 `來源` 就好——那要靠獨立 GitHub 帳號才擋得住（見
// `docs/GitHub分支保護-設定與驗證.md` 的「第二步：分身分」）。
// 它防的是**混淆與遺漏**，不是惡意。
//
// 退出碼：0＝沒有未回應的阻擋；1＝有；2＝查不清楚（fail-closed，比照協作欄位閘）。
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** 結論用詞 → 是不是阻擋。**只認這三種**，寫別的等於沒下結論（→ 查不清楚）。 */
export const VERDICTS = {
  通過: false,
  需修改後再審: true,
  不可合併: true,
};

/**
 * 來歷標頭。**刻意是可見的一行，不是 HTML 註解**——
 * 註解在畫面上看不見，而今晚已經有三次「藏在註解裡就繞過去了」的實例。
 *
 * 格式（逐字）：
 *   🤖 <角色>｜來源：<哪個 session>｜審 `<短 sha>`｜r<輪次>｜結論：<三選一>
 */
const HEADER = /^\s*(?:[*_>\s]*)🤖\s*([A-Za-z]+)｜來源：([^｜]+)｜審\s*`?([0-9a-f]{7,40})`?｜r(\d+)｜結論：(\S+?)\s*$/mu;

/**
 * 從一則留言抽出來歷標頭。抓不到就回 null（呼叫端決定那算不算問題）。
 * @param {string} body
 */
export function headerOf(body) {
  const first = String(body || '').split('\n').find((l) => l.trim()) || '';
  const m = HEADER.exec(first);
  if (!m) return null;
  const verdict = m[5].replace(/[。．.]$/u, '');
  if (!(verdict in VERDICTS)) return null;
  return {
    role: m[1],
    source: m[2].trim(),
    sha: m[3].toLowerCase(),
    round: Number(m[4]),
    verdict,
    blocking: VERDICTS[/** @type {keyof typeof VERDICTS} */ (verdict)],
  };
}

/** 一則留言看起來是不是「想下結論」——用來抓「有結論卻沒標頭」的漏網。 @param {string} body */
export const looksLikeVerdict = (body) =>
  /結論|複審|審查完成|可以合併|不可合併|需修改/u.test(String(body || ''));

/**
 * 聯集判定。
 *
 * ⚠️ **撤銷只能由同一個審查者做，而且要用更新（或相同）的 commit**：
 * A 說「需修改」之後，B 說「通過」**不會**解除 A 的阻擋——那正是 #383 的情境。
 * 同一個審查者身分＝`角色 + 來源`（不是只有角色：兩個 Claude session 是兩個審查者）。
 *
 * @param {{body: string}[]} comments @param {string} head
 * @returns {{ problems: string[], reviewers: Record<string, any> }}
 */
export function verdictProblems(comments, head) {
  /** @type {string[]} */ const problems = [];
  /** @type {Record<string, any>} */ const latest = {};
  for (const c of comments) {
    const h = headerOf(c.body);
    if (!h) {
      if (looksLikeVerdict(c.body)) {
        problems.push('有一則留言下了結論卻沒有合規的來歷標頭'
          + `（第一行要長成「🤖 角色｜來源：…｜審 \`sha\`｜r<n>｜結論：${Object.keys(VERDICTS).join('／')}」）：`
          + `「${String(c.body).replace(/\s+/g, ' ').slice(0, 60)}…」`);
      }
      continue;
    }
    const who = `${h.role}（${h.source}）`;
    // 同一個審查者：留最新一輪的結論
    if (!latest[who] || h.round >= latest[who].round) latest[who] = { ...h, who };
  }
  for (const h of Object.values(latest)) {
    if (!h.blocking) continue;
    problems.push(`${h.who} 在 r${h.round}（審 ${h.sha}）的結論是「${h.verdict}」，還沒有被同一位審查者撤銷。\n`
      + '    ⚠️ **取聯集，不取最後一則**：別人說「通過」不會解除這一條。'
      + '請那位審查者針對目前的 head 重新給結論。');
  }
  // 有結論的審查者都應該審到目前的 head（否則那個「通過」是對舊版本說的）
  for (const h of Object.values(latest)) {
    if (!h.blocking && !head.startsWith(h.sha)) {
      problems.push(`${h.who} 的「${h.verdict}」是對 ${h.sha} 說的，但目前 head 是 ${head.slice(0, 7)}——`
        + '分支被推過之後，那個結論不再適用。');
    }
  }
  return { problems, reviewers: latest };
}

/** @param {string} pr */
function fetchPr(pr) {
  const out = execFileSync('gh', ['pr', 'view', pr, '--json', 'comments,headRefOid'], { encoding: 'utf8' });
  const p = JSON.parse(out);
  if (!Array.isArray(p?.comments)) throw new Error('gh 回傳的形狀不對（comments）');
  if (typeof p.headRefOid !== 'string' || !/^[0-9a-f]{40}$/.test(p.headRefOid)) {
    throw new Error('gh 沒有回傳合法的 headRefOid');
  }
  return { comments: p.comments, head: p.headRefOid };
}

/** @param {string[]} argv */
export function main(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('用法：node scripts/check-review-verdicts.js <PR 編號>');
    return 2;
  }
  let data;
  try { data = fetchPr(pr); }
  catch (e) {
    console.error(`複審聯集閘 PR #${pr}：查不清楚（${/** @type {any} */ (e)?.message}）——一律當成未通過。`);
    return 2;   // fail-closed
  }
  const { problems, reviewers } = verdictProblems(data.comments, data.head);
  const who = Object.values(reviewers).map((r) => `${r.who}=${r.verdict}`).join('、') || '（沒有任何帶標頭的結論）';
  if (problems.length === 0) {
    console.log(`複審聯集閘 PR #${pr}：沒有未回應的阻擋結論。現況：${who}`);
    return 0;
  }
  console.error(`複審聯集閘 PR #${pr}：**未通過**\n` + problems.map((p) => `  ・${p}`).join('\n')
    + `\n\n現況：${who}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main(process.argv.slice(2)));
}
