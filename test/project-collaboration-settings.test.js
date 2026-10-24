import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import settingsBuilder from '../tools/build-settings.js';
import reviewLaunch from '../tools/review-launch.js';

const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));

test('專案設定產出的分工為 Codex 實作與 Grok 複審，條件式 Gemini 掃描登記', () => {
  const rendered = settingsBuilder.build(settings);
  assert.equal(rendered, readFileSync(new URL('../PROJECT-SETTINGS.md', import.meta.url), 'utf8'));
  assert.ok(rendered.includes('實作者＝Codex；複審者＝Grok'));
  assert.ok(rendered.includes('- 掃描者識別值：Gemini；怎麼起：Gemini 原生 CLI 唯讀掃描（'));
  assert.equal(settings.scanner.strongest, 'gemini-3.1-pro-preview');
  assert.equal(settings.scanner.maxEffort, 'HIGH');
  const spec = reviewLaunch.resolveScannerSpec(settings, undefined, settings.participants.map(row => row.id));
  assert.equal(spec.scanner, 'Gemini');
  assert.match(spec.command, /scripts\/gemini-scan-native\.js --model \{model\} --effort \{effort\} --scan-tree \{scanTree\}/u);
  assert.doesNotMatch(spec.command, /review-tree|mutation-copy/u);
  assert.ok(!Object.hasOwn(settings.scanner, 'nativeSources'));
  assert.match(settings.scanner.assignedBy, /額度用完/u);
});

test('專案停用掃描設定讓掃描啟動入口在外部命令前拒絕', () => {
  let calls = 0;
  const disabled = structuredClone(settings); disabled.scanner.participant = '無'; disabled.scanner.tool = '無';
  const result = reviewLaunch.main(['--scan', '17'], { settings: disabled, platform: { ask: () => { calls++; throw Error('UNEXPECTED_SCAN'); } } });
  assert.equal(result.code, 2);
  assert.deepEqual(result.lines, ['送審產生器：本專案沒有設定掃描者（PR說明的「### 複審後掃」下寫「未執行：本專案無掃描者」）——沒有產生。']);
  assert.equal(calls, 0);
});


test('Gemini 單輪登記使用原生有效模型與推理命令', () => {
  const row = settings.reviewers.find(item => item.participant === 'Gemini');
  assert.ok(settings.participants.some(item => item.id === 'Gemini'));
  assert.ok(settings.sources.some(item => item.string === 'Gemini CLI'));
  assert.equal(row.strongest, 'gemini-3.1-pro-preview');
  assert.equal(row.maxEffort, 'HIGH');
  assert.equal(row.source, 'Gemini CLI');
  assert.match(row.command, /scripts\/gemini-review\.js --model \{model\} --effort \{effort\}/u);
  assert.equal(settings.defaultDivision.reviewer, 'Grok');
});
