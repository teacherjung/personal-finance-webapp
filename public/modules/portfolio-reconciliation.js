// @ts-check
import { isRealDate } from './calendar-date.js';
import { normalizePortfolioSymbol } from './portfolio-symbol.js';
const SCALE = 1_000_000;
const LIMIT = 1_000_000_000 * SCALE;

/** @param {string} text */
function parseDecimal(text) {
  const value = text.trim().replace(/^−/, '-');
  if (!value) return { ok: false, reason: 'missing' };
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return { ok: false, reason: 'syntax' };
  const whole = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] || '').replace(/0+$/, '');
  if (fraction.length > 6) return { ok: false, reason: 'precision' };
  if (whole.length > 10 || (whole.length === 10 && whole > '1000000000')) return { ok: false, reason: 'range' };
  const absolute = Number(whole + fraction.padEnd(6, '0'));
  if (!Number.isSafeInteger(absolute) || absolute > LIMIT) return { ok: false, reason: 'range' };
  const scaled = absolute === 0 ? 0 : match[1] === '-' ? -absolute : absolute;
  return { ok: true, scaled };
}

/** @param {unknown} input */
export function parseReferenceQuantity(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'type' };
  return parseDecimal(input);
}

/** @param {unknown} input */
export function parseAppQuantity(input) {
  if (typeof input !== 'number') return { ok: false, reason: 'type' };
  if (!Number.isFinite(input)) return { ok: false, reason: 'non-finite' };
  return parseDecimal(String(input));
}

/** @param {number} scaled */
export function quantityText(scaled) {
  if (!Number.isSafeInteger(scaled) || Math.abs(scaled) > 2 * LIMIT) throw new RangeError('Invalid exact quantity');
  const digits = String(Math.abs(scaled)).padStart(7, '0');
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/, '');
  return (scaled < 0 ? '−' : '') + whole + (fraction ? '.' + fraction : '');
}

/** Pure arithmetic only; identity/date/unit confirmation belongs to its caller.
 * @param {unknown} referenceText @param {unknown} appQuantity */
export function quantityDifference(referenceText, appQuantity) {
  const reference = parseReferenceQuantity(referenceText);
  const app = parseAppQuantity(appQuantity);
  if (!reference.ok || !app.ok) return { ok: false, reference, app };
  const scaled = /** @type {number} */ (reference.scaled) - /** @type {number} */ (app.scaled);
  if (!Number.isSafeInteger(scaled) || Math.abs(scaled) > 2 * LIMIT) return { ok: false, reason: 'range' };
  return { ok: true, scaled, text: quantityText(scaled) };
}


const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** @param {any} deps */
export function createReferenceComparison({ isRealDate, normalizePortfolioSymbol }) {
  if (typeof isRealDate !== 'function' || typeof normalizePortfolioSymbol !== 'function') {
    throw new TypeError('Date and symbol validators are required');
  }
  /** @param {any} [input] */
  return function compareReference({ holdings, selectedId, reference, confirmations } = {}) {
    const reasons = [];
    const rows = Array.isArray(holdings) ? holdings : [];
    const matches = nonempty(selectedId) ? rows.filter(row => own(row, 'id') === selectedId) : [];
    if (!nonempty(selectedId)) reasons.push('selection-required');
    if (matches.length !== 1) reasons.push('selection-not-unique');
    const selected = matches.length === 1 ? matches[0] : undefined;
    for (const key of ['sourceLabel', 'scopeLabel', 'marketLabel']) {
      if (!nonempty(own(reference, key))) reasons.push(key + '-required');
    }
    const referenceSymbol = own(reference, 'symbol');
    const appSymbol = own(selected, 'symbol');
    const symbolsUsable = nonempty(referenceSymbol) && nonempty(appSymbol);
    if (!symbolsUsable) reasons.push('symbol-required');
    if (symbolsUsable && normalizePortfolioSymbol(referenceSymbol) !== normalizePortfolioSymbol(appSymbol)) {
      reasons.push('symbol-mismatch');
    }
    const referenceDate = own(reference, 'date');
    if (isRealDate(referenceDate) !== true) reasons.push('reference-date-invalid');
    const unit = own(reference, 'unit');
    if (unit !== '股' && unit !== '單位') reasons.push('unit-unconfirmed-or-unsupported');
    for (const key of ['sameInstrument', 'sameScope', 'sameQuantityDefinition']) {
      if (own(confirmations, key) !== true) reasons.push(key + '-unconfirmed');
    }
    const referenceQuantity = own(reference, 'quantity');
    const appQuantity = own(selected, 'quantity');
    const base = {
      kind: 'parallel', reasons,
      referenceQuantity: typeof referenceQuantity === 'string' ? referenceQuantity : null,
      appQuantity: typeof appQuantity === 'number' && Number.isFinite(appQuantity) ? appQuantity : null,
      referenceDate: typeof referenceDate === 'string' ? referenceDate : null,
      appPositionDate: null,
      identityBasis: 'manual-confirmation',
      reconciliation: 'not-established',
      difference: null,
    };
    if (reasons.length) return base;
    const difference = quantityDifference(referenceQuantity, appQuantity);
    if (!difference.ok) return { ...base, reasons: ['quantity-invalid'], quantityValidation: difference };
    return { ...base, kind: 'difference', difference: { scaled: difference.scaled, text: difference.text } };
  };
}

const FIELDS = Object.freeze(['id', 'symbol', 'name', 'currency', 'quantity', 'source']);
const unsupported = () => Object.freeze({ ok: false, reason: 'unsupported-snapshot-input' });
const primitive = value => value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value);

// 避免保留無關欄位；不宣稱能檢查任意 Proxy 的副作用。
/** @param {any} holdings */
export function snapshotHoldings(holdings) {
  if (!Array.isArray(holdings)) return unsupported();
  const projected = [];
  for (let index = 0; index < holdings.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(holdings, String(index));
    if (!item || !Object.hasOwn(item, 'value')) return unsupported();
    const row = item.value;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return unsupported();
    const prototype = Object.getPrototypeOf(row);
    if (prototype !== Object.prototype && prototype !== null) return unsupported();
    const copy = {};
    for (const key of FIELDS) {
      const field = Object.getOwnPropertyDescriptor(row, key);
      if (!field) continue;
      if (!Object.hasOwn(field, 'value') || !primitive(field.value)) return unsupported();
      copy[key] = field.value;
    }
    projected.push(Object.freeze(copy));
  }
  return Object.freeze({ ok: true, rows: Object.freeze(projected) });
}

const CONTEXT_FIELDS = new Set(['sourceLabel', 'scopeLabel', 'symbol', 'marketLabel', 'date', 'unit']);
const REFERENCE_FIELDS = new Set([...CONTEXT_FIELDS, 'quantity']);
const CONFIRMATION_FIELDS = new Set(['sameInstrument', 'sameScope', 'sameQuantityDefinition']);
const emptyConfirmations = () => ({ sameInstrument: false, sameScope: false, sameQuantityDefinition: false });
/** @param {string} reason @returns {{ok:false, reason:string}} */
const refused = reason => ({ ok: false, reason });

// 固定開窗時的輸入，避免後來刷新來源偷偷改變同一輪比較。
/** @param {any} [options] */
export function createReferenceSession({ holdings, snapshotHoldings, compareReference } = {}) {
  if (typeof snapshotHoldings !== 'function' || typeof compareReference !== 'function') throw new TypeError('Snapshot and comparison functions are required');
  const snapshot = snapshotHoldings(holdings);
  if (!snapshot.ok) return refused('unsupported-snapshot-input');
  const rows = snapshot.rows;
  let active = true;
  let selectedId = '';
  const reference = { sourceLabel: '', scopeLabel: '', symbol: '', marketLabel: '', date: '', unit: '', quantity: '' };
  let confirmations = emptyConfirmations();
  let comparison = null;
  const clearResult = () => { comparison = null; };
  function read() {
    return { ...structuredClone({ status: active ? 'active' : 'disposed', selectedId, reference, confirmations, comparison }), rows };
  }
  /** @returns {{ok:true,changed:boolean}|{ok:false,reason:string}} */
  function select(value) {
    if (!active) return refused('disposed');
    if (typeof value !== 'string') return refused('invalid-selected-id');
    if (value === selectedId) return { ok: true, changed: false };
    selectedId = value;
    clearResult();
    confirmations = emptyConfirmations();
    return { ok: true, changed: true };
  }
  /** @returns {{ok:true,changed:boolean}|{ok:false,reason:string}} */
  function setReferenceField(field, value) {
    if (!active) return refused('disposed');
    if (!REFERENCE_FIELDS.has(field) || typeof value !== 'string') return refused('invalid-reference-field');
    if (reference[field] === value) return { ok: true, changed: false };
    reference[field] = value;
    clearResult();
    if (CONTEXT_FIELDS.has(field)) confirmations = emptyConfirmations();
    return { ok: true, changed: true };
  }
  /** @returns {{ok:true,changed:boolean}|{ok:false,reason:string}} */
  function setConfirmation(field, value) {
    if (!active) return refused('disposed');
    if (!CONFIRMATION_FIELDS.has(field) || typeof value !== 'boolean') return refused('invalid-confirmation-field');
    if (confirmations[field] === value) return { ok: true, changed: false };
    confirmations[field] = value;
    clearResult();
    return { ok: true, changed: true };
  }
  function calculate() {
    if (!active) return refused('disposed');
    // Clear before invoking the dependency so an exception cannot leave a stale successful result.
    clearResult();
    comparison = compareReference({ holdings: rows, selectedId, reference, confirmations });
    return { ok: true, comparison: structuredClone(comparison) };
  }
  function dispose() {
    active = false;
    clearResult();
    confirmations = emptyConfirmations();
    return { ok: true, status: 'disposed' };
  }
  return Object.freeze({ ok: true, select, setReferenceField, setConfirmation, calculate, read, dispose });
}

const comparePortfolioReference = createReferenceComparison({ isRealDate, normalizePortfolioSymbol });
/** @param {any[]} holdings */
export function createPortfolioReferenceSession(holdings) {
  return createReferenceSession({ holdings, snapshotHoldings, compareReference: comparePortfolioReference });
}
