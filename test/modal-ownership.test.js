// @ts-check
// #modal-root 世代擁有權（P0.5 r6→r9）：純邏輯行為題（DOM 無關）＋ 全站開窗點的接線形狀題。
// 為什麼要它：全站表單 onSubmit 有 await，回來時可能 (1) 使用者已換頁、或 (2) 期間開了新彈窗——
// 舊的成功 continuation 不可 close() 掉後開的彈窗、也不可在新頁報過期錯誤。
// owns() 用兩個判準判「這一格還是不是我的」：世代章（開窗/關窗都蓋章）＋**換頁**序號。
// ⚠️ r9 的核心教訓：判準②吃的必須是「換頁」序號，不是「重繪」序號。r7 接成重繪序號（routeSeq），
//   開機報價更新這種**同頁背景重繪**就把擁有權撤掉了——存檔成功卻不關窗、儲存鈕永遠灰。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeModalOwnership } from '../public/modules/modal-ownership.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('擁有權｜新 claim 讓舊持有者的 owns() 立刻變 false；最新的一份 owns() 為 true', () => {
  let cell = 0;   // 假的共用格（＝真實碼裡 #modal-root 的 dataset.modalGen）
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const ownsA = claim();
  assert.equal(ownsA(), true, '剛 claim＝擁有');
  const ownsB = claim();   // 第二個彈窗接管
  assert.equal(ownsA(), false, '被後來的 claim 蓋章＝舊的不再擁有（舊 async close 就作廢）');
  assert.equal(ownsB(), true, '最新的一份擁有');
  const ownsC = claim();
  assert.deepEqual([ownsA(), ownsB(), ownsC()], [false, false, true], '永遠只有最新那一份 owns');
});

test('擁有權｜owns() 讀的是「當下」的章（外部把格清成 0 也不再擁有）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true);
  cell = 0;   // 例如 modal-root 被清空、dataset 沒了
  assert.equal(owns(), false, '章不見了＝不擁有（不會誤 close 空格或別人的內容）');
});

test('擁有權｜release() 撤銷擁有權：關窗後舊持有者的 owns() 立刻變 false（不再誤 close/toast）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true, '剛 claim＝擁有');
  owns.release();   // 關窗＝撤銷
  assert.equal(owns(), false, '關窗後舊 async 回來時 owns() 為 false＝不會對已關的窗 close/toast');
});

// ⭐ r9（Codex r8 Medium①的「本 PR 新種下」那半）：release 必須**有主才撤**。
// 舊窗的 close 若無條件蓋章，會把**後開那個窗**的擁有權一起洗掉——等於幫下一個 stale continuation 開門。
test('⭐ 擁有權｜release 有主才撤：不是主人時呼叫 release，不可洗掉現任的擁有權', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const ownsOld = claim();
  const ownsNew = claim();            // 新窗接管
  assert.deepEqual([ownsOld(), ownsNew()], [false, true]);
  ownsOld.release();                  // 舊窗的 close 這時才跑（stale）
  assert.equal(ownsNew(), true, '舊窗 release 不可把現任的章洗掉（否則新窗立刻變成無主、任人 close）');
  ownsNew.release();
  assert.equal(ownsNew(), false, '現任自己 release 才算數');
});

// ⭐ r9 核心回歸題：同頁重繪 ≠ 換頁。這一題直接鎖住 r7 那顆「存檔成功卻不關窗、儲存鈕永遠灰」的 bug。
test('⭐ 擁有權｜同一頁的背景重繪不可撤銷擁有權；使用者真的換頁才失效', () => {
  let cell = 0, nav = 3;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; }, readNav: () => nav });
  const owns = claim();
  assert.equal(owns(), true, '同一頁、章沒動＝擁有');
  // 開機報價更新／自動快照／帳戶對齊都會在同一頁呼叫 router()：重繪序號會跳，但**換頁序號不動**。
  assert.equal(owns(), true, '同頁重繪不影響擁有權（r7 接成重繪序號時這裡會是 false＝送出成功卻不關窗）');
  nav = 4;   // 使用者真的換頁
  assert.equal(owns(), false, '換頁後舊 async 的 close/toast 才作廢');
});

test('擁有權｜沒給 readNav 時退化成純世代章判準（相容不看換頁的呼叫端）', () => {
  let cell = 0;
  const claim = makeModalOwnership({ readGen: () => cell, writeGen: (g) => { cell = g; } });
  const owns = claim();
  assert.equal(owns(), true, '沒有 readNav＝不看換頁，只看章');
});

/** 去註解（接線題掃原始碼形狀，先拿掉註解）。 @param {string} raw */
function strip(raw) { return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }

test('接線｜openForm 的 async onSubmit 只在 owns() 時 close/toast；關窗即 release；ownership 吃換頁序號', () => {
  const app = strip(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
  assert.match(app, /export function claimModalRoot\(\)/, 'claimModalRoot 存在');
  assert.match(app, /readNav: \(\) => currentNavSeq\(\)/, 'ownership 要吃**換頁**序號 currentNavSeq；且包一層箭頭避 TDZ');
  assert.doesNotMatch(app, /readNav: \(\) => currentRouteSeq\(\)/, '不可接回重繪序號 routeSeq（r7 的 bug 來源）');
  assert.match(app, /const owns = claimModalRoot\(\);/, 'openForm 要在開窗當下 claim 並留 owns');
  assert.match(app, /await onSubmit\(out\); if \(owns\(\)\) close\(\);/, 'onSubmit 後只在仍擁有時才 close');
  assert.match(app, /catch \(err\) \{ if \(owns\(\)\)/, '失敗也只在仍擁有時才 toast（不報過期錯誤）');
  assert.ok((app.match(/owns\.release\(\);/g) || []).length >= 2, 'openForm/openInfo 的 close 都要 owns.release()（有主才撤）');
  const shell = strip(readFileSync(join(ROOT, 'public/modules/modal-shell.js'), 'utf8'));
  assert.match(shell, /const owns = claimModalRoot\(\)/, 'openModalShell 也要 claim 並留 owns');
  assert.match(shell, /owns\.release\(\)/, 'openModalShell 的 close 也要 owns.release()');
});

// ⭐ r9→r10：換頁序號本身的定義題——只有**使用者眼前的完整 hash** 變了才前進。
//   接成「每次 router() 都前進」＝退化成重繪序號、bug 原地復活；接成「只比去掉 query 的 route」
//   ＝個股頁換股票不算換頁，舊表單的 continuation 會跑到新股票的畫面上（r10）。
test('⭐ 接線｜navSeq 只在使用者眼前的網址改變時才前進（同頁重繪不動它）', () => {
  const app = strip(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
  assert.match(app, /export const currentNavSeq = \(\) => navSeq;/, 'currentNavSeq 存在且回傳換頁序號');
  assert.match(app, /const navKey = location\.hash;/,
    '換頁鑰匙要用**完整 hash**（r10：個股頁的身分含 ?symbol=&tab=，只比 route 會漏掉換股票）');
  assert.match(app, /if \(navKey !== lastNavKey\) \{ lastNavKey = navKey; navSeq\+\+; \}/,
    'navSeq 只在使用者眼前的網址變了才前進（背景重繪不動網址＝照樣不前進）');
  // routeSeq 仍要每次前進——它管的是「別覆蓋新頁面的畫面」，同頁重繪也該作廢舊寫入。
  assert.match(app, /const seq = \+\+routeSeq;/, 'routeSeq 維持每次 router() 都前進（重繪世代，勿一起改掉）');
});

// ⭐ r9：匯入流程的 onPage 也必須吃換頁序號——接成重繪序號時密碼窗會**靜靜不開**（使用者上傳完什麼都沒發生）。
test('⭐ 接線｜匯入流程的 onPage 吃 currentNavSeq（接成 routeSeq 時密碼窗會靜靜不開）', () => {
  for (const rel of ['public/modules/cashflow.js', 'public/modules/transactions-import.js']) {
    const src = strip(readFileSync(join(ROOT, rel), 'utf8'));
    assert.match(src, /const seq0 = currentNavSeq\(\);/, `${rel}：onPage 的基準要用換頁序號`);
    assert.match(src, /const onPage = \(\) => seq0 === currentNavSeq\(\);/, `${rel}：onPage 比的要是換頁序號`);
    assert.doesNotMatch(src, /onPage = \(\) => seq0 === currentRouteSeq\(\)/, `${rel}：不可用重繪序號當 onPage`);
  }
});

// ⭐ r10（Codex Medium①）：本 PR 新增的「全部清除帳單密碼」也是「使用者還在這一頁嗎」的問題。
// 接成重繪序號時：開機背景重繪一發生，清除**會成功**但提前 return——沒有成功提示、也不重讀，
// 畫面還顯示舊組數與清除鈕（看起來像沒清掉）。這一題鎖住它。
test('⭐ 接線｜「清除記住的帳單密碼」吃 currentNavSeq（同頁重繪不可吃掉成功提示與重讀）', () => {
  const src = strip(readFileSync(join(ROOT, 'public/modules/settings.js'), 'utf8'));
  const m = /const btn = byId\('clearStmtPws'\);[\s\S]*?\n {4}\};/.exec(src);
  assert.ok(m, '找不到「清除記住的帳單密碼」的接線區塊（改寫時要同步這一題）');
  const block = m[0];
  assert.doesNotMatch(block, /currentRouteSeq\(\)/,
    '清除流程不可用重繪序號判「還在不在設定頁」——背景重繪會讓成功提示與重讀被吃掉');
  assert.equal((block.match(/currentNavSeq\(\)/g) || []).length, 3,
    '基準一處＋成功分支一處＋失敗分支一處，三處都要用換頁序號');
});

// ⭐ 關門題（r7 要求盤點／r8 只比總數不夠／r10 中央三窗沒逐一驗／r12 箭頭函式假綠）：
// 任何**開窗點**（把 modal-bg 外殼寫進 #modal-root）都必須在**那次寫入之前**先 claimModalRoot()。
// 四次修訂換來的掃法，三個要點都不可退回：
//   ①以**頂層大括號深度**切段——**刻意不辨識任何函式寫法**。r12 抓到：只認 `function` 宣告時，
//     在兩個開窗函式之間插一個沒 claim 的**箭頭函式**開窗，它會被算進上一個已 claim 的段落而假綠。
//     照深度切則 arrow／function／method 各自成段，claim 跨不過段界。
//   ②開窗記號認 `class="modal-bg"` 字串本身，不綁 `innerHTML =` 同一行（換行樣板也掃得到）。
//   ③六個開窗點**逐一點名**，新增開窗點沒進點名表就轉紅（r10：否則 openInfo 的 claim 被 openForm 代打）。
const OPENERS = [
  ['public/app.js', 'openForm'],
  ['public/app.js', 'openInfo'],
  ['public/modules/modal-shell.js', 'openModalShell'],
  ['public/modules/assets.js', 'openRebalance'],
  ['public/modules/assets.js', 'openTargets'],
  ['public/modules/settings-store-rules.js', 'openRulePreview'],
];

/**
 * 把**註解／字串／樣板／正則字面值**的內容換成空白，**保留換行**（行號不跑掉）。
 * 只為了兩件事可信：①數大括號時不被字面值裡的括號騙 ②`class="modal-bg"`／`claimModalRoot()`
 * 的比對不會命中註解裡的字。
 * ⚠️ 不共用檔案上方的 `strip()`：那一份會把區塊註解連換行一起吃掉（行號會漂），也不處理正則。
 * @param {string} src
 * @param {boolean} [keepStrings] true＝保留字串/樣板**內容**（找 `class="modal-bg"` 這種寫在樣板裡的記號用），
 *   註解與正則照樣清掉；false（預設）＝連字串內容一起清（數大括號與找 `claimModalRoot()` 用）。
 * @returns {string}
 */
function blankNonCode(src, keepStrings = false) {
  const keepNl = (/** @type {string} */ ch) => (ch === '\n' ? '\n' : ' ');
  let out = '', i = 0;
  const n = src.length;
  // 正則字面值的判定：`/` 前面最近的一個有意義字元決定它是除號還是正則開頭（標準啟發式）
  const regexOk = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k];
      if (c === ' ' || c === '\n' || c === '\t') continue;
      return '(,=:[!&|?{};+-*%~^'.includes(c);
    }
    return true;   // 檔案開頭
  };
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && c2 === '*') { out += '  '; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += keepNl(src[i]); i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      out += c; i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') { out += keepStrings ? src.slice(i, i + 2) : '  '; i += 2; continue; }
        out += keepStrings ? src[i] : keepNl(src[i]); i++;
      }
      if (i < n) { out += c; i++; }
      continue;
    }
    if (c === '/' && regexOk()) {
      out += '/'; i++;
      let inClass = false;
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { out += '  '; i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        out += ' '; i++;
      }
      if (i < n && src[i] === '/') { out += '/'; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/**
 * 依**頂層大括號深度**切段：深度回到 0 之後的下一個有內容的行＝下一段開始。
 * **刻意不辨識任何函式寫法**——arrow／function／method 都各自成段，claim 跨不過段界（r12 那一刀的解法）。
 * @param {string} src @returns {{name:string, from:number, to:number}[]}
 */
function topLevelSegments(src) {
  const raw = src.split('\n');
  const flat = blankNonCode(src).split('\n');
  /** @type {{name:string, from:number, to:number}[]} */ const segs = [];
  let depth = 0;
  flat.forEach((line, i) => {
    if (depth === 0 && line.trim() !== '') {
      const head = raw[i];
      const m = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(head)
        || /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)/.exec(head);
      segs.push({ name: m ? m[1] : `line${i + 1}`, from: i, to: raw.length });
    }
    for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  });
  // 大括號沒收平＝掃法被字面值/註解騙了：**大聲失敗**，不可以靜靜當成掃過了（靜靜通過最危險）
  assert.equal(depth, 0, '大括號深度沒有回到 0——blankNonCode 漏處理了某種字面值/註解，這道關門題已不可信');
  segs.forEach((sg, i) => { if (segs[i + 1]) sg.to = segs[i + 1].from; });
  return segs;
}

/**
 * 掃出每個「含開窗寫入」的段落，並判斷該段是否**在每次寫入之前**都已 claim。
 * @param {string} src @returns {{name:string, line:number, ok:boolean}[]}
 */
function scanOpeners(src) {
  const code = blankNonCode(src).split('\n');            // 清掉字串＝`claimModalRoot()` 不會命中註解/字串裡的字
  const marked = blankNonCode(src, true).split('\n');    // 留字串＝樣板裡的 `class="modal-bg"` 才看得到
  /** @type {{name:string, line:number, ok:boolean}[]} */ const found = [];
  for (const sg of topLevelSegments(src)) {
    let claimed = false, ok = true, writes = 0, firstWrite = -1;
    for (let i = sg.from; i < sg.to; i++) {
      if (/claimModalRoot\(\)/.test(code[i])) claimed = true;
      if (/class="modal-bg"/.test(marked[i])) {
        writes++; if (firstWrite < 0) firstWrite = i;
        if (!claimed) ok = false;
      }
    }
    if (writes) found.push({ name: sg.name, line: firstWrite + 1, ok });
  }
  return found;
}

// ⭐ r12：先驗**掃描器本身**擋不擋得住 Codex 那一刀（沒 claim 的頂層箭頭函式開窗）。
// 掃描器自己就是保證的承重點——它假綠的話，下面兩題再漂亮也守不到東西。
test('⭐ 關門題的掃描器自身：沒 claim 的箭頭函式開窗必須被抓出來（r12 那一刀）', () => {
  const claimedFn = `function openA() {\n  const root = byId('modal-root');\n  claimModalRoot();\n  root.innerHTML = \`<div class="modal-bg">A</div>\`;\n}\n`;
  const sneakyArrow = `const openSneaky = () => {\n  const root = byId('modal-root');\n  root.innerHTML = \`<div class="modal-bg">偷開的</div>\`;\n};\n`;
  const claimedArrow = `const openB = () => {\n  claimModalRoot();\n  byId('modal-root').innerHTML = \`<div class="modal-bg">B</div>\`;\n};\n`;

  const good = scanOpeners(claimedFn);
  assert.deepEqual(good.map(o => [o.name, o.ok]), [['openA', true]], '有 claim 的 function 開窗＝通過');

  // 這就是 r12 的突變：把箭頭函式塞在已 claim 的 function **後面**
  const mutated = scanOpeners(claimedFn + sneakyArrow);
  assert.equal(mutated.length, 2, '箭頭函式開窗要被當成獨立的開窗點（不可被前一段吸收）');
  assert.deepEqual(mutated.map(o => [o.name, o.ok]), [['openA', true], ['openSneaky', false]],
    '前一個函式的 claim 不可以跨段替箭頭函式背書');

  assert.deepEqual(scanOpeners(claimedArrow).map(o => o.ok), [true], '箭頭函式自己有 claim＝通過（不可假紅）');
  // 合法但順序刁鑽：先 claim 再宣告別名再寫入（r8 以別名切段的舊寫法會誤判成紅）
  const aliasAfterClaim = `function openC() {\n  claimModalRoot();\n  const root = byId('modal-root');\n  root.innerHTML = \`<div class="modal-bg">C</div>\`;\n}\n`;
  assert.deepEqual(scanOpeners(aliasAfterClaim).map(o => o.ok), [true], '先 claim 再宣告別名＝合法，不可假紅');
});

test('⭐ 接線｜六個開窗點**逐一**驗「先 claim 再寫入」（中央三窗不可被彼此代打）', () => {
  for (const [rel, fnName] of OPENERS) {
    const found = scanOpeners(readFileSync(join(ROOT, rel), 'utf8'));   // 傳原始碼：scanOpeners 自己有 blankNonCode（用 strip 會二次處理、行號還會漂）
    const hit = found.find(o => o.name === fnName);
    assert.ok(hit, `${rel}：掃不到開窗點 ${fnName}（改名或改寫法要同步點名表，否則這題會假綠）`);
    assert.ok(hit.ok, `${rel}:${fnName}（第 ${hit.line} 行）在寫入 #modal-root 之前沒有 claimModalRoot()`);
  }
});

/** 遞迴列出 public/ 底下所有 .js。 @param {string} dir @returns {string[]} */
function listJs(dir) {
  /** @type {string[]} */ const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('⭐ 接線｜全站掃描：任何新增的開窗點也要「先 claim 再寫入」，且要進點名表（防未來漏網）', () => {
  const roster = new Set(OPENERS.map(([rel, fn]) => `${rel}:${fn}`));
  let scanned = 0;
  for (const f of listJs(join(ROOT, 'public'))) {
    const rel = relative(ROOT, f).split('\\').join('/');
    for (const o of scanOpeners(readFileSync(f, 'utf8'))) {
      scanned++;
      assert.ok(o.ok, `${rel}:${o.name}（第 ${o.line} 行）在寫入 #modal-root 之前沒有 claimModalRoot()——手刻彈窗一律要先宣告接管`);
      assert.ok(roster.has(`${rel}:${o.name}`),
        `${rel}:${o.name} 是新的開窗點，請加進 OPENERS 點名表（逐一驗證那題才守得到它）`);
    }
  }
  assert.equal(scanned, OPENERS.length, `掃到的開窗點數應與點名表一致（實得 ${scanned}）`);
});
