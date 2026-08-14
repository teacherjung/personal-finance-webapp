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
function renderRow(account, ibLastSync) {
  const source = read('public/modules/assets.js');
  const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const icon = name => `<svg data-icon="${name}"></svg>`;
  const moneyCur = (n, cur) => `${cur} ${Number(n).toLocaleString('en-US')}`;
  const row = Function('esc', 'icon', 'moneyCur', 'balanceAsOfNote',
    `${namedFunction(source, 'bankAccRow')}; return bankAccRow;`)(esc, icon, moneyCur, balanceAsOfNote);
  return row(account, ibLastSync);
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
  assert.deepEqual(good, { has: true, date: '2026-05-31', source: 'statement', text: '對帳單更新至 2026-05-31' });
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

// ── IB 同步的現金帳戶（2026-08-14 預審抓到的阻擋級）─────────────────────────
// `lib/services/ib-sync.js` 只寫 balance、不寫 balanceAsOf ⇒ 這些列會**永遠**顯示
// 「未由對帳單更新過」，而它們其實每次同步都在更新；說明窗還叫使用者去匯對帳單，
// 那條路對 IBKR 帳戶永遠走不通。這一族考題釘住「它們要走另一條文案」。
const IB_ACCOUNT = Object.freeze({ ...ACCOUNT, name: 'IBKR 美元現金', currency: 'USD', ibCashCur: 'USD' });

test('IB 現金帳戶：講「上次 IB 同步 <日期>」，不可以說成「未由對帳單更新過」', () => {
  const cell = balanceCell(renderRow(IB_ACCOUNT, '2026-08-14T03:21:00.000Z'));
  assert.match(cell, /上次 IB 同步 2026-08-14/, '★要用 IB 自己的時間點');
  assert.doesNotMatch(cell, /同步更新至|更新至 2026/u,
    '★不可以講成「這筆餘額更新到那天」（#454 r1 阻擋①）：lastSync 是每次同步無條件寫的，'
    + '而現金報表缺失時餘額是刻意沿用舊值——同步時間前進、餘額沒動是正常狀態');
  assert.doesNotMatch(cell, /未由對帳單更新過/u,
    '★這句對 IB 帳戶是錯的：它每次同步都在更新，而 IBKR 根本不出這種對帳單');
  assert.doesNotMatch(cell, /對帳單更新至/u, '也不可以講成對帳單更新的');
});

test('IB 現金帳戶：連同步時間都沒有時，仍要說清楚它靠的是 IB 而不是對帳單', () => {
  for (const noSync of [undefined, null, '', 'not-a-date', 12345]) {
    const cell = balanceCell(renderRow(IB_ACCOUNT, /** @type {any} */ (noSync)));
    assert.match(cell, /由 IB 同步更新/u, `★${JSON.stringify(noSync)}：沒有時間也要講出來源`);
    assert.doesNotMatch(cell, /上次 IB 同步 /u, `★${JSON.stringify(noSync)}：驗不過就不可以編一個日期出來`);
    assert.doesNotMatch(cell, /未由對帳單更新過/u, '★仍然不可以退回那句錯的');
  }
});

test('IB 的時間戳不可以外溢到一般銀行帳戶', () => {
  const cell = balanceCell(renderRow({ ...ACCOUNT }, '2026-08-14T03:21:00.000Z'));
  assert.match(cell, /未由對帳單更新過/u,
    '★一般帳戶沒有 ibCashCur，就不能借 IB 的同步時間冒充自己的更新日');
  assert.doesNotMatch(cell, /IB 同步/u);
});

test('說明窗要交代 IB 那一種，否則使用者只會看到一句沒解釋的新文案', () => {
  const body = namedFunction(read('public/modules/assets.js'), 'openBalanceAsOfInfo');
  assert.match(body, /上次 IB 同步/u, '說明窗要提到這種列長什麼樣');
  assert.match(body, /不是這一筆餘額的時間/u,
    '★說明窗必須點破「整次同步的時間 ≠ 這筆餘額的時間」——不寫的話這個日期一樣會被讀成保證');
  assert.match(body, /上界/u, '★要告訴使用者怎麼用它判斷：不會比它更新，但可能更舊');
  assert.doesNotMatch(body, /每次 IB 同步就會更新/u,
    '★這句話不成立：同步沒拿到現金報表時餘額刻意不動，時間卻照樣前進');
  assert.match(body, /不需要、也沒有對帳單可以匯|沒有對帳單/u,
    '★要講明「這種帳戶沒有對帳單可匯」——不然使用者會照另一段去找一條不存在的路');
});

test('接線｜頁面要真的把 IB 同步時間傳給每一列（漏傳＝IB 列永遠沒有日期）', () => {
  // ⚠️ 這一題是**接線形狀**，不是行為：上面那些題直接呼叫 bankAccRow、自己餵 ibLastSync，
  //    所以看不到「渲染那一端有沒有傳」。漏傳的話 IB 列會退成「由 IB 同步更新（不是對帳單）」
  //    ——文案仍然誠實，但使用者失去他要的那個判斷依據（多久沒同步了）。
  //    這種掃描守得住「參數被拿掉」，守不住等價改寫；能做到行為級要先把整頁渲染拉進可測範圍（待辦）。
  const source = read('public/modules/assets.js');
  assert.match(source, /bankAccRow\(a, db\.settings\?\.ib\?\.lastSync\)/u,
    '★渲染時要把 settings.ib.lastSync 傳進每一列');
  assert.match(source, /function bankAccRow\(x, ibLastSync\)/u,
    '★bankAccRow 要收得下第二個參數（簽章被改回去＝上面那行等於白傳）');
});

test('IB 日期用**當地**日曆日，不是 UTC 日（#454 r1 阻擋②）', () => {
  // 台北 2026-08-14 01:30 的同步，ISO 是前一天 17:30Z——切 UTC 會少一天。
  const cell = balanceCell(renderRow(IB_ACCOUNT, '2026-08-13T17:30:00.000Z'));
  const localDay = new Date('2026-08-13T17:30:00.000Z');
  const expect = `${localDay.getFullYear()}-${String(localDay.getMonth() + 1).padStart(2, '0')}-${String(localDay.getDate()).padStart(2, '0')}`;
  assert.match(cell, new RegExp(`上次 IB 同步 ${expect}`),
    `★要顯示當地日曆日（本機時區算出來是 ${expect}）——切 UTC 的話台北凌晨同步會少一天`);
});

test('IB 的假瞬間不編出日期（2026-02-30T… 會被 new Date 悄悄滾成 3/2）', () => {
  for (const bad of ['2026-02-30T10:00:00.000Z', '2026-13-01T10:00:00.000Z', '2026-08-14', 'x', '']) {
    const cell = balanceCell(renderRow(IB_ACCOUNT, bad));
    assert.match(cell, /由 IB 同步更新（不是對帳單）/u, `★${JSON.stringify(bad)} 要退回「只講來源」`);
    assert.doesNotMatch(cell, /上次 IB 同步 \d/u,
      `★${JSON.stringify(bad)} 不可以印出日期——new Date 對不存在的日子不會回 NaN，會滾到下個月`);
  }
});
