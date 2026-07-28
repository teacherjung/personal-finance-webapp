// @ts-check
import { api, view, byId, wan, money, esc, daysUntil, openForm, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { icon } from './icons.js';

const CYCLES = [
  { value: 'yearly', label: '年繳' }, { value: 'semiannual', label: '半年繳' },
  { value: 'quarterly', label: '季繳' }, { value: 'monthly', label: '月繳' }, { value: 'single', label: '躉繳' }
];
const cycleLabel = (c) => (CYCLES.find(x => x.value === c) || {}).label || c || '—';

export async function renderInsurance() {
  const seq = currentRouteSeq();
  const list = (await api('/insurance')).slice().sort((a, b) => daysUntil(a.nextPayment) - daysUntil(b.nextPayment));
  if (seq !== currentRouteSeq()) return;   // fetch 期間切走了頁（Codex r10#6 idiom；r11#2 補上漏掉的兩頁）——寫 DOM 前必守，router 的事後檢查救不了 renderer 內部的寫入

  // 依被保險人分組統計年繳保費
  const annual = list.reduce((s, p) => {
    const mult = { yearly: 1, semiannual: 2, quarterly: 4, monthly: 12, single: 0 }[p.premiumCycle] ?? 1;
    return s + Number(p.premium || 0) * mult;
  }, 0);
  const totalCv = list.reduce((s, p) => s + Number(p.cashValue || 0), 0);

  view().innerHTML = `
    <div class="page-head">
      <div><h1>保險追蹤</h1><p>繳費時程、保障內容、要保／被保／受益人、保障期限</p></div>
      <button class="btn" id="addIns">${icon('plus', 16)}新增保單</button>
    </div>

    <div class="cards">
      <div class="card"><h3>保單數</h3><div class="stat sm">${list.length}</div></div>
      <div class="card"><h3>年化保費</h3><div class="stat sm">${wan(annual)}</div></div>
      <div class="card"><h3>保單現金價值</h3><div class="stat sm">${wan(totalCv)}</div></div>
      <div class="card"><h3>30 天內繳費</h3><div class="stat sm">${list.filter(p => daysUntil(p.nextPayment) >= 0 && daysUntil(p.nextPayment) <= 30).length} 張</div></div>
    </div>

    <div class="grid card-grid">
      ${list.map(card).join('') || '<div class="empty">尚無保單，點右上角新增。</div>'}
    </div>
  `;

  byId('addIns').onclick = () => openInsForm();
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openInsForm(list.find(p => p.id === b.dataset.edit)));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const p = list.find(x => x.id === b.dataset.del);
    confirmDelete(p.policyName, () => api('/insurance/' + p.id, { method: 'DELETE' }));
  });
}

function card(p) {
  const d = daysUntil(p.nextPayment);
  const soon = d >= 0 && d <= 30;
  return `<div class="card">
    <div class="card-head">
      <div><div class="item-title">${esc(p.policyName)}</div>
        <div class="muted" style="font-size:12px">${esc(p.insurer || '')}</div></div>
      <span class="tag ${soon ? 'amber' : 'blue'}">${esc(p.insured || '')}</span>
    </div>
    <div class="detail-grid">
      ${row('要保人', esc(p.policyholder || '—'))}
      ${row('被保險人', esc(p.insured || '—'))}
      ${row('受益人', esc(p.beneficiary || '—'))}
      ${row('保費', `${money(p.premium)} / ${cycleLabel(p.premiumCycle)}`)}
      ${row('下次繳費', `${esc(p.nextPayment || '—')}${soon ? `　<span class="tag amber">${d === 0 ? '今天' : d + ' 天'}</span>` : ''}`)}
      ${row('保障期限', `${esc(p.startDate || '?')} ～ ${esc(p.endDate || '終身')}`)}
      ${row('現金價值', money(p.cashValue))}
    </div>
    <div class="note-block">
      <b>保障：</b>${esc(p.coverage || '—')}</div>
    <div class="row-actions" style="margin-top:12px">
      <button class="btn-link btn-sm" data-edit="${esc(p.id)}" title="編輯">${icon('edit', 15)}</button>
      <button class="btn-danger btn-sm" data-del="${esc(p.id)}" title="刪除">${icon('trash', 15)}</button>
    </div>
  </div>`;
}
const row = (k, v) => `<span class="muted">${k}</span><span>${v ?? '—'}</span>`;

function openInsForm(p) {
  openForm({
    title: p ? '編輯保單' : '新增保單',
    fields: [
      { key: 'policyName', label: '保單名稱', type: 'text', required: true, placeholder: '例：AIA 醫療終身險' },
      { key: 'insurer', label: '保險公司', type: 'text', placeholder: '例：國泰人壽' },
      { key: 'policyholder', label: '要保人', type: 'text' },
      { key: 'insured', label: '被保險人', type: 'text' },
      { key: 'beneficiary', label: '受益人', type: 'text' },
      { key: 'premium', label: '保費', type: 'number' },
      { key: 'premiumCycle', label: '繳費週期', type: 'select', options: CYCLES },
      { key: 'nextPayment', label: '下次繳費日', type: 'date' },
      { key: 'startDate', label: '保障起日', type: 'date' },
      { key: 'endDate', label: '保障迄日（終身留空）', type: 'date' },
      { key: 'cashValue', label: '保單現金價值', type: 'number' },
      { key: 'coverage', label: '保障內容', type: 'textarea', full: true, placeholder: '例：住院日額 3000、重大疾病一次給付 200 萬' }
    ],
    values: p || {},
    onSubmit: async (data) => {
      if (p) await api('/insurance/' + p.id, { method: 'PUT', body: data });
      else await api('/insurance', { method: 'POST', body: data });
      toast('已儲存'); renderInsurance();
    }
  });
}
