// Logique pure de la synchro : ni DOM, ni `grist`, ni réseau. Tout ce qui décide (quelle
// version gagne, quoi écrire, quelle adresse accepter, quelles colonnes posent problème) est
// ici, testé par `tests/unit/core.test.mjs`. Les autres modules lisent Grist, appellent ces
// fonctions et appliquent le résultat.

export const KEY_COL = 'id_sync';
export const ORDER_COL = 'MajLe';
export const DELETE_COL = 'Supprime';
export const LIST_COL = 'Synchro_Ids'; // liste des clés existantes, envoyée par la SOURCE
export const APPLIED_COL = 'Sync_Applique'; // version déjà recopiée dans la destination
export const AUTHOR_COL = 'Sync_Par'; // e-mail de la personne qui a ajouté la ligne (user.Email)
export const RECEIVED_COL = 'Sync_Recu'; // date d'arrivée de la ligne dans le Journal (NOW())
export const STATE_COL = 'Sync_Etat'; // effet de la version recopiée : ajout, modif, suppression
export const DATA_COL = 'Synchro_Donnees'; // colonnes envoyées, en un bloc JSON (vue d'export)
export const SCHEMA_COL = 'Synchro_Colonnes'; // colonnes envoyées : [{ id, type, label }] en JSON
export const GROUP_COL = 'group'; // colonne propre aux tables de résumé, envoyée par le webhook
const LIST_PREFIX = 'ids:';
const CODE_PREFIX = 'GRISTSYNC1.';
export const CHUNK = 500; // lignes par action : sous la file de 1000 événements des webhooks

// ---------------------------------------------------------------------------------------------
// Utilitaires

// fetchTable renvoie des colonnes ({id: [...], Nom: [...]}) : on travaille en lignes.
export function toRows(columnar) {
  if (!columnar || !Array.isArray(columnar.id)) return [];
  const cols = Object.keys(columnar);
  return columnar.id.map((_, i) => Object.fromEntries(cols.map(c => [c, columnar[c][i]])));
}

export function chunk(items, size = CHUNK) {
  const parts = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function isTrue(value) {
  return value === true || value === 1 || (typeof value === 'string' && ['true', 'oui', 'vrai', '1'].includes(value.trim().toLowerCase()));
}

// Identifiant de table Grist valide à partir d'un nom libre.
export function toTableId(name, fallback = 'Table') {
  let id = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
  if (/^[0-9]/.test(id)) id = 'T_' + id;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// ---------------------------------------------------------------------------------------------
// Versions : (valeur de MajLe, numéro de ligne du Journal). Vide = plus ancien ; à égalité
// d'horodatage, la dernière ligne arrivée gagne.

function compareOrder(a, b) {
  if (isBlank(a) || isBlank(b)) return (isBlank(a) ? 0 : 1) - (isBlank(b) ? 0 : 1);
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function compareVersion(a, b) {
  return compareOrder(a.order, b.order) || Math.sign((a.id || 0) - (b.id || 0));
}

// Dernière version de chaque clé du Journal. Les lignes sans clé (test, saisie manuelle) sont
// ignorées.
export function latestByKey(journalRows) {
  const latest = new Map();
  for (const row of journalRows) {
    const key = row[KEY_COL];
    if (isBlank(key)) continue;
    const version = { order: row[ORDER_COL], id: row.id, row };
    const current = latest.get(key);
    if (!current || compareVersion(version, current) > 0) latest.set(key, version);
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------
// Consolidation Journal -> table de destination

// Colonnes recopiées, en couples [colonne du Journal, colonne de la destination] : colonnes de
// données présentes des deux côtés (sous le nom choisi dans `map`, sinon le même), hors colonnes
// techniques de la synchro et formules de la destination. La destination ne garde que `id_sync`.
export function copyColumns(journalCols, destCols, map = {}) {
  const skip = new Set(['id', 'manualSort', KEY_COL, ORDER_COL, DELETE_COL, LIST_COL, APPLIED_COL, AUTHOR_COL, RECEIVED_COL, STATE_COL, DATA_COL, SCHEMA_COL, GROUP_COL]);
  const writable = new Set(destCols.filter(c => !c.isFormula).map(c => c.colId));
  return journalCols.map(c => c.colId).filter(id => !skip.has(id) && !id.startsWith('gristHelper_'))
    .map(id => [id, map[id] || id]).filter(([, to]) => writable.has(to) && to !== KEY_COL);
}

// Lignes du Journal avec leurs colonnes envoyées dépliées (bloc JSON de la vue d'export). Une
// liste devient une ChoiceList au format de Grist. Un Journal d'avant la vue d'export n'a pas de
// bloc : ses lignes restent telles quelles.
export function expandRows(journalRows) {
  return journalRows.map((row) => {
    if (isBlank(row[DATA_COL])) return row;
    let data;
    try { data = JSON.parse(row[DATA_COL]); } catch (e) { return row; }
    if (!data || typeof data !== 'object') return row;
    const values = Object.fromEntries(Object.entries(data).filter(([k]) => COL_ID.test(k))
      .map(([k, v]) => [k, Array.isArray(v) ? ['L', ...v] : v]));
    return { ...values, ...row };
  });
}

// Colonnes envoyées d'après la dernière liste reçue (la SOURCE y met la description de sa vue
// d'export), sinon `fallback` (celles de l'invitation).
export function sentColumns(journalRows, fallback = []) {
  const list = latestList(journalRows);
  try {
    const cols = JSON.parse((list && list[SCHEMA_COL]) || 'null');
    if (validColumns(cols)) return cols;
  } catch (e) { /* liste sans description */ }
  return fallback;
}

// Dernière liste des clés reçue (ligne du Journal sans clé, colonne Synchro_Ids).
function latestList(journalRows) {
  let latest = null;
  for (const row of journalRows) {
    if (String(row[LIST_COL] || '').startsWith(LIST_PREFIX) && (!latest || row.id > latest.id)) latest = row;
  }
  return latest;
}

// Actions qui amènent la destination à l'état de la SOURCE, en un seul lot :
//  - la dernière version de chaque clé, si elle n'a pas encore été recopiée ; une clé inconnue
//    de la destination peut y reprendre une ligne existante sans clé de même valeur dans la
//    colonne `matchCol` (rattachement d'un référentiel déjà rempli) ;
//  - la suppression des lignes cochées `Supprime`, ou absentes de la dernière liste des clés
//    (ligne effacée dans la SOURCE) quand aucune version plus récente n'est arrivée depuis ;
//  - le marquage des versions et de la liste traitées (`Sync_Applique`) et de leur effet
//    (`Sync_Etat`), pour l'historique ; une suppression venue de la liste est notée sur la
//    dernière version de la clé, à la date d'arrivée de la liste.
// Une retouche manuelle survit donc jusqu'à la prochaine modification côté SOURCE, et rejouer le
// plan après application ne change rien (idempotent).
export function planConsolidation({ journalRows, destRows, copyCols, destTable, journalTable, matchCol = '' }) {
  const destByKey = new Map();
  const unkeyed = new Map(); // valeur de matchCol -> lignes de la destination sans clé
  for (const row of destRows) {
    if (isBlank(row[KEY_COL])) {
      if (!matchCol || isBlank(row[matchCol])) continue;
      if (!unkeyed.has(row[matchCol])) unkeyed.set(row[matchCol], []);
      unkeyed.get(row[matchCol]).push(row);
      continue;
    }
    if (!destByKey.has(row[KEY_COL])) destByKey.set(row[KEY_COL], []);
    destByKey.get(row[KEY_COL]).push(row);
  }
  const matchFrom = (copyCols.find(([, to]) => to === matchCol) || [])[0];
  const latest = latestByKey(journalRows);
  const list = latestList(journalRows);
  const marks = new Map(); // ligne du Journal -> effet ('' pour la liste ou une version sans effet)
  const listGone = [];
  const gone = new Set();
  if (list && !isTrue(list[APPLIED_COL])) {
    const present = new Set(String(list[LIST_COL]).slice(LIST_PREFIX.length).split(' ').filter(Boolean));
    for (const key of destByKey.keys()) {
      const version = latest.get(key);
      if (present.has(key) || (version && version.id > list.id)) continue;
      gone.add(key);
      if (version) listGone.push(version.id);
    }
    marks.set(list.id, '');
  }

  const upserts = [];
  const attached = []; // [ligne de la destination, version]
  const stats = { added: 0, updated: 0, removed: 0 };
  for (const [key, version] of latest) {
    if (isTrue(version.row[APPLIED_COL])) continue;
    if (isTrue(version.row[DELETE_COL])) gone.add(key);
    if (gone.has(key)) {
      marks.set(version.id, destByKey.has(key) ? 'suppression' : '');
      continue;
    }
    const candidates = !destByKey.has(key) && matchFrom ? unkeyed.get(version.row[matchFrom]) : null;
    if (candidates && candidates.length) {
      attached.push([candidates.shift(), version]);
      marks.set(version.id, 'modif');
      stats.updated++;
      continue;
    }
    marks.set(version.id, destByKey.has(key) ? 'modif' : 'ajout');
    stats[destByKey.has(key) ? 'updated' : 'added']++;
    upserts.push(version);
  }
  const removeIds = [];
  for (const key of gone) {
    if (!destByKey.has(key)) continue;
    removeIds.push(...destByKey.get(key).map(r => r.id));
    stats.removed++;
  }

  const values = (versions) => {
    const out = {};
    for (const [from, to] of copyCols) out[to] = versions.map(v => v.row[from] ?? null);
    return out;
  };
  const actions = chunk(upserts).map(part =>
    ['BulkAddOrUpdateRecord', destTable, { [KEY_COL]: part.map(v => v.row[KEY_COL]) }, values(part), { on_many: 'all' }]);
  for (const part of chunk(attached)) {
    actions.push(['BulkUpdateRecord', destTable, part.map(([row]) => row.id),
      { [KEY_COL]: part.map(([, v]) => v.row[KEY_COL]), ...values(part.map(([, v]) => v)) }]);
  }
  for (const part of chunk(removeIds)) actions.push(['BulkRemoveRecord', destTable, part]);
  for (const part of chunk([...marks])) {
    actions.push(['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [APPLIED_COL]: part.map(() => true), [STATE_COL]: part.map(([, state]) => state) }]);
  }
  for (const part of chunk(listGone)) {
    actions.push(['BulkUpdateRecord', journalTable, part,
      { [STATE_COL]: part.map(() => 'suppression'), [RECEIVED_COL]: part.map(() => list[RECEIVED_COL] ?? null) }]);
  }
  return { actions, stats };
}

// Nettoyage du Journal, dans le même lot : restent la dernière version de chaque clé et la
// dernière liste (avec leur marque `Sync_Applique`), et la ligne la plus récente, pour que Grist ne
// réutilise pas son numéro. Le reste (versions remplacées, test du lien) disparaît.
export function planPurge(journalRows, journalTable) {
  const keep = new Set([...latestByKey(journalRows).values()].map(v => v.id));
  const list = latestList(journalRows);
  if (list) keep.add(list.id);
  keep.add(journalRows.reduce((max, r) => Math.max(max, r.id), 0));
  const ids = journalRows.filter(r => !keep.has(r.id)).map(r => r.id);
  return chunk(ids).map(part => ['BulkRemoveRecord', journalTable, part]);
}

// Historique : dernière version de chaque clé recopiée avec un effet, arrivée après `since`
// (secondes), la plus récente d'abord, au plus `max`. `labelCol` nomme la ligne.
export function recentChanges(journalRows, labelCol, since, max) {
  return [...latestByKey(journalRows).values()]
    .map(v => ({ at: v.row[RECEIVED_COL] ?? v.order, state: v.row[STATE_COL], row: v.row }))
    .filter(c => c.state && typeof c.at === 'number' && c.at > since)
    .sort((a, b) => b.at - a.at).slice(0, max)
    .map(c => ({ at: c.at, label: labelCol ? String(c.row[labelCol] ?? '') : '', state: c.state }));
}

// Table de la SOURCE qui envoie la liste des clés existantes : une ligne, une formule recalculée
// à chaque ajout ou suppression dans `tableId` (pas à une simple modification).
export const listTableId = tableId => `Synchro_${tableId}`;
export const listFormula = tableId => `"${LIST_PREFIX}" + " ".join(${tableId}.all.${KEY_COL})`;

// ---------------------------------------------------------------------------------------------
// SOURCE : contrôle de la table envoyée

// Vue d'export : table de résumé de la table SOURCE par `id_sync`, mise à jour par Grist seul.
// Le webhook la surveille : elle n'a que la clé, la date, la case de suppression et les colonnes
// choisies, en un bloc JSON. Changer les colonnes ne change donc jamais ce que reçoit le Journal.
export const exportTableId = tableId => `${tableId}_summary_${KEY_COL}`;
export const masterTableId = exportId => exportId.replace(new RegExp(`_summary_${KEY_COL}$`), '');

// Colonnes qu'une table SOURCE peut envoyer : toutes ses colonnes de données et formules, hors
// colonnes de la synchro et colonnes internes de Grist. Les pièces jointes ne peuvent pas partir
// (`blocked`). Une Référence part comme le texte qu'elle affiche.
export function exportableColumns(cols) {
  const skip = new Set(['manualSort', KEY_COL, ORDER_COL, DELETE_COL]);
  return cols.filter(c => !skip.has(c.colId) && !c.colId.startsWith('gristHelper_')).map(c => ({
    id: c.colId, label: c.label || c.colId, type: /^Ref(List)?:/.test(c.type) ? 'Text' : c.type, source: c.type,
    visible: c.visible || '', blocked: c.type === 'Attachments',
  }));
}

// Description des colonnes envoyées, telle que la CIBLE la reçoit.
export const exportSchema = columns => columns.map(({ id, type, label }) => ({ id, type, label }));

// Formule du bloc JSON. Chaque valeur est lue à part : une cellule en erreur part vide sans
// bloquer les autres. Dates en secondes (format de Grist), Référence par son texte affiché.
export function exportFormula(columns) {
  const read = (c) => {
    if (c.source.startsWith('RefList:')) return `", ".join(str(${c.visible ? `x.${c.visible}` : 'x.id'}) for x in r.${c.id})`;
    if (c.source.startsWith('Ref:')) return c.visible ? `r.${c.id}.${c.visible}` : `r.${c.id}.id`;
    return `r.${c.id}`;
  };
  return [
    'import json, datetime',
    'if not $group: return ""',
    'r = $group[0]',
    'def v(x):',
    '  if isinstance(x, datetime.datetime): return x.timestamp()',
    '  if isinstance(x, datetime.date): return (x - datetime.date(1970, 1, 1)).days * 86400',
    '  if isinstance(x, (list, tuple)): return [v(y) for y in x]',
    '  return x if x is None or isinstance(x, (str, int, float, bool)) else str(x)',
    'def g(f):',
    '  try: return v(f())',
    '  except Exception: return None',
    `return json.dumps({${columns.map(c => `"${c.id}": g(lambda: ${read(c)})`).join(', ')}}, ensure_ascii=False)`,
  ].join('\n');
}

// Actions qui créent les colonnes de la vue d'export (créée juste avant par Grist, avec `count`).
export const exportColumnsActions = exportId => [
  ['RemoveColumn', exportId, 'count'],
  ['AddColumn', exportId, ORDER_COL, { type: 'DateTime:UTC', isFormula: true, formula: `max($group.${ORDER_COL})` }],
  ['AddColumn', exportId, DELETE_COL, { type: 'Bool', isFormula: true, formula: `any($group.${DELETE_COL})` }],
  ['AddColumn', exportId, DATA_COL, { type: 'Text', isFormula: true, formula: '""' }],
];

// Colonnes de la synchro qui manquent à la table SOURCE.
export const missingSyncColumns = cols => [KEY_COL, ORDER_COL, DELETE_COL].filter(id => !cols.some(c => c.colId === id));

// id_sync : UUID posé à la création. MajLe : NOW() à toute modification. Supprime : case à
// cocher de suppression logique (Grist n'envoie pas les suppressions).
export function prepareSourceActions(tableId, missing) {
  const specs = {
    [KEY_COL]: { type: 'Text', isFormula: false, formula: 'UUID()', recalcWhen: 0 },
    [ORDER_COL]: { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 2 },
    [DELETE_COL]: { type: 'Bool', isFormula: false },
  };
  return missing.map(colId => ['AddColumn', tableId, colId, specs[colId]]);
}

// Une formule de déclenchement ajoutée après coup laisse les lignes existantes vides (vérifié).
export function fillKeyActions(tableId, rows, newId) {
  const empty = rows.filter(r => isBlank(r[KEY_COL])).map(r => r.id);
  return chunk(empty).map(ids => ['BulkUpdateRecord', tableId, ids, { [KEY_COL]: ids.map(() => newId()) }]);
}

// ---------------------------------------------------------------------------------------------
// Codes échangés entre SOURCE et CIBLE : préfixe + JSON en base64url, sur une ligne.

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
}

function encodeCode(payload) {
  return CODE_PREFIX + toBase64Url(JSON.stringify(payload));
}

export function decodeCode(text, kind) {
  const raw = String(text || '').trim();
  if (!raw.startsWith(CODE_PREFIX)) throw new Error('codeFormat');
  let payload;
  try { payload = JSON.parse(fromBase64Url(raw.slice(CODE_PREFIX.length))); } catch (e) { throw new Error('codeFormat'); }
  if (!payload || payload.kind !== kind) throw new Error(kind === 'invitation' ? 'notInvitation' : 'notReply');
  return payload;
}

const COL_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET = /^[0-9a-f]{32}$/;

// Une invitation porte une ou plusieurs tables. `id` la désigne dans la réponse ; `secret`,
// facultatif et choisi à la création, prouve que la réponse vient de quelqu'un qui l'a reçue (la
// SOURCE n'en garde que l'empreinte).
export function buildInvitation({ id, name, origin, secret = '', from = {}, tables }) {
  return encodeCode({
    kind: 'invitation', id, name, origin, secret, from,
    tables: tables.map(({ table, columns }) => ({
      table, columns: exportSchema(columns),
    })),
  });
}

const INVITATION_ID = /^[0-9a-f]{16}$/;
function validColumns(cols) {
  return Array.isArray(cols) && cols.length > 0 && new Set(cols.map(c => c && c.id)).size === cols.length &&
    cols.every(c => c && COL_ID.test(c.id) && typeof c.type === 'string' && /^[A-Za-z:_0-9]+$/.test(c.type));
}

export function parseInvitation(text) {
  const inv = decodeCode(text, 'invitation');
  const ok = INVITATION_ID.test(inv.id) && typeof inv.name === 'string' && (!inv.secret || SECRET.test(inv.secret)) &&
    Array.isArray(inv.tables) && inv.tables.length > 0 && inv.tables.every(tb => tb && COL_ID.test(tb.table) && validColumns(tb.columns)) &&
    new Set(inv.tables.map(tb => tb.table)).size === inv.tables.length;
  if (!ok) throw new Error('codeInvalid');
  const from = inv.from && typeof inv.from === 'object' ? inv.from : {};
  return { ...inv, from: { email: String(from.email || '').slice(0, 200), docId: String(from.docId || '').slice(0, 200) } };
}

// `links` : pour chaque table SOURCE, l'adresse d'écriture de son Journal dans la CIBLE.
export function buildReply({ id, secret = '', recipient, links }) {
  return encodeCode({ kind: 'reponse', id, secret, recipient, links });
}

// `sourceOrigin` : origine de l'instance du document SOURCE. Les webhooks ne partent que vers la
// même instance, à des adresses d'écriture par clé de formulaire, rien d'autre.
export function parseReply(text, sourceOrigin) {
  const reply = decodeCode(text, 'reponse');
  const links = Array.isArray(reply.links) ? reply.links : [];
  const targets = links.map(l => l && COL_ID.test(l.table) && parseWebhookUrl(l.url));
  if (!INVITATION_ID.test(reply.id) || (reply.secret && !SECRET.test(reply.secret)) || !links.length ||
      targets.some(tg => !tg || !tg.flat) || !reply.recipient || typeof reply.recipient !== 'object') {
    throw new Error('codeInvalid');
  }
  if (targets.some(tg => tg.origin !== sourceOrigin)) throw new Error('otherInstance');
  const r = reply.recipient;
  const recipient = Object.fromEntries(['email', 'docId', 'team', 'at'].map(k => [k, String(r[k] ?? '').slice(0, 200)]));
  return { id: reply.id, secret: reply.secret || '', recipient, links: links.map(l => ({ table: l.table, url: l.url })) };
}

// ---------------------------------------------------------------------------------------------
// Adresses

// Lien « Copier le lien » d'un formulaire publié : https://<instance>[/o/<équipe>]/forms/<clé>/<n>
export function parseFormLink(link) {
  let url;
  try { url = new URL(String(link || '').trim()); } catch (e) { return null; }
  const m = url.pathname.match(/^((?:\/o\/[^/]+)?)\/forms\/([A-Za-z0-9]+)\/\d+\/?$/);
  return m && /^https?:$/.test(url.protocol) ? { origin: url.origin, prefix: m[1], key: m[2] } : null;
}

export function buildWebhookUrl(formLink, journalTable) {
  const form = parseFormLink(formLink);
  return form && COL_ID.test(journalTable) ? `${form.origin}${form.prefix}/api/s/${form.key}/tables/${journalTable}/records?flat=1` : null;
}

export function parseWebhookUrl(text) {
  let url;
  try { url = new URL(String(text || '')); } catch (e) { return null; }
  const m = url.pathname.match(/^((?:\/o\/[^/]+)?)\/api\/s\/([A-Za-z0-9]+)\/tables\/([A-Za-z_][A-Za-z0-9_]*)\/records$/);
  if (!m || !/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  return { origin: url.origin, prefix: m[1], key: m[2], table: m[3], flat: url.search === '?flat=1' };
}

// La clé de partage est un droit d'écriture : on ne l'affiche jamais en entier.
export function maskKey(url) {
  return String(url || '').replace(/\/api\/s\/([A-Za-z0-9]{4})[A-Za-z0-9]*/, '/api/s/$1…');
}

// `baseUrl` renvoyé par getAccessToken : https://<instance>[/o/<équipe>]/api/docs/<docId>
export function parseDocBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const m = url.pathname.match(/^(?:\/o\/([^/]+))?\/api\/docs\/([^/]+)\/?$/);
  return { origin: url.origin, team: m ? m[1] || '' : '', docId: m ? m[2] : '' };
}
