// Tables techniques du widget :
//  - SOURCE : une seule table, Synchro, quel que soit le nombre d'exports et de tables. Chaque
//    table d'un export y a sa liste des clés, son lot de lignes modifiées et son suivi des clés
//    (voir core.js) ; une ligne 'charge' suit les renvois du document. Les exports (nom, lien
//    public), les invitations en attente (et l'empreinte de leur secret) et les pauses sont notés
//    dans la description de sa colonne Synchro_Export : des métadonnées, que le webhook n'envoie pas.
//  - CIBLE : un journal par export reçu, Journal_<export>, où le webhook dépose les listes et les
//    lots. Ce que la CIBLE a choisi (destinations, colonnes) est noté dans la description de sa
//    colonne Synchro_Ids, que la clé du formulaire ne peut pas écrire.
// Aucune n'a de page : elles restent dans « Données source ».
import {
  APPLIED_COL, AUTHOR_COL, DATA_COL, DELETE_COL, EXPORT_COL, JOURNAL_PREFIX, KEY_COL, KIND, LIST_COL, LOT_COL, MISSING_COL, ORDER_COL, RECEIVED_COL,
  RESEND_COL, SCHEMA_COL, TYPE_COL,
  RECALC_COL, RECALC_SPEC, STATE_COL, SYNC_TABLE, TABLE_COL, TRACK_COL, addTrackRowsAction, deleteColumnAction, exchangeTables, exportCondition, exportRowsActions,
  exportTables, exportableColumns, hookName, hooksOf, keyTriggerAction, majleAction, missingSyncColumns, prepareSourceActions, syncColumns, syncFormulas,
} from './core.js';
import {
  apply, createWebhook, deleteWebhook, dropPages, exportsViewRef, fetchRows, hideColumn, listWebhooks, readSchema, tidyPages, webhookConditions,
} from './grist.js';

// Tables de la personne, que l'on peut envoyer ou choisir comme destination : pas celles du widget.
export const isUserTable = id => id !== SYNC_TABLE && !id.startsWith('Synchro_') && !id.startsWith(JOURNAL_PREFIX);

// ---------------------------------------------------------------------------------------------
// SOURCE

const SORT_COL = 'manualSort'; // colonne d'ordre que Grist donne à toute table (voir ensureSyncTable)

// Lignes de Synchro des exports ([] sans la table), sans la ligne 'charge'. `schema` : instantané
// déjà lu, s'il y en a un.
export const isCharge = row => row[TYPE_COL] === KIND.load;
export const syncRows = async (schema = null) => ((schema || await readSchema()).has(SYNC_TABLE) ? (await fetchRows(SYNC_TABLE)).filter(r => !isCharge(r)) : []);

// Ligne 'charge' de Synchro (voir parseCharge), créée au premier renvoi.
export async function chargeRow() {
  const row = (await fetchRows(SYNC_TABLE)).find(isCharge);
  if (row) return row;
  const fields = { [TYPE_COL]: KIND.load, [EXPORT_COL]: '', [TABLE_COL]: '', [SCHEMA_COL]: '', [RESEND_COL]: '' };
  return { ...fields, id: (await apply([['AddRecord', SYNC_TABLE, null, fields]])).retValues[0] };
}

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

// Relit la note, la change (`change` la modifie en place) et l'écrit.
export async function updateSourceNote(change) {
  const note = readSourceNote(await readSchema());
  change(note);
  await writeSourceNote(note);
}

// Les formules de Synchro nomment les tables qu'elles lisent : réécrites quand l'ensemble change.
// Une table renommée ou effacée dans la SOURCE n'y figure plus (la carte de l'export le signale) :
// son nom inconnu mettrait en erreur les lignes de tous les exports.
async function refreshFormulas(schema, rows) {
  const { keys, lot, state } = syncFormulas(rows.map(r => r[TABLE_COL]).filter(table => schema.has(table)));
  const cols = schema.columns(SYNC_TABLE);
  const actions = [[LIST_COL, keys], [LOT_COL, lot], [TRACK_COL, state]]
    .filter(([colId, formula]) => (cols.find(c => c.colId === colId) || {}).formula !== formula)
    .map(([colId, formula]) => ['ModifyColumn', SYNC_TABLE, colId, { formula }]);
  await apply(actions);
  return actions.length > 0;
}

// Table Synchro à jour : une colonne ajoutée par une version suivante du widget est créée, la
// colonne de suivi (marque d'envoi coupé des lots, suivi des clés, heure de la dernière
// consolidation d'un Échange) accepte du texte et surveille le lot, la liste et la demande de
// renvoi (dépendances posées après coup : Grist les refuse à la création), les formules
// sont celles de cette version, pour les tables de `rows` (lignes de Synchro, ou à venir), et
// chaque table d'un export a son suivi des clés. Synchro n'a pas de colonne manualSort : le webhook
// l'enverrait, et chaque ligne reçue se placerait au même rang dans le journal ; au bout d'une
// cinquantaine d'envois en attente (page de la CIBLE fermée), Grist renumérote les lignes voisines,
// ce que la clé du formulaire n'a pas le droit de faire (403), et la file se bloque (vérifié). Rend
// vrai si quelque chose a changé.
export async function ensureSyncTable(rows = null) {
  let schema = await readSchema();
  if (!schema.has(SYNC_TABLE)) return false;
  const have = new Set(schema.columns(SYNC_TABLE).map(c => c.colId));
  const missing = syncColumns([]).filter(c => !have.has(c.id));
  const sorted = have.has(SORT_COL);
  if (missing.length || sorted) {
    await apply([...missing.map(({ id, ...info }) => ['AddColumn', SYNC_TABLE, id, info]), ...(sorted ? [['RemoveColumn', SYNC_TABLE, SORT_COL]] : [])]);
    schema = await readSchema();
  }
  const cols = schema.columns(SYNC_TABLE);
  const watch = cols.find(c => c.colId === TRACK_COL);
  const deps = ['L', ...[LOT_COL, LIST_COL, RESEND_COL].map(id => cols.find(c => c.colId === id).id)];
  const depsChanged = JSON.stringify(watch.recalcDeps || null) !== JSON.stringify(deps) || watch.type !== 'Any';
  if (watch.type !== 'Any') await apply([['ModifyColumn', SYNC_TABLE, TRACK_COL, { type: 'Any' }]]);
  if (depsChanged) await apply([['UpdateRecord', '_grist_Tables_column', watch.id, { recalcWhen: 0, recalcDeps: deps }]]);
  const formulasChanged = await refreshFormulas(schema, rows || await syncRows(schema));
  const track = addTrackRowsAction(await fetchRows(SYNC_TABLE));
  if (track) await apply([track]);
  return missing.length > 0 || sorted || depsChanged || formulasChanged || Boolean(track);
}

// MajLe de chaque table envoyée suit les colonnes que ses exports envoient (voir majleAction), et
// la table a sa colonne RecalculLe. Rend vrai si quelque chose a changé.
export async function refreshMajLe() {
  const schema = await readSchema();
  const rows = await syncRows(schema);
  const sent = new Map(); // table -> colonnes envoyées par l'un de ses exports
  for (const id of new Set(rows.map(r => r[EXPORT_COL]))) {
    // Une colonne de filtre compte aussi : une ligne qui entre dans le filtre doit partir.
    for (const { table, columns, filter } of exportTables(rows, id)) {
      sent.set(table, new Set([...(sent.get(table) || []), ...columns.map(c => c.id), ...(filter ? [filter.id] : [])]));
    }
  }
  const tables = [...sent].filter(([table]) => schema.has(table));
  // RecalculLe (repère des annulations) manque aux tables exportées avant la version 0.4.3, et
  // était une date avant la version 0.5.
  const recalc = table => schema.columns(table).find(c => c.colId === RECALC_COL);
  const actions = [
    ...tables.flatMap(([table]) => (recalc(table) ? [] : prepareSourceActions(table, [RECALC_COL]))),
    ...tables.filter(([table]) => recalc(table) && (recalc(table).type !== RECALC_SPEC.type || recalc(table).formula !== RECALC_SPEC.formula))
      .map(([table]) => ['ModifyColumn', table, RECALC_COL, RECALC_SPEC]),
    ...tables.map(([table, ids]) => majleAction(schema.columns(table), [...ids])).filter(Boolean),
  ];
  await apply(actions);
  return actions.length > 0;
}

// Enregistre les tables et colonnes d'un export (`tables` : [{ table, columns }]). Crée la table
// Synchro au premier export. Rend les tables dont les lignes sont à envoyer (nouvelles ou aux
// colonnes changées). `swap` : export en Échange (voir exportRowsActions).
export async function saveExport(exportId, tables, { isPublic = false, swap = false } = {}) {
  if (!(await readSchema()).has(SYNC_TABLE)) {
    await apply([['AddTable', SYNC_TABLE, syncColumns(tables.map(tb => tb.table))]]);
    await dropPages([SYNC_TABLE]);
  }
  const before = await fetchRows(SYNC_TABLE);
  const { actions, changed } = exportRowsActions(before, exportId, tables, { isPublic, swap });
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


// Note d'un journal relue, changée par `change` (qui rend la nouvelle note), puis écrite.
export async function updateJournalNote(journal, change) {
  const schema = await readSchema();
  await writeNote(schema, journal, change(readNote(schema, journal)));
}

// ---------------------------------------------------------------------------------------------
// Échange : deux documents qui se tiennent à jour l'un l'autre (voir planConsolidation). Chacun a
// un export (même identifiant des deux côtés, avec sa ligne 'echange') et un journal en mode
// 'echange' qui reçoit l'autre. Le journal de retour du document qui a invité (`retour`) attend
// la réponse (`from` encore vide) avant de recopier quoi que ce soit.

export const awaitingPartner = note => note.mode === 'echange' && Boolean(note.retour) && !(note.from || {}).docId;

// Côté CIBLE : l'export de retour (identifiant et nom de l'export reçu) envoie les destinations à
// la SOURCE. Elles reçoivent MajLe et RecalculLe, et une clé à chaque ligne nouvelle ; les lignes
// déjà là sans clé restent à ce document. Avec `retour` (adresse d'écriture du journal de retour,
// lue dans l'invitation, jamais notée), le webhook vers la SOURCE est (re)créé.
export async function wireExchange(note, retour = '') {
  let schema = await readSchema();
  for (const { dest } of note.tables) {
    const cols = schema.columns(dest) || [];
    await apply([...prepareSourceActions(dest, missingSyncColumns(cols)), keyTriggerAction(dest, cols), deleteColumnAction(dest, cols)].filter(Boolean));
  }
  schema = await readSchema();
  await saveExport(note.export, exchangeTables(note.tables, dest => exportableColumns(schema.columns(dest) || [])), { swap: true });
  await updateSourceNote((n) => {
    const was = n.exports.find(e => e.id === note.export) || { at: Date.now() / 1000 };
    n.exports = [...n.exports.filter(e => e.id !== note.export), { ...was, id: note.export, name: note.name, echange: true, retour: true }];
  });
  if (!retour) return;
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  for (const h of hooksOf(hooks, conditions, note.export)) await deleteWebhook(h.id);
  const from = note.from || {};
  await createWebhook({
    name: hookName(note.name, note.export), memo: [from.email, from.docId].filter(Boolean).join(' · '), url: retour,
    tableId: SYNC_TABLE, condition: exportCondition(note.export),
  });
}

// Échange, côté du document qui invite : ses tables reçoivent la case Supprime.
export async function addDeleteColumns(tables) {
  const schema = await readSchema();
  await apply(tables.map(table => deleteColumnAction(table, schema.columns(table) || [])).filter(Boolean));
}

// Fin d'un Échange, de ce côté : ses webhooks et son journal sont effacés, les tables gardent
// leurs lignes. `keepExport` (document qui a invité) : l'export reste, sans destinataire ; sinon
// (export de retour) il disparaît aussi.
export async function endExchange(exportId, { keepExport }) {
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  for (const h of hooksOf(hooks, conditions, exportId)) await deleteWebhook(h.id);
  const journals = receivedJournals(await readSchema()).filter(r => r.note.export === exportId && r.note.mode === 'echange');
  await removeTechnicalTables(journals.map(r => r.journal));
  if (keepExport) await saveExport(exportId, exportTables(await syncRows(), exportId));
  else await removeExport(exportId);
  await updateSourceNote((note) => {
    note.exports = keepExport ? note.exports.map(e => (e.id === exportId ? { ...e, echange: false } : e)) : note.exports.filter(e => e.id !== exportId);
    note.invitations = note.invitations.filter(i => i.export !== exportId);
    note.pauses = note.pauses.filter(p => p.export !== exportId);
  });
}
