// La page du formulaire se range sous celle de la table qui reçoit, et le partage de ce formulaire garde de
// quoi dire qu'une réception a existé : si son journal est supprimé (avec ou sans la table qui reçoit), le
// widget ne repart plus de zéro sans rien dire. Deux documents en mémoire (engine-fake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { readSchema } from '../../js/engine/port.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { createReception, readInvitation } from '../../js/engine/target/receive.js';
import { dismissLost, markReceptions, readLost } from '../../js/engine/target/lost.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { readMark } from '../../js/engine/logic/lost.js';
import { fakePair } from './engine-fake.mjs';

// Une CIBLE qui a une table `Annuaire_recu` sur sa page, puis une autre page, et qui reçoit un export.
async function reception({ arrange }) {
  const { world, source, target } = fakePair('10');
  target.addTable('Annuaire_recu', [{ id: 'Nom', type: 'Text' }]);
  const tableRef = target.fetchRows('_grist_Tables').find(tb => tb.tableId === 'Annuaire_recu').id;
  const view = target.apply([['AddRecord', '_grist_Views', null, { name: 'Annuaire_recu' }]]).retValues[0];
  target.apply([['AddRecord', '_grist_Views_section', null, { parentId: view, parentKey: 'record', tableRef }]]);
  const other = target.apply([['AddRecord', '_grist_Views', null, { name: 'Autre page' }]]).retValues[0];
  target.apply([['AddRecord', '_grist_Pages', null, { viewRef: view, shareRef: 0, indentation: 0, pagePos: 1 }],
    ['AddRecord', '_grist_Pages', null, { viewRef: other, shareRef: 0, indentation: 0, pagePos: 2 }]]);
  const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });
  as(source);
  const { created: exp } = await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom'], filter: null }] });
  const { entry, secret } = await startInvitation(exp);
  const { code } = await invitationCode(exp, entry, secret);
  as(target);
  const invitation = await readInvitation(code);
  const plans = invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' }));
  const made = await createReception(invitation, plans, { reserve: true, options: {}, arrange });
  return { target, made, as };
}

const order = target => {
  const views = new Map(target.fetchRows('_grist_Views').map(v => [v.id, v.name]));
  return target.fetchRows('_grist_Pages').sort((a, b) => a.pagePos - b.pagePos).map(p => `${p.indentation}:${views.get(p.viewRef)}`);
};

test('arrange : la page du formulaire vient juste sous celle de la table qui reçoit', async () => {
  const { target } = await reception({ arrange: true });
  assert.deepEqual(order(target), ['0:Annuaire_recu', '0:Journal_Annuaire', '0:Autre page']);
});

test('sans arrange : la page reste en fin de liste, comme avant', async () => {
  const { target, made } = await reception({ arrange: false });
  assert.deepEqual(order(target), ['0:Annuaire_recu', '0:Autre page', '0:Journal_Annuaire']);
  assert.deepEqual(target.fetchRows('_grist_Shares').map(s => s.description || ''), [''], 'ni marque sur le partage');
  assert.deepEqual(await readLost(), [], made.journal);
});

test('le partage du formulaire garde la marque de la réception, jamais un secret', async () => {
  const { target, made } = await reception({ arrange: true });
  const [share] = target.fetchRows('_grist_Shares');
  assert.deepEqual(readMark(share.description), { journal: 'Journal_Annuaire', name: 'Annuaire', dests: ['Annuaire_recu'] });
  assert.ok(!share.description.includes(made.note.secret), 'le secret de l\'invitation n\'y est pas');
  assert.deepEqual(await readLost(), [], 'journal présent : rien de perdu');
});

test('journal supprimé : la réception est dite perdue, avec ce qui reste de ses tables', async () => {
  const { target } = await reception({ arrange: true });
  target.apply([['RemoveTable', 'Journal_Annuaire']]);
  const [lost] = await readLost();
  assert.equal(lost.journal, 'Journal_Annuaire');
  assert.equal(lost.name, 'Annuaire');
  assert.deepEqual(lost.dests, [{ dest: 'Annuaire_recu', there: true }], 'la table reçue est encore là');
  target.apply([['RemoveTable', 'Annuaire_recu']]);
  assert.deepEqual((await readLost())[0].dests, [{ dest: 'Annuaire_recu', there: false }], 'puis elle est supprimée aussi');
  assert.equal((await readLost()).length, 1, 'une seule réception, même relue');
});

test('retirer l\'avis efface le partage (et son ancienne clé) : plus rien n\'est perdu', async () => {
  const { target } = await reception({ arrange: true });
  target.apply([['RemoveTable', 'Journal_Annuaire']]);
  const [lost] = await readLost();
  await dismissLost(lost);
  assert.deepEqual(await readLost(), []);
  assert.deepEqual(target.fetchRows('_grist_Shares'), []);
});

test('une réception recréée sous le même nom n\'est plus perdue', async () => {
  const { target, made } = await reception({ arrange: true });
  target.apply([['RemoveTable', 'Journal_Annuaire']]);
  assert.equal((await readLost()).length, 1);
  target.addTable(made.journal, [{ id: 'x', type: 'Text' }]);
  assert.deepEqual(await readLost(), []);
});

test('markReceptions : ajoute la marque à une réception d\'avant, la tient à jour, ne réécrit pas une marque juste', async () => {
  const { target } = await reception({ arrange: false });
  const receptions = receivedJournals(await readSchema());
  assert.equal(await markReceptions(receptions), true, 'la réception d\'avant n\'avait pas de marque');
  assert.equal(readMark(target.fetchRows('_grist_Shares')[0].description).journal, 'Journal_Annuaire');
  assert.equal(await markReceptions(receptions), false, 'rien à écrire la deuxième fois');
  receptions[0].note.tables.push({ table: 'Villes', dest: 'Villes_recu', columns: [] });
  assert.equal(await markReceptions(receptions), true, 'une table rangée plus tard change la liste');
  assert.deepEqual(readMark(target.fetchRows('_grist_Shares')[0].description).dests, ['Annuaire_recu', 'Villes_recu']);
  // Réception en lien public ou retour d'Échange : pas de formulaire, pas de marque.
  assert.equal(await markReceptions([{ journal: 'Journal_Annuaire', note: { ...receptions[0].note, mode: 'public' } }]), false);
  assert.equal(await markReceptions([{ journal: 'Journal_Annuaire', note: { ...receptions[0].note, retour: true } }]), false);
});

test('une description d\'une autre personne ou abîmée n\'est jamais prise pour une marque', () => {
  for (const text of ['', 'bonjour', '{"syncPlus":null}', '{"syncPlus":{"journal":"a b"}}', '{"syncPlus":{"journal":"X;DROP"}}', '[]', 'null']) assert.equal(readMark(text), null, text);
  assert.deepEqual(readMark('{"syncPlus":{"journal":"Journal_X","name":"Annu‮aire","dests":["A","b c",7]}}'), { journal: 'Journal_X', name: 'Annu aire', dests: ['A'] });
});
