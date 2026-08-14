/* Alert rules a visitor writes themselves.
 *
 * The four rules the server ships are fixed, and a monitoring page you cannot
 * touch is a screenshot. So this module is the other half: pick a signal, put a
 * line under it, say where the message goes. It is the flow an engineer already
 * knows from Datadog, kept to the four decisions that matter.
 *
 * It owns the rules, their evaluation and the compose drawer. It does not own
 * the table: a visitor's rule and a shipped rule are the same kind of thing to
 * the person reading the page, so both are drawn as rows by alerts.js and this
 * module hands it the pieces.
 *
 * Two constraints shaped it.
 *
 * The demo takes no writes, and it is public: a rule saved on the server would
 * be a rule every other visitor sees, and a free write endpoint besides. So a
 * rule lives in this browser's localStorage. That is stated on the page rather
 * than hidden - a visitor who saves a rule, closes the tab and finds it gone
 * would rightly conclude the whole demo is theatre.
 *
 * And nothing is sent, ever. A form that silently swallows an email address is
 * worse than no form. Every path that would deliver says so, in those words.
 *
 * What is real: the evaluation. A rule is measured against the same aggregate
 * the dashboard and the fixed alerts read, so a rule that says ALERTING is
 * genuinely breaching in the sample data, and the drill-down link lands on the
 * calls behind it.
 */
(function () {
  const STORE_KEY = 'vaani.demo.monitors.v1';
  // The sample size below which the fixed rules refuse to judge. Mirrored from
  // app/alerts.py: a threshold that means one thing above the fold and another
  // below it is worse than having no threshold at all.
  const MINIMUM_CALLS = 3;
  const HOUR = 3600000;

  const WINDOWS = [
    { id: '1h', label: 'the last hour', ms: HOUR },
    { id: '24h', label: 'the last 24 hours', ms: 24 * HOUR },
    { id: '7d', label: 'the last 7 days', ms: 7 * 24 * HOUR },
    { id: '30d', label: 'the last 30 days', ms: 30 * 24 * HOUR },
  ];

  const STATS = [
    { id: 'p50', label: 'typical (p50)' },
    { id: 'p95', label: 'worst case (p95)' },
    { id: 'p99', label: 'extreme (p99)' },
  ];

  /* ------------------------------------------------------------- the signals */

  function stage(summary, stageId, key, stat) {
    const block = ((summary.stages || {})[stageId] || {}).metrics || [];
    const metric = block.find((entry) => entry.key === key);
    const dist = metric && metric.distribution;
    if (!dist || !dist.available) return { value: null, reason: (dist && dist.reason) || 'not captured on these calls' };
    if (dist[stat] == null) return { value: null, reason: 'not enough measured turns' };
    if (dist[`${stat}_confident`] === false) return { value: null, reason: `too few turns for a reliable ${stat}` };
    return { value: dist[stat] };
  }

  const METRICS = [
    {
      id: 'reply_wait',
      group: 'Conversation',
      label: 'Reply wait',
      phrase: 'the reply wait',
      help: 'How long the caller sat in silence before the agent answered.',
      unit: 'ms', stats: true, fallback: 5000, selector: 'slowest',
      read(summary, stat) {
        const block = summary.overview.response_latency;
        if (!block.available || block[stat] == null) return { value: null, reason: block.reason || 'not measurable' };
        if (block[`${stat}_confident`] === false) return { value: null, reason: `too few turns for a reliable ${stat}` };
        return { value: block[stat] };
      },
    },
    {
      id: 'audible_lag',
      group: 'Conversation',
      label: 'Turns where the caller waited over 3s',
      phrase: 'the share of turns where the caller waited over 3s',
      help: 'The share of replies slow enough that the caller hears dead air.',
      unit: 'rate', stats: false, fallback: 25, selector: 'audible_lag',
      read(summary) {
        const block = summary.overview.audible_lag;
        if (!block.available) return { value: null, reason: block.reason || 'not measurable' };
        if (Number(block.eligible || 0) < 10) return { value: null, reason: 'too few measured turns' };
        return { value: block.rate * 100 };
      },
    },
    {
      id: 'error_rate',
      group: 'Conversation',
      label: 'Calls hitting a provider error',
      phrase: 'the share of calls hitting a provider error',
      help: 'A failed speech or model call is a conversation that broke mid-sentence.',
      unit: 'rate', stats: false, fallback: 5, selector: 'failures',
      read(summary) {
        const block = summary.overview.failure_impacted_calls;
        if (!block.available) return { value: null, reason: block.reason || 'not measurable' };
        return { value: block.rate * 100 };
      },
    },
    {
      id: 'unmeasured',
      group: 'Conversation',
      label: 'Turns the SDK could not time',
      phrase: 'the share of turns the SDK could not time',
      help: 'An agent you cannot measure is an agent you cannot fix.',
      unit: 'rate', stats: false, fallback: 40, selector: 'unmeasured',
      read(summary) {
        const turns = Number(summary.coverage.turns_in_range || 0);
        const measured = Number(summary.coverage.measured_response_turns || 0);
        if (turns < 20) return { value: null, reason: 'too few turns in range' };
        return { value: ((turns - measured) / turns) * 100 };
      },
    },
    {
      id: 'stt_final',
      group: 'Pipeline stage',
      label: 'Speech to text · final transcript',
      phrase: 'the time to a final transcript',
      help: 'Caller stops speaking to the transcript the agent acts on.',
      unit: 'ms', stats: true, fallback: 2000, selector: 'slowest', byStage: true,
      read: (summary, stat) => stage(summary, 'stt', 'stt_final_ms', stat),
    },
    {
      id: 'llm_ttft',
      group: 'Pipeline stage',
      label: 'Model · time to first token',
      phrase: 'the model time to first token',
      help: 'The stage that most often owns a slow reply.',
      unit: 'ms', stats: true, fallback: 4000, selector: 'slowest', byStage: true,
      read: (summary, stat) => stage(summary, 'llm', 'llm_ttft_ms', stat),
    },
    {
      id: 'tts_first_audio',
      group: 'Pipeline stage',
      label: 'Voice · first audio out',
      phrase: 'the time to first audio out',
      help: 'How quickly the caller hears the first syllable.',
      unit: 'ms', stats: true, fallback: 800, selector: 'slowest', byStage: true,
      read: (summary, stat) => stage(summary, 'tts', 'tts_first_audio_ms', stat),
    },
  ];

  const metricById = (id) => METRICS.find((m) => m.id === id) || METRICS[0];
  const known = (id) => METRICS.some((m) => m.id === id);
  const windowById = (id) => WINDOWS.find((w) => w.id === id) || WINDOWS[2];

  /* ------------------------------------------------------------------ helpers */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function formatValue(metric, value) {
    if (value == null) return '—';
    if (metric.unit === 'rate') return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
  }

  function thresholdLabel(metric, threshold) {
    return metric.unit === 'rate' ? `${threshold}%` : formatValue(metric, threshold);
  }

  /* The rule read back as a sentence. Datadog does this for a reason: a row of
     dropdowns can be filled in correctly and still not mean what the author
     thought, and the only way to catch that is to read it as English. The
     picker labels are written to be scanned in a list, which is not the same
     job, so each metric carries a phrase for this. */
  function sentence(rule) {
    const metric = metricById(rule.metric);
    const stat = metric.stats ? ` at ${rule.statistic || 'p95'}` : '';
    const where = rule.scope ? rule.scope : 'all agents together';
    return `Notify ${rule.destination || 'nobody yet'} when ${metric.phrase}${stat} for ${where}`
      + ` goes ${rule.comparator === 'below' ? 'below' : 'above'} ${thresholdLabel(metric, rule.threshold)}`
      + ` over ${windowById(rule.window).label}.`;
  }

  function suggestedName(rule) {
    const metric = metricById(rule.metric);
    const scope = rule.scope || 'all agents';
    return `${metric.label} ${rule.comparator === 'below' ? '<' : '>'} ${thresholdLabel(metric, rule.threshold)} · ${scope}`;
  }

  /* --------------------------------------------------------------- the store */

  /* Two rules already in place on a first visit.
   *
   * An empty list is the honest starting state and a bad demo: the section a
   * visitor is meant to judge would be a blank box, and they would have to
   * build a rule before seeing what a built rule looks like. So the demo seeds
   * a pair - one alerting, one quiet, which is the contrast worth showing - and
   * tags them as examples so nobody mistakes them for their own work. Delete
   * either one and it stays deleted.
   */
  function seeds(agentList) {
    const busiest = agentList.find((id) => id === 'india-travel-agent') || '';
    return [
      {
        id: 'seed-wait', example: true, name: 'Transcription slower than 1.2s',
        metric: 'stt_final', statistic: 'p95', comparator: 'above', threshold: 1200,
        window: '7d', scope: '', severity: 'critical',
        channel: 'slack', destination: '#voice-oncall', muted: false,
      },
      {
        id: 'seed-tts', example: true, name: 'Voice stalls before the first syllable',
        metric: 'tts_first_audio', statistic: 'p95', comparator: 'above', threshold: 800,
        window: '7d', scope: busiest, severity: 'warning',
        channel: 'email', destination: 'voice-team@yourcompany.com', muted: false,
      },
    ];
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return Array.isArray(raw) ? raw : null;
    } catch (error) {
      return null;
    }
  }

  function persist(list) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
      return true;
    } catch (error) {
      // Private browsing, or a full quota. Better to say so than to show a rule
      // in the list that will not survive the next reload.
      return false;
    }
  }

  /* ------------------------------------------------------------- evaluation */

  const summaries = new Map();

  function summaryFor(windowId, agentId) {
    const key = `${windowId}|${agentId || ''}`;
    if (summaries.has(key)) return summaries.get(key);
    const to = window.vaaniNow();
    const params = new URLSearchParams({ from_ms: String(to - windowById(windowId).ms), to_ms: String(to) });
    if (agentId) params.set('agent_id', agentId);
    const request = fetch(`/v1/dashboard/summary?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    summaries.set(key, request);
    return request;
  }

  function judge(rule, summary) {
    const metric = metricById(rule.metric);
    const calls = Number(summary.coverage.calls || 0);
    if (!calls) return { state: 'no_data', reason: 'no calls in this window' };
    if (calls < MINIMUM_CALLS) {
      return { state: 'no_data', reason: `only ${calls} call${calls === 1 ? '' : 's'} in range`, calls };
    }
    const { value, reason } = metric.read(summary, rule.statistic || 'p95');
    if (value == null) return { state: 'no_data', reason: reason || 'not measurable', calls };
    const breaching = rule.comparator === 'below' ? value < rule.threshold : value > rule.threshold;
    return { state: breaching ? 'alerting' : 'ok', value, calls };
  }

  function verdictFor(rule) {
    return summaryFor(rule.window, rule.scope)
      .then((summary) => judge(rule, summary))
      .catch(() => ({ state: 'no_data', reason: 'could not read the sample data' }));
  }

  function drilldownHref(rule) {
    const metric = metricById(rule.metric);
    const params = new URLSearchParams({ range: rule.window });
    if (rule.scope) params.set('agent_id', rule.scope);
    params.set('drilldown', metric.selector);
    return `/dashboard?${params.toString()}`;
  }

  /* ------------------------------------------------------------- row pieces */
  /* alerts.js draws the row; this decides what it says, because the wording has
     to stay tied to the metric definitions above. */

  function row(rule, verdict) {
    const metric = metricById(rule.metric);
    const reading = verdict.state === 'no_data'
      ? `<span class="ac-reading is-nodata">No reading — ${esc(verdict.reason || 'not measurable')}</span>`
      : `<span class="ac-reading"><b>${esc(formatValue(metric, verdict.value))}</b>`
        + `threshold ${rule.comparator === 'below' ? 'under' : 'over'} ${esc(thresholdLabel(metric, rule.threshold))}</span>`;
    return {
      id: rule.id,
      source: 'yours',
      state: rule.muted ? 'muted' : verdict.state,
      severity: rule.severity,
      name: rule.name,
      tag: rule.example ? 'Example' : 'Yours',
      scope: rule.scope || 'All agents',
      scopeHtml: rule.scope
        ? `<span class="ac-scope"><b>${esc(rule.scope)}</b>one agent</span>`
        : '<span class="ac-scope"><b>All agents</b>nothing excluded</span>',
      readingHtml: reading,
      notifyHtml: `<span class="ac-notify"><b>${esc(rule.destination)}</b>`
        + `${rule.channel === 'slack' ? 'Slack' : 'Email'}</span>`,
    };
  }

  /* The alert as it would land, in the words the channel would carry. This is
     the part a visitor is actually buying, and the part where the demo has to
     be unambiguous, so the disclaimer sits inside the card. */
  function previewHtml(rule, verdict) {
    const metric = metricById(rule.metric);
    const value = verdict.state === 'no_data' ? 'no reading yet' : formatValue(metric, verdict.value);
    const title = `${rule.severity === 'critical' ? '[CRITICAL]' : '[WARNING]'} ${rule.name}`;
    const body = `${metric.label}${metric.stats ? ` (${rule.statistic})` : ''} is ${value} for `
      + `${rule.scope || 'all agents'} over ${windowById(rule.window).label}, `
      + `${rule.comparator === 'below' ? 'under' : 'over'} the ${thresholdLabel(metric, rule.threshold)} threshold.`;
    return `
      <div class="ac-preview is-${esc(rule.channel)}">
        <span class="ac-preview-where">${rule.channel === 'slack'
          ? `Slack · ${esc(rule.destination)}`
          : `Email · to ${esc(rule.destination)}`}</span>
        <p class="ac-preview-title">${esc(title)}</p>
        <p class="ac-preview-body">${esc(body)}</p>
        <p class="ac-preview-note">This is a demo dashboard. No alert was sent, and no address or
          channel you type here leaves your browser.</p>
      </div>`;
  }

  function detailHtml(rule, verdict) {
    const metric = metricById(rule.metric);
    const link = verdict.state === 'no_data'
      ? '<span class="ac-link is-off">No eligible calls to open</span>'
      : `<a class="ac-link" href="${esc(drilldownHref(rule))}">${metric.byStage
        ? 'See the slowest calls in this window \u2192'
        : 'See these calls \u2192'}</a>`;
    return `
      <p class="ac-detail-why">${esc(sentence(rule))}</p>
      <div class="ac-detail-grid">
        <div>
          <p class="ac-panel-title">Per agent, worst first</p>
          <div class="ac-agents" data-agents="${esc(rule.id)}">
            <p class="ac-note">Reading each agent&#8230;</p>
          </div>
        </div>
        <div>
          <p class="ac-panel-title">${metricById(rule.metric).byStage
            ? 'The slowest calls in this window'
            : 'The calls behind this number'}</p>
          <div class="ac-calls" data-calls="${esc(rule.id)}">
            <p class="ac-note">Looking for the worst calls&#8230;</p>
          </div>
        </div>
      </div>
      <p class="ac-note">${esc(metric.help)} This rule lives in <b>this browser only</b>, and nothing
        is ever delivered. Below ${MINIMUM_CALLS} measured calls it reports No data rather than guess.</p>
      <div data-preview="${esc(rule.id)}"></div>
      <div class="ac-detail-foot">
        ${link}
        <span class="ac-spacer"></span>
        <button type="button" class="btn tiny" data-act="test">Preview the message</button>
        <button type="button" class="btn tiny" data-act="mute">${rule.muted ? 'Unmute' : 'Mute'}</button>
        <button type="button" class="btn tiny" data-act="delete">Delete</button>
      </div>`;
  }

  /* A rule a visitor wrote has to answer the same two questions a built-in one
     does - which agent, and which calls - or the builder looks like a toy next
     to the rules that shipped. Both answers arrive after the row is already on
     screen, because each is a separate read of the sample. */

  function agentRowHtml(rule, agentId, verdict) {
    const metric = metricById(rule.metric);
    const firing = verdict.state === 'alerting';
    const tone = firing ? (rule.severity === 'critical' ? ' is-breaching' : ' is-warning')
      : (verdict.state === 'no_data' ? ' is-unknown' : '');
    const value = verdict.state === 'no_data' ? 'no reading' : formatValue(metric, verdict.value);
    const note = verdict.state === 'no_data'
      ? esc(verdict.reason || 'not measurable')
      : `${verdict.calls} call${verdict.calls === 1 ? '' : 's'}`;
    const href = `/dashboard?${new URLSearchParams({
      range: rule.window, agent_id: agentId, drilldown: metric.selector,
    }).toString()}`;
    return `
      <a class="ac-agent${tone}" href="${esc(href)}">
        <span class="ac-agent-value">${esc(value)}</span>
        <span class="ac-agent-id">${esc(agentId)}</span>
        <span class="ac-agent-calls">${note}</span>
      </a>`;
  }

  function callMetric(rule, call) {
    if (rule.metric === 'error_rate') {
      return `${call.failed_op_count || 0} failure${call.failed_op_count === 1 ? '' : 's'}`;
    }
    if (rule.metric === 'unmeasured') {
      const n = call.missing_final_turns || 0;
      return n ? `${n} turn${n === 1 ? '' : 's'} untimed` : 'no timings';
    }
    if (rule.metric === 'audible_lag') {
      const n = call.audible_lag_turns || 0;
      return `${n} slow turn${n === 1 ? '' : 's'}`;
    }
    if (!call.max_response_latency_ms) return '\u2014';
    const worst = `${(call.max_response_latency_ms / 1000).toFixed(1)}s`;
    // The number is the whole reply, not the stage. Labelling it says so in the
    // one place a reader would otherwise assume it was the stage's own timing.
    return metricById(rule.metric).byStage ? `reply ${worst}` : worst;
  }

  function hydrate(rule, node) {
    const agentSlot = node.querySelector(`[data-agents="${CSS.escape(rule.id)}"]`);
    const callSlot = node.querySelector(`[data-calls="${CSS.escape(rule.id)}"]`);
    const metric = metricById(rule.metric);
    // A scoped rule watches one agent. Showing the rest as if they were covered
    // would misstate what the rule does.
    const watched = rule.scope ? [rule.scope] : agents;

    if (agentSlot) {
      Promise.all(watched.map((agentId) => summaryFor(rule.window, agentId)
        .then((summary) => ({ agentId, verdict: judge(rule, summary) }))
        .catch(() => ({ agentId, verdict: { state: 'no_data', reason: 'could not read' } }))))
        .then((results) => {
          // "Worst" is whichever direction the rule watches. Sorting a
          // below-threshold rule high-first would put its healthiest agent on top.
          const worst = (a, b) => (rule.comparator === 'below'
            ? (a.verdict.value || 0) - (b.verdict.value || 0)
            : (b.verdict.value || 0) - (a.verdict.value || 0));
          results.sort((a, b) => (
            (a.verdict.state !== 'alerting') - (b.verdict.state !== 'alerting')
            || worst(a, b)
          ));
          agentSlot.innerHTML = results.map((r) => agentRowHtml(rule, r.agentId, r.verdict)).join('')
            + (rule.scope
              ? '<p class="ac-note">Scoped to one agent — the others are not watched by this rule.</p>'
              : '');
        });
    }

    if (!callSlot) return;
    // The call rankings the sample offers are all "most of this", so a rule
    // watching for a number falling below a floor has no matching list. Naming
    // the gap is better than handing over the slowest calls and hoping.
    if (rule.comparator === 'below') {
      callSlot.innerHTML = `<p class="ac-note">This sample ranks calls by the worst of a signal, so it
        cannot list the calls that pushed ${esc(metric.label.toLowerCase())} <b>below</b> your floor.
        The dashboard link opens the same window unranked.</p>`;
      return;
    }
    const to = window.vaaniNow();
    const params = new URLSearchParams({
      selector: metric.selector,
      from_ms: String(to - windowById(rule.window).ms),
      to_ms: String(to),
      limit: '4',
    });
    if (rule.scope) params.set('agent_id', rule.scope);
    fetch(`/v1/dashboard/calls?${params.toString()}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((data) => {
        const items = data.items || [];
        if (!items.length) {
          callSlot.innerHTML = '<p class="ac-note">No calls in this window match the signal.</p>';
          return;
        }
        callSlot.innerHTML = items.slice(0, 4).map((call) => `
          <a class="ac-call" href="/#/call/${encodeURIComponent(call.session_id)}${
            call.focus_turn_id ? `/turn/${encodeURIComponent(call.focus_turn_id)}` : ''}">
            <span class="ac-call-metric">${esc(callMetric(rule, call))}</span>
            <span class="ac-call-id">${esc(String(call.session_id).slice(0, 8))}</span>
            <span class="ac-call-agent">${esc(call.agent_id || '')}</span>
            <span class="ac-call-when"></span>
          </a>`).join('')
          + (metric.byStage
            ? `<p class="ac-note">The sample ranks calls by their slowest reply, not by
               ${esc(metric.label.toLowerCase())} on its own, so these are the slowest calls in the
               window rather than the calls that made this stage slow. Each figure is the whole
               reply.</p>`
            : '');
      })
      .catch(() => {
        callSlot.innerHTML = '<p class="ac-note">Could not load the calls behind this number.</p>';
      });
  }

  /* ------------------------------------------------------------------- form */

  const draft = {
    metric: 'reply_wait',
    statistic: 'p95',
    comparator: 'above',
    threshold: 5000,
    window: '7d',
    scope: '',
    severity: 'critical',
    channel: 'slack',
    destination: '#voice-oncall',
    name: '',
  };

  let agents = [];
  let rules = [];
  let notify = () => {};

  function options(list, selected) {
    return list.map((item) => (
      `<option value="${esc(item.value)}"${item.value === selected ? ' selected' : ''}>${esc(item.label)}</option>`
    )).join('');
  }

  function metricOptions(selected) {
    const groups = [...new Set(METRICS.map((m) => m.group))];
    return groups.map((group) => `
      <optgroup label="${esc(group)}">
        ${METRICS.filter((m) => m.group === group).map((m) => (
          `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.label)}</option>`
        )).join('')}
      </optgroup>`).join('');
  }

  function formHtml() {
    const metric = metricById(draft.metric);
    return `
      <form class="mon-form" id="mon-form" novalidate>
        <fieldset class="mon-step">
          <legend><span class="mon-step-n">1</span> Pick the signal</legend>
          <div class="mon-row">
            <label class="mon-field is-wide">
              <span>Metric</span>
              <select id="mon-metric">${metricOptions(draft.metric)}</select>
            </label>
            <label class="mon-field${metric.stats ? '' : ' is-off'}" id="mon-stat-field">
              <span>Statistic</span>
              <select id="mon-stat"${metric.stats ? '' : ' disabled'}>
                ${options(STATS.map((s) => ({ value: s.id, label: s.label })), draft.statistic)}
              </select>
            </label>
            <label class="mon-field">
              <span>Scope</span>
              <select id="mon-scope">
                ${options([{ value: '', label: 'All agents' }]
                  .concat(agents.map((a) => ({ value: a, label: a }))), draft.scope)}
              </select>
            </label>
          </div>
          <p class="mon-help" id="mon-metric-help">${esc(metric.help)}</p>
        </fieldset>

        <fieldset class="mon-step">
          <legend><span class="mon-step-n">2</span> Set the condition</legend>
          <div class="mon-row">
            <label class="mon-field">
              <span>Alert when</span>
              <select id="mon-comparator">
                ${options([
                  { value: 'above', label: 'is above' },
                  { value: 'below', label: 'is below' },
                ], draft.comparator)}
              </select>
            </label>
            <label class="mon-field">
              <span>Threshold</span>
              <span class="mon-threshold">
                <input id="mon-threshold" type="number" min="0" step="any" inputmode="decimal"
                  value="${esc(draft.threshold)}">
                <b id="mon-unit">${metric.unit === 'rate' ? '%' : 'ms'}</b>
              </span>
            </label>
            <label class="mon-field">
              <span>Evaluated over</span>
              <select id="mon-window">
                ${options(WINDOWS.map((w) => ({ value: w.id, label: w.label.replace('the ', '') })), draft.window)}
              </select>
            </label>
            <label class="mon-field">
              <span>Priority</span>
              <select id="mon-severity">
                ${options([
                  { value: 'critical', label: 'Critical' },
                  { value: 'warning', label: 'Warning' },
                ], draft.severity)}
              </select>
            </label>
          </div>
          <div class="mon-live" id="mon-live" aria-live="polite">Checking this threshold against the sample data…</div>
          <p class="mon-help">The window is measured against the published sample, not a live clock.
            Priority travels with the message so the receiving channel can route it.
            Under ${MINIMUM_CALLS} measured calls the rule reports <b>No data</b> instead of guessing —
            the same floor the built-in rules use. Recovery notices and re-notify cadence exist in the
            product but are not modelled on this frozen sample.</p>
        </fieldset>

        <fieldset class="mon-step">
          <legend><span class="mon-step-n">3</span> Say where it goes</legend>
          <div class="mon-row">
            <div class="mon-field">
              <span id="mon-channel-label">Channel</span>
              <div class="mon-channels" role="radiogroup" aria-labelledby="mon-channel-label">
                <label class="mon-channel${draft.channel === 'slack' ? ' is-on' : ''}">
                  <input type="radio" name="mon-channel" value="slack"${draft.channel === 'slack' ? ' checked' : ''}>
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 0 1 4 0v5a2 2 0 1 1-4 0v-5Zm2-8a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 0 1 0 4H4a2 2 0 1 1 0-4h5Zm9 2a2 2 0 1 1 2 2h-2V10Zm-1 0a2 2 0 1 1-4 0V5a2 2 0 1 1 4 0v5Zm-2 8a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 0 1 0-4h5a2 2 0 1 1 0 4h-5Z"/></svg>
                  Slack
                </label>
                <label class="mon-channel${draft.channel === 'email' ? ' is-on' : ''}">
                  <input type="radio" name="mon-channel" value="email"${draft.channel === 'email' ? ' checked' : ''}>
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Zm2.2-.5 6.8 5.1L18.8 6H5.2ZM19 7.9l-6.4 4.8a1 1 0 0 1-1.2 0L5 7.9v9.6c0 .3.2.5.5.5h13c.3 0 .5-.2.5-.5V7.9Z"/></svg>
                  Email
                </label>
              </div>
            </div>
            <label class="mon-field">
              <span id="mon-dest-label">${draft.channel === 'slack' ? 'Slack channel' : 'Email address'}</span>
              <input id="mon-destination" type="text" value="${esc(draft.destination)}"
                placeholder="${draft.channel === 'slack' ? '#voice-oncall' : 'oncall@yourteam.com'}"
                autocomplete="off" spellcheck="false">
            </label>
          </div>
        </fieldset>

        <fieldset class="mon-step">
          <legend><span class="mon-step-n">4</span> Name it</legend>
          <div class="mon-row">
            <label class="mon-field is-wide">
              <span>Rule name</span>
              <input id="mon-name" type="text" value="${esc(draft.name)}" autocomplete="off"
                placeholder="${esc(suggestedName(draft))}">
            </label>
          </div>
          <p class="mon-sentence" id="mon-sentence">${esc(sentence(draft))}</p>
          <p class="mon-error" id="mon-error" role="alert" hidden></p>
        </fieldset>
      </form>`;
  }

  /* ------------------------------------------------------------------ wiring */

  function el(id) { return document.getElementById(id); }

  function readDraft() {
    const metric = metricById(el('mon-metric').value);
    draft.metric = metric.id;
    draft.statistic = el('mon-stat').value;
    draft.scope = el('mon-scope').value;
    draft.comparator = el('mon-comparator').value;
    draft.threshold = Number(el('mon-threshold').value);
    draft.window = el('mon-window').value;
    draft.severity = el('mon-severity').value;
    draft.channel = (document.querySelector('input[name="mon-channel"]:checked') || {}).value || 'slack';
    draft.destination = el('mon-destination').value.trim();
    draft.name = el('mon-name').value.trim();
    return metric;
  }

  function syncMetric(metric, { resetThreshold }) {
    el('mon-stat').disabled = !metric.stats;
    el('mon-stat-field').classList.toggle('is-off', !metric.stats);
    el('mon-unit').textContent = metric.unit === 'rate' ? '%' : 'ms';
    el('mon-metric-help').textContent = metric.help;
    if (resetThreshold) {
      // Switching from a percentage to milliseconds leaves a threshold that is
      // valid as a number and nonsense as a rule (25ms, 5000%). Re-seeding with
      // a sane default for the new unit is the only reading that is not a trap.
      draft.threshold = metric.fallback;
      el('mon-threshold').value = String(metric.fallback);
    }
  }

  function syncChannel() {
    const slack = draft.channel === 'slack';
    el('mon-dest-label').textContent = slack ? 'Slack channel' : 'Email address';
    el('mon-destination').placeholder = slack ? '#voice-oncall' : 'oncall@yourteam.com';
    document.querySelectorAll('.mon-channel').forEach((label) => {
      label.classList.toggle('is-on', label.querySelector('input').checked);
    });
  }

  function syncSentence() {
    el('mon-sentence').textContent = sentence(draft);
    el('mon-name').placeholder = suggestedName(draft);
  }

  /* The threshold checked against the real sample, live. A number typed into a
     box means nothing until you know whether the traffic clears it, and guessing
     is how teams end up with a rule that never fires or never stops. */
  function syncLive() {
    const metric = metricById(draft.metric);
    const target = el('mon-live');
    if (!target) return;
    if (!Number.isFinite(draft.threshold) || draft.threshold < 0) {
      target.className = 'mon-live';
      target.textContent = 'Enter a threshold to see how it would behave on the sample data.';
      return;
    }
    const token = `${draft.metric}|${draft.statistic}|${draft.scope}|${draft.window}|${draft.threshold}|${draft.comparator}`;
    target.dataset.token = token;
    summaryFor(draft.window, draft.scope).then((summary) => {
      if (target.dataset.token !== token) return;
      const verdict = judge(draft, summary);
      if (verdict.state === 'no_data') {
        target.className = 'mon-live is-nodata';
        target.textContent = `No reading over ${windowById(draft.window).label} — ${verdict.reason}.`;
        return;
      }
      target.className = `mon-live is-${verdict.state}`;
      target.textContent = verdict.state === 'alerting'
        ? `This would be alerting on the sample window: ${formatValue(metric, verdict.value)} across ${verdict.calls} calls.`
        : `Quiet on the sample window: ${formatValue(metric, verdict.value)} across ${verdict.calls} calls, inside the threshold.`;
    }).catch(() => {
      if (target.dataset.token !== token) return;
      target.className = 'mon-live';
      target.textContent = 'Could not read the sample data for that window.';
    });
  }

  function validate() {
    if (!Number.isFinite(draft.threshold) || draft.threshold <= 0) return 'Give the threshold a number above zero.';
    if (draft.channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(draft.destination)) {
      return 'That does not look like an email address. Nothing is sent to it either way.';
    }
    if (draft.channel === 'slack' && !/^[#@][\w.-]{1,60}$/.test(draft.destination)) {
      return 'Slack destinations look like #voice-oncall or @yourname.';
    }
    return null;
  }

  function commit(message) {
    notify({ rules, saved: persist(rules), message });
  }

  function bindForm() {
    const form = el('mon-form');
    // Which metric the threshold box currently belongs to. It cannot be read
    // back off the draft at change time: a <select> fires `input` before
    // `change`, so the draft has already moved on and the unit switch would go
    // unnoticed — leaving a threshold of 5000 sitting under a percent sign.
    let unitOf = metricById(draft.metric).unit;

    form.addEventListener('change', (event) => {
      const metric = readDraft();
      if (event.target.id === 'mon-metric') {
        syncMetric(metric, { resetThreshold: metric.unit !== unitOf });
        unitOf = metric.unit;
      }
      if (event.target.name === 'mon-channel') {
        // Swapping channel keeps a destination that belongs to the other one,
        // which then fails validation for reasons the reader cannot see.
        const stale = (draft.channel === 'slack') === draft.destination.includes('@');
        if (stale || !draft.destination) {
          draft.destination = draft.channel === 'slack' ? '#voice-oncall' : 'oncall@yourteam.com';
          el('mon-destination').value = draft.destination;
        }
        syncChannel();
      }
      readDraft();
      syncSentence();
      syncLive();
    });

    form.addEventListener('input', (event) => {
      readDraft();
      syncSentence();
      if (event.target.id === 'mon-threshold') syncLive();
    });

    form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });
  }

  function submit() {
    readDraft();
    const problem = validate();
    const error = el('mon-error');
    error.hidden = !problem;
    error.textContent = problem || '';
    if (problem) {
      (problem.startsWith('Give') ? el('mon-threshold') : el('mon-destination')).focus();
      return;
    }
    const rule = Object.assign({}, draft, {
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: draft.name || suggestedName(draft),
      muted: false,
    });
    rules = [rule].concat(rules);
    close();
    commit({
      text: 'Saved in this browser. This is a demo dashboard — no alert is ever sent.',
      open: rule.id,
    });
  }

  /* ------------------------------------------------------------------ drawer */
  /* Composing a rule is a task, not a view. In a panel over the table the list
     the visitor is comparing against stays on screen, and the page they came to
     read does not turn into a form. */

  let opener = null;

  function drawerHtml() {
    return `
      <div class="ac-drawer-head">
        <div>
          <h2 class="ac-drawer-title" id="ac-drawer-title">New alert rule</h2>
          <p class="ac-drawer-sub">Checked against the same sample calls the dashboard reports on.
            Rules stay in this browser, and nothing is ever delivered.</p>
        </div>
        <button type="button" class="btn tiny ghost ac-drawer-close" id="mon-close">Close</button>
      </div>
      <div class="ac-drawer-body">${formHtml()}</div>
      <div class="ac-drawer-foot">
        <span class="mon-foot-note">Nothing is sent — you see the message instead.</span>
        <span class="ac-spacer"></span>
        <button type="button" class="btn" id="mon-cancel">Cancel</button>
        <button type="submit" class="btn primary" id="mon-save" form="mon-form">Save rule</button>
      </div>`;
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    // A panel over a scrim has to hold focus, or the next Tab walks into the
    // table behind it and the reader is typing into something they cannot see.
    const drawer = el('ac-drawer');
    if (!drawer) return;
    const focusable = [...drawer.querySelectorAll('button, select, input, a[href]')]
      .filter((node) => !node.disabled && node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function open(trigger) {
    if (el('ac-drawer')) return;
    opener = trigger || document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'ac-scrim';
    scrim.id = 'ac-scrim';
    scrim.addEventListener('click', () => close());
    const drawer = document.createElement('aside');
    drawer.className = 'ac-drawer';
    drawer.id = 'ac-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', 'ac-drawer-title');
    drawer.innerHTML = drawerHtml();
    document.body.append(scrim, drawer);
    // A dialog that only *claims* to be modal still lets a screen reader walk
    // the table behind it.
    document.querySelectorAll('body > .workspace, body > .demo-banner, body > .toast')
      .forEach((node) => node.setAttribute('inert', ''));
    requestAnimationFrame(() => drawer.classList.add('is-open'));
    bindForm();
    syncChannel();
    syncSentence();
    syncLive();
    el('mon-close').addEventListener('click', () => close());
    el('mon-cancel').addEventListener('click', () => close());
    document.addEventListener('keydown', onKey, true);
    el('mon-metric').focus();
  }

  function close() {
    const drawer = el('ac-drawer');
    const scrim = el('ac-scrim');
    document.querySelectorAll('[inert]').forEach((node) => node.removeAttribute('inert'));
    document.removeEventListener('keydown', onKey, true);
    if (scrim) scrim.remove();
    if (!drawer) return;
    drawer.classList.remove('is-open');
    const done = () => { if (drawer.isConnected) drawer.remove(); };
    drawer.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 340);
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }

  /* -------------------------------------------------------------- public API */

  function configure(agentList, onChange) {
    agents = agentList;
    notify = onChange || notify;
    const stored = load();
    // An unknown metric id is a rule saved by an older build. Reinterpreting it
    // as the first metric would silently change what the rule watches.
    rules = (stored || seeds(agentList)).filter((rule) => known(rule.metric));
    return rules;
  }

  function act(id, action) {
    const rule = rules.find((entry) => entry.id === id);
    if (!rule) return null;
    if (action === 'delete') {
      rules = rules.filter((entry) => entry.id !== id);
      commit({ text: 'Rule deleted.' });
      return 'deleted';
    }
    if (action === 'mute') {
      rule.muted = !rule.muted;
      commit({ text: rule.muted ? 'Muted. It stays in the list and stops alerting.' : 'Unmuted.' });
      return 'muted';
    }
    return null;
  }

  window.vaaniMonitors = {
    configure,
    list: () => rules,
    ruleById: (id) => rules.find((entry) => entry.id === id),
    verdictFor,
    row,
    detailHtml,
    hydrate,
    previewHtml,
    act,
    open,
    close,
  };
}());
