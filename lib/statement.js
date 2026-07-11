// 信用卡帳單 PDF 解析：解密（密碼存卡片的 pdfPassword，本機 store.json、永不進版控）、
// 抽出消費明細、關鍵字自動分類（兩層：大類／子類）。PDF 本身不落地保存，只回傳解析結果。
// v1 支援富邦；新增銀行＝加一個 parseXxx() 並在 parseStatementPdf 依 issuer 分流。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { DEFAULT_EXPENSE } from '../public/modules/categories.js';

// ---- 關鍵字 → [大類, 子類]（比對「消費說明」，由上往下先中先贏）----
// 分類字串必須對得上 public/modules/categories.js 的 EXPENSE_TREE（AGENTS.md 同步點）。
// 順序重點：特殊指定（YouTube→學習、ChatGPT/Claude/Notion→工作、汽車保險→交通）與
// 較專一的關鍵字要排在通用之前，才不會被通用規則先攔截。
const CATEGORY_RULES = [
  // 工作（軟體訂閱要在其他通用之前）
  ['工作', 'ChatGPT', ['CHATGPT', 'OPENAI']],
  ['工作', 'Claude', ['CLAUDE', 'ANTHROPIC']],
  ['工作', 'Notion', ['NOTION']],
  ['工作', 'Canva及其他工作軟體', ['CANVA', 'ADOBE', 'FIGMA', 'MICROSOFT', 'OFFICE 365', 'MICROSOFT 365']],
  ['工作', '網站／網域／雲端服務', ['GITHUB', 'DROPBOX', 'GODADDY', 'CLOUDFLARE', 'VERCEL', 'AWS', 'GOOGLE CLOUD', '網域']],
  // 學習
  ['學習', 'YouTube Premium', ['YOUTUBE']],
  ['學習', '學習型訂閱服務', ['UDEMY', 'COURSERA', 'HAHOW', '均一', '線上課程', 'MASTERCLASS']],
  ['學習', '書籍', ['博客來', '讀冊', '金石堂', '誠品書', 'BOOKS']],
  ['學習', '考試／證照費', ['測驗中心', '報名費', '證照', '檢定']],
  // 交通（汽車保險要在保險之前）
  ['交通', '汽車保險', ['汽車保險', '強制險', '車體險', '車險']],
  ['交通', '油錢', ['中油', '台亞', '加油站', '加油', '福記', '柑園加油']],
  ['交通', '停車費', ['停車', '嘟嘟房', '停車場', '城市車旅', '和雲', 'TIMES', '拖吊']],
  ['交通', '計程車／Uber', ['UBER TRIP', '優步', '台灣大車隊', '計程車', 'TAXI', '55688', 'YOXI']],
  ['交通', '大眾運輸', ['悠遊卡', '一卡通', '高鐵', '台鐵', '捷運', '客運', '公車', '台灣鐵路']],
  ['交通', '過路費', ['ETAG', '遠通電收', '國道']],
  ['交通', '牌照稅', ['牌照稅']],
  ['交通', '燃料使用費', ['燃料費', '燃料使用']],
  ['交通', '汽車保養', ['汽車保養', '原廠保養', '定保']],
  ['交通', '洗車', ['洗車']],
  // 娛樂（旅遊、影音、遊戲…）
  ['娛樂', '旅遊', ['AGODA', 'BOOKING.COM', 'BOOKING ', 'EXPEDIA', 'AIRBNB', 'HOTELS.COM', 'TRIP.COM', 'KKDAY', 'KLOOK', '雄獅', '易遊網', '可樂旅遊', '五福旅遊', '燦星', '旅行社', '訂房', '飯店', '酒店', '旅館', '民宿', '度假村', 'RESORT', 'HOTEL', '溫泉會館', '航空', '機票', 'EVA AIR', 'TIGERAIR', '護照', '領事', '簽證', '外交部領事']],
  ['娛樂', 'Netflix及影音串流', ['NETFLIX', 'DISNEY', 'HBO', 'PRIME VIDEO', 'FRIDAY影音', 'CATCHPLAY', 'APPLE.COM/BILL', 'ICLOUD']],
  ['娛樂', '音樂', ['SPOTIFY', 'KKBOX', 'APPLE MUSIC']],
  ['娛樂', '遊戲', ['STEAM', 'PLAYSTATION', 'NINTENDO', 'GOOGLE PLAY', '遊戲橘子', '巴哈姆特']],
  ['娛樂', '電影', ['威秀', '秀泰', '國賓影城', '新光影城', '電影', 'CINEMA', 'VIESHOW']],
  ['娛樂', '樂園／展覽', ['樂園', '動物園', '展覽', '美術館', '博物館', '六福', '劍湖山', '麗寶', 'KTV']],
  ['娛樂', '興趣用品', ['誠品']],
  // 身心（醫療/美容/健身/按摩）
  ['身心', '健身房', ['健身', 'GYM', 'WORLD GYM', 'ANYTIME']],
  ['身心', '美髮', ['髮藝', '美髮', '造型', '沙龍', 'HAIR', '剪髮']],
  ['身心', '美容', ['美容', '護膚', '美甲', '美睫', 'SPA', '芳療']],
  ['身心', '按摩', ['按摩', '指壓', '紓壓', '推拿', '整復']],
  ['身心', '牙科', ['牙醫', '牙科']],
  ['身心', '看診', ['醫院', '診所', '醫療', '婦產', '眼科', '皮膚科']],
  ['身心', '醫藥', ['藥局', '藥師', '大樹', '杏一']],
  ['身心', '健檢', ['健檢', '健康檢查']],
  ['身心', '保健食品', ['保健', '維他命', '善存', '葡萄王']],
  // 飲食（先認真正的店家，把子類判準；外送平台前綴放最後當保底，確保仍落在飲食）
  ['飲食', '超市', ['全聯', '家樂福', '大潤發', '美廉社', '好市多', 'COSTCO', '超市', 'JASONS', '楓康', '頂好']],
  ['飲食', '飲料／咖啡', ['星巴克', 'STARBUCKS', '路易莎', 'CAMA', '咖啡', '清心', '五十嵐', 'COMEBUY', '手搖', '飲料', '可不可', '大苑子', '迷客夏', '聲島', 'BEING']],
  ['飲食', '早餐／便當', ['麥味登', '早餐', '早午餐', '美而美', '便當', '豆漿']],
  ['飲食', '餐廳', ['餐廳', '餐飲', '石二鍋', '鼎泰豐', '麥當勞', '肯德基', '摩斯', '漢堡', '火鍋', '燒肉', '燒臘', '食堂', '小吃', '拉圖爾', '12MINI', 'LADY M', 'LADY-M', '秘食', '墨爾']],
  ['飲食', '超市', ['統一超商', '7-ELEVEN', '全家', '萊爾富', 'OK超商', '超商']],   // 超商暫歸超市桶
  ['飲食', '外送', ['FOODPANDA', 'FP-', 'UBER EATS', 'UBEREATS', '優食', 'FP＊']],   // 保底：認不出店家的外送仍歸飲食
  // 居住
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
  ['生活', '3C產品', ['3C', 'APPLE STORE', 'STUDIO A', '德誼', '燦坤', '全國電子']],
  ['生活', '衣服', ['UNIQLO', 'ZARA', 'H&M', 'NET', '服飾', 'GU', 'LATIV', 'GLOBAL MALL']],
  ['生活', '鞋子', ['ABC-MART', 'NIKE', 'ADIDAS', '球鞋']],
  ['生活', '清潔用品', ['清潔', '洗衣']],
  ['生活', '所得稅', ['所得稅', '綜所稅']],
  ['生活', '行政規費', ['規費', '監理', '戶政', '地政', '區公所', '地價稅', '房屋稅']],
  ['生活', '日用品', ['MOMO', 'PCHOME', '蝦皮', 'SHOPEE', 'COUPANG', '酷澎', 'momo購物']],
  // 保險
  ['保險', '壽險', ['人壽', '壽險']],
  ['保險', '其他個人保險', ['保險', '產險']],
  // 養育
  ['養育', '補習／才藝', ['補習', '安親', '才藝', '美語', '音樂教室', '畫室']],
  ['養育', '孩子學費', ['幼兒園', '幼稚園', '托嬰', '學費']],
  // 社交
  ['社交', '捐款', ['捐款', '基金會', '紅十字', '世界展望', '慈濟']]
];

// 回傳 [大類, 子類]。未命中→生活/其他生活雜支。
export function categorize(desc) {
  const d = String(desc || '').toUpperCase();
  for (const [cat, sub, keys] of CATEGORY_RULES) {
    if (keys.some(k => d.includes(k.toUpperCase()))) return [cat, sub];
  }
  return [...DEFAULT_EXPENSE];
}

// 正規化消費說明：官網版 PDF 用康熙部首異體字（⼝≠口）且字間插空白，
// 郵寄版用全形英數。統一成標準字＋半形，讓兩版產生一致的說明與 stmtRef
// （否則同一筆消費跨版式上傳會被當成新的重複匯入、分類關鍵字也比對不到）。
const RADICAL_FIX = { '⺠': '民' };   // NFKC 涵蓋不到的個別部首，遇到再補
export function normalizeDesc(s) {
  return String(s || '')
    .replace(/[⺀-⿟]/g, (c) => RADICAL_FIX[c] || c)
    .normalize('NFKC')   // 康熙部首→標準字、全形英數→半形
    .replace(/\s+(?=[㐀-鿿])|(?<=[㐀-鿿])\s+/g, '')   // CJK 相鄰的空白（部首拆字造成）
    .replace(/\s+/g, ' ').trim();
}

// 民國日期 115/01/13 → 2026-01-13
function rocToIso(s) {
  const m = String(s || '').match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
}

// PDF → 每頁文字列（依 y 分行、x 排序重建表格；cells 為該列的文字片段陣列）
async function extractLines(data, password) {
  const task = getDocument({ data, password, verbosity: 0 });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (String(e?.name).includes('Password')) {
      throw new Error(password
        ? 'PDF 密碼錯誤（請到卡片追蹤確認「帳單 PDF 密碼」）'
        : '這份 PDF 有加密，請先到卡片追蹤設定這張卡的「帳單 PDF 密碼」');
    }
    throw new Error('PDF 無法開啟：' + (e.message || e));
  }
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const rows = {};
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str.trim() });
    }
    for (const [, cells] of Object.entries(rows).sort((a, b) => b[0] - a[0])) {
      lines.push(cells.sort((a, b) => a.x - b.x).map(c => c.s));
    }
  }
  await task.destroy();
  return lines;
}

// 富邦帳單：明細列＝ 消費日期(民國) | 消費說明 | 入帳日期(民國) | [外幣折算日/幣別 | 外幣金額/消費地] | 台幣金額
// 兩種版式都支援：①郵寄電子帳單（說明與日期同一列）②官網「帳單明細查詢」下載版
// （交易列只有 日期|入帳日|幣別|金額，消費說明「換行」到下一列）。
function parseFubon(lines) {
  const txs = [];
  const isRoc = (s) => /^\d{2,3}\/\d{2}\/\d{2}$/.test(s);
  const isAmt = (s) => /^-?[\d,]+(\.\d+)?$/.test(s);
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
    // 官網版：本列沒有說明 → 下一列若非日期列也非金額列，就是換行的消費說明
    if (!desc) {
      const next = lines[i + 1];
      if (next && next.length && !isRoc(next[0]) && !isAmt(next[next.length - 1])) {
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

// 主入口：data=PDF Uint8Array。回傳 { bank, transactions:[{date, desc, amount, category, subcategory, isPayment}] }
export async function parseStatementPdf(data, password, issuer = '') {
  const lines = await extractLines(data, password);
  // v1 都走富邦格式；未來依 issuer 關鍵字分流（國泰/台新/玉山…）
  const bank = /富邦/.test(issuer) ? '富邦' : '富邦';
  const raw = parseFubon(lines);
  if (!raw.length) throw new Error('找不到消費明細——可能不是支援的帳單格式（目前支援：富邦），或該期沒有交易。');
  const txs = raw.map(t => {
    const isPayment = t.amount < 0;   // 負數＝繳款/退款，預設不匯入記帳
    const [cat, sub] = isPayment ? ['繳款/退款', ''] : categorize(t.desc);
    return { ...t, isPayment, category: cat, subcategory: sub };
  });
  // 「國外交易服務費」跟隨它所屬的那筆刷卡分類（費用緊接在該筆消費之後）：
  // AGODA 的服務費→娛樂/旅遊、Netflix 的服務費→娛樂/影音…，而非一律丟生活雜項。
  for (let i = 1; i < txs.length; i++) {
    if (!txs[i].isPayment && /國外交易服務費/.test(txs[i].desc)) {
      const prev = txs[i - 1];
      if (prev && !prev.isPayment && !/國外交易服務費/.test(prev.desc)) {
        txs[i].category = prev.category;
        txs[i].subcategory = prev.subcategory;
      }
    }
  }
  return { bank, transactions: txs };
}
