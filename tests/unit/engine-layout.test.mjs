// Ordre et colonnes cachées de la page d'une table, de bout en bout sur deux documents en mémoire : la SOURCE (une table
// Budget dont la page cache une colonne et range les autres autrement) les envoie dans la description signée des colonnes (`pos`) ;
// la CIBLE les pose une fois sur ce que le widget crée, sans refaire ce qu'elle a changé ; « Reprendre depuis la SOURCE » remet
// tout d'accord. Puis la logique pure : section modèle, rangs, plan d'écritures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { isPos, layoutSent, modelSection, planLayout, withLayout } from '../../js/engine/logic/layout.js';
import { sentElements } from '../../js/engine/logic/descriptions.js';
import { exportSchema } from '../../js/engine/logic/codes.js';
import { elementCounts } from '../../js/engine/logic/exports.js';
import { schemaFrom } from '../../js/engine/logic/schema.js';
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
const source = fakeDoc({ docId: 'sourcedoclay01', name: 'Budget source', email: 'source@fake.local' });
const target = fakeDoc({ docId: 'targetdoclay02', name: 'Budget copie', email: 'cible@fake.local' });
const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });

const COLS = ['Libelle', 'Montant', 'Reel', 'Note', 'Code'];
source.addTable('Budget', COLS.map(id => ({ id, type: 'Text' })), [{ Libelle: 'Loyer', Montant: '100', Reel: '90', Note: 'n', Code: 'c1' }]);

// La page d'une table, comme Grist la crée : une vue, une section de type tableau, un champ par colonne montrée, dans l'ordre donné.
const tableRow = (doc, table) => doc.fetchRows('_grist_Tables').find(tb => tb.tableId === table);
const colRef = (doc, table, colId) => doc.fetchRows('_grist_Tables_column').find(c => c.parentId === tableRow(doc, table).id && c.colId === colId).id;
let nextView = 50;
function addPage(doc, table, shown) {
  const view = nextView++;
  const [section] = doc.apply([['AddRecord', '_grist_Views_section', null, { tableRef: tableRow(doc, table).id, parentKey: 'record', parentId: view }]]).retValues;
  shown.forEach((colId, i) => doc.apply([['AddRecord', '_grist_Views_section_field', null, { parentId: section, colRef: colRef(doc, table, colId), parentPos: 10 + i }]]));
  return section;
}
const pageSection = (doc, table) => modelSection(tableRow(doc, table), doc.fetchRows('_grist_Views_section'));
const pageOrder = (doc, table) => {
  const names = new Map(doc.fetchRows('_grist_Tables_column').map(c => [c.id, c.colId]));
  const section = pageSection(doc, table);
  return doc.fetchRows('_grist_Views_section_field').filter(f => f.parentId === section.id).sort((a, b) => a.parentPos - b.parentPos).map(f => names.get(f.colRef));
};
const moveField = (doc, table, colId, parentPos) => {
  const field = doc.fetchRows('_grist_Views_section_field').find(f => f.parentId === pageSection(doc, table).id && f.colRef === colRef(doc, table, colId));
  doc.apply([['UpdateRecord', '_grist_Views_section_field', field.id, { parentPos }]]);
};

addPage(source, 'Budget', ['Code', 'Libelle', 'Montant', 'Reel']); // Note est cachée dans la page de la SOURCE

const story = {};
const columnsOf = lot => JSON.parse(lot[SCHEMA_COL]);
const lotOf = async exportId => (await syncRows()).find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Budget');
const row = { Libelle: 'Loyer', Montant: '100', Reel: '90', Note: 'n', Code: 'c1' };

test('mise en page : SOURCE vers CIBLE', async (t) => {
  await t.test('SOURCE : sans la case, aucun rang ne part ; avec, chaque colonne a le sien (-1 pour la cachée)', async () => {
    as(source);
    const plain = await saveChosenExport({ name: 'Sans', selection: [{ table: 'Budget', columns: COLS, filter: null }] });
    assert.ok(!(await lotOf(plain.id))[SCHEMA_COL].includes('"pos"'));
    const saved = await saveChosenExport({ name: 'Budget', layout: true, selection: [{ table: 'Budget', columns: COLS, filter: null }] });
    story.exp = saved.created;
    story.lot = await lotOf(saved.id);
    assert.deepEqual(Object.fromEntries(columnsOf(story.lot).map(c => [c.id, c.pos])), { Libelle: 1, Montant: 2, Reel: 3, Note: -1, Code: 0 });
    assert.ok(columnsOf(story.lot).every(c => !c.fmt && !c.desc && !c.tdesc), 'seule la mise en page était demandée');
    assert.deepEqual(sentElements(columnsOf(story.lot)), ['layout']);
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

  const deliver = async (lot, rows = [['k1', 100, false, row]]) => {
    const head = { [EXPORT_COL]: story.exp.id, [TABLE_COL]: 'Budget', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lot[SCHEMA_COL] };
    world.deliver(story.accepted.url, [{ ...head, [LOT_COL]: await signText(story.accepted.keys.down, head, JSON.stringify({ lignes: rows, total: rows.length })) }]);
  };

  await t.test('CIBLE : sans page pour la table, rien n\'est décidé (la colonne reste à décider)', async () => {
    await deliver(story.lot);
    as(target);
    await consolidateAll();
    assert.deepEqual(target.rows('Budget_recu').map(r => [r.Libelle, r.Code]), [['Loyer', 'c1']]);
    const entry = receivedJournals(await readSchema())[0].note.tables[0];
    assert.deepEqual(entry.sends, ['layout']);
    assert.equal(entry.laid, undefined);
  });

  await t.test('CIBLE : la page de la table paraît, la colonne cachée par la SOURCE l\'est aussi, l\'ordre est celui de la SOURCE', async () => {
    addPage(target, 'Budget_recu', ['Libelle', 'Montant', 'Reel', 'Note', 'Code']);
    as(target);
    await consolidateAll({ reread: true });
    assert.deepEqual(pageOrder(target, 'Budget_recu'), ['Code', 'Libelle', 'Montant', 'Reel']);
    assert.deepEqual(target.rows('Budget_recu').map(r => r.Note), ['n'], 'les données de la colonne cachée sont là');
    assert.deepEqual(receivedJournals(await readSchema())[0].note.tables[0].laid.sort(), COLS.slice().sort());
  });

  await t.test('CIBLE : ce qui est décidé n\'est pas refait (une colonne remontrée, une autre déplacée ici)', async () => {
    as(target);
    target.apply([['AddRecord', '_grist_Views_section_field', null, { parentId: pageSection(target, 'Budget_recu').id, colRef: colRef(target, 'Budget_recu', 'Note'), parentPos: 99 }]]);
    moveField(target, 'Budget_recu', 'Code', 100);
    await consolidateAll({ reread: true });
    assert.deepEqual(pageOrder(target, 'Budget_recu'), ['Libelle', 'Montant', 'Reel', 'Note', 'Code']);
  });

  await t.test('SOURCE : un nouvel ordre met la description des colonnes à jour, sans renvoyer de ligne', async () => {
    as(source);
    moveField(source, 'Budget', 'Reel', 1); // Reel passe en tête
    const sent = source.rows('Synchro').filter(r => r[TYPE_COL] === KIND.lot).length;
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), true);
    story.lot = await lotOf(story.exp.id);
    assert.deepEqual(Object.fromEntries(columnsOf(story.lot).map(c => [c.id, c.pos])), { Libelle: 2, Montant: 3, Reel: 0, Note: -1, Code: 1 });
    assert.equal(source.rows('Synchro').filter(r => r[TYPE_COL] === KIND.lot).length, sent);
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), false, 'rien de plus au passage suivant');
  });

  await t.test('CIBLE : « Reprendre depuis la SOURCE » remet l\'ordre et cache la colonne cachée', async () => {
    await deliver(story.lot);
    as(target);
    await consolidateAll({ reread: true });
    assert.deepEqual(pageOrder(target, 'Budget_recu'), ['Libelle', 'Montant', 'Reel', 'Note', 'Code'], 'sans clic, l\'ordre décidé reste');
    await restyle(story.made.journal, { layout: true });
    assert.deepEqual(pageOrder(target, 'Budget_recu'), ['Reel', 'Code', 'Libelle', 'Montant']);
    await restyle(story.made.journal, { layout: true });
    assert.deepEqual(pageOrder(target, 'Budget_recu'), ['Reel', 'Code', 'Libelle', 'Montant'], 'reprendre deux fois ne change rien');
  });

  await t.test('CIBLE : une colonne cachée ici que la SOURCE montre est remontrée sur « Reprendre »', async () => {
    as(target);
    const field = target.fetchRows('_grist_Views_section_field').find(f => f.parentId === pageSection(target, 'Budget_recu').id && f.colRef === colRef(target, 'Budget_recu', 'Montant'));
    target.apply([['RemoveRecord', '_grist_Views_section_field', field.id]]);
    await consolidateAll({ reread: true });
    assert.ok(!pageOrder(target, 'Budget_recu').includes('Montant'), 'sans clic, la colonne cachée ici le reste');
    await restyle(story.made.journal, { layout: true });
    assert.deepEqual(pageOrder(target, 'Budget_recu'), ['Reel', 'Code', 'Libelle', 'Montant']);
  });

  await t.test('SOURCE : la page de la table disparaît, plus aucun rang ne part', async () => {
    as(source);
    const section = pageSection(source, 'Budget');
    source.apply([['BulkRemoveRecord', '_grist_Views_section_field', source.fetchRows('_grist_Views_section_field').filter(f => f.parentId === section.id).map(f => f.id)], ['RemoveRecord', '_grist_Views_section', section.id]]);
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), true);
    assert.ok(!columnsOf(await lotOf(story.exp.id)).some(c => 'pos' in c));
  });
});

test('mise en page : rangs et section modèle', () => {
  const table = { id: 7, rawViewSectionRef: 11, recordCardViewSectionRef: 12 };
  const sections = [
    { id: 11, tableRef: 7, parentKey: 'record', parentId: 0 }, { id: 12, tableRef: 7, parentKey: 'single', parentId: 0 },
    { id: 20, tableRef: 7, parentKey: 'single', parentId: 3 }, { id: 21, tableRef: 8, parentKey: 'record', parentId: 4 },
    { id: 31, tableRef: 7, parentKey: 'record', parentId: 5 }, { id: 30, tableRef: 7, parentKey: 'record', parentId: 6 },
  ];
  assert.equal(modelSection(table, sections).id, 30, 'la première section de type tableau d\'une page, hors données brutes et fiche');
  assert.equal(modelSection(table, sections.slice(0, 4)), null);
  assert.equal(modelSection(null, sections), null);
  assert.equal(modelSection(table, null), null);

  const live = [{ id: 1, colId: 'A' }, { id: 2, colId: 'B' }, { id: 3, colId: 'C' }, { id: 4, colId: 'D' }];
  const fields = [{ parentId: 30, colRef: 3, parentPos: 1 }, { parentId: 30, colRef: 1, parentPos: 2 }, { parentId: 30, colRef: 4, parentPos: 3 }, { parentId: 31, colRef: 2, parentPos: 1 }];
  assert.deepEqual(withLayout([{ id: 'A' }, { id: 'B' }, { id: 'C' }], live, table, sections, fields).map(c => c.pos), [1, -1, 0], 'D n\'est pas envoyée : elle ne compte pas dans les rangs');
  assert.deepEqual(withLayout([{ id: 'A', pos: 5 }], live, table, sections.slice(0, 4), fields), [{ id: 'A' }], 'sans page, le rang est retiré');
  assert.equal(layoutSent([{ id: 'A' }]), false);
  assert.equal(layoutSent([{ id: 'A', pos: -1 }]), true);
  assert.equal(isPos(0) && isPos(-1) && isPos(100000), true);
  assert.equal([1.5, -2, 100001, '3', null, NaN].some(isPos), false);
  assert.deepEqual(exportSchema([{ id: 'A', type: 'Text', pos: 2 }, { id: 'B', type: 'Text', pos: 'x' }], true).map(c => c.pos), [2, undefined]);
  assert.equal(elementCounts(schemaFrom([{ id: 7, tableId: 'T', rawViewSectionRef: 11 }], []), ['T'], sections).layout, 1);
});

test('mise en page : plan d\'écritures', () => {
  const tables = [{ id: 7, tableId: 'T', rawViewSectionRef: 11 }];
  const columns = ['A', 'B', 'C', 'D', 'E'].map((colId, i) => ({ id: i + 1, parentId: 7, parentPos: i, colId, type: 'Text', label: colId }));
  const schema = schemaFrom(tables, columns);
  const sections = [{ id: 11, tableRef: 7, parentKey: 'record', parentId: 0 }, { id: 30, tableRef: 7, parentKey: 'record', parentId: 6 }];
  const fields = ['A', 'B', 'C', 'D', 'E'].map((c, i) => ({ id: 100 + i, parentId: 30, colRef: i + 1, parentPos: 10 + i }));
  const sent = pos => ['A', 'B', 'C', 'D', 'E'].map((id, i) => ({ id, pos: pos[i] }));
  const entry = { dest: 'T', own: ['A', 'B', 'C', 'D'] }; // E existait déjà : jamais touchée

  const hide = planLayout(schema, entry, sent([0, -1, 1, 2, -1]), { sections, fields });
  assert.deepEqual(hide.actions, [['BulkRemoveRecord', '_grist_Views_section_field', [101]]], 'B cachée ; E, qui n\'est pas à nous, garde son champ ; les autres sont déjà dans l\'ordre');
  assert.deepEqual(hide.laid, ['A', 'B', 'C', 'D']);

  const order = planLayout(schema, entry, sent([3, 2, 1, 0, 4]), { sections, fields });
  assert.deepEqual(order.actions, [['BulkUpdateRecord', '_grist_Views_section_field', [103, 102, 101, 100], { parentPos: [10, 11, 12, 13] }]], 'les colonnes se répartissent les places de leurs champs, E ne bouge pas');

  const again = planLayout(schema, { ...entry, laid: ['A', 'B', 'C', 'D'] }, sent([3, 2, 1, 0, 4]), { sections, fields });
  assert.deepEqual([again.actions, again.laid], [[], []], 'décidé une fois, sans demande');

  const without = fields.filter(f => f.colRef !== 2);
  const show = planLayout(schema, { ...entry, laid: ['A', 'B', 'C', 'D'] }, sent([0, 1, 2, 3, 4]), { sections, fields: without, replace: true });
  assert.deepEqual(show.actions, [
    ['BulkUpdateRecord', '_grist_Views_section_field', [102, 103], { parentPos: [13, 15] }],
    ['AddRecord', '_grist_Views_section_field', null, { parentId: 30, colRef: 2, parentPos: 12 }],
  ], 'repris : B est remontrée à sa place parmi les nôtres, après la place qu\'occupait un champ de moins');
});

test('mise en page : rien sans page ni sans rang', () => {
  const schema = schemaFrom([{ id: 7, tableId: 'T', rawViewSectionRef: 11 }], [{ id: 1, parentId: 7, parentPos: 0, colId: 'A', type: 'Text' }]);
  const raw = [{ id: 11, tableRef: 7, parentKey: 'record', parentId: 0 }];
  assert.deepEqual(planLayout(schema, { dest: 'T', own: ['A'] }, [{ id: 'A', pos: 0 }], { sections: raw, fields: [] }), { actions: [], laid: [] });
  const page = [...raw, { id: 30, tableRef: 7, parentKey: 'record', parentId: 6 }];
  assert.deepEqual(planLayout(schema, { dest: 'T', own: ['A'] }, [{ id: 'A' }], { sections: page, fields: [{ id: 5, parentId: 30, colRef: 1, parentPos: 1 }] }), { actions: [], laid: [] }, 'une colonne sans rang n\'est pas décidée');
  assert.deepEqual(planLayout(schema, { dest: 'T', own: [] }, [{ id: 'A', pos: -1 }], { sections: page, fields: [{ id: 5, parentId: 30, colRef: 1, parentPos: 1 }] }), { actions: [], laid: [] }, 'une colonne qui n\'est pas à nous n\'est pas décidée');
});
