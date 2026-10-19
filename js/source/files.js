// SOURCE : envoi du contenu des pièces jointes, tant qu'un propriétaire a la page du widget ouverte
// (le rattrapage s'en charge, voir resend.js). Le webhook ne porte que la liste des fichiers de
// chaque cellule ; le widget envoie chaque fichier une fois par destinataire, en morceaux, à
// l'adresse de son webhook (le lien du formulaire de son journal). Ce qui est parti est noté dans
// la note de Synchro (`fichiers`, voir readTracking) : aucune table de plus.
import { EXPORT_COL, KIND, LOT_COL, SYNC_TABLE, TYPE_COL, groupBy, randomHex } from '../logic/common.js';
import { hooksOf } from '../logic/exports.js';
import { setFiles } from '../logic/notes.js';
import { encodeParts, fileSends, forgetHooks, neededFiles, partRow, readTracking, recordSent, trackingNote } from '../logic/files.js';
import { downloadAttachment, fetchRows, postToHook, readSchema, selectRows } from '../grist.js';
import { readSourceNote, updateSourceNote } from './synchro.js';

const pending = new Map(); // export -> envois de fichiers restants, pour la carte
// Webhook dont un envoi direct a échoué (lien coupé, instance qui refuse) : il attend FAIL_HOLD_MS
// avant un nouvel essai, pour ne pas retélécharger le fichier à chaque rattrapage.
const failed = new Map();
const FAIL_HOLD_MS = 600000;

export const filesPending = exportId => pending.get(exportId) || 0;

// Lignes 'fichiers' de Synchro, avec leur liste (lue en SQL quand Grist le permet : les lots, de
// grosses cellules, ne sont pas relus).
async function fileRows() {
  const rows = await selectRows(SYNC_TABLE, [EXPORT_COL, TYPE_COL, LOT_COL], { [TYPE_COL]: KIND.files });
  return rows || (await fetchRows(SYNC_TABLE)).filter(r => r[TYPE_COL] === KIND.files);
}

const saveTracking = change => updateSourceNote(note => setFiles(note, change({ ...(note.fichiers || {}) })));

// Envois dus, par export qui envoie des fichiers : { exportId, needed, tracking, sends, hooks }.
// Le suivi nettoyé (fichiers retirés, destinataires partis) est écrit s'il a changé. `ok(h)` : le
// webhook reçoit (actif, sans échec).
export async function planFiles(hooks, conditions, ok) {
  const groups = groupBy(await fileRows(), r => r[EXPORT_COL]);
  const noted = readSourceNote(await readSchema()).fichiers || {};
  const recent = id => Date.now() - (failed.get(id) || 0) < FAIL_HOLD_MS;
  const plans = [...groups].map(([exportId, rows]) => {
    const mine = hooksOf(hooks, conditions, exportId);
    const active = mine.filter(h => ok(h) && !recent(h.id)).map(h => h.id);
    const needed = neededFiles(rows);
    return { exportId, needed, hooks: mine, ...fileSends(readTracking(noted[exportId]), needed, mine.map(h => h.id), active) };
  });
  pending.clear();
  for (const p of plans) pending.set(p.exportId, p.sends.reduce((n, s) => n + s.hooks.length, 0));
  const next = Object.fromEntries(plans.map(p => [p.exportId, trackingNote(p.tracking)]));
  if (JSON.stringify(next) !== JSON.stringify(noted)) await saveTracking(() => next);
  return plans.filter(p => p.sends.length);
}

// Envoie les fichiers dus, un à la fois : téléchargé une fois, puis, pour chaque destinataire, tous
// ses morceaux à la suite ; il est noté reçu quand le dernier morceau est accepté. Les envois
// suivent le budget des renvois (`spend`, qui attend s'il est dépassé ; `spend(0)` attend seulement)
// : les modifications ordinaires, elles, partent toujours. Rend le nombre d'envois faits.
export async function sendFiles(plans, spend) {
  let done = 0;
  for (const plan of plans) {
    let { tracking } = plan;
    for (const { sha, hooks: ids } of plan.sends) {
      const sent = ids.length ? await sendFile(plan, sha, ids, spend) : [];
      tracking = recordSent(tracking, sha, sent);
      const noted = trackingNote(tracking);
      await saveTracking(all => ({ ...all, [plan.exportId]: noted }));
      pending.set(plan.exportId, Math.max(0, filesPending(plan.exportId) - ids.length));
      done += sent.length;
    }
  }
  return done;
}

// Un fichier, téléchargé une fois, envoyé en entier à chaque webhook de `ids` ; rend ceux qui l'ont
// reçu. Un webhook en échec attend (voir failed).
async function sendFile(plan, sha, ids, spend) {
  await spend(0);
  const file = plan.needed.get(sha);
  const bytes = await downloadAttachment(file.id);
  const parts = encodeParts(bytes);
  const info = { sha, name: file.name, size: bytes.length };
  const send = randomHex(4);
  const rows = parts.map((part, n) => partRow(plan.exportId, info, send, n, parts.length, part));
  const size = parts.reduce((total, part) => total + part.length, 0);
  const sent = [];
  for (const h of plan.hooks.filter(x => ids.includes(x.id))) {
    try {
      for (const row of rows) await postToHook(h, [row]);
      sent.push(h.id);
    } catch (e) {
      failed.set(h.id, Date.now());
    }
    await spend(size);
  }
  return sent;
}

// « Tout renvoyer » : les destinataires de l'export reçoivent de nouveau tous ses fichiers.
export async function resendFiles(exportId) {
  const noted = readSourceNote(await readSchema()).fichiers || {};
  if (!noted[exportId]) return;
  const tracking = trackingNote(forgetHooks(readTracking(noted[exportId])));
  await saveTracking(all => ({ ...all, [exportId]: tracking }));
}
