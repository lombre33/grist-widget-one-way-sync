// Le montage que les essais du moteur partagent : une SOURCE branchée à une CIBLE sur deux documents en mémoire
// (invitation, lecture, réception, réponse, approbation), sans écran. Chaque essai y met ce qui lui est propre :
// la table de destination, le plan, les réglages de la réception.
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KEY_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { signText } from '../../js/engine/logic/trust.js';
import { syncRows } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { readSchema } from '../../js/engine/port.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { state, tableKey } from '../../js/engine/target/loop.js';
import { fakePair } from './engine-fake.mjs';

// Le moteur sur tel document du monde : on passe de la SOURCE à la CIBLE en changeant de port.
export const engineAs = world => doc => startEngine({ port: world.port(doc), version: '9.9.9' });

// L'export « Annuaire » (table Contacts, colonne Nom) de la SOURCE : le moteur y reste.
export async function exportAnnuaire(world, source) {
  engineAs(world)(source);
  return (await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom'], filter: null }] })).created;
}

// L'invitation de l'export `exp` (SOURCE), lue par la CIBLE : le moteur finit sur la CIBLE.
export async function invite({ world, target, exp }) {
  const { entry, secret } = await startInvitation(exp);
  const { code } = await invitationCode(exp, entry, secret);
  engineAs(world)(target);
  return { entry, invitation: await readInvitation(code) };
}

// L'export `exp` branché de bout en bout : la CIBLE reçoit dans `dest` (un nom, ou une fonction de la table envoyée), ou selon `plan`
// (le plan d'une table, avec par exemple `match`) ; `check` lit les destinations avant ; `receive` : réglages de createReception.
// Le moteur finit sur la SOURCE.
export async function wireReception({ world, source, target, exp, dest, plan, check = true, receive = { reserve: false, options: {} } }) {
  const { entry, invitation } = await invite({ world, target, exp });
  const planOf = plan || (tb => ({ tb, dest: typeof dest === 'function' ? dest(tb) : dest }));
  const plans = invitation.tables.map(planOf);
  if (check) await checkDestinations(invitation, plans);
  const made = await createReception(invitation, plans, receive);
  const { code: reply } = await receptionReply(made, world.formLink(target, made.journal));
  engineAs(world)(source);
  const accepted = await checkReply(exp, entry, reply);
  const hook = await approveReply(exp, entry, accepted);
  return { entry, invitation, plans, made, accepted, hook };
}

// Les lignes reçues et non supprimées d'une table, « clé:Nom:Ville », triées.
export const receivedNames = (doc, table) => doc.rows(table).filter(r => r.Supprime !== true).map(r => `${r[KEY_COL]}:${r.Nom}:${r.Ville}`).sort();

// Une SOURCE dont la table Fiches (Nom, Ville) est exportée sous le nom « Fiches », branchée à une CIBLE (`prepare(cible)` la prépare
// avant la réception). Rend de quoi livrer des lots signés à la CIBLE : `deliver(colonnes, lignes)` ; `base` : les colonnes de l'export.
export async function wireFiches(tag, { rows = [], prepare, dest, plan, receive }) {
  const { world, source, target } = fakePair(tag, { contacts: false });
  source.addTable('Fiches', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], rows);
  if (prepare) prepare(target);
  const as = engineAs(world);
  as(source);
  const saved = await saveChosenExport({ name: 'Fiches', selection: [{ table: 'Fiches', columns: ['Nom', 'Ville'], filter: null }] });
  const { made, accepted } = await wireReception({ world, source, target, exp: saved.created, dest, plan, receive });
  const lot = (await syncRows()).find(r => r[EXPORT_COL] === saved.id && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Fiches');
  const deliver = async (columns, lines) => {
    const row = { [EXPORT_COL]: saved.id, [TABLE_COL]: 'Fiches', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: JSON.stringify(columns) };
    world.deliver(accepted.url, [{ ...row, [LOT_COL]: await signText(accepted.keys.down, row, JSON.stringify({ lignes: lines, total: lines.length })) }]);
  };
  return { world, source, target, made, as, saved, accepted, base: JSON.parse(lot[SCHEMA_COL]), deliver };
}

// Ce que les essais relisent : la note du premier journal reçu, le résultat de la dernière recopie d'une table reçue, une colonne
// d'un document, les colonnes que décrit une ligne de lot.
export const journalNote = async () => receivedJournals(await readSchema())[0].note;
export const resultOf = (made, table = 'Fiches') => state.results.get(tableKey(made.journal, table));
export const columnOf = (doc, table, colId) => doc.fetchRows('_grist_Tables_column').find(c => c.colId === colId && doc.tables.get(table).columns.some(x => x.id === c.id));
export const lotColumns = lot => JSON.parse(lot[SCHEMA_COL]);
