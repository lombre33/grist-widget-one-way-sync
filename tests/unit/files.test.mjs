// Pièces jointes : liste des fichiers, suivi des envois (SOURCE), morceaux, réception, cellules (CIBLE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILE_MAX, PART_BYTES, encodeParts, fileArrivals, fileList, fileSends, fillActions, filesState, forgetHooks, joinParts, neededFiles, partRow, readPart, readTracking,
  recordSent, resolveCell, resolveRows, sha1, shaOf, short, trackingNote,
} from '../../js/logic/files.js';
import { EXPORT } from './fixtures.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const info = (id, size = 10) => ({ id, name: `f${id}.pdf`, size });

test('SOURCE : fichiers d\'un export lus dans ses listes, empreinte SHA-1 du fileIdent', () => {
  assert.equal(shaOf(`${A}.pdf`), A);
  assert.equal(shaOf(A), A);
  assert.equal(shaOf('abc.pdf'), null);
  assert.equal(shaOf(null), null);
  const rows = [
    { Synchro_Lot: JSON.stringify({ [`${A}.pdf`]: [3, 'devis.pdf', 1200], [`${B}.png`]: [4, 'photo.png', 99], 'pas-une-empreinte': [5, 'x', 1], [`${C}.txt`]: ['6', 'x', 1] }) },
    { Synchro_Lot: '' }, { Synchro_Lot: '[1]' }, { Synchro_Lot: JSON.stringify({ [`${A}.PDF`]: [7, 'devis (copie).pdf', 1200] }) },
  ];
  assert.deepEqual([...neededFiles(rows)], [[A, { id: 7, name: 'devis (copie).pdf', size: 1200 }], [B, { id: 4, name: 'photo.png', size: 99 }]]);
});

test('SOURCE : suivi des envois, une fois par destinataire, noté sans grandir avec leur nombre', () => {
  const needed = new Map([[A, info(1)], [B, info(2)]]);
  // Premier destinataire : il reçoit tout.
  let { tracking, sends } = fileSends(readTracking(undefined), needed, ['h1'], ['h1']);
  assert.deepEqual(sends, [{ sha: A, hooks: ['h1'] }, { sha: B, hooks: ['h1'] }]);
  tracking = recordSent(tracking, A, ['h1']);
  tracking = recordSent(tracking, B, ['h1']);
  assert.deepEqual(trackingNote(tracking), { f: `${short(A)} ${short(B)}`, h: ['h1'], p: {} });
  assert.deepEqual(fileSends(readTracking(trackingNote(tracking)), needed, ['h1'], ['h1']).sends, [], 'déjà reçu : rien ne repart');
  // Un second destinataire (h2) reçoit l'existant ; un fichier nouveau (C) va à tous ; h3, en
  // pause, ne reçoit rien.
  needed.set(C, info(3));
  ({ tracking, sends } = fileSends(tracking, needed, ['h1', 'h2', 'h3'], ['h1', 'h2']));
  assert.deepEqual(sends, [{ sha: A, hooks: ['h2'] }, { sha: B, hooks: ['h2'] }, { sha: C, hooks: ['h1', 'h2'] }]);
  for (const s of sends) tracking = recordSent(tracking, s.sha, s.hooks);
  assert.deepEqual(trackingNote(tracking), { f: [A, B, C].map(short).join(' '), h: ['h1', 'h2'], p: { h3: '' } });
  // h3 repris : il reçoit tout ; h2 en échec quand un fichier arrive : il le recevra ensuite, et
  // garde ce qu'il avait.
  const D = 'd'.repeat(40);
  needed.set(D, info(4));
  ({ tracking, sends } = fileSends(tracking, needed, ['h1', 'h2', 'h3'], ['h1', 'h3']));
  assert.deepEqual(sends.find(s => s.sha === D), { sha: D, hooks: ['h1', 'h3'] });
  assert.deepEqual(sends.filter(s => s.sha !== D).map(s => s.hooks), [['h3'], ['h3'], ['h3']]);
  tracking = recordSent(tracking, D, ['h1', 'h3']);
  assert.deepEqual(trackingNote(tracking).p, { h2: [A, B, C].map(short).sort().join(' '), h3: short(D) });
  ({ sends } = fileSends(tracking, needed, ['h1', 'h2', 'h3'], ['h1', 'h2', 'h3']));
  assert.deepEqual(sends.map(s => [s.sha, s.hooks]), [[A, ['h3']], [B, ['h3']], [C, ['h3']], [D, ['h2']]]);
  // Fichier retiré, destinataire révoqué : oubliés.
  needed.delete(A);
  ({ tracking } = fileSends(tracking, needed, ['h1', 'h3'], ['h1', 'h3']));
  assert.deepEqual(trackingNote(tracking), { f: [B, C, D].map(short).join(' '), h: ['h1'], p: { h3: short(D) } });
  // Trop gros : ne part pas, n'est pas suivi.
  needed.set(A, info(1, FILE_MAX + 1));
  assert.ok(!fileSends(tracking, needed, ['h1'], ['h1']).sends.some(s => s.sha === A));
  // « Tout renvoyer » : chacun reçoit tout de nouveau.
  assert.deepEqual(fileSends(forgetHooks(tracking), needed, ['h1'], ['h1']).sends.map(s => s.sha), [B, C, D]);
  // Sans destinataire servi, un fichier nouveau est seulement noté ; un destinataire arrivé ensuite le reçoit.
  ({ tracking, sends } = fileSends(readTracking(null), new Map([[A, info(1)]]), [], []));
  assert.deepEqual(sends, [{ sha: A, hooks: [] }]);
  tracking = recordSent(tracking, A, []);
  assert.deepEqual(fileSends(tracking, new Map([[A, info(1)]]), ['h9'], ['h9']).sends, [{ sha: A, hooks: ['h9'] }]);
  assert.deepEqual(readTracking({ f: 'zz abc', h: 'h1', p: [] }), { f: new Set(), h: new Set(), p: new Map() }, 'note abîmée : rien de reçu');
});

test('morceaux : base64 de 512 Ko au plus, rassemblés à l\'identique', async () => {
  const bytes = Uint8Array.from({ length: PART_BYTES * 2 + 5 }, (_, i) => (i * 7) % 256);
  const parts = encodeParts(bytes);
  assert.equal(parts.length, 3);
  assert.ok(parts.every(p => p.length <= 700000));
  assert.deepEqual(joinParts(parts), bytes);
  assert.deepEqual(encodeParts(new Uint8Array(0)), [''], 'un fichier vide part en un morceau vide');
  assert.equal(await sha1(new TextEncoder().encode('abc')), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  const row = partRow(EXPORT, { sha: A, name: 'a.pdf', size: 3 }, '0a1b2c3d', 0, 1, 'YWJj');
  assert.deepEqual(row, { Synchro_Export: EXPORT, Synchro_Type: 'fichier', Synchro_Colonnes: `{"sha":"${A}","nom":"a.pdf","taille":3,"n":0,"parts":1,"envoi":"0a1b2c3d"}`, Synchro_Lot: 'YWJj' });
});

test('CIBLE : un morceau ne vient que de la SOURCE de l\'export, bien formé', () => {
  const ok = { id: 1, ...partRow(EXPORT, { sha: A, name: '../a\u0000.pdf', size: 3 }, '0a1b2c3d', 0, 1, 'YWJj') };
  assert.deepEqual(readPart(ok, EXPORT), { sha: A, name: '.._a_.pdf', size: 3, n: 0, parts: 1, send: '0a1b2c3d', data: 'YWJj' });
  const meta = change => ({ ...ok, Synchro_Colonnes: JSON.stringify({ ...JSON.parse(ok.Synchro_Colonnes), ...change }) });
  for (const [row, why] of [
    [ok, 'autre export'], [meta({ sha: 'x' }), 'empreinte'], [meta({ n: 1 }), 'rang'], [meta({ parts: 99 }), 'trop de morceaux'],
    [meta({ taille: FILE_MAX + 1 }), 'trop gros'], [meta({ envoi: 'zz' }), 'envoi'], [meta({ nom: 3 }), 'nom'], [{ ...ok, Synchro_Lot: 'pas du base64 !' }, 'contenu'],
    [{ ...ok, Synchro_Colonnes: 'null' }, 'description'], [{ ...ok, Synchro_Type: 'lot' }, 'type'],
  ]) assert.equal(readPart(row, why === 'autre export' ? '1111111111111111' : EXPORT), null, why);
});

test('CIBLE : fichier arrivé en entier, envoi remplacé, envoi abandonné, lignes illisibles', () => {
  const part = (id, sha, send, n, parts, at = 1000) => ({ id, Sync_Recu: at, ...partRow(EXPORT, { sha, name: 'f.bin', size: 6 }, send, n, parts, n ? 'ZGVm' : 'YWJj') });
  const rows = [
    part(1, A, '00000001', 1, 2), part(2, A, '00000001', 0, 2), // A : complet, dans le désordre
    part(3, B, '00000001', 0, 2), part(4, B, '00000002', 0, 2), // B : le premier envoi est remplacé, le second attend
    part(5, C, '00000003', 0, 2, 0), // C : incomplet depuis plus d'un jour
    { id: 6, Synchro_Type: 'fichier', Synchro_Export: EXPORT, Synchro_Colonnes: '{}' },
    { id: 7, Synchro_Type: 'lot' },
  ];
  const { ready, stale, rejected } = fileArrivals(rows, EXPORT, 1000 + 3600);
  assert.deepEqual(ready.map(f => [f.sha, f.data, f.ids]), [[A, ['YWJj', 'ZGVm'], [1, 2]]]);
  assert.deepEqual(new TextDecoder().decode(joinParts(ready[0].data)), 'abcdef');
  assert.deepEqual(stale, [3]);
  assert.deepEqual(rejected, [6]);
  assert.deepEqual(fileArrivals(rows, EXPORT, 1000 + 90000).stale.sort(), [3, 4, 5]);
});

test('CIBLE : cellules résolues avec les fichiers présents, attendus, trop gros', () => {
  const cell = ['L', [`${A}.pdf`, 'a.pdf', 10], [`${B}.png`, 'b.png', 20]];
  const present = new Map([[A, 11]]);
  assert.deepEqual(fileList(cell), [{ sha: A, name: 'a.pdf', size: 10 }, { sha: B, name: 'b.png', size: 20 }]);
  assert.deepEqual(resolveCell(cell, present), ['L', 11]);
  assert.deepEqual(resolveCell(cell, new Map([[A, 11], [B, 12]])), ['L', 11, 12]);
  assert.equal(resolveCell(cell, new Map()), null);
  assert.equal(resolveCell(null, present), null);
  const rows = [
    { id: 1, id_sync: 'k1', MajLe: 1, Photo: cell, Nom: 'x' },
    { id: 2, id_sync: 'k2', MajLe: 1, Photo: ['L', [`${C}.zip`, 'gros.zip', FILE_MAX + 1]] },
    { id: 3, id_sync: 'k3', MajLe: 1, Photo: ['L', ['d'.repeat(40), 'd', 1]], Supprime: true },
    { id: 4, id_sync: 'k4', MajLe: 0, Photo: ['L', ['e'.repeat(40), 'e', 1]] }, { id: 5, id_sync: 'k4', MajLe: 2, Photo: null },
  ];
  assert.deepEqual(resolveRows(rows, ['Photo'], present).map(r => r.Photo), [['L', 11], null, null, null, null]);
  assert.equal(resolveRows(rows, [], present), rows);
  assert.deepEqual(filesState(rows, ['Photo'], present), { waiting: [B], big: [{ sha: C, name: 'gros.zip', size: FILE_MAX + 1 }] },
    'dernière version seulement, suppressions exclues');
});

test('CIBLE : un fichier arrivé complète les cellules restées telles que la recopie les a laissées', () => {
  const cell = ['L', [`${A}.pdf`, 'a.pdf', 10], [`${B}.png`, 'b.png', 20]];
  const journalRows = [
    { id: 1, id_sync: 'k1', MajLe: 1, Photo: cell, Sync_Applique: true },
    { id: 2, id_sync: 'k2', MajLe: 1, Photo: cell, Sync_Applique: true },
    { id: 3, id_sync: 'k3', MajLe: 1, Photo: cell }, // pas encore recopiée : la recopie l'écrit
    { id: 4, id_sync: 'k4', MajLe: 1, Photo: ['L', [`${A}.pdf`, 'a.pdf', 10]], Sync_Applique: true },
  ];
  const destRows = [
    { id: 10, id_sync: 'k1', Image: ['L', 11] }, // sans B : à compléter
    { id: 11, id_sync: 'k2', Image: null }, // retouchée à la main : gardée
    { id: 12, id_sync: 'k3', Image: ['L', 11] },
    { id: 13, id_sync: 'k4', Image: ['L', 11] },
  ];
  const present = new Map([[A, 11], [B, 12]]);
  const args = { journalRows, destRows, copyCols: [['Photo', 'Image']], present, destTable: 'Fiches' };
  assert.deepEqual(fillActions({ ...args, arrived: new Set([short(B)]) }), [['BulkUpdateRecord', 'Fiches', [10], { Image: [['L', 11, 12]] }]]);
  assert.deepEqual(fillActions({ ...args, arrived: new Set() }), []);
  assert.deepEqual(fillActions({ ...args, copyCols: [], arrived: new Set([short(B)]) }), []);
});
