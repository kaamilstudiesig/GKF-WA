// Small progressive enhancements; every page still works without this file.
document.documentElement.classList.add('js');

// R4: installable app. The service worker only caches CSS/JS and an offline page (see /sw.js).
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
// Android/desktop Chrome: keep the install prompt for our own "Install app" button.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  document.querySelectorAll('[data-install]').forEach(b => { b.hidden = false; });
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  document.querySelectorAll('[data-install]').forEach(b => { b.hidden = true; });
});

document.addEventListener('DOMContentLoaded', () => {
  // "Install app" (shown once the browser offers it) and the iPhone hint (Safari has no prompt).
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  document.querySelectorAll('[data-install]').forEach(b => {
    b.hidden = standalone || !installPrompt;
    b.addEventListener('click', async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      b.hidden = true;
    });
  });
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  document.querySelectorAll('[data-ios-install]').forEach(el => { el.hidden = standalone || !isIos; });

  // Keep the conversation scrolled to the latest message.
  document.querySelectorAll('[data-chat]').forEach(el => { el.scrollTop = el.scrollHeight; });

  // Auto-submit selects marked with data-autosubmit (pipeline status changes).
  document.querySelectorAll('select[data-autosubmit]').forEach(sel => {
    sel.addEventListener('change', () => sel.form.submit());
    const btn = sel.form.querySelector('.js-hide');
    if (btn) btn.hidden = true;
  });

  // Business settings, Brand (R12): keep the colour picker and hex box in sync,
  // and turn the chosen logo file into a data URL for the hidden "logo" field.
  const brandForm = document.querySelector('[data-brand-form]');
  if (brandForm) {
    const pick = brandForm.querySelector('[data-color-pick]');
    const text = brandForm.querySelector('[data-color-text]');
    pick.addEventListener('input', () => { text.value = pick.value; });
    text.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) pick.value = text.value; });
    const file = brandForm.querySelector('[data-logo-file]');
    const data = brandForm.querySelector('[data-logo-data]');
    const hint = brandForm.querySelector('[data-logo-hint]');
    const hintText = hint.textContent;
    file.addEventListener('change', () => {
      data.value = '';
      hint.textContent = hintText;
      hint.classList.remove('text-error');
      const f = file.files[0];
      if (!f) return;
      if (f.size > 40 * 1024) {
        hint.textContent = 'That image is ' + Math.round(f.size / 1024) + ' KB. Use one under 40 KB.';
        hint.classList.add('text-error');
        file.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { data.value = reader.result; };
      reader.readAsDataURL(f);
    });
  }

  // Add many staff (R13): "+ 5 more rows" copies the last row, emptied.
  const bulkRows = document.querySelector('[data-bulk-rows]');
  const bulkMore = document.querySelector('[data-bulk-more]');
  if (bulkRows && bulkMore) {
    bulkMore.hidden = false;
    bulkMore.addEventListener('click', () => {
      for (let i = 0; i < 5; i++) {
        const row = bulkRows.lastElementChild.cloneNode(true);
        row.classList.remove('ring-1', 'ring-error');
        row.querySelectorAll('ul').forEach(el => el.remove());
        row.querySelectorAll('input').forEach(el => { el.value = ''; });
        row.querySelectorAll('select').forEach(el => {
          el.querySelectorAll('option').forEach(o => { if (o.textContent === 'Choose a role') o.remove(); });
          el.value = 'sales';
        });
        const n = bulkRows.children.length + 1;
        row.querySelectorAll('[aria-label]').forEach(el => { el.setAttribute('aria-label', el.getAttribute('aria-label').replace(/^Row \d+/,'Row ' + n)); });
        bulkRows.appendChild(row);
      }
    });
  }

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
