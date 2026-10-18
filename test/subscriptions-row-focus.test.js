// 正式 app 與訂閱按鈕的真 DOM；合成 fetch 不連外、不讀帳本。
// jsdom 不算版面；矩形夾具只供可見性判斷，焦點仍由 DOM 原生實作。
/* global window, document, Element */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let app, renderSubscriptions, serial = 0, rows, calls, reads, putWait, putFail, putPlans, errors;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
const el = s => document.querySelector(s);
const flag = (id = rows[0].id) => [...document.querySelectorAll('.subs-table [data-flag]')].find(b => b.dataset.flag === id);
const puts = () => calls.filter(c => c.method === 'PUT');
async function boot() {
  if (app) return;
  const win = new JSDOM('<!doctype html><nav id="nav"></nav><button id="snapshotBtn"></button><button id="outside">外部</button><main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>', { url: 'http://localhost/#subscriptions', pretendToBeVisual: true }).window;
  for (const k of ['window','document','location','localStorage','HTMLElement','Element','Node','Event','CustomEvent','KeyboardEvent','MouseEvent','MutationObserver','requestAnimationFrame','getComputedStyle']) Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
  Object.defineProperty(globalThis, 'Chart', { configurable: true, value: class { destroy() {} } });
  win.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
  win.addEventListener('error', e => { errors.push(e.error?.message || e.message); e.preventDefault(); });
  globalThis.fetch = async (url, init) => {
    const path = String(url).split('?')[0], method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    const call={ path, method, body };calls.push(call);
    if (method === 'PUT' && path.startsWith('/api/subscriptions/')) {
      const row = rows.find(r => r.id === path.split('/').at(-1));
      const planned=putPlans.shift();
      if(planned){const response=await planned(row,body);call.status=response.status;return response;}
      if (putWait) await putWait.promise;
      if (putFail) {call.status=503;return json({ error: '合成寫入失敗' }, 503);}
      Object.assign(row, body);call.status=200;return json(row);
    }
    if (path === '/api/subscriptions') {
      const snap = structuredClone(rows), next = reads.shift();
      return next ? next(snap) : json(snap);
    }
    if (path === '/api/history') {
      const hist = []; const now = new Date();
      for (let y = 2026; y <= now.getFullYear(); y++) for (let m = 1; m <= 12; m++) hist.push({ id: `${y}-${m}`, month: `${y}-${String(m).padStart(2,'0')}`, amount: 1 });
      return json(hist);
    }
    if (path === '/api/mode') return json({ hosted: false });
    if (['/api/cards','/api/accounts','/api/insurance','/api/transactions'].includes(path)) return json([]);
    return json({});
  };
  app = await import('../public/app.js'); await app.bootSettled;
  ({ renderSubscriptions } = await import('../public/modules/subscriptions.js'));
  await settle();
}
beforeEach(async () => {
  serial++; calls=[]; reads=[]; putWait=null; putFail=false;putPlans=[]; errors=[];
  rows = ['a','b'].map((x,i)=>({ id:`${serial}-${x}`,name:'本題合成'+x,amount:100+i,cycle:'monthly',since:'2026-06',nextCharge:'2099-12-01',status:'active',active:true,considerCancel:false }));
  await boot();
  el('#modal-root').replaceChildren();
  window.location.hash='#cards'; await settle();
  window.location.hash='#subscriptions'; await settle();
  el('#toast-root').replaceChildren(); calls=[];
});
afterEach(() => assert.deepEqual(errors, []));
async function start() { const b=flag(); assert.ok(b); b.focus(); assert.equal(document.activeElement,b); b.click(); await settle(); return b; }
function written(id) { assert.equal(rows.find(r=>r.id===id).considerCancel,true); assert.equal(puts().filter(c=>c.path==='/api/subscriptions/'+id && c.body?.considerCancel===true).length,1); }

test('標記真寫入後回同筆標記鈕，通知一次且不補發寫入', async()=>{
  const id=rows[0].id, old=flag(); await start(); written(id);
  assert.notEqual(flag(id),old); assert.equal(document.activeElement,flag(id));
  assert.equal(document.querySelectorAll('.subscriptions-notice').length,1); assert.equal(el('#toast-root').textContent,'');
});
test('等待讀取後重排列序，依穩定身分回焦',async()=>{
  const id=rows[0].id,d=defer(); reads.push(async snap=>{await d.promise;return json(snap.reverse());});
  await start(); written(id); d.resolve(); await settle(); assert.equal(document.activeElement,flag(id));
});
for(const stage of ['PUT','GET']) test(`${stage}等待中移焦，完成寫入與重畫但不搶回`,async()=>{
  const d=defer(),id=rows[0].id;
  if(stage==='PUT')putWait=d;else reads.push(async snap=>{await d.promise;return json(snap);});
  await start(); el('#outside').focus(); d.resolve(); await settle();written(id);assert.equal(document.activeElement,el('#outside'));
});
for(const event of ['keydown','pointerdown','touchstart','wheel']) test(`等待時${event}取消回焦，原操作照常完成`,async()=>{
  const d=defer(),id=rows[0].id;putWait=d;await start();document.dispatchEvent(new Event(event,{bubbles:true}));d.resolve();await settle();written(id);assert.equal(document.activeElement,document.body);
});
for(const close of [false,true]) test(`新窗${close?'開後關閉':'持續持焦'}使舊回焦失效`,async()=>{
  const d=defer(),id=rows[0].id;putWait=d;await start();
  app.openInfo('本題新窗','<input id="newField" value="本題未儲存" data-modal-initial>');await settle();
  if(close){el('#modal-root .x-close').click();await settle();}
  d.resolve();await settle();written(id);
  if(close)assert.notEqual(document.activeElement,flag(id));
  else{assert.equal(document.activeElement,el('#newField'));assert.equal(el('#newField').value,'本題未儲存');}
});
for(const failure of ['PUT','GET','empty'])test(`${failure}結果不新增回焦目的地且不重送PUT`,async()=>{
  if(failure==='PUT')putFail=true;
  if(failure==='GET')reads.push(()=>json({error:'合成讀取失敗'},503));
  if(failure==='empty')reads.push(()=>json([]));
  const id=rows[0].id,old=await start();assert.equal(puts().length,1);
  if(failure==='PUT'){assert.equal(rows[0].considerCancel,false);assert.equal(document.activeElement,old);}
  else{written(id);assert.equal(document.activeElement,document.body);assert.ok(el(failure==='GET'?'#retrySubscriptions':'#emptyAddSub'));}
});
for(const bad of [false,true])test(`較舊${bad?'失敗':'成功'}不覆蓋較新同頁呈現`,async()=>{
  const id=rows[0].id,d=defer();reads.push(async snap=>{await d.promise;return bad?json({error:'合成舊失敗'},503):json(snap);});
  await start();written(id);rows[0].name='本題較新名稱';await renderSubscriptions({showLoading:false});const newer=el('.subscriptions-page');el('#outside').focus();d.resolve();await settle();
  assert.equal(el('.subscriptions-page'),newer);assert.match(newer.textContent,/本題較新名稱/);assert.equal(document.activeElement,el('#outside'));
});
test('程式點擊未持焦標記鈕，不憑空取得回焦權',async()=>{const id=rows[0].id;el('#outside').focus();flag().click();await settle();written(id);assert.equal(document.activeElement,el('#outside'));});

// 在真 renderer 的同步 DOM 提交點製造候選失效；不替換 DOM focus 行為。
function alterCommit(change, before = () => {}) {
  const host=el('#view'), native=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
  Object.defineProperty(host,'innerHTML',{configurable:true,get(){return native.get.call(this);},set(value){
    if (String(value).includes('class="subs-table"')) before(this);
    native.set.call(this,value);
    if(this.querySelector('.subs-table')){delete host.innerHTML;change(this);}
  }});
}
for(const state of ['disabled','hidden','inert','display','throw'])test(`標記鈕${state}時退同筆編輯鈕`,async()=>{
  const id=rows[0].id;alterCommit(()=>{const b=flag(id);if(state==='disabled')b.disabled=true;else if(state==='hidden')b.hidden=true;else if(state==='inert')b.setAttribute('inert','');else if(state==='display')b.style.display='none';else b.focus=()=>{throw new Error('合成聚焦失敗');};});
  await start();written(id);assert.equal(document.activeElement,el(`.subs-table [data-edit="${id}"]`));
});
test('同筆兩鈕均失效時回指定標題，離焦才還原暫加屬性',async()=>{
  const id=rows[0].id;alterCommit(()=>{flag(id).disabled=true;el(`.subs-table [data-edit="${id}"]`).hidden=true;});
  await start();written(id);const h=el('.subscriptions-workspace h2');assert.equal(document.activeElement,h);assert.equal(h.getAttribute('tabindex'),'-1');el('#outside').focus();assert.equal(h.hasAttribute('tabindex'),false);
});
test('原列消失，其他列仍在時回指定標題且只消費一次',async()=>{
  const id=rows[0].id;reads.push(snap=>json(snap.slice(1)));await start();written(id);
  const h=el('.subscriptions-workspace h2');assert.equal(document.activeElement,h);await renderSubscriptions({showLoading:false});await settle();assert.equal(document.activeElement,document.body);assert.equal(h.hasAttribute('tabindex'),false);
});
test('暫加屬性在外部改寫後不覆寫，既有tabindex不移除',async()=>{
  const id=rows[0].id;reads.push(snap=>json(snap.slice(1)));alterCommit(host=>host.querySelector('.subscriptions-workspace h2').setAttribute('tabindex','0'));
  await start();written(id);const h=el('.subscriptions-workspace h2');assert.equal(document.activeElement,h);el('#outside').focus();assert.equal(h.getAttribute('tabindex'),'0');
});
test('暫加tabindex被外部改寫後離焦不覆寫',async()=>{
  const id=rows[0].id;reads.push(snap=>json(snap.slice(1)));await start();written(id);const h=el('.subscriptions-workspace h2');assert.equal(document.activeElement,h);h.setAttribute('tabindex','3');el('#outside').focus();assert.equal(h.getAttribute('tabindex'),'3');
});
for(const state of ['hidden','missing','throw'])test(`指定標題${state}且列消失時不發明第四落點`,async()=>{
  const id=rows[0].id;reads.push(snap=>json(snap.slice(1)));let h;
  alterCommit(host=>{h=host.querySelector('.subscriptions-workspace h2');if(state==='hidden')h.hidden=true;else if(state==='missing')h.remove();else h.focus=()=>{throw new Error('合成聚焦失敗');};});
  await start();written(id);assert.equal(document.activeElement,document.body);assert.equal(h.hasAttribute('tabindex'),false);
});
test('重複訂閱身分不猜其中一列',async()=>{const id=rows[0].id;reads.push(snap=>json([...snap,snap[0]]));await start();written(id);assert.equal(document.activeElement,document.body);});
test('候選focus事件轉焦新窗後停止，不再嘗試編輯或標題',async()=>{
  const id=rows[0].id;alterCommit(()=>flag(id).addEventListener('focus',()=>app.openInfo('接管','<input id="reentrant" data-modal-initial value="本題未存">'),{once:true}));
  await start();written(id);await settle();assert.equal(document.activeElement,el('#reentrant'));assert.equal(el('#reentrant').value,'本題未存');
});
for(const kind of ['hash','away-back','router','blur','hidden','original-blur'])test(`${kind}接管後舊工作不回焦`,async()=>{
  const id=rows[0].id,d=defer();putWait=d;await start();
  if(kind==='hash')window.location.hash='#subscriptions?other=1';
  if(kind==='away-back'){window.location.hash='#cards';await settle();window.location.hash='#subscriptions';await settle();}
  if(kind==='router')await app.router();
  if(kind==='blur')window.dispatchEvent(new Event('blur'));
  if(kind==='hidden'){Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}
  if(kind==='original-blur')document.activeElement.blur();
  d.resolve();await settle();written(id);assert.notEqual(document.activeElement,flag(id));
  if(kind==='hidden')delete document.hidden;
});
test('第二筆標記已接管時，晚回舊操作不移動目前外部焦點',async()=>{
  const id=rows[0].id,d=defer();putWait=d;await start();putWait=null;const b=flag(rows[1].id);b.focus();b.click();await settle();assert.equal(rows[1].considerCancel,true);el('#outside').focus();d.resolve();await settle();written(id);assert.equal(document.activeElement,el('#outside'));assert.equal(puts().length,2);
});
for(const bad of [false,true])test(`較舊PUT晚回不換掉較新標記頁面，舊讀取${bad?'錯誤誘餌':'成功'}不搶焦`,async()=>{
  rows[0].considerCancel=true;
  await renderSubscriptions({showLoading:false});await settle();
  const oldId=rows[0].id,newId=rows[1].id,d=defer();putWait=d;await start();
  putWait=null;const second=flag(newId);second.focus();second.click();await settle();
  written(newId);const page=el('.subscriptions-page'),focused=flag(newId),notice=el('.subscriptions-notice');
  assert.equal(document.activeElement,focused);assert.equal(notice.textContent,'已標記為考慮停用');
  if(bad)reads.push(()=>json({error:'本題舊讀取失敗'},503));
  const readCount=calls.filter(c=>c.path==='/api/subscriptions').length;
  d.resolve();await settle();
  assert.equal(rows.find(r=>r.id===oldId).considerCancel,false);assert.equal(puts().length,2);
  assert.equal(el('.subscriptions-page'),page);assert.equal(document.activeElement,focused);
  assert.equal(el('.subscriptions-notice'),notice);assert.equal(notice.textContent,'已標記為考慮停用');
  assert.equal(flag(oldId).classList.contains('flag-on'),false);
  assert.equal(calls.filter(c=>c.path==='/api/subscriptions').length,readCount);
  assert.equal(reads.length,bad?1:0);
});
test('晚確認只原地同步標記與同一物件閉包，其他欄位沿較新呈現',async()=>{
  rows[0].considerCancel=true;await renderSubscriptions({showLoading:false});await settle();
  const a=rows[0].id,b=rows[1].id,d=defer(),offIcon=flag(b).innerHTML,offTitle=flag(b).title;
  putPlans.push(async(row,body)=>{await d.promise;Object.assign(row,body);return json({...row,name:'本題舊回音名稱',amount:987654});});
  await start();rows[0].name='本題較新名稱';const second=flag(b);second.focus();second.click();await settle();
  const page=el('.subscriptions-page'),aButton=flag(a),bButton=flag(b),notice=el('.subscriptions-notice');
  d.resolve();await settle();
  assert.equal(el('.subscriptions-page'),page);assert.equal(flag(a),aButton);assert.equal(document.activeElement,bButton);assert.equal(el('.subscriptions-notice'),notice);
  assert.match(aButton.closest('tr').textContent,/本題較新名稱/);assert.doesNotMatch(aButton.closest('tr').textContent,/本題舊回音名稱|987,654/);
  assert.equal(aButton.classList.contains('flag-on'),false);assert.equal(aButton.closest('tr').querySelector('.cancel-dot').classList.contains('on'),false);
  assert.equal(aButton.innerHTML,offIcon);assert.equal(aButton.title,offTitle);
  aButton.focus();aButton.click();await settle();
  assert.equal(puts().length,3);assert.deepEqual(puts().at(-1).body,{considerCancel:true});assert.equal(rows[0].considerCancel,true);
});
for(const bad of [false,true])test(`真的在途舊GET${bad?'失敗':'成功'}不換掉較新標記的頁面與通知`,async()=>{
  rows[0].considerCancel=true;await renderSubscriptions({showLoading:false});await settle();
  const a=rows[0].id,b=rows[1].id,d=defer(),readsBefore=calls.filter(c=>c.path==='/api/subscriptions').length;let completed=false;
  reads.push(async snap=>{await d.promise;completed=true;return bad?json({error:'本題在途舊讀取失敗'},503):json(snap);});
  await start();assert.equal(rows[0].considerCancel,false);
  const second=flag(b);second.focus();second.click();await settle();written(b);
  const page=el('.subscriptions-page'),button=flag(b),notice=el('.subscriptions-notice');assert.equal(document.activeElement,button);
  d.resolve();await settle();assert.equal(completed,true);
  assert.equal(el('.subscriptions-page'),page);assert.equal(document.activeElement,button);assert.equal(el('.subscriptions-notice'),notice);
  assert.equal(notice.textContent,'已標記為考慮停用');assert.equal(puts().length,2);assert.equal(calls.filter(c=>c.path==='/api/subscriptions').length-readsBefore,2);
  assert.equal(flag(a).classList.contains('flag-on'),false);
});
test('新GET快照早於確認時只合併flag，下一次操作讀同一新呈現資料',async()=>{
  rows[0].considerCancel=true;await renderSubscriptions({showLoading:false});await settle();
  const a=rows[0].id,put=defer(),get=defer();putWait=put;await start();putWait=null;
  reads.push(async snap=>{await get.promise;return json(snap.map((r,i)=>i?r:{...r,name:'本題權威讀取名稱',amount:321}));});
  const reading=renderSubscriptions({showLoading:false});await settle();put.resolve();await settle();assert.equal(rows[0].considerCancel,false);
  get.resolve();await reading;await settle();
  const button=flag(a);assert.equal(button.classList.contains('flag-on'),false);assert.match(button.closest('tr').textContent,/本題權威讀取名稱/);assert.match(button.closest('tr').textContent,/321/);
  button.focus();button.click();await settle();assert.deepEqual(puts().at(-1).body,{considerCancel:true});assert.equal(rows[0].considerCancel,true);
});
test('確認後才開始的GET採權威新值，不永久覆蓋其他來源的flag',async()=>{
  const a=rows[0].id;await start();written(a);rows[0].considerCancel=false;rows[0].name='本題後續權威讀取';
  await renderSubscriptions({showLoading:false});await settle();assert.equal(flag(a).classList.contains('flag-on'),false);
  flag(a).focus();flag(a).click();await settle();assert.deepEqual(puts().at(-1).body,{considerCancel:true});assert.equal(rows[0].considerCancel,true);
});
test('新GET含重複身分時不合併晚確認的flag或猜其中一列',async()=>{
  const a=rows[0].id,put=defer(),get=defer();putWait=put;await start();putWait=null;
  reads.push(async snap=>{await get.promise;return json([...snap,snap[0]]);});const reading=renderSubscriptions({showLoading:false});await settle();
  put.resolve();await settle();written(a);get.resolve();await reading;await settle();
  const duplicates=[...document.querySelectorAll('[data-flag]')].filter(b=>b.dataset.flag===a);
  assert.equal(duplicates.length,2);assert.equal(duplicates.every(b=>!b.classList.contains('flag-on')),true);
});
for(const kind of ['id','type','target'])test(`未確認的${kind}回音不原地套值或當作成功`,async()=>{
  const a=rows[0].id,original=flag(a);putPlans.push(async(row,body)=>{Object.assign(row,body);return json({...row,...(kind==='id'?{id:'本題其他身分'}:{considerCancel:kind==='type'?'true':false})});});
  await start();written(a);assert.equal(flag(a),original);assert.equal(original.classList.contains('flag-on'),false);
  assert.equal(el('.subscriptions-notice'),null);assert.equal(calls.filter(c=>c.path==='/api/subscriptions').length,0);
});
test('同筆接受時凍結可見值並局部序列，每筆只送一次且不等整頁GET',async()=>{
  const a=rows[0].id,d=defer();putWait=d;const original=await start();putWait=null;original.click();await settle();
  assert.equal(puts().length,1);assert.deepEqual(puts()[0].body,{considerCancel:true});
  d.resolve();await settle();assert.equal(puts().length,2);assert.deepEqual(puts().map(c=>c.body),[{considerCancel:true},{considerCancel:true}]);
  assert.deepEqual(puts().map(c=>c.status),[200,200]);assert.equal(rows[0].considerCancel,true);assert.equal(document.activeElement,flag(a));
  const get=defer();reads.push(async snap=>{await get.promise;return json(snap);});flag(a).click();await settle();assert.equal(puts().length,3);
  assert.deepEqual(puts().at(-1).body,{considerCancel:false});assert.equal(rows[0].considerCancel,false);
  const heldButton=flag(a);heldButton.click();await settle();assert.equal(puts().length,4);assert.deepEqual(puts().at(-1).body,{considerCancel:true});
  get.resolve();await settle();assert.equal(rows[0].considerCancel,true);assert.equal(puts().length,4);
});
test('同筆前次PUT失敗不堵住後續已接受的固定目標',async()=>{
  const a=rows[0].id,d=defer();putPlans.push(async()=>{await d.promise;return json({error:'本題前筆失敗'},503);});
  const original=await start();original.click();await settle();assert.equal(puts().length,1);
  d.resolve();await settle();assert.equal(puts().length,2);assert.deepEqual(puts().map(c=>c.body),[{considerCancel:true},{considerCancel:true}]);
  assert.deepEqual(puts().map(c=>c.status),[503,200]);assert.equal(rows[0].considerCancel,true);assert.equal(flag(a).classList.contains('flag-on'),true);
});
test('不同筆互不等待，較新作業仍在PUT時舊確認只同步原列',async()=>{
  const a=rows[0].id,b=rows[1].id,first=defer(),second=defer();putWait=first;await start();putWait=second;
  const bButton=flag(b);bButton.focus();bButton.click();await settle();assert.equal(puts().length,2);
  const page=el('.subscriptions-page');first.resolve();await settle();written(a);
  assert.equal(rows[1].considerCancel,false);assert.equal(el('.subscriptions-page'),page);assert.equal(document.activeElement,bButton);
  assert.equal(flag(a).classList.contains('flag-on'),true);assert.equal(calls.filter(c=>c.path==='/api/subscriptions').length,0);
  second.resolve();await settle();written(b);assert.equal(document.activeElement,flag(b));assert.equal(flag(a).classList.contains('flag-on'),true);
});
test('較新正常GET已失敗時舊PUT晚確認不復活列表或覆蓋錯誤頁',async()=>{
  const a=rows[0].id,b=rows[1].id,d=defer();putWait=d;await start();putWait=null;reads.push(()=>json({error:'本題較新讀取失敗'},503));
  const second=flag(b);second.focus();second.click();await settle();written(b);const page=el('.subscriptions-page');assert.ok(el('#retrySubscriptions'));
  d.resolve();await settle();written(a);assert.equal(el('.subscriptions-page'),page);assert.ok(el('#retrySubscriptions'));assert.equal(puts().length,2);
  assert.equal(calls.filter(c=>c.path==='/api/subscriptions').length,1);
});
for(const state of ['empty','missing','duplicate'])test(`外部讀取${state}後舊確認不插回或猜列`,async()=>{
  const a=rows[0].id,d=defer();putWait=d;await start();putWait=null;
  reads.push(snap=>json(state==='empty'?[]:state==='missing'?snap.slice(1):[...snap,snap[0]]));
  await renderSubscriptions({showLoading:false});await settle();const page=el('.subscriptions-page'),buttons=[...document.querySelectorAll('[data-flag]')];
  d.resolve();await settle();written(a);assert.equal(el('.subscriptions-page'),page);assert.deepEqual([...document.querySelectorAll('[data-flag]')],buttons);
  if(state==='duplicate')assert.equal(buttons.filter(b=>b.dataset.flag===a).every(b=>!b.classList.contains('flag-on')),true);
  else assert.equal(flag(a),undefined);
});
test('既有校正遞迴仍保留通知與標記回焦，校正寫入另計',async()=>{
  const id=rows[0].id;reads.push(snap=>json(snap.map((r,i)=>i? r:{...r,status:'lifetime'})));
  await start();written(id);assert.equal(rows[0].cycle,'lifetime');assert.equal(document.activeElement,flag(id));assert.equal(puts().length,2);assert.equal(document.querySelectorAll('.subscriptions-notice').length,1);
});

test('穩定身分含引號時不用字串selector猜列',async()=>{
  rows[0].id=`${serial}-"[constructor]`;await renderSubscriptions({showLoading:false});await settle();const id=rows[0].id;await start();written(id);assert.equal(document.activeElement,flag(id));
});
test('舊父讀取過期後不把校正遞迴變成新的呈現擁有者',async()=>{
  const id=rows[0].id,d=defer();reads.push(async snap=>{await d.promise;return json(snap.map(r=>({...r,status:'lifetime'})));});
  await start();written(id);await renderSubscriptions({showLoading:false});const page=el('.subscriptions-page');el('#outside').focus();d.resolve();await settle();assert.equal(el('.subscriptions-page'),page);assert.equal(puts().length,1);assert.equal(document.activeElement,el('#outside'));
});
for(const cancel of [false,true])test(`焦點工作${cancel?'取消':'成功'}後收掉自己的document與window監聽`,async()=>{
  const active=new Map(),restore=[];
  for(const target of [document,window]){
    const add=target.addEventListener,remove=target.removeEventListener;
    target.addEventListener=function(type,fn,options){if(options===true){active.set(fn,(active.get(fn)||0)+1);}return add.call(this,type,fn,options);};
    target.removeEventListener=function(type,fn,options){if(options===true&&active.has(fn)){const count=active.get(fn)-1;if(count)active.set(fn,count);else active.delete(fn);}return remove.call(this,type,fn,options);};
    restore.push(()=>{target.addEventListener=add;target.removeEventListener=remove;});
  }
  try{const id=rows[0].id,d=defer();putWait=d;await start();assert.ok(active.size>0);if(cancel)el('#outside').focus();d.resolve();await settle();written(id);assert.equal(active.size,0);}finally{restore.forEach(r=>r());}
});

test('新窗世代開後撤銷，即使焦點未離原鈕也撤銷舊工作',async()=>{
  const id=rows[0].id,d=defer();putWait=d;await start();const own=app.claimModalRoot();own.release();d.resolve();await settle();written(id);assert.equal(document.activeElement,document.body);
});
for(const state of ['ending','ended'])test(`${state}列表同筆標記也只回本列`,async()=>{
  rows[0].status=state;rows[0].active=state!=='ended';rows[0].endsOn=state==='ending'?'2099-12-01':'2026-01-01';await renderSubscriptions({showLoading:false});await settle();const id=rows[0].id;await start();written(id);assert.equal(document.activeElement,flag(id));assert.equal(flag(id).closest('.tbl-wrap').dataset.listKey,state);
});

// Chromium 移除持焦節點會同步發出 blur，且會經 window 的 capture listener。
test('自身同步DOM替換的原鈕blur不誤當視窗失焦',async()=>{
  const id=rows[0].id;alterCommit(()=>{},()=>{const b=flag(id);assert.equal(document.activeElement,b);b.blur();});await start();written(id);assert.equal(document.activeElement,flag(id));
});
