// Mise en forme des colonnes, de bout en bout sur deux documents en mémoire : la SOURCE (en fr-FR, avec une
// table Budget : devise sans monnaie propre, style d'en-tête, règles conditionnelles dont une piégée) envoie sa
// mise en forme ; la CIBLE (en en-US) la reprend dans les colonnes qu'elle crée, sans écraser ses retouches,
// pose les règles reconstruites (jamais la formule d'origine), signale l'écart de langue et ne règle le document
// que sur un geste. « Reprendre la mise en forme » remet tout d'accord.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KEY_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { signText } from '../../js/engine/logic/trust.js';
import { readSchema } from '../../js/engine/port.js';
import { syncRows, refreshOptions } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { consolidateAll, restyle } from '../../js/engine/target/loop.js';
import { alignDocFormat, readDocFormat } from '../../js/engine/target/style.js';
import { currencyOf, formatGap } from '../../js/engine/logic/docformat.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

const world = fakeWorld();
const source = fakeDoc({ docId: 'sourcedocfmt1x', name: 'Budget source', email: 'source@fake.local', locale: 'fr-FR' });
const target = fakeDoc({ docId: 'targetdocfmt2x', name: 'Budget copie', email: 'cible@fake.local' });
const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });

// Une colonne du document `doc` d'après son nom.
const columnOf = (doc, table, colId) => doc.fetchRows('_grist_Tables_column').find(c => c.colId === colId && doc.tables.get(table).columns.some(x => x.id === c.id));
const options = (doc, table, colId) => JSON.parse(columnOf(doc, table, colId).widgetOptions || '{}');
// Règles d'une colonne : [{ formula, style }] dans l'ordre de ses règles.
const rulesOf = (doc, table, colId) => {
  const column = columnOf(doc, table, colId);
  const styles = options(doc, table, colId).rulesOptions || [];
  return (column.rules ? column.rules.slice(1) : []).map((ref, i) => ({ formula: doc.fetchRows('_grist_Tables_column').find(c => c.id === ref).formula, style: styles[i] }));
};
const addRule = (doc, table, colId, formula, style) => {
  const column = columnOf(doc, table, colId);
  const { retValues } = doc.apply([['AddEmptyRule', table, 0, column.id]]);
  doc.apply([['ModifyColumn', table, retValues[0].colId, { formula }]]);
  const list = options(doc, table, colId).rulesOptions || [];
  doc.apply([['UpdateRecord', '_grist_Tables_column', column.id, { widgetOptions: JSON.stringify({ ...options(doc, table, colId), rulesOptions: [...list, style] }) }]]);
};

source.addTable('Budget', [
  { id: 'Libelle', type: 'Text' },
  { id: 'Montant', type: 'Numeric', widgetOptions: JSON.stringify({ numMode: 'currency', decimals: 2, headerFillColor: '#336699', headerFontBold: true, alignment: 'right' }) },
  { id: 'Reel', type: 'Numeric', widgetOptions: JSON.stringify({ numMode: 'decimal', decimals: 1 }) },
  { id: 'Cache', type: 'Numeric' },
], [{ Libelle: 'Loyer', Montant: 1234.5, Reel: 1200, Cache: 1 }]);
addRule(source, 'Budget', 'Montant', '$Montant < 0', { fillColor: '#FF0000', textColor: '#FFFFFF', fontBold: true });
addRule(source, 'Budget', 'Reel', 'rec.Reel > $Montant * 0.9', { fillColor: '#FFCC00' });
addRule(source, 'Budget', 'Libelle', '__import__("os").system("echo piraté")', { fillColor: '#00FF00' });
addRule(source, 'Budget', 'Libelle', '$Cache > 0', { fillColor: '#0000FF' }); // lit une colonne que l'export n'envoie pas

const story = {};

test('mise en forme : SOURCE fr-FR vers CIBLE en-US', async (t) => {
  await t.test('SOURCE : l\'export envoie la mise en forme, lue et réécrite', async () => {
    as(source);
    const saved = await saveChosenExport({ name: 'Budget', style: true, selection: [{ table: 'Budget', columns: ['Libelle', 'Montant', 'Reel'], filter: null }] });
    story.exp = saved.created;
    const lot = (await syncRows()).find(r => r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Budget');
    const columns = JSON.parse(lot[SCHEMA_COL]);
    assert.deepEqual(columns.map(c => c.id), ['Libelle', 'Montant', 'Reel']);
    assert.ok(columns.every(c => c.fmt === true), 'chaque colonne dit que l\'export envoie sa mise en forme');
    assert.deepEqual(columns[0].doc, { locale: 'fr-FR' }, 'la langue du document est portée par la première colonne');
    assert.deepEqual(columns.filter(c => c.doc).length, 1);
    const montant = columns[1].opts;
    assert.deepEqual({ ...montant, rules: undefined }, { numMode: 'currency', decimals: 2, alignment: 'right', headerFillColor: '#336699', headerFontBold: true, currency: 'EUR', rules: undefined },
      'la monnaie du document (fr-FR : euro) est dite, la CIBLE n\'a pas la même');
    assert.deepEqual(montant.rules, [{ when: '$Montant < 0', fillColor: '#FF0000', textColor: '#FFFFFF', fontBold: true }]);
    assert.deepEqual(columns[2].opts.rules, [{ when: '$Reel > $Montant * 0.9', fillColor: '#FFCC00' }], 'rec.X réécrit en $X');
    assert.equal(columns[0].opts, undefined, 'ni la règle piégée ni celle qui lit une colonne absente de l\'export ne partent');
    assert.ok(!lot[SCHEMA_COL].includes('__import__') && !lot[SCHEMA_COL].includes('Cache'));
    story.lot = lot;
  });

  await t.test('SOURCE puis CIBLE : invitation, réception, webhook', async () => {
    const { entry, secret } = await startInvitation(story.exp);
    const { code } = await invitationCode(story.exp, entry, secret);
    as(target);
    const invitation = await readInvitation(code);
    const plans = invitation.tables.map(tb => ({ tb, dest: 'Budget_recu' }));
    await checkDestinations(invitation, plans);
    story.made = await createReception(invitation, plans, { reserve: false, options: {} });
    const { code: reply } = await receptionReply(story.made, world.formLink(target, story.made.journal));
    as(source);
    story.accepted = await checkReply(story.exp, entry, reply);
    await approveReply(story.exp, entry, story.accepted);
  });

  const deliver = async (lot) => {
    const row = { [EXPORT_COL]: story.exp.id, [TABLE_COL]: 'Budget', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lot[SCHEMA_COL] };
    world.deliver(story.accepted.url, [{ ...row, [LOT_COL]: await signText(story.accepted.keys.down, row, JSON.stringify({ lignes: [['k1', 100, false, { Libelle: 'Loyer', Montant: 1234.5, Reel: 1200 }]], total: 1 })) }]);
  };

  await t.test('CIBLE : les colonnes créées prennent le format, l\'en-tête et la monnaie ; les règles sont reconstruites', async () => {
    await deliver(story.lot);
    as(target);
    await consolidateAll();
    assert.deepEqual(target.rows('Budget_recu').map(r => [r.Libelle, r.Montant]), [['Loyer', 1234.5]]);
    assert.deepEqual(options(target, 'Budget_recu', 'Montant'),
      { numMode: 'currency', decimals: 2, alignment: 'right', headerFillColor: '#336699', headerFontBold: true, currency: 'EUR', rulesOptions: [{ fillColor: '#FF0000', textColor: '#FFFFFF', fontBold: true }] });
    assert.deepEqual(rulesOf(target, 'Budget_recu', 'Montant'), [{ formula: '$Montant < 0', style: { fillColor: '#FF0000', textColor: '#FFFFFF', fontBold: true } }]);
    assert.deepEqual(rulesOf(target, 'Budget_recu', 'Reel'), [{ formula: '$Reel > $Montant * 0.9', style: { fillColor: '#FFCC00' } }]);
    assert.deepEqual(rulesOf(target, 'Budget_recu', 'Libelle'), [], 'la règle piégée n\'est jamais posée');
    assert.ok(!JSON.stringify(target.fetchRows('_grist_Tables_column')).includes('__import__'));
    const entry = receivedJournals(await readSchema())[0].note.tables[0];
    assert.deepEqual(entry.sourceDoc, { locale: 'fr-FR' });
    assert.deepEqual(entry.styled.sort(), ['Montant', 'Reel']);
    const helpers = () => target.fetchRows('_grist_Tables_column').filter(c => c.colId.startsWith('gristHelper_')).length;
    assert.equal(helpers(), 2);
    await consolidateAll({ reread: true });
    assert.equal(helpers(), 2, 'un passage de plus ne pose rien de plus');
  });

  await t.test('CIBLE : l\'écart de langue est dit, le document n\'est réglé que sur un geste', async () => {
    as(target);
    const here = await readDocFormat();
    assert.deepEqual(here, { locale: 'en-US' });
    const gap = formatGap({ locale: 'fr-FR' }, here);
    assert.deepEqual(gap, { locale: ['fr-FR', 'en-US'], currency: ['EUR', 'USD'] });
    assert.equal(currencyOf({ locale: 'fr-FR' }), 'EUR');
    assert.equal(formatGap({ locale: 'en-US' }, here), null, 'même langue : rien à dire');
    assert.deepEqual(await readDocFormat(), { locale: 'en-US' }, 'aucun passage n\'a touché au réglage du document');
    assert.equal(await alignDocFormat({ locale: 'fr-FR' }), true);
    assert.equal(target.fetchRows('_grist_DocInfo')[0].documentSettings, JSON.stringify({ locale: 'fr-FR', engine: 'python3' }), 'langue changée, moteur gardé');
    assert.equal(formatGap({ locale: 'fr-FR' }, await readDocFormat()), null);
    assert.equal(await alignDocFormat({ locale: 'fr-FR' }), false, 'déjà d\'accord : rien à écrire');
    await alignDocFormat({ locale: 'en-US' }); // pour la suite
  });

  await t.test('CIBLE : une retouche d\'ici n\'est pas écrasée, « Reprendre la mise en forme » remet tout d\'accord', async () => {
    as(target);
    const column = columnOf(target, 'Budget_recu', 'Montant');
    target.apply([['UpdateRecord', '_grist_Tables_column', column.id, { widgetOptions: JSON.stringify({ ...options(target, 'Budget_recu', 'Montant'), currency: 'USD', alignment: 'left', rulesOptions: [] }) }]]);
    target.apply([['RemoveColumn', 'Budget_recu', 'gristHelper_ConditionalRule']]);
    assert.deepEqual(rulesOf(target, 'Budget_recu', 'Montant'), [], 'la règle est retirée ici');
    await consolidateAll({ reread: true });
    assert.equal(options(target, 'Budget_recu', 'Montant').currency, 'USD', 'la devise choisie ici reste');
    assert.deepEqual(rulesOf(target, 'Budget_recu', 'Montant'), [], 'la règle supprimée ici n\'est pas refaite');
    await restyle(story.made.journal);
    assert.equal(options(target, 'Budget_recu', 'Montant').currency, 'EUR');
    assert.equal(options(target, 'Budget_recu', 'Montant').alignment, 'right');
    assert.deepEqual(rulesOf(target, 'Budget_recu', 'Montant').map(r => r.formula), ['$Montant < 0']);
    assert.deepEqual(rulesOf(target, 'Budget_recu', 'Reel').map(r => r.formula), ['$Reel > $Montant * 0.9'], 'les règles d\'une autre colonne sont remplacées, pas doublées');
    const helpers = target.fetchRows('_grist_Tables_column').filter(c => c.colId.startsWith('gristHelper_'));
    assert.equal(helpers.length, 2);
  });

  await t.test('SOURCE : une règle changée ou une langue changée mettent la description à jour, sans renvoyer de ligne', async () => {
    as(source);
    source.apply([['UpdateRecord', '_grist_DocInfo', 1, { documentSettings: JSON.stringify({ locale: 'de-DE', engine: 'python3' }) }]]);
    const rule = columnOf(source, 'Budget', 'Montant').rules[1];
    source.apply([['ModifyColumn', 'Budget', source.fetchRows('_grist_Tables_column').find(c => c.id === rule).colId, { formula: '$Montant < 100' }]]);
    const marked = source.rows('Synchro').filter(r => r[TYPE_COL] === KIND.lot).length;
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), true);
    const lot = (await syncRows()).find(r => r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Budget');
    const columns = JSON.parse(lot[SCHEMA_COL]);
    assert.deepEqual(columns[0].doc, { locale: 'de-DE' });
    assert.equal(columns[1].opts.currency, 'EUR', 'de-DE : l\'euro aussi');
    assert.equal(columns[1].opts.rules[0].when, '$Montant < 100');
    assert.equal(source.rows('Synchro').filter(r => r[TYPE_COL] === KIND.lot).length, marked);
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), false, 'rien de plus au passage suivant');
  });

  await t.test('SOURCE : un export qui n\'envoie pas sa mise en forme garde la description d\'avant', async () => {
    as(source);
    const saved = await saveChosenExport({ name: 'Sans', style: false, selection: [{ table: 'Budget', columns: ['Libelle', 'Montant', 'Reel'], filter: null }] });
    const lot = (await syncRows()).find(r => r[EXPORT_COL] === saved.id && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Budget');
    const columns = JSON.parse(lot[SCHEMA_COL]);
    assert.ok(columns.every(c => !c.fmt && !c.doc), 'ni marque, ni langue');
    assert.deepEqual(columns[1].opts, { numMode: 'currency', decimals: 2, alignment: 'right' }, 'ni en-tête, ni règle, ni monnaie résolue');
    assert.ok(!lot[SCHEMA_COL].includes('rules') && !lot[SCHEMA_COL].includes('header'));
    assert.equal(KEY_COL.length > 0, true);
  });
});
