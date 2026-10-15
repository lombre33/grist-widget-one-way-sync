// Outils communs : noms de tables, lignes, seaux de clés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketOf, chunk, crc32, freeTableId, isSafeId, toRows, toTableId } from '../../js/logic/common.js';
import { newColumnsMap } from '../../js/logic/consolidation.js';

test('toRows et chunk', () => {
  assert.deepEqual(toRows({ id: [1, 2], A: ['x', 'y'] }), [{ id: 1, A: 'x' }, { id: 2, A: 'y' }]);
  assert.deepEqual(toRows(null), []);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test('toTableId et freeTableId', () => {
  assert.equal(toTableId('journal des élèves'), 'Journal_des_eleves');
  assert.equal(toTableId('2024'), 'T_2024');
  assert.equal(toTableId('  '), 'Table');
  assert.equal(freeTableId('Journal_A', ['Journal_B']), 'Journal_A');
  assert.equal(freeTableId('Journal_A', ['Journal_A', 'Journal_A_2']), 'Journal_A_3');
});

test('seau d\'une clé : CRC-32 comme zlib.crc32 en Python, 256 seaux', () => {
  assert.equal(crc32('123456789'), 0xcbf43926, 'valeur de contrôle du CRC-32');
  assert.equal(crc32('été'), 0x44d16cd4, 'UTF-8, comme str.encode() en Python');
  assert.equal(bucketOf('123456789'), 0xcb);
  assert.ok([...Array(2000).keys()].every(i => bucketOf(`k${i}`) >= 0 && bucketOf(`k${i}`) < 256));
});

// Cas limites.

test('noms : identifiants Grist, conflits sans tenir compte des majuscules', () => {
  assert.equal(toTableId('Été 2026 / RH'), 'Ete_2026_RH');
  assert.equal(toTableId('___'), 'Table');
  assert.equal(toTableId(null, 'Export'), 'Export');
  assert.equal(toTableId('éà'), 'Ea');
  assert.equal(freeTableId('Journal_ANNUAIRE', ['Journal_Annuaire']), 'Journal_ANNUAIRE_2', 'Grist confondrait les deux');
  assert.equal(freeTableId('Note', ['note', 'NOTE_2']), 'Note_3');
  assert.deepEqual(newColumnsMap({ columns: [] }, [{ id: 'nom' }], ['Nom']), { nom: 'nom_2' }, 'une colonne nouvelle ne prend pas la place d\'une autre');
});

test('toRows : colonnes manquantes ou absentes', () => {
  assert.deepEqual(toRows({}), []);
  assert.deepEqual(toRows({ id: [] }), []);
  assert.deepEqual(toRows({ id: [1], A: [] }), [{ id: 1, A: undefined }]);
});

test('CRC-32 : texte accentué lu en UTF-8, comme zlib.crc32(texte.encode()) en Python', () => {
  assert.equal(crc32(''), 0);
  assert.equal(crc32('é'), 235179326);
});

test('identifiants sûrs : nom Grist, jamais une propriété des objets', () => {
  for (const ok of ['Contacts', 'id_sync', '_x', 'A1']) assert.ok(isSafeId(ok), ok);
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '1A', 'a b', 'Été', '', null, 5]) assert.ok(!isSafeId(bad), String(bad));
});
