// Références conservées : colonnes qui gardent leur lien, conversion chez le destinataire, numéros
// des lignes visées, cellules complétées à l'arrivée de la ligne visée.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLinks, fillLinks, keyIds, linkActions, linkTables, linkable, planLinks, resolveLinks, targetRows, textFill, unlinkActions } from '../../js/logic/links.js';
import { exportSchema } from '../../js/logic/codes.js';
import { exportRowsActions } from '../../js/logic/exports.js';
import { syncFormulas } from '../../js/logic/formulas.js';
import { LINK_PREFIX, SCHEMA_COL, TYPE_COL } from '../../js/logic/common.js';

const col = (id, extra = {}) => ({ id, type: 'Text', label: id, source: 'Text', visible: '', ...extra });
const lieu = col('Lieu', { source: 'Ref:Villes', visible: 'Nom' });
const SOURCE = [
  { table: 'Contacts', columns: [col('Nom'), lieu], filter: null },
  { table: 'Villes', columns: [col('Nom'), col('Pays')], filter: null },
];

test('SOURCE : une Référence vers une table de l\'export, dont la colonne affichée part aussi, garde son lien', () => {
  assert.ok(linkable(SOURCE));
  const on = linkTables(SOURCE, true);
  assert.equal(on[0].columns[1].link, 'Villes');
  assert.equal(on[0].columns[0].link, undefined);
  assert.equal(on[1].columns[0].link, undefined);
  assert.equal(linkTables(on, false)[0].columns[1].link, undefined, 'décochée : le lien part');
  assert.equal(SOURCE[0].columns[1].link, undefined, 'les colonnes de départ ne sont pas touchées');
});

test('SOURCE : pas de lien sans la table visée, sans sa colonne affichée, ni pour une Liste de références', () => {
  const alone = [SOURCE[0]];
  assert.ok(!linkable(alone));
  assert.equal(linkTables(alone, true)[0].columns[1].link, undefined);
  const hidden = [SOURCE[0], { table: 'Villes', columns: [col('Pays')], filter: null }];
  assert.ok(!linkable(hidden), 'la colonne affichée ne part pas : la Référence montrerait des numéros');
  const noShown = [{ table: 'Contacts', columns: [col('Lieu', { source: 'Ref:Villes', visible: '' })] }, SOURCE[1]];
  assert.ok(!linkable(noShown));
  const list = [{ table: 'Contacts', columns: [col('Lieux', { source: 'RefList:Villes', visible: 'Nom' })] }, SOURCE[1]];
  assert.ok(!linkable(list));
});

test('SOURCE : une table peut viser elle-même', () => {
  const people = [{ table: 'Personnes', columns: [col('Nom'), col('Chef', { source: 'Ref:Personnes', visible: 'Nom' })] }];
  assert.equal(linkTables(people, true)[0].columns[1].link, 'Personnes');
});

test('codes et description des colonnes : le lien et la colonne affichée ne sont gardés que contrôlés', () => {
  const columns = [{ id: 'Lieu', type: 'Text', link: 'Villes', visible: 'Nom' }, { id: 'Pays', type: 'Text', link: 'x y', visible: 'z z' }, { id: 'Nom', type: 'Text', link: 'Villes', visible: 'a;b' }];
  assert.deepEqual(exportSchema(columns, true), [
    { id: 'Lieu', type: 'Text', link: 'Villes', visible: 'Nom' }, { id: 'Pays', type: 'Text' }, { id: 'Nom', type: 'Text', link: 'Villes' },
  ]);
  assert.deepEqual(exportSchema(columns), [{ id: 'Lieu', type: 'Text' }, { id: 'Pays', type: 'Text' }, { id: 'Nom', type: 'Text' }], 'les codes ne le portent pas');
});

test('SOURCE : cocher ou décocher les liens renvoie la table', () => {
  const id = '0123456789abcdef';
  const first = exportRowsActions([], id, linkTables(SOURCE, false));
  const rows = first.actions.flatMap(([, , ids, fields]) => ids.map((_, i) => ({ id: i + 1, Synchro_Export: id, Synchro_Table: fields.Synchro_Table[i], [TYPE_COL]: fields[TYPE_COL][i], [SCHEMA_COL]: fields[SCHEMA_COL][i] })));
  assert.deepEqual(exportRowsActions(rows, id, linkTables(SOURCE, false)).changed, [], 'rien de changé');
  assert.deepEqual(exportRowsActions(rows, id, linkTables(SOURCE, true)).changed, ['Contacts'], 'les liens ajoutés : la table qui les porte repart');
});

test('formule du lot : la clé de la ligne visée part avec le texte', () => {
  const { lot } = syncFormulas(['Contacts']);
  assert.ok(lot.includes(`${LINK_PREFIX}`));
  assert.ok(lot.includes('data(r, cols)'));
});

// Schéma simulé : Contacts reçoit dans « Contacts_ici », Villes dans « Villes_ici » (colonne Nom renommée).
const schema = (types = {}) => {
  const tables = {
    Contacts_ici: [{ id: 11, colId: 'Nom', type: 'Text' }, { id: 12, colId: 'Lieu', type: types.Lieu || 'Text' }],
    Villes_ici: [{ id: 21, colId: 'Ville', type: 'Text' }, { id: 22, colId: 'Pays', type: 'Text' }],
  };
  return { has: id => id in tables, columns: id => tables[id] || null };
};
const dests = new Map([['Villes', { table: 'Villes', dest: 'Villes_ici', map: { Nom: 'Ville' } }]]);
const entry = { table: 'Contacts', dest: 'Contacts_ici', own: ['Nom', 'Lieu'] };
const sent = [{ id: 'Nom', type: 'Text' }, { id: 'Lieu', type: 'Text', link: 'Villes', visible: 'Nom' }];

test('CIBLE : une colonne créée ici, encore du texte, est à convertir', () => {
  const plan = planLinks(schema(), entry, sent, dests);
  assert.deepEqual(plan.ready, []);
  assert.deepEqual(plan.todo, [{ from: 'Lieu', to: 'Lieu', ref: 12, type: 'Text', target: 'Villes_ici', shownId: 'Ville', shown: 21 }]);
});

test('CIBLE : déjà une Référence vers la table reçue : prête ; ni créée ici ni décidée : laissée', () => {
  assert.equal(planLinks(schema({ Lieu: 'Ref:Villes_ici' }), entry, sent, dests).ready.length, 1);
  assert.deepEqual(planLinks(schema({ Lieu: 'Ref:Villes_ici' }), entry, sent, dests).todo, []);
  assert.deepEqual(planLinks(schema(), { ...entry, own: ['Nom'] }, sent, dests).todo, [], 'colonne choisie par la personne');
  assert.deepEqual(planLinks(schema(), { ...entry, linked: ['Lieu'] }, sent, dests).todo, [], 'sort déjà décidé');
  assert.deepEqual(planLinks(schema({ Lieu: 'Ref:Autre' }), entry, sent, dests), { ready: [], todo: [], undo: [] }, 'Référence vers une autre table');
});

test('CIBLE : rien tant que la table visée ou sa colonne affichée manque', () => {
  const none = { ready: [], todo: [], undo: [] };
  assert.deepEqual(planLinks(schema(), entry, sent, new Map()), none);
  assert.deepEqual(planLinks(schema(), entry, sent, new Map([['Villes', { table: 'Villes', dest: 'Absente' }]])), none);
  assert.deepEqual(planLinks(schema(), entry, [{ id: 'Lieu', type: 'Text', link: 'Villes' }], dests), none, 'sans colonne affichée');
  assert.deepEqual(planLinks(schema(), entry, [{ id: 'Lieu', type: 'Text', link: 'Villes', visible: 'Inconnue' }], dests), none);
  assert.deepEqual(planLinks(schema(), { ...entry, map: { Lieu: 'Absente' } }, sent, dests), none, 'colonne effacée ici');
  assert.deepEqual(planLinks(schema(), { ...entry, map: { Lieu: 'Nom' } }, sent, dests).todo.map(s => s.to), ['Nom'], 'correspondance suivie');
});

test('CIBLE : un lien que la SOURCE ne garde plus rend la colonne au texte', () => {
  const linked = { ...entry, linked: ['Lieu'] };
  const unlinked = [{ id: 'Nom', type: 'Text' }, { id: 'Lieu', type: 'Text' }];
  const plan = planLinks(schema({ Lieu: 'Ref:Villes_ici' }), linked, unlinked, dests);
  assert.deepEqual(plan.undo, [{ from: 'Lieu', to: 'Lieu' }]);
  assert.deepEqual(unlinkActions('Contacts_ici', plan.undo), [['ModifyColumn', 'Contacts_ici', 'Lieu', { type: 'Text' }]]);
  assert.deepEqual(planLinks(schema({ Lieu: 'Ref:Villes_ici' }), linked, sent, dests).undo, [], 'le lien est toujours envoyé');
  assert.deepEqual(planLinks(schema({ Lieu: 'Ref:Villes_ici' }), entry, unlinked, dests).undo, [], 'colonne jamais décidée par le widget');
  assert.deepEqual(planLinks(schema({ Lieu: 'Ref:Villes_ici' }), { ...linked, own: ['Nom'] }, unlinked, dests).undo, [], 'colonne choisie par la personne');
  assert.deepEqual(planLinks(schema({ Lieu: 'Ref:Autre' }), linked, unlinked, dests).undo, [], 'Référence vers une table qui n\'est pas reçue');
  assert.deepEqual(planLinks(schema(), linked, unlinked, dests).undo, [], 'déjà du texte');
});

test('CIBLE : conversion en Référence qui affiche la colonne de la SOURCE', () => {
  const [spec] = planLinks(schema(), entry, sent, dests).todo;
  assert.deepEqual(linkActions('Contacts_ici', spec), [
    ['ModifyColumn', 'Contacts_ici', 'Lieu', { type: 'Ref:Villes_ici' }],
    ['UpdateRecord', '_grist_Tables_column', 12, { visibleCol: 21 }],
    ['SetDisplayFormula', 'Contacts_ici', null, 12, '$Lieu.Ville'],
  ]);
});

test('CIBLE : seules les colonnes vides sont converties, toutes sont décidées', () => {
  const todo = [{ from: 'A', to: 'A1' }, { from: 'B', to: 'B1' }];
  const { convert, decided } = decideLinks(todo, to => to === 'A1');
  assert.deepEqual(convert.map(s => s.from), ['A']);
  assert.deepEqual(decided, ['A', 'B']);
});

test('numéros des lignes visées : la première ligne de chaque clé, et toutes les lignes qui existent', () => {
  const rows = [{ id: 5, id_sync: 'a' }, { id: 6, id_sync: '' }, { id: 7, id_sync: 'b' }, { id: 8, id_sync: 'a' }, { id: 9 }];
  assert.deepEqual([...keyIds(rows)], [['a', 5], ['b', 7]]);
  assert.deepEqual([...targetRows(rows).live], [5, 6, 7, 8, 9]);
});

const spec = { from: 'Lieu', to: 'Lieu', target: 'Villes_ici' };
const lookups = new Map([['Villes_ici', { keys: new Map([['k1', 31], ['k2', 32]]), live: new Set([31, 32, 40]) }]]);
const keyOf = `${LINK_PREFIX}Lieu`;

test('lignes du journal : la cellule Référence vaut le numéro de la ligne visée, 0 si elle n\'est pas là', () => {
  const rows = [{ id: 1, Lieu: 'Paris', [keyOf]: 'k1' }, { id: 2, Lieu: 'Lyon', [keyOf]: 'k9' }, { id: 3, Lieu: '', [keyOf]: null }, { id: 4, Nom: 'sans la colonne' }];
  const out = resolveLinks(rows, [spec], lookups);
  assert.deepEqual(out.map(r => r.Lieu), [31, 0, 0, undefined]);
  assert.equal(out[3], rows[3], 'ligne sans la colonne : inchangée');
  assert.equal(rows[0].Lieu, 'Paris', 'les lignes du journal ne sont pas modifiées');
  assert.equal(resolveLinks(rows, [], lookups), rows);
});

test('cellules complétées : seulement celles d\'une version appliquée, vides, dont la ligne visée est arrivée', () => {
  const version = (id, key, extra = {}) => ({ id, id_sync: key, Sync_Applique: true, [keyOf]: extra.link, ...extra });
  const journalRows = [
    version(1, 'p1', { link: 'k1' }), version(2, 'p2', { link: 'k9' }), version(3, 'p3', { link: 'k2' }), version(4, 'p4', { link: 'k1', Supprime: true }),
    { id: 5, id_sync: 'p5', [keyOf]: 'k1' }, version(6, 'p6', { link: 'k1' }), version(7, 'p7', { link: 'k1' }),
  ];
  const destRows = [
    { id: 101, id_sync: 'p1', Lieu: 0 }, { id: 102, id_sync: 'p2', Lieu: 0 }, { id: 103, id_sync: 'p3', Lieu: 0 }, { id: 104, id_sync: 'p4', Lieu: 0 },
    { id: 105, id_sync: 'p5', Lieu: 0 }, { id: 106, id_sync: 'p6', Lieu: 32 }, { id: 108, id_sync: 'autre', Lieu: 0 },
  ];
  assert.deepEqual(fillLinks({ journalRows, destRows, specs: [spec], lookups, destTable: 'Contacts_ici' }), [
    ['BulkUpdateRecord', 'Contacts_ici', [101, 103], { Lieu: [31, 32] }],
  ]);
  assert.deepEqual(fillLinks({ journalRows, destRows, specs: [], lookups, destTable: 'Contacts_ici' }), []);
  // Une cellule qui vise une ligne effacée (puis revenue sous un autre numéro) est refaite ; celle qui vise une ligne sans clé reste.
  const stale = [{ id: 201, id_sync: 'p1', Lieu: 17 }, { id: 202, id_sync: 'p3', Lieu: 40 }, { id: 203, id_sync: 'p6', Lieu: 31 }];
  assert.deepEqual(fillLinks({ journalRows, destRows: stale, specs: [spec], lookups, destTable: 'Contacts_ici' }), [
    ['BulkUpdateRecord', 'Contacts_ici', [201], { Lieu: [31] }],
  ]);
});

test('colonne rendue au texte : chaque cellule reprend le texte de la dernière version reçue', () => {
  const journalRows = [
    { id: 1, id_sync: 'p1', Sync_Applique: true, Lieu: 'Lyon' }, { id: 2, id_sync: 'p1', Sync_Applique: true, Lieu: 'Villeurbanne' },
    { id: 3, id_sync: 'p2', Sync_Applique: true, Lieu: '' }, { id: 4, id_sync: 'p3', Sync_Applique: false, Lieu: 'Brest' }, { id: 5, id_sync: 'p4', Sync_Applique: true },
  ];
  const destRows = [{ id: 101, id_sync: 'p1', Lieu: '1' }, { id: 102, id_sync: 'p2', Lieu: '0' }, { id: 103, id_sync: 'p3', Lieu: '2' }, { id: 104, id_sync: 'seule', Lieu: '5' }, { id: 105, id_sync: 'p4', Lieu: '3' }];
  assert.deepEqual(textFill({ journalRows, destRows, specs: [{ from: 'Lieu', to: 'Lieu' }], destTable: 'Contacts_ici' }), [
    ['BulkUpdateRecord', 'Contacts_ici', [101, 102, 103], { Lieu: ['Villeurbanne', '', 'Brest'] }],
  ]);
  assert.deepEqual(textFill({ journalRows, destRows, specs: [], destTable: 'Contacts_ici' }), []);
});
