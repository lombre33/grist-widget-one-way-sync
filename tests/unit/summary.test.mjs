// SOURCE : les tables de résumé de Grist dans un export (voir logic/summary.js). Grist n'y accepte aucune colonne de données : la clé et MajLe
// sont des formules. Le document en mémoire (engine-fake) refuse comme lui une colonne de données dans un résumé. Puis la logique pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { schemaFrom } from '../../js/engine/logic/schema.js';
import { exportTables, exportableColumns, readTables } from '../../js/engine/logic/exports.js';
import { summaryActions, summaryKeyFormula, summaryMajleFormula, summaryTables } from '../../js/engine/logic/summary.js';
import { RECALC_SPEC } from '../../js/engine/logic/formulas.js';
import { readSchema } from '../../js/engine/port.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { startReturn } from '../../js/engine/source/invite.js';
import { repairKeys } from '../../js/engine/source/keys.js';
import { readSourceNote, refreshMajLe, syncRows } from '../../js/engine/source/synchro.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

const FICHES = [{ id: 'Ville', type: 'Text' }, { id: 'Service', type: 'Text' }, { id: 'Montant', type: 'Numeric' }];
const AGGREGATES = [{ id: 'count', type: 'Int' }, { id: 'Montant', type: 'Numeric' }];

// Un document SOURCE avec Fiches et son résumé par Ville (Fiches_summary_Ville), les lignes calculées posées à la main.
function summarized(tag) {
  const world = fakeWorld();
  const source = fakeDoc({ docId: `source${tag}docx`, name: `Source ${tag}`, email: 'source@fake.local' });
  source.addTable('Fiches', FICHES, [{ Ville: 'Pau', Service: 'A', Montant: 10 }, { Ville: 'Lyon', Service: 'A', Montant: 30 }]);
  source.addSummary('Fiches_summary_Ville', 'Fiches', ['Ville'], AGGREGATES, [{ Ville: 'Pau', count: 1, Montant: 10 }, { Ville: 'Lyon', count: 1, Montant: 30 }]);
  startEngine({ port: world.port(source), version: '9.9.9' });
  return { source, world };
}
const SUMMARY = 'Fiches_summary_Ville';
const colsOf = async table => (await readSchema()).columns(table);
const named = (cols, id) => cols.find(c => c.colId === id);

test('le schéma reconnaît une table de résumé : regroupement, table résumée, colonne group', async () => {
  summarized('s1');
  const schema = await readSchema();
  assert.deepEqual(schema.summary(SUMMARY), { source: 'Fiches', by: ['Ville'] });
  assert.equal(schema.summary('Fiches'), null);
  assert.ok(schema.sourceTableIds.includes(SUMMARY), 'une SOURCE peut l\'envoyer');
  assert.ok(!schema.tableIds.includes(SUMMARY), 'une CIBLE n\'y écrit pas : elle n\'est pas une destination');
  assert.ok(schema.tableIds.includes('Fiches'));
  const cols = await colsOf(SUMMARY);
  assert.equal(named(cols, 'group').summaryGroup, true);
  assert.equal(named(cols, 'Ville').summaryBy, true);
  assert.equal(named(cols, 'count').summaryBy, false);
  assert.equal((await colsOf('Fiches')).some(c => c.summaryGroup || c.summaryBy), false, 'une table ordinaire n\'a rien de tel');
});

test('un schéma sans table de résumé : sourceTableIds est tableIds, une colonne nommée group n\'est pas la liste des lignes', () => {
  const schema = schemaFrom([{ id: 1, tableId: 'Fiches', summarySourceTable: 0 }, { id: 2, tableId: 'GristHidden_x', summarySourceTable: 0 }],
    [{ id: 1, parentId: 1, parentPos: 1, colId: 'group', type: 'Text', summarySourceCol: 0 }]);
  assert.deepEqual(schema.sourceTableIds, ['Fiches']);
  assert.deepEqual(schema.tableIds, ['Fiches']);
  assert.equal(schema.columns('Fiches')[0].summaryGroup, undefined, 'une table ordinaire garde sa colonne group');
});

test('les colonnes offertes sont celles du résumé, sans la colonne group', async () => {
  summarized('s2');
  const cols = exportableColumns(await colsOf(SUMMARY));
  assert.deepEqual(cols.map(c => c.id), ['Ville', 'count', 'Montant']);
  assert.deepEqual(cols.map(c => c.type), ['Text', 'Int', 'Numeric']);
});

test('créer un export d\'une table de résumé : clé, MajLe et RecalculLe sont des formules, aucune colonne de données', async () => {
  const { source } = summarized('s3');
  await saveChosenExport({ name: 'Résumé', selection: [{ table: SUMMARY, columns: ['Ville', 'count', 'Montant'], filter: null }] });
  const cols = await colsOf(SUMMARY);
  for (const id of ['id_sync', 'MajLe', 'RecalculLe']) assert.equal(named(cols, id).isFormula, true, `${id} est une formule`);
  assert.equal(named(cols, 'id_sync').formula, summaryKeyFormula(['Ville']));
  assert.match(named(cols, 'MajLe').formula, /\("count", ""\), \("id_sync", ""\)|\("Montant", ""\)/);
  assert.equal(named(cols, 'RecalculLe').formula, RECALC_SPEC.formula);
  // Rien n'a été écrit dans les lignes du résumé (aucun remplissage de clé, Grist les calcule).
  assert.ok(!source.log.some(a => /Record/.test(a[0]) && a[1] === SUMMARY), 'aucune écriture dans les lignes du résumé');
});

test('un export de la table résumée et de son résumé : la table ordinaire garde ses colonnes de données', async () => {
  summarized('s4');
  await saveChosenExport({ name: 'Les deux', selection: [{ table: 'Fiches', columns: ['Ville', 'Montant'], filter: null }, { table: SUMMARY, columns: ['Ville', 'Montant'], filter: null }] });
  const fiches = await colsOf('Fiches');
  assert.equal(named(fiches, 'id_sync').isFormula, false, 'la table ordinaire : clé de données posée à la création');
  assert.equal(named(await colsOf(SUMMARY), 'id_sync').isFormula, true);
});

test('refreshMajLe : MajLe d\'un résumé suit les colonnes envoyées, et rien ne bouge quand rien n\'a changé', async () => {
  const { source } = summarized('s5');
  await saveChosenExport({ name: 'Résumé', selection: [{ table: SUMMARY, columns: ['Ville', 'count'], filter: null }] });
  assert.equal(await refreshMajLe(), false, 'à jour : rien à écrire (une formule réécrite renverrait toute la table)');
  const before = named(await colsOf(SUMMARY), 'MajLe').formula;
  assert.ok(!/"Montant"/.test(before), 'une colonne non envoyée n\'y est pas lue');
  // Un second export envoie aussi Montant : l'enregistrement remet MajLe d'accord (saveExport appelle refreshMajLe), la formule la lit.
  await saveChosenExport({ name: 'Montants', selection: [{ table: SUMMARY, columns: ['Ville', 'Montant'], filter: null }] });
  assert.match(named(await colsOf(SUMMARY), 'MajLe').formula, /"Montant"/);
  assert.equal(await refreshMajLe(), false, 'puis stable');
  // Une colonne de plus à suivre, constatée plus tard (formule remise à la main sur l'ancienne) : refreshMajLe la réécrit.
  source.apply([['ModifyColumn', SUMMARY, 'MajLe', { type: 'DateTime:UTC', isFormula: true, formula: before }]]);
  assert.equal(await refreshMajLe(), true, 'MajLe réécrite');
  assert.equal(named(await colsOf(SUMMARY), 'MajLe').formula.includes('"Montant"'), true);
  const summaryTable = source.fetchRows('_grist_Tables').find(tb => tb.tableId === SUMMARY).id;
  const ownColumns = new Set(source.fetchRows('_grist_Tables_column').filter(c => c.parentId === summaryTable).map(c => c.id));
  assert.ok(!source.log.some(a => a[0] === 'UpdateRecord' && a[1] === '_grist_Tables_column' && ownColumns.has(a[2]) && a[3].recalcDeps), 'MajLe d\'un résumé n\'est jamais posée par recalcDeps');
});

test('la formule de clé d\'un regroupement changé (que Grist recopie avec l\'ancienne) est remise d\'accord', async () => {
  const { source } = summarized('s6');
  await saveChosenExport({ name: 'Résumé', selection: [{ table: SUMMARY, columns: ['Ville', 'count'], filter: null }] });
  // Grist a recopié les colonnes du widget dans la nouvelle table de résumé, avec l'ancienne formule de clé.
  const stale = [...(await colsOf(SUMMARY))];
  source.addSummary('Fiches_summary_Service_Ville', 'Fiches', ['Service', 'Ville'], AGGREGATES, []);
  for (const c of stale.filter(x => ['id_sync', 'MajLe', 'RecalculLe'].includes(x.colId))) {
    source.apply([['AddColumn', 'Fiches_summary_Service_Ville', c.colId, { type: c.type, isFormula: true, formula: c.formula }]]);
  }
  const fresh = (await colsOf('Fiches_summary_Service_Ville'));
  assert.equal(named(fresh, 'id_sync').formula, summaryKeyFormula(['Ville']), 'départ : la clé ne lit que Ville');
  assert.deepEqual((await readSchema()).summary('Fiches_summary_Service_Ville').by, ['Service', 'Ville']);
  await repairKeys('Fiches_summary_Service_Ville');
  assert.equal(named(await colsOf('Fiches_summary_Service_Ville'), 'id_sync').formula, summaryKeyFormula(['Service', 'Ville']), 'la clé lit les deux colonnes');
  assert.equal(await repairKeys('Fiches_summary_Service_Ville') >= 0, true);
});

test('pas d\'Échange avec une table de résumé : refusé à l\'invitation et à la modification d\'un export en Échange', async () => {
  summarized('s7');
  const saved = await saveChosenExport({ name: 'Résumé', selection: [{ table: SUMMARY, columns: ['Ville', 'count'], filter: null }] });
  const exp = { ...readSourceNote(await readSchema()).exports.find(e => e.id === saved.id), tables: exportTables(await syncRows(), saved.id), recipients: [], invitations: [] };
  await assert.rejects(() => startReturn(exp), (e) => { assert.equal(e.message, 'exchangeSummary'); assert.equal(e.vars.tables, SUMMARY); return true; });
  await assert.rejects(() => saveChosenExport({ exp: { ...exp, echange: true }, name: 'Résumé', selection: [{ table: SUMMARY, columns: ['Ville'], filter: null }] }),
    e => e.message === 'exchangeSummary');
});

test('summaryTables : les tables de résumé parmi des tables, rien pour un schéma qui n\'en connaît pas', async () => {
  summarized('s8');
  const schema = await readSchema();
  assert.deepEqual(summaryTables(schema, ['Fiches', SUMMARY]), [SUMMARY]);
  assert.deepEqual(summaryTables({ has: () => true }, ['Fiches']), [], 'un port d\'avant n\'a pas `summary`');
});

test('lien public : la table que résume un résumé compte parmi celles qui sont lues', async () => {
  summarized('s9');
  const schema = await readSchema();
  const tables = [{ table: SUMMARY, columns: [{ id: 'Ville', source: 'Text' }] }];
  assert.deepEqual(readTables(tables), [SUMMARY]);
  assert.deepEqual(readTables(tables, schema), [SUMMARY, 'Fiches'], 'une règle qui cache des lignes de Fiches cache aussi ce que le résumé en dit');
});

test('formule de clé : une empreinte des valeurs du regroupement, dans l\'ordre de la table', () => {
  assert.equal(summaryKeyFormula(['Ville']), 'import hashlib\nreturn hashlib.sha1(repr([rec.Ville]).encode("utf-8")).hexdigest()');
  assert.match(summaryKeyFormula(['Dir', 'Jour', 'Ville']), /repr\(\[rec\.Dir, rec\.Jour, rec\.Ville\]\)/);
});

test('formule de MajLe : lit la clé et les colonnes envoyées, triées et sans doublon, avec le texte affiché d\'une Référence', () => {
  const cols = [{ colId: 'Ville' }, { colId: 'Dir', visible: 'Nom' }, { colId: 'count' }, { colId: 'id_sync' }, { colId: 'MajLe' }, { colId: 'RecalculLe' }];
  const formula = summaryMajleFormula(cols, ['count', 'Ville', 'Dir', 'count', 'MajLe', 'inconnue']);
  assert.match(formula, /\[\("id_sync", ""\), \("Dir", "Nom"\), \("Ville", ""\), \("count", ""\)\]/);
  assert.ok(!formula.includes('inconnue') && !formula.includes('"MajLe"'), 'une colonne absente ou du widget n\'est pas lue');
  assert.equal(formula, summaryMajleFormula(cols, ['Ville', 'count', 'Dir']), 'même choix, même texte, quel que soit l\'ordre');
  assert.match(formula, /except Exception:\n {4}pass/, 'une colonne en erreur ne met pas la ligne en erreur');
});

test('summaryActions : ajoute ce qui manque, corrige une clé périmée, n\'écrit MajLe que sur demande', () => {
  const table = 'T_summary_A';
  const cols = [{ colId: 'A', type: 'Text' }, { colId: 'count', type: 'Int', isFormula: true }];
  const [key, majle, recalc] = summaryActions(table, cols, ['A'], ['A', 'count']);
  assert.deepEqual([key[0], key[2], key[3].isFormula, key[3].type], ['AddColumn', 'id_sync', true, 'Text']);
  assert.deepEqual([majle[0], majle[2], majle[3].isFormula, majle[3].type], ['AddColumn', 'MajLe', true, 'DateTime:UTC']);
  assert.deepEqual(recalc, ['AddColumn', table, 'RecalculLe', RECALC_SPEC]);
  const done = summaryActions(table, cols, ['A'], ['A', 'count']).map(([, , id, spec]) => ({ colId: id, type: spec.type, isFormula: true, formula: spec.formula }));
  const ready = [...cols, ...done];
  assert.deepEqual(summaryActions(table, ready, ['A'], ['A', 'count'], { refresh: true }), [], 'à jour : rien');
  // Un regroupement qui a gagné une colonne : la clé est refaite, MajLe pas (sans `refresh`), RecalculLe jamais.
  const stale = summaryActions(table, ready, ['A', 'B'], ['A', 'count']);
  assert.deepEqual(stale.map(a => [a[0], a[2]]), [['ModifyColumn', 'id_sync']]);
  // Une colonne envoyée de plus : MajLe réécrite sur demande seulement.
  assert.deepEqual(summaryActions(table, ready, ['A'], ['A', 'count', 'B']).length, 0);
  const more = [...ready.filter(c => c.colId !== 'count'), { colId: 'count', visible: '' }, { colId: 'B', type: 'Text' }];
  assert.deepEqual(summaryActions(table, more, ['A'], ['A', 'count', 'B'], { refresh: true }).map(a => a[2]), ['MajLe']);
  // Une colonne du widget devenue colonne de données (ou d'un autre type) revient en formule.
  const data = ready.map(c => (c.colId === 'MajLe' ? { ...c, isFormula: false } : c));
  assert.deepEqual(summaryActions(table, data, ['A'], ['A', 'count'], { refresh: true }).map(a => a[2]), ['MajLe']);
});
