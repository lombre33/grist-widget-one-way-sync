// Tables techniques du widget, une par table synchronisée, rangées sous la page du widget :
//  - SOURCE : Synchro_<table>, une ligne dont la formule liste les clés existantes (envoyée à
//    chaque ajout ou suppression : c'est ainsi que les vraies suppressions arrivent dans la CIBLE) ;
//  - CIBLE : Journal_<table>, où le webhook dépose les versions.
// Les invitations en attente (et l'empreinte de leur secret éventuel) sont notées dans la
// description de la colonne Synchro_Ids de ces tables : des métadonnées, que le webhook n'envoie
// pas et que la clé du formulaire ne peut pas écrire.
import { APPLIED_COL, DELETE_COL, KEY_COL, LIST_COL, ORDER_COL, listFormula, listTableId } from './core.js';
import { apply, hideColumn, readSchema, tuckUnderWidgetPage } from './grist.js';

export const JOURNAL_PREFIX = 'Journal_';

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
    ['AddTable', id, [{ id: LIST_COL, type: 'Text', isFormula: true, formula: listFormula(tableId) }]],
    ['AddRecord', id, null, {}],
  ]);
  await tuckUnderWidgetPage([id]);
}

// CIBLE : le journal reçoit les colonnes envoyées, la liste des clés, la marque des versions
// recopiées et l'auteur de chaque ligne ; la destination, les seules colonnes de données et la
// clé `id_sync`, masquée de sa page.
export async function createReceivingTables({ journal, dest, columns, note }) {
  await apply([
    ['AddTable', journal, [...columns,
      { id: LIST_COL, type: 'Text', isFormula: false },
      { id: APPLIED_COL, type: 'Bool', isFormula: false },
      { id: 'Sync_Par', type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 }]],
    ['AddTable', dest, columns.filter(c => c.id !== ORDER_COL && c.id !== DELETE_COL)],
  ]);
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
