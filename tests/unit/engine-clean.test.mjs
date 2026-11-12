// Effacer l'historique sur demande (bouton CIBLE et SOURCE) : l'avant des modifications et les valeurs des lignes supprimées
// sont vidés du journal, l'historique de la carte repart de zéro, et la recopie continue comme avant (les lignes vidées restent
// scellées et ordonnent encore les versions). Rien ne se fait seul.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { BEFORE_COL, DATA_COL, EXPORT_COL, KEY_COL, KIND, LOT_COL, SCHEMA_COL, SEAL_COL, STATE_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { signText } from '../../js/engine/logic/trust.js';
import { cleanPlan } from '../../js/engine/logic/clean.js';
import { addEvent, clearEvents, eventsOf, vanishedRecipients } from '../../js/engine/logic/notes.js';
import { readSchema } from '../../js/engine/port.js';
import { readSourceNote, syncRows, updateSourceNote } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { cleanJournal } from '../../js/engine/target/clean.js';
import { clearExportHistory } from '../../js/engine/source/history.js';
import { consolidateAll } from '../../js/engine/target/loop.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { fakePair } from './engine-fake.mjs';

test('cleanPlan : l\'avant des états montrés et les valeurs des clés parties, rien en Échange', () => {
  const row = (id, key, extra) => ({ id, Synchro_Table: 'T', [KEY_COL]: key, MajLe: id, ...extra });
  const rows = [
    row(1, 'a', { [STATE_COL]: 'modif', [BEFORE_COL]: '{"v":{"Nom":"x"}}', [DATA_COL]: '{"Nom":"y"}' }),
    row(2, 'b', { [STATE_COL]: 'suppression', [BEFORE_COL]: '{"n":3}', [DATA_COL]: '{"Nom":"z"}' }),
    row(3, 'c', { [STATE_COL]: 'partie', [DATA_COL]: '{"Nom":"w"}' }),
    row(4, 'd', { [STATE_COL]: 'refus', [BEFORE_COL]: '{"v":{"Nom":"q"}}', [DATA_COL]: '{"Nom":"r"}' }),
    row(5, 'e', { [STATE_COL]: 'ajout', [DATA_COL]: '{"Nom":"s"}' }),
    row(6, 'b', { [STATE_COL]: 'ajout', [DATA_COL]: '{"Nom":"t"}' }), // plus récente que la suppression de b : b est revenue
  ];
  const plan = cleanPlan(rows);
  assert.deepEqual(plan.before, [1, 2], 'le refus (corrigé par l\'Échange) garde son avant');
  assert.deepEqual(plan.values, [3], 'seule la dernière version d\'une clé partie est vidée : b est revenue, c est partie');
  assert.deepEqual(cleanPlan(rows, { hub: true }).values, [], 'en Échange, les valeurs servent encore à comparer');
});

test('clearEvents : rien de montré, des repères pour les destinataires disparus et les clés', () => {
  let note = {};
  for (const [at, kind, who, n] of [[100, 'join', 'a@x.fr', 0], [200, 'resend', '', 12], [300, 'join', 'b@x.fr', 0], [400, 'revoke', 'a@x.fr', 0], [500, 'shrink', 'Contacts', 30]]) note = addEvent(note, 'exp', { at, kind, who, n });
  assert.equal(eventsOf(note, 'exp').length, 5);
  const cleared = clearEvents(note, 'exp');
  assert.deepEqual(eventsOf(cleared, 'exp'), [], 'l\'historique montré est vide');
  const marks = eventsOf(cleared, 'exp', { all: true });
  assert.deepEqual(marks.map(e => e.kind).sort(), ['join', 'join', 'revoke'], 'les ajouts et retraits restent comme repères');
  assert.ok(marks.every(e => e.cleared && !e.who && !e.n), 'sans nom ni nombre');
  assert.doesNotMatch(JSON.stringify(cleared), /a@x\.fr|b@x\.fr|Contacts/);
  assert.equal(vanishedRecipients(marks, 0), 1, 'deux ajoutés, un révoqué, aucun présent : un a disparu, comme avant l\'effacement');
  assert.equal(clearEvents(clearEvents(note, 'exp'), 'exp').historique.exp.length, 3, 'effacer deux fois ne change rien');
  assert.deepEqual(eventsOf(clearEvents(note, 'autre'), 'exp').length, 5, 'les autres exports ne bougent pas');
});

// Une SOURCE et une CIBLE branchées, un lot signé reçu et recopié.
async function copied() {
  const { world, source, target } = fakePair('cl');
  const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });
  as(source);
  const { created: exp } = await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom'], filter: null }] });
  const { entry, secret } = await startInvitation(exp);
  const { code } = await invitationCode(exp, entry, secret);
  as(target);
  const invitation = await readInvitation(code);
  const made = await createReception(invitation, invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' })), { reserve: true, options: {} });
  const { code: reply } = await receptionReply(made, world.formLink(target, made.journal));
  as(source);
  const accepted = await checkReply(exp, entry, reply);
  await approveReply(exp, entry, accepted);
  const lotRow = (await syncRows()).find(r => r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Contacts');
  const send = async (lines) => {
    const row = { [EXPORT_COL]: exp.id, [TABLE_COL]: 'Contacts', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lotRow[SCHEMA_COL] };
    world.deliver(accepted.url, [{ ...row, [LOT_COL]: await signText(accepted.keys.down, row, JSON.stringify({ lignes: lines, total: lines.length })) }]);
    as(target);
    target.tick();
    await consolidateAll({ reread: true });
  };
  as(target);
  return { world, source, target, as, exp, send, journal: made.journal };
}

test('le journal garde l\'avant et les valeurs supprimées, « Effacer l\'historique » les vide sans rien casser', async () => {
  const { target, send, journal } = await copied();
  await send([['k1', 100, false, { Nom: 'Alice' }], ['k2', 100, false, { Nom: 'Bob' }], ['k3', 100, false, { Nom: 'Carl' }]]);
  await send([['k1', 200, false, { Nom: 'Alicia' }]]); // modification : l'avant est gardé
  await send([['k3', 300, true, { Nom: 'Carl' }]]); // suppression : la ligne part d'ici, ses valeurs restent dans le journal
  const dest = () => target.rows('Annuaire_recu').map(r => `${r[KEY_COL]}:${r.Nom}`).sort();
  assert.deepEqual(dest(), ['k1:Alicia', 'k2:Bob']);
  const versions = () => target.rows(journal).filter(r => r[KEY_COL]);
  const gone = () => versions().find(r => r[KEY_COL] === 'k3');
  assert.ok(versions().some(r => r[STATE_COL] === 'modif' && /Alice/.test(r[BEFORE_COL] || '')), 'l\'avant de la modification est dans le journal');
  assert.equal(gone()[STATE_COL], 'suppression');
  assert.match(gone()[DATA_COL], /Carl/, 'les valeurs de la ligne supprimée sont dans le journal');

  const done = await cleanJournal(journal);
  assert.deepEqual(done, { before: 2, values: 1 }, 'l\'avant de la modification et de la suppression, les valeurs de k3');
  assert.ok(versions().every(r => !r[BEFORE_COL]), 'plus aucun avant');
  assert.ok(!gone()[DATA_COL], 'valeurs supprimées vidées');
  assert.equal(gone()[STATE_COL], 'suppression', 'mais la version garde son état, sa clé et son heure');
  assert.ok(gone()[SEAL_COL], 'et son sceau');
  assert.equal(receivedJournals(await readSchema()).find(r => r.journal === journal).note.histo > 0, true, 'l\'heure d\'effacement est notée');
  // Les lignes d'ici ne bougent pas, et la recopie continue : la version vidée n'est pas prise pour une ligne forgée.
  assert.deepEqual(dest(), ['k1:Alicia', 'k2:Bob']);
  await send([['k2', 400, false, { Nom: 'Robert' }]]);
  assert.deepEqual(dest(), ['k1:Alicia', 'k2:Robert']);
  assert.equal(receivedJournals(await readSchema()).find(r => r.journal === journal).note.suspect, undefined, 'aucune arrivée suspecte');
  assert.ok(gone(), 'la version vidée est toujours dans le journal (le sceau est bon)');
  // Une version plus ancienne de k3 qui arriverait en retard ne ressuscite pas la ligne.
  await send([['k3', 150, false, { Nom: 'Carl' }]]);
  assert.deepEqual(dest(), ['k1:Alicia', 'k2:Robert'], 'k3 reste supprimée');
  // Ce qui est arrivé depuis (l'avant de la modification de k2) part au prochain effacement, puis il n'y a plus rien à vider.
  assert.deepEqual(await cleanJournal(journal), { before: 1, values: 0 });
  assert.deepEqual(await cleanJournal(journal), { before: 0, values: 0 });
});

test('SOURCE : effacer l\'historique d\'un export vide la note, sans toucher aux destinataires', async () => {
  const { source, as, exp, world } = await copied();
  as(source);
  await updateSourceNote(note => addEvent(addEvent(note, exp.id, { at: 1700000000, kind: 'join', who: 'cible@fake.local' }), exp.id, { at: 1700000100, kind: 'resend', n: 12 }));
  const had = eventsOf(readSourceNote(await readSchema()), exp.id).length; // l'ajout du destinataire, noté par l'approbation
  assert.equal(eventsOf(readSourceNote(await readSchema()), exp.id).length, had);
  assert.ok(had >= 1);
  const hooks = world.webhooks(source).length;
  const total = await clearExportHistory(exp.id);
  assert.deepEqual(total, { before: 0, values: 0 });
  const note = readSourceNote(await readSchema());
  assert.deepEqual(eventsOf(note, exp.id), []);
  const marks = eventsOf(note, exp.id, { all: true });
  assert.ok(marks.length >= 2 && marks.every(e => e.cleared && ['join', 'revoke'].includes(e.kind)), 'des repères d\'ajout seulement (celui du destinataire branché compris)');
  assert.equal(world.webhooks(source).length, hooks, 'le destinataire est toujours branché');
  assert.doesNotMatch(JSON.stringify(note.historique), /cible@fake|resend/);
});
