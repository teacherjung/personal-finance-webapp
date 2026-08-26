// @ts-check
// AI 解析引擎（P1b-1，解析器通用化 §二「會計師」）：把「帳單抽出的文字」交給 AI，照固定答案卷
// （AI_BANK_SCHEMA）填成與模板解析器**同形狀**的 ParsedBankFull——下游（P1a 機構維度、對帳閘、
// 預覽、匯入）一行不改就接得上。
//
// 三條硬規矩（拍板依據見 docs/parser-generalization-plan.md）：
// 1. **答案不可信、逐欄驗收（normalizeAiBank fail-closed）**：AI 回的每一欄都過型別／日期／金額／
//    方向／長度／筆數牆，任何一欄壞＝整份丟 `ai_bad_answer`（寧可不吃）。驗收過了也只是「形狀對」，
//    **數字對不對由對帳閘裁決**（服務層接線，★6：AI 路線必須過強閘才准匯入）。
// 2. **供應商是接縫不是信仰（★3 拍板 2026-08-12＝Anthropic）**：本檔是**純模組（零外連能力）**——
//    答案卷 schema／提示詞／驗收器／文字組裝。真正打 API 的 fetch 住 lib/ai-transport.js（唯一外連檔、
//    入外連登記閘），由路由層組成 engineFactory 注入服務層；**本檔與服務層都拿不到 fetch**＝外連能力
//    不沿 import 閉包傳染到 crud.js 等動態路徑路由檔（hosted-auth 反向對帳閘的要求）。考題全走假引擎。
// 3. **機密流向**：鑰匙與帳單內文**絕不落 log**（本模組零 console；考題用 console spy 釘住）；
//    內文不進錯誤訊息（錯誤只帶分類 code 與白話說明）。
import { accountSuffixAny, normalizeMaskShape, makeCurrencyTable, MIXED_CURRENCY_MSG, canonMasked as canonMaskedShared } from './bank-statement.js';
import { isRealDate } from './schema.js';
import { RECIPE_FORMAT_VERSION, RECIPE_DATE_FORMATS, RECIPE_REFDATE_STRATEGIES, RECIPE_BALANCE_PICKS, RECIPE_ROW_IDENTS, RECIPE_LIMITS } from './parse-recipe.js';

const apiError = (/** @type {number} */ status, /** @type {string} */ msg, /** @type {string=} */ code) =>
  Object.assign(new Error(msg), { status, ...(code ? { code } : {}) });

/** 模型階梯（★3 拍板＝Anthropic；**裁示⑥ 2026-08-15**：解析預設 Sonnet、閘紅升 Opus 重試一次、
 * Haiku 退出解析路徑——帳單解析的錯是「安靜的錢錯」、省小錢冒大險不划算。階梯由服務層走，本模組單發。
 * 「寫配方一律用 Opus」的落點在 P2-3 配方生成（配方錯誤會被免費複製到未來每一期）。 */
export const AI_BANK_MODELS = { primary: 'claude-sonnet-5', escalation: 'claude-opus-5' };

/** 寫配方一律 Opus（裁示⑥ 2026-08-15）：配方錯誤會被免費複製到未來每一期——生成品質不省小錢。 */
export const RECIPE_MODEL = 'claude-opus-5';

/** 三讀仲裁模型（裁示⑦ 2026-08-16 拍板）：雙讀不一致時由 Fable 獨立解第三份——不看前兩份答案
 * （「送給 Fable 讀看看」的拍板語意、也避免錨定）。 */
export const AI_ARBITER_MODEL = 'claude-fable-5';

/** 雙讀開關判準（裁示⑦b＝預設開）：**只有明確 false 才關**——讀不到／壞型別＝開。
 * fail 的方向刻意與 aiAskBeforeSend 相反：那顆壞值→「當成要問」是少送、這顆壞值→「當成要雙讀」
 * 是多驗證（代價只是多一發費用，換到的是金額欄位的獨立核對）。
 * @param {any} settings */
export function dualReadWanted(settings) { return settings?.aiDualRead !== false; }

/** 遮罩帳號正規化（P2-4c，William 2026-08-17 核准「程式端帳號正規化」）：先過 `normalizeMaskShape`（只折全形＋X／圓點／
 * 全形星→半形星，與驗收同一把），再只留**英數字與 `*`**——剝 `-`、空格、全形分隔符；**字母保留**（`AB****5678` 與 `CD****5678`
 * 是兩顆戶，剝掉字母就「一致」了——Codex #504 r3#2）。⚠️ 「照抄」鐵則不動 AI（要它邊讀邊改寫＝多一步可出錯、也破壞接地
 * 的逐字對照）；格式統一全在程式端＝確定性、零費用。這支只用於**比對與身分判別**；持久化的形是 `normalizeMaskShape`
 * 改寫後的遮罩形（分隔符照 AI 抄的原樣留著）。 */
export const canonMasked = canonMaskedShared;   // 判準搬到 bank-statement.js（幣別表物件也要用它比身分）；這裡轉出＝既有呼叫端不動

/** 兩個遮罩帳號的身分判別（P2-4c「完整號碼認身分」；**Grok r0 升級＝比整串數字序列**——首版只比
 * 「第一顆星號前的前綴」，星號中段夾的數字差（900200*00* vs *99*）與「完全沒星號的完整號 vs 另一戶
 * 遮罩號」都會被放行）：
 * 'same'＝正規形相等（分隔符差異歸零、連「印法」提示都不列）；
 * 'variance'＝數字序列相等（星號長短/位置不同＝純印法）、或一串是另一串的**尾端**（少印前綴/只印
 *   末碼＝P1a「可見前綴兩邊都印得出來才否決」的同款相容判準）；
 * 'conflict'＝其餘＝數字對不上、且不是「少印」能解釋的＝不同戶（錢的歸屬、要觸發）。
 * ⚠️ 誠實殘餘（考題釘現況）：極短前綴巧合（「0****1234」的 0 恰是另一戶前綴尾）＝相容放行——
 * P1a 同款取捨，1~2 碼前綴的鑑別力本來就低。（字母剝掉的舊殘餘已收：字母是可見身分，X／圓點遮罩先統一成星號。） */
export function maskedCmp(/** @type {any} */ x, /** @type {any} */ y) {
  const cx = canonMasked(x), cy = canonMasked(y);
  if (cx === cy) return 'same';
  const dx = cx.replace(/[*]/g, ''), dy = cy.replace(/[*]/g, '');
  if (dx === dy) return 'variance';
  if (dx && dy && (dx.endsWith(dy) || dy.endsWith(dx))) return 'variance';
  return 'conflict';
}

/** 雙讀比對（裁示⑦；**P2-4b 校準＝William 2026-08-17 裁示「移出機構名＋備註」**——真帳單第一份
 * 就實測到：錢欄位兩讀全同、分歧全在文字欄的**寫法差異**（「台新銀行」vs 全名、備註措辭），照舊
 * 觸發仲裁＝白等 Fable 五分鐘再被 ai_disagree 擋＝不可用）。
 * **hard（觸發仲裁/擋下）**＝金額／方向／日期／餘額／帳號**末碼**／幣別／摘要（去重鍵主力、照舊
 * 空白不敏感）／現值參考日／帳戶幣別表／帳戶錢組成（**末碼＋幣別＋餘額**——帳號「印法」兩模型本來
 * 就會不同（含不含前綴、分隔符），末碼才是穩定身分；印法差異降到 textVariance）／交易筆數與順序。
 * **textVariance（建議面：不觸發、徽章 ✏️ 句顯示**實際中選模型**——一致路固定 Opus、仲裁/互證路可能是 Sonnet）**＝機構名／交易備註／帳號印法
 * （masked 全字）。⚠️ 備註仍進 bankRef 去重鍵——重複入帳的風險由「疑似重複提醒」層接住（裁示時
 * 明講的取捨）。diffs 與 textVariance 都**只帶欄位路徑、絕不帶欄值**（機密紀律，同 recipeReproduces）。
 * 帳戶 label／note 照舊完全不比。transactions 嚴格比順序。
 * @param {any} a @param {any} b
 * @returns {{agree: boolean, diffs: string[], textVariance: string[]}} */
export function aiAnswersAgree(a, b) {
  /** @type {string[]} */ const diffs = [];
  /** @type {string[]} */ const textVariance = [];
  const soft = (/** @type {any} */ x, /** @type {any} */ y) => x === y || (typeof x === 'string' && typeof y === 'string' && x.replace(/\s+/g, '') === y.replace(/\s+/g, ''));
  if (!soft(a?.bank, b?.bank)) textVariance.push('機構名');   // P2-4b：寫法差異不觸發（W 裁示）；空白差異連建議都不算（r1#1）
  if (a?.referenceDate !== b?.referenceDate) diffs.push('現值參考日');
  // ⚠️ 末碼碰撞＝退回嚴格鍵（Grok G1/G2/G3：兩帳戶**同末碼**時，只比末碼會讓幣別/餘額「歸屬對調」
  // 全綠——罕見情境寧嚴勿鬆；無碰撞的常見路照裁示走末碼身分、印法差異不誤觸發）。
  // r3#1：末碼一律走單一真相 accountSuffixAny()（寬版：先剝分隔符再用窄版取遮罩末碼、支援三碼末碼 900200****363→'363'；沒遮＝末四碼——另寫 slice(-4)
  // 會得 '*363'≠交易的 '363'＝碰撞漏偵測、三碼戶的歸屬對調靜默全綠）。
  const suf = (/** @type {any} */ k) => accountSuffixAny(canonMasked(k));   // P2-4c：末碼也從正規形取；寬版＝沒遮的完整帳號取末四碼
  const ca = a?.accountCurrency || {}, cb = b?.accountCurrency || {};
  const accsA = Array.isArray(a?.accounts) ? a.accounts : [], accsB = Array.isArray(b?.accounts) ? b.accounts : [];
  // r1#1（Codex）fail-closed：**單份答案內**同一身分（canon 相同）出現多個**不同的原字串**＝
  // 「同一帳號印兩種形、各掛各的錢」——正規化會把它們捏成可交換項（幣別/餘額對調照樣 agree），
  // 但下游（statementCurrencyLookup 等）仍按**原字串** exact-key 查表＝行為分歧。這種答案形不可
  // 唯一配對＝直接 hard 觸發（寧可仲裁/手動、不讓對調靜默採用）。
  const dupCanonIn = (/** @type {string[]} */ raws) => {
    /** @type {Map<string, Set<string>>} */ const m = new Map();
    for (const r of raws) { const c = canonMasked(r); const g = m.get(c); if (g) g.add(String(r)); else m.set(c, new Set([String(r)])); }
    return [...m.values()].some((g) => g.size > 1);
  };
  if (dupCanonIn(Object.keys(ca)) || dupCanonIn(Object.keys(cb))
    || dupCanonIn(accsA.map((/** @type {any} */ x) => String(x?.masked ?? ''))) || dupCanonIn(accsB.map((/** @type {any} */ x) => String(x?.masked ?? '')))) {
    if (!diffs.includes('帳戶帳號')) diffs.push('帳戶帳號');
  }
  // 碰撞＝**單份答案內**同末碼出現超過一次（跨份加總會把正常帳戶也算成碰撞——考題實抓）。
  const collideIn = (/** @type {string[]} */ keys) => {
    const c = new Map();
    for (const k of keys) c.set(k, (c.get(k) || 0) + 1);
    return [...c.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  };
  const collide = new Set([
    ...collideIn(Object.keys(ca).map(suf)), ...collideIn(Object.keys(cb).map(suf)),
    ...collideIn(accsA.map((/** @type {any} */ x) => String(x?.suffix ?? ''))), ...collideIn(accsB.map((/** @type {any} */ x) => String(x?.suffix ?? ''))),
  ]);
  const curKey = (/** @type {string} */ k, /** @type {string} */ v) => (collide.has(suf(k)) ? `${canonMasked(k)}\u0000${v}` : `${suf(k)}\u0000${v}`);
  const sa = Object.entries(ca).map(([k, v]) => curKey(k, /** @type {string} */ (v))).sort();
  const sb = Object.entries(cb).map(([k, v]) => curKey(k, /** @type {string} */ (v))).sort();
  if (sa.length !== sb.length || sa.some((k, i) => k !== sb[i])) diffs.push('帳戶幣別表');
  else {
    // P2-4c 完整號碼認身分：同末碼配對後 maskedCmp——conflict（兩邊前綴都印得出且對不上）＝不同戶＝hard
    const bySuf = (/** @type {string[]} */ keys) => { /** @type {Map<string,string[]>} */ const m = new Map(); for (const k of keys) { const s0 = suf(k); const g = m.get(s0); if (g) g.push(k); else m.set(s0, [k]); } return m; };
    const ma = bySuf(Object.keys(ca)), mb = bySuf(Object.keys(cb));
    for (const [s0, ksA] of ma) {
      const ksB = mb.get(s0) || [];
      if (ksA.length === 1 && ksB.length === 1) {
        const mc = maskedCmp(ksA[0], ksB[0]);
        if (mc === 'conflict') { if (!diffs.includes('帳戶帳號')) diffs.push('帳戶帳號'); }
        else if (mc === 'variance' && !textVariance.includes('帳號印法')) textVariance.push('帳號印法');
      }
    }
  }
  // kind 進 hard（2026-08-18）：它決定同遮罩的多列要不要各自成戶——一讀說 time 一讀說 demand，
  // 匯入結果會差一整筆錢（分開列管 vs 被當重複吃掉），這不是寫法差。
  const accMoney = (/** @type {any} */ x) => [collide.has(String(x?.suffix ?? '')) ? canonMasked(x?.masked) : '', x?.suffix, x?.currency, x?.balance, x?.kind || ''].join('\u0000');
  const A = accsA.map(accMoney).sort(), B = accsB.map(accMoney).sort();
  if (A.length !== B.length || A.some((k, i) => k !== B[i])) diffs.push('帳戶餘額組成');
  else {
    const listA = accsA.map((/** @type {any} */ x) => x?.masked), listB = accsB.map((/** @type {any} */ x) => x?.masked);
    const canA = listA.map(canonMasked).sort(), canB = listB.map(canonMasked).sort();
    if (JSON.stringify(canA) !== JSON.stringify(canB)) {
      // 同末碼配對逐一判別（無碰撞時每末碼各一戶）；conflict＝hard、其餘＝印法建議面
      const bySuf2 = (/** @type {any[]} */ xs) => { /** @type {Map<string,any[]>} */ const m = new Map(); for (const x of xs) { const s0 = String(x?.suffix ?? ''); const g = m.get(s0); if (g) g.push(x); else m.set(s0, [x]); } return m; };
      const ga = bySuf2(accsA), gb = bySuf2(accsB);
      // ⚠️ 誠實註記（R3b 模式；Grok #8 的「非 1v1 靜默吞」實測為**不可達**）：走進這個 else 的前提是
      // 錢組成 multiset 相等——而碰撞末碼的 money 鍵**含 canon masked**，同末碼多戶時 masked 不同
      // ⇒ money 鍵必不等 ⇒ 在上面就 hard 了；無碰撞＝每末碼各一戶＝必為 1v1。首版在此放了一條
      // fallback 建議行，刀 P65 證明它是死碼（殺不死）＝假防線，照「靜靜通過最危險」拆掉改記這段。
      let conflict = false, variance = false;
      for (const [s0, xsA] of ga) {
        const xsB = gb.get(s0) || [];
        if (xsA.length === 1 && xsB.length === 1) {
          const mc = maskedCmp(xsA[0]?.masked, xsB[0]?.masked);
          if (mc === 'conflict') conflict = true; else if (mc === 'variance') variance = true;
        }
      }
      if (conflict) { if (!diffs.includes('帳戶帳號')) diffs.push('帳戶帳號'); }
      else if (variance && !textVariance.includes('帳號印法')) textVariance.push('帳號印法');
    }
  }
  // 定存期間：**缺席≠矛盾**（一讀沒抄到期間＝資訊少了，不是兩份互相打架）——只有兩讀都抄到、
  // 而且抄得不一樣才算 hard（期間進 cdKey＝身分，抄錯會在下個月長出一個假的新定存帳戶）。
  const periodsBy = (/** @type {any[]} */ accs) => {
    /** @type {Map<string,string[]>} */ const m = new Map();
    for (const x of accs || []) {
      if (x?.kind !== 'time' || !x?.period) continue;
      const k = [collide.has(String(x?.suffix ?? '')) ? canonMasked(x?.masked) : '', x?.suffix, x?.currency, x?.balance].join('\u0000');   // 與 accMoney 同一把尺（Grok G6：同末碼不同戶的同額定存會被揉成一組＝憑空的 hard/建議）
      const g = m.get(k); if (g) g.push(String(x.period)); else m.set(k, [String(x.period)]);
    }
    for (const g of m.values()) g.sort();
    return m;
  };
  const pA = periodsBy(accsA), pB = periodsBy(accsB);
  const markPeriod = (/** @type {'hard'|'soft'} */ w) => {
    if (w === 'hard') { if (!diffs.includes('定存期間')) diffs.push('定存期間'); }
    else if (!textVariance.includes('定存期間')) textVariance.push('定存期間');
  };
  for (const [k, la] of pA) {
    const lb = pB.get(k);
    // ⚠️ 同值定存（William 的兩筆 51 美元）會落在**同一個鍵**上＝這裡拿到的是清單而非單值。
    //   長度不同＝一讀少抄了一段期間（**缺席**）；長度相同而內容不同才是兩份互相打架（**矛盾**）。
    //   把長度差當 hard＝同值定存只要一讀漏抄期間就憑空多一輪仲裁，正是這支要避免的事。
    if (!lb || la.length !== lb.length) { markPeriod('soft'); continue; }
    if (la.some((v, i) => v !== lb[i])) markPeriod('hard');
  }
  for (const k of pB.keys()) if (!pA.has(k)) markPeriod('soft');
  const ta = Array.isArray(a?.transactions) ? a.transactions : [], tb = Array.isArray(b?.transactions) ? b.transactions : [];
  if (ta.length !== tb.length) diffs.push('交易筆數');
  else ta.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
    const f = tb[i];
    for (const [name, label, softly] of /** @type {[string,string,boolean][]} */ ([
      ['date', '日期', false], ['direction', '方向', false], ['amount', '金額', false], ['balance', '餘額', false],
      ['acctSuffix', '帳號末碼', false], ['summary', '摘要', true],
    ])) {
      if (!(softly ? soft(e?.[name], f?.[name]) : e?.[name] === f?.[name])) diffs.push(`第 ${i + 1} 筆交易的${label}`);
    }
    const mc = maskedCmp(e?.acctMasked, f?.acctMasked);
    // P2-4c：碰撞＝正規形不等就 hard；無碰撞＝conflict（前綴都印得出且對不上）也 hard、variance＝建議面
    if (collide.has(String(e?.acctSuffix ?? '')) ? mc !== 'same' : mc === 'conflict') diffs.push(`第 ${i + 1} 筆交易的帳號`);
    else if (mc === 'variance') { if (!textVariance.includes('帳號印法')) textVariance.push('帳號印法'); }
    if (!soft(e?.note, f?.note)) textVariance.push(`第 ${i + 1} 筆交易的備註`);
  });
  return { agree: diffs.length === 0, diffs, textVariance };
}

/** 不一致欄位清單→白話短句（標紅落地＝錯誤訊息列**欄位**；值一律不回聲）。 */
/** 差異欄名的**封閉形狀**（Codex #485 r1#1：機密回歸護欄不能只靠一個未窮舉的情境題）：
 * 固定欄名、或「第 N 筆交易的X」且 **N 必須是受測交易的實際索引**（1..maxTx——「第 100 筆」在只有
 * 2 筆的帳單上＝有人把金額寫進了序號位）。aiAnswersAgree 新增路徑必須同步登記，否則出不了站。 */
const DIFF_NAME_FIXED = new Set(['機構名', '現值參考日', '帳戶帳號', '帳戶幣別表', '帳戶餘額組成', '交易筆數', '定存期間']);
const DIFF_NAME_TX = /^第 ([1-9][0-9]{0,3}) 筆交易的(日期|方向|金額|餘額|帳號末碼|摘要|帳號)$/;
/** 正式路的 fail-closed 過濾（機密優先於資訊完整：不合形＝整格丟掉，寧可少一句提示也不外洩）。
 * @param {string[]} diffs @param {number} maxTx @returns {string[]} */
export function sanitizeAiDiffs(diffs, maxTx) {
  return (Array.isArray(diffs) ? diffs : []).filter((x) => {
    if (typeof x !== 'string') return false;
    if (DIFF_NAME_FIXED.has(x)) return true;
    const m = DIFF_NAME_TX.exec(x);
    return !!m && Number(m[1]) <= maxTx;
  });
}

/** 定存期間正規化（2026-08-18）：兩讀對同一段期間可能寫成 `2026/01/15~2026/07/15`、`2026-1-15 至 2026-7-15`…
 * ——**不正規化就會變成新的仲裁來源**（寫法差≠讀錯）。統一成模板路線的形狀 `YYYY/MM/DD~YYYY/MM/DD`
 * （`lib/bank-statement.js` 的 padDate 同款），這樣 cdKey 在兩條路線上也對得起來。
 * 認不出兩個完整日期、日期不合真實日曆、或起日晚於迄日＝一律回空字串（fail-safe）。
 * @param {any} v @returns {string} */
export function canonPeriod(v) {
  const m = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})\D+?(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(v || ''));
  if (!m) return '';
  const d = (/** @type {string} */ y, /** @type {string} */ mo, /** @type {string} */ dd) => `${y}/${mo.padStart(2, '0')}/${dd.padStart(2, '0')}`;
  const a = d(m[1], m[2], m[3]), b = d(m[4], m[5], m[6]);
  // ⚠️ 外形對不代表是日期（Codex #488 r1#2）：`2026/13/45~2026/14/99` 兩段都「完整」，卻會變成一個
  //   永遠到不了期的假身分（迄日比不過任何參考日＝那顆定存永遠不歸零，下期真日期補上又裂成第二戶）。
  //   過真實日曆才收，否則整段回空字串（＝與「沒印期間」同一條 fail-safe 路）。
  if (!isRealDate(a.replace(/\//g, '-')) || !isRealDate(b.replace(/\//g, '-'))) return '';
  if (a > b) return '';   // 起日晚於迄日＝抄反了（Codex #488 r2#3）：收下它就會生出一個**永遠到不了期**的身分，
  //                          下期讀成正確順序時又是另一把鍵＝同一筆定存裂成兩戶。
  return `${a}~${b}`;
}

export function aiDiffSummary(/** @type {string[]} */ diffs) {
  const list = [...new Set(diffs)];
  return list.slice(0, 6).join('、') + (list.length > 6 ? `⋯等 ${list.length} 處` : '');
}

/** 筆數與長度牆（防 AI 幻覺灌爆 db；正常對帳單遠低於此）。 */
const LIMITS = { accounts: 200, transactions: 5000, shortStr: 80, longStr: 500, bank: 20, masked: 40 };

/** 固定答案卷（結構化輸出 schema）：欄位語意對齊 lib/bank-statement.js 的 ParsedBankFull。 */
export const AI_BANK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bank', 'referenceDate', 'accountCurrencies', 'accounts', 'totals', 'transactions'],
  properties: {
    bank: { type: 'string', description: '開戶機構短名（例：台新、國泰世華、玉山）；帳單上印的銀行名' },
    referenceDate: { type: ['string', 'null'], description: '帳戶餘額的現值參考日（餘額算到哪一天），西元 YYYY-MM-DD。'
      + '帳單沒印這個欄位、但有**唯一一個**明確標示為整份帳單期間的區間時，填該區間的結束日；'
      + '有多個區間、區間不是在講整份帳單、或無法確定它就是餘額截止日＝一律 null（寧可不填也不要填錯）' },
    accountCurrencies: {
      type: 'array',
      description: '概要區**每一個**帳戶的幣別身分——含餘額欄空白（透支/負餘額）的帳戶也要列。這張表是幣別的權威來源',
      items: {
        type: 'object', additionalProperties: false,
        required: ['masked', 'currency'],
        properties: {
          masked: { type: 'string', description: '遮罩帳號，照帳單原樣' },
          currency: { type: 'string', description: 'ISO 幣別碼（TWD/USD/JPY…）' },
        },
      },
    },
    accounts: {
      type: 'array',
      description: '概要區的帳戶清單（餘額欄空白的帳戶不要列）',
      items: {
        type: 'object', additionalProperties: false,
        required: ['masked', 'balance', 'currency', 'kind'],
        properties: {
          masked: { type: 'string', description: '遮罩帳號，照帳單原樣（如 900100****3301）' },
          balance: { type: 'number', description: '帳戶餘額；外幣帳戶填原幣金額、不要換算' },
          currency: { type: 'string', description: 'ISO 幣別碼（TWD/USD/JPY…）' },
          label: { type: 'string', description: '帳戶類別名（如 新臺幣活存）；沒有＝空字串' },
          note: { type: 'string', description: '備註（如 Richart）；沒有＝空字串' },
          // 定存欄（2026-08-18）：模板路線早有 kind/period，AI 路線沒有＝同一個遮罩下的多筆定存被當成
          // 重複、**靜靜少算一筆**（William 的兩筆 51 美元實例）。補這兩欄＝**分開列管**在 AI 路線也生效、
          // 且對帳閘的「定存概要列不對末筆」skip 認得出來。⚠️ **到期歸零刻意不含在內**——它只吃確定性
          // 解析（見 bank-import 的 deterministic 旗標）：AI 讀漏一列就會把還在的定存清成 0。
          kind: { type: 'string', enum: ['demand', 'time'], description: '存款類別：定期存款/定存/整存整付/零存整付＝time，其餘（活存、支存、綜存）＝demand' },
          period: { type: 'string', description: '定存的存續期間「起日~迄日」，如 2026/01/15~2026/07/15；不是定存或帳單沒印＝空字串' },
        },
      },
    },
    totals: {
      type: 'object', additionalProperties: false,
      description: '帳單自己印的合計欄（裁示⑧：給對帳閘交叉驗證、兼補「每帳戶第一筆驗不到」盲區）。'
        + '只抄帳單印的數字；帳單沒印該項＝null，**絕不自己加總**。'
        + '一律填正數（帳單把支出合計印成負號＝去號）。'
        + '帳單同時有台幣與外幣帳戶、而合計欄涵蓋範圍不明（整份？台幣段？）＝三欄一律填 null',
      required: ['txCount', 'totalOut', 'totalIn'],
      properties: {
        txCount: { type: ['number', 'null'], description: '帳單印的明細總筆數；沒印＝null' },
        totalOut: { type: ['number', 'null'], description: '帳單印的支出/轉出合計；沒印＝null' },
        totalIn: { type: ['number', 'null'], description: '帳單印的存入/轉入合計；沒印＝null' },
      },
    },
    transactions: {
      type: 'array',
      description: '明細區逐筆交易，照帳單順序',
      items: {
        type: 'object', additionalProperties: false,
        required: ['acctMasked', 'date', 'direction', 'amount', 'balance', 'summary', 'note'],
        properties: {
          acctMasked: { type: 'string', description: '這筆所屬帳戶的遮罩帳號，照帳單原樣' },
          date: { type: 'string', description: '交易日，西元 YYYY-MM-DD（民國年要換算）' },
          direction: { type: 'string', enum: ['in', 'out'], description: 'in＝存入、out＝支出' },
          amount: { type: 'number', description: '金額（正數、去千分位）' },
          balance: { type: ['number', 'null'], description: '這筆之後的帳戶餘額；帳單沒印＝null、不要用算的' },
          summary: { type: 'string', description: '摘要欄原文；沒有＝空字串' },
          note: { type: 'string', description: '備註欄原文；沒有＝空字串' },
        },
      },
    },
  },
};

/** 座標列 → 純文字（AI 的輸入）：每列 cells 依 x 排序後以空格相接。 @param {{y:number,cells:{x:number,s:string}[]}[]} lines */
export function linesToText(lines) {
  return (lines || [])
    .map((l) => [...(l.cells || [])].sort((a, b) => a.x - b.x).map((c) => c.s).join(' '))
    .join('\n');
}

/** 解析提示（system）：規則講死、不留發揮空間——照抄不臆測，讀不到就留 null/空。 */
export function buildBankSystem() {
  return [
    '你是銀行對帳單解析器。把使用者提供的對帳單文字，逐字照抄填進指定的 JSON 答案格式。',
    '規則：',
    '1. 只抄帳單上印的內容，絕不臆測或補算：某筆沒印餘額＝balance null（不要用前後筆推算）。',
    '1a. referenceDate（現值參考日＝**帳戶餘額**算到哪一天）：帳單若直接印「現值參考日」就照抄。'
      + '若沒印，**只有在帳單上找得到唯一一個、明確標示為整份帳單期間的區間**（例如「帳單期間 2026/01/01 ~ 2026/01/31」）時，'
      + '才填那個區間的**結束日**——期末餘額本來就是截至區間結束那天。'
      + '⚠️ 以下情況一律填 null，**不可挑一個**：帳單上有兩個以上的區間、'
      + '區間不是在講整份帳單（例如某個利率適用期間、某張卡的消費期間、某筆定存的存續期間）、'
      + '或你無法確定那個區間就是餘額的截止日。'
      + '⚠️ 也不可填開始日、不可填今天、不可自己推算或補一個沒印在帳單上的日期。'
      + '⚠️ **寧可回 null**：填錯會讓 app 拿這份帳單的餘額去蓋掉比較新的數字，而回 null 只是這次不更新餘額。',
    '2. 日期一律轉西元 YYYY-MM-DD（民國年＋1911）。金額去掉千分位逗號與貨幣符號，是數字。',
    '3. direction：存入/轉入/收入類＝in；支出/轉出/提領類＝out。以帳單的欄位歸屬（存入欄vs支出欄）為準。',
    '4. 遮罩帳號完全照帳單原樣抄（遮罩符號、位數都不可改寫；帳單沒有遮罩就照印完整帳號，不要自己加星號）。外幣帳戶餘額填原幣、不換算。',
    '5. bank 填帳單所屬機構的短名（帳單抬頭印的銀行名）。',
    '6. accountCurrencies 要列出概要區**每一個**帳戶的遮罩帳號與幣別——含餘額欄空白（透支/負餘額）的帳戶。⚠️ 同一個帳號同時掛多種幣別（外幣綜合帳戶）時，**每一種幣別各列一列，不可合併**（同下面定存那條的寫法）——合併成一列會讓概要的另一列對不上而整份被打回。',
    '7. accounts 只列「有印餘額」的帳戶（餘額欄空白的不要列，但它的幣別仍要出現在 accountCurrencies）。摘要/備註欄原文照抄（含機器味文字）。',
    '8. totals：帳單自己印的明細總筆數/支出合計/存入合計照抄；帳單沒印該項＝null，絕不自己加總或推算。一律填正數（印負號＝去號）。帳單同時有台幣與外幣、合計欄涵蓋範圍不明＝三欄一律填 null。',
    '9. kind：帳單上明確標示為定期存款/定存/整存整付/零存整付的帳戶填 time，其餘（活存、支票存款、綜合存款、外幣活存…）一律填 demand。'
      + '**看不出來就填 demand**（填錯成 time 會讓 app 用「期間」當帳戶身分）。',
    '10. period：kind=time 才填，內容是那筆定存印在帳單上的**存續期間**「起日~迄日」，格式 YYYY/MM/DD~YYYY/MM/DD（民國年一樣先轉西元）。'
      + '帳單沒印期間、或不是定存＝空字串。⚠️ 同一個帳號下有好幾筆定存時**每一筆各列一列**（金額相同也要各列一列，不可合併）——'
      + '合併會讓使用者少算一筆錢。⚠️ 這個期間**不可**拿去填 referenceDate（見規則 1a）。',
  ].join('\n');
}

/** 驗一個字串欄：型別、去頭尾空白、長度上限。 @param {any} v @param {string} field @param {number} max @param {boolean} [required] */
function str(v, field, max, required = false) {
  if (v == null && !required) return '';
  if (typeof v !== 'string') throw apiError(400, `AI 答案卷的 ${field} 不是文字`, 'ai_bad_answer');
  const s = v.trim();
  if (required && !s) throw apiError(400, `AI 答案卷的 ${field} 是空的`, 'ai_bad_answer');
  if (s.length > max) throw apiError(400, `AI 答案卷的 ${field} 超長（${s.length} 字）`, 'ai_bad_answer');
  return s;
}

/** 驗一個有限數字。 @param {any} v @param {string} field */
function num(v, field) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw apiError(400, `AI 答案卷的 ${field} 不是有效數字`, 'ai_bad_answer');
  return v;
}

/**
 * AI 答案卷 → ParsedBankFull（fail-closed 逐欄驗收；任何一欄壞＝整份 `ai_bad_answer`）。
 * 這裡只保證**形狀與型別**合法；**數字對不對交給對帳閘**（服務層接線）。
 * @param {any} raw AI 回的物件
 * @returns {{ bank:string, referenceDate:string|null, accounts:{suffix:string,masked:string,balance:number,currency:string,label:string,note:string}[], accountCurrency:Record<string,string>, transactions:import('./bank-statement.js').BankTx[], totals:{txCount:number|null, totalOut:number|null, totalIn:number|null} }}
 */
/** 帳號看不出末碼時給使用者的白話（不回聲帳號本身：AI 輸出可能夾帳單資料，r1#3 既有規矩）。
 * 整份先不匯入（一筆帳號認不出就硬匯＝那筆錢會掛錯帳戶，比不匯更糟）。 @param {string} which */
function unreadableAccountMsg(which) {
  return `AI 抄回來的${which}看不出末幾碼（帳單可能把帳號整個遮住、或是我們沒見過的印法），這份先不匯入——請把這種印法回報給我。`;
}

export function normalizeAiBank(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw apiError(400, 'AI 沒有交回答案卷（不是物件）', 'ai_bad_answer');
  const bank = str(raw.bank, 'bank', LIMITS.bank, true).replace(/\|/g, '');   // 分段符不可入段（同 bankRefBase）
  if (!bank) throw apiError(400, 'AI 答案卷的 bank 只剩非法字元', 'ai_bad_answer');
  let referenceDate = null;
  if (raw.referenceDate != null) {
    const d = str(raw.referenceDate, 'referenceDate', 10, true);
    if (!isRealDate(d)) throw apiError(400, 'AI 答案卷的現值參考日不是真日期', 'ai_bad_answer');   // 不回聲值（r1#3：AI 輸出可能夾帳單資料）
    referenceDate = d;
  }
  if (!Array.isArray(raw.accounts) || raw.accounts.length > LIMITS.accounts) throw apiError(400, 'AI 答案卷的 accounts 缺失或筆數異常', 'ai_bad_answer');
  if (!Array.isArray(raw.accountCurrencies) || raw.accountCurrencies.length > LIMITS.accounts) throw apiError(400, 'AI 答案卷的 accountCurrencies 缺失或筆數異常', 'ai_bad_answer');
  if (!Array.isArray(raw.transactions) || raw.transactions.length > LIMITS.transactions) throw apiError(400, 'AI 答案卷的 transactions 缺失或筆數異常', 'ai_bad_answer');
  // 幣別身分的權威來源＝accountCurrencies（r2#1：概要**所有**帳戶、含餘額空白的——模板解析器 2026-07-28
  // 同一課：parseBankSummary 對空白餘額帳戶「只記幣別、不進 accounts」，漏了它＝外幣交易查無幣別
  // fail-open 成 TWD、被當台幣入帳。accounts 只承載「有餘額可更新」的帳戶，不可兼任幣別表）。
  // 幣別表走**三條路共用的表物件**（哨兵規則／成員判準／混台外幣判定都住那裡＝單一實作）。
  const curTable = makeCurrencyTable();
  const accountCurrency = curTable.map;
  for (let i = 0; i < raw.accountCurrencies.length; i++) {
    const e = raw.accountCurrencies[i];
    const masked = normalizeMaskShape(str(e?.masked, `accountCurrencies[${i}].masked`, LIMITS.masked, true));   // 遮罩符號統一由程式做（AI 照原樣抄）
    if (!accountSuffixAny(masked)) throw apiError(400, unreadableAccountMsg(`帳戶幣別表第 ${i + 1} 個帳號`), 'ai_bad_answer');
    const currency = str(e?.currency, `accountCurrencies[${i}].currency`, 8, true).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw apiError(400, `AI 答案卷的 accountCurrencies[${i}].currency 不是三碼幣別`, 'ai_bad_answer');
    curTable.note(masked, currency);   // 同帳號多幣別＝哨兵（三條路同一份判準）
  }
  // ⚠️ **同一個帳號混了台幣與外幣＝拒收（不是哨兵）**（2026-08-26 預審抓到的 regression）：
  //   哨兵讓下游走「分不出＝不驗算、不入帳」，那對**純外幣同號**（JPY+USD）是安全的——那些列本來
  //   就不入帳。但只要其中一種是 TWD，同一份帳單會同時發生三件事：①該帳號整組豁免對帳閘
  //   （twdCheckable 看的是壓平值＝UNKNOWN）⇒ 壞掉的餘額鏈不再被擋 ②它的**台幣概要餘額照樣入帳**
  //   （applyBalancesToDb 判的是逐列的 pa.currency、不是這張表）⇒ ★6「AI 解的帳單要逐筆驗算才准入」
  //   被繞過 ③它的**真台幣明細列被當外幣丟掉**＝收支漏帳，畫面還把它們講成「外幣明細」。
  //   改版前這個形狀在驗收牆就整份拒收（吵，但安全）；放寬時**必須把這一格留在原地**，否則是拿
  //   loud 的拒收換 silent 的錢錯。逐筆幣別（批二）落地前，這個形狀我們是真的判不出來。
  // ⚠️ 專用碼 `ai_mixed_currency`，**不是**通用的 ai_bad_answer（Codex #517 r5#2）：通用碼會被
  //   單讀階梯當成「答案壞、換大模型再試」、被雙讀當成「這一讀無效、另一讀或仲裁可以頂上」——
  //   實測 Sonnet 誠實列出 TWD+USD 被拒、Opus 與 Fable 漏掉外幣區，於是 attested 過閘、匯入 2 筆。
  //   混幣是**版面事實**：一讀看到了就是有，別讀沒看到只是它漏了——**任一讀偵測到即終局**。
  curTable.finalize();   // 等價印法互看統一算一次（見 makeCurrencyTable）
  if (curTable.hasMixedTwd()) throw apiError(400, MIXED_CURRENCY_MSG, 'ai_mixed_currency');
  // ⚠️ 「**AI 有講才算數**」（2026-08-18）：只要有任何一列**帶了 kind 欄**，整份就當**結構化答案**、逐列帶
  //    kind/period；一列都沒有這個欄位＝退回舊形狀。**欄位在但型別／值不合法＝拒收整份**（r4#1）。
  //    ⚠️ 這條決定的是「這份答案帶不帶定存結構」（影響分開列管與對帳閘的定存 skip），**不是**防誤歸零的
  //    邊界——那道在 bank-import 的 `deterministic` 路由旗標（到期歸零只吃內建範本）。兩者曾被我寫成
  //    同一件事，#488 r1 證明那是錯的：kind 設成 schema 必填之後，每份 AI 答案都自稱結構化。
  // ⚠️ **缺席 ≠ 型別不合法**（Codex #488 r4#1）：判準是「**這個欄位在不在**」，不是「值長得像不像字串」。
  //   舊寫法用 `typeof === 'string'`，於是引擎回 `kind: 1` 時整份被當成舊答案形狀、**繞過下面的封閉列舉
  //   驗收**，兩筆同遮罩定存又被既有去重吃成一戶＝總額少一半。normalizeAiBank 的契約是「引擎答案不可信、
  //   一律 fail-closed」，欄位存在卻不合法必須拒收。
  const kindGiven = raw.accounts.some((/** @type {any} */ a) => a != null && Object.hasOwn(Object(a), 'kind'));
  const accounts = raw.accounts.map((/** @type {any} */ a, /** @type {number} */ i) => {
    const masked = normalizeMaskShape(str(a?.masked, `accounts[${i}].masked`, LIMITS.masked, true));
    const suffix = accountSuffixAny(masked);
    if (!suffix) throw apiError(400, unreadableAccountMsg(`第 ${i + 1} 個帳戶的帳號`), 'ai_bad_answer');
    const currency = str(a?.currency, `accounts[${i}].currency`, 8, true).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw apiError(400, `AI 答案卷的 accounts[${i}].currency 不是三碼幣別`, 'ai_bad_answer');
    // 一致性（fail-closed）：有餘額的帳戶也必須出現在權威幣別表、且幣別一致——內部矛盾＝壞答案
    // ⚠️ 判準是**成員**不是等值（2026-08-26）：外幣綜合帳戶的 accounts 會有兩列（各自原幣餘額）、
    //    masked 逐字相同——用等值比必然有一列對不上 ⇒ 整份拒收。守的東西一格沒放鬆：這一列的幣別
    //    仍然必須是**幣別表為這個帳號列過的**其中一種（沒列過＝壞答案，r2#1 的原意），
    //    也仍然必須出現在表裡（r3#1：查無幣別不可 fallback 成 TWD 靜靜入帳）。
    const listed = curTable.listed(masked);
    if (!listed) throw apiError(400, `AI 答案卷的 accounts[${i}] 不在 accountCurrencies 裡（幣別表要含概要所有帳戶）`, 'ai_bad_answer');
    if (!listed.has(currency)) throw apiError(400, `AI 答案卷的 accounts[${i}] 幣別與 accountCurrencies 矛盾`, 'ai_bad_answer');
    /** @type {any} */ let cd = {};
    if (kindGiven) {
      // ⚠️ 整份既然已自稱結構化（有別列帶了 kind），這裡就**不准有列漏填**（Grok 掃描 G5）：
      //   舊寫法把漏填的列補成 demand，而漏填的若正好是定存列＝它被當活存＝同遮罩分開列管失效＝
      //   **又回到少算一筆**。schema 已把 kind 設必填，但 normalizeAiBank 是最後一道、不靠上游的善意。
      const has = a != null && Object.hasOwn(Object(a), 'kind');
      if (!has) throw apiError(400, `AI 答案卷的 accounts[${i}] 少了 kind（同一份答案裡不可有的有、有的沒有）`, 'ai_bad_answer');
      if (typeof a.kind !== 'string') throw apiError(400, `AI 答案卷的 accounts[${i}].kind 型別不對（要字串 demand/time）`, 'ai_bad_answer');
      const k = String(a.kind).trim();
      if (k !== 'demand' && k !== 'time') throw apiError(400, `AI 答案卷的 accounts[${i}].kind 只能是 demand 或 time`, 'ai_bad_answer');
      // period 只對定存有意義；活存那格一律清空（AI 偶爾會把利率適用期間填進來）
      cd = { kind: k, period: k === 'time' ? canonPeriod(str(a?.period, `accounts[${i}].period`, LIMITS.shortStr)) : '' };
    }
    return { suffix, masked, balance: num(a?.balance, `accounts[${i}].balance`), currency,
      label: str(a?.label, `accounts[${i}].label`, LIMITS.shortStr), note: str(a?.note, `accounts[${i}].note`, LIMITS.shortStr), ...cd };
  });
  const transactions = raw.transactions.map((/** @type {any} */ t, /** @type {number} */ i) => {
    const acctMasked = normalizeMaskShape(str(t?.acctMasked, `transactions[${i}].acctMasked`, LIMITS.masked, true));
    const acctSuffix = accountSuffixAny(acctMasked);
    if (!acctSuffix) throw apiError(400, unreadableAccountMsg(`第 ${i + 1} 筆交易的帳號`), 'ai_bad_answer');
    // r3#1：交易帳號也必須在權威幣別表——AI 是不可信輸入，「提示詞叫它列概要所有帳戶」不可當成已成立的
    // 前提；整個帳戶連幣別表一起漏交＝下游查無幣別照樣 fallback 成 TWD 入帳（r3 實測 imported:5）。
    if (!curTable.listed(acctMasked)) throw apiError(400, `AI 答案卷的 transactions[${i}] 帳號不在 accountCurrencies 裡（每個交易帳號都要有幣別身分）`, 'ai_bad_answer');
    const date = str(t?.date, `transactions[${i}].date`, 10, true);
    if (!isRealDate(date)) throw apiError(400, `AI 答案卷的 transactions[${i}].date 不是真日期`, 'ai_bad_answer');   // 不回聲值（r1#3）
    const direction = t?.direction;
    if (direction !== 'in' && direction !== 'out') throw apiError(400, `AI 答案卷的 transactions[${i}].direction 不是 in/out`, 'ai_bad_answer');
    const amount = num(t?.amount, `transactions[${i}].amount`);
    if (amount < 0) throw apiError(400, `AI 答案卷的 transactions[${i}].amount 是負數（金額欄無正負、方向由 direction 表達）`, 'ai_bad_answer');
    const balance = t?.balance == null ? null : num(t.balance, `transactions[${i}].balance`);
    return { acctSuffix, acctMasked, date, direction: /** @type {'in'|'out'} */ (direction), amount, balance,
      summary: str(t?.summary, `transactions[${i}].summary`, LIMITS.shortStr), note: str(t?.note, `transactions[${i}].note`, LIMITS.longStr) };
  });
  // totals（裁示⑧）：null 容忍（帳單沒印＝誠實缺席）、有值必須是有限數字且非負
  /** @type {{txCount:number|null, totalOut:number|null, totalIn:number|null}} */
  const totals = { txCount: null, totalOut: null, totalIn: null };
  // 缺席＝拒（與 accounts/accountCurrencies 同口徑）：schema 列 required、結構化輸出必給——
  // 漏交必填欄位就是壞答案，不靜默降級成「全 null」（fail-closed 家規；三欄各自 null 仍合法＝帳單沒印）
  if (raw.totals == null) throw apiError(400, 'AI 答案卷缺 totals（帳單沒印合計＝三欄填 null，欄位本身不可缺席）', 'ai_bad_answer');
  {
    if (typeof raw.totals !== 'object' || Array.isArray(raw.totals)) throw apiError(400, 'AI 答案卷的 totals 不是物件', 'ai_bad_answer');
    for (const f of /** @type {const} */ (['txCount', 'totalOut', 'totalIn'])) {
      // r1#1：三欄逐欄必填（own-property）——物件在、單鍵缺席若靜默補 null，「必填」就只剩口號
      if (!Object.hasOwn(raw.totals, f)) throw apiError(400, `AI 答案卷的 totals 缺 ${f} 欄（帳單沒印＝該欄填 null，鍵本身不可缺席）`, 'ai_bad_answer');
      const v = raw.totals[f];
      if (v == null) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw apiError(400, `AI 答案卷的 totals.${f} 不是非負數字`, 'ai_bad_answer');
      totals[f] = v;
    }
  }
  return { bank, referenceDate, accounts, accountCurrency, transactions, totals };
}

/**
 * 接地檢查（裁示⑧a，抓「自洽錯」的主力、零 AI 成本）：答案卷裡的每一個**金額數字**都必須在
 * 帳單原文逐字找得到——AI 把一組數字抄錯得剛好互相吻合時，餘額鏈與合計都軋得平，
 * 但「帳單上根本沒印過這個數字」藏不住。
 * 範圍＝帳戶餘額、交易金額、交易餘額、totals 三欄（非 null 者）；日期刻意不查
 * （民國→西元轉換後字面必然不同）。比對法＝把原文所有「數字長相」token（去 $ 與千分位）
 * 收成數值集合，答案的每個數字必須在集合裡。訊息**不回聲數字**（機密紀律 r1#3）。
 * @param {ReturnType<typeof normalizeAiBank>} parsed
 * @param {string} text 送給 AI 的同一份帳單文字
 */
export function assertAiBankGrounded(parsed, text) {
  // 集合建法（預審 r0 補強）：①NFKC 正規化——台灣帳單常見全形數字/逗號（１，５００），
  // 不正規化＝整個版面每筆都「不接地」誤殺（AI 路線正是給未知版面的退路、首當其衝）
  // ②日期長相 token（2026-08-15、115/08/15）先剔除再掃＝減少「金額恰等於年月日」的誤接地
  // ③相鄰兩 token 只隔空白＝加收拼接值——抽字器把一個金額拆進兩個 cell（1,234,│567）時
  //   token 斷裂，配對拼接把它接回來；**只增不減**（原 token 仍在集合）＝方向是放寬不是收緊。
  // ⚠️ 已知殘洞（誠實記載、非窮盡）：遮罩帳號片段、獨立年份、拼接產生的噪音值仍會進集合，
  //   金額恰等於它們的臆測會誤接地——本檢查是防禦縱深（把 B 類自洽錯壓低），不是閘、不宣稱窮盡。
  const seen = new Set();
  const add = (/** @type {string} */ raw) => {
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(n)) { seen.add(n); seen.add(Math.abs(n)); }
  };
  const stripped = String(text || '').normalize('NFKC')
    .replace(/\d{4}-\d{1,2}-\d{1,2}|\d{2,4}\/\d{1,2}\/\d{1,2}/g, ' ');
  /** @type {{ tok: string, start: number, end: number }[]} */
  const toks = [];
  for (const m of stripped.matchAll(/-?[\d,]+(?:\.\d+)?/g)) {
    toks.push({ tok: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    add(m[0]);
  }
  for (let i = 0; i + 1 < toks.length; i++) {
    // 間隔限「同列空白」（不含換行）：拆 cell 只發生在同一列（linesToText 列間是 \n）——
    // 跨列拼接會讓「上列尾數字＋下列頭數字」變合法接地證據（r1 殘餘、順手關掉）
    if (/^[^\S\n]+$/.test(stripped.slice(toks[i].end, toks[i + 1].start))) add(toks[i].tok + toks[i + 1].tok);
  }
  const miss = (/** @type {string} */ where) =>
    apiError(400, `AI 答案卷的 ${where} 數字在帳單原文找不到（可能是 AI 臆測或抄錯，也可能是帳單印法特殊）`, 'ai_bad_answer');
  parsed.accounts.forEach((a, i) => { if (!seen.has(a.balance) && !seen.has(Math.abs(a.balance))) throw miss(`accounts[${i}].balance`); });
  parsed.transactions.forEach((t, i) => {
    if (!seen.has(t.amount)) throw miss(`transactions[${i}].amount`);
    if (t.balance != null && !seen.has(t.balance) && !seen.has(Math.abs(t.balance))) throw miss(`transactions[${i}].balance`);
  });
  for (const f of /** @type {const} */ (['txCount', 'totalOut', 'totalIn'])) {
    const v = parsed.totals?.[f];
    if (v != null && !seen.has(v)) throw miss(`totals.${f}`);
  }
}

// ============================== 配方生成（P2-3） ==============================

/** 配方答案卷（格式 A＝填格子）：AI 只能填、不能發明格子；枚舉欄只准從清單選；
 * 錨點/表頭一律「版面上印的字面文字」。formatVersion 由程式蓋、不入答案卷。
 * 深層把關不在這裡——出生三關（validateRecipeStrict＋against-statement＋reproduces）在存檔前。 */
export const RECIPE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['bank', 'docAnchors', 'dateFormat', 'refDate', 'summary', 'detail'],
  properties: {
    bank: { type: 'string', description: '銀行短名（帳單抬頭印的；同答案卷 bank 規則）' },
    docAnchors: { type: 'array', maxItems: RECIPE_LIMITS.docAnchors, items: { type: 'string' },
      description: '2–4 個「這份版面獨有」的字面標題文字（照版面逐字抄、不含數字），用來認出同版面' },
    dateFormat: { type: 'string', enum: [...RECIPE_DATE_FORMATS], description: '明細日期的印法' },
    refDate: {
      type: 'object', additionalProperties: false, required: ['strategy', 'anchor'],
      properties: {
        strategy: { type: 'string', enum: [...RECIPE_REFDATE_STRATEGIES] },
        anchor: { type: ['string', 'null'], description: '現值參考日旁邊印的字面標籤（strategy=none＝null）' },
      },
    },
    summary: {
      type: 'object', additionalProperties: false, required: ['sections', 'endAnchor', 'balancePick'],
      properties: {
        sections: { type: 'array', maxItems: RECIPE_LIMITS.sections,
          items: { type: 'object', additionalProperties: false, required: ['anchor', 'currency'],
            properties: { anchor: { type: 'string', description: '總覽區段標題的字面文字' },
              currency: { type: 'string', description: '三碼幣別（TWD…）或 BY-CODE（區段內按幣別碼列）' } } },
          description: '概要總覽的每一個區段' },
        endAnchor: { type: 'string', description: '總覽收尾列的字面文字（如 總計）' },
        balancePick: { type: 'string', enum: [...RECIPE_BALANCE_PICKS], description: '帳戶列有多個金額格時挑哪個當餘額' },
      },
    },
    detail: {
      type: 'object', additionalProperties: false,
      required: ['rowIdent', 'headerOut', 'headerIn', 'headerBalance', 'headerNote', 'headerIgnore'],
      properties: {
        rowIdent: { type: 'string', enum: [...RECIPE_ROW_IDENTS], description: '交易列的長相' },
        headerOut: { type: 'string', description: '支出/提領欄的表頭字面' },
        headerIn: { type: 'string', description: '存入欄的表頭字面' },
        headerBalance: { type: 'string', description: '餘額欄的表頭字面' },
        headerNote: { type: ['string', 'null'], description: '備註欄表頭；版面沒有＝null' },
        headerIgnore: { type: 'array', maxItems: RECIPE_LIMITS.headerIgnore, items: { type: 'string' },
          description: '金額區內要忽略的欄表頭（如 單號）；沒有＝空陣列' },
      },
    },
  },
};

/** 配方生成提示（system）：填格子、照抄字面、嚴禁交易內容。 */
export function buildRecipeSystem() {
  return [
    '你是銀行對帳單「版面規則卡」的填表員。根據使用者提供的對帳單文字，把版面結構填進固定格子。',
    '規則：',
    '1. 每一格只准照抄版面上印的**字面文字**（標題、表頭、標籤）；一個字都不可以改寫或翻譯。',
    '2. 枚舉欄位（dateFormat/strategy/balancePick/rowIdent/currency）只准從格子說明的清單選。',
    '3. **嚴禁任何交易內容**：金額、帳號、日期值、人名、店名、備註內文都不可以出現在任何格子裡。',
    '4. docAnchors 挑「這份版面獨有、每期都會印」的標題文字 2 到 4 個；不確定獨不獨有就挑版面自己的產品名稱。',
    '5. 版面沒有的欄位照格子說明填 null 或空陣列；不可以硬湊。',
  ].join('\n');
}

/**
 * 候選配方白名單化（零信任）：只搬 schema 內的鍵、蓋上 formatVersion——AI 多給的鍵一律丟棄。
 * 深層合法性交給出生三關（validateRecipeStrict 等），這裡不重複驗。
 * @param {any} raw @returns {object}
 */
export function pickRecipeCandidate(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    formatVersion: RECIPE_FORMAT_VERSION,
    bank: o.bank, docAnchors: o.docAnchors, dateFormat: o.dateFormat,
    refDate: o.refDate && typeof o.refDate === 'object'
      ? { strategy: o.refDate.strategy, anchor: o.refDate.anchor } : undefined,
    summary: o.summary && typeof o.summary === 'object'
      ? { sections: Array.isArray(o.summary.sections)
            ? o.summary.sections.map((/** @type {any} */ x) => ({ anchor: x?.anchor, currency: x?.currency }))
            : undefined,
          endAnchor: o.summary.endAnchor, balancePick: o.summary.balancePick } : undefined,
    detail: o.detail && typeof o.detail === 'object'
      ? { rowIdent: o.detail.rowIdent, headerOut: o.detail.headerOut, headerIn: o.detail.headerIn,
          headerBalance: o.detail.headerBalance,
          // 白名單只搬、不修補（r1#2）：headerNote null／headerIgnore [] 是**合法值**（W2/G4：丟鍵＝
          // 這類正常版面全滅；「null＝strict 紅」是誤讀探針的假宣稱、已撤回）；但**缺鍵與壞型別原樣
          // 交給 strict 擋**——白名單替 AI 補成 null/[] ＝ strict 從「整包驗」退化成「驗修好的」，
          // 出生月剛好沒備註/忽略欄時會靜默放行壞答案卷（Codex r1 實測）。
          ...('headerNote' in o.detail ? { headerNote: o.detail.headerNote } : {}),
          ...('headerIgnore' in o.detail ? { headerIgnore: o.detail.headerIgnore } : {}) }
      : undefined,
  };
}
