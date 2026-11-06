// Table Synchro : celle du widget ou d'une autre personne, colonnes en trop, colonne que refuse un
// journal. Le cas vu (0.5.9) : une table Synchro faite à la main, avec les colonnes A, B et C de Grist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncColumns } from '../../js/logic/formulas.js';
import { exportCondition } from '../../js/logic/exports.js';
import {
  columnFault, foreignSync, freeTableName, hasContent, lostSync, ownsSync, refusedColumn, strayColumns, syncColumnIds, tableNameProblem,
} from '../../js/logic/strays.js';

// Colonnes telles que readSchema les rend.
const col = (colId, extra = {}) => ({ id: 1, colId, label: colId, type: 'Text', isFormula: false, formula: '', ...extra });
const widget = () => syncColumns([]).map(c => col(c.id));
const grist = () => ['A', 'B', 'C'].map(id => col(id, { type: 'Any', isFormula: true }));
const schemaOf = tables => ({ has: id => id in tables, columns: id => tables[id] || null });

test('la table du widget est reconnue à sa colonne Synchro_Export, celle d\'une autre personne non', () => {
  const own = schemaOf({ Synchro: [...widget(), ...grist()] });
  assert.deepEqual([ownsSync(own), foreignSync(own)], [true, false], 'les colonnes en plus n\'en font pas la table d\'une autre personne');
  const theirs = schemaOf({ Synchro: [col('manualSort'), ...grist()] });
  assert.deepEqual([ownsSync(theirs), foreignSync(theirs)], [false, true]);
  const none = schemaOf({ Contacts: grist() });
  assert.deepEqual([ownsSync(none), foreignSync(none)], [false, false], 'sans table Synchro, rien à reprendre ni à refuser');
});

test('le widget a neuf colonnes dans Synchro', () => {
  assert.deepEqual([...syncColumnIds()].sort(), ['Sync_Etat', 'Sync_Par', 'Synchro_Colonnes', 'Synchro_Export', 'Synchro_Ids', 'Synchro_Lot', 'Synchro_Renvoi', 'Synchro_Table', 'Synchro_Type']);
});

test('colonnes en trop : toutes listées, hors colonnes du widget, ordre de Grist et colonnes cachées', () => {
  const columns = [col('manualSort', { type: 'ManualSortPos' }), ...widget(), ...grist(), col('gristHelper_Display', { type: 'Any', isFormula: true })];
  assert.deepEqual(strayColumns(columns, []).map(s => s.id), ['A', 'B', 'C']);
  assert.deepEqual(strayColumns(widget(), []), [], 'une table du widget seule n\'a rien en trop');
});

test('colonnes en trop : vides, remplies, ou à formule', () => {
  const columns = [...widget(), col('A', { type: 'Any', isFormula: true }), col('Note', { type: 'Text' }), col('Score', { type: 'Numeric' }),
    col('Choix', { type: 'ChoiceList' }), col('Total', { type: 'Numeric', isFormula: true, formula: '$Score * 2' })];
  const rows = [
    { id: 1, Note: 'à voir', Score: 0, Choix: ['L'], A: null, Total: 0 },
    { id: 2, Note: '', Score: 12, Choix: ['L', 'a'], A: null, Total: 24 },
    { id: 3, Note: '  ', Score: 0, Choix: ['L'], A: null, Total: 0 },
  ];
  const [a, note, score, choix, total] = strayColumns(columns, rows);
  assert.deepEqual([a.filled, hasContent(a)], [0, false], 'une colonne par défaut de Grist est vide');
  assert.deepEqual([note.filled, score.filled, choix.filled], [1, 1, 1], '0, texte vide et liste vide ne sont pas des valeurs');
  assert.deepEqual([total.filled, total.formula, hasContent(total)], [0, '$Score * 2', true], 'une formule est à sauvegarder, pas ses valeurs');
  assert.deepEqual([note.type, score.label], ['Text', 'Score']);
});

test('colonne refusée par un journal : la première nommée, quelle que soit la mise en forme de l\'erreur', () => {
  const usage = lastErrorMessage => ({ lastErrorMessage });
  assert.equal(refusedColumn(usage('{"error":"Invalid column \\"A\\""}')), 'A', 'le texte de la capture : 400 {"error":"Invalid column \\"A\\""}');
  assert.equal(refusedColumn(usage('Invalid column "Sync_Par" at https://g.fr/api/s/k/tables/J/records')), 'Sync_Par');
  assert.equal(refusedColumn(usage('{"error":"Invalid column \\"Synchro_Ids\\""}')), 'Synchro_Ids');
  assert.equal(refusedColumn(usage('{"error":"Blocked by table update access rules"}')), '');
  assert.equal(refusedColumn(null), '');
  assert.equal(refusedColumn({}), '');
});

test('d\'où vient la colonne refusée : en trop dans Synchro, déjà retirée, ou colonne du widget', () => {
  const invalid = name => ({ lastErrorMessage: `{"error":"Invalid column \\"${name}\\""}` });
  const inSync = [...widget().map(c => c.colId), 'A', 'B', 'C'];
  assert.equal(columnFault(invalid('A'), inSync), 'stray', 'A est dans Synchro et n\'est pas au widget : à retirer');
  assert.equal(columnFault(invalid('A'), widget().map(c => c.colId)), 'gone', 'A est retirée : la file garde d\'anciens envois');
  assert.equal(columnFault(invalid('Sync_Par'), inSync), '', 'une colonne du widget manque au journal : il se remet à jour côté CIBLE');
  assert.equal(columnFault({ lastErrorMessage: 'timeout' }, inSync), '');
});

test('nom libre pour la table d\'une autre personne, et noms que Grist accepte', () => {
  assert.equal(freeTableName(['Contacts', 'Synchro']), 'Table_Synchro');
  assert.equal(freeTableName(['Table_Synchro', 'Table_synchro2']), 'Table_Synchro3', 'Grist ne distingue pas les majuscules');
  assert.equal(tableNameProblem('', []), 'empty');
  assert.equal(tableNameProblem('Ma table', []), 'invalid');
  assert.equal(tableNameProblem('1table', []), 'invalid');
  assert.equal(tableNameProblem('Été', []), 'invalid');
  assert.equal(tableNameProblem('table_synchro', ['Table_Synchro']), 'taken');
  assert.equal(tableNameProblem(' Table_Synchro ', ['Contacts']), '', 'les espaces autour sont ignorés');
  assert.equal(tableNameProblem('Table_Synchro', ['Contacts']), '');
});

// Webhooks tels que listWebhooks les rend, et leurs conditions (webhookConditions).
const hook = (id, tableId) => ({ id, fields: { tableId } });
const conditions = ids => new Map(ids.map(([id, exportId]) => [id, exportCondition(exportId)]));

test('Synchro perdue : effacée, renommée ou illisible, reconnue aux webhooks du widget qui restent', () => {
  const exportId = '0123456789abcdef';
  const mine = conditions([['w1', exportId], ['w2', exportId]]);
  const noTable = schemaOf({ Contacts: grist() });
  // Effacée : Grist garde les webhooks, sans table.
  assert.deepEqual(lostSync(noTable, [hook('w1', null), hook('w2', null)], mine), { kind: 'deleted', name: '', hooks: ['w1', 'w2'] });
  // Renommée : les webhooks suivent la table.
  assert.deepEqual(lostSync(noTable, [hook('w1', 'Ma_table'), hook('w2', 'Ma_table')], mine), { kind: 'renamed', name: 'Ma_table', hooks: ['w1', 'w2'] });
  // Au nom de Synchro, mais sans sa colonne Synchro_Export pour le widget : effacée ou cachée par une règle d'accès.
  const hidden = schemaOf({ Synchro: [col('manualSort')] });
  assert.equal(lostSync(hidden, [hook('w1', 'Synchro')], mine).kind, 'hidden');
  assert.equal(lostSync(noTable, [hook('w1', 'Synchro')], mine).kind, 'hidden', 'table cachée à tous : elle n\'est même plus dans le schéma');
});

test('Synchro perdue : rien à dire quand la table est celle du widget, ou qu\'aucun de ses webhooks ne reste', () => {
  const exportId = '0123456789abcdef';
  const mine = conditions([['w1', exportId]]);
  const own = schemaOf({ Synchro: widget() });
  assert.equal(lostSync(own, [hook('w1', 'Synchro')], mine), null, 'table en place');
  const noTable = schemaOf({ Contacts: grist() });
  assert.equal(lostSync(noTable, [], new Map()), null, 'jamais servi : rien n\'est perdu');
  // Un webhook qui n'est pas celui d'un export (autre usage de Grist, condition d'un autre genre) ne prouve rien.
  assert.equal(lostSync(noTable, [hook('w9', null)], new Map([['w9', 'rec.Montant > 3']])), null);
  assert.equal(lostSync(noTable, [hook('w9', null)], new Map()), null);
});
