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

/**
 * 對帳裁決 → 預覽窗頂部的一段白話說明。裁決缺席/形狀不對（舊快取/後端改版）＝回空字串、畫面不多長東西。
 * @param {{level?:string, advisories?:{message:string}[], stats?:Record<string, number>}|null|undefined} reconcile
 * @param {'bank'|'card'} kind
 * @returns {string}
 */
export function gateSummaryHtml(reconcile, kind) {
  if (!reconcile || typeof reconcile !== 'object' || !reconcile.level) return '';
  if (!(KNOWN_LEVELS[kind] || []).includes(reconcile.level)) return '';
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
      // r2#1：銀行預覽只顯示前 12 筆、確認後匯入的是**全部**非重複台幣明細——句子要照實講，
      // 不可讓使用者以為「沒顯示的就不會入帳」。
      main = '<b>△ 沒讀到足夠的餘額數字可驗算</b>：只做了基本結構檢查。確認後會匯入這次讀到的全部非重複台幣明細（下方僅預覽前 12 筆）——匯入前建議對帳單核對筆數與金額。';
    }
  } else {
    if (reconcile.level === 'medium') {
      main = '<b class="pos">✓ 帳單摘要驗算通過</b>：上期應繳 − 已繳款 ＋ 本期新增 ＝ 本期應繳，數字互相吻合。';
    } else {
      main = '<b>△ 沒讀到可交叉驗算的總額</b>（例如官網下載的 XLSX 就沒有印）：只會匯入下面讀到且勾選的明細，匯入前建議對帳單核對筆數與金額。';
    }
  }
  const adv = advisories.length
    ? `<ul class="muted" style="font-size:12px;margin:4px 0 0 18px;padding:0;line-height:1.7">`
      + advisories.map((a) => `<li>⚠ ${esc(String(a && a.message || ''))}</li>`).join('')
      + '</ul>'
    : '';
  return `<div class="gate-summary" style="margin-bottom:10px"><p class="muted" style="margin:0;font-size:12.5px">${main}</p>${adv}</div>`;
}
