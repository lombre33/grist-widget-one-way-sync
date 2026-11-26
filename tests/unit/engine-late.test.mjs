// CIBLE : une modification perdue (webhook coupé à la main puis rallumé, envoi perdu) est dite quand le compte des lignes est bon.
// Le bilan du lot annonce les dernières modifications de la SOURCE (`bilan.r`) ; une ligne d'ici dont la dernière version est plus
// ancienne reste « en retard » dans la note, puis la carte la signale au bout du délai de grâce, jamais avant, jamais en trop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { TALLY_GRACE_S } from '../../js/engine/logic/tally.js';
import { signText } from '../../js/engine/logic/trust.js';
import { consolidateAll, state } from '../../js/engine/target/loop.js';
import { journalNote, wireFiches } from './engine-wire.mjs';

const A = 'a1aaaaaaaa-x';
const B = 'b2bbbbbbbb-x';
const C = 'c3cccccccc-x';
// Le bilan nomme une ligne par le début de sa clé (dix caractères), comme la formule du lot.
const P = key => key.slice(0, 10);
const line = (key, order, Nom) => [key, order, false, { Nom, Ville: 'Lyon' }];

// Une SOURCE et une CIBLE branchées ; `send(lignes, bilan)` livre un lot signé qui porte ce bilan.
async function pair(tag, receive = { reserve: false, options: {} }) {
  const p = await wireFiches(tag, { dest: 'Fiches_recue', receive });
  const send = async (lines, bilan) => {
    const row = { [EXPORT_COL]: p.saved.id, [TABLE_COL]: 'Fiches', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: JSON.stringify(p.base) };
    p.world.deliver(p.accepted.url, [{ ...row, [LOT_COL]: await signText(p.accepted.keys.down, row, JSON.stringify({ lignes: lines, total: lines.length, ...(bilan ? { bilan } : {}) })) }]);
    p.as(p.target);
    await consolidateAll({ reread: true });
  };
  return { ...p, send };
}

// Le temps de la page avance de `s` secondes (le délai de grâce se compte en temps réel).
const realNow = Date.now;
let skew = 0;
Date.now = () => realNow() + skew * 1000;
const wait = async (s) => { skew += s; };

// Ce que la carte de la réception montrerait des lignes qui manquent (voir tallyReport).
const tallyOf = made => (state.results.get(made.journal) || {}).tally || {};

test('modification perdue : dite après le délai de grâce, jamais avant', async (t) => {
  const p = await pair('late1');
  await t.test('trois lignes arrivent, le bilan est bon : rien', async () => {
    await p.send([line(A, 100, 'Alice'), line(B, 100, 'Bob'), line(C, 100, 'Carl')], { n: 3, t: 100, r: [[P(A), 100], [P(B), 100], [P(C), 100]] });
    assert.deepEqual(tallyOf(p.made), {});
    assert.equal((await journalNote()).tally.Fiches.late, undefined, 'rien en retard dans la note');
  });
  await t.test('un lot annonce une modification de Bob que cette CIBLE n\'a pas : en retard, notée, pas encore dite', async () => {
    await p.send([line(A, 160, 'Alice II')], { n: 3, t: 100, r: [[P(A), 160], [P(B), 150]] });
    assert.deepEqual((await journalNote()).tally.Fiches.late, { [P(B)]: 150 }, 'seule Bob est en retard : Alice a reçu sa version');
    assert.deepEqual(tallyOf(p.made), {}, 'pas avant le délai de grâce');
    await wait(TALLY_GRACE_S - 30);
    await consolidateAll({ reread: true });
    assert.deepEqual(tallyOf(p.made), {}, 'toujours pas');
  });
  await t.test('passé le délai de grâce : « une modification manque »', async () => {
    await wait(60);
    await consolidateAll({ reread: true });
    assert.deepEqual(tallyOf(p.made), { Fiches: { late: 1, keys: [P(B)] } });
  });
  await t.test('la modification de Bob arrive : l\'avis part et la note l\'oublie', async () => {
    await p.send([line(B, 150, 'Bob II')], { n: 3, t: 100, r: [[P(B), 150]] });
    assert.deepEqual(tallyOf(p.made), {});
    assert.equal((await journalNote()).tally.Fiches.late, undefined);
  });
});

test('modification annoncée plus ancienne ou égale à celle d\'ici, ou SOURCE d\'avant : aucun retard', async () => {
  const p = await pair('late2');
  await p.send([line(A, 200, 'Alice'), line(B, 200, 'Bob')], { n: 2, t: 200, r: [[P(A), 200], [P(B), 150]] });
  assert.equal((await journalNote()).tally.Fiches.late, undefined, 'égale ou plus ancienne : rien');
  await p.send([], { n: 2, t: 300 });
  assert.equal((await journalNote()).tally.Fiches.late, undefined, 'SOURCE d\'avant : pas de liste des modifications');
  await p.send([], { n: 2, t: 400, r: [['clé-inconnue', 999]] });
  assert.equal((await journalNote()).tally.Fiches.late, undefined, 'une clé que cette CIBLE n\'a pas est un manque de ligne, pas un retard');
  await wait(2 * TALLY_GRACE_S);
  await consolidateAll({ reread: true });
  assert.deepEqual(tallyOf(p.made), {});
});

// Le même retard, avec ou sans archive : la carte le dit seulement quand les lignes parties ne restent pas.
for (const [tag, options, said] of [['late3', {}, true], ['late4', { archive: true }, false]]) {
  test(`${options.archive ? 'en archive, rien n\'est signalé' : 'sans archive, le même retard est signalé'}`, async () => {
    const p = await pair(tag, { reserve: false, options });
    await p.send([line(A, 100, 'Alice'), line(B, 100, 'Bob')], { n: 2, t: 100 });
    await p.send([], { n: 2, t: 300, r: [[P(B), 250]] });
    await wait(2 * TALLY_GRACE_S);
    await consolidateAll({ reread: true });
    assert.deepEqual(tallyOf(p.made), said ? { Fiches: { late: 1, keys: [P(B)] } } : {});
  });
}
