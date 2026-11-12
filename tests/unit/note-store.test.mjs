// Où le widget garde ses notes : dans les options des colonnes, et non dans leur description (que Grist
// laisse lire aux lecteurs d'un document, lien public compris). Déplacement des notes d'avant la 3.0.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyNoteActions } from '../../js/engine/logic/note-store.js';
import { columnNote } from '../../js/engine/logic/common.js';
import { receivedJournals, receivedKey, signedTables } from '../../js/engine/logic/received.js';
import { schemaFrom } from '../../js/engine/logic/schema.js';

const K1 = 'a'.repeat(32);
const SOURCE_NOTE = { exports: [{ id: '0123456789abcdef', name: 'Contacts' }], invitations: [{ id: 'x', hash: 'h', prive: 'secret' }], pauses: [] };
const JOURNAL_NOTE = { export: 'e1', secret: 's', tables: [{ table: 'Contacts', dest: 'Annuaire' }], from: { email: 'a@b.fr' } };

// Document lu comme le fait readSchema : tables et colonnes de Grist, chacune avec description et options.
function documentOf(tables) {
  const tableRows = [];
  const columnRows = [];
  let ref = 0;
  for (const [tableId, columns] of Object.entries(tables)) {
    const parent = ++ref;
    tableRows.push({ id: parent, tableId });
    columns.forEach(([colId, extra = {}], pos) => columnRows.push({ id: ++ref, parentId: parent, parentPos: pos, colId, type: 'Text', description: '', widgetOptions: '', ...extra }));
  }
  return schemaFrom(tableRows, columnRows);
}
const legacy = note => ({ description: JSON.stringify(note) });
const inOptions = note => ({ widgetOptions: JSON.stringify({ syncNote: note }) });
const column = (schema, table, colId) => schema.columns(table).find(c => c.colId === colId);

test('notes d\'avant : SOURCE, journal et clé de signature passent de la description aux options', () => {
  const schema = documentOf({
    Synchro: [['Synchro_Export', legacy(SOURCE_NOTE)]],
    Journal_a: [['Synchro_Ids', legacy(JOURNAL_NOTE)]],
    Annuaire: [['Nom'], ['id_sync', legacy({ signature: { e1: K1 } })]],
  });
  const actions = legacyNoteActions(schema).sort((a, b) => a[2] - b[2]);
  assert.equal(actions.length, 3);
  const expected = [
    [column(schema, 'Synchro', 'Synchro_Export').id, SOURCE_NOTE],
    [column(schema, 'Journal_a', 'Synchro_Ids').id, JOURNAL_NOTE],
    [column(schema, 'Annuaire', 'id_sync').id, { signature: { e1: K1 } }],
  ].sort((a, b) => a[0] - b[0]);
  expected.forEach(([id, note], i) => {
    assert.deepEqual(actions[i], ['UpdateRecord', '_grist_Tables_column', id, { widgetOptions: JSON.stringify({ syncNote: note }), description: '' }]);
  });
});

test('notes d\'avant : rien à faire si tout est déjà dans les options, ou si la colonne n\'a pas de note', () => {
  const schema = documentOf({
    Synchro: [['Synchro_Export', inOptions(SOURCE_NOTE)]],
    Journal_a: [['Synchro_Ids', inOptions(JOURNAL_NOTE)]],
    Annuaire: [['id_sync', inOptions({ signature: { e1: K1 } })]],
    Villes: [['id_sync']],
  });
  assert.deepEqual(legacyNoteActions(schema), []);
});

test('notes d\'avant : une note déjà dans les options fait foi, la description d\'avant est seulement vidée', () => {
  const schema = documentOf({ Journal_a: [['Synchro_Ids', { ...inOptions({ ...JOURNAL_NOTE, secret: 'récent' }), ...legacy({ ...JOURNAL_NOTE, secret: 'ancien' }) }]] });
  assert.deepEqual(legacyNoteActions(schema), [['UpdateRecord', '_grist_Tables_column', column(schema, 'Journal_a', 'Synchro_Ids').id, { description: '' }]]);
  assert.equal(columnNote(column(schema, 'Journal_a', 'Synchro_Ids')).secret, 'récent');
});

test('notes d\'avant : les autres options de la colonne sont gardées', () => {
  const schema = documentOf({ Annuaire: [['id_sync', { ...legacy({ signature: { e1: K1 } }), widgetOptions: '{"alignment":"left"}' }]] });
  assert.deepEqual(legacyNoteActions(schema)[0][3], { widgetOptions: '{"alignment":"left","syncNote":{"signature":{"e1":"' + K1 + '"}}}', description: '' });
});

test('notes d\'avant : une description écrite à la main n\'est jamais touchée', () => {
  const schema = documentOf({
    Annuaire: [['id_sync', { description: 'Clé de la ligne, ne pas toucher' }]],
    Villes: [['id_sync', legacy({ autre: 'chose' })]], // un objet JSON, mais pas une clé de signature
    Pays: [['Nom', legacy({ signature: { e1: K1 } })]], // pas la colonne id_sync
    Synchro: [['A', legacy({ exports: [] })]], // table Synchro d'une autre personne : pas de Synchro_Export
  });
  assert.deepEqual(legacyNoteActions(schema), []);
});

test('notes d\'avant : lues en attendant le déplacement, et même résultat après', () => {
  const before = documentOf({
    Journal_a: [['Synchro_Ids', legacy(JOURNAL_NOTE)]],
    Annuaire: [['id_sync', legacy({ signature: { e1: K1 } })]],
  });
  const after = documentOf({
    Journal_a: [['Synchro_Ids', inOptions(JOURNAL_NOTE)]],
    Annuaire: [['id_sync', inOptions({ signature: { e1: K1 } })]],
  });
  for (const schema of [before, after]) {
    assert.equal(receivedJournals(schema)[0].note.export, 'e1');
    assert.equal(receivedKey(schema, 'Journal_a', { export: 'e1', tables: [{ dest: 'Annuaire' }] }), K1);
    assert.deepEqual(signedTables(schema), ['Annuaire']);
  }
});

test('tables avec clé de signature : celles dont id_sync porte au moins une clé, jamais la table Synchro ni un journal', () => {
  const schema = documentOf({
    Annuaire: [['id_sync', inOptions({ signature: { e1: K1 } })]],
    Villes: [['id_sync', inOptions({ signature: {} })]],
    Pays: [['id_sync']],
    Contacts: [['Nom']],
    Journal_a: [['id_sync', inOptions({ signature: { e1: K1 } })]],
  });
  assert.deepEqual(signedTables(schema), ['Annuaire']);
});
