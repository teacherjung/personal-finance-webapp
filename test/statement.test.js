// 帳單解析器的「自動考試」：把消費分類與店名清理的規則鎖住，改壞任何一條都會考不過。
// 跑法：npm test（用 Node 內建測試工具，零相依）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, cleanStore, normalizeDesc } from '../lib/statement.js';

test('categorize：消費說明 → 正確的分類/子類', () => {
  const cases = [
    ['星巴克', ['飲食', '飲料／咖啡']],
    ['World Gym 台北', ['健康', '健身房']],
    ['大樹藥局', ['健康', '醫藥']],
    ['牙醫診所', ['健康', '牙科']],
    ['迪卡儂運動用品', ['健康', '運動用品']],
    ['摩斯漢堡', ['飲食', '餐廳']],
    ['涮乃葉新店店', ['飲食', '餐廳']],
    ['馬可先生麵包', ['飲食', '早餐／便當']],
    ['地價稅 114年', ['居住', '']],
    ['房屋稅 114年', ['居住', '']],
    ['ROBLOX', ['娛樂', '遊戲']],
    ['友邦人壽保費', ['保險', '壽險']],
    ['OMGYES.COM', ['健康', '']],
    ['悠遊卡自動加值', ['生活', '其他生活雜支']],   // 「自動加值」要排在「悠遊卡→交通」之前
    ['TAPPAY_台灣國際開發', ['交通', '停車費']],
    ['ＦＰ－石二鍋', ['飲食', '餐廳']],              // 外送前綴不影響：石二鍋仍→餐廳
    ['某不存在的神秘小店', ['其他', '未分類']],       // 認不出→其他/未分類
  ];
  for (const [desc, expected] of cases) {
    assert.deepEqual(categorize(normalizeDesc(desc)), expected, `categorize(${desc})`);
  }
});

test('cleanStore：帳單店名清理（涵蓋使用者指定的 14 條規則）', () => {
  const cases = [
    ['Apple Xinyi A第03/12期/TW', 'Apple Xinyi A第03/12期'],
    ['連加*阜爾運通股份有限Taipei', '阜爾運通'],
    ['21PLUS、21O2732 Taipei', '21PLUS'],
    ['摩斯漢堡Mos BO2732 Taipei', '摩斯漢堡'],
    ['OMGYESA2716 OMGYES', 'OMGYES'],
    // eTag 停車（使用者定 2026-07-18）：場站名（冒號後）救回來 →「eTag 停車（場站名）」
    ['eTag停車3087-H8:救國團林口運動中心', 'eTag 停車（救國團林口運動中心）'],
    ['eTag停車3087-H8:?亭新店行政園區', 'eTag 停車（俥亭新店行政園區）'],   // 場站的「?亭」缺字一併修補
    ['eTag停車3087-H8', 'eTag 停車'],                                       // 沒場站名＝只回品牌
    ['悠遊卡自動加值-正好停—正好停— /TW', '悠遊卡自動加值'],
    ['柑園加油站有限公司林口二站TAIPEI', '柑園加油站林口二站'],
    ['foodpanda-ECO2732 Taipei', 'foodpanda'],
    ['騰加數位*馬可先生新莊店', '馬可先生'],
    ['五桐號WooTEA0145 Taipei', '五桐號'],
    ['順康資產管理顧問有限公司', '順康資產管理顧問'],
    ['六必居潮州一品沙A0145', '六必居'],
    ['FP-石二鍋(林口家樂O2732 Taipei', '石二鍋'],   // cleanStore 砍掉 FP 前綴＝乾淨身分；「（FP）」標記在顯示層
    // 額外：OPENAI* 不當金流前綴、外幣註記保留、截斷只能到某處
    ['OPENAI* CHATGPT CREDITOPENAI', 'OpenAI'],
    ['COURSERA.ORGO5190 COURSE（USD/17.00）', 'COURSERA.ORGO5190 COURSE（USD/17.00）'],
    ['TAPPAY_台灣國際開A2716 TAIPEI', '台灣國際開'],
    // 停車三案（使用者回報 2026-07-18）：聯信＝收單方前綴要砍、公司字尾截斷殘尾要修、「?亭」＝俥亭缺字
    ['聯信-台灣普客二四股份有A0145 TAIPEI', '台灣普客二四'],   // 聯信-＋股份有（截斷）都是雜訊
    ['聯信-台灣普客二四股份有A0145 NEW TA', '台灣普客二四'],
    ['連加*?亭停車事業股份Taipei', '俥亭停車'],               // ?＝「俥」超出 Big5 的銀行缺字；事業股份＝截斷殘尾
    ['聯信-%Arabica象A0145 TAIPEI', '%Arabica象'],            // 聯信- 砍掉後其餘照常清理
    // 金流前綴疊兩層（使用者回報 2026-07-18）：連加*連加*… 要剔到乾淨，不可遺留一個
    ['連加*連加*健身工廠林口廠', '健身工廠林口廠'],
    ['連加*連加*摩斯漢堡APP', '摩斯漢堡'],
    // 國外交易服務費（使用者定 2026-07-18）：帶出對應簽帳金額 →（-金額）；台新/富邦兩種寫法；無金額不變
    ['國外交易服務費(簽帳15,925 )', '國外交易服務費（-15,925）'],
    ['國外交易服務費-3781.00', '國外交易服務費（-3,781）'],
    ['國外交易服務費', '國外交易服務費'],
    // 路易莎（使用者定 2026-07-18）：LOUISA COFFE（銀行截斷）全部＝林口文三門市
    ['LOUISA COFFEA0145 NEW TA', '路易莎咖啡（林口文三門市）'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(cleanStore(raw), expected, `cleanStore(${raw})`);
  }
});

test('cleanStore：分類仍用原始說明、不受清理影響', () => {
  // FP-石二鍋 清成身分名「石二鍋」（「（FP）」是顯示層標記），分類仍用原始字串判斷 → 飲食/餐廳
  assert.equal(cleanStore('FP-石二鍋(林口家樂O2732 Taipei'), '石二鍋');
  assert.deepEqual(categorize('FP-石二鍋(林口家樂O2732 Taipei'), ['飲食', '餐廳']);
});

test('normalizeDesc：全形英數→半形、去 CJK 間多餘空白', () => {
  assert.equal(normalizeDesc('ＡＢＣ１２３'), 'ABC123');
  assert.equal(normalizeDesc('台  北  富  邦'), '台北富邦');
});
