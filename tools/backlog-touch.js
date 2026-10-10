#!/usr/bin/env node
// 開工印待辦（規矩 F6 的「放在哪裡」）：列出待辦清單裡「放在哪裡」提到這一支改到的檔的那幾條；只列不擋。
//
// 為什麼：待辦多半寫「下一支本來就要動那個檔時順手改」，但「這一支動到那個檔」沒有東西告訴實作者——
// 稽核 2026-10-06 量到 MACHINES.md 被改了八次，等著它的四條待辦一條都沒動。擁有者 2026-09-25 裁這一半＝開工時由工具印出來、
// 條件到了的由實作者問裁示者要不要併進手上這支或另開；2026-10-07 裁第 2 批的三台提前做，這是第三台。
// 不併進待裁清單工具：那一支是 D1 的清單腳本，一支工具講兩條規矩，機器表那一列就要講兩件事。
//
// 「這一支改到的檔」＝跟基準版本（預設 origin 上的主幹）的三點差異，加上還沒提交的改動與沒追蹤的檔（開工時多半還沒提交）。
// 待辦檔只從磁碟上現在那一份讀，設定的檔名不拿去問版本控制：曾做過「這支自己剛加的待辦不列」（要拿檔名去找分岔點那一版來比），
// #50 四輪複審各抓到一種檔名在磁碟與版本控制裡身分對不上的情形（讀失敗、./、冒號開頭、大小寫別名、捷徑檔），每一種都把該列的
// 舊待辦藏起來還退 0；擁有者 2026-10-07 裁 a 拿掉。代價：送審前跑會多印實作者自己剛寫的那幾條（量到 0〜2 條），開工時沒有。
// 「提到」＝那一條的整段文字裡出現那個檔的路徑或它的上層資料夾（寫成「tools/」這種，結尾帶斜線），前後不能再接路徑字元：
// settings.json 不會命中 unfilled-settings.json。
//
// ⚠️ 守不到的：只寫檔名不寫路徑的、寫「那些檔」「說明書的換頁程式」這類說法的，都配不到；換了路徑寫法（例如 ./tools/x.js）、
//   路徑緊接半形標點（半形括號、逗號）的也配不到；這支自己剛寫進待辦的那幾條也會列（見上）；
//   列出來之後有沒有人看、條件是不是真的到了，全靠人判斷——這支不判斷值不值得做，也不寫任何東西。
// 退出碼：0＝列完了（有沒有命中都是 0）／2＝列不了（設定沒填、待辦檔或那一節找不到、基準找不到、git 出錯、參數不對）。⚠️ 不是閘。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { read: readSettings } = require('./settings-data.js');
const { gitEnv } = require('./git-env.js');

const UNSET = '未設定';
const USAGE = '用法：node tools/backlog-touch.js [--base <基準版本>]';
/**
 * 路徑字元＝半形可見字元扣掉反引號與兩種引號（E6 准檔名用任何半形符號，所以 @、[、+ 這些也可能是路徑的一部分；#50 r2 R3）。
 * 扣掉的那三個是待辦裡常拿來框路徑的。代價：路徑緊接半形標點（例如半形括號、逗號）的寫法配不到。
 */
const PATH_CHAR = '[!#-&(-_a-~]';

class TouchError extends Error {}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new TouchError(`git 起不來：${r.error.message}`);
  if (r.status !== 0) throw new TouchError(`git ${args.join(' ')} 退 ${r.status === null ? '（被殺掉）' : r.status}：${(r.stderr || '').trim() || '（沒有訊息）'}`);
  return r.stdout;
}

/**
 * 待辦那一節的每一條：從那一節的標題行到下一個同級或更高的標題為止（標題前 0〜3 個空白也算標題），每個第一層的「- 」開一條，
 * 縮排的續行算在同一條裡。回 [{ line（第幾行，從 1 起）, text }]。找不到那一節＝null。
 */
function itemsOf(markdown, heading) {
  const all = String(markdown).replace(/\r\n?/gu, '\n').split('\n');
  const start = all.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  const level = (/^#+/u.exec(heading) || [''])[0].length;
  const items = [];
  for (let i = start + 1; i < all.length; i += 1) {
    const l = all[i];
    const h = /^ {0,3}(#+)\s/u.exec(l);   // 標題前 0〜3 個空白仍是標題（Markdown 的規則；#50 r5 R1：寫成「 ## 做完的」時原本被當成續行、下一節全算進來）
    if (h && h[1].length <= level) break;
    if (/^- /u.test(l)) items.push({ line: i + 1, text: l.slice(2) });
    else if (items.length && /^\s+\S/u.test(l)) items[items.length - 1].text += `\n${l.trim()}`;
  }
  return items;
}

/** 這個路徑本身與它的每一層上層資料夾（帶結尾斜線），都是可以被「提到」的寫法。 */
function namesOf(p) {
  const parts = p.split('/');
  const out = [p];
  for (let i = 1; i < parts.length; i += 1) out.push(`${parts.slice(0, i).join('/')}/`);
  return out;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/**
 * 文字裡有沒有整個提到這個名字：前後都不能再接路徑字元。資料夾名字自己帶斜線結尾，所以「tools/」後面接 a.js、
 * 接 .cache/ 都是更深的路徑、不算提到整個 tools/（#50 r1 R4：點也是路徑字元）。
 */
function mentions(text, name) {
  return new RegExp(`(?<!${PATH_CHAR})${esc(name)}(?!${PATH_CHAR})`, 'u').test(text);
}

/** 純判斷層：每一條待辦對上了哪幾個改到的檔。 */
function match(items, changed) {
  const out = [];
  for (const it of items) {
    const hit = changed.filter((p) => namesOf(p).some((n) => mentions(it.text, n)));
    if (hit.length) out.push({ ...it, hit });
  }
  return out;
}

function run({ settings = readSettings(), cwd = process.cwd(), argv = [] } = {}) {
  let base;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { base = argv[i + 1]; i += 1; }
    else return { code: 2, lines: [`不認得的參數：${argv.slice(i).join(' ')}`, USAGE] };
  }
  try {
    const b = settings.backlog || {};
    if (!b.file || b.file === UNSET || !b.section || b.section === UNSET) throw new TouchError('專案設定的 backlog（待辦檔在哪、哪一節）還沒填');
    // 待辦檔名正規化成從根目錄算起的寫法（./BACKLOG.md＝BACKLOG.md），要在倉庫裡面；這個名字只用在磁碟上，不經過版本控制的路徑解讀
    const file = path.posix.normalize(String(b.file));
    if (path.posix.isAbsolute(file) || file === '..' || file.startsWith('../')) throw new TouchError(`專案設定的 backlog.file「${b.file}」要寫成從倉庫根目錄算起、在倉庫裡面的路徑`);
    const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    if (base === undefined) {
      if (!settings.mainBranch || settings.mainBranch === UNSET) throw new TouchError('專案設定的主幹分支名沒填，也沒給 --base');
      base = `origin/${settings.mainBranch}`;
    }
    const ok = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: root, env: gitEnv(), encoding: 'utf8' });
    if (ok.error || ok.status !== 0) throw new TouchError(`基準版本 ${base} 找不到（先 git fetch，或用 --base 指定）`);
    // 檔名一律用 -z（NUL 分隔、不加引號）：可讀輸出會把含引號或反斜線的檔名包引號再跳脫，拿去比就配不到（#50 r1 R3）
    const nul = (out) => out.split('\0').filter(Boolean);
    // 還沒提交的分兩段看：已暫存（索引對 HEAD）與沒暫存（工作檔對索引）。只看工作檔對 HEAD 的淨差異，
    // 改了又暫存、再把工作檔改回去的那一種會互相抵消、看不見（#50 r2 R1）
    const changed = [...new Set([
      ...nul(git(root, ['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`])),
      ...nul(git(root, ['diff', '--name-only', '-z', '--no-renames', '--cached'])),
      ...nul(git(root, ['diff', '--name-only', '-z', '--no-renames'])),
      ...nul(git(root, ['ls-files', '-z', '--others', '--exclude-standard'])),
    ])].sort();
    let text;
    try { text = fs.readFileSync(path.join(root, file), 'utf8'); } catch (e) { throw new TouchError(`讀不到待辦檔 ${file}（${e.code || e.message}）`); }
    const items = itemsOf(text, b.section);
    if (items === null) throw new TouchError(`${file} 裡找不到「${b.section}」那一節`);
    const hits = match(items, changed);
    const out = [`開工印待辦｜這支（${base}...HEAD，加上還沒提交與沒追蹤的）改到 ${changed.length} 個檔；${file}「${b.section}」那一節 ${items.length} 條，提到這些檔的 ${hits.length} 條（只列不擋）`];
    for (const h of hits) {
      const first = h.text.split('\n')[0];
      out.push(`  ・第 ${h.line} 行（${h.hit.join('、')}）：${first.length > 90 ? `${first.slice(0, 90)}…` : first}`);
    }
    if (hits.length) out.push('看各條的「什麼情況下值得做」：條件到了的，問裁示者要不要併進手上這支或另開（擁有者 2026-09-25 裁）；沒到的不用寫理由。');
    return { code: 0, lines: out, hits, changed };
  } catch (e) {
    if (e instanceof TouchError) return { code: 2, lines: [`開工印待辦：${e.message}——列不了。`] };
    throw e;
  }
}

if (require.main === module) {
  let result;
  try { result = run({ argv: process.argv.slice(2) }); } catch (e) { result = { code: 2, lines: [`開工印待辦：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——列不了。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { run, itemsOf, match, mentions, namesOf };
