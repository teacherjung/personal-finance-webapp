import test from 'node:test';
import assert from 'node:assert/strict';
import {createReferenceView} from '../public/modules/portfolio-reconciliation-view.js';
import {snapshotHoldings} from '../public/modules/portfolio-reconciliation.js';
import {createReferenceComparison} from '../public/modules/portfolio-reconciliation.js';
import {isRealDate} from '../public/modules/calendar-date.js';
import {normalizePortfolioSymbol} from '../public/modules/portfolio-symbol.js';
import {esc} from '../public/modules/html-escape.js';

const compare = createReferenceComparison({isRealDate, normalizePortfolioSymbol});
const view = createReferenceView({escapeHtml:esc});
const hint = '核對 public/modules/portfolio-reconciliation-view.js 的 initialForm／resultHtml；重跑 node --test test/portfolio-reconciliation-view.test.js';
function fresh(id) {
  return {
    holdings:[{id,symbol:'TEST',name:'合成標的',quantity:0.1,currency:'USD',source:'manual'}],selectedId:id,
    reference:{sourceLabel:'合成來源',scopeLabel:'合成範圍',marketLabel:'合成掛牌',date:'2024-02-29',symbol:'TEST',quantity:'0.3',unit:'股'},
    confirmations:{sameInstrument:true,sameScope:true,sameQuantityDefinition:true},
  };
}
// The test composes real pure models; it is not product controller wiring.
function bundle(input) {
  const snapshot=snapshotHoldings(input.holdings);assert.equal(snapshot.ok,true,hint);
  const comparison=compare({...input,holdings:snapshot.rows});
  const rows=snapshot.rows.filter(row=>row.id===input.selectedId);
  return {comparison,reference:input.reference,selected:rows.length===1?rows[0]:undefined};
}
test('初始空欄與確認未預勾',()=>{
  const input=fresh('initial');const html=view.initialForm(snapshotHoldings(input.holdings).rows);
  assert.ok(html.includes('<option value="" selected>請選取一筆</option>'),hint);
  assert.ok(html.includes('<option value="" selected>未確認</option>'),hint);
  assert.equal((html.match(/type="text" value=""/g)||[]).length,6,hint);
  assert.equal((html.match(/type="checkbox"/g)||[]).length,3,hint);
  assert.doesNotMatch(html,/\bchecked\b/,hint);
});
for(const [name,app,ref,expected] of [['正小數',0.1,'0.3','0.2'],['負小數',0.3,'0.1','−0.2'],['明確零',0,'0','0'],['完整大數',-1000000000,'1000000000','2000000000'],['六位精度',0.000001,'1.000002','1.000001']]) {
  test('有效差額呈現｜'+name,()=>{
    const input=fresh(name);input.holdings[0].quantity=app;input.reference.quantity=ref;
    const data=bundle(input);assert.equal(data.comparison.kind,'difference',hint);
    const html=view.resultHtml(data);
    assert.ok(html.includes('<output data-reference-difference>'+expected+'</output>'),hint);
    assert.ok(html.includes('參考數量 − App 紀錄數量'),hint);
    assert.ok(html.includes('數量單位：股'),hint);
    assert.ok(html.includes('尚未建立帳戶或部位核對結果'),hint);
    assert.doesNotMatch(html,/獲利|損失|已對平|無漏記|已出清|建議買|建議賣|class="(?:positive|negative)/,hint);
  });
}
test('零差額不冒稱對平',()=>{
  const input=fresh('zero');input.reference.quantity='0.1';const html=view.resultHtml(bundle(input));
  assert.ok(html.includes('<output data-reference-difference>0</output>'),hint);
  assert.ok(html.includes('兩個輸入數量相減為 0。'),hint);
  assert.doesNotMatch(html,/已對平|相符|無漏記|已出清|核對通過/,hint);
});
for(const [name,change,reason] of [
  ['缺量',i=>{delete i.holdings[0].quantity;},'數量缺漏、格式或精度超出本工具範圍'],
  ['超精度',i=>{i.reference.quantity='0.1234567';},'數量缺漏、格式或精度超出本工具範圍'],
  ['來源',i=>{i.reference.sourceLabel='';},'請填寫參考資料的來源名稱'],
  ['範圍',i=>{i.reference.scopeLabel='';},'請填寫帳戶或比較範圍的別名'],
  ['掛牌',i=>{i.reference.marketLabel='';},'請填寫市場或掛牌描述'],
  ['日期',i=>{i.reference.date='2024-02-30';},'請填寫有效的參考基準日'],
  ['單位',i=>{i.reference.unit='';},'請確認數量單位為股或單位'],
  ['證券未確認',i=>{i.confirmations.sameInstrument=false;},'尚未手動確認同一證券與掛牌身分'],
  ['範圍未確認',i=>{i.confirmations.sameScope=false;},'尚未手動確認這筆 App 紀錄正是要比較的範圍'],
  ['定義未確認',i=>{i.confirmations.sameQuantityDefinition=false;},'尚未手動確認數量定義、正負號與單位相同'],
]) {
  test('單一缺項只並列｜'+name,()=>{
    const input=fresh(name);change(input);const data=bundle(input);assert.equal(data.comparison.kind,'parallel',hint);
    const html=view.resultHtml(data);assert.ok(html.includes(reason),hint);
    assert.ok(html.includes('僅並列數量，尚不能計算差額'),hint);
    assert.doesNotMatch(html,/<output\b/,hint);
    if(name==='缺量')assert.ok(html.includes('App 紀錄數量：未記錄／無法判讀'),hint);
  });
}
test('參考日期與未知App日期各自標明',()=>{
  const input=fresh('dates');input.holdings[0].lastSync='2025-01-01';
  const html=view.resultHtml(bundle(input));
  assert.ok(html.includes('參考基準日（手動輸入）：2024-02-29'),hint);
  assert.ok(html.includes('App：本頁已載入的一筆紀錄；部位基準日未記錄。'),hint);
  assert.doesNotMatch(html,/2025-01-01|兩邊日期不同|App 部位日：2024-02-29/,hint);
});
test('原來源標記不推導券商帳戶',()=>{
  const input=fresh('source');input.holdings[0].source='ib';const html=view.resultHtml(bundle(input));
  assert.ok(html.includes('參考來源（手動輸入）：合成來源'),hint);
  assert.ok(html.includes('App 原來源標記：ib；原標記不是帳戶、市場或同日部位的查證'),hint);
  assert.doesNotMatch(html,/已查證|券商認證|同步成功/,hint);
});
test('文字輸出逐落點跳脫',()=>{
  const input=fresh('text');const attack='<tag>&"\'';const escaped='&lt;tag&gt;&amp;&quot;&#39;';
  input.reference.sourceLabel=attack;input.reference.scopeLabel=attack;input.reference.marketLabel=attack;
  input.holdings[0].source=attack;const html=view.resultHtml(bundle(input));
  for(const label of ['參考來源（手動輸入）：','比較範圍別名（手動輸入）：','市場／掛牌描述（手動輸入）：','App 原來源標記：'])assert.ok(html.includes(label+escaped),hint);
  assert.ok(!html.includes(attack),hint);
  input.reference.quantity=attack;input.reference.date=attack;const parallel=view.resultHtml(bundle(input));
  assert.ok(parallel.includes('參考數量：'+escaped),hint);assert.ok(parallel.includes('參考基準日（手動輸入）：'+escaped),hint);
});
test('選項屬性及可見文字各自跳脫',()=>{
  const input=fresh('attribute');const attack='<tag>&"\'';input.holdings[0]={...input.holdings[0],id:attack,symbol:attack,name:attack,currency:attack};
  const html=view.initialForm(snapshotHoldings(input.holdings).rows);const escaped='&lt;tag&gt;&amp;&quot;&#39;';
  assert.ok(html.includes('<option value="'+escaped+'">'),hint);
  assert.ok(html.includes('>'+escaped+'｜'+escaped+'｜0.1｜'+escaped+'</option>'),hint);
  assert.ok(!html.includes(attack),hint);
});
test('重複id與同代號保留列序而不自選',()=>{
  const input=fresh('duplicate');input.holdings.push({...input.holdings[0],name:'第二列',quantity:7});
  const snap=snapshotHoldings(input.holdings);const html=view.initialForm(snap.rows);
  assert.equal((html.match(/value="duplicate"/g)||[]).length,2,hint);
  assert.ok(html.indexOf('合成標的')<html.indexOf('第二列'),hint);
  assert.equal((html.match(/\bselected\b/g)||[]).length,2,hint);
  const result=view.resultHtml(bundle(input));assert.doesNotMatch(result,/<output\b/,hint);
  assert.ok(result.includes('身分重複'),hint);
});
test('未知原因與壞結果不升為差額',()=>{
  const input=fresh('bad');const data=bundle(input);
  const proto=view.resultHtml({...data,comparison:{...data.comparison,kind:'parallel',reasons:['toString']}});
  assert.ok(proto.includes('無法判讀比對條件，請檢查輸入。'),hint);assert.doesNotMatch(proto,/<output\b/,hint);
  for(const comparison of [null,{}, {...data.comparison,kind:'parallel'}, {...data.comparison,difference:{text:'<script>',scaled:0}}, {...data.comparison,difference:{text:'0',scaled:NaN}}]) {
    const html=view.resultHtml({...data,comparison});assert.doesNotMatch(html,/<output\b/,hint);assert.ok(html.includes('請檢查輸入'),hint);
  }
});
test('無關敏感哨兵不進呈現',()=>{
  const input=fresh('private');input.holdings[0].pdfPassword='SYNTHETIC-NOT-A-SECRET';input.reference.accountNumber='SYNTHETIC-ACCOUNT';
  const data=bundle(input);const html=view.initialForm(snapshotHoldings(input.holdings).rows)+view.resultHtml(data);
  assert.doesNotMatch(html,/SYNTHETIC-NOT-A-SECRET|SYNTHETIC-ACCOUNT|pdfPassword|accountNumber/,hint);
});
test('真正呈現後輸入保存且未被凍結',()=>{
  const input=fresh('preserve');const data=bundle(input);const rows=structuredClone(input.holdings);const before=structuredClone({data,rows});
  const a=view.initialForm(rows)+view.resultHtml(data);const b=view.initialForm(rows)+view.resultHtml(data);
  assert.equal(a,b,hint);assert.deepEqual({data,rows},before,hint);
  assert.equal(Object.isFrozen(data.reference),false,hint);assert.equal(Object.isFrozen(rows),false,hint);assert.equal(Object.isFrozen(rows[0]),false,hint);
  data.reference.scopeLabel='改後範圍';rows[0].quantity=8;rows.push({id:'extra'});
  assert.equal(data.reference.scopeLabel,'改後範圍',hint);assert.equal(rows[0].quantity,8,hint);assert.equal(rows.length,2,hint);
});
test('沒有跳脫工具就明確拒絕',()=>{
  assert.throws(()=>createReferenceView(),/escapeHtml is required/,hint);
  assert.throws(()=>createReferenceView({escapeHtml:null}),/escapeHtml is required/,hint);
});
