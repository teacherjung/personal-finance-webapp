// @ts-check
// 只觀測公開邊界的選定欄位；不讀模型 contents、thoughts 或認證參數。
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isMainModule } from '../lib/is-main.js';

export const REVIEW_TOOLS = ['glob', 'grep_search', 'list_directory', 'read_file', 'replace', 'run_shell_command', 'write_file'];
export const TOOL_OUTPUT_CHARS = 12000;
const digest = value => createHash('sha256').update(value).digest('hex');

export function configObservation(config, expected) {
  const level = config.getModelConfigService().getResolvedConfig({ model: expected.model }).generateContentConfig.thinkingConfig?.thinkingLevel;
  const fields = {
    model: config.getModel(), thinkingLevel: level, trusted: config.isTrustedFolder(),
    coreTools: [...config.getCoreTools()].sort(), allowedMcp: config.getAllowedMcpServers(),
    mcpNoConfiguredMatch: !Object.hasOwn(config.getMcpServers() ?? {}, expected.sentinel),
    discoveryDisabled: !config.getToolDiscoveryCommand(), callDisabled: !config.getToolCallCommand(),
    mcpCommandDisabled: !config.getMcpServerCommand(), activeExtensions: config.getExtensions().filter(item => item.isActive).length,
    approvalMode: config.getApprovalMode(), extensionReloading: config.getEnableExtensionReloading(),
    hooks: config.getEnableHooks(), agents: config.isAgentsEnabled(), skills: config.isSkillsSupportEnabled(),
    autoMemory: config.isAutoMemoryEnabled(), includeDirectoryTree: config.getIncludeDirectoryTree(),
    loadIncludedMemory: config.shouldLoadMemoryFromIncludeDirectories(), outputFormat: config.getOutputFormat(),
    toolOutputChars: config.getTruncateToolOutputThreshold(),
  };
  assert.equal(fields.model, expected.model, '實際 Config 模型不符');
  assert.equal(fields.thinkingLevel, 'HIGH', '實際 Config 推理不符');
  assert.equal(fields.trusted, true, '實際 Config 未信任');
  assert.deepEqual(fields.coreTools, REVIEW_TOOLS, '實際 Config 工具不符');
  assert.ok(Array.isArray(fields.allowedMcp) && fields.allowedMcp.length === 1 && fields.allowedMcp[0] === expected.sentinel, '實際 MCP 排他名單不符');
  for (const key of ['mcpNoConfiguredMatch', 'discoveryDisabled', 'callDisabled', 'mcpCommandDisabled']) assert.equal(fields[key], true, `實際 Config ${key} 不符`);
  for (const key of ['hooks', 'agents', 'skills', 'autoMemory', 'includeDirectoryTree', 'loadIncludedMemory', 'extensionReloading']) assert.equal(fields[key], false, `實際 Config ${key} 不符`);
  assert.equal(fields.approvalMode, 'default', '實際 Config 授權模式不符');
  assert.equal(fields.activeExtensions, 0, '實際 Config 有啟用擴充');
  assert.equal(fields.outputFormat, 'json', '實際 Config 輸出格式不符');
  assert.ok(Number.isFinite(fields.toolOutputChars) && fields.toolOutputChars > 0 && fields.toolOutputChars <= TOOL_OUTPUT_CHARS, '實際工具輸出上限不符');
  return fields;
}

// 上限針對旁錄收到的資料；不宣稱原生 Shell 之前沒有裁切。
export function boundedText(value, bytes = 256 * 1024) {
  const data = Buffer.from(String(value ?? ''), 'utf8');
  return { text: data.length <= bytes ? data.toString('utf8') : data.subarray(0, bytes / 2).toString('utf8') + '\n[旁錄截短]\n' + data.subarray(-bytes / 2).toString('utf8'), bytes: data.length, sha256: digest(data), truncated: data.length > bytes };
}

export function eventWriter(file, binding, maxBytes = 32 * 1024 * 1024) {
  writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  let bytes = 0, sequence = 0;
  return (type, fields = {}) => {
    const line = JSON.stringify({ sequence: ++sequence, pid: process.pid, type, binding, ...fields }) + '\n';
    bytes += Buffer.byteLength(line);
    assert.ok(bytes <= maxBytes, '旁錄容量用完；本輪證據不完整');
    appendFileSync(file, line);
  };
}

export function installObserver(api, expected, writeEvent) {
  const undo = [];
  const configs = new WeakMap();
  let configSequence = 0, shellSequence = 0, fatal;
  const emit = (type, fields = {}) => {
    if (fatal) throw fatal;
    try { writeEvent(type, fields); }
    catch (error) { fatal = error; throw error; }
  };
  const wrap = (object, key, decorate) => {
    const original = object[key];
    assert.equal(typeof original, 'function', `原生觀測點 ${key} 缺失`);
    object[key] = decorate(original);
    undo.push(() => { object[key] = original; });
  };
  const check = (config, stage) => {
    if (fatal) throw fatal;
    try {
      const fields = configObservation(config, expected);
      if (!configs.has(config)) configs.set(config, { id: ++configSequence, stages: new Set() });
      const observed = configs.get(config); observed.stages.add(stage);
      emit('config', { configId: observed.id, stage, fields });
      return observed;
    } catch (error) { emit('guard_failure', { stage, message: error.message }); fatal = error; throw error; }
  };
  for (const method of ['refreshAuth', 'initialize']) wrap(api.Config.prototype, method, original => function (...args) {
    check(this, method);
    return original.apply(this, args);
  });
  for (const method of ['generateContent', 'generateContentStream']) wrap(api.LoggingContentGenerator.prototype, method, original => function (request, promptId, role) {
    try {
      if (fatal) throw fatal;
      const observed = configs.get(this.config);
      assert.ok(observed?.stages.has('refreshAuth') && observed.stages.has('initialize'), '主請求沒有同一正式 Config 的階段觀測');
      check(this.config, 'request');
      const tools = [...this.config.getToolRegistry().getAllToolNames()].sort();
      assert.deepEqual(tools, REVIEW_TOOLS, '正式工具 registry 不符');
      assert.ok(role === 'main' || role === 'utility_loop_detector', '請求角色未核實');
      if (role === 'main') {
        assert.equal(request.model, expected.model, '主審請求模型不符');
        assert.equal(request.config?.thinkingConfig?.thinkingLevel, 'HIGH', '主審請求推理不符');
      } else assert.ok([expected.model, 'gemini-3-flash-preview'].includes(request.model), '輔助請求模型不符');
      emit('request', { configId: observed.id, tools, method, role, model: request.model, thinkingLevel: request.config?.thinkingConfig?.thinkingLevel ?? null });
    } catch (error) { if (!fatal) emit('guard_failure', { stage: 'request', message: error.message }); fatal ??= error; throw error; }
    return original.call(this, request, promptId, role);
  });
  wrap(api.ChatRecordingService.prototype, 'recordToolCalls', original => function (model, calls) {
    for (const call of calls) emit('tool', {
      id: call.id, name: call.name, status: call.status,
      args: boundedText(JSON.stringify(call.args)), result: boundedText(JSON.stringify(call.result)),
    });
    return original.call(this, model, calls);
  });
  wrap(api.ShellExecutionService, 'execute', original => async function (...args) {
    const shellId = ++shellSequence;
    emit('shell_start', { shellId, command: boundedText(args[0]), cwd: args[1] });
    let started;
    try { started = await original.apply(this, args); }
    catch (error) { emit('shell_error', { shellId, message: boundedText(error.message) }); throw error; }
    // 先掛觀察者再交回同一物件／promise；旁錄錯誤鎖住後續請求，不製造未處理 rejection。
    started.result.then(result => {
      emit('shell_result', { shellId, shellPid: started.pid ?? null, exitCode: result.exitCode ?? null, signal: result.signal ?? null, aborted: result.aborted ?? null, backgrounded: result.backgrounded ?? false, output: boundedText(result.output), error: result.error ? boundedText(result.error.message) : null });
    }, error => { emit('shell_error', { shellId, message: boundedText(error.message) }); }).catch(error => { fatal ??= error; });
    return started;
  });
  emit('installed');
  return () => { for (const restore of undo.reverse()) restore(); };
}

if (isMainModule(import.meta.url)) console.log('Gemini runtime observer：由 scripts/gemini-review.js 的本輪預載器使用；直接驗證請跑 node --test test/gemini-runtime-observer.test.js。');
