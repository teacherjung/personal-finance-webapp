// 找出「匯率被數字字面量當退路」的算式——丙（#556）護欄用：匯率表只有 fx-rates.js 一份實作，
// 其他檔不可以自己寫死一個預設匯率（改常數時那些地方不會跟著改＝兩套數字）。
//
// 用 TypeScript 解析器看語法樹，不用正規式（#558 r3：正規式 `(fxTwd|usdTwd|GBP|JPY)…|| 數字`
// 對 `USD ||  31`（名單沒 USD、兩個空白）假綠，對 `GBP.count || 0`（筆數不是匯率）假紅）。
//
// 判準（三種形狀，數字含負號）：
//   ① `X || 數字`、`X ?? 數字`（`a || b || 31` 這種鏈整條攤開看）
//   ② `條件 ? X : 數字`／`條件 ? 數字 : X`
//   命中＝被退路的 X（①）或條件／另一支（②）的「末端名字」落在匯率名單 FX_NAMES。
//   末端名字＝存取鏈最後一節：`a.rates.USD`→`USD`、`s.usdTwd`→`usdTwd`、`fxTwd[cur]`（動態鍵）→`fxTwd`、
//   `fxTwd['GBP']`→`GBP`、`usdRate(s)`（呼叫）→`usdRate`；`Number()`／`parseFloat()`／`+x` 這些包裝先剝掉。
//   所以 `t.GBP.count || 0` 末端是 `count`＝不命中；`s.fxHigh || 32`（分批門檻）＝不命中；
//   `bal * f.rate || 0`＝命中（||／?? 的左邊連乘除一起看：乘積的 NaN 防呆會把缺匯率靜靜蓋成 0）；
//   `ok ? bal * f.rate : 0`＝不命中（三元式只看條件與「本身就是一個匯率」的另一支；乘積不算）；
//   `f.missing ? 0 : f.rate`／`!f.missing ? f.rate : 0`＝唯一豁免：條件**本身**是 `.missing` 旗標（複合條件如
//   `f.missing && rates.USD > 0 ? 0 : 31` 不算）、數字支是 0、另一支不是數字字面量（`f.missing ? 0 : 31` 命中）。
//   不豁免的三元式：條件子樹裡**任何地方**碰到解析器欄位 missing／source／cur／rate（`Boolean(f.missing) ? 0 : 31`、
//   `f.source === 'unsupported' ? 0 : 31`）就命中——它在替「有沒有匯率」做決定，數字支就是寫死的匯率。
// 射程之外（誠實劃界，考題 test/derive.test.js 有列；這些會算錯金額的由 test/fx-sentinel.test.js 兩組哨兵抓）：`Math.max(rate, 31)`、if 賦值、
//   先把數字存進變數再退路、三元式另一支是乘積——不長上面的形狀，抓不到。
// 壞語法＝丟例外（TS 解析器不會自己丟，半棵樹會靜靜漏抓；這裡 fail-closed）。
// ⚠️ 定位（William 2026-09-04 裁示）：這支是**第二道網**——主網是 test/fx-sentinel.test.js 的哨兵匯率行為題，
//    任何真的會算錯金額的寫死匯率都由它抓；這裡只補「有匯率卻不用、退路寫死」的死程式，形狀列舉補不完就劃界、不再加輪。
import ts from 'typescript';
import { SUPPORTED_FX } from '../../public/modules/fx-rates.js';

export const FX_NAMES = Object.freeze(new Set([
  ...SUPPORTED_FX, 'TWD',                                                // 幣別碼＝匯率表的鍵（rates.USD／fxTwd.GBP）
  'usdTwd', 'fxTwd',                                                     // settings 裡「上次抓到的匯率」
  'rate', 'rates', 'fx', 'fxRate', 'fxTable', 'usdRate', 'usd', 'twd',   // 解析器輸出與新舊參數名
]));

const FALLBACK_OPS = new Set([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
const FLATTEN_OPS = new Set([...FALLBACK_OPS, ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const COERCE = new Set(['Number', 'parseFloat', 'parseInt']);

/** @param {string} src @param {string} file */
function parse(src, file) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const bad = /** @type {any} */ (sf).parseDiagnostics || [];
  if (bad.length) throw new Error(`${file} 解析失敗：${ts.flattenDiagnosticMessageText(bad[0].messageText, '\n')}`);
  return sf;
}

/** @param {ts.Node} n */
function unwrap(n) {
  for (;;) {
    if (ts.isParenthesizedExpression(n)) n = n.expression;
    else if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.PlusToken) n = n.operand;
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && COERCE.has(n.expression.text) && n.arguments.length) n = n.arguments[0];
    else return n;
  }
}

/** @param {ts.Node} n */
function isNumber(n) {
  n = unwrap(n);
  return ts.isNumericLiteral(n) || (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand));
}

/** 存取鏈的末端名字；不是存取鏈（乘積、物件字面量…）回 null。 @param {ts.Node} n @returns {string|null} */
function terminal(n) {
  n = unwrap(n);
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isCallExpression(n)) return terminal(n.expression);   // usdRate(s) → usdRate
  if (ts.isElementAccessExpression(n)) {
    const k = unwrap(n.argumentExpression);
    if (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) return k.text;   // fxTwd['GBP'] → GBP
    return terminal(n.expression);   // fxTwd[cur]（動態鍵）→ 看被索引的是誰
  }
  return null;
}

const ARITH_OPS = new Set([ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken]);

/**
 * 攤開 ||／??／&&／比較鏈，取每個運算元的末端名字；arith=true 時連乘除也攤開
 * （`bal * f.rate || 0` 這種「乘積的 NaN 防呆」會把缺匯率靜靜蓋成 0，所以 ||／?? 的左邊要看進乘積裡）。
 * @param {ts.Node} n @param {boolean} [arith] @returns {string[]}
 */
function terminals(n, arith = false) {
  n = unwrap(n);
  if (ts.isBinaryExpression(n) && (FLATTEN_OPS.has(n.operatorToken.kind) || (arith && ARITH_OPS.has(n.operatorToken.kind)))) {
    return [...terminals(n.left, arith), ...terminals(n.right, arith)];
  }
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return terminals(n.operand, arith);
  const t = terminal(n);
  return t ? [t] : [];
}

const RESOLVER_FIELDS = new Set(['missing', 'source', 'cur', 'rate']);   // fxFor() 回傳物件的四個欄位

/** 子樹裡任何一個 `.missing`／`['source']`… 存取（不看位置，呼叫參數、比較兩側都算）。 @param {ts.Node} root @returns {string|undefined} */
function mentionsResolverField(root) {
  /** @type {string|undefined} */ let found;
  /** @param {ts.Node} n */
  const walk = (n) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && RESOLVER_FIELDS.has(n.name.text)) { found = n.name.text; return; }
    if (ts.isElementAccessExpression(n)) { const k = unwrap(n.argumentExpression); if ((ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) && RESOLVER_FIELDS.has(k.text)) { found = k.text; return; } }
    ts.forEachChild(n, walk);
  };
  walk(root); return found;
}

/**
 * @param {string} src 原始碼
 * @param {string} [file] 檔名（只用在訊息）
 * @returns {{ line: number, name: string, text: string }[]} 命中清單（空＝乾淨）
 */
export function findFxLiteralFallbacks(src, file = 'source.js') {
  const sf = parse(src, file);
  /** @type {{ line: number, name: string, text: string }[]} */
  const hits = [];
  /** @param {ts.Node} node @param {ts.Node[]} scope */
  const report = (node, scope, arith = false) => {
    const name = scope.flatMap((n) => terminals(n, arith)).find((t) => FX_NAMES.has(t));
    if (name) hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, name, text: node.getText(sf).replace(/\s+/g, ' ') });
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && FALLBACK_OPS.has(node.operatorToken.kind) && isNumber(node.right)) report(node, [node.left], true);
    else if (ts.isConditionalExpression(node) && (isNumber(node.whenTrue) || isNumber(node.whenFalse))) {
      const zeroWhenTrue = isNumber(node.whenTrue);
      const numeric = zeroWhenTrue ? node.whenTrue : node.whenFalse;
      const other = zeroWhenTrue ? node.whenFalse : node.whenTrue;
      // 唯一豁免：`f.missing ? 0 : X`／`!f.missing ? X : 0`——條件**本身**就是解析器旗標 missing（不是「條件裡出現 missing」：
      // #558 r4 實測 `f.missing && rates.USD > 0 ? 0 : 31` 靠複合條件把 31 藏掉）、數字是 0、X 不是數字字面量。
      // 這是丙契約的「缺匯率不計入」，不是另一個預設匯率；`f.missing ? 31 : f.rate`、`f.missing ? 0 : 31` 仍命中。
      const cond = unwrap(node.condition);
      const negated = ts.isPrefixUnaryExpression(cond) && cond.operator === ts.SyntaxKind.ExclamationToken;
      const flag = negated ? unwrap(cond.operand) : cond;
      const exempt = unwrap(numeric).getText(sf) === '0' && !isNumber(other) && ts.isPropertyAccessExpression(flag)
        && flag.name.text === 'missing' && (negated ? !zeroWhenTrue : zeroWhenTrue);
      if (!exempt) {
        const names = [node.condition, other].flatMap((n) => terminals(n));
        // 條件裡**任何地方**碰到解析器的欄位（missing／source／cur／rate；含 `Boolean(f.missing)`、`!!f.missing`、
        // `f.source === 'unsupported'` 這種包在呼叫或比較裡的）⇒ 這個三元式在替「有沒有匯率」做決定，數字支就是寫死的匯率
        // （#558 r5 實測 `Boolean(f.missing) ? 0 : 31` 靠呼叫包裝躲過只看末端名字的判斷）。
        const name = names.find((t) => FX_NAMES.has(t)) || mentionsResolverField(node.condition);
        if (name) hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, name, text: node.getText(sf).replace(/\s+/g, ' ') });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
