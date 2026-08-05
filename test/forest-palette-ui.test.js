import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const tabs = readFileSync(new URL('../public/workspace-tabs.css', import.meta.url), 'utf8');

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(match, `missing CSS selector: ${selector}`);
  return match[1];
}

function token(name) {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(styles);
  assert.ok(match, `missing hex token --${name}`);
  return match[1];
}

function luminance(hex) {
  const values = hex.slice(1).match(/../g).map(part => Number.parseInt(part, 16) / 255);
  const [r, g, b] = values.map(value => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('UI5 暖米橘色票：紙張底不偏綠，品牌互動與主要按鈕拆成兩組', () => {
  assert.equal(token('bg').toLowerCase(), '#fbf2dc');
  assert.equal(token('card').toLowerCase(), '#fffdf6');
  assert.equal(token('card-2').toLowerCase(), '#f5ead1');
  assert.equal(token('accent').toLowerCase(), '#ac4c28');
  assert.equal(token('accent-hover').toLowerCase(), '#89381d');
  assert.equal(token('accent-soft').toLowerCase(), '#f6dfd1');
  assert.equal(token('action').toLowerCase(), '#557f3c');
  assert.equal(token('action-hover').toLowerCase(), '#456c32');
  assert.equal(token('action-soft').toLowerCase(), '#e3edcf');
  assert.equal(token('pos-soft').toLowerCase(), '#e3edcf');
});

test('UI5 暖米橘色票：綠色只供主要按鈕，導覽、排序、focus 與提示走品牌橘', () => {
  assert.match(ruleBody(styles, '.btn'), /background:\s*var\(--action\)/);
  assert.match(ruleBody(styles, '.btn:hover'), /background:\s*var\(--action-hover\)/);
  assert.doesNotMatch(ruleBody(styles, '.btn'), /var\(--accent\)/);
  assert.match(ruleBody(styles, '#nav a.active'), /color:\s*var\(--accent-hover\)/);
  assert.match(ruleBody(styles, '.sort-tri.active'), /color:\s*var\(--accent\)/);
  assert.match(ruleBody(styles, '.hint'), /background:\s*var\(--accent-soft\)/);
  assert.match(ruleBody(styles, 'button:focus-visible, a:focus-visible, #nav a:focus-visible'), /outline:\s*3px solid var\(--accent\)/);
  assert.match(ruleBody(styles, '.dchip.good'), /background:\s*var\(--pos-soft\)/);
  assert.match(tabs, /--workspace-tabs-accent:\s*var\(--accent\)/);
  assert.match(tabs, /--workspace-tabs-active-text:\s*var\(--accent-hover\)/);
});

test('UI5 暖米橘色票：橘色文字、橘色 focus 與綠色按鈕維持可讀對比', () => {
  for (const background of ['bg', 'card', 'card-2']) {
    assert.ok(contrast(token('accent'), token(background)) >= 4.5,
      `--accent must keep 4.5:1 contrast on --${background}`);
  }
  assert.ok(contrast('#ffffff', token('action')) >= 4.5, 'primary button text contrast');
  assert.ok(contrast('#ffffff', token('action-hover')) >= 4.5, 'hovered primary button text contrast');
  assert.ok(contrast(token('accent'), token('accent-soft')) >= 3, 'focus contrast on orange soft state');
});
