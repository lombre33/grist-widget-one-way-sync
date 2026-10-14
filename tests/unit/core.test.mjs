// Tests unitaires de la logique pure : `node --test tests/unit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvitation, buildReply, buildWebhookUrl, chunk, exportFormula, exportableColumns, expandRows, sentColumns, compareVersion, copyColumns,
  decodeCode, fillKeyActions, latestByKey, maskKey, parseDocBaseUrl, parseFormLink, parseInvitation,
  parseReply, parseWebhookUrl, planConsolidation, planPull, planPurge, publicAclActions, recentChanges, prepareSourceActions, toRows, toTableId,
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

test('vue d\'export : colonnes envoyables, formule du bloc JSON', () => {
  const cols = [
    { colId: 'Nom', type: 'Text', label: 'Nom' },
    { colId: 'Ville', type: 'Ref:Villes', visible: 'Nom' },
    { colId: 'Tags', type: 'RefList:Tags', visible: '' },
    { colId: 'Photo', type: 'Attachments' },
    { colId: 'gristHelper_Display', type: 'Any' },
    { colId: 'manualSort', type: 'ManualSortPos' },
    { colId: 'id_sync', type: 'Text' }, { colId: 'MajLe', type: 'DateTime:UTC' }, { colId: 'Supprime', type: 'Bool' },
  ];
  const sendable = exportableColumns(cols);
  assert.deepEqual(sendable.map(c => [c.id, c.type, c.blocked]), [['Nom', 'Text', false], ['Ville', 'Text', false], ['Tags', 'Text', false], ['Photo', 'Attachments', true]]);
  const formula = exportFormula(sendable.filter(c => !c.blocked));
  assert.match(formula, /r = \$group\[0\]/);
  assert.match(formula, /"Nom": g\(lambda: r\.Nom\)/);
  assert.match(formula, /"Ville": g\(lambda: r\.Ville\.Nom\)/);
  assert.match(formula, /"Tags": g\(lambda: ", "\.join\(str\(x\.id\) for x in r\.Tags\)\)/);
});

test('CIBLE : bloc JSON déplié, colonnes envoyées lues dans la dernière liste', () => {
  const rows = expandRows([
    { id: 1, id_sync: 'a', Synchro_Donnees: '{"Nom": "Alice", "Tags": ["x", "y"], "id": 99}' },
    { id: 2, id_sync: 'b', Nom: 'ancien format' },
    { id: 3, id_sync: '', Synchro_Ids: 'ids:a', Synchro_Colonnes: '[{"id":"Nom","type":"Text","label":"Nom"}]' },
  ]);
  assert.equal(rows[0].Nom, 'Alice');
  assert.deepEqual(rows[0].Tags, ['L', 'x', 'y']);
  assert.equal(rows[0].id, 1, 'le numéro de ligne du Journal reste le sien');
  assert.equal(rows[1].Nom, 'ancien format');
  assert.deepEqual(sentColumns(rows).map(c => c.id), ['Nom']);
  assert.deepEqual(sentColumns(rows.slice(0, 2), [{ id: 'X', type: 'Text' }]).map(c => c.id), ['X']);
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
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom' }, { id: 'Ville', type: 'Text', label: 'Ville é' }];
  const id = '0123456789abcdef';
  const code = buildInvitation({ id, name: 'Annuaire', secret: SECRET, origin: 'https://g.fr', tables: [{ table: 'Contacts', columns }, { table: 'Villes', columns }] });
  assert.ok(code.startsWith('GRISTSYNC1.'));
  const inv = parseInvitation(code);
  assert.deepEqual(inv.tables.map(tb => tb.table), ['Contacts', 'Villes']);
  assert.deepEqual(inv.tables[0].columns[1], { id: 'Ville', type: 'Text', label: 'Ville é' });
  assert.equal(parseInvitation(buildInvitation({ id, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })).secret, '');
  assert.throws(() => parseInvitation('bonjour'), /codeFormat/);
  assert.throws(() => decodeCode(code, 'reponse'), /notReply/);
  const bad = buildInvitation({ id, name: 'x', origin: '', tables: [{ table: 'Contacts', columns: [{ id: 'a;b', type: 'Text' }] }] });
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

test('lien public : règles d\'accès du widget, avant les règles existantes, retirables', () => {
  const resources = [{ id: 1, tableId: '*', colIds: '*' }];
  const rules = [{ id: 5, resource: 1, rulePos: 1, memo: '' }, { id: 6, resource: 1, rulePos: -1, memo: 'Synchro : lecture limitée aux vues d’export' }];
  const actions = publicAclActions(resources, rules, ['Contacts']);
  assert.deepEqual(actions[0], ['BulkRemoveRecord', '_grist_ACLRules', [6]]);
  const added = actions.filter(a => a[1] === '_grist_ACLRules' && a[0] === 'AddRecord').map(a => [a[3].resource, a[3].permissionsText, a[3].aclFormula]);
  assert.deepEqual(added, [[-1, '+R', 'user.Access == VIEWER'], [-2, '+R', 'user.Access == VIEWER'], [1, '-R', 'user.Access == VIEWER']]);
  assert.deepEqual(actions.filter(a => a[1] === '_grist_ACLResources').map(a => a[3].tableId), ['Contacts_summary_id_sync', 'Synchro_Contacts']);
  assert.ok(actions.filter(a => a[0] === 'AddRecord' && a[1] === '_grist_ACLRules').every(a => a[3].rulePos < -1));
  assert.deepEqual(publicAclActions(resources, rules, []), [['BulkRemoveRecord', '_grist_ACLRules', [6]]]);
  assert.equal(publicAclActions(resources, rules, [], { keepDeny: true }).filter(a => a[0] === 'AddRecord').length, 1);
});

test('lien public : seules les versions nouvelles et une liste changée entrent au Journal', () => {
  const records = [
    { id: 1, fields: { id_sync: 'a', MajLe: 10, Supprime: false, Synchro_Donnees: '{"Nom":"A"}' } },
    { id: 2, fields: { id_sync: 'b', MajLe: 20, Supprime: false, Synchro_Donnees: '{"Nom":"B2"}' } },
  ];
  const schema = [{ id: 'Nom', type: 'Text', label: 'Nom' }];
  const journalRows = [
    { id: 1, id_sync: 'a', MajLe: 10, Supprime: false, Synchro_Donnees: '{"Nom":"A"}' },
    { id: 2, id_sync: 'b', MajLe: 20, Supprime: false, Synchro_Donnees: '{"Nom":"B"}' },
    { id: 3, id_sync: '', Synchro_Ids: 'ids:b a', Synchro_Colonnes: JSON.stringify(schema) },
  ];
  assert.deepEqual(planPull({ records, schema, journalRows, journalTable: 'J' }), [
    ['BulkAddRecord', 'J', [null], { id_sync: ['b'], MajLe: [20], Supprime: [false], Synchro_Donnees: ['{"Nom":"B2"}'] }],
  ]);
  const gone = planPull({ records: records.slice(0, 1), schema, journalRows, journalTable: 'J' });
  assert.deepEqual(gone.at(-1), ['AddRecord', 'J', null, { Synchro_Ids: 'ids:a', Synchro_Colonnes: JSON.stringify(schema) }]);
});

test('invitation par lien public : adresse du document réécrite, sinon refusée', () => {
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom' }];
  const id = '0123456789abcdef';
  const code = buildInvitation({ id, name: 'x', origin: 'https://g.fr', base: 'https://g.fr/o/eq/api/docs/abcDEF12', tables: [{ table: 'Contacts', columns }] });
  const inv = parseInvitation(code);
  assert.equal(inv.mode, 'public');
  assert.equal(inv.base, 'https://g.fr/o/eq/api/docs/abcDEF12');
  const bad = buildInvitation({ id, name: 'x', origin: '', base: 'https://g.fr/api/docs/abc?x=1', tables: [{ table: 'Contacts', columns }] });
  assert.throws(() => parseInvitation(bad), /codeInvalid/);
  assert.equal(parseInvitation(buildInvitation({ id, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })).mode, 'reponse');
});
