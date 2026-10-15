// Tables techniques du widget, une par table synchronisée, rangées sous la page du widget :
//  - SOURCE : Synchro_<table>, une ligne dont la formule liste les clés existantes (envoyée à
//    chaque ajout ou suppression : c'est ainsi que les vraies suppressions arrivent dans la CIBLE) ;
//  - CIBLE : Journal_<table>, où le webhook dépose les versions.
// Les invitations en attente (et l'empreinte de leur secret éventuel) sont notées dans la
// description de la colonne Synchro_Ids de ces tables : des métadonnées, que le webhook n'envoie
// pas et que la clé du formulaire ne peut pas écrire.
import {
  APPLIED_COL, AUTHOR_COL, DATA_COL, DELETE_COL, GROUP_COL, JOURNAL_PREFIX, KEY_COL, LIST_COL, ORDER_COL, RECEIVED_COL, SCHEMA_COL,
  STATE_COL, exportColumnsActions, exportFormula, exportSchema, exportTableId, listFormula, listTableId,
} from './core.js';
import { apply, fetchRows, hideColumn, readSchema, tuckUnderWidgetPage } from './grist.js';

export { JOURNAL_PREFIX };

// SOURCE : tables prêtes à l'envoi (elles ont leur table liste).
export const sentTables = schema => schema.tableIds.filter(id => schema.has(listTableId(id)));

// CIBLE : couples (Journal_<D>, D) existants.
export const receivedTables = schema => schema.tableIds
  .filter(id => id.startsWith(JOURNAL_PREFIX) && schema.has(id.slice(JOURNAL_PREFIX.length)))
  .map(journal => ({ journal, dest: journal.slice(JOURNAL_PREFIX.length) }));

export async function createListTable(tableId) {
  const id = listTableId(tableId);
  if ((await readSchema()).has(id)) return;
  await apply([
    ['AddTable', id, [
      { id: LIST_COL, type: 'Text', isFormula: true, formula: listFormula(tableId) },
      // E-mail de la personne qui prépare la table : présenté à la CIBLE comme propriétaire.
      { id: AUTHOR_COL, type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 },
      // Colonnes de la vue d'export, écrites par le widget : la CIBLE crée celles qui manquent.
      { id: SCHEMA_COL, type: 'Text', isFormula: false }]],
    ['AddRecord', id, null, {}],
  ]);
  await tuckUnderWidgetPage([id]);
}

// Vue d'export de `tableId` (créée si besoin, rangée sous la page du widget) avec ces colonnes
// (`exportableColumns`). La description part d'abord, par la table liste, puis la formule : la
// file des webhooks étant dans l'ordre, la CIBLE connaît les colonnes avant de les recevoir.
export async function setExport(tableId, columns) {
  const id = exportTableId(tableId);
  const schema = await readSchema();
  if (!schema.has(id)) {
    const key = schema.columns(tableId).find(c => c.colId === KEY_COL);
    const created = (await apply([['CreateViewSection', schema.table(tableId).id, 0, 'record', [key.id], null]])).retValues[0];
    await apply(exportColumnsActions(id));
    await tuckUnderWidgetPage([], [created.viewRef]);
  }
  const list = listTableId(tableId);
  const ids = (await fetchRows(list)).map(r => r.id);
  await apply([['BulkUpdateRecord', list, ids, { [SCHEMA_COL]: ids.map(() => JSON.stringify(exportSchema(columns))) }]]);
  await apply([['ModifyColumn', id, DATA_COL, { formula: exportFormula(columns) }]]);
}

// Colonnes actuelles de la vue d'export, lues dans la table liste ; [] si elle n'existe pas.
export async function readExport(tableId) {
  const list = listTableId(tableId);
  if (!(await readSchema()).has(list)) return [];
  try { return JSON.parse(((await fetchRows(list))[0] || {})[SCHEMA_COL] || '[]') || []; } catch (e) { return []; }
}

// Colonnes que la destination reçoit : les colonnes de données (un code d'avant la vue d'export
// y mêlait les colonnes de la synchro).
export const destColumns = columns => columns.filter(c => ![KEY_COL, ORDER_COL, DELETE_COL].includes(c.id));

// Colonnes techniques du journal, en plus des colonnes envoyées : liste des clés, marque et effet
// des versions recopiées, auteur et date d'arrivée de chaque ligne (formules du serveur Grist).
const JOURNAL_COLUMNS = [
  { id: KEY_COL, type: 'Text', isFormula: false },
  { id: ORDER_COL, type: 'DateTime:UTC', isFormula: false },
  { id: DELETE_COL, type: 'Bool', isFormula: false },
  { id: GROUP_COL, type: 'Any', isFormula: false },
  { id: DATA_COL, type: 'Text', isFormula: false },
  { id: LIST_COL, type: 'Text', isFormula: false },
  { id: SCHEMA_COL, type: 'Text', isFormula: false },
  { id: APPLIED_COL, type: 'Bool', isFormula: false },
  { id: STATE_COL, type: 'Text', isFormula: false },
  { id: AUTHOR_COL, type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 },
  { id: RECEIVED_COL, type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 0 },
];

// Un journal créé par une version précédente du widget reçoit les colonnes techniques qui lui
// manquent. Renvoie vrai si le schéma a changé.
export async function upgradeJournal(schema, journal) {
  const have = new Set(schema.columns(journal).map(c => c.colId));
  const missing = JOURNAL_COLUMNS.filter(c => !have.has(c.id));
  await apply(missing.map(({ id, ...info }) => ['AddColumn', journal, id, info]));
  return missing.length > 0;
}

// CIBLE : colonnes envoyées qui manquent à la destination, sous le nom choisi dans `map`
// (colonne envoyée -> colonne de la destination). La clé `id_sync` en fait partie.
export function addDestColumnsActions(schema, dest, columns, map = {}) {
  const have = new Set((schema.columns(dest) || []).map(c => c.colId));
  return [...destColumns(columns), { id: KEY_COL, type: 'Text', label: KEY_COL }]
    .map(({ id, type, label }) => ({ id: map[id] || id, type, label: map[id] ? map[id] : label }))
    .filter(c => !have.has(c.id))
    .map(({ id, ...info }) => ['AddColumn', dest, id, { ...info, isFormula: false }]);
}

// CIBLE : le journal reçoit la vue d'export de la SOURCE (clé, date, suppression, bloc JSON) et
// ses colonnes techniques. La destination est créée, ou complétée des colonnes qui lui manquent ;
// sa clé `id_sync` est masquée de sa page.
export async function createReceivingTables({ journal, dest, columns, note, map = {} }) {
  const schema = await readSchema();
  await apply([
    ['AddTable', journal, JOURNAL_COLUMNS],
    ...(schema.has(dest) ? [] : [['AddTable', dest, []]]),
  ]);
  await apply(addDestColumnsActions(await readSchema(), dest, columns, map));
  await writeNote(await readSchema(), journal, note);
  await hideColumn(dest, KEY_COL);
  await tuckUnderWidgetPage([journal]);
}

// Note JSON dans la description de la colonne Synchro_Ids d'une table technique.
const listColumn = (schema, tableId) => (schema.columns(tableId) || []).find(c => c.colId === LIST_COL);

export function readNote(schema, tableId) {
  const column = listColumn(schema, tableId);
  try { return JSON.parse((column && column.description) || 'null'); } catch (e) { return null; }
}

export async function writeNote(schema, tableId, value) {
  await apply([['UpdateRecord', '_grist_Tables_column', listColumn(schema, tableId).id, { description: value == null ? '' : JSON.stringify(value) }]]);
}

// Efface des tables techniques et les pages qu'elles laissent vides (celle d'une vue d'export
// n'est pas la page principale de sa table).
export async function removeTechnicalTables(tableIds) {
  const schema = await readSchema();
  const ids = tableIds.filter(id => schema.has(id));
  const refs = new Set(ids.map(id => schema.table(id).id));
  const views = new Set((await fetchRows('_grist_Views_section')).filter(s => refs.has(s.tableRef)).map(s => s.parentId));
  await apply(ids.map(id => ['RemoveTable', id]));
  const [sections, existing] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Views')]);
  const left = new Set(sections.map(s => s.parentId));
  const still = new Set(existing.map(v => v.id));
  await apply([...views].filter(v => still.has(v) && !left.has(v)).map(v => ['RemoveView', v]));
}

// SOURCE : tables techniques d'une table qui n'est plus envoyée (liste et vue d'export).
export const removeSyncTables = tables => removeTechnicalTables(tables.flatMap(tb => [exportTableId(tb), listTableId(tb)]));
