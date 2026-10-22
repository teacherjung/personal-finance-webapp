#!/usr/bin/env node
// 開工與送審前體檢總表（規矩 D1、F6、K5、D4、F11、G1）：把開工前與送審前散在多支的唯讀檢查與 4 個 AI 座位體檢收成一鍵執行；只列不擋。
//
// 為什麼：開工前要跑 pending-rulings、backlog-touch、downstream-lag，送審前還要再跑 backlog-touch、stale-text、risk-tier，
// 多家 AI 協作時還要確認本機各家 CLI 執行檔（與 Grok 盒外憑證檔）在不在。散成 5〜6 條指令時容易漏跑其中一條；
// 收成單一入口，不傳變更編號跑開工前項目、傳變更編號一併跑送審前項目，各支原本的獨立工具與判斷邏輯維持原樣不重複實作。
//
// 誠實劃界（規矩 K3）：
//   ①這支只是唯讀總表，不是合併閘；個別項目（待裁、待辦、下游落後、舊文字、風險分級）的守不到範圍見各支工具檔頭；
//   ②AI 座位體檢只看設定裡登記的啟動指令執行檔在不在（以及走 --grok-exec 時盒外 ~/.grok/auth.json 是否為一般檔案），
//     絕不讀取或印出憑證內容，也不發網路請求驗權杖有沒有過期（Grok 權杖續期與 Seatbelt 預檢在實際啟動 --grok-exec 時才跑）。
//
// 退出碼：0＝所有執行的項目都順利算完（含「0 筆命中」或座位缺執行檔的提醒）／2＝參數不對，或任一子工具算不出來（如設定未填、平台問不到、基準版本找不到）。⚠️ 不是閘。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ask } = require('./platform.js');
const { read: readSettings } = require('./settings-data.js');
const { run: runPending } = require('./pending-rulings.js');
const { run: runBacklog } = require('./backlog-touch.js');
const { run: runDownstream } = require('./downstream-lag.js');
const { run: runStale } = require('./stale-text.js');
const { run: runRisk, gitIn } = require('./risk-tier.js');

const UNSET = '未設定';
const USAGE = '用法：node tools/preflight.js [<變更編號>] [--base <基準版本>] [--skip-downstream] [--skip-seats]';

function filled(v) {
  return typeof v === 'string' && v.trim() !== '' && v.trim() !== UNSET;
}

/** 解析指令列參數。不認得的旗標或多餘位置參數回 { error }。 */
function parseArgs(argv = []) {
  const out = { change: undefined, base: undefined, skipDownstream: false, skipSeats: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `--base 後面要接基準版本。${USAGE}` };
      out.base = v;
      i += 1;
    } else if (a === '--skip-downstream') {
      out.skipDownstream = true;
    } else if (a === '--skip-seats') {
      out.skipSeats = true;
    } else if (a.startsWith('--')) {
      return { error: `不認得的參數：${a}。${USAGE}` };
    } else if (out.change === undefined) {
      out.change = a;
    } else {
      return { error: `多給了一個參數：${a}。${USAGE}` };
    }
  }
  return out;
}

/** 在環境 PATH 與常見本機安裝路徑裡找可執行檔（純檔案系統檢查，不起子行程）；若已帶路徑則只驗該路徑本身。 */
function defaultWhich(bin, { env = process.env, homedir = os.homedir(), fsImpl = fs } = {}) {
  if (!bin || typeof bin !== 'string') return null;
  if (bin.includes('/') || bin.includes(path.sep)) {
    try {
      const st = fsImpl.statSync(bin);
      if (!st.isFile()) return null;
      fsImpl.accessSync(bin, fsImpl.constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  const home = homedir || '';
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    home ? path.join(home, '.local', 'bin') : '',
    home ? path.join(home, '.grok', 'bin') : '',
  ].filter(Boolean);
  const dirs = [...new Set([...String(env.PATH || '').split(path.delimiter).filter(Boolean), ...extra])];
  for (const d of dirs) {
    const candidate = path.join(d, bin);
    try {
      const st = fsImpl.statSync(candidate);
      if (!st.isFile()) continue;
      fsImpl.accessSync(candidate, fsImpl.constants.X_OK);
      return candidate;
    } catch {
      /* 繼續找下一個目錄 */
    }
  }
  return null;
}

/** 從 command 樣板擷取要檢查的 CLI 執行檔（保留明確路徑），以及是否走 --grok-exec 沙盒通道。 */
function extractCommandSpec(command) {
  const text = String(command || '').trim();
  if (!text || text === UNSET) return { bin: null, usesGrokExec: false };
  if (/(?:^|[\s/\\])review-launch\.js(?:\s+[^\n]*?)?\s+--grok-exec(?=\s|$)/u.test(text)) {
    return { bin: 'grok', usesGrokExec: true };
  }
  const segments = text.split(/\s*(?:&&|;)\s*/u).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/u).filter(Boolean);
    let idx = 0;
    while (idx < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[idx]) || tokens[idx] === 'env')) {
      idx += 1;
    }
    if (idx >= tokens.length) continue;
    const first = tokens[idx].replace(/^['"]|['"]$/gu, '');
    const base = path.basename(first);
    if (base === 'cd' || base === 'export') continue;
    if (!first || first.startsWith('-') || first.startsWith('{')) return { bin: null, usesGrokExec: false };
    return { bin: first, usesGrokExec: false };
  }
  return { bin: null, usesGrokExec: false };
}

/**
 * 檢查設定裡登記的 AI 座位（複審者名單 + 掃描者）在本機的 CLI 執行檔與必要盒外憑證檔狀態。
 * 唯讀、只列不擋（退出碼永遠 0），絕不讀取或輸出憑證檔內容。
 */
function checkSeats(settings = {}, {
  which,
  authFile = path.join(os.homedir(), '.grok', 'auth.json'),
  grokBin = path.basename(path.dirname(authFile)) === '.grok'
    ? path.join(path.dirname(authFile), 'bin', 'grok')
    : path.join(os.homedir(), '.grok', 'bin', 'grok'),
  fsImpl = fs,
} = {}) {
  const resolveBin = typeof which === 'function' ? which : (b) => defaultWhich(b, { fsImpl });
  const div = settings.defaultDivision || {};
  const impl = filled(div.implementer) ? div.implementer : '未設定';
  const rev = filled(div.reviewer) ? div.reviewer : '未設定';
  const sc = settings.scanner || {};
  const scanName = sc.tool === '無' ? '無' : (filled(sc.participant) ? sc.participant : '未設定');

  const seats = new Map();
  for (const r of Array.isArray(settings.reviewers) ? settings.reviewers : []) {
    if (!r || !filled(r.participant)) continue;
    seats.set(r.participant, {
      participant: r.participant,
      roles: ['複審候選'],
      source: filled(r.source) ? r.source : '未填來源',
      model: filled(r.strongest) ? r.strongest : '未填模型',
      effort: filled(r.maxEffort) ? r.maxEffort : '未填推理',
      commands: [r.command],
    });
  }
  if (sc && sc.tool !== '無' && filled(sc.participant)) {
    const existing = seats.get(sc.participant);
    if (existing) {
      existing.roles.push('掃描者');
      existing.commands.push(sc.command);
    } else {
      seats.set(sc.participant, {
        participant: sc.participant,
        roles: ['掃描者'],
        source: filled(sc.source) ? sc.source : '未填來源',
        model: filled(sc.strongest) ? sc.strongest : '未填模型',
        effort: filled(sc.maxEffort) ? sc.maxEffort : '未填推理',
        commands: [sc.command],
      });
    }
  }

  const lines = [
    `AI 座位體檢｜分工設定：實作＝${impl}、複審＝${rev}、掃描＝${scanName}｜已登記 CLI 座位 ${seats.size} 個（只列不擋）`,
  ];
  if (!seats.size) {
    lines.push('  （專案設定尚未登記任何 reviewers 或 scanner 座位）');
    return { code: 0, lines, seats: [] };
  }

  const results = [];
  for (const seat of seats.values()) {
    const specs = seat.commands.map((c) => extractCommandSpec(c));
    const usesGrokExec = specs.some((s) => s.usesGrokExec);
    if (!specs.length || specs.some((s) => !s.bin)) {
      lines.push(`  ・${seat.participant}（${seat.source}｜${seat.model}／${seat.effort}）：⚠️ 啟動指令未填或無法解析執行檔`);
      results.push({ participant: seat.participant, bin: null, binPath: null, usesGrokExec, authReady: null, ok: false });
      continue;
    }
    const checkTargets = [];
    const seenTargetKeys = new Set();
    for (const s of specs) {
      const key = s.usesGrokExec ? `grokExec:${grokBin}` : `std:${s.bin}`;
      if (seenTargetKeys.has(key)) continue;
      seenTargetKeys.add(key);
      checkTargets.push({
        label: s.usesGrokExec ? grokBin : s.bin,
        displayBin: s.bin,
        path: s.usesGrokExec ? defaultWhich(grokBin, { fsImpl }) : resolveBin(s.bin),
      });
    }
    const missingBins = checkTargets.filter((r) => !r.path).map((r) => r.label);
    const allBinsOk = missingBins.length === 0;
    const bin = allBinsOk ? [...new Set(checkTargets.map((r) => r.displayBin))].join('、') : missingBins.join('、');
    const binPath = allBinsOk ? [...new Set(checkTargets.map((r) => r.path))].join('、') : null;
    let authReady = null;
    let authNote = '';
    if (usesGrokExec) {
      try {
        const st = fsImpl.lstatSync(authFile);
        authReady = st.isFile() && !st.isSymbolicLink();
      } catch {
        authReady = false;
      }
      authNote = authReady
        ? '；Grok 盒外憑證檔就緒（僅驗一般檔案存在，不讀內容）'
        : `；⚠️ 找不到 Grok 盒外憑證一般檔案（${authFile}）`;
    }
    const ok = Boolean(binPath) && (authReady === null || authReady === true);
    const binNote = binPath
      ? `執行檔 ${bin} 就緒（${binPath}）`
      : `⚠️ 找不到執行檔 ${bin}（輪到此座位時請先確認安裝與 PATH）`;
    lines.push(`  ・${seat.participant}（${seat.source}｜${seat.model}／${seat.effort}）：${binNote}${authNote}`);
    results.push({ participant: seat.participant, bin, binPath: binPath || null, usesGrokExec, authReady, ok });
  }
  return { code: 0, lines, seats: results };
}

/**
 * 執行開工／送審前體檢總表。
 * 不帶變更編號＝開工前模式（待裁、待辦、下游落後、AI 座位）；帶變更編號＝送審前模式（加跑舊文字掃描與合併前風險分級）。
 */
function run(argv = [], {
  settings = readSettings(),
  platform = { ask },
  cwd = process.cwd(),
  which,
  authFile,
  fsImpl,
  runners = {},
} = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { code: 2, lines: [parsed.error] };

  const baseArgv = parsed.base ? ['--base', parsed.base] : [];
  const tasks = [
    {
      id: 'pending-rulings',
      title: '待裁清單（D1）',
      exec: () => (runners.pendingRulings || runPending)({ settings, platform }),
    },
    {
      id: 'backlog-touch',
      title: '開工印待辦（F6）',
      exec: () => (runners.backlogTouch || runBacklog)({ settings, cwd, argv: baseArgv }),
    },
  ];

  if (!parsed.skipDownstream) {
    tasks.push({
      id: 'downstream-lag',
      title: '下游落後（開工手動跑）',
      exec: () => (runners.downstreamLag || runDownstream)({ settings, platform, root: cwd }),
    });
  }

  if (parsed.change !== undefined) {
    tasks.push(
      {
        id: 'stale-text',
        title: '舊文字掃描（K5）',
        exec: () => (runners.staleText || runStale)(baseArgv, { settings, cwd }),
      },
      {
        id: 'risk-tier',
        title: `合併前風險分級（D4｜變更 ${parsed.change}）`,
        exec: () => (runners.riskTier || runRisk)(parsed.change, { settings, platform, git: gitIn(cwd) }),
      },
    );
  }

  if (!parsed.skipSeats) {
    tasks.push({
      id: 'seats',
      title: '參與 AI 座位體檢（F11、G1）',
      exec: () => (runners.seats || checkSeats)(settings, { which, authFile, fsImpl }),
    });
  }

  const modeLabel = parsed.change !== undefined ? `送審前模式（變更 ${parsed.change}）` : '開工前模式';
  const lines = [`開工／送審前體檢總表｜${modeLabel}｜共 ${tasks.length} 項（唯讀、只列不擋）`];
  let overallCode = 0;
  const sections = [];

  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i];
    lines.push('', `=== [${i + 1}/${tasks.length}] ${t.title} ===`);
    let res;
    try {
      res = t.exec();
    } catch (e) {
      res = { code: 2, lines: [`${t.title}：未預期錯誤（${(e && e.message) || '不明'}）——算不出來。`] };
    }
    if (!res || typeof res.code !== 'number' || !Array.isArray(res.lines)) {
      res = { code: 2, lines: [`${t.title}：回傳格式不對——算不出來。`] };
    }
    if (res.code !== 0) overallCode = 2;
    lines.push(...res.lines);
    sections.push({ id: t.id, code: res.code, lines: res.lines });
  }

  return { code: overallCode, lines, sections };
}

if (require.main === module) {
  let result;
  try {
    result = run(process.argv.slice(2));
  } catch (e) {
    result = { code: 2, lines: [`體檢總表：沒預期到的錯誤（${(e && e.code) || (e && e.message) || '不明'}）——算不出來。`] };
  }
  process.exitCode = result.code;
  process.stdout.on('error', () => { process.exitCode = 2; });
  process.stdout.write(`${result.lines.join('\n')}\n`);
}

module.exports = { run, parseArgs, checkSeats, extractCommandSpec, defaultWhich, USAGE };
