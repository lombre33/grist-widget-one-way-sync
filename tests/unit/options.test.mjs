// Listes de choix et formats : envoyés contrôlés, repris dans les colonnes créées par la CIBLE,
// complétés sans rien écraser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnOptions, fillOptions, ownsColumn } from '../../js/logic/options.js';

const CHOICES = JSON.stringify({
  choices: ['Oui', 'Non', 'Oui', 3, '', 'x'.repeat(201)], choiceOptions: { Oui: { fillColor: '#00FF00', textColor: 'red', fontBold: true }, Peut: { fillColor: '#000000' } },
  alignment: 'center', widget: 'TextBox', formula: 'évil', rulesOptions: [{}],
});

test('options envoyées : clés connues aux valeurs contrôlées, selon le type', () => {
  assert.deepEqual(columnOptions('Choice', CHOICES), { alignment: 'center', choices: ['Oui', 'Non'], choiceOptions: { Oui: { fillColor: '#00FF00', fontBold: true } } });
  assert.deepEqual(columnOptions('Numeric', { numMode: 'currency', currency: 'EUR', decimals: 2, maxDecimals: 99, widget: 'Spinner', dateFormat: 'YYYY' }),
    { numMode: 'currency', currency: 'EUR', decimals: 2, widget: 'Spinner' });
  assert.deepEqual(columnOptions('DateTime:Europe/Paris', '{"dateFormat":"DD/MM/YYYY","timeFormat":"HH:mm","isCustomTimeFormat":true,"choices":["a"]}'),
    { dateFormat: 'DD/MM/YYYY', timeFormat: 'HH:mm', isCustomTimeFormat: true });
  assert.deepEqual(columnOptions('Date', { dateFormat: '<script>' }), null, 'format refusé');
  assert.deepEqual(columnOptions('Text', { widget: 'TextBox', wrap: true }), { widget: 'TextBox', wrap: true });
  assert.deepEqual(columnOptions('Text', { widget: 'HyperLink', wrap: true }), { wrap: true }, 'ni lien cliquable ni Markdown');
  assert.equal(columnOptions('Text', { widget: 'Markdown' }), null);
  assert.equal(columnOptions('Text', { widget: 'Spinner' }), null, 'affichage d\'un autre type');
  assert.equal(columnOptions('Attachments', { height: 36 }), null);
  assert.equal(columnOptions('Bool', 'illisible'), null);
  assert.equal(columnOptions('Bool', '[1]'), null);
  assert.equal(columnOptions('Choice', { choices: 'Oui' }), null);
  const many = { choices: Array.from({ length: 600 }, (_, i) => `choix ${i}`) };
  assert.equal(columnOptions('ChoiceList', many).choices.length, 500);
  const heavy = { choices: Array.from({ length: 200 }, (_, i) => `${'c'.repeat(90)}${i}`), choiceOptions: {} };
  heavy.choices.forEach((c) => { heavy.choiceOptions[c] = { fillColor: '#123456' }; });
  assert.deepEqual(Object.keys(columnOptions('Choice', heavy)), ['choices'], 'trop lourd : sans les couleurs');
  heavy.choices = Array.from({ length: 500 }, (_, i) => `${'c'.repeat(150)}${i}`);
  assert.equal(columnOptions('Choice', heavy), null, 'trop lourd même sans les couleurs');
});

test('colonne d\'ici complétée : clés absentes et choix nouveaux, rien d\'écrasé', () => {
  const sent = { choices: ['Oui', 'Non', 'Peut-être'], choiceOptions: { Oui: { fillColor: '#00FF00' }, 'Peut-être': { fillColor: '#FFFF00' } }, alignment: 'center' };
  assert.equal(fillOptions('Choice', '', sent), JSON.stringify({ alignment: 'center', choices: ['Oui', 'Non', 'Peut-être'], choiceOptions: { Oui: { fillColor: '#00FF00' }, 'Peut-être': { fillColor: '#FFFF00' } } }));
  const here = JSON.stringify({ choices: ['Non', 'Autre'], choiceOptions: { Non: { fillColor: '#FF0000' } }, alignment: 'left' });
  assert.equal(fillOptions('Choice', here, sent), JSON.stringify({ choices: ['Non', 'Autre', 'Oui', 'Peut-être'], choiceOptions: { Non: { fillColor: '#FF0000' }, Oui: { fillColor: '#00FF00' }, 'Peut-être': { fillColor: '#FFFF00' } }, alignment: 'left' }));
  const full = fillOptions('Choice', here, sent);
  assert.equal(fillOptions('Choice', full, sent), null, 'rien ne manque');
  assert.equal(fillOptions('Text', here, sent), null, 'colonne d\'un autre type : rien de propre aux choix, alignement d\'ici gardé');
  assert.equal(fillOptions('Choice', '', null), null);
  assert.equal(fillOptions('Choice', JSON.stringify({ choices: ['Oui'] }), { choices: ['Oui'], choiceOptions: { Oui: { fillColor: '#00FF00' } } }), null, 'couleur d\'un choix déjà là : gardée telle quelle');
});

test('liste de choix d\'ici : bornée, les nouveaux choix s\'arrêtent à la limite', () => {
  const had = JSON.stringify({ choices: Array.from({ length: 499 }, (_, i) => `a${i}`) });
  const sent = { choices: ['nouveau 1', 'nouveau 2', 'nouveau 3'], choiceOptions: { 'nouveau 1': { fillColor: '#123456' }, 'nouveau 3': { fillColor: '#654321' } } };
  const next = JSON.parse(fillOptions('Choice', had, sent));
  assert.equal(next.choices.length, 500);
  assert.equal(next.choices[499], 'nouveau 1');
  assert.deepEqual(Object.keys(next.choiceOptions), ['nouveau 1'], 'les couleurs des choix non ajoutés ne passent pas');
  const full = JSON.stringify({ choices: Array.from({ length: 500 }, (_, i) => `a${i}`) });
  assert.equal(fillOptions('Choice', full, sent), null, 'liste pleine : rien ne s\'ajoute');
});

test('colonnes qu\'on complète : créées ici, ou de choix sans choix pour une réception d\'avant la 0.12', () => {
  assert.equal(ownsColumn(['Etat'], 'Etat', { type: 'Text' }), true);
  assert.equal(ownsColumn([], 'Etat', { type: 'Choice', widgetOptions: '' }), false);
  assert.equal(ownsColumn(undefined, 'Etat', { type: 'Choice', widgetOptions: '' }), true);
  assert.equal(ownsColumn(undefined, 'Etat', { type: 'Choice', widgetOptions: '{"choices":["A"]}' }), false);
  assert.equal(ownsColumn(undefined, 'Etat', { type: 'Text', widgetOptions: '' }), false);
});
