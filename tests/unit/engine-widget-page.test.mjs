// Le widget posé sur la page d'une table reçue (carte d'une réception, « Ajouter le widget à la page de la table reçue ») :
// une section « Personnalisée » sur la page qui montre la table, sans l'accès accordé, une seule fois. Document en mémoire
// (engine-fake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { addWidgetToPage, widgetSpots } from '../../js/engine/pages.js';
import { customUrl } from '../../js/engine/logic/page-widget.js';
import { fakePair } from './engine-fake.mjs';

const URL_WIDGET = 'https://lombre33.github.io/grist-widget-one-way-sync/';

// Une CIBLE avec une table `Dossiers` sur sa page, une table `Sans_page` qui n'en a pas, et la page du widget.
function document() {
  const { world, target } = fakePair('20');
  target.addTable('Dossiers', [{ id: 'Nom', type: 'Text' }]);
  target.addTable('Sans_page', [{ id: 'Nom', type: 'Text' }]);
  const refs = Object.fromEntries(target.fetchRows('_grist_Tables').map(tb => [tb.tableId, tb.id]));
  const page = (name, pos, tableRef, key = 'record') => {
    const view = target.apply([['AddRecord', '_grist_Views', null, { name }]]).retValues[0];
    target.apply([['AddRecord', '_grist_Views_section', null, { parentId: view, parentKey: key, tableRef }],
      ['AddRecord', '_grist_Pages', null, { viewRef: view, shareRef: 0, indentation: 0, pagePos: pos }]]);
    return view;
  };
  const dossiers = page('Dossiers', 1, refs.Dossiers);
  const synchro = page('Synchro', 2, refs.Dossiers, 'custom');
  startEngine({ port: world.port(target), version: '9.9.9' });
  return { target, dossiers, synchro, refs };
}

const customSections = (target, view) => target.fetchRows('_grist_Views_section').filter(s => s.parentId === view && s.parentKey === 'custom');

test('la page de la table n\'a pas le widget : il y est ajouté, sans l\'accès accordé', async () => {
  const { target, dossiers, refs } = document();
  const before = await widgetSpots(['Dossiers', 'Sans_page'], URL_WIDGET);
  assert.deepEqual([...before], [['Dossiers', { view: dossiers, there: false }], ['Sans_page', { view: null, there: false }]]);
  const done = await addWidgetToPage('Dossiers', URL_WIDGET);
  assert.deepEqual(done, { added: true, view: dossiers });
  const [section] = customSections(target, dossiers);
  assert.equal(section.tableRef, refs.Dossiers);
  assert.equal(customUrl(section), URL_WIDGET);
  assert.equal(JSON.parse(JSON.parse(section.options).customView).access, 'none', 'Grist le demande à la personne, le widget ne se le donne pas');
  assert.equal((await widgetSpots(['Dossiers'], URL_WIDGET)).get('Dossiers').there, true);
});

test('un deuxième clic n\'ajoute rien', async () => {
  const { target, dossiers } = document();
  await addWidgetToPage('Dossiers', URL_WIDGET);
  const again = await addWidgetToPage('Dossiers', `${URL_WIDGET}index.html?access=full`);
  assert.deepEqual(again, { added: false, view: dossiers });
  assert.equal(customSections(target, dossiers).length, 1);
});

test('le widget d\'une autre page n\'est pas celui de la page de la table', async () => {
  const { target, dossiers, synchro } = document();
  // La page « Synchro » porte déjà le widget (celui qui tourne), pas la page de la table.
  target.apply([['UpdateRecord', '_grist_Views_section', customSections(target, synchro)[0].id, { options: JSON.stringify({ customView: JSON.stringify({ mode: 'url', url: URL_WIDGET, access: 'full' }) }) }]]);
  const done = await addWidgetToPage('Dossiers', URL_WIDGET);
  assert.equal(done.added, true);
  assert.equal(customSections(target, dossiers).length, 1);
  assert.equal(customSections(target, synchro).length, 1, 'la page du widget n\'est pas touchée');
});

test('l\'adresse écrite par la personne est reprise telle quelle', async () => {
  const { target, dossiers, synchro } = document();
  target.apply([['UpdateRecord', '_grist_Views_section', customSections(target, synchro)[0].id, { options: JSON.stringify({ customView: JSON.stringify({ mode: 'url', url: 'https://lombre33.github.io/grist-widget-one-way-sync/index.html', access: 'full' }) }) }]]);
  await addWidgetToPage('Dossiers', URL_WIDGET);
  assert.equal(customUrl(customSections(target, dossiers)[0]), 'https://lombre33.github.io/grist-widget-one-way-sync/index.html');
});

test('une table sans page, une table inconnue et une adresse qui n\'est pas un lien sont refusées sans rien écrire', async () => {
  const { target } = document();
  const sections = target.fetchRows('_grist_Views_section').length;
  await assert.rejects(() => addWidgetToPage('Sans_page', URL_WIDGET), { message: 'noPageForTable' });
  await assert.rejects(() => addWidgetToPage('Absente', URL_WIDGET), { message: 'noPageForTable' });
  await assert.rejects(() => addWidgetToPage('Dossiers', 'javascript:alert(1)'), { message: 'badWidgetUrl' });
  await assert.rejects(() => addWidgetToPage('Dossiers', ''), { message: 'badWidgetUrl' });
  assert.equal(target.fetchRows('_grist_Views_section').length, sections);
});
