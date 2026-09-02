// @ts-check
// 發卡行「可選清單」的考題（William 2026-08-28 指派：把 `card.issuer` 從自由文字改成清單＋自訂）。
//
// ## 這一支在守什麼
//
// 自由文字**本身就無法消歧**：香港富邦官方自稱「富邦銀行」、台北富邦官方沿革同樣記載這個簡稱，
// 所以「把香港卡的發卡行填成精確的『富邦』」是合理且可達的輸入。判成台北富邦＝台北富邦的帳單
// 自動歸到香港卡上（**錢記到錯的卡**）。清單把歧義消在**輸入的當下**。
//
// 2026-09-02 再加一層：**機構代號** `card.issuerId`。清單解決了「輸入的當下不歧義」，但**存進 DB 的
// 仍然是顯示字串**、身分照樣靠文字算 ⇒ 名字改了、比對規則被動手腳，身分就會跟著漂。代號讓
// 「這張卡是哪一家」對**有代號的卡**變成查表。⚠️ William 裁示「照舊自動＋提示升級」：
// **沒有代號的卡照舊走文字、照舊自動歸卡**（零回歸），所以本卷同時要釘住那一半沒有被改壞。
//
// 四類題目，各自守不同的東西：
//   ①**資料紀律**（清單本身）：名字兩兩不同、`bank` 不可亂填、新增一家不可以碰巧撞上內建範本。
//   ①b**代號紀律**：代號是會落進使用者資料庫的**持久值**——整組釘成精確集合（改名／刪除都要紅）、
//     形狀限定、查表逐字相等（不吃 `issuerNameKey`，否則等於在代號那條路上再開一個文字入口）。
//   ②**行為**（純函式）：既有資料打開表單不會被靜靜改掉、送出時合回**要存的兩欄**、代號優先於字串、
//     查不到的代號退回文字（零回歸）。
//   ③**接線**（讀原始碼＋真櫃檯）：`public/modules/cards.js` 真的用了這些函式、升級提示真的渲染出來，
//     而且 `issuerId` 真的過得了櫃檯（`pickWritable`）——純函式全對、但沒接上去或被白名單剝掉，
//     使用者那邊一個字都沒變。
//
// ## ⚠️ 誠實劃界
//
// - **擋不住「清單漏了某一家銀行」**：那是人的判斷，而且清單本來就不完整（所以才有「其他」）。
// - **擋不住「使用者挑錯自己那張卡的發卡行」**：挑錯的後果與填錯自由文字相同。
// - **`onMount` 的顯示／隱藏用真 DOM 驗**（jsdom；#520 r4 之後補上）。
//   ⚠️ 這裡原本寫「不驗畫面，因為 `public/app.js` 頂層碰 document、node 裡 import 不進來」——
//   前半句的**結論**是錯的（工作流 2026-08-28 實測：jsdom 已是 devDependency，`test/backup-export.test.js`
//   與 `test/reminder-thresholds.test.js` 早就在用）。當時只靠一行原始碼 regex 守著，實測把
//   `other?.closest('div')` 改成 `root.querySelector('div')`（抓到 `.modal-bg`＝整個彈窗被隱藏）**當時的相關考卷全綠**。
//   ⚠️ 誠實劃界：本檔在 jsdom 裡重建的是 `openForm` 產出的**那兩格欄位**，不是整支 `cards.js`
//   （它 import `../app.js`，頂層讀 localStorage，node 裡 import 不進來——這句仍為真）。
//   所以本題證明的是「**這段 onMount 程式碼**放進那個 DOM 會正確切換」，不是「整張表單畫面正確」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARD_ISSUERS, SHARED_ISSUER_NAMES, ISSUER_OTHER, ISSUER_OTHER_LABEL, ISSUER_UNSET_LABEL,
  issuerNameKey, issuersNamed, issuerById, cardCode, issuerOptions, issuerFormFields, resolveIssuerFields,
} from '../public/modules/card-issuers.js';
import { OWN_ISSUERS, issuerBank, issuerCertainlyNot, cardIssuerBank, cardCertainlyNot } from '../lib/card-identity.js';
import { squash } from '../lib/bank-statement.js';

// ⚠️ 一定要 fileURLToPath：這個 repo 的路徑含空白與中文，`new URL(...).pathname` 會回百分號編碼
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), 'utf8');

/** 「帳單抬頭」那把尺對這個字串的判定（`issuerBank` 的退路，也是本檔驗清單用的獨立第二把尺）。 */
const byPattern = (/** @type {string} */ text) => {
  const hit = OWN_ISSUERS.filter(o => o.re.test(squash(text)));
  return hit.length === 1 ? hit[0].bank : '';
};

// ───────────────────────── ① 資料紀律 ─────────────────────────

test('清單｜每一家的名字兩兩不同（正規化後）——同名兩筆＝挑哪一項都一樣，清單就白做了', () => {
  const seen = new Map();
  for (const o of CARD_ISSUERS) {
    const k = issuerNameKey(o.name);
    assert.ok(k, `發卡機構的名字不可空白：${JSON.stringify(o)}`);
    assert.equal(seen.has(k), false, `清單有兩筆同名：${o.name}（與 ${seen.get(k)} 撞）`);
    seen.set(k, o.name);
  }
});

test('清單｜`bank` 只能是內建範本的機構名或空字串', () => {
  const allowed = new Set([...OWN_ISSUERS.map(o => o.bank), '']);
  for (const o of CARD_ISSUERS) {
    assert.ok(allowed.has(o.bank), `${o.name} 的 bank「${o.bank}」不在內建範本清單裡（${[...allowed].join('／')}）`);
  }
});

test('★清單｜任何一筆的名字／別名都不可以「樣式對到別家」——新增一家銀行時碰巧撞上內建範本會轉紅', () => {
  // 這是本檔最重要的機械閘：`issuerBank` 清單查不到時會退回樣式比對，所以清單上的字**不可以**
  // 在樣式那條路上指向另一家。例：日後有人把「台新銀行」誤登記成別家的別名，這一題會紅。
  for (const o of CARD_ISSUERS) {
    for (const text of [o.name, ...(o.aka || [])]) {
      const pat = byPattern(text);
      assert.ok(pat === '' || pat === o.bank,
        `「${text}」登記在「${o.name}」（bank='${o.bank}'）底下，但帳單抬頭那把尺說它是「${pat}」`);
    }
  }
});

test('★清單｜有內建範本的那幾家，正式名稱在樣式那條路也要認得出來（兩把尺不可以走鐘）', () => {
  const withTemplate = CARD_ISSUERS.filter(o => o.bank !== '');
  assert.ok(withTemplate.length >= 1, '前提：清單裡至少有一家有內建範本');
  for (const o of withTemplate) {
    assert.equal(byPattern(o.name), o.bank, `${o.name} 在樣式那條路上對不出 ${o.bank}`);
  }
  // 對照：內建範本有幾支，清單就該有幾家掛得上（漏掉一家＝那家的卡永遠自動歸不了）
  assert.deepEqual(
    [...new Set(withTemplate.map(o => o.bank))].sort(),
    [...new Set(OWN_ISSUERS.map(o => o.bank))].sort(),
    '★內建範本的機構在清單裡必須各有一家掛著，否則使用者挑不到「能自動歸卡」的那一項');
});

test('★清單｜「富邦」「富邦銀行」必須被**兩家**宣稱——這是 `issuerBank` 判歧義的資料面依據', () => {
  // `lib/card-identity.js` 的歧義那一格指名這一題。刪掉其中一邊的宣稱，那一格就會回去猜。
  for (const shortName of ['富邦', '富邦銀行']) {
    const named = issuersNamed(shortName);
    assert.ok(named.length >= 2, `「${shortName}」只被 ${named.length} 家宣稱 ⇒ 歧義消失了`);
    assert.ok(named.some(o => o.name === '台北富邦銀行'), `「${shortName}」少了台北富邦的宣稱`);
    assert.ok(named.some(o => o.name === '富邦銀行（香港）'), `「${shortName}」少了香港富邦的宣稱`);
  }
});

test('★清單｜**清單上宣告的**寫法裡，判得出機構的就是這四個（Codex #520 r2#1／r3#1）', () => {
  // r1／r2 的閘都用「這個別名有沒有改變結果」當判準，兩次都被同族資料寫法躲過：
  //   ・r1：兩家 `bank: ''` 同補 `HSBC`（是歧義，但兩邊都不掛機構名 ⇒ 一個結果都沒改）
  //   ・r2：只替**台新**補 `HSBC`——`issuerBank('HSBC')` 直接變成 `'台新'`，**全套照樣綠**（實測）
  // 這個 repo 的教訓是「列舉補不完就關門」：改成**精確集合相等**，要新增就得先改這一題＝刻意的審批點。
  //
  // ## ⚠️ 誠實劃界：這是**資料面**的閘，不是「所有輸入」的封閉白名單（Codex #520 r3#1）
  //
  // 判準真正吃的是 `issuerNameKey` 抹平後的鑰匙，所以**每一個列在下面的寫法，它的等價類也判得出來**
  //   ——`issuerBank('臺 新') === '台新'` 就在白名單之外。這一題**只**保證：
  //   「`CARD_ISSUERS` 裡**宣告過**的寫法中，判得出機構的恰好是這四個」。
  // ⚠️ 它**擋不住**「有人改 `issuerNameKey`、讓別的字串落進這四個的等價類」——Codex r3#1 實測：
  //   在正規化器裡加一條 `hsbc → 台新`，本卷**全數照樣綠**而 `issuerBank('HSBC')` 變成 `'台新'`。
  //   **不要**把這一題當成「新字串不可能取得身分」的保證。
  // ⚠️ 要真的關起那道門，字串架構本身辦不到——得改成存穩定的機構代號（只有從清單挑的代號才授予身分）。
  //   **William 2026-08-28 裁示：本支只把話講準，代號另開一張卡。** 等價類造成的行為差異
  //   （臺新／臺 新／台🈟）已由 `test/card-identity.test.js` 的「相對 base 的行為改變逐項釘住」列出。
  const resolvable = CARD_ISSUERS
    .flatMap(o => [o.name, ...(o.aka || [])])
    .filter(t => issuerBank(t) !== '')
    .sort();
  assert.deepEqual(resolvable, ['台北富邦', '台北富邦銀行', '台新', '台新銀行'].sort(),
    '★清單上宣告的寫法裡，判得出機構的那一組變了——每多一個，它的整個等價類都跟著判得出機構');
});

test('★清單｜共用寫法（歧義）＝**逐組宣告**，與資料精確相等（Codex #520 r2#1）', () => {
  // 「逐字白名單」那題管的是「判得出機構」的那一側；這一題管另一側——**判不出來是因為兩家都叫這個名字**。
  // 多一個共用寫法（例如替兩家同補 HSBC）會在這裡紅。
  // ⚠️ 與「逐字白名單」題同一份劃界：這一對集合閘管的都是**清單宣告的資料**，不是所有 runtime 輸入
  //    （改 `issuerNameKey` 讓某個字串落進共用寫法的等價類，這一對都看不到）。
  const computed = [...new Set(CARD_ISSUERS.flatMap(o => o.aka || []))]
    .map(a => ({ name: a, claimedBy: issuersNamed(a).map(o => o.name) }))
    .filter(x => x.claimedBy.length >= 2)
    .sort((a, b) => a.name.localeCompare(b.name));
  const declared = SHARED_ISSUER_NAMES
    .map(x => ({ name: x.name, claimedBy: [...x.claimedBy] }))
    .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(computed, declared,
    '★清單算出來的共用寫法與 SHARED_ISSUER_NAMES 的宣告對不上——新增共用寫法要先去那裡列名並寫下理由');
  for (const x of SHARED_ISSUER_NAMES) {
    assert.ok(x.why && x.why.length >= 6, `共用寫法「${x.name}」沒寫為什麼是真的共用`);
    assert.equal(issuerBank(x.name), '', `★共用寫法「${x.name}」必須判不出身分`);
  }
});

test('★清單｜別名不可以與自己的正式名稱、或同一家的其他別名撞同一把鑰匙（Codex #520 r1#5②）', () => {
  // `issuerNameKey` 會把「臺新」壓成跟「台新」同一把，所以 `aka: ['台新','臺新']` 的第二個是死字：
  // 刪掉它一個結果都不會變，「共用寫法逐組宣告」那題卻放行。重複的別名讓清單看起來比實際嚴謹。
  for (const o of CARD_ISSUERS) {
    const seen = new Set([issuerNameKey(o.name)]);
    for (const a of o.aka || []) {
      const k = issuerNameKey(a);
      assert.equal(seen.has(k), false, `${o.name} 的別名「${a}」與同一家的別的寫法壓成同一把鑰匙（${k}）`);
      seen.add(k);
    }
  }
});

test('★清單｜正式名稱不可以同時是別人的別名——否則挑清單上那一項反而變歧義', () => {
  for (const o of CARD_ISSUERS) {
    assert.deepEqual(issuersNamed(o.name), [o], `「${o.name}」不是只有自己宣稱`);
  }
});

test('清單｜`issuersNamed` 的三種筆數各自代表什麼', () => {
  assert.equal(issuersNamed('台新銀行').length, 1);
  assert.equal(issuersNamed('台新').length, 1, '別名也算宣稱');
  assert.equal(issuersNamed('富邦').length, 2, '兩家共用＝歧義');
  assert.equal(issuersNamed('某某不存在銀行').length, 0, '清單沒有這個寫法');
  assert.equal(issuersNamed('').length, 0);
  assert.equal(issuersNamed(null).length, 0);
});

test('清單｜比對形吃得下全形／空白／臺台／大小寫', () => {
  assert.equal(issuerNameKey(' 臺新銀行 '), issuerNameKey('台新銀行'));
  assert.equal(issuerNameKey('富邦銀行（香港）'), issuerNameKey('富邦銀行(香港)'));
  assert.equal(issuerNameKey('TAISHIN'), issuerNameKey('taishin'));
});

// ───────────────────────── ①b 代號紀律（2026-09-02）─────────────────────────

/**
 * **代號的精確集合**——這是持久資料的棘輪。
 *
 * 為什麼要抄一份在考題裡（而不是從 `CARD_ISSUERS` 推導）：`card.issuerId` 會**落進使用者的資料庫**，
 * 一個代號發出去就永遠不可以改名或刪除——改了＝那些卡查不到東西、退回文字那條路、身分可能就此不同。
 * 從清單推導的話，刪一家、改一個字母全都照樣綠；抄成精確集合，動一個字就轉紅，
 * 逼人先來這裡改、順便想一下「資料庫裡已經有這個代號的卡怎麼辦」。
 * ⚠️ 新增一家銀行時**要**改這一份（那是刻意的摩擦，不是壞掉）。
 */
const ISSUER_BINDINGS = [
  { id: 'taishin', name: '台新銀行', bank: '台新' },
  { id: 'fubon-taipei', name: '台北富邦銀行', bank: '富邦' },
  { id: 'fubon-hk', name: '富邦銀行（香港）', bank: '' },
  { id: 'cathay-united', name: '國泰世華銀行', bank: '' },
  { id: 'ctbc', name: '中國信託銀行', bank: '' },
  { id: 'esun', name: '玉山銀行', bank: '' },
  { id: 'sinopac', name: '永豐銀行', bank: '' },
  { id: 'union', name: '聯邦銀行', bank: '' },
  { id: 'far-eastern', name: '遠東商銀', bank: '' },
  { id: 'dbs-tw', name: '星展銀行（台灣）', bank: '' },
  { id: 'hsbc-tw', name: '匯豐銀行（台灣）', bank: '' },
  { id: 'sc-tw', name: '渣打銀行（台灣）', bank: '' },
  { id: 'citi-tw', name: '花旗銀行（台灣）', bank: '' },
  { id: 'mega', name: '兆豐銀行', bank: '' },
  { id: 'first', name: '第一銀行', bank: '' },
  { id: 'hua-nan', name: '華南銀行', bank: '' },
  { id: 'chang-hwa', name: '彰化銀行', bank: '' },
  { id: 'yuanta', name: '元大銀行', bank: '' },
  { id: 'kgi', name: '凱基銀行', bank: '' },
  { id: 'shin-kong', name: '新光銀行', bank: '' },
  { id: 'entie', name: '安泰銀行', bank: '' },
  { id: 'o-bank', name: '王道銀行', bank: '' },
  { id: 'bank-of-taiwan', name: '台灣銀行', bank: '' },
  { id: 'tcb', name: '合作金庫銀行', bank: '' },
  { id: 'land-bank', name: '土地銀行', bank: '' },
  { id: 'scsb', name: '上海商業儲蓄銀行', bank: '' },
  { id: 'tbb', name: '台灣企銀', bank: '' },
  { id: 'taichung', name: '台中銀行', bank: '' },
  { id: 'bok', name: '高雄銀行', bank: '' },
  { id: 'sunny', name: '陽信銀行', bank: '' },
  { id: 'panhsin', name: '板信銀行', bank: '' },
  { id: 'cota', name: '三信商業銀行', bank: '' },
  { id: 'rising', name: '瑞興銀行', bank: '' },
  { id: 'hwatai', name: '華泰銀行', bank: '' },
  { id: 'jih-sun', name: '日盛銀行', bank: '' },
  { id: 'rakuten-tw', name: '樂天國際商業銀行', bank: '' },
  { id: 'next-bank', name: '將來銀行', bank: '' },
  { id: 'line-bank', name: '連線商業銀行', bank: '' },
];

test('★代號｜整組**代號→法人**的綁定是精確集合（不只代號序列——換名字也要紅）', () => {
  // ⚠️ Codex #547 r3 第 2 條實測：只釘代號序列時，把 `cathay-united` 與 `ctbc` 的**正式名稱互換**、
  //    代號與順序完全不動，四卷 166 題照樣全綠 ⇒ 那等於「既有代號被重新綁到另一個法人」而沒人發現，
  //    資料庫裡那些卡的身分會靜靜換一家。所以釘的是**綁定**，不是序列。
  assert.deepEqual(CARD_ISSUERS.map(o => ({ id: o.id, name: o.name, bank: o.bank })), ISSUER_BINDINGS,
    '★代號→（正式名稱, 內建範本）的綁定與宣告對不上。新增一家＝在下面補一列；'
    + '**改名**＝除了改這裡，還必須把舊正式名稱留進該筆的 `aka`（否則既有卡片會從 ok 掉進 unconfirmed）；'
    + '**刪除或重用代號**＝資料庫裡那些卡查不到身分，不可以做。');
});

test('★代號｜清單改名時，舊卡不可以靜靜失去身分——舊名要留在 `aka`', () => {
  // Codex #547 r3 第 2 條的第二半：正常表單存出的 `{issuerId:'taishin', issuer:'台新銀行'}`，
  // 若日後只改清單名稱、沒把舊名留進 `aka`，會從 `ok/台新` 變成 `unconfirmed/''`。
  // 這一題把「舊名留在 aka」這個紀律變成可執行的示範：改名後只要舊名在 aka，既有卡片照舊是 ok。
  const renamed = { id: 'taishin', name: '台新國際商業銀行', bank: '台新', aka: ['台新', '台新銀行'] };
  const legacyCard = { issuerId: 'taishin', issuer: '台新銀行' };
  const claimed = [renamed.name, ...renamed.aka].some(n => issuerNameKey(n) === issuerNameKey(legacyCard.issuer));
  assert.ok(claimed, '★改名後舊正式名稱必須仍被那一筆宣稱，既有卡片才不會掉進 unconfirmed');
  // 對照：舊名沒留在 aka 就會失去身分（這就是上面那條紀律存在的理由）
  const renamedBad = { id: 'taishin', name: '台新國際商業銀行', bank: '台新', aka: ['台新'] };
  assert.equal([renamedBad.name, ...renamedBad.aka].some(n => issuerNameKey(n) === issuerNameKey(legacyCard.issuer)), false);
});

test('★代號｜形狀紀律：不重複、非空、只用小寫 ASCII 與連字號', () => {
  const seen = new Set();
  for (const o of CARD_ISSUERS) {
    assert.match(o.id, /^[a-z][a-z0-9-]*[a-z0-9]$/, `代號「${o.id}」形狀不合（只准小寫 ASCII 字母、數字、連字號，且不以連字號起訖）`);
    assert.equal(seen.has(o.id), false, `代號重複：${o.id}`);
    seen.add(o.id);
  }
  // ⚠️ 代號刻意**不是**中文名字的音譯保證，也不宣稱是官方英文縮寫——它只需要唯一且不變。
  //    所以這裡不驗「代號要對得上名字」（那種題目會逼人為了讓題目綠而改持久資料）。
});

test('★代號｜查表逐字相等，不吃正規化——代號那條路不可以長出第二個入口', () => {
  assert.equal(issuerById('taishin')?.name, '台新銀行');
  assert.equal(issuerById('fubon-hk')?.name, '富邦銀行（香港）');
  // 這幾個在 `issuerNameKey` 底下都會被抹成同一把；代號查表必須全部不認
  for (const near of ['TAISHIN', 'Taishin', ' taishin', 'taishin ', 'ｔａｉｓｈｉｎ', 'tai shin']) {
    assert.equal(issuerById(near), null, `★「${near}」不是我們發出去的代號，不可以查得到`);
  }
  // 非字串一律不是代號（與 `issuer` 那一欄「字串化後再判」的裁定刻意不同，理由見 issuerById 檔頭）
  for (const bad of [null, undefined, 123, true, {}, ['taishin'], '']) {
    assert.equal(issuerById(bad), null, `★${JSON.stringify(bad)} 不可以被當成代號`);
  }
  assert.equal(issuerById(String(['taishin'])), CARD_ISSUERS[0], '對照：字串化之後才查得到＝所以差別真的在 typeof 那一行（不是恆假）');
});

test('★代號｜清單上每一家挑下去，卡片版判準都要給出它宣告的那一家', () => {
  for (const o of CARD_ISSUERS) {
    assert.equal(cardIssuerBank({ issuerId: o.id }), o.bank, `代號「${o.id}」判出來的不是 ${o.bank || '（無範本）'}`);
    assert.equal(cardIssuerBank({ issuerId: o.id, issuer: o.name }), o.bank, '顯示名＝正式名稱（表單寫出來的形狀）');
    for (const a of o.aka || []) {
      assert.equal(cardIssuerBank({ issuerId: o.id, issuer: a }), o.bank, `別名「${a}」也要算「確認了代號」`);
    }
  }
  // ★代號真正買到的東西：**歧義的顯示名被消歧**。單看文字判不出來，配上代號就說得清楚。
  assert.equal(issuerBank('富邦'), '', '前提：「富邦」被兩家宣稱 ⇒ 文字那條路不猜');
  assert.equal(cardIssuerBank({ issuer: '富邦', issuerId: 'fubon-taipei' }), '富邦', '★代號說是台北富邦 ⇒ 說得清楚了');
  assert.equal(cardIssuerBank({ issuer: '富邦', issuerId: 'fubon-hk' }), '', '★代號說是香港富邦 ⇒ 沒有內建範本');
  assert.equal(cardCertainlyNot({ issuer: '富邦', issuerId: 'fubon-hk' }, '富邦'), true, '★而且確定不是台北富邦');
  assert.equal(issuerCertainlyNot('富邦', '富邦'), false, '對照：沒有代號時「富邦」是「不確定」');
});

test('★★代號｜**顯示名沒有確認代號＝說不清楚**，既不採信代號、也不退回文字（Codex #547 r1 第 1 條、r2 第 1／3 條）', async () => {
  const { cardCode } = await import('../public/modules/card-issuers.js');
  // 走散的卡有兩種，**危害方向相反**，所以退路不可以是「退回文字」：
  //   r1：`{issuer:'台北富邦銀行', issuerId:'taishin'}`（舊分頁只送 issuer 就造得出來）
  //       ——無條件相信代號 ⇒ 這張出局 ⇒ 另一張富邦卡成唯一同行卡 ⇒ 富邦帳單自動歸過去。
  //   r2：`{issuer:'美國運通', issuerId:'taishin'}`（POST/PUT 兩欄一起送、備份匯入都做得到）
  //       ——r1 的修法只否決「清單認得、但認成別家」，清單認不得的另一家被當成沒有反對證據
  //         ⇒ 台新帳單自動歸到一張畫面寫著「美國運通」的卡（Codex 端到端重現過）。
  for (const shown of ['台北富邦銀行', '美國運通', '兆豐國際商業銀行', '我的某某卡', '玉山銀行']) {
    const card = { issuer: shown, issuerId: 'taishin' };
    assert.deepEqual(cardCode(card), { state: 'unconfirmed' }, `「${shown}」沒有確認 taishin`);
    assert.equal(cardIssuerBank(card), '', `★「${shown}」＋台新代號 ⇒ 判不出來（不可以判成台新，也不可以判成顯示名那一家）`);
    assert.equal(cardCertainlyNot(card, '台新'), false, '★說不清楚＝證明不了是別家＝擋自動歸並進候選');
    assert.equal(cardCertainlyNot(card, '富邦'), false);
  }
  // ★★**可證明的不變量**：有代號的卡，只會判成「它自己那一家」或「判不出來」，**不可能判成別家**。
  //   這一格是 r2 第 3 條的正解——r1 的「退回文字」讓顯示名可以指定另一家，那句宣稱當時是假的
  //   （Codex 把 `issuerNameKey` 改壞讓 HSBC 抹成台新，`{issuerId:'esun', issuer:'HSBC'}` 就被歸成台新）。
  const NASTY = ['', '   ', '台新銀行', '台新', '臺新', '台 新', '富邦', '富邦銀行', '台北富邦銀行',
    '富邦銀行（香港）', '台北富邦銀行（香港）', '美國運通', '玉山銀行', '某某會員俱樂部',
    'HSBC', 'ｔａｉｓｈｉｎ', 'taishin', '__other__', '[object Object]'];
  for (const o of CARD_ISSUERS) {
    for (const shown of NASTY) {
      const got = cardIssuerBank({ issuerId: o.id, issuer: shown });
      assert.ok(got === o.bank || got === '',
        `★代號「${o.id}」＋顯示名「${shown}」判成了「${got}」——有代號的卡不可以判成別家`);
    }
  }
  // 對照組：**確認得了**的四種都要照舊採信代號（否則這道檢查就是「一律不信代號」的恆真）
  assert.deepEqual(cardCode({ issuer: '台新銀行', issuerId: 'taishin' }), { state: 'ok', issuer: CARD_ISSUERS[0] }, '正式名稱');
  assert.deepEqual(cardCode({ issuer: '台新', issuerId: 'taishin' }), { state: 'ok', issuer: CARD_ISSUERS[0] }, '★別名也算確認');
  assert.deepEqual(cardCode({ issuer: '', issuerId: 'taishin' }), { state: 'ok', issuer: CARD_ISSUERS[0] }, '空白＝沒有東西可以牴觸');
  assert.deepEqual(cardCode({ issuer: '  ', issuerId: 'taishin' }), { state: 'ok', issuer: CARD_ISSUERS[0] }, '整串空白同理');
  assert.equal(cardCode({ issuer: '富邦', issuerId: 'fubon-hk' }).state, 'ok', '★歧義寫法含代號那一家＝確認（消歧正是清單的目的）');
  assert.equal(cardCode({ issuer: '富邦', issuerId: 'esun' }).state, 'unconfirmed', '歧義的兩家都不是代號那一家 ⇒ 說不清楚');
  // 沒有可解析的代號＝完全不走這條路（零回歸）
  for (const badId of [undefined, null, '', 123, ['taishin'], {}, '沒這個代號', 'TAISHIN']) {
    assert.deepEqual(cardCode({ issuer: '台新銀行', issuerId: badId }), { state: 'none' }, `代號 ${JSON.stringify(badId)} 不可解析`);
    assert.equal(cardIssuerBank({ issuer: '台新銀行', issuerId: badId }), issuerBank('台新銀行'), '★逐字退回文字判準');
  }
});

test('★★代號｜只認**卡片自己身上**的欄位，而且字串化炸不出來時 fail-closed（Codex #547 r3 第 1 條）', async () => {
  const { cardCode, cardIssuerText } = await import('../public/modules/card-issuers.js');
  // ①**原型鏈上的代號不算**：`Object.create({issuerId:'taishin'})` 這種形狀（原型污染、
  //   JSON 的 `__proto__` 都做得到）原本會讓一張**自己沒有代號**的卡憑空取得身分。
  const viaProto = Object.create({ issuerId: 'taishin', issuer: '台新銀行' });
  assert.deepEqual(cardCode(viaProto), { state: 'none' }, '★原型上的 issuerId 不算代號');
  assert.equal(cardIssuerBank(viaProto), '', '★連顯示名也只讀自己身上的 ⇒ 兩欄同一把尺');
  assert.equal(cardIssuerText(viaProto), '', '原型上的 issuer 不算顯示名');
  // 對照：同樣的值放在卡片**自己身上**就照舊算數（否則上面那格是「一律不認」的恆真）
  assert.deepEqual(cardCode({ issuerId: 'taishin', issuer: '台新銀行' }), { state: 'ok', issuer: CARD_ISSUERS[0] });
  // ②**連 `String()` 都炸的顯示名**（`{toString:null}` 這族——`cards.issuer` 沒有型別收斂，
  //   可經 CRUD 與備份匯入原樣落庫）不可以炸掉整份帳單預覽，而且要 fail-closed 成「說不清楚」。
  const bomb = { toString: null, valueOf: null };
  assert.throws(() => String(bomb), TypeError, '前提：這族值裸跑 String() 真的會炸');
  assert.deepEqual(cardCode({ issuerId: 'taishin', issuer: bomb }), { state: 'unconfirmed' },
    '★證明不了顯示名確認了代號 ⇒ 說不清楚（不可以當成「空的」而放行代號）');
  assert.equal(cardIssuerBank({ issuerId: 'taishin', issuer: bomb }), '');
  assert.equal(cardCertainlyNot({ issuerId: 'taishin', issuer: bomb }, '台新'), false, '★說不清楚＝擋自動歸');
  // ③沒有代號的那條路同樣不可以炸（本支唯一的零回歸例外，照實記：base 是丟 TypeError 炸掉預覽）
  assert.doesNotThrow(() => cardIssuerBank({ issuer: bomb }));
  assert.equal(cardIssuerBank({ issuer: bomb }), '', '★炸不出字串＝認不出機構 ⇒ 退成請使用者選');
  assert.doesNotThrow(() => cardCertainlyNot({ issuer: bomb }, '台新'));
  assert.doesNotThrow(() => issuerFormFields({ issuer: bomb, issuerId: 'taishin' }), '表單也不可以被炸掉');
  // ④非物件的卡片值不可以炸
  // ⚠️ 訊息用序號而不是 `String(weird)`——`Object.create(null)` 連 `String()` 都炸，
  //    第一版就是被自己的錯誤訊息炸掉的（這一題自己踩了它要測的那個坑）。
  const weirds = [null, undefined, 'card', 123, true, Object.create(null), Object.create({})];
  weirds.forEach((weird, i) => {
    assert.doesNotThrow(() => cardCode(weird), `cardCode(第 ${i} 個怪值) 不可丟例外`);
    assert.doesNotThrow(() => cardIssuerBank(weird), `cardIssuerBank(第 ${i} 個怪值) 不可丟例外`);
    assert.doesNotThrow(() => cardCertainlyNot(weird, '台新'), `cardCertainlyNot(第 ${i} 個怪值) 不可丟例外`);
  });
});

test('★代號｜正規化規則被動手腳時，有代號的卡最多只會「判不出來」，不會被指去別家', () => {
  // Codex #520 r3#1 的實測：在正規化器裡加一條對映，整卷考題照樣綠、`issuerBank('HSBC')` 變成 '台新'。
  // 本支對**有代號的卡**關掉的就是這條路——但關法不是「不讀正規化器」（`cardCode` 仍用它做確認），
  // 而是**結構上不可能指去別家**：確認得了 ⇒ 代號那一家；確認不了 ⇒ 判不出來。上一題的全組合檢查
  // 已經把這件事釘住，這裡補「文字那條路照舊」的對照，免得有人以為整條路都關了。
  assert.equal(issuerBank('臺新'), '台新', '前提：文字那條路會把「臺新」判成台新');
  assert.equal(cardIssuerBank({ issuerId: 'esun', issuer: '臺新' }), '',
    '★代號說玉山、顯示名說台新 ⇒ 判不出來（**不是**台新——r1 的「退回文字」在這裡會答台新）');
  assert.equal(cardIssuerBank({ issuer: '臺新' }), '台新',
    '★沒有代號的卡照舊走正規化器，那條通道對它們仍然開著（William 2026-09-02 裁示，本支刻意不改）');
});

// ───────────────────────── ② 判準（清單 → issuerBank）─────────────────────────

test('★判準｜清單上的每一項挑下去，`issuerBank` 都要給出它宣告的那一家', () => {
  for (const o of CARD_ISSUERS) assert.equal(issuerBank(o.name), o.bank, `挑「${o.name}」得到的不是 ${o.bank || '（不掛機構名）'}`);
});

test('★判準｜別名照筆數決定：唯一宣稱＝算那一家，兩家宣稱＝不猜', () => {
  for (const o of CARD_ISSUERS) {
    for (const a of o.aka || []) {
      const named = issuersNamed(a);
      if (named.length === 1) assert.equal(issuerBank(a), o.bank, `「${a}」唯一宣稱者是 ${o.name}，卻沒對出 ${o.bank}`);
      else assert.equal(issuerBank(a), '', `「${a}」被 ${named.length} 家宣稱，不可以判出身分`);
    }
  }
});

test('★判準｜清單裡沒有的寫法仍走樣式比對（自訂機構、清單化之前的自由文字都不可以整批失效）', () => {
  assert.equal(issuersNamed('台新國際商業銀行股份有限公司').length, 0, '前提：這個寫法不在清單上');
  assert.equal(issuerBank('台新國際商業銀行股份有限公司'), '台新');
  assert.equal(issuerBank('富邦銀行（香港）有限公司'), '', '★香港富邦不是台北富邦');
  assert.equal(issuerBank('富邦人壽'), '', '★保險公司不是發卡行');
});

// ───────────────────────── ③ 表單行為 ─────────────────────────

test('★表單｜既有的自由文字一律落到「其他」並原字帶進去——不可趁打開表單就靜靜改寫', () => {
  // 這個 repo 的前例：帳戶型別因為「現值不在選項裡」被瀏覽器選成第一項，
  // 使用者只改個名字按儲存，50 萬負債變 50 萬資產（見 public/modules/form-options.js 檔頭）。
  for (const legacy of ['台新', '富邦', '台北富邦', '某某會員俱樂部', '台新國際商業銀行股份有限公司']) {
    const v = issuerFormFields({ issuer: legacy });
    assert.equal(v.issuerPick, ISSUER_OTHER, `「${legacy}」不該被預選成清單上的某一項`);
    assert.equal(v.issuerOther, legacy, `「${legacy}」要原字帶進自訂欄`);
  }
});

test('表單｜正式寫法才預選；空值＝未設定（預選的值＝**代號**，不是名字）', () => {
  assert.deepEqual(issuerFormFields({ issuer: '台新銀行' }), { issuerPick: 'taishin', issuerOther: '' });
  assert.deepEqual(issuerFormFields({ issuer: '富邦銀行（香港）' }), { issuerPick: 'fubon-hk', issuerOther: '' });
  // William 三張真卡填的是「台新銀行」「台北富邦銀行」「遠東商銀」——三個都在清單上，打開表單就預選好
  for (const real of ['台新銀行', '台北富邦銀行', '遠東商銀']) {
    const entry = CARD_ISSUERS.find(o => o.name === real);
    assert.deepEqual(issuerFormFields({ issuer: real }), { issuerPick: entry.id, issuerOther: '' }, `既有卡片「${real}」要直接對上清單`);
  }
  assert.deepEqual(issuerFormFields({ issuer: '臺新銀行 ' }), { issuerPick: 'taishin', issuerOther: '' }, '同一個名字換個字形／多個空白＝同一項');
  for (const empty of ['', '   ', null, undefined]) assert.deepEqual(issuerFormFields({ issuer: empty }), { issuerPick: '', issuerOther: '' });
  assert.deepEqual(issuerFormFields(null), { issuerPick: '', issuerOther: '' }, '新增卡片＝沒有卡片物件');
});

test('★表單｜代號**可用**時才預選它；說不清楚的卡落回文字（與判準側同一把尺）', () => {
  assert.deepEqual(issuerFormFields({ issuerId: 'fubon-hk', issuer: '富邦銀行（香港）' }), { issuerPick: 'fubon-hk', issuerOther: '' });
  assert.deepEqual(issuerFormFields({ issuerId: 'taishin', issuer: '台新' }), { issuerPick: 'taishin', issuerOther: '' }, '別名＝確認得了');
  assert.deepEqual(issuerFormFields({ issuerId: 'taishin', issuer: '' }), { issuerPick: 'taishin', issuerOther: '' }, '空白＝沒有東西可以牴觸');
  assert.deepEqual(issuerFormFields({ issuerId: 'fubon-hk', issuer: '富邦' }), { issuerPick: 'fubon-hk', issuerOther: '' }, '★歧義寫法配代號＝消歧');
  // ★說不清楚 ⇒ **不可以預選代號那一項**（預選會讓使用者按個儲存就把它寫死）。
  //   落回文字那條路 ⇒ 預選「畫面上看到的那一家」⇒ 按儲存＝把兩欄修成一致（自我修復）。
  assert.deepEqual(issuerFormFields({ issuerId: 'fubon-hk', issuer: '台新銀行' }), { issuerPick: 'taishin', issuerOther: '' },
    '★預選的是顯示名那一家，不是代號那一家');
  assert.deepEqual(issuerFormFields({ issuerId: 'taishin', issuer: '我的某某卡' }), { issuerPick: ISSUER_OTHER, issuerOther: '我的某某卡' },
    '★清單認不得的顯示名 ⇒ 落到「其他」並原字帶進去（代號不被預選）');
});

test('★表單｜傳字串進 `issuerFormFields` 要當場丟例外（改名＋這道 typeof 是同一件事的兩半）', () => {
  // 改名（`issuerFormValues` → `issuerFormFields`）擋的是**沒跟上的舊呼叫端**；
  // 這道 typeof 擋的是**新寫的呼叫端手滑傳 `c.issuer`**——那會靜靜回一組空值，
  // 使用者按個儲存就把發卡行清空，而清空之後那張卡連「不確定」都算不上。
  assert.throws(() => issuerFormFields('台新銀行'), TypeError);
  assert.throws(() => issuerFormFields(''), TypeError, '空字串也是字串——同樣是傳錯東西');
});

test('表單｜送出時兩欄合回**要存的兩欄**（顯示名＋代號）', () => {
  assert.deepEqual(resolveIssuerFields('taishin', ''), { issuer: '台新銀行', issuerId: 'taishin' });
  assert.deepEqual(resolveIssuerFields('taishin', '殘留的舊字'), { issuer: '台新銀行', issuerId: 'taishin' },
    '★沒選「其他」就無視自訂欄（它隱藏時仍會被送出）');
  assert.deepEqual(resolveIssuerFields(ISSUER_OTHER, '  某某銀行 '), { issuer: '  某某銀行 ', issuerId: '' },
    '★自訂文字不 trim（Codex #520 r1#1：無條件 trim 會讓既有值在「什麼都不改」的儲存裡被靜靜改掉）；★自訂＝發不出代號');
  assert.deepEqual(resolveIssuerFields(ISSUER_OTHER, ''), { issuer: '', issuerId: '' }, '選了其他卻留白＝未設定');
  assert.deepEqual(resolveIssuerFields(ISSUER_OTHER, '   '), { issuer: '', issuerId: '' },
    '★整串空白視同沒填（否則卡片頁會判成「有填」印出一串看不見的空白）');
  assert.deepEqual(resolveIssuerFields('', ''), { issuer: '', issuerId: '' });
  assert.deepEqual(resolveIssuerFields('不是清單上的值', ''), { issuer: '不是清單上的值', issuerId: '' },
    '★下拉送回不認得的值（form-options 保留清單外現值那條路）⇒ 字保留、不可憑空發代號');
  // 清單上每一項挑下去，兩欄都要對得起來（不是只驗兩三個樣本）
  for (const o of CARD_ISSUERS) {
    assert.deepEqual(resolveIssuerFields(o.id, ''), { issuer: o.name, issuerId: o.id }, `挑「${o.name}」存錯了`);
  }
});

test('★表單｜字串 issuer 打開表單、什麼都不改就儲存＝只有三種行為：原字保存／正式名稱收斂／純空白清空（另有兩條見 resolveIssuerFields 檔內）', () => {
  const roundTrip = (/** @type {string} */ x) => { const v = issuerFormFields({ issuer: x }); return resolveIssuerFields(v.issuerPick, v.issuerOther).issuer; };
  // ①**原字保存**：自訂值與別名一個字元都不動（含頭尾空白——r1#1 實測第一版會靜靜 trim 掉）
  for (const x of ['', '台新', '富邦', '台新銀行', '富邦銀行（香港）', '遠東商銀', '某某會員俱樂部',
    ' 某某會員俱樂部 ', '富邦 ', ' 台新']) {
    assert.equal(roundTrip(x), x, `「${x}」被表單改掉了`);
  }
  // ⚠️ **會動到既有值的只有下面兩格**（Codex #520 r2#3／r3#2：這裡曾有三句各自寫「唯一」、互相打架）。
  //    正本＝`card-issuers.js` 的 `resolveIssuerFields` 檔內那份逐條列名，本題只負責把它們釘成行為。
  // ②**整串空白 → 空字串**：兩者在畫面與行為上本來就等價（都顯示「未設定」、都不參與歸卡）
  assert.equal(roundTrip('   '), '', '★純空白視同未設定——這一格刻意不 round-trip');
  // ③**正式名稱的另一種字形 → 收斂成清單寫法**（要使用者按下儲存才會發生，而且必須還是同一家）
  for (const [before, after] of [
    ['臺新銀行', '台新銀行'],
    ['台 新 銀 行', '台新銀行'],
    ['富邦銀行(香港)', '富邦銀行（香港）'],
  ]) {
    assert.equal(roundTrip(before), after, `「${before}」應收斂成清單正式寫法`);
    assert.equal(issuerNameKey(roundTrip(before)), issuerNameKey(before), '★而且必須還是同一家');
  }
});

test('★表單｜**帶代號**的 round-trip：顯示名跟著身分走，不認得的代號會被換掉（`resolveIssuerFields` 檔內清單的行為面）', () => {
  // ⚠️ 這一題 2026-09-02 補（預審抓到）：上一題的 helper 只餵 `{issuer: x}`、從不餵 `issuerId`，
  //    所以 `resolveIssuerFields` 檔內那份「既有值會不會變」的逐條列名，**代號那兩格一格都沒釘到**，
  //    而它自己還寫著「每一條都由 round-trip 題釘住」——宣稱大於考題。
  const rt = (/** @type {any} */ card) => {
    const v = issuerFormFields(card);
    return resolveIssuerFields(v.issuerPick, v.issuerOther);
  };
  // ①資料一致的卡＝原封不動（冪等；正常操作存進去的都長這樣）
  assert.deepEqual(rt({ issuer: '台新銀行', issuerId: 'taishin' }), { issuer: '台新銀行', issuerId: 'taishin' });
  assert.deepEqual(rt({ issuer: '富邦銀行（香港）', issuerId: 'fubon-hk' }), { issuer: '富邦銀行（香港）', issuerId: 'fubon-hk' });
  // ②代號查得到、顯示名是空的 ⇒ 補上正式名稱（代號才是身分，顯示名跟著它走）
  assert.deepEqual(rt({ issuer: '', issuerId: 'fubon-hk' }), { issuer: '富邦銀行（香港）', issuerId: 'fubon-hk' });
  // ③★**資料互相矛盾時，按儲存＝把代號修正成與顯示名一致**（Codex #547 r1 第 1 條之後改成這樣）。
  //   舊版是反過來的（顯示名跟著代號走），那會讓一張畫面寫著甲的卡靜靜變成乙——而矛盾最常見的
  //   來源是「升級後沒重新整理的舊分頁只送了 issuer」，那時**使用者看到的、要的就是顯示名那一家**。
  assert.deepEqual(rt({ issuer: '玉山銀行', issuerId: 'taishin' }), { issuer: '玉山銀行', issuerId: 'esun' },
    '★代號被修正成顯示名那一家（自我修復），顯示名一個字不動');
  assert.deepEqual(rt({ issuer: '台北富邦銀行', issuerId: 'taishin' }), { issuer: '台北富邦銀行', issuerId: 'fubon-taipei' },
    '★Codex 那張卡：按一次儲存就修好了');
  // ④★**不認得的代號**：檔內第一版寫「代號清成 '' 且顯示字串不動」——**兩半都不總是對**
  assert.deepEqual(rt({ issuer: '臺新銀行', issuerId: 'zzz' }), { issuer: '台新銀行', issuerId: 'taishin' },
    '★顯示字串照樣會被收斂，而且代號被寫成合法的那一個（不是清成空）');
  assert.deepEqual(rt({ issuer: '玉山銀行', issuerId: 'esun-old' }), { issuer: '玉山銀行', issuerId: 'esun' },
    '★不認得的舊代號被換成清單上的合法代號');
  assert.deepEqual(rt({ issuer: '某某會員俱樂部', issuerId: 'zzz' }), { issuer: '某某會員俱樂部', issuerId: '' },
    '★清單認不得名字時才真的是「原字保存＋代號清空」——這才是檔內原句成立的那一格');
  // ⑤非字串代號＝視同沒有代號，逐字等於只有字串時的答案（零回歸）
  for (const badId of [123, null, undefined, ['taishin'], {}, true]) {
    assert.deepEqual(rt({ issuer: '台新', issuerId: badId }), rt({ issuer: '台新' }),
      `★代號 ${JSON.stringify(badId)} 不可以走到與「沒有代號」不同的答案`);
  }
  assert.deepEqual(rt({ issuer: '台新' }), { issuer: '台新', issuerId: '' }, '對照：別名落到「其他」＝原字保存、發不出代號');
});

test('表單｜下拉選項＝（未設定）在最前、其他在最後；值是**代號**、標籤才是名字', () => {
  const opts = issuerOptions();
  assert.deepEqual(opts[0], { value: '', label: ISSUER_UNSET_LABEL });
  assert.deepEqual(opts[opts.length - 1], { value: ISSUER_OTHER, label: ISSUER_OTHER_LABEL });
  assert.equal(opts.length, CARD_ISSUERS.length + 2);
  assert.equal(new Set(opts.map(o => o.value)).size, opts.length, '選項的值不可重複（重複＝挑不到其中一項）');
  assert.deepEqual(opts.slice(1, -1), CARD_ISSUERS.map(o => ({ value: o.id, label: o.name })),
    '★選項的值＝代號、標籤＝名字，順序照清單（值放名字＝送回來的還要再翻譯一次，那一步會走鐘）');
  assert.equal(issuersNamed(ISSUER_OTHER).length, 0, '★「其他」的哨兵值不可以是任何一家的名字或別名');
  assert.equal(issuerById(ISSUER_OTHER), null, '★「其他」的哨兵值也不可以是任何一家的代號');
});

test('★型別｜非字串 issuer 的容忍界線——不崩、不多給身分（#520 r3#2 加過型別牆、r4#1 撤回）', async () => {
  // 為什麼**不**加 `FIELD_SCHEMA.cards.issuer = 'str'`：理由逐條寫在 `lib/schema.js` 那一格
  //（升級前的壞值會讓每一次整庫寫入炸掉，而型別牆買不到對應的好處）。
  // ⚠️ 這裡**刻意不寫** `assert.equal('issuer' in FIELD_SCHEMA.cards, false)` 那種「反向護欄」：
  //    它斷言的是 schema 的形狀，不是它訊息裡宣稱的那個危害——那正是這個 repo 記過的假護欄
  //    （護欄不能自己證明自己有在跑）。要釘就釘**行為**。
  const { issuerBank } = await import('../lib/card-identity.js');
  for (const bad of [{ unexpected: true }, 123, true, {}, ['台北富邦銀行', '玉山']]) {
    // ①不崩：讀取端一律 `String()` 包好，這是這個欄位今天安全的**唯一**理由
    assert.doesNotThrow(() => issuerBank(bad), `issuerBank(${JSON.stringify(bad)}) 不可丟例外`);
    assert.doesNotThrow(() => issuerFormFields({ issuer: bad }));
    assert.doesNotThrow(() => cardIssuerBank({ issuer: bad }), '卡片版同樣不可丟例外');
    // ②不多給身分：壞型別的答案 **等於** 它字串化之後的答案（兩邊走同一個 String()）
    assert.equal(issuerBank(bad), issuerBank(String(bad)), '★壞型別不可以走到與字串化不同的答案');
  }
  // ⚠️ **誠實劃界：非字串「不是一律判不出身分」**——陣列被 String() 攤平後剛好等於合法寫法就會判得出來。
  //    這與使用者直接打那串字同義（base 也是這樣），所以不是本支的洞；但不寫下來就會變成假保證。
  assert.equal(issuerBank(['台新']), '台新', '★String(["台新"]) === "台新" ⇒ 判得出來，這是既有行為');
  assert.equal(issuerBank({ unexpected: true }), '', '對照：物件字串化成 [object Object] ⇒ 判不出來');
});

test('★櫃檯｜`issuerId` 真的存得進去（純函式全對、白名單漏了它＝代號永遠寫不進資料庫）', async () => {
  const { pickWritable } = await import('../lib/schema.js');
  // ⚠️ 打的是**正式的**櫃檯函式，不是斷言 `WRITABLE_FIELDS.cards` 的形狀——後者是「護欄自己證明
  //    自己有在跑」那種假護欄（這個 repo 記過）。要釘就釘行為：送進去、看它有沒有活著出來。
  const picked = pickWritable('cards', { name: '台新卡', issuer: '台新銀行', issuerId: 'taishin' });
  assert.deepEqual(picked.errors, [], '不可以有欄位被判成非法');
  assert.equal(picked.value.issuerId, 'taishin', '★代號被櫃檯剝掉＝這支 PR 在真實流程裡完全沒生效');
  assert.equal(picked.value.issuer, '台新銀行', '顯示名照舊要存得進去');
  // 清空代號（挑「其他」時送空字串）也要送得進去，否則舊代號會被 PUT 的部分合併永遠留著
  assert.equal(pickWritable('cards', { issuerId: '' }).value.issuerId, '', '★空字串＝清掉代號，不可以被當「沒送」丟掉');
  // 對照：白名單外的表單自用欄位確實會被剝掉（證明上面那兩格不是「什麼都收」的恆真）
  const junk = pickWritable('cards', { issuerPick: 'taishin', issuerOther: '某某銀行' });
  assert.equal('issuerPick' in junk.value, false, '★表單自用欄位不可以進資料庫');
  assert.equal('issuerOther' in junk.value, false);

  // ★★**兩欄是同一個身分的兩半**（Codex #547 r1 第 1 條，高、阻擋）：
  //   `PUT` 是部分更新、`lib/repo.js` 淺合併 ⇒ 只送 `issuer` 會**留下前一次的代號**。
  //   升級後沒重新整理的**舊分頁**跑的是舊版 `cards.js`（只送 `issuer`）⇒ 按一次儲存就產生矛盾的卡。
  assert.deepEqual(pickWritable('cards', { issuer: '台北富邦銀行' }).value, { issuer: '台北富邦銀行', issuerId: '' },
    '★送了顯示名卻沒送代號 ⇒ 代號要一起清掉（否則會留下「畫面寫甲、代號是乙」的卡）');
  assert.deepEqual(pickWritable('cards', { issuer: '' }).value, { issuer: '', issuerId: '' },
    '★清空顯示名同理——不可以留下一個看不見的代號還在授予身分');
  // 反向的兩個對照組（缺一就變成「一律清掉」的恆真護欄）：
  assert.equal(pickWritable('cards', { name: '只改卡片名稱' }).value.issuerId, undefined,
    '★沒送 issuer 的 PUT 不可以順手把代號清掉（那會讓每一次改名都降級一張卡）');
  assert.deepEqual(pickWritable('cards', { issuer: '台新銀行', issuerId: 'taishin' }).value,
    { issuer: '台新銀行', issuerId: 'taishin' }, '★兩欄都送＝正常表單，原樣收下');
  // ★**只做一個方向**：反過來只送代號時**不可以**替使用者補一段他沒打過的顯示名
  //   （Codex #547 r2 第 5 條：這句宣稱原本沒有考題撐著）。
  const onlyCode = pickWritable('cards', { issuerId: 'taishin' }).value;
  assert.deepEqual(onlyCode, { issuerId: 'taishin' },
    '★只送代號 ⇒ 原樣收下、**不得多出 issuer**（櫃檯不替使用者編畫面文字；那個方向的安全由 cardCode 收口）');
});

// ───────────────────────── ④ 接線（讀原始碼）─────────────────────────

/**
 * 接線判準——正常題與突變題**必須呼叫同一個 helper**：判準抄成兩份就會走散，
 * 走散之後突變題斷言的不再是接線題會不會紅，而是那份過期副本（＝自我證明）。
 * @param {string} src public/modules/cards.js 的原始碼
 */
function assertPicklistWiring(src) {
  assert.match(src, /import \{[^}]*issuerOptions[^}]*\} from '\.\/card-issuers\.js';/);
  assert.match(src, /\{ key: 'issuerPick', label: '發卡銀行 \/ 機構', type: 'select', options: issuerOptions\(\) \}/,
    '★發卡行必須是 select＋清單，不可以是自由文字框');
  assert.match(src, /\{ key: 'issuerOther',[^\n]*type: 'text'/, '★清單以外的機構要填得進去（其他＝自行輸入）');
  assert.match(src, /values: c \? \{[^\n]*\.\.\.issuerFormFields\(c\)/, '★編輯既有卡片時要把**整張卡**餵回表單（只餵 c.issuer 會漏掉代號）');
  assert.match(src, /const picked = resolveIssuerFields\(data\.issuerPick, data\.issuerOther\);/,
    '★送出前要由同一支函式算出兩欄');
  assert.match(src, /data\.issuer = picked\.issuer; data\.issuerId = picked\.issuerId;/,
    '★兩欄都要存——只存 issuer 就等於這支 PR 沒做（代號永遠不會被寫進去）');
  assert.match(src, /delete data\.issuerPick; delete data\.issuerOther;/,
    '★issuerPick／issuerOther 不是 schema 欄位、不可以送到後端');
  assert.match(src, /cell\.hidden = sel\.value !== ISSUER_OTHER/, '★自訂欄只在選了「其他」時出現');
}

test('★接線｜卡片表單真的用了清單（純函式全對、沒接上去＝使用者看到的還是自由文字框）', () => {
  assertPicklistWiring(read('public/modules/cards.js'));
});

test('★接線｜「為什麼要從清單挑」有就地解釋（專案鐵則：不可只寫在文件裡）', () => {
  const src = read('public/modules/cards.js');
  assert.match(src, /id="issuerInfo"/, '卡片頁要有那個說明入口');
  assert.match(src, /byId\('issuerInfo'\)\.onclick = \(\) => openInfo\([^)]*ISSUER_INFO_HTML\)/, '入口要真的接上說明窗');
  const copy = src.slice(src.indexOf('const ISSUER_INFO_HTML'), src.indexOf('const TYPE_LABEL'));
  for (const must of ['台北富邦', '香港', '其他（自行輸入）']) {
    assert.ok(copy.includes(must), `說明文案少了「${must}」——講不清楚為什麼要改，使用者只會覺得表單變難用`);
  }
  // ⚠️ 判準只擋這三個 token，訊息就只能說這三個（工作流 2026-08-28：原訊息寫「不可出現英文技術詞」
  //    是通則，而文案裡本來就有「AI」照樣綠 ⇒ 訊息大於判準，下一個人會以為英文詞已被機械把關）。
  assert.equal(/[Bb]ank|API|schema/.test(copy), false, '文案不可出現 Bank／API／schema 這三個程式術語');
});

/**
 * 文案邊界判準——正常題與突變題必須呼叫同一個 helper（同 assertPicklistWiring 的理由）。
 * @param {string} copy 說明窗那段文案 @param {string} doc 運作說明全文
 */
function assertCopyBoundaries(copy, doc) {
  assert.ok(copy.includes('不等於帳單一定會自動對上'), '★說明窗要講清楚「挑清單」與「看得懂帳單格式」是兩件事');
  assert.ok(doc.includes('挑了清單不等於帳單就會自動對上'), '★運作說明也要有同一條邊界');
  for (const banned of ['不會少記、也不會記錯', '永遠不會卡住或默默記錯']) {
    assert.equal(doc.includes(banned), false, `★運作說明出現撐不住的保證「${banned}」`);
    assert.equal(copy.includes(banned), false, `★說明窗出現撐不住的保證「${banned}」`);
  }
}

test('★文案｜不可承諾程式撐不住的事（Codex #520 r1#2／r2#2／r2#4）', () => {
  const src = read('public/modules/cards.js');
  const doc = read('docs/帳單匯入與分類-運作說明.md');
  const copy = src.slice(src.indexOf('const ISSUER_INFO_HTML'), src.indexOf('const TYPE_LABEL'));

  // ①「挑了清單就會自動認卡」是假的：清單絕大多數機構沒有內建範本 ⇒ 挑了也掛不上機構身分。
  //    這一題把那個前提**用行為釘住**，文案只要再滑回去承諾自動認卡，前提與文案就會一起被看到。
  const listedWithoutTemplate = CARD_ISSUERS.filter(o => o.bank === '');
  assert.ok(listedWithoutTemplate.length > 0, '前提：清單上大多數銀行沒有內建範本');
  for (const o of listedWithoutTemplate.slice(0, 5)) {
    // ⚠️ 這一題**只**斷言「挑了它仍然掛不上內建範本」——**不**推論它下游會走哪一條退路
    //    （Codex #520 r3#3：原本的訊息寫「⇒ 帳單照樣要手選」，那句沒有跑過解析流程，是推論不是證據）。
    assert.equal(issuerBank(o.name), '', `★挑「${o.name}」仍然掛不上內建範本`);
  }
  assertCopyBoundaries(copy, doc);

  // ④「讀不懂版面」與「讀得懂但認不出卡片」是**兩條不同的退路**，文案不可混成一條（r3#3）。
  //    正式路徑：兩支解析器都讀不到列（或證據指向別家）⇒ `lib/statement.js` 先丟 `card_unrecognized`，
  //    **根本走不到選卡窗**；選卡窗只發生在明細已經抽出來之後。
  assert.ok(copy.includes('整個讀不懂'), '★說明窗要把「整份讀不動」單獨講出來');
  assert.ok(copy.includes('不會') && copy.includes('跳出選卡'), '★而且要說清楚那種情況不會跳出選卡');
  assert.ok(doc.includes('card_unrecognized'), '★運作說明要指到真正會丟的那個錯');

  // ②不可出現絕對保證——`lib/card-identity.js` 自己就記著相容比對可能誤命中。
  // ⚠️ **誠實劃界**：這裡釘的是**實際寫過、而且被 Codex 抓出來拿掉的那兩句**，外加要求兩處的免責句還在。
  //    它**不證明**「文案裡沒有任何過度宣稱」——換一種說法寫的新保證，這一題看不出來
  //    （列舉補不完；這個 repo 對這種情形的規矩是照實劃界，不是假裝擋得住）。
  assert.ok(doc.includes('不等於「絕不會判錯」'), '★運作說明的保底原則要自己說出它的極限');
  assert.ok(doc.includes('不承諾「永遠不會記錯」'), '★發卡行那段的免責句要在');

  // ③自訂值仍走相容比對——文案不可反過來說「自己打的一定認不出來」。
  assert.equal(issuerBank('台新國際商業銀行股份有限公司'), '台新', '前提：清單外的寫法仍走樣式比對');
  assert.ok(copy.includes('先用舊的方式盡量認'), '★說明窗要講出「自訂值仍會先被盡量認」的實況');
});

test('★真 DOM｜「其他」的文字框只在選了其他時出現，切換選項會即時跟著（jsdom，跑的是正式 onMount 程式碼）', async () => {
  const { JSDOM } = await import('jsdom');
  const { selectOptionsHtml } = await import('../public/modules/form-options.js');
  const src = read('public/modules/cards.js');

  // 取出**正式的** onMount 函式本體（不是另寫一份）——改壞它這一題就會紅
  const start = src.indexOf('onMount: (root) => {');
  const end = src.indexOf('\n    },\n    onSubmit:', start);
  assert.ok(start >= 0 && end > start, '找不到卡片表單的 onMount（接線改名了就要更新這一題）');
  const body = src.slice(src.indexOf('{', start) + 1, end);
  const runOnMount = new Function('root', 'ISSUER_OTHER', body);

  /** 重建 `openForm` 對這兩格欄位產出的 DOM（欄位包在一個 div 裡，select 用同一支選項產生器）。 */
  const build = (/** @type {string} */ issuerValue) => {
    const dom = new JSDOM(`<!doctype html><body><div class="modal-bg"><div class="modal-sm"><form><div class="form-grid">
      <div><label>發卡銀行 / 機構</label><select id="f_issuerPick">${selectOptionsHtml(issuerOptions(), issuerValue)}</select></div>
      <div><label>其他發卡銀行 / 機構名稱</label><input id="f_issuerOther" type="text" value="" /></div>
    </div></form></div></div></body>`);
    const root = dom.window.document.body;
    return { dom, root, sel: root.querySelector('#f_issuerPick'), cell: root.querySelector('#f_issuerOther').closest('div') };
  };

  // ①清單上的正式寫法 ⇒ 自訂欄收起來
  {
    const { root, sel, cell } = build(issuerFormFields({ issuer: '台新銀行' }).issuerPick);
    runOnMount(root, ISSUER_OTHER);
    assert.equal(sel.value, 'taishin', '前提：下拉選中清單上那一項（值＝代號）');
    assert.equal(cell.hidden, true, '★挑了清單上的銀行，「其他」的文字框不該出現');
  }
  // ②既有自由文字（落到「其他」）⇒ 自訂欄要看得見，否則使用者看不到自己現在填的是什麼
  {
    const { root, sel, cell } = build(issuerFormFields({ issuer: '富邦' }).issuerPick);
    runOnMount(root, ISSUER_OTHER);
    assert.equal(sel.value, ISSUER_OTHER, '前提：既有自由文字落到「其他」');
    assert.equal(cell.hidden, false, '★落到「其他」時文字框必須看得見');
  }
  // ③使用者當場切換 ⇒ 要即時跟著（這是 onMount 唯一的動態行為）
  {
    const { dom, root, sel, cell } = build('');
    runOnMount(root, ISSUER_OTHER);
    assert.equal(cell.hidden, true, '前提：一開始是（未設定）⇒ 收起來');
    sel.value = ISSUER_OTHER;
    sel.dispatchEvent(new dom.window.Event('change'));
    assert.equal(cell.hidden, false, '★切到「其他」要即時打開');
    sel.value = 'fubon-taipei';
    sel.dispatchEvent(new dom.window.Event('change'));
    assert.equal(cell.hidden, true, '★切回清單上的銀行要即時收起來');
  }
});

test('★升級提示｜只在「挑下去真的有終點」時出現，挑完就消失（跑的是正式 `issuerUpgradeNote` 程式碼）', () => {
  const src = read('public/modules/cards.js');
  // 取出**正式的**函式本體（同 onMount 那題的做法）——改壞它這一題就會紅
  const start = src.indexOf('function issuerUpgradeNote(c) {');
  assert.ok(start >= 0, '找不到 issuerUpgradeNote（改名了就要更新這一題）');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, '找不到 issuerUpgradeNote 的結尾');
  const body = src.slice(src.indexOf('{', start) + 1, end);
  const note = new Function('c', 'esc', 'cardCode', 'issuersNamed', body).bind(null);
  const run = (/** @type {any} */ c) => note(c, (/** @type {string} */ x) => String(x), cardCode, issuersNamed);

  // ①**代號可用** ⇒ 升級完了，不再提示（提示清得掉，這是它不會變成嘮叨的理由）
  assert.equal(run({ issuerId: 'taishin', issuer: '台新銀行' }), '');
  assert.equal(run({ issuerId: 'taishin', issuer: '台新' }), '', '別名也算升級完了');
  // ①b★**說不清楚的卡也要提示**（Codex #547 r3 第 2 條）：第一版只問「查不查得到代號」，
  //    於是這種卡**既失去自動歸卡、又看不到修復入口**；清單日後改名就會把正常舊卡推進這一格。
  const unconfirmed = run({ issuerId: 'taishin', issuer: '台北富邦銀行' });
  assert.match(unconfirmed, /對不起來/, '★兩欄對不起來要講出來');
  assert.match(unconfirmed, /現在要你自己選/, '★而且要說清楚現在的後果');
  assert.equal(cardIssuerBank({ issuerId: 'taishin', issuer: '台北富邦銀行' }), '', '前提：這張卡現在真的判不出身分');
  assert.notEqual(run({ issuerId: 'taishin', issuer: '我的某某卡' }), '', '★清單認不得的顯示名也是說不清楚，照樣要提示');
  // ②**清單認得這個寫法、但還沒有代號** ⇒ 提示（今天照舊會自動，所以講的是「可以更保險」）
  const legacy = run({ issuer: '台新銀行' });
  assert.match(legacy, /card-issuer-upgrade/);
  assert.match(legacy, /可以更保險/);
  assert.equal(/要動一下/.test(legacy), false, '★不是歧義卡，不可以說得像現在壞掉了');
  assert.equal(run({ issuer: '台新' }), legacy, '★別名也要提示——那正是清單化之前最常見的寫法');
  // ③**歧義寫法** ⇒ 這張卡**現在就**判不出身分＝帳單已經要手選，話要講重一點
  const ambiguous = run({ issuer: '富邦' });
  assert.match(ambiguous, /要動一下/);
  assert.match(ambiguous, /現在要你自己選/);
  // ★家數必須是**算出來的**。⚠️ 只斷言 `/2 家/` 分辨不出「算出來的 2」與「寫死的 2」——
  //    今天清單上唯一的歧義寫法就是被 2 家宣稱（預審 2026-09-02 實測：把 `${named.length}` 寫死成
  //    `2`，全卷零題轉紅）。改成**注入一個回三筆的替身**，一行就把它釘住。
  const fake3 = () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const injected = note({ issuer: '富邦' }, (/** @type {string} */ x) => String(x), cardCode, fake3);
  assert.match(injected, /3 家/, '★家數寫死的話這裡會印 2——它必須跟著 issuersNamed 的筆數走');
  assert.equal(cardIssuerBank({ issuer: '富邦' }), '', '★前提：這張卡今天確實判不出身分（否則上面那句話是假的）');
  // ④**清單裡沒有這個寫法** ⇒ 不提示（挑下去只能選「其他」，提示了也清不掉＝永遠的嘮叨）
  for (const x of ['某某會員俱樂部', '台新國際商業銀行股份有限公司', '', '   ', null, undefined]) {
    assert.equal(run({ issuer: x }), '', `★「${x}」挑下去沒有終點，不可以提示`);
  }
  // ⑤**只提示信用卡**。另外兩種都不提示，理由不同（預審 2026-09-02 抓到第一版把簽帳卡算進來）：
  assert.notEqual(run({ type: 'credit', issuer: '台新銀行' }), '');
  assert.notEqual(run({ issuer: '台新銀行' }), '', 'type 缺席＝信用卡');
  assert.equal(run({ type: 'membership', issuer: '台新銀行' }), '', '會員卡沒有帳單要歸');
  assert.equal(run({ type: 'debit', issuer: '台新' }), '',
    '★簽帳金融卡不提示：它有帳單要歸，但**那條路不讀代號** ⇒ 挑清單一個結果都改不了（見下面的前提斷言）');
  // ⚠️ 「為什麼簽帳卡不提示」的前提**用行為題釘**，不在這裡掃原始碼（Codex #547 r1 第 2 條：
  //    第一版掃 `/issuerId/` 字面，換個等價寫法就量不到；另一格正則還數到了不相干的字串）：
  //      ・`test/statement-pipeline.test.js` 的 **J14**＝簽帳卡不進 `previewAuto` 的族群（代號那條路）
  //      ・`test/debit-card-ledger.test.js` 的 **★簽帳卡歸卡只看 issuer 文字**＝真的跑一次配對流程
  //    那兩題在「簽帳卡開始讀代號」那天會轉紅，正好提醒回來重新決定提示範圍。
  // ⑥壞代號＝視同沒有代號 ⇒ 落回下面的判準（清單認得這個寫法 ⇒ 提示）
  assert.notEqual(run({ issuerId: '沒這個代號', issuer: '台新銀行' }), '');
  assert.equal(run({ issuerId: '沒這個代號', issuer: '某某會員俱樂部' }), '', '壞代號＋清單認不得的名字＝挑下去沒有終點，不提示');

  // ⑦★**提示不可以承諾「現在照舊會自動」**（自審 2026-09-02 抓到的過度宣稱）：
  //   同一句話也會印在**沒有內建範本**的機構上，那些卡的帳單從來沒有自動過。
  const noTemplate = CARD_ISSUERS.find(o => o.bank === '' && (o.aka || []).length === 0);
  assert.ok(noTemplate, '前提：清單上有沒有內建範本的機構');
  assert.equal(cardIssuerBank({ issuer: noTemplate.name }), '',
    `前提：「${noTemplate.name}」掛不上內建範本＝它的帳單本來就不會自動歸`);
  const noTemplateNote = run({ issuer: noTemplate.name });
  assert.notEqual(noTemplateNote, '', `前提：「${noTemplate.name}」這種卡確實會看到提示`);
  for (const banned of ['照舊會自動', '一樣會自動', '照樣會自動']) {
    assert.equal(noTemplateNote.includes(banned), false,
      `★提示對「${noTemplate.name}」說「${banned}」＝對使用者的錢說假話（它從來沒有自動過）`);
  }

  // ⑧★**歧義那一支也不可以承諾「自動」**（預審 2026-09-02：e09dced 只修了上面那一支）。
  //   前提：歧義的兩個選項裡**有一個沒有內建範本**（富邦銀行（香港）——那正是這份清單存在的理由），
  //   照著提示去挑它的人，挑完永遠不會自動對上。
  const shared = issuersNamed('富邦');
  assert.equal(shared.length, 2, '前提：「富邦」被兩家宣稱');
  assert.ok(shared.some(o => o.bank === ''), '前提：歧義的選項裡有一家沒有內建範本');
  assert.equal(cardIssuerBank({ issuerId: shared.find(o => o.bank === '').id }), '',
    '前提：挑了那一家之後仍然掛不上範本＝帳單不會自動對上');
  for (const banned of ['恢復自動', '自動對上', '就會自動', '就恢復']) {
    assert.equal(ambiguous.includes(banned), false,
      `★歧義提示說「${banned}」＝對挑到香港富邦的那一半使用者說假話`);
  }
  assert.match(ambiguous, /分得出這是哪一家/, '★能承諾的只有「程式從此分得出是哪一家」');
  assert.match(ambiguous, /另一件事/, '★而且要當場說清楚「會不會自動記帳」是另一回事');
  // ⚠️ **誠實劃界**：上面的禁語是**列舉**，補不完——換一種說法寫的新承諾這一題看不出來
  //    （同本檔文案題的既有劃界）。真正撐住這一格的是那兩句正向斷言＋前提斷言
  //    （歧義選項裡真的有一家沒有內建範本），不是禁語表。
});

test('★升級提示｜有接到卡片面板上，而且機構名有跳脫', () => {
  const src = read('public/modules/cards.js');
  assert.match(src, /\$\{issuerUpgradeNote\(c\)\}/, '★算出來卻沒渲染＝使用者永遠看不到，等於沒做');
  // ⚠️ 誠實劃界：`esc(c.issuer)` 今天**沒有可達的惡意輸入**——那一格只在「寫法被兩家宣稱」時才印，
  //    而被宣稱的寫法只有「富邦」「富邦銀行」兩個（`issuerNameKey` 抹平之後仍要相等，塞得進標籤的
  //    字元都會讓它對不上）。所以這是防禦性的，不是修一個活著的洞——但缺了它，日後多一個共用寫法
  //    就會變成活的。這一題只釘「有呼叫 esc」，不宣稱它擋下過什麼。
  assert.match(src, /esc\(c\.issuer\)/, '★提示裡的機構名要過 esc');
});

// ───────────────────────── ⑤ 突變：拿掉守門會不會紅 ─────────────────────────

test('★突變｜接線題與文案題拿掉守門會紅（跑的是**同一份**判準函式，不是抄一份）', () => {
  // ⚠️ 突變後的內容必須餵**原題用的那份**判準函式、斷言它 throw——把 regex／字串抄一份
  //    再自己斷言是**自我證明**：判準走散時，突變題斷言的是過期副本，不是原題會不會紅。
  const src = read('public/modules/cards.js');
  const doc = read('docs/帳單匯入與分類-運作說明.md');
  const copyOf = (/** @type {string} */ s2) => s2.slice(s2.indexOf('const ISSUER_INFO_HTML'), s2.indexOf('const TYPE_LABEL'));
  // 基準：未突變時兩份判準都要綠（否則下面的 throws 是恆真）
  assertPicklistWiring(src);
  assertCopyBoundaries(copyOf(src), doc);
  // 接線①：發卡行欄改回自由文字框
  const broken = src.replace("type: 'select', options: issuerOptions()", "type: 'text', placeholder: '例：台新銀行'");
  assert.notEqual(broken, src, '突變目標必須存在');
  assert.throws(() => assertPicklistWiring(broken), '★改回自由文字框，接線判準要紅');
  // 接線②：拿掉兩欄合併
  const noMerge = src.replace('data.issuer = picked.issuer; data.issuerId = picked.issuerId;', 'data.issuer = picked.issuer;');
  assert.notEqual(noMerge, src, '突變目標必須存在');
  assert.throws(() => assertPicklistWiring(noMerge), '★只存顯示名、不存代號，接線判準要紅（那等於整支 PR 沒做）');
  // 接線③：把整張卡改回只餵 `c.issuer`（代號在 values 這一步就被漏掉，表單看起來完全正常）
  const strFed = src.replace('...issuerFormFields(c),', '...issuerFormFields(c.issuer),');
  assert.notEqual(strFed, src, '突變目標必須存在');
  assert.throws(() => assertPicklistWiring(strFed), '★只餵 c.issuer，接線判準要紅');
  // 文案①：把「挑清單≠自動認卡」那句改掉
  const noBoundary = src.replace('不等於帳單一定會自動對上', '一定會自動對上');
  assert.notEqual(noBoundary, src, '突變目標必須存在');
  assert.throws(() => assertCopyBoundaries(copyOf(noBoundary), doc), '★邊界句被改掉，文案判準要紅');
  // 文案②：把絕對保證加回運作說明
  const absolute = doc.replace('**不會卡住**', '**永遠不會卡住或默默記錯**');
  assert.notEqual(absolute, doc, '突變目標必須存在');
  assert.throws(() => assertCopyBoundaries(copyOf(src), absolute), '★絕對保證復活，文案判準要紅');
});
