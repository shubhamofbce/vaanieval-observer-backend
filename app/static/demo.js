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
    const calls = config.call_count ? `${config.call_count} real calls` : 'sample calls';
    const when = config.window_label ? ` from ${config.window_label}` : '';
    const note = el('span', { class: 'demo-note' },
      el('span', { class: 'demo-tag', text: 'Live demo' }),
      el('span', {
        class: 'demo-note-text',
        text: `${calls}${when}, anonymised. Read-only — the audio, transcripts, timings and traces are real captures.`,
      }),
    );

    const actions = el('div', { class: 'demo-actions' },
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

  function intro() {
    // The dashboard opens on a wall of red. Without a sentence of framing a
    // visitor reads it as "this vendor's agents are broken" instead of "this
    // tool found the problem", which is the opposite of the intended effect.
    // The numbers are real and are not softened; only the reading is supplied.
    const heading = el('h2', {
      class: 'demo-intro-title',
      text: 'This is a real agent in trouble — and how you find out why.',
    });
    const body = el('p', {
      class: 'demo-intro-text',
      text:
        'Vaani Observer measured every turn of these captured calls and flagged the ones a '
        + 'caller would have felt. The red is the finding, not the product. Open a flagged call '
        + 'to hear the audio, read the transcript, and land on the exact turn that caused it.',
    });
    const actions = el('div', { class: 'demo-intro-actions' },
      FEATURED
        ? el('a', {
            class: 'demo-intro-cta',
            href: `/#/call/${FEATURED}`,
            text: 'Open a call →',
          })
        : null,
      el('span', {
        class: 'demo-intro-hint',
        text: 'or click any row in “Calls needing attention”.',
      }),
    );
    const desktop = el('p', {
      class: 'demo-desktop-note',
      text:
        'On a phone you are seeing the summary. The call view — waveform, transcript '
        + 'and trace side by side — is built for a desktop screen.',
    });
    return el('section', { class: 'demo-intro' }, heading, body, actions, desktop);
  }

  function mountIntro() {
    if (document.querySelector('.demo-intro')) return;
    // Only on the dashboard: the console already opens on the evidence, so the
    // same framing there would be an interruption rather than an orientation.
    const filters = document.getElementById('filters');
    if (!filters || !filters.parentNode) return;
    filters.parentNode.insertBefore(intro(), filters);
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
    mountConsoleCta();
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
})();
