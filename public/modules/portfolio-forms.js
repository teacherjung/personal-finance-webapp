// @ts-check
// 投資表單的純資料規格：欄位、預設值、持股送出前整理與凍結加碼原因。

import { compOf } from './portfolio-exposure.js';
import { normalizePortfolioSymbol } from './portfolio-symbol.js';

export const PORTFOLIO_CURRENCIES = ['USD', 'TWD', 'GBP', 'JPY'];

/** @param {any} settings */
export function fxBandsFormModel(settings) {
  return {
    title: '調整換匯分批區間',
    fields: [
      { key: 'fxLow', label: '低於此值＝台幣→美元 分批區', type: 'number', required: true, step: '0.1' },
      { key: 'fxHigh', label: '高於此值＝美元→台幣 分批區', type: 'number', required: true, step: '0.1' }
    ],
    values: { fxLow: settings.fxLow || 28, fxHigh: settings.fxHigh || 32 }
  };
}

/** @param {any} settings */
export function signalsFormModel(settings) {
  return {
    title: '更新估值訊號（區域市場，每月一次）',
    size: 'md',
    fields: [
      { key: 'china', label: '中股 滬深300 本益比', type: 'number', step: '0.1', placeholder: '例：12.3' },
      { key: 'japan', label: '日股 整體 P/B', type: 'number', step: '0.01', placeholder: '例：1.25' },
      { key: 'korea', label: '韓股 KOSPI P/B', type: 'number', step: '0.01', placeholder: '例：0.95' },
      { key: 'taiwanPE', label: '台股 大盤本益比', type: 'number', step: '0.1', placeholder: '例：17.5' },
      { key: 'taiwanYield', label: '台股 大盤殖利率（%）', type: 'number', step: '0.1', placeholder: '例：3.2' },
      { key: 'realYieldManual', label: '美10年實質利率手動值（%，FRED 失敗時才需填）', type: 'number', step: '0.01', full: true }
    ],
    values: settings.signals || {}
  };
}

/** @param {any} settings */
export function capeFormModel(settings) {
  return {
    title: '手動設定 Shiller PE',
    fields: [{ key: 'capeManual', label: '目前 CAPE 值（multpl.com 可查）', type: 'number', required: true }],
    values: { capeManual: settings.capeManual || '' }
  };
}

/**
 * @param {any} holding
 * @param {Record<string, {label:string}>} layers
 * @param {string[]} layerOrder
 */
export function holdingFormModel(holding, layers, layerOrder) {
  return {
    title: holding ? '編輯持股' : '新增持股',
    fields: [
      { key: 'symbol', label: '代號', type: 'text', required: true, placeholder: '例：CSPX' },
      { key: 'name', label: '說明（一眼看懂持有什麼）', type: 'text', placeholder: '例：美國指數' },
      { key: 'layer', label: '層（核心–衛星）', type: 'select', options: layerOrder.map(key => ({ value: key, label: layers[key].label })) },
      { key: 'currency', label: '計價幣別', type: 'select', options: PORTFOLIO_CURRENCIES },
      { key: 'quantity', label: '股數', type: 'number', required: true },
      { key: 'avgCost', label: '購買均價（原幣，自動算投入成本）', type: 'number', step: '0.01' },
      { key: 'price', label: '現價（原幣）', type: 'number', required: true, step: '0.01' },
      { key: 'quoteSymbol', label: 'Yahoo 報價代號（留空＝手動報價）', type: 'text', placeholder: '例：CSPX.L、00719B.TWO、QQQM' }
    ],
    values: holding
      ? {
          ...holding,
          avgCost: holding.avgCost != null
            ? Math.round(Number(holding.avgCost) * 100) / 100
            : (Number(holding.quantity) ? Math.round(Number(holding.cost || 0) / Number(holding.quantity) * 100) / 100 : '')
        }
      : { currency: 'USD', layer: 'core' }
  };
}

/**
 * @param {any} holding
 * @param {any} data
 * @param {{symbols:Set<string>, regions:Set<string>, equity:boolean}} freeze
 */
export function holdingSubmission(holding, data, freeze) {
  const oldQty = holding ? Number(holding.quantity || 0) : 0;
  const newQty = Number(data.quantity || 0);
  const symbol = normalizePortfolioSymbol(data.symbol);
  /** @type {string[]} */
  const freezeReasons = [];

  const composition = compOf({ symbol, layer: data.layer });
  const oldSymbol = normalizePortfolioSymbol(holding?.symbol);
  const oldComposition = holding ? compOf({ symbol: oldSymbol, layer: holding.layer }) : null;
  const identityChanged = Boolean(holding) && (
    symbol !== oldSymbol
    || data.layer !== holding.layer
    || composition.type !== oldComposition?.type
    || JSON.stringify(composition.regions) !== JSON.stringify(oldComposition?.regions)
  );

  if (newQty > 0 && (newQty > oldQty || identityChanged)) {
    if (freeze.symbols.has(symbol)) freezeReasons.push('單一個股上限');
    for (const region of Object.keys(composition.regions || {})) {
      if (freeze.regions.has(region)) freezeReasons.push(`${region}上限`);
    }
    if (composition.type === 'equity' && freeze.equity) freezeReasons.push('股票總曝險上限');
  }

  const body = { ...data };
  body.symbol = symbol;
  body.avgCost = Math.round(Number(data.avgCost || 0) * 100) / 100;
  body.price = Math.round(Number(data.price || 0) * 100) / 100;
  body.cost = Math.round((body.avgCost * Number(data.quantity || 0)) * 100) / 100;
  return { symbol, freezeReasons, body };
}

/** @param {any} watch */
export function watchFormModel(watch) {
  return {
    title: watch ? '編輯願望清單' : '新增願望清單',
    fields: [
      { key: 'symbol', label: '代號', type: 'text', required: true },
      { key: 'name', label: '說明', type: 'text', placeholder: '例：中國網路' },
      { key: 'targetPrice', label: '目標買價（原幣）', type: 'number', required: true, step: '0.01' },
      { key: 'currency', label: '幣別', type: 'select', options: PORTFOLIO_CURRENCIES },
      { key: 'quoteSymbol', label: 'Yahoo 報價代號', type: 'text', placeholder: '例：KWEB、ICHN.L' },
      { key: 'note', label: '備註（為什麼等這個價位）', type: 'text', full: true }
    ],
    values: watch || { currency: 'USD' }
  };
}
