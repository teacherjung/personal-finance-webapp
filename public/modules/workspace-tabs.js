// @ts-check
// 共用頁籤產生器：只負責可存取的連結結構，輪廓與響應式行為在 workspace-tabs.css。

import { icon } from './icons.js';

/** @typedef {{ key: string, label: string, icon: string }} WorkspaceTab */

const START_JOIN = `<svg class="workspace-tab__join workspace-tab__join--start" viewBox="0 0 22 22" preserveAspectRatio="none" aria-hidden="true" focusable="false">
  <path class="workspace-tab__join-fill" d="M20 0H22V22H0C11.046 22 20 13.046 20 2Z"></path>
  <path class="workspace-tab__join-line" d="M20 0V2C20 13.046 11.046 22 0 22"></path>
</svg>`;

const END_JOIN = `<svg class="workspace-tab__join workspace-tab__join--end" viewBox="0 0 22 22" preserveAspectRatio="none" aria-hidden="true" focusable="false">
  <path class="workspace-tab__join-fill" d="M0 0H2V2C2 13.046 10.954 22 22 22H0Z"></path>
  <path class="workspace-tab__join-line" d="M2 0V2C2 13.046 10.954 22 22 22"></path>
</svg>`;

/**
 * @param {{
 *   tabs: readonly WorkspaceTab[],
 *   activeKey: string,
 *   ariaLabel: string,
 *   idPrefix: string,
 *   hrefFor: (tab: WorkspaceTab) => string,
 *   compactOnMobile?: boolean
 * }} options
 * @param {{ esc: (value: unknown) => string }} helpers
 */
export function workspaceTabsHtml(options, helpers) {
  if (typeof helpers?.esc !== 'function') throw new TypeError('workspaceTabsHtml 需要 esc 格式器');
  if (typeof options?.hrefFor !== 'function') throw new TypeError('workspaceTabsHtml 需要 hrefFor');

  const navClass = options.compactOnMobile === false
    ? 'workspace-tabs'
    : 'workspace-tabs workspace-tabs--compact-mobile';
  const links = options.tabs.map(tab => {
    const active = tab.key === options.activeKey;
    return `<a id="${helpers.esc(`${options.idPrefix}-${tab.key}`)}" class="workspace-tab${active ? ' is-active' : ''}" href="${helpers.esc(options.hrefFor(tab))}" aria-label="${helpers.esc(tab.label)}" title="${helpers.esc(tab.label)}"${active ? ' aria-current="page"' : ''}>${START_JOIN}${icon(tab.icon, 18)}<span class="workspace-tab__label">${helpers.esc(tab.label)}</span>${END_JOIN}</a>`;
  }).join('');

  return `<nav class="${navClass}" aria-label="${helpers.esc(options.ariaLabel)}">
    <div class="workspace-tabs__track">${links}</div>
  </nav>`;
}

