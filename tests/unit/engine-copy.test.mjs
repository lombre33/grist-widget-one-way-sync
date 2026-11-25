// La copie unique de bout en bout sur deux documents en mémoire : un document A dont on exporte des tables en texte « Code View »,
// un document B qui les crée d'après ce texte. Puis les refus : noms réservés, formules, table qui existe déjà, document qui a changé.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { importText, previewImport, readCopyDocument } from '../../js/engine/copy.js';
import { generateCode } from '../../js/engine/logic/code-view-write.js';
import { prepareExport } from '../../js/engine/logic/copy-plan.js';
import { refusedNames } from '../../js/engine/logic/copy-actions.js';
import { fakeDoc, fakePort } from './engine-fake.mjs';

// Le moteur sur tel document (`owner` : la personne en est propriétaire), et les lots d'actions que le moteur y envoie.
function engineOn(doc, { owner = true } = {}) {
  const port = fakePort(doc, { owner });
  const batches = [];
  const apply = port.apply;
  port.apply = async (actions) => { batches.push(actions.map(action => action[0])); return apply(actions); };
  startEngine({ port, version: '9.9.9' });
  return batches;
}

const rowOf = (doc, table) => doc.fetchRows('_grist_Tables').find(row => row.tableId === table);
const columnsOf = (doc, table) => doc.fetchRows('_grist_Tables_column').filter(col => col.parentId === rowOf(doc, table).id);
const columnOf = (doc, table, colId) => columnsOf(doc, table).find(col => col.colId === colId);
const keys = warnings => warnings.map(warning => warning.key);

// Le document A : deux tables, des références (dont deux liées dans les deux sens), une liste de choix, une monnaie, des formules.
function documentA() {
  const doc = fakeDoc({ docId: 'copydocaaaaa', locale: 'fr-FR', currency: 'EUR' });
  doc.addTable('Cities', [{ id: 'Label', type: 'Text' }, { id: 'Zip', type: 'Text' }]);
  doc.addTable('People', [
    { id: 'Name', type: 'Text', label: 'Nom', description: 'Le nom de la personne' },
    { id: 'Age', type: 'Int', formula: '18' },
    { id: 'Salary', type: 'Numeric', widgetOptions: JSON.stringify({ numMode: 'currency', decimals: 2 }) },
    { id: 'Kind', type: 'Choice', widgetOptions: JSON.stringify({ choices: ['a', 'b'], choiceOptions: { a: { fillColor: '#FF0000', textColor: '#000000' } } }) },
    { id: 'Boss', type: 'Ref:People' },
    { id: 'Team', type: 'RefList:People' },
    { id: 'City', type: 'Ref:Cities' },
    { id: 'Full', type: 'Text', isFormula: true, formula: '$Name + "!"' },
    { id: 'id_sync', type: 'Text' },
  ]);
  const ref = (table, colId) => columnOf(doc, table, colId).id;
  doc.apply([
    ['ModifyColumn', 'People', 'Boss', { visibleCol: ref('People', 'Name') }],
    ['ModifyColumn', 'People', 'City', { visibleCol: ref('Cities', 'Label') }],
    ['ModifyColumn', 'People', 'Boss', { reverseCol: ref('People', 'Team') }],
    ['UpdateRecord', '_grist_Views_section', rowOf(doc, 'People').rawViewSectionRef, { description: 'Les gens' }],
  ]);
  return doc;
}

// Le texte que A donne pour les tables `tableIds`, avec ce qu'on laisse de côté.
async function exportFrom(doc, selection) {
  engineOn(doc);
  return prepareExport(await readCopyDocument(), selection);
}

test('A donne un texte que B lit : tables, colonnes, types, libellés, descriptions, colonne affichée, liens dans les deux sens', async () => {
  const exported = await exportFrom(documentA(), { tableIds: ['Cities', 'People'] });
  assert.match(exported.text, /class People:/);
  assert.doesNotMatch(exported.text, /id_sync/, 'une colonne du widget ne part jamais dans le texte');
  assert.deepEqual(exported.notes, []);

  const b = fakeDoc({ docId: 'copydocbbbbb' });
  const batches = engineOn(b);
  const { plan } = await previewImport(exported.text);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.tables.map(table => [table.sourceId, table.mode, table.tableId, table.problem]), [['Cities', 'create', 'Cities', null], ['People', 'create', 'People', null]]);
  const done = await importText(exported.text);
  assert.deepEqual(done.created, [{ tableId: 'Cities', columns: 2 }, { tableId: 'People', columns: 8 }]);
  assert.deepEqual(done.filled, []);
  assert.deepEqual(done.notes, []);
  assert.deepEqual(batches[0], ['AddTable', 'AddTable'], 'les deux tables partent dans un seul lot : Grist le défait en entier s\'il échoue');

  assert.deepEqual(columnsOf(b, 'People').map(col => [col.colId, col.type]), [
    ['Name', 'Text'], ['Age', 'Int'], ['Salary', 'Numeric'], ['Kind', 'Choice'], ['Boss', 'Ref:People'], ['Team', 'RefList:People'], ['City', 'Ref:Cities'], ['Full', 'Text'],
  ]);
  assert.equal(columnOf(b, 'People', 'Name').label, 'Nom');
  assert.equal(columnOf(b, 'People', 'Name').description, 'Le nom de la personne');
  assert.equal(columnOf(b, 'People', 'Boss').visibleCol, columnOf(b, 'People', 'Name').id);
  assert.equal(columnOf(b, 'People', 'City').visibleCol, columnOf(b, 'Cities', 'Label').id);
  assert.equal(columnOf(b, 'People', 'Boss').reverseCol, columnOf(b, 'People', 'Team').id);
  assert.equal(columnOf(b, 'People', 'Team').reverseCol, columnOf(b, 'People', 'Boss').id);
  assert.deepEqual(JSON.parse(columnOf(b, 'People', 'Kind').widgetOptions).choices, ['a', 'b']);
  assert.equal(JSON.parse(columnOf(b, 'People', 'Kind').widgetOptions).choiceOptions.a.fillColor, '#FF0000');
  assert.equal(JSON.parse(columnOf(b, 'People', 'Salary').widgetOptions).currency, 'EUR', 'la monnaie du document A part avec la colonne : B n\'a pas la même');
  const section = b.fetchRows('_grist_Views_section').find(row => row.id === rowOf(b, 'People').rawViewSectionRef);
  assert.equal(section.description, 'Les gens', 'la description d\'une table est celle de sa section de données brutes');
  assert.equal(b.fetchRows('_grist_Views_section').find(row => row.id === rowOf(b, 'Cities').rawViewSectionRef).description, '');
});

test('sans la case des formules, les colonnes calculées sont créées vides, et c\'est dit', async () => {
  const exported = await exportFrom(documentA(), { tableIds: ['People'] });
  const b = fakeDoc({ docId: 'copydocbbbb2' });
  engineOn(b);
  const { plan } = await previewImport(exported.text);
  assert.ok(keys(plan.warnings).includes('copy.warn.computedColumns'));
  await importText(exported.text);
  assert.deepEqual([columnOf(b, 'People', 'Full').isFormula, columnOf(b, 'People', 'Full').formula], [false, '']);
  assert.equal(columnOf(b, 'People', 'Age').formula, '', 'la formule de déclenchement n\'est pas posée non plus');
  assert.equal(columnOf(b, 'People', 'City').type, 'Any', 'la table visée n\'est pas ici : la colonne devient « Any » et c\'est dit');
  assert.ok(keys(plan.warnings).includes('copy.warn.refTargetMissingInDoc'));
});

test('avec la case des formules, un propriétaire les pose, les autres sont refusées par la lecture', async () => {
  const text = generateCode([{
    tableId: 'Notes',
    description: null,
    columns: [
      { colId: 'A', type: 'Int', isFormula: false, formula: '', label: 'A' },
      { colId: 'Double', type: 'Int', isFormula: true, formula: '$A * 2', label: 'Double' },
      { colId: 'Start', type: 'Int', isFormula: false, formula: '7', label: 'Start' },
      { colId: 'Evil', type: 'Any', isFormula: true, formula: 'import os\nreturn os.listdir("/")', label: 'Evil' },
      { colId: 'Net', type: 'Any', isFormula: true, formula: 'return REQUEST("https://example.org/" + str($A))', label: 'Net' },
    ],
  }]);
  const b = fakeDoc({ docId: 'copydocbbbb3' });
  engineOn(b);
  const { plan } = await previewImport(text, { withFormulas: true });
  assert.deepEqual(keys(plan.warnings).filter(key => key === 'copy.warn.formulaRefused').length, 2);
  await importText(text, { withFormulas: true });
  assert.deepEqual([columnOf(b, 'Notes', 'Double').isFormula, columnOf(b, 'Notes', 'Double').formula], [true, '$A * 2']);
  assert.deepEqual([columnOf(b, 'Notes', 'Start').isFormula, columnOf(b, 'Notes', 'Start').formula], [false, '7']);
  for (const colId of ['Evil', 'Net']) assert.deepEqual([columnOf(b, 'Notes', colId).isFormula, columnOf(b, 'Notes', colId).formula], [false, ''], `${colId} : créée vide`);
  assert.ok(!JSON.stringify(b.log).includes('listdir'), 'le code refusé n\'a jamais été envoyé à Grist');
  assert.ok(!JSON.stringify(b.log).includes('REQUEST'));
});

test('quelqu\'un qui n\'est pas propriétaire ne pose aucune formule : rien n\'est écrit', async () => {
  const text = generateCode([{ tableId: 'Notes', description: null, columns: [{ colId: 'A', type: 'Int', isFormula: true, formula: '1', label: 'A' }] }]);
  const b = fakeDoc({ docId: 'copydocbbbb4' });
  engineOn(b, { owner: false });
  await assert.rejects(importText(text, { withFormulas: true }), { message: 'copyFormulasOwner' });
  assert.equal(b.has('Notes'), false);
  await importText(text); // sans formule, la copie est permise
  assert.equal(b.has('Notes'), true);
});

test('les noms réservés ne passent pas : ni table du widget, ni colonne du widget', async () => {
  const column = id => ({ colId: id, type: 'Text', isFormula: false, formula: '', label: id });
  const text = generateCode([
    { tableId: 'Synchro', description: null, columns: [column('A')] },
    { tableId: 'Journal_ab12', description: null, columns: [column('A')] },
    { tableId: '_grist_Tables', description: null, columns: [column('A')] },
    { tableId: 'Notes', description: null, columns: [column('Texte'), column('id_sync'), column('MajLe'), column('Synchro_Lot'), column('manualSort'), column('gristHelper_X'), column('Sync_Applique')] },
  ]);
  const b = fakeDoc({ docId: 'copydocbbbb5' });
  engineOn(b);
  const { parsed, plan } = await previewImport(text);
  assert.deepEqual(parsed.tables.map(table => table.tableId), ['Notes']);
  assert.equal(keys(parsed.warnings).filter(key => key === 'copy.warn.reservedTableId').length, 3);
  assert.equal(keys(parsed.warnings).filter(key => key === 'copy.warn.reservedColumnId').length, 6);
  await importText(text);
  assert.deepEqual(columnsOf(b, 'Notes').map(col => col.colId), ['Texte']);
  assert.equal(b.has('Synchro'), false);
  assert.equal(plan.ready, true);
});

test('un nom réservé choisi à la main pour une table à créer est refusé dès l\'aperçu', async () => {
  const text = generateCode([{ tableId: 'Notes', description: null, columns: [{ colId: 'A', type: 'Text', isFormula: false, formula: '', label: 'A' }] }]);
  const b = fakeDoc({ docId: 'copydocbbbb0' });
  engineOn(b);
  for (const tableId of ['Synchro', 'Synchro_Lot', 'Journal_ab12', 'Journal_']) {
    const choices = { targets: new Map([['Notes', { mode: 'create', tableId }]]) };
    assert.equal((await previewImport(text, choices)).plan.tables[0].problem, 'copy.validation.reservedId', tableId);
    await assert.rejects(importText(text, choices), { message: 'copyNotReady' });
  }
  assert.equal(b.has('Synchro'), false);
  assert.equal((await previewImport(text, { targets: new Map([['Notes', { mode: 'create', tableId: 'Notes2' }]]) })).plan.ready, true);
});

test('un texte qui ne dit que des noms réservés n\'a rien à copier', async () => {
  const text = generateCode([{ tableId: 'Synchro', description: null, columns: [{ colId: 'A', type: 'Text', isFormula: false, formula: '', label: 'A' }] }]);
  const b = fakeDoc({ docId: 'copydocbbbb6' });
  engineOn(b);
  assert.equal((await previewImport(text)).plan.ready, false);
  await assert.rejects(importText(text), { message: 'copyNothing' });
});

test('une table qui existe déjà bloque l\'aperçu ; ajouter ses colonnes ne touche à aucune colonne qui existe', async () => {
  const exported = await exportFrom(documentA(), { tableIds: ['People'] });
  const b = fakeDoc({ docId: 'copydocbbbb7' });
  b.addTable('People', [{ id: 'Name', type: 'Int' }, { id: 'Note', type: 'Text' }], [{ Name: 5, Note: 'x' }]);
  engineOn(b);

  const blocked = await previewImport(exported.text);
  assert.equal(blocked.plan.ready, false);
  assert.equal(blocked.plan.tables[0].problem, 'copy.validation.tableExists');
  await assert.rejects(importText(exported.text), { message: 'copyNotReady' });
  assert.equal(columnsOf(b, 'People').length, 2, 'rien n\'est écrit');

  const choices = { targets: new Map([['People', { mode: 'add', tableId: 'People' }]]) };
  const { plan } = await previewImport(exported.text, choices);
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.tables[0].present, ['Name']);
  assert.ok(keys(plan.warnings).includes('copy.warn.columnsExist'));
  const done = await importText(exported.text, choices);
  assert.deepEqual(done.filled, [{ tableId: 'People', columns: 7 }]);
  assert.equal(columnOf(b, 'People', 'Name').type, 'Int', 'la colonne qui existait garde son type');
  assert.deepEqual(b.rows('People').map(row => [row.Name, row.Note]), [[5, 'x']], 'les valeurs ne bougent pas');
  assert.equal(columnOf(b, 'People', 'Boss').type, 'Ref:People', 'une référence à sa propre table vise la table qui reçoit');
  assert.equal(columnOf(b, 'People', 'Boss').reverseCol, columnOf(b, 'People', 'Team').id, 'les deux bouts sont ajoutés ensemble : ils se lient');
});

test('ajouter à une table qui n\'existe pas, ou à la même table deux fois, est refusé', async () => {
  const exported = await exportFrom(documentA(), { tableIds: ['Cities', 'People'] });
  const b = fakeDoc({ docId: 'copydocbbbb8' });
  b.addTable('Both', [{ id: 'Zip', type: 'Text' }]);
  engineOn(b);
  const unknown = (await previewImport(exported.text, { targets: new Map([['Cities', { mode: 'add', tableId: 'Absent' }]]) })).plan;
  assert.equal(unknown.tables[0].problem, 'copy.validation.tableUnknown');
  const twice = (await previewImport(exported.text, { targets: new Map([['Cities', { mode: 'add', tableId: 'Both' }], ['People', { mode: 'add', tableId: 'Both' }]]) })).plan;
  assert.deepEqual(twice.tables.map(table => table.problem), ['copy.validation.duplicateTarget', 'copy.validation.duplicateTarget']);
  assert.equal(twice.ready, false);
  const reserved = (await previewImport(exported.text, { targets: new Map([['Cities', { mode: 'add', tableId: 'Synchro' }]]) })).plan;
  assert.equal(reserved.tables[0].problem, 'copy.validation.tableUnknown', 'une table du widget n\'est jamais la destination');
});

test('une table arrivée entre l\'aperçu et le clic fait refuser la copie : rien n\'est écrit', async () => {
  const exported = await exportFrom(documentA(), { tableIds: ['Cities'] });
  const b = fakeDoc({ docId: 'copydocbbbb9' });
  engineOn(b);
  assert.equal((await previewImport(exported.text)).plan.ready, true);
  b.addTable('CITIES', [{ id: 'X', type: 'Text' }]); // Grist ne distingue pas les majuscules
  await assert.rejects(importText(exported.text), { message: 'copyNotReady' });
  assert.equal(b.has('Cities'), false);
});

test('une table laissée de côté qui existe déjà reste la cible des références', async () => {
  const exported = await exportFrom(documentA(), { tableIds: ['Cities', 'People'] });
  const b = fakeDoc({ docId: 'copydocbbbc1' });
  b.addTable('Cities', [{ id: 'Label', type: 'Text' }]);
  engineOn(b);
  const choices = { targets: new Map([['Cities', { mode: 'skip', tableId: 'Cities' }]]) };
  const { plan } = await previewImport(exported.text, choices);
  assert.equal(plan.ready, true);
  const done = await importText(exported.text, choices);
  assert.deepEqual(done.created, [{ tableId: 'People', columns: 8 }]);
  assert.equal(columnOf(b, 'People', 'City').type, 'Ref:Cities');
  assert.equal(columnOf(b, 'People', 'City').visibleCol, columnOf(b, 'Cities', 'Label').id);
  assert.equal(columnsOf(b, 'Cities').length, 1, 'la table laissée de côté n\'est pas touchée');
});

test('une colonne laissée de côté n\'arrive pas, et un lien dans les deux sens sans son autre bout devient une référence simple', async () => {
  const exported = await exportFrom(documentA(), { tableIds: ['People'] });
  const b = fakeDoc({ docId: 'copydocbbbc2' });
  engineOn(b);
  const choices = { excluded: new Map([['People', new Set(['Team', 'City'])]]) };
  const { plan } = await previewImport(exported.text, choices);
  assert.ok(keys(plan.warnings).includes('copy.warn.twoWayColumns'));
  await importText(exported.text, choices);
  assert.equal(columnOf(b, 'People', 'Team'), undefined);
  assert.equal(columnOf(b, 'People', 'City'), undefined);
  assert.equal(columnOf(b, 'People', 'Boss').reverseCol, 0);
  assert.equal(columnOf(b, 'People', 'Boss').visibleCol, columnOf(b, 'People', 'Name').id);
});

test('les éléments laissés de côté (libellés, descriptions, choix, formats, colonnes affichées, liens) ne sont pas posés', async () => {
  const exported = await exportFrom(documentA(), { tableIds: ['People'] });
  const b = fakeDoc({ docId: 'copydocbbbc3' });
  engineOn(b);
  const omit = new Set(['labels', 'descriptions', 'tableDescriptions', 'choices', 'options', 'displayColumns', 'twoWay']);
  await importText(exported.text, { omit });
  assert.equal(columnOf(b, 'People', 'Name').label, 'Name');
  assert.equal(columnOf(b, 'People', 'Name').description, '');
  assert.equal(columnOf(b, 'People', 'Boss').visibleCol, 0);
  assert.equal(columnOf(b, 'People', 'Boss').reverseCol, 0);
  assert.equal(columnOf(b, 'People', 'Kind').widgetOptions, '');
  assert.equal(columnOf(b, 'People', 'Salary').widgetOptions, '');
  assert.equal(b.fetchRows('_grist_Views_section').find(row => row.id === rowOf(b, 'People').rawViewSectionRef).description, '');
});

test('une colonne affichée que la table visée n\'a pas est dite, et la colonne affiche les numéros de ligne', async () => {
  const text = generateCode([{
    tableId: 'Pets',
    description: null,
    columns: [{ colId: 'Owner', type: 'Ref:Cities', isFormula: false, formula: '', label: 'Owner', visibleColId: 'Ghost' }],
  }]);
  const b = fakeDoc({ docId: 'copydocbbbc4' });
  b.addTable('Cities', [{ id: 'Label', type: 'Text' }]);
  engineOn(b);
  const done = await importText(text);
  assert.deepEqual(keys(done.notes), ['copy.warn.visibleColMissing']);
  assert.deepEqual(done.notes[0].params, { colId: 'Owner', visibleColId: 'Ghost', target: 'Cities' });
  assert.equal(columnOf(b, 'Pets', 'Owner').visibleCol, 0);
});

test('un réglage qui échoue après la création est dit, sans défaire ce qui est créé', async () => {
  const text = generateCode([{ tableId: 'Notes', description: 'Une table', columns: [{ colId: 'A', type: 'Text', isFormula: false, formula: '', label: 'A', description: 'Une colonne' }] }]);
  const b = fakeDoc({ docId: 'copydocbbbc5' });
  const port = fakePort(b);
  const apply = port.apply;
  port.apply = async actions => (actions.some(action => action[0] === 'ModifyColumn' || action[0] === 'UpdateRecord') ? Promise.reject(new Error('boom')) : apply(actions));
  startEngine({ port, version: '9.9.9' });
  const done = await importText(text);
  assert.equal(b.has('Notes'), true);
  assert.deepEqual(keys(done.notes), ['copy.note.refineFailed']);
});

test('le texte d\'export ne contient que ce que la personne a choisi, avec ce qui n\'a pas pu y suivre', async () => {
  const a = documentA();
  a.apply([['AddColumn', 'People', 'Track', { type: 'Int', formula: '$Age', recalcWhen: 2 }], ['AddColumn', 'People', 'Wide', { type: 'Text', isFormula: true, formula: `"${'x'.repeat(6000)}"` }]]);
  const all = await exportFrom(a, { tableIds: ['People'] });
  assert.deepEqual(all.notes.map(note => note.key), ['copy.note.triggerLost', 'copy.note.formulaTooLong']);
  assert.deepEqual(all.referenced.get('Cities'), ['People.City']);
  assert.ok(all.counts.formulas >= 2);

  const narrow = await exportFrom(a, { tableIds: ['People'], excluded: new Map([['People', new Set(['Salary', 'Track', 'Wide', 'Boss'])]]), omit: new Set(['formulas', 'descriptions', 'tableDescriptions']) });
  assert.doesNotMatch(narrow.text, /Salary|Track|Wide|Boss/);
  assert.doesNotMatch(narrow.text, /Le nom de la personne|Les gens|\$Name/);
  assert.deepEqual(narrow.notes, [], 'sans les formules, rien n\'est dit à leur sujet');
  assert.doesNotMatch(narrow.text, /reverse_of/, 'le lien dans les deux sens part avec l\'une de ses colonnes');
});

test('refusedNames : tout identifiant que Grist ou le widget gardent pour eux est refusé avant l\'écriture', () => {
  const column = id => ({ id });
  assert.deepEqual(refusedNames([{ id: 'Notes', columns: [column('Texte'), column('Total')] }]), []);
  assert.deepEqual(refusedNames([{ id: 'Synchro', columns: [] }, { id: 'Journal_x', columns: [] }, { id: '_grist_X', columns: [] }, { id: 'Bad Name', columns: [] }]),
    ['Synchro', 'Journal_x', '_grist_X', 'Bad Name']);
  assert.deepEqual(refusedNames([{ id: 'Notes', columns: [column('id'), column('ID_SYNC'), column('majle'), column('Synchro_Lot'), column('Sync_Applique'), column('gristHelper_A'), column('__proto__')] }]),
    ['Notes.id', 'Notes.ID_SYNC', 'Notes.majle', 'Notes.Synchro_Lot', 'Notes.Sync_Applique', 'Notes.gristHelper_A', 'Notes.__proto__']);
});
