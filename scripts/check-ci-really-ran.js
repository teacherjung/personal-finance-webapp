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
 * required 名單＝**現場讀分支保護**（context＋app_id），不硬編（r1 高①：硬編會在
 * 保護新增 required check 時靜默漏查；只比對名字則任何 GitHub App 都能貼一個
 * 同名 success 冒名放行——名單與身分都以分支保護為準）。
 * @typedef {{ context: string, appId: number | null }} RequiredCheck
 */

/** @typedef {{ name: string, status: string, conclusion: string | null, completed_at: string | null, app_id: number | null }} CheckRun */

/**
 * 形狀驗證（r2 新中①補嚴）：completed 場次必須有**合法時間字串**的 completed_at 與非 null 的
 * conclusion（它們是排序與判定的承重欄）；未完成場次依 API 契約兩者皆 null。
 * @param {unknown} v @returns {v is CheckRun[]}
 */
export function isCheckRunList(v) {
  return Array.isArray(v) && v.every((r) => {
    if (!r || typeof r !== 'object') return false;
    const o = /** @type {any} */ (r);
    if (typeof o.name !== 'string' || typeof o.status !== 'string') return false;
    if (o.app_id !== null && typeof o.app_id !== 'number') return false;
    if (o.status === 'completed') {
      return typeof o.conclusion === 'string'
        && typeof o.completed_at === 'string' && Number.isFinite(Date.parse(o.completed_at));
    }
    return o.conclusion === null && o.completed_at === null;
  });
}

/** @param {unknown} v @returns {v is RequiredCheck[]} */
export function isRequiredList(v) {
  return Array.isArray(v) && v.every((r) => !!r && typeof r === 'object'
    && typeof (/** @type {any} */ (r).context) === 'string' && (/** @type {any} */ (r).context).length > 0
    && ((/** @type {any} */ (r).appId) === null || typeof (/** @type {any} */ (r).appId) === 'number'));
}

/**
 * 純判斷層（考題直測）。
 * @param {CheckRun[]} runs 合併頭 commit 的全部 check runs（已分頁撈全）
 * @param {boolean} autoMergeOn PR 是否開著 auto-merge
 * @param {RequiredCheck[]} required 分支保護的 required checks（context＋app_id）
 * @returns {{ code: 0 | 1 | 2, reason: string }}
 */
export function evaluateGate(runs, autoMergeOn, required) {
  if (autoMergeOn) {
    return { code: 1, reason: 'auto-merge 開著——草稿轉正式的空窗裡它會拿舊的 skipped 綠燈直接合併，先 `gh pr merge --disable-auto` 關掉' };
  }
  if (required.length === 0) {
    return { code: 2, reason: '分支保護的 required checks 名單是空的——查不到＝不安全（保護被關掉了？）' };
  }
  for (const { context, appId } of required) {
    // 身分過濾（r1 高①）：分支保護釘了 app_id 就只認該 App 的場次——別的 App 貼同名 success 不算數。
    // appId=null＝保護自己允許任何來源（GitHub 語意），那是保護的選擇、不是本閘放寬。
    const mine = runs.filter((r) => r.name === context && (appId === null || r.app_id === appId));
    if (mine.length === 0) {
      return { code: 2, reason: `合併頭上找不到 required check「${context}」的正牌場次（app ${appId ?? '任意'}）——查不到＝不安全（workflow 還沒觸發？或只有別的 App 冒名的同名場次）` };
    }
    if (mine.some((r) => r.status !== 'completed')) {
      return { code: 1, reason: `「${context}」有場次還在跑——等它跑完再判` };
    }
    // 最新＝GitHub 文件對 filter=latest 的裁決鍵 completed_at（r1 高②：started_at 實測會倒走）。
    // ⚠️ API 精度到秒、且沒有任何欄位有「同刻誰晚」的契約保證（r2：id 只承諾唯一、不承諾遞增）
    //   ——所以**同刻並列取交集語意**：最大 completed_at 的所有場次必須全部 success，
    //   有任何一場不是＝結論不明＝fail-closed 擋下（寧可多跑一次真考卷，不猜平台沒承諾的順序）。
    const maxAt = mine.reduce((m, r) => (String(r.completed_at) > m ? String(r.completed_at) : m), '');
    const tied = mine.filter((r) => String(r.completed_at) === maxAt);
    const bad = tied.find((r) => r.conclusion !== 'success');
    if (bad) {
      return { code: 1, reason: `「${context}」最新（completed_at 並列含）場次的結論是 ${bad.conclusion}——skipped＝草稿期的跳過（不是真考卷）、其餘＝沒過；同刻結論不一致也算不明。轉正式後重跑到真的 success 再合併` };
    }
  }
  return { code: 0, reason: `required checks（${required.map((r) => r.context).join('、')}）在合併頭上皆真跑且 success、auto-merge 關閉` };
}

// ---- CLI ----------------------------------------------------------------
if (isMainModule(import.meta.url)) {
  const pr = process.argv[2];
  if (!pr || !/^\d+$/.test(pr)) { console.error('用法：node scripts/check-ci-really-ran.js <PR 編號>'); process.exit(2); }
  try {
    const view = JSON.parse(execFileSync('gh', ['pr', 'view', pr, '--json', 'headRefOid,autoMergeRequest'], { encoding: 'utf8' }));
    const sha = view?.headRefOid;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) { console.error(`真考卷閘 PR #${pr}：讀不到合併頭 sha（fail-closed）`); process.exit(2); }
    // required 名單＝現場讀分支保護（r1 高①）；讀不到／空＝fail-closed
    const prot = JSON.parse(execFileSync('gh', ['api', 'repos/{owner}/{repo}/branches/main/protection/required_status_checks', '--jq', '[.checks[] | { context, appId: (if (.app_id // -1) < 0 then null else .app_id end) }]'], { encoding: 'utf8' }));
    if (!isRequiredList(prot)) { console.error(`真考卷閘 PR #${pr}：分支保護名單形狀不對（fail-closed）`); process.exit(2); }
    // check runs＝--paginate 撈全（r1 高②：單頁 100 筆會截斷）；--jq 每頁輸出一個陣列、串起來再合併
    const pages = execFileSync('gh', ['api', '--paginate', `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '[.check_runs[] | { name, status, conclusion, completed_at, app_id: (.app.id // null) }]'], { encoding: 'utf8' });
    const raw = pages.split('\n').filter((l) => l.trim()).flatMap((l) => JSON.parse(l));
    if (!isCheckRunList(raw)) { console.error(`真考卷閘 PR #${pr}：check runs 形狀不對（fail-closed）`); process.exit(2); }
    const { code, reason } = evaluateGate(raw, view?.autoMergeRequest != null, prot);
    console.log(`真考卷閘 PR #${pr}：${code === 0 ? '通過' : '未通過'}——${reason}`);
    process.exit(code);
  } catch (e) {
    console.error(`真考卷閘 PR #${pr}：查詢失敗（${/** @type {any} */ (e)?.message?.split('\n')[0] || '未知'}）——查不到＝不安全（fail-closed）`);
    process.exit(2);
  }
}
