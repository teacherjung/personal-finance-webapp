#!/usr/bin/env node
// @ts-check
// 資格驗證與本人啟用確認缺一不可；入口不以環境或呼叫參數代替這兩份證據。
import { isMainModule } from '../lib/is-main.js';

export const GEMINI_REVIEW_CANDIDATE = Object.freeze({
  participant: 'Gemini',
  source: 'Antigravity CLI',
  model: 'gemini-4-argon-high',
  effort: 'high',
  version: '1.3.5',
  binarySha256: 'ebd71c4db14f79fca3fd0160332a38d9037146737422dcfc1f1d21ba01a13fff',
  enabled: false,
  qualification: 'not-passed',
});

/** @returns {never} */
export function runGeminiReview() {
  throw Error('GEMINI_REVIEW_NOT_ENABLED: CLI 工具權限資格尚未通過，且正式啟用須由本人另行確認。');
}

if (isMainModule(import.meta.url)) {
  try { runGeminiReview(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'GEMINI_REVIEW_NOT_ENABLED');
    process.exitCode = 78;
  }
}
