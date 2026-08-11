// @ts-check
import { api, view, byId, wan, money, moneyCur, pct, esc, openForm, confirmDelete, toast, modalSizeClass, bindBackdropClose, currentRouteSeq, claimModalRoot, releaseModalRoot } from '../app.js';
import { PALETTE, AXIS } from './theme.js';
import { icon } from './icons.js';
import { rebalancePlan } from './rebalance.js';
// 型別選項、幣別選項與「算不算負債」一律走 accounts-model（#409 r8）：本檔原本各自手抄一份，
// 型別選項漏了 liability／creditcard（合法值選不到 ⇒ 打開那種帳戶按儲存就靜靜變 cash，
// 50 萬負債變 50 萬資產），負債判準漏了 creditcard（信用卡帳戶被畫成藍標籤、餘額不標紅）。
// 這些手抄清單零考題看著；理由、後果與「新增型別還要改哪裡」全寫在 accounts-model.js 檔頭。
import { accountTypeOptions, isLiabilityAccount, ACCOUNT_CURRENCIES } from './accounts-model.js';
let chart;
const ASSET_CLASS_DISPLAY_ORDER = Object.freeze(['股票', '債券', '現金', '黃金']);

/** @param {any[]} rows */
function orderAllocationRows(rows) {
  const rank = name => {
    const index = ASSET_CLASS_DISPLAY_ORDER.indexOf(name);
    return index === -1 ? ASSET_CLASS_DISPLAY_ORDER.length : index;
  };
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.class) - rank(b.row.class) || a.index - b.index)
    .map(({ row }) => row);
}

export async function renderAssets() {
  const seq = currentRouteSeq();
  const [db, alloc] = await Promise.all([api('/db'), api('/summary')]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別動 DOM/圖表（Codex r10#6）
  const accounts = db.accounts || [];
  const nonCash = accounts.filter(x => (x.type || 'cash') !== 'cash');   // 銀行/現金帳戶獨立到「銀行帳戶」頁（使用者定 2026-07-21）
  const a = alloc.allocation;
  if (chart) { chart.destroy(); chart = null; }

  view().innerHTML = `
    <div class="assets-page">
      <div class="page-head assets-head">
        <div><h1>資產配置</h1><p>看清資產放在哪裡，再判斷是否需要調整</p></div>
        <div class="page-actions"><button class="btn-ghost" id="rebalBtn">${icon('repeat', 16)}再平衡計算</button><button class="btn-ghost" id="editTargets">${icon('settings', 16)}設定目標配置</button><button class="btn" id="addAcc">${icon('plus', 16)}新增帳戶</button></div>
      </div>

      <aside class="assets-scope-note" aria-label="資產配置資料口徑">
        <strong>資料口徑</strong>
        <p>股票與債券由「投資組合」的持股自動換算併入；銀行與現金請到「<a href="#bank">銀行帳戶</a>」管理。黃金、房地產、保單現金價值、其他資產與負債則在本頁維護。</p>
      </aside>

      <section class="asset-kpi-frame" aria-label="資產摘要">
        <div class="asset-kpi"><span>總資產</span><strong class="pos">${wan(alloc.assets)}</strong></div>
        <div class="asset-kpi"><span>總負債</span><strong class="neg">${wan(alloc.liabilities)}</strong></div>
        <div class="asset-kpi"><span>淨資產 <small>（含現金）</small></span><strong>${wan(alloc.netWorth)}</strong></div>
      </section>

      <section class="assets-layout">
        <article class="asset-panel asset-chart-panel">
          <div class="assets-panel-head"><div><span class="assets-eyebrow">配置概況</span><h2>資產分布</h2></div><span class="assets-panel-note">含現金</span></div>
          <div class="chart-box asset-chart-box"><canvas id="pie"></canvas></div>
        </article>
        <article class="asset-panel asset-target-panel">
          <div class="assets-panel-head"><div><span class="assets-eyebrow">配置檢查</span><h2>實際配置 vs 目標</h2></div><span class="assets-panel-note">偏離門檻 ${db.settings.allocationDriftPct || 5}%</span></div>
          <div class="asset-allocation-list">
            ${orderAllocationRows(a.rows).filter(r => r.value > 0 || r.targetPct > 0).map(r => {
          const off = Math.abs(r.diff) >= (db.settings.allocationDriftPct || 5);
          const fromPf = ['股票', '債券'].includes(r.class);
          return `<div class="asset-allocation-row">
            <div class="asset-allocation-head">
              <div class="asset-allocation-name"><strong>${esc(r.class)}</strong>${fromPf ? `<a href="#ib" class="drill-link" title="此數字由投資組合的持股自動換算，點此看明細">投資組合 →</a>` : ''}</div>
              <div class="asset-allocation-values"><strong>${r.actualPct.toFixed(1)}%</strong><span>目標 ${r.targetPct}%</span>${off ? `<span class="tag amber">偏離 ${r.diff > 0 ? '+' : ''}${r.diff.toFixed(1)}%</span>` : ''}</div>
            </div>
            <div class="asset-allocation-track">
              <span class="asset-allocation-fill" style="--allocation-width:${Math.min(r.actualPct, 100)}%"></span>
              <span class="asset-allocation-target" style="--allocation-target:${Math.min(r.targetPct, 100)}%" title="目標比例"></span>
            </div>
          </div>`;
        }).join('') || '<p class="empty">尚未設定目標配置。</p>'}
          </div>
          <p class="asset-target-legend"><span></span>深色直線表示目標比例</p>
        </article>
      </section>

      <section class="assets-details">
        <div class="assets-details-head"><div><span class="assets-eyebrow">帳戶明細</span><h2>其他資產與負債</h2></div><p>投資、房地產與負債等；銀行帳戶見「<a href="#bank">銀行帳戶</a>」</p></div>
        <div class="tbl-wrap">
          <table class="assets-account-table"><thead><tr><th>帳戶</th><th>類別</th><th>資產類別</th><th class="num">餘額</th><th></th></tr></thead>
          <tbody>${nonCash.map(accRow).join('') || `<tr><td colspan="5" class="empty">尚無非現金帳戶。銀行/現金帳戶請到「銀行帳戶」頁。</td></tr>`}</tbody></table>
        </div>
      </section>
    </div>
  `;

  drawPie(alloc.byClass);
  byId('addAcc').onclick = () => openAccForm();
  byId('editTargets').onclick = () => openTargets(db.assetTargets || []);
  byId('rebalBtn').onclick = () => openRebalance(a.rows);
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openAccForm(accounts.find(x => x.id === b.dataset.edit)));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const x = accounts.find(y => y.id === b.dataset.del);
    confirmDelete(x.name, () => api('/accounts/' + x.id, { method: 'DELETE' }));
  });
}

function accRow(x) {
  const liab = isLiabilityAccount(x);
  const cur = x.currency || 'TWD';
  return `<tr>
    <td>${esc(x.name)}</td>
    <td><span class="tag asset-account-type${liab ? ' amber' : ''}">${esc(typeLabel(x.type))}</span></td>
    <td class="muted">${esc(x.class || '—')}</td>
    <td class="num ${liab ? 'neg' : ''}">${moneyCur(x.balance, cur)}</td>
    <td><div class="row-actions"><button class="btn-link btn-sm" data-edit="${esc(x.id)}" title="編輯">${icon('edit', 15)}</button><button class="btn-danger btn-sm" data-del="${esc(x.id)}" title="刪除">${icon('trash', 15)}</button></div></td>
  </tr>`;
}
function typeLabel(t) { return (accountTypeOptions().find(a => a.value === t) || {}).label || t; }

function drawPie(byClass) {
  const ctx = byId('pie');
  const labels = Object.keys(byClass);
  if (!labels.length) { ctx.parentElement.innerHTML = '<p class="empty">尚無資產資料。</p>'; return; }
  chart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: labels.map(l => byClass[l]), backgroundColor: PALETTE, borderColor: '#ffffff', borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: window.matchMedia('(max-width: 700px)').matches ? 'bottom' : 'right', labels: { color: AXIS, boxWidth: 12, padding: 12 } },
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${money(c.parsed)} (${pct(c.parsed / c.dataset.data.reduce((x, y) => x + y, 0) * 100)})` } } } }
  });
}

/** @param {any=} acc @param {{defaultType?:string, onDone?:()=>any}=} opts 新增預設類型／存檔後重繪哪一頁（銀行帳戶頁共用此表單） */
function openAccForm(acc, opts = {}) {
  const done = opts.onDone || renderAssets;
  openForm({
    title: acc ? '編輯帳戶' : '新增帳戶',
    fields: [
      { key: 'name', label: '帳戶名稱', type: 'text', required: true, placeholder: '例：台新銀行 活存' },
      { key: 'type', label: '帳戶類型', type: 'select', options: accountTypeOptions() },
      { key: 'currency', label: '幣別', type: 'select', options: ACCOUNT_CURRENCIES },
      { key: 'class', label: '資產類別（用於配置圓餅圖）', type: 'text', placeholder: '例：現金、黃金', full: true },
      { key: 'balance', label: '目前餘額（原幣，負債請填負數）', type: 'number', required: true },
      // 完整帳號不投影到瀏覽器，GET 只回是否已設定與末四碼；供銀行對帳單匯入辨識帳戶。
      { key: 'accountNo', label: '完整帳號（選填，用於辨識對帳單）', type: 'text', full: true,
        placeholder: acc?.accountNoSet ? `已設定（末四碼 ${acc.accountNoLast4 || '****'}），留空＝不變更` : '例：9001001234 53301（銀行對帳單匯入時用來對到這個帳戶）' },
      ...(acc?.accountNoSet ? [{ key: 'clearAccountNo', label: '清除已存的帳號（改回未設定）', type: 'checkbox', full: true }] : []),
    ],
    values: acc || { currency: 'TWD', ...(opts.defaultType ? { type: opts.defaultType } : {}) },
    onSubmit: async (data) => {
      const { clearAccountNo, ...body } = data;
      // 勾「清除」→ 送空字串清空；否則留空＝不變更（PUT 部分合併保留舊帳號，同 pdfPassword 慣例）
      if (acc && clearAccountNo) body.accountNo = '';
      else if (acc && (body.accountNo == null || body.accountNo === '')) delete body.accountNo;
      if (acc) await api('/accounts/' + acc.id, { method: 'PUT', body });
      else await api('/accounts', { method: 'POST', body });
      toast('已儲存'); done();
    }
  });
}

// ---- 銀行帳戶頁（獨立自資產配置，使用者定 2026-07-21）：只列現金/銀行帳戶（type:'cash'），管理餘額＋對帳單末碼。----
// 配置圓餅圖與淨資產仍含現金（在資產配置頁）；這裡只是把「銀行帳戶的管理」搬出來獨立一頁。
function bankAccountSummary(accounts) {
  return {
    accountCount: accounts.length,
    suffixCount: accounts.filter(x => x.accountNoSet || x.accountNoLast4).length,
    currencies: [...new Set(accounts.map(x => x.currency || 'TWD'))],
  };
}

function bankAccountNoticeHtml(message) {
  if (!message) return '';
  return `<div class="bank-account-notice" role="status" aria-live="polite">
    <span>${icon('check', 17)}</span><strong>${esc(message)}</strong>
  </div>`;
}

function bankAccountLoadErrorHtml(message) {
  return `<div class="bank-accounts-page">
    <div class="page-head bank-accounts-head">
      <div><h1>銀行帳戶</h1><p>管理現金帳戶、原幣餘額與對帳單辨識資訊</p></div>
    </div>
    <section class="bank-account-error" role="alert" aria-labelledby="bankAccountErrorTitle">
      <span class="bank-error-icon">${icon('alert', 28)}</span>
      <div class="bank-error-copy">
        <span>載入未完成</span>
        <h2 id="bankAccountErrorTitle">銀行帳戶暫時載入失敗</h2>
        <p>這次只讀取失敗，沒有修改任何帳戶資料。可以直接重新載入。</p>
      </div>
      <button class="btn-ghost" id="retryBankAccounts">${icon('refresh', 16)}重新載入</button>
      <details><summary>查看錯誤訊息</summary><code>${esc(message || '無法連線')}</code></details>
    </section>
  </div>`;
}

let bankAccountNotice = '';

function rerenderBankAccountsAfterSave(seq, message) {
  if (seq !== currentRouteSeq()) return;
  bankAccountNotice = message;
  return renderBankAccounts();
}

export async function renderBankAccounts() {
  const seq = currentRouteSeq();
  const notice = bankAccountNotice;
  bankAccountNotice = '';
  let db;
  try {
    db = await api('/db');
  } catch (error) {
    if (seq !== currentRouteSeq()) return;
    view().innerHTML = bankAccountLoadErrorHtml(error instanceof Error ? error.message : '無法連線');
    byId('retryBankAccounts').onclick = () => renderBankAccounts();
    return;
  }
  if (seq !== currentRouteSeq()) return;
  const accounts = (db.accounts || []).filter(x => (x.type || 'cash') === 'cash');
  const summary = bankAccountSummary(accounts);
  view().innerHTML = `
    <div class="bank-accounts-page">
      <div class="page-head bank-accounts-head">
        <div><h1>銀行帳戶</h1><p>管理現金帳戶、原幣餘額與對帳單辨識資訊</p></div>
        <div class="page-actions">
          <a class="btn-ghost" href="#cashflow">${icon('upload', 16)}匯入對帳單</a>
          <button class="btn" id="addBankAcc">${icon('plus', 16)}新增銀行帳戶</button>
        </div>
      </div>

      ${bankAccountNoticeHtml(notice)}

      <section class="bank-account-summary" aria-label="銀行帳戶摘要">
        <div class="bank-account-kpi"><span>帳戶數</span><strong>${summary.accountCount} 個</strong></div>
        <div class="bank-account-kpi"><span>已設定帳號末碼</span><strong>${summary.suffixCount} 個</strong></div>
        <div class="bank-account-kpi"><span>使用幣別</span><strong>${summary.currencies.length ? summary.currencies.map(esc).join('、') : '尚無'}</strong></div>
      </section>

      <aside class="bank-privacy-note" aria-label="帳號隱私說明">
        <span class="bank-privacy-icon">${icon('shield', 18)}</span>
        <div><strong>帳號只顯示末四碼</strong><p>完整帳號只用於辨識銀行對帳單；編輯帳戶時留空，原本設定不會被清除。</p></div>
      </aside>

      <section class="bank-account-details">
        <div class="bank-account-section-head">
          <div><span>帳戶明細</span><h2>現金與銀行存款</h2></div>
          <p>餘額依各帳戶原幣顯示，不跨幣別加總</p>
        </div>
        ${accounts.length ? `<div class="tbl-wrap bank-account-table-wrap">
          <table class="bank-acc-tbl bank-account-table"><thead><tr><th>銀行帳戶</th><th>帳戶末四碼</th><th>幣別</th><th class="num">餘額</th><th aria-label="動作"></th></tr></thead>
          <tbody>${accounts.map(bankAccRow).join('')}</tbody></table>
        </div>` : `<div class="bank-account-empty">
          <span class="bank-empty-icon">${icon('bank', 28)}</span>
          <div><strong>尚無銀行帳戶</strong><p>先新增一個銀行帳戶，或由銀行收支匯入對帳單建立。</p></div>
          <div class="bank-empty-actions">
            <button class="btn" id="addBankAccEmpty">${icon('plus', 16)}新增第一個帳戶</button>
            <a class="btn-ghost" href="#cashflow">${icon('upload', 16)}匯入對帳單</a>
          </div>
        </div>`}
      </section>
    </div>
  `;
  byId('addBankAcc').onclick = () => openAccForm(null, {
    defaultType: 'cash', onDone: () => rerenderBankAccountsAfterSave(seq, '銀行帳戶已新增')
  });
  const emptyAdd = byId('addBankAccEmpty');
  if (emptyAdd) emptyAdd.onclick = () => openAccForm(null, {
    defaultType: 'cash', onDone: () => rerenderBankAccountsAfterSave(seq, '銀行帳戶已新增')
  });
  view().querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openAccForm(accounts.find(x => x.id === b.dataset.edit), {
    onDone: () => rerenderBankAccountsAfterSave(seq, '銀行帳戶資料已更新')
  }));
  view().querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const x = accounts.find(y => y.id === b.dataset.del);
    confirmDelete(x.name, () => api('/accounts/' + x.id, { method: 'DELETE' }));   // confirmDelete 內建 router() 重繪目前頁（銀行帳戶）
  });
}
function bankAccRow(x) {
  const cur = x.currency || 'TWD';
  const neg = Number(x.balance) < 0;
  const suffix = x.accountNoLast4 ? `•••• ${esc(x.accountNoLast4)}` : '<span class="bank-account-unset">尚未設定</span>';
  return `<tr>
    <td class="bank-account-name-cell"><div class="bank-account-name"><span class="bank-account-mark">${icon('bank', 17)}</span><span><strong>${esc(x.name)}</strong>${x.class && x.class !== '現金' ? `<small>${esc(x.class)}</small>` : ''}</span></div></td>
    <td data-label="帳戶末四碼"><span class="bank-account-suffix">${suffix}</span></td>
    <td data-label="幣別"><span class="bank-currency-tag">${esc(cur)}</span></td>
    <td data-label="餘額" class="num ${neg ? 'neg' : ''}">${moneyCur(x.balance, cur)}</td>
    <td class="bank-account-actions"><div class="row-actions"><button class="btn-link btn-sm" data-edit="${esc(x.id)}" title="編輯" aria-label="編輯 ${esc(x.name)}">${icon('edit', 15)}</button><button class="btn-danger btn-sm" data-del="${esc(x.id)}" title="刪除" aria-label="刪除 ${esc(x.name)}">${icon('trash', 15)}</button></div></td>
  </tr>`;
}

// 再平衡計算器（3-13）：唯讀試算、不改任何資料。預設「只買不賣」（符合投資原則：加碼只用新資金）。
function openRebalance(allocRows) {
  const root = byId('modal-root');
  let buyOnly = true;
  claimModalRoot();   // r7：接管 modal-root＝蓋新章，任何在途的 openForm(async) 就失去擁有權、不會回來清掉這個窗
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('md')}">
    <div class="modal-head"><h2>再平衡計算器</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <button type="button" class="btn btn-sm" id="modeBuy">只買不賣</button>
        <button type="button" class="btn-ghost btn-sm" id="modeBoth">允許買賣</button>
        <span id="cashWrap" style="display:flex;gap:6px;align-items:center;margin-left:auto">
          <label class="muted" style="font-size:12px">新資金（台幣）</label>
          <input id="rebCash" type="number" step="1000" min="0" placeholder="例：50000" style="width:120px" />
        </span>
      </div>
      <div id="rebOut"></div>
      <p class="muted" style="font-size:11px;margin-top:10px">「只買不賣」＝新資金優先補低配類別（符合「加碼只用新資金、不舉新債」原則）；「允許買賣」＝恢復目標配置的完整買賣清單。此為試算，<b>不會改動任何資料</b>；目標％依比例自動正規化。</p>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; releaseModalRoot(); };   // r7：關窗即撤銷擁有權
  root.querySelector('.x-close').onclick = close;
  bindBackdropClose(root, close);
  const render = () => {
    const cash = Number(/** @type {any} */ (byId('rebCash')).value || 0);
    const plan = rebalancePlan(allocRows, { buyOnly, cash });
    byId('modeBuy').className = buyOnly ? 'btn btn-sm' : 'btn-ghost btn-sm';
    byId('modeBoth').className = buyOnly ? 'btn-ghost btn-sm' : 'btn btn-sm';
    byId('cashWrap').style.display = buyOnly ? 'flex' : 'none';
    if (!plan.rows.length) { byId('rebOut').innerHTML = '<p class="empty">尚未設定目標配置（先按「設定目標配置」）。</p>'; return; }
    const need = buyOnly && !(cash > 0);
    byId('rebOut').innerHTML = `
      <div class="tbl-wrap"><table>
        <thead><tr><th>類別</th><th class="num">目前</th><th class="num">目標</th><th class="num">${buyOnly ? '建議加碼' : '動作'}</th><th class="num">調整後</th></tr></thead>
        <tbody>${plan.rows.map(r => {
          const act = need ? '<span class="muted">—</span>'
            : Math.abs(r.delta) < 1 ? '<span class="muted">—</span>'
            : r.delta > 0 ? `<b class="pos">買 ${money(r.delta)}</b>`
            : `<b class="neg">賣 ${money(-r.delta)}</b>`;
          return `<tr>
            <td>${esc(r.class)}</td>
            <td class="num">${money(r.value)}<br><span class="muted" style="font-size:11px">${r.currentPct.toFixed(1)}%</span></td>
            <td class="num">${r.targetPctNorm.toFixed(1)}%</td>
            <td class="num">${act}</td>
            <td class="num muted">${need ? '—' : r.afterPct.toFixed(1) + '%'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      ${need ? '<p class="hint" style="margin-top:8px">輸入這次要投入的新資金金額，就會算出各類別建議加碼多少。</p>' : ''}
      ${plan.excluded.length ? `<p class="muted" style="font-size:11px;margin-top:8px">未設目標、不參與計算：${plan.excluded.map(esc).join('、')}</p>` : ''}`;
  };
  byId('modeBuy').onclick = () => { buyOnly = true; render(); };
  byId('modeBoth').onclick = () => { buyOnly = false; render(); };
  byId('rebCash').oninput = render;
  render();
}

function openTargets(targets) {
  const root = byId('modal-root');
  claimModalRoot();   // r7：同 openRebalance，接管 modal-root＝作廢在途的 openForm(async)
  const rows = () => targets.map((t, i) => `<div class="form-grid" style="margin-bottom:8px" data-i="${i}">
    <input data-k="class" value="${esc(t.class || '')}" placeholder="類別 (例：股票)" />
    <div style="display:flex;gap:8px"><input data-k="targetPct" type="number" value="${esc(t.targetPct ?? '')}" placeholder="目標 %" />
    <button type="button" class="btn-danger btn-sm" data-rm="${i}" title="刪除">${icon('trash', 15)}</button></div>
  </div>`).join('');
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('md')}">
    <div class="modal-head"><h2>設定目標資產配置</h2><button class="x-close">×</button></div>
    <div class="modal-body"><div id="tRows">${rows()}</div>
      <button type="button" class="btn-ghost btn-sm" id="addRow">${icon('plus', 15)}新增類別</button>
      <div class="form-actions"><button class="btn-ghost" data-cancel>取消</button><button class="btn" id="saveT">儲存</button></div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; releaseModalRoot(); };   // r7：關窗即撤銷擁有權
  const collect = () => [...root.querySelectorAll('#tRows [data-i]')].map(r => ({
    class: r.querySelector('[data-k="class"]').value,
    targetPct: Number(r.querySelector('[data-k="targetPct"]').value || 0)
  })).filter(x => x.class);
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  root.querySelector('#addRow').onclick = () => { targets = collect(); targets.push({ class: '', targetPct: 0 }); root.querySelector('#tRows').innerHTML = rows(); bind(); };
  function bind() { root.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { targets = collect(); targets.splice(Number(b.dataset.rm), 1); root.querySelector('#tRows').innerHTML = rows(); bind(); }); }
  bind();
  const saveBtn = /** @type {HTMLButtonElement} */ (root.querySelector('#saveT'));
  saveBtn.onclick = async () => {
    if (saveBtn.disabled) return;                          // 防連點（自主體檢：連點＝重複 POST 讓目標翻倍）
    saveBtn.disabled = true;
    const next = collect();
    try {
      // 原子整批取代（護欄 G1）：一次呼叫、後端單次寫檔——不再 GET→逐筆 DELETE→逐筆 POST（中途失敗會半刪半建救不回）
      await api('/assetTargets/replace', { method: 'POST', body: { targets: next } });
      toast('目標配置已更新'); close(); renderAssets();
    } catch (err) {
      // 整批原子：失敗＝什麼都沒動，維持原狀即可（不再是「半完成需重新確認」）
      saveBtn.disabled = false;
      toast('儲存目標配置時發生錯誤：' + (/** @type {any} */ (err).message || ''), true);
      renderAssets();
    }
  };
}
