import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import * as core from '../src/hermes_web_core.mjs';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const START = 'Ich sichere gerade den laufenden Company-Job und pausiere ihn für unseren Chat.';
const DONE = 'Der Company-Job ist gesichert und pausiert. Ich stehe dir jetzt voll zur Verfügung.';
function setup() {
  const elements = new Map(); const requests = []; const stored = new Map(); const activities = [];
  function element() {
    return { value: '', textContent: '', children: [], style: {}, dataset: {}, handlers: {},
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {}, addEventListener(event, fn) { this.handlers[event] = fn; },
      append(...children) { this.children.push(...children); }, appendChild(child) { this.children.push(child); },
      querySelector() { return null; }, focus() {} };
  }
  const context = vm.createContext({ ...core, crypto: { randomUUID }, TextDecoder, TextEncoder, console,
    location: { href: 'https://example.test/hermes/', origin: 'https://example.test' },
    localStorage: { getItem: k => stored.get(k), setItem: (k,v) => stored.set(k,v), removeItem: k => stored.delete(k) },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element },
  });
  // Execute the real frontend source, suppress only imports and automatic boot.
  vm.runInContext(source.replace(/^import[\s\S]*?from '\.\/hermes_web_core.mjs';/, '').split('boot().catch(')[0], context);
  vm.runInContext('globalThis.s = state; globalThis.e = els;', context);
  context.s.apiBase = 'https://example.test/hermes'; context.s.sessionId = 'session-a'; context.s.serverAuthAvailable = true;
  context.e.apiBase.value = context.s.apiBase; context.e.sessionId.value = context.s.sessionId;
  context.reply = () => stream([['run.completed', {}]]);
  context.apiFetch = async (path, options) => { requests.push({ path, ...options }); return context.reply(path, options); };
  context.loadSessions = async () => {}; context.loadMessages = async () => { context.historyReads = (context.historyReads || 0) + 1; };
  context.noteActivity = event => activities.push(event); context.speakAnswer = () => {};
  return { c: context, requests, stored, activities, elements };
}
function stream(events, fail = false) {
  const bytes = new TextEncoder().encode(events.map(([event,data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  let read = false;
  return { ok: true, body: { getReader: () => ({ async read() {
    if (!read) { read = true; return { value: bytes, done: false }; }
    if (fail) throw new Error('network lost'); return { done: true };
  } }) } };
}
const receipt = (submission, state, notices = []) => ({ ok: true, json: async () => ({ request_id: submission.requestId, state, notices }) });
async function failSend(c) { c.reply = () => { throw new Error('lost'); }; await assert.rejects(c.streamTurn('  original\n')); return c.currentSubmission(); }

test('real composer preserves whitespace; separate submissions use fresh UUIDs', async () => {
  const { c, requests, elements } = setup(); c.wireEvents();
  c.e.prompt.value = '  A\n '; await elements.get('composer').handlers.submit({ preventDefault() {} });
  c.e.prompt.value = 'B'; await elements.get('composer').handlers.submit({ preventDefault() {} });
  const bodies = requests.filter(r => r.method === 'POST').map(r => JSON.parse(r.body));
  assert.equal(bodies[0].message, '  A\n '); assert.notEqual(bodies[0].request_id, bodies[1].request_id);
  assert.match(bodies[0].request_id, /^[0-9a-f-]{36}$/);
});

test('uncertain send retains exact JSON and files in memory, never new persistence', async () => {
  const { c, stored } = setup(); const file = new File(['a'], 'a.png', { type: 'image/png' }); c.s.pendingFiles = [file];
  const submission = await failSend(c);
  assert.equal(submission.text, '  original\n'); assert.equal(submission.files[0], file);
  assert.equal(JSON.parse(submission.body).message[1].image_url, 'data:image/png;base64,YQ==');
  assert.equal(stored.size, 0); assert.equal(c.e.companyRetry.hidden, true);
});

test('explicit blocked retry rechecks receipt then resends byte-identical body and ID', async () => {
  const { c, requests } = setup(); const submission = await failSend(c); const original = submission.body;
  c.reply = path => path.includes('/receipts/') ? receipt(submission, 'blocked') : stream([['run.completed', {}]]);
  await c.reconcileSubmission(); assert.equal(c.e.companyRetry.hidden, false); await c.retrySubmission();
  const sends = requests.filter(r => r.method === 'POST'); assert.equal(sends.length, 2); assert.equal(sends[1].body, original);
  assert.equal(c.e.messages.children.filter(el => el.className === 'message user').length, 1);
});

for (const state of ['claimed', 'uncertain', 'waiting', 'admitted', 'completed']) {
  test(`receipt ${state} never replays`, async () => {
    const { c, requests } = setup(); const submission = await failSend(c);
    c.reply = () => receipt(submission, state); await c.reconcileSubmission(); await c.retrySubmission();
    assert.equal(requests.filter(r => r.method === 'POST').length, 1);
    if (state === 'completed') { assert.equal(c.historyReads, 1); assert.equal(submission.body, ''); }
    else assert.notEqual(submission.body, '');
  });
}

test('stale blocked retry is cancelled if receipt becomes claimed', async () => {
  const { c, requests } = setup(); const submission = await failSend(c);
  c.reply = () => receipt(submission, 'blocked'); await c.reconcileSubmission();
  c.reply = () => receipt(submission, 'claimed'); await c.retrySubmission();
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
});

test('old/disabled receipt 404 retains uncertain input; successful ordinary chat needs no receipt', async () => {
  const { c, requests } = setup(); const submission = await failSend(c);
  c.reply = () => ({ ok: false, status: 404 }); await c.reconcileSubmission();
  assert.equal(submission.status, 'uncertain'); assert.notEqual(submission.body, '');
  const ordinary = setup(); await ordinary.c.streamTurn('normal');
  assert.equal(ordinary.c.currentSubmission(), undefined); assert.equal(ordinary.requests.length, 1);
});

test('typed Company notices are scoped, bounded and absent from transcript and model body', async () => {
  const { c, requests, activities } = setup();
  c.reply = (_, options) => { const id = JSON.parse(options.body).request_id; return stream([
    ['company.status', { kind: 'company', request_id: id, text: START }],
    ['company.status', { kind: 'company', request_id: 'wrong', text: DONE }],
    ['company.status', { kind: 'company', request_id: id, text: DONE }],
    ['assistant.delta', { delta: 'answer' }], ['run.completed', {}],
  ]); };
  await c.streamTurn('question'); assert.equal(c.e.companyText.textContent, DONE);
  assert.equal(c.e.activityBar.children.length, 1); assert.equal(activities.includes('company.status'), false);
  assert.equal(c.e.messages.children.some(el => el.textContent.includes(START) || el.textContent.includes(DONE)), false);
  assert.equal(requests[0].body.includes(START), false);
});

test('EOF without completion and HTTP refusal preserve original', async () => {
  for (const reply of [() => stream([['assistant.delta', { delta: 'partial' }]]), () => ({ ok: false, status: 503 })]) {
    const { c } = setup(); c.reply = reply; await assert.rejects(c.streamTurn('keep'));
    assert.equal(c.currentSubmission().text, 'keep'); assert.equal(c.currentSubmission().status, 'uncertain');
  }
});

test('session/API/auth revision scopes prevent reconciliation against another identity', async () => {
  const { c, requests } = setup(); const submission = await failSend(c);
  for (const [field, value] of [['sessionId','other'], ['apiBase','https://other.test'], ['authRevision',1]]) {
    const old = c.s[field]; c.s[field] = value; assert.equal(c.currentSubmission(), undefined);
    await c.reconcileSubmission(submission); assert.equal(requests.length, 1); c.s[field] = old;
  }
});

test('completed receipt with failed history retains original and cannot replay', async () => {
  const { c, requests } = setup(); const submission = await failSend(c);
  c.reply = () => receipt(submission, 'completed');
  c.loadMessages = async () => { throw new Error('history unavailable'); };
  await c.reconcileSubmission(); await c.retrySubmission();
  assert.equal(submission.status, 'uncertain'); assert.notEqual(submission.body, '');
  assert.equal(requests.filter(r => r.method === 'POST').length, 1);
});

test('actual settings update changes auth scope without persisting recovery content', async () => {
  const { c, stored } = setup(); const submission = await failSend(c);
  c.e.apiBase.value = 'https://other.test/profile'; c.saveSettings();
  assert.equal(c.currentSubmission(), undefined); assert.equal(c.s.authRevision, 1);
  assert.equal([...stored.values()].some(value => String(value).includes(submission.text)), false);
});

test('composer blocks accidental new send while retained submission unresolved', async () => {
  const { c, requests, elements } = setup(); await failSend(c); c.wireEvents(); c.e.prompt.value = 'changed';
  await elements.get('composer').handlers.submit({ preventDefault() {} });
  assert.equal(requests.length, 1); assert.equal(c.e.prompt.value, 'changed');
});
