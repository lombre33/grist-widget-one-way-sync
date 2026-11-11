// SOURCE : créer ou modifier un export, sans fenêtre. L'écran (js/source/export-wizard.js) recueille les
// choix de la personne (tables, colonnes, filtres, nom, règles) et appelle ceci ; GFS fait de même avec
// son écran. Ce fichier écrit dans le document (colonnes du widget dans les tables envoyées, table
// Synchro, note) et rend des données, jamais un nœud ni un texte d'écran.
import { nowS, randomHex } from '../logic/common.js';
import { exportEmail, exportableColumns, hookName, pruneRules, readTables, withDoc } from '../logic/exports.js';
import { docFormatOf } from '../logic/docformat.js';
import { linkTables } from '../logic/links.js';
import { hiddenTables } from '../logic/acl.js';
import { putExport } from '../logic/notes.js';
import { exchangeRules } from '../logic/consolidation.js';
import { STATES } from '../logic/journal.js';
import { fillKeyActions, missingSyncColumns, prepareSourceActions } from '../logic/formulas.js';
import { receivedDests } from '../logic/received.js';
import { apply, fetchRows, readSchema, renameWebhook } from '../port.js';
import { failure } from '../errors.js';
import { recordEvent, saveExport, syncRows, updateSourceNote } from './synchro.js';
import { resendTables } from './resend.js';

// Tables prêtes à partir (id_sync, MajLe…) et leurs colonnes choisies. Une table reçue (relais)
// garde la clé de son document d'origine : une ligne ajoutée ici à la main reste sans clé, donc
// locale (avec une clé, la prochaine liste de l'origine, qui ne la connaît pas, l'effacerait).
// Un seul instantané suffit : chaque étape ne touche que sa table, et les colonnes que le widget
// ajoute ne sont pas envoyables. `selection` : [{ table, columns: [identifiants cochés], filter }].
async function prepareTables(selection, links, style) {
  const schema = await readSchema();
  // Avec « la mise en forme des colonnes » : langue et monnaie du document, dites à la CIBLE (voir docformat.js).
  const doc = style ? docFormatOf(await fetchRows('_grist_DocInfo')) : null;
  const relays = receivedDests(schema).map(d => d.dest);
  const tables = [];
  for (const { table, columns: picked, filter } of selection) {
    await apply(prepareSourceActions(table, missingSyncColumns(schema.columns(table))));
    if (!relays.includes(table)) await apply(fillKeyActions(table, await fetchRows(table), () => crypto.randomUUID()));
    const columns = exportableColumns(schema.columns(table), { extras: Boolean(style), doc }).filter(c => picked.includes(c.id));
    tables.push({ table, columns: style ? withDoc(pruneRules(columns), doc) : columns, filter: filter || null });
  }
  return linkTables(tables, Boolean(links));
}

// Export partagé par lien public : rien de ce qu'une règle d'accès cache ne doit s'y ajouter.
async function refuseHidden(tables) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const hidden = hiddenTables(resources, rules, readTables(tables));
  if (hidden.length) throw failure('publicHiddenEdit', { tables: hidden.join(', ') });
}

// Nom et date de l'export dans la note SOURCE. Règles d'un Échange administré ici : notées
// seulement si elles ne sont pas toutes « Accepter ».
async function noteExport(rules, id, name) {
  const kept = rules ? exchangeRules({ regles: rules, refus: rules.refus }) : undefined;
  await updateSourceNote((note) => {
    const entry = { at: nowS(), ...note.exports.find(e => e.id === id), id, name };
    if (rules) Object.assign(entry, { regles: kept ? Object.fromEntries(STATES.map(st => [st, kept[st]])) : undefined, refus: kept?.refus });
    return putExport(note, JSON.parse(JSON.stringify(entry)));
  });
}

// Crée l'export (`exp` absent) ou enregistre la modification de `exp`. `selection` : voir
// prepareTables ; `links` : garder les liens entre les tables (case de l'étape Colonnes) ; `style` : envoyer la
// mise en forme des colonnes (en-têtes, règles conditionnelles, monnaie, langue du document ; case de
// l'étape Colonnes, jamais en Échange) ; `rules` : règles d'un Échange administré ici ({ ajout, modif,
// suppression, refus }), ou rien. Rend
// `{ id, name, tables, changed, created }` : `changed` = les tables qu'il faut renvoyer (modification),
// `created` = l'export tel que l'écran de ses destinataires l'attend (création).
export async function saveChosenExport({ exp = null, name, selection, links = false, style = false, rules = null }) {
  const tables = await prepareTables(selection, links, style && !exp?.echange);
  if (exp?.public) await refuseHidden(tables);
  const id = exp ? exp.id : randomHex(8);
  const changed = await saveExport(id, tables, { isPublic: Boolean(exp?.public), swap: Boolean(exp?.echange) });
  await noteExport(rules, id, name);
  const created = exp ? null : { id, name, tables, recipients: [], invitations: [], public: false, email: exportEmail(await syncRows(), id) };
  return { id, name, tables, changed, created };
}

// Après l'enregistrement d'un export modifié : l'événement de l'historique, les webhooks renommés si le
// nom a changé, les tables changées renvoyées (par tranches : `progress` en reçoit l'avancement, voir
// resendTables). Rend le nombre de lignes renvoyées, ou null si le renvoi attend son tour.
export async function finishEdit(exp, { name, changed }, progress) {
  await recordEvent(exp.id, changed.length ? 'editSent' : 'edit', { n: changed.length });
  if (name !== exp.name) for (const h of exp.recipients) await renameWebhook(h.id, hookName(name, exp.id));
  return changed.length ? resendTables(exp.id, changed, progress) : 0;
}
