// @ts-check
// 設定頁（頁面本體）：店名規則編輯器已歸戶 settings-store-rules.js（系統優化階段二④）。
import { api, view, byId, esc, money, toast, openForm, openInfo, stmtOrig, currentRouteSeq, currentNavSeq, bindBackdropClose } from '../app.js';
import { openModalShell } from './modal-shell.js';   // 彈窗外殼歸戶（U3 擴大）；規則預覽窗除外（見 settings-store-rules.js 的 openRulePreview 註記）
import { icon } from './icons.js';
import { netWorthTargetFromWan, netWorthTargetPreview, netWorthTargetWanInput } from './goal-tracking.js';
import { birthStatsHtml, birthSummary } from './recipe-birth-text.js';   // 規則卡出生統計（省 AI 那條路的診斷儀表）
import { openStoreRulesEditor } from './settings-store-rules.js';
import { askToggleDisplayAfterSaveFailure } from './ai-consent.js';   // r5#1：開關失敗後的顯示判準（核對制）
import { sortStoreRows, storeCatCell, STORE_SORT_DEFAULT } from './settings-store-table.js';
import { aiKeyPatch, AI_KEY_INFO, AI_KEY_CARD_TITLE, AI_KEY_CARD_NOTE, AI_KEY_COST_LINE, AI_KEY_PLACEHOLDER_SET, AI_KEY_PLACEHOLDER_UNSET, AI_KEY_CLEAR_LABEL, AI_KEY_SAVED_TEXT, AI_KEY_CLEARED_TEXT, AI_KEY_NOCHANGE_TEXT } from './ai-key-settings.js';   // AI 解析鑰匙卡（P1b-2）：判準與文案的家
import { thBuilder, bindSortClicks } from './tx-sort.js';   // 表頭三角形與點擊綁定＝與收支頁／訂閱頁同一套
import { runExport, exportNotice, defaultWithTimeout, MODE_TIMEOUT_MS } from './backup-export.js';   // 匯出備份「按下去會說話」（先驗再存，見 exportBtn 的 onclick）
import { subcategoryOptionsHtml } from './form-options.js';   // 子類下拉「保留清單外的現值」的單一實作（#409）

/** 店家表的排序狀態（模組級：切走再回來仍記得剛才排哪一欄）。 @type {{key:string, dir:string}} */
const storeSort = { ...STORE_SORT_DEFAULT };

/**
 * ⏳ 文案（Claude 起草、**待 William 審改**）：「資料備份」卡的說明。
 *
 * ⚠️⚠️ **這張卡片的說明拿不到模式資訊，所以每一句都必須兩種模式同時成立**——它刻意只講
 *    「這裡能做什麼」，不替任何一種模式宣稱資料放在哪、也不宣稱檔案裡有什麼。
 *    以下寫法無法在兩種模式同時成立：
 *    ①寫「所有資料只存在本機 `data/store.db`（SQLite）」＝雲端版的資料在 Supabase，那是明確錯誤的
 *      資料存放／隱私說明，而使用者正是在「要不要相信這個 app」的時刻讀到它；
 *    ②寫「把你的資料**整包**匯出成一個檔案」＝HOSTED 的 `/api/export` 走 `stripSecretsForBackup(db)`
 *      （`lib/routes/core.js` 的 export 路由＋`lib/secret-fields.js`），**刻意**剝掉 IB flexToken／
 *      信用卡帳單 PDF 密碼／證券對帳單密碼／完整帳號（C5 裁決⑤），所以那句在雲端版是假的。
 *    ⇒ 「整包／全部／完整」這類**宣稱檔案內容完整**的字一律不寫：換一個病灶不算治好。
 * ⚠️ **要分流的那一句不在這裡**：`/api/export` 兩種模式含不含機密**刻意相反**，一句話講不準兩邊，
 *    講錯方向會害本機使用者把含 IB 憑證的檔案轉寄出去，所以匯出前的告知窗才依模式講真話
 *    （`EXPORT_NOTICE_LOCAL`／`EXPORT_NOTICE_HOSTED`＋`GET /api/mode`）。授權範圍僅止於那個布林，
 *    別擴張成「前端什麼環境資訊都能問」——完整規則見 docs/contracts/cloud-security.md
 *    「匯出前告知的模式分流」節。
 */
const BACKUP_CARD_NOTE = '可以把你的資料匯出成一個檔案（JSON 檔）存起來。'
  + '建議定期匯一份、放到你自己找得到的地方——要還原的時候用「匯入備份」讀回來。';

export async function renderSettings() {
  const seq = currentRouteSeq();
  const [s, txs, expTree, health, rulesRes, orphans] = await Promise.all([
    api('/settings'), api('/transactions'), api('/categories'),
    api('/statement/health').catch(() => ({ items: [], dismissed: 0 })),
    api('/statement/rules').catch(() => ({ rules: null })),
    api('/statement/learned/orphans').catch(() => ({ items: [], total: 0 }))]);
  if (seq !== currentRouteSeq()) return;   // 期間切走了頁就別覆蓋新頁面（Codex r10#6）
  const myRules = rulesRes?.rules || null;
  const ruleCount = myRules ? Object.values(myRules).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0) : 0;
  // 帳單說明／分類學習（合併卡，使用者定 2026-07-18）：一列＝一個帳單原文（藏在 stmtRef 第 4 段），
  // 顯示名/分類取「該原文最新一筆」為代表（編輯時整批統一）。編輯以原文為準——不同分店各自取名/分類。
  const byOrig = new Map();
  const keyCount = new Map();   // 品牌鑰匙 → 帳單交易總筆數（「同店一起改」算「其他 N 筆」用）
  for (const t of txs || []) {
    if (t.source !== 'stmt' || !t.stmtRef) continue;
    const orig = stmtOrig(t.stmtRef);   // 剝去重序號 |#N（Codex r10#5）——不然同店第 2 筆會裂成「星巴克|#2」另一列
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
  const storeRows = [...byOrig.values()];
  // 三層一次看（使用者定 2026-07-18）：帳單原文（銀行印的）→ 身分鑰匙（辨識同一家店的乾淨名，學習用）→ 顯示名（你看到的，可自訂）
  // 四欄皆可點擊排序（使用者定 2026-07-26）：排序與分類儲存格的規則在 settings-store-table.js（有考題）。
  const storeTableHtml = () => {
    const th = thBuilder(storeSort);
    return `<table>
        <thead><tr>${th('orig', '帳單原文')}${th('key', '身分鑰匙')}${th('cur', '顯示名')}${th('cat', '分類')}<th></th></tr></thead>
        <tbody>${sortStoreRows(storeRows, storeSort).map(p => `<tr><td class="muted">${esc(p.orig)}</td><td class="muted">${esc(p.key || '—')}</td><td>${esc(p.cur)}</td>
          <td>${storeCatCell(p, esc)}</td>
          <td style="width:36px"><button class="btn-link btn-sm" data-editstore="${esc(p.orig)}" data-cur="${esc(p.cur)}" data-cat="${esc(p.cat)}" data-sub="${esc(p.sub)}" data-key="${esc(p.key)}" data-others="${Math.max(0, (keyCount.get(p.key) || 0) - p.cnt)}" title="編輯這一列的店名與分類">${icon('edit', 15)}</button></td></tr>`).join('')}</tbody></table>`;
  };
  const storeMapRows = storeRows.length
    ? `<div class="tbl-wrap" id="storeMapWrap" style="max-height:44vh;overflow:auto">${storeTableHtml()}</div>`
    : '<p class="empty">尚無帳單記錄。匯入信用卡帳單後，這裡會列出每家店的顯示名與分類。</p>';
  view().innerHTML = `
    <div class="page-head"><div><h1>設定</h1><p>依分頁分組——要調整哪個分頁的行為，到對應區塊找</p></div></div>

    <h2 class="section-title" style="margin-top:4px">銀行收支</h2>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:14px">緊急預備金</h3>
      <div class="form-grid">
        <div><label>緊急預備金目標（月）——現金可支撐幾個月支出，低於此值總覽會提醒</label><input id="emergencyFundMonths" type="number" value="${esc(s.emergencyFundMonths)}" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveEfund">儲存</button></div>
    </div>
    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">支出分類管理</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">新增、改名、刪除、排序你的<b>支出</b>分類（大類與子類）。<b>改名</b>會自動套用到所有舊交易與學習表；<b>刪除</b>有交易的分類會把那些交易改歸「其他／未分類」。「其他／未分類」是系統退路，不能刪。⚠️ <b>儲存後沒有「復原」可以按</b>。</p>
      <div><button class="btn-ghost" id="manageCatsBtn">${icon('refresh', 16) || ''}管理支出分類</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">收入分類管理</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">新增、改名、刪除、排序你的<b>收入</b>分類（大類與子類），供銀行收支的收入使用。<b>改名</b>會自動套用到所有舊的收入交易；<b>刪除</b>有交易的分類會把那些交易改歸「其他／其他收入」。「其他／其他收入」是系統退路，不能刪。⚠️ <b>儲存後沒有「復原」可以按</b>。</p>
      <div><button class="btn-ghost" id="manageIncomeCatsBtn">${icon('refresh', 16) || ''}管理收入分類</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">內轉分類管理</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">內轉沒有大類，只有一串子分類。<b>內轉出／內轉入／交割</b>是系統自動判斷用的（錢出／進、證券劃撥）——<b>改名／刪除都可以</b>，自動判斷會跟著你改的走（刪掉的話，該類的自動判斷會變成空白，仍是內轉、只是沒子分類）。你也可以新增自己的（例：還卡費、定存互轉）。<b>改名</b>會套用到所有舊的內轉交易。</p>
      <div><button class="btn-ghost" id="manageTransferSubsBtn">${icon('refresh', 16) || ''}管理內轉分類</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">版面規則卡（省 AI 費用的學習成果）</h3>
      <p class="muted" style="font-size:12px;margin-bottom:10px">用 AI 讀過一次帳單並套用之後，系統會試著把那個版面「學成一張規則卡」——學會了，<b>下次同版面會先用這張卡讀，讀得過就不花 AI 費用</b>（讀不過、或驗算沒過，會自動退回 AI）。學習本身會失敗：它要另外請 AI 寫出一張「怎麼讀這個版面」的規則，再用那張規則回頭把你剛確認過的那份逐欄重現一次，對不起來就不收。這裡如實列出<b>試了幾次、學會幾次、沒學成的卡在哪一關</b>。</p>
      ${birthStatsHtml(s?.recipeBirthStats, birthSummary(s?.recipeBirthStats), esc)}
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">銀行收支學習</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">你在收支頁改過的銀行交易分類／說明，系統會以「<b>摘要＋對方帳號</b>」記起來，未來匯入自動套用（改一次記一輩子）。這裡可以<b>檢視</b>教過哪些規則、<b>刪掉</b>教錯的（刪掉不影響已匯入的交易；下次匯入該對象就回到自動判斷）。</p>
      <div><button class="btn-ghost" id="manageBankLearnedBtn">${icon('history', 16) || ''}管理已學規則</button></div>
    </div>


    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">店名規則（自己加規則）${ruleCount ? `<span class="store-rank">${ruleCount} 條</span>` : ''}</h3>
      <p class="muted" style="font-size:12px;margin-bottom:6px">「編輯店名規則」可以做四件事：</p>
      <ol class="muted" style="font-size:12px;margin:0 0 8px;padding-left:20px">
        <li>把帳單同一店名的「不同寫法」合併</li>
        <li>把帳單「店名截斷的部分」併回來</li>
        <li>單純更改成喜歡的店名</li>
        <li>告訴系統某個連鎖店怎麼切出店名</li>
      </ol>
      <p style="font-size:12px;margin-bottom:14px;color:var(--neg)"><b>儲存後沒有「復原」可以按</b></p>
      <div><button class="btn-ghost" id="storeRulesBtn">${icon('edit', 16) || ''}編輯店名規則</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">帳務體檢 ${health.items.length ? `<span class="store-rank">${health.items.length} 件待確認</span>` : '<span class="muted" style="font-size:12px">✅ 目前乾淨</span>'}</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">系統主動檢查可疑的店名、身分鑰匙與分類問題（同店被拆成兩把鑰匙、分期分裂、未分類累積、名字殘留雜訊…），排成清單讓你一鍵處理或略過。每次開啟即時重算，按過略過的不再出現${health.dismissed ? `（已略過 ${health.dismissed} 件）` : ''}。</p>
      <div><button class="btn-ghost" id="healthBtn">${icon('refresh', 16) || ''}開始體檢</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">帳單說明／分類學習</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">信用卡匯入時會自動清理店名、自動判斷分類；你改過的（店名或分類）系統會記住，下次匯入同一家店自動套用（優先於內建規則）。三欄＝店名的三層：<b>帳單原文</b>（銀行印的）→ <b>身分鑰匙</b>（辨識「同一家店」用，<b>只到品牌、不含分店</b>——所以各分店的消費會合併統計；所有加油站一律算「加油站」）→ <b>顯示名</b>（你看到的，含分店、可自訂）。<b>按列尾的編輯鈕可直接改這一列的顯示名與分類</b>——同原文的各月份記錄整批改；彈窗裡的「還原自動判斷」＝清除自訂、恢復系統判斷。共 ${storeRows.length} 家店，<b>點欄位標題可排序</b>（預設依顯示名）。</p>
      ${storeMapRows}
      ${orphans.items.length ? `<p class="muted" style="font-size:12px;margin-top:12px">另有 <b>${orphans.items.length}</b> 條學習規則目前沒對到任何記錄（刪過那批帳單、或改過店名規則），平常看不到但下次匯入仍會生效。<button class="btn-link btn-sm" id="orphanBtn">查看／清理</button></p>` : ''}
    </div>

    <h2 class="section-title">資產配置</h2>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">淨值目標</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">設定後，總覽會顯示目前進度，並分別用「每月現金結餘」與「整體淨值變化」估算還要多久。留空儲存即可關閉。</p>
      <div class="form-grid">
        <div><label>淨值目標（萬元）</label><input id="netWorthTargetWan" type="number" min="0.1" step="0.1" value="${esc(netWorthTargetWanInput(s.netWorthTarget))}" placeholder="例如 5,000" /></div>
        <div class="goal-target-preview"><span>台幣完整金額</span><b id="netWorthTargetPreview" aria-live="polite">${esc(netWorthTargetPreview(netWorthTargetWanInput(s.netWorthTarget), money))}</b></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveGoal">儲存目標</button></div>
    </div>

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
        ${s.ib?.flexTokenSet ? '<div class="full"><label style="display:flex;align-items:center;gap:8px;font-weight:normal"><input id="clearFlexToken" type="checkbox"> 清除已存的 Token（改回未設定）</label></div>' : ''}
        <div class="full"><label>Flex Query ID</label><input id="flexQueryId" value="${esc(s.ib?.flexQueryId || '')}" placeholder="例：123456" /></div>
      </div>
      <div class="form-actions"><button class="btn" id="saveIb">儲存 IB 設定</button></div>
    </div>

    <h2 class="section-title">證券交易</h2>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">台新證券對帳單密碼</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">存起來後，到「證券交易」頁上傳對帳單就不用每次輸入（通常是身分證字號；只存這台電腦、永不上傳，比照信用卡帳單密碼）。不存也可以——每次上傳時再輸入。</p>
      <div class="form-grid">
        <div class="full"><label>PDF 密碼</label><input id="taishinSecPw" type="password" value="" placeholder="${s.taishinSecPdfPasswordSet ? '已設定，留空＝不變更' : '通常是身分證字號'}" /></div>
        ${s.taishinSecPdfPasswordSet ? '<div class="full"><label style="display:flex;align-items:center;gap:8px;font-weight:normal"><input id="clearTaishinSecPw" type="checkbox"> 清除已存的密碼（改回每次輸入）</label></div>' : ''}
      </div>
      <div class="form-actions"><button class="btn" id="saveTaishinSecPw">儲存</button></div>
    </div>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">記住的帳單密碼</h3>
      <p class="muted" style="font-size:12px;margin-bottom:14px">上傳銀行對帳單或信用卡帳單、系統打不開請你輸入密碼時，勾「記住這組密碼」就會存進來；之後匯入會自動逐一嘗試。這裡看得到「記了幾組」、也可以整批清除（清除後改回每次輸入）。</p>
      <p style="font-size:13px;margin-bottom:12px">目前記住 <b>${Number(s.rememberedStatementPasswordsCount) || 0}</b> 組。</p>
      ${(Number(s.rememberedStatementPasswordsCount) || 0) ? '<div class="form-actions"><button class="btn-danger" id="clearStmtPws">全部清除</button></div>' : ''}
    </div>

    <h2 class="section-title">帳單解析（AI）</h2>

    <div class="card" style="margin-bottom:18px">
      <h3 style="margin-bottom:6px">${AI_KEY_CARD_TITLE}</h3>
      <p class="muted" style="font-size:12px;margin-bottom:10px">${AI_KEY_CARD_NOTE}</p>
      <p class="muted" style="font-size:12px;margin-bottom:14px">${AI_KEY_COST_LINE}</p>
      <div class="muted" style="font-size:12px;display:flex;flex-wrap:wrap;gap:14px;margin-bottom:14px">
        <button type="button" class="info-link" data-ai-info="what">ⓘ API key 是什麼？去哪辦？</button>
        <button type="button" class="info-link" data-ai-info="cost">ⓘ 大概要花多少錢？</button>
        <button type="button" class="info-link" data-ai-info="where">ⓘ 鑰匙存在哪？帳單會送去哪？</button>
        <button type="button" class="info-link" data-ai-info="skip">ⓘ 不設定會怎樣？</button>
        <button type="button" class="info-link" data-ai-info="ask">ⓘ 什麼時候會送出去？</button>
      </div>
      <label class="inline-check" style="margin-bottom:14px">
        <input id="aiAskBeforeSend" type="checkbox" ${s.aiAskBeforeSend === true ? 'checked' : ''} />
        <span>送給 AI 之前先問我一次</span>
      </label>
      <p class="muted" style="font-size:12px;margin:-8px 0 14px">預設不問：內建程式認不出版面時就直接送去讀。打開這個，每次送出前會先跳一個窗給你確認。</p>
      <label class="inline-check" style="margin-bottom:14px">
        <input id="aiDualRead" type="checkbox" ${s.aiDualRead === false ? '' : 'checked'} />
        <span>新版面讓兩個 AI 各讀一次、互相核對（雙讀）</span>
      </label>
      <p class="muted" style="font-size:12px;margin:-8px 0 6px">只在「第一次遇到新版面」時發生：兩個 AI 各自讀、金額欄位全一致才收；不一致再請第三個 AI 仲裁，三份都不同就請你手動記帳。多花一到兩發費用（不一致時再加一發仲裁）、換金額多一層獨立核對。</p>
      <div style="margin:0 0 14px"><button type="button" class="info-link" data-ai-info="dual">ⓘ 雙讀是什麼？會多花多少錢？</button></div>
      <div class="form-grid">
        <div class="full"><label>API key</label><input id="aiApiKey" type="password" value="" placeholder="${s.aiApiKeySet ? AI_KEY_PLACEHOLDER_SET : AI_KEY_PLACEHOLDER_UNSET}" /></div>
        ${s.aiApiKeySet ? `<div class="full"><label style="display:flex;align-items:center;gap:8px;font-weight:normal"><input id="clearAiApiKey" type="checkbox"> ${AI_KEY_CLEAR_LABEL}</label></div>` : ''}
      </div>
      <div class="form-actions"><button class="btn" id="saveAiApiKey">儲存</button></div>
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
      <p class="muted" style="font-size:12px;margin-bottom:14px">${BACKUP_CARD_NOTE}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <a class="btn" id="exportBtn" href="/api/export" download>${icon('download', 16)}匯出備份 (JSON)</a>
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
  const goalInput = /** @type {HTMLInputElement} */ (byId('netWorthTargetWan'));
  const updateGoalPreview = () => {
    byId('netWorthTargetPreview').textContent = netWorthTargetPreview(goalInput.value, money);
  };
  goalInput.oninput = updateGoalPreview;
  byId('saveGoal').onclick = () => {
    const target = netWorthTargetFromWan(goalInput.value);
    if (Number.isNaN(target)) return toast('淨值目標請輸入大於 0 的數字，或留空關閉。', true);
    saveSettings({ netWorthTarget: target }, target == null ? '淨值目標已清除' : '淨值目標已儲存');
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
    // 勾「清除」→ 明確送空字串清空（後端接受 '' ＝清除，Codex r10#10）；否則有打才更新、留空＝不變更
    if (/** @type {HTMLInputElement} */ (byId('clearFlexToken'))?.checked) ib.flexToken = '';
    else if (val('flexToken')) ib.flexToken = val('flexToken');
    saveSettings({ ib }, 'IB 設定已儲存，可到 IB 投資組合頁同步');
  };
  byId('saveTaishinSecPw').onclick = () => {
    // 同 flexToken 慣例（Codex r10#10）：留空＝不變更；勾「清除」＝明確送空字串清空；有打才更新
    const body = /** @type {any} */ ({});
    if (/** @type {HTMLInputElement} */ (byId('clearTaishinSecPw'))?.checked) body.taishinSecPdfPassword = '';
    else if (val('taishinSecPw')) body.taishinSecPdfPassword = val('taishinSecPw');
    else return toast('沒有變更：輸入新密碼，或勾選清除。', true);
    saveSettings(body, body.taishinSecPdfPassword === '' ? '已清除證券對帳單密碼' : '證券對帳單密碼已儲存');
  };
  { // 記住的帳單密碼：只有「全部清除」一個動作（新增走匯入時的「記住」勾選；內容絕不回瀏覽器、只有數量）
    const btn = byId('clearStmtPws');
    if (btn) btn.onclick = async () => {
      // r3#1：清除請求期間切頁＝別拿設定頁重畫覆蓋新頁面。r10 訂正：這裡問的是「使用者還在設定頁嗎」＝
      //   **換頁**序號；接成重繪序號時，開機背景重繪就會讓清除成功卻不提示也不重讀（畫面還顯示舊組數）。
      //   重畫本身的防覆蓋由 renderSettings 自己的 routeSeq 判準負責，不靠這裡。
      const seq = currentNavSeq();
      try {
        await api('/statement/password/clear', { method: 'POST', body: {} });
        if (seq !== currentNavSeq()) return;
        toast('已清除記住的帳單密碼'); await renderSettings();   // await：重畫失敗不變成 unhandled rejection
      } catch (err) { if (seq !== currentNavSeq()) return; toast('清除失敗：' + /** @type {any} */ (err).message, true); }   // r5#2：換頁後不報過期錯誤
    };
  }
  { // AI 解析鑰匙（P1b-2）：判準（留空＝不變更／勾清除＝送空字串／都沒動＝報錯）住 ai-key-settings.js 的
    //   aiKeyPatch，這裡只接線。成功後**重繪**＝讓契約要求的「清除已存的鑰匙」入口當場出現，
    //   不必切頁再回來（saveSettings 只 toast 不重繪；比照上面 clearStmtPws 那條既有的重繪路徑）。
    // 「送出前先問我」＝獨立開關，勾一下就存（不跟鑰匙共用儲存鍵——鑰匙那顆有「留空＝不變更」語意，
    //   混在一起會讓「只想改開關」的人被迫重打鑰匙）。
    const ask = /** @type {HTMLInputElement|null} */ (byId('aiAskBeforeSend'));
    // ⚠️ r1#3：不可用 saveSettings（它吞錯誤只 toast）——PUT 失敗時畫面顯示「已開」、
    //    資料庫還是關的，下一次上傳就直接外送。失敗＝把開關**退回原狀**讓人看見。
    const dual = /** @type {HTMLInputElement|null} */ (byId('aiDualRead'));
    if (dual) dual.onchange = async () => {
      const want = dual.checked;
      dual.disabled = true;
      try {
        await api('/settings', { method: 'PUT', body: { aiDualRead: want } });
        toast(want ? '好，新版面會讓兩個 AI 互相核對' : '好，改回單讀（讀不好會自動換強模型重試）');
      } catch (err) {
        // 核對制（#455 同款）：寫入可能已成功、回應沒回來——向資料庫重新核對；核對不到＝顯示「關」
        //（畫面寧可少保證）。⚠️ 執行期判準相反＝讀不到當「開」（dualReadWanted＝多驗證）——顯示的
        // 保守與執行的保守方向相反、而且應該相反：畫面不假稱有保護、程式寧多驗一發。
        try { const s2 = /** @type {any} */ (await api('/settings')); dual.checked = s2.aiDualRead !== false; }
        catch { dual.checked = false; }
        toast('儲存失敗，已向資料庫重新核對，開關目前＝'
          + (dual.checked ? '雙讀' : '單讀') + '：' + (/** @type {any} */ (err).message || ''), true);
      } finally { dual.disabled = false; }
    };
    if (ask) ask.onchange = async () => {
      const want = ask.checked;
      ask.disabled = true;
      try {
        await api('/settings', { method: 'PUT', body: { aiAskBeforeSend: want } });
        toast(want ? '好，之後每次送出前會先問你' : '好，之後認不出版面就直接送去讀');
      } catch (err) {
        // ⚠️ 不可用 !want 推定（r5#1）：後端先寫入再回應——寫入可能已成功、回應沒回來。
        //    向資料庫重新核對；核對不到＝顯示「直接送」（畫面寧可少保證、不做假保證）。
        ask.checked = await askToggleDisplayAfterSaveFailure(() => api('/settings'));
        toast('儲存失敗，已向資料庫重新核對，開關目前＝'
          + (ask.checked ? '會先問你' : '直接送') + '：' + (/** @type {any} */ (err).message || ''), true);
      } finally { ask.disabled = false; }
    };
    const btn = byId('saveAiApiKey');
    if (btn) btn.onclick = async () => {
      const patch = aiKeyPatch({ value: val('aiApiKey'), clear: /** @type {HTMLInputElement} */ (byId('clearAiApiKey'))?.checked === true });
      if (!patch) return toast(AI_KEY_NOCHANGE_TEXT, true);
      // r10 同款：問的是「使用者還在設定頁嗎」＝**換頁**序號；接成重繪序號時，開機背景重繪會讓
      //   儲存成功卻不提示也不重讀（清除入口不會出現）。
      const seq = currentNavSeq();
      try {
        await api('/settings', { method: 'PUT', body: patch });
        if (seq !== currentNavSeq()) return;
        toast(patch.aiApiKey === '' ? AI_KEY_CLEARED_TEXT : AI_KEY_SAVED_TEXT);
        await renderSettings();   // await：重畫失敗不變成 unhandled rejection
      } catch (err) { if (seq !== currentNavSeq()) return; toast('儲存失敗：' + (/** @type {any} */ (err).message || ''), true); }   // r5#2：換頁後不報過期錯誤
    };
    // 就地解釋（設定頁首例；形狀照 securities.js；顆數不寫死＝寫死的數字自己會漂）。Object.hasOwn＝只認自有鍵（'constructor' 撈不到原型）
    view().querySelectorAll('[data-ai-info]').forEach((/** @type {any} */ b) => { b.onclick = () => {
      const key = String(b.dataset.aiInfo || '');
      const info = Object.hasOwn(AI_KEY_INFO, key) ? AI_KEY_INFO[/** @type {keyof typeof AI_KEY_INFO} */ (key)] : null;
      if (info) openInfo(info.title, info.html, { size: 'md' });
    }; });
  }
  byId('manageCatsBtn').onclick = async () => {
    try { openCategoryEditor(await api('/categories'), CAT_CFG.expense); }
    catch (err) { toast('讀取分類失敗：' + err.message, true); }
  };
  byId('manageIncomeCatsBtn').onclick = async () => {
    try { openCategoryEditor(await api('/income-categories'), CAT_CFG.income); }
    catch (err) { toast('讀取收入分類失敗：' + err.message, true); }
  };
  byId('manageBankLearnedBtn').onclick = async () => {
    try { openBankLearnedManager(await api('/bank-learned')); }
    catch (err) { toast('讀取已學規則失敗：' + err.message, true); }
  };
  byId('manageTransferSubsBtn').onclick = async () => {
    try { openTransferSubEditor(await api('/transfer-subcategories')); }
    catch (err) { toast('讀取內轉分類失敗：' + err.message, true); }
  };
  // 帳單說明／分類學習（合併卡）：編輯這一列的顯示名＋分類——以「帳單原文」為準
  //（同原文整批改＋記學習，未來匯入沿用；不同分店可各自取名/分類。2026-07-18 使用者定）
  const expParents = Object.keys(expTree || {});
  // 排序會重畫表格 → 編輯鈕要重綁：包成函式讓首次渲染與排序回呼共用同一份（兩套會走鐘）
  const bindStoreEdit = () => view().querySelectorAll('[data-editstore]').forEach(b => b.onclick = () => {
    const el = /** @type {HTMLElement} */ (b);
    const orig = el.dataset.editstore || '';
    const cur = el.dataset.cur || '', cat0 = el.dataset.cat || '', sub0 = el.dataset.sub || '';
    // 同店一起改（使用者定 2026-07-19，與收支列表編輯同一招）：同品牌鑰匙下「其他原文」還有幾筆
    const key = el.dataset.key || '', others = Number(el.dataset.others || 0);
    // 國外交易服務費不支援整批改（r2-Codex#3；後端 isServiceFee 為單一真相）→ 不給「同店一起改」勾選框（同 transactions.js）
    const isFeeKey = /國外交易服務費/.test(orig) || /國外交易服務費/.test(key);
    const catOpts = (cat0 && !expParents.includes(cat0)) ? [cat0, ...expParents] : expParents;   // 保留目前值（防默默改資料）
    openForm({
      title: '編輯店名與分類（只影響這一列）',
      fields: [
        { key: 'name', label: `原文「${orig}」的顯示名`, type: 'text', required: true, full: true },
        { key: 'category', label: '分類', type: 'select', options: catOpts, default: cat0 || expParents[0] },
        { key: 'subcategory', label: '子類（可留白）', type: 'select', options: [] },   // 由 onMount 依分類連動
        ...(key && others > 0 && !isFeeKey ? [{ key: 'applyAll', label: `同時套用分類到「${key}」的其他 ${others} 筆記錄（顯示名不會跟過去）`, type: 'checkbox', full: true }] : []),
      ],
      values: { name: cur, category: cat0, subcategory: sub0 },
      onMount: (/** @type {any} */ root) => {
        const catSel = root.querySelector('#f_category');
        const subSel = root.querySelector('#f_subcategory');
        const fill = (/** @type {string} */ parent, /** @type {string} */ curSub) => {
          const subs = ['', ...((Object.hasOwn(expTree || {}, parent) && (expTree || {})[parent]) || [])];   // hasOwn（Codex r8#3）：同 transactions.js subOptions
          // 「保留清單外的現值」＋拼 <option> 都交給 form-options.js（#409 自審把三份抄本收成一份；
          // 這一處本來就有保留、行為不變——但抄本只要留著，下一個人就可能再漏一次）。
          subSel.innerHTML = subcategoryOptionsHtml(subs, curSub);
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
        // 「同店一起改」原子化（護欄 G3）：把 applyAll 併進 rename-store，後端一次寫檔完成改名＋分類傳播——
        // 不再前端「rename-store 再另呼 apply-category」兩次寫（中途失敗會半套用、且這條原本沒接錯誤）
        const r = await api('/statement/rename-store', { method: 'POST',
          body: { orig, name: d.name, category: d.category, subcategory: d.subcategory || '', applyAll: !!(d.applyAll && key) } });
        if (r.applied) toast(`已更新 ${r.changed} 筆，並把「${key}」的其他 ${r.applied.changed} 筆一起改成 ${d.category}${d.subcategory ? `·${d.subcategory}` : ''}`);
        else toast(`已更新 ${r.changed} 筆記錄`);
        renderSettings();
      }
    });
  });
  // 點表頭排序：只重畫表格本身（不重打 6 支 API），重畫後重綁編輯鈕與表頭
  const bindStoreTable = () => {
    bindStoreEdit();
    const wrap = byId('storeMapWrap');
    if (!wrap) return;   // 沒有帳單記錄＝顯示空狀態、沒有表格
    bindSortClicks(wrap, storeSort, () => { wrap.innerHTML = storeTableHtml(); bindStoreTable(); });
  };
  bindStoreTable();
  byId('healthBtn').onclick = () => openHealthCheck();
  byId('storeRulesBtn').onclick = () => openStoreRulesEditor(myRules);
  if (orphans.items.length) byId('orphanBtn').onclick = () => openOrphanLearned(orphans);
  // 匯出備份：**攔下瀏覽器的直接下載**，改成 fetch → 驗狀態／驗內容 → 才落檔並出聲。
  // 舊版是純 <a download>，成功失敗都不出聲；雲端版 session 過期時瀏覽器會安靜存下一個
  // 內容是錯誤訊息（或登入頁 HTML）的 .json，而使用者以為自己有備份了。
  //
  // ⚠️ 那顆 <a> 的 `href="/api/export"` 與 `download` **刻意留著**（沒有改成 <button>）：
  //    ①它是「右鍵另存連結」的退路 ②有別的考題以這個字面定位這顆鈕。
  //    代價寫明白：右鍵另存那條路**繞過下面這三道關卡**，會退回舊的靜靜失敗——
  //    這一支只保證「左鍵按下去會說話」，那是使用者實際會走的那條路。
  /**
   * 匯出前的告知窗（William 2026-08-08 定案）：**告知、不是警告**——不擋、不需要理由，
   * 按〈確認匯出〉就走。回 false＝使用者取消（呼叫端必須什麼都不做）。
   * ⚠️ 關窗（× 或點背景）**視為取消**：沒有明確按下確認就不動作，比較保守的那一邊。
   * @returns {Promise<boolean>}
   */
  const confirmExport = async () => {
    // 先問模式再決定講哪一句（William 2026-08-08「要講準」）。問不到就走保守那句（含機密）。
    // ⚠️ **這次問答也要有上限**（r5 阻擋①）：`/api/mode` 若連上了卻永不回應，`catch` 不會發生
    //    ——畫面連確認窗都不會出現，等於把「按下去沒聲音」搬到匯出前一步。逾時＝當作問不到。
    let mode = null;
    try { mode = await defaultWithTimeout(api('/mode'), MODE_TIMEOUT_MS); }
    catch { /* 問不到／逾時＝保守：exportNotice(null) 回「含機密」 */ }
    const notice = exportNotice(mode);
    return new Promise((resolve) => {
    let decided = false;
    const done = (/** @type {boolean} */ ok) => { if (!decided) { decided = true; resolve(ok); } };
    // ⚠️ `backdrop: false`（r4 阻擋③）：openModalShell 內建的點背景關窗只會呼叫 `close`，
    //    **不會**把這顆 Promise 收掉——上一版於是每點一次背景就留下一顆永遠不 settle 的 Promise
    //    （複驗者用真 DOM 抓到：窗關了、API 0 次、落檔 0 次，但呼叫端 50ms 後仍 pending）。
    //    所以三條退出路（取消鈕／×／點背景）**一律走同一個 cancel()**，沒有第二種關窗方式。
    const { root, close } = openModalShell({
      title: '匯出備份', size: 'sm', backdrop: false,
      bodyHtml: `<p style="font-size:13px;margin:0 0 16px">${esc(notice)}</p>
        <div class="form-actions">
          <button type="button" class="btn-ghost" data-cancel>取消</button>
          <button type="button" class="btn" id="exportConfirmBtn">確認匯出</button>
        </div>`,
    });
    const cancel = () => { close(); done(false); };
    root.querySelector('[data-cancel]').onclick = cancel;
    root.querySelector('.x-close').onclick = cancel;
    bindBackdropClose(root, cancel);
    root.querySelector('#exportConfirmBtn').onclick = () => { close(); done(true); };
    });
  };

  byId('exportBtn').onclick = async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    // ⚠️ busy 從**整段流程的最前面**就設（r5 阻擋①的後半）：上一版設在確認之後，
    //    於是「問模式／等他回答」這段時間連點會同時開好幾條確認流程（每條各自一顆 Promise）。
    if (btn.dataset.busy === '1') return;        // 連點兩下不要抓兩份
    btn.dataset.busy = '1';
    try {
      // 🧑‍⚖️ William 2026-08-08：按下去**先跳窗告知**（本機版／雲端版講的話不同，見 exportNotice），
      //    按〈確認匯出〉才開始下載；按〈取消〉什麼都不做（不打 API、不落檔）。
      //    ⚠️ 用 app 自己的彈窗而不是瀏覽器 confirm()：他要的按鈕字是「確認匯出／取消」，
      //    原生 confirm 只給得出「確定／取消」。
      if (!await confirmExport()) return;
      await runExport({
        fetchFn: (url) => fetch(url),
        saveFile: (filename, body) => {
          // Blob + 暫時連結：不重新序列化，落下去的是伺服器回的原始文字。
          const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
          const a = document.createElement('a');
          a.href = url; a.download = filename;
          document.body.appendChild(a); a.click(); a.remove();
          // ⚠️ revoke 要**延後**：緊接著 click 就 revoke，在某些瀏覽器（Safari 有回報過）會讓下載被取消
          //    ——那正好是這一支最想避免的「說了已存下、其實沒有」。等一拍再回收那個暫時網址。
          //    誠實劃界：這一行沒有考題撐著（settings.js 的 DOM 路徑在 node 裡跑不起來），
          //    是照已知的瀏覽器行為做的保險，不是實測過每一種瀏覽器。
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        },
        toast,
      });
    } finally { btn.dataset.busy = ''; }
  };
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
  // 外殼歸戶（U3 擴大）：內容與事件照舊自理
  const { close } = openModalShell({
    title: `帳務體檢${items.length ? `（${items.length} 件待確認）` : ''}`, size: 'lg',
    bodyHtml: `
      ${items.length ? `<p class="muted" style="font-size:12px;margin-bottom:10px">這些是系統覺得「怪怪的」的地方——不一定是錯，你說了算：處理、或按略過讓它永久安靜。</p>
        <div style="max-height:56vh;overflow:auto">${items.map(rowHtml).join('')}</div>`
        : '<p class="empty">目前一切乾淨 ✅ 沒有待確認的項目。</p>'}
      <div class="form-actions">
        ${health.dismissed ? `<button type="button" class="btn-link" data-hreset>重新顯示已略過的 ${health.dismissed} 件</button>` : ''}
        <button type="button" class="btn" data-close>關閉</button></div>`,
  });
  root.querySelector('[data-close]').onclick = close;
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

// 支出／收入分類管理各自的設定（同一個編輯器兩用）：端點、標題、受保護的退路節點、修改說明。
// 收入樹的後端（saveIncomeTree/effectiveIncomeTree）與支出對稱，退路＝其他/其他收入；收入無自動分類器，故不提「學習表」。
const CAT_CFG = {
  expense: { title: '支出分類管理', endpoint: '/categories', otherCat: '其他', otherSub: '未分類',
    note: '改名會套用到所有舊交易與學習表；刪除有交易的分類，那些交易會改歸「其他／未分類」。' },
  income: { title: '收入分類管理', endpoint: '/income-categories', otherCat: '其他', otherSub: '其他收入',
    note: '改名會套用到所有舊的收入交易；刪除有交易的分類，那些交易會改歸「其他／其他收入」。' },
};

// 分類管理編輯器：把整棵分類樹載入成可編輯狀態（每列記「原名」以偵測改名），一次儲存。
// 為保留輸入焦點：打字時不重繪，只有結構性動作（新增/刪除/搬移）才 syncFromDom→重繪。
/** @param {Record<string,string[]>} tree @param {typeof CAT_CFG.expense} [cfg] 支出或收入的設定（預設支出） */
function openCategoryEditor(tree, cfg = CAT_CFG.expense) {
  const root = byId('modal-root');
  // 狀態：[{orig, name, subs:[{orig,name}]}]，orig=null＝新增（非改名）；退路大類（其他）與其退路子類受保護不可刪改
  /** @type {{orig: string|null, name: string, subs: {orig: string|null, name: string}[]}[]} */
  const state = Object.entries(tree || {}).map(([name, subs]) => ({
    orig: /** @type {string|null} */ (name), name, subs: (subs || []).map(s => ({ orig: /** @type {string|null} */ (s), name: s }))
  }));
  const isOther = (p) => p.orig === cfg.otherCat;

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
        ${p.subs.map((s, j) => { const lock = isOther(p) && s.orig === cfg.otherSub;
          return `<span class="sub-chip"><input class="sub-name" data-p="${i}" data-s="${j}" value="${esc(s.name)}" placeholder="子類" ${lock ? 'readonly' : ''} /><button type="button" class="sub-x" data-act="delS" data-p="${i}" data-s="${j}" title="刪除子類" ${lock ? 'disabled' : ''}>×</button></span>`; }).join('')}
        <button type="button" class="btn-ghost btn-sm" data-act="addS" data-p="${i}">＋子類</button>
      </div>
    </div>`;

  const redraw = () => { byId('catEditorBody').innerHTML = state.map((p, i) => blockHtml(p, i)).join(''); };

  // 外殼歸戶（U3 擴大）：title 傳原文（外殼負責 esc，勿雙重跳脫）
  const { close } = openModalShell({
    title: cfg.title, size: 'lg',
    bodyHtml: `
      <p class="muted" style="font-size:12px;margin-bottom:10px">${esc(cfg.note)}</p>
      <div id="catEditorBody" style="max-height:52vh;overflow:auto"></div>
      <div style="margin-top:10px"><button type="button" class="btn-ghost btn-sm" data-act="addP">＋ 新增大類</button></div>
      <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button><button type="button" class="btn" id="catSave">儲存分類</button></div>`,
  });
  root.querySelector('[data-cancel]').onclick = close;
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
    else if (act === 'delS') { const sub = state[p]?.subs[s]; if (state[p] && !(isOther(state[p]) && sub?.orig === cfg.otherSub)) state[p].subs.splice(s, 1); }
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
      const r = await api(cfg.endpoint, { method: 'POST', body: { tree: outTree, parentRenames, subRenames } });
      close();
      const n = r.changedTx || 0;
      toast(n ? `分類已儲存，${n} 筆舊交易一併更新` : '分類已儲存');
      renderSettings();
    } catch (err) { toast('儲存失敗：' + err.message, true); }
  };
}

// ---------- 內轉分類管理（使用者定 2026-07-21，全可編輯）：扁平清單編輯器 ----------
// 每項一列（改名/上下移/刪除）＋新增；系統角色 out/in/settle 用 tag 標記、跟著改名走。存檔送 {subs,renames}。
/** @param {{label:string, role?:string}[]} list */
function openTransferSubEditor(list) {
  const root = byId('modal-root');
  /** @type {Record<string,string>} */
  const roleLabel = { out: '出', in: '進', settle: '交割' };
  /** @type {{orig: string|null, label: string, role?: string}[]} */
  const state = (list || []).map(s => ({ orig: s.label, label: s.label, role: s.role }));
  const syncFromDom = () => {
    root.querySelectorAll('input.tsub-name').forEach((/** @type {any} */ inp) => { const i = Number(inp.dataset.i); if (state[i]) state[i].label = inp.value; });
  };
  const rowHtml = (/** @type {any} */ s, /** @type {number} */ i) => `
    <div class="cat-block-head" style="margin-bottom:8px">
      <input class="tsub-name cat-name" data-i="${i}" value="${esc(s.label)}" placeholder="內轉子分類名稱" />
      ${s.role ? `<span class="tag blue" title="系統自動判斷用">系統・${esc(roleLabel[s.role] || s.role)}</span>` : ''}
      <span class="cat-block-btns">
        <button type="button" class="btn-icon" data-act="up" data-i="${i}" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn-icon" data-act="down" data-i="${i}" title="下移" ${i === state.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn-icon danger" data-act="del" data-i="${i}" title="刪除">✕</button>
      </span>
    </div>`;
  const redraw = () => { byId('tsubEditorBody').innerHTML = state.map(rowHtml).join(''); };
  // 外殼歸戶（U3 擴大）
  const { close } = openModalShell({
    title: '內轉分類管理', size: 'md',
    bodyHtml: `
      <p class="muted" style="font-size:12px;margin-bottom:10px">標「系統」的三項（出／進／交割）是自動判斷用的：改名沒問題（自動判斷跟著走）、刪掉的話該類自動判斷會變空白。改名會套用到所有舊的內轉交易。</p>
      <div id="tsubEditorBody"></div>
      <div style="margin-top:10px"><button type="button" class="btn-ghost btn-sm" data-act="add">＋ 新增內轉分類</button></div>
      <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>取消</button><button type="button" class="btn" id="tsubSave">儲存</button></div>`,
  });
  root.querySelector('[data-cancel]').onclick = close;
  redraw();
  root.querySelector('.modal-body').addEventListener('click', (/** @type {any} */ e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act, i = Number(btn.dataset.i);
    syncFromDom();
    if (act === 'add') state.push({ orig: null, label: '' });
    else if (act === 'del') state.splice(i, 1);
    else if (act === 'up') { if (i > 0) [state[i - 1], state[i]] = [state[i], state[i - 1]]; }
    else if (act === 'down') { if (i < state.length - 1) [state[i + 1], state[i]] = [state[i], state[i + 1]]; }
    else return;
    redraw();
  });
  byId('tsubSave').onclick = async () => {
    syncFromDom();
    /** @type {{label:string, role?:string}[]} */
    const subs = [];
    /** @type {{from:string, to:string}[]} */
    const renames = [];
    const seen = new Set();
    for (const s of state) {
      const label = s.label.trim();
      if (!label) return toast('有內轉分類是空的，請填寫或刪除', true);
      if (seen.has(label)) return toast(`「${label}」重複了`, true);
      seen.add(label);
      subs.push(s.role ? { label, role: s.role } : { label });
      if (s.orig && s.orig !== label) renames.push({ from: s.orig, to: label });
    }
    if (!subs.length) return toast('至少要保留一個內轉分類', true);
    try {
      const r = await api('/transfer-subcategories', { method: 'POST', body: { subs, renames } });
      close();
      toast(r.changedTx ? `已儲存，${r.changedTx} 筆舊內轉交易一併更新` : '內轉分類已儲存');
      renderSettings();
    } catch (err) { toast('儲存失敗：' + err.message, true); }
  };
}

// ---------- 銀行收支「真·學習」已學規則管理（使用者定 2026-07-21）----------
// 一列＝一條「摘要＋對方帳號 → type/分類/顯示名」的學過規則。可檢視、逐條刪除（教錯的救援）。
// 刪除只影響「下次匯入該對象」（回自動判斷），不動已匯入的交易。
/** @param {any[]} list */
function openBankLearnedManager(list) {
  const root = byId('modal-root');
  const flowLbl = (/** @type {string} */ t) => t === 'income' ? '收入' : t === 'transfer' ? '內轉' : '支出';
  const flowCls = (/** @type {string} */ t) => t === 'income' ? 'pos' : t === 'transfer' ? 'muted' : 'neg';
  const render = (/** @type {any[]} */ rows) => {
    const body = rows.map(r => `<tr>
      <td>${esc(r.summary)}${r.counterparty ? `<br><span class="muted" style="font-size:11px">→ ${esc(r.counterparty)}</span>` : ''}</td>
      <td><span class="flow-tag ${flowCls(r.type)}">${flowLbl(r.type)}</span> ${esc(r.category || '（不分類）')}${r.subcategory ? '・' + esc(r.subcategory) : ''}</td>
      <td class="muted">${r.name ? esc(r.name) : '<span class="muted">（用原始說明）</span>'}</td>
      <td><button class="btn-danger btn-sm" data-del="${esc(r.key)}" title="刪除這條規則">${icon('trash', 15)}</button></td>
    </tr>`).join('');
    // 外殼歸戶（U3 擴大）：render() 每次重畫都重開外殼（刪除後就地重繪的既有行為不變）
    const { close } = openModalShell({
      title: '銀行收支學習', size: 'lg',
      bodyHtml: `
        <p class="muted" style="font-size:12px;margin-bottom:10px">每一列是你教過的一條規則（摘要＋對方帳號 → 分類／顯示名）。刪掉只是讓下次匯入該對象回到自動判斷，<b>不影響</b>已經匯入的交易。</p>
        <div class="tbl-wrap"><table>
          <thead><tr><th>摘要／對方</th><th>金流・分類</th><th>顯示說明</th><th></th></tr></thead>
          <tbody>${body || '<tr><td colspan="4" class="empty">還沒有學過任何規則。到收支頁改一筆銀行交易的分類／說明，就會自動學起來。</td></tr>'}</tbody>
        </table></div>
        <div class="form-actions"><button type="button" class="btn" data-close>關閉</button></div>`,
    });
    root.querySelector('[data-close]').onclick = close;
    root.querySelectorAll('[data-del]').forEach(btn => /** @type {HTMLElement} */ (btn).onclick = async () => {
      const key = /** @type {HTMLElement} */ (btn).dataset.del;
      const r = rows.find(x => x.key === key);
      if (!window.confirm(`確定刪掉這條學過的規則嗎？（${r.summary}${r.counterparty ? ' → ' + r.counterparty : ''}）\n刪掉不影響已匯入的交易，只是下次匯入該對象回到自動判斷。`)) return;
      try {
        await api('/bank-learned/delete', { method: 'POST', body: { key } });
        toast('已刪除這條規則');
        render(rows.filter(x => x.key !== key));   // 就地移除、不必重抓
      } catch (e) { toast('刪除失敗：' + /** @type {any} */ (e).message, true); }
    });
  };
  render(list || []);
}

// 孤兒學習條目：對不上任何現存交易的學習規則——刪過整批帳單、或改規則讓鑰匙搬家後留下的。
// 它們看不見卻仍會在「下次匯入」生效，所以要有地方看得到、刪得掉（第三帖配套）。
/** @param {{items:{key:string,name?:string,category?:string,subcategory?:string}[], total:number}} r */
function openOrphanLearned(r) {
  const root = byId('modal-root');
  const rows = r.items.map(it => `<tr><td>${esc(it.key)}</td><td>${esc(it.name || '—')}</td>
    <td>${esc(it.category || '—')}${it.subcategory ? ` <span class="muted">· ${esc(it.subcategory)}</span>` : ''}</td>
    <td style="width:36px"><button class="btn-link btn-sm danger" data-dellearn="${esc(it.key)}" title="刪除這條學習">✕</button></td></tr>`).join('');
  // 外殼歸戶（U3 擴大）
  const { close } = openModalShell({
    title: `沒對到記錄的學習規則（${r.items.length}）`, size: 'md',
    bodyHtml: `
      <p class="muted" style="font-size:12px;margin-bottom:10px">這些是系統幫你記住的店名／分類規則，但目前<b>沒有任何一筆記錄用得到它們</b>——通常是你刪過那批帳單，或改了店名規則。
      它們平常看不到，卻會在<b>下次匯入同一家店時默默生效</b>。留著沒關係（下次匯入就會派上用場），確定不要了才刪。</p>
      ${rows ? `<div class="tbl-wrap" style="max-height:46vh;overflow:auto"><table>
        <thead><tr><th>對應的名字</th><th>學到的顯示名</th><th>學到的分類</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="empty">尚無孤兒條目 ✅</p>'}
      <div class="form-actions"><button type="button" class="btn-ghost" data-cancel>關閉</button></div>`,
  });
  root.querySelector('[data-cancel]').onclick = close;
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
