// Logique de la CIBLE en charge : 30 000 lignes de 20 et de 40 colonnes, comme les envoie la SOURCE
// (lots de 250 ko), dépliées, recopiées, purgées. Pas de Grist ici : ce que ces tests gardent, c'est
// que rien ne se perd ni ne devient lent quand la table grossit, et la taille des écritures que le widget
// demande à Grist. Les essais dans un vrai Grist sont dans tests/e2e/charge.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expandRows, planPurge, planUnpack, rowsByTable } from '../../js/engine/logic/journal.js';
import { planConsolidation } from '../../js/engine/logic/consolidation.js';
import { KIND } from '../../js/engine/logic/common.js';

const LOT_MAX = 250000; // octets d'un lot (formule du lot de la SOURCE)
const NOW = 2e9;

// Colonnes de texte et de nombres, comme une vraie table.
const columns = n => Array.from({ length: n }, (_, i) => ({ id: `Col${i}`, type: i % 4 === 0 ? 'Numeric' : 'Text', label: `Col${i}` }));
const lineOf = (cols, i, key = randomUUID()) => [key, 1.7e9 + i, false, Object.fromEntries(cols.map((c, k) => [c.id, k % 4 === 0 ? i * 1.25 : `valeur ${i} colonne ${k} texte`]))];

// Lots comme la formule de la SOURCE les coupe (le premier venu part même s'il dépasse).
function lotsOf(lines) {
  const lots = [];
  let cur = [];
  let size = 0;
  for (const line of lines) {
    const n = JSON.stringify(line).length;
    if (cur.length && size + n > LOT_MAX) { lots.push(cur); cur = []; size = 0; }
    cur.push(line);
    size += n;
  }
  if (cur.length) lots.push(cur);
  return lots;
}
// Lignes brutes telles que le webhook les dépose dans le journal.
const rawLots = (lots, cols, total) => lots.map((lot, k) => ({
  id: k + 1, Synchro_Export: 'e', Synchro_Table: 'Contacts', Synchro_Type: KIND.lot, Synchro_Colonnes: JSON.stringify(cols), Synchro_Lot: JSON.stringify({ lignes: lot, total }),
  Synchro_Ids: '', Synchro_Renvoi: '', Sync_Recu: 1,
}));
const bytes = actions => JSON.stringify(actions).length;
const copyColsOf = cols => cols.map(c => [c.id, c.id]);

for (const [rows, cols] of [[30000, 20], [30000, 40]]) {
  test(`${rows} lignes × ${cols} colonnes : dépliage, recopie, purge, rien ne manque`, () => {
    const cs = columns(cols);
    const lines = Array.from({ length: rows }, (_, i) => lineOf(cs, i));
    const raw = rawLots(lotsOf(lines), cs, rows);
    const t0 = performance.now();
    // Page ouverte après l'envoi : tous les lots sont là d'un coup (500 au plus par passage).
    const plan = planUnpack(raw, 'J', { exportId: 'e', max: 500, now: NOW });
    assert.equal(plan.added.length, rows, 'toutes les lignes sont dépliées');
    assert.equal(plan.left, 0);
    assert.equal(plan.rejected, 0);
    const journal = plan.added.map((r, i) => ({ id: raw.length + i + 1, ...r }));
    const tableRows = rowsByTable(expandRows(journal)).get('Contacts');
    const out = planConsolidation({ journalRows: tableRows, destRows: [], copyCols: copyColsOf(cs), destTable: 'Contacts', journalTable: 'J', now: NOW });
    assert.deepEqual(out.stats, { added: rows, updated: 0, removed: 0 });
    assert.ok(performance.now() - t0 < 10000, 'dépliage et recopie en moins de 10 s');
    // Rejouée après application (versions marquées), la recopie ne fait rien : idempotente.
    const applied = tableRows.map(r => ({ ...r, Sync_Applique: true }));
    const dest = tableRows.map((r, i) => ({ id: i + 1, id_sync: r.id_sync, ...Object.fromEntries(cs.map(c => [c.id, r[c.id]])) }));
    const again = planConsolidation({ journalRows: applied, destRows: dest, copyCols: copyColsOf(cs), destTable: 'Contacts', journalTable: 'J', now: NOW });
    assert.deepEqual(again.stats, { added: 0, updated: 0, removed: 0 });
    assert.deepEqual(again.actions, []);
    // Purge : une seule version par clé reste.
    const purged = planPurge([...applied, ...raw.slice(0, 0)], 'J');
    assert.equal(purged.flatMap(a => a[2]).length, 0, 'rien à effacer : une version par clé');
  });
}

test('une clé en double dans la SOURCE : une seule ligne ici, la plus récente', () => {
  const cs = columns(3);
  const same = 'cle-en-double';
  const lines = [lineOf(cs, 1, same), lineOf(cs, 2, same), lineOf(cs, 3)];
  const plan = planUnpack(rawLots([lines], cs, 3), 'J', { exportId: 'e', now: NOW });
  const journal = plan.added.map((r, i) => ({ id: i + 1, ...r }));
  const out = planConsolidation({ journalRows: rowsByTable(expandRows(journal)).get('Contacts'), destRows: [], copyCols: copyColsOf(cs), destTable: 'Contacts', journalTable: 'J', now: NOW });
  assert.equal(out.stats.added, 2, 'trois lignes envoyées, deux clés');
});
