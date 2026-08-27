#!/usr/bin/env node
// @ts-check
// **基準版本自動對齊**（2026-08-27，26 封失敗信的教訓）：push 之前，把 PR 說明的
// 「基準版本」欄位改成**即將推上去的那顆 commit**。
//
// ## 為什麼要有這支
//
// 協作欄位閘（`check-pr-collab-fields.js`）要求「基準版本＝目前 head」。每推一次 head 就變，
// 欄位隨即過期 ⇒ 那一輪的 `synchronize` 檢查**必紅**，紅完再手動改欄位才轉綠。
// 實測 2026-08-15～27 共 **233 次**這種紅——它們全部是同一個動作沒做：先改欄位再推。
// REVIEW-AND-MERGE.md「省額度慣例」早就寫了正解（「每輪先 commit → 先改欄位 → 才 push」），
// 但寫了跟做得到是兩回事：233 次證明**靠記憶維持的程序會斷**（同 `check-pr-collab-fields.js`
// 檔頭那句「規則靠記憶維持，就會斷」——那支閘存在的理由，這支腳本存在的理由是同一個）。
//
// ## ⚠️ 這支**不是閘**，而且刻意不能是
//
// 它只做「文書對齊」，一次都不做「放行」的決定：
//   ・跑不動、查不到、改不出可驗證的結果 ⇒ **什麼都不改**，push 照常進行。
//   ・欄位對不對，仍然由 `check-pr-collab-fields.js` 在雲端與合併步驟**各自獨立**檢查。
//   ・所以它壞掉的最壞後果＝退回今天的狀態（那一輪紅一次），**不會讓任何東西靜靜通過**。
//
// ## ⚠️ 為什麼自動推進這個欄位不算開後門（動手前查證過，不是推論）
//
// 「審完 A、作者又推 B」的把關**不在這個欄位身上**——在 `scripts/check-review-verdicts.js`：
// 它要求指定審查者對**目前 head** 有一則真的「通過」（見該檔檔頭與退出碼 0 的定義）。
// 推了 B，審 A 的那則結論就不再指向 head，那道閘照樣紅。
// 基準版本欄位管的是**文書上釘得住版本**，不是「這顆被審過」——後者有專責的閘。
// ⚠️ 若哪天 `check-review-verdicts.js` 不再釘 head，這支就變成真的後門，屆時必須一起重評。
//
// 用法（pre-push hook 餵 stdin，格式＝git 給 pre-push 的四欄）：
//   printf '%s\n' "<local-ref> <local-sha> <remote-ref> <remote-sha>" | node scripts/sync-pr-base-version.js
// 退出碼：**永遠 0**（見上：它不是閘，不該有權力擋 push）。

import { execFileSync } from 'node:child_process';
import { isMainModule } from '../lib/is-main.js';
import { gitEnv } from '../lib/git-env.js';
import { staleBaseProblems } from './check-pr-collab-fields.js';

/** 十六進位段的合法長度（與 `staleBaseProblems` 的判準同一把尺：7–40）。 */
const MIN_SHA = 7;
const MAX_SHA = 40;

/**
 * 把 HTML 註解**遮成同長度的空白**（換行保留）。
 *
 * ⚠️ 為什麼不像閘那樣直接 `replace(/<!--[\s\S]*?-->/g, '')`：閘只要「讀得到值」，
 *    這支要**改回原字串的正確位置**，所以偏移量必須 1:1 對得上。
 *    直接刪掉會讓後面所有字元位移；遮成等長空白則位置不動。
 * ⚠️ 換行**必須留著**：欄位正則靠 `^`／`m` 錨定行首，把換行也遮掉會讓行的邊界跑掉。
 * @param {string} body @returns {string}
 */
export function maskComments(body) {
  return String(body || '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 「基準版本」那一行的欄位正則。
 *
 * ⚠️ **形狀逐字照抄 `check-pr-collab-fields.js` 的 `fieldValue`**——兩邊必須是同一把尺，
 *    不然會出現「閘讀的是這一行、我改的是另一行」這種各改各的。
 *    互扣考題＝`test/pr-base-version.test.js`：改完的結果一律拿**閘自己的**
 *    `staleBaseProblems` 重驗，對不上就當作沒改。
 */
const BASE_LINE_RE = /^[^\S\n]*(?:(?:[-*+]|\d+[.)])[^\S\n]*)?(?:\*\*|__)?基準版本(?:\*\*|__)?[^\S\n]*[:：][^\S\n]*(.*)$/m;

/**
 * 找出「基準版本」欄位**值**在原字串裡的區間（找不到回 `null`）。
 *
 * ⚠️ 抽成獨立函式是為了**可對帳**：`BASE_LINE_RE` 是閘那支 `fieldValue` 的手抄本，
 *    手抄本會漂。`test/pr-base-version.test.js` 的「同一把尺」那題直接拿閘的
 *    `fieldValue` 逐一比對本函式讀到的值——兩邊讀到不同的東西就轉紅。
 * @param {string} body @returns {{ start: number, end: number, value: string } | null}
 */
export function baseFieldSpan(body) {
  const src = String(body || '');
  const m = maskComments(src).match(BASE_LINE_RE);
  if (!m || m.index === undefined) return null;
  const end = m.index + m[0].length;
  const start = end - m[1].length;
  return { start, end, value: src.slice(start, end) };
}

/**
 * 把說明裡「基準版本」欄位的每一段 SHA 換成 `sha` 的同長度前綴。
 *
 * ⚠️ **換「每一段」、不是只換第一段**（判準與 `staleBaseProblems` 對齊）：
 *    `[d6c4fbd](https://…/commit/d6c4fbd…)` 這種顯示值＋連結的寫法有兩段，
 *    閘要求**每一段**都是 head 的前綴——只改顯示值會留下指著舊 commit 的連結，
 *    而那正是閘的註解點名的「很常見的手滑」。
 * ⚠️ 保留各段**原本的長度**（短 SHA 仍是短 SHA、40 碼仍是 40 碼），
 *    這樣人寫的版面不會被機器改成另一種樣子。超過 40 碼的段落會被截到 40＝順手修好。
 * ⚠️ 欄位**本來就沒有 SHA 就不動它**（空白、或填了讀不出 SHA 的東西）：
 *    那是「模板沒填」的真訊號，該讓它繼續紅，不該被機器補得像填過了。
 *
 * @param {string} body @param {string} sha 完整 40 碼 SHA
 * @returns {{ body: string, changed: boolean, reason: string }}
 */
export function rewriteBaseVersion(body, sha) {
  const src = String(body || '');
  if (!/^[0-9a-f]{40}$/.test(sha)) return { body: src, changed: false, reason: '給的不是合法的 40 碼 SHA' };

  const span = baseFieldSpan(src);
  if (!span) return { body: src, changed: false, reason: '說明裡沒有「基準版本」欄位' };
  const { start: valStart, end: lineEnd, value } = span;

  let hit = 0;
  const next = value.replace(/[0-9a-fA-F]+/g, (run) => {
    if (run.length < MIN_SHA) return run;             // 太短＝不是 SHA（閘也不當它是）
    hit += 1;
    return sha.slice(0, Math.min(run.length, MAX_SHA));
  });
  if (!hit) return { body: src, changed: false, reason: '「基準版本」欄位裡讀不出 SHA（可能還沒填）' };
  if (next === value) return { body: src, changed: false, reason: '「基準版本」已經是這顆 commit' };

  return { body: src.slice(0, valStart) + next + src.slice(lineEnd), changed: true, reason: '' };
}

/**
 * 解析 git 餵給 pre-push 的 stdin：`<local-ref> <local-sha> <remote-ref> <remote-sha>`。
 * 只回傳「推分支、而且不是刪除」的那些。
 * @param {string} stdin @returns {Array<{ branch: string, sha: string }>}
 */
export function parsePushRefs(stdin) {
  /** @type {Array<{ branch: string, sha: string }>} */ const out = [];
  for (const line of String(stdin || '').split('\n')) {
    const [localRef, localSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha) continue;
    if (!localRef.startsWith('refs/heads/')) continue;      // tag／其他 ref 與這件事無關
    if (/^0{40}$/.test(localSha)) continue;                 // 全零＝刪分支，沒有 head 可對齊
    if (!/^[0-9a-f]{40}$/.test(localSha)) continue;
    out.push({ branch: localRef.slice('refs/heads/'.length), sha: localSha });
  }
  return out;
}

/**
 * ⚠️ `env: gitEnv()` 不可省（AGENTS.md 鐵則 11）：`gh` 會自己再 spawn git，
 *    繼承來的 `GIT_DIR` 會讓它去讀**另一個** repo 的 PR，而輸出看起來完全正常。
 * @param {string[]} args @returns {string}
 */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', env: gitEnv() });
}

/** @param {string} branch @returns {{ number: number, body: string } | null} */
function findPr(branch) {
  const out = gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,body']);
  const list = JSON.parse(out);
  if (!Array.isArray(list) || list.length !== 1) return null;   // 0 支＝還沒開 PR；>1＝不猜
  const [pr] = list;
  if (typeof pr?.number !== 'number' || typeof pr?.body !== 'string') return null;
  return { number: pr.number, body: pr.body };
}

/**
 * @param {string} stdin
 * @param {{ log?: (s: string) => void, find?: typeof findPr, edit?: (n: number, b: string) => void }} [io]
 * @returns {number} 永遠 0
 */
export function main(stdin, io = {}) {
  const log = io.log || ((s) => console.log(s));
  const find = io.find || findPr;
  const edit = io.edit || ((n, b) => { gh(['pr', 'edit', String(n), '--body', b]); });

  const refs = parsePushRefs(stdin);
  // ⚠️ **這一句不是裝飾**：`test/entry-guard.test.js` 靠「跑起來看不看得到輸出」判斷
  //    進入點守衛（`isMainModule`）有沒有壞——完全不出聲的腳本它證不了，只能列進豁免。
  //    這裡本來就有話可說（沒有 ref＝刪分支或沒東西推），所以照實講、不進豁免清單。
  //    ⚠️ 真的在 push 時 git 一定會餵至少一行，所以這句在正常流程不會出現。
  if (!refs.length) {
    log('（基準版本：這次沒有要對齊的分支 ref——刪除分支或沒有分支要推，什麼都不做）');
    return 0;
  }
  for (const { branch, sha } of refs) {
    let pr;
    try { pr = find(branch); }
    catch (e) {
      // ⚠️ 查不到就**安靜地不做事**（與閘的 fail-closed 相反，而且是刻意的）：
      //    這支不決定放行，「不確定」的正確反應是把事情原樣留給閘，不是擋住 push。
      log(`   （基準版本：查不到 ${branch} 的 PR（${/** @type {any} */ (e)?.message}）——不動它，閘照常會檢查）`);
      continue;
    }
    if (!pr) continue;                                   // 還沒開 PR＝正常，第一次推分支就是這樣

    const r = rewriteBaseVersion(pr.body, sha);
    if (!r.changed) {
      if (r.reason && !r.reason.includes('已經是')) log(`   （基準版本：${r.reason}——不動它）`);
      continue;
    }
    // ⚠️ **拿閘自己的尺回頭驗一次**：改出來的東西如果自己都過不了閘，那就是改錯了，
    //    寧可不改（維持今天的行為＝紅一次），也不要留下一份看起來填好、其實仍會紅的說明。
    const left = staleBaseProblems(r.body, sha);
    if (left.length) {
      log(`   （基準版本：改出來的結果自己驗不過（${left[0].split('\n')[0]}）——不動它）`);
      continue;
    }
    try {
      edit(pr.number, r.body);
      log(`   ✅ 基準版本已對齊 PR #${pr.number} → ${sha.slice(0, 7)}（這一輪的協作欄位檢查就不會紅了）`);
    } catch (e) {
      log(`   （基準版本：改不進去（${/** @type {any} */ (e)?.message}）——不動它，閘照常會檢查）`);
    }
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => { process.exit(main(input)); });
}
