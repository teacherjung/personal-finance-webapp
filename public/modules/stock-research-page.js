// @ts-check
// 個股研究頁控制器：讀取現有資料、組合 P1/P3 純模型並綁定研究互動。
// 本模組不 import app.js；所有 DOM/API 工具由 app.js 注入，避免循環 import 的 TDZ。

import { buildPortfolioModel } from './portfolio-model.js';
import { createPortfolioResearchActions } from './portfolio-research-actions.js';
import { buildStockResearchModel, findStockResearch } from './stock-research-model.js';
import {
  shouldRefreshStockFundamentals,
  stockFundamentalsFailureState,
  stockFundamentalsInnerHtml
} from './stock-research-fundamentals.js';
import { normalizePortfolioSymbol } from './portfolio-symbol.js';
import {
  STOCK_RESEARCH_INFO,
  normalizeStockResearchTab,
  stockResearchViewHtml
} from './stock-research-view.js';

/** @param {unknown} value */
function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/** @param {unknown} value */
function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 每次 render 都從當下 hash 取代號，不快取上一個公司。
 * @param {unknown} hash
 */
export function stockSymbolFromHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const queryAt = raw.indexOf('?');
  if ((queryAt < 0 ? raw : raw.slice(0, queryAt)) !== 'stock') return '';
  const params = new URLSearchParams(queryAt < 0 ? '' : raw.slice(queryAt + 1));
  return normalizePortfolioSymbol(params.get('symbol'));
}

/**
 * tab 只接受六個固定 key；缺值、非法值與原型名稱都回總覽。
 * @param {unknown} hash
 */
export function stockTabFromHash(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const queryAt = raw.indexOf('?');
  if ((queryAt < 0 ? raw : raw.slice(0, queryAt)) !== 'stock') return 'overview';
  const params = new URLSearchParams(queryAt < 0 ? '' : raw.slice(queryAt + 1));
  return normalizeStockResearchTab(params.get('tab'));
}

/** @param {any} root */
export function revealActiveStockTab(root) {
  const active = root?.querySelector?.('.stock-tab.active');
  active?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
}

/**
 * 估值區只顯示持股已保存的現價，不因打開研究頁另抓網路或寫回持股。
 * @param {string} symbol
 * @param {any[]} holdings
 * @param {Record<string, any>} settings
 */
export function stockQuoteFromHoldings(symbol, holdings, settings) {
  const key = normalizePortfolioSymbol(symbol);
  const holding = holdings.find(item => (
    normalizePortfolioSymbol(item?.symbol) === key
    && item?.layer === 'stock'
    && finiteOrNull(item?.price) != null
  ));
  if (!holding) return {};
  const asOfMatch = /^(\d{4}-\d{2}-\d{2})/.exec(String(settings.quotesLastAt || ''));
  return {
    price: finiteOrNull(holding.price),
    currency: String(holding.currency || 'TWD').toUpperCase(),
    source: holding.quoteSymbol ? 'Yahoo Finance' : '持股資料',
    asOf: holding.quoteSymbol ? (asOfMatch?.[1] || '') : ''
  };
}

/**
 * @typedef {Object} StockResearchPageDeps
 * @property {(path:string, options?:any)=>Promise<any>} api
 * @property {()=>any} getView
 * @property {()=>string} getHash
 * @property {()=>number} getRouteSeq
 * @property {()=>string} getViewCurrency
 * @property {(value:any)=>string} esc
 * @property {(config:any)=>void} openForm
 * @property {(title:string, html:string, options?:any)=>void} openInfo
 * @property {(message:string, error?:boolean)=>void} toast
 * @property {()=>string} today
 */

/**
 * @param {StockResearchPageDeps} deps
 */
export function createStockResearchPage(deps) {
  let renderGeneration = 0;

  async function renderStockResearch() {
    const routeSeq = deps.getRouteSeq();
    const generation = ++renderGeneration;
    const symbol = stockSymbolFromHash(deps.getHash());
    const activeTab = stockTabFromHash(deps.getHash());
    const isCurrent = () => (
      routeSeq === deps.getRouteSeq()
      && generation === renderGeneration
      && stockSymbolFromHash(deps.getHash()) === symbol
      && stockTabFromHash(deps.getHash()) === activeTab
    );
    const rerenderIfCurrent = () => {
      if (isCurrent()) void renderStockResearch();
    };

    if (!symbol) {
      if (!isCurrent()) return;
      deps.getView().innerHTML = stockResearchViewHtml({
        model: buildStockResearchModel({ symbol: '' }),
        activeTab
      }, { esc: deps.esc });
      return;
    }

    const [holdingsRaw, researchRaw, securitiesRaw, summaryRaw, settingsRaw] = await Promise.all([
      deps.api('/holdings'),
      deps.api('/research'),
      deps.api('/securities'),
      deps.api('/summary'),
      deps.api('/settings')
    ]);
    if (!isCurrent()) return;

    const holdings = arrayOrEmpty(holdingsRaw);
    const research = arrayOrEmpty(researchRaw);
    const securities = objectOrEmpty(securitiesRaw);
    const summary = objectOrEmpty(summaryRaw);
    const settings = objectOrEmpty(settingsRaw);
    const rows = buildPortfolioModel(holdings, [], settings).rows;
    const model = buildStockResearchModel({
      symbol,
      rows,
      research,
      netWorth: summary.netWorth,
      settings
    });
    let fundamentals = null;
    const fundamentalsPath = `/stock-fundamentals/${encodeURIComponent(symbol)}`;
    if (activeTab === 'fundamentals' && model.availability.state !== 'empty') {
      try {
        fundamentals = await deps.api(fundamentalsPath);
      } catch (error) {
        fundamentals = stockFundamentalsFailureState(null, error, symbol);
      }
      if (!isCurrent()) return;
    }
    const quote = stockQuoteFromHoldings(symbol, holdings, settings);
    const root = deps.getView();
    root.innerHTML = stockResearchViewHtml({
      model,
      trades: arrayOrEmpty(securities.trades),
      quote,
      viewCurrency: deps.getViewCurrency(),
      usdRate: settings.usdTwd,
      activeTab,
      fundamentals
    }, { esc: deps.esc });
    if (!isCurrent()) return;
    revealActiveStockTab(root);

    const bindStockInfo = (scope) => {
      scope?.querySelectorAll?.('[data-stock-info]').forEach((button) => {
        button.onclick = () => {
          const key = button.dataset.stockInfo;
          if (!Object.hasOwn(STOCK_RESEARCH_INFO, key)) return;
          const info = STOCK_RESEARCH_INFO[key];
          deps.openInfo(info.title, info.html);
        };
      });
    };
    bindStockInfo(root);

    const researchActions = createPortfolioResearchActions({
      api: deps.api,
      getElement: id => root.ownerDocument?.getElementById(id) || null,
      getAll: selector => root.querySelectorAll(selector),
      openForm: deps.openForm,
      toast: deps.toast,
      rerender: rerenderIfCurrent,
      today: deps.today
    });
    root.querySelectorAll('[data-stock-edit], [data-stock-create]').forEach((button) => {
      button.onclick = () => researchActions.openResearchForm(symbol, research);
    });

    const existing = findStockResearch(symbol, research);
    root.querySelectorAll('[data-stock-add-checkpoint]').forEach((button) => {
      button.onclick = () => deps.openForm({
        title: `${symbol} 新增檢查點`,
        fields: [
          { key: 'date', label: '日期', type: 'date', required: true, default: deps.today() },
          { key: 'note', label: '檢查筆記', type: 'textarea', full: true, required: true }
        ],
        onSubmit: async (data) => {
          if (!existing?.id) throw new Error('找不到這筆研究資料，請重新整理後再試一次');
          await deps.api('/research/' + encodeURIComponent(existing.id), {
            method: 'PUT',
            body: {
              checkpoints: [
                ...arrayOrEmpty(existing.checkpoints),
                { date: String(data.date || '').trim(), note: String(data.note || '').trim() }
              ]
            }
          });
          deps.toast('已記錄檢查點');
          rerenderIfCurrent();
        }
      });
    });

    if (activeTab === 'fundamentals' && model.availability.state !== 'empty') {
      let currentFundamentals = fundamentals;
      /** @type {Promise<void>|null} */
      let refreshPromise = null;
      const manualInput = {
        watchMetrics: model.research?.watchMetrics,
        legacyMetrics: model.research?.metrics
      };

      const bindFundamentalsRefresh = () => {
        const mount = root.querySelector('[data-stock-fundamentals-root]');
        mount?.querySelectorAll?.('[data-stock-fundamentals-refresh]').forEach((button) => {
          button.onclick = () => { void refreshFundamentals(true); };
        });
      };

      const drawFundamentals = (refreshing) => {
        if (!isCurrent()) return;
        const mount = root.querySelector('[data-stock-fundamentals-root]');
        if (!mount) return;
        mount.innerHTML = stockFundamentalsInnerHtml({
          cache: currentFundamentals,
          refreshing,
          ...manualInput
        }, { esc: deps.esc });
        bindStockInfo(mount);
        bindFundamentalsRefresh();
      };

      const refreshFundamentals = (manual) => {
        if (refreshPromise) return refreshPromise;
        refreshPromise = (async () => {
          drawFundamentals(true);
          try {
            currentFundamentals = await deps.api(`${fundamentalsPath}/refresh`, { method: 'POST' });
            if (!isCurrent()) return;
            if (manual) {
              const failed = Boolean(currentFundamentals?.refreshError || currentFundamentals?.refreshed === false);
              deps.toast(
                failed ? '官方基本面更新失敗，已保留上次成功資料' : '官方基本面已更新',
                failed
              );
            }
          } catch (error) {
            currentFundamentals = stockFundamentalsFailureState(currentFundamentals, error, symbol);
            if (!isCurrent()) return;
            if (manual) deps.toast(/** @type {any} */ (error)?.message || '官方基本面更新失敗', true);
          } finally {
            refreshPromise = null;
            drawFundamentals(false);
          }
        })();
        return refreshPromise;
      };

      bindFundamentalsRefresh();
      if (shouldRefreshStockFundamentals(currentFundamentals)) void refreshFundamentals(false);
    }
  }

  return renderStockResearch;
}
