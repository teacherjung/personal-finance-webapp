import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, chmodSync, linkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { browserClient } from '../scripts/gemini-browser-client.js';
import { leaseMessage, sha256, SELECTED } from '../scripts/gemini-browser-protocol.js';
import { writeOnce, readMail, mailExists, SOURCE_FILES } from '../scripts/gemini-browser-files.js';
import { BrowserLease, checkBrowserArtifacts, renderBrowserLauncher, renderBrowserCuaLoader } from '../scripts/gemini-browser-runner.js';
import { material, answer, observation, jobFixture } from './helpers/gemini-browser-fixture.js';

test('信箱根採固定系統根的正規化結果，不跟環境暫存目錄走', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'browser-root-env-test-')));
  try {
    const source = new URL('../scripts/gemini-browser-files.js', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import {join} from 'node:path';
      import {tmpdir} from 'node:os';
      import {syncBuiltinESMExports} from 'node:module';
      import {configureBrowserOwner,JOB_ROOT} from ${JSON.stringify(source)};
      const uid=process.getuid(), expected=join(fs.realpathSync('/tmp'),'gemini-browser-jobs-'+uid);
      assert.notEqual(fs.realpathSync(tmpdir()),fs.realpathSync('/tmp'));
      configureBrowserOwner(uid); assert.equal(JOB_ROOT,expected);
      const original=fs.realpathSync;
      fs.realpathSync=(path,...args)=>path==='/tmp'?'/synthetic-canonical-tmp':original(path,...args);
      syncBuiltinESMExports();
      try { configureBrowserOwner(uid); assert.equal(JOB_ROOT,'/synthetic-canonical-tmp/gemini-browser-jobs-'+uid); }
      finally { fs.realpathSync=original; syncBuiltinESMExports(); }
      process.stdout.write('ROOT-OK');
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script],
      { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', TMPDIR: dir } });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'ROOT-OK');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('盒內持有請求到回覆的整輪；額外回覆、無回覆及壞來源不能終結成功', async () => {
  for (const variant of ['good', 'replay', 'missing', 'bad-source']) {
    const input = new PassThrough(), output = [];
    input.write(JSON.stringify({ kind: 'start', material: material() }) + '\n');
    const running = browserClient(input, line => {
      const frame = JSON.parse(line); output.push(frame);
      if (frame.kind === 'request') {
        const p = frame.packet, o = observation(p);
        if (variant === 'bad-source') o.complete = false;
        const reply = JSON.stringify({ kind: 'reply', response: answer(p), observation: o }) + '\n';
        input.end(variant === 'missing' ? '' : variant === 'replay' ? reply + reply : reply);
      }
    });
    if (variant === 'good') { await running; assert.equal(output.length, 2); assert.equal(output[1].result.answer.findings.length, 1); }
    else await assert.rejects(running);
  }
});
test('lease 必須回答新 challenge；只核准一次且先消耗後才接受捕獲', () => {
  const j = jobFixture();
  try {
    const claim = leaseMessage(j.descriptor, 'c'.repeat(32), 'd'.repeat(64), 'claim');
    writeOnce(j.dir, 'claim.json', claim); j.lease.tick();
    assert.deepEqual(readMail(j.dir, 'claim-ack.json'), { ...claim, stage: 'claimed' });
    const ready = { ...leaseMessage(j.descriptor, claim.instance, 'e'.repeat(64), 'ready'), tabId: 'test-owned', temporary: true, initialResponses: 0, selected: 'Open mode picker, currently Argon High' };
    writeOnce(j.dir, 'ready.json', ready); j.lease.tick();
    assert.equal(j.lease.state, 'SUBMIT_AUTHORIZED'); assert.equal(readMail(j.dir, 'permit.json').challenge, ready.challenge);
    assert.throws(() => writeOnce(j.dir, 'ready.json', ready));
    writeOnce(j.dir, 'capture.json', { instance: claim.instance, observation: observation(j.packet) });
    writeOnce(j.dir, 'submitted.json', { instance: claim.instance, tabId: ready.tabId, submissions: 1 });
    writeOnce(j.dir, 'response.txt', answer(j.packet));
    writeOnce(j.dir, 'quiescent.json', { instance: claim.instance, tabClosed: true, failed: false });
    assert.throws(() => j.lease.tick()); assert.notEqual(j.lease.state, 'CAPTURED');
  } finally { j.cleanup(); }
});
test('中止與晚到回覆不被採用；盒外專屬假值與新機密形狀守門', () => {
  const j = jobFixture();
  try {
    writeOnce(j.dir, 'aborted.json', { adopted: false });
    writeOnce(j.dir, 'capture.json', { instance: 'x', observation: observation(j.packet) });
    assert.throws(() => j.lease.tick(), /ABORTED/); assert.equal(mailExists(j.dir, 'receipt.json'), false);
    checkBrowserArtifacts([Buffer.from(answer(j.packet))], 'synthetic-secret', material().text);
    assert.throws(() => checkBrowserArtifacts([Buffer.from('synthetic-secret')], 'synthetic-secret', material().text), /CANARY_LEAK/);
    assert.throws(() => checkBrowserArtifacts([Buffer.from('flexToken":"new-secret-123456"')], 'synthetic-secret', material().text), /SECRET_SHAPE/);
    writeFileSync(join(j.dir, 'outside-canary.txt'), 'synthetic-secret');
  } finally { j.cleanup(); }
});

test('根發射器在匯入前核固定設定、node、提示及執行來源；缺集合或自改釘值不能追認', () => {
  for (const target of ['runner', 'cua']) for (const variant of ['good', 'source', 'node', 'node-mode', 'node-links', 'node-size', 'prompt', 'config', 'duplicate', 'missing-source', ...(target === 'runner' ? ['flags', 'loader', 'node-path'] : [])]) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'browser-bootstrap-test-')));
    try {
      const providerRoot = join(dir, 'provider'), promptFile = join(dir, 'prompt.txt'), marker = join(dir, 'IMPORTED');
      const script = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'yes'); export async function runBrowserScan(d) { if(d.pins.length!==5)throw Error('pins'); return {status:'SYNTHETIC',runId:'fake',receipt:'fake'}; }`;
      const providerFiles = SOURCE_FILES.map(path => {
        const bytes = ['scripts/gemini-browser-runner.js', 'scripts/gemini-browser-cua.js'].includes(path) ? script
          : path === 'scripts/gemini-browser-files.js' ? 'export function configureBrowserOwner(uid) { if(!Number.isSafeInteger(uid))throw Error("uid"); }'
          : path === 'package.json' ? '{"type":"module"}' : '';
        mkdirSync(dirname(join(providerRoot, path)), { recursive: true }); writeFileSync(join(providerRoot, path), bytes, { mode: 0o600 });
        return { path, mode: '100644', sha256: sha256(bytes), bytes: Buffer.byteLength(bytes) };
      });
      writeFileSync(promptFile, 'synthetic prompt', { mode: 0o600 });
      // 這是身分資料夾具，不是啟動子程序的 Node；真執行映像由完整 Mac 資格驗收。
      // 只替子程序設定身分與 argv，生成的 launcher、檔案核對及雜湊函式原樣執行。
      const nodeIdentity = join(dir, 'node-identity'), harness = join(dir, 'harness.mjs');
      const nodeBytes = variant === 'node-size' ? Buffer.alloc(16 * 1024 * 1024 + 1) : Buffer.from('synthetic node identity');
      writeFileSync(nodeIdentity, nodeBytes, { mode: 0o600 });
      if (variant === 'node-mode') chmodSync(nodeIdentity, 0o620);
      if (variant === 'node-links') linkSync(nodeIdentity, join(dir, 'node-identity-link'));
      const d = { purpose: 'qualification', providerRoot, providerHead: 'a'.repeat(40), providerFiles,
        repo: dir, base: 'b'.repeat(40), head: 'c'.repeat(40), promptFile, promptSha256: sha256('synthetic prompt'),
        node: nodeIdentity, nodeSha256: sha256(nodeBytes), qualification: null };
      if (variant === 'node') d.nodeSha256 = '0'.repeat(64);
      if (variant === 'missing-source') d.providerFiles = d.providerFiles.slice(1);
      let config = JSON.stringify(d) + '\n';
      if (variant === 'duplicate') config = config.replace('{', '{"purpose":"qualification",');
      const configFile = join(dir, 'deployment.json'), launcher = join(dir, 'launcher.mjs'), loader = join(dir, 'cua.mjs');
      writeFileSync(configFile, config, { mode: 0o600 });
      writeFileSync(loader, renderBrowserCuaLoader(configFile, sha256(config), providerRoot), { mode: 0o600 });
      writeFileSync(launcher, renderBrowserLauncher(configFile, sha256(config), providerRoot, { path: loader, sha256: sha256(readFileSync(loader)) }), { mode: 0o600 });
      if (variant === 'loader') writeFileSync(loader, 'throw Error("changed loader");');
      if (variant === 'source') writeFileSync(join(providerRoot, 'scripts/gemini-browser-client.js'), 'throw Error("unverified import");');
      if (variant === 'prompt') writeFileSync(promptFile, 'changed');
      if (variant === 'config') writeFileSync(configFile, JSON.stringify({ ...d, nodeSha256: '0'.repeat(64) }) + '\n');
      const execIdentity = variant === 'node-path' ? join(dir, 'other-node-identity') : nodeIdentity;
      if (variant === 'node-path') writeFileSync(execIdentity, nodeBytes, { mode: 0o600 });
      const entry = target === 'runner' ? launcher : loader, args = [execIdentity, entry, ...(variant === 'flags' ? ['--force'] : [])];
      writeFileSync(harness, `
        import assert from 'node:assert/strict';
        Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(execIdentity)} });
        process.argv = ${JSON.stringify(args)};
        assert.equal(process.execPath, ${JSON.stringify(execIdentity)});
        assert.deepEqual(process.argv, ${JSON.stringify(args)});
        try { await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write('BOOTSTRAP_ACCEPTED\\n'); }
        catch (error) {
          if (error.message !== 'GEMINI_BROWSER_BOOTSTRAP_REJECTED') throw error;
          process.stderr.write('BOOTSTRAP_REJECTED\\n'); process.exitCode = 1;
        }
      `);
      const r = spawnSync(process.execPath, [harness], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
      assert.equal(r.status, variant === 'good' ? 0 : 1, `${target}/${variant}: ${r.stderr}`);
      assert.equal(r.stderr, variant === 'good' ? '' : 'BOOTSTRAP_REJECTED\n', `${target}/${variant}`);
      assert.equal(r.stdout.endsWith('BOOTSTRAP_ACCEPTED\n'), variant === 'good', `${target}/${variant}`);
      assert.equal(existsSync(marker), variant === 'good', `${target}/${variant}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});


test('ready 沿用 claim challenge 時不產生 permit；不同 challenge 才授權', () => {
  for (const repeated of [true, false]) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'browser-ready-test-')));
    try {
      const descriptor = { runId: 'a'.repeat(32), lease: 'b'.repeat(64), requestSha256: 'c'.repeat(64), expiresAt: Date.now() + 60000 };
      const lease = new BrowserLease(dir, descriptor, () => {});
      const claim = leaseMessage(descriptor, 'd'.repeat(32), 'e'.repeat(64), 'claim');
      writeOnce(dir, 'claim.json', claim); lease.tick();
      assert.equal(lease.state, 'CLAIMED');
      assert.deepEqual(readMail(dir, 'claim-ack.json'), { ...claim, stage: 'claimed' });
      const challenge = repeated ? claim.challenge : 'f'.repeat(64);
      const ready = { ...leaseMessage(descriptor, claim.instance, challenge, 'ready'), tabId: 'test-owned', temporary: true, initialResponses: 0, selected: SELECTED };
      writeOnce(dir, 'ready.json', ready);
      if (repeated) {
        assert.throws(() => lease.tick(), /GEMINI_BROWSER_READY/);
        assert.equal(lease.state, 'CLAIMED'); assert.equal(mailExists(dir, 'permit.json'), false);
      } else {
        lease.tick(); assert.equal(lease.state, 'SUBMIT_AUTHORIZED');
        assert.deepEqual(readMail(dir, 'permit.json'), { ...ready, stage: 'submit-once' });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('正式入口核完整容量收據；停用的專案登記在建目錄前拒絕', () => {
  const runner = new URL('../scripts/gemini-browser-runner.js', import.meta.url).href;
  const protocol = new URL('../scripts/gemini-browser-protocol.js', import.meta.url).href;
  const fixture = new URL('./helpers/gemini-browser-fixture.js', import.meta.url).href;
  // 替身只供來源、收據與建目錄邊界；原樣 runner 的資格分支照跑，不當 OS 或網頁驗收。
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import {readFileSync,realpathSync} from 'node:fs';
    import * as protocol from ${JSON.stringify(protocol)};
    import {material as makeMaterial} from ${JSON.stringify(fixture)};
    const material=makeMaterial(), context=vm.createContext({Buffer,TextDecoder,process,setTimeout,clearTimeout});
    const node=realpathSync(process.execPath), nodeSha='1'.repeat(64), sourceSha='2'.repeat(64), head='3'.repeat(40);
    const projectSettings=readFileSync(new URL('../settings.json',${JSON.stringify(runner)}));
    const activeSettings=Buffer.from(JSON.stringify({scanner:{strongest:protocol.MODEL,maxEffort:protocol.EFFORT,tool:'gemini-browser-runner.js'}}));
    let receiptBytes, settingsBytes=activeSettings, reached=0;
    const module=new vm.SourceTextModule(readFileSync(new URL(${JSON.stringify(runner)}),'utf8'),
      {context,identifier:${JSON.stringify(runner)},initializeImportMeta(meta,m){meta.url=m.identifier;}});
    await module.link(async (specifier,ref)=>{
      const id=specifier.startsWith('node:')?specifier:new URL(specifier,ref.identifier).href;
      const value={...await import(id)};
      if(specifier==='node:fs')value.mkdirSync=()=>{reached++;throw Error('PREFLIGHT_ACCEPTED');};
      if(specifier==='./gemini-browser-files.js')Object.assign(value,{
        sourceDigest:()=>({sha256:sourceSha}),
        readBoundedFile:p=>p.endsWith('settings.json')?settingsBytes:receiptBytes
      });
      if(specifier==='./gemini-native-runner.js')value.snapshotPinnedSources=()=>[];
      if(specifier==='./gemini-scan.js')Object.assign(value,{
        verifyProvider:()=>({digest:'4'.repeat(64)}),buildScanMaterials:()=>({text:material.text,materialSha256:material.sha256})
      });
      return new vm.SyntheticModule(Object.keys(value),function(){for(const k of Object.keys(value))this.setExport(k,value[k]);},{context,identifier:id});
    });
    await module.evaluate();
    const cap=protocol.PROMPT_CAP;
    for(const [label,promptBytes] of [['good',cap],['missing',undefined],['object',{}],['string',String(cap)],['below',cap-1],['above',cap+1],['fraction',cap+0.5],['cancelled',cap]]){
      settingsBytes=label==='cancelled'?projectSettings:activeSettings;
      receiptBytes=Buffer.from(JSON.stringify({purpose:'qualification',status:'PUBLISHED',sourceSha256:sourceSha,
        providerHead:head,promptBytes,sourcePins:[{name:'node',sha256:nodeSha}]}));
      reached=0;
      const pins=['wrapper','deployment','prompt','node','cua-loader'].map(name=>({name,
        path:name==='node'?node:name==='prompt'?'/synthetic/prompt':'/synthetic/'+name,sha256:nodeSha}));
      let message='';
      try{await module.namespace.runBrowserScan({purpose:'scan',providerHead:head,repo:'/synthetic/repo',
        base:material.base,head:material.head,promptFile:'/synthetic/prompt',pins,
        qualification:{path:'/synthetic/receipt',sha256:protocol.sha256(receiptBytes)}});}
      catch(error){message=error.message;}
      assert.equal(message,label==='good'?'PREFLIGHT_ACCEPTED':label==='cancelled'?'GEMINI_BROWSER_REGISTRATION':'GEMINI_BROWSER_QUALIFICATION',label);
      assert.equal(reached,label==='good'?1:0,label);
    }
    process.stdout.write('QUALIFICATION-CAPACITY-OK');
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'QUALIFICATION-CAPACITY-OK');
});
