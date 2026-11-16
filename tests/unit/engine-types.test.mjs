// Types de colonnes qu'un export envoie (SOURCE) et que la CIBLE sait recevoir : un Blob ne part pas (Grist n'écrit pas
// d'octets dans une colonne par ses API), un rang et un identifiant de ligne partent en nombre. Avant, une colonne d'un
// type inconnu de la CIBLE, cochée par défaut, rendait l'invitation illisible (codeInvalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportableColumns, exportDrift, sentType, unsentColumns } from '../../js/engine/logic/exports.js';
import { readSchema } from '../../js/engine/port.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { checkDestinations } from '../../js/engine/target/receive.js';
import { fakePair } from './engine-fake.mjs';
import { engineAs, invite } from './engine-wire.mjs';

const COLS = [
  { colId: 'Nom', type: 'Text' }, { colId: 'Photo', type: 'Blob', label: 'Signature binaire' }, { colId: 'Rang', type: 'PositionNumber' },
  { colId: 'Num', type: 'Id' }, { colId: 'Ville', type: 'Ref:Villes' }, { colId: 'Date', type: 'DateTime:Europe/Paris' },
  { colId: 'Futur', type: 'UnTypeDeDemain' }, { colId: 'manualSort', type: 'ManualSortPos' },
];

test('type envoyé : référence en texte, rang en nombre, identifiant en entier, Blob et inconnus jamais', () => {
  assert.equal(sentType('Ref:Villes'), 'Text');
  assert.equal(sentType('RefList:Tags'), 'Text');
  assert.equal(sentType('PositionNumber'), 'Numeric');
  assert.equal(sentType('Id'), 'Int');
  assert.equal(sentType('DateTime:Europe/Paris'), 'DateTime:Europe/Paris');
  for (const type of ['Bool', 'Choice', 'ChoiceList', 'Date', 'Int', 'Numeric', 'Text', 'Any', 'Attachments']) assert.equal(sentType(type), type);
  for (const type of ['Blob', 'ManualSortPos', 'UnTypeDeDemain', '', undefined, null]) assert.equal(sentType(type), null, String(type));
  assert.equal(sentType('Constructor'), null);
  assert.equal(sentType('__proto__'), null);
});

test('colonnes envoyables : un Blob est écarté et dit, la source reste le vrai type', () => {
  const sendable = exportableColumns(COLS);
  assert.deepEqual(sendable.map(c => [c.id, c.type, c.source]), [
    ['Nom', 'Text', 'Text'], ['Rang', 'Numeric', 'PositionNumber'], ['Num', 'Int', 'Id'], ['Ville', 'Text', 'Ref:Villes'],
    ['Date', 'DateTime:Europe/Paris', 'DateTime:Europe/Paris'],
  ]);
  assert.deepEqual(unsentColumns(COLS), [{ id: 'Photo', label: 'Signature binaire', type: 'Blob' }, { id: 'Futur', label: 'Futur', type: 'UnTypeDeDemain' }],
    'ni la clé de tri de Grist ni les colonnes de la synchro ne sont comptées');
});

test('un export d\'avant qui envoyait un Blob : l\'écart le signale, « Modifier » le retire', () => {
  const schema = { has: () => true, columns: () => COLS };
  const old = [{ table: 'Contacts', columns: [{ id: 'Nom', type: 'Text' }, { id: 'Photo', type: 'Blob', source: 'Blob' }] }];
  assert.deepEqual(exportDrift(schema, old), { lost: [], changed: ['Contacts.Photo'] });
});

test('SOURCE puis CIBLE : une colonne Blob cochée ne rend pas l\'invitation illisible', async () => {
  const { world, source, target } = fakePair('ty', { contacts: false });
  const as = engineAs(world);
  source.addTable('Contacts', [{ id: 'Nom', type: 'Text' }, { id: 'Photo', type: 'Blob' }, { id: 'Rang', type: 'PositionNumber' }], [{ Nom: 'Alice', Rang: 1.5 }]);
  as(source);
  const saved = await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom', 'Photo', 'Rang'], filter: null }] });
  assert.deepEqual(saved.tables[0].columns.map(c => [c.id, c.type]), [['Nom', 'Text'], ['Rang', 'Numeric']], 'le Blob coché ne part pas');
  assert.ok((await readSchema()).has('Synchro'));
  const { invitation } = await invite({ world, target, exp: saved.created });
  assert.deepEqual(invitation.tables[0].columns.map(c => [c.id, c.type]), [['Nom', 'Text'], ['Rang', 'Numeric']]);
  const { existing } = await checkDestinations(invitation, invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' })));
  assert.deepEqual(existing, []);
});
