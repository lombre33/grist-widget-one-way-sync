// SOURCE : un export (des tables, leurs colonnes, un filtre de lignes facultatif) et ses lignes
// dans Synchro ; ses destinataires (un webhook filtré sur l'export) ; ce qu'un Échange renvoie. Les
// règles d'accès du lien public sont dans acl.js.
import { AUTHOR_COL, COL_ID, DELETE_COL, EXPORT_COL, HEX16, KEY_COL, KIND, ORDER_COL, RECALC_COL, RESEND_COL, SCHEMA_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, is, parseJson } from './common.js';

// Dernier envoi à un destinataire coupé (révoqué, export supprimé, Échange arrêté) : une ligne
// « fin » de son export, envoyée directement à l'adresse de son webhook. Sans elle, la CIBLE, qui ne
// lit pas la SOURCE, ne saurait jamais que plus rien n'arrivera.
export const endNotice = exportId => [{ [EXPORT_COL]: exportId, [TYPE_COL]: KIND.end }];

// Colonnes qu'une table SOURCE peut envoyer : toutes ses colonnes de données et formules, hors
// colonnes de la synchro et colonnes internes de Grist. Une Référence part comme le texte qu'elle
// affiche ; une colonne Pièces jointes, comme la liste de ses fichiers (voir files.js).
export function exportableColumns(cols) {
  const skip = new Set(['manualSort', KEY_COL, ORDER_COL, RECALC_COL, DELETE_COL]);
  return cols.filter(c => !skip.has(c.colId) && !c.colId.startsWith('gristHelper_')).map(c => ({
    id: c.colId, label: c.label || c.colId, type: /^Ref(List)?:/.test(c.type) ? 'Text' : c.type, source: c.type, visible: c.visible || '',
  }));
}

// Tables que lisent les formules de Synchro pour les tables d'un export (`tables`, voir
// exportTables) : les siennes, et celles d'où vient le texte affiché de ses colonnes Référence.
export const readTables = tables => [...new Set(tables.flatMap(({ table, columns }) => [table,
  ...columns.map(c => (/^Ref(?:List)?:(\w+)$/.exec(c.source || '') || [])[1]).filter(Boolean)]))];

// Colonne Pièces jointes (envoyée ou reçue).
export const isFileColumn = c => c.type === 'Attachments';

// Filtre de lignes d'une table : n'envoyer que les lignes dont la colonne `id` vaut `value` (texte
// affiché, sans tenir compte des majuscules ; une case à cocher vaut « oui » ou « non »). Rend le
// filtre tel que la formule le lit, ou null s'il est vide ou mal formé.
const YES = ['oui', 'yes', 'vrai', 'true', '1', 'x'];
export function rowFilter(filter) {
  if (!filter || !COL_ID.test(String(filter.id || ''))) return null;
  const source = String(filter.source || '');
  const text = String(filter.value ?? '').trim().toLowerCase();
  const value = source === 'Bool' ? (YES.includes(text) ? 'oui' : 'non') : text;
  return { id: filter.id, source, visible: String(filter.visible || ''), value };
}

// ---------------------------------------------------------------------------------------------
// Lignes Synchro d'un export

const SYNC_FIELDS = [EXPORT_COL, TABLE_COL, TYPE_COL, SCHEMA_COL, RESEND_COL];

// Valeur de Synchro_Colonnes voulue pour chaque type de ligne d'une table : ses colonnes, ou son
// filtre (ligne 'filtre', seulement s'il y en a un).
function wantedValues({ columns, filter }, kinds) {
  const schema = JSON.stringify(columns.map(({ id, type, label, source, visible, as }) => ({ id, type, label, source, visible, ...(as ? { as } : {}) })));
  const kept = rowFilter(filter);
  return new Map([...kinds.map(kind => [kind, schema]), ...(kept ? [[KIND.filter, JSON.stringify(kept)]] : [])]);
}

// Table nouvelle, aux colonnes changées ou au filtre changé : ses lignes sont à renvoyer.
function tableChanged(here, values) {
  const filterWas = (here.find(r => r[TYPE_COL] === KIND.filter) || {})[SCHEMA_COL] || '';
  return !here.length || here.some(r => r[TYPE_COL] !== KIND.filter && r[SCHEMA_COL] !== values.get(KIND.keys))
    || filterWas !== (values.get(KIND.filter) || '');
}

// Lignes Synchro d'un export : par table, sa liste des clés, son lot, son suivi des clés, son
// filtre s'il en a un, la liste de ses fichiers si elle envoie des pièces jointes, et son
// instantané complet avec son empreinte s'il est partagé par lien public ; un export en Échange
// (`swap`) a en plus sa ligne 'echange' (sans table) ; sa ligne 'signature' reste telle quelle (voir
// signingKey). `rows` : lignes Synchro existantes. Rend les actions qui amènent l'export à `tables`
// ([{ table, columns, filter }], colonnes de `exportableColumns`) et `changed`, les tables dont les
// lignes sont à renvoyer.
export function exportRowsActions(rows, exportId, tables, { isPublic = false, swap = false } = {}) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId);
  const kinds = [KIND.keys, KIND.lot, KIND.track, ...(isPublic ? [KIND.full, KIND.mark] : [])];
  const wanted = [];
  const changed = [];
  for (const tb of tables) {
    const values = wantedValues(tb, tb.columns.some(isFileColumn) ? [...kinds, KIND.files] : kinds);
    const here = mine.filter(r => r[TABLE_COL] === tb.table);
    if (tableChanged(here, values)) changed.push(tb.table);
    for (const [kind, value] of values) wanted.push({ table: tb.table, kind, value, row: here.find(r => r[TYPE_COL] === kind) });
  }
  if (swap) wanted.push({ table: '', kind: KIND.swap, value: '', row: mine.find(r => r[TYPE_COL] === KIND.swap) });
  const keys = new Set(wanted.map(w => `${w.table}|${w.kind}`));
  const add = wanted.filter(w => !w.row)
    .map(w => ({ [EXPORT_COL]: exportId, [TABLE_COL]: w.table, [TYPE_COL]: w.kind, [SCHEMA_COL]: w.value, [RESEND_COL]: '' }));
  const update = wanted.filter(w => w.row && w.kind !== KIND.swap && w.row[SCHEMA_COL] !== w.value);
  const remove = mine.filter(r => r[TYPE_COL] !== KIND.sign && !keys.has(`${r[TABLE_COL]}|${r[TYPE_COL]}`)).map(r => r.id);
  const actions = [];
  if (add.length) actions.push(['BulkAddRecord', SYNC_TABLE, add.map(() => null), Object.fromEntries(SYNC_FIELDS.map(c => [c, add.map(r => r[c])]))]);
  if (update.length) actions.push(['BulkUpdateRecord', SYNC_TABLE, update.map(w => w.row.id), { [SCHEMA_COL]: update.map(w => w.value) }]);
  if (remove.length) actions.push(['BulkRemoveRecord', SYNC_TABLE, remove]);
  return { actions, changed };
}

// Tables, colonnes et filtres d'un export, lus dans ses lignes Synchro.
export function exportTables(rows, exportId) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId && r[TYPE_COL] !== KIND.swap && r[TYPE_COL] !== KIND.sign);
  const tables = new Map();
  for (const r of mine) {
    if (r[TYPE_COL] !== KIND.filter && !tables.has(r[TABLE_COL])) tables.set(r[TABLE_COL], parseJson(r[SCHEMA_COL], []) || []);
  }
  const filterOf = table => rowFilter(parseJson((mine.find(r => r[TABLE_COL] === table && r[TYPE_COL] === KIND.filter) || {})[SCHEMA_COL], null));
  return [...tables].map(([table, columns]) => ({ table, columns, filter: filterOf(table) }));
}

// Exports en Échange : ceux qui ont une ligne 'echange'.
export const swapExports = rows => new Set(rows.filter(r => r[TYPE_COL] === KIND.swap).map(r => r[EXPORT_COL]));

// ---------------------------------------------------------------------------------------------
// Destinataires

// Condition du webhook d'un destinataire : Grist ne lui envoie que les lignes de son export.
const conditionOf = exportId => `rec.${EXPORT_COL} == "${exportId}" and rec.${TYPE_COL} in ("${KIND.keys}", "${KIND.lot}")`;
// L'identifiant entre dans une formule Python : rien d'autre que 16 chiffres hexadécimaux.
export function exportCondition(exportId) {
  if (!is(HEX16, exportId)) throw new Error('codeInvalid');
  return conditionOf(exportId);
}

// Export d'un webhook, lu dans sa condition ; '' si elle n'a pas exactement la forme attendue
// (webhook à ne pas laisser : il recevrait d'autres lignes que celles d'un export).
export function conditionExport(text) {
  const [before, after] = conditionOf('\u0000').split('\u0000');
  const s = String(text || '');
  if (!s.startsWith(before) || !s.endsWith(after)) return '';
  const id = s.slice(before.length, s.length - after.length);
  return HEX16.test(id) ? id : '';
}

// Nom du webhook d'un destinataire : lisible dans les réglages de Grist, avec l'export en fin.
export const hookName = (name, exportId) => `Synchro ${name} #${exportId}`;

// État d'un destinataire, lu dans l'état d'envoi que Grist donne à son webhook (`usage`) :
// [état, ton de la pastille].
export function hookStatus(h) {
  if (!h.fields.enabled) return ['paused', 'off'];
  const u = h.usage || {};
  return ['retrying', 'error'].includes(u.status) || u.lastHttpStatus >= 400 ? ['error', 'err'] : ['active', 'ok'];
}

// Lot refusé pour sa taille. L'état d'un webhook est remis à zéro quand la file est vidée, mais un
// envoi en vol peut encore y écrire son échec : seul compte l'envoi que Grist retente.
export function tooLarge(h) {
  const u = h.usage || {};
  return ['retrying', 'postponed'].includes(u.status) && (u.lastEventBatch || {}).httpStatus === 413;
}

// Erreur d'envoi d'un destinataire : clé du texte qui la dit simplement, avec ce qu'il faut faire.
export function hookErrorKey(h) {
  const u = h.usage || {};
  const status = u.lastHttpStatus || (u.lastEventBatch || {}).httpStatus;
  if (status === 413) return 'send.error.size';
  if (/Invalid column/i.test(u.lastErrorMessage || '')) return 'send.error.column';
  return [401, 403, 404].includes(status) ? 'send.error.link' : 'send.error.other';
}

// État d'un export pour sa carte : [clé de la pastille, ton]. `exp` : { recipients, invitations,
// public, echange, retour }.
export function exportStatus(exp) {
  if (exp.recipients.some(h => hookStatus(h)[0] === 'error')) return ['error', 'err'];
  if (exp.recipients.length && exp.echange && !exp.retour) return ['participants', 'ok'];
  if (exp.recipients.length || exp.public) return ['people', 'ok'];
  return exp.invitations.length ? ['invited', 'pending'] : ['alone', 'off'];
}

// Mémo d'un webhook : la fiche du destinataire, « e-mail · document · équipe/nom du document »
// (voir memoMatches). Le nom, lu chez Grist à l'approbation, perd ses « · » ; le mémo d'un webhook
// d'avant la 0.10.1 s'arrête à l'équipe.
const memoText = text => String(text || '').replace(/\s*·\s*/g, ' - ').trim();
export const hookMemo = ({ email, docId, team, docName }) => {
  const name = memoText(docName);
  return [email, docId, name ? `${team || ''}/${name}` : team].filter(Boolean).join(' · ');
};

// Fiche d'un destinataire à l'écran : son mémo, l'équipe suivie du nom du document. `docName` : le
// nom vu chez Grist au dernier contrôle (voir checkHooks), qui l'emporte sur celui du mémo (document
// renommé) et complète un mémo qui n'en a pas.
export function hookLabel(memo, docName = '') {
  const parts = String(memo || '').split(' · ').filter(Boolean);
  let at = parts.findIndex(p => p.includes('/'));
  if (at < 0 && parts.length === 3) at = 2;
  const place = at < 0 ? '' : parts[at];
  const team = place.split('/')[0];
  const name = memoText(docName) || place.slice(team.length + 1);
  const shown = [team, name].filter(Boolean).join('/');
  if (at < 0) return [...parts, shown].filter(Boolean).join(' · ');
  return parts.map((p, i) => (i === at ? shown : p)).filter(Boolean).join(' · ');
}

// Journal de retour d'un participant (webhook `hook`) : noté à l'approbation (`hook`) ; pour un
// Échange branché avant, retrouvé par le document de la fiche, cité dans le mémo du webhook.
export const ownJournal = hook => ({ note }) => note.hook === hook.id
  || (!note.hook && Boolean((note.from || {}).docId) && (hook.fields.memo || '').split(' · ').includes(note.from.docId));

// E-mail de la personne qui a créé l'export (colonne Sync_Par de ses lignes Synchro).
export const exportEmail = (rows, exportId) => (rows.find(r => r[EXPORT_COL] === exportId) || {})[AUTHOR_COL] || '';

// Destinataires d'un export : les webhooks sur Synchro dont la condition nomme cet export
// (`conditions` : texte de la condition par webhook).
export const hooksOf = (hooks, conditions, exportId) =>
  hooks.filter(h => h.fields.tableId === SYNC_TABLE && conditionExport(conditions.get(h.id)) === exportId);

// ---------------------------------------------------------------------------------------------
// Échange

// Côté CIBLE : ce que ce document renvoie à la SOURCE. Chaque destination (`entries` : tables de la
// note du journal) part avec les colonnes qui reçoivent une colonne de la SOURCE, chacune avec son
// nom là-bas (`as`). `columnsOf(table)` : ses colonnes envoyables.
export function exchangeTables(entries, columnsOf) {
  return entries.map((entry) => {
    const map = entry.map || {};
    const back = new Map([...new Set([...(entry.columns || []).map(c => c.id), ...Object.keys(map)])].map(id => [map[id] || id, id]));
    // Les fichiers ne vont, pour l'instant, que de la SOURCE vers la CIBLE.
    const columns = (columnsOf(entry.dest) || []).filter(c => !isFileColumn(c) && back.has(c.id)).map(c => ({ ...c, as: back.get(c.id) }));
    return { table: entry.dest, columns, filter: null };
  }).filter(tb => tb.columns.length);
}

// Export de retour d'un Échange, côté CIBLE : les destinations de la note du journal, avec leurs
// colonnes actuelles.
export const returnExportTables = (note, schema) => exchangeTables(note.tables, dest => exportableColumns(schema.columns(dest) || []));

// Côté SOURCE (journal de retour) : colonnes reçues de l'autre document gardées, et leur
// correspondance (colonne de l'autre document -> d'ici), lue dans leur nom ici (`as`) ; un choix
// noté dans `map` l'emporte. L'autre document n'écrit que les colonnes que l'export d'ici envoie
// pour cette table (`allowed`) : ni une colonne gardée pour soi, ni une colonne nouvelle.
export function exchangeColumns(sent, allowed, map = {}) {
  const target = c => map[c.id] || c.as || c.id;
  const kept = sent.filter(c => allowed.has(target(c)));
  return { sent: kept, map: Object.fromEntries(kept.map(c => [c.id, target(c)])) };
}
