import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { makeModalOwnership } from '../public/modules/modal-ownership.js';
import { createPortfolioReconciliationActions } from '../public/modules/portfolio-reconciliation-actions.js';
import { holdingsTableHtml } from '../public/modules/portfolio-tables.js';
import { esc } from '../public/modules/html-escape.js';

// 本檔由 node --test 的獨立檔案行程隔離；外殼與所有權載入真來源。
// app 的背景開機不在本題射程，鍵盤／回焦函式從當版 AST 取出，不抄第二份實作。
const appUrl = new URL('../public/app.js', import.meta.url).href;
const source = ts.createSourceFile('app.js', readFileSync(new URL(appUrl), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['bindBackdropClose', 'bindModalAccessibility', 'modalTitleSeq', 'MODAL_FOCUSABLE', 'modalReturnFocus', 'modalFocusOwner', 'modalReturnWatch', 'modalSizeClass', 'MODAL_SIZES']);
const declarations = source.statements.filter(node => ts.isFunctionDeclaration(node)
  ? names.has(node.name?.text)
  : ts.isVariableStatement(node) && node.declarationList.declarations.some(decl => names.has(decl.name.getText(source))));
assert.equal(declarations.length, names.size, '核對 app.js 的彈窗函式及 AST 選取，重跑 test/portfolio-reconciliation-actions.test.js');
const selectedSource = declarations.map(node => node.getText(source).replace(/^export /, '')).join('\n');
const helpers = new Function('document', 'window', 'MutationObserver', 'getComputedStyle', 'currentNavSeq', 'location', selectedSource+'\nreturn {bindBackdropClose,bindModalAccessibility,modalSizeClass};');
const globalNames=['window','document','MutationObserver','localStorage','Chart','__reconciliationTest'];
const saved = new Map(globalNames.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
const exported=['api','view','byId','esc','moneyCur','todayStr','parseLocalDate','openForm','openInfo','openPrintWindow','confirmDelete','toast','currentRouteSeq','watchModalRoot','claimModalRoot','modalSizeClass','bindBackdropClose','bindModalAccessibility'];
const hook=registerHooks({load(url,context,nextLoad){
  if(url===appUrl) return {format:'module',shortCircuit:true,source:exported.map(name=>`export const ${name}=(...args)=>globalThis.__reconciliationTest.${name}(...args);`).join('\n')};
  return nextLoad(url,context);
}});
const {openModalShell}=await import('../public/modules/modal-shell.js');
after(()=>{hook.deregister();for(const [name,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const reference={sourceLabel:'合成來源',scopeLabel:'合成範圍',date:'2024-02-29',symbol:'TEST',marketLabel:'合成掛牌',quantity:'0.3',unit:'股'};
const confirmations=['sameInstrument','sameScope','sameQuantityDefinition'];
const sample=(id='row')=>[{id,symbol:'TEST',name:'合成標的',currency:'USD',quantity:0.1,source:'manual',unrelated:{sentinel:'SYNTHETIC-PRESERVATION'}}];
function fixture(holdings=sample()) {
  const dom=new JSDOM('<main id="view"><button id="compareReferenceQuantity">參考數量比對</button></main><div id="modal-root"></div>',{url:'https://synthetic.invalid/#ib'});
  const {document}=dom.window;const root=document.getElementById('modal-root');
  let nav=1,route=1,current=true;const navigators=new Set(),mediaListeners=new Set(),observers=new Set();const apiCalls=[],storageWrites=[],watchGenerations=[];
  const ownership=makeModalOwnership({readGen:()=>Number(root.dataset.modalGen||0),writeGen:n=>{root.dataset.modalGen=String(n);},readNav:()=>nav});
  const media={matches:true,addEventListener:(type,fn)=>{assert.equal(type,'change');mediaListeners.add(fn);},removeEventListener:(type,fn)=>{assert.equal(type,'change');mediaListeners.delete(fn);}};
  const bindings=helpers(document,dom.window,dom.window.MutationObserver,dom.window.getComputedStyle.bind(dom.window),()=>nav,dom.window.location);
  const data={'/holdings':holdings,'/watchlist':[],'/research':[],'/settings':{},'/portfolioSnapshots':[],'/accounts':[],'/ibTrades':[],'/summary':{},'/cape':null,'/realyield':null};
  let holdRead=null;
  const unexpected=()=>{throw Error('核對比對入口不得呼叫寫入互動；重跑 test/portfolio-reconciliation-actions.test.js');};
  const app={...bindings,api:async(path,opts)=>{apiCalls.push([path,opts]);assert.equal(opts,undefined);assert.ok(Object.hasOwn(data,path));if(path==='/holdings'&&holdRead)return holdRead;return structuredClone(data[path]);},view:()=>document.getElementById('view'),byId:id=>document.getElementById(id),esc,moneyCur:(n,c)=>n+' '+c,todayStr:()=> '2026-10-20',parseLocalDate:s=>new Date(s),currentRouteSeq:()=>route,claimModalRoot:ownership,watchModalRoot:()=>{watchGenerations.push(Number(root.dataset.modalGen));return ownership.watch();},openForm:unexpected,openInfo:unexpected,openPrintWindow:unexpected,confirmDelete:unexpected,toast:unexpected};
  Object.assign(globalThis,{window:dom.window,document,MutationObserver:dom.window.MutationObserver,localStorage:{getItem:()=>null,setItem:(...args)=>storageWrites.push(args)},Chart:class{destroy(){}},__reconciliationTest:app});
  dom.window.matchMedia=()=>media;
  const deps={holdings,getElement:app.byId,escapeHtml:esc,openModalShell,watchModalRoot:app.watchModalRoot,isCurrentRender:()=>current,getMediaQuery:()=>media,onNavigate:fn=>{navigators.add(fn);return()=>navigators.delete(fn);},observeModal:(node,callback)=>{const o=new dom.window.MutationObserver(callback);observers.add(o);o.observe(node,{childList:true,subtree:true});return()=>{o.disconnect();observers.delete(o);};}};
  const actions=createPortfolioReconciliationActions(deps);
  const f={dom,document,root,holdings,app,actions,apiCalls,storageWrites,watchGenerations,navigators,mediaListeners,observers,media,open(){document.getElementById('compareReferenceQuantity').focus();document.getElementById('compareReferenceQuantity').click();return root.querySelector('form');},navigate(){nav++;route++;for(const fn of [...navigators])fn();dom.window.dispatchEvent(new dom.window.HashChangeEvent('hashchange'));},stale(){current=false;},narrow(){media.matches=false;for(const fn of [...mediaListeners])fn();},deferHoldings(){holdRead=new Promise(resolve=>{f.resolveHoldings=resolve;});},async close(){actions.dispose();root.innerHTML='';await flush();dom.window.close();}};
  return f;
}
function input(f,form,name,value){const element=form.elements.namedItem(name);assert.ok(element,name);if(element.type==='checkbox')element.checked=value;else element.value=value;element.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));}
function fill(f,form,id=f.holdings[0].id){input(f,form,'selectedId',id);for(const [key,value]of Object.entries(reference))input(f,form,key,value);for(const key of confirmations)input(f,form,key,true);}
function calculate(f,form){const event=new f.dom.window.Event('submit',{bubbles:true,cancelable:true});form.dispatchEvent(event);assert.equal(event.defaultPrevented,true);return form.querySelector('[data-reference-difference]')?.textContent;}

test('真外殼開啟後才取watch；明確選列、輸入與計算不改來源或持久狀態',async()=>{
  const f=fixture(sample('preserve'));const before=structuredClone(f.holdings),hash=f.dom.window.location.href;
  try{const form=f.open();assert.ok(form);assert.deepEqual(f.watchGenerations,[1]);assert.equal(form.elements.namedItem('selectedId').value,'');assert.equal(form.querySelector('[data-reference-difference]'),null);
    for(const name of Object.keys(reference))assert.equal(form.elements.namedItem(name).value,'');
    fill(f,form);assert.equal(calculate(f,form),'0.2');assert.deepEqual(f.holdings,before);assert.deepEqual(f.apiCalls,[]);assert.deepEqual(f.storageWrites,[]);assert.equal(f.dom.window.location.href,hash);assert.doesNotMatch(f.root.textContent,/SYNTHETIC-PRESERVATION/);
    f.holdings[0].quantity=0.9;f.holdings.push({...f.holdings[0]});assert.equal(calculate(f,form),'0.2');
  }finally{await f.close();}
});

test('改輸入清舊差額；身分改動撤確認，修改數量保留確認及焦點',async()=>{
  const f=fixture();try{const form=f.open();fill(f,form);assert.equal(calculate(f,form),'0.2');const quantity=form.elements.namedItem('quantity');quantity.focus();input(f,form,'quantity','0.6');assert.equal(form.querySelector('output'),null);assert.equal(f.document.activeElement,quantity);assert.equal(form.elements.namedItem('sameScope').checked,true);assert.equal(calculate(f,form),'0.5');
    input(f,form,'scopeLabel','新範圍');assert.equal(form.querySelector('output'),null);for(const key of confirmations)assert.equal(form.elements.namedItem(key).checked,false);assert.equal(calculate(f,form),undefined);assert.match(form.textContent,/尚未手動確認/);
    for(const key of confirmations)input(f,form,key,true);assert.equal(calculate(f,form),'0.5');input(f,form,'sameScope',false);assert.equal(form.querySelector('output'),null);
  }finally{await f.close();}
});

test('送出重讀未發input的值，身分變動不能沿用勾選',async()=>{
  const f=fixture();try{const form=f.open();fill(f,form);assert.equal(calculate(f,form),'0.2');form.elements.namedItem('quantity').value='0.6';assert.equal(calculate(f,form),'0.5');form.elements.namedItem('scopeLabel').value='未發事件的新範圍';assert.equal(calculate(f,form),undefined);for(const key of confirmations)assert.equal(form.elements.namedItem(key).checked,false);
  }finally{await f.close();}
});

for(const method of ['button','x','escape','backdrop','navigate','narrow','dispose'])test('關閉與失效解除本窗訂閱｜'+method,async()=>{
  const f=fixture();try{const form=f.open();fill(f,form);assert.equal(calculate(f,form),'0.2');await flush();assert.equal(f.navigators.size,1);assert.equal(f.mediaListeners.size,1);assert.equal(f.observers.size,1);
    if(method==='button')form.querySelector('[data-reference-close]').click();
    if(method==='x')f.root.querySelector('.x-close').click();
    if(method==='escape')f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    if(method==='backdrop'){const bg=f.root.querySelector('.modal-bg');for(const name of ['mousedown','mouseup','click'])bg.dispatchEvent(new f.dom.window.MouseEvent(name,{bubbles:true}));}
    if(method==='navigate')f.navigate();if(method==='narrow')f.narrow();if(method==='dispose')f.actions.dispose();
    await flush();assert.equal(f.root.children.length,0);assert.equal(f.navigators.size,0);assert.equal(f.mediaListeners.size,0);assert.equal(f.observers.size,0);
    form.elements.namedItem('quantity').value='9';form.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));assert.equal(f.root.children.length,0);
    if(['button','x','escape','backdrop'].includes(method))assert.equal(f.document.activeElement,f.document.getElementById('compareReferenceQuantity'));
  }finally{await f.close();}
});

test('新窗接管與舊事件同回合：舊close與dispose不清新窗',async()=>{
  const f=fixture();try{const form=f.open();fill(f,form);assert.equal(calculate(f,form),'0.2');openModalShell({title:'另一窗',bodyHtml:'<input id="new-value" value="保存新窗">'});const dialog=f.root.querySelector('.modal'),generation=f.root.dataset.modalGen;input(f,form,'quantity','9');form.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));f.actions.dispose();await flush();assert.equal(f.root.querySelector('.modal'),dialog);assert.equal(f.document.getElementById('new-value').value,'保存新窗');assert.equal(f.root.dataset.modalGen,generation);assert.equal(f.navigators.size,0);
  }finally{await f.close();}
});

test('同窗form或結果節點被換代，舊事件不寫新節點',async()=>{
  for(const target of ['form','result']){const f=fixture();try{const form=f.open();fill(f,form);assert.equal(calculate(f,form),'0.2');const old=target==='form'?form:form.querySelector('[data-reference-result]');const fresh=old.cloneNode(true);fresh.setAttribute('data-sentinel','fresh');old.replaceWith(fresh);input(f,form,'quantity','9');await flush();assert.equal(f.root.children.length,0);assert.equal(fresh.getAttribute('data-sentinel'),'fresh');assert.doesNotMatch(fresh.textContent,/8\.9/);}finally{await f.close();}}
});

test('過期頁面與窄版不開窗；空資料及異常快照不自選或崩潰',async()=>{
  for(const mode of ['narrow','stale','empty','invalid']){const f=fixture(mode==='empty'?[]:mode==='invalid'?[null]:sample());try{if(mode==='narrow')f.media.matches=false;if(mode==='stale')f.stale();const form=f.open();if(mode==='narrow'||mode==='stale')assert.equal(f.root.children.length,0);if(mode==='empty'){assert.ok(form);assert.equal(form.elements.namedItem('selectedId').options.length,1);assert.equal(calculate(f,form),undefined);}if(mode==='invalid'){assert.equal(form,null);assert.match(f.root.textContent,/資料形狀無法判讀/);f.navigate();assert.equal(f.root.children.length,0);}}finally{await f.close();}}
});

test('頁面或入口失效當下的舊事件不能保留差額',async()=>{
  for(const mode of ['stale','detached']){const f=fixture();try{const form=f.open();fill(f,form);assert.equal(calculate(f,form),'0.2');if(mode==='stale')f.stale();else f.document.getElementById('compareReferenceQuantity').remove();input(f,form,'quantity','9');assert.equal(f.root.children.length,0);await flush();assert.equal(f.observers.size,0);assert.deepEqual(f.storageWrites,[]);}finally{await f.close();}}
});

test('本窗未知欄位拒收後撤銷輸入與舊差額',async()=>{
  const f=fixture();try{const form=f.open();fill(f,form);assert.equal(calculate(f,form),'0.2');const rogue=f.document.createElement('input');rogue.name='unknown';rogue.value='不接受';form.append(rogue);rogue.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await flush();assert.equal(f.root.children.length,0);assert.equal(f.navigators.size,0);assert.equal(f.mediaListeners.size,0);assert.equal(f.observers.size,0);assert.deepEqual(f.storageWrites,[]);}finally{await f.close();}
});

test('入口與CSS限桌面，預設display none且不改表格欄位',async()=>{
  const f=fixture();try{const html=holdingsTableHtml([],0,{sortKey:'value',sortDir:'desc',formatters:{escapeHtml:esc,formatMoney:String,formatPercent:String}});f.document.getElementById('view').innerHTML=html;const entry=f.document.getElementById('compareReferenceQuantity');assert.equal(entry.type,'button');assert.equal(entry.closest('.portfolio-reconciliation-entry').children.length,1);const style=f.document.createElement('style');style.textContent=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');f.document.head.append(style);assert.ok(style.sheet);const found=[];function visit(rules,media=''){for(const rule of rules){if(rule.selectorText?.includes('.portfolio-reconciliation-entry'))found.push([rule.selectorText,media,rule.style.getPropertyValue('display')]);if(rule.cssRules)visit(rule.cssRules,rule.conditionText||media);}}visit(style.sheet.cssRules);assert.deepEqual(found,[['.portfolio-reconciliation-entry','','none'],['.portfolio-reconciliation-entry','screen and (min-width: 901px)','block']]);assert.equal(entry.parentElement.style.display,'');}finally{await f.close();}
});

test('真正portfolio render在新讀取完成前dispose舊窗，重開使用本輪新資料',async()=>{
  const f=fixture();try{const {renderPortfolio}=await import('../public/modules/portfolio.js');await renderPortfolio();await flush();const form=f.open();fill(f,form);assert.equal(calculate(f,form),'0.2');const beforeCalls=f.apiCalls.length;input(f,form,'quantity','0.6');assert.equal(calculate(f,form),'0.5');assert.equal(f.apiCalls.length,beforeCalls);assert.deepEqual(f.storageWrites,[]);
    f.deferHoldings();const redraw=renderPortfolio();assert.equal(f.root.children.length,0);f.resolveHoldings(sample('new-row'));await redraw;await flush();const next=f.open();assert.notEqual(next,form);assert.equal(next.elements.namedItem('selectedId').value,'');fill(f,next,'new-row');assert.equal(calculate(f,next),'0.2');input(f,form,'quantity','8');assert.equal(next.querySelector('output').textContent,'0.2');assert.deepEqual(f.storageWrites,[]);
    f.navigate();await flush();assert.equal(f.root.children.length,0);
  }finally{await f.close();}
});
