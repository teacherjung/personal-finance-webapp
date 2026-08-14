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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
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

/** 餘額格裡那行小字的**完整內容**（逐字比對用）。
 *  ⚠️ r4 阻擋：原本用「包含正句＋列舉禁詞」把關，於是在正句後面**接一句**
 *  「—這筆餘額由 IB 同步」照樣全綠——列舉永遠補不完，所以這一族改成**整串等值**。 */
function asOfSmallCount(html) {
  return (html.match(/<small class="bank-balance-asof/gu) || []).length;   // 數**元素**，不是數 class 字串
}

function asOfSmallText(html) {
  const m = /<small class="bank-balance-asof[^"]*">([\s\S]*?)<\/small>/u.exec(html);
  assert.ok(m, '餘額格裡找不到那行小字（<small class="bank-balance-asof…">）');
  return m[1];
}

/** 取出 `data-label="餘額"` 那一格的內容——「字有出現在這一列」不算數，要在**餘額格裡** */
function balanceCell(html) {
  const m = /<td data-label="餘額"[^>]*>([\s\S]*?)<\/td>/u.exec(html);
  assert.ok(m, '找不到餘額欄位（<td data-label="餘額">）');
  return m[1];
}


/** 在指定時區開一個子行程跑真的 `balanceAsOfNote`，回傳那行小字。
 *  ⚠️ 不能在本行程改 `process.env.TZ`——V8 會快取時區，改了不一定生效。 */
function noteTextUnderTz(tz, iso) {
  const url = pathToFileURL(join(ROOT, 'public/modules/accounts-model.js')).href;
  const script = `import(${JSON.stringify(url)}).then(m => `
    + `process.stdout.write(m.balanceAsOfNote({ ibCashCur: 'USD' }, ${JSON.stringify(iso)}).text));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();
}

const ACCOUNT = Object.freeze({ id: 'a1', name: '測試銀行 活存', currency: 'TWD', balance: 12345, accountNoLast4: '1234' });

test('有現值參考日：餘額格裡出現「對帳單更新至 <日期>」，金額本身還在', () => {
  const html = renderRow({ ...ACCOUNT, balanceAsOf: '2026-05-31' });
  const cell = balanceCell(html);
  assert.equal(asOfSmallCount(html), 1,
    '整列只准出現一次——同一行字被畫兩次（例如又貼到幣別格）是壞掉，不是「至少有一個」');
  assert.match(cell, /TWD 12,345/, '金額不見了——旁註不可以擠掉主角');
  assert.equal(asOfSmallText(html), '對帳單更新至 2026-05-31', '★整串逐字（同上：只驗「包含」補不完）');
  assert.doesNotMatch(cell, /餘額截至|正確到/u, '不可以宣稱成「餘額截至/正確到某日」——手動改餘額不會動這個日期');
});

test('沒有現值參考日：餘額格裡明說「未由對帳單更新過」，不是留白', () => {
  const html = renderRow({ ...ACCOUNT });
  const cell = balanceCell(html);
  assert.match(cell, /TWD 12,345/);
  // ⚠️ r5 阻擋：這題原本只做「包含」，於是接一句「—這筆餘額由手動維護」照樣全綠
  //    ——那句對「帳單讀不到現值參考日」的帳戶是**假話**。整串等值才關得住。
  assert.equal(asOfSmallText(html), '未由對帳單更新過',
    '★整串逐字：留白會被讀成「這個餘額是新的」，多接一句又會把來源講死');
  assert.match(cell, /bank-balance-asof-none/, '「沒有日期」要有自己的樣式鉤子，才能跟有日期的視覺分開');
  assert.equal(asOfSmallCount(html), 1, '整列只准出現一次');
});

// ⚠️ 這題**不是**在證明髒值會從正常路徑流進來——寫入端 `lib/schema.js` 的 `'date'` 已經擋掉了
//（實測：`save()` 對 `2026-02-30` 直接丟例外）。它守的是顯示層自己的失敗模式：
// 萬一資料庫檔被手改、或日後多出繞過 save() 的寫入路徑，這格要看起來「沒日期」，
// 不可以把假日期原樣印在餘額旁邊冒充真的。
test('髒日期不原樣印在餘額旁邊（顯示層不相信自己的輸入）', () => {
  for (const bad of ['', '2026-13-45', '2026-02-30', '2026/05/31', '31-05-2026', 20260531, { d: '2026-05-31' }, null]) {
    assert.equal(asOfSmallText(renderRow({ ...ACCOUNT, balanceAsOf: bad })), '未由對帳單更新過',
      `★髒值 ${JSON.stringify(bad)} 要**整串**退回「沒有」——只驗「包含」的話，`
      + '把髒日期接在後面（「未由對帳單更新過（2026-02-30）」）照樣會過');
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
// 「未由對帳單更新過」，但那句對它們是錯的（它們根本不靠對帳單）；說明窗還叫使用者去匯對帳單，
// 那條路對 IBKR 帳戶永遠走不通。這一族考題釘住「它們要走另一條文案」。
const IB_ACCOUNT = Object.freeze({ ...ACCOUNT, name: 'IBKR 美元現金', currency: 'USD', ibCashCur: 'USD' });

test('IB 現金帳戶：講「上次 IB 同步 <日期>」，不可以說成「未由對帳單更新過」', () => {
  const html = renderRow(IB_ACCOUNT, '2026-08-14T03:21:00.000Z');
  const cell = balanceCell(html);
  assert.equal(asOfSmallText(html), '上次 IB 同步 2026-08-14',
    '★**整串逐字**：不可以只是「包含」這句——在後面接一句「這筆餘額由 IB 同步」就又把來源講死了，'
    + '而 lastSync 是每次同步無條件寫的、現金報表缺失時餘額刻意沿用舊值');
  assert.doesNotMatch(cell, /未由對帳單更新過/u,
    '★這句對 IB 帳戶是錯的：它們根本不靠對帳單，IBKR 也不出這種對帳單'
    + '（⚠️ 不可以寫成「它每次同步都在更新」——缺 Cash Report 時餘額刻意不動，見 ib-cash-freshness）');
  assert.doesNotMatch(cell, /對帳單更新至/u, '也不可以講成對帳單更新的');
});

test('IB 現金帳戶：沒有同步時間時只講身分，不可以宣稱這個數字是同步來的', () => {
  // ⚠️ r3 阻擋：舊文案「由 IB 同步更新（不是對帳單）」在**預設狀態下就是假的**——
  //    `data/seed.json` 是 `ib.lastSync: null` 配兩個 IB 現金帳戶＝**還沒同步過**，
  //    而餘額也可能是使用者自己填的。更糟的是我原本的考題把那句錯話釘住了。
  for (const noSync of [undefined, null, '', 'not-a-date', 12345]) {
    const html = renderRow(IB_ACCOUNT, /** @type {any} */ (noSync));
    assert.equal(asOfSmallText(html), 'IB 現金帳戶（尚無同步時間）',
      `★${JSON.stringify(noSync)}：**整串逐字**＝只講身分＋時間未知。多接任何一句`
      + '（例如「這筆餘額由 IB 同步」）都是把來源講死——可能從沒同步過、也可能是使用者自己填的');
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
  assert.doesNotMatch(body, /上界|不會比它更新/u,
    '★「上界」是被 r2 推翻的假宣稱：帳戶表單可以手動改餘額，改完數字反而**比那個日期新**');
  assert.match(body, /比這個日期新/u, '★要講出「手動改過餘額會比它新」這個反方向');
  assert.match(body, /不保證這個數字的新舊/u, '★要明說它只講同步時間、不保證餘額新舊');
  assert.match(body, /IB 那幾個則是再跑一次 IB 同步/u,
    '★結尾的「怎麼更新」要分流——一概叫使用者去匯對帳單，跟上面那段「IB 沒有對帳單可匯」自相矛盾');
  assert.doesNotMatch(body, /每次 IB 同步就會更新/u,
    '★這句話不成立：同步沒拿到現金報表時餘額刻意不動，時間卻照樣前進');
  assert.match(body, /不需要、也沒有對帳單可以匯|沒有對帳單/u,
    '★要講明「這種帳戶沒有對帳單可匯」——不然使用者會照另一段去找一條不存在的路');
});

test('接線｜頁面要真的把 IB 同步時間傳給每一列（漏傳＝IB 列永遠沒有日期）', () => {
  // ⚠️ 這一題是**接線形狀**，不是行為：上面那些題直接呼叫 bankAccRow、自己餵 ibLastSync，
  //    所以看不到「渲染那一端有沒有傳」。漏傳的話 IB 列會退成「IB 現金帳戶（尚無同步時間）」
  //    ——文案仍然誠實，但使用者失去他要的那個判斷依據（多久沒同步了）。
  //    這種掃描守得住「參數被拿掉」，守不住等價改寫；能做到行為級要先把整頁渲染拉進可測範圍（待辦）。
  const source = read('public/modules/assets.js');
  assert.match(source, /bankAccRow\(a, db\.settings\?\.ib\?\.lastSync\)/u,
    '★渲染時要把 settings.ib.lastSync 傳進每一列');
  assert.match(source, /function bankAccRow\(x, ibLastSync\)/u,
    '★bankAccRow 要收得下第二個參數（簽章被改回去＝上面那行等於白傳）');
});

test('IB 日期用**當地**日曆日，不是 UTC 日（#454 r1 阻擋②）', () => {
  // ⚠️ **這題必須真的換時區跑**（r2 阻擋②）：第一版用跟實作同一組 local getter 算期望值，
  //    那是恆真式；而正式 CI（GitHub Actions）跑在 UTC，兩邊剛好一致 ⇒ 就算實作切回 UTC 也全綠。
  //    所以改成開子行程、把 TZ 釘死，斷言**兩個時區給出不同的日**——切 UTC 的實作做不到這件事。
  const iso = '2026-08-13T17:30:00.000Z';          // 台北是 08-14 凌晨 01:30，UTC 還是 08-13
  assert.equal(noteTextUnderTz('Asia/Taipei', iso), '上次 IB 同步 2026-08-14',
    '★台北時區要顯示 08-14（切 UTC 的話會少一天）');
  assert.equal(noteTextUnderTz('UTC', iso), '上次 IB 同步 2026-08-13',
    '★UTC 時區顯示 08-13——兩個時區給出不同的日，才證明它真的看當地時間');
});

test('IB 的假瞬間不編出日期（2026-02-30T… 會被 new Date 悄悄滾成 3/2）', () => {
  for (const bad of ['2026-02-30T10:00:00.000Z', '2026-13-01T10:00:00.000Z', '2026-08-14', 'x', '']) {
    assert.equal(asOfSmallText(renderRow(IB_ACCOUNT, bad)), 'IB 現金帳戶（尚無同步時間）',
      `★${JSON.stringify(bad)} 要整串退回「只講身分」——new Date 對不存在的日子不會回 NaN、會滾到下個月，`
      + '印出來就是一個假日期');
  }
});
