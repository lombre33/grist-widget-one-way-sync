// Copie unique, volet « Coller ici » : la carte d'une table du texte. La personne choisit ce qu'on en fait (créer une table, ajouter ses
// colonnes à une table de ce document, la laisser de côté), son nom ou sa destination, et les colonnes qu'elle ne veut pas.
import { t } from '../i18n.js';
import { checkList, el, withHelp } from '../ui.js';
import { defaultTableId } from '../engine/logic/copy-resolve.js';
import { warningsBlock } from './parts.js';

const MODES = ['create', 'add', 'skip'];

// Ce que la personne a décidé d'une table du texte (créer sous le nom que Grist garderait, tant qu'elle n'a rien dit).
export const targetOf = (imp, table) => imp.targets.get(table.tableId) ?? { mode: 'create', tableId: defaultTableId(table.tableId) };
const setTarget = (imp, table, change) => imp.targets.set(table.tableId, { ...targetOf(imp, table), ...change });

// La table de ce document qui porte le même nom (la casse ne compte pas), sinon la première.
const suggestedDestination = (doc, table) => (doc.tables.find(other => other.tableId.toLowerCase() === table.tableId.toLowerCase()) ?? doc.tables[0])?.tableId ?? '';

function modeSelect(doc, imp, table, onMode) {
  const current = targetOf(imp, table).mode;
  return el('select', { class: 'input mode-select', 'aria-label': t('copy.import.mode.label', { table: table.tableId }), onchange: event => onMode(event.target.value) },
    MODES.map(mode => el('option', { value: mode, selected: mode === current, disabled: mode === 'add' && doc.tables.length === 0 }, t(`copy.import.mode.${mode}`))));
}

// Le nom de la table à créer : chaque frappe met le plan à jour (`replan` ne redessine que les remarques, jamais ce champ).
const idField = (imp, table, replan) => withHelp(el('label', {}, t('copy.import.id'), el('input', {
  class: 'input', type: 'text', value: targetOf(imp, table).tableId, autocomplete: 'off', spellcheck: 'false',
  oninput: (event) => { setTarget(imp, table, { tableId: event.target.value.trim() }); replan(); },
})), t('copy.import.id.help'), t('copy.import.id'));

// La table de ce document qui reçoit les colonnes.
const destField = (doc, imp, table, replan) => el('label', {}, t('copy.import.dest'), el('select', {
  class: 'input', onchange: (event) => { setTarget(imp, table, { tableId: event.target.value }); replan(); },
}, doc.tables.map(other => el('option', { value: other.tableId, selected: other.tableId === targetOf(imp, table).tableId }, other.tableId))));

// Les colonnes du texte, à décocher une à une ; ce qui est décoché n'arrive pas (`imp.excluded`).
function columnsList(imp, table, onChange) {
  const left = imp.excluded.get(table.tableId) ?? new Set();
  const all = table.columns.map(col => col.id);
  const title = n => t('copy.import.columns', { n, total: all.length });
  const summary = el('summary', { class: 'small' }, title(all.length - left.size));
  return el('details', { class: 'guide' }, summary, checkList({
    items: table.columns.map(col => ({ value: col.id, label: col.id, hint: col.dslType })),
    checked: all.filter(id => !left.has(id)), label: table.tableId, wide: true,
    onChange: (values) => {
      imp.excluded.set(table.tableId, new Set(all.filter(id => !values.includes(id))));
      summary.textContent = title(values.length);
      onChange();
    },
  }));
}

// Le problème d'une table (en rouge) et ses remarques, redessinés à chaque changement du plan sans toucher aux champs.
export function paintCardStatus(node, planTable, warnings) {
  node.replaceChildren(
    planTable.problem ? el('p', { class: 'msg msg-err small' }, t(planTable.problem)) : null,
    warningsBlock(warnings));
}

// La carte d'une table du texte `table` (`{ tableId, columns: [{ id, dslType }] }`). `replan` : le plan change (remarques), `columnsChanged` :
// des colonnes sont décochées, `rebuild(identifiant de la table)` : le but a changé, tout se refait. Rend `{ node, status }` : `status` reçoit les remarques.
export function tableCard({ table, doc, imp, replan, columnsChanged, rebuild }) {
  const mode = targetOf(imp, table).mode;
  const onMode = (value) => {
    setTarget(imp, table, { mode: value, tableId: value === 'create' ? defaultTableId(table.tableId) : suggestedDestination(doc, table) });
    rebuild(table.tableId);
  };
  const fields = {
    create: () => [idField(imp, table, replan)],
    add: () => [destField(doc, imp, table, replan), el('p', { class: 'muted small' }, t('copy.import.add.help'))],
    skip: () => [el('p', { class: 'muted small' }, t('copy.import.skip.help'))],
  }[mode]();
  const status = el('div', { 'aria-live': 'polite' });
  const node = el('div', { class: 'card copy-card', 'data-copy-table': table.tableId },
    el('div', { class: 'card-head' }, el('strong', {}, t('copy.import.table', { table: table.tableId, n: table.columns.length })), modeSelect(doc, imp, table, onMode)),
    fields, mode !== 'skip' && table.columns.length > 1 ? columnsList(imp, table, columnsChanged) : null, status);
  return { node, status };
}
