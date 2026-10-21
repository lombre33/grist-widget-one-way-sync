// CIBLE : ce qu'un passage garde pour l'onglet (arrivées suspectes, fin d'envoi, tables proposées,
// pièces jointes attendues, carte d'une table).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHOWN, cardShape, driftResult, endedAt, exportShape, filesSummary, nextSuspect, offersOf, tableResult, wrote,
} from '../../js/logic/report.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('arrivées suspectes : compte cumulé, heure de la dernière, flot anormal gardé', () => {
  assert.deepEqual(nextSuspect(undefined, 3, false, 100.7), { n: 3, at: 100 });
  assert.deepEqual(nextSuspect({ n: 3, at: 100 }, 2, true, 200), { n: 5, at: 200, flood: 200 });
  assert.deepEqual(nextSuspect({ n: 5, at: 200, flood: 200 }, 1, false, 300), { n: 6, at: 300, flood: 200 });
});

test('fin d\'envoi : notée à son heure (ou maintenant), gardée, effacée par une arrivée', () => {
  assert.equal(endedAt({ ended: 50 }, {}, 999), 50);
  assert.equal(endedAt({}, {}, 999), undefined);
  assert.equal(endedAt({}, { ended: { at: 70 } }, 999), 70);
  assert.equal(endedAt({}, { ended: {} }, 999.4), 999);
  assert.equal(endedAt({ ended: 50 }, { ended: false }, 999), undefined);
});

test('tables ajoutées à l\'export : en attente, et proposées dès que leurs colonnes sont connues', () => {
  const cols = JSON.stringify([{ id: 'Nom', type: 'Text', label: 'Nom' }]);
  const groups = new Map([
    ['Contacts', [{ id: 1, id_sync: 'k1' }]],
    ['Villes', [{ id: 2, id_sync: '', Synchro_Colonnes: cols }, { id: 3, id_sync: 'v1' }, { id: 4, id_sync: 'v2' }, { id: 5, id_sync: 'v1' }]],
    ['Pays', [{ id: 6, id_sync: 'p1' }]],
    ['Refusee', [{ id: 7, id_sync: 'r1', Synchro_Colonnes: cols }]],
  ]);
  const { pending, offers } = offersOf(groups, { tables: [{ table: 'Contacts' }], refused: ['Refusee'] });
  assert.deepEqual(pending, ['Villes', 'Pays']);
  assert.deepEqual(offers, [{ table: 'Villes', columns: [{ id: 'Nom', type: 'Text', label: 'Nom' }], n: 2 }]);
});

test('pièces jointes : fichiers attendus notés, trop gros nommés, rien par lien public', () => {
  const rows = [{ id: 1, id_sync: 'k1', MajLe: 1, Doc: ['L', [`${A}.pdf`, 'a.pdf', 10], [`${B}.zip`, 'b.zip', 30 * 1048576]] }];
  assert.deepEqual(filesSummary(rows, [], new Map(), false), { waiting: undefined, card: undefined });
  const seen = filesSummary(rows, [['Doc', 'Doc']], new Map(), false);
  assert.deepEqual(seen.waiting, [A.slice(0, 16)]);
  assert.equal(seen.card.waiting, 1);
  assert.deepEqual(seen.card.big.map(f => f.name), ['b.zip']);
  const pub = filesSummary(rows, [['Doc', 'Doc']], new Map(), true);
  assert.equal(pub.waiting, undefined);
  assert.equal(pub.card.waiting, 0);
  assert.equal(filesSummary(rows, [['Doc', 'Doc']], new Map([[A, 4]]), false).waiting, undefined);
});

test('forme d\'un export de retour : tables et colonnes, sans ordre des tables', () => {
  const a = exportShape([{ table: 'B', columns: [{ id: 'x' }] }, { table: 'A', columns: [{ id: 'y', as: 'z' }] }]);
  const b = exportShape([{ table: 'A', columns: [{ id: 'y', as: 'z' }] }, { table: 'B', columns: [{ id: 'x' }] }]);
  assert.equal(a, b);
  assert.notEqual(a, exportShape([{ table: 'A', columns: [{ id: 'y' }] }, { table: 'B', columns: [{ id: 'x' }] }]));
});

test('retouches pour la carte : les premières, nommées, comptées en cellules et lignes effacées', () => {
  const drift = Array.from({ length: SHOWN + 2 }, (_, i) => ({ n: i + 1, row: { Nom: `n${i}` }, cells: [['Nom', 'Nom', 'a', 'b']] }));
  drift.push({ n: 99, row: { Nom: 'parti' }, cells: [], gone: true });
  const result = driftResult(drift, 'Nom', [['Ville', 'Ville']]);
  assert.equal(result.drift.length, SHOWN);
  assert.deepEqual(result.drift[0], { n: 1, label: 'n0', cells: [['Nom', 'Nom', 'a', 'b']] });
  assert.equal(result.driftCount, SHOWN + 2 + 1 + 1);
  assert.equal(result.driftGone, 1);
  assert.equal(driftResult([{ n: 1, row: {}, cells: [] }], '', []).drift[0].label, '');
});

test('carte d\'une table : colonne qui nomme les lignes, historique et colonnes ajoutées depuis la visite', () => {
  const entry = { table: 'Contacts', dest: 'Annuaire', label: 'Ville', addedCols: [{ id: 'Tel', at: 50 }, { id: 'Mail', at: 150 }] };
  const copyCols = [['Nom', 'Nom'], ['Ville', 'Ville']];
  const groups = new Map([['Contacts', [
    { id: 1, id_sync: 'k1', MajLe: 1, Nom: 'Ana', Ville: 'Lyon', Sync_Etat: 'ajout', Sync_Recu: 120 },
    { id: 2, id_sync: 'k2', MajLe: 1, Nom: 'Bo', Ville: 'Metz', Sync_Etat: 'ajout', Sync_Recu: 80 },
  ]]]);
  const base = { entry, stats: { added: 1, updated: 0, removed: 0 }, copyCols, types: {}, numbers: new Map([['k1', 4]]), drift: [], dropped: [], pending: [], gaps: [] };
  const card = tableResult(base, groups, 100);
  assert.equal(card.labelCol, 'Ville');
  assert.deepEqual(card.recent.map(r => [r.label, r.n]), [['Lyon', 4]]);
  assert.deepEqual(card.added.map(a => a.id), ['Mail']);
  assert.equal(card.held, null);
  assert.equal(card.pendingCount, 0);
  assert.equal(tableResult({ ...base, entry: { ...entry, label: 'Absente' } }, groups, 0).labelCol, 'Nom');
  assert.equal(tableResult({ ...base, entry: { table: 'Vide' } }, new Map(), 0).recent.length, 0);
  assert.deepEqual(tableResult({ ...base, error: 'destMissing' }, groups, 0), { table: 'Contacts', error: 'destMissing' });
  const review = tableResult({ ...base, pending: [{ id: 9, n: 2, state: 'modif', row: { Ville: 'Brest' }, cells: [] }] }, groups, 0);
  assert.deepEqual(review.pending, [{ id: 9, n: 2, state: 'modif', label: 'Brest', cells: [] }]);
  assert.deepEqual(review.pendingIds, [9]);
});

test('carte inchangée ou non : forme comparée, écritures vues', () => {
  assert.equal(cardShape(), cardShape({}));
  assert.notEqual(cardShape({ driftCount: 1 }), cardShape({}));
  assert.equal(wrote(undefined), false);
  assert.equal(wrote({ added: 0, updated: 0, removed: 0 }), false);
  assert.equal(wrote({ added: 0, updated: 2, removed: 0 }), true);
});
