// CIBLE : un journal par export reçu, Journal_<export>, où le webhook dépose les listes et les lots.
// Ce que la CIBLE a choisi (destinations, colonnes) est noté dans la description de sa colonne
// Synchro_Ids (voir readNote pour sa forme) ; la clé du formulaire peut la lire, mais pas
// l'écrire. Le journal n'a pas de page : seul son formulaire en a une (voir pages.js).
import {
  APPLIED_COL, AUTHOR_COL, BEFORE_COL, DATA_COL, DELETE_COL, JOURNAL_PREFIX, KEY_COL, LIST_COL, MISSING_COL, ORDER_COL, RECEIVED_COL, SEAL_COL,
  SIG_KEY, STATE_COL, columnNote, noteAction,
} from '../logic/common.js';
import { syncColumns } from '../logic/formulas.js';
import { destColumns } from '../logic/journal.js';
import { apply, readSchema } from '../grist.js';
import { dropPages, hideColumn } from '../pages.js';

// Colonnes du journal : celles de la table Synchro (le webhook envoie chaque ligne entière), puis
// les colonnes des lignes dépliées et leurs marques (clé, date, suppression, bloc des colonnes ;
// recopiée, effet, valeurs remplacées, auteur, date d'arrivée, sceau). Le webhook n'écrit que les
// premières : une colonne propre au journal ne gêne pas.
const JOURNAL_COLUMNS = [
  ...syncColumns([]).map(({ id, type }) => ({ id, type, isFormula: false })).filter(c => ![AUTHOR_COL, MISSING_COL].includes(c.id)),
  { id: KEY_COL, type: 'Text', isFormula: false },
  { id: ORDER_COL, type: 'DateTime:UTC', isFormula: false },
  { id: DELETE_COL, type: 'Bool', isFormula: false },
  { id: DATA_COL, type: 'Text', isFormula: false },
  { id: APPLIED_COL, type: 'Bool', isFormula: false },
  { id: STATE_COL, type: 'Text', isFormula: false },
  { id: BEFORE_COL, type: 'Text', isFormula: false },
  { id: AUTHOR_COL, type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 },
  { id: RECEIVED_COL, type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 0 },
  { id: SEAL_COL, type: 'Text', isFormula: false },
];

// Journaux d'exports reçus : { journal, note } (note : voir readNote), dont la note dit d'où ils
// viennent et où va chaque table.
export function receivedJournals(schema) {
  return schema.tableIds.filter(id => id.startsWith(JOURNAL_PREFIX)).map((journal) => {
    const note = readNote(schema, journal);
    return note && note.export && Array.isArray(note.tables) ? { journal, note: { refused: [], missing: {}, ...note } } : null;
  }).filter(Boolean);
}

// Tables reçues ici, avec la table envoyée et le document qui l'envoie : pour refuser les boucles,
// repérer un relais et dire ce qu'une destination reçoit déjà.
export const receivedDests = schema => receivedJournals(schema)
  .flatMap(({ note }) => note.tables.map(tb => ({ dest: tb.dest, table: tb.table, fromDocId: (note.from || {}).docId || '' })));

// Un journal créé par une version précédente du widget reçoit les colonnes techniques qui lui
// manquent. Renvoie vrai si le schéma a changé.
export async function upgradeJournal(schema, journal) {
  const have = new Set(schema.columns(journal).map(c => c.colId));
  const missing = JOURNAL_COLUMNS.filter(c => !have.has(c.id));
  await apply(missing.map(({ id, ...info }) => ['AddColumn', journal, id, info]));
  return missing.length > 0;
}

// CIBLE : colonnes envoyées qui manquent à la destination, sous le nom choisi dans `map`
// (colonne envoyée -> colonne de la destination). La clé `id_sync` en fait partie. Les colonnes de
// données s'affichent dans les vues de la table (`AddColumn` ne les mettrait que dans « Données
// source » et la fiche : une colonne ajoutée plus tard à l'export arrivait cachée) ; la clé non.
export function addDestColumnsActions(schema, dest, columns, map = {}) {
  const have = new Set((schema.columns(dest) || []).map(c => c.colId));
  return [...destColumns(columns), { id: KEY_COL, type: 'Text', label: KEY_COL }]
    .map(({ id, type, label }) => ({ id: map[id] || id, type, label: map[id] ? map[id] : label, key: id === KEY_COL }))
    .filter(c => !have.has(c.id))
    .map(({ id, key, ...info }) => [key ? 'AddColumn' : 'AddVisibleColumn', dest, id, { ...info, isFormula: false }]);
}

// Clé qui signe les envois d'un export reçu (voir trust.js) : dans la description de la colonne
// id_sync de ses destinations ({ signature: { <place>: <clé> } }), pas dans la note du journal,
// que la clé du formulaire peut lire. La place est l'export ; pour un journal de retour d'Échange,
// le journal lui-même : chaque participant signe avec sa propre clé, donnée dans sa réponse.
export const keySlot = (journal, note) => (note.retour ? journal : note.export);
const keyColumn = (schema, table) => (schema.columns(table) || []).find(c => c.colId === KEY_COL);
function keysOf(column) {
  const { signature } = columnNote(column) || {};
  return signature && typeof signature === 'object' ? signature : {};
}
export function receivedKey(schema, journal, note) {
  const slot = keySlot(journal, note);
  return (note.tables || []).map(tb => keysOf(keyColumn(schema, tb.dest))[slot]).find(k => SIG_KEY.test(k || '')) || '';
}
export async function storeKey(tables, slot, key) {
  if (!SIG_KEY.test(key || '')) return;
  const schema = await readSchema();
  await apply(tables.map(table => keyColumn(schema, table)).filter(c => c && keysOf(c)[slot] !== key)
    .map(c => noteAction(c, { signature: { ...keysOf(c), [slot]: key } })));
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

// Note d'un journal : JSON dans la description de sa colonne Synchro_Ids (description de référence).
// - invitation : id, export, name, secret (pour le code de la réponse), from { email, docId,
//   docName }, mode (absent : réponse ; 'echange', 'public' avec base, l'adresse de la SOURCE),
//   renforce, reserve (journal réservé aux éditeurs, voir acl.js), reserved (règle posée), pub et
//   pubSource (clés publiques de la réponse et de l'invitation, pour le code de la réponse et son
//   code de contrôle ; jamais de clé privée, voir linkKeys) ;
// - Échange : retour (journal de retour, chez qui a invité), hook (webhook du participant) ;
// - par table : tables [{ table, dest, columns, map, match, label, refs, dropped, addedCols,
//   waiting }] (voir loop.js), refused (tables refusées) ;
// - état des arrivées : missing { table: lignes manquantes }, big { table: clés trop grosses },
//   tooBig (lien public), suspect (arrivées suspectes), ended (heure de l'avis de fin) ;
// - sceau : empreinte de la clé qui scelle les lignes dépliées (voir trust.js). Une fois notée, une
//   clé de signature introuvable arrête le dépliage (voir sealing dans loop.js).
const listColumn = (schema, tableId) => (schema.columns(tableId) || []).find(c => c.colId === LIST_COL);

const readNote = (schema, tableId) => columnNote(listColumn(schema, tableId));
const writeNote = (schema, tableId, note) => apply([noteAction(listColumn(schema, tableId), note)]);

// Note d'un journal relue, changée par `change` (qui rend la nouvelle note), puis écrite. Rend la
// note écrite.
export async function updateJournalNote(journal, change) {
  const schema = await readSchema();
  const note = change(readNote(schema, journal));
  await writeNote(schema, journal, note);
  return note;
}
