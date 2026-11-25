// Onglet « Copie » : copier la structure de tables d'un document dans un autre, une seule fois. Deux volets : « Copier d'ici » (choisir des
// tables, copier le texte) et « Coller ici » (voir ce que le texte ferait, puis créer). Le texte passe par le presse-papiers : aucun réseau,
// aucune table technique, aucun lien entre les deux documents ensuite.
import { t } from '../i18n.js';
import { el } from '../ui.js';
import { isOwner } from '../engine/port.js';
import { readCopyDocument } from '../engine/copy.js';
import { ELEMENTS } from '../engine/logic/copy-elements.js';
import { exportPanel } from './export-panel.js';
import { importPanel, newImportState } from './import-panel.js';

// Ce que la personne a choisi, gardé tant que la page du widget reste ouverte (l'onglet se redessine, ses choix restent).
// À l'export, tous les éléments sont laissés de côté d'emblée : elle coche ce qu'elle veut envoyer avec les colonnes.
const state = { mode: 'export', exp: { tableIds: [], excluded: new Map(), omit: new Set(ELEMENTS) }, imp: newImportState() };

// Le choix du sens : deux boutons, celui qui est actif est annoncé (`aria-pressed`).
function modeSwitch(paint) {
  const buttons = ['export', 'import'].map(mode => el('button', { type: 'button', 'data-copy-mode': mode, onclick: () => { state.mode = mode; paint(); } }, t(`copy.ui.mode.${mode}`)));
  const mark = () => buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.copyMode === state.mode)));
  mark();
  buttons.forEach(button => button.addEventListener('click', mark));
  return el('div', { class: 'seg', role: 'group', 'aria-label': t('copy.ui.mode') }, buttons);
}

export async function renderCopy(view) {
  const [doc, owner] = await Promise.all([readCopyDocument(), isOwner().catch(() => false)]);
  state.exp.tableIds = state.exp.tableIds.filter(tableId => doc.tables.some(table => table.tableId === tableId)); // une table effacée entre-temps
  const body = el('div', { class: 'form' });
  const paint = () => body.replaceChildren(state.mode === 'export'
    ? exportPanel(doc, state.exp)
    : importPanel({ doc, imp: state.imp, owner, onDone: () => renderCopy(view) }));
  paint();
  view.replaceChildren(
    el('div', { class: 'copy-head' }, el('h2', { class: 'home-title' }, t('copy.ui.title')), el('p', { class: 'muted small' }, t('copy.ui.intro'))),
    modeSwitch(paint), body);
}
