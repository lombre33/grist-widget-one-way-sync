// Accès au document courant, avec les droits de la personne qui a ouvert la page, et tout ce que
// le widget envoie sur le réseau (ce fichier seul) :
//  - l'API des widgets (`grist.docApi`) : lecture des tables, écritures groupées ;
//  - l'API REST du document pour les webhooks et les pièces jointes, que l'API des widgets
//    n'expose pas, et pour des lectures légères (SQL, comparaison d'états), avec un jeton d'accès
//    court (`getAccessToken`) passé en paramètre `auth=` (voir authUrl) ;
//  - des requêtes anonymes à la même instance : écriture par la clé d'un formulaire (postRows),
//    fiche d'un partage (shareInfo), lecture d'un document public (publicAccess, publicRecords).
// Toutes passent par gristFetch, qui refuse une instance hors de la liste.
import { GRIST_ORIGINS } from './config.js';
import { maskKey, parseDocBaseUrl, parseWebhookUrl } from './logic/codes.js';
import { parseJson, toRows } from './logic/common.js';
import { readShare } from './logic/trust.js';

// Requête vers une instance Grist de la liste (config.js), jamais ailleurs, sans les cookies de
// la personne (le jeton, quand il en faut un, est dans l'adresse).
// Délais d'abandon : avis de fin envoyé juste avant d'effacer un webhook, fiche d'un partage.
const SHORT_MS = 10000;
const SHARE_MS = 15000;

async function gristFetch(url, options = {}) {
  if (!GRIST_ORIGINS.includes(new URL(url).origin)) throw new Error('otherInstance');
  return fetch(url, { ...options, credentials: 'omit' });
}

// Adresse REST du document courant suivie de `path`, avec un jeton d'accès court (lecture seule
// sauf `write`).
async function authUrl(path, { write = false } = {}) {
  const { token, baseUrl } = await grist.docApi.getAccessToken({ readOnly: !write });
  return `${baseUrl}${path}${path.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

export const fetchRows = async tableId => toRows(await grist.docApi.fetchTable(tableId));

export const apply = actions => (actions.length ? grist.docApi.applyUserActions(actions) : null);

// Instantané des métadonnées du document (tables et colonnes), lu en deux requêtes, et relu après
// une écriture qui change le schéma. Les tables de résumé et les tables cachées de Grist ne sont
// pas listées, mais `has` et `columns` les connaissent.
export async function readSchema() {
  const [tables, columns] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Tables_column')]);
  const byId = new Map(tables.map(tb => [tb.tableId, tb]));
  const colById = new Map(columns.map(c => [c.id, c]));
  return {
    tableIds: tables.filter(tb => !tb.summarySourceTable && !tb.tableId.startsWith('GristHidden')).map(tb => tb.tableId).sort(),
    has: tableId => byId.has(tableId),
    table: tableId => byId.get(tableId),
    // Nom exact d'une table nommée `tableId` aux majuscules près (Grist ne les distingue pas), ou null.
    resolve: tableId => (tables.find(tb => tb.tableId.toLowerCase() === String(tableId).toLowerCase()) || {}).tableId || null,
    // Nom actuel de la table de numéro `ref` (il change si on la renomme), ou null.
    tableIdOf: ref => (tables.find(tb => tb.id === ref) || {}).tableId || null,
    // Colonnes d'une table, dans l'ordre de leur création ; null si la table n'existe pas.
    // `visible` : colonne affichée d'une Référence, dans la table visée.
    columns(tableId) {
      const table = byId.get(tableId);
      if (!table) return null;
      return columns.filter(c => c.parentId === table.id).sort((x, y) => x.parentPos - y.parentPos).map(c => ({
        id: c.id, colId: c.colId, type: c.type, isFormula: c.isFormula, formula: c.formula, label: c.label, description: c.description,
        displayCol: c.displayCol, recalcWhen: c.recalcWhen, recalcDeps: c.recalcDeps,
        visible: (colById.get(c.visibleCol) || {}).colId || '',
      }));
    },
  };
}

// Identité du document, déduite de l'adresse REST du jeton : instance, équipe, identifiant, et
// l'adresse elle-même (`baseUrl`).
export async function docIdentity() {
  const { baseUrl } = await grist.docApi.getAccessToken({ readOnly: true });
  return { ...parseDocBaseUrl(baseUrl), baseUrl };
}

// La personne ne fait que lire le document : Grist le dit dans l'adresse du widget (`readonly`).
// Le nom du document, lui, n'est pas lisible : l'API REST refuse au jeton la fiche du document.
export const isReadOnly = () => new URLSearchParams(location.search).get('readonly') === 'true';

// Propriétaire du document : seul un propriétaire lit la liste des webhooks. Une réponse sûre est
// gardée pour la session ; une autre erreur (réseau, document rechargé) remonte, sans rien garder.
let owner = null;
export async function isOwner() {
  if (owner === null) {
    try {
      await listWebhooks();
      owner = true;
    } catch (e) {
      if (e.message !== 'ownerOnly') throw e;
      owner = false;
    }
  }
  return owner;
}

// Quelques colonnes d'une table, lues par l'API REST en SQL (jeton en lecture seule) : bien plus
// léger que fetchTable quand la table a de grosses cellules (lots de Synchro), pour une lecture
// répétée. `where` : { colonne: valeur } (des noms du widget, pas des valeurs lues ailleurs). Null
// si Grist refuse (droits, table absente) : lire alors la table entière.
export async function selectRows(tableId, colIds, where = {}) {
  try {
    const test = Object.entries(where).map(([c, v]) => `"${c}" = '${String(v).replace(/'/g, "''")}'`).join(' and ');
    const sql = `select ${['id', ...colIds].map(c => `"${c}"`).join(', ')} from "${tableId}"${test ? ` where ${test}` : ''}`;
    const response = await gristFetch(await authUrl(`/sql?q=${encodeURIComponent(sql)}`));
    return response.ok ? (await response.json()).records.map(r => r.fields) : null;
  } catch (e) {
    return null;
  }
}

// Contenu d'une pièce jointe du document (numéro dans _grist_Attachments).
export async function downloadAttachment(id) {
  const response = await gristFetch(await authUrl(`/attachments/${Number(id)}/download`));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Dépose un fichier dans le document, avec les droits de la personne ; rend son numéro.
export async function uploadAttachment(name, bytes) {
  const form = new FormData();
  form.append('upload', new Blob([bytes]), name);
  const response = await gristFetch(await authUrl('/attachments', { write: true }), {
    method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: form,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return (await response.json())[0];
}

// Ce qui a changé dans le document depuis l'état `since` (empreinte d'une action de son
// historique) : l'état actuel (`hash`) et les tables touchées, lignes ou colonnes (`tables` ; null
// si `since` est vide ou sorti de l'historique, si une table a été renommée, ou si Grist n'a pas
// pu répondre). Lu par la comparaison de deux états de Grist (GET /compare, quelques
// millisecondes ; une valeur au plus par colonne revient). Null si Grist refuse : la comparaison
// est réservée à qui peut lire tout le document.
export async function docChanges(since) {
  const read = async left => gristFetch(await authUrl(`/compare?left=${encodeURIComponent(left)}&right=HEAD&maxRows=1`));
  try {
    let response = await read(since || 'HEAD');
    if ([401, 403].includes(response.status)) return null;
    if (!response.ok && since) response = await read('HEAD');
    if (!response.ok) return response.status === 404 ? null : { hash: since, tables: null };
    const { right, details } = await response.json();
    const delta = (details || {}).rightChanges;
    const known = since && delta && !(delta.tableRenames || []).length;
    return { hash: right.h, tables: known ? new Set(Object.keys(delta.tableDeltas || {})) : null };
  } catch (e) {
    return { hash: since, tables: null };
  }
}

// Une seule exécution à la fois de `fn` sous ce nom, tous onglets du navigateur confondus.
export const withLock = (name, fn) => (navigator.locks ? navigator.locks.request(name, fn) : fn());

// ---------------------------------------------------------------------------------------------
// Webhooks (propriétaires du document seulement : Grist refuse sinon en 403)

async function rest(method, path, body) {
  const response = await gristFetch(await authUrl(path, { write: true }), {
    method,
    // Grist exige l'un de ces en-têtes pour toute écriture sans cookie (protection CSRF).
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    // Une erreur de Grist peut citer l'adresse d'un webhook : sa clé n'est jamais montrée en entier.
    const error = new Error(response.status === 403 ? 'ownerOnly' : maskKey(`HTTP ${response.status} ${text.slice(0, 200)}`));
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

export const listWebhooks = async () => (await rest('GET', '/webhooks')).webhooks;

// Un webhook par destinataire, sur la table Synchro, filtré par `condition` (formule évaluée par
// Grist sur chaque ligne : seules celles de l'export partent). Grist accepte les conditions depuis
// la version 1.7.11 : une instance plus ancienne refuse le champ, ou l'ignore ; le widget vérifie
// donc la condition enregistrée et efface le webhook si elle manque (il recevrait tout).
export async function createWebhook({ name, memo, url, tableId, condition }) {
  let result;
  try {
    result = await rest('POST', '/webhooks', {
      webhooks: [{ fields: { name, memo, url, tableId, condition, eventTypes: ['add', 'update'], enabled: true, isReadyColumn: null } }],
    });
  } catch (e) {
    if (/condition/i.test(e.message)) throw new Error('gristTooOld');
    throw e;
  }
  const id = result.webhooks[0].id;
  if ((await webhookConditions()).get(id) !== condition) {
    await deleteWebhook(id).catch(() => {});
    throw new Error('gristTooOld');
  }
  return id;
}

// Condition de chaque webhook du document (texte de la formule), par identifiant de webhook :
// lue dans _grist_Triggers, où Grist garde aussi l'identifiant de chaque webhook.
export async function webhookConditions() {
  const conditions = new Map();
  for (const trigger of await fetchRows('_grist_Triggers')) {
    const text = (parseJson(trigger.condition || '{}') || {}).text || '';
    const actions = parseJson(trigger.actions || '[]');
    for (const action of Array.isArray(actions) ? actions : []) if (action && action.type === 'webhook') conditions.set(action.id, text);
  }
  return conditions;
}

export const setWebhookEnabled = (id, enabled) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, { enabled });
export const renameWebhook = (id, name) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, { name });
export const deleteWebhook = id => rest('DELETE', `/webhooks/${encodeURIComponent(id)}`);

// Envoi direct de lignes à une adresse d'écriture (clé d'un formulaire publié : elle n'accepte
// qu'un ajout de lignes, sans identifiant), comme le webhook les enverrait. Écriture anonyme en
// JSON : l'en-tête Content-Type suffit à Grist. Une erreur cite le début de la réponse, jamais la clé.
export async function postRows(url, rows, timeout = 60000) {
  const response = await gristFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(maskKey(`HTTP ${response.status} ${(await response.text()).slice(0, 120)}`));
}
export const postToHook = (h, rows, timeout) => postRows(h.fields.url, rows, timeout);

// Webhook effacé après un dernier envoi direct à son adresse. Un lien déjà mort ou trop lent ne
// retient pas l'effacement.
export async function deleteWebhookWithNotice(h, rows) {
  await postToHook(h, rows, SHORT_MS).catch(() => {});
  await deleteWebhook(h.id);
}
export const clearWebhookQueue = () => rest('DELETE', '/webhooks/queue');

// Document que désigne l'adresse d'écriture `url` (clé d'un formulaire publié), lu chez Grist par
// une requête anonyme : nom, dossier, équipe, identifiant (voir readShare). Null si la clé n'existe
// pas (lien coupé) ; une erreur si Grist ne répond pas.
export async function shareInfo(url) {
  const target = parseWebhookUrl(url);
  if (!target) return null;
  const response = await gristFetch(`${target.origin}${target.prefix}/api/s/${target.key}`, { signal: AbortSignal.timeout(SHARE_MS) });
  if (response.status === 404 || response.status === 403) return null;
  if (!response.ok) throw new Error('shareUnreadable');
  const info = readShare(await response.json().catch(() => null));
  if (!info) throw new Error('shareUnreadable');
  return info;
}

// ---------------------------------------------------------------------------------------------
// Document public (lien public), lu sans identifiant

// Droit du lien public du document d'adresse REST `base` : 'viewers', 'editors' (s'il a été réglé
// sur Éditeur), '' s'il n'est pas public, ou null quand la réponse ne permet pas de le dire
// (réseau, serveur occupé).
export async function publicAccess(base) {
  try {
    const response = await gristFetch(base);
    if (response.ok) return String(((await response.json().catch(() => null)) || {}).access || 'viewers');
    return [401, 403, 404].includes(response.status) ? '' : null;
  } catch (e) {
    return null;
  }
}

// Lignes d'une table d'un document public (`filter` : { colonne: [valeurs] }). Une erreur
// 'publicClosed' si Grist refuse ou ne répond pas.
export async function publicRecords(base, tableId, filter) {
  const query = encodeURIComponent(JSON.stringify(filter));
  const response = await gristFetch(`${base}/tables/${tableId}/records?filter=${query}`).catch(() => null);
  if (!response || !response.ok) throw new Error('publicClosed');
  return (await response.json()).records || [];
}
