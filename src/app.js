import {
  parseSseBlock,
  extractDelta,
  renderMarkdown,
  buildMessageParts,
  normalizeSessionList,
  normalizeMessageList,
  canStopRun,
  buildInputPayload,
  isApprovalEvent,
  nextActivityState,
  parseWebCommand,
  defaultApiBase,
  escapeHtml,
} from './hermes_web_core.mjs';

const $ = (id) => document.getElementById(id);
const DEFAULT_API_BASE = defaultApiBase(location.href);

const state = {
  apiBase: localStorage.getItem('hermes.apiBase') || DEFAULT_API_BASE,
  apiKey: localStorage.getItem('hermes.apiKey') || '',
  serverAuthAvailable: false,
  autoSpeak: localStorage.getItem('hermes.autoSpeak') !== 'false',
  speechEnabled: false,
  sessionId: localStorage.getItem('hermes.sessionId') || '',
  model: localStorage.getItem('hermes.model') || '',
  provider: localStorage.getItem('hermes.provider') || '',
  busy: false,
  activeRunId: null,
  sessions: [],
  modelInventory: [],
  pendingFiles: [],
  pendingApproval: null,
  assistantBuffer: '',
  activity: { phase: 'idle', busy: false, eventCount: 0, deltaCount: 0, lastEvent: '', lastEventAt: null },
};

const els = {
  messages: $('messages'), prompt: $('prompt'), sendButton: $('sendButton'), stopButton: $('stopButton'),
  connectionLabel: $('connectionLabel'), menuModelLabel: $('menuModelLabel'), settingsPanel: $('settingsPanel'), sidebar: $('sidebar'), scrim: $('scrim'),
  apiBase: $('apiBase'), apiKey: $('apiKey'), serverAuthHint: $('serverAuthHint'), autoSpeak: $('autoSpeak'), stopSpeechButton: $('stopSpeechButton'), sessionId: $('sessionId'), model: $('modelName'), provider: $('providerName'), modelFilter: $('modelFilter'), modelPickerMeta: $('modelPickerMeta'), sessionList: $('sessionList'),
  fileInput: $('fileInput'), attachButton: $('attachButton'), attachmentTray: $('attachmentTray'), approvalBar: $('approvalBar'),
  approvalText: $('approvalText'), approveButton: $('approveButton'), denyButton: $('denyButton'),
  activityBar: $('activityBar'), activityPhase: $('activityPhase'), activityDetail: $('activityDetail'), activityMetrics: $('activityMetrics'),
};

function normalizeBase(url) { return ((url || '').trim().replace(/\/+$/, '')) || DEFAULT_API_BASE; }
function safeHostLabel(url) { try { const p = new URL(url, location.origin); return p.host + p.pathname.replace(/\/$/, ''); } catch { return 'URL prüfen'; } }
function providerLabelFor(slug) {
  const provider = state.modelInventory.find(p => (p.slug || p.provider || p.id) === slug);
  return provider?.name || provider?.label || slug || '';
}
function modelStatusLabel() {
  const provider = providerLabelFor(state.provider);
  if (provider && state.model) return `${provider} · ${state.model}`;
  if (provider) return provider;
  if (state.model) return state.model;
  return '';
}
function setConnectionLabel(text) {
  const status = modelStatusLabel();
  const fallback = `${safeHostLabel(state.apiBase)}${state.sessionId ? ' · ' + state.sessionId.slice(0, 12) : ''}`;
  const label = text || status || fallback;
  els.connectionLabel.textContent = label;
  if (els.menuModelLabel) els.menuModelLabel.textContent = status || safeHostLabel(state.apiBase);
}
function setBusy(busy) { state.busy = busy; els.sendButton.disabled = busy; els.stopButton.disabled = !busy; els.sendButton.textContent = busy ? 'Läuft…' : 'Senden'; }
function activityLabel(activity) {
  if (activity.phase === 'server') return ['Server', activity.lastEvent === 'run.started' ? 'Run gestartet; warte auf Modell…' : 'Server verarbeitet…'];
  if (activity.phase === 'model') return ['Modell', 'Modell streamt Antwort…'];
  if (activity.phase === 'tool') return ['Tool', `${activity.toolName || 'Tool'} läuft serverseitig…`];
  if (activity.phase === 'approval') return ['Approval', 'Warte auf deine Freigabe…'];
  if (activity.phase === 'done') return ['Fertig', 'Run abgeschlossen'];
  if (activity.phase === 'error') return ['Fehler', activity.error || 'Fehler im Stream'];
  return ['Bereit', 'Keine laufende Anfrage'];
}
function renderActivity() {
  const [phase, detail] = activityLabel(state.activity);
  els.activityPhase.textContent = phase;
  els.activityDetail.textContent = detail + (state.activity.lastEvent ? ` · ${state.activity.lastEvent}` : '');
  els.activityMetrics.textContent = `Events: ${state.activity.eventCount || 0} · Δ: ${state.activity.deltaCount || 0}${state.activity.runId ? ' · ' + state.activity.runId.slice(0, 10) : ''}`;
  els.activityBar.className = `activity-bar ${state.activity.phase || 'idle'} ${state.activity.busy ? 'busy' : ''}`;
}
function noteActivity(event, data = {}) {
  state.activity = nextActivityState(state.activity, event, data || {});
  renderActivity();
}
function resetActivity(label = 'Bereit') {
  state.activity = { phase: 'idle', busy: false, eventCount: 0, deltaCount: 0, lastEvent: '', lastEventAt: null };
  renderActivity();
  if (label) els.activityDetail.textContent = label;
}
function hasAuth() { return Boolean(state.apiKey || state.serverAuthAvailable); }
function authHeaders(extra = {}) { return state.apiKey ? { 'Authorization': `Bearer ${state.apiKey}`, ...extra } : { ...extra }; }

async function loadBootstrap() {
  try {
    const root = new URL('.', location.href).href.replace(/\/+$/, '');
    const res = await fetch(`${root}/__hermes_web/bootstrap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) return;
    const data = await res.json();
    state.serverAuthAvailable = Boolean(data.server_auth_available);
    if (state.serverAuthAvailable && !localStorage.getItem('hermes.apiBase')) state.apiBase = normalizeBase(data.api_base || DEFAULT_API_BASE);
    if (els.serverAuthHint) els.serverAuthHint.textContent = state.serverAuthAvailable ? 'Server-Key aktiv: Diese PWA kann ohne erneute Token-Eingabe über den lokalen Proxy arbeiten.' : 'Kein Server-Key erkannt; Token wird lokal im Browser gespeichert.';
  } catch (err) {
    console.warn('Bootstrap unavailable', err);
  }
}

function renderMessageContent(el, text) {
  el.innerHTML = renderMarkdown(text || '');
}

function addMessage(role, text = '', options = {}) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  if (options.html) el.innerHTML = options.html;
  else if (role === 'assistant') renderMessageContent(el, text);
  else el.textContent = text;
  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
  return el;
}

function addToolCard(tool) {
  const details = document.createElement('details');
  details.className = 'tool-card';
  const summary = document.createElement('summary');
  summary.textContent = tool.title || 'Tool Event';
  const pre = document.createElement('pre');
  pre.textContent = tool.body || '';
  details.append(summary, pre);
  els.messages.appendChild(details);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function clearMessages() { els.messages.textContent = ''; }

function saveSettings() {
  state.apiBase = normalizeBase(els.apiBase.value);
  state.apiKey = els.apiKey.value.trim() || state.apiKey;
  state.sessionId = els.sessionId.value.trim();
  state.model = els.model?.value.trim() || '';
  state.provider = els.provider?.value.trim() || '';
  localStorage.setItem('hermes.apiBase', state.apiBase);
  localStorage.setItem('hermes.apiKey', state.apiKey);
  localStorage.setItem('hermes.sessionId', state.sessionId);
  if (state.model) localStorage.setItem('hermes.model', state.model); else localStorage.removeItem('hermes.model');
  if (state.provider) localStorage.setItem('hermes.provider', state.provider); else localStorage.removeItem('hermes.provider');
  setConnectionLabel(); renderSessions();
}
function openSettings() { els.apiBase.value = state.apiBase; els.apiKey.value = state.apiKey; els.sessionId.value = state.sessionId; if (els.autoSpeak) els.autoSpeak.checked = state.autoSpeak; if (els.serverAuthHint) els.serverAuthHint.textContent = state.serverAuthAvailable ? 'Server-Key aktiv: keine erneute Token-Eingabe nötig.' : 'Kein Server-Key erkannt; API Token wird im Browser gespeichert.'; if (els.model) els.model.value = state.model; if (els.provider) els.provider.value = state.provider; els.settingsPanel.classList.add('open'); els.settingsPanel.setAttribute('aria-hidden', 'false'); els.scrim.classList.add('open'); }
function closeSettings() { els.settingsPanel.classList.remove('open'); els.settingsPanel.setAttribute('aria-hidden', 'true'); if (!els.sidebar.classList.contains('open')) els.scrim.classList.remove('open'); }
function openSidebar() { els.sidebar.classList.add('open'); els.scrim.classList.add('open'); }
function closeSidebar() { els.sidebar.classList.remove('open'); if (!els.settingsPanel.classList.contains('open')) els.scrim.classList.remove('open'); }

async function apiFetch(path, options = {}) {
  if (!hasAuth()) throw new Error('API Token fehlt und kein Server-Key ist aktiv. Öffne ⚙ und trage API_SERVER_KEY ein.');
  return fetch(`${state.apiBase}${path}`, { ...options, headers: authHeaders(options.headers || {}) });
}

async function webControl(path, payload = {}) {
  if (!hasAuth()) throw new Error('API Token fehlt und kein Server-Key ist aktiv. Öffne ⚙ und trage API_SERVER_KEY ein.');
  const root = new URL('.', location.href).href.replace(/\/+$/, '');
  return fetch(`${root}/__hermes_web${path}`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
}

function providerDisplay(provider) {
  const name = provider.name || provider.label || provider.slug || provider.id || 'Provider';
  const count = provider.total_models ?? (provider.models || []).length;
  return `${name} (${count})`;
}

function selectedProviderEntry() {
  const slug = els.provider?.value || state.provider;
  return state.modelInventory.find(p => (p.slug || p.provider || p.id) === slug) || state.modelInventory[0] || null;
}

function renderModelOptions() {
  if (!els.model) return;
  const provider = selectedProviderEntry();
  els.model.textContent = '';
  const models = provider?.models || [];
  const needle = (els.modelFilter?.value || '').trim().toLowerCase();
  const filtered = models.filter(m => String(m).toLowerCase().includes(needle)).slice(0, 500);
  for (const model of filtered) {
    const opt = document.createElement('option');
    opt.value = String(model); opt.textContent = String(model);
    if (String(model) === state.model) opt.selected = true;
    els.model.appendChild(opt);
  }
  if (filtered.length && !els.model.value) els.model.value = filtered[0];
  if (els.modelPickerMeta) {
    const slug = provider?.slug || provider?.provider || provider?.id || '';
    els.modelPickerMeta.textContent = provider ? `${providerDisplay(provider)} · ${filtered.length}/${models.length} angezeigt · ${slug}` : 'Keine Provider geladen.';
  }
}

function renderModelProviders() {
  if (!els.provider) return;
  els.provider.textContent = '';
  const current = state.provider || state.modelInventory.find(p => p.is_current)?.slug || state.modelInventory[0]?.slug || '';
  for (const provider of state.modelInventory) {
    const slug = provider.slug || provider.provider || provider.id;
    const opt = document.createElement('option');
    opt.value = slug; opt.textContent = providerDisplay(provider);
    if (slug === current) opt.selected = true;
    els.provider.appendChild(opt);
  }
  state.provider = els.provider.value || state.provider;
  renderModelOptions();
}

async function loadModelInventory(refresh = false) {
  const res = await webControl('/models', { refresh });
  const text = await res.text();
  if (!res.ok) throw new Error(`Modelle nicht ladbar: HTTP ${res.status} ${text}`);
  const data = JSON.parse(text);
  state.modelInventory = data.providers || [];
  state.provider = data.provider || state.provider || state.modelInventory.find(p => p.is_current)?.slug || '';
  state.model = data.model || state.model || '';
  if (state.provider) localStorage.setItem('hermes.provider', state.provider);
  if (state.model) localStorage.setItem('hermes.model', state.model);
  renderModelProviders();
  setConnectionLabel();
  return state.modelInventory;
}

async function openModelPicker(refresh = false) {
  openSettings();
  if (els.modelPickerMeta) els.modelPickerMeta.textContent = 'Lade Provider-/Modellliste…';
  await loadModelInventory(refresh);
  addMessage('system', `Modellauswahl geladen: ${state.modelInventory.length} Provider. Provider wählen, Modell suchen/markieren, dann „Modell setzen“.`);
}

async function testConnection() {
  saveSettings();
  try { const res = await apiFetch('/health'); if (!res.ok) throw new Error(`HTTP ${res.status}`); addMessage('system', 'Verbindung zur Hermes API funktioniert.'); closeSettings(); }
  catch (err) { addMessage('error', `Verbindung fehlgeschlagen: ${err.message || err}`); }
}

async function ensureSession() {
  if (state.sessionId) return state.sessionId;
  const res = await apiFetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Hermes Web' }) });
  if (!res.ok) throw new Error(`Session konnte nicht erstellt werden: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  state.sessionId = data.id || data.session_id || data.session?.id;
  if (!state.sessionId) throw new Error('API-Antwort enthielt keine Session-ID.');
  localStorage.setItem('hermes.sessionId', state.sessionId); els.sessionId.value = state.sessionId; setConnectionLabel();
  await loadSessions(false).catch(() => {});
  return state.sessionId;
}

async function newSession() { saveSettings(); state.sessionId = ''; localStorage.removeItem('hermes.sessionId'); clearMessages(); addMessage('system', 'Neue Hermes-Session. Die Session wird beim ersten Senden erstellt.'); setConnectionLabel(); renderSessions(); closeSidebar(); }

async function createNamedSession(title = 'Hermes Web') {
  saveSettings();
  const res = await apiFetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title || 'Hermes Web', model: state.model || undefined }) });
  if (!res.ok) throw new Error(`Session konnte nicht erstellt werden: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  state.sessionId = data.id || data.session_id || data.session?.id;
  if (!state.sessionId) throw new Error('API-Antwort enthielt keine Session-ID.');
  localStorage.setItem('hermes.sessionId', state.sessionId);
  els.sessionId.value = state.sessionId;
  clearMessages(); addMessage('system', `Neue Session erstellt: ${state.sessionId}`); setConnectionLabel(); await loadSessions(false).catch(() => {});
}

function showWebHelp() {
  addMessage('system', `/help · /status · /new [Titel] · /model · /model <modell> [--provider <provider>]\nBeispiel: /model gpt-5.5 --provider openai-codex\nHinweis: Vollständige CLI-/Gateway-Slashcommands laufen nicht 1:1 über den API Server; diese Web-Kommandos werden lokal vom WebUI behandelt.`);
}

async function showStatus() {
  const res = await apiFetch('/v1/capabilities');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const cap = await res.json();
  addMessage('system', `API: ${safeHostLabel(state.apiBase)}\nSession: ${state.sessionId || '(keine)'}\nWebUI-Modell: ${state.model || '(Gateway-Default)'}\nProvider: ${state.provider || '(Gateway-Default)'}\nAPI-Modellname: ${cap.model || '(unbekannt)'}`);
}

async function setRemoteModel(model, provider = '') {
  if (!model && !provider) {
    await openModelPicker(false);
    return;
  }
  const res = await webControl('/model', { model, provider });
  const text = await res.text();
  if (!res.ok) throw new Error(`Modellwechsel fehlgeschlagen: HTTP ${res.status} ${text}`);
  const data = JSON.parse(text);
  state.model = data.model || model || state.model;
  state.provider = data.provider || provider || state.provider;
  if (els.model) els.model.value = state.model;
  if (els.provider) els.provider.value = state.provider;
  if (state.model) localStorage.setItem('hermes.model', state.model);
  if (state.provider) localStorage.setItem('hermes.provider', state.provider);
  setConnectionLabel();
  addMessage('system', `Modell gesetzt: ${state.provider ? state.provider + ' / ' : ''}${state.model}. Gilt für neue Hermes-Agent-Turns über den Gateway/API-Server.`);
}

async function handleWebCommand(text) {
  const cmd = parseWebCommand(text);
  if (!cmd) return false;
  if (cmd.command === 'help') { showWebHelp(); return true; }
  if (cmd.command === 'status') { await showStatus(); return true; }
  if (cmd.command === 'new') { await createNamedSession(cmd.title || 'Hermes Web'); return true; }
  if (cmd.command === 'model') { await setRemoteModel(cmd.model, cmd.provider); return true; }
  addMessage('system', `Unbekanntes WebUI-Kommando: /${cmd.name}. /help zeigt unterstützte Kommandos.`);
  return true;
}

async function loadSessions(showErrors = true) {
  if (!hasAuth()) { renderSessions('Token fehlt'); return; }
  try { const res = await apiFetch('/api/sessions?limit=40&include_children=true'); if (!res.ok) throw new Error(`HTTP ${res.status}`); state.sessions = normalizeSessionList(await res.json()); renderSessions(); }
  catch (err) { renderSessions('Sessions nicht ladbar'); if (showErrors) addMessage('error', `Sessions konnten nicht geladen werden: ${err.message || err}`); }
}

function renderSessions(placeholder = '') {
  els.sessionList.textContent = '';
  if (placeholder || !state.sessions.length) {
    const div = document.createElement('div'); div.className = 'session-empty'; div.textContent = placeholder || 'Keine Sessions geladen'; els.sessionList.appendChild(div); return;
  }
  for (const session of state.sessions) {
    const id = session.id; const title = session.title || session.name || id || 'Session'; const updated = session.updated_at || session.created_at || '';
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = `session-item ${id === state.sessionId ? 'active' : ''}`;
    btn.innerHTML = `<div class="session-title"></div><div class="session-meta"></div>`;
    btn.querySelector('.session-title').textContent = title; btn.querySelector('.session-meta').textContent = `${id?.slice(0, 18) || ''} ${updated}`;
    btn.addEventListener('click', async () => { state.sessionId = id; localStorage.setItem('hermes.sessionId', id); setConnectionLabel(); renderSessions(); closeSidebar(); await loadMessages(id).catch((err) => addMessage('error', `Historie nicht ladbar: ${err.message || err}`)); });
    els.sessionList.appendChild(btn);
  }
}

async function loadMessages(sessionId) {
  const session = state.sessions.find(s => s.id === sessionId) || {};
  const limit = 500;
  const offset = Math.max(0, Number(session.message_count || 0) - limit);
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}`); if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json(); const items = normalizeMessageList(data); clearMessages();
  if (!items.length) addMessage('system', 'Keine Nachrichten in dieser Session.');
  else if (offset > 0) addMessage('system', `Zeige die letzten ${items.length} Nachrichten dieser Session. Ältere Nachrichten sind aus Performance-Gründen ausgeblendet.`);
  else addMessage('system', `${items.length} Nachrichten aus der Session-Historie geladen.`);
  for (const msg of items) {
    const parts = buildMessageParts(msg.content);
    if (msg.role === 'tool') continue;
    else if (msg.role === 'assistant') addMessage('assistant', parts.text || '');
    else addMessage(msg.role === 'user' ? 'user' : 'system', parts.text || '');
    for (const attachment of parts.attachments) {
      if (attachment.type === 'image' && attachment.url) addMessage('system', '', { html: `<img class="inline-image" alt="Anhang" src="${escapeHtml(attachment.url)}">` });
    }
  }
}

function renderAttachments() {
  els.attachmentTray.textContent = '';
  for (const [idx, file] of state.pendingFiles.entries()) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'attachment-chip'; chip.textContent = `${file.name} ×`;
    chip.addEventListener('click', () => { state.pendingFiles.splice(idx, 1); renderAttachments(); });
    els.attachmentTray.appendChild(chip);
  }
}

async function buildSessionMessage(text) {
  if (!state.pendingFiles.length) return text;
  const payload = await buildInputPayload(text, state.pendingFiles);
  return payload.input[0].content;
}

function showApproval(data) {
  state.pendingApproval = data || {};
  els.approvalText.textContent = data?.preview || data?.message || data?.command || 'Hermes wartet auf Freigabe.';
  els.approvalBar.classList.add('open');
}
function hideApproval() { state.pendingApproval = null; els.approvalBar.classList.remove('open'); }
async function resolveApproval(approved) {
  if (!state.activeRunId) { addMessage('error', 'Keine Run-ID für Approval verfügbar.'); return; }
  try {
    const res = await apiFetch(`/v1/runs/${encodeURIComponent(state.activeRunId)}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approved, decision: approved ? 'approve' : 'deny' }) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`); addMessage('system', approved ? 'Freigabe gesendet.' : 'Ablehnung gesendet.'); hideApproval();
  } catch (err) { addMessage('error', `Approval fehlgeschlagen: ${err.message || err}`); }
}

function speechSupported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }
function cleanSpeechText(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, 'Codeblock ausgelassen.')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[#>*_~\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function stopSpeech() {
  if (speechSupported()) window.speechSynthesis.cancel();
}
function speakAnswer(text) {
  if (!state.autoSpeak || !speechSupported()) return;
  const clean = cleanSpeechText(text);
  if (!clean) return;
  stopSpeech();
  const utterance = new SpeechSynthesisUtterance(clean.slice(0, 12000));
  utterance.lang = 'de-DE';
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

async function streamTurn(inputText) {
  const sessionId = await ensureSession(); const assistant = addMessage('assistant', ''); let gotText = false; state.activeRunId = null; state.assistantBuffer = '';
  const message = await buildSessionMessage(inputText);
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  if (!res.ok) throw new Error(`Hermes API Fehler: HTTP ${res.status} ${await res.text()}`); if (!res.body) throw new Error('Dieser Browser liefert keinen lesbaren Stream.');
  const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const parts = buffer.split('\n\n'); buffer = parts.pop() || '';
    for (const part of parts) {
      const { event, data } = parseSseBlock(part); if (data?.run_id) state.activeRunId = data.run_id;
      noteActivity(event, data || {});
      if (isApprovalEvent(event, data)) { showApproval(data); continue; }
      const delta = extractDelta(event, data);
      if (delta) { gotText = true; state.assistantBuffer += delta; renderMessageContent(assistant, state.assistantBuffer); els.messages.scrollTop = els.messages.scrollHeight; continue; }
      if (event.includes('tool') || event.includes('function')) {
        const toolName = data?.tool_name || data?.name || data?.tool || data?.function?.name || event;
        if (els.activityDetail) els.activityDetail.textContent = `${toolName} läuft…`;
      }
      if (event === 'run.completed' && Array.isArray(data?.messages)) reconcileCompletedMessages(data.messages, assistant);
      if (event.includes('error')) addMessage('error', typeof data === 'string' ? data : JSON.stringify(data));
    }
  }
  if (!gotText && !assistant.textContent.trim()) assistant.textContent = 'Fertig. Keine Textantwort im Stream erhalten.';
  const spokenText = state.assistantBuffer || assistant.textContent || '';
  state.pendingFiles = []; renderAttachments(); await loadSessions(false).catch(() => {});
  speakAnswer(spokenText);
}

function reconcileCompletedMessages(messages, liveAssistantEl) {
  const finalAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content && !m.tool_calls);
  if (finalAssistant && !state.assistantBuffer.trim()) renderMessageContent(liveAssistantEl, finalAssistant.content);
}

async function stopActiveRun() {
  if (!canStopRun(state.activeRunId)) { addMessage('system', 'Keine Run-ID im aktuellen Stream bekannt; Stop ist für diesen Hermes-Endpunkt eventuell nicht verfügbar.'); return; }
  try { const res = await apiFetch(`/v1/runs/${encodeURIComponent(state.activeRunId)}/stop`, { method: 'POST' }); if (!res.ok) throw new Error(`HTTP ${res.status}`); addMessage('system', 'Stop-Signal gesendet.'); }
  catch (err) { addMessage('error', `Stop fehlgeschlagen: ${err.message || err}`); }
}

function wireEvents() {
  $('settingsButton').addEventListener('click', () => { openSettings(); if (hasAuth() && !state.modelInventory.length) loadModelInventory(false).catch((err) => { if (els.modelPickerMeta) els.modelPickerMeta.textContent = `Modelle nicht ladbar: ${err.message || err}`; }); }); $('closeSettingsButton').addEventListener('click', closeSettings);
  $('saveSettingsButton').addEventListener('click', () => { saveSettings(); closeSettings(); addMessage('system', 'Einstellungen gespeichert.'); }); $('testConnectionButton').addEventListener('click', testConnection);
  els.autoSpeak?.addEventListener('change', () => { state.autoSpeak = els.autoSpeak.checked; localStorage.setItem('hermes.autoSpeak', String(state.autoSpeak)); if (!state.autoSpeak) stopSpeech(); });
  els.stopSpeechButton?.addEventListener('click', stopSpeech);
  $('setModelButton')?.addEventListener('click', async () => { saveSettings(); try { await setRemoteModel(state.model, state.provider); } catch (err) { addMessage('error', err.message || String(err)); } });
  els.provider?.addEventListener('change', () => { state.provider = els.provider.value; state.model = ''; if (els.modelFilter) els.modelFilter.value = ''; renderModelOptions(); setConnectionLabel(); });
  els.modelFilter?.addEventListener('input', renderModelOptions);
  els.model?.addEventListener('change', () => { state.model = els.model.value; setConnectionLabel(); });
  $('sessionsButton').addEventListener('click', openSidebar); $('closeSidebarButton').addEventListener('click', closeSidebar); $('newSessionButton').addEventListener('click', newSession); $('refreshSessionsButton').addEventListener('click', () => { saveSettings(); loadSessions(true); });
  els.stopButton.addEventListener('click', stopActiveRun); els.scrim.addEventListener('click', () => { closeSettings(); closeSidebar(); });
  els.attachButton.addEventListener('click', () => els.fileInput.click()); els.fileInput.addEventListener('change', () => { state.pendingFiles.push(...els.fileInput.files); els.fileInput.value = ''; renderAttachments(); });
  els.approveButton.addEventListener('click', () => resolveApproval(true)); els.denyButton.addEventListener('click', () => resolveApproval(false));
  els.prompt.addEventListener('input', () => { els.prompt.style.height = 'auto'; els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 150)}px`; });
  els.prompt.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('composer').requestSubmit(); } });
  $('composer').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const text = els.prompt.value.trim(); if ((!text && !state.pendingFiles.length) || state.busy) return;
    if (!hasAuth()) { addMessage('system', 'Bitte zuerst ⚙ öffnen und API_SERVER_KEY eintragen oder Server-Key aktivieren.'); openSettings(); return; }
    els.prompt.value = ''; els.prompt.style.height = 'auto';
    if (!state.pendingFiles.length && text.startsWith('/')) {
      addMessage('user', text); resetActivity('WebUI-Kommando wird ausgeführt…'); setBusy(true);
      try { await handleWebCommand(text); }
      catch (err) { noteActivity('error', { error: err.message || String(err) }); addMessage('error', err.message || String(err)); }
      finally { resetActivity('Bereit'); setBusy(false); setConnectionLabel(); els.prompt.focus(); }
      return;
    }
    addMessage('user', text || `[${state.pendingFiles.length} Datei(en)]`); resetActivity('Anfrage wird an Server gesendet…'); setBusy(true); setConnectionLabel('Hermes arbeitet…');
    try { await streamTurn(text); } catch (err) { noteActivity('error', { error: err.message || String(err) }); addMessage('error', err.message || String(err)); }
    finally { setBusy(false); state.activeRunId = null; setConnectionLabel(); els.prompt.focus(); }
  });
}

async function boot() {
  wireEvents(); await loadBootstrap(); if (els.autoSpeak) els.autoSpeak.checked = state.autoSpeak; setConnectionLabel(); renderSessions(); addMessage('system', state.serverAuthAvailable ? 'Hermes Web bereit. Server-Key aktiv; kein API-Token im Browser nötig.' : 'Hermes Web bereit. Öffne ⚙, trage dein API Token ein und starte eine Session.');
  if (hasAuth()) {
    await loadModelInventory(false).catch((err) => { if (els.menuModelLabel) els.menuModelLabel.textContent = `Modell unbekannt`; console.warn('Model inventory unavailable', err); });
    await loadSessions(false);
    if (state.sessionId) await loadMessages(state.sessionId).catch((err) => addMessage('error', `Historie nicht ladbar: ${err.message || err}`));
  }
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
boot().catch((err) => {
  document.body.innerHTML = `<pre style="white-space:pre-wrap;padding:20px;color:#fff;background:#070812">Hermes Web konnte nicht starten:\n${err?.stack || err}</pre>`;
});
