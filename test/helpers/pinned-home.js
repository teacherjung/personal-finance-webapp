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
//   ・跑那一行時 HOME 要由呼叫的考題自己放進子行程的環境（這裡只造家、不起子行程，**這一支自己什麼都擋不住**）。
//     漏帶＝子行程沿用考卷自己的 HOME：在補過複本的機器上會讀到真的那一份而照樣綠；只有 CI、或外層 HOME 是空目錄的跑法
//     會「指紋對不上」而紅。擋得住什麼（都在呼叫的考題裡，不在這裡）：
//       ・test/money-kit-hook.test.js：runRaw() 沒給 home 參數＝當場丟錯（擋「忘了傳」）；子行程的環境裡把 HOME 拿掉＝
//         外層有對得上的複本時紅在③「暫存家裡沒有複本」那一題，外層沒有時每一題實跑那一行的都紅；
//       ・test/money-boundary.test.js：「探針真的把 HOME 帶進子行程」那一題用空的暫存家叫同一個 probe()、要起不來——
//         拿掉 HOME 在外層有對得上的複本時紅在這一題，外層沒有時連同其餘探針題一起紅。
//       （2026-09-19 兩種外層各跑一次量過。）
//     擋不住的：紅之前那幾發已經用考卷自己的 HOME 跑過（補過複本的機器上＝讀過真的那一份，只讀不寫）；
//     不經過這兩處（runRaw／probe）另起子行程跑那一行的新寫法，沒有任何一題看得到。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync, readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import guardCopy from '../../tools/guard-copy.js';

const { COPY_FILES, CLAUDE_BASE, fingerprintDir, treeFingerprint } = guardCopy;

/**
 * 考卷語境的提示（兩支呼叫的考題共用這一句）：跑那一行時 HOME＝makePinnedHome() 造的家、錯誤輸出卻是「指紋對不上」那一句，
 * 在考卷裡的意思是 `.claude/settings.json` 那一行沒跟著重印（家是照這棵樹當下四個檔造的、那一行找的是舊指紋）——
 * 那一句本身叫人「原句轉給裁示者」是寫給真的對話的，考卷裡照這一句處理。失敗訊息裡原句照印、另外接這一句。
 * 前提是 HOME 真的帶進了子行程：HOME 沒帶進去（CI 或外層 HOME 是空的）時一樣印「指紋對不上」，而等式題①是綠的——
 * 所以這一句後半補了這個分辨法（內部核對量到：拿掉 HOME、外層是空的，9 題紅、9 則都接這一句，①是綠的）。
 */
export const PIN_MISMATCH_HINT = '——考題的暫存家是照這棵樹當下四個檔造的；這裡對不上＝.claude/settings.json 那一行沒跟著重印，'
  + '先看 money-kit-hook ①、照手續重跑 --claude-line；這不是要轉給裁示者的那種情況'
  + '（money-kit-hook ① 是綠的卻紅在這裡＝不是沒重印：先看探針／runRaw 有沒有把 HOME 帶進子行程——就是「探針真的把 HOME 帶進子行程」那一題守的那件事）';
/** 錯誤輸出含「指紋對不上」＝回 PIN_MISMATCH_HINT，否則空字串。只給 HOME＝makePinnedHome() 造的家的那幾發用。 */
export const pinMismatchHint = (/** @type {unknown} */ stderr) => (/指紋對不上/u.test(String(stderr)) ? PIN_MISMATCH_HINT : '');

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
