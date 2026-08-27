// @ts-check
// 匯入預覽「對帳驗算」就地說明的考題（P0 前端子項）：純函式吃裁決回 HTML，
// 銀行/信用卡兩頁共用同一份翻譯——這裡鎖住句意、計數、跳脫與「裁決缺席＝不長東西」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateSummaryHtml, totalsCheckSentence } from '../public/modules/reconcile-summary.js';
import { TOTALS_CHECK, TOTALS_FIELDS } from '../lib/statement-reconcile.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 去註解掃描器（堆疊式；字串／樣板字串裡的 `//` 不算註解）。
 * 與 contract-split.test.js／cashflow-bank-upload.test.js 同源——本 repo 的考題**不共用 helper 檔**
 * （test/ 底下任何 .js 都會被 node --test 當考題跑），所以這裡是刻意的區域副本。
 * 為什麼需要：AGENTS 硬規則「掃原始碼的形狀考題要先去掉註解」——註解常逐字引用舊程式碼。
 * @param {string} src
 */
function stripComments(src) {
  let out = ''; let prev = '';
  /** @type {string[]} */ const stack = ['code'];
  /** @type {number[]} */ const interp = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]; const nx = src[i + 1];
    const st = stack[stack.length - 1];
    if (st === 'code' || st === 'interp') {
      if (c === '/' && nx === '/' && prev !== '\\') { stack.push('line'); prev = ''; i++; continue; }
      if (c === '/' && nx === '*' && prev !== '\\') { stack.push('block'); prev = ''; i++; continue; }
      if (c === '\'') stack.push('s1');
      else if (c === '"') stack.push('s2');
      else if (c === '`') stack.push('tpl');
      else if (st === 'interp') {
        if (c === '{') interp[interp.length - 1]++;
        else if (c === '}') {
          if (interp[interp.length - 1] === 0) { stack.pop(); interp.pop(); out += c; prev = c; continue; }
          interp[interp.length - 1]--;
        }
      }
      out += c; prev = c;
    } else if (st === 'line') {
      if (c === '\n') { stack.pop(); out += c; prev = ''; }
    } else if (st === 'block') {
      if (c === '*' && nx === '/') { stack.pop(); i++; prev = ''; }
      else if (c === '\n') out += c;
    } else if (st === 's1' || st === 's2' || st === 'tpl') {
      out += c;
      if (c === '\\' && prev !== '\\') { prev = c; continue; }
      if ((st === 's1' && c === '\'') || (st === 's2' && c === '"') || (st === 'tpl' && c === '`')) { if (prev !== '\\') stack.pop(); }
      else if (st === 'tpl' && c === '$' && nx === '{') { stack.push('interp'); interp.push(0); out += '{'; i++; }
      prev = prev === '\\' && c === '\\' ? '' : c;
    }
  }
  return out;
}

test('銀行｜驗算通過：講出驗了幾關、期末吻合幾戶、外幣跳過幾筆（數字來自裁決 stats）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [],
    stats: { pairsChecked: 29, endChecked: 4, foreignRowsSkipped: 2 } }, 'bank');
  assert.match(h, /✓ 帳單數學驗算通過/);
  assert.match(h, /逐筆餘額 29 關全部接上/);
  assert.match(h, /4 個帳戶期末與帳單概要吻合/);
  assert.match(h, /外幣明細 2 筆不驗算（也不會匯入）/);
});

test('銀行｜沒驗到期末/沒有外幣＝那兩句不出現（不可硬湊「0 個帳戶」這種句子）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [], stats: { pairsChecked: 3, endChecked: 0, foreignRowsSkipped: 0 } }, 'bank');
  assert.match(h, /逐筆餘額 3 關/);
  assert.doesNotMatch(h, /期末/);
  assert.doesNotMatch(h, /外幣/);
});

test('銀行｜弱＝講「沒讀到」不講「帳單沒有」；匯入範圍照實講「全部非重複台幣明細」（r1#1＋r2#1）', () => {
  // r2#1：預覽是抽樣時，「只會匯入列出的」是錯的承諾——會讓使用者把「未顯示」誤解成「不匯入」。
  const h = gateSummaryHtml({ level: 'weak', advisories: [], stats: {} }, 'bank');
  assert.match(h, /△ 沒讀到足夠的餘額數字可驗算/);
  assert.match(h, /全部非重複台幣明細/);
  assert.match(h, /僅預覽前 12 筆/);
  assert.match(h, /核對筆數與金額/);
  assert.doesNotMatch(h, /帳單沒有/, '不可把降級講成帳單的鍋');
  assert.doesNotMatch(h, /只會匯入上面列出/, '不可暗示「沒顯示＝不匯入」');
});

test('銀行｜只驗到期末（餘額鏈 0 對）＝不可出現「逐筆餘額 0 關全部接上」（r1#2）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [], stats: { pairsChecked: 0, endChecked: 2 } }, 'bank');
  assert.match(h, /✓ 帳單數學驗算通過/);
  assert.match(h, /2 個帳戶期末與帳單概要吻合/);
  assert.doesNotMatch(h, /0 關/, '驗到哪關講哪關，不可湊句');
});

test('不認得的 level＝形狀不對＝空字串（r1#3：level:bogus 不可誤套弱級句）', () => {
  assert.equal(gateSummaryHtml(/** @type {any} */ ({ level: 'bogus', advisories: [], stats: {} }), 'bank'), '');
  assert.equal(gateSummaryHtml(/** @type {any} */ ({ level: 'strong', advisories: [], stats: {} }), 'card'), '',
    'strong 不是卡片畫面的合法級別——後端形狀變動時寧可不顯示');
});

test('信用卡｜摘要驗算通過＝講等式本人；零提醒＝不長清單', () => {
  const h = gateSummaryHtml({ level: 'medium', advisories: [], stats: {} }, 'card');
  assert.match(h, /✓ 帳單摘要驗算通過/);
  assert.match(h, /上期應繳 − 已繳款 ＋ 本期新增 ＝ 本期應繳/);
  assert.doesNotMatch(h, /<ul/);
});

test('信用卡｜影子提醒原文列出、不擋匯入；訊息內容一律跳脫（advisory 文字進 HTML 的唯一通道）', () => {
  const h = gateSummaryHtml({ level: 'medium', stats: {},
    advisories: [{ message: '差 100——可能漏讀' }, { message: '<img src=x onerror=alert(1)>' }] }, 'card');
  assert.match(h, /⚠ 差 100——可能漏讀/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/, '惡意字串要以跳脫後的樣子出現');
  assert.doesNotMatch(h, /<img/, '不可有未跳脫的原始標籤');
});

test('信用卡｜弱＝講「沒讀到」、XLSX 只當例子；匯入承諾限縮在「讀到且勾選」（r1#1）', () => {
  const h = gateSummaryHtml({ level: 'weak', advisories: [], stats: {} }, 'card');
  assert.match(h, /△ 沒讀到可交叉驗算的總額/);
  assert.match(h, /例如官網下載的 XLSX/, '不可斷言這份就是 XLSX——裁決裡看不出檔案格式');
  assert.match(h, /只會匯入下面讀到且勾選的明細/);
  assert.match(h, /核對筆數與金額/);
});

test('裁決缺席/形狀不對＝回空字串（舊回應/降級時畫面不多長東西、不炸）', () => {
  assert.equal(gateSummaryHtml(null, 'bank'), '');
  assert.equal(gateSummaryHtml(undefined, 'card'), '');
  assert.equal(gateSummaryHtml(/** @type {any} */ ({}), 'bank'), '', '沒有 level＝不認得的形狀');
  assert.equal(gateSummaryHtml(/** @type {any} */ ('strong'), 'card'), '', '字串不是物件');
});

test('接線｜兩個預覽窗都真的呼叫 gateSummaryHtml（去註解原始碼形狀——cashflow.js 頂層 import app.js、node 載不動整頁，形狀掃描＝家規核可的接線驗法；顯示型接線被拔＝功能靜靜消失）', () => {
  // 鎖**插值形狀** `${gateSummaryHtml(…)}` 而非只鎖呼叫（r1#4）：`${(gateSummaryHtml(…), '')}` 這種
  // 逗號運算子寫法「有呼叫、沒插進畫面」——只鎖名稱的正規式會放它過、功能靜靜消失。
  const cashflow = stripComments(readFileSync(join(ROOT, 'public/modules/cashflow.js'), 'utf8'));
  assert.match(cashflow, /from '\.\/reconcile-summary\.js'/, '銀行頁要 import 本模組');
  assert.match(cashflow, /\$\{gateSummaryHtml\(r\.reconcile, 'bank'\)\}/, '銀行預覽窗要把翻譯結果插進畫面');
  const txImport = stripComments(readFileSync(join(ROOT, 'public/modules/transactions-import.js'), 'utf8'));
  assert.match(txImport, /from '\.\/reconcile-summary\.js'/, '卡片頁要 import 本模組');
  assert.match(txImport, /\$\{gateSummaryHtml\(curR\.reconcile, 'card'\)\}/, '卡片預覽窗（draw 內＝換卡重算也會刷新）要插進畫面');
});

test('advisories 不是陣列＝當空處理、stats 缺席＝計數當 0（防禦：後端形狀變動不炸畫面）', () => {
  const h = gateSummaryHtml(/** @type {any} */ ({ level: 'medium', advisories: 'x' }), 'card');
  assert.match(h, /✓ 帳單摘要驗算通過/);
  assert.doesNotMatch(h, /<ul/);
  const b = gateSummaryHtml(/** @type {any} */ ({ level: 'strong' }), 'bank');
  assert.match(b, /✓ 帳單數學驗算通過/, 'stats 缺席仍給結論');
  assert.doesNotMatch(b, /0 關/, '不可湊出「0 關」（r1#2）');
  assert.doesNotMatch(b, /：。/, '不可留空冒號句');
});

// ---- 合計交叉驗證的實況（2026-08-19；William 指出混幣時這道整個關掉、畫面卻說它擋得住＝轉述）----
// 這幾題守的是**畫面不說謊**：那道檢查對混幣帳單整道跳過，而說明區把它當現役防線在講。
// 少一道檢查使用者還知道要自己核對；畫面說它有把關＝他連核對都省了。

test('合計｜混幣＝必須明講「這次沒有跑」＋原因＋少了它看不到什麼（不可只有 ✓ 通過那句）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [],
    stats: { pairsChecked: 2, endChecked: 1 }, totalsCheck: { status: 'mixed-currency', fields: [] } }, 'bank');
  assert.match(h, /✓ 帳單數學驗算通過/, '餘額鏈那道真的跑了＝照講（不因為另一道沒跑就整段改口）');
  assert.match(h, /合計交叉驗證這次<b>沒有跑<\/b>/, '★沒跑就要明講沒跑');
  assert.match(h, /台幣[^。]*外幣/, '★要講出原因是混幣（使用者才知道這是他這份帳單的性質、不是壞掉）');
  // 三型**逐型**斷言（自審突變 M-loss-list-drop：原本只釘①，把⑥⑦砍掉全綠——契約寫著
  // 「多列＝誇大、少列＝遮掩」，而只有「誇大」那半有題，「遮掩」那半是空的）
  assert.match(h, /第一筆的方向讀反/, '★①每個帳戶第一筆的方向讀反或整筆漏掉');
  assert.match(h, /整個帳戶被漏讀/, '★⑦整個帳戶被漏讀——整帳戶的錢不見、餘額鏈完全接得上，最陰險的一型不可被砍掉');
  assert.match(h, /併成淨額/, '★⑥一收一支併成淨額');
  assert.doesNotMatch(h, /<b>方向讀反<\/b>/, '★不可講成「所有方向讀反都看不到」（非首筆的餘額鏈當場接不上）＝誇大損失');
  assert.match(h, /核對筆數與金額/, '★要給下一步');
  assert.match(h, /<p[^>]*>⚠️ 合計交叉驗證/, '★警示記號不可被拿掉（M-warn-sign-drop）：這段是 muted 小字、又緊接在綠色「✓ 通過」下面，沒有記號會被讀成中性附註');
  assert.doesNotMatch(h, /核對過|已經驗過|不影響/, '★理由不可反過來安撫（M-mixed-reason-lie：改寫成「台幣那段已經另外核對過了」仍含「台幣與外幣」＝拼字守衛攔不住）');
  assert.doesNotMatch(h, /合計交叉驗證：/, '★不可同時出現「合計對得上」那句');
});

test('合計｜有跑＝只列真的比對過的欄（只交回一半時不可說「都對得上」）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [], stats: { pairsChecked: 2 },
    totalsCheck: { status: 'pass', fields: ['txCount', 'totalOut'] } }, 'bank');
  assert.match(h, /AI 抄回來的筆數、支出合計與它自己逐筆算出來的對得上/);
  // 「對得上」那一句本身不可含沒讀到的欄（後面括號點名「這次沒讀到存入合計」是另一回事）
  const claim = h.slice(h.indexOf('合計交叉驗證：'), h.indexOf('（這次沒讀到'));
  assert.ok(claim.includes('對得上'), '抓得到「對得上」那一句（抓不到＝這題空轉）');
  assert.doesNotMatch(claim, /存入合計/, '★沒讀到的欄不可混進「對得上」那一句（那會把「沒得對」講成「對過了」）');
  assert.doesNotMatch(h, /沒有跑/);
  // ⚠️ William 2026-08-19 裁範圍（這一族連三輪中刀）：**收回誇大句**——這道能保證的只有
  //    「兩邊對得上」，不是「會改動那幾欄的錯都擋得住」（r5 實測：整組改成自洽的另一套數字全通過）。
  assert.match(h, /擋不住整組一起抄錯/, '★要自己講出真正的邊界');
  assert.doesNotMatch(h, /只擋得住<b>會改動/, '★誇大句不可回來');
  assert.doesNotMatch(h, /帳單印的/, '★不可斷言「帳單印的」——那是 AI 抄回來的，管線分不出帳單真的印了什麼');
  // 句子**到句號為止**（自審突變 M-pass-overclaim：三題全是 match＝子字串，句號後面接
  // 「每一筆的金額與方向都被驗過了」照樣全綠——合計只比三個控制總額，首筆的金額/方向本來就驗不到）
  assert.equal(totalsCheckSentence({ status: 'pass', fields: ['txCount', 'totalOut', 'totalIn'] }),
    '合計交叉驗證：AI 抄回來的筆數、支出合計、存入合計與它自己逐筆算出來的對得上。'
    + '這一道比的是這兩邊，擋得住抄漏、抄多、方向對調這種<b>兩邊對不上</b>的錯，<b>擋不住整組一起抄錯</b>。',
    '★逐字相等——誇大可以接在句號後面，子字串比對永遠攔不到（三欄全比到＝這句就是全部，不可再多掛）');
  // 三欄全交回＝三欄都要唸出來（Codex #490 r1#2：原本只驗兩欄，刪掉 totalIn 的翻譯全綠＝
  // 後端說「存入合計真的比對過了」、畫面卻靜靜不講，而那正是這支要消滅的病）
  const all = gateSummaryHtml({ level: 'strong', advisories: [], stats: { pairsChecked: 2 },
    totalsCheck: { status: 'pass', fields: ['txCount', 'totalOut', 'totalIn'] } }, 'bank');
  assert.match(all, /AI 抄回來的筆數、支出合計、存入合計與它自己逐筆算出來的對得上/);
});

test('合計｜只比到筆數＝要自己講「方向讀反仍沒把關」（複審後掃抓到：「有跑」≠「這幾型都罩到了」）', () => {
  // 實測：首筆 in→out 對調後**筆數 3→3 一模一樣**（支出合計 500→1500 才會不符）——
  // AI 只交回明細總筆數時，這道比得到的那一欄對「方向讀反」完全無效。不講的話，使用者照徽章
  // 的指路看到「合計交叉驗證…一致」就以為方向也有人看＝這支要消滅的同一種假話換個角落復發。
  const onlyCount = totalsCheckSentence({ status: TOTALS_CHECK.PASS, fields: ['txCount'] });
  assert.match(onlyCount, /這次沒讀到支出合計、存入合計/, '★沒比到的欄要點名（而且說「沒讀到」不說「帳單沒印」）');
  assert.match(onlyCount, /方向對調不會改變筆數/, '★要講出原因（否則使用者不知道為什麼筆數對了還要自己看）');
  assert.match(onlyCount, /第一筆的方向讀反/, '★要點名仍然沒把關的是哪一型');
  assert.match(onlyCount, /核對收支方向/, '★要給下一步');
  // 出入合計只要比到一個，方向讀反就擋得住（對調會讓兩邊同時變）＝不可再掛「方向沒把關」嚇人
  for (const f of [['txCount', 'totalOut'], ['txCount', 'totalIn'], ['totalOut'], ['txCount', 'totalOut', 'totalIn']]) {
    assert.doesNotMatch(totalsCheckSentence({ status: TOTALS_CHECK.PASS, fields: f }), /方向讀反/,
      `★${f.join('+')} 比到了出入合計＝方向讀反擋得住，不可誇大成「仍沒把關」`);
  }
  // 沒比到的欄一律點名（r4#1：漏掉一筆收入不會改動支出合計——「只比筆數」不是唯一有洞的那一格）
  const noIn = totalsCheckSentence({ status: TOTALS_CHECK.PASS, fields: ['txCount', 'totalOut'] });
  assert.match(noIn, /沒讀到存入合計/, '★缺存入合計也要講（漏抄一筆收入時它才是那把刀）');
  assert.doesNotMatch(noIn, /方向讀反/, '★但方向讀反這一型已經有支出合計罩著，不可重複嚇人');
  assert.doesNotMatch(totalsCheckSentence({ status: TOTALS_CHECK.PASS, fields: ['txCount', 'totalOut', 'totalIn'] }),
    /沒讀到/, '★三欄全比到＝沒有欄可點名，不可硬掛一句');
});

test('合計｜每個欄名都翻得出白話（互扣：後端說比對過、畫面卻靜靜不講＝Codex #490 r1#2 的假綠）', () => {
  for (const f of TOTALS_FIELDS) {
    const line = totalsCheckSentence({ status: TOTALS_CHECK.PASS, fields: [f] });
    assert.notEqual(line, '', `欄名 ${f} 沒有對應的白話——後端會回這個欄，畫面卻唸不出來`);
    assert.match(line, /合計交叉驗證：AI 抄回來的.+與它自己逐筆算出來的對得上/, `欄名 ${f} 的句子形狀不對`);
  }
  // 認得的欄與不認得的欄混在一起＝只唸認得的那些（不可整句消失、也不可把陌生欄名原樣吐出去）
  const mixed = totalsCheckSentence({ status: TOTALS_CHECK.PASS, fields: ['txCount', 'newField'] });
  assert.match(mixed, /筆數/);
  assert.doesNotMatch(mixed, /newField/);
});

test('合計｜每個後端狀態碼都有句子（互扣：新增碼沒補文案＝這裡紅）；未知碼／空 fields＝不吐、不編造', () => {
  for (const code of Object.values(TOTALS_CHECK)) {
    const tc = { status: code, fields: code === TOTALS_CHECK.PASS ? ['txCount'] : [] };
    assert.notEqual(totalsCheckSentence(tc), '', `狀態碼 ${code} 沒有對應的白話句`);
  }
  assert.equal(totalsCheckSentence({ status: 'bogus', fields: [] }), '', '不認得的碼＝不吐亂碼（新後端配舊前端）');
  // ⚠️ 原型鍵是「不認得的碼」裡最陰的一種（鐵則 3.5；Codex #490 r2#1 抓到）：
  //    `({...})['toString']` 撈到的是原型上的**函式**，`if (!why) return ''` 這種空值守衛對它無效，
  //    函式本體會被樣板字串印進畫面。實測原本會印出「合計交叉驗證這次沒有跑：function toString() {…}」。
  //    ⚠️ 自有的 `__proto__` 鍵只有 `JSON.parse` 造得出來（物件字面量裡那個是設原型的特殊語法），
  //    所以這題的 fields 走 JSON.parse——用字面量寫永遠測不到真實路徑。
  for (const k of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__']) {
    assert.equal(totalsCheckSentence({ status: k, fields: [] }), '', `★原型鍵 ${k} 不可撈到原型上的東西`);
    assert.equal(totalsCheckSentence({ status: 'pass', fields: [k] }), '', `★欄名是原型鍵 ${k} 時同樣不算數`);
  }
  const fromJson = JSON.parse('{"status":"pass","fields":["__proto__","toString"]}');
  assert.equal(totalsCheckSentence(fromJson), '', '★JSON.parse 造出的自有保留字鍵也不可撈到東西');
  assert.equal(gateSummaryHtml({ level: 'strong', advisories: [], stats: {} }, /** @type {any} */ ('toString')), '',
    '★kind 是原型鍵＝撈到函式後 .includes 會直接 TypeError 炸掉整個預覽窗');
  assert.equal(totalsCheckSentence(null), '');
  assert.equal(totalsCheckSentence(/** @type {any} */ ('pass')), '', '字串不是物件');
  assert.equal(totalsCheckSentence({ status: 'pass', fields: [] }), '',
    '★pass 卻一欄都沒比對過＝形狀不對，不可編造「對得上」');
  const tpl = gateSummaryHtml({ level: 'strong', advisories: [], stats: { pairsChecked: 2 } }, 'bank');
  assert.doesNotMatch(tpl, /合計交叉驗證/, '模板路線的裁決沒有這一欄＝畫面不長這句（那道檢查本來就不存在）');
});

test('合計｜壞形狀不得變成畫面上的東西：狀態碼與欄名只當查表鍵，永遠不插進 HTML', () => {
  // 這句話全部是本模組自己的字面（後端只給封閉代碼）——所以句子裡的 <b> 不經 esc。
  // 那個設計成立的**前提**就是「外來字串一個都進不了」，這題把前提釘住。
  assert.equal(totalsCheckSentence({ status: '<img src=x onerror=alert(1)>', fields: [] }), '');
  assert.equal(totalsCheckSentence({ status: 'pass', fields: ['<img src=x onerror=alert(1)>'] }), '',
    '★不認得的欄名不是「原樣顯示」而是不算數（一欄都不認得＝這句話不成立）');
  const h = gateSummaryHtml({ level: 'strong', advisories: [], stats: { pairsChecked: 1 },
    totalsCheck: /** @type {any} */ ({ status: 'pass', fields: ['txCount', '<img src=x>'] }) }, 'bank');
  assert.match(h, /合計交叉驗證：AI 抄回來的筆數與/);
  assert.doesNotMatch(h, /<img/, '★外來字串不可有機會進 HTML');
});

test('合計｜三個「沒跑」的理由不可互換：各自要講自己那一種（M-no-totals-blame）', () => {
  // 自審突變：三句可以互相複製貼上而全綠——互扣題只問「每個碼查得到非空句子」。
  // 最傷的一種：no-totals（規則卡路線根本不抄合計欄＝我們的鍋）被改成「你的帳單沒印」，
  // 直接違反本模組檔頭立的 r1#1「弱級句不可把鍋甩給帳單」，使用者也就不會想到換一條路線重讀。
  const mixed = totalsCheckSentence({ status: TOTALS_CHECK.MIXED_CURRENCY, fields: [] });
  const notRead = totalsCheckSentence({ status: TOTALS_CHECK.NOT_READ, fields: [] });
  const noTotals = totalsCheckSentence({ status: TOTALS_CHECK.NO_TOTALS, fields: [] });
  assert.match(mixed, /台幣[^。]{0,24}外幣/, '混幣要講混幣');
  assert.match(mixed, /判不出來|跳過/, '混幣要講出「為什麼不能硬比」');
  assert.match(notRead, /沒讀到/, '★只能說「這次沒讀到」——帳單可能印了、只是 AI 沒交回來（r5#3）');
  assert.doesNotMatch(notRead, /^這份帳單自己沒印/, '★不可斷言是帳單沒印（管線分不出來）');
  assert.match(noTotals, /讀這份帳單的方式|這條路線|沒有讀出/, '★路線不產這個欄＝我們的鍋，不可甩給帳單');
  assert.doesNotMatch(noTotals, /帳單自己沒印/, '★no-totals 不可講成「帳單沒印」（那是另一種情況、而且是甩鍋）');
  assert.equal(new Set([mixed, notRead, noTotals]).size, 3, '★三句必須各自不同（互相複製貼上＝這裡紅）');
});

test('合計｜有影子提醒時這句不可被擠掉（M-adv-suppress：兩者從未同時出現在任何一題裡）', () => {
  const h = gateSummaryHtml({ level: 'strong', advisories: [{ message: '差 100——可能漏讀' }],
    stats: { pairsChecked: 2 }, totalsCheck: { status: 'mixed-currency', fields: [] } }, 'bank');
  assert.match(h, /合計交叉驗證這次<b>沒有跑<\/b>/, '★同時有影子提醒又混幣＝最需要人工核對的那一份，不可反而不講');
  assert.match(h, /⚠ 差 100/, '影子提醒照舊列出');
});

// ⚠️ **誠實劃界：本檔的考題驗的是「字串內容」，不驗「畫面上看不看得見」**。
//    自審突變 M-hide-line（在這句的 style 加 display:none）確實全綠——句子照樣被組進 HTML、
//    畫面上卻消失。**刻意不守**：那不是真實的失誤模式（沒有人會不小心寫出 display:none），
//    而本專案為了防它燒過四輪覆審、被四種寫法輪流打穿（`test/ai-gate-interception.test.js`
//    的「攔截率」題有 William 2026-08-13 的同款裁示與完整病歷）。可見性要靠真的渲染才驗得到。

// ── 認不出機構的就地警語（2026-08-27）─────────────────────────────────────────
test('★認不出機構時要有就地警語；認得出來就不得亂鳴', async () => {
  const { unknownIssuerNoticeHtml } = await import('../public/modules/reconcile-summary.js');
  const html = unknownIssuerNoticeHtml('none');
  assert.match(html, /認不出/, '★要講清楚我們不知道這是哪一家');
  assert.match(html, /核對再匯入/, '★要告訴使用者該做什麼（列可能有漏抄或抄錯）');
  assert.match(html, /不會自動/, '★要說明為什麼要自己選卡');
  // 認得出來、或欄位根本沒帶（舊回應）都不得印——狼來了會讓警語失效
  assert.equal(unknownIssuerNoticeHtml('header'), '');
  assert.equal(unknownIssuerNoticeHtml('xlsx-template'), '');
  assert.equal(unknownIssuerNoticeHtml(undefined), '');
  assert.equal(unknownIssuerNoticeHtml(''), '');
});

test('★接線：預覽窗真的有呼叫「認不出機構」警語（Codex #518 r3#3：拔掉呼叫不會紅）', async () => {
  // ⚠️ 這是**形狀釘**，本卷其餘題都是行為題。放它的理由：這條接線是「畫面會不會說謊」的唯一保證，
  //    而預覽窗是靠字串樣板組出來的（沒有 DOM 測試環境可以直接驗）。同檔既有的對帳說明也是這樣釘的。
  //    ⚠️ 它證明的只有「呼叫存在、參數對」，**不保證它印在使用者看得到的位置**。
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/modules/transactions-import.js', import.meta.url), 'utf-8');
  assert.match(src, /import \{[^}]*unknownIssuerNoticeHtml[^}]*\} from '\.\/reconcile-summary\.js'/,
    '★要從單一真相引入，不可以在前端自己拼一句');
  assert.match(src, /\$\{unknownIssuerNoticeHtml\(curR\.bankEvidence\)\}/,
    '★要用後端回來的 bankEvidence 當參數（寫死或傳錯欄位＝警語永遠不出現／永遠出現）');
  // 它必須跟對帳說明一起出現在預覽窗的 bodyHtml 裡（兩者相鄰＝同一個區塊）
  const i = src.indexOf('unknownIssuerNoticeHtml(curR.bankEvidence)');
  const j = src.indexOf("gateSummaryHtml(curR.reconcile, 'card')");
  assert.ok(i > 0 && j > 0 && Math.abs(i - j) < 200, '★兩句要在預覽窗的同一個區塊裡');
});
