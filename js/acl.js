// Règles d'accès du widget (voir logic/acl.js), remises d'accord avec le document par un
// propriétaire : seul un propriétaire peut les changer, et chaque changement fait recharger le
// document (donc le widget). Elles ne sont donc réécrites que si elles diffèrent, et jamais pendant
// un assistant (un rechargement le fermerait). Rend vrai si elles ont changé : l'onglet attend
// alors le rechargement (voir reloading).
import { KEY_COL, SYNC_TABLE, isUserTable } from './logic/common.js';
import { aclActions, currentRules, isPublicRule, journalAclRules, lockAclRules, ownerAclRules, publicAclRules } from './logic/acl.js';
import { apply, fetchRows, readSchema } from './grist.js';
import { message } from './ui.js';
import { t } from './i18n.js';
import { updateJournalNote } from './target/journals.js';
import { receivedJournals } from './logic/received.js';
import { readSourceNote } from './source/synchro.js';

// `publicIds` : exports partagés par lien public, et `open` : le document est-il public (vrai,
// faux, ou null si on ne sait pas). Sans eux (onglet Recevoir), les règles du lien public restent
// telles quelles. Les journaux dont la note le demande (`reserve`) sont cachés aux lecteurs, et les
// tables reçues d'une réception verrouillée (`verrou`, jamais en Échange) en lecture seule pour
// tous sauf les propriétaires.
export async function syncRules({ publicIds = null, open = null } = {}) {
  if (document.querySelector('.scrim')) return false;
  const [schema, resources, rules] = await Promise.all([readSchema(), fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const current = currentRules(resources, rules);
  const publicPart = publicIds === null || open === null
    ? current.filter(isPublicRule).filter(r => r.tableId === '*' || schema.has(r.tableId))
    : publicAclRules(publicIds, { keepDeny: Boolean(open) && current.some(isPublicRule) });
  const journals = receivedJournals(schema).filter(r => r.note.reserve).map(r => r.journal);
  const exchanges = readSourceNote(schema).exports.filter(e => e.echange).map(e => e.id);
  const locked = receivedJournals(schema).filter(r => r.note.verrou && r.note.mode !== 'echange').flatMap(r => r.note.tables.map(tb => tb.dest))
    .filter(d => isUserTable(d) && schema.has(d) && schema.columns(d).some(c => c.colId === KEY_COL));
  const wanted = [...publicPart, ...(schema.has(SYNC_TABLE) ? ownerAclRules(exchanges) : []), ...journalAclRules(journals), ...lockAclRules(locked)];
  const actions = aclActions(resources, rules, wanted, id => !schema.has(id));
  if (!actions.length) {
    // Règles en place : chaque journal réservé le note, pour l'onglet d'un éditeur (qui ne lit pas
    // les règles d'accès, voir receivedGroups).
    for (const { journal } of receivedJournals(schema).filter(r => r.note.reserve && !r.note.reserved)) {
      await updateJournalNote(journal, n => ({ ...n, reserved: true }));
    }
    return false;
  }
  try {
    await apply(actions);
  } catch (e) {
    // Une règle d'autrui nomme une table absente, par exemple : Grist refuse tout changement.
    console.warn(e);
    return false;
  }
  return true;
}

// Après un changement de règles, Grist recharge le document, et le widget avec lui : l'onglet le
// dit au lieu de se dessiner pour rien (un assistant ouvert serait fermé par le rechargement), et se
// redessine lui-même si le rechargement tarde (RELOAD_MS).
const RELOAD_MS = 8000;
export function reloading(root, render) {
  root.replaceChildren(message('info', t('common.reloading')));
  setTimeout(() => { if (root.isConnected) render(); }, RELOAD_MS);
}
