// Filtre des lignes d'un export (SOURCE) : conditions remises en forme, filtre d'avant la 0.11,
// comparaisons par type (les mêmes que la formule), valeurs proposées.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATORS, cellText, columnValues, filterColumns, filterKind, filterTester, operandOf, rowFilter } from '../../js/logic/filters.js';

const cond = (id, source, op, values = [], more = {}) => ({ id, source, visible: '', op, values, ...more });
const only = (...conds) => ({ mode: 'all', conds });
const kept = (filter, rows, labels) => rows.filter(filterTester(filter, labels)).map(r => r.id);

test('types de colonnes : chacun a ses opérateurs, les Pièces jointes ne se filtrent pas', () => {
  assert.equal(filterKind('Text'), 'text');
  assert.equal(filterKind('Choice'), 'text');
  assert.equal(filterKind('Any'), 'text');
  assert.equal(filterKind('ChoiceList'), 'list');
  assert.equal(filterKind('Ref:Villes'), 'ref');
  assert.equal(filterKind('RefList:Villes'), 'refs');
  assert.equal(filterKind('Numeric'), 'number');
  assert.equal(filterKind('Int'), 'number');
  assert.equal(filterKind('Date'), 'date');
  assert.equal(filterKind('DateTime:Europe/Paris'), 'date');
  assert.equal(filterKind('Bool'), 'bool');
  assert.equal(filterKind('Attachments'), null);
  for (const ops of Object.values(OPERATORS)) for (const op of ops) assert.ok(['pick', 'one', 'two', 'none'].includes(operandOf(op)), op);
  assert.equal(operandOf('notin'), 'pick');
  assert.equal(operandOf('between'), 'two');
  assert.equal(operandOf('notempty'), 'none');
});

test('remise en forme : valeurs du type, conditions incomplètes ignorées', () => {
  assert.equal(rowFilter(null), null);
  assert.equal(rowFilter({ mode: 'all', conds: [] }), null);
  assert.equal(rowFilter(only(cond('a b', 'Text', 'in', ['x']))), null, 'identifiant de colonne invalide');
  assert.equal(rowFilter(only(cond('Statut', 'Text', 'in', []))), null, 'rien de coché : la condition ne filtre rien (sinon tout serait effacé)');
  assert.equal(rowFilter(only(cond('Statut', 'Text', 'pareil', ['x']))), null, 'opérateur inconnu');
  assert.equal(rowFilter(only(cond('Montant', 'Numeric', 'gt', ['abc']))), null);
  assert.equal(rowFilter(only(cond('Montant', 'Numeric', 'between', [1]))), null, 'entre : deux valeurs');
  assert.equal(rowFilter(only(cond('Le', 'Date', 'lt', ['12/10/2026']))), null, 'jour au format AAAA-MM-JJ');
  assert.equal(rowFilter(only(cond('Pj', 'Attachments', 'empty'))), null);
  const spec = rowFilter({ mode: 'any', conds: [
    cond('Statut', 'Choice', 'in', [' Actif ', 'actif', 'Clos'], { labels: ['Actif', 'Actif', 'Clos'] }),
    cond('Montant', 'Numeric', 'between', ['10', 20.5, 99]),
    cond('Ville', 'Ref:Villes', 'in', [3, '7', 0, 'x'], { labels: ['Pau', 'Lyon', '?', '?'] }),
    cond('Nom', 'Text', 'contains', ['  DU ']),
    cond('Note', 'Text', 'contains', ['']),
  ] });
  assert.equal(spec.mode, 'any');
  assert.deepEqual(spec.conds.map(c => c.values), [['actif', 'clos'], [10, 20.5], [3, 7], ['du']]);
  assert.deepEqual(spec.conds[0].labels, ['Actif', 'Clos'], 'doublons retirés, chaque valeur garde son texte');
  assert.deepEqual(spec.conds[2].labels, ['Pau', 'Lyon']);
  assert.equal(spec.conds[1].labels, undefined);
  assert.deepEqual(filterColumns(spec), ['Statut', 'Montant', 'Ville', 'Nom']);
  assert.deepEqual(filterColumns(null), []);
  assert.equal(rowFilter({ conds: [cond('Actif', 'Bool', 'true', ['ignorée'])] }).conds[0].values.length, 0);
});

test('filtre d\'avant la 0.11 : une colonne et le texte qu\'elle affiche', () => {
  assert.equal(rowFilter({ id: 'a;b', value: 'x' }), null);
  assert.deepEqual(rowFilter({ id: 'Ville', source: 'Ref:Villes', visible: 'Nom', value: '  LYON ' }),
    { mode: 'all', conds: [{ id: 'Ville', source: 'Ref:Villes', visible: 'Nom', op: 'eq', values: ['lyon'] }] });
  assert.equal(rowFilter({ id: 'Actif', source: 'Bool', value: ' Oui ' }).conds[0].op, 'true');
  assert.equal(rowFilter({ id: 'Actif', source: 'Bool', value: 'Yes' }).conds[0].op, 'true', 'oui ou non, en français comme en anglais');
  assert.equal(rowFilter({ id: 'Actif', source: 'Bool', value: 'peut-être' }).conds[0].op, 'false');
  assert.equal(rowFilter({ id: 'Statut', source: 'Choice', value: '' }).conds[0].op, 'empty', 'texte vide : les lignes vides');
  assert.deepEqual(rowFilter({ id: 'N', source: 'Numeric', value: 0 }).conds[0].values, [0]);
  const rows = [{ id: 1, Ville: 1 }, { id: 2, Ville: 2 }, { id: 3, Ville: 0 }];
  assert.deepEqual(kept({ id: 'Ville', source: 'Ref:Villes', visible: 'Nom', value: 'Lyon' }, rows, { Ville: new Map([[1, 'Lyon'], [2, 'Pau']]) }), [1]);
});

test('texte et choix : l\'une de, contient, commence par, vide ; majuscules indifférentes', () => {
  const rows = [{ id: 1, S: 'Actif' }, { id: 2, S: ' clos ' }, { id: 3, S: '' }, { id: 4, S: null }, { id: 5, S: 'En attente' }, { id: 6, S: 12.0 }];
  assert.deepEqual(kept(only(cond('S', 'Choice', 'in', ['ACTIF', 'Clos'])), rows), [1, 2]);
  assert.deepEqual(kept(only(cond('S', 'Choice', 'notin', ['actif'])), rows), [2, 3, 4, 5, 6], 'les lignes vides ne sont l\'une de rien');
  assert.deepEqual(kept(only(cond('S', 'Text', 'eq', ['12'])), rows), [6], 'nombre entier écrit sans décimale, comme la formule');
  assert.deepEqual(kept(only(cond('S', 'Text', 'contains', ['T'])), rows), [1, 5]);
  assert.deepEqual(kept(only(cond('S', 'Text', 'notcontains', ['t'])), rows), [2, 3, 4, 6]);
  assert.deepEqual(kept(only(cond('S', 'Text', 'starts', ['en '])), rows), [5]);
  assert.deepEqual(kept(only(cond('S', 'Text', 'empty')), rows), [3, 4]);
  assert.deepEqual(kept(only(cond('S', 'Text', 'notempty')), rows), [1, 2, 5, 6]);
  assert.equal(cellText(true), 'oui');
  assert.equal(cellText(['L', 'A ', 'b']), 'l, a, b');
});

test('nombres, dates (dans le fuseau de la colonne) et cases à cocher', () => {
  const rows = [{ id: 1, M: 5, D: 1791763200, H: 1791845940, A: true }, { id: 2, M: 20, D: 1791849600, H: 1791849600, A: false },
    { id: 3, M: null, D: null, H: null, A: null }, { id: 4, M: '?', D: 'x', H: 0, A: 'oui' }];
  assert.deepEqual(kept(only(cond('M', 'Numeric', 'gt', [5])), rows), [2]);
  assert.deepEqual(kept(only(cond('M', 'Int', 'ge', [5])), rows), [1, 2]);
  assert.deepEqual(kept(only(cond('M', 'Numeric', 'noteq', [5])), rows), [2, 3, 4], 'négation : les vides et les valeurs invalides aussi');
  assert.deepEqual(kept(only(cond('M', 'Numeric', 'between', [5, 10])), rows), [1], 'bornes comprises');
  assert.deepEqual(kept(only(cond('M', 'Numeric', 'empty')), rows), [3, 4]);
  // D : 2026-10-12 et 2026-10-13 (Date, minuit UTC). H : 2026-10-12 23:39 UTC, le 13 à Paris.
  assert.deepEqual(kept(only(cond('D', 'Date', 'eq', ['2026-10-12'])), rows), [1]);
  assert.deepEqual(kept(only(cond('D', 'Date', 'gt', ['2026-10-12'])), rows), [2]);
  assert.deepEqual(kept(only(cond('D', 'Date', 'between', ['2026-10-01', '2026-10-13'])), rows), [1, 2]);
  assert.deepEqual(kept(only(cond('H', 'DateTime:Europe/Paris', 'eq', ['2026-10-13'])), rows), [1, 2]);
  assert.deepEqual(kept(only(cond('H', 'DateTime:UTC', 'eq', ['2026-10-13'])), rows), [2]);
  assert.deepEqual(kept(only(cond('H', 'DateTime:Nulle/Part', 'lt', ['2026-10-13'])), rows), [1, 4], 'fuseau inconnu : UTC');
  assert.deepEqual(kept(only(cond('A', 'Bool', 'true')), rows), [1]);
  assert.deepEqual(kept(only(cond('A', 'Bool', 'false')), rows), [2, 3, 4]);
});

test('Référence et Liste de références : par fiche (un renommage ne change rien), contient sur le texte affiché', () => {
  const villes = new Map([[1, 'Pau'], [2, 'Lyon'], [3, 'Paris']]);
  const rows = [{ id: 1, V: 1, L: ['L', 1, 2] }, { id: 2, V: 3, L: ['L', 3] }, { id: 3, V: 0, L: null }, { id: 4, V: 2, L: ['L'] }];
  const labels = { V: villes, L: villes };
  assert.deepEqual(kept(only(cond('V', 'Ref:Villes', 'in', [1, 3])), rows, labels), [1, 2]);
  assert.deepEqual(kept(only(cond('V', 'Ref:Villes', 'in', [1, 3])), rows, { V: new Map([[1, 'Pau-Ville']]) }), [1, 2], 'fiche renommée');
  assert.deepEqual(kept(only(cond('V', 'Ref:Villes', 'notin', [1])), rows, labels), [2, 3, 4]);
  assert.deepEqual(kept(only(cond('V', 'Ref:Villes', 'contains', ['PA'], { visible: 'Nom' })), rows, labels), [1, 2]);
  assert.deepEqual(kept(only(cond('V', 'Ref:Villes', 'empty')), rows, labels), [3]);
  assert.deepEqual(kept(only(cond('L', 'RefList:Villes', 'in', [2])), rows, labels), [1], 'cite l\'une de');
  assert.deepEqual(kept(only(cond('L', 'RefList:Villes', 'contains', ['lyon'])), rows, labels), [1]);
  assert.deepEqual(kept(only(cond('L', 'RefList:Villes', 'empty')), rows, labels), [3, 4]);
});

test('liste de choix, et plusieurs conditions : toutes ou au moins une', () => {
  const rows = [{ id: 1, C: ['L', 'Rouge', 'Vert'], N: 1 }, { id: 2, C: ['L', 'bleu'], N: 2 }, { id: 3, C: null, N: 3 }];
  assert.deepEqual(kept(only(cond('C', 'ChoiceList', 'in', ['VERT', 'bleu'])), rows), [1, 2]);
  assert.deepEqual(kept(only(cond('C', 'ChoiceList', 'notin', ['vert'])), rows), [2, 3]);
  assert.deepEqual(kept(only(cond('C', 'ChoiceList', 'empty')), rows), [3]);
  const both = [cond('C', 'ChoiceList', 'notempty'), cond('N', 'Int', 'ge', [2])];
  assert.deepEqual(kept({ mode: 'all', conds: both }, rows), [2]);
  assert.deepEqual(kept({ mode: 'any', conds: both }, rows), [1, 2, 3]);
  assert.deepEqual(kept({ mode: 'all', conds: [...both, cond('N', 'Int', 'in', [])] }, rows), [2], 'condition incomplète ignorée');
  assert.deepEqual(kept(null, rows), [1, 2, 3]);
});

test('valeurs proposées : présentes dans la colonne, avec leur nombre de lignes, triées', () => {
  const rows = [{ id: 1, S: 'Actif', C: ['L', 'b', 'a'], V: 2, L: ['L', 1, 2, 1] }, { id: 2, S: 'actif ', C: ['L', 'a'], V: 2, L: ['L', 2] },
    { id: 3, S: 'Clos', C: null, V: 0, L: null }, { id: 4, S: '', C: ['L', ''], V: 9, L: ['L'] }];
  assert.deepEqual(columnValues(cond('S', 'Choice'), rows), [{ value: 'actif', label: 'Actif', n: 2 }, { value: 'clos', label: 'Clos', n: 1 }]);
  assert.deepEqual(columnValues(cond('C', 'ChoiceList'), rows), [{ value: 'a', label: 'a', n: 2 }, { value: 'b', label: 'b', n: 1 }]);
  const villes = new Map([[1, 'Pau'], [2, 'Lyon']]);
  assert.deepEqual(columnValues(cond('V', 'Ref:Villes'), rows, villes), [{ value: 9, label: '#9', n: 1 }, { value: 2, label: 'Lyon', n: 2 }]);
  assert.deepEqual(columnValues(cond('L', 'RefList:Villes'), rows, villes), [{ value: 2, label: 'Lyon', n: 2 }, { value: 1, label: 'Pau', n: 1 }], 'une fiche citée deux fois compte une ligne');
  assert.deepEqual(columnValues(cond('M', 'Numeric'), rows), [], 'nombres : pas de liste à cocher');
});
