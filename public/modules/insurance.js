// @ts-check
import { api, view, byId, wan, money, esc, daysUntil, openForm, confirmDelete, toast, currentRouteSeq } from '../app.js';
import { icon } from './icons.js';

const CYCLES = [
  { value: 'yearly', label: '年繳' }, { value: 'semiannual', label: '半年繳' },
  { value: 'quarterly', label: '季繳' }, { value: 'monthly', label: '月繳' }, { value: 'single', label: '躉繳' }
];
const cycleLabel = (c) => (CYCLES.find(x => x.value === c) || {}).label || c || '—';
const PREMIUM_MULTIPLIER = Object.freeze({ yearly: 1, semiannual: 2, quarterly: 4, monthly: 12, single: 0 });

function annualPremiumOf(list) {
  return list.reduce((sum, policy) => {
    const mult = PREMIUM_MULTIPLIER[policy.premiumCycle] ?? 1;
    return sum + Number(policy.premium || 0) * mult;
  }, 0);
}

function paymentMeta(nextPayment) {
  const days = daysUntil(nextPayment);
  if (!nextPayment || !Number.isFinite(days)) return { tone: 'missing', label: '尚未安排', days };
  if (days < 0) return { tone: 'danger', label: `已過 ${-days} 天`, days };
  if (days === 0) return { tone: 'warning', label: '今天繳費', days };
  if (days <= 7) return { tone: 'warning', label: `${days} 天後繳費`, days };
  if (days <= 30) return { tone: 'upcoming', label: `${days} 天後繳費`, days };
  return { tone: 'normal', label: '已安排', days };
}

function coverageMeta(endDate) {
  const days = daysUntil(endDate);
  if (!endDate) return { tone: 'lifetime', label: '終身保障' };
  if (!Number.isFinite(days)) return { tone: 'missing', label: '日期待確認' };
  if (days < 0) return { tone: 'danger', label: `已到期 ${-days} 天` };
  if (days <= 90) return { tone: 'warning', label: `${days} 天後到期` };
  return { tone: 'normal', label: '保障中' };
}

function insuranceNoticeHtml(message) {
  if (!message) return '';
  return `<div class="insurance-notice" role="status" aria-live="polite">
    <span>${icon('check', 17)}</span><strong>${esc(message)}</strong>
  </div>`;
}

function insuranceLoadingHtml() {
  return `<section class="insurance-page">
    <div class="page-head insurance-page-head">
      <div><p class="page-eyebrow">保障管理</p><h1>保險追蹤</h1><p>把繳費時程、保障內容與保單關係放在同一個工作面。</p></div>
    </div>
    <section class="insurance-state insurance-loading" role="status" aria-live="polite" aria-busy="true">
      <span class="insurance-state-icon">${icon('shield', 28)}</span>
      <div><span>正在整理</span><h2>正在讀取保單資料</h2><p>只會讀取保單清單，不會新增、刪除或修改任何資料。</p></div>
    </section>
  </section>`;
}

function insuranceLoadErrorHtml(message) {
  return `<section class="insurance-page">
    <div class="page-head insurance-page-head">
      <div><p class="page-eyebrow">保障管理</p><h1>保險追蹤</h1><p>把繳費時程、保障內容與保單關係放在同一個工作面。</p></div>
    </div>
    <section class="insurance-state insurance-error" role="alert" aria-labelledby="insuranceErrorTitle">
      <span class="insurance-state-icon">${icon('alert', 28)}</span>
      <div class="insurance-state-copy">
        <span>載入未完成</span>
        <h2 id="insuranceErrorTitle">保單資料暫時載入失敗</h2>
        <p>這次只讀取失敗，沒有新增、刪除或修改任何保單。可以直接重新載入。</p>
      </div>
      <button class="btn-ghost" id="retryInsurance">${icon('refresh', 16)}重新載入</button>
      <details><summary>查看錯誤訊息</summary><code>${esc(message || '無法連線')}</code></details>
    </section>
  </section>`;
}

function insuranceEmptyHtml() {
  return `<div class="insurance-empty">
    <span>${icon('shield', 24)}</span>
    <div><strong>尚無保單</strong><p>先新增仍在繳費或需要續期的保單，之後就能集中查看繳費時程與保障關係。</p></div>
    <button class="btn" id="emptyAddIns">${icon('plus', 16)}新增第一張保單</button>
  </div>`;
}

let insuranceNotice = '';

function rerenderInsuranceAfterSave(seq, message) {
  if (seq !== currentRouteSeq()) return;
  insuranceNotice = message;
  return renderInsurance();
}

export async function renderInsurance() {
  const seq = currentRouteSeq();
  const notice = insuranceNotice;
  insuranceNotice = '';
  view().innerHTML = insuranceLoadingHtml();
  let list;
  try {
    list = (await api('/insurance')).slice().sort((a, b) => daysUntil(a.nextPayment) - daysUntil(b.nextPayment));
  } catch (error) {
    if (seq !== currentRouteSeq()) return;
    view().innerHTML = insuranceLoadErrorHtml(error instanceof Error ? error.message : '無法連線');
    byId('retryInsurance').onclick = () => renderInsurance();
    return;
  }
  if (seq !== currentRouteSeq()) return;   // fetch 期間切走了頁（Codex r10#6 idiom；r11#2 補上漏掉的兩頁）——寫 DOM 前必守，router 的事後檢查救不了 renderer 內部的寫入

  const annual = annualPremiumOf(list);
  const totalCv = list.reduce((s, p) => s + Number(p.cashValue || 0), 0);
  const dueSoon = list.filter(p => {
    const d = daysUntil(p.nextPayment);
    return d >= 0 && d <= 30;
  }).length;
  const overdue = list.filter(p => {
    const d = daysUntil(p.nextPayment);
    return Number.isFinite(d) && d < 0;
  }).length;
  const ending = list.filter(p => {
    const d = daysUntil(p.endDate);
    return d >= 0 && d <= 90;
  }).length;
  const attention = overdue
    ? `${overdue} 張保單的繳費日已過，請先確認是否完成繳費。`
    : dueSoon
      ? `${dueSoon} 張保單將在 30 天內繳費，時程已排在最前面。`
      : '目前沒有 30 天內要繳費的保單。';

  view().innerHTML = `
    <section class="insurance-page">
    <div class="page-head insurance-page-head">
      <div><p class="page-eyebrow">保障管理</p><h1>保險追蹤</h1><p>把繳費時程、保障內容與保單關係放在同一個工作面。</p></div>
      <div class="page-actions"><button class="btn" id="addIns">${icon('plus', 16)}新增保單</button></div>
    </div>

    ${insuranceNoticeHtml(notice)}

    <div class="insurance-summary" aria-label="保險摘要">
      <div class="insurance-summary-item"><span>保單數</span><strong>${list.length} 張</strong></div>
      <div class="insurance-summary-item"><span>年化保費</span><strong>${wan(annual)}</strong></div>
      <div class="insurance-summary-item"><span>保單現金價值</span><strong>${wan(totalCv)}</strong></div>
      <div class="insurance-summary-item"><span>30 天內繳費</span><strong>${dueSoon} 張</strong></div>
    </div>

    <div class="insurance-attention ${overdue ? 'danger' : dueSoon ? 'warning' : ''}">
      <span class="insurance-attention-icon">${icon(overdue ? 'alert' : 'shield', 18)}</span>
      <div><strong>${attention}</strong>
        <p>「年化保費」依繳費週期換算，躉繳不重複計入；繳費完成後，請把下次繳費日更新到下一期。${ending ? `另有 ${ending} 張保單將在 90 天內到期。` : ''}</p></div>
    </div>

    <section class="insurance-policy-section">
      <div class="insurance-section-head">
        <div><span>保障清單</span><h2>我的保單</h2></div>
        <p>依下次繳費日排序，逾期與近期項目會先出現。</p>
      </div>
      <div class="insurance-policy-grid">
        ${list.map(policyCard).join('') || insuranceEmptyHtml()}
      </div>
    </section>
    </section>
  `;

  byId('addIns').onclick = () => openInsForm();
  const emptyAdd = byId('emptyAddIns');
  if (emptyAdd) emptyAdd.onclick = () => openInsForm();
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openInsForm(list.find(p => p.id === b.dataset.edit)));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const p = list.find(x => x.id === b.dataset.del);
    confirmDelete(p.policyName, async () => {
      await api('/insurance/' + p.id, { method: 'DELETE' });
      if (seq === currentRouteSeq()) insuranceNotice = '保單已刪除';
    });
  });
}

function policyCard(p) {
  const payment = paymentMeta(p.nextPayment);
  const coverage = coverageMeta(p.endDate);
  return `<article class="insurance-policy">
    <header class="insurance-policy-head">
      <div class="insurance-policy-identity"><span class="insurance-policy-mark">${icon('shield', 17)}</span>
        <div><h3>${esc(p.policyName)}</h3><p>${esc(p.insurer || '保險公司未填')}</p></div></div>
      <span class="insurance-person-tag">${esc(p.insured || '被保險人未填')}</span>
    </header>

    <div class="insurance-payment-strip">
      <div><span>保費／週期</span><strong>${money(p.premium)} <small>/ ${esc(cycleLabel(p.premiumCycle))}</small></strong></div>
      <div class="insurance-payment-status ${payment.tone}"><span>下次繳費</span>
        <strong>${esc(p.nextPayment || '未填日期')}</strong><em>${esc(payment.label)}</em></div>
    </div>

    <div class="insurance-people">
      <div><span>要保人</span><strong>${esc(p.policyholder || '未填')}</strong></div>
      <div><span>被保險人</span><strong>${esc(p.insured || '未填')}</strong></div>
      <div><span>受益人</span><strong>${esc(p.beneficiary || '未填')}</strong></div>
    </div>

    <div class="insurance-policy-facts">
      <div><span>保單現金價值</span><strong>${money(p.cashValue)}</strong></div>
      <div><span>保障期間</span><strong>${esc(p.startDate || '起日未填')} ～ ${esc(p.endDate || '終身')}</strong>
        <em class="insurance-coverage-status ${coverage.tone}">${esc(coverage.label)}</em></div>
    </div>

    <div class="insurance-coverage"><span>保障內容</span><p>${esc(p.coverage || '尚未填寫保障內容')}</p></div>
    <footer class="insurance-policy-actions row-actions">
      <button class="btn-link btn-sm" data-edit="${esc(p.id)}" title="編輯">${icon('edit', 15)}</button>
      <button class="btn-danger btn-sm" data-del="${esc(p.id)}" title="刪除">${icon('trash', 15)}</button>
    </footer>
  </article>`;
}

function openInsForm(p) {
  const seq = currentRouteSeq();
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
      const message = p ? '保單資料已更新' : '保單已新增';
      toast(message);
      rerenderInsuranceAfterSave(seq, message);
    }
  });
}
