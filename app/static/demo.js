/* Public demo chrome.
 *
 * Loaded only when the server is in demo mode. Its whole job is to make the
 * console honest about what it is showing and continuous with the site the
 * visitor came from: a header that carries the VaaniEval mark, a plain
 * statement that the calls are a fixed sample, and a route back to the site
 * and to a booking. Everything else on the page is the real product.
 */
(function () {
  const config = window.__VAANI_DEMO__;
  if (!config) return;

  const SITE = config.site_url || 'https://www.vaanieval.com';
  const BOOKING = config.booking_url || SITE;
  const FEATURED = config.featured_session_id || '';

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value == null) return;
      if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else node.setAttribute(key, value);
    });
    children.filter(Boolean).forEach((child) => node.append(child));
    return node;
  }

  function bar() {
    const brand = el('a', {
      class: 'demo-brand',
      href: SITE,
      title: 'VaaniEval home',
    },
      el('span', { class: 'demo-logo' }, el('img', { src: '/assets/vaanieval-logo.jpg', alt: '' })),
      el('span', { class: 'demo-word', html: 'Vaani<span>Eval</span>' }),
    );

    // Say the date out loud. The snapshot's clock is frozen, so "3 days ago" in
    // the call list is measured from the sample window and not from today; a
    // visitor who is not told that will read it as stale data.
    // Say the date out loud. The snapshot's clock is frozen, so "3 days ago" in
    // the call list is measured from the sample window and not from today; a
    // visitor who is not told that will read it as stale data.
    // The bar carries the date and nothing else; the full provenance sentence
    // lives in the title, and "How to read this" is where a visitor who wants
    // the explanation actually goes.
    const calls = config.call_count ? `${config.call_count} real calls` : 'Sample calls';
    const when = config.window_label ? ` · ${config.window_label}` : '';
    const note = el('span', { class: 'demo-note' },
      el('span', { class: 'demo-tag', text: 'Live demo' }),
      el('span', {
        class: 'demo-note-text',
        title: `${calls} from ${config.window_label || 'the sample window'}, anonymised. Read-only — the audio, transcripts, timings and traces are real captures.`,
        text: `${calls}${when} · anonymised`,
      }),
    );

    const actions = el('div', { class: 'demo-actions' },
      guideButton(),
      el('a', { class: 'demo-link', href: SITE, text: 'Back to vaanieval.com' }),
      el('a', {
        class: 'demo-cta',
        href: BOOKING,
        target: '_blank',
        rel: 'noopener',
        text: 'Book a demo',
      }),
    );

    return el('header', { class: 'demo-bar', role: 'banner' }, brand, note, actions);
  }

  function desktopNote() {
    return el('p', {
      class: 'demo-desktop-note',
      text:
        'On a phone you are seeing the summary. The call view — waveform, transcript '
        + 'and trace side by side — is built for a desktop screen.',
    });
  }

  /* Orientation.
     -----------------------------------------------------------------------
     The dashboard opens on a wall of red, because the sample agent really was
     slow and really did fail. Without framing, a visitor reads that as "this
     vendor's agents are broken" rather than "this tool found the problem".
     That framing used to sit in a band above the KPIs, where it ate the top of
     the page every visit for a sentence most people read once. It now lives
     behind a header control, the way a product tour trigger does: available on
     every page, costing no space on any of them. A dot marks it unread so the
     first-time visitor is still pointed at it. */
  const SEEN_KEY = 'vaani.demo.guide.seen.v1';

  function seen() {
    try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (err) { return false; }
  }

  function markSeen() {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (err) { /* private mode */ }
  }

  function guideButton() {
    const btn = el('button', {
      type: 'button',
      class: seen() ? 'demo-guide-btn' : 'demo-guide-btn is-new',
      id: 'demo-guide-btn',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
    },
      el('span', { class: 'demo-guide-icon', 'aria-hidden': 'true', text: '?' }),
      el('span', { class: 'demo-guide-label', text: 'How to read this' }),
    );
    btn.addEventListener('click', openGuide);
    return btn;
  }

  let lastFocus = null;

  function guideDialog() {
    const close = el('button', {
      type: 'button',
      class: 'demo-guide-close',
      'aria-label': 'Close',
      text: '✕',
    });

    const card = el('div', {
      class: 'demo-guide-card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'demo-guide-title',
      tabindex: '-1',
    },
      close,
      el('h2', {
        class: 'demo-guide-title',
        id: 'demo-guide-title',
        text: 'This is a real agent in trouble — and how you find out why.',
      }),
      el('p', {
        class: 'demo-guide-text',
        text:
          'Vaani Observer measured every turn of these captured calls and flagged the ones a '
          + 'caller would have felt. The red is the finding, not the product. Open a flagged call '
          + 'to hear the audio, read the transcript, and land on the exact turn that caused it.',
      }),
      el('div', { class: 'demo-guide-actions' },
        FEATURED
          ? el('a', {
              class: 'demo-guide-cta',
              href: `/#/call/${FEATURED}`,
              text: 'Open a call →',
            })
          : null,
        el('span', {
          class: 'demo-guide-hint',
          text: 'or click any row in “Calls needing attention”.',
        }),
      ),
    );

    const wrap = el('div', { class: 'demo-guide-scrim', id: 'demo-guide' }, card);
    close.addEventListener('click', closeGuide);
    wrap.addEventListener('click', (event) => { if (event.target === wrap) closeGuide(); });
    return wrap;
  }

  function onGuideKey(event) {
    if (event.key === 'Escape') { closeGuide(); return; }
    if (event.key !== 'Tab') return;
    const card = document.querySelector('.demo-guide-card');
    if (!card) return;
    const stops = [...card.querySelectorAll('a[href], button')].filter((n) => !n.disabled);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function openGuide() {
    if (document.getElementById('demo-guide')) return;
    lastFocus = document.activeElement;
    const btn = document.getElementById('demo-guide-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.remove('is-new');
    }
    markSeen();
    const wrap = guideDialog();
    document.body.append(wrap);
    // The console behind the dialog stays reachable to a screen reader unless
    // it is inerted, which makes aria-modal a claim the page does not keep.
    [...document.body.children].forEach((node) => {
      if (node !== wrap && node.nodeType === 1) node.toggleAttribute('inert', true);
    });
    wrap.querySelector('.demo-guide-card').focus();
    document.addEventListener('keydown', onGuideKey);
  }

  function closeGuide() {
    const wrap = document.getElementById('demo-guide');
    if (!wrap) return;
    document.removeEventListener('keydown', onGuideKey);
    wrap.remove();
    [...document.body.children].forEach((node) => {
      if (node.nodeType === 1) node.removeAttribute('inert');
    });
    const btn = document.getElementById('demo-guide-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (lastFocus && lastFocus.isConnected) lastFocus.focus();
    else if (btn) btn.focus();
  }

  function mountIntro() {
    // The phone warning still belongs in the page: it explains why the layout
    // is reduced, which is only useful at the moment the visitor sees it. It
    // is display:none above 860px, so it costs a desktop visitor nothing.
    if (document.querySelector('.demo-desktop-note')) return;
    const filters = document.getElementById('filters');
    if (!filters || !filters.parentNode) return;
    filters.parentNode.insertBefore(desktopNote(), filters);
  }

  function mountCallDesktopNote() {
    // A visitor who arrives on a shared call link never passes the dashboard,
    // so without this the phone warning only reaches the people who did not
    // need it. Same note, same breakpoint, at the top of the call they opened.
    const host = document.getElementById('call');
    if (!host || !host.children.length) return;
    if (host.querySelector('.demo-desktop-note')) return;
    host.prepend(desktopNote());
  }

  function mountConsoleCta() {
    // Placed at the end of the call detail, which is the point of peak
    // interest: the visitor has just heard the failure and seen the trace.
    if (document.querySelector('.demo-close-cta')) return;
    const host = document.getElementById('call');
    if (!host || !host.children.length) return;
    host.append(el('aside', { class: 'demo-close-cta' },
      el('span', {
        class: 'demo-close-text',
        text: 'This is one recorded call. See it running against your own traffic.',
      }),
      el('a', {
        class: 'demo-cta',
        href: BOOKING,
        target: '_blank',
        rel: 'noopener',
        text: 'Book a 20-minute walkthrough',
      }),
    ));
  }

  function mount() {
    if (!document.querySelector('.demo-bar')) document.body.prepend(bar());
    mountIntro();
    mountCallDesktopNote();
    mountConsoleCta();
    document.title = document.title.includes('Demo')
      ? document.title
      : `${document.title} · Live demo`;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // The console renders asynchronously and re-renders on navigation, so a
  // one-shot mount would miss it or lose the CTA on the next call.
  const observer = new MutationObserver(() => {
    mountIntro();
    mountCallDesktopNote();
    mountConsoleCta();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
})();
