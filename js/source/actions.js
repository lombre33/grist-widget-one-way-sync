// SOURCE : actions sur un export et ses destinataires, depuis sa carte.
import { ORDER_COL, RESEND_ALL } from '../logic/common.js';
import { buildInvitation } from '../logic/codes.js';
import { rowsSince } from '../logic/resend.js';
import { docIdentity, fetchRows, readSchema, setWebhookEnabled } from '../grist.js';
import { removeTechnicalTables } from '../pages.js';
import { dropInvitation, setExport, setPause } from '../logic/notes.js';
import { closeExport, removeRecipient } from '../exchange.js';
import { readSourceNote, saveExport, updateSourceNote } from './synchro.js';
import { clearAndMark, resendTables } from './resend.js';
import { closeButtons, confirmDialog, copyField, el, openModal } from '../ui.js';
import { handoffButton } from '../guide.js';
import { t } from '../i18n.js';

const AFTER_S = 0.0001; // juste après l'heure de la pause (MajLe en secondes)

// Mise en pause : un webhook désactivé perd son historique d'envoi (Grist remet son état à zéro),
// il ne peut donc pas dire depuis quand il ne livre plus. On note la plus récente MajLe des tables
// de l'export (heure du serveur, sans écart d'horloge avec le navigateur) et leurs colonnes.
export async function pause(exp, h) {
  let at = 0;
  for (const { table } of exp.tables) for (const r of await fetchRows(table)) at = Math.max(at, r[ORDER_COL] || 0);
  await updateSourceNote(note => setPause(note, h.id, { hook: h.id, export: exp.id, at, columns: JSON.stringify(exp.tables) }));
  await setWebhookEnabled(h.id, false);
}

// Choix de reprise : rattraper (par défaut) ou reprendre tel quel. Rend 'catchup', 'as-is' ou null.
function resumeChoice(title, help) {
  const choice = (value, label, text, checked) => [el('label', { class: 'check' },
    el('input', { type: 'radio', name: 'gristsync-resume', value, checked }), el('strong', {}, label)), el('p', { class: 'muted small choice-help' }, text)];
  const body = el('div', { class: 'form', role: 'radiogroup', 'aria-label': title },
    choice('catchup', t('send.resume.catchup'), help, true), choice('as-is', t('send.resume.asIs'), t('send.resume.asIs.help'), false));
  return new Promise((resolve) => {
    let answered = false;
    const done = (m, value) => { answered = true; resolve(value); m.close(); };
    openModal({
      title, body,
      onClose: () => { if (!answered) resolve(null); },
      buttons: [{ label: t('common.cancel'), onClick: m => done(m, null) },
        { label: t('send.action.resume'), kind: 'btn-primary', onClick: m => done(m, body.querySelector('input:checked').value) }],
    });
  });
}

// Reprendre après une pause : un webhook désactivé ne met rien en file, les changements de la
// pause sont donc perdus pour la CIBLE. Le rattrapage renvoie les lignes dont MajLe est plus
// récente que la pause, et la liste des clés pour les suppressions. Heure inconnue, ou colonnes
// changées pendant la pause : tout l'export.
export async function resume(exp, h, out) {
  const entry = readSourceNote(await readSchema()).pauses.find(p => p.hook === h.id);
  const all = !entry || entry.columns !== JSON.stringify(exp.tables);
  const since = all ? RESEND_ALL : entry.at + AFTER_S; // MajLe plus récente que la pause
  let n = 0;
  for (const { table } of exp.tables) n += rowsSince(await fetchRows(table), since).length;
  const help = [t('send.resume.catchup.help', { n }), all ? t('send.resume.all') : ''].filter(Boolean).join(' ');
  const picked = await resumeChoice(t('send.resume.title', { name: h.fields.memo || exp.name }), help);
  if (!picked) return;
  await setWebhookEnabled(h.id, true);
  await updateSourceNote(note => setPause(note, h.id));
  // Le renvoi pose sa marque avant tout : s'il s'interrompt, le rattrapage automatique le finit.
  if (picked === 'catchup') await resendTables(exp.id, exp.tables.map(tb => tb.table), out, since);
}

// Révoquer une personne : son webhook disparaît, les autres destinataires continuent ; sa carte le
// dit (voir endRows). Un Échange s'arrête dans les deux sens (voir closeExport) ; dans un Échange
// à plusieurs, pour ce participant seulement (voir removeRecipient).
export async function revoke(exp, h) {
  const one = exp.echange && !exp.retour && exp.recipients.length > 1;
  const body = t(one ? 'send.revoke.participant' : exp.echange ? 'send.revoke.exchange' : 'send.revoke.body');
  if (!(await confirmDialog({ title: t('send.revoke.title', { name: h.fields.memo || exp.name }), body, confirmLabel: t('send.action.revoke') }))) return;
  if (exp.echange && !one) await closeExport(exp.id, { keepExport: !exp.retour });
  else await removeRecipient(exp.id, h);
}

// Annuler une invitation ; celle d'un Échange emporte son journal de retour (et la clé d'écriture
// de son formulaire).
export async function cancelInvitation(inv) {
  if (!(await confirmDialog({ title: t('send.cancel.title'), body: t('send.cancel.body'), confirmLabel: t('send.action.cancel') }))) return;
  await updateSourceNote(note => dropInvitation(note, inv.id));
  if (inv.journal) await removeTechnicalTables([inv.journal]);
}

// Débloquer : la file de Grist est commune au document, la vider abandonne les envois en attente
// de tous les destinataires ; le rattrapage renvoie ensuite les exports servis.
export async function unblockQueue() {
  if (await confirmDialog({ title: t('send.unblock.title'), body: t('send.unblock.body'), confirmLabel: t('send.action.unblock') })) await clearAndMark();
}

// Supprimer un export : ses destinataires sont coupés, ses lignes Synchro effacées (la table
// disparaît avec le dernier export), avec le journal de retour d'un Échange. Les colonnes id_sync
// et MajLe restent dans les tables.
export async function deleteExport(exp) {
  const body = t('send.delete.body', { n: exp.recipients.length });
  if (!(await confirmDialog({ title: t('send.delete.title', { name: exp.name }), body, confirmLabel: t('send.action.delete') }))) return;
  await closeExport(exp.id, { keepExport: false });
}

// ---------------------------------------------------------------------------------------------
// Lien public : pas de webhook, la CIBLE lit elle-même les instantanés de l'export.

export async function publicCode(exp) {
  const { origin, docId, baseUrl } = await docIdentity();
  return buildInvitation({ id: exp.id, exportId: exp.id, name: exp.name, origin, base: baseUrl, from: { email: exp.email, docId }, tables: exp.tables });
}

export async function showPublicCode(exp) {
  const code = await publicCode(exp);
  await new Promise(resolve => openModal({ title: exp.name, onClose: resolve,
    body: [el('p', {}, t('send.public.help')), copyField(code), handoffButton('target', 'public', 1, code)], buttons: closeButtons() }));
}

// Couper le lien public d'un export : ses instantanés disparaissent, les règles d'accès suivent au
// prochain affichage. Tant que le document reste public, le refus général reste en place.
export async function stopPublic(exp) {
  const body = t('send.public.revokeBody');
  if (!(await confirmDialog({ title: t('send.public.stopTitle', { name: exp.name }), body, confirmLabel: t('send.public.stop') }))) return;
  await updateSourceNote(note => setExport(note, exp.id, { public: false }));
  await saveExport(exp.id, exp.tables, { isPublic: false });
}
