import { api, view, esc, toast } from '../app.js';
import { icon } from './icons.js';

export async function renderSettings() {
  const s = await api('/settings');
  view().innerHTML = `
    <div class="page-head"><div><h1>設定</h1><p>提醒門檻、IB 連線、資料備份</p></div></div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:14px">提醒門檻</h3>
      <div class="form-grid">
        <div><label>緊急預備金目標（月）</label><input id="emergencyFundMonths" type="number" value="${esc(s.emergencyFundMonths)}" /></div>
        <div><label>美元兌台幣匯率 (USD→TWD)</label><input id="usdTwd" type="number" step="0.01" value="${esc(s.usdTwd)}" /></div>
        <div><label>資產配置偏離提醒（%）</label><input id="allocationDriftPct" type="number" value="${esc(s.allocationDriftPct)}" /></div>
        <div><label>IB 單一持股過重門檻（%）</label><input id="ibConcentrationPct" type="number" value="${esc(s.ibConcentrationPct)}" /></div>
        <div><label>IB 閒置現金提醒門檻（美元 USD）</label><input id="ibIdleCashAlert" type="number" value="${esc(s.ibIdleCashAlert)}" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveThresholds">儲存門檻</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">IBKR Flex Query 連線（唯讀）</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px;line-height:1.7">
        ① Client Portal → <b>Performance &amp; Reports → Flex Queries</b> → Activity Flex Query 按「＋」新增：勾選
        <b>Open Positions</b>（欄位全選）與 <b>Cash Report</b>（欄位全選），格式 <b>XML</b>、期間 Last Business Day → 儲存後記下 <b>Query ID</b>。<br>
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

    <div class="card">
      <h3 style="margin-bottom:6px">資料備份</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">所有資料只存在本機 <code>data/store.json</code>。建議定期匯出備份。</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a class="btn" href="/api/export" download>${icon('download', 16)}匯出備份 (JSON)</a>
        <button class="btn-ghost" id="importBtn">${icon('upload', 16)}匯入備份</button>
        <input type="file" id="importFile" accept="application/json" style="display:none" />
      </div>
    </div>
  `;

  document.getElementById('saveThresholds').onclick = async () => {
    await api('/settings', { method: 'PUT', body: {
      emergencyFundMonths: Number(val('emergencyFundMonths')),
      usdTwd: Number(val('usdTwd')),
      allocationDriftPct: Number(val('allocationDriftPct')),
      ibConcentrationPct: Number(val('ibConcentrationPct')),
      ibIdleCashAlert: Number(val('ibIdleCashAlert'))
    }});
    toast('門檻已儲存');
  };
  document.getElementById('saveIb').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { ib: { flexToken: val('flexToken'), flexQueryId: val('flexQueryId') } } });
    toast('IB 設定已儲存，可到 IB 投資組合頁同步');
  };
  document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
  document.getElementById('importFile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (!confirm('匯入會覆蓋目前所有資料，確定嗎？')) return;
    try { await api('/import', { method: 'POST', body: JSON.parse(await file.text()) }); toast('已匯入'); location.hash = 'dashboard'; }
    catch (err) { toast('匯入失敗：' + err.message, true); }
  };
}
const val = (id) => document.getElementById(id).value;
