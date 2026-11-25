// Sonde : ce que Grist fait d'une table de résumé (« Résumer » une table par une ou plusieurs colonnes), pour l'envoi des résumés (V0.31.0).
// Elle ne touche pas au widget : ce sont les faits de Grist sur lesquels `js/engine/logic/summary.js` s'appuie, vérifiés dans une vraie instance.
//  1. Un résumé REFUSE toute colonne de données (`cannot add a non-formula column to a summary table`) : ni `id_sync` (UUID à la création), ni `MajLe`
//     (formule de déclenchement, donc une colonne de données) ne peuvent y vivre ; une colonne de FORMULE passe.
//  2. Une clé de formule (empreinte des valeurs du regroupement) est stable : un groupe qui disparaît puis revient reprend sa clé.
//  3. Un `MajLe` de formule qui LIT une colonne n'est recalculé que pour la ligne du groupe touché, et seulement si la colonne lue change.
//  4. Changer le regroupement (`UpdateSummaryViewSection`) crée une AUTRE table de résumé (nouveau nom), à laquelle Grist recopie les colonnes de formule
//     de l'utilisateur avec leur ancienne formule : la clé doit être remise d'accord (`summaryActions`).
// Mode d'emploi : tests/e2e/start-grist.sh, puis  node tests/e2e/tools/probe-summary.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summaryKeyFormula, summaryMajleFormula } from '../../../js/engine/logic/summary.js';

const env = JSON.parse(readFileSync(fileURLToPath(new URL('../.env.json', import.meta.url)), 'utf8'));
const team = `${env.grist}/o/${env.team}`;
const api = async (method, path, body) => {
  const res = await fetch(`${team}/api${path}`, { method, headers: { Authorization: `Bearer ${env.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`), { text });
  return text ? JSON.parse(text) : null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (what) => console.log(`ok · ${what}`);

const workspaces = await api('GET', '/orgs/current/workspaces');
const wsId = workspaces[0] ? workspaces[0].id : await api('POST', '/orgs/current/workspaces', { name: 'W' });
const doc = await api('POST', `/workspaces/${wsId}/docs`, { name: 'Sonde résumé' });
const apply = actions => api('POST', `/docs/${doc}/apply`, actions);
const rows = async table => (await api('GET', `/docs/${doc}/tables/${table}/records`)).records.map(r => ({ id: r.id, ...r.fields }));
const meta = async () => ({ tables: await rows('_grist_Tables'), cols: await rows('_grist_Tables_column') });

try {
  await apply([['AddTable', 'Fiches', [{ id: 'Ville', type: 'Text' }, { id: 'Service', type: 'Text' }, { id: 'Montant', type: 'Numeric' }, { id: 'Note', type: 'Text' }]]]);
  await apply([['BulkAddRecord', 'Fiches', [null, null, null, null], { Ville: ['Pau', 'Pau', 'Lyon', 'Lyon'], Service: ['A', 'B', 'A', 'A'], Montant: [10, 20, 30, 40], Note: ['', '', '', ''] }]]);
  let m = await meta();
  const source = m.tables.find(t => t.tableId === 'Fiches');
  const col = id => m.cols.find(c => c.parentId === source.id && c.colId === id).id;
  const created = await apply([['CreateViewSection', source.id, 0, 'record', [col('Ville')], null]]);
  const section = created.retValues[0].sectionRef;
  m = await meta();
  const summary = m.tables.find(t => t.summarySourceTable === source.id);
  const T = summary.tableId;
  assert.equal(T, 'Fiches_summary_Ville');
  const kinds = m.cols.filter(c => c.parentId === summary.id).map(c => `${c.colId}${c.summarySourceCol ? '*' : ''}${c.isFormula ? 'F' : 'D'}`);
  console.log('colonnes du résumé :', kinds.join(' '));
  assert.ok(kinds.includes('Ville*D'), 'la colonne du regroupement est de données (summarySourceCol)');
  assert.ok(kinds.includes('groupF') && kinds.includes('countF'), 'group et count sont des formules');
  ok(`le résumé ${T} est créé, avec son regroupement, group et count`);

  // 1. Pas de colonne de données dans un résumé.
  for (const [id, spec] of [['id_sync', { type: 'Text', isFormula: false, formula: 'UUID()', recalcWhen: 0 }], ['MajLe', { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 2 }]]) {
    await assert.rejects(() => apply([['AddColumn', T, id, spec]]), e => /non-formula column to a summary table/.test(e.text), `${id} de données refusée`);
  }
  ok('une colonne de données est refusée dans un résumé (id_sync, MajLe)');

  // 2 et 3. Clé et MajLe en formules (celles du widget).
  const cols = [{ colId: 'Ville' }, { colId: 'count' }, { colId: 'Montant' }, { colId: 'id_sync' }, { colId: 'MajLe' }];
  await apply([
    ['AddColumn', T, 'id_sync', { type: 'Text', isFormula: true, formula: summaryKeyFormula(['Ville']) }],
    ['AddColumn', T, 'MajLe', { type: 'DateTime:UTC', isFormula: true, formula: summaryMajleFormula(cols, ['Ville', 'count', 'Montant']) }],
  ]);
  const read = async () => Object.fromEntries((await rows(T)).map(r => [r.Ville, r]));
  let before = await read();
  assert.equal(before.Pau.id_sync.length, 40, 'une empreinte SHA-1');
  assert.notEqual(before.Pau.id_sync, before.Lyon.id_sync);
  ok('la clé est une empreinte distincte par groupe');
  await sleep(1500);
  await apply([['UpdateRecord', 'Fiches', 1, { Montant: 11 }]]); // un membre de Pau : la somme de Pau change
  let after = await read();
  assert.ok(after.Pau.MajLe > before.Pau.MajLe, 'MajLe de Pau est recalculée');
  assert.equal(after.Lyon.MajLe, before.Lyon.MajLe, 'celle de Lyon ne bouge pas');
  ok('une somme modifiée ne recalcule que MajLe de son groupe');
  before = after;
  await sleep(1500);
  await apply([['UpdateRecord', 'Fiches', 1, { Note: 'x' }]]); // colonne que le résumé ne lit pas
  after = await read();
  assert.equal(after.Pau.MajLe, before.Pau.MajLe, 'une colonne non lue ne recalcule rien');
  ok('une colonne que le résumé ne lit pas ne recalcule rien');
  before = after;
  const keyOfLyon = before.Lyon.id_sync;
  await apply([['BulkRemoveRecord', 'Fiches', [3, 4]]]);
  assert.equal((await read()).Lyon, undefined, 'le groupe vide disparaît');
  await apply([['AddRecord', 'Fiches', null, { Ville: 'Lyon', Service: 'A', Montant: 5 }]]);
  assert.equal((await read()).Lyon.id_sync, keyOfLyon, 'le groupe qui revient reprend sa clé');
  ok('un groupe qui disparaît puis revient reprend sa clé');

  // 4. Regroupement changé : une autre table, avec l'ancienne formule de clé.
  await apply([['UpdateSummaryViewSection', section, [col('Ville'), col('Service')]]]);
  m = await meta();
  const regrouped = m.tables.filter(t => t.summarySourceTable === source.id).map(t => t.tableId);
  console.log('tables de résumé après le regroupement :', regrouped.join(', '));
  assert.deepEqual(regrouped, ['Fiches_summary_Service_Ville'], 'l\'ancienne table disparaît, une autre naît');
  const copied = m.cols.filter(c => c.parentId === m.tables.find(t => t.tableId === regrouped[0]).id && c.colId === 'id_sync');
  assert.equal(copied.length, 1, 'Grist recopie la colonne de formule de la personne');
  assert.equal(copied[0].formula, summaryKeyFormula(['Ville']), 'avec son ancienne formule : la clé ne lit pas Service');
  ok('un regroupement changé crée une autre table, avec la clé d\'avant (à remettre d\'accord)');
  console.log('\nLa sonde est passée.');
} finally {
  await api('DELETE', `/docs/${doc}`).catch(() => {});
}
