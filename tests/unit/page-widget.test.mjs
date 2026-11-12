// Logique pure du widget posé sur la page d'une table reçue : comparaison d'adresses, lecture d'une section « Personnalisée »,
// où est le widget pour une table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { customOptions, customUrl, sectionUrl, widgetAddress, widgetSpot } from '../../js/engine/logic/page-widget.js';

test('widgetAddress : un même widget sous plusieurs écritures', () => {
  const same = ['https://x.github.io/repo', 'https://x.github.io/repo/', 'https://x.github.io/repo/index.html', 'https://x.github.io/repo/?access=full&a=1#haut', 'https://x.github.io/repo/index.html?readonly=1'];
  assert.deepEqual([...new Set(same.map(widgetAddress))], ['https://x.github.io/repo']);
  assert.equal(widgetAddress('http://localhost:8585/'), 'http://localhost:8585');
  assert.notEqual(widgetAddress('https://x.github.io/repo'), widgetAddress('https://x.github.io/autre'));
  assert.notEqual(widgetAddress('https://x.github.io/repo'), widgetAddress('https://y.github.io/repo'));
});

test('widgetAddress : rien qui ne soit un lien http(s)', () => {
  for (const bad of ['', null, undefined, 'javascript:alert(1)', 'data:text/html,<p>', 'ftp://x/y', 'pas un lien', 42, {}]) assert.equal(widgetAddress(bad), '', String(bad));
});

const custom = (url, extra = {}) => ({ id: 1, parentId: 5, parentKey: 'custom', options: JSON.stringify({ customView: JSON.stringify({ mode: 'url', url, access: 'full', ...extra }) }) });

test('customUrl : l\'adresse d\'une section Personnalisée, jamais celle d\'une autre', () => {
  assert.equal(customUrl(custom('https://x.github.io/repo/')), 'https://x.github.io/repo/');
  assert.equal(customUrl({ parentKey: 'record', options: custom('https://x/').options }), '', 'une grille n\'est pas un widget');
  for (const options of ['', 'pas du JSON', '{}', '{"customView": "pas du JSON"}', '{"customView": 5}', '{"customView": "{\\"url\\": 3}"}', 'null']) {
    assert.equal(customUrl({ parentKey: 'custom', options }), '', options);
  }
  // La valeur de customView est un texte JSON dans Grist ; un objet est lu aussi.
  assert.equal(customUrl({ parentKey: 'custom', options: JSON.stringify({ customView: { url: 'https://x/y/' } }) }), 'https://x/y/');
});

const tables = [{ id: 2, tableId: 'Dossiers', primaryViewId: 0 }, { id: 3, tableId: 'Autre', primaryViewId: 0 }];
const pages = [{ id: 1, viewRef: 5, indentation: 0, pagePos: 1 }, { id: 2, viewRef: 6, indentation: 0, pagePos: 2 }];
const grid = { id: 10, parentId: 5, parentKey: 'record', tableRef: 2 };

test('widgetSpot : la page de la table, et le widget qui y est déjà ou non', () => {
  const url = 'https://x.github.io/repo/';
  assert.deepEqual(widgetSpot('Dossiers', url, tables, [grid], pages), { view: 5, there: false });
  assert.deepEqual(widgetSpot('Dossiers', url, tables, [grid, { ...custom('https://x.github.io/repo/index.html?access=full'), id: 11 }], pages), { view: 5, there: true });
  // Le widget est sur une autre page : la page de la table ne l'a pas.
  assert.deepEqual(widgetSpot('Dossiers', url, tables, [grid, { ...custom(url), id: 11, parentId: 6 }], pages), { view: 5, there: false });
  // Un autre widget sur la même page n'est pas celui-ci.
  assert.deepEqual(widgetSpot('Dossiers', url, tables, [grid, { ...custom('https://autre.github.io/outil/'), id: 11 }], pages), { view: 5, there: false });
});

test('widgetSpot : une table sans page, ou inconnue, n\'a pas de lieu', () => {
  assert.deepEqual(widgetSpot('Autre', 'https://x/', tables, [grid], pages), { view: null, there: false });
  assert.deepEqual(widgetSpot('Absente', 'https://x/', tables, [grid], pages), { view: null, there: false });
  assert.deepEqual(widgetSpot('Dossiers', 'pas un lien', tables, [grid, custom('pas un lien')], pages), { view: 5, there: false }, 'une adresse illisible ne compte jamais comme "déjà là"');
});

test('sectionUrl : l\'adresse écrite par la personne est gardée, sinon celle du widget', () => {
  assert.equal(sectionUrl('https://x.github.io/repo/', [custom('https://x.github.io/repo')]), 'https://x.github.io/repo');
  assert.equal(sectionUrl('https://x.github.io/repo/', [custom('https://autre/outil/')]), 'https://x.github.io/repo/');
  assert.equal(sectionUrl('https://x.github.io/repo/', []), 'https://x.github.io/repo/');
  assert.equal(sectionUrl('javascript:alert(1)', [custom('javascript:alert(1)')]), '', 'jamais autre chose qu\'un lien http(s)');
  assert.equal(sectionUrl('', []), '');
});

test('customOptions : sans accès accordé, au format que Grist range', () => {
  const options = JSON.parse(customOptions('https://x.github.io/repo/'));
  assert.equal(typeof options.customView, 'string');
  assert.deepEqual(JSON.parse(options.customView), { mode: 'url', url: 'https://x.github.io/repo/', access: 'none', renderAfterReady: false });
});
