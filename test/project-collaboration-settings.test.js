import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import settingsBuilder from '../tools/build-settings.js';
import reviewLaunch from '../tools/review-launch.js';
import collabFields from '../tools/gates/check-collab-fields.js';
import reviewVerdicts from '../tools/gates/check-review-verdicts.js';

const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));

test('專案設定產出的分工為 Codex 實作與 Grok 複審，預設 Grok 隔離掃描登記且保留 Gemini 掃描樣板', () => {
  const rendered = settingsBuilder.build(settings);
  assert.equal(rendered, readFileSync(new URL('../PROJECT-SETTINGS.md', import.meta.url), 'utf8'));
  assert.ok(rendered.includes('實作者＝Codex；複審者＝Grok'));
  assert.ok(rendered.includes('- 掃描者識別值：Grok；怎麼起：Grok CLI（經 tools\\/review\\-launch\\.js \\-\\-grok\\-exec'));
  assert.equal(settings.scanner.participant, 'Grok');
  assert.equal(settings.scanner.strongest, 'grok-4.7');
  assert.equal(settings.scanner.maxEffort, 'xhigh');
  assert.equal(settings.scanner.source, 'Grok CLI');
  const usable = settings.participants.map(row => row.id);
  const spec = reviewLaunch.resolveScannerSpec(settings, undefined, usable);
  assert.equal(spec.scanner, 'Grok');
  assert.match(spec.command, /^node tools\/review-launch\.js --grok-exec --mode scan --cwd \{scanTree\} --model \{model\} --reasoning-effort \{effort\} --prompt-file \{promptFile\} --out \{outFile\}$/u);
  assert.doesNotMatch(spec.command, /reviewTree|review-tree|mutationCopy|mutation-copy/u);
  assert.ok(!Object.hasOwn(settings.scanner, 'nativeSources'));
  assert.match(settings.scanner.assignedBy, /6878641993/u);
  assert.match(settings.scanner.assignedBy, /額度用完/u);

  const geminiSpec = reviewLaunch.resolveScannerSpec(settings, 'Gemini', usable);
  assert.equal(geminiSpec.scanner, 'Gemini');
  assert.match(geminiSpec.command, /scripts\/gemini-scan-native\.js --model \{model\} --effort \{effort\} --scan-tree \{scanTree\}/u);
  assert.doesNotMatch(geminiSpec.command, /reviewTree|review-tree|mutationCopy|mutation-copy/u);
});

test('專案停用掃描設定讓掃描啟動入口在外部命令前拒絕', () => {
  let calls = 0;
  const disabled = structuredClone(settings); disabled.scanner.participant = '無'; disabled.scanner.tool = '無';
  const result = reviewLaunch.main(['--scan', '17'], { settings: disabled, platform: { ask: () => { calls++; throw Error('UNEXPECTED_SCAN'); } } });
  assert.equal(result.code, 2);
  assert.deepEqual(result.lines, ['送審產生器：本專案沒有設定掃描者（PR說明的「### 複審後掃」下寫「未執行：本專案無掃描者」）——沒有產生。']);
  assert.equal(calls, 0);
});


test('Gemini 單輪登記與 Claude CLI 審查命令符合設定契約', () => {
  const row = settings.reviewers.find(item => item.participant === 'Gemini');
  assert.ok(settings.participants.some(item => item.id === 'Gemini'));
  assert.ok(settings.sources.some(item => item.string === 'Gemini CLI'));
  assert.equal(row.strongest, 'gemini-3.1-pro-preview');
  assert.equal(row.maxEffort, 'HIGH');
  assert.equal(row.source, 'Gemini CLI');
  assert.match(row.command, /scripts\/gemini-review\.js --model \{model\} --effort \{effort\}/u);
  assert.match(row.scanCommand, /scripts\/gemini-scan-native\.js --model \{model\} --effort \{effort\} --scan-tree \{scanTree\}/u);

  const claude = settings.reviewers.find(item => item.participant === 'Claude');
  assert.equal(claude.strongest, 'claude-opus-5-5-high');
  assert.equal(claude.second, 'claude-sonnet-5-5-high');
  assert.equal(claude.maxEffort, 'high');
  assert.equal(claude.autoMode, 'auto');
  assert.equal(claude.source, 'Claude CLI');
  assert.doesNotMatch(claude.command, /--dangerously-skip-permissions/u);
  assert.doesNotMatch(claude.scanCommand, /--dangerously-skip-permissions|reviewTree|mutationCopy/u);
  assert.deepEqual(reviewLaunch.templateProblems(settings), []);
  const { text: claudeCmd } = reviewLaunch.substitute(claude.command, {
    model: claude.strongest,
    effort: claude.maxEffort,
    reviewTree: '/synthetic/review',
    mutationCopy: '/synthetic/mutation',
    promptFile: '/synthetic/prompt.md',
    outFile: '/synthetic/output.log',
  }, 'Claude 合成命令');
  assert.match(claudeCmd, /^cd \/synthetic\/review && agy -p "\$\(cat \/synthetic\/prompt\.md\)" --model claude-opus-5-5-high --effort high --disable-slash-commands --add-dir \/synthetic\/mutation --settings '([^']+)' --output-format json < \/dev\/null > \/synthetic\/output\.log$/u);
  const settingsArg = claudeCmd.match(/--settings '([^']+)'/u)?.[1];
  assert.ok(settingsArg, 'Claude 啟動命令必須帶單次會話 --settings JSON；查 settings.json，重跑 node --test test/project-collaboration-settings.test.js');
  const parsedAgySettings = JSON.parse(settingsArg);
  assert.equal(parsedAgySettings.allowNonWorkspaceAccess, false);
  assert.equal(parsedAgySettings.enableTerminalSandbox, false);
  assert.deepEqual(parsedAgySettings.permissions.allow, ['write_file(/synthetic/mutation)']);
  for (const denied of [
    'mcp(*)',
    'read_url(*)',
    'execute_url(*)',
    'download_url(*)',
    'write_file(/synthetic/review)',
    'command(gh pr merge)',
    'command(gh pr edit)',
    'command(gh pr close)',
    'command(gh pr comment)',
    'command(gh api -X)',
    'command(gh api graphql)',
    'command(git push)',
    'command(git commit)',
    'command(git checkout)',
    'command(npm install)',
    'command(npm ci)',
  ]) {
    assert.ok(parsedAgySettings.permissions.deny.includes(denied), `Claude 權限拒絕清單缺少 ${denied}；查 settings.json，重跑 node --test test/project-collaboration-settings.test.js`);
  }
  const { text: claudeScanCmd } = reviewLaunch.substitute(claude.scanCommand, {
    model: claude.strongest,
    effort: claude.maxEffort,
    scanTree: '/synthetic/scan',
    promptFile: '/synthetic/scan-prompt.md',
    outFile: '/synthetic/scan-output.log',
  }, 'Claude 掃描合成命令');
  const parsedScanSettings = JSON.parse(claudeScanCmd.match(/--settings '([^']+)'/u)?.[1] ?? '');
  assert.ok(parsedScanSettings.permissions.deny.includes('mcp(*)'));
  assert.ok(parsedScanSettings.permissions.deny.includes('write_file(/synthetic/scan)'));
  assert.match(claude.verified, /available: low, medium, high/u);

  const codex = settings.reviewers.find(item => item.participant === 'Codex');
  assert.equal(codex.second, 'gpt-6.1-sol');

  const grok = settings.reviewers.find(item => item.participant === 'Grok');
  assert.match(grok.scanCommand, /^node tools\/review-launch\.js --grok-exec --mode scan --cwd \{scanTree\}/u);

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
