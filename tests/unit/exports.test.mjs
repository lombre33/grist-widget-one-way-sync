// Exports (SOURCE) : colonnes envoyables, lignes de Synchro, webhooks et leur condition, lien public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTrackRowsAction, conditionExport, exchangeColumns, exchangeTables, exportableColumns, exportCondition, exportRowsActions, exportTables, hookName, hooksOf, isPublicRule, publicAclActions, publicAclRules, rowFilter, ruleText } from '../../js/logic/exports.js';
import { sentColumns } from '../../js/logic/journal.js';
import { resendValue } from '../../js/logic/resend.js';
import { EXPORT } from './fixtures.mjs';

test('Échange : ligne \'echange\' de l\'export, colonnes avec leur nom dans l\'autre document', () => {
  const E = '0123456789abcdef';
  const columns = [{ id: 'Nom_2', type: 'Text', label: 'Nom', source: 'Text', visible: '', as: 'Nom' }];
  const { actions } = exportRowsActions([], E, [{ table: 'Contacts', columns }], { swap: true });
  const values = actions[0][3];
  assert.deepEqual(values.Synchro_Type, ['cles', 'lot', 'suivi', 'echange']);
  assert.deepEqual(values.Synchro_Table, ['Contacts', 'Contacts', 'Contacts', '']);
  assert.equal(values.Synchro_Colonnes[0], '[{"id":"Nom_2","type":"Text","label":"Nom","source":"Text","visible":"","as":"Nom"}]');
  const rows = values.Synchro_Type.map((type, i) => ({ id: i + 1, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]])) }));
  assert.deepEqual(exportTables(rows, E).map(tb => tb.table), ['Contacts'], 'la ligne \'echange\' n\'est pas une table');
  assert.deepEqual(exportRowsActions(rows, E, [{ table: 'Contacts', columns }], { swap: true }).actions, []);
  assert.deepEqual(exportRowsActions(rows, E, [{ table: 'Contacts', columns }]).actions, [['BulkRemoveRecord', 'Synchro', [4]]]);
  assert.deepEqual(sentColumns([{ id: 1, Synchro_Colonnes: values.Synchro_Colonnes[0] }]), [{ id: 'Nom_2', type: 'Text', label: 'Nom', as: 'Nom' }]);
  assert.deepEqual(sentColumns([{ id: 1, Synchro_Colonnes: '[{"id":"Nom","type":"Text","as":"a b"}]' }]), [], 'nom dans l\'autre document invalide');
});

test('colonnes envoyables : Référence en texte, pièces jointes bloquées, colonnes techniques exclues', () => {
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
  assert.deepEqual(sendable[1], { id: 'Ville', label: 'Ville', type: 'Text', source: 'Ref:Villes', visible: 'Nom', blocked: false });
});

test('table Synchro : lignes d\'un export (liste, lot, instantané public), tables ajoutées, changées ou retirées', () => {
  const col = id => ({ id, type: 'Text', label: id, source: 'Text', visible: '', blocked: false });
  const E = '0123456789abcdef';
  const first = exportRowsActions([], E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(first.changed, ['Contacts', 'Villes']);
  assert.equal(first.actions.length, 1);
  const [, table, ids, values] = first.actions[0];
  assert.equal(table, 'Synchro');
  assert.equal(ids.length, 6);
  assert.deepEqual(values.Synchro_Type, ['cles', 'lot', 'suivi', 'cles', 'lot', 'suivi']);
  assert.deepEqual(values.Synchro_Colonnes[0], '[{"id":"Nom","type":"Text","label":"Nom","source":"Text","visible":""}]');
  const rows = ids.map((_, i) => ({ id: i + 1, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]])) }));
  rows.push({ id: 9, Synchro_Export: 'fedcba9876543210', Synchro_Table: 'Contacts', Synchro_Type: 'cles', Synchro_Colonnes: '[]' });
  assert.deepEqual(exportTables(rows, E), [{ table: 'Contacts', columns: JSON.parse(values.Synchro_Colonnes[0]), filter: null }, { table: 'Villes', columns: JSON.parse(values.Synchro_Colonnes[3]), filter: null }]);
  assert.deepEqual(exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]), { actions: [], changed: [] });
  const edit = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom'), col('Age')] }]);
  assert.deepEqual(edit.changed, ['Contacts']);
  assert.deepEqual(edit.actions.map(a => [a[0], a[2]]), [['BulkUpdateRecord', [1, 2, 3]], ['BulkRemoveRecord', [4, 5, 6]]], 'l\'autre export n\'est pas touché');
  assert.equal(addTrackRowsAction(rows.filter(r => r.Synchro_Export === E)), null, 'chaque table a son suivi');
  const before05 = rows.filter(r => r.Synchro_Type !== 'suivi');
  assert.deepEqual(addTrackRowsAction(before05), ['BulkAddRecord', 'Synchro', [null, null, null], {
    Synchro_Export: [E, E, 'fedcba9876543210'], Synchro_Table: ['Contacts', 'Villes', 'Contacts'], Synchro_Colonnes: [values.Synchro_Colonnes[0], values.Synchro_Colonnes[3], '[]'],
    Synchro_Type: ['suivi', 'suivi', 'suivi'], Synchro_Renvoi: ['', '', ''] }], 'montage 0.4 : le suivi est ajouté');
  const pub = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }], { isPublic: true });
  assert.deepEqual(pub.actions[0][3].Synchro_Type, ['complet', 'empreinte', 'complet', 'empreinte']);
  assert.deepEqual(pub.changed, []);
  // Filtre de lignes : une ligne 'filtre' par table filtrée ; poser, changer ou retirer un filtre
  // renvoie la table.
  const filter = { id: 'Statut', source: 'Choice', visible: '', value: ' Actif ' };
  const filtered = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')], filter }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(filtered.changed, ['Contacts']);
  assert.deepEqual(filtered.actions[0][3].Synchro_Type, ['filtre']);
  assert.equal(filtered.actions[0][3].Synchro_Colonnes[0], '{"id":"Statut","source":"Choice","visible":"","value":"actif"}');
  const withFilter = [...rows, { id: 10, Synchro_Export: E, Synchro_Table: 'Contacts', Synchro_Type: 'filtre', Synchro_Colonnes: filtered.actions[0][3].Synchro_Colonnes[0] }];
  assert.deepEqual(exportTables(withFilter, E)[0].filter, { id: 'Statut', source: 'Choice', visible: '', value: 'actif' });
  const unfiltered = exportRowsActions(withFilter, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(unfiltered, { actions: [['BulkRemoveRecord', 'Synchro', [10]]], changed: ['Contacts'] });
  assert.equal(rowFilter({ id: 'a;b', value: 'x' }), null);
  assert.equal(rowFilter({ id: 'Actif', source: 'Bool', value: 'Yes' }).value, 'oui', 'case à cocher : oui ou non, en français comme en anglais');
  assert.equal(rowFilter({ id: 'Actif', source: 'Bool', value: 'faux' }).value, 'non');
});

test('webhook d\'un destinataire : condition sur son export, relue à l\'identique seulement', () => {
  const E = '0123456789abcdef';
  assert.equal(exportCondition(E), 'rec.Synchro_Export == "0123456789abcdef" and rec.Synchro_Type in ("cles", "lot")');
  assert.equal(conditionExport(exportCondition(E)), E);
  assert.equal(conditionExport(''), '');
  assert.equal(conditionExport(null), '');
  assert.equal(conditionExport('rec.Synchro_Export == "0123456789abcdef" or True and rec.Synchro_Type in ("cles", "lot")'), '');
  assert.throws(() => exportCondition('0123456789ABCDEF'), /codeInvalid/, 'l\'identifiant entre dans une formule : 16 chiffres hexadécimaux en minuscules');
  assert.throws(() => exportCondition('" or True or "'), /codeInvalid/);
  assert.equal(conditionExport('rec.Synchro_Export == "0123456789ABCDEF" and rec.Synchro_Type in ("cles", "lot")'), '');
  assert.equal(hookName('Annuaire', E), 'Synchro Annuaire #0123456789abcdef');
  assert.equal(resendValue('ab12', [3, 4]), 'ab12:3,4');
});

test('lien public : règles d\'accès du widget, avant les règles existantes, retirables', () => {
  const E = '0123456789abcdef';
  const F = 'fedcba9876543210';
  assert.deepEqual(publicAclRules([F, E, 'pas un export']), [
    { tableId: 'Synchro', colIds: 'Synchro_Export', aclFormula: 'user.Access == VIEWER', permissionsText: '-R' },
    { tableId: 'Synchro', colIds: '*', permissionsText: '+R', aclFormula: `user.Access == VIEWER and rec.Synchro_Export in ["${E}", "${F}"] and rec.Synchro_Type in ["complet", "empreinte"]` },
    { tableId: '*', colIds: '*', aclFormula: 'user.Access == VIEWER', permissionsText: '-R' },
  ], 'la colonne qui porte la note de la SOURCE est cachée aux lecteurs');
  assert.deepEqual(publicAclRules([]), []);
  assert.deepEqual(publicAclRules([], { keepDeny: true }).map(r => r.tableId), ['*']);
  const resources = [{ id: 1, tableId: '*', colIds: '*' }];
  const rules = [{ id: 5, resource: 1, rulePos: 1, memo: '' }, { id: 6, resource: 1, rulePos: -1, memo: 'Synchro : lecture limitée aux vues d’export' }];
  const actions = publicAclActions(resources, rules, [E]);
  assert.deepEqual(actions[0], ['BulkRemoveRecord', '_grist_ACLRules', [6]], 'règle d\'une version précédente retirée');
  assert.deepEqual(actions.filter(a => a[1] === '_grist_ACLResources').map(a => `${a[3].tableId}:${a[3].colIds}`), ['Synchro:Synchro_Export', 'Synchro:*']);
  const added = actions.filter(a => a[1] === '_grist_ACLRules' && a[0] === 'AddRecord');
  assert.deepEqual(added.map(a => [a[3].resource, a[3].permissionsText]), [[-1, '-R'], [-2, '+R'], [1, '-R']]);
  assert.equal(ruleText(publicAclRules([E])[0]), 'Synchro|Synchro_Export|user.Access == VIEWER|-R');
  assert.ok(added.every(a => a[3].rulePos < -1 && a[3].memo === 'Synchro : lecture limitée aux exports publics'));
  assert.deepEqual(publicAclActions(resources, rules, []), [['BulkRemoveRecord', '_grist_ACLRules', [6]]]);
});

// Cas limites.

test('filtre de lignes : formes acceptées', () => {
  assert.equal(rowFilter(null), null);
  assert.equal(rowFilter({ id: 'a b', value: 'x' }), null);
  assert.deepEqual(rowFilter({ id: 'Actif', source: 'Bool', value: ' Oui ' }), { id: 'Actif', source: 'Bool', visible: '', value: 'oui' });
  assert.deepEqual(rowFilter({ id: 'Actif', source: 'Bool', value: 'peut-être' }).value, 'non');
  assert.equal(rowFilter({ id: 'Ville', value: '  LYON ' }).value, 'lyon');
  assert.equal(rowFilter({ id: 'N', value: 0 }).value, '0');
});

test('condition d\'un webhook : rien d\'autre que la forme exacte', () => {
  const ok = `rec.Synchro_Export == "${EXPORT}" and rec.Synchro_Type in ("cles", "lot")`;
  assert.equal(conditionExport(ok), EXPORT);
  assert.equal(conditionExport(` ${ok}`), '');
  assert.equal(conditionExport(ok.replace('"lot")', '"lot", "complet")')), '');
  assert.equal(conditionExport(ok.replace(EXPORT, `${EXPORT}" or "1`)), '');
  assert.equal(conditionExport(null), '');
  const hooks = [{ id: 'h1', fields: { tableId: 'Synchro' } }, { id: 'h2', fields: { tableId: 'Contacts' } }, { id: 'h3', fields: { tableId: 'Synchro' } }];
  const conditions = new Map([['h1', ok], ['h2', ok], ['h3', '']]);
  assert.deepEqual(hooksOf(hooks, conditions, EXPORT).map(h => h.id), ['h1'], 'webhook d\'une autre table ou sans filtre : pas un destinataire');
  assert.ok(isPublicRule({ memo: 'Synchro : lecture limitée aux exports publics' }) && !isPublicRule({ memo: '' }));
});

test('Échange : colonnes renvoyées sous leur nom d\'origine, correspondance déduite', () => {
  const entries = [{ table: 'Contacts', dest: 'Fiches', columns: [{ id: 'Nom' }, { id: 'Ville' }], map: { Ville: 'Commune' } }, { table: 'Vide', dest: 'Rien', columns: [{ id: 'X' }] }];
  const columnsOf = dest => (dest === 'Fiches' ? [{ id: 'Nom', type: 'Text' }, { id: 'Commune', type: 'Text' }, { id: 'Note', type: 'Text' }, { id: 'Photo', blocked: true }] : []);
  assert.deepEqual(exchangeTables(entries, columnsOf), [{ table: 'Fiches', filter: null, columns: [{ id: 'Nom', type: 'Text', as: 'Nom' }, { id: 'Commune', type: 'Text', as: 'Ville' }] }],
    'seules les colonnes reçues repartent ; une destination sans colonne ne part pas');
  const allowed = new Set(['Ville', 'Nom', 'Lieu']);
  assert.deepEqual(exchangeColumns([{ id: 'Commune', as: 'Ville' }, { id: 'Nom' }], allowed),
    { sent: [{ id: 'Commune', as: 'Ville' }, { id: 'Nom' }], map: { Commune: 'Ville', Nom: 'Nom' } });
  assert.deepEqual(exchangeColumns([{ id: 'Commune', as: 'Ville' }], allowed, { Commune: 'Lieu' }).map, { Commune: 'Lieu' }, 'un choix noté l\'emporte');
  // L'autre document n'écrit que les colonnes que l'export d'ici envoie : ni colonne gardée pour
  // soi (Salaire), ni colonne nouvelle (Pirate).
  const forged = exchangeColumns([{ id: 'X', as: 'Salaire' }, { id: 'Salaire' }, { id: 'Pirate' }, { id: 'Commune', as: 'Ville' }], allowed);
  assert.deepEqual(forged, { sent: [{ id: 'Commune', as: 'Ville' }], map: { Commune: 'Ville' } });
});
