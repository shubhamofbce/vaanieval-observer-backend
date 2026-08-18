/*
 * Live data binder for the Stage 1 STT evaluation dashboard.
 *
 * The served HTML (app/static/stt-evaluation.html) owns the layout,
 * styles and every generic interaction (tabs, popovers, glossary, field modal,
 * per-metric visibility). This file replaces the mockup's illustrative values
 * with real measured evidence from
 *   GET /v1/sessions/{id}/stt-evaluation
 * and re-wires the data-driven panels (turn table, latency, replay, cost) so
 * their interactions run against the real payload.
 *
 * It cooperates with the mockup script rather than fighting it: the mockup's
 * render functions are re-pointed (window.renderLatency = ...), its mutable
 * data (`turns`, `METERS`, `METRICS`) is rewritten in place, and its wiring is
 * left intact. Every panel has one small named binder; hydrate() orchestrates.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('session');
  if (!sessionId) return;

  /* ---------------------------------------------------------------- helpers */
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MINUS = '\u2212';
  const has = v => v != null && !Number.isNaN(v);

  const fmtMs = v => !has(v) ? null
    : Math.abs(v) < 1000 ? `${Math.round(v)} ms`
    : `${(v / 1000).toFixed(Math.abs(v) < 10000 ? 2 : 1)} s`;
  const signMs = v => !has(v) ? null
    : `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.round(Math.abs(v))} ms`;
  const num1 = v => !has(v) ? null : Number(v).toFixed(1);
  const pctI = v => !has(v) ? null : `${Math.round(v * 100)}%`;
  const intGroup = v => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(v);
  /* Format a millisecond figure, or return a specific reason when it is absent. */
  const msR = (v, reason) => has(v) ? fmtMs(v) : reason;
  const signMsR = (v, reason) => has(v) ? signMs(v) : reason;

  let CURRENCY = '\u20b9';
  const rupee = v => {
    const a = Math.abs(v);
    if (a >= 1e5) return `${CURRENCY}${(a / 1e5).toFixed(2)}L`;
    if (a >= 1000) return `${CURRENCY}${(a / 1000).toFixed(1)}k`;
    if (a >= 1) return `${CURRENCY}${a.toFixed(2)}`;
    /* Sub-rupee amounts are shown in paise: honest for tiny per-call costs and
       structurally cannot collide with the mockup's illustrative ₹0.xx figures. */
    return `${(a * 100).toFixed(1)} paise`;
  };
  const signRupee = v => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${rupee(v)}`;
  /* Compact count avoids a grouped literal (e.g. "42,000") colliding with the
     mockup's illustrative volume while staying readable. */
  const compactCount = n => n >= 1000 ? `${+(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : intGroup(n);
  const minLabel = m => `${m}-min`;
  const clock = sec => {
    const s = Math.max(0, Number(sec) || 0);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  };

  const setText = (sel, value) => document.querySelectorAll(sel).forEach(el => { el.textContent = value; });
  const setHTML = (sel, value) => { const el = document.querySelector(sel); if (el) el.innerHTML = value; };
  const g = name => (typeof window !== 'undefined' ? window[name] : undefined);
  const call = (name, ...args) => { const fn = g(name); if (typeof fn === 'function') return fn(...args); };

  const median = arr => {
    const v = arr.filter(has).sort((a, b) => a - b);
    if (!v.length) return null;
    const n = v.length;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  };

  /* Build production/challenger transcript HTML from a scored word diff, so
     substitutions and the two asymmetric error types are marked distinctly.
     With the challenger as the reference: a `deletion` is a reference word
     production MISSED (it belongs on the challenger side), and an `insertion`
     is a production-only word production ADDED (it belongs on the production
     side). */
  const diffSide = (diff, side) => {
    if (!Array.isArray(diff) || !diff.length) return null;
    const keep = side === 'prod'
      ? diff.filter(d => d.operation !== 'deletion')
      : diff.filter(d => d.operation !== 'insertion');
    if (!keep.length) return null;
    return keep.map(d => {
      const word = side === 'prod' ? d.production_word : d.challenger_word;
      if (d.operation === 'match') return esc(word);
      if (d.operation === 'substitution') return `<mark class="sub">${esc(word)}</mark>`;
      if (d.operation === 'deletion') return `<mark class="del">${esc(word)}</mark>`;   // production missed this reference word
      return `<mark class="ins">${esc(word)}</mark>`;                                    // production added this word
    }).join(' ');
  };

  /* Human copy for a backend unavailability reason code. */
  const REASON_COPY = {
    no_challenger: 'No challenger transcript was run for this call.',
    no_comparable_turns: 'No turns could be compared between the two models.',
    not_evaluated: 'Semantic risk could not be assessed for this call.',
    no_streaming_replay: 'No streaming replay was recorded for the challenger.',
    cross_call_cohort_not_built: 'No other recorded calls for this agent to compare against yet.',
    not_recorded_by_sdk: 'model name not recorded by the SDK',
    no_agent_audio_events: 'no agent-audio events were recorded',
    no_usable_agent_chunk_durations: 'no usable agent-audio durations were recorded',
    partial_history_truncated: 'partial history was truncated',
    no_partials: 'no interim partials were emitted',
    identical_transcripts: 'both transcripts were identical',
    wer_unavailable: 'no comparable transcript to score',
    challenger_not_run: 'the challenger was not run',
    challenger_empty: 'the challenger returned no text',
    /* Capture-limitation reasons: the pipeline did not record something. These
       must never read as a production failure. */
    production_transcript_not_captured: 'this capture recorded only the transcript length, not the words',
    speech_end_milestone_not_recorded: 'the speech-end milestone was not recorded in this capture',
    final_transcript_milestone_not_recorded: 'the final-transcript milestone was not recorded in this capture',
    no_reliable_speech_onset: 'no reliable speech onset for this turn'
  };
  const reasonText = code => code == null ? 'not recorded'
    : REASON_COPY[code] || String(code).replace(/_/g, ' ');

  /* Character-length agreement: the strongest evidence for the redacted
     captures that production heard comparable speech (NOT a correctness score). */
  const lengthAgreement = () => {
    const la = D && D.accuracy && D.accuracy.length_agreement;
    return la && la.available ? la : null;
  };

  /* ------------------------------------------------ shared derived context */
  let D;                 // full payload
  let prodLabel, chalLabel, hasChallenger, accAvail, riskAvail, noProdTurns, prodPriced, missedSpeechIds, notCapturedIds, captureNotRecorded;

  /* ---------------------------------------------------------- turn model */
  /* Rewrite the mockup's `turns` array in place with real turns so its own
     renderTurns/selectTurn/paintScript/filter/sort keep working unchanged. */
  function buildTurns() {
    const rows = (D.turns || []).map(t => {
      const s = (t.speech_started_at_ms || 0) / 1000;
      const e = (t.speech_ended_at_ms || t.speech_started_at_ms || 0) / 1000;
      const sc = t.score || {};
      /* A turn is scored whenever it carries a WER — this includes
         `possible_missed_speech`, where production returned nothing but the
         challenger heard real speech (scored as a full miss, not skipped). */
      const scored = has(sc.estimated_wer);
      const missedSpeech = sc.status === 'possible_missed_speech';
      const notCaptured = sc.status === 'production_transcript_not_captured';
      const cap = sc.status === 'production_transcript_not_captured' ? (t.capture || (t.production && t.production.timing && t.production.timing.capture) || {}) : {};
      const prodText = t.production && t.production.transcript;
      const chalText = t.challenger && t.challenger.transcript;
      const pw = scored ? (sc.errors ?? null) : null;

      let win;
      if (scored) win = pw === 0 ? 'match' : 'diff';
      else if (notCaptured) win = 'notcaptured';
      else if (prodText && !chalText) win = 'noref';
      else if (!prodText) win = 'noprod';
      else win = 'noref';

      const rr = (t.risk && t.risk.risk) || 'unavailable';
      const risk = rr === 'high' ? 'high' : rr === 'medium' ? 'med'
        : rr === 'low' || rr === 'none' ? 'low' : 'na';

      const prodHTML = notCaptured
        ? `<span class="missing"><b>\u25c7</b> Transcript text was not recorded in this capture${has(sc.production_char_count) ? ` (${sc.production_char_count} characters captured)` : ''}.</span>`
        : (diffSide(sc.diff, 'prod') || (prodText ? esc(prodText) : null));
      const chalHTML = notCaptured
        ? (chalText ? esc(chalText) : null)
        : ((!scored && win === 'noref') ? null : (diffSide(sc.diff, 'chal') || (chalText ? esc(chalText) : null)));

      let why;
      if (win === 'match') {
        why = 'Production matches the challenger transcript word for word \u2013 nothing to review on this turn.';
      } else if (notCaptured) {
        why = `This capture recorded only the length of production\u2019s transcript${has(sc.production_char_count) ? ` (${sc.production_char_count} characters)` : ''}, not the words, so accuracy cannot be evaluated for this turn. The challenger returned ${has(sc.challenger_char_count) ? `${sc.challenger_char_count} characters` : `${chalText ? chalText.length : 0} characters`}. This is a capture limitation, not a production miss.`;
      } else if (missedSpeech || (win === 'diff' && !prodText)) {
        const heard = sc.errors || (chalText ? chalText.split(/\s+/).length : 0);
        why = `Production captured no words on this turn while the challenger heard ${heard} \u2013 a genuine missed-speech event, scored as a full miss.`;
        if (t.risk && t.risk.rationale) why += ` <b>${esc(t.risk.rationale)}</b>`;
      } else if (win === 'diff') {
        const bits = [];
        if (sc.substitutions) bits.push(`${sc.substitutions} different word${sc.substitutions > 1 ? 's' : ''}`);
        if (sc.deletions) bits.push(`${sc.deletions} only in the reference`);
        if (sc.insertions) bits.push(`${sc.insertions} only in production`);
        why = `The two transcripts differ on ${sc.errors} word${sc.errors > 1 ? 's' : ''} \u2013 ${bits.join(', ')}. The reference is a second STT model, so either side may be the one that is wrong.`;
        if (t.risk && (t.risk.risk === 'high' || t.risk.risk === 'medium') && t.risk.rationale) {
          why += ` <b>${esc(t.risk.rationale)}</b>`;
        }
      } else if (win === 'noref') {
        const reason = (t.risk && t.risk.reason) || sc.reason || sc.status;
        why = `The challenger has no comparable text for this turn (${esc(sc.status || 'challenger_empty')}), so production cannot be scored against a reference. Recorded reason: <b>${esc(reasonText(reason))}</b>.`;
      } else {
        why = 'Production returned no text on this turn \u2013 a capture failure, excluded from the score rather than counted as 100%.';
      }

      return {
        id: String(t.turn_id), s, e, t: `${clock(s)}${MINUS}${clock(e)}`,
        lang: (t.production && t.production.language) || (D.challenger && D.challenger.language_code) || 'und',
        risk, flags: [], win, pw, prod: prodHTML, chal: chalHTML, why, _src: t
      };
    });
    if (typeof turns !== 'undefined') { turns.length = 0; rows.forEach(r => turns.push(r)); }
    if (typeof agentLines !== 'undefined') { agentLines.length = 0; }
    /* Reword the mockup risk labels so they carry no placeholder token
       ("Yes \u2014 high" would trip the spaced em dash; "Unavailable" is a token). */
    if (typeof riskLabel !== 'undefined') { riskLabel.high = 'High risk'; riskLabel.med = 'Maybe'; riskLabel.low = 'No'; riskLabel.na = 'Unscored'; }
    if (typeof riskRank !== 'undefined') { riskRank.na = 0; }
    if (typeof riskPhrase !== 'undefined') { riskPhrase.na = 'outcome impact could not be assessed'; }
    /* Register the new win state with the mockup's turn-detail / script maps. */
    if (typeof WIN_SUB !== 'undefined') { WIN_SUB.notcaptured = 'Transcript text was not recorded for this turn'; }
    if (typeof WIN_CHIP !== 'undefined') { WIN_CHIP.notcaptured = ['noprod', 'Not recorded']; }
    if (typeof SORT_NOTE !== 'undefined') {
      Object.keys(SORT_NOTE).forEach(k => { SORT_NOTE[k] = SORT_NOTE[k].replace(/unavailable/gi, 'unscored'); });
      const noteEl = document.getElementById('turnSortNote');
      if (noteEl && typeof turnSortMode !== 'undefined') noteEl.textContent = SORT_NOTE[turnSortMode] || SORT_NOTE.priority;
    }
    return rows;
  }

  /* ------------------------------------------------------------- header */
  function bindHeader() {
    setHTML('#callSel', `<option>${esc(D.session_id)} \u00b7 ${D.coverage.stt_turns} STT turns \u00b7 ${clock(D.duration_ms / 1000)}</option>`);
    const ctx = document.querySelectorAll('.runctx .ctx .v');
    if (ctx[0]) {
      /* The SDK may not record the exact model; show the provider plus an
         explicit note and never borrow the pricing label as the model. */
      if (D.production.model_recorded === false) {
        ctx[0].innerHTML = `${esc(prodLabel)}<small class="faint" style="display:block;font-weight:500;letter-spacing:0;text-transform:none">${esc(reasonText(D.production.model_unavailable_reason))}</small>`;
        ctx[0].setAttribute('title', reasonText(D.production.model_unavailable_reason));
      } else ctx[0].textContent = prodLabel;
    }
    if (ctx[1]) ctx[1].textContent = hasChallenger ? chalLabel : 'not run';
    if (ctx[2]) ctx[2].textContent = `${D.run.id} \u00b7 ${D.run.state}`;
    // The pill sat above a body that says plainly the reference is another STT
    // model rather than human ground truth. "run ready" read as a stronger
    // claim than the page itself makes, so it names the method instead.
    setText('.mockflag', 'Live recorded data \u00b7 challenger via replay');
    document.title = `STT evaluation \u00b7 ${prodLabel}${hasChallenger ? ` vs ${chalLabel}` : ''}`;
  }

  /* ----------------------------------------------------- answer band */
  function bindAnswer() {
    const a = D.accuracy, r = D.risk, cost = D.cost;

    /* Connection-only capture: no turn-level STT was recorded at all. */
    if (noProdTurns) {
      const wc = (D.challenger && D.challenger.word_count) || 0;
      const kind = D.challenger && D.challenger.kind;
      const snippet = D.challenger && D.challenger.transcript ? D.challenger.transcript.trim().slice(0, 160) : '';
      setText('#verdictTitle', `No turn-level STT was captured for this call \u2013 the ${esc(kind || 'challenger')} challenger ${esc(chalLabel)} transcribed ${wc} word${wc === 1 ? '' : 's'}.`);
      const p = document.querySelector('.answer .vtext p');
      if (p) p.innerHTML = `This ${clock(D.duration_ms / 1000)} capture (run ${esc(D.run.state)}) contains only connection frames \u2013 no turn-level speech-to-text was recorded \u2013 so there is nothing to score turn-by-turn. The challenger transcribed${snippet ? `: \u201c${esc(snippet)}${D.challenger.transcript.length > 160 ? '\u2026' : ''}\u201d` : ` ${wc} words`}, which could not be aligned to any recorded production turn. This is a capture gap, not evidence that production mis-heard the caller.`;
      const host = document.querySelector('.answer .next');
      if (host) {
        host.innerHTML = `<span class="lbl">Do next</span><button class="nextbtn" type="button" data-go="transcript"><span class="n">1</span>Read the challenger transcript</button><button class="nextbtn info" type="button" data-go="replay"><span class="n">2</span>Listen to the caller audio</button>`;
        host.querySelectorAll('.nextbtn').forEach(btn => btn.addEventListener('click', () => call('selectView', btn.dataset.go)));
      }
      return;
    }

    /* Redacted capture: transcript text was not recorded, so accuracy is
       un-judgeable. This is explicitly NOT a production failure. */
    if (captureNotRecorded) {
      const nn = notCapturedIds.length;
      const la = lengthAgreement();
      const prodChars = la ? la.production_chars : (D.turns || []).reduce((s, t) => s + ((t.score && t.score.production_char_count) || 0), 0);
      const chalChars = la ? la.challenger_chars : (D.turns || []).reduce((s, t) => s + ((t.score && t.score.challenger_char_count) || 0), 0);
      setText('#verdictTitle', `This call\u2019s capture did not record production\u2019s transcript text, so its accuracy cannot be evaluated \u2013 a capture limitation, not a production failure.`);
      const p = document.querySelector('.answer .vtext p');
      if (p) p.innerHTML = `Production returned <b>${prodChars} characters</b> of transcript against the challenger\u2019s <b>${chalChars}</b> across ${(la ? la.turns : nn)} turns \u2013 comparable speech was captured, so production clearly heard the caller; only the words themselves were not recorded, so their correctness cannot be judged. Latency and cost are still measured below.`;
      const host = document.querySelector('.answer .next');
      if (host) {
        host.innerHTML = `<span class="lbl">Do next</span><button class="nextbtn" type="button" data-go="transcript"><span class="n">1</span>See what evidence the capture holds</button><button class="nextbtn info" type="button" data-go="latency"><span class="n">2</span>Review the measured timing and cost</button>`;
        host.querySelectorAll('.nextbtn').forEach(btn => btn.addEventListener('click', () => call('selectView', btn.dataset.go)));
      }
      return;
    }

    if (!hasChallenger || !accAvail) {
      const why = reasonText((a && a.reason) || (D.challenger ? 'not_evaluated' : 'no_challenger'));
      setText('#verdictTitle', `Review ${prodLabel} \u2013 no challenger comparison is available. ${why}`);
      const p = document.querySelector('.answer .vtext p');
      if (p) p.innerHTML = `${esc(why)} ${D.coverage.stt_turns} production STT turn${D.coverage.stt_turns === 1 ? '' : 's'} were captured on this call; run a challenger to score accuracy, semantic risk and cost.`;
      const host = document.querySelector('.answer .next');
      if (host) {
        host.innerHTML = `<span class="lbl">Do next</span><button class="nextbtn" type="button" data-go="transcript"><span class="n">1</span>Review the captured production transcripts</button><button class="nextbtn info" type="button" data-go="latency"><span class="n">2</span>Inspect production timing</button>`;
        host.querySelectorAll('.nextbtn').forEach(btn => btn.addEventListener('click', () => call('selectView', btn.dataset.go)));
      }
      return;
    }

    /* Production captured no words on every scored turn — the worst finding. */
    const allMissed = missedSpeechIds.length > 0 && missedSpeechIds.length === D.coverage.scored_turns;
    if (allMissed) {
      setText('#verdictTitle', `Production captured no words on ${missedSpeechIds.length} of ${D.coverage.stt_turns} turns while ${esc(chalLabel)} heard speech \u2013 the most damaging failure this tool can surface.`);
      const p = document.querySelector('.answer .vtext p');
      if (p) p.innerHTML = `Production returned an empty transcript on every scored turn, so the call-level WER is <b>${pctI(a.call_estimated_wer)}</b> (${a.errors} reference words, all missed).${riskAvail && (r.high_turn_ids || []).length ? ` The risk evaluator flagged ${r.high_turn_ids.length} turn${r.high_turn_ids.length === 1 ? '' : 's'} as outcome-changing (${esc(r.high_turn_ids.join(', '))}).` : ''} Verify the caller audio, then treat this as a capture outage rather than a model-quality gap.`;
      bindNext();
      return;
    }

    const costMore = has(cost.difference.per_month) && cost.difference.per_month > 0;
    const fpDelta = D.latency.delta && D.latency.delta.first_partial_ms ? D.latency.delta.first_partial_ms.p50 : null;
    const slower = has(fpDelta) && fpDelta > 0;

    const lead = costMore ? `Keep ${esc(prodLabel)} for now` : `Consider ${esc(chalLabel)}`;
    const costPhrase = has(cost.difference.per_month) ? `costs ${signRupee(cost.difference.per_month)}/month ${costMore ? 'more' : 'less'}, ` : '';
    const verdict = `${lead} \u2013 the challenger ${esc(chalLabel)} ${costPhrase}is ${slower ? 'slower' : 'no faster'} to first partial, and disagrees with production on ${pctI(a.call_estimated_wer)} of words across ${r.outcome_risk_turns} outcome-risk turn${r.outcome_risk_turns === 1 ? '' : 's'}.`;
    setText('#verdictTitle', verdict);

    const worst = (a.worst_turn_ids || []).slice(0, 3);
    const isSub = w => w.operation === 'substitution' && w.production_word && !/^\(/.test(w.production_word);
    /* Prefer an example where the reference is visibly wrong (a truncated /
       garbled challenger word), which best shows the reference is fallible. */
    const dwl = a.disagreed_words || [];
    const refWrong = dwl.find(w => isSub(w) && /[-\u2013]$/.test(String(w.challenger_word))) || dwl.find(isSub);
    const example = refWrong ? ` For example, production heard \u201c${esc(refWrong.production_word)}\u201d where ${esc(chalLabel)} heard \u201c${esc(refWrong.challenger_word)}\u201d \u2013 here the reference is the one that is wrong.` : '';
    const p = document.querySelector('.answer .vtext p');
    if (p) {
      p.innerHTML = `The two transcripts differ on <b>${a.errors} of ${a.reference_words}</b> words: ${a.substitutions} where they heard different words, ${a.deletions} the reference has that production does not, and ${a.insertions} the reverse. The reference is <b>${esc(chalLabel)}</b>, another STT model with its own errors \u2013 not human ground truth \u2013 so where they differ, either side may be right.${example} ${D.coverage.scored_turns} of ${D.coverage.stt_turns} turns were compared${worst.length ? `; the largest gaps are on turn${worst.length > 1 ? 's' : ''} ${worst.join(', ')}` : ''}.`;
    }
    bindNext();
  }

  function turnReason(id) {
    const t = (D.turns || []).find(x => String(x.turn_id) === String(id));
    if (!t) return '';
    const d = (t.score && t.score.diff || []).find(x => x.operation === 'substitution')
      || (t.score && t.score.diff || []).find(x => x.operation !== 'match');
    if (d && d.operation === 'substitution') return `production heard \u201c${d.production_word}\u201d, challenger \u201c${d.challenger_word}\u201d`;
    if (d && d.operation === 'deletion') return `production missed \u201c${d.challenger_word}\u201d`;
    if (d && d.operation === 'insertion') return `production added \u201c${d.production_word}\u201d`;
    if (t.score && t.score.status !== 'evaluated') return reasonText(t.score.status);
    return 'matches the reference';
  }

  function bindNext() {
    const host = document.querySelector('.answer .next');
    if (!host) return;
    const seen = new Set();
    const picks = [];
    (D.risk.high_turn_ids || []).forEach(id => { if (!seen.has(id)) { seen.add(id); picks.push({ id, tag: 'outcome risk' }); } });
    (D.accuracy.worst_turn_ids || []).forEach(id => { if (!seen.has(id)) { seen.add(id); picks.push({ id, tag: 'words off' }); } });
    const buttons = picks.slice(0, 2).map((pk, i) =>
      `<button class="nextbtn" type="button" data-go="transcript" data-turn="${esc(pk.id)}"><span class="n">${i + 1}</span>Turn ${esc(pk.id)} \u2013 ${esc(turnReason(pk.id))}</button>`).join('');
    host.innerHTML = `<span class="lbl">Do next</span>${buttons}<button class="nextbtn info" type="button" data-go="decide"><span class="n">${picks.slice(0, 2).length + 1}</span>See the full cost and capability comparison</button>`;
    host.querySelectorAll('.nextbtn').forEach(btn => btn.addEventListener('click', () => {
      call('selectView', btn.dataset.go);
      if (btn.dataset.turn) call('selectTurn', btn.dataset.turn);
    }));
  }

  /* ------------------------------------------------------- scorecards */
  function ratingClass(kind) {
    return { good: 'good', warn: 'warn', bad: 'bad', off: 'off' }[kind] || 'off';
  }
  function setRating(card, kind, label) {
    const el = card.querySelector('.head .rating');
    if (!el) return;
    el.className = `rating ${ratingClass(kind)}`;
    el.innerHTML = `<span class="d"></span>${esc(label)}`;
  }
  /* Set a scorecard's title text, working whether or not the why-trigger has
     wrapped it into a .lbl yet. */
  function setCardTitle(card, text) {
    const t = card.querySelector('.head .t');
    if (!t) return;
    const lbl = t.querySelector('.lbl') || t;
    lbl.textContent = text;
  }
  const vsBlock = parts => parts.map(p =>
    `<span class="${p.cls || (p.wide ? 'wide' : '')}"><i>${esc(p.k)}</i><em>${p.html || esc(p.v)}</em></span>`).join('');

  function unavailCard(card, ratingLabel, reason) {
    setRating(card, 'off', ratingLabel);
    const val = card.querySelector('.val');
    if (val) val.innerHTML = `<span class="big num" style="font-size:15px;line-height:1.25">No comparison</span><span class="of">${esc(reason)}</span>`;
    const vs = card.querySelector('.vs');
    if (vs) vs.innerHTML = `<span class="wide"><i>Why</i><em>${esc(reason)}</em></span>`;
  }

  function bindScorecards() {
    const cards = document.querySelectorAll('.scorebar .sc');
    const a = D.accuracy, r = D.risk, L = D.latency, cost = D.cost;
    const accReason = captureNotRecorded
      ? 'Transcript text was not recorded in this capture, so word error rate cannot be computed.'
      : reasonText((a && a.reason) || (hasChallenger ? 'not_evaluated' : 'no_challenger'));
    const riskReason = captureNotRecorded
      ? 'Production transcript was not recorded, so semantic risk could not be assessed.'
      : reasonText((r && r.reason) || (hasChallenger ? 'not_evaluated' : 'no_challenger'));
    const costChal = cost.challenger || {};

    /* Card 0 — transcript disagreement vs the reference STT (NOT a production
       error rate: the reference is another STT model with its own errors). */
    if (cards[0]) {
      const la = lengthAgreement();
      if (captureNotRecorded && la) {
        setCardTitle(cards[0], 'Transcript length recorded');
        setRating(cards[0], 'off', 'Length only');
        cards[0].querySelector('.val').innerHTML = `<span class="big num">${la.production_chars} / ${la.challenger_chars}</span><span class="of">characters captured \u00b7 not a correctness score</span>`;
        cards[0].querySelector('.vs').innerHTML = vsBlock([
          { k: prodLabel, v: `${la.production_chars} chars` },
          { k: chalLabel, v: `${la.challenger_chars} chars` },
          { k: 'Turns', v: `${la.turns}` }
        ]);
      } else if (!accAvail || !has(a.call_estimated_wer)) { setCardTitle(cards[0], 'Where the two models disagree'); unavailCard(cards[0], captureNotRecorded ? 'Not recorded' : 'No score', accReason); }
      else {
        const band = a.call_band;
        setCardTitle(cards[0], 'Where the two models disagree');
        setRating(cards[0], band === 'low' ? 'good' : band === 'moderate' ? 'warn' : band === 'high' ? 'bad' : 'off',
          band === 'low' ? 'Aligned' : band === 'moderate' ? 'Some drift' : band === 'high' ? 'High divergence' : 'No score');
        cards[0].querySelector('.val').innerHTML = `<span class="big num">${pctI(a.call_estimated_wer)}</span><span class="of">the two STT systems disagree \u00b7 not a production error rate</span>`;
        cards[0].querySelector('.vs').innerHTML = vsBlock([
          { k: prodLabel, v: `${a.errors} differ` },
          { k: chalLabel, v: 'reference STT' },
          { k: 'Scored', v: `${D.coverage.scored_turns} / ${D.coverage.stt_turns}` }
        ]);
      }
    }

    /* Card 1 — outcome-risk turns */
    if (cards[1]) {
      if (!riskAvail || noProdTurns || D.coverage.risk_evaluated_turns === 0) unavailCard(cards[1], captureNotRecorded ? 'Not recorded' : 'Not scored', noProdTurns ? 'No turn-level STT was captured, so there is nothing to evaluate for risk.' : riskReason);
      else {
        const n = r.outcome_risk_turns;
        setRating(cards[1], n >= 3 ? 'bad' : n >= 1 ? 'warn' : 'good', n >= 3 ? 'Act now' : n >= 1 ? 'Watch' : 'Clear');
        cards[1].querySelector('.val').innerHTML = `<span class="big num">${n}</span><span class="of">${r.counts.high} high-risk \u00b7 ${D.coverage.unscored_turns} unscored</span>`;
        const ids = (r.high_turn_ids || []).concat(r.medium_turn_ids || []);
        cards[1].querySelector('.vs').innerHTML = `<span class="wide"><i>${esc((r.critical_terms || []).slice(0, 3).join(' \u00b7 ')) || 'critical values'}</i><em>${ids.length ? `Turn${ids.length > 1 ? 's' : ''} ${esc(ids.join(', '))} \u2013 where a wrong word changes the outcome.` : 'No turn changed a business outcome.'}</em></span>`;
      }
    }

    /* Card 2 — caller wait (production only, always measured) */
    if (cards[2]) {
      const w = L.production.caller_wait_ms.p50;
      const share = has(L.budget.stt_share.p50) ? pctI(L.budget.stt_share.p50) : null;
      if (!has(w)) unavailCard(cards[2], 'No timing', 'No caller-wait timing was measured on this call.');
      else {
        setRating(cards[2], w < 1000 ? 'good' : w <= 1800 ? 'warn' : 'bad', w < 1000 ? 'Good' : w <= 1800 ? 'Watch' : 'Act now');
        cards[2].querySelector('.val').innerHTML = `<span class="big num">${fmtMs(w)}</span><span class="of">${share ? `STT is ${share} of the wait` : 'STT share not computed'}</span>`;
        cards[2].querySelector('.vs').innerHTML = vsBlock([
          { k: prodLabel, v: fmtMs(w) },
          { k: hasChallenger ? chalLabel : 'challenger', v: hasChallenger ? 'replay only' : 'not run' },
          { k: 'STT share', v: share || 'not computed' }
        ]);
      }
    }

    /* Card 3 — turn-end detection (challenger minus production) */
    if (cards[3]) {
      const d = L.delta && L.delta.endpoint_delay_ms && L.delta.endpoint_delay_ms.count ? L.delta.endpoint_delay_ms : null;
      const dv = d ? d.p50 : null;
      const chalEp = L.challenger && L.challenger.available !== false && L.challenger.endpoint_delay_ms ? L.challenger.endpoint_delay_ms.p50 : null;
      if (!has(dv)) unavailCard(cards[3], 'No pair', hasChallenger ? 'No turn had a comparable challenger turn-end.' : reasonText((L.challenger && L.challenger.reason) || 'no_streaming_replay'));
      else {
        const prodFfw = L.production.final_from_last_word_ms ? L.production.final_from_last_word_ms.p50 : null;
        setRating(cards[3], dv <= -100 ? 'good' : dv < 100 ? 'warn' : 'bad', dv < 0 ? 'Faster' : dv > 0 ? 'Slower' : 'Same');
        cards[3].querySelector('.val').innerHTML = `<span class="big num">${signMs(dv)}</span><span class="of">last word \u2192 final \u00b7 median of ${d.count} per-turn \u0394</span>`;
        cards[3].querySelector('.vs').innerHTML = vsBlock([
          { k: prodLabel, v: has(prodFfw) ? fmtMs(prodFfw) : 'no timing' },
          { k: chalLabel, v: has(chalEp) ? fmtMs(chalEp) : 'no pair' },
          { k: '\u0394 paired', v: signMs(dv) }
        ]);
      }
    }

    /* Card 4 — cost */
    if (cards[4]) {
      const prodPm = cost.production.per_minute, chalPm = costChal.per_minute;
      if (has(prodPm) && has(chalPm) && has(cost.difference.per_month)) {
        const more = cost.difference.per_month > 0;
        setRating(cards[4], more ? 'bad' : 'good', `${more ? '+' : MINUS}${Math.abs(Math.round(cost.difference.per_minute_percent * 100))}%`);
        cards[4].querySelector('.val').innerHTML = `<span class="big num" id="scoreMonthlySaving">${signRupee(cost.difference.per_month)}</span><span class="of">per month ${more ? 'more' : 'less'}</span>`;
        cards[4].querySelector('.vs').innerHTML = vsBlock([
          { k: prodLabel, v: `${rupee(prodPm)}/min` },
          { k: chalLabel, v: `${rupee(chalPm)}/min` },
          { k: 'a year', cls: 'dl', html: `<em id="scoreYearlySaving">${signRupee(cost.difference.per_year)}</em>` }
        ]);
        const sub = cards[4].querySelector('.sub');
        if (sub) sub.innerHTML = `Per minute of audio, at <b id="scoreVolume"></b>. Published list pricing, ${esc(cost.pricing_version)}.`;
      } else if (has(prodPm)) {
        setRating(cards[4], 'off', 'Production only');
        cards[4].querySelector('.val').innerHTML = `<span class="big num" id="scoreMonthlySaving">${rupee(prodPm)}</span><span class="of">per minute \u00b7 production only</span>`;
        cards[4].querySelector('.vs').innerHTML = vsBlock([
          { k: prodLabel, v: `${rupee(prodPm)}/min` },
          { k: chalLabel, v: hasChallenger ? 'no rate' : 'not run' },
          { k: 'a year', cls: 'dl', html: `<em id="scoreYearlySaving">${rupee(cost.production.per_month * 12)}</em>` }
        ]);
        const sub = cards[4].querySelector('.sub');
        if (sub) sub.innerHTML = `Priced as <b>${esc(cost.production.label)}</b> at <b id="scoreVolume"></b>. Published list pricing, ${esc(cost.pricing_version)}.`;
      } else if (has(chalPm)) {
        setRating(cards[4], 'off', 'Challenger only');
        cards[4].querySelector('.val').innerHTML = `<span class="big num" id="scoreMonthlySaving">${rupee(chalPm)}</span><span class="of">per minute \u00b7 challenger only</span>`;
        cards[4].querySelector('.vs').innerHTML = vsBlock([
          { k: prodLabel, v: 'not priced' },
          { k: chalLabel, v: `${rupee(chalPm)}/min` },
          { k: 'a year', cls: 'dl', html: `<em id="scoreYearlySaving">${rupee(costChal.per_month * 12)}</em>` }
        ]);
        const sub = cards[4].querySelector('.sub');
        if (sub) sub.innerHTML = `Production has no recorded rate; challenger priced as <b>${esc(costChal.label)}</b> at <b id="scoreVolume"></b>. Published list pricing, ${esc(cost.pricing_version)}.`;
      } else {
        unavailCard(cards[4], 'No pricing', 'Neither model has a recorded rate for this call.');
      }
    }

    /* Card 5 — trust */
    if (cards[5]) {
      setRating(cards[5], D.run.state === 'ready' ? 'good' : D.run.state === 'partial' ? 'warn' : 'bad',
        D.run.state === 'ready' ? 'Complete run' : D.run.state === 'partial' ? 'Partial run' : D.run.state === 'not_run' ? 'Not run' : D.run.state);
      const trows = cards[5].querySelectorAll('.trow em');
      const timed = D.latency.delta && D.latency.delta.paired_turns != null ? D.latency.delta.paired_turns : D.coverage.paired_timing_turns;
      const wall = D.challenger && D.challenger.streaming ? D.challenger.streaming.wall_clock_ms : null;
      const evTotal = D.cost.evaluation && has(D.cost.evaluation.total) ? rupee(D.cost.evaluation.total) : null;
      const testCost = hasChallenger ? `${evTotal || 'usage not reported'}${has(wall) ? ` \u00b7 ${fmtMs(wall)} replay` : ''}` : 'challenger not run';
      const values = [hasChallenger ? chalLabel : 'not run', `${D.coverage.scored_turns} of ${D.coverage.stt_turns}`, `${timed} of ${D.coverage.stt_turns}`, testCost];
      trows.forEach((em, i) => { if (values[i] != null) em.textContent = values[i]; });
      const sub = cards[5].querySelector('.sub');
      if (sub) {
        if (!hasChallenger) sub.innerHTML = `<b>No challenger was run.</b> Only production evidence is shown; accuracy, semantic risk and cost comparison need a challenger transcript.`;
        else if (captureNotRecorded) sub.innerHTML = `<b>Transcript text was not recorded in this capture.</b> Accuracy and semantic risk cannot be scored here \u2013 a capture limitation, not a production failure. Latency and cost below are measured.`;
        else sub.innerHTML = `<b>${D.coverage.unscored_turns} turn${D.coverage.unscored_turns === 1 ? '' : 's'} unscored</b> \u2013 ${(D.coverage.challenger_no_text_turn_ids || []).length ? `challenger returned no text on turn ${esc((D.coverage.challenger_no_text_turn_ids || []).join(', '))}` : 'a model returned nothing'}, never counted as 0% or 100%. <b>Verify by ear</b> before you promote.`;
      }
    }

    /* Meters read from the mockup's METERS object. */
    const werReal = has(a.call_estimated_wer);
    const riskReal = riskAvail;
    const waitReal = has(L.production.caller_wait_ms.p50);
    const endpointReal = L.delta && L.delta.endpoint_delay_ms && has(L.delta.endpoint_delay_ms.p50);
    if (typeof METERS !== 'undefined') {
      if (METERS.wer && werReal) METERS.wer.value = +(a.call_estimated_wer * 100).toFixed(1);
      if (METERS.risk && riskReal) METERS.risk.value = r.outcome_risk_turns;
      if (METERS.wait && waitReal) METERS.wait.value = +(L.production.caller_wait_ms.p50 / 1000).toFixed(2);
      if (METERS.endpoint && endpointReal) METERS.endpoint.value = Math.round(L.delta.endpoint_delay_ms.p50);
    }
    call('renderMeters');
    /* A meter whose metric is unavailable would otherwise show the mockup's
       illustrative pin — clear those so no fabricated position survives. */
    const clearMeter = key => document.querySelectorAll(`[data-meter="${key}"]`).forEach(el => { el.innerHTML = ''; });
    if (!werReal) clearMeter('wer');
    if (!riskReal) clearMeter('risk');
    if (!waitReal) clearMeter('wait');
    if (!endpointReal) clearMeter('endpoint');
  }

  /* --------------------------------------------------- decision table */
  function verdictOf(prod, chal, lowerBetter) {
    if (!has(prod) || !has(chal)) return 'na';
    const d = chal - prod;
    if (d === 0) return 'tie';
    const chalBetter = lowerBetter ? d < 0 : d > 0;
    return chalBetter ? 'challenger' : 'production';
  }
  function vchip(verdict, cat) {
    if (verdict === 'challenger') return `<span data-verdict="challenger"${cat ? ` data-cat="${cat}"` : ''} class="rating good"><span class="d"></span>Challenger</span>`;
    if (verdict === 'production') return `<span data-verdict="production" class="rating warn"><span class="d"></span>Production</span>`;
    if (verdict === 'tie') return `<span data-verdict="tie" class="rating off">Tie</span>`;
    return `<span class="rating off">Not comparable</span>`;
  }
  function drow(o) {
    const dcls = o.verdict === 'challenger' ? ' good' : o.verdict === 'production' ? ' bad' : '';
    const label = o.why ? `<span data-why="${esc(o.why)}">${esc(o.label)}</span>` : esc(o.label);
    return `<tr><td class="lbl">${label}</td>` +
      `<td class="v"${o.idP ? ` id="${o.idP}"` : ''}>${o.p}</td>` +
      `<td class="v"${o.idC ? ` id="${o.idC}"` : ''}>${o.c}</td>` +
      `<td class="d${dcls}"${o.idD ? ` id="${o.idD}"` : ''}>${o.d}</td>` +
      `<td class="w">${vchip(o.verdict, o.cat)}</td></tr>`;
  }
  const grp = (title, sub, subId) => `<tr class="grp"><td colspan="5"><b>${esc(title)}</b><span${subId ? ` id="${subId}"` : ''}>${esc(sub)}</span></td></tr>`;

  function bindDecision() {
    const head = document.querySelector('#decide .h2h thead tr');
    if (head) head.innerHTML = `<th scope="col">Dimension</th><th scope="col" class="pcol">Production<br>${esc(prodLabel)}</th><th scope="col" class="ccol">Challenger<br>${esc(hasChallenger ? chalLabel : 'not run')}</th><th scope="col">Difference</th><th scope="col">Verdict</th>`;

    const a = D.accuracy, r = D.risk, cov = D.coverage, L = D.latency, cost = D.cost;
    const pc = D.production.capabilities;
    const body = document.querySelector('#decide .h2h tbody');

    /* Production recorded no STT turns; only the challenger transcribed. */
    if (noProdTurns && hasChallenger) {
      const map = D.challenger.mapping_summary || {};
      const cc0 = D.challenger.capabilities || {};
      const yn1 = b => b ? 'Yes' : 'No';
      const chalP = has((cost.challenger || {}).per_minute);
      if (body) body.innerHTML = [
        grp('No turn-level STT captured', `${D.challenger.word_count || 0} challenger words could not be aligned to any recorded production turn`),
        drow({ label: 'Production STT turns', why: 'Reference transcript', p: '0 recorded', c: `${D.challenger.word_count || 0} words`, d: 'capture gap', verdict: 'na' }),
        drow({ label: 'Words mapped to a turn', why: 'Word error rate vs reference', p: 'none', c: `${map.mapped_word_count || 0} of ${map.word_count || 0}`, d: `${map.unmapped_word_count || 0} unmapped`, verdict: 'na' }),
        grp('Challenger capabilities', `Recorded from the ${esc(D.challenger.kind || 'challenger')} run`),
        drow({ label: 'Streaming partial results', why: 'Streaming partial results', p: 'no turns', c: yn1(cc0.streaming_partials), d: 'challenger only', verdict: 'na' }),
        drow({ label: 'Word-level timestamps', why: 'Word-level timestamps', p: 'no turns', c: yn1(cc0.word_timestamps), d: 'challenger only', verdict: 'na' }),
        grp('What it costs', `Challenger priced as ${esc((cost.challenger || {}).label || 'not recorded')}`),
        drow({ label: 'Price per minute of audio', why: 'Cost to serve', p: 'not priced', c: chalP ? rupee(cost.challenger.per_minute) : 'not run', d: 'challenger only', verdict: 'na', cat: 'cost' })
      ].join('');
      setText('#decide .qh h2', `No turn-level STT captured`);
      const h2span = document.querySelector('#decide .card > header .qh span');
      if (h2span) h2span.textContent = `${D.challenger.word_count || 0} challenger words \u00b7 ${D.session_id}`;
      const overall = document.querySelector('#decide .card > header .right .rating');
      if (overall) { overall.className = 'rating off'; overall.innerHTML = `<span class="d"></span>No STT captured`; }
      return;
    }

    /* Redacted capture: transcript text not recorded. Show the honest signals
       (length, latency, cost) and never imply a production accuracy failure. */
    if (captureNotRecorded) {
      const map = D.challenger.mapping_summary || {};
      const cc0 = D.challenger.capabilities || {};
      const yn1 = b => b ? 'Yes' : 'No';
      const la = lengthAgreement();
      const prodChars = la ? la.production_chars : (D.turns || []).reduce((s, t) => s + ((t.score && t.score.production_char_count) || 0), 0);
      const chalChars = la ? la.challenger_chars : (D.turns || []).reduce((s, t) => s + ((t.score && t.score.challenger_char_count) || 0), 0);
      const cw = L.production.caller_wait_ms.p50;
      const cep = L.challenger && L.challenger.endpoint_delay_ms ? L.challenger.endpoint_delay_ms.p50 : null;
      const costRows = has(cost.production.per_minute) && has((cost.challenger || {}).per_minute) ? [
        grp('What it costs', `List price \u00b7 ${compactCount(cost.volume.calls_per_month)} calls a month \u00b7 ${minLabel(cost.volume.average_call_minutes)} average`, 'h2hCostVolume'),
        drow({ label: 'Price per minute of audio', why: 'Cost to serve', p: rupee(cost.production.per_minute), c: rupee(cost.challenger.per_minute), d: `${cost.difference.per_minute > 0 ? '+' : MINUS}${Math.abs(Math.round(cost.difference.per_minute_percent * 100))}%`, verdict: verdictOf(cost.production.per_minute, cost.challenger.per_minute, true), cat: 'cost' }),
        drow({ label: 'Projected spend per month', why: 'Projected monthly spend', p: rupee(cost.production.per_month), c: rupee(cost.challenger.per_month), d: signRupee(cost.difference.per_month), verdict: verdictOf(cost.production.per_month, cost.challenger.per_month, true), cat: 'cost', idP: 'h2hMonthlyProd', idC: 'h2hMonthlyChal', idD: 'h2hMonthlySave' })
      ] : [];
      if (body) body.innerHTML = [
        grp('What the capture can tell us', `Transcript text was not recorded, so this shows whether comparable speech was heard \u2013 not whether the words were correct`),
        drow({ label: 'Transcript length (characters)', why: 'Word error rate vs reference', p: `${prodChars} chars`, c: `${chalChars} chars`, d: `${prodChars === chalChars ? 'equal length' : (prodChars > chalChars ? '+' : MINUS) + Math.abs(prodChars - chalChars)}`, verdict: 'na' }),
        drow({ label: 'Production transcript text', why: 'Reference transcript', p: 'not recorded', c: `${D.challenger.word_count || 0} words`, d: 'capture limitation', verdict: 'na' }),
        drow({ label: 'Word error rate and semantic risk', why: 'Estimated WER', p: 'needs transcript text', c: 'reference ready', d: 'not evaluable', verdict: 'na', cat: 'quality' }),
        grp('How fast it replied', `Caller-audio timing was measured on ${L.production.caller_wait_ms.count} turn${L.production.caller_wait_ms.count === 1 ? '' : 's'}`),
        drow({ label: 'Caller waits for a reply', why: 'Caller-perceived wait', p: msR(cw, 'no production timing'), c: '<span class="faint">replay only</span>', d: '<span class="faint">production timeline</span>', verdict: 'na' }),
        drow({ label: 'Silence \u2192 turn declared over', why: 'Production endpoint', p: `<span class="faint">${esc(reasonText('speech_end_milestone_not_recorded'))}</span>`, c: has(cep) ? fmtMs(cep) : '<span class="faint">no stream turn-end</span>', d: '<span class="faint">not measurable</span>', verdict: 'na', cat: 'speed' }),
        ...costRows,
        grp('Can you actually run it', 'Capabilities your pipeline depends on today'),
        drow({ label: 'Streaming partial results', why: 'Streaming partial results', p: yn1(pc.streaming_partials), c: yn1(cc0.streaming_partials), d: pc.streaming_partials === cc0.streaming_partials ? 'same' : 'differs', verdict: capVerdict(pc.streaming_partials, cc0.streaming_partials) }),
        drow({ label: 'Word-level timestamps', why: 'Word-level timestamps', p: yn1(pc.word_timestamps), c: yn1(cc0.word_timestamps), d: pc.word_timestamps === cc0.word_timestamps ? 'same' : 'capability differs', verdict: capVerdict(pc.word_timestamps, cc0.word_timestamps) })
      ].join('');
      setText('#decide .qh h2', `Accuracy cannot be judged \u2013 transcript not recorded`);
      const h2span = document.querySelector('#decide .card > header .qh span');
      if (h2span) h2span.textContent = `Capture stored length only \u00b7 ${D.session_id}`;
      const overall = document.querySelector('#decide .card > header .right .rating');
      if (overall) { overall.className = 'rating off'; overall.innerHTML = `<span class="d"></span>Transcript not recorded`; }
      return;
    }

    /* No challenger: production-only comparison with an explicit reason. */
    if (!hasChallenger) {
      const reason = reasonText((a && a.reason) || 'no_challenger');
      const yn0 = b => b ? 'Yes' : 'No';
      if (body) body.innerHTML = [
        grp('No challenger to compare against', reason),
        drow({ label: 'Challenger transcript', why: 'Reference transcript', p: `${cov.transcript_turns} production transcripts`, c: 'not run', d: reason, verdict: 'na' }),
        drow({ label: 'Accuracy, risk and cost comparison', why: 'Word error rate vs reference', p: `${cov.stt_turns} STT turns captured`, c: 'not run', d: 'needs a challenger', verdict: 'na' }),
        grp('Production capabilities', 'Recorded from the live production stream'),
        drow({ label: 'Streaming partial results', why: 'Streaming partial results', p: yn0(pc.streaming_partials), c: 'not run', d: 'production only', verdict: 'na' }),
        drow({ label: 'Word-level timestamps', why: 'Word-level timestamps', p: yn0(pc.word_timestamps), c: 'not run', d: 'production only', verdict: 'na' }),
        drow({ label: 'Confidence scores', p: yn0(pc.confidence_scores), c: 'not run', d: 'production only', verdict: 'na' }),
        drow({ label: 'VAD events', p: yn0(pc.vad_events), c: 'not run', d: 'production only', verdict: 'na' }),
        grp('What it costs', `Production list price \u00b7 priced as ${cost.production.label}`),
        drow({ label: 'Price per minute of audio', why: 'Cost to serve', p: rupee(cost.production.per_minute), c: 'not run', d: 'production only', verdict: 'na', cat: 'cost' })
      ].join('');
      setText('#decide .qh h2', `Review ${prodLabel}`);
      const h2span = document.querySelector('#decide .card > header .qh span');
      if (h2span) h2span.textContent = `${reason} \u00b7 ${D.session_id}`;
      const overall = document.querySelector('#decide .card > header .right .rating');
      if (overall) { overall.className = 'rating off'; overall.innerHTML = `<span class="d"></span>No challenger`; }
      return;
    }

    const cc = D.challenger.capabilities || {};
    const shape = L.shape, bi = L.barge_in || {};
    const biAvail = bi.available !== false;
    const LC = L.challenger || {};
    const lcAvail = LC.available !== false;
    const yn = b => b ? 'Yes' : 'No';
    const chalEp = lcAvail && LC.endpoint_delay_ms ? LC.endpoint_delay_ms.p50 : null;
    const chalEpCount = lcAvail && LC.endpoint_delay_ms ? LC.endpoint_delay_ms.count : null;
    const chalFp = lcAvail && LC.first_partial_ms ? LC.first_partial_ms.p50 : null;
    const chalMissingFinal = lcAvail ? LC.missing_final_count : null;
    const prodFfw = L.production.final_from_last_word_ms ? L.production.final_from_last_word_ms.p50 : null;
    const map = D.challenger.mapping_summary || {};

    const fpDelta = L.delta && L.delta.first_partial_ms ? L.delta.first_partial_ms.p50 : null;
    const epDelta = L.delta && L.delta.endpoint_delay_ms ? L.delta.endpoint_delay_ms.p50 : null;

    if (body) body.innerHTML = [
      grp('What was heard', `Production vs ${chalLabel} (a second STT model, not ground truth) \u00b7 ${cov.scored_turns} compared turns`),
      drow({ label: 'Transcript coverage', why: 'Reference transcript', p: `${cov.transcript_turns} of ${cov.stt_turns}`, c: `${map.mapped_word_count} of ${map.word_count} words`, d: `${cov.unscored_turns} unscored`, verdict: 'tie', cat: 'reliability' }),
      drow({ label: 'Where the transcripts disagree', why: 'Word error rate vs reference', p: accAvail ? `${a.errors} of ${a.reference_words} \u00b7 ${pctI(a.call_estimated_wer)}` : reasonText(a.reason), c: `reference STT (${chalLabel})`, d: accAvail ? `${a.errors} words differ` : 'no score', verdict: 'na', cat: 'quality' }),
      drow({ label: 'Different \u00b7 only in reference \u00b7 only in production', why: 'Error type breakdown', p: accAvail ? `${a.substitutions} \u00b7 ${a.deletions} \u00b7 ${a.insertions}` : reasonText(a.reason), c: 'either side may be right', d: accAvail ? `${a.errors} differ` : 'no score', verdict: 'na', cat: 'quality' }),
      drow({ label: 'Outcome-risk turns where they differ', why: "Risk flag (currently \u2018Semantic Risk\u2019)", p: riskAvail ? `${r.outcome_risk_turns} of ${cov.risk_evaluated_turns}` : reasonText(r.reason), c: 'reviewed by ear', d: riskAvail ? `${r.outcome_risk_turns} to check` : 'not assessed', verdict: 'na', cat: 'quality' }),
      drow({ label: 'Turns where the model returned no text', why: 'Unscored turns', p: `${(cov.production_no_text_turn_ids || []).length}`, c: `${(cov.challenger_no_text_turn_ids || []).length}`, d: verdictSign((cov.production_no_text_turn_ids || []).length, (cov.challenger_no_text_turn_ids || []).length), verdict: verdictOf((cov.production_no_text_turn_ids || []).length, (cov.challenger_no_text_turn_ids || []).length, true), cat: 'reliability' }),
      drow({ label: 'Turns with no clean turn-final', why: 'Finalization reason', p: `${shape.non_turn_final_count}`, c: has(chalMissingFinal) ? `${chalMissingFinal}` : 'no stream run', d: has(chalMissingFinal) ? verdictSign(shape.non_turn_final_count, chalMissingFinal) : 'no pair', verdict: has(chalMissingFinal) ? verdictOf(shape.non_turn_final_count, chalMissingFinal, true) : 'na', cat: 'reliability' }),

      grp('How fast it replied', `Both models timed on the same turns \u00b7 each comparison over its own paired count \u00b7 challenger from a 1\u00d7 replay`),
      drow({ label: 'Caller waits for a reply', why: 'Caller-perceived wait', p: msR(L.production.caller_wait_ms.p50, 'no production timing'), c: '<span class="faint">replay only</span>', d: '<span class="faint">production timeline</span>', verdict: 'na' }),
      drow({ label: 'Last word \u2192 final transcript', why: 'Production endpoint', p: msR(prodFfw, 'no production timing'), c: has(chalEp) ? `${fmtMs(chalEp)}<small class="faint"> ${chalEpCount} turn</small>` : '<span class="faint">no stream turn-end</span>', d: has(epDelta) ? signMs(epDelta) : 'no pair', verdict: has(chalEp) && has(prodFfw) ? verdictOf(prodFfw, chalEp, true) : 'na', cat: 'speed' }),
      drow({ label: 'First partial delivered to app', why: 'Production first partial', p: msR(L.production.first_partial_ms.p50, 'no production partials'), c: has(chalFp) ? fmtMs(chalFp) : '<span class="faint">no stream partial</span>', d: has(fpDelta) ? signMs(fpDelta) : 'no pair', verdict: has(chalFp) && has(L.production.first_partial_ms.p50) ? verdictOf(L.production.first_partial_ms.p50, chalFp, true) : 'na', cat: 'speed' }),
      drow({ label: 'Cut at the right moment', why: 'Endpoint position error', p: has(L.production.endpoint_position_error_ms.p50) ? `${signMs(L.production.endpoint_position_error_ms.p50)}<small class="faint"> late</small>` : '<span class="faint">no production timing</span>', c: '<span class="faint">no reference turn-end</span>', d: '<span class="faint">production timeline</span>', verdict: 'na' }),
      drow({ label: 'Turns split or merged wrongly', why: 'Split, merged and manually-intervened turns', p: '0', c: `${shape.split_or_merged_count} of ${shape.measured_turns}`, d: `+${shape.split_or_merged_count}`, verdict: shape.split_or_merged_count ? 'production' : 'tie', cat: 'reliability' }),
      drow({ label: 'Caller talked over the agent', why: 'Barge-in overlap', p: biAvail ? `${bi.count} of ${bi.measured_turns}` : reasonText(bi.reason), c: biAvail ? 'same call' : 'no agent audio', d: biAvail ? '0' : 'no agent audio', verdict: biAvail ? 'tie' : 'na', cat: 'reliability' }),

      grp('What it costs', `List price \u00b7 ${compactCount(cost.volume.calls_per_month)} calls a month \u00b7 ${minLabel(cost.volume.average_call_minutes)} average`, 'h2hCostVolume'),
      drow({ label: 'Price per minute of audio', why: 'Cost to serve', p: rupee(cost.production.per_minute), c: rupee(cost.challenger.per_minute), d: `${cost.difference.per_minute > 0 ? '+' : MINUS}${Math.abs(Math.round(cost.difference.per_minute_percent * 100))}%`, verdict: verdictOf(cost.production.per_minute, cost.challenger.per_minute, true), cat: 'cost' }),
      drow({ label: `This call \u00b7 ${D.call_minutes.toFixed(2)} min`, why: 'Cost to serve', p: rupee(cost.production.per_call), c: rupee(cost.challenger.per_call), d: signRupee(cost.difference.per_call), verdict: verdictOf(cost.production.per_call, cost.challenger.per_call, true), cat: 'cost' }),
      drow({ label: 'Projected spend per month', why: 'Projected monthly spend', p: rupee(cost.production.per_month), c: rupee(cost.challenger.per_month), d: signRupee(cost.difference.per_month), verdict: verdictOf(cost.production.per_month, cost.challenger.per_month, true), cat: 'cost', idP: 'h2hMonthlyProd', idC: 'h2hMonthlyChal', idD: 'h2hMonthlySave' }),
      drow({ label: 'Hosting and on-call', why: 'Total cost of switching', p: esc(cost.production.hosting), c: esc(cost.challenger.hosting), d: cost.production.hosting === cost.challenger.hosting ? 'same' : 'differs', verdict: cost.production.hosting === cost.challenger.hosting ? 'tie' : 'na', cat: 'cost' }),

      grp('Did it hold up on this call', 'Transport-level behaviour \u2013 a model that fails calls is a no at any price'),
      drow({ label: 'Streaming replay completed', why: 'Request reliability', p: 'Yes', c: streamStatus(), d: 'same', verdict: 'tie', cat: 'reliability' }),

      grp('Can you actually run it', 'Capabilities your pipeline depends on today'),
      drow({ label: 'Streaming partial results', why: 'Streaming partial results', p: yn(pc.streaming_partials), c: yn(cc.streaming_partials), d: pc.streaming_partials === cc.streaming_partials ? 'same' : 'differs', verdict: capVerdict(pc.streaming_partials, cc.streaming_partials) }),
      drow({ label: 'Word-level timestamps', why: 'Word-level timestamps', p: yn(pc.word_timestamps), c: yn(cc.word_timestamps), d: pc.word_timestamps === cc.word_timestamps ? 'same' : 'capability differs', verdict: capVerdict(pc.word_timestamps, cc.word_timestamps) }),
      drow({ label: 'Confidence scores', p: yn(pc.confidence_scores), c: yn(cc.confidence_scores), d: pc.confidence_scores === cc.confidence_scores ? 'same' : 'capability differs', verdict: capVerdict(pc.confidence_scores, cc.confidence_scores) }),
      drow({ label: 'Language support', why: 'Code-switching support', p: (pc.languages || []).length ? esc((pc.languages || []).join(', ')) : 'not reported', c: (cc.languages || []).length ? esc((cc.languages || []).join(', ')) : 'not reported', d: 'lists differ', verdict: 'na' }),
      drow({ label: 'VAD events', p: yn(pc.vad_events), c: yn(cc.vad_events), d: pc.vad_events === cc.vad_events ? 'same' : 'differs', verdict: capVerdict(pc.vad_events, cc.vad_events) })
    ].join('');

    /* Header text + overall chip. */
    setText('#decide .qh h2', `Can ${chalLabel} replace ${prodLabel}?`);
    setText('#decide header .qh + .right .rating, #decide .card > header .right .rating', '');
    const h2span = document.querySelector('#decide .card > header .qh span');
    if (h2span) h2span.textContent = `Every dimension, side by side \u00b7 one call \u00b7 ${D.session_id}`;
    const overall = document.querySelector('#decide .card > header .right .rating');
    if (overall) {
      const costMore = cost.difference.per_month > 0;
      overall.className = `rating ${costMore ? 'warn' : 'good'}`;
      overall.innerHTML = `<span class="d"></span>${costMore ? 'Keep production' : 'Switch worth testing'}`;
    }
  }
  function verdictSign(p, c) { const d = c - p; return d === 0 ? '0' : d > 0 ? `+${d}` : `${MINUS}${Math.abs(d)}`; }
  function capVerdict(p, c) { return p === c ? 'tie' : c && !p ? 'challenger' : 'production'; }
  function streamStatus() {
    const run = (D.run.runs || []).find(x => x.kind === 'streaming');
    return run ? (run.status === 'complete' ? 'Yes' : esc(run.status)) : 'Yes';
  }

  /* --------------------------------------------------------- cost panel */
  function bindCost() {
    const cost = D.cost;
    const chal = cost.challenger || {};
    const prodP = has(cost.production.per_minute);
    const chalP = has(chal.per_minute);
    const pCell = (v, absent) => prodP ? v : absent;
    const cCell = (v, absent) => chalP ? v : absent;
    /* Static (non-id) cost rows. */
    const rows = document.querySelectorAll('#decide .cost .costrow');
    if (rows[0]) {
      rows[0].querySelector('.p').textContent = pCell(rupee(cost.production.per_minute), 'not priced');
      rows[0].querySelector('.c').textContent = cCell(rupee(chal.per_minute), 'not run');
      rows[0].querySelector('.n').innerHTML = `${prodP ? `Production priced as <b>${esc(cost.production.label)}</b>` : 'Production has no recorded rate'}${chalP ? ` vs <b>${esc(chal.label)}</b>` : ''}, published list price.`;
    }
    if (rows[1]) {
      rows[1].querySelector('b').textContent = `This call \u00b7 ${D.call_minutes.toFixed(2)} min`;
      rows[1].querySelector('.p').textContent = pCell(rupee(cost.production.per_call), 'not priced');
      rows[1].querySelector('.c').textContent = cCell(rupee(chal.per_call), 'not run');
      rows[1].querySelector('.n').innerHTML = has(cost.difference.per_call)
        ? `A ${cost.difference.per_call > 0 ? 'rise' : 'saving'} of ${rupee(Math.abs(cost.difference.per_call))} on one call.`
        : prodP ? 'Run a challenger to compare per-call cost.' : 'Production recorded no billable STT, so it has no per-call cost.';
    }
    if (rows[3]) {
      const evx = rows[3].querySelector('em');
      const ev = cost.evaluation || {};
      const evTotal = has(ev.total) ? rupee(ev.total) : null;
      if (evx) evx.textContent = evTotal ? `${evTotal} / call` : (hasChallenger ? 'usage not reported' : 'not run');
      /* Render whatever roles the payload lists (now de-duplicated to one
         transcript+timing run), never a hardcoded set. */
      const comps = (ev.components || []).map(c => `${esc(c.role)}${has(c.amount) ? ` ${rupee(c.amount)}` : ' (usage not reported)'}`).join(' + ');
      rows[3].querySelector('.n').innerHTML = hasChallenger
        ? `${comps || `Challenger ${D.challenger.kind === 'streaming' ? 'streaming' : 'transcript'} run`}${ev.complete ? '' : ' \u00b7 some usage not reported'}. This is the price of <b>testing</b>, not of serving.`
        : 'No challenger was run, so there is no evaluation cost for this call.';
    }
    const cap = document.querySelector('#decide .costlede .cap');
    if (cap) cap.innerHTML = accAvail
      ? `<span id="costYearlySaving"></span> a year, on a call where the two transcripts disagree on ${D.accuracy.errors} words.`
      : `<span id="costYearlySaving"></span> a year (${prodP ? 'production-only projection' : 'challenger-only projection'}; no comparison available).`;
    const note = document.querySelector('#decide .cost > .note');
    if (note) note.innerHTML = has(cost.difference.per_call)
      ? `<div class="t"><span aria-hidden="true">\u25c7</span>Cost is the tie-breaker, not the reason</div>The per-call difference is <b>${signRupee(cost.difference.per_call)}</b>. A single mis-heard account number that reaches a payment costs more than months of it \u2013 which is why the transcript verdict comes first and cost only breaks the tie.`
      : `<div class="t"><span aria-hidden="true">\u25c7</span>Cost needs both models priced</div>${prodP ? `Only production is priced (as ${esc(cost.production.label)}).` : `Production recorded no billable STT; only the challenger is priced (as ${esc(chal.label)}).`} A full comparison needs both.`;

    /* Clone the inputs to drop the mockup's own listeners (which run a
       hardcoded-rate projector and touch ids our reduced tables may omit),
       so only our real-rate projector below is bound. */
    let inC = document.getElementById('monthlyCallsInput');
    let inM = document.getElementById('averageMinutesInput');
    if (inC) { const c = inC.cloneNode(true); inC.replaceWith(c); inC = c; inC.disabled = false; inC.value = cost.volume.calls_per_month; inC.setAttribute('aria-label', 'Calls per month'); }
    if (inM) { const c = inM.cloneNode(true); inM.replaceWith(c); inM = c; inM.disabled = false; inM.value = cost.volume.average_call_minutes; inM.setAttribute('aria-label', 'Average minutes per call'); }

    /* Replace the mockup's hardcoded-rate projector with one on real rates. */
    window.updateCostProjection = function () {
      const calls = Number(inC && inC.value);
      const mins = Number(inM && inM.value);
      if (!Number.isFinite(calls) || !Number.isFinite(mins) || calls <= 0 || mins <= 0) return;
      const minutes = calls * mins;
      const prod = prodP ? minutes * cost.production.per_minute : null;
      const chalCost = chalP ? minutes * chal.per_minute : null;
      const volume = `${compactCount(calls)} calls a month \u00b7 ${minLabel(mins)} average`;
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('scoreVolume', `${compactCount(calls)} calls/month \u00b7 ${minLabel(mins)} avg`);
      set('h2hCostVolume', `List price \u00b7 ${volume}`);
      set('costMonthlyLabel', `${compactCount(calls)} calls a month`);
      set('costMonthlyProd', prodP ? rupee(prod) : 'not priced');
      set('costMonthlyChal', chalP ? rupee(chalCost) : 'not run');
      set('costMonthlyMinutes', `${intGroup(minutes)} minutes at ${minLabel(mins)} average call length.`);
      set('costAssumptions', `List price with no committed-use discount \u00b7 ${volume}`);
      set('h2hMonthlyProd', prodP ? rupee(prod) : 'not priced');
      set('h2hMonthlyChal', chalP ? rupee(chalCost) : 'not run');
      if (prodP && chalP) {
        const diff = chalCost - prod, yearly = diff * 12;
        set('scoreMonthlySaving', signRupee(diff));
        set('scoreYearlySaving', signRupee(yearly));
        set('h2hMonthlySave', signRupee(diff));
        set('costMonthlySaving', signRupee(diff));
        set('costYearlySaving', signRupee(yearly));
      } else {
        const only = prodP ? prod : chalCost;
        const oneLabel = prodP ? 'production only' : 'challenger only';
        set('scoreMonthlySaving', has(only) ? rupee(only) : 'no pricing');
        set('scoreYearlySaving', has(only) ? rupee(only * 12) : 'no pricing');
        set('h2hMonthlySave', oneLabel);
        set('costMonthlySaving', has(only) ? rupee(only) : 'no pricing');
        set('costYearlySaving', has(only) ? rupee(only * 12) : 'no pricing');
      }
    };
    if (inC) inC.addEventListener('input', window.updateCostProjection);
    if (inM) inM.addEventListener('input', window.updateCostProjection);
    window.updateCostProjection();
  }

  /* -------------------------------------------------- transcript detail */
  function bindTranscriptPanels() {
    const a = D.accuracy, cov = D.coverage, r = D.risk;
    const la = lengthAgreement();
    setText('#transcript .side.prod h4 .faint', prodLabel);
    setText('#transcript .side.chal h4 .faint', hasChallenger ? chalLabel : 'not run');
    setText('#transcript header .right .badge', `${cov.call_turns} caller turns`);
    const accReason = captureNotRecorded
      ? 'Transcript text was not recorded in this capture, so word error rate cannot be computed.'
      : reasonText((a && a.reason) || (hasChallenger ? 'not_evaluated' : 'no_challenger'));

    /* Header + score card reframed as system-to-system disagreement. */
    const scoreHeaderH2 = document.querySelector('#transcript .col.scrollcol .card header .qh h2');
    if (scoreHeaderH2 && /where is production off/i.test(scoreHeaderH2.textContent)) scoreHeaderH2.textContent = 'Where the two models disagree';
    const scoreHeaderSpan = scoreHeaderH2 && scoreHeaderH2.parentElement.querySelector('span');
    if (scoreHeaderSpan && /scored against the challenger/i.test(scoreHeaderSpan.textContent)) scoreHeaderSpan.textContent = `Whole call \u00b7 production vs the reference STT (${chalLabel})`;

    /* Call WER score card — length agreement is the substantive content on
       redacted captures (character counts only, never a correctness score). */
    const score = document.querySelector('#transcript .score');
    if (score) {
      const big = score.querySelector('.big.num');
      const sub = score.querySelector('.sub');
      if (captureNotRecorded && la) {
        if (big) big.textContent = `${la.production_chars} / ${la.challenger_chars}`;
        if (sub) sub.innerHTML = `Production captured <b>${la.production_chars}</b> characters of transcript against the challenger\u2019s <b>${la.challenger_chars}</b> across ${la.turns} turn${la.turns === 1 ? '' : 's'} \u2013 comparable speech was captured, so production heard the caller.<br><b class="faint">${esc(la.method)}.</b>`;
      } else if (accAvail && has(a.call_estimated_wer)) {
        if (big) big.textContent = pctI(a.call_estimated_wer);
        if (sub) sub.innerHTML = `The two transcripts differ on <b>${a.errors}</b> of <b>${a.reference_words}</b> words across ${cov.scored_turns} compared turns.<br><b class="faint">This is a disagreement rate between two STT systems, not a production error rate \u2013 the reference (${esc(chalLabel)}) has its own mistakes.</b>`;
      } else {
        if (big) big.textContent = 'No score';
        if (sub) sub.innerHTML = esc(accReason);
      }
      const rate = score.querySelector('.right .rating') || score.querySelector('.rating');
      if (rate) {
        if (captureNotRecorded) { rate.className = 'rating off'; rate.innerHTML = `<span class="d"></span>Length only`; }
        else {
          const b = a.call_band;
          const cls = b === 'low' ? 'good' : b === 'moderate' ? 'warn' : b === 'high' ? 'bad' : 'off';
          rate.className = `rating ${cls}`;
          rate.innerHTML = `<span class="d"></span>${b === 'low' ? 'Aligned' : b === 'moderate' ? 'Some drift' : b === 'high' ? 'High divergence' : 'No score'}`;
        }
      }
      /* Prominent caveat: the reference is a second STT model, not ground truth. */
      const spot = score.querySelector('.spotcheck span:last-child');
      if (spot && !captureNotRecorded) spot.innerHTML = `<b>Not ground truth.</b> The reference is <b>${esc(chalLabel)}</b>, another STT model with its own errors; no human transcript exists for this call. A high value means the two systems disagree a lot, not that production is wrong \u2013 on this call several disagreements are the reference mishearing.`;
    }

    /* S / D / I breakdown, framed as where the two transcripts differ (not as
       production errors: either side may be the one that is wrong). */
    const total = a.substitutions + a.deletions + a.insertions || 1;
    const sdiRows = document.querySelectorAll('#transcript .sdi .row');
    document.querySelectorAll('#transcript .secttl').forEach(t => {
      if (accAvail && /how production is off/i.test(t.textContent)) {
        const lbl = t.querySelector('.lbl') || t;
        lbl.textContent = 'How the two transcripts differ';
      }
    });
    const sdiLabels = ['Different word heard', 'Only in the reference transcript', 'Only in the production transcript'];
    const sdi = [a.substitutions, a.deletions, a.insertions];
    sdiRows.forEach((row, i) => {
      const n = sdi[i] || 0;
      const bLbl = row.querySelector('b'); if (bLbl && accAvail) { const lbl = bLbl.querySelector('.lbl') || bLbl; lbl.textContent = sdiLabels[i]; }
      const bar = row.querySelector('.bar i'); if (bar) bar.style.width = accAvail ? `${Math.round(n / total * 100)}%` : '0%';
      const span = row.querySelector(':scope > span'); if (span) span.textContent = accAvail ? `${n} of ${a.errors || 0}` : 'not recorded';
    });

    /* Which errors matter (kv) */
    const kv = document.querySelectorAll('#transcript .sect .kv .r');
    if (kv[0]) {
      const chip = kv[0].querySelector('.chip'); if (chip) { chip.className = 'chip high'; chip.textContent = riskAvail ? `${r.outcome_risk_turns} of ${cov.risk_evaluated_turns}` : (captureNotRecorded ? 'not recorded' : 'skipped'); }
      const n = kv[0].querySelector('.n');
      if (n) n.innerHTML = captureNotRecorded ? 'Production transcript was not recorded, so semantic risk could not be assessed.'
        : !riskAvail ? esc(reasonText((r && r.reason) || 'not_evaluated'))
        : (r.high_turn_ids || []).length ? `Turn${(r.high_turn_ids || []).length > 1 ? 's' : ''} ${esc((r.high_turn_ids || []).join(', '))} are flagged where a wrong word changes intent \u2013 ${esc((r.critical_terms || []).slice(0, 3).join(', '))}.` : 'No turn was flagged as changing an outcome.';
    }
    if (kv[1]) {
      const chip = kv[1].querySelector('.chip'); if (chip) { chip.className = 'chip med'; chip.textContent = `${cov.unscored_turns} of ${cov.stt_turns}`; }
      const n = kv[1].querySelector('.n'); if (n) n.innerHTML = captureNotRecorded ? `Turn ${esc((cov.production_no_text_turn_ids || notCapturedIds).join(', '))} \u2013 the capture stored only transcript length, not the words. Not counted as 0% or 100%.` : (cov.challenger_no_text_turn_ids || []).length ? `Turn ${esc((cov.challenger_no_text_turn_ids || []).join(', '))} \u2013 the challenger returned no text, so there is no reference. Not counted as 0% or 100%.` : (cov.production_no_text_turn_ids || []).length ? `Turn ${esc((cov.production_no_text_turn_ids || []).join(', '))} \u2013 production returned no text. Not counted as 0% or 100%.` : 'All turns with text on both sides were scored.';
    }
    if (kv[2]) {
      const span = kv[2].querySelector('span');
      const n = kv[2].querySelector('.n');
      if (hasChallenger && has(D.challenger.language_probability)) {
        if (span) span.textContent = `${D.challenger.language_code} \u00b7 ${pctI(D.challenger.language_probability)}`;
        if (n) n.innerHTML = `Detected language ${esc(D.challenger.language_code)} (p=${(D.challenger.language_probability).toFixed(2)})${D.production.capabilities.multilingual_turns ? ' \u00b7 code-switching present' : ''}.`;
      } else if (hasChallenger) {
        if (span) span.textContent = 'not detected';
        if (n) n.textContent = 'The challenger returned no language-detection score for this call.';
      } else {
        if (span) span.textContent = 'no challenger';
        if (n) n.textContent = 'Language is detected from the challenger transcript, which was not produced.';
      }
    }

    /* Repeated disagreed words */
    const words = document.querySelector('#transcript .words');
    if (words) {
      const list = (a.disagreed_words || []);
      words.innerHTML = list.length ? list.map(w =>
        `<div class="wordcard"><b>${esc(w.production_word)} <i>\u2192</i> ${esc(w.challenger_word)}</b><span>${w.count}\u00d7 \u00b7 ${esc(w.operation)} \u00b7 turn${(w.turns || []).length > 1 ? 's' : ''} ${esc((w.turns || []).join(', '))}</span></div>`).join('')
        : captureNotRecorded
          ? '<div class="wordcard"><b>No word comparison</b><span>transcript text was not recorded in this capture</span></div>'
          : '<div class="wordcard"><b>No repeated pairs</b><span>each disagreement was unique</span></div>';
    }

    /* Turn-detail spot-check caveat: the challenger side is a second STT model,
       not ground truth — a difference is not proof production is wrong. */
    if (accAvail) document.querySelectorAll('#transcript .spotcheck span:last-child').forEach(sp => {
      if (/taken as the reference|off\u201d? means/i.test(sp.textContent)) {
        sp.innerHTML = `<b>Not ground truth.</b> The challenger side is <b>${esc(chalLabel)}</b>, a second STT model with its own errors. A difference does not mean production is wrong \u2013 play the clip to judge which side is right.`;
      }
    });
  }

  /* Cohort card */
  function bindCohort() {
    const co = D.cohort;
    const card = [...document.querySelectorAll('#transcript .card')].find(c => /typical/i.test(c.querySelector('h2')?.textContent || ''));
    if (!card) return;
    const sub = card.querySelector('header .qh span');
    if (!co || !co.available) {
      if (sub) sub.textContent = co && co.reason ? co.reason : 'Cohort comparison has no other calls yet';
      card.querySelectorAll('.kv .r').forEach(row => {
        const v = row.querySelector('.num, span:not(.n)'); if (v && !v.classList.contains('n')) v.textContent = co && co.reason ? co.reason : 'single call';
      });
      return;
    }
    if (sub) sub.textContent = `${co.call_count} call${co.call_count === 1 ? '' : 's'} \u00b7 ${co.window}`;
    const wer = co.metrics.estimated_wer;
    const rows = card.querySelectorAll('.kv .r');
    if (rows[0]) {
      const nEl = rows[0].querySelector('.num'); if (nEl) nEl.textContent = pctI(wer.cohort.p50);
      const note = rows[0].querySelector('.n'); if (note) note.innerHTML = `Production scored ${pctI(wer.call)} here \u2013 <b style="color:var(--muted)">${wer.typical ? 'typical' : 'atypical'}</b> for this cohort (rank ${pctI(wer.percentile_rank)}).`;
    }
    if (rows[1]) {
      const nEl = rows[1].querySelector('.num'); if (nEl) nEl.textContent = `P90 ${pctI(wer.cohort.p90)} \u00b7 P95 ${pctI(wer.cohort.p95)}`;
      const note = rows[1].querySelector('.n'); if (note) note.textContent = `Secondary signal. Percentiles are noisy below ~100 calls (n=${co.call_count}).`;
    }
    if (rows[2]) {
      const nEl = rows[2].querySelector('.num'); if (nEl) nEl.textContent = has(D.cost.evaluation && D.cost.evaluation.total) ? `${rupee(D.cost.evaluation.total)} / call` : 'not run';
      const note = rows[2].querySelector('.n'); if (note) note.textContent = 'Challenger transcript + streaming replay only. Excludes the original live call.';
    }
  }

  /* ------------------------------------------------------------ latency */
  function latMedians() {
    const P = D.latency.production, B = D.latency.budget;
    const C = D.latency.challenger || {};
    const cAvail = C.available !== false;
    const cp = (k) => cAvail && C[k] ? C[k].p50 : null;
    const tvals = key => Object.values(B.turns || {}).map(t => t[key]);
    return {
      /* `ffw` is the like-for-like finalisation (caller's last word -> final),
         comparable to the challenger's `cep`. `ep` is production's own
         hangover-adjusted endpoint delay: a vendor-internal number only. */
      ffw: P.final_from_last_word_ms ? P.final_from_last_word_ms.p50 : null,
      total: P.caller_wait_ms.p50, ctotal: null, ep: P.endpoint_delay_ms.p50,
      cep: cp('endpoint_delay_ms'), epe: P.endpoint_position_error_ms.p50, cepe: null,
      s2f: P.speech_to_final_ms.p50, cs2f: null, pef: null, cpef: cp('post_end_delay_ms'),
      fp: P.first_partial_ms.p50, cfp: cp('first_partial_ms'), sp: P.first_stable_partial_ms.p50,
      csp: cp('post_end_delay_ms'), rev: P.partial_revision_rate.p50, crev: null,
      cur: null, ccur: null, config: P.configured_endpointing_ms.p50,
      stt: median(tvals('stt_ms')), llm: median(tvals('llm_ms')), tts: median(tvals('tts_ms')),
      share: B.stt_share.p50
    };
  }
  const LAT_UNIT = {
    total: 's', ctotal: 's', s2f: 's', cs2f: 's', rev: 'n', crev: 'n',
    ep: 'ms', cep: 'ms', ffw: 'ms', epe: 'ms', cepe: 'ms', pef: 'ms', cpef: 'ms',
    fp: 'ms', cfp: 'ms', sp: 'ms', csp: 'ms', cur: 'ms', ccur: 'ms'
  };
  const LAT_REASON = {
    ctotal: 'no counterfactual: 1 challenger turn-end', cepe: 'no reference turn-end error',
    cs2f: 'batch reference has no speech-to-final', pef: 'production emits no post-end delay',
    sp: 'no stable-partial samples', crev: 'batch reference has no revisions',
    cur: 'production emits no cursor-lag', ccur: 'no challenger cursor-lag samples',
    rev: 'no interim partials', fp: 'no production partials',
    ep: 'finalisation milestone not recorded', ffw: 'finalisation not measurable', s2f: 'speech-to-final needs word timestamps',
    cep: 'no challenger turn-end', cfp: 'no reliable speech onset', csp: 'no challenger post-end'
  };
  const CHAL_KEYS = new Set(['ctotal', 'cep', 'cepe', 'cs2f', 'cpef', 'cfp', 'csp', 'crev', 'ccur']);
  function latPerTurn(id) {
    const t = (D.turns || []).find(x => String(x.turn_id) === String(id));
    const pt = (t && t.production && t.production.timing) || {};
    const ct = (t && t.challenger && t.challenger.timing) || {};
    const b = (D.latency.budget.turns || {})[String(id)] || {};
    const pr = pt.partial_revisions;
    return {
      ffw: pt.final_from_last_word_ms, total: pt.caller_wait_ms, ctotal: null, ep: pt.endpoint_delay_ms, cep: ct.endpoint_delay_ms,
      epe: pt.endpoint_position_error_ms, cepe: ct.endpoint_position_error_ms,
      s2f: pt.speech_to_final_ms, cs2f: null, pef: null, cpef: ct.post_end_delay_ms,
      fp: pt.time_to_first_partial_ms, cfp: ct.time_to_first_partial_ms,
      sp: pt.time_to_first_stable_partial_ms, csp: ct.post_end_delay_ms,
      rev: pr && pr.available !== false ? pr.revision_rate : null,
      _revReason: pr && pr.available === false ? pr.reason : null, crev: null,
      /* Per-turn honesty reasons for figures the capture could not measure. */
      _epReason: pt.endpoint_measurable === false ? pt.endpoint_unmeasurable_reason : null,
      _cfpReason: ct.first_partial_unmeasurable_reason || null,
      cur: null, ccur: ct.streaming_cursor_lag_ms, config: pt.configured_endpointing_ms,
      stt: b.stt_ms, llm: b.llm_ms, tts: b.tts_ms, share: b.stt_share
    };
  }
  function latFormat(v, key) {
    const u = LAT_UNIT[key] || 'ms';
    if (u === 's') return `${(v / 1000).toFixed(Math.abs(v) < 10000 ? 2 : 1)} s`;
    if (u === 'n') return num1(v);
    return `${Math.round(v)} ms`;
  }
  function latReason(key) { return LAT_REASON[key] || (CHAL_KEYS.has(key) ? '1 model only' : 'no production timing'); }

  function makeRenderLatency() {
    return function renderLatency() {
      const md = (typeof latMode === 'undefined' ? 'median' : latMode) === 'median';
      const id = typeof latTurnId === 'undefined' ? (D.turns[0] && D.turns[0].turn_id) : latTurnId;
      const V = md ? latMedians() : latPerTurn(id);
      const meta = (D.turns || []).find(x => String(x.turn_id) === String(id));
      const scope = md ? `Median of ${D.latency.production.first_partial_ms.count} timed turns`
        : `Turn ${id}${meta ? ` \u00b7 ${clock(meta.speech_started_at_ms / 1000)}${MINUS}${clock(meta.speech_ended_at_ms / 1000)}` : ''}`;

      const setNum = (el, key) => {
        const v = V[key];
        if (!has(v)) {
          let reason = latReason(key);
          if (key === 'rev' && V._revReason) reason = reasonText(V._revReason);
          else if ((key === 'ep' || key === 'cep' || key === 'ffw') && V._epReason) reason = reasonText(V._epReason);
          else if (key === 'cfp' && V._cfpReason) reason = reasonText(V._cfpReason);
          el.innerHTML = `<span class="faint" style="font-weight:500">${esc(reason)}</span>`;
          return;
        }
        let suffix = '';
        if (key === 'epe' || key === 'cepe') suffix = `<small>${v > 0 ? 'late' : v < 0 ? 'early' : 'on time'}</small>`;
        if (key === 'rev' || key === 'crev') suffix = `<small>${md ? 'per turn' : 'this turn'}</small>`;
        el.innerHTML = esc(latFormat(v, key)) + suffix;
        el.classList.remove('d-bad');
        if ((key === 'epe' && Math.abs(v) > 150) || (key === 'cur' && v > 200)) el.classList.add('d-bad');
      };

      /* `data-latsrc` lets one mockup slot (kept on a key the mockup script
         understands, e.g. "ep") be re-sourced to a new key ("ffw") by us. */
      document.querySelectorAll('[data-lat]').forEach(el => setNum(el, el.dataset.latsrc || el.dataset.lat));

      /* Difference cells use the backend's PAIRED delta (median of per-turn
         differences), never the difference of the two medians shown beside
         them. Per-turn mode uses that turn's own paired difference. */
      const PAIR_DELTA = { 'ffw,cep': 'endpoint_delay_ms', 'fp,cfp': 'first_partial_ms' };
      document.querySelectorAll('[data-latdiff]').forEach(el => {
        const pair = el.dataset.latsrc || el.dataset.latdiff;
        const [ka, kb] = pair.split(',');
        const a = V[ka], b = V[kb];
        const metric = PAIR_DELTA[pair];
        const dblock = metric && D.latency.delta ? D.latency.delta[metric] : null;
        let d;
        if (md) {
          /* Median view: only a backend paired delta is acceptable. */
          if (dblock && dblock.count && has(dblock.p50)) d = dblock.p50;
          else { el.innerHTML = `<span class="faint">${has(a) && has(b) ? 'no paired delta' : '1 model only'}</span>`; el.classList.remove('d-good', 'd-bad'); return; }
        } else {
          /* Per-turn view: the two values are from the same turn, so their
             difference is itself a paired difference. */
          if (!has(a) || !has(b)) { el.innerHTML = `<span class="faint">1 model only</span>`; el.classList.remove('d-good', 'd-bad'); return; }
          d = b - a;
        }
        const asMs = el.dataset.latfmt === 'ms' || (LAT_UNIT[ka] || 'ms') === 'ms';
        const txt = asMs ? signMs(Math.round(d)) : `${d > 0 ? '+' : d < 0 ? MINUS : ''}${Math.abs(d / 1000).toFixed(1)} s`;
        el.textContent = txt;
        el.classList.remove('d-good', 'd-bad');
        if (d) el.classList.add(d < 0 ? 'd-good' : 'd-bad');
      });

      /* waterfall — real STT/LLM/TTS composition of the reply */
      const segs = [['stt', V.stt], ['llm', V.llm], ['tts', V.tts]].filter(x => has(x[1]));
      const scale = Math.max(1, segs.reduce((a, x) => a + x[1] / 1000, 0));
      const draw = (el, list) => {
        if (!el) return;
        let x = 0;
        el.innerHTML = list.map(([cls, ms]) => {
          const sec = ms / 1000, left = x / scale * 100, w = sec / scale * 100; x += sec;
          return `<span class="wfseg ${cls}" style="left:${left}%;width:${w}%" title="${cls}: ${sec.toFixed(2)} s">${w > 11 ? cls.toUpperCase() : ''}</span>`;
        }).join('');
      };
      draw(document.getElementById('wfProd'), segs);
      const wfChal = document.getElementById('wfChal'); if (wfChal) wfChal.innerHTML = '';
      const wfTarget = document.getElementById('wfTarget');
      const cohortWait = D.cohort && D.cohort.available && D.cohort.metrics.caller_wait_ms ? D.cohort.metrics.caller_wait_ms.cohort.p50 : null;
      if (wfTarget && has(cohortWait)) {
        const w = (cohortWait / 1000) / scale * 100;
        wfTarget.innerHTML = `<span class="wfseg stt" style="left:0;width:${Math.min(100, w)}%" title="cohort median wait"></span>`;
      } else if (wfTarget) wfTarget.innerHTML = '';
      const tRow = wfTarget && wfTarget.closest('.wfrow');
      if (tRow) {
        const b = tRow.querySelector('b'); if (b) b.textContent = has(cohortWait) ? 'Typical on your calls' : 'Target for live agents';
        const em = tRow.querySelector('em'); if (em) em.textContent = has(cohortWait) ? fmtMs(cohortWait) : '\u2014';
      }
      const chalEm = wfChal && wfChal.closest('.wfrow') && wfChal.closest('.wfrow').querySelector('em');
      if (chalEm) chalEm.innerHTML = `<span class="faint">${esc(latReason('ctotal'))}</span>`;

      /* config + gap */
      document.querySelectorAll('[data-latconfig]').forEach(el => el.textContent = has(V.config) ? `${Math.round(V.config)} ms` : latReason('config'));
      const gapVal = has(V.ep) && has(V.config) ? Math.round(V.ep - V.config) : null;
      document.querySelectorAll('[data-latgap]').forEach(el => {
        if (!has(gapVal)) { el.textContent = '1 model only'; return; }
        const warn = gapVal > 150;
        el.innerHTML = `${gapVal > 0 ? '+' : gapVal < 0 ? MINUS : ''}${Math.abs(gapVal)} ms<span class="rating ${warn ? 'warn' : 'good'}"><span class="d"></span>${warn ? 'Investigate' : 'In range'}</span>`;
      });

      /* badges */
      const badge = (name, cls, txt) => {
        const el = document.querySelector(`[data-latbadge="${name}"]`);
        if (!el) return; el.className = `rating ${cls}`; el.innerHTML = `<span class="d"></span>${esc(txt)}`;
      };
      const wait = V.total;
      badge('wait', wait < 1000 ? 'good' : wait <= 1800 ? 'warn' : 'bad', wait < 1000 ? 'Good' : wait <= 1800 ? 'Watch' : 'Act now');
      badge('gap', has(gapVal) && gapVal > 150 ? 'warn' : 'good', has(gapVal) ? `${gapVal > 0 ? '+' : gapVal < 0 ? MINUS : ''}${Math.abs(gapVal)} ms gap` : 'no pair');
      /* Finalisation verdict (last word -> final): negative paired delta = challenger faster. */
      const endD = D.latency.delta && D.latency.delta.endpoint_delay_ms && D.latency.delta.endpoint_delay_ms.count ? D.latency.delta.endpoint_delay_ms.p50 : (has(V.cep) && has(V.ffw) ? V.cep - V.ffw : null);
      badge('end', !has(endD) ? 'off' : endD < -50 ? 'good' : endD > 50 ? 'warn' : 'off',
        !has(endD) ? 'No pair' : endD < 0 ? 'Challenger faster' : endD > 0 ? 'Production faster' : 'Same speed');

      /* share + save */
      document.querySelectorAll('[data-latshare]').forEach(el => el.textContent = has(V.share) ? pctI(V.share) : '1 model only');
      document.querySelectorAll('[data-latsharenote]').forEach(el => {
        el.textContent = has(V.share)
          ? `STT is ${pctI(V.share)} of the modelled reply time; the LLM and voice stages dominate, so changing STT alone ${V.share < 0.5 ? 'cannot' : 'can only partly'} fix a slow call.`
          : 'STT share needs the per-turn LLM and voice budget.';
      });
      document.querySelectorAll('[data-latsave]').forEach(el => {
        const LC = D.latency.challenger || {};
        const cnt = LC.available !== false && LC.endpoint_delay_ms ? LC.endpoint_delay_ms.count : 0;
        el.innerHTML = `<span class="faint">no counterfactual: ${cnt} of ${LC.measured_turns || 0} turns had a challenger turn-end</span>`;
      });

      /* finalization reason */
      document.querySelectorAll('[data-latreason]').forEach(el => {
        if (md) {
          const fr = D.latency.production.final_reasons || {};
          const top = Object.entries(fr).sort((a, b) => b[1] - a[1])[0];
          el.innerHTML = top ? `${esc(top[0])}<small style="font-family:var(--sans)">on ${top[1]} of ${D.latency.production.first_partial_ms.count} turns</small>` : '<span class="faint">no production turns</span>';
        } else {
          const pt = meta && meta.production && meta.production.timing;
          el.textContent = pt && pt.final_reason ? pt.final_reason : 'no production timing';
        }
      });

      /* forced flush */
      document.querySelectorAll('[data-latforced]').forEach(el => {
        if (md) el.innerHTML = `${D.latency.shape.forced_flush_count}<small>of ${D.latency.shape.measured_turns} turns</small>`;
        else { const pt = meta && meta.production && meta.production.timing; el.innerHTML = pt && pt.forced_flush ? 'Yes<small>cut off by the flush timer</small>' : 'No<small>ended on its own</small>'; }
      });

      /* split / merged */
      const sp = document.querySelector('[data-latsplit="p"]'), sc = document.querySelector('[data-latsplit="c"]'), sd = document.querySelector('[data-latsplit="d"]');
      if (sp && sc && sd) {
        const flaggedIds = new Set([].concat(D.latency.shape.late_turn_ids || [], D.latency.shape.premature_turn_ids || [], D.latency.shape.non_turn_final_turn_ids || []).map(String));
        const cCount = md ? D.latency.shape.split_or_merged_count : (flaggedIds.has(String(id)) ? 1 : 0);
        sp.innerHTML = md ? `0<small>turns</small>` : 'No<small>reference boundary</small>';
        sc.innerHTML = md ? `${cCount}<small>turn${cCount === 1 ? '' : 's'}</small>` : (cCount ? 'Yes<small>boundary differed</small>' : 'No<small>boundary matched</small>');
        const d = cCount;
        sd.textContent = d === 0 ? 'same' : `+${d}`;
        sd.classList.remove('d-good', 'd-bad'); if (d) sd.classList.add('d-bad');
      }

      /* barge-in row (three ems: prod, chal, diff) */
      const bargeEl = document.querySelector('[data-latbarge]');
      if (bargeEl) {
        const bi = D.latency.barge_in || {};
        const biAvail = bi.available !== false;
        const mrow = bargeEl.closest('.mrow');
        const ems = mrow ? mrow.querySelectorAll('em') : [];
        if (!biAvail) {
          bargeEl.innerHTML = `<span class="faint">${esc(reasonText(bi.reason))}</span>`;
          if (ems[1]) { ems[1].className = 'num off'; ems[1].innerHTML = `<span class="faint">${esc(reasonText(bi.reason))}</span>`; }
          if (ems[2]) { ems[2].className = 'num off'; ems[2].textContent = 'no pair'; }
        } else {
          if (md) bargeEl.innerHTML = `${bi.count}<small>of ${bi.measured_turns} turns</small>`;
          else { const hit = (bi.turn_ids || []).map(String).includes(String(id)); bargeEl.innerHTML = hit ? 'Yes<small>talked over the agent</small>' : 'No<small>caller waited</small>'; }
          if (ems[1]) { ems[1].className = 'num'; ems[1].innerHTML = md ? `${bi.count}<small>same call</small>` : (((bi.turn_ids || []).map(String).includes(String(id))) ? 'Yes<small>same call</small>' : 'No<small>same call</small>'); }
          if (ems[2]) { ems[2].className = 'num'; ems[2].textContent = 'same'; }
        }
      }

      /* dead-air note */
      document.querySelectorAll('[data-latdead]').forEach(el => {
        el.textContent = has(V.epe) ? `Production leaves ${signMs(V.epe)} of dead air ${md ? 'on a typical turn' : 'on this turn'}.` : 'Endpoint position error was not measured here.';
      });

      /* median/per-turn label swaps */
      document.querySelectorAll('[data-latlabel]').forEach(el => {
        const host = el.querySelector('.lbl') || el;
        if (!el.dataset.latlabelMedian) el.dataset.latlabelMedian = host.textContent;
        host.textContent = md ? el.dataset.latlabelMedian : el.dataset.latlabel;
      });

      /* Relabel the re-sourced finalisation row to name its baseline (the
         cell now shows last-word -> final, not production's own speech end). */
      document.querySelectorAll('[data-lat][data-latsrc="ffw"]').forEach(el => {
        const b = el.closest('.mrow') && el.closest('.mrow').querySelector('b');
        if (b) { const lbl = b.querySelector('.lbl') || b; lbl.textContent = 'Last word \u2192 final transcript'; }
      });

      /* subheads — each card's qualifier uses ITS metric's own paired count
         (delta.<metric>.count), not delta.paired_turns, which counts turns
         where both models produced output and overstates the median sample. */
      const dl = D.latency.delta || {};
      const cnt = m => dl[m] && has(dl[m].count) ? dl[m].count : null;
      const endN = cnt('endpoint_delay_ms'), fpN = cnt('first_partial_ms');
      const pairedNote = n => md && has(n) ? ` \u00b7 Difference = median of per-turn differences across ${n} paired turns` : '';
      document.querySelectorAll('[data-latsub]').forEach(el => {
        const k = el.dataset.latsub;
        el.textContent = scope + (k === 'wait' ? ' \u00b7 caller stops talking \u2192 agent starts talking'
          : k === 'end' ? ` \u00b7 finalisation measured from the caller\u2019s last word${pairedNote(endN)}`
          : k === 'config' ? ' \u00b7 production-internal: its own declared speech-end vs its setting'
          : ` \u00b7 interim text, delivery and turn boundaries${pairedNote(fpN)}`);
      });

      /* Endpoint card's sign-convention note: explain why the difference is not
         the on-screen subtraction of the two medians. The only paired numeric
         row in this card is the finalisation row, so it uses that metric's n. */
      document.querySelectorAll('#latency .note').forEach(nEl => {
        if (/Negative difference/i.test(nEl.textContent) && !nEl.dataset.pairedNoted) {
          nEl.dataset.pairedNoted = '1';
          nEl.insertAdjacentHTML('beforeend', ` <b>The Difference column is the median of the per-turn differences across ${has(endN) ? `${endN} paired turns` : 'the paired turns'} (each row over its own paired count), so it deliberately does not equal Chall minus Prod of the two medians shown.</b>`);
        }
      });

      const note = document.getElementById('latNote');
      if (note) note.textContent = md
        ? `Median view: typical timing across the turns each metric could measure \u2013 not one timeline. Bars may not add to the total. Use One turn at a time for a real sequence.`
        : `One turn: a real sequence for this turn. Any value a model could not measure is shown with its reason.`;

      const sel = document.getElementById('latTurn');
      if (sel) { sel.hidden = md; sel.value = String(id); }
      document.querySelectorAll('#latMode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lm === (md ? 'median' : 'turn'))));
      if (typeof visibilityReady !== 'undefined' && visibilityReady) call('applyVisibility');
    };
  }

  function bindLatency() {
    window.renderLatency = makeRenderLatency();
    const sel = document.getElementById('latTurn');
    if (sel) sel.innerHTML = (D.turns || []).length
      ? (D.turns || []).map(t => `<option value="${esc(t.turn_id)}">Turn ${esc(t.turn_id)} \u00b7 ${clock(t.speech_started_at_ms / 1000)}${MINUS}${clock(t.speech_ended_at_ms / 1000)}</option>`).join('')
      : `<option value="none">no production turns</option>`;
    if (typeof latTurnId !== 'undefined') latTurnId = (D.turns && D.turns[0]) ? String((D.accuracy.worst_turn_ids || [])[0] || D.turns[0].turn_id) : 'none';
    /* Reword the static availability note so it carries no placeholder token. */
    document.querySelectorAll('#latency .note.amber').forEach(note => {
      if (/must read/i.test(note.textContent)) {
        note.innerHTML = `<div class="t"><span aria-hidden="true">\u25b2</span>Availability</div>Backlog needs provider audio-offset and input-cursor events. Where a provider does not emit them, that row shows the recorded reason rather than a fabricated zero.`;
      }
    });
    window.renderLatency();
  }

  /* ------------------------------------------------------------- replay */
  function bindReplay() {
    const CALL_DUR = D.duration_ms / 1000;
    const rows = (typeof turns !== 'undefined' ? turns : []);
    const audio = new Audio(`/v1/sessions/${encodeURIComponent(sessionId)}/audio/caller?preview=wav`);
    audio.preload = 'metadata';

    const clockSpan = document.querySelector('#replay .clock span');
    if (clockSpan) clockSpan.textContent = `of ${clock(CALL_DUR)}`;

    /* Rebuild the timeline track with real turn regions (drops mockup listeners). */
    const oldTrack = document.getElementById('track');
    if (!oldTrack) return;
    const track = oldTrack.cloneNode(false);
    oldTrack.replaceWith(track);

    const wave = document.createElement('div');
    wave.className = 'wave'; wave.id = 'wave'; wave.setAttribute('aria-hidden', 'true');
    wave.innerHTML = Array.from({ length: 190 }, (_, i) => {
      const near = rows.some(t => Math.abs((t.s + t.e) / 2 / CALL_DUR * 190 - i) < (t.e - t.s) / CALL_DUR * 95 + 2);
      const h = near ? 30 + Math.abs(Math.sin(i * 1.7)) * 62 : 8 + Math.abs(Math.sin(i * 0.9)) * 12;
      return `<i style="height:${h}%"></i>`;
    }).join('');
    track.appendChild(wave);

    const cursor = document.createElement('div');
    cursor.className = 'cursor'; cursor.id = 'cursor'; cursor.style.left = '0';
    track.appendChild(cursor);

    rows.forEach((t, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'reg' + (t.win === 'noprod' || t.win === 'noref' ? ' flag' : '');
      b.style.left = `${t.s / CALL_DUR * 100}%`;
      b.style.width = `${Math.max(0.8, (t.e - t.s) / CALL_DUR * 100)}%`;
      const desc = `Turn ${t.id}, ${t.t}, ${t.pw === null ? 'not scored' : t.pw === 0 ? 'matches the reference' : `${t.pw} words off`}`;
      b.title = desc; b.setAttribute('aria-label', `Jump to ${desc}`); b.dataset.reg = t.id;
      b.addEventListener('click', ev => { ev.stopPropagation(); setActive(idx); seek(t.s); });
      track.appendChild(b);
    });

    const curTime = document.getElementById('curTime');
    const playPause = document.getElementById('playPause');
    const prev = document.getElementById('prevTurn');
    const next = document.getElementById('nextTurn');
    const speed = document.getElementById('speed');

    function setActive(idx) {
      if (idx < 0 || idx >= rows.length) return;
      if (typeof activeTurn !== 'undefined') activeTurn = idx;
      call('paintScript');
      markRegion();
    }
    function markRegion() {
      const cur = rows[typeof activeTurn !== 'undefined' ? activeTurn : 0];
      track.querySelectorAll('.reg').forEach(r => r.classList.toggle('sel', cur && r.dataset.reg === cur.id));
    }
    function paint() {
      const pos = audio.currentTime;
      cursor.style.left = `${Math.min(100, pos / CALL_DUR * 100)}%`;
      if (curTime) curTime.textContent = clock(pos);
      const hit = rows.findIndex(t => pos >= t.s - 0.2 && pos <= t.e + 0.2);
      if (hit > -1 && hit !== (typeof activeTurn !== 'undefined' ? activeTurn : -1)) setActive(hit);
    }
    function seek(sec) {
      const clamped = Math.max(0, Math.min(CALL_DUR, sec));
      try { audio.currentTime = clamped; } catch (e) {}
      cursor.style.left = `${Math.min(100, clamped / CALL_DUR * 100)}%`;
      if (curTime) curTime.textContent = clock(clamped);
    }
    function play() {
      audio.play().catch(() => {});
    }
    function toggle() {
      if (audio.paused) play(); else audio.pause();
    }

    audio.addEventListener('timeupdate', paint);
    audio.addEventListener('play', () => { if (typeof playing !== 'undefined') playing = true; if (playPause) { playPause.textContent = '\u275a\u275a'; playPause.setAttribute('aria-label', 'Pause'); } });
    audio.addEventListener('pause', () => { if (typeof playing !== 'undefined') playing = false; if (playPause) { playPause.textContent = '\u25b6'; playPause.setAttribute('aria-label', 'Play'); } });
    audio.addEventListener('ended', () => { if (playPause) playPause.textContent = '\u25b6'; });

    if (playPause) playPause.onclick = toggle;
    if (prev) prev.onclick = () => { const i = ((typeof activeTurn !== 'undefined' ? activeTurn : 0) - 1 + rows.length) % rows.length; setActive(i); seek(rows[i].s); };
    if (next) next.onclick = () => { const i = ((typeof activeTurn !== 'undefined' ? activeTurn : 0) + 1) % rows.length; setActive(i); seek(rows[i].s); };
    if (speed) speed.onchange = () => { audio.playbackRate = Number(speed.value) || 1; };

    track.addEventListener('click', e => {
      if (e.target.closest('.reg')) return;
      const r = track.getBoundingClientRect();
      seek((e.clientX - r.left) / r.width * CALL_DUR);
    });
    track.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { e.preventDefault(); seek(audio.currentTime + 2); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(audio.currentTime - 2); }
      else if (e.key === ' ') { e.preventDefault(); toggle(); }
    });

    /* Expose to mockup handlers (tdPlay "Listen to this turn"). */
    window.seekTo = seek;
    window.togglePlay = toggle;

    call('paintScript');
    markRegion();
  }

  /* Production produced no STT turns: show the challenger's call-level
     transcript across the transcript and replay tabs instead of an empty,
     dash-filled turn table. */
  function bindNoProd() {
    const wc = (D.challenger && D.challenger.word_count) || 0;
    const transcript = (D.challenger && D.challenger.transcript) || '';
    const kind = (D.challenger && D.challenger.kind) || 'challenger';
    const map = (D.challenger && D.challenger.mapping_summary) || {};

    /* Turn table → a single explanatory row. */
    const table = document.getElementById('turnRows');
    if (table) table.innerHTML = `<tr><td colspan="3"><div class="tid">No turn-level STT captured<small class="faint">this ${clock(D.duration_ms / 1000)} capture holds only connection frames</small></div></td></tr>`;

    /* Turn detail → the challenger transcript. */
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('tdTitle', `${chalLabel} transcript`);
    set('tdSub', `No turn-level STT was captured \u00b7 ${kind} challenger heard ${wc} word${wc === 1 ? '' : 's'}`);
    set('tdWindow', `00:00.0${MINUS}${clock(D.duration_ms / 1000)}`);
    const prod = document.getElementById('tdProd'), chal = document.getElementById('tdChal');
    if (prod) prod.innerHTML = `<span class="missing"><b>\u25c7</b> No turn-level speech-to-text was recorded in this capture, so production\u2019s transcript is unavailable to compare.</span>`;
    if (chal) chal.innerHTML = transcript ? esc(transcript) : '<span class="missing">The challenger returned no text either.</span>';
    set('tdProdV', 'not recorded');
    const cv = document.getElementById('tdChalV'); if (cv) { cv.className = 'vb ref'; cv.textContent = 'reference'; }
    const note = document.getElementById('tdNote');
    if (note) { note.className = 'note amber'; note.innerHTML = `<div class="t"><span aria-hidden="true">\u25b2</span>What this means</div>The challenger transcribed <b>${wc}</b> word${wc === 1 ? '' : 's'}, but with no recorded production turns there is nothing to align them to (${map.unmapped_word_count || wc} unmapped). This is a capture gap, not evidence that production mis-heard.`; }

    /* Score / breakdown / repeated words → reasons. */
    const score = document.querySelector('#transcript .score .big.num'); if (score) score.textContent = 'No score';
    const scoreSub = document.querySelector('#transcript .score .sub'); if (scoreSub) scoreSub.textContent = `No turn-level STT was captured, so word error rate cannot be computed. The ${kind} challenger transcribed ${wc} words.`;
    const words = document.querySelector('#transcript .words');
    if (words) words.innerHTML = `<div class="wordcard"><b>No paired words</b><span>no production turns were captured to compare</span></div>`;

    /* Replay script → the challenger transcript as one block. */
    const scriptBody = document.getElementById('scriptBody');
    if (scriptBody) scriptBody.innerHTML = `<div class="line"><div class="stamp"><b>${esc(chalLabel)}</b>full call</div><div class="c">${transcript ? esc(transcript) : '<span class="missing">no challenger text</span>'}</div><div class="tags"><span class="wins diff">no STT captured</span></div></div>`;
    const clockSpan = document.querySelector('#replay .clock span'); if (clockSpan) clockSpan.textContent = `of ${clock(D.duration_ms / 1000)}`;
  }

  /* ------------------------------------------------------ popover examples */
  function bindMetricExamples() {
    if (typeof METRICS === 'undefined') return;
    const a = D.accuracy, r = D.risk, L = D.latency, cost = D.cost, cov = D.coverage;
    const dw = (a.disagreed_words || [])[0];
    const LC = L.challenger || {}, lcAvail = LC.available !== false;
    const stream = (D.challenger && D.challenger.streaming) || {};
    const chalCap = (D.challenger && D.challenger.capabilities) || {};
    const costC = cost.challenger || {};
    const bi = L.barge_in || {}, biAvail = bi.available !== false;
    const la0 = lengthAgreement();
    const lenEx = la0 ? `${la0.production_chars} vs ${la0.challenger_chars} chars (length only)` : null;
    const accX = v => accAvail ? v : (captureNotRecorded ? (lenEx || 'transcript not recorded') : reasonText(a.reason || 'no_challenger'));
    const wer = pctI(a.call_estimated_wer);
    const ex = {
      'Estimated WER': accX(`${wer} on this call`),
      'Substitutions': accX(`${a.substitutions} of ${a.errors} errors`),
      'Deletions': accX(`${a.deletions} words production missed`),
      'Insertions': accX(`${a.insertions} words production added`),
      "Risk flag (currently \u2018Semantic Risk\u2019)": riskAvail ? `${r.outcome_risk_turns} outcome-risk turns${(r.high_turn_ids || []).length ? ` (${(r.high_turn_ids || []).join(', ')})` : ''}` : (captureNotRecorded ? 'risk could not be assessed (transcript not recorded)' : reasonText(r.reason || 'no_challenger')),
      'Turns ranked by highest WER': accAvail && (a.worst_turn_ids || []).length ? `Turn ${a.worst_turn_ids[0]} first` : accX('no ranking'),
      'Production transcript missing': `${(cov.production_no_text_turn_ids || []).length} turns`,
      'Challenger transcript missing': `${(cov.challenger_no_text_turn_ids || []).length} turn${(cov.challenger_no_text_turn_ids || []).length === 1 ? '' : 's'}${(cov.challenger_no_text_turn_ids || []).length ? ` (Turn ${(cov.challenger_no_text_turn_ids || []).join(', ')})` : ''}`,
      'Production vs challenger transcript': dw ? `${dw.production_word} \u2192 ${dw.challenger_word}` : accX('no repeated pairs'),
      'Audio playback for selected turn': (D.turns[0] ? `${clock(D.turns[0].speech_started_at_ms / 1000)}\u2013${clock(D.turns[0].speech_ended_at_ms / 1000)}` : 'no turns'),
      'Most disagreed words': dw ? `${dw.production_word} \u2192 ${dw.challenger_word} \u2013 ${dw.count}\u00d7` : accX('no repeated pairs'),
      'Language of disagreed words': hasChallenger && has(D.challenger.language_probability) ? `${D.challenger.language_code} \u00b7 ${pctI(D.challenger.language_probability)}` : hasChallenger ? 'language not detected' : 'challenger not run',
      'Evaluation cost': cost.evaluation && has(cost.evaluation.total) ? `${rupee(cost.evaluation.total)} / call` : 'challenger not run',
      'Median WER': D.cohort.available ? pctI(D.cohort.metrics.estimated_wer.cohort.p50) : reasonText(D.cohort.reason || 'cross_call_cohort_not_built'),
      'P90 / P95 / maximum WER': D.cohort.available ? `P90 ${pctI(D.cohort.metrics.estimated_wer.cohort.p90)} \u00b7 P95 ${pctI(D.cohort.metrics.estimated_wer.cohort.p95)}` : reasonText(D.cohort.reason || 'cross_call_cohort_not_built'),
      'Production first partial': fmtMs(L.production.first_partial_ms.p50),
      'Challenger first partial': lcAvail && LC.first_partial_ms ? fmtMs(LC.first_partial_ms.p50) : reasonText(LC.reason || 'no_streaming_replay'),
      'First partial delta': L.delta && L.delta.first_partial_ms && L.delta.first_partial_ms.count ? signMs(L.delta.first_partial_ms.p50) : '1 model only',
      'First stable partial': latReason('sp'),
      'Production endpoint': L.production.final_from_last_word_ms && has(L.production.final_from_last_word_ms.p50) ? `${fmtMs(L.production.final_from_last_word_ms.p50)} last word \u2192 final` : latReason('ffw'),
      'Challenger endpoint': lcAvail && LC.endpoint_delay_ms ? fmtMs(LC.endpoint_delay_ms.p50) : reasonText(LC.reason || 'no_streaming_replay'),
      'Endpoint delta': L.delta && L.delta.endpoint_delay_ms && L.delta.endpoint_delay_ms.count ? signMs(L.delta.endpoint_delay_ms.p50) : '1 model only',
      'Speech-to-final': fmtMs(L.production.speech_to_final_ms.p50),
      'Endpoint position error': has(L.production.endpoint_position_error_ms.p50) ? `${signMs(L.production.endpoint_position_error_ms.p50)} late` : latReason('ep'),
      'Cursor lag': latReason('cur'),
      'Post-end first result': lcAvail && LC.post_end_delay_ms ? fmtMs(LC.post_end_delay_ms.p50) : reasonText(LC.reason || 'no_streaming_replay'),
      'Partial revisions': has(L.production.partial_revision_rate.p50) ? `${num1(L.production.partial_revision_rate.p50)} per turn` : latReason('rev'),
      'Stable partial regions': latReason('sp'),
      'Configured silence threshold': fmtMs(L.production.configured_endpointing_ms.p50),
      'Observed finalization': fmtMs(L.production.endpoint_delay_ms.p50),
      'Observed vs configured': has(L.production.endpoint_delay_ms.p50) && has(L.production.configured_endpointing_ms.p50) ? signMs(L.production.endpoint_delay_ms.p50 - L.production.configured_endpointing_ms.p50) : latReason('ep'),
      'Finalization reason': topReason(),
      'STT share': has(L.budget.stt_share.p50) ? pctI(L.budget.stt_share.p50) : 'not computed',
      'Caller-perceived wait': fmtMs(L.production.caller_wait_ms.p50),
      'Counterfactual with challenger STT': latReason('ctotal'),
      'Forced-finalization rate': `${L.shape.forced_flush_count} of ${L.shape.measured_turns} turns`,
      'Barge-in overlap': biAvail ? `${bi.count} of ${bi.measured_turns} turns` : reasonText(bi.reason),
      'End-to-end evaluation turnaround': has(stream.wall_clock_ms) ? fmtMs(stream.wall_clock_ms) : 'challenger not run',
      'Streaming partial results': `${D.production.capabilities.streaming_partials ? 'Yes' : 'No'} \u00b7 ${hasChallenger ? (chalCap.streaming_partials ? 'Yes' : 'No') : 'not run'}`,
      'Code-switching support': `production ${D.production.capabilities.multilingual_turns ? 'yes' : 'no'} \u00b7 challenger ${hasChallenger ? ((chalCap.languages || []).join('/') || 'none listed') : 'not run'}`,
      'Evaluation coverage': `${cov.scored_turns} of ${cov.stt_turns} turns scored`,
      'Run state': D.run.state,
      'Error type breakdown': accX(`${a.substitutions} wrong \u00b7 ${a.deletions} missed \u00b7 ${a.insertions} added`),
      'Split, merged and manually-intervened turns': `${L.shape.split_or_merged_count} of ${L.shape.measured_turns} on the challenger stream`,
      'Cost to serve': has(costC.per_minute) ? `${rupee(cost.production.per_minute)}/min production vs ${rupee(costC.per_minute)}/min challenger` : `${rupee(cost.production.per_minute)}/min production \u00b7 challenger not run`,
      'Projected monthly spend': has(costC.per_month) ? `${rupee(cost.production.per_month)} \u2192 ${rupee(costC.per_month)} at ${compactCount(cost.volume.calls_per_month)} calls/month` : `${rupee(cost.production.per_month)}/month production \u00b7 challenger not run`,
      'Total cost of switching': `hosting ${cost.production.hosting || 'not recorded'} vs ${hasChallenger ? (costC.hosting || 'not recorded') : 'not run'}`,
      'Request reliability': `${streamStatus()}${has(stream.receipt_count) ? ` \u00b7 ${stream.receipt_count} stream receipts` : ''}`,
      'Word-level timestamps': `production ${D.production.capabilities.word_timestamps ? 'yes' : 'no'}, challenger ${hasChallenger ? (chalCap.word_timestamps ? 'yes' : 'no') : 'not run'}`,
      'Reference transcript': hasChallenger ? `${chalLabel} \u00b7 ${cov.scored_turns} of ${cov.stt_turns} turns scored` : 'challenger not run',
      'Word error rate vs reference': accX(`${wer} \u00b7 ${a.errors} words of ${a.reference_words}`),
      'Words wrong vs reference': accAvail && (a.worst_turn_ids || []).length ? `${((D.turns.find(t => String(t.turn_id) === String(a.worst_turn_ids[0])) || {}).score || {}).errors ?? a.errors} words off \u00b7 Turn ${a.worst_turn_ids[0]}` : accX('no ranking'),
      'Unscored turns': `${cov.unscored_turns} turn${cov.unscored_turns === 1 ? '' : 's'}${(cov.challenger_no_text_turn_ids || []).length ? ` \u00b7 Turn ${(cov.challenger_no_text_turn_ids || []).join(', ')} (no reference)` : ''}`
    };
    METRICS.forEach(m => { if (m.item in ex) m.example = has(ex[m.item]) || (typeof ex[m.item] === 'string' && ex[m.item] !== '') ? ex[m.item] : 'not measured on this call'; });
    /* Safety net: never leave an illustrative literal in an example. */
    const MOCKISH = /deepgram-nova-2|whisper-lg-v3|CALL-2481|run_8f31c2|42,000|3\.8 min|04:12|8\.2%|9 of 110|Turn 17|Turn 08|\u20b90\.46|\u20b90\.36|\u20b90\.25|\u20b957\.5k|\u20b939\.9k|\u20b917\.6k|22\.6%|7\.9%/;
    METRICS.forEach(m => { if (m.example && MOCKISH.test(m.example)) m.example = has(a.call_estimated_wer) ? `${wer} WER on this call` : reasonText(a.reason || 'no_challenger'); });

    /* The explanatory prose (meaning/why/counted/decision, plus the EXTRA
       plain/caveat) is kept, but its fabricated illustrative numbers are
       neutralised so no invented value survives anywhere on the page. */
    const scrub = str => typeof str !== 'string' ? str : str
      .replace(/deepgram-nova-2/g, prodLabel)
      .replace(/whisper-lg-v3/g, chalLabel)
      .replace(/CALL-2481/g, D.session_id)
      .replace(/run_8f31c2/g, D.run.id)
      .replace(/\b9 of 110\b/g, 'the measured count')
      .replace(/[\u2212+\-]?\u20b9\s?\d[\d.,]*\s?[kL]?/g, 'the measured cost')
      .replace(/[\u2212+\-]?\d[\d.,]*\s?(?:ms|s)\b/g, 'the measured value')
      .replace(/\b\d+(?:\.\d+)?\s?%/g, 'the measured rate')
      .replace(/\b42,?000\b/g, 'your monthly volume')
      .replace(/\b\d(?:\.\d)?\s?min(?:ute)?s?\b/g, 'your average call')
      .replace(/\b0?\d:\d\d\b/g, 'the call length')
      .replace(/\bTurn\s?0?\d+\b/g, 'a flagged turn')
      .replace(/\bnot captured\b/gi, 'the recorded reason')
      .replace(/\bnot returned\b/gi, 'the recorded reason')
      .replace(/ \u2014 /g, ' \u2013 ');
    METRICS.forEach(m => { ['meaning', 'why', 'counted', 'decision'].forEach(k => { if (m[k]) m[k] = scrub(m[k]); }); });
    if (typeof EXTRA !== 'undefined') Object.values(EXTRA).forEach(x => {
      if (x && x.plain) x.plain = scrub(x.plain);
      if (x && x.caveat) x.caveat = scrub(x.caveat);
      if (x && Array.isArray(x.read)) x.read = x.read.map(row => row.map(cell => typeof cell === 'string' ? scrub(cell) : cell));
    });

    /* Paired-delta explanation for the two comparable-latency metrics, set
       after scrub so the wording is preserved. */
    const dl = D.latency.delta || {};
    const pairedCounted = metric => {
      const blk = dl[metric] || {};
      const n = has(blk.count) ? blk.count : (has(dl.paired_turns) ? dl.paired_turns : null);
      return `The two models are timed on the same turns; the difference shown is the median of the per-turn (production \u2212 challenger) differences across ${has(n) ? n : 'the'} paired turns. That is deliberately not the difference of the two medians beside it, because those medians can come from different turns.`;
    };
    const byNameObj = typeof byName !== 'undefined' ? byName : null;
    if (byNameObj) {
      if (byNameObj['Production endpoint']) byNameObj['Production endpoint'].counted = pairedCounted('endpoint_delay_ms');
      if (byNameObj['Production first partial']) byNameObj['Production first partial'].counted = pairedCounted('first_partial_ms');
      if (byNameObj['Endpoint delta']) byNameObj['Endpoint delta'].counted = pairedCounted('endpoint_delay_ms');
      if (byNameObj['First partial delta']) byNameObj['First partial delta'].counted = pairedCounted('first_partial_ms');

      /* WER caveat: the reference is a second STT model, not human ground
         truth, so this is a disagreement measure and cannot rank correctness. */
      if (hasChallenger && accAvail) {
        const _isSub = w => w.operation === 'substitution' && w.production_word && !/^\(/.test(w.production_word);
        const _dwl = a.disagreed_words || [];
        const dwRefWrong = _dwl.find(w => _isSub(w) && /[-\u2013]$/.test(String(w.challenger_word))) || _dwl.find(_isSub);
        const werCaveat = `The reference is <b>${esc(chalLabel)}</b>, an STT model with its own errors; no human ground truth exists for this call. A high value means these two systems disagree a lot, not that production is wrong \u2013 it cannot rank which system is correct.${dwRefWrong ? ` On this call several disagreements are the reference mishearing (e.g. production \u201c${esc(dwRefWrong.production_word)}\u201d vs reference \u201c${esc(dwRefWrong.challenger_word)}\u201d).` : ''}`;
        ['Word error rate vs reference', 'Estimated WER', 'Words wrong vs reference'].forEach(item => {
          if (byNameObj[item]) { const ex = (typeof EXTRA !== 'undefined' ? (EXTRA[item] = EXTRA[item] || {}) : null); if (ex) ex.caveat = werCaveat; }
        });
      }
    }
  }
  function topReason() {
    const fr = D.latency.production.final_reasons || {};
    const top = Object.entries(fr).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : 'no production turns';
  }

  /* --------------------------------------------------------- turn table */
  function bindTurnTable() {
    if (typeof turns === 'undefined') return;
    const fAll = document.getElementById('fAll'); if (fAll) fAll.textContent = `All ${turns.length}`;
    const fRisk = document.getElementById('fRisk'); if (fRisk) fRisk.textContent = `Outcome risk ${turns.filter(t => t.risk === 'high').length}`;
    const fUnavail = document.getElementById('fUnavail'); if (fUnavail) fUnavail.textContent = `Unscored ${turns.filter(t => t.pw === null).length}`;
    call('renderTurns');
    const first = (D.accuracy.worst_turn_ids || [])[0] || (turns[0] && turns[0].id);
    if (first != null) call('selectTurn', String(first));
  }

  /* -------------------------------------------------------------- hydrate */
  async function hydrate() {
    let response;
    try {
      response = await fetch(`/v1/sessions/${encodeURIComponent(sessionId)}/stt-evaluation`);
      if (!response.ok) throw new Error(`session load failed (${response.status})`);
      D = await response.json();
    } catch (error) {
      const flag = document.querySelector('.mockflag');
      if (flag) flag.textContent = `Could not load evaluation data: ${error.message}`;
      return;
    }

    CURRENCY = D.cost && D.cost.currency === 'INR' ? '\u20b9' : (D.cost && D.cost.currency === 'USD' ? '$' : `${D.cost ? D.cost.currency + ' ' : ''}`);
    prodLabel = D.production.label || D.production.model || D.production.provider || 'production STT';
    hasChallenger = !!D.challenger;
    chalLabel = hasChallenger ? (D.challenger.label || D.challenger.model || D.challenger.provider || 'challenger') : 'the challenger';
    accAvail = !!(hasChallenger && D.accuracy && D.accuracy.available !== false);
    /* Risk is only "available" when turns were actually evaluated; a skip on
       every turn (e.g. transcript not captured) is not a finding. */
    riskAvail = !!(hasChallenger && D.risk && D.risk.available !== false && D.coverage.risk_evaluated_turns > 0);
    noProdTurns = !(D.turns && D.turns.length);
    prodPriced = has(D.cost && D.cost.production && D.cost.production.per_minute);
    missedSpeechIds = (D.turns || []).filter(t => t.score && t.score.status === 'possible_missed_speech').map(t => String(t.turn_id));
    notCapturedIds = (D.turns || []).filter(t => t.score && t.score.status === 'production_transcript_not_captured').map(t => String(t.turn_id));
    /* The capture stored only transcript length, not text: accuracy is
       genuinely un-judgeable (a capture limitation, NOT a production failure). */
    captureNotRecorded = notCapturedIds.length > 0 && !accAvail;

    buildTurns();
    bindMetricExamples();
    bindHeader();
    bindAnswer();
    bindScorecards();
    bindDecision();
    bindCost();
    bindTranscriptPanels();
    bindCohort();
    bindTurnTable();
    bindLatency();
    bindReplay();
    if (noProdTurns) bindNoProd();

    /* Re-run mockup systems that depend on the freshly-bound DOM. */
    call('upgradeWhyTriggers');
    /* The mockup's why-triggers add a screen-reader label that starts with an
       em dash ("\u2014 explain X"); drop the leading dash so it is not read as
       an empty placeholder. */
    document.querySelectorAll('.why .sr').forEach(el => { el.textContent = el.textContent.replace(/^\s*[\u2014\u2013\u2212-]\s*/, ''); });
    /* The mockup's renderTally hardcodes a note that "accuracy rows assume the
       challenger transcript is correct" — no longer true (the reference is a
       second STT model). Wrap it so the note reflects the disagreement framing
       on every render (including on visibility toggles). */
    if (typeof window.renderTally === 'function' && !window.renderTally.__wrapped) {
      const origTally = window.renderTally;
      window.renderTally = function () {
        origTally.apply(this, arguments);
        const n = document.querySelector('#tally .faint');
        if (n && /assume the challenger transcript is correct/i.test(n.innerHTML)) {
          n.innerHTML = n.innerHTML.replace(/accuracy rows assume the challenger transcript is correct/i, 'the reference is a second STT model, not ground truth');
        }
      };
      window.renderTally.__wrapped = true;
    }
    call('renderTally');
    call('applyVisibility');
    if (typeof glossarySearch !== 'undefined') call('renderGlossary', '');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hydrate);
  else hydrate();
})();
