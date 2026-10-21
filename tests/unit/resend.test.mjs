// Renvois (SOURCE) : marques reprenables, listes des clés, budget par document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSpent, BUDGET_WINDOW, budgetWait, chargeBusy, chunkMark, dueRows, LEASE_S, listOverdue, lotLate, listRequest, parseCharge, RESEND_BUDGET, resendValue, rowsSince, trackState } from '../../js/logic/resend.js';
import { RESEND_ALL } from '../../js/logic/common.js';
import { parseList } from '../../js/logic/journal.js';

test('renvoi reprenable : lignes depuis la marque, dans l\'ordre de MajLe ; la marque avance par tranche', () => {
  const rows = [{ id: 1, MajLe: 30 }, { id: 2, MajLe: null }, { id: 3, MajLe: 10 }, { id: 4, MajLe: 20 }, { id: 5, MajLe: 10 }];
  assert.deepEqual(rowsSince(rows, RESEND_ALL).map(r => r.id), [2, 3, 5, 4, 1], 'toute la table, lignes sans MajLe d\'abord');
  assert.equal(resendValue('ab12', [3, 4]), 'ab12:3,4', 'demande de renvoi : marque et numéros');
  assert.deepEqual(rowsSince(rows, 20).map(r => r.id), [4, 1]);
  assert.deepEqual(rowsSince(rows, 31), []);
  const all = rowsSince(rows, RESEND_ALL);
  assert.equal(chunkMark(all.slice(0, 2), RESEND_ALL), RESEND_ALL, 'lignes sans MajLe : toute la table reste à envoyer');
  assert.equal(chunkMark(all.slice(2, 4), RESEND_ALL), 10);
  assert.equal(chunkMark(all.slice(4), RESEND_ALL), 30);
  assert.equal(chunkMark([{ id: 4, MajLe: 20 }], 15), 20);
});

test('liste des clés : seaux, morceau de liste complète, ancienne liste d\'un seul tenant', () => {
  assert.deepEqual(parseList('ids:a b  c'), { full: ['a', 'b', 'c'] });
  for (const bad of ['', null, '{}', 'x', '{"seaux": {"3": ["a"]}}', '{"t": 5, "seaux": {"300": ["a"], "x": []}}']) assert.equal(parseList(bad), null);
  assert.deepEqual(parseList('{"t": 5, "seaux": {"3": ["a", "", 3], "7": []}}'), { buckets: { t: 5, keys: new Map([[3, new Set(['a', '3'])], [7, new Set()]]) } });
  assert.equal(listRequest('abcd1234', 2, 'k9'), '{"marque":"abcd1234","n":2,"apres":"k9"}');
  const part = { liste: { marque: 'abcd1234', n: 2, t: 7, cles: ['a'], fin: true } };
  assert.deepEqual(parseList(JSON.stringify({ t: 6, seaux: { 1: ['z'] }, ...part })),
    { buckets: { t: 6, keys: new Map([[1, new Set(['z'])]]) }, part: { mark: 'abcd1234', n: 2, t: 7, keys: ['a'], last: true } });
  assert.equal(parseList(JSON.stringify({ liste: { ...part.liste, n: 0 } })), null, 'morceau mal formé');
  const track = { Synchro_Type: 'suivi', Sync_Etat: '{"t": 1, "top": 4, "s": [], "trop": "1.5"}', Synchro_Renvoi: '' };
  assert.deepEqual(trackState(track), { t: 1, top: 4, s: [], trop: '1.5' });
  assert.equal(listOverdue(track), true, 'trop de clés parties : liste complète à renvoyer');
  assert.equal(listOverdue({ ...track, Synchro_Renvoi: '1.5' }), false, 'renvoyée depuis');
  assert.deepEqual(trackState({ Synchro_Type: 'lot', Sync_Etat: 12 }), {});
  assert.equal(listOverdue({ Synchro_Type: 'suivi', Sync_Etat: 'illisible' }), false);
});

test('renvois ménagés : un à la fois par document, budget par fenêtre de dix minutes', () => {
  assert.deepEqual(parseCharge(''), { par: '', le: 0, reprise: 0, envoye: [] });
  assert.deepEqual(parseCharge('{"par": "a", "le": 5, "envoye": [[60, 10], "x"]}'), { par: 'a', le: 5, reprise: 0, envoye: [[60, 10]] });
  const held = { ...parseCharge(''), par: 'n1.a', le: 1000 };
  assert.equal(chargeBusy(held, 'n2.b', 1100), true, 'une page d\'un autre navigateur renvoie');
  assert.equal(chargeBusy(held, 'n1.a', 1100), false, 'c\'est cette page');
  assert.equal(chargeBusy(held, 'n1.c', 1100), false, 'page du même navigateur, fermée (elle tiendrait le verrou)');
  assert.equal(chargeBusy(held, 'n2.b', 1000 + LEASE_S), false, 'sans signe de vie, une autre page reprend');
  assert.equal(chargeBusy({ ...held, par: '' }, 'n2.b', 1100), false);
  let c = addSpent(parseCharge(''), 1000, 5);
  c = addSpent(c, 1010, 7);
  assert.deepEqual(c.envoye, [[960, 12]], 'une entrée par minute');
  c = addSpent(c, 1000 + BUDGET_WINDOW, 1);
  assert.deepEqual(c.envoye, [[1560, 1]], 'les envois sortis de la fenêtre sont oubliés');
  assert.equal(budgetWait(c, 1600), 0);
  const full = { ...c, envoye: [[1200, RESEND_BUDGET / 2], [1260, RESEND_BUDGET / 2], [1320, 10]] };
  assert.equal(budgetWait(full, 1400), 1200 + BUDGET_WINDOW - 1400, 'attendre que la plus ancienne minute sorte');
  assert.equal(budgetWait(full, 1900), 0, 'plus rien dans la fenêtre au-delà du budget');
});

test('rattrapage : lots coupés, listes dues sauf celle d\'un lot coupé ou d\'un export qui change de forme', () => {
  const rows = [
    { id: 1, Synchro_Export: 'e1', Synchro_Table: 'A', Synchro_Type: 'lot', Sync_Etat: 5 },
    { id: 2, Synchro_Export: 'e1', Synchro_Table: 'A', Synchro_Type: 'cles', Synchro_Renvoi: 'm' },
    { id: 3, Synchro_Export: 'e1', Synchro_Table: 'B', Synchro_Type: 'cles', Synchro_Renvoi: 'm' },
    { id: 4, Synchro_Export: 'e1', Synchro_Table: 'B', Synchro_Type: 'lot', Sync_Etat: 0 },
    { id: 5, Synchro_Export: 'e2', Synchro_Table: 'C', Synchro_Type: 'cles', Synchro_Renvoi: 'm' },
    { id: 6, Synchro_Export: 'e2', Synchro_Table: '', Synchro_Type: 'echange' },
  ];
  assert.deepEqual([lotLate(rows[0]), lotLate(rows[3]), lotLate(rows[1])], [true, false, false]);
  const { late, lists } = dueRows(rows);
  assert.deepEqual(late.map(r => r.id), [1]);
  assert.deepEqual(lists.map(r => r.id), [3]);
});
