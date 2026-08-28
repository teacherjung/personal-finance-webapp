// @ts-check
// 發卡行「可選清單」的考題（William 2026-08-28 指派：把 `card.issuer` 從自由文字改成清單＋自訂）。
//
// ## 這一支在守什麼
//
// 自由文字**本身就無法消歧**：香港富邦官方自稱「富邦銀行」、台北富邦官方沿革同樣記載這個簡稱，
// 所以「把香港卡的發卡行填成精確的『富邦』」是合理且可達的輸入。判成台北富邦＝台北富邦的帳單
// 自動歸到香港卡上（**錢記到錯的卡**）。清單把歧義消在**輸入的當下**。
//
// 三類題目，各自守不同的東西：
//   ①**資料紀律**（清單本身）：名字兩兩不同、`bank` 不可亂填、新增一家不可以碰巧撞上內建範本。
//   ②**行為**（純函式）：既有資料打開表單不會被靜靜改掉、送出時兩欄合回一欄。
//   ③**接線**（讀原始碼）：`public/modules/cards.js` 真的用了這三個函式——純函式全對、但沒接上去，
//     使用者看到的還是舊的自由文字框。
//
// ## ⚠️ 誠實劃界
//
// - **擋不住「清單漏了某一家銀行」**：那是人的判斷，而且清單本來就不完整（所以才有「其他」）。
// - **擋不住「使用者挑錯自己那張卡的發卡行」**：挑錯的後果與填錯自由文字相同。
// - **不驗畫面**：`onMount` 的顯示／隱藏只驗原始碼有那段接線，沒有真的跑 DOM
//   （`public/app.js` 頂層碰 document，node 裡 import 不進來——同 `test/form-options.test.js` 的理由）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARD_ISSUERS, ISSUER_OTHER, ISSUER_OTHER_LABEL, ISSUER_UNSET_LABEL,
  issuerNameKey, issuersNamed, issuerOptions, issuerFormValues, resolveIssuerInput,
} from '../public/modules/card-issuers.js';
import { OWN_ISSUERS, issuerBank } from '../lib/card-identity.js';
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

test('★清單｜每一個別名都必須**改變結果**——裝飾用的別名（全球品牌短名）會轉紅', () => {
  // 這一題是本支自審抓到的：我第一版替每一家都補了「HSBC」「Rakuten」「星展」這種短名，
  // 而那正是本支要消掉的東西——同一個品牌在不同法域是不同法人（`lib/bank-alias.js` 記著
  // 「日本樂天 vs 台灣樂天」）。寫下去＝替使用者猜他指的是哪個法人，而清單存在的理由就是不要猜。
  // 一個別名只有兩種身分才留得住：①製造歧義（兩家以上宣稱）②收既有短名（樣式那條路對不出這一家）。
  for (const o of CARD_ISSUERS) {
    for (const a of o.aka || []) {
      const shared = issuersNamed(a).length >= 2;
      const patternMisses = byPattern(a) !== o.bank;
      assert.ok(shared || patternMisses,
        `「${a}」對結果沒有任何影響（樣式那條路本來就對得出 ${o.bank}，也沒有第二家宣稱它）⇒ 刪掉`);
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
    const v = issuerFormValues(legacy);
    assert.equal(v.issuer, ISSUER_OTHER, `「${legacy}」不該被預選成清單上的某一項`);
    assert.equal(v.issuerOther, legacy, `「${legacy}」要原字帶進自訂欄`);
  }
});

test('表單｜正式寫法才預選；空值＝未設定', () => {
  assert.deepEqual(issuerFormValues('台新銀行'), { issuer: '台新銀行', issuerOther: '' });
  assert.deepEqual(issuerFormValues('富邦銀行（香港）'), { issuer: '富邦銀行（香港）', issuerOther: '' });
  // William 三張真卡填的是「台新銀行」「台北富邦銀行」「遠東商銀」——三個都在清單上，打開表單就預選好
  for (const real of ['台新銀行', '台北富邦銀行', '遠東商銀']) {
    assert.deepEqual(issuerFormValues(real), { issuer: real, issuerOther: '' }, `既有卡片「${real}」要直接對上清單`);
  }
  assert.deepEqual(issuerFormValues('臺新銀行 '), { issuer: '台新銀行', issuerOther: '' }, '同一個名字換個字形／多個空白＝同一項');
  for (const empty of ['', '   ', null, undefined]) assert.deepEqual(issuerFormValues(empty), { issuer: '', issuerOther: '' });
});

test('表單｜送出時兩欄合回一欄', () => {
  assert.equal(resolveIssuerInput('台新銀行', ''), '台新銀行');
  assert.equal(resolveIssuerInput('台新銀行', '殘留的舊字'), '台新銀行', '★沒選「其他」就無視自訂欄（它隱藏時仍會被送出）');
  assert.equal(resolveIssuerInput(ISSUER_OTHER, '  某某銀行 '), '某某銀行');
  assert.equal(resolveIssuerInput(ISSUER_OTHER, ''), '', '選了其他卻留白＝未設定');
  assert.equal(resolveIssuerInput('', ''), '');
});

test('★表單｜打開表單、什麼都不改就儲存，發卡行不會變（正規化字形除外）', () => {
  const roundTrip = (/** @type {string} */ x) => { const v = issuerFormValues(x); return resolveIssuerInput(v.issuer, v.issuerOther); };
  for (const x of ['', '台新', '富邦', '台新銀行', '富邦銀行（香港）', '遠東商銀', '某某會員俱樂部']) {
    assert.equal(roundTrip(x), x, `「${x}」被表單改掉了`);
  }
  // 唯一容許的改動＝同一個名字的另一種字形被寫成清單上的正式寫法（要使用者按下儲存才會發生）
  assert.equal(roundTrip('臺新銀行'), '台新銀行');
  assert.equal(issuerNameKey(roundTrip('臺新銀行')), issuerNameKey('臺新銀行'), '★而且必須還是同一家');
});

test('表單｜下拉選項＝（未設定）在最前、其他在最後，值不重複', () => {
  const opts = issuerOptions();
  assert.deepEqual(opts[0], { value: '', label: ISSUER_UNSET_LABEL });
  assert.deepEqual(opts[opts.length - 1], { value: ISSUER_OTHER, label: ISSUER_OTHER_LABEL });
  assert.equal(opts.length, CARD_ISSUERS.length + 2);
  assert.equal(new Set(opts.map(o => o.value)).size, opts.length, '選項的值不可重複（重複＝挑不到其中一項）');
  assert.equal(issuersNamed(ISSUER_OTHER).length, 0, '★「其他」的哨兵值不可以是任何一家的名字或別名');
});

// ───────────────────────── ④ 接線（讀原始碼）─────────────────────────

test('★接線｜卡片表單真的用了清單（純函式全對、沒接上去＝使用者看到的還是自由文字框）', () => {
  const src = read('public/modules/cards.js');
  assert.match(src, /import \{[^}]*issuerOptions[^}]*\} from '\.\/card-issuers\.js';/);
  assert.match(src, /\{ key: 'issuer', label: '發卡銀行 \/ 機構', type: 'select', options: issuerOptions\(\) \}/,
    '★發卡行必須是 select＋清單，不可以是自由文字框');
  assert.match(src, /\{ key: 'issuerOther',[^\n]*type: 'text'/, '★清單以外的機構要填得進去（其他＝自行輸入）');
  assert.match(src, /values: c \? \{[^\n]*\.\.\.issuerFormValues\(c\.issuer\)/, '★編輯既有卡片時要把現值餵回表單');
  assert.match(src, /data\.issuer = resolveIssuerInput\(data\.issuer, data\.issuerOther\); delete data\.issuerOther;/,
    '★送出前要合併兩欄，而且 issuerOther 不是 schema 欄位、不可以送到後端');
  assert.match(src, /cell\.hidden = sel\.value !== ISSUER_OTHER/, '★自訂欄只在選了「其他」時出現');
});

test('★接線｜「為什麼要從清單挑」有就地解釋（專案鐵則：不可只寫在文件裡）', () => {
  const src = read('public/modules/cards.js');
  assert.match(src, /id="issuerInfo"/, '卡片頁要有那個說明入口');
  assert.match(src, /byId\('issuerInfo'\)\.onclick = \(\) => openInfo\([^)]*ISSUER_INFO_HTML\)/, '入口要真的接上說明窗');
  const copy = src.slice(src.indexOf('const ISSUER_INFO_HTML'), src.indexOf('const TYPE_LABEL'));
  for (const must of ['台北富邦', '香港', '其他（自行輸入）']) {
    assert.ok(copy.includes(must), `說明文案少了「${must}」——講不清楚為什麼要改，使用者只會覺得表單變難用`);
  }
  assert.equal(/[Bb]ank|API|schema/.test(copy), false, '文案不可出現英文技術詞（使用者沒有程式背景）');
});

// ───────────────────────── ⑤ 突變：拿掉守門會不會紅 ─────────────────────────

test('★突變｜把香港富邦對「富邦」的宣稱拿掉，歧義那一題要紅', () => {
  // 資料面的突變沒辦法真的改 import 進來的常數，所以直接對同一個判準重跑一次：
  // 若清單只剩台北富邦宣稱「富邦」，`issuersNamed('富邦').length` 就會是 1 ⇒ 回去猜。
  const withoutHk = CARD_ISSUERS.filter(o => o.name !== '富邦銀行（香港）');
  const named = withoutHk.filter(o => o.name === '富邦' || (o.aka || []).some(a => a === '富邦'));
  assert.equal(named.length, 1, '前提：拿掉香港富邦之後「富邦」就只剩一家宣稱');
  assert.notEqual(named[0].bank, '', '★而那一家是有內建範本的台北富邦 ⇒ 少了香港那一筆就會判成它（本支要修的就是這個）');
});

test('★突變｜接線題與文案題拿掉守門會紅', () => {
  const src = read('public/modules/cards.js');
  const broken = src.replace("type: 'select', options: issuerOptions()", "type: 'text', placeholder: '例：台新銀行'");
  assert.notEqual(broken, src, '突變目標必須存在');
  assert.doesNotMatch(broken, /\{ key: 'issuer', label: '發卡銀行 \/ 機構', type: 'select', options: issuerOptions\(\) \}/);
  const noMerge = src.replace('data.issuer = resolveIssuerInput(data.issuer, data.issuerOther); delete data.issuerOther;', '');
  assert.notEqual(noMerge, src, '突變目標必須存在');
  assert.doesNotMatch(noMerge, /data\.issuer = resolveIssuerInput/);
});
