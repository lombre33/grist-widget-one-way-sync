// CIBLE : ce que le schéma dit des exports reçus (journaux, destinations, clés de signature), en
// fonctions pures sur le schéma lu (voir readSchema dans grist.js). Les écritures sont dans
// target/journals.js.
import { JOURNAL_PREFIX, KEY_COL, LIST_COL, SIG_KEY, columnNote, noteAction } from './common.js';
import { destColumns } from './journal.js';
import { columnOptions, fillOptions, ownsColumn } from './options.js';

// Note d'un journal : JSON dans la description de sa colonne Synchro_Ids (description de référence).
// - invitation : id, export, name, secret (pour le code de la réponse), from { email, docId,
//   docName }, mode (absent : réponse ; 'echange', 'public' avec base, l'adresse de la SOURCE),
//   renforce, reserve (journal réservé aux éditeurs, voir acl.js), reserved (règle posée), archive
//   (une ligne effacée à la SOURCE reste ici, cochée) et verrou (tables reçues en lecture seule,
//   voir target/options.js), pub et
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
export const journalNote = (schema, tableId) => columnNote(listColumn(schema, tableId));
export const journalNoteAction = (schema, tableId, note) => noteAction(listColumn(schema, tableId), note);

// Ce que la note garde des options d'une réception (rien pour une option décochée).
export const optionsNote = ({ archive, verrou }) => ({ ...(archive ? { archive: true } : {}), ...(verrou ? { verrou: true } : {}) });

// Journaux d'exports reçus : { journal, note } (note : voir plus haut), dont la note dit d'où ils
// viennent et où va chaque table.
export function receivedJournals(schema) {
  return schema.tableIds.filter(id => id.startsWith(JOURNAL_PREFIX)).map((journal) => {
    const note = journalNote(schema, journal);
    return note && note.export && Array.isArray(note.tables) ? { journal, note: { refused: [], missing: {}, ...note } } : null;
  }).filter(Boolean);
}

// Tables reçues ici, avec la table envoyée et le document qui l'envoie : pour refuser les boucles,
// repérer un relais et dire ce qu'une destination reçoit déjà.
export const receivedDests = schema => receivedJournals(schema)
  .flatMap(({ note }) => note.tables.map(tb => ({ dest: tb.dest, table: tb.table, fromDocId: (note.from || {}).docId || '' })));

// Colonnes envoyées qui manquent à la destination, sous le nom choisi dans `map` (colonne envoyée
// -> colonne de la destination). La clé `id_sync` en fait partie. Les colonnes de données
// s'affichent dans les vues de la table (`AddColumn` ne les mettrait que dans « Données source » et
// la fiche : une colonne ajoutée plus tard à l'export arrivait cachée) ; la clé non. Chacune prend
// la liste de choix et le format de la SOURCE (voir options.js).
export function addDestColumnsActions(schema, dest, columns, map = {}) {
  const have = new Set((schema.columns(dest) || []).map(c => c.colId));
  return [...destColumns(columns), { id: KEY_COL, type: 'Text', label: KEY_COL }]
    .map(({ id, type, label, opts }) => ({ id: map[id] || id, type, label: map[id] ? map[id] : label, key: id === KEY_COL, opts: columnOptions(type, opts) }))
    .filter(c => !have.has(c.id))
    .map(({ id, key, opts, ...info }) => [key ? 'AddColumn' : 'AddVisibleColumn', dest, id, { ...info, isFormula: false, ...(opts ? { widgetOptions: JSON.stringify(opts) } : {}) }]);
}

// Colonnes envoyées (leur nom dans l'export) que addDestColumnsActions créerait : la CIBLE les note
// comme siennes (`own` de l'entrée), seules à recevoir plus tard les choix ajoutés à la SOURCE.
export function missingColumns(schema, dest, columns, map = {}) {
  const have = new Set((schema.columns(dest) || []).map(c => c.colId));
  return destColumns(columns).map(c => c.id).filter(id => !have.has(map[id] || id));
}

// Listes de choix et formats reçus, ajoutés à ce qui manque aux colonnes de la destination que la
// CIBLE a créées (voir ownsColumn et fillOptions). `columns` : colonnes envoyées, avec `opts`.
export function optionActions(schema, entry, columns) {
  const here = new Map((schema.columns(entry.dest) || []).map(c => [c.colId, c]));
  return destColumns(columns).filter(c => c.opts).flatMap((c) => {
    const column = here.get((entry.map || {})[c.id] || c.id);
    if (!column || !ownsColumn(entry.own, c.id, column)) return [];
    const text = fillOptions(column.type, column.widgetOptions, c.opts);
    return text ? [['UpdateRecord', '_grist_Tables_column', column.id, { widgetOptions: text }]] : [];
  });
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
// Clé notée à sa place dans les destinations `tables` qui ne l'ont pas déjà.
export function storeKeyActions(schema, tables, slot, key) {
  if (!SIG_KEY.test(key || '')) return [];
  return tables.map(table => keyColumn(schema, table)).filter(c => c && keysOf(c)[slot] !== key)
    .map(c => noteAction(c, { signature: { ...keysOf(c), [slot]: key } }));
}
