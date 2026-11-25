// Copie unique, volet « Copier d'ici » : choisir des tables (et au besoin leurs colonnes), ce qui part avec elles, puis copier le texte.
// Le texte ne contient que la structure des tables cochées : aucune ligne de données. Voir engine/logic/copy-plan.js.
import { t, typeName } from '../i18n.js';
import { checkList, confirmDialog, copyButton, el, message, notice, smallButton } from '../ui.js';
import { exportCounts, prepareExport } from '../engine/logic/copy-plan.js';
import { userColumns } from '../engine/logic/copy-read.js';
import { elementBoxes, section, warningsBlock } from './parts.js';

// Avant de copier des formules : une fenêtre dit ce que c'est. Vrai si la personne confirme.
const confirmFormulas = () => confirmDialog({
  title: t('copy.export.formulas.title'),
  body: [el('p', {}, t('copy.export.formulas.body1')), el('p', {}, t('copy.export.formulas.body2')), el('p', {}, t('copy.export.formulas.body3'))],
  confirmLabel: t('copy.export.formulas.confirm'), kind: 'btn-primary',
});

// Le texte et son bouton « Copier » ; un navigateur qui refuse la copie laisse le texte sélectionné.
function textView(text) {
  const area = el('textarea', { class: 'code', readonly: true, rows: 12, spellcheck: 'false', 'aria-label': t('copy.export.text') });
  area.value = text;
  return el('div', {}, el('div', { class: 'copy-field' }, area, copyButton(() => text, t('copy.export.copy'), () => area.select())),
    el('p', { class: 'muted small' }, t('copy.export.size', { n: text.length })));
}

// `doc` : le document lu (readDocument) ; `exp` : ce qui est choisi, gardé d'un dessin à l'autre (`tableIds`, `excluded`, `omit`).
export function exportPanel(doc, exp) {
  const columnsOf = new Map(doc.tables.map(table => [table.tableId, userColumns(doc.allColumns, table.tableRef)]));
  if (columnsOf.size === 0) return el('div', { class: 'form' }, message('info', t('copy.export.noTables')));
  const opened = new Set();
  const columnsBox = el('div', { class: 'form' });
  const elementsBox = el('div', { class: 'form' });
  const textBox = el('div', { class: 'form' });
  const selection = () => ({ tableIds: exp.tableIds, excluded: exp.excluded, omit: exp.omit });

  // Les colonnes de chaque table cochée, pour en laisser de côté.
  const paintColumns = () => {
    columnsBox.replaceChildren(...exp.tableIds.filter(tableId => columnsOf.get(tableId).length > 1).map((tableId) => {
      const all = columnsOf.get(tableId);
      const left = exp.excluded.get(tableId) ?? new Set();
      const summary = el('summary', { class: 'small' }, t('copy.export.columns', { table: tableId, n: all.length - left.size, total: all.length }));
      const details = el('details', { class: 'guide', open: opened.has(tableId) }, summary, checkList({
        items: all.map(col => ({ value: col.colId, label: col.colId, hint: typeName(col.type) })),
        checked: all.map(col => col.colId).filter(colId => !left.has(colId)),
        label: tableId, wide: true,
        onChange: (values) => {
          exp.excluded.set(tableId, new Set(all.map(col => col.colId).filter(colId => !values.includes(colId))));
          summary.textContent = t('copy.export.columns', { table: tableId, n: values.length, total: all.length });
          paintElements();
          paintText();
        },
      }));
      details.addEventListener('toggle', () => { if (details.open) opened.add(tableId); else opened.delete(tableId); });
      return details;
    }));
  };

  // Ce qui part avec les colonnes : décoché d'emblée, la personne coche ce qu'elle veut envoyer.
  const paintElements = () => {
    if (exp.tableIds.length === 0) return elementsBox.replaceChildren();
    return elementsBox.replaceChildren(section('copy.export.elements', 'copy.export.elements.sub', elementBoxes({
      counts: exportCounts(doc, selection()), omit: exp.omit,
      onChange: async (element, box) => {
        if (element === 'formulas' && box.checked && !(await confirmFormulas())) { box.checked = false; exp.omit.add('formulas'); }
        paintText();
      },
    })));
  };

  // Les tables que des colonnes Référence visent sans qu'elles soient cochées : on le dit, et on propose de les ajouter.
  const referencedNotices = referenced => [...referenced].map(([table, columns]) => notice({
    tone: 'warn', lines: [t('copy.export.referenced', { table, columns: columns.join(', ') })],
    actions: [smallButton(t('copy.export.addTable', { table }), 'plus', () => { exp.tableIds = [...exp.tableIds, table]; paintTables(); repaint(); })],
  }));

  const paintText = () => {
    if (exp.tableIds.length === 0) return textBox.replaceChildren(el('p', { class: 'muted small' }, t('copy.export.pick')));
    const prepared = prepareExport(doc, selection());
    return textBox.replaceChildren(section('copy.export.text', 'copy.export.text.help', textView(prepared.text),
      warningsBlock(prepared.notes, 'info'), ...referencedNotices(prepared.referenced)));
  };

  // La liste des tables ; refaite quand une table est ajoutée d'un clic (elle doit s'y montrer cochée).
  const tableBox = el('div');
  const paintTables = () => tableBox.replaceChildren(checkList({
    items: [...columnsOf].map(([tableId, columns]) => ({ value: tableId, label: tableId, hint: t('copy.ui.columns', { n: columns.length }) })),
    checked: exp.tableIds, label: t('copy.export.tables'), wide: true,
    onChange: (values) => {
      exp.tableIds = values;
      for (const tableId of [...exp.excluded.keys()]) if (!values.includes(tableId)) exp.excluded.delete(tableId);
      repaint();
    },
  }));
  const repaint = () => { paintColumns(); paintElements(); paintText(); };
  paintTables();
  repaint();
  return el('div', { class: 'form' }, section('copy.export.tables', 'copy.export.tables.sub', tableBox, columnsBox), elementsBox, textBox);
}
