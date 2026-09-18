// @ts-check
// 錢的考題專用：給 Claude 側釘指紋那一行一個**暫存的家**（2026-09-19，Claude 側釘指紋第 2 支）。
//
// 為什麼要有這一份：`.claude/settings.json` 的 PreToolUse 那一行只寫指紋，判斷讀的是
// `$HOME/.local/share/ai-collab-kit/guard/<指紋>` 這一份倉庫外的固定複本（範本＝templates/hook-claude-pinned.json）。
// 考題要真的跑那一行，就得讓 HOME 指到一個裡面有那一份複本的家；而
//   ・**CI 上真的家目錄沒有複本**（每台機器由人跑 `node tools/guard-copy.js --claude` 補，雲端沒有人補）；
//   ・考題**不可以讀或寫真的** `~/.local/share/ai-collab-kit`（那一份是 William 機器上那一行正在用的）。
// 所以每支考題自己開一個暫存家、在裡面用**這棵樹當下的四個檔**造一份複本，跑完刪掉。
//
// 位元組怎麼來（要跟 `--claude` 抽出來的一致，不然那一行的指紋對不上＝全擋）：
//   ・`tools/forbidden-tools.js`、`tools/settings-data.js`、`tools/package.json`：原樣複製；
//   ・`settings.json`：只留 forbidden 那一塊，寫法照 tools/guard-copy.js 的 forbiddenOnly()（縮排 2、結尾一個換行）。
//     那一支沒有匯出，這裡另寫一份——**所以造完一定用 tools/guard-copy.js 匯出的 fingerprintDir() 算一次，
//     要等於 treeFingerprint(root)**（那一支自己的寫法算的），不等就當場丟 AssertionError（呼叫的考題因此紅）：
//     這一條本身就是「兩份寫法一致」的對照，寫法漂了不會靜靜造出一份對不上的複本。
//   ・檔案唯讀（0o444），跟 `--claude` 落地的一樣；目錄照預設權限（刪得掉）。
//
// ⚠️ 誠實劃界：
//   ・這一份是從**工作樹**造的（含沒提交的改動），不是 `--claude` 從已合併版本抽的那一份；
//     證明的是「這棵樹的清單裝進那一行之後擋該擋、放該放」。William 機器上那一份有沒有、是不是同一個指紋，
//     只有在真的對話按測試鈕量得到。
//   ・跑那一行時 HOME 要由呼叫的考題自己放進子行程的環境（這裡只造家、不起子行程）。漏給＝沿用考卷自己的 HOME：
//     在補過複本的機器上會讀到真的那一份而照樣綠（看不出漏給）；只有 CI、或外層把 HOME 指到空目錄的跑法會「指紋對不上」而紅。
//     所以兩支呼叫的考題都只在一處起子行程、那一處一律放 HOME（test/money-kit-hook.test.js 的 run() 漏給 home 就當場丟錯）。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import guardCopy from '../../tools/guard-copy.js';

const { COPY_FILES, CLAUDE_BASE, fingerprintDir, treeFingerprint } = guardCopy;

/** 暫存家的前綴：removeHome() 只刪名字是這兩種開頭、而且直接在 os.tmpdir() 底下的目錄。 */
const PREFIXES = ['pfw-empty-home-', 'pfw-pinned-home-'];
const newHome = (/** @type {string} */ prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** 一個空的暫存家（沒有任何複本）：「這台機器還沒補複本」那一種情境用。 */
export function makeEmptyHome() {
  return newHome(PREFIXES[0]);
}

/**
 * 開一個暫存家、在裡面用 root 這棵樹當下的四個檔造一份複本。回 { home, fp, copyDir }。
 * 造完驗：fingerprintDir(複本)＝treeFingerprint(root)，不等＝刪掉剛開的家、丟 AssertionError。
 * @param {string} root
 */
export function makePinnedHome(root) {
  const home = newHome(PREFIXES[1]);
  try {
    const fp = treeFingerprint(root);
    const copyDir = join(home, ...CLAUDE_BASE, fp);
    for (const rel of COPY_FILES) {
      const bytes = rel === 'settings.json'
        ? Buffer.from(`${JSON.stringify({ forbidden: JSON.parse(readFileSync(join(root, rel), 'utf8')).forbidden }, null, 2)}\n`, 'utf8')
        : readFileSync(join(root, rel));
      mkdirSync(dirname(join(copyDir, rel)), { recursive: true });
      writeFileSync(join(copyDir, rel), bytes, { flag: 'wx', mode: 0o444 });
    }
    assert.equal(fingerprintDir(copyDir), fp,
      '考題造的複本跟 tools/guard-copy.js 算的指紋對不上：這裡另寫的 settings.json 寫法（只留 forbidden、縮排 2、結尾一個換行）'
      + '跟那一支的 forbiddenOnly() 漂開了——照那一支改回來（這一份對不上＝那一行在考題裡全擋，量到的不是清單）');
    return { home, fp, copyDir };
  } catch (e) {
    removeHome(home);
    throw e;
  }
}

/**
 * 刪掉考題自己開的暫存家（先把權限打開：複本裡的檔是唯讀）。只收 os.tmpdir() 底下、名字是 PREFIXES 那兩種開頭的目錄。
 * @param {string} home
 */
export function removeHome(home) {
  assert.ok(dirname(home) === realpathSync(tmpdir()) && PREFIXES.some((p) => basename(home).startsWith(p)),
    `removeHome 只刪這一份開的暫存家（os.tmpdir() 底下、${PREFIXES.join('／')} 開頭）：${home}`);
  const walk = (/** @type {string} */ p) => {
    let st;
    try { st = lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    try { chmodSync(p, 0o755); } catch { /* 已經不在 */ }
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
  };
  walk(home);
  rmSync(home, { recursive: true, force: true });
}
