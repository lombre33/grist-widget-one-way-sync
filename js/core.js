// Logique pure de la synchro : ni DOM, ni `grist`, ni réseau. Tout ce qui décide (quelle
// version gagne, quoi écrire, quelle adresse accepter, quelles colonnes posent problème) est
// ici, testé par `tests/unit/core.test.mjs`. Les autres modules lisent Grist, appellent ces
// fonctions et appliquent le résultat.

export const CONFIG_TABLE = 'Synchro_Config';
export const RECIPIENTS_TABLE = 'Synchro_Destinataires';
export const KEY_COL = 'id_sync';
export const ORDER_COL = 'MajLe';
export const DELETE_COL = 'Supprime';
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

// Colonnes recopiées : colonnes de données présentes des deux côtés, hors colonnes techniques de
// la synchro et formules de la destination. La destination ne garde que la clé `id_sync`.
export function copyColumns(journalCols, destCols) {
  const skip = new Set(['id', 'manualSort', KEY_COL, ORDER_COL, DELETE_COL]);
  const writable = new Set(destCols.filter(c => !c.isFormula).map(c => c.colId));
  return journalCols.map(c => c.colId).filter(id => !skip.has(id) && !id.startsWith('gristHelper_') && writable.has(id));
}

// Actions qui amènent la destination à la dernière version de chaque clé reçue depuis le
// dernier passage. `seen` est le plus grand numéro de ligne du Journal déjà traité (noté dans
// Synchro_Config, que la clé du formulaire ne peut pas écrire) : une clé n'est réécrite que si
// sa dernière version est arrivée après. Une retouche manuelle survit donc jusqu'à la prochaine
// modification côté SOURCE, et rejouer le même plan ne change rien (idempotent).
export function planConsolidation({ journalRows, destRows, copyCols, destTable, seen = 0 }) {
  const destByKey = new Map();
  for (const row of destRows) {
    if (isBlank(row[KEY_COL])) continue;
    if (!destByKey.has(row[KEY_COL])) destByKey.set(row[KEY_COL], []);
    destByKey.get(row[KEY_COL]).push(row);
  }

  const upserts = [];
  const removeIds = [];
  const stats = { added: 0, updated: 0, removed: 0 };
  for (const [key, version] of latestByKey(journalRows)) {
    if (version.id <= seen) continue;
    const existing = destByKey.get(key) || [];
    if (isTrue(version.row[DELETE_COL])) {
      if (existing.length) { removeIds.push(...existing.map(r => r.id)); stats.removed++; }
      continue;
    }
    stats[existing.length ? 'updated' : 'added']++;
    upserts.push(version);
  }

  const actions = chunk(upserts).map(part => {
    const values = {};
    for (const col of copyCols) values[col] = part.map(v => v.row[col] ?? null);
    return ['BulkAddOrUpdateRecord', destTable, { [KEY_COL]: part.map(v => v.row[KEY_COL]) }, values, { on_many: 'all' }];
  });
  for (const part of chunk(removeIds)) actions.push(['BulkRemoveRecord', destTable, part]);
  const lastId = journalRows.reduce((max, r) => Math.max(max, r.id), seen);
  return { actions, stats, seen: lastId };
}

// Nettoyage du Journal, fait à chaque passage : les versions remplacées par une plus récente et
// les lignes sans clé (test du lien) disparaissent. Restent la dernière version de chaque clé
// (suppression comprise) et la ligne la plus récente du Journal, pour que Grist ne réutilise pas
// son numéro (voir `seen`).
export function planPurge(journalRows, journalTable) {
  const keep = new Set([...latestByKey(journalRows).values()].map(v => v.id));
  keep.add(journalRows.reduce((max, r) => Math.max(max, r.id), 0));
  const ids = journalRows.filter(r => !keep.has(r.id)).map(r => r.id);
  return chunk(ids).map(part => ['BulkRemoveRecord', journalTable, part]);
}

// ---------------------------------------------------------------------------------------------
// SOURCE : contrôle de la table envoyée

// Type de la colonne du Journal. Une Référence arrive comme un numéro de ligne de la SOURCE.
function journalType(type) {
  if (type.startsWith('Ref:')) return 'Int';
  if (type.startsWith('RefList:')) return 'Any';
  return type;
}

// `cols` : colonnes de _grist_Tables_column (id, colId, type, displayCol, rules). Renvoie les
// colonnes envoyées par le webhook et les problèmes, sous forme de codes traduits par l'écran.
export function checkSourceColumns(cols) {
  const sent = [];
  const problems = [];
  for (const col of cols) {
    if (col.colId === 'manualSort') continue;
    if (col.colId.startsWith('gristHelper_')) {
      const owner = cols.find(o => o.displayCol === col.id || (o.rules || []).includes(col.id));
      const code = col.colId.startsWith('gristHelper_Display') ? 'helperDisplay' : 'helperRule';
      problems.push({ code, blocking: true, colId: owner ? owner.colId : col.colId });
    } else if (col.type === 'Attachments') {
      problems.push({ code: 'attachments', blocking: true, colId: col.colId });
    } else {
      if (col.type.startsWith('Ref')) problems.push({ code: 'reference', blocking: false, colId: col.colId });
      sent.push(col);
    }
  }
  const missing = [KEY_COL, ORDER_COL, DELETE_COL].filter(id => !sent.some(c => c.colId === id));
  return { sent, problems, missing };
}

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

export function buildInvitation({ name, table, columns, secret, origin }) {
  return encodeCode({
    kind: 'invitation', name, table, origin, secret,
    columns: columns.map(c => ({ id: c.colId, type: journalType(c.type), label: c.label || c.colId })),
  });
}

export function parseInvitation(text) {
  const inv = decodeCode(text, 'invitation');
  const ok = typeof inv.name === 'string' && COL_ID.test(inv.table) && SECRET.test(inv.secret) &&
    Array.isArray(inv.columns) && inv.columns.length > 0 &&
    inv.columns.every(c => c && COL_ID.test(c.id) && typeof c.type === 'string' && /^[A-Za-z:_0-9]+$/.test(c.type)) &&
    [KEY_COL, ORDER_COL, DELETE_COL].every(id => inv.columns.some(c => c.id === id));
  if (!ok) throw new Error('codeInvalid');
  return inv;
}

export function buildReply({ url, secret, recipient }) {
  return encodeCode({ kind: 'reponse', url, secret, recipient });
}

// `sourceOrigin` : origine de l'instance du document SOURCE. Le webhook ne part que vers la même
// instance, à une adresse d'écriture par clé de formulaire, rien d'autre.
export function parseReply(text, sourceOrigin) {
  const reply = decodeCode(text, 'reponse');
  const target = parseWebhookUrl(reply.url);
  if (!target || !target.flat || !SECRET.test(reply.secret) || !reply.recipient || typeof reply.recipient !== 'object') {
    throw new Error('codeInvalid');
  }
  if (target.origin !== sourceOrigin) throw new Error('otherInstance');
  const r = reply.recipient;
  const recipient = Object.fromEntries(['email', 'docId', 'team', 'journal', 'at'].map(k => [k, String(r[k] ?? '').slice(0, 200)]));
  return { url: reply.url, secret: reply.secret, recipient };
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
