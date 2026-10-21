import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import settingsBuilder from '../tools/build-settings.js';
import scanProbe from '../tools/scan-probe.js';

const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));

test('專案設定產出的分工為 Codex 實作與 Grok 複審，沒有掃描者', () => {
  const rendered = settingsBuilder.build(settings);
  assert.equal(rendered, readFileSync(new URL('../PROJECT-SETTINGS.md', import.meta.url), 'utf8'));
  assert.ok(rendered.includes('實作者＝Codex；複審者＝Grok'));
  assert.ok(rendered.includes('- 掃描者：無（'));
  assert.equal(settings.scanner.strongest, '未設定');
  assert.equal(settings.scanner.maxEffort, '未設定');
});

test('專案停用掃描設定讓試探入口在外部命令前拒絕', () => {
  let calls = 0;
  const result = scanProbe.probeRun({ settings, run: () => { calls++; throw Error('UNEXPECTED_PROBE'); } });
  assert.equal(result.code, 2);
  assert.deepEqual(result.lines, ['隔離提供者是「無」：沒有隔離＝不掃，掃描紀錄寫「未執行：無隔離」。']);
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
