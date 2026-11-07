// Estimation d'un envoi (SOURCE) : poids d'une ligne, lots, durée, texte de la durée.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINE_OVERHEAD, LONG_SECONDS, LOT_SECONDS, durationParts, estimateSend, lineBytes, sizeParts, tableCost } from '../../js/engine/logic/estimate.js';
import { BUDGET_WINDOW, RESEND_BUDGET, RESEND_CHUNK } from '../../js/engine/logic/resend.js';
import { LOT_MAX } from '../../js/engine/logic/formulas.js';

test('poids d\'une ligne du lot : valeurs, nom des colonnes répété, surcoût de la ligne', () => {
  assert.equal(lineBytes([]), LINE_OVERHEAD);
  assert.equal(lineBytes([null, undefined]), LINE_OVERHEAD);
  const row = { Nom: 'Durand', Ville: 'Lyon' };
  assert.equal(lineBytes([row]), JSON.stringify(row).length + LINE_OVERHEAD);
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Colonne_${i}`, 'valeur']));
  assert.ok(lineBytes([wide]) > 8 * lineBytes([row]) / 2, 'plus de colonnes, plus lourd');
});

test('coût d\'une table : tranches de 200 lignes si elles tiennent dans un lot, sinon plus petites après un premier lot coupé', () => {
  assert.deepEqual(tableCost({ rows: 0, bytesPerLine: 500 }), { rows: 0, bytes: 0, lots: 0, perLot: RESEND_CHUNK });
  const small = tableCost({ rows: 1000, bytesPerLine: 500 });
  assert.equal(small.lots, 5, '1000 lignes en 5 tranches de 200');
  assert.equal(small.bytes, 500000);
  const big = tableCost({ rows: 30000, bytesPerLine: 1253 });
  assert.equal(RESEND_CHUNK * 1253 > LOT_MAX, true);
  assert.equal(big.perLot, Math.floor(Math.floor(LOT_MAX / 1253) * 0.9), 'les tranches suivantes tiennent dans un lot avec de la marge');
  assert.equal(big.lots, Math.ceil(30000 / big.perLot) + 1, 'un lot coupé au premier envoi, puis des tranches qui tiennent');
  assert.ok(big.bytes > 30000 * 1253, 'le lot coupé a pesé sur le budget');
  assert.equal(tableCost({ rows: 3, bytesPerLine: 2 * LOT_MAX }).perLot, 1, 'une ligne plus grosse qu\'un lot part seule');
});

test('durée : au moins le temps des lots, au moins ce que le budget laisse passer (fenêtre glissante)', () => {
  const none = estimateSend({ tables: [{ rows: 0, bytesPerLine: 100 }] });
  assert.deepEqual([none.rows, none.bytes, none.lots, none.seconds], [0, 0, 0, 0]);
  const few = estimateSend({ tables: [{ rows: 400, bytesPerLine: 300 }] });
  assert.equal(few.lots, 2);
  assert.equal(few.seconds, 2 * LOT_SECONDS, 'sous le budget : seul le temps des lots compte');
  const one = estimateSend({ tables: [{ rows: 30000, bytesPerLine: 1253 }], recipients: 1 });
  const three = estimateSend({ tables: [{ rows: 30000, bytesPerLine: 1253 }], recipients: 3 });
  assert.equal(three.bytes, 3 * one.bytes, 'une copie par destinataire, comme le budget');
  assert.equal(three.seconds, Math.round((three.bytes / RESEND_BUDGET - 1) * BUDGET_WINDOW), 'trois destinataires : le budget décide');
  assert.ok(three.seconds > 3 * one.seconds - 1, 'plus de destinataires, plus long');
  assert.ok(three.seconds > LONG_SECONDS);
  const two = estimateSend({ tables: [{ rows: 100, bytesPerLine: 200 }, { rows: 300, bytesPerLine: 200 }] });
  assert.equal(two.rows, 400);
  assert.equal(two.lots, 3, 'les lots de chaque table s\'ajoutent');
  assert.equal(estimateSend({ tables: [{ rows: 10, bytesPerLine: 10 }], recipients: 0 }).recipients, 1, 'au moins un destinataire');
});

test('durée et poids dits à une personne', () => {
  assert.deepEqual(durationParts(20), { h: 0, min: 0 });
  assert.deepEqual(durationParts(75), { h: 0, min: 1 });
  assert.deepEqual(durationParts(7 * 60 + 10), { h: 0, min: 7 });
  assert.deepEqual(durationParts(27 * 60), { h: 0, min: 25 }, 'par pas de 5 minutes jusqu\'à une heure');
  assert.deepEqual(durationParts(83 * 60), { h: 1, min: 20 }, 'par pas de 10 minutes ensuite');
  assert.deepEqual(durationParts(2 * 3600), { h: 2, min: 0 });
  assert.deepEqual(sizeParts(33200000), { n: 33, unit: 'MB' });
  assert.deepEqual(sizeParts(850000), { n: 850, unit: 'KB' });
  assert.deepEqual(sizeParts(10), { n: 1, unit: 'KB' });
});
