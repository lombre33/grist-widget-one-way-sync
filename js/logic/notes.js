// Note SOURCE (description de la colonne Synchro_Export, voir source/synchro.js) :
// { exports: [{ id, name, at, public, renforce, echange, retour, regles, refus }],
//   invitations: [{ id, export, hash, at, renforce, journal, ready, pub, prive }],
//   pauses: [{ hook, export, at, columns }], fichiers: { <export>: { f, h, p } },
//   historique: { <export>: [{ at, kind, who, n }] } }.
// Chaque opération rend une nouvelle note, sans toucher à celle qu'elle reçoit.

// Élément remplacé à sa place (même `id`), sinon ajouté à la fin.
const put = (list, entry) => (list.some(x => x.id === entry.id) ? list.map(x => (x.id === entry.id ? entry : x)) : [...list, entry]);

// Champs d'un export changés ; l'export garde sa place (l'ordre des cartes).
export const setExport = (note, id, fields) => ({ ...note, exports: note.exports.map(e => (e.id === id ? { ...e, ...fields } : e)) });
export const putExport = (note, entry) => ({ ...note, exports: put(note.exports, entry) });

// Invitations et pauses d'un export retirées ; `dropExport` retire aussi l'export.
export const clearExport = (note, id) => ({ ...note, invitations: note.invitations.filter(i => i.export !== id), pauses: note.pauses.filter(p => p.export !== id) });
export function dropExport(note, id) {
  const next = { ...clearExport(note, id), exports: note.exports.filter(e => e.id !== id) };
  delete next.historique;
  const { [id]: gone, ...history } = note.historique || {};
  return Object.keys(history).length ? { ...next, historique: history } : next;
}

// Historique des envois d'un export : les événements que le widget a lui-même conduits (renvois,
// rattrapages, pauses, destinataires), du plus récent au plus ancien, les EVENTS_KEPT derniers.
// Les envois ordinaires partent de Grist sans le widget : l'état de chaque destinataire (dernier
// succès, erreur) les dit. `event` : { at (secondes), kind ('join', 'resend', 'catchup', 'unblock',
// 'pause', 'resume', 'revoke', 'edit', 'editSent'), who (destinataire, texte), n (lignes ou tables) }.
export const EVENTS_KEPT = 30;
const WHO_MAX = 80;
const EVENT_KINDS = ['join', 'resend', 'catchup', 'unblock', 'pause', 'resume', 'revoke', 'edit', 'editSent'];
export function addEvent(note, exportId, { at, kind, who = '', n = 0 }) {
  const event = { at, kind, ...(who ? { who: String(who).slice(0, WHO_MAX) } : {}), ...(n ? { n } : {}) };
  return { ...note, historique: { ...(note.historique || {}), [exportId]: [event, ...((note.historique || {})[exportId] || [])].slice(0, EVENTS_KEPT) } };
}
// Événements lisibles d'un export. La note peut avoir été retouchée à la main ou écrite par une autre
// version : un élément mal formé est écarté, jamais d'erreur à l'affichage.
const readable = e => e && typeof e === 'object' && EVENT_KINDS.includes(e.kind) && Number.isFinite(e.at) && e.at > 0 && e.at < 4e9;
export function eventsOf(note, exportId) {
  const list = (note.historique || {})[exportId];
  return (Array.isArray(list) ? list : []).filter(readable).map(({ at, kind, who, n }) => ({
    at, kind, ...(who ? { who: String(who).slice(0, WHO_MAX) } : {}), ...(Number.isFinite(n) && n ? { n } : {}),
  }));
}

export const putInvitation = (note, entry) => ({ ...note, invitations: put(note.invitations, entry) });
export const dropInvitation = (note, id) => ({ ...note, invitations: note.invitations.filter(i => i.id !== id) });

// Pause du webhook `hook` : notée (`entry`), ou levée (sans `entry`).
export const setPause = (note, hook, entry = null) => ({ ...note, pauses: [...note.pauses.filter(p => p.hook !== hook), ...(entry ? [entry] : [])] });

// Suivi des fichiers envoyés (voir source/files.js) : retiré de la note quand il est vide.
export function setFiles(note, fichiers) {
  const rest = { ...note };
  delete rest.fichiers;
  return Object.keys(fichiers).length ? { ...rest, fichiers } : rest;
}
