// Recopie des versions reçues dans les tables de destination (CIBLE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyColumns, destRefs, followRenames, newColumnsMap, planConsolidation } from '../../js/logic/consolidation.js';
import { j, plan, marked, list, done, gone, part } from './fixtures.mjs';

test('copyColumns ignore les colonnes techniques et les formules de la destination', () => {
  const journal = ['id_sync', 'MajLe', 'Supprime', 'Nom', 'Ville', 'Age', 'manualSort', 'gristHelper_X'].map(colId => ({ colId }));
  const dest = [{ colId: 'id_sync' }, { colId: 'Nom' }, { colId: 'Ville', isFormula: true }, { colId: 'Age' }];
  assert.deepEqual(copyColumns(journal, dest), [['Nom', 'Nom'], ['Age', 'Age']]);
  assert.deepEqual(copyColumns(journal, [...dest, { colId: 'Commune' }], { Ville: 'Commune' }), [['Nom', 'Nom'], ['Ville', 'Commune'], ['Age', 'Age']]);
});

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

test('consolidation : une version identique à la destination est sans effet (renvoi)', () => {
  const journalRows = [j(1, 'a', 10, { Nom: 'Lyon' }), j(2, 'b', 10, { Nom: '', Tags: ['x'] })];
  const destRows = [{ id: 7, id_sync: 'a', Nom: 'Lyon' }, { id: 8, id_sync: 'b', Nom: null, Tags: ['L', 'x'] }];
  const { actions, stats } = planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom'], ['Tags', 'Tags']], destTable: 'Dest', journalTable: 'J' });
  assert.deepEqual(stats, { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(actions, [marked([1, 2], ['', ''])]);
});

test('consolidation : un renvoi des mêmes valeurs ne défait pas une retouche manuelle', () => {
  const journalRows = [j(1, 'a', 10, { Nom: 'Lyon', ...done }), j(2, 'a', 10, { Nom: 'Lyon' }), j(3, 'b', 10, { Nom: 'Nice', ...done }), j(4, 'b', 10, { Nom: 'Nice' })];
  const destRows = [{ id: 7, id_sync: 'a', Nom: 'retouche' }];
  const { actions, stats } = plan(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 0, removed: 0 }, 'une ligne effacée à la main revient');
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b'] }, { Nom: ['Nice'] }, { on_many: 'all' }],
    marked([2, 4], ['', 'ajout']),
  ]);
  assert.deepEqual(plan([...journalRows.slice(0, 1), j(2, 'a', 11, { Nom: 'Lille' })], destRows).stats.updated, 1, 'une vraie modification passe');
});

test('Échange : la version la plus récente gagne et écrit MajLe ; les listes des clés sont sans effet', () => {
  const swap = (journalRows, destRows) => planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', exchange: true });
  const destRows = [{ id: 1, id_sync: 'a', Nom: 'ici', MajLe: 20 }, { id: 2, id_sync: 'b', Nom: 'ici', MajLe: 20 }, { id: 3, id_sync: 'c', Nom: 'ici', MajLe: null },
    { id: 4, id_sync: 'd', Nom: 'ici', MajLe: 20 }, { id: 5, id_sync: 'e', Nom: 'ici', MajLe: 20 }];
  const journalRows = [j(1, 'a', 30, { Nom: 'là-bas' }), j(2, 'b', 10, { Nom: 'ancienne' }), j(3, 'c', 5, { Nom: 'là-bas' }), j(4, 'd', 20, { Nom: 'même heure' }),
    j(5, 'e', 15, { Supprime: true }), j(6, 'f', null, { Nom: 'nouvelle' }), list(7, ['a']), gone(8, 40, ['b'])];
  const { actions, stats } = swap(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 2, removed: 0 }, 'rien n\'est effacé : ni par la liste, ni par une suppression plus ancienne que la ligne d\'ici');
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['a', 'c', 'f'] }, { Nom: ['là-bas', 'là-bas', 'nouvelle'], MajLe: [30, 5, null] }, { on_many: 'all' }],
    marked([7, 8, 1, 2, 3, 4, 5, 6], ['', '', 'modif', '', 'modif', '', '', 'ajout']),
  ]);
  const deleted = swap([j(1, 'e', 25, { Supprime: true })], destRows);
  assert.deepEqual(deleted.actions[0], ['BulkRemoveRecord', 'Dest', [5]], 'Supprime plus récente : la ligne est effacée');
  const applied = [{ ...destRows[0], Nom: 'là-bas', MajLe: 30 }, ...destRows.slice(1)];
  assert.deepEqual(swap([j(1, 'a', 30, { Nom: 'là-bas' })], applied).actions, [marked([1], [''])], 'sa propre version revenue (écho) est sans effet');
  const matched = planConsolidation({ journalRows: [j(1, 'x', 50, { Nom: 'Lyon' })], destRows: [{ id: 9, id_sync: '', Nom: 'Lyon' }], copyCols: [['Nom', 'Nom']],
    destTable: 'Dest', journalTable: 'J', matchCol: 'Nom', exchange: true });
  assert.deepEqual(matched.actions[0], ['BulkUpdateRecord', 'Dest', [9], { id_sync: ['x'], Nom: ['Lyon'], MajLe: [50] }], 'rattachement : MajLe aussi');
});

test('consolidation : clés parties d\'un seau effacées, sauf version plus récente à l\'heure de la SOURCE', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 10, done), j(3, 'c', 30), j(4, 'e', 5), gone(5, 20, ['b', 'c', 'e', 'x'], { Sync_Recu: 60 }, ['a'])];
  const destRows = [{ id: 1, id_sync: 'a' }, { id: 2, id_sync: 'b' }];
  const { actions, stats } = plan(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 0, removed: 1 }, 'c recréée après coup reste ; e, partie avant d\'être recopiée, n\'arrive pas');
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['c'] }, { Nom: ['n3'] }, { on_many: 'all' }],
    ['BulkRemoveRecord', 'Dest', [2]],
    marked([5, 3, 4], ['', 'ajout', '']),
    ['BulkUpdateRecord', 'J', [2], { Sync_Etat: ['suppression'], Sync_Recu: [60] }],
  ]);
});

test('consolidation : seule la liste la plus récente d\'un seau compte (filtre posé puis retiré)', () => {
  // b est sortie du filtre (liste de l'heure 20 sans elle, déjà appliquée), puis y revient : la
  // liste de l'heure 30 la cite, sa version (heure 5) est renvoyée. Une liste de l'heure 25 sans
  // elle, arrivée en retard, attend le même passage, avant ou après celle de l'heure 30.
  const base = [j(1, 'a', 10, done), j(2, 'b', 5, { ...done, Sync_Etat: 'suppression' }), gone(3, 20, ['b'], done, ['a'])];
  const old = id => gone(id, 25, ['b'], {}, ['a']);
  const back = id => gone(id, 30, ['b'], {}, ['a', 'b']);
  const destRows = [{ id: 1, id_sync: 'a', Nom: 'n1' }];
  for (const lists of [[old(4), back(5)], [back(4), old(5)]]) {
    const { actions, stats } = plan([...base, ...lists, j(6, 'b', 5)], destRows);
    assert.deepEqual(stats, { added: 1, updated: 0, removed: 0 }, 'b revient');
    assert.deepEqual(actions[0], ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b'] }, { Nom: ['n6'] }, { on_many: 'all' }]);
  }
  const { stats } = plan([...base, old(4), j(6, 'b', 5)], destRows);
  assert.equal(stats.added, 0, 'sans la liste plus récente, b reste partie');
  const parts = plan([...base, back(4), part(5, 1, 40, ['a'], true)], [...destRows, { id: 2, id_sync: 'b' }]);
  assert.equal(parts.stats.removed, 1, 'une liste complète plus récente l\'emporte sur un seau');
});

test('consolidation : liste complète en morceaux, appliquée une fois tous arrivés', () => {
  const base = [j(1, 'a', 10, done), j(2, 'b', 10, done), j(3, 'd', 50, done)];
  const destRows = [{ id: 1, id_sync: 'a' }, { id: 2, id_sync: 'b' }, { id: 3, id_sync: 'd' }];
  assert.deepEqual(plan([...base, part(4, 1, 40, ['a'], false)], destRows).actions, [], 'un morceau seul attend les autres');
  const { actions, stats } = plan([...base, part(4, 1, 40, ['a'], false), part(5, 2, 41, ['c'], true)], destRows);
  assert.equal(stats.removed, 1, 'b absente ; d, créée pendant le renvoi (heure 50), reste');
  assert.deepEqual(actions, [['BulkRemoveRecord', 'Dest', [2]], marked([4, 5], ['', '']), ['BulkUpdateRecord', 'J', [2], { Sync_Etat: ['suppression'], Sync_Recu: [null] }]]);
  const replaced = plan([...base, part(4, 1, 40, ['a'], false), part(5, 1, 60, ['a'], false, 'm2')], destRows);
  assert.deepEqual(replaced.actions, [marked([4], [''])], 'renvoi interrompu, repris sous une autre marque : l\'ancien morceau ne sert plus');
});

test('consolidation idempotente : rejouer après application ne fait rien', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 20, { Supprime: true, ...done }), list(3, ['a'], done)];
  assert.deepEqual(plan(journalRows, [{ id: 1, id_sync: 'a', Nom: 'n1' }]).actions, []);
});

test('colonne ajoutée à l\'export après coup : jamais sur une colonne de la destination', () => {
  const entry = { columns: [{ id: 'Nom' }], map: { Ville: 'Commune' } };
  assert.equal(newColumnsMap(entry, [{ id: 'Nom' }, { id: 'Ville' }], ['Nom', 'Commune']), null);
  assert.deepEqual(newColumnsMap(entry, [{ id: 'Nom' }, { id: 'Note' }, { id: 'Tel' }], ['Nom', 'Commune', 'Note', 'Note_2']),
    { Ville: 'Commune', Note: 'Note_3', Tel: 'Tel' });
});

test('CIBLE : destination renommée suivie par ses numéros Grist', () => {
  const schemaOf = (tableId, cols) => ({
    tableIdOf: ref => (ref === 7 ? tableId : null),
    table: id => (id === tableId ? { id: 7, tableId } : undefined),
    columns: id => (id === tableId ? cols : null),
  });
  const before = schemaOf('Contacts', [{ id: 70, colId: 'Nom' }, { id: 71, colId: 'Ville' }, { id: 72, colId: 'Code' }]);
  const entry = { table: 'Contacts', dest: 'Contacts', columns: [{ id: 'Nom' }, { id: 'Ville' }], map: { Cp: 'Code' }, match: 'Code' };
  const noted = { ...entry, refs: destRefs(before, 'Contacts') };
  assert.deepEqual(noted.refs, { table: 7, cols: { Nom: 70, Ville: 71, Code: 72 } });
  assert.equal(followRenames(noted, before), noted, 'rien de renommé : même entrée');
  const after = schemaOf('Personnes', [{ id: 70, colId: 'Nom' }, { id: 71, colId: 'Commune' }, { id: 72, colId: 'CodePostal' }]);
  const next = followRenames(noted, after);
  assert.equal(next.dest, 'Personnes');
  assert.deepEqual(next.map, { Cp: 'CodePostal', Ville: 'Commune' });
  assert.equal(next.match, 'CodePostal');
  assert.equal(followRenames({ ...entry, refs: { table: 9, cols: {} } }, before).dest, 'Contacts', 'table disparue : son nom noté');
  assert.equal(destRefs(before, 'Absente'), undefined);
});

// Cas limites.

test('consolidation : clés en double dans la destination, version supprimée d\'une clé inconnue', () => {
  const journalRows = [
    { id: 1, id_sync: 'a', MajLe: 5, Supprime: false, Nom: 'A2' },
    { id: 2, id_sync: 'z', MajLe: 5, Supprime: true, Nom: 'Z' },
  ];
  const destRows = [{ id: 10, id_sync: 'a', Nom: 'A' }, { id: 11, id_sync: 'a', Nom: 'A' }];
  const { actions, stats } = planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'D', journalTable: 'J' });
  assert.deepEqual(stats, { added: 0, updated: 1, removed: 0 });
  assert.deepEqual(actions[0], ['BulkAddOrUpdateRecord', 'D', { id_sync: ['a'] }, { Nom: ['A2'] }, { on_many: 'all' }], 'les deux lignes de la clé suivent');
  assert.deepEqual(actions[1][3].Sync_Etat, ['modif', ''], 'suppression d\'une clé jamais reçue : sans effet');
});

test('Échange : suppression plus ancienne que la ligne d\'ici sans effet, plus récente appliquée', () => {
  const destRows = [{ id: 10, id_sync: 'a', MajLe: 50, Nom: 'A' }];
  const run = order => planConsolidation({
    journalRows: [{ id: 1, id_sync: 'a', MajLe: order, Supprime: true, Nom: 'A' }], destRows, copyCols: [['Nom', 'Nom']], destTable: 'D', journalTable: 'J', exchange: true,
  });
  assert.deepEqual(run(40).stats, { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(run(60).stats, { added: 0, updated: 0, removed: 1 });
  const fresh = planConsolidation({ journalRows: [{ id: 1, id_sync: 'b', MajLe: null, Supprime: false, Nom: 'B' }], destRows, copyCols: [['Nom', 'Nom']], destTable: 'D', journalTable: 'J', exchange: true });
  assert.deepEqual(fresh.actions[0][3], { Nom: ['B'], MajLe: [null] }, 'ligne nouvelle sans date : ajoutée');
});
