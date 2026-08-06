// @ts-check
// 店名規則自助編輯器（系統優化階段二④，2026-07-24 從 settings.js 搬出、搬家不裝修）：
// 「第三帖」規則資料化的工作區——編輯窗（五種規則表單、預覽→確認→儲存、學習規則衝突處理）
// ＋影響預覽窗（openRulePreview＝U3 記錄在案的外殼例外：×是返回編輯不是關閉、無背景關閉）。
// settings.js 只留設定頁本體；儲存成功後經 renderSettings 接縫回頭重繪設定頁。
// 循環 import 安全：本檔 ↔ settings.js ↔ app.js 成環，所有 import 綁定一律只在函式內取用
//（勿在檔案頂層取用＝TDZ 陷阱，見 theme.js 註記；本檔頂層只有常數字面量與函式宣告）。
import { api, byId, esc, toast, modalSizeClass } from '../app.js';
import { openModalShell } from './modal-shell.js';
import { renderSettings } from './settings.js';

// ---------- 店名規則自助管理（第三帖，使用者定 2026-07-19） ----------
// 以前每發現一條店名規則要改，就得等 Claude 改程式→PR→合併→重啟。這裡把規則變成可編輯的資料。
// 兩個 UI 上的堅持：
// ①**表單而非正規表示式**：使用者填純文字＋選比對方式，後端負責跳脫（沒有程式背景也不會誤傷全庫）。
// ②**先預覽再儲存**：規則是全庫生效的，一條寫太寬會改壞幾百筆——所以「儲存」前一定先看到影響。
/** 五種規則的表單定義（欄位與後端 lib/store-rules.js 的形狀一一對應）。 */
const RULE_SECTIONS = [
  { key: 'canon', title: '這些寫法是同一家店', mode: true,
    hint: '帳單上同一家店有好幾種寫法時，統一成一個名字。<b>這改的是「身分鑰匙」：不管分店、只管品牌</b>——命中的消費整家店算成同一家（統計、排行、學習全部合併），顯示名也會變成這個名字。例：帳單印「XX咖啡 A1234 Taipei」和「XX咖啡館」，填「XX咖啡」→「XX咖啡」。要保留分店寫法，請用下面「併回品牌名」那一種。',
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
export function openStoreRulesEditor(rules) {
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

  // 外殼歸戶（U3 擴大）
  const { close } = openModalShell({
    title: '店名規則', size: 'lg',
    bodyHtml: `
      <p class="muted" style="font-size:12px;margin-bottom:10px">你自己加的規則<b>優先於系統內建規則</b>。填的都是<b>普通文字</b>（不是程式碼），系統會照字面比對。
      規則對<b>全部</b>記錄生效，所以請先按「預覽影響」看看會改到哪些，確認沒問題再儲存。⚠️ 存下去沒有「復原」可以按，<b>別只靠系統的自動備份</b>（只有<b>本機版</b>才有那一份，而且失敗了畫面不會講）——動手前請先到設定頁最下面「資料與備份」按「匯出備份」存一份。</p>
      <div id="ruleEditorBody" style="max-height:50vh;overflow:auto"></div>
      <div class="form-actions">
        <button type="button" class="btn-ghost" data-cancel>取消</button>
        <button type="button" class="btn-ghost" id="rulePreview">預覽影響</button>
        <button type="button" class="btn" id="ruleSave">儲存並套用</button>
      </div>`,
  });
  root.querySelector('[data-cancel]').onclick = close;
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
  // ⚠️ 刻意**不用** openModalShell（U3 擴大的記錄在案例外）：這個窗的「×」是**返回編輯**（onBack）
  // 不是關閉，且**沒有**背景點擊關閉——防止使用者點到背景把「編輯到一半的規則」整窗弄丟。
  // 外殼會接管 x-close 與 bindBackdropClose，語意不同不可硬套（Codex U3 修訂點名的情況）。
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
