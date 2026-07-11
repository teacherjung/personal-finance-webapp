// 信用卡帳單 PDF 解析：解密（密碼存卡片的 pdfPassword，本機 store.json、永不進版控）、
// 抽出消費明細、關鍵字自動分類。PDF 本身不落地保存，只回傳解析結果。
// v1 支援富邦；新增銀行＝加一個 parseXxx() 並在 parseStatementPdf 依 issuer 分流。
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// ---- 關鍵字 → 分類（比對「消費說明」，由上往下先中先贏；分類需存在於記帳頁 CATEGORIES）----
const CATEGORY_RULES = [
  ['訂閱', ['NETFLIX', 'SPOTIFY', 'YOUTUBE', 'GOOGLE', 'APPLE.COM', 'ICLOUD', 'OPENAI', 'ANTHROPIC', 'CHATGPT', 'CLAUDE', 'DISNEY', 'KKBOX', 'PRIME VIDEO', 'MICROSOFT', 'NOTION', 'DROPBOX', 'GITHUB']],
  ['旅遊', ['AGODA', 'BOOKING.COM', 'BOOKING ', 'EXPEDIA', 'AIRBNB', 'HOTELS.COM', 'TRIP.COM', 'KKDAY', 'KLOOK', '雄獅', '易遊網', '可樂旅遊', '五福旅遊', '燦星', '旅行社', '訂房', '飯店', '酒店', '旅館', '民宿', '度假村', 'RESORT', 'HOTEL', '溫泉會館', '護照', '領事', '簽證', '外交部領事']],
  ['交通', ['悠遊卡', '一卡通', '中油', '台亞', '加油', '停車', '嘟嘟房', '台灣大車隊', 'TAXI', 'UBER TRIP', '優步', '高鐵', '台鐵', '捷運', '長榮航空', '中華航空', 'EVA AIR', 'TIGERAIR', '航空', '機票']],
  ['飲食', ['全聯', '家樂福', '7-ELEVEN', '統一超商', '全家', '萊爾富', 'OK超商', '美廉社', 'FOODPANDA', 'FP-', 'UBER EATS', 'UBEREATS', '優食', '麥當勞', '肯德基', '摩斯', '麥味登', '星巴克', 'STARBUCKS', '路易莎', 'CAMA', '咖啡', '餐廳', '餐飲', '小吃', '燒肉', '燒臘', '火鍋', '鼎泰豐', '食堂', '便當', '早餐', '早午餐', '飲料', '手搖', '漢堡', '豆漿', '12MINI', 'LADY M', 'LADY-M']],
  ['醫療', ['醫院', '診所', '牙醫', '藥局', '藥師', '醫美', '健檢']],
  // 身心：美容美髮＋按摩紓壓＋健身（自我照護）。放在醫療之後，讓「醫學美容診所」等仍歸醫療。
  ['身心', ['髮藝', '造型', '美髮', '美容', '美甲', '美睫', '護膚', '沙龍', 'SALON', 'SPA', '按摩', '指壓', '紓壓', '芳療', '身心', '健身', '瑜珈', '皮拉提斯']],
  ['保險', ['保險', '人壽', '產險']],
  ['稅務', ['地價稅', '房屋稅', '牌照', '燃料', '所得稅', '稅款']],
  ['子女教育', ['幼兒園', '托嬰', '學費', '補習', '安親', '才藝']],
  ['娛樂', ['誠品', '博客來', '威秀', '秀泰', '國賓影城', '電影', 'STEAM', 'PLAYSTATION', 'NINTENDO', '遊戲', 'KTV']],
  ['生活雜支', ['屈臣氏', '康是美', '寶雅', 'IKEA', '特力屋', 'MOMO', 'PCHOME', '蝦皮', 'SHOPEE', 'COUPANG', '酷澎', 'COSTCO', '好市多', '大潤發', '水費', '電費', '瓦斯', '中華電信', '台灣大哥大', '遠傳', '台灣電力', '自來水', '洗衣', '五金']]
];

export function categorize(desc) {
  const d = String(desc || '').toUpperCase();
  for (const [cat, keys] of CATEGORY_RULES) {
    if (keys.some(k => d.includes(k.toUpperCase()))) return cat;
  }
  return '其他';
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

// 主入口：data=PDF Uint8Array。回傳 { bank, transactions:[{date, desc, amount, category, isPayment}] }
export async function parseStatementPdf(data, password, issuer = '') {
  const lines = await extractLines(data, password);
  // v1 都走富邦格式；未來依 issuer 關鍵字分流（國泰/台新/玉山…）
  const bank = /富邦/.test(issuer) ? '富邦' : '富邦';
  const raw = parseFubon(lines);
  if (!raw.length) throw new Error('找不到消費明細——可能不是支援的帳單格式（目前支援：富邦），或該期沒有交易。');
  const txs = raw.map(t => ({
    ...t,
    isPayment: t.amount < 0,   // 負數＝繳款/退款，預設不匯入記帳
    category: t.amount < 0 ? '繳款/退款' : categorize(t.desc)
  }));
  // 「國外交易服務費」跟隨它所屬的那筆刷卡分類（費用緊接在該筆消費之後）：
  // AGODA 的服務費→旅遊、Netflix 的服務費→訂閱…，而非一律丟其他。
  for (let i = 1; i < txs.length; i++) {
    if (!txs[i].isPayment && /國外交易服務費/.test(txs[i].desc)) {
      const prev = txs[i - 1];
      if (prev && !prev.isPayment && !/國外交易服務費/.test(prev.desc)) txs[i].category = prev.category;
    }
  }
  return { bank, transactions: txs };
}
