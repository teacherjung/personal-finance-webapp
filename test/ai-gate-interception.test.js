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

/** @type {{id:string, 類:'A'|'B'|'C'|'D', name:string, why:string, expect:'caught'|'missed',
 *          badge?:string, build:() => any}[]}
 * `badge`＝這一型在**預覽窗徽章**上的那句話（B 類必填）：考題拿它去徽章裡找，
 * 找不到＝我們知道它攔不到、卻沒告訴使用者。 */
const CASES = [
  // ── A 類：會讓入帳金額出錯，而且會造成前後不一致 ⇒ 目標全數攔下 ──
  { id: 'A1', 類: 'A', name: '單筆金額抄錯一位數（8→3）', expect: 'caught',
    why: '金額變了、餘額沒變 ⇒ 逐筆餘額鏈當場接不上',
    build: () => { const p = corpusFull(); p.transactions[1].amount = 700; return p; } },

  { id: 'A2', 類: 'A', name: '小數點位移（1,234.5 讀成 12,345）', expect: 'caught',
    why: '同上，差額巨大、鏈必斷',
    build: () => { const p = corpusFull(); p.transactions[2].amount = 7000; return p; } },

  { id: 'A3', 類: 'A', name: '方向看反（存入讀成支出）', expect: 'caught',
    why: '方向反了、餘額不動 ⇒ 差兩倍金額，鏈接不上',
    build: () => { const p = corpusFull(); p.transactions[2].direction = 'out'; return p; } },

  { id: 'A4', 類: 'A', name: '漏讀一整筆（跳過一行）', expect: 'caught',
    why: '前後兩筆的餘額之間多出一段沒有交易解釋 ⇒ 鏈斷',
    build: () => { const p = corpusFull(); p.transactions.splice(2, 1); return p; } },

  { id: 'A5', 類: 'A', name: '同一筆讀成兩筆（重複一行）', expect: 'caught',
    why: '多出來那筆的餘額與前一筆相同 ⇒ 對不上金額',
    build: () => { const p = corpusFull(); p.transactions.splice(2, 0, { ...p.transactions[2] }); return p; } },

  { id: 'A6', 類: 'A', name: '餘額欄抄錯（金額對、餘額錯）', expect: 'caught',
    why: '鏈的兩端都在驗，改單邊必斷',
    build: () => { const p = corpusFull(); p.transactions[2].balance = 1400; return p; } },

  { id: 'A7', 類: 'A', name: '把 A 帳戶的一列掛到 B 帳戶（末碼讀錯）', expect: 'caught',
    why: '兩邊的鏈同時被破壞。⚠️ 基準用**兩邊都驗得動**的 corpusTwoAccounts——'
      + '建在「本來就會被拒收」的基準上＝二元判定證明不了是注入造成的攔截（r1#2 抓到的假陽性）',
    build: () => { const p = corpusTwoAccounts(); p.transactions[1].acctMasked = '900100****3302'; p.transactions[1].acctSuffix = '3302'; return p; } },

  { id: 'A8', 類: 'A', name: '期末餘額與概要對不上（漏讀期末幾筆）', expect: 'caught',
    why: '末筆餘額與概要區印的帳戶餘額互扣 ⇒ 對不上',
    build: () => { const p = corpusFull(); p.transactions.pop(); return p; } },

  { id: 'A9', 類: 'A', name: '整份只讀出一筆（其餘全漏）', expect: 'caught',
    why: '只有一筆＝沒有相鄰兩筆可比，但末筆仍要對概要 ⇒ 對不上',
    build: () => { const p = corpusFull(); p.transactions = [p.transactions[0]]; return p; } },

  // ── D 類：金額全對，但**驗算根本蓋不到那個帳戶** ⇒ ★6 保守拒收 ──
  // ⚠️ 它**不屬於 A 類**（r3#2 指正）：A 類的承諾是「造成不一致的錯會被擋」，而這一型
  //    一個數字都沒錯、`problems` 是空的——擋它的是**覆蓋政策**，不是偵測到不一致。
  //    混進 A 類＝用不相干的樣本把 10/10 撐高。
  { id: 'D1', 類: 'D', name: '某個台幣帳戶的餘額欄全空（該帳戶零驗證）', expect: 'caught',
    why: '★6 逐帳戶覆蓋：有任何一個受驗帳戶一道擋下型都沒吃到就拒收（level 是全檔旗標、擋不住搭便車）',
    build: () => corpusFreeRider() },

  // ── B 類：會讓入帳金額出錯，但**閘看不到**（已知盲點，畫面上逐條寫給使用者看） ──
  { id: 'B1', 類: 'B', name: '金額與餘額**一起**被改成自洽的另一組數字', expect: 'missed', badge: '自洽',
    why: '盲點④：數學是平的，驗算看不出來——只能靠使用者自己看一眼',
    build: () => { const p = corpusFull(); p.transactions[1].amount = 300; p.transactions[1].balance = 700;
      p.transactions[2].balance = 1400; p.transactions[3].balance = 1200;
      /** @type {any} */ (p.accounts[0]).balance = 1200; return p; } },

  { id: 'B2', 類: 'B', name: '每個帳戶的**第一筆**金額或方向讀錯', expect: 'missed', badge: '第一筆',
    why: '盲點①：首筆沒有前一筆可比——鏈是拿它的**餘額**去比下一筆，它的**金額**沒有任何檢查用到，'
      + '所以只改金額、其餘一個字不動，整份仍完全自洽（連概要都對得上），錢卻已經記錯了',
    build: () => { const p = corpusFull(); p.transactions[0].amount = 900; return p; } },

  { id: 'B3', 類: 'B', name: '本期無往來帳戶的概要餘額讀錯', expect: 'missed', badge: '沒有往來',
    why: '盲點③：明細一筆都沒有＝沒有任何數字可以驗它，但那個餘額仍會被寫進帳戶',
    build: () => { const p = corpusIdleAccount(); /** @type {any} */ (p.accounts[1]).balance = 8000; return p; } },

  // ⚠️ 以下四型是**審查者（Codex r1）用唯讀探針找出來的**，我原本的型錄漏了它們——
  //    也就是說「這道驗算看不到的四件事」那句話**是假的**。清單補不完，所以改口：不再宣稱窮盡。
  { id: 'B4', 類: 'B', name: '某筆金額讀錯、而且**同一筆的餘額讀成空白**', expect: 'missed', badge: '餘額是空白',
    why: '盲點⑤：餘額空白的那一對會被跳過，但該帳戶還有別對在驗 ⇒ 仍算「有驗到」，逐帳戶覆蓋不會紅',
    build: () => { const p = corpusFull(); p.transactions[1].amount = 700; p.transactions[1].balance = null; return p; } },

  { id: 'B5', 類: 'B', name: '一筆支出與一筆收入被**併成一筆淨額**', expect: 'missed', badge: '併成一筆淨額',
    why: '盲點⑥：淨額一樣 ⇒ 餘額鏈完全接得上、期末也對，但**收入與支出兩邊的總額都錯了**（最陰險的一型）',
    build: () => { const p = corpusFull();
      p.transactions.splice(1, 2, tx({ date: '2026-07-05', summary: '淨額', direction: 'in', amount: 500, balance: 1500 }));
      return p; } },

  { id: 'B6', 類: 'B', name: '整個帳戶被漏讀（概要與明細都沒讀到）', expect: 'missed', badge: '整個帳戶被漏讀',
    why: '盲點⑦：沒讀到的東西沒有任何數字可以驗——剩下的部分自己是自洽的',
    build: () => { const p = corpusTwoAccounts(); p.accounts.pop();
      p.transactions = p.transactions.filter((/** @type {any} */ t) => t.acctSuffix !== '3302'); return p; } },

  { id: 'B7', 類: 'B', name: '台幣帳戶被誤判成**外幣**', expect: 'missed', badge: '認成外幣',
    why: '盲點⑧：閘整組跳過不驗，而且匯入層也會排除 ⇒ 那個帳戶的交易**一筆都不會進帳**，畫面卻說驗算通過',
    build: () => { const p = corpusTwoAccounts(); /** @type {any} */ (p.accounts[1]).currency = 'USD';
      /** @type {any} */ (p.accountCurrency)['900100****3302'] = 'USD'; return p; } },

  { id: 'B10', 類: 'B', name: '首筆的**方向**讀反（收入讀成支出）', expect: 'missed', badge: '金額與方向',
    why: '盲點①的第三種形狀，也是**後果最直接**的一種：首筆的方向同樣沒有任何檢查用到'
      + '（鏈只拿它的餘額比下一筆）⇒ 整份仍完全自洽，但那筆收入會被記成支出，**月收入與月支出同時失真**。'
      + '⚠️ main 的徽章本來就寫「金額與方向」，是我 2026-08-13 重寫那條時弄丟了「方向」（r5 抓到的回歸）',
    build: () => { const p = corpusFull(); p.transactions[0].direction = 'out'; return p; } },

  // 審查者 r2 又找到的兩型：都掛在既有編號底下（畫面不新增條目，只把 ①⑧ 的說法擴寫）
  { id: 'B8', 類: 'B', name: '**整筆漏掉**每個帳戶的第一筆', expect: 'missed', badge: '整筆漏掉',
    why: '盲點①的另一種形狀：首筆整個不見，後面的鏈與期末仍然對得上',
    build: () => { const p = corpusFull(); const [, ...rest] = p.transactions; p.transactions = rest; return p; } },

  { id: 'B9', 類: 'B', name: '外幣帳戶被誤判成**台幣**', expect: 'missed', badge: '外幣數字被當成台幣',
    why: '盲點⑧的反方向：外幣的數字會被當台幣入帳（比誤判成外幣更糟——那只是不進帳，這是進錯帳）',
    build: () => { const p = corpusForeign();
      /** @type {any} */ (p.accounts[1]).currency = 'TWD'; /** @type {any} */ (p.accountCurrency)['900100****363'] = 'TWD';
      p.transactions[4].balance = 30; p.transactions[5].balance = 50; return p; } },

  // ── C 類：不動到金額（閘本來就不管，靠學習表與人工改） ──
  { id: 'C0', 類: 'C', name: '外幣明細的金額讀錯', expect: 'missed',
    why: '外幣列整組不驗（盲點②），但**也不會匯入**＝帳本金額不受影響。'
      + '⚠️ 原本被我歸成 B 類「會讓入帳金額出錯」＝說法過重（r1#2 指正）：錯的是畫面上看到的那個數字，不是帳',
    build: () => { const p = corpusForeign(); p.transactions[5].amount = 999; return p; } },

  { id: 'C1', 類: 'C', name: '摘要抄錯字（金額全對）', expect: 'missed',
    why: '不影響任何數字；分類可能跑掉，但錢是對的——匯入後在收支列表逐筆改',
    build: () => { const p = corpusFull(); p.transactions[1].summary = '提欵'; return p; } },

  { id: 'C2', 類: 'C', name: '日期讀錯（金額與餘額全對）', expect: 'missed',
    why: '閘驗的是餘額鏈的順序關係，不是日期本身；日期錯會讓那筆記在別的月份',
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

test('P1b-3 攔截率｜逐型故障注入：每一格的結果都要與寫死的期望吻合', () => {
  /** @type {string[]} */ const wrong = [];
  for (const c of CASES) {
    const actual = aiWouldPass(c.build()) ? 'missed' : 'caught';
    if (actual !== c.expect) wrong.push(`${c.id}（${c.name}）：期望 ${c.expect}、實測 ${actual}`);
  }
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
    assert.deepEqual(v.problems, [], `★${c.id} 的金額必須全對（有 problem 就該歸 A 類）`);
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
  // ⚠️ **要驗看得見的內容**（r3#1 實測）：把那幾條 <li> 包進 `<!-- -->`，字串還在、
  //    `includes()` 照樣命中，但畫面上一條都不剩。先剝註解，而且**徽章本來就不該有註解**——
  //    直接連「有註解」都禁掉，這條路就整個關起來。
  // ⚠️ **改成關門，不再逐個補洞**（r4#1）：藏東西的方法列不完——註解、`hidden`、`display:none`、
  //    `<template>`…每補一個他就找到下一個。改成**白名單**：徽章只准出現這幾種標籤，
  //    其餘（template／script／style／iframe…）一律紅。這一族就整個關起來了。
  const ALLOWED_TAGS = new Set(['b', 'br', 'details', 'div', 'li', 'p', 'summary', 'ul']);
  const usedTags = [...new Set([...raw.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase()))];
  assert.deepEqual(usedTags.filter((t) => !ALLOWED_TAGS.has(t)), [],
    '★徽章出現了白名單外的標籤——`<template>` 之類會讓整段警語在畫面上消失（考題卻照樣掃得到字串）');
  assert.doesNotMatch(raw, /<!--/, '★也不可含 HTML 註解（同樣是把警語藏起來、字串卻還在）');
  assert.doesNotMatch(raw, /\bhidden\b|display\s*:\s*none|visibility\s*:\s*hidden/i,
    '★也不可用 hidden／display:none／visibility:hidden 藏');
  const badge = raw.replace(/<!--[\s\S]*?-->/g, '');
  const missing = b.filter((c) => !c.badge || !badge.includes(c.badge));
  assert.deepEqual(missing.map((c) => c.id), [],
    '★這些盲點在畫面上找不到——考題知道它們攔不到，卻沒告訴使用者');
  assert.doesNotMatch(badge, /看不到的[一二三四五六七八九十]+件事|以下[一二三四五六七八九十]+種|共[一二三四五六七八九十]+件/,
    '★畫面不可寫死件數——寫死就等於宣稱窮盡，而它補不完');
  assert.match(badge, /不保證完整|不只這些|還有沒列到|不是全部/,
    '★畫面要明說這份清單不保證完整（少列＝對使用者說謊）');
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
