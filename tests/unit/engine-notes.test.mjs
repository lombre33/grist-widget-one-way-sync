// Descriptions des colonnes et de la table, de bout en bout sur deux documents en mémoire : la SOURCE (une table Budget
// dont les colonnes et la table ont une description) les envoie dans la description signée des colonnes ; la CIBLE les
// pose sur ce que le widget crée, une seule fois, sans écraser ce qu'elle a retouché ; « Reprendre depuis la SOURCE »
// remet tout d'accord, élément par élément. Puis la logique pure : texte nettoyé et borné, rien d'envoyé sans la case.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { NOTE_MAX, TABLE_NOTE_MAX, cleanNote, noteSent, planNotes, sentElements, tableNoteOf, withTableNote } from '../../js/engine/logic/descriptions.js';
import { exportSchema } from '../../js/engine/logic/codes.js';
import { signText } from '../../js/engine/logic/trust.js';
import { readSchema } from '../../js/engine/port.js';
import { refreshOptions, syncRows } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { consolidateAll, restyle } from '../../js/engine/target/loop.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

const world = fakeWorld();
const source = fakeDoc({ docId: 'sourcedocnote1', name: 'Budget source', email: 'source@fake.local' });
const target = fakeDoc({ docId: 'targetdocnote2', name: 'Budget copie', email: 'cible@fake.local' });
const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });

const columnOf = (doc, table, colId) => doc.fetchRows('_grist_Tables_column').find(c => c.colId === colId && doc.tables.get(table).columns.some(x => x.id === c.id));
const describe = (doc, table, colId, description) => doc.apply([['UpdateRecord', '_grist_Tables_column', columnOf(doc, table, colId).id, { description }]]);
const noteOfColumn = (doc, table, colId) => columnOf(doc, table, colId).description;
const rawSection = (doc, table) => doc.fetchRows('_grist_Views_section').find(s => s.id === doc.fetchRows('_grist_Tables').find(tb => tb.tableId === table).rawViewSectionRef);
const noteOfTable = (doc, table) => rawSection(doc, table).description;
const setTableNote = (doc, table, description) => doc.apply([['UpdateRecord', '_grist_Views_section', rawSection(doc, table).id, { description }]]);

source.addTable('Budget', [{ id: 'Libelle', type: 'Text' }, { id: 'Montant', type: 'Numeric' }, { id: 'Reel', type: 'Numeric' }], [{ Libelle: 'Loyer', Montant: 100, Reel: 90 }]);
describe(source, 'Budget', 'Libelle', 'Intitulé de la ligne budgétaire');
describe(source, 'Budget', 'Montant', 'Montant TTC en euros\nsaisi par le service');
setTableNote(source, 'Budget', 'Lignes du budget 2026');

const story = {};
const columnsOf = lot => JSON.parse(lot[SCHEMA_COL]);
const lotOf = async exportId => (await syncRows()).find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Budget');

test('descriptions : SOURCE vers CIBLE', async (t) => {
  await t.test('SOURCE : les descriptions partent avec les colonnes, signées, quand les cases sont cochées', async () => {
    as(source);
    const saved = await saveChosenExport({ name: 'Budget', notes: true, tableNote: true, selection: [{ table: 'Budget', columns: ['Libelle', 'Montant', 'Reel'], filter: null }] });
    story.exp = saved.created;
    story.lot = await lotOf(saved.id);
    const columns = columnsOf(story.lot);
    assert.deepEqual(columns.map(c => c.desc), ['Intitulé de la ligne budgétaire', 'Montant TTC en euros\nsaisi par le service', ''], 'une colonne sans description dit « vide » : l\'export les envoie');
    assert.deepEqual(columns.map(c => c.tdesc), ['Lignes du budget 2026', undefined, undefined], 'la description de la table est portée par la première colonne');
    assert.ok(columns.every(c => !c.fmt && !c.opts), 'ni mise en forme ni format : seules les descriptions étaient demandées');
  });

  await t.test('SOURCE : sans les cases, rien de plus que la description d\'avant', async () => {
    as(source);
    const saved = await saveChosenExport({ name: 'Sans', selection: [{ table: 'Budget', columns: ['Libelle', 'Montant'], filter: null }] });
    const text = (await lotOf(saved.id))[SCHEMA_COL];
    assert.ok(!text.includes('desc') && !text.includes('tdesc'), text);
    const only = await saveChosenExport({ name: 'Colonnes seules', notes: true, selection: [{ table: 'Budget', columns: ['Libelle'], filter: null }] });
    assert.ok(!(await lotOf(only.id))[SCHEMA_COL].includes('tdesc'), 'la case de la table est à part');
    const table = await saveChosenExport({ name: 'Table seule', tableNote: true, selection: [{ table: 'Budget', columns: ['Libelle'], filter: null }] });
    const columns = columnsOf(await lotOf(table.id));
    assert.deepEqual([columns[0].desc, columns[0].tdesc], [undefined, 'Lignes du budget 2026']);
  });

  await t.test('SOURCE puis CIBLE : invitation, réception, webhook', async () => {
    const { entry, secret } = await startInvitation(story.exp);
    const { code } = await invitationCode(story.exp, entry, secret);
    as(target);
    const invitation = await readInvitation(code);
    const plans = invitation.tables.map(tb => ({ tb, dest: 'Budget_recu' }));
    await checkDestinations(invitation, plans);
    story.made = await createReception(invitation, plans, { reserve: false, options: {} });
    const { code: reply } = await receptionReply(story.made, world.formLink(target, story.made.journal));
    as(source);
    story.accepted = await checkReply(story.exp, entry, reply);
    await approveReply(story.exp, entry, story.accepted);
  });

  const deliver = async (lot, rows = [['k1', 100, false, { Libelle: 'Loyer', Montant: 100, Reel: 90 }]]) => {
    const row = { [EXPORT_COL]: story.exp.id, [TABLE_COL]: 'Budget', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lot[SCHEMA_COL] };
    world.deliver(story.accepted.url, [{ ...row, [LOT_COL]: await signText(story.accepted.keys.down, row, JSON.stringify({ lignes: rows, total: rows.length })) }]);
  };

  await t.test('CIBLE : les colonnes créées et la table reçoivent leurs descriptions, une seule fois', async () => {
    await deliver(story.lot);
    as(target);
    await consolidateAll();
    assert.deepEqual(target.rows('Budget_recu').map(r => [r.Libelle, r.Montant]), [['Loyer', 100]]);
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Libelle'), 'Intitulé de la ligne budgétaire');
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Montant'), 'Montant TTC en euros\nsaisi par le service');
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Reel'), '', 'une colonne sans description reste sans');
    assert.equal(noteOfTable(target, 'Budget_recu'), 'Lignes du budget 2026');
    const entry = receivedJournals(await readSchema())[0].note.tables[0];
    assert.deepEqual(entry.described.sort(), ['Libelle', 'Montant']);
    assert.equal(entry.tabled, true);
    assert.deepEqual(entry.sends, ['notes', 'table']);
    assert.ok(!JSON.stringify(receivedJournals(await readSchema())[0].note).includes('Intitulé'), 'la note du journal ne garde pas les textes');
  });

  await t.test('CIBLE : une description retouchée ou effacée ici n\'est pas refaite', async () => {
    as(target);
    describe(target, 'Budget_recu', 'Libelle', 'Ma propre description');
    describe(target, 'Budget_recu', 'Montant', '');
    setTableNote(target, 'Budget_recu', '');
    await consolidateAll({ reread: true });
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Libelle'), 'Ma propre description');
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Montant'), '', 'effacée ici : le sort est décidé, elle ne revient pas');
    assert.equal(noteOfTable(target, 'Budget_recu'), '');
  });

  await t.test('SOURCE : une description changée met la description des colonnes à jour, sans renvoyer de ligne', async () => {
    as(source);
    describe(source, 'Budget', 'Reel', 'Dépensé réellement');
    setTableNote(source, 'Budget', 'Budget 2026, mis à jour');
    const marked = source.rows('Synchro').filter(r => r[TYPE_COL] === KIND.lot).length;
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), true);
    const lot = await lotOf(story.exp.id);
    const columns = columnsOf(lot);
    assert.deepEqual(columns.map(c => c.desc).slice(2), ['Dépensé réellement']);
    assert.equal(columns[0].tdesc, 'Budget 2026, mis à jour');
    assert.equal(source.rows('Synchro').filter(r => r[TYPE_COL] === KIND.lot).length, marked);
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), false, 'rien de plus au passage suivant');
    story.lot = lot;
  });

  await t.test('CIBLE : une colonne qui n\'avait pas de description reçoit la nouvelle, ce qui est décidé reste', async () => {
    await deliver(story.lot);
    as(target);
    await consolidateAll({ reread: true });
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Reel'), 'Dépensé réellement');
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Libelle'), 'Ma propre description');
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Montant'), '');
    assert.equal(noteOfTable(target, 'Budget_recu'), '', 'la table décidée une fois n\'est pas refaite');
  });

  await t.test('CIBLE : « Reprendre depuis la SOURCE » remet les éléments demandés', async () => {
    as(target);
    await restyle(story.made.journal, { notes: true });
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Libelle'), 'Intitulé de la ligne budgétaire');
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Montant'), 'Montant TTC en euros\nsaisi par le service');
    assert.equal(noteOfTable(target, 'Budget_recu'), '', 'la description de la table n\'était pas demandée');
    await restyle(story.made.journal, { table: true });
    assert.equal(noteOfTable(target, 'Budget_recu'), 'Budget 2026, mis à jour');
    describe(target, 'Budget_recu', 'Reel', 'Autre');
    await restyle(story.made.journal, { style: true });
    assert.equal(noteOfColumn(target, 'Budget_recu', 'Reel'), 'Autre', 'reprendre le style ne touche pas aux descriptions');
  });

  await t.test('CIBLE : jamais de description sur la clé ni sur la note du journal', async () => {
    as(target);
    const keys = target.fetchRows('_grist_Tables_column').filter(c => c.colId === 'id_sync');
    assert.ok(keys.every(c => !String(c.description || '').includes('Intitulé')));
    const journal = receivedJournals(await readSchema())[0].journal;
    const note = target.fetchRows('_grist_Tables_column').find(c => c.colId === 'Synchro_Ids' && target.tables.get(journal).columns.some(x => x.id === c.id));
    assert.ok(!String(note.description).includes('Intitulé') && !String(note.description).includes('Dépensé'));
  });
});

test('descriptions : texte nettoyé et borné', () => {
  assert.equal(cleanNote('  Bonjour\r\nle monde  '), 'Bonjour\nle monde');
  assert.equal(cleanNote('a\u0000b‮c​d\u0007e'), 'abcde', 'ni caractères de contrôle ni sens d\'écriture');
  assert.equal(cleanNote('a\t\tb'), 'a  b');
  assert.equal(cleanNote('un\n\n\n\n\ndeux'), 'un\n\ndeux');
  assert.equal(cleanNote(undefined), '');
  assert.equal(cleanNote(12), '');
  assert.equal(cleanNote({ toString: () => 'x' }), '');
  const long = cleanNote('é'.repeat(1000));
  assert.equal([...long].length, NOTE_MAX);
  assert.ok(long.endsWith('…'));
  assert.equal([...cleanNote('x'.repeat(2000), TABLE_NOTE_MAX)].length, TABLE_NOTE_MAX);
  assert.equal(cleanNote('😀'.repeat(400)).includes('�'), false, 'jamais au milieu d\'un caractère');
});

test('descriptions : lecture des colonnes envoyées', () => {
  const columns = [{ id: 'A', desc: 'a', tdesc: 'table', fmt: true }, { id: 'B', desc: '' }, { id: 'C' }];
  assert.deepEqual(noteSent(columns), { notes: true, table: true, tableNote: 'table' });
  assert.deepEqual(sentElements(columns), ['style', 'notes', 'table']);
  assert.deepEqual(sentElements([{ id: 'A' }]), []);
  assert.deepEqual(sentElements(null), []);
  assert.deepEqual(noteSent([{ id: 'A', tdesc: 12, desc: 5 }]), { notes: false, table: false, tableNote: null }, 'un texte seulement');
  assert.deepEqual(withTableNote([{ id: 'A', tdesc: 'ancienne' }, { id: 'B', tdesc: 'autre' }], 'neuve'), [{ id: 'A', tdesc: 'neuve' }, { id: 'B' }]);
  assert.deepEqual(withTableNote([{ id: 'A', tdesc: 'ancienne' }], null), [{ id: 'A' }]);
  assert.equal(tableNoteOf({ rawViewSectionRef: 3 }, [{ id: 2, description: 'non' }, { id: 3, description: 'oui' }]), 'oui');
  assert.equal(tableNoteOf({ rawViewSectionRef: 3 }, null), '');
  assert.equal(tableNoteOf(undefined, []), '');
});

test('descriptions : exportSchema ne garde que du texte nettoyé', () => {
  const [first, second] = exportSchema([
    { id: 'A', type: 'Text', desc: 'a‮', tdesc: 'x'.repeat(900), fmt: true },
    { id: 'B', type: 'Text', desc: { evil: true }, tdesc: 7, fmt: 'oui' },
  ], true);
  assert.equal(first.desc, 'a');
  assert.equal([...first.tdesc].length, TABLE_NOTE_MAX);
  assert.equal(first.fmt, true);
  assert.equal(Object.hasOwn(second, 'desc') || Object.hasOwn(second, 'tdesc') || Object.hasOwn(second, 'fmt'), false);
  assert.equal(Object.hasOwn(exportSchema([{ id: 'A', type: 'Text', desc: 'a' }])[0], 'desc'), false, 'jamais dans un code ni dans la note du journal');
});

test('descriptions : planNotes', () => {
  const schema = {
    columns: () => [{ id: 1, colId: 'A', description: '' }, { id: 2, colId: 'B', description: 'déjà' }, { id: 3, colId: 'C', description: '' }],
    table: () => ({ rawViewSectionRef: 9 }),
  };
  const entry = { dest: 'T', own: ['A', 'B', 'C'], map: { C: 'C' } };
  const columns = [{ id: 'A', desc: 'dA' }, { id: 'B', desc: 'dB' }, { id: 'C', desc: '' }, { id: 'D', desc: 'dD' }, { id: 'E' }];
  const plan = planNotes(schema, entry, columns, { tableNote: 'dT', sections: [{ id: 9, description: '' }] });
  assert.deepEqual(plan.actions, [['UpdateRecord', '_grist_Tables_column', 1, { description: 'dA' }], ['UpdateRecord', '_grist_Views_section', 9, { description: 'dT' }]]);
  assert.deepEqual(plan.described, ['A', 'B'], 'B a déjà la sienne : décidée sans rien écrire ; C n\'a rien à recevoir : pas décidée');
  assert.equal(plan.tabled, true);
  const later = planNotes(schema, { ...entry, described: ['A', 'B'], tabled: true }, columns, { tableNote: 'dT', sections: [{ id: 9, description: '' }] });
  assert.deepEqual(later.actions, []);
  const foreign = planNotes(schema, { ...entry, own: ['C'] }, columns, { tableNote: null });
  assert.deepEqual(foreign.actions, [], 'une colonne que le widget n\'a pas créée est laissée');
  const replaced = planNotes(schema, entry, columns, { replace: true, replaceTable: true, tableNote: '', sections: [{ id: 9, description: 'ancienne' }] });
  assert.deepEqual(replaced.actions.map(a => a[3].description), ['dA', 'dB', ''], 'reprendre remplace aussi par du vide');
  assert.deepEqual(planNotes({ columns: () => [], table: () => null }, entry, columns, { tableNote: 'x', sections: [] }).actions, []);
});
