// @ts-check
// 複審結論聯集閘：本專案的登記與文件守表題（2026-09-18 搬家第 7 步起只剩這四題）。
//
// 起因是一場**真實事故**：#383 上出現兩份都自稱「Claude 複審」、結論相反的留言（GitHub 上兩則都是 `teacherjung`）。
// 危險的不是有兩份，是**看起來一樣有效而結論相反**，於是「最後一則說通過」等於放行。
// 判斷本身（標頭怎麼讀、各自解除、作廢上一則、放行只認指定那一位）從切換日（2026-09-17）起住套件
// `tools/gates/check-review-verdicts.js`，行為題在套件 `tests/check-review-verdicts.test.js`；舊閘 `scripts/check-review-verdicts.js`
// 與它的 121 題行為題（重述／豁免／缺 sha／雜湊四族救濟、真實語料 25 份）2026-09-18 搬家第 7 步退役。
// 本檔只守本專案這一側：閘登記為已啟用且指回 RULES F4／F5、範本與 RULES 的逐字句、來源字串表（settings.json 的 sources
// ＝ PROJECT-SETTINGS.md 那張表）、範本裡的救法。
// ⚠️ 誠實劃界：文件題只證明「規則寫在該寫的地方、沒有被靜靜刪掉」，證明不了任何人真的照著打字（那要靠審查）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');


test('合併程序真的把聯集閘登記成一道（settings.json 的 gates；順序由執行器保證）', () => {
  const settings = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8'));
  const gates = Array.isArray(settings.gates) ? settings.gates : [];
  const gate = gates.find((g) => Array.isArray(g.args) && g.args.includes('tools/gates/check-review-verdicts.js'));
  assert.ok(gate, 'settings.json 的 gates 沒有登記 tools/gates/check-review-verdicts.js——執行器不會跑聯集閘，規則會退回「靠記性」');
  assert.equal(gate.command, 'node', '聯集閘登記的指令不是 node——執行器起不了它');
  // 執行器只跑 state === '已啟用' 的閘（tools/merge.js）：登記了但停用＝一樣不會跑（Codex #611 r1 中①，停用實測 136 題仍綠）
  assert.equal(gate.state, '已啟用', '聯集閘登記成「' + gate.state + '」——執行器只跑已啟用的閘，正式審查會被靜靜漏跑');
  assert.ok(existsSync(join(ROOT, 'tools/gates/check-review-verdicts.js')), '登記的閘檔不存在＝登記了也跑不到');
  // 登記的規矩條號要指回結論標頭那兩條（RULES F4、F5）——閘與規矩對不上，讀登記表的人會找錯條
  assert.match(String(gate.rules || ''), /F4/, '聯集閘的登記沒有指回 RULES F4（標頭形狀）');
  assert.match(String(gate.rules || ''), /F5/, '聯集閘的登記沒有指回 RULES F5（各自解除、放行只認指定那一位）');
  // 合併指令本身要登記著（沒有 mergeCommand 的話執行器停在閘後、不會合併——那時「閘在合併前」是空話）
  assert.ok(settings.mergeCommand && settings.mergeCommand.command, 'settings.json 沒有登記 mergeCommand');
});

test('套件範本與規矩本文要寫下「各自解除」與自報來歷的格式（切換日起改綁 templates/verdict-header.md 與 RULES F4／F5）', () => {
  // ⚠️ **剝掉 HTML 註解再比對**（Codex #385 r1 Medium⑤）：
  //    不剝的話，把整段規則包進 `<!-- -->` 就能讓「文件寫了」變成假的——
  //    而這支 PR 自己新增的固定維度第 2 條講的就是這件事，我在自己的考題裡違反了它。
  // 切換前這一題讀 AGENTS.md 的「取聯集，不取最後一則」原句與 `🤖 <角色>｜來源：` 格式行；那一節已隨
  // 切換日拿掉，正本改成套件範本（標頭行逐字）＋RULES F4／F5（規矩），AGENTS 附則只指路。
  const strip = (/** @type {string} */ s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const tmpl = strip(readFileSync(join(ROOT, 'templates/verdict-header.md'), 'utf8'));
  assert.ok(tmpl.includes('🤖 <角色識別值>｜來源：<來源字串>｜審 `<短版本碼>`｜r<輪次>｜結論：<通過｜需修改後再審｜不可合併>'),
    'templates/verdict-header.md 沒有寫出來歷標頭的逐字格式行（含 🤖、全形｜、反引號版本碼、三選一），寫的人只能猜');
  assert.ok(tmpl.includes('各自解除'), 'templates/verdict-header.md 找不到「各自解除」——聯集規則只寫在腳本裡＝讀範本的人不會知道');
  const rules = strip(readFileSync(join(ROOT, 'RULES.md'), 'utf8'));
  assert.match(rules, /^- F4 .*機器標頭/mu, 'RULES F4 沒有寫「結論留言第一行是機器標頭」');
  assert.match(rules, /^- F5 .*各自解除/mu, 'RULES F5 沒有寫「每位審查者的阻擋各自解除」——那正是「取聯集、不取最後一則」的規矩版');
  const agents = strip(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'));
  assert.ok(agents.includes('templates/verdict-header.md'),
    'AGENTS.md 沒有指向 templates/verdict-header.md——只讀 AGENTS 的人找不到標頭格式');
});

test('範本與規矩｜「放行只認指定的那一位」在兩處要一致、不可自相矛盾（切換日起改綁 templates/verdict-header.md 與 RULES F5）', () => {
  // 切換前這一題讀規則書裡講委任關係的那段（同一條規則的兩半曾經一句「放行只認指定那一位」、
  // 一句「也不構成放行」互相打架）；那一節 2026-09-17 已隨切換日拿掉。現在同一條規則住兩處：範本第 9 行與 RULES F5，
  // 兩處都要有「放行只認…指定的那一位」，而且不可以再冒出反句。
  const strip = (/** @type {string} */ s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const tmpl = strip(readFileSync(join(ROOT, 'templates/verdict-header.md'), 'utf8'));
  const rules = strip(readFileSync(join(ROOT, 'RULES.md'), 'utf8'));
  for (const [name, text] of [['templates/verdict-header.md', tmpl], ['RULES.md', rules]]) {
    assert.ok(/放行只認變更說明指定的那一位/.test(text), `${name} 沒寫清楚「放行只認變更說明指定的那一位」`);
    assert.ok(!/也\*\*不構成放行\*\*/.test(text),
      `${name} 出現「也不構成放行」——與「放行只認指定那一位」矛盾，讀者無法判斷哪句才是規則`);
  }
});

test('標準來源字串表（settings.json 的 sources 五筆）與標頭範本的「作廢上一則」救法要站著（切換日起改綁套件登記與範本）', () => {
  // ⚠️ 誠實劃界：文件題只證明「規則寫在該寫的地方、沒有被靜靜刪掉」，
  //    證明不了任何人真的照著打字（那要靠審查與上面那道相似提醒）。
  //    但機制只活在腳本裡＝打字漂掉的人**不知道該用哪個字串、也不知道怎麼救**，
  //    #453 兩次被擋就是這樣來的。
  // 切換前這一題讀舊程序文件的「發審查提示」節（標頭格式行、角色名單指路、來源字串表、「補發、不可編輯舊留言」
  // 的補救程序）與 AGENTS 的「來源是機械身分」指路句；那份文件與那一節 2026-09-17 隨切換日拿掉。
  // 現在的家：機器讀的來源清單＝根目錄 settings.json 的 sources；人讀的同一張表＝PROJECT-SETTINGS.md
  // 「來源字串標準表」；標頭格式、來源欄的寫作義務、各自解除、壞標頭的救法＝templates/verdict-header.md。
  const settings = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8'));
  const sources = Array.isArray(settings.sources) ? settings.sources : [];
  // ⚠️ **斷言整筆（工具＋字串），不是只斷言那個字串**：切換前第一版只寫 `doc.includes('`codex CLI`')`，
  //    把整列刪掉照樣全綠——同一串字在別處也出現過，includes 被別處滿足了（本專案認過的病型：
  //    同一句活兩處、改壞一處看不見；突變 M6 當場抓到）。這裡比對的是 settings.json 裡的整筆。
  const want = [
    ['本機 codex CLI 起的審查 session', 'codex CLI'],
    ['Claude Code CLI 起的審查 session', 'Claude CLI'],
    ['Codex 桌面 session', 'Codex 桌面'],
    ['Claude 桌面 session', 'Claude 桌面'],
    ['William 本人（畫面驗收／產品裁決）', 'William 本人'],
  ];
  assert.deepEqual(sources.map((s) => [s.tool, s.string]), want,
    'settings.json 的 sources 與標準來源字串表對不上（少一筆、多一筆、或字串被改）\n（沒有建議值，每個人就會自己編一個；改了要連 PROJECT-SETTINGS.md 那張表一起改）');
  // 人讀的那張表要跟機器清單逐筆同字（同一張表活兩處＝會漂；這裡把兩處釘在一起）
  const ps = readFileSync(join(ROOT, 'PROJECT-SETTINGS.md'), 'utf8');
  for (const [tool, string] of want) {
    assert.ok(ps.includes(`| ${tool} | ${string} |`),
      `PROJECT-SETTINGS.md 的來源字串標準表少了這一列（或與 settings.json 不同字）：| ${tool} | ${string} |`);
  }
  const tmpl = readFileSync(join(ROOT, 'templates/verdict-header.md'), 'utf8');
  // 可整行照抄的標頭格式行（發射者憑印象拼標頭＝角色欄就是這樣寫歪的：#479 r10/r11 把角色寫成「獨立審查者」）
  assert.ok(tmpl.includes('🤖 <角色識別值>｜來源：<來源字串>｜審 `<短版本碼>`｜r<輪次>｜結論：<通過｜需修改後再審｜不可合併>'),
    '範本少了可照抄的標頭格式行（含 🤖、全形｜、反引號版本碼、**逐字**三個合規結論字串——沒列出來的那次，五支 PR 全被壞標頭鎖死）');
  // 來源欄的寫作義務：從標準表挑、跨輪次一字不改、不含會變的東西；它是機械身分的一半
  assert.ok(tmpl.includes('來源字串是機械身分'), '範本少了「來源字串是機械身分」那句——打字漂掉的人不會知道自己變成了另一位審查者');
  assert.ok(tmpl.includes('PROJECT-SETTINGS.md'), '範本沒有指到 PROJECT-SETTINGS.md 的標準表——來源字串沒有建議值，每個人就會自己編一個');
  assert.ok(tmpl.includes('跨輪次一字不改'), '範本少了「同一個工具跨輪次不可改寫法」那條');
  // 壞標頭的救法：套件把舊閘的三級救濟收成「作廢上一則」一行（範本第 8 行）——普通補發救不了壞標頭，這句要在
  assert.ok(tmpl.includes('作廢上一則：<那則留言的編號>'), '範本少了「作廢上一則」那行的逐字格式——標頭寫壞的人不知道怎麼自救');
  assert.ok(tmpl.includes('壞留言原地保留'), '範本少了「壞留言原地保留」——會有人照舊例去刪留言、洗掉稽核軌跡');
  // 各自解除：同一身分、更高輪次、對目前受審版本——這正是「照原輪次補發撤銷不掉」與「每個身分各自算」的規矩版
  assert.ok(tmpl.includes('各自解除：同一身分、更高輪次'),
    '範本少了「各自解除：同一身分、更高輪次」——照原輪次補發撤銷不掉，而規則是每個身分各自算');
});
