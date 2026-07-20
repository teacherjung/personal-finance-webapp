// @ts-check
import { api, view, byId, esc, toast, modalSizeClass, bindBackdropClose, openForm } from '../app.js';
import { icon } from './icons.js';

export async function renderSettings() {
  const [s, txs, expTree, health, rulesRes, orphans] = await Promise.all([
    api('/settings'), api('/transactions'), api('/categories'),
    api('/statement/health').catch(() => ({ items: [], dismissed: 0 })),
    api('/statement/rules').catch(() => ({ rules: null })),
    api('/statement/learned/orphans').catch(() => ({ items: [], total: 0 }))]);
  const myRules = rulesRes?.rules || null;
  const ruleCount = myRules ? Object.values(myRules).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0) : 0;
  // 帳單說明／分類學習（合併卡，使用者定 2026-07-18）：一列＝一個帳單原文（藏在 stmtRef 第 4 段），
  // 顯示名/分類取「該原文最新一筆」為代表（編輯時整批統一）。編輯以原文為準——不同分店各自取名/分類。
  const byOrig = new Map();
  const keyCount = new Map();   // 品牌鑰匙 → 帳單交易總筆數（「同店一起改」算「其他 N 筆」用）
  for (const t of txs || []) {
    if (t.source !== 'stmt' || !t.stmtRef) continue;
    const parts = String(t.stmtRef).split('|');   // stmtRef＝卡id|消費日|金額|原始說明
    if (parts.length < 4) continue;
    const orig = parts.slice(3).join('|').trim();   // 原文可能含「|」→ 取第 3 個分隔後全部
    if (!orig) continue;
    const k = String(t.storeKey || '').trim();
    if (k) keyCount.set(k, (keyCount.get(k) || 0) + 1);
    const prev = byOrig.get(orig);
    const cnt = (prev?.cnt || 0) + 1;
    if (!prev || String(t.date || '') > prev.date) {
      byOrig.set(orig, { orig, cnt, date: String(t.date || ''), cur: String(t.note || '').trim(),
        key: k, cat: String(t.category || ''), sub: String(t.subcategory || '') });
    } else prev.cnt = cnt;
  }
  const storeRows = [...byOrig.values()].sort((a, b) => a.cur.localeCompare(b.cur, 'zh-Hant'));
  // 三層一次看（使用者定 2026-07-18）：帳單原文（銀行印的）→ 身分鑰匙（辨識同一家店的乾淨名，學習用）→ 顯示名（你看到的，可自訂）
  const storeMapRows = storeRows.length ? `<div class="tbl-wrap" style="max-height:44vh;overflow:auto"><table>
        <thead><tr><th>帳單原文</th><th>身分鑰匙</th><th>顯示名</th><th>分類</th><th></th></tr></thead>
        <tbody>${storeRows.map(p => `<tr><td class="muted">${esc(p.orig)}</td><td class="muted">${esc(p.key || '—')}</td><td>${esc(p.cur)}</td>
          <td>${esc(p.cat)}${p.sub ? ` <span class="muted">· ${esc(p.sub)}</span>` : ''}</td>
          <td style="width:36px"><button class="btn-link btn-sm" data-editstore="${esc(p.orig)}" data-cur="${esc(p.cur)}" data-cat="${esc(p.cat)}" data-sub="${esc(p.sub)}" data-key="${esc(p.key)}" data-others="${Math.max(0, (keyCount.get(p.key) || 0) - p.cnt)}" title="編輯這一列的店名與分類">${icon('edit', 15)}</button></td></tr>`).join('')}</tbody></table></div>`
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
      <h3 style="margin-bottom:6px">店名規則（自己加規則）${ruleCount ? `<span class="store-rank">${ruleCount} 條</span>` : ''}</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">以前發現店名要改，得等我改程式；現在你可以<b>自己加規則</b>。可以做四件事：把同一家店的不同寫法<b>合併</b>、把銀行截斷的名字<b>併回品牌名</b>（分店保留）、單純<b>改個名字</b>、告訴系統某個<b>連鎖</b>怎麼切分店。填的都是普通文字、不是程式碼。改完先<b>預覽影響</b>再儲存，儲存後立刻套用到所有舊記錄（套用前會另存一份還原檔 <code>data/store.db.pre-rules.bak</code>）。</p>
      <div><button class="btn-ghost" id="storeRulesBtn">${icon('edit', 16) || ''}編輯店名規則</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">帳務體檢 ${health.items.length ? `<span class="store-rank">${health.items.length} 件待確認</span>` : '<span class="muted" style="font-size:12px">✅ 目前乾淨</span>'}</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">系統主動檢查可疑的店名、身分鑰匙與分類問題（同店被拆成兩把鑰匙、分期分裂、未分類累積、名字殘留雜訊…），排成清單讓你一鍵處理或略過。每次開啟即時重算，按過略過的不再出現${health.dismissed ? `（已略過 ${health.dismissed} 件）` : ''}。</p>
      <div><button class="btn-ghost" id="healthBtn">${icon('refresh', 16) || ''}開始體檢</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">帳單說明／分類學習</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">信用卡匯入時會自動清理店名、自動判斷分類；你改過的（店名或分類）系統會記住，下次匯入同一家店自動套用（優先於內建規則）。三欄＝店名的三層：<b>帳單原文</b>（銀行印的）→ <b>身分鑰匙</b>（辨識「同一家店」用，<b>只到品牌、不含分店</b>——所以各分店的消費會合併統計；所有加油站一律算「加油站」）→ <b>顯示名</b>（你看到的，含分店、可自訂）。<b>按列尾的編輯鈕可直接改這一列的顯示名與分類</b>——同原文的各月份記錄整批改；彈窗裡的「還原自動判斷」＝清除自訂、恢復系統判斷。共 ${storeRows.length} 家店，依顯示名排序。</p>
      ${storeMapRows}
      ${orphans.items.length ? `<p class="muted" style="font-size:12px;margin-top:12px">另有 <b>${orphans.items.length}</b> 條學習規則目前沒對到任何記錄（刪過那批帳單、或改過店名規則），平常看不到但下次匯入仍會生效。<button class="btn-link btn-sm" id="orphanBtn">查看／清理</button></p>` : ''}
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
        ① Client Portal → <b>Performance &amp; Reports → Flex Queries</b> → Activity Flex Query 按「＋」新增，勾選六個區塊（欄位都全選）：
        <b>Open Positions</b>（持倉）、<b>Cash Report</b>（各幣別現金）、<b>Trades</b>（成交——交易摘要與 XIRR 用）、
        <b>Cash Transactions</b>（股息/利息現金流）、<b>Net Asset Value (NAV) in Base</b>（官方淨值摘要——融資槓桿與斷頭距離用）、
        <b>Account Information</b>（至少勾 <b>Currency</b>＝帳戶基準幣別——現金報表只有彙總列時靠它判定入帳幣別）。
        格式 <b>XML</b>、期間建議 <b>Last 365 Calendar Days</b> → 儲存後記下 <b>Query ID</b>。<br>
        ② 右上頭像 → <b>Settings → Account Settings → Flex Web Service</b> → 啟用並產生 <b>Token</b>（效期可設一年）。<br>
        ③ 兩者貼到下方儲存，再到「投資組合」頁按 <b>IBKR 同步</b>：持倉會自動合併（股數/均價/現價），各幣別現金更新到帳戶。
        此 Token 僅能讀取報表，<b>無法下單或轉帳</b>。
      </p>
      <div class="form-grid">
        <div class="full"><label>Flex Web Service Token</label><input id="flexToken" type="password" value="" placeholder="${s.ib?.flexTokenSet ? '已設定，留空＝不變更' : '貼上 token'}" /></div>
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

  // 小工具（自主體檢 #13）：儲存失敗別假報「已儲存」——包 try/catch，錯誤讓使用者看得見
  const saveSettings = async (/** @type {any} */ body, /** @type {string} */ okMsg) => {
    try { await api('/settings', { method: 'PUT', body }); toast(okMsg); }
    catch (err) { toast('儲存失敗：' + (/** @type {any} */ (err).message || ''), true); }
  };
  byId('savePrinciples').onclick = () => saveSettings({
    ibConcentrationPct: Number(val('ibConcentrationPct')),
    equityCapPct: Number(val('equityCapPct')),
    countryCapPct: Number(val('countryCapPct')),
    chinaCapPct: Number(val('chinaCapPct')),
    levCapPct: Number(val('levCapPct')),
    ibMaintenancePct: Number(val('ibMaintenancePct'))
  }, '投資原則已儲存');
  // 提醒門檻已依分頁拆成三張卡（收支／資產配置／投資組合），各自儲存自己的欄位（PUT /settings 為部分更新）
  byId('saveEfund').onclick = () => saveSettings({ emergencyFundMonths: Number(val('emergencyFundMonths')) }, '已儲存');
  byId('saveAlloc').onclick = () => saveSettings({ allocationDriftPct: Number(val('allocationDriftPct')) }, '已儲存');
  byId('saveFxCash').onclick = () => saveSettings({
    usdTwd: Number(val('usdTwd')),
    ibIdleCashAlert: Number(val('ibIdleCashAlert')),
    fxHigh: Number(val('fxHigh')),
    fxLow: Number(val('fxLow'))
  }, '已儲存');
  byId('saveIb').onclick = () => {
    // flexToken 留空＝不變更（後端 ib 是巢狀合併，不送就保留舊 token，自主體檢 Q3）
    const ib = /** @type {any} */ ({ flexQueryId: val('flexQueryId') });
    if (val('flexToken')) ib.flexToken = val('flexToken');
    saveSettings({ ib }, 'IB 設定已儲存，可到 IB 投資組合頁同步');
  };
  byId('manageCatsBtn').onclick = async () => {
    try { openCategoryEditor(await api('/categories')); }
    catch (err) { toast('讀取分類失敗：' + err.message, true); }
  };
  // 帳單說明／分類學習（合併卡）：編輯這一列的顯示名＋分類——以「帳單原文」為準
  //（同原文整批改＋記學習，未來匯入沿用；不同分店可各自取名/分類。2026-07-18 使用者定）
  const expParents = Object.keys(expTree || {});
  view().querySelectorAll('[data-editstore]').forEach(b => b.onclick = () => {
    const el = /** @type {HTMLElement} */ (b);
    const orig = el.dataset.editstore || '';
    const cur = el.dataset.cur || '', cat0 = el.dataset.cat || '', sub0 = el.dataset.sub || '';
    // 同店一起改（使用者定 2026-07-19，與收支列表編輯同一招）：同品牌鑰匙下「其他原文」還有幾筆
    const key = el.dataset.key || '', others = Number(el.dataset.others || 0);
    const catOpts = (cat0 && !expParents.includes(cat0)) ? [cat0, ...expParents] : expParents;   // 保留目前值（防默默改資料）
    openForm({
      title: '編輯店名與分類（只影響這一列）',
      fields: [
        { key: 'name', label: `原文「${orig}」的顯示名`, type: 'text', required: true, full: true },
        { key: 'category', label: '分類', type: 'select', options: catOpts, default: cat0 || expParents[0] },
        { key: 'subcategory', label: '子類（可留白）', type: 'select', options: [] },   // 由 onMount 依分類連動
        ...(key && others > 0 ? [{ key: 'applyAll', label: `同時套用分類到「${key}」的其他 ${others} 筆記錄（顯示名不會跟過去）`, type: 'checkbox', full: true }] : []),
      ],
      values: { name: cur, category: cat0, subcategory: sub0 },
      onMount: (/** @type {any} */ root) => {
        const catSel = root.querySelector('#f_category');
        const subSel = root.querySelector('#f_subcategory');
        const fill = (/** @type {string} */ parent, /** @type {string} */ curSub) => {
          const subs = ['', ...((Object.hasOwn(expTree || {}, parent) && (expTree || {})[parent]) || [])];   // hasOwn（Codex r8#3）：同 transactions.js subOptions
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
            // 同品牌共用的分類規則不會被自動清（清了會誤傷其他分店），但留著代表「還原只是暫時的」：
            // 下次匯入本原文又會被套回舊分類 → 問使用者要不要一起清（Codex#4）
            if (r.brandRule && confirm(`「${r.brandRule.key}」還有同品牌共用的分類規則（另 ${r.brandRule.sharedCount} 個帳單原文在用）。\n不清除的話，下次匯入這家店會再被套回舊分類。\n\n要一併清除嗎？（會影響同品牌其他分店）`)) {
              await api('/statement/rename-store', { method: 'POST', body: { orig, reset: true, clearBrand: true } });
              toast('已一併清除同品牌分類規則');
            }
            renderSettings();
          } catch (e2) { toast('還原失敗：' + e2.message, true); }
        };
        root.querySelector('.form-actions')?.prepend(rb);
      },
      onSubmit: async (d) => {
        const r = await api('/statement/rename-store', { method: 'POST', body: { orig, name: d.name, category: d.category, subcategory: d.subcategory || '' } });
        if (d.applyAll && key) {
          const r2 = await api('/statement/apply-category', { method: 'POST',
            body: { storeKey: key, category: d.category, subcategory: d.subcategory || '' } });
          toast(`已更新 ${r.changed} 筆，並把「${key}」的其他 ${r2.changed} 筆一起改成 ${d.category}${d.subcategory ? `·${d.subcategory}` : ''}`);
        } else toast(`已更新 ${r.changed} 筆記錄`);
        renderSettings();
      }
    });
  });
  byId('healthBtn').onclick = () => openHealthCheck();
  byId('storeRulesBtn').onclick = () => openStoreRulesEditor(myRules);
  if (orphans.items.length) byId('orphanBtn').onclick = () => openOrphanLearned(orphans);
  byId('importBtn').onclick = () => byId('importFile').click();
  byId('importFile').onchange = async (e) => {
    const input = e.target;
    const file = input.files[0]; if (!file) return;
    try {
      if (!confirm('匯入會覆蓋目前所有資料，確定嗎？')) return;
      await api('/import', { method: 'POST', body: JSON.parse(await file.text()) });
      toast('已匯入'); location.hash = 'dashboard';
    } catch (err) { toast('匯入失敗：' + err.message, true); }
    finally { input.value = ''; }   // 清空（自主體檢）：不清的話取消 confirm 或匯入失敗後，同一檔案重選不觸發 onchange
  };
}

// ---------- 帳務體檢佇列（第二帖，使用者定 2026-07-19） ----------
// 佇列即時算（GET /statement/health）；動作走既有端點：未分類→apply-category（品牌層）、
// 分類漂移→rename-store（原文層，改成自動 or 保留現值）、鑰匙類→複製回報文字貼給 Claude。
// 每個動作完成後整窗重新抓資料重畫（項目消失＝真的修好，不是前端假裝）。
async function openHealthCheck() {
  const root = byId('modal-root');
  const [health, tree] = await Promise.all([api('/statement/health'), api('/categories')]);
  const parents = Object.keys(tree || {});
  const catSelHtml = (/** @type {number} */ i) => `<select data-hcat="${i}" style="width:auto;max-width:9em">${parents.map(c => `<option>${esc(c)}</option>`).join('')}</select>
    <select data-hsub="${i}" style="width:auto;max-width:9em">${['', ...(tree[parents[0]] || [])].map(x => `<option value="${esc(x)}">${x === '' ? '（不分子類）' : esc(x)}</option>`).join('')}</select>`;
  const rowHtml = (/** @type {any} */ it, /** @type {number} */ i) => {
    const chipCls = it.severity >= 3 ? 'red' : it.severity === 2 ? 'amber' : '';
    const act = it.type === 'uncategorized' ? `${catSelHtml(i)} <button class="btn-ghost btn-sm" data-hfix="${i}">套用</button>`
      : it.type === 'cat-drift' ? `<button class="btn-ghost btn-sm" data-hauto="${i}">改成自動</button> <button class="btn-ghost btn-sm" data-hkeep="${i}">保留現值</button>`
      : `<button class="btn-ghost btn-sm" data-hcopy="${i}" title="複製問題描述，貼給 Claude 加規則">複製回報</button>`;
    return `<div class="health-row"><span class="tag ${chipCls}" style="white-space:nowrap">${esc(it.chip)}</span>
      <div class="health-desc">${esc(it.desc)}</div>
      <div class="health-acts">${act} <button class="btn-link btn-sm" data-hskip="${i}" title="這是正常的，別再提醒">略過</button></div></div>`;
  };
  const items = health.items || [];
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('lg')}">
    <div class="modal-head"><h2>帳務體檢${items.length ? `（${items.length} 件待確認）` : ''}</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      ${items.length ? `<p class="muted" style="font-size:12px;margin-bottom:10px">這些是系統覺得「怪怪的」的地方——不一定是錯，你說了算：處理、或按略過讓它永久安靜。</p>
        <div style="max-height:56vh;overflow:auto">${items.map(rowHtml).join('')}</div>`
        : '<p class="empty">目前一切乾淨 ✅ 沒有待確認的項目。</p>'}
      <div class="form-actions">
        ${health.dismissed ? `<button type="button" class="btn-link" data-hreset>重新顯示已略過的 ${health.dismissed} 件</button>` : ''}
        <button type="button" class="btn" data-close>關閉</button></div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-close]').onclick = close;
  bindBackdropClose(root, close);
  const redo = async (/** @type {string} */ msg) => { toast(msg); await openHealthCheck(); };
  root.querySelector('[data-hreset]')?.addEventListener('click', async () => {
    await api('/statement/health/dismiss', { method: 'POST', body: { clearAll: true } });
    redo('已重新顯示全部項目');
  });
  root.querySelectorAll('[data-hskip]').forEach(b => b.addEventListener('click', async () => {
    const it = items[Number(/** @type {HTMLElement} */ (b).dataset.hskip)];
    try {
      await api('/statement/health/dismiss', { method: 'POST', body: { id: it.id } });
      redo('已略過（同一狀況不再提醒）');
    } catch (e) { toast('略過失敗：' + e.message, true); await openHealthCheck(); }   // 資料已變動→重抓最新佇列
  }));
  root.querySelectorAll('[data-hcopy]').forEach(b => b.addEventListener('click', async () => {
    const it = items[Number(/** @type {HTMLElement} */ (b).dataset.hcopy)];
    try { await navigator.clipboard.writeText(String(it.data.report || it.desc)); toast('已複製，貼給 Claude 就能加規則 📋'); }
    catch { toast('複製失敗，請手動選取', true); }
  }));
  // 未分類：分類連動子類 → 套用（apply-category＝整店改＋品牌層學習）
  root.querySelectorAll('[data-hcat]').forEach(sel => sel.addEventListener('change', () => {
    const i = /** @type {HTMLElement} */ (sel).dataset.hcat;
    const sub = root.querySelector(`[data-hsub="${i}"]`);
    const subs = ['', ...(tree[/** @type {HTMLSelectElement} */ (sel).value] || [])];
    sub.innerHTML = subs.map(x => `<option value="${esc(x)}">${x === '' ? '（不分子類）' : esc(x)}</option>`).join('');
  }));
  root.querySelectorAll('[data-hfix]').forEach(b => b.addEventListener('click', async () => {
    const i = Number(/** @type {HTMLElement} */ (b).dataset.hfix);
    const it = items[i];
    const cat = /** @type {HTMLSelectElement} */ (root.querySelector(`[data-hcat="${i}"]`)).value;
    const sub = /** @type {HTMLSelectElement} */ (root.querySelector(`[data-hsub="${i}"]`)).value;
    try {
      const r = await api('/statement/apply-category', { method: 'POST', body: { storeKey: it.data.key, category: cat, subcategory: sub } });
      redo(`已把「${it.data.key}」${r.changed} 筆歸到 ${cat}${sub ? `·${sub}` : ''}，以後也自動歸`);
    } catch (e) { toast('套用失敗：' + e.message, true); }
  }));
  // 分類漂移：改成自動（分類跟上現行規則、名字不動）／保留現值（把現值學起來，之後不再報）
  const drift = async (/** @type {any} */ it, /** @type {{category: string, subcategory: string}} */ target, /** @type {string} */ msg) => {
    try {
      await api('/statement/rename-store', { method: 'POST',
        body: { orig: it.data.orig, name: it.data.note || it.data.orig, category: target.category, subcategory: target.subcategory || '' } });
      redo(msg);
    } catch (e) { toast('處理失敗：' + e.message, true); }
  };
  root.querySelectorAll('[data-hauto]').forEach(b => b.addEventListener('click', () => {
    const it = items[Number(/** @type {HTMLElement} */ (b).dataset.hauto)];
    drift(it, it.data.auto, `已改成 ${it.data.auto.category}${it.data.auto.subcategory ? `·${it.data.auto.subcategory}` : ''}（${it.data.count} 筆）`);
  }));
  root.querySelectorAll('[data-hkeep]').forEach(b => b.addEventListener('click', () => {
    const it = items[Number(/** @type {HTMLElement} */ (b).dataset.hkeep)];
    drift(it, it.data.current, '已把現在的分類學起來，之後不再提醒');
  }));
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
    const outTree = Object.create(null);   // 大類名是使用者文字：普通物件遇「__proto__」不是寫鍵、是換原型——鍵在送出前就消失，後端收到 {} 卻回報「儲存成功」（Codex r6#3）。null-proto 讓保留字成為自有鍵、真的送到後端拿 400，使用者才看得到真錯誤
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
// ---------- 店名規則自助管理（第三帖，使用者定 2026-07-19） ----------
// 以前每發現一條店名規則要改，就得等 Claude 改程式→PR→合併→重啟。這裡把規則變成可編輯的資料。
// 兩個 UI 上的堅持：
// ①**表單而非正規表示式**：使用者填純文字＋選比對方式，後端負責跳脫（沒有程式背景也不會誤傷全庫）。
// ②**先預覽再儲存**：規則是全庫生效的，一條寫太寬會改壞幾百筆——所以「儲存」前一定先看到影響。
/** 五種規則的表單定義（欄位與後端 lib/store-rules.js 的形狀一一對應）。 */
const RULE_SECTIONS = [
  { key: 'canon', title: '這些寫法是同一家店', mode: true,
    hint: '帳單上同一家店有好幾種寫法時，統一成一個名字。例：帳單印「XX咖啡 A1234 Taipei」和「XX咖啡館」，填「XX咖啡」→「XX咖啡」。<b>分店會被併掉</b>（整家店算一個），要保留分店請用下面那一種。',
    ph: ['帳單上出現的字', '要顯示成'] },
  { key: 'brand', title: '併回品牌名（保留分店）', mode: false,
    hint: '銀行把店名截斷成兩種寫法、變成兩家店時用這個。例：「好麥永和豆漿」和「好麥永和豆漿店」是同一家 → 填「好麥永和豆漿」→「好麥永和豆漿店」。後面的分店名會保留。',
    ph: ['開頭是（含被截斷的寫法）', '完整品牌名'] },
  { key: 'rename', title: '顯示名改寫', mode: false,
    hint: '單純想換個看得順眼的名字。例：「全家便利商店」→「全家商店」。只換字、分店與其他部分都保留。',
    ph: ['原本的字', '改成'] },
  { key: 'chains', title: '連鎖店（沒有分隔符也要切分店）', mode: false, single: true,
    hint: '帳單把品牌和分店黏在一起、中間沒有符號時用。例：填「鮮芋仙」→「鮮芋仙林口店」會變成「鮮芋仙（林口店）」。電腦看不出主體在哪結束，所以要你告訴它。',
    ph: ['連鎖品牌名'] },
  { key: 'parkExempt', title: '不要包成「停車費（…）」', mode: false, single: true,
    hint: '分類是停車費的消費，顯示名預設會包成「停車費（店名）」。有些名字包了反而怪（例：儲值、加值），填在這裡就維持原名。',
    ph: ['要維持原名的店名'] }
];

/** @param {any} rules 目前規則（後端 GET /statement/rules） */
function openStoreRulesEditor(rules) {
  const root = byId('modal-root');
  /** @type {Record<string, any[]>} 編輯中的狀態（一律轉成物件陣列，single 型的存 {to}） */
  const state = {};
  for (const sec of RULE_SECTIONS) {
    const list = (rules && rules[sec.key]) || [];
    state[sec.key] = sec.single ? list.map((/** @type {string} */ v) => ({ to: v }))
      : list.map((/** @type {any} */ e) => ({ match: e.match || '', to: e.to || '', mode: e.mode || 'contains' }));
  }

  // 打字時不重繪（保住焦點）；結構性動作（新增/刪除）才 syncFromDom→重繪，同 openCategoryEditor 的做法
  const syncFromDom = () => {
    root.querySelectorAll('[data-rk]').forEach((/** @type {any} */ inp) => {
      const row = state[inp.dataset.rk]?.[Number(inp.dataset.ri)];
      if (row) row[inp.dataset.rf] = inp.value;
    });
  };

  const rowHtml = (/** @type {any} */ sec, /** @type {any} */ r, /** @type {number} */ i) => {
    const cell = (/** @type {string} */ f, /** @type {number} */ n) =>
      `<input data-rk="${sec.key}" data-ri="${i}" data-rf="${f}" value="${esc(r[f] || '')}" placeholder="${esc(sec.ph[n])}" />`;
    const modeSel = sec.mode ? `<select data-rk="${sec.key}" data-ri="${i}" data-rf="mode">
        ${[['contains', '包含'], ['startsWith', '開頭是'], ['exact', '完全等於']].map(([v, t]) =>
    `<option value="${v}"${r.mode === v ? ' selected' : ''}>${t}</option>`).join('')}</select>` : '';
    return `<div class="rule-row">
      ${sec.single ? cell('to', 0) : `${cell('match', 0)}${modeSel}<span class="muted">→</span>${cell('to', 1)}`}
      <button type="button" class="btn-icon danger" data-ract="del" data-rk="${sec.key}" data-ri="${i}" title="刪除這條">✕</button>
    </div>`;
  };

  const secHtml = (/** @type {any} */ sec) => `
    <div class="rule-sec">
      <h4>${esc(sec.title)} <span class="muted" style="font-weight:400">（${state[sec.key].length}）</span></h4>
      <p class="muted" style="font-size:11.5px;margin:2px 0 8px">${sec.hint}</p>
      ${state[sec.key].map((r, i) => rowHtml(sec, r, i)).join('') || '<p class="empty" style="margin:0 0 6px">尚無規則</p>'}
      <button type="button" class="btn-ghost btn-sm" data-ract="add" data-rk="${sec.key}">＋ 加一條</button>
    </div>`;

  const redraw = () => { byId('ruleEditorBody').innerHTML = RULE_SECTIONS.map(secHtml).join(''); };

  /**
   * 把編輯狀態轉回後端形狀。預設丟掉「填一半」的列（送出去也會被後端丟棄，不如不送）；
   * keepPartial＝保留半成品，給「離開又回來」用——不然使用者打到一半去看預覽，回來就整片空白。
   * @param {boolean} [keepPartial]
   */
  const collect = (keepPartial = false) => {
    syncFromDom();
    /** @type {Record<string, any>} */
    const out = {};
    for (const sec of RULE_SECTIONS) {
      const rows = state[sec.key].map(r => ({ match: String(r.match || '').trim(), to: String(r.to || '').trim(), mode: r.mode || 'contains' }));
      out[sec.key] = sec.single
        ? rows.map(r => r.to).filter(r => keepPartial || r)
        : rows.filter(r => keepPartial || (r.match && r.to));
    }
    return out;
  };

  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('lg')}">
    <div class="modal-head"><h2>店名規則</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p class="muted" style="font-size:12px;margin-bottom:10px">你自己加的規則<b>優先於系統內建規則</b>。填的都是<b>普通文字</b>（不是程式碼），系統會照字面比對。
      規則對<b>全部</b>記錄生效，所以請先按「預覽影響」看看會改到哪些，確認沒問題再儲存。儲存前自動備份。</p>
      <div id="ruleEditorBody" style="max-height:50vh;overflow:auto"></div>
      <div class="form-actions">
        <button type="button" class="btn-ghost" data-cancel>取消</button>
        <button type="button" class="btn-ghost" id="rulePreview">預覽影響</button>
        <button type="button" class="btn" id="ruleSave">儲存並套用</button>
      </div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  bindBackdropClose(root, close);
  redraw();

  root.querySelector('.modal-body').addEventListener('click', (/** @type {any} */ e) => {
    const btn = e.target.closest('[data-ract]');
    if (!btn) return;
    syncFromDom();
    const k = btn.dataset.rk;
    if (btn.dataset.ract === 'add') state[k].push({ match: '', to: '', mode: 'contains' });
    else state[k].splice(Number(btn.dataset.ri), 1);
    redraw();
  });

  byId('rulePreview').onclick = async () => {
    try {
      const r = await api('/statement/rules/preview', { method: 'POST', body: { rules: collect() } });
      // 「什麼都不會改」的判斷要**把不可逆的兩種也算進去**（Codex r3#2）：
      // 孤兒學習的自訂名被改到時，changed 與 keyChanged 都是 0——只看這兩個數字就會在這裡早退，
      // 跳出「不會改動任何既有記錄」的安心訊息，然後使用者按儲存、名字就沒了。
      const nothing = !r.changed && !r.keyChanged
        && !(r.learnedConflicts || []).length && !(r.learnedNameChanges || []).length;
      if (nothing) return toast('這些規則不會改動任何既有記錄（未來匯入時仍會生效）');
      // 回上一頁＝用「目前編輯到的內容」重開編輯窗（含填一半的列）。
      // ⚠️ 不可以用 innerHTML 快照還原（實測踩到）：使用者打進 input 的字不會反映到 HTML 屬性上，
      // 還原回去會整片空白——去看一眼預覽就把心血全弄丟，是最不能忍的那種 bug。
      const snapshot = collect(true);
      openRulePreview(r, () => openStoreRulesEditor(snapshot));
    } catch (e) { toast('預覽失敗：' + e.message, true); }
  };
  byId('ruleSave').onclick = async () => {
    try {
      const rules = collect();
      // 「預覽影響」是自願按的，但學習表衝突是不可逆的——直接按儲存的人更需要被擋一下。
      // 先偷跑一次預覽，只有真的會蓋掉教過的設定時才出聲（沒衝突就安靜地存，不多一步打擾）。
      // ⚠️ 預覽失敗就**不要儲存**（Codex r3#7）：原本用 .catch(() => null) 吞掉錯誤照樣往下存，
      // 等於在「算不出有什麼不可逆變更」的情況下硬做——安全帶斷了就該停車，不是繼續開。
      let pre;
      try { pre = await api('/statement/rules/preview', { method: 'POST', body: { rules } }); }
      catch (e) { return toast('無法確認這些規則會改到什麼，為安全起見沒有儲存：' + e.message, true); }
      const cf = pre?.learnedConflicts || [];
      const nc = pre?.learnedNameChanges || [];
      // ⚠️ 用**真實總數**（Total），不是被截到 50 的陣列長度（Codex r4#5）：
      // 52 家併起來理論上 51 個衝突，明細只回 50，若用 cf.length 算，第 51 個會被無聲捨棄。
      const cfTotal = pre?.learnedConflictTotal ?? cf.length;
      const ncTotal = pre?.learnedNameChangeTotal ?? nc.length;
      if (cfTotal || ncTotal) {
        const lines = [
          ...cf.slice(0, 5).map(c => `・「${c.key}」的設定：留下 ${c.kept}，捨棄 ${c.dropped}`),
          ...nc.slice(0, 5).map(c => `・你取的店名「${c.before}」→ ${c.after || '清除'}`)
        ];
        const extra = cfTotal + ncTotal - Math.min(cf.length, 5) - Math.min(nc.length, 5);
        if (!confirm(`有 ${cfTotal + ncTotal} 項你教過／取過的東西會被蓋掉，刪掉規則也救不回來：\n\n`
          + lines.join('\n') + (extra > 0 ? `\n…另外 ${extra} 項` : '') + '\n\n確定要套用嗎？')) return;
      }
      const r = await api('/statement/rules', { method: 'POST', body: { rules } });
      close();
      const bits = [r.changed && `${r.changed} 筆顯示名`, r.keyChanged && `${r.keyChanged} 筆店家身分`,
        r.learnedNamesFixed && `${r.learnedNamesFixed} 筆學過的舊名`].filter(Boolean);
      toast(bits.length ? `規則已儲存，整理了 ${bits.join('、')} ✨` : '規則已儲存（沒有既有記錄需要整理）');
      renderSettings();
    } catch (e) { toast('儲存失敗：' + e.message, true); }
  };
}

// 規則影響預覽：只看、不套用（真正的套用在編輯窗按「儲存並套用」）——
// 分成兩件事講，因為它們的嚴重度不同：顯示名改錯了再改回來就好，**身分鑰匙**改了會影響
// 「哪些消費算同一家店」（統計、排行、學習全部跟著動），所以獨立標出來。
/** @param {{changed:number, keyChanged:number, changes:{id:string,before:string,after:string}[],
 *            learnedConflicts:{key:string,field:string,kept:string,dropped:string}[], learnedConflictTotal?:number,
 *            learnedNameChanges:{key:string,before:string,after:string}[], learnedNameChangeTotal?:number}} r
 *  @param {() => void} onBack 回到編輯窗（呼叫端負責帶著「編輯到一半的內容」重開） */
function openRulePreview(r, onBack) {
  const root = byId('modal-root');
  const rows = r.changes.map(c => `<tr><td>${esc(c.before)}</td><td class="muted" style="text-align:center">→</td><td><b>${esc(c.after)}</b></td></tr>`).join('');
  // 學習表衝突＝整個自助化唯一「刪掉規則也救不回來」的效果：兩把鑰匙併成一把時，
  // 兩邊手動教過的分類只留得下一個。不講出來的話，使用者看到「4 筆顯示名會變」就按下去了。
  const FIELD_LABEL = { category: '分類', subcategory: '子分類', name: '顯示名' };
  const conflicts = r.learnedConflicts || [];
  const nameChanges = r.learnedNameChanges || [];
  const cfTotal = r.learnedConflictTotal ?? conflicts.length, ncTotal = r.learnedNameChangeTotal ?? nameChanges.length;
  const blank = (/** @type {string} */ v) => v || '（清除，改回系統自動判斷）';
  const conflictHtml = conflicts.length ? `
    <div class="rule-warn">
      <b>⚠️ 有 ${cfTotal} 項你教過的設定會被蓋掉，而且刪掉規則也救不回來</b>
      <p>這些店被合併成同一家，但你當初教系統的答案不一樣——只能留一個：</p>
      <ul>${conflicts.map(c => `<li>「${esc(c.key)}」的${esc(FIELD_LABEL[c.field] || c.field)}：留下 <b>${esc(c.kept)}</b>，<span class="rule-drop">捨棄 ${esc(c.dropped)}</span></li>`).join('')}${cfTotal > conflicts.length ? `<li class="muted">…另外 ${cfTotal - conflicts.length} 項（清單僅顯示前 ${conflicts.length} 筆）</li>` : ''}</ul>
      <p>如果捨棄的那個才是你要的，先回去把它改成一致，再套用規則。</p>
    </div>` : '';
  // 學過的「自訂店名」被改寫／清除——比分類衝突更隱蔽：這些可能是已經沒有交易對應的孤兒學習，
  // 顯示名與鑰匙的計數都是 0，不特別講出來，畫面上會顯示成「什麼都不會改」。
  const nameHtml = nameChanges.length ? `
    <div class="rule-warn">
      <b>⚠️ 有 ${ncTotal} 個你自己取的店名會被新規則改掉，刪掉規則也還原不回來</b>
      <p>這些是你當初手動命名、系統記住的名字（有些目前沒有對應的記錄，所以上面的筆數看不到它們）：</p>
      <ul>${nameChanges.map(c => `<li>「${esc(c.key)}」：<b>${esc(c.before)}</b> → <span class="rule-drop">${esc(blank(c.after))}</span></li>`).join('')}${ncTotal > nameChanges.length ? `<li class="muted">…另外 ${ncTotal - nameChanges.length} 項（清單僅顯示前 ${nameChanges.length} 筆）</li>` : ''}</ul>
      <p>想留住原本的名字，就先回去把規則改得窄一點，別命中這幾家。</p>
    </div>` : '';
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('md')}">
    <div class="modal-head"><h2>規則影響預覽</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p class="muted" style="font-size:12px;margin-bottom:10px">套用後：<b>${r.changed}</b> 筆顯示名會改變${r.keyChanged
    ? `，<b>${r.keyChanged}</b> 筆的「店家身分」會改變（＝哪些消費算同一家店，會影響統計與排行）` : ''}。這裡只是預覽，還沒有存。</p>
      ${conflictHtml}${nameHtml}
      ${rows ? `<div class="tbl-wrap" style="max-height:${(conflicts.length || nameChanges.length) ? '28vh' : '44vh'};overflow:auto"><table>
        <thead><tr><th>目前顯示名</th><th></th><th>改成</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="empty">顯示名沒有變化（只有店家身分會變）。</p>'}
      ${r.changed > r.changes.length ? `<p class="muted" style="font-size:11px;margin-top:8px">（清單僅顯示前 ${r.changes.length} 筆）</p>` : ''}
      <div class="form-actions"><button type="button" class="btn" data-back>回去繼續編輯</button></div>
    </div></div></div>`;
  root.querySelector('.x-close').onclick = onBack;
  root.querySelector('[data-back]').onclick = onBack;
}

// 孤兒學習條目：對不上任何現存交易的學習規則——刪過整批帳單、或改規則讓鑰匙搬家後留下的。
// 它們看不見卻仍會在「下次匯入」生效，所以要有地方看得到、刪得掉（第三帖配套）。
/** @param {{items:{key:string,name?:string,category?:string,subcategory?:string}[], total:number}} r */
function openOrphanLearned(r) {
  const root = byId('modal-root');
  const rows = r.items.map(it => `<tr><td>${esc(it.key)}</td><td>${esc(it.name || '—')}</td>
    <td>${esc(it.category || '—')}${it.subcategory ? ` <span class="muted">· ${esc(it.subcategory)}</span>` : ''}</td>
    <td style="width:36px"><button class="btn-link btn-sm danger" data-dellearn="${esc(it.key)}" title="刪除這條學習">✕</button></td></tr>`).join('');
  root.innerHTML = `<div class="modal-bg"><div class="${modalSizeClass('md')}">
    <div class="modal-head"><h2>沒對到記錄的學習規則（${r.items.length}）</h2><button class="x-close">×</button></div>
    <div class="modal-body">
      <p class="muted" style="font-size:12px;margin-bottom:10px">這些是系統幫你記住的店名／分類規則，但目前<b>沒有任何一筆記錄用得到它們</b>——通常是你刪過那批帳單，或改了店名規則。
      它們平常看不到，卻會在<b>下次匯入同一家店時默默生效</b>。留著沒關係（下次匯入就會派上用場），確定不要了才刪。</p>
      ${rows ? `<div class="tbl-wrap" style="max-height:46vh;overflow:auto"><table>
        <thead><tr><th>對應的名字</th><th>學到的顯示名</th><th>學到的分類</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="empty">尚無孤兒條目 ✅</p>'}
      <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>關閉</button></div>
    </div></div></div>`;
  const close = () => { root.innerHTML = ''; };
  root.querySelector('.x-close').onclick = close;
  root.querySelector('[data-cancel]').onclick = close;
  bindBackdropClose(root, close);
  root.querySelectorAll('[data-dellearn]').forEach(b => b.addEventListener('click', async () => {
    const key = /** @type {HTMLElement} */ (b).dataset.dellearn;
    if (!confirm(`刪除「${key}」這條學習規則？下次匯入這家店會改用系統的自動判斷。`)) return;
    try {
      await api('/learned/delete', { method: 'POST', body: { key } });
      toast('已刪除');
      openOrphanLearned(await api('/statement/learned/orphans'));   // 重抓，確認真的消失
    } catch (e) { toast('刪除失敗：' + e.message, true); }
  }));
}

const val = (id) => byId(id).value;
