// @ts-check
// 信用卡帳單 PDF 解析：解密（密碼存卡片的 pdfPassword，本機 store.json、永不進版控）、
// 抽出消費明細、關鍵字自動分類（兩層：分類／子類）。PDF 本身不落地保存，只回傳解析結果。
// v1 支援富邦；新增銀行＝加一個 parseXxx() 並在 parseStatementPdf 依 issuer 分流。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as XLSX from 'xlsx';
import { DEFAULT_EXPENSE } from '../public/modules/categories.js';
// 使用者自訂的店名規則（第三帖）：純資料存在 settings.storeRules，由 repo 櫃檯餵進 store-rules.js。
// 本檔在四處把「使用者規則排在內建規則前面」（使用者要蓋得過內建判斷）：cleanStore 的 STORE_CANON、
// applyBrandCanon、applyBrandRename、branchNormalize 的連鎖白名單、applyDisplayLabels 的停車豁免。
// ⚠️ 分類規則（CATEGORY_RULES）刻意不開放——storeKeyOf 用 categorize 判「油錢→加油站」，
// 分類可編輯的話身分鑰匙會漂移、既有學習全部對不上。鑰匙的判定基礎凍結在內建規則（考題鎖住）。
import { getUserRules } from './store-rules.js';
import { isRealDate } from './schema.js';   // 真日曆驗證（自主體檢：假日期不可流到寫入櫃檯才炸）
/** @typedef {import('./types.js').RawTx} RawTx */
/** @typedef {import('./types.js').ParsedTx} ParsedTx */
/** @typedef {import('./types.js').StatementResult} StatementResult */

// ---- 關鍵字 → [分類, 子類]（比對「消費說明」，由上往下先中先贏）----
// 分類字串必須對得上 public/modules/categories.js 的 EXPENSE_TREE（AGENTS.md 同步點）。
// 順序重點：特殊指定（YouTube→學習、ChatGPT/Claude/Notion→工作、汽車保險→交通）與
// 較專一的關鍵字要排在通用之前，才不會被通用規則先攔截。
/** 每條＝[分類, 子類, 關鍵字陣列]。 @type {[string, string, string[]][]} */
const CATEGORY_RULES = [
  // 工作（軟體訂閱要在其他通用之前）
  ['工作', 'ChatGPT', ['CHATGPT', 'OPENAI']],
  ['工作', 'Claude', ['CLAUDE', 'ANTHROPIC']],
  ['工作', 'Notion', ['NOTION']],
  ['工作', 'Canva及其他工作軟體', ['CANVA', 'ADOBE', 'FIGMA', 'MICROSOFT', 'OFFICE 365', 'MICROSOFT 365', 'ELEVENLABS', 'HEYGEN', 'SYNTHESIA', 'DESCRIPT', 'ZAPIER', 'AIRTABLE']],
  ['工作', '網站／網域／雲端服務', ['GITHUB', 'DROPBOX', 'GODADDY', 'CLOUDFLARE', 'VERCEL', 'AWS', 'GOOGLE CLOUD', '網域']],
  // 學習
  ['學習', 'YouTube Premium', ['YOUTUBE']],
  ['學習', '學習型訂閱服務', ['UDEMY', 'COURSERA', 'HAHOW', '均一', '線上課程', 'MASTERCLASS', '思維槓桿', 'PRESSPLAY', '知識訂閱']],
  ['學習', '書籍', ['博客來', '讀冊', '金石堂', '誠品書', 'BOOKS']],
  ['學習', '考試／證照費', ['測驗中心', '報名費', '證照', '檢定']],
  // 悠遊卡/一卡通自動加值歸生活（使用者定）。要排在「整個交通區塊」之前——加值可能在停車場/車隊
  // 觸發（悠遊卡自動加值-和雲…），排後面會被「和雲/停車」關鍵字搶走判成停車費（帳務體檢 D2 抓到，2026-07-19）。
  // eTag自動儲值 不受影響（字樣是「儲值」，由下方 ETAG自動儲值 關鍵字明確歸停車費）。
  ['生活', '其他生活雜支', ['自動加值']],
  // 交通（汽車保險要在保險之前）
  ['交通', '汽車保險', ['汽車保險', '強制險', '車體險', '車險']],
  ['交通', '油錢', ['中油', '台亞', '加油站', '加油', '福記', '柑園加油', '統一精工', '速邁樂']],
  ['交通', '停車費', ['停車', '嘟嘟房', '停車場', '城市車旅', '和雲', 'TIMES', '拖吊', '阜爾運通', '普客二四', '順康資產', '林口四維路', '綠湖', '嘟嘟房']],
  // 叫車認「車隊」而非「優步」：優步（Uber）同一個商戶名底下混著叫車與外送（優步-好麥永和豆漿店＝外送），
  // 用 優步 當關鍵字會把外送全判成交通。純「優步-<認不出的店家>」由檔尾的保底規則收（使用者定 2026-07-18）。
  ['交通', '計程車／Uber', ['UBER TRIP', '車隊', '計程車', 'TAXI', '55688', 'YOXI', 'Q2 TAXI', 'Q２']],
  ['交通', '停車費', ['ETAG停車', 'ETAG自動儲值', '泊車', '長庚泊車']],
  ['交通', '停車費', ['TAPPAY', '台灣國際開發']],   // TapPay 第三方支付，使用者的多為停車（非停車者可於預覽/事後逐筆改）
  ['交通', '大眾運輸', ['悠遊卡', '一卡通', '高鐵', '台鐵', '捷運', '客運', '公車', '台灣鐵路', '微笑單車', 'YOUBIKE']],
  ['交通', '過路費', ['ETAG', '遠通電收', '國道']],
  ['交通', '牌照稅', ['牌照稅']],
  ['交通', '燃料使用費', ['燃料費', '燃料使用']],
  ['交通', '汽車保養', ['汽車保養', '原廠保養', '定保', '現代汽車', '和泰汽車', '汎德', '保養廠']],
  ['交通', '洗車', ['洗車']],
  // 娛樂（旅遊、影音、遊戲…）
  ['娛樂', '旅遊', ['AGODA', 'BOOKING.COM', 'BOOKING ', 'EXPEDIA', 'AIRBNB', 'HOTELS.COM', 'TRIP.COM', 'KKDAY', 'KLOOK', '客路', 'FLICKKET', '雄獅', '易遊網', '可樂旅遊', '五福旅遊', '燦星', '旅行社', '訂房', '飯店', '酒店', '旅館', '民宿', '度假村', 'RESORT', 'HOTEL', '溫泉會館', '汽車旅館', '風閣', '航空', '機票', 'EVA AIR', 'TIGERAIR', '護照', '領事', '簽證', '外交部領事']],
  ['娛樂', 'Netflix及影音串流', ['NETFLIX', 'DISNEY', 'HBO', 'PRIME VIDEO', 'FRIDAY影音', 'CATCHPLAY']],
  ['娛樂', '音樂', ['SPOTIFY', 'KKBOX', 'APPLE MUSIC']],
  ['娛樂', '遊戲', ['STEAM', 'PLAYSTATION', 'NINTENDO', 'GOOGLE PLAY', '遊戲橘子', '巴哈姆特', 'ROBLOX']],
  ['娛樂', '電影', ['威秀', '秀泰', '國賓影城', '新光影城', '影城', '電影', 'CINEMA', 'VIESHOW']],
  ['娛樂', '樂園／展覽', ['樂園', '動物園', '展覽', '美術館', '博物館', '六福', '劍湖山', '麗寶', '台北101', '觀景台', 'KTV']],
  // 健康（醫療/美容/健身/按摩）
  ['健康', '', ['OMGYES']],   // 性教育內容，使用者歸健康
  ['健康', '健身房', ['健身', 'GYM', 'WORLD GYM', 'ANYTIME']],
  ['健康', '美髮', ['髮藝', '美髮', '造型', '沙龍', 'HAIR', '剪髮']],
  ['健康', '美容', ['美容', '護膚', '美甲', '美睫', 'SPA', '芳療']],
  ['健康', '按摩', ['按摩', '指壓', '紓壓', '推拿', '整復']],
  ['健康', '牙科', ['牙醫', '牙科']],
  ['健康', '看診', ['醫院', '診所', '醫療', '婦產', '眼科', '皮膚科']],
  ['健康', '醫藥', ['藥局', '藥師', '大樹', '杏一']],
  ['健康', '健檢', ['健檢', '健康檢查']],
  ['健康', '保健食品', ['保健', '維他命', '善存', '葡萄王']],
  ['健康', '運動用品', ['DECATHLON', '迪卡儂', '運動用品', '迪卡']],
  ['健康', '運動課程', ['攀岩', '運動中心', '游泳池', '瑜珈', '皮拉提斯', '拳擊', '飛輪']],
  // 飲食（先認真正的店家，把子類判準；外送平台前綴放最後當保底，確保仍落在飲食）
  ['飲食', '零食', ['COLD STONE', 'COLDSTONE', '冰淇淋', '霜淇淋', 'ICE CREAM', '哈根達斯', 'HAAGEN', '零食']],
  ['飲食', '超市', ['全聯', '家樂福', '大潤發', '美廉社', '好市多', 'COSTCO', '超市', 'JASONS', '楓康', '頂好']],
  ['飲食', '飲料／咖啡', ['星巴克', 'STARBUCKS', '路易莎', 'LOUISA', 'CAMA', 'ARABICA', '咖啡', 'COFFE', '清心', '五十嵐', 'COMEBUY', '手搖', '飲料', '可不可', '大苑子', '迷客夏', '聲島', 'BEING']],
  ['飲食', '早餐／便當', ['麥味登', '早餐', '早午餐', '美而美', '便當', '豆漿', '馬可先生']],
  ['飲食', '麵食', ['八方雲集']],   // 使用者定 2026-07-19（「麵食」＝使用者自訂樹的子類；預設樹無此子類時降為不分子類）
  ['飲食', '餐廳', ['餐廳', '餐飲', '石二鍋', '鼎泰豐', '麥當勞', '肯德基', '摩斯', '漢堡', '火鍋', '燒肉', '燒臘', '食堂', '小吃', '拉圖爾', '12MINI', 'LADY M', 'LADY-M', '秘食', '墨爾', '炸牛', '爭鮮', '壽司', '涮涮', '鬍鬚張', '無老鍋', '精釀', '三顧茅廬', '冰室', '御園坊', '茗香園', '滷味', '牛肉麵', '拉麵', '涮乃葉']],
  ['飲食', '超市', ['統一超商', '7-ELEVEN', '全家', '萊爾富', 'OK超商', '超商']],   // 超商暫歸超市桶
  ['飲食', '外送', ['FOODPANDA', 'FP-', 'UBER EATS', 'UBEREATS', '優食', 'FP＊', 'ODDLE']],   // 保底：認不出店家的外送仍歸飲食
  // 居住
  ['居住', '', ['地價稅', '房屋稅']],   // 房產稅（地價稅/房屋稅）歸居住（使用者定；居住無稅務子類，故不分子類）
  ['居住', '房貸', ['房貸']],
  ['居住', '房租', ['房租']],
  ['居住', '管理費', ['管理費', '社區管理']],
  ['居住', '網路費', ['中華電信', '台灣大哥大', '遠傳', '亞太電信', '台灣之星', '網路費', '光世代', 'HINET']],
  ['居住', '水費', ['自來水', '水費']],
  ['居住', '電費', ['台灣電力', '台電', '電費']],
  ['居住', '瓦斯費', ['瓦斯', '欣欣天然氣', '大台北瓦斯']],
  ['居住', '家具', ['IKEA', '宜家', '家具', '詩肯']],
  ['居住', '居家用品', ['特力屋', 'HOLA', '生活工場', '無印', 'MUJI', '宜得利', 'NITORI']],
  ['居住', '修繕／裝潢', ['修繕', '裝潢', '水電行', '五金']],
  // 生活
  ['生活', '日用品', ['屈臣氏', '康是美', '寶雅', '小北百貨', '日用', '美妝', '藥妝']],
  ['生活', '3C產品', ['3C', 'APPLE', '蘋果電腦', 'ICLOUD', 'STUDIO A', '德誼', '燦坤', '全國電子']],
  ['生活', '個人用品', ['OWNDAYS', '眼鏡', '寶島眼鏡', '小林眼鏡', '鐘錶']],
  ['生活', '衣服', ['UNIQLO', 'ZARA', 'H&M', 'NET', '服飾', 'GU', 'LATIV', 'GLOBAL MALL']],
  ['生活', '鞋子', ['ABC-MART', 'NIKE', 'ADIDAS', '球鞋']],
  ['生活', '清潔用品', ['清潔', '洗衣']],
  ['生活', '所得稅', ['所得稅', '綜所稅']],
  ['生活', '行政規費', ['規費', '監理', '戶政', '地政', '區公所']],   // 地價稅/房屋稅已移到居住（見上）
  ['生活', '日用品', ['MOMO', 'PCHOME', '蝦皮', 'SHOPEE', 'COUPANG', '酷澎', 'momo購物', 'AMAZON', 'AMZN']],
  // 保險
  ['保險', '壽險', ['人壽', '壽險', '友邦']],
  ['保險', '其他個人保險', ['保險', '產險']],
  // 養育
  ['養育', '補習／才藝', ['補習', '安親', '才藝', '美語', '音樂教室', '畫室', '佳音', '何嘉仁', '學美語']],
  ['養育', '孩子學費', ['幼兒園', '幼稚園', '托嬰', '學費']],
  ['養育', '親子活動', ['卡哇依', '親子', '遊戲愛樂園', 'KIDS', '兒童樂園', '碰碰船', '碰碰車']],
  // 社交
  ['社交', '捐款', ['捐款', '基金會', '紅十字', '世界展望', '慈濟']],
  ['社交', '禮物', ['LINE禮物', 'LINE GIFT', '禮物卡', '禮券']],
  ['社交', '社交活動', ['TIMELEFT']],
  // ---- 場所保底層（使用者定 2026-07-19：「具體店家 > 場所」）----
  // 百貨/OUTLET 這類關鍵字說的是「在哪裡」不是「買什麼」：認得出店家（八方雲集林口三井店＝麵店）
  // 就讓上面的店家規則先接走；只有認不出是百貨裡哪家店時，才落到這層歸「娛樂百貨」。
  // 排表尾正是實作方式——先中先贏，場所永遠最後才輪到。（順帶救活：小北百貨 以前被「百貨」搶走，
  // 生活/日用品 的專屬關鍵字形同虛設；石二鍋林口三井店 也曾被判娛樂。）
  ['娛樂', '興趣用品', ['誠品', '奧特萊斯', 'OUTLET', '三井', '遠東百貨', '遠百', 'SOGO', '新光三越', '百貨']]
];

// 回傳 [分類, 子類]。未命中→其他/未分類（DEFAULT_EXPENSE，讓使用者一眼看出待手動確認）。
/** @param {string} desc @returns {[string, string]} */
export function categorize(desc) {
  const raw = String(desc || '');
  const d = raw.toUpperCase();
  for (const [cat, sub, keys] of CATEGORY_RULES) {
    if (keys.some(k => d.includes(k.toUpperCase()))) return [cat, sub];
  }
  // 優步（Uber）保底：與顯示標記（deliveryTagOf）同一判準，兩邊口徑必須一致（Codex#1）——
  // 前面規則沒接走＝不是車隊（車隊/TAXI/計程車 已在交通規則裡），所以「優步-<認不出的店家>」＝外送，
  // 顯示會標（UE）、分類就該是飲食/外送；只有平台名（優步福爾摩沙股份有公司，無分隔符）＝叫車。
  if (UBER_PREFIX.test(raw)) return /** @type {[string, string]} */ (['飲食', '外送']);
  if (raw.includes('優步')) return /** @type {[string, string]} */ (['交通', '計程車／Uber']);
  return /** @type {[string, string]} */ ([...DEFAULT_EXPENSE]);   // 複製一份避免外部改到共用常數
}

// 正規化消費說明：官網版 PDF 用康熙部首異體字（⼝≠口）且字間插空白，
// 郵寄版用全形英數。統一成標準字＋半形，讓兩版產生一致的說明與 stmtRef
// （否則同一筆消費跨版式上傳會被當成新的重複匯入、分類關鍵字也比對不到）。
const RADICAL_FIX = { '⺠': '民' };   // NFKC 涵蓋不到的個別部首，遇到再補
/** @param {string} s @returns {string} */
export function normalizeDesc(s) {
  return String(s || '')
    .replace(/[⺀-⿟]/g, (c) => RADICAL_FIX[c] || c)
    .normalize('NFKC')   // 康熙部首→標準字、全形英數→半形
    .replace(/\s+(?=[㐀-鿿])|(?<=[㐀-鿿])\s+/g, '')   // CJK 相鄰的空白（部首拆字造成）
    .replace(/\s+/g, ' ').trim();
}

// 店名清理（僅顯示用）：讓帳單店名好讀。**只影響顯示**（匯入後的 note、預覽的顯示）；
// 分類與去重（stmtRef）仍用原始 desc，不受影響。盡力而為：台新 PDF/XLSX 常把店名截斷，救不回被截字。
// 先比對「已知品牌標準名」（不管周邊雜訊直接顯示標準名），沒中再走一般清理規則。
/** 每條＝[標準店名, 命中樣式]。 @type {[string, RegExp][]} */
const STORE_CANON = [
  // eTag 停車不在此表：場站名在冒號後（eTag停車3087-H8:救國團林口運動中心），由 cleanStore 開頭的專屬規則
  // 轉成「eTag 停車（場站名）」（使用者定 2026-07-18）——早退表做不到「保留尾段當分店」。
  ['foodpanda', /^foodpanda[-\s]/i],       // foodpanda-EC → foodpanda（FP-<店名> 不在此、會保留店名）
  ['路易莎咖啡（林口文三門市）', /LOUISA\s*COFFE/i],   // 使用者定 2026-07-18：LOUISA COFFE（銀行截斷）全部＝這家門市
  ['麥當勞', /麥當勞|MCDONALD/i],           // 使用者定 2026-07-18：台灣麥當勞MOP-056 → 麥當勞
  ['六松今苑壽喜燒', /紅陽科技六本/],        // 使用者定 2026-07-18：紅陽科技＝金流商，實際店家是這家
  // 以下皆使用者定 2026-07-18（銀行截斷或英文原名，統一成看得懂的標準名）
  ['肯德基', /肯德基|KFC/i],                // 肯德基KFC炸雞漢（截斷）
  ['星巴克', /STARBUCKS|星巴克/i],          // STARBUCKS／星巴克MITSUI門市
  ['DECATHLON', /DECATHLON|迪卡儂/i],       // DECATHLON TAIWATaichu／DECATHLON TAA0145 Taichu（截斷）
  // 只認「醫院本體」的寫法——之前 /林口長庚/ 太寬，把「林口長庚泊車區」（停車）和
  // 「錢都日式涮涮鍋(林口長庚店)」（分店名帶林口長庚的火鍋店）都吞成醫院（體檢 D2 抓到，2026-07-19）
  ['林口長庚醫院', /長庚醫療|林口長庚紀念醫/],
  ['林口三井', /三新奧特萊斯|三井[Oo]utlet/],   // 三新奧特萊斯林口I館＝三井 OUTLET 林口
  ['兒童新樂園', /卡哇依/],                  // 卡哇依＝兒童新樂園的攤商，記成樂園本身
  ['蘋果電腦', /蘋果電腦/],                  // 蘋果電腦-台灣-EC（EC＝網路商店代碼）
  ['LINE Pay', /LINEPAY[*＊]\s*NONE/i],     // 使用者定 2026-07-19：LINEPAY*none／*NONE＝不明店家，算同一家
  ['OpenAI', /OPENAI|CHATGPT/i],           // AI 訂閱服務（工作）；OPENAI* 是商家名、不是金流前綴
  ['悠遊卡自動加值', /自動加值/],            // 悠遊卡自動加值-正好停… → 悠遊卡自動加值
  ['OMGYES', /OMGYES/i],
  ['馬可先生', /馬可先生/],
  ['六必居', /六必居/]
];
// 已知金流/通路（含 marketplace）前綴白名單——**只砍這些**，避免誤砍像 OPENAI* 這種「商家名＋*」。
// 聯信＝聯合信用卡處理中心（收單方），接分隔符「-」：聯信-台灣普客二四… 的「聯信」不是店名。
// 結尾 +＝疊幾層剔幾層：銀行有時印兩次（連加*連加*健身工廠… 的顯示名曾遺留一個「連加*」，使用者回報 2026-07-18）。
const GATEWAY_PREFIX = /^(?:(?:連加|騰加數位|TAPPAY|momo)[*＊_]\s*|(?:聯信|藍新|點點付|綠界科技)[-－*＊_]\s*)+/i;   // 綠界＝金流商（體檢 D2 抓到，2026-07-19）
// 公司字尾「截斷殘尾」（銀行欄位截字產生：…股份有／…事業股份／…有限公）——只在結尾比對，
// 完整型態（股份有限公司等）由 cleanStore 的全域規則處理；這條補截斷版，供 cleanStore 與品牌正規化共用。
const COMPANY_TAIL = /(?:(?:事業)?股份(?:有限(?:公司?)?|有)?|有限公司?)\s*$/;
/** @param {string} s @returns {string} */
function trimCompanyTail(s) { return String(s || '').replace(COMPANY_TAIL, '').trim(); }
/** @param {string} desc @returns {string} */
export function cleanStore(desc) {
  const raw = String(desc || '');
  // 保留結尾外幣註記（（USD/17.00）之類）：先摘下、清理完再接回（使用者要保留幣別）
  const fxM = raw.match(/（[A-Za-z]{3}\/[\d.,]+）\s*$/);
  const fx = fxM ? fxM[0].trim() : '';
  const body = fxM ? raw.slice(0, fxM.index) : raw;   // 用 fxM 判斷（TS 才能收斂 non-null）
  const withFx = (s) => (fx ? `${s}${fx}` : s);
  // 國外交易服務費（使用者定 2026-07-18）：把「對應的簽帳金額」帶出來 →「國外交易服務費（-金額）」，
  // 一眼看出這筆手續費是跟著哪筆消費。兩種銀行寫法：台新「國外交易服務費(簽帳16,633 )」、
  // 富邦「國外交易服務費-1288.00」；金額去小數、加千分位。純「國外交易服務費」（無金額）不變。
  const feeM = body.match(/^國外交易服務費\s*(?:[（(]\s*簽帳\s*|[-－])\s*([\d,]+(?:\.\d+)?)/);
  if (feeM) {
    const amt = Math.round(Number(feeM[1].replace(/,/g, '')));
    return withFx(`國外交易服務費（-${amt.toLocaleString('en-US')}）`);
  }
  // eTag 停車：身分鑰匙＝「eTag 停車」（品牌層，使用者定 2026-07-18——所有場站算同一家，
  // 店家檔案合併統計、排行不灌水）；場站名屬「顯示層」，由 applyDisplayLabels 從原文補在顯示名。
  if (ETAG_RE.test(body)) return withFx('eTag 停車');
  for (const [canon, re] of [...getUserRules().canon, ...STORE_CANON]) if (re.test(body)) return withFx(canon);   // 使用者規則優先
  const s = body
    .replace(DELIVERY_PREFIX_ANY, '')                                                               // 外送平台前綴只砍掉（鑰匙＝餐廳本身）；「（FP）／（UE）」標記在顯示層由 applyDisplayLabels 加
    .replace(UBER_PREFIX, '')                                                                       // 優步前綴：後面是車隊或餐廳，下面依 TAXI_FLEET 分流
    .replace(GATEWAY_PREFIX, '')                                                                    // 金流/通路前綴（白名單）
    .replace(/[?？]亭/g, '俥亭')                                                                     // 銀行缺字修補：「俥」超出 Big5，帳單印成「?亭停車」「?亭新店…」
    .replace(/[（(].*$/, '')                                                                        // 截斷的括號分店：石二鍋(林口家樂 → 石二鍋
    .replace(/、.*$/, '')                                                                           // 21PLUS、21 → 21PLUS
    .replace(/\s*\d{3,4}-[A-Z0-9]{1,4}\s*$/, '')                                                    // 結尾設備碼：eTag自動儲值3087-H8 → eTag自動儲值
    .replace(/(股份有限公司|有限公司|股份有限|股份公司|有限合夥)/g, '')                                 // 公司型態字眼
    .replace(/\s*[/／](TW|US|JP|HK|SG|GB|CN|KR)\s*$/i, '')                                         // 結尾 /TW 等國別碼
    .replace(/\s*[A-Z]\d{3,4}\s*(NEW\s*TAI?P?E?I?|New\s*Tai?p?e?i?|TAIPEI|Taipei|TAOYUAN?|Taoyuan?|TAICHUNG?|Taichung?|TW)?\s*$/i, '')   // 結尾分店定位碼(＋城市)
    .replace(/\s*(NEW\s*TAI?P?E?I?|New\s*Tai?p?e?i?|TAIPEI|Taipei|TAOYUAN?|Taoyuan?|TAICHUNG?|Taichung?)\s*$/i, '')                       // 結尾殘留城市（含桃園/台中截斷）
    .replace(/\d{8,}\s*$/, '')                                                                     // 結尾長數字(統編/序號)
    .replace(/[?？]+\s*$/, '')                                                                      // 尾端缺字符號（俥亭停車事業股份?）——剝掉才輪得到殘尾規則
    .replace(COMPANY_TAIL, '')                                                                     // 公司字尾截斷殘尾：台灣普客二四股份有 → 台灣普客二四
    .replace(/([一-鿿])[?？]?[A-Za-z][A-Za-z0-9 .&]*$/, '$1')                              // 中文店名後的殘留英文（可夾缺字符號）：達卡印度廚房?Dhaka In → 達卡印度廚房
    .replace(/[\s（(＊*－\-:：]+$/, '')                                                              // 收尾多餘標點/空白
    .trim();
  // 優步（Uber）分流（使用者定 2026-07-18）：**叫車的「店家」就是 Uber**（車隊只是派到哪台車）
  // → 「Uber（車隊名）」、鑰匙統一 Uber（所有叫車合併成一張檔案）；**外送的店家是餐廳**
  // → 落到下面的一般流程（餐廳本身），（UE）標記由 applyDisplayLabels 加。
  if (UBER_PREFIX.test(body) && TAXI_FLEET.test(s)) return withFx(`Uber（${s}）`);
  if (/^優步(?:福爾摩沙股份有公司)?$/.test(s)) return withFx('Uber');   // 只有平台名（沒帶店家）
  return normalizeStoreDisplay(withFx(s || body));
}

// ---- 顯示標記（使用者定 2026-07-18）----
// 只加在「顯示名」（交易的 note），**不進 storeKey**——storeKey 是學習用的身分鑰匙，
// 混入標記會讓既有學習對不上。標記需要 cleanStore 看不到的上下文（帳單原文、分類），
// 所以由匯入/遷移端在知道上下文時呼叫 applyDisplayLabels()。兩個標記皆冪等。
// ①外送平台：帳單原文有平台前綴（DELIVERY_PREFIXES：`FP-`＝foodpanda、`優食-`＝Uber Eats；
//   要求有分隔符，免誤傷本來就叫 FPxxx 的店）→ 顯示成「主體（平台）」——**不留分店**（外送是線上點的，
//   出餐分店是雜訊；使用者定 2026-07-18：12MINI（桃園龜山復興一店）（FP）→ 12MINI（FP））。
//   尾端的分店括號會被摘掉、外幣註記保留。平台名只進顯示名，鑰匙是餐廳本身（優食-好麥永和豆漿店
//   的鑰匙＝好麥永和豆漿店，不是「優食」——否則所有 Uber Eats 消費會被當成同一家店）。
// ②停車：**子類＝停車費** → 包成「停車費（原店名）」。用分類而非店名字面，才涵蓋得到
//   「嘟嘟房」「阜爾運通」「Times Parking」這種名字沒有「停車」二字的停車場（使用者定：一律套用）。
//   例外白名單 PARK_WRAP_EXEMPT（使用者定 2026-07-18）：①「儲值/加值」不是在某停車場繳費，
//   包成「停車費（eTag自動儲值）」語意不對 → 維持原名（eTag自動儲值、悠遊卡自動加值）
//   ②名字本身已是停車語意（eTag 停車（場站））→ 再包一層是贅字。命中白名單＝不包（新的由使用者提出後加）。
// ③eTag 場站：身分鑰匙只到品牌「eTag 停車」（所有場站＝同一家，使用者定 2026-07-18），
//   場站名從帳單原文取回、補在顯示名——只裝飾「素的品牌名」，已帶場站（冪等）或使用者自訂名（不覆蓋）都跳過。
// 順序：外送先、eTag 場站次之、停車包裝最後（eTag 已被豁免、不會被包）。
export const FP_PREFIX = /^FP[\s\-*＊]+/i;
/** 外送平台前綴＝[比對樣式, 顯示標記]。新平台由使用者提出後加一條。 @type {[RegExp, string][]} */
export const DELIVERY_PREFIXES = [[FP_PREFIX, 'FP'], [/^優食[\s\-*＊]+/, 'UE']];   // UE＝Uber Eats（使用者定 2026-07-18）
// 「假自訂名」＝舊版規則把平台當成店名（優食（好麥永和豆漿店）／優食（UE））時，使用者跟著改出來的名字。
// 現行規則已能從帳單原文正確取出店家 → 整理時把這種名字當殘骸丟掉、用原文重生（使用者定 2026-07-18：
// 「優食（UE）全部改回原本的」）。判準：整個名字就是平台名，或「平台名（…）」。
const PLATFORM_WORDS = ['FP', '優食', '優步福爾摩沙股份有公司', '優步'];
/** @param {string|undefined} name @returns {boolean} */
export function isPlatformArtifactName(name) {
  const s = String(name || '').trim();
  return Boolean(s) && PLATFORM_WORDS.some(w => s === w || s.startsWith(`${w}（`));
}
// 優步（Uber）：同一個商戶名底下混著叫車與外送，帳單原文分不出來 → 用「店家是不是車隊」判
// （使用者定 2026-07-18「優步的外送也標（UE）」）。叫車的商家一律是某某車隊／Taxi，其餘視為外送。
const UBER_PREFIX = /^優步(?:福爾摩沙股份有公司)?[\s\-*＊_]+/;
const TAXI_FLEET = /車隊|TAXI|計程車/i;
/** 命中的外送平台標記（沒中回 ''）。 @param {string|undefined} desc @param {string} [name] 已清理的店名（判車隊用） @returns {string} */
const deliveryTagOf = (desc, name = '') => {
  const d = String(desc || '');
  const hit = DELIVERY_PREFIXES.find(([re]) => re.test(d));
  if (hit) return String(hit[1]);
  return (UBER_PREFIX.test(d) && !TAXI_FLEET.test(String(name || ''))) ? 'UE' : '';
};
// 由上表推導（加平台只改上表一處）：cleanStore 砍前綴用、stripDisplayLabels 拆標記用。
// 只在函式內取用（模組頂層的 const 有 TDZ，見 AGENTS.md）。
const DELIVERY_PREFIX_ANY = new RegExp(DELIVERY_PREFIXES.map(([re]) => `(?:${re.source})`).join('|'), 'i');
const DELIVERY_TAG_TAIL = new RegExp(
  `（(?:${DELIVERY_PREFIXES.map(([, t]) => t).join('|')})）(?=\\s*（[A-Za-z]{3}\\/[\\d.,]+）\\s*$|\\s*$)`);
const PARK_WRAP_EXEMPT = [/^eTag自動儲值$/i, /^悠遊卡自動加值$/, /^eTag ?停車/i];   // eTag 停車（場站）：名字已是停車語意，不再包一層
// eTag 停車的原文樣式：eTag停車<設備碼>:<場站名>。cleanStore 用它認身分（回品牌名）、
// applyDisplayLabels 用它取場站名補到顯示名（③）。
const ETAG_RE = /^(?:eTag|ETAG)\s*停車\s*(?:\d{3,4}-[A-Z0-9]{1,4})?\s*[:：]?\s*(.*)$/i;
/**
 * 依上下文替顯示名加標記。 @param {string} name 已清理的店名
 * @param {{desc?: string, subcategory?: string}} [ctx] desc＝帳單原文（判 FP）、subcategory＝子類（判停車）
 * @returns {string}
 */
export function applyDisplayLabels(name, ctx = {}) {
  let s = String(name || '');
  if (!s) return s;
  const tag = deliveryTagOf(ctx.desc, s);
  if (tag) {
    const fxM = s.match(/（[A-Za-z]{3}\/[\d.,]+）\s*$/);   // 外幣註記先摘、最後接回
    const fx = fxM ? fxM[0].trim() : '';
    let base = (fxM ? s.slice(0, fxM.index) : s).trim();
    if (base !== tag && !base.endsWith(`（${tag}）`)) {     // base===tag＝店名救不回（只剩平台名），不加贅括號
      base = base.replace(new RegExp(`(（(?!${tag}）)[^（）]*）\\s*)+$`), '').trim() || base;   // 摘掉尾端分店括號（外送不留分店）
      base = `${base}（${tag}）`;
    }
    s = fx ? `${base}${fx}` : base;
  }
  if (/^eTag ?停車$/i.test(s)) {   // ③場站名從原文補回顯示名（僅素品牌名；已帶場站或自訂名不動）
    const em = String(ctx.desc || '').match(ETAG_RE);
    const venue = em ? em[1].replace(/[?？]亭/g, '俥亭').trim() : '';
    if (venue) s = `eTag 停車（${venue}）`;
  }
  if (String(ctx.subcategory || '') === '停車費' && !s.startsWith('停車費（')
    && ![...getUserRules().parkExempt, ...PARK_WRAP_EXEMPT].some((re) => re.test(s))) s = `停車費（${s}）`;
  return s;
}

// 品牌顯示名改寫（使用者偏好的簡稱；保留分店與其餘部分）。用簡單字串取代，維持在「顯示層」——
// 分類與 stmtRef（去重）仍用原始 desc，不受影響。新的改寫由使用者提出後加一條。
// ⚠️ 同步點（AGENTS.md）：cleanStore 收尾與「店名整理」遷移（statement-import.js）共用 normalizeStoreDisplay。
/** 每條＝[比對樣式, 取代成]。 @type {[RegExp, string][]} */
const BRAND_RENAME = [
  [/全家便利商店/g, '全家商店'],       // 使用者定 2026-07：全家便利商店（XXX）→ 全家商店（XXX）
  [/麥味登早午餐/g, '麥味登'],         // 使用者定 2026-07-18：品牌簡稱（銀行有「麥味登」「麥味登早午餐」兩種寫法，統一短的）
  // 台灣普客二四：2026-07-18 使用者定改回中文名（反轉先前的 → Times Parking），改由 BRAND_CANON 統一成「台灣普客二四」
];
/** @param {string} s @returns {string} */
function applyBrandRename(s) {
  let out = String(s || '');
  for (const [re, to] of [...getUserRules().rename, ...BRAND_RENAME]) out = out.replace(re, to);   // 使用者規則優先
  return out;
}

// 雜訊主體拆殼：收單方（聯信）或類別詞（停車場）被舊規則誤當主體、真店名被關進括號——
// 「聯信（Times Parking股份有）」「停車場（俥亭停車）」。拆出括號內容當店名，再過一次品牌正規化。
// 只認白名單主體（絕不會是真店名的詞），拆完修公司殘尾；「Times」單獨出現＝普客二四的舊縮寫。
const GENERIC_BODY = /^(?:聯信|停車場)（([^（）]+)）$/;
/** @param {string} s @returns {string} */
function promoteGenericBody(s) {
  const str = String(s || '');
  const m = str.match(GENERIC_BODY);
  if (!m) return str;
  let inner = trimCompanyTail(m[1]);
  if (/^Times$/i.test(inner)) inner = '台灣普客二四';
  return inner ? applyBrandCanon(inner) : str;
}

/**
 * 店名顯示層整理（cleanStore 收尾＋一次性遷移共用）：品牌正規化（applyBrandCanon）→ 統一分店格式
 * （branchNormalize）→ 雜訊主體拆殼（promoteGenericBody）→ 品牌簡稱（applyBrandRename）。
 * 冪等；未來若要加更多顯示規則集中在這裡。 @param {string} name @returns {string}
 */
export function normalizeStoreDisplay(name) {
  return applyBrandRename(promoteGenericBody(branchNormalize(applyBrandCanon(name))));
}

// 顯示標記的「反向」：把 note 拆回乾淨店名（停車費（X）→ X、去掉（FP））。
// 「店名格式整理」用：舊 note 若已包停車標記，巢狀括號會讓 normalizeStoreDisplay 的規則全部比不到，
// 必須先拆殼→整理→再由 applyDisplayLabels 重新上標記（兩者皆冪等，正確的 note 走一圈不變）。
/** @param {string} name @returns {string} */
export function stripDisplayLabels(name) {
  let s = String(name || '').trim();
  const m = s.match(/^停車費（(.+)）$/);   // 貪婪取到最後一個「）」→ 內容可含巢狀括號
  if (m) {
    let depth = 0, ok = true;
    for (const ch of m[1]) {   // 內容括號必須自我平衡，才確定拆的是最外層包裝
      if (ch === '（') depth++;
      else if (ch === '）' && --depth < 0) { ok = false; break; }
    }
    if (ok && depth === 0) s = m[1].trim();
  }
  s = s.replace(DELIVERY_TAG_TAIL, '').trim();   // 外送標記（FP／優食）在結尾或外幣註記前
  return s;
}

// ---- 身分鑰匙（storeKey）＝品牌層（使用者定 2026-07-18：「鑰匙像餐廳的名字、不管分店」）----
// 與顯示名的分工：cleanStore＝顯示名的自動版（帶分店，「統一超商（百福）」）；
// storeKeyOf＝辨識「同一家店」的鑰匙（不帶分店，「統一超商」）——店家消費檔案靠它合併統計、
// 學習表靠它記共用規則。分店資訊只活在顯示名，鑰匙不該因為換一家分店就變成另一家店。
/** 摘掉結尾一組「（分店）」；外幣註記（USD/9.99）先摘再接回、不當分店。 @param {string} name @returns {string} */
function stripBranch(name) {
  const raw = String(name || '').trim();
  const fxM = raw.match(/（[A-Za-z]{3}\/[\d.,]+）\s*$/);
  const fx = fxM ? fxM[0].trim() : '';
  const s = (fxM ? raw.slice(0, fxM.index) : raw).trim();
  const m = s.match(/^(.+?)（[^（）]+）$/);
  const base = (m && m[1].trim()) ? m[1].trim() : s;
  return fx ? `${base}${fx}` : base;
}
/**
 * 帳單原文 → 身分鑰匙。①加油站聚合（使用者定 2026-07-18「所有加油站都改成加油站」）：
 * 內建分類判為「交通/油錢」一律回「加油站」——中油/台亞/柑園/世新/車容坊在使用者眼中是同一件事
 * （加油），合併統計才看得出「這個月加油花多少」。用**內建 categorize(原文)** 而非交易上的分類，
 * 才不會因為使用者改分類就讓鑰匙漂移、學習全部對不上。②其餘＝cleanStore 摘掉分店。
 * @param {string} desc 帳單原文 @returns {string}
 */
export function storeKeyOf(desc) {
  const d = String(desc || '');
  if (categorize(d)[1] === '油錢') return '加油站';   // 用原文判（資訊最全）
  return storeKeyOfName(cleanStore(d));
}
/**
 * 已清理的顯示名 → 身分鑰匙（同上規則）。給「拿不到帳單原文」的資料用：手動記帳、
 * 舊資料缺 stmtRef——只能從現成的名字回推品牌層。 @param {string} name @returns {string}
 */
export function storeKeyOfName(name) {
  // 外幣註記（USD/9.99）是「這一筆的金額」不是店家身分（Codex#6）：留在鑰匙裡會讓同一家店
  // 因為每次刷的金額不同而裂成好幾把鑰匙（APPLE.COM/BILL（USD/9.99）vs（USD/19.99）），
  // 學習、排行、店家檔案全部分家。顯示名照舊保留幣別（使用者定），只有鑰匙要脫掉。
  // 分期期數同理（使用者定 2026-07-19，體檢 D7）：「第N/M期」是這一期的標記不是店家身分——
  // 留著會讓一筆分期裂成 N 把鑰匙（Apple Xinyi A 實測 7 把）。顯示名保留期數（看得到繳到第幾期）。
  const s = String(name || '').replace(/（[A-Za-z]{3}\/[\d.,]+）\s*$/, '')
    .replace(/\s*第\d+\/\d+期\s*/g, ' ').trim();
  if (categorize(s)[1] === '油錢') return '加油站';
  return stripBranch(s);
}

/** stmtRef（卡id|消費日|金額|原始說明）取回帳單原文；非帳單交易或格式不符回 ''。 @param {string|undefined} stmtRef @returns {string} */
export function origFromStmtRef(stmtRef) {
  const parts = String(stmtRef || '').split('|');
  return parts.length >= 4 ? parts.slice(3).join('|').trim() : '';   // 原文可能含「|」→ 第 3 個分隔後全取
}

// 品牌正規化（主體統一成標準名，有分店才加括號）——比 BRAND_RENAME 強：能把「主體＋分店」拆開重組。
// 例：台亞（加油站品牌）不論寫成「台亞」「台亞加油站」「台亞林口第二交流道南站」，一律 →「台亞加油站」，
//     後面有分店名才加（分店）。每條＝{ prefix: 從頭比對品牌各種寫法, brand: 標準品牌名 }。
// 分店＝比對後剩餘：純中文（BRANCH_TAIL）才加括號；已是「（分店）」則保留（冪等）；雜訊則只回品牌名。
// 結尾「單筆註記」＝外幣金額／分期期數：屬於這一筆，不是店家身分的一部分。
// 任何店名變形（品牌正規化…）都要先摘下、處理完原順序接回，否則同一家店會因為註記不同而分家。
const TAIL_NOTE = /(（[A-Za-z]{3}\/[\d.,]+）|第\d+\/\d+期)\s*$/;
/** @param {string} s @returns {[string, string]} [本體, 註記（原順序）] */
function detachTailNotes(s) {
  let base = String(s || ''), tail = '';
  for (;;) {
    const m = base.match(TAIL_NOTE);
    if (!m) return [base, tail];
    tail = m[1] + tail;
    base = base.slice(0, m.index).trim();
  }
}

/** @type {{prefix: RegExp, brand: string}[]} */
const BRAND_CANON = [
  { prefix: /^台亞(加油站)?/, brand: '台亞加油站' },   // 使用者定 2026-07
  // 普客二四（Times 停車場）：中英寫法統一成中文名（使用者定 2026-07-18；舊資料有 Times Parking 殘留）
  { prefix: /^(?:台灣普客二四|Times[ ]?Parking)(?![A-Za-z])/i, brand: '台灣普客二四' },
  // 銀行截斷版併回完整名（使用者定 2026-07-18）：同一家店被截成兩種寫法會變成兩把鑰匙、消費統計拆開。
  // 用 BRAND_CANON 而非 STORE_CANON——截斷版補回品牌名的同時，完整版後面的分店仍保留。
  { prefix: /^好麥永和豆漿(店)?/, brand: '好麥永和豆漿店' },
  { prefix: /^Zaika札伊卡(印度咖哩風味)?/i, brand: 'Zaika札伊卡' },       // 使用者定 2026-07-19：同一家
  { prefix: /^潮味決(\.?湯滷專門店)?/, brand: '潮味決' },                 // 使用者定 2026-07-19：同一家
  // Apple 信義（體檢回報 2026-07-19）：分期那幾筆的定位碼被期數擠成單一個「A」
  //（A2716 → A），與沒分期的那筆分成兩把鑰匙。剩餘的「A」不是分店＝落到「只回品牌名」。
  { prefix: /^Apple Xinyi/i, brand: 'Apple Xinyi' },
  { prefix: /^傳承永和豆漿(大王)?/, brand: '傳承永和豆漿大王' },
];
/** @param {string} s @returns {string} */
function applyBrandCanon(s) {
  const raw = String(s || '');
  // 先摘下結尾的「單筆註記」（外幣 （USD/9.99）／分期 第03/12期），最後原順序接回——
  // 品牌正規化不可把這些吃掉（幣別＝Codex#5；期數＝使用者定 2026-07-19，體檢回報 Apple Xinyi）。
  const [str, tail] = detachTailNotes(raw);
  const fx = tail;
  for (const { prefix, brand } of [...getUserRules().brand, ...BRAND_CANON]) {   // 使用者規則優先
    const m = str.match(prefix);
    if (!m) continue;
    // 剩餘去掉前導分隔符（台亞加油站-林口站 的「-」）與空白＋公司字尾殘尾（普客二四「股份有」），才判斷是不是分店（Codex#5）
    const rest = trimCompanyTail(str.slice(m[0].length).replace(/^\s*[-－﹣—–]?\s*/, ''));
    let out;
    if (rest.startsWith('（') && rest.endsWith('）')) out = brand + rest;   // 已格式化的分店 → 保留（冪等）
    else if (rest && BRANCH_TAIL.test(rest)) out = `${brand}（${rest}）`;   // 純中文分店 → 加括號
    else out = brand;                                                      // 無分店或剩餘是雜訊 → 只回品牌名
    return fx ? `${out}${fx}` : out;
  }
  return raw;
}

// 分店格式正規化（使用者定，2026-07）：把「主體＋分店」統一成「主體（分店）」（全形括號）。
// 兩種來源：①有分隔符（統一超商-百福）——限「中文主體＋中文分店」，避免 ABC-MART／LADY-M 這種英文品牌被誤切；
//          ②無分隔符的已知連鎖（誠品生活新店）——需白名單 BRANCH_CHAINS，因為電腦無法自行判斷主體到哪結束
//            （「誠品生活新店」也可能被誤切成「誠品生」＋「活新店」）。新連鎖由使用者從「店名格式整理」預覽發現後增補。
// 冪等：已是「…（分店）」不動；結尾外幣註記（USD/9.99）先摘再接回、不當分店。
// ⚠️ 同步點（AGENTS.md）：cleanStore 收尾會呼叫此函式；「店名格式整理」遷移（statement-import.js）也用它。
/** 無分隔符也要切分店的已知連鎖（主體名；後面接的即分店）。使用者可增補。 @type {string[]} */
// 健身工廠／八方雲集／少年家宵夜食堂／石二鍋＝使用者定 2026-07-18（健身工廠林口廠 → 健身工廠（林口廠））
// 傳承永和豆漿大王／好麥永和豆漿店改由 BRAND_CANON 處理（要同時併回銀行截斷版），不重複列在這裡
export const BRANCH_CHAINS = ['誠品生活', '健身工廠', '八方雲集', '少年家宵夜食堂', '石二鍋', '好市多', '威秀影城'];
const CJK = '一-鿿';
const BRANCH_TAIL = new RegExp(`^[${CJK}][${CJK}0-9]{0,9}$`);   // 分店＝中文起頭、僅中文/數字、1–10 字（擋含英文/符號的雜訊）
// 分隔符切分：主體可為任意（含英文品牌，如 IKEA-新莊、COSTCO-內湖），但分店必須「純中文起頭」——
// 這道限制讓 ABC-MART／LADY-M（分店段是英文）自然不會被切，同時涵蓋英文連鎖＋中文分店的常見樣式。
const DASH_SPLIT = new RegExp(`^(.+?)\\s*[-－﹣—–_]\\s*([${CJK}][${CJK}0-9]{0,9})$`);   // 底線＝點點付格式（水灣餐廳_碧潭店）
/** @param {string} name @returns {string} */
export function branchNormalize(name) {
  const raw = String(name || '');
  const fxM = raw.match(/（[A-Za-z]{3}\/[\d.,]+）\s*$/);   // 保留結尾外幣註記，不當分店
  const fx = fxM ? fxM[0].trim() : '';
  const s = (fxM ? raw.slice(0, fxM.index) : raw).trim();
  if (!s) return raw;
  let out = s;
  if (/^.+（[^（）]+）$/.test(s)) {                        // 已是「…（分店）」→ 不動（冪等，避免包兩層）
    out = s;
  } else {
    const dash = s.match(DASH_SPLIT);                     // ① 中文主體 - 中文分店
    if (dash) {
      out = `${dash[1].trim()}（${dash[2].trim()}）`;
    } else {                                              // ② 已知連鎖前綴 ＋ 純中文分店
      for (const chain of [...getUserRules().chains, ...BRANCH_CHAINS]) {   // 使用者規則優先
        if (s.startsWith(chain) && s.length > chain.length && BRANCH_TAIL.test(s.slice(chain.length))) {
          out = `${chain}（${s.slice(chain.length)}）`;
          break;
        }
      }
    }
  }
  return fx ? `${out}${fx}` : out;
}

// 民國日期 → 西元 ISO。支援 115/01/13（斜線，富邦/台新新版）與 1150113（7 碼，台新補印版）
/** @param {string} s @returns {string|null} */
export function rocToIso(s) {
  let str = String(s || '').trim();
  if (/^1\d{6}$/.test(str)) str = `${str.slice(0, 3)}/${str.slice(3, 5)}/${str.slice(5)}`;
  const m = str.match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const iso = `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
  // 真日曆驗證（自主體檢）：115/13/45 這種假日期以前只驗長相就放行，一路流到寫入櫃檯才炸 500、
  // 一筆壞列毒死整批匯入。這裡回 null＝該列進不了交易（匯入端以 skipped 計），其餘列不受牽連。
  return isRealDate(iso) ? iso : null;
}

// PDF → 每頁文字列（依 y 分行、x 排序重建表格；cells 為該列的文字片段陣列）
/** @param {Uint8Array} data @param {string=} password @returns {Promise<string[][]>} */
async function extractLines(data, password) {
  // pdfjs 會「detach」傳入的 ArrayBuffer（把呼叫端的 data 清空）。免選卡「試密碼」會對
  // 同一份 bytes 連續解析多次，第 2 次起就會拿到已 detach 的空 buffer→「Cannot transfer
  // object of unsupported type」，害所有需要密碼的加密帳單開不了。傳「副本」進去即可避免。
  const task = getDocument({ data: new Uint8Array(data), password, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (String(e?.name).includes('Password')) {
      throw new Error(password
        ? 'PDF 密碼錯誤（請到卡片追蹤確認「帳單 PDF 密碼」）'
        : '這份 PDF 有加密，請先到卡片追蹤設定這張卡的「帳單 PDF 密碼」', { cause: e });
    }
    throw new Error('PDF 無法開啟：' + (e.message || e), { cause: e });
  }
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    /** @type {Record<number, {x:number, s:string}[]>} */
    const rows = {};
    for (const it of tc.items) {
      if (!('str' in it) || !it.str || !it.str.trim()) continue;   // 只取有文字的 TextItem（排除 TextMarkedContent）
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str.trim() });
    }
    for (const [, cells] of Object.entries(rows).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      lines.push(cells.sort((a, b) => a.x - b.x).map(c => c.s));
    }
  }
  await task.destroy();
  return lines;
}

// 富邦帳單：明細列＝ 消費日期(民國) | 消費說明 | 入帳日期(民國) | [外幣折算日/幣別 | 外幣金額/消費地] | 台幣金額
// 兩種版式都支援：①郵寄電子帳單（說明與日期同一列）②官網「帳單明細查詢」下載版
// （交易列只有 日期|入帳日|幣別|金額，消費說明「換行」到下一列）。
/** @param {string[][]} lines @returns {RawTx[]} */
export function parseFubon(lines) {
  /** @type {RawTx[]} */
  const txs = [];
  const isRoc = (s) => /^\d{2,3}\/\d{2}\/\d{2}$/.test(s);
  const isAmt = (s) => /^-?(?=[\d,]*\d)[\d,]+(\.\d+)?$/.test(s);   // 至少一個數字（',,,'/'-,' 不算金額，自主體檢）
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i];
    if (cells.length < 3 || !isRoc(cells[0])) continue;
    const last = cells[cells.length - 1];
    if (!isAmt(last)) continue;
    const amount = Number(last.replace(/,/g, ''));
    // 消費說明＝消費日之後、入帳日之前的文字（normalizeDesc 統一兩版式的字元差異）
    const postIdx = cells.findIndex((c, k) => k > 0 && isRoc(c));
    let desc = normalizeDesc((postIdx > 0 ? cells.slice(1, postIdx) : cells.slice(1, cells.length - 1)).join(' '));
    // 外幣資訊（入帳日與金額之間若還有欄位，併進備註；國內交易的「TWD」欄不需備註）
    let extra = normalizeDesc(postIdx > 0 ? cells.slice(postIdx + 1, cells.length - 1).join(' ') : '');
    if (extra === 'TWD') extra = '';
    // 官網版：本列沒有說明 → 下一列「首格不是日期」就是換行的消費說明。
    // ⚠️ 不可用「末格是不是金額」排除（自主體檢）：店名結尾帶數字且被 pdfjs 拆開
    //（['全聯福利中心','1758']）時會被誤判成金額列 → desc 空 → 整筆交易無聲蒸發。
    // 真正的下一筆交易列一定以日期開頭，用這個判準就夠。
    if (!desc) {
      const next = lines[i + 1];
      if (next && next.length && !isRoc(next[0]) && !/^(本期|上期|總計|合計|小計|循環)/.test(String(next[0]))) {
        desc = normalizeDesc(next.join(' '));
        i++;   // 說明列已消耗，跳過
      }
    }
    if (!desc) continue;
    txs.push({
      date: rocToIso(cells[0]),
      postDate: postIdx > 0 ? rocToIso(cells[postIdx]) : null,
      desc: extra ? `${desc}（${extra}）` : desc,
      amount
    });
  }
  return txs;
}

// 台新帳單 PDF（郵寄電子帳單，加密）。交易列＝消費日 | 入帳起息日 | [消費明細] | 台幣金額 | [外幣折算日 消費地 幣別 外幣金額]。
// 兩種模板都支援：斜線民國(115/06/02) 與 7 碼民國(1150602，補印版)。金額＝兩個日期之後第一個純整數 cell
// （避開說明內含的地點碼與外幣金額）。說明有時不在交易列上，而是印在「上一行」（此列無說明時）——
// **只取上一行、不可連下一行也抓**（下一行是下一筆的說明，抓了會把兩筆說明黏在一起）；上一行無內容才退用下一行。
// 與同月 XLSX 交叉驗證：3 月 94/94、7 月 66/66，日期＋金額零誤差。
/** @param {string[][]} lines @returns {RawTx[]} */
export function parseTaishinPdf(lines) {
  const isRoc = (s) => /^\d{2,3}\/\d{2}\/\d{2}$/.test(s) || /^1\d{6}$/.test(s);
  const isAmt = (s) => /^-?(?=[\d,]*\d)[\d,]+$/.test(s);   // 至少一個數字（自主體檢）
  /** @type {RawTx[]} */
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    const c = lines[i];
    if (c.length < 3 || !isRoc(c[0]) || !isRoc(c[1])) continue;
    let ai = -1;
    for (let k = 2; k < c.length; k++) { if (isAmt(c[k])) { ai = k; break; } }
    if (ai < 0) continue;
    const amount = Number(c[ai].replace(/,/g, ''));
    let desc = normalizeDesc(c.slice(2, ai).join(' '));
    if (!desc) {   // 說明印在相鄰非交易列：優先取「上一行」，上一行沒有才退用「下一行」（不可兩行都抓＝會黏到下一筆）
      const prev = lines[i - 1], next = lines[i + 1];
      const pa = (prev && !isRoc(prev[0])) ? normalizeDesc(prev.join(' ')) : '';
      const nb = (next && !isRoc(next[0])) ? normalizeDesc(next.join(' ')) : '';
      desc = pa || nb;
    }
    if (!desc) continue;
    // 外幣：金額後若有幣別碼（USD…）＋外幣金額，接進說明（與 XLSX 一致，讓跨格式去重對得上）
    const rest = c.slice(ai + 1);
    const ci = rest.findIndex(x => /^[A-Z]{3}$/.test(x));
    if (ci >= 0 && rest[ci + 1] && /^[\d.,]+$/.test(rest[ci + 1])) desc = `${desc}（${rest[ci]}/${rest[ci + 1]}）`;
    raw.push({ date: rocToIso(c[0]), postDate: rocToIso(c[1]), desc, amount });
  }
  return raw;
}

// 「國外交易服務費」的判準（唯一真相）：finalize 的「繼承前一筆分類」與 learning 的「不學習」共用，
// 避免同一條規則寫兩處而走鐘。說明長相：國外交易服務費-2350.00（帶當筆金額）。
/** @param {string} desc @returns {boolean} */
export const isServiceFee = (desc) => /國外交易服務費/.test(String(desc || ''));

// 分類＋國外交易服務費繼承（PDF/XLSX 各家解析器的原始明細共用這道後處理）。
// raw=[{date, postDate, desc, amount}]，回傳 { bank, transactions:[{...,isPayment,category,subcategory}] }
/** @param {RawTx[]} raw @param {string} bank @returns {{ bank: string, transactions: ParsedTx[] }} */
export function finalize(raw, bank) {
  const txs = raw.map(t => {
    const isPayment = t.amount < 0;   // 負數＝繳款/退款，預設不匯入記帳
    const [cat, sub] = isPayment ? ['繳款/退款', ''] : categorize(t.desc);
    // store＝顯示名（帶分店）、storeKey＝身分鑰匙（品牌層）——兩者分工見 storeKeyOf 檔頭
    return { ...t, isPayment, category: cat, subcategory: sub, store: cleanStore(t.desc), storeKey: storeKeyOf(t.desc) };
  });
  // 「國外交易服務費」跟隨它所屬的那筆刷卡分類（費用緊接在該筆消費之後）
  for (let i = 1; i < txs.length; i++) {
    if (!txs[i].isPayment && isServiceFee(txs[i].desc)) {
      const prev = txs[i - 1];
      if (prev && !prev.isPayment && !isServiceFee(prev.desc)) {
        txs[i].category = prev.category;
        txs[i].subcategory = prev.subcategory;
      }
    }
  }
  return { bank, transactions: txs };
}

// 台新 XLSX（官網下載「信用卡明細」）：西元日期、金額獨立欄，結構乾淨。
// 交易列＝ col0 消費日期(YYYY/MM/DD) | col1 入帳日 | col2 消費明細 | col3 幣別 | col4 金額 | … col7 外幣幣別/金額
/** @param {Uint8Array} data @returns {RawTx[]} */
export function parseTaishinXlsx(data) {
  const wb = XLSX.read(data, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  const isDate = (s) => /^\d{4}\/\d{2}\/\d{2}$/.test(String(s || '').trim());
  const raw = [];
  for (const r of rows) {
    if (!isDate(r[0])) continue;
    const amount = Number(String(r[4]).replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount === 0) continue;
    let desc = normalizeDesc(String(r[2] || ''));
    const fx = String(r[7] || '').trim();   // 外幣幣別/金額，如 USD/9.99
    if (fx) desc = `${desc}（${fx}）`;
    if (!desc) continue;
    const isoDate = (/** @type {any} */ v) => {
      const p = String(v || '').trim().split(/[/／-]/);
      if (p.length !== 3) return '';
      const d = `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}`;
      return isRealDate(d) ? d : '';   // 假日期（2026-13-45）回空＝該列跳過，不毒整批（自主體檢）
    };
    const dISO = isoDate(r[0]);
    if (!dISO) continue;
    raw.push({ date: dISO, postDate: isoDate(r[1]) || null, desc, amount });
  }
  return raw;
}

// PDF 依「文件內容」自動辨識銀行（不看使用者選的卡片——卡片只決定記到哪＋PDF 密碼）。
// 兩家版式結構本就不同（台新每列開頭兩個民國日期、富邦一個），且帳單一定印自家行名；
// 先用行名關鍵字判斷方向，命中的解析器有結果就採用，否則挑解析到較多筆的那家。
/** @param {string[][]} lines @returns {{ bank: string, raw: RawTx[] }} */
export function parsePdfAuto(lines) {
  const text = lines.map(l => l.join(' ')).join('\n');
  const taishinHits = (text.match(/台\s*新|Taishin|Richart/gi) || []).length;
  const fubonHits = (text.match(/富\s*邦|Fubon/gi) || []).length;
  const fubon = { bank: '富邦', raw: parseFubon(lines) };
  const taishin = { bank: '台新', raw: parseTaishinPdf(lines) };
  if (taishinHits > fubonHits && taishin.raw.length) return taishin;
  if (fubonHits > taishinHits && fubon.raw.length) return fubon;
  return taishin.raw.length > fubon.raw.length ? taishin : fubon;   // 行名不明時挑筆數多者（皆 0 → 上層報錯）
}

// 從帳單內容抓「卡號末四碼」（盡力而為；抓不到回 null，上層退回請使用者選卡）。
// 帳單卡號多為遮罩顯示，樣式各家不同，先支援常見幾種；真實帳單校準後再補。
/** @param {string} text @returns {string|null} */
export function extractLastFour(text) {
  const t = String(text || '');
  let m = t.match(/末\s*[四4]\s*碼[^\d]{0,6}(\d{4})/);          // ①「末四碼 1234」「卡號末4碼：1234」
  if (m) return m[1];
  m = t.match(/[*Xx#•●](?:[\s*Xx#•●-]*)(\d{4})\b/); // ②遮罩後接四碼：**** **** **** 1234
  if (m) return m[1];
  m = t.match(/卡號[^\n]{0,30}?(\d{4})\b(?!.*\d)/m);            // ③「卡號…」該行最後一組四碼
  if (m) return m[1];
  return null;
}

// 從帳單內容抓「這是哪一期的帳單」（使用者定 2026-07-19：不可用最後一筆消費日回推——
// 結帳日落在月初時，末筆消費日的月份會跟帳單期別對不上，兩期還可能撞成同一個月）。
// 只掃**表頭區**（前 1500 字）：明細區滿是消費日期，掃全文會抓到交易日而非期別。
// 優先序（使用者定 2026-07-19，以結帳日為準）：
//   ①**結帳日所在月份**——`結帳日 2026/02/02` → 2026-02。**不論月初月尾都算當月**
//     （使用者原本說「月初算上個月」，後來更正為一律當月）。結帳日最權威：它定義了帳單期間的結束。
//   ②明寫的期別欄位（富邦「帳單年月：115/01」）
//   ③「115年06月份」這類年月寫法
//   ④標題型（台新「2026/02 信用卡明細」）
// 全部抓不到回 null，上層退回「末筆消費日的月份」當保底並在 UI 標「推估」、可手動修正。
/** @param {string} text @returns {string|null} YYYY-MM */
export function extractStatementMonth(text) {
  const head = String(text || '').slice(0, 1500);
  /** @param {string} y @param {string} m @returns {string|null} */
  const toIso = (y, m) => {
    const mm = Number(m);
    if (!(mm >= 1 && mm <= 12)) return null;
    const yy = Number(y);
    const year = yy < 1000 ? yy + 1911 : yy;                    // 民國 115 → 2026
    return (year >= 2000 && year <= 2100) ? `${year}-${String(mm).padStart(2, '0')}` : null;
  };
  // ①結帳日（最優先）：先找「本期」系標籤，找不到才退回裸「結帳日」——且裸的前面不可是
  // 上/下/前/次（自主體檢：台新表頭常同印「上期結帳日」「下次結帳日」，交替組含子字串照樣命中、
  // match 取最早出現者 → 期別無聲標成上一期或下一期，UI 又不會標「推估」看起來很權威）
  let m = head.match(/(本期結帳日|帳單結帳日|帳單日期)[^0-9]{0,8}(1\d{2}|20\d{2})\s*[/／.-]\s*(\d{1,2})\s*[/／.-]\s*\d{1,2}/);
  if (m) { const r = toIso(m[2], m[3]); if (r) return r; }
  m = head.match(/(?<![期次])(結帳日)[^0-9]{0,8}(1\d{2}|20\d{2})\s*[/／.-]\s*(\d{1,2})\s*[/／.-]\s*\d{1,2}/);   // 擋「×期結帳日」「下次結帳日」（緊鄰字＝期/次）
  if (m) { const r = toIso(m[2], m[3]); if (r) return r; }
  // ②明寫的期別欄位（富邦「帳單年月：115/01」）
  m = head.match(/(帳單年月|帳單月份|帳單期別)[^0-9]{0,8}(1\d{2}|20\d{2})\s*[/／年.-]\s*(\d{1,2})/);
  if (m) { const r = toIso(m[2], m[3]); if (r) return r; }
  // ③「115年06月份」「民國 115 年 1 月」
  m = head.match(/(?:民國\s*)?(1\d{2}|20\d{2})\s*年\s*(\d{1,2})\s*月/);
  if (m) { const r = toIso(m[1], m[2]); if (r) return r; }
  // ④標題型（台新「2026/02 信用卡明細」）：後面緊接帳單類字眼才算，且不可是完整日期的前兩段
  m = head.match(/(1\d{2}|20\d{2})\s*[/／]\s*(\d{1,2})(?!\s*[/／]\s*\d)(?=[^\n]{0,12}(?:信用卡|明細|帳單|對帳單))/);
  if (m) { const r = toIso(m[1], m[2]); if (r) return r; }
  return null;
}

// 從帳單抓「應繳金額」（使用者定 2026-07-19）：批次列表的「匯入金額」是**實際記帳的消費總和**，
// 與銀行的應繳金額本來就不同（應繳＝上期未繳＋本期新增＋分期本期＋年費利息−已繳款/退款；
// 我們刻意不匯入繳款/退款那些負數）。把帳單自己印的數字一起存起來，對帳時一眼看到差多少。
// 各家欄位名不同，依優先序比對（台新有兩個欄位，以「本期應繳總金額」為主）。
// 「本期帳單金額」＝台新**官網 XLSX**的叫法（2026-07-20 使用者實測 2026-02 抓不到）——同一家銀行
// 郵寄版與網站版連欄位名都不同；XLSX 裡完全沒有「應繳」開頭的總額欄（只有「最低應繳金額」，
// 那不是我們要的）。放最後＝優先序最低，兩種版本欄位並存時仍以「應繳」系列為準。
const DUE_KEYS = ['本期應繳總金額', '本期應繳總額', '本期應繳金額', '本期累計應繳金額', '本期帳單金額'];
/**
 * 抓帳單自己印的應繳金額。兩種版面（2026-07-20 使用者實測 115/01 郵寄版抓錯後改寫）：
 * ①**同一行**：欄位名後 14 字內的數字（富邦「本期應繳總額：12,345」、台新官網版）。
 * ②**標籤行＋數值行**（台新郵寄版）：摘要是一行標籤、下一行全是數字——
 *     上期應款總額 - (已繳款金額+本期退款) + 本期新增款項 = 本期累計應繳金額 本期最低應繳金額
 *       10,449          10,449               58,459            58,459           8,257
 *   舊寫法的 regex 會跨行滑進數值行、撞到第一個數字＝**隔壁欄（上期）的值**（實抓 10,449、應為 58,459）。
 *   正解＝**依欄位序數對位**：標籤行裡「本期累計應繳金額」是第 4 個欄位 → 取數值行第 4 個數字。
 *   守門：標籤行必須「含鍵且無任何數字」、數值行必須「幾乎全是數字」（≥8 成 token）、
 *   序數不超界——不像這種版型就跳過，寧可回 null（列表顯示「—」）也不猜錯。
 * @param {string} text @returns {number|null}
 */
export function extractStatementDue(text) {
  const lines = String(text || '').split('\n');
  const OP = /^[-+=＝＋－×*/]+$/;                      // 標籤行裡的運算符 token（不算欄位）
  const NUM = /^-?[\d,]+(?:\.\d+)?$/;
  for (const k of DUE_KEYS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idx = line.indexOf(k);
      if (idx < 0) continue;
      // ①同一行：鍵後 14 個非數字字元內的數字（原行為，但**不可跨行**——跨行正是這次的病根）
      const m = line.slice(idx + k.length).match(/^[^0-9-]{0,14}(-?[\d,]+(?:\.\d+)?)/);
      if (m) {
        const n = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
      }
      // ②標籤行＋數值行：本行完全無數字，下一行是數值行 → 依欄位序數對位
      if (/\d/.test(line)) continue;
      const rawTokens = line.trim().split(/\s+/).filter(t => !OP.test(t));      // 欄位（去掉 - + = 運算符）
      // 括號組併回一欄（Codex r5#3）：PDF 有時把「(已繳款金額＋本期退款)」拆出內部空格
      // →「(已繳款金額」「本期退款)」變兩個 token，欄位數一多、序數就對到隔壁欄
      //（實測抓到「最低應繳金額」）。用括號深度計數，把整組併回一個標籤。
      /** @type {string[]} */
      const labels = [];
      let buf = '', depth = 0;
      for (const t of rawTokens) {
        depth += (t.match(/[(（]/g) || []).length - (t.match(/[)）]/g) || []).length;
        buf = buf ? buf + t : t;
        if (depth <= 0) { labels.push(buf); buf = ''; depth = 0; }
      }
      if (buf) labels.push(buf);                                                // 括號沒閉合＝照原樣收尾，別丟欄
      const nextTokens = (lines[i + 1] || '').trim().split(/\s+/).filter(Boolean);
      const nums = nextTokens.filter(t => NUM.test(t));
      if (!nums.length) continue;
      // 單一標籤配數值行＝無歧義，直接取——但「標籤」必須幾乎就是欄位名本身（≤4 個裝飾字，
      // 如冒號/NT$），且下一行過半是數字。否則「……本期應繳金額……」這種**散文行**（整行沒空白
      // ＝一個 token）也會被當標籤，配上後面隨便一行明細就抓錯（考題實抓：散文＋明細列 → 150）。
      if (labels.length === 1) {
        const deco = labels[0].replace(/[:：]/g, '').length - k.length;
        if (deco >= 0 && deco <= 4 && nums.length >= nextTokens.length * 0.5) {
          const n = Number(nums[0].replace(/,/g, ''));
          if (Number.isFinite(n)) return n;
        }
        continue;
      }
      // 多欄：下一行必須「幾乎全是數字」（≥8 成 token）、**欄位數與數字數相等**（Codex r5#3 加嚴：
      // 併完括號組仍對不齊＝這行不是我們認得的版型，序數對位沒有意義，寧可回 null 也不硬猜）
      // 且序數對得上——否則不猜
      if (nums.length < 2 || nums.length < nextTokens.length * 0.8) continue;
      if (labels.length !== nums.length) continue;
      const ord = labels.findIndex(t => t.includes(k));
      if (ord < 0 || ord >= nums.length) continue;
      const n = Number(nums[ord].replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// XLSX 全表文字（供 extractLastFour 掃卡號；交易列以外的表頭也要看）。
/** @param {Uint8Array} data @returns {string} */
function xlsxAllText(data) {
  try {
    const wb = XLSX.read(data, { type: 'array' });
    /** @type {string[]} */
    const out = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
      for (const r of rows) out.push(r.join(' '));
    }
    return out.join('\n');
  } catch { return ''; }
}

// 主入口：data=Uint8Array（PDF 或 XLSX，依位元組自動偵測）。password 僅加密 PDF 需要。
// 系統只負責把消費明細抽出來——PDF 銀行由文件內容判斷（parsePdfAuto）、卡片末四碼由 extractLastFour 抽出，
// 供上層自動歸卡；不用卡片 issuer 分流或擋銀行。回 { bank, lastFour, transactions }。
// 未來新增銀行＝加 parseXxx() 並補進 parsePdfAuto。
/** @param {Uint8Array} data @param {string=} password @returns {Promise<StatementResult>} */
export async function parseStatement(data, password) {
  const isXlsx = data[0] === 0x50 && data[1] === 0x4B;   // ZIP（xlsx）魔術位元組 "PK"
  if (isXlsx) {
    const raw = parseTaishinXlsx(data);
    if (!raw.length) throw new Error('這份 XLSX 找不到消費明細——目前 XLSX 支援台新官網下載的「信用卡明細」格式。');
    const allText = xlsxAllText(data);
    return { ...finalize(raw, '台新'), lastFour: extractLastFour(allText), statementMonth: extractStatementMonth(allText), statementDue: extractStatementDue(allText) };
  }
  const lines = await extractLines(data, password);
  const { bank, raw } = parsePdfAuto(lines);
  if (!raw.length) throw new Error('找不到消費明細——PDF 目前支援富邦與台新兩家的帳單格式，或該期沒有交易。');
  const allText = lines.map(l => l.join(' ')).join('\n');
  return { ...finalize(raw, bank), lastFour: extractLastFour(allText), statementMonth: extractStatementMonth(allText), statementDue: extractStatementDue(allText) };
}

// 相容舊呼叫名（server.js 已改用 parseStatement）
export const parseStatementPdf = parseStatement;
