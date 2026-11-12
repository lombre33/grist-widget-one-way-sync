// SOURCE : colonnes ajoutées après coup aux tables d'un export (voir logic/new-columns.js, source/new-columns.js) et ce que l'export dit des
// colonnes qui ont changé (renommée sans doute, autre type). Un document en mémoire, un export sans destinataire. Puis la logique pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { driftDetails, exportTables } from '../../js/engine/logic/exports.js';
import { exportFlags, knownColumns, newColumns, widenedSelection } from '../../js/engine/logic/new-columns.js';
import { readSchema } from '../../js/engine/port.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { autoSendNewColumns, baselineNewColumns, dismissNewColumns, pendingColumns, sendNewColumns } from '../../js/engine/source/new-columns.js';
import { readSourceNote, syncRows } from '../../js/engine/source/synchro.js';
import { setExport } from '../../js/engine/logic/notes.js';
import { updateSourceNote } from '../../js/engine/source/synchro.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

const COLUMNS = [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }, { id: 'Age', type: 'Int' }];

// Un document SOURCE avec une table Fiches et un export qui n'envoie que `columns` ; `autoCols` : il envoie seul les colonnes à venir.
async function exported(tag, { columns = ['Nom', 'Ville'], autoCols = false } = {}) {
  const world = fakeWorld();
  const source = fakeDoc({ docId: `source${tag}docx`, name: `Source ${tag}`, email: 'source@fake.local' });
  source.addTable('Fiches', COLUMNS, [{ Nom: 'Alice', Ville: 'Lyon', Age: 30 }]);
  startEngine({ port: world.port(source), version: '9.9.9' });
  const saved = await saveChosenExport({ name: 'Fiches', autoCols, selection: [{ table: 'Fiches', columns, filter: null }] });
  const expOf = async () => {
    const schema = await readSchema();
    return { ...readSourceNote(schema).exports.find(e => e.id === saved.id), tables: exportTables(await syncRows(), saved.id), recipients: [] };
  };
  return { source, saved, expOf };
}
const sentIds = exp => exp.tables[0].columns.map(c => c.id);

test('l\'export note les colonnes envoyables qu\'il connaît, envoyées ou non', async () => {
  const { expOf } = await exported('nc1');
  const exp = await expOf();
  assert.deepEqual(exp.known, { Fiches: ['Nom', 'Ville', 'Age'] });
  assert.deepEqual(await pendingColumns(exp), [], 'une colonne choisie de ne pas envoyer est un choix : rien à dire');
});

test('une colonne ajoutée après coup est dite, puis envoyée, ignorée ou envoyée seule', async (t) => {
  await t.test('dite, pas envoyée', async () => {
    const { source, expOf } = await exported('nc2');
    source.apply([['AddColumn', 'Fiches', 'Pays', { type: 'Text' }]]);
    assert.deepEqual(await pendingColumns(await expOf()), [{ table: 'Fiches', columns: [{ id: 'Pays', type: 'Text' }] }]);
    assert.deepEqual(sentIds(await expOf()), ['Nom', 'Ville']);
  });
  await t.test('« Envoyer ces colonnes » enregistre l\'export avec elle et la rend connue', async () => {
    const { source, expOf } = await exported('nc3');
    source.apply([['AddColumn', 'Fiches', 'Pays', { type: 'Text' }]]);
    const result = await sendNewColumns(await expOf());
    assert.notEqual(result, false);
    const exp = await expOf();
    assert.deepEqual(sentIds(exp), ['Nom', 'Ville', 'Pays'], 'la colonne s\'ajoute aux autres, rien d\'autre ne bouge');
    assert.deepEqual(exp.known.Fiches.sort(), ['Age', 'Nom', 'Pays', 'Ville']);
    assert.deepEqual(await pendingColumns(exp), []);
    assert.equal(await sendNewColumns(exp), false, 'rien de nouveau : rien n\'est enregistré');
  });
  await t.test('« Ne pas les envoyer » les range parmi les colonnes connues', async () => {
    const { source, expOf } = await exported('nc4');
    source.apply([['AddColumn', 'Fiches', 'Pays', { type: 'Text' }]]);
    await dismissNewColumns(await expOf());
    assert.deepEqual(sentIds(await expOf()), ['Nom', 'Ville']);
    assert.deepEqual(await pendingColumns(await expOf()), []);
  });
  await t.test('un export qui les envoie seul (autoCols) le fait au passage, les autres non', async () => {
    const auto = await exported('nc5', { autoCols: true });
    assert.equal((await auto.expOf()).autoCols, true);
    auto.source.apply([['AddColumn', 'Fiches', 'Pays', { type: 'Text' }]]);
    assert.equal(await autoSendNewColumns([await auto.expOf()]), true);
    assert.deepEqual(sentIds(await auto.expOf()), ['Nom', 'Ville', 'Pays']);
    assert.equal(await autoSendNewColumns([await auto.expOf()]), false, 'rien de nouveau');
    const manual = await exported('nc6');
    manual.source.apply([['AddColumn', 'Fiches', 'Pays', { type: 'Text' }]]);
    assert.equal(await autoSendNewColumns([await manual.expOf()]), false);
    assert.deepEqual(sentIds(await manual.expOf()), ['Nom', 'Ville']);
  });
});

test('un export d\'avant ce suivi reçoit sa référence sans rien dire', async () => {
  const { source, expOf, saved } = await exported('nc7');
  await updateSourceNote(note => setExport(note, saved.id, { known: undefined }));
  source.apply([['AddColumn', 'Fiches', 'Pays', { type: 'Text' }]]);
  assert.deepEqual(await pendingColumns(await expOf()), [], 'sans référence : rien n\'est dit');
  assert.equal(await baselineNewColumns([await expOf()]), true);
  const exp = await expOf();
  assert.deepEqual(exp.known.Fiches.sort(), ['Age', 'Nom', 'Pays', 'Ville']);
  assert.deepEqual(await pendingColumns(exp), [], 'la colonne arrivée avant la référence compte comme un choix');
  assert.equal(await baselineNewColumns([exp]), false, 'une seule fois');
});

test('logique : colonnes nouvelles, choix élargi, ce que l\'export envoie en plus', async (t) => {
  const schema = { has: id => id === 'T', columns: () => [{ colId: 'A', type: 'Text' }, { colId: 'B', type: 'Text' }, { colId: 'C', type: 'Int' }, { colId: 'MajLe', type: 'Numeric' }] };
  await t.test('newColumns', () => {
    const tables = [{ table: 'T', columns: [{ id: 'A' }] }, { table: 'Absente', columns: [{ id: 'A' }] }];
    assert.deepEqual(newColumns(schema, tables, { T: ['A', 'B'] }), [{ table: 'T', columns: [{ id: 'C', type: 'Int' }] }]);
    assert.deepEqual(newColumns(schema, tables, null), []);
    assert.deepEqual(newColumns(schema, tables, { Autre: ['A'] }), [], 'table que la référence ne cite pas');
    assert.deepEqual(knownColumns(schema, tables), { T: ['A', 'B', 'C'] });
  });
  await t.test('widenedSelection garde les filtres', () => {
    const filter = { mode: 'all', conds: [] };
    assert.deepEqual(widenedSelection([{ table: 'T', columns: [{ id: 'A' }], filter }, { table: 'U', columns: [{ id: 'X' }] }], [{ table: 'T', columns: ['C'] }]),
      [{ table: 'T', filter, columns: ['A', 'C'] }, { table: 'U', filter: null, columns: ['X'] }]);
  });
  await t.test('exportFlags', () => {
    assert.deepEqual(exportFlags([{ columns: [{ id: 'A' }] }]), { links: false, style: false, notes: false, tableNote: false, formulas: false });
    assert.deepEqual(exportFlags([{ columns: [{ id: 'A', link: 'x', fmt: true, desc: '', tdesc: 'T', fx: '' }] }]), { links: true, style: true, notes: true, tableNote: true, formulas: true });
  });
});

test('driftDetails : colonne disparue (renommée sans doute), autre type, affichage changé', () => {
  const col = (id, source, visible = '') => ({ id, type: source.split(':')[0] === 'Ref' ? 'Text' : source, source, visible });
  const cols = list => ({ has: () => true, columns: () => list.map(c => ({ colId: c.id, type: c.source, visible: c.visible })) });
  const sent = [{ table: 'T', columns: [col('Ville', 'Text'), col('Age', 'Int'), col('Lieu', 'Ref:Villes', 'Nom')] }];
  // Ville renommée en Commune, Age devenue Text, Lieu affiche une autre colonne.
  const schema = cols([col('Commune', 'Text'), col('Age', 'Text'), col('Lieu', 'Ref:Villes', 'Code')]);
  assert.deepEqual(driftDetails(schema, sent), [
    { table: 'T', id: 'Ville', kind: 'gone', to: 'Commune' },
    { table: 'T', id: 'Age', kind: 'retyped', was: 'Int', now: 'Text' },
    { table: 'T', id: 'Lieu', kind: 'shown' },
  ]);
  // Deux pendants possibles : aucune supposition.
  assert.deepEqual(driftDetails(cols([col('Commune', 'Text'), col('Ville2', 'Text')]), [{ table: 'T', columns: [col('Ville', 'Text')] }]), [{ table: 'T', id: 'Ville', kind: 'gone' }]);
  // Deux colonnes disparues du même type : aucune supposition non plus.
  assert.deepEqual(driftDetails(cols([col('Commune', 'Text')]), [{ table: 'T', columns: [col('Ville', 'Text'), col('Pays', 'Text')] }]).map(d => d.to), [undefined, undefined]);
  assert.deepEqual(driftDetails({ has: () => false, columns: () => [] }, sent), [], 'table perdue : dite ailleurs');
});
