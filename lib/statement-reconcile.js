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
//   ②中閘的「明細對摘要總額」（C2′/C3′）＝**影子檢查、不擋**：公式已依真郵寄版校準（P0.2），
//     但分期/年費/循環息月份的樣本還沒見過——William 裁示（2026-08-11）維持影子；⏰ 絆線＝
//     那類月份出現且影子仍安靜時，提請裁決把②③升級為擋（**兩處** advisories.push 改 problems
//     ＋考題同步改，需一起動、不是單行）。擋下的只有 C1（帳單自己印的那行等式，天生必平）。
// 純函式模組：不碰 db、不碰 IO，餵解析器的產物、回裁決。接線見 bank-import.js／statement-import.js。
import { isCardPayment } from './statement.js';   // 繳款判準單一真相（缺旗標負數列的重判用，P0.2 r1#2）
import { getOwn } from './safe-map.js';   // 幣別表查鍵用 own-property（原型鍵防線）

/** @typedef {{code:string, message:string}} GateProblem */
/** @typedef {'pass'|'fail'|'skip'|'mismatch'} CheckStatus mismatch＝影子檢查對不上（不擋、進 advisories） */
/**
 * 對帳裁決。level＝這份帳單「實際有擋下型驗證」的級別（不是解析器的宣稱）；ok=false ⇒ 呼叫端擋下匯入。
 * advisories＝影子檢查的對不上：不影響 ok，供預覽顯示與後續校準（升級為擋＝經 William 裁決後
 * 另支 PR 把兩處 advisories.push 改 problems＋考題同步、一起動）。
 * @typedef {{level:'strong'|'medium'|'weak', ok:boolean, problems:GateProblem[], advisories:GateProblem[],
 *   checks:Record<string, CheckStatus>, stats:Record<string, number>}} GateVerdict
 */
/** 信用卡帳單摘要四格（statement.js extractStatementTotals 的產物；讀不到的格＝null）。
 * @typedef {{due:number|null, prevDue:number|null, paidAndRefund:number|null, newCharges:number|null}} CardTotals */

/** 浮點修圓到分（帳面金額最小單位＝分；直接相減會有 1e-13 級噪音）。 @param {number} n */
const r2 = (n) => Math.round(n * 100) / 100;
/** 訊息裡的金額（千分位、最多兩位小數）。 @param {number} n */
const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
/** 餘額鏈容差（P0.1 r1#3 更正歸因）：受驗的是台幣帳戶＝理論上整數全等；0.005 擋的是
 * **IEEE 浮點殘差與分位修圓**（且「查無幣別＝比照台幣驗」的 fallback 不可假設輸入必為整數），
 * 不是幣別容差——0.01 以上照擋。 */
export const BAL_EPS = 0.005;   // 匯出＝AI 路線合計欄交叉驗證共用同一把尺（P2-2a），不留漂移副本
/**
 * 合計交叉驗證的**封閉狀態碼**（2026-08-19；William 指出：混幣時這道整個關掉，畫面卻說它擋得住——
 * 不是逐字引用，是轉述他當天在對話裡點的問題）。
 *
 * 這道檢查（裁示⑧b，接線在 `bank-import.js assertAiBankReconciled`）**不是每份帳單都跑得起來**：
 * 混幣帳單整道跳過、AI 沒交回合計欄就沒得對、配方路線根本不產這個欄位。跑不跑得起來**必須跟著裁決
 * 走到畫面**——否則說明區那句「帳單有印合計＝合計也擋」對混幣帳單（使用者自己的帳單正是這型）
 * 就是假話，而畫面說謊比少一道檢查更糟（少一道他還知道要自己核對）。
 *
 * ⚠️ **零插值**（同 `progress-stages.js` 的機密機械化）：後端只回這張表裡的代碼與**欄名**，
 * 白話句住 `public/modules/reconcile-summary.js`；帳單的數字一個都不隨裁決外送。
 * ⚠️ 新增代碼要同時補前端句子與互扣考題（`test/reconcile-summary.test.js`）。
 */
export const TOTALS_CHECK = Object.freeze({
  PASS: 'pass',                       // 至少一欄真的比對過、而且對得上（對不上＝ai_totals_mismatch 整份擋下，走不到畫面）
  NO_TOTALS: 'no-totals',             // 這條路線不產合計欄（配方路線：parseWithRecipe 不抄合計）
  NOT_READ: 'not-read',               // 欄位在、三欄都 null＝**AI 沒交回那一欄**（帳單沒印、或它沒讀出來——管線分不出，所以不叫 not-printed）
  MIXED_CURRENCY: 'mixed-currency',   // 台幣＋外幣混合＝合計涵蓋哪一段機械判不出來，整道跳過
});
/** 合計交叉驗證**認得的欄名**（封閉；`totalsCheck.fields` 只會出現這幾個）。
 * ⚠️ 存在的理由是**互扣**（Codex #490 r1#2 抓到的假綠）：前端逐欄翻白話，少翻一個欄
 * ——後端說「這欄真的比對過了」、畫面卻靜靜不講——原本沒有任何考題會紅。
 * 這張表讓前端的互扣題逐欄檢查得到；新增欄位＝前端沒補文案就轉紅。 */
export const TOTALS_FIELDS = Object.freeze(['txCount', 'totalOut', 'totalIn']);
/** 信用卡總額容差：帳單是整數新臺幣，允許 ±1 的進位差（超過＝真的對不上）。 */
const CARD_EPS = 1.005;

/**
 * 帳單自己（概要區）對某遮罩帳號的幣別判定：①accountCurrency 對照（權威，含餘額空白的帳戶）
 * ②accounts 列補位；**查無＝null**（讓呼叫端決定 fallback）。
 * ⚠️ 這是閘與匯入端（bank-import.js `txCurrency` 的前兩步）共用的**單一判準**（P0.1 r1#2）：
 * 兩邊各寫一份就會歧義——實測 map 缺鍵、accounts 判外幣時，匯入端跳過該列（foreign）、
 * 閘卻當台幣驗＝為不入帳的列擋整份。匯入端的第三步（db 現金帳戶補位）由服務層接線時
 * 以 currencyOf 參數帶進來（本模組純函式、不碰 db）。
 * @param {{accounts?:{masked?:string, currency?:string}[], accountCurrency?:Record<string,string>}} parsed
 * @param {string} masked @returns {string|null}
 */
export function statementCurrencyLookup(parsed, masked) {
  if (!masked) return null;
  // own-property 查表（原型鍵防線）：`constructor` 這類帳號字樣直讀會拿到 Object 原型成員（truthy 的 function）
  //   ＝被當成幣別、整列判外幣靜默不入帳。正式路徑進不來（AI 驗收的帳號文法閘、模板一律星號數字），縱深防禦。
  const byMap = parsed?.accountCurrency ? getOwn(parsed.accountCurrency, masked) : null;
  if (byMap) return byMap;
  const pa = (parsed?.accounts || []).find((a) => a.masked && a.masked === masked);
  if (pa) return pa.currency || 'TWD';
  return null;
}

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
 * ⚠️ **只驗台幣帳戶（P0.1，真帳單煙霧測 2026-08-11 誤擋後修）**：外幣綜合帳戶＝同一個帳號下掛
 *   多種幣別——概要區同一個遮罩帳號出現多列（各幣別各自的餘額）、明細各幣別交易共用同一個帳號欄
 *   且列上沒有幣別資訊，按帳號分組必然把兩條幣別的餘額鏈攪在一起＝合法帳單被整份誤擋（實測：
 *   USD 利息列撞上另一幣別的餘額、同一末筆被拿去對兩個幣別的概要餘額）。而**匯入的只有台幣現金流**
 *   （外幣明細只呈現、不入帳，bank-import.js 的 foreign 分流）——**閘的射程對齊匯入的射程**：
 *   幣別判定＝共用的 statementCurrencyLookup（見上；與 txCurrency 前兩步同一份判準），
 *   服務層接線時經 currencyOf 參數把 db 補位那一步也帶進來＝兩邊永遠同向；非 TWD 的帳戶
 *   整組 skip 並計入 stats.foreignRowsSkipped／foreignAccountsSkipped；**查無幣別＝比照台幣驗**
 *   （匯入端最後的 fallback 也是 TWD——會被當台幣記進帳本的列就要被驗到）。
 * @param {{accounts?:{masked:string, balance:number|null, currency?:string}[], accountCurrency?:Record<string,string>, transactions?:import('./bank-statement.js').BankTx[]}} parsed
 * @param {(masked:string)=>string} [currencyOf] 遮罩帳號→幣別（預設＝帳單自帶判準＋TWD fallback；
 *   服務層傳入含 db 補位的完整鏈＝與 txCurrency 同一條）
 * @returns {GateVerdict}
 */
export function reconcileBankStatement(parsed, currencyOf = (m) => statementCurrencyLookup(parsed, m) || 'TWD') {
  /** @type {GateProblem[]} */
  const problems = [];
  /** 這個遮罩帳號的列會不會被當台幣匯入（＝閘要不要驗它）。 @param {string} masked */
  const twdCheckable = (masked) => currencyOf(masked) === 'TWD';
  /** @type {Map<string, import('./bank-statement.js').BankTx[]>} */
  const byAcct = new Map();
  for (const tx of parsed?.transactions || []) {
    const key = tx.acctMasked || `x****${tx.acctSuffix || ''}`;
    const g = byAcct.get(key);
    if (g) g.push(tx); else byAcct.set(key, [tx]);
  }
  let pairsChecked = 0, pairsSkipped = 0, chainBroken = 0, foreignRowsSkipped = 0, twdAccounts = 0;
  // 每個受驗（台幣）帳戶各吃到幾道**擋下型**檢查（P1b-1 r1#1）：level 是**全檔**旗標——A 帳戶驗得動、
  // B 帳戶餘額全空時整份仍是 strong，B 的列等於零驗證搭便車。模板路線維持全檔語意（既有行為不動）；
  // AI 路線（★6）用 stats.twdAccountsUnverified 逐帳戶把關：有任何一個受驗帳戶一道擋下型都沒吃到＝拒收。
  /** @type {Map<string, number>} */
  const blockingByAcct = new Map();
  for (const [masked, list] of byAcct) {
    if (!twdCheckable(masked)) { foreignRowsSkipped += list.length; continue; }   // 外幣＝不入帳、不誤擋（見檔頭 P0.1）
    twdAccounts++;
    blockingByAcct.set(masked, 0);
    const suffix = masked.match(/(\d+)$/)?.[1] || masked;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      if (prev.balance == null || cur.balance == null) { pairsSkipped++; continue; }
      pairsChecked++;
      blockingByAcct.set(masked, (blockingByAcct.get(masked) || 0) + 1);
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
  let endChecked = 0, endBroken = 0, foreignAccountsSkipped = 0;
  for (const pa of parsed?.accounts || []) {
    if (pa.balance == null || !pa.masked) continue;
    // 外幣概要列 skip（P0.1）：多幣別帳戶同一個遮罩帳號有多列概要，明細末筆無從歸屬到幣別——
    // 實測同一末筆被拿去對 USD 與另一幣別兩個概要餘額、必有一個對不上＝合法帳單誤擋。
    if ((pa.currency && pa.currency !== 'TWD') || !twdCheckable(pa.masked)) { foreignAccountsSkipped++; continue; }
    // 定存概要列 skip（2026-08-18 定存分開列管）：定存本身沒有明細交易可對——同遮罩的**台幣**定存列
    // 若不跳過，會拿「活存明細的末筆餘額」去對「定存金額」＝必對不上＝合法帳單整份 400（測繪實指）。
    // 判準收窄到 kind==='time'（結構化的存款類別欄）。⚠️ **2026-08-18 起 AI 答案卷也有 kind**＝AI 路線
    // 的定存列同樣會走這條 skip（那正是本次要修的誤擋）；沒有 kind 的形狀（配方路線／舊 AI 答案）行為不變。
    if (/** @type {any} */ (pa).kind === 'time') continue;
    // 簽帳金融卡明細（Stage 1）skip：它的「帳戶餘額」就是明細最後一列抄來的——沒有獨立的
    // 概要區可對，硬對＝**拿同一個數字對自己、恆綠**，還把 blockingByAcct 的覆蓋計數灌水
    // （畫面會多說一句「期末與帳單概要吻合」的假話）。誠實 skip、餘額鏈照驗。
    if (/** @type {any} */ (pa).balanceFromDetail === true) continue;
    const list = byAcct.get(pa.masked);
    if (!list) continue;   // 概要有、明細沒有交易的帳戶＝沒得對（本期無往來，正常）
    // 只認**真正的末筆**（r1#2）：末筆餘額讀不到＝skip，不可回頭拿較早的餘額冒充
    // （較早餘額之後還有交易，對概要必然對不上＝把「缺數字」誤報成「不一致」）。
    const lastTx = list[list.length - 1];
    if (lastTx.balance == null) continue;
    endChecked++;
    blockingByAcct.set(pa.masked, (blockingByAcct.get(pa.masked) || 0) + 1);   // 末筆對概要也算該帳戶的擋下型覆蓋
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
    // firstRowsUnverified＝檔頭界線①的誠實計數：每個**受驗（台幣）**帳戶都有一筆「鏈驗不到」的首筆；
    // 外幣帳戶整組不驗＝已由 foreignRowsSkipped／foreignAccountsSkipped 誠實揭露（P0.1）。
    // twdAccountsUnverified＝一道擋下型都沒吃到的受驗帳戶數（P1b-1 r1#1）：AI 路線（★6）要求它為 0
    // 才放行——level 是全檔旗標、擋不住「B 帳戶餘額全空搭便車」；模板路線只誠實揭露、行為不變。
    stats: { pairsChecked, pairsSkipped, endChecked, firstRowsUnverified: twdAccounts, foreignRowsSkipped, foreignAccountsSkipped,
      twdAccountsUnverified: [...blockingByAcct.values()].filter((n) => n === 0).length },
  };
}

/**
 * 中閘：信用卡帳單。totals＝帳單摘要四格（台新郵寄版那一行自己印了整條等式：
 * 「上期應款總額 − (已繳款金額＋本期退款) ＋ 本期新增款項 ＝ 本期累計應繳金額」）。三道檢查，
 * **各自只在讀得到所需欄位時才跑**（缺格＝skip，不可拿「沒讀到」當「對不上」誤擋）：
 * ①（擋下）摘要等式自驗——四格都在才驗；銀行印的那行天生是平的，不平＝至少一格被**我們**讀錯。
 * ②（影子）**明細正項−退款** vs 本期新增款項。公式依 2026-08-11 四份真郵寄版校準（P0.2）：
 *   版面語意實測＝「本期新增款項」是**已扣退款的淨額**、退款不在已繳款桶——標籤寫「(已繳款金額＋
 *   本期退款)」但數字不含退款（四份、退款筆數各異，本公式全部精準吻合）。
 * ③（影子）**繳款列加總**（isPayment）vs 已繳款＋退款桶——同上校準。
 *   負數列缺旗標時用 desc 過 isCardPayment 重判（單一真相共用，r1#2）；連 desc 都沒有＝分不出
 *   繳款/退款＝②③兩道誠實 skip（不猜——猜成退款會讓真繳款把兩道一起誤鳴）。
 * ②③維持**影子不擋**（William 裁示 2026-08-11：先修公式、暫不升級成擋）——樣本全來自同一張卡的
 *   乾淨帳期，分期/年費/循環息月份還沒見過。⏰ **提醒絆線**：未來哪個月帳單出現那些項目、影子仍
 *   安靜＝樣本補齊，就提請 William 裁決升級為擋（兩處 advisories.push 改 problems＋考題同步，一起動）。
 * level 只數**擋下型**驗證：C1 有跑＝medium；只剩影子或全 skip＝weak（誠實：影子不是保護）。
 * @param {{transactions?:{amount:number, desc?:string, isPayment?:boolean, isRefund?:boolean}[], statementTotals?:CardTotals}} parsed
 * @returns {GateVerdict}
 */
export function reconcileCardStatement(parsed) {
  /** @type {GateProblem[]} */
  const problems = [];
  /** @type {GateProblem[]} */
  const advisories = [];
  const t = parsed?.statementTotals || { due: null, prevDue: null, paidAndRefund: null, newCharges: null };
  // AI 卡片路（批二）：帳單的應繳等式可含**不在明細區的具名調整列**（循環利息／違約金／年費／分期攤還…）
  // ——「上期應繳 −已繳/退款 ＋本期新增 ＋利息 ＋違約金 ＝ 本期應繳」是遠銀等版面的實際印法。
  // AI 答案卷把它們另抄成 aiAdjustments（fail-closed 驗收在 ai-parse-card.js），這裡摺進等式。
  // ⚠️ 模板路的 parsed 沒有這個欄 ⇒ adjSum=0 ⇒ **行為一個位元組都沒變**（有考題釘）。
  const adjSum = r2((Array.isArray(/** @type {any} */ (parsed)?.aiAdjustments) ? /** @type {any} */ (parsed).aiAdjustments : [])
    .reduce((/** @type {number} */ acc, /** @type {any} */ a) => acc + (Number(a?.amount) || 0), 0));
  let sumPos = 0, refundAbs = 0, payAbs = 0, unjudgeableNeg = 0;
  for (const tx of parsed?.transactions || []) {
    const a = Number(tx.amount) || 0;
    if (a > 0) { sumPos += a; continue; }
    // 負數列＝繳款或退款。優先信 finalize 的旗標；缺旗標用 desc 過 isCardPayment 重判（單一真相，
    // r1#2：猜成退款會讓真繳款把 C2′/C3′ 一起誤鳴）；連 desc 都沒有＝分不出＝計數、兩道影子 skip。
    const flagged = tx.isPayment !== undefined || tx.isRefund !== undefined;
    // 重判只吃**非空**說明（r2#2）：desc:'' 或純空白過 isCardPayment 必回 false＝被猜成退款，
    // 違反「無從判＝skip」的承諾；空的與缺席同待遇＝計入 unjudgeableNeg。
    const d = typeof tx.desc === 'string' ? tx.desc.trim() : '';
    const isPay = flagged ? !!tx.isPayment : (d ? isCardPayment(d) : null);
    if (isPay === null) { unjudgeableNeg++; continue; }
    if (isPay) payAbs += -a; else refundAbs += -a;
  }
  sumPos = r2(sumPos); refundAbs = r2(refundAbs); payAbs = r2(payAbs);

  /** @type {Record<string, CheckStatus>} */
  const checks = { equation: 'skip', newVsRows: 'skip', paidVsRows: 'skip' };
  if (t.due != null && t.prevDue != null && t.paidAndRefund != null && t.newCharges != null) {
    const computed = r2(t.prevDue - t.paidAndRefund + t.newCharges + adjSum);
    const diff = r2(computed - t.due);
    if (Math.abs(diff) > CARD_EPS) {
      checks.equation = 'fail';
      problems.push({
        code: 'card-equation',
        message: `帳單摘要自己的等式不平：上期應繳 ${fmt(t.prevDue)} − 已繳/退款 ${fmt(t.paidAndRefund)} `
          + `＋ 本期新增 ${fmt(t.newCharges)} ${adjSum ? `＋ 具名調整 ${fmt(adjSum)} ` : ''}＝ ${fmt(computed)}，但讀到的本期應繳是 ${fmt(t.due)}`
          + `（差 ${fmt(Math.abs(diff))}）——${adjSum ? '這些' : '四個'}數字至少有一個被讀錯`,
      });
    } else checks.equation = 'pass';
  }
  // ②③影子檢查（r1#1；公式＝P0.2 四份真郵寄版校準）：mismatch 進 advisories、不進 problems＝不擋。
  // 訊息把兩種可能都講（我們漏讀 or 版面例外），供預覽顯示與後續校準；升級為擋＝經 William 裁決後
  // 把下面**兩處** advisories.push 改 problems＋考題同步（一起動）。判不出繳款/退款的負數列存在時
  // ②③兩道都 skip（sums 不完整、比了只會亂鳴）。
  if (t.newCharges != null && unjudgeableNeg === 0) {
    const diff = r2((sumPos - refundAbs) - t.newCharges);
    if (Math.abs(diff) > CARD_EPS) {
      checks.newVsRows = 'mismatch';
      advisories.push({
        code: 'card-new-vs-rows',
        message: `明細的消費−退款＝${fmt(r2(sumPos - refundAbs))} 與帳單印的「本期新增款項」${fmt(t.newCharges)} 差 ${fmt(Math.abs(diff))}`
          + '——可能漏讀了消費/退款，也可能這份帳單有只列在摘要的分期/年費/利息（影子檢查、不擋，請回報數字幫忙校準）',
      });
    } else checks.newVsRows = 'pass';
  }
  if (t.paidAndRefund != null && unjudgeableNeg === 0) {
    const diff = r2(payAbs - t.paidAndRefund);
    if (Math.abs(diff) > CARD_EPS) {
      checks.paidVsRows = 'mismatch';
      advisories.push({
        code: 'card-paid-vs-rows',
        message: `明細的繳款列加總 ${fmt(payAbs)} 與帳單印的「已繳款＋退款」${fmt(t.paidAndRefund)} 差 ${fmt(Math.abs(diff))}`
          + '——可能漏讀了繳款列，也可能這份帳單把繳款只列在摘要（影子檢查、不擋，請回報數字幫忙校準）',
      });
    } else checks.paidVsRows = 'pass';
  }
  return {
    // level 只數擋下型驗證（C1）：影子檢查不是保護，不可讓它撐級別（誠實劃界②）
    level: checks.equation !== 'skip' ? 'medium' : 'weak',
    ok: problems.length === 0,
    problems, advisories, checks,
    stats: {
      sumPos, refundAbs, payAbs, unjudgeableNeg,
      // adjFolded（r2#2）：等式有沒有摺入具名調整——前端摘要句照它換寫法（模板路恆 0＝句子不變）。
      // 只帶總和給顯示層判斷，不帶各列明細（那些在 aiAdjustments 本體）。
      adjFolded: adjSum,
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
