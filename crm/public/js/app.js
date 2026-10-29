// Small progressive enhancements; every page works without this file.
document.addEventListener('DOMContentLoaded', () => {
  // Keep the conversation scrolled to the latest message.
  document.querySelectorAll('.chat').forEach(el => { el.scrollTop = el.scrollHeight; });

  // Confirm destructive or outward-facing actions.
  document.querySelectorAll('form[data-confirm]').forEach(form => {
    form.addEventListener('submit', e => { if (!window.confirm(form.dataset.confirm)) e.preventDefault(); });
  });

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
    const update = () => { out.textContent = `${box.value.length} / ${box.maxLength}`; };
    box.addEventListener('input', update); update();
  }
});
