// @ts-check
// HTTP 入口與上游都換成禁網替身；這裡不讀正式登入檔，也不發模型請求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import * as relay from '../scripts/grok-relay.js';

const prefix = '[relay] diagnostic: ';
const event = { route: 'responses', status: 429, phase: 'complete', error: 'none' };

test('固定診斷拒收額外欄位、未知值及超量，不回顯候選文字', () => {
  const decode = relay.summarizeRelayDiagnostics;
  const line = prefix + JSON.stringify(event) + '\n';
  assert.deepEqual(decode(line), { valid: true, events: 1, groups: [{ ...event, count: 1 }] });
  for (const bad of [
    { ...event, url: 'PRIVATE-SENTINEL' }, { ...event, route: 'PRIVATE-SENTINEL' },
    { ...event, status: '429' }, { ...event, status: 999 }, { ...event, status: 200.5 },
    { ...event, phase: 'PRIVATE-SENTINEL' }, { ...event, error: 'PRIVATE-SENTINEL' },
    { ...event, phase: 'interrupted', error: 'PRIVATE-SENTINEL' },
    { ...event, status: null, phase: 'headers' }, { ...event, error: 'timeout' },
    null, [],
  ]) {
    const result = decode(prefix + JSON.stringify(bad) + '\n');
    assert.equal(result.valid, false);
    assert.ok(!JSON.stringify(result).includes('PRIVATE-SENTINEL'));
  }
  assert.equal(decode(prefix + 'PRIVATE-SENTINEL\n').valid, false);
  assert.equal(decode(line.repeat(relay.MAX_DIAGNOSTIC_EVENTS)).valid, true);
  assert.equal(decode(line.repeat(relay.MAX_DIAGNOSTIC_EVENTS + 1)).valid, false);
  assert.equal(decode('x'.repeat(1024 * 1024 + 1)).valid, false);
});

test('正式轉送入口只輸出允許路由分類與 HTTP 狀態，內容與 session 不進診斷', (t) => {
  /** @type {any} */ let handle;
  /** @type {any} */ let receive;
  /** @type {any} */ let upstream;
  const rows = [];
  let requests = 0;
  const server = Object.assign(new EventEmitter(), { listen: () => {} });
  t.mock.method(http, 'createServer', (/** @type {any} */ fn) => { handle = fn; return server; });
  t.mock.method(https, 'request', (/** @type {any} */ _options, /** @type {any} */ fn) => {
    requests++; receive = fn; upstream = Object.assign(new EventEmitter(), { destroy: () => {} }); return upstream;
  });
  t.mock.method(process.stderr, 'write', (/** @type {any} */ line) => { rows.push(String(line)); return true; });
  relay.startRelay(0);
  const routes = [
    ['GET', '/v1/models', 'models'], ['GET', '/v1/settings', 'settings'],
    ['GET', '/v1/feedback/config', 'feedback'], ['POST', '/v1/responses', 'responses'],
    ['POST', '/v1/sessions/12345678-1234-1234-1234-123456789012/signals', 'signals'],
    ['POST', '/v1/sessions/12345678-1234-1234-1234-123456789012/turn-deltas', 'turn-deltas'],
    ['POST', '/v1/traces', 'traces'],
  ];
  for (const [method, url, route] of routes) {
    const req = Object.assign(new EventEmitter(), { method, url: url + '?PRIVATE-QUERY', headers: { authorization: 'PRIVATE-AUTH' }, pipe: () => {} });
    const res = Object.assign(new EventEmitter(), { writeHead: () => {}, end: () => {} });
    handle(req, res);
    const response = Object.assign(new EventEmitter(), { statusCode: 429, headers: { secret: 'PRIVATE-HEADER' }, pipe: () => {} });
    receive(response);
    response.emit('data', Buffer.from('PRIVATE-BODY'));
    response.emit('end'); response.emit('close'); upstream.emit('close');
    const parsed = relay.summarizeRelayDiagnostics(rows.slice(-2).join(''));
    assert.deepEqual(parsed, { valid: true, events: 2, groups: [
      { route, status: 429, phase: 'headers', error: 'none', count: 1 },
      { route, status: 429, phase: 'complete', error: 'none', count: 1 },
    ] });
  }
  assert.equal(requests, routes.length);
  assert.ok(!rows.join('').includes('PRIVATE-'));
  assert.ok(!rows.join('').includes('12345678-1234'));
});

test('正式轉送錯誤只記白名單類別，中斷重複事件只收一次', (t) => {
  /** @type {any} */ let handle;
  /** @type {any} */ let receive;
  /** @type {any} */ let upstream;
  const rows = [];
  t.mock.method(http, 'createServer', (/** @type {any} */ fn) => { handle = fn; return Object.assign(new EventEmitter(), { listen: () => {} }); });
  t.mock.method(https, 'request', (/** @type {any} */ _options, /** @type {any} */ fn) => {
    receive = fn; upstream = Object.assign(new EventEmitter(), { destroy: () => {} }); return upstream;
  });
  t.mock.method(process.stderr, 'write', (/** @type {any} */ line) => { rows.push(String(line)); return true; });
  relay.startRelay(0);
  const begin = () => handle(Object.assign(new EventEmitter(), { method: 'POST', url: '/v1/responses', headers: {}, pipe: () => {} }), Object.assign(new EventEmitter(), { writeHead: () => {}, end: () => {} }));
  for (const [code, error] of [['ECONNRESET', 'reset'], ['ETIMEDOUT', 'timeout'], ['ENOTFOUND', 'dns'], ['ECONNREFUSED', 'refused'], ['CERT_HAS_EXPIRED', 'tls'], ['PRIVATE-CODE', 'other']]) {
    rows.length = 0; begin();
    upstream.emit('error', Object.assign(new Error('PRIVATE-MESSAGE'), { code }));
    upstream.emit('close');
    assert.deepEqual(relay.summarizeRelayDiagnostics(rows.join('')), { valid: true, events: 1, groups: [{ route: 'responses', status: null, phase: 'interrupted', error, count: 1 }] });
    assert.ok(!rows.join('').includes('PRIVATE-'));
  }
  rows.length = 0; begin();
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, pipe: () => {} });
  receive(response); response.emit('aborted'); response.emit('close'); upstream.emit('close');
  assert.deepEqual(relay.summarizeRelayDiagnostics(rows.join('')), { valid: true, events: 2, groups: [
    { route: 'responses', status: 200, phase: 'headers', error: 'none', count: 1 },
    { route: 'responses', status: 200, phase: 'interrupted', error: 'other', count: 1 },
  ] });
});
