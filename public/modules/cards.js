// @ts-check
import { api, view, byId, wan, money, esc, daysUntil, openForm, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { icon } from './icons.js';

const NETWORKS = ['VISA', 'Mastercard', 'JCB', '銀聯', '美國運通', '—'];
const TYPE_LABEL = { credit: '信用卡', membership: '會員卡', debit: '簽帳金融卡' };
// 簽帳金融卡（Stage 5b）：刷卡直接從存款帳戶扣，**沒有結帳日、繳款日、年費**；它存在的理由是讓金融卡帳單的
// 「刷卡消費明細」有一本自己的消費帳本（跟信用卡一樣做分類分析），銀行匯入時會自動建一張。

// 卡片效期只記年/月（卡面 MM/YY），有效到該月「月底」——倒數與停用判斷都以月底計。
// 兼容舊資料的完整日期（YYYY-MM-DD 原樣沿用）。
const expiryEnd = (e) => /^\d{4}-\d{2}$/.test(e || '')
  ? `${e}-${String(new Date(Number(e.slice(0, 4)), Number(e.slice(5, 7)), 0).getDate()).padStart(2, '0')}`
  : e;

function cardSummary(list) {
  const credit = list.filter(c => (c.type || 'credit') === 'credit');
  const member = list.filter(c => c.type === 'membership');
  const debit = list.filter(c => c.type === 'debit');
  return {
    credit,
    member,
    debit,
    annualFees: credit.reduce((sum, c) => sum + Number(c.annualFee || 0), 0),
    expiringSoon: list.filter(c => {
      const days = daysUntil(expiryEnd(c.expiry));
      return days >= 0 && days <= 30;
    }).length,
  };
}

function expiryMeta(expiry) {
  const month = (expiry || '').slice(0, 7);
  if (!month) return { text: '未設定效期', tone: 'neutral' };
  const days = daysUntil(expiryEnd(expiry));
  if (days < 0) return { text: '已到期', tone: 'danger' };
  if (days <= 60) return { text: `${days} 天後到期`, tone: 'warning' };
  return { text: `有效至 ${month}`, tone: 'neutral' };
}

function cardNoticeHtml(message) {
  if (!message) return '';
  return `<div class="card-tracker-notice" role="status" aria-live="polite">
    <span>${icon('check', 17)}</span><strong>${esc(message)}</strong>
  </div>`;
}

function cardsLoadingHtml() {
  return `<div class="cards-page">
    <div class="page-head cards-page-head">
      <div><h1>卡片追蹤</h1><p>集中管理信用卡、會員卡、結帳繳款日、年費與到期狀態。</p></div>
    </div>
    <section class="card-tracker-state card-tracker-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="card-state-icon">${icon('card', 27)}</span>
      <div><span>正在整理</span><h2>正在讀取卡片資料</h2><p>只會讀取卡片清單，不會修改任何資料。</p></div>
    </section>
  </div>`;
}

function cardsLoadErrorHtml(message) {
  return `<div class="cards-page">
    <div class="page-head cards-page-head">
      <div><h1>卡片追蹤</h1><p>集中管理信用卡、會員卡、結帳繳款日、年費與到期狀態。</p></div>
    </div>
    <section class="card-tracker-state card-tracker-error" role="alert" aria-labelledby="cardsErrorTitle">
      <span class="card-state-icon">${icon('alert', 28)}</span>
      <div class="card-state-copy">
        <span>載入未完成</span>
        <h2 id="cardsErrorTitle">卡片資料暫時載入失敗</h2>
        <p>這次只讀取失敗，沒有新增、刪除或修改任何卡片。可以直接重新載入。</p>
      </div>
      <button class="btn-ghost" id="retryCards">${icon('refresh', 16)}重新載入</button>
      <details><summary>查看錯誤訊息</summary><code>${esc(message || '無法連線')}</code></details>
    </section>
  </div>`;
}

let cardNotice = '';

function rerenderCardsAfterSave(seq, message) {
  if (seq !== currentRouteSeq()) return;
  cardNotice = message;
  return renderCards();
}

export async function renderCards() {
  const seq = currentRouteSeq();
  const notice = cardNotice;
  cardNotice = '';
  view().innerHTML = cardsLoadingHtml();
  let list;
  try {
    list = await api('/cards');
  } catch (error) {
    if (seq !== currentRouteSeq()) return;
    view().innerHTML = cardsLoadErrorHtml(error instanceof Error ? error.message : '無法連線');
    byId('retryCards').onclick = () => renderCards();
    return;
  }
  if (seq !== currentRouteSeq()) return;   // fetch 期間切走了頁（Codex r10#6 idiom；r11#2 補上漏掉的兩頁）——寫 DOM 前必守，router 的事後檢查救不了 renderer 內部的寫入
  const summary = cardSummary(list);

  view().innerHTML = `
    <div class="cards-page">
      <div class="page-head cards-page-head">
        <div><h1>卡片追蹤</h1><p>集中管理信用卡、會員卡、結帳繳款日、年費與到期狀態。</p></div>
        <div class="page-actions"><button class="btn" id="addCard">${icon('plus', 16)}新增卡片</button></div>
      </div>

      ${cardNoticeHtml(notice)}

      <section class="card-tracker-summary" aria-label="卡片摘要">
        <div class="card-summary-item"><span>全部卡片</span><strong>${list.length} 張</strong></div>
        <div class="card-summary-item"><span>信用卡</span><strong>${summary.credit.length} 張</strong></div>
        <div class="card-summary-item"><span>信用卡年費合計</span><strong>${wan(summary.annualFees)}</strong></div>
        <div class="card-summary-item"><span>30 天內到期</span><strong>${summary.expiringSoon} 張</strong></div>
      </section>

      <div class="card-privacy-note">
        <span class="card-privacy-icon">${icon('shield', 17)}</span>
        <div><strong>卡號只顯示末四碼</strong><p>帳單密碼不會回填到頁面；需要更新時再於編輯表單輸入。</p></div>
      </div>

      ${cardSection('信用卡', '帳務與繳款', summary.credit, 'credit')}
      ${cardSection('簽帳金融卡', '直接扣帳戶，只記消費', summary.debit, 'debit')}
      ${cardSection('會員卡', '會籍與權益', summary.member, 'membership')}
    </div>
  `;

  byId('addCard').onclick = () => openCardForm();
  view().querySelectorAll('[data-add-type]').forEach(b => b.onclick = () => openCardForm(null, { defaultType: b.dataset.addType }));
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openCardForm(list.find(c => c.id === b.dataset.edit)));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const c = list.find(x => x.id === b.dataset.del);
    confirmDelete(c.name, async () => {
      await api('/cards/' + c.id, { method: 'DELETE' });
      cardNotice = '卡片已刪除';
    });
  });
}

function cardSection(title, eyebrow, list, type) {
  const emptyText = type === 'credit' ? '尚無信用卡' : type === 'debit' ? '尚無簽帳金融卡' : '尚無會員卡';
  const emptyGuide = type === 'credit'
    ? '新增後可一起查看結帳日、繳款日、年費與效期。'
    : type === 'debit'
      ? '上傳金融卡帳單時會自動建立；刷卡消費明細會記到它的消費帳本做分類分析。'
      : '新增後可記錄會員編號、等級、權益與效期。';
  return `<section class="card-tracker-section">
    <div class="card-tracker-section-head">
      <div><span>${eyebrow}</span><h2>${title}</h2></div>
      <p>${list.length} 張</p>
    </div>
    ${list.length
      ? `<div class="card-tracker-grid">${list.map(cardPanel).join('')}</div>`
      : `<div class="card-tracker-empty">
        <span>${icon('card', 22)}</span>
        <div><strong>${emptyText}</strong><p>${emptyGuide}</p></div>
        <button class="btn" data-add-type="${type}">${icon('plus', 16)}新增${emptyText.slice(2)}</button>
      </div>`}
  </section>`;
}

function cardPanel(c) {
  const credit = (c.type || 'credit') === 'credit';
  const debit = c.type === 'debit';
  const expiry = expiryMeta(c.expiry);
  const dueLabel = c.dueDay
    ? `${Number(c.statementDay) && Number(c.dueDay) < Number(c.statementDay) ? '次月' : '每月'} ${c.dueDay} 日`
    : '未設定';
  const facts = credit ? [
    ['末四碼', c.lastFour ? `•••• ${c.lastFour}` : '未設定'],
    ['卡片組織', c.network || '未設定'],
    ['年費', c.annualFee === '' || c.annualFee == null ? '未設定' : money(c.annualFee)],
  ] : debit ? [
    ['末四碼', c.lastFour ? `•••• ${c.lastFour}` : '未設定'],
    ['發卡銀行', c.issuer || '未設定'],
    ['卡片組織', c.network && c.network !== '—' ? c.network : '未設定'],
  ] : [
    ['會員編號', c.memberId || '未設定'],
    ['會員等級', c.level || '未設定'],
    ['發卡機構', c.issuer || '未設定'],
  ];
  return `<article class="card-tracker-item">
    <div class="card-tracker-item-head">
      <div class="card-tracker-identity">
        <span class="card-tracker-mark">${icon('card', 18)}</span>
        <div><h3>${esc(c.name)}</h3><p>${esc(c.issuer || (credit ? '發卡銀行未設定' : '發卡機構未設定'))}</p></div>
      </div>
      <span class="card-type-tag ${credit ? 'credit' : debit ? 'debit' : 'membership'}">${TYPE_LABEL[c.type || 'credit'] || '信用卡'}</span>
    </div>

    ${credit ? `<div class="card-schedule" aria-label="結帳與繳款日">
      <div><span>結帳日</span><strong>${c.statementDay ? `每月 ${esc(c.statementDay)} 日` : '未設定'}</strong></div>
      <div><span>繳款日</span><strong>${esc(dueLabel)}</strong></div>
    </div>` : ''}

    <div class="card-facts">
      ${facts.map(([label, value]) => `<div><span>${label}</span><strong>${esc(value)}</strong></div>`).join('')}
    </div>

    <div class="card-expiry-row">
      <span class="card-expiry-tag ${expiry.tone}">${icon('history', 14)}${esc(expiry.text)}</span>
    </div>

    ${c.benefits ? `<div class="card-benefits"><span>主要權益</span><p>${esc(c.benefits)}</p></div>` : ''}
    ${c.note ? `<p class="card-note">${esc(c.note)}</p>` : ''}
    <div class="card-tracker-actions">
      <button class="btn-link btn-sm" data-edit="${esc(c.id)}" title="編輯" aria-label="編輯 ${esc(c.name)}">${icon('edit', 15)}</button>
      <button class="btn-danger btn-sm" data-del="${esc(c.id)}" title="刪除" aria-label="刪除 ${esc(c.name)}">${icon('trash', 15)}</button>
    </div>
  </article>`;
}

function openCardForm(c, { defaultType = 'credit' } = {}) {
  const seq = currentRouteSeq();
  openForm({
    title: c ? '編輯卡片' : '新增卡片',
    fields: [
      { key: 'type', label: '卡片類型', type: 'select', options: [{ value: 'credit', label: '信用卡' }, { value: 'debit', label: '簽帳金融卡' }, { value: 'membership', label: '會員卡' }], default: 'credit' },
      { key: 'name', label: '卡片名稱', type: 'text', required: true, placeholder: '例：台新 GOGO 卡' },
      { key: 'issuer', label: '發卡銀行 / 機構', type: 'text', placeholder: '例：台新銀行' },
      { key: 'network', label: '卡片類別（信用卡）', type: 'select', options: NETWORKS, default: 'Mastercard' },
      { key: 'lastFour', label: '末四碼', type: 'text', placeholder: '1234' },
      { key: 'statementDay', label: '結帳日（信用卡，幾號）', type: 'number', placeholder: '5' },
      { key: 'dueDay', label: '繳款日（信用卡，幾號）', type: 'number', placeholder: '20' },
      { key: 'annualFee', label: '年費（信用卡）', type: 'number' },
      { key: 'pdfPassword', label: '帳單 PDF 密碼（只存這台電腦、永不上傳）', type: 'password', placeholder: c?.pdfPasswordSet ? '已設定，留空＝不變更' : '通常是身分證字號' },
      // 明確清除入口（Codex r10#10）：只在已設定時出現；勾了才真的清空（留空仍是「不變更」，避免誤刪）
      ...(c?.pdfPasswordSet ? [{ key: 'clearPdfPassword', label: '清除已存的帳單密碼（改回未設定）', type: 'checkbox', full: true }] : []),
      { key: 'memberId', label: '會員編號（會員卡）', type: 'text' },
      { key: 'level', label: '等級（會員卡）', type: 'text', placeholder: '例：金卡 / 鑽石' },
      { key: 'expiry', label: '有效期限（年/月，卡面 MM/YY）', type: 'month' },
      { key: 'benefits', label: '權益 / 回饋', type: 'textarea', full: true, placeholder: '例：國內 3% 回饋、機場接送 2 次' },
      { key: 'note', label: '備註', type: 'text', full: true }
    ],
    // 機密不預填（自主體檢）：GET /api/cards 已剝掉 pdfPassword，編輯時本來就沒有值可填
    values: c ? { ...c, expiry: (c.expiry || '').slice(0, 7) } : { type: defaultType },
    onSubmit: async (data) => {
      const clearPw = data.clearPdfPassword; delete data.clearPdfPassword;   // 非 schema 欄位，送出前移除
      // 勾「清除」→ 明確送空字串清空（後端接受 '' ＝清除）；否則留空＝不變更（PUT 部分合併保留舊密碼）
      if (c && clearPw) data.pdfPassword = '';
      else if (c && (data.pdfPassword == null || data.pdfPassword === '')) delete data.pdfPassword;
      if (c) await api('/cards/' + c.id, { method: 'PUT', body: data });
      else await api('/cards', { method: 'POST', body: data });
      toast('已儲存');
      if (seq === currentRouteSeq()) {
        const message = c ? '卡片資料已更新' : `${TYPE_LABEL[data.type] || '卡片'}已新增`;
        rerenderCardsAfterSave(seq, message);
      }
    }
  });
}
