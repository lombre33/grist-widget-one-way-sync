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
  const button = el('button', { class: 'btn', type: 'button' }, icon('copy'), t('common.copy'));
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(value); } catch (e) { area.select(); return; }
    button.lastChild.textContent = t('common.copied');
    setTimeout(() => { button.lastChild.textContent = t('common.copy'); }, 1500);
  });
  return el('div', { class: 'copy-field' }, area, button);
}

// Liste avec recherche (combobox). `items` : [{value, label, hint}]. Renvoie l'élément ; la
// valeur choisie est dans `.value` et un événement `change` est émis.
export function searchSelect({ items, placeholder = t('common.choose'), onChange }) {
  const input = el('input', { class: 'search-input', type: 'text', role: 'combobox', 'aria-expanded': 'false', placeholder, autocomplete: 'off' });
  const list = el('ul', { class: 'search-list hidden', role: 'listbox' });
  const root = el('div', { class: 'search-select' }, input, list);
  root.value = '';
  let active = 0;
  const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');

  const matches = () => {
    const words = fold(input.value).split(' ').filter(Boolean);
    return items.filter(it => words.every(w => fold(`${it.label} ${it.value}`).includes(w)));
  };
  const render = () => {
    const found = matches();
    active = Math.min(active, Math.max(found.length - 1, 0));
    list.replaceChildren(...(found.length ? found.map((it, i) => el('li', {
      role: 'option', class: i === active ? 'active' : '', 'aria-selected': String(it.value === root.value),
      onmousedown: (e) => { e.preventDefault(); choose(it); },
    }, el('span', {}, it.label), it.hint ? el('span', { class: 'hint' }, it.hint) : null)) : [el('li', { class: 'empty' }, t('common.none'))]));
  };
  const open = (on) => { list.classList.toggle('hidden', !on); input.setAttribute('aria-expanded', String(on)); if (on) render(); };
  const choose = (it) => {
    root.value = it.value;
    input.value = it.label;
    open(false);
    if (onChange) onChange(it.value);
  };
  input.addEventListener('focus', () => { input.select(); open(true); });
  input.addEventListener('blur', () => { open(false); const it = items.find(i => i.value === root.value); input.value = it ? it.label : ''; });
  input.addEventListener('input', () => { active = 0; open(true); });
  input.addEventListener('keydown', (e) => {
    const found = matches();
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, found.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && found[active]) { choose(found[active]); e.preventDefault(); }
    else if (e.key === 'Escape' && !list.classList.contains('hidden')) { open(false); e.stopPropagation(); e.preventDefault(); }
  });
  return root;
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
