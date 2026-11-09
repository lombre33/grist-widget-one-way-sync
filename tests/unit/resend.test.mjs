// Renvois (SOURCE) : marques reprenables, listes des clés, budget par document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addProg, addSpent, announceRest, BUDGET_WINDOW, chunkCount, eligibleRows, etaSeconds, lotCut, nextChunkSize, parseProg, percent, startProg, windowSpent, budgetWait, chargeBusy, chunkMark, dueRows, LEASE_S, listOverdue, lotLate, listRequest, parseCharge, RESEND_BUDGET, resendValue, rowsSince, trackState, trackedCounts } from '../../js/engine/logic/resend.js';
import { RESEND_ALL } from '../../js/engine/logic/common.js';
import { parseList } from '../../js/engine/logic/journal.js';

test('renvoi reprenable : lignes depuis la marque, dans l\'ordre de MajLe ; la marque avance par tranche', () => {
  const rows = [{ id: 1, MajLe: 30 }, { id: 2, MajLe: null }, { id: 3, MajLe: 10 }, { id: 4, MajLe: 20 }, { id: 5, MajLe: 10 }];
  assert.deepEqual(rowsSince(rows, RESEND_ALL).map(r => r.id), [2, 3, 5, 4, 1], 'toute la table, lignes sans MajLe d\'abord');
  assert.equal(resendValue('ab12', [3, 4]), 'ab12:3,4', 'demande de renvoi : marque et numéros');
  assert.equal(resendValue('ab12', [3, 4], 250), 'ab12:250:3,4', 'avec ce qui reste à venir : marque, reste, numéros');
  assert.equal(resendValue('ab12', [], 0), 'ab12:0:', 'dernière tranche vide : le reste est zéro');
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
  assert.deepEqual(parseCharge(''), { par: '', le: 0, reprise: 0, envoye: [], prog: null });
  assert.deepEqual(parseCharge('{"par": "a", "le": 5, "envoye": [[60, 10], "x"]}'), { par: 'a', le: 5, reprise: 0, envoye: [[60, 10]], prog: null });
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

test('avancement d\'un renvoi : lu dans la ligne charge, jamais invalide, avec reste à faire', () => {
  assert.equal(parseProg(null), null);
  assert.equal(parseProg({ done: 3 }), null, 'sans export');
  assert.deepEqual(parseProg({ exp: 'e', table: 7, done: '12', total: -5, lots: 'x' }), { exp: 'e', table: '', done: 12, total: 0, lots: 0, lotsTotal: 0, bytes: 0, at: 0, last: 0 });
  const prog = addProg(addProg(startProg('e', 1000, 5, 100.7), { rows: 200, bytes: 300000, now: 110 }), { rows: 0, bytes: 250000, now: 115 });
  assert.deepEqual(prog, { exp: 'e', table: '', done: 200, total: 1000, lots: 2, lotsTotal: 5, bytes: 550000, at: 100, last: 115 }, 'un lot coupé compte comme un lot et pèse sur les octets, pas sur les lignes');
  assert.equal(percent(prog), 20);
  assert.equal(percent({ done: 5, total: 0 }), 0);
  assert.equal(percent({ done: 500, total: 100 }), 100);
  assert.deepEqual(parseCharge(JSON.stringify({ par: 'a', le: 1, prog })).prog, prog);
  assert.equal(chunkCount(0), 1, 'une table vide part en un lot vide');
  assert.equal(chunkCount(401), 3);
});

test('temps restant : le plus long du rythme tenu et du budget, rien tant qu\'il est trop tôt', () => {
  const charge = parseCharge('');
  assert.equal(etaSeconds(null, charge, 1000), null);
  const start = startProg('e', 1000, 5, 1000);
  assert.equal(etaSeconds(start, charge, 1100), null, 'rien de parti');
  const some = addProg(start, { rows: 200, bytes: 100000, now: 1010 });
  assert.equal(etaSeconds(some, charge, 1010), null, 'moins de 15 secondes');
  assert.equal(etaSeconds(some, charge, 1100), 400, 'au rythme tenu : 200 lignes en 100 s, 800 restantes');
  assert.equal(etaSeconds(addProg(some, { rows: 800, bytes: 0, now: 1100 }), charge, 1100), null, 'tout est parti');
  // Le budget est plein : il faut attendre, quel que soit le rythme d\'avant.
  const heavy = addProg(start, { rows: 100, bytes: 5000000, now: 1010 });
  const full = { ...charge, envoye: [[960, RESEND_BUDGET]] };
  assert.equal(windowSpent(full, 1100), RESEND_BUDGET);
  assert.equal(windowSpent(full, 1100 + BUDGET_WINDOW), 0, 'sortis de la fenêtre');
  const eta = etaSeconds(heavy, full, 1100);
  assert.equal(eta, Math.round(((900 * 50000 - 0) / RESEND_BUDGET) * BUDGET_WINDOW), 'budget plein : 900 lignes de 50 Ko à passer au rythme du budget');
  assert.ok(eta > 400);
});

test('lot coupé : seules les lignes qui devaient partir comptent, les tranches suivantes rétrécissent', () => {
  const lot = (lines, total, big = 0) => ({ lines: Array.from({ length: lines }), total, big: Array.from({ length: big }) });
  assert.equal(lotCut(null), false, 'lot illisible');
  assert.equal(lotCut(lot(200, 200)), false);
  assert.equal(lotCut(lot(150, 200)), true);
  assert.equal(lotCut(lot(199, 200, 1)), false, 'une ligne trop grosse pour un envoi n\'est pas une coupure : elle ne partira jamais');
  assert.equal(nextChunkSize(200, 200, 200), 200, 'rien de coupé : la taille ne change pas');
  assert.equal(nextChunkSize(200, 200, 151), 135, 'un peu moins que ce qui a tenu');
  assert.equal(nextChunkSize(100, 200, 151), 100, 'jamais plus grande qu\'avant');
  assert.equal(nextChunkSize(200, 4, 0), 1, 'au moins une ligne');
  assert.equal(nextChunkSize(200, 3, 1), 1);
});

test('lignes qui peuvent partir : le nombre du suivi de la table, null sans suivi', () => {
  const rows = [
    { Synchro_Export: 'e', Synchro_Table: 'A', Synchro_Type: 'suivi', Synchro_Ids: '29871:0a1b2c3d' },
    { Synchro_Export: 'e', Synchro_Table: 'B', Synchro_Type: 'suivi', Synchro_Ids: '' },
    { Synchro_Export: 'e', Synchro_Table: 'C', Synchro_Type: 'suivi', Synchro_Ids: 'illisible' },
    { Synchro_Export: 'e', Synchro_Table: 'D', Synchro_Type: 'cles', Synchro_Ids: '12:0a1b2c3d' },
  ];
  assert.equal(eligibleRows(rows, 'e', 'A'), 29871);
  assert.equal(eligibleRows(rows, 'e', 'B'), null);
  assert.equal(eligibleRows(rows, 'e', 'C'), null);
  assert.equal(eligibleRows(rows, 'e', 'D'), null, 'la ligne des clés n\'est pas le suivi');
  assert.deepEqual(trackedCounts([...rows, { Synchro_Export: 'f', Synchro_Table: 'A', Synchro_Type: 'suivi', Synchro_Ids: '5:ff' }]), { e: { A: 29871 }, f: { A: 5 } }, 'comptes par export et par table, suivis lisibles seulement');
  assert.equal(eligibleRows(rows, 'autre', 'A'), null);
});

test('renvoi en tranches : ce qui reste à venir est annoncé à la CIBLE, ramené aux lignes qui partent', () => {
  assert.equal(announceRest(0), 0, 'plus de tranche : rien ne reste');
  assert.equal(announceRest(800), 800, 'sans filtre : toutes les lignes des tranches à venir');
  assert.equal(announceRest(800, 0.25), 200, 'filtre : seule la part qui part est annoncée');
  assert.equal(announceRest(3, 0.01), 1, 'tant qu\'il reste des tranches, au moins une ligne');
  assert.equal(announceRest(10, 7), 10, 'une part plus grande que 1 est ramenée à 1');
  assert.equal(announceRest(10, -1), 1, 'une part négative est ramenée à 0 : au moins une ligne tant qu\'il reste des tranches');
});
