// Formules des colonnes, de bout en bout sur deux documents en mémoire : la SOURCE (une table Budget avec deux colonnes de
// formule, dont une qui ne passe pas la lecture) les envoie, à part, dans la description signée des colonnes ; la CIBLE les
// lit à chaque passage mais n'en pose aucune seule : seul « Reprendre depuis la SOURCE » avec la case « Formules » (propriétaire)
// transforme une colonne que le widget a créée en colonne de formule, après objection levée. Puis la logique pure : texte nettoyé,
// formules refusées d'office, colonnes et tables citées, plan d'écriture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { FORMULAS_TOTAL_MAX, FORMULA_MAX, cleanFormula, formulaItems, formulaProblems, formulasOffered, formulasSent, planFormulas, sourceFormula, withFormulas } from '../../js/engine/logic/column-formulas.js';
import { elementCounts } from '../../js/engine/logic/exports.js';
import { sentElements } from '../../js/engine/logic/descriptions.js';
import { exportSchema } from '../../js/engine/logic/codes.js';
import { signText } from '../../js/engine/logic/trust.js';
import { readSchema } from '../../js/engine/port.js';
import { refreshOptions, syncRows } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { consolidateAll, restyle, state, tableKey } from '../../js/engine/target/loop.js';
import { formulaColumns } from '../../js/engine/target/formulas.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

const world = fakeWorld();
const source = fakeDoc({ docId: 'sourcedocfx001', name: 'Budget source', email: 'source@fake.local' });
const target = fakeDoc({ docId: 'targetdocfx002', name: 'Budget copie', email: 'cible@fake.local' });
const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });

source.addTable('Budget', [
  { id: 'Libelle', type: 'Text' },
  { id: 'Montant', type: 'Numeric' },
  { id: 'TVA', type: 'Numeric', isFormula: true, formula: '$Montant * 0.2' },
  { id: 'Fuite', type: 'Text', isFormula: true, formula: 'import os\nreturn os.getcwd()' },
  { id: 'Declenchee', type: 'Text', isFormula: false, formula: '"x" + $Libelle', recalcWhen: 0 },
], [{ Libelle: 'Loyer', Montant: 100, TVA: 20, Fuite: '/', Declenchee: 'xLoyer' }]);

const story = {};
const columnsOf = lot => JSON.parse(lot[SCHEMA_COL]);
const lotOf = async exportId => (await syncRows()).find(r => r[EXPORT_COL] === exportId && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Budget');
const all = { table: 'Budget', columns: ['Libelle', 'Montant', 'TVA', 'Fuite', 'Declenchee'], filter: null };
const destColumn = (doc, table, colId) => doc.fetchRows('_grist_Tables_column').find(c => c.colId === colId && doc.tables.get(table).columns.some(x => x.id === c.id));
const itemsOf = () => (state.results.get(tableKey(story.made.journal, 'Budget')) || {}).formulas || [];

test('formules de colonne : SOURCE vers CIBLE', async (t) => {
  await t.test('SOURCE : sans la case, aucune formule ne part', async () => {
    as(source);
    const saved = await saveChosenExport({ name: 'Sans', notes: true, selection: [all] });
    const text = (await lotOf(saved.id))[SCHEMA_COL];
    assert.ok(!text.includes('"fx"') && !text.includes('os.getcwd'), text);
  });

  await t.test('SOURCE : avec la case, chaque colonne dit sa formule (vide si ce n\'en est pas une), signée avec les colonnes', async () => {
    as(source);
    const saved = await saveChosenExport({ name: 'Budget', formulas: true, selection: [all] });
    story.exp = saved.created;
    story.lot = await lotOf(saved.id);
    const columns = columnsOf(story.lot);
    assert.deepEqual(columns.map(c => c.fx), ['', '', '$Montant * 0.2', 'import os\nreturn os.getcwd()', ''],
      'la colonne à formule de déclenchement n\'est pas une formule ; une colonne de données dit « vide » : l\'export les envoie');
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

  const deliver = async (lot, rows) => {
    const row = { [EXPORT_COL]: story.exp.id, [TABLE_COL]: 'Budget', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lot[SCHEMA_COL] };
    world.deliver(story.accepted.url, [{ ...row, [LOT_COL]: await signText(story.accepted.keys.down, row, JSON.stringify({ lignes: rows, total: rows.length })) }]);
  };
  const data = { Libelle: 'Loyer', Montant: 100, TVA: 20, Fuite: '/', Declenchee: 'xLoyer' };

  await t.test('CIBLE : les valeurs arrivent comme des données, les formules sont lues mais jamais posées d\'elles-mêmes', async () => {
    await deliver(story.lot, [['k1', 100, false, data]]);
    as(target);
    await consolidateAll();
    assert.deepEqual(target.rows('Budget_recu').map(r => [r.Libelle, r.Montant, r.TVA, r.Fuite]), [['Loyer', 100, 20, '/']]);
    assert.ok(['TVA', 'Fuite'].every(id => !destColumn(target, 'Budget_recu', id).isFormula), 'rien n\'est posé par un passage ordinaire');
    const items = itemsOf();
    assert.deepEqual(items.map(i => [i.id, i.state, i.ok]), [['TVA', 'data', true], ['Fuite', 'data', false]]);
    assert.deepEqual(items[1].problems.map(p => [p.code, p.name]), [['unsafe', 'os']], 'le module système est refusé d\'office');
    assert.equal(items[0].formula, '$Montant * 0.2');
    assert.deepEqual(sentElements(columnsOf(story.lot)), ['formulas']);
    assert.ok(!JSON.stringify(target.fetchRows('_grist_Tables_column').filter(c => c.colId === 'id_sync')).includes('Montant * 0.2'), 'la note du journal ne garde pas les formules');
  });

  await t.test('CIBLE : « Reprendre depuis la SOURCE » avec la case Formules pose celles qui n\'ont pas d\'objection', async () => {
    as(target);
    await restyle(story.made.journal, { formulas: true });
    const tva = destColumn(target, 'Budget_recu', 'TVA');
    assert.equal(tva.isFormula, true);
    assert.equal(tva.formula, '$Montant * 0.2');
    assert.equal(tva.type, 'Numeric', 'le type reste celui de la colonne');
    const fuite = destColumn(target, 'Budget_recu', 'Fuite');
    assert.equal(fuite.isFormula, false, 'une formule qui a une objection reste une colonne de données');
    assert.equal(target.rows('Budget_recu')[0].Fuite, '/', 'ses données restent');
    assert.deepEqual(itemsOf().map(i => [i.id, i.state]), [['TVA', 'same'], ['Fuite', 'data']]);
  });

  await t.test('CIBLE : une colonne devenue formule n\'est plus recopiée, les autres le restent', async () => {
    await deliver(story.lot, [['k1', 200, false, { ...data, Montant: 150, TVA: 999, Libelle: 'Loyer 2' }]]);
    as(target);
    await consolidateAll({ reread: true });
    const [row] = target.rows('Budget_recu');
    assert.equal(row.Montant, 150);
    assert.equal(row.Libelle, 'Loyer 2');
    assert.equal(row.TVA, 20, 'la valeur envoyée n\'est pas écrite dans une colonne de formule (Grist le refuserait)');
  });

  await t.test('CIBLE : refaire « Reprendre » ne change rien quand la formule est déjà posée', async () => {
    as(target);
    const before = target.fetchRows('_grist_Tables_column').filter(c => c.isFormula).length;
    await restyle(story.made.journal, { formulas: true });
    assert.equal(target.fetchRows('_grist_Tables_column').filter(c => c.isFormula).length, before);
    assert.equal(itemsOf().find(i => i.id === 'TVA').state, 'same');
  });

  await t.test('SOURCE : une formule changée met la description des colonnes à jour, sans renvoyer de ligne', async () => {
    as(source);
    source.apply([['ModifyColumn', 'Budget', 'TVA', { isFormula: true, formula: '$Montant * 0.1' }]]);
    const marked = source.rows('Synchro').filter(r => r[TYPE_COL] === KIND.lot).length;
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), true);
    story.lot = await lotOf(story.exp.id);
    assert.equal(columnsOf(story.lot)[2].fx, '$Montant * 0.1');
    assert.equal(source.rows('Synchro').filter(r => r[TYPE_COL] === KIND.lot).length, marked);
    assert.equal(await refreshOptions(await readSchema(), await syncRows()), false, 'rien de plus au passage suivant');
  });

  await t.test('CIBLE : une autre formule dans la SOURCE est dite « autre » et ne remplace la nôtre que sur « Reprendre »', async () => {
    await deliver(story.lot, [['k1', 300, false, { ...data, Montant: 150, Libelle: 'Loyer 3' }]]);
    as(target);
    await consolidateAll({ reread: true });
    assert.equal(destColumn(target, 'Budget_recu', 'TVA').formula, '$Montant * 0.2', 'un passage ordinaire ne pose rien');
    assert.equal(itemsOf().find(i => i.id === 'TVA').state, 'other');
    await restyle(story.made.journal, { formulas: true });
    assert.equal(destColumn(target, 'Budget_recu', 'TVA').formula, '$Montant * 0.1');
  });

  await t.test('CIBLE : une colonne qui existait déjà ici n\'est jamais transformée', async () => {
    as(target);
    const entry = { dest: 'Budget_recu', own: ['Libelle'], map: {} };
    const columns = [{ id: 'Montant', fx: '$Libelle' }];
    await formulaColumns({ schema: await readSchema(), dests: new Map(), exchange: false }, entry, columns, { replace: true });
    assert.equal(destColumn(target, 'Budget_recu', 'Montant').isFormula, false);
  });
});

test('formules : un Échange n\'en lit ni n\'en pose', async () => {
  const items = await formulaColumns({ schema: { columns: () => { throw new Error('jamais lu'); } }, dests: new Map(), exchange: true }, { dest: 'T' }, [{ id: 'A', fx: '1' }], { replace: true });
  assert.deepEqual(items, []);
});

test('formules : texte nettoyé et borné', () => {
  assert.equal(cleanFormula('  $Montant * 2  \r\n'), '  $Montant * 2', 'l\'indentation compte en Python, les espaces de fin non');
  assert.equal(cleanFormula('\n\nreturn 1'), 'return 1');
  assert.equal(cleanFormula('a\u0000b‮c​d\u0007e'), 'abcde', 'ni caractères de contrôle ni sens d\'écriture');
  assert.equal(cleanFormula('if x:\n\treturn 1'), 'if x:\n\treturn 1', 'tabulation et retours à la ligne gardés');
  assert.equal(cleanFormula(undefined), '');
  assert.equal(cleanFormula(12), '');
  assert.equal(cleanFormula('x'.repeat(FORMULA_MAX)), 'x'.repeat(FORMULA_MAX));
  assert.equal(cleanFormula('x'.repeat(FORMULA_MAX + 1)), '', 'trop longue : elle ne part pas, jamais coupée');
});

test('formules : ce que la SOURCE envoie', () => {
  assert.equal(sourceFormula({ isFormula: true, type: 'Numeric', formula: '$A + 1' }), '$A + 1');
  assert.equal(sourceFormula({ isFormula: false, type: 'Text', formula: '"x"' }), '', 'formule de déclenchement : pas une formule de colonne');
  assert.equal(sourceFormula({ isFormula: true, type: 'Ref:Villes', formula: 'Villes.lookupOne(Nom=$A)' }), '', 'une Référence part comme du texte');
  assert.equal(sourceFormula({ isFormula: true, type: 'RefList:Villes', formula: 'x' }), '');
  assert.equal(sourceFormula({ isFormula: true, type: 'Attachments', formula: 'x' }), '');
  assert.equal(sourceFormula({ isFormula: true, type: 'Text', formula: '   ' }), '');
  assert.equal(sourceFormula(undefined), '');
  const live = [{ colId: 'A', isFormula: true, type: 'Text', formula: 'x'.repeat(900) }, { colId: 'B', isFormula: true, type: 'Text', formula: 'y'.repeat(900) }, { colId: 'C', type: 'Text' }];
  const made = withFormulas([{ id: 'A', fx: 'vieux' }, { id: 'B' }, { id: 'C' }, { id: 'Z' }], live);
  assert.deepEqual(made.map(c => c.fx.length), [900, 900, 0, 0], 'colonne absente ou sans formule : vide ; l\'ancienne valeur ne reste pas');
  const wide = Array.from({ length: 30 }, (_, i) => ({ colId: `C${i}`, isFormula: true, type: 'Text', formula: 'z'.repeat(1000) }));
  const sent = withFormulas(wide.map(c => ({ id: c.colId })), wide).filter(c => c.fx);
  assert.equal(sent.length, FORMULAS_TOTAL_MAX / 1000, 'au-delà du total d\'une table, les formules suivantes ne partent pas');
  assert.deepEqual([formulasOffered([{ id: 'A', fx: '' }]), formulasSent([{ id: 'A', fx: '' }])], [true, false]);
  assert.deepEqual([formulasOffered([{ id: 'A' }]), formulasSent([{ id: 'A', fx: 'x' }])], [false, true]);
  assert.deepEqual(formulaItems([{ id: 'A', fx: 'x' }, { id: 'B', fx: '' }, null, { id: 'C', fx: 4 }]).map(c => c.id), ['A']);
  assert.deepEqual(sentElements([{ id: 'A', fx: '' }]), [], 'une export qui n\'a aucune formule n\'en propose pas la reprise');
});

test('formules : exportSchema ne garde que du texte nettoyé', () => {
  const [first, second, third] = exportSchema([{ id: 'A', type: 'Text', fx: '$B‮ + 1  ' }, { id: 'B', type: 'Text', fx: { evil: true } }, { id: 'C', type: 'Text', fx: 'x'.repeat(5000) }], true);
  assert.equal(first.fx, '$B + 1');
  assert.equal(Object.hasOwn(second, 'fx'), false);
  assert.equal(third.fx, '', 'trop longue : vide');
  assert.equal(Object.hasOwn(exportSchema([{ id: 'A', type: 'Text', fx: '1' }])[0], 'fx'), false, 'jamais dans un code ni dans la note du journal');
});

test('formules : elementCounts compte les colonnes de formule', () => {
  const schema = {
    columns: table => (table === 'T' ? [{ colId: 'A', isFormula: true, type: 'Text', formula: '1' }, { colId: 'B', isFormula: false, type: 'Text', formula: '"x"' }, { colId: 'C', isFormula: true, type: 'Ref:U', formula: 'U.all[0]' }] : []),
    table: () => ({ rawViewSectionRef: 0 }),
  };
  assert.equal(elementCounts(schema, ['T', 'U'], []).formulas, 1);
});

const here = new Map(['Montant', 'Libelle'].map(id => [id, {}]));
const tables = new Map([['Budget', 'Budget'], ['Villes', 'Cities']]);
const problems = (formula, extra = {}) => formulaProblems(formula, { here, map: {}, tables, ...extra }).map(p => `${p.code}:${p.name}${p.to ? `>${p.to}` : ''}`);

test('formules : ce qui empêche de poser une formule', () => {
  assert.deepEqual(problems('$Montant * 0.2'), []);
  assert.deepEqual(problems('rec.Montant + rec.id + $id'), [], 'rec.Nom comme $Nom ; id est toujours là');
  assert.deepEqual(problems('$Libelle == "open"'), [], 'un mot dans un texte n\'est pas du code');
  assert.deepEqual(problems('"Prix en $USD " + str($Montant)'), [], 'ni un $ dans un texte');
  assert.deepEqual(problems('$Montant  # import os, open'), [], 'ni un commentaire');
  assert.deepEqual(problems('import math\nreturn math.floor($Montant)'), []);
  assert.deepEqual(problems('from datetime import datetime as dt, timedelta\nreturn 1'), []);
  assert.deepEqual(problems('import os\nreturn os.getcwd()'), ['unsafe:os']);
  assert.deepEqual(problems('x = 1; import subprocess'), ['unsafe:subprocess'], 'même derrière un point-virgule');
  assert.deepEqual(problems('if $Montant: import json, shelve'), ['unsafe:shelve']);
  assert.deepEqual(problems('import foo.bar as b'), ['import:foo'], 'module hors de la liste');
  assert.deepEqual(problems('from foo import bar'), ['import:foo']);
  assert.deepEqual(problems('f"{open(\'x\').read()}"'), ['unsafe:open'], 'Python exécute ce qui est entre les accolades d\'un texte f"…"');
  assert.deepEqual(problems('eval("1")'), ['unsafe:eval']);
  assert.deepEqual(problems('getattr($Montant, "real")'), ['unsafe:getattr']);
  assert.deepEqual(problems('"{0.__class__}".format($Montant)'), ['unsafe:__'], 'les doubles tirets bas sont refusés partout, même dans un texte');
  assert.deepEqual(problems('$Inconnue + 1'), ['missingCol:Inconnue']);
  assert.deepEqual(problems('$Montant', { map: { Montant: 'Somme' } }), ['renamedCol:Montant>Somme'], 'jamais réécrite : la personne corrige si elle le veut');
  assert.deepEqual(problems('len(Budget.lookupRecords(Libelle=$Libelle))'), []);
  assert.deepEqual(problems('Secrets.all'), ['foreignTable:Secrets'], 'seules les tables de l\'export se lisent');
  assert.deepEqual(problems('Villes.lookupOne(Nom=$Libelle).Nom'), ['renamedTable:Villes>Cities']);
});

test('formules : plan d\'écriture', () => {
  const schema = {
    columns: () => [
      { id: 1, colId: 'Montant', isFormula: false, formula: '' }, { id: 2, colId: 'TVA', isFormula: false, formula: '' }, { id: 3, colId: 'Net', isFormula: true, formula: '$Montant - 1' },
      { id: 4, colId: 'Pre', isFormula: false, formula: '' }, { id: 5, colId: 'id_sync', isFormula: false, formula: '' },
    ],
  };
  const entry = { dest: 'T', own: ['Montant', 'TVA', 'Net', 'Cle'], map: { Cle: 'id_sync' } };
  const columns = [
    { id: 'TVA', fx: '$Montant * 0.2' }, { id: 'Net', fx: '$Montant - 1' }, { id: 'Pre', fx: '1' }, { id: 'Cle', fx: '1' },
    { id: 'Absente', fx: '1' }, { id: 'Montant' }, { id: 'Vide', fx: '' },
  ];
  const read = planFormulas(schema, entry, columns);
  assert.deepEqual(read.actions, [], 'sans « replace », rien n\'est écrit');
  assert.deepEqual(read.items.map(i => [i.id, i.state, i.ok]), [['TVA', 'data', true], ['Net', 'same', true], ['Pre', 'data', false]],
    'la clé id_sync et les colonnes absentes ne sont jamais proposées ; une colonne qui n\'est pas au widget a une objection');
  assert.deepEqual(read.items[2].problems.map(p => p.code), ['notOwn']);
  const done = planFormulas(schema, entry, columns, { replace: true });
  assert.deepEqual(done.actions, [['ModifyColumn', 'T', 'TVA', { isFormula: true, formula: '$Montant * 0.2' }]], 'celle qui est déjà posée et celle qui a une objection ne sont pas écrites');
  assert.equal(done.items[0].applied, true);
  assert.equal(done.items[0].state, 'same');
  const other = planFormulas(schema, entry, [{ id: 'Net', fx: '$Montant - 2' }], { replace: true });
  assert.deepEqual(other.actions, [['ModifyColumn', 'T', 'Net', { isFormula: true, formula: '$Montant - 2' }]], 'une autre formule est remplacée sur demande');
});
