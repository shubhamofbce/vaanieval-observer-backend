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
    // A custom property has to go through setProperty; assigning it onto the
    // style object makes a plain JS expando that never reaches the stylesheet.
    else if (key === 'style') {
      for (const [name, item] of Object.entries(value)) {
        if (item == null) continue;
        if (name.startsWith('--')) node.style.setProperty(name, String(item));
        else node.style[name] = item;
      }
    }
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

/** Packages number their turns either `4` or `turn-4`, and the whole interface
 *  writes `#4`. Printed raw the second form reads "#turn-4", and inside a
 *  sentence it becomes "before turn turn-4". */
function turnName(value) {
  const text = String(value ?? '');
  const numbered = text.match(/^turn[-_ ]?(\d+)$/i);
  return numbered ? numbered[1] : text;
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
  const seconds = Math.round((window.vaaniNow() - date.getTime()) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  const units = [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800], ['month', 2629800], ['year', 31557600]];
  let [unit, size] = units[0];
  for (const candidate of units) if (Math.abs(seconds) >= candidate[1]) [unit, size] = candidate;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return format.format(-Math.round(seconds / size), unit);
}

/** A rail-width age. The full "28 minutes ago" gets clipped to "28 minutes" in
 *  a dense row, which reads as a duration — and the column beside it really is
 *  one. A compact form is unambiguous and leaves the agent name room to breathe. */
/** The day a call belongs to, as the rail's group heading. Naming the day once
 *  per group is cheaper than stamping "1d" on all sixty-eight rows, and it is
 *  the only thing that told two 21:40 calls apart. */
function dayLabel(value) {
  const date = parseDate(value);
  if (!date) return 'Unknown date';
  const start = (input) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const days = Math.round((start(window.vaaniDate()) - start(date)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: days > 300 ? 'numeric' : undefined });
}

function absoluteTime(value) {
  const date = parseDate(value);
  if (!date) return 'No timestamp recorded';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

function clockTime(value) {
  const date = parseDate(value);
  return date ? date.toLocaleTimeString(undefined, { hour12: false }) : '—';
}

function percentile(values, fraction) {  if (!values.length) return null;
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

/**
 * Recovers whole JSON objects from the front of a truncated body.
 *
 * The SDK stores a head-only byte prefix, so a captured prompt is almost always
 * cut mid-object and a strict parse of the whole thing always fails. Throwing
 * the prefix away loses the messages that ARE complete inside it, which is why
 * the conversation silently empties out on exactly the long calls a reviewer
 * opened the tool to read. Scanning for balanced braces after `"messages":[`
 * salvages every complete message and stops at the first partial one.
 */
function salvageMessages(text) {
  const anchor = text.indexOf('"messages"');
  if (anchor === -1) return [];
  const open = text.indexOf('[', anchor);
  if (open === -1) return [];

  const messages = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          if (parsed && typeof parsed === 'object') messages.push(parsed);
        } catch { /* a complete-looking object that still will not parse */ }
        start = -1;
      }
    } else if (character === ']' && depth === 0) {
      break;
    }
  }
  return messages;
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
    const messages = salvageMessages(value);
    const model = /"model"\s*:\s*"([^"]+)"/.exec(value)?.[1];
    const request = {};
    if (model) request.model = model;
    if (messages.length) request.messages = messages;
    return { request, truncated: true, originalBytes, unparsed: value, salvaged: messages.length > 0 };
  }
}

/**
 * Decodes one chat-completions response, streamed or not, into the parts a
 * reviewer cares about: what the agent said, which tools it asked for, and why
 * generation stopped.
 *
 * Memoized on the response object: rendering and sorting both ask the same
 * question about the same operations many times per keystroke, and decoding a
 * streamed body means re-parsing every SSE frame. Session payloads are replaced
 * wholesale on reload, so identity is a sound cache key.
 */
const completionCache = new WeakMap();

function decodeCompletion(response) {
  if (!response || typeof response !== 'object') return decodeCompletionUncached(response);
  const cached = completionCache.get(response);
  if (cached) return cached;
  const decoded = decodeCompletionUncached(response);
  completionCache.set(response, decoded);
  return decoded;
}

function decodeCompletionUncached(response) {
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
    // Framework spans report token accounting flat rather than under `usage`.
    // Without this the tokens the UI promises are on this span read as absent.
    if (!result.usage && (payload.total_tokens != null || payload.prompt_tokens != null || payload.ttft_ms != null)) {
      result.usage = payload;
    }
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
  try { absorbPayload(JSON.parse(body)); } catch {
    // A body that opens like JSON but will not parse is a truncated capture,
    // not something the agent said. Rendering it as speech puts raw braces in
    // the transcript and claims the agent uttered them.
    if (unwrapped.truncated || /^\s*[{[]/.test(body)) result.truncated = true;
    else result.text = body;
  }
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

  if (!entries.length) {
    // No LLM bodies were captured. For a voice agent that is the normal case,
    // and the spoken conversation is recorded on the STT and TTS spans.
    const voice = buildVoiceTranscript(operations);
    if (voice.entries.length) {
      return { entries: voice.entries, systemPrompt, modelCallCount: calls.length, bodiesCaptured, source: 'voice' };
    }
    return { entries, systemPrompt, modelCallCount: calls.length, bodiesCaptured, voice };
  }
  return { entries, systemPrompt, modelCallCount: calls.length, bodiesCaptured };
}

/** The conversation as it was actually spoken.
 *
 *  `buildTranscript` reconstructs the dialogue from LLM request/response
 *  bodies, which is the only source an HTTP-instrumented agent has. A voice
 *  agent recorded through the LiveKit integration captures no LLM bodies at
 *  all, so that path produced a permanently empty Transcript tab even though
 *  the STT and TTS spans carried both halves of the conversation verbatim.
 *
 *  These spans are also the better source where they exist: `stt.transcript` is
 *  what the caller was heard to say and `tts.text` is what was actually played
 *  to them, whereas the LLM bodies are what the model was asked and what it
 *  proposed -- which on an interrupted reply is not what anyone heard. */
function buildVoiceTranscript(operations) {
  const entries = [];
  let spokenOps = 0;
  let contentCaptured = false;
  for (const op of operations) {
    const isUser = op.type === 'stt';
    if (!isUser && op.type !== 'tts') continue;
    const response = op.response || {};
    const text = (isUser ? response.transcript : response.text) || '';
    // A span with a character count but no characters is content capture being
    // switched off, not a silent participant. Counted so the empty state can
    // say which of the two it is.
    if (text || response.char_count || response.characters_count) spokenOps += 1;
    if (!text) continue;
    contentCaptured = true;
    entries.push({
      role: isUser ? 'user' : 'assistant',
      text,
      toolCalls: [],
      at: op.started_at_ms,
      turnId: op.turn_id ?? null,
      op,
      latency: isUser ? null : op.duration_ms,
      source: 'voice',
    });
  }
  entries.sort((a, b) => (a.at || 0) - (b.at || 0));
  return { entries, spokenOps, contentCaptured };
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
  callView: 'trace',
  expanded: new Set(),
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
    $('#conn-state').textContent = `Updated ${window.vaaniDate().toLocaleTimeString()}`;
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

  // One line per call. A reviewer scanning hundreds of recordings wants to see
  // as many as the screen allows; the full id and timestamp stay on the title
  // so nothing is lost, it is just no longer shouting.
  //
  // The clock time leads, because it is the field that actually tells two calls
  // apart and the one a reviewer correlates against their own logs. The agent
  // name is printed only on the calls that are *not* the deployment's usual
  // agent: repeating "india-travel-agent" down sixty-three rows spends the
  // widest column in the app to say nothing, and hides the five rows where the
  // agent is the whole story. The usual one is named once, under the filter.
  const counts = new Map();
  for (const item of state.sessions) {
    const name = item.agent_id || 'Untitled agent';
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const usual = ranked.length > 1 && ranked[0][1] > 1 ? ranked[0][0] : null;
  const railAgent = $('#rail-agent');
  if (railAgent) {
    railAgent.hidden = !usual;
    if (usual) {
      railAgent.textContent = `mostly ${usual}`;
      railAgent.title = ranked.map(([name, count]) => `${name} — ${count}`).join('\n');
    }
  }

  let day = null;
  for (const item of list) {
    const started = item.started_at || item.created_at;
    const errors = item.error_count || 0;
    const agent = item.agent_id || 'Untitled agent';
    const odd = usual != null && agent !== usual;
    const itemDay = dayLabel(started);
    if (itemDay !== day) {
      day = itemDay;
      host.append(h('p', { class: 'session-day', text: itemDay }));
    }
    host.append(h('button', {
      type: 'button',
      class: 'session',
      dataset: { agents: odd ? 'many' : 'one' },
      'aria-current': String(item.id === state.sessionId),
      title: `${agent}\n${item.id}\n${absoluteTime(started)}\n${item.turn_count ?? 0} turn${item.turn_count === 1 ? '' : 's'} · ${item.status}${item.outcome ? ` · ${item.outcome}` : ''}${errors ? `\n${errors} failed operation${errors === 1 ? '' : 's'}` : ''}`,
      onClick: () => selectSession(item.id),
    },
      h('span', { class: 'session-dot', dataset: { status: item.status } }),
      h('span', { class: 'session-time num', text: clockTime(started) }),
      odd ? h('span', { class: 'session-agent', text: agent }) : null,
      h('span', { class: 'session-errs', text: errors ? String(errors) : '' }),
      h('span', { class: 'session-dur num', text: duration(item.duration_ms) || '—' }),
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
    view: query.get('view'),
    opType: query.get('type'),
    opErrors: query.get('errors') === '1',
    opQuery: query.get('q'),
    // A reviewer pasting a link into a ticket means "listen to this bit", so
    // the moment travels in the URL alongside the span they had selected.
    at: Number.parseFloat(query.get('t')),
    range: query.get('range'),
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
  if (state.callView !== 'trace') query.set('view', state.callView);
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
  state.callView = requested.view && CALL_VIEWS.some((view) => view.key === requested.view) ? requested.view : 'trace';
  // Handed to the player when it builds, and consumed once: a shared link
  // should place the playhead, not pin it against every later seek.
  const cutFrom = Number.parseFloat((requested.range || '').split('-')[0]);
  const cutTo = Number.parseFloat((requested.range || '').split('-')[1]);
  state.audioCue = Number.isFinite(requested.at) || Number.isFinite(cutFrom)
    ? { at: Number.isFinite(requested.at) ? requested.at : cutFrom, range: Number.isFinite(cutFrom) && cutTo > cutFrom ? { from: cutFrom, to: cutTo } : null }
    : null;
  if (!render) return;

  if (state.session) renderWorkbench(state.session);
  syncOpFilterControls();

  // A link opened while the same call is already on screen never rebuilds the
  // player, so the cue has to be pushed at it rather than waited for.
  ui.applyAudioCue?.();

  const id = requested.selectionId;
  if (id && requested.kind === 'op' && state.opsById.has(id)) setSelection('op', id, { scroll: true });
  else if (id && requested.kind === 'turn' && state.turnsById.has(id)) setSelection('turn', id, { scroll: true });
  else setSelection(null, null);
}

/* -------------------------------------------------------------- selection */

function setSelection(kind, id, { scroll = false } = {}) {
  state.selection = id == null ? null : { kind, id };
  syncSelection({ scroll });
  // Until the audio is actually running there is no playhead to follow, so the
  // live panel shows what the reviewer picked instead. Refreshing it after
  // `syncSelection` keeps its rows from being rebuilt out from under the marks
  // that call has just written.
  ui.liveTrace?.refresh();
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
    state.transcript = buildTranscript(session.operations || []);    state.opsById = new Map((session.operations || []).map((op) => [op.event_id, op]));
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
  releaseSegments();
  ui.deckMetrics?.();
  ui.deckMetrics = null;
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
  ui.turnGuides = null;
  ui.transcriptScroller = null;
  ui.transcriptFollowButton = null;
  ui.transcriptList = null;
  ui.transcriptCard = null;
  ui.transcriptTools = null;
  ui.deckTabs = null;
  ui.deckTabTools = null;
  ui.deckPanels = null;
  ui.liveTrace = null;
  ui.liveTurnId = null;
  ui.togglePlay = null;
  ui.chooseAudioTrack = null;
  ui.setAudioSelection = null;
  ui.markAudioSpan = null;
  ui.playerKeys = null;
  ui.applyAudioCue = null;
  ui.clearAudioSelection = null;
  ui.playheadAligned = false;
  hideTooltip();
}

function captureWarnings(session) {
  const capture = session.manifest?.capture_status || {};
  const warnings = [];
  if (session.status === 'partial' && !(capture.coverage_gaps || []).length) {
    // Zero operations has two very different causes and only the recorder's own
    // audio tap can tell them apart. Reporting the measurement turns "the SDK
    // looks broken" into "your agent never spoke" — which is the failure that
    // actually cost the caller, and the one an operator would otherwise never
    // be told about.
    const measured = capture.measured || {};
    const agentMs = measured.agent_audio_ms;
    // `agent_audio_ms: 0` only means "the agent was silent" when the tap was
    // actually running. With no tap installed it means nothing was ever
    // measured, and telling an operator who mis-wired the SDK that their agent
    // was mute sends them to debug the one thing that was working.
    if (agentMs === 0 && measured.agent_audio_tapped === false) {
      warnings.push('No operations were captured and no audio tap was installed, so the agent was never measured. Pass agent=<your Agent> to observe_agent_session() (and mix in VaaniAudioTapMixin) before concluding anything about this call.');
    } else if (agentMs === 0) {
      warnings.push('No operations were captured, and the recorder measured 0ms of agent audio: the agent never spoke on this call. This is a measurement of your agent, not a gap in capture.');
    } else if (agentMs > 0) {
      warnings.push(`No classified operations were imported, yet the recorder measured ${(agentMs / 1000).toFixed(1)}s of agent audio. The agent spoke but nothing was classified — check that events.jsonl reached the observer.`);
    } else {
      warnings.push('No classified operations were imported, so the timeline and transcript are empty. Check that events.jsonl reached the observer.');
    }
  }
  // A stage that demonstrably ran but produced no span. Reported first and in
  // the SDK's own words, because it is the one warning that says a number on
  // this page is missing rather than merely uncertain.
  for (const gap of capture.coverage_gaps || []) {
    const detail = [
      gap.turn_count ? `${gap.turn_count} turn(s)` : null,
      gap.unattributed_agent_audio_ms ? `${(gap.unattributed_agent_audio_ms / 1000).toFixed(1)}s of agent audio unaccounted for` : null,
      // Over-attribution is the direction that flatters the product, so it is
      // named just as plainly as the direction that shortchanges it.
      gap.overattributed_agent_audio_ms ? `${(gap.overattributed_agent_audio_ms / 1000).toFixed(1)}s more agent audio reported than was rendered` : null,
    ].filter(Boolean).join(', ');
    warnings.push(`Incomplete ${gap.stage} capture: ${gap.reason}${detail ? ` (${detail})` : ''}. Latency and cost for this stage are understated.`);
  }
  // Spans the provider never reported, rebuilt from LiveKit's turn report or
  // from the recorder's own audio tape. On a real Deepgram `aura-2` call this
  // is most of them, and every synthesis-latency number on this page is an
  // estimate as a result. Saying so is the difference between a number a
  // reader knows is approximate — which is useful — and one they believe was
  // measured, which is worse than a gap.
  const derivedOps = capture.measured?.derived_tts_op_count || 0;
  if (derivedOps > 0) {
    const derivedMs = capture.measured.derived_tts_agent_audio_ms || 0;
    warnings.push(`${derivedOps} TTS span(s)${derivedMs ? ` covering ${(derivedMs / 1000).toFixed(1)}s of speech` : ''} were reconstructed because the TTS plugin emitted no metrics_collected for them. Their timings are estimates and provider character counts are unavailable; spans are labelled inferred on the timeline.`);
  }
  // The share is published on every call, so it says "most of this page is an
  // estimate" even when the op count alone reads as a handful of spans.
  const derivedShare = capture.measured?.derived_tts_share_pct;
  if (derivedShare >= 50) {
    warnings.push(`${derivedShare}% of the agent's speech on this call is described by reconstructed spans rather than provider measurements, so most synthesis timings here are estimates.`);
  }
  // Which reply an audio stream belonged to is normally proved from LiveKit's
  // speech context. On a build that does not expose it the recorder falls back
  // to timing, which is sound but weaker — and a per-turn number that rests on
  // a guess should not look identical to one that rests on identity.
  if (capture.measured?.stream_ownership === 'inferred') {
    warnings.push('This livekit-agents build does not expose the speech-handle context, so each reply\'s audio was matched to it by timing rather than by identity. Per-turn talk time, latency and cost may have moved between adjacent replies; call totals are unaffected.');
  }
  // Boundary jitter the coverage audit forgave. Small by construction and
  // capped, but a write-off nobody can see is indistinguishable from data that
  // was never lost.
  const writtenOff = capture.measured?.tail_written_off_ms || 0;
  if (writtenOff > 0) {
    const onTurns = capture.measured.tail_written_off_turn_ids || [];
    warnings.push(`${writtenOff}ms of measured agent audio sits on no TTS span and was written off as turn-boundary jitter (cap ${capture.measured.tail_write_off_cap_ms}ms)${onTurns.length ? ` on ${onTurns.join(', ')}` : ''}.`);
  }
  // Audio that reached no span and was not written off. It sits under the
  // tolerance, so it does not move the status — which is exactly why it has to
  // be visible: a threshold that is applied but never shown is a second,
  // invisible write-off stacked on the first.
  const unattributed = capture.measured?.unattributed_agent_audio_ms || 0;
  if (unattributed > 0) {
    warnings.push(`${unattributed}ms of measured agent audio is on no TTS span, within the ${capture.measured.unattributed_tolerance_ms}ms tolerance that keeps it out of the capture verdict.`);
  }
  if (capture.events_complete === false) warnings.push('The SDK reported an incomplete event stream.');
  if (capture.audio_complete === false) warnings.push('Stereo call audio capture was incomplete.');
  if (capture.caller_audio_complete === false) warnings.push('Caller audio capture was incomplete.');
  if (capture.agent_audio_complete === false) warnings.push('Agent audio capture was incomplete.');
  if (capture.dropped_event_count) warnings.push(`${capture.dropped_event_count} event(s) were dropped under backpressure.`);
  if (capture.dropped_audio_chunk_count) warnings.push(`${capture.dropped_audio_chunk_count} audio chunk(s) were dropped, so playback may drift.`);
  for (const key of ['http_instrumentation', 'websocket_instrumentation']) {
    if (capture[key] && capture[key] !== 'active') warnings.push(`${key.replace(/_/g, ' ')} was ${capture[key]}; some spans may be missing.`);
  }
  return warnings;
}

// One LiveKit message can be committed as two turn rows. Both rows are kept and
// listed, because the inspector needs them, but they are one exchange -- and the
// session list already counts them that way, so counting rows here made opening
// a call silently change its turn count from 1 to 2.
function exchangeCount(turns) {
  return turns.filter((turn) => !turn.continues_turn).length;
}

function renderCall(session) {
  const manifest = session.manifest || {};
  const turns = session.turns || [];
  const operations = session.operations || [];
  const started = manifest.started_at || session.created_at;

  const responses = turns.map((turn) => turn.time_to_first_audio_ms).filter((value) => value != null);
  const errors = operations.filter((op) => effectiveStatus(op) === 'error');
  const interrupted = operations.filter((op) => isAborted(op));
  const tools = operations.filter((op) => op.type === 'tool');
  const slowest = turns.filter((turn) => turn.time_to_first_audio_ms != null)
    .sort((a, b) => b.time_to_first_audio_ms - a.time_to_first_audio_ms)[0];

  // One line, because a header is wayfinding and wayfinding is not data. Who,
  // when, how long, how it ended — everything else this used to carry (the
  // relative time beside the absolute one, the word "outcome:", a 36-character
  // uuid) said the same thing twice or said nothing.
  const outcome = manifest.outcome || session.outcome || 'unknown';
  const head = h('div', { class: 'call-head' },
    h('div', { class: 'call-id' },
      h('h1', { text: manifest.agent_id || session.agent_id || 'Untitled agent' }),
      h('div', { class: 'call-sub' },
        h('span', { text: absoluteTime(started), title: relativeTime(started) }),
        h('span', { class: 'dot-sep' }),
        h('span', {
          class: 'status-pill', dataset: { status: outcome === 'completed' ? 'ready' : outcome },
          title: 'How the call ended', text: outcome,
        }),
        // A capture status only earns pixels when it is not the happy path.
        session.status && session.status !== 'ready'
          ? h('span', { class: 'status-pill', dataset: { status: session.status }, text: session.status })
          : null,
      ),
    ),
  );

  const jumpToOps = (patch) => {
    Object.assign(state.opFilter, patch);
    // The trace filters too, so a KPI drill-down no longer has to throw the
    // reviewer into a different table to answer "which ones failed".
    if (state.callView !== 'trace' && state.callView !== 'spans') state.callView = 'trace';
    renderWorkbench(session);
    writeLocation();
    ui.workbenchBody?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Providers actually exercised by the call — the API leaves `model` null on
  // every span, so the endpoint id is the only honest identity we have.
  const providers = [...new Set(operations.map((op) => op.endpoint_id || op.provider).filter(Boolean))];
  // `model` is null on every span, but the streamed completion names it, so the
  // reconstructed transcript is the only place the real model shows up.
  const models = [...new Set([
    ...operations.map((op) => op.model),
    ...(state.transcript?.entries || []).map((entry) => entry.completion?.model),
  ].filter(Boolean))];

  /* These seven numbers used to be a 204px grid of cards, each with a label, a
     big number and a caption explaining itself — 204px of chrome above the
     trace to carry about forty characters of information. As a strip they read
     left to right in one pass, keep every drill-down they had, and the captions
     move to the tooltip, where an explanation is only in the way if you ask
     for it. */
  const metric = (label, value, foot, options = {}) => h(options.onClick ? 'button' : 'div', {
    type: options.onClick ? 'button' : null,
    class: 'metric',
    dataset: { metric: label.toLowerCase(), ...(options.tone ? { tone: options.tone } : {}) },
    title: [options.title, foot].filter(Boolean).join(' — ') || null,
    onClick: options.onClick || null,
  },
    h('span', { class: 'metric-label', text: label }),
    h('span', { class: 'metric-value', text: value }),
  );

  const p50 = responses.length ? percentile(responses, 0.5) : null;
  const p95 = responses.length ? percentile(responses, 0.95) : null;
  const strip = h('div', { class: 'metric-strip' },
    metric('Turns', String(exchangeCount(turns)),
      turns.length
        ? `${operations.length} operations${turns.length !== exchangeCount(turns)
            ? ` · ${turns.length} turn rows, ${turns.length - exchangeCount(turns)} continuing another`
            : ''}`
        : 'no turn spans captured'),
    metric('Length', duration(manifest.duration_ms) || '—', `${session.recordings?.filter((r) => r.uploaded).length || 0} audio track(s)`),
    metric('Typical wait', p50 != null ? duration(p50) : '—',
      responses.length ? `median (p50) caller stops → first audio, thresholds ${duration(WARN_MS)} / ${duration(SLOW_MS)}` : 'needs turns with a first-audio mark',
      { tone: p50 != null ? latencyTone(p50) : null }),
    metric('Worst wait', p95 != null ? duration(p95) : '—',
      responses.length ? `p95 over ${responses.length} turn${responses.length === 1 ? '' : 's'} — 1 in 20 waited at least this long` : 'needs turns with a first-audio mark',
      { tone: p95 != null ? latencyTone(p95) : null }),
    metric('Slowest', slowest ? duration(slowest.time_to_first_audio_ms) : '—',
      slowest ? null : 'no timed turns',
      slowest
        ? { tone: latencyTone(slowest.time_to_first_audio_ms), title: `Inspect turn #${slowest.turn_id}`, onClick: () => setSelection('turn', slowest.turn_id, { scroll: true }) }
        : {}),
    metric('Failures', String(errors.length),
      errors.length ? 'filter operations' : interrupted.length ? `all ok · ${interrupted.length} interrupted` : 'all operations ok',
      { tone: errors.length ? 'danger' : null, onClick: errors.length ? () => jumpToOps({ errorsOnly: true, type: 'all' }) : null }),
    metric('Tools', String(tools.length), tools.length ? 'filter operations' : 'none in this call',
      { onClick: tools.length ? () => jumpToOps({ type: 'tool', errorsOnly: false }) : null }),
    providers.length
      ? h('div', { class: 'metric metric-providers', dataset: { metric: 'providers' } },
        h('span', { class: 'metric-label', text: providers.length === 1 ? 'Provider' : 'Providers' }),
        h('span', { class: 'metric-chips' },
          ...providers.slice(0, 2).map((id) => h('button', {
            type: 'button', class: 'chip chip-action', text: id,
            title: `Search operations for ${id}${models.length ? ` · models: ${models.join(', ')}` : ' · no model name recorded on any span'}`,
            onClick: () => jumpToOps({ query: id }),
          })),
          providers.length > 2
            ? h('span', { class: 'chip', text: `+${providers.length - 2}`, title: providers.slice(2).join(', ') })
            : null,
        ),
      )
      : null,
  );

  // The metrics belong in the header band, not in a strip under it: a call is
  // read "who, when, how well" in one pass, and a separate 48px row for the
  // numbers pushed the waveform — the thing the reviewer came to use — below
  // the fold to say nothing the header could not have said on the same line.
  head.append(strip, h('div', { class: 'card-tools' },
    errors.length
      ? h('button', {
        type: 'button', class: 'status-pill', dataset: { status: 'failed' },
        title: 'Show only failed operations',
        onClick: () => jumpToOps({ errorsOnly: true, type: 'all' }),
        text: `${errors.length} failed`,
      })
      : null,
    h('button', {
      type: 'button', class: 'copy-id', title: `Copy session id — ${session.id}`,
      onClick: () => copy(session.id, 'Session id'),
    },
      h('span', { text: `${session.id.slice(0, 8)}⋯` }),
      h('span', { text: '⧉' }),
    ),
  ));

  const warnings = captureWarnings(session);
  const banner = warnings.length ? h('div', { class: 'banner', dataset: { tone: session.status === 'partial' ? 'danger' : 'warn' } },
    h('div', {},
      h('b', { text: warnings.length === 1 ? 'Capture warning' : `${warnings.length} capture warnings` }),
      h('span', { text: warnings.join(' ') }),
    ),
  ) : null;

  const columns = h('div', { class: 'columns' },
    h('div', { class: 'col' }, buildWorkbenchCard(session)),
    h('div', { class: 'col col-side' }, buildInspectorCard()),
  );
  // The inspector is a detail view of a selection, so with no selection it is
  // 400px of "Nothing selected" pinned beside the table that makes selections.
  // It appears when there is something to inspect and stands down when there
  // is not; `renderInspector` owns the flag.
  ui.columns = columns;

  const player = buildAudioCard(session);
  player.classList.add('call-player');
  const transcript = buildTranscriptSection(session);
  const liveTrace = buildLiveTraceCard(session);
  // One review surface: what you can hear on the left, what was said and what
  // the trace was doing at that instant on the right.
  //
  // The transcript used to sit under the player, which made the deck a stack of
  // three panels and pushed the trace table, the KPIs and the inspector under
  // the fold. Both right-hand answers now share one column as tabs: each gets
  // the full height instead of a third of it, and the deck is two panels tall.
  //
  // Stacking all of that still costs height, and the deck is pinned, so it
  // collapses to a single transport bar the moment the reviewer scrolls down to
  // read anything else. See `wireDeck`.
  const deck = h('div', { class: 'review-deck' },
    h('div', { class: 'deck-main' }, player),
    h('div', { class: 'deck-side' }, buildDeckTabs(transcript, liveTrace)),
  );

  const deckToggle = h('button', {
    type: 'button', class: 'icon-btn deck-toggle',
    onClick: () => ui.toggleDeck?.(),
  }, glyph(PATH.chevronUp, 14));
  ui.deckToggle = deckToggle;
  // The transport bar is where a reviewer's eye already is while listening, so
  // that is where the collapse control belongs. A call with no recording has no
  // transport bar, and its deck still collapses, so the control falls back to
  // the side tab strip rather than disappearing.
  const playerBar = player.querySelector('.player-bar');
  if (playerBar) playerBar.append(deckToggle);
  else ui.deckTabTools?.append(deckToggle);
  deck.dataset.transport = playerBar ? 'player' : 'transcript';

  clear($('#call')).append(...[head, deck, banner, columns].filter(Boolean));
  wireDeck(deck);
  renderWorkbench(session);
  renderInspector();
  drawTurnGuides(null);
}

/** How the review deck was last left. This is a view preference rather than
 *  call state, so it outlives the session and never touches the URL. */
const DECK_KEY = 'vaani.deck';
function readDeckPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DECK_KEY) || '{}');
    return { compact: saved.compact === true, sideTab: saved.sideTab === 'turns' ? 'turns' : 'transcript' };
  } catch { return { compact: false, sideTab: 'transcript' }; }
}
function writeDeckPrefs(patch) {
  try { localStorage.setItem(DECK_KEY, JSON.stringify({ ...readDeckPrefs(), ...patch })); } catch { /* private mode */ }
}

/** The deck is the scrollport's own sticky header, and a header that keeps a
 *  waveform, a transcript and a live trace open is a third of the viewport that
 *  the reviewer cannot scroll away from. Everything below it — the trace table,
 *  the KPIs, the inspector — was being read through a slot.
 *
 *  So the deck has two shapes. At the top of the call it is the full review
 *  surface. The moment the reviewer scrolls down to look at anything else it
 *  folds to a single transport bar, roughly 54px, which still plays, still
 *  scrubs and still names the turn and the span under the playhead. Scrolling
 *  back to the top restores it.
 *
 *  The thresholds are deliberately asymmetric. Collapsing shortens the deck,
 *  which pulls the content below it upward; with one threshold the resulting
 *  clamp at the bottom of a short call can drop the scroller back under it and
 *  the deck flaps open and shut on every frame.
 *
 *  A reviewer who overrides the state gets to keep it: an expand while scrolled
 *  holds until they return to the top, and a collapse holds until they undo it,
 *  because a reviewer who put the player away meant it. */
function wireDeck(deck) {
  const host = $('#call');
  const wide = window.matchMedia('(min-width: 1240px)');
  let compact = readDeckPrefs().compact;
  let manual = compact ? 'compact' : null;

  // CSS cannot read one element's height into another's offset, and the sticky
  // inspector has to start below whichever shape the deck is currently in.
  // It is 0 below 1240px, where the deck stops sticking and nothing needs it.
  const publish = () => host.style.setProperty('--deck-h', wide.matches ? `${Math.round(deck.getBoundingClientRect().height)}px` : '0px');

  const paint = () => {
    deck.dataset.compact = String(compact);
    // Folded, the side column is only the "what is playing" line, so the turn
    // ladder is shown whichever tab was left selected. A global
    // `[hidden] { display: none !important }` means CSS cannot reveal it —
    // the fold has to move the panel flags itself.
    if (ui.deckPanels) {
      if (compact) {
        ui.deckPanels.turns.hidden = false;
        ui.deckPanels.transcript.hidden = true;
      } else {
        showDeckTab(readDeckPrefs().sideTab, { silent: true });
      }
    }
    const button = ui.deckToggle;
    if (!button) return;
    const label = compact ? 'Expand the player' : 'Collapse the player';
    button.setAttribute('aria-expanded', String(!compact));
    button.setAttribute('aria-label', label);
    button.title = `${label}  ·  c`;
    button.querySelector('path')?.setAttribute('d', compact ? PATH.chevronDown : PATH.chevronUp);
  };

  const setCompact = (next) => {
    if (next === compact) return;
    compact = next;
    paint();
    publish();
  };

  const onScroll = () => {
    if (manual === 'compact') return;
    // Below 1240px the deck scrolls away with the page, so there is nothing to
    // fold out of the way — folding would only shrink a card as it leaves.
    if (!wide.matches) return;
    const top = host.scrollTop;
    if (manual === 'expanded') {
      if (top < 40) manual = null;
      return;
    }
    if (compact) { setCompact(top >= 40); return; }
    // Folding removes its own height from the page, and if that leaves the
    // scroller clamped back above the unfold threshold the deck flaps open and
    // shut on every wheel notch. So fold only when what remains still scrolls
    // clear of that threshold. Comparing against the deck's *whole* height was
    // too blunt — the folded deck is only about 60px, so most of it comes back
    // as scrollable page.
    const maxScroll = host.scrollHeight - host.clientHeight;
    const reclaimed = Math.max(0, deck.getBoundingClientRect().height - 60);
    if (top > 120 && maxScroll - reclaimed > 60) setCompact(true);
  };

  ui.toggleDeck = () => {
    manual = compact ? 'expanded' : 'compact';
    setCompact(!compact);
    // Only a deliberate collapse is remembered. Remembering an expand would
    // reopen a deck the reviewer only wanted open for one call.
    writeDeckPrefs({ compact: manual === 'compact' });
  };

  host.addEventListener('scroll', onScroll, { passive: true });
  const observer = new ResizeObserver(publish);
  observer.observe(deck);
  wide.addEventListener('change', publish);
  ui.deckMetrics = () => {
    observer.disconnect();
    wide.removeEventListener('change', publish);
    host.removeEventListener('scroll', onScroll);
    host.style.removeProperty('--deck-h');
    ui.toggleDeck = null;
    ui.deckToggle = null;
  };
  paint();
  publish();
}

/* ------------------------------------------------------------- workbench */

/** The call used to arrive as five stacked cards — timeline, STT quality,
 *  conversation, turns and operations — all open at once. Everything is still
 *  here, but one view at a time, so the page opens on the one that answers the
 *  first question a reviewer has.
 *
 *  Conversation and Timeline have since left this switcher entirely. Both are
 *  read against the recording rather than on their own, so they now live with
 *  the player: the spans as a lane under the waveform on the same axis, the
 *  transcript as a panel directly beneath it that follows playback. Tabbing
 *  away from the audio to read what was said was the wrong shape for the job. */
const CALL_VIEWS = [
  { key: 'trace', label: 'Trace' },
  { key: 'spans', label: 'All spans' },
  { key: 'stt', label: 'STT review · Beta' },
];

function buildWorkbenchCard(session) {
  const tabs = h('div', { class: 'view-tabs', role: 'tablist', 'aria-label': 'Call views' });
  for (const view of CALL_VIEWS) {
    tabs.append(h('button', {
      type: 'button',
      role: 'tab',
      dataset: { view: view.key },
      'aria-selected': String(state.callView === view.key),
      text: view.label,
      onClick: () => {
        if (state.callView === view.key) return;
        state.callView = view.key;
        renderWorkbench(session);
        writeLocation();
      },
    }));
  }
  ui.workbenchTabs = tabs;
  // The card below used to repeat the selected tab's name and then hang its
  // filters on a second bar underneath it — two rows of chrome, one of which
  // said "Trace" directly under a tab reading "Trace". The tools ride on the
  // tab row instead; `renderWorkbench` lifts them out of whichever card it
  // just built.
  ui.workbenchTools = h('div', { class: 'card-tools view-tools' });
  ui.workbenchBody = h('div', { class: 'workbench-body' });
  return h('section', { class: 'workbench' },
    h('div', { class: 'view-bar' }, tabs, ui.workbenchTools),
    ui.workbenchBody,
  );
}

/** Moves a workbench card's header controls onto the shared tab bar and drops
 *  the header itself. A card whose title is the tab you are already on is a
 *  row of pixels spent saying where you are. */
function hoistCardTools(card) {
  clear(ui.workbenchTools);
  const head = card.querySelector(':scope > .card-head');
  if (!head) return;
  const tools = head.querySelector('.card-tools');
  if (tools) ui.workbenchTools.append(...tools.childNodes);
  head.remove();
}

function renderWorkbench(session) {
  const host = ui.workbenchBody;
  if (!host) return;
  // Anything the previous view owned is now detached; clearing the handles
  // keeps a later render from writing into a node nobody can see.
  ui.opRows = ui.opHead = ui.opSeg = ui.opSearch = ui.opErrors = ui.opCount = null;
  ui.traceRows = ui.traceCount = null;
  clear(host);
  for (const button of ui.workbenchTabs?.querySelectorAll('button') || []) {
    button.setAttribute('aria-selected', String(button.dataset.view === state.callView));
  }
  let card;
  switch (state.callView) {
    case 'spans': card = buildOperationsCard(); host.append(card); renderOperationRows(); break;
    case 'stt': card = buildSttQualityCard(session); host.append(card); break;
    default: card = buildTraceCard(session); host.append(card); renderTraceRows(); break;
  }
  hoistCardTools(card);
  syncSelection();
}

/* -------------------------------------------------------------- timeline */

/** Splits a call's operations into the rows a span rail draws, in a fixed order
 *  so the same call always stacks the same way. Sockets are kept apart: they
 *  all span the whole call, so stacking them on one row would bury every socket
 *  but the topmost under an identical, unclickable bar. */
function spanRows(session) {
  const all = session.operations || [];
  const sockets = all.filter(isSocket);
  const timed = all.filter((op) => !isSocket(op));
  const rows = TYPES.map((type) => ({
    key: type,
    label: TYPE_LABEL[type] || type,
    short: type.toUpperCase(),
    color: COLOR[type],
    ops: timed.filter((op) => op.type === type),
  }));
  for (const socket of sockets) {
    rows.push({
      key: `ws:${socket.event_id}`,
      label: `${(socket.type || 'ws').toUpperCase()} socket`,
      short: `${(socket.type || 'ws').toUpperCase()} ws`,
      color: COLOR.conn,
      hint: socket.endpoint_id || socket.provider || 'provider socket',
      ops: [socket],
    });
  }
  const total = Math.max(
    session.manifest?.duration_ms || 0,
    ...all.map((op) => op.presentation_window?.to_ms || op.ended_at_ms || op.started_at_ms || 0),
    1,
  );
  return { rows, total, count: all.length, sockets };
}

/** Arrow-key navigation for a row of bars. A 37-span rail must not be 37 tab
 *  stops; the track is one stop and the arrows walk the spans inside it. */
function wireBarKeys(track) {
  const bars = [...track.querySelectorAll('.timeline-bar')];
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
}

function spanLegend(session) {
  const { sockets } = spanRows(session);
  return h('div', { class: 'timeline-legend' },
    ...TYPES.map((type) => h('span', { class: 'legend-item' },
      h('span', { class: 'legend-swatch', style: { background: COLOR[type] } }),
      TYPE_LABEL[type],
    )),
    sockets.length ? h('span', { class: 'legend-item' },
      h('span', { class: 'legend-swatch', style: { background: COLOR.conn } }), 'Provider socket') : null,
  );
}

/** The full-width span rail on its own call clock. The player draws its spans
 *  inside the waveform instead, so this is only reached when the two clocks
 *  cannot be trusted to agree — a call with no audio, or a track whose timings
 *  do not line up with the recording. */
function buildTimelineSurface(session) {
  // Draw from the flat operation list only. `session.turns[].operations` are
  // separate objects after JSON parsing, and rendering both would let the
  // timeline and the operations table disagree about the same span.
  const { rows, total, count } = spanRows(session);
  if (!count) {
    return h('div', { class: 'empty-block' },
      h('b', { text: 'No spans to plot' }),
      h('p', { text: 'This package contained no classified stt, llm, tts or tool operations.' }),
    );
  }

  ui.timelineTotal = total;

  const timeline = h('div', { class: 'timeline' });
  for (const row of rows) {
    const track = h('div', { class: 'timeline-track' });
    if (!row.ops.length) { track.classList.add('is-empty'); track.dataset.empty = 'none captured'; }
    for (const op of row.ops) track.append(timelineBar(op, total, row.color));
    wireBarKeys(track);
    timeline.append(h('div', { class: 'timeline-row' },
      h('b', { class: 'timeline-label', title: row.hint || null },
        h('span', { class: 'legend-swatch', style: { background: row.color } }),
        row.short,
      ),
      track,
    ));
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

  ui.turnGuides = h('div', { class: 'turn-guides' });

  // No playhead: this surface only renders when the call has no audio to track.
  return h('div', { class: 'timeline-surface' }, ui.turnGuides, timeline, axis);
}

function timelineBar(op, total, color) {
  const canonical = op.presentation_window;
  const rawStart = Math.max(0, canonical?.from_ms ?? op.started_at_ms ?? 0);
  const rawEnd = canonical?.to_ms ?? op.ended_at_ms ?? rawStart;
  const start = Math.min(rawStart, total);
  // Guard against reversed or open-ended spans so a bar can never run past the
  // track it is drawn in.
  const end = Math.min(total, Math.max(rawEnd, rawStart + 1));
  const left = (start / total) * 100;
  const width = Math.min(100 - left, Math.max(0.35, ((end - start) / total) * 100));
  const socket = isSocket(op);
  const label = `${TYPE_LABEL[displayType(op)] || op.type} · ${op.endpoint_id || op.request?.name || op.transport || 'operation'}`;
  const span = duration(rawEnd - rawStart) || 'unknown';
  const lasted = socket ? `held open ${span}` : `lasts ${span}`;
  const node = h('button', {
    type: 'button',
    class: 'timeline-bar',
    dataset: { opId: op.event_id },
    style: { left: `${left}%`, width: `${width}%`, background: color },
    // A bar's selected ring comes only from `aria-pressed` — `syncSelection`
    // deliberately leaves `is-selected` off bars. Reading the live selection
    // here keeps the ring through every repaint: the lane is rebuilt on zoom,
    // on resize and by the spans toggle, and a hard-coded `false` dropped it
    // while the inspector still showed that same op.
    'aria-pressed': String(state.selection?.kind === 'op' && state.selection.id === op.event_id),
    'aria-label': `${label}, ${canonical?.kind || 'provider work'}, ${canonical?.confidence || 'recorded'}, ${offset(rawStart)} to ${offset(rawEnd)}${canonical ? `; provider work ${offset(op.started_at_ms)} to ${offset(op.ended_at_ms)}` : ''}`,
    onClick: () => {
      setSelection('op', op.event_id, { scroll: true });
      if (audioWindow(op)) playSegment(op);
    },
  });
  if (effectiveStatus(op) === 'cancelled') node.classList.add('is-cancelled');
  if (effectiveStatus(op) === 'error') node.classList.add('is-error');

  node.addEventListener('mouseenter', () => showTooltip(node, label, [
    op.turn_id != null ? `turn #${op.turn_id}` : socket ? 'connection scope' : 'ungrouped',
    `starts ${offset(rawStart)}`,
    lasted,
    canonical ? `provider work ${offset(op.started_at_ms)} → ${offset(op.ended_at_ms)}` : null,
    canonical?.confidence === 'inferred' ? 'audible timing inferred from rendered duration' : null,
    `status ${effectiveStatus(op) || 'unknown'}`,
  ].filter(Boolean)));
  node.addEventListener('mouseleave', hideTooltip);
  node.addEventListener('focus', () => showTooltip(node, label, [
    `starts ${offset(rawStart)}`, lasted,
    canonical ? `provider work ${offset(op.started_at_ms)} → ${offset(op.ended_at_ms)}` : null,
    canonical?.confidence === 'inferred' ? 'audible timing inferred from rendered duration' : null,
  ].filter(Boolean)));
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

/** The conversation, as a panel under the player rather than a tab beside it.
 *  Reading what was said and hearing it said are the same act of review, so the
 *  transcript stays on screen with the waveform and follows the playhead. */
function buildTranscriptSection(session) {
  const { entries, systemPrompt, modelCallCount, bodiesCaptured, voice } = state.transcript || { entries: [], modelCallCount: 0 };
  const body = h('div', { class: 'card-body transcript-body' });

  if (!entries.length) {
    // Naming the actual cause matters more here than anywhere else on the
    // page: "nothing was said", "we did not record it" and "you turned
    // recording off" look identical to a reader and mean completely different
    // things about the call.
    let explanation;
    if (voice?.spokenOps) {
      explanation = `${voice.spokenOps} speech operation(s) were recorded, but their words were not stored. Content capture is off; set VAANI_CAPTURE_STT_CONTENT=1 in the SDK to read the conversation here.`;
    } else if (!modelCallCount) {
      explanation = 'The transcript is read from the speech operations, falling back to model requests and responses. This call has no captured stt, tts or llm operations, so there is nothing to show.';
    } else if (bodiesCaptured) {
      explanation = `${modelCallCount} model call(s) were recorded but none carried readable message content.`;
    } else {
      explanation = `${modelCallCount} model call(s) were recorded without their request or response bodies, so their words were never stored. Enable body capture in the SDK to read the conversation here.`;
    }
    body.append(h('div', { class: 'empty-block' },
      h('b', { text: 'No conversation captured' }),
      h('p', { text: explanation }),
    ));
    return transcriptSection(body, 0, null, session);
  }

  // The prompt is reference material, not conversation: a permanent 26px row
  // reading "System prompt · 2970 chars" above every transcript spends deck
  // height on a fact that belongs in the header. It lives in the body so it
  // scrolls with the dialogue it precedes, but stays out of the flow until the
  // header chip asks for it.
  const prompt = systemPrompt
    ? h('details', { class: 'system-prompt' },
      h('summary', {}, 'System prompt', h('span', { class: 'tag', text: `${systemPrompt.length} chars` })),
      h('pre', { text: systemPrompt }),
    )
    : null;
  if (prompt) body.append(prompt);
  const firstTurn = (session.turns || [])[0];
  if (firstTurn && !(firstTurn.operations || []).some((op) => op.type === 'llm')) {
    body.append(h('p', { class: 'notice', style: { marginBottom: '8px' } },
      `Turn #${turnName(firstTurn.turn_id)} played ${duration(firstTurn.tts_ms) || 'audio'} of speech with no model call — a scripted opening line, so its words are not in the capture.`));
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
  return transcriptSection(body, entries.length, transcript, session, prompt);
}

function transcriptSection(body, count, transcript, session, prompt = null) {
  // Both the follow toggle and the "click to hear it" promise are about audio.
  // On a package whose recording never arrived they offer something that cannot
  // happen, which is worse than not offering it.
  // `recordings` lists what the manifest *declared*; the player only plays what
  // actually arrived (`uploaded`). Trusting the former promises playback on a
  // package whose objects never landed — the exact case this guards.
  const playable = audioTracks(session).length > 0;
  // Auto-scroll is the whole point of a transcript beside a player, and it is
  // also the thing that makes one unusable: the moment a reviewer scrolls back
  // to re-read a line, a following panel drags them away from it. Following is
  // therefore a mode the reviewer holds, dropped the instant they take the
  // scroller themselves and picked back up on request.
  const follow = h('button', {
    type: 'button',
    class: 'btn tiny follow-toggle',
    'aria-pressed': 'true',
    title: 'Keep the playing turn in view',
    text: 'Follow',
    onClick: () => setFollow(!ui.transcriptFollow, { recentre: true }),
  });

  ui.transcriptFollow = playable;
  ui.transcriptScroller = body;
  ui.transcriptFollowButton = follow;
  ui.transcriptList = transcript;

  if (transcript && playable) {
    // Wheel and drag are unambiguous statements of intent, unlike `scroll`,
    // which the panel also fires at itself while following. A press on a line
    // or on a payload disclosure is not: both are interactions the panel
    // invites, and either would silently cost the reviewer follow mode.
    for (const event of ['wheel', 'touchmove']) {
      body.addEventListener(event, () => setFollow(false), { passive: true });
    }
    body.addEventListener('pointerdown', (event) => {
      if (!event.target.closest('.msg, .msg-payload')) setFollow(false);
    }, { passive: true });
    body.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) setFollow(false);
    });
  }

  // The prompt is one click away rather than a permanent row above the
  // dialogue, so the chip is what advertises it and what reports its state —
  // including when the reader closes the disclosure from inside the body.
  const promptChip = prompt
    ? h('button', {
      type: 'button', class: 'chip chip-action', 'aria-pressed': 'false',
      title: 'Show the system prompt this call ran with',
      text: 'prompt',
      onClick: () => {
        prompt.open = !prompt.open;
        if (prompt.open) {
          showDeckTab('transcript');
          prompt.scrollIntoView({ block: 'nearest' });
        }
      },
    })
    : null;
  prompt?.addEventListener('toggle', () => promptChip.setAttribute('aria-pressed', String(prompt.open)));

  // The transcript is a panel of the deck's side tabs, so the tab is its name,
  // its count and its affordance all at once. Repeating "Transcript 52" in a
  // header directly under a selected tab reading the same thing spent a row on
  // nothing, so the card keeps only its dialogue and hands its two controls up
  // to the tab strip, which is where the reviewer is already looking.
  const card = h('section', { class: 'card transcript-card' }, body);

  ui.transcriptCard = card;
  ui.transcriptCount = count;
  ui.transcriptTools = h('div', { class: 'card-tools transcript-tools' },
    promptChip,
    transcript && playable ? follow : null,
  );
  return card;
}

/** The deck's right-hand column. Two answers to "what happened here" — the
 *  words and the spans behind them — compete for the same slot, and stacking
 *  both is what pushed the transcript under the fold in the first place. Tabs
 *  give each the full column at full height and cost one row.
 *
 *  Transcript leads because it is what a reviewer reads first: the audio names
 *  the moment, the transcript says what was said in it, and the turn ladder is
 *  the follow-up question about why it took so long.
 */
const DECK_TABS = [
  { key: 'transcript', label: 'Transcript' },
  { key: 'turns', label: 'Turns' },
];

function buildDeckTabs(transcriptCard, liveCard) {
  const tabs = h('div', { class: 'tabs deck-tablist', role: 'tablist', 'aria-label': 'Call detail' });
  for (const tab of DECK_TABS) {
    tabs.append(h('button', {
      type: 'button',
      role: 'tab',
      id: `deck-tab-${tab.key}`,
      'aria-controls': `deck-panel-${tab.key}`,
      dataset: { deckTab: tab.key },
      'aria-selected': 'false',
      tabindex: '-1',
      onClick: () => showDeckTab(tab.key, { focus: false }),
    },
      h('span', { text: tab.label }),
      tab.key === 'transcript'
        ? h('span', { class: 'strip-count', text: String(ui.transcriptCount || 0) })
        : null,
    ));
  }
  // A tablist is a single tab stop; arrows move between the tabs inside it.
  tabs.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const usable = [...tabs.querySelectorAll('button')];
    let next = null;
    if (step) next = usable[(usable.indexOf(event.target) + step + usable.length) % usable.length];
    else if (event.key === 'Home') next = usable[0];
    else if (event.key === 'End') next = usable[usable.length - 1];
    if (!next) return;
    event.preventDefault();
    showDeckTab(next.dataset.deckTab);
  });

  transcriptCard.id = 'deck-panel-transcript';
  transcriptCard.setAttribute('role', 'tabpanel');
  transcriptCard.setAttribute('aria-labelledby', 'deck-tab-transcript');
  liveCard.id = 'deck-panel-turns';
  liveCard.setAttribute('role', 'tabpanel');
  liveCard.setAttribute('aria-labelledby', 'deck-tab-turns');

  const tools = h('div', { class: 'card-tools deck-tab-tools' }, ui.transcriptTools);
  const card = h('section', { class: 'card side-deck' },
    h('div', { class: 'card-head deck-tab-head' }, tabs, tools),
    h('div', { class: 'side-panels' }, transcriptCard, liveCard),
  );
  ui.deckTabs = tabs;
  ui.deckTabTools = tools;
  ui.deckPanels = { transcript: transcriptCard, turns: liveCard };
  showDeckTab(readDeckPrefs().sideTab, { silent: true });
  return card;
}

/** Which panel the side column is showing. It is a view preference, so it
 *  outlives the call and the reload, and never touches the URL. */
function showDeckTab(key, { silent = false, focus = true } = {}) {
  if (!ui.deckPanels || !ui.deckPanels[key]) key = 'transcript';
  for (const tab of ui.deckTabs?.querySelectorAll('button') || []) {
    const on = tab.dataset.deckTab === key;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus && !silent) tab.focus();
  }
  for (const [name, panel] of Object.entries(ui.deckPanels)) panel.hidden = name !== key;
  // Only the transcript owns tools; the turn ladder's own header is its label.
  if (ui.transcriptTools) ui.transcriptTools.hidden = key !== 'transcript';
  if (silent) return;
  writeDeckPrefs({ sideTab: key });
  if (key === 'transcript') scrollTranscriptTo(ui.liveTurnId, { force: true });
}

function setFollow(on, { recentre = false } = {}) {
  if (ui.transcriptFollow === on && !recentre) return;
  ui.transcriptFollow = on;
  ui.transcriptFollowButton?.setAttribute('aria-pressed', String(on));
  if (on && recentre) scrollTranscriptTo(ui.liveTurnId, { force: true });
}

/** Brings the turn now playing to the top of the transcript panel, moving only
 *  that panel — a document-level `scrollIntoView` would yank the page away from
 *  whatever else the reviewer was reading. */
function scrollTranscriptTo(turnId, { force = false } = {}) {
  const scroller = ui.transcriptScroller;
  if (!scroller || !scroller.isConnected || turnId == null) return;
  if (!ui.transcriptFollow && !force) return;
  const group = scroller.querySelector(`.transcript-turn[data-turn-id="${CSS.escape(String(turnId))}"]`);
  if (!group) return;
  const top = group.offsetTop - scroller.offsetTop - 8;
  if (Math.abs(scroller.scrollTop - top) < 2) return;
  scroller.scrollTo({ top, behavior: wantsCalm() ? 'auto' : 'smooth' });
}

/** A tool payload is evidence, not conversation. Rendered open it buries the
 *  spoken lines either side of it — one 800px JSON blob inside a 290px panel
 *  costs the reviewer the thread of the call. Collapsed to a single row with a
 *  preview, the transcript stays readable and the payload is one click away. */
function toolPayload(label, value) {
  const text = pretty(value);
  const lines = text.split('\n').length;
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 72);
  return h('details', { class: 'msg-payload' },
    // Inside a `.msg` button, a click on the summary would also re-seek the
    // line; opening a payload is its own intent.
    h('summary', { onClick: (event) => event.stopPropagation() },
      h('span', { class: 'payload-name', text: label }),
      h('span', { class: 'payload-peek', text: preview || 'empty' }),
      h('span', { class: 'payload-size', text: `${lines} line${lines === 1 ? '' : 's'}` }),
    ),
    h('pre', { class: 'msg-tool', text }),
  );
}

function transcriptMessage(entry) {
  const who = entry.role === 'user' ? 'Caller' : entry.role === 'assistant' ? 'Agent' : entry.role === 'tool' ? 'Tool' : entry.role;
  const tags = [];
  if (entry.turnId != null) tags.push(h('span', { class: 'tag', text: `turn #${turnName(entry.turnId)}` }));
  if (entry.latency != null && entry.source === 'completion') {
    tags.push(h('span', { class: 'tag', dataset: latencyTone(entry.latency) ? { tone: latencyTone(entry.latency) } : {}, text: `${duration(entry.latency)} model` }));
  }
  if (entry.completion?.model) tags.push(h('span', { class: 'tag', text: entry.completion.model }));
  if (entry.completion?.finishReason && entry.completion.finishReason !== 'stop') {
    tags.push(h('span', { class: 'tag', dataset: { tone: 'warn' }, text: `finish: ${entry.completion.finishReason}` }));
  }
  // Only the reply this call produced failed; the caller line merely sat in
  // its prompt, so tagging that as failed would blame the wrong utterance.
  if (entry.source === 'completion' && entry.op) {
    if (isAborted(entry.op)) {
      tags.push(h('span', { class: 'tag', dataset: { tone: 'warn' }, text: 'interrupted' }));
    } else if (entry.op.status === 'error') {
      tags.push(h('span', { class: 'tag', dataset: { tone: 'danger' }, text: 'failed' }));
    }
  }
  if (entry.completion?.truncated && !entry.repaired) tags.push(h('span', { class: 'tag', dataset: { tone: 'warn' }, text: 'capture truncated' }));

  const toolCalls = entry.toolCalls || [];
  const bodyNodes = [];
  const payloads = [];
  if (entry.role === 'tool') {
    payloads.push(toolPayload('Tool result', entry.text));
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
    if (call.arguments) payloads.push(toolPayload(call.name ? `${call.name} arguments` : 'Arguments', call.arguments));
  }

  // Only the agent's reply was actually produced by the model call it came
  // from. A caller line merely appeared in that call's prompt, so sending the
  // reviewer to an "LLM · azure-openai" span would misattribute their words.
  const spoken = entry.source === 'completion';
  const target = spoken && entry.op
    ? { kind: 'op', id: entry.op.event_id, hint: 'Inspect the model call that produced this reply' }
    : entry.turnId != null
      ? { kind: 'turn', id: String(entry.turnId), hint: `Inspect turn #${turnName(entry.turnId)}` }
      : null;
  const playbackOp = entry.turnId != null
    ? (state.session?.operations || []).find((op) => String(op.turn_id) === String(entry.turnId)
      && op.type === (entry.role === 'user' ? 'stt' : 'tts') && audioWindow(op))
    : null;

  const line = h('button', {
    type: 'button',
    class: 'msg',
    dataset: { role: entry.role, opId: spoken ? entry.op?.event_id || '' : '', turnId: entry.turnId != null ? String(entry.turnId) : '' },
    title: target?.hint || 'Nothing to inspect for this line',
    onClick: () => {
      if (target) setSelection(target.kind, target.id, { scroll: true });
      if (playbackOp) playSegment(playbackOp);
    },
  },
    h('span', { class: 'msg-role' },
      h('span', { class: 'msg-who', text: who }),
      h('span', { class: 'msg-at', text: offset(entry.at) }),
    ),
    h('span', {}, ...bodyNodes, tags.length ? h('span', { class: 'msg-tags' }, ...tags) : null),
  );

  // A `<details>` nested inside a `<button>` is invalid HTML and its summary
  // stops toggling, so payloads are siblings of the line rather than children.
  if (!payloads.length) return line;
  return h('div', { class: 'msg-shell', dataset: { role: entry.role } }, line, ...payloads);
}

/* ------------------------------------------------------------ live trace */

/** The turn a point on the call clock belongs to. Stated once here so the
 *  player, the live trace and anything else that has to answer "where am I"
 *  can never disagree about it. */
function turnAtMs(ms) {
  return (state.session?.turns || []).find((turn) => ms >= (turn.started_at_ms || 0) && ms <= (turn.ended_at_ms ?? turn.started_at_ms ?? 0)) || null;
}

/** Between two turns there is no turn, but there is still a most recent one,
 *  and a panel that blanks during every silence is worse than one that keeps
 *  describing what was just heard. */
function lastTurnBeforeMs(ms) {
  let found = null;
  for (const turn of state.session?.turns || []) {
    if ((turn.started_at_ms || 0) <= ms) found = turn; else break;
  }
  return found;
}

/** The end of a span on the call clock. Playout is authoritative where it was
 *  recorded: a TTS span finishes generating long before the caller stops
 *  hearing it, and the reviewer is listening to the audio, not the request. */
function spanEndMs(op, fallback = 0) {
  return op.presentation_window?.to_ms ?? op.ended_at_ms ?? op.started_at_ms ?? fallback;
}

/**
 * The trace, read at the playhead.
 *
 * The trace table below answers "what happened in this call". It cannot answer
 * "what is happening right now", which is the question a reviewer actually has
 * while a recording is playing — three seconds of silence go by and they want
 * to know whether the model was thinking, the tool was waiting or nothing was
 * running at all. Scrolling a 76-row table to the right turn on every playhead
 * move is not an answer.
 *
 * So this panel holds one turn: the spans that served it, drawn on that turn's
 * own clock, with the playhead running across them. It re-renders only when the
 * turn changes — the line and the active row are the only things that move on a
 * frame, because this updates from `paintPlayer`, which runs sixty times a
 * second while the audio plays.
 *
 * With no recording, or with a track that will not align to the call clock,
 * there is no playhead to follow. It then shows whatever the reviewer has
 * selected instead of pretending to be live.
 */
function buildLiveTraceCard(session) {
  const { parentOf } = nestTransportAttempts(session.operations || []);
  // Retries are folded into the call that owns them, exactly as in the trace
  // table: three rows for one model call would read as three model calls.
  const byTurn = new Map();
  for (const op of session.operations || []) {
    if (isSocket(op) || parentOf.has(op.event_id)) continue;
    const key = String(op.turn_id);
    if (!byTurn.has(key)) byTurn.set(key, []);
    byTurn.get(key).push(op);
  }
  for (const list of byTurn.values()) list.sort((a, b) => (a.started_at_ms ?? 0) - (b.started_at_ms ?? 0));

  const nowTag = h('span', { class: 'type-tag', dataset: { type: 'turn' }, text: '—' });
  const nowTurn = h('span', { class: 'live-now-turn', hidden: true });
  const nowLabel = h('span', { class: 'live-now-label', text: 'Nothing playing' });
  const nowTime = h('span', { class: 'live-now-time num', text: '' });
  // The one line that survives into the collapsed deck, so a reviewer reading
  // the table below still knows what the audio is on. It is also this card's
  // only header: a strip reading "Trace · follows the audio" above a chart
  // that visibly follows the audio was a label for something already obvious,
  // and it cost a row on the tallest panel of the deck.
  const nowLine = h('button', {
    type: 'button', class: 'live-now',
    title: 'Inspect the turn now playing',
    onClick: () => { if (shownTurn) setSelection('turn', shownTurn.turn_id, { scroll: true }); },
  }, nowTag, nowTurn, nowLabel, nowTime);

  const said = h('p', { class: 'live-said', hidden: true });
  const scale = h('div', { class: 'live-scale' });
  const rows = h('div', { class: 'live-rows' });
  const playhead = h('div', { class: 'live-playhead', hidden: true });
  const stack = h('div', { class: 'live-stack' }, rows, playhead);
  const empty = h('div', { class: 'empty-block live-empty' },
    h('b', { text: 'Nothing to follow yet' }),
    h('p', { text: 'Play the recording and the spans behind each turn appear here, on the turn’s own clock. With no aligned audio, pick a turn or a span and it is shown here instead.' }),
  );

  const body = h('div', { class: 'card-body live-body' }, said, scale, stack, empty);
  const card = h('section', { class: 'card live-card' },
    nowLine,
    body,
  );

  let shownTurn = null;
  let shownKey = Symbol('none');
  let shownWindow = null;
  let shownActive = Symbol('none');
  let lastAt = null;
  let lastAligned = false;
  const barsById = new Map();

  /** The stretch of call clock a turn's row chart is drawn on. A turn's own end
   *  mark stops at the caller's speech, so an agent reply that is still playing
   *  would run off the right-hand edge of the chart it belongs to. */
  function windowOf(turn, spans) {
    const from = turn.started_at_ms ?? spans[0]?.started_at_ms ?? 0;
    let to = turn.ended_at_ms ?? from;
    for (const op of spans) to = Math.max(to, spanEndMs(op, from));
    return { from, to: Math.max(to, from + 1) };
  }

  function drawTurn(turn) {
    clear(rows);
    barsById.clear();
    const spans = turn ? (byTurn.get(String(turn.turn_id)) || []) : [];
    shownTurn = turn;
    card.dataset.empty = String(!turn || !spans.length);
    if (!turn) { shownWindow = null; clear(scale); said.hidden = true; nowTurn.hidden = true; return; }

    const reply = turn.time_to_first_audio_ms;
    nowTurn.hidden = false;
    nowTurn.textContent = `#${turnName(turn.turn_id)}`;

    const window = windowOf(turn, spans);
    shownWindow = window;
    const span = window.to - window.from;
    clear(scale).append(
      h('span', { class: 'num', text: offset(window.from) }),
      h('span', { class: 'live-scale-mid', dataset: { tone: latencyTone(reply) || 'none' },
        text: reply != null ? `first audio back ${duration(reply)}` : `${duration(span)} of call` }),
      h('span', { class: 'num', text: offset(window.to) }),
    );

    const spoken = transcriptLine('user', turn.turn_id);
    said.hidden = !spoken;
    if (spoken) said.textContent = `“${spoken}”`;

    for (const op of spans) {
      const from = op.started_at_ms ?? window.from;
      const to = spanEndMs(op, from);
      const left = clampPercent(((from - window.from) / span) * 100, 99);
      const type = displayType(op);
      const bar = h('span', {
        class: 'live-bar',
        style: {
          left: `${left}%`,
          width: `${clampPercent(((to - from) / span) * 100, 100 - left, 1.2)}%`,
          background: COLOR[type] || 'var(--accent)',
        },
      });
      const row = h('button', {
        type: 'button',
        class: 'live-row',
        dataset: { opId: op.event_id, type, status: effectiveStatus(op) || 'ok' },
        title: `${operationLabel(op)} · starts ${offset(from)} · ${duration(to - from) || 'no duration recorded'}`,
        onClick: () => setSelection('op', op.event_id, { scroll: true }),
      },
        h('span', { class: 'live-row-head' },
          h('span', { class: 'type-tag', dataset: { type }, text: (type || '').toUpperCase() }),
          h('span', { class: 'live-label', text: operationLabel(op) }),
          h('span', { class: 'live-dur num', text: duration(to - from) || '—' }),
        ),
        h('span', { class: 'live-track' }, bar),
      );
      rows.append(row);
      barsById.set(op.event_id, { row, from, to });
    }
    syncSelection();
  }

  /* Before anything has played, the panel used to sit there saying "nothing
   * running" beside a chart of one turn nobody had asked for — a third of the
   * deck spent on an empty state. At rest it shows the whole call instead: one
   * row per turn, the bar scaled to that turn's reply time, so the reviewer's
   * first glance at a call already answers "which turn was slow" and every row
   * is a way in. Playback takes the panel over the moment the playhead moves. */
  function drawOverview() {
    clear(rows);
    barsById.clear();
    shownTurn = null;
    shownWindow = null;
    said.hidden = true;
    nowTurn.hidden = true;
    const turns = state.session?.turns || [];
    card.dataset.empty = String(!turns.length);
    if (!turns.length) { clear(scale); return; }

    const replies = turns.map((turn) => turn.time_to_first_audio_ms).filter((value) => value != null);
    const worst = replies.length ? Math.max(...replies) : 0;
    clear(scale).append(
      h('span', { class: 'num', text: `${exchangeCount(turns)} turn${exchangeCount(turns) === 1 ? '' : 's'}` }),
      h('span', { class: 'live-scale-mid', dataset: { tone: worst ? latencyTone(worst) : 'none' },
        text: worst ? 'reply time per turn' : 'no first-audio marks' }),
      h('span', { class: 'num', text: worst ? duration(worst) : '—' }),
    );

    for (const turn of turns) {
      const reply = turn.time_to_first_audio_ms;
      const tone = reply == null ? null : latencyTone(reply);
      const spoken = transcriptLine('user', turn.turn_id);
      rows.append(h('button', {
        type: 'button',
        class: 'live-row',
        dataset: { turnId: String(turn.turn_id), status: turn.status || 'ok' },
        title: `Turn ${turnName(turn.turn_id)}${reply != null ? ` · first audio back ${duration(reply)}` : ' · no first-audio mark'}`,
        onClick: () => setSelection('turn', turn.turn_id, { scroll: true }),
      },
        h('span', { class: 'live-row-head' },
          h('span', { class: 'type-tag', dataset: { type: 'turn' }, text: `#${turnName(turn.turn_id)}` }),
          h('span', { class: 'live-label', text: spoken || `Turn ${turnName(turn.turn_id)}` }),
          h('span', { class: 'live-dur num', dataset: tone ? { tone } : {}, text: reply != null ? duration(reply) : '—' }),
        ),
        h('span', { class: 'live-track' },
          h('span', {
            class: 'live-bar',
            dataset: tone ? { tone } : {},
            style: { left: '0%', width: `${reply != null && worst ? clampPercent((reply / worst) * 100, 100, 2) : 0}%` },
          }),
        ),
      ));
    }
    syncSelection();
  }


  function activeAt(ms) {
    let found = null;
    for (const [, entry] of barsById) {
      if (ms < entry.from || ms > entry.to) continue;
      if (!found || entry.from >= found.from) found = entry;
    }
    return found;
  }

  function paintNowLine(ms) {
    const active = ms == null ? null : activeAt(ms);
    const key = active ? active.row.dataset.opId : ms == null ? 'idle' : 'gap';
    const changed = key !== shownActive;
    shownActive = key;

    if (active) {
      if (changed) {
        for (const [, entry] of barsById) entry.row.classList.toggle('is-live', entry === active);
        nowTag.dataset.type = active.row.dataset.type;
        nowTag.textContent = (active.row.dataset.type || '').toUpperCase();
        nowLabel.textContent = active.row.querySelector('.live-label').textContent;
      }
      nowTime.textContent = `${duration(ms - active.from) || '0ms'} in`;
      return;
    }

    if (changed) for (const [, entry] of barsById) entry.row.classList.remove('is-live');
    if (ms == null) {
      if (changed) {
        nowTag.dataset.type = 'turn';
        nowTag.textContent = '—';
        nowLabel.textContent = shownTurn ? `Turn #${turnName(shownTurn.turn_id)} — selected` : 'Nothing playing';
      }
      nowTime.textContent = '';
      return;
    }
    // Silence is the reading a reviewer most often wants explained, so it is
    // named as a state of its own rather than left as a blank line.
    if (changed) {
      nowTag.dataset.type = 'gap';
      nowTag.textContent = 'GAP';
      nowLabel.textContent = 'nothing running';
    }
    let since = null;
    for (const [, entry] of barsById) if (entry.to <= ms && (since == null || entry.to > since)) since = entry.to;
    nowTime.textContent = since == null ? '' : `${duration(ms - since) || '0ms'} of silence`;
  }

  function paintPlayhead(ms) {
    if (ms == null || !shownWindow) { playhead.hidden = true; return; }
    const fraction = (ms - shownWindow.from) / (shownWindow.to - shownWindow.from);
    playhead.hidden = fraction < 0 || fraction > 1;
    if (!playhead.hidden) playhead.style.setProperty('--live-x', String(fraction));
  }

  /** @param at seconds on the recording, or null when nothing is playing. */
  function at(seconds, aligned) {
    lastAt = seconds;
    lastAligned = aligned;
    const ms = aligned && seconds != null ? seconds * 1000 : null;
    const turns = state.session?.turns || [];
    // "At rest" is any moment the audio is not actually running: paused at the
    // top, never started, or not alignable at all. The playhead cannot answer
    // for the panel then, so the reviewer's selection does — and with no
    // selection either, the panel shows the whole call rather than a turn
    // nobody asked for.
    const resting = ms == null || ms < 50;
    if (resting && !state.selection) {
      if (shownKey !== 'overview') {
        shownKey = 'overview';
        shownActive = Symbol('none');
        drawOverview();
      }
      card.dataset.live = 'false';
      playhead.hidden = true;
      nowTag.dataset.type = 'turn';
      nowTag.textContent = 'CALL';
      nowLabel.textContent = turns.length ? 'Every turn, by reply time' : 'No turns captured';
      nowTime.textContent = '';
      nowLine.disabled = true;
      return;
    }
    nowLine.disabled = false;
    // At 0:00 the playhead is before the first turn, and an empty panel is a
    // poor answer to "what is in this call" — the first turn is the one about
    // to play, so it is the one shown.
    const live = !resting;
    const turn = resting
      ? (selectedTurn() || turns[0] || null)
      : (turnAtMs(ms) || lastTurnBeforeMs(ms) || turns[0] || null);
    const key = turn ? String(turn.turn_id) : 'none';
    if (key !== shownKey) {
      shownKey = key;
      shownActive = Symbol('none');
      drawTurn(turn);
    }
    card.dataset.live = String(live);
    paintPlayhead(live ? ms : null);
    paintNowLine(live ? ms : null);
  }

  ui.liveTrace = { at, refresh: () => at(lastAt, lastAligned) };
  at(null, false);
  return card;
}

/** What one side of a turn said, for the panels that quote a line rather than
 *  render the conversation. */
function transcriptLine(role, turnId, limit = 130) {
  const entry = (state.transcript?.entries || []).find((item) => item.role === role && String(item.turnId) === String(turnId) && item.text);
  if (!entry) return null;
  const text = entry.text.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 2)}…` : text;
}

/* ----------------------------------------------------------------- trace */

/** Sorts rows on a value that can be absent. An unmeasured row is not a fast
 *  row, so it always sinks to the bottom whichever way the column points. */
function compareSortable(left, right, direction) {
  const missingLeft = left == null || left === '' || Number.isNaN(left);
  const missingRight = right == null || right === '' || Number.isNaN(right);
  if (missingLeft || missingRight) return missingLeft && missingRight ? 0 : missingLeft ? 1 : -1;
  const compare = typeof left === 'string' ? left.localeCompare(right) : left - right;
  return compare * (direction === 'asc' ? 1 : -1);
}

// Framework and transport spans are timed either side of an await, so a retry
// can appear to start a few ms before the call that owns it.
const NEST_SLACK_MS = 500;

/**
 * A model call is recorded twice. The agent framework emits one span per
 * logical call — it carries the tokens and the time to first token, and it
 * covers every retry underneath it. The HTTP instrumentation emits one span per
 * physical attempt — it carries the request body and the status code. Listed
 * side by side these look like unexplained duplicate calls, which is exactly
 * the confusion this view exists to remove: the attempts are nested under the
 * call they served, so "three LLM calls" is visibly one call that retried
 * twice.
 */
function nestTransportAttempts(operations) {
  const llm = operations.filter((op) => op.type === 'llm' && !isSocket(op));
  const frameworks = llm.filter((op) => !isTransportSpan(op));
  const attempts = llm.filter((op) => isTransportSpan(op));
  const children = new Map();
  const parentOf = new Map();

  for (const attempt of attempts) {
    const start = attempt.started_at_ms ?? 0;
    const end = attempt.ended_at_ms ?? start;
    let host = null;
    for (const framework of frameworks) {
      if (String(framework.turn_id) !== String(attempt.turn_id)) continue;
      const from = framework.started_at_ms ?? 0;
      const to = framework.ended_at_ms ?? from;
      if (start < from - NEST_SLACK_MS || end > to + NEST_SLACK_MS) continue;
      // Prefer the tightest enclosing call when a turn made several.
      if (!host || from > (host.started_at_ms ?? 0)) host = framework;
    }
    if (!host) continue;
    if (!children.has(host.event_id)) children.set(host.event_id, []);
    children.get(host.event_id).push(attempt);
    parentOf.set(attempt.event_id, host.event_id);
  }
  for (const list of children.values()) list.sort((a, b) => (a.started_at_ms ?? 0) - (b.started_at_ms ?? 0));
  return { children, parentOf };
}

/** The call as a reviewer thinks about it: turns, each holding the spans that
 *  served it, with whole-call provider sockets kept out of the way at the end
 *  so they cannot be mistaken for a two-minute transcription. */
function buildTrace(session) {
  const operations = session.operations || [];
  const turns = session.turns || [];
  const { children, parentOf } = nestTransportAttempts(operations);
  const known = new Set(turns.map((turn) => String(turn.turn_id)));
  const top = operations.filter((op) => !parentOf.has(op.event_id));

  const groups = turns.map((turn) => ({
    kind: 'turn',
    id: `turn:${turn.turn_id}`,
    turn,
    spans: top.filter((op) => !isSocket(op) && String(op.turn_id) === String(turn.turn_id)),
  }));

  const loose = top.filter((op) => !isSocket(op) && !known.has(String(op.turn_id)));
  if (loose.length) {
    groups.push({ kind: 'loose', id: 'group:ungrouped', label: 'Outside any turn', spans: loose });
  }
  const sockets = top.filter(isSocket);
  if (sockets.length) {
    groups.push({ kind: 'sockets', id: 'group:sockets', label: 'Provider connections', spans: sockets });
  }
  for (const group of groups) group.spans.sort((a, b) => (a.started_at_ms ?? 0) - (b.started_at_ms ?? 0));
  return { groups, children };
}

/** Shared by the trace and the flat span table so a filter can never mean two
 *  different things depending on which view is open. */
function matchesOpFilter(op) {
  const query = state.opFilter.query.trim().toLowerCase();
  if (state.opFilter.type !== 'all' && displayType(op) !== state.opFilter.type) return false;
  if (state.opFilter.errorsOnly && effectiveStatus(op) !== 'error') return false;
  if (query && !`${operationLabel(op)} ${op.type} ${op.transport || ''} ${op.event_id}`.toLowerCase().includes(query)) return false;
  return true;
}

/** A span the agent deliberately abandoned is not a failure, but the SDK has no
 *  way to say so: aborting an in-flight request surfaces as a thrown error, so
 *  it lands in the package with status "error" and the runtime's abort name.
 *
 *  That distinction is not cosmetic. In the recorded corpus 82 of 95 "errors"
 *  are aborts and only 13 are real (provider read timeouts). Reporting all 95
 *  as failures buries the 13 that matter under a 7:1 noise floor, which is
 *  exactly the "everything looks broken" problem this view exists to remove.
 *
 *  Node throws `AbortError`, Python raises `CancelledError`; both mean the same
 *  thing, and in the recorded corpus every deliberate abort carries one of those
 *  names. Nothing is matched on the message: downgrading a span here removes it
 *  from the failure count, so a false positive HIDES a real outage, which is far
 *  worse than the false negative of leaving one unexplained error on screen.
 *  Message text is not safe for this — a provider failing with `{"error":"the
 *  run was cancelled by policy"}` is a real failure, and undici reports a
 *  server closing a stream mid-response as a bare `Error: aborted`, which is
 *  also a real failure. Only an explicit abort name is trustworthy. */
const ABORT_NAMES = new Set(['AbortError', 'CancelledError', 'CancelledException']);

function isAborted(op) {
  if (op?.status !== 'error') return false;
  return ABORT_NAMES.has(op.error?.name);
}

/** The status this span should be judged by, as opposed to the one the runtime
 *  happened to record. Everything that counts, filters, colours or rolls up a
 *  status goes through here so the trace, the table and the KPIs can never
 *  disagree about what "failed" means. */
function effectiveStatus(op) {
  return isAborted(op) ? 'cancelled' : op?.status;
}

/** A cancelled span is the single most alarming thing in this view and the one
 *  the data explains least: the SDK records that the work stopped early but
 *  never why, so the row reads like an unhandled fault. It almost never is.
 *
 *  Across the recorded corpus 19 of 20 cancelled TTS spans overlap a caller
 *  utterance — the agent was talking, the caller talked over it, and the agent
 *  correctly stopped. That is barge-in working, not a failure. The remaining
 *  case had no caller speech and sat at the end of the call: the call closed
 *  mid-sentence.
 *
 *  Note the overlap has to be a true interval intersection. Testing only for a
 *  caller utterance *starting inside* the span misses the common case where the
 *  caller was already mid-sentence when the span began, which accounted for 12
 *  of the 19. */
function cancelReason(op) {
  if (!op || isSocket(op)) return null;
  const aborted = isAborted(op);
  if (op.status !== 'cancelled' && !aborted) return null;
  if (!aborted && op.type !== 'tts') return null;
  const playout = op.presentation_window;
  const from = playout?.from_ms ?? op.started_at_ms;
  const to = playout?.to_ms ?? op.ended_at_ms ?? from;
  if (from == null) return null;

  const interrupter = (state.session?.operations || []).find((other) => {
    if (other.type !== 'stt' || isSocket(other) || other === op) return false;
    if (other.turn_id != null && String(other.turn_id) === String(op.turn_id)) return false;
    const marks = other.milestones || {};
    const speechFrom = other.presentation_window?.from_ms ?? marks.speech_started?.occurred_at_ms ?? other.started_at_ms;
    const speechTo = other.presentation_window?.to_ms ?? marks.speech_ended?.occurred_at_ms ?? other.ended_at_ms;
    if (speechFrom == null || speechTo == null) return false;
    return presentationWindowsOverlap({ ...playout, from_ms: from, to_ms: to }, { from_ms: speechFrom, to_ms: speechTo });
  });

  const spoken = op.response?.audio_ms;
  const played = op.type === 'tts'
    ? (spoken ? `${duration(spoken)} of it had already played` : 'playback had barely started')
    : `it had been running ${duration(to - from)}`;
  const what = op.type === 'tts' ? 'synthesis' : op.type === 'llm' ? 'the model call' : 'the operation';

  if (interrupter) {
    const text = sttText(interrupter);
    return {
      kind: 'barge-in',
      short: 'cut off by the caller',
      text: `Barge-in: the caller started speaking over the agent, so ${what} was abandoned — ${played}.${text ? ` They said “${text}”.` : ''} This is the interruption handling working, not a fault.`,
    };
  }
  return {
    kind: 'stopped',
    short: 'stopped early',
    text: `${what[0].toUpperCase()}${what.slice(1)} was stopped before it finished and no caller speech overlaps it, so this is not barge-in — ${played}. The usual cause is the turn being superseded or the call ending.`,
  };
}

/** Exact chunk attribution may contain genuine silence. Compare the recorded
 * ranges, not their enclosing hull, so silence cannot manufacture a barge-in. */
function presentationWindowsOverlap(left, right) {
  const ranges = (window) => window?.segments?.length
    ? window.segments.map((segment) => [segment.from_ms, segment.to_ms])
    : [[window?.from_ms, window?.to_ms]];
  return ranges(left).some(([from, to]) => ranges(right).some(([otherFrom, otherTo]) =>
    Number.isFinite(from) && Number.isFinite(to) && Number.isFinite(otherFrom) && Number.isFinite(otherTo)
    && from < otherTo && to > otherFrom));
}

/** One line of plain language saying what this span actually did, because a row
 *  reading "azure-openai · 1.4s · ok" tells a reviewer nothing they came for. */
function spanHeadline(op) {
  if (op.type === 'stt') {
    const text = sttText(op);
    return text ? `“${text}”` : isSocket(op) ? 'streaming transcription socket' : 'no transcript recorded';
  }
  if (op.type === 'tool') {
    const input = op.request?.input;
    const summary = typeof input === 'string' ? input : input ? pretty(input) : '';
    return summary ? summary.replace(/\s+/g, ' ').slice(0, 120) : 'no arguments recorded';
  }
  if (op.type === 'tts') {
    if (isSocket(op)) return 'speech synthesis socket';
    const chars = op.milestones?.speak?.char_count;
    const audio = op.response?.audio_ms;
    const parts = [];
    if (chars) parts.push(`${chars} chars`);
    if (audio) parts.push(`${duration(audio)} of audio`);
    const headline = parts.join(' → ') || 'no audio recorded';
    const reason = cancelReason(op);
    return reason ? `${headline} — ${reason.short}` : headline;
  }
  if (op.type === 'llm') {
    if (isTransportSpan(op)) {
      const status = op.response?.status;
      const model = parseRequestBody(op).request?.model;
      return [model, status ? `HTTP ${status}` : 'HTTP attempt'].filter(Boolean).join(' · ');
    }
    const completion = decodeCompletion(op.response);
    const tokens = op.response?.total_tokens ?? completion.usage?.total_tokens;
    const model = op.model || completion.model;
    const parts = [];
    if (model) parts.push(model);
    if (tokens) parts.push(`${tokens} tokens`);
    const ttft = op.milestones?.first_token?.occurred_at_ms;
    if (ttft != null && op.started_at_ms != null) parts.push(`first token ${duration(ttft - op.started_at_ms)}`);
    return parts.join(' · ') || 'model call';
  }
  return operationLabel(op);
}

// The order a phase actually happens in, so the strip reads left to right like
// the call did. Anything a provider adds that is not listed is appended after.
const PHASE_ORDER = {
  stt: ['connected', 'speech_started', 'first_partial', 'speech_ended', 'speech_final', 'final_transcript', 'end_of_utterance', 'turn_report'],
  tts: ['connected', 'speak', 'first_byte', 'audio_chunk', 'flush', 'turn_report'],
  llm: ['request_body_captured', 'first_token'],
};

const PHASE_LABEL = {
  connected: 'socket open',
  speech_started: 'caller starts speaking',
  first_partial: 'first partial transcript',
  speech_ended: 'caller stops speaking',
  speech_final: 'provider marks speech final',
  final_transcript: 'final transcript',
  end_of_utterance: 'end of utterance',
  turn_report: 'reported to the turn',
  request_body_captured: 'request sent',
  first_token: 'first token',
  speak: 'text handed to the voice',
  first_byte: 'first audio byte',
  audio_chunk: 'audio streaming',
  flush: 'flush requested',
  sent_frame: 'frames sent',
  received_frame: 'frames received',
};

/**
 * When does the caller actually start and stop talking? A duration alone cannot
 * say, so every recorded phase is laid out against the span's own window with
 * the wall-clock offset spelled out underneath. This is the answer to "STT
 * starts when and ends when".
 */
function phaseStrip(op) {
  const milestones = op.milestones && typeof op.milestones === 'object' ? op.milestones : {};
  const order = PHASE_ORDER[op.type] || [];
  const names = [
    ...order.filter((name) => milestones[name]),
    ...Object.keys(milestones).filter((name) => !order.includes(name)),
  ];
  const win = audioWindow(op);
  if (!names.length && !win) return null;

  const start = op.started_at_ms ?? 0;
  const end = op.ended_at_ms ?? start;
  const span = Math.max(1, end - start);

  const track = h('div', { class: 'phase-track' });
  const legend = h('div', { class: 'phase-legend' });
  for (const name of names) {
    const point = milestones[name];
    const at = typeof point?.occurred_at_ms === 'number' ? point.occurred_at_ms : null;
    if (at == null) continue;
    const last = typeof point?.last_at_ms === 'number' ? point.last_at_ms : at;
    const left = clampPercent(((at - start) / span) * 100);
    const width = clampPercent(((Math.max(last, at) - at) / span) * 100, 100 - left);
    // A mark that covers a range is a band and a mark that happened once is a
    // tick. Drawn at the same weight the wide one hides every point mark that
    // falls inside it — on a TTS span the streaming band buried both the speak
    // and the flush.
    track.append(h('span', {
      class: 'phase-mark',
      dataset: { type: op.type, range: width > 0.5 ? 'true' : 'false' },
      style: { left: `${left}%`, width: width > 0.5 ? `${width}%` : null },
      title: `${PHASE_LABEL[name] || name} at ${offset(at)}${point.count > 1 ? ` · ${point.count} events, last ${offset(last)}` : ''}`,
    }));
    legend.append(h('span', { class: 'phase-item' },
      h('b', { text: PHASE_LABEL[name] || name.replace(/_/g, ' ') }),
      h('span', { class: 'num', text: offset(at) }),
      point.count > 1 ? h('small', { text: `×${point.count} → ${offset(last)}` }) : null,
    ));
  }
  if (!legend.childElementCount && !win) return null;

  const rail = h('div', { class: 'phase-rail' },
    h('span', { class: 'phase-edge num', text: offset(start) }),
    track,
    h('span', { class: 'phase-edge num', text: offset(end) }),
  );

  const strip = h('div', { class: 'phase' }, rail, legend);
  if (!win) return strip;

  // The window the audio covers is usually narrower than the span — a socket is
  // open before anyone speaks — so it is shaded rather than implied.
  const left = clampPercent(((win.from - start) / span) * 100);
  const width = clampPercent(((win.to - win.from) / span) * 100, 100 - left);
  track.prepend(h('span', {
    class: 'phase-window',
    dataset: { type: op.type },
    style: { left: `${left}%`, width: `${Math.max(width, 0.6)}%` },
    title: `${win.label} · ${offset(win.from)} → ${offset(win.to)}`,
  }));
  track.append(h('span', { class: 'phase-playhead', dataset: { op: op.event_id }, hidden: true }));

  rail.classList.add('has-audio');
  const playing = segment.playing && segment.opId === op.event_id;
  rail.prepend(h('button', {
    type: 'button',
    class: 'phase-play',
    dataset: { op: op.event_id, playing: String(playing) },
    'aria-pressed': String(playing),
    'aria-label': playing ? 'Stop this span' : 'Play this span',
    title: `Play the ${win.label} for this span (${duration(win.to - win.from)})`,
    text: playing ? '■' : '▶',
    onClick: (event) => { event.stopPropagation(); playSegment(op); },
  }));

  legend.append(h('span', { class: 'phase-item is-audio' },
    h('b', { text: win.isolated ? `plays ${win.label}` : 'plays both speakers' }),
    h('span', { class: 'num', text: duration(win.to - win.from) }),
    win.isolated ? null : h('small', { text: 'no isolated channel in this package' }),
  ));

  return strip;
}

function traceCell(text, className = '') {
  return h('span', { class: className, title: text, text });
}

/** One row of the trace, at any depth. Turns, spans and retries share a grid so
 *  the eye can compare a retry against the call that spawned it. */
function traceRowNode({ depth, expandable, expanded, badge, badgeType, title, headline, chip, startMs, durationMs, durationHint, tone, status, bar, dataset, onActivate }) {
  const twisty = h('span', { class: 'trace-twisty', text: expandable ? (expanded ? '▾' : '▸') : '' });
  return h('button', {
    type: 'button',
    class: 'trace-row',
    dataset: { ...dataset, depth: String(depth) },
    'aria-expanded': expandable ? String(expanded) : null,
    'aria-pressed': 'false',
    style: { '--depth': String(depth) },
    onClick: onActivate,
  },
    h('span', { class: 'trace-lead' }, twisty, h('span', { class: 'type-tag', dataset: { type: badgeType }, text: badge })),
    h('span', { class: 'trace-title' },
      title ? h('b', { text: title }) : null,
      // The number that used to get its own full-width band under the row. It
      // is one measurement about this turn, so it rides along with the turn.
      chip ? h('span', { class: 'reply-chip', dataset: chip.tone ? { tone: chip.tone } : {}, title: chip.title || null, text: chip.text }) : null,
      headline ? traceCell(headline, 'trace-headline') : null,
    ),
    h('span', { class: 'num trace-start', text: startMs == null ? '—' : offset(startMs) }),
    h('span', { class: 'trace-dur' },
      durationMs == null
        ? h('span', { class: 'cell-missing', text: durationHint || 'not timed' })
        : h('span', { class: 'num', title: durationHint || null, text: duration(durationMs) }),
      bar ? h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', dataset: tone ? { tone } : {}, style: { width: `${bar.width}%`, background: bar.color || null } })) : null,
    ),
    h('span', { class: 'state-dot', dataset: { status }, text: status || '—' }),
  );
}

/** Both the trace and the flat table read `state.opFilter`, so the controls are
 *  built once and either view can host them. */
function buildOpFilterControls(onChange) {
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
      onClick: () => { state.opFilter.type = type; onChange(); },
    }));
  }

  const errorsToggle = h('button', {
    type: 'button',
    class: 'btn tiny',
    dataset: { role: 'errors-only' },
    'aria-pressed': String(state.opFilter.errorsOnly),
    text: 'Failures only',
    onClick: () => { state.opFilter.errorsOnly = !state.opFilter.errorsOnly; onChange(); },
  });

  const search = h('input', {
    type: 'search',
    class: 'filter-input',
    placeholder: 'Search endpoint or tool',
    'aria-label': 'Search operations',
    onInput: (event) => { state.opFilter.query = event.target.value; onChange(); },
  });

  ui.opSeg = seg;
  ui.opErrors = errorsToggle;
  ui.opSearch = search;
  return { seg, errorsToggle, search };
}

/** Re-renders whichever filtered view happens to be mounted. */
function refreshFilteredViews() {
  renderTraceRows();
  renderOperationRows();
  syncOpFilterControls();
  writeLocation();
}

function hasPhases(op) {
  const milestones = op?.milestones;
  if (milestones && typeof milestones === 'object' && Object.keys(milestones).length) return true;
  // A span with no provider marks can still be played back, and that is reason
  // enough to let the reviewer open it.
  if (audioWindow(op)) return true;
  // A cancelled span carries an explanation worth reading even when it recorded
  // nothing else at all.
  return Boolean(cancelReason(op));
}

function turnUtterance(group) {
  const stt = group.spans.find((op) => op.type === 'stt' && !isSocket(op));
  return stt ? sttText(stt) : null;
}

function buildTraceCard(session) {
  state.trace = buildTrace(session);
  const { seg, errorsToggle, search } = buildOpFilterControls(refreshFilteredViews);
  search.value = state.opFilter.query;

  ui.traceCount = h('span', { class: 'chip' });
  ui.traceRows = h('div', { class: 'rows trace' });

  const allIds = () => [
    ...state.trace.groups.map((group) => group.id),
    ...state.trace.groups.flatMap((group) => group.spans.filter((op) => hasPhases(op) || state.trace.children.has(op.event_id)).map((op) => op.event_id)),
  ];

  const toggleAll = h('button', {
    type: 'button', class: 'btn tiny',
    text: 'Expand all',
    onClick: (event) => {
      const opening = event.currentTarget.textContent === 'Expand all';
      state.expanded = opening ? new Set(allIds()) : new Set();
      event.currentTarget.textContent = opening ? 'Collapse all' : 'Expand all';
      renderTraceRows();
    },
  });

  const head = h('div', { class: 'row-head trace-grid' },
    h('span', { text: '' }),
    h('span', { text: 'Step' }),
    h('span', { text: 'Start' }),
    h('span', { text: 'Elapsed' }),
    h('span', { text: 'Status' }),
  );

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('div', { class: 'card-tools' }, ui.traceCount, seg, errorsToggle, toggleAll, search),
    ),
    h('div', { class: 'card-body flush scroll-cap' }, head, ui.traceRows),
  );
}

/** The trace already shows the type as a coloured tag, so a label that merely
 *  repeats it ("LLM · llm") spends the widest column saying nothing. Drop it and
 *  let the headline have the room. */
function countFailed(ops) {
  return ops.filter((op) => effectiveStatus(op) === 'error').length;
}

function traceTitle(op) {  const label = operationLabel(op);
  return label.toLowerCase() === (displayType(op) || '').toLowerCase() ? '' : label;
}

function renderTraceRows() {
  const host = ui.traceRows;
  if (!host || !state.trace) return;
  clear(host);

  const { groups, children } = state.trace;
  const filtering = state.opFilter.type !== 'all' || state.opFilter.errorsOnly || Boolean(state.opFilter.query.trim());
  // A filter that hid the retry but kept its parent would misreport the call,
  // so a span survives if it matches or if any attempt beneath it does.
  const keep = (op) => matchesOpFilter(op) || (children.get(op.event_id) || []).some(matchesOpFilter);

  // Provider sockets are open for the whole call; scaling against them would
  // flatten every per-turn span this view exists to compare.
  const scale = [];
  for (const group of groups) {
    for (const op of group.spans) {
      if (!isSocket(op) && op.duration_ms != null) scale.push(op.duration_ms);
      for (const kid of children.get(op.event_id) || []) if (kid.duration_ms != null) scale.push(kid.duration_ms);
    }
  }
  const longest = Math.max(...scale, 1);

  const total = groups.reduce((sum, group) => sum + group.spans.length + group.spans.reduce((n, op) => n + (children.get(op.event_id)?.length || 0), 0), 0);
  let shown = 0;

  // The count has to describe the spans the filter selected, not the rows that
  // happen to be painted; a parent kept only because a retry beneath it matched
  // is not itself a match and must not inflate the total.
  const countMatches = (op) => {
    const self = !filtering || matchesOpFilter(op) ? 1 : 0;
    return (children.get(op.event_id) || []).reduce((sum, kid) => sum + countMatches(kid), self);
  };

  const appendSpan = (op, depth) => {
    const allKids = children.get(op.event_id) || [];
    // A filter that kept the parent but hid the matching retry would answer the
    // reviewer's question with the one row that cannot answer it: "failures
    // only" has to actually show the failed attempt.
    const kids = filtering ? allKids.filter(matchesOpFilter) : allKids;
    const expandable = allKids.length > 0 || hasPhases(op);
    const open = state.expanded.has(op.event_id) || (filtering && kids.length > 0);
    const socket = isSocket(op);
    host.append(traceRowNode({
      depth,
      expandable,
      expanded: open,
      badge: (displayType(op) || '').toUpperCase(),
      badgeType: displayType(op),
      title: traceTitle(op),
      headline: spanHeadline(op),
      startMs: op.started_at_ms,
      durationMs: op.duration_ms,
      durationHint: socket ? 'open for the whole call, not a per-request latency' : null,
      status: effectiveStatus(op),
      bar: op.duration_ms == null ? null : {
        width: socket ? 100 : Math.min(100, Math.max(2, (op.duration_ms / longest) * 100)),
        color: COLOR[displayType(op)] || 'var(--accent)',
      },
      dataset: { opId: op.event_id },
      onActivate: () => {
        if (expandable) {
          if (open) state.expanded.delete(op.event_id);
          else state.expanded.add(op.event_id);
        }
        setSelection('op', op.event_id);
        renderTraceRows();
      },
    }));
    if (!open) return;
    const why = cancelReason(op);
    if (why) {
      host.append(h('div', { class: 'trace-detail', style: { '--depth': String(depth + 1) } },
        h('p', { class: 'trace-explain', dataset: { tone: why.kind === 'barge-in' ? 'info' : 'warn' }, text: why.text }),
      ));
    }
    const strip = phaseStrip(op);
    if (strip) host.append(h('div', { class: 'trace-detail', style: { '--depth': String(depth + 1) } }, strip));
    if (allKids.length) {
      host.append(h('div', { class: 'trace-detail', style: { '--depth': String(depth + 1) } },
        h('p', { class: 'trace-explain', text: allKids.length === 1
          ? 'One HTTP request served this model call. The framework span above reports the tokens; the request body is on the attempt below.'
          : `${allKids.length} HTTP attempts served this one model call${countFailed(allKids) ? `, ${countFailed(allKids)} of which failed and ${countFailed(allKids) === 1 ? 'was' : 'were'} retried` : ''}. The framework span above times the whole sequence, which is why its duration covers every attempt.` }),
      ));
    }
    for (const kid of kids) appendSpan(kid, depth + 1);
  };

  for (const group of groups) {
    const spans = group.spans.filter((op) => !filtering || keep(op));
    if (filtering && !spans.length) continue;
    shown += spans.reduce((sum, op) => sum + countMatches(op), 0);

    const expanded = filtering || state.expanded.has(group.id);
    const turn = group.turn;
    const starts = group.spans.map((op) => op.started_at_ms).filter((value) => value != null);
    const ends = group.spans.map((op) => op.ended_at_ms ?? op.started_at_ms).filter((value) => value != null);
    const from = starts.length ? Math.min(...starts) : null;
    const to = ends.length ? Math.max(...ends) : null;
    // A span's own status is not the whole story: the framework span for a model
    // call can be abandoned by barge-in while the HTTP attempt nested under it
    // failed for real. Those attempts are not in `group.spans` (they hang off
    // `children`), so a rollup that ignored them could quietly downgrade a turn
    // that genuinely failed.
    const branchStatus = (op) => {
      const kids = children.get(op.event_id) || [];
      if (effectiveStatus(op) === 'error' || kids.some((kid) => branchStatus(kid) === 'error')) return 'error';
      if (effectiveStatus(op) === 'cancelled' || kids.some((kid) => branchStatus(kid) === 'cancelled')) return 'cancelled';
      return 'ok';
    };
    const worstStatus = group.spans.some((op) => branchStatus(op) === 'error') ? 'error'
      : group.spans.some((op) => branchStatus(op) === 'cancelled') ? 'cancelled' : 'ok';
    // The server stamps the turn "error" from the same raw span statuses, so a
    // turn whose only fault was an aborted call inherits a failure the spans
    // underneath it no longer claim. Trust the spans: a parent row must never
    // accuse a turn of failing when nothing inside it did.
    const groupStatus = turn
      ? (turn.status === 'error' && worstStatus !== 'error' ? worstStatus : turn.status || worstStatus)
      : worstStatus;

    const parts = [];
    if (turn) {
      if (turn.user_speech_ms != null) parts.push(`${duration(turn.user_speech_ms)} listening`);
      if (turn.llm_ms != null) parts.push(`${duration(turn.llm_ms)} thinking${turn.llm_calls > 1 ? ` over ${turn.llm_calls} calls` : ''}`);
      if (turn.tts_ms != null) parts.push(`${duration(turn.tts_ms)} speaking`);
    }
    if (!parts.length) parts.push(`${group.spans.length} span${group.spans.length === 1 ? '' : 's'}`);

    const response = turn?.time_to_first_audio_ms;
    host.append(traceRowNode({
      depth: 0,
      expandable: true,
      expanded,
      badge: turn ? `#${turn.turn_id}` : '',
      badgeType: turn ? 'turn' : 'conn',
      title: turn ? (turnUtterance(group) ? `“${turnUtterance(group)}”` : `Turn ${turn.turn_id}`) : group.label,
      chip: turn && response != null
        ? { text: `↩ ${duration(response)}`, tone: latencyTone(response) || 'ok', title: 'Caller stops → first audio back' }
        : null,
      headline: parts.join(' · '),
      startMs: from,
      durationMs: from != null && to != null ? to - from : null,
      durationHint: group.kind === 'sockets' ? 'sockets stay open for the whole call' : null,
      tone: response == null ? null : latencyTone(response),
      status: groupStatus,
      bar: response == null ? null : { width: Math.min(100, Math.max(2, (response / Math.max(SLOW_MS * 2, response)) * 100)) },
      dataset: turn ? { turnId: turn.turn_id, groupId: group.id } : { groupId: group.id },
      onActivate: () => {
        if (expanded) state.expanded.delete(group.id);
        else state.expanded.add(group.id);
        if (turn) setSelection('turn', turn.turn_id);
        renderTraceRows();
      },
    }));

    if (!expanded) continue;
    for (const op of spans) appendSpan(op, 1);
  }

  if (ui.traceCount) ui.traceCount.textContent = shown === total ? `${total} spans` : `${shown} of ${total} spans`;

  // Collapsing or filtering away the span that is playing would leave audio
  // running with no control on screen and no way to tell what it belongs to.
  if (segment.playing && !host.querySelector(`.phase-play[data-op="${CSS.escape(segment.opId)}"]`)) stopSegment();

  if (!host.childElementCount) {
    host.append(h('div', { class: 'empty-block' },
      h('b', { text: total ? 'No spans match these filters' : 'No operations captured' }),
      total
        ? h('button', { type: 'button', class: 'btn tiny', text: 'Clear filters', onClick: () => { state.opFilter = { type: 'all', errorsOnly: false, query: '' }; refreshFilteredViews(); } })
        : h('p', { text: 'The uploaded package contained no stt, llm, tts or tool events.' }),
    ));
  }
  syncSelection();
}

/* ---------------------------------------------------------- STT quality */

/**
 * STT is intentionally its own review surface.  A connection-scoped STT
 * websocket is transport health, not an utterance, so only the turn span is
 * considered here.  The same pattern can later power LLM and TTS quality
 * panels without changing the all-up call timeline above.
 */
function sttOperation(turn) {
  return (turn?.operations || []).find((op) => op.type === 'stt' && !isSocket(op)) || null;
}

function sttMilestone(op, name) {
  const point = op?.milestones?.[name];
  return typeof point?.occurred_at_ms === 'number' ? point.occurred_at_ms : null;
}

function sttResult(op) {
  const response = op?.response;
  return response && typeof response === 'object' ? response : {};
}

function sttText(op) {
  const value = sttResult(op).transcript;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sttPartialCount(op) {
  return op?.samples?.partial?.items?.length ?? 0;
}

function confidence(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

const CHALLENGER_STT_OPTIONS = [
  { value: 'elevenlabs_scribe_v2', label: 'ElevenLabs Scribe v2' },
];

function buildChallengerControl(session, comparisonUrl) {
  const trigger = h('button', { type: 'button', class: 'btn primary', text: 'Run beta comparison', 'aria-expanded': 'false' });
  const chooser = h('select', { class: 'challenger-select', 'aria-label': 'Choose a challenger STT model', hidden: true },
    h('option', { value: '', text: 'Select challenger STT…' }),
    ...CHALLENGER_STT_OPTIONS.map((option) => h('option', { value: option.value, text: option.label })),
  );
  const stateText = h('span', { class: 'challenger-state', role: 'status', 'aria-live': 'polite' });
  const control = h('div', { class: 'challenger-control' }, trigger, chooser, stateText);
  let pollTimer = null;

  const openChooser = () => {
    chooser.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    chooser.focus();
  };
  const stopPolling = () => {
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = null;
  };
  const showStatus = (job) => {
    const active = job.status === 'queued' || job.status === 'in_progress';
    const label = job.label || 'Challenger';
    if (active) {
      chooser.hidden = true;
      trigger.disabled = true;
      trigger.textContent = 'Comparing recorded audio…';
      stateText.textContent = job.status === 'queued' ? 'Queued' : 'Running';
      pollTimer = window.setTimeout(loadStatus, 1500);
      return;
    }
    stopPolling();
    trigger.disabled = false;
    if (job.status === 'completed' || job.status === 'partial') {
      chooser.hidden = true;
      trigger.textContent = 'View comparison';
      trigger.onclick = () => { window.location.href = comparisonUrl; };
      stateText.textContent = job.status === 'completed' ? `${label} complete` : `${label} ready with limited results`;
    } else if (window.__VAANI_DEMO__) {
      // The demo serves a fixed snapshot and cannot start a new evaluation.
      // Calls that already carry one keep the "View comparison" button above;
      // the rest show nothing rather than a button that would 404.
      control.remove();
    } else if (job.status === 'failed') {
      trigger.textContent = 'Retry comparison';
      trigger.onclick = openChooser;
      stateText.textContent = job.error ? `Could not run ${label}: ${job.error}` : 'Challenger evaluation failed';
    } else {
      trigger.textContent = 'Run beta comparison';
      trigger.onclick = openChooser;
      stateText.textContent = 'Replays recorded caller audio with ElevenLabs Scribe v2.';
    }
  };
  const loadStatus = async () => {
    if (!control.isConnected || state.sessionId !== session.id) return;
    try {
      const response = await fetch(`/v1/sessions/${encodeURIComponent(session.id)}/challenger-evaluation`);
      if (!response.ok) throw new Error('Could not load challenger status');
      showStatus(await response.json());
    } catch (error) {
      trigger.disabled = false;
      stateText.textContent = error.message;
    }
  };
  trigger.onclick = openChooser;
  chooser.addEventListener('change', async () => {
    if (!chooser.value) return;
    const model = chooser.value;
    trigger.disabled = true;
    chooser.disabled = true;
    stateText.textContent = 'Starting challenger evaluation…';
    try {
      const response = await fetch(`/v1/sessions/${encodeURIComponent(session.id)}/challenger-evaluation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || 'Could not start challenger evaluation');
      }
      chooser.disabled = false;
      showStatus(await response.json());
    } catch (error) {
      chooser.disabled = false;
      trigger.disabled = false;
      stateText.textContent = error.message;
    }
  });
  // The card has not been appended when this helper returns, so starting the
  // request synchronously would see a detached node and stop immediately.
  queueMicrotask(() => { void loadStatus(); });
  return control;
}

function buildSttQualityCard(session) {
  const turns = session.turns || [];
  const rows = turns.map((turn) => ({ turn, op: sttOperation(turn) })).filter(({ op }) => op);
  const partials = rows.map(({ op }) => {
    const start = sttMilestone(op, 'speech_started');
    const first = sttMilestone(op, 'first_partial');
    return start != null && first != null && first >= start ? first - start : null;
  }).filter((value) => value != null);
  const finals = rows.map(({ op }) => {
    const end = sttMilestone(op, 'speech_ended');
    const final = sttMilestone(op, 'final_transcript');
    return end != null && final != null && final >= end ? final - end : null;
  }).filter((value) => value != null);
  const configured = [...new Set(rows.map(({ op }) => op.request?.endpointing_ms).filter((value) => Number.isFinite(value)))];
  const endpointing = configured.length === 1 ? duration(configured[0]) : configured.length > 1 ? 'varies' : '—';
  const captured = rows.filter(({ op }) => sttText(op)).length;
  const callerTrack = session.recordings?.some((item) => ['call', 'caller'].includes(item.track) && item.uploaded);
  const productionModel = rows.map(({ op }) => op.model || op.request?.model).find(Boolean) || 'deepgram-nova-3';
  const comparisonUrl = `/stt-evaluation?session=${encodeURIComponent(session.id)}&production=${encodeURIComponent(productionModel)}`;

  const metric = (label, value, note, tone = null) => h('div', { class: 'stt-metric', dataset: tone ? { tone } : {} },
    h('span', { text: label }),
    h('b', { class: 'num', text: value }),
    h('small', { text: note }),
  );

  const summary = h('div', { class: 'stt-summary' },
    metric('Coverage', `${rows.length}/${turns.length || 0}`, 'recorded turns'),
    metric('Transcripts', `${captured}/${rows.length || 0}`, captured === rows.length ? 'available' : 'partial capture'),
    metric('First partial p50', partials.length ? duration(percentile(partials, 0.5)) : '—', partials.length ? 'speech → text' : 'unavailable'),
    metric('Finalization p50', finals.length ? duration(percentile(finals, 0.5)) : '—', finals.length ? 'speech end → final' : 'unavailable', finals.length && percentile(finals, 0.5) > 700 ? 'warn' : null),
    metric('Endpointing', endpointing, configured.length ? 'configured' : 'unavailable'),
  );

  const notice = h('div', { class: 'stt-notice' },
    h('b', { text: 'Live STT telemetry · Beta' }),
    h('span', { text: 'Streaming timing and transcripts. Accuracy appears after a challenger comparison.' }),
  );

  const table = h('div', { class: 'stt-turns' });
  if (!rows.length) {
    table.append(h('div', { class: 'empty-block' }, h('b', { text: 'No recorded STT turns' }), h('p', { text: 'Only spoken turns with STT telemetry appear here.' })));
  } else {
    table.append(h('div', { class: 'stt-turn stt-turn-head' },
      h('span', { text: 'Turn' }), h('span', { text: 'Production transcript' }), h('span', { text: 'Stream' }), h('span', { text: 'Finalization' }), h('span', { text: 'Review' }),
    ));
    for (const { turn, op } of rows) {
      const text = sttText(op);
      const start = sttMilestone(op, 'speech_started');
      const first = sttMilestone(op, 'first_partial');
      const end = sttMilestone(op, 'speech_ended');
      const final = sttMilestone(op, 'final_transcript');
      const firstMs = start != null && first != null && first >= start ? first - start : null;
      const finalMs = end != null && final != null && final >= end ? final - end : null;
      const result = sttResult(op);
      table.append(h('div', { class: 'stt-turn', dataset: { turnId: turn.turn_id } },
        h('button', { type: 'button', class: 'stt-turn-id', text: `#${turn.turn_id}`, title: 'Open this turn in the inspector', onClick: () => setSelection('turn', turn.turn_id, { scroll: true }) }),
        h('div', { class: 'stt-copy' },
          h('span', { text: text || 'Transcript content was not captured' }),
          text ? h('small', { text: `${confidence(result.confidence)} confidence · ${(result.words || []).length || 'no'} timed words` }) : null,
        ),
        h('div', { class: 'stt-stream' },
          h('span', { class: 'num', text: firstMs != null ? duration(firstMs) : '—' }),
          h('small', { text: `${sttPartialCount(op)} changed partial${sttPartialCount(op) === 1 ? '' : 's'}` }),
        ),
        h('div', { class: 'stt-stream' },
          h('span', { class: 'num', text: finalMs != null ? duration(finalMs) : '—' }),
          h('small', { text: result.final_reason ? `via ${result.final_reason.replace(/_/g, ' ')}` : 'not measured' }),
        ),
        callerTrack && start != null ? h('button', { type: 'button', class: 'btn tiny', text: 'Listen', onClick: () => seekMs(start) }) : h('span', { class: 'cell-missing', text: callerTrack ? 'no speech window' : 'no caller audio' }),
      ));
    }
  }

  // The STT comparison page is turned off in the public demo: it is a separate
  // deep-dive surface whose controls imply a run the snapshot cannot perform.
  // The button stays visible but inert, so the capability is still legible.
  const comparisonCta = window.__VAANI_DEMO__
    ? h('button', {
      type: 'button', class: 'btn', text: 'Open comparison', disabled: true,
      title: 'The STT comparison is not part of this demo.',
    })
    : h('a', { class: 'btn', href: comparisonUrl, text: 'Open comparison' });

  return h('section', { class: 'card stt-card', id: 'stt-quality' },
    h('div', { class: 'card-head' },
      h('h3', {}, 'STT review', h('span', { class: 'chip', dataset: { tone: 'warn' }, text: 'Beta' })),
      h('div', { class: 'card-tools' },
        h('span', { class: 'chip', text: rows.length ? `${rows.length} captured STT turn${rows.length === 1 ? '' : 's'}` : 'not captured' }),
        window.__VAANI_DEMO__ ? null : buildChallengerControl(session, comparisonUrl),
        comparisonCta,
      ),
    ),
    h('div', { class: 'card-body flush' }, notice, summary, table),
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
  status: (op) => effectiveStatus(op) || '',
};

const reportedCostCache = new WeakMap();

function hasReportedModelCosts() {
  const operations = state.session?.operations;
  if (!operations) return false;
  const cached = reportedCostCache.get(operations);
  if (cached !== undefined) return cached;
  const answer = operations.some((op) => op.type === 'llm' && decodeCompletion(op.response).cost);
  reportedCostCache.set(operations, answer);
  return answer;
}

function visibleOperationColumns() {
  return hasReportedModelCosts() ? OP_COLUMNS : OP_COLUMNS.filter((column) => column.key !== 'cost');
}

function buildOperationsCard() {
  const { seg, errorsToggle, search } = buildOpFilterControls(refreshFilteredViews);
  search.value = state.opFilter.query;

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
      h('div', { class: 'card-tools' }, ui.opCount, seg, errorsToggle, search),
    ),
    h('div', { class: 'card-body flush scroll-cap' }, head, ui.opRows),
  );
  return ui.opsCard;
}

function syncOpFilterControls() {
  for (const button of ui.opSeg?.querySelectorAll('button') || []) {
    button.setAttribute('aria-pressed', String(button.dataset.opType === state.opFilter.type));
  }
  if (ui.opErrors) {
    ui.opErrors.setAttribute('aria-pressed', String(state.opFilter.errorsOnly));
    // A call with nothing to filter to should say so before it is clicked. Left
    // enabled, the control's only possible outcome is an empty list, which reads
    // as a broken filter rather than as a clean call.
    const anyFailed = (state.session?.operations || []).some((op) => effectiveStatus(op) === 'error');
    ui.opErrors.disabled = !anyFailed && !state.opFilter.errorsOnly;
    ui.opErrors.title = anyFailed ? '' : 'No failed operations in this call';
  }
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
  const rows = all.filter(matchesOpFilter);

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
        ? h('button', { type: 'button', class: 'btn tiny', text: 'Clear filters', onClick: () => { state.opFilter = { type: 'all', errorsOnly: false, query: '' }; refreshFilteredViews(); } })
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
      `status ${effectiveStatus(op) || 'unknown'}`,
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
      h('span', { class: 'state-dot', dataset: { status: effectiveStatus(op) }, text: effectiveStatus(op) || '—' }),
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

  // Where the call pane is too narrow to give the inspector a column, it docks
  // over the trace instead of reflowing it — a 400px column taken out of a
  // 1000px pane crushes the step names in the table the selection came from.
  // Docked, it needs a way out that is not the keyboard.
  return h('section', { class: 'card inspector' },
    h('div', { class: 'card-head' },
      ui.inspectorTitle,
      ui.inspectorTools,
      h('button', {
        type: 'button', class: 'icon-btn inspector-close',
        title: 'Close the inspector  ·  esc', 'aria-label': 'Close the inspector',
        onClick: () => setSelection(null, null),
      }, glyph(PATH.close, 13)),
    ),
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
  if (ui.columns) ui.columns.dataset.inspector = subject ? 'open' : 'idle';
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

/**
 * Whether an LLM span came from the HTTP instrumentation rather than the agent
 * framework. Only the transport span carries a status code and a body; only the
 * framework span carries tokens and TTFT.
 */
function isTransportSpan(op) {
  return Boolean(op?.request?.body) || op?.response?.status != null;
}

/**
 * The other half of the same model call.
 *
 * A voice agent records one LLM call twice — the framework reports tokens and
 * TTFT, the HTTP instrumentation reports the request body — and neither span
 * can answer the other's questions. Without this link an inspector lands on the
 * framework span, finds empty request and response tabs, and has no way to know
 * the body is sitting on a sibling span a few milliseconds away.
 */
function llmCounterpart(op) {
  if (!op || op.type !== 'llm' || op.turn_id == null || !state.opsById) return null;
  const wanted = !isTransportSpan(op);
  const start = op.started_at_ms ?? 0;
  const end = op.ended_at_ms ?? start;
  let best = null;
  let bestGap = Infinity;
  for (const other of state.opsById.values()) {
    if (other === op || other.type !== 'llm') continue;
    if (String(other.turn_id) !== String(op.turn_id)) continue;
    if (isTransportSpan(other) !== wanted) continue;
    const otherStart = other.started_at_ms ?? 0;
    const otherEnd = other.ended_at_ms ?? otherStart;
    if (otherStart > end || otherEnd < start) continue;
    const gap = Math.abs(otherStart - start);
    if (gap < bestGap) { best = other; bestGap = gap; }
  }
  return best;
}

function counterpartNotice(panel, op, what) {
  const other = llmCounterpart(op);
  if (!other) return false;
  const toTransport = isTransportSpan(other);
  panel.append(h('div', { class: 'banner', dataset: { tone: 'info' }, style: { marginBottom: '10px' } },
    h('div', {},
      h('b', { text: `The ${what} is on the other half of this call` }),
      h('span', {
        text: toTransport
          ? 'This span came from the agent framework, which reports tokens and timing but never the payload. The HTTP request that served it was recorded separately.'
          : 'This span came from the HTTP instrumentation, which never sees token counts. The framework recorded those separately.',
      }),
    ),
    h('button', {
      type: 'button', class: 'btn tiny',
      text: toTransport ? 'Open the HTTP span with the payload' : 'Open the framework span with the tokens',
      onClick: () => setSelection('op', other.event_id, { scroll: true }),
    }),
  ));
  return true;
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
      ['Status', effectiveStatus(op)],
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
      const other = llmCounterpart(op);
      panel.append(h('div', { class: 'code-head' },
        h('h4', { text: 'Related' }),
        h('button', { type: 'button', class: 'btn tiny', text: `Open turn #${op.turn_id}`, onClick: () => setSelection('turn', String(op.turn_id), { scroll: true }) }),
        other ? h('button', {
          type: 'button', class: 'btn tiny',
          text: isTransportSpan(other) ? 'Open the HTTP span (payload)' : 'Open the framework span (tokens)',
          onClick: () => setSelection('op', other.event_id, { scroll: true }),
        }) : null,
      ));
    }
    return;
  }

  if (tab === 'request') {
    if (op.type === 'llm') {
      const { request, truncated, originalBytes, unparsed } = parseRequestBody(op);
      if (!op.request?.body) counterpartNotice(panel, op, 'request body');
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
      const skipped = op.response?.body?._capture_skipped;
      if (!completion.text && !completion.toolCalls.length) counterpartNotice(panel, op, 'response body');
      if (skipped) {
        panel.append(h('div', { class: 'banner', dataset: { tone: 'warn' }, style: { marginBottom: '10px' } },
          h('div', {},
            h('b', { text: 'Response body not captured' }),
            h('span', { text: `${skipped} Draining a streamed reply to record it would delay the caller's first token, which is the latency this SDK exists to measure. Use the conversation view for what the agent actually said.` }),
          ),
        ));
      }
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
      ['Turn', turn.continues_turn
        // Reading this half's latency as a whole turn's is the mistake the
        // label exists to prevent.
        ? `#${turn.turn_id} — second half of #${turn.continues_turn}, which LiveKit committed as one message`
        : `#${turn.turn_id}`],
      ['Status', turn.status],
      ['Starts at', offset(turn.started_at_ms)],
      ['Ends at', offset(turn.ended_at_ms)],
      ['Turn length', duration(turn.duration_ms) || '—'],
      ['Caller speech', duration(turn.user_speech_ms) || 'no stt span'],
      ['Model time', turn.llm_ms == null ? 'no model call' : `${duration(turn.llm_ms)} over ${turn.llm_calls} call(s)`],
      ['Audible speech out', turn.reply_skipped
        ? (turn.reply_skipped === 'callback_error'
          ? 'none — the agent\'s turn callback raised, so LiveKit never replied'
          : 'none — the agent declined to answer')
        : (duration(turn.audible_tts_ms) || 'not captured')],
      ['TTS provider work', duration(turn.tts_ms) || 'no tts span'],
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
      if (firstAudio != null) {
        // Turns with no STT span have no measured start, so the delta is not a
        // number. Label the instant rather than claiming "+null".
        const reply = duration(turn.time_to_first_audio_ms);
        marker(firstAudio, reply ? `first audio +${reply}` : 'first audio', latencyTone(turn.time_to_first_audio_ms));
      }
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

/**
 * The call player.
 *
 * Reviewing a voice agent is an listening exercise before it is a reading one:
 * every latency number on this page is a claim about something that either did
 * or did not happen in the recording. So the player draws the real amplitude
 * envelope of the call — the agent channel above the caller channel — and lets
 * the reviewer scrub, zoom, loop and hear a single turn against the same clock
 * the timeline and trace are drawn on.
 */

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const ZOOMS = [1, 2, 4, 8, 16];
/** A reviewer who has asked the operating system for less motion should not get
 *  a sweeping playhead or a viewport that glides under their cursor. Read live
 *  rather than cached — the preference can be flipped mid-session. */
const calmMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
const wantsCalm = () => !!calmMotion?.matches;
// Bar pitch in CSS pixels: 2px of ink and 1px of air reads as a waveform rather
// than a solid block, and keeps the bucket count a screen actually needs small.
const WAVE_PITCH = 3;
const WAVE_LANE_GAP = 8;
/* Canvas cannot read a CSS variable, so the waveform palette is pulled off the
   root element and cached until the theme changes. Without this the wave keeps
   its dark-tuned pastels on a white card and reads as an empty rail. */
const CHANNEL_TOKEN = { agent: 'agent', caller: 'caller', mixed: 'mixed', call: 'mixed' };
const CHANNEL_LABEL = { agent: 'Agent', caller: 'Caller', mixed: 'Mixed', call: 'Call' };
let wavePalette = null;

const readToken = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function buildWavePalette() {
  const alpha = Number(readToken('--wave-dim-a')) || 0.28;
  const lift = readToken('--wave-lift-rgb') || '255 255 255';
  const tones = {};
  for (const [channel, token] of Object.entries(CHANNEL_TOKEN)) {
    const ink = readToken(`--wave-${token}`) || '#9bb8e8';
    const rgb = readToken(`--wave-${token}-rgb`) || '155 184 232';
    tones[channel] = { ink, dim: `rgb(${rgb} / ${alpha * 100}%)`, label: CHANNEL_LABEL[channel] };
  }
  return { tones, lift };
}

const palette = () => (wavePalette ||= buildWavePalette());
/* A lift is white on a dark theme and shade on a light one, so the same rule
   reads as "raise this off the surface" in both. */
const waveLift = (percent) => `rgb(${palette().lift} / ${percent}%)`;
const toneFor = (name) => palette().tones[name] || palette().tones.call;

window.addEventListener('vaani:themechange', () => { wavePalette = null; });

const PATH = {
  play: 'M5.2 3.3a.8.8 0 0 1 1.2-.68l6 4.7a.8.8 0 0 1 0 1.36l-6 4.7A.8.8 0 0 1 5.2 12.7Z',
  pause: 'M5 3h2.2v10H5Zm3.8 0H11v10H8.8Z',
  speaker: 'M8.2 2.3a.7.7 0 0 1 .4.63v10.14a.7.7 0 0 1-1.14.55L4.6 11.2H2.7a.7.7 0 0 1-.7-.7V5.5a.7.7 0 0 1 .7-.7h1.9l2.86-2.42a.7.7 0 0 1 .74-.08Zm2.5 2.1a.7.7 0 0 1 .98.13 5.7 5.7 0 0 1 0 6.94.7.7 0 1 1-1.11-.85 4.3 4.3 0 0 0 0-5.24.7.7 0 0 1 .13-.98Z',
  muted: 'M8.2 2.3a.7.7 0 0 1 .4.63v10.14a.7.7 0 0 1-1.14.55L4.6 11.2H2.7a.7.7 0 0 1-.7-.7V5.5a.7.7 0 0 1 .7-.7h1.9l2.86-2.42a.7.7 0 0 1 .74-.08Zm2.36 3.03a.7.7 0 0 1 .99 0L12.6 6.4l1.05-1.06a.7.7 0 1 1 .99.99L13.59 7.4l1.05 1.05a.7.7 0 1 1-.99.99L12.6 8.38l-1.05 1.06a.7.7 0 1 1-.99-.99l1.05-1.05-1.05-1.06a.7.7 0 0 1 0-.99Z',
  back: 'M7.7 2.2a.7.7 0 0 1 0 1.18l-.86.6A4.6 4.6 0 1 1 3.4 8.3a.7.7 0 1 1 1.4-.1 3.2 3.2 0 1 0 2.5-3.26l.83.58a.7.7 0 1 1-.8 1.15L5.1 5.24a.7.7 0 0 1 0-1.15l2.2-1.53a.7.7 0 0 1 .4-.36Z',
  forward: 'M8.3 2.2a.7.7 0 0 0 0 1.18l.86.6A4.6 4.6 0 1 0 12.6 8.3a.7.7 0 1 0-1.4-.1 3.2 3.2 0 1 1-2.5-3.26l-.83.58a.7.7 0 1 0 .8 1.15l2.23-1.43a.7.7 0 0 0 0-1.15L8.7 2.56a.7.7 0 0 0-.4-.36Z',
  loop: 'M4.8 3.2h5.1a2.9 2.9 0 0 1 2.9 2.9v.6a.7.7 0 1 1-1.4 0v-.6c0-.83-.67-1.5-1.5-1.5H4.8v1.05a.5.5 0 0 1-.8.4L1.7 4.3a.5.5 0 0 1 0-.8l2.3-1.75a.5.5 0 0 1 .8.4Zm6.4 9.6H6.1a2.9 2.9 0 0 1-2.9-2.9v-.6a.7.7 0 1 1 1.4 0v.6c0 .83.67 1.5 1.5 1.5h5.1v-1.05a.5.5 0 0 1 .8-.4l2.3 1.75a.5.5 0 0 1 0 .8l-2.3 1.75a.5.5 0 0 1-.8-.4Z',
  download: 'M8 1.6a.7.7 0 0 1 .7.7v6.1l1.9-1.9a.7.7 0 1 1 1 1L8.5 10.6a.7.7 0 0 1-1 0L4.4 7.5a.7.7 0 1 1 1-1l1.9 1.9V2.3a.7.7 0 0 1 .7-.7ZM2.6 10.4a.7.7 0 0 1 .7.7v1.4h9.4v-1.4a.7.7 0 1 1 1.4 0v1.7a1.1 1.1 0 0 1-1.1 1.1H2.9a1.1 1.1 0 0 1-1.1-1.1v-1.7a.7.7 0 0 1 .7-.7Z',
  zoomIn: 'M7 1.8a5.2 5.2 0 0 1 4.1 8.42l3 3a.75.75 0 0 1-1.06 1.06l-3-3A5.2 5.2 0 1 1 7 1.8Zm0 1.5a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Zm0 1.2a.6.6 0 0 1 .6.6v1.3h1.3a.6.6 0 1 1 0 1.2H7.6v1.3a.6.6 0 1 1-1.2 0V7.6H5.1a.6.6 0 0 1 0-1.2h1.3V5.1a.6.6 0 0 1 .6-.6Z',
  zoomOut: 'M7 1.8a5.2 5.2 0 0 1 4.1 8.42l3 3a.75.75 0 0 1-1.06 1.06l-3-3A5.2 5.2 0 1 1 7 1.8Zm0 1.5a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4ZM5.1 6.4h3.8a.6.6 0 1 1 0 1.2H5.1a.6.6 0 0 1 0-1.2Z',
  lanes: 'M2.2 3.1h7.3a.75.75 0 0 1 0 1.5H2.2a.75.75 0 0 1 0-1.5Zm4 4.15h7.6a.75.75 0 0 1 0 1.5H6.2a.75.75 0 0 1 0-1.5Zm-4 4.15h5.6a.75.75 0 0 1 0 1.5H2.2a.75.75 0 0 1 0-1.5Z',
  chevronUp: 'M7.47 5.72a.75.75 0 0 1 1.06 0l4 4a.75.75 0 1 1-1.06 1.06L8 7.31l-3.47 3.47a.75.75 0 0 1-1.06-1.06Z',
  chevronDown: 'M3.47 5.72a.75.75 0 0 1 1.06 0L8 9.19l3.47-3.47a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 0-1.06Z',
  close: 'M4.22 4.22a.75.75 0 0 1 1.06 0L8 6.94l2.72-2.72a.75.75 0 1 1 1.06 1.06L9.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L8 9.06l-2.72 2.72a.75.75 0 0 1-1.06-1.06L6.94 8 4.22 5.28a.75.75 0 0 1 0-1.06Z',
};

function glyph(path, size = 14) {
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
}

/** Playback preferences a reviewer sets once and expects to keep across calls. */
const PREF_KEY = 'vaani.player';
function readPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return {
      volume: Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : 1,
      muted: saved.muted === true,
      rate: SPEEDS.includes(saved.rate) ? saved.rate : 1,
      coached: saved.coached === true,
      lanes: saved.lanes !== false,
    };
  } catch { return { volume: 1, muted: false, rate: 1, coached: false, lanes: true }; }
}
function writePrefs(prefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

/** One review source per call. Speaker windows remain annotated in the trace. */
function audioTracks(session) {
  const uploaded = (session.recordings || []).filter((track) => track.uploaded);
  if (!uploaded.length) return [];
  const stereo = uploaded.find((track) => track.track === 'call');
  if (stereo) {
    return [{ id: 'call', label: 'Call recording', note: `${bytes(stereo.size_bytes)} · ${stereo.sample_rate_hz} Hz · stereo call` }];
  }
  if (uploaded.length > 1) {
    return [{ id: 'mixed', label: 'Mixed call', note: 'caller and agent, mixed' }];
  }
  const only = uploaded[0];
  return [{ id: only.track, label: only.track === 'agent' ? 'Agent' : only.track === 'caller' ? 'Caller' : 'Call recording', note: `${bytes(only.size_bytes)} · ${only.sample_rate_hz} Hz · ${only.encoding}` }];
}

function buildAudioCard(session) {
  const recordings = session.recordings || [];
  const tracks = audioTracks(session);
  const body = h('div', { class: 'card-body' });
  const tools = h('div', { class: 'card-tools' });

  // No header. A waveform, a play button and a clock do not need a card
  // labelled "Call audio" above them, and the hint that it is drawn on the
  // call clock was a caption on a chart that is the only chart here. The
  // controls that lived in the header now sit in the transport bar, next to
  // the playhead the reviewer is already watching.
  const card = h('section', { class: 'card player-card' }, body);

  if (!tracks.length) {
    body.append(h('div', { class: 'empty-block' },
      h('b', { text: 'No audio uploaded' }),
      h('p', { text: recordings.length ? 'The manifest declares tracks, but their objects never reached the observer.' : 'This package declared no audio tracks.' }),
    ));
    // The spans used to have a tab of their own. With nothing to draw them
    // against, they still have to be drawn somewhere, or a call that failed
    // before it recorded anything would show no evidence at all.
    body.append(h('div', { class: 'player-timeline' },
      h('div', { class: 'player-timeline-head' },
        h('b', { text: 'Call timeline' }),
        h('span', { class: 'hint', text: 'on the call clock — there is no recording to line it up with' }),
        spanLegend(session),
      ),
      buildTimelineSurface(session),
    ));
    return card;
  }

  const prefs = readPrefs();
  const audio = new Audio();
  // Media events queued for a call that has been closed would otherwise keep
  // its DOM alive and write into the next call's controls.
  const listeners = new AbortController();
  const bind = (type, handler, target = audio) => target.addEventListener(type, handler, { signal: listeners.signal });
  state.audioListeners = listeners;
  state.audio = audio;
  audio.preload = 'metadata';
  audio.volume = prefs.volume;
  audio.muted = prefs.muted;
  audio.playbackRate = prefs.rate;

  /* ------------------------------------------------------------- surface */

  const canvas = h('canvas', { class: 'wave-canvas' });
  const strip = h('div', { class: 'wave-strip' }, canvas);
  // A canvas is opaque to assistive technology, so everything the drawing says
  // — how long the call is, how many turns it has, which one was worst — has to
  // be said again in text. `aria-description` is still patchy across screen
  // readers; a described-by target works everywhere.
  const summaryId = `wave-summary-${String(session.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'call'}`;
  const waveSummary = h('span', { class: 'sr-only', id: summaryId, text: 'Waveform of the call.' });
  // Playing a call is a stream of events a sighted reviewer reads off the
  // canvas. Announcing each turn as the playhead enters it is the same
  // information, delivered politely enough not to interrupt.
  const waveLive = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const viewport = h('div', { class: 'wave-viewport', tabindex: '0', role: 'slider',
    'aria-label': 'Seek within the call', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
    'aria-valuetext': 'Nothing loaded yet', 'aria-describedby': summaryId }, strip);
  const regions = h('div', { class: 'wave-regions' });
  const gaps = h('div', { class: 'wave-gaps' });
  const loopFrom = h('span', { class: 'loop-grip', dataset: { edge: 'from' } });
  const loopTo = h('span', { class: 'loop-grip', dataset: { edge: 'to' } });
  const loopTag = h('span', { class: 'loop-tag' });
  const loopBand = h('div', { class: 'wave-loop', hidden: true }, loopFrom, loopTo, loopTag);
  const spanBand = h('div', { class: 'wave-span', hidden: true });
  const tailBand = h('div', { class: 'wave-tail', hidden: true }, h('span', { class: 'wave-tail-label', text: 'after the call ended' }));
  const playhead = h('div', { class: 'wave-head', hidden: true });
  const hoverLine = h('div', { class: 'wave-hover', hidden: true });
  const ruler = h('div', { class: 'wave-ruler' });
  const marks = h('div', { class: 'wave-marks' });
  // The spans sit between the envelope and the turn marks, on the waveform's
  // own axis, so they zoom and scroll with it. Reading "the model was still
  // working here" off the same pixels as the silence you can hear is the whole
  // reason the timeline moved into the player.
  const lanes = h('div', { class: 'wave-lanes' });
  strip.append(regions, tailBand, gaps, spanBand, loopBand, lanes, marks, hoverLine, playhead, ruler);

  const bubble = h('div', { class: 'wave-bubble', hidden: true });
  const skeleton = h('div', { class: 'wave-skeleton' }, h('span', { class: 'wave-skeleton-label', text: 'Reading the waveform…' }));
  // Shift-drag and double-click-to-loop are the two gestures that make this
  // player worth using, and both are invisible. The hint below the card is
  // easily below the fold, so the first call a reviewer ever opens says it out
  // loud, once, over the waveform itself.
  function dismissCoach() {
    coach.hidden = true;
    clearTimeout(coachTimer);
    if (prefs.coached) return;
    prefs.coached = true;
    savePrefs();
  }
  const coach = h('div', { class: 'wave-coach', hidden: prefs.coached },
    h('span', { class: 'coach-line' }, h('kbd', { text: 'shift' }), ' + drag to loop a range'),
    h('span', { class: 'coach-line' }, h('kbd', { text: 'double-click' }), ' a turn to replay it'),
    h('button', { type: 'button', class: 'coach-x', 'aria-label': 'Dismiss this hint', text: '✕', onClick: dismissCoach }),
  );
  // Leaving the call inside the nine seconds must not leave a timer writing to
  // a card that no longer exists.
  const coachTimer = prefs.coached ? null : setTimeout(dismissCoach, 9000);
  listeners.signal.addEventListener('abort', () => clearTimeout(coachTimer));
  // A zoomed view can be panned minutes away from the playhead, and then the
  // clock and the picture describe different parts of the call. These say which
  // way the playhead went and take the reviewer back to it.
  const backLeft = h('button', {
    type: 'button', class: 'wave-return at-left', hidden: true,
    'aria-label': 'Playhead is to the left — scroll back to it',
    onClick: () => centreOn(audio.currentTime),
  }, '◂ playhead');
  const backRight = h('button', {
    type: 'button', class: 'wave-return at-right', hidden: true,
    'aria-label': 'Playhead is to the right — scroll forward to it',
    onClick: () => centreOn(audio.currentTime),
  }, 'playhead ▸');
  const shell = h('div', { class: 'wave-shell' }, viewport, skeleton, coach, bubble, waveSummary, waveLive, backLeft, backRight);

  // A zoomed view answers "what happened here" but loses "where am I"; the
  // overview keeps the whole call on screen with the visible window drawn on it.
  const mini = h('canvas', { class: 'mini-canvas' });
  const miniWindow = h('div', { class: 'mini-window' });
  const miniStrip = h('div', { class: 'mini-strip', title: 'Drag to move the zoomed view' }, mini, miniWindow);
  const miniWrap = h('div', { class: 'wave-mini', hidden: true }, miniStrip);

  /* ------------------------------------------------------------ controls */

  const playIcon = glyph(PATH.play, 16);
  const playButton = h('button', {
    type: 'button', class: 'play-btn', 'aria-label': 'Play', title: 'Play or pause  ·  space',
    onClick: () => togglePlay(),
  }, playIcon);

  // Spelled out rather than hidden inside the arrow: a reviewer should never
  // have to hover a transport button to find out how far it jumps.
  const nudge = (seconds, path, hint) => h('button', {
    type: 'button', class: 'nudge', title: hint, 'aria-label': hint,
    onClick: () => seekTo(audio.currentTime + seconds),
  }, glyph(path, 15), h('span', { class: 'nudge-n', text: `${Math.abs(seconds)}s` }));

  const current = h('span', { class: 'time-now', text: '0:00.000' });
  const total = h('span', { class: 'time-total', text: '--:--.---' });

  const volumeSlider = h('input', {
    type: 'range', min: '0', max: '1', step: '0.05', value: String(prefs.volume),
    class: 'vol-range', 'aria-label': 'Volume',
    onInput: (event) => {
      audio.volume = Number(event.target.value);
      audio.muted = audio.volume === 0;
      savePrefs();
      paintVolume();
    },
  });
  const volumeIcon = glyph(prefs.muted || prefs.volume === 0 ? PATH.muted : PATH.speaker, 14);
  const muteButton = h('button', {
    type: 'button', class: 'icon-btn', title: 'Mute  ·  m', 'aria-label': 'Mute',
    onClick: () => { audio.muted = !audio.muted; savePrefs(); paintVolume(); },
  }, volumeIcon);

  const speed = h('select', { class: 'player-select', 'aria-label': 'Playback speed', title: 'Playback speed  ·  [ and ]',
    onChange: (event) => { audio.playbackRate = Number(event.target.value); savePrefs(); } },
    ...SPEEDS.map((value) => h('option', { value: String(value), selected: value === prefs.rate ? 'selected' : null, text: `${value.toFixed(2).replace(/0$/, '').replace(/\.$/, '')}×` })),
  );

  const loopButton = h('button', {
    type: 'button', class: 'chip-btn', 'aria-pressed': 'false', title: 'Loop the selection, or the whole call  ·  l',
    onClick: () => { view.loop = !view.loop; applyLoop(); },
  }, glyph(PATH.loop, 14), h('span', { text: 'Loop' }));

  // The lane costs vertical space in a card that is pinned to the top of the
  // page, so a reviewer who only wants to listen can put it away and have it
  // stay away.
  const lanesButton = h('button', {
    type: 'button', class: 'chip-btn', 'aria-pressed': String(prefs.lanes),
    title: 'Show provider spans under the waveform  ·  s',
    onClick: () => setLanes(!prefs.lanes),
  }, glyph(PATH.lanes, 14), h('span', { text: 'Spans' }));

  // The control bar's dead centre is the best place for the one thing a
  // reviewer always wants while listening: which turn they are inside, and how
  // long that turn made the caller wait.
  const nowChip = h('button', {
    type: 'button', class: 'now-chip', hidden: true,
    onClick: () => { if (view.liveTurn) setSelection('turn', view.liveTurn.turn_id, { scroll: true }); },
  });

  const selectionChip = h('button', {
    type: 'button', class: 'chip-btn selection-chip', hidden: true, title: 'Clear the loop selection  ·  esc',
    onClick: () => setSelectionRange(null),
  });

  // The waveform is the scrubber while the deck is open. Folded to a transport
  // bar it is gone, and a player you cannot seek is a player you have to open
  // again to use — which is the whole thing the fold was meant to avoid.
  const railFill = h('span', { class: 'mini-rail-fill' });
  const miniRail = h('div', {
    class: 'mini-rail', role: 'presentation', title: 'Drag to seek',
  }, railFill);

  const zoomOut = h('button', { type: 'button', class: 'icon-btn', title: 'Zoom out  ·  −', 'aria-label': 'Zoom out', onClick: () => setZoom(-1) }, glyph(PATH.zoomOut, 15));
  const zoomIn = h('button', { type: 'button', class: 'icon-btn', title: 'Zoom in  ·  +', 'aria-label': 'Zoom in', onClick: () => setZoom(1) }, glyph(PATH.zoomIn, 15));
  const zoomLabel = h('button', { type: 'button', class: 'zoom-level num', title: 'Fit the whole call  ·  0', text: 'fit', onClick: () => setZoom(0, { absolute: 1 }) });

  const download = h('a', { class: 'icon-btn', download: '', title: 'Download this track as WAV', 'aria-label': 'Download WAV' }, glyph(PATH.download, 15));

  const trackChips = h('div', { class: 'seg', role: 'group', 'aria-label': 'Audio source' });
  if (tracks.length > 1) {
    for (const track of tracks) {
      trackChips.append(h('button', {
        type: 'button', class: 'seg-btn', dataset: { track: track.id }, text: track.label,
        'aria-pressed': 'false', title: track.note,
        onClick: () => chooseTrack(track.id),
      }));
    }
    tools.append(trackChips);
  }

  // Only the lines that carry a problem stay under the bar. The track's size,
  // sample rate and colour key were four permanent rows of chrome above the
  // fold for facts a reviewer needs once, so they live in the track tooltips
  // and the lane labels instead.
  const drift = h('p', { class: 'track-note is-warn', hidden: true });
  const error = h('p', { class: 'audio-error', hidden: true });
  const peaksNote = h('p', { class: 'track-note is-warn peaks-note', hidden: true });

  body.append(h('div', { class: 'player' },
    shell,
    miniWrap,
    h('div', { class: 'player-bar' },
      h('div', { class: 'transport' },
        nudge(-10, PATH.back, 'Back 10 seconds  ·  shift + ←'),
        playButton,
        nudge(10, PATH.forward, 'Forward 10 seconds  ·  shift + →'),
      ),
      h('div', { class: 'player-time num' }, current, h('span', { class: 'time-sep', text: '/' }), total),
      miniRail,
      h('div', { class: 'player-spacer' }, nowChip, selectionChip),
      h('div', { class: 'player-tools' },
        tools,
        lanesButton,
        loopButton,
        h('div', { class: 'vol' }, muteButton, volumeSlider),
        speed,
        h('div', { class: 'zoom' }, zoomOut, zoomLabel, zoomIn),
        download,
      ),
    ),
    drift,
    error,
    peaksNote,
  ));

  /* --------------------------------------------------------------- state */

  const view = {
    zoom: 1,
    peaks: null,
    peaksKey: null,
    loading: false,
    selection: null,   // { from, to } in seconds
    loop: false,
    span: null,        // the trace span being auditioned, in ms
    aligned: false,
    overview: null,
    liveTurn: null,
  };
  const peakCache = new Map();
  const peaksInFlight = new Set();
  let peaksTicket = 0;

  // The prefs object carries more than the media element does — the coach flag
  // is not readable from `audio` — so a save has to start from it rather than
  // rebuild it, or dismissing the hint is undone by the next volume nudge.
  const savePrefs = () => writePrefs({ ...prefs, volume: audio.volume, muted: audio.muted, rate: audio.playbackRate });
  const durationMs = () => (Number.isFinite(audio.duration) ? audio.duration * 1000 : 0);
  /** The clock the waveform is drawn on.
   *
   * A six-minute stereo preview is tens of megabytes, and the media element
   * publishes no duration until it has read enough of it. The envelope and the
   * manifest both already know how long the call is, so the ruler, the turn
   * marks and the scrubber are usable from the first paint instead of sitting
   * at `--:--` while the recording downloads. */
  const clockLength = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    const known = view.peaks?.duration_ms || session.manifest?.duration_ms || 0;
    return known / 1000;
  };
  /** Where the playhead belongs, including a scrub the media element has not
   *  been able to accept yet. */
  const playedSeconds = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime : (pendingSeek ?? 0));

  function paintVolume() {
    const off = audio.muted || audio.volume === 0;
    volumeIcon.firstChild.setAttribute('d', off ? PATH.muted : PATH.speaker);
    muteButton.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
    muteButton.dataset.off = String(off);
    volumeSlider.value = String(audio.muted ? 0 : audio.volume);
  }
  paintVolume();

  function seekTo(seconds) {
    const length = clockLength();
    if (!length) return;
    const at = Math.max(0, Math.min(length, seconds));
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = at;
    } else {
      // Scrubbing before the media element knows its own length is normal on a
      // long call; the position is remembered and applied the moment it does.
      pendingSeek = at;
    }
    paintPlayer();
  }

  function togglePlay() {
    if (audio.paused) {
      audio.play().catch((reason) => { error.hidden = false; error.textContent = `Playback failed: ${reason.message}`; });
    } else audio.pause();
  }
  ui.togglePlay = togglePlay;

  /* ------------------------------------------------------------ waveform */

  function stripWidth() { return Math.max(1, strip.clientWidth); }
  function viewportWidth() { return Math.max(1, viewport.clientWidth); }

  function timeAt(clientX) {
    const box = strip.getBoundingClientRect();
    const fraction = (clientX - box.left) / Math.max(1, box.width);
    return Math.max(0, Math.min(1, fraction)) * clockLength();
  }

  async function loadPeaks() {
    // The card is built detached, so the first call measures a 1px viewport and
    // would ask the server to render the whole recording at a useless 64
    // buckets. The ResizeObserver fires again the moment it is laid out.
    if (!viewport.clientWidth) return;
    const wanted = Math.max(64, Math.min(4000, Math.round((viewportWidth() * view.zoom) / WAVE_PITCH)));
    const key = `${state.audioTrack}:${wanted}`;
    // Both early returns end the swap too: switching back to a track already in
    // the cache is instant, and leaving the ghost dimmed would strand the
    // waveform at a quarter opacity with nothing left to load.
    // Zooming back to a level that did load has to retract the "you are looking
    // at a stale envelope" note as well as the skeleton, or the warning outlives
    // the condition it describes.
    if (view.peaksKey === key) {
      skeleton.hidden = true;
      shell.classList.remove('is-swapping');
      if (view.peaksError) { view.peaksError = null; refreshPeaksError(); }
      return;
    }
    if (peakCache.has(key)) {
      view.peaksKey = key;
      view.peaks = peakCache.get(key);
      view.peaksError = null;
      skeleton.hidden = true;
      shell.classList.remove('is-swapping');
      refreshPeaksError();
      paintWave();
      return;
    }
    // Restoring a hidden tab fires `visibilitychange` and then, on the very
    // next rendering step, the ResizeObserver — two identical requests, each a
    // full re-render of the recording server-side. The ticket makes the result
    // correct; this makes it cheap.
    if (peaksInFlight.has(key)) return;
    peaksInFlight.add(key);
    view.loading = !view.peaks;
    skeleton.hidden = !view.loading;
    const requested = state.audioTrack;
    // Zooming twice quickly leaves two renders in flight; without a ticket the
    // coarser one can land last and pin the waveform below the zoom's detail.
    const ticket = (peaksTicket += 1);
    try {
      const summary = await api(`/v1/sessions/${encodeURIComponent(session.id)}/audio/${encodeURIComponent(requested)}/peaks?buckets=${wanted}`);
      // Peaks arriving for a track or a call the reviewer has already left must
      // never be drawn over what they are looking at now.
      if (state.audio !== audio || state.audioTrack !== requested) return;
      for (const channel of summary.channels || []) {
        // A caller on a phone line is routinely 10 dB quieter than a synthesised
        // agent voice. Drawn at true scale their channel is a flat line, which
        // hides exactly the barge-ins and half-words a reviewer is looking for,
        // so each lane is drawn against its own loudest moment. Levels are
        // therefore comparable within a lane and never between two.
        const loudest = Math.max(0, ...(channel.peaks || [0]));
        channel.gain = loudest > 0 ? Math.min(6, (summary.scale || 1000) / loudest) : 1;
      }
      peakCache.set(key, summary);
      if (ticket !== peaksTicket) return;
      view.peaks = summary;
      view.peaksKey = key;
      view.peaksError = null;
    } catch (reason) {
      // A missing envelope only costs the drawing; playback still works, so the
      // player falls back to a plain progress bar rather than an error. Silence
      // is the wrong call though: without a note the reviewer cannot tell a
      // quiet call from a failed request, nor — when an older envelope survives
      // — that the detail they just zoomed for never arrived.
      if (state.audio !== audio) return;
      view.peaksError = { detail: reason?.message || 'the request failed', stale: !!view.peaks };
      view.peaks = view.peaks || null;
    } finally {
      peaksInFlight.delete(key);
      if (state.audio === audio) {
        view.loading = false;
        skeleton.hidden = true;
        shell.classList.remove('is-swapping');
        refreshPeaksError();
        refreshClock();
        paintWave();
      }
    }
  }

  /** The waveform is a reading aid, not the playback itself, so a failed render
   *  is a note rather than a blocking error — but it is still a note, with the
   *  one action that might fix it. */
  function refreshPeaksError() {
    clear(peaksNote);
    peaksNote.hidden = !view.peaksError;
    if (!view.peaksError) return;
    const { detail, stale } = view.peaksError;
    peaksNote.append(
      h('span', {
        text: stale
          ? `The waveform could not be redrawn at this zoom — ${detail}. You are looking at the last envelope that loaded.`
          : `The waveform could not be drawn — ${detail}. Playback and the timings below are unaffected.`,
      }),
      h('button', {
        type: 'button', class: 'btn ghost', text: 'Try again',
        onClick: () => { view.peaksError = null; view.peaksKey = null; refreshPeaksError(); loadPeaks(); },
      }),
    );
  }

  function paintWave() {
    const width = viewportWidth();
    const height = Math.max(40, canvas.clientHeight || 96);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${width}px`;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const channels = view.peaks?.channels?.length ? view.peaks.channels : null;
    const total = stripWidth();
    const offsetX = viewport.scrollLeft;
    const length = clockLength();
    const playedX = length ? (playedSeconds() / length) * total - offsetX : -1;

    if (!channels) {
      // No envelope yet: a flat rail still shows position and keeps the control
      // usable while the summary is being computed.
      context.fillStyle = waveLift(6);
      context.fillRect(0, height / 2 - 3, width, 6);
      context.fillStyle = toneFor('caller').ink;
      context.fillRect(0, height / 2 - 3, Math.max(0, playedX), 6);
      return;
    }

    const lanes = channels.length;
    const laneHeight = (height - WAVE_LANE_GAP * (lanes - 1)) / lanes;
    const buckets = view.peaks.buckets || 1;
    const scale = view.peaks.scale || 1000;

    for (let lane = 0; lane < lanes; lane += 1) {
      const tone = toneFor(channels[lane].name);
      const peaks = channels[lane].peaks || [];
      const gain = channels[lane].gain || 1;
      const top = lane * (laneHeight + WAVE_LANE_GAP);
      const centre = top + laneHeight / 2;
      const reach = laneHeight / 2 - 1;

      context.fillStyle = waveLift(7);
      context.fillRect(0, centre - 0.5, width, 1);

      for (let x = 0; x < width; x += WAVE_PITCH) {
        const from = Math.floor(((offsetX + x) / total) * buckets);
        const to = Math.max(from + 1, Math.ceil(((offsetX + x + WAVE_PITCH) / total) * buckets));
        let loudest = 0;
        for (let index = Math.max(0, from); index < Math.min(buckets, to); index += 1) {
          if (peaks[index] > loudest) loudest = peaks[index];
        }
        const amplitude = Math.max(1, Math.min(reach, (loudest * gain / scale) * reach));
        context.fillStyle = x + WAVE_PITCH <= playedX ? tone.ink : tone.dim;
        context.fillRect(x, centre - amplitude, WAVE_PITCH - 1, amplitude * 2);
      }
    }

    // Naming the lanes on the lanes themselves, rather than in a legend under
    // the card, keeps "who is this" answerable without moving your eyes.
    context.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'top';
    for (let lane = 0; lane < lanes; lane += 1) {
      const tone = toneFor(channels[lane].name);
      context.fillStyle = tone.ink;
      context.globalAlpha = 0.45;
      context.fillText(tone.label.toUpperCase(), 7, lane * (laneHeight + WAVE_LANE_GAP) + 5);
      context.globalAlpha = 1;
    }

    // Loaded ranges, so a reviewer scrubbing a long call can tell the difference
    // between silence and audio the browser has not fetched yet.
    if (length) {
      context.fillStyle = waveLift(12);
      for (let index = 0; index < audio.buffered.length; index += 1) {
        const from = (audio.buffered.start(index) / length) * total - offsetX;
        const to = (audio.buffered.end(index) / length) * total - offsetX;
        context.fillRect(from, height - 2, Math.max(1, to - from), 2);
      }
    }
  }

  async function loadOverview() {
    const requested = state.audioTrack;
    const key = `${requested}:overview`;
    if (peakCache.has(key)) { view.overview = peakCache.get(key); paintMini(); return; }
    try {
      const summary = await api(`/v1/sessions/${encodeURIComponent(session.id)}/audio/${encodeURIComponent(requested)}/peaks?buckets=360`);
      if (state.audio !== audio || state.audioTrack !== requested) return;
      for (const channel of summary.channels || []) {
        const loudest = Math.max(0, ...(channel.peaks || [0]));
        channel.gain = loudest > 0 ? Math.min(6, (summary.scale || 1000) / loudest) : 1;
      }
      peakCache.set(key, summary);
      view.overview = summary;
      paintMini();
    } catch { /* the overview is an aid, never a requirement */ }
  }

  function paintMini() {
    miniWrap.hidden = view.zoom === 1;
    if (miniWrap.hidden) return;
    const width = Math.max(1, miniStrip.clientWidth);
    const height = Math.max(18, mini.clientHeight || 30);
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    mini.style.width = `${width}px`;
    mini.width = Math.round(width * ratio);
    mini.height = Math.round(height * ratio);
    const context = mini.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const channels = view.overview?.channels || [];
    const scale = view.overview?.scale || 1000;
    for (const channel of channels) {
      const tone = toneFor(channel.name);
      const peaks = channel.peaks || [];
      const gain = channel.gain || 1;
      context.fillStyle = tone.dim;
      for (let x = 0; x < width; x += 2) {
        const index = Math.min(peaks.length - 1, Math.floor((x / width) * peaks.length));
        const amplitude = Math.max(0.5, Math.min(height / 2, (peaks[index] * gain / scale) * (height / 2)));
        context.fillRect(x, height / 2 - amplitude, 1.5, amplitude * 2);
      }
    }
    const total = stripWidth();
    miniWindow.style.left = `${(viewport.scrollLeft / total) * 100}%`;
    miniWindow.style.width = `${Math.min(100, (viewportWidth() / total) * 100)}%`;
  }

  const scrubMini = (clientX) => {
    const box = miniStrip.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width)));
    viewport.scrollLeft = Math.max(0, Math.min(stripWidth() - viewportWidth(), fraction * stripWidth() - viewportWidth() / 2));
    paintMini();
  };
  bind('pointerdown', (event) => {
    if (event.button !== 0) return;
    miniDragging = true;
    try { miniStrip.setPointerCapture(event.pointerId); } catch { /* no live pointer */ }
    scrubMini(event.clientX);
    event.preventDefault();
  }, miniStrip);
  bind('pointermove', (event) => { if (miniDragging) scrubMini(event.clientX); }, miniStrip);
  bind('pointerup', () => { miniDragging = false; }, miniStrip);
  bind('pointercancel', () => { miniDragging = false; }, miniStrip);

  function paintRuler() {
    clear(ruler);
    const total = stripWidth();
    const seconds = clockLength();
    if (!seconds) return;
    const step = tickStep(seconds / (total / 90));
    for (let at = 0; at <= seconds + 0.001; at += step) {
      const fraction = at / seconds;
      if (fraction > 1) break;
      ruler.append(h('span', { class: 'wave-tick', style: { left: `${fraction * 100}%` }, text: clockShort(at) }));
    }
    paintTurnMarks();
    paintGaps();
    paintLanes();
  }

  /** Round tick spacing to something a person reads as a clock. */
  function tickStep(rough) {
    const options = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return options.find((option) => option >= rough) || 900;
  }

  /** The dead air between the caller finishing and the agent's first frame,
   *  and which stage of the pipeline ate it.
   *
   *  "Time to first audio: 8.71s" names the symptom; a reviewer still has to
   *  open the waterfall to learn whether the model, the voice or the endpointer
   *  was responsible. Attributing it here is what makes the silence on the
   *  waveform readable rather than merely visible. */
  function responseGap(turn) {
    const ops = turn.operations || [];
    const stt = ops.find((op) => op.type === 'stt');
    const tts = ops.find((op) => op.type === 'tts' && op.milestones?.audio_chunk);
    // The last spoken word, not the moment the endpointer noticed — the same
    // clock `time_to_first_audio_ms` uses. Anchoring on `speech_ended` instead
    // would hide the endpointer's own silence window, which is exactly one of
    // the stages this rail exists to attribute, and would draw a band that
    // disagreed with every other latency number on the page.
    const from = stt?.presentation_window?.to_ms ?? sttMilestone(stt, 'speech_ended') ?? stt?.ended_at_ms;
    const to = tts?.milestones?.audio_chunk?.occurred_at_ms;
    if (from == null || to == null || to <= from) return null;
    const finalAt = Math.min(to, sttMilestone(stt, 'final_transcript') ?? sttMilestone(stt, 'speech_final') ?? from);
    // The moment synthesis was asked for splits the silence in two: nothing
    // before it is voice, and nothing after it is thinking. Clipping every span
    // at that boundary rather than at the first audio frame is what keeps the
    // "say a filler and keep thinking" pattern — whose second model call opens
    // on the *same millisecond* as the TTS request — from being charged to the
    // model and driving voice synthesis to a flat zero.
    const spoke = Math.min(to, Math.max(from, tts.started_at_ms ?? to));
    // Agents routinely run two or three model calls at once, and one nested
    // inside another is common. Adding their durations charges the same wall
    // clock twice: a turn whose two overlapping spans covered 2.5s of real time
    // was being billed 4.6s of "the model", which both overshot the gap and
    // named the wrong culprit. Only the union of the clipped spans is time the
    // caller actually spent waiting on that stage.
    const union = (list) => {
      const spans = list
        // A span with no end did not take zero time — it is one that crashed or
        // hung, which makes it the single most likely cause of the silence being
        // measured. Left as `?? 0` it would be filtered out and the rail would
        // blame the wait on nothing at all, so an open span is treated as still
        // running when synthesis was finally asked for.
        .map((op) => [Math.max(op.started_at_ms ?? 0, from), Math.min(op.ended_at_ms ?? spoke, spoke)])
        .filter(([start, end]) => end > start)
        .sort((a, b) => a[0] - b[0]);
      let total = 0;
      let openFrom = 0;
      let openTo = -Infinity;
      for (const [start, end] of spans) {
        if (start > openTo) { total += Math.max(0, openTo - openFrom); openFrom = start; openTo = end; }
        else if (end > openTo) openTo = end;
      }
      return total + Math.max(0, openTo - openFrom);
    };
    const thinking = ops.filter((op) => op.type === 'llm');
    const tools = ops.filter((op) => op.type === 'tool');
    const stages = [
      { label: 'endpointing', ms: Math.max(0, finalAt - from) },
      { label: 'tool calls', ms: union(tools) },
      { label: 'the model', ms: union(thinking) },
      { label: 'voice synthesis', ms: Math.max(0, to - spoke) },
    ].filter((stage) => stage.ms > 0).sort((a, b) => b.ms - a.ms);
    const total = to - from;
    return { from, to, ms: total, cause: stages[0] || null, stages };
  }

  /** Every gap in the call, computed once per render rather than per repaint. */
  function gapIndex() {
    if (view.gaps) return view.gaps;
    view.gaps = (state.session?.turns || [])
      .map((turn) => ({ turn, gap: responseGap(turn) }))
      .filter((entry) => entry.gap);
    return view.gaps;
  }

  function paintGaps() {
    // The hovered node is about to be removed, and `mouseleave` never fires on
    // an element that is no longer in the tree.
    hideTooltip();
    clear(gaps);
    const seconds = clockLength();
    if (!seconds || !view.aligned) return;
    const ranked = [...gapIndex()].sort((a, b) => b.gap.ms - a.gap.ms).slice(0, 3).map((entry) => entry.gap);
    for (const { turn, gap } of gapIndex()) {
      // Sub-second gaps are the system working; drawing them would turn the
      // waveform into stripes and bury the ones that hurt.
      if (gap.ms < 700) continue;
      const left = (gap.from / 1000 / seconds) * 100;
      const width = (gap.ms / 1000 / seconds) * 100;
      if (left > 100 || width <= 0) continue;
      // A centred label near either end would be cut off by the viewport, and
      // the last turn of a call is exactly the one people scroll to.
      const centre = left + Math.min(100 - left, width) / 2;
      const margin = (56 / stripWidth()) * 100;
      // Colour is absolute — the same 3s means "danger" here, in the KPI and in
      // the turns table — but on a call where every reply took four seconds an
      // absolute scale saturates and the rail says only "all of them". Rank
      // within this call is the second, relative encoding: it survives a corpus
      // where everything is red and answers "which ones here were worst".
      const place = ranked.indexOf(gap);
      const band = h('div', {
        class: 'wave-gap',
        dataset: {
          tone: latencyTone(turn.time_to_first_audio_ms) || 'warn',
          rank: place >= 0 ? 'worst' : null,
          edge: centre > 100 - margin ? 'end' : centre < margin ? 'start' : null,
        },
        style: { left: `${left}%`, width: `${Math.min(100 - left, width)}%` },
      }, h('span', { class: 'wave-gap-label', text: `${duration(gap.ms)}${gap.cause ? ` · ${gap.cause.label}` : ''}` }));
      band.addEventListener('mouseenter', () => showTooltip(band, `${duration(gap.ms)} of silence`, [
        `turn #${turnName(turn.turn_id)}, from ${offset(gap.from)}`,
        place >= 0 ? `the ${['longest', '2nd longest', '3rd longest'][place]} silence in this call` : null,
        'the caller had stopped talking and nothing was coming back',
        ...gap.stages.map((stage) => `${stage.label}: ${duration(stage.ms)}`),
        gap.stages.reduce((sum, stage) => sum + stage.ms, 0) > gap.ms * 1.05
          ? 'stages overlap, so they total more than the gap'
          : null,
      ].filter(Boolean)));
      band.addEventListener('mouseleave', hideTooltip);
      gaps.append(band);
    }
  }

  /** The one sentence a screen-reader user needs before they start scrubbing:
   *  how long the call is, how many turns it has, and where the worst wait was.
   *  Sighted reviewers read this off the gap rail in a glance. */
  function refreshSummary() {
    const seconds = clockLength();
    const turns = state.session?.turns || [];
    const parts = [seconds ? `Call waveform, ${clockShort(seconds)} long` : 'Call waveform'];
    if (view.aligned && turns.length) {
      parts.push(`${turns.length} turn${turns.length === 1 ? '' : 's'}`);
      const worst = gapIndex().slice().sort((a, b) => b.gap.ms - a.gap.ms)[0];
      if (worst) {
        parts.push(`longest silence ${duration(worst.gap.ms)} before turn ${turnName(worst.turn.turn_id)} at ${clockShort(worst.gap.from / 1000)}`
          + (worst.gap.cause ? `, mostly ${worst.gap.cause.label}` : ''));
      }
    }
    parts.push(view.zoom === 1 ? 'showing the whole call' : `zoomed ${view.zoom} times`);
    waveSummary.textContent = `${parts.join('. ')}.`;
  }

  /* --------------------------------------------------------- span lanes */

  /** The provider spans, drawn on the waveform's own axis so a bar and the
   *  silence it explains occupy the same pixels. Only rows that actually
   *  carry work are kept: an empty "TOOL" rail in a card pinned to the top of
   *  the page costs height to say nothing. */
  function paintLanes() {
    hideTooltip();
    clear(lanes);
    const seconds = clockLength();
    const on = prefs.lanes && view.aligned && seconds > 0;
    card.dataset.lanes = String(on);
    lanesButton.setAttribute('aria-pressed', String(prefs.lanes));
    // Drawn on the recording's clock, not the call's. They agree to within the
    // alignment tolerance, and using one number for both keeps a bar from
    // sliding away from the envelope it belongs to.
    const total = seconds * 1000;
    // Sockets are deliberately not lanes here. They are connection-scope, not
    // turn work: one is held open for the whole call and says nothing about
    // where the time went, and the other is a 4px stub with no recorded
    // duration. Two rows of that in a card pinned to the top of the page cost
    // more than they explain, and both are still listed with their timings
    // under All spans and drawn in full on a call with no audio.
    const rows = on ? spanRows(session).rows.filter((row) => row.ops.length && TYPES.includes(row.key)) : [];
    // 11px row + 2px gap, plus the strip's 2px top padding.
    card.style.setProperty('--lanes-h', rows.length ? `${rows.length * 13 + 4}px` : '0px');
    if (!rows.length) return;
    for (const row of rows) {
      const track = h('div', { class: 'lane-track' });
      for (const op of row.ops) track.append(timelineBar(op, total, row.color));
      wireBarKeys(track);
      lanes.append(h('div', { class: 'lane-row' },
        // Sticky so the name survives a scroll at 16×, where the left edge of
        // the strip is minutes off screen.
        h('span', { class: 'lane-label', title: row.hint || row.label, text: row.short }),
        track,
      ));
    }
  }

  function setLanes(on) {
    prefs.lanes = on;
    savePrefs();
    paintLanes();
    // The strip got taller or shorter, so everything measured against its
    // height has to be told.
    paintWave();
  }

  function paintTurnMarks() {
    hideTooltip();
    clear(marks);
    const seconds = clockLength();
    if (!seconds || !view.aligned) return;
    const turns = state.session?.turns || [];
    const width = stripWidth();
    // Labelling every turn buries the answer in its own evidence: a long call
    // becomes a solid band of chips. The slowest few are named, everything else
    // is a tick that keeps its colour, its tooltip and its click.
    const worst = new Set(turns.filter((turn) => turn.time_to_first_audio_ms != null)
      .sort((a, b) => b.time_to_first_audio_ms - a.time_to_first_audio_ms)
      .slice(0, 4).map((turn) => turn.turn_id));
    let lastLabel = -Infinity;
    let lastTick = -Infinity;
    for (const turn of turns) {
      const at = (turn.started_at_ms || 0) / 1000;
      if (at > seconds) continue;
      const x = (at / seconds) * width;
      const reply = turn.time_to_first_audio_ms;
      const tone = latencyTone(reply) || 'none';
      // A hundred turns in half an hour puts several marks on the same pixel.
      // Healthy turns are the ones worth dropping: the strip is there to show
      // where the trouble is, and zooming in brings the rest back.
      if (x - lastTick < 4 && tone !== 'danger' && tone !== 'warn' && String(turn.turn_id) !== String(state.selection?.id)) continue;
      lastTick = x;
      // Room is checked even for a named turn, so two slow turns half a second
      // apart cannot print over each other.
      const labelled = (worst.has(turn.turn_id) || view.zoom >= 4) && x - lastLabel > 46;
      if (labelled) lastLabel = x;
      const spoken = callerLine(turn.turn_id);
      const mark = h('button', {
        type: 'button',
        class: labelled ? 'wave-turn' : 'wave-turn is-tick',
        // A centred mark at either end would hang outside the strip and clip.
        style: { left: `${(x / width) * 100}%`, transform: x < 24 ? 'translateX(0)' : x > width - 24 ? 'translateX(-100%)' : null },
        dataset: { tone, turn: String(turn.turn_id) },
        'aria-label': `Turn ${turnName(turn.turn_id)} at ${offset(turn.started_at_ms)}${reply != null ? `, first audio back after ${duration(reply)}` : ''}`,
        text: labelled ? `#${turnName(turn.turn_id)}${reply != null ? ` ${duration(reply)}` : ''}` : '',
        onClick: (event) => {
          event.stopPropagation();
          seekTo(at);
          setSelection('turn', turn.turn_id, { scroll: false });
        },
      });
      const describe = () => showTooltip(mark, `Turn #${turnName(turn.turn_id)}`, [
        `starts ${offset(turn.started_at_ms)}`,
        reply != null ? `first audio back ${duration(reply)}${tone === 'danger' ? ' — audible lag' : tone === 'warn' ? ' — borderline' : ''}` : 'no first-audio mark',
        turn.user_speech_ms != null ? `caller spoke ${duration(turn.user_speech_ms)}` : null,
        turn.reply_skipped
          ? (turn.reply_skipped === 'callback_error'
            ? 'no reply — the agent\'s turn callback failed'
            : 'reply skipped by the agent')
          : null,
        spoken ? `“${spoken}”` : null,
        'click to seek and inspect',
      ].filter(Boolean));
      mark.addEventListener('mouseenter', describe);
      mark.addEventListener('focus', describe);
      mark.addEventListener('mouseleave', hideTooltip);
      mark.addEventListener('blur', hideTooltip);
      marks.append(mark);
    }
  }

  /** What the caller said in a turn, for the marker tooltip and the live chip. */
  function callerLine(turnId) {
    return transcriptLine('user', turnId, 90);
  }

  /** The turn a point on the recording belongs to, for the hover read-out. */
  function lastTurnBefore(seconds) {
    return lastTurnBeforeMs(seconds * 1000);
  }

  function turnAt(seconds) {
    return view.aligned ? turnAtMs(seconds * 1000) : null;
  }

  /* ------------------------------------------------------------ pointing */

  // The folded transport bar's own scrubber. Pointer capture rather than a
  // window listener so a drag that leaves the 6px rail — which every drag does
  // — keeps seeking instead of stopping dead at the edge.
  let railDragging = false;
  const railSeek = (event) => {
    const box = miniRail.getBoundingClientRect();
    seekTo(((event.clientX - box.left) / Math.max(1, box.width)) * clockLength());
  };
  bind('pointerdown', (event) => {
    if (event.button !== 0 || !clockLength()) return;
    railDragging = true;
    // A pointer that is already gone — a synthetic event, or a button released
    // outside the window — cannot be captured, and the throw would abandon the
    // seek the reviewer actually asked for.
    try { miniRail.setPointerCapture(event.pointerId); } catch { /* no live pointer */ }
    miniRail.classList.add('is-scrubbing');
    railSeek(event);
    event.preventDefault();
  }, miniRail);
  bind('pointermove', (event) => { if (railDragging) railSeek(event); }, miniRail);
  for (const type of ['pointerup', 'pointercancel']) {
    bind(type, (event) => {
      if (!railDragging) return;
      railDragging = false;
      miniRail.classList.remove('is-scrubbing');
      try { miniRail.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    }, miniRail);
  }

  let dragging = null;
  let miniDragging = false;

  bind('pointerdown', (event) => {
    if (event.button !== 0 || !clockLength()) return;
    // Whatever they did with it, they have found the waveform.
    if (!coach.hidden) dismissCoach();
    if (event.target.closest('.wave-turn')) return;
    // A span in the lane is a target in its own right: it is clicked to inspect
    // and audition the operation. Letting the press also start a scrub would
    // seek the recording out from under the click.
    if (event.target.closest('.timeline-bar')) return;
    // A grip on the loop band moves that edge instead of starting a new scrub,
    // so a range can be nudged after it has been drawn.
    const grip = event.target.closest('.loop-grip');
    if (grip && view.selection) {
      dragging = { mode: 'grip', edge: grip.dataset.edge };
      try { viewport.setPointerCapture(event.pointerId); } catch { /* no live pointer */ }
      event.preventDefault();
      return;
    }
    // Capture keeps a scrub alive when the pointer leaves the waveform, but a
    // synthetic or already-released pointer has nothing to capture.
    try { viewport.setPointerCapture(event.pointerId); } catch { /* no live pointer */ }
    const at = timeAt(event.clientX);
    if (event.shiftKey) {
      dragging = { mode: 'select', anchor: at };
      setSelectionRange({ from: at, to: at });
    } else {
      dragging = { mode: 'seek' };
      seekTo(at);
    }
    // Dragging the playhead should feel like holding it, not like repeatedly
    // clicking somewhere new.
    shell.classList.toggle('is-scrubbing', dragging.mode !== 'grip');
    event.preventDefault();
  }, viewport);

  bind('pointermove', (event) => {
    if (!clockLength()) return;
    const at = timeAt(event.clientX);
    if (dragging?.mode === 'select') {
      setSelectionRange({ from: Math.min(dragging.anchor, at), to: Math.max(dragging.anchor, at) });
    } else if (dragging?.mode === 'grip') {
      const edge = dragging.edge === 'from'
        ? { from: Math.min(at, view.selection.to - 0.1), to: view.selection.to }
        : { from: view.selection.from, to: Math.max(at, view.selection.from + 0.1) };
      setSelectionRange({ ...edge, label: view.selection.label });
    } else if (dragging?.mode === 'seek') {
      seekTo(at);
    }
    showHover(event.clientX, at);
  }, viewport);

  const endDrag = (event) => {
    if (!dragging) return;
    // A shift-drag that never moved is a mis-click, not a zero-length loop.
    if (dragging.mode === 'select' && view.selection && view.selection.to - view.selection.from < 0.15) setSelectionRange(null);
    dragging = null;
    shell.classList.remove('is-scrubbing');
    try {
      if (event?.pointerId != null && viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    } catch { /* the pointer is already gone */ }
  };
  bind('pointerup', endDrag, viewport);
  bind('pointercancel', endDrag, viewport);
  bind('pointerleave', () => { hideHover(); }, viewport);

  bind('dblclick', (event) => {
    // A span in the lane has already answered the double-click with its own
    // click: it auditions exactly that operation. Looping the whole turn on top
    // of it would immediately override the narrower thing they asked for.
    if (event.target.closest('.timeline-bar')) return;
    const at = timeAt(event.clientX);
    const turn = turnAt(at);
    if (!turn) return;
    const from = (turn.started_at_ms || 0) / 1000;
    const to = Math.max(from + 0.3, (turn.ended_at_ms ?? turn.started_at_ms ?? 0) / 1000);
    setSelectionRange({ from, to, label: `turn #${turnName(turn.turn_id)}` });
    if (!view.loop) { view.loop = true; applyLoop(); }
    seekTo(from);
    if (audio.paused) togglePlay();
  }, viewport);

  bind('scroll', () => { paintWave(); paintMini(); paintReturn(); }, viewport);

  // Trackpad and wheel zoom keeps the point under the cursor fixed, which is
  // what every timeline tool trains a reviewer to expect.
  bind('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(event.deltaY < 0 ? 1 : -1, { around: timeAt(event.clientX) });
  }, viewport);

  function showHover(clientX, at) {
    const box = shell.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    hoverLine.hidden = false;
    hoverLine.style.left = `${((clientX - stripBox.left) / Math.max(1, stripBox.width)) * 100}%`;
    const turn = turnAt(at);
    bubble.hidden = false;
    clear(bubble).append(
      h('b', { class: 'num', text: clockShort(at, true) }),
      turn ? h('span', { text: `turn #${turnName(turn.turn_id)}` }) : null,
    );
    const width = bubble.offsetWidth || 60;
    bubble.style.left = `${Math.max(0, Math.min(box.width - width, clientX - box.left - width / 2))}px`;
  }
  function hideHover() {
    if (dragging) return;
    hoverLine.hidden = true;
    bubble.hidden = true;
  }

  /* ---------------------------------------------------------- selections */

  function setSelectionRange(range) {
    view.selection = range && range.to > range.from ? range : null;
    refreshDownload();
    if (!view.selection) {
      loopBand.hidden = true;
      selectionChip.hidden = true;
      applyLoop();
      return;
    }
    const seconds = clockLength();
    if (!seconds) return;
    loopBand.hidden = false;
    loopBand.style.left = `${(view.selection.from / seconds) * 100}%`;
    loopBand.style.width = `${Math.max(0.2, ((view.selection.to - view.selection.from) / seconds) * 100)}%`;
    loopTag.textContent = view.selection.label || `${duration((view.selection.to - view.selection.from) * 1000)} selected`;
    selectionChip.hidden = false;
    clear(selectionChip).append(
      h('span', { class: 'num', text: `${clockShort(view.selection.from)}–${clockShort(view.selection.to)}` }),
      h('span', { class: 'chip-x', text: '×' }),
    );
    selectionChip.title = `Clear the ${view.selection.label || 'loop'} selection`;
    applyLoop();
  }
  ui.setAudioSelection = setSelectionRange;

  function applyLoop() {
    loopButton.setAttribute('aria-pressed', String(view.loop));
    loopButton.dataset.on = String(view.loop);
    loopBand.dataset.on = String(view.loop);
    // A whole-track loop is the media element's own job; a range loop has to be
    // policed on the clock because `loop` only wraps at the end of the file.
    audio.loop = view.loop && !view.selection;
    // Turning a range loop on under reduced motion has to restart the frame
    // loop that `animate` would otherwise have declined to schedule.
    if (view.loop && view.selection && !audio.paused && !raf) raf = requestAnimationFrame(animate);
  }

  /** Highlights the slice of the recording a trace span answers for. */
  function markSpan(window) {
    view.span = window;
    const seconds = clockLength();
    if (!window || !seconds) { spanBand.hidden = true; return; }
    spanBand.hidden = false;
    spanBand.style.left = `${Math.max(0, Math.min(100, (window.from / 1000 / seconds) * 100))}%`;
    spanBand.style.width = `${Math.max(0.2, Math.min(100, ((window.to - window.from) / 1000 / seconds) * 100))}%`;
    spanBand.dataset.channel = window.channel || 'call';
  }
  ui.markAudioSpan = markSpan;

  /* --------------------------------------------------------------- zoom */

  function setZoom(step, { absolute = null, around = null } = {}) {
    const index = ZOOMS.indexOf(view.zoom);
    const next = absolute != null ? absolute : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, index + step))];
    if (next === view.zoom) return;
    const anchor = around != null ? around : audio.currentTime || 0;
    view.zoom = next;
    strip.style.width = `${next * 100}%`;
    // "1×" invites the question "one times what?"; the resting state is a fit.
    zoomLabel.textContent = next === 1 ? 'fit' : `${next}×`;
    zoomOut.disabled = next === ZOOMS[0];
    zoomIn.disabled = next === ZOOMS[ZOOMS.length - 1];
    viewport.classList.toggle('is-zoomed', next > 1);
    // The canvas is torn down and redrawn at a new scale in a single frame,
    // which reads as a blink. A short dip in opacity turns that into a change
    // the eye can follow, and the class is dropped by the next paint anyway.
    shell.classList.add('is-rescaling');
    clearTimeout(view.rescaleTimer);
    view.rescaleTimer = setTimeout(() => shell.classList.remove('is-rescaling'), 200);
    requestAnimationFrame(() => {
      centreOn(anchor);
      paintRuler();
      paintWave();
      paintMini();
      paintReturn();
      refreshSummary();
      loadPeaks();
    });
  }

  function centreOn(seconds) {
    const length = clockLength();
    if (!length || view.zoom === 1) { viewport.scrollLeft = 0; return; }
    const target = (seconds / length) * stripWidth() - viewportWidth() / 2;
    // Deliberately instant. A smooth scroll here would stack a slide on top of
    // the zoom's opacity dip, and at high zoom it would travel through minutes
    // of a call the reviewer never asked to see. The dip is the transition.
    viewport.scrollLeft = Math.max(0, Math.min(stripWidth() - viewportWidth(), target));
  }

  /** Says which way the playhead went once it is off the visible window, so a
   *  panned view can never quietly describe a different part of the call than
   *  the clock does. */
  function paintReturn() {
    const length = clockLength();
    const off = !length || view.zoom === 1;
    const x = off ? 0 : (playedSeconds() / length) * stripWidth() - viewport.scrollLeft;
    const left = off ? true : x >= 0;
    const right = off ? true : x <= viewportWidth();
    // Only write when the answer changes. This runs on every animation frame
    // during playback, and a write between two layout reads costs a reflow.
    if (backLeft.hidden !== left) backLeft.hidden = left;
    if (backRight.hidden !== right) backRight.hidden = right;
  }

  /** Keeps a zoomed view following playback without fighting a reviewer who has
   *  just scrolled somewhere else. */
  function followPlayhead() {
    const length = clockLength();
    if (view.zoom === 1 || !length || dragging) return;
    // A viewport that slides itself under the cursor is exactly the motion the
    // reduced-motion preference is about; the playhead still moves, the frame
    // around it just stops chasing.
    if (wantsCalm()) return;
    const x = (playedSeconds() / length) * stripWidth() - viewport.scrollLeft;
    const width = viewportWidth();
    if (x < width * 0.12 || x > width * 0.88) centreOn(audio.currentTime);
  }

  /* ------------------------------------------------------------ painting */

  let raf = null;
  function paintPlayer() {
    if (state.audio !== audio) return;
    const seconds = clockLength();
    const at = playedSeconds();
    const fraction = seconds ? at / seconds : 0;
    playhead.hidden = !seconds;
    playhead.style.left = `${Math.max(0, Math.min(100, fraction * 100))}%`;
    viewport.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    // Screen readers read this character by character, so millisecond precision
    // becomes "zero colon zero zero point zero zero zero" on every seek.
    viewport.setAttribute('aria-valuetext', `${clockShort(at)} of ${clockShort(seconds)}`);
    current.textContent = clockShort(at, true);
    total.textContent = seconds ? clockShort(seconds) : '--:--';
    railFill.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
    // A span play button drives this same element for its own window. Wrapping
    // it back into the waveform's loop would strand the span at zero and play
    // the wrong audio, so the loop yields while a span is on.
    if (view.loop && view.selection && !segment.playing && at >= view.selection.to - 0.02) {
      audio.currentTime = view.selection.from;
    }
    paintNow(at);
    // The panel beside the player answers "what is running right now", so it
    // moves on the same clock the playhead does.
    ui.liveTrace?.at(at, view.aligned);
    followPlayhead();
    paintWave();
    paintReturn();
  }

  /** The turn the playhead is inside, published to the chip and to every row on
   *  the page that belongs to it. Listening and reading then stay in step
   *  without the player hijacking the reviewer's own selection. */
  function paintNow(at) {
    // Between turns there is no turn, but there is still a most recent one —
    // and a chip that blinks out during every silence is worse than one that
    // keeps naming what you just heard.
    const turn = view.aligned ? (turnAt(at) || lastTurnBefore(at)) : null;
    if (turn === view.liveTurn) return;
    view.liveTurn = turn;
    for (const node of document.querySelectorAll('[data-turn-id].is-live')) node.classList.remove('is-live');
    if (!turn) { nowChip.hidden = true; return; }
    for (const node of document.querySelectorAll(`[data-turn-id="${CSS.escape(String(turn.turn_id))}"]`)) node.classList.add('is-live');
    ui.liveTurnId = turn.turn_id;
    // Only while the recording is running. Scrolling the panel under a reviewer
    // who is scrubbing by hand fights the thing they are already doing.
    if (!audio.paused) scrollTranscriptTo(turn.turn_id);
    const reply = turn.time_to_first_audio_ms;
    const tone = latencyTone(reply);
    const spoken = callerLine(turn.turn_id);
    const gap = gapIndex().find((entry) => entry.turn === turn)?.gap;
    // Only while the audio is actually running: announcing a turn the reviewer
    // moved to themselves repeats what they just did.
    if (!audio.paused) {
      waveLive.textContent = [
        `Turn ${turnName(turn.turn_id)}`,
        reply != null ? `replied in ${duration(reply)}` : null,
        tone === 'danger' ? 'audible lag' : tone === 'warn' ? 'slow' : null,
        spoken ? `caller said ${spoken}` : null,
      ].filter(Boolean).join(', ');
    }
    nowChip.hidden = false;
    nowChip.dataset.tone = tone || 'none';
    nowChip.title = `Inspect turn #${turnName(turn.turn_id)}`;
    // `append` stringifies whatever it is handed, so an absent measurement
    // would print the word "null" into the control bar.
    clear(nowChip).append(...[
      h('span', { class: 'now-turn', text: `Turn #${turnName(turn.turn_id)}` }),
      reply != null ? h('span', { class: 'now-latency num', text: duration(reply) }) : null,
      // Naming the stage that dominated the wait turns the chip from a label
      // into the beginning of an answer.
      // Stages overlap (three model calls inside one turn), so their durations
      // do not add up to the gap. Naming the dominant one without a number is
      // the claim the data actually supports; the exact split is a hover away.
      tone && gap?.cause ? h('span', {
        class: 'now-cause',
        text: `${tone === 'danger' ? 'audible lag' : 'slow'} · mostly ${gap.cause.label}`,
        title: `Stages can overlap, so this names the largest one rather than a share: ${gap.stages.map((stage) => `${stage.label} ${duration(stage.ms)}`).join(', ')}.`,
      }) : null,
      spoken ? h('span', { class: 'now-said', text: `“${spoken}”` }) : null,
    ].filter(Boolean));
  }

  const animate = () => {
    paintPlayer();
    // Sixty repaints a second is a sweeping playhead. Asked for calm, the
    // player leans on `timeupdate` (roughly four a second) instead, so the
    // playhead steps rather than glides and the canvas stops redrawing. A live
    // loop still needs the frames: `timeupdate` is too coarse to catch the end
    // of a range, and a loop that overshoots by a quarter second is broken, not
    // calm.
    if (wantsCalm() && !(view.loop && view.selection)) { raf = null; return; }
    if (!audio.paused && !audio.ended) raf = requestAnimationFrame(animate);
  };

  bind('timeupdate', paintPlayer);
  bind('progress', paintWave);
  bind('play', () => {
    playIcon.firstChild.setAttribute('d', PATH.pause);
    playButton.setAttribute('aria-label', 'Pause');
    card.dataset.playing = 'true';
    // `paintNow` only acts when the live turn changes, and seeking while paused
    // has usually already set it. Without this, pressing play on a turn the
    // reviewer just scrubbed to leaves the transcript wherever it was.
    scrollTranscriptTo(ui.liveTurnId);
    if (!raf) raf = requestAnimationFrame(animate);
  });
  bind('pause', () => {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    card.dataset.playing = 'false';
    paintPlayer();
    playIcon.firstChild.setAttribute('d', PATH.play);
    playButton.setAttribute('aria-label', 'Play');
    // A live region keeps its last message. Left there, a screen reader can
    // re-announce a turn the playhead has long since left.
    waveLive.textContent = '';
  });
  bind('ended', () => {
    playIcon.firstChild.setAttribute('d', PATH.play);
    card.dataset.playing = 'false';
    waveLive.textContent = '';
  });

  bind('loadedmetadata', () => {
    // A queued event from a track the reviewer has already switched away from
    // must not publish its duration or alignment as the current track's.
    if (state.audio !== audio || !sameSource(audio.currentSrc, expectedSrc)) return;
    total.textContent = clockShort(audio.duration);
    if (pendingSeek != null) {
      audio.currentTime = Math.min(pendingSeek, audio.duration || pendingSeek);
      pendingSeek = null;
    }
    if (pendingResume && pendingResume.token === loadToken) {
      if (pendingResume.at) audio.currentTime = Math.min(pendingResume.at, audio.duration || pendingResume.at);
      if (pendingResume.wasPlaying) audio.play().catch(() => {});
      pendingResume = null;
    }
    refreshClock();
  });

  // Alignment decides whether there is a playhead to follow at all, and with it
  // the turn marks, the live chip and the trace panel beside the player. It was
  // settled only on `loadedmetadata` and at the end of a peaks render, and both
  // of those bail when a queued response belongs to a track the reviewer has
  // already left — leaving a perfectly good recording playing with nothing on
  // the page following it. The length is the only input, so it is re-settled
  // whenever the length changes.
  bind('durationchange', () => {
    if (state.audio !== audio) return;
    refreshClock();
  });

  /** Decides whether the recording and the call share a clock, and redraws
   *  everything that is measured against it.
   *
   *  The envelope carries the preview's length, so this can be settled — and
   *  the ruler and turn marks drawn — before the media element has read enough
   *  of a long recording to report a duration of its own. */
  function refreshClock() {
    // The preview is rendered against the call clock, but legacy packages
    // without chunk timings play back contiguously. Only drive the timeline
    // playhead, the turn marks and the hover read-out when the two clocks agree.
    const callMs = session.manifest?.duration_ms || 0;
    const audioMs = durationMs() || view.peaks?.duration_ms || 0;
    // Running past the end of the call does not break alignment — the agent's
    // last utterance often drains after the call is closed. Compaction, which
    // shows up as a recording shorter than the call, is what does.
    view.aligned = callMs > 0 && audioMs > 0 && callMs - audioMs <= Math.max(2000, callMs * 0.12);
    ui.playheadAligned = view.aligned;
    if (audioMs && !view.aligned) {
      drift.hidden = false;
      drift.textContent = `This track is ${duration(audioMs)} long against a ${duration(callMs)} call, so it has no chunk timings to align with the call clock.`;
    } else {
      drift.hidden = true;
    }
    // The agent's last utterance often drains after the call is closed, so the
    // recording outlives the call clock. Left unmarked, the ruler quietly
    // contradicts the "6m 39s" printed at the top of the page.
    const tail = view.aligned && callMs > 0 && audioMs > callMs + 1500 ? callMs / 1000 : null;
    tailBand.hidden = !tail;
    if (tail) {
      tailBand.style.left = `${(tail / (audioMs / 1000)) * 100}%`;
      tailBand.style.width = `${Math.max(0, 100 - (tail / (audioMs / 1000)) * 100)}%`;
      tailBand.title = `The call ended at ${offset(callMs)}; the recording runs ${duration(audioMs - callMs)} longer.`;
    }
    paintRuler();
    paintPlayer();
    refreshSummary();
    applyCue();
  }

  /** A link that says "listen from 3:14" is worthless until the clock exists,
   *  so the cue waits for the first measurement and then retires itself. */
  function applyCue() {
    const cue = state.audioCue;
    if (!cue || !clockLength()) return;
    state.audioCue = null;
    if (cue.range) setSelectionRange({ ...cue.range });
    seekTo(cue.at);
  }

  ui.applyAudioCue = applyCue;

  bind('error', () => {
    if (state.audio !== audio || !audio.getAttribute('src')) return;
    if (!sameSource(audio.currentSrc, expectedSrc)) return;
    error.hidden = false;
    error.textContent = `Could not decode the ${state.audioTrack} preview. The observer may not be able to render this encoding.`;
    skeleton.hidden = true;
  });

  /* -------------------------------------------------------------- source */

  let loadToken = 0;
  let expectedSrc = '';
  let pendingResume = null;
  let pendingSeek = null;

  /** Downloading the whole call to attach eight seconds to a bug report is a
   *  tax on everyone who opens the attachment, so the link follows the
   *  selection whenever there is one. */
  function refreshDownload() {
    const id = state.audioTrack;
    const base = `/v1/sessions/${encodeURIComponent(session.id)}/audio/${encodeURIComponent(id)}?preview=wav`;
    const cut = view.selection
      ? `&from_ms=${Math.round(view.selection.from * 1000)}&to_ms=${Math.round(view.selection.to * 1000)}`
      : '';
    download.href = `${base}${cut}`;
    download.setAttribute('download', `${session.id}-${id}${cut ? '-clip' : ''}.wav`);
    download.title = cut ? 'Download the selected range as WAV' : 'Download this track as WAV';
    download.classList.toggle('is-scoped', Boolean(cut));
  }

  function chooseTrack(id, { resumePlayback = true } = {}) {
    const token = ++loadToken;
    state.audioTrack = id;
    const wasPlaying = resumePlayback && !audio.paused;
    const at = audio.currentTime;
    audio.src = `/v1/sessions/${encodeURIComponent(session.id)}/audio/${encodeURIComponent(id)}?preview=wav`;
    expectedSrc = audio.src;
    refreshDownload();
    error.hidden = true;
    for (const button of trackChips.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.track === id));
    }
    view.peaksKey = null;
    view.overview = null;
    view.gaps = null;
    // Blanking the canvas to a flat rail loses the reviewer's place: the shape
    // they were reading is the only landmark on a six-minute recording. The old
    // envelope is held as a dimmed ghost under the skeleton instead — it is
    // labelled as loading, so it claims nothing about the new track, and both
    // tracks are the same call so the landmarks still line up.
    shell.classList.add('is-swapping');
    skeleton.hidden = false;
    paintWave();
    loadPeaks();
    loadOverview();
    // Switching tracks fires a fresh `loadedmetadata`; only the newest request
    // is allowed to restore the previous position and resume playback.
    pendingResume = { token, at, wasPlaying };
  }
  ui.chooseAudioTrack = chooseTrack;

  /* ------------------------------------------------------------ lifecycle */

  const resize = new ResizeObserver(() => { paintWave(); paintRuler(); paintMini(); loadPeaks(); });
  resize.observe(viewport);

  // Canvas keeps whatever it was last painted with, so a theme switch has to
  // repaint or the waveform stays in the previous theme's colours.
  bind('vaani:themechange', () => { paintWave(); paintRuler(); paintMini(); }, window);
  listeners.signal.addEventListener('abort', () => { resize.disconnect(); if (raf) cancelAnimationFrame(raf); });

  // A background tab never runs `requestAnimationFrame`, and neither the
  // canvas nor a zoom applied while hidden would ever be drawn: open a call in
  // a new tab and it sits on "Reading the waveform…" until you look at it.
  // Coming back into view is the moment to catch up.
  bind('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    paintWave();
    paintRuler();
    paintMini();
    loadPeaks();
  }, document);

  bind('keydown', (event) => {
    // The lane spans and the turn marks live inside the viewport and run their
    // own keyboard model: arrows rove between bars, Enter activates one. Without
    // this, every key does both — Right moves focus *and* seeks 5s, and Enter
    // starts whole-call playback instead of auditioning the focused span.
    if (event.target.closest('.timeline-bar, .wave-turn')) return;
    const step = event.shiftKey ? 10 : 5;
    const keys = {
      ArrowRight: () => seekTo(audio.currentTime + step),
      ArrowLeft: () => seekTo(audio.currentTime - step),
      ArrowUp: () => seekTo(audio.currentTime + step),
      ArrowDown: () => seekTo(audio.currentTime - step),
      PageUp: () => seekTo(audio.currentTime + step * 6),
      PageDown: () => seekTo(audio.currentTime - step * 6),
      Home: () => seekTo(0),
      End: () => seekTo(clockLength()),
      Enter: togglePlay,
      ' ': togglePlay,
    };
    const action = keys[event.key];
    if (!action) return;
    action();
    event.preventDefault();
  }, viewport);

  ui.playerKeys = (event) => {
    const key = event.key;
    if (key === 'm') { audio.muted = !audio.muted; savePrefs(); paintVolume(); return true; }
    if (key === 'l') { view.loop = !view.loop; applyLoop(); return true; }
    if (key === 's') { setLanes(!prefs.lanes); return true; }
    if (key === '[' || key === ']') {
      const index = SPEEDS.indexOf(Number(speed.value));
      const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, index + (key === ']' ? 1 : -1)))];
      speed.value = String(next);
      audio.playbackRate = next;
      savePrefs();
      return true;
    }
    if (key === '+' || key === '=') { setZoom(1); return true; }
    if (key === '-' || key === '_') { setZoom(-1); return true; }
    if (key === '0') { setZoom(0, { absolute: 1 }); return true; }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      seekTo(audio.currentTime + (key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 10 : 5));
      return true;
    }
    return false;
  };
  ui.clearAudioSelection = () => {
    if (!view.selection) return false;
    setSelectionRange(null);
    return true;
  };

  zoomOut.disabled = true;
  chooseTrack(tracks[0].id);
  paintWave();
  return card;
}

/** Position on the recording, the way a reviewer reads a player. */
function clockShort(seconds, precise = false) {
  if (!Number.isFinite(seconds)) return precise ? '0:00.000' : '--:--';
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(milliseconds / 60000);
  const rest = milliseconds - minutes * 60000;
  const whole = `${minutes}:${String(Math.floor(rest / 1000)).padStart(2, '0')}`;
  return precise ? `${whole}.${String(rest % 1000).padStart(3, '0')}` : whole;
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
  if (!ui.playheadAligned) { toast('This track has no chunk timings, so it cannot be located on the call clock.'); return; }
  audio.currentTime = Math.max(0, Math.min(audio.duration, callMs / 1000));
}

/* ------------------------------------------------------ segment playback */

// Below this a window is as likely to be silence as speech: measured across the
// corpus, every window of 300ms or more lands on audible speech, while under it
// barely half do — those are utterances cut off by barge-in and first frames
// marked before the recorder had anything to write. Offering to play them just
// plays nothing and makes the control look broken.
const MIN_SEGMENT_MS = 300;

/**
 * The slice of the recording a span is answerable for, and the channel that can
 * corroborate it.
 *
 * Durations and transcripts cannot settle "did the caller really stop talking
 * there" or "is that actually what we played" — only the audio can. So an STT
 * span points at the call recording across the speech or playout it represents.
 */
function audioWindow(op) {
  // A per-turn streaming TTS/STT span is also a WebSocket operation.  Do not
  // reject it merely because of its transport: that hid playback for every
  // live streamed TTS response.  Connection-lifetime spans are different,
  // they have no answerable audio window and must stay excluded.
  if (!op || (op.type !== 'stt' && op.type !== 'tts') || op.scope === 'connection') return null;
  const canonical = op.presentation_window;
  if (canonical && typeof canonical.from_ms === 'number' && typeof canonical.to_ms === 'number'
      && canonical.to_ms - canonical.from_ms >= MIN_SEGMENT_MS) {
    const track = segmentTrack(canonical.track);
    if (!track) return null;
    return {
      from: canonical.from_ms, to: canonical.to_ms, track, channel: canonical.track,
      label: canonical.kind === 'playout'
        ? `audible agent audio${canonical.segments?.length > 1 ? ` (${canonical.segments.length} playout ranges)` : ''}`
        : 'caller speech',
      isolated: track === canonical.track, source: canonical.source, confidence: canonical.confidence,
      segments: canonical.segments,
    };
  }
  const marks = op.milestones && typeof op.milestones === 'object' ? op.milestones : {};
  const at = (name, key = 'occurred_at_ms') => (typeof marks[name]?.[key] === 'number' ? marks[name][key] : null);

  let from;
  let to;
  let channel;
  let label;
  if (op.type === 'stt') {
    channel = 'caller';
    label = 'caller audio';
    // The socket opens before anyone speaks, so the span's own start would play
    // silence; fall back to it only when the provider marked no speech. Keep
    // the clip open through finalisation so playback matches the STT span
    // displayed in the trace, including any post-speech processing gap.
    from = at('speech_started') ?? op.started_at_ms;
    to = at('final_transcript') ?? at('speech_final') ?? at('speech_ended') ?? op.ended_at_ms;
  } else {
    channel = 'agent';
    label = 'agent audio';
    // Synthesis starts before the first frame is on the wire; the audible part
    // is the streaming window, not the request.
    from = at('audio_chunk') ?? at('first_byte') ?? op.started_at_ms;
    // `last_at_ms` says when the final chunk was received, not when its PCM
    // finished playing. Rendered duration is the usable fallback for old calls.
    const renderedMs = Number(op.response?.audio_ms);
    to = Number.isFinite(renderedMs) && renderedMs > 0 ? from + renderedMs : op.ended_at_ms;
  }

  if (typeof from !== 'number' || typeof to !== 'number' || to - from < MIN_SEGMENT_MS) return null;
  const track = segmentTrack(channel);
  if (!track) return null;
  return { from, to, track, channel, label, isolated: track === channel };
}

/** The uploaded track that best isolates one speaker. A stereo call is split
 *  server side, so a single recording still answers for both. */
function segmentTrack(channel) {
  const uploaded = (state.session?.recordings || []).filter((track) => track.uploaded);
  if (!uploaded.length) return null;
  // Review uses one call player and one source. Speaker ownership still labels
  // the window, but never swaps in a second virtual channel/player.
  if (uploaded.some((track) => track.track === 'call')) return 'call';
  if (uploaded.length > 1) return 'mixed';
  return uploaded[0].track;
}

// Segment controls are only remote controls for the one visible call player.
const segment = { token: 0, opId: null, playing: false, raf: null, timer: null, disarm: null, nodes: null };

/** Looks the controls up by span id rather than holding them, because the trace
 *  rebuilds its rows on every expand and would leave us pointing at dead nodes. */
function segmentNodes(opId) {
  if (segment.nodes?.opId === opId && segment.nodes.button?.isConnected) return segment.nodes;
  const found = {
    opId,
    button: document.querySelector(`.phase-play[data-op="${CSS.escape(opId)}"]`),
    head: document.querySelector(`.phase-playhead[data-op="${CSS.escape(opId)}"]`),
  };
  segment.nodes = found;
  return found;
}

function paintSegment(opId, fraction) {
  const { button, head } = segmentNodes(opId);
  const playing = fraction != null;
  if (head) {
    head.hidden = !playing;
    if (playing) head.style.left = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }
  if (button) {
    button.dataset.playing = String(playing);
    button.setAttribute('aria-pressed', String(playing));
    button.setAttribute('aria-label', playing ? 'Stop this span' : 'Play this span');
    button.textContent = playing ? '■' : '▶';
  }
}

function stopSegment() {
  const opId = segment.opId;
  segment.token += 1;
  if (segment.raf) cancelAnimationFrame(segment.raf);
  segment.raf = null;
  if (segment.timer) clearTimeout(segment.timer);
  segment.timer = null;
  segment.disarm?.();
  segment.disarm = null;
  state.audio?.pause();
  segment.playing = false;
  segment.opId = null;
  if (opId) paintSegment(opId, null);
  ui.markAudioSpan?.(null);
  segment.nodes = null;
}

/** Drops the previous call's media before the next one's controls are built. */
function releaseSegments() {
  stopSegment();
}

function playSegment(op) {
  const win = audioWindow(op);
  if (!win) return;
  const toggleOff = segment.playing && segment.opId === op.event_id;
  stopSegment();
  if (toggleOff) return;

  const audio = state.audio;
  if (!audio || !ui.chooseAudioTrack) { toast('This call has no audio player.'); return; }
  const token = ++segment.token;
  const opId = op.event_id;
  segment.opId = opId;
  const onError = () => {
    if (segment.token !== token) return;
    toast(`The ${win.track} track could not be decoded, so this span cannot be played.`);
    stopSegment();
  };
  const begin = () => {
    if (segment.token !== token) return;
    const audioMs = (audio.duration || 0) * 1000;
    if (!Number.isFinite(audioMs) || audioMs <= 0) {
      toast('That recording has no readable duration, so this span cannot be located inside it.');
      stopSegment();
      return;
    }
    if (win.from >= audioMs) {
      toast('This span starts after the recording ends.');
      stopSegment();
      return;
    }
    audio.currentTime = Math.max(0, win.from / 1000);
    audio.play().then(() => {
      if (segment.token !== token) { audio.pause(); return; }
      segment.playing = true;
      paintSegment(opId, 0);
      // The waveform shows which slice of the recording is being auditioned, so
      // the reviewer can see the span they clicked against the whole call.
      ui.markAudioSpan?.({ from: win.from, to: win.to, channel: win.channel });
      follow(audio, token, opId, win);
    }).catch((reason) => {
      if (segment.token !== token) return;
      toast(`Could not play that span: ${reason.message}`);
      stopSegment();
    });
  };

  if (state.audioTrack !== win.track) {
    // A segment owns this source change. Do not resume whatever the reviewer
    // happened to be hearing on the old track before its exact seek is ready.
    ui.chooseAudioTrack(win.track, { resumePlayback: false });
    audio.addEventListener('loadedmetadata', begin, { once: true });
    audio.addEventListener('error', onError, { once: true });
    return;
  }
  if (audio.readyState >= 1) { begin(); return; }
  audio.addEventListener('loadedmetadata', begin, { once: true });
  audio.addEventListener('error', onError, { once: true });
}

/** `timeupdate` only fires a few times a second, which is too coarse both to
 *  stop on the span's end and to move a playhead without it stuttering. */
function follow(audio, token, opId, win) {
  const span = Math.max(1, win.to - win.from);
  const stop = () => {
    if (segment.token !== token) return;
    // Leave the one player at the precise review boundary, even if a media
    // frame crossed it before the browser delivered this animation frame.
    if (!audio.ended) audio.currentTime = win.to / 1000;
    audio.pause();
    stopSegment();
  };
  // A hidden tab runs no animation frames, so the rAF chain cannot be the only
  // thing holding the span's end: play a span, switch tabs, and the rest of the
  // call would play out behind your back. The timer owns the boundary; the
  // frames only move the progress bar.
  const arm = () => {
    if (segment.timer) clearTimeout(segment.timer);
    const left = (win.to - audio.currentTime * 1000) / (audio.playbackRate || 1);
    segment.timer = setTimeout(() => { if (segment.token === token && !audio.paused) stop(); }, Math.max(0, left) + 30);
  };
  const tick = () => {
    if (segment.token !== token) return;
    const nowMs = audio.currentTime * 1000;
    if (nowMs >= win.to || audio.ended) { stop(); return; }
    if (audio.paused) { stopSegment(); return; }
    paintSegment(opId, (nowMs - win.from) / span);
    segment.raf = requestAnimationFrame(tick);
  };
  arm();
  // Seeking or changing speed mid-span invalidates the deadline the timer was
  // armed against.
  audio.addEventListener('seeked', arm);
  audio.addEventListener('ratechange', arm);
  segment.disarm = () => {
    audio.removeEventListener('seeked', arm);
    audio.removeEventListener('ratechange', arm);
  };
  segment.raf = requestAnimationFrame(tick);
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
  // The exception is the player: its viewport is a `role="slider"` and its
  // controls are buttons, so this rule would silence m / l / s / [ / ] / zoom
  // exactly where a reviewer is most likely to press them — right after
  // clicking the waveform. Only the keys the focused control genuinely owns
  // (arrows, Enter, Space, paging) still belong to it.
  const inPlayer = event.target instanceof Element && event.target.closest('.call-player');
  const controlOwns = event.key.startsWith('Arrow')
    || ['Enter', ' ', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(event.key);
  if (inPlayer && !controlOwns && state.audio && ui.playerKeys?.(event)) {
    event.preventDefault();
    return;
  }

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
  } else if (event.key.toLowerCase() === 'b') {
    toggleRail();
    event.preventDefault();
  } else if (event.key.toLowerCase() === 'c' && ui.toggleDeck) {
    ui.toggleDeck();
    event.preventDefault();
  } else if (event.key.toLowerCase() === 't' && ui.deckPanels) {
    // The key used to open and close the transcript; it now brings it forward,
    // which is the same intent in a tabbed column. It must not move focus onto
    // the tab: a focused `role="tab"` is a control, and the guard above would
    // then swallow the next press of the same key.
    showDeckTab(ui.deckPanels.transcript.hidden ? 'transcript' : 'turns', { focus: false });
    event.preventDefault();
  } else if (event.key === ' ' && state.audio) {
    ui.togglePlay?.();
    event.preventDefault();
  } else if (state.audio && ui.playerKeys?.(event)) {
    event.preventDefault();
  } else if (event.key === 'Escape') {
    // A loop range is the most recent thing the reviewer set, so it clears
    // before the selection the rest of the page is drawn from.
    if (ui.clearAudioSelection?.()) return;
    setSelection(null, null);
  }
});

/* ------------------------------------------------------------------ rail */

/** The rail is 292px of furniture on every screen. Folding it to a strip is a
 *  view preference, not call state, so it outlives the session and the URL. */
const RAIL_KEY = 'vaani.rail.collapsed';

function setRailCollapsed(collapsed) {
  const button = $('#rail-toggle');
  $('#shell').dataset.rail = collapsed ? 'collapsed' : 'open';
  button.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Show the call list' : 'Hide the call list';
  button.setAttribute('aria-label', label);
  button.title = `${label}  ·  b`;
  try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch { /* private mode */ }
}

function toggleRail() {
  setRailCollapsed($('#shell').dataset.rail !== 'collapsed');
}

let railStart = false;
try { railStart = localStorage.getItem(RAIL_KEY) === '1'; } catch { /* private mode */ }
setRailCollapsed(railStart);

/* ------------------------------------------------------------- bootstrap */

$('#rail-toggle').addEventListener('click', toggleRail);
$('#refresh').addEventListener('click', () => loadSessions({ reload: true }));
$('#session-search').addEventListener('input', (event) => { state.filter = event.target.value; renderRail(); });
// The page itself no longer scrolls — the call pane and the rail do — and a
// tooltip is positioned against a rectangle that any of them can move.
document.addEventListener('scroll', hideTooltip, { capture: true, passive: true });
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
