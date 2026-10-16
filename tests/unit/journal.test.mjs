// Journal (CIBLE) : dépliage des lignes reçues, lots et listes, purge, historique, lien public.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersion, expandRows, isRaw, latestByKey, nextGaps, parseList, parseLot, planPull, planPurge, planUnpack, recentChanges, rowsByTable, sentColumns } from '../../js/logic/journal.js';
import { KIND } from '../../js/logic/common.js';
import { j, list, done, gone, part, EXPORT } from './fixtures.mjs';

test('la version la plus récente gagne, MajLe puis numéro de ligne', () => {
  assert.ok(compareVersion({ order: 2, id: 1 }, { order: 1, id: 9 }) > 0);
  assert.ok(compareVersion({ order: 1, id: 2 }, { order: 1, id: 1 }) > 0);
  assert.ok(compareVersion({ order: null, id: 9 }, { order: 1, id: 1 }) < 0);
  const latest = latestByKey([j(1, 'a', 10), j(2, 'a', 30), j(3, 'a', 20), j(4, '', 99)]);
  assert.equal(latest.size, 1);
  assert.equal(latest.get('a').id, 2); // la version de 20 arrivée en retard est ignorée
});

test('purge : par table, la dernière version de chaque clé, la dernière liste, et la ligne la plus récente', () => {
  const C = { Synchro_Table: 'Contacts' };
  const V = { Synchro_Table: 'Villes' };
  const rows = [j(1, 'a', 10, C), j(2, 'a', 20, C), list(3, ['a'], C), j(4, '', 5), list(5, ['a', 'b'], C), j(6, 'a', 15, C),
    j(7, 'a', 1, V), j(8, 'a', 2, V), { id: 9, Synchro_Type: 'lot', Synchro_Table: 'Contacts' }, j(10, '', 0)];
  assert.deepEqual(planPurge(rows, 'J'), [['BulkRemoveRecord', 'J', [1, 3, 4, 6, 7]]], 'ligne brute pas encore dépliée gardée');
  assert.deepEqual(planPurge(rows, 'J', { keep: ['Villes'] }), [['BulkRemoveRecord', 'J', [1, 3, 4, 6]]], 'table proposée : tout est gardé');
  assert.deepEqual(planPurge(rows, 'J', { drop: ['Villes'] }), [['BulkRemoveRecord', 'J', [1, 3, 4, 6, 7, 8]]], 'table refusée : tout part');
  assert.deepEqual(planPurge([j(1, 'a', 1, C)], 'J'), []);
});

test('purge : clés parties pas encore traitées et morceaux du dernier renvoi gardés', () => {
  const C = { Synchro_Table: 'Contacts' };
  const rows = [j(1, 'a', 10, C), { ...part(2, 1, 5, ['a'], false), ...C }, { ...part(3, 1, 6, ['a'], false, 'm2'), ...C },
    gone(4, 7, ['z'], C), gone(5, 8, ['y'], { ...C, ...done }), j(6, 'b', 1, C)];
  assert.deepEqual(planPurge(rows, 'J'), [['BulkRemoveRecord', 'J', [2, 5]]]);
});

test('historique : versions recopiées arrivées après la visite, plus récentes d\'abord, plafonnées', () => {
  const rows = [j(1, 'a', 10, { Sync_Etat: 'ajout' }), j(2, 'a', 30, { Sync_Etat: 'modif', Sync_Recu: 31 }),
    j(3, 'b', 20, { Sync_Etat: 'suppression', Sync_Recu: 40 }), j(4, 'c', 15, { Sync_Etat: 'ajout' }), j(5, 'd', 50), list(6, ['a'])];
  const brief = c => ({ at: c.at, label: c.label, state: c.state });
  assert.deepEqual(recentChanges(rows, 'Nom', 12, 20).map(brief), [
    { at: 40, label: 'n3', state: 'suppression' }, { at: 31, label: 'n2', state: 'modif' }, { at: 15, label: 'n4', state: 'ajout' }]);
  assert.equal(recentChanges(rows, 'Nom', 0, 1).length, 1);
});

test('historique : numéro de ligne d\'ici, avant et après sur les colonnes recopiées', () => {
  const copyCols = [['Nom', 'Nom'], ['Ville', 'Commune']];
  const rows = [
    j(1, 'a', 10, { Ville: 'Lyon', Sync_Etat: 'ajout', Sync_Recu: 11 }),
    j(2, 'b', 20, { Ville: 'Nice', Sync_Etat: 'modif', Sync_Recu: 21, Sync_Avant: JSON.stringify({ v: { Ville: 'Paris' } }) }),
    j(3, 'c', 30, { Ville: 'Metz', Sync_Etat: 'suppression', Sync_Recu: 31, Sync_Avant: JSON.stringify({ n: 7 }) }),
    j(4, 'd', 40, { Sync_Etat: 'modif', Sync_Recu: 41 }),
    j(5, 'e', 50, { Sync_Etat: 'modif', Sync_Recu: 51, Sync_Avant: JSON.stringify({ v: { toString: 'x', constructor: 'y' }, n: -1 }) }),
    j(6, 'f', 60, { Sync_Etat: 'suppression', Sync_Recu: 61, Sync_Avant: '{"n":"3"}' }),
  ];
  const numbers = new Map([['a', 4], ['b', 2], ['c', 9], ['e', 5]]);
  const byKey = Object.fromEntries(recentChanges(rows, 'Nom', 0, 10, { copyCols, numbers }).map(c => [c.label, c]));
  assert.deepEqual(byKey.n1, { at: 11, label: 'n1', state: 'ajout', n: 4, detail: { cols: copyCols, before: null, after: ['n1', 'Lyon'] } });
  assert.deepEqual(byKey.n2, { at: 21, label: 'n2', state: 'modif', n: 2, detail: { cols: [['Ville', 'Commune']], before: ['Paris'], after: ['Nice'] } });
  assert.deepEqual(byKey.n3, { at: 31, label: 'n3', state: 'suppression', n: 7, detail: { cols: copyCols, before: ['n3', 'Metz'], after: null } },
    'une ligne supprimée garde le numéro qu\'elle avait');
  assert.equal(byKey.n4.detail, null, 'modification sans valeurs d\'avant notées (version plus ancienne) : pas de détail');
  assert.deepEqual([byKey.n5.n, byKey.n5.detail], [5, null], 'seules les colonnes recopiées sont lues');
  assert.equal(byKey.n6.n, null, 'numéro illisible ignoré');
});

test('lot : lignes reçues, lignes illisibles écartées', () => {
  const lot = parseLot(JSON.stringify({ lignes: [['k1', 10, false, { Nom: 'A' }], ['', 1, false, {}], ['k2', null, 1, { Nom: 'B' }], 'x'], total: 7 }));
  assert.deepEqual(lot, { lines: [{ key: 'k1', order: 10, deleted: false, data: { Nom: 'A' } }, { key: 'k2', order: null, deleted: true, data: { Nom: 'B' } }], total: 7, big: [] });
  assert.deepEqual(parseLot(JSON.stringify({ lignes: [], total: 1, tropGros: ['k3'] })).big, ['k3']);
  assert.equal(parseLot(''), null);
  assert.equal(parseLot('{"x": 1}'), null);
});

test('CIBLE : dépliage des listes et des lots dans l\'ordre d\'arrivée, lignes manquantes comptées', () => {
  const schema = '[{"id":"Nom","type":"Text","label":"Nom"}]';
  const raw = (id, type, extra) => ({ id, Synchro_Export: 'e', Synchro_Table: 'Contacts', Synchro_Type: type, Synchro_Colonnes: schema, Synchro_Renvoi: '', Sync_Recu: 100 + id, ...extra });
  const rows = [
    { id: 1, id_sync: 'x', Synchro_Table: 'Contacts', Synchro_Type: '' }, // déjà dépliée
    raw(3, 'lot', { Synchro_Lot: JSON.stringify({ lignes: [['b', 20, false, { Nom: 'B' }]], total: 3 }) }),
    raw(2, 'lot', { Synchro_Lot: JSON.stringify({ lignes: [['a', 10, false, { Nom: 'A' }], ['c', 9, true, { Nom: 'C' }]], total: 2 }) }),
    raw(4, 'cles', { Synchro_Ids: 'ids:a b' }),
    raw(5, 'lot', { Synchro_Renvoi: 'm:1,2', Synchro_Table: 'Villes', Synchro_Lot: JSON.stringify({ lignes: [], total: 2 }) }),
    raw(6, 'lot', { Synchro_Table: 'mauvais nom', Synchro_Lot: '{"lignes": [], "total": 0}' }),
  ];
  const { actions, missing, resent, rejected } = planUnpack(rows, 'J');
  assert.equal(rejected, 1, 'table au nom invalide');
  assert.deepEqual(missing, { Contacts: 2, Villes: 0 }, 'un renvoi remet le compte à zéro');
  assert.deepEqual(resent, ['Villes']);
  assert.equal(actions.length, 2);
  const [, , ids, values] = actions[0];
  assert.equal(ids.length, 4);
  assert.deepEqual(values.id_sync, ['a', 'c', 'b', '']);
  assert.deepEqual(values.Synchro_Ids, ['', '', '', 'ids:a b']);
  assert.deepEqual(values.Supprime, [false, true, false, false]);
  assert.deepEqual(values.Synchro_Colonnes, [schema, '', schema, schema], 'la première version de chaque lot porte les colonnes');
  assert.deepEqual(values.Sync_Recu, [102, 102, 103, 104]);
  assert.deepEqual(values.Synchro_Donnees.slice(0, 3), ['{"Nom":"A"}', '{"Nom":"C"}', '{"Nom":"B"}']);
  assert.deepEqual(actions[1], ['BulkRemoveRecord', 'J', [2, 3, 4, 5, 6]]);
  assert.deepEqual(planUnpack(rows.slice(0, 1), 'J'), { actions: [], missing: {}, big: {}, arrived: {}, resent: [], rejected: 0, left: 0 });
  const empty = raw(10, 'cles', { Synchro_Ids: '', Synchro_Colonnes: '' });
  assert.deepEqual(planUnpack([empty], 'J').actions, [['BulkRemoveRecord', 'J', [10]]], 'liste vide sans colonnes : rien à garder');
  const seaux = '{"t": 1, "seaux": {"3": ["a"]}}';
  assert.deepEqual(planUnpack([{ ...empty, Synchro_Ids: seaux }], 'J').actions[0][3].Synchro_Ids, [seaux]);
  const cut = raw(7, 'lot', { Synchro_Lot: JSON.stringify({ lignes: [], total: 4 }) });
  const again = raw(8, 'lot', { Synchro_Renvoi: 'm:1', Synchro_Lot: JSON.stringify({ lignes: [], total: 1 }) });
  assert.deepEqual(planUnpack([cut, again], 'J').missing, { Contacts: 0 }, 'coupé puis renvoyé');
  assert.deepEqual(planUnpack([again, { ...cut, id: 9 }], 'J').missing, { Contacts: 4 }, 'renvoyé puis coupé');
});

test('CIBLE : lignes forgées par le lien du formulaire effacées et comptées, passage limité', () => {
  const ok = { id: 1, Synchro_Export: 'e', Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Colonnes: '[]', Synchro_Renvoi: '', Synchro_Lot: '{"lignes": [["k", 1, false, {}]], "total": 1}' };
  const forged = [
    { ...ok, id: 2, Synchro_Export: 'autre' },
    { ...ok, id: 3, Synchro_Type: 'complet' },
    { ...ok, id: 4, Synchro_Lot: 'pas du JSON' },
    { ...ok, id: 5, Synchro_Colonnes: '{"x": 1}' },
    { ...ok, id: 6, Synchro_Type: 'cles', Synchro_Lot: '', Synchro_Ids: '{"moins": ["k"]}' },
    { ...ok, id: 7, Synchro_Type: 'cles', Synchro_Lot: '', Synchro_Ids: 'x' },
  ];
  const plan = planUnpack([ok, ...forged], 'J', { exportId: 'e' });
  assert.equal(plan.rejected, 6);
  assert.deepEqual(plan.arrived, { Contacts: ['k'] }, 'seule la ligne de l\'export est dépliée');
  assert.deepEqual(plan.actions.at(-1), ['BulkRemoveRecord', 'J', [1, 2, 3, 4, 5, 6, 7]], 'toutes les lignes reçues sont effacées');
  assert.equal(planUnpack([ok, ...forged], 'J').rejected, 5, 'sans export attendu, seul l\'export n\'est pas vérifié');
  const limited = planUnpack([...forged, ok], 'J', { exportId: 'e', max: 2 });
  assert.deepEqual([limited.rejected, limited.left], [1, 5]);
  assert.deepEqual(limited.actions.at(-1), ['BulkRemoveRecord', 'J', [1, 2]], 'les plus anciennes d\'abord');
});

test('CIBLE : fin d\'envoi annoncée par la SOURCE, effacée si des données arrivent ensuite', () => {
  const lot = { id: 1, Synchro_Export: 'e', Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Colonnes: '[]', Synchro_Renvoi: '', Synchro_Lot: '{"lignes": [["k", 1, false, {}]], "total": 1}', Sync_Recu: 50 };
  const end = { id: 2, Synchro_Export: 'e', Synchro_Type: KIND.end, Sync_Recu: 60 };
  const plan = planUnpack([lot, end], 'J', { exportId: 'e' });
  assert.deepEqual([plan.ended, plan.rejected], [{ at: 60 }, 0], 'la fin, arrivée après la dernière donnée');
  assert.deepEqual(plan.arrived, { Contacts: ['k'] });
  assert.deepEqual(plan.actions.at(-1), ['BulkRemoveRecord', 'J', [1, 2]], 'la ligne de fin est effacée aussi');
  assert.equal(planUnpack([end, { ...lot, id: 3 }], 'J', { exportId: 'e' }).ended, null, 'des données après la fin : l\'envoi a repris');
  assert.equal(planUnpack([lot], 'J', { exportId: 'e' }).ended, null, 'des données seules : l\'envoi est actif');
  assert.deepEqual(planUnpack([{ ...end, Sync_Recu: null }], 'J', { exportId: 'e' }).ended, { at: null });
  const other = planUnpack([{ ...end, Synchro_Export: 'autre' }], 'J', { exportId: 'e' });
  assert.deepEqual([other.ended, other.rejected], [undefined, 1], 'la fin d\'un autre export est rejetée');
  assert.equal(planUnpack([end], 'J').rejected, 1, 'sans export attendu (lien public), pas de fin');
  assert.ok(!('ended' in planUnpack([], 'J', { exportId: 'e' })), 'rien reçu : rien sur la fin');
});

test('CIBLE : lignes manquantes et lignes trop grosses suivies d\'un dépliage à l\'autre', () => {
  const unpack = { missing: { A: 2 }, big: { A: ['k1'], B: ['k2'] }, arrived: { A: ['k9'] }, resent: [] };
  let gaps = nextGaps({}, unpack);
  assert.deepEqual(gaps, { missing: { A: 2 }, big: { A: ['k1'], B: ['k2'] } });
  gaps = nextGaps(gaps, { missing: {}, big: {}, arrived: { B: ['k2'] }, resent: [] });
  assert.deepEqual(gaps.big, { A: ['k1'] }, 'une ligne arrivée n\'est plus signalée');
  assert.deepEqual(nextGaps(gaps, { missing: { A: 0 }, big: {}, arrived: {}, resent: ['A'] }), { missing: {}, big: {} }, 'un renvoi remet à zéro');
});

test('CIBLE : lignes dépliées rangées par table d\'origine, lignes brutes à part', () => {
  const groups = rowsByTable([{ id: 1, Synchro_Table: 'A' }, { id: 2, Synchro_Table: 'B' }, { id: 3, Synchro_Table: 'A' },
    { id: 4, Synchro_Table: 'A', Synchro_Type: 'lot' }, { id: 5, Synchro_Table: '' }]);
  assert.deepEqual([...groups].map(([table, rows]) => [table, rows.map(r => r.id)]), [['A', [1, 3]], ['B', [2]]]);
});

test('CIBLE : bloc JSON déplié, colonnes envoyées lues dans la dernière liste', () => {
  const rows = expandRows([
    { id: 1, id_sync: 'a', Synchro_Donnees: '{"Nom": "Alice", "Tags": ["x", "y"], "id": 99}' },
    { id: 2, id_sync: 'b', Nom: 'ancien format' },
    { id: 3, id_sync: '', Synchro_Ids: 'ids:a', Synchro_Colonnes: '[{"id":"Nom","type":"Text","label":"Nom"}]' },
  ]);
  assert.equal(rows[0].Nom, 'Alice');
  assert.deepEqual(rows[0].Tags, ['L', 'x', 'y']);
  assert.equal(rows[0].id, 1, 'le numéro de ligne du Journal reste le sien');
  assert.equal(rows[1].Nom, 'ancien format');
  assert.deepEqual(sentColumns(rows).map(c => c.id), ['Nom']);
  assert.deepEqual(sentColumns(rows.slice(0, 2), [{ id: 'X', type: 'Text' }]).map(c => c.id), ['X']);
});

test('lien public : seules les versions nouvelles et une liste changée entrent au journal', () => {
  const schema = '[{"id":"Nom","type":"Text","label":"Nom"}]';
  const full = lignes => ({ id: 1, fields: { Synchro_Table: 'Contacts', Synchro_Type: 'complet', Synchro_Colonnes: schema, Synchro_Lot: JSON.stringify({ lignes, total: lignes.length }) } });
  const C = { Synchro_Table: 'Contacts' };
  const journalRows = [
    { id: 1, ...C, id_sync: 'a', MajLe: 10, Supprime: false, Synchro_Donnees: '{"Nom":"A"}' },
    { id: 2, ...C, id_sync: 'b', MajLe: 20, Supprime: false, Synchro_Donnees: '{"Nom":"B"}' },
    { id: 3, ...C, id_sync: '', Synchro_Ids: 'ids:b a', Synchro_Colonnes: schema },
  ];
  const both = [['a', 10, false, { Nom: 'A' }], ['b', 20, false, { Nom: 'B2' }]];
  assert.deepEqual(planPull({ records: [full(both)], journalRows, journalTable: 'J' }).actions, [
    ['BulkAddRecord', 'J', [null], { Synchro_Table: ['Contacts'], id_sync: ['b'], MajLe: [20], Supprime: [false], Synchro_Donnees: ['{"Nom":"B2"}'] }],
  ]);
  const removed = planPull({ records: [full(both.slice(0, 1))], journalRows, journalTable: 'J' });
  assert.deepEqual(removed.actions, [['AddRecord', 'J', null, { Synchro_Table: 'Contacts', Synchro_Ids: 'ids:a', Synchro_Colonnes: schema }]]);
  const other = { id: 2, fields: { ...full(both).fields, Synchro_Type: 'lot' } };
  assert.deepEqual(planPull({ records: [other], journalRows, journalTable: 'J' }), { actions: [], tooBig: [] }, 'seules les lignes « complet » comptent');
  const big = { id: 3, fields: { ...full([]).fields, Synchro_Lot: JSON.stringify({ lignes: [], total: 90000, trop: true }) } };
  assert.deepEqual(planPull({ records: [big], journalRows, journalTable: 'J' }), { actions: [], tooBig: ['Contacts'] }, 'instantané trop gros : rien n\'est effacé');
});

// Cas limites.

test('listes et lots reçus : formes inattendues', () => {
  assert.equal(parseList(''), null);
  assert.equal(parseList('{}'), null);
  assert.equal(parseList('[1,2]'), null);
  assert.equal(parseList('{"t":"hier","seaux":{"1":["a"]}}'), null, 'heure qui n\'est pas un nombre');
  assert.equal(parseList('{"t":1,"seaux":{"999":["a"],"x":["b"]}}'), null, 'seaux hors limites');
  assert.deepEqual([...parseList('{"t":1,"seaux":{"3":["a","",null,5]}}').buckets.keys.get(3)], ['a', '5']);
  assert.equal(parseList('{"liste":{"marque":"m","n":0,"t":1}}'), null, 'morceau numéro 0');
  assert.deepEqual(parseList('ids:a  b ').full, ['a', 'b']);
  assert.equal(parseLot('null'), null);
  assert.equal(parseLot('{"lignes":"x"}'), null);
  const lot = parseLot(JSON.stringify({
    lignes: [['k', 1, 'oui', { A: 1 }], ['', 2, false, {}], ['j', 3, false, null], 'x', [5, null, 0, {}], ['l', 4, false, []], ['m', 'hier', false, {}], [{}, 5, false, {}]],
    total: 'trois',
  }));
  assert.deepEqual(lot.lines.map(l => [l.key, l.deleted]), [['k', true], ['5', false]], 'clé vide ou pas un texte, bloc absent ou liste, heure qui n\'est pas un nombre : écartés');
  assert.equal(lot.total, 2, 'total illisible : les lignes lues');
});

test('dépliage : lignes brutes forgées sans effet, liste vide ignorée', () => {
  const lot = JSON.stringify({ lignes: [['k', 1, false, { Nom: 'A' }]], total: 1 });
  const raw = [
    { id: 1, Synchro_Export: EXPORT, Synchro_Table: 'Contacts', Synchro_Type: KIND.full, Synchro_Lot: lot },
    { id: 2, Synchro_Export: EXPORT, Synchro_Table: 'Contacts', Synchro_Type: KIND.keys, Synchro_Ids: '' },
    { id: 3, Synchro_Export: EXPORT, Synchro_Table: '', Synchro_Type: KIND.lot, Synchro_Lot: lot },
    { id: 4, Synchro_Export: EXPORT, Synchro_Table: 'Contacts', Synchro_Type: KIND.lot, Synchro_Lot: lot, Synchro_Colonnes: '{"pas":"une liste"}' },
    { id: 5, Synchro_Export: EXPORT, Synchro_Table: 'Contacts', Synchro_Type: KIND.swap },
  ];
  const plan = planUnpack(raw, 'J', { exportId: EXPORT });
  assert.equal(plan.rejected, 4, 'instantané hors lien public, table vide, colonnes illisibles, type inconnu');
  assert.deepEqual(plan.actions, [['BulkRemoveRecord', 'J', [1, 2, 3, 4, 5]]], 'tout est effacé, rien n\'est ajouté');
  assert.ok(isRaw({ Synchro_Type: 'x' }) && !isRaw({ Synchro_Type: '' }) && !isRaw({}));
});

test('bloc JSON déplié : seules les clés qui peuvent être des colonnes', () => {
  const [row] = expandRows([{ id: 1, Nom: 'garde', Synchro_Donnees: JSON.stringify({ Nom: 'écrasé ?', 'a b': 1, __proto__: { x: 1 }, Tags: ['a', 'b'] }) }]);
  assert.equal(row.Nom, 'garde', 'une colonne du journal l\'emporte sur le bloc');
  assert.deepEqual(row.Tags, ['L', 'a', 'b']);
  assert.ok(!('a b' in row));
  assert.equal({}.x, undefined, 'aucune pollution du prototype');
  assert.deepEqual(expandRows([{ id: 2, Synchro_Donnees: 'pas du JSON' }]), [{ id: 2, Synchro_Donnees: 'pas du JSON' }]);
});

test('versions : dates vides, textes et nombres', () => {
  assert.ok(compareVersion({ order: null, id: 9 }, { order: 1, id: 1 }) < 0, 'sans date : plus ancienne');
  assert.ok(compareVersion({ order: null, id: 2 }, { order: '', id: 1 }) > 0, 'deux sans date : la dernière arrivée');
  assert.ok(compareVersion({ order: '2026-10-15', id: 1 }, { order: '2026-10-14', id: 2 }) > 0);
});

test('purge : journal vide, tables refusées effacées', () => {
  assert.deepEqual(planPurge([], 'J'), []);
  const rows = [{ id: 1, Synchro_Table: 'Villes', id_sync: 'v', MajLe: 1 }, { id: 2, Synchro_Table: 'Contacts', id_sync: 'c', MajLe: 1 }, { id: 3, Synchro_Table: 'Villes', id_sync: 'v', MajLe: 2 }];
  assert.deepEqual(planPurge(rows, 'J', { drop: ['Villes'] }), [['BulkRemoveRecord', 'J', [1]]], 'la ligne la plus récente reste (numéro non réutilisé)');
});

test('historique : dates illisibles écartées', () => {
  const rows = [{ id: 1, id_sync: 'a', MajLe: 'hier', Sync_Etat: 'ajout' }, { id: 2, id_sync: 'b', MajLe: 5, Sync_Etat: 'modif', Sync_Recu: 9, Nom: null }];
  assert.deepEqual(recentChanges(rows, 'Nom', 0, 10), [{ at: 9, label: '', state: 'modif', n: null, detail: null }]);
});

test('noms reçus : aucune table ne peut viser une propriété des objets JavaScript', () => {
  const lot = JSON.stringify({ lignes: [['k', 1, false, { Nom: 'A' }]], total: 2 });
  const row = (id, table) => ({ id, Synchro_Export: EXPORT, Synchro_Table: table, Synchro_Type: KIND.lot, Synchro_Lot: lot });
  const plan = planUnpack([row(1, '__proto__'), row(2, 'constructor'), row(3, 'toString'), row(4, 'Contacts')], 'J', { exportId: EXPORT });
  assert.equal(plan.rejected, 3);
  assert.deepEqual([Object.keys(plan.arrived), plan.missing], [['Contacts'], { Contacts: 1 }]);
});

test('ce qui manque : tables refusées ignorées, note plafonnée', () => {
  const missing = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`T${i}`, 1]));
  const gaps = nextGaps({ refused: ['T249'] }, { missing, big: { T248: ['k'] }, arrived: {}, resent: [] });
  assert.equal(Object.keys(gaps.missing).length, 200, 'au plus 200 tables suivies');
  assert.ok(!('T249' in gaps.missing) && 'T248' in gaps.missing, 'table refusée écartée, les plus récentes gardées');
  assert.deepEqual(gaps.big, { T248: ['k'] });
  const many = Array.from({ length: 1500 }, (_, i) => `k${i}`);
  assert.equal(nextGaps({}, { missing: {}, big: { A: many }, arrived: {}, resent: [] }).big.A.length, 1000, 'au plus 1 000 clés trop grosses par table');
});

test('lots démesurés : trop de lignes refusées, clés trop grosses plafonnées', () => {
  const line = i => [`k${i}`, 1, false, {}];
  assert.equal(parseLot(JSON.stringify({ lignes: Array.from({ length: 100001 }, (_, i) => line(i)) })), null, 'plus de 100 000 lignes');
  assert.equal(parseLot(JSON.stringify({ lignes: [line(1)], tropGros: Array.from({ length: 1500 }, (_, i) => `k${i}`) })).big.length, 1000);
  assert.deepEqual(parseLot(JSON.stringify({ lignes: [], trop: true })), { lines: [], total: 0, big: [], tooBig: true });
});

test('historique : seuls les trois états connus sont montrés', () => {
  const rows = [{ id: 1, id_sync: 'a', MajLe: 5, Sync_Etat: '<img src=x>' }, { id: 2, id_sync: 'b', MajLe: 6, Sync_Etat: 'suppression' }, { id: 3, id_sync: 'c', MajLe: 7, Sync_Etat: '' }];
  assert.deepEqual(recentChanges(rows, null, 0, 10), [{ at: 6, label: '', state: 'suppression', n: null, detail: null }]);
});
