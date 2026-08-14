/* Alerts.
 *
 * The page renders one ranked list of breaches and one quiet list of the rules
 * that are holding. It computes nothing: the server decides what is firing, so
 * the alert a visitor reads here and the number they see on the dashboard can
 * never disagree by being derived twice from different code.
 */
(function () {
  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function shortId(value) {
    return String(value || '').slice(0, 8);
  }

  function when(iso) {
    if (!iso) return '';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const delta = window.vaaniNow() - at.getTime();
    const hours = Math.round(delta / 3600000);
    if (hours < 1) return 'in the last hour';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function seconds(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  function scopeLabel(alert) {
    return alert.scope === 'fleet' ? 'All agents' : alert.agent_id;
  }

  /* What to show next to each linked call. The rule decides: an alert about
     waiting is followed by how long the caller waited, an alert about errors by
     how many broke. Showing the same generic duration under every rule would
     make the evidence look pasted on. */
  function evidenceMetric(alert, call) {
    if (alert.rule_id === 'failed-calls') {
      const n = call.failed_op_count || 0;
      return `${n} failure${n === 1 ? '' : 's'}`;
    }
    if (alert.rule_id === 'blind-turns') {
      const n = call.missing_final_turns || 0;
      return n ? `${n} turn${n === 1 ? '' : 's'} untimed` : 'no timings';
    }
    return call.max_response_latency_ms ? seconds(call.max_response_latency_ms) : '—';
  }

  function callHref(sessionId, turnId) {
    const suffix = turnId ? `/turn/${encodeURIComponent(turnId)}` : '';
    return `/#/call/${encodeURIComponent(sessionId)}${suffix}`;
  }

  function dashboardHref(alert, { drilldown = true } = {}) {
    // The link promises a specific set of calls, so it has to arrive narrowed
    // to that set: same window, same agent, and the drill-down the alert
    // counted already open. Landing on a bare dashboard would leave the reader
    // to reconstruct which calls the number referred to.
    const params = new URLSearchParams({ range: '7d' });
    if (alert.agent_id) params.set('agent_id', alert.agent_id);
    if (drilldown) params.set('drilldown', alert.selector);
    return `/dashboard?${params.toString()}`;
  }

  /* One finding, one card.
   *
   * The server evaluates every rule for the fleet and again for each agent, so
   * a single problem arrives as up to five entries. Rendered flat that reads as
   * five problems, and the reader has to work out that four of them are the
   * same one seen from a different angle. Grouping by rule puts the finding
   * once, with the agents it touches ranked underneath - which is also the
   * order someone would work them in.
   */
  function group(firing) {
    const byRule = new Map();
    firing.forEach((alert) => {
      if (!byRule.has(alert.rule_id)) byRule.set(alert.rule_id, []);
      byRule.get(alert.rule_id).push(alert);
    });
    return [...byRule.values()].map((entries) => {
      // The fleet number leads when there is one: it is the honest headline.
      // Otherwise the worst agent is the headline, because the rule is real
      // there even though the fleet average absorbed it.
      const fleet = entries.find((entry) => entry.scope === 'fleet');
      const agents = entries
        .filter((entry) => entry.scope === 'agent')
        .sort((a, b) => (b.excess || 0) - (a.excess || 0));
      return { head: fleet || agents[0], agents, fleetWide: Boolean(fleet) };
    }).sort((a, b) => (
      (a.head.severity !== 'critical') - (b.head.severity !== 'critical')
      || (b.head.excess || 0) - (a.head.excess || 0)
    ));
  }

  /* Agents whose calls are in the evidence but which have no per-agent row.
     Without a word of explanation this reads as the page contradicting itself:
     a channel named in every linked call, absent from the list of channels
     breaching the rule. */
  function missing(item) {
    const listed = new Set(item.agents.map((entry) => entry.agent_id));
    const seen = (item.head.evidence || []).map((call) => call.agent_id).filter(Boolean);
    return [...new Set(seen)].filter((id) => !listed.has(id));
  }

  function agentRow(alert) {
    return `
      <a class="alert-agent" href="${esc(dashboardHref(alert))}">
        <span class="alert-agent-value">${esc(alert.observed_label)}</span>
        <span class="alert-agent-id">${esc(alert.agent_id)}</span>
        <span class="alert-agent-calls">${alert.calls_in_range} calls</span>
      </a>`;
  }

  function alertCard(item) {
    const alert = item.head;
    const tone = alert.severity === 'critical' ? 'is-critical' : 'is-warning';
    const shown = item.fleetWide ? item.agents : item.agents.slice(1);
    const calls = (alert.evidence || []).map((call) => `
      <a class="alert-call" href="${esc(callHref(call.session_id, call.focus_turn_id))}">
        <span class="alert-call-metric">${esc(evidenceMetric(alert, call))}</span>
        <span class="alert-call-id">${esc(shortId(call.session_id))}</span>
        <span>${esc(call.agent_id || '')}</span>
        <span class="alert-call-when">${esc(when(call.started_at))}</span>
      </a>`).join('');
    return `
      <article class="alert ${tone}">
        <div class="alert-top">
          <span class="alert-badge ${tone}">${alert.severity === 'critical' ? 'Critical' : 'Warning'}</span>
          <h3 class="alert-label">${esc(alert.label)}</h3>
          <span class="alert-scope">${esc(scopeLabel(alert))}</span>
        </div>
        <p class="alert-why">${esc(alert.question)}</p>
        <div class="alert-numbers">
          <span class="alert-observed">${esc(alert.observed_label)}</span>
          <span class="alert-threshold">alerts ${esc(alert.threshold_label)} · ${alert.calls_in_range} calls in range</span>
        </div>
        ${shown.length ? `
          <div class="alert-agents">
            <p class="alert-evidence-title">${item.fleetWide
              ? 'Also breaching on its own numbers'
              : shown.length === 1 ? 'The agent breaching it' : 'Agents breaching it, worst first'}</p>
            ${shown.map(agentRow).join('')}
            ${missing(item).map((id) => `<p class="alert-agent-missing">${esc(id)} is not listed
              here — too few measured turns for a number of its own, so it appears under Holding.</p>`).join('')}
          </div>` : ''}
        <div class="alert-evidence">
          <p class="alert-evidence-title">${alert.scope === 'fleet'
            ? 'The worst calls across the fleet'
            : 'The calls that tripped it'}</p>
          <div class="alert-calls">${calls}</div>
          <a class="alert-more" href="${esc(dashboardHref(alert))}">${
            alert.evidence_total > (alert.evidence || []).length
              ? `See all ${alert.evidence_total} calls on the dashboard →`
              : 'Open this view on the dashboard →'
          }</a>
        </div>
      </article>`;
  }

  function quietRow(alert) {
    const value = alert.state === 'unknown'
      ? `<b>not measurable</b> · ${esc(alert.reason || 'no data')}`
      : `<b>${esc(alert.observed_label || 'ok')}</b> · alerts ${esc(alert.threshold_label)}`;
    return `
      <div class="alert-quiet">
        <span class="alert-quiet-label">${esc(alert.label)}</span>
        <span class="alert-quiet-scope">${esc(scopeLabel(alert))}</span>
        <span class="alert-quiet-value${alert.state === 'unknown' ? ' is-unknown' : ''}">${value}</span>
      </div>`;
  }

  function render(data) {
    const body = document.getElementById('alerts-body');
    const findings = group(data.firing || []);
    const quiet = data.quiet || [];
    const critical = findings.filter((f) => f.head.severity === 'critical').length;
    body.innerHTML = `
      <header class="alerts-head">
        <h1 class="alerts-title">Alerts</h1>
        <p class="alerts-sub">Every rule below is evaluated against the same calls the dashboard
          reports on, over the last 7 days of the sample window. An alert links to the
          recordings that tripped it, so you can hear the problem rather than take the
          number on trust.</p>
        <span class="alerts-count${findings.length ? ' is-firing' : ''}">
          <b>${findings.length}</b> firing${critical ? ` · <b>${critical}</b> critical` : ''}
        </span>
      </header>
      ${findings.length ? `
        <h2 class="alerts-section-title">Firing now</h2>
        ${findings.map(alertCard).join('')}` : `
        <div class="alerts-empty">Nothing is breaching. Every rule below is inside its threshold.</div>`}
      <h2 class="alerts-section-title">Holding</h2>
      ${quiet.map(quietRow).join('')}
      <p class="alerts-note">These four rules ship with the demo and cannot be edited or acknowledged
        here. <a href="#your-rules">Write your own below</a> — same data, your thresholds, your
        channel — or take the whole thing into a deployment you own.</p>`;
  }

  /* The agents the fleet actually has. Taken from the alert payload rather than
     fetched again: the server already evaluated every rule per agent, so this
     list cannot drift from the one the rules above were measured against. */
  function agentIds(data) {
    const ids = (data.firing || []).concat(data.quiet || [])
      .map((entry) => entry.agent_id)
      .filter(Boolean);
    return [...new Set(ids)].sort();
  }

  function failed(error) {
    document.getElementById('alerts-body').innerHTML = `
      <div class="alerts-empty">Could not load alerts. ${esc(error.message || error)}</div>`;
  }

  const to = window.vaaniNow();
  fetch(`/v1/alerts?from_ms=${to - WINDOW_MS}&to_ms=${to}`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      render(data);
      if (window.vaaniMonitors) window.vaaniMonitors.mount(agentIds(data));
    })
    .catch(failed);
}());
