(() => {
  'use strict';

  let lastSearchTrigger = null;

  const buttonLabels = [
    ['.search-popup-trigger', '打开站内搜索'],
    ['.popup-btn-close', '关闭站内搜索'],
    ['.navbar-bar', '打开导航菜单'],
    ['.toggle-tools-list', '展开页面工具'],
    ['.tool-font-adjust-plus', '增大正文字号'],
    ['.tool-font-adjust-minus', '减小正文字号'],
    ['.tool-dark-light-toggle', '切换明暗主题'],
    ['.tool-scroll-to-top', '返回页面顶部'],
    ['.tool-scroll-to-bottom', '前往页面底部'],
  ];

  function makeButton(element, label) {
    if (!element) return;
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    if (!element.getAttribute('aria-label')) element.setAttribute('aria-label', label);
  }

  function installSkipLink() {
    if (document.querySelector('.skip-to-content')) return;
    const target = document.querySelector('main, #main-container, .main-content, .post-content');
    if (!target) return;
    if (!target.id) target.id = 'main-content';
    target.setAttribute('tabindex', '-1');
    const link = document.createElement('a');
    link.className = 'skip-to-content';
    link.href = `#${target.id}`;
    link.textContent = '跳到正文';
    document.body.prepend(link);
  }

  function enhanceControls() {
    installSkipLink();
    buttonLabels.forEach(([selector, label]) => {
      document.querySelectorAll(selector).forEach((element) => makeButton(element, label));
    });
    document.querySelectorAll('.right-bottom-tools.rss a').forEach((link) => {
      link.setAttribute('aria-label', '订阅 RSS');
    });

    document.querySelectorAll('.desktop .has-dropdown').forEach((link) => {
      link.setAttribute('aria-haspopup', 'true');
      link.setAttribute('aria-expanded', link.matches(':focus') ? 'true' : 'false');
    });

    document.querySelectorAll('[navbar-data-toggle]').forEach((element) => {
      makeButton(element, '展开子菜单');
      const target = element.getAttribute('navbar-data-toggle');
      element.setAttribute('aria-controls', target);
      const panel = document.querySelector(`[data-target="${CSS.escape(target)}"]`);
      if (panel && !panel.id) panel.id = target;
      element.setAttribute('aria-expanded', panel && !panel.classList.contains('hidden') ? 'true' : 'false');
    });

    const overlay = document.querySelector('.search-pop-overlay');
    const dialog = document.querySelector('.search-popup');
    const input = document.querySelector('.search-input');
    if (overlay) overlay.setAttribute('aria-hidden', overlay.classList.contains('active') ? 'false' : 'true');
    if (dialog) {
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', '站内搜索');
    }
    if (input) input.setAttribute('aria-label', '搜索文章标题、标签和分类');

    syncExpandedState();
  }

  function syncExpandedState() {
    const searchOpen = Boolean(document.querySelector('.search-pop-overlay.active'));
    document.querySelectorAll('.search-popup-trigger').forEach((element) => {
      element.setAttribute('aria-expanded', searchOpen ? 'true' : 'false');
    });
    const overlay = document.querySelector('.search-pop-overlay');
    if (overlay) overlay.setAttribute('aria-hidden', searchOpen ? 'false' : 'true');

    const drawerOpen = document.body.classList.contains('navbar-drawer-show');
    document.querySelectorAll('.navbar-bar').forEach((element) => {
      element.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
      element.setAttribute('aria-label', drawerOpen ? '关闭导航菜单' : '打开导航菜单');
    });

    document.querySelectorAll('[navbar-data-toggle]').forEach((element) => {
      const target = element.getAttribute('navbar-data-toggle');
      const panel = document.querySelector(`[data-target="${CSS.escape(target)}"]`);
      element.setAttribute('aria-expanded', panel && !panel.classList.contains('hidden') ? 'true' : 'false');
    });
  }

  function handleActivation(event) {
    const control = event.target.closest('[role="button"]');
    if (!control || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    control.click();
  }

  function trapSearchFocus(event) {
    if (event.key !== 'Tab') return;
    const dialog = document.querySelector('.search-pop-overlay.active .search-popup');
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll('a[href], input, button, [tabindex="0"]')]
      .filter((element) => !element.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', (event) => {
    handleActivation(event);
    trapSearchFocus(event);
    if (event.key !== 'Escape') return;

    const close = document.querySelector('.search-pop-overlay.active .popup-btn-close');
    if (close) {
      close.click();
      lastSearchTrigger?.focus();
      return;
    }

    if (document.body.classList.contains('navbar-drawer-show')) {
      document.querySelector('.navbar-bar')?.click();
    }
  });

  document.addEventListener('click', (event) => {
    const searchTrigger = event.target.closest('.search-popup-trigger');
    if (searchTrigger) lastSearchTrigger = searchTrigger;

    const close = event.target.closest('.popup-btn-close');
    window.requestAnimationFrame(() => {
      syncExpandedState();
      if (close && lastSearchTrigger) lastSearchTrigger.focus();
    });
  }, true);

  document.addEventListener('focusin', (event) => {
    const dropdown = event.target.closest('.desktop .navbar-item');
    dropdown?.querySelector('.has-dropdown')?.setAttribute('aria-expanded', 'true');
  });

  document.addEventListener('focusout', (event) => {
    const dropdown = event.target.closest('.desktop .navbar-item');
    if (!dropdown) return;
    window.requestAnimationFrame(() => {
      if (!dropdown.contains(document.activeElement)) {
        dropdown.querySelector('.has-dropdown')?.setAttribute('aria-expanded', 'false');
      }
    });
  });

  const observer = new MutationObserver(syncExpandedState);
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ['class'],
  });

  document.addEventListener('DOMContentLoaded', enhanceControls, { once: true });
  window.addEventListener('redefine:page:refresh', enhanceControls);
})();
