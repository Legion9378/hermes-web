import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function setup() {
  const requests = [];
  const stored = new Map();
  const context = vm.createContext({
    state: { sessionId: '', model: 'test-model', sessions: [] },
    els: { sessionId: { value: 'old-session' }, sessionList: { appendChild() {}, textContent: '' } },
    localStorage: { setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) },
    apiFetch: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ session: { id: `new-${requests.length}` } }) };
    },
    saveSettings() { context.state.sessionId = context.els.sessionId.value; },
    setConnectionLabel() {}, loadSessions: async () => {}, clearMessages() {},
    addMessage() {}, closeSidebar() {}, loadMessages: async () => {},
    parseWebCommand: () => ({ command: 'new', title: '' }),
    document: { createElement: () => ({ querySelector: () => ({}), addEventListener: (_, cb) => { context.selectSession = cb; } }) },
  });
  for (const name of ['ensureSession', 'newSession', 'createNamedSession', 'handleWebCommand', 'renderSessions']) {
    const start = source.indexOf(`${name === 'renderSessions' ? '' : 'async '}function ${name}(`);
    const end = source.indexOf('\n}\n', start) + 3;
    // newSession is currently a single-line declaration.
    vm.runInContext(source.slice(start, name === 'newSession' ? source.indexOf('\n', start) : end), context);
  }
  return { context, requests };
}

test('automatic sessions leave unique IDs and titles to the server', async () => {
  const { context, requests } = setup();
  await context.ensureSession();
  context.state.sessionId = '';
  await context.ensureSession();
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert.equal(body.title, undefined);
    assert.equal(body.id, undefined);
    assert.equal(body.session_id, undefined);
  }
});

test('/new without a title does not reuse the default title', async () => {
  const { context, requests } = setup();
  await context.handleWebCommand('/new');
  assert.equal(requests[0].title, undefined);
});

test('explicit session titles are preserved', async () => {
  const { context, requests } = setup();
  await context.createNamedSession('My session');
  assert.equal(requests[0].title, 'My session');
});

test('new session clears the settings field so settings cannot restore the old ID', async () => {
  const { context } = setup();
  await context.newSession();
  context.saveSettings();
  assert.equal(context.state.sessionId, '');
  assert.equal(context.els.sessionId.value, '');
});

test('selecting a session synchronizes the settings field', async () => {
  const { context } = setup();
  context.state.sessions = [{ id: 'selected-session' }];
  context.renderSessions();
  await context.selectSession();
  context.saveSettings();
  assert.equal(context.state.sessionId, 'selected-session');
});
