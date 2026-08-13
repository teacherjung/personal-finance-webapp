// @ts-check
// P1b-3 攔截率實測：AI 讀錯帳單時，對帳閘攔得住哪幾種、攔不住哪幾種——用**數字**回答。
//
// ⚠️ **這份量的是「閘」的性質，不是「AI」的性質**（整份的誠實劃界，讀數字前先讀這段）：
//   ・做法＝**故障注入**：拿一份正確的合成帳單，照「AI 會怎麼讀錯」逐型注入錯誤，看閘攔不攔得住。
//   ・得到的是**條件攔截率**——「**如果** AI 犯了 X 型錯，會不會被擋下」。
//   ・**不是**「AI 多常犯錯」。那要真 AI ＋ 有標準答案的語料，不在這一支（見 §八）。
//   ・為什麼不打真 AI 量：①不可重現（同一份帳單兩次可能不同答案，票制存在的理由就是這個）
//     ②要花使用者的錢 ③跑得動的份數小到沒有統計意義。故障注入可以**窮舉錯誤型別**、零成本、可重現。
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

/** @type {{id:string, 類:'A'|'B'|'C', name:string, why:string, expect:'caught'|'missed', build:() => any}[]} */
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
    why: '兩邊的鏈同時被破壞',
    build: () => { const p = corpusFreeRider(); p.transactions[1].acctMasked = '900100****3302'; p.transactions[1].acctSuffix = '3302'; return p; } },

  { id: 'A8', 類: 'A', name: '期末餘額與概要對不上（漏讀期末幾筆）', expect: 'caught',
    why: '末筆餘額與概要區印的帳戶餘額互扣 ⇒ 對不上',
    build: () => { const p = corpusFull(); p.transactions.pop(); return p; } },

  { id: 'A9', 類: 'A', name: '整份只讀出一筆（其餘全漏）', expect: 'caught',
    why: '只有一筆＝沒有相鄰兩筆可比，但末筆仍要對概要 ⇒ 對不上',
    build: () => { const p = corpusFull(); p.transactions = [p.transactions[0]]; return p; } },

  { id: 'A10', 類: 'A', name: '某個台幣帳戶的餘額欄全空（該帳戶零驗證）', expect: 'caught',
    why: '★6 逐帳戶覆蓋：有任何一個受驗帳戶一道擋下型都沒吃到就拒收（level 是全檔旗標、擋不住搭便車）',
    build: () => corpusFreeRider() },

  // ── B 類：會讓入帳金額出錯，但**閘看不到**（已知盲點，畫面上逐條寫給使用者看） ──
  { id: 'B1', 類: 'B', name: '金額與餘額**一起**被改成自洽的另一組數字', expect: 'missed',
    why: '盲點④：數學是平的，驗算看不出來——只能靠使用者自己看一眼',
    build: () => { const p = corpusFull(); p.transactions[1].amount = 300; p.transactions[1].balance = 700;
      p.transactions[2].balance = 1400; p.transactions[3].balance = 1200;
      /** @type {any} */ (p.accounts[0]).balance = 1200; return p; } },

  { id: 'B2', 類: 'B', name: '每個帳戶的**第一筆**金額或方向讀錯', expect: 'missed',
    why: '盲點①：首筆沒有前一筆可比——鏈是拿它的**餘額**去比下一筆，它的**金額**沒有任何檢查用到，'
      + '所以只改金額、其餘一個字不動，整份仍完全自洽（連概要都對得上），錢卻已經記錯了',
    build: () => { const p = corpusFull(); p.transactions[0].amount = 900; return p; } },

  { id: 'B3', 類: 'B', name: '外幣明細的金額讀錯', expect: 'missed',
    why: '盲點②：外幣列本來就不計入台幣收支、整組不驗（餘額仍會照帳單概要更新）',
    build: () => { const p = corpusForeign(); p.transactions[5].amount = 999; return p; } },

  { id: 'B4', 類: 'B', name: '本期無往來帳戶的概要餘額讀錯', expect: 'missed',
    why: '盲點③：明細一筆都沒有＝沒有任何數字可以驗它，但那個餘額仍會被寫進帳戶',
    build: () => { const p = corpusIdleAccount(); /** @type {any} */ (p.accounts[1]).balance = 8000; return p; } },

  // ── C 類：不動到金額（閘本來就不管，靠學習表與人工改） ──
  { id: 'C1', 類: 'C', name: '摘要抄錯字（金額全對）', expect: 'missed',
    why: '不影響任何數字；分類可能跑掉，但錢是對的——匯入後在收支列表逐筆改',
    build: () => { const p = corpusFull(); p.transactions[1].summary = '提欵'; return p; } },

  { id: 'C2', 類: 'C', name: '日期讀錯（金額與餘額全對）', expect: 'missed',
    why: '閘驗的是餘額鏈的順序關係，不是日期本身；日期錯會讓那筆記在別的月份',
    build: () => { const p = corpusFull(); p.transactions[1].date = '2026-07-06'; return p; } },
];

// ---------- 實測 ----------

test('P1b-3 攔截率｜前置：正確的合成帳單四種形狀都要能通過（不然攔截率是被誤擋撐出來的）', () => {
  for (const [name, p] of /** @type {[string, any][]} */ ([
    ['單帳戶完整', corpusFull()], ['台幣＋外幣', corpusForeign()], ['含無往來帳戶', corpusIdleAccount()],
  ])) {
    assert.equal(aiWouldPass(p), true, `★${name}：沒有注入錯誤就該放行——會誤擋的閘算出來的攔截率沒有意義`);
  }
  // 搭便車形狀**本來就該被拒**（A10 就是在講這件事），所以不列進「前置要通過」的名單。
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

test('P1b-3 攔截率｜A 類（造成不一致的錯）必須 100% 攔下——這是這支功能唯一的承諾', () => {
  const a = CASES.filter((c) => c.類 === 'A');
  assert.ok(a.length >= 10, `A 類樣本要夠多才敢寫成承諾（現有 ${a.length} 型）`);
  const missed = a.filter((c) => aiWouldPass(c.build()));
  assert.deepEqual(missed.map((c) => c.id), [],
    '★「造成不一致的錯會被擋下來給你看」是計畫 §八 的承諾——漏掉任何一型，那句話就要改口');
});

test('P1b-3 攔截率｜B 類盲點剛好四個，而且與畫面上寫給使用者的四件事一一對上', () => {
  // 預覽窗的徽章逐條列出「這道驗算看不到的四件事」。那份清單與這裡的 B 類**必須是同一份**，
  // 否則畫面在對使用者說謊（少列＝漏講、多列＝嚇人）。
  const b = CASES.filter((c) => c.類 === 'B');
  assert.equal(b.length, 4, '★盲點數目變了就要同步改畫面文案與契約');
  for (const c of b) assert.match(c.why, /盲點[①②③④]/, `${c.id} 要標明對應畫面上的第幾件事`);
  assert.deepEqual(b.map((c) => (c.why.match(/盲點([①②③④])/) || [])[1]).sort(), ['①', '②', '③', '④'],
    '★四個盲點要一一對上，不可重複也不可缺');
});

test('P1b-3 攔截率｜計畫 §八 寫的數字＝這份考題實際量到的（兩邊互扣，改一邊另一邊就紅）', () => {
  // ⚠️ 攔截率一旦寫進文件就是對使用者的承諾。文件的數字**不可以**靠人記得更新（寫死的數字自己會漂），
  //    所以這裡直接拿文件去對實測：加一型錯誤、或某型的結果變了，這題就會紅、逼人一起改。
  const plan = readFileSync(join(ROOT, 'docs/parser-generalization-plan.md'), 'utf8');
  const n = (/** @type {'A'|'B'|'C'} */ k) => CASES.filter((c) => c.類 === k).length;
  assert.match(plan, new RegExp(`故障注入 \\*\\*${CASES.length}\\*\\* 型`), '★總型數要與考題一致');
  assert.match(plan, new RegExp(`A 類[^\\n]*＝ ${n('A')}/${n('A')} 全數攔下`), '★A 類的分子分母都要與考題一致');
  assert.match(plan, new RegExp(`B 類[^\\n]*＝ ${n('B')} 型全數漏接`), '★B 類盲點數要與考題一致');
  assert.match(plan, new RegExp(`C 類[^\\n]*＝ ${n('C')} 型`), '★C 類型數要與考題一致');
  // 這句是誠實劃界的承重點：拿掉它，讀者就會把條件攔截率誤讀成「AI 正確率」
  assert.match(plan, /條件攔截率/, '★要講明量的是條件攔截率');
  assert.match(plan, /不是.*「?AI 多常犯錯/, '★要講明不是 AI 的錯誤率');
});
