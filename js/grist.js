// Accès au document courant, avec les droits de la personne qui a ouvert la page, et tout ce que
// le widget envoie sur le réseau (ce fichier seul) :
//  - l'API des widgets (`grist.docApi`) : lecture des tables, écritures groupées ;
//  - l'API REST du document pour les webhooks et les pièces jointes, que l'API des widgets
//    n'expose pas, et pour des lectures légères (SQL, comparaison d'états), avec un jeton d'accès
//    court (`getAccessToken`) passé en paramètre `auth=` (voir authUrl) ;
//  - des requêtes anonymes à la même instance : écriture par la clé d'un formulaire (postRows),
//    fiche d'un partage (shareInfo), lecture d'un document public (publicAccess, publicRecords).
// Toutes passent par gristFetch, qui refuse une instance hors de la liste.
//
// Les requêtes elles-mêmes (webhooks, comparaison d'états, SQL, envois directs, pièces jointes) sont
// écrites une seule fois, dans le moteur (engine/rest-port.js) ; ce fichier ne leur donne que `http` :
// le jeton, la liste des instances, le délai d'abandon.
import { GRIST_ORIGINS } from './config.js';
import { parseDocBaseUrl } from './engine/logic/codes.js';
import { toRows } from './engine/logic/common.js';
import { schemaFrom } from './engine/logic/schema.js';
import { createRestPort } from './engine/rest-port.js';

// Requête vers une instance Grist de la liste (config.js), jamais ailleurs, sans les cookies de
// la personne (le jeton, quand il en faut un, est dans l'adresse).
// Une requête qui n'a pas de réponse au bout de ce délai est abandonnée : sans cela, une réponse qui n'arrive jamais (mandataire qui
// retient la requête, réseau qui ne coupe pas) suspend la boucle qui l'attend, et la recopie s'arrête sans une erreur (audit du
// 25 novembre : /compare retenue en route, rien n'arrivait plus et la carte restait « À jour »). Les fichiers ont plus de temps.
const REQUEST_MS = 120000;
const TRANSFER_MS = 600000;
async function gristFetch(url, options = {}, ms = REQUEST_MS) {
  if (!GRIST_ORIGINS.includes(new URL(url).origin)) throw new Error('otherInstance');
  return fetch(url, { signal: AbortSignal.timeout(ms), ...options, credentials: 'omit' });
}

// Adresse REST du document courant suivie de `path`, avec un jeton d'accès court : en lecture
// seule, sauf `full` (les droits de la personne). Il le faut pour écrire, mais aussi pour /sql et
// /compare, que Grist réserve à qui peut lire tout le document : un jeton en lecture seule y est
// traité en lecteur, et refusé (403) dès que le document a des règles d'accès, celles que pose le
// widget comprises (vérifié). Sans lui, chaque coup d'œil retombait sur une lecture complète.
async function authUrl(path, { full = false } = {}) {
  const { token, baseUrl } = await grist.docApi.getAccessToken({ readOnly: !full });
  return `${baseUrl}${path}${path.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`;
}

export const fetchRows = async tableId => toRows(await grist.docApi.fetchTable(tableId));

export const apply = actions => (actions.length ? grist.docApi.applyUserActions(actions) : null);

// Instantané des métadonnées du document (tables et colonnes), lu en deux requêtes, et relu après
// une écriture qui change le schéma (sa forme : engine/logic/schema.js).
export async function readSchema() {
  const [tables, columns] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Tables_column')]);
  return schemaFrom(tables, columns);
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

// Une seule exécution à la fois de `fn` sous ce nom, tous onglets du navigateur confondus.
export const withLock = (name, fn) => (navigator.locks ? navigator.locks.request(name, fn) : fn());

// ---------------------------------------------------------------------------------------------
// `http` du moteur (voir engine/rest-port.js pour le contrat) : ce que syncPlus ajoute aux requêtes REST.

// Une réponse de Grist en `{ status, body }` : le corps est lu en JSON (null s'il est vide ou illisible). Un
// refus (hors 2xx) devient une erreur portant `status` et le début du texte (`message`).
async function answerOf(response, limit = 200) {
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(text.slice(0, limit)), { status: response.status });
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (e) {
    body = null;
  }
  return { status: response.status, body };
}

// Une requête REST dont le navigateur n'a pas pu lire la réponse (TypeError de `fetch` : « NetworkError when attempting to
// fetch resource », « Failed to fetch »). Vu sur DINUM (18 novembre 2026) : quand Grist refuse le jeton `auth=` (401 « Broken
// token », « Cannot verify token », « Token has expired »), sa réponse n'a aucun en-tête CORS, et le navigateur la cache : la personne
// lit une erreur de réseau sans code d'état (sonde `tests/e2e/tools/probe-cors-token.mjs`). Un refus de droits (403) a ses en-têtes,
// lui, et reste lisible. L'erreur dit quelle requête a échoué (`méthode chemin`, jamais l'adresse complète ni le jeton) et garde son type
// (`unreachable` de ui.js la reconnaît : le document qui se recharge en passant ne fait pas peur).
const unreachableError = (e, method, path) => Object.assign(new TypeError('gristUnreachable'), { vars: { request: `${method} ${path}` }, cause: e });
// Une requête abandonnée faute de réponse (`TimeoutError`) se dit comme une requête qui n'a pas pu être lue : Grist n'a pas répondu.
const timedOut = e => Boolean(e) && (e.name === 'TimeoutError' || e.name === 'AbortError');
const onlyUnreachable = (method, path) => (e) => { throw e instanceof TypeError || timedOut(e) ? unreachableError(e, method, path) : e; };

const http = {
  // REST du document courant, avec le jeton de la personne (`full`) ou en lecture seule. Grist exige
  // l'un de ces en-têtes pour toute écriture sans cookie (protection CSRF).
  async request(method, path, { body, params, full = false, timeout } = {}) {
    const query = Object.entries(params || {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const url = await authUrl(`${path}${query ? `?${query}` : ''}`, { full });
    return answerOf(await gristFetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
    }).catch(onlyUnreachable(method, path)));
  },
  // Sans jeton : écriture anonyme en JSON (l'en-tête Content-Type suffit à Grist), fiche d'un partage,
  // document public.
  async anonymous(method, url, { body, timeout } = {}) {
    return answerOf(await gristFetch(url, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
    }), 120);
  },
  async download(id) {
    const path = `/attachments/${Number(id)}/download`;
    const response = await gristFetch(await authUrl(path), {}, TRANSFER_MS).catch(onlyUnreachable('GET', path));
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    return new Uint8Array(await response.arrayBuffer());
  },
  async upload(name, bytes) {
    const form = new FormData();
    form.append('upload', new Blob([bytes]), name);
    const response = await gristFetch(await authUrl('/attachments', { full: true }), {
      method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: form,
    }, TRANSFER_MS).catch(onlyUnreachable('POST', '/attachments'));
    return (await answerOf(response)).body[0];
  },
  docBaseUrl: async () => (await docIdentity()).baseUrl,
};

export const {
  querySql, selectRows, journalStats, docChanges, isOwner, downloadAttachment, uploadAttachment, listWebhooks,
  createWebhook, webhookConditions, setWebhookEnabled, renameWebhook, deleteWebhook, deleteWebhookWithNotice,
  clearWebhookQueue, postRows, postToHook, publicRecords, publicAccess, shareInfo,
} = createRestPort({ docApi: { fetchRows }, http });
