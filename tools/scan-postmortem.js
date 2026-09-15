#!/usr/bin/env node
// 掃描後比對（規矩 G2；裁示者 2026-09-12 裁「丙」）：掃描期間埋在真禁區的假機密（每掃現生）、以及真憑證裡
// 沒給盒子的值，有沒有出現在掃描器的任何輸出裡——回覆、日誌、**連檔名都算**（原專案：機密只出現在檔名、
// 內容無害，舊寫法一路走到成功路徑）。有＝事故（退 1）：停掃、不保存、通報裁示者。
// **不回聲命中的內容**——事故訊息會被抄進變更說明，而那可能是公開的。
//
// 為什麼只比對字面（含 JSON 轉義一層、兩層的寫法）：這些值由構造已知，不需要用形狀去猜。原專案憑形狀認機密
// 那一族（私鑰標頭、token 形狀）連同「材料裡本來就有的不算」那套排除集合，是假事故最多的地方，這裡不搬。
// 為什麼要算轉義的寫法：掃描器的日誌常是 JSON，裡面的引號與反斜線會被轉義，命中跟原文對不上（原專案第三次
// 正式掃描踩到）。深度到兩層是觀察值不是定理。
//
// 名字也算輸出：回覆的檔名、日誌裡每一個檔與**目錄**的名字、日誌根本身（根是符號連結＝事故）。
// 守不到的照實說：編碼過、拆段過、轉義超過兩層的外洩認不得（方向是漏報）；輸出讀不了的部分驗不到＝
// 不能說乾淨（退 2）——**但非 UTF-8 的檔照樣逐位元組比，比到＝事故優先**；日誌區出現符號連結之類的非一般檔案＝掃描器在日誌區放了捷徑，當事故。
//
// ⚠️ **輸出的名字本身可能就是機密**（這支工具存在的理由之一）。所以任何會印出名字的路徑——包含讀不到、
//    讀不進、超過上限的錯誤訊息——一律先過 redact()。2026-09-13 稽核抓到：原本讀檔沒有 try/catch，
//    日誌區只要有一個讀不到的檔，整支就未捕捉例外中止，把**未遮蔽的完整路徑印兩次到 stderr**，
//    而那段訊息照這套流程會被抄進可能公開的變更說明。
//
// 退出碼：0＝乾淨／1＝有命中，事故／2＝比對做不成（沒有機密可比、機密太短、沒有輸出、有輸出驗不了、
//        讀不到或讀不進——**任何 I/O 問題都算做不成，不是事故**）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CAPS = Object.freeze({ files: 4000, depth: 12, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });
const MIN_SECRET = 8;

const jsonEscOnce = (s) => JSON.stringify(s).slice(1, -1);
/** 原文、轉義一層、轉義兩層——偵測側只有這一把尺 */
function escapeForms(s) {
  const out = [s];
  while (out.length < 3) out.push(jsonEscOnce(out[out.length - 1]));
  return out;
}

function positionsOf(text, needle) {
  const out = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/**
 * 比對。secrets＝要找的值（不回聲）；outputs＝[{ where, text }] 或 [{ where, bytes }] 或 [{ where, special }]。
 * 回傳 { code, lines, hits, unverified }；hits 只記位置與第幾個機密、第幾種寫法，不記值。
 */
function compare({ secrets, outputs, caps = CAPS } = {}) {
  const lines = [];
  const say = (text) => lines.push(text);
  const list = Array.isArray(secrets) ? secrets : [];
  if (!list.length) { say('沒有任何機密可比：什麼都沒比就說乾淨，比沒有比對更危險，不算通過。'); return { code: 2, lines, hits: [], unverified: [] }; }
  for (const [i, s] of list.entries()) {
    if (typeof s !== 'string' || s.length < MIN_SECRET) { say(`第 ${i + 1} 個機密不是字串或短於 ${MIN_SECRET} 字：比對會亂中，不算通過。`); return { code: 2, lines, hits: [], unverified: [] }; }
  }
  const outs = Array.isArray(outputs) ? outputs : [];
  if (!outs.length) { say('沒有任何輸出可比：證明不了掃描器做了什麼，不算通過。'); return { code: 2, lines, hits: [], unverified: [] }; }

  const forms = list.map((s) => escapeForms(s));
  const hits = [];
  const unverified = [];
  const dec = new TextDecoder('utf-8', { fatal: true });
  // 名字本身可能就含機密（考題釘著）：印出來、記進命中或驗不了清單之前，一律先把三種寫法都遮掉
  const redact = (s) => { let t = s; for (const fs3 of forms) for (const f of fs3) t = t.split(f).join('＜遮蔽＞'); return t; };
  const scan = (text, where, part) => {
    forms.forEach((fs3, secretIndex) => {
      fs3.forEach((form, formIndex) => {
        for (const index of positionsOf(text, form)) hits.push({ where: redact(where), part, secret: secretIndex + 1, form: formIndex, index });
      });
    });
  };
  // 解不成文字的輸出也要比位元組：假機密是已知的位元組序列（搬家驗屋 09-13：檔案裡混一個不合法位元組，
  // 原本整份當「驗不了」、退 2＝記未執行，真的外洩就從事故降成沒驗到、裁示者收不到通報）
  const scanBytes = (buf, where) => {
    forms.forEach((fs3, secretIndex) => {
      fs3.forEach((form, formIndex) => {
        const needle = Buffer.from(form, 'utf8');
        for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + needle.length)) hits.push({ where: redact(where), part: '內容（非 UTF-8，比位元組）', secret: secretIndex + 1, form: formIndex, index: i });
      });
    });
  };
  let totalBytes = 0;
  for (const o of outs) {
    const where = String(o.where || '');
    if (!where) { say('有一份輸出沒有名字：驗不了。'); unverified.push('（沒有名字）'); continue; }
    if (o.special) { hits.push({ where: redact(where), part: '非一般檔案', kind: String(o.special) }); continue; }
    if (o.unreadable) { unverified.push(`${redact(where)}（${o.unreadable}）`); scan(where, where, '名字'); continue; }
    scan(where, where, '名字');
    let text;
    if (typeof o.text === 'string') text = o.text;
    else if (Buffer.isBuffer(o.bytes)) {
      if (o.bytes.length > caps.fileBytes) { unverified.push(redact(where)); continue; }
      totalBytes += o.bytes.length;
      if (totalBytes > caps.totalBytes) { unverified.push(redact(where)); continue; }
      // 比不到仍算驗不了：別的編碼（例如一個字兩個位元組）寫出來的機密，這裡認不得
      try { text = dec.decode(o.bytes); } catch { scanBytes(o.bytes, where); unverified.push(redact(where)); continue; }
    } else { unverified.push(redact(where)); continue; }
    scan(text, where, '內容');
  }
  if (hits.length) {
    const byWhere = new Map();
    for (const h of hits) byWhere.set(h.where, (byWhere.get(h.where) || 0) + 1);
    for (const [where, n] of byWhere) say(`⚠️ 命中｜${where}｜${n} 處（機密編號與寫法只記在結果裡，不印值）`);
    say(`比對：${hits.length} 處命中＝盒子外的東西出現在掃描器的輸出裡，這是事故；不保存、照規矩 G2 通報裁示者。`);
    return { code: 1, lines, hits, unverified };
  }
  if (unverified.length) {
    say(`比對：${unverified.length} 份輸出驗不了（非 UTF-8、超過上限或沒有內容）：${unverified.slice(0, 3).join('、')}${unverified.length > 3 ? '…' : ''}——驗不到就不能說乾淨。`);
    return { code: 2, lines, hits, unverified };
  }
  say(`比對：${outs.length} 份輸出（含名字）對 ${list.length} 個機密各三種寫法，零命中。`);
  return { code: 0, lines, hits, unverified };
}

/**
 * 把一個目錄底下的檔案收成 outputs：不跟符號連結、非一般檔案另標；超過上限＝回 over。
 * ⚠️ 每一次 I/O 都包起來：讀不到的檔或進不去的子目錄**不可以讓整支中止**——那條路會把未遮蔽的路徑
 *    丟進 stderr，而路徑本身可能就是機密。讀不到的照實記成 unreadable，交給 compare 判「驗不了」。
 * ⚠️ 深度上限的訊息只回層數、不回路徑（同一個理由）。
 */
function collectOutputs(dir, caps = CAPS) {
  const outputs = [];
  let count = 0;
  const walk = (d, depth, rel) => {
    if (depth > caps.depth) return `深度超過 ${caps.depth} 層`;
    let names;
    try { names = fs.readdirSync(d); }
    catch (e) { outputs.push({ where: rel || '.', unreadable: `目錄進不去：${e.code || '讀取失敗'}` }); return ''; }
    for (const name of names) {
      const p = path.join(d, name);
      const rp = rel ? `${rel}/${name}` : name;
      let st;
      try { st = fs.lstatSync(p); }
      catch (e) { outputs.push({ where: rp, unreadable: `看不到：${e.code || '讀取失敗'}` }); continue; }
      // 目錄的**名字**也是掃描器寫的東西：機密只出現在目錄名時，原本從不進 outputs（r1 High⑤）
      if (st.isDirectory()) { outputs.push({ where: rp, text: '' }); const over = walk(p, depth + 1, rp); if (over) return over; continue; }
      count += 1;
      if (count > caps.files) return `檔數超過 ${caps.files}`;
      if (!st.isFile()) { outputs.push({ where: rp, special: st.isSymbolicLink() ? '符號連結' : '特殊檔' }); continue; }
      try { outputs.push({ where: rp, bytes: fs.readFileSync(p) }); }
      catch (e) { outputs.push({ where: rp, unreadable: `讀不進：${e.code || '讀取失敗'}` }); }
    }
    return '';
  };
  // 根目錄自己也先 lstat：根是符號連結時，「不跟符號連結」的政策原本只作用在子項（r1 High⑤）。
  // 根的**名字**也進比對（r2 High⑥：原本普通根的名字從沒進過 outputs；錯誤與特殊檔那幾條又把它換成人讀標籤）——
  // 所以每一種出口的 where 都帶著根的真名字，印出來之前會被遮蔽。
  const rootLabel = `日誌根（${path.basename(path.resolve(dir))}）`;
  let rootSt;
  try { rootSt = fs.lstatSync(dir); }
  catch (e) { return { outputs: [{ where: rootLabel, unreadable: `看不到：${e.code || '讀取失敗'}` }], over: '', files: 0 }; }
  if (rootSt.isSymbolicLink()) return { outputs: [{ where: rootLabel, special: '符號連結' }], over: '', files: 0 };
  if (!rootSt.isDirectory()) return { outputs: [{ where: rootLabel, unreadable: '不是目錄' }], over: '', files: 0 };
  outputs.push({ where: rootLabel, text: '' });
  const over = walk(dir, 0, '');
  return { outputs, over, files: count };
}

/**
 * 指令入口的本體，抽出來讓考題直接考（原本整段寫在 require.main 裡＝零覆蓋，2026-09-13 稽核抓到：
 * 把回覆從 outputs 拿掉，這支會印「零命中」退 0，而測試卷一題都不紅）。
 * 回傳 { code, lines }；任何 I/O 問題都回 2，訊息只帶錯誤代碼、不帶路徑。
 */
function cli(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const secretsFile = arg('--secrets');
  const replyFile = arg('--reply');
  const logsDir = arg('--logs');
  if (!secretsFile || (!replyFile && !logsDir)) {
    return { code: 2, lines: ['用法：node tools/scan-postmortem.js --secrets <每行一個機密的檔> [--reply <回覆檔>] [--logs <日誌目錄>]'] };
  }
  let secrets;
  try { secrets = fs.readFileSync(secretsFile, 'utf8').split('\n').map((x) => x.trim()).filter(Boolean); }
  catch (e) { return { code: 2, lines: [`機密清單讀不到（${e.code || '讀取失敗'}）：沒有機密就比不了，不算通過。`] }; }
  const outputs = [];
  if (replyFile) {
    // 回覆檔的**檔名**也要比對（r1 High⑤：原本換成人讀的「回覆」標籤，真名字從沒進過比對）
    const label = `回覆（${path.basename(replyFile)}）`;
    try { outputs.push({ where: label, bytes: fs.readFileSync(replyFile) }); }
    catch (e) { outputs.push({ where: label, unreadable: `讀不到：${e.code || '讀取失敗'}` }); }
  }
  if (logsDir) {
    let collected;
    try { collected = collectOutputs(logsDir); }
    catch (e) { collected = { outputs: [{ where: '日誌根目錄', unreadable: `收不起來：${e.code || '讀取失敗'}` }], over: '' }; }
    outputs.push(...collected.outputs);
    // 超限不提前退：已經收到的回覆與日誌照樣比，命中優先於驗不了（r1 Medium⑯：原本先退 2，把已到手的外洩證據降成普通未執行）
    if (collected.over) outputs.push({ where: '日誌收集', unreadable: `讀不完：${collected.over}` });
    // 「根目錄存在」不能單獨算成有輸出可驗（r2 High⑥）：空根、又沒有回覆＝什麼都沒掃到＝驗不了
    if (collected.files === 0 && !replyFile && !collected.over) outputs.push({ where: '日誌收集', unreadable: '日誌目錄裡沒有任何檔案，沒有輸出可驗' });
  }
  return compare({ secrets, outputs });
}

if (require.main === module) {
  let result;
  // 最後一層網：任何沒想到的例外都不可以把未遮蔽的路徑丟進 stderr
  try { result = cli(process.argv.slice(2)); }
  catch (e) { result = { code: 2, lines: [`比對做不成（${(e && e.code) || '未預期的錯誤'}）：驗不到就不能說乾淨。`] }; }
  process.stdout.write(`${result.lines.join('\n')}\n`);
  process.exit(result.code);
}

module.exports = { cli, compare, collectOutputs, escapeForms, CAPS, MIN_SECRET };
