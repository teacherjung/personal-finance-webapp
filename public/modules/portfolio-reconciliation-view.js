// @ts-check
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined;
const text = value => typeof value === 'string' && value.trim() ? value : '未記錄';
const quantityText = value => (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value)) ? String(value).replace(/^-/, '−') : '未記錄／無法判讀';
const REASONS = new Map([
  ['calculation-required', '填妥後按「計算差額」；輸入改動後需重新計算。'],
  ['selection-required', '請明確選取一筆 App 紀錄。'],
  ['selection-not-unique', '選取的紀錄不存在或身分重複，無法確認是哪一筆。'],
  ['sourceLabel-required', '請填寫參考資料的來源名稱。'],
  ['scopeLabel-required', '請填寫帳戶或比較範圍的別名。'],
  ['marketLabel-required', '請填寫市場或掛牌描述。'],
  ['symbol-required', '兩側都需要標的代號。'],
  ['symbol-mismatch', '兩側標的代號不同，尚不能計算差額。'],
  ['reference-date-invalid', '請填寫有效的參考基準日。'],
  ['unit-unconfirmed-or-unsupported', '請確認數量單位為股或單位。'],
  ['sameInstrument-unconfirmed', '尚未手動確認同一證券與掛牌身分。'],
  ['sameScope-unconfirmed', '尚未手動確認這筆 App 紀錄正是要比較的範圍。'],
  ['sameQuantityDefinition-unconfirmed', '尚未手動確認數量定義、正負號與單位相同。'],
  ['quantity-invalid', '數量缺漏、格式或精度超出本工具範圍，不能計算差額。'],
]);
const UNKNOWN_REASON = '無法判讀比對條件，請檢查輸入。';

// 資格及相減由模型決定，本層不從呈現文字重算。
/** @param {any} [options] */
export function createReferenceView({ escapeHtml } = {}) {
  if (typeof escapeHtml !== 'function') throw new TypeError('escapeHtml is required');
  const esc = escapeHtml;
  /** @param {any[]} rows */
  function initialForm(rows) {
    if (!Array.isArray(rows)) throw new TypeError('Snapshot rows are required');
    const options = rows.map(row => {
      const id = own(row, 'id');
      const usableId = typeof id === 'string' && id.trim().length > 0;
      const value = usableId ? id : '';
      const label = `${text(own(row, 'symbol'))}｜${text(own(row, 'name'))}｜${quantityText(own(row, 'quantity'))}｜${text(own(row, 'currency'))}`;
      return `<option value="${esc(value)}"${usableId ? '' : ' disabled'}>${esc(label)}</option>`;
    }).join('');
    const fields = [
      ['sourceLabel', '來源名稱'], ['scopeLabel', '帳戶／比較範圍別名'],
      ['date', '參考基準日'], ['symbol', '標的代號'], ['marketLabel', '市場／掛牌描述'], ['quantity', '參考數量'],
    ].map(([name, label]) => `<label>${label}<input name="${name}" type="text" value="" autocomplete="off"></label>`).join('');
    const confirmations = [
      ['sameInstrument', '我手動確認同一證券與掛牌身分'],
      ['sameScope', '我手動確認本筆 App 紀錄正是要比較的範圍'],
      ['sameQuantityDefinition', '我手動確認數量定義、正負號與單位相同'],
    ].map(([name, label]) => `<div class="full"><label class="inline-check" style="margin-left:0;white-space:normal"><input style="width:auto" type="checkbox" name="${name}">${label}</label></div>`).join('');
    return `<form data-reference-form autocomplete="off"><p>參考資料：手動輸入；確認由你操作，不代表程式已查證。</p><p class="field-hint">範圍請填別名，不必填完整帳號。基準日格式：YYYY-MM-DD。數量每側最多十億、最多六位有效小數；這是本工具的計算範圍。股與單位不作轉換，淨部位、可賣量或交割口徑不明時請勿勾選確認。</p><div class="form-grid"><label class="full">App 紀錄<select name="selectedId"><option value="" selected>請選取一筆</option>${options}</select></label>${fields}<label>數量單位<select name="unit"><option value="" selected>未確認</option><option value="股">股</option><option value="單位">單位</option></select></label>${confirmations}</div><div data-reference-result aria-live="polite"></div><div class="form-actions"><button type="button" class="btn-ghost" data-reference-close>關閉</button><button type="submit" class="btn-primary">計算差額</button></div></form>`;
  }
  /** @param {any} [data] */
  function resultHtml({ comparison, reference, selected } = {}) {
    const reasons = own(comparison, 'reasons');
    const difference = own(comparison, 'difference');
    const diffText = own(difference, 'text');
    const validDifference = own(comparison, 'kind') === 'difference'
      && Array.isArray(reasons) && reasons.length === 0
      && own(comparison, 'identityBasis') === 'manual-confirmation'
      && own(comparison, 'reconciliation') === 'not-established'
      && own(comparison, 'appPositionDate') === null
      && Number.isSafeInteger(own(difference, 'scaled'))
      && typeof diffText === 'string' && /^−?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(diffText);
    const unit = own(reference, 'unit');
    const unitText = unit === '股' || unit === '單位' ? unit : '未確認';
    const quantities = `<p>參考數量：${esc(quantityText(own(comparison, 'referenceQuantity')))}</p><p>App 紀錄數量：${esc(quantityText(own(comparison, 'appQuantity')))}</p><p>數量單位：${esc(unitText)}</p>`;
    const metadata = `<p>App 紀錄：${esc(text(own(selected, 'symbol')))}｜${esc(text(own(selected, 'name')))}｜${esc(text(own(selected, 'currency')))}</p><p>參考來源（手動輸入）：${esc(text(own(reference, 'sourceLabel')))}</p><p>比較範圍別名（手動輸入）：${esc(text(own(reference, 'scopeLabel')))}</p><p>市場／掛牌描述（手動輸入）：${esc(text(own(reference, 'marketLabel')))}</p><p>參考基準日（手動輸入）：${esc(text(own(comparison, 'referenceDate')))}</p><p>App：本頁已載入的一筆紀錄；部位基準日未記錄。</p><p>App 原來源標記：${esc(text(own(selected, 'source')))}；原標記不是帳戶、市場或同日部位的查證。</p><p>證券與範圍身分依手動確認，並非程式自動查證。</p>`;
    if (validDifference) {
      const displayDifference = diffText.replace(/^-/, '−');
      const zero = diffText === '0' ? '<p>兩個輸入數量相減為 0。</p>' : '';
      return `<section>${metadata}${quantities}<p>參考數量 − App 紀錄數量</p><output data-reference-difference>${esc(displayDifference)}</output>${zero}<p>這只是兩個輸入數量相減，尚未建立帳戶或部位核對結果。</p></section>`;
    }
    const descriptions = Array.isArray(reasons) && reasons.length
      ? reasons.map(reason => REASONS.get(reason) ?? UNKNOWN_REASON)
      : [UNKNOWN_REASON];
    return `<section>${metadata}${quantities}<p>僅並列數量，尚不能計算差額。</p><ul>${descriptions.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></section>`;
  }
  return Object.freeze({ initialForm, resultHtml });
}
