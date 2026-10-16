// Échange : deux documents qui se tiennent à jour l'un l'autre (voir planConsolidation). Chacun a
// un export (même identifiant des deux côtés, avec sa ligne 'echange') et un journal en mode
// 'echange' qui reçoit l'autre. Le journal de retour du document qui a invité (`retour`) attend
// la réponse (`from` encore vide) avant de recopier quoi que ce soit.
// Échange à plusieurs : le document qui invite en administre plusieurs à la fois, chacun avec son
// webhook et son journal de retour ; les participants ne se connaissent pas (voir markHub).
import { EXPORT_COL, HUB, KIND, SCHEMA_COL, SYNC_TABLE, TYPE_COL } from './logic/common.js';
import { deleteColumnAction, keyTriggerAction, missingSyncColumns, prepareSourceActions } from './logic/formulas.js';
import { endNotice, exchangeTables, exportCondition, exportTables, exportableColumns, hookName, hooksOf } from './logic/exports.js';
import { apply, createWebhook, deleteWebhook, deleteWebhookWithNotice, listWebhooks, readSchema, webhookConditions } from './grist.js';
import { removeTechnicalTables } from './pages.js';
import { removeExport, saveExport, syncRows, updateSourceNote } from './source/synchro.js';
import { receivedJournals } from './target/journals.js';

// Côté CIBLE : l'export de retour (identifiant et nom de l'export reçu) envoie les destinations à
// la SOURCE. Elles reçoivent MajLe et RecalculLe, et une clé à chaque ligne nouvelle ; les lignes
// déjà là sans clé restent à ce document. Avec `retour` (adresse d'écriture du journal de retour,
// lue dans l'invitation, jamais notée), le webhook vers la SOURCE est (re)créé.
export async function wireExchange(note, retour = '') {
  let schema = await readSchema();
  for (const { dest } of note.tables) {
    const cols = schema.columns(dest) || [];
    await apply([...prepareSourceActions(dest, missingSyncColumns(cols)), keyTriggerAction(dest, cols), deleteColumnAction(dest, cols)].filter(Boolean));
  }
  schema = await readSchema();
  await saveExport(note.export, exchangeTables(note.tables, dest => exportableColumns(schema.columns(dest) || [])), { swap: true });
  await updateSourceNote((n) => {
    const was = n.exports.find(e => e.id === note.export) || { at: Date.now() / 1000 };
    n.exports = [...n.exports.filter(e => e.id !== note.export), { ...was, id: note.export, name: note.name, echange: true, retour: true }];
  });
  if (!retour) return;
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  for (const h of hooksOf(hooks, conditions, note.export)) await deleteWebhook(h.id);
  const from = note.from || {};
  await createWebhook({
    name: hookName(note.name, note.export), memo: [from.email, from.docId].filter(Boolean).join(' · '), url: retour,
    tableId: SYNC_TABLE, condition: exportCondition(note.export),
  });
}

// Échange à plusieurs : la ligne 'echange' de l'export est marquée dès deux participants (webhooks
// de l'export) ; la formule du lot renvoie alors aux autres ce que chacun envoie. Un seul : l'Échange
// à deux, sans écho.
export async function markHub(exportId) {
  const [hooks, conditions, rows] = await Promise.all([listWebhooks(), webhookConditions(), syncRows()]);
  const value = hooksOf(hooks, conditions, exportId).length >= 2 ? HUB : '';
  const row = rows.find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.swap);
  if (row && (row[SCHEMA_COL] || '') !== value) await apply([['UpdateRecord', SYNC_TABLE, row.id, { [SCHEMA_COL]: value }]]);
}

// Journal de retour d'un participant (webhook `hook`) : noté à l'approbation (`hook`) ; pour un
// Échange branché avant, retrouvé par le document de la fiche, cité dans le mémo du webhook.
const ownJournal = hook => ({ note }) => note.hook === hook.id
  || (!note.hook && Boolean((note.from || {}).docId) && (hook.fields.memo || '').split(' · ').includes(note.from.docId));

// Retirer un participant d'un Échange à plusieurs : son webhook part (avec l'avis de fin, qui
// arrête aussi son envoi de retour, voir stopReturn), puis son journal de retour et sa clé ; les
// autres continuent.
export async function removeParticipant(exportId, hook) {
  await deleteWebhookWithNotice(hook, endNotice(exportId));
  const journals = receivedJournals(await readSchema()).filter(r => r.note.export === exportId && r.note.retour).filter(ownJournal(hook));
  await removeTechnicalTables(journals.map(r => r.journal));
  await updateSourceNote((note) => { note.pauses = note.pauses.filter(p => p.hook !== hook.id); });
  await markHub(exportId);
}

// Échange coupé par l'autre document : son journal de retour n'existe plus, chaque envoi de retour
// échouerait et bloquerait la file de ce document. L'envoi de retour s'arrête donc ici aussi
// (propriétaire seulement ; sinon, au premier passage d'un propriétaire).
export async function stopReturn(exportId) {
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  for (const h of hooksOf(hooks, conditions, exportId)) await deleteWebhook(h.id);
}

// Échange, côté du document qui invite : ses tables reçoivent la case Supprime.
export async function addDeleteColumns(tables) {
  const schema = await readSchema();
  await apply(tables.map(table => deleteColumnAction(table, schema.columns(table) || [])).filter(Boolean));
}

// Fin d'un Échange, de ce côté : ses webhooks et son journal sont effacés, les tables gardent
// leurs lignes. `keepExport` (document qui a invité) : l'export reste, sans destinataire ; sinon
// (export de retour) il disparaît aussi.
export async function endExchange(exportId, { keepExport }) {
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  for (const h of hooksOf(hooks, conditions, exportId)) await deleteWebhookWithNotice(h, endNotice(exportId));
  const journals = receivedJournals(await readSchema()).filter(r => r.note.export === exportId && r.note.mode === 'echange');
  await removeTechnicalTables(journals.map(r => r.journal));
  if (keepExport) await saveExport(exportId, exportTables(await syncRows(), exportId));
  else await removeExport(exportId);
  await updateSourceNote((note) => {
    note.exports = keepExport ? note.exports.map(e => (e.id === exportId ? { ...e, echange: false } : e)) : note.exports.filter(e => e.id !== exportId);
    note.invitations = note.invitations.filter(i => i.export !== exportId);
    note.pauses = note.pauses.filter(p => p.export !== exportId);
  });
}
