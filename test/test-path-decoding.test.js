import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ⚠️ 為什麼要有這一題（2026-08-08 實際事故）：
 * `new URL(…).pathname` 留著 URL 編碼。本專案實際落在「07 專案/榮祥森（投資理財）」
 * 這種含**空白與中文**的路徑下，於是它算出 `.../07%20%E5%B0%88%E6%A1%88/...`
 * ⇒ 掃描原始碼的考題 `readFileSync` 直接 ENOENT。
 *
 * 這個病的形狀最惡：#417 的實作樹與十四棵審查樹都落在純 ASCII 的 `/private/tmp/…`
 * ＝四題全綠、十四輪審查也全綠；**合併進 main、在使用者自己的目錄跑才紅。**
 * ⇒ 「考題在開發者機器上綠」不代表「在使用者機器上綠」，路徑是這條分界線上最常見的那顆雷。
 */

/**
 * 去註解但**保留行數與行內位移**（把註解內容換成空白，換行原樣留著）——
 * 這樣掃出來的位置還能換算成行號。
 *
 * ⚠️ 為什麼不能用「整行開頭是不是 `//`／`*`」判斷（r1 阻擋①，複驗者用探針證明）：
 *    `/* 說明 *\/ const R = new URL('..', import.meta.url).pathname;` 這種**同一行前半是註解、
 *    後半是真程式**的寫法會被整行跳過 ⇒ 真違規逃掉。逐行正則也接不住跨行寫法。
 * ⚠️ 字串與正規式裡的 `//` 不可當註解剝（`'https://…'`、`/\/\//`）——否則真程式會憑空消失＝另一種假綠。
 */
export function blankOutComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | sq | dq | tpl | re
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { mode = 'sq'; out += c; i++; continue; }
      if (c === '"') { mode = 'dq'; out += c; i++; continue; }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue; }
      // 正規式字面：只在「前一個非空白字元不可能是運算元結尾」時才算（夠用，且錯的方向是少剝不是多剝）
      if (c === '/') {
        const prev = out.replace(/\s+$/, '').slice(-1);
        if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)) { mode = 're'; out += c; i++; continue; }
      }
      out += c; i++; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c; i++; continue; }
      out += ' '; i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    // 字串／樣板／正規式內：原樣抄，處理轉義與結束字元
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
    const closer = { sq: "'", dq: '"', tpl: '`', re: '/' }[mode];
    out += c; i++;
    if (c === closer) mode = 'code';
    else if (c === '\n' && (mode === 'sq' || mode === 'dq' || mode === 're')) mode = 'code'; // 未閉合就當結束
    continue;
  }
  return out;
}

// ⚠️ 這個寫法本身不能寫成本檔的字面常數再去比對——那會讓本檔自己成為違規者。用組裝的方式表達。
const BAD = new RegExp(String.raw`new\s+URL\([^)]*import\.meta\.url[^)]*\)\s*\.\s*pathname`);

function scanFile(rel) {
  const src = blankOutComments(readFileSync(join(ROOT, rel), 'utf8'));
  const hits = [];
  const re = new RegExp(BAD.source, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    hits.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
  }
  return hits;
}

test('掃原始碼的考題不可用 new URL(…).pathname 當檔案路徑（含空白／中文的目錄會 ENOENT）', () => {
  const offenders = [];
  for (const dir of ['test', 'scripts', 'lib', 'public']) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base, { recursive: true })) {
      if (typeof f !== 'string' || !f.endsWith('.js')) continue;
      offenders.push(...scanFile(join(dir, f)));
    }
  }
  assert.deepEqual(offenders, [],
    '這些地方用 `new URL(…).pathname` 當檔案路徑：\n  ' + offenders.join('\n  ')
    + '\n\n它留著 URL 編碼，遇到含空白或中文的專案路徑（本專案就是）會 ENOENT。'
    + "\n改用：const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');"
    + '\n⚠️ 這種錯在純 ASCII 的實作樹裡完全看不出來——#417 十四輪審查全綠，合併後在主目錄才紅。');
});

test('⭐ 掃描器自己的探針：註解要剝乾淨、但真程式不可被剝掉', () => {
  // ⚠️ 這一題就是 r1 阻擋①：複驗者的探針（行首區塊註解結束後接真違規）當時 2/2 綠＝漏口。
  //    把它固定成考題，連同其他三種形狀一起釘住。
  // ⚠️ 探針字串**必須組裝**、不可寫成字面：寫成字面的話上一題掃到本檔就會把探針當違規者
  //    （第一版就是這樣，本檔自己紅了六行）。組裝之後本檔完全不含那個字面。
  const U = 'new URL';
  const IMU = 'import' + '.meta.url';
  const PN = '.' + 'pathname';
  const bad = `${U}('..', ${IMU})${PN}`;

  const mustCatch = [
    ['同一行：前半區塊註解、後半真違規', `/* 說明 */ const R = ${bad};`],
    ['跨行寫法', `const R = ${U}('..',\n  ${IMU})${PN};`],
    ['點號前後有空白', `const R = ${U}('..', ${IMU}) . pathname;`],
    ['行尾註解在後面', `const R = ${bad}; // 舊寫法`],
    ['多行區塊註解結束後同行接真違規', `/*\n * 說明\n */ const R = ${bad};`],
  ];
  for (const [why, src] of mustCatch) {
    assert.match(blankOutComments(src), BAD, `這種形狀必須抓到卻漏了：${why}`);
  }

  const mustIgnore = [
    ['純行註解裡提到', `// 不可以用 ${bad}`],
    ['區塊註解裡提到', `/*\n * ${bad} 是錯的\n */`],
    ['HTTP URL 的 pathname（不是檔案路徑）', `const p = ${U}(req.url, 'http://x')${PN};`],
  ];
  for (const [why, src] of mustIgnore) {
    assert.doesNotMatch(blankOutComments(src), BAD, `這種不該算違規卻被抓：${why}`);
  }

  // ⚠️ 反面自我驗證：確認剝註解沒有把字串裡的 `//` 當註解剝掉（那會讓真程式憑空消失＝假綠）
  assert.match(blankOutComments("const u = 'https://example.com/a';"), /https:\/\/example\.com\/a/,
    '字串裡的 `//` 被當註解剝掉了——真程式會憑空消失，掃描器從此靜靜全綠');
  assert.match(blankOutComments('const re = /\\/\\//; const x = 1;'), /const x = 1/,
    '正規式字面把剝註解帶歪了，後面的真程式被吃掉');
});

test('ROOT 這一顆真的指到 repo 根（否則上面兩題就是在空掃）', () => {
  // ⚠️ 只斷言「沒有違規者」會在 ROOT 算錯時假綠（掃不到檔案＝清單當然空）。
  assert.ok(existsSync(join(ROOT, 'package.json')), 'ROOT 沒指到 repo 根，上面那題等於什麼都沒掃');
  assert.ok(readdirSync(join(ROOT, 'test')).length > 50, 'test/ 掃到的檔案數不對，ROOT 可能算錯');
});
