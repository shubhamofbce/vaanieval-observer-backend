/* The get-started guide.
 *
 * Three rules govern everything below, and they are the reason this page is
 * not just a rendered README:
 *
 * 1. **A tick means this server saw evidence.** Steps 1, 3 and 4 are decided
 *    entirely by `/v1/onboarding/status`, which reads rows that ingest wrote.
 *    The page never infers completion from "the user clicked the copy button"
 *    or from an absent error. Step 2 — did `pip`/`npm` finish — genuinely
 *    cannot be observed from here until data flows, so it is the one step a
 *    developer may mark themselves, and a self-report is drawn as a dashed,
 *    differently-worded claim rather than borrowing the green tick that
 *    everything else has to earn.
 *
 * 2. **The snippet is the developer's, not an example's.** The ingest URL is
 *    whatever host they reached this page on, and a key they just minted is
 *    pasted in literally. What the page cannot know — their provider URLs —
 *    is marked as a blank to fill rather than quietly presented as working
 *    configuration. A snippet you must diff against your own setup before it
 *    runs is a snippet that has already failed.
 *
 * 3. **It waits with them.** After the key exists the page polls, so the
 *    moment the first call lands the step turns over under the developer's
 *    cursor while they are still in the terminal. Polling stops as soon as
 *    every step is verified, and while the tab is hidden.
 */
(function () {
  'use strict';

  const RUNTIME_KEY = 'vaani.onboarding.runtime';
  const MARK_KEY = 'vaani.onboarding.marked';
  // Fast enough that the first call feels instant, slow enough that a guide
  // left open all afternoon is not a load generator. Backs off when the tab is
  // hidden and stops entirely once there is nothing left to wait for.
  const POLL_MS = 4000;
  const IDLE_POLL_MS = 20000;
  const PLACEHOLDER_KEY = 'PASTE_YOUR_API_KEY';

  /* Snippet markers. Code is authored as plain text with these sentinels so the
   * copyable string and the highlighted markup are generated from one source —
   * two hand-maintained copies of a command is how a page ends up teaching one
   * thing and copying another. The delimiters are control characters, which
   * cannot occur in the snippets and survive HTML escaping untouched. */
  const M_OPEN = '\u0001';
  const M_MID = '\u0002';
  const M_END = '\u0003';
  const mark = (kind) => (text) => `${M_OPEN}${kind}${M_MID}${text}${M_END}`;
  const cmt = mark('cmt');
  const fill = mark('fill');
  const live = mark('live');
  const MARKER = /\u0001(cmt|fill|live)\u0002([\s\S]*?)\u0003/g;

  const state = {
    runtime: 'python',
    variant: {},
    status: null,
    keys: [],
    minted: null,
    error: null,
    creating: false,
    loading: true,
    reqId: 0,
    timer: null,
  };

  const $ = (sel) => document.querySelector(sel);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* localStorage is unavailable in some privacy modes and throws on write when
   * a quota is hit. None of this state is worth failing a render over — but a
   * swallowed write would turn "I have installed it" into a button that does
   * nothing at all, with no feedback. So fall back to a process-lifetime map:
   * the control keeps working for this visit, it just does not survive a
   * reload. */
  const memoryStore = new Map();
  function readStore(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) return JSON.parse(raw);
    } catch { /* private mode */ }
    return memoryStore.has(key) ? memoryStore.get(key) : fallback;
  }
  function writeStore(key, value) {
    memoryStore.set(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }

  function marked() {
    const value = readStore(MARK_KEY, {});
    return value && typeof value === 'object' ? value : {};
  }
  function setMarked(stepId, on) {
    const value = marked();
    if (on) value[stepId] = true; else delete value[stepId];
    writeStore(MARK_KEY, value);
  }

  function toast(message, tone) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast${tone ? ` ${tone}` : ''}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  /* `navigator.clipboard` is unavailable on a plain-HTTP origin that is not
   * localhost — which is exactly how this dashboard gets reached from a
   * colleague's machine or a LAN IP. Failing there would mean the one control
   * this page is built around silently does nothing, so the legacy path stays. */
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      ok ? resolve() : reject(new Error('Copy is blocked in this browser.'));
    });
  }

  function plain(code) {
    return code.replace(MARKER, (_match, _kind, text) => text);
  }

  function highlight(code) {
    // Escaped first so the code itself can never inject markup; the markers are
    // control characters and pass through `esc` unchanged, so the spans are
    // applied to already-safe text.
    return esc(code).replace(MARKER, (_match, kind, text) => `<span class="${kind}">${text}</span>`);
  }

  function relative(iso) {
    if (!iso) return '';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';
    const seconds = Math.round((Date.now() - then) / 1000);
    if (seconds < 45) return 'just now';
    if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 172800) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
  }

  function absolute(iso) {
    if (!iso) return '';
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleString();
  }

  const ICON = {
    tick: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.5 6.5a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06L6.75 10.19l5.97-5.97a.75.75 0 0 1 1.06 0Z"/></svg>',
    dot: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="8" cy="8" r="3.25" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    hand: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" d="M3.2 8.4 6 11.2l6.8-6.8"/></svg>',
    copy: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M5.5 2A1.5 1.5 0 0 0 4 3.5v8A1.5 1.5 0 0 0 5.5 13h6a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 11.5 2h-6Zm0 1.5h6v8h-6v-8ZM2 5.25A.75.75 0 0 1 2.75 6v6.25c0 .14.11.25.25.25h5.25a.75.75 0 0 1 0 1.5H3A1.75 1.75 0 0 1 1.25 12.25V6A.75.75 0 0 1 2 5.25Z"/></svg>',
    alert: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 1.75a.75.75 0 0 1 .65.38l6 10.5A.75.75 0 0 1 14 13.75H2a.75.75 0 0 1-.65-1.12l6-10.5A.75.75 0 0 1 8 1.75Zm0 3.5a.7.7 0 0 0-.7.78l.25 2.6a.45.45 0 0 0 .9 0l.25-2.6A.7.7 0 0 0 8 5.25Zm0 5a.85.85 0 1 0 0 1.7.85.85 0 0 0 0-1.7Z"/></svg>',
  };

  /* ------------------------------------------------------------------ content
   *
   * Every command and every API name below is taken from the SDK sources, not
   * paraphrased. Neither SDK is published to a registry yet, and the page says
   * so in the install step rather than printing a `pip install vaani-observer`
   * that resolves to somebody else's package.
   */
  const RUNTIMES = {
    python: {
      label: 'Python',
      language: 'python',
      package: 'vaanieval-observer',
      requires: 'Python 3.10+',
      install: (ctx) => [
        cmt('# Not on PyPI yet — install from the SDK repository.'),
        'pip install "vaanieval-observer @ git+https://github.com/shubhamofbce/vaanieval-observer-python-sdk.git"',
        '',
        cmt('# On LiveKit Agents, take the extra that pulls in the integration:'),
        cmt('#   pip install "vaanieval-observer[livekit] @ git+…"'),
      ].join('\n'),
      verify: 'python -c "import vaani_observer; print(vaani_observer.__version__)"',
      variants: [
        {
          id: 'plain',
          label: 'Any agent',
          code: (ctx) => [
            'from vaani_observer import VaaniObserver',
            '',
            'AUDIO = {"encoding": "pcm_s16le", "sample_rate_hz": 16000, "channels": 1}',
            '',
            'vaani = VaaniObserver(',
            `    endpoint=${live(`"${ctx.endpoint}"`)},   ${cmt('# this dashboard — filled in for you')}`,
            `    api_key=${ctx.keyLiteral},`,
            cmt('    # endpoints (plural) is a different thing from endpoint above: these are'),
            cmt('    # your providers. Only URLs matched here are timed. Anything else your'),
            cmt('    # agent calls is left untouched on purpose — so list what you want measured.'),
            '    endpoints=[',
            `        {"id": "stt", "type": "stt", "url": ${fill('"https://api.your-stt.com"')}},`,
            `        {"id": "llm", "type": "llm", "url": ${fill('"https://api.your-llm.com"')}},`,
            `        {"id": "tts", "type": "tts", "url": ${fill('"https://api.your-tts.com"')}},`,
            '    ],',
            ')',
            '',
            'async def handle_call():',
            '    session = vaani.start_session(agent_id="support")',
            '',
            cmt('    # caller_pcm / agent_pcm are the raw 16-bit PCM frames your telephony or'),
            cmt('    # WebRTC stack already hands you. Tee them here — nothing is re-encoded,'),
            cmt('    # re-sent, or pulled from the network. On LiveKit, use the tab above:'),
            cmt('    # the mixin does this teeing for you.'),
            '    session.record_inbound_audio(caller_pcm, AUDIO)',
            '    session.record_outbound_audio(agent_pcm, AUDIO)',
            '',
            cmt('    # Provider calls made inside this block are attributed to the call.'),
            '    with session.context():',
            `        await ${fill('run_your_agent()')}`,
            '',
            '    finalized = await session.end(outcome="completed")',
            `    await vaani.upload_package(finalized)   ${cmt('# explicit, after the call')}`,
          ].join('\n'),
        },
        {
          id: 'livekit',
          label: 'LiveKit Agents',
          code: (ctx) => [
            cmt('# 1. Mix the audio tap into your Agent so caller and agent PCM are teed.'),
            'from vaani_observer.integrations.livekit import VaaniAudioTapMixin, observe_agent_session',
            '',
            `class ${fill('MyAgent')}(VaaniAudioTapMixin, Agent):`,
            '    ...',
            '',
            cmt('# 2. Attach a recorder to the AgentSession. It reads the VAANI_* env below,'),
            cmt('#    subscribes to LiveKit\'s own metrics, and uploads when the call ends.'),
            'recorder = observe_agent_session(agent_session)',
            'agent.vaani = recorder',
            '',
            cmt('# 3. Finish the call. This finalizes the package and uploads it.'),
            'await recorder.finish(outcome="completed")',
          ].join('\n'),
          env: (ctx) => [
            'VAANI_ENABLED=1',
            `VAANI_ENDPOINT=${live(ctx.endpoint)}`,
            `VAANI_API_KEY=${ctx.keyRaw}`,
            'VAANI_AGENT_ID=support',
          ].join('\n'),
          envNote: 'The LiveKit recorder is configured from the environment, so no key ever reaches your source tree. With <code>VAANI_ENABLED</code> unset it builds an inert recorder — the integration stays in place and records nothing.',
        },
      ],
    },
    nodejs: {
      label: 'Node.js',
      language: 'javascript',
      package: '@vaanieal/observer',
      requires: 'Node 20+',
      install: () => [
        cmt('# Not on npm yet — install from the SDK repository.'),
        'npm install github:shubhamofbce/vaanieval-observer-nodejs-sdk',
      ].join('\n'),
      verify: "node --input-type=module -e \"import { VaaniObserver } from '@vaanieal/observer'; console.log(typeof VaaniObserver)\"",
      variants: [
        {
          id: 'plain',
          label: 'Any agent',
          code: (ctx) => [
            "import { VaaniObserver } from '@vaanieal/observer';",
            '',
            cmt('// Note the casing: the Node SDK takes sampleRateHz where the Python SDK'),
            cmt('// takes sample_rate_hz. Each SDK follows its own language convention.'),
            "const AUDIO = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 };",
            '',
            'const vaani = new VaaniObserver({',
            `  endpoint: ${live(`'${ctx.endpoint}'`)},   ${cmt('// this dashboard — filled in for you')}`,
            `  apiKey: ${ctx.keyLiteralJs},`,
            cmt('  // endpoints (plural) is a different thing from endpoint above: these are'),
            cmt('  // your providers. Only URLs matched here are timed. Anything else your'),
            cmt('  // agent calls is left untouched on purpose — so list what you want measured.'),
            '  endpoints: [',
            `    { id: 'stt', type: 'stt', url: ${fill("'https://api.your-stt.com'")} },`,
            `    { id: 'llm', type: 'llm', url: ${fill("'https://api.your-llm.com'")} },`,
            `    { id: 'tts', type: 'tts', url: ${fill("'https://api.your-tts.com'")} },`,
            '  ],',
            '});',
            '',
            'async function handleCall() {',
            "  const session = vaani.startSession({ agentId: 'support' });",
            '',
            cmt('  // callerPcm / agentPcm are the raw 16-bit PCM Buffers your telephony or'),
            cmt('  // WebRTC stack already hands you. Tee them here — nothing is re-encoded,'),
            cmt('  // re-sent, or pulled from the network.'),
            '  session.recordInboundAudio(callerPcm, AUDIO);',
            '  session.recordOutboundAudio(agentPcm, AUDIO);',
            '',
            cmt('  // fetch() calls made inside run() are attributed to the call.'),
            `  await session.run(() => ${fill('runYourAgent()')});`,
            '',
            "  const finalized = await session.end({ outcome: 'completed' });",
            `  await vaani.uploadPackage(finalized);   ${cmt('// explicit, after the call')}`,
            '}',
          ].join('\n'),
        },
      ],
    },
  };

  function runtime() {
    return RUNTIMES[state.runtime] || RUNTIMES.python;
  }

  function variantFor(config) {
    const chosen = state.variant[state.runtime];
    return config.variants.find((item) => item.id === chosen) || config.variants[0];
  }

  /* The key the snippet shows. A freshly minted token is pasted in literally —
   * it is already on screen a few centimetres above, so hiding it here would
   * buy nothing and cost the developer a manual edit. Otherwise the page prints
   * a placeholder: it cannot read back an existing key, and a snippet that
   * showed a prefix would look copy-ready while silently failing to
   * authenticate. */
  function keyContext(endpoint) {
    const token = state.minted && state.minted.token;
    return {
      endpoint,
      keyRaw: token || PLACEHOLDER_KEY,
      keyLiteral: token ? live(`"${token}"`) : fill(`"${PLACEHOLDER_KEY}"`),
      keyLiteralJs: token ? live(`'${token}'`) : fill(`'${PLACEHOLDER_KEY}'`),
    };
  }

  function snippet(title, code, options) {
    const opts = options || {};
    const source = plain(code);
    const tabs = opts.tabs || '';
    return `<div class="snippet">
      <div class="snippet-head">
        <h3>${esc(title)}</h3>
        ${tabs}
        <button type="button" class="btn tiny" data-copy="${esc(source)}">${ICON.copy}Copy</button>
      </div>
      <pre><code>${highlight(code)}</code></pre>
    </div>`;
  }

  function stateBadge(step, selfReported) {
    if (step.state === 'verified') {
      return `<span class="step-state" data-state="verified">${ICON.tick}Verified</span>`;
    }
    if (selfReported) {
      return `<span class="step-state" data-state="self-reported" title="You marked this done. This dashboard cannot observe it until a call arrives.">${ICON.hand}Marked done by you</span>`;
    }
    return `<span class="step-state" data-state="waiting">${ICON.dot}Not done</span>`;
  }

  function evidence(step) {
    if (step.state !== 'verified' || !step.evidence) return '';
    // Each step's evidence carries its own timestamp under a different key,
    // because each proves a different event. Reading only `first.created_at`
    // silently dropped the time from every step that does not have a `first` —
    // and an undated claim is the weaker claim this page argues against.
    const detail = step.detail || {};
    const when = (detail.first && detail.first.created_at)
      || detail.last_used_at
      || (detail.captured && detail.captured.created_at)
      || null;
    return `<div class="step-evidence">${ICON.tick}<div>${esc(step.evidence)}${
      when ? ` <span class="when">· ${esc(relative(when))}</span>` : ''
    }</div></div>`;
  }

  function waiting(step, options) {
    if (step.state === 'verified' || !step.waiting) return '';
    const opts = options || {};
    const lead = opts.listening
      ? '<span class="pulse" aria-hidden="true"></span>'
      : `<span aria-hidden="true">${ICON.alert}</span>`;
    return `<div class="step-waiting"${opts.tone ? ` data-tone="${opts.tone}"` : ''}>${lead}<div>${
      opts.html || esc(step.waiting)
    }</div></div>`;
  }

  /* ------------------------------------------------------------------- steps */

  function renderKeyStep(step) {
    const active = state.keys.filter((key) => !key.revoked_at);
    const rows = state.keys.map((key) => `
      <tr data-revoked="${key.revoked_at ? 'true' : 'false'}">
        <td class="name">${esc(key.name)}</td>
        <td class="prefix">${esc(key.prefix)}…</td>
        <td title="${esc(absolute(key.created_at))}">${esc(relative(key.created_at))}</td>
        <td title="${esc(absolute(key.last_used_at) || '')}">${
          key.last_used_at ? esc(relative(key.last_used_at)) : '<span style="color:var(--text-faint)">never</span>'
        }</td>
        <td class="actions">${
          key.revoked_at
            ? `<span class="step-state" data-state="waiting" title="Revoked ${esc(absolute(key.revoked_at))}">Revoked</span>`
            : `<button type="button" class="btn tiny" data-revoke="${esc(key.id)}" data-name="${esc(key.name)}">Revoke</button>`
        }</td>
      </tr>`).join('');

    const table = state.keys.length
      ? `<table class="key-table">
          <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
      : '';

    const reveal = state.minted
      ? `<div class="key-reveal">
          <p><b>Copy this now.</b> Only a SHA-256 digest is stored, so this dashboard cannot show it again. Lost keys are replaced, not recovered.</p>
          <div class="key-value">
            <code>${esc(state.minted.token)}</code>
            <button type="button" class="btn tiny primary" data-copy="${esc(state.minted.token)}">${ICON.copy}Copy</button>
            <button type="button" class="btn tiny ghost" data-dismiss-key>Done</button>
          </div>
          <p style="color:var(--text-dim)">It is filled into the snippets below while this panel is open.</p>
        </div>`
      : '';

    const enforcement = state.status && state.status.enforcement;
    const note = enforcement && !enforcement.required
      ? `<p class="foot-note">This instance does not <em>require</em> a key: ingest is accepted with or without one, so a local agent keeps working. Set <code>${esc(enforcement.env_var)}=1</code> to reject unauthenticated uploads. Either way the key is recorded when it is used, which is what verifies this step.</p>`
      : '<p class="foot-note">This instance requires a valid key on every ingest request. An agent sending an unknown or revoked key receives <code>401</code>. Creating and revoking keys needs one too — send an existing key, or do it from the host, or the gate would cost an attacker a single unauthenticated request.</p>';

    return `
      <p class="step-lede">The SDK sends this key on the two calls that create and complete a session. Keep one key per environment so revoking a leaked staging key never takes production down with it.</p>
      ${reveal}
      ${table}
      <form class="key-form" data-key-form>
        <input type="text" name="name" maxlength="80" placeholder="Key name — e.g. “local dev” or “staging”" aria-label="Name for the new API key" autocomplete="off">
        <button type="submit" class="btn${active.length ? '' : ' primary'}" ${state.creating ? 'disabled' : ''}>${
          state.creating ? 'Creating…' : 'Create API key'
        }</button>
      </form>
      ${note}`;
  }

  function renderInstallStep(step, config, ctx) {
    return `
      <p class="step-lede">One package, ${esc(config.requires)}. It writes each call to a local spool directory and uploads after the call ends, so nothing in the media path waits on this dashboard.</p>
      ${snippet(`Install · ${config.label}`, config.install(ctx))}
      ${snippet('Check it imports', config.verify)}`;
  }

  function renderInstrumentStep(step, config, ctx) {
    const tabs = config.variants.length > 1
      ? `<div class="snippet-tabs" role="tablist" aria-label="Integration style">${config.variants.map((item) => `
          <button type="button" role="tab" data-variant="${esc(item.id)}" aria-selected="${
            item.id === variantFor(config).id ? 'true' : 'false'
          }">${esc(item.label)}</button>`).join('')}</div>`
      : '';
    const variant = variantFor(config);
    const first = step.detail && step.detail.first;

    const body = [
      `<p class="step-lede">Construct the observer once, wrap the call, and upload when it ends. The one thing this page cannot fill in for you is <span class="fill" style="padding:0 3px">your provider URLs</span> — the SDK only measures endpoints you list.</p>`,
      snippet(`Instrument · ${config.label}`, variant.code(ctx), { tabs }),
    ];
    if (variant.env) {
      body.push(snippet('Environment', variant.env(ctx)));
      if (variant.envNote) body.push(`<p class="foot-note">${variant.envNote}</p>`);
    }
    if (step.state === 'verified' && first) {
      const recent = (step.detail.recent || []).map((call) => `
        <a class="recent-row" href="/#/call/${encodeURIComponent(call.session_id)}">
          <span class="status-pill" data-status="${esc(call.status)}">${esc(call.status)}</span>
          <span class="id">${esc(call.session_id)}</span>
          <span class="ops">${call.operation_count} ops</span>
          <span>${esc(relative(call.created_at))}</span>
        </a>`).join('');
      body.push(`<div class="recent">${recent}</div>`);
    }
    return body.join('');
  }

  function renderCaptureStep(step, config) {
    const captured = step.detail && step.detail.captured;
    const body = [
      '<p class="step-lede">An uploaded call is not yet an observed call. This step passes only once at least one provider request was actually timed — which is the check that catches an <code>endpoints</code> list that matches nothing.</p>',
    ];
    if (captured) {
      body.push(`<div class="step-actions">
        <a class="btn primary" href="/#/call/${encodeURIComponent(captured.session_id)}">Open the call</a>
        <a class="btn" href="/dashboard">Go to the dashboard</a>
        <span class="muted">${esc(captured.operation_count)} operations · ${esc(relative(captured.created_at))}</span>
      </div>`);
    }
    return body.join('');
  }

  function renderStep(step, index, config, ctx) {
    const selfReported = Boolean(step.self_reportable && marked()[step.id]);
    const stepState = step.state === 'verified' ? 'verified' : (selfReported ? 'self-reported' : 'waiting');

    let body = '';
    let waitingBlock = '';
    if (step.id === 'api-key') {
      body = renderKeyStep(step);
      waitingBlock = waiting(step);
    } else if (step.id === 'install') {
      body = renderInstallStep(step, config, ctx);
      waitingBlock = selfReported ? '' : waiting(step);
    } else if (step.id === 'instrument') {
      body = renderInstrumentStep(step, config, ctx);
      waitingBlock = waiting(step, { listening: true });
    } else {
      body = renderCaptureStep(step, config);
      waitingBlock = waiting(step, {
        tone: step.detail && step.detail.uploaded_without_operations ? 'warn' : undefined,
        listening: !(step.detail && step.detail.uploaded_without_operations),
      });
    }

    const mine = step.self_reportable
      ? `<div class="step-actions"><button type="button" class="btn tiny" data-mark="${esc(step.id)}" data-on="${
          selfReported ? 'true' : 'false'
        }">${selfReported ? 'Un-mark this step' : 'I have installed it'}</button><span class="muted">${
          selfReported
            ? 'Your own note. It is replaced by real evidence when your first call arrives.'
            : 'Only you can see this; it never counts as evidence.'
        }</span></div>`
      : '';

    return `<li class="step" data-state="${stepState}" data-current="${step.state !== 'verified' && !selfReported}">
      <span class="step-marker" aria-hidden="true">${step.state === 'verified' ? ICON.tick : index + 1}</span>
      <div class="step-head">
        <h2>${esc(step.title)}</h2>
        ${stateBadge(step, selfReported)}
      </div>
      <div class="step-body">
        ${evidence(step)}
        ${waitingBlock}
        ${body}
        ${mine}
      </div>
    </li>`;
  }

  /* ------------------------------------------------------------------ render */

  function renderProgress() {
    const status = state.status;
    const node = $('#progress');
    if (!status) { node.innerHTML = ''; return; }
    // Self-reports are counted nowhere. The number beside "of 4" is how many
    // steps this server can prove, and it has to stay that even when the
    // developer has ticked one themselves.
    const done = status.verified_steps;
    const total = status.total_steps;
    node.innerHTML = status.complete
      ? `<span class="progress-done">${ICON.tick}Setup verified end to end</span>
         <div class="progress-track" aria-hidden="true">${'<i data-on="true"></i>'.repeat(total)}</div>`
      : `<span class="progress-count"><b>${done}</b> of ${total} steps verified</span>
         <div class="progress-track" aria-hidden="true">${
           status.steps.map((step) => `<i data-on="${step.state === 'verified'}"></i>`).join('')
         }</div>`;
  }

  function renderRuntimeSwitch() {
    const wrap = $('#runtime-switch');
    wrap.hidden = false;
    wrap.querySelectorAll('[data-runtime]').forEach((button) => {
      const on = button.dataset.runtime === state.runtime;
      button.setAttribute('aria-checked', String(on));
      button.setAttribute('aria-pressed', String(on));
      button.tabIndex = on ? 0 : -1;
    });
    // If calls are arriving from a runtime other than the one being read, say
    // so. Reading Python instructions while a Node agent uploads is a confusing
    // ten minutes that one sentence prevents.
    const status = state.status;
    const seen = status && status.ingest.latest && status.ingest.latest.sdk.language;
    const hint = $('#runtime-hint');
    hint.innerHTML = seen && seen !== state.runtime && RUNTIMES[seen]
      ? `Your most recent call came from the <b>${esc(RUNTIMES[seen].label)}</b> SDK.`
      : '';
  }

  function renderFoot() {
    const foot = $('#guide-foot');
    const status = state.status;
    if (!status) { foot.hidden = true; return; }
    foot.hidden = false;
    foot.innerHTML = `
      <div class="legend">
        <span class="step-state" data-state="verified">${ICON.tick}Verified</span>
        <span>a row this dashboard received</span>
        <span class="step-state" data-state="self-reported">${ICON.hand}Marked done by you</span>
        <span>your note, stored in this browser only</span>
      </div>
      <p class="foot-note">Ingest endpoint <code>${esc(status.endpoint)}</code> · checked ${esc(relative(status.generated_at))}. Nothing on this page is cached: every state above is recomputed from the calls and keys this instance holds.</p>`;
  }

  function render() {
    const body = $('#steps');
    if (state.error && !state.status) {
      body.innerHTML = `<li class="load-error">${ICON.alert}<div>${esc(state.error)}</div></li>`;
      $('#runtime-switch').hidden = true;
      renderFoot();
      return;
    }
    if (!state.status) {
      body.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
      return;
    }
    const config = runtime();
    const ctx = keyContext(state.status.endpoint);
    body.innerHTML = state.status.steps
      .map((step, index) => renderStep(step, index, config, ctx))
      .join('');
    renderProgress();
    renderRuntimeSwitch();
    renderFoot();
  }

  /* -------------------------------------------------------------------- data */

  function connState(text, tone) {
    const node = $('#conn-state');
    node.textContent = text;
    if (tone) node.dataset.state = tone; else delete node.dataset.state;
  }

  function load(options) {
    const opts = options || {};
    const id = ++state.reqId;
    if (!opts.quiet) connState('Checking…');
    return Promise.all([
      fetch('/v1/onboarding/status').then(readJson),
      fetch('/v1/api-keys').then(readJson),
    ])
      .then(([status, keyList]) => {
        if (id !== state.reqId) return;   // a newer request already won
        state.status = status;
        state.keys = keyList.keys || [];
        state.error = null;
        state.loading = false;
        // A key revoked in another tab, or one that never existed, must not
        // leave a stale secret pasted into the snippets below.
        if (state.minted && !state.keys.some((key) => key.id === state.minted.id && !key.revoked_at)) {
          state.minted = null;
        }
        connState(status.complete ? 'Setup verified' : 'Watching for calls');
        render();
        schedule();
      })
      .catch((error) => {
        if (id !== state.reqId) return;
        state.loading = false;
        state.error = error.message || 'Could not reach this dashboard.';
        connState('Offline', 'error');
        render();
        schedule();
      });
  }

  function readJson(response) {
    if (response.ok) return response.json();
    return response.text().then((text) => {
      let message = text || response.statusText;
      try { const parsed = JSON.parse(text); if (parsed && parsed.detail) message = parsed.detail; } catch { /* plain text */ }
      return Promise.reject(new Error(message));
    });
  }

  /* Polling stops once every step is verified. A setup page that keeps asking
   * after there is nothing left to learn is a background load on every browser
   * anyone left open on it. */
  function schedule() {
    clearTimeout(state.timer);
    if (state.status && state.status.complete) return;
    const delay = document.hidden ? IDLE_POLL_MS : POLL_MS;
    state.timer = setTimeout(() => load({ quiet: true }), delay);
  }

  function createKey(form) {
    if (state.creating) return;
    state.creating = true;
    render();
    const name = new FormData(form).get('name') || '';
    fetch('/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: String(name).slice(0, 80) }),
    })
      .then(readJson)
      .then((created) => {
        state.creating = false;
        state.minted = created;
        toast('API key created. Copy it now — it is not shown again.');
        return load({ quiet: true });
      })
      .catch((error) => {
        state.creating = false;
        toast(error.message || 'Could not create the key.', 'danger');
        render();
      });
  }

  function revokeKey(id, name) {
    // Revocation is the one destructive control here and it breaks a running
    // agent, so it asks. There is no undo: a revoked key cannot be restored.
    if (!window.confirm(`Revoke “${name}”?\n\nAny agent still sending this key stops being recognised. This cannot be undone.`)) return;
    fetch(`/v1/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
      .then(readJson)
      .then(() => {
        toast('Key revoked.');
        return load({ quiet: true });
      })
      .catch((error) => toast(error.message || 'Could not revoke the key.', 'danger'));
  }

  /* ------------------------------------------------------------------ events */

  document.addEventListener('click', (event) => {
    const copyButton = event.target.closest('[data-copy]');
    if (copyButton) {
      copy(copyButton.dataset.copy)
        .then(() => toast('Copied to clipboard.'))
        .catch((error) => toast(error.message || 'Copy failed.', 'danger'));
      return;
    }

    const runtimeButton = event.target.closest('[data-runtime]');
    if (runtimeButton) {
      state.runtime = runtimeButton.dataset.runtime;
      writeStore(RUNTIME_KEY, state.runtime);
      render();
      return;
    }

    const variantButton = event.target.closest('[data-variant]');
    if (variantButton) {
      state.variant[state.runtime] = variantButton.dataset.variant;
      render();
      return;
    }

    const markButton = event.target.closest('[data-mark]');
    if (markButton) {
      setMarked(markButton.dataset.mark, markButton.dataset.on !== 'true');
      render();
      return;
    }

    const revokeButton = event.target.closest('[data-revoke]');
    if (revokeButton) {
      revokeKey(revokeButton.dataset.revoke, revokeButton.dataset.name);
      return;
    }

    if (event.target.closest('[data-dismiss-key]')) {
      state.minted = null;
      render();
      return;
    }

    const refresh = event.target.closest('#refresh');
    if (refresh) load();
  });

  document.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-key-form]');
    if (!form) return;
    event.preventDefault();
    createKey(form);
  });

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement
      && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
    if (event.key === 'r' || event.key === 'R') { load(); event.preventDefault(); }
  });

  // Coming back to the tab is the moment a developer most wants a fresh answer
  // — they have just been in a terminal starting their agent.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { schedule(); return; }
    load({ quiet: true });
  });

  const stored = readStore(RUNTIME_KEY, null);
  if (typeof stored === 'string' && RUNTIMES[stored]) state.runtime = stored;
  render();
  load();
})();
