// Ce qui prouve qui est à l'autre bout d'un lien, au-delà de ce que dit un code collé : le document
// que désigne une clé de formulaire, lu chez Grist ; un code de contrôle à comparer par téléphone ;
// la durée de vie d'une invitation ; la signature des envois (HMAC-SHA256 avec une clé propre à
// l'export, que seuls la SOURCE et ses destinataires connaissent).
import {
  DATA_COL, DELETE_COL, EXPORT_COL, KEY_COL, KIND, LIST_COL, LOT_COL, ORDER_COL, SCHEMA_COL, SEAL_COL, TABLE_COL, TYPE_COL, is, isBlank, isTrue,
  toHex,
} from './common.js';
import { parseWebhookUrl } from './codes.js';

// ---------------------------------------------------------------------------------------------
// Document désigné par une clé de formulaire

// Réponse de Grist à GET <instance>/api/s/<clé> (anonyme) : { docId (complet), name, folder, team
// (adresse de l'équipe), teamName, personal (espace personnel : son propriétaire n'est pas
// vérifiable) } ; null si elle n'a pas la forme attendue.
export function readShare(json) {
  if (!json || typeof json !== 'object' || !is(/^[A-Za-z0-9_-]{12,}$/, json.id)) return null;
  const ws = json.workspace && typeof json.workspace === 'object' ? json.workspace : {};
  const org = ws.org && typeof ws.org === 'object' ? ws.org : {};
  const text = v => (typeof v === 'string' ? v.slice(0, 200) : '');
  const team = text(org.domain);
  return {
    docId: json.id, name: text(json.name), folder: text(ws.name), team, teamName: text(org.name),
    personal: !team || /^docs(-\d+)?$/.test(team) || Boolean(org.billingAccount && org.billingAccount.individual),
  };
}

// Un code ou un mémo désigne un document par son identifiant court (urlId : au moins les 12 premiers
// caractères de l'identifiant complet, règle de Grist) ou complet.
export const sameDoc = (fullId, shown) => typeof shown === 'string' && shown.length >= 12 && fullId.startsWith(shown);

// Mémo d'un webhook (« e-mail · document · équipe ») : faux si aucune de ses parties ne désigne le
// document `fullId` alors qu'une au moins a la forme d'un identifiant (un mémo sans document ne dit
// rien).
export function memoMatches(memo, fullId) {
  const parts = String(memo || '').split(' · ').filter(p => !p.includes('@') && /^[A-Za-z0-9]{12,}$/.test(p));
  return !parts.length || parts.some(p => sameDoc(fullId, p));
}

// ---------------------------------------------------------------------------------------------
// Code de contrôle : six caractères tirés de la clé de l'adresse d'écriture et du secret, affichés
// des deux côtés. Une adresse remplacée en route (ou une réponse faite par un autre) donne un autre
// code. Seule la clé compte, tirée par Grist : le reste de l'adresse (équipe, table) se choisit, et
// le faire varier jusqu'à retomber sur le même code serait à la portée d'un ordinateur.

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sans 0, 1, I, L, O
export async function controlCode(url, secret) {
  const subject = (parseWebhookUrl(url) || {}).key || url;
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${subject}\n${secret || ''}`)));
  const chars = Array.from(bytes.slice(0, 6), b => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 3)}-${chars.slice(3)}`;
}

// ---------------------------------------------------------------------------------------------
// Invitations

export const INVITE_DAYS = 7;
export const expiresAt = at => (Number(at) || 0) + INVITE_DAYS * 86400;
export const isExpired = (at, now) => now > expiresAt(at);

// ---------------------------------------------------------------------------------------------
// Signature des envois. La formule de Synchro signe le texte d'un lot (Synchro_Lot des lignes
// 'lot') ou d'une liste des clés (Synchro_Ids des lignes 'cles') : la signature, sur l'export, la
// table, le type, la description des colonnes et le texte, est ajoutée en dernier champ du JSON
// (`"sig"`), que la CIBLE retire pour vérifier. Un changement de colonnes change donc la signature
// du lot, qui repart avec elles. Le widget SOURCE signe de même l'avis de fin ('fin', dans
// Synchro_Lot).

const SIGNED = { [KIND.lot]: LOT_COL, [KIND.keys]: LIST_COL, [KIND.end]: LOT_COL };
const SIG_TAIL = /, "sig": "([0-9a-f]{64})"\}$/;

const message = (row, text) => [row[EXPORT_COL], row[TABLE_COL] || '', row[TYPE_COL], row[SCHEMA_COL] || '', text].join('|');

export async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))));
}

// Texte JSON d'objet `text` signé pour la ligne `row` (comme la formule le fait).
export async function signText(key, row, text) {
  return `${text.slice(0, -1)}, "sig": "${await hmac(key, message(row, text))}"}`;
}

// Ligne brute d'un journal, au regard de la clé `key` : 'ok' (signée, ou d'un type qui ne l'est
// pas : morceau de fichier, protégé par son empreinte), 'bare' (liste des clés vide : elle ne dit
// rien, mais sa description des colonnes n'est pas prouvée, donc pas lue) ou 'bad'.
export async function signature(row, key) {
  const col = SIGNED[row[TYPE_COL]];
  if (!col) return 'ok';
  const text = typeof row[col] === 'string' ? row[col] : '';
  if (!text) return row[TYPE_COL] === KIND.keys ? 'bare' : 'bad';
  const m = SIG_TAIL.exec(text);
  if (!m) return 'bad';
  const body = `${text.slice(0, m.index)}}`;
  return (await hmac(key, message(row, body))) === m[1] ? 'ok' : 'bad';
}

// Lignes brutes de l'export `exportId` (celles d'un autre export sont laissées au contrôle du
// dépliage) : { bad (mal signées), bare (listes vides) }, ensembles de numéros de lignes.
export async function checkSigned(rows, key, exportId) {
  const out = { bad: new Set(), bare: new Set() };
  for (const row of rows) {
    if (row[EXPORT_COL] !== exportId) continue;
    const verdict = await signature(row, key);
    if (verdict !== 'ok') out[verdict].add(row.id);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sceau des lignes dépliées (CIBLE). La clé du formulaire d'un journal peut y créer une ligne avec
// n'importe quelles colonnes : sans type, elle n'est pas une ligne reçue et passerait pour une
// version déjà dépliée, sans contrôle de signature ni de date. Le widget scelle donc chaque ligne
// qu'il déplie (HMAC avec la clé de signature de l'export, que la clé du formulaire ne lit pas) et
// écarte toute ligne d'une table sans sceau valide. Le sceau couvre ce que le dépliage écrit, pas
// les marques que la recopie pose ensuite (Sync_Applique, Sync_Etat, Sync_Avant, et Sync_Recu, que
// la recopie récrit sur la version d'une ligne effacée d'après une liste des clés : voir
// planConsolidation).
const SEALED = [TABLE_COL, KEY_COL, ORDER_COL, DELETE_COL, DATA_COL, SCHEMA_COL, LIST_COL];
export const sealText = (exportId, row) => JSON.stringify(['sceau', exportId,
  ...SEALED.map(c => (c === DELETE_COL ? isTrue(row[c]) : isBlank(row[c]) ? '' : row[c]))]);

// Lignes dépliées, à sceller : une ligne d'une table (version ou liste des clés). Les lignes
// reçues sont contrôlées au dépliage ; une ligne sans table (test du lien) ne sert à rien.
export const isUnpacked = row => isBlank(row[TYPE_COL]) && !isBlank(row[TABLE_COL]);

// Sceau d'un texte avec la clé `key`, importée une fois : fonction asynchrone texte -> hexadécimal.
export async function sealer(key) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async text => toHex(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text))));
}

// Empreinte de la clé qui scelle, notée dans la note du journal (`sceau`) : quand elle change
// (première fois, nouvelle invitation), le widget rescelle ce qui est déjà là.
export const sealMark = async seal => (await seal('sceau')).slice(0, 8);

export const sealRows = async (rows, exportId, seal) => Promise.all(rows.map(async r => ({ ...r, [SEAL_COL]: await seal(sealText(exportId, r)) })));

// Lignes du journal à garder : toutes, sauf les lignes d'une table au sceau absent ou faux
// (`forged`, numéros). `seen` : sceaux déjà vérifiés, par numéro de ligne, tenu à jour ici (une
// ligne disparue en sort : un numéro réutilisé est vérifié de nouveau).
export async function checkSeals(rows, exportId, seal, seen = new Map()) {
  const present = new Set(rows.map(r => r.id));
  for (const id of seen.keys()) if (!present.has(id)) seen.delete(id);
  const forged = [];
  for (const row of rows.filter(isUnpacked)) {
    const got = row[SEAL_COL];
    if (got && seen.get(row.id) === got) continue;
    if (got && got === await seal(sealText(exportId, row))) seen.set(row.id, got);
    else forged.push(row.id);
  }
  const bad = new Set(forged);
  return { kept: rows.filter(r => !bad.has(r.id)), forged };
}
