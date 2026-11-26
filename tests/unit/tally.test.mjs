// CIBLE : bilan des lignes annoncées par la SOURCE et reçues, sans fausse alerte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LATE_MAX, TALLY_GRACE_S, keyPrefix, lateEntries, liveKeys, nextLate, nextTally, tallyDue, tallyGap } from '../../js/engine/logic/tally.js';
import { parseLot, planUnpack } from '../../js/engine/logic/journal.js';

// Version déjà dépliée d'une clé : id, heure de la version, case Supprime, état noté par la recopie.
const version = (id, key, extra = {}) => ({ id, id_sync: key, MajLe: id, Supprime: false, Sync_Etat: '', Synchro_Table: 'Contacts', ...extra });

test('lot : l\'annonce du nombre de clés est lue, ou absente', () => {
  const lot = bilan => parseLot(JSON.stringify({ lignes: [], total: 0, bilan })).tally;
  assert.deepEqual(lot({ n: 30000, t: 1760000000 }), { n: 30000, t: 1760000000 });
  assert.deepEqual(lot({ n: 0, t: 5.5 }), { n: 0, t: 5.5 }, 'zéro clé est une annonce');
  for (const bad of [{ n: -1, t: 1 }, { n: 1.5, t: 1 }, { n: '12', t: 1 }, { n: 3 }, { n: 3, t: 'hier' }, { n: 3, t: null }, null, 'x', []]) {
    assert.equal(lot(bad), undefined, `annonce illisible ignorée : ${JSON.stringify(bad)}`);
  }
  assert.ok(!('tally' in parseLot('{"lignes": [], "total": 0}')), 'SOURCE d\'avant : pas d\'annonce');
});

test('dépliage : l\'annonce la plus récente de chaque table l\'emporte, à égalité la dernière arrivée', () => {
  const raw = (id, table, bilan) => ({
    id, Synchro_Export: 'e', Synchro_Table: table, Synchro_Type: 'lot', Synchro_Colonnes: '', Synchro_Renvoi: '', Sync_Recu: 100 + id,
    Synchro_Lot: JSON.stringify({ lignes: [], total: 0, ...(bilan ? { bilan } : {}) }),
  });
  const { tally } = planUnpack([
    raw(1, 'Contacts', { n: 10, t: 100 }), raw(2, 'Contacts', { n: 12, t: 300 }), raw(3, 'Contacts', { n: 11, t: 200 }),
    raw(4, 'Villes', { n: 5, t: 50 }), raw(5, 'Villes', { n: 6, t: 50 }), raw(6, 'Autres', null),
  ], 'J');
  assert.deepEqual(tally, { Contacts: { n: 12, t: 300 }, Villes: { n: 6, t: 50 } }, 'un lot qui arrive dans le désordre ne remplace pas une annonce plus récente');
});

test('note du journal : annonces gardées par table reçue, la plus récente d\'abord', () => {
  const was = { Contacts: { n: 10, t: 100 }, Villes: { n: 5, t: 90 }, Partie: { n: 1, t: 1 } };
  assert.deepEqual(nextTally(was, { Contacts: { n: 12, t: 200 } }, ['Contacts', 'Villes']), { Contacts: { n: 12, t: 200 }, Villes: { n: 5, t: 90 } }, 'une table qui n\'est plus reçue est oubliée');
  assert.deepEqual(nextTally(was, { Contacts: { n: 9, t: 50 } }).Contacts, { n: 10, t: 100 }, 'une annonce plus ancienne est ignorée');
  assert.deepEqual(nextTally(undefined, undefined), {});
  assert.equal(Object.keys(nextTally({}, Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`T${i}`, { n: 1, t: i }])))).length, 200, 'au plus 200 tables');
});

test('clés encore à la SOURCE : la dernière version de chaque clé, sans celles qui en sont parties', () => {
  const rows = [
    version(1, 'a'), version(2, 'a', { MajLe: 5, Sync_Etat: 'modif' }), // deux versions d'une clé : une seule clé
    version(3, 'b', { Sync_Etat: 'ajout' }),
    version(4, 'c', { Sync_Etat: 'suppression' }), // partie par une liste des clés
    version(5, 'd', { Sync_Etat: 'partie' }),
    version(6, 'e', { Supprime: true, Sync_Etat: 'suppression' }), // case Supprime : la ligne reste dans la table de la SOURCE
    version(7, 'f', { Supprime: true, Sync_Etat: 'partie' }),
    version(8, '', {}), version(9, null, {}), // sans clé : listes, test du lien
  ];
  assert.equal(liveKeys(rows), 4, 'a, b, e, f');
  assert.equal(liveKeys([...rows, version(10, 'c', { MajLe: 20 })]), 5, 'une clé revenue compte de nouveau');
  assert.equal(liveKeys([]), 0);
});

test('manque : seulement quand la SOURCE annonce plus de clés qu\'il n\'en est arrivé', () => {
  const rows = Array.from({ length: 8 }, (_, i) => version(i + 1, `k${i}`));
  assert.deepEqual(tallyGap({ n: 10, t: 1 }, rows), { expected: 10, got: 8, gap: 2 });
  assert.equal(tallyGap({ n: 8, t: 1 }, rows), null, 'compte complet');
  assert.equal(tallyGap({ n: 6, t: 1 }, rows), null, 'surplus : pas un manque');
  assert.equal(tallyGap(undefined, rows), null, 'SOURCE d\'avant ou pas encore d\'annonce');
  assert.equal(tallyGap({ n: 10, t: 1 }, rows, true), null, 'écart déjà expliqué (lignes à venir, trop grosses)');
  assert.deepEqual(tallyGap({ n: 3, t: 1 }, []), { expected: 3, got: 0, gap: 3 }, 'rien reçu du tout');
});

test('manque signalé seulement s\'il dure sans changer', () => {
  const seen = new Map();
  const gap = { expected: 10, got: 8, gap: 2 };
  assert.equal(tallyDue(seen, 'J|Contacts', gap, 1000), false, 'vu pour la première fois');
  assert.equal(tallyDue(seen, 'J|Contacts', gap, 1000 + TALLY_GRACE_S - 1), false, 'pas encore assez longtemps');
  assert.equal(tallyDue(seen, 'J|Contacts', gap, 1000 + TALLY_GRACE_S), true, 'dure depuis assez longtemps');
  assert.equal(tallyDue(seen, 'J|Contacts', { expected: 10, got: 9, gap: 1 }, 1000 + TALLY_GRACE_S + 5), false, 'une ligne de plus est arrivée : on repart de zéro');
  assert.equal(tallyDue(seen, 'J|Contacts', { expected: 10, got: 9, gap: 1 }, 1000 + 2 * TALLY_GRACE_S + 5), true);
  assert.equal(tallyDue(seen, 'J|Contacts', null, 5000), false, 'plus de manque');
  assert.equal(seen.size, 0, 'oublié');
  assert.equal(tallyDue(seen, 'J|Villes', gap, 5000), false);
  assert.equal(tallyDue(seen, 'J|Contacts', gap, 5000 + 1e6), false, 'une autre table a son propre délai');
});

// ---------------------------------------------------------------------------------------------
// Modification perdue : le bilan annonce les dernières modifications de la SOURCE (bilan.r).

const raw = (id, table, lot) => ({
  id, Synchro_Export: 'e', Synchro_Table: table, Synchro_Type: 'lot', Synchro_Colonnes: '', Synchro_Renvoi: '', Sync_Recu: 100 + id,
  Synchro_Lot: JSON.stringify({ lignes: [], total: 0, ...lot }),
});

test('lot : les dernières modifications annoncées sont lues, celles qui sont illisibles écartées', () => {
  const recent = r => parseLot(JSON.stringify({ lignes: [], total: 0, bilan: { n: 3, t: 5, r } })).recent;
  assert.deepEqual(recent([['abcdefghij', 1760000000], ['k2', 1760000005.5]]), [['abcdefghij', 1760000000], ['k2', 1760000005.5]]);
  assert.deepEqual(recent([['', 1], ['ok', 2], [3, 4], ['x'], ['y', 'hier'], ['z', null], ['w', Infinity], 'texte', null, ['trop-long-pour-etre-une-cle-abregee-du-bilan', 9]]), [['ok', 2]],
    'clé vide, nombre, heure illisible, entrée qui n\'est pas une paire, clé plus longue qu\'un début de clé : écartés');
  assert.equal(recent([]), undefined, 'liste vide : rien');
  for (const bad of ['x', 12, {}, null]) assert.equal(recent(bad), undefined, `liste illisible : ${JSON.stringify(bad)}`);
  assert.equal(recent(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])).length, 12, 'au plus douze entrées');
  assert.ok(!('recent' in parseLot(JSON.stringify({ lignes: [], total: 0, bilan: { n: 3, t: 5 } }))), 'SOURCE d\'avant : pas d\'annonce de modifications');
  assert.ok(!('recent' in parseLot(JSON.stringify({ lignes: [], total: 0, bilan: { n: -1, t: 5, r: [['k', 1]] } }))), 'un bilan illisible n\'apporte rien');
});

test('dépliage : les modifications annoncées par tous les lots arrivés ensemble se retrouvent, la plus récente de chaque ligne', () => {
  const { recent } = planUnpack([
    raw(1, 'Contacts', { bilan: { n: 4, t: 10, r: [['a', 100], ['b', 90]] } }),
    raw(2, 'Contacts', { bilan: { n: 4, t: 20, r: [['a', 95], ['c', 120]] } }),
    raw(3, 'Villes', { bilan: { n: 2, t: 20, r: [['v', 7]] } }),
    raw(4, 'Autres', { bilan: { n: 2, t: 20 } }),
  ], 'J');
  assert.deepEqual(recent, { Contacts: [['a', 100], ['b', 90], ['c', 120]], Villes: [['v', 7]] });
});

test('début de clé : comme Python, en caractères', () => {
  assert.equal(keyPrefix('0123456789abcdef'), '0123456789');
  assert.equal(keyPrefix('court'), 'court');
  assert.equal(keyPrefix('😀😀😀😀😀😀😀😀😀😀😀😀'), '😀'.repeat(10), 'dix caractères, pas dix unités de 16 bits');
  assert.equal(keyPrefix(12), '12');
});

test('lignes en retard : seule une ligne d\'ici plus ancienne que l\'annonce l\'est', () => {
  const rows = [
    version(1, 'aaaaaaaaaa-1', { MajLe: 100 }),
    version(2, 'bbbbbbbbbb-2', { MajLe: 100 }),
    version(3, 'cccccccccc-3', { MajLe: 100, Sync_Etat: 'suppression' }),
    version(4, 'dddddddddd-4', { MajLe: 100, Supprime: true, Sync_Etat: 'suppression' }),
  ];
  assert.deepEqual(lateEntries([['aaaaaaaaaa', 150]], rows), [['aaaaaaaaaa', 150]], 'plus ancienne que l\'annonce');
  assert.deepEqual(lateEntries([['aaaaaaaaaa', 100]], rows), [], 'même heure : rien');
  assert.deepEqual(lateEntries([['aaaaaaaaaa', 90]], rows), [], 'ici plus récente : rien (un renvoi, Ctrl+Z, datent après MajLe)');
  assert.deepEqual(lateEntries([['zzzzzzzzzz', 500]], rows), [], 'une clé absente ici est un manque que dit le compte, pas un retard');
  assert.deepEqual(lateEntries([['cccccccccc', 500]], rows), [], 'une ligne partie de la SOURCE n\'est pas en retard');
  assert.deepEqual(lateEntries([['dddddddddd', 500]], rows), [['dddddddddd', 500]], 'la case Supprime laisse la ligne dans la SOURCE : elle compte');
  assert.deepEqual(lateEntries([], rows), []);
  assert.deepEqual(lateEntries([['aaaaaaaaaa', 150], ['bbbbbbbbbb', 50]], rows), [['aaaaaaaaaa', 150]]);
  const later = [...rows, version(5, 'aaaaaaaaaa-1', { MajLe: 160 })];
  assert.deepEqual(lateEntries([['aaaaaaaaaa', 150]], later), [], 'une version assez récente est arrivée');
  const same = [version(1, 'kkkkkkkkkk-a', { MajLe: 100 }), version(2, 'kkkkkkkkkk-b', { MajLe: 300 })];
  assert.deepEqual(lateEntries([['kkkkkkkkkk', 200]], same), [], 'un début de clé qui désigne deux lignes compte pour la plus récente : jamais de fausse alerte');
  assert.deepEqual(lateEntries([['aaaaaaaaaa', 150]], [version(1, 'aaaaaaaaaa-1', { MajLe: null })]), [['aaaaaaaaaa', 150]], 'sans heure ici : en retard');
});

test('note : les lignes en retard se gardent jusqu\'à l\'arrivée d\'une version assez récente', () => {
  const rows = [version(1, 'aaaaaaaaaa-1', { MajLe: 100 }), version(2, 'bbbbbbbbbb-2', { MajLe: 100 })];
  assert.deepEqual(nextLate(undefined, [['aaaaaaaaaa', 150], ['bbbbbbbbbb', 80]], rows), { aaaaaaaaaa: 150 });
  assert.deepEqual(nextLate({ aaaaaaaaaa: 150 }, [], rows), { aaaaaaaaaa: 150 }, 'sans nouvelle annonce, la note reste');
  assert.deepEqual(nextLate({ aaaaaaaaaa: 150 }, [['bbbbbbbbbb', 130]], rows), { aaaaaaaaaa: 150, bbbbbbbbbb: 130 }, 'deux lignes');
  assert.deepEqual(nextLate({ aaaaaaaaaa: 150 }, [['aaaaaaaaaa', 120]], rows), { aaaaaaaaaa: 150 }, 'la plus récente annonce l\'emporte');
  assert.deepEqual(nextLate({ aaaaaaaaaa: 150 }, [], [...rows, version(3, 'aaaaaaaaaa-1', { MajLe: 151 })]), {}, 'la version est arrivée : plus de retard');
  const many = Array.from({ length: 40 }, (_, i) => version(i + 1, `${String(i).padStart(10, 'k')}-x`, { MajLe: 1 }));
  assert.equal(Object.keys(nextLate({}, many.map((r, i) => [keyPrefix(r.id_sync), 50 + i]), many)).length, LATE_MAX, `au plus ${LATE_MAX} lignes gardées`);
});

test('manque : une ligne en retard est dite quand le compte est bon, jamais en plus d\'un manque de lignes', () => {
  const rows = Array.from({ length: 3 }, (_, i) => version(i + 1, `kkkkkkkkk${i}-z`, { MajLe: 100 }));
  const late = { kkkkkkkkk1: 150, kkkkkkkkk0: 120 };
  assert.deepEqual(tallyGap({ n: 3, t: 1, late }, rows), { late: 2, keys: ['kkkkkkkkk0', 'kkkkkkkkk1'] });
  assert.deepEqual(tallyGap({ n: 5, t: 1, late }, rows), { expected: 5, got: 3, gap: 2 }, 'le manque de lignes passe d\'abord');
  assert.equal(tallyGap({ n: 3, t: 1, late }, rows, true), null, 'écart déjà expliqué');
  assert.equal(tallyGap({ n: 3, t: 1 }, rows), null, 'rien d\'annoncé');
  assert.equal(tallyGap({ n: 3, t: 1, late: { kkkkkkkkk1: 90 } }, rows), null, 'la version d\'ici est plus récente');
  assert.equal(tallyGap({ n: 3, t: 1, late }, [...rows, version(9, 'kkkkkkkkk1-z', { MajLe: 160 }), version(10, 'kkkkkkkkk0-z', { MajLe: 130 })]), null, 'les versions sont arrivées');
});

test('retard signalé seulement s\'il dure sans changer', () => {
  const seen = new Map();
  const gap = { late: 1, keys: ['kkkkkkkkk1'] };
  assert.equal(tallyDue(seen, 'J|Contacts', gap, 1000), false);
  assert.equal(tallyDue(seen, 'J|Contacts', gap, 1000 + TALLY_GRACE_S - 1), false);
  assert.equal(tallyDue(seen, 'J|Contacts', gap, 1000 + TALLY_GRACE_S), true);
  assert.equal(tallyDue(seen, 'J|Contacts', { late: 2, keys: ['kkkkkkkkk0', 'kkkkkkkkk1'] }, 1000 + TALLY_GRACE_S + 1), false, 'une ligne de plus : on repart de zéro');
  assert.equal(tallyDue(seen, 'J|Contacts', { expected: 3, got: 2, gap: 1 }, 1000 + 2 * TALLY_GRACE_S), false, 'un autre genre de manque repart de zéro aussi');
});
