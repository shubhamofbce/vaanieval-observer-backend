/**
 * Vaani Observer console.
 *
 * One page: a rail of recorded calls on the left, one call's detail on the
 * right. Everything on the detail side is driven off a single selection model
 * so the timeline, transcript, tables and inspector always agree about what the
 * reviewer is currently looking at.
 */

/* ------------------------------------------------------------------ dom */

const $ = (selector, scope = document) => scope.querySelector(selector);

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && !key.includes('-')) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const clear = (node) => { node.replaceChildren(); return node; };

/* --------------------------------------------------------------- format */

const TYPES = ['stt', 'llm', 'tool', 'tts'];

/** A provider socket is opened once and held for the whole call. It carries the
 *  `stt`/`tts` type of the stream it serves, but presenting it as a two-minute
 *  transcription would invent a latency that never happened. Older packages
 *  predate `scope`, so an unturned websocket is treated the same way. */
function isSocket(op) {
  return op?.scope === 'connection' || (op?.turn_id == null && op?.transport === 'websocket');
}

function displayType(op) {
  return isSocket(op) ? 'conn' : op?.type;
}
const TYPE_LABEL = { stt: 'Speech to text', llm: 'Model', tts: 'Text to speech', tool: 'Tool', conn: 'Provider socket' };
// Response-time bands, stated once and shown to the reviewer in the KPI legend.
const SLOW_MS = 3000;
const WARN_MS = 1800;

/** The one place the response-time bands are decided, so the KPI, the turns
 *  table and the legend can never disagree. */
function latencyTone(value) {
  if (value == null || Number.isNaN(value)) return null;
  if (value >= SLOW_MS) return 'danger';
  if (value >= WARN_MS) return 'warn';
  return 'ok';
}

/** Places one waterfall bar inside its parent span, tolerating milestones
 *  recorded outside it rather than letting the bar escape the track. */
function waterfallGeometry(from, to, start, span, background) {
  const left = clampPercent(((from - start) / span) * 100, 99);
  return {
    left: `${left}%`,
    width: `${clampPercent(((to - from) / span) * 100, 100 - left, 1.5)}%`,
    background: background || 'var(--accent)',
  };
}

/** Geometry from recorded clocks can fall outside the span it is drawn in. */
function clampPercent(value, max = 100, min = 0) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const COLOR = { stt: '#62b4ff', llm: '#a98bff', tts: '#4fd6a5', tool: '#f0b355', conn: '#6d89b0' };

/** Human duration: sub-second stays in ms, minutes get a m/s split. */
function duration(value) {
  if (value == null || Number.isNaN(value)) return null;
  const ms = Math.round(value);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) {
    const text = (ms / 1000).toFixed(ms < 10000 ? 2 : 1);
    // 59950ms rounds to "60.0", which must carry into the minute form.
    if (Number(text) < 60) return `${text}s`;
  }
  // Round to whole seconds first, otherwise 119999ms renders as "1m 60s".
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Position on the call clock, the way a reviewer reads a recording. */
function offset(value) {
  if (value == null) return '—';
  // Round to the printed tenth first, or 59950ms renders as "0:60.0".
  const tenths = Math.max(0, Math.round(value / 100));
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  return `${minutes}:${String(Math.floor(rest / 10)).padStart(2, '0')}.${rest % 10}`;
}

function clock(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function bytes(value) {
  if (!value) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function relativeTime(value) {
  const date = parseDate(value);
  if (!date) return 'unknown time';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  const units = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2629800], ['year', 31557600]];
  let [unit, size] = units[0];
  for (const candidate of units) if (Math.abs(seconds) >= candidate[1]) [unit, size] = candidate;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return format.format(-Math.round(seconds / size), unit);
}

function absoluteTime(value) {
  const date = parseDate(value);
  if (!date) return 'No timestamp recorded';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function pretty(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

/* ------------------------------------------------------------ transcript */

/**
 * The SDK replaces oversized captures with a `_truncated` envelope, so every
 * body has to be unwrapped before it can be parsed — and the truncation has to
 * stay visible, otherwise a clipped reply reads like a missing one.
 */
function unwrapBody(body) {
  if (body && typeof body === 'object' && body._truncated) {
    return { value: body._preview ?? '', truncated: true, originalBytes: body._original_bytes ?? null };
  }
  return { value: body, truncated: false, originalBytes: null };
}

function parseRequestBody(op) {
  const { value, truncated, originalBytes } = unwrapBody(op?.request?.body);
  const empty = { request: {}, truncated, originalBytes };
  if (value == null) return empty;
  if (typeof value !== 'string') return typeof value === 'object' ? { request: value, truncated, originalBytes } : empty;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? { request: parsed, truncated, originalBytes } : empty;
  } catch {
    return { request: {}, truncated: true, originalBytes, unparsed: value };
  }
}

/**
 * Decodes one chat-completions response, streamed or not, into the parts a
 * reviewer cares about: what the agent said, which tools it asked for, and why
 * generation stopped.
 */
function decodeCompletion(response) {
  const result = { text: '', toolCalls: [], finishReason: null, model: null, usage: null, cost: null, truncated: false, originalBytes: null, alternatives: 0 };
  if (!response) return result;
  const unwrapped = unwrapBody(response.body ?? response);
  result.truncated = unwrapped.truncated;
  result.originalBytes = unwrapped.originalBytes;
  const body = unwrapped.value;
  // Streamed tool calls arrive as fragments keyed by index, and providers are
  // free to skip indexes, so they cannot be accumulated in a plain array.
  const toolCalls = new Map();

  const absorbDelta = (delta) => {
    if (!delta) return;
    if (typeof delta.content === 'string') result.text += delta.content;
    for (const [position, call] of (delta.tool_calls || []).entries()) {
      const key = call.index ?? call.id ?? position;
      const slot = toolCalls.get(key) || { name: '', arguments: '', order: toolCalls.size };
      if (call.function?.name) slot.name += call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
      toolCalls.set(key, slot);
    }
  };

  const absorbChoice = (choice) => {
    if (!choice) return;
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    if (choice.delta) absorbDelta(choice.delta);
    if (choice.message) {
      if (typeof choice.message.content === 'string') result.text += choice.message.content;
      for (const [position, call] of (choice.message.tool_calls || []).entries()) {
        toolCalls.set(call.id ?? `message-${position}`, {
          name: call.function?.name || call.name || 'tool',
          arguments: call.function?.arguments || '',
          order: toolCalls.size,
        });
      }
    }
  };

  const absorbPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.model) result.model = payload.model;
    if (payload.usage) result.usage = payload.usage;
    // Do not derive a price from tokens or a model name. Some providers include
    // an actual charge in their response; this accepts only those explicit
    // monetary fields, including the final usage chunk of an SSE response.
    const reportedCost = extractReportedCost(payload);
    if (reportedCost) result.cost = reportedCost;
    // With n > 1 the alternatives are separate replies; concatenating them
    // would invent an utterance the caller never heard. Only the primary
    // choice was actually spoken.
    const choices = payload.choices || [];
    // Streamed alternatives arrive as separate chunks that each carry one
    // choice, so an `index: 1` chunk must be dropped rather than treated as
    // the primary reply by positional fallback.
    const indexed = choices.some((choice) => choice?.index != null);
    const primary = indexed
      ? choices.find((choice) => choice.index === 0)
      : choices[0];
    for (const choice of choices) {
      const index = choice?.index ?? 0;
      if (index > result.alternatives) result.alternatives = index;
    }
    absorbChoice(primary);
  };

  const finish = () => {
    result.toolCalls = [...toolCalls.values()].sort((a, b) => a.order - b.order);
    return result;
  };

  if (body && typeof body === 'object') { absorbPayload(body); return finish(); }
  if (typeof body !== 'string') return finish();

  // Only treat the body as an event stream when a line actually starts with a
  // `data:` field; a JSON reply that merely mentions "data:" is not SSE.
  if (/^data:/m.test(body)) {
    const consume = (payload) => {
      if (!payload || payload === '[DONE]') return true;
      try { absorbPayload(JSON.parse(payload)); return true; } catch { return false; }
    };
    for (const block of body.split(/\r?\n\r?\n/)) {
      const lines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (!lines.length) continue;
      // A multi-line `data:` field is one payload, but captures that dropped the
      // blank separators put several whole events in one block. Try the spec
      // reading first, then fall back to one event per line.
      if (consume(lines.join('\n'))) continue;
      for (const line of lines) consume(line);
    }
    return finish();
  }
  try { absorbPayload(JSON.parse(body)); } catch { result.text = body; }
  return finish();
}

function extractReportedCost(payload) {
  const usage = payload?.usage;
  const candidates = [
    [usage?.cost, usage],
    [usage?.total_cost, usage],
    [payload?.cost, payload],
    [payload?.total_cost, payload],
  ];
  for (const [value, context] of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { amount: value, currency: context?.currency || payload?.currency || null };
    }
    if (value && typeof value === 'object' && typeof value.amount === 'number' && Number.isFinite(value.amount)) {
      return { amount: value.amount, currency: value.currency || context?.currency || payload?.currency || null };
    }
  }
  return null;
}

function formatReportedCost(cost) {
  if (!cost) return null;
  if (typeof cost.currency === 'string' && /^[A-Za-z]{3}$/.test(cost.currency)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency', currency: cost.currency.toUpperCase(), maximumFractionDigits: 8,
      }).format(cost.amount);
    } catch { /* retain the provider's amount if its currency code is unsupported */ }
  }
  return String(cost.amount);
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').filter(Boolean).join('\n');
  return content == null ? '' : JSON.stringify(content, null, 2);
}

/**
 * Rebuilds the conversation from the model calls. Every request carries the
 * full history, so walking the calls in order and taking only the messages that
 * have not been seen before recovers the whole dialogue — including the opening
 * line, which has no model call of its own.
 *
 * Identity is content-based rather than positional: a scalar "how far did we
 * get" pointer breaks on retried calls, parallel calls that share a history,
 * and agents that summarise and therefore shorten their history. Repeated
 * identical utterances stay distinct because the key also carries how many
 * times that exact message has already appeared in the history.
 */
function buildTranscript(operations) {
  // Capture order is the tie-breaker: event ids are random UUIDs, so sorting by
  // them would shuffle parallel calls that share a start timestamp.
  const captureOrder = new Map(operations.map((op, index) => [op, index]));
  const calls = operations
    .filter((op) => op.type === 'llm')
    .sort((a, b) => (a.started_at_ms || 0) - (b.started_at_ms || 0)
      || captureOrder.get(a) - captureOrder.get(b));

  const entries = [];
  const seen = new Set();
  const totals = new Map();
  let systemPrompt = null;
  let bodiesCaptured = false;
  // Several replies can be awaiting repair at once when calls overlap, so a
  // single slot would be cleared by whichever call happened to finish next.
  const pendingReplies = [];

  const identity = (role, text, extra, occurrence) => `${role}\u0000${extra || ''}\u0000${text}\u0000${occurrence}`;

  const remember = (role, text, extra, occurrence) => {
    const base = `${role}\u0000${extra || ''}\u0000${text}`;
    totals.set(base, Math.max(totals.get(base) || 0, occurrence + 1));
    seen.add(identity(role, text, extra, occurrence));
  };

  /** Upgrades a truncated reply once a later request carries the full text. */
  const repairPending = (text) => {
    let best = -1;
    for (let i = 0; i < pendingReplies.length; i += 1) {
      const candidate = pendingReplies[i];
      if (!candidate.text || !text.startsWith(candidate.text) || text === candidate.text) continue;
      if (best < 0 || candidate.text.length > pendingReplies[best].text.length) best = i;
    }
    if (best < 0) return false;
    const entry = pendingReplies.splice(best, 1)[0];
    entry.text = text;
    entry.repaired = true;
    return true;
  };

  for (const op of calls) {
    const { request } = parseRequestBody(op);
    const messages = Array.isArray(request.messages) ? request.messages : [];
    if (op.request?.body != null || op.response?.body != null) bodiesCaptured = true;

    const counted = new Map();
    for (const message of messages) {
      const role = message.role === 'tool' ? 'tool' : message.role;
      const text = messageText(message);
      const extra = message.tool_call_id || '';
      const base = `${role}\u0000${extra}\u0000${text}`;
      const occurrence = counted.get(base) || 0;
      counted.set(base, occurrence + 1);
      totals.set(base, Math.max(totals.get(base) || 0, occurrence + 1));

      const key = identity(role, text, extra, occurrence);
      if (seen.has(key)) continue;
      seen.add(key);

      if (role === 'system') { systemPrompt ??= text; continue; }

      // A captured reply can be a truncated prefix; the next request carries the
      // whole thing, so upgrade the entry we already have instead of repeating it.
      if (role === 'assistant' && text && repairPending(text)) continue;

      entries.push({
        role,
        text,
        toolCalls: (message.tool_calls || []).map((call) => ({ name: call.function?.name || call.name || 'tool', arguments: call.function?.arguments || '' })),
        at: op.started_at_ms,
        turnId: op.turn_id ?? null,
        op,
        source: 'history',
      });
    }

    const completion = decodeCompletion(op.response);
    // An op whose bodies were never captured would otherwise show up as an
    // empty agent turn, which reads as "the agent said nothing" rather than
    // "we did not record it".
    if (completion.text || completion.toolCalls.length || completion.truncated) {
      // The reply is not yet in this call's history, so its occurrence is the
      // number of identical assistant lines already in that history. A retried
      // call therefore lands on the same key as its first attempt and is
      // dropped, while a genuinely repeated utterance gets a fresh one.
      const base = `assistant\u0000\u0000${completion.text}`;
      const occurrence = counted.get(base) || 0;
      const key = identity('assistant', completion.text, '', occurrence);
      const isRetry = completion.text && seen.has(key);
      if (!isRetry) {
        const entry = {
          role: 'assistant',
          text: completion.text,
          toolCalls: completion.toolCalls,
          at: op.ended_at_ms ?? op.started_at_ms,
          turnId: op.turn_id ?? null,
          op,
          completion,
          latency: op.duration_ms,
          source: 'completion',
        };
        entries.push(entry);
        remember('assistant', completion.text, '', occurrence);
        if (completion.truncated || !completion.text) pendingReplies.push(entry);
      }
    }
  }

  return { entries, systemPrompt, modelCallCount: calls.length, bodiesCaptured };
}

/* ----------------------------------------------------------------- state */

const state = {
  sessions: [],
  filter: '',
  sessionId: null,
  session: null,
  requestToken: 0,
  transcript: null,
  opsById: new Map(),
  turnsById: new Map(),
  selection: null, // { kind: 'op' | 'turn', id }
  opFilter: { type: 'all', errorsOnly: false, query: '' },
  opSort: { key: 'start', direction: 'asc' },
  turnSort: { key: 'turn', direction: 'asc' },
  inspectorTab: 'overview',
  audio: null,
  audioListeners: null,
  audioTrack: null,
};

const ui = {};

/* ------------------------------------------------------------------- api */

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try { const body = await response.json(); if (body?.detail) detail = body.detail; } catch { /* non-JSON error body */ }
    throw new Error(detail);
  }
  return response.json();
}

let toastTimer;
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
}

async function copy(value, label) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} copied`);
  } catch {
    toast('Clipboard blocked by the browser');
  }
}

/* ------------------------------------------------------------------ rail */

let listToken = 0;
async function loadSessions({ keepSelection = true, reload = false } = {}) {
  const button = $('#refresh');
  const token = ++listToken;
  button.classList.add('is-busy');
  button.disabled = true;
  try {
    const sessions = await api('/v1/sessions');
    // An overlapping refresh must not let the older response win.
    if (token !== listToken) return;
    state.sessions = sessions;
    $('#conn-state').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    $('#conn-state').dataset.state = 'ok';
    renderRail();
    const requested = readLocation();
    const wanted = keepSelection && state.sessions.some((item) => item.id === state.sessionId)
      ? state.sessionId
      : state.sessions.some((item) => item.id === requested.sessionId) ? requested.sessionId : null;
    // On an explicit refresh the open call is refetched even when it is still
    // the selected one, otherwise newly uploaded operations never appear.
    if (wanted && (reload || wanted !== state.sessionId)) {
      await selectSession(wanted, wanted === state.sessionId ? readLocation() : requested);
    } else if (!wanted) {
      if (state.sessions[0]) await selectSession(state.sessions[0].id, requested);
      else renderNoSessions();
    }
  } catch (error) {
    if (token !== listToken) return;
    $('#conn-state').textContent = 'Cannot reach the observer API';
    $('#conn-state').dataset.state = 'error';
    state.requestToken += 1;
    teardownCall();
    renderFatal('Could not load sessions', error.message, () => loadSessions({ keepSelection: false }));
  } finally {
    if (token === listToken) {
      button.classList.remove('is-busy');
      button.disabled = false;
    }
  }
}

function visibleSessions() {
  const query = state.filter.trim().toLowerCase();
  if (!query) return state.sessions;
  return state.sessions.filter((item) => `${item.agent_id || ''} ${item.id} ${item.outcome || ''} ${item.status}`.toLowerCase().includes(query));
}

function renderRail() {
  const host = clear($('#sessions'));
  const list = visibleSessions();
  $('#session-count').textContent = String(state.sessions.length);

  const note = $('#rail-note');
  note.hidden = list.length > 0;
  if (!list.length) {
    note.textContent = state.sessions.length
      ? `No call matches “${state.filter.trim()}”.`
      : 'No calls recorded yet. Complete an SDK upload to see one here.';
  }

  for (const item of list) {
    host.append(h('button', {
      type: 'button',
      class: 'session',
      'aria-current': String(item.id === state.sessionId),
      title: `${item.agent_id || 'Untitled agent'}\n${item.id}\n${absoluteTime(item.started_at || item.created_at)}`,
      onClick: () => selectSession(item.id),
    },
      h('span', { class: 'session-top' },
        h('span', { class: 'session-dot', dataset: { status: item.status } }),
        h('span', { class: 'session-agent', text: item.agent_id || 'Untitled agent' }),
      ),
      h('span', { class: 'session-meta' },
        h('span', { text: relativeTime(item.started_at || item.created_at) }),
        h('span', { text: duration(item.duration_ms) || '—' }),
        h('span', { text: `${item.turn_count ?? 0} turn${item.turn_count === 1 ? '' : 's'}` }),
      ),
      h('span', { class: 'session-id', text: item.id }),
    ));
  }
}

/* ------------------------------------------------------- shell rendering */

function renderNoSessions() {
  state.requestToken += 1;
  teardownCall();
  clear($('#call')).append(h('div', { class: 'card' },
    h('div', { class: 'empty-block' },
      h('b', { text: 'No calls recorded yet' }),
      h('p', { text: 'Point the SDK at this observer, finish a call, and the completed package will appear in the rail on the left.' }),
    ),
  ));
}

function renderFatal(title, message, retry) {
  clear($('#call')).append(h('div', { class: 'banner', dataset: { tone: 'danger' } },
    h('div', {}, h('b', { text: title }), h('span', { text: message })),
    h('button', { type: 'button', class: 'btn', text: 'Retry', onClick: retry }),
  ));
}

function renderLoading() {
  const bar = (height, width = '100%') => h('div', { class: 'skeleton', style: { height, width } });
  clear($('#call')).append(
    h('div', { class: 'skeleton-stack' },
      bar('26px', '280px'),
      bar('68px'),
      bar('220px'),
      bar('320px'),
    ),
  );
}

/* ------------------------------------------------------------------- url */

/** Keeps the call and the inspected span in the address bar so a reviewer can
 *  paste a link to exactly what they are looking at. */
/** A hand-edited or truncated hash can carry an invalid escape; a thrown
 *  URIError there would surface as a bogus "cannot reach the API" banner. */
function safeDecode(value) {
  if (value == null) return null;
  try { return decodeURIComponent(value); } catch { return value; }
}

function readLocation() {
  const match = /^#\/call\/([^/?]+)(?:\/(op|turn)\/([^/?]+))?(?:\?(.*))?/.exec(location.hash || '');
  if (!match) return {};
  const query = new URLSearchParams(match[4] || '');
  return {
    sessionId: safeDecode(match[1]),
    kind: match[2] || null,
    selectionId: safeDecode(match[3]),
    tab: query.get('tab'),
    opType: query.get('type'),
    opErrors: query.get('errors') === '1',
    opQuery: query.get('q'),
  };
}

let suppressHashHandling = false;
let lastHistoryPath = null;
function writeLocation() {
  if (!state.sessionId) return;
  const selection = state.selection;
  const path = selection ? `/${selection.kind}/${encodeURIComponent(selection.id)}` : '';
  const query = new URLSearchParams();
  if (selection) query.set('tab', state.inspectorTab);
  if (state.opFilter.type !== 'all') query.set('type', state.opFilter.type);
  if (state.opFilter.errorsOnly) query.set('errors', '1');
  if (state.opFilter.query.trim()) query.set('q', state.opFilter.query.trim());
  const suffix = query.toString();
  const hash = `#/call/${encodeURIComponent(state.sessionId)}${path}${suffix ? `?${suffix}` : ''}`;
  if (location.hash === hash) return;
  // Opening a different call or a different span is a navigation a reviewer
  // expects Back to undo. Retyping a filter is not, so it rewrites in place
  // instead of burying the previous view under a keystroke per character.
  const historyPath = `${state.sessionId}${path}`;
  const isNavigation = lastHistoryPath !== null && historyPath !== lastHistoryPath;
  lastHistoryPath = historyPath;
  suppressHashHandling = true;
  if (isNavigation) history.pushState(null, '', hash);
  else history.replaceState(null, '', hash);
  suppressHashHandling = false;
}

/** Single place that turns a parsed location into view state, so the address
 *  bar and the page can never drift apart. Anything the URL omits is reset
 *  rather than left over from the previous view. */
function applyViewState(requested = {}, { render = false } = {}) {
  state.opFilter = {
    type: requested.opType || 'all',
    errorsOnly: Boolean(requested.opErrors),
    query: requested.opQuery || '',
  };
  state.inspectorTab = requested.tab && TABS.some((tab) => tab.key === requested.tab) ? requested.tab : 'overview';
  if (!render) return;

  if (ui.opSearch) ui.opSearch.value = state.opFilter.query;
  renderOperationRows();
  syncOpFilterControls();

  const id = requested.selectionId;
  if (id && requested.kind === 'op' && state.opsById.has(id)) setSelection('op', id, { scroll: true });
  else if (id && requested.kind === 'turn' && state.turnsById.has(id)) setSelection('turn', id, { scroll: true });
  else setSelection(null, null);
}

/* -------------------------------------------------------------- selection */

function setSelection(kind, id, { scroll = false } = {}) {
  state.selection = id == null ? null : { kind, id };
  syncSelection({ scroll });
  renderInspector();
  writeLocation();
}

function selectedOperation() {
  if (!state.selection) return null;
  if (state.selection.kind === 'op') return state.opsById.get(state.selection.id) || null;
  return null;
}

function selectedTurn() {
  if (!state.selection) return null;
  if (state.selection.kind === 'turn') return state.turnsById.get(state.selection.id) || null;
  const op = selectedOperation();
  return op?.turn_id != null ? state.turnsById.get(String(op.turn_id)) || null : null;
}

function syncSelection({ scroll = false } = {}) {
  const selection = state.selection;
  const turn = selectedTurn();

  for (const node of document.querySelectorAll('[data-op-id]')) {
    const active = selection?.kind === 'op' && node.dataset.opId === selection.id;
    if (node.tagName === 'BUTTON') node.setAttribute('aria-pressed', String(active));
    node.classList.toggle('is-selected', active && !node.classList.contains('timeline-bar'));
    if (active && scroll) node.scrollIntoView({ block: 'nearest' });
  }
  for (const node of document.querySelectorAll('[data-turn-id]')) {
    const active = turn != null && node.dataset.turnId === turn.turn_id;
    if (node.tagName === 'BUTTON' && node.hasAttribute('aria-pressed')) {
      node.setAttribute('aria-pressed', String(active && selection?.kind === 'turn'));
    }
    node.classList.toggle('is-selected', active);
    if (active && selection?.kind === 'turn' && scroll) node.scrollIntoView({ block: 'nearest' });
  }
  drawTurnGuides(turn);
}

/* -------------------------------------------------------------- the call */

async function selectSession(id, restore = {}) {
  // A newer selection always wins; otherwise a slow response for a call the
  // reviewer has already navigated away from would overwrite the current one.
  const token = ++state.requestToken;
  state.sessionId = id;
  teardownCall();
  renderRail();
  renderLoading();
  try {
    const session = await api(`/v1/sessions/${encodeURIComponent(id)}`);
    if (token !== state.requestToken) return;
    state.session = session;
    state.transcript = buildTranscript(session.operations || []);
    state.opsById = new Map((session.operations || []).map((op) => [op.event_id, op]));
    state.turnsById = new Map((session.turns || []).map((turn) => [turn.turn_id, turn]));
    state.selection = null;
    applyViewState(restore);
    state.opSort = { key: 'start', direction: 'asc' };
    state.turnSort = { key: 'turn', direction: 'asc' };
    renderCall(session);
    applyViewState(restore, { render: true });
  } catch (error) {
    if (token !== state.requestToken) return;
    renderFatal('Could not load this call', error.message, () => selectSession(id));
  }
}

/** Stops anything the previous call left running before its DOM is replaced. */
function teardownCall() {
  if (state.audio) {
    state.audioListeners?.abort();
    state.audio.pause();
    state.audio.removeAttribute('src');
    state.audio.load();
  }
  state.audioListeners = null;
  state.audio = null;
  state.audioTrack = null;
  state.session = null;
  state.transcript = null;
  state.opsById = new Map();
  state.turnsById = new Map();
  state.selection = null;
  ui.playhead = null;
  ui.turnGuides = null;
  ui.togglePlay = null;
  ui.playheadAligned = false;
  hideTooltip();
}

function captureWarnings(session) {
  const capture = session.manifest?.capture_status || {};
  const warnings = [];
  if (session.status === 'partial') warnings.push('No classified operations were imported, so the timeline and transcript are empty. Check that events.jsonl reached the observer.');
  if (capture.events_complete === false) warnings.push('The SDK reported an incomplete event stream.');
  if (capture.caller_audio_complete === false) warnings.push('Caller audio capture was incomplete.');
  if (capture.agent_audio_complete === false) warnings.push('Agent audio capture was incomplete.');
  if (capture.dropped_event_count) warnings.push(`${capture.dropped_event_count} event(s) were dropped under backpressure.`);
  if (capture.dropped_audio_chunk_count) warnings.push(`${capture.dropped_audio_chunk_count} audio chunk(s) were dropped, so playback may drift.`);
  for (const key of ['http_instrumentation', 'websocket_instrumentation']) {
    if (capture[key] && capture[key] !== 'active') warnings.push(`${key.replace(/_/g, ' ')} was ${capture[key]}; some spans may be missing.`);
  }
  return warnings;
}

function renderCall(session) {
  const manifest = session.manifest || {};
  const turns = session.turns || [];
  const operations = session.operations || [];
  const started = manifest.started_at || session.created_at;

  const responses = turns.map((turn) => turn.time_to_first_audio_ms).filter((value) => value != null);
  const errors = operations.filter((op) => op.status === 'error');
  const tools = operations.filter((op) => op.type === 'tool');
  const slowest = turns.filter((turn) => turn.time_to_first_audio_ms != null)
    .sort((a, b) => b.time_to_first_audio_ms - a.time_to_first_audio_ms)[0];

  const head = h('div', { class: 'call-head' },
    h('div', {},
      h('h1', { text: manifest.agent_id || session.agent_id || 'Untitled agent' }),
      h('div', { class: 'call-sub' },
        h('span', { text: absoluteTime(started) }),
        h('span', { class: 'dot-sep' }),
        h('span', { text: relativeTime(started) }),
        h('span', { class: 'dot-sep' }),
        h('span', { class: 'num', text: duration(manifest.duration_ms) || 'unknown length' }),
        h('span', { class: 'dot-sep' }),
        h('span', { text: `outcome: ${manifest.outcome || session.outcome || 'unknown'}` }),
      ),
    ),
    h('div', { class: 'card-tools' },
      h('button', {
        type: 'button', class: 'copy-id', title: 'Copy session id',
        onClick: () => copy(session.id, 'Session id'),
      },
        h('span', { text: session.id }),
        h('span', { text: '⧉' }),
      ),
      errors.length
        ? h('button', {
          type: 'button', class: 'status-pill', dataset: { status: 'failed' },
          title: 'Show only failed operations',
          onClick: () => jumpToOps({ errorsOnly: true, type: 'all' }),
          text: `${errors.length} failed op${errors.length === 1 ? '' : 's'}`,
        })
        : null,
      h('span', { class: 'status-pill', dataset: { status: session.status }, text: session.status }),
    ),
  );

  // Providers actually exercised by the call — the API leaves `model` null on
  // every span, so the endpoint id is the only honest identity we have.
  const providers = [...new Set(operations.map((op) => op.endpoint_id || op.provider).filter(Boolean))];
  // `model` is null on every span, but the streamed completion names it, so the
  // reconstructed transcript is the only place the real model shows up.
  const models = [...new Set([
    ...operations.map((op) => op.model),
    ...(state.transcript?.entries || []).map((entry) => entry.completion?.model),
  ].filter(Boolean))];
  const providerRow = providers.length ? h('div', { class: 'provider-row' },
    h('span', { class: 'provider-label', text: 'Providers' }),
    ...providers.map((id) => h('button', {
      type: 'button', class: 'chip chip-action', text: id,
      title: `Search operations for ${id}`,
      onClick: () => jumpToOps({ query: id }),
    })),
    models.length
      ? h('span', { class: 'provider-models', text: `models: ${models.join(', ')}` })
      : h('span', { class: 'provider-models cell-missing', text: 'no model name recorded on any span' }),
  ) : null;

  const kpi = (label, value, unit, foot, options = {}) => h(options.onClick ? 'button' : 'div', {
    type: options.onClick ? 'button' : null,
    class: 'kpi',
    dataset: options.tone ? { tone: options.tone } : {},
    title: options.title || null,
    onClick: options.onClick || null,
  },
    h('span', { class: 'kpi-label', text: label }),
    h('span', { class: 'kpi-value' }, value, unit ? h('small', { text: unit }) : null),
    h('span', { class: 'kpi-foot', text: foot }),
  );

  const jumpToOps = (patch) => {
    Object.assign(state.opFilter, patch);
    if (ui.opSearch) ui.opSearch.value = state.opFilter.query;
    renderOperationRows();
    writeLocation();
    if (ui.opsCard) ui.opsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    syncOpFilterControls();
  };

  const kpis = h('div', { class: 'kpis' },
    kpi('Turns', String(turns.length), null, turns.length ? `${operations.length} operations` : 'no turn spans captured'),
    kpi('Call length', duration(manifest.duration_ms) || '—', null, `${session.recordings?.filter((r) => r.uploaded).length || 0} audio track(s)`),
    kpi('Response p50', responses.length ? duration(percentile(responses, 0.5)) : '—', null,
      responses.length ? 'user stops → first audio' : 'needs turns with a first-audio mark',
      { tone: responses.length ? latencyTone(percentile(responses, 0.5)) : null }),
    kpi('Response p95', responses.length ? duration(percentile(responses, 0.95)) : '—', null,
      responses.length ? `over ${responses.length} turn${responses.length === 1 ? '' : 's'}` : 'needs turns with a first-audio mark',
      { tone: responses.length ? latencyTone(percentile(responses, 0.95)) : null }),
    kpi('Slowest turn', slowest ? duration(slowest.time_to_first_audio_ms) : '—', null,
      slowest ? `turn #${slowest.turn_id} — inspect` : 'no timed turns',
      slowest ? { tone: latencyTone(slowest.time_to_first_audio_ms), title: `Inspect turn #${slowest.turn_id}`, onClick: () => setSelection('turn', slowest.turn_id, { scroll: true }) } : {}),
    kpi('Failures', String(errors.length), null, errors.length ? 'filter operations' : 'all operations ok',
      { tone: errors.length ? 'danger' : null, onClick: errors.length ? () => jumpToOps({ errorsOnly: true, type: 'all' }) : null }),
    kpi('Tool calls', String(tools.length), null, tools.length ? 'filter operations' : 'none in this call',
      { onClick: tools.length ? () => jumpToOps({ type: 'tool', errorsOnly: false }) : null }),
  );

  const legend = h('p', { class: 'kpi-legend' },
    'Response time is the gap between the caller stopping and the first agent audio frame. ',
    h('span', { class: 'tone-key', dataset: { tone: 'ok' } }, `under ${duration(WARN_MS)} good`),
    h('span', { class: 'tone-key', dataset: { tone: 'warn' } }, `${duration(WARN_MS)} to under ${duration(SLOW_MS)} borderline`),
    h('span', { class: 'tone-key', dataset: { tone: 'danger' } }, `${duration(SLOW_MS)} or more is audible lag`),
  );

  const warnings = captureWarnings(session);
  const banner = warnings.length ? h('div', { class: 'banner', dataset: { tone: session.status === 'partial' ? 'danger' : 'warn' } },
    h('div', {},
      h('b', { text: warnings.length === 1 ? 'Capture warning' : `${warnings.length} capture warnings` }),
      h('span', { text: warnings.join(' ') }),
    ),
  ) : null;

  const columns = h('div', { class: 'columns' },
    h('div', { class: 'col' }, buildTimelineCard(session), buildTranscriptCard(session), buildTurnsCard(session), buildOperationsCard()),
    h('div', { class: 'col col-side' }, buildAudioCard(session), buildInspectorCard()),
  );

  clear($('#call')).append(...[head, providerRow, banner, kpis, legend, columns].filter(Boolean));
  renderTurnRows();
  renderOperationRows();
  renderInspector();
  drawTurnGuides(null);
}

/* -------------------------------------------------------------- timeline */

function buildTimelineCard(session) {
  // Draw from the flat operation list only. `session.turns[].operations` are
  // separate objects after JSON parsing, and rendering both would let the
  // timeline and the operations table disagree about the same span.
  const all = session.operations || [];
  const sockets = all.filter(isSocket);
  const turnOps = all.filter((op) => op.turn_id != null && !isSocket(op));
  const loose = all.filter((op) => op.turn_id == null && !isSocket(op));
  const spans = [...turnOps, ...loose, ...sockets];
  const total = Math.max(session.manifest?.duration_ms || 0, ...spans.map((op) => op.ended_at_ms || op.started_at_ms || 0), 1);

  ui.timelineTotal = total;

  const legend = h('div', { class: 'timeline-legend' },
    ...TYPES.map((type) => h('span', { class: 'legend-item' },
      h('span', { class: 'legend-swatch', style: { background: COLOR[type] } }),
      TYPE_LABEL[type],
    )),
    sockets.length ? h('span', { class: 'legend-item' },
      h('span', { class: 'legend-swatch', style: { background: COLOR.conn } }), 'Provider socket') : null,
  );

  const timeline = h('div', { class: 'timeline' });
  const rowFor = (ops, label, color, hint) => {
    const track = h('div', { class: 'timeline-track' });
    if (!ops.length) { track.classList.add('is-empty'); track.dataset.empty = 'none captured'; }
    for (const op of ops) track.append(timelineBar(op, total, color));
    track.addEventListener('click', (event) => {
      // Bars handle their own click; anywhere else on the row seeks.
      if (event.target.closest('.timeline-bar')) return;
      const box = track.getBoundingClientRect();
      seekMs(((event.clientX - box.left) / box.width) * total);
    });
    const bars = [...track.querySelectorAll('.timeline-bar')];
    // A 37-span timeline must not be 37 tab stops; the track is one stop and
    // the arrow keys walk the spans inside it.
    bars.forEach((bar, position) => { bar.tabIndex = position === 0 ? 0 : -1; });
    track.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      let next = null;
      if (step) next = bars[bars.indexOf(event.target) + step];
      else if (event.key === 'Home') next = bars[0];
      else if (event.key === 'End') next = bars[bars.length - 1];
      if (!next) return;
      event.preventDefault();
      for (const bar of bars) bar.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    });
    return h('div', { class: 'timeline-row' },
      h('b', { class: 'timeline-label', title: hint || null },
        h('span', { class: 'legend-swatch', style: { background: color } }),
        label,
      ),
      track,
    );
  };

  const timed = [...turnOps, ...loose].filter((op) => !isSocket(op));
  for (const type of TYPES) {
    timeline.append(rowFor(timed.filter((op) => op.type === type), type.toUpperCase(), COLOR[type]));
  }
  // Sockets all span the full call, so stacking them on one row would bury every
  // socket but the topmost under an identical, unclickable bar.
  for (const socket of sockets) {
    const stream = (socket.type || 'ws').toUpperCase();
    timeline.append(rowFor([socket], `${stream} ws`, COLOR.conn, socket.endpoint_id || socket.provider || 'provider socket'));
  }

  const axis = h('div', { class: 'timeline-axis' });
  const ticks = 6;
  for (let index = 0; index <= ticks; index += 1) {
    const fraction = index / ticks;
    const position = index === 0 ? 'at-start' : index === ticks ? 'at-end' : '';
    axis.append(h('span', {
      class: `timeline-tick ${position}`.trim(),
      style: { left: `${fraction * 100}%` },
      text: offset(total * fraction),
    }));
  }

  ui.playhead = h('div', { class: 'timeline-playhead' });
  ui.turnGuides = h('div', { class: 'turn-guides' });

  const surface = h('div', { class: 'timeline-surface' }, ui.turnGuides, timeline, axis, ui.playhead);

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, 'Call timeline', h('span', { class: 'hint', text: 'click a span to inspect it · click empty track to seek audio' })),
      legend,
    ),
    h('div', { class: 'card-body' },
      spans.length ? surface : h('div', { class: 'empty-block' },
        h('b', { text: 'No spans to plot' }),
        h('p', { text: 'This package contained no classified stt, llm, tts or tool operations.' }),
      ),
    ),
  );
}

function timelineBar(op, total, color) {
  const rawStart = Math.max(0, op.started_at_ms || 0);
  const rawEnd = op.ended_at_ms ?? rawStart;
  const start = Math.min(rawStart, total);
  // Guard against reversed or open-ended spans so a bar can never run past the
  // track it is drawn in.
  const end = Math.min(total, Math.max(rawEnd, rawStart + 1));
  const left = (start / total) * 100;
  const width = Math.min(100 - left, Math.max(0.35, ((end - start) / total) * 100));
  const socket = isSocket(op);
  const label = `${TYPE_LABEL[displayType(op)] || op.type} · ${op.endpoint_id || op.request?.name || op.transport || 'operation'}`;
  const span = duration(op.duration_ms ?? (rawEnd - rawStart)) || 'unknown';
  const lasted = socket ? `held open ${span}` : `lasts ${span}`;
  const node = h('button', {
    type: 'button',
    class: 'timeline-bar',
    dataset: { opId: op.event_id },
    style: { left: `${left}%`, width: `${width}%`, background: color },
    'aria-pressed': 'false',
    'aria-label': `${label}, ${lasted}, starting at ${offset(rawStart)}`,
    onClick: () => setSelection('op', op.event_id, { scroll: true }),
  });
  if (op.status === 'cancelled') node.classList.add('is-cancelled');
  if (op.status === 'error') node.classList.add('is-error');

  node.addEventListener('mouseenter', () => showTooltip(node, label, [
    op.turn_id != null ? `turn #${op.turn_id}` : socket ? 'connection scope' : 'ungrouped',
    `starts ${offset(rawStart)}`,
    lasted,
    `status ${op.status || 'unknown'}`,
  ]));
  node.addEventListener('mouseleave', hideTooltip);
  node.addEventListener('focus', () => showTooltip(node, label, [`starts ${offset(rawStart)}`, lasted]));
  node.addEventListener('blur', hideTooltip);
  return node;
}

function showTooltip(anchor, title, lines) {
  const node = $('#tooltip');
  clear(node).append(h('b', { text: title }), ...lines.map((line) => h('span', {}, line, h('br'))));
  node.hidden = false;
  const box = anchor.getBoundingClientRect();
  const own = node.getBoundingClientRect();
  node.style.left = `${Math.max(8, Math.min(window.innerWidth - own.width - 8, box.left + box.width / 2 - own.width / 2))}px`;
  node.style.top = `${box.top - own.height - 8 < 8 ? box.bottom + 8 : box.top - own.height - 8}px`;
}

const hideTooltip = () => { $('#tooltip').hidden = true; };

function drawTurnGuides(turn) {
  if (!ui.turnGuides) return;
  clear(ui.turnGuides);
  if (!turn || !ui.timelineTotal) return;
  // Clock skew can put a turn outside the call span; an unclamped guide would
  // then hang off the track or invert.
  const start = Math.min(ui.timelineTotal, Math.max(0, turn.started_at_ms || 0));
  const end = Math.min(ui.timelineTotal, Math.max(start + 1, turn.ended_at_ms || start + 1));
  const left = clampPercent((start / ui.timelineTotal) * 100, 100);
  ui.turnGuides.append(h('div', {
    class: 'turn-guide',
    style: { left: `${left}%`, width: `${clampPercent(((end - start) / ui.timelineTotal) * 100, 100 - left, 0.4)}%` },
  }));
}

/* ------------------------------------------------------------ transcript */

function buildTranscriptCard(session) {
  const { entries, systemPrompt, modelCallCount, bodiesCaptured } = state.transcript || { entries: [], modelCallCount: 0 };
  const body = h('div', { class: 'card-body scroll-cap' });

  if (!entries.length) {
    body.append(h('div', { class: 'empty-block' },
      h('b', { text: 'No conversation captured' }),
      h('p', {
        text: !modelCallCount
          ? 'The transcript is reconstructed from model requests and responses. This call has no captured llm operations, so there is nothing to show.'
          : bodiesCaptured
            ? `${modelCallCount} model call(s) were recorded but none carried readable message content.`
            : `${modelCallCount} model call(s) were recorded without their request or response bodies, so their words were never stored. Enable body capture in the SDK to read the conversation here.`,
      }),
    ));
    return transcriptCard(body, 0);
  }

  if (systemPrompt) {
    body.append(h('details', { class: 'system-prompt' },
      h('summary', {}, 'System prompt', h('span', { class: 'tag', text: `${systemPrompt.length} chars` })),
      h('pre', { text: systemPrompt }),
    ));
  }

  const firstTurn = (session.turns || [])[0];
  if (firstTurn && !(firstTurn.operations || []).some((op) => op.type === 'llm')) {
    body.append(h('p', { class: 'notice', style: { marginBottom: '8px' } },
      `Turn #${firstTurn.turn_id} played ${duration(firstTurn.tts_ms) || 'audio'} of speech with no model call — a scripted opening line, so its words are not in the capture.`));
  }

  const transcript = h('div', { class: 'transcript' });
  let currentTurn = Symbol('none');
  let group = null;

  for (const entry of entries) {
    if (entry.turnId !== currentTurn) {
      currentTurn = entry.turnId;
      group = h('div', { class: 'transcript-turn', dataset: entry.turnId != null ? { turnId: String(entry.turnId) } : {} });
      transcript.append(group);
    }
    group.append(transcriptMessage(entry));
  }

  body.append(transcript);
  return transcriptCard(body, entries.length);
}

function transcriptCard(body, count) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, 'Conversation', h('span', { class: 'hint', text: 'reconstructed from model requests and responses' })),
      h('span', { class: 'chip', text: `${count} message${count === 1 ? '' : 's'}` }),
    ),
    body,
  );
}

function transcriptMessage(entry) {
  const who = entry.role === 'user' ? 'Caller' : entry.role === 'assistant' ? 'Agent' : entry.role === 'tool' ? 'Tool' : entry.role;
  const tags = [];
  if (entry.turnId != null) tags.push(h('span', { class: 'tag', text: `turn #${entry.turnId}` }));
  if (entry.latency != null && entry.source === 'completion') {
    tags.push(h('span', { class: 'tag', dataset: latencyTone(entry.latency) ? { tone: latencyTone(entry.latency) } : {}, text: `${duration(entry.latency)} model` }));
  }
  if (entry.completion?.model) tags.push(h('span', { class: 'tag', text: entry.completion.model }));
  if (entry.completion?.finishReason && entry.completion.finishReason !== 'stop') {
    tags.push(h('span', { class: 'tag', dataset: { tone: 'warn' }, text: `finish: ${entry.completion.finishReason}` }));
  }
  // Only the reply this call produced failed; the caller line merely sat in
  // its prompt, so tagging that as failed would blame the wrong utterance.
  if (entry.source === 'completion' && entry.op?.status === 'error') {
    tags.push(h('span', { class: 'tag', dataset: { tone: 'danger' }, text: 'failed' }));
  }
  if (entry.completion?.truncated && !entry.repaired) tags.push(h('span', { class: 'tag', dataset: { tone: 'warn' }, text: 'capture truncated' }));

  const toolCalls = entry.toolCalls || [];
  const bodyNodes = [];
  if (entry.role === 'tool') {
    bodyNodes.push(h('pre', { class: 'msg-tool', text: pretty(entry.text) }));
  } else if (entry.text) {
    bodyNodes.push(h('div', { class: 'msg-body', text: entry.text }));
  } else if (toolCalls.length) {
    bodyNodes.push(h('div', { class: 'msg-body' },
      h('span', { class: 'cell-dim', text: 'Requested tools: ' }),
      toolCalls.map((call) => call.name).filter(Boolean).join(', ') || 'unnamed tool',
    ));
  } else {
    bodyNodes.push(h('div', { class: 'msg-body cell-missing', text: entry.completion?.truncated
      ? 'The captured prefix of this response contains no text yet — open the Response tab for what was stored.'
      : 'No text in this response.' }));
  }
  for (const call of toolCalls) {
    if (call.arguments) bodyNodes.push(h('pre', { class: 'msg-tool', text: pretty(call.arguments) }));
  }

  // Only the agent's reply was actually produced by the model call it came
  // from. A caller line merely appeared in that call's prompt, so sending the
  // reviewer to an "LLM · azure-openai" span would misattribute their words.
  const spoken = entry.source === 'completion';
  const target = spoken && entry.op
    ? { kind: 'op', id: entry.op.event_id, hint: 'Inspect the model call that produced this reply' }
    : entry.turnId != null
      ? { kind: 'turn', id: String(entry.turnId), hint: `Inspect turn #${entry.turnId}` }
      : null;

  return h('button', {
    type: 'button',
    class: 'msg',
    dataset: { role: entry.role, opId: spoken ? entry.op?.event_id || '' : '', turnId: entry.turnId != null ? String(entry.turnId) : '' },
    title: target?.hint || 'Nothing to inspect for this line',
    onClick: () => target && setSelection(target.kind, target.id, { scroll: true }),
  },
    h('span', { class: 'msg-role' },
      h('span', { class: 'msg-who', text: who }),
      h('span', { class: 'msg-at', text: offset(entry.at) }),
    ),
    h('span', {}, ...bodyNodes, tags.length ? h('span', { class: 'msg-tags' }, ...tags) : null),
  );
}

/* ----------------------------------------------------------------- turns */

const TURN_COLUMNS = [
  { key: 'turn', label: 'Turn', sortable: true },
  { key: 'speech', label: 'Caller speech', sortable: true },
  { key: 'llm', label: 'Model', sortable: true },
  { key: 'tts', label: 'Speech out', sortable: true },
  { key: 'response', label: 'First audio', sortable: true },
  { key: 'status', label: 'Status', sortable: false },
];

const TURN_VALUE = {
  turn: (turn) => Number(turn.turn_id) || 0,
  speech: (turn) => turn.user_speech_ms,
  llm: (turn) => turn.llm_ms,
  tts: (turn) => turn.tts_ms,
  response: (turn) => turn.time_to_first_audio_ms,
};

/** Sorts rows on a value that can be absent. An unmeasured row is not a fast
 *  row, so it always sinks to the bottom whichever way the column points. */
function compareSortable(left, right, direction) {
  const missingLeft = left == null || left === '' || Number.isNaN(left);
  const missingRight = right == null || right === '' || Number.isNaN(right);
  if (missingLeft || missingRight) return missingLeft && missingRight ? 0 : missingLeft ? 1 : -1;
  const compare = typeof left === 'string' ? left.localeCompare(right) : left - right;
  return compare * (direction === 'asc' ? 1 : -1);
}

function buildTurnsCard(session) {
  const head = h('div', { class: 'row-head turns-grid' });
  for (const column of TURN_COLUMNS) {
    head.append(column.sortable
      ? h('button', {
        type: 'button',
        'aria-label': `Sort by ${column.label}`,
        dataset: { sortKey: column.key },
        onClick: () => {
          const sort = state.turnSort;
          sort.direction = sort.key === column.key && sort.direction === 'asc' ? 'desc' : 'asc';
          sort.key = column.key;
          renderTurnRows();
        },
      }, column.label, h('span', { class: 'sort-caret' }))
      : h('span', { text: column.label }));
  }

  ui.turnHead = head;
  ui.turnRows = h('div', { class: 'rows' });

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, 'Turns', h('span', { class: 'hint', text: 'one row per caller/agent exchange' })),
      h('span', { class: 'chip', text: `${(session.turns || []).length} turn${(session.turns || []).length === 1 ? '' : 's'}` }),
    ),
    h('div', { class: 'card-body flush scroll-cap' }, head, ui.turnRows),
  );
}

function renderTurnRows() {
  const host = ui.turnRows;
  if (!host) return;
  clear(host);

  const turns = [...(state.session?.turns || [])];
  const { key, direction } = state.turnSort;
  const value = TURN_VALUE[key] || TURN_VALUE.turn;
  turns.sort((a, b) => compareSortable(value(a), value(b), direction));

  for (const button of ui.turnHead?.querySelectorAll('button') || []) {
    const active = button.dataset.sortKey === key;
    const label = TURN_COLUMNS.find((column) => column.key === button.dataset.sortKey)?.label || 'column';
    button.setAttribute('aria-label', active
      ? `Sort by ${label}, currently ${direction === 'asc' ? 'ascending' : 'descending'}`
      : `Sort by ${label}`);
    button.dataset.active = String(active);
    $('.sort-caret', button).textContent = active ? (direction === 'asc' ? '↑' : '↓') : '';
  }

  if (!turns.length) {
    host.append(h('div', { class: 'empty-block' },
      h('b', { text: 'No turn spans in this package' }),
      h('p', { text: 'Operations were captured without a turn_id, so they could not be grouped into exchanges. They are still listed under Operations below.' }),
    ));
    return;
  }

  const worst = Math.max(...turns.map((turn) => turn.time_to_first_audio_ms || 0), 1);

  for (const turn of turns) {
    const response = turn.time_to_first_audio_ms;
    const tone = latencyTone(response);
    // A grid of bare numbers is unreadable to a screen reader, and
    // `aria-selected` is invalid outside a grid or listbox, so the row states
    // its own metrics and reports selection as a pressed toggle.
    const announced = [
      `Turn ${turn.turn_id}`,
      `caller speech ${duration(turn.user_speech_ms) || 'not measured'}`,
      `model ${duration(turn.llm_ms) || 'not measured'}${turn.llm_calls > 1 ? ` over ${turn.llm_calls} calls` : ''}`,
      `speech out ${duration(turn.tts_ms) || 'not measured'}`,
      `first audio ${duration(response) || 'not measured'}`,
      `status ${turn.status}`,
    ].join(', ');
    host.append(h('button', {
      type: 'button',
      class: 'row turns-grid',
      dataset: { turnId: turn.turn_id },
      'aria-label': announced,
      'aria-pressed': 'false',
      onClick: () => setSelection('turn', turn.turn_id),
    },
      h('span', { class: 'cell-mono', text: `#${turn.turn_id}` }),
      metricCell(turn.user_speech_ms, 'no stt span'),
      metricCell(turn.llm_ms, 'no model call', turn.llm_calls > 1 ? `${turn.llm_calls} calls` : null),
      metricCell(turn.tts_ms, 'no tts span'),
      h('span', { class: 'bar-cell' },
        response == null
          ? h('span', { class: 'cell-missing', text: 'no first-audio mark' })
          : h('span', { class: 'num', text: duration(response) }),
        response == null ? null : h('span', { class: 'bar-track' }, h('span', {
          class: 'bar-fill',
          dataset: tone ? { tone } : {},
          style: { width: `${Math.max(2, (response / worst) * 100)}%` },
        })),
      ),
      h('span', { class: 'state-dot', dataset: { status: turn.status }, text: turn.status }),
    ));
  }
  syncSelection();
}

function metricCell(value, missingHint, note) {
  // A bare em dash reads as zero; say why the number is absent, visibly.
  if (value == null) return h('span', { class: 'cell-missing', text: missingHint });
  return h('span', { class: 'bar-cell' },
    h('span', { class: 'num', text: duration(value) }),
    note ? h('span', { class: 'cell-dim', style: { fontSize: '10.5px' }, text: note }) : null,
  );
}

/* ------------------------------------------------------------ operations */

const OP_COLUMNS = [
  { key: 'type', label: 'Type', sortable: true },
  { key: 'target', label: 'Target', sortable: true },
  { key: 'start', label: 'Start', sortable: true },
  { key: 'duration', label: 'Duration', sortable: true },
  { key: 'cost', label: 'Cost', sortable: true },
  { key: 'scope', label: 'Scope', sortable: false },
  { key: 'status', label: 'Status', sortable: true },
];

const OP_VALUE = {
  type: (op) => displayType(op) || '',
  target: (op) => operationLabel(op).toLowerCase(),
  start: (op) => op.started_at_ms ?? 0,
  duration: (op) => op.duration_ms,
  cost: (op) => decodeCompletion(op.response).cost?.amount ?? null,
  status: (op) => op.status || '',
};

function hasReportedModelCosts() {
  return (state.session?.operations || []).some((op) => op.type === 'llm' && decodeCompletion(op.response).cost);
}

function visibleOperationColumns() {
  return hasReportedModelCosts() ? OP_COLUMNS : OP_COLUMNS.filter((column) => column.key !== 'cost');
}

function buildOperationsCard() {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filter operations by type' });
  // "conn" is a scope rather than a type, but from the reviewer's point of view
  // it is just another lane of the call they want to isolate.
  for (const type of ['all', ...TYPES, 'conn']) {
    seg.append(h('button', {
      type: 'button',
      dataset: { opType: type },
      'aria-pressed': String(state.opFilter.type === type),
      text: type === 'all' ? 'All' : type.toUpperCase(),
      title: type === 'conn' ? 'Provider socket connections' : null,
      onClick: () => { state.opFilter.type = type; renderOperationRows(); syncOpFilterControls(); writeLocation(); },
    }));
  }

  const errorsToggle = h('button', {
    type: 'button',
    class: 'btn tiny',
    dataset: { role: 'errors-only' },
    'aria-pressed': String(state.opFilter.errorsOnly),
    text: 'Failures only',
    onClick: () => { state.opFilter.errorsOnly = !state.opFilter.errorsOnly; renderOperationRows(); syncOpFilterControls(); writeLocation(); },
  });

  const search = h('input', {
    type: 'search',
    class: 'filter-input',
    placeholder: 'Search endpoint or tool',
    'aria-label': 'Search operations',
    onInput: (event) => { state.opFilter.query = event.target.value; renderOperationRows(); writeLocation(); },
  });

  ui.opSeg = seg;
  ui.opErrors = errorsToggle;
  ui.opSearch = search;
  ui.opCount = h('span', { class: 'chip' });
  ui.opRows = h('div', { class: 'rows' });

  const head = h('div', { class: `row-head ops-grid${hasReportedModelCosts() ? ' with-cost' : ''}` });
  for (const column of visibleOperationColumns()) {
    head.append(column.sortable
      ? h('button', {
        type: 'button',
        'aria-label': `Sort by ${column.label}`,
        dataset: { sortKey: column.key },
        onClick: () => {
          const sort = state.opSort;
          sort.direction = sort.key === column.key && sort.direction === 'asc' ? 'desc' : 'asc';
          sort.key = column.key;
          renderOperationRows();
        },
      }, column.label, h('span', { class: 'sort-caret' }))
      : h('span', { text: column.label }));
  }
  ui.opHead = head;

  ui.opsCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, 'Operations', ui.opCount),
      h('div', { class: 'card-tools' }, seg, errorsToggle, search),
    ),
    h('div', { class: 'card-body flush scroll-cap' }, head, ui.opRows),
  );
  return ui.opsCard;
}

function syncOpFilterControls() {
  for (const button of ui.opSeg?.querySelectorAll('button') || []) {
    button.setAttribute('aria-pressed', String(button.dataset.opType === state.opFilter.type));
  }
  if (ui.opErrors) ui.opErrors.setAttribute('aria-pressed', String(state.opFilter.errorsOnly));
  if (ui.opSearch && ui.opSearch.value !== state.opFilter.query) ui.opSearch.value = state.opFilter.query;
}

function operationLabel(op) {
  return op.request?.name || op.endpoint_id || op.provider || op.model || op.transport || 'operation';
}

function renderOperationRows() {
  const host = ui.opRows;
  if (!host) return;
  clear(host);

  const all = state.session?.operations || [];
  const query = state.opFilter.query.trim().toLowerCase();
  const rows = all.filter((op) => {
    if (state.opFilter.type !== 'all' && displayType(op) !== state.opFilter.type) return false;
    if (state.opFilter.errorsOnly && op.status !== 'error') return false;
    if (query && !`${operationLabel(op)} ${op.type} ${op.transport || ''} ${op.event_id}`.toLowerCase().includes(query)) return false;
    return true;
  });

  const { key: sortKey, direction } = state.opSort;
  const value = OP_VALUE[sortKey] || OP_VALUE.start;
  rows.sort((a, b) => {
    // A socket is open for the whole call by definition, so ranking it against
    // per-request durations would always crown it the "slowest operation".
    if (sortKey === 'duration') {
      const socketDelta = Number(isSocket(a)) - Number(isSocket(b));
      if (socketDelta) return socketDelta;
    }
    return compareSortable(value(a), value(b), direction);
  });

  for (const button of ui.opHead?.querySelectorAll('button') || []) {
    const active = button.dataset.sortKey === sortKey;
    const label = visibleOperationColumns().find((column) => column.key === button.dataset.sortKey)?.label || 'column';
    button.setAttribute('aria-label', active
      ? `Sort by ${label}, currently ${direction === 'asc' ? 'ascending' : 'descending'}`
      : `Sort by ${label}`);
    button.dataset.active = String(active);
    $('.sort-caret', button).textContent = active ? (direction === 'asc' ? '↑' : '↓') : '';
  }

  if (ui.opCount) ui.opCount.textContent = rows.length === all.length ? `${all.length}` : `${rows.length} of ${all.length}`;

  if (!rows.length) {
    host.append(h('div', { class: 'empty-block' },
      h('b', { text: all.length ? 'No operations match these filters' : 'No operations captured' }),
      all.length
        ? h('button', { type: 'button', class: 'btn tiny', text: 'Clear filters', onClick: () => { state.opFilter = { type: 'all', errorsOnly: false, query: '' }; if (ui.opSearch) ui.opSearch.value = ''; renderOperationRows(); syncOpFilterControls(); writeLocation(); } })
        : h('p', { text: 'The uploaded package contained no stt, llm, tts or tool events.' }),
    ));
    return;
  }

  // Provider sockets run for the whole call, so scaling every bar against them
  // would flatten the per-turn spans this table exists to compare.
  const scaled = rows.filter((op) => !isSocket(op));
  const longest = Math.max(...(scaled.length ? scaled : rows).map((op) => op.duration_ms || 0), 1);

  for (const op of rows) {
    const reportedCost = op.type === 'llm' ? decodeCompletion(op.response).cost : null;
    const timing = op.duration_ms == null ? 'not timed'
      : isSocket(op) ? `open ${duration(op.duration_ms)}` : duration(op.duration_ms);
    const announced = [
      `${TYPE_LABEL[displayType(op)] || op.type}: ${operationLabel(op)}`,
      `starts ${offset(op.started_at_ms)}`,
      timing,
      op.turn_id != null ? `turn ${op.turn_id}` : isSocket(op) ? 'whole call' : 'ungrouped',
      `status ${op.status || 'unknown'}`,
    ].join(', ');
    host.append(h('button', {
      type: 'button',
      class: `row ops-grid${hasReportedModelCosts() ? ' with-cost' : ''}`,
      dataset: { opId: op.event_id },
      'aria-label': announced,
      'aria-pressed': 'false',
      onClick: () => setSelection('op', op.event_id),
    },
      h('span', { class: 'type-tag', dataset: { type: displayType(op) }, text: (displayType(op) || '').toUpperCase() }),
      h('span', { class: 'cell-dim', style: { color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: operationLabel(op), text: operationLabel(op) }),
      h('span', { class: 'num cell-dim', text: offset(op.started_at_ms) }),
      h('span', { class: 'bar-cell' },
        op.duration_ms == null
          ? h('span', { class: 'cell-missing', text: 'not timed' })
          : h('span', { class: 'num', title: isSocket(op) ? 'Socket lifetime, not a per-request latency' : null, text: isSocket(op) ? `open ${duration(op.duration_ms)}` : duration(op.duration_ms) }),
        h('span', { class: 'bar-track' }, h('span', {
          class: 'bar-fill',
          dataset: isSocket(op) ? { full: 'true' } : {},
          style: { width: `${Math.min(100, Math.max(2, ((op.duration_ms || 0) / longest) * 100))}%`, background: COLOR[displayType(op)] || 'var(--accent)' },
        })),
      ),
      hasReportedModelCosts()
        ? h('span', {
          class: reportedCost ? 'num cell-dim' : 'cell-missing',
          title: reportedCost && !reportedCost.currency ? 'Provider reported this amount without a currency code' : null,
          text: formatReportedCost(reportedCost) || 'not reported',
        })
        : null,
      h('span', { class: 'cell-dim', text: op.turn_id != null ? `turn #${op.turn_id}` : isSocket(op) ? 'whole call' : 'ungrouped' }),
      h('span', { class: 'state-dot', dataset: { status: op.status }, text: op.status || '—' }),
    ));
  }
  syncSelection();
}

/* ------------------------------------------------------------- inspector */

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'request', label: 'Request' },
  { key: 'response', label: 'Response' },
  { key: 'timing', label: 'Timing' },
  { key: 'raw', label: 'Raw' },
];

function buildInspectorCard() {
  ui.inspectorTabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Inspector sections' });
  for (const tab of TABS) {
    ui.inspectorTabs.append(h('button', {
      type: 'button',
      role: 'tab',
      id: `tab-${tab.key}`,
      'aria-controls': 'inspector-panel',
      dataset: { tab: tab.key },
      'aria-selected': String(state.inspectorTab === tab.key),
      tabindex: state.inspectorTab === tab.key ? '0' : '-1',
      text: tab.label,
      onClick: () => { state.inspectorTab = tab.key; renderInspector(); writeLocation(); },
    }));
  }
  // Tablists are a single tab stop; arrows move between the tabs inside it.
  ui.inspectorTabs.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const usable = [...ui.inspectorTabs.querySelectorAll('button')].filter((button) => !button.hidden && !button.disabled);
    if (!usable.length) return;
    let next = null;
    if (step) next = usable[(usable.indexOf(event.target) + step + usable.length) % usable.length];
    else if (event.key === 'Home') next = usable[0];
    else if (event.key === 'End') next = usable[usable.length - 1];
    if (!next) return;
    event.preventDefault();
    state.inspectorTab = next.dataset.tab;
    renderInspector();
    writeLocation();
    next.focus();
  });
  ui.inspectorPanel = h('div', { class: 'tab-panel', role: 'tabpanel', id: 'inspector-panel', tabindex: '0' });
  ui.inspectorTitle = h('h3', { text: 'Inspector' });
  ui.inspectorTools = h('div', { class: 'card-tools' });

  return h('section', { class: 'card inspector' },
    h('div', { class: 'card-head' }, ui.inspectorTitle, ui.inspectorTools),
    ui.inspectorTabs,
    ui.inspectorPanel,
  );
}

function availableTabs(subject, isOperation) {
  if (!subject) return TABS;
  return isOperation ? TABS : TABS.filter((tab) => ['overview', 'timing', 'raw'].includes(tab.key));
}

function renderInspector() {
  if (!ui.inspectorPanel) return;
  const op = selectedOperation();
  const turn = state.selection?.kind === 'turn' ? selectedTurn() : null;
  const subject = op || turn;
  const tabs = availableTabs(subject, Boolean(op));
  if (!tabs.some((tab) => tab.key === state.inspectorTab)) state.inspectorTab = tabs[0].key;

  for (const button of ui.inspectorTabs.querySelectorAll('button')) {
    const allowed = tabs.some((tab) => tab.key === button.dataset.tab);
    button.hidden = !allowed;
    const selected = allowed && button.dataset.tab === state.inspectorTab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.disabled = !subject;
  }

  clear(ui.inspectorTools);
  ui.inspectorPanel.setAttribute('aria-labelledby', `tab-${state.inspectorTab}`);
  ui.inspectorTitle.textContent = op
    ? `${(displayType(op) || '').toUpperCase()} · ${operationLabel(op)}`
    : turn ? `Turn #${turn.turn_id}` : 'Inspector';

  if (subject) {
    ui.inspectorTools.append(h('button', {
      type: 'button', class: 'btn tiny', text: 'Copy JSON',
      onClick: () => copy(JSON.stringify(subject, null, 2), op ? 'Operation JSON' : 'Turn JSON'),
    }));
  }

  const panel = clear(ui.inspectorPanel);
  if (!subject) {
    panel.append(h('div', { class: 'empty-block' },
      h('b', { text: 'Nothing selected' }),
      h('p', { text: 'Pick a span on the timeline, a message in the conversation, or a row in the turns or operations tables to inspect it here.' }),
    ));
    return;
  }

  const tab = state.inspectorTab;
  if (op) renderOperationTab(panel, op, tab);
  else renderTurnTab(panel, turn, tab);
}

function truncationNotice(originalBytes, which) {
  return h('div', { class: 'banner', dataset: { tone: 'warn' }, style: { marginBottom: '10px' } },
    h('div', {},
      h('b', { text: 'Capture truncated' }),
      h('span', { text: `The SDK stored only the first part of this ${which}${originalBytes ? ` (${bytes(originalBytes)} original)` : ''}, so anything below is a prefix.` }),
    ),
  );
}

function codeBlock(panel, title, value, { copyLabel } = {}) {
  const text = typeof value === 'string' ? value : pretty(value);
  panel.append(h('div', { class: 'code-head' },
    h('h4', { text: title }),
    text ? h('button', { type: 'button', class: 'btn tiny', text: 'Copy', onClick: () => copy(text, copyLabel || title) }) : null,
  ));
  panel.append(text ? h('pre', { class: 'code', text }) : h('p', { class: 'notice', text: 'Not captured for this operation.' }));
}

function definitions(pairs) {
  const list = h('dl', { class: 'kv' });
  for (const [term, value, mono] of pairs) {
    if (value == null || value === '') continue;
    list.append(h('dt', { text: term }), h('dd', { class: mono ? 'mono' : '', text: String(value) }));
  }
  return list;
}

function wallClock(offsetMs) {
  const started = parseDate(state.session?.manifest?.started_at);
  if (!started || offsetMs == null) return null;
  // The fraction belongs to the resulting instant, not to the offset alone.
  const at = new Date(started.getTime() + offsetMs);
  return `${at.toLocaleTimeString(undefined, { hour12: false })}.${String(at.getMilliseconds()).padStart(3, '0')}`;
}

function renderOperationTab(panel, op, tab) {
  if (tab === 'overview') {
    panel.append(definitions([
      ['Type', TYPE_LABEL[displayType(op)] || op.type],
      ['Target', operationLabel(op)],
      ['Transport', op.transport],
      ['Model', op.model],
      ['Provider', op.provider],
      ['Scope', op.turn_id != null ? `turn #${op.turn_id}` : isSocket(op) ? 'whole call' : 'ungrouped'],
      ['Status', op.status],
      ['Starts at', offset(op.started_at_ms)],
      ['Ends at', op.ended_at_ms == null ? 'still open' : offset(op.ended_at_ms)],
      [isSocket(op) ? 'Open for' : 'Duration', duration(op.duration_ms) || '—'],
      ['Wall clock', wallClock(op.started_at_ms)],
      ['Event id', op.event_id, true],
    ]));
    if (op.error) codeBlock(panel, 'Error', op.error);
    if (op.type === 'llm') {
      const completion = decodeCompletion(op.response);
      if (completion.truncated) panel.append(truncationNotice(completion.originalBytes, 'response'));
      if (completion.text || completion.toolCalls.length) {
        codeBlock(panel, 'Agent said', completion.text || `(no text — requested ${completion.toolCalls.map((call) => call.name).join(', ')})`);
      }
      if (completion.usage) codeBlock(panel, 'Token usage', completion.usage);
      if (completion.cost) codeBlock(panel, 'Provider-reported cost', completion.cost);
    }
    if (op.type === 'tool') {
      codeBlock(panel, 'Tool input', op.request?.input);
      codeBlock(panel, 'Tool result', op.response?.result);
    }
    if (op.turn_id != null) {
      panel.append(h('div', { class: 'code-head' },
        h('h4', { text: 'Related' }),
        h('button', { type: 'button', class: 'btn tiny', text: `Open turn #${op.turn_id}`, onClick: () => setSelection('turn', String(op.turn_id), { scroll: true }) }),
      ));
    }
    return;
  }

  if (tab === 'request') {
    if (op.type === 'llm') {
      const { request, truncated, originalBytes, unparsed } = parseRequestBody(op);
      if (truncated) panel.append(truncationNotice(originalBytes, 'request'));
      if (unparsed) { codeBlock(panel, 'Captured prefix', unparsed); return; }
      const { messages, ...params } = request;
      if (Object.keys(params).length) codeBlock(panel, 'Parameters', params);
      if (Array.isArray(messages)) {
        panel.append(h('div', { class: 'code-head' }, h('h4', { text: `Messages (${messages.length})` })));
        for (const message of messages) {
          panel.append(h('div', { class: 'msg', dataset: { role: message.role }, style: { cursor: 'default' } },
            h('span', { class: 'msg-role' }, h('span', { class: 'msg-who', text: message.role })),
            h('span', { class: 'msg-body', text: messageText(message) || (message.tool_calls ? `→ ${message.tool_calls.map((call) => call.function?.name).join(', ')}` : '(empty)') }),
          ));
        }
      }
      return;
    }
    codeBlock(panel, 'Request', op.request && Object.keys(op.request).length ? op.request : null);
    return;
  }

  if (tab === 'response') {
    if (op.type === 'llm') {
      const completion = decodeCompletion(op.response);
      if (completion.truncated) panel.append(truncationNotice(completion.originalBytes, 'response'));
      panel.append(definitions([
        ['Model', completion.model],
        ['Provider-reported cost', formatReportedCost(completion.cost)],
        ['Finish reason', completion.finishReason || (completion.truncated ? 'not in the captured prefix' : null)],
        ['HTTP status', op.response?.status],
        ['Alternatives', completion.alternatives
          ? `${completion.alternatives} unspoken (only choice 0 reached the caller)` : null],
      ]));
      codeBlock(panel, 'Decoded reply', completion.text || null);
      for (const call of completion.toolCalls) codeBlock(panel, `Tool call · ${call.name || 'unnamed'}`, call.arguments);
      if (completion.usage) codeBlock(panel, 'Usage', completion.usage);
      codeBlock(panel, completion.truncated ? 'Captured response prefix' : 'Raw response body', unwrapBody(op.response?.body).value ?? null);
      return;
    }
    codeBlock(panel, 'Response', op.response && Object.keys(op.response).length ? op.response : null);
    return;
  }

  if (tab === 'timing') {
    const milestones = Object.entries(op.milestones || {});
    panel.append(definitions([
      ['Starts at', offset(op.started_at_ms)],
      ['Ends at', op.ended_at_ms == null ? 'still open' : offset(op.ended_at_ms)],
      [isSocket(op) ? 'Open for' : 'Duration', duration(op.duration_ms) || '—'],
    ]));
    if (!milestones.length) { panel.append(h('p', { class: 'notice', text: 'No milestones were recorded inside this span.' })); return; }

    const start = op.started_at_ms || 0;
    const span = Math.max(1, (op.ended_at_ms ?? start) - start);
    panel.append(h('div', { class: 'code-head' }, h('h4', { text: 'Milestones' })));
    const waterfall = h('div', { class: 'waterfall' });
    for (const [name, value] of milestones) {
      const at = value?.occurred_at_ms ?? 0;
      const last = value?.last_at_ms ?? at;
      waterfall.append(h('div', { class: 'waterfall-row', title: `${name} · ${value?.count ?? 1} event(s)` },
        h('span', { class: 'cell-dim', style: { overflow: 'hidden', textOverflow: 'ellipsis' }, text: name.replace(/_/g, ' ') }),
        h('span', { class: 'waterfall-track' }, h('span', {
          class: 'waterfall-fill',
          style: waterfallGeometry(at, last, start, span, COLOR[displayType(op)]),
        })),
        h('span', { class: 'num cell-dim', text: offset(at) }),
      ));
    }
    panel.append(waterfall);
    panel.append(h('div', { class: 'code-head' }, h('h4', { text: 'Milestone detail' })));
    panel.append(h('pre', { class: 'code', text: pretty(op.milestones) }));
    return;
  }

  codeBlock(panel, 'Operation JSON', op, { copyLabel: 'Operation JSON' });
}

function renderTurnTab(panel, turn, tab) {
  if (tab === 'raw') {
    const { operations, ...rest } = turn;
    codeBlock(panel, 'Turn JSON', { ...rest, operation_count: (operations || []).length });
    return;
  }

  if (tab === 'timing' || tab === 'overview') {
    panel.append(definitions([
      ['Turn', `#${turn.turn_id}`],
      ['Status', turn.status],
      ['Starts at', offset(turn.started_at_ms)],
      ['Ends at', offset(turn.ended_at_ms)],
      ['Turn length', duration(turn.duration_ms) || '—'],
      ['Caller speech', duration(turn.user_speech_ms) || 'no stt span'],
      ['Model time', turn.llm_ms == null ? 'no model call' : `${duration(turn.llm_ms)} over ${turn.llm_calls} call(s)`],
      ['Speech out', duration(turn.tts_ms) || 'no tts span'],
      ['Time to first audio', duration(turn.time_to_first_audio_ms) || 'not measurable'],
    ]));

    const ops = [...(turn.operations || [])].sort((a, b) => (a.started_at_ms || 0) - (b.started_at_ms || 0));
    if (ops.length) {
      const start = turn.started_at_ms || 0;
      const span = Math.max(1, (turn.ended_at_ms || start) - start);
      panel.append(h('div', { class: 'code-head' }, h('h4', { text: `Operations (${ops.length})` })));
      const waterfall = h('div', { class: 'waterfall' });

      // Without these marks, "why was first audio 2.81s" means eyeballing
      // overlapping bars. Anchor the answer: where the caller stopped talking
      // and where the first reply frame actually reached them.
      const speechEnd = ops.find((op) => op.type === 'stt')?.ended_at_ms;
      const firstAudio = ops.find((op) => op.type === 'tts')?.milestones?.audio_chunk?.occurred_at_ms;
      const marker = (at, label, tone) => waterfall.append(h('span', {
        class: 'waterfall-mark',
        dataset: { tone },
        style: { left: `calc(var(--wf-label) + var(--wf-gap) + (100% - var(--wf-label) - var(--wf-gap) - var(--wf-value) - var(--wf-gap)) * ${Math.max(0, Math.min(1, (at - start) / span))})` },
        title: `${label} at ${offset(at)}`,
      }, h('span', { class: 'waterfall-mark-label', text: label })));
      if (speechEnd != null) marker(speechEnd, 'caller stops', 'neutral');
      if (firstAudio != null) marker(firstAudio, `first audio +${duration(turn.time_to_first_audio_ms)}`, latencyTone(turn.time_to_first_audio_ms));
      for (const op of ops) {
        waterfall.append(h('button', {
          type: 'button',
          class: 'waterfall-row',
          style: { background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', color: 'inherit', width: '100%' },
          title: `Inspect ${operationLabel(op)}`,
          onClick: () => setSelection('op', op.event_id, { scroll: true }),
        },
          h('span', { class: 'type-tag', dataset: { type: displayType(op) }, text: (displayType(op) || '').toUpperCase() }),
          h('span', { class: 'waterfall-track' }, h('span', {
            class: 'waterfall-fill',
            style: waterfallGeometry(op.started_at_ms || 0, op.ended_at_ms ?? op.started_at_ms ?? 0,
              start, span, COLOR[displayType(op)]),
          })),
          h('span', { class: 'num cell-dim', text: duration(op.duration_ms) || '—' }),
        ));
      }
      panel.append(waterfall);
    }
    return;
  }

  panel.append(h('div', { class: 'empty-block' },
    h('b', { text: 'Nothing to show for this tab' }),
    h('p', { text: 'Open one of the turn’s operations from the Overview tab to read its request and response.' }),
  ));
}

/* ----------------------------------------------------------------- audio */

function buildAudioCard(session) {
  const recordings = session.recordings || [];
  const uploaded = recordings.filter((track) => track.uploaded);
  const body = h('div', { class: 'card-body' });

  const card = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', {}, 'Audio', h('span', { class: 'hint', text: 'aligned to the call clock' })),
    ),
    body,
  );

  if (!uploaded.length) {
    body.append(h('div', { class: 'empty-block' },
      h('b', { text: 'No audio uploaded' }),
      h('p', { text: recordings.length ? 'The manifest declares tracks, but their objects never reached the observer.' : 'This package declared no audio tracks.' }),
    ));
    return card;
  }

  const tracks = [];
  if (uploaded.length > 1) tracks.push({ id: 'mixed', label: 'Both', note: 'caller and agent mixed on the call clock' });
  for (const track of uploaded) {
    tracks.push({ id: track.track, label: track.track === 'caller' ? 'Caller' : track.track === 'agent' ? 'Agent' : track.track, note: `${bytes(track.size_bytes)} · ${track.sample_rate_hz} Hz · ${track.encoding}` });
  }

  const audio = new Audio();
  // Media events queued for a call that has been closed would otherwise keep
  // its DOM alive and write into the next call's controls.
  const listeners = new AbortController();
  const bind = (type, handler) => audio.addEventListener(type, handler, { signal: listeners.signal });
  state.audioListeners = listeners;
  audio.preload = 'metadata';
  state.audio = audio;

  const switcher = h('div', { class: 'seg', role: 'group', 'aria-label': 'Choose an audio track' });
  const note = h('p', { class: 'track-note' });
  const drift = h('p', { class: 'track-note', hidden: true });
  const error = h('p', { class: 'audio-error', hidden: true });

  const icon = (path, size = 13) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    node.setAttribute('fill', 'currentColor');
    node.setAttribute('d', path);
    svg.append(node);
    return svg;
  };
  const PLAY = 'M5.2 3.3a.8.8 0 0 1 1.2-.68l6 4.7a.8.8 0 0 1 0 1.36l-6 4.7A.8.8 0 0 1 5.2 12.7Z';
  const PAUSE = 'M5 3h2.2v10H5Zm3.8 0H11v10H8.8Z';
  const SPEAKER = 'M8.2 2.3a.7.7 0 0 1 .4.63v10.14a.7.7 0 0 1-1.14.55L4.6 11.2H2.7a.7.7 0 0 1-.7-.7V5.5a.7.7 0 0 1 .7-.7h1.9l2.86-2.42a.7.7 0 0 1 .74-.08Zm2.5 2.1a.7.7 0 0 1 .98.13 5.7 5.7 0 0 1 0 6.94.7.7 0 1 1-1.11-.85 4.3 4.3 0 0 0 0-5.24.7.7 0 0 1 .13-.98Z';

  const playIcon = icon(PLAY, 14);
  const playButton = h('button', { type: 'button', class: 'play-btn', 'aria-label': 'Play', title: 'Play or pause (space)', onClick: togglePlay }, playIcon);

  const fill = h('span', { class: 'scrub-fill' });
  const head = h('span', { class: 'scrub-head' });
  const scrub = h('div', {
    class: 'scrub',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Seek within the call',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
    onClick: (event) => {
      if (!Number.isFinite(audio.duration)) return;
      const fraction = (event.clientX - scrub.getBoundingClientRect().left) / scrub.clientWidth;
      audio.currentTime = Math.max(0, Math.min(audio.duration, fraction * audio.duration));
    },
    onKeydown: (event) => {
      const step = event.shiftKey ? 10 : 5;
      if (event.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + step); event.preventDefault(); }
      if (event.key === 'ArrowLeft') { audio.currentTime = Math.max(0, audio.currentTime - step); event.preventDefault(); }
      if (event.key === 'ArrowUp') { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + step); event.preventDefault(); }
      if (event.key === 'ArrowDown') { audio.currentTime = Math.max(0, audio.currentTime - step); event.preventDefault(); }
      if (event.key === 'PageUp') { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + step * 6); event.preventDefault(); }
      if (event.key === 'PageDown') { audio.currentTime = Math.max(0, audio.currentTime - step * 6); event.preventDefault(); }
      if (event.key === 'Home') { audio.currentTime = 0; event.preventDefault(); }
      if (event.key === 'End' && Number.isFinite(audio.duration)) { audio.currentTime = audio.duration; event.preventDefault(); }
      if (event.key === 'Enter' || event.key === ' ') { togglePlay(); event.preventDefault(); }
    },
  }, fill, head);

  const current = h('span', { text: '0:00' });
  const total = h('span', { text: '--:--' });

  const volume = h('input', {
    type: 'range', min: '0', max: '1', step: '0.05', value: '1',
    'aria-label': 'Volume',
    onInput: (event) => { audio.volume = Number(event.target.value); },
  });

  const download = h('a', { class: 'btn tiny', download: '', text: 'Download WAV' });

  body.append(h('div', { class: 'player' },
    switcher,
    note,
    h('div', { class: 'player-scrub' }, scrub, h('div', { class: 'scrub-time' }, current, total)),
    h('div', { class: 'player-controls' },
      playButton,
      h('label', { class: 'player-vol' }, icon(SPEAKER, 13), volume),
      download,
    ),
    drift,
    error,
  ));

  function togglePlay() {
    if (audio.paused) audio.play().catch((reason) => { error.hidden = false; error.textContent = `Playback failed: ${reason.message}`; });
    else audio.pause();
  }
  ui.togglePlay = togglePlay;

  let loadToken = 0;
  let expectedSrc = '';
  let resume = null;
  function chooseTrack(id) {
    const token = ++loadToken;
    state.audioTrack = id;
    const wasPlaying = !audio.paused;
    const at = audio.currentTime;
    audio.src = `/v1/sessions/${encodeURIComponent(session.id)}/audio/${encodeURIComponent(id)}?preview=wav`;
    expectedSrc = audio.src;
    download.href = audio.src;
    download.setAttribute('download', `${session.id}-${id}.wav`);
    error.hidden = true;
    note.textContent = tracks.find((track) => track.id === id)?.note || '';
    for (const button of switcher.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.track === id));
    // Switching tracks fires a fresh `loadedmetadata`; only the newest request
    // is allowed to restore the previous position and resume playback.
    resume = { token, at, wasPlaying };
  }

  for (const track of tracks) {
    switcher.append(h('button', {
      type: 'button', dataset: { track: track.id }, 'aria-pressed': 'false', text: track.label,
      onClick: () => chooseTrack(track.id),
    }));
  }

  bind('timeupdate', () => {
    if (state.audio !== audio) return;
    const fraction = audio.duration ? audio.currentTime / audio.duration : 0;
    fill.style.width = `${fraction * 100}%`;
    head.style.left = `${fraction * 100}%`;
    scrub.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    scrub.setAttribute('aria-valuetext', `${clock(audio.currentTime)} of ${clock(audio.duration)}`);
    current.textContent = clock(audio.currentTime);
    if (ui.playhead && ui.playheadAligned && ui.timelineTotal) {
      const position = Math.max(0, Math.min(1, (audio.currentTime * 1000) / ui.timelineTotal));
      ui.playhead.classList.add('is-on');
      ui.playhead.style.left = `calc((100% - var(--track-inset)) * ${position})`;
    }
  });
  bind('loadedmetadata', () => {
    // A queued event from a track the reviewer has already switched away from
    // must not publish its duration or alignment as the current track's.
    if (state.audio !== audio || !sameSource(audio.currentSrc, expectedSrc)) return;
    total.textContent = clock(audio.duration);
    if (resume && resume.token === loadToken) {
      if (resume.at) audio.currentTime = Math.min(resume.at, audio.duration || resume.at);
      if (resume.wasPlaying) audio.play().catch(() => {});
      resume = null;
    }
    // The preview is rendered against the call clock, but legacy packages
    // without chunk timings play back contiguously. Only drive the timeline
    // playhead when the two clocks actually agree.
    const callMs = session.manifest?.duration_ms || 0;
    const audioMs = (audio.duration || 0) * 1000;
    ui.playheadAligned = callMs > 0 && Math.abs(audioMs - callMs) <= Math.max(2000, callMs * 0.12);
    if (!ui.playheadAligned) {
      ui.playhead?.classList.remove('is-on');
      drift.hidden = false;
      drift.textContent = `This track is ${duration(audioMs)} long against a ${duration(callMs)} call, so it has no chunk timings to align with the timeline.`;
    } else {
      drift.hidden = true;
    }
  });
  bind('play', () => { playIcon.firstChild.setAttribute('d', PAUSE); playButton.setAttribute('aria-label', 'Pause'); });
  bind('pause', () => { playIcon.firstChild.setAttribute('d', PLAY); playButton.setAttribute('aria-label', 'Play'); });
  bind('ended', () => { playIcon.firstChild.setAttribute('d', PLAY); });
  bind('error', () => {
    if (state.audio !== audio || !audio.getAttribute('src')) return;
    if (!sameSource(audio.currentSrc, expectedSrc)) return;
    error.hidden = false;
    error.textContent = `Could not decode the ${state.audioTrack} preview. The observer may not be able to render this encoding.`;
  });

  chooseTrack(tracks[0].id);
  return card;
}

/** Compares a resolved media URL with the relative one we asked for. */
function sameSource(currentSrc, expected) {
  if (!currentSrc || !expected) return true;
  try { return new URL(currentSrc, location.href).href === new URL(expected, location.href).href; }
  catch { return true; }
}

function seekMs(callMs) {
  const audio = state.audio;
  if (!audio) { toast('This call has no audio to seek.'); return; }
  if (!Number.isFinite(audio.duration)) { toast('Audio is still loading — try again in a moment.'); return; }
  if (!ui.playheadAligned) { toast('This track has no chunk timings, so it cannot be seeked from the timeline.'); return; }
  audio.currentTime = Math.max(0, Math.min(audio.duration, callMs / 1000));
}

/* -------------------------------------------------------------- keyboard */

function isTyping(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTyping(event.target)) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  // Space activates a focused control and arrows drive sliders/tabs, so the
  // global shortcuts must never swallow them while a control has focus.
  const onControl = event.target instanceof Element
    && event.target.closest('button, a, [role="slider"], [role="tab"], summary, audio');
  const list = visibleSessions();
  const index = list.findIndex((item) => item.id === state.sessionId);

  // Escape is the only shortcut that still makes sense while a control has
  // focus; the rest would fight the control's own keyboard behaviour.
  if (onControl && event.key !== 'Escape') return;

  if (event.key === 'j' || event.key === 'ArrowDown') {
    if (list[index + 1]) { selectSession(list[index + 1].id); event.preventDefault(); }
  } else if (event.key === 'k' || event.key === 'ArrowUp') {
    if (list[index - 1]) { selectSession(list[index - 1].id); event.preventDefault(); }
  } else if (event.key === '/') {
    $('#session-search').focus();
    event.preventDefault();
  } else if (event.key.toLowerCase() === 'r') {
    if (!$('#refresh').disabled) loadSessions({ reload: true });
  } else if (event.key === ' ' && state.audio) {
    ui.togglePlay?.();
    event.preventDefault();
  } else if (event.key === 'Escape') {
    setSelection(null, null);
  }
});

/* ------------------------------------------------------------- bootstrap */

$('#refresh').addEventListener('click', () => loadSessions({ reload: true }));
$('#session-search').addEventListener('input', (event) => { state.filter = event.target.value; renderRail(); });
window.addEventListener('scroll', hideTooltip, { passive: true });
window.addEventListener('hashchange', () => {
  if (suppressHashHandling) return;
  const requested = readLocation();
  if (!requested.sessionId) return;
  // Back/forward already moved history, so the next write must diff against
  // where we actually are rather than pushing a duplicate entry.
  lastHistoryPath = `${requested.sessionId}${requested.kind ? `/${requested.kind}/${requested.selectionId}` : ''}`;
  if (requested.sessionId !== state.sessionId) selectSession(requested.sessionId, requested);
  else applyViewState(requested, { render: true });
});

loadSessions({ keepSelection: false });
