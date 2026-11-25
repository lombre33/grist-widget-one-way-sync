// Ce que la copie unique lit du document : ses tables et colonnes (les tables internes `_grist_Tables`, `_grist_Tables_column`,
// `_grist_Views_section`, lisibles comme les autres par un widget en accès complet) et la langue et la monnaie du document. La
// lecture est faite par le moteur sur des lignes déjà lues (`fetchRows` du port) : rien ici ne touche au document.

import { COPY_LABEL_MAX, COPY_NOTE_MAX, copyOptions, isReservedColumnId, splitType } from './code-view-types.js';
import { isReservedTableId } from './code-view-parse.js';
import { cleanNote, TABLE_NOTE_MAX } from './descriptions.js';
import { cleanFormula } from './column-formulas.js';
import { currencyOf, docFormatOf } from './docformat.js';
import { omitElements, omitTable } from './copy-elements.js';
import { parseJson } from './common.js';

export const COPY_FORMULA_MAX = 5000; // caractères d'une formule copiée à la main (le lot d'un envoi la borne à 1 500)
const NUMBERS = new Set(['Numeric', 'Int']);

// Ce que la personne voit d'une table : ni celles de Grist, ni les résumés (qu'on ne peut pas recréer), ni celles de ce widget.
const isCopiable = table => !table.tableId.startsWith('_grist_') && !table.summarySourceTable && !table.tableId.startsWith('GristHidden') && !isReservedTableId(table.tableId);
const isHidden = colId => isReservedColumnId(colId) || colId.startsWith('#');

// Les colonnes d'une table telles que la personne les voit, dans l'ordre de la Code View : les colonnes de données, puis les formules, chacune par sa position.
export function userColumns(allColumns, tableRef) {
  return allColumns
    .filter(col => col.parentId === tableRef && !isHidden(col.colId))
    .sort((first, second) => Number(first.isFormula) - Number(second.isFormula) || first.parentPos - second.parentPos);
}

// Le document tel que la copie le lit, d'après les lignes de `_grist_Tables` (`tables`), `_grist_Tables_column` (`columns`),
// `_grist_Views_section` (`sections`) et `_grist_DocInfo` (`info`) : les tables copiables (avec la description de leur section de
// données brutes, celle où Grist la range), toutes les colonnes, l'identifiant de toutes les tables (résumés compris) et la
// langue et la monnaie du document.
export function readDocument({ tables, columns, sections = [], info = [] }) {
  const descriptions = new Map(sections.map(section => [section.id, section.description]));
  const copiable = tables.filter(isCopiable).map(table => ({
    tableRef: table.id,
    tableId: table.tableId,
    rawViewSectionRef: table.rawViewSectionRef,
    description: cleanNote(descriptions.get(table.rawViewSectionRef), TABLE_NOTE_MAX) || null,
  })).sort((first, second) => first.tableId.localeCompare(second.tableId));
  return { tables: copiable, allColumns: columns, tableIds: tables.map(table => table.tableId), format: docFormatOf(info) };
}

// Les identifiants des tables copiables, avec ceux de leurs colonnes visibles : ce que l'onglet d'export liste, et dont la personne peut retirer des colonnes.
export const tablesWithColumns = ({ tables, allColumns }) =>
  tables.map(table => ({ tableId: table.tableId, columns: userColumns(allColumns, table.tableRef).map(col => col.colId) }));

// Les colonnes du document sans celles que la personne a laissées hors de l'export (`excluded` : identifiant de table vers Set de
// colonnes). L'export lit ceci plutôt que toutes les colonnes : rien de ce qu'il compte ou écrit ne cite une colonne laissée de côté.
// Une colonne qu'elle affichait, ou dont elle était l'autre bout d'un lien, ne se retrouve plus par son numéro de ligne : ces liens partent avec elle.
export function withoutExcluded({ tables, allColumns }, excluded) {
  const tableIdOf = new Map(tables.map(table => [table.tableRef, table.tableId]));
  return allColumns.filter(col => !excluded.get(tableIdOf.get(col.parentId))?.has(col.colId));
}

// Les options d'une colonne `type` en objet, contrôlées, avec la monnaie du document quand une colonne « Devise » n'en dit pas :
// elle vaut celle du document (ou de sa langue), qu'un autre document n'a pas forcément (le piège du dollar, voir docformat.js).
function exportedOptions(type, widgetOptions, format) {
  const raw = widgetOptions ? parseJson(widgetOptions, null) : null;
  const options = copyOptions(type, raw);
  const base = splitType(type).name;
  if (!NUMBERS.has(base) || !options || options.numMode !== 'currency' || options.currency) return options;
  const currency = currencyOf(format);
  return currency ? { ...options, currency } : options;
}

// Une formule de déclenchement qui ne joue que « sur les nouvelles lignes » : la seule qu'une copie sait refaire (celle qui se
// recalcule quand une colonne change, ou à toute modification, n'a pas d'équivalent dans le texte).
const isPlainTrigger = col => !col.recalcWhen && !(Array.isArray(col.recalcDeps) && col.recalcDeps.length > 1);

// La formule d'une colonne pour le texte, et ce qui n'a pas pu l'y suivre : `formula` (vide s'il n'y en a pas), `lost` ('' ou
// 'trigger' : une formule de déclenchement d'une autre sorte, 'long' : une formule trop longue pour être copiée).
function formulaOfColumn(col) {
  const text = typeof col.formula === 'string' ? col.formula : '';
  if (!text.trim()) return { formula: '', lost: '' };
  if (!col.isFormula && !isPlainTrigger(col)) return { formula: '', lost: 'trigger' };
  const formula = cleanFormula(text, COPY_FORMULA_MAX);
  return formula ? { formula, lost: '' } : { formula: '', lost: 'long' };
}

// Ce que l'onglet d'export écrit pour les tables données (`tableIds`, dans cet ordre), chacune avec sa description. `visibleColId` et
// `reverseColId` sont les identifiants de la colonne qu'une Référence affiche et de son autre bout : les numéros de ligne que Grist
// garde (`visibleCol`, `reverseCol`) ne veulent rien dire dans un autre document.
export function buildExportSchema({ tables, allColumns, format = null }, tableIds) {
  const byRef = new Map(allColumns.map(col => [col.id, col]));
  return tableIds
    .map(tableId => tables.find(table => table.tableId === tableId))
    .filter(Boolean)
    .map(table => ({
      tableId: table.tableId,
      description: table.description ?? null,
      columns: userColumns(allColumns, table.tableRef).map(col => ({
        colId: col.colId,
        type: col.type,
        isFormula: Boolean(col.isFormula),
        ...formulaOfColumn(col),
        label: cleanNote(col.label, COPY_LABEL_MAX) || null,
        description: cleanNote(col.description, COPY_NOTE_MAX) || null,
        widgetOptions: exportedOptions(col.type, col.widgetOptions, format),
        visibleColId: byRef.get(col.visibleCol)?.colId ?? null,
        reverseColId: byRef.get(col.reverseCol)?.colId ?? null,
      })),
    }));
}

// Le schéma d'export sans les éléments `omitted` (un Set) : sans les formules, une colonne de formule (vide ou non) s'écrit en données
// et une formule de déclenchement tombe.
export function omitFromExport(schema, omitted) {
  return schema.map(table => ({
    ...omitTable(table, omitted),
    columns: table.columns.map((col) => {
      const kept = omitElements(col, omitted);
      return omitted.has('formulas') && (col.isFormula || col.formula?.trim()) ? { ...kept, isFormula: false, formula: '' } : kept;
    }),
  }));
}

// Ce que l'export dit à la personne de ce qui n'a pas pu partir dans le texte : { key, params } de textes `copy.note.*`.
export function exportNotes(schema) {
  const lost = kind => schema.flatMap(table => table.columns.filter(col => col.lost === kind).map(col => `${table.tableId}.${col.colId}`));
  return [['trigger', 'copy.note.triggerLost'], ['long', 'copy.note.formulaTooLong']]
    .map(([kind, key]) => ({ key, columns: lost(kind) }))
    .filter(({ columns }) => columns.length > 0)
    .map(({ key, columns }) => ({ key, params: { columns: columns.join(', ') } }));
}

// Les autres tables copiables que visent les colonnes Référence des tables données, avec le `table.colonne` de celles qui les visent,
// par ordre alphabétique. Les tables déjà données n'y sont pas.
export function findReferencedTables({ tables, allColumns }, tableIds) {
  const copiable = new Map(tables.map(table => [table.tableId, table]));
  const referencedBy = new Map();
  for (const tableId of tableIds) {
    for (const col of userColumns(allColumns, copiable.get(tableId)?.tableRef)) {
      const { name, arg } = splitType(col.type);
      if ((name === 'Ref' || name === 'RefList') && copiable.has(arg) && !tableIds.includes(arg)) {
        referencedBy.set(arg, [...(referencedBy.get(arg) ?? []), `${tableId}.${col.colId}`]);
      }
    }
  }
  return new Map([...referencedBy].sort(([first], [second]) => first.localeCompare(second)));
}
