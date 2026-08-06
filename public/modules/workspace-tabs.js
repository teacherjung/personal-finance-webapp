// @ts-check
// 共用頁籤產生器：只負責可存取的連結結構，輪廓與響應式行為在 workspace-tabs.css。

import { icon } from './icons.js';

/** @typedef {{ key: string, label: string, icon: string }} WorkspaceTab */

/**
 * @param {{
 *   tabs: readonly WorkspaceTab[],
 *   activeKey: string,
 *   ariaLabel: string,
 *   idPrefix: string,
 *   hrefFor: (tab: WorkspaceTab) => string
 * }} options
 * @param {{ esc: (value: unknown) => string }} helpers
 */
export function workspaceTabsHtml(options, helpers) {
  if (typeof helpers?.esc !== 'function') throw new TypeError('workspaceTabsHtml 需要 esc 格式器');
  if (typeof options?.hrefFor !== 'function') throw new TypeError('workspaceTabsHtml 需要 hrefFor');

  const links = options.tabs.map(tab => {
    const active = tab.key === options.activeKey;
    return `<a id="${helpers.esc(`${options.idPrefix}-${tab.key}`)}" class="workspace-tab${active ? ' is-active' : ''}" href="${helpers.esc(options.hrefFor(tab))}" aria-label="${helpers.esc(tab.label)}" title="${helpers.esc(tab.label)}"${active ? ' aria-current="page"' : ''}>${icon(tab.icon, 18)}<span class="workspace-tab__label">${helpers.esc(tab.label)}</span></a>`;
  }).join('');

  return `<nav class="workspace-tabs workspace-tabs--compact-mobile" aria-label="${helpers.esc(options.ariaLabel)}">
    <div class="workspace-tabs__track">${links}</div>
  </nav>`;
}
