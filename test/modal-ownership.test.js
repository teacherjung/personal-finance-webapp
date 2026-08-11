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
test('⭐ 接線｜navSeq 只在 route 真的改變時才前進（同頁重繪不動它）', () => {
  const app = strip(readFileSync(join(ROOT, 'public/app.js'), 'utf8'));
  assert.match(app, /export const currentNavSeq = \(\) => navSeq;/, 'currentNavSeq 存在且回傳換頁序號');
  assert.match(app, /if \(route !== lastRoute\) \{ lastRoute = route; navSeq\+\+; \}/,
    'router() 必須先算出 route、只有跟上次不同才前進 navSeq（同頁重繪不可動它）');
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

// ⭐ 關門題（Codex r7 要求盤點、r8 指出只比總數不夠）：任何**直接**把 modal-bg 外殼寫進 #modal-root 的
// 開窗點，都必須在**那次寫入之前**先 claimModalRoot()——否則在途的 openForm(async) 回來時會誤判仍擁有、
// 清掉這個後開的窗。改成「逐個開窗點驗 claim 在寫入之前」，而不是比整檔總數：
// 總數比法會被「A 少一個 claim、B 多一個 claim」對消掉（r8 點名的漏洞）。
// 作法：先找出 #modal-root 的別名宣告（const root = byId('modal-root')），以宣告點切段，
// 要求每個寫入點與它所屬宣告之間，文字上出現過一次 claimModalRoot()。
test('⭐ 接線｜每個手刻開窗點都要「先 claim 再寫入」#modal-root（关门·防未來漏網）', () => {
  const CENTRAL = new Set(['public/app.js', 'public/modules/modal-shell.js']);   // 中央外殼＝claim 的實作本體
  let checked = 0;
  for (const f of listJs(join(ROOT, 'public'))) {
    const rel = relative(ROOT, f).split('\\').join('/');
    if (CENTRAL.has(rel)) continue;
    const src = strip(readFileSync(f, 'utf8'));
    const lines = src.split('\n');
    // 每個 modal-root 別名宣告開一個新段；段內出現 claim 就記下，遇到開窗寫入時必須已經記過。
    let claimedInSection = false;
    lines.forEach((line, i) => {
      if (/=\s*(byId\('modal-root'\)|\$\('#modal-root'\)|document\.getElementById\('modal-root'\))/.test(line)) {
        claimedInSection = false;   // 新的一段（通常＝新的一個開窗函式）
      }
      if (/claimModalRoot\(\)/.test(line)) claimedInSection = true;
      if (/innerHTML\s*=\s*`<div class="modal-bg"/.test(line)) {
        assert.ok(claimedInSection,
          `${rel}:${i + 1} 在寫入 #modal-root 之前沒有 claimModalRoot()——手刻彈窗一律要先宣告接管`);
        checked++;
      }
    });
  }
  assert.ok(checked >= 3, `應至少盤到 assets(×2)＋settings-store-rules(×1)＝3 個手刻開窗點，實得 ${checked}`);
});
