import { api, view, esc, toast } from '../app.js';
import { icon } from './icons.js';

export async function renderSettings() {
  const s = await api('/settings');
  view().innerHTML = `
    <div class="page-head"><div><h1>設定</h1><p>提醒門檻、IB 連線、資料備份</p></div></div>

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
      <h3 style="margin-bottom:14px">提醒門檻</h3>
      <div class="form-grid">
        <div><label>緊急預備金目標（月）</label><input id="emergencyFundMonths" type="number" value="${esc(s.emergencyFundMonths)}" /></div>
        <div><label>美元兌台幣匯率 (USD→TWD)</label><input id="usdTwd" type="number" step="0.01" value="${esc(s.usdTwd)}" /></div>
        <div><label>資產配置偏離提醒（%）</label><input id="allocationDriftPct" type="number" value="${esc(s.allocationDriftPct)}" /></div>
        <div><label>IB 閒置現金提醒門檻（美元 USD）</label><input id="ibIdleCashAlert" type="number" value="${esc(s.ibIdleCashAlert)}" /></div>
        <div><label>換匯區間：美元→台幣（≥ 此值提醒分批換台幣）</label><input id="fxHigh" type="number" step="0.1" value="${esc(s.fxHigh ?? 32)}" /></div>
        <div><label>換匯區間：台幣→美元（≤ 此值提醒分批換美元）</label><input id="fxLow" type="number" step="0.1" value="${esc(s.fxLow ?? 28)}" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveThresholds">儲存門檻</button></div>
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

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">分類轉換（一次性）</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">把舊的單層分類（房貸、生活雜支、旅遊、訂閱…）轉成新的兩層分類（居住／房貸…）。可重複執行、只改到得動的舊標籤，轉換前會自動備份。</p>
      <div><button class="btn-ghost" id="migrateBtn">${icon('refresh', 16) || ''}轉換舊分類 → 新分類</button></div>
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

  document.getElementById('savePrinciples').onclick = async () => {
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
  document.getElementById('saveThresholds').onclick = async () => {
    await api('/settings', { method: 'PUT', body: {
      emergencyFundMonths: Number(val('emergencyFundMonths')),
      usdTwd: Number(val('usdTwd')),
      allocationDriftPct: Number(val('allocationDriftPct')),
      ibIdleCashAlert: Number(val('ibIdleCashAlert')),
      fxHigh: Number(val('fxHigh')),
      fxLow: Number(val('fxLow'))
    }});
    toast('門檻已儲存');
  };
  document.getElementById('saveIb').onclick = async () => {
    await api('/settings', { method: 'PUT', body: { ib: { flexToken: val('flexToken'), flexQueryId: val('flexQueryId') } } });
    toast('IB 設定已儲存，可到 IB 投資組合頁同步');
  };
  document.getElementById('migrateBtn').onclick = async () => {
    if (!confirm('要把舊分類轉換成新的兩層分類嗎？（會先自動備份，可重複執行）')) return;
    try {
      const r = await api('/migrate/categories', { method: 'POST' });
      const detail = Object.entries(r.byOldCategory || {}).map(([k, v]) => `${k}×${v}`).join('、');
      toast(r.changed ? `已轉換 ${r.changed} 筆${detail ? '（' + detail + '）' : ''}` : '沒有需要轉換的舊分類');
    } catch (err) { toast('轉換失敗：' + err.message, true); }
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
