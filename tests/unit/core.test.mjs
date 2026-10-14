// Tests unitaires de la logique pure : `node --test tests/unit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvitation, buildReply, buildWebhookUrl, checkSourceColumns, chunk, compareVersion, copyColumns,
  decodeCode, fillKeyActions, latestByKey, maskKey, parseDocBaseUrl, parseFormLink, parseInvitation,
  parseReply, parseWebhookUrl, planConsolidation, planPurge, recentChanges, prepareSourceActions, toRows, toTableId,
} from '../../js/core.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const j = (id, key, majle, extra = {}) => ({ id, id_sync: key, MajLe: majle, Supprime: false, Nom: `n${id}`, ...extra });

test('toRows et chunk', () => {
  assert.deepEqual(toRows({ id: [1, 2], A: ['x', 'y'] }), [{ id: 1, A: 'x' }, { id: 2, A: 'y' }]);
  assert.deepEqual(toRows(null), []);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test('toTableId', () => {
  assert.equal(toTableId('journal des élèves'), 'Journal_des_eleves');
  assert.equal(toTableId('2024'), 'T_2024');
  assert.equal(toTableId('  '), 'Table');
});

test('la version la plus récente gagne, MajLe puis numéro de ligne', () => {
  assert.ok(compareVersion({ order: 2, id: 1 }, { order: 1, id: 9 }) > 0);
  assert.ok(compareVersion({ order: 1, id: 2 }, { order: 1, id: 1 }) > 0);
  assert.ok(compareVersion({ order: null, id: 9 }, { order: 1, id: 1 }) < 0);
  const latest = latestByKey([j(1, 'a', 10), j(2, 'a', 30), j(3, 'a', 20), j(4, '', 99)]);
  assert.equal(latest.size, 1);
  assert.equal(latest.get('a').id, 2); // la version de 20 arrivée en retard est ignorée
});

test('copyColumns ignore les colonnes techniques et les formules de la destination', () => {
  const journal = ['id_sync', 'MajLe', 'Supprime', 'Nom', 'Ville', 'Age', 'manualSort', 'gristHelper_X'].map(colId => ({ colId }));
  const dest = [{ colId: 'id_sync' }, { colId: 'Nom' }, { colId: 'Ville', isFormula: true }, { colId: 'Age' }];
  assert.deepEqual(copyColumns(journal, dest), [['Nom', 'Nom'], ['Age', 'Age']]);
  assert.deepEqual(copyColumns(journal, [...dest, { colId: 'Commune' }], { Ville: 'Commune' }), [['Nom', 'Nom'], ['Ville', 'Commune'], ['Age', 'Age']]);
});

const plan = (journalRows, destRows, matchCol) => planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', matchCol });
const marked = (ids, states) => ['BulkUpdateRecord', 'J', ids, { Sync_Applique: ids.map(() => true), Sync_Etat: states }];
const list = (id, keys, extra = {}) => ({ id, id_sync: '', Synchro_Ids: `ids:${keys.join(' ')}`, ...extra });
const done = { Sync_Applique: true };

test('consolidation : ajout, mise à jour, suppression, versions déjà appliquées ignorées', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 10, done), j(3, 'c', 10, done), j(4, 'd', 10, done),
    j(5, 'b', 20, { Nom: 'b2' }), j(6, 'd', 20, { Supprime: true }), j(7, 'e', 10)];
  const destRows = [{ id: 11, id_sync: 'b' }, { id: 12, id_sync: 'c', Nom: 'retouche manuelle' }, { id: 13, id_sync: 'd' }];
  const { actions, stats } = plan(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 1, removed: 1 });
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b', 'e'] }, { Nom: ['b2', 'n7'] }, { on_many: 'all' }],
    ['BulkRemoveRecord', 'Dest', [13]],
    marked([5, 6, 7], ['modif', 'suppression', 'ajout']),
  ]);
});

test('consolidation : une version arrivée en retard ne remplace pas une plus récente', () => {
  const { actions } = plan([j(1, 'a', 20, done), j(2, 'a', 10, { Nom: 'ancienne' })], [{ id: 1, id_sync: 'a' }]);
  assert.deepEqual(actions, []);
});

test('consolidation : une clé absente de la liste est effacée, sauf version plus récente', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 10, done), list(3, ['a'], { Sync_Recu: 50 }), j(4, 'c', 10)];
  const destRows = [{ id: 1, id_sync: 'a' }, { id: 2, id_sync: 'b' }, { id: 3, id_sync: '' }];
  const { actions, stats } = plan(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 0, removed: 1 });
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['c'] }, { Nom: ['n4'] }, { on_many: 'all' }],
    ['BulkRemoveRecord', 'Dest', [2]],
    marked([3, 4], ['', 'ajout']),
    ['BulkUpdateRecord', 'J', [2], { Sync_Etat: ['suppression'], Sync_Recu: [50] }],
  ]);
});

test('consolidation : une ligne déjà là est rattachée par la colonne commune au lieu d\'être doublée', () => {
  const journalRows = [j(1, 'a', 10, { Nom: 'Lyon' }), j(2, 'b', 10, { Nom: 'Paris' })];
  const destRows = [{ id: 7, id_sync: '', Nom: 'Lyon' }, { id: 8, id_sync: '', Nom: 'Nice' }];
  const { actions, stats } = plan(journalRows, destRows, 'Nom');
  assert.deepEqual(stats, { added: 1, updated: 1, removed: 0 });
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b'] }, { Nom: ['Paris'] }, { on_many: 'all' }],
    ['BulkUpdateRecord', 'Dest', [7], { id_sync: ['a'], Nom: ['Lyon'] }],
    marked([1, 2], ['modif', 'ajout']),
  ]);
});

test('consolidation idempotente : rejouer après application ne fait rien', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 20, { Supprime: true, ...done }), list(3, ['a'], done)];
  assert.deepEqual(plan(journalRows, [{ id: 1, id_sync: 'a', Nom: 'n1' }]).actions, []);
});

test('purge : garde la dernière version de chaque clé, la dernière liste et la ligne la plus récente', () => {
  const rows = [j(1, 'a', 10), j(2, 'a', 20), list(3, ['a']), j(4, '', 5), list(5, ['a', 'b']), j(6, 'a', 15), j(7, '', 0)];
  assert.deepEqual(planPurge(rows, 'Journal'), [['BulkRemoveRecord', 'Journal', [1, 3, 4, 6]]]);
  assert.deepEqual(planPurge([j(1, 'a', 1)], 'Journal'), []);
});

test('historique : versions recopiées arrivées après la visite, plus récentes d\'abord, plafonnées', () => {
  const rows = [j(1, 'a', 10, { Sync_Etat: 'ajout' }), j(2, 'a', 30, { Sync_Etat: 'modif', Sync_Recu: 31 }),
    j(3, 'b', 20, { Sync_Etat: 'suppression', Sync_Recu: 40 }), j(4, 'c', 15, { Sync_Etat: 'ajout' }), j(5, 'd', 50), list(6, ['a'])];
  assert.deepEqual(recentChanges(rows, 'Nom', 12, 20), [
    { at: 40, label: 'n3', state: 'suppression' }, { at: 31, label: 'n2', state: 'modif' }, { at: 15, label: 'n4', state: 'ajout' }]);
  assert.equal(recentChanges(rows, 'Nom', 0, 1).length, 1);
});

test('contrôle de la table SOURCE', () => {
  const cols = [
    { id: 1, colId: 'Nom', type: 'Text' },
    { id: 2, colId: 'Ville', type: 'Ref:Villes', displayCol: 5 },
    { id: 3, colId: 'Statut', type: 'Choice', rules: [6] },
    { id: 4, colId: 'Photo', type: 'Attachments' },
    { id: 5, colId: 'gristHelper_Display', type: 'Any' },
    { id: 6, colId: 'gristHelper_ConditionalRule', type: 'Any' },
    { id: 7, colId: 'manualSort', type: 'ManualSortPos' },
    { id: 8, colId: 'id_sync', type: 'Text' },
  ];
  const { sent, problems, missing } = checkSourceColumns(cols);
  assert.deepEqual(sent.map(c => c.colId), ['Nom', 'Ville', 'Statut', 'id_sync']);
  assert.deepEqual(problems, [
    { code: 'reference', blocking: false, colId: 'Ville' },
    { code: 'attachments', blocking: true, colId: 'Photo' },
    { code: 'helperDisplay', blocking: true, colId: 'Ville' },
    { code: 'helperRule', blocking: true, colId: 'Statut' },
  ]);
  assert.deepEqual(missing, ['MajLe', 'Supprime']);
});

test('préparation de la SOURCE : colonnes manquantes et clés des lignes existantes', () => {
  assert.deepEqual(prepareSourceActions('T', ['MajLe']), [
    ['AddColumn', 'T', 'MajLe', { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 2 }],
  ]);
  let n = 0;
  const actions = fillKeyActions('T', [{ id: 1, id_sync: '' }, { id: 2, id_sync: 'x' }, { id: 3 }], () => `u${++n}`);
  assert.deepEqual(actions, [['BulkUpdateRecord', 'T', [1, 3], { id_sync: ['u1', 'u2'] }]]);
});

test('invitation : aller-retour, plusieurs tables, refus des codes invalides', () => {
  const columns = [{ colId: 'id_sync', type: 'Text' }, { colId: 'MajLe', type: 'DateTime:UTC' },
    { colId: 'Supprime', type: 'Bool' }, { colId: 'Ville', type: 'Ref:Villes', label: 'Ville é' }];
  const id = '0123456789abcdef';
  const code = buildInvitation({ id, name: 'Annuaire', secret: SECRET, origin: 'https://g.fr', tables: [{ table: 'Contacts', columns }, { table: 'Villes', columns }] });
  assert.ok(code.startsWith('GRISTSYNC1.'));
  const inv = parseInvitation(code);
  assert.deepEqual(inv.tables.map(tb => tb.table), ['Contacts', 'Villes']);
  assert.equal(inv.tables[0].columns[3].type, 'Int');
  assert.equal(inv.tables[0].columns[3].label, 'Ville é');
  assert.equal(parseInvitation(buildInvitation({ id, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })).secret, '');
  assert.throws(() => parseInvitation('bonjour'), /codeFormat/);
  assert.throws(() => decodeCode(code, 'reponse'), /notReply/);
  const bad = buildInvitation({ id, name: 'x', origin: '', tables: [{ table: 'Contacts', columns: [{ colId: 'a;b', type: 'Text' }] }] });
  assert.throws(() => parseInvitation(bad), /codeInvalid/);
  const twice = buildInvitation({ id, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }, { table: 'Contacts', columns }] });
  assert.throws(() => parseInvitation(twice), /codeInvalid/);
});

test('réponse : même instance, adresses par clé de formulaire seulement', () => {
  const url = 'https://g.fr/o/eq/api/s/Abc123/tables/Journal_Contacts/records?flat=1';
  const id = '0123456789abcdef';
  const recipient = { email: 'a@b.fr', docId: 'doc1', team: 'eq', at: '2026-10-14', extra: 'x' };
  const links = [{ table: 'Contacts', url }];
  const reply = parseReply(buildReply({ id, secret: SECRET, recipient, links }), 'https://g.fr');
  assert.deepEqual(reply.links, links);
  assert.equal(reply.secret, SECRET);
  assert.equal(reply.recipient.extra, undefined);
  assert.equal(parseReply(buildReply({ id, recipient, links }), 'https://g.fr').secret, '');
  assert.throws(() => parseReply(buildReply({ id, secret: 'court', recipient, links }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(buildReply({ id, recipient, links }), 'https://autre.fr'), /otherInstance/);
  const noFlat = [{ table: 'Contacts', url: url.replace('?flat=1', '') }];
  assert.throws(() => parseReply(buildReply({ id, recipient, links: noFlat }), 'https://g.fr'), /codeInvalid/);
  const api = [{ table: 'Contacts', url: 'https://g.fr/api/docs/doc1/tables/T/records?flat=1' }];
  assert.throws(() => parseReply(buildReply({ id, recipient, links: api }), 'https://g.fr'), /codeInvalid/);
});

test('adresses : lien de formulaire, webhook, masque, baseUrl', () => {
  const link = 'https://grist.numerique.gouv.fr/o/mon-equipe/forms/Ab12Cd34Ef56/2';
  assert.deepEqual(parseFormLink(link), { origin: 'https://grist.numerique.gouv.fr', prefix: '/o/mon-equipe', key: 'Ab12Cd34Ef56' });
  assert.equal(buildWebhookUrl(link, 'Journal'), 'https://grist.numerique.gouv.fr/o/mon-equipe/api/s/Ab12Cd34Ef56/tables/Journal/records?flat=1');
  assert.equal(buildWebhookUrl('https://x.fr/forms/K1/3', 'J'), 'https://x.fr/api/s/K1/tables/J/records?flat=1');
  assert.equal(parseFormLink('https://x.fr/doc/abc'), null);
  assert.equal(parseFormLink('javascript:alert(1)//forms/a/1'), null);
  assert.equal(parseWebhookUrl('https://u:p@x.fr/api/s/K/tables/J/records?flat=1'), null);
  assert.equal(maskKey('https://x.fr/api/s/Ab12Cd34Ef56/tables/J/records?flat=1'), 'https://x.fr/api/s/Ab12…/tables/J/records?flat=1');
  assert.deepEqual(parseDocBaseUrl('https://x.fr/o/eq/api/docs/d1'), { origin: 'https://x.fr', team: 'eq', docId: 'd1' });
  assert.deepEqual(parseDocBaseUrl('http://localhost:8484/api/docs/d2'), { origin: 'http://localhost:8484', team: '', docId: 'd2' });
});
