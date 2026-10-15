// Tables techniques du widget :
//  - SOURCE : une seule table, Synchro, quel que soit le nombre d'exports et de tables. Chaque
//    table d'un export y a sa liste des clés et son lot de lignes modifiées (voir core.js). Les
//    exports (nom, lien public), les invitations en attente (et l'empreinte de leur secret) et
//    les pauses sont notés dans la description de sa colonne Synchro_Export : des métadonnées,
//    que le webhook n'envoie pas.
//  - CIBLE : un journal par export reçu, Journal_<export>, où le webhook dépose les listes et les
//    lots. Ce que la CIBLE a choisi (destinations, colonnes) est noté dans la description de sa
//    colonne Synchro_Ids, que la clé du formulaire ne peut pas écrire.
// Aucune n'a de page : elles restent dans « Données source ».
import {
  APPLIED_COL, AUTHOR_COL, DATA_COL, DELETE_COL, EXPORT_COL, JOURNAL_PREFIX, KEY_COL, LIST_COL, LOT_COL, MISSING_COL, ORDER_COL, RECEIVED_COL,
  STATE_COL, SYNC_TABLE, TABLE_COL, exportRowsActions, exportTables, majleAction, syncColumns, syncFormulas,
} from './core.js';
import { apply, dropPages, exportsViewRef, fetchRows, hideColumn, readSchema, tidyPages } from './grist.js';

// Tables de la personne, que l'on peut envoyer ou choisir comme destination : pas celles du widget.
export const isUserTable = id => id !== SYNC_TABLE && !id.startsWith('Synchro_') && !id.startsWith(JOURNAL_PREFIX);

// ---------------------------------------------------------------------------------------------
// SOURCE

// Lignes de Synchro ([] sans la table). `schema` : instantané déjà lu, s'il y en a un.
export const syncRows = async (schema = null) => ((schema || await readSchema()).has(SYNC_TABLE) ? fetchRows(SYNC_TABLE) : []);

// Note de la table Synchro : { exports: [{ id, name, at, public }], invitations: [{ id, export,
// hash, at }], pauses: [{ hook, export, at, columns }] }.
const exportColumn = schema => (schema.columns(SYNC_TABLE) || []).find(c => c.colId === EXPORT_COL);

export function readSourceNote(schema) {
  let note = null;
  try { note = JSON.parse((exportColumn(schema) || {}).description || 'null'); } catch (e) { /* note illisible */ }
  return { exports: [], invitations: [], pauses: [], ...(note && typeof note === 'object' ? note : {}) };
}

export async function writeSourceNote(note) {
  const column = exportColumn(await readSchema());
  if (column) await apply([['UpdateRecord', '_grist_Tables_column', column.id, { description: JSON.stringify(note) }]]);
}

// Les formules de Synchro nomment les tables qu'elles lisent : réécrites quand l'ensemble change.
// Une table renommée ou effacée dans la SOURCE n'y figure plus (la carte de l'export le signale) :
// son nom inconnu mettrait en erreur les lignes de tous les exports.
async function refreshFormulas(schema, rows) {
  const { keys, lot } = syncFormulas(rows.map(r => r[TABLE_COL]).filter(table => schema.has(table)));
  const cols = schema.columns(SYNC_TABLE);
  const actions = [[LIST_COL, keys], [LOT_COL, lot]]
    .filter(([colId, formula]) => (cols.find(c => c.colId === colId) || {}).formula !== formula)
    .map(([colId, formula]) => ['ModifyColumn', SYNC_TABLE, colId, { formula }]);
  await apply(actions);
  return actions.length > 0;
}

// Table Synchro à jour : une colonne ajoutée par une version suivante du widget est créée, la
// marque d'envoi coupé surveille le lot (dépendance posée après coup : Grist la refuse à la
// création), et les formules sont celles de cette version, pour les tables de `rows` (lignes de
// Synchro, ou à venir). Rend vrai si quelque chose a changé.
export async function ensureSyncTable(rows = null) {
  let schema = await readSchema();
  if (!schema.has(SYNC_TABLE)) return false;
  const have = new Set(schema.columns(SYNC_TABLE).map(c => c.colId));
  const missing = syncColumns([]).filter(c => !have.has(c.id));
  if (missing.length) {
    await apply(missing.map(({ id, ...info }) => ['AddColumn', SYNC_TABLE, id, info]));
    schema = await readSchema();
  }
  const cols = schema.columns(SYNC_TABLE);
  const lot = cols.find(c => c.colId === LOT_COL);
  const watch = cols.find(c => c.colId === MISSING_COL);
  const deps = ['L', lot.id];
  const depsChanged = JSON.stringify(watch.recalcDeps || null) !== JSON.stringify(deps);
  if (depsChanged) await apply([['UpdateRecord', '_grist_Tables_column', watch.id, { recalcWhen: 0, recalcDeps: deps }]]);
  const formulasChanged = await refreshFormulas(schema, rows || await syncRows(schema));
  return missing.length > 0 || depsChanged || formulasChanged;
}

// MajLe de chaque table envoyée suit les colonnes que ses exports envoient (voir majleAction).
// Rend vrai si quelque chose a changé.
export async function refreshMajLe() {
  const schema = await readSchema();
  const rows = await syncRows(schema);
  const sent = new Map(); // table -> colonnes envoyées par l'un de ses exports
  for (const id of new Set(rows.map(r => r[EXPORT_COL]))) {
    for (const { table, columns } of exportTables(rows, id)) sent.set(table, new Set([...(sent.get(table) || []), ...columns.map(c => c.id)]));
  }
  const actions = [...sent].filter(([table]) => schema.has(table)).map(([table, ids]) => majleAction(schema.columns(table), [...ids])).filter(Boolean);
  await apply(actions);
  return actions.length > 0;
}

// Enregistre les tables et colonnes d'un export (`tables` : [{ table, columns }]). Crée la table
// Synchro au premier export. Rend les tables dont les lignes sont à envoyer (nouvelles ou aux
// colonnes changées).
export async function saveExport(exportId, tables, { isPublic = false } = {}) {
  if (!(await readSchema()).has(SYNC_TABLE)) {
    await apply([['AddTable', SYNC_TABLE, syncColumns(tables.map(tb => tb.table))]]);
    await dropPages([SYNC_TABLE]);
  }
  const before = await fetchRows(SYNC_TABLE);
  const { actions, changed } = exportRowsActions(before, exportId, tables, { isPublic });
  // Les formules d'abord quand une table s'ajoute (elles doivent pouvoir la lire), après quand une
  // table s'en va (elles ne la lisent plus quand ses lignes disparaissent).
  const all = [...before.filter(r => r[EXPORT_COL] !== exportId), ...tables.map(tb => ({ [TABLE_COL]: tb.table }))];
  await ensureSyncTable([...before, ...all]);
  await apply(actions);
  await refreshFormulas(await readSchema(), all);
  await refreshMajLe();
  return changed;
}

// Efface les lignes d'un export ; la table Synchro disparaît avec le dernier export.
export async function removeExport(exportId) {
  const rows = await syncRows();
  const left = rows.filter(r => r[EXPORT_COL] !== exportId);
  if (!left.length) {
    await removeTechnicalTables([SYNC_TABLE]);
    return;
  }
  await apply([['BulkRemoveRecord', SYNC_TABLE, rows.filter(r => r[EXPORT_COL] === exportId).map(r => r.id)]]);
  await refreshFormulas(await readSchema(), left);
}

// Écrit les mêmes champs dans des lignes de Synchro (renvoi, marque d'envoi coupé).
export const writeSync = (ids, fields) => apply(ids.length
  ? [['BulkUpdateRecord', SYNC_TABLE, ids, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, ids.map(() => v)]))]] : []);

// Montage d'avant la version 0.4 : une vue d'export et une table liste par table envoyée, et la
// page Synchro_Exports. Ces tables sont reconnues à leur nom et à leur colonne Synchro_Ids.
export const legacyTables = schema => [
  ...schema.tableIds.filter(id => id.startsWith('Synchro_') && (schema.columns(id) || []).some(c => c.colId === LIST_COL && c.isFormula)),
  ...schema.tableIds.map(id => `${id}_summary_${KEY_COL}`).filter(id => schema.has(id)),
];

export async function removeLegacy(schema) {
  await removeTechnicalTables(legacyTables(schema));
  const page = await exportsViewRef();
  if (page) await apply([['RemoveView', page]]);
}

// ---------------------------------------------------------------------------------------------
// CIBLE

// Colonnes du journal : celles de la table Synchro (le webhook envoie chaque ligne entière), puis
// les colonnes des lignes dépliées et leurs marques (clé, date, suppression, bloc des colonnes ;
// recopiée, effet, auteur, date d'arrivée).
const JOURNAL_COLUMNS = [
  ...syncColumns([]).map(({ id, type }) => ({ id, type, isFormula: false })).filter(c => ![AUTHOR_COL, MISSING_COL].includes(c.id)),
  { id: KEY_COL, type: 'Text', isFormula: false },
  { id: ORDER_COL, type: 'DateTime:UTC', isFormula: false },
  { id: DELETE_COL, type: 'Bool', isFormula: false },
  { id: DATA_COL, type: 'Text', isFormula: false },
  { id: APPLIED_COL, type: 'Bool', isFormula: false },
  { id: STATE_COL, type: 'Text', isFormula: false },
  { id: AUTHOR_COL, type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 },
  { id: RECEIVED_COL, type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 0 },
];

// Journaux d'exports reçus : leur note dit d'où ils viennent et où va chaque table.
// { journal, note: { id, export, name, secret, from, mode, base, tables: [{ table, dest, columns,
// map, match, label }], refused: [], missing: {} } }
export function receivedJournals(schema) {
  return schema.tableIds.filter(id => id.startsWith(JOURNAL_PREFIX)).map((journal) => {
    const note = readNote(schema, journal);
    return note && note.export && Array.isArray(note.tables) ? { journal, note: { refused: [], missing: {}, ...note } } : null;
  }).filter(Boolean);
}

// Journaux d'avant la version 0.4 (un par table reçue) : à refaire.
export function legacyJournals(schema) {
  const current = new Set(receivedJournals(schema).map(r => r.journal));
  return schema.tableIds.filter(id => id.startsWith(JOURNAL_PREFIX) && !current.has(id) && (schema.columns(id) || []).some(c => c.colId === LIST_COL));
}

// Tables reçues ici, avec le document qui les envoie : pour refuser les boucles et repérer un relais.
export const receivedDests = schema => receivedJournals(schema)
  .flatMap(({ note }) => note.tables.map(tb => ({ dest: tb.dest, fromDocId: (note.from || {}).docId || '' })));

// Un journal créé par une version précédente du widget reçoit les colonnes techniques qui lui
// manquent. Renvoie vrai si le schéma a changé.
export async function upgradeJournal(schema, journal) {
  const have = new Set(schema.columns(journal).map(c => c.colId));
  const missing = JOURNAL_COLUMNS.filter(c => !have.has(c.id));
  await apply(missing.map(({ id, ...info }) => ['AddColumn', journal, id, info]));
  return missing.length > 0;
}

// Colonnes que la destination reçoit : les colonnes de données.
export const destColumns = columns => columns.filter(c => ![KEY_COL, ORDER_COL, DELETE_COL].includes(c.id));

// CIBLE : colonnes envoyées qui manquent à la destination, sous le nom choisi dans `map`
// (colonne envoyée -> colonne de la destination). La clé `id_sync` en fait partie.
export function addDestColumnsActions(schema, dest, columns, map = {}) {
  const have = new Set((schema.columns(dest) || []).map(c => c.colId));
  return [...destColumns(columns), { id: KEY_COL, type: 'Text', label: KEY_COL }]
    .map(({ id, type, label }) => ({ id: map[id] || id, type, label: map[id] ? map[id] : label }))
    .filter(c => !have.has(c.id))
    .map(({ id, ...info }) => ['AddColumn', dest, id, { ...info, isFormula: false }]);
}

export async function createJournal(journal, note) {
  await apply([['AddTable', journal, JOURNAL_COLUMNS]]);
  await writeNote(await readSchema(), journal, note);
  await dropPages([journal]);
}

// Destination d'une table reçue : créée, ou complétée des colonnes qui lui manquent ; sa clé
// `id_sync` est masquée de sa page.
export async function prepareDest({ dest, columns, map = {} }) {
  if (!(await readSchema()).has(dest)) await apply([['AddTable', dest, []]]);
  await apply(addDestColumnsActions(await readSchema(), dest, columns, map));
  await hideColumn(dest, KEY_COL);
}

// Note JSON dans la description de la colonne Synchro_Ids d'un journal.
const listColumn = (schema, tableId) => (schema.columns(tableId) || []).find(c => c.colId === LIST_COL);

export function readNote(schema, tableId) {
  const column = listColumn(schema, tableId);
  try { return JSON.parse((column && column.description) || 'null'); } catch (e) { return null; }
}

export async function writeNote(schema, tableId, value) {
  await apply([['UpdateRecord', '_grist_Tables_column', listColumn(schema, tableId).id, { description: value == null ? '' : JSON.stringify(value) }]]);
}

// Efface des tables techniques et les pages qu'elles laissent vides, puis range les pages où il
// reste des sections (formulaires repliés, partage de la page).
export async function removeTechnicalTables(tableIds) {
  const schema = await readSchema();
  const ids = tableIds.filter(id => schema.has(id));
  if (!ids.length) return;
  const refs = new Set(ids.map(id => schema.table(id).id));
  const views = new Set((await fetchRows('_grist_Views_section')).filter(s => refs.has(s.tableRef)).map(s => s.parentId));
  await apply(ids.map(id => ['RemoveTable', id]));
  const [sections, existing] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Views')]);
  const left = new Set(sections.map(s => s.parentId));
  const still = new Set(existing.map(v => v.id));
  await apply([...views].filter(v => still.has(v) && !left.has(v)).map(v => ['RemoveView', v]));
  await tidyPages([...views].filter(v => still.has(v) && left.has(v)));
}

