// Pipeline board: drag-and-drop between stages on desktop (SortableJS), details dialog
// for stages that need them, and the Move menu on phones. The page works without JS
// (Move forms post normally; detail stages link to the lead's Log outcome sheet).
document.addEventListener('DOMContentLoaded', () => {
  const board = document.querySelector('[data-kanban]');
  if (!board) return;
  const NEEDS_DETAILS = { visit_booked: 'Visit booked', joined: 'Joined', lost: 'Lost' };
  const csrf = document.querySelector('input[name="_csrf"]')?.value || '';
  const dialog = document.getElementById('stage-dialog');
  const form = dialog?.querySelector('[data-stage-form]');
  const toasts = document.querySelector('[data-toasts]');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const toast = (text, kind = 'success') => {
    const el = document.createElement('div');
    el.className = `alert alert-${kind} alert-soft text-sm shadow-lg`;
    el.textContent = text;
    toasts.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  };

  const bumpCount = (list, delta) => {
    const badge = list.closest('section')?.querySelector('[data-count]');
    if (badge) badge.textContent = String(Math.max(0, Number(badge.textContent) + delta));
    const empty = list.querySelector('.kanban-empty');
    if (empty) empty.hidden = list.querySelectorAll('.kanban-card').length > 0;
  };

  // ---- details dialog (Visit booked / Joined / Lost) ----
  let onCancel = null;
  const openDialog = (card, stage, cancel) => {
    onCancel = cancel || null;
    form.action = `/leads/${encodeURIComponent(card.dataset.wa)}/stage`;
    form.querySelector('input[name="stage"]').value = stage;
    dialog.querySelector('[data-stage-title]').textContent = `Move to ${NEEDS_DETAILS[stage]}`;
    dialog.querySelector('[data-stage-lead]').textContent = card.dataset.name;
    dialog.querySelectorAll('[data-for]').forEach(group => {
      const on = group.dataset.for === stage;
      group.hidden = !on;
      group.querySelectorAll('input, select').forEach(f => {
        f.required = on && f.name !== 'note';
        if (!on) f.value = '';
      });
    });
    dialog.showModal();
    dialog.querySelector('[data-for]:not([hidden]) input, [data-for]:not([hidden]) select')?.focus();
  };
  const closeDialog = () => {
    if (dialog.open) dialog.close();
    if (onCancel) { onCancel(); onCancel = null; }
  };
  dialog?.querySelectorAll('[data-stage-cancel]').forEach(b => b.addEventListener('click', e => { e.preventDefault(); closeDialog(); }));
  dialog?.addEventListener('cancel', e => { e.preventDefault(); closeDialog(); }); // Escape key
  form?.addEventListener('submit', () => { onCancel = null; }); // a real move: don't snap the card back

  // ---- Move sheet on phones: tap Move, pick a stage (detail stages ask for details next) ----
  const sheet = document.getElementById('move-sheet');
  const sheetForm = sheet?.querySelector('[data-move-form]');
  let sheetCard = null;
  board.addEventListener('click', e => {
    const opener = e.target.closest('[data-move-open]');
    if (!opener || !sheet) return;
    e.preventDefault(); // keep the no-JS dropdown closed
    sheetCard = opener.closest('.kanban-card');
    sheet.querySelector('[data-move-lead]').textContent = sheetCard.dataset.name;
    sheetForm.action = `/leads/${encodeURIComponent(sheetCard.dataset.wa)}/stage`;
    sheet.querySelectorAll('[data-sheet-stage]').forEach(b => { b.hidden = b.dataset.sheetStage === opener.dataset.stage; });
    sheet.showModal();
  });
  sheetForm?.addEventListener('click', e => {
    const btn = e.target.closest('[data-sheet-stage]');
    if (!btn || !NEEDS_DETAILS[btn.dataset.sheetStage]) return; // simple stages submit the form
    e.preventDefault();
    sheet.close();
    openDialog(sheetCard, btn.dataset.sheetStage);
  });

  // ---- No-JS dropdown fallback links: detail stages open the dialog instead of leaving the page ----
  board.addEventListener('click', e => {
    const link = e.target.closest('a[data-move]');
    if (!link || !NEEDS_DETAILS[link.dataset.move]) return;
    e.preventDefault();
    link.closest('details')?.removeAttribute('open');
    openDialog(link.closest('.kanban-card'), link.dataset.move);
  });

  // ---- drag-and-drop on devices with a mouse/trackpad ----
  if (!window.Sortable || !window.matchMedia('(pointer: fine)').matches) return;

  const move = async (card, stage) => {
    const body = new URLSearchParams({ _csrf: csrf, stage });
    const res = await fetch(`/leads/${encodeURIComponent(card.dataset.wa)}/stage`, {
      method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not move this lead.');
  };

  board.querySelectorAll('.kanban-list').forEach(list => {
    window.Sortable.create(list, {
      group: 'pipeline',
      draggable: '.kanban-card',
      forceFallback: true, // pointer-based drag: the card follows the cursor 1:1, same in every browser
      fallbackTolerance: 4,
      filter: '.dropdown, a',
      preventOnFilter: false,
      animation: reduceMotion ? 0 : 160,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
      ghostClass: 'kanban-ghost',
      chosenClass: 'kanban-chosen',
      dragClass: 'kanban-drag',
      onEnd: async evt => {
        if (evt.from === evt.to) return;
        const card = evt.item;
        const stage = evt.to.dataset.stage;
        const revert = () => {
          evt.from.insertBefore(card, evt.from.children[evt.oldIndex] || null);
          bumpCount(evt.to, -1); bumpCount(evt.from, +1);
        };
        bumpCount(evt.from, -1); bumpCount(evt.to, +1);
        if (NEEDS_DETAILS[stage]) return openDialog(card, stage, revert);
        try {
          await move(card, stage);
          toast(`${card.dataset.name} moved to ${evt.to.closest('section').getAttribute('aria-label')}`);
        } catch (err) {
          revert();
          toast(err.message, 'error');
        }
      }
    });
  });
});
