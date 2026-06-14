import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSseBlock,
  extractDelta,
  renderMarkdown,
  buildMessageParts,
  normalizeSessionList,
  canStopRun,
  buildInputPayload,
  isApprovalEvent,
  defaultApiBase,
  nextActivityState,
  normalizeMessageList,
  parseWebCommand,
} from '../src/hermes_web_core.mjs';

test('run.completed output is not treated as a delta after streamed deltas', () => {
  const delta = parseSseBlock('event: assistant.delta\ndata: {"delta":"Hallo"}\n');
  assert.equal(extractDelta(delta.event, delta.data), 'Hallo');

  const completed = parseSseBlock('event: run.completed\ndata: {"output":"Hallo"}\n');
  assert.equal(extractDelta(completed.event, completed.data), '');
});

test('markdown renderer handles bold, lists, links and fenced code safely', () => {
  const html = renderMarkdown('**Hi**\n\n- one\n- two\n\n```js\n<bad>\n```\n[link](https://example.com)');
  assert.match(html, /<strong>Hi<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<pre><code class="language-js">&lt;bad&gt;\n<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/example.com"/);
  assert.doesNotMatch(html, /<bad>/);
});

test('message history normalizes OpenAI content arrays', () => {
  const parts = buildMessageParts([{ type: 'text', text: 'A' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }]);
  assert.equal(parts.text, 'A');
  assert.equal(parts.attachments.length, 1);
});

test('session lists normalize common API envelopes', () => {
  assert.deepEqual(normalizeSessionList({ sessions: [{ id: 'a' }] }).map(s => s.id), ['a']);
  assert.deepEqual(normalizeSessionList({ items: [{ session_id: 'b' }] }).map(s => s.id), ['b']);
});

test('run stop availability requires a run id', () => {
  assert.equal(canStopRun('run_1'), true);
  assert.equal(canStopRun(''), false);
  assert.equal(canStopRun(null), false);
});

test('image files become Responses-compatible multimodal content', async () => {
  const file = new File(['abc'], 'a.png', { type: 'image/png' });
  const payload = await buildInputPayload('describe', [file]);
  assert.equal(payload.input[0].role, 'user');
  assert.equal(payload.input[0].content[0].type, 'input_text');
  assert.equal(payload.input[0].content[1].type, 'input_image');
  assert.match(payload.input[0].content[1].image_url, /^data:image\/png;base64,/);
});

test('approval events are detected from event name and status payload', () => {
  assert.equal(isApprovalEvent('run.approval_required', {}), true);
  assert.equal(isApprovalEvent('message', { status: 'waiting_for_approval' }), true);
  assert.equal(isApprovalEvent('tool.started', { name: 'terminal' }), false);
});

test('default API base follows Caddy subpath deployments', () => {
  assert.equal(defaultApiBase('http://host.tail.ts.net/ziel/'), 'http://host.tail.ts.net/ziel/hermes');
  assert.equal(defaultApiBase('http://host.tail.ts.net/ziel/index.html'), 'http://host.tail.ts.net/ziel/hermes');
  assert.equal(defaultApiBase('http://host.tail.ts.net/'), 'http://host.tail.ts.net/hermes');
});

test('activity state tracks server, model, tools and completion', () => {
  let s = nextActivityState(undefined, 'run.started', { run_id: 'run_1' });
  assert.equal(s.phase, 'server');
  assert.equal(s.runId, 'run_1');
  assert.equal(s.busy, true);

  s = nextActivityState(s, 'message.started', {});
  assert.equal(s.phase, 'model');

  s = nextActivityState(s, 'assistant.delta', { delta: 'Hi' });
  assert.equal(s.phase, 'model');
  assert.equal(s.deltaCount, 1);

  s = nextActivityState(s, 'tool.progress', { tool_name: 'web_search' });
  assert.equal(s.phase, 'tool');
  assert.equal(s.toolName, 'web_search');

  s = nextActivityState(s, 'run.completed', {});
  assert.equal(s.phase, 'done');
  assert.equal(s.busy, false);
});


test('message lists normalize API list envelope data field', () => {
  const messages = normalizeMessageList({ object: 'list', data: [{ id: 1, role: 'user', content: 'hi' }] });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'hi');
});


test('web slash command parser handles model provider and new session', () => {
  assert.deepEqual(parseWebCommand('/model gpt-5.5 --provider openai-codex'), { command: 'model', model: 'gpt-5.5', provider: 'openai-codex', global: false });
  assert.deepEqual(parseWebCommand('/new Mobile Test'), { command: 'new', title: 'Mobile Test' });
  assert.equal(parseWebCommand('normale Frage'), null);
});
