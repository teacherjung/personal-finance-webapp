// @ts-check
// 真考卷閘：合併前驗「required checks 在合併頭上**真的跑過且成功**」——skipped／cancelled 不算數。
//
// 為什麼需要它（2026-08-15，省額度改造的 Grok 預審抓到的兩個【高】）：
//   ci.yml 對草稿 PR 的推送用 job 級 `if` 跳過省額度，而 GitHub 把 skipped 的 required check
//   **視同滿足**。設計上的不變量是「草稿合不了；轉正式那一刻（ready_for_review）會真跑一次」，
//   但它有兩個機械上兜不住的洞：
//   ①空窗：`gh pr ready` 之後、真 CI 的 check run 建立之前，分支保護看到的仍是舊 head 的
//     skipped＝綠——這段空窗裡按合併（或 auto-merge）就是「沒跑考卷就合」。
//   ②舊場次重跑：GitHub 的 Re-run 沿用**原始事件 payload**（`draft: true` 凍結在裡面），
//     重跑舊草稿場次會再蓋一筆 skipped；配上 concurrency cancel-in-progress 還可能先取消
//     正在跑的真考卷。
//   分支保護擋不住這兩個（skipped＝滿足是 GitHub 的語意，改不動），所以在**合併程序**收口：
//   本閘直接讀合併頭的 check runs，逐一要求 conclusion === 'success'——skipped 就是紅。
//   同時要求 auto-merge 必須關著（空窗洞的自動化版本：檢查已「綠」時 ready 一按就自動合）。
//
// 慣例同其他閘：純判斷層（evaluateGate）供考題直測；CLI 包裝 fail-closed
//（查不到／形狀不對＝退出碼 2，不放行）。

import { execFileSync } from 'node:child_process';
import { isMainModule } from '../lib/is-main.js';

/**
 * **這支是合併程序的一道機械閘**——`test/collab-invariant-docs.test.js` 靠這個標記
 * 反查「現在到底有幾道閘」，再要求文件把每一道都點名得出來。
 */
export const MERGE_GATE = { name: '真考卷', why: '合併頭的 required checks 必須真的跑過且成功——skipped/cancelled 不算，auto-merge 必須關閉' };

/**
 * 必須「真的成功」的 check 名單＝分支保護的 required checks（job 的 `name:` 逐字）。
 * ⚠️ 與 workflow 檔的機械互扣在 `test/ci-really-ran.test.js`（從 yml 解析出 job name 比對）——
 *    改名時考題會紅，兩邊一起改。`dev-machine` 刻意不在名單（continue-on-error 的前瞻燈，不是門）。
 */
export const REQUIRED_CHECK_NAMES = ['上線用的 Node（.node-version）', '協作欄位（實作者 ≠ 獨立審查者）'];

/** @typedef {{ name: string, status: string, conclusion: string | null, started_at: string | null }} CheckRun */

/** @param {unknown} v @returns {v is CheckRun[]} */
export function isCheckRunList(v) {
  return Array.isArray(v) && v.every((r) => !!r && typeof r === 'object'
    && typeof (/** @type {any} */ (r).name) === 'string'
    && typeof (/** @type {any} */ (r).status) === 'string'
    && ((/** @type {any} */ (r).conclusion) === null || typeof (/** @type {any} */ (r).conclusion) === 'string'));
}

/**
 * 純判斷層（考題直測）。
 * @param {CheckRun[]} runs 合併頭 commit 的全部 check runs
 * @param {boolean} autoMergeOn PR 是否開著 auto-merge
 * @param {string[]} [required]
 * @returns {{ code: 0 | 1 | 2, reason: string }}
 */
export function evaluateGate(runs, autoMergeOn, required = REQUIRED_CHECK_NAMES) {
  if (autoMergeOn) {
    return { code: 1, reason: 'auto-merge 開著——草稿轉正式的空窗裡它會拿舊的 skipped 綠燈直接合併，先 `gh pr merge --disable-auto` 關掉' };
  }
  for (const name of required) {
    const mine = runs.filter((r) => r.name === name);
    if (mine.length === 0) {
      return { code: 2, reason: `合併頭上找不到 required check「${name}」的任何場次——查不到＝不安全（是不是 workflow 還沒觸發？）` };
    }
    // 同名多場次＝取最新（GitHub 分支保護同語意）；started_at 缺就用陣列末位（API 回傳新在後）
    const latest = [...mine].sort((a, b) => String(a.started_at || '').localeCompare(String(b.started_at || ''))).at(-1);
    if (!latest || latest.status !== 'completed') {
      return { code: 1, reason: `「${name}」還在跑（status=${latest?.status}）——等它跑完` };
    }
    if (latest.conclusion !== 'success') {
      return { code: 1, reason: `「${name}」最新場次的結論是 ${latest.conclusion}——skipped＝草稿期的跳過（不是真考卷）、其餘＝沒過。轉正式後重跑到真的 success 再合併` };
    }
  }
  return { code: 0, reason: `required checks（${required.join('、')}）在合併頭上皆真跑且 success、auto-merge 關閉` };
}

// ---- CLI ----------------------------------------------------------------
if (isMainModule(import.meta.url)) {
  const pr = process.argv[2];
  if (!pr || !/^\d+$/.test(pr)) { console.error('用法：node scripts/check-ci-really-ran.js <PR 編號>'); process.exit(2); }
  try {
    const view = JSON.parse(execFileSync('gh', ['pr', 'view', pr, '--json', 'headRefOid,autoMergeRequest'], { encoding: 'utf8' }));
    const sha = view?.headRefOid;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) { console.error(`真考卷閘 PR #${pr}：讀不到合併頭 sha（fail-closed）`); process.exit(2); }
    const raw = JSON.parse(execFileSync('gh', ['api', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs'], { encoding: 'utf8' }));
    if (!isCheckRunList(raw)) { console.error(`真考卷閘 PR #${pr}：check runs 形狀不對（fail-closed）`); process.exit(2); }
    const { code, reason } = evaluateGate(raw, view?.autoMergeRequest != null);
    console.log(`真考卷閘 PR #${pr}：${code === 0 ? '通過' : '未通過'}——${reason}`);
    process.exit(code);
  } catch (e) {
    console.error(`真考卷閘 PR #${pr}：查詢失敗（${/** @type {any} */ (e)?.message?.split('\n')[0] || '未知'}）——查不到＝不安全（fail-closed）`);
    process.exit(2);
  }
}
