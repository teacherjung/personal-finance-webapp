// @ts-check
// 匯入預覽的「對帳驗算」就地說明（P0 前端子項，計畫 §四「閘級別跟著匯入預覽顯示」）。
// 純函式：吃後端預覽回應的 `reconcile` 裁決、回一段 HTML 字串；銀行（cashflow.js）與信用卡
// （transactions-import.js）共用同一份翻譯——兩頁講同一種話、改文案只改這裡。
// 白話鐵則：不用「強閘/中閘/弱閘」術語，句子直接講「驗了什麼、驗到什麼程度」；
// 能看到預覽＝這份帳單**沒有**「對不上」（對不上在後端就整份 400 擋下了，到不了這個畫面）。
// 影子提醒（advisories）＝後端算出來的白話句，原文列出、不擋匯入。
import { esc } from './html-escape.js';

/**
 * 對帳裁決 → 預覽窗頂部的一段白話說明。裁決缺席（舊快取/降級）＝回空字串、畫面不多長東西。
 * @param {{level?:string, advisories?:{message:string}[], stats?:Record<string, number>}|null|undefined} reconcile
 * @param {'bank'|'card'} kind
 * @returns {string}
 */
export function gateSummaryHtml(reconcile, kind) {
  if (!reconcile || typeof reconcile !== 'object' || !reconcile.level) return '';
  const s = reconcile.stats || {};
  const n = (/** @type {string} */ k) => Number(s[k]) || 0;
  const advisories = Array.isArray(reconcile.advisories) ? reconcile.advisories : [];
  let main;
  if (kind === 'bank') {
    if (reconcile.level === 'strong') {
      main = `<b class="pos">✓ 帳單數學驗算通過</b>：逐筆餘額 ${n('pairsChecked')} 關全部接上`
        + (n('endChecked') ? `、${n('endChecked')} 個帳戶期末與帳單概要吻合` : '')
        + (n('foreignRowsSkipped') ? `。外幣明細 ${n('foreignRowsSkipped')} 筆不驗算（也不會匯入）` : '')
        + '。';
    } else {
      main = '<b>△ 這份帳單沒有可驗算的餘額數字</b>：只做了基本結構檢查，匯入前建議抽幾筆自行核對。';
    }
  } else {
    if (reconcile.level === 'medium') {
      main = '<b class="pos">✓ 帳單摘要驗算通過</b>：上期應繳 − 已繳款 ＋ 本期新增 ＝ 本期應繳，數字互相吻合。';
    } else {
      main = '<b>△ 這份帳單沒印可交叉驗算的總額</b>（官網下載的 XLSX 都是這種）：金額仍會照帳單逐筆匯入。';
    }
  }
  const adv = advisories.length
    ? `<ul class="muted" style="font-size:12px;margin:4px 0 0 18px;padding:0;line-height:1.7">`
      + advisories.map((a) => `<li>⚠ ${esc(String(a && a.message || ''))}</li>`).join('')
      + '</ul>'
    : '';
  return `<div class="gate-summary" style="margin-bottom:10px"><p class="muted" style="margin:0;font-size:12.5px">${main}</p>${adv}</div>`;
}
