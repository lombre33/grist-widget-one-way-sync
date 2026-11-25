// La copie unique, partie pure du moteur : lire et écrire le texte « Code View » d'une table sans l'exécuter (py-text,
// code-view-types, code-view-parse, code-view-write), lire le document (copy-read) et résoudre ce qu'on y a lu (copy-resolve).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findMatchingClose, parseArguments, parseString, parseStringList, quotePython, stringLines, withoutComment,
} from '../../js/engine/logic/py-text.js';
import {
  buildTypeExpression, copyOptions, defaultLiteralForType, isReservedColumnId, resolveColumnType, splitType,
} from '../../js/engine/logic/code-view-types.js';
import { COLUMNS_MAX, TABLES_MAX, TEXT_MAX, isReservedTableId, parseCodeView } from '../../js/engine/logic/code-view-parse.js';
import { generateCode } from '../../js/engine/logic/code-view-write.js';

const keys = warnings => warnings.map(warning => warning.key);
const resolve = (dslType, args, colId = 'C') => {
  const warnings = [];
  return { ...resolveColumnType(dslType, args, colId, warnings), warnings };
};

// ---- py-text : du texte Python lu sans l'exécuter ----

test('quotePython et parseString sont réciproques, guillemets, barres obliques et retours à la ligne compris', () => {
  for (const text of ['', 'simple', 'l\'apostrophe', 'a\\b', 'deux\nlignes', 'tab\tet\rretour', '« accents » éè', '\\\'', '\\n littéral']) {
    assert.equal(parseString(quotePython(text)), text, JSON.stringify(text));
    assert.ok(!quotePython(text).includes('\n'), 'le littéral tient sur une ligne');
  }
  assert.equal(parseString('"entre guillemets"'), 'entre guillemets');
  assert.equal(parseString('"l\\"un"'), 'l"un');
});

test('parseString ne lit que des littéraux de texte entiers', () => {
  for (const source of ['abc', '\'a\' + \'b\'', '\'a\', \'b\'', '\'non fermé', undefined, null, 12, ['\'a\'']]) assert.equal(parseString(source), null, String(source));
});

test('parseArguments coupe aux virgules du niveau haut seulement, et les noms propres aux objets ne sont pas des arguments', () => {
  const { positional, kwargs } = parseArguments('\'People\', visible_col=\'Name, Full\', choices=[\'a\', \'b\'], label="(x)"');
  assert.deepEqual(positional, ['\'People\'']);
  assert.deepEqual({ ...kwargs }, { visible_col: '\'Name, Full\'', choices: '[\'a\', \'b\']', label: '"(x)"' });
  const odd = parseArguments('constructor=1, __proto__=2, toString=3').kwargs;
  assert.equal(Object.getPrototypeOf(odd), null, 'sans prototype : `constructor` ne vise rien');
  assert.deepEqual(Object.keys(odd).sort(), ['__proto__', 'constructor', 'toString']);
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(parseArguments('').positional, []);
});

test('findMatchingClose ignore les parenthèses des textes, withoutComment les dièses des textes', () => {
  const text = 'f(\'Oui (confirmé)\', g(1))';
  assert.equal(findMatchingClose(text, 1), text.length - 1);
  assert.equal(findMatchingClose('f(\'a', 1), -1);
  assert.equal(findMatchingClose('abc', 0), -1, 'pas une ouverture');
  assert.equal(withoutComment('x = \'a # b\'  # fin'), 'x = \'a # b\'');
  assert.equal(withoutComment('x = 1'), 'x = 1');
});

test('parseStringList rend les textes, dit ceux qui n\'en sont pas, et null pour une liste vide ou qui n\'en est pas une', () => {
  const skipped = [];
  assert.deepEqual(parseStringList('[\'a\', "b", 3, c]', item => skipped.push(item)), ['a', 'b']);
  assert.deepEqual(skipped, ['3', 'c']);
  assert.equal(parseStringList('[]'), null);
  assert.equal(parseStringList('\'a\''), null);
  assert.equal(parseStringList(undefined), null);
});

test('stringLines repère les lignes d\'un texte sur plusieurs lignes : triples guillemets, barre oblique, littéraux joints', () => {
  const lines = ['x = """', 'dans le texte', '"""', 'y = (\'a\'', '  \'b\')', 'z = 1', 'w = \'a\' \\', '  \'b\'', 'v = 2'];
  assert.deepEqual(stringLines(lines), [false, true, true, false, true, false, false, true, false]);
});

test('stringLines lit en une passe un texte piégé de triples guillemets jamais fermés', () => {
  const text = '\'\'\'a\n'.repeat(20000).split('\n');
  const start = Date.now();
  stringLines(text);
  assert.ok(Date.now() - start < 3000, 'pas de lecture quadratique');
});

// ---- code-view-types ----

test('splitType et buildTypeExpression écrivent les types comme la Code View de Grist', () => {
  assert.deepEqual(splitType('Ref:People'), { name: 'Ref', arg: 'People' });
  assert.deepEqual(splitType('Text'), { name: 'Text', arg: '' });
  assert.equal(buildTypeExpression('Text'), 'grist.Text()');
  assert.equal(buildTypeExpression('Ref:People', { visible_col: '\'Name\'' }), 'grist.Reference(\'People\', visible_col=\'Name\')');
  assert.equal(buildTypeExpression('RefList:People'), 'grist.ReferenceList(\'People\')');
  assert.equal(buildTypeExpression('DateTime:Europe/Paris'), 'grist.DateTime(\'Europe/Paris\')');
  assert.equal(buildTypeExpression('Choice', { choices: '[\'a\']' }), 'grist.Choice(choices=[\'a\'])');
});

test('la valeur d\'une formule vide dépend du type', () => {
  assert.deepEqual(['Text', 'Numeric', 'Int', 'Bool', 'Date', 'Ref:T', 'Choice', 'ChoiceList', 'Any'].map(defaultLiteralForType), ['\'\'', '0.0', '0', 'False', 'None', '0', '\'\'', 'None', 'None']);
});

test('chaque type du constructeur se lit', () => {
  const types = [
    ['Text', '', 'Text'], ['Numeric', '', 'Numeric'], ['Int', '', 'Int'], ['Bool', '', 'Bool'], ['Date', '', 'Date'],
    ['Choice', '', 'Choice'], ['ChoiceList', '', 'ChoiceList'], ['Attachments', '', 'Attachments'], ['Blob', '', 'Blob'], ['Any', '', 'Any'],
    ['DateTime', '\'Europe/Paris\'', 'DateTime:Europe/Paris'],
    ['Reference', '\'People\'', 'Ref:People'], ['ReferenceList', '"People"', 'RefList:People'],
  ];
  for (const [dsl, args, type] of types) {
    const column = resolve(dsl, args);
    assert.equal(column.type, type, dsl);
    assert.deepEqual(column.warnings, [], dsl);
  }
  assert.equal(resolve('Reference', '\'People\'').refTarget, 'People');
});

test('un type inconnu devient Any, et un nom propre aux objets n\'est pas un type', () => {
  for (const dsl of ['Fancy', 'constructor', '__proto__', 'toString']) {
    const column = resolve(dsl, '');
    assert.equal(column.type, 'Any', dsl);
    assert.deepEqual(keys(column.warnings), ['copy.warn.unknownType'], dsl);
  }
});

test('une Référence sans table lisible, ou à la table d\'un nom dangereux, devient Any', () => {
  for (const args of ['', 'visible_col=\'X\'', '\'a b\'', '\'__proto__\'', '\'constructor\'', 'People']) {
    const column = resolve('Reference', args);
    assert.equal(column.type, 'Any', args);
    assert.equal(column.refTarget, null, args);
    assert.deepEqual(keys(column.warnings), ['copy.warn.refTargetMissingSyntax'], args);
  }
});

test('le fuseau d\'une colonne Date et heure doit être un nom de fuseau, sinon UTC et une remarque', () => {
  assert.equal(resolve('DateTime', '\'America/Argentina/Buenos_Aires\'').type, 'DateTime:America/Argentina/Buenos_Aires');
  assert.equal(resolve('DateTime', '\'Etc/GMT+5\'').type, 'DateTime:Etc/GMT+5');
  assert.deepEqual(keys(resolve('DateTime', '').warnings), ['copy.warn.dateTimeNoTimezone']);
  assert.equal(resolve('DateTime', '').type, 'DateTime:UTC');
  for (const bad of ['\'Paris, France\'', '\'x\\\') + evil(\'\'', '\'../../etc\'', '\'\'']) {
    const column = resolve('DateTime', bad);
    assert.equal(column.type, 'DateTime:UTC', bad);
    assert.ok(column.warnings.length > 0, bad);
  }
});

test('les choix et les options d\'affichage passent par la liste blanche du moteur', () => {
  const column = resolve('Choice', 'choices=[\'a\', \'b\', \'a\'], widget_options=\'{"choiceOptions":{"a":{"fillColor":"#FF0000","textColor":"red"}},"alignment":"center","dropdownCondition":{"text":"x"},"rules":[{"when":"$A","fillColor":"#000000"}],"evil":1}\'');
  assert.deepEqual(column.widgetOptions, { alignment: 'center', choices: ['a', 'b'], choiceOptions: { a: { fillColor: '#FF0000' } } });
  assert.equal(resolve('Choice', 'choices=[\'a\']').widgetOptions.choices[0], 'a');
  assert.equal(resolve('Text', 'choices=[\'a\']').widgetOptions, null, 'la liste de choix n\'est lue que pour un type de choix');
});

test('des options mal écrites sont dites et laissées, jamais exécutées', () => {
  assert.deepEqual(keys(resolve('Text', 'widget_options=\'{pas du json\'').warnings), ['copy.warn.invalidWidgetOptions']);
  assert.deepEqual(keys(resolve('Text', 'widget_options=\'[1, 2]\'').warnings), ['copy.warn.invalidWidgetOptions']);
  assert.deepEqual(keys(resolve('Text', `widget_options='${'x'.repeat(30000)}'`).warnings), ['copy.warn.invalidWidgetOptions']);
  assert.deepEqual(keys(resolve('Text', 'widget_options=json.dumps(1)').warnings), ['copy.warn.unreadableOption']);
  assert.deepEqual(keys(resolve('Choice', 'choices=[\'a\', x]').warnings), ['copy.warn.unreadableOption']);
  assert.equal(resolve('Text', 'widget_options=\'{"__proto__":{"polluted":1}}\'').widgetOptions, null);
  assert.equal(Object.prototype.polluted, undefined);
});

test('les options d\'une copie : sans règles, une Référence a celles d\'un texte, un texte peut rester un lien', () => {
  assert.equal(copyOptions('Text', '{"rules":[{"when":"$A","fillColor":"#000000"}]}'), null);
  assert.deepEqual(copyOptions('Ref:People', { alignment: 'right', wrap: true, widget: 'Reference' }), { alignment: 'right', wrap: true });
  assert.deepEqual(copyOptions('Text', { widget: 'HyperLink' }), { widget: 'HyperLink' });
  assert.deepEqual(copyOptions('Text', { widget: 'Markdown' }), { widget: 'Markdown' });
  assert.equal(copyOptions('Int', { widget: 'HyperLink' }), null, 'un lien n\'a de sens que dans un texte');
  assert.equal(copyOptions('Blob', { alignment: 'left' }), null);
  assert.deepEqual(copyOptions('Numeric', '{"numMode":"currency","currency":"EUR","decimals":2}'), { numMode: 'currency', currency: 'EUR', decimals: 2 });
  assert.equal(copyOptions('Numeric', '{"currency":"eur"}'), null, 'une monnaie qui n\'en est pas une');
});

test('étiquette, description et colonnes liées sont lues, nettoyées et bornées', () => {
  const column = resolve('Reference', '\'People\', label=\'Nom\\u202e\', description=\'Une\\nnote\', visible_col=\'Name\', reverse_of=\'Mine\'');
  assert.equal(column.label, 'Nom', 'le sens d\'écriture n\'est pas gardé');
  assert.equal(column.description, 'Une\nnote');
  assert.equal(column.visibleColId, 'Name');
  assert.equal(column.reverseColId, 'Mine');
  assert.equal(resolve('Text', 'visible_col=\'a b\'').visibleColId, null);
  assert.equal(resolve('Text', 'reverse_of=\'__proto__\'').reverseColId, null);
  assert.ok(resolve('Text', `description='${'é'.repeat(5000)}'`).description.length <= 2000);
  assert.equal(resolve('Text', 'label=\'\x07\x08\'').label, null);
});

test('les identifiants que Grist ou le widget gardent pour eux ne se copient pas', () => {
  for (const id of ['id', 'ID', 'manualSort', 'id_sync', 'MajLe', 'majle', 'RecalculLe', 'Sync_Etat', 'Sync_Applique', 'Synchro_Export', 'Synchro_Lot', 'gristHelper_Display', 'Supprimee_a_la_source']) {
    assert.equal(isReservedColumnId(id), true, id);
  }
  for (const id of ['Name', 'Supprime', 'Synchronisation', 'Sync', 'Date', 'ident', 'my_id_sync']) assert.equal(isReservedColumnId(id), false, id);
});

test('les tables du widget et de Grist ne se copient pas', () => {
  for (const id of ['Synchro', 'Synchro_Export', 'Journal_abc', '_grist_Tables', '_Summary', '_x']) assert.equal(isReservedTableId(id), true, id);
  for (const id of ['People', 'Synchronisation', 'Journals', 'Journal']) assert.equal(isReservedTableId(id), false, id);
});

// ---- code-view-parse ----

const RICH = `import grist
from functions import *

@grist.UserTable
class People:
  'Les gens'
  Name = grist.Text(label='Nom', description='Le nom')
  Age = grist.Int()
  City = grist.Reference('Cities', visible_col='Label')
  Tags = grist.ChoiceList(choices=['a', 'b'])
  id_sync = grist.Text()

  @grist.formulaType(grist.Text())
  def Full(rec, table):
    return $Name + '!'

  def _default_Age(rec, table, value, user):
    return 18

@grist.UserTable
class Cities:
  Label = grist.Text()
`;

test('un texte de Code View donne ses tables, ses colonnes, sa description et ses formules', () => {
  const { tables, warnings } = parseCodeView(RICH);
  assert.deepEqual(tables.map(table => table.tableId), ['People', 'Cities']);
  assert.equal(tables[0].description, 'Les gens');
  assert.deepEqual(tables[0].columns.map(col => [col.id, col.kind]), [['Name', 'data'], ['Age', 'trigger'], ['City', 'data'], ['Tags', 'data'], ['Full', 'formula']]);
  const full = tables[0].columns.find(col => col.id === 'Full');
  assert.deepEqual([full.dslType, full.code], ['Text', 'return $Name + \'!\'']);
  assert.equal(tables[0].columns.find(col => col.id === 'Age').code, 'return 18');
  assert.deepEqual(keys(warnings), ['copy.warn.reservedColumnId']);
  assert.equal(warnings[0].params.colId, 'id_sync');
  assert.equal(tables[1].description, null);
});

test('les fins de ligne de Windows et les commentaires ne changent rien', () => {
  const crlf = parseCodeView(RICH.replace(/\n/g, '\r\n'));
  assert.deepEqual(crlf.tables.map(table => table.columns.length), [5, 1]);
  const commented = parseCodeView('@grist.UserTable\nclass T:  # la table\n  # un commentaire\n  A = grist.Int()  # la colonne\n');
  assert.deepEqual(commented.tables[0].columns.map(col => col.id), ['A']);
  assert.deepEqual(commented.warnings, []);
});

test('une table du widget ou de Grist est refusée, avec sa remarque', () => {
  const text = ['Synchro', 'Synchro_Export', 'Journal_x', '_grist_Tables', '__proto__', 'Fine'].map(id => `@grist.UserTable\nclass ${id}:\n  A = grist.Int()\n`).join('\n');
  const { tables, warnings } = parseCodeView(text);
  assert.deepEqual(tables.map(table => table.tableId), ['Fine']);
  assert.deepEqual(warnings.map(warning => warning.params.tableId), ['Synchro', 'Synchro_Export', 'Journal_x', '_grist_Tables', '__proto__']);
  assert.ok(keys(warnings).every(key => key === 'copy.warn.reservedTableId'));
});

test('une colonne réservée, en double (casse comprise) ou en trop est dite et laissée', () => {
  const body = ['id = grist.Int()', 'manualSort = grist.Numeric()', 'MajLe = grist.DateTime(\'UTC\')', 'Name = grist.Text()', 'name = grist.Text()', 'gristHelper_X = grist.Text()', '__proto__ = grist.Text()'];
  const { tables, warnings } = parseCodeView(`@grist.UserTable\nclass T:\n${body.map(line => `  ${line}`).join('\n')}\n`);
  assert.deepEqual(tables[0].columns.map(col => col.id), ['Name']);
  assert.deepEqual(keys(warnings), ['copy.warn.reservedColumnId', 'copy.warn.reservedColumnId', 'copy.warn.reservedColumnId', 'copy.warn.duplicateColumnId', 'copy.warn.reservedColumnId', 'copy.warn.reservedColumnId']);
});

test('les limites d\'un texte collé sont tenues et dites', () => {
  assert.deepEqual(keys(parseCodeView('x'.repeat(TEXT_MAX + 1)).warnings), ['copy.warn.textTooLong']);
  const many = Array.from({ length: TABLES_MAX + 2 }, (_, i) => `@grist.UserTable\nclass T${i}:\n  A = grist.Int()\n`).join('\n');
  const parsed = parseCodeView(many);
  assert.equal(parsed.tables.length, TABLES_MAX);
  assert.deepEqual([...new Set(keys(parsed.warnings))], ['copy.warn.tooManyTables']);
  const wide = `@grist.UserTable\nclass W:\n${Array.from({ length: COLUMNS_MAX + 3 }, (_, i) => `  C${i} = grist.Int()`).join('\n')}\n`;
  const wideParsed = parseCodeView(wide);
  assert.equal(wideParsed.tables[0].columns.length, COLUMNS_MAX);
  assert.equal(keys(wideParsed.warnings).length, 3);
});

test('sans table, ou avec un décorateur sans classe, le texte le dit', () => {
  assert.deepEqual(keys(parseCodeView('').warnings), ['copy.warn.noTableFound']);
  assert.deepEqual(keys(parseCodeView('print("bonjour")').warnings), ['copy.warn.noTableFound']);
  const { tables, warnings } = parseCodeView('@grist.UserTable\nx = 1\n');
  assert.equal(tables.length, 0);
  assert.deepEqual(keys(warnings), ['copy.warn.decoratorNoClass']);
});

test('un type de formule en double ou sans fonction, un décorateur ou un contenu inconnus sont dits', () => {
  const text = `@grist.UserTable
class T:
  @grist.formulaType(grist.Int())
  @grist.formulaType(grist.Text())
  def A(rec, table):
    return 'a'
  @grist.formulaType(grist.Int())
  B = grist.Text()
  @other.thing
  import os
  C = grist.Text()
`;
  const { tables, warnings } = parseCodeView(text);
  assert.deepEqual(tables[0].columns.map(col => [col.id, col.dslType]), [['A', 'Text'], ['B', 'Text'], ['C', 'Text']]);
  assert.deepEqual(keys(warnings), ['copy.warn.formulaTypeDuplicate', 'copy.warn.formulaTypeNoFunction', 'copy.warn.unknownDecorator', 'copy.warn.unrecognizedContent']);
});

test('rien n\'est exécuté : du code Python dans le texte n\'est qu\'un contenu non reconnu', () => {
  const text = `@grist.UserTable
class T:
  __import__('os').system('rm -rf /')
  A = grist.Text(label=__import__('os').getcwd())
  B = grist.Int()
`;
  const { tables, warnings } = parseCodeView(text);
  assert.deepEqual(tables[0].columns.map(col => col.id), ['A', 'B']);
  assert.equal(resolveFirst(tables[0]).label, null);
  assert.ok(keys(warnings).includes('copy.warn.unrecognizedContent'));
});
const resolveFirst = table => resolve(table.columns[0].dslType, table.columns[0].argsRaw, table.columns[0].id);

test('la formule d\'une colonne sur plusieurs lignes, avec un texte à triples guillemets, se lit des deux mises en page de Grist', () => {
  const after = '@grist.UserTable\nclass T:\n  def F(rec, table):\n    x = """a\nb"""\n    return x\n  G = grist.Int()\n';
  const before = '@grist.UserTable\nclass T:\n  def F(rec, table):\n    x = """a\n    b"""\n    return x\n  G = grist.Int()\n';
  for (const text of [after, before]) {
    const { tables } = parseCodeView(text);
    assert.deepEqual(tables[0].columns.map(col => col.id).sort(), ['F', 'G'], text);
    assert.match(tables[0].columns.find(col => col.id === 'F').code, /^x = """a\n\s*b"""\nreturn x$/);
  }
});

test('un grand texte est lu vite', () => {
  const text = Array.from({ length: 2000 }, (_, i) => `@grist.UserTable\nclass T${i}:\n${Array.from({ length: 20 }, (__, j) => `  C${j} = grist.Text(label='${'é'.repeat(30)}')`).join('\n')}\n`).join('\n');
  const start = Date.now();
  parseCodeView(text.slice(0, TEXT_MAX));
  assert.ok(Date.now() - start < 5000);
});

// ---- code-view-write : l'aller-retour ----

const schema = [
  {
    tableId: 'People',
    description: 'Les gens, l\'équipe\nde « Paris »',
    columns: [
      { colId: 'Name', type: 'Text', isFormula: false, formula: '', label: 'Nom', description: 'Le nom d\'usage', widgetOptions: { alignment: 'center', widget: 'HyperLink' }, visibleColId: null, reverseColId: null },
      { colId: 'Age', type: 'Int', isFormula: false, formula: '18', label: null, description: null, widgetOptions: null, visibleColId: null, reverseColId: null },
      { colId: 'Status', type: 'Choice', isFormula: false, formula: '', label: null, description: null, widgetOptions: { choices: ['Oui', 'Non', 'l\'autre'], choiceOptions: { Oui: { fillColor: '#00FF00' } } }, visibleColId: null, reverseColId: null },
      { colId: 'Boss', type: 'Ref:People', isFormula: false, formula: '', label: null, description: null, widgetOptions: null, visibleColId: 'Name', reverseColId: 'Team' },
      { colId: 'Team', type: 'RefList:People', isFormula: false, formula: '', label: null, description: null, widgetOptions: null, visibleColId: null, reverseColId: 'Boss' },
      { colId: 'Seen', type: 'DateTime:Europe/Paris', isFormula: false, formula: '', label: null, description: null, widgetOptions: { dateFormat: 'DD/MM/YYYY' }, visibleColId: null, reverseColId: null },
      { colId: 'Full', type: 'Text', isFormula: true, formula: '$Name + " (" + str($Age) + ")"', label: null, description: null, widgetOptions: null, visibleColId: null, reverseColId: null },
      { colId: 'Blank', type: 'Numeric', isFormula: true, formula: '', label: null, description: null, widgetOptions: null, visibleColId: null, reverseColId: null },
      { colId: 'Multi', type: 'Any', isFormula: true, formula: 'x = 1\nif x:\n  return "a"\nreturn "b"', label: null, description: null, widgetOptions: null, visibleColId: null, reverseColId: null },
    ],
  },
  { tableId: 'Empty', description: null, columns: [] },
];

test('le texte écrit se relit à l\'identique : types, étiquettes, descriptions, choix, options, liens, formules', () => {
  const { tables, warnings } = parseCodeView(generateCode(schema));
  assert.deepEqual(warnings, []);
  assert.deepEqual(tables.map(table => table.tableId), ['People', 'Empty']);
  assert.equal(tables[0].description, schema[0].description);
  assert.equal(tables[1].columns.length, 0, 'une table sans colonne s\'écrit `pass`');
  const read = Object.fromEntries(tables[0].columns.map((col) => {
    const resolved = resolve(col.dslType, col.argsRaw, col.id);
    assert.deepEqual(resolved.warnings, [], col.id);
    return [col.id, { ...col, ...resolved }];
  }));
  assert.deepEqual(Object.keys(read), ['Name', 'Age', 'Status', 'Boss', 'Team', 'Seen', 'Full', 'Blank', 'Multi'].sort((a, b) => order(a) - order(b)));
  assert.deepEqual([read.Name.label, read.Name.description, read.Name.widgetOptions], ['Nom', 'Le nom d\'usage', { alignment: 'center', widget: 'HyperLink' }]);
  assert.deepEqual(read.Status.widgetOptions, schema[0].columns[2].widgetOptions);
  assert.deepEqual([read.Boss.type, read.Boss.visibleColId, read.Boss.reverseColId], ['Ref:People', 'Name', 'Team']);
  assert.deepEqual([read.Team.type, read.Team.reverseColId], ['RefList:People', 'Boss']);
  assert.equal(read.Seen.type, 'DateTime:Europe/Paris');
  assert.deepEqual(read.Seen.widgetOptions, { dateFormat: 'DD/MM/YYYY' });
  assert.equal(read.Age.kind, 'trigger');
  assert.equal(read.Age.code, 'return 18');
  assert.equal(read.Full.kind, 'formula');
  assert.equal(read.Full.code, 'return $Name + " (" + str($Age) + ")"');
  assert.equal(read.Blank.code, 'return 0.0');
  assert.equal(read.Multi.code, 'x = 1\nif x:\n  return "a"\nreturn "b"');
});
const ORDER = ['Name', 'Age', 'Status', 'Boss', 'Team', 'Seen', 'Full', 'Blank', 'Multi'];
const order = id => ORDER.indexOf(id);

test('un texte qui contient des guillemets, des barres obliques et des lignes ne casse pas l\'écriture', () => {
  const tricky = [{
    tableId: 'T',
    description: '\'\'\' """ \\ fin',
    columns: [{ colId: 'A', type: 'Text', isFormula: false, formula: '', label: 'a\\\'b"c', description: 'l1\nl2\\n', widgetOptions: null, visibleColId: null, reverseColId: null }],
  }];
  const { tables, warnings } = parseCodeView(generateCode(tricky));
  assert.deepEqual(warnings, []);
  assert.equal(tables[0].description, tricky[0].description);
  const col = tables[0].columns[0];
  const resolved = resolve(col.dslType, col.argsRaw, col.id);
  assert.deepEqual([resolved.label, resolved.description], ['a\\\'b"c', 'l1\nl2\\n']);
});
