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
// ⚠️ **不接受 `>` 引用與 `-` 列表前綴**（Codex #385 r1 Medium④）：
//    引用別人的標頭不該被算成一則新結論。只容許粗體包裝與水平空白。
const HEADER = /^[^\S\n]*(?:\*\*|__)?[^\S\n]*🤖\s*([A-Za-z]+)｜來源：([^｜]+)｜審\s*`?([0-9a-fA-F]{7,40})`?｜r(\d+)｜結論：(\S+?)\s*$/mu;

/**
 * 從一則留言抽出來歷標頭。抓不到就回 null（呼叫端決定那算不算問題）。
 * @param {string} body
 */
export function headerOf(body) {
  const first = String(body || '').split('\n').find((l) => l.trim()) || '';
  const m = HEADER.exec(first);
  if (!m) return null;
  const verdict = m[5].replace(/[。．.]$/u, '');
  // ⚠️ `in` 會命中原型鍵（`toString`／`constructor` 都會被當成合法的第四種結論）——
  //    本專案的原型鍵鐵則，我在自己的新腳本裡又犯一次（Codex #385 r1 Medium⑤）。
  if (!Object.hasOwn(VERDICTS, verdict)) return null;
  return {
    role: m[1],
    // 來源做 collapse whitespace：多打一個空白不該變成「另一個審查者」（那會多出一條永遠撤不掉的阻擋）
    source: m[2].trim().replace(/\s+/gu, ' '),
    sha: m[3].toLowerCase(),
    round: Number(m[4]),
    verdict,
    blocking: VERDICTS[/** @type {keyof typeof VERDICTS} */ (verdict)],
  };
}

/**
 * 一則留言看起來是不是「想下結論」——用來抓「有結論卻沒標頭」的漏網。
 *
 * ⚠️ **誤擋比漏抓更貴**（Codex #385 r1 Medium④ 實測，以下全被第一版誤擋）：
 * 「這不是複審，只是提醒」／「修完就可以合併嗎？」／引用上一輪的結論／
 * 說明「腳本遇到『不可合併』要回 exit 1」／fenced code 裡的格式範例。
 * 誤擋會讓人乾脆繞過這道閘，那比它漏抓一次更糟。
 *
 * 所以判準收緊成兩條、而且**先剝掉引用與 code fence**：
 *   ①出現機器人記號 `🤖`（想用這個格式卻寫錯）
 *   ②出現「結論」後面緊跟著三種合法用詞之一（真的在下結論，不是在討論結論）
 * @param {string} body
 */
export function looksLikeVerdict(body) {
  const text = String(body || '')
    .replace(/^```[\s\S]*?^```/gm, '')     // code fence 裡的範例不是結論
    .replace(/^[^\S\n]*>.*$/gm, '');       // 引用別人的話不是自己的結論
  if (/🤖/u.test(text)) return true;
  const words = Object.keys(VERDICTS).join('|');
  return new RegExp(`結論[^\\n]{0,8}(?:${words})`, 'u').test(text);
}

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
    const cur = latest[who];
    if (!cur || h.round > cur.round) { latest[who] = { ...h, who }; continue; }
    // ⚠️ **同輪次出現相反結論 → fail-closed**（Codex #385 r1 High①）：
    //    原本用 `>=`，於是同為 r2 時「需修改」後貼「通過」就放行、反過來就阻擋
    //    ——**結果取決於留言順序**，那正是這支要根治的病，我卻在自己的實作裡犯了。
    //    契約寫的是「**更新的**輪次才能撤銷」，同輪次不算撤銷。
    if (h.round === cur.round && h.blocking !== cur.blocking) {
      latest[who] = { ...cur, conflict: true, blocking: true,
        verdict: `同一輪（r${h.round}）出現相反結論：${cur.verdict} vs ${h.verdict}` };
    }
  }
  // ⚠️ **沒有任何針對目前 head 的正式結論＝不可合併**（Codex #385 r1 High②）。
  //    我原本讓它放行，理由是「沒有人下結論不等於有人說不行」——**那是退步**：
  //    `main` 原本的合併步驟 2 就要求「確認審查結論」，而協作欄位閘只證明
  //    **有人被寫成審查者**，證明不了**審查真的發生過**。
  const passedAtHead = Object.values(latest).some((h) => !h.blocking && head.startsWith(h.sha));
  if (!passedAtHead) {
    problems.push(`沒有任何一位審查者對目前的 head（${head.slice(0, 7)}）下過「通過」的正式結論。\n`
      + '    ⚠️ 協作欄位閘只證明「有人被寫成審查者」，證明不了「審查真的發生過」。\n'
      + '    請獨立審查者用來歷標頭給出結論（格式見 AGENTS.md「一支 PR 上可能有好幾個審查者」節）。');
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
