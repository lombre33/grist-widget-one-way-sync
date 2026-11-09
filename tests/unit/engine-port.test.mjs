// Le moteur tourne avec un port qui n'est pas celui de Grist (tests/unit/engine-fake.mjs : un document en
// mémoire), avec un préfixe de tables. Aucun navigateur, aucun `grist`. SOURCE : une table devient un
// export. CIBLE : un lot déposé dans le journal est recopié dans sa destination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KEY_COL, KIND, LOT_COL, ORDER_COL, RECALC_COL, SCHEMA_COL, TABLE_COL, TYPE_COL, SYNC_TABLE, journalId } from '../../js/engine/logic/common.js';
import { missingSyncColumns, prepareSourceActions } from '../../js/engine/logic/formulas.js';
import { ownsSync } from '../../js/engine/logic/strays.js';
import { apply, readSchema } from '../../js/engine/port.js';
import { exportTables } from '../../js/engine/logic/exports.js';
import { saveExport, syncRows } from '../../js/engine/source/synchro.js';
import { createJournal, prepareDest } from '../../js/engine/target/journals.js';
import { consolidateAll, state } from '../../js/engine/target/loop.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { fakeDoc, fakePort } from './engine-fake.mjs';

const EXPORT = 'fedcba9876543210';
const COLUMNS = [{ id: 'Nom', type: 'Text', label: 'Nom' }, { id: 'Ville', type: 'Text', label: 'Ville' }];
const PREFIX = 'Gfs_';

test('SOURCE : un export crée la table technique préfixée, ses lignes et ses formules', async () => {
  const doc = fakeDoc();
  startEngine({ port: fakePort(doc), prefix: PREFIX });
  doc.addTable('Contacts', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], [{ Nom: 'Alice', Ville: 'Lyon' }, { Nom: 'Bob', Ville: 'Nice' }]);
  // Ce que fait l'assistant d'export avant d'enregistrer : les colonnes du widget dans la table envoyée.
  await apply(prepareSourceActions('Contacts', missingSyncColumns((await readSchema()).columns('Contacts'))));
  const changed = await saveExport(EXPORT, [{ table: 'Contacts', columns: COLUMNS }]);

  assert.equal(SYNC_TABLE, 'Gfs_Synchro');
  assert.deepEqual(changed.map(tb => tb.table ?? tb), ['Contacts']);
  assert.ok(doc.has('Gfs_Synchro'), 'la table technique porte le préfixe');
  assert.ok(!doc.has('Synchro'), 'l\'ancien nom n\'est pas créé');
  const schema = await readSchema();
  assert.ok(ownsSync(schema), 'le moteur reconnaît sa table');
  const rows = await syncRows();
  assert.deepEqual(rows.map(r => r[TYPE_COL]).sort(), [KIND.keys, KIND.lot, KIND.track].sort());
  assert.ok(rows.every(r => r[EXPORT_COL] === EXPORT && r[TABLE_COL] === 'Contacts'));
  assert.deepEqual(exportTables(rows, EXPORT).map(tb => [tb.table, tb.columns.map(c => c.id)]), [['Contacts', ['Nom', 'Ville']]]);
  // Les formules cherchent dans la table préfixée.
  const lot = schema.columns('Gfs_Synchro').find(c => c.colId === LOT_COL);
  assert.ok(lot.formula.includes('Gfs_Synchro.lookupOne('));
  assert.ok(![...lot.formula.matchAll(/(?<![A-Za-z0-9_])Synchro(?![A-Za-z0-9_])/g)].length);
  // Les colonnes du widget sont dans la table envoyée.
  const have = schema.columns('Contacts').map(c => c.colId);
  for (const id of [KEY_COL, ORDER_COL, RECALC_COL]) assert.ok(have.includes(id), id);
  assert.ok(schema.columns('Gfs_Synchro').some(c => c.colId === SCHEMA_COL));
});

test('CIBLE : un lot déposé dans le journal est recopié dans la destination', async () => {
  const doc = fakeDoc();
  startEngine({ port: fakePort(doc), prefix: PREFIX });
  const journal = journalId('Annuaire', (await readSchema()).tableIds);
  assert.equal(journal, 'Gfs_Journal_Annuaire');
  const entry = { table: 'Contacts', dest: 'Gfs_Contacts', columns: COLUMNS, own: ['Nom', 'Ville'] };
  await createJournal(journal, {
    id: '0123456789abcdef', export: EXPORT, name: 'Annuaire', secret: '', from: { email: 'source@fake.local', docId: 'zyxwvutsrqpo', docName: 'Source' }, tables: [entry], refused: [], missing: {},
  });
  await prepareDest({ dest: entry.dest, columns: COLUMNS });
  assert.deepEqual(receivedJournals(await readSchema()).map(r => r.journal), [journal]);

  // Ce que le webhook dépose : une ligne brute 'lot', comme la formule de la SOURCE la fabrique.
  const lot = (lines, total = lines.length) => doc.addRow(journal, {
    [EXPORT_COL]: EXPORT, [TABLE_COL]: 'Contacts', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: JSON.stringify(COLUMNS), [LOT_COL]: JSON.stringify({ lignes: lines, total }), Sync_Recu: doc.now(),
  });
  lot([['k1', 100, false, { Nom: 'Alice', Ville: 'Lyon' }], ['k2', 100, false, { Nom: 'Bob', Ville: 'Nice' }]]);
  await consolidateAll();
  const names = () => doc.rows('Gfs_Contacts').filter(r => r.Supprime !== true).map(r => `${r[KEY_COL]}:${r.Nom}:${r.Ville}`).sort();
  assert.deepEqual(names(), ['k1:Alice:Lyon', 'k2:Bob:Nice']);
  assert.deepEqual(doc.rows(journal).filter(r => r[TYPE_COL] === KIND.lot), [], 'la ligne brute est dépliée puis effacée');

  // Une modification plus récente, une ligne de plus : la destination suit.
  doc.tick();
  lot([['k1', 200, false, { Nom: 'Alice', Ville: 'Paris' }], ['k3', 200, false, { Nom: 'Chloé', Ville: 'Brest' }]]);
  await consolidateAll({ reread: true });
  assert.deepEqual(names(), ['k1:Alice:Paris', 'k2:Bob:Nice', 'k3:Chloé:Brest']);

  // Ce que l'écran lit : le résultat du dernier passage, sous le nom du journal préfixé.
  const result = state.results.get(`${journal}|Contacts`);
  assert.ok(result && !result.error, JSON.stringify(result));
  assert.equal(doc.has('Journal_Annuaire'), false);
  assert.equal(doc.has('Contacts'), false, 'seul le nom préfixé existe');
});

test('CIBLE : une destination donnée par l\'hôte reste intacte, sans y remettre le préfixe', async () => {
  const doc = fakeDoc();
  startEngine({ port: fakePort(doc), prefix: 'GFS_' });
  const journal = journalId('Dossiers', (await readSchema()).tableIds);
  assert.equal(journal, 'GFS_Journal_Dossiers');
  // L'hôte (un écran de GFS) a choisi l'identifiant exact de la destination : `dest` n'est pas préfixé,
  // le moteur ne le préfixe pas (seul le nom que l'écran de Sync+ propose passe par destTableId).
  const entry = { table: 'Contacts', dest: 'Dossiers_recus', columns: COLUMNS, own: ['Nom', 'Ville'] };
  await createJournal(journal, {
    id: '0123456789abcdef', export: EXPORT, name: 'Dossiers', secret: '', from: { email: 'source@fake.local', docId: 'zyxwvutsrqpo', docName: 'Source' }, tables: [entry], refused: [], missing: {},
  });
  await prepareDest({ dest: entry.dest, columns: COLUMNS });
  assert.ok(doc.has('Dossiers_recus'), 'la destination porte exactement l\'identifiant donné');
  assert.ok(!doc.has('GFS_Dossiers_recus'));

  doc.addRow(journal, {
    [EXPORT_COL]: EXPORT, [TABLE_COL]: 'Contacts', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: JSON.stringify(COLUMNS),
    [LOT_COL]: JSON.stringify({ lignes: [['k1', 100, false, { Nom: 'Alice', Ville: 'Lyon' }]], total: 1 }), Sync_Recu: doc.now(),
  });
  await consolidateAll();
  assert.deepEqual(doc.rows('Dossiers_recus').map(r => `${r[KEY_COL]}:${r.Nom}`), ['k1:Alice']);
  assert.ok(!doc.has('GFS_Dossiers_recus'));
  const result = state.results.get(`${journal}|Contacts`);
  assert.ok(result && !result.error, JSON.stringify(result));
});
