#!/usr/bin/env node
// @ts-check
/**
 * grok CLI 升版助手（William 2026-09-22 裁示：閘留著、把麻煩拿掉）。
 *
 * 為什麼需要它：`scripts/grok-scan.js` 釘住 grok 執行檔的版本與 sha256，而 grok 會自己升版
 * （裁示者同日裁「auto_update 維持開著」）。升版後掃描會 fail-closed 擋下來，要有人重走一次
 * 「重驗轉送器目的地 → 改兩個常數 → 改考題那兩行」。本檔把那段手工流程變成一個指令。
 *
 *     node scripts/grok-bump.js            # 只看報告，不動任何檔
 *     node scripts/grok-bump.js --write    # 重驗通過才就地改兩個檔（**不 commit、不 push**）
 *
 * 退出碼：0＝已經釘在目前這一版（不必動）或 --write 寫好了；1＝有新版、重驗通過、但沒帶 --write；
 *         2＝查不清楚或重驗不過（**不可升版**）。任何沒預期到的錯誤也一律收斂成 2（#636 r1 #6）。
 *
 * ⚠️ **退 0 的意思，在 #636 r4 縮小過**（F10 五題）：它是「**已經釘在這一版、一個字都沒動**」
 *    或「**那四處換好了**」，**都不是「已驗證」**。
 *    本檔**不保證整份考卷會過**——「常數被改了而沒人注意到」本來就有東西在管，就是
 *    `test/grok-scan-flow-preflight.test.js` 自己。我連四輪想在 bump 裡自己做一個弱化版的
 *    「這一句是不是活的」判斷，審查者連四輪用合法的 ESM 打穿（幌子參數、解構、`assert['equal']`、
 *    `'1.\x32.3'`、`'1.2.' + '3'`）。所以保證換成一句量得到的話：
 *    **本檔動的只有兩處：常數檔那兩個字串字面值，與考題檔那兩行固定模板。動錯了，那份考題會紅
 *    ——是大聲失敗，不是靜靜通過。**（⚠️ 常數檔走的是字面值替換，**不套** `assert.equal(...)` 那條模板；
 *    Grok 掃描 #636 抓到我原本把兩邊講成同一件事。）
 *    （考題 `test/grok-bump.test.js` 裡那幾題是**真的用 node 跑那個 fixture**：改之前過、改之後紅。）
 *
 * ⚠️ **本檔從不執行那支執行檔**。理由跟 grok-scan.js 釘 sha256 是同一個：版本字串是被檢者自己印的，
 *    而「還沒驗過的第三方執行檔」在沙箱外跑一次就已經輸了。所以：
 *    ・版本號取自 `~/.grok/version.json`（更新器寫的**純檔案**）——它只是**候選值**，本檔不信任它；
 *      真正的強制力仍在 runScan：把執行檔 clone 進盒子、對**盒內副本**算 sha256，再於**沙箱內**跑
 *      `--version` 精確比對常數。version.json 說謊 ⇒ 下一次掃描當場擋下，不是本檔的漏洞。
 *    ・必要字串用**讀檔找位元組**確認，不呼叫 `strings`。⚠️ 跟 `strings … | grep -cF` 的數字**不保證一樣**：
 *      那個數的是「含有該字串的**行**數」，這裡數的是實際出現次數；同一行出現兩次就會差。
 *      （1.0.13→1.0.40 這兩支、五個字串、兩種算法，2026-09-22 實測十組全部相同；那是這兩支的結果，不是通則。）
 *
 * ⚠️ **寫進原始碼的值只有三個，而且都先過同一道形狀關**（`SAFE_FOR_SOURCE`）。
 *    這是 #636 r1 #1 的修法：審查者拿一個**合法的檔名** `grok'); writeFileSync(…); ('tail` 就把
 *    「執行檔的名字」變成了下一次 `npm test` 會執行的程式——因為它被原樣塞進單引號字串裡。
 *    正解是**關門，不是列舉要跳脫哪些字元**（2026-09-01 裁示）：能寫進原始碼的字元集只有
 *    `A-Z a-z 0-9 . _ -`，裡面沒有引號、反斜線、換行、括號、分號，所以 `'` ＋ 值 ＋ `'`
 *    在**任何**通過這道關的值上都只會是一個字串字面值。不合形狀＝退 2、一個字都不寫。
 *
 * ⚠️ **定位用語法解析器，不用正規式**（#636 r1 #2；鐵則「結構考題用解析器不用正規式」）。
 *    正規式會認到**註解掉的那一行**：審查者把兩個真常數改成雙引號、把舊的單引號宣告留成 `//` 註解，
 *    整卷仍綠，而 `--write` 只改到註解、真常數停在舊值。改用 TypeScript 的解析器找**有效宣告**與
 *    **有效斷言**，拿到節點位置後直接換那一段；註解與字串裡的同名字樣根本不在語法樹上。
 *    （`typescript` 是本倉庫的開發相依，跑這支要先 `npm install`。）
 *
 * ⚠️ **已知沒有獨立覆蓋的防禦條件**（拿掉它們整卷仍綠——照實記，不硬造考題、也不因此刪掉它們）：
 *    ①替換區間的重疊檢查 ②寫完之後再讀一次核四個值 ③`assertLine()` 的引號／反斜線守衛
 *    ④`literal()` 的 `SAFE_FOR_SOURCE` 守衛 ⑤`shaMsg()` 的同一道守衛（④⑤上游已經有字元集關）
 *    ⑥fixture 第 2、3 個參數必須是字串字面值（與整行模板比對重疊）。
 *    ——這是 #636 r2〜r5 逐輪量到的清單，**不宣稱已經窮舉所有冗餘條件**。
 *
 * ⚠️ **射程**：本檔驗的是那些字串**還在不在**，不驗它們**還做不做原來那件事**——旗標名字留著、行為被改掉，
 *    本檔看不出來。另一塊明知沒驗的是 `grok-relay.js` 的 `ALLOWED_REQUESTS` 那張表：它要記錄型 proxy 實測
 *    才能重驗，本檔做不到也不假裝做得到（**做完必要字串檢查之後就會印這一行**——成功的 dry-run、
 *    成功的 `--write`、缺字串被擋下來，以及檢查之後才失敗的路徑都帶著它；在那之前就拒絕的路徑，
 *    例如定位不到、檔名形狀不合，不會印——那些跟這張表無關。⚠️ 我原本寫「三種」，
 *    跟下面那句「不是窮舉」自相矛盾，Grok 掃描 #636 抓到；以實作為準）。新版若打出表外，轉送器回 403；**除非**那個形狀在 `grok-relay.js` 的
 *    `TOLERATED_REFUSALS` 容許清單上（#635 加的，例如 `GET /`），否則掃描退 2（fail-closed）。
 *    這兩塊是**我知道沒驗的**，不是「除此之外都驗過了」。
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isMainModule } from '../lib/is-main.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

/** 升版必須「新版裡也還在」的字串。少任何一個＝不可升版（退 2）。 */
export const REQUIRED_TOKENS = Object.freeze([
  { token: 'GROK_CLI_CHAT_PROXY_BASE_URL', why: '轉送器靠這個環境變數把 grok 導到 127.0.0.1' },
  { token: 'cli-chat-proxy.grok.com', why: '轉送器唯一放行的目的地（grok-relay.js 的 UPSTREAM_HOST）' },
  { token: '--disable-web-search', why: 'GROK_FLAGS：關掉上網' },
  { token: '--no-subagents', why: 'GROK_FLAGS：關掉它自己再叫小弟' },
  { token: '--always-approve', why: 'GROK_FLAGS：盒內不要互動式確認' },
]);

/**
 * **能被寫進原始碼的字元集**。關門用的，不是清洗用的：不合形狀就退 2，不去想「那要跳脫哪些字」。
 * 這個集合裡沒有 `'`、`"`、`` ` ``、`\`、換行、`(`、`)`、`;`——所以把通過的值夾在單引號中間，
 * 在**任何**通過的值上都只會長成一個字串字面值，不可能提早收尾、不可能變成程式。
 */
export const SAFE_FOR_SOURCE = /^[A-Za-z0-9._-]{1,120}$/;

/** 要定位的四處。用語法解析器找，`kind` 說的是「它在語法樹上是什麼」。 */
const PINS = Object.freeze({
  version: { file: 'scripts/grok-scan.js', kind: 'const', name: 'EXPECTED_GROK_VERSION' },
  sha256: { file: 'scripts/grok-scan.js', kind: 'const', name: 'EXPECTED_GROK_SHA256' },
  testVersion: { file: 'test/grok-scan-flow-preflight.test.js', kind: 'assert', name: 'EXPECTED_GROK_VERSION' },
  testSha: { file: 'test/grok-scan-flow-preflight.test.js', kind: 'assert', name: 'EXPECTED_GROK_SHA256' },
});

/** @param {Buffer} buf @param {string} token 實際出現次數（不是含有它的行數） */
export function countBytes(buf, token) {
  const needle = Buffer.from(token, 'utf8');
  let n = 0, i = 0;
  for (;;) { const at = buf.indexOf(needle, i); if (at < 0) return n; n++; i = at + 1; }
}

/** 把通過形狀關的值包成單引號字面值。**只准餵過關的值**；沒過關的在上游就該退 2。 */
function literal(/** @type {string} */ v) {
  if (!SAFE_FOR_SOURCE.test(v)) throw new Error(`「${v}」不在可寫進原始碼的字元集內（只准 A-Za-z0-9._-）`);
  return `'${v}'`;
}

/** 日期也得過關。Grok 掃描（#636）抓到：`today` 是**第四個**被寫進原始碼的東西，而我宣稱「只有三個」。 */
export const SAFE_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/** 說明句（**純文字，引號一律由 assertLine 加**）：可變的那兩段都由形狀關把守，其餘是本檔寫死的中文。 */
function versionMsg(/** @type {string} */ v, /** @type {string} */ today) {
  if (!SAFE_DATE.test(today)) throw new Error(`日期「${today}」不是 YYYY-MM-DD 的形狀——不寫進原始碼`);
  return `grok CLI ${v}（${today} 重驗轉送器目的地後升的）`;
}
function shaMsg(/** @type {string} */ name) {
  if (!SAFE_FOR_SOURCE.test(name)) throw new Error(`執行檔名「${name}」不在可寫進原始碼的字元集內`);
  return `${name} 的 sha256`;
}

/** @param {ts.SourceFile} sf @param {(n: ts.Node) => boolean} pick */
function collect(sf, pick) {
  /** @type {ts.Node[]} */ const hits = [];
  const walk = (/** @type {ts.Node} */ n) => { if (pick(n)) hits.push(n); ts.forEachChild(n, walk); };
  walk(sf);
  return hits;
}

/**
 * 在有效程式碼上**定位**那四處，回傳值與可以直接換掉的位置。註解與字串裡的同名字樣不在語法樹上。
 *
 * ⚠️ **做法在 #636 r3 換過**（F10 五題：我連三輪都在補「哪些形狀不算數」——註解、`export let`、
 *    死分支、幌子 `dummy.equal`、函式參數、解構——那是在重做 JavaScript 的作用域解析，補不完）。
 *    現在分成兩件互不依賴的事：
 *    ・**常數檔**靠**語言自己的封閉保證**：ESM 裡一個名字只可能由這幾種方式成為具名匯出——
 *      帶 `export` 的頂層宣告、`export { … as 名字 }` 的 specifier、`export * from`（被本地宣告蓋過）、
 *      `export * as 名字 from`（與本地同名宣告並存＝重複匯出，Node 直接拒絕載入）。
 *      所以「剛好一個頂層 `export const 名字 = '字串'`」＋「沒有任何 specifier 匯出這個名字」
 *      ⇒ 找到的那一個**就是**生效的那一個。這不是我的列舉，是語言的清單
 *      （審查者 r4 實測找不到第四條「保持合法 ESM、卻讓它指向別的值」的路）。
 *    ・**考題 fixture 不是模組契約**，靠的是**固定模板契約**：整份檔案裡**剛好一個**
 *      `assert.equal(<名字>, …, …)` 呼叫，而且**它所在的那一整行**逐字等於
 *      `assert.equal(<名字>, '<值>', '<說明>');`；不合＝寫入前退 2。
 *      ⚠️ 它**不要求整個檔案只有一行**——真的那個考題檔有幾十行（Grok 掃描 #636 抓到我原本寫錯）。
 *      ⚠️ 這**不宣稱**「挑到的是活的那一句」——見上面退 0 的說明。
 * @param {string} repo
 * @returns {Record<string, { file: string, value: string, valueAt: [number, number], lineAt: [number, number] | null, indent: string }>}
 */
export function readPins(repo) {
  /** @type {Record<string, { file: string, value: string, valueAt: [number, number], lineAt: [number, number] | null, indent: string }>} */
  const out = {};
  for (const [k, { file, kind, name }] of Object.entries(PINS)) {
    const text = readTextLossless(join(repo, file), file);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    /** @type {ts.StringLiteral} */ let value;
    /** @type {[number, number] | null} */ let lineRange = null;
    /** @type {string} */ let indent = '';
    if (kind === 'const') {
      // 只認**頂層的 `export const <名字> = '<字串>'`**。這是現行檔案真正的寫法；
      // 其餘形狀（let、巢狀、死分支裡的同名 const、沒 export 的）一律當成「我不懂」而退 2。
      const hits = /** @type {ts.VariableDeclaration[]} */ (collect(sf, (n) => {
        if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== name) return false;
        const list = n.parent, stmt = list?.parent;
        return !!list && ts.isVariableDeclarationList(list)
          && (list.flags & ts.NodeFlags.Const) !== 0
          && !!stmt && ts.isVariableStatement(stmt)
          && stmt.parent === sf                                           // 頂層，不是某個區塊／死分支裡
          && (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0;
      }));
      if (hits.length !== 1) throw new Error(`${file} 裡頂層的 \`export const ${name} = '…'\` 有 ${hits.length} 個（要剛好 1 個；0＝原始碼改了形狀或不是這種寫法，>1＝不敢猜要改哪一個）`);
      const init = hits[0].initializer;
      if (!init || !ts.isStringLiteral(init)) throw new Error(`${file} 的 \`${name}\` 不是直接指定一個字串字面值——本檔不改這種形狀`);
      // ESM 讓一個名字成為具名匯出的方式就那幾種（帶 export 的宣告／specifier／`export * from`／
      // `export * as 名字 from`——後兩種被本地宣告蓋過，或造成重複匯出而讓 Node 直接拒絕載入；
      // 完整說明在檔頭）。上面已經釘住第一種剛好一個，這裡排掉第二種，
      // 兩條合起來就是**語言層級的**「找到的就是生效的那一個」——不是我在列舉哪些寫法不算數。
      // ⚠️ 兩種都要數：`export { … as 名字 }` 是 ExportSpecifier，`export * as 名字 from` 是 **NamespaceExport**。
      //    Grok 掃描（#636）抓到我只數了前者，而檔頭卻把後者也算進「偵測得到」。
      const 別的匯出 = collect(sf, (n) =>
        (ts.isExportSpecifier(n) && n.name.text === name) || (ts.isNamespaceExport(n) && n.name.text === name));
      if (別的匯出.length) throw new Error(`${file} 裡還有 ${別的匯出.length} 個別的地方在匯出 \`${name}\`（\`export { … as }\` 或 \`export * as\`）——哪一個生效由不得我猜，不動它`);
      value = init;
    } else {
      // 找出形狀像那一行的呼叫；**接收者是不是 `assert` 由下面的整行模板比對決定**——
      // 不在這裡另立一個條件（#636 r4 突變實測：多留那個條件，拿掉它整卷仍綠＝沒有證據撐著）。
      const hits = /** @type {ts.CallExpression[]} */ (collect(sf, (n) =>
        ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && ts.isIdentifier(n.expression.name) && n.expression.name.text === 'equal'
        && n.arguments.length === 3 && ts.isIdentifier(n.arguments[0]) && n.arguments[0].text === name));
      if (hits.length !== 1) throw new Error(`${file} 裡 \`assert.equal(${name}, …)\` 有 ${hits.length} 個（要剛好 1 個）`);
      const [, v, m] = hits[0].arguments;   // m 只用來比對模板，不另外存
      if (!ts.isStringLiteral(v) || !ts.isStringLiteral(m)) throw new Error(`${file} 的 \`${name}\` 斷言第 2、3 個參數不都是字串字面值——本檔不改這種形狀`);
      // **固定模板契約**（#636 r4 F10）：整行要**逐字等於**這個形狀，才動它。
      // 不是為了證明「這一行是活的」——那件事由 `npm test` 判；是為了讓「我只會動哪一行」講得死。
      const 行首 = text.lastIndexOf('\n', hits[0].getStart(sf)) + 1;
      const 行尾 = text.indexOf('\n', hits[0].getEnd());
      const 整行 = text.slice(行首, 行尾 < 0 ? text.length : 行尾);
      lineRange = [行首, 行尾 < 0 ? text.length : 行尾];
      indent = 整行.match(/^[ \t]*/)?.[0] ?? '';
      const 模板 = assertLine(indent, name, v.text, m.text);
      if (整行 !== 模板) throw new Error(`${file} 的 \`${name}\` 那一行不是本檔認得的固定模板（看到「${整行.trim().slice(0, 60)}…」）——不改這種形狀`);
      value = v;
    }
    out[k] = {
      file,
      value: value.text,
      valueAt: [value.getStart(sf), value.getEnd()],
      // fixture 那兩行是**整行重畫**（讀與寫共用 assertLine），所以這裡要的是整行的範圍與縮排
      lineAt: lineRange, indent,
    };
  }
  return out;
}

/**
 * **排他建立一個自己的暫存檔**，回傳路徑與已開好的 fd。
 *
 * ⚠️ 為什麼不能用固定檔名（#636 r6 #1）：`writeFileSync(固定路徑, …)` 會**跟隨符號連結**、
 *    也會**截短既有檔**。審查者實測：事先在 `scripts/grok-scan.js.grok-bump-tmp` 放一條指向
 *    `unrelated.js` 的連結，升版就把那個不相干的檔整份蓋掉，而前後 `npm test` 都是綠的；
 *    把連結指回目標自己，還會做出自我循環、讀目標得到 `ELOOP`。
 *
 *    作法照標準的那一套（不自己想）：**同目錄、隨機檔名、`wx` 旗標**。
 *    `O_CREAT|O_EXCL` 在最後一段是連結時直接失敗，所以「先被放好的連結」對它無效；
 *    撞到既有檔就換一個名字，**絕不覆寫任何既有路徑**。清理時也只清**自己建的那一個**。
 *
 * ⚠️ **這一格的邊界，逐條寫明**（#636 r7 #2，都是實測過的）：
 *    ・`wx` 拒絕的是**新暫存路徑最後一段**已經有東西；它**仍會沿父目錄的符號連結解析**
 *      （`scripts/` 本身是連結時，就照那條連結讀寫）。
 *    ・**目標檔本身是符號連結**時：讀會跟隨，`rename` 則是換掉**連結那個目錄項**，原本指到的檔不變。
 *    ・**不保留 mode**：目標原本 0600，換完之後是當下 umask 的結果（實測 0644）。
 *    ・**不保證 TOCTOU**：別的行程同時在搶同一個目錄，`wx` 讓「先放好的」無效，擋不住「正在換」。
 *    ——所以這一格能講的是「**內容**只有那四處會變」，**不是**「磁碟上所有狀態都沒變」。
 *
 * @param {string} target 要被蓋掉的那個檔（暫存檔放在它隔壁，確保同一個檔案系統，rename 才是原子的）
 * @param {() => string} [nameFor] 只給考題用的接縫：讓它可以指定要試哪些名字
 */
export function createExclusiveTemp(target, nameFor) {
  // 結尾刻意留 `.grok-bump-tmp`，這樣 .gitignore 那一行照樣蓋得到
  const 取名 = nameFor ?? (() => `${target}.${randomBytes(6).toString('hex')}.grok-bump-tmp`);
  /** @type {string[]} */ const 試過 = [];
  for (let i = 0; i < 8; i++) {
    const path = 取名();
    試過.push(path);
    try { return { path, fd: openSync(path, 'wx') }; }        // wx＝既有路徑（含連結）一律失敗
    catch (e) { if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e; }
  }
  throw new Error(`連續 ${試過.length} 次都撞到既有路徑，不敢再試（最後一個：${basename(試過[試過.length - 1])}）`);
}

/**
 * 讀檔，並且**要求這個檔用 UTF-8 解出來再編回去，位元組一個不差**。
 *
 * ⚠️ 為什麼非有不可（#636 r5 #1）：`readFileSync(…, 'utf8')` 碰到**不合法的 UTF-8 位元組**
 *    不會報錯，它會換成替代字元 U+FFFD。本檔是「整檔讀成字串 → 換掉一段 → 整檔寫回」，
 *    所以那些位元組會被**靜靜改掉**——而且改的是**模板以外**的地方，固定模板契約攔不住它。
 *    審查者實測：fixture 檔頭放一行含 `FF` 的註解，升版之後那個 `FF` 變成 `EF BF BD`，
 *    而且前後 `npm test` 都是綠的。
 *
 *    修法是**關門**：往返對不起來就退 2、兩個檔一個字都不寫。
 *    （不是「去修那些位元組」——原始碼檔本來就該是合法的 UTF-8；不是的話，該停下來看，不是照樣改。）
 * @param {string} full @param {string} shown
 */
function readTextLossless(full, shown) {
  const raw = readFileSync(full);
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) {
    throw new Error(`${shown} 不是合法的 UTF-8（用 UTF-8 讀出來再編回去，位元組對不起來）——`
      + `本檔是整檔讀進來再整檔寫回去，硬改會把模板以外的位元組一起換掉；不動它`);
  }
  return text;
}

/**
 * 考題 fixture 那兩行的**唯一形狀**。讀的時候拿它比對，寫的時候拿它渲染——同一個函式，兩邊不可能漂開。
 * ⚠️ 值與說明都**不准含引號或反斜線**。這一條是**防禦性的、沒有獨立覆蓋**（第三個這樣的，照實記）：
 *    寫的時候值已經過了 `SAFE_FOR_SOURCE`、說明是本檔自己組的；讀的時候就算餵進帶跳脫的字串，
 *    下面那道「整行逐字等於模板」也會先擋掉。拿掉它整卷仍綠。留著是因為它是**唯一**組出原始碼的地方。
 */
export function assertLine(/** @type {string} */ indent, /** @type {string} */ name, /** @type {string} */ value, /** @type {string} */ msg) {
  for (const x of [value, msg]) if (/['\\]/.test(x)) throw new Error(`「${x}」含有引號或反斜線，不可以放進模板`);
  return `${indent}assert.equal(${name}, '${value}', '${msg}');`;
}

/** 整份檔案的 **JS 語法診斷**（不是只有 parseDiagnostics——那一半漏掉 JS 專屬的那些，#636 r3 #2）。 */
export function jsSyntaxErrors(/** @type {string} */ file, /** @type {string} */ text) {
  const host = {
    getSourceFile: (/** @type {string} */ n) => n === file
      ? ts.createSourceFile(n, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) : undefined,
    getDefaultLibFileName: () => 'lib.d.ts', writeFile: () => { }, getCurrentDirectory: () => '',
    getCanonicalFileName: (/** @type {string} */ n) => n, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n', fileExists: (/** @type {string} */ n) => n === file, readFile: () => text,
  };
  const program = ts.createProgram([file], { allowJs: true, checkJs: false, noResolve: true, noLib: true }, host);
  return program.getSyntacticDiagnostics(program.getSourceFile(file)).map((d) =>
    `${d.code}：${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
}

/**
 * 主流程。@param {{ grokHome?: string, repo?: string, write?: boolean, today?: string, tempNameFor?: () => string }} args
 * @returns {Promise<{ code: 0|1|2, lines: string[] }>}
 */
export async function bump(args = {}) {
  /** @type {string[]} */ const lines = [];
  try {
    return await run(args, lines);
  } catch (e) {
    // 任何沒預期到的錯誤（讀不了、權限、磁碟滿）都要收斂成 2＋報告，不可以變成未捕捉例外退 1
    // ——那個退出碼在本檔的契約裡是「重驗通過、等你決定」（#636 r1 #6）。
    lines.push(`✖ 沒預期到的錯誤，一律當成「查不清楚」：${/** @type {Error} */ (e)?.message ?? e}`);
    return { code: 2, lines };
  }
}

/**
 * @param {{ grokHome?: string, repo?: string, write?: boolean, today?: string, tempNameFor?: () => string }} args
 * @param {string[]} lines
 * @returns {Promise<{ code: 0|1|2, lines: string[] }>}
 */
async function run(args, lines) {
  const grokHome = args.grokHome ?? join(homedir(), '.grok');
  const repo = args.repo ?? REPO;
  const say = (/** @type {string} */ m) => { lines.push(m); };
  const fail = (/** @type {string} */ m) => { say(`✖ ${m}`); return /** @type {{code:2,lines:string[]}} */ ({ code: 2, lines }); };
  /**
   * 沒被涵蓋的那一塊。**印它的時機＝做完必要字串檢查之後**：成功的 dry-run、成功的 --write、
   * 缺字串被擋下來，以及檢查之後才失敗的路徑（寫入失敗、寫完驗不過）。
   * 在那之前就拒絕的路徑不印——根本沒做這件檢查，硬印是假訊號。
   * ⚠️ 「三種」不是窮舉（#636 r3 #4）：檢查之後的失敗路徑也會印。
   */
  const sayUncovered = () => say('  ⚠️ 沒驗到的：grok-relay.js 的 ALLOWED_REQUESTS 那張表（要記錄型 proxy 實測）。'
    + '新版若打出表外＝轉送器 403；除非那個形狀在 TOLERATED_REFUSALS 容許清單上（例如 GET /），否則掃描退 2。');

  /** @type {ReturnType<typeof readPins>} */ let pins;
  try { pins = readPins(repo); } catch (e) { return fail(/** @type {Error} */ (e).message); }
  const pinnedVersion = pins.version.value, pinnedSha = pins.sha256.value;
  if (pins.testVersion.value !== pinnedVersion || pins.testSha.value !== pinnedSha) {
    return fail(`常數與考題 fixture 現在就對不上（常數 ${pinnedVersion}／考題 ${pins.testVersion.value}）——先把它們弄一致再升版`);
  }
  say(`目前釘著：${pinnedVersion}｜${pinnedSha.slice(0, 12)}…`);

  // 候選版本：純讀檔，不執行任何東西。
  // ⚠️ 這裡刻意**沒有** `existsSync` 前哨（#636 r3 #3）：前哨只是把同一個錯誤分成兩個返回點，
  //    而其中一個做不出輸入＝沒有人測得到。少一個分支，剩下的每一個都有考題。
  const vPath = join(grokHome, 'version.json');
  /** @type {string} */ let candidateVersion;
  try {
    const v = JSON.parse(readFileSync(vPath, 'utf8'));
    if (typeof v?.version !== 'string' || !/^[0-9]+(\.[0-9]+){1,3}$/.test(v.version)) throw new Error(`version 欄位不是版本號的形狀`);
    candidateVersion = v.version;
  } catch (e) { return fail(`${vPath} 讀不出版本號：${/** @type {Error} */ (e).message}——不知道新版號；不猜`); }

  // 候選執行檔：realpath（bin/grok 是捷徑）→ 算 sha256。**不執行**。
  // 目錄／不存在／權限都由 readFileSync 的 catch 一起接（EISDIR／ENOENT／EACCES 訊息本來就講得清楚）。
  const binLink = join(grokHome, 'bin', 'grok');
  /** @type {string} */ let binReal;
  try { binReal = realpathSync(binLink); } catch (e) { return fail(`${binLink} 解析不了：${/** @type {Error} */ (e).message}`); }
  /** @type {Buffer} */ let buf;
  try { buf = readFileSync(binReal); } catch (e) { return fail(`${binReal} 讀不了：${/** @type {Error} */ (e).message}`); }
  const candidateSha = createHash('sha256').update(buf).digest('hex');
  const binName = basename(binReal);
  say(`磁碟上的：${candidateVersion}｜${candidateSha.slice(0, 12)}…｜${binName}`);

  if (candidateSha === pinnedSha) {
    say(candidateVersion === pinnedVersion
      ? '✔ 已經釘在這一版，不必動。'
      : `⚠️ sha256 跟釘的一樣、但 version.json 寫 ${candidateVersion}≠${pinnedVersion}——同一支執行檔被標成不同版本，先查清楚再說（本檔不改）。`);
    // 進得來就代表 sha 相同；差別只剩版本號對不對得上
    return candidateVersion === pinnedVersion ? { code: 0, lines } : { code: 2, lines };
  }

  // 要寫進原始碼的三個值，先一起過形狀關（關門；#636 r1 #1）
  for (const [what, v] of [['版本號', candidateVersion], ['sha256', candidateSha], ['執行檔名', binName]]) {
    if (!SAFE_FOR_SOURCE.test(v)) {
      return fail(`${what}「${v}」含有不准寫進原始碼的字元（只准 A-Za-z0-9._-）——**不可升版**，請手動處理。` +
        `（這道關擋的是「第三方給的字串變成我們自己的程式」，不是格式潔癖。）`);
    }
  }

  // 必要字串：新版裡在不在（判定依據）
  say('');
  say('重驗（讀檔找位元組，沒有執行它）：');
  /** @type {Buffer|null} */ let oldBuf = null;
  const dl = join(grokHome, 'downloads');
  if (existsSync(dl)) {
    for (const n of readdirSync(dl)) {   // 用**雜湊**認舊版，不靠檔名
      const p = join(dl, n);
      try { const b = readFileSync(p); if (createHash('sha256').update(b).digest('hex') === pinnedSha) { oldBuf = b; say(`  （舊版執行檔＝${n}，用雜湊認出來的，可以做新舊對照）`); break; } } catch { /* 讀不了就當沒有 */ }
    }
  }
  if (!oldBuf) say('  ⚠️ 磁碟上找不到釘著那一版的執行檔（已被清掉）——**只能驗「新版裡在不在」，沒有新舊對照**。');
  let missing = 0;
  for (const { token, why } of REQUIRED_TOKENS) {
    const nNew = countBytes(buf, token);
    const nOld = oldBuf ? countBytes(oldBuf, token) : null;
    const mark = nNew > 0 ? (nOld === null ? '✔' : nNew === nOld ? '✔' : '⚠️') : '✖';
    if (!nNew) missing++;
    say(`  ${mark} ${token}${nOld === null ? `：新版 ${nNew} 次` : `：舊 ${nOld} → 新 ${nNew}`}｜${why}`);
  }
  if (missing) { sayUncovered(); return fail(`有 ${missing} 個必要字串在新版裡不見了——**不可升版**；先弄清楚轉送器還轉不轉得到，再手動處理。`); }
  sayUncovered();

  const today = args.today ?? new Date().toISOString().slice(0, 10);
  if (!args.write) {
    say('');
    say(`→ 可以升到 ${candidateVersion}。要寫進去就加 --write（它只改檔，不 commit、不 push）。`);
    return { code: 1, lines };
  }

  // 寫：先把**同一個檔的所有替換一次收齊**，再從後往前套用，最後才落地。
  // ⚠️ 位置都是對**原文**量的：一個檔有四處要換時，若邊改邊量，第二處以後的位置就已經被前一處挪掉了。
  /** @type {Record<string, [number, number, string][]>} */ const editsByFile = {};
  for (const [k, { file, valueAt, lineAt, indent }] of Object.entries(pins)) {
    const newValue = k === 'version' || k === 'testVersion' ? candidateVersion : candidateSha;
    if (lineAt) {   // fixture：**整行照模板重畫**，讀與寫共用 assertLine
      const name = k === 'testVersion' ? 'EXPECTED_GROK_VERSION' : 'EXPECTED_GROK_SHA256';
      const msg = k === 'testVersion' ? versionMsg(candidateVersion, today) : shaMsg(binName);
      (editsByFile[file] ??= []).push([lineAt[0], lineAt[1], assertLine(indent, name, newValue, msg)]);
    } else {
      (editsByFile[file] ??= []).push([valueAt[0], valueAt[1], literal(newValue)]);
    }
  }
  /** @type {Record<string, string>} */ const files = {};
  for (const [file, edits] of Object.entries(editsByFile)) {
    const sorted = [...edits].sort((a, b) => b[0] - a[0]);   // 從後面往前換
    // ⚠️ **這道重疊檢查沒有考題**（審查者 r2 #7 實測：刪掉它整卷仍綠），而且我認為在**能通過 readPins 的形狀下
    //    它不可達**：四個落點各自來自「剛好一個」的宣告或斷言，兩個不同節點的字元範圍不可能相交。
    //    留著是因為它擋的是「readPins 哪天放寬了」，那時它會是唯一擋在寫入前面的東西。
    //    ——照實記成「防禦性、目前不可達、沒有覆蓋」，不為了填表硬造一個考題。
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i][1] > sorted[i - 1][0]) return fail(`${file} 裡要換的兩段重疊了（${sorted[i]}／${sorted[i - 1]}）——不敢寫`);
    }
    files[file] = sorted.reduce((s, [a, b, rep]) => s.slice(0, a) + rep + s.slice(b), readTextLossless(join(repo, file), file));
  }
  // ⚠️ **單一檔案不可以被寫到一半**（審查者 r2 #2：`writeFileSync` 中途失敗會留下被截短的檔，
  //    而我原本的報告還說「沒有任何檔被改到」）。作法：先在**同一個目錄**寫暫存檔，再 rename 蓋過去。
  //    同一個檔案系統上的 rename 是原子的，所以每個檔只有「整份換成新的」與「一個字都沒動」兩種結果。
  //    ⚠️ 但**兩個檔之間沒有交易**：第一個換好、第二個失敗是可能的，報告必須講明白。
  /** @type {string[]} */ const written = [];
  for (const [file, text] of Object.entries(files)) {
    const target = join(repo, file);
    /** @type {{ path: string, fd: number } | null} */ let tmp = null;
    try {
      tmp = createExclusiveTemp(target, args.tempNameFor);
      // ⚠️ **要用「寫到完為止」的那個介面**（#636 r7 #1）：`writeSync()` 回傳的是**實際寫了幾個位元組**，
      //    底層在寫了一部分之後遇到狀況會回一個正數而**不拋錯**——我原本沒看回傳值就 rename，
      //    於是一個**被截掉尾巴、但語法還合法**的檔會被當成正式來源檔（審查者實測：常數檔 203 要寫、
      //    只寫了 150，尾端不相干的 export 就沒了，而四個值都在前段，寫後檢查全過）。
      //    `writeFileSync(fd, …)` 內部會迴圈寫到完，短寫入會被它自己補完。
      writeFileSync(tmp.fd, Buffer.from(text, 'utf8'));
      closeSync(tmp.fd); tmp = { path: tmp.path, fd: -1 };
      renameSync(tmp.path, target);
      tmp = null;                                   // rename 成功＝那個暫存檔已經不在了
      written.push(file);
    } catch (e) {
      /** @type {string} */ let 殘留 = '';
      if (tmp) {
        try { if (tmp.fd >= 0) closeSync(tmp.fd); } catch { /* 已關 */ }
        // 只清**自己建的那一個**；別的路徑一律不碰
        try { rmSync(tmp.path, { force: true }); } catch { 殘留 = `｜⚠️ **暫存檔清不掉，留在 ${basename(tmp.path)}，請自己刪**`; }
      }
      return fail(`寫 ${file} 失敗：${/** @type {Error} */ (e).message}｜${file} 本身**沒有被動到**（排他建立的暫存檔＋rename）${殘留}｜` +
        (written.length ? `⚠️ **但前面這些已經換好了：${written.join('、')}——請自己看 git diff 決定要不要 checkout 回去**`
          : 殘留 ? '前面沒有別的檔被換掉（但上面那個暫存檔還在）' : '也沒有別的檔被改到'));
    }
  }
  // ── 寫完之後：**直接量結果**，不再論證「我改的是不是生效的那一個」（#636 r3 F10）──
  const 改壞了 = (/** @type {string} */ m) => fail(`${m}｜⚠️ **${written.join('、')} 已經被改過**，請自己看 git diff`);
  // ① 寫完的兩個檔還要通過 **JS 語法診斷**。
  //    ⚠️ **射程**（r4 #3）：這是**語法**診斷，**不含 ESM 的 early error**——例如重複宣告
  //    （`const DUP = 1; const DUP = 2;`）Node 會拒絕載入，這裡回空陣列。
  //    本檔換掉的是**一整行固定模板**，值又過了字元集關，所以「我換的那一行本身合法」是成立的；
  //    **「整份檔案合法」不是本檔的保證**——輸入本來就不合法的話，輸出也不會變合法。
  for (const file of Object.keys(files)) {
    const errs = jsSyntaxErrors(file, readTextLossless(join(repo, file), file));
    if (errs.length) return 改壞了(`寫完之後 ${file} 不是合法的 JS 了：${errs.slice(0, 2).join('；')}`);
  }
  // ③ 定位器再讀一次，四個值都要是新的（擋「寫了卻沒改到」）。
  //    ⚠️ **防禦性、沒有獨立覆蓋**（跟上面那個重疊檢查一樣照實記）：要讓它單獨開火，
  //    得造出「寫成功了但內容不是我組的」，而那要在 fs 上開一個接縫。刪掉它整卷仍綠——
  //    它擋的東西目前由「來回題」與「真檔格式題」從另一側蓋住。留著是因為它便宜，且日後 splice 改了它會先叫。
  try {
    const after = readPins(repo);
    for (const [k, want] of /** @type {[string, string][]} */ ([['version', candidateVersion], ['sha256', candidateSha],
      ['testVersion', candidateVersion], ['testSha', candidateSha]])) {
      if (after[k].value !== want) return 改壞了(`寫完再讀回來，${k} 是「${after[k].value}」不是「${want}」`);
    }
  } catch (e) { return 改壞了(`寫完再讀回來就定位不到了：${/** @type {Error} */ (e).message}`); }
  say('');
  say(`✔ 已改：${Object.keys(files).join('、')}（${pinnedVersion} → ${candidateVersion}）。**還沒 commit**。`);
  // ⚠️ 退 0 的意思講清楚（#636 r4 F10）：本檔只保證「把符合模板的那一行換成新值」，
  //    **不保證整份考卷會過**——那件事本來就有東西在管，就是那份考題自己。
  say('  ⚠️ 退 0 的意思是「那四處換好了」，**不是「已驗證」——本檔沒有驗證整份考卷**。');
  say('  接下來一定要跑：npm run lint／typecheck／test。改錯了那份 preflight 考題會紅（它存在的理由就是這個）。');
  return { code: 0, lines };
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const r = await bump({ write: argv.includes('--write') });
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
