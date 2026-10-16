// @ts-check
// 假 Grok 只驗正式複審材料與安全流程；不證明真模型的審查品質。
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdtempSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { MODEL_WALK_MAX_NODES, reviewModelsQualified, runScan } from '../scripts/grok-scan.js';
import { cleanupTempRoots, fakeCanary, fakeGrok, fakeRelay, isolated, keep, promptFile, SANDBOX_OK, SKIP_AFTER_CANARY, tinyRepo, withGrok } from './helpers/grok-scan-flow-fixtures.js';

after(cleanupTempRoots);
const hash = (/** @type {string | Buffer} */ value) => createHash('sha256').update(value).digest('hex');
const identity = { project: 'owner/repo', change: '17', reviewer: 'Grok', source: 'Grok CLI', round: 1 };

test('複審資格採精確的非空全員集合，不按陌生名稱推級別', () => {
  for (const models of [[], undefined, 'grok-4.7', [null], [61713], ['grok-4.5'], ['grok-4.8'], ['grok-4.7', 'grok-4.5'], ['grok-4.7', 'grok-4.7-other'], ['toString']]) {
    assert.equal(reviewModelsQualified(models), false);
  }
  assert.equal(reviewModelsQualified(['grok-4.6-build', 'grok-4.7']), true);
});

/** @param {Record<string, any>} [options] */
async function reviewRun(options = {}) {
  const repo = tinyRepo({ firstCommitFiles: { '.gitattributes': 'tree-only.txt export-ignore\n', 'RULES.md': 'base rules\n' } });
  const inst = fakeGrok({ formalTranscript: true, model: 'grok-4.7', ...options.fake });
  if (options.versionProbe) {
    const bin = join(inst, 'bin', 'grok');
    const body = readFileSync(bin, 'utf8');
    const target = 'if [ "$1" = "--version" ]; then';
    assert.ok(body.includes(target));
    writeFileSync(bin, body.replace(target, `${target} ${options.versionProbe};`));
  }
  if (options.shell) {
    const bin = join(inst, 'bin', 'grok');
    const body = readFileSync(bin, 'utf8');
    assert.ok(body.includes("printf '%s' \"FAKE-REPLY\""));
    writeFileSync(bin, body.replace("printf '%s' \"FAKE-REPLY\"", options.shell + "\nprintf '%s' \"FAKE-REPLY\""));
  }
  const iso = isolated();
  const logs = [];
  let box = '';
  let observed;
  const result = await runScan(/** @type {any} */ ({ base: repo.base, head: repo.head, promptFile: promptFile('F3-UNCHANGED-PROMPT'), repo: repo.dir,
    purpose: 'review', model: 'grok-4.7', effort: 'xhigh', review: { ...identity, previousHead: repo.base }, ...options.args }),
  { ...iso, ...withGrok(inst), relayScript: fakeRelay(), ...options.deps, log: (line) => {
    logs.push(line);
    if (line.startsWith('盒子：')) box = line.slice('盒子：'.length);
    options.onLog?.(line, box);
    if (line.startsWith('複審開始：') && existsSync(join(box, 'review-manifest.json'))) {
      observed = {
        manifest: JSON.parse(readFileSync(join(box, 'review-manifest.json'), 'utf8')),
        material: readFileSync(join(box, 'materials.md'), 'utf8'),
        base: readFileSync(join(box, 'base', 'a.txt'), 'utf8'),
        head: readFileSync(join(box, 'src', 'a.txt'), 'utf8'),
        mutation: readFileSync(join(box, 'mutation', 'a.txt'), 'utf8'),
        archivedOut: readFileSync(join(box, 'src', 'tree-only.txt'), 'utf8'),
      };
    }
  } });
  return { result, observed, repo, box, iso, logs };
}

test('正式複審拒絕未指定模型或推理；不借掃描預設值補空格', async () => {
  for (const args of [{ model: undefined }, { effort: undefined }, { purpose: 'unknown' }, { review: { ...identity, source: 'Claude CLI' } }]) {
    const { result, logs } = await reviewRun({ args });
    assert.equal(result.code, 2, '修正 runner 的用途與複審參數檢查後重跑本檔');
    assert.ok(!logs.some((line) => line.startsWith('盒子：')), '修正建盒前檢查後重跑本檔');
  }
});

test('正式材料的 git 子行程收到的環境不含 GIT 家族，dirty GIT_DIR 不會換掉受審版本', async () => {
  const repo = tinyRepo();
  const fake = fakeGrok({ formalTranscript: true, model: 'grok-4.7' });
  const root = keep(mkdtempSync(join(tmpdir(), 'review-git-env-')));
  const observed = join(root, 'received.jsonl');
  const wrapper = `#!${process.execPath}\nconst fs=require('node:fs'); const cp=require('node:child_process'); fs.appendFileSync(${JSON.stringify(observed)},JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env).filter(k=>k.startsWith('GIT_'))})+'\\n'); const r=cp.spawnSync('/usr/bin/git',process.argv.slice(2),{env:process.env}); process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status??2);\n`;
  writeFileSync(join(root, 'git'), wrapper, { mode: 0o755 });
  const before = { PATH: process.env.PATH, GIT_DIR: process.env.GIT_DIR, GIT_FUTURE_REVIEW_CANARY: process.env.GIT_FUTURE_REVIEW_CANARY };
  try {
    process.env.PATH = root + ':' + before.PATH;
    process.env.GIT_DIR = join(root, 'wrong-repository');
    process.env.GIT_FUTURE_REVIEW_CANARY = 'must-not-reach-child';
    const result = await runScan({ base: repo.base, head: repo.head, repo: repo.dir, promptFile: promptFile(), purpose: 'review', model: 'grok-4.7', effort: 'xhigh', review: { ...identity, previousHead: repo.base } }, { ...isolated(), ...withGrok(fake), relayScript: fakeRelay(), log: () => {} });
    const rows = readFileSync(observed, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(rows.some((row) => row.args.includes('ls-tree') && row.args.includes('-rz')), '修正複審材料 git 呼叫後重跑本檔');
    assert.ok(rows.some((row) => row.args.includes('cat-file') && row.args.includes('blob')), '修正 blob 讀取接線後重跑本檔');
    assert.ok(rows.some((row) => row.args.includes('diff') && row.args.includes(`${repo.base}..${repo.head}`)), '修正 previousHead 的本輪差異接線後重跑本檔');
    assert.ok(rows.some((row) => row.args.includes('config') && row.args.includes('--get') && row.args.includes('remote.origin.url')), '修正原始遠端標籤讀取接線後重跑本檔');
    for (const row of rows) assert.deepEqual(row.keys, [], '修正該 git 呼叫的 gitEnv 後重跑本檔');
    if (SANDBOX_OK) { assert.equal(result.code, 0, result.summary.join('\n')); assert.equal(result.review?.head, repo.head); }
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('正式複審保留基底、受審與突變材料，原文與 manifest 可核對', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const { result, observed, repo, box, iso } = await reviewRun({ shell: 'printf mutation-only > ../mutation/a.txt' });
  assert.equal(result.code, 0, result.summary.join('\n'));
  assert.ok(observed, '修正 runner 的正式材料建立後重跑本檔');
  assert.equal(observed.base, 'hello\n');
  assert.equal(observed.head, 'hello world\n');
  assert.equal(observed.mutation, observed.head);
  assert.equal(observed.archivedOut, 'TREE-ONLY-PUBLIC-VALUE\n');
  assert.ok(observed.material.includes('F3-UNCHANGED-PROMPT'));
  assert.ok(!observed.material.includes('不要跑整套 npm test'));
  assert.equal(observed.manifest.head, repo.head);
  assert.equal(observed.manifest.base, repo.base);
  assert.equal(observed.manifest.snapshots.head.files['a.txt'].sha256, hash(observed.head));
  assert.equal(observed.manifest.snapshots.mutation.files['a.txt'].sha256, hash(observed.mutation));
  assert.ok(result.review, '修正 runner 的成功收據後重跑本檔');
  assert.equal(result.review.reply, 'FAKE-REPLY');
  assert.equal(result.review.replySha256, hash(result.review.reply));
  assert.equal(result.review.source, 'Grok CLI');
  assert.equal(result.review.head, repo.head);
  assert.equal(result.review.manifestSha256, hash(JSON.stringify(observed.manifest, null, 2) + '\n'));
  assert.equal(existsSync(box), false);
  const saved = JSON.parse(readFileSync(join(iso.resultsRoot, readdirSync(iso.resultsRoot)[0], 'review-result.json'), 'utf8'));
  assert.equal(saved.replySha256, result.review.replySha256);
});

test('正式複審把本輪明確指定的模型與推理傳進 CLI，不拿掃描設定代替', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const { result } = await reviewRun({ args: { model: 'grok-4.6', effort: 'high' }, fake: { model: 'grok-4.6' }, shell: 'printf "%s\\n" "$@"' });
  assert.equal(result.code, 0, result.summary.join('\n'));
  assert.ok(result.review, '修正 runner 正式複審回傳後重跑本檔');
  assert.ok(result.review.stdout.includes('--model\ngrok-4.6\n'));
  assert.ok(result.review.stdout.includes('--reasoning-effort\nhigh\n'));
});

test('正式複審在首次未信任 CLI 之前備妥材料與突變相依副本', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const files = ['src/a.txt', 'base/a.txt', 'mutation/a.txt', 'src/node_modules/eslint/package.json', 'mutation/node_modules/eslint/package.json', 'materials.md', 'review-manifest.json'];
  const versionProbe = files.map((file) => `[ -f ${file} ]`).join(' && ') + ' || exit 93';
  const { result } = await reviewRun({ versionProbe });
  assert.equal(result.code, 0, result.summary.join('\n'));
  assert.ok(result.review, '修正首次未信任 CLI 前的建置順序後重跑本檔');
});

for (const purpose of ['review', 'scan']) {
  test(`${purpose === 'review' ? '正式複審' : '掃描'}在首次未信任 CLI 前完成可信父寫，版本程式植鏈後不覆寫盒外標記`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
    const root = keep(mkdtempSync(join(tmpdir(), 'grok-parent-write-')));
    const outside = join(root, 'owned-marker.txt');
    const marker = `SYNTHETIC-PARENT-WRITE-${purpose}\n`;
    writeFileSync(outside, marker);
    const outFile = join(root, 'scan-result.txt');
    const files = ['canary-inside.txt', 'materials.md', 'src/a.txt', 'src/node_modules/eslint/package.json',
      ...(purpose === 'review' ? ['base/a.txt', 'mutation/a.txt', 'mutation/node_modules/eslint/package.json', 'review-manifest.json', 'full.diff', 'round.diff'] : [])];
    const quote = (/** @type {string} */ value) => `'${value.replace(/'/g, "'\\''")}'`;
    const versionProbe = `${files.map((file) => `[ -f ${quote(file)} ]`).join(' && ')} && printf READY > tmp/parent-write-ready || printf NOT_READY > tmp/parent-write-ready; printf 'VERSION\\n' >> tmp/version-events; rm -f canary-inside.txt; ln -s ${quote(outside)} canary-inside.txt || exit 94`;
    let canaryCalls = 0;
    let readiness = '', versionEvents = '', linkTarget = '';
    // 此假 canary 只重現固定父寫點，不量真金絲雀的全機探針或沙箱能力。
    const { result } = await reviewRun({
      args: { purpose, ...(purpose === 'scan' ? { outFile } : {}) }, versionProbe,
      deps: { runCanary: async (/** @type {string} */ box) => {
        canaryCalls++;
        writeFileSync(join(box, 'canary-inside.txt'), 'INSIDE-OK\n');
        return { code: 0, lines: ['（本題可信父寫完成）'] };
      } },
      onLog: (/** @type {string} */ line, /** @type {string} */ box) => {
        if (!line.startsWith('複審開始：') && !line.startsWith('掃描開始：')) return;
        const ready = join(box, 'tmp', 'parent-write-ready');
        const events = join(box, 'tmp', 'version-events');
        readiness = existsSync(ready) ? readFileSync(ready, 'utf8') : 'MISSING';
        versionEvents = existsSync(events) ? readFileSync(events, 'utf8') : '';
        const inside = join(box, 'canary-inside.txt');
        linkTarget = existsSync(inside) && lstatSync(inside).isSymbolicLink() ? readlinkSync(inside) : '';
      },
    });
    assert.equal(result.code, 0, result.summary.join('\n'));
    assert.equal(canaryCalls, 1, '修正可信 canary 接線後重跑本檔');
    assert.equal(versionEvents, 'VERSION\n', '修正版本查詢接線後重跑本檔');
    assert.equal(linkTarget, outside, '修正本題假版本的植鏈操作後重跑本檔');
    assert.equal(readFileSync(outside, 'utf8'), marker, '修正首次未信任 CLI 與可信父寫順序後重跑本檔');
    assert.equal(readiness, 'READY', '修正原始碼、相依、材料與可信 canary 的前置順序後重跑本檔');
    if (purpose === 'review') assert.ok(result.review, '修正正式結果產生路徑後重跑本檔');
    else assert.equal(readFileSync(outFile, 'utf8'), 'FAKE-REPLY', '修正掃描輸出接線後重跑本檔');
  });
}

for (const [label, shell] of [
  ['受審檔', 'printf changed > a.txt'],
  ['基底檔', 'printf changed > ../base/a.txt'],
  ['新增檔', 'printf added > new.txt'],
  ['manifest', 'printf changed > ../review-manifest.json'],
  ['原始差異', 'printf changed > ../full.diff'],
  ['提示材料', 'printf changed > ../materials.md'],
]) test(`正式複審在執行後發現${label}被改，不產生正式結果`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const { result, iso, box } = await reviewRun({ shell });
  assert.equal(result.code, 2, '修正 runner 的快照前後比對後重跑本檔');
  assert.equal(result.review, undefined);
  assert.deepEqual(readdirSync(iso.resultsRoot), []);
  assert.equal(existsSync(box), false);
});

test('正式複審安全鏈失敗、沒有原文或模型足跡時不產生正式結果', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  for (const options of [{ deps: { runCanary: fakeCanary(1) } }, { fake: { reply: '' } }, { fake: { noToolFootprint: true } }, { fake: { status: 1 } }, { fake: { model: undefined } }]) {
    const { result, iso } = await reviewRun(options);
    assert.equal(result.code, 2, result.summary.join('\n'));
    assert.equal(result.review, undefined);
    assert.deepEqual(readdirSync(iso.resultsRoot), []);
  }
});

test('正式複審接受已登記的 4.6 以上單一或混合模型，保留指定值與實際投影', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const models = ['grok-4.6', 'grok-4.6-build', 'grok-4.7', 'grok-4.7-build'];
  for (let bits = 1; bits < (1 << models.length); bits++) {
    const selected = models.filter((_, i) => bits & (1 << i));
    const { result, iso, box } = await reviewRun({ fake: { model: selected[0], sessionLines: selected.map(model_id => JSON.stringify({ model_id })) } });
    assert.equal(result.code, 0, result.summary.join('\n'));
    assert.ok(result.review, '模型資格合格仍須取得完整正式結果');
    assert.equal(result.review.model, 'grok-4.7');
    assert.equal(result.review.effort, 'xhigh');
    assert.deepEqual(result.review.observedModels, selected);
    assert.equal(result.review.modelFloor, '4.6');
    assert.equal(result.review.modelQualified, true);
    assert.ok(result.review.recipe.includes(`模型=${selected.join('＋')}｜`));
    assert.equal(readdirSync(iso.resultsRoot).length, 1);
    const saved = JSON.parse(readFileSync(join(iso.resultsRoot, readdirSync(iso.resultsRoot)[0], 'review-result.json'), 'utf8'));
    assert.deepEqual(saved.observedModels, selected);
    assert.equal(existsSync(box), false);
  }
});

test('正式複審模型核對失敗只回已核集合，仍清除未合格結果', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const unknown = 'SYNTHETIC-UNRECOGNIZED-MODEL-61713';
  const hostile = '/synthetic/account/SENTINEL-61713\\t';
  const overLimit = JSON.stringify({ model_id: 'grok-4.6', nodes: Array(MODEL_WALK_MAX_NODES).fill(0) });
  for (const [fake, expected] of [
    [{ model: 'grok-4.5' }, '查不出來'],
    [{ model: 'grok-4.8' }, '查不出來'],
    [{ model: 'grok-4.7-unregistered' }, '查不出來'],
    [{ model: undefined }, '查不出來'],
    [{ model: unknown }, '查不出來'],
    [{ sessionLines: ['{"model_id":"grok-4.5"}'] }, 'grok-4.7'],
    [{ sessionLines: [JSON.stringify({ model_id: hostile })] }, 'grok-4.7'],
    [{ sessionLines: [overLimit] }, 'grok-4.7'],
    [{ model: undefined, sessionLines: [overLimit] }, '查不出來'],
    [{ model: undefined, sessionLines: [overLimit, JSON.stringify({ model_id: unknown })] }, '查不出來'],
    [{ sessionLines: [overLimit, JSON.stringify({ model_id: unknown })] }, 'grok-4.7'],
    [{ model: undefined, sessionLines: ['{"model_id":"grok-4.6"}', overLimit, JSON.stringify({ model_id: unknown })] }, 'grok-4.6'],
    [{ sessionLines: ['{"model_id":"grok-4.6"}', '{"model_id":61713}'] }, 'grok-4.6＋grok-4.7'],
  ]) {
    const { result, iso, box } = await reviewRun({ fake });
    assert.equal(result.code, 2);
    assert.equal(result.review, undefined);
    const diagnostic = result.summary.find(line => line.includes('實際模型紀錄')) ?? '';
    assert.equal(diagnostic, `⛔ 正式複審的實際模型紀錄不完整或未符合已登記的 4.6 以上資格；模型紀錄摘要：${expected}。核對模型與 session 格式後重跑 scripts/grok-review.js`);
    assert.ok(!diagnostic.includes(unknown) && !diagnostic.includes('61713'), '陌生值與未信任計數不能進診斷文字');
    assert.deepEqual(readdirSync(iso.resultsRoot), []);
    assert.equal(existsSync(box), false);
  }
});

for (const [label, options] of [
  ['JSONL 截斷', { fake: { sessionLines: ['{"model_id":"grok-4.6"'] } }],
  ['JSON 截斷', { shell: `printf '%s' '{"model_id":"grok-4.6"' > "$ws/fake-session/model.json"` }],
  ['JSONL 非 UTF-8', { shell: `printf '{"model_id":"grok-4.7","note":"\\377"}' > "$ws/fake-session/model.jsonl"` }],
  ['JSON 非 UTF-8', { shell: `printf '{"model_id":"grok-4.7","note":"\\377"}' > "$ws/fake-session/model.json"` }],
  ['JSON 空內容', { shell: ': > "$ws/fake-session/model.json"' }],
]) {
  test(`正式複審拒收損毀模型紀錄：${label}，有效工具與模型足跡不能掩蓋它`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
    const { result, iso, box } = await reviewRun(options);
    assert.equal(result.code, 2, '修正正式用途的模型日誌完整性檢查後重跑本檔');
    assert.equal(result.review, undefined);
    assert.deepEqual(readdirSync(iso.resultsRoot), []);
    assert.equal(existsSync(box), false);
    assert.ok(result.summary.some((line) => line.includes('模型紀錄無法完整解碼或解析')), '需走到模型日誌完整性檢查，不能借前置失敗冒充拒收');
  });

  test(`掃描保留損毀模型紀錄的既有判準：${label}`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
    const { result, iso, box } = await reviewRun({ ...options, args: { purpose: 'scan' } });
    assert.equal(result.code, 0, result.summary.join('\n'));
    assert.equal(result.review, undefined);
    assert.equal(readdirSync(iso.resultsRoot).length, 1);
    assert.equal(existsSync(box), false);
    assert.ok(result.summary.some((line) => line.includes('模型=grok-4.7')));
  });
}


test('完整 root final 與 CLI 進度分列保存，Unicode 範圍使用 UTF-8 bytes', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const prefix = '進度🙂\n';
  const { result, iso } = await reviewRun({ shell: `printf '%s' '${prefix}'` });
  assert.equal(result.code, 0, result.summary.join('\n'));
  assert.ok(result.review);
  assert.equal(result.review.reply, 'FAKE-REPLY');
  assert.equal(result.review.stdout, prefix + 'FAKE-REPLY');
  assert.equal(result.review.stdoutSha256, hash(prefix + 'FAKE-REPLY'));
  assert.equal(result.review.selection.byteStart, Buffer.byteLength(prefix));
  const saved = JSON.parse(readFileSync(join(iso.resultsRoot, readdirSync(iso.resultsRoot)[0], 'review-result.json'), 'utf8'));
  assert.deepEqual(saved, result.review);
});

for (const [name, code, shell] of [
  ['缺 root transcript', 'TRANSCRIPT_MISSING', 'rm "$ws/fake-session/chat_history.jsonl"'],
  ['最後 user 不能倒找 assistant', 'FINAL_KEYS', `printf '%s\n' '{"type":"user","content":"FAKE-REPLY"}' >> "$ws/fake-session/chat_history.jsonl"`],
  ['多 root', 'ROOT_CARDINALITY', 'mkdir "$ws/00000000-0000-4000-8000-000000000002"; cp "$ws/fake-session/chat_history.jsonl" "$ws/00000000-0000-4000-8000-000000000002/chat_history.jsonl"'],
  ['重複 stdout', 'UNIQUE_MATCH', "printf 'FAKE-REPLY'"],
  ['非 final 機器人標記', 'PREFIX_MARKER', "printf '🤖 假前綴\\n'"],
]) test(`安全 runner 不對不明 final fallback stdout：${name}`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const { result, iso, box, logs } = await reviewRun({ shell });
  assert.equal(result.code, 2, result.summary.join('\n'));
  assert.ok(result.summary.some(line => line.includes(`final-selection=${code}`)));
  assert.ok(!logs.join('\n').includes('🤖 假前綴'));
  assert.equal(result.review, undefined); assert.deepEqual(readdirSync(iso.resultsRoot), []);
  assert.equal(existsSync(box), false);
});

test('final 選取不能蓋過完整 stdout 的 DLP 事故', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const live = 'SYNTHETIC-FINAL-LIVE-SENTINEL-ONLY';
  const { result, iso } = await reviewRun({ shell: `printf '%s' '${live}'`, deps: { liveSecret: live } });
  assert.equal(result.code, 1, result.summary.join('\n')); assert.equal(result.review, undefined);
  assert.ok(!result.summary.some(line => line.includes('final-selection=')));
  const directory = join(iso.resultsRoot, readdirSync(iso.resultsRoot)[0]);
  assert.equal(existsSync(join(directory, 'review-result.json')), false);
  assert.equal(existsSync(join(directory, 'incident.json')), true);
});


for (const [name, options] of [
  ['模型', { fake: { model: 'grok-4.5' } }],
  ['材料', { shell: 'printf changed > a.txt' }],
  ['行為足跡', { fake: { noToolFootprint: true } }],
  ['掃前試探', { deps: { runCanary: fakeCanary(1) } }],
]) test(`前置安全檢查拒收時不產生 selector 碼或保留失敗結果：${name}`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const shell = (options.shell ?? '') + '\nrm "$ws/fake-session/chat_history.jsonl"';
  const { result, iso, logs, box } = await reviewRun({ ...options, shell });
  assert.equal(result.code, 2);
  assert.ok(!logs.some(line => line.includes('final-selection=') || line.includes('final-root-structure=')));
  assert.equal(result.review, undefined);
  assert.deepEqual(readdirSync(iso.resultsRoot), []);
  assert.equal(existsSync(box), false);
});

test('DLP 拒收時不以 selector 診斷留下原文或正式結果', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const { result, iso, logs } = await reviewRun({ shell: 'printf "%s" "fake-owner@example.test"; rm "$ws/fake-session/chat_history.jsonl"' });
  assert.equal(result.code, 1);
  assert.ok(!logs.some(line => line.includes('final-selection=') || line.includes('final-root-structure=')));
  const directory = join(iso.resultsRoot, readdirSync(iso.resultsRoot)[0]);
  assert.deepEqual(readdirSync(directory), ['incident.json', 'launch.json']);
  assert.ok(!readFileSync(join(directory, 'incident.json'), 'utf8').includes('fake-owner@example.test'));
  assert.equal(result.review, undefined);
});


for (const [name, shell, expected] of [
  ['多 UUID', 'mkdir "$ws/00000000-0000-4000-8000-000000000002"; cp "$ws/fake-session/chat_history.jsonl" "$ws/00000000-0000-4000-8000-000000000002/chat_history.jsonl"',
    { rootComponents: 'MULTIPLE', uuidComponents: 'MULTIPLE', exactUuidTranscripts: 'MULTIPLE', directWorkspaceFilePresent: false, nonUuidNestedComponentPresent: false, otherWorkspaceTopComponentPresent: false, equivalentEncodedWorkspacePresent: false }],
]) test(`安全 runner 在既有拒收之後只印 root 有限結構且清掉原材料：${name}`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const { result, iso, box, logs } = await reviewRun({ shell });
  assert.equal(result.code, 2, result.summary.join('\n')); assert.equal(result.review, undefined);
  assert.ok(result.summary.some(line => line.includes('final-selection=ROOT_CARDINALITY')));
  const projected = logs.filter(line => line.startsWith('final-root-structure='));
  assert.equal(projected.length, 1);
  assert.deepEqual(JSON.parse(projected[0].slice('final-root-structure='.length)), expected);
  assert.ok(!projected[0].includes('SYNTHETIC')); assert.ok(!projected[0].includes(box));
  assert.deepEqual(readdirSync(iso.resultsRoot), []); assert.equal(existsSync(box), false);
});


test('直層 prompt_history 保留全快照稽核，正式選取只取 UUID transcript', { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const metadata = JSON.stringify({ type: 'assistant', content: '🤖 合成 metadata 假結論', model_id: 'grok-4.7', model_fingerprint: 'synthetic', reasoning_effort: 'xhigh' });
  const { result, iso, box, logs } = await reviewRun({ shell: `printf '%s\\n' '${metadata}' > "$ws/prompt_history.jsonl"` });
  assert.equal(result.code, 0, result.summary.join('\n'));
  assert.equal(result.review.reply, 'FAKE-REPLY');
  assert.ok(result.review.selection.transcriptPath.endsWith('/00000000-0000-4000-8000-000000000001/chat_history.jsonl'));
  assert.ok(!logs.some(line => line.startsWith('final-root-structure=')));
  assert.equal(readdirSync(iso.resultsRoot).length, 1); assert.equal(existsSync(box), false);
});

for (const [name, target] of [
  ['預期 workspace 直層', '"$ws/metadata.json"'],
  ['其他 workspace 直層', '"$GROK_HOME/sessions/%2Fother%2Fsrc/metadata.json"'],
]) test(`直層檔排除候選仍不能躲過 DLP：${name}`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const { result, iso, box, logs } = await reviewRun({ shell: `mkdir -p "$GROK_HOME/sessions/%2Fother%2Fsrc"; printf '%s\\n' '{"note":"fake-owner@example.test"}' > ${target}` });
  assert.equal(result.code, 1, result.summary.join('\n')); assert.equal(result.review, undefined);
  assert.ok(!logs.some(line => line.includes('final-selection=') || line.includes('final-root-structure=')));
  const directory = join(iso.resultsRoot, readdirSync(iso.resultsRoot)[0]);
  assert.deepEqual(readdirSync(directory), ['incident.json', 'launch.json']);
  assert.ok(!readFileSync(join(directory, 'incident.json'), 'utf8').includes('fake-owner@example.test'));
  assert.equal(existsSync(box), false);
});

for (const [name, data] of [
  ['低階模型', '{"type":"assistant","model_id":"grok-4.5"}'],
  ['壞 JSON', '{BROKEN-SYNTHETIC-JSON'],
]) test(`直層檔排除候選仍受解析與模型稽核：${name}`, { skip: !SANDBOX_OK && SKIP_AFTER_CANARY }, async () => {
  const { result, iso, box, logs } = await reviewRun({ shell: `printf '%s\\n' '${data}' > "$ws/metadata.json"` });
  assert.equal(result.code, 2, result.summary.join('\n')); assert.equal(result.review, undefined);
  assert.ok(result.summary.some(line => line.includes('模型')));
  assert.ok(!logs.some(line => line.includes('final-selection=') || line.includes('final-root-structure=')));
  assert.deepEqual(readdirSync(iso.resultsRoot), []); assert.equal(existsSync(box), false);
});
