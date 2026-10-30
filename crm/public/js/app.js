// Small progressive enhancements; every page still works without this file.
document.documentElement.classList.add('js');

document.addEventListener('DOMContentLoaded', () => {
  // Keep the conversation scrolled to the latest message.
  document.querySelectorAll('[data-chat]').forEach(el => { el.scrollTop = el.scrollHeight; });

  // Auto-submit selects marked with data-autosubmit (pipeline status changes).
  document.querySelectorAll('select[data-autosubmit]').forEach(sel => {
    sel.addEventListener('change', () => sel.form.submit());
    const btn = sel.form.querySelector('.js-hide');
    if (btn) btn.hidden = true;
  });

  // Character counter for the WhatsApp reply box.
  const box = document.querySelector('textarea[data-count]');
  const out = document.querySelector('[data-counter]');
  if (box && out) {
    const update = () => { out.textContent = box.value.length ? `${box.value.length} / ${box.maxLength}` : ''; };
    box.addEventListener('input', update); update();
  }

  // Lead page tabs on phones: show one panel at a time (desktop shows all side by side).
  const tabs = document.querySelector('[data-tabs]');
  const isPhone = () => window.matchMedia('(max-width: 63.99rem)').matches;
  if (tabs) {
    const buttons = [...tabs.querySelectorAll('[data-tab]')];
    const panels = [...document.querySelectorAll('[data-panel]')];
    const show = (key, { scroll = true } = {}) => {
      buttons.forEach(b => {
        const on = b.dataset.tab === key;
        b.classList.toggle('tab-active', on);
        b.setAttribute('aria-selected', on);
      });
      panels.forEach(p => p.toggleAttribute('data-tab-hidden', p.dataset.panel !== key));
      // Hide a whole column when none of its panels is showing, so no empty space is left.
      document.querySelectorAll('[data-col]').forEach(c => c.toggleAttribute('data-tab-hidden', !c.querySelector('[data-panel]:not([data-tab-hidden])')));
      // Chat opens at the latest message, like WhatsApp; other tabs open at the top.
      if (scroll && isPhone()) window.scrollTo(0, key === 'chat' ? document.body.scrollHeight : 0);
    };
    buttons.forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
    document.querySelectorAll('[data-tab-link]').forEach(el => el.addEventListener('click', () => show(el.dataset.tabLink)));
    show('chat', { scroll: false });
    if (isPhone() && !location.hash) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  }

  // Message box grows with the text, like WhatsApp.
  document.querySelectorAll('textarea[data-autogrow]').forEach(t => {
    const grow = () => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; };
    t.addEventListener('input', grow);
  });

  // Bottom sheets open via #hash (works without JS); Escape closes them.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !document.querySelector('.modal:target')) return;
    location.hash = '';
    history.replaceState(null, '', location.pathname + location.search);
  });
});
