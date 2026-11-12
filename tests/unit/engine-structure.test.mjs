// Changements de structure côté CIBLE (voir logic/structure.js), de bout en bout sur deux documents en mémoire : une réception qui
// « demande » (`ask`) ne crée pas la colonne que la SOURCE ajoute à l'export, mais la propose ; « Appliquer » la crée et la remplit
// depuis les versions déjà reçues ; une colonne que la SOURCE n'envoie plus est dite, une fois. Une réception qui ne demande pas
// (comme avant) crée la colonne toute seule. Puis la logique pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { backfillActions, acknowledged, structureChanges } from '../../js/engine/logic/structure.js';
import { optionsNote, receivedJournals } from '../../js/engine/logic/received.js';
import { signText } from '../../js/engine/logic/trust.js';
import { readSchema } from '../../js/engine/port.js';
import { syncRows } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { approveStructure, consolidateAll, state, tableKey } from '../../js/engine/target/loop.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

// Une SOURCE (table Fiches : Nom, Ville) et une CIBLE ; `ask` : la réception demande l'accord. Rend de quoi livrer des lots.
async function pair(tag, options) {
  const world = fakeWorld();
  const source = fakeDoc({ docId: `source${tag}docx`, name: `Source ${tag}`, email: 'source@fake.local' });
  const target = fakeDoc({ docId: `target${tag}docx`, name: `Cible ${tag}`, email: 'cible@fake.local' });
  const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });
  source.addTable('Fiches', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], [{ Nom: 'Alice', Ville: 'Lyon' }]);
  as(source);
  const saved = await saveChosenExport({ name: 'Fiches', selection: [{ table: 'Fiches', columns: ['Nom', 'Ville'], filter: null }] });
  const { entry, secret } = await startInvitation(saved.created);
  const { code } = await invitationCode(saved.created, entry, secret);
  as(target);
  const invitation = await readInvitation(code);
  const plans = invitation.tables.map(tb => ({ tb, dest: 'Fiches_recu' }));
  await checkDestinations(invitation, plans);
  const made = await createReception(invitation, plans, { reserve: false, options });
  const { code: reply } = await receptionReply(made, world.formLink(target, made.journal));
  as(source);
  const accepted = await checkReply(saved.created, entry, reply);
  await approveReply(saved.created, entry, accepted);
  const lot = (await syncRows()).find(r => r[EXPORT_COL] === saved.id && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Fiches');
  // `columns` : les colonnes que l'export décrit à ce moment-là (la SOURCE en ajoute ou en retire) ; `rows` : [clé, heure, supprimée, données].
  const deliver = async (columns, rows) => {
    const row = { [EXPORT_COL]: saved.id, [TABLE_COL]: 'Fiches', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: JSON.stringify(columns) };
    world.deliver(accepted.url, [{ ...row, [LOT_COL]: await signText(accepted.keys.down, row, JSON.stringify({ lignes: rows, total: rows.length })) }]);
  };
  const base = JSON.parse(lot[SCHEMA_COL]);
  const column = id => ({ id, type: 'Text', label: id, source: 'Text', visible: '' });
  return { source, target, made, as, deliver, base, column };
}

const journalNote = async () => receivedJournals(await readSchema())[0].note;
const resultOf = made => state.results.get(tableKey(made.journal, 'Fiches'));
const columnsOf = doc => doc.tables.get('Fiches_recu').columns.map(c => c.colId).filter(id => id !== 'id_sync');

test('réception qui demande l\'accord : la colonne ajoutée à la SOURCE attend un clic, puis se remplit', async (t) => {
  const p = await pair('ask1', { ask: true });
  const lines = [['k1', 100, false, { Nom: 'Alice', Ville: 'Lyon' }], ['k2', 100, false, { Nom: 'Bob', Ville: 'Nice' }]];
  await t.test('la note garde le choix, la première livraison est recopiée', async () => {
    await p.deliver(p.base, lines);
    p.as(p.target);
    await consolidateAll();
    assert.equal((await journalNote()).ask, true);
    assert.deepEqual(p.target.rows('Fiches_recu').map(r => [r.Nom, r.Ville]).sort(), [['Alice', 'Lyon'], ['Bob', 'Nice']]);
    assert.equal(resultOf(p.made).structure, null, 'rien à décider');
  });
  const more = [...p.base, p.column('Pays')];
  await t.test('une colonne ajoutée est proposée, pas créée ; les lignes continuent d\'arriver', async () => {
    await p.deliver(more, [['k1', 200, false, { Nom: 'Alice', Ville: 'Lyon', Pays: 'France' }], ['k2', 200, false, { Nom: 'Bob', Ville: 'Nice', Pays: 'France' }],
      ['k3', 200, false, { Nom: 'Chloé', Ville: 'Lille', Pays: 'France' }]]);
    p.as(p.target);
    await consolidateAll({ reread: true });
    assert.deepEqual(columnsOf(p.target), ['Nom', 'Ville'], 'la colonne n\'est pas créée');
    assert.deepEqual(resultOf(p.made).structure.held, [{ id: 'Pays', to: 'Pays', label: 'Pays', type: 'Text' }]);
    assert.deepEqual(p.target.rows('Fiches_recu').map(r => r.Nom).sort(), ['Alice', 'Bob', 'Chloé'], 'une ligne nouvelle arrive sans la colonne');
    assert.deepEqual((await journalNote()).tables[0].map, undefined, 'rien n\'est rangé');
  });
  await t.test('« Appliquer » crée la colonne, la remplit pour toutes les lignes, et les valeurs retouchées ne bougent pas', async () => {
    p.as(p.target);
    p.target.apply([['BulkUpdateRecord', 'Fiches_recu', [p.target.rows('Fiches_recu').find(r => r.Nom === 'Bob').id], { Ville: ['Retouchée'] }]]);
    await approveStructure(p.made.journal);
    assert.deepEqual(columnsOf(p.target), ['Nom', 'Ville', 'Pays']);
    assert.deepEqual(p.target.rows('Fiches_recu').map(r => [r.Nom, r.Pays, r.Ville]).sort(), [['Alice', 'France', 'Lyon'], ['Bob', 'France', 'Retouchée'], ['Chloé', 'France', 'Lille']]);
    assert.equal(resultOf(p.made).structure, null);
    const entry = (await journalNote()).tables[0];
    assert.deepEqual([entry.map, entry.own.includes('Pays')], [{ Pays: 'Pays' }, true]);
    assert.equal((await journalNote()).ask, true, 'la réception continue de demander');
  });
  await t.test('une colonne que la SOURCE n\'envoie plus est dite jusqu\'à « Appliquer »', async () => {
    await p.deliver([p.base[0], p.column('Pays')], [['k1', 300, false, { Nom: 'Alice', Pays: 'Belgique' }]]);
    p.as(p.target);
    await consolidateAll({ reread: true });
    assert.deepEqual(resultOf(p.made).structure.gone, [{ id: 'Ville', to: 'Ville' }]);
    assert.deepEqual(columnsOf(p.target), ['Nom', 'Ville', 'Pays'], 'la colonne reste ici');
    await approveStructure(p.made.journal);
    assert.equal(resultOf(p.made).structure, null, 'vu, plus répété');
    await consolidateAll({ reread: true });
    assert.equal(resultOf(p.made).structure, null);
  });
  await t.test('« Appliquer » et traiter automatiquement : la réception ne demande plus, la colonne suivante se crée seule', async () => {
    p.as(p.source);
    await p.deliver([p.base[0], p.column('Pays'), p.column('Age')], [['k1', 400, false, { Nom: 'Alice', Pays: 'Belgique', Age: '30' }]]);
    p.as(p.target);
    await consolidateAll({ reread: true });
    assert.equal(resultOf(p.made).structure.held[0].id, 'Age');
    await approveStructure(p.made.journal, { auto: true });
    assert.equal((await journalNote()).ask, undefined, 'la réception n\'est plus à valider');
    assert.deepEqual(columnsOf(p.target), ['Nom', 'Ville', 'Pays', 'Age']);
    assert.equal(p.target.rows('Fiches_recu').find(r => r.Nom === 'Alice').Age, '30');
    await p.deliver([p.base[0], p.column('Pays'), p.column('Age'), p.column('Rue')], [['k1', 500, false, { Nom: 'Alice', Pays: 'Belgique', Age: '30', Rue: 'Rue Neuve' }]]);
    await consolidateAll({ reread: true });
    assert.deepEqual(columnsOf(p.target), ['Nom', 'Ville', 'Pays', 'Age', 'Rue'], 'créée sans demander');
  });
});

test('réception qui ne demande pas (comme avant) : la colonne ajoutée est créée au passage suivant', async () => {
  const p = await pair('auto1', {});
  await p.deliver(p.base, [['k1', 100, false, { Nom: 'Alice', Ville: 'Lyon' }]]);
  p.as(p.target);
  await consolidateAll();
  await p.deliver([...p.base, p.column('Pays')], [['k1', 200, false, { Nom: 'Alice', Ville: 'Lyon', Pays: 'France' }]]);
  await consolidateAll({ reread: true });
  assert.deepEqual(columnsOf(p.target), ['Nom', 'Ville', 'Pays']);
  assert.equal(p.target.rows('Fiches_recu')[0].Pays, 'France');
  assert.equal(resultOf(p.made).structure, null);
});

test('logique pure : avis, accord, remplissage', () => {
  assert.deepEqual(optionsNote({ ask: true }), { ask: true });
  assert.deepEqual(optionsNote({ ask: false, archive: true }), { archive: true });
  const entry = { columns: [{ id: 'Nom' }, { id: 'Ville' }], map: {}, own: ['Nom', 'Ville'] };
  const here = [{ colId: 'Nom', type: 'Text' }, { colId: 'Ville', type: 'Text' }];
  assert.equal(structureChanges(entry, { all: [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], described: true, here }), null);
  const gone = structureChanges(entry, { all: [{ id: 'Nom', type: 'Text' }], described: true, here });
  assert.deepEqual(gone.gone, [{ id: 'Ville', to: 'Ville' }]);
  assert.equal(structureChanges(entry, { all: [{ id: 'Nom', type: 'Text' }], described: false, here }), null, 'sans description reçue, rien n\'a disparu');
  const typed = structureChanges(entry, { all: [{ id: 'Nom', type: 'Numeric' }, { id: 'Ville', type: 'Text' }], described: true, here });
  assert.deepEqual(typed.retyped, [{ id: 'Nom', to: 'Nom', sent: 'Numeric', here: 'Text' }]);
  assert.equal(structureChanges({ ...entry, own: [] }, { all: [{ id: 'Nom', type: 'Numeric' }, { id: 'Ville', type: 'Text' }], described: true, here }), null, 'une colonne choisie par la personne garde son type');
  assert.equal(structureChanges(entry, { all: [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], described: true, here: [here[0], { colId: 'Ville', type: 'Ref:Villes' }] }), null, 'une Référence conservée n\'est pas un changement de type');
  assert.deepEqual(acknowledged(entry, typed), ['type:Nom:Numeric']);
  assert.deepEqual(acknowledged({ ...entry, ack: ['gone:Ville'] }, gone), ['gone:Ville']);
  const seen = { ...entry, ack: acknowledged(entry, typed) };
  assert.equal(structureChanges(seen, { all: [{ id: 'Nom', type: 'Numeric' }, { id: 'Ville', type: 'Text' }], described: true, here }), null, 'vu');
  assert.notEqual(structureChanges(seen, { all: [{ id: 'Nom', type: 'Date' }, { id: 'Ville', type: 'Text' }], described: true, here }), null, 'un autre changement est dit');
  const journalRows = [{ id: 1, id_sync: 'a', Pays: 'FR', MajLe: 1 }, { id: 2, id_sync: 'b', Pays: '', MajLe: 1 }, { id: 3, id_sync: 'c', Pays: 'BE', Supprime: true, MajLe: 1 }];
  const destRows = [{ id: 10, id_sync: 'a', Pays: null }, { id: 11, id_sync: 'b', Pays: null }, { id: 12, id_sync: 'c', Pays: null }, { id: 13, id_sync: '', Pays: null }, { id: 14, id_sync: 'a', Pays: 'DE' }];
  assert.deepEqual(backfillActions({ journalRows, destRows, specs: [{ from: 'Pays', to: 'Pays' }], destTable: 'Dest' }), [['BulkUpdateRecord', 'Dest', [10], { Pays: ['FR'] }]],
    'seulement une cellule vide dont la version a une valeur ; ligne supprimée, ligne sans clé et cellule remplie ne bougent pas');
});
