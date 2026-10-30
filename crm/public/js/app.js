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

  // Lead page tabs on phones: show one panel at a time (desktop shows all).
  const tabs = document.querySelector('[data-tabs]');
  if (tabs) {
    const buttons = [...tabs.querySelectorAll('[data-tab]')];
    const panels = [...document.querySelectorAll('[data-panel]')];
    const show = key => {
      buttons.forEach(b => {
        const on = b.dataset.tab === key;
        b.classList.toggle('tab-active', on);
        b.setAttribute('aria-selected', on);
      });
      panels.forEach(p => p.toggleAttribute('data-tab-hidden', p.dataset.panel !== key));
      try { sessionStorage.setItem('leadTab', key); } catch (e) { /* private mode */ }
    };
    buttons.forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
    let start = 'chat';
    try { start = sessionStorage.getItem('leadTab') || 'chat'; } catch (e) { /* ignore */ }
    show(buttons.some(b => b.dataset.tab === start) ? start : 'chat');
  }

  // Bottom sheets open via #hash (works without JS); Escape closes them.
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !document.querySelector('.modal:target')) return;
    location.hash = '';
    history.replaceState(null, '', location.pathname + location.search);
  });
});
