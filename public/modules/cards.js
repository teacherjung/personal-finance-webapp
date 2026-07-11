import { api, view, wan, money, esc, daysUntil, openForm, confirmDelete, toast } from '../app.js';
import { icon } from './icons.js';

const NETWORKS = ['VISA', 'Mastercard', 'JCB', '銀聯', '美國運通', '—'];
const TYPE_LABEL = { credit: '信用卡', membership: '會員卡' };

// 卡片效期只記年/月（卡面 MM/YY），有效到該月「月底」——倒數與停用判斷都以月底計。
// 兼容舊資料的完整日期（YYYY-MM-DD 原樣沿用）。
const expiryEnd = (e) => /^\d{4}-\d{2}$/.test(e || '')
  ? `${e}-${String(new Date(Number(e.slice(0, 4)), Number(e.slice(5, 7)), 0).getDate()).padStart(2, '0')}`
  : e;

export async function renderCards() {
  const list = await api('/cards');
  const credit = list.filter(c => (c.type || 'credit') === 'credit');
  const member = list.filter(c => c.type === 'membership');
  const annualFees = credit.reduce((s, c) => s + Number(c.annualFee || 0), 0);

  view().innerHTML = `
    <div class="page-head">
      <div><h1>卡片追蹤</h1><p>信用卡與會員卡的卡片類別、末四碼、結帳/繳款日、年費、權益、停用</p></div>
      <button class="btn" id="addCard">${icon('plus', 16)}新增卡片</button>
    </div>

    <div class="cards">
      <div class="card"><h3>信用卡</h3><div class="stat sm">${credit.length} 張</div></div>
      <div class="card"><h3>會員卡</h3><div class="stat sm">${member.length} 張</div></div>
      <div class="card"><h3>信用卡年費合計</h3><div class="stat sm">${wan(annualFees)}</div></div>
      <div class="card"><h3>30 天內停用</h3><div class="stat sm">${list.filter(c => { const d = daysUntil(expiryEnd(c.expiry)); return d >= 0 && d <= 30; }).length} 張</div></div>
    </div>

    <div class="section-title">信用卡</div>
    <div class="grid card-grid">
      ${credit.map(card).join('') || '<div class="empty">尚無信用卡，點右上角新增。</div>'}
    </div>

    <div class="section-title">會員卡</div>
    <div class="grid card-grid">
      ${member.map(card).join('') || '<div class="empty">尚無會員卡。</div>'}
    </div>
  `;

  document.getElementById('addCard').onclick = () => openCardForm();
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openCardForm(list.find(c => c.id === b.dataset.edit)));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const c = list.find(x => x.id === b.dataset.del);
    confirmDelete(c.name, () => api('/cards/' + c.id, { method: 'DELETE' }));
  });
}

function card(c) {
  const credit = (c.type || 'credit') === 'credit';
  const d = daysUntil(expiryEnd(c.expiry));
  const expSoon = d >= 0 && d <= 60;
  const rows = credit ? [
    ['發卡銀行', c.issuer], ['卡片類別', c.network], ['末四碼', c.lastFour ? '•••• ' + c.lastFour : ''],
    ['結帳日', c.statementDay ? `每月 ${c.statementDay} 日` : ''],
    ['繳款日', c.dueDay ? `每月 ${c.dueDay} 日` : ''],
    ['年費', Number(c.annualFee) > 0 ? money(c.annualFee) : ''],   // 0 元或未填都不顯示
    ['有效期限', (c.expiry || '').slice(0, 7)]
  ] : [
    ['發卡機構', c.issuer], ['會員編號', c.memberId], ['等級', c.level], ['有效期限', (c.expiry || '').slice(0, 7)]
  ];
  return `<div class="card">
    <div class="card-head">
      <div style="display:flex;align-items:center;gap:9px">
        <span style="color:var(--accent)">${icon('card', 18)}</span>
        <div class="item-title">${esc(c.name)}</div>
      </div>
      <span class="tag ${credit ? 'blue' : 'green'}">${TYPE_LABEL[c.type] || '信用卡'}</span>
    </div>
    <div class="detail-grid">
      ${rows.filter(r => r[1]).map(r => `<span class="muted">${r[0]}</span><span>${esc(r[1])}${r[0] === '有效期限' && expSoon ? `　<span class="tag amber">${d} 天後停用</span>` : ''}</span>`).join('')}
    </div>
    ${c.benefits ? `<div class="note-block"><b>權益：</b>${esc(c.benefits)}</div>` : ''}
    ${c.note ? `<div class="muted" style="font-size:12px;margin-top:8px">${esc(c.note)}</div>` : ''}
    <div class="row-actions" style="margin-top:12px">
      <button class="btn-link btn-sm" data-edit="${c.id}" title="編輯">${icon('edit', 15)}</button>
      <button class="btn-danger btn-sm" data-del="${c.id}" title="刪除">${icon('trash', 15)}</button>
    </div>
  </div>`;
}

function openCardForm(c) {
  openForm({
    title: c ? '編輯卡片' : '新增卡片',
    fields: [
      { key: 'type', label: '卡片類型', type: 'select', options: [{ value: 'credit', label: '信用卡' }, { value: 'membership', label: '會員卡' }], default: 'credit' },
      { key: 'name', label: '卡片名稱', type: 'text', required: true, placeholder: '例：台新 GOGO 卡' },
      { key: 'issuer', label: '發卡銀行 / 機構', type: 'text', placeholder: '例：台新銀行' },
      { key: 'network', label: '卡片類別（信用卡）', type: 'select', options: NETWORKS, default: 'Mastercard' },
      { key: 'lastFour', label: '末四碼', type: 'text', placeholder: '1234' },
      { key: 'statementDay', label: '結帳日（信用卡，幾號）', type: 'number', placeholder: '5' },
      { key: 'dueDay', label: '繳款日（信用卡，幾號）', type: 'number', placeholder: '20' },
      { key: 'annualFee', label: '年費（信用卡）', type: 'number' },
      { key: 'pdfPassword', label: '帳單 PDF 密碼（只存這台電腦、永不上傳）', type: 'password', placeholder: '通常是身分證字號' },
      { key: 'memberId', label: '會員編號（會員卡）', type: 'text' },
      { key: 'level', label: '等級（會員卡）', type: 'text', placeholder: '例：金卡 / 鑽石' },
      { key: 'expiry', label: '有效期限（年/月，卡面 MM/YY）', type: 'month' },
      { key: 'benefits', label: '權益 / 回饋', type: 'textarea', full: true, placeholder: '例：國內 3% 回饋、機場接送 2 次' },
      { key: 'note', label: '備註', type: 'text', full: true }
    ],
    values: c ? { ...c, expiry: (c.expiry || '').slice(0, 7) } : {},   // 舊資料完整日期 → 年/月預填
    onSubmit: async (data) => {
      if (c) await api('/cards/' + c.id, { method: 'PUT', body: data });
      else await api('/cards', { method: 'POST', body: data });
      toast('已儲存'); renderCards();
    }
  });
}
