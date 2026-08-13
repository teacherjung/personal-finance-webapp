// 銀行帳戶頁：餘額下面那行「這個餘額是被哪一天的對帳單更新的」。
//
// 這一族考題要守的**不是排版**，是兩件會讓使用者誤判的事：
// ① 那行字必須真的出現在**餘額那一格**（跑真的 `bankAccRow`，不是比對字串常數）——
//    渲染函式沒接上、或接到別的欄位，使用者就看不到判斷依據。
// ② 文案不可以宣稱成「餘額截至 X 日」。`balanceAsOf` 只有對帳單匯入會寫，
//    手動改餘額不會動它；講成「餘額正確到這天」是**假話**，而假話比沒有標示更糟
//    （沒標示時使用者知道自己不知道）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceAsOfNote } from '../public/modules/accounts-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');

/** 從原始碼切出一個具名函式（與 bank-accounts-states-ui.test.js 同法：考題跑真的實作，不抄一份） */
function namedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 1;
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${name} 缺少右大括號`);
}

/** 用真的 `bankAccRow` 產一列 HTML；`balanceAsOfNote` 也是真的那一支（兩者接不上就會在這裡爆） */
function renderRow(account) {
  const source = read('public/modules/assets.js');
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const icon = name => `<svg data-icon="${name}"></svg>`;
  const moneyCur = (n, cur) => `${cur} ${Number(n).toLocaleString('en-US')}`;
  const row = Function('esc', 'icon', 'moneyCur', 'balanceAsOfNote',
    `${namedFunction(source, 'bankAccRow')}; return bankAccRow;`)(esc, icon, moneyCur, balanceAsOfNote);
  return row(account);
}

/** 取出 `data-label="餘額"` 那一格的內容——「字有出現在這一列」不算數，要在**餘額格裡** */
function balanceCell(html) {
  const m = /<td data-label="餘額"[^>]*>([\s\S]*?)<\/td>/u.exec(html);
  assert.ok(m, '找不到餘額欄位（<td data-label="餘額">）');
  return m[1];
}

const ACCOUNT = Object.freeze({ id: 'a1', name: '測試銀行 活存', currency: 'TWD', balance: 12345, accountNoLast4: '1234' });

test('有現值參考日：餘額格裡出現「對帳單更新至 <日期>」，金額本身還在', () => {
  const html = renderRow({ ...ACCOUNT, balanceAsOf: '2026-05-31' });
  const cell = balanceCell(html);
  assert.equal(html.split('bank-balance-asof').length - 1, 1,
    '整列只准出現一次——同一行字被畫兩次（例如又貼到幣別格）是壞掉，不是「至少有一個」');
  assert.match(cell, /TWD 12,345/, '金額不見了——旁註不可以擠掉主角');
  assert.match(cell, /對帳單更新至 2026-05-31/, '餘額格裡沒有更新日期');
  assert.doesNotMatch(cell, /餘額截至|正確到/u, '不可以宣稱成「餘額截至/正確到某日」——手動改餘額不會動這個日期');
});

test('沒有現值參考日：餘額格裡明說「未由對帳單更新過」，不是留白', () => {
  const cell = balanceCell(renderRow({ ...ACCOUNT }));
  assert.match(cell, /TWD 12,345/);
  assert.match(cell, /未由對帳單更新過/, '留白會被讀成「這個餘額是新的」——沒有標示要明講');
  assert.match(cell, /bank-balance-asof-none/, '「沒有日期」要有自己的樣式鉤子，才能跟有日期的視覺分開');
});

// ⚠️ 這題**不是**在證明髒值會從正常路徑流進來——寫入端 `lib/schema.js` 的 `'date'` 已經擋掉了
//（實測：`save()` 對 `2026-02-30` 直接丟例外）。它守的是顯示層自己的失敗模式：
// 萬一資料庫檔被手改、或日後多出繞過 save() 的寫入路徑，這格要看起來「沒日期」，
// 不可以把假日期原樣印在餘額旁邊冒充真的。
test('髒日期不原樣印在餘額旁邊（顯示層不相信自己的輸入）', () => {
  for (const bad of ['', '2026-13-45', '2026-02-30', '2026/05/31', '31-05-2026', 20260531, { d: '2026-05-31' }, null]) {
    const cell = balanceCell(renderRow({ ...ACCOUNT, balanceAsOf: bad }));
    assert.match(cell, /未由對帳單更新過/, `髒值 ${JSON.stringify(bad)} 應該退回「沒有」`);
    assert.doesNotMatch(cell, /對帳單更新至/, `髒值 ${JSON.stringify(bad)} 不可以被當成有效日期印出來`);
  }
});

test('純函式 balanceAsOfNote：真日曆才算數，回傳的 date 只在 has 為真時有值', () => {
  const good = balanceAsOfNote({ balanceAsOf: '2026-05-31' });
  assert.deepEqual(good, { has: true, date: '2026-05-31', text: '對帳單更新至 2026-05-31' });
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-05-32']) {
    assert.equal(balanceAsOfNote({ balanceAsOf: bad }).has, false, `${bad} 不是真實日期`);
    assert.equal(balanceAsOfNote({ balanceAsOf: bad }).date, '', `${bad} 不該回傳 date`);
  }
  assert.equal(balanceAsOfNote(undefined).has, false, '沒帶帳戶不可以爆掉（渲染中途丟例外＝整頁白掉）');
  assert.equal(balanceAsOfNote({}).text, '未由對帳單更新過');
});

test('就地解釋接上去了：說明按鈕存在、綁得到，而且文案講出「手動改餘額不會動這個日期」', () => {
  const source = read('public/modules/assets.js');
  assert.match(source, /id="balanceAsOfInfo"/u, '沒有說明按鈕');
  assert.match(source, /byId\('balanceAsOfInfo'\)\.onclick = openBalanceAsOfInfo;/u, '按鈕沒綁上——看得到點不動');
  const body = namedFunction(source, 'openBalanceAsOfInfo');
  assert.match(body, /openInfo\(/u, '說明窗要走共用的 openInfo');
  assert.match(body, /手動改餘額時，這個日期不會跟著動/u,
    '說明必須點破這一句：不寫，使用者會把它讀成「餘額正確到這天」——那是這個功能唯一會害人的誤解');
  assert.match(body, /現值參考日/u, '要交代「沒有日期」的另一個成因：帳單上讀不到現值參考日');
});
