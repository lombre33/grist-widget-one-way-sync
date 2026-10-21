// SOURCE : la seule table technique du widget, Synchro, quel que soit le nombre d'exports et de
// tables. Chaque table d'un export y a sa liste des clés, son lot de lignes modifiées et son suivi
// des clés (voir logic/formulas.js) ; une ligne 'charge' suit les renvois du document. Les exports
// (nom, lien public), les invitations en attente (et l'empreinte de leur secret) et les pauses sont
// notés dans la description de sa colonne Synchro_Export : des métadonnées, que le webhook
// n'envoie pas. Synchro n'a pas de page : elle reste dans « Données source ».
import {
  EXPORT_COL, KIND, LIST_COL, LOT_COL, SIG_KEY, RECALC_COL, RESEND_COL, SCHEMA_COL, SYNC_TABLE, TABLE_COL, TRACK_COL, TYPE_COL, columnNote, noteAction, nowS,
} from '../logic/common.js';
import { RECALC_SPEC, majleAction, prepareSourceActions, syncColumns, syncFormulas } from '../logic/formulas.js';
import { endNotice, exportRowsActions, exportTables, hooksOf, optionsActions } from '../logic/exports.js';
import { filterColumns } from '../logic/filters.js';
import { keptKeys, readKeys, signText } from '../logic/trust.js';
import { addEvent } from '../logic/notes.js';
import { apply, fetchRows, listWebhooks, readSchema, webhookConditions, withLock } from '../grist.js';
import { dropPages, removeTechnicalTables } from '../pages.js';

const SORT_COL = 'manualSort'; // colonne d'ordre que Grist donne à toute table (voir ensureSyncTable)

// Lignes de Synchro des exports ([] sans la table), sans la ligne 'charge'. `schema` : instantané
// déjà lu, s'il y en a un.
export const isCharge = row => row[TYPE_COL] === KIND.load;
export const syncRows = async (schema = null) => ((schema || await readSchema()).has(SYNC_TABLE) ? (await fetchRows(SYNC_TABLE)).filter(r => !isCharge(r)) : []);

// Webhooks du document et leurs conditions (propriétaires seulement) ; `of(id)` : les
// destinataires d'un export (voir hooksOf).
export async function readHooks() {
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  return { hooks, conditions, of: id => hooksOf(hooks, conditions, id) };
}
export const exportHooks = async exportId => (await readHooks()).of(exportId);

// Ligne 'charge' de Synchro (voir parseCharge), créée au premier renvoi.
export async function chargeRow() {
  const row = (await fetchRows(SYNC_TABLE)).find(isCharge);
  if (row) return row;
  const fields = { [TYPE_COL]: KIND.load, [EXPORT_COL]: '', [TABLE_COL]: '', [SCHEMA_COL]: '', [RESEND_COL]: '' };
  return { ...fields, id: (await apply([['AddRecord', SYNC_TABLE, null, fields]])).retValues[0] };
}

// Note de la table Synchro, dans la description de Synchro_Export : forme et opérations dans
// logic/notes.js.
const exportColumn = schema => (schema.columns(SYNC_TABLE) || []).find(c => c.colId === EXPORT_COL);

export const readSourceNote = schema => ({ exports: [], invitations: [], pauses: [], ...columnNote(exportColumn(schema)) });

// Relit la note, la change (`change` rend la nouvelle note, voir logic/notes.js) et l'écrit. Une
// seule lecture-modification-écriture à la fois entre les onglets du navigateur (le rattrapage, une
// action et l'historique écrivent tous dans cette note : la dernière écriture ferait perdre l'autre).
export const updateSourceNote = change => withLock('gristsync-source-note', async () => {
  const schema = await readSchema();
  const column = exportColumn(schema);
  if (column) await apply([noteAction(column, change(readSourceNote(schema)))]);
});

// Événement d'envoi noté pour l'historique de l'export (voir addEvent) ; un échec de la note ne
// fait jamais échouer l'action qu'il raconte.
export const recordEvent = (exportId, kind, fields = {}) => updateSourceNote(note => addEvent(note, exportId, { at: nowS(), kind, ...fields })).catch(console.warn);

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
// renvoi (dépendances posées après coup : Grist les refuse à la création), et les formules
// sont celles de cette version, pour les tables de `rows` (lignes de Synchro, ou à venir ; lues
// ici si absentes). `schema` : déjà lu par l'appelant. Synchro n'a pas de colonne manualSort : le
// webhook l'enverrait, et chaque ligne reçue se placerait au même rang dans le journal ; au bout d'une
// cinquantaine d'envois en attente (page de la CIBLE fermée), Grist renumérote les lignes voisines,
// ce que la clé du formulaire n'a pas le droit de faire (403), et la file se bloque (vérifié). Rend
// vrai si quelque chose a changé.
export async function ensureSyncTable(schema = null, rows = null) {
  schema ||= await readSchema();
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
  return missing.length > 0 || sorted || depsChanged || formulasChanged;
}

// Listes de choix et formats changés dans les tables des exports (voir optionsActions). Rend vrai
// si quelque chose a changé.
export async function refreshOptions(schema, rows) {
  const actions = optionsActions(rows, schema);
  await apply(actions);
  return actions.length > 0;
}

// MajLe de chaque table envoyée suit les colonnes que ses exports envoient (voir majleAction), et
// la table a sa colonne RecalculLe. `schema` et `rows` (lignes de Synchro) : déjà lus par
// l'appelant, sinon lus ici. Rend vrai si quelque chose a changé.
export async function refreshMajLe(schema = null, rows = null) {
  schema ||= await readSchema();
  rows ||= await syncRows(schema);
  const sent = new Map(); // table -> colonnes envoyées par l'un de ses exports
  for (const id of new Set(rows.map(r => r[EXPORT_COL]))) {
    // Une colonne de filtre compte aussi : une ligne qui entre dans le filtre doit partir.
    for (const { table, columns, filter } of exportTables(rows, id)) {
      sent.set(table, new Set([...(sent.get(table) || []), ...columns.map(c => c.id), ...filterColumns(filter)]));
    }
  }
  const tables = [...sent].filter(([table]) => schema.has(table));
  // RecalculLe (repère des annulations) remise en état si elle manque ou a été changée à la main.
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
  await ensureSyncTable(null, [...before, ...all]);
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

// Clés qui signent les envois d'un export, une par destinataire (ligne 'signature' de Synchro,
// réservée aux propriétaires : { webhook : clé }, voir readKeys). Les formules signent pour chacune
// dès qu'elle est là (voir formulas.js). `change` rend les nouvelles clés ; rien n'est écrit si
// elles n'ont pas changé (sinon tous les lots de l'export seraient recalculés et renvoyés).
async function updateKeys(exportId, change) {
  const row = (await syncRows()).find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.sign);
  const before = readKeys(row ? row[SCHEMA_COL] : '');
  const after = change(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return;
  const value = JSON.stringify(after);
  await apply([row ? ['UpdateRecord', SYNC_TABLE, row.id, { [SCHEMA_COL]: value }]
    : ['AddRecord', SYNC_TABLE, null, { [EXPORT_COL]: exportId, [TABLE_COL]: '', [TYPE_COL]: KIND.sign, [SCHEMA_COL]: value, [RESEND_COL]: '' }]]);
}

// Clé d'un destinataire, rangée sous `label` (l'invitation, le temps de créer son webhook, puis le
// webhook) ; `was` : l'étiquette qu'elle remplace.
export async function putRecipientKey(exportId, label, key, was = '') {
  if (!SIG_KEY.test(key || '')) throw new Error('codeInvalid');
  await updateKeys(exportId, (keys) => {
    const rest = Object.fromEntries(Object.entries(keys).filter(([k]) => k !== was));
    return { ...rest, [label]: key };
  });
}

// Seule clé d'un export : celle de l'envoi de retour d'un Échange, côté CIBLE (un seul webhook).
export async function setOnlyKey(exportId, label, key) {
  if (!SIG_KEY.test(key || '')) throw new Error('codeInvalid');
  await updateKeys(exportId, () => ({ [label]: key }));
}

// Clés des destinataires partis effacées (voir keptKeys) : un webhook révoqué ne reçoit plus de
// lot signé pour lui, et une ancienne clé ne signe plus rien.
export async function pruneKeys(exportId) {
  const [hooks, schema] = await Promise.all([exportHooks(exportId), readSchema()]);
  const pending = readSourceNote(schema).invitations.filter(inv => inv.export === exportId).map(inv => inv.id);
  await updateKeys(exportId, keys => keptKeys(keys, hooks.map(h => h.id), pending));
}

// Avis de fin d'un export pour le webhook `hookId` (voir endNotice), signé avec la clé de ce
// destinataire. Une clé illisible (réseau) arrête l'action en cours : un avis non signé serait
// rejeté par la CIBLE, qui ne saurait jamais la fin.
export async function endRows(exportId, hookId) {
  const row = (await syncRows()).find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.sign);
  const keys = readKeys(row ? row[SCHEMA_COL] : '');
  const key = keys[hookId] || keys['*'];
  const rows = endNotice(exportId);
  return key ? Promise.all(rows.map(async r => ({ ...r, [LOT_COL]: await signText(key, r, '{"fin": true}') }))) : rows;
}

// Écrit les mêmes champs dans des lignes de Synchro (renvoi, marque d'envoi coupé).
export const writeSync = (ids, fields) => apply(ids.length
  ? [['BulkUpdateRecord', SYNC_TABLE, ids, Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, ids.map(() => v)]))]] : []);
