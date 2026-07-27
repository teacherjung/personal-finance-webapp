// @ts-check
// 店名規則批次（使用者定 2026-07-27 深夜）：自訂規則入內建＋新店家清單＋通用過濾精進。
// 每一條都是使用者貼的真實帳單原文（或其代表樣式）——固定輸入輸出，規則改壞任何一家會當場紅。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanStore, storeKeyOf, categorize, refundPairKeyOf } from '../lib/statement.js';

// ---- 品牌＋分店型（BRAND_CANON）：鑰匙到品牌、分店留顯示名 ----
test('新光三越：館別碼 A1 不是分店身分（rest 精進）', () => {
  assert.equal(cleanStore('新光三越百貨臺北信義A1A2119 TAIPEI'), '新光三越（臺北信義）');
  assert.equal(storeKeyOf('新光三越百貨臺北信義A1A2119 TAIPEI'), '新光三越');
});

test('遠東百貨：分公司＝法人字眼不是分店（COMPANY_TAIL 精進）', () => {
  assert.equal(cleanStore('遠東百貨板橋新站分公司(A2716 NEW TA'), '遠東百貨（板橋新站）');
  assert.equal(storeKeyOf('遠東百貨板橋新站分公司(A2716 NEW TA'), '遠東百貨');
});

test('康是美：正字與異體「門巿」兩種寫法收斂成同一個顯示名＋同一把鑰匙', () => {
  assert.equal(cleanStore('康是美未來門市A2716 TAIPEI'), '康是美（未來門市）');
  assert.equal(cleanStore('康是美藥妝未來門巿A2119 TAIPEI'), '康是美（未來門市）');
  assert.equal(storeKeyOf('康是美未來門市A2716 TAIPEI'), '康是美');
  assert.equal(storeKeyOf('康是美藥妝未來門巿A2119 TAIPEI'), '康是美');
});

test('涮乃葉：行政區前綴「新店」不進分店名（使用者定顯示＝涮乃葉（小碧潭店））', () => {
  assert.equal(cleanStore('涮乃葉新店小碧潭店A2716 NEWTAI'), '涮乃葉（小碧潭店）');
  assert.equal(storeKeyOf('涮乃葉新店小碧潭店A2716 NEWTAI'), '涮乃葉');
});

test('誠品生活：分期期數保留在顯示名、分公司截斷「分」剝掉、鑰匙不含期數', () => {
  assert.equal(cleanStore('誠品生活股份有限公司新店分第03/03期/TW'), '誠品生活（新店）第03/03期');
  assert.equal(storeKeyOf('誠品生活股份有限公司新店分第03/03期/TW'), '誠品生活');
});

test('歐悅／康宜庭：品牌聚合、分店留顯示', () => {
  assert.equal(storeKeyOf('歐悅精品汽車旅館林口館'), '歐悅精品汽車旅館');
  assert.equal(cleanStore('歐悅精品汽車旅館林口館'), '歐悅精品汽車旅館（林口館）');
  assert.equal(storeKeyOf('康宜庭精緻蛋糕'), '康宜庭');
});

test('萊爾富／7-ELEVEN：公司名剝除、7-ELEVEN 併回統一超商', () => {
  assert.equal(cleanStore('萊爾富國際股份有限公司林口文化店'), '萊爾富（林口文化店）');
  assert.equal(storeKeyOf('萊爾富國際股份有限公司林口文化店'), '萊爾富');
  assert.equal(storeKeyOf('7-ELEVEN百福門市'), '統一超商');
});

// ---- 一步到位型（STORE_CANON）：顯示與鑰匙都是標準名 ----
test('壽司郎：公司字＋截斷殘「中」全部收乾淨', () => {
  assert.equal(cleanStore('台灣壽司郎股份有限公司中A0145 TAOYUA'), '壽司郎');
  assert.equal(storeKeyOf('台灣壽司郎股份有限公司中A0145 TAOYUA'), '壽司郎');
});

test('意享／路易莎（更新舊裁決：不再帶「林口文三門市」）', () => {
  assert.equal(cleanStore('eat enjoy意享A2716 TAIPEI'), '意享');
  assert.equal(storeKeyOf('eat enjoy意享A2716 TAIPEI'), '意享');
  assert.equal(cleanStore('LOUISA COFFEA2716 TAIPEI'), '路易莎咖啡');
});

test('Apple 全家族：訂閱、iTunes、實體店（信義）鑰匙全部收成同一把 Apple', () => {
  assert.equal(cleanStore('APPLE.COM/BILLA2119 080009'), 'Apple');
  assert.equal(cleanStore('APPLE.COM/BILLA2119 ITUNES'), 'Apple（iTunes）');
  assert.equal(storeKeyOf('APPLE.COM/BILLA2119 080009'), 'Apple');
  assert.equal(storeKeyOf('APPLE.COM/BILLA2119 ITUNES'), 'Apple');
  // 實體店：顯示改 Apple（信義）（分店資訊保留）、分期期數不可弄丟（detachTailNotes）
  assert.equal(cleanStore('Apple XinyiA 第03/12期'), 'Apple（信義）第03/12期');
  assert.equal(storeKeyOf('Apple XinyiA 第03/12期'), 'Apple');
  assert.equal(storeKeyOf('蘋果電腦-台灣-EC'), 'Apple');
});

test('momo：購物寫法全中、MOMO PARADISE（壽喜燒）不被吸走', () => {
  assert.equal(storeKeyOf('momo*生活用品店'), 'momo');
  assert.equal(storeKeyOf('momo購物網'), 'momo');
  assert.notEqual(cleanStore('MOMO PARADISE壽喜燒'), 'momo');   // 別家品牌：momo 後接（空白＋）英文＝擋
  assert.notEqual(cleanStore('MOMOPARADISE'), 'momo');
});

test('訂閱／平台一步到位團（使用者清單逐一）', () => {
  const expect = [
    ['AMAZON.COM*AB12CD', 'Amazon'], ['AMZN MKTP US', 'Amazon'],
    ['AUTOPASS', 'Autopass'],
    ['BURGER KI', 'Burger King'],
    ['ELEVENLABS.IO', 'ELEVENLABS'],
    ['GOOGLE *YOUTUBE', 'YouTube'],
    ['GRAMMARLY COQF3P8', 'GRAMMARLY'],
    ['HEYGEN TECHNOLOGY', 'HEYGEN'],
    ['IKEA新莊店', 'IKEA'],
    ['KLOOK客路', 'Klook'],
    ['LINEPAY＊某小店', 'LINE Pay'],   // 使用者定 2026-07-27：所有 LINEPAY 代收＝同一家（沿用既有鑰匙寫法 LINE Pay）
    ['LINKEDIN PREMIUM', 'LinkedIn'],
    ['MASTERCLASS SUBSCRIPTION', 'MASTERCLASS'],
    ['NIKE台北101', 'NIKE'],
    ['Nintendo eShop', 'Nintendo'],
    ['NOTION LABS', 'NOTION'],
    ['PCHOME線上購物', 'PCHOME'],
  ];
  for (const [orig, want] of expect) {
    assert.equal(cleanStore(orig), want, `cleanStore(${orig})`);
    assert.equal(storeKeyOf(orig), want, `storeKeyOf(${orig})`);
  }
});

// ---- 自訂規則搬入內建（原 settings.storeRules，使用者要求改由程式端管理）----
test('自訂規則九條全數由內建接手（與自訂規則產物逐字一致＝留著也冪等）', () => {
  const expect = [
    ['UNIQLO TW林口A2716', 'UNIQLO'],
    ['WOW HOT', 'WOW HOT DOG'],
    ['札伊卡A2716 TAIPEI', '札伊卡印度咖哩風味餐館'],
    ['Zaika札伊卡印度咖哩風味', '札伊卡印度咖哩風味餐館'],   // 舊 BRAND_CANON 寫法也收進同一名
    ['聯信-台灣國際開A0145', '台灣國際開發'],
    ['%Arabica信義店', '%Arabica'],
    ['27號炒牛羊肉x特色炒飯', '27號炒牛羊肉x特色炒飯'],
    ['三新汽車股份有限公司', '現代汽車'],
    ['友邦人壽保險費', '友邦人壽'],
    ['CLAUDE.AI SUBSCRIPTION', 'Claude'],
  ];
  for (const [orig, want] of expect) assert.equal(cleanStore(orig), want, `cleanStore(${orig})`);
});

// ---- 運動中心：字面聚合鑰匙（顯示保留完整場館名）----
test('運動中心：所有場館同一把鑰匙、顯示名各自保留、退款配對用細身分', () => {
  const cases = ['臺北市松山運動中心A2716 Taipei', '新北市林口國民運動中心', '新北市新店國民運動中心'];
  for (const orig of cases) assert.equal(storeKeyOf(orig), '運動中心', `storeKeyOf(${orig})`);
  // 顯示名保留完整場館（聚合只動鑰匙）
  assert.equal(cleanStore('臺北市松山運動中心A2716 Taipei'), '臺北市松山運動中心');
  assert.equal(cleanStore('新北市林口國民運動中心'), '新北市林口國民運動中心');
  // 退款配對不可用彙總鑰匙（同停車費的教訓）：細身分＝各場館自己，不同場館配不上
  const a = refundPairKeyOf('臺北市松山運動中心A2716 Taipei');
  const b = refundPairKeyOf('新北市林口國民運動中心');
  assert.ok(a && b && a !== b, '不同運動中心的退款配對身分必須不同');
  assert.notEqual(a, '運動中心');
});

// ---- 分類（CATEGORY_RULES）----
test('NextGen＝詐騙、ATT4FUN＝娛樂百貨（子類需存在於使用者分類樹才完整生效）', () => {
  assert.deepEqual(categorize('NEXTGEN*8004561'), ['其他', '詐騙']);
  assert.deepEqual(categorize('ATT4FUN股份有限公司'), ['娛樂', '百貨']);
  assert.deepEqual(categorize('GRAMMARLY COQF3P8'), ['工作', 'Canva及其他工作軟體']);
});

// ---- 誤傷防（新規則不可打壞既有語意）----
test('誤傷防：佳音美語仍是補習、幸福十分的「分」不被當公司殘尾、路易莎分類不變', () => {
  assert.deepEqual(categorize('佳音美語林口分校'), ['養育', '補習／才藝']);
  assert.equal(cleanStore('幸福十分'), '幸福十分');           // (?<![十幾滿])分：真店名的「分」不剝
  assert.deepEqual(categorize('LOUISA COFFEA2716 TAIPEI'), ['飲食', '飲料／咖啡']);
});

test('誤傷防 r1（Codex 抓到＋同型自查）：ONLINEPAY／YOUTUBER／BURGER KITCHEN 不被吸走', () => {
  assert.notEqual(cleanStore('ONLINEPAY SERVICE'), 'LINE Pay');       // OnlinePay＝真實支付品牌（Codex r1）
  assert.notEqual(cleanStore('ONLINEPAYMENT CO'), 'LINE Pay');
  assert.equal(cleanStore('LINEPAY＊某小店'), 'LINE Pay');            // 真 LINE Pay 代收照常中
  assert.equal(cleanStore('聯信-LINEPAY*NONE'), 'LINE Pay');          // 帶收單前綴也接得到（沒用 ^ 錨定的理由）
  assert.notEqual(cleanStore('YOUTUBER課程'), 'YouTube');             // 創作者課程＝別家商家（Codex r1）
  assert.equal(cleanStore('GOOGLE *YOUTUBE'), 'YouTube');
  assert.equal(cleanStore('YOUTUBE PREMIUM'), 'YouTube');
  assert.notEqual(cleanStore('BURGER KITCHEN'), 'Burger King');       // 同型自查：KITCHEN 的 KI 不是 KING 截斷
  assert.equal(cleanStore('BURGER KI'), 'Burger King');
});
