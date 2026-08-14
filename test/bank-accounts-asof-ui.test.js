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
import { readFileSync, readdirSync } from 'node:fs';
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

/** 餘額格的**完整可見文字**（剝掉所有標籤）。
 *  ⚠️ r9 阻擋：asOfSmallText 只看 <small> 裡面——把假宣稱接在 </small> **後面**，
 *  字照樣顯示在餘額格、守衛卻看不到。可見文字要整格一起釘：格子裡只准有金額＋那行小字，
 *  多一個字都是在對使用者說話、都要有人核准。 */
function balanceCellText(html) {
  return balanceCell(html).replace(/<[^>]+>/gu, '');
}

/** 餘額格裡那行小字的**完整內容**（逐字比對用）。
 *  ⚠️ 這支函式是三輪阻擋磨出來的，每一道都有名字：
 *  r4「包含正句＋列舉禁詞」被接一段繞過 → 改整串等值；
 *  r6 唯一性只放在兩題 → 收進本函式、所有呼叫者自動受保護；
 *  r7 只認 class="…" 雙引號字面 → 改成**解析元素**：<small> 用單雙引號、任何屬性順序寫都認得，
 *  而且**餘額格裡任何形狀的 <small> 也只准一個**（沒掛 class 的偷渡版一樣算）。
 *  誠實劃界：擋的是等價寫法（引號／屬性順序／多 class），不追對抗性藏匿
 *  （#452 已裁示不防刻意隱藏——那不是真實的失敗模式）。 */
function asOfSmallText(html) {
  const classesOf = (/** @type {string} */ attrs) => {
    // ⚠️ 屬性名要有左邊界（r8 阻擋①）：沒有的話 `data-class="bank-balance-asof"` 也被認成 class
    //    ——CSS 已失效、考題卻照樣綠。開頭或空白之後的 `class=` 才算。
    const m = /(?:^|\s)class\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/u.exec(attrs);
    return ((m && (m[1] ?? m[2] ?? m[3])) || '').split(/\s+/u);
  };
  // 整列掛該 class 的 <small> 恰好一個（複製到別的欄位＝2＝紅）
  const rowSmalls = [...html.matchAll(/<small\b([^>]*)>([\s\S]*?)<\/small>/gu)];
  const noted = rowSmalls.filter((m) => classesOf(m[1]).includes('bank-balance-asof'));
  assert.equal(noted.length, 1,
    `整列掛 bank-balance-asof 的 <small> 必須恰好一個（實際 ${noted.length}）——單引號、屬性換序的寫法一樣要數到`);
  // 餘額格裡任何形狀的 <small> 恰好一個，而且**那一個自己就要掛著 class**（r8 阻擋②）：
  // 原本比「內文相等」——把掛 class 的搬去幣別格、餘額格留一個同文字的裸 <small>，
  // 內文照樣相等＝假綠。「是不是同一個元素」要看它自己的屬性，不是看字長得像不像。
  const cellSmalls = [...balanceCell(html).matchAll(/<small\b([^>]*)>([\s\S]*?)<\/small>/gu)];
  assert.equal(cellSmalls.length, 1,
    `餘額格裡任何形狀的 <small> 都只准一個（實際 ${cellSmalls.length}）——沒掛 class 的偷渡版一樣算`);
  assert.ok(classesOf(cellSmalls[0][1]).includes('bank-balance-asof'),
    '餘額格裡那一個 <small> 自己就要掛 bank-balance-asof——樣式掛在別處的複本上＝這行小字沒有樣式');
  return cellSmalls[0][2];
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
  assert.match(cell, /TWD 12,345/, '金額不見了——旁註不可以擠掉主角');
  assert.equal(asOfSmallText(html), '對帳單更新至 2026-05-31', '★整串逐字（同上：只驗「包含」補不完）');
  assert.equal(balanceCellText(html), 'TWD 12,345對帳單更新至 2026-05-31',
    '★整格可見文字＝金額＋小字，一個字都不准多（r9：接在 </small> 後面的字 small 守衛看不到）');
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
  assert.equal(balanceCellText(html), 'TWD 12,345未由對帳單更新過', '★整格可見文字（r9）');
  assert.match(cell, /bank-balance-asof-none/, '「沒有日期」要有自己的樣式鉤子，才能跟有日期的視覺分開');
});

// ⚠️ 這題**不是**在證明髒值會從正常路徑流進來——寫入端 `lib/schema.js` 的 `'date'` 已經擋掉了
//（實測：`save()` 對 `2026-02-30` 直接丟例外）。它守的是顯示層自己的失敗模式：
// 萬一資料庫檔被手改、或日後多出繞過 save() 的寫入路徑，這格要看起來「沒日期」，
// 不可以把假日期原樣印在餘額旁邊冒充真的。
test('髒日期不原樣印在餘額旁邊（顯示層不相信自己的輸入）', () => {
  for (const bad of ['', '2026-13-45', '2026-02-30', '2026/05/31', '31-05-2026', 20260531, { d: '2026-05-31' }, null]) {
    assert.equal(balanceCellText(renderRow({ ...ACCOUNT, balanceAsOf: bad })), 'TWD 12,345未由對帳單更新過',
      `★髒值 ${JSON.stringify(bad)}：整格可見文字（r9）`);
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
    '說明必須點破這一句：不寫，使用者會把它讀成「餘額正確到這天」——這正是這行小字最容易造成的誤解');
  assert.match(body, /現值參考日/u, '要交代「沒有日期」的另一個成因：帳單上讀不到現值參考日');
});

// ── IB 同步的現金帳戶（2026-08-14 預審抓到的阻擋級）─────────────────────────
// `lib/services/ib-sync.js` 只寫 balance、不寫 balanceAsOf ⇒ **沒有 IB 分支的話**這些列
// 會被打成「未由對帳單更新過」——那句對它們是錯的（它們根本不靠對帳單），而「去匯一份對帳單」
// 這條路對 IBKR 永遠走不通。這一族考題釘住「它們要走另一條文案」。
const IB_ACCOUNT = Object.freeze({ ...ACCOUNT, name: 'IBKR 美元現金', currency: 'USD', ibCashCur: 'USD' });

test('IB 現金帳戶：講「上次 IB 同步 <日期>」，不可以說成「未由對帳單更新過」', () => {
  const html = renderRow(IB_ACCOUNT, '2026-08-14T03:21:00.000Z');
  const cell = balanceCell(html);
  assert.equal(balanceCellText(html), 'USD 12,345上次 IB 同步 2026-08-14',
    '★整格可見文字（r9：他的刀就是把「—這筆餘額由 IB 同步」接在 </small> 後面）');
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
    assert.equal(balanceCellText(html), 'USD 12,345IB 現金帳戶（尚無同步時間）',
      `★${JSON.stringify(noSync)}：整格可見文字（r9）`);
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
    assert.equal(balanceCellText(renderRow(IB_ACCOUNT, bad)), 'USD 12,345IB 現金帳戶（尚無同步時間）',
      `★${JSON.stringify(bad)}：整格可見文字（r9）`);
    assert.equal(asOfSmallText(renderRow(IB_ACCOUNT, bad)), 'IB 現金帳戶（尚無同步時間）',
      `★${JSON.stringify(bad)} 要整串退回「只講身分」——new Date 對不存在的日子不會回 NaN、會滾到下個月，`
      + '印出來就是一個假日期');
  }
});

test('畫面文字不可以住在 CSS：content 只准裝飾符號字串／attr／none／normal（r10–r12）', () => {
  // ⚠️ 這題三輪磨出來（r10 CJK content／r11 註解與 link 屬性序／r12 英文假話＋掃描器語彙洞）。
  //    規則從黑名單翻成**白名單**：content 裡的字串 literal 一律不得含任何文字或數字
  //    （\p{L}\p{N}，任何語言）——「對使用者說話的字住在 HTML」不分語言。
  //    custom property 的字串（字型名這類）**不用管**：var 進不了 content（r12 定案），
  //    它們到不了畫面。空字串與 ›、✘ 這類純符號放行；attr() **只准**手機欄位標籤那一條
  //    （名字＋selector 一起綁——「值來自 HTML 所以守衛看得到」是 r14 推翻的錯誤理由：
  //    剝標籤時屬性值一起被剝掉，data-* 正好是守衛的盲區）。
  //    content 的**值形狀白名單化**（只准字串／attr／none／normal）：var、counter、url 全關——
  //    也因此 custom property 裡的字串（字型名這類）不用管，它們進不了 content。
  //    掃描器＝字串感知的小型解析器：屬性名大小寫不敏感、字串裡的分號不會截斷宣告、
  //    註解在字串外才剝。@import 一律禁止（匯進來的檔案逃出掃描射程；現況本來就零使用）。
  const attrOf = (/** @type {string} */ attrs, /** @type {string} */ name) => {
    const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(attrs);
    return m ? (m[1] ?? m[2] ?? m[3]) : '';
  };
  /** 剝註解（字串感知：字串裡的 /* 不算註解） @param {string} css */
  const stripComments = (css) => {
    let out = '', inStr = null;
    for (let i = 0; i < css.length; i++) {
      const c = css[i];
      if (inStr) {
        out += c;
        if (c === '\\') { out += css[i + 1] ?? ''; i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") { inStr = c; out += c; continue; }
      if (c === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2);
        i = (end === -1 ? css.length : end + 1); out += ' '; continue;
      }
      out += c;
    }
    return out;
  };
  /** 逐宣告收集：字串掛在哪個屬性底下＋content 完整值＋**它住在哪個 selector 底下**
   *（r15 阻擋：attr(data-label) 的白名單必須綁 selector，不然任何規則都能借這個名字搬字）
   * @param {string} clean */
  const declarations = (clean) => {
    /** @type {{selector: string, prop: string, strings: string[], value: string}[]} */
    const decls = [];
    let prop = null, buf = '', value = '', inStr = null, cur = '', strings = [], selector = '';
    const flush = () => {
      if (prop !== null) decls.push({ selector, prop, strings, value: value.trim() });
      prop = null; buf = ''; value = ''; strings = [];
    };
    for (let i = 0; i < clean.length; i++) {
      const c = clean[i];
      if (inStr) {
        if (c === '\\') { cur += clean[i + 1] ?? ''; value += c + (clean[i + 1] ?? ''); i++; continue; }
        if (c === inStr) { strings.push(cur); inStr = null; value += c; continue; }
        cur += c; value += c; continue;
      }
      if (c === '"' || c === "'") { inStr = c; cur = ''; if (prop !== null) value += c; continue; }
      if (c === '{') {   // 進 block：塊頭＝selector（@media 之下的內層 selector 會再覆蓋一次）
        selector = (prop !== null ? `${prop}:${value}` : buf).trim();
        prop = null; buf = ''; value = ''; strings = [];
        continue;
      }
      if (c === ';' || c === '}') { flush(); continue; }
      if (prop === null) {
        buf += c;
        if (c === ':') prop = buf.slice(0, -1).trim().toLowerCase();
      } else value += c;
    }
    flush();
    return decls;
  };
  /** @param {string} css @param {string} where */
  const scanCss = (css, where) => {
    const clean = stripComments(css);
    assert.doesNotMatch(clean, /@import/iu,
      `★${where} 用了 @import——匯進來的檔案逃出這題的射程，一律禁止（現況零使用）`);
    assert.doesNotMatch(clean, /@counter-style/iu,
      `★${where} 用了 @counter-style——它的 symbols/prefix/suffix 都能定義畫上畫面的文字，一律禁止（現況零使用）`);
    for (const d of declarations(clean)) {
      // ⚠️ r16 阻擋：content 不是唯一會畫字的屬性——list-style-type 可帶**任意字串**當清單符號
      //    （display: list-item 一配就上畫面，Chromium 實測會渲染）。字串規則同 content。
      if (d.prop.startsWith('list-style')) {   // 整個家族（r18：列舉兩個名字漏了 list-style-image——
                                               //  它自己也能掛 url()；-position 只有關鍵字值、順帶無害）
        for (const text of d.strings) {
          assert.doesNotMatch(text, /[\p{L}\p{N}]/u,
            `★${where} 的「${d.prop}」帶著文字「${text}」——清單符號也是畫在畫面上的字，同 content 規則`);
        }
        // ⚠️ r17 阻擋②：只驗直接字串不夠——list-style-type: var(--x) 讓 custom property
        //    那條搬字路重新開門（r12 關 content 的 var 時就是同一個理由）。url() 同理
        //    （marker 圖片可以是一張寫滿字的圖）。關鍵字（none/disc/inside…）照常放行。
        assert.doesNotMatch(d.value, /\b(?:var|url)\s*\(/iu,
          `★${where} 的「${d.prop}」用了 var/url——文字（或文字圖）從守衛看不到的地方進畫面`);
        continue;
      }
      if (d.prop !== 'content') continue;   // 其他屬性的字串（字型名、custom property 的字型堆疊）
                                            // 不會渲染成使用者看得到的話——content 的值形狀在下面
                                            // 白名單化之後，var() 進不了 content，那些字串也就到不了畫面
      for (const text of d.strings) {
        assert.doesNotMatch(text, /[\p{L}\p{N}]/u,
          `★${where} 的 content 帶著文字「${text}」——對使用者說話的字必須住在 HTML（任何語言、含數字都算）`);
      }
      // 值形狀白名單：只准 字串／attr(data-label)／none／normal。var()、counter()、url()…一律紅——
      // 每一個都是「文字從守衛看不到的地方進畫面」的通道，與其逐一列黑名單不如關門。
      // ⚠️ attr() **不是**全面放行（r14 阻擋）：我原本的理由「值來自 HTML、守衛看得到」是錯的——
      //    balanceCellText 剝標籤時把屬性值一起剝掉了，塞進 data-* 屬性的假話守衛根本看不到。
      //    唯一合法用途＝手機版欄位標籤 attr(data-label)，而 data-label 的值被
      //    bank-accounts-forest-ui 的欄名 deepEqual 釘死（『帳戶末四碼／幣別／餘額』），
      //    改值＝那題紅。其他任何 attr(＝從守衛盲區搬文字上畫面。
      // ⚠️ r15 阻擋：只驗 attr 的**名字**不夠——把 data-label 掛到 <small> 自己身上、
      //    再用 .bank-balance-asof::after { content: attr(data-label) } 一樣搬字上畫面。
      //    白名單＝「名字＋selector」一起綁：唯一合法的就是手機欄位標籤那一條規則。
      const MOBILE_LABEL_SELECTOR = '.bank-account-table td[data-label]::before';
      for (const a of d.value.matchAll(/attr\s*\(([^)]*)\)/giu)) {
        assert.ok(a[1].trim().toLowerCase() === 'data-label'
            && d.selector.replace(/\s+/gu, ' ') === MOBILE_LABEL_SELECTOR,
          `★${where} 的「${d.selector}」用了 attr(${a[1].trim()})——屬性值在守衛的盲區`
          + `（剝標籤時連值一起剝掉）。唯一合法的是 ${MOBILE_LABEL_SELECTOR} 的 attr(data-label)`);
      }
      const residue = d.value
        .replace(/"[^"]*"|'[^']*'/gu, ' ')
        .replace(/attr\s*\([^)]*\)/giu, ' ')
        .replace(/\b(?:none|normal)\b/giu, ' ')
        .trim();
      assert.equal(residue, '',
        `★${where} 的 content 出現「${residue}」——content 只准字串／attr()／none／normal，`
        + 'var、counter、url 這些都是守衛看不到的文字來源');
    }
  };
  const index = read('public/index.html');
  // ⚠️ HTML 的標籤與屬性名不分大小寫（r13 阻擋②）：<LINK REL="STYLESHEET"> 一樣合法，
  //    只認小寫＝等價改寫就讓整份樣式表逃出射程（fail-open）。
  const hrefs = [...index.matchAll(/<link\b([^>]*)>/giu)]
    .filter((m) => attrOf(m[1], 'rel').toLowerCase().split(/\s+/u).includes('stylesheet'))
    .map((m) => attrOf(m[1], 'href'))
    .filter((h) => h && !/^https?:/u.test(h));
  assert.ok(hrefs.length >= 5, `index.html 應該掛著多份樣式表（實際 ${hrefs.length}）——抓不到＝這題在驗空氣`);
  for (const href of hrefs) scanCss(read(`public/${href}`), href);
  for (const style of index.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) {
    scanCss(style[1], 'index.html 行內 <style>');
  }
  // ⚠️ CSS 不只住在 .css 檔（r13 阻擋①）：列印預覽（openPrintWindow）是 JS 生的 HTML，
  //    樣式在 app.js 的 PRINT_SHELL_CSS 與各報表的 extraCss 樣板字串裡——那個視窗根本
  //    不載 index.html 的樣式表，塞在這裡的 content 前面的掃描全部看不到。
  //    收集方式＝命名慣例（變數名含 css，不分大小寫）；PRINT_SHELL_CSS 另設錨點斷言，
  //    改名或搬家會當場紅、逼人回來更新收集規則，而不是靜靜漏掃。
  const jsFiles = ['public/app.js',
    ...readdirSync(join(ROOT, 'public/modules')).filter((f) => f.endsWith('.js')).map((f) => `public/modules/${f}`)];
  let cssLiterals = 0, sawPrintShell = false;
  for (const jf of jsFiles) {
    const js = read(jf);
    for (const m of js.matchAll(/(?:const|let|var)\s+(\w*css\w*)\s*=\s*`([\s\S]*?)`/giu)) {
      cssLiterals++;
      if (m[1] === 'PRINT_SHELL_CSS') sawPrintShell = true;
      scanCss(m[2], `${jf} 的 ${m[1]} 樣板`);
    }
  }
  assert.ok(sawPrintShell, 'app.js 的 PRINT_SHELL_CSS 收集不到了——改名或搬家請同步更新這裡的收集規則');
  // ⚠️ r17 阻擋①：行內 style 屬性是另一條畫字路——<small style="display:list-item;
  //    list-style-type:'假話'">，字直接顯示、上面的樣式表掃描全部管不到。與其去解析
  //    每一個 style 屬性（模板插值讓它解析不完整），不如整類關門：**JS 與 HTML 一律
  //    不准出現 list-style／listStyle**（樣式表裡的由上面的解析器管；現況 JS/HTML 零使用）。
  //    日後真的需要行內清單樣式＝這題紅、來人工審一次。
  for (const jf of ['public/index.html', ...jsFiles]) {
    assert.doesNotMatch(read(jf), /list-?style/iu,
      `★${jf} 出現 list-style／listStyle——行內清單符號能把任意字串畫上畫面`
      + '（style 屬性、el.style 都一樣），這一類只准住在樣式表裡給解析器審');
  }
  assert.ok(cssLiterals >= 3, `JS 裡的 CSS 樣板應該至少三份（PRINT_SHELL_CSS＋兩份報表 extraCss，實際 ${cssLiterals}）`);
});
