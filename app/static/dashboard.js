/* Aggregate dashboard.
 *
 * Design rules this file enforces, because they are what separate a dashboard a
 * developer trusts from one they learn to ignore:
 *
 *   1. A missing measurement renders as the reason it is missing, never as 0.
 *      A zero is a claim; "this SDK build did not record the milestone" is the
 *      truth. Painting the second as the first is how a dashboard teaches
 *      people it is lying.
 *   2. Every number carries its sample size, and a percentile below the
 *      server's confidence threshold is rendered muted with the count visible.
 *   3. Every number is clickable and lands on the calls behind it, and each of
 *      those rows deep links into the existing console at the offending turn.
 *      A metric you cannot open is trivia.
 *   4. Colour is reserved for things that are wrong. If everything is coloured,
 *      nothing is.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ const

  const RANGES = [
    { id: '1h', label: 'Last hour', ms: 3600e3 },
    { id: '6h', label: 'Last 6 hours', ms: 6 * 3600e3 },
    { id: '24h', label: 'Last 24 hours', ms: 24 * 3600e3 },
    { id: '7d', label: 'Last 7 days', ms: 7 * 864e5 },
    { id: '30d', label: 'Last 30 days', ms: 30 * 864e5 },
    { id: '90d', label: 'Last 90 days', ms: 90 * 864e5 },
  ];
  const DEFAULT_RANGE = '7d';

  const FACETS = [
    { key: 'agent_id', label: 'Agent', all: 'All agents' },
    { key: 'provider', label: 'Provider', all: 'All providers' },
    { key: 'model', label: 'Model', all: 'All models' },
    { key: 'sdk_language', label: 'SDK', all: 'All SDKs' },
    { key: 'environment', label: 'Environment', all: 'All environments' },
    { key: 'agent_version', label: 'Version', all: 'All versions' },
  ];

  const STAGE_ORDER = ['stt', 'llm', 'tool', 'tts'];
  const STAGE_COLOR = { stt: 'var(--stt)', llm: 'var(--llm)', tool: 'var(--tool)', tts: 'var(--tts)' };
  // Below this share of its stage's turns, a metric describes a different
  // population from its neighbours and must not be read as comparable to them.
  const LOW_COVERAGE_RATIO = 0.5;

  // Lower is better for every latency metric we publish, so a rise is bad. Rate
  // metrics are handled separately because "more failures" is bad but "more
  // calls" is not.
  const REASON_TEXT = {
    not_captured_by_sdk: 'Not captured by the SDKs in this range',
    no_eligible_turns: 'No turns in range produced this stage',
    milestone_not_captured: 'The SDK build did not record the milestone this needs',
    not_independently_observed: 'Start and end came from one event',
    speech_onset_not_observed: 'No word timestamps, so the first word is unknown',
    below_minimum_sample: 'Too few samples to report',
    stage_absent: 'No operations of this stage in range',
    no_previous_period: 'No comparable previous period',
    range_too_large_for_filter: 'Range too large to answer exactly with this filter',
  };

  const state = {
    range: DEFAULT_RANGE,
    filters: {},
    data: null,
    loading: false,
    error: null,
    reqId: 0,
  };

  // ------------------------------------------------------------------ utils

  const $ = (sel) => document.querySelector(sel);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* Latency is read at a glance, so the unit switches at the point where the
     extra digits stop carrying information: nobody acts on the difference
     between 4,317 ms and 4,318 ms, but everybody acts on 4.3 s vs 11 s. */
  function ms(value) {
    if (value == null || !Number.isFinite(value)) return { text: '—', unit: '' };
    // A rendered "0 ms" is indistinguishable from an unmeasured zero, which is
    // the one confusion this dashboard promises never to cause. Capture is at
    // millisecond resolution, so a recorded 0 means "shorter than the clock can
    // see", and that is what it should say.
    if (value >= 0 && value < 0.5) return { text: '<1', unit: 'ms' };
    if (value < 1000) return { text: String(Math.round(value)), unit: 'ms' };
    const seconds = value / 1000;
    return { text: seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1), unit: 's' };
  }

  function msText(value) {
    const parts = ms(value);
    return parts.unit ? `${parts.text} ${parts.unit}` : parts.text;
  }

  function pct(rate, digits) {
    if (rate == null || !Number.isFinite(rate)) return '—';
    const value = rate * 100;
    const d = digits != null ? digits : (value > 0 && value < 1 ? 2 : value < 10 ? 1 : 0);
    return `${value.toFixed(d)}%`;
  }

  function count(value) {
    if (value == null) return '—';
    return Number(value).toLocaleString();
  }

  /* Bucket widths are read as "how wide is one point on this chart", so they
     want human units, not the 1440m that `duration` would produce. */
  function spanLabel(msValue) {
    if (!msValue) return '';
    const minutes = msValue / 60000;
    if (minutes < 60) return `${Math.round(minutes)} min`;
    const hours = minutes / 60;
    if (hours < 24) return `${hours % 1 ? hours.toFixed(1) : hours} hour${hours === 1 ? '' : 's'}`;
    const days = hours / 24;
    return `${days % 1 ? days.toFixed(1) : days} day${days === 1 ? '' : 's'}`;
  }

  function duration(msValue) {
    if (!msValue && msValue !== 0) return '—';
    const total = Math.round(msValue / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  }

  function clockLabel(epoch, span) {
    const d = new Date(epoch);
    if (span <= 36 * 3600e3) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function stamp(epoch) {
    return new Date(epoch).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function reasonText(reason) {
    if (!reason) return 'Not available';
    return REASON_TEXT[reason] || reason.replace(/_/g, ' ');
  }

  function rangeMs() {
    const found = RANGES.find((r) => r.id === state.range);
    return (found || RANGES[3]).ms;
  }

  function activeParams() {
    const params = new URLSearchParams();
    const to = window.vaaniNow();
    params.set('from_ms', String(to - rangeMs()));
    params.set('to_ms', String(to));
    Object.entries(state.filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return params;
  }

  /* The drill-down must be answered against the exact window the panel was
     computed for, not "now minus the range" a few seconds later — otherwise the
     KPI says 5 calls and the list that opens shows 4. */
  function frozenParams() {
    const params = new URLSearchParams();
    const range = (state.data && state.data.range) || {};
    params.set('from_ms', String(range.from_ms != null ? range.from_ms : window.vaaniNow() - rangeMs()));
    params.set('to_ms', String(range.to_ms != null ? range.to_ms : window.vaaniNow()));
    Object.entries(state.filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return params;
  }

  function toast(message, tone) {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast${tone ? ` ${tone}` : ''}`;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  // ------------------------------------------------------------- components

  function info(text) {
    return `<span class="info" tabindex="0" data-tip="${esc(text)}" role="img" aria-label="${esc(text)}">i</span>`;
  }

  function sampleLabel(n, noun) {
    if (n == null) return '';
    // "n=75 turns" is statistician's shorthand that a buyer reads past. The
    // number is the useful part, so say what it counts in words.
    return `${count(n)}${noun ? ` ${noun}` : ''} measured`;
  }

  /* A delta the server refused to compute is shown as the refusal, not hidden.
     Silently omitting it reads as "no change", which is a different and false
     statement. */
  function deltaChip(change, opts) {
    const options = opts || {};
    if (!change || !change.available) {
      const reason = change && change.reason;
      if (reason === 'no_previous_period') {
        return `<span class="delta none" title="No comparable previous period">no baseline</span>`;
      }
      const tip = reason === 'below_minimum_sample'
        ? `Needs ${count(change && change.minimum)} samples in both periods; had ${count(change && change.count)} now and ${count(change && change.previous_count)} before.`
        : reasonText(reason);
      const label = reason === 'below_minimum_sample'
        ? 'not enough history to compare'
        : 'trend unavailable';
      return `<span class="delta none" title="${esc(tip)}">${esc(label)}</span>`;
    }
    const ratio = change.ratio != null ? change.ratio : null;
    const abs = change.delta != null ? change.delta : null;
    if (ratio == null && abs == null) return '';
    const value = ratio != null ? ratio * 100 : abs;
    const rounded = Math.abs(value) < 0.5 ? 0 : value;
    const dir = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
    // "Higher is worse" is the default because every published metric is a
    // latency or a failure rate.
    const good = options.higherIsBetter ? dir === 'up' : dir === 'down';
    const cls = dir === 'flat' ? 'flat' : good ? 'down' : 'up';
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—';
    const text = ratio != null
      ? `${Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0)}%`
      : msText(Math.abs(abs));
    const tip = [
      change.previous != null ? `Previous ${options.rate ? pct(change.previous) : msText(change.previous)}` : null,
      change.current != null ? `now ${options.rate ? pct(change.current) : msText(change.current)}` : null,
      change.previous_count != null ? `over ${count(change.previous_count)} prior samples` : null,
    ].filter(Boolean).join(' · ');
    return `<span class="delta ${cls}" title="${esc(tip)}">${arrow} ${text} vs previous</span>`;
  }

  const TONE_WORD = { warn: 'elevated', alarm: 'critical' };
  // The same two thresholds the single-call console paints a turn with
  // (app.js WARN_MS / SLOW_MS), and the same 3 s the "audible lag" rate counts
  // against. A fleet median above the threshold the rest of the product calls
  // slow must not be the only place that renders it as calm.
  const WARN_MS = 1800;
  const SLOW_MS = 3000;

  function latencyTone(value, scale) {
    // `scale` widens the thresholds for a tail metric: a P95 above 3 s is
    // normal in a voice pipeline, so alarming there would cry wolf on every
    // healthy fleet, while a *median* above 3 s means the typical caller is
    // waiting longer than the product's own definition of slow.
    const factor = scale || 1;
    if (!Number.isFinite(value)) return '';
    if (value >= SLOW_MS * factor) return 'alarm';
    if (value >= WARN_MS * factor) return 'warn';
    return '';
  }

  function kpiTile(opts) {
    const tone = opts.tone ? ` is-${opts.tone}` : '';
    const clickable = !!opts.selector;
    // Colour alone does not carry the alarm for a colour-blind reader, and a
    // red number with no word is also ambiguous about which direction is bad.
    const toneWord = TONE_WORD[opts.tone]
      ? `<span class="fleet-kpi-tone ${esc(opts.tone)}">${esc(TONE_WORD[opts.tone])}</span>` : '';
    const valueHtml = opts.unavailable
      ? `<div class="fleet-kpi-value unavailable">${esc(opts.unavailable)}</div>`
      // The scope sits on its own line, not inline beside the tone word: in a
      // fifth-width tile the two wrapped into each other and the fleet's most
      // important reliability number read as a rendering fault.
      : `<div class="fleet-kpi-value">${esc(opts.value)}${opts.unit ? `<span class="unit">${esc(opts.unit)}</span>` : ''}${toneWord}</div>${
          opts.unitSuffix ? `<div class="fleet-kpi-scope">${esc(opts.unitSuffix)}</div>` : ''}`;
    return `
      <button type="button" class="fleet-kpi${tone}" data-static="${!clickable}"
        ${clickable ? `data-selector="${esc(opts.selector)}" data-title="${esc(opts.label)}"` : 'tabindex="-1" aria-disabled="true"'}>
        <span class="fleet-kpi-label">${esc(opts.label)}${opts.hint ? info(opts.hint) : ''}</span>
        ${valueHtml}
        <span class="fleet-kpi-foot">${opts.foot || ''}</span>
      </button>`;
  }

  function emptyState(title, body) {
    return `<div class="empty"><b>${esc(title)}</b>${esc(body || '')}</div>`;
  }

  // -------------------------------------------------------------- filter bar

  function renderFilters() {
    const form = $('#filters');
    const data = state.data;
    const facets = (data && data.facets) || {};

    // A dimension the SDKs never record gets one line of explanation, not a
    // dead dropdown. Two disabled selects sitting in the primary filter bar
    // read as "you have no data" when the truth is "nothing emits this field",
    // and they cost more space than the working filters they sit next to.
    const usable = [];
    const missing = [];
    FACETS.forEach((facet) => {
      const facetData = facets[facet.key] || { values: [], reason: null };
      if ((facetData.values || []).length) usable.push([facet, facetData]);
      else missing.push([facet, facetData]);
    });

    const controls = usable.map(([facet, facetData]) => {
      const selected = state.filters[facet.key] || '';
      // A stale selection must stay selectable, or changing the time range
      // would silently widen the query while the control still claims a filter.
      const values = facetData.values.slice();
      if (selected && !values.includes(selected)) values.push(selected);
      const options = [`<option value="">${esc(facet.all)}</option>`].concat(
        values.map((v) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(v)}${
          facetData.values.includes(v) ? '' : ' (not in range)'}</option>`)
      ).join('');
      return `<label class="filter">
        <span>${esc(facet.label)}</span>
        <select data-filter="${esc(facet.key)}">${options}</select>
      </label>`;
    }).join('');

    const missingNote = missing.length
      ? `<span class="filter-note missing-facets" title="${esc(missing.map(([f, d]) => `${f.label}: ${reasonText(d.reason || 'no_eligible_turns')}`).join(' · '))}">
           ${esc(missing.map(([f]) => f.label.toLowerCase()).join(' and '))} not captured by the SDKs
         </span>`
      : '';

    const rangeOptions = RANGES.map((r) => (
      `<option value="${r.id}"${r.id === state.range ? ' selected' : ''}>${esc(r.label)}</option>`
    )).join('');

    const activeCount = Object.values(state.filters).filter(Boolean).length;

    form.innerHTML = `
      <label class="filter">
        <span>Time range</span>
        <select data-range>${rangeOptions}</select>
      </label>
      ${controls}
      ${activeCount ? `<button type="button" class="btn tiny" data-clear>Clear ${activeCount} filter${activeCount > 1 ? 's' : ''}</button>` : ''}
      <span class="filters-spacer"></span>
      <span class="filters-meta">${missingNote}${metaBadges()}</span>`;
  }

  function metaBadges() {
    const data = state.data;
    if (!data) return '';
    const out = [];
    const acc = data.accuracy || {};
    if (acc.refused) {
      out.push(`<span class="badge alarm" title="${esc(reasonText(acc.refused.reason))}">refused: ${esc(reasonText(acc.refused.reason))}</span>`);
    } else if (acc.exact) {
      out.push(`<span class="badge exact" title="Computed from every raw turn in range, ${esc(acc.percentile_rule || '')}">exact</span>`);
    } else {
      const err = acc.relative_error != null ? `${(acc.relative_error * 100).toFixed(0)}%` : '1%';
      out.push(`<span class="badge approx" title="Percentiles from hourly sketches, guaranteed within ${esc(err)} relative error. Counts remain exact. Narrow the range for exact percentiles.">±${esc(err)} percentiles</span>`);
    }
    const coverage = data.coverage || {};
    if (coverage.pending_metric_builds) {
      out.push(`<span class="badge approx" title="Uploaded calls whose metrics have not been extracted yet. They are missing from every number on this page until they finish.">${count(coverage.pending_metric_builds)} calls still indexing</span>`);
    }
    return out.join('');
  }

  // ---------------------------------------------------------------- KPI row

  function renderKpis(data) {
    const overview = data.overview || {};
    const calls = overview.calls || {};
    const latency = overview.response_latency || {};
    const lag = overview.audible_lag || {};
    const failed = overview.failure_impacted_calls || {};
    const coverage = data.coverage || {};

    const cards = [];

    cards.push(kpiTile({
      label: 'Calls',
      value: count(calls.total),
      hint: 'Calls whose start time falls in the selected range. Call counts are attributed to the call start; turn metrics use the turn\u2019s own time.',
      selector: 'all',
      foot: [
        `${count(calls.turns)} turns`,
        calls.incomplete ? `<span class="delta up" title="Capture ended before the call did, so these calls under-report">${count(calls.incomplete)} incomplete capture</span>` : '',
        calls.total_duration_ms ? `${duration(calls.total_duration_ms)} audio` : '',
      ].filter(Boolean).join(' · '),
    }));

    const p50 = ms(latency.p50);
    cards.push(kpiTile({
      label: 'Typical reply wait',
      tone: latency.available && latency.p50_confident ? latencyTone(latency.p50) : '',
      hint: 'The median turn (P50). Caller stops speaking to the first audible byte of the agent\u2019s reply, measured per turn with the same function the call view uses.',
      value: latency.available && latency.p50_confident ? p50.text : null,
      unit: p50.unit,
      unavailable: !latency.available
        ? reasonText(latency.reason)
        : !latency.p50_confident ? `${p50.text} ${p50.unit} · low confidence` : null,
      selector: 'slowest',
      foot: [sampleLabel(latency.count, 'turns'), deltaChip(latency.change)].filter(Boolean).join(' · '),
    }));

    const p95 = ms(latency.p95);
    cards.push(kpiTile({
      label: 'Worst-case reply wait',
      hint: 'The 95th percentile (P95) \u2014 the tail your callers actually complain about. Needs 20 measured turns to report and 100 to be stable; below that the value moves on a single slow turn.',
      value: latency.available && latency.p95_confident ? p95.text : null,
      unit: p95.unit,
      unavailable: !latency.available
        ? reasonText(latency.reason)
        : !latency.p95_confident ? `needs ${count(coverage.minimum_sample_p95 || 20)} turns, have ${count(latency.count)}` : null,
      tone: latency.p95_confident ? latencyTone(latency.p95, 2) : '',
      selector: 'slowest',
      foot: [
        sampleLabel(latency.count, 'turns'),
        latency.p95_confident && !latency.p95_stable ? '<span class="delta none" title="Under 100 samples this percentile moves on one slow turn.">still a small sample</span>' : '',
        deltaChip(latency.change_p95),
      ].filter(Boolean).join(' · '),
    }));

    cards.push(kpiTile({
      label: 'Turns over 3 s',
      hint: 'Share of measured turns where the caller waited longer than the audible-lag threshold before hearing anything. This is the number that maps to "the bot feels slow".',
      value: lag.available ? pct(lag.rate) : null,
      unavailable: lag.available ? null : reasonText(lag.reason),
      tone: lag.available ? (lag.rate > 0.25 ? 'alarm' : lag.rate > 0.1 ? 'warn' : '') : '',
      selector: 'audible_lag',
      // The scope rides on the value itself, not in the footnote. This is the
      // loudest number on the page, and "88%" of a half-measured population is
      // a materially different claim from 88% of the fleet - a reader who takes
      // it at face value over-estimates how slow their agents are.
      unitSuffix: lag.available && calls.turns && lag.eligible < calls.turns ? 'of measured turns' : '',
      foot: lag.available
        ? `${count(lag.count)} of ${count(lag.eligible)} measured turns${
            calls.turns && lag.eligible < calls.turns
              ? ` <span class="delta none" title="${esc(`Response latency could not be measured on ${count(calls.turns - lag.eligible)} of ${count(calls.turns)} turns, so this share describes the measured turns only.`)}">${pct(lag.eligible / calls.turns, 0)} of ${count(calls.turns)} turns measurable</span>`
              : ''}`
        : '',
    }));

    cards.push(kpiTile({
      label: 'Calls hitting an error',
      hint: 'Calls with at least one genuine failure. Deliberate cancellation from barge-in is excluded, because treating correct interruption as an error would drown the real ones.',
      value: failed.available ? pct(failed.rate) : null,
      unavailable: failed.available ? null : reasonText(failed.reason),
      tone: failed.available ? (failed.rate > 0.05 ? 'alarm' : failed.rate > 0.01 ? 'warn' : '') : '',
      selector: 'failures',
      foot: failed.available ? `${count(failed.count)} of ${count(failed.eligible)} calls` : '',
    }));

    return `<section class="fleet-kpi-row">${cards.join('')}</section>`;
  }

  // ------------------------------------------------------------------ chart

  /* Hand-rolled SVG rather than a charting library. The panel has exactly one
     job — show P50, P95, volume and failures on a shared time axis — and a
     library would add a bundle, a theme fight, and a second set of rounding
     rules that would disagree with the KPI row above it. */
  function niceCeiling(value) {
    const steps = [100, 250, 500, 1000, 2000, 2500, 5000, 10000, 15000, 20000, 30000, 60000];
    for (const step of steps) {
      const top = Math.ceil(value / step) * step;
      if (top / step <= 6) return top;
    }
    return Math.ceil(value / 60000) * 60000;
  }

  function renderChart(data) {
    const series = (data.timeseries || []).slice();
    const span = (data.range || {}).to_ms - (data.range || {}).from_ms;
    const measured = series.filter((b) => b.measured > 0);
    const refusal = (data.accuracy || {}).refused;
    if (!series.length) {
      // A refusal and an empty range are different answers and must not share
      // an empty state: one says "there is nothing here", the other says
      // "there may be plenty here, and the server declined to count it".
      return refusal
        ? card('Response latency over time', '', emptyState(
            'Not computed for this range',
            refusal.message || reasonText(refusal.reason)))
        : card('Response latency over time', '', emptyState('No data in this range', 'Try a wider time range or clear a filter.'));
    }

    const W = 1000;
    const H = 240;
    const padL = 46;
    const padR = 46;
    const padT = 14;
    const padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const volH = 46;
    const lineH = plotH - volH - 10;

    // Rounded to a readable step so the axis reads 0 / 5 s / 10 s rather than
    // 0 / 7.74 s / 15.5 s. The domain only ever grows, so nothing is clipped.
    const maxLatency = niceCeiling(Math.max(1, ...measured.map((b) => Math.max(b.p95 || 0, b.p50 || 0))));
    const maxVolume = Math.max(1, ...series.map((b) => b.turns || 0));
    const n = series.length;
    const bw = plotW / n;

    const x = (i) => padL + bw * (i + 0.5);
    const yLine = (v) => padT + lineH - (v / maxLatency) * lineH;
    const yVol = (v) => padT + plotH - (v / maxVolume) * volH;

    // A gap in measurement is a gap in the line. Interpolating across an hour
    // with no measured turns invents a trend that never happened.
    function path(key) {
      const segments = [];
      let current = [];
      series.forEach((bucket, i) => {
        const v = bucket[key];
        if (v == null || !bucket.measured) {
          if (current.length) segments.push(current);
          current = [];
          return;
        }
        current.push(`${x(i).toFixed(1)},${yLine(v).toFixed(1)}`);
      });
      if (current.length) segments.push(current);
      // A single measured bucket between two gaps has no line to draw. Emitted
      // as a dot instead of a zero-length path, which rendered as invisible dust.
      return {
        path: segments.filter((seg) => seg.length > 1).map((seg) => `M${seg.join('L')}`).join(' '),
        points: segments.filter((seg) => seg.length === 1).map((seg) => seg[0]),
      };
    }

    // No measured turn means no latency domain. The axis would otherwise be
    // drawn from the `Math.max(1, ...)` floor and read "100 ms / 50 ms / 0" -
    // a scale invented from nothing, under an empty plot, which reads as a
    // broken chart rather than as an honest absence of data.
    const hasLatency = measured.length > 0;
    const ticks = !hasLatency ? '' : [0, 0.5, 1].map((f) => {
      const value = maxLatency * (1 - f);
      const y = padT + lineH * f;
      return `<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--line-soft)" stroke-width="1"/>
        <text x="${padL - 7}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-faint)">${esc(value === 0 ? '0' : msText(value))}</text>`;
    }).join('');
    const noLatencyNote = hasLatency ? '' :
      `<text x="${(padL + plotW / 2).toFixed(1)}" y="${(padT + lineH / 2).toFixed(1)}" text-anchor="middle"
         font-size="12" fill="var(--text-faint)">No measurable response latency in this range</text>`;

    const bars = series.map((bucket, i) => {
      if (!bucket.turns) return '';
      const h = padT + plotH - yVol(bucket.turns);
      const failing = bucket.failures > 0;
      return `<rect x="${(x(i) - bw * 0.32).toFixed(1)}" y="${yVol(bucket.turns).toFixed(1)}"
        width="${(bw * 0.64).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="1"
        fill="${failing ? 'color-mix(in srgb, var(--danger) 55%, transparent)' : 'var(--line-strong)'}"/>`;
    }).join('');

    const hits = series.map((bucket, i) => (
      `<rect class="chart-hit" x="${(padL + bw * i).toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${plotH}"
        tabindex="0" role="button" data-bucket="${i}"
        aria-label="${esc(bucketSummary(bucket))}"><title>${esc(bucketSummary(bucket))}</title></rect>`
    )).join('');

    const labelEvery = Math.max(1, Math.ceil(n / 8));
    const axis = series.map((bucket, i) => (
      i % labelEvery === 0
        ? `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-faint)">${esc(clockLabel(bucket.from_ms, span))}</text>`
        : ''
    )).join('');

    // Right-anchored at the viewBox edge: left-anchoring past `W - padR` pushed
    // the label outside the 1000-unit box and clipped it to "156 turn".
    const rightMax = `<text x="${W - 2}" y="${(padT + plotH - volH / 2).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-faint)">${esc(count(maxVolume))} turns/bucket</text>`;

    const p95Line = path('p95');
    const p50Line = path('p50');
    const dots = (points, color) => points.map((pt) => {
      const [cx, cy] = pt.split(',');
      return `<circle cx="${cx}" cy="${cy}" r="2.6" fill="${color}"/>`;
    }).join('');

    const svg = `
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Response latency P50 and P95 by time bucket with turn volume and failures">
        ${ticks}
        ${noLatencyNote}
        ${bars}
        ${rightMax}
        <path d="${p95Line.path}" fill="none" stroke="var(--warn)" stroke-width="1.8" stroke-dasharray="5 3" stroke-linejoin="round" stroke-linecap="round"/>
        <path d="${p50Line.path}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots(p95Line.points, 'var(--warn)')}
        ${dots(p50Line.points, 'var(--accent)')}
        ${axis}
        ${hits}
      </svg>`;

    const legend = `<div class="chart-legend">
      ${hasLatency ? '<span><i style="background:var(--accent)"></i>P50</span>' : ''}
      ${hasLatency ? '<span><i class="dashed" style="background:var(--warn)"></i>P95 (dashed)</span>' : ''}
      <span><i class="swatch-vol" style="background:var(--line-strong)"></i>turns per bucket</span>
      <span><i class="swatch-vol" style="background:color-mix(in srgb, var(--danger) 55%, transparent)"></i>bucket contained a failure</span>
    </div>`;

    const gapNote = !hasLatency
      ? `<p class="filter-note" style="margin-top:8px">Turn volume and failures are still shown. Response latency needs both a recorded speech end and a first audible byte on the same turn.</p>`
      : series.length - measured.length > 0
        ? `<p class="filter-note" style="margin-top:8px">${count(series.length - measured.length)} of ${count(series.length)} buckets had no measurable turn; the line breaks there rather than interpolating across them.</p>`
        : '';

    return card(
      'Response latency over time',
      `one point = ${spanLabel((data.range || {}).bucket_ms)}`,
      `<div class="chart-wrap" data-chart>${svg}</div>${legend}${gapNote}`
    );
  }

  // ------------------------------------------------------------ stage cards

  function metricRow(metric, stage) {
    const dist = metric.distribution || {};
    const coverage = metric.coverage || {};
    const bar = coverage.eligible
      ? `<div class="metric-bar" title="${esc(`Measured on ${count(coverage.measured)} of ${count(coverage.eligible)} ${coverage.population || 'eligible turns'}`)}">
           <i style="width:${Math.min(100, (coverage.ratio || 0) * 100).toFixed(1)}%;background:${STAGE_COLOR[stage]}"></i>
         </div>`
      : '';

    if (!dist.available) {
      return `<div class="metric-row">
        <span class="metric-name">${esc(metric.label)}${info(metric.definition)}</span>
        <span class="metric-unavailable">${esc(reasonText(dist.reason))}</span>
      </div>`;
    }

    const p50 = ms(dist.p50);
    const p95 = ms(dist.p95);
    // Two metrics in one card are read as one sequence, so a metric captured on
    // a small slice of the stage's turns has to say so on the row itself. Time
    // to first token measured on 45 turns can legitimately exceed completion
    // measured on 241, and stacked without this the card looks broken.
    const thin = coverage.eligible && coverage.ratio != null && coverage.ratio < LOW_COVERAGE_RATIO;
    const note = thin
      ? `<span class="metric-thin" title="${esc(`Captured on ${count(coverage.measured)} of ${count(coverage.eligible)} ${coverage.population || 'eligible turns'}. Compare it with other metrics only where both cover the same turns.`)}">different subset</span>`
      : '';
    return `<div class="metric-row${thin ? ' thin' : ''}">
      <span class="metric-name">${esc(metric.label)}${info(metric.definition)}${note}</span>
      <span class="metric-num${dist.p50_confident ? '' : ' dim'}" title="${esc(dist.p50_confident ? `min ${msText(dist.min)} · mean ${msText(dist.mean)} · P90 ${msText(dist.p90)} · P99 ${msText(dist.p99)} · max ${msText(dist.max)}` : 'Below the minimum sample size to report confidently')}">
        ${esc(p50.text)}<em>${esc(p50.unit)}</em><small>P50</small>
      </span>
      <span class="metric-num${dist.p95_confident ? '' : ' dim'}" title="${esc(dist.p95_confident ? `P99 ${msText(dist.p99)} · max ${msText(dist.max)}${dist.p95_stable ? '' : ' · under 100 samples, moves on one slow turn'}` : `Needs 20 samples, have ${count(dist.count)}`)}">
        ${dist.p95_confident ? `${esc(p95.text)}<em>${esc(p95.unit)}</em>` : '—'}<small>P95</small>
      </span>
      <span>
        ${bar}
        <span class="metric-sample">${esc(count(dist.count))}${coverage.eligible ? ` / ${esc(count(coverage.eligible))}` : ''} turns measured</span>
      </span>
    </div>`;
  }

  function statChip(opts) {
    const clickable = !!opts.selector;
    const body = `<span>${esc(opts.label)}</span><b>${opts.value}</b>`;
    const tone = opts.tone ? ` ${opts.tone}` : '';
    const hint = esc(opts.hint || '');
    // A chip with nothing to drill into is a readout, not a control. Rendering
    // it as a button gave it the affordance of one, so a visitor clicked it and
    // nothing happened - which reads as a broken product rather than as a
    // figure that simply has no detail behind it.
    if (!clickable) {
      return `<span class="stat-chip${tone}" data-static="true" title="${hint}">${body}</span>`;
    }
    return `<button type="button" class="stat-chip${tone}" data-static="false"
      data-selector="${esc(opts.selector)}" data-title="${esc(opts.title || opts.label)}"
      title="${hint}">${body}</button>`;
  }

  function renderStages(data) {
    const stages = data.stages || {};
    const cards = STAGE_ORDER.filter((key) => stages[key]).map((key) => {
      const stage = stages[key];
      const metrics = (stage.metrics || []).map((m) => metricRow(m, key)).join('');
      const fail = stage.failure_rate || {};
      const impacted = stage.calls_impacted || {};
      const chips = [];

      chips.push(statChip({
        label: 'failure rate',
        value: fail.available ? esc(pct(fail.rate)) : '—',
        tone: fail.available && fail.rate > 0.02 ? 'alarm' : fail.available && fail.rate === 0 ? 'ok' : '',
        selector: fail.available && fail.count ? `${key}_failures` : null,
        title: `${stage.label} failures`,
        hint: fail.available
          ? `${count(fail.count)} genuine failures across ${count(fail.eligible)} ${stage.label} operations. Deliberate cancellation is excluded.`
          : reasonText(fail.reason),
      }));

      chips.push(statChip({
        label: 'calls affected',
        value: impacted.available
          ? `${impacted.upper_bound ? '≤' : ''}${esc(count(impacted.count))} <span style="font-weight:500;color:var(--text-faint)">/ ${esc(count(impacted.eligible))}</span>`
          : '—',
        tone: impacted.available && impacted.count > 0 ? 'alarm' : '',
        selector: impacted.available && impacted.count ? `${key}_failures` : null,
        title: `Calls hit by a ${stage.label} failure`,
        hint: `Distinct calls with at least one failure in this stage. A single bad call with 40 retries counts once here and 40 times in the failure rate.${
          impacted.upper_bound ? ' Over this range the value is merged from hourly rollups, so a call whose failures span two hours can be counted twice: read it as an upper bound.' : ''}`,
      }));

      (stage.extra || []).forEach((extra) => {
        chips.push(statChip({
          label: extra.label.toLowerCase(),
          value: extra.available ? esc(pct(extra.rate)) : '—',
          tone: extra.key === 'tts_interrupted' ? '' : (extra.available && extra.rate > 0.02 ? 'alarm' : ''),
          selector: extra.key === 'stt_missing_final' && extra.count ? 'missing_final' : null,
          title: extra.label,
          hint: `${extra.definition} ${extra.available ? `${count(extra.count)} of ${count(extra.eligible)}.` : reasonText(extra.reason)}`,
        }));
      });

      return `<article class="card stage-card">
        <div class="card-head">
          <h3><span class="stage-dot" style="background:${STAGE_COLOR[key]}"></span>${esc(stage.label)}</h3>
          <span class="sub" title="Recorded operations of this stage in range. This is the denominator for the failure rate.">${stage.eligible_operations == null ? 'not counted' : `${esc(count(stage.eligible_operations))} operations`}</span>
        </div>
        <div class="card-body">
          ${metrics || emptyState('No metrics in range', '')}
          <div class="stage-foot">${chips.join('')}</div>
        </div>
      </article>`;
    }).join('');

    return `<section class="stage-grid">${cards}</section>`;
  }

  // ------------------------------------------------------- tools & failures

  function renderTools(data) {
    const tools = data.tools || {};
    const items = tools.items || [];
    if (!items.length) {
      return card('Tool breakdown', '', emptyState('No tool calls in this range', 'Tools appear here as soon as an agent invokes one.'));
    }
    const minRank = tools.minimum_invocations_to_rank || 5;
    const rows = items.map((tool) => {
      const fail = tool.failure_rate || {};
      const p50 = ms(tool.p50);
      const p95 = ms(tool.p95);
      return `<tr class="clickable" tabindex="0" role="button" data-selector="tool_failures" data-tool="${esc(tool.name)}"
          data-title="${esc(`Calls using ${tool.name}`)}" data-any-tool="1">
        <td class="mono">${esc(tool.name)}</td>
        <td class="right num">${esc(count(tool.invocations))}</td>
        <td class="right num">${esc(count(tool.calls))}${tool.calls_are_upper_bound ? '<span class="cell-muted" title="Summed across hourly buckets; a call spanning two hours is counted in each.">≈</span>' : ''}</td>
        <td class="right num">${tool.rankable ? esc(`${p50.text} ${p50.unit}`) : `<span class="cell-muted" title="Under ${minRank} invocations, a percentile is one sample wearing a statistic's clothes.">—</span>`}</td>
        <td class="right num">${tool.rankable && tool.p95_confident ? esc(`${p95.text} ${p95.unit}`) : `<span class="cell-muted" title="Needs 20 invocations; have ${count(tool.measured)}.">—</span>`}</td>
        <td class="right num">${fail.available && fail.count ? `<span style="color:var(--danger)">${esc(pct(fail.rate))}</span>` : '<span class="cell-muted">0%</span>'}</td>
        <td class="right num">${tool.timeout_count ? `<span style="color:var(--warn)" title="Failures whose error name or message indicates a timeout.">${esc(count(tool.timeout_count))}</span>` : '<span class="cell-muted">—</span>'}</td>
      </tr>`;
    }).join('');

    return card('Tool breakdown', `${items.length} distinct`, `
      <table class="data">
        <thead><tr>
          <th>Tool</th>
          <th class="right">Calls made</th>
          <th class="right">In calls</th>
          <th class="right">P50</th>
          <th class="right">P95</th>
          <th class="right">Failure</th>
          <th class="right">Timeouts</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="filter-note" style="margin-top:10px">Percentiles are withheld below ${minRank} invocations. Tool duration is the SDK-recorded span, which includes the network hop to your own service.</p>`);
  }

  function renderFailures(data) {
    const failures = data.failures || [];
    if (!failures.length) {
      return card('Failure signatures', '', emptyState('No failures in this range', 'Barge-in cancellation is excluded by design.'));
    }
    const total = failures.reduce((sum, f) => sum + f.count, 0);
    const rows = failures.map((f) => {
      const share = total ? f.count / total : 0;
      return `<tr class="clickable" tabindex="0" role="button" data-selector="failures" data-fingerprint="${esc(f.fingerprint)}"
          data-title="${esc(`Calls hitting ${f.fingerprint}`)}">
        <td>
          <span class="reason-chip failure">${esc(f.stage)}</span>
          <span class="mono">${esc(f.fingerprint.split(':').slice(1).join(':') || f.fingerprint)}</span>
        </td>
        <td class="right num">${esc(count(f.count))}</td>
        <td class="right num">${esc(count(f.calls))}${f.calls_are_upper_bound ? '<span class="cell-muted" title="Summed across hourly buckets; a call whose failures span two hours is counted in each. Read it as an upper bound.">≈</span>' : ''}</td>
        <td style="width:80px"><div class="metric-bar"><i style="width:${(share * 100).toFixed(1)}%;background:var(--danger)"></i></div></td>
      </tr>`;
    }).join('');
    return card('Failure signatures', `${count(total)} failures`, `
      <table class="data">
        <thead><tr><th>Signature</th><th class="right">Errors</th><th class="right">Calls</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="filter-note" style="margin-top:10px">Signatures are the stage plus the error type only. Provider message text is deliberately excluded: it carries transcript fragments and would explode into thousands of one-off rows.</p>`);
  }

  const SEVERITY_LABEL = { 3: 'Failed', 2: 'Unverifiable', 1: 'Slow' };

  // Rows shown before the queue asks to be expanded.
  const ATTENTION_PREVIEW = 8;

  function renderAttention(data) {
    const queue = data.attention || {};
    const items = queue.items || [];
    if (!items.length) {
      return card('Calls needing attention', '', emptyState('Nothing flagged in this range', 'Calls appear here when they fail, stall or lose capture.'));
    }
    const rows = items.map((call, index) => {
      const chips = (call.reasons || []).map((r) => (
        `<span class="reason-chip ${esc(r.kind)}" title="${esc(r.stage ? `${r.stage} · ${r.kind}` : r.kind)}">${esc(r.label)}</span>`
      )).join('');
      return `<tr class="clickable${index >= ATTENTION_PREVIEW ? ' is-extra' : ''}" ${index >= ATTENTION_PREVIEW ? 'hidden' : ''}
        data-open="${esc(call.session_id)}" data-turn="${esc(call.focus_turn_id || '')}">
        <td class="sev sev-${esc(call.severity)}" title="${esc(SEVERITY_LABEL[call.severity] || '')}">${esc(SEVERITY_LABEL[call.severity] || '')}</td>
        <td>
          <a class="row-link" href="${esc(callHref(call.session_id, call.focus_turn_id))}" target="_blank" rel="noopener">${esc(call.agent_id || 'unknown agent')}</a>
          <div class="cell-muted mono">${esc(call.session_id.slice(0, 8))} · ${esc(stamp(Date.parse(call.started_at)))}</div>
        </td>
        <td>${chips}</td>
        <td class="right num">${esc(count(call.turn_count))}</td>
        <td class="right num">${call.max_response_latency_ms != null ? esc(msText(call.max_response_latency_ms)) : '<span class="cell-muted">—</span>'}</td>
        <td class="right num cell-muted">${esc(duration(call.duration_ms))}</td>
      </tr>`;
    }).join('');
    const more = (queue.total || items.length) - items.length;
    const hidden = Math.max(0, items.length - ATTENTION_PREVIEW);
    // Triage belongs above the diagnostics, but twenty-five rows of it pushes
    // the trend chart off the screen entirely. The worst few are the ones an
    // engineer opens; the rest is one click away and stays on the same page.
    const expand = hidden
      ? `<button type="button" class="link-button" data-expand-attention>Show ${count(hidden)} more flagged call${hidden === 1 ? '' : 's'}</button>`
      : '';
    return card('Calls needing attention', `${count(items.length)} of ${count(queue.total)} flagged`, `
      <table class="data">
        <thead><tr>
          <th>Severity</th><th>Call</th><th>Why</th><th class="right">Turns</th><th class="right">Slowest turn</th><th class="right">Length</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${expand}
      <p class="filter-note" style="margin-top:10px">Ranked in three classes — <b>failed</b> (the caller heard an error), <b>unverifiable</b> (capture is incomplete, so we cannot say what they heard) and <b>slow</b> — then by magnitude within each class. Opening a row lands on the turn that caused the flag.${
        more > 0 ? ` ${count(more)} further flagged call${more === 1 ? '' : 's'} are not shown; use the KPI drill-downs above for the full list.` : ''}</p>`);
  }

  function card(title, sub, body) {
    return `<article class="card">
      <div class="card-head"><h2>${esc(title)}</h2>${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</div>
      <div class="card-body">${body}</div>
    </article>`;
  }

  // ----------------------------------------------------------------- render

  function renderBody() {
    const root = $('#board-body');
    if (state.error) {
      root.innerHTML = `<div class="board-grid">${card('Dashboard unavailable', '', `
        <div class="notice">${esc(state.error)}</div>
        <p class="filter-note" style="margin-top:10px">The console at <a href="/">Calls</a> is unaffected; it reads the raw sessions directly.</p>`)}</div>`;
      return;
    }
    const data = state.data;
    if (!data) {
      root.innerHTML = `<div class="board-grid">
        <div class="skeleton" style="height:104px"></div>
        <div class="skeleton" style="height:300px"></div>
        <div class="skeleton" style="height:260px"></div>
      </div>`;
      return;
    }

    const coverage = data.coverage || {};
    const refused = (data.accuracy || {}).refused;
    const notices = [];
    if (refused) {
      // Says exactly which numbers survived. The earlier wording promised that
      // "counts and rates below remain exact", which was true only of the
      // call-level row - every per-stage number on this view is a dash.
      notices.push(`<div class="notice">This view was refused: ${esc(reasonText(refused.reason))}. Only call-level counts above are computed; per-stage latency, failure rates, tools and the trend are shown as unavailable rather than guessed. Narrow the time range, or clear the provider/model filter, to compute them.</div>`);
    }
    if (coverage.capture_incomplete_calls) {
      notices.push(`<div class="notice">${count(coverage.capture_incomplete_calls)} call(s) in range ended before capture finished. Their turns are under-counted in every panel below.</div>`);
    }
    if (!coverage.calls) {
      root.innerHTML = `<div class="board-grid">${card('No calls in this range', '', emptyState(
        'Nothing to aggregate yet',
        'Widen the time range, clear a filter, or upload a call from the SDK.'
      ))}</div>`;
      return;
    }
    // Not on a refused range: nothing was measured because nothing was looked
    // at, and telling the reader "stage metrics below are still valid" would
    // contradict both the refusal banner above it and the dashes below it.
    if (!refused && coverage.turns && !coverage.measured_response_turns) {
      notices.push('<div class="notice">No turn in this range had both a speech end and a first audible byte recorded, so response latency cannot be measured. Stage metrics below are still valid.</div>');
    }

    /* Order is triage-first: is the fleet healthy (KPIs), what do I open right
       now (attention queue), then the diagnostics that explain it (trend,
       stages, tools, failures). The queue used to sit last, three screens below
       the answer it belongs next to. */
    root.innerHTML = `<div class="board-grid">
      ${notices.join('')}
      ${renderKpis(data)}
      ${renderAttention(data)}
      ${renderChart(data)}
      ${renderStages(data)}
      <section class="grid-2">${renderTools(data)}${renderFailures(data)}</section>
      ${renderFootnotes(data)}
    </div>`;
  }

  function renderFootnotes(data) {
    const defs = data.definitions || {};
    const notes = (defs.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
    const acc = data.accuracy || {};
    return `<details class="card" style="padding:0">
      <summary style="padding:12px 14px;cursor:pointer;font-size:12px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-dim)">How these numbers are made</summary>
      <div class="card-body" style="border-top:1px solid var(--line-soft)">
        <ul style="margin:0 0 10px;padding-left:18px;color:var(--text-dim);font-size:12px;line-height:1.7">
          ${notes}
          ${acc.refused
            ? '<li>Percentiles were not computed for this view, so no source or rule applies to them.</li>'
            : `<li>Percentiles: ${esc(acc.percentile_rule || 'nearest rank')}. Source: ${esc(acc.method || 'raw turn rows')}.</li>`}
          <li>Every metric here is derived from the same turn-grouping function the single-call view uses, so a dashboard percentile and the call it links to always agree.</li>
          <li>Reporting thresholds: P50 needs 5 samples, P95 needs ${esc(count((data.coverage || {}).minimum_sample_p95 || 20))} and is unstable under 100, a period-over-period change needs ${esc(count((data.coverage || {}).minimum_sample_change || 30))} in both periods.</li>
        </ul>
        <p class="filter-note">Range ${esc(stamp(data.range.from_ms))} → ${esc(stamp(data.range.to_ms))} · compared against ${esc(stamp(data.range.previous_from_ms))} → ${esc(stamp(data.range.previous_to_ms))}.</p>
      </div>
    </details>`;
  }

  // ----------------------------------------------------------------- drawer

  let drawerReturnFocus = null;

  function openDrawer(opts) {
    const drawer = $('#drawer');
    drawerReturnFocus = document.activeElement;
    $('#drawer-title').textContent = opts.title || 'Calls';
    $('#drawer-sub').textContent = 'Loading…';
    $('#drawer-body').innerHTML = '<div class="skeleton" style="height:180px"></div>';
    drawer.hidden = false;
    setBackgroundInert(true);
    drawer.querySelector('.btn').focus();

    const params = frozenParams();
    params.set('selector', opts.selector || 'all');
    if (opts.tool) params.set('tool_name', opts.tool);
    if (opts.fingerprint) params.set('fingerprint', opts.fingerprint);
    params.set('limit', '100');

    fetch(`/v1/dashboard/calls?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || r.statusText)))))
      .then((payload) => {
        const items = payload.items || [];
        const shown = items.length;
        $('#drawer-sub').textContent = `${payload.label} · ${count(payload.total)} call${payload.total === 1 ? '' : 's'}${
          payload.total > shown ? ` · showing the first ${shown}` : ''}`;
        if (!shown) {
          $('#drawer-body').innerHTML = emptyState('No calls matched', 'The filters above still apply to this list.');
          return;
        }
        const rows = items.map((call) => `
          <tr class="clickable" data-open="${esc(call.session_id)}" data-turn="${esc(call.focus_turn_id || '')}">
            <td>
              <a class="row-link" href="${esc(callHref(call.session_id, call.focus_turn_id))}" target="_blank" rel="noopener">${esc(call.agent_id || 'unknown agent')}</a>
              <div class="cell-muted mono">${esc(stamp(Date.parse(call.started_at)))}</div>
            </td>
            <td class="right num">${esc(count(call.turn_count))}</td>
            <td class="right num">${call.max_response_latency_ms != null ? esc(msText(call.max_response_latency_ms)) : '<span class="cell-muted">—</span>'}</td>
            <td class="right num">${call.failed_op_count ? `<span style="color:var(--danger)">${esc(count(call.failed_op_count))}</span>` : '<span class="cell-muted">0</span>'}</td>
            <td class="right num cell-muted">${esc(duration(call.duration_ms))}</td>
          </tr>`).join('');
        $('#drawer-body').innerHTML = `
          <table class="data">
            <thead><tr><th>Call</th><th class="right">Turns</th><th class="right">Slowest turn</th><th class="right">Errors</th><th class="right">Length</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="filter-note" style="margin-top:10px">Opening a call lands on the turn that put it in this list.</p>`;
      })
      .catch((err) => {
        $('#drawer-sub').textContent = '';
        $('#drawer-body').innerHTML = `<div class="notice">Could not load these calls: ${esc(err.message)}</div>`;
      });
  }

  function closeDrawer() {
    $('#drawer').hidden = true;
    setBackgroundInert(false);
    if (drawerReturnFocus && drawerReturnFocus.focus) drawerReturnFocus.focus();
    drawerReturnFocus = null;
  }

  function setBackgroundInert(inert) {
    // A screen reader otherwise announces the page behind the dialog as if it
    // were part of it. `aria-modal` alone does not stop that in every reader.
    const page = document.querySelector('[data-workspace]');
    if (!page) return;
    if (inert) { page.setAttribute('inert', ''); page.setAttribute('aria-hidden', 'true'); }
    else { page.removeAttribute('inert'); page.removeAttribute('aria-hidden'); }
  }

  function callHref(sessionId, turnId) {
    // A real URL, not just a click handler. It gives keyboard users a focusable
    // target, screen readers a link role, and everyone cmd/middle-click to fan
    // several calls out at once - which is how an investigation queue is
    // actually worked through.
    const suffix = turnId ? `/turn/${encodeURIComponent(turnId)}` : '';
    return `/#/call/${encodeURIComponent(sessionId)}${suffix}`;
  }

  function openCall(sessionId, turnId) {
    // The console owns call rendering. Linking into its existing hash route
    // keeps one implementation of the call view instead of a second, subtly
    // different one embedded here.
    const suffix = turnId ? `/turn/${encodeURIComponent(turnId)}` : '';
    window.open(`/#/call/${encodeURIComponent(sessionId)}${suffix}`, '_blank', 'noopener');
  }

  // ------------------------------------------------------------------ fetch

  // The console header shows "Updated HH:MM:SS"; the dashboard says the same
  // thing in the same slot so the two pages read as one product.
  function freshnessText(generatedAt) {
    const at = generatedAt ? new Date(generatedAt) : window.vaaniDate();
    if (Number.isNaN(at.getTime())) return '';
    return `Updated ${at.toLocaleTimeString()}`;
  }

  function load() {
    const id = ++state.reqId;
    state.loading = true;
    state.error = null;
    $('#conn-state').textContent = 'Loading…';
    if (!state.data) renderBody();

    fetch(`/v1/dashboard/summary?${activeParams().toString()}`)
      .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || r.statusText)))))
      .then((payload) => {
        if (id !== state.reqId) return; // a newer request already won
        state.data = payload;
        state.loading = false;
        $('#conn-state').textContent = freshnessText(payload.generated_at);
        $('#conn-state').title = payload.generated_at || '';
        renderFilters();
        renderBody();
        if (state.pendingDrilldown) {
          const selector = state.pendingDrilldown;
          state.pendingDrilldown = null;
          openDrawer({ selector });
        }
      })
      .catch((err) => {
        if (id !== state.reqId) return;
        state.loading = false;
        state.error = err.message || 'Request failed';
        $('#conn-state').textContent = '';
        $('#conn-state').title = '';
        renderFilters();
        renderBody();
      });
  }

  // --------------------------------------------------------------- wiring

  function readUrl() {
    const params = new URLSearchParams(window.location.search);
    const range = params.get('range');
    if (range && RANGES.some((r) => r.id === range)) state.range = range;
    FACETS.forEach((f) => {
      const value = params.get(f.key);
      if (value) state.filters[f.key] = value;
    });
    // An alert links here saying "see all 14 calls". Landing on an unfiltered
    // dashboard would make the reader re-derive which 14, so the drill-down the
    // alert was counting is opened for them. Applied once, on first load only,
    // so changing a filter afterwards does not keep reopening it.
    state.pendingDrilldown = params.get('drilldown') || null;
  }

  function writeUrl() {
    const params = new URLSearchParams();
    params.set('range', state.range);
    Object.entries(state.filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', next);
  }

  function bind() {
    $('#filters').addEventListener('change', (event) => {
      const target = event.target;
      if (target.hasAttribute('data-range')) {
        state.range = target.value;
      } else if (target.dataset.filter) {
        const key = target.dataset.filter;
        if (target.value) state.filters[key] = target.value;
        else delete state.filters[key];
      } else {
        return;
      }
      writeUrl();
      load();
    });

    $('#refresh').addEventListener('click', () => load());

    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) { closeDrawer(); return; }

      if (event.target.closest('[data-clear]')) {
        state.filters = {};
        writeUrl();
        load();
        return;
      }

      const expand = event.target.closest('[data-expand-attention]');
      if (expand) {
        expand.closest('.card-body').querySelectorAll('tr.is-extra').forEach((row) => {
          row.hidden = false;
          row.classList.remove('is-extra');
        });
        expand.remove();
        return;
      }

      if (event.target.closest('a.row-link')) return;  // the link handles itself
      const openRow = event.target.closest('[data-open]');
      if (openRow) {
        openCall(openRow.dataset.open, openRow.dataset.turn);
        return;
      }

      const chartHit = event.target.closest('.chart-hit');
      if (chartHit && state.data) {
        const bucket = state.data.timeseries[Number(chartHit.dataset.bucket)];
        if (bucket && bucket.calls) {
          openBucket(bucket);
        } else {
          toast('That bucket has no calls to open.');
        }
        return;
      }

      const trigger = event.target.closest('[data-selector]');
      if (trigger && trigger.dataset.static !== 'true') {
        openDrawer({
          selector: trigger.dataset.selector,
          title: trigger.dataset.title || 'Calls',
          tool: trigger.dataset.tool || null,
          fingerprint: trigger.dataset.fingerprint || null,
        });
      }
    });

    document.addEventListener('mouseover', (event) => {
      const hit = event.target.closest('.chart-hit');
      if (hit) showChartTip(hit, event);
      const tip = event.target.closest('[data-tip]');
      if (tip) showTip(tip.dataset.tip, tip);
    });
    document.addEventListener('mouseout', (event) => {
      if (event.target.closest('.chart-hit, [data-tip]')) hideTip();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !$('#drawer').hidden) { closeDrawer(); return; }
      if (event.key === 'Tab' && !$('#drawer').hidden) { trapFocus(event); return; }
      // Enter/Space on a focused row does what a click does. Without this the
      // tool and failure tables are reachable by keyboard but not usable, which
      // is worse than not being reachable at all.
      if (event.key === 'Enter' || event.key === ' ') {
        const row = event.target.closest && event.target.closest('tr[role="button"], .chart-hit');
        if (row) { event.preventDefault(); row.dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
      }
      if (event.target.matches('input, select, textarea')) return;
      if (event.key === 'r' || event.key === 'R') { load(); }
    });

    // A focused chart bucket announces the same numbers the tooltip shows.
    // Definitions are reachable by keyboard as well as by pointer. Every "i"
    // costs a tab stop whether or not it shows anything, so one that reveals
    // nothing on focus is a stop spent for no return - and a sighted keyboard
    // user has no other way to read the definition.
    document.addEventListener('focusin', (event) => {
      if (!event.target.closest) return;
      const hit = event.target.closest('.chart-hit');
      if (hit) { showChartTip(hit, null); return; }
      const tip = event.target.closest('[data-tip]');
      if (tip) showTip(tip.dataset.tip, tip);
    });
    document.addEventListener('focusout', (event) => {
      if (event.target.closest && event.target.closest('.chart-hit, [data-tip]')) hideTip();
    });
  }

  function trapFocus(event) {
    // `aria-modal` is a promise to assistive technology that focus stays inside
    // the dialog. Without a trap, Tab walks onto the obscured page behind it and
    // a keyboard user is stranded on content they cannot see.
    const panel = $('#drawer').querySelector('.drawer-panel');
    if (!panel) return;
    const focusable = [...panel.querySelectorAll(
      'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((node) => node.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    else if (!panel.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
  }

  function openBucket(bucket) {
    // Clicking a bucket asks a narrower question than the page filters do, so
    // the request has to carry the bucket window rather than the page window.
    const params = new URLSearchParams();
    params.set('from_ms', String(bucket.from_ms));
    params.set('to_ms', String(bucket.to_ms));
    Object.entries(state.filters).forEach(([k, v]) => { if (v) params.set(k, v); });
    // Every call in the bucket, not just the failing ones. Silently narrowing to
    // failures made a bucket the tooltip described as "45 calls" open a list of
    // three, so the chart and the list it opened disagreed on their own count.
    params.set('selector', 'all');
    params.set('limit', '100');

    const drawer = $('#drawer');
    drawerReturnFocus = document.activeElement;
    drawer.hidden = false;
    setBackgroundInert(true);
    const close = drawer.querySelector('.btn');
    if (close) close.focus();
    $('#drawer-title').textContent = `${stamp(bucket.from_ms)} → ${stamp(bucket.to_ms)}`;
    $('#drawer-sub').textContent = 'Loading…';
    $('#drawer-body').innerHTML = '<div class="skeleton" style="height:180px"></div>';

    fetch(`/v1/dashboard/calls?${params.toString()}`)
      .then((r) => r.json())
      .then((payload) => {
        const items = payload.items || [];
        $('#drawer-sub').textContent = `${count(payload.total)} call${payload.total === 1 ? '' : 's'} started here · ${count(bucket.turns)} turns and ${count(bucket.failures)} failure${bucket.failures === 1 ? '' : 's'} recorded in this bucket`;
        $('#drawer-body').innerHTML = items.length
          ? `<table class="data"><thead><tr><th>Call</th><th class="right">Turns</th><th class="right">Slowest turn</th><th class="right">Errors</th></tr></thead><tbody>${
              items.map((call) => `<tr class="clickable" data-open="${esc(call.session_id)}" data-turn="${esc(call.focus_turn_id || '')}">
                <td><a class="row-link" href="${esc(callHref(call.session_id, call.focus_turn_id))}" target="_blank" rel="noopener">${esc(call.agent_id || 'unknown agent')}</a><div class="cell-muted mono">${esc(stamp(Date.parse(call.started_at)))}</div></td>
                <td class="right num">${esc(count(call.turn_count))}</td>
                <td class="right num">${call.max_response_latency_ms != null ? esc(msText(call.max_response_latency_ms)) : '—'}</td>
                <td class="right num">${esc(count(call.failed_op_count))}</td></tr>`).join('')
            }</tbody></table>`
          : emptyState('No calls started in this bucket', 'Turns are attributed to their own time, but calls are attributed to their start, so a long call can put turns in a bucket it did not start in.');
      })
      .catch((err) => {
        $('#drawer-body').innerHTML = `<div class="notice">Could not load these calls: ${esc(err.message)}</div>`;
      });
  }

  function bucketSummary(bucket) {
    const parts = [
      stamp(bucket.from_ms),
      `${count(bucket.calls)} calls started`,
      `${count(bucket.turns)} turns`,
      bucket.measured ? `P50 ${msText(bucket.p50)}, P95 ${msText(bucket.p95)} from ${count(bucket.measured)} measured turns`
                      : 'no measurable turn',
    ];
    if (bucket.audible_lag_turns) parts.push(`${count(bucket.audible_lag_turns)} turns over 3 s`);
    if (bucket.failures) parts.push(`${count(bucket.failures)} failures`);
    return parts.join(' · ');
  }

  function showChartTip(hit, event) {
    const bucket = state.data && state.data.timeseries[Number(hit.dataset.bucket)];
    if (!bucket) return;
    const lines = [
      `<b>${esc(stamp(bucket.from_ms))}</b>`,
      `${count(bucket.calls)} calls started · ${count(bucket.turns)} turns`,
      bucket.measured
        ? `P50 ${msText(bucket.p50)} · P95 ${msText(bucket.p95)} <span style="color:var(--text-faint)">(n=${count(bucket.measured)})</span>`
        : '<span style="color:var(--text-faint)">no measurable turn in this bucket</span>',
      bucket.audible_lag_turns ? `${count(bucket.audible_lag_turns)} turns over 3 s` : '',
      bucket.failures ? `<span style="color:var(--danger)">${count(bucket.failures)} failures</span>` : '',
    ].filter(Boolean);
    // A keyboard focus carries no pointer coordinates, so anchor to the bucket.
    const point = event || (() => {
      const rect = hit.getBoundingClientRect();
      return { clientX: rect.left + rect.width / 2, clientY: rect.top };
    })();
    showTipHtml(lines.join('<br>'), point);
  }

  function showTip(text, el) {
    const rect = el.getBoundingClientRect();
    showTipHtml(esc(text), { clientX: rect.left + rect.width / 2, clientY: rect.top });
  }

  function showTipHtml(html, point) {
    const tip = $('#tooltip');
    tip.innerHTML = html;
    tip.hidden = false;
    const rect = tip.getBoundingClientRect();
    const x = Math.min(Math.max(8, point.clientX - rect.width / 2), window.innerWidth - rect.width - 8);
    const y = point.clientY - rect.height - 12;
    tip.style.left = `${x}px`;
    tip.style.top = `${y < 8 ? point.clientY + 18 : y}px`;
  }

  function hideTip() {
    $('#tooltip').hidden = true;
  }

  // ------------------------------------------------------------------- boot

  readUrl();
  bind();
  renderFilters();
  renderBody();
  load();

  // A voice agent fleet changes on the minute, and a stale dashboard during an
  // incident is worse than no dashboard. Refresh only while the tab is visible
  // so a backgrounded tab does not hammer the aggregate endpoint for hours.
  setInterval(() => {
    if (document.visibilityState === 'visible' && !state.loading && $('#drawer').hidden) load();
  }, 60000);
})();
