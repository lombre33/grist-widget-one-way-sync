// Briques d'interface communes : construction d'éléments sans innerHTML (aucun texte venu du
// document ou d'un code collé n'est interprété comme du HTML), fenêtres, confirmation, champ à
// copier, liste avec recherche.
import { t } from './i18n.js';

// el('button', {class: 'btn', onclick: fn}, 'Texte') ; les enfants texte passent par textContent.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else if (name === 'class') node.className = value;
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const icon = name => el('span', { class: `icon icon-${name}`, 'aria-hidden': 'true' });

export function message(kind, text) {
  return el('p', { class: `msg msg-${kind}`, role: kind === 'err' ? 'alert' : 'status' }, text);
}

// ---------------------------------------------------------------------------------------------
// Fenêtres : titre fixe, contenu qui défile, boutons fixes. Le focus entre à l'ouverture,
// tourne dans la fenêtre (Tab), revient à l'élément d'origine à la fermeture ; Échap ferme.

const stack = [];

export function openModal({ title, body, buttons = [], width = 480, onClose }) {
  const opener = document.activeElement;
  const titleId = `modal-title-${stack.length}`;
  const footer = el('div', { class: 'modal-footer' });
  const frame = el('div', { class: `modal modal-${width}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    el('h2', { class: 'modal-title', id: titleId }, title),
    el('div', { class: 'modal-body' }, body),
    footer);
  const scrim = el('div', { class: 'scrim' }, frame);
  const modal = {
    frame, footer,
    close(result) {
      scrim.remove();
      stack.splice(stack.indexOf(modal), 1);
      if (opener && opener.focus) opener.focus();
      if (onClose) onClose(result);
    },
    setButtons(list) {
      footer.replaceChildren(...list.map(b => el('button', {
        class: `btn ${b.kind || ''}`, type: 'button', disabled: b.disabled,
        onclick: () => (b.onClick ? b.onClick(modal) : modal.close()),
      }, b.label)));
    },
  };
  modal.setButtons(buttons.length ? buttons : [{ label: t('common.close') }]);
  stack.push(modal);
  document.body.append(scrim);
  (frame.querySelector('textarea, input, select, .btn-primary') || footer.querySelector('button')).focus();
  return modal;
}

document.addEventListener('keydown', (event) => {
  const modal = stack[stack.length - 1];
  if (!modal) return;
  if (event.key === 'Escape') { event.preventDefault(); modal.close(false); return; }
  if (event.key !== 'Tab') return;
  const focusable = [...modal.frame.querySelectorAll('button, input, textarea, select, [tabindex="0"]')].filter(n => !n.disabled);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  const inside = modal.frame.contains(document.activeElement);
  if (event.shiftKey && (document.activeElement === first || !inside)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !inside)) { event.preventDefault(); first.focus(); }
});

// Assistant : une seule fenêtre, des étapes numérotées qui se débloquent l'une après l'autre.
// `show(index, body, buttons)` affiche une étape ; les précédentes sont marquées faites.
export function openWizard({ title, steps, onClose }) {
  const bar = el('ol', { class: 'steps' });
  const content = el('div', { class: 'form' });
  const modal = openModal({ title, body: [bar, content], onClose });
  let shown = -1;
  return {
    close: () => modal.close(),
    show(index, body, buttons) {
      bar.replaceChildren(...steps.map((label, i) => el('li', {
        class: i < index ? 'done' : i === index ? 'current' : 'locked', 'aria-current': i === index ? 'step' : null,
      }, el('span', { class: 'step-num', 'aria-hidden': 'true' }, i < index ? '✓' : String(i + 1)), label)));
      content.replaceChildren(...[body].flat().filter(Boolean));
      modal.setButtons(buttons);
      if (index === shown) return; // même étape redessinée : le focus reste où il est
      shown = index;
      const first = content.querySelector('textarea:not([readonly]), input') || modal.footer.querySelector('.btn-primary');
      if (first) first.focus();
    },
  };
}

// Confirmation : promesse d'un booléen. Une action destructrice met le focus sur Annuler.
export function confirmDialog({ title, body, confirmLabel, cancelLabel = t('common.cancel'), danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal({
      title, body: el('p', {}, body), width: 400,
      onClose: () => { if (!answered) resolve(false); },
      buttons: [
        { label: cancelLabel, onClick: m => { answered = true; resolve(false); m.close(); } },
        { label: confirmLabel, kind: danger ? 'btn-danger' : 'btn-primary', onClick: m => { answered = true; resolve(true); m.close(); } },
      ],
    });
    if (danger) modal.footer.querySelector('button').focus();
  });
}

// Code en lecture seule avec bouton « Copier ».
export function copyField(value) {
  const area = el('textarea', { class: 'code', readonly: true, rows: 3, spellcheck: 'false' });
  area.value = value;
  return el('div', { class: 'copy-field' }, area, copyButton(() => value, t('common.copy'), () => area.select()));
}

// Bouton qui copie `text()` dans le presse-papiers ; `onFail` si le navigateur le refuse.
export function copyButton(text, label, onFail = () => {}) {
  const button = el('button', { class: 'btn', type: 'button' }, icon('copy'), label);
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text()); } catch (e) { onFail(); return; }
    button.lastChild.textContent = t('common.copied');
    setTimeout(() => { button.lastChild.textContent = label; }, 1500);
  });
  return button;
}

// Liste à cocher, filtrable au clavier (tables, colonnes). `checked` : valeurs cochées au départ.
// `onChange` reçoit les valeurs cochées, dans l'ordre de la liste.
export function checkList({ items, checked = [], placeholder = t('common.filter'), onChange }) {
  const filter = el('input', { class: 'search-input', type: 'search', placeholder, 'aria-label': placeholder, autocomplete: 'off' });
  const list = el('div', { class: 'check-list', role: 'group' });
  const chosen = new Set(checked);
  const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const render = () => {
    const words = fold(filter.value).split(/\s+/).filter(Boolean);
    const found = items.filter(it => words.every(w => fold(it.label).includes(w)));
    list.replaceChildren(...(found.length ? found.map(it => el('label', {},
      el('input', {
        type: 'checkbox', checked: chosen.has(it.value),
        onchange: (e) => { if (e.target.checked) chosen.add(it.value); else chosen.delete(it.value); onChange(items.map(i => i.value).filter(v => chosen.has(v))); },
      }), it.label)) : [el('p', { class: 'muted small' }, t('common.none'))]));
  };
  filter.addEventListener('input', render);
  render();
  return el('div', { class: 'check-select' }, filter, list);
}

// Choix d'une valeur dans une liste filtrable (tables, colonnes) : un bouton qui affiche le choix
// et ouvre la liste sous lui. `items` : [{ value, label }]. Échap referme la liste seule.
export function pickField({ items, value, label, onChange = () => {} }) {
  let current = value;
  const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const button = el('button', { class: 'btn pick-button', type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label });
  const filter = el('input', { class: 'search-input', type: 'search', placeholder: t('common.filter'), 'aria-label': t('common.filter'), autocomplete: 'off' });
  const list = el('div', { class: 'check-list', role: 'listbox', 'aria-label': label });
  const panel = el('div', { class: 'pick-panel hidden' }, filter, list);
  const field = el('div', { class: 'pick-field' }, button, panel);
  const shown = () => (items.find(it => it.value === current) || items[0]).label;
  const toggle = (open) => {
    panel.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
    if (open) { filter.value = ''; render(); filter.focus(); } else button.focus();
  };
  const choose = (v) => { current = v; button.textContent = shown(); toggle(false); onChange(v); };
  function render() {
    const words = fold(filter.value).split(/\s+/).filter(Boolean);
    const found = items.filter(it => words.every(w => fold(it.label).includes(w)));
    list.replaceChildren(...(found.length ? found.map(it => el('button', {
      class: 'pick-option', type: 'button', role: 'option', 'aria-selected': String(it.value === current), onclick: () => choose(it.value),
    }, it.label)) : [el('p', { class: 'muted small' }, t('common.none'))]));
  }
  button.textContent = shown();
  button.addEventListener('click', () => toggle(panel.classList.contains('hidden')));
  filter.addEventListener('input', render);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) { e.stopPropagation(); toggle(false); }
    if (e.key === 'Enter' && e.target === filter) { e.preventDefault(); const first = list.querySelector('.pick-option'); if (first) first.click(); }
  });
  field.value = () => current;
  return field;
}

// Exécute une action d'un bouton : le bouton est grisé pendant l'opération, l'erreur affichée
// dans `out` (élément qui reçoit le message).
export async function run(button, out, fn) {
  if (button) button.disabled = true;
  if (out) out.replaceChildren();
  try {
    return await fn();
  } catch (e) {
    const key = `error.${e.message}`;
    const text = t(key) === key ? e.message || String(e) : t(key);
    console.error(e);
    if (out) out.replaceChildren(message('err', text));
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}
