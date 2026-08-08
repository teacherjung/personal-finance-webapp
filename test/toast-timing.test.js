// @ts-check
// 提示停留時間的考題：**訊息讀得完，出聲才算數**。
//
// 這一族守的是 r2 審查者抓到的洞：整支 #417 的保證是「按下匯出會說話」，而那些話全靠右下角的
// ⚠️ **2026-08-08 訂正（原文以下保留作沿革）**：William 兩輪縮短之後，匯出文案已經是
//    **一行、12–18 字**（成功那句尾巴掛檔名與筆數），而且「把這句話整句告訴我」那個指令
//    整句拿掉了。所以下面「40–100 字」「兩句叫他整句告訴我」講的是**縮短之前**的狀態。
//    ⚠️ 但這一支的價值不變：**提示停留時間照字數給**（成功那句含長檔名仍可能偏長），
//    而「短句 3.2 秒夠」正是縮短之後仍要守住的下限。
// toast 投遞——`public/app.js` 的 `toast()` 原本固定 3.2 秒就把訊息移除，而匯出的文案是 40–100 字，
// 3.2 秒內要讀完得每秒十幾到快三十個字。更糟的是其中兩句叫他「把這句話整句告訴我（⚠️ 2026-08-08 起這個指令已隨文案縮短移除，見下）」，
// 而那句話幾秒後就不存在、也不能複製。**文案寫得再白話，他讀不到就等於沒說。**
//
// ⚠️ 這裡的標準（每個字至少 `MIN_MS_PER_CHAR` 毫秒）是**考題自己定的**、比正式程式給的還寬鬆
//    （`TOAST_MS_PER_CHAR` 目前更慢），刻意留餘裕：這樣「把時間改回固定值」與「文案長到讀不完」
//    兩種壞法都會紅，而正式程式微調每字時間不會假紅。
// ⚠️ 誠實劃界：行為驗得到的是「時間怎麼算」（純函式）與匯出文案本身（長度、有沒有下一步）。
//    畫面互動在 node 裡沒有 DOM 可跑：只有「滑鼠停在上面暫停」有原始碼文字題（提醒等級、不是保證），
//    toast() 末段的「點一下收掉／選字時不收」（click ＋ getSelection）**零考題**——刪了本檔照樣全綠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { toastMs, TOAST_MIN_MS, TOAST_MAX_MS, TOAST_MS_PER_CHAR } from '../public/modules/toast-timing.js';
import { okMsg, networkFailMsg, authFailMsg, serverFailMsg, notBackupMsg, saveFailMsg }
  from '../public/modules/backup-export.js';
import { fileURLToPath } from 'node:url';

// ⚠️ 路徑一律用 `fileURLToPath` 解碼，**不可以用 `new URL(...).pathname`**：後者留著 URL 編碼，
//    專案實際落在「07 專案/榮祥森（投資理財）」這種含空白與中文的路徑下時會變成 `07%20%E5%B0%88...`
//    ⇒ 掃描器 `readFileSync` 直接 ENOENT，四題接線在 William 的機器上等於從來沒跑過（2026-08-08 實際踩到：
//    #417 在 ASCII 的實作樹裡全綠、合併進 main 後在主目錄四題紅）。repo 其餘 UI 考題本來就用這個寫法。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 去掉 JS 註解——**被註解掉的接線等於不存在**（r5 阻擋②：複驗者把接線改成註解，本檔的形狀題全綠）。
 * ⚠️ 行註解只在 `//` 前面不是 `:`／引號／反斜線／文字時才剝：否則 `https://`、`split('//')`、
 *    正規式 `/\/\//` 會被誤剝半行（那會讓真程式憑空消失＝另一種假綠）。
 * ⚠️ 與 test/vault-and-backup-integrity.test.js 的同名函式**同一份寫法**（那支是先例）。
 * @param {string} s @returns {string}
 */
const stripJsComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"`\w\\])\/\/[^\n]*/g, '$1');

/** 考題自己的「讀得完」標準：每個字至少這麼多毫秒（約每秒五個字，對不習慣讀螢幕的人偏寬鬆）。 */
const MIN_MS_PER_CHAR = 200;

test('提示時間｜短句的時間沒有變（全 app 大多數提示只有幾個字，那些不該被改到）', () => {
  // ⚠️ 這一格是「別把別人弄壞」的保險：這次改的是**長訊息**讀不完的問題，
  //    短提示（「已刪除」「已記錄本月淨資產快照 📸」…）原本 3.2 秒就夠，不可以順手一起加長。
  assert.equal(toastMs('已刪除'), TOAST_MIN_MS, '三個字的提示照舊是下限時間');
  assert.equal(toastMs(''), TOAST_MIN_MS, '空字串也要有下限時間（不可以 0 秒＝閃一下就沒了）');
  assert.equal(toastMs(/** @type {any} */ (undefined)), TOAST_MIN_MS,
    '沒給訊息也不可以丟錯——提示是「出聲」的最後一段路，這裡丟錯等於整條路又變回靜靜失敗');
  assert.equal(toastMs(/** @type {any} */ (null)), TOAST_MIN_MS);
});

test('提示時間｜長訊息照長度給時間（這才是這一族存在的理由）', () => {
  const short = '存好了';
  const long = '匯出失敗，沒有存下任何檔案：伺服器回 500 Internal Server Error'
    + '（這是伺服器那一端的問題，不是你做錯什麼：等一下再試一次，還是不行就把這句話整句告訴我。）';
  assert.ok(toastMs(long) > toastMs(short), '長訊息必須比短訊息停久——同一個時間讀不同長度是說不通的');
  assert.ok(toastMs(long) >= long.length * MIN_MS_PER_CHAR,
    `${long.length} 字的訊息至少要停 ${long.length * MIN_MS_PER_CHAR} 毫秒才讀得完，`
    + `現在只給 ${toastMs(long)}——把時間改回固定值（例如 3200）就是這一格會紅的那個壞法`);
  // 每字時間本身也要有下限：正式程式可以調快一點，但不可以調到「其實等於固定值」。
  assert.ok(TOAST_MS_PER_CHAR >= MIN_MS_PER_CHAR,
    '每個字給的時間不可以低於考題的讀得完標準（要調就要連這條標準一起討論，不可以偷偷調快）');
});

test('提示時間｜有上限：一則提示不可以無限期佔住畫面角落', () => {
  const monster = '啊'.repeat(5000);
  assert.equal(toastMs(monster), TOAST_MAX_MS, '再長也停在上限');
  assert.ok(TOAST_MAX_MS > TOAST_MIN_MS);
});

test('提示時間｜匯出那幾句話，每一句都讀得完（文案與投遞機制要對得起來）', () => {
  // ⚠️ 這一格把**文案**與**投遞機制**綁在一起：以後有人把訊息寫更長，這裡就會紅——
  //    那時該做的是「短提示 ＋ openInfo(...) 放完整說明」（repo 已有 openInfo 與 .info-link，
  //    也符合使用者「必須懂的就地解釋」鐵則），不是把上限往上調。
  // ⚠️ 失敗那五句**不收參數**（畫面一行只給下一步，伺服器原話與狀態碼留在 runExport 的回傳 reason）；
  //    成功那句例外：okMsg(筆數, 檔名) 仍收兩個參數，量級資訊掛句尾括號、不佔句子本體。
  const msgs = [
    ['成功', okMsg(3214, 'finance-backup-2026-08.json')],
    ['連線斷掉', networkFailMsg()],
    ['401 要登入', authFailMsg()],
    ['伺服器掛了', serverFailMsg()],
    ['回的不是備份', notBackupMsg()],
    ['落檔出錯', saveFailMsg()],
  ];
  for (const [what, msg] of msgs) {
    const need = msg.length * MIN_MS_PER_CHAR;
    assert.ok(toastMs(msg) >= need,
      `「${what}」那句話有 ${msg.length} 字，需要至少 ${need} 毫秒才讀得完，現在只給 ${toastMs(msg)}——`
      + '這句話裡有他的下一步（其中兩句還叫他「把這句話整句告訴我」），讀不到就等於沒說');
  }
  // ⚠️ 舊版這裡釘著「失敗文案含『把這句話整句告訴我』」——**William 2026-08-08 兩輪縮短之後，
  //    那個指令整句拿掉了**（畫面只留下一步）。所以改釘現在真正需要讀完的東西：
  //    每一句都短到一定讀得完，而且**都有下一步**（不是只講「失敗了」就停住）。
  for (const [what, msg] of msgs) {
    // 成功那句尾巴掛著（檔名，共 N 筆）＝**變動長度的量級資訊**，不算文案長度；
    // 括號前那一截才是句子本體（檔名長不長不是文案能決定的事）。
    const body = msg.replace(/（.*$/, '');
    assert.ok(body.length <= 24, `「${what}」句子本體 ${body.length} 字——縮短後的口徑是一行為限`);
  }
  assert.ok(msgs.every(([, m]) => /請|確認/.test(m)),
    '每一句都要有下一步（「請…」或「…確認…」）：只講失敗不講下一步，他讀完還是不知道要幹嘛');
});

/** 從 `from` 起抓出配對到的那一段，含頭尾括號（純字元計數，不懂字串裡的括號——抓不到會紅、不會假綠）。
 * @param {string} src @param {number} from @param {string} open @param {string} close */
function matchedSpan(src, from, open, close) {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(from, i + 1);
  }
  return '';
}

test('接線｜app.js 的 toast() 真的照長度給時間，而且滑鼠停在上面不會被抽走', () => {
  // ⚠️ 為什麼是原始碼文字題：`public/app.js` 在 node 裡 import 不進來（模組頂層就碰 document／
  //    localStorage），所以「正式環境那一行到底怎麼寫」只驗得到文字（比字，不執行）。
  //    別拿 `test/xss-id-escaping.test.js` 當前例：#409 後它改成直接 import 正式的 esc 跑行為。
  // ⚠️ 誠實劃界：這一題擋的是「下一個人把時間改回固定值、或把暫停拿掉」，不是「跑起來真的會暫停」。
  const src = stripJsComments(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
  assert.match(src, /import\s*\{[^}]*\btoastMs\b[^}]*\}\s*from\s*['"]\.\/modules\/toast-timing\.js['"]/,
    'app.js 必須從 modules/toast-timing.js import toastMs——時間算法抄一份在 app.js 裡就沒有考題撐得住');

  const at = src.indexOf('export function toast(');
  assert.ok(at >= 0, '找不到 toast() 的定義（改名了？那要一起更新本考題）');
  const body = matchedSpan(src, src.indexOf('{', at), '{', '}');
  assert.ok(body.length > 2, 'toast() 的函式主體沒抓到（寫法太特殊——原始碼文字題的限制）');

  assert.match(body, /\btoastMs\s*\(/,
    'toast() 必須用 toastMs(訊息) 算停留時間——固定秒數會讓長訊息讀不完（這一支所有文案都靠它投遞）');
  const hardcoded = body.match(/setTimeout\s*\([\s\S]*?,\s*(\d+)\s*\)/);
  assert.equal(hardcoded, null,
    `toast() 裡的 setTimeout 不可以用寫死的毫秒數（抓到「${hardcoded?.[1] ?? ''}」）——`
    + '那正是 r2 審查者抓到的洞：固定 3.2 秒，而匯出失敗那幾句要讀二十幾秒');
  assert.match(body, /mouseenter|pointerenter|mouseover/,
    '滑鼠停在提示上面時要暫停（不然他讀到一半、或正要選字複製，訊息就被抽走）');
  assert.match(body, /clearTimeout/,
    '暫停要真的把計時器停掉——只綁事件不停計時器等於沒暫停');
});
