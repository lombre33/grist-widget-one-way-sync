// La copie unique, lecture du document et résolution de ce qu'on a lu : copy-read, copy-elements, copy-resolve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCode } from '../../js/engine/logic/code-view-write.js';
import { parseCodeView } from '../../js/engine/logic/code-view-parse.js';
import {
  ELEMENTS, elementCounts, omitElements, omitTable, optionKinds, selectOptions, sumCounts,
} from '../../js/engine/logic/copy-elements.js';
import {
  buildExportSchema, exportNotes, findReferencedTables, omitFromExport, readDocument, tablesWithColumns, userColumns, withoutExcluded,
} from '../../js/engine/logic/copy-read.js';
import {
  checkTableId, defaultTableId, formulaApplies, idFromLabel, isTied, isUntied, linkedColumns, resolveColumns, twoWayPairs, twoWayWarnings,
} from '../../js/engine/logic/copy-resolve.js';

const keys = warnings => warnings.map(warning => warning.key);

// Un document comme `fetchRows` rend ses tables internes.
const tables = [
  { id: 1, tableId: 'People', rawViewSectionRef: 10, summarySourceTable: 0 },
  { id: 2, tableId: 'Cities', rawViewSectionRef: 11, summarySourceTable: 0 },
  { id: 3, tableId: 'Synchro', rawViewSectionRef: 12, summarySourceTable: 0 },
  { id: 4, tableId: 'Journal_ab12', rawViewSectionRef: 13, summarySourceTable: 0 },
  { id: 5, tableId: 'People_summary_Name', rawViewSectionRef: 14, summarySourceTable: 1 },
  { id: 6, tableId: '_grist_Tables', rawViewSectionRef: 0, summarySourceTable: 0 },
  { id: 7, tableId: 'GristHidden_import', rawViewSectionRef: 0, summarySourceTable: 0 },
];
const sections = [{ id: 10, description: 'Les gens‮' }, { id: 11, description: '' }];
let nextId = 100;
const column = (parentId, parentPos, colId, extra = {}) => ({
  id: nextId++, parentId, parentPos, colId, type: 'Text', isFormula: false, formula: '', label: colId, description: '',
  widgetOptions: '', visibleCol: 0, reverseCol: 0, recalcWhen: 0, recalcDeps: null, ...extra,
});
const columns = (() => {
  const label = column(2, 1, 'Label');
  const team = column(1, 7, 'Team', { type: 'RefList:People' });
  const boss = column(1, 6, 'Boss', { type: 'Ref:People', visibleCol: 0, reverseCol: team.id });
  team.reverseCol = boss.id;
  const name = column(1, 1, 'Name', { label: 'Nom', description: 'Le nom', widgetOptions: '{"alignment":"center","rules":[{"when":"$A","fillColor":"#000000"}]}' });
  boss.visibleCol = name.id;
  return [
    name, boss, team, label,
    column(1, 2, 'Age', { type: 'Int', formula: '18', recalcWhen: 0 }),
    column(1, 3, 'Salary', { type: 'Numeric', widgetOptions: '{"numMode":"currency","decimals":2}' }),
    column(1, 4, 'Fixed', { type: 'Numeric', widgetOptions: '{"numMode":"currency","currency":"CHF"}' }),
    column(1, 5, 'Hist', { type: 'Int', formula: '$Age + 1', recalcWhen: 2 }),
    column(1, 8, 'Full', { type: 'Text', isFormula: true, formula: '$Name + "!"' }),
    column(1, 9, 'Long', { type: 'Text', isFormula: true, formula: `$Name + "${'x'.repeat(6000)}"` }),
    column(1, 10, 'id_sync', { type: 'Text' }),
    column(1, 11, 'MajLe', { type: 'DateTime:UTC' }),
    column(1, 12, 'gristHelper_Display', { type: 'Any', isFormula: true }),
    column(1, 13, 'manualSort', { type: 'ManualSortPos' }),
    column(3, 1, 'Synchro_Export'),
  ];
})();
const info = [{ id: 1, documentSettings: '{"locale":"fr-FR","engine":"python3"}' }];
const doc = readDocument({ tables, columns, sections, info });

test('le document lu ne montre que les tables de la personne, avec la description de leur section de données brutes', () => {
  assert.deepEqual(doc.tables.map(table => table.tableId), ['Cities', 'People']);
  assert.equal(doc.tables.find(table => table.tableId === 'People').description, 'Les gens', 'le sens d\'écriture n\'est pas gardé');
  assert.equal(doc.tables.find(table => table.tableId === 'Cities').description, null);
  assert.equal(doc.tableIds.length, tables.length, 'les identifiants de toutes les tables, résumés compris');
  assert.deepEqual(doc.format, { locale: 'fr-FR' });
  assert.equal(readDocument({ tables, columns }).format, null);
});

test('la personne voit ses colonnes dans l\'ordre de la Code View : données, puis formules, sans les colonnes du widget ni de Grist', () => {
  const ids = userColumns(doc.allColumns, 1).map(col => col.colId);
  assert.deepEqual(ids, ['Name', 'Age', 'Salary', 'Fixed', 'Hist', 'Boss', 'Team', 'Full', 'Long']);
  assert.deepEqual(tablesWithColumns(doc).find(table => table.tableId === 'Cities').columns, ['Label']);
});

test('l\'export écrit les liens par identifiant, nettoie les options, garde la monnaie et dit ce qui ne passe pas', () => {
  const [people] = buildExportSchema(doc, ['People']);
  const col = id => people.columns.find(c => c.colId === id);
  assert.deepEqual([col('Boss').visibleColId, col('Boss').reverseColId, col('Team').reverseColId], ['Name', 'Team', 'Boss']);
  assert.deepEqual([col('Name').label, col('Name').description, col('Name').widgetOptions], ['Nom', 'Le nom', { alignment: 'center' }]);
  assert.equal(col('Boss').label, 'Boss');
  assert.deepEqual([col('Age').isFormula, col('Age').formula, col('Age').lost], [false, '18', ''], 'la formule « sur les nouvelles lignes » part');
  assert.deepEqual([col('Hist').formula, col('Hist').lost], ['', 'trigger'], 'celle qui se recalcule ne part pas');
  assert.deepEqual([col('Full').isFormula, col('Full').formula], [true, '$Name + "!"']);
  assert.deepEqual([col('Long').formula, col('Long').lost], ['', 'long']);
  assert.deepEqual(col('Salary').widgetOptions, { numMode: 'currency', decimals: 2, currency: 'EUR' }, 'la monnaie du document est écrite : un autre document n\'a pas la même');
  assert.equal(col('Fixed').widgetOptions.currency, 'CHF');
  assert.equal(buildExportSchema({ ...doc, format: null }, ['People'])[0].columns.find(c => c.colId === 'Salary').widgetOptions.currency, undefined);
  assert.deepEqual(exportNotes([people]).map(note => [note.key, note.params.columns]), [['copy.note.triggerLost', 'People.Hist'], ['copy.note.formulaTooLong', 'People.Long']]);
  assert.deepEqual(buildExportSchema(doc, ['Nope', 'Synchro']), []);
});

test('un texte écrit puis relu redonne les mêmes tables et les mêmes colonnes', () => {
  const schema = buildExportSchema(doc, ['People', 'Cities']);
  const { tables: read, warnings } = parseCodeView(generateCode(schema));
  assert.deepEqual(warnings, []);
  assert.deepEqual(read.map(table => [table.tableId, table.columns.map(col => col.id)]),
    schema.map(table => [table.tableId, [...table.columns.filter(c => !c.isFormula).map(c => c.colId), ...table.columns.filter(c => c.isFormula).map(c => c.colId)]]));
});

test('omettre des éléments les retire de la table et des colonnes, les formules ramenées à des données', () => {
  const schema = buildExportSchema(doc, ['People']);
  const bare = omitFromExport(schema, new Set(ELEMENTS));
  const col = id => bare[0].columns.find(c => c.colId === id);
  assert.equal(bare[0].description, null);
  assert.deepEqual([col('Name').label, col('Name').description, col('Name').widgetOptions], [null, null, null]);
  assert.deepEqual([col('Boss').visibleColId, col('Boss').reverseColId], [null, null]);
  assert.deepEqual([col('Full').isFormula, col('Full').formula, col('Age').formula], [false, '', '']);
  const kept = omitFromExport(schema, new Set(['formulas']));
  assert.equal(kept[0].columns.find(c => c.colId === 'Name').label, 'Nom');
  assert.deepEqual(omitFromExport(schema, new Set())[0].columns, schema[0].columns);
});

test('les éléments sont comptés sur les colonnes qui les portent vraiment', () => {
  const [people, cities] = buildExportSchema(doc, ['People', 'Cities']);
  const counts = elementCounts(people.columns, [people, cities]);
  assert.deepEqual(counts, { labels: 1, descriptions: 1, tableDescriptions: 1, choices: 0, options: 3, displayColumns: 1, twoWay: 2, formulas: 2 });
  assert.deepEqual(sumCounts([counts, counts]).options, 6);
  assert.equal(sumCounts([]).labels, 0);
});

test('les options se rangent en choix et en affichage', () => {
  assert.deepEqual(optionKinds({ choices: ['a'], alignment: 'left' }), { choices: true, display: true });
  assert.deepEqual(optionKinds({ choices: [] }), { choices: false, display: false }, 'une liste de choix vide ne dit rien');
  assert.deepEqual(optionKinds(null), { choices: false, display: false });
  assert.deepEqual(selectOptions({ choices: ['a'], choiceOptions: { a: {} }, alignment: 'left' }, { choices: false, display: true }), { alignment: 'left' });
  assert.deepEqual(selectOptions({ choices: ['a'], alignment: 'left' }, { choices: true, display: false }), { choices: ['a'] });
  assert.equal(selectOptions({ alignment: 'left' }, { choices: true, display: false }), null);
  assert.equal(selectOptions(null, { choices: true, display: true }), null);
  assert.equal(omitTable({ description: 'x' }, new Set(['tableDescriptions'])).description, null);
  assert.equal(omitElements({ label: 'a', widgetOptions: { alignment: 'left' } }, new Set(['labels'])).widgetOptions.alignment, 'left');
});

test('les colonnes laissées hors de l\'export, et les tables que visent les Références', () => {
  const rest = withoutExcluded(doc, new Map([['People', new Set(['Name'])]]));
  assert.ok(!rest.some(col => col.colId === 'Name' && col.parentId === 1));
  assert.ok(rest.some(col => col.colId === 'Label'));
  assert.deepEqual([...findReferencedTables(doc, ['People'])], []);
  const withCity = [...columns, column(1, 20, 'City', { type: 'Ref:Cities' }), column(1, 21, 'Cities', { type: 'RefList:Cities' }), column(1, 22, 'Ghost', { type: 'Ref:Nowhere' })];
  assert.deepEqual([...findReferencedTables(readDocument({ tables, columns: withCity }), ['People'])], [['Cities', ['People.City', 'People.Cities']]]);
  assert.deepEqual([...findReferencedTables(readDocument({ tables, columns: withCity }), ['People', 'Cities'])], []);
});

// ---- copy-resolve ----

const textOf = body => parseCodeView(`@grist.UserTable\nclass People:\n${body.map(line => `  ${line}`).join('\n')}\n`).tables[0];

test('chaque colonne devient une définition : type, étiquette, options, formule, et ce que Grist ne fait pas dans AddTable', () => {
  const table = textOf(['Name = grist.Text(label=\'Nom\')', 'Boss = grist.Reference(\'People\', visible_col=\'Name\')', 'Ghost = grist.Reference(\'Nowhere\')', 'Age = grist.Int()',
    '', '@grist.formulaType(grist.Text())', 'def Full(rec, table):', '  return $Name + \'!\'']);
  const { columns: resolved, warnings, counts } = resolveColumns(table, new Map([['People', 'People']]), ['People'], { withFormulas: true });
  const by = id => resolved.find(col => col.id === id);
  assert.deepEqual([by('Name').type, by('Name').label], ['Text', 'Nom']);
  assert.deepEqual([by('Boss').type, by('Boss').visibleColId], ['Ref:People', 'Name']);
  assert.deepEqual([by('Ghost').type, by('Ghost').visibleColId], ['Any', null]);
  assert.deepEqual(keys(warnings), ['copy.warn.refTargetMissingInDoc']);
  assert.deepEqual([by('Full').kind, by('Full').formula, by('Full').problems], ['formula', '$Name + \'!\'', []]);
  assert.equal(formulaApplies(by('Full'), true), true);
  assert.equal(formulaApplies(by('Full'), false), false);
  assert.equal(counts.formulas, 1);
});

test('sans la case des formules, les colonnes calculées sont créées vides et c\'est dit une fois', () => {
  const table = textOf(['A = grist.Int()', '', '@grist.formulaType(grist.Int())', 'def B(rec, table):', '  return $A', '', 'def _default_A(rec, table, value, user):', '  return 1']);
  const { columns: resolved, warnings } = resolveColumns(table, new Map([['People', 'People']]), null);
  assert.deepEqual(keys(warnings), ['copy.warn.computedColumns']);
  assert.equal(warnings[0].params.columns, 'A, B');
  assert.ok(resolved.every(col => col.problems.length === 0));
  const excluded = resolveColumns(table, new Map(), null, { excluded: new Set(['A', 'B']) });
  assert.deepEqual(excluded.warnings, [], 'une colonne laissée de côté ne dit rien');
  assert.equal(excluded.counts.formulas, 0);
});

test('une formule qui n\'a rien à faire dans une colonne n\'est pas posée, la colonne est créée vide et c\'est dit', () => {
  const formulas = {
    Shell: 'import os\nreturn os.listdir("/")',
    Net: 'return REQUEST("https://example.org/x?" + $A)',
    Dunder: 'return $A.__class__',
    Wide: 'return ｅｖａｌ("1")',
    Private: 'return random._os',
    Lookup: 'return Secrets.lookupRecords()',
    Missing: 'return $Absent + 1',
    Fine: 'return $A + len(People.lookupRecords(A=$A))',
    Same: 'return math.floor($A / 2)',
  };
  const lines = ['A = grist.Int()'];
  for (const [id, code] of Object.entries(formulas)) lines.push('', '@grist.formulaType(grist.Any())', `def ${id}(rec, table):`, ...code.split('\n').map(line => `  ${line}`));
  const table = textOf(lines);
  const { columns: resolved, warnings } = resolveColumns(table, new Map([['People', 'People']]), ['People', 'Secrets'], { withFormulas: true });
  const refused = resolved.filter(col => col.problems.length > 0).map(col => col.id).sort();
  assert.deepEqual(refused, ['Dunder', 'Lookup', 'Missing', 'Net', 'Private', 'Shell', 'Wide']);
  assert.deepEqual(resolved.filter(col => formulaApplies(col, true)).map(col => col.id).sort(), ['A', 'Fine', 'Same']);
  assert.equal(warnings.filter(warning => warning.key === 'copy.warn.formulaRefused').length, 7);
  assert.ok(warnings.find(warning => warning.params.colId === 'Shell').params.names.includes('os'));
  assert.deepEqual(resolved.find(col => col.id === 'Missing').problems.map(problem => problem.code), ['missingCol']);
});

test('une table existante peut être citée seulement si la copie la crée, et les colonnes déjà là comptent', () => {
  const table = textOf(['A = grist.Int()', '', '@grist.formulaType(grist.Int())', 'def B(rec, table):', '  return $A + $Old', '', '@grist.formulaType(grist.Int())', 'def C(rec, table):', '  return len(Other.all)']);
  const lone = resolveColumns(table, new Map([['People', 'People']]), ['People', 'Other'], { withFormulas: true });
  assert.deepEqual(lone.columns.find(col => col.id === 'B').problems.map(problem => problem.code), ['missingCol']);
  assert.deepEqual(lone.columns.find(col => col.id === 'C').problems.map(problem => problem.code), ['foreignTable']);
  const known = resolveColumns(table, new Map([['People', 'People']]), ['People', 'Other'], { withFormulas: true, existing: ['Old'] });
  assert.deepEqual(known.columns.find(col => col.id === 'B').problems, []);
  const renamed = resolveColumns(table, new Map([['People', 'People2']]), ['People2'], { withFormulas: true });
  assert.equal(renamed.columns.find(col => col.id === 'B').problems.length, 1, 'une formule n\'est pas réécrite : la colonne manquante est dite');
});

test('les identifiants de tables sont contrôlés comme Grist les garderait', () => {
  assert.equal(defaultTableId('_people'), 'People');
  assert.equal(defaultTableId('people'), 'People');
  assert.equal(checkTableId('People', ['Cities'], []), null);
  assert.equal(checkTableId('', [], []), 'copy.validation.emptyId');
  for (const bad of ['people', '1abc', 'a b', 'None', 'True', 'Été']) assert.equal(checkTableId(bad, [], []), 'copy.validation.invalidId', bad);
  assert.equal(checkTableId('People', [], ['people']), 'copy.validation.duplicateId');
  assert.equal(checkTableId('People', ['PEOPLE'], []), 'copy.validation.tableExists');
  assert.equal(checkTableId('People', null, []), null);
});

test('l\'identifiant d\'une colonne est « lié » à son étiquette quand Grist l\'en a tiré', () => {
  assert.equal(idFromLabel('Prénom de la personne'), 'Prenom_de_la_personne');
  assert.equal(idFromLabel('1er'), 'c1er');
  assert.equal(idFromLabel('class'), 'cclass');
  assert.equal(isTied('Prénom', 'Prenom'), true);
  assert.equal(isTied('Prénom', 'Prenom2'), true);
  assert.equal(isTied('Prénom', 'Prenom1'), false);
  assert.equal(isTied('Prénom', 'Given'), false);
  assert.equal(isTied('???', 'A'), true);
  assert.equal(isUntied({ id: 'Given', label: 'Prénom' }), true);
  assert.equal(isUntied({ id: 'Given', label: null }), false);
});

test('deux colonnes qui se nomment l\'une l\'autre et se visent forment un lien dans les deux sens, les autres restent simples', () => {
  const tablesOf = {
    A: textOf(['Link = grist.ReferenceList(\'B\', reverse_of=\'Back\')', 'Alone = grist.Reference(\'B\', reverse_of=\'Missing\')', 'Wrong = grist.Reference(\'B\', reverse_of=\'Wrong\')']),
    B: textOf(['Back = grist.Reference(\'A\', reverse_of=\'Link\')', 'Wrong = grist.Reference(\'B\', reverse_of=\'Wrong\')']),
  };
  const resolved = Object.entries(tablesOf).map(([id, table]) => ({ id, columns: resolveColumns(table, new Map([['A', 'A'], ['B', 'B']]), null).columns }));
  const pairs = twoWayPairs(resolved);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].map(({ tableId, col }) => `${tableId}.${col.id}`), ['A.Link', 'B.Back']);
  assert.equal(linkedColumns(resolved).size, 2);
  const warnings = twoWayWarnings(resolved);
  assert.deepEqual(warnings.map(warning => [warning.table, warning.params.columns]), [['A', 'Alone, Wrong'], ['B', 'Wrong']]);
});
