/* Light/dark switch, shared by every Observer surface.
 *
 * The console is themed entirely through custom properties on :root, so
 * switching is one attribute write — there is no second stylesheet and no
 * per-component branching to keep in sync.
 *
 * Two things here are deliberate and easy to break:
 *
 * 1. The stored choice is applied by an inline snippet in <head>, before any
 *    paint (see the `data-theme` bootstrap in each page). This file only owns
 *    the control and the persistence. Applying the theme from here would mean
 *    a frame of the wrong theme on every load, which on a dark-preferring
 *    visitor is a white flash straight into the eyes.
 *
 * 2. The control is a switch, so it reports *state*, not an action: knob left
 *    is light, knob right is dark, and both icons stay on the track the whole
 *    time. A control that renames itself as you use it cannot be read at a
 *    glance, and there is no honest resting label for two states anyway.
 *    `role="switch"` plus `aria-checked` gives assistive tech the same reading
 *    the knob position gives the eye.
 */
(function () {
  const KEY = 'vaani.theme';
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const stored = () => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  };
  const store = (v) => {
    try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* private mode */ }
  };

  /* Resolved theme: an explicit choice wins, otherwise follow the OS. */
  const resolved = () => stored() || (media.matches ? 'dark' : 'light');

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', theme);
    document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
      const dark = theme === 'dark';
      /* State, not action: the knob's side names the theme you are in. */
      btn.setAttribute('data-mode', theme);
      btn.removeAttribute('aria-pressed');
      btn.setAttribute('aria-checked', dark ? 'true' : 'false');
      btn.setAttribute('aria-label', 'Dark theme');
      btn.title = 'Dark theme  ·  d';
    });
    window.dispatchEvent(new CustomEvent('vaani:themechange', { detail: { theme } }));
  }

  function set(theme) {
    store(theme);
    apply(theme);
  }

  const ICON_SUN = '<path fill="currentColor" d="M8 11.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7Zm0-1.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0-8a.7.7 0 0 1 .7.7v1.1a.7.7 0 1 1-1.4 0V2.7A.7.7 0 0 1 8 2Zm0 9.5a.7.7 0 0 1 .7.7v1.1a.7.7 0 1 1-1.4 0v-1.1a.7.7 0 0 1 .7-.7ZM2 8a.7.7 0 0 1 .7-.7h1.1a.7.7 0 1 1 0 1.4H2.7A.7.7 0 0 1 2 8Zm9.5 0a.7.7 0 0 1 .7-.7h1.1a.7.7 0 1 1 0 1.4h-1.1a.7.7 0 0 1-.7-.7ZM3.76 3.76a.7.7 0 0 1 .99 0l.78.78a.7.7 0 0 1-.99.99l-.78-.78a.7.7 0 0 1 0-.99Zm6.71 6.71a.7.7 0 0 1 .99 0l.78.78a.7.7 0 1 1-.99.99l-.78-.78a.7.7 0 0 1 0-.99Zm1.77-6.71a.7.7 0 0 1 0 .99l-.78.78a.7.7 0 0 1-.99-.99l.78-.78a.7.7 0 0 1 .99 0ZM5.53 10.47a.7.7 0 0 1 0 .99l-.78.78a.7.7 0 0 1-.99-.99l.78-.78a.7.7 0 0 1 .99 0Z"/>';
  const ICON_MOON = '<path fill="currentColor" d="M6.2 2.4a.7.7 0 0 1 .16.76 4.9 4.9 0 0 0 6.48 6.48.7.7 0 0 1 .92.92A6.3 6.3 0 1 1 5.44 2.24a.7.7 0 0 1 .76.16Zm-1.5 1.7a4.9 4.9 0 1 0 7.2 7.2A6.3 6.3 0 0 1 4.7 4.1Z"/>';

  function button() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-switch';
    btn.id = 'theme-toggle';
    btn.setAttribute('data-theme-toggle', '');
    btn.setAttribute('role', 'switch');
    btn.setAttribute('data-mode', 'light');
    /* Both icons ship and sit above the knob, so toggling never waits on a
       re-render and the control cannot flicker between glyphs. */
    btn.innerHTML =
      '<span class="theme-switch-track" aria-hidden="true">' +
      '<span class="theme-switch-knob"></span>' +
      `<svg class="theme-switch-icon theme-switch-icon--sun" viewBox="0 0 16 16" width="12" height="12">${ICON_SUN}</svg>` +
      `<svg class="theme-switch-icon theme-switch-icon--moon" viewBox="0 0 16 16" width="12" height="12">${ICON_MOON}</svg>` +
      '</span>';
    btn.addEventListener('click', () => {
      set(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    return btn;
  }

  function mount() {
    if (document.querySelector('[data-theme-toggle]')) return;
    /* Prefer the demo bar: in the demo that is the top bar the visitor sees.
       Outside the demo there is no top bar at all, so the sections rail foot
       is the stable home next to Refresh. */
    const host = document.querySelector('.demo-actions') || document.querySelector('.sidebar-foot');
    if (!host) return;
    const btn = button();
    if (host.classList.contains('demo-actions')) host.insertBefore(btn, host.firstChild);
    else host.insertBefore(btn, host.querySelector('.sidebar-refresh') || null);
    apply(resolved());
  }

  /* The demo bar is injected by demo.js after load, and the rail is rendered by
     nav.js, so a single mount on DOMContentLoaded can land before either host
     exists. Observing the body covers every ordering without racing. */
  function watch() {
    mount();
    if (document.querySelector('[data-theme-toggle]')) return;
    const obs = new MutationObserver(() => {
      mount();
      if (document.querySelector('[data-theme-toggle]')) obs.disconnect();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    /* Never observe forever: a surface with neither host is a valid page. */
    setTimeout(() => obs.disconnect(), 8000);
  }

  /* Only follow the OS while the visitor has not chosen for themselves. */
  media.addEventListener('change', () => { if (!stored()) apply(resolved()); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'd' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    set(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  apply(resolved());
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();

  window.vaaniTheme = { get: resolved, set };
})();
