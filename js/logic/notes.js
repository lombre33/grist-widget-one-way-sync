// Note SOURCE (description de la colonne Synchro_Export, voir source/synchro.js) :
// { exports: [{ id, name, at, public, renforce, echange, retour, regles, refus }],
//   invitations: [{ id, export, hash, at, renforce, journal, ready }],
//   pauses: [{ hook, export, at, columns }], fichiers: { <export>: { f, h, p } } }.
// Chaque opération rend une nouvelle note, sans toucher à celle qu'elle reçoit.

// Élément remplacé à sa place (même `id`), sinon ajouté à la fin.
const put = (list, entry) => (list.some(x => x.id === entry.id) ? list.map(x => (x.id === entry.id ? entry : x)) : [...list, entry]);

// Champs d'un export changés ; l'export garde sa place (l'ordre des cartes).
export const setExport = (note, id, fields) => ({ ...note, exports: note.exports.map(e => (e.id === id ? { ...e, ...fields } : e)) });
export const putExport = (note, entry) => ({ ...note, exports: put(note.exports, entry) });

// Invitations et pauses d'un export retirées ; `dropExport` retire aussi l'export.
export const clearExport = (note, id) => ({ ...note, invitations: note.invitations.filter(i => i.export !== id), pauses: note.pauses.filter(p => p.export !== id) });
export const dropExport = (note, id) => ({ ...clearExport(note, id), exports: note.exports.filter(e => e.id !== id) });

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
