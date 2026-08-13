// @ts-check
// P1b-3 攔截率實測：AI 讀錯帳單時，對帳閘攔得住哪幾種、攔不住哪幾種——用**數字**回答。
//
// ⚠️ **這份量的是「閘」的性質，不是「AI」的性質**（整份的誠實劃界，讀數字前先讀這段）：
//   ・做法＝**故障注入**：拿一份正確的合成帳單，照「AI 會怎麼讀錯」逐型注入錯誤，看閘攔不攔得住。
//   ・得到的是**條件攔截率**——「**如果** AI 犯了 X 型錯，會不會被擋下」。
//   ・**不是**「AI 多常犯錯」。那要真 AI ＋ 有標準答案的語料，不在這一支（見 §八）。
//   ・為什麼不打真 AI 量：①不可重現（同一份帳單兩次可能不同答案，票制存在的理由就是這個）
//     ②要花使用者的錢 ③跑得動的份數小到沒有統計意義。故障注入零成本、可重現，而且可以**逐型**測。
//     ⚠️ 但**列不完**：審查者兩輪各找出四型與兩型我沒想到的——所以本份**不宣稱窮盡**，
//     畫面與計畫也一律改口（第一版寫「看不到的四件事」，那句話是假的）。
//
// 判定用的是**AI 路線**的放行條件（★6，比模板嚴）：`ok && level==='strong' && twdAccountsUnverified===0`。
// 不滿足＝擋下（使用者看得到、匯不進去）＝**攔截成功**。
//
// 這份考題的形狀：每個情境自己寫死 `expect`（caught／missed）與**為什麼**。實測與期望逐格比對——
//   ・閘被改壞 ⇒ 某格從 caught 變 missed ⇒ 紅。
//   ・閘被改好 ⇒ 某格從 missed 變 caught ⇒ **也紅**（提醒：文件與數字要一起更新，別讓 §八 過期）。
// 這是刻意的：**攔截率一旦寫進文件就是對使用者的承諾**，不可以自己悄悄漂。
//
// 假資料鐵則（收支契約）：帳號一律明顯假值（900100****3301 系），絕不複製真帳單遮罩末碼。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { reconcileBankStatement } = await import('../lib/statement-reconcile.js');
const { aiPreviewBadgeHtml } = await import('../public/modules/ai-consent.js');

// ---------- 合成語料 ----------

/** @param {Partial<import('../lib/bank-statement.js').BankTx>} o */
const tx = (o) => ({ acctSuffix: '3301', acctMasked: '900100****3301', date: '2026-07-01', summary: '轉帳存入',
  direction: /** @type {'in'|'out'} */ ('in'), amount: 100, balance: null, note: '', ...o });

/** 單一台幣帳戶、每筆都有餘額、概要也印了期末餘額＝閘火力全開的形狀。 */
function corpusFull() {
  return {
    bank: '合成一銀', referenceDate: '2026-07-31',
    accounts: [{ suffix: '3301', masked: '900100****3301', balance: 1300, currency: 'TWD', label: '活存', note: '' }],
    accountCurrency: { '900100****3301': 'TWD' },
    transactions: [
      tx({ date: '2026-07-01', summary: '薪資轉入', direction: 'in', amount: 1000, balance: 1000 }),
      tx({ date: '2026-07-05', summary: '提款', direction: 'out', amount: 200, balance: 800 }),
      tx({ date: '2026-07-12', summary: '轉帳存入', direction: 'in', amount: 700, balance: 1500 }),
      tx({ date: '2026-07-20', summary: '繳費', direction: 'out', amount: 200, balance: 1300 }),
    ],
  };
}

/** 台幣＋外幣混合：外幣列整組不入帳、也不驗（P0.1 的刻意設計）。 */
function corpusForeign() {
  const p = corpusFull();
  p.accounts.push({ suffix: '363', masked: '900100****363', balance: 50, currency: 'USD', label: '外幣', note: '' });
  /** @type {any} */ (p.accountCurrency)['900100****363'] = 'USD';
  p.transactions.push(
    tx({ acctSuffix: '363', acctMasked: '900100****363', date: '2026-07-08', summary: '外幣利息', direction: 'in', amount: 30, balance: 30 }),
    tx({ acctSuffix: '363', acctMasked: '900100****363', date: '2026-07-18', summary: '外幣存入', direction: 'in', amount: 20, balance: 50 }),
  );
  return p;
}

/** 兩個台幣帳戶，其中 B 的餘額欄全空＝B 一道擋下型都吃不到（搭便車的形狀）。 */
function corpusFreeRider() {
  const p = corpusFull();
  p.accounts.push({ suffix: '3302', masked: '900100****3302', balance: 500, currency: 'TWD', label: '活存B', note: '' });
  /** @type {any} */ (p.accountCurrency)['900100****3302'] = 'TWD';
  p.transactions.push(
    tx({ acctSuffix: '3302', acctMasked: '900100****3302', date: '2026-07-09', summary: '轉入', direction: 'in', amount: 500, balance: null }),
  );
  return p;
}

/** 兩個台幣帳戶、**兩邊都有完整餘額鏈**＝乾淨基準（注入前必須放行，才證明得了「是注入造成攔截」）。 */
function corpusTwoAccounts() {
  const p = corpusFull();
  p.accounts.push({ suffix: '3302', masked: '900100****3302', balance: 700, currency: 'TWD', label: '活存B', note: '' });
  /** @type {any} */ (p.accountCurrency)['900100****3302'] = 'TWD';
  p.transactions.push(
    tx({ acctSuffix: '3302', acctMasked: '900100****3302', date: '2026-07-03', summary: '轉入', direction: 'in', amount: 500, balance: 500 }),
    tx({ acctSuffix: '3302', acctMasked: '900100****3302', date: '2026-07-15', summary: '轉入', direction: 'in', amount: 200, balance: 700 }),
  );
  return p;
}

/** 概要有、明細一筆都沒有的帳戶（本期無往來）：餘額會照帳單更新，但沒有明細可驗。 */
function corpusIdleAccount() {
  const p = corpusFull();
  p.accounts.push({ suffix: '3303', masked: '900100****3303', balance: 9000, currency: 'TWD', label: '定存', note: '' });
  /** @type {any} */ (p.accountCurrency)['900100****3303'] = 'TWD';
  return p;
}

// ---------- 判定 ----------

/** AI 路線的放行條件（★6）。回 true＝這份帳單**匯得進去**。 @param {any} parsed */
function aiWouldPass(parsed) {
  const v = reconcileBankStatement(parsed);
  return v.ok && v.level === 'strong' && v.stats.twdAccountsUnverified === 0;
}

// ---------- 錯誤型錄 ----------
// 每一型都是「AI 讀帳單時真的會犯」的錯：抄錯一位數、看錯正負、跳過一行、把兩行併一行…
// `expect` 是這一支的**承諾**：caught＝使用者匯不進去、會看到擋下訊息；missed＝閘看不到。

/** @type {{id:string, 類:'A'|'B'|'C'|'D', base:() => any, name:string, why:string, expect:'caught'|'missed',
 *          badge?:string, proves:(built:any, base:any) => void, build:() => any}[]}
 * `badge`＝這一型在**預覽窗徽章**上的那句話（B 類必填）：考題拿它去徽章裡找，
 * 找不到＝我們知道它攔不到、卻沒告訴使用者。
 * `proves`＝**證明注入的是題名說的那個故障**（r10#1）：只比對「build 與 base 不一樣」不夠——
 * 把某型改成只動一個無關的摘要錯字，它照樣是 missed、考題全綠＝那一型根本沒在測它宣稱的東西。
 * 所以每型自己斷言「目標欄位真的變了」＋「關鍵旁支沒變」。 */
const CASES = [
  // ── A 類：會讓**匯入的帳本內容**出錯（金額／方向／帳戶歸屬／筆數／去重鍵），
  //    而且**造成前後不一致** ⇒ 目標全數攔下 ──
  // ⚠️ 定義原本寫「入帳金額出錯」＝**過窄**（r9#2）：A6 只改明細餘額、A7 只改帳戶歸屬，
  //    兩者的 amount 都沒變，但它們一樣把帳本弄錯（歸錯戶、去重鍵變了＝下次重匯會多算一份）。
  //    收寬定義比硬把它們算成「金額出錯」誠實。
  { id: 'A1', 類: 'A', base: corpusFull, name: '單筆金額抄錯（200 讀成 700）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions[1].amount, 700); assert.equal(a.transactions[1].amount, 200); assert.equal(b.transactions[1].balance, a.transactions[1].balance); },
    why: '金額變了、餘額沒變 ⇒ 逐筆餘額鏈當場接不上',
    build: () => { const p = corpusFull(); p.transactions[1].amount = 700; return p; } },

  { id: 'A2', 類: 'A', base: corpusFull, name: '金額差一個數量級（700 讀成 7000）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions[2].amount, 7000); assert.equal(a.transactions[2].amount, 700); assert.equal(b.transactions[2].balance, a.transactions[2].balance); },
    why: '同上，差額巨大、鏈必斷',
    build: () => { const p = corpusFull(); p.transactions[2].amount = 7000; return p; } },

  { id: 'A3', 類: 'A', base: corpusFull, name: '方向看反（存入讀成支出）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions[2].direction, 'out'); assert.equal(a.transactions[2].direction, 'in'); assert.equal(b.transactions[2].amount, a.transactions[2].amount); assert.deepEqual(b.transactions.map((/** @type {any} */ t) => t.balance), a.transactions.map((/** @type {any} */ t) => t.balance)); },
    why: '方向反了、餘額不動 ⇒ 差兩倍金額，鏈接不上',
    build: () => { const p = corpusFull(); p.transactions[2].direction = 'out'; return p; } },

  { id: 'A4', 類: 'A', base: corpusFull, name: '漏讀一整筆（跳過一行）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions.length, a.transactions.length - 1); assert.equal(b.transactions[2].date, a.transactions[3].date); },
    why: '前後兩筆的餘額之間多出一段沒有交易解釋 ⇒ 鏈斷',
    build: () => { const p = corpusFull(); p.transactions.splice(2, 1); return p; } },

  { id: 'A5', 類: 'A', base: corpusFull, name: '同一筆讀成兩筆（重複一行）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions.length, a.transactions.length + 1); assert.deepEqual(b.transactions[2], b.transactions[3]); },
    why: '多出來那筆的餘額與前一筆相同 ⇒ 對不上金額',
    build: () => { const p = corpusFull(); p.transactions.splice(2, 0, { ...p.transactions[2] }); return p; } },

  { id: 'A6', 類: 'A', base: corpusFull, name: '餘額欄抄錯（金額對、餘額錯）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions[2].balance, 1400); assert.notEqual(a.transactions[2].balance, 1400); assert.equal(b.transactions[2].amount, a.transactions[2].amount); },
    why: '鏈的兩端都在驗，改單邊必斷',
    build: () => { const p = corpusFull(); p.transactions[2].balance = 1400; return p; } },

  { id: 'A7', 類: 'A', base: corpusTwoAccounts, name: '把 A 帳戶的一列掛到 B 帳戶（末碼讀錯）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions[1].acctSuffix, '3302'); assert.equal(a.transactions[1].acctSuffix, '3301'); assert.equal(b.transactions[1].amount, a.transactions[1].amount); },
    why: '兩邊的鏈同時被破壞。⚠️ 基準用**兩邊都驗得動**的 corpusTwoAccounts——'
      + '建在「本來就會被拒收」的基準上＝二元判定證明不了是注入造成的攔截（r1#2 抓到的假陽性）',
    build: () => { const p = corpusTwoAccounts(); p.transactions[1].acctMasked = '900100****3302'; p.transactions[1].acctSuffix = '3302'; return p; } },

  { id: 'A8', 類: 'A', base: corpusFull, name: '期末餘額與概要對不上（漏讀期末幾筆）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions.length, a.transactions.length - 1); assert.equal(b.transactions.at(-1).date, a.transactions.at(-2).date); },
    why: '末筆餘額與概要區印的帳戶餘額互扣 ⇒ 對不上',
    build: () => { const p = corpusFull(); p.transactions.pop(); return p; } },

  { id: 'A9', 類: 'A', base: corpusFull, name: '整份只讀出一筆（其餘全漏）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions.length, 1); assert.ok(a.transactions.length > 1); },
    why: '只有一筆＝沒有相鄰兩筆可比，但末筆仍要對概要 ⇒ 對不上',
    build: () => { const p = corpusFull(); p.transactions = [p.transactions[0]]; return p; } },

  // ── D 類：金額全對，但**驗算根本蓋不到那個帳戶** ⇒ ★6 保守拒收 ──
  // ⚠️ 它**不屬於 A 類**（r3#2 指正）：A 類的承諾是「造成不一致的錯會被擋」，而這一型
  //    一個數字都沒錯、`problems` 是空的——擋它的是**覆蓋政策**，不是偵測到不一致。
  //    混進 A 類＝用不相干的樣本把 10/10 撐高。
  { id: 'D1', 類: 'D', base: corpusTwoAccounts, name: '某個台幣帳戶的餘額欄全空（該帳戶零驗證）', expect: 'caught',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.ok(b.transactions.filter((/** @type {any} */ t) => t.acctSuffix === '3302').every((/** @type {any} */ t) => t.balance === null)); assert.ok(a.transactions.filter((/** @type {any} */ t) => t.acctSuffix === '3302').every((/** @type {any} */ t) => t.balance !== null)); },
    why: '★6 逐帳戶覆蓋：有任何一個受驗帳戶一道擋下型都沒吃到就拒收（level 是全檔旗標、擋不住搭便車）。'
      + '⚠️ 基準用**乾淨的雙帳戶**、只把其中一戶的餘額清空——直接拿 corpusFreeRider 當 build 的話，'
      + 'base 與 build 相同＝證明不了是「注入」造成的（r9#1）',
    build: () => { const p = corpusTwoAccounts();
      for (const t of p.transactions) if (t.acctSuffix === '3302') t.balance = null;
      return p; } },

  // ── B 類：會讓**匯入的帳本內容**出錯（金額／方向／歸屬／筆數），但**閘看不到** ──
  //    （已知盲點，畫面上逐條寫給使用者看）
  // ⚠️ 定義與 A 類同步收寬（r10#3）：B10 只改方向、B7/B9 只改幣別歸屬，都不是「金額出錯」，
  //    但一樣把帳本弄錯——寫「入帳金額出錯」會讓這幾型看起來不屬於這一類。
  { id: 'B1', 類: 'B', base: corpusFull, name: '金額與餘額**一起**被改成自洽的另一組數字', expect: 'missed', badge: '自洽',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.notEqual(b.transactions[1].amount, a.transactions[1].amount); assert.notEqual(b.transactions[1].balance, a.transactions[1].balance); assert.notEqual(b.accounts[0].balance, a.accounts[0].balance); },
    why: '盲點④：數學是平的，驗算看不出來——只能靠使用者自己看一眼',
    build: () => { const p = corpusFull(); p.transactions[1].amount = 300; p.transactions[1].balance = 700;
      p.transactions[2].balance = 1400; p.transactions[3].balance = 1200;
      /** @type {any} */ (p.accounts[0]).balance = 1200; return p; } },

  { id: 'B2', 類: 'B', base: corpusFull, name: '每個帳戶的**第一筆**金額或方向讀錯', expect: 'missed', badge: '第一筆',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.notEqual(b.transactions[0].amount, a.transactions[0].amount); assert.equal(b.transactions[0].direction, a.transactions[0].direction); assert.equal(b.transactions[0].balance, a.transactions[0].balance); },
    why: '盲點①：首筆沒有前一筆可比——鏈是拿它的**餘額**去比下一筆，它的**金額**沒有任何檢查用到，'
      + '所以只改金額、其餘一個字不動，整份仍完全自洽（連概要都對得上），錢卻已經記錯了',
    build: () => { const p = corpusFull(); p.transactions[0].amount = 900; return p; } },

  { id: 'B3', 類: 'B', base: corpusIdleAccount, name: '本期無往來帳戶的概要餘額讀錯', expect: 'missed', badge: '沒有往來',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.notEqual(b.accounts[1].balance, a.accounts[1].balance); assert.equal(b.transactions.length, a.transactions.length); },
    why: '盲點③：明細一筆都沒有＝沒有任何數字可以驗它，但那個餘額仍會被寫進帳戶',
    build: () => { const p = corpusIdleAccount(); /** @type {any} */ (p.accounts[1]).balance = 8000; return p; } },

  // ⚠️ 以下四型是**審查者（Codex r1）用唯讀探針找出來的**，我原本的型錄漏了它們——
  //    也就是說「這道驗算看不到的四件事」那句話**是假的**。清單補不完，所以改口：不再宣稱窮盡。
  { id: 'B4', 類: 'B', base: corpusFull, name: '某筆金額讀錯、而且**同一筆的餘額讀成空白**', expect: 'missed', badge: '餘額是空白',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.notEqual(b.transactions[1].amount, a.transactions[1].amount); assert.equal(b.transactions[1].balance, null); assert.notEqual(a.transactions[1].balance, null); },
    why: '盲點⑤：餘額空白的那一對會被跳過，但該帳戶還有別對在驗 ⇒ 仍算「有驗到」，逐帳戶覆蓋不會紅',
    build: () => { const p = corpusFull(); p.transactions[1].amount = 700; p.transactions[1].balance = null; return p; } },

  { id: 'B5', 類: 'B', base: corpusFull, name: '一筆支出與一筆收入被**併成一筆淨額**', expect: 'missed', badge: '併成一筆淨額',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions.length, a.transactions.length - 1); assert.equal(b.transactions[1].amount, 500); assert.equal(b.transactions[1].direction, 'in'); },
    why: '盲點⑥：淨額一樣 ⇒ 餘額鏈完全接得上、期末也對，但**收入與支出兩邊的總額都錯了**（最陰險的一型）',
    build: () => { const p = corpusFull();
      p.transactions.splice(1, 2, tx({ date: '2026-07-05', summary: '淨額', direction: 'in', amount: 500, balance: 1500 }));
      return p; } },

  { id: 'B6', 類: 'B', base: corpusTwoAccounts, name: '整個帳戶被漏讀（概要與明細都沒讀到）', expect: 'missed', badge: '整個帳戶被漏讀',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.accounts.length, a.accounts.length - 1); assert.equal(b.transactions.filter((/** @type {any} */ t) => t.acctSuffix === '3302').length, 0); assert.ok(a.transactions.some((/** @type {any} */ t) => t.acctSuffix === '3302')); },
    why: '盲點⑦：沒讀到的東西沒有任何數字可以驗——剩下的部分自己是自洽的',
    build: () => { const p = corpusTwoAccounts(); p.accounts.pop();
      p.transactions = p.transactions.filter((/** @type {any} */ t) => t.acctSuffix !== '3302'); return p; } },

  { id: 'B7', 類: 'B', base: corpusTwoAccounts, name: '台幣帳戶被誤判成**外幣**', expect: 'missed', badge: '認成外幣',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.accounts[1].currency, 'USD'); assert.equal(a.accounts[1].currency, 'TWD'); },
    why: '盲點⑧：閘整組跳過不驗，而且匯入層也會排除 ⇒ 那個帳戶的交易**一筆都不會進帳**，畫面卻說驗算通過',
    build: () => { const p = corpusTwoAccounts(); /** @type {any} */ (p.accounts[1]).currency = 'USD';
      /** @type {any} */ (p.accountCurrency)['900100****3302'] = 'USD'; return p; } },

  { id: 'B10', 類: 'B', base: corpusFull, name: '首筆的**方向**讀反（收入讀成支出）', expect: 'missed', badge: '金額與方向',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions[0].direction, 'out'); assert.equal(a.transactions[0].direction, 'in'); assert.equal(b.transactions[0].amount, a.transactions[0].amount); assert.deepEqual(b.transactions.map((/** @type {any} */ t) => t.balance), a.transactions.map((/** @type {any} */ t) => t.balance)); assert.deepEqual(b.accounts, a.accounts); },
    why: '盲點①的第三種形狀，也是**後果最直接**的一種：首筆的方向同樣沒有任何檢查用到'
      + '（鏈只拿它的餘額比下一筆）⇒ 整份仍完全自洽，但那筆收入會被記成支出，**月收入與月支出同時失真**。'
      + '⚠️ main 的徽章本來就寫「金額與方向」，是我 2026-08-13 重寫那條時弄丟了「方向」（r5 抓到的回歸）',
    build: () => { const p = corpusFull(); p.transactions[0].direction = 'out'; return p; } },

  // 審查者 r2 又找到的兩型：都掛在既有編號底下（畫面不新增條目，只把 ①⑧ 的說法擴寫）
  { id: 'B8', 類: 'B', base: corpusFull, name: '**整筆漏掉**每個帳戶的第一筆', expect: 'missed', badge: '整筆漏掉',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions.length, a.transactions.length - 1); assert.equal(b.transactions[0].summary, a.transactions[1].summary); },
    why: '盲點①的另一種形狀：首筆整個不見，後面的鏈與期末仍然對得上',
    build: () => { const p = corpusFull(); const [, ...rest] = p.transactions; p.transactions = rest; return p; } },

  { id: 'B9', 類: 'B', base: corpusForeign, name: '外幣帳戶被誤判成**台幣**', expect: 'missed', badge: '外幣數字被當成台幣',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.accounts[1].currency, 'TWD'); assert.equal(a.accounts[1].currency, 'USD'); assert.equal(b.accountCurrency['900100****363'], 'TWD'); assert.equal(a.accountCurrency['900100****363'], 'USD'); assert.deepEqual(b.transactions.map((/** @type {any} */ t) => t.amount), a.transactions.map((/** @type {any} */ t) => t.amount)); },
    why: '盲點⑧的反方向：外幣的數字會被當台幣入帳（比誤判成外幣更糟——那只是不進帳，這是進錯帳）',
    build: () => { const p = corpusForeign();
      /** @type {any} */ (p.accounts[1]).currency = 'TWD'; /** @type {any} */ (p.accountCurrency)['900100****363'] = 'TWD';
      p.transactions[4].balance = 30; p.transactions[5].balance = 50; return p; } },

  // ── C 類：不動到金額（閘本來就不管，靠學習表與人工改） ──
  { id: 'C0', 類: 'C', base: corpusForeign, name: '外幣明細的金額讀錯', expect: 'missed',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.equal(b.transactions[5].amount, 999); assert.notEqual(a.transactions[5].amount, 999); assert.equal(b.transactions[5].acctSuffix, '363'); },
    why: '外幣列整組不驗（盲點②），但**也不會匯入**＝帳本金額不受影響。'
      + '⚠️ 原本被我歸成 B 類「會讓入帳金額出錯」＝說法過重（r1#2 指正）：錯的是畫面上看到的那個數字，不是帳',
    build: () => { const p = corpusForeign(); p.transactions[5].amount = 999; return p; } },

  { id: 'C1', 類: 'C', base: corpusFull, name: '摘要抄錯字（金額全對）', expect: 'missed',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.notEqual(b.transactions[1].summary, a.transactions[1].summary); assert.equal(b.transactions[1].amount, a.transactions[1].amount); assert.equal(b.transactions[1].balance, a.transactions[1].balance); },
    why: '不影響任何數字；分類可能跑掉，但錢是對的——匯入後在收支列表逐筆改',
    build: () => { const p = corpusFull(); p.transactions[1].summary = '提欵'; return p; } },

  { id: 'C2', 類: 'C', base: corpusFull, name: '日期讀錯（金額與餘額全對）', expect: 'missed',
    proves: (/** @type {any} */ b, /** @type {any} */ a) => { assert.notEqual(b.transactions[1].date, a.transactions[1].date); assert.equal(b.transactions[1].date.slice(0, 7), a.transactions[1].date.slice(0, 7)); assert.equal(b.transactions[1].amount, a.transactions[1].amount); assert.equal(b.transactions[1].balance, a.transactions[1].balance); },
    why: '閘驗的是餘額鏈的順序關係，不是日期本身。⚠️ 本例注入的是**同月內**改日期（07-05→07-06）：'
      + '跨月會讓那筆記到別的月份、月報表就錯了，但那不是這道驗算看得到的事——兩種都漏接',
    build: () => { const p = corpusFull(); p.transactions[1].date = '2026-07-06'; return p; } },
];

// ---------- 實測 ----------

test('P1b-3 攔截率｜前置：正確的合成帳單**每一種**形狀都要能通過（不然攔截率是被誤擋撐出來的）', () => {
  for (const [name, p] of /** @type {[string, any][]} */ ([
    ['單帳戶完整', corpusFull()], ['台幣＋外幣', corpusForeign()], ['含無往來帳戶', corpusIdleAccount()],
    ['雙台幣帳戶（A7／B6／B7 的基準）', corpusTwoAccounts()],   // ★漏驗它＝A7 可能又被髒基準的假陽性撐住（r2#1）
  ])) {
    assert.equal(aiWouldPass(p), true, `★${name}：沒有注入錯誤就該放行——會誤擋的閘算出來的攔截率沒有意義`);
  }
  // 搭便車形狀**本來就該被拒**（D1 就是在講這件事），所以不列進「前置要通過」的名單。
  assert.equal(aiWouldPass(corpusFreeRider()), false, '搭便車形狀＝★6 逐帳戶覆蓋要拒收');
});

test('P1b-3 攔截率｜逐型故障注入：先證明故障真的注入了，再比對結果', () => {
  // ⚠️ **只比對 caught／missed 是假綠**（r9#1，AGENTS「必須明確證明受測操作確實執行」）：
  //    把任何一個 missed 型的 build 改成直接回傳乾淨基準，它照樣是 missed、型數與文件互扣全綠——
  //    等於那一型根本沒有在測任何東西。所以每一型都要先證明「它真的動了手腳」。
  /** @type {string[]} */ const notInjected = [];
  /** @type {string[]} */ const wrong = [];
  for (const c of CASES) {
    if (JSON.stringify(c.build()) === JSON.stringify(c.base())) notInjected.push(`${c.id}（${c.name}）：完全沒動`);
    // ★r10#1：光「有東西不一樣」證明不了「動的是題名說的那個」——把某型改成只動一個無關的
    //   摘要錯字，它照樣 missed、考題全綠。每型自己的 proves 才是真的在守它宣稱的東西。
    try { c.proves(c.build(), c.base()); }
    catch (e) { notInjected.push(`${c.id}（${c.name}）：動的不是題名說的那個 → ${/** @type {any} */ (e).message}`); }
    const actual = aiWouldPass(c.build()) ? 'missed' : 'caught';
    if (actual !== c.expect) wrong.push(`${c.id}（${c.name}）：期望 ${c.expect}、實測 ${actual}`);
  }
  assert.deepEqual(notInjected, [], '★這些型沒有真的注入它宣稱的那個故障——它們不是在測自己說的東西\n' + notInjected.join('\n'));
  assert.deepEqual(wrong, [],
    '★攔截率是寫進文件、對使用者的承諾——某格變了就要連文件一起更新，不可以自己悄悄漂\n' + wrong.join('\n'));
});

test('P1b-3 攔截率｜A 類必須是「偵測到不一致」才算數，D 類必須是「金額全對但蓋不到」', () => {
  // ⚠️ **只看「有沒有被擋下」不夠**（r4#2）：這一型（曾經編號 A10、現為 D1）金額全對、`problems` 空的，卻因為覆蓋政策被拒收，
  //    混在 A 類裡就把 10/10 撐高了。分類的**語意**要自己被鎖住，否則下一個人再把 D1 搬回 A 類，
  //    互扣只會跟著改數字、不會出聲。
  const a = CASES.filter((c) => c.類 === 'A');
  assert.ok(a.length >= 9, `A 類樣本要夠多才敢寫成承諾（現有 ${a.length} 型）`);
  for (const c of a) {
    const v = reconcileBankStatement(c.build());
    assert.ok(v.problems.length > 0,
      `★${c.id}（${c.name}）沒有產生任何 problem——它不是被「偵測到不一致」擋下的，不該算在 A 類`);
    assert.equal(aiWouldPass(c.build()), false, `★${c.id} 要真的匯不進去`);
  }
  // ★r5：**題名寫「方向」就要真的改方向**。把 B10 的 build 改成動金額，它照樣是 missed ⇒ 考題不會出聲，
  //   而「方向也驗不到」這件事就沒有任何東西在測（那正是 main 有、我改寫時弄丟的那一條）。
  const b10 = CASES.find((c) => c.id === 'B10');
  assert.ok(b10, 'B10（首筆方向讀反）要在型錄裡');
  const flipped = b10.build();
  assert.equal(flipped.transactions[0].direction, 'out',
    '★B10 必須真的把首筆**方向**改反——改金額就變成在測 B2，方向這件事等於沒測');
  assert.equal(flipped.transactions[0].amount, 1000,
    '★而且金額要維持正確：兩個都動就分不出是哪一個造成漏接');

  const d = CASES.filter((c) => c.類 === 'D');
  assert.equal(d.length, 1, 'D 類目前只有一型（覆蓋政策）；變了要同步改 §八');
  for (const c of d) {
    const v = reconcileBankStatement(c.build());
    assert.deepEqual(v.problems, [], `★${c.id} 沒有任何 problem（有 problem 就該歸 A 類）`);
    // ⚠️ 不可用「沒有 problem」推論「金額全對」（r9#1）：首筆金額改錯照樣沒有 problem。
    //    直接跟基準逐筆比金額與方向。
    const built = c.build(), base = c.base();
    assert.deepEqual(built.transactions.map((/** @type {any} */ t) => [t.amount, t.direction]),
      base.transactions.map((/** @type {any} */ t) => [t.amount, t.direction]),
      `★${c.id} 的每一筆金額與方向都必須與基準相同——D 類的定義就是「金額全對、只是驗算蓋不到」`);
    assert.equal(v.ok, true, `★${c.id} 本身是「通過」的`);
    assert.equal(v.level, 'strong', `★${c.id} 的 level 也是 strong——擋它的不是級別`);
    assert.ok(v.stats.twdAccountsUnverified > 0, `★${c.id} 必須是由**逐帳戶覆蓋**拒收（★6），不是別的機制`);
    assert.equal(aiWouldPass(c.build()), false, `★${c.id} 最後仍要匯不進去`);
  }
});

test('P1b-3 攔截率｜每一個盲點都要真的出現在畫面上，而且不可寫死件數', () => {
  // ⚠️ 上一版只驗「沒寫死件數＋有講不完整」＝**假綠**：審查者把 B4–B7 從徽章整段刪掉，
  //    所有斷言照樣過（使用者的警語被刪掉會過關＝真回歸）。改成**逐型核對**：
  //    每一型自己帶一句 `badge`，那句話必須真的在徽章裡找得到。
  const b = CASES.filter((c) => c.類 === 'B');
  assert.ok(b.length >= 10, `盲點至少要收錄目前已知的十型（現有 ${b.length}）`);
  const raw = aiPreviewBadgeHtml({ engine: 'ai', aiModel: 'claude-haiku-4-5-20251001' });
  // ⚠️⚠️ **這一題守什麼、刻意不守什麼**（William 2026-08-13 裁示）：
  //
  //   **守**＝這十型盲點的文字**真的在徽章的輸出裡**（逐型比對，刪掉任一條就紅）。
  //   這防的是**真實會發生的失誤**：改文案時順手弄丟一句。本支就發生過——我重寫這段時
  //   把「方向」兩個字弄丟了，於是「首筆方向讀反＝收入被記成支出」在畫面上消失，
  //   三關全綠、我完全沒察覺（複審比對 main 才抓到）。這一類意外還會再發生，所以要守。
  //
  //   **刻意不守**＝「它不會被藏起來」（`opacity:0`／`<template>`／`display:none`…）。
  //   理由不是做不到（雖然從 Node 也確實做不到——那要真的渲染），而是**那不是真實的失誤模式**：
  //   沒有人會不小心寫出 `opacity:0`。我為了防它燒掉四輪覆審、被打穿四次
  //   （`<template>`／`opacity:0`／單引號 `style='…'`／`font-size:calc(0px)`），投入沒有上限、
  //   回報趨近於零。⚠️ **對抗式的藏匿不在本考題射程內**，這句話要明寫，不要讓後人以為守到了。
  //
  //   一次性的人工證據（2026-08-13）：在真的瀏覽器裡渲染徽章、展開收合區，量到那條盲點 li
  //   為 922×137px、`visibility:visible`、`opacity:1`、`font-size:12px`、①～⑧ 齊全。
  //   那是**當下的證據，不是持續的保證**。
  const badge = raw;
  const missing = b.filter((c) => !c.badge || !badge.includes(c.badge));
  assert.deepEqual(missing.map((c) => c.id), [],
    '★這些盲點在畫面上找不到——考題知道它們攔不到，卻沒告訴使用者');
  // ⚠️ **`includes` 只是必要條件**（r11#2 實測）：核准句可以當成更長錯句的**前綴**——
  //   「這道驗算看不到的（不只這些）**都列完了**」「這份清單不保證完整，**其實已經完整**」
  //   兩句互相矛盾，includes 照樣通過。所以改成**整條 <li> 逐字相等**：
  //   想改那段文案，就得連這個常數一起改——改的人自然會讀到這段說明。
  //   ⚠️ 代價：任何文字微調都會讓這題紅。那是刻意的（這段是對使用者的誠實揭露，
  //   不該有人順手改掉而沒人看見），不是誤紅。
  const APPROVED_BLIND_SPOTS = "⚠️ <b>這道驗算看不到的（不只這些）</b>：①每個帳戶的<b>第一筆</b>——驗算是拿它的<b>餘額</b>去比下一筆，它的<b>金額與方向</b>都沒有被驗到（方向讀反＝<b>收入被記成支出</b>，月收支同時失真）；<b>整筆漏掉也一樣</b>（後面的鏈與期末仍然對得上）②<b>外幣</b>明細（本來就不計入台幣收支；外幣帳戶餘額仍會照帳單更新）③<b>這期沒有往來的帳戶</b>（只出現在概要、沒有明細可驗，但餘額仍會更新或新建帳戶）④金額和餘額<b>一起</b>被抄成剛好自洽的另一組數字 ⑤某筆金額抄錯、<b>而且同一筆的餘額是空白</b>⑥一筆支出和一筆收入被<b>併成一筆淨額</b>（餘額照樣接得上，但收入與支出的總額都錯了）⑦<b>整個帳戶被漏讀</b>（沒讀到的東西沒有數字可以驗）⑧台幣與外幣<b>互相認錯</b>——認成外幣＝那個帳戶的交易<b>一筆都不會進帳</b>；認成台幣＝<b>外幣數字被當成台幣入帳</b>。兩種畫面都會說驗算通過。<br>⚠️ <b>這份清單不保證完整</b>——⑤～⑧是 2026-08-13 覆審時才發現的，往後可能還有。所以下面兩張表還是請你自己看一眼，尤其是上面那張「帳戶餘額」。";
  const liMatch = badge.match(/<li>⚠️ <b>這道驗算看不到的[\s\S]*?<\/li>/);
  assert.ok(liMatch, '★徽章要有盲點清單那條 <li>');
  assert.equal(liMatch[0].slice(4, -5), APPROVED_BLIND_SPOTS,
    '★盲點清單那條要**逐字**等於核准版本——只要求「包含核准句」擋不住把它當前綴接上相反的話'
    + '（實測：「…（不只這些）都列完了」「…不保證完整，其實已經完整」都能通過 includes）');
});
test('P1b-3 攔截率｜計畫 §八 寫的數字＝這份考題實際量到的（兩邊互扣，改一邊另一邊就紅）', () => {
  // ⚠️ 攔截率一旦寫進文件就是對使用者的承諾。文件的數字**不可以**靠人記得更新（寫死的數字自己會漂），
  //    所以這裡直接拿文件去對實測：加一型錯誤、或某型的結果變了，這題就會紅、逼人一起改。
  // ⚠️ 兩個坑（r1#3 實測）：①**HTML 註解**——把舊數字藏進 <!-- --> 就能騙過「整份搜尋」
  //    ②**整份搜尋**——數字可以寫在文件任何角落，不必真的在講攔截率那一段。
  //    所以：先剝註解，再把範圍鎖到 §八 裡「P1b-3 已實測」開始、到下一個 `- ` 頂層項目為止。
  const planRaw = readFileSync(join(ROOT, 'docs/parser-generalization-plan.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const from = planRaw.indexOf('**P1b-3 已實測');
  assert.notEqual(from, -1, '§八 要有 P1b-3 實測那一段');
  const plan = planRaw.slice(from, planRaw.indexOf('\n- ', from));
  assert.ok(plan.length > 200, '★範圍要真的咬到那一段（咬空的話底下全部斷言都是空包彈）');
  // ⚠️ 第三種穿透（r2#3 實測）：**把整份文件包進 `<div hidden>`**——原始字串全都還在、
  //    斷言全過，但**渲染出來什麼都看不到**。文件是給人看的，藏起來等於刪掉。
  assert.doesNotMatch(planRaw, /<[a-z]+[^>]*\bhidden\b/i, '★計畫文件不可用 hidden 把內容藏起來');
  assert.doesNotMatch(planRaw, /display\s*:\s*none/i, '★也不可用 display:none 藏');
  const n = (/** @type {'A'|'B'|'C'} */ k) => CASES.filter((c) => c.類 === k).length;
  assert.match(plan, new RegExp(`故障注入 \\*\\*${CASES.length}\\*\\* 型`), '★總型數要與考題一致');
  assert.match(plan, new RegExp(`A 類[^\\n]*＝ ${n('A')}/${n('A')} 全數攔下`), '★A 類的分子分母都要與考題一致');
  assert.match(plan, new RegExp(`B 類[^\\n]*＝ ${n('B')} 型全數漏接`), '★B 類盲點數要與考題一致');
  assert.match(plan, new RegExp(`C 類[^\\n]*＝ ${n('C')} 型`), '★C 類型數要與考題一致');
  // ★r4#2：D 類也要互扣——刪掉 §八 那整段說明，之前的斷言完全不會出聲
  assert.match(plan, new RegExp(`D 類[^\\n]*＝ ${n('D')} 型`), '★D 類型數要與考題一致');
  assert.match(plan, /不算在 A 類|不併進 A 類/, '★§八 要寫明 D 類為什麼不算進 A 類（那正是 10/10 被撐高的病）');
  // ★r5：盲點①要**同時**講金額與方向。main 本來就有「方向」，是我重寫徽章時弄丟的——
  //   方向讀反＝收入被記成支出，月收支同時失真，後果比金額讀錯更直接。
  assert.match(plan, /金額與方向/, '★§八 的盲點①要講明「金額與方向」都驗不到（漏掉方向＝畫面與文件都不再揭露那個回歸）');
  // ★r6 待辦：§八 內文自己又寫了一次型數（「本節的型數是 N」），它**沒被上面那條互扣蓋到**、
  //   上一輪就漂成 9 而沒人出聲。同一份文件裡的每一個型數都要對得起來。
  assert.match(plan, new RegExp(`本節的型數是 ${n('B')}`),
    '★§八 內文複述的型數也要與考題一致（同一份文件不可自己跟自己不一樣）');
  assert.match(plan, /月收支同時失真|月收入與月支出/, '★方向讀反的**後果**要講出來，不能只說「驗不到」');
  // ★r7：型數已經漂過三次（16→20→22→23），每次都是**某處複述**沒跟上。與其一處一處補斷言，
  //   不如**禁止寫死可漂的量詞**：「那兩種形狀」這種寫法一加型別就過期，改成直接點名 B8／B9／B10。
  // ⚠️ 掃 **planRaw 全文**、而且要涵蓋阿拉伯數字（r8#2）：上一版只掃 §八 的窄切片，
  //    把那句話搬到切片外就偵測不到；regex 也漏了「那 3 種形狀」這種寫法＝**漏攔**，不是誤紅。
  // ⚠️ 射程照實寫（r9#4）：這條擋的是「（那／這／以上／以下／共有）N 種形狀」這一族句型，
  //   **不是**所有可漂量詞——裸寫「三種形狀」之類仍漏得掉。與其誇大成「量詞禁令」，不如寫清楚它守到哪。
  assert.doesNotMatch(planRaw, /(?:那|這|以上|以下|共有|共)\s*[0-9一二三四五六七八九十兩]*\s*種形狀/,
    '★不要用「那／這／以上 N 種形狀」寫死數量——加一型就過期，而複述處補不完（直接點名 B8／B9／B10 不會漂）');
  // 誠實劃界那兩句在**下一個項目符號**裡（不在上面那段窄範圍內），所以拿剝過註解的**全文**驗。
  // 藏進 HTML 註解已經行不通（planRaw 剝掉了），這裡要的是「這兩句確實在文件裡」。
  assert.match(planRaw, /條件攔截率/, '★要講明量的是條件攔截率——拿掉它，讀者會把它誤讀成「AI 正確率」');
  assert.match(planRaw, /不是.*「?AI 多常犯錯/, '★要講明不是 AI 的錯誤率');
  assert.match(planRaw, /不保證完整|不再宣稱窮盡/, '★盲點清單不可宣稱窮盡（第一版的「四件事」就是假的）');
  // ★r3#3：**同一份文件不可以自己打自己**。§二-2 曾留著「攔截率未經實測、不先給數字」，
  //   而 §五／§八 已經宣告實測完成並給了數字——讀者會以為其中一邊在說謊（而且確實有一邊是）。
  //   這一條掃**全文**：任何「攔截率還沒實測」的殘句都算矛盾。
  //   ⚠️ 不可寫成掃「未實測」三個字——§八 講「**AI 的錯誤率**尚未做」是**正確且必要**的劃界，
  //   誤殺它等於逼人拿掉那句誠實話。
  assert.doesNotMatch(planRaw, /攔截率未經實測|攔截率的數字要等|實測前不承諾機率/,
    '★攔截率已經實測並寫進 §八——文件裡不可再留「還沒實測」的殘句（r3#3：同檔自相矛盾）');
});
