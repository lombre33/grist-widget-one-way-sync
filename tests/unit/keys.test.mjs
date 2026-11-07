// Clés id_sync des lignes d'une table envoyée : comptées sans rien lire d'autre, réparées sans toucher aux données.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyCountSql, keyCounts, keyProblems, repairActions } from '../../js/engine/logic/keys.js';

test('keyCountSql : une requête de comptage, et rien pour un nom de table douteux', () => {
  assert.match(keyCountSql('Contacts'), /^select count\(\*\) as n, .* from "Contacts"$/);
  assert.equal(keyCountSql('a"; drop table x; --'), null);
  assert.equal(keyCountSql('constructor'), null);
});

test('keyCounts : lignes sans clé et lignes en trop qui partagent une clé', () => {
  assert.equal(keyCounts({ n: 100, blank: 0, keys: 100 }), null, 'en règle : rien à dire');
  assert.deepEqual(keyCounts({ n: 2005, blank: 10, keys: 1985 }), { rows: 2005, blank: 10, dup: 10 });
  assert.deepEqual(keyCounts({ n: 5, blank: 5, keys: 0 }), { rows: 5, blank: 5, dup: 0 });
  assert.equal(keyCounts(undefined), null);
});

test('keyProblems : la plus ancienne ligne d\'un groupe garde sa clé', () => {
  const rows = [
    { id: 1, id_sync: 'a' }, { id: 2, id_sync: 'b' }, { id: 3, id_sync: 'a' }, { id: 4, id_sync: '' }, { id: 5, id_sync: null },
    { id: 7, id_sync: 'b' }, { id: 6, id_sync: 'b' }, { id: 8, id_sync: ' ' }, { id: 9, id_sync: 'c' },
  ];
  const p = keyProblems(rows);
  assert.deepEqual(p.blank, [4, 5, 8]);
  assert.deepEqual(p.dup.sort(), [3, 6, 7]);
  assert.deepEqual(p.keep.sort(), [1, 2]);
  assert.deepEqual(p.touch.sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(keyProblems([{ id: 1, id_sync: 'a' }, { id: 2, id_sync: 'b' }]).touch, []);
});

test('repairActions : clé neuve et heure de modification pour les lignes réparées, heure seule pour celles qui gardent leur clé', () => {
  let n = 0;
  const actions = repairActions('Contacts', { blank: [4], dup: [3, 6], keep: [1] }, { newId: () => `k${++n}`, now: 1700000000, order: 'MajLe' });
  assert.deepEqual(actions, [
    ['BulkUpdateRecord', 'Contacts', [4, 3, 6], { id_sync: ['k1', 'k2', 'k3'], MajLe: [1700000000, 1700000000, 1700000000] }],
    ['BulkUpdateRecord', 'Contacts', [1], { MajLe: [1700000000] }],
  ]);
  const many = repairActions('T', { blank: Array.from({ length: 1200 }, (_, i) => i + 1), dup: [], keep: [] }, { newId: () => 'k', now: 1, order: 'MajLe' });
  assert.equal(many.length, 3, 'écritures par paquets de 500');
  assert.deepEqual(repairActions('T', { blank: [], dup: [], keep: [] }, { newId: () => 'k', now: 1, order: 'MajLe' }), []);
});
