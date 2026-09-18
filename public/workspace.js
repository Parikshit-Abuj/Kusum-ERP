/* Presentation interactions only. No requests, polling or transaction handlers. */
'use strict';
(() => {
  const menus = [...document.querySelectorAll('.account-menu, .action-menu')];
  menus.forEach(menu => menu.addEventListener('toggle', () => {
    if (menu.open) menus.forEach(other => { if (other !== menu) other.open = false; });
  }));
  document.addEventListener('click', event => {
    menus.forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const focused = menus.find(menu => menu.open && menu.contains(document.activeElement));
    menus.forEach(menu => { menu.open = false; });
    focused?.querySelector('summary')?.focus();
    const sidebar = document.getElementById('appSidebar');
    if (sidebar?.classList.contains('is-open')) {
      document.getElementById('mobileMenuToggle')?.click();
      document.getElementById('mobileMenuToggle')?.focus();
    }
  });
  // Keep the active navigation item in view on shorter shop displays.
  const activeLink = document.querySelector('.sidebar nav a[aria-current="page"]');
  const navigation = activeLink?.closest('nav');
  if (navigation && activeLink) {
    const linkBox = activeLink.getBoundingClientRect();
    const navBox = navigation.getBoundingClientRect();
    if (linkBox.bottom > navBox.bottom) navigation.scrollTop += linkBox.bottom - navBox.bottom + 12;
  }

  // Let each user choose between the full-screen workspace and the normal
  // navigation.  The preference is local to this ERP installation and does
  // not affect another user or device.
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('appSidebar');
  if (sidebarToggle && sidebar) {
    const STORAGE_KEY = 'kusum-erp-sidebar-collapsed';
    let collapsed = false;
    try { collapsed = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}

    const applySidebarPreference = (next, { persist = true } = {}) => {
      collapsed = Boolean(next);
      const desktop = window.innerWidth > 900;
      const hidden = desktop && collapsed;
      document.body.classList.toggle('sidebar-collapsed', hidden);
      sidebar.setAttribute('aria-hidden', hidden ? 'true' : 'false');
      if ('inert' in sidebar) sidebar.inert = hidden;
      sidebarToggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
      const label = hidden ? 'Show navigation' : 'Hide navigation';
      const localizedLabel = typeof window.kusumUiText === 'function' ? window.kusumUiText(label) : label;
      sidebarToggle.setAttribute('aria-label', localizedLabel);
      sidebarToggle.setAttribute('title', localizedLabel);
      const text = sidebarToggle.querySelector('[data-sidebar-toggle-label]');
      if (text) text.textContent = localizedLabel;
      const glyph = sidebarToggle.querySelector('.sidebar-toggle-glyph');
      if (glyph) glyph.textContent = hidden ? '›' : '‹';
      if (persist) {
        try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch (_) {}
      }
      if (hidden && sidebar.contains(document.activeElement)) sidebarToggle.focus();
    };

    sidebarToggle.addEventListener('click', () => applySidebarPreference(!collapsed));
    window.addEventListener('resize', () => applySidebarPreference(collapsed, { persist: false }));
    applySidebarPreference(collapsed, { persist: false });
  }

  // Let the ambient background gently follow the pointer without changing
  // any workspace controls or content.
  const ambientRoot = document.body.classList.contains('erp-ui') || document.body.classList.contains('erp-login')
    ? document.body
    : null;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (ambientRoot && !reduceMotion) {
    let targetX = .5;
    let targetY = .42;
    let currentX = targetX;
    let currentY = targetY;
    let frame = 0;

    const renderAmbientPointer = () => {
      currentX += (targetX - currentX) * .085;
      currentY += (targetY - currentY) * .085;
      ambientRoot.style.setProperty('--ambient-x', `${(currentX * 100).toFixed(2)}%`);
      ambientRoot.style.setProperty('--ambient-y', `${(currentY * 100).toFixed(2)}%`);
      ambientRoot.style.setProperty('--ambient-shift-x', `${((currentX - .5) * 34).toFixed(2)}px`);
      ambientRoot.style.setProperty('--ambient-shift-y', `${((currentY - .42) * 24).toFixed(2)}px`);
      if (Math.abs(targetX - currentX) > .001 || Math.abs(targetY - currentY) > .001) {
        frame = window.requestAnimationFrame(renderAmbientPointer);
      } else {
        frame = 0;
      }
    };

    const setAmbientTarget = event => {
      targetX = Math.min(1, Math.max(0, event.clientX / Math.max(window.innerWidth, 1)));
      targetY = Math.min(1, Math.max(0, event.clientY / Math.max(window.innerHeight, 1)));
      if (!frame) frame = window.requestAnimationFrame(renderAmbientPointer);
    };
    window.addEventListener('pointermove', setAmbientTarget, { passive: true });
    window.addEventListener('pointerleave', () => {
      targetX = .5;
      targetY = .42;
      if (!frame) frame = window.requestAnimationFrame(renderAmbientPointer);
    }, { passive: true });
  }

})();
