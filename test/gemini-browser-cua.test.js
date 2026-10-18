import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, lstatSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { visibleJsonCodeResponse, captureBrowserScan, cancelBrowserScan } from '../scripts/gemini-browser-cua.js';
import { REPLY_CAP, RENDERED_CAP, sha256 } from '../scripts/gemini-browser-protocol.js';
import { validateResponseArtifacts } from '../scripts/gemini-browser-runner.js';
import { readMail, writeOnce } from '../scripts/gemini-browser-files.js';
import { runBrowserScanUi, jobFixture, browserFixture, answer, responseDom } from './helpers/gemini-browser-fixture.js';

test('固定 CUA 完整路徑只建自有分頁、送一次、存原文及官方明細後關閉', async () => {
  const j = jobFixture(), b = browserFixture(j, { detailsLoading: true }); j.serve();
  try {
    await runBrowserScanUi(b.browser, j.runId);
    assert.equal(b.state.sent, 1); assert.equal(b.state.responses, 1);
    await assert.rejects(runBrowserScanUi(b.browser, j.runId), /REPLAY/);
    const result = await captureBrowserScan(j.runId);
    assert.equal(result.state, 'CAPTURED'); assert.equal(b.state.closed, true);
    assert.equal(readMail(j.dir, 'quiescent.json').failed, false);
    assert.equal(readMail(j.dir, 'capture.json').observation.details, 'Used 4 Argon 高');
    assert.equal(readMail(j.dir, 'capture.json').observation.detailsSource, 'response-details');
    await assert.rejects(captureBrowserScan(j.runId), /CAPTURE_ORDER/);
    assert.equal(b.state.sent, 1); assert.equal(b.calls.filter(c => c[0] === 'new').length, 1);
  } finally { j.cleanup(); }
});
test('唯一可見 code 正文逐字保存直接文字與 highlight，另留容器證據且不操作複製控制', async () => {
  const j = jobFixture(), payload = JSON.parse(answer(j.packet));
  payload.findings[0].reproduction = 'quote " slash \\ newline\n tick ` entity &amp;';
  const raw = JSON.stringify(payload), b = browserFixture(j, { raw, highlight: true }); j.serve();
  try {
    await runBrowserScanUi(b.browser, j.runId); await captureBrowserScan(j.runId);
    const code = readFileSync(join(j.dir, 'response.txt')), rendered = readFileSync(join(j.dir, 'response-rendered.txt'));
    const dom = readMail(j.dir, 'response-dom.json'), observed = readMail(j.dir, 'capture.json').observation;
    assert.equal(code.toString(), raw); assert.deepEqual(JSON.parse(code), payload);
    assert.equal(rendered.toString(), 'JSON\n' + raw);
    assert.equal(observed.responseSha256, sha256(raw)); assert.equal(observed.renderedSha256, sha256(rendered));
    assert.equal(dom.structure.highlightSpans, 1); assert.deepEqual(dom.structure.codeNodes, [[3, 1], [1, raw.length - 2, 'hljs-string'], [3, 1]]);
    validateResponseArtifacts(code, rendered, dom, observed);
    assert.equal(b.calls.filter(c => c[0] === 'response-code').length, 2);
    assert.equal(b.calls.some(c => c[0] === 'click' && /Copy code|Download code/.test(c[1])), false);
    assert.equal(b.state.sent, 1); assert.equal(b.state.closed, true);
  } finally { j.cleanup(); }
});
test('活 lease 在接收時重核正文證據，檔案變造不能取得捕獲狀態', async () => {
  for (const changed of [false, true]) {
    const j = jobFixture(), b = browserFixture(j); j.serve();
    try {
      await runBrowserScanUi(b.browser, j.runId); j.stop(); await captureBrowserScan(j.runId);
      if (changed) {
        writeFileSync(join(j.dir, 'response-rendered.txt'), 'changed evidence');
        assert.throws(() => j.lease.tick(), /RESPONSE_ARTIFACT/);
        assert.notEqual(j.lease.state, 'CAPTURED');
      } else {
        assert.equal(j.lease.tick().raw.toString(), answer(j.packet));
        assert.equal(j.lease.state, 'CAPTURED');
      }
    } finally { j.cleanup(); }
  }
});
test('已觀測父子鏈之外的正文、空元件、citation、重複或隱藏 code 均拒收', async () => {
  const mutations = [
    root => root.append('outside text'),
    (root, d) => root.append(d.createElement('div')),
    (root, d) => { const cite = d.createElement('citation'); cite.textContent = 'TXT + 1'; root.append(cite); },
    root => root.append(root.querySelector('code-block').cloneNode(true)),
    root => { const duplicate = root.querySelector('code-block').cloneNode(true); duplicate.setAttribute('hidden', ''); root.append(duplicate); },
    root => root.querySelector('code').remove(),
    root => root.querySelector('code').setAttribute('hidden', ''),
    root => { root.querySelector('.code-block-decoration > span').textContent = 'JavaScript'; },
    root => root.querySelector('code').setAttribute('role', 'button'),
    root => root.querySelector('.markdown').classList.remove('md-content'),
    root => { root.querySelector('.code-block-decoration > span').append(root.ownerDocument.createElement('span')); },
    root => { root.querySelector('code').innerHTML = '<a>unknown inline</a>'; },
  ];
  for (const mutateDom of mutations) {
    const j = jobFixture(), b = browserFixture(j, { mutateDom }); j.serve();
    try {
      await runBrowserScanUi(b.browser, j.runId);
      await assert.rejects(captureBrowserScan(j.runId), /RESPONSE_DOM/);
      assert.equal(readMail(j.dir, 'quiescent.json').failed, true);
      assert.equal(b.state.sent, 1); assert.equal(b.state.closed, true);
    } finally { j.cleanup(); }
  }
});
test('明細後同文但結構變動、呈現文字變動與超長正文不可封存', async () => {
  for (const options of [
    { afterDetails: s => { s.highlight = true; } },
    { afterDetails: s => { s.rendered = 'changed rendering'; } },
    { raw: 'x'.repeat(REPLY_CAP + 1) },
    { raw: '字'.repeat(REPLY_CAP / 2) },
    { rendered: 'x'.repeat(RENDERED_CAP + 1) },
  ]) {
    const j = jobFixture(), b = browserFixture(j, options); j.serve();
    try {
      await runBrowserScanUi(b.browser, j.runId); await assert.rejects(captureBrowserScan(j.runId));
      assert.equal(readMail(j.dir, 'quiescent.json').failed, true);
      assert.equal(b.state.sent, 1); assert.equal(b.state.closed, true);
    } finally { j.cleanup(); }
  }
});
test('DOM 評估器序列化後仍讀完整 code，動態 class 不作身分', () => {
  const raw = '{"n":1}', fixture = responseDom(raw, { highlight: true });
  try {
    fixture.root.querySelector('.markdown').classList.add('ng-tns-c123-99');
    const evaluate = new Function('return (' + visibleJsonCodeResponse.toString() + ')')();
    const result = evaluate(fixture.root, { reply: REPLY_CAP, rendered: RENDERED_CAP });
    assert.equal(result.codeText, raw); assert.equal(result.renderedText, 'JSON\n' + raw);
  } finally { fixture.close(); }
});
test('思考步驟入口只採同一回覆官方 metadata；自稱、缺失、重複及來源歧義拒收', async () => {
  for (const options of [{}, { details: 'Used Flash', selfReportedDetails: 'Used 4 Argon 高' },
    { metadataCount: 0, selfReportedDetails: 'Used 4 Argon 高' }, { metadataCount: 2 }, { sidebarCount: 2 }, { responseMenu: 'ambiguous' }]) {
    const j = jobFixture(), b = browserFixture(j, { responseMenu: 'thinking-steps', detailsLoading: true, ...options }); j.serve();
    try {
      await runBrowserScanUi(b.browser, j.runId);
      if (Object.keys(options).length) {
        await assert.rejects(captureBrowserScan(j.runId));
        assert.equal(readMail(j.dir, 'quiescent.json').failed, true);
      } else {
        assert.equal((await captureBrowserScan(j.runId)).state, 'CAPTURED');
        assert.equal(readMail(j.dir, 'capture.json').observation.detailsSource, 'thinking-steps');
        assert.equal(readMail(j.dir, 'capture.json').observation.details, 'Used 4 Argon 高');
        assert.ok(b.calls.some(c => c[1] === 'menuitem:Show thinking steps'));
      }
      assert.equal(b.state.sent, 1); assert.equal(b.state.closed, true);
    } finally { j.cleanup(); }
  }
});
test('UI 前來源、請求、期限及目錄不合規拒絕，沒有瀏覽器呼叫', async () => {
  for (const variant of ['source', 'request', 'expired', 'mode', 'bad-id']) {
    const j = jobFixture(), b = browserFixture(j);
    j.serve();
    try {
      if (variant === 'source') writeFileSync(join(j.dir, 'descriptor.json'), JSON.stringify({ ...j.descriptor, sourceSha256: '0'.repeat(64) }));
      if (variant === 'request') writeFileSync(join(j.dir, 'control.txt'), 'changed');
      if (variant === 'expired') writeFileSync(join(j.dir, 'descriptor.json'), JSON.stringify({ ...j.descriptor, expiresAt: 1 }));
      if (variant === 'mode') chmodSync(j.dir, 0o755);
      await assert.rejects(runBrowserScanUi(b.browser, variant === 'bad-id' ? '../elsewhere' : j.runId));
      assert.deepEqual(b.calls, []);
    } finally { chmodSync(j.dir, 0o700); j.cleanup(); }
  }
});
test('靜態工作沒有 live ACK 或只留舊 challenge 時零 UI；第二 claim 不可接手', async () => {
  for (const variant of ['no-runner', 'old-ack', 'double-claim']) {
    const j = jobFixture(), b = browserFixture(j);
    try {
      if (variant === 'old-ack') writeOnce(j.dir, 'claim-ack.json', { ...j.descriptor, challenge: '0'.repeat(64) });
      if (variant === 'double-claim') writeOnce(j.dir, 'claim.json', {});
      await assert.rejects(runBrowserScanUi(b.browser, j.runId));
      assert.deepEqual(b.calls, []);
    } finally { j.cleanup(); }
  }
});
test('非空白、錯來源、雙回覆、降級與明細後內容變更不能封存成功', async () => {
  for (const options of [{ text: 'preexisting-private' }, { url: 'https://example.com' },
    { afterSubmit: s => { s.responses = 2; } }, { details: 'Used Flash' },
    { afterDetails: s => { s.raw = 'changed after capture'; } }]) {
    const j = jobFixture(), b = browserFixture(j, options); j.serve();
    try {
      await assert.rejects(async () => { await runBrowserScanUi(b.browser, j.runId); await captureBrowserScan(j.runId); });
      assert.equal(b.state.closed, true); assert.ok(b.state.sent <= 1);
      assert.equal(readMail(j.dir, 'quiescent.json').failed, true);
    } finally { j.cleanup(); }
  }
});
test('等待中取消只關自有分頁，晚到內容不能再採用或補送', async () => {
  const j = jobFixture(), b = browserFixture(j, { pending: true }); j.serve();
  try {
    await runBrowserScanUi(b.browser, j.runId);
    assert.equal((await captureBrowserScan(j.runId)).state, 'PENDING');
    await cancelBrowserScan(j.runId); b.state.pending = false;
    await assert.rejects(captureBrowserScan(j.runId));
    assert.equal(b.state.sent, 1); assert.equal(b.state.closed, true);
    assert.equal(b.calls.filter(c => c[0] === 'close').length, 1);
  } finally { j.cleanup(); }
});

test('同內容的一般檔可送出，符號連結在 UI 前被檔案守門拒收', async t => {
  // 同內容與活 ACK 排除其他拒收理由；本題守整組檔案保護，不證明各單層或替換競態。
  for (const variant of ['regular', 'symlink']) {
    await t.test(variant, async () => {
      const j = jobFixture(), b = browserFixture(j); j.serve();
      try {
        const prompt = join(j.dir, 'control.txt'), target = join(j.dir, 'prompt-target.txt');
        writeFileSync(target, j.packet.controlPrompt, { mode: 0o600, flag: 'wx' });
        const targetStat = lstatSync(target);
        assert.equal(targetStat.isFile(), true); assert.equal(targetStat.nlink, 1);
        assert.equal(targetStat.uid, lstatSync(prompt).uid); assert.equal(targetStat.mode & 0o777, 0o600);
        assert.deepEqual(readFileSync(target), readFileSync(prompt));
        assert.equal(targetStat.size, j.descriptor.manifest.control.bytes);
        if (variant === 'symlink') {
          rmSync(prompt); symlinkSync(target, prompt); assert.equal(lstatSync(prompt).isSymbolicLink(), true);
        }
        let result, error;
        try { result = await runBrowserScanUi(b.browser, j.runId); } catch (e) { error = e; }
        assert.equal(j.error(), undefined);
        assert.equal(b.state.sent, variant === 'regular' ? 1 : 0);
        if (variant === 'regular') { assert.equal(error, undefined); assert.equal(result.state, 'SUBMITTED'); }
        else { assert.match(error?.message ?? '', /GEMINI_BROWSER_FILE_PATH/); assert.deepEqual(b.calls, []); }
      } finally {
        try { if (b.state.sent) await cancelBrowserScan(j.runId); } finally { j.cleanup(); }
      }
    });
  }
});

test('已結束的真合成 runner 及雙 adapter 競爭都不多送', async () => {
  const dead = spawn(process.execPath, ['-e', ''], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  await new Promise(resolve => dead.once('close', resolve));
  {
    const j = jobFixture(), b = browserFixture(j);
    try {
      writeFileSync(join(j.dir, 'descriptor.json'), JSON.stringify({ ...j.descriptor, pid: dead.pid }));
      await assert.rejects(runBrowserScanUi(b.browser, j.runId)); assert.deepEqual(b.calls, []);
    } finally { j.cleanup(); }
  }
  const j = jobFixture(), b = browserFixture(j); j.serve();
  try {
    const other = await import('../scripts/gemini-browser-cua.js?independent-instance');
    const results = await Promise.allSettled([runBrowserScanUi(b.browser, j.runId), (async () => { await other.beginBrowserScan(b.browser, j.runId); await other.uploadBrowserScan(j.runId); return other.submitBrowserScan(j.runId); })()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(b.state.sent, 1);
    await cancelBrowserScan(j.runId);
  } finally { j.cleanup(); }
});

test('送出許可前取消、原文編碼壞掉及模型夾帶命令都不能追加動作', async () => {
  const j = jobFixture(), b = browserFixture(j); j.serve();
  const originalNew = b.browser.tabs.new;
  b.browser.tabs.new = async () => { j.stop(); writeOnce(j.dir, 'aborted.json', {}); return await originalNew(); };
  try { await assert.rejects(runBrowserScanUi(b.browser, j.runId)); assert.equal(b.state.sent, 0); assert.equal(b.state.closed, true); }
  finally { j.cleanup(); }
  for (const raw of ['\ud800', '{"command":"open credentials","url":"https://evil.test","selector":"Task"}']) {
    const k = jobFixture(), fake = browserFixture(k, { raw }); k.serve();
    try {
      await runBrowserScanUi(fake.browser, k.runId);
      if (raw === '\ud800') await assert.rejects(captureBrowserScan(k.runId), /REPLY_ENCODING/);
      else {
        await captureBrowserScan(k.runId);
        assert.equal(readMail(k.dir, 'capture.json').observation.responseBytes, Buffer.byteLength(raw));
      }
      assert.equal(fake.state.sent, 1); assert.equal(fake.calls.filter(c => c[0] === 'goto').length, 1);
    } finally { k.cleanup(); }
  }
});

test('沒有 process 的受限宿主用固定 owner 與活 runner 握手走完整 CUA 配方', () => {
  const fixture = new URL('./helpers/gemini-browser-fixture.js', import.meta.url).href;
  const files = new URL('../scripts/gemini-browser-files.js', import.meta.url).href;
  const adapter = new URL('../scripts/gemini-browser-cua.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import {readFileSync} from 'node:fs';
    import {jobFixture,browserFixture} from ${JSON.stringify(fixture)};
    const context=vm.createContext({Buffer,TextDecoder,setTimeout,clearTimeout});
    assert.equal(vm.runInContext('typeof process',context),'undefined');
    const allowed=new Set(['node:fs','node:path','node:url','node:crypto','node:perf_hooks','node:util']);
    const cache=new Map();
    async function load(id){
      if(cache.has(id))return cache.get(id);
      let module;
      if(id.startsWith('node:')){
        assert.ok(allowed.has(id),'unsupported host module '+id);
        const value=await import(id);
        module=new vm.SyntheticModule(Object.keys(value),function(){for(const key of Object.keys(value))this.setExport(key,value[key]);},{context,identifier:id});
      }else{
        module=new vm.SourceTextModule(readFileSync(new URL(id),'utf8'),{context,identifier:id,initializeImportMeta(meta,m){meta.url=m.identifier;}});
      }
      cache.set(id,module);
      await module.link((specifier,ref)=>load(specifier.startsWith('node:')?specifier:new URL(specifier,ref.identifier).href));
      return module;
    }
    const f=await load(${JSON.stringify(files)});await f.evaluate();
    f.namespace.configureBrowserOwner(process.getuid());
    assert.throws(()=>f.namespace.configureBrowserOwner(process.getuid()+1));
    const a=await load(${JSON.stringify(adapter)});await a.evaluate();
    const j=jobFixture(),b=browserFixture(j);j.serve();
    try{
      await a.namespace.beginBrowserScan(b.browser,j.runId);await a.namespace.uploadBrowserScan(j.runId);assert.equal((await a.namespace.submitBrowserScan(j.runId)).state,'SUBMITTED');
      assert.equal((await a.namespace.captureBrowserScan(j.runId)).state,'CAPTURED');
      assert.equal(b.state.sent,1);assert.equal(b.state.closed,true);
    }finally{j.cleanup();}
    process.stdout.write('RESTRICTED-HOST-OK');
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'RESTRICTED-HOST-OK');
});
