// Règles d'accès posées par le widget : lien public, Synchro réservée aux propriétaires, journaux
// réservés aux éditeurs ; et refus du lien public quand une règle cache une partie d'une table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_MEMO, OWNER_MEMO, PUBLIC_MEMO, aclActions, currentRules, hiddenTables, isPublicRule, isWidgetRule, journalAclRules, ownerAclRules, publicAclRules, ruleText,
} from '../../js/logic/acl.js';

const E = '0123456789abcdef';
const F = 'fedcba9876543210';
const strip = rules => rules.map(({ memo, ...rule }) => rule);

test('lien public : seuls les instantanés des exports publics, sans la note de la SOURCE', () => {
  assert.deepEqual(strip(publicAclRules([F, E, 'pas un export'])), [
    { tableId: 'Synchro', colIds: 'Synchro_Export', aclFormula: 'user.Access == VIEWER', permissionsText: '-R' },
    { tableId: 'Synchro', colIds: '*', permissionsText: '+R', aclFormula: `user.Access == VIEWER and rec.Synchro_Export in ["${E}", "${F}"] and rec.Synchro_Type in ["complet", "empreinte"]` },
    { tableId: '*', colIds: '*', aclFormula: 'user.Access == VIEWER', permissionsText: '-R' },
  ], 'la colonne qui porte la note de la SOURCE est cachée aux lecteurs');
  assert.ok(publicAclRules([E]).every(r => r.memo === PUBLIC_MEMO && isPublicRule(r) && isWidgetRule(r)));
  assert.deepEqual(publicAclRules([]), []);
  assert.deepEqual(publicAclRules([], { keepDeny: true }).map(r => r.tableId), ['*'], 'document encore public : le refus général reste');
  assert.ok(isPublicRule({ memo: 'Synchro : lecture limitée aux vues d’export' }), 'règle d\'une version précédente reconnue');
  assert.ok(!isWidgetRule({ memo: '' }) && !isWidgetRule({ memo: 'Synchro' }));
});

test('Synchro réservée aux propriétaires : un éditeur ne lit que les lignes d\'un Échange, sans lot ni listes', () => {
  const rules = ownerAclRules();
  assert.ok(rules.every(r => r.tableId === 'Synchro' && r.memo === OWNER_MEMO && !isPublicRule(r)));
  assert.deepEqual(rules.map(r => [r.colIds, r.permissionsText]), [
    ['Synchro_Export', '-R'], ['Synchro_Lot,Synchro_Ids,Sync_Etat,Sync_Par', '-RU'], ['Synchro_Renvoi', '+RU'], ['*', '+R'], ['*', '-CRUD'],
  ]);
  assert.equal(rules[0].aclFormula, 'user.Access == VIEWER', 'note de la SOURCE cachée aux lecteurs');
  assert.equal(rules[1].aclFormula, 'user.Access == EDITOR', 'les colonnes ne visent pas les lecteurs : le lien public lit encore l\'instantané');
  assert.equal(rules[2].aclFormula, 'user.Access == EDITOR and rec.Synchro_Type in ["echange", "lot"]', 'la recopie d\'un Échange écrit Synchro_Renvoi');
  assert.equal(rules[3].aclFormula, rules[2].aclFormula);
  assert.equal(rules[4].aclFormula, 'user.Access != OWNER');
});

test('journaux réservés aux éditeurs : un refus de lecture par journal, dans l\'ordre', () => {
  assert.deepEqual(journalAclRules(['Journal_B', 'Journal_A']).map(r => [r.tableId, r.colIds, r.aclFormula, r.permissionsText, r.memo]), [
    ['Journal_A', '*', 'user.Access == VIEWER', '-R', JOURNAL_MEMO], ['Journal_B', '*', 'user.Access == VIEWER', '-R', JOURNAL_MEMO],
  ]);
  assert.deepEqual(journalAclRules([]), []);
});

test('règles du widget : remplacées seulement si elles diffèrent, avant toutes les autres', () => {
  const resources = [{ id: 1, tableId: '*', colIds: '*' }, { id: 2, tableId: 'Synchro', colIds: '*' }];
  const rules = [
    { id: 5, resource: 1, rulePos: 1, aclFormula: 'user.Email == "a@b.fr"', permissionsText: '+R', memo: '' },
    { id: 6, resource: 1, rulePos: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: 'Synchro : lecture limitée aux vues d’export' },
  ];
  const wanted = [...publicAclRules([E]), ...ownerAclRules()];
  const actions = aclActions(resources, rules, wanted);
  assert.deepEqual(actions[0], ['BulkRemoveRecord', '_grist_ACLRules', [6]], 'règle d\'une version précédente retirée, celle d\'autrui gardée');
  assert.deepEqual(actions.filter(a => a[1] === '_grist_ACLResources').map(a => [a[2], `${a[3].tableId}:${a[3].colIds}`]),
    [[-1, 'Synchro:Synchro_Export'], [-2, 'Synchro:Synchro_Lot,Synchro_Ids,Sync_Etat,Sync_Par'], [-3, 'Synchro:Synchro_Renvoi']], 'une ressource par colonnes, réutilisée');
  const bulk = actions.filter(a => a[1] === '_grist_ACLRules' && a[0].endsWith('AddRecord'));
  assert.equal(bulk.length, 1, 'un seul ajout : Grist inverserait des ajouts successifs placés avant les autres');
  const cols = bulk[0][3];
  const added = cols.resource.map((resource, i) => ({ resource, permissionsText: cols.permissionsText[i], memo: cols.memo[i], rulePos: cols.rulePos[i] }));
  assert.deepEqual(added.map(a => [a.resource, a.permissionsText, a.memo]), wanted.map((w) => {
    const id = { 'Synchro|Synchro_Export': -1, 'Synchro|Synchro_Lot,Synchro_Ids,Sync_Etat,Sync_Par': -2, 'Synchro|Synchro_Renvoi': -3, 'Synchro|*': 2, '*|*': 1 }[`${w.tableId}|${w.colIds}`];
    return [id, w.permissionsText, w.memo];
  }));
  assert.ok(added.every((a, i) => a.rulePos < 1 && (i === 0 || a.rulePos > added[i - 1].rulePos)), 'dans l\'ordre voulu, avant la règle d\'autrui');
  // Déjà en place, dans le même ordre : rien (changer une règle recharge le document).
  const placed = [...resources, { id: 3, tableId: 'Synchro', colIds: 'Synchro_Export' }, { id: 4, tableId: 'Synchro', colIds: 'Synchro_Lot,Synchro_Ids,Sync_Etat,Sync_Par' },
    { id: 7, tableId: 'Synchro', colIds: 'Synchro_Renvoi' }];
  const resourceOf = w => placed.find(r => r.tableId === w.tableId && r.colIds === w.colIds).id;
  const now = [rules[0], ...wanted.map((w, i) => ({ id: 10 + i, resource: resourceOf(w), rulePos: i - 20, aclFormula: w.aclFormula, permissionsText: w.permissionsText, memo: w.memo }))];
  assert.deepEqual(currentRules(placed, now).map(ruleText), wanted.map(ruleText));
  assert.deepEqual(aclActions(placed, now, wanted), []);
  assert.deepEqual(aclActions(placed, now, wanted.slice().reverse()).slice(0, 1), [['BulkRemoveRecord', '_grist_ACLRules', now.slice(1).map(r => r.id)]], 'ordre changé : tout est reposé');
  assert.deepEqual(aclActions(resources, [rules[0]], []), [], 'rien à poser ni à retirer');
  assert.deepEqual(aclActions(resources, rules, []), [['BulkRemoveRecord', '_grist_ACLRules', [6]]]);
});

test('lien public : refusé pour une table dont une règle cache des lignes ou des colonnes', () => {
  const resources = [{ id: 1, tableId: 'Contacts', colIds: 'Salaire' }, { id: 2, tableId: 'Villes', colIds: '*' }, { id: 3, tableId: '*', colIds: '*' }, { id: 4, tableId: 'Notes', colIds: '*' }];
  const rules = [
    { resource: 1, permissionsText: '-R', memo: '' },
    { resource: 2, permissionsText: '+R-U', memo: '' },
    { resource: 3, permissionsText: '-R', memo: '' },
    { resource: 4, permissionsText: 'none', memo: '' },
    { resource: 2, permissionsText: '-R', memo: OWNER_MEMO },
  ];
  assert.deepEqual(hiddenTables(resources, rules, ['Contacts', 'Villes', 'Notes', 'Autre']), ['Contacts', 'Notes'],
    'colonne cachée, table refusée ; pas une règle qui n\'ôte que l\'écriture, ni une règle du widget');
  assert.deepEqual(hiddenTables(resources, [{ resource: 2, permissionsText: '-CRUD', memo: '' }], ['Villes']), ['Villes']);
  assert.deepEqual(hiddenTables(resources, [{ resource: 2, permissionsText: '-U+R', memo: '' }], ['Villes']), []);
});

test('règles du widget : une ressource d\'une table effacée part avec elles, sauf si une autre règle s\'en sert', () => {
  const resources = [{ id: 1, tableId: 'Journal_A', colIds: '*' }, { id: 2, tableId: 'Journal_B', colIds: '*' }, { id: 3, tableId: '*', colIds: '*' }];
  const rules = [
    { id: 5, resource: 1, rulePos: -2, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: JOURNAL_MEMO },
    { id: 6, resource: 2, rulePos: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: JOURNAL_MEMO },
    { id: 7, resource: 2, rulePos: 1, aclFormula: '', permissionsText: '-D', memo: '' },
  ];
  const actions = aclActions(resources, rules, journalAclRules([]), id => id !== 'Journal_C');
  assert.deepEqual(actions, [['BulkRemoveRecord', '_grist_ACLRules', [5, 6]], ['BulkRemoveRecord', '_grist_ACLResources', [1]]]);
  const again = aclActions(resources, rules.slice(0, 2), journalAclRules(['Journal_A']), id => id === 'Journal_B');
  assert.deepEqual(again.slice(0, 2), [['BulkRemoveRecord', '_grist_ACLRules', [5, 6]], ['BulkRemoveRecord', '_grist_ACLResources', [2]]]);
  assert.equal(again[2][3].resource[0], 1, 'la ressource d\'une table présente est réutilisée');
  assert.deepEqual(aclActions(resources, rules.slice(0, 1), journalAclRules(['Journal_A']), () => true), [], 'règles en place : une ressource libre ne gêne pas');
});
