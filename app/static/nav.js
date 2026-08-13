/* Shared left navigation for every Observer surface.
 *
 * It lives in one file, injected by both the console and the dashboard, because
 * two hand-maintained copies of a nav drift: the day someone adds a section it
 * appears on one page and not the other, and the product quietly becomes two
 * products. The current section is derived from the URL rather than passed in,
 * so a page cannot mislabel itself.
 */
(function () {
  const SECTIONS = [
    {
      id: 'onboarding',
      label: 'Get started',
      href: '/onboarding',
      hint: 'Install an SDK and send your first call',
      icon: '<path fill="currentColor" d="M10 2.2a.75.75 0 0 1 .53.22l3.5 3.5a.75.75 0 0 1 0 1.06l-6.4 6.4a.75.75 0 0 1-.36.2l-3.2.8a.75.75 0 0 1-.91-.91l.8-3.2a.75.75 0 0 1 .2-.36l6.4-6.4a.75.75 0 0 1 .53-.22Zm-6.25 14.3a.75.75 0 0 1 .75-.75h11a.75.75 0 0 1 0 1.5h-11a.75.75 0 0 1-.75-.75Z"/>',
    },
    {
      id: 'dashboard',
      label: 'Dashboard',
      href: '/dashboard',
      hint: 'Fleet latency and reliability',
      icon: '<path fill="currentColor" d="M3 3h6v7H3V3Zm0 9h6v5H3v-5Zm8 4h6V9h-6v7Zm0-13v4h6V3h-6Z"/>',
    },
    {
      id: 'calls',
      label: 'Calls',
      href: '/',
      hint: 'Open one recorded call',
      icon: '<path fill="currentColor" d="M4 7.5A1.5 1.5 0 0 1 5.5 6h1A1.5 1.5 0 0 1 8 7.5v5A1.5 1.5 0 0 1 6.5 14h-1A1.5 1.5 0 0 1 4 12.5v-5Zm5-3A1.5 1.5 0 0 1 10.5 3h1A1.5 1.5 0 0 1 13 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 9 15.5v-11Zm5 4A1.5 1.5 0 0 1 15.5 7h1A1.5 1.5 0 0 1 18 8.5v3a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 14 11.5v-3Z"/>',
    },
    {
      id: 'alerts',
      label: 'Alerts',
      href: null,
      hint: 'Coming soon',
      soon: true,
      icon: '<path fill="currentColor" d="M10 2a5 5 0 0 0-5 5v3l-1.4 2.3A.75.75 0 0 0 4.25 14h11.5a.75.75 0 0 0 .65-1.7L15 10V7a5 5 0 0 0-5-5Zm0 16a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 10 18Z"/>',
    },
  ];

  function currentSection() {
    const path = window.location.pathname;
    if (path.startsWith('/onboarding')) return 'onboarding';
    if (path.startsWith('/dashboard')) return 'dashboard';
    return 'calls';
  }

  function render() {
    const active = currentSection();
    const nav = document.createElement('nav');
    nav.className = 'sidenav';
    nav.setAttribute('aria-label', 'Sections');
    nav.innerHTML = SECTIONS.map((section) => {
      const isActive = section.id === active;
      const icon = `<svg viewBox="0 0 20 20" width="17" height="17" aria-hidden="true">${section.icon}</svg>`;
      const body = `${icon}<span class="sidenav-label">${section.label}</span>${
        section.soon ? '<span class="sidenav-soon">Soon</span>' : ''
      }`;
      if (!section.href) {
        // A disabled link that still receives focus is a trap for keyboard
        // users: it announces a destination that does not exist. A button
        // marked disabled says what it is.
        return `<button type="button" class="sidenav-item" disabled aria-disabled="true" title="${section.hint}">${body}</button>`;
      }
      return `<a class="sidenav-item${isActive ? ' is-active' : ''}" href="${section.href}"${
        isActive ? ' aria-current="page"' : ''
      } title="${section.hint}">${body}</a>`;
    }).join('');
    return nav;
  }

  function mount() {
    if (document.querySelector('.sidenav')) return;
    const slot = document.querySelector('[data-nav-slot]');
    const shell = slot || document.querySelector('[data-workspace]');
    if (!shell) return;
    if (slot) slot.append(render());
    else shell.prepend(render());
    wireCollapse();
  }

  /* The sections rail, the call list and the player deck all fold, and all
   * three remember what the reviewer chose. A rail that reopens on every page
   * load is a rail the reviewer folds again on every page load. */
  const KEY = 'vaani.sidebar.collapsed';

  function wireCollapse() {
    const sidebar = document.getElementById('sidebar');
    const button = document.getElementById('sidebar-toggle');
    if (!sidebar || !button) return;

    const apply = (collapsed, save) => {
      sidebar.dataset.collapsed = String(collapsed);
      button.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? 'Expand the sections rail' : 'Collapse the sections rail';
      button.setAttribute('aria-label', label);
      button.title = `${label}  ·  n`;
      if (save) { try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch { /* private mode */ } }
    };

    let start = false;
    try { start = localStorage.getItem(KEY) !== '0'; } catch { /* private mode */ }
    // Collapsed by default: three sections do not earn 176px on every screen,
    // and the label is one hover — or one keystroke — away.
    apply(start, false);

    button.addEventListener('click', () => apply(sidebar.dataset.collapsed !== 'true', true));
    document.addEventListener('keydown', (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'n') return;
      const target = event.target;
      const typing = target instanceof HTMLElement
        && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (typing) return;
      apply(sidebar.dataset.collapsed !== 'true', true);
      event.preventDefault();
    });
  }

  // The slot is markup, not script, so by the time this file runs the element
  // it mounts into already exists. Waiting for DOMContentLoaded would publish
  // the nav *after* the page script has looked for the controls inside it.
  if (document.querySelector('[data-nav-slot], [data-workspace]')) mount();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
