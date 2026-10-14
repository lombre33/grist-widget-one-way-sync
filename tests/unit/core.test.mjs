// Tests unitaires de la logique pure : `node --test tests/unit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvitation, buildReply, buildWebhookUrl, checkSourceColumns, chunk, compareVersion, copyColumns,
  decodeCode, fillKeyActions, latestByKey, maskKey, parseDocBaseUrl, parseFormLink, parseInvitation,
  parseReply, parseWebhookUrl, planConsolidation, planPurge, prepareSourceActions, toRows, toTableId,
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

test('copyColumns ignore clé, colonnes techniques et formules de la destination', () => {
  const journal = ['id_sync', 'MajLe', 'Supprime', 'Nom', 'Ville', 'manualSort', 'gristHelper_X'].map(colId => ({ colId }));
  const dest = [{ colId: 'id_sync' }, { colId: 'MajLe' }, { colId: 'Nom' }, { colId: 'Ville', isFormula: true }, { colId: 'Sync_JournalId' }];
  assert.deepEqual(copyColumns(journal, dest), ['MajLe', 'Nom']);
});

test('consolidation : ajout, mise à jour, rien à faire, suppression', () => {
  const journalRows = [j(1, 'a', 10), j(2, 'b', 10), j(3, 'b', 20, { Nom: 'b2' }), j(4, 'c', 10), j(5, 'd', 10), j(6, 'd', 20, { Supprime: true })];
  const destRows = [
    { id: 11, id_sync: 'b', Nom: 'old', Sync_JournalId: 2, Sync_Ordre: 10 },
    { id: 12, id_sync: 'c', Nom: 'retouche manuelle', Sync_JournalId: 4, Sync_Ordre: 10 },
    { id: 13, id_sync: 'd', Nom: 'n5', Sync_JournalId: 5, Sync_Ordre: 10 },
  ];
  const { actions, stats } = planConsolidation({ journalRows, destRows, copyCols: ['Nom'], destTable: 'Dest' });
  assert.deepEqual(stats, { added: 1, updated: 1, removed: 1 });
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['a', 'b'] },
      { Sync_JournalId: [1, 3], Sync_Ordre: [10, 20], Nom: ['n1', 'b2'] }, { on_many: 'all' }],
    ['BulkRemoveRecord', 'Dest', [13]],
  ]);
});

test('consolidation idempotente : rejouer après application ne fait rien', () => {
  const journalRows = [j(1, 'a', 10), j(2, 'b', 20, { Supprime: true })];
  const destRows = [{ id: 1, id_sync: 'a', Nom: 'n1', Sync_JournalId: 1, Sync_Ordre: 10 }];
  const { actions } = planConsolidation({ journalRows, destRows, copyCols: ['Nom'], destTable: 'Dest' });
  assert.deepEqual(actions, []);
});

test('purge : garde la dernière version de chaque clé et les lignes sans clé', () => {
  const rows = [j(1, 'a', 10), j(2, 'a', 20), j(3, 'b', 10), j(4, '', 5), j(5, 'a', 15)];
  assert.deepEqual(planPurge(rows, 'Journal'), [['BulkRemoveRecord', 'Journal', [1, 5]]]);
  assert.deepEqual(planPurge([j(1, 'a', 1)], 'Journal'), []);
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

test('invitation : aller-retour et refus des codes invalides', () => {
  const columns = [{ colId: 'id_sync', type: 'Text' }, { colId: 'MajLe', type: 'DateTime:UTC' },
    { colId: 'Supprime', type: 'Bool' }, { colId: 'Ville', type: 'Ref:Villes', label: 'Ville é' }];
  const code = buildInvitation({ name: 'Contacts 2026', table: 'Contacts', columns, secret: SECRET, origin: 'https://g.fr' });
  assert.ok(code.startsWith('GRISTSYNC1.'));
  const inv = parseInvitation(code);
  assert.equal(inv.columns[3].type, 'Int');
  assert.equal(inv.columns[3].label, 'Ville é');
  assert.throws(() => parseInvitation('bonjour'), /codeFormat/);
  assert.throws(() => decodeCode(code, 'reponse'), /notReply/);
  const bad = buildInvitation({ name: 'x', table: 'Contacts', columns: [{ colId: 'a;b', type: 'Text' }], secret: SECRET, origin: '' });
  assert.throws(() => parseInvitation(bad), /codeInvalid/);
});

test('réponse : même instance, adresse par clé de formulaire seulement', () => {
  const url = 'https://g.fr/o/eq/api/s/Abc123/tables/Journal_Contacts/records?flat=1';
  const recipient = { email: 'a@b.fr', docId: 'doc1', team: 'eq', journal: 'Journal_Contacts', at: '2026-10-14', extra: 'x' };
  const reply = parseReply(buildReply({ url, secret: SECRET, recipient }), 'https://g.fr');
  assert.equal(reply.url, url);
  assert.equal(reply.recipient.extra, undefined);
  assert.throws(() => parseReply(buildReply({ url, secret: SECRET, recipient }), 'https://autre.fr'), /otherInstance/);
  const noFlat = url.replace('?flat=1', '');
  assert.throws(() => parseReply(buildReply({ url: noFlat, secret: SECRET, recipient }), 'https://g.fr'), /codeInvalid/);
  const api = 'https://g.fr/api/docs/doc1/tables/T/records?flat=1';
  assert.throws(() => parseReply(buildReply({ url: api, secret: SECRET, recipient }), 'https://g.fr'), /codeInvalid/);
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
