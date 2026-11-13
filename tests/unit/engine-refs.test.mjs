// Références entre tables, de bout en bout sur deux documents en mémoire : la SOURCE (Contacts qui vise Villes par une
// Référence et Services par une Liste de références) garde le lien de la colonne de son choix, la table visée s'ajoute à
// l'export avec sa seule colonne affichée ; la CIBLE refait des Références (Listes de références) vers les tables reçues,
// complète les cellules à l'arrivée d'une ligne visée, laisse du texte une colonne déjà remplie jusqu'à « Refaire les références ».
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { signText } from '../../js/engine/logic/trust.js';
import { syncRows } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { consolidateAll, relink, state, tableKey } from '../../js/engine/target/loop.js';
import { linkOffers } from '../../js/engine/logic/links.js';
import { exportableColumns } from '../../js/engine/logic/exports.js';
import { pullColumns } from '../../js/source/pull.js';
import { readSchema } from '../../js/engine/port.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

const world = fakeWorld();
const source = fakeDoc({ docId: 'sourcedoclnk1', name: 'Annuaire source', email: 'source@fake.local' });
const target = fakeDoc({ docId: 'targetdoclnk2', name: 'Annuaire copie', email: 'cible@fake.local' });
const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });
const columnId = (doc, table, colId) => doc.fetchRows('_grist_Tables_column').find(c => c.colId === colId && doc.tables.get(table).columns.some(x => x.id === c.id)).id;
const typeOf = (doc, table, colId) => doc.tables.get(table).columns.find(c => c.colId === colId).type;

source.addTable('Villes', [{ id: 'Nom', type: 'Text' }, { id: 'Pays', type: 'Text' }], [{ Nom: 'Lyon', Pays: 'France' }, { Nom: 'Paris', Pays: 'France' }]);
source.addTable('Services', [{ id: 'Libelle', type: 'Text' }, { id: 'Budget', type: 'Numeric' }], [{ Libelle: 'Compta', Budget: 1 }, { Libelle: 'RH', Budget: 2 }, { Libelle: 'IT', Budget: 3 }]);
source.addTable('Contacts', [
  { id: 'Nom', type: 'Text' },
  { id: 'Ville', type: 'Ref:Villes', visibleCol: columnId(source, 'Villes', 'Nom') },
  { id: 'Services', type: 'RefList:Services', visibleCol: columnId(source, 'Services', 'Libelle') },
], [{ Nom: 'Alice', Ville: 1, Services: ['L', 1, 2] }]);

const story = {};
// La description d'une table de l'export (lue dans la SOURCE).
const lotOf = async (table, exp = story.exp) => { as(source); return (await syncRows()).find(r => r[EXPORT_COL] === exp.id && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === table); };

test('références entre tables : SOURCE puis CIBLE', async (t) => {
  await t.test('SOURCE : la personne garde les liens de Ville et de Services, les tables visées s\'ajoutent avec leur seule colonne affichée', async () => {
    as(source);
    const schema = await readSchema();
    const columnsOf = table => exportableColumns(schema.columns(table));
    const offers = linkOffers({ chosen: ['Contacts'], columnsOf, picked: table => (table === 'Contacts' ? ['Nom', 'Ville', 'Services'] : undefined), choices: new Map([['Contacts.Ville', true], ['Contacts.Services', true]]) });
    assert.deepEqual([...offers.pulled], [['Villes', ['Nom']], ['Services', ['Libelle']]]);
    const selection = [{ table: 'Contacts', columns: ['Nom', 'Ville', 'Services'], filter: null },
      ...[...offers.pulled].map(([table, columns]) => ({ table, columns, filter: null }))];
    const saved = await saveChosenExport({ name: 'Annuaire', selection, links: new Set(offers.rows.filter(r => r.link).map(r => r.key)) });
    story.exp = saved.created;
    const columns = JSON.parse((await lotOf('Contacts'))[SCHEMA_COL]);
    assert.deepEqual(columns.map(c => [c.id, c.link || null, c.source]), [['Nom', null, 'Text'], ['Ville', 'Villes', 'Ref:Villes'], ['Services', 'Services', 'RefList:Services']]);
    assert.deepEqual(JSON.parse((await lotOf('Villes'))[SCHEMA_COL]).map(c => c.id), ['Nom'], 'Pays ne part pas');
    assert.deepEqual(JSON.parse((await lotOf('Services'))[SCHEMA_COL]).map(c => c.id), ['Libelle']);
  });

  await t.test('SOURCE : la table ajoutée pour un lien peut partir en entier (toute la table) ou avec des colonnes au choix', async () => {
    as(source);
    const schema = await readSchema();
    const columnsOf = table => exportableColumns(schema.columns(table));
    const picked = mode => table => (table === 'Contacts' ? ['Nom', 'Services'] : pullColumns({ mode, usable: columnsOf(table), extras: ['Budget'] }));
    for (const [mode, expected] of [['all', ['Libelle', 'Budget']], ['pick', ['Libelle', 'Budget']], ['shown', ['Libelle']]]) {
      const offers = linkOffers({ chosen: ['Contacts'], columnsOf, picked: picked(mode), choices: new Map([['Contacts.Services', true]]) });
      const selection = [{ table: 'Contacts', columns: ['Nom', 'Services'], filter: null },
        ...[...offers.pulled].map(([table, required]) => ({ table, columns: pullColumns({ mode, usable: columnsOf(table), required, extras: ['Budget'] }), filter: null }))];
      const saved = await saveChosenExport({ name: `Services ${mode}`, selection, links: new Set(offers.rows.filter(r => r.link).map(r => r.key)) });
      assert.deepEqual(JSON.parse((await lotOf('Services', saved.created))[SCHEMA_COL]).map(c => c.id), expected, `Services : ${mode}`);
      assert.deepEqual(JSON.parse((await lotOf('Contacts', saved.created))[SCHEMA_COL]).map(c => [c.id, c.link || null]), [['Nom', null], ['Services', 'Services']], `le lien est gardé : ${mode}`);
    }
  });

  await t.test('SOURCE : sans choix, aucune table ne s\'ajoute et aucun lien ne part', async () => {
    as(source);
    const saved = await saveChosenExport({ name: 'Valeurs', selection: [{ table: 'Contacts', columns: ['Nom', 'Ville', 'Services'], filter: null }], links: new Set() });
    const lot = (await syncRows()).find(r => r[EXPORT_COL] === saved.created.id && r[TYPE_COL] === KIND.lot);
    assert.deepEqual(JSON.parse(lot[SCHEMA_COL]).filter(c => c.link), []);
    assert.equal(saved.tables.length, 1);
  });

  await t.test('SOURCE puis CIBLE : invitation, réception, webhook', async () => {
    const { entry, secret } = await startInvitation(story.exp);
    const { code } = await invitationCode(story.exp, entry, secret);
    as(target);
    const invitation = await readInvitation(code);
    const plans = invitation.tables.map(tb => ({ tb, dest: `${tb.table}_recu` }));
    await checkDestinations(invitation, plans);
    story.made = await createReception(invitation, plans, { reserve: false, options: {} });
    const { code: reply } = await receptionReply(story.made, world.formLink(target, story.made.journal));
    as(source);
    story.accepted = await checkReply(story.exp, entry, reply);
    await approveReply(story.exp, entry, story.accepted);
  });

  const deliver = async (table, lines) => {
    const lot = await lotOf(table);
    const row = { [EXPORT_COL]: story.exp.id, [TABLE_COL]: table, [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lot[SCHEMA_COL] };
    world.deliver(story.accepted.url, [{ ...row, [LOT_COL]: await signText(story.accepted.keys.down, row, JSON.stringify({ lignes: lines, total: lines.length })) }]);
  };
  const ids = (table, column, value) => target.rows(table).find(r => r[column] === value).id;

  await t.test('CIBLE : les colonnes deviennent une Référence et une Liste de références vers les tables reçues', async () => {
    await deliver('Villes', [['v1', 100, false, { Nom: 'Lyon' }], ['v2', 100, false, { Nom: 'Paris' }]]);
    await deliver('Services', [['s1', 100, false, { Libelle: 'Compta' }], ['s2', 100, false, { Libelle: 'RH' }]]);
    await deliver('Contacts', [
      ['c1', 100, false, { Nom: 'Alice', Ville: 'Lyon', Services: 'Compta, RH', Synchro_Cle_Ville: 'v1', Synchro_Cle_Services: ['s1', 's2'] }],
      ['c2', 100, false, { Nom: 'Bob', Ville: 'Paris', Services: 'RH, IT', Synchro_Cle_Ville: 'v2', Synchro_Cle_Services: ['s2', 's3'] }],
    ]);
    as(target);
    await consolidateAll();
    assert.equal(typeOf(target, 'Contacts_recu', 'Ville'), 'Ref:Villes_recu');
    assert.equal(typeOf(target, 'Contacts_recu', 'Services'), 'RefList:Services_recu');
    const alice = target.rows('Contacts_recu').find(r => r.Nom === 'Alice');
    assert.equal(alice.Ville, ids('Villes_recu', 'Nom', 'Lyon'));
    assert.deepEqual(alice.Services, ['L', ids('Services_recu', 'Libelle', 'Compta'), ids('Services_recu', 'Libelle', 'RH')]);
    const bob = target.rows('Contacts_recu').find(r => r.Nom === 'Bob');
    assert.deepEqual(bob.Services, ['L', ids('Services_recu', 'Libelle', 'RH')], 'IT n\'est pas encore arrivée : la liste est incomplète');
  });

  await t.test('CIBLE : la ligne visée qui arrive ensuite complète la liste', async () => {
    await deliver('Services', [['s3', 101, false, { Libelle: 'IT' }]]);
    as(target);
    await consolidateAll();
    const bob = target.rows('Contacts_recu').find(r => r.Nom === 'Bob');
    assert.deepEqual(bob.Services, ['L', ids('Services_recu', 'Libelle', 'RH'), ids('Services_recu', 'Libelle', 'IT')]);
    const result = state.results.get(tableKey(story.made.journal, 'Contacts'));
    assert.deepEqual(result.links.map(s => [s.to, s.list]), [['Ville', false], ['Services', true]]);
    assert.deepEqual(result.relinkable, []);
    await consolidateAll({ reread: true });
    assert.deepEqual(target.rows('Contacts_recu').find(r => r.Nom === 'Bob').Services, bob.Services, 'un passage de plus ne change rien');
  });

  await t.test('CIBLE : une colonne déjà remplie de texte reste du texte, « Refaire les références » la convertit', async () => {
    // Un second journal de la même SOURCE : l'export d'abord sans lien, la colonne Services est remplie de texte.
    as(source);
    const plain = await saveChosenExport({ name: 'Texte', selection: [{ table: 'Contacts', columns: ['Nom', 'Services'], filter: null }, { table: 'Services', columns: ['Libelle'], filter: null }], links: new Set() });
    story.plain = plain.created;
    const { entry, secret } = await startInvitation(story.plain);
    const { code } = await invitationCode(story.plain, entry, secret);
    as(target);
    const invitation = await readInvitation(code);
    const plans = invitation.tables.map(tb => ({ tb, dest: `${tb.table}_texte` }));
    await checkDestinations(invitation, plans);
    story.second = await createReception(invitation, plans, { reserve: false, options: {} });
    const { code: reply } = await receptionReply(story.second, world.formLink(target, story.second.journal));
    as(source);
    story.acceptedPlain = await checkReply(story.plain, entry, reply);
    await approveReply(story.plain, entry, story.acceptedPlain);
    const send = async (exp, accepted, table, lines, schemaText) => {
      const row = { [EXPORT_COL]: exp.id, [TABLE_COL]: table, [TYPE_COL]: KIND.lot, [SCHEMA_COL]: schemaText };
      world.deliver(accepted.url, [{ ...row, [LOT_COL]: await signText(accepted.keys.down, row, JSON.stringify({ lignes: lines, total: lines.length })) }]);
    };
    const schemaOf = async (exp, table) => (await syncRows()).find(r => r[EXPORT_COL] === exp.id && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === table)[SCHEMA_COL];
    await send(story.plain, story.acceptedPlain, 'Services', [['s1', 100, false, { Libelle: 'Compta' }], ['s2', 100, false, { Libelle: 'RH' }]], await schemaOf(story.plain, 'Services'));
    await send(story.plain, story.acceptedPlain, 'Contacts', [['c1', 100, false, { Nom: 'Alice', Services: 'Compta, RH' }]], await schemaOf(story.plain, 'Contacts'));
    as(target);
    await consolidateAll();
    assert.equal(typeOf(target, 'Contacts_texte', 'Services'), 'Text');
    assert.equal(target.rows('Contacts_texte')[0].Services, 'Compta, RH');
    // La SOURCE garde maintenant le lien de Services : l'export est modifié, la ligne repart avec les clés citées.
    as(source);
    await saveChosenExport({ exp: story.plain, name: 'Texte', selection: [{ table: 'Contacts', columns: ['Nom', 'Services'], filter: null }, { table: 'Services', columns: ['Libelle'], filter: null }], links: new Set(['Contacts.Services']) });
    await send(story.plain, story.acceptedPlain, 'Contacts', [['c1', 101, false, { Nom: 'Alice', Services: 'Compta, RH', Synchro_Cle_Services: ['s1', 's2'] }]], await schemaOf(story.plain, 'Contacts'));
    as(target);
    await consolidateAll({ reread: true });
    assert.equal(typeOf(target, 'Contacts_texte', 'Services'), 'Text', 'rien n\'est touché sans accord');
    const result = state.results.get(tableKey(story.second.journal, 'Contacts'));
    assert.deepEqual(result.relinkable.map(s => [s.to, s.list]), [['Services', true]]);
    await relink(story.second.journal);
    assert.equal(typeOf(target, 'Contacts_texte', 'Services'), 'RefList:Services_texte');
    assert.deepEqual(target.rows('Contacts_texte')[0].Services, ['L', ids('Services_texte', 'Libelle', 'Compta'), ids('Services_texte', 'Libelle', 'RH')]);
    assert.deepEqual(state.results.get(tableKey(story.second.journal, 'Contacts')).relinkable, []);
  });
});
