// @ts-check
// 匯入對帳閘（P0，解析器通用化施工計畫 §四；#437 定案、本支落地）。
// 帳單自己印了可以互相驗算的數字——匯入前先驗「帳單自己的數學」，驗不過就整份擋下：
//   強閘＝銀行對帳單：同帳戶逐筆「前一筆餘額 ± 金額 ＝ 這一筆餘額」的餘額鏈＋明細末筆對概要區餘額。
//   中閘＝信用卡帳單：摘要等式（上期應繳 − 已繳/退款 ＋ 本期新增 ＝ 本期應繳）＋明細加總對摘要總額。
//   弱閘＝什麼數字都對不了（如台新官網 XLSX 沒印總額）：只剩結構檢查＝不驗、照舊放行並標示級別。
//
// 裁決（施工計畫 §四）：**「與帳單印的數字不一致」＝擋下（fail-closed）**——寧可暫時不能匯入，
// 不把錯的數字靜靜記進帳本（生存優先）；**「沒有數字可對」＝誠實降級**（強→弱／中→弱）照舊放行，
// 既有模板解析器的今日行為不變。★6（William 2026-08-11）：未來 AI 解析路線（P1）相反——弱閘＝不准匯入。
//
// ⚠️ 誠實劃界（施工計畫 §六）：這道閘攔的是「不一致」。解析器若錯得**自洽**（金額與餘額同套錯、
// 或整筆連同餘額一起漏讀在鏈的頭尾），數學驗不出——不可把這裡說成「保證正確」。
// 純函式模組：不碰 db、不碰 IO，餵解析器的產物、回裁決。接線見 bank-import.js／statement-import.js。

/** @typedef {{code:string, message:string}} GateProblem */
/** @typedef {'pass'|'fail'|'skip'} CheckStatus */
/**
 * 對帳裁決。level＝這份帳單「實際驗到」的級別（不是解析器的宣稱）；ok=false ⇒ 呼叫端擋下匯入。
 * @typedef {{level:'strong'|'medium'|'weak', ok:boolean, problems:GateProblem[],
 *   checks:Record<string, CheckStatus>, stats:Record<string, number>}} GateVerdict
 */
/** 信用卡帳單摘要四格（statement.js extractStatementTotals 的產物；讀不到的格＝null）。
 * @typedef {{due:number|null, prevDue:number|null, paidAndRefund:number|null, newCharges:number|null}} CardTotals */

/** 浮點修圓到分（外幣餘額帶兩位小數；直接相減會有 1e-13 級噪音）。 @param {number} n */
const r2 = (n) => Math.round(n * 100) / 100;
/** 訊息裡的金額（千分位、最多兩位小數）。 @param {number} n */
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
/** 餘額鏈容差：整數台幣理論上要全等，外幣兩位小數＝允許 0.005 的修圓縫。 */
const BAL_EPS = 0.005;
/** 信用卡總額容差：帳單是整數新臺幣，允許 ±1 的進位差（超過＝真的對不上）。 */
const CARD_EPS = 1.005;

/**
 * 強閘：台新銀行綜合對帳單。
 * ①餘額鏈——同一個帳戶（分組鍵＝**完整遮罩帳號**，同 bankRefBase：末碼相同、前綴不同的兩帳戶不可混鏈）
 *   相鄰兩筆都讀得到餘額時，驗「前一筆餘額 ± 這筆金額 ＝ 這筆餘額」。解析器**靜默跳過**讀不懂的列
 *   （壞日期、抓不到金額都是 continue）——被跳過的那筆會讓鏈接不起來＝這道檢查存在的理由。
 * ②末筆對概要——明細最後一筆的餘額要等於概要區印的帳戶餘額（兩個區各自印、互相對＝文件內的雙帳本）。
 *   ⚠️ 這一條建立在「現值參考日＝明細期末」的版面假設上，真帳單煙霧測如誤擋，先軟化它、不動①。
 * 讀不到餘額的列跳過該對（stats 記 pairsSkipped）；整份都沒有可驗的數字＝降級 weak、放行。
 * @param {{accounts?:{masked:string, balance:number|null}[], transactions?:import('./bank-statement.js').BankTx[]}} parsed
 * @returns {GateVerdict}
 */
export function reconcileBankStatement(parsed) {
  /** @type {GateProblem[]} */
  const problems = [];
  /** @type {Map<string, import('./bank-statement.js').BankTx[]>} */
  const byAcct = new Map();
  for (const tx of parsed?.transactions || []) {
    const key = tx.acctMasked || `x****${tx.acctSuffix || ''}`;
    const g = byAcct.get(key);
    if (g) g.push(tx); else byAcct.set(key, [tx]);
  }
  let pairsChecked = 0, pairsSkipped = 0, chainBroken = 0;
  for (const [masked, list] of byAcct) {
    const suffix = masked.match(/(\d+)$/)?.[1] || masked;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (prev.balance == null || cur.balance == null) { pairsSkipped++; continue; }
      pairsChecked++;
      const expected = cur.direction === 'in' ? cur.amount : -cur.amount;
      const diff = r2(cur.balance - (prev.balance + expected));
      if (Math.abs(diff) > BAL_EPS) {
        chainBroken++;
        problems.push({
          code: 'bank-chain-break',
          message: `帳戶 ****${suffix} 在 ${cur.date}「${cur.summary || '（無摘要）'}」接不上：`
            + `前一筆餘額 ${fmt(prev.balance)}、這筆${cur.direction === 'in' ? '存入' : '支出'} ${fmt(cur.amount)}，`
            + `帳上卻印餘額 ${fmt(cur.balance)}（差 ${fmt(Math.abs(diff))}）——中間可能有一筆沒被讀到，或金額/方向讀錯`,
        });
      }
    }
  }
  let endChecked = 0, endBroken = 0;
  for (const pa of parsed?.accounts || []) {
    if (pa.balance == null || !pa.masked) continue;
    const list = byAcct.get(pa.masked);
    if (!list) continue;   // 概要有、明細沒有交易的帳戶＝沒得對（本期無往來，正常）
    /** @type {{date:string, balance:number}|null} */
    let last = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i].balance;
      if (b != null) { last = { date: list[i].date, balance: b }; break; }
    }
    if (!last) continue;
    endChecked++;
    const diff = r2(last.balance - pa.balance);
    if (Math.abs(diff) > BAL_EPS) {
      endBroken++;
      const suffix = pa.masked.match(/(\d+)$/)?.[1] || pa.masked;
      problems.push({
        code: 'bank-end-balance',
        message: `帳戶 ****${suffix}：明細最後一筆（${last.date}）的餘額 ${fmt(last.balance)} `
          + `與概要區印的帳戶餘額 ${fmt(pa.balance)} 對不上（差 ${fmt(Math.abs(diff))}）——期末可能漏讀了交易`,
      });
    }
  }
  /** @type {Record<string, CheckStatus>} */
  const checks = {
    chain: pairsChecked ? (chainBroken ? 'fail' : 'pass') : 'skip',
    endBalance: endChecked ? (endBroken ? 'fail' : 'pass') : 'skip',
  };
  return {
    level: (pairsChecked + endChecked) > 0 ? 'strong' : 'weak',
    ok: problems.length === 0,
    problems, checks,
    stats: { pairsChecked, pairsSkipped, endChecked },
  };
}

/**
 * 中閘：信用卡帳單。totals＝帳單摘要四格（台新郵寄版那一行自己印了整條等式：
 * 「上期應款總額 − (已繳款金額＋本期退款) ＋ 本期新增款項 ＝ 本期累計應繳金額」）。三道檢查，
 * **各自只在讀得到所需欄位時才跑**（缺格＝skip，不可拿「沒讀到」當「對不上」誤擋）：
 * ①摘要等式自驗——四格都在才驗；不平＝至少一格被讀錯（銀行印的那行天生是平的）。
 * ②明細正項加總 ＝ 本期新增款項——漏讀/多讀一筆消費就露餡（閘的主要獵物）。
 * ③明細負項加總 ＝ 已繳款＋退款——繳款與退款列的鏡像檢查。
 * 三道全 skip（如 XLSX 官網版沒印總額）＝降級 weak、照舊放行。
 * @param {{transactions?:{amount:number}[], statementTotals?:CardTotals}} parsed
 * @returns {GateVerdict}
 */
export function reconcileCardStatement(parsed) {
  /** @type {GateProblem[]} */
  const problems = [];
  const t = parsed?.statementTotals || { due: null, prevDue: null, paidAndRefund: null, newCharges: null };
  let sumPos = 0, sumNegAbs = 0;
  for (const tx of parsed?.transactions || []) {
    const a = Number(tx.amount) || 0;
    if (a > 0) sumPos += a; else sumNegAbs += -a;
  }
  sumPos = r2(sumPos); sumNegAbs = r2(sumNegAbs);

  /** @type {Record<string, CheckStatus>} */
  const checks = { equation: 'skip', newVsRows: 'skip', paidVsRows: 'skip' };
  if (t.due != null && t.prevDue != null && t.paidAndRefund != null && t.newCharges != null) {
    const computed = r2(t.prevDue - t.paidAndRefund + t.newCharges);
    const diff = r2(computed - t.due);
    if (Math.abs(diff) > CARD_EPS) {
      checks.equation = 'fail';
      problems.push({
        code: 'card-equation',
        message: `帳單摘要自己的等式不平：上期應繳 ${fmt(t.prevDue)} − 已繳/退款 ${fmt(t.paidAndRefund)} `
          + `＋ 本期新增 ${fmt(t.newCharges)} ＝ ${fmt(computed)}，但讀到的本期應繳是 ${fmt(t.due)}`
          + `（差 ${fmt(Math.abs(diff))}）——四個數字至少有一個被讀錯`,
      });
    } else checks.equation = 'pass';
  }
  if (t.newCharges != null) {
    const diff = r2(sumPos - t.newCharges);
    if (Math.abs(diff) > CARD_EPS) {
      checks.newVsRows = 'fail';
      problems.push({
        code: 'card-new-vs-rows',
        message: `明細的消費加總 ${fmt(sumPos)} 與帳單印的「本期新增款項」${fmt(t.newCharges)} 對不上`
          + `（差 ${fmt(Math.abs(diff))}）——可能漏讀或多讀了消費`,
      });
    } else checks.newVsRows = 'pass';
  }
  if (t.paidAndRefund != null) {
    const diff = r2(sumNegAbs - t.paidAndRefund);
    if (Math.abs(diff) > CARD_EPS) {
      checks.paidVsRows = 'fail';
      problems.push({
        code: 'card-paid-vs-rows',
        message: `明細的繳款/退款加總 ${fmt(sumNegAbs)} 與帳單印的「已繳款＋退款」${fmt(t.paidAndRefund)} 對不上`
          + `（差 ${fmt(Math.abs(diff))}）——可能漏讀了繳款或退款列`,
      });
    } else checks.paidVsRows = 'pass';
  }
  const ran = Object.values(checks).some((s) => s !== 'skip');
  return {
    level: ran ? 'medium' : 'weak',
    ok: problems.length === 0,
    problems, checks,
    stats: {
      sumPos, sumNegAbs,
      due: t.due ?? NaN, prevDue: t.prevDue ?? NaN, paidAndRefund: t.paidAndRefund ?? NaN, newCharges: t.newCharges ?? NaN,
    },
  };
}

/**
 * 擋下時給使用者看的整句白話訊息（400 的 message）。最多列 3 處、其餘計數，
 * 收尾講清楚「為什麼整份擋」與「下一步」——擋下不解釋＝使用者只會以為 app 壞了。
 * @param {GateVerdict} verdict @param {string} docLabel 「銀行對帳單」/「信用卡帳單」
 */
export function gateFailureMessage(verdict, docLabel) {
  const list = verdict.problems.slice(0, 3).map((p) => p.message);
  const more = verdict.problems.length - list.length;
  return `對帳沒過，這份${docLabel}先不匯入：${list.join('；')}`
    + `${more > 0 ? `；…還有 ${more} 處對不上` : ''}。`
    + '為了不把錯的數字記進帳本，整份都先擋下——請把這段訊息回報，我們會查是哪裡讀歪了。';
}
