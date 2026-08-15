// @ts-check
// 呼叫端行為題的**共用探針**：證明「這個呼叫點真的走了 `gitEnv()`」。
//
// ## 為什麼有兩種題，而且第二種才是真的門
//
// r1 複審抓到（#463 r1 Medium）：呼叫端行為題原本各自只注入 `GIT_DIR`
// ⇒ 把 `gitEnv()` 退化成「只刪 `GIT_DIR`」的**列名版**，七條全部照樣綠。
// 而「列名補不完」正是這一族存在的全部理由——**我自己做了一顆自己在防的假綠**。
//
// 我第一次的修法是「再挑一個第二家族變數一起注」，**那條路是死的**。實測（2026-08-15，
// 對本專案四種呼叫形狀）：
//
// | 注入 | `ls-files --cached --others --exclude-standard` | `ls-files` | `grep` | `rev-parse --show-toplevel` |
// |---|---|---|---|---|
// | `GIT_DIR` | 變 | 變 | 變 | 變 |
// | `GIT_WORK_TREE` | 變 | 變 | 變 | **不變** |
// | `GIT_INDEX_FILE` | **不變** | 變 | 變 | **不變** |
// | `GIT_CONFIG_*`（`core.excludesFile` 指到不存在的檔） | **不變** | **不變** | **不變** | **不變** |
//
// ⇒ **沒有任何一個變數對四種形狀都有影響力**；挑變數本身就是又一次列舉。
//    （⚠️ 我的第一版探針還量錯過：`env $v "$@"` 在 zsh 下不會分詞，`env` 把整串當成指令名而報錯，
//      我把那個錯誤輸出讀成「行為改變了」。註解裡的實測數字要自己重量，不可沿用。）
//
// 所以分成兩種題，射程各自寫清楚：
//
// - **①「答案仍然正確」**（`injectDirtyGitEnv`）：注入 `GIT_DIR`——上表唯一四種形狀通吃的那個，
//   也正是 2026-08-09 事故的原兇。它證明的是**真實情境下結果沒被帶偏**。
//   ⚠️ 誠實劃界：它是**代理指標**，只涵蓋「剛好會改變這個指令的變數」。
// - **②「子行程收到什麼」**（`gitEnvSeenBy`）：把一支假 `git` 放到 PATH 最前面，
//   直接讀它實際看到的環境。**不管未來冒出哪個沒人見過的家族都涵蓋得到**——這一種才關得起門。

import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 髒環境的內容。**兩個用途**：①題的注入來源 ②`gitEnvSeenBy` 的注入來源。
 *
 * ⚠️ 這裡刻意**混合三種**：事故原兇（`GIT_DIR`）、`git -c` 會生出來的會長一族（`GIT_CONFIG_*`）、
 *    以及一個**這個世界上還不存在**的名字（`GIT_BOGUS_FUTURE_THING`）。最後那個是重點：
 *    列名式的清法不可能認得它，而題②會抓到它。
 */
export const DIRTY_GIT_ENV = Object.freeze({
  GIT_DIR: join(tmpdir(), 'definitely-not-a-git-dir-xyz'),
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'core.excludesFile',
  GIT_CONFIG_VALUE_0: join(tmpdir(), 'definitely-not-an-exclude-file-xyz'),
  GIT_BOGUS_FUTURE_THING: 'unlisted',
});

/**
 * 【題①】把髒環境塞進 `process.env`，回傳「還原」函式。
 *
 * 回傳 restore 而不是包一層 callback，是為了讓同步與 async 的呼叫端共用同一份
 * （`test/xlsx-isolate.test.js` 的 `productionFiles()` 是 async）：
 *
 * ```js
 * const restore = injectDirtyGitEnv();
 * try { ...斷言結果仍然正確... } finally { restore(); }
 * ```
 *
 * @returns {() => void} 還原函式（一定要放進 `finally`，否則污染同行程的其他考題）
 */
export function injectDirtyGitEnv() {
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  for (const [key, value] of Object.entries(DIRTY_GIT_ENV)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, before] of Object.entries(saved)) {
      if (before === undefined) delete process.env[key]; else process.env[key] = before;
    }
  };
}

/**
 * 【題②】在 `PATH` 最前面放一支**假 `git`**，在髒環境下跑 `fn`，回報那支假 git 實際看到什麼。
 *
 * ⚠️ 假 git 一律 exit 0、不輸出東西 ⇒ 呼叫端會拿到空清單、或因為形狀不對而丟例外。
 *    **那不是重點**（本題不看結果，看的是環境），所以 `fn` 的例外一律吞掉——
 *    但「假 git 到底有沒有被叫到」要斷言，不然這一題會在什麼都沒發生的情況下通過。
 *
 * ⚠️ `gitEnv()` 保留 `PATH` 是本題成立的前提（清掉 PATH 就找不到 git 執行檔，全部呼叫端一起紅，
 *    那有 `test/git-env.test.js` 的反面斷言守著）。
 *
 * @param {() => unknown} fn 會去 spawn `git` 的那段程式
 * @returns {{ called: boolean, leaked: string[] }} `leaked`＝假 git 看到的 `GIT_*` 變數名（排序過）
 */
export function gitEnvSeenBy(fn) {
  const probe = startProbe();
  try {
    try { fn(); } catch { /* 假 git 的輸出當然不合呼叫端的預期——本題不看結果，看環境 */ }
    return probe.read();
  } finally {
    probe.stop();
  }
}

/**
 * 【題②的 async 版】給 `productionFiles()` 這種 async 呼叫端用。
 *
 * ⚠️ 非有這一版不可：假 git 與髒環境要**撐到那段 async 真的跑完**才能收。用同步版包一個
 *    回 Promise 的函式，`finally` 會在它還沒 spawn 之前就把 PATH 還原掉——探針量到空的，
 *    然後這一題會「什麼都沒驗卻通過」（`called` 那條斷言會抓到，但那是靠運氣，不是設計）。
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ called: boolean, leaked: string[] }>}
 */
export async function gitEnvSeenByAsync(fn) {
  const probe = startProbe();
  try {
    try { await fn(); } catch { /* 同上 */ }
    return probe.read();
  } finally {
    probe.stop();
  }
}

/** 假 git ＋ 髒環境的架設與拆除（同步／async 兩版共用，避免兩份各自漂）。 */
function startProbe() {
  const dir = mkdtempSync(join(tmpdir(), 'git-env-seen-'));
  const log = join(dir, 'seen.txt');
  const savedPath = process.env.PATH;
  const restoreDirty = injectDirtyGitEnv();
  writeFileSync(join(dir, 'git'),
    `#!/bin/sh\n{ echo CALLED; env | grep '^GIT_' | cut -d= -f1 | sort; } >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(join(dir, 'git'), 0o755);
  process.env.PATH = `${dir}:${savedPath ?? ''}`;
  return {
    read() {
      if (!existsSync(log)) return { called: false, leaked: /** @type {string[]} */ ([]) };
      const lines = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
      return { called: lines.includes('CALLED'), leaked: [...new Set(lines.filter((l) => l.startsWith('GIT_')))].sort() };
    },
    stop() {
      restoreDirty();
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * 【題②的斷言版】給呼叫端直接用，訊息統一。
 * @param {import('node:assert')} assert node:assert/strict
 * @param {string} what 這個呼叫點的名字（出現在失敗訊息裡）
 * @param {() => unknown} fn
 */
export function assertChildGitEnvClean(assert, what, fn) {
  reportSeen(assert, what, gitEnvSeenBy(fn));
}

/**
 * 【題②的斷言版・async】
 * @param {import('node:assert')} assert @param {string} what @param {() => Promise<unknown>} fn
 */
export async function assertChildGitEnvCleanAsync(assert, what, fn) {
  reportSeen(assert, what, await gitEnvSeenByAsync(fn));
}

/** @param {import('node:assert')} assert @param {string} what @param {{called: boolean, leaked: string[]}} seen */
function reportSeen(assert, what, seen) {
  assert.ok(seen.called,
    `${what}：假 git 根本沒被叫到 ⇒ 這一題是空轉的（呼叫點沒 spawn git？PATH 被清掉了？）`);
  assert.deepEqual(seen.leaked, [],
    `${what} 把這些 GIT_* 原封不動傳給 git 了：${seen.leaked.join('、')}\n`
    + '⇒ 那個呼叫點沒有走 lib/git-env.js 的 gitEnv()（或走了一份「列名式」的清法，'
    + '而列名永遠追不上——`GIT_CONFIG_*` 是 `git -c` 生出來的、名字是變數）。');
}
