// Données et aides communes aux tests unitaires.
import { Buffer } from 'node:buffer';
import { buildInvitation } from '../../js/logic/codes.js';
import { bucketOf } from '../../js/logic/common.js';
import { planConsolidation } from '../../js/logic/consolidation.js';

export const SECRET = '0123456789abcdef0123456789abcdef';
export const j = (id, key, majle, extra = {}) => ({ id, id_sync: key, MajLe: majle, Supprime: false, Nom: `n${id}`, ...extra });
export const plan = (journalRows, destRows, matchCol) => planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', matchCol });
export const marked = (ids, states) => ['BulkUpdateRecord', 'J', ids, { Sync_Applique: ids.map(() => true), Sync_Etat: states }];
// Ce que la recopie a remplacé, noté pour l'historique : [[ligne du journal, { v } ou { n }]].
export const replaced = entries => ['BulkUpdateRecord', 'J', entries.map(([id]) => id), { Sync_Avant: entries.map(([, was]) => JSON.stringify(was)) }];
export const list = (id, keys, extra = {}) => ({ id, id_sync: '', Synchro_Ids: `ids:${keys.join(' ')}`, ...extra });
export const done = { Sync_Applique: true };
// Seaux qui ont perdu les clés `keys` : chacun part avec ses clés restantes (parmi `left`).
export const gone = (id, t, keys, extra = {}, left = []) => ({ id, id_sync: '', ...extra, Synchro_Ids: JSON.stringify({ t,
  seaux: Object.fromEntries(keys.map(k => [bucketOf(k), left.filter(x => bucketOf(x) === bucketOf(k))])) }) });
export const part = (id, n, t, keys, last, mark = 'm1') => ({ id, id_sync: '', Synchro_Ids: JSON.stringify({ liste: { marque: mark, n, t, cles: keys, fin: last } }) });
export const ID = '0123456789abcdef';
export const EXPORT = 'fedcba9876543210';
export const COLUMNS = [{ id: 'Nom', type: 'Text', label: 'Nom' }];
// Clé publique d'une invitation ou d'une réponse : seule sa forme compte ici (voir trust.test.mjs).
export const PUB = `B${'x'.repeat(85)}A`;
export const invitation = (fields = {}) => buildInvitation({ id: ID, exportId: EXPORT, name: 'Annuaire', origin: 'https://g.fr', tables: [{ table: 'Contacts', columns: COLUMNS }], pub: PUB, ...fields });
// Code forgé à la main : préfixe et JSON en base64url, sans passer par buildInvitation.
export const forge = payload => `GRISTSYNC2.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
