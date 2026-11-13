// Table ajoutée pour un lien : la colonne affichée seule, toute la table, ou des colonnes au choix (js/source/pull.js), avec ce
// que linkOffers en fait (les Références de la table prise en entier s'ajoutent aux choix).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PULL_MODES, extrasFor, pullColumns, pullLeftOut } from '../../js/source/pull.js';
import { linkOffers } from '../../js/engine/logic/links.js';

const col = (id, extra = {}) => ({ id, type: 'Text', label: id, source: 'Text', visible: '', ...extra });
const SERVICES = [col('Libelle'), col('Budget', { type: 'Numeric', source: 'Numeric' }), col('Pieces', { type: 'Attachments', source: 'Attachments' }), col('Direction', { source: 'Ref:Directions', visible: 'Nom' })];
const required = ['Libelle'];

test('trois choix : la colonne affichée seule (d\'emblée), toute la table, les colonnes cochées', () => {
  assert.deepEqual(PULL_MODES, ['shown', 'all', 'pick']);
  assert.deepEqual(pullColumns({ usable: SERVICES, required }), ['Libelle'], 'sans choix : la colonne affichée seule');
  assert.deepEqual(pullColumns({ mode: 'shown', usable: SERVICES, required, extras: ['Budget'] }), ['Libelle'], 'des colonnes cochées avant ne comptent pas hors du choix « cochées »');
  assert.deepEqual(pullColumns({ mode: 'all', usable: SERVICES, required }), ['Libelle', 'Budget', 'Direction'], 'toute la table, sauf les Pièces jointes');
  assert.deepEqual(pullColumns({ mode: 'pick', usable: SERVICES, required, extras: ['Pieces', 'Budget'] }), ['Libelle', 'Pieces', 'Budget'], 'les colonnes cochées, Pièces jointes comprises');
  assert.deepEqual(pullColumns({ mode: 'pick', usable: SERVICES, required }), ['Libelle'], 'rien de plus coché : la colonne affichée reste');
  assert.deepEqual(pullColumns({ mode: 'pick', usable: SERVICES, required: ['Libelle', 'Budget'], extras: ['Budget', 'Libelle'] }), ['Libelle', 'Budget'], 'jamais deux fois la même colonne');
});

test('toute la table dit les Pièces jointes qu\'elle laisse de côté', () => {
  assert.deepEqual(pullLeftOut({ mode: 'all', usable: SERVICES }).map(c => c.id), ['Pieces']);
  assert.deepEqual(pullLeftOut({ mode: 'pick', usable: SERVICES }), []);
  assert.deepEqual(pullLeftOut({ mode: 'shown', usable: SERVICES }), []);
  assert.deepEqual(pullLeftOut({ mode: 'all', usable: SERVICES.slice(0, 2) }), []);
});

test('de « toute la table » à « choisir » : ce qui partait reste coché, sans la colonne exigée ni une colonne qui n\'existe plus', () => {
  const columns = pullColumns({ mode: 'all', usable: SERVICES, required });
  assert.deepEqual(extrasFor({ usable: SERVICES, required, columns }), ['Budget', 'Direction']);
  assert.deepEqual(extrasFor({ usable: SERVICES, required, columns: ['Libelle', 'Disparue', 'Budget'] }), ['Budget']);
  assert.deepEqual(extrasFor({ usable: SERVICES, required }), []);
});

// Une Référence de la table prise en entier (Direction) devient un choix de plus ; sa table visée n'est jamais ajoutée sans ce choix.
const SCHEMAS = {
  Gens: [col('Prenom'), col('Services', { source: 'Ref:Services', visible: 'Libelle' })],
  Services: SERVICES,
  Directions: [col('Nom'), col('Code')],
};
const offers = (mode, choices = new Map(), extras = []) => linkOffers({
  chosen: ['Gens'], columnsOf: table => SCHEMAS[table],
  picked: table => (table === 'Gens' ? ['Prenom', 'Services'] : pullColumns({ mode, usable: SCHEMAS[table], extras })),
  choices: new Map([['Gens.Services', true], ...choices]),
});

test('toute la table : la Référence qu\'elle porte se propose, sans rien ajouter d\'office', () => {
  const one = offers('shown');
  assert.deepEqual([...one.pulled], [['Services', ['Libelle']]]);
  assert.deepEqual(one.rows.map(r => r.key), ['Gens.Services'], 'la colonne Direction ne part pas : pas de choix à faire');
  const whole = offers('all');
  assert.deepEqual([...whole.pulled], [['Services', ['Libelle']]], 'Directions n\'est pas ajoutée sans le choix de la personne');
  const direction = whole.rows.find(r => r.key === 'Services.Direction');
  assert.ok(direction && direction.ok && !direction.link && !direction.inside, 'choix proposé, valeurs seules d\'emblée');
});

test('toute la table : garder le lien de la Référence qu\'elle porte ajoute la table visée, en cascade', () => {
  const whole = offers('all', new Map([['Services.Direction', true]]));
  assert.deepEqual([...whole.pulled], [['Services', ['Libelle']], ['Directions', ['Nom']]]);
  const none = offers('shown', new Map([['Services.Direction', true]]));
  assert.deepEqual([...none.pulled], [['Services', ['Libelle']]], 'la colonne n\'est pas prise : le choix est sans objet');
});
