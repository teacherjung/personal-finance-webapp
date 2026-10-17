import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { browserClient } from '../scripts/gemini-browser-client.js';
import { prepareBrowserPacket, PROMPT_CAP, sha256 } from '../scripts/gemini-browser-protocol.js';
import { beginBrowserScan, captureBrowserScan } from '../scripts/gemini-browser-cua.js';
import { readMail, mailExists, readBoundedFile } from '../scripts/gemini-browser-files.js';
import { material, answer, observation, jobFixture, browserFixture } from './helpers/gemini-browser-fixture.js';

const CAPACITY = 2 * 1024 * 1024;
function sizedMaterial(bytes) {
  const m = material(), value = JSON.parse(m.text);
  value.prompt = '合成中文 "quoted" \\escaped\n';
  const build = () => { const text = JSON.stringify(value); return { ...m, text, sha256: sha256(text) }; };
  const overhead = prepareBrowserPacket(build()).promptBytes;
  assert.ok(bytes >= overhead);
  value.prompt += 'x'.repeat(bytes - overhead);
  return build();
}

test('完整文字請求以 UTF-8 與 JSON 跳脫後 bytes 計算：2 MiB 接受，多一 byte 拒收', () => {
  assert.equal(PROMPT_CAP, CAPACITY);
  const full = sizedMaterial(CAPACITY), packet = prepareBrowserPacket(full);
  assert.equal(packet.promptBytes, CAPACITY);
  assert.equal(Buffer.byteLength(packet.prompt), CAPACITY);
  assert.ok(packet.prompt.length < CAPACITY);
  assert.ok(packet.prompt.includes('合成中文 \\"quoted\\" \\\\escaped\\n'));
  const start = packet.prompt.indexOf('{'), end = packet.prompt.lastIndexOf('}');
  assert.deepEqual(JSON.parse(packet.prompt.slice(start, end + 1)).material, JSON.parse(full.text));
  assert.throws(() => prepareBrowserPacket(sizedMaterial(CAPACITY + 1)), /GEMINI_BROWSER_PROMPT_SIZE/);
});

test('盒內 client 完整容量請求與唯一原文回覆往返', async () => {
  const input = new PassThrough(), output = [], full = sizedMaterial(CAPACITY);
  input.write(JSON.stringify({ kind: 'start', material: full }) + '\n');
  await browserClient(input, line => {
    const frame = JSON.parse(line); output.push(frame);
    if (frame.kind === 'request') {
      assert.equal(frame.packet.promptBytes, CAPACITY);
      assert.equal(frame.packet.binding.materialSha256, full.sha256);
      input.end(JSON.stringify({ kind: 'reply', response: answer(frame.packet), observation: observation(frame.packet) }) + '\n');
    }
  });
  assert.equal(output.length, 2); assert.equal(output[1].kind, 'result');
  assert.equal(output[1].result.answer.findings.length, 1);
  assert.equal(output[1].result.receiverConsumptionVerified, false);
});

test('固定 CUA 讀取完整容量並核逐字內容；少一字時零送出且關閉自有分頁', async () => {
  // API 假身只證明本機配方；實際網頁、沙箱與接收容量另由固定版資格場驗收。
  for (const truncate of [false, true]) {
    const j = jobFixture(sizedMaterial(CAPACITY)), b = browserFixture(j, { truncate }); j.serve();
    try {
      assert.throws(() => readBoundedFile(j.dir + '/prompt.txt'), /GEMINI_BROWSER_FILE/);
      if (truncate) {
        await assert.rejects(beginBrowserScan(b.browser, j.runId), /GEMINI_BROWSER_UI_STATE/);
        assert.equal(b.state.sent, 0); assert.equal(mailExists(j.dir, 'permit.json'), false);
        assert.equal(readMail(j.dir, 'quiescent.json').failed, true);
      } else {
        assert.equal((await beginBrowserScan(b.browser, j.runId)).state, 'SUBMITTED');
        assert.equal(b.calls.find(c => c[0] === 'fill')[1], j.packet.prompt);
        assert.equal((await captureBrowserScan(j.runId)).state, 'CAPTURED');
        await assert.rejects(beginBrowserScan(b.browser, j.runId), /REPLAY/);
        assert.equal(b.state.sent, 1); assert.equal(readMail(j.dir, 'quiescent.json').failed, false);
      }
      assert.equal(b.state.closed, true); assert.equal(j.error(), undefined);
    } finally { j.cleanup(); }
  }
});

test('runner 的活性核對可讀完整容量，普通信箱仍維持小容量拒收', () => {
  const runner = new URL('../scripts/gemini-browser-runner.js', import.meta.url).href;
  const protocol = new URL('../scripts/gemini-browser-protocol.js', import.meta.url).href;
  const fixture = new URL('./helpers/gemini-browser-fixture.js', import.meta.url).href;
  // 原樣 runner 執行到 prompt 重讀；假身取代 OS、來源身分與子程序，不提供正式隔離證據。
  const script = `
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    import fs from 'node:fs';
    import {join} from 'node:path';
    import {tmpdir} from 'node:os';
    import {EventEmitter} from 'node:events';
    import {PassThrough} from 'node:stream';
    import * as protocol from ${JSON.stringify(protocol)};
    import {material} from ${JSON.stringify(fixture)};
    const base=material(), value=JSON.parse(base.text);
    value.prompt+='x'.repeat(${CAPACITY}-protocol.prepareBrowserPacket(base).promptBytes);
    const text=JSON.stringify(value), full={...base,text,sha256:protocol.sha256(text)};
    const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'browser-capacity-test-'))), jobs=join(root,'jobs');
    const context=vm.createContext({Buffer,TextDecoder,process,setTimeout,clearTimeout});
    let child, promptRead=false, box;
    const module=new vm.SourceTextModule(fs.readFileSync(new URL(${JSON.stringify(runner)}),'utf8'),
      {context,identifier:${JSON.stringify(runner)},initializeImportMeta(meta,m){meta.url=m.identifier;}});
    await module.link(async(specifier,ref)=>{
      const id=specifier.startsWith('node:')?specifier:new URL(specifier,ref.identifier).href;
      const real=await import(id), value={...real};
      if(specifier==='node:fs')value.mkdtempSync=()=>{box=fs.mkdtempSync(join(root,'box-'));return box;};
      if(specifier==='node:child_process')value.spawn=()=>{
        child=new EventEmitter();Object.assign(child,{pid:12345,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});
        child.stdin.on('data',bytes=>{
          const event=JSON.parse(bytes.toString());assert.equal(event.kind,'start');
          child.stdout.write(JSON.stringify({kind:'request',packet:protocol.prepareBrowserPacket(event.material)})+'\\n');
        });return child;
      };
      if(specifier==='./gemini-browser-files.js')Object.assign(value,{
        JOB_ROOT:jobs,sourceDigest:()=>({sha256:'2'.repeat(64)}),
        readBoundedFile:(path,cap)=>{
          const bytes=real.readBoundedFile(path,cap);
          if(path.endsWith('/prompt.txt')){
            assert.equal(bytes.length,${CAPACITY});
            assert.throws(()=>real.readBoundedFile(path),/GEMINI_BROWSER_FILE/);
            promptRead=true;throw Error('CAPACITY_READ_COMPLETE');
          }return bytes;
        }
      });
      if(specifier==='./gemini-native-runner.js')Object.assign(value,{snapshotPinnedSources:()=>[],verifyPinnedSourcesUnchanged:()=>{}});
      if(specifier==='./gemini-scan.js')Object.assign(value,{verifyProvider:()=>({digest:'3'.repeat(64)}),buildScanMaterials:()=>({text,materialSha256:full.sha256})});
      if(specifier==='./gemini-browser-canary.js')value.browserCanary=async()=>({code:0});
      if(specifier==='./grok-scan.js')Object.assign(value,{killGroupAndWait:async()=>{child.emit('close',0);},sweepEscapees:()=>0});
      return new vm.SyntheticModule(Object.keys(value),function(){for(const k of Object.keys(value))this.setExport(k,value[k]);},{context,identifier:id});
    });
    try{
      await module.evaluate();
      const pins=['wrapper','deployment','prompt','node','cua-loader'].map(name=>({name,path:name==='node'?fs.realpathSync(process.execPath):'/synthetic/'+name,sha256:'1'.repeat(64)}));
      await assert.rejects(module.namespace.runBrowserScan({purpose:'qualification',providerHead:'c'.repeat(40),repo:'/synthetic/repo',
        base:full.base,head:full.head,promptFile:'/synthetic/prompt',pins,qualification:null}),/GEMINI_BROWSER_FAILED/);
      assert.equal(promptRead,true,'runner prompt read did not complete; inspect explicit cap and rerun capacity test');
      assert.equal(fs.existsSync(join(jobs,'active')),false);assert.equal(fs.existsSync(box),false);
      const job=join(jobs,fs.readdirSync(jobs).find(p=>/^[a-f0-9]{32}$/.test(p)));
      const failure=JSON.parse(fs.readFileSync(join(job,'failure.json'),'utf8'));
      assert.equal(failure.cleaned,true);assert.equal(failure.error,'GEMINI_BROWSER_REJECTED');
      assert.equal(fs.existsSync(join(job,'claim.json')),false);assert.equal(fs.existsSync(join(job,'receipt.json')),false);
      process.stdout.write('RUNNER-CAPACITY-OK');
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.endsWith('RUNNER-CAPACITY-OK'), true);
});
