// La page du formulaire se range sous celle de la table qui reçoit, et le partage de ce formulaire garde de
// quoi dire qu'une réception a existé : si son journal est supprimé (avec ou sans la table qui reçoit), le
// widget ne repart plus de zéro sans rien dire. Deux documents en mémoire (engine-fake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSchema } from '../../js/engine/port.js';
import { createReception } from '../../js/engine/target/receive.js';
import { dismissLost, markReceptions, readLost } from '../../js/engine/target/lost.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { lostReceptions, readMark, renamedSince, shareTables } from '../../js/engine/logic/lost.js';
import { fakePair } from './engine-fake.mjs';
import { engineAs, exportAnnuaire, invite } from './engine-wire.mjs';

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
  const exp = await exportAnnuaire(world, source);
  const { invitation } = await invite({ world, target, exp });
  const plans = invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' }));
  const made = await createReception(invitation, plans, { reserve: true, options: {}, arrange });
  return { target, made, as: engineAs(world) };
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

// Journal renommé (retour d'un testeur, 19 novembre) : la SOURCE écrit toujours sous l'ancien nom, que Grist ne trouve plus.
test('journal renommé : la réception est dite renommée, pas supprimée, avec son nouveau nom', async () => {
  const { target } = await reception({ arrange: true });
  assert.equal((await readLost()).length, 0);
  target.apply([['RenameTable', 'Journal_Annuaire', 'Mon_journal']]);
  const [lost] = await readLost();
  assert.deepEqual([lost.journal, lost.name, lost.renamedTo, lost.recognized], ['Journal_Annuaire', 'Annuaire', 'Mon_journal', false]);
  assert.deepEqual(lost.dests, [{ dest: 'Annuaire_recu', there: true }]);
  // Rendu à son nom, il n'y a plus rien à dire.
  target.apply([['RenameTable', 'Mon_journal', 'Journal_Annuaire']]);
  assert.deepEqual(await readLost(), []);
});

test('journal supprimé : jamais dit renommé, même si une autre table a un nom qui y ressemble', async () => {
  const { target } = await reception({ arrange: true });
  target.addTable('Mon_journal', [{ id: 'x', type: 'Text' }]);
  target.apply([['RemoveTable', 'Journal_Annuaire']]);
  const [lost] = await readLost();
  assert.deepEqual([lost.renamedTo, lost.recognized], ['', false]);
});

test('journal renommé en gardant le préfixe : le widget le connaît encore, mais la réception est dite renommée', async () => {
  const { target } = await reception({ arrange: true });
  target.apply([['RenameTable', 'Journal_Annuaire', 'Journal_annuaire2']]);
  const [lost] = await readLost();
  assert.deepEqual([lost.journal, lost.renamedTo, lost.recognized], ['Journal_Annuaire', 'Journal_annuaire2', true]);
  assert.deepEqual(receivedJournals(await readSchema()).map(r => r.journal), ['Journal_annuaire2'], 'il reste une réception pour le widget');
});

test('markReceptions : un journal renommé garde la marque, qui dit le nom que la SOURCE vise ; rendu à son nom, elle suit de nouveau', async () => {
  const { target } = await reception({ arrange: true });
  target.apply([['RenameTable', 'Journal_Annuaire', 'Journal_annuaire2']]);
  const receptions = receivedJournals(await readSchema());
  assert.equal(await markReceptions(receptions), false, 'la marque n\'est pas réécrite au nouveau nom');
  assert.equal(readMark(target.fetchRows('_grist_Shares')[0].description).journal, 'Journal_Annuaire');
  assert.equal((await readLost()).length, 1, 'et la réception reste signalée');
  target.apply([['RenameTable', 'Journal_annuaire2', 'Journal_Annuaire']]);
  assert.deepEqual(await readLost(), []);
  receptions[0].journal = 'Journal_Annuaire';
  receptions[0].note.tables.push({ table: 'Villes', dest: 'Villes_recu', columns: [] });
  assert.equal(await markReceptions(receptions), true, 'à son nom d\'origine, la marque est tenue à jour');
});

test('renamedSince : seulement quand la marque cite un journal qui n\'existe plus sous ce nom', () => {
  const schema = { has: id => id === 'Journal_B' };
  assert.equal(renamedSince(schema, { journal: 'Journal_A' }, 'Journal_B'), true);
  assert.equal(renamedSince(schema, { journal: 'Journal_B' }, 'Journal_B'), false, 'même nom');
  assert.equal(renamedSince({ has: () => true }, { journal: 'Journal_A' }, 'Journal_B'), false, 'l\'ancien nom existe encore (autre table)');
  assert.equal(renamedSince(schema, null, 'Journal_B'), false, 'pas de marque');
});

test('shareTables : la table du formulaire de chaque partage ; une page de plusieurs formulaires ne dit rien', () => {
  const forms = new Map([['Journal_A', { viewRef: 1, shared: 0 }], ['Journal_B', { viewRef: 2, shared: 1 }], ['Journal_C', { viewRef: 3, shared: 0 }]]);
  const pages = [{ viewRef: 1, shareRef: 10 }, { viewRef: 2, shareRef: 11 }, { viewRef: 3, shareRef: 0 }];
  assert.deepEqual([...shareTables(forms, pages)], [[10, 'Journal_A']]);
});

test('lostReceptions : sans table de formulaire connue, un journal absent reste « supprimé »', async () => {
  const { target } = await reception({ arrange: true });
  target.apply([['RenameTable', 'Journal_Annuaire', 'Mon_journal']]);
  const [lost] = lostReceptions(await readSchema(), target.fetchRows('_grist_Shares'));
  assert.equal(lost.renamedTo, '');
});
