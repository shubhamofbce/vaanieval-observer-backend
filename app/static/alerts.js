/* Alerts console.
 *
 * Three questions, one viewport: what is wrong now, what is being watched, and
 * how do I add a watch of my own. The shell is fixed and only the table
 * scrolls, because a monitoring page whose count leaves the screen when you
 * scroll is not a monitoring page.
 *
 * One row per rule. The server evaluates every rule for the fleet and again for
 * each agent, so four rules arrive as twenty entries; rendered flat that reads
 * as twenty problems on a page that has four. The row carries the fleet verdict
 * and opens onto the per-agent breakdown and the recordings behind it.
 *
 * The page computes nothing about the shipped rules: the server decides what is
 * firing, so the alert read here and the number on the dashboard cannot
 * disagree by being derived twice. Rules a visitor writes are evaluated in the
 * browser (the demo takes no writes) against the same aggregate, through
 * monitors.js, which mirrors the server's confidence gates.
 */
(function () {
  const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
  const monitors = window.vaaniMonitors;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const shortId = (value) => String(value || '').slice(0, 8);
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function when(iso) {
    if (!iso) return '';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const hours = Math.round((window.vaaniNow() - at.getTime()) / 3600000);
    if (hours < 1) return 'in the last hour';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  /* What to show next to each linked call. The rule decides: an alert about
     waiting is followed by how long the caller waited, an alert about errors by
     how many broke. The same generic duration under every rule would make the
     evidence look pasted on. */
  function evidenceMetric(alert, call) {
    if (alert.rule_id === 'failed-calls') return plural(call.failed_op_count || 0, 'failure');
    if (alert.rule_id === 'blind-turns') {
      const n = call.missing_final_turns || 0;
      return n ? `${plural(n, 'turn')} untimed` : 'no timings';
    }
    return call.max_response_latency_ms ? seconds(call.max_response_latency_ms) : '—';
  }

  function callHref(sessionId, turnId) {
    const suffix = turnId ? `/turn/${encodeURIComponent(turnId)}` : '';
    return `/#/call/${encodeURIComponent(sessionId)}${suffix}`;
  }

  /* The link promises a specific set of calls, so it has to arrive narrowed to
     that set: same window, same agent, and the drill-down the alert counted
     already open. A bare dashboard would leave the reader to reconstruct which
     calls the number referred to. */
  function dashboardHref(alert, { drilldown = true } = {}) {
    const params = new URLSearchParams({ range: '7d' });
    if (alert.agent_id) params.set('agent_id', alert.agent_id);
    if (drilldown) params.set('drilldown', alert.selector);
    return `/dashboard?${params.toString()}`;
  }

  /* ------------------------------------------------------- the shipped rules */

  function shippedRows(data) {
    const byRule = new Map();
    (data.firing || []).concat(data.quiet || []).forEach((entry) => {
      if (!byRule.has(entry.rule_id)) byRule.set(entry.rule_id, []);
      byRule.get(entry.rule_id).push(entry);
    });

    return [...byRule.values()].map((entries) => {
      const fleet = entries.find((entry) => entry.scope === 'fleet');
      const agents = entries.filter((entry) => entry.scope === 'agent').sort((a, b) => (
        (a.state !== 'firing') - (b.state !== 'firing')
        || (b.excess || 0) - (a.excess || 0)
      ));
      const firingAgents = agents.filter((entry) => entry.state === 'firing');
      const blind = agents.filter((entry) => entry.state === 'unknown').length;
      // The fleet number is the honest headline when there is one. When the
      // fleet cannot be measured, the worst agent leads instead, because the
      // rule is real there even though the average absorbed it.
      const head = (fleet && fleet.state !== 'unknown') ? fleet : (firingAgents[0] || fleet || agents[0]);
      const evidence = entries.find((entry) => (entry.evidence || []).length) || head;
      const state = head.state === 'firing' ? 'alerting' : (head.state === 'ok' ? 'ok' : 'no_data');
      const measured = agents.filter((entry) => entry.state !== 'unknown').length;

      return {
        kind: 'shipped',
        id: head.rule_id,
        state,
        severity: head.severity === 'critical' ? 'critical' : 'warning',
        name: head.label,
        tag: 'Built-in',
        // The denominator is every agent, not just the measurable ones: "1 of 1"
        // when three agents could not be read is technically true and misleading.
        scopeHtml: head.scope === 'fleet'
          ? `<span class="ac-scope"><b>${firingAgents.length
              ? `${firingAgents.length} of ${agents.length} agents`
              : `All ${agents.length} agents`}</b>${blind
              ? `${blind} no reading` : 'all measured'}</span>`
          : `<span class="ac-scope"><b>${esc(head.agent_id)}</b>one agent</span>`,
        scopeText: head.scope === 'fleet'
          ? `${firingAgents.length || agents.length} of ${agents.length} agents`
          : head.agent_id,
        readingHtml: state === 'no_data'
          ? `<span class="ac-reading is-nodata">No reading — ${esc(head.reason || 'not measurable')}</span>`
          : `<span class="ac-reading"><b>${esc(head.observed_label)}</b>threshold ${esc(head.threshold_label)}</span>`,
        notifyHtml: '<span class="ac-notify is-none"><b>Demo rule</b>fixed threshold</span>',
        sort: (head.excess || 0),
        detail: () => shippedDetail(head, agents, evidence),
      };
    });
  }

  function agentRow(entry) {
    const tone = entry.state === 'firing'
      ? (entry.severity === 'critical' ? ' is-breaching' : ' is-warning')
      : (entry.state === 'unknown' ? ' is-unknown' : '');
    const value = entry.state === 'unknown' ? 'no reading' : entry.observed_label;
    const note = entry.state === 'unknown'
      ? esc(entry.reason || 'not measurable')
      : plural(entry.calls_in_range, 'call');
    return `
      <a class="ac-agent${tone}" href="${esc(dashboardHref(entry))}">
        <span class="ac-agent-value">${esc(value)}</span>
        <span class="ac-agent-id">${esc(entry.agent_id)}</span>
        <span class="ac-agent-calls">${note}</span>
      </a>`;
  }

  function shippedDetail(head, agents, evidence) {
    const calls = (evidence.evidence || []).slice(0, 4).map((call) => `
      <a class="ac-call" href="${esc(callHref(call.session_id, call.focus_turn_id))}">
        <span class="ac-call-metric">${esc(evidenceMetric(head, call))}</span>
        <span class="ac-call-id">${esc(shortId(call.session_id))}</span>
        <span class="ac-call-agent">${esc(call.agent_id || '')}</span>
        <span class="ac-call-when">${esc(when(call.started_at))}</span>
      </a>`).join('');
    return `
      <p class="ac-detail-why">${esc(head.question)}</p>
      <div class="ac-detail-grid">
        <div>
          <p class="ac-panel-title">Per agent, worst first</p>
          <div class="ac-agents">${agents.map(agentRow).join('')
            || '<p class="ac-note">Only measured fleet-wide over this window.</p>'}</div>
        </div>
        <div>
          <p class="ac-panel-title">${calls
            ? (head.scope === 'fleet' ? 'The worst calls across the fleet' : 'The calls that tripped it')
            : 'Recordings'}</p>
          ${calls ? `<div class="ac-calls">${calls}</div>` : `
            <p class="ac-note">Nothing is breaching this rule, so there are no calls to answer for.
              The dashboard link below opens the same window if you want to look anyway.</p>`}
        </div>
      </div>
      <div class="ac-detail-foot">
        <a class="ac-link" href="${esc(dashboardHref(head))}">${
          evidence.evidence_total > (evidence.evidence || []).length
            ? `See all ${evidence.evidence_total} calls on the dashboard \u2192`
            : 'Open this view on the dashboard \u2192'}</a>
        <span class="ac-spacer"></span>
        <span class="ac-note">Built-in rule · fixed thresholds in this demo</span>
      </div>`;
  }

  /* ---------------------------------------------------------------- the table */

  const STATE_ORDER = { alerting: 0, ok: 1, no_data: 2, muted: 3 };
  const STATE_LABEL = { alerting: 'Alerting', ok: 'OK', no_data: 'No data', muted: 'Muted' };

  let rows = [];
  let filter = 'all';
  let openRow = null;

  function chevron() {
    return `<span class="ac-chev" aria-hidden="true"><svg viewBox="0 0 16 16" width="13" height="13"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M6 3.5 10.5 8 6 12.5"/></svg></span>`;
  }

  function stateChip(row) {
    const tone = row.state === 'alerting' && row.severity !== 'critical' ? 'is-warning' : `is-${row.state.replace('_', '')}`;
    return `<span class="ac-state ${tone}">${STATE_LABEL[row.state]}</span>`;
  }

  /* The row is one control, so it needs one sentence. Left to itself a screen
     reader reads six unlabelled cells in a run. */
  function rowLabel(row) {
    const reading = String(row.readingHtml).replace(/<\/b>/g, ', ').replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return `${row.name}. ${STATE_LABEL[row.state]}. ${reading}. `
      + `${row.scopeText || row.scope}. ${row.tag} rule. Expand for the agents and calls behind it.`;
  }

  function rowHtml(row) {
    const warm = row.state === 'alerting' && row.severity !== 'critical' ? ' is-warning' : '';
    return `
      <div class="ac-row${row.state === 'alerting' ? ' is-alerting' : ''}${warm}${row.state === 'muted' ? ' is-muted' : ''}"
        data-key="${esc(row.kind)}:${esc(row.id)}">
        <button type="button" class="ac-row-main" aria-expanded="false"
          aria-label="${esc(rowLabel(row))}"
          aria-controls="d-${esc(row.kind)}-${esc(row.id)}">
          ${stateChip(row)}
          <span class="ac-name">
            <span class="ac-name-text">${esc(row.name)}</span>
            <span class="ac-tag${row.kind === 'yours' ? ' is-yours' : ''}">${esc(row.tag)}</span>
          </span>
          ${row.scopeHtml || `<span class="ac-scope"><b>${esc(row.scope)}</b>${
            row.kind === 'yours' ? 'watched by your rule' : ''}</span>`}
          ${row.readingHtml}
          ${row.notifyHtml || `<span class="ac-notify">${esc(row.notify)}</span>`}
          ${chevron()}
        </button>
        <div class="ac-detail" id="d-${esc(row.kind)}-${esc(row.id)}" hidden></div>
      </div>`;
  }

  function counts() {
    return rows.reduce((acc, row) => {
      const key = row.state === 'muted' ? 'muted' : row.state;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }

  function chip(id, label, tone, n) {
    return `
      <button type="button" class="ac-chip ${tone}" data-filter="${id}" aria-pressed="${filter === id}">
        <span class="ac-dot"></span>${label}<b>${n}</b>
      </button>`;
  }

  function paint() {
    const n = counts();
    document.getElementById('ac-chips').innerHTML = [
      chip('all', 'All rules', '', rows.length),
      chip('alerting', 'Firing in sample', 'is-alerting', n.alerting || 0),
      chip('ok', 'OK', 'is-ok', n.ok || 0),
      chip('no_data', 'No data', 'is-nodata', n.no_data || 0),
      chip('muted', 'Muted', 'is-muted', n.muted || 0),
    ].join('');

    const visible = rows
      .filter((row) => filter === 'all' || row.state === filter)
      .sort((a, b) => (
        STATE_ORDER[a.state] - STATE_ORDER[b.state]
        || (a.severity === 'critical' ? 0 : 1) - (b.severity === 'critical' ? 0 : 1)
        || (b.sort || 0) - (a.sort || 0)
        || a.name.localeCompare(b.name)
      ));

    const headline = document.getElementById('ac-headline');
    if (headline) {
      headline.textContent = (n.alerting || 0)
        ? `${n.alerting} of ${rows.length} rules are firing on this frozen sample of 30 calls.`
        : `All ${rows.length} rules are inside their thresholds on this frozen sample.`;
    }

    const table = document.getElementById('ac-rows');
    if (!visible.length) {
      table.innerHTML = `
        <div class="ac-empty">
          <p>No rules are <b>${esc((STATE_LABEL[filter] || filter).toLowerCase())}</b> on this sample.</p>
          <button type="button" class="btn tiny" data-filter="all">Show all ${rows.length} rules</button>
        </div>`;
      return;
    }
    // A divider where the firing rules end. With the count in the header this is
    // what tells the reader the rest of the list is the answer to "and what else
    // is being watched", rather than more problems.
    const firing = visible.filter((row) => row.state === 'alerting');
    const rest = visible.filter((row) => row.state !== 'alerting');
    table.innerHTML = (firing.length ? firing.map(rowHtml).join('') : '')
      + (firing.length && rest.length ? '<p class="ac-group">Quiet — watched, inside its threshold</p>' : '')
      + rest.map(rowHtml).join('');

    if (openRow) {
      const node = table.querySelector(`[data-key="${CSS.escape(openRow)}"]`);
      if (node) expand(node, true);
    }
  }

  function expand(node, on) {
    const button = node.querySelector('.ac-row-main');
    const panel = node.querySelector('.ac-detail');
    node.classList.toggle('is-open', on);
    button.setAttribute('aria-expanded', String(on));
    panel.hidden = !on;
    if (!on) { panel.innerHTML = ''; return; }
    const [kind, id] = node.dataset.key.split(':');
    const row = rows.find((entry) => entry.kind === kind && String(entry.id) === id);
    if (row) {
      panel.innerHTML = row.detail();
      if (kind === 'yours') {
        const rule = monitors.ruleById(id);
        if (rule) monitors.hydrate(rule, panel);
      }
    }
    // Opening a row near the bottom of the list would otherwise put its evidence
    // below the fold with nothing to say it is there.
    requestAnimationFrame(() => node.scrollIntoView({ block: 'nearest' }));
  }

  function toast(message) {
    const node = document.getElementById('toast');
    if (!node || !message) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { node.hidden = true; }, 5200);
  }

  /* ----------------------------------------------------------- visitor rules */

  function yourRows(list) {
    return list.map((rule) => {
      const row = monitors.row(rule, rule._verdict || { state: 'no_data', reason: 'reading…' });
      return Object.assign(row, {
        kind: 'yours',
        detail: () => monitors.detailHtml(rule, rule._verdict || { state: 'no_data', reason: 'reading…' }),
      });
    });
  }

  function refreshYours(list, { open } = {}) {
    rows = rows.filter((row) => row.kind !== 'yours').concat(yourRows(list));
    if (open) openRow = `yours:${open}`;
    paint();
    // Each rule's reading resolves on its own. Waiting for all of them before
    // drawing anything would show an empty table for as long as the slowest
    // window takes.
    list.forEach((rule) => {
      monitors.verdictFor(rule).then((verdict) => {
        rule._verdict = verdict;
        rows = rows.filter((row) => row.kind !== 'yours').concat(yourRows(list));
        paint();
      });
    });
  }

  /* ------------------------------------------------------------------- mount */

  function shell(data) {
    const generated = data.range && data.range.to_ms;
    return `
      <div class="ac">
        <header class="ac-head">
          <div class="ac-head-row">
            <div>
              <h1 class="ac-title">Alerts</h1>
              <p class="ac-sub"><b id="ac-headline"></b> Every rule is evaluated against the same
                calls the dashboard reports on. Open one to see the agents behind the number and the
                recordings that tripped it.</p>
            </div>
            <div class="ac-head-actions">
              <button type="button" class="btn primary" id="ac-new">New alert rule</button>
            </div>
          </div>
        </header>
        <div class="ac-bar">
          <div class="ac-chips" id="ac-chips"></div>
          <span class="ac-bar-note" title="Rules you create are evaluated in your browser and stored there.">
            <span class="ac-dot" aria-hidden="true"></span>Nothing is ever delivered — rules you add
            stay in this browser</span>
        </div>
        <div class="ac-scroll">
          <div class="ac-table">
            <div class="ac-thead" aria-hidden="true">
              <span>Status</span><span>Rule</span><span>Scope</span><span>Reading</span>
              <span class="ac-th-notify">Notifies</span><span></span>
            </div>
            <div id="ac-rows"></div>
          </div>
        </div>
      </div>`;
  }

  function bind() {
    const main = document.getElementById('alerts-body');

    document.getElementById('ac-new').addEventListener('click', (event) => {
      monitors.open(event.currentTarget);
    });

    document.getElementById('ac-chips').addEventListener('click', (event) => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      filter = button.dataset.filter;
      paint();
    });

    main.addEventListener('click', (event) => {
      const reset = event.target.closest('.ac-empty [data-filter]');
      if (reset) { filter = reset.dataset.filter; paint(); return; }
      const action = event.target.closest('button[data-act]');
      if (action) {
        const node = action.closest('[data-key]');
        const id = node.dataset.key.split(':')[1];
        const rule = monitors.ruleById(id);
        if (!rule) return;
        if (action.dataset.act === 'test') {
          const slot = node.querySelector(`[data-preview]`);
          monitors.verdictFor(rule).then((verdict) => {
            slot.innerHTML = monitors.previewHtml(rule, verdict);
          });
          return;
        }
        if (action.dataset.act === 'delete' && openRow === node.dataset.key) openRow = null;
        monitors.act(id, action.dataset.act);
        return;
      }
      const head = event.target.closest('.ac-row-main');
      if (!head) return;
      const node = head.closest('.ac-row');
      const on = head.getAttribute('aria-expanded') !== 'true';
      // One open row. Two expanded rows push the second one's evidence off the
      // screen, which is the scrolling this page exists to avoid.
      main.querySelectorAll('.ac-row.is-open').forEach((other) => {
        if (other !== node) expand(other, false);
      });
      openRow = on ? node.dataset.key : null;
      expand(node, on);
    });
  }

  /* The agents the fleet actually has. Taken from the alert payload rather than
     fetched again: the server already evaluated every rule per agent, so this
     list cannot drift from the one the rules were measured against. */
  function agentIds(data) {
    const ids = (data.firing || []).concat(data.quiet || [])
      .map((entry) => entry.agent_id).filter(Boolean);
    return [...new Set(ids)].sort();
  }

  function start(data) {
    document.getElementById('alerts-body').innerHTML = shell(data);
    rows = shippedRows(data);
    bind();
    paint();
    const list = monitors.configure(agentIds(data), (change) => {
      refreshYours(change.rules, { open: change.message && change.message.open });
      if (change.message) {
        toast(change.saved
          ? change.message.text
          : 'This browser will not store the rule (private mode?). It is shown for this visit only.');
      }
    });
    refreshYours(list);
  }

  function failed(error) {
    document.getElementById('alerts-body').innerHTML = `
      <div class="ac"><div class="ac-scroll"><div class="ac-table">
        <div class="ac-empty">
          <p>The alert rules could not be read from the demo data.
            <span class="ac-note">${esc(error.message || error)}</span></p>
          <button type="button" class="btn tiny" id="ac-retry">Try again</button>
        </div>
      </div></div></div>`;
    document.getElementById('ac-retry').addEventListener('click', () => window.location.reload());
  }

  const to = window.vaaniNow();
  fetch(`/v1/alerts?from_ms=${to - WINDOW_MS}&to_ms=${to}`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(start)
    .catch(failed);
}());
