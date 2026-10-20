import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { bindDividendActions } from '../public/modules/portfolio-dividend-actions.js';
import { dividendActivityHtml } from '../public/modules/portfolio-activity.js';

const incomeSample = () => ({periodBasis:'ib-flex-single-statement-v1',from:'20260115',to:'20260320',dividends:12.5,paymentInLieu:0,count:1,skippedNoFx:0,skippedNoCurrency:0,estimatedNoFx:0});
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function page(income=incomeSample()) {
  const dom=new JSDOM('<main>'+dividendActivityHtml({ib:{income}},{escapeHtml,formatCurrency:(n,c)=>Math.round(n)+' '+c})+'</main>');
  const document=dom.window.document;
  let current=true;
  bindDividendActions({income,getElement:id=>document.getElementById(id),isCurrentRender:()=>current});
  return {dom,document,input:document.querySelector('input'),output:document.querySelector('output'),stale:()=>{current=false;}};
}
function inputPrice(p,text) {
  p.input.value=text;
  p.input.dispatchEvent(new p.dom.window.Event('input',{bubbles:true}));
}

test('配息輸入｜輸入、表單送出、清空與失效值都走真 DOM 事件', () => {
  const p=page();
  try {
    assert.match(p.output.textContent,/請輸入/);
    inputPrice(p,'2');assert.equal(p.output.textContent,'約 6.25 參考單位');
    p.input.value='5';
    const event=new p.dom.window.Event('submit',{bubbles:true,cancelable:true});
    p.document.querySelector('form').dispatchEvent(event);
    assert.equal(event.defaultPrevented,true);
    assert.equal(p.output.textContent,'約 2.5 參考單位');
    inputPrice(p,'2USD');assert.match(p.output.textContent,/完整十進位/);assert.doesNotMatch(p.output.textContent,/2\.5|6\.25/);
    inputPrice(p,'2');p.document.querySelector('[data-dividend-clear]').click();
    assert.equal(p.input.value,'');assert.match(p.output.textContent,/請輸入/);assert.equal(p.document.activeElement,p.input);
    assert.equal(p.input.getAttribute('autocomplete'),'off');
    assert.equal(p.document.querySelector('label').htmlFor,p.input.id);
    assert.equal(p.output.getAttribute('aria-live'),'polite');
  } finally {p.dom.window.close();}
});

test('配息輸入｜固定本輪收入快照；有效結果變下溢時清掉舊數字', () => {
  const income={...incomeSample(),dividends:Number.MIN_VALUE};
  const p=page(income);
  try {
    income.dividends=12.5;
    inputPrice(p,'1');assert.equal(p.output.textContent,'約 5e−324 參考單位');
    inputPrice(p,'2');assert.equal(p.output.textContent,'數值超出可表示範圍，無法換算。');
    assert.doesNotMatch(p.output.textContent,/參考單位/);
  } finally {p.dom.window.close();}
});

test('配息輸入｜離頁或同 ID 節點換代後，舊輸入與清空不再改動任何畫面', () => {
  for(const invalidation of ['route','node']) {
    const p=page();
    try {
      inputPrice(p,'2');
      if(invalidation==='route') p.stale();
      else {
        const old=p.document.getElementById('dividendEquivalence');
        old.replaceWith(old.cloneNode(true));
      }
      inputPrice(p,'5');
      p.input.closest('form').querySelector('[data-dividend-clear]').click();
      assert.equal(p.input.value,'5');
      assert.equal(p.output.textContent,'約 6.25 參考單位');
      assert.equal(p.document.querySelector('output').textContent,'約 6.25 參考單位');
    } finally {p.dom.window.close();}
  }
});

test('配息輸入｜品質不完整只顯示原因，文字輸入不會變成 HTML', () => {
  const p=page({...incomeSample(),skippedNoCurrency:1});
  try {
    inputPrice(p,'2');assert.match(p.output.textContent,/缺少幣別/);assert.doesNotMatch(p.output.textContent,/參考單位/);
    inputPrice(p,'<img src=x onerror=alert(1)>');assert.equal(p.document.querySelector('img'),null);
  } finally {p.dom.window.close();}
});

test('配息桌面範圍｜整塊預設隱藏，只由 screen 901px 規則顯示，無行內 display', () => {
  const p=page();
  try {
    const style=p.document.createElement('style');
    style.textContent=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');
    p.document.head.append(style);
    assert.ok(style.sheet,'樣式必須成功解析才檢查規則');
    const found=[];
    function visit(rules,media='') {
      for(const rule of rules) {
        if(rule.selectorText?.includes('.portfolio-dividend-equivalence')) found.push({selector:rule.selectorText,media,display:rule.style.getPropertyValue('display')});
        if(rule.cssRules) visit(rule.cssRules,rule.conditionText || media);
      }
    }
    visit(style.sheet.cssRules);
    assert.deepEqual(found,[
      {selector:'.portfolio-dividend-equivalence',media:'',display:'none'},
      {selector:'.portfolio-dividend-equivalence',media:'screen and (min-width: 901px)',display:'block'}
    ]);
    const panel=p.document.getElementById('dividendEquivalence');
    assert.equal(panel.style.display,'');
    for(const node of p.document.querySelectorAll('h3,form,label,input,button,output,#dividendExplanation'))assert.equal(node.closest('.portfolio-dividend-equivalence'),panel);
  } finally {p.dom.window.close();}
});

test('投資頁真接線｜渲染與換代都綁上換算，本次輸入不觸發 API 或保存', async () => {
  // 以模組載入鉤子替換 app 邊界，portfolio.js 及其換算、DOM 控制器仍載入實體來源。
  // 這是合成 DOM 接線題，不驗原生排版、Tab 順序或跨瀏覽器採用。
  const dom=new JSDOM('<main id="view"></main>');
  const names=['window','document','localStorage','Chart','__dividendPageTest'];
  const saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const calls=[],formatCalls=[],storageWrites=[];
  let route=1;
  const data={'/holdings':[],'/watchlist':[],'/research':[],'/settings':{ib:{income:incomeSample()}},'/portfolioSnapshots':[],'/accounts':[],'/ibTrades':[],'/summary':{},'/cape':null,'/realyield':null};
  const unexpected=()=>{throw Error('不應呼叫互動副作用');};
  Object.assign(globalThis,{
    window:dom.window,document:dom.window.document,
    localStorage:{getItem:()=>null,setItem:(...args)=>storageWrites.push(args)},
    Chart:class {destroy(){}},
    __dividendPageTest:{
      api:async(path,opts)=>{calls.push([path,opts]);assert.ok(Object.hasOwn(data,path),path);return structuredClone(data[path]);},
      view:()=>dom.window.document.getElementById('view'),byId:id=>dom.window.document.getElementById(id),esc:escapeHtml,
      moneyCur:(n,c)=>{formatCalls.push([n,c]);return Math.round(n)+' '+c;},
      todayStr:()=> '2026-10-20',parseLocalDate:s=>new Date(s),currentRouteSeq:()=>route,
      watchModalRoot:()=>{throw Error('配息題不應開比對窗；核對 portfolio.js 接線，重跑 test/portfolio-dividend-actions.test.js');},
      openForm:unexpected,openInfo:unexpected,openPrintWindow:unexpected,confirmDelete:unexpected,toast:unexpected
    }
  });
  const appUrl=new URL('../public/app.js',import.meta.url).href;
  const shellUrl=new URL('../public/modules/modal-shell.js',import.meta.url).href;
  const hook=registerHooks({load(url,context,nextLoad){
    if(url===shellUrl) return {format:'module',shortCircuit:true,source:"export const openModalShell=()=>{throw Error('配息題不應開比對窗；核對 portfolio.js 接線，重跑 test/portfolio-dividend-actions.test.js');};"};
    if(url===appUrl) return {format:'module',shortCircuit:true,source:'export const {api,view,byId,esc,moneyCur,todayStr,parseLocalDate,openForm,openInfo,openPrintWindow,confirmDelete,toast,currentRouteSeq,watchModalRoot}=globalThis.__dividendPageTest;'};
    return nextLoad(url,context);
  }});
  try {
    const {renderPortfolio}=await import('../public/modules/portfolio.js');
    await renderPortfolio();await new Promise(resolve=>setImmediate(resolve));
    const document=dom.window.document;
    const first={dom,input:document.querySelector('#dividendReferencePrice')};
    const firstOutput=document.querySelector('#dividendEquivalence output');
    assert.ok(first.input);const priorCalls=calls.length;
    inputPrice(first,'2');assert.equal(firstOutput.textContent,'約 6.25 參考單位');
    assert.equal(calls.length,priorCalls);assert.deepEqual(storageWrites,[]);
    assert.deepEqual(formatCalls,[[12.5,'USD']]);
    await renderPortfolio();await new Promise(resolve=>setImmediate(resolve));
    const secondInput=document.querySelector('#dividendReferencePrice');
    const secondOutput=document.querySelector('#dividendEquivalence output');
    assert.notEqual(secondInput,first.input);assert.equal(secondInput.value,'');assert.match(secondOutput.textContent,/請輸入/);
    inputPrice(first,'5');assert.equal(firstOutput.textContent,'約 6.25 參考單位');assert.match(secondOutput.textContent,/請輸入/);
    inputPrice({dom,input:secondInput},'2');assert.equal(secondOutput.textContent,'約 6.25 參考單位');
    route++;
    inputPrice({dom,input:secondInput},'5');assert.equal(secondOutput.textContent,'約 6.25 參考單位');
    assert.ok(calls.every(([,options])=>options===undefined));assert.deepEqual(storageWrites,[]);
  } finally {
    hook.deregister();dom.window.close();
    for(const [name,descriptor] of saved) {
      if(descriptor) Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  }
});
