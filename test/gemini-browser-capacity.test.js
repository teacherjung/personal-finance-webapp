import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { browserClient } from '../scripts/gemini-browser-client.js';
import { prepareBrowserPacket, ATTACHMENT_CAP, sha256 } from '../scripts/gemini-browser-protocol.js';
import { captureBrowserScan } from '../scripts/gemini-browser-cua.js';
import { readMail, mailExists, readBoundedFile } from '../scripts/gemini-browser-files.js';
import { runBrowserScanUi, material, answer, observation, jobFixture, browserFixture } from './helpers/gemini-browser-fixture.js';

const CAPACITY = 2 * 1024 * 1024;
function sizedMaterial(bytes) {
  const m = material(), value = JSON.parse(m.text);
  value.prompt = '合成中文 "quoted" \\escaped\n';
  const build = () => { const text = JSON.stringify(value); return { ...m, text, sha256: sha256(text) }; };
  const overhead = prepareBrowserPacket(build()).manifest.attachment.bytes;
  assert.ok(bytes >= overhead);
  value.prompt += 'x'.repeat(bytes - overhead);
  return build();
}

test('完整文字請求以 UTF-8 與 JSON 跳脫後 bytes 計算：2 MiB 接受，多一 byte 拒收', () => {
  assert.equal(ATTACHMENT_CAP, CAPACITY);
  const full = sizedMaterial(CAPACITY), packet = prepareBrowserPacket(full);
  assert.equal(packet.manifest.attachment.bytes, CAPACITY);
  assert.equal(Buffer.byteLength(packet.attachmentText), CAPACITY);
  assert.ok(packet.attachmentText.length < CAPACITY);
  assert.ok(packet.attachmentText.includes('合成中文 \\"quoted\\" \\\\escaped\\n'));
  const start = packet.attachmentText.indexOf('{'), end = packet.attachmentText.lastIndexOf('}');
  assert.deepEqual(JSON.parse(packet.attachmentText.slice(start, end + 1)).material, JSON.parse(full.text));
  assert.throws(() => prepareBrowserPacket(sizedMaterial(CAPACITY + 1)), /GEMINI_BROWSER_ATTACHMENT_SIZE/);
});

test('盒內 client 完整容量請求與唯一原文回覆往返', async () => {
  const input = new PassThrough(), output = [], full = sizedMaterial(CAPACITY);
  input.write(JSON.stringify({ kind: 'start', material: full }) + '\n');
  await browserClient(input, line => {
    const frame = JSON.parse(line); output.push(frame);
    if (frame.kind === 'request') {
      assert.equal(frame.packet.manifest.attachment.bytes, CAPACITY);
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
    const j = jobFixture(sizedMaterial(CAPACITY)), b = browserFixture(j, { truncate, textContentCap: 1000000 }); j.serve();
    try {
      assert.throws(() => readBoundedFile(j.dir + '/' + j.packet.manifest.attachment.name), /GEMINI_BROWSER_FILE/);
      if (truncate) {
        await assert.rejects(runBrowserScanUi(b.browser, j.runId), /GEMINI_BROWSER_UI_STATE/);
        assert.equal(b.state.sent, 0); assert.equal(mailExists(j.dir, 'permit.json'), false);
        assert.equal(readMail(j.dir, 'quiescent.json').failed, true);
        const diagnostic = readMail(j.dir, 'adapter-failed.json');
        assert.equal(diagnostic.phase, 'input-readback');
        assert.equal(diagnostic.readbacks.input.sampled, true);
        assert.equal(diagnostic.readbacks.input.expectedCodeUnits, j.packet.controlPrompt.length);
        assert.equal(diagnostic.readbacks.input.actualCodeUnits, j.packet.controlPrompt.length - 1);
        assert.equal(diagnostic.readbacks.input.match, false);
      } else {
        assert.equal((await runBrowserScanUi(b.browser, j.runId)).state, 'SUBMITTED');
        assert.equal(b.calls.find(c => c[0] === 'fill')[1], j.packet.controlPrompt);
        assert.equal((await captureBrowserScan(j.runId)).state, 'CAPTURED');
        await assert.rejects(runBrowserScanUi(b.browser, j.runId), /REPLAY/);
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
    value.prompt+='x'.repeat(${CAPACITY}-protocol.prepareBrowserPacket(base).manifest.attachment.bytes);
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
          if(path.split('/').pop().startsWith('gemini-') && path.endsWith('.txt')){
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

test('失敗診斷分辨等待階段與讀回差異，寫檔失敗仍收尾且不洩露樣本', () => {
  const adapter = new URL('../scripts/gemini-browser-cua.js', import.meta.url).href;
  const fixture = new URL('./helpers/gemini-browser-fixture.js', import.meta.url).href;
  const files = new URL('../scripts/gemini-browser-files.js', import.meta.url).href;
  const protocol = new URL('../scripts/gemini-browser-protocol.js', import.meta.url).href;
  // 受控時鐘只讓既有等待越過期限；瀏覽器是假身，不證明平台狀態或實際傳輸容量。
  const script = `
    import assert from 'node:assert/strict';import vm from 'node:vm';import fs from 'node:fs';
    import {jobFixture,browserFixture,material} from ${JSON.stringify(fixture)};
    import * as files from ${JSON.stringify(files)};import {sha256} from ${JSON.stringify(protocol)};
    let now=0,current;
    const context=vm.createContext({Buffer,TextDecoder,Error,setTimeout,clearTimeout});
    const module=new vm.SourceTextModule(fs.readFileSync(new URL(${JSON.stringify(adapter)}),'utf8'),
      {context,identifier:${JSON.stringify(adapter)},initializeImportMeta(meta,m){meta.url=m.identifier;}});
    await module.link(async(specifier,ref)=>{
      const id=specifier.startsWith('node:')?specifier:new URL(specifier,ref.identifier).href, value={...await import(id)};
      if(specifier==='node:perf_hooks')value.performance={now:()=>now};
      if(specifier==='./gemini-browser-files.js'){
        value.writeOnce=(dir,name,data)=>{if(current.writeFail&&name==='adapter-failed.json')throw Error('synthetic-write-failure');return files.writeOnce(dir,name,data);};
        value.readMail=(dir,name)=>{if(current.mail===name)throw Error(current.decoy);return files.readMail(dir,name);};
      }
      return new vm.SyntheticModule(Object.keys(value),function(){for(const k of Object.keys(value))this.setExport(k,value[k]);},{context,identifier:id});
    });await module.evaluate();
    const role=(role,name)=>'getByRole:'+role+':'+name;
    const picker=role('button','/^Open mode picker, currently /'), textbox=role('textbox','Enter a prompt for Gemini');
    const target=(phase,path,action,nth=1,timeout=false)=>({phase,path,action,nth,timeout});
    const cases=[
      {phase:'claim-ack',mail:'claim-ack.json'},target('new-tab','tabs','new'),target('navigate','tab','goto'),target('initial-origin','tab','url'),
      target('initial-controls',role('button','Temporary chat'),'isVisible',1,true),target('initial-model-control',picker,'waitFor'),
      target('initial-empty','locator:model-response-content','count'),target('temporary-activate',role('button','Temporary chat'),'click'),
      target('temporary-confirm','getByText:Just stopping by?','isVisible',1,true),target('model-menu-open',picker,'click'),
      target('model-option-wait',role('menuitem','/4 Argon Complex tasks/'),'isVisible',1,true),target('model-select',role('menuitem','/4 Argon Complex tasks/'),'click'),
      target('model-confirm',picker,'getAttribute',1,true),target('effort-menu-open',picker,'click',2),
      target('effort-menu-wait',role('menuitem','Thinking level'),'isVisible',1,true),target('effort-menu-select',role('menuitem','Thinking level'),'click'),
      target('effort-option-wait',role('menuitem','High Extra thorough'),'isVisible',1,true),target('effort-select',role('menuitem','High Extra thorough'),'click'),
      target('effort-confirm',picker,'getAttribute',2,true),target('input-fill',textbox,'fill'),
      target('input-readback',textbox,'evaluate'),target('ready-precondition','getByText:Just stopping by?','isVisible',3),
      {phase:'permit-wait',mail:'permit.json'},target('submit-precondition','tab','url',3),target('submit-attempt',role('button','Send message'),'click'),
      ...['missing','extra','bool','length','negative','unsampled'].map(invalid=>({...target('input-readback',textbox,'evaluate'),invalid})),
      ...['short','same-bytes','null','bad-encoding'].map(mode=>({...target('input-readback',textbox,'evaluate'),mode})),
      {...target('submit-precondition',textbox,'evaluate',2),mode:'same-bytes'},
      {...target('input-fill',textbox,'fill'),writeFail:true},
      {...target('input-fill',textbox,'fill'),closeFail:true}
    ];
    for(const item of cases){
      now=0;current={...item,decoy:'PRIVATE-SYNTHETIC-'+Math.random()+'中文'};
      const base=material(),data=JSON.parse(base.text);data.prompt+=current.decoy;
      const text=JSON.stringify(data),j=jobFixture({...base,text,sha256:sha256(text)}),b=browserFixture(j);
      const counts=new Map();let reached=0,actual,closeAttempts=0;
      function wrap(object,path){return new Proxy(object,{get(target,key){
        const value=target[key];if(typeof value!=='function')return value&&typeof value==='object'?wrap(value,String(key)):value;
        return(...args)=>{
          if(['getByRole','getByText','locator'].includes(String(key))){
            const next=key==='getByRole'?role(args[0],String(args[1]?.name??'')):String(key)+':'+String(args[0]);return wrap(value.apply(target,args),next);
          }
          if(key==='close'){closeAttempts++;if(current.closeFail)throw Error(current.decoy);}
          const id=path+'/'+String(key),count=(counts.get(id)??0)+1;counts.set(id,count);
          if(current.path===path&&current.action===key&&count===current.nth){
            reached++;
            if(current.invalid){
              const result=args[0]({textContent:j.packet.controlPrompt},args[1]);
              if(current.invalid==='missing')delete result.actualCodeUnits;
              if(current.invalid==='extra')result.other=true;
              if(current.invalid==='bool')result.match='true';
              if(current.invalid==='length'){result.expectedCodeUnits--;result.actualCodeUnits--;}
              if(current.invalid==='negative')result.actualCodeUnits=-1;
              if(current.invalid==='unsampled'){result.sampled=false;result.actualCodeUnits=null;}
              return Promise.resolve(result);
            }
            if(current.mode){
              actual=current.mode==='short'?j.packet.controlPrompt.slice(0,-1):current.mode==='same-bytes'?j.packet.controlPrompt.slice(0,Math.floor(j.packet.controlPrompt.length/2))+'X'+j.packet.controlPrompt.slice(Math.floor(j.packet.controlPrompt.length/2)+1):current.mode==='null'?null:'\\ud800';
              now+=11000;return Promise.resolve(args[0]({textContent:actual},args[1]));
            }
            if(current.timeout){now+=11000;return Promise.resolve(key==='getAttribute'?'wrong-model':false);}
            throw Error(current.decoy);
          }
          const result=value.apply(target,args);return key==='new'?result.then(tab=>wrap(tab,'tab')):result;
        };
      }});}
      j.serve();
      try{
        await assert.rejects(async()=>{await module.namespace.beginBrowserScan(wrap(b.browser,'browser'),j.runId);await module.namespace.uploadBrowserScan(j.runId);await module.namespace.submitBrowserScan(j.runId);});
        assert.equal(b.state.sent,0);assert.equal(files.mailExists(j.dir,'submitted.json'),false);
        if(!current.mail)assert.equal(reached,1,item.phase);
        const expectedTab=item.phase!=='claim-ack'&&item.phase!=='new-tab';
        assert.equal(closeAttempts,expectedTab?1:0,item.phase);
        assert.equal(files.mailExists(j.dir,'quiescent.json'),!current.closeFail,item.phase);
        if(!current.closeFail)assert.equal(files.readMail(j.dir,'quiescent.json').tabClosed,expectedTab);
        if(!current.writeFail){
          const raw=fs.readFileSync(j.dir+'/adapter-failed.json','utf8'),d=JSON.parse(raw);
          assert.equal(d.phase,item.phase);assert.equal(raw.includes(current.decoy),false);
          assert.equal(d.readbackMethod,'dom-textContent-equality/v1');assert.equal(d.readbackUnit,'utf16-code-units');
          assert.deepEqual(Object.keys(d).sort(),['code','instance','phase','readbackMethod','readbackUnit','readbacks']);
          if(current.invalid)assert.equal(d.code,['missing','extra'].includes(current.invalid)?'other':'READBACK_RESULT');
          else if(current.timeout||current.mode&&item.phase==='input-readback')assert.equal(d.code,'UI_STATE');
          else if(current.mode)assert.equal(d.code,'PRECONDITION');else assert.equal(d.code,'other');
          if(current.mode){
            const sample=d.readbacks[item.phase==='input-readback'?'input':'submit'];
            assert.equal(sample.sampled,typeof actual==='string');
            assert.equal(sample.expectedCodeUnits,j.packet.controlPrompt.length);
            assert.equal(sample.actualCodeUnits,typeof actual==='string'?actual.length:null);assert.equal(sample.match,false);
            if(item.phase==='input-readback')assert.equal(files.mailExists(j.dir,'ready.json'),false);
          }
          if(item.phase==='input-fill')assert.deepEqual(d.readbacks.input,{sampled:false,expectedCodeUnits:j.packet.controlPrompt.length,actualCodeUnits:null,match:false});
        }
      }finally{j.cleanup();}
    }
    process.stdout.write('DIAGNOSTICS-OK');
  `;
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'DIAGNOSTICS-OK');
});
