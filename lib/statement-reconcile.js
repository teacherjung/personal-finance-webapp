// @ts-check
// 匯入對帳閘（P0，解析器通用化施工計畫 §四；#437 定案、本支落地）。
// 帳單自己印了可以互相驗算的數字——匯入前先驗「帳單自己的數學」，驗不過就整份擋下：
//   強閘＝銀行對帳單：同帳戶逐筆「前一筆餘額 ± 金額 ＝ 這一筆餘額」的餘額鏈＋明細末筆對概要區餘額。
//   中閘＝信用卡帳單：摘要等式（上期應繳 − 已繳/退款 ＋ 本期新增 ＝ 本期應繳）擋下；
//         明細加總對摘要總額＝**影子檢查**（記 advisories 不擋，見下方界線②）。
//   弱閘＝沒有任何擋下型檢查開得了（如台新官網 XLSX：只印本期帳單金額、缺三個交叉欄＝C1 開不了）：
//         不驗、照舊放行並標示級別。
//
// 裁決（施工計畫 §四）：**「與帳單印的數字不一致」＝擋下（fail-closed）**——寧可暫時不能匯入，
// 不把錯的數字靜靜記進帳本（生存優先）；**「沒有數字可對」＝誠實降級**（強→弱／中→弱）照舊放行，
// 既有模板解析器的今日行為不變。★6（William 2026-08-11）：未來 AI 解析路線（P1）相反——弱閘＝不准匯入。
//
// ⚠️ 誠實劃界（施工計畫 §八）：這道閘攔的是「不一致」。解析器若錯得**自洽**（金額與餘額同套錯、
// 或整筆連同餘額一起漏讀在鏈的頭尾），數學驗不出——不可把這裡說成「保證正確」。
// 兩條已知界線（r1 複審坐實，逐字揭露、不遮）：
//   ①強閘**驗不到每個帳戶的第一筆**：餘額鏈從第二筆起才有「上一筆」可咬合，而帳單的期初餘額
//     目前沒有抽取＝計畫寫的「期初＋Σ進出＝期末」**尚未實作**——首筆的金額/方向錯，鏈照樣全綠。
//     verdict.stats.firstRowsUnverified 誠實計數；期初餘額抽取＝真帳單校準後另支補。
//   ②中閘的「明細加總 vs 摘要總額」（C2/C3）＝**影子檢查、不擋**：分期/年費/利息這類
//     「只列摘要、不列明細」的合法版面會讓它天生對不上——真帳單校準出口徑之前，硬擋＝誤擋
//     合法帳單。擋下的只有 C1（帳單自己印的那行等式，天生必平、不平＝我們讀錯）。
// 純函式模組：不碰 db、不碰 IO，餵解析器的產物、回裁決。接線見 bank-import.js／statement-import.js。

/** @typedef {{code:string, message:string}} GateProblem */
/** @typedef {'pass'|'fail'|'skip'|'mismatch'} CheckStatus mismatch＝影子檢查對不上（不擋、進 advisories） */
/**
 * 對帳裁決。level＝這份帳單「實際有擋下型驗證」的級別（不是解析器的宣稱）；ok=false ⇒ 呼叫端擋下匯入。
 * advisories＝影子檢查的對不上：不影響 ok，供預覽顯示與真帳單校準（升級成擋＝另支 PR 的一行改動）。
 * @typedef {{level:'strong'|'medium'|'weak', ok:boolean, problems:GateProblem[], advisories:GateProblem[],
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
 * ②末筆對概要——明細**真正的最後一筆**餘額要等於概要區印的帳戶餘額（兩區各自印、互相對）。
 *   ⚠️ 末筆餘額讀不到＝這個帳戶 skip——**不可拿較早的餘額冒充末筆**（r1#2：較早餘額之後還有交易，
 *   拿它對概要必然對不上＝把「缺數字」誤判成「不一致」，違反「缺數字＝skip」的裁決）。
 *   ⚠️ 這一條另建立在「現值參考日＝明細期末」的版面假設上，真帳單煙霧測如誤擋，先軟化它、不動①。
 * 讀不到餘額的列跳過該對（stats 記 pairsSkipped）；整份都沒有可驗的數字＝降級 weak、放行。
 * ⚠️ 首筆未驗（r1#3）＝檔頭界線①：每個帳戶的第一筆金額/方向這裡驗不到，stats.firstRowsUnverified 計數。
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
    // 只認**真正的末筆**（r1#2）：末筆餘額讀不到＝skip，不可回頭拿較早的餘額冒充
    // （較早餘額之後還有交易，對概要必然對不上＝把「缺數字」誤報成「不一致」）。
    const lastTx = list[list.length - 1];
    if (lastTx.balance == null) continue;
    endChecked++;
    const diff = r2(lastTx.balance - pa.balance);
    if (Math.abs(diff) > BAL_EPS) {
      endBroken++;
      const suffix = pa.masked.match(/(\d+)$/)?.[1] || pa.masked;
      problems.push({
        code: 'bank-end-balance',
        message: `帳戶 ****${suffix}：明細最後一筆（${lastTx.date}）的餘額 ${fmt(lastTx.balance)} `
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
    problems, advisories: [], checks,
    // firstRowsUnverified＝檔頭界線①的誠實計數：每個有交易的帳戶都有一筆「鏈驗不到」的首筆
    stats: { pairsChecked, pairsSkipped, endChecked, firstRowsUnverified: byAcct.size },
  };
}

/**
 * 中閘：信用卡帳單。totals＝帳單摘要四格（台新郵寄版那一行自己印了整條等式：
 * 「上期應款總額 − (已繳款金額＋本期退款) ＋ 本期新增款項 ＝ 本期累計應繳金額」）。三道檢查，
 * **各自只在讀得到所需欄位時才跑**（缺格＝skip，不可拿「沒讀到」當「對不上」誤擋）：
 * ①（擋下）摘要等式自驗——四格都在才驗；銀行印的那行天生是平的，不平＝至少一格被**我們**讀錯。
 * ②（影子）明細正項加總 vs 本期新增款項——漏讀/多讀消費會露餡，**但分期/年費/利息這類
 *   「只列摘要不列明細」的合法版面也會對不上**（r1#1 坐實）＝分不出「我們錯」還是「版面如此」，
 *   在真帳單校準出口徑前只記 advisories 不擋。
 * ③（影子）明細負項加總 vs 已繳款＋退款——同②的理由與待遇。
 * level 只數**擋下型**驗證：C1 有跑＝medium；只剩影子或全 skip＝weak（誠實：影子不是保護）。
 * @param {{transactions?:{amount:number}[], statementTotals?:CardTotals}} parsed
 * @returns {GateVerdict}
 */
export function reconcileCardStatement(parsed) {
  /** @type {GateProblem[]} */
  const problems = [];
  /** @type {GateProblem[]} */
  const advisories = [];
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
  // ②③影子檢查（r1#1）：mismatch 進 advisories、不進 problems＝不擋。訊息把兩種可能都講
  // （我們漏讀 or 版面只列摘要），供預覽顯示與真帳單校準；升級成擋＝把 push 目標改 problems 一行。
  if (t.newCharges != null) {
    const diff = r2(sumPos - t.newCharges);
    if (Math.abs(diff) > CARD_EPS) {
      checks.newVsRows = 'mismatch';
      advisories.push({
        code: 'card-new-vs-rows',
        message: `明細的消費加總 ${fmt(sumPos)} 與帳單印的「本期新增款項」${fmt(t.newCharges)} 差 ${fmt(Math.abs(diff))}`
          + '——可能漏讀了消費，也可能這份帳單有只列在摘要的分期/年費/利息（P0 影子檢查、不擋，請回報數字幫忙校準）',
      });
    } else checks.newVsRows = 'pass';
  }
  if (t.paidAndRefund != null) {
    const diff = r2(sumNegAbs - t.paidAndRefund);
    if (Math.abs(diff) > CARD_EPS) {
      checks.paidVsRows = 'mismatch';
      advisories.push({
        code: 'card-paid-vs-rows',
        message: `明細的繳款/退款加總 ${fmt(sumNegAbs)} 與帳單印的「已繳款＋退款」${fmt(t.paidAndRefund)} 差 ${fmt(Math.abs(diff))}`
          + '——可能漏讀了繳款/退款列，也可能這份帳單把繳款只列在摘要（P0 影子檢查、不擋，請回報數字幫忙校準）',
      });
    } else checks.paidVsRows = 'pass';
  }
  return {
    // level 只數擋下型驗證（C1）：影子檢查不是保護，不可讓它撐級別（誠實劃界②）
    level: checks.equation !== 'skip' ? 'medium' : 'weak',
    ok: problems.length === 0,
    problems, advisories, checks,
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
