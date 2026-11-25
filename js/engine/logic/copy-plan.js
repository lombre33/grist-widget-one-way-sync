// Ce que la copie unique prépare avant d'écrire : le texte d'un export (tables, colonnes et éléments choisis) et le plan d'un import
// (quelle table devient quoi, quelles colonnes arrivent, ce qui est dit avant de toucher au document). Rien ici ne lit ni n'écrit un
// document : `doc` est celui de readDocument (copy-read.js), les textes sont ceux de code-view-parse.js. Voir engine/copy.js.

import { generateCode } from './code-view-write.js';
import { isReservedTableId, TEXT_MAX } from './code-view-parse.js';
import { elementCounts, sumCounts } from './copy-elements.js';
import {
  buildExportSchema, exportNotes, findReferencedTables, omitFromExport, userColumns, withoutExcluded,
} from './copy-read.js';
import { checkTableId, defaultTableId, resolveColumns, twoWayWarnings } from './copy-resolve.js';

// ---------------------------------------------------------------------------------------------
// Export

// Le schéma des tables choisies, sans les colonnes que la personne laisse de côté (`excluded` : identifiant de table vers Set de colonnes).
const exportSchema = (doc, { tableIds, excluded = new Map() }) => buildExportSchema({ ...doc, allColumns: withoutExcluded(doc, excluded) }, tableIds);

// Combien de colonnes (et de tables) portent chaque élément, pour la sélection : ce que l'onglet propose de laisser de côté.
export function exportCounts(doc, selection) {
  const schema = exportSchema(doc, selection);
  return elementCounts(schema.flatMap(table => table.columns), schema);
}

// L'export de la sélection `{ tableIds, excluded, omit }` : le texte à copier, ce qui n'a pas pu y suivre (`notes`), les tables que
// les colonnes Référence visent sans qu'elles soient choisies (`referenced`, table vers colonnes qui les visent) et le compte des éléments.
export function prepareExport(doc, selection) {
  const omit = selection.omit ?? new Set();
  const schema = exportSchema(doc, selection);
  const text = generateCode(omitFromExport(schema, omit));
  const notes = omit.has('formulas') ? [] : exportNotes(schema);
  if (text.length > TEXT_MAX) notes.push({ key: 'copy.note.textTooLong', params: { size: text.length, max: TEXT_MAX } });
  return {
    text,
    notes,
    counts: elementCounts(schema.flatMap(table => table.columns), schema),
    referenced: findReferencedTables({ ...doc, allColumns: withoutExcluded(doc, selection.excluded ?? new Map()) }, selection.tableIds),
  };
}

// ---------------------------------------------------------------------------------------------
// Import

// La table du document que `tableId` désigne (parmi celles que la copie peut toucher), ou undefined.
const tableOf = (doc, tableId) => doc.tables.find(candidate => candidate.tableId === tableId);

// Ce que la personne a choisi d'une table du texte : créer une table (d'identifiant `tableId`), ajouter ses colonnes à une table du
// document, ou la laisser de côté (une table qui existe déjà et que d'autres citent).
function targetOf(choices, table) {
  const chosen = choices.targets?.get(table.tableId);
  return { mode: chosen?.mode ?? 'create', tableId: chosen?.tableId ?? defaultTableId(table.tableId) };
}

// Ce qui ne va pas dans le but d'une table : la clé de texte du problème, ou null. `others` : les autres tables du texte avec leur but.
function problemOf(entry, doc, others) {
  if (entry.mode === 'skip') return null;
  if (entry.mode === 'add') {
    if (!tableOf(doc, entry.tableId)) return 'copy.validation.tableUnknown';
    return others.some(other => other.mode === 'add' && other.tableId === entry.tableId) ? 'copy.validation.duplicateTarget' : null;
  }
  if (isReservedTableId(entry.tableId)) return 'copy.validation.reservedId'; // un nom choisi à la main peut être celui du widget
  return checkTableId(entry.tableId, doc.tableIds, others.filter(other => other.mode === 'create').map(other => other.tableId));
}

// Les tables du texte avec leur but et leur problème éventuel.
function targetsOf(parsed, doc, choices) {
  const entries = parsed.tables.map(table => ({ table, ...targetOf(choices, table) }));
  return entries.map((entry, at) => ({ ...entry, problem: problemOf(entry, doc, entries.filter((_, other) => other !== at)) }));
}

// Les colonnes de `entry.table` que la personne n'a pas laissées de côté, résolues pour ce but. En « ajouter à une table », celles
// que la table a déjà ne sont pas touchées (`present`) et une formule peut citer les colonnes qu'elle a.
function columnsOf(entry, doc, ids, choices) {
  const left = choices.excluded?.get(entry.table.tableId) ?? new Set();
  const table = { ...entry.table, columns: entry.table.columns.filter(col => !left.has(col.id)) };
  const target = entry.mode === 'add' ? tableOf(doc, entry.tableId) : null;
  const omit = new Set(choices.omit);
  omit.delete('formulas'); // les formules ont leur case : voir `withFormulas`
  const resolved = resolveColumns(table, ids, doc.tables.map(candidate => candidate.tableId), {
    withFormulas: Boolean(choices.withFormulas),
    omit,
    existing: target ? userColumns(doc.allColumns, target.tableRef).map(col => col.colId) : [],
  });
  const taken = new Set(target ? doc.allColumns.filter(col => col.parentId === target.tableRef).map(col => col.colId.toLowerCase()) : []);
  const present = resolved.columns.filter(col => taken.has(col.id.toLowerCase()));
  return { ...resolved, columns: resolved.columns.filter(col => !present.includes(col)), present: present.map(col => col.id) };
}

// Le plan d'une table du texte.
function entryPlan(entry, doc, ids, choices) {
  const base = { sourceId: entry.table.tableId, mode: entry.mode, tableId: entry.tableId, problem: entry.problem };
  if (entry.mode === 'skip') return { ...base, description: null, columns: [], present: [], warnings: [], counts: elementCounts([]) };
  const resolved = columnsOf(entry, doc, ids, choices);
  const warnings = resolved.warnings.map(warning => ({ ...warning, table: base.sourceId }));
  if (resolved.present.length > 0) warnings.push({ key: 'copy.warn.columnsExist', params: { columns: resolved.present.join(', ') }, table: base.sourceId });
  const described = entry.mode === 'create' && !new Set(choices.omit).has('tableDescriptions');
  return {
    ...base,
    description: described ? entry.table.description || null : null,
    columns: resolved.columns,
    present: resolved.present,
    warnings,
    counts: sumCounts([resolved.counts, elementCounts([], entry.mode === 'create' ? [entry.table] : [])]),
  };
}

// Le plan d'un import : `parsed` est le texte lu (parseCodeView), `doc` le document (readDocument), `choices` ce que la personne a décidé
// (`targets` : identifiant de table du texte vers `{ mode: 'create' | 'add' | 'skip', tableId }`, créer par défaut ; `excluded`
// : identifiant de table du texte vers Set de colonnes laissées de côté ; `omit` : éléments laissés de côté ; `withFormulas`).
// Rend les tables (`tables`, chacune avec ses colonnes résolues et son problème), ce qui est dit (`warnings`, `{ key, params, table? }`),
// le compte des éléments, et `ready` : de quoi écrire, sans aucun problème.
export function planImport(parsed, doc, choices = {}) {
  const entries = targetsOf(parsed, doc, choices);
  const ids = new Map(entries.filter(entry => entry.mode !== 'skip').map(entry => [entry.table.tableId, entry.tableId]));
  const tables = entries.map(entry => entryPlan(entry, doc, ids, choices));
  const live = tables.filter(table => table.mode !== 'skip');
  const warnings = [
    ...parsed.warnings,
    ...tables.flatMap(table => table.warnings),
    ...twoWayWarnings(live.map(table => ({ id: table.tableId, columns: table.columns }))),
  ];
  const work = live.reduce((total, table) => total + (table.mode === 'create' ? 1 : table.columns.length), 0);
  return {
    tables,
    warnings,
    counts: sumCounts(tables.map(table => table.counts)),
    work,
    ready: work > 0 && tables.every(table => !table.problem),
  };
}
