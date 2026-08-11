#!/usr/bin/env node
// @ts-check
// **跨 PR 試合併閘**（William 2026-08-03 定）。
//
// ## 這支在解什麼
//
// 「兩支 PR 各自全綠」**不等於**「合起來全綠」。2026-08-03 一個晚上就撞了兩次，
// 而且兩次都是同一個形狀——**一支的規則，禁止了另一支的內容**：
//
// | | #384 加的規則 | #385 的內容 | 結果 |
// |---|---|---|---|
// | 第一次 | AGENTS.md 標題只准 `##`／`###` | 它寫了 `#### 兩條規則` | 各自綠、合起來紅 |
// | 第二次 | AGENTS.md 一個 `<` 都不准 | 它寫了 `🤖 <角色>｜來源：<哪個 session>` | 同上 |
//
// 兩次都**沒有改到同一個檔案的同一行**，所以：
//   ・GitHub 不顯示衝突（文字上合得起來）
//   ・兩支的 CI 都是綠的（各自跑各自的）
//   ・**合併第二支的當下，`main` 就紅了**
//
// 現有機制一個都抓不到：分支保護的 `strict` 只檢查「跟 `main` 同步」，
// 不檢查「跟另一支**開著的** PR 相容」；「預計修改的共享檔案」預約制查的是
// 檔案重疊，而這種撞法**沒有檔案重疊**。
//
// ## 為什麼做成閘，不是寫進 AGENTS.md
//
// 因為這個專案自己有證據：PR 說明的五個必填欄位是寫在規則書裡、大家都同意的規則，
// 而 2026-08-02 實測**連續三支（#374／#375／#376）漏填**。
// 「記得在合併前做試合併」是完全同一種規則——要在正確的時機、由記得的人、手動執行，
// 而**被忘記的那一次不會有任何徵兆**。
//
// 做成閘之後，AGENTS.md 只需要多一個**名字**（自報的 `MERGE_GATE` 會強迫兩處摘要點名它），
// 不需要多一條要記住的規則。照 AGENTS.md 自己那句話：**摘要會落後，名字不會。**
//
// 用法：node scripts/check-cross-pr-merge.js <PR 編號>
// 退出碼：0＝沒有其他 open PR，或每一支試合併之後三關都綠
//         1＝有一支合起來會壞（文字衝突／測試紅）→ 停下來，先處理相容性
//         2＝查不清楚（gh 失敗／不是 git repo／發起樹沒有可用的 node_modules／
//             三關「執行不起來」（spawn 失敗／被訊號終止／126／127）／建不出臨時工作區）→ fail-closed
//
// ## 誠實劃界
//
// 擋得住：**測試看得到**的互相破壞（一支的護欄擋掉另一支的內容、型別對不上、行為衝突）。
// **擋不住**：兩支合起來語意上矛盾、但測試沒有覆蓋到的地方——那還是要人看。
// 它也**不保證**合併之後 `main` 一定是綠的：它試的是「這兩支的 head」，
// 而真正合併時 `main` 可能已經又前進了（那一段由 `strict` 與 CI 接手）。
// 「執行不起來」（spawn 失敗／被訊號終止／126／127）＝**沒有取得可直接判讀的正常測試
// 結果**，成因這裡不推定——實際出現過的至少有三種：環境（node_modules 殘缺——#441）、
// 兩支合壞了 scripts 呼叫的追蹤檔案（#446 r2 Codex 造出來）、測試自己以 127 收場
// （#446 r3 Codex 造出來）。所以這一族一律退 2「查不清楚」，只擋下來要人查；
// node_modules 殘缺到「跑得起來但缺套件」的灰色地帶，三關仍會以紅（1）收場——
// 那時死因欄裡的 stderr 尾巴就是人工判讀的依據。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainModule } from '../lib/is-main.js';

/**
 * **這支是合併程序的一道機械閘**——`test/collab-invariant-docs.test.js` 靠這個標記
 * 反查「現在到底有幾道閘」，再要求文件把每一道都點名得出來。
 */
export const MERGE_GATE = {
  name: '跨 PR 試合併',
  why: '兩支各自全綠不代表合起來全綠——一支的規則可能禁止另一支的內容',
};

/**
 * 要拿來試合併的其他 PR。
 *
 * ⚠️ 判準只有兩條，刻意不多：**base 是 `main`**、**不是自己**。
 * 草稿（draft）也算——它一樣會被合併，而且草稿階段正是最容易寫出互斥內容的時候。
 * @param {{number: number, headRefOid: string, headRefName: string, baseRefName: string, isDraft?: boolean}[]} list
 * @param {number} self
 */
export function othersToTry(list, self) {
  return list
    .filter((p) => p.number !== self && p.baseRefName === 'main')
    .sort((a, b) => a.number - b.number);
}

/**
 * 把每一支的試合併結果彙整成退出碼與訊息。
 *
 * ⚠️ `cantRun: true` 的失敗（三關「執行不起來」）＝**拿不到可信的測試判決**，一律轉成
 * 退出碼 2「查不清楚」，不可以混進「合起來會壞」（1）——但也**不宣稱一定是環境**：
 * 126／127 兩支各自全綠的 PR 也造得出來（見 `cantRunSignal` 檔頭）。只要有一筆
 * cantRun，整輪就以 2 收場（三關共用同一份發起樹的 node_modules，它若真的壞了，
 * 同輪其他結果的可信度也存疑）；同輪若另有「跑得起來的紅」，訊息要列出來並說明
 * 那些不因此失效——下不了定論的是 cantRun 那幾筆，不是整輪的事實。
 * @param {{number: number, ok: boolean, why: string, cantRun?: boolean}[]} results
 */
export function verdict(results) {
  const bad = results.filter((r) => !r.ok);
  if (bad.some((r) => r.cantRun)) {
    const confirmed = bad.filter((r) => !r.cantRun);
    return {
      code: 2,
      message: '跨 PR 試合併：**查不清楚——有三關「執行不起來」，這一輪下不了定論**\n'
        + bad.map((r) => `  ・#${r.number}：${r.why}`).join('\n')
        + '\n\n⚠️ 「執行不起來」（spawn 失敗如 ENOENT／EACCES、被訊號終止、或退出碼 126／127）'
        + '＝**沒有取得可直接判讀的正常測試結果**，這裡不推定成因。實際出現過的可能至少有三種：\n'
        + '   ・發起樹的 node_modules 殘缺（空的、.bin 斷了）或 npm 不可用（#441 實際發生的形狀）\n'
        + '   ・兩支合起來弄壞了 scripts 會呼叫的**追蹤檔案**（一支開始呼叫、另一支刪檔或拔執行位——#446 r2 的反例）\n'
        + '   ・測試或指令自己以 126／127 收場（#446 r3 的反例）\n'
        + '   排查起點：從主目錄重跑一次這道閘作對照，再照上面的死因欄逐條查。'
        + (confirmed.length
          ? '\n   ⚠️ 上列另有**本輪已確定的阻擋**（文字衝突、或跑得起來的測試紅）——那些不因本輪下不了定論而失效。'
          : ''),
    };
  }
  if (!bad.length) {
    return {
      code: 0,
      message: results.length
        ? `跨 PR 試合併：與 ${results.length} 支 open PR 合起來都是綠的（#${results.map((r) => r.number).join('、#')}）。`
        : '跨 PR 試合併：目前沒有其他 open PR，不需要試。',
    };
  }
  return {
    code: 1,
    message: '跨 PR 試合併：**合起來會壞**\n'
      + bad.map((r) => `  ・#${r.number}：${r.why}`).join('\n')
      // ⚠️ 兩種壞法要分開講，不可以混為一談（實跑第一次就發現我原本的訊息不準）：
      //    文字衝突 GitHub **會**顯示；測試紅 GitHub **不會**——後者才是這道閘存在的理由。
      + (bad.some((r) => r.why.includes('文字衝突'))
        ? '\n\n⚠️ **文字衝突**：這種 GitHub 自己就看得到（合併鍵會變灰）。'
          + '這道閘的價值在於**現在**就告訴你，而不是等到要合併的那一刻。'
        : '')
      + (bad.some((r) => r.why.includes('紅了'))
        ? '\n\n⚠️ **合起來測試紅**：這種 GitHub **不會**顯示——兩支各自的 CI 都是綠的、'
          + '也沒有檔案衝突，**合併第二支的當下 `main` 就紅了**。\n'
          + '   通常是其中一支的護欄擋掉了另一支的內容。先讓兩支相容再合併。'
        : ''),
  };
}

/** @param {string[]} args */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1e8 });
}

/**
 * 把三關失敗的 execFileSync 錯誤壓成一行死因。
 *
 * ⚠️ **stderr 的尾巴一定要帶**：只截 stdout 的話，127「指令找不到」這種環境錯誤
 * 完全看不見——stdout 只有 npm 的執行橫幅，「command not found」與 npm 的錯誤碼
 * 整段都在 stderr（2026-08-11 #441 誤報時，訊息裡只有橫幅，看的人分不出
 * 「測試紅」跟「環境壞」）。兩邊都空（如 spawn 本身失敗）就退回 message。
 * @param {{stdout?: string, stderr?: string, message?: string} | null | undefined} err
 */
export function redDetail(err) {
  // 太長時**頭尾都留、截中段**：死因可能在頭（sh 的「command not found」是 stderr
  // 第一行），也可能在尾（npm 的錯誤碼、最後一行斷言）。只留開頭的寫法曾把最後一行
  // 的真正死因整段裁掉（#446 r1 Codex 用行為題示範）。
  const clip = (/** @type {string} */ s) =>
    s.length <= 300 ? s : `${s.slice(0, 150)} …（截掉中段）… ${s.slice(-150)}`;
  const tail = (/** @type {string | undefined} */ s, /** @type {number} */ n) =>
    clip(String(s || '').split('\n').filter(Boolean).slice(-n).join(' / '));
  const out = tail(err?.stdout, 3);
  const errOut = tail(err?.stderr, 8);
  return [out, errOut && `stderr：${errOut}`].filter(Boolean).join('｜')
    || String(err?.message || '').slice(0, 300) || '（子行程沒有留下任何輸出）';
}

/**
 * 三關的失敗屬不屬於「執行不起來」（＝拿不到可信的測試判決）。是＝回症狀字串（給死因欄），
 * 不是＝回 null（那是「跑得起來的紅」，照舊算紅）。
 *
 * 錯誤形狀（execFileSync，2026-08-11 實測）：正常非零退出＝`status` 是數字；
 * spawn 失敗（ENOENT／EACCES…）＝`status: null`＋`code` 是 errno 字串；
 * 被訊號終止＝`status: null`＋`signal`。所以判準是「**拿不到數字退出碼**」＋ shell 的
 * 126（不可執行）／127（找不到指令）。⚠️ 列舉 errno 名單在這裡是錯的寫法——
 * #446 r2 Codex 實測 EACCES（npm 存在但不可執行）就漏在 r2 的 ENOENT 名單外。
 *
 * ⚠️ 這一族**判定不了成因**，也不推定：環境（node_modules 殘缺）、兩支合壞了追蹤檔案
 * （#446 r2 Codex 造出 126／127 的兩支全綠反例）、甚至測試自己印完輸出再以 127 收場
 * （#446 r3 Codex 實測 status 一樣是 127）——三種都真實存在。誠實語意只有「沒有取得
 * 可直接判讀的正常結果」，由 verdict 整輪退 2，不宣稱是誰的錯。
 * 跑得起來的紅（含 eslint 的退出碼 2＝可能是合出來的壞設定）刻意不歸這裡。
 * @param {{status?: number | null, code?: string, signal?: string | null} | null | undefined} err
 * @returns {string | null}
 */
export function cantRunSignal(err) {
  if (!err || typeof err.status !== 'number') {
    return String(err?.code ?? (err?.signal ? `被 ${err.signal} 終止` : '沒有退出碼'));
  }
  return (err.status === 126 || err.status === 127) ? `退出碼 ${err.status}` : null;
}

/**
 * 在拋棄式的工作區裡把 `base` 與 `other` 合起來，跑三關。
 *
 * ⚠️ **`node_modules` 用 symlink 指回發起樹，而且只用 `unlink` 拆掉**（不是 `rm -rf`）：
 * 新建的 worktree 沒有 `node_modules`，三關會全部 127 錯誤退出（2026-08-03 踩過，
 * 而且我當時把「指令沒找到」看成「三關通過」）。
 * 另一半的前提「**發起樹自己有 node_modules**」由 `main()` 在進迴圈前把關——
 * 從沒有 node_modules 的樹發起時這條連結是懸空的，三關照樣全 127，
 * 2026-08-11 #441 就這樣被誤報成「合起來會壞」（退出碼 1）；那要以 2 退出，不進到這裡。
 * 但 CLAUDE.md 有一條鐵則：**不要在 worktree 裡刪除 `node_modules`**——那個 symlink
 * 指回主目錄，動到它會讓 William 的 app 起不來。所以拆的時候用 `unlinkSync`：
 * 它只刪得掉連結本身，如果哪天那裡變成真的目錄，它會直接失敗而不是遞迴刪除。
 * @param {string} repoRoot @param {string} baseSha @param {string} otherSha @param {number} otherNumber
 */
function tryMerge(repoRoot, baseSha, otherSha, otherNumber) {
  const wt = mkdtempSync(join(tmpdir(), `cross-pr-${otherNumber}-`));
  const run = (/** @type {string[]} */ argv, /** @type {string} */ cwd) =>
    execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', stdio: 'pipe' });
  try {
    run(['git', 'worktree', 'add', '--detach', '-q', wt, baseSha], repoRoot);
    const nm = join(wt, 'node_modules');
    if (!existsSync(nm)) symlinkSync(join(repoRoot, 'node_modules'), nm);
    try {
      run(['git', 'merge', '--no-edit', '-q', otherSha], wt);
    } catch {
      return { number: otherNumber, ok: false, why: '文字衝突，git merge 就過不去' };
    }
    for (const [label, script] of [['校對', 'typecheck'], ['糾察', 'lint'], ['考試', 'test']]) {
      try {
        run(['npm', 'run', script === 'test' ? 'test' : script], wt);
      } catch (e) {
        const err = /** @type {any} */ (e);
        // ⚠️ 「執行不起來」≠「跑完是紅的」——分界與「為什麼不判定成因」寫在
        //    cantRunSignal 檔頭（#441 誤報＋#446 r1／r2 Codex 的兩輪反例都在那裡）。
        const sig = cantRunSignal(err);
        if (sig !== null) {
          return {
            number: otherNumber, ok: false, cantRun: true,
            why: `「${label}」執行不起來（症狀：${sig}）：${redDetail(err)}`,
          };
        }
        return { number: otherNumber, ok: false, why: `合起來之後「${label}」紅了：${redDetail(err)}` };
      }
    }
    return { number: otherNumber, ok: true, why: '' };
  } finally {
    // ⚠️ 先拆 symlink 再移除 worktree——`unlink` 只動得了連結，動不到主目錄的 node_modules
    const nm = join(wt, 'node_modules');
    try { unlinkSync(nm); } catch { /* 不在或不是連結都不要緊 */ }
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, stdio: 'pipe' }); }
    catch { try { rmSync(wt, { recursive: true, force: true }); } catch { /* 盡力清乾淨 */ } }
  }
}

/** 發起樹的 node_modules 要「是目錄」才算可用（statSync 跟隨 symlink；不存在／懸空＝throw）。 @param {string} p */
function isUsableNodeModulesDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** @param {string[]} argv */
export function main(argv) {
  const pr = argv[0];
  if (!pr || !/^\d+$/.test(pr)) {
    console.error('用法：node scripts/check-cross-pr-merge.js <PR 編號>');
    return 2;
  }
  let repoRoot; let self; let list;
  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    self = JSON.parse(gh(['pr', 'view', pr, '--json', 'number,headRefOid,baseRefName']));
    list = JSON.parse(gh(['pr', 'list', '--state', 'open', '--base', 'main',
      '--json', 'number,headRefOid,headRefName,baseRefName,isDraft', '--limit', '100']));
  } catch (e) {
    console.error(`跨 PR 試合併 PR #${pr}：查不清楚（${/** @type {any} */ (e)?.message}）——一律當成未通過。`);
    return 2;   // fail-closed
  }
  if (!self?.headRefOid || !Array.isArray(list)) {
    console.error(`跨 PR 試合併 PR #${pr}：gh 回傳的形狀不對——一律當成未通過。`);
    return 2;
  }
  const others = othersToTry(list, Number(pr));
  // ⚠️ 試合併前先驗發起樹的 node_modules（2026-08-11 #441 實踩）：臨時工作區的
  //    node_modules 是 symlink 指回發起樹（見 tryMerge 檔頭），發起樹自己沒有
  //    （例如 /private/tmp 的代合併樹）＝懸空連結，三關全部「指令找不到」，
  //    被誤報成「#442 合起來之後『校對』紅了」退出碼 1——但那支只動了兩個 .md。
  //    環境問題的誠實語意是「查不清楚」（2），不是「兩支相斥」（1）。
  //    零支其他 PR 時刻意不驗：那個結論不需要跑三關，#438 的代合併正是這樣安全通過的
  //    ——把它也擋下來＝誤傷本來就正確的用法。
  //    先驗用 statSync 驗到「是目錄」為止——existsSync 只驗「存在」，node_modules 是
  //    普通檔案（或 symlink 指到檔案）時照樣 true（#446 r1 Codex 抓的洞）。
  //    「存在但殘缺」先驗驗不了，由三關的「執行不起來」分類接手（見 tryMerge 的 catch）。
  const nmSrc = join(repoRoot, 'node_modules');
  if (others.length && !isUsableNodeModulesDir(nmSrc)) {
    console.error(
      `跨 PR 試合併 PR #${pr}：查不清楚——發起樹沒有可用的 node_modules（${nmSrc} 不存在、不是目錄、或是懸空連結）。\n`
      + '  請從主目錄跑這道閘，或先把 node_modules symlink 掛進發起樹再跑一次。');
    return 2;
  }
  const results = [];
  for (const o of others) {
    try {
      results.push(tryMerge(repoRoot, self.headRefOid, o.headRefOid, o.number));
    } catch (e) {
      console.error(`跨 PR 試合併 PR #${pr}：建不出臨時工作區（${/** @type {any} */ (e)?.message}）。`);
      return 2;
    }
  }
  const v = verdict(results);
  (v.code === 0 ? console.log : console.error)(v.message);
  return v.code;
}

// 只有直接執行才跑（考題 import 純函式；端到端考題用假 gh 跑整支）。
// 判斷一律走 `lib/is-main.js`——symlink 與百分號編碼兩個坑寫在那裡，
// 這裡不重述（重述的說明會漂）。它答錯的後果：`main()` 從來沒跑而退出碼是 0，
// **一道閘「什麼都沒做卻回報通過」比它不存在更危險**。考題 `test/entry-guard.test.js` 盯著。
if (isMainModule(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
