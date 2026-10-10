#!/usr/bin/env node
// 進度摘要檢查（規矩 J5）：讀倉庫外那份共用進度摘要，列出不合檔頭寫法、時間寫反、沒動的線、超過大小上限、附件條號指不到、
// 「已合併」跟平台對不上的地方；只列不擋（有問題也退 0），接進鉤子時帶 --strict 才擋。
//
// 為什麼：進度摘要是擁有者最常看的檔，卻沒有任何機器看它（套件缺點稽核 2026-10-06 第一主題）。
// 2026-10-07 改成八欄之後三小時，另一個工作階段照它記憶裡的舊檔頭把自己那一則蓋回五欄——
// 格式只住在檔頭、靠每個 AI 記得讀，就會這樣。這一支讀的形狀＝摘要檔頭「怎麼寫」那一段（2026-10-07 版）；
// 檔頭改了這裡要跟著改，每一條判準各有考題釘著。
//
// 查什麼：
//   ①「進行中的線」每一則：標題四段（專案三選一、狀態六選一、誰・資料夾有「・」）、八欄齊全且依序、每欄非空、
//     每一行都是清單（舊的五欄寫法沒有清單記號，抓得到）；第一則之前的內容、縮排或井號數不對的標題，列出來、不靜靜丟掉；
//     檔頭沒規定的節（例如把工作線的標題寫成兩個井號、自己長出一節）列出來；同名的節出現兩次＝查不了，後一節不可以蓋掉前一節；
//   ②時間欄：整理與核實都要有「月/日 時:分」，核實不可以晚於整理；
//   ③證據欄引的「附件第 N 條」在附件裡找得到（已結束那一節引的也查）；「45〜47」「1 〜 3」這種範圍會展開；
//     附件可以另放一份檔（--attachments <附件檔>，擁有者 2026-10-07 裁「三件」的第三件：附件搬出摘要本檔、本文只留指標）：
//     條號從那份檔讀（有「## 附件」那一節就讀那一節，沒有就整份讀；那一節出現兩次＝查不了），本檔的附件那一節這時可以只留指標、也可以沒有；同一個條號兩邊都有＝列出來；
//     「附件第 … 條」裡拆不開、倒過來、不是 1〜MAX_REF 的整數、一個範圍超過 MAX_RANGE 條的，列成問題、不會卡住；
//   ④到哪一步寫了「已合併」：引到的附件裡要找得到 PR（github.com 的完整網址——主機與路徑都要對，別站網址裡夾著 github.com 不算；
//     或 --repos 登記過的「套件 #N」這種寫法，別名要整個對上、不可以被較短的別名搶走）；切段只看空白、不看任何標點（擁有者 2026-10-08 裁
//     「只認用空白隔開的寫法」）：一段裡第一個「://」（任何 scheme、大小寫不分）不是 http(s) 的 GitHub PR 網址，那一段後面的全部不算；
//     「套件 #N」從別名到編號所在的那一段含「://」＝黏著網址，不算（r7 R1：編號那一端黏著網址、外層網址寫大寫 HTTPS 都曾漏掉）；
//     而且問得到平台時至少一支真的合併了；
//     狀態是施工中或等複審、到哪一步沒寫已合併、引到的 PR 卻全部合併了＝可能過期；平台的答案只認布林 true／false，別的形狀＝核不了；
//   ⑤已結束那一節：只認「### 專案｜事情｜已結束 月/日｜已留：附件第 N 條」「…｜無永久決定」一種形狀，其餘非空行一律列出
//     （不枚舉壞法：r1〜r3 連三輪補了縮排、四個井號、兩個井號、缺空白、七個井號，追不完，改成只認一種、其餘全列）；
//     「已留」要有解析得出的附件條號、滿 30 天該刪；本週成果那一節：只認「- 月/日」與它底下縮排的子項目，其餘列出；
//     子項目上面要有合法的日期行（沒有＝孤立、整組多縮排兩格＝日期行也縮了，都列出來，不讓成果躲過七天；r4 R2）；日期超過七天該刪。
//   ⑥沒動的線（擁有者 2026-10-10 裁 a，進度摘要設計報告第一批）：暫停中的則，整理時間（文字最後改的那一刻）超過 STALE_PAUSED_DAYS 天＝列（第 15 天起），不是刪、給擁有者決定關掉還是叫回；
//     施工中、等複審、等驗收、等裁示四種狀態的則（STALE_STATES），核實時間超過 STALE_VERIFIED_DAYS 天＝列（第 8 天起；Codex 唸出來才不會是上週的狀態）；暫停中的不重複列核實，
//     寫在進行中的「已結束」與不在選單的狀態不算（前者該搬去已結束那一節、後者已另列）；只比月日、未來的日期不算；月日從 STAMP 重讀、讀不出（例如一位數的月）＝已列成缺欄、不算天數；
//     --strict 時這兩種跟其餘問題一樣算；「再改時間」＝核實與整理兩個時間都改成現在（只改核實會撞到「核實晚於整理」那一條）；
//   ⑧大小與孤兒附件（擁有者 2026-10-10 授權 Fable 代裁 Q8；只列不擋、都用位元組算、換行先統一成 LF）：本文（整份減掉「本週成果」與「附件」兩節——本週成果是機器照那一週合了幾支印的、
//     寫的人控制不了）超過 BODY_MAX_BYTES＝列；附件（另放一份檔就量整份檔，放本檔就量那一節）超過 ATTACH_MAX_BYTES＝列；一條附件（從原文量，條號那一行起到下一條前、空行不算）
//     超過 ATTACH_ITEM_MAX_BYTES＝列（從原文量：空行以外每一行原樣都算，含分隔線與條號的前導零；只放去哪查，逐輪經過留在 PR 說明；#72 r1 R2）；本文與附件那一節只算真的存在的換行（#72 r1 R1）；沒有任何一則引用的附件條＝列（附件那一節以外的引用都算，只被別的附件條引用不算；
//     附件條跟它的線一起到期：已結束那一行滿 30 天刪時它引的附件條一起刪，刪前先確認裡面沒有還沒貼出去的原話或還沒歸位的決定）。
//   ⑦最近誰提交（擁有者 2026-10-10 裁「那三件小事就做」的第三件）：摘要在 git 倉庫裡（那一層是個小倉庫）就印最近 RECENT_HOURS 小時改過本檔的提交（--recent <小時> 改窗口，只收非負整數）；
//     只算改到本檔的；只印、不是問題、不動退出碼——「現在誰在動」那一欄靠人改、會落後（10/10 量到一則寫沒人、那個視窗其實在跟擁有者對話），提交紀錄才是誰真的動過；不在倉庫裡或 git 不能用＝印查不到；
//     log 帶 --no-show-signature 與 --encoding=UTF-8（使用者的 git 顯示設定不污染清單；r2 R1）、時間印提交時間（跟 --since 同一種；r2 R2）、
//     檔名用 --literal-pathspecs 逐字比對（檔名裡的 [ ] * ? 與冒號開頭不當樣式；r3 R2）。
// 換行先統一：CRLF、CR 的摘要判得跟 LF 一樣。
// 平台只問一件事：那支 PR 合併了沒（gh api；證據網址是 github.com，查詢也固定問 github.com，環境裡選主機、選倉庫的變數先清掉）；
// 答案可以用 --pr-states <json 檔> 代替（考題與離線用）；--offline＝不問平台，④只查引不引得到 PR。
// ⚠️ 守不到的：內容真不真（「他要的」是不是他要的、核實時間有沒有真的核）；「已驗收」對不對（平台上沒有固定形狀可查）；
//   跨年的先後（只比月日，未來的日期當成還沒到）；附件以外的網址；github.com 以外的平台；沒帶 https:// 的網址；有沒有人跑它；
//   平台回的答案是不是真的；網址寫在別的連結的「標題」裡（[x](https://外站 "https://github.com/…")）會被認——只用空白切段的代價。
// 退出碼：0＝查完了（有沒有問題都是 0；--strict 時有問題＝1）／2＝查不了（檔或附件檔讀不到、少了要查的節、同名的節重複、參數不對）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gitEnv } = require('./git-env.js');
const { parseInstant } = require('./time-point.js');

const PROJECTS = ['套件', '理財', '共用'];
const STATES = ['施工中', '等複審', '等驗收', '等裁示', '暫停中', '已結束'];
const FIELDS = ['他要的', '做了什麼', '到哪一步', '現在誰在動', '下一步是', '動哪些檔', '證據', '時間'];
const SECTIONS = { active: '## 進行中的線', week: '## 本週成果', done: '## 已結束', attachments: '## 附件' };
// 檔頭規定的節：不在這裡的 ## 標題一律列出來（把工作線標題寫成兩個井號，就會變成一節、從所有檢查裡消失）
const KNOWN_SECTIONS = ['## 全貌', SECTIONS.active, '## 等裁示', SECTIONS.week, SECTIONS.done, '## 待辦', SECTIONS.attachments];
const DONE_DAYS = 30;
const WEEK_DAYS = 7;
// 沒動的線（擁有者 2026-10-10 裁 a）：暫停中的則整理超過 14 天、其他狀態的則核實超過 7 天就列出來（不是刪；第 15／第 8 天起列）
const STALE_PAUSED_DAYS = 14;
const STALE_VERIFIED_DAYS = 7;
// 核實那一條只管還在動的四種狀態；暫停中另算整理、已結束不該在進行中、不在選單的已另列（自審 C3／C10）
const STALE_STATES = ['施工中', '等複審', '等驗收', '等裁示'];
// 最近誰提交的預設窗口（小時）；--recent 改
const RECENT_HOURS = 1;
// 大小上限（擁有者 2026-10-10 授權 Fable 代裁 Q8，位元組、1 KB＝1,000）：本文不含本週成果與附件那一節、附件（整份附件檔或本檔那一節）、一條附件
const BODY_MAX_BYTES = 30000;
const ATTACH_MAX_BYTES = 60000;
const ATTACH_ITEM_MAX_BYTES = 1500;
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');
// 附件條號的上限：真的摘要到 2026-10-07 是 69 條；超過這個數字的幾乎一定是寫壞的（例如把留言編號寫成條號）
const MAX_REF = 100000;
// 一個範圍最多展開幾條（閉區間，1〜200 是 200 條）：防「1〜100000」這種把整份附件引進來的寫法
const MAX_RANGE = 200;
const STAMP = /(\d{2})\/(\d{2}) (\d{2}):(\d{2})/u;
// 網址跟「套件 #N」怎麼分，只看空白、不看任何標點（擁有者 2026-10-08 裁「只認用空白隔開的寫法」；r3 R3 → r4 R1 → r5 R1 → r6 R1 連四輪
// 都是在猜網址跟標點怎麼分——挖到空白太寬、挖到定界字元太短、用中文標點切段又被網址裡的全形括號繞過——猜不完，所以不猜）：
//   一段（空白之間）裡的網址依序看：第一個「://」往前的字母、數字、+ - . 就是它的 scheme，不是 http／https（大小寫不分）＝不支援的網址，
//   或者是 http(s) 但不是 github.com 的 PR 網址，那一段後面的全部不算（外站網址裡夾的字、夾的 GitHub 網址都不當證據；r7 R1 入口 B：外層寫 HTTPS:// 曾被跳過）；
//   「套件 #N」從別名到編號所在的那一段含「://」＝黏著網址，不認（r7 R1 入口 A：只查別名那一端、編號後面黏著網址曾漏掉）——要認就用空白隔開；
//   拿不準一律往「核不了」倒，不往「當證據」倒。
// 守不到：網址寫在別的連結的「標題」裡（[x](https://外站 "https://github.com/…")）會被認，因為引號前有空白。
const SCHEME = '://';
const SCHEME_CHAR = /[A-Za-z0-9+.-]/u;
const HTTP_SCHEME = /^https?$/iu;
// 一個網址的候選：從 scheme 起、到空白、中文標點、Markdown 的定界字元（反引號、引號、方括號、圓括號）前；主機與路徑再用 URL 解析核對
const URL_CANDIDATE = /^https?:\/\/[^\s<>「」（）()。，、；：！？`'"[\]]+/iu;
const TOKEN_BREAK = /\s/u;
const PR_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:\/|$)/u;
const GITHUB_HOSTS = ['github.com', 'www.github.com'];
const BARE_PR = /(\S+?)\s*#(\d+)/gu;
// 「附件第 … 條」先整段抓起來，裡面每一段再驗合不合法（r2 R2：只抓數字的話，「2.5」這種寫壞的根本進不了清單）；
// 不設長度上限（r3 R2：60 字的上限讓 25 條的合法清單整段消失），到同一行最近的「條」為止
const ATTACHMENT_REF = /附件第\s*([^條\n]+?)\s*條/gu;
const OLD_FIELD = /^(到哪一步|下一步是|狀態說明|動哪些檔|證據)：/u;
const LOOKS_LIKE_HEADING = /^\s*#{1,6}\s/u;
// 已結束那一節每一筆的形狀：只認這一種；不合的非空行一律列出，不再枚舉「哪些壞法算壞」（F10 第三輪：縮排→四個井號→兩個井號→缺空白／七個井號，枚舉追不完）
const DONE_RECORD = /^### (套件|理財|共用)｜(.+?)｜已結束 (\d{2})\/(\d{2})｜(已留：附件第[^｜]+條.*|無永久決定.*)$/u;
// 本週成果那一節只認兩種行：「- 月/日」與它底下縮排的「- …」子項目；子項目要屬於上面某個合法的日期行（r4 R2，擁有者 2026-10-08 裁「守結構」）
const WEEK_DAY = /^- (\d{2})\/(\d{2})\s*$/u;
const WEEK_ITEM = /^\s+- \S/u;
// 縮排的日期行：長得像日期卻縮在別的日期底下，它底下的成果會被算成上一個日期的（整組多縮排兩格就是這樣）；日期只能寫在最外層
const WEEK_ITEM_LOOKS_LIKE_DAY = /^\s+- \d{2}\/\d{2}\s*$/u;
const HOST = 'github.com';

/** 月/日 時:分 → 可以直接比大小的字串；讀不出＝null。 */
function stamp(text) {
  const m = STAMP.exec(text || '');
  return m ? `${m[1]}/${m[2]} ${m[3]}:${m[4]}` : null;
}

/**
 * 證據欄的附件條號：「45〜47」「12、13」「1 〜 3」都展開成 numbers；條號要是 1〜MAX_REF 的整數、一個範圍最多 MAX_RANGE 條（閉區間）。
 * 拆不開、倒過來、超出範圍的段落放進 bad（照原字），不悄悄丟掉：r1 R3 超出安全整數的範圍讓迴圈停不下來、R4 帶空白的範圍被拆成兩個端點、
 * r2 R2「2.5」這種字進不了清單。
 */
function parseRefs(text) {
  const numbers = [];
  const bad = [];
  for (const m of String(text).matchAll(ATTACHMENT_REF)) {
    const normalized = m[1]
      .replace(/[０-９]/gu, (d) => String(d.charCodeAt(0) - 0xff10))
      .replace(/\s*[〜~\-－]\s*/gu, '〜');
    const parts = normalized.split(/[、，,\s]+/u).filter(Boolean);
    if (parts.length === 0) { bad.push(m[1].trim() || '（空的）'); continue; }
    for (const part of parts) {
      const range = /^(\d+)〜(\d+)$/u.exec(part);
      if (!range && !/^\d+$/u.test(part)) { bad.push(part); continue; }
      const nums = range ? [Number(range[1]), Number(range[2])] : [Number(part)];
      // 上限本身就擋掉超出安全整數的值（MAX_REF 遠小於 2^53），不另外驗 isSafeInteger
      if (nums.some((n) => n < 1 || n > MAX_REF)) { bad.push(part); continue; }
      if (!range) { numbers.push(nums[0]); continue; }
      const [a, b] = nums;
      if (b < a || b - a + 1 > MAX_RANGE) { bad.push(part); continue; }
      for (let i = a; i <= b; i += 1) numbers.push(i);
    }
  }
  return { numbers, bad };
}

const expandRefs = (text) => parseRefs(text).numbers;

/** 從 [start, end) 往左、往右各走到空白為止，回那一段文字（別名所在的「一段」）。 */
function tokenAround(s, start, end) {
  let i = start;
  let j = end;
  while (i > 0 && !TOKEN_BREAK.test(s.charAt(i - 1))) i -= 1;
  while (j < s.length && !TOKEN_BREAK.test(s.charAt(j))) j += 1;
  return s.slice(i, j);
}

/**
 * 從一段文字裡找 PR：github.com 的完整網址（主機要是 github.com、路徑要是 /owner/repo/pull/N；別站網址裡夾著 github.com 不算，r2 R4），
 * 加上 --repos 登記過的「套件 #45」這種寫法：別名要整個對上，或前面接的是標點、不是字母數字；幾個別名都對上時取最長的那一個，
 * 跟登記順序無關（r2 R3：「新套件 #41」不可以被「套件」搶走）。切段只看空白：一段裡第一個不是 GitHub PR 的網址之後整段不算、
 * 別名所在那一段含「://」的不認（擁有者 2026-10-08 裁）。回「owner/repo#n」的集合。
 */
function prRefs(text, repos = {}) {
  const out = new Set();
  const s = String(text);
  for (const tok of s.split(/\s+/u)) {
    let from = 0;
    while (from < tok.length) {
      const sep = tok.indexOf(SCHEME, from);
      if (sep < 0) break;
      let start = sep;
      while (start > from && SCHEME_CHAR.test(tok.charAt(start - 1))) start -= 1;
      // 第一個「://」的 scheme 不是 http／https（大小寫不分）＝不支援的網址，這一段後面的全部不算（r7 R1 入口 B）
      if (!HTTP_SCHEME.test(tok.slice(start, sep))) break;
      const cand = URL_CANDIDATE.exec(tok.slice(start));
      if (!cand) break;
      let url;
      try { url = new URL(cand[0]); } catch { break; }
      // 第一個不是 github.com PR 的網址出現後，這一段後面的全部不算：它可能是外站網址的一部分（r6 R1：查詢字串裡夾 GitHub 網址）
      if (!GITHUB_HOSTS.includes(url.hostname.toLowerCase())) break;
      const p = PR_PATH.exec(url.pathname);
      if (!p) break;
      out.add(`${p[1]}/${p[2]}#${p[3]}`);
      from = start + cand[0].length;
    }
  }
  const names = Object.keys(repos);
  if (names.length) {
    for (const m of s.matchAll(BARE_PR)) {
      const word = m[1];
      const hits = names.filter((n) => word === n || (word.endsWith(n) && !/[\p{L}\p{N}]/u.test(word.charAt(word.length - n.length - 1))));
      if (!hits.length) continue;
      const name = hits.sort((x, y) => y.length - x.length)[0];
      // 從別名到編號所在的那一段（空白之間）含「://」＝它在網址裡、或黏著網址沒隔開，不認（r5〜r7 R1；只看空白；兩端都查）
      const aliasStart = m.index + word.length - name.length;
      if (tokenAround(s, aliasStart, m.index + m[0].length).includes(SCHEME)) continue;
      out.add(`${repos[name]}#${m[2]}`);
    }
  }
  return out;
}

/** 換行先統一成 LF：CRLF 的摘要照 \n 切會留下 \r，欄位與附件的正則全部對不上（r1 R2）。 */
const normalize = (text) => String(text).replace(/\r\n?/gu, '\n');

/** 把檔案切成節：每個 ## 標題起、到下一個 ## 標題前，照出現順序排成陣列（同名的節不合併、不覆蓋）。節與節之間的分隔線（---）不算內容。 */
function splitSections(text) {
  const sections = [];
  for (const line of normalize(text).split('\n')) {
    if (line.startsWith('## ')) { sections.push({ heading: line, lines: [] }); continue; }
    if (/^-{3,}\s*$/u.test(line)) continue;
    if (sections.length) sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

/** 標題以 heading 開頭的那幾節（可能不只一節：那是查不了的理由，由呼叫端判）。 */
function findSections(sections, heading) {
  return sections.filter((s) => s.heading.startsWith(heading));
}

/** 附件：編號 → 那一條的全文（含接在後面、沒有編號的續行）。 */
function parseAttachments(lines) {
  const out = new Map();
  let current = null;
  for (const line of lines) {
    const m = /^(\d+)\. (.*)$/u.exec(line);
    if (m) { current = Number(m[1]); out.set(current, m[2]); continue; }
    if (current !== null && line.trim()) out.set(current, `${out.get(current)}\n${line}`);
  }
  return out;
}

/** 進行中的線：每一則＝標題行＋到下一則之前的行；第一則之前的非空行是 stray，要列出來（r1 R1：縮排的標題以前被靜靜丟掉）。 */
function parseEntries(lines) {
  const entries = [];
  const stray = [];
  for (const line of lines) {
    if (line.startsWith('### ')) { entries.push({ title: line.slice(4), body: [] }); continue; }
    if (entries.length) entries[entries.length - 1].body.push(line);
    else if (line.trim()) stray.push(line);
  }
  return { entries, stray };
}

/** 天數差：now 減 date（都只有月日；年用 now 的年）。未來的日期回負數。 */
/** 時間欄裡「整理」「核實」各自那一段：從標籤起、到另一個標籤前為止（順序不拘）；沒有那個標籤＝null。 */
function timeParts(time) {
  const i = time.indexOf('整理');
  const j = time.indexOf('核實');
  const seg = (at, other) => (at < 0 ? null : time.slice(at, other > at ? other : undefined));
  return { edited: seg(i, j), verified: seg(j, i) };
}

function daysBefore(now, month, day) {
  const a = Date.UTC(now.year, now.month - 1, now.day);
  const b = Date.UTC(now.year, month - 1, day);
  return Math.round((a - b) / 86400000);
}

/** 平台對這支的答案：只認布林；沒有答案、或形狀不對（字串、物件、null）＝null（核不了），不當成證據（r1 R5）。 */
function answerOf(prStates, pr) {
  const s = prStates[pr];
  return s && typeof s === 'object' && (s.merged === true || s.merged === false) ? s.merged : null;
}

function checkEntry(entry, ctx) {
  const problems = [];
  const segs = entry.title.split('｜');
  const label = segs.length >= 2 ? `${segs[0]}｜${segs[1]}` : entry.title;
  const say = (why) => problems.push(`${label}：${why}`);
  if (segs.length !== 4) say(`標題要四段（專案｜事情｜狀態｜誰・資料夾），這一則有 ${segs.length} 段${segs.length === 5 ? '（像是舊格式的「確認時間」還在標題裡）' : ''}`);
  if (!PROJECTS.includes(segs[0])) say(`專案「${segs[0]}」不在 ${PROJECTS.join('／')} 裡`);
  const state = segs[2];
  if (segs.length >= 3 && !STATES.includes(state)) say(`狀態「${state}」不是六選一（${STATES.join('／')}）`);
  if (segs.length >= 4 && !segs[3].includes('・')) say('第四段要寫「誰・資料夾」，中間用「・」');

  const fields = new Map();
  const order = [];
  for (const raw of entry.body) {
    if (!raw.trim()) continue;
    if (OLD_FIELD.test(raw)) { say(`「${raw.split('：')[0]}」是舊的五欄寫法（沒有清單記號、少了八欄）`); continue; }
    if (LOOKS_LIKE_HEADING.test(raw)) { say(`有一行像是寫壞的標題（縮排或井號數不對，沒有被當成一則）：「${raw.trim().slice(0, 30)}」`); continue; }
    if (!/^(\s*)- /u.test(raw)) { say(`有一行不是清單：「${raw.trim().slice(0, 30)}」`); continue; }
    const m = /^- ([^：]+)：(.*)$/u.exec(raw);
    if (!m) continue;
    if (FIELDS.includes(m[1])) {
      if (fields.has(m[1])) say(`「${m[1]}」寫了兩次`);
      fields.set(m[1], m[2]);
      order.push(m[1]);
    }
  }
  for (const f of FIELDS) {
    if (!fields.has(f)) say(`少了「${f}」這一欄`);
    else if (!fields.get(f).trim()) say(`「${f}」是空的`);
  }
  const expected = FIELDS.filter((f) => fields.has(f));
  if (expected.some((f, i) => order[i] !== f)) say(`八欄的順序要照檔頭（${FIELDS.join('／')}）`);

  const time = fields.get('時間') || '';
  // 整理、核實各取自己那一段，缺的時間不可以借另一段的（r8 R1：「核實：未核；整理 10/07 18:26」以前把整理的時間當成核實的）
  const parts = timeParts(time);
  const edited = stamp(parts.edited);
  const verifiedPart = parts.verified;
  const verified = stamp(verifiedPart);
  if (!edited) say('時間欄缺「整理 月/日 時:分」');
  if (!verifiedPart) say('時間欄缺「核實」');
  else if (!verified) say('「核實」後面要有一個月/日 時:分（沿用舊紀錄就寫那份紀錄的時間）');
  if (edited && verified && verified > edited) say(`核實時間（${verified}）晚於整理時間（${edited}）：核實之後改了字就要更新整理時間`);
  // 沒動的線（擁有者 2026-10-10 裁 a）：暫停中看整理時間（文字最後改的那一刻），超過 STALE_PAUSED_DAYS 天＝列，給擁有者決定關掉還是叫回；
  // STALE_STATES 四種狀態看核實時間，超過 STALE_VERIFIED_DAYS 天＝列（唸出來才不會是上週的狀態）；暫停中不重複列核實、已結束與不在選單的不算。
  // 只比月日、未來的日期不算（跟已結束、本週成果同一套 daysBefore）；月日從 STAMP 重讀，不切字串（格式一鬆切出來是 NaN、會靜靜不列；自審 C5），讀不出＝不算天數。
  const dayOf = (s) => { const m = STAMP.exec(s || ''); return m ? { month: Number(m[1]), day: Number(m[2]), text: `${m[1]}/${m[2]}` } : null; };
  if (state === '暫停中') {
    const d = dayOf(edited);
    if (d) {
      const age = daysBefore(ctx.now, d.month, d.day);
      if (age > STALE_PAUSED_DAYS) say(`暫停中已 ${age} 天沒動（整理 ${d.text}；上限 ${STALE_PAUSED_DAYS} 天）：給擁有者決定關掉還是叫回`);
    }
  } else if (STALE_STATES.includes(state)) {
    const d = dayOf(verified);
    if (d) {
      const age = daysBefore(ctx.now, d.month, d.day);
      if (age > STALE_VERIFIED_DAYS) say(`核實已 ${age} 天沒更新（上次核實 ${d.text}；上限 ${STALE_VERIFIED_DAYS} 天）：回報前先核一次，核實與整理兩個時間都改成現在`);
    }
  }

  const refs = parseRefs(fields.get('證據') || '');
  for (const b of refs.bad) say(`證據欄的附件條號寫法不對，認不出「${b}」（要寫成「附件第 N 條」或「附件第 N〜M 條」，N、M 是 1〜${MAX_REF} 的整數、一個範圍最多 ${MAX_RANGE} 條）`);
  if (fields.has('證據') && refs.numbers.length === 0 && refs.bad.length === 0) say('證據欄沒有引到任何「附件第 N 條」');
  for (const n of refs.numbers) if (!ctx.attachments.has(n)) say(`證據引的附件第 ${n} 條不存在`);

  const step = fields.get('到哪一步') || '';
  const cited = new Set();
  for (const n of refs.numbers) for (const pr of prRefs(ctx.attachments.get(n) || '', ctx.repos)) cited.add(pr);
  const claimsMerged = /已合併/u.test(step);
  if (claimsMerged) {
    if (cited.size === 0) say('到哪一步寫「已合併」，但引到的附件裡找不到任何 PR（github.com 的完整網址或登記過的寫法），核不了');
    else if (!ctx.offline) {
      const answers = [...cited].map((pr) => [pr, answerOf(ctx.prStates, pr)]);
      const unknown = answers.filter(([, a]) => a === null).map(([pr]) => pr);
      if (unknown.length) say(`問不到平台、或平台的答案形狀不對，核不了：${unknown.join('、')}`);
      else if (!answers.some(([, a]) => a === true)) say(`到哪一步寫「已合併」，但引到的 PR 在平台上沒有一支合併了（${[...cited].join('、')}）`);
    }
  } else if (['施工中', '等複審'].includes(state) && cited.size && !ctx.offline) {
    if ([...cited].every((pr) => answerOf(ctx.prStates, pr) === true)) say(`狀態是${state}、到哪一步沒寫已合併，引到的 PR 卻全部合併了（${[...cited].join('、')}）：可能過期`);
  }
  return { problems, cited: [...cited] };
}

function checkDone(lines, ctx) {
  const problems = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    // 只認一種形狀；其餘非空行（縮排、少空白、井號數不對、散文）一律列出，沒有任何一行可以不被看到（r1〜r3 R1 同族，F10 換做法）
    const m = DONE_RECORD.exec(line);
    if (!m) { problems.push(`已結束：有一行不是合法的紀錄（只認「### 專案｜事情｜已結束 月/日｜已留：附件第 N 條」或「…｜無永久決定」，井號三個、後面一個空白）：「${line.trim().slice(0, 40)}」`); continue; }
    const age = daysBefore(ctx.now, Number(m[3]), Number(m[4]));
    if (age > DONE_DAYS) problems.push(`已結束：「${m[2]}」結束滿 ${age} 天（上限 ${DONE_DAYS} 天），該刪`);
    if (m[5].startsWith('已留')) {
      const refs = parseRefs(m[5]);
      for (const b of refs.bad) problems.push(`已結束：「${m[2]}」的附件條號寫法不對，認不出「${b}」`);
      if (refs.numbers.length === 0) problems.push(`已結束：「${m[2]}」寫「已留」卻沒有一個解析得出的附件條號`);
      for (const n of refs.numbers) if (!ctx.attachments.has(n)) problems.push(`已結束：「${m[2]}」引的附件第 ${n} 條不存在`);
    }
  }
  return problems;
}

function checkWeek(lines, ctx) {
  const problems = [];
  // 目前這組成果所屬的日期行；null＝上面還沒有合法的「- 月/日」
  let day = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = WEEK_DAY.exec(line);
    if (!m) {
      // 同樣只認兩種行：日期行與縮排的子項目；其餘列出（本週成果裡沒有日期的成果，會躲過七天的檢查）
      if (!WEEK_ITEM.test(line)) { problems.push(`本週成果：有一行不是「- 月/日」也不是縮排的子項目：「${line.trim().slice(0, 40)}」`); continue; }
      // 子項目要屬於上面某個合法的日期行，不然它的保留天數核不了（r4 R2：只剩子項目、或整組多縮排兩格，七天的檢查就消失）；
      // 縮排的日期行不算父項，它底下的成果會被算成上一個日期的，所以先點名它
      if (WEEK_ITEM_LOOKS_LIKE_DAY.test(line)) problems.push(`本週成果：日期行「${line.trim()}」縮排了（日期只能寫在最外層；它底下的成果會被算成${day ? ` ${day} ` : '上一個日期'}的）`);
      else if (day === null) problems.push(`本週成果：子項目上面沒有合法的「- 月/日」父項，核不了保留天數：「${line.trim().slice(0, 40)}」`);
      continue;
    }
    day = `${m[1]}/${m[2]}`;
    const age = daysBefore(ctx.now, Number(m[1]), Number(m[2]));
    if (age > WEEK_DAYS) problems.push(`本週成果：${m[1]}/${m[2]} 已經是 ${age} 天前（只留 ${WEEK_DAYS} 天），該刪`);
  }
  return problems;
}

/**
 * 大小與孤兒附件（擁有者 2026-10-10 授權 Fable 代裁 Q8）：本文、附件、一條附件的位元組上限，與沒有任何一則引用的附件條。
 * 本文＝整份（換行統一成 LF）減掉「本週成果」與「附件」兩節（標題行起、到下一個 ## 之前）；附件＝另放一份檔就量整份檔，放本檔就量那一節；
 * 一條附件＝從原文量：條號那一行起到下一條前，空行以外的每一行原樣都算（含分隔線與條號的前導零），行與行之間的換行算一個位元組；
 * 本文與附件那一節只算真的存在的換行（#72 r1 R1、R2）；引用＝附件那一節以外的「附件第 … 條」（只被別的附件條引用不算）。
 */
function checkSizes(text, attachmentsText, attachments) {
  const problems = [];
  let body = 0;
  let inlineAttach = 0;
  let where = null;
  const refText = [];
  const inlineLines = [];
  const lines = normalize(text).split('\n');
  lines.forEach((line, i) => {
    // 只算真的存在的換行：最後一段後面沒有換行就不加（#72 r1 R1：逐行一律 +1 會把剛好卡在上限的內容多算 1）
    const b = bytesOf(line) + (i < lines.length - 1 ? 1 : 0);
    if (line.startsWith('## ')) where = line.startsWith(SECTIONS.week) ? 'week' : line.startsWith(SECTIONS.attachments) ? 'attach' : null;
    if (where === 'attach') { inlineAttach += b; if (!line.startsWith('## ')) inlineLines.push(line); return; }
    refText.push(line);
    if (where !== 'week') body += b;
  });
  if (body > BODY_MAX_BYTES) problems.push(`大小：本文（不含本週成果與附件那一節）${body} 位元組，超過上限 ${BODY_MAX_BYTES}：先結案、縮附件、刪過期再寫，不是刪交接要用的資訊`);
  const attachBytes = attachmentsText !== null ? bytesOf(normalize(attachmentsText)) : inlineAttach;
  if (attachBytes > ATTACH_MAX_BYTES) problems.push(`大小：附件${attachmentsText !== null ? '檔' : '那一節'} ${attachBytes} 位元組，超過上限 ${ATTACH_MAX_BYTES}：先縮超過一條上限的、刪跟線一起到期的`);
  // 一條附件從原文量（#72 r1 R2：用解析後重組的文字會漏掉分隔線、條號的前導零，而且有沒有「## 附件」標題結果不同）：
  // 條號那一行起到下一條前，空行以外的每一行都算（原樣、含分隔線），行與行之間的換行算一個位元組
  const sizes = new Map();
  const measure = (raw) => {
    let cur = null;
    for (const line of raw) {
      const m = /^(\d+)\. /u.exec(line);
      if (m) { cur = Number(m[1]); sizes.set(cur, bytesOf(line)); continue; }
      if (cur !== null && line.trim()) sizes.set(cur, sizes.get(cur) + 1 + bytesOf(line));
    }
  };
  measure(inlineLines);
  if (attachmentsText !== null) {
    const fileLines = normalize(attachmentsText).split('\n');
    const h = fileLines.findIndex((l) => l.startsWith(SECTIONS.attachments));
    if (h < 0) measure(fileLines);
    else {
      const rest = fileLines.slice(h + 1);
      const next = rest.findIndex((l) => l.startsWith('## '));
      measure(next < 0 ? rest : rest.slice(0, next));
    }
  }
  for (const [n, b] of sizes) {
    if (b > ATTACH_ITEM_MAX_BYTES) problems.push(`附件第 ${n} 條 ${b} 位元組，超過一條的上限 ${ATTACH_ITEM_MAX_BYTES}：只留去哪查（網址、版本碼、留言編號、檔名），逐輪經過留在 PR 說明，全文可以搬到 Archive`);
  }
  const cited = new Set(parseRefs(refText.join('\n')).numbers);
  for (const n of attachments.keys()) {
    if (!cited.has(n)) problems.push(`附件第 ${n} 條沒有任何一則引用：先確認裡面沒有還沒貼出去的原話或還沒歸位的決定，再刪或補進它那條線的「已留」`);
  }
  return problems;
}

/**
 * 純判斷層。text＝整份摘要；now＝{ year, month, day }；prStates＝{ 'owner/repo#n': { merged: true|false|null } }；
 * repos＝{ 套件: 'owner/repo' }；offline＝不看 prStates。
 * 回 { unsure, problems, entries, attachments, cited }：unsure 非空＝查不了。
 */
function evaluate(text, { now, prStates = {}, repos = {}, offline = false, attachmentsText = null } = {}) {
  const sections = splitSections(text);
  const actives = findSections(sections, SECTIONS.active);
  const attachmentSections = findSections(sections, SECTIONS.attachments);
  if (actives.length === 0) return { unsure: `找不到「${SECTIONS.active}」那一節` };
  // 附件另放一份檔時，本檔的附件那一節可以沒有（只留指標也行）；沒給附件檔就一定要有
  if (attachmentSections.length === 0 && attachmentsText === null) return { unsure: `找不到「${SECTIONS.attachments}」那一節（附件另放一份檔的話要帶 --attachments）` };
  for (const [name, found] of [[SECTIONS.active, actives], [SECTIONS.attachments, attachmentSections]]) {
    if (found.length > 1) return { unsure: `「${name}」那一節出現 ${found.length} 次，分不出哪一節算數` };
  }
  if (!now || !(now.year >= 2000) || !(now.month >= 1 && now.month <= 12) || !(now.day >= 1 && now.day <= 31)) return { unsure: '今天的日期讀不出來' };
  const inline = attachmentSections.length ? parseAttachments(attachmentSections[0].lines) : new Map();
  const attachments = new Map(inline);
  const problems = [];
  let fromFile = 0;
  if (attachmentsText !== null) {
    // 附件檔：有「## 附件」那一節就讀那一節，沒有就整份讀（檔頭、說明都不是條目，parseAttachments 只認「N. 」開頭的行）
    const fileSections = findSections(splitSections(attachmentsText), SECTIONS.attachments);
    // 附件檔裡那一節出現兩次＝跟本檔一樣查不了，不自己挑第一節（r1 R1）
    if (fileSections.length > 1) return { unsure: `附件檔裡「${SECTIONS.attachments}」那一節出現 ${fileSections.length} 次，分不出哪一節算數` };
    const extra = fileSections.length ? parseAttachments(fileSections[0].lines) : parseAttachments(normalize(attachmentsText).split('\n'));
    fromFile = extra.size;
    for (const [n, body] of extra) {
      if (attachments.has(n)) problems.push(`附件第 ${n} 條在摘要本檔與附件檔都有，分不出哪一條算數（本檔那一節應該只留指標）`);
      attachments.set(n, body);
    }
  }
  const ctx = { now, prStates, repos, offline, attachments };
  // 檔頭沒規定的節：把工作線標題寫成兩個井號，整則就變成一節、從所有檢查裡消失（r2 R1）
  for (const s of sections) {
    if (KNOWN_SECTIONS.some((k) => s.heading.startsWith(k))) continue;
    problems.push(`多了一節不在檔頭規定裡：「${s.heading.slice(0, 40)}」${s.heading.includes('｜') ? '（像是把工作線的標題寫成兩個井號，整則沒有被檢查）' : ''}`);
  }
  const { entries, stray } = parseEntries(actives[0].lines);
  for (const line of stray) {
    const why = LOOKS_LIKE_HEADING.test(line) ? '像是縮排或井號數不對的標題，沒有被當成一則' : '不是任何一則的內容';
    problems.push(`進行中的線：第一則之前有不屬於任何一則的內容（${why}）：「${line.trim().slice(0, 30)}」`);
  }
  const cited = new Set();
  for (const entry of entries) {
    const r = checkEntry(entry, ctx);
    problems.push(...r.problems);
    for (const pr of r.cited) cited.add(pr);
  }
  for (const s of findSections(sections, SECTIONS.done)) problems.push(...checkDone(s.lines, ctx));
  for (const s of findSections(sections, SECTIONS.week)) problems.push(...checkWeek(s.lines, ctx));
  problems.push(...checkSizes(text, attachmentsText, attachments));
  return { unsure: null, problems, entries: entries.length, attachments: attachments.size, attachmentsInline: inline.size, attachmentsFile: fromFile, cited: [...cited] };
}

/** 問平台用的環境：清掉 GIT_ 那一族（E4）之外，再清選主機、選倉庫的變數——證據網址是 github.com，查詢不可以被環境變數導去別的主機（r1 R7）。 */
function ghEnv(env = process.env) {
  const out = gitEnv(env);
  for (const key of ['GH_HOST', 'GH_REPO', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete out[key];
  return out;
}

/**
 * 問平台「這支合併了沒」。runner 可換（考題用）；固定問 github.com。
 * 問不到＝merged: null、附原因；答案要是物件、要有 merged_at：null＝沒合併、合法的時間＝合併了，其餘形狀都＝null（核不了），不猜（r1 R5）。
 */
function fetchPrStates(prs, runner = runGh) {
  const out = {};
  for (const pr of prs) {
    const m = /^([^/]+)\/([^#]+)#(\d+)$/u.exec(pr);
    if (!m) { out[pr] = { merged: null, why: '寫法認不得' }; continue; }
    const r = runner(['api', '--hostname', HOST, `repos/${m[1]}/${m[2]}/pulls/${m[3]}`]);
    if (r.status !== 0) { out[pr] = { merged: null, why: (r.stderr || '').trim().split('\n')[0] || `退出碼 ${r.status}` }; continue; }
    let data;
    try { data = JSON.parse(r.stdout); } catch { out[pr] = { merged: null, why: '平台回的不是 JSON' }; continue; }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !('merged_at' in data)) { out[pr] = { merged: null, why: '平台回的形狀不對（沒有 merged_at）' }; continue; }
    if (data.merged_at === null) out[pr] = { merged: false, state: data.state };
    else if (parseInstant(data.merged_at) !== null) out[pr] = { merged: true, state: data.state };
    else out[pr] = { merged: null, why: 'merged_at 不是合法的時間' };
  }
  return out;
}

/** 最近 hours 小時改過 file 的提交（git log，只算這一個檔）；不在倉庫裡、git 不能用＝null（印查不到，不猜）。環境先清掉版本控制那一族變數（E4）。 */
function recentCommits(file, hours) {
  const dir = path.dirname(path.resolve(file));
  // --no-show-signature、--encoding=UTF-8：使用者的 git 設定開了 log.showSignature（簽章診斷會混進標準輸出、被當成提交）或 i18n.logOutputEncoding 設成別的編碼（題名變亂碼）時也要對（#66 r2 R1；跟 tools/downstream-lag.js 同一套）；
  // 時間印 %cd（提交時間）：--since 本來就用提交時間篩，印作者時間會對不上（rebase、amend 之後兩個時間不同；#66 r2 R2）；
  // format-local：照這台機器的時區印（format: 會照提交裡記的時區，別的時區提的會對不上摘要裡的台北時間）
  // --literal-pathspecs：檔名逐字比對，不當成比對樣式（檔名有 [ ] * ? 或冒號開頭時，別的檔的提交會被列進來；#66 r3 R2）
  const r = spawnSync('git', ['-C', dir, '--literal-pathspecs', 'log', '--no-show-signature', '--encoding=UTF-8', `--since=${hours} hours ago`, '--format=%cd%x09%s', '--date=format-local:%m/%d %H:%M', '--', path.basename(file)], { encoding: 'utf8', env: gitEnv() });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { time: l.slice(0, i), subject: l.slice(i + 1) }; });
}

function runGh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', env: ghEnv(), maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: '', stderr: String(r.error.message) };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parseArgs(argv) {
  // 別名表不帶原型：登記什麼名字（連 __proto__）都只是自有的鍵，不會改到別的東西（r1 R8）
  const opts = { file: null, now: null, offline: false, strict: false, prStatesFile: null, repos: Object.create(null), recent: String(RECENT_HOURS) };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { i += 1; if (i >= argv.length) throw new Error(`${a} 後面要接值`); return argv[i]; };
    if (a === '--file') opts.file = next();
    else if (a === '--attachments') opts.attachmentsFile = next();
    else if (a === '--now') opts.now = next();
    else if (a === '--offline') opts.offline = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--recent') opts.recent = next();
    else if (a === '--pr-states') opts.prStatesFile = next();
    else if (a === '--repos') {
      for (const pair of next().split(',')) {
        const [name, repo] = pair.split('=');
        if (!name || !repo || !/^[^/]+\/[^/]+$/u.test(repo)) throw new Error(`--repos 的寫法是 名稱=owner/repo，用逗號隔開（收到「${pair}」）`);
        opts.repos[name.trim()] = repo.trim();
      }
    } else throw new Error(`不認得的參數：${a}。用法：node tools/check-progress-summary.js --file <摘要檔> [--now 月/日] [--offline] [--strict] [--recent <小時>] [--pr-states <json 檔>] [--repos 套件=owner/repo,...]`);
  }
  if (!opts.file) throw new Error('要給 --file <摘要檔>');
  return opts;
}

function todayLocal() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

function parseNow(text) {
  const m = /^(\d{1,2})\/(\d{1,2})$/u.exec(text || '');
  if (!m) return null;
  return { year: todayLocal().year, month: Number(m[1]), day: Number(m[2]) };
}

function run(argv, { fetch = fetchPrStates } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { return { code: 2, lines: [`進度摘要檢查：${e.message}`] }; }
  let text;
  try { text = fs.readFileSync(opts.file, 'utf8'); } catch (e) { return { code: 2, lines: [`進度摘要檢查：讀不到 ${opts.file}（${e.code || e.message}）`] }; }
  let attachmentsText = null;
  if (opts.attachmentsFile) {
    try { attachmentsText = fs.readFileSync(opts.attachmentsFile, 'utf8'); } catch (e) { return { code: 2, lines: [`進度摘要檢查：讀不到附件檔 ${opts.attachmentsFile}（${e.code || e.message}）`] }; }
  }
  const now = opts.now ? parseNow(opts.now) : todayLocal();
  if (!now) return { code: 2, lines: [`進度摘要檢查：--now 要寫成 月/日（收到「${opts.now}」）`] };
  if (!/^\d+$/u.test(String(opts.recent))) return { code: 2, lines: [`進度摘要檢查：--recent 要是幾小時（非負整數；收到「${opts.recent}」）`] };
  const recentHours = Number(opts.recent);
  let prStates = {};
  if (opts.prStatesFile) {
    try { prStates = JSON.parse(fs.readFileSync(opts.prStatesFile, 'utf8')); } catch (e) { return { code: 2, lines: [`進度摘要檢查：--pr-states 讀不到或不是 JSON（${e.code || e.message}）`] }; }
    if (!prStates || typeof prStates !== 'object' || Array.isArray(prStates)) return { code: 2, lines: ['進度摘要檢查：--pr-states 要是一個物件（owner/repo#n → { merged: true|false }）'] };
  }
  // 先離線跑一次，只為了知道要問平台哪幾支；再帶著答案真的判。
  const dry = evaluate(text, { now, repos: opts.repos, offline: true, attachmentsText });
  if (dry.unsure) return { code: 2, lines: [`進度摘要檢查：${dry.unsure}——查不了。`] };
  if (!opts.offline && !opts.prStatesFile && dry.cited.length) prStates = fetch(dry.cited);
  const result = evaluate(text, { now, prStates, repos: opts.repos, offline: opts.offline, attachmentsText });
  if (result.unsure) return { code: 2, lines: [`進度摘要檢查：${result.unsure}——查不了。`] };
  const lines = [`進度摘要檢查｜${opts.file}：進行中 ${result.entries} 則、附件 ${result.attachments} 條${opts.attachmentsFile ? `（本檔 ${result.attachmentsInline}、附件檔 ${result.attachmentsFile}）` : ''}、引到 ${result.cited.length} 支 PR${opts.offline ? '（離線，沒問平台）' : ''}；問題 ${result.problems.length} 條`];
  for (const p of result.problems) lines.push(`  ・${p}`);
  lines.push(result.problems.length ? '只列不擋（--strict 才擋）；照檔頭「怎麼寫」逐條改，改完再跑一次。' : '沒有問題。');
  // 最近誰提交：只印、不算問題（「現在誰在動」落後時以這裡為準）
  const recent = recentCommits(opts.file, recentHours);
  if (recent === null) lines.push('最近誰提交：本檔不在 git 倉庫裡（或 git 不能用），查不到');
  else if (!recent.length) lines.push(`最近 ${recentHours} 小時沒有人提交本檔（git）`);
  else {
    lines.push(`最近 ${recentHours} 小時改過本檔的提交（git；「現在誰在動」那一欄落後時以這裡為準）：`);
    for (const c of recent) lines.push(`  ・${c.time} ${c.subject}`);
  }
  return { code: opts.strict && result.problems.length ? 1 : 0, lines };
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { run, evaluate, fetchPrStates, ghEnv, expandRefs, parseRefs, prRefs, parseArgs, FIELDS, STATES, PROJECTS, KNOWN_SECTIONS, DONE_DAYS, WEEK_DAYS, STALE_PAUSED_DAYS, STALE_VERIFIED_DAYS, STALE_STATES, RECENT_HOURS, BODY_MAX_BYTES, ATTACH_MAX_BYTES, ATTACH_ITEM_MAX_BYTES, MAX_REF, MAX_RANGE };
