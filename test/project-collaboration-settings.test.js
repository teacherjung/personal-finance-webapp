import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import settingsBuilder from '../tools/build-settings.js';
import reviewLaunch from '../tools/review-launch.js';
import collabFields from '../tools/gates/check-collab-fields.js';
import reviewVerdicts from '../tools/gates/check-review-verdicts.js';

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

test('Sol 個案登記沿官方命令與收件防線，預設分工仍由 Grok 複審', () => {
  const sol = settings.reviewers.find(row => row.participant === 'Sol');
  assert.ok(sol, '必須登記本人指定的獨立 Sol 複審；查 settings.json，重跑 node --test test/project-collaboration-settings.test.js');
  assert.ok(settings.participants.some(row => row.id === 'Sol'));
  assert.ok(settings.sources.some(row => row.string === 'codex CLI'));
  assert.equal(sol.strongest, 'gpt-6.1-sol');
  assert.equal(sol.maxEffort, 'xhigh');
  assert.equal(sol.second, '未設定');
  assert.equal(sol.source, 'codex CLI');
  assert.equal(sol.autoMode, '不使用自動模式');
  assert.equal(settings.defaultDivision.implementer, 'Codex');
  assert.equal(settings.defaultDivision.reviewer, 'Grok');
  const { text: command } = reviewLaunch.substitute(sol.command, {
    model: sol.strongest, effort: sol.maxEffort, reviewTree: '/synthetic/review',
    outFile: '/synthetic/output.log', promptFile: '/synthetic/prompt.md',
  }, 'Sol 合成命令');
  assert.equal(command, 'codex exec -m gpt-6.1-sol -c model_reasoning_effort=\'"xhigh"\' -c approval_policy=\'"never"\' -s workspace-write -c sandbox_workspace_write.network_access=true -C /synthetic/review -o /synthetic/output.log - < /synthetic/prompt.md');

  // 合成設定與標頭只能證明接線，實際模型及人員獨立性須另核原生場次。
  const { usable } = collabFields.rolesOf(settings);
  const body = '## 協作欄位\n\n- **實作者**：Codex\n- **複審者**：Sol\n- **預計修改的檔案**：settings.json\n- **這支若完全失敗，最糟失去什麼**：錯誤複審資格\n';
  assert.deepEqual(collabFields.problemsOf(body, usable), []);
  assert.ok(collabFields.problemsOf(body.replace('：Codex', '：Sol'), usable).length, '不准同角色自審；查 tools/gates/check-collab-fields.js 的套件正本，重跑 node --test test/project-collaboration-settings.test.js');
  assert.ok(collabFields.problemsOf(body, usable.filter(id => id !== 'Sol')).length, '未登記角色不可收件；查 tools/gates/check-collab-fields.js 的套件正本，重跑 node --test test/project-collaboration-settings.test.js');
  const head = '0123456789abcdef0123456789abcdef01234567';
  const text = '🤖 Sol｜來源：codex CLI｜審 `0123456`｜r1｜結論：通過\n\n### 本輪實際用的設定\n\n### 清單逐項結果\n';
  const opts = { reviewer: 'Sol', source: sol.source, round: 1, head, usable };
  assert.equal(reviewLaunch.prepareVerdict(text, opts).body, text);
  for (const [from, to] of [['codex CLI', 'Codex 桌面'], ['🤖 Sol', '🤖 Codex'], ['0123456', 'abcdef0'], ['｜r1｜', '｜r2｜'], ['### 清單逐項結果', '清單未完成']]) {
    assert.throws(() => reviewLaunch.prepareVerdict(text.replace(from, to), opts));
  }
  const pass = { id: 'sol-pass', createdAt: '2026-10-31T00:02:00Z', body: text };
  const blocked = { id: 'grok-block', createdAt: '2026-10-31T00:01:00Z', body: text.replace('🤖 Sol', '🤖 Grok').replace('codex CLI', 'Grok CLI').replace('結論：通過', '結論：需修改後再審') };
  assert.deepEqual(reviewVerdicts.evaluate([pass], head, 'Sol', usable).problems, []);
  assert.ok(reviewVerdicts.evaluate([blocked, pass], head, 'Sol', usable).problems.length, 'Sol 通過不可替 Grok 清除阻擋；查 tools/gates/check-review-verdicts.js 的套件正本，重跑 node --test test/project-collaboration-settings.test.js');
});
