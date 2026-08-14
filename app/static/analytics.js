/* Demo-side analytics: closes the loop between a shared link and what the
 * visitor actually did in the console.
 *
 * The marketing site and this console are two applications on two hosts. GA4
 * on the site alone stops measuring the moment someone clicks through, which
 * is exactly the moment worth measuring — opening the demo is the conversion
 * the shared links are for.
 *
 * Three things happen here and nothing else:
 *
 * 1. GA4 is loaded with the same measurement id as the site, so both hosts
 *    report into one property. The cookie is written on the registrable domain
 *    so a visitor who crosses from the site keeps one client id and one
 *    session rather than appearing as a second, self-referred visitor.
 * 2. Attribution is recovered — first from the incoming utm_* params the site
 *    appends to the demo link, then from the shared cookie if the visitor
 *    typed the demo URL directly.
 * 3. A handful of real demo actions are reported. Not every click: only the
 *    ones that separate "bounced off the dashboard" from "listened to a call",
 *    because that is the difference a shared link is being judged on.
 *
 * Loading is entirely conditional on a measurement id being configured, so an
 * unconfigured deployment ships no third-party script and sets no cookie.
 */
(function () {
  const config = window.__VAANI_DEMO__;
  if (!config || !config.ga_id) return;

  const GA_ID = config.ga_id;

  /* One cookie domain for both hosts. Without this the console writes its own
     _ga on demo.vaanieval.com and the two surfaces never join up. */
  function registrableDomain() {
    const host = location.hostname;
    if (host === 'localhost' || /^[\d.]+$/.test(host)) return undefined;
    const parts = host.split('.');
    return parts.length < 2 ? undefined : parts.slice(-2).join('.');
  }

  function readCookie(name) {
    const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    if (!hit) return null;
    try { return JSON.parse(decodeURIComponent(hit.slice(name.length + 1))); } catch { return null; }
  }

  /* The link the site built wins over the stored cookie: it describes this
     specific click, while the cookie describes the visitor's history. */
  function attribution() {
    const q = new URLSearchParams(location.search);
    const fromUrl = {
      source: q.get('utm_source') || undefined,
      medium: q.get('utm_medium') || undefined,
      campaign: q.get('utm_campaign') || undefined,
      content: q.get('utm_content') || undefined,
      ref: q.get('ref') || undefined,
    };
    if (Object.values(fromUrl).some(Boolean)) return { attr: fromUrl, via: 'link' };
    const cookie = readCookie('va_attr_last') || readCookie('va_attr_first');
    if (cookie) return { attr: cookie, via: 'cookie' };
    return { attr: {}, via: 'direct' };
  }

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;

  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GA_ID);
  document.head.appendChild(script);

  const { attr, via } = attribution();

  gtag('js', new Date());
  gtag('config', GA_ID, {
    anonymize_ip: true,
    cookie_domain: registrableDomain() || 'none',
    /* The demo is one property with the site, so page paths are prefixed to
       stay legible in a report that also contains marketing routes. */
    page_title: 'Demo · ' + document.title,
  });

  gtag('set', 'user_properties', {
    demo_source: attr.source || attr.ref || 'direct',
    demo_campaign: attr.campaign || 'none',
    demo_attribution_via: via,
  });

  gtag('event', 'demo_opened', {
    utm_source: attr.source || 'direct',
    utm_medium: attr.medium || 'none',
    utm_campaign: attr.campaign || 'none',
    ref: attr.ref || 'none',
    attribution_via: via,
    entry_path: location.pathname,
    snapshot_id: config.snapshot_id || '',
  });

  /* Delegated so it covers rows and controls the console renders later, and so
     there is one list of what counts as engagement rather than a call in every
     feature file. */
  const INTENT = [
    ['.demo-cta, [data-demo-cta]', 'demo_booking_clicked'],
    ['a.sidenav-item[href^="/alerts"]', 'demo_alerts_opened'],
    ['a.sidenav-item[href^="/stt-evaluation"]', 'demo_stt_opened'],
    /* A table row carrying data-open is how the console opens a call, on every
       surface that lists calls, so one selector covers them all. */
    ['tr.clickable[data-open], [data-open-session], a[href*="session="]', 'demo_call_opened'],
    ['a[href*="vaanieval.com"]:not([href*="demo."])', 'demo_back_to_site'],
  ];

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    for (const [selector, name] of INTENT) {
      if (target.closest(selector)) { gtag('event', name, { path: location.pathname }); return; }
    }
  }, true);

  /* Audio playback is the demo's real proof, and it is reported once per page
     so a visitor scrubbing a call does not inflate the number. */
  let heardPlayback = false;
  document.addEventListener('play', () => {
    if (heardPlayback) return;
    heardPlayback = true;
    gtag('event', 'demo_audio_played', { path: location.pathname });
  }, true);
})();
