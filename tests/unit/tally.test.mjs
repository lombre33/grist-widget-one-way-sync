// CIBLE : bilan des lignes annoncées par la SOURCE et reçues, sans fausse alerte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TALLY_GRACE_S, liveKeys, nextTally, tallyDue, tallyGap } from '../../js/logic/tally.js';
import { parseLot, planUnpack } from '../../js/logic/journal.js';

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
