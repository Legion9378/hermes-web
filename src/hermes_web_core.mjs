export function defaultApiBase(currentHref) {
  return new URL('hermes', currentHref).href.replace(/\/+$/, '');
}

export function nextActivityState(prev = {}, event = '', data = {}) {
  const now = Date.now();
  const state = {
    phase: prev.phase || 'idle',
    busy: prev.busy || false,
    runId: prev.runId || null,
    toolName: prev.toolName || '',
    deltaCount: prev.deltaCount || 0,
    eventCount: (prev.eventCount || 0) + 1,
    lastEvent: event,
    lastEventAt: now,
    error: '',
  };
  if (data?.run_id) state.runId = data.run_id;
  if (event === 'run.started') { state.phase = 'server'; state.busy = true; }
  else if (event === 'message.started') { state.phase = 'model'; state.busy = true; }
  else if (event.includes('delta')) { state.phase = 'model'; state.busy = true; state.deltaCount += 1; }
  else if (event.includes('tool') || event.includes('function')) {
    state.phase = 'tool'; state.busy = true; state.toolName = data?.tool_name || data?.name || data?.tool || data?.function?.name || state.toolName || 'Tool';
  } else if (event.includes('approval')) { state.phase = 'approval'; state.busy = true; }
  else if (event === 'assistant.completed') { state.phase = 'server'; state.busy = true; }
  else if (event === 'run.completed' || event === 'done') { state.phase = 'done'; state.busy = false; }
  else if (event.includes('error')) { state.phase = 'error'; state.busy = false; state.error = typeof data === 'string' ? data : (data?.error || JSON.stringify(data || {})); }
  return state;
}

export function parseSseBlock(block) {
  const lines = String(block || '').split('\n');
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  const raw = dataLines.join('\n');
  if (!raw) return { event, data: null };
  try { return { event, data: JSON.parse(raw) }; }
  catch { return { event, data: raw }; }
}

export function extractDelta(event, data) {
  if (!data) return '';
  const ev = String(event || '');
  const isDelta = ev.includes('delta') || ev === 'assistant.delta' || ev === 'response.output_text.delta';
  if (!isDelta) return '';
  if (typeof data === 'string') return data;
  return data.delta || data.text || data.content || data.output_text_delta || '';
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url, 'https://example.invalid');
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return url;
  } catch {}
  return '#';
}

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => `<a href="${escapeHtml(sanitizeUrl(url))}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  return out;
}

export function renderMarkdown(markdown) {
  const source = String(markdown || '').replace(/\r\n/g, '\n');
  const parts = [];
  let cursor = 0;
  const fence = /```([\w.+-]*)\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(source))) {
    parts.push({ type: 'md', value: source.slice(cursor, match.index) });
    parts.push({ type: 'code', lang: match[1] || '', value: match[2] });
    cursor = fence.lastIndex;
  }
  parts.push({ type: 'md', value: source.slice(cursor) });

  return parts.map(part => {
    if (part.type === 'code') {
      const cls = part.lang ? ` class="language-${escapeHtml(part.lang)}"` : '';
      return `<pre><code${cls}>${escapeHtml(part.value)}</code></pre>`;
    }
    const blocks = part.value.split(/\n{2,}/).filter(Boolean);
    return blocks.map(block => {
      const lines = block.split('\n');
      if (lines.every(l => /^\s*[-*]\s+/.test(l))) {
        return `<ul>${lines.map(l => `<li>${renderInline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }
      if (lines.every(l => /^\s*\d+\.\s+/.test(l))) {
        return `<ol>${lines.map(l => `<li>${renderInline(l.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
      }
      return `<p>${lines.map(renderInline).join('<br>')}</p>`;
    }).join('');
  }).join('');
}

export function buildMessageParts(content) {
  if (typeof content === 'string') return { text: content, attachments: [] };
  if (!Array.isArray(content)) return { text: String(content ?? ''), attachments: [] };
  const text = [];
  const attachments = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') text.push(part.text || '');
    else if (part.type === 'image_url') attachments.push({ type: 'image', url: part.image_url?.url || part.image_url });
    else if (part.type === 'input_image') attachments.push({ type: 'image', url: part.image_url });
    else attachments.push({ type: part.type || 'attachment', value: part });
  }
  return { text: text.join('\n'), attachments };
}

export function normalizeSessionList(data) {
  const raw = Array.isArray(data) ? data : (data?.sessions || data?.items || data?.data || []);
  return raw.map(item => ({ ...item, id: item.id || item.session_id }));
}

export function normalizeMessageList(data) {
  return Array.isArray(data) ? data : (data?.messages || data?.items || data?.data || []);
}

export function parseWebCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  const command = (parts.shift() || '').slice(1).toLowerCase();
  if (command === 'help' || command === '?') return { command: 'help' };
  if (command === 'status') return { command: 'status' };
  if (command === 'new' || command === 'reset') return { command: 'new', title: parts.join(' ').trim() };
  if (command === 'model') {
    let provider = '';
    let global = false;
    const modelParts = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      if (part === '--provider' || part === '-p') { provider = parts[i + 1] || ''; i += 1; continue; }
      if (part === '--global') { global = true; continue; }
      modelParts.push(part);
    }
    return { command: 'model', model: modelParts.join(' ').trim(), provider, global };
  }
  return { command: 'unknown', name: command, raw };
}

export function canStopRun(runId) {
  return typeof runId === 'string' && runId.trim().length > 0;
}

async function fileToDataUrl(file) {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Datei konnte nicht gelesen werden'));
      reader.readAsDataURL(file);
    });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  return `data:${file.type || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
}

export async function buildInputPayload(text, files = []) {
  const content = [{ type: 'input_text', text }];
  for (const file of files) {
    const url = await fileToDataUrl(file);
    if (file.type.startsWith('image/')) content.push({ type: 'input_image', image_url: url });
    else content.push({ type: 'input_text', text: `\n[Datei angehängt: ${file.name}, ${file.type || 'unknown'}, ${file.size} bytes]\n${url}` });
  }
  return { input: [{ role: 'user', content }] };
}

export function isApprovalEvent(event, data) {
  const ev = String(event || '').toLowerCase();
  if (ev.includes('approval')) return true;
  const status = String(data?.status || data?.type || '').toLowerCase();
  return status.includes('approval') || status.includes('awaiting_human') || status.includes('pending_approval');
}

export function extractToolEvent(event, data) {
  const marker = `${event} ${typeof data === 'string' ? data : JSON.stringify(data || {})}`.toLowerCase();
  if (!marker.includes('tool') && !marker.includes('function')) return null;
  if (typeof data === 'string') return { title: event, body: data };
  return {
    title: data?.name || data?.tool || data?.function?.name || data?.type || event,
    body: JSON.stringify(data || {}, null, 2),
    callId: data?.call_id || data?.id,
  };
}
