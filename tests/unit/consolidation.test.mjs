// Recopie des versions reçues dans les tables de destination (CIBLE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WAVE, WAVE_STRICT, addedColumns, copyColumns, destRefs, droppedColumns, exchangeRules, followRenames, manualEdits, newColumnsMap, planConsolidation, receivedColumns,
  refusedGaps, restoreActions, rowNumbers,
} from '../../js/logic/consolidation.js';
import { j, plan, marked, list, done, gone, part, replaced } from './fixtures.mjs';

test('copyColumns ignore les colonnes techniques et les formules de la destination', () => {
  const journal = ['id_sync', 'MajLe', 'Supprime', 'Nom', 'Ville', 'Age', 'manualSort', 'gristHelper_X'];
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
    replaced([[5, { v: { Nom: null } }], [6, { n: 3 }]]),
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
    replaced([[2, { n: 2 }]]),
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
    replaced([[1, { v: { Nom: 'ici' } }], [3, { v: { Nom: 'ici' } }]]),
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
    marked([5, 3, 4], ['', 'ajout', 'partie']),
    ['BulkUpdateRecord', 'J', [2], { Sync_Etat: ['suppression'], Sync_Recu: [60] }],
    replaced([[2, { n: 2 }]]),
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
  assert.deepEqual(actions, [['BulkRemoveRecord', 'Dest', [2]], marked([4, 5], ['', '']), ['BulkUpdateRecord', 'J', [2], { Sync_Etat: ['suppression'], Sync_Recu: [null] }],
    replaced([[2, { n: 2 }]])]);
  const other = plan([...base, part(4, 1, 40, ['a'], false), part(5, 1, 60, ['a'], false, 'm2')], destRows);
  assert.deepEqual(other.actions, [marked([4], [''])], 'renvoi interrompu, repris sous une autre marque : l\'ancien morceau ne sert plus');
});

test('numéros de ligne : ordre de la table (manualSort), pas l\'id', () => {
  const destRows = [{ id: 1, id_sync: 'a', manualSort: 3 }, { id: 2, id_sync: 'b', manualSort: 1 }, { id: 3, id_sync: '', manualSort: 2 }, { id: 4, id_sync: 'd' }];
  assert.deepEqual([...rowNumbers(destRows)], [['b', 1], ['a', 3], ['d', 4]], 'une ligne sans clé compte dans la numérotation');
});

test('consolidation : une ligne rattachée note les valeurs qu\'elle remplace', () => {
  const { actions } = plan([j(1, 'a', 10, { Nom: 'Lyon' })], [{ id: 7, id_sync: '', Nom: 'Lyon' }, { id: 8, id_sync: 'z', Nom: 'x' }], 'Nom');
  assert.equal(actions.find(a => a[3] && a[3].Sync_Avant), undefined, 'rien de remplacé : rien de noté');
  const changed = planConsolidation({ journalRows: [j(1, 'a', 10, { Nom: 'Lyon', Tel: '02' })], destRows: [{ id: 7, id_sync: '', Nom: 'Lyon', Tel: '01' }],
    copyCols: [['Nom', 'Nom'], ['Tel', 'Tel']], destTable: 'Dest', journalTable: 'J', matchCol: 'Nom' });
  assert.deepEqual(changed.actions.at(-1), replaced([[1, { v: { Tel: '01' } }]]));
});

test('écarts : valeurs retouchées ici, par numéro de ligne ; rien en Échange', () => {
  const copyCols = [['Nom', 'Nom'], ['Ville', 'Commune']];
  const journalRows = [j(1, 'a', 10, { Ville: 'Lyon', ...done }), j(2, 'b', 10, { Ville: 'Nice', ...done }), j(3, 'b', 5, { Ville: 'ancienne', ...done }),
    j(4, 'c', 10, { Supprime: true, ...done }), j(5, 'e', 10, { Ville: null, Tags: ['x'], ...done })];
  const destRows = [{ id: 1, id_sync: 'b', manualSort: 2, Nom: 'n2', Commune: 'Nice' }, { id: 2, id_sync: 'a', manualSort: 1, Nom: 'Alice', Commune: 'Paris' },
    { id: 3, id_sync: 'c', manualSort: 3, Nom: 'x' }, { id: 4, id_sync: '', manualSort: 4, Nom: 'locale' }, { id: 5, id_sync: 'e', manualSort: 5, Nom: 'n5', Commune: '' }];
  const edits = manualEdits({ journalRows, destRows, copyCols });
  assert.deepEqual(edits.map(e => [e.key, e.n, e.cells]), [['a', 1, [['Nom', 'Nom', 'Alice', 'n1'], ['Ville', 'Commune', 'Paris', 'Lyon']]]],
    'b suit sa dernière version, c est supprimée, une ligne locale sans clé et un vide égal à vide ne comptent pas');
  assert.equal(edits[0].row.Nom, 'n1', 'la version reçue nomme la ligne');
  assert.deepEqual(manualEdits({ journalRows, destRows, copyCols, exchange: true }), []);
});

test('lignes effacées ici : signalées tant que la SOURCE les a ; une clé partie de la SOURCE est notée, plus signalée', () => {
  const copyCols = [['Nom', 'Nom']];
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 10, { ...done, Sync_Etat: 'suppression' }), j(3, 'c', 10, { ...done, Sync_Etat: 'partie' }),
    j(4, 'd', 10, { Supprime: true, ...done }), j(5, 'e', 10, done), j(6, 'f', 10, done)];
  const destRows = [{ id: 1, id_sync: 'f', Nom: 'n6' }];
  const edits = manualEdits({ journalRows, destRows, copyCols, except: new Set(['e']) });
  assert.deepEqual(edits.map(e => [e.key, e.gone, e.n]), [['a', true, null]], 'b, c, d parties de la SOURCE ; e partie à ce passage');
  assert.deepEqual(restoreActions(edits, 'Dest', copyCols), [['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['a'] }, { Nom: ['n1'] }, { on_many: 'all' }]],
    'Corriger fait revenir la ligne');
  // a, effacée ici, part ensuite de la SOURCE : la liste de son seau la note partie, sans rien effacer.
  const { actions, stats } = plan([...journalRows, gone(7, 20, ['a'], { Sync_Recu: 30 })], destRows);
  assert.equal(stats.removed, 0);
  assert.deepEqual(actions, [marked([7], ['']), ['BulkUpdateRecord', 'J', [1], { Sync_Etat: ['partie'] }]]);
  assert.deepEqual(plan([j(1, 'a', 10, { ...done, Sync_Etat: 'partie' }), gone(7, 20, ['a'])], destRows).actions, [marked([7], [''])], 'déjà notée : rien de plus');
});

test('colonnes effacées ici : notées, jamais une colonne nouvelle de l\'export ni la clé', () => {
  const sent = ['id_sync', 'MajLe', 'Nom', 'Ville', 'Tel', 'Note'].map(id => ({ id }));
  const entry = { map: { Ville: 'Commune' }, refs: { table: 1, cols: { id_sync: 1, Nom: 2, Commune: 3, Tel: 4 } } };
  assert.deepEqual(droppedColumns(entry, sent, ['Nom', 'Tel']), [['Ville', 'Commune']], 'Note, nouvelle, sera créée ; id_sync toujours recréée');
  assert.deepEqual(droppedColumns({ ...entry, refs: { cols: { Nom: 2 } }, dropped: ['Commune'] }, sent, ['Nom', 'Tel']), [['Ville', 'Commune']], 'déjà notée : le reste');
  assert.deepEqual(droppedColumns({ ...entry, dropped: ['Commune'] }, sent, ['Nom', 'Tel', 'Commune']), [], 'revenue');
  assert.deepEqual(droppedColumns({ ...entry, dropped: ['Commune'] }, sent.filter(c => c.id !== 'Ville'), ['Nom', 'Tel']), [], 'plus envoyée');
});

test('Corriger : les cellules retouchées reprennent la valeur de la SOURCE, et seulement elles', () => {
  const copyCols = [['Nom', 'Nom'], ['Ville', 'Commune'], ['Tags', 'Tags']];
  const journalRows = [j(1, 'a', 10, { Ville: 'Lyon', Tags: ['L', 'x'], ...done }), j(2, 'b', 10, { Ville: 'Nice', ...done }), j(3, 'c', 10, { Ville: 'Metz', ...done })];
  const destRows = [{ id: 7, id_sync: 'a', Nom: 'n1', Commune: 'Paris', Tags: ['L', 'y'] }, { id: 8, id_sync: 'b', Nom: 'n2', Commune: 'Nantes' },
    { id: 9, id_sync: 'c', Nom: 'n3', Commune: 'Metz' }];
  const actions = restoreActions(manualEdits({ journalRows, destRows, copyCols }), 'Dest', copyCols);
  assert.deepEqual(actions, [
    ['BulkUpdateRecord', 'Dest', [7], { Commune: ['Lyon'], Tags: [['L', 'x']] }],
    ['BulkUpdateRecord', 'Dest', [8], { Commune: ['Nice'] }],
  ]);
  const fixed = destRows.map(r => ({ ...r, ...(r.id === 7 ? { Commune: 'Lyon', Tags: ['L', 'x'] } : r.id === 8 ? { Commune: 'Nice' } : {}) }));
  assert.deepEqual(manualEdits({ journalRows, destRows: fixed, copyCols }), [], 'plus rien à corriger');
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

test('colonne ajoutée à l\'export : notée pour l\'historique sous son nom d\'ici, une seule fois', () => {
  const entry = { columns: [{ id: 'Nom' }], map: { Ville: 'Commune' } };
  const next = { Ville: 'Commune', Note: 'Note_3', Tel: 'Tel' };
  assert.deepEqual(addedColumns(entry, next, 50), [{ col: 'Note_3', at: 50 }, { col: 'Tel', at: 50 }]);
  const later = { ...entry, map: next, addedCols: addedColumns(entry, next, 50) };
  assert.deepEqual(addedColumns(later, { ...next, Mail: 'Mail' }, 60).map(a => a.col), ['Note_3', 'Tel', 'Mail'], 'les précédentes restent');
  assert.equal(addedColumns({}, { Nom: 'Nom' }, 50), undefined, 'ancien montage sans colonnes connues : rien de noté');
  const many = Array.from({ length: 12 }, (_, i) => [`C${i}`, `C${i}`]);
  assert.equal(addedColumns(entry, Object.fromEntries(many), 70).length, 10, 'les dix dernières seulement');
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
  assert.deepEqual(actions[1][3].Sync_Etat, ['modif', 'partie'], 'suppression d\'une clé jamais reçue : sans effet, notée partie');
});

test('Échange à plusieurs, chez A : une ligne cochée Supprime reste ici, cochée, pour repartir vers les autres', () => {
  const hub = (journalRows, destRows) => planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', exchange: true, hub: true });
  const destRows = [{ id: 1, id_sync: 'a', Nom: 'A', MajLe: 20, Supprime: false }, { id: 2, id_sync: 'b', Nom: 'B', MajLe: 20, Supprime: true }];
  const deleted = hub([j(1, 'a', 30, { Nom: 'A', Supprime: true }), j(2, 'x', 30, { Supprime: true })], destRows);
  assert.deepEqual(deleted.stats, { added: 0, updated: 0, removed: 1 });
  assert.deepEqual(deleted.actions.slice(0, 2), [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['a'] }, { Nom: ['A'], Supprime: [true], MajLe: [30] }, { on_many: 'all' }],
    marked([1, 2], ['suppression', 'partie']),
  ], 'rien n\'est effacé ici ; une clé inconnue ici reste sans effet');
  assert.deepEqual(hub([j(1, 'b', 30, { Nom: 'B', Supprime: true })], destRows).actions, [marked([1], [''])], 'déjà cochée : sans effet');
  const back = hub([j(1, 'b', 40, { Nom: 'B', Supprime: false })], destRows);
  assert.deepEqual(back.actions[0], ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b'] }, { Nom: ['B'], Supprime: [false], MajLe: [40] }, { on_many: 'all' }],
    'décochée par un participant : décochée ici, et repart');
  assert.deepEqual(planConsolidation({ journalRows: [j(1, 'a', 30, { Nom: 'A', Supprime: true })], destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', hub: true }).stats,
    { added: 0, updated: 0, removed: 1 }, 'hors Échange, la marque est sans objet : la ligne est effacée');
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

// ---------------------------------------------------------------------------------------------
// Échange administré ici : règles pour les changements des participants

test('exchangeRules : tout accepté rend null ; règles et refus lus, valeurs inconnues ramenées au défaut', () => {
  assert.equal(exchangeRules(undefined), null);
  assert.equal(exchangeRules({ regles: { ajout: 'accepter' }, refus: 'signaler' }), null);
  assert.deepEqual(exchangeRules({ regles: { modif: 'valider' } }), { ajout: 'accepter', modif: 'valider', suppression: 'accepter', refus: 'corriger' });
  assert.deepEqual(exchangeRules({ regles: { ajout: 'toString', suppression: 'refuser' }, refus: 'signaler' }),
    { ajout: 'accepter', modif: 'accepter', suppression: 'refuser', refus: 'signaler' });
});

const hubDest = () => [{ id: 10, id_sync: 'a', Nom: 'A', MajLe: 20, Supprime: false, manualSort: 1 }, { id: 11, id_sync: 'b', Nom: 'B', MajLe: 20, Supprime: false, manualSort: 2 }];
const proposals = () => [j(1, 'a', 30, { Nom: 'A2' }), j(2, 'x', 30, { Nom: 'X' }), j(3, 'b', 30, { Nom: 'B', Supprime: true })];
const ruledArgs = rule => ({
  journalRows: proposals(), destRows: hubDest(), copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', exchange: true, deleteCol: true,
  rules: { ajout: rule, modif: rule, suppression: rule, refus: 'corriger' },
});
const ruled = (rule, extra = {}) => planConsolidation({ ...ruledArgs(rule), ...extra });

test('Échange administré ici : un changement à valider attend, sans marque ni écriture ; la décision l\'applique', () => {
  const waiting = ruled('valider');
  assert.deepEqual(waiting.actions, [], 'rien n\'est écrit, rien n\'est marqué');
  assert.deepEqual(waiting.pending.map(p => [p.id, p.key, p.state, p.n, p.cells]), [
    [1, 'a', 'modif', 1, [['Nom', 'Nom', 'A', 'A2']]],
    [2, 'x', 'ajout', null, [['Nom', 'Nom', null, 'X']]],
    [3, 'b', 'suppression', 2, [['Nom', 'Nom', 'B', null]]],
  ]);
  const accepted = ruled('valider', { decisions: new Map([[1, 'accepter'], [3, 'refuser']]) });
  assert.deepEqual(accepted.stats, { added: 0, updated: 1, removed: 0 });
  assert.deepEqual(accepted.actions[0], ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['a'] }, { Nom: ['A2'], Supprime: [false], MajLe: [30] }, { on_many: 'all' }]);
  assert.deepEqual(accepted.actions[1], marked([1, 3], ['modif', 'refus']));
  assert.deepEqual(accepted.pending.map(p => p.id), [2], 'l\'ajout attend toujours');
  const older = planConsolidation({ journalRows: [j(1, 'a', 10, { Nom: 'vieux' })], destRows: hubDest(), copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J',
    exchange: true, rules: { ajout: 'valider', modif: 'valider', suppression: 'valider', refus: 'corriger' } });
  assert.deepEqual([older.pending, older.actions], [[], [marked([1], [''])]], 'plus ancienne que la ligne d\'ici : sans effet, rien à valider');
});

test('Échange administré ici : un refus corrigé fait repartir la ligne d\'ici, datée juste après ; un ajout refusé y reste coché Supprime', () => {
  const refused = ruled('refuser');
  assert.deepEqual(refused.stats, { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(refused.actions, [
    marked([1, 2, 3], ['refus', 'refus', 'refus']),
    replaced([[1, { v: { Nom: 'A' }, k: 'modif' }], [2, { k: 'ajout' }], [3, { k: 'suppression' }]]),
  ], 'rien n\'est recopié ; le refus est noté pour l\'historique');
  assert.deepEqual(refused.fix.keys, ['a', 'x', 'b']);
  assert.deepEqual(refused.fix.actions, [
    ['BulkUpdateRecord', 'Dest', [10, 11], { MajLe: [30 + 0.001, 30 + 0.001] }],
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['x'] }, { Nom: ['X'], Supprime: [true], MajLe: [30 + 0.001] }, { on_many: 'all' }],
  ]);
  const flagged = ruled('refuser', { rules: { ajout: 'refuser', modif: 'refuser', suppression: 'refuser', refus: 'signaler' } });
  assert.deepEqual([flagged.fix.actions, flagged.fix.keys], [[], []], 'écart signalé : rien ne repart');
  assert.deepEqual(flagged.actions[0], marked([1, 2, 3], ['refus', 'refus', 'refus']));
});

test('Échange : une version plus récente, non cochée, fait revenir une ligne cochée Supprime ici (suppression refusée)', () => {
  const destRows = [{ id: 1, id_sync: 'a', Nom: 'A', MajLe: 30, Supprime: true }];
  const run = deleteCol => planConsolidation({ journalRows: [j(1, 'a', 30 + 0.001, { Nom: 'A' })], destRows, copyCols: [['Nom', 'Nom']], destTable: 'D', journalTable: 'J', exchange: true, deleteCol });
  assert.deepEqual(run(true).actions[0], ['BulkAddOrUpdateRecord', 'D', { id_sync: ['a'] }, { Nom: ['A'], Supprime: [false], MajLe: [30 + 0.001] }, { on_many: 'all' }]);
  assert.deepEqual(run(false).stats, { added: 0, updated: 0, removed: 0 }, 'sans case Supprime ici, rien à décocher');
});

test('refusedGaps : une ligne refusée reste signalée jusqu\'à sa prochaine modification ici ; un refus corrigé n\'en laisse pas', () => {
  const refusedRow = (id, key, extra) => j(id, key, 30, { Sync_Applique: true, Sync_Etat: 'refus', ...extra });
  const journalRows = [
    refusedRow(1, 'a', { Nom: 'A2', Sync_Avant: JSON.stringify({ v: { Nom: 'A' }, k: 'modif' }) }),
    refusedRow(2, 'x', { Nom: 'X', Sync_Avant: JSON.stringify({ k: 'ajout' }) }),
    refusedRow(3, 'b', { Nom: 'B', Supprime: true, Sync_Avant: JSON.stringify({ k: 'suppression' }) }),
    j(4, 'c', 30, { Sync_Applique: true, Sync_Etat: 'modif' }),
  ];
  const destRows = [...hubDest(), { id: 12, id_sync: 'c', Nom: 'n4', MajLe: 30, manualSort: 3 }];
  const gaps = refusedGaps({ journalRows, destRows, copyCols: [['Nom', 'Nom']] });
  assert.deepEqual(gaps.map(g => [g.key, g.n, g.state, g.cells]), [
    ['a', 1, 'modif', [['Nom', 'Nom', 'A', 'A2']]],
    ['b', 2, 'suppression', []],
    ['x', null, 'ajout', [['Nom', 'Nom', null, 'X']]],
  ]);
  const later = destRows.map(r => (r.id_sync === 'a' ? { ...r, MajLe: 40 } : r));
  assert.deepEqual(refusedGaps({ journalRows, destRows: later, copyCols: [['Nom', 'Nom']] }).map(g => g.key), ['b', 'x'], 'modifiée ici depuis : plus d\'écart');
  const fixed = destRows.map(r => ({ ...r, MajLe: 30 + 0.001 }));
  assert.deepEqual(refusedGaps({ journalRows, destRows: fixed, copyCols: [['Nom', 'Nom']] }).map(g => g.key), ['x'], 'refus corrigé : la ligne d\'ici est datée après');
});

test('vague de suppressions : retenue au-delà de 10 lignes et de 20 % ; Appliquer efface, Ignorer détache', () => {
  const keys = Array.from({ length: 40 }, (_, i) => `k${i}`);
  const kept = keys.slice(0, 28);
  const journalRows = [...keys.map((k, i) => j(i + 1, k, 10, done)), list(100, kept, { Sync_Recu: 50 }), j(101, 'k39', 20, { Supprime: true })];
  const destRows = keys.map((k, i) => ({ id: i + 1, id_sync: k, manualSort: i + 1, Nom: `n${i + 1}` }));
  const run = (options = {}) => planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', hold: WAVE, ...options });
  // 12 lignes parties (11 par la liste, 1 cochée Supprime) sur 40 : 30 %.
  const held = run();
  assert.deepEqual(held.held, { n: 12, numbers: [29, 30, 31, 32, 33, 34, 35, 36, 37, 38] });
  assert.equal(held.stats.removed, 0);
  assert.deepEqual(held.actions, [], 'rien d\'effacé ni de noté : la liste et la version attendent la décision');
  const applied = run({ wave: 'appliquer' });
  assert.equal(applied.held, null);
  assert.equal(applied.stats.removed, 12);
  assert.deepEqual(applied.actions.find(a => a[0] === 'BulkRemoveRecord'), ['BulkRemoveRecord', 'Dest', keys.slice(28).map((k, i) => i + 29)]);
  const ignored = run({ wave: 'ignorer' });
  assert.equal(ignored.held, null);
  assert.equal(ignored.stats.removed, 0);
  assert.ok(!ignored.actions.some(a => a[0] === 'BulkRemoveRecord'));
  assert.deepEqual(ignored.actions.find(a => a[1] === 'Dest'), ['BulkUpdateRecord', 'Dest', keys.slice(28).map((k, i) => i + 29), { id_sync: keys.slice(28).map(() => '') }],
    'les lignes restent ici, sans clé : plus rien ne les suit');
  assert.deepEqual(ignored.actions.find(a => a[1] === 'J' && a[3].Sync_Applique), marked([100, 101], ['', 'partie']));
  assert.deepEqual(ignored.actions.find(a => a[1] === 'J' && !a[3].Sync_Applique), ['BulkUpdateRecord', 'J', keys.slice(28, 39).map((k, i) => i + 29), { Sync_Etat: keys.slice(28, 39).map(() => 'partie') }]);
  // Sous les seuils : appliquée sans attendre.
  const few = planConsolidation({ journalRows: [...journalRows.slice(0, 40), list(100, keys.slice(0, 35))], destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', hold: WAVE });
  assert.equal(few.held, null);
  assert.equal(few.stats.removed, 5);
  // Sécurité renforcée : dès une ligne.
  const one = planConsolidation({ journalRows: [...journalRows.slice(0, 40), list(100, keys.slice(0, 39))], destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', hold: WAVE_STRICT });
  assert.deepEqual(one.held, { n: 1, numbers: [40] });
  assert.equal(plan(journalRows, destRows).held, null, 'sans seuil (Échange) : rien n\'est retenu');
});

test('archive : rien n\'est effacé, les lignes parties restent cochées ; plus suivies ensuite, décochées si elles reviennent', () => {
  const run = (journalRows, destRows, options = {}) => planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', archive: true, hold: WAVE_STRICT, ...options });
  const versions = ['a', 'b', 'c', 'd'].map((k, i) => j(i + 1, k, 10, done));
  const destRows = versions.map(v => ({ id: v.id, id_sync: v.id_sync, manualSort: v.id, Nom: v.Nom, Supprimee_a_la_source: false }));
  const first = run([...versions, list(10, ['a', 'd'], { Sync_Recu: 50 }), j(11, 'd', 20, { Supprime: true })], destRows);
  assert.equal(first.held, null, 'aucune vague : rien n\'est effacé');
  assert.equal(first.stats.removed, 3);
  assert.ok(!first.actions.some(a => a[0] === 'BulkRemoveRecord'));
  assert.deepEqual(first.actions[0], ['BulkUpdateRecord', 'Dest', [2, 3, 4], { Supprimee_a_la_source: [true, true, true] }]);
  // Passage suivant : les lignes gardées ne sont plus suivies par les listes.
  const settledRows = [...versions.map(v => (v.id === 2 || v.id === 3 ? { ...v, Sync_Etat: 'suppression' } : v)), { ...list(10, ['a', 'd']), ...done }, j(11, 'd', 20, { Supprime: true, ...done, Sync_Etat: 'suppression' })];
  const archived = destRows.map(r => (r.id === 1 ? r : { ...r, Supprimee_a_la_source: true }));
  const again = run([...settledRows, list(12, ['a'], { Sync_Recu: 60 })], archived);
  assert.deepEqual(again.actions, [marked([12], [''])]);
  assert.deepEqual(again.stats, { added: 0, updated: 0, removed: 0 });
  // Une nouvelle version de la clé (même valeurs) fait revenir la ligne.
  const back = run([...settledRows, j(13, 'b', 30, { Nom: 'n2' })], archived);
  assert.deepEqual(back.actions[0], ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b'] }, { Nom: ['n2'], Supprimee_a_la_source: [false] }, { on_many: 'all' }]);
  assert.deepEqual(back.stats, { added: 0, updated: 1, removed: 0 });
  // Une ligne gardée en archive n'est pas une retouche, même modifiée ici.
  const edited = archived.map(r => (r.id === 3 ? { ...r, Nom: 'retouche' } : r));
  assert.deepEqual(manualEdits({ journalRows: settledRows, destRows: edited, copyCols: [['Nom', 'Nom']] }), []);
  // Sans archive, les mêmes versions effacent.
  assert.deepEqual(run([...versions, list(10, ['a', 'd'], { Sync_Recu: 50 })], destRows, { archive: false, hold: null }).actions[0], ['BulkRemoveRecord', 'Dest', [2, 3]]);
  // Archive décochée plus tard : les lignes déjà archivées restent, cochées (jamais effacées sans le dire).
  const off = run([...settledRows, list(12, ['a'], { Sync_Recu: 60 })], archived, { archive: false, hold: null });
  assert.deepEqual(off.actions, [marked([12], [''])]);
  assert.equal(off.stats.removed, 0);
  const offBack = run([...settledRows, j(13, 'b', 30, { Nom: 'n2' })], archived, { archive: false, hold: null });
  assert.deepEqual(offBack.actions[0], ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b'] }, { Nom: ['n2'], Supprimee_a_la_source: [false] }, { on_many: 'all' }], 'une clé revenue décoche la ligne');
  // Une ligne partie après l'arrêt de l'archive est effacée, l'archivée reste.
  const mixed = run([...versions, list(14, ['a', 'c'], { Sync_Recu: 70 })], destRows.map(r => ({ ...r, Supprimee_a_la_source: r.id === 2 })), { archive: false, hold: null });
  assert.deepEqual(mixed.actions[0], ['BulkRemoveRecord', 'Dest', [4]]);
  assert.equal(mixed.stats.removed, 1);
});

test('colonnes reçues : une colonne nouvelle prend un nom libre et est notée ; en Échange, seules les colonnes envoyées d\'ici', () => {
  assert.deepEqual(newColumnsMap({ columns: [] }, [{ id: 'nom' }], ['Nom']), { nom: 'nom_2' }, 'une colonne nouvelle ne prend pas la place d\'une autre');
  const schema = { columns: () => [{ colId: 'Nom' }, { colId: 'Note' }, { colId: 'id_sync' }] };
  const described = cols => [{ id: 1, Synchro_Colonnes: JSON.stringify(cols) }];
  const entry = { table: 'Contacts', dest: 'Contacts', columns: [{ id: 'Nom', type: 'Text' }], map: {} };
  const same = receivedColumns(entry, described([{ id: 'Nom', type: 'Text' }]), schema, null, 100);
  assert.deepEqual([same.sent.map(c => c.id), same.entry], [['Nom'], entry], 'rien de nouveau : l\'entrée ne change pas');
  const more = receivedColumns(entry, described([{ id: 'Nom', type: 'Text' }, { id: 'Note', type: 'Text' }]), schema, null, 100);
  assert.deepEqual(more.entry.map, { Note: 'Note_2' }, 'la colonne Note d\'ici n\'est pas écrasée');
  assert.deepEqual(more.entry.addedCols, [{ col: 'Note_2', at: 100 }]);
  assert.deepEqual(receivedColumns(entry, [], schema, null, 100).sent, entry.columns, 'sans description reçue : celles de l\'invitation');
  const swap = receivedColumns(entry, described([{ id: 'Nom', type: 'Text' }, { id: 'Secret', type: 'Text' }]), schema, new Set(['Nom']), 100);
  assert.deepEqual(swap.sent.map(c => c.id), ['Nom'], 'Échange : une colonne que cet export n\'envoie pas est écartée');
});
