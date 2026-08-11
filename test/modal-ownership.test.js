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

// ⭐ r9：換頁序號本身的定義題——只有 route 真的變了才前進，否則就退化成重繪序號、bug 原地復活。
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

// ⭐ 關門題（Codex r7 要求盤點／r8 指出只比總數不夠／r10 指出中央三窗沒逐一驗）：
// 任何**開窗點**（把 modal-bg 外殼寫進 #modal-root）都必須在**那次寫入之前**先 claimModalRoot()——
// 否則在途的 openForm(async) 回來時會誤判仍擁有、清掉這個後開的窗。
// 三次修訂換來的掃法：①逐**函式**切段（不是比整檔總數，也不是以別名宣告切段——別名重宣告會誤紅）
// ②開窗記號認 `class="modal-bg"` 這個字串本身（不綁 `innerHTML =` 同一行，換行樣板也掃得到）
// ③中央三窗與手刻三窗**逐一點名**驗證（r10：把 openInfo 的 claim 拿掉時，舊寫法會被 openForm 代打而假綠）。
const OPENERS = [
  ['public/app.js', 'openForm'],
  ['public/app.js', 'openInfo'],
  ['public/modules/modal-shell.js', 'openModalShell'],
  ['public/modules/assets.js', 'openRebalance'],
  ['public/modules/assets.js', 'openTargets'],
  ['public/modules/settings-store-rules.js', 'openRulePreview'],
];

/** 把原始碼切成「頂層函式」段：回傳 [{name, from, to}]（行號 0-based，to 不含）。 @param {string[]} lines */
function topLevelFns(lines) {
  /** @type {{name:string, from:number, to:number}[]} */ const fns = [];
  lines.forEach((line, i) => {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (m) fns.push({ name: m[1], from: i, to: lines.length });
  });
  fns.forEach((f, i) => { if (fns[i + 1]) f.to = fns[i + 1].from; });
  return fns;
}

/** 這個函式段裡，每個開窗寫入之前是否都已 claim。 @param {string[]} lines @param {{from:number,to:number}} fn */
function claimBeforeEveryWrite(lines, fn) {
  let claimed = false, writes = 0, ok = true;
  for (let i = fn.from; i < fn.to; i++) {
    if (/claimModalRoot\(\)/.test(lines[i])) claimed = true;
    if (/class="modal-bg"/.test(lines[i])) { writes++; if (!claimed) ok = false; }
  }
  return { ok, writes };
}

test('⭐ 接線｜六個開窗點**逐一**驗「先 claim 再寫入」（中央三窗不可被彼此代打）', () => {
  for (const [rel, fnName] of OPENERS) {
    const lines = strip(readFileSync(join(ROOT, rel), 'utf8')).split('\n');
    const fn = topLevelFns(lines).find(f => f.name === fnName);
    assert.ok(fn, `${rel}：找不到開窗函式 ${fnName}（改名要同步這張點名表）`);
    const { ok, writes } = claimBeforeEveryWrite(lines, fn);
    assert.ok(writes >= 1, `${rel}:${fnName} 掃不到開窗寫入（modal-bg）——掃法或函式已變，考題會假綠`);
    assert.ok(ok, `${rel}:${fnName} 在寫入 #modal-root 之前沒有 claimModalRoot()`);
  }
});

test('⭐ 接線｜全站掃描：任何新增的開窗點也要「先 claim 再寫入」（防未來漏網）', () => {
  const known = new Set(OPENERS.map(([rel, fn]) => `${rel}:${fn}`));
  let scanned = 0;
  for (const f of listJs(join(ROOT, 'public'))) {
    const rel = relative(ROOT, f).split('\\').join('/');
    const lines = strip(readFileSync(f, 'utf8')).split('\n');
    if (!lines.some(l => /class="modal-bg"/.test(l))) continue;
    for (const fn of topLevelFns(lines)) {
      const { ok, writes } = claimBeforeEveryWrite(lines, fn);
      if (!writes) continue;
      scanned++;
      assert.ok(ok, `${rel}:${fn.name} 在寫入 #modal-root 之前沒有 claimModalRoot()——手刻彈窗一律要先宣告接管`);
      assert.ok(known.has(`${rel}:${fn.name}`),
        `${rel}:${fn.name} 是新的開窗點，請加進 OPENERS 點名表（逐一驗證那題才守得到它）`);
    }
  }
  assert.equal(scanned, OPENERS.length, `掃到的開窗函式數應與點名表一致（實得 ${scanned}）`);
});
