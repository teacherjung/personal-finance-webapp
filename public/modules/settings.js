// @ts-check
import { api, view, byId, esc, toast, modalSizeClass, bindBackdropClose, openForm } from '../app.js';
import { icon } from './icons.js';

export async function renderSettings() {
  const [s, txs, expTree] = await Promise.all([api('/settings'), api('/transactions'), api('/categories')]);
  // 帳單店名／分類學習（合併卡，使用者定 2026-07-18）：一列＝一個帳單原文（藏在 stmtRef 第 4 段），
  // 顯示名/分類取「該原文最新一筆」為代表（編輯時整批統一）。編輯以原文為準——不同分店各自取名/分類。
  const byOrig = new Map();
  for (const t of txs || []) {
    if (t.source !== 'stmt' || !t.stmtRef) continue;
    const parts = String(t.stmtRef).split('|');   // stmtRef＝卡id|消費日|金額|原始說明
    if (parts.length < 4) continue;
    const orig = parts.slice(3).join('|').trim();   // 原文可能含「|」→ 取第 3 個分隔後全部
    if (!orig) continue;
    const prev = byOrig.get(orig);
    if (!prev || String(t.date || '') > prev.date) {
      byOrig.set(orig, { orig, date: String(t.date || ''), cur: String(t.note || '').trim(),
        cat: String(t.category || ''), sub: String(t.subcategory || '') });
    }
  }
  const storeRows = [...byOrig.values()].sort((a, b) => a.cur.localeCompare(b.cur, 'zh-Hant'));
  const storeMapRows = storeRows.length ? `<div class="tbl-wrap" style="max-height:44vh;overflow:auto"><table>
        <thead><tr><th>帳單原文</th><th>顯示為</th><th>分類</th><th></th></tr></thead>
        <tbody>${storeRows.map(p => `<tr><td class="muted">${esc(p.orig)}</td><td>${esc(p.cur)}</td>
          <td>${esc(p.cat)}${p.sub ? ` <span class="muted">· ${esc(p.sub)}</span>` : ''}</td>
          <td style="width:36px"><button class="btn-link btn-sm" data-editstore="${esc(p.orig)}" data-cur="${esc(p.cur)}" data-cat="${esc(p.cat)}" data-sub="${esc(p.sub)}" title="編輯這一列的店名與分類">${icon('edit', 15)}</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="empty">尚無帳單記錄。匯入信用卡帳單後，這裡會列出每家店的顯示名與分類。</p>';
  view().innerHTML = `
    <div class="page-head"><div><h1>設定</h1><p>依分頁分組——要調整哪個分頁的行為，到對應區塊找</p></div></div>

    <h2 class="section-title" style="margin-top:4px">收支記帳</h2>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:14px">緊急預備金</h3>
      <div class="form-grid">
        <div><label>緊急預備金目標（月）——現金可支撐幾個月支出，低於此值總覽會提醒</label><input id="emergencyFundMonths" type="number" value="${esc(s.emergencyFundMonths)}" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveEfund">儲存</button></div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">分類管理（自訂大類／子類）</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">新增、改名、刪除、排序你的支出分類（大類與子類）。<b>改名</b>會自動套用到所有舊交易與學習表；<b>刪除</b>有交易的分類會把那些交易改歸「其他／未分類」。「其他／未分類」是系統退路，不能刪。收入分類（薪資／投資…）維持固定。儲存前自動備份。</p>
      <div><button class="btn-ghost" id="manageCatsBtn">${icon('refresh', 16) || ''}管理分類</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">店名格式整理</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">把帳單說明的店名整理成好讀格式：分店統一為「主體（分店）」（例：「統一超商-百福」→「統一超商（百福）」）、品牌名統一（例：「全家便利商店」→「全家商店」、「台灣普客二四」→「Times Parking」）。會先<b>預覽</b>再套用，套用前自動備份、可重複執行——之後每次新增整理規則，再跑一次即可套到舊資料。未涵蓋到的連鎖或想改的品牌名，告訴我再補。</p>
      <div><button class="btn-ghost" id="normBranchBtn">${icon('refresh', 16) || ''}整理店名格式</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">帳單店名／分類學習</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">信用卡匯入時會自動清理店名、自動判斷分類；你改過的（店名或分類）系統會記住，下次匯入同一家店自動套用（優先於內建規則）。<b>按列尾的編輯鈕可直接改這一列的顯示名與分類</b>——同原文的各月份記錄整批改；彈窗裡的「還原自動判斷」＝清除自訂、恢復系統判斷。共 ${storeRows.length} 家店，依顯示名排序。</p>
      ${storeMapRows}
    </div>

    <h2 class="section-title">資產配置</h2>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:14px">配置偏離提醒</h3>
      <div class="form-grid">
        <div><label>資產配置偏離提醒（%）——實際與目標差超過此值，總覽會提醒再平衡</label><input id="allocationDriftPct" type="number" value="${esc(s.allocationDriftPct)}" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveAlloc">儲存</button></div>
    </div>

    <h2 class="section-title">投資組合</h2>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">投資原則</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">口徑：% 淨資產、區域穿透計算。全部是<b>軟上限</b>：超標＝凍結加碼（總覽提醒＋投資組合「紀律檢查」卡），不強制減碼。</p>
      <div class="form-grid">
        <div><label>單一個股上限（%）</label><input id="ibConcentrationPct" type="number" step="0.5" value="${esc(s.ibConcentrationPct ?? 5)}" /></div>
        <div><label>股票總曝險上限（%）</label><input id="equityCapPct" type="number" value="${esc(s.equityCapPct ?? 90)}" /></div>
        <div><label>單一國家上限（%，美國與「其他」不設限）</label><input id="countryCapPct" type="number" value="${esc(s.countryCapPct ?? 15)}" /></div>
        <div><label>中國上限（%，可與國家上限不同）</label><input id="chinaCapPct" type="number" value="${esc(s.chinaCapPct ?? 15)}" /></div>
        <div><label>融資槓桿上限（x，任何時期；訊號期加碼只用新資金）</label><input id="levCapPct" type="number" step="0.1" value="${esc(s.levCapPct ?? 1.3)}" /></div>
        <div><label>IB 維持保證金率（%，斷頭距離計算用）</label><input id="ibMaintenancePct" type="number" step="1" value="${esc(s.ibMaintenancePct ?? 25)}" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="savePrinciples">儲存投資原則</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:14px">匯率與現金提醒</h3>
      <div class="form-grid">
        <div><label>美元兌台幣匯率 (USD→TWD)</label><input id="usdTwd" type="number" step="0.01" value="${esc(s.usdTwd)}" /></div>
        <div><label>IB 閒置現金提醒門檻（美元 USD）</label><input id="ibIdleCashAlert" type="number" value="${esc(s.ibIdleCashAlert)}" /></div>
        <div><label>換匯區間：美元→台幣（≥ 此值提醒分批換台幣）</label><input id="fxHigh" type="number" step="0.1" value="${esc(s.fxHigh ?? 32)}" /></div>
        <div><label>換匯區間：台幣→美元（≤ 此值提醒分批換美元）</label><input id="fxLow" type="number" step="0.1" value="${esc(s.fxLow ?? 28)}" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveFxCash">儲存</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">IBKR Flex Query 連線（唯讀）</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px;line-height:1.7">
        ① Client Portal → <b>Performance &amp; Reports → Flex Queries</b> → Activity Flex Query 按「＋」新增，勾選五個區塊（欄位都全選）：
        <b>Open Positions</b>（持倉）、<b>Cash Report</b>（各幣別現金）、<b>Trades</b>（成交——交易摘要與 XIRR 用）、
        <b>Cash Transactions</b>（股息/利息現金流）、<b>Net Asset Value (NAV) in Base</b>（官方淨值摘要——融資槓桿與斷頭距離用）。
        格式 <b>XML</b>、期間建議 <b>Last 365 Calendar Days</b> → 儲存後記下 <b>Query ID</b>。<br>
        ② 右上頭像 → <b>Settings → Account Settings → Flex Web Service</b> → 啟用並產生 <b>Token</b>（效期可設一年）。<br>
        ③ 兩者貼到下方儲存，再到「投資組合」頁按 <b>IBKR 同步</b>：持倉會自動合併（股數/均價/現價），各幣別現金更新到帳戶。
        此 Token 僅能讀取報表，<b>無法下單或轉帳</b>。
      </p>
      <div class="form-grid">
        <div class="full"><label>Flex Web Service Token</label><input id="flexToken" type="password" value="${esc(s.ib?.flexToken || '')}" placeholder="貼上 token" /></div>
        <div class="full"><label>Flex Query ID</label><input id="flexQueryId" value="${esc(s.ib?.flexQueryId || '')}" placeholder="例：123456" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveIb">儲存 IB 設定</button></div>
    </div>

    <h2 class="section-title">訂閱追蹤</h2>
    <div class="card" style="margin-bottom:18px">
      <p class="muted" style="font-size:12px">續費日／停用日前 7 天內會在總覽提醒（固定值）。目前沒有其他可調整的設定——想把提醒天數開放成可調整，跟我說一聲。</p>
    </div>

    <h2 class="section-title">卡片追蹤</h2>
    <div class="card" style="margin-bottom:18px">
      <p class="muted" style="font-size:12px">繳款日前 7 天內會在總覽提醒、3 天內升級為警告（固定值）。目前沒有其他可調整的設定——想調整跟我說一聲。</p>
    </div>

    <h2 class="section-title">保險追蹤</h2>
    <div class="card" style="margin-bottom:18px">
      <p class="muted" style="font-size:12px">保費繳費前 30 天內提醒（7 天內升級為警告）、保單保障到期前 90 天提醒（固定值）。目前沒有其他可調整的設定——想調整跟我說一聲。</p>
    </div>

    <h2 class="section-title">資料與備份</h2>

    <div class="card">
      <h3 style="margin-bottom:6px">資料備份</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">所有資料只存在本機 <code>data/store.db</code>（SQLite）。建議定期匯出備份（匯出格式為 JSON）。</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a class="btn" href="/api/export" download>${icon('download', 16)}匯出備份 (JSON)</a>
        <button class="btn-ghost" id="importBtn">${icon('upload', 16)}匯入備份</button>
        <input type="file" id="importFile" accept="application/json" style="display:none" />
      </div>
    </div>
  `;

  byId('savePrinciples').onclick = async () => {
    await api('/settings', { method: 'PUT', body: {
      ibConcentrationPct: Number(val('ibConcentrationPct')),
      equityCapPct: Number(val('equityCapPct')),
      countryCapPct: Number(val('countryCapPct')),
      chinaCapPct: Number(val('chinaCapPct')),
      levCapPct: Number(val('levCapPct')),
      ibMaintenancePct: Number(val('ibMaintenancePct'))
    }});
    toast('投資原則已儲存');
  };
  // 提醒門檻已依分頁拆成三張卡（收支／資產配置／投資組合），各自儲存自己的欄位（PUT /settings 為部分更新）
  byId('saveEfund').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { emergencyFundMonths: Number(val('emergencyFundMonths')) } });
    toast('已儲存');
  };
  byId('saveAlloc').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { allocationDriftPct: Number(val('allocationDriftPct')) } });
    toast('已儲存');
  };
  byId('saveFxCash').onclick = async () => {
    await api('/settings', { method: 'PUT', body: {
      usdTwd: Number(val('usdTwd')),
      ibIdleCashAlert: Number(val('ibIdleCashAlert')),
      fxHigh: Number(val('fxHigh')),
      fxLow: Number(val('fxLow'))
    }});
    toast('已儲存');
  };
  byId('saveIb').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { ib: { flexToken: val('flexToken'), flexQueryId: val('flexQueryId') } } });
    toast('IB 設定已儲存，可到 IB 投資組合頁同步');
  };
  byId('manageCatsBtn').onclick = async () => {
    try { openCategoryEditor(await api('/categories')); }
    catch (err) { toast('讀取分類失敗：' + err.message, true); }
  };
  byId('normBranchBtn').onclick = async () => {
    try {
      const prev = await api('/statement/normalize-branches', { method: 'POST', body: { dryRun: true } });
      if (!prev.changed) { toast('沒有需要整理的說明格式'); return; }
      openBranchPreview(prev.changed, prev.changes || []);
    } catch (err) { toast('整理失敗：' + err.message, true); }
  };
  // 帳單店名／分類學習（合併卡）：編輯這一列的顯示名＋分類——以「帳單原文」為準
  //（同原文整批改＋記學習，未來匯入沿用；不同分店可各自取名/分類。2026-07-18 使用者定）
  const expParents = Object.keys(expTree || {});
  view().querySelectorAll('[data-editstore]').forEach(b => b.onclick = () => {
    const el = /** @type {HTMLElement} */ (b);
    const orig = el.dataset.editstore || '';
    const cur = el.dataset.cur || '', cat0 = el.dataset.cat || '', sub0 = el.dataset.sub || '';
    const catOpts = (cat0 && !expParents.includes(cat0)) ? [cat0, ...expParents] : expParents;   // 保留目前值（防默默改資料）
    openForm({
      title: '編輯店名與分類（只影響這一列）',
      fields: [
        { key: 'name', label: `原文「${orig}」的顯示名`, type: 'text', required: true, full: true },
        { key: 'category', label: '分類', type: 'select', options: catOpts, default: cat0 || expParents[0] },
        { key: 'subcategory', label: '子類（可留白）', type: 'select', options: [] }   // 由 onMount 依分類連動
      ],
      values: { name: cur, category: cat0, subcategory: sub0 },
      onMount: (/** @type {any} */ root) => {
        const catSel = root.querySelector('#f_category');
        const subSel = root.querySelector('#f_subcategory');
        const fill = (/** @type {string} */ parent, /** @type {string} */ curSub) => {
          const subs = ['', ...((expTree || {})[parent] || [])];
          if (curSub && !subs.includes(curSub)) subs.unshift(curSub);
          subSel.innerHTML = subs.map(x => `<option value="${esc(x)}" ${x === curSub ? 'selected' : ''}>${x === '' ? '（不分子類）' : esc(x)}</option>`).join('');
        };
        fill(catSel.value, sub0);
        catSel.onchange = () => fill(catSel.value, '');
        // 還原自動判斷：整列恢復系統的自動店名＋自動分類、清除這一列的學習
        const rb = document.createElement('button');
        rb.type = 'button'; rb.className = 'btn-ghost'; rb.textContent = '還原自動判斷';
        rb.onclick = async () => {
          if (!confirm('還原成系統自動判斷的店名與分類？（此原文的所有記錄一起還原，並清除學習）')) return;
          try {
            const r = await api('/statement/rename-store', { method: 'POST', body: { orig, reset: true } });
            root.querySelector('.x-close').click();
            toast(`已還原 ${r.changed} 筆`);
            renderSettings();
          } catch (e2) { toast('還原失敗：' + e2.message, true); }
        };
        root.querySelector('.form-actions')?.prepend(rb);
      },
      onSubmit: async (d) => {
        const r = await api('/statement/rename-store', { method: 'POST', body: { orig, name: d.name, category: d.category, subcategory: d.subcategory || '' } });
        toast(`已更新 ${r.changed} 筆記錄`);
        renderSettings();
      }
    });
  });
  byId('importBtn').onclick = () => byId('importFile').click();
  byId('importFile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('匯入會覆蓋目前所有資料，確定嗎？')) return;
    try { await api('/import', { method: 'POST', body: JSON.parse(await file.text()) }); toast('已匯入'); location.hash = 'dashboard'; }
    catch (err) { toast('匯入失敗：' + err.message, true); }
  };
}

// 店名格式整理的預覽彈窗：可捲動的 before→after 清單＋套用/取消（比 confirm 更適合逐筆核對大量變更）。
/** @param {number} count @param {{id:string,before:string,after:string}[]} changes */
function openBranchPreview(count, changes) {
  const root = byId('modal-root');
  const rows = changes.map(c => `<tr><td>${esc(c.before)}</td><td class="muted" style="text-align:center">→</td><td><b>${esc(c.after)}</b></td></tr>`).join('');
  const capNote = count > changes.length
    ? `<p class="muted" style="font-size:11px;margin-top:8px">（清單僅顯示前 ${changes.length} 筆，套用時會處理全部 ${count} 筆）</p>` : '';
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('md')}">
    <div class="modal-head"><h2>店名格式整理預覽</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p class="muted" style="font-size:12px;margin-bottom:10px">共 <b>${count}</b> 筆說明會整理成統一格式（分店括號、品牌名）。套用前會自動備份、可重複執行。請確認以下變更：</p>
      <div class="tbl-wrap" style="max-height:46vh;overflow:auto"><table>
        <thead><tr><th>目前說明</th><th></th><th>整理後</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      ${capNote}
      <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button><button type="button" class="btn" id="branchApply">套用整理（${count} 筆）</button></div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  bindBackdropClose(root, close);
  byId('branchApply').onclick = async () => {
    try {
      const r = await api('/statement/normalize-branches', { method: 'POST', body: {} });
      close();
      toast(r.changed ? `已整理 ${r.changed} 筆說明格式` : '沒有需要整理的說明格式');
      renderSettings();
    } catch (err) { toast('整理失敗：' + err.message, true); }
  };
}

// 分類管理編輯器：把整棵分類樹載入成可編輯狀態（每列記「原名」以偵測改名），一次儲存。
// 為保留輸入焦點：打字時不重繪，只有結構性動作（新增/刪除/搬移）才 syncFromDom→重繪。
/** @param {Record<string,string[]>} tree */
function openCategoryEditor(tree) {
  const root = byId('modal-root');
  // 狀態：[{orig, name, subs:[{orig,name}]}]，orig=null＝新增（非改名）；'其他'／'未分類' 受保護不可刪改
  /** @type {{orig: string|null, name: string, subs: {orig: string|null, name: string}[]}[]} */
  const state = Object.entries(tree || {}).map(([name, subs]) => ({
    orig: /** @type {string|null} */ (name), name, subs: (subs || []).map(s => ({ orig: /** @type {string|null} */ (s), name: s }))
  }));
  const isOther = (p) => p.orig === '其他';

  const syncFromDom = () => {
    root.querySelectorAll('input.cat-name').forEach(inp => { const p = Number(inp.dataset.p); if (state[p]) state[p].name = inp.value; });
    root.querySelectorAll('input.sub-name').forEach(inp => { const p = Number(inp.dataset.p), s = Number(inp.dataset.s); if (state[p] && state[p].subs[s]) state[p].subs[s].name = inp.value; });
  };

  const blockHtml = (p, i) => `
    <div class="cat-block">
      <div class="cat-block-head">
        <input class="cat-name" data-p="${i}" value="${esc(p.name)}" placeholder="大類名稱" ${isOther(p) ? 'readonly title="系統退路，不可改名"' : ''} />
        <span class="cat-block-btns">
          <button type="button" class="btn-icon" data-act="up" data-p="${i}" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn-icon" data-act="down" data-p="${i}" title="下移" ${i === state.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn-icon danger" data-act="delP" data-p="${i}" title="刪除大類" ${isOther(p) ? 'disabled' : ''}>✕</button>
        </span>
      </div>
      <div class="cat-subs">
        ${p.subs.map((s, j) => { const lock = isOther(p) && s.orig === '未分類';
          return `<span class="sub-chip"><input class="sub-name" data-p="${i}" data-s="${j}" value="${esc(s.name)}" placeholder="子類" ${lock ? 'readonly' : ''} /><button type="button" class="sub-x" data-act="delS" data-p="${i}" data-s="${j}" title="刪除子類" ${lock ? 'disabled' : ''}>×</button></span>`; }).join('')}
        <button type="button" class="btn-ghost btn-sm" data-act="addS" data-p="${i}">＋子類</button>
      </div>
    </div>`;

  const redraw = () => { byId('catEditorBody').innerHTML = state.map((p, i) => blockHtml(p, i)).join(''); };

  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('lg')}">
    <div class="modal-head"><h2>分類管理</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p class="muted" style="font-size:12px;margin-bottom:10px">改名會套用到所有舊交易與學習表；刪除有交易的分類，那些交易會改歸「其他／未分類」。收入分類固定、不在此。</p>
      <div id="catEditorBody" style="max-height:52vh;overflow:auto"></div>
      <div style="margin-top:10px"><button type="button" class="btn-ghost btn-sm" data-act="addP">＋ 新增大類</button></div>
      <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button><button type="button" class="btn" id="catSave">儲存分類</button></div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  bindBackdropClose(root, close);
  redraw();

  // 委派按鈕事件（結構性動作：先 syncFromDom 保住已打的字，再改 state、重繪）
  root.querySelector('.modal-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act, p = Number(btn.dataset.p), s = Number(btn.dataset.s);
    syncFromDom();
    if (act === 'addP') state.push({ orig: null, name: '', subs: [] });
    else if (act === 'delP') { if (state[p] && !isOther(state[p])) state.splice(p, 1); }
    else if (act === 'up') { if (p > 0) [state[p - 1], state[p]] = [state[p], state[p - 1]]; }
    else if (act === 'down') { if (p < state.length - 1) [state[p + 1], state[p]] = [state[p], state[p + 1]]; }
    else if (act === 'addS') { if (state[p]) state[p].subs.push({ orig: null, name: '' }); }
    else if (act === 'delS') { const sub = state[p]?.subs[s]; if (state[p] && !(isOther(state[p]) && sub?.orig === '未分類')) state[p].subs.splice(s, 1); }
    else return;
    redraw();
  });

  byId('catSave').onclick = async () => {
    syncFromDom();
    /** @type {Record<string,string[]>} */
    const outTree = {};
    /** @type {{from:string,to:string}[]} */
    const parentRenames = [];
    /** @type {{parent:string,from:string,to:string}[]} */
    const subRenames = [];
    const seenP = new Set();
    for (const p of state) {
      const name = p.name.trim();
      if (!name) return toast('有大類名稱是空的，請填寫或刪除', true);
      if (seenP.has(name)) return toast(`大類「${name}」重複了`, true);
      seenP.add(name);
      const subs = []; const seenS = new Set();
      for (const s of p.subs) {
        const sn = s.name.trim();
        if (!sn) return toast(`「${name}」底下有子類是空的，請填寫或刪除`, true);
        if (seenS.has(sn)) return toast(`「${name}」的子類「${sn}」重複了`, true);
        seenS.add(sn); subs.push(sn);
        if (s.orig && s.orig !== sn) subRenames.push({ parent: name, from: s.orig, to: sn });
      }
      outTree[name] = subs;
      if (p.orig && p.orig !== name) parentRenames.push({ from: p.orig, to: name });
    }
    try {
      const r = await api('/categories', { method: 'POST', body: { tree: outTree, parentRenames, subRenames } });
      close();
      const n = r.changedTx || 0;
      toast(n ? `分類已儲存，${n} 筆舊交易一併更新` : '分類已儲存');
      renderSettings();
    } catch (err) { toast('儲存失敗：' + err.message, true); }
  };
}
const val = (id) => byId(id).value;
