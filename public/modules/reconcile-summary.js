// @ts-check
// 匯入預覽的「對帳驗算」就地說明（P0 前端子項，計畫 §四「閘級別跟著匯入預覽顯示」）。
// 純函式：吃後端預覽回應的 `reconcile` 裁決、回一段 HTML 字串；銀行（cashflow.js）與信用卡
// （transactions-import.js）共用同一份翻譯——兩頁講同一種話、改文案只改這裡。
// 白話鐵則：不用「強閘/中閘/弱閘」術語，句子直接講「驗了什麼、驗到什麼程度」；
// 能看到預覽＝**沒有擋下型的不一致**（那種在後端就整份 400、到不了這個畫面）——
// 影子提醒（advisories）帶著 mismatch 到預覽是正常的：後端算好的白話句原文列出、不擋匯入。
// ⚠️ 弱級句不可把鍋甩給帳單（r1#1）：弱級＝「**沒讀到**足夠數字可驗算」——可能是帳單真沒印，
// 也可能是解析降級漏讀；句子只講我們讀到什麼，並提醒核對筆數與金額。
import { esc } from './html-escape.js';

/** 各畫面合法的裁決級別（r1#3）：不認得的 level＝形狀不對＝回空字串，不可誤套弱級句。 */
const KNOWN_LEVELS = { bank: ['strong', 'weak'], card: ['medium', 'weak'] };
/** 封閉查表的唯一讀法（鐵則 3.5「查表一律 hasOwn」；Codex #490 r2#1 抓到本檔三張表都沒守）：
 * `({...})['toString']` 撈到的是**原型上的函式**——`if (!x) return ''` 這種空值守衛對它完全無效，
 * 函式本體會被樣板字串直接印進畫面（實測：「合計交叉驗證這次沒有跑：function toString() {…}」）。
 * @param {Record<string, any>} table @param {any} key */
const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

/** 合計交叉驗證真的比對過的欄名 → 白話（後端只給封閉欄名＝零插值，見 lib/statement-reconcile.js）。 */
const TOTALS_FIELD_TEXT = Object.freeze({ txCount: '筆數', totalOut: '支出合計', totalIn: '存入合計' });
/** 沒跑起來的原因 → 白話（鍵＝後端 TOTALS_CHECK 的封閉狀態碼；互扣考題釘住「每個碼都有句子」）。 */
const TOTALS_SKIP_TEXT = Object.freeze({
  'mixed-currency': '這份帳單同時有台幣與外幣，而合計欄涵蓋哪一段（整份？還是台幣那段？）機械上判不出來——硬比會把正確的答案誤擋，所以整道跳過',
  'not-printed': '這次沒讀到帳單的明細合計（帳單沒印、或 AI 沒讀出來都算），沒有數字可以對',
  'no-totals': '這次讀這份帳單的方式沒有讀出合計欄',
});

/**
 * 合計交叉驗證的**這一份**實際狀態（2026-08-19；William 指出混幣時這道整個關掉、畫面卻說它擋得住＝轉述）。
 * ⚠️ 這句話的存在理由＝**不讓畫面說謊**：沒跑就要明講沒跑、並講出「少了它看不到什麼」——
 * 說明區列的「要比到哪一欄才擋得住」是**機制**，這裡講的是**這一份到底比到了什麼**。
 * 裁決沒帶這個欄（模板路線＝這道檢查本來就不存在）／狀態碼不認得（新後端配舊前端）＝回空字串。
 * @param {{status?:string, fields?:string[]}|null|undefined} tc
 * @returns {string}
 */
export function totalsCheckSentence(tc) {
  if (!tc || typeof tc !== 'object') return '';
  const status = String(tc.status || '');
  if (status === 'pass') {
    const seen = (Array.isArray(tc.fields) ? tc.fields : []).map((f) => String(f))
      .filter((f) => own(TOTALS_FIELD_TEXT, f));
    const names = seen.map((f) => own(TOTALS_FIELD_TEXT, f));
    // fields 空的 pass＝形狀不對（後端會給 not-printed）＝不編造「都對得上」
    if (!names.length) return '';
    // ⚠️ **「有跑」不等於「這幾型都罩到了」**（2026-08-19 複審後掃抓到；實測：首筆 in→out
    //    對調後筆數 3→3 一模一樣、而支出合計 500→1500 當場不符）：帳單只印明細總筆數時，
    //    這道只比得到筆數——「第一筆方向讀反」改不動筆數，於是它仍然沒有第二道把關。
    //    不講＝使用者照徽章的指路看到「有跑」，就以為方向也有人看＝這支要消滅的同一種假話。
    // ⚠️ **這句話能保證的只有「兩邊對得上」**（William 2026-08-19 裁範圍：收回誇大句、不再加註——
    //    這一族連三輪被審查者中刀，每中一刀就多掛一句但書，會把畫面堆到沒人看）：
    //    比的是「AI 抄回來的合計」與「AI 自己逐筆算出來的」，**兩邊都出自同一份 AI 答案**——
    //    抄漏、抄多、方向對調這類會讓兩邊對不上的錯擋得住；**整組一起抄成自洽的另一套數字擋不住**
    //    （Codex #490 r5 用正式管線實測：筆數/支出/收入 3/300/800 全部改成自洽的 4/350/850，
    //    只要錯值也印在帳單別處，強閘＋接地＋合計全部通過）。所以**不寫「只擋得住會改動這幾欄的錯」**
    //    ——那句話把「兩邊自洽」講成了「數字正確」。
    //    ⚠️ 誠實殘餘（只記在這裡與考題，刻意不進畫面）：①金額 0 或**不大於容差 BAL_EPS**（0.005）的列
    //    方向對調，兩側合計都不動＝比到出入合計也看不到（那種列不影響金額，取捨照實記）②「沒讀到某欄」
    //    不等於「帳單沒印」——管線只知道 AI 沒交回來，所以句子一律說「這次沒讀到」。
    const missing = Object.keys(TOTALS_FIELD_TEXT).filter((f) => !seen.includes(f))
      .map((f) => own(TOTALS_FIELD_TEXT, f));
    const sums = seen.includes('totalOut') || seen.includes('totalIn');
    return `合計交叉驗證：AI 抄回來的${names.join('、')}與它自己逐筆算出來的對得上`
      + (missing.length ? `（這次沒讀到${missing.join('、')}）` : '')
      + '。這一道比的是這兩邊，擋得住抄漏、抄多、方向對調這種<b>兩邊對不上</b>的錯，'
      + '<b>擋不住整組一起抄錯</b>。'
      + (sums ? '' : '⚠️ 而且這次沒比到出入合計——<b>方向對調不會改變筆數</b>，'
        + '「每個帳戶第一筆的方向讀反」這一型仍然沒有第二道把關，請自己核對收支方向。');
  }
  const why = own(TOTALS_SKIP_TEXT, status);
  if (!why) return '';
  // ⚠️ 這裡只列**真的只靠合計擋得住**的那幾型（徽章盲點清單的①⑥⑦）——非首筆的方向讀反／漏掉會讓
  //    餘額鏈當場接不上，把它們也算進來＝反過來誇大損失（誇大與遮掩同罪）。
  return `⚠️ 合計交叉驗證這次<b>沒有跑</b>：${why}。`
    + '少了這一道，<b>每個帳戶第一筆的方向讀反或整筆漏掉</b>、<b>整個帳戶被漏讀</b>、'
    + '<b>一筆收入和一筆支出被併成淨額</b>這幾種就沒有第二道把關（其餘的錯餘額鏈仍會接不上）'
    + '——請自己對帳單核對筆數與金額。';
}

/** 合計交叉驗證那一句的 HTML（句子本身在 totalsCheckSentence；沒話講＝不長東西）。
 * ⚠️ 句子是**這個模組自己的字面**（後端只給封閉代碼），所以 `<b>` 是我們自己寫的、不是外來字串——
 * 不經 esc（esc 會把它變成畫面上的角括號）；外來字串一律仍走 esc（advisory 那條路）。
 * @param {any} tc */
function totalsCheckHtml(tc) {
  const line = totalsCheckSentence(tc);
  return line ? `<p class="muted" style="margin:4px 0 0;font-size:12px">${line}</p>` : '';
}

/**
 * 對帳裁決 → 預覽窗頂部的一段白話說明。裁決缺席/形狀不對（舊快取/後端改版）＝回空字串、畫面不多長東西。
 * @param {{level?:string, advisories?:{message:string}[], stats?:Record<string, number>, totalsCheck?:{status?:string, fields?:string[]}}|null|undefined} reconcile
 * @param {'bank'|'card'} kind
 * @returns {string}
 */
export function gateSummaryHtml(reconcile, kind) {
  if (!reconcile || typeof reconcile !== 'object' || !reconcile.level) return '';
  if (!(own(KNOWN_LEVELS, kind) || []).includes(reconcile.level)) return '';   // kind='toString' 撈到函式＝.includes 直接 TypeError 炸掉畫面
  const s = reconcile.stats || {};
  const n = (/** @type {string} */ k) => Number(s[k]) || 0;
  const advisories = Array.isArray(reconcile.advisories) ? reconcile.advisories : [];
  let main;
  if (kind === 'bank') {
    if (reconcile.level === 'strong') {
      // 驗到哪關講哪關（r1#2）：pairsChecked 為 0 時不可寫「逐筆餘額 0 關全部接上」
      const parts = [];
      if (n('pairsChecked')) parts.push(`逐筆餘額 ${n('pairsChecked')} 關全部接上`);
      if (n('endChecked')) parts.push(`${n('endChecked')} 個帳戶期末與帳單概要吻合`);
      // stats 全缺（防禦：後端形狀變動）＝只講結論、不掛空冒號
      main = `<b class="pos">✓ 帳單數學驗算通過</b>${parts.length ? '：' + parts.join('、') : ''}`
        + (n('foreignRowsSkipped') ? `。外幣明細 ${n('foreignRowsSkipped')} 筆不驗算（也不會匯入）` : '')
        + '。';
    } else {
      // r2#1：預覽是抽樣時，不可讓使用者把「未顯示」誤解成「不匯入」——句子要講匯入的真實範圍。
      main = '<b>△ 沒讀到足夠的餘額數字可驗算</b>：只做了基本結構檢查。確認後會匯入這次讀到的全部非重複台幣明細（下方僅預覽前 12 筆）——匯入前建議對帳單核對筆數與金額。';
    }
  } else {
    if (reconcile.level === 'medium') {
      main = '<b class="pos">✓ 帳單摘要驗算通過</b>：上期應繳 − 已繳款 ＋ 本期新增 ＝ 本期應繳，數字互相吻合。';
    } else {
      main = '<b>△ 沒讀到可交叉驗算的總額</b>（例如官網下載的 XLSX 就沒有印）：只會匯入下面讀到且勾選的明細，匯入前建議對帳單核對筆數與金額。';
    }
  }
  // 合計交叉驗證的實況（只有 AI／配方路線的裁決帶得出來；模板路線沒有這道＝不長東西）
  const totals = totalsCheckHtml(/** @type {any} */ (reconcile).totalsCheck);
  const adv = advisories.length
    ? `<ul class="muted" style="font-size:12px;margin:4px 0 0 18px;padding:0;line-height:1.7">`
      + advisories.map((a) => `<li>⚠ ${esc(String(a && a.message || ''))}</li>`).join('')
      + '</ul>'
    : '';
  return `<div class="gate-summary" style="margin-bottom:10px"><p class="muted" style="margin:0;font-size:12.5px">${main}</p>${totals}${adv}</div>`;
}
