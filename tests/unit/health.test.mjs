// Où en est l'envoi d'un export (SOURCE) : une phrase, avec la raison quand rien ne bouge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportFlow, flowMoves } from '../../js/engine/logic/health.js';
import { LEASE_S, parseCharge, startProg, addProg } from '../../js/engine/logic/resend.js';

const E = '0123456789abcdef';
const NOW = 10000;
const idle = parseCharge('');
const running = (extra = {}) => ({ ...idle, par: 'n1.a', le: NOW - 5, prog: { ...startProg(E, 1000, 5, NOW - 100), table: 'Contacts' }, ...extra });
const flow = (over = {}) => exportFlow({ exportId: E, owed: 0, recipients: ['active'], charge: idle, page: 'n1.a', now: NOW, ...over });

test('rien à envoyer : aucun message', () => {
  assert.equal(flow(), null);
  assert.equal(flow({ recipients: ['error'] }), null, 'une erreur sans rien d\'en retard se dit sur la fiche du destinataire');
  assert.equal(flowMoves(null), false);
});

test('un envoi qui tourne : où il en est, le même texte pour cette page et pour une autre', () => {
  const charge = running();
  charge.prog = addProg(charge.prog, { rows: 250, bytes: 300000, now: NOW - 50 });
  const mine = flow({ charge });
  assert.equal(mine.key, 'running');
  assert.deepEqual([mine.vars.done, mine.vars.total, mine.vars.pct, mine.vars.lot, mine.vars.lots, mine.vars.table], [250, 1000, 25, 2, 5, 'Contacts']);
  assert.ok(mine.vars.left > 0, 'temps restant estimé');
  assert.equal(flow({ charge, page: 'n2.b' }).key, 'runningOther', 'une autre page ou une autre personne');
  assert.equal(flowMoves(mine), true);
  const other = exportFlow({ exportId: 'ffffffffffffffff', owed: 0, recipients: ['active'], charge, page: 'n1.a', now: NOW });
  assert.equal(other, null, 'un autre export, rien en retard : rien à dire');
});

test('lots prévus : jamais moins que ceux déjà partis', () => {
  const charge = running();
  charge.prog = { ...charge.prog, lots: 6, lotsTotal: 5 };
  const f = flow({ charge });
  assert.deepEqual([f.vars.lot, f.vars.lots], [7, 7], 'un lot coupé en a refait : le total s\'ajuste');
});

test('pause du budget : l\'heure de reprise et ce qui est déjà parti', () => {
  const f = flow({ charge: running({ reprise: NOW + 240 }) });
  assert.equal(f.key, 'budget');
  assert.equal(f.vars.at, NOW + 240);
  assert.equal(flowMoves(f), true);
  assert.equal(flow({ charge: { ...idle, par: 'n2.b', le: NOW - 1, reprise: NOW + 60 }, owed: 1 }).key, 'budgetWait', 'un renvoi d\'un autre export attend le budget');
});

test('un renvoi sans signe de vie depuis LEASE_S secondes ne tourne plus', () => {
  const stale = running({ le: NOW - LEASE_S });
  assert.equal(flow({ charge: stale }), null, 'rien en retard : rien à dire');
  const f = flow({ charge: stale, owed: 1 });
  assert.equal(f.key, 'interrupted', 'page fermée en route : où il s\'est arrêté');
  assert.deepEqual([f.vars.done, f.vars.total], [0, 1000]);
  assert.equal(flowMoves(f), false);
});

test('pourquoi rien ne part : tout en pause, destinataire en erreur, ou le rattrapage va s\'en charger', () => {
  assert.deepEqual(flow({ owed: 2, recipients: ['paused', 'paused'] }), { key: 'paused', vars: { n: 2 } });
  assert.deepEqual(flow({ owed: 1, recipients: ['active', 'error', 'error'] }), { key: 'blocked', vars: { n: 2 } });
  assert.equal(flow({ owed: 1, recipients: ['paused', 'error'] }).key, 'blocked', 'un destinataire en pause ne compte pas, un en erreur bloque');
  assert.equal(flow({ owed: 1, recipients: ['paused', 'active'] }).key, 'waiting');
  const waiting = flow({ owed: 3, lastPass: { at: 12345 } });
  assert.deepEqual(waiting, { key: 'waiting', vars: { n: 3, at: 12345 } });
  assert.equal(flowMoves(waiting), true);
  assert.equal(flowMoves(flow({ owed: 1, recipients: ['error'] })), false, 'bloqué : rien ne bouge seul');
  assert.equal(flow({ owed: 1, charge: { ...idle, par: 'n2.b', le: NOW - 1 } }).key, 'queued', 'un autre envoi passe d\'abord');
});
