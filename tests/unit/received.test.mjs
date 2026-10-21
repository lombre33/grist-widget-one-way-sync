// CIBLE : exports reçus lus dans le schéma (journaux, destinations, clés de signature).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDestColumnsActions, journalNote, journalNoteAction, keySlot, missingColumns, optionActions, optionsNote, receivedDests, receivedJournals, receivedKey, storeKeyActions,
} from '../../js/logic/received.js';

const K1 = '1'.repeat(32);
const K2 = '2'.repeat(32);
// Schéma lu (voir readSchema) : colonnes par table, avec leur numéro et leur description.
const schemaOf = (tables) => {
  let n = 0;
  const cols = Object.fromEntries(Object.entries(tables).map(([t, cs]) => [t, cs.map(([colId, note]) => ({ id: ++n, colId, description: note ? JSON.stringify(note) : '' }))]));
  return { tableIds: Object.keys(cols), has: t => t in cols, columns: t => cols[t] };
};

test('journaux reçus : ceux dont la note dit l\'export et les tables, complétée ; destinations et document d\'origine', () => {
  const schema = schemaOf({
    Journal_a: [['Synchro_Ids', { export: 'e1', tables: [{ table: 'Contacts', dest: 'Annuaire' }], from: { docId: 'docA' } }]],
    Journal_b: [['Synchro_Ids', { export: 'e2' }]],
    Journal_c: [['Synchro_Ids', null]],
    Contacts: [['Nom', { export: 'e3', tables: [] }]],
  });
  assert.deepEqual(receivedJournals(schema), [{ journal: 'Journal_a', note: { refused: [], missing: {}, export: 'e1', tables: [{ table: 'Contacts', dest: 'Annuaire' }], from: { docId: 'docA' } } }]);
  assert.deepEqual(receivedDests(schema), [{ dest: 'Annuaire', table: 'Contacts', fromDocId: 'docA' }]);
  assert.equal(journalNote(schema, 'Journal_b').export, 'e2');
  assert.equal(journalNote(schema, 'Absente'), null);
  assert.deepEqual(journalNoteAction(schema, 'Journal_b', { export: 'e2', tables: [] }), ['UpdateRecord', '_grist_Tables_column', 2, { description: '{"export":"e2","tables":[]}' }]);
});

test('destination : colonnes manquantes ajoutées sous leur nom choisi, visibles, la clé cachée', () => {
  const schema = schemaOf({ Annuaire: [['Nom']] });
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom' }, { id: 'Ville', type: 'Text', label: 'Ville' }, { id: 'MajLe', type: 'DateTime:UTC' }, { id: 'Supprime', type: 'Bool' }];
  assert.deepEqual(addDestColumnsActions(schema, 'Annuaire', columns, { Ville: 'Commune' }), [
    ['AddVisibleColumn', 'Annuaire', 'Commune', { type: 'Text', label: 'Commune', isFormula: false }],
    ['AddColumn', 'Annuaire', 'id_sync', { type: 'Text', label: 'id_sync', isFormula: false }],
  ]);
  assert.equal(addDestColumnsActions(schemaOf({}), 'Neuve', columns).length, 3);
});

test('clé de signature : à la place de l\'export, ou du journal pour un retour d\'Échange ; notée sans écraser les autres', () => {
  const schema = schemaOf({
    Annuaire: [['id_sync', { signature: { e1: K1, Journal_r: 'pas une clé' } }]],
    Villes: [['id_sync', { signature: { e1: K1 } }]],
    Pays: [['Nom']],
  });
  const note = { export: 'e1', tables: [{ dest: 'Pays' }, { dest: 'Annuaire' }] };
  assert.equal(keySlot('Journal_a', note), 'e1');
  assert.equal(keySlot('Journal_r', { ...note, retour: true }), 'Journal_r');
  assert.equal(receivedKey(schema, 'Journal_a', note), K1);
  assert.equal(receivedKey(schema, 'Journal_r', { ...note, retour: true }), '', 'valeur illisible ignorée');
  assert.deepEqual(storeKeyActions(schema, ['Annuaire', 'Villes', 'Pays', 'Absente'], 'e1', K2), [
    ['UpdateRecord', '_grist_Tables_column', 1, { description: JSON.stringify({ signature: { e1: K2, Journal_r: 'pas une clé' } }) }],
    ['UpdateRecord', '_grist_Tables_column', 2, { description: JSON.stringify({ signature: { e1: K2 } }) }],
  ]);
  assert.deepEqual(storeKeyActions(schema, ['Villes'], 'e1', K1), [], 'déjà notée');
  assert.deepEqual(storeKeyActions(schema, ['Villes'], 'e1', 'xyz'), [], 'clé invalide');
});

test('choix et formats : colonnes créées avec ceux de la SOURCE, colonnes d\'ici complétées seulement si elles sont à la CIBLE', () => {
  const opts = { choices: ['A', 'B'], alignment: 'center' };
  const columns = [{ id: 'Etat', type: 'Choice', label: 'État', opts }, { id: 'Nom', type: 'Text', label: 'Nom' }];
  const created = addDestColumnsActions(schemaOf({}), 'Neuve', columns);
  assert.deepEqual(created[0], ['AddVisibleColumn', 'Neuve', 'Etat', { type: 'Choice', label: 'État', isFormula: false, widgetOptions: '{"alignment":"center","choices":["A","B"]}' }]);
  assert.equal(created[1][3].widgetOptions, undefined);
  assert.deepEqual(missingColumns(schemaOf({ Annuaire: [['Nom']] }), 'Annuaire', [...columns, { id: 'MajLe', type: 'DateTime:UTC' }], { Etat: 'Statut' }), ['Etat']);
  // Destination : Statut créée ici (own), Choix choisie par la CIBLE.
  const dest = schemaOf({ Annuaire: [['Statut'], ['Choix']] });
  dest.columns('Annuaire').forEach((c) => { c.type = 'Choice'; c.widgetOptions = '{"choices":["A"]}'; });
  const sent = [{ id: 'Etat', type: 'Choice', opts }, { id: 'Choix', type: 'Choice', opts }];
  const entry = { dest: 'Annuaire', map: { Etat: 'Statut' }, own: ['Etat'] };
  assert.deepEqual(optionActions(dest, entry, sent), [['UpdateRecord', '_grist_Tables_column', 1, { widgetOptions: '{"choices":["A","B"],"alignment":"center"}' }]]);
  assert.deepEqual(optionActions(dest, { ...entry, own: undefined }, sent), [], 'réception d\'avant la 0.12 : colonnes qui ont déjà des choix laissées');
  assert.deepEqual(optionActions(schemaOf({}), entry, sent), [], 'destination absente');
});

test('options d\'une réception : seules les options cochées sont notées', () => {
  assert.deepEqual(optionsNote({}), {});
  assert.deepEqual(optionsNote({ archive: false, verrou: false }), {});
  assert.deepEqual(optionsNote({ archive: true }), { archive: true });
  assert.deepEqual(optionsNote({ archive: true, verrou: true }), { archive: true, verrou: true });
});
