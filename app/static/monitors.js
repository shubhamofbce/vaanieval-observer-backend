/* Alert rules a visitor writes themselves.
 *
 * The four rules above this section are fixed, and a monitoring page you cannot
 * touch is a screenshot. So this section is the other half: pick a signal, put a
 * line under it, say where the message goes. It is the flow an engineer already
 * knows from Datadog, kept to the four decisions that matter.
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
        id: 'seed-wait', example: true, name: 'Worst-case reply wait over 8s',
        metric: 'reply_wait', statistic: 'p95', comparator: 'above', threshold: 8000,
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

  function save(rules) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(rules));
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

  function drilldownHref(rule) {
    const metric = metricById(rule.metric);
    const params = new URLSearchParams({ range: rule.window });
    if (rule.scope) params.set('agent_id', rule.scope);
    params.set('drilldown', metric.selector);
    return `/dashboard?${params.toString()}`;
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
            <label class="mon-field">
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
          <p class="mon-help">Priority travels with the message so the receiving channel can route it.
            It changes nothing else here, and the window is evaluated against the published sample,
            not a live clock.</p>
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
            <label class="mon-field mon-grow">
              <span id="mon-dest-label">${draft.channel === 'slack' ? 'Slack channel' : 'Email address'}</span>
              <input id="mon-destination" type="text" value="${esc(draft.destination)}"
                placeholder="${draft.channel === 'slack' ? '#voice-oncall' : 'oncall@yourteam.com'}"
                autocomplete="off" spellcheck="false">
            </label>
          </div>
          <p class="mon-help">Nothing is delivered from this demo. Saving a rule shows you the message
            that would have been sent, and keeps the rule in this browser only.</p>
        </fieldset>

        <fieldset class="mon-step">
          <legend><span class="mon-step-n">4</span> Name it and save</legend>
          <div class="mon-row">
            <label class="mon-field mon-grow">
              <span>Rule name</span>
              <input id="mon-name" type="text" value="${esc(draft.name)}" autocomplete="off"
                placeholder="${esc(suggestedName(draft))}">
            </label>
          </div>
          <p class="mon-sentence" id="mon-sentence">${esc(sentence(draft))}</p>
          <p class="mon-error" id="mon-error" role="alert" hidden></p>
          <div class="mon-actions">
            <button type="submit" class="btn primary" id="mon-save">Save rule</button>
            <button type="button" class="btn ghost" id="mon-reset">Reset</button>
          </div>
        </fieldset>
      </form>`;
  }

  /* ------------------------------------------------------------------- list */

  function stateChip(verdict) {
    if (verdict.state === 'alerting') return '<span class="mon-state is-alerting">Alerting</span>';
    if (verdict.state === 'ok') return '<span class="mon-state is-ok">OK</span>';
    return '<span class="mon-state is-nodata">No data</span>';
  }

  function ruleCard(rule, verdict) {
    const metric = metricById(rule.metric);
    const reading = verdict.state === 'no_data'
      ? `Nothing to measure — ${esc(verdict.reason)}`
      : `Sample window: ${esc(formatValue(metric, verdict.value))} across ${verdict.calls} call${verdict.calls === 1 ? '' : 's'}
         · alerts ${rule.comparator === 'below' ? 'under' : 'over'} ${esc(thresholdLabel(metric, rule.threshold))}`;
    return `
      <article class="mon-rule${rule.muted ? ' is-muted' : ''}${verdict.state === 'alerting' && !rule.muted ? ' is-alerting' : ''}"
        data-id="${esc(rule.id)}">
        <div class="mon-rule-top">
          ${rule.muted ? '<span class="mon-state is-muted">Muted</span>' : stateChip(verdict)}
          <h3 class="mon-rule-name">${esc(rule.name)}</h3>
          ${rule.example ? '<span class="mon-tag">Example</span>' : ''}
          <span class="mon-rule-sev">${rule.severity === 'critical' ? 'Critical' : 'Warning'}</span>
        </div>
        <p class="mon-rule-sentence">${esc(sentence(rule))}</p>
        <p class="mon-rule-reading">${reading}</p>
        <div class="mon-rule-actions">
          ${verdict.state === 'no_data'
            ? '<span class="mon-link is-off">No eligible calls to open</span>'
            : `<a class="mon-link" href="${esc(drilldownHref(rule))}">${metric.byStage
              ? 'See the slowest calls in this window \u2192'
              : 'See these calls \u2192'}</a>`}
          <button type="button" class="btn tiny" data-act="test">Preview the message</button>
          <button type="button" class="btn tiny" data-act="mute">${rule.muted ? 'Unmute' : 'Mute'}</button>
          <button type="button" class="btn tiny" data-act="delete">Delete</button>
        </div>
      </article>`;
  }

  /* What the alert would look like where it lands. This is the part a visitor is
     actually buying, and it is also where the demo has to be unambiguous: the
     preview says in its own words that it was not sent. */
  function preview(rule, verdict) {
    const metric = metricById(rule.metric);
    const value = verdict.state === 'no_data' ? 'no reading yet' : formatValue(metric, verdict.value);
    const title = `${rule.severity === 'critical' ? '[CRITICAL]' : '[WARNING]'} ${rule.name}`;
    const body = `${metric.label}${metric.stats ? ` (${rule.statistic})` : ''} is ${value} for `
      + `${rule.scope || 'all agents'} over ${windowById(rule.window).label}, `
      + `${rule.comparator === 'below' ? 'under' : 'over'} the ${thresholdLabel(metric, rule.threshold)} threshold.`;
    const wrap = document.getElementById('mon-preview');
    wrap.innerHTML = `
      <div class="mon-preview-card is-${esc(rule.channel)}">
        <div class="mon-preview-head">
          <span class="mon-preview-where">${rule.channel === 'slack'
            ? `Slack · ${esc(rule.destination)}`
            : `Email · to ${esc(rule.destination)}`}</span>
          <button type="button" class="btn tiny ghost" id="mon-preview-close">Close</button>
        </div>
        <p class="mon-preview-title">${esc(title)}</p>
        <p class="mon-preview-body">${esc(body)}</p>
        <p class="mon-preview-link">vaanieval.com/dashboard → the calls behind it</p>
        <p class="mon-preview-note">This is a demo dashboard. No alert was sent, and no address or
          channel you type here leaves your browser.</p>
      </div>`;
    wrap.hidden = false;
    document.getElementById('mon-preview-close').addEventListener('click', () => { wrap.hidden = true; });
    wrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ------------------------------------------------------------------- wiring */

  let rules = [];

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
     box means nothing until you know whether today's traffic clears it, and
     guessing is how teams end up with a rule that never fires or never stops. */
  function syncLive() {
    const metric = metricById(draft.metric);
    const target = el('mon-live');
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

  function renderList() {
    const wrap = el('mon-list');
    if (!rules.length) {
      wrap.innerHTML = `
        <div class="mon-empty">
          <p><b>No rules of your own yet.</b> Build one above — it is evaluated against the same
            sample calls the dashboard reports on, so you will see straight away whether it
            would be alerting.</p>
        </div>`;
      el('mon-count').textContent = '';
      return;
    }
    el('mon-count').textContent = `${rules.length} rule${rules.length === 1 ? '' : 's'} in this browser`;    // Render the cards first with whatever is known, then fill each reading in
    // as its window resolves: a list that waits for four fetches before showing
    // anything reads as broken.
    wrap.innerHTML = rules.map((rule) => ruleCard(rule, { state: 'no_data', reason: 'reading…' })).join('');
    rules.forEach((rule) => {
      summaryFor(rule.window, rule.scope)
        .then((summary) => judge(rule, summary))
        .catch(() => ({ state: 'no_data', reason: 'could not read the sample data' }))
        .then((verdict) => {
          const card = wrap.querySelector(`[data-id="${CSS.escape(rule.id)}"]`);
          if (!card) return;
          card.outerHTML = ruleCard(rule, verdict);
          rule._verdict = verdict;
        });
    });
  }

  function commit() {
    if (!save(rules)) {
      const error = el('mon-error');
      error.hidden = false;
      error.textContent = 'This browser will not let the demo store the rule (private mode?). It is still shown below for this visit.';
    }
    renderList();
  }

  function toast(message) {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { node.hidden = true; }, 5200);
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

    form.addEventListener('submit', (event) => {
      event.preventDefault();
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
      commit();
      toast('Saved in this browser. This is a demo dashboard — no alert is ever sent.');
      summaryFor(rule.window, rule.scope)
        .then((summary) => preview(rule, judge(rule, summary)))
        .catch(() => preview(rule, { state: 'no_data', reason: 'no reading', calls: 0 }));
    });

    el('mon-reset').addEventListener('click', () => {
      form.reset();
      readDraft();
      const metric = metricById(draft.metric);
      unitOf = metric.unit;
      syncMetric(metric, { resetThreshold: false });
      syncChannel();
      syncSentence();
      syncLive();
      el('mon-error').hidden = true;
    });
  }

  function bindList() {
    el('mon-list').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-act]');
      if (!button) return;
      const id = button.closest('[data-id]').dataset.id;
      const rule = rules.find((entry) => entry.id === id);
      if (!rule) return;
      if (button.dataset.act === 'delete') {
        rules = rules.filter((entry) => entry.id !== id);
        commit();
        toast('Rule deleted.');
        return;
      }
      if (button.dataset.act === 'mute') {
        rule.muted = !rule.muted;
        commit();
        return;
      }
      summaryFor(rule.window, rule.scope)
        .then((summary) => preview(rule, judge(rule, summary)))
        .catch(() => preview(rule, { state: 'no_data', reason: 'no reading', calls: 0 }));
    });
  }

  function mount(facetAgents) {
    agents = facetAgents;
    const stored = load();
    rules = (stored || seeds(facetAgents)).filter((rule) => known(rule.metric));
    const host = document.getElementById('monitors');
    if (!host) return;
    host.innerHTML = `
      <h2 class="alerts-section-title" id="your-rules">Your own alert rules</h2>
      <p class="mon-intro">The four rules above ship with the demo. These are yours: pick a signal, put a
        line under it, choose where the message lands. Rules are checked against the same sample
        calls, and stay in this browser — <b>nothing is ever sent, and no address you type leaves
        this page</b>.</p>
      ${formHtml()}
      <div class="mon-preview" id="mon-preview" hidden></div>
      <div class="mon-list-head">
        <h3 class="mon-list-title">Rules you have set up</h3>
        <span class="mon-count" id="mon-count"></span>
      </div>
      <div class="mon-list" id="mon-list"></div>`;
    bindForm();
    bindList();
    syncChannel();
    syncSentence();
    syncLive();
    renderList();
  }

  window.vaaniMonitors = { mount };
}());
