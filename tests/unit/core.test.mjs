// Tests unitaires de la logique pure : `node --test tests/unit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInvitation, buildReply, buildWebhookUrl, chunk, conditionExport, exportCondition, exportRowsActions, exportTables, exportableColumns, expandRows,
  sentColumns, compareVersion, copyColumns, chunkMark, majleAction, rowsSince, addTrackRowsAction, bucketOf, crc32, listOverdue, listRequest, parseList, trackState, RESEND_ALL, decodeCode, fillKeyActions, freeTableId, hookName, latestByKey, maskKey, parseDocBaseUrl,
  newColumnsMap, nextGaps, docLabel, followRenames, destRefs, rowFilter, parseFormLink, parseInvitation, parseLot, parseReply, parseWebhookUrl, loopingTables, planConsolidation, planPull, planPurge, planUnpack,
  publicAclActions, publicAclRules, recentChanges, prepareSourceActions, resendValue, rowsByTable, syncColumns, syncFormulas, toRows, toTableId,
} from '../../js/core.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const j = (id, key, majle, extra = {}) => ({ id, id_sync: key, MajLe: majle, Supprime: false, Nom: `n${id}`, ...extra });

test('toRows et chunk', () => {
  assert.deepEqual(toRows({ id: [1, 2], A: ['x', 'y'] }), [{ id: 1, A: 'x' }, { id: 2, A: 'y' }]);
  assert.deepEqual(toRows(null), []);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test('toTableId et freeTableId', () => {
  assert.equal(toTableId('journal des élèves'), 'Journal_des_eleves');
  assert.equal(toTableId('2024'), 'T_2024');
  assert.equal(toTableId('  '), 'Table');
  assert.equal(freeTableId('Journal_A', ['Journal_B']), 'Journal_A');
  assert.equal(freeTableId('Journal_A', ['Journal_A', 'Journal_A_2']), 'Journal_A_3');
});

test('la version la plus récente gagne, MajLe puis numéro de ligne', () => {
  assert.ok(compareVersion({ order: 2, id: 1 }, { order: 1, id: 9 }) > 0);
  assert.ok(compareVersion({ order: 1, id: 2 }, { order: 1, id: 1 }) > 0);
  assert.ok(compareVersion({ order: null, id: 9 }, { order: 1, id: 1 }) < 0);
  const latest = latestByKey([j(1, 'a', 10), j(2, 'a', 30), j(3, 'a', 20), j(4, '', 99)]);
  assert.equal(latest.size, 1);
  assert.equal(latest.get('a').id, 2); // la version de 20 arrivée en retard est ignorée
});

test('copyColumns ignore les colonnes techniques et les formules de la destination', () => {
  const journal = ['id_sync', 'MajLe', 'Supprime', 'Nom', 'Ville', 'Age', 'manualSort', 'gristHelper_X'].map(colId => ({ colId }));
  const dest = [{ colId: 'id_sync' }, { colId: 'Nom' }, { colId: 'Ville', isFormula: true }, { colId: 'Age' }];
  assert.deepEqual(copyColumns(journal, dest), [['Nom', 'Nom'], ['Age', 'Age']]);
  assert.deepEqual(copyColumns(journal, [...dest, { colId: 'Commune' }], { Ville: 'Commune' }), [['Nom', 'Nom'], ['Ville', 'Commune'], ['Age', 'Age']]);
});

const plan = (journalRows, destRows, matchCol) => planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'Dest', journalTable: 'J', matchCol });
const marked = (ids, states) => ['BulkUpdateRecord', 'J', ids, { Sync_Applique: ids.map(() => true), Sync_Etat: states }];
const list = (id, keys, extra = {}) => ({ id, id_sync: '', Synchro_Ids: `ids:${keys.join(' ')}`, ...extra });
const done = { Sync_Applique: true };

test('consolidation : ajout, mise à jour, suppression, versions déjà appliquées ignorées', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 10, done), j(3, 'c', 10, done), j(4, 'd', 10, done),
    j(5, 'b', 20, { Nom: 'b2' }), j(6, 'd', 20, { Supprime: true }), j(7, 'e', 10)];
  const destRows = [{ id: 11, id_sync: 'b' }, { id: 12, id_sync: 'c', Nom: 'retouche manuelle' }, { id: 13, id_sync: 'd' }];
  const { actions, stats } = plan(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 1, removed: 1 });
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b', 'e'] }, { Nom: ['b2', 'n7'] }, { on_many: 'all' }],
    ['BulkRemoveRecord', 'Dest', [13]],
    marked([5, 6, 7], ['modif', 'suppression', 'ajout']),
  ]);
});

test('consolidation : une version arrivée en retard ne remplace pas une plus récente', () => {
  const { actions } = plan([j(1, 'a', 20, done), j(2, 'a', 10, { Nom: 'ancienne' })], [{ id: 1, id_sync: 'a' }]);
  assert.deepEqual(actions, []);
});

test('consolidation : une clé absente de la liste est effacée, sauf version plus récente', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 10, done), list(3, ['a'], { Sync_Recu: 50 }), j(4, 'c', 10)];
  const destRows = [{ id: 1, id_sync: 'a' }, { id: 2, id_sync: 'b' }, { id: 3, id_sync: '' }];
  const { actions, stats } = plan(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 0, removed: 1 });
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['c'] }, { Nom: ['n4'] }, { on_many: 'all' }],
    ['BulkRemoveRecord', 'Dest', [2]],
    marked([3, 4], ['', 'ajout']),
    ['BulkUpdateRecord', 'J', [2], { Sync_Etat: ['suppression'], Sync_Recu: [50] }],
  ]);
});

test('consolidation : une ligne déjà là est rattachée par la colonne commune au lieu d\'être doublée', () => {
  const journalRows = [j(1, 'a', 10, { Nom: 'Lyon' }), j(2, 'b', 10, { Nom: 'Paris' })];
  const destRows = [{ id: 7, id_sync: '', Nom: 'Lyon' }, { id: 8, id_sync: '', Nom: 'Nice' }];
  const { actions, stats } = plan(journalRows, destRows, 'Nom');
  assert.deepEqual(stats, { added: 1, updated: 1, removed: 0 });
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b'] }, { Nom: ['Paris'] }, { on_many: 'all' }],
    ['BulkUpdateRecord', 'Dest', [7], { id_sync: ['a'], Nom: ['Lyon'] }],
    marked([1, 2], ['modif', 'ajout']),
  ]);
});

test('consolidation : une version identique à la destination est sans effet (renvoi)', () => {
  const journalRows = [j(1, 'a', 10, { Nom: 'Lyon' }), j(2, 'b', 10, { Nom: '', Tags: ['x'] })];
  const destRows = [{ id: 7, id_sync: 'a', Nom: 'Lyon' }, { id: 8, id_sync: 'b', Nom: null, Tags: ['L', 'x'] }];
  const { actions, stats } = planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom'], ['Tags', 'Tags']], destTable: 'Dest', journalTable: 'J' });
  assert.deepEqual(stats, { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(actions, [marked([1, 2], ['', ''])]);
});

test('consolidation : un renvoi des mêmes valeurs ne défait pas une retouche manuelle', () => {
  const journalRows = [j(1, 'a', 10, { Nom: 'Lyon', ...done }), j(2, 'a', 10, { Nom: 'Lyon' }), j(3, 'b', 10, { Nom: 'Nice', ...done }), j(4, 'b', 10, { Nom: 'Nice' })];
  const destRows = [{ id: 7, id_sync: 'a', Nom: 'retouche' }];
  const { actions, stats } = plan(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 0, removed: 0 }, 'une ligne effacée à la main revient');
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['b'] }, { Nom: ['Nice'] }, { on_many: 'all' }],
    marked([2, 4], ['', 'ajout']),
  ]);
  assert.deepEqual(plan([...journalRows.slice(0, 1), j(2, 'a', 11, { Nom: 'Lille' })], destRows).stats.updated, 1, 'une vraie modification passe');
});

// Seaux qui ont perdu les clés `keys` : chacun part avec ses clés restantes (parmi `left`).
const gone = (id, t, keys, extra = {}, left = []) => ({ id, id_sync: '', ...extra, Synchro_Ids: JSON.stringify({ t,
  seaux: Object.fromEntries(keys.map(k => [bucketOf(k), left.filter(x => bucketOf(x) === bucketOf(k))])) }) });
const part = (id, n, t, keys, last, mark = 'm1') => ({ id, id_sync: '', Synchro_Ids: JSON.stringify({ liste: { marque: mark, n, t, cles: keys, fin: last } }) });

test('seau d\'une clé : CRC-32 comme zlib.crc32 en Python, 256 seaux', () => {
  assert.equal(crc32('123456789'), 0xcbf43926, 'valeur de contrôle du CRC-32');
  assert.equal(crc32('été'), 0x44d16cd4, 'UTF-8, comme str.encode() en Python');
  assert.equal(bucketOf('123456789'), 0xcb);
  assert.ok([...Array(2000).keys()].every(i => bucketOf(`k${i}`) >= 0 && bucketOf(`k${i}`) < 256));
});

test('consolidation : clés parties d\'un seau effacées, sauf version plus récente à l\'heure de la SOURCE', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 10, done), j(3, 'c', 30), j(4, 'e', 5), gone(5, 20, ['b', 'c', 'e', 'x'], { Sync_Recu: 60 }, ['a'])];
  const destRows = [{ id: 1, id_sync: 'a' }, { id: 2, id_sync: 'b' }];
  const { actions, stats } = plan(journalRows, destRows);
  assert.deepEqual(stats, { added: 1, updated: 0, removed: 1 }, 'c recréée après coup reste ; e, partie avant d\'être recopiée, n\'arrive pas');
  assert.deepEqual(actions, [
    ['BulkAddOrUpdateRecord', 'Dest', { id_sync: ['c'] }, { Nom: ['n3'] }, { on_many: 'all' }],
    ['BulkRemoveRecord', 'Dest', [2]],
    marked([5, 3, 4], ['', 'ajout', '']),
    ['BulkUpdateRecord', 'J', [2], { Sync_Etat: ['suppression'], Sync_Recu: [60] }],
  ]);
});

test('consolidation : liste complète en morceaux, appliquée une fois tous arrivés', () => {
  const base = [j(1, 'a', 10, done), j(2, 'b', 10, done), j(3, 'd', 50, done)];
  const destRows = [{ id: 1, id_sync: 'a' }, { id: 2, id_sync: 'b' }, { id: 3, id_sync: 'd' }];
  assert.deepEqual(plan([...base, part(4, 1, 40, ['a'], false)], destRows).actions, [], 'un morceau seul attend les autres');
  const { actions, stats } = plan([...base, part(4, 1, 40, ['a'], false), part(5, 2, 41, ['c'], true)], destRows);
  assert.equal(stats.removed, 1, 'b absente ; d, créée pendant le renvoi (heure 50), reste');
  assert.deepEqual(actions, [['BulkRemoveRecord', 'Dest', [2]], marked([4, 5], ['', '']), ['BulkUpdateRecord', 'J', [2], { Sync_Etat: ['suppression'], Sync_Recu: [null] }]]);
  const replaced = plan([...base, part(4, 1, 40, ['a'], false), part(5, 1, 60, ['a'], false, 'm2')], destRows);
  assert.deepEqual(replaced.actions, [marked([4], [''])], 'renvoi interrompu, repris sous une autre marque : l\'ancien morceau ne sert plus');
});

test('consolidation idempotente : rejouer après application ne fait rien', () => {
  const journalRows = [j(1, 'a', 10, done), j(2, 'b', 20, { Supprime: true, ...done }), list(3, ['a'], done)];
  assert.deepEqual(plan(journalRows, [{ id: 1, id_sync: 'a', Nom: 'n1' }]).actions, []);
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
  assert.deepEqual(recentChanges(rows, 'Nom', 12, 20), [
    { at: 40, label: 'n3', state: 'suppression' }, { at: 31, label: 'n2', state: 'modif' }, { at: 15, label: 'n4', state: 'ajout' }]);
  assert.equal(recentChanges(rows, 'Nom', 0, 1).length, 1);
});

test('colonnes envoyables : Référence en texte, pièces jointes bloquées, colonnes techniques exclues', () => {
  const cols = [
    { colId: 'Nom', type: 'Text', label: 'Nom' },
    { colId: 'Ville', type: 'Ref:Villes', visible: 'Nom' },
    { colId: 'Tags', type: 'RefList:Tags', visible: '' },
    { colId: 'Photo', type: 'Attachments' },
    { colId: 'gristHelper_Display', type: 'Any' },
    { colId: 'manualSort', type: 'ManualSortPos' },
    { colId: 'id_sync', type: 'Text' }, { colId: 'MajLe', type: 'DateTime:UTC' }, { colId: 'Supprime', type: 'Bool' },
  ];
  const sendable = exportableColumns(cols);
  assert.deepEqual(sendable.map(c => [c.id, c.type, c.blocked]), [['Nom', 'Text', false], ['Ville', 'Text', false], ['Tags', 'Text', false], ['Photo', 'Attachments', true]]);
  assert.deepEqual(sendable[1], { id: 'Ville', label: 'Ville', type: 'Text', source: 'Ref:Villes', visible: 'Nom', blocked: false });
});

test('table Synchro : ses colonnes, et des formules qui nomment les tables des exports', () => {
  assert.deepEqual(syncColumns([]).map(c => c.id),
    ['Synchro_Export', 'Synchro_Table', 'Synchro_Type', 'Synchro_Colonnes', 'Synchro_Renvoi', 'Synchro_Ids', 'Synchro_Lot', 'Sync_Etat', 'Sync_Par']);
  const { keys, lot, state } = syncFormulas(['Villes', 'Contacts', 'Villes', 'mauvais nom']);
  assert.match(keys, /^if \$Synchro_Type not in \("cles", "suivi"\): return ""\ntables = \{"Contacts": Contacts, "Villes": Villes\}\nsrc = tables\.get\(\$Synchro_Table\)/);
  assert.match(keys, /  sums = \[zlib\.crc32\(str\(r\.id_sync\)\.encode\(\)\) for r in src\.all if r\.id_sync and keep\(r\)\]\n  return "%d:%08x" % \(len\(sums\), sum\(sums\) & 0xffffffff\)/,
    'suivi : nombre de clés et somme de leurs CRC-32, recalculés à chaque changement des clés');
  assert.match(keys, /s = Synchro\.lookupOne\(Synchro_Export=\$Synchro_Export, Synchro_Table=\$Synchro_Table, Synchro_Type="suivi"\)/);
  assert.match(keys, /out = \{"t": state\["t"\], "seaux": state\["seaux"\]\} if state\.get\("seaux"\) else \{\}/, 'seuls les seaux qui ont perdu une clé partent');
  assert.match(keys, /i = bisect\.bisect_right\(have, str\(ask\.get\("apres"\) or ""\)\)/, 'un morceau reprend après la dernière clé du précédent');
  assert.match(keys, /"t": state\["t"\], "cles": have\[i:i \+ 5000\], "fin": i \+ 5000 >= len\(have\)\}/, 'liste complète en morceaux, au renvoi seulement, à l\'heure du suivi');
  for (const formula of [keys, lot, state]) {
    assert.match(formula, /f = Synchro\.lookupOne\(Synchro_Export=\$Synchro_Export, Synchro_Table=\$Synchro_Table, Synchro_Type="filtre"\)/, 'filtre de la table lu dans sa ligne');
    assert.match(formula, /def keep\(r\): return not spec or txt\(g\(r, spec\)\) == spec\["value"\]/);
  }
  assert.match(lot, /rows = \[r for r in src\.all if r\.id_sync and keep\(r\)\]/, 'seules les lignes du filtre partent');
  assert.match(lot, /tables = \{"Contacts": Contacts, "Villes": Villes\}/);
  // Variables en minuscules : une table nommée T ou D (majuscule, comme toute table Grist) ne
  // les masque pas.
  assert.doesNotMatch(lot, /\b[A-Z] = /);
  assert.match(lot, /timedelta\(seconds=5\)/);
  assert.match(lot, /lists = Synchro\.lookupRecords\(Synchro_Export=\$Synchro_Export, Synchro_Type="cles"\)/);
  assert.match(lot, /room = 950000 - sum\(len\(r\.Synchro_Ids or ""\) for r in lists\)\nbudget = max\(20000, min\(250000, room \/\/ max\(1, len\(lists\)\)\)\)/,
    'les lots d\'un export se partagent ce que leurs listes des clés laissent');
  assert.match(lot, /if capped and n > max\(budget, room\):\n    big\.append\(r\.id_sync\)\n    continue/, 'une ligne plus grosse qu\'un envoi est signalée');
  assert.match(lot, /if capped and out and size \+ n > budget: break/, 'la première ligne part seule, même au-delà du plafond');
  assert.match(lot, /undone = set\(r\.id for r in rows if r\.id not in recent and not echo\(r\) and \(getattr\(r, "RecalculLe", None\) or cut\) > cut\)/,
    'une ligne annulée (RecalculLe récent, MajLe ancienne) repart');
  assert.match(lot, /    x, y = getattr\(r, "RecuLe", None\), getattr\(r, "RecalculLe", None\)\n    return bool\(x and y and y > cut and abs\(\(y - x\)\.total_seconds\(\)\) < 1\)/,
    'une ligne écrite par la consolidation d\'un Échange : RecuLe et RecalculLe recalculées ensemble');
  assert.match(lot, /  swap = Synchro\.lookupOne\(Synchro_Export=\$Synchro_Export, Synchro_Type="echange"\)\.id/);
  assert.match(lot, /  fresh = set\(\) if swap else set\(r\.id for r in rows if r\.id not in recent and echo\(r\)\)/,
    'une ligne reçue par l\'Échange part vers les autres exports, pas vers l\'autre document');
  assert.match(lot, /if len\(recent\) \+ len\(undone\) == len\(rows\) > \(0 if swap else 20\): undone = set\(\)/, 'un rechargement du document n\'est pas une annulation');
  assert.match(lot, /def when\(r\): return v\(getattr\(r, "RecalculLe"\) if r\.id in undone else r\.MajLe\)/, 'une annulation part à son heure');
  assert.match(lot, /lot\.update\(depuis=v\(cut\), renvoi=bool\(again\)\)/, 'un lot coupé dit depuis quand');
  assert.match(lot, /v\(getattr\(r, "Supprime", False\)\)/, 'Supprime part telle quelle : « Non » ne supprime pas');
  assert.match(syncFormulas([]).keys, /tables = \{\}\nsrc = tables\.get/);
});

test('colonne ajoutée à l\'export après coup : jamais sur une colonne de la destination', () => {
  const entry = { columns: [{ id: 'Nom' }], map: { Ville: 'Commune' } };
  assert.equal(newColumnsMap(entry, [{ id: 'Nom' }, { id: 'Ville' }], ['Nom', 'Commune']), null);
  assert.deepEqual(newColumnsMap(entry, [{ id: 'Nom' }, { id: 'Note' }, { id: 'Tel' }], ['Nom', 'Commune', 'Note', 'Note_2']),
    { Ville: 'Commune', Note: 'Note_3', Tel: 'Tel' });
});

test('suivi des clés et envoi coupé : une colonne de déclenchement, nommée comme une colonne des journaux', () => {
  const { state } = syncFormulas(['Contacts']);
  const mark = syncColumns(['Contacts']).find(c => c.id === 'Sync_Etat');
  assert.deepEqual(mark, { id: 'Sync_Etat', type: 'Any', isFormula: false, formula: state, recalcWhen: 0 });
  assert.match(state, /^import json\nif \$Synchro_Type == "lot":\n  lot = json\.loads\(\$Synchro_Lot or "\{\}"\)\n  if lot\.get\("depuis"\) and not lot\.get\("renvoi"\):\n/,
    'lot : un renvoi coupé ne pose pas de marque');
  assert.match(state, /    return min\(value, lot\["depuis"\]\) if value else lot\["depuis"\]\n  return value\nif \$Synchro_Type != "suivi": return value\n/, 'la plus ancienne date reste');
  assert.match(state, /  b = h \* 256 >> 32\n  sums\[b\] = \(sums\[b\] \+ h\) & 0xffffffff\n  if r\.id > top: fresh\[b\] = \(fresh\[b\] \+ h\) & 0xffffffff/,
    'une somme par seau, et celle des lignes nouvelles (numéro au-delà de top)');
  assert.match(state, /if was == sums: return value/, 'clés inchangées : la cellule ne bouge pas');
  assert.match(state, /moved = set\(b for b in range\(256\) if \(was\[b\] \+ fresh\[b\]\) & 0xffffffff != sums\[b\]\)/,
    'un seau qui n\'a fait que gagner des lignes nouvelles ne part pas');
  assert.match(state, /if sum\(len\(x\) for x in left\.values\(\)\) > 5000: state\["trop"\] = str\(t\)\n  elif left: state\["seaux"\] = /,
    'trop de clés à envoyer : la liste complète sera renvoyée');
  assert.match(state, /if old\.get\("trop"\) and old\["trop"\] != \$Synchro_Renvoi and "trop" not in state: state\["trop"\] = old\["trop"\]\nreturn json\.dumps\(state\)$/,
    'la demande reste jusqu\'à ce que le widget ait renvoyé la liste');
});

test('MajLe suit les colonnes envoyées, leur texte affiché et Supprime', () => {
  const cols = [
    { id: 1, colId: 'id_sync' }, { id: 2, colId: 'MajLe', recalcWhen: 2, recalcDeps: null }, { id: 3, colId: 'Nom' },
    { id: 4, colId: 'Lieu', displayCol: 9 }, { id: 5, colId: 'Supprime' }, { id: 6, colId: 'Interne' }, { id: 9, colId: 'gristHelper_Display' },
  ];
  const action = ['UpdateRecord', '_grist_Tables_column', 2, { recalcWhen: 0, recalcDeps: ['L', 3, 4, 5, 9] }];
  assert.deepEqual(majleAction(cols, ['Lieu', 'Nom']), action);
  cols[1] = { ...cols[1], recalcWhen: 0, recalcDeps: ['L', 3, 4, 5, 9] };
  assert.equal(majleAction(cols, ['Nom', 'Lieu']), null, 'déjà à jour');
  assert.deepEqual(majleAction(cols, ['Nom'])[3].recalcDeps, ['L', 3, 5], 'une colonne retirée de l\'export');
  assert.equal(majleAction(cols.filter(c => c.colId !== 'MajLe'), ['Nom']), null);
  assert.equal(majleAction(cols.filter(c => c.colId !== 'Supprime'), ['Absente']), null);
});

test('table Synchro : lignes d\'un export (liste, lot, instantané public), tables ajoutées, changées ou retirées', () => {
  const col = id => ({ id, type: 'Text', label: id, source: 'Text', visible: '', blocked: false });
  const E = '0123456789abcdef';
  const first = exportRowsActions([], E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(first.changed, ['Contacts', 'Villes']);
  assert.equal(first.actions.length, 1);
  const [, table, ids, values] = first.actions[0];
  assert.equal(table, 'Synchro');
  assert.equal(ids.length, 6);
  assert.deepEqual(values.Synchro_Type, ['cles', 'lot', 'suivi', 'cles', 'lot', 'suivi']);
  assert.deepEqual(values.Synchro_Colonnes[0], '[{"id":"Nom","type":"Text","label":"Nom","source":"Text","visible":""}]');
  const rows = ids.map((_, i) => ({ id: i + 1, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]])) }));
  rows.push({ id: 9, Synchro_Export: 'fedcba9876543210', Synchro_Table: 'Contacts', Synchro_Type: 'cles', Synchro_Colonnes: '[]' });
  assert.deepEqual(exportTables(rows, E), [{ table: 'Contacts', columns: JSON.parse(values.Synchro_Colonnes[0]), filter: null }, { table: 'Villes', columns: JSON.parse(values.Synchro_Colonnes[3]), filter: null }]);
  assert.deepEqual(exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]), { actions: [], changed: [] });
  const edit = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom'), col('Age')] }]);
  assert.deepEqual(edit.changed, ['Contacts']);
  assert.deepEqual(edit.actions.map(a => [a[0], a[2]]), [['BulkUpdateRecord', [1, 2, 3]], ['BulkRemoveRecord', [4, 5, 6]]], 'l\'autre export n\'est pas touché');
  assert.equal(addTrackRowsAction(rows.filter(r => r.Synchro_Export === E)), null, 'chaque table a son suivi');
  const before05 = rows.filter(r => r.Synchro_Type !== 'suivi');
  assert.deepEqual(addTrackRowsAction(before05), ['BulkAddRecord', 'Synchro', [null, null, null], {
    Synchro_Export: [E, E, 'fedcba9876543210'], Synchro_Table: ['Contacts', 'Villes', 'Contacts'], Synchro_Colonnes: [values.Synchro_Colonnes[0], values.Synchro_Colonnes[3], '[]'],
    Synchro_Type: ['suivi', 'suivi', 'suivi'], Synchro_Renvoi: ['', '', ''] }], 'montage 0.4 : le suivi est ajouté');
  const pub = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }], { isPublic: true });
  assert.deepEqual(pub.actions[0][3].Synchro_Type, ['complet', 'complet']);
  assert.deepEqual(pub.changed, []);
  // Filtre de lignes : une ligne 'filtre' par table filtrée ; poser, changer ou retirer un filtre
  // renvoie la table.
  const filter = { id: 'Statut', source: 'Choice', visible: '', value: ' Actif ' };
  const filtered = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')], filter }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(filtered.changed, ['Contacts']);
  assert.deepEqual(filtered.actions[0][3].Synchro_Type, ['filtre']);
  assert.equal(filtered.actions[0][3].Synchro_Colonnes[0], '{"id":"Statut","source":"Choice","visible":"","value":"actif"}');
  const withFilter = [...rows, { id: 10, Synchro_Export: E, Synchro_Table: 'Contacts', Synchro_Type: 'filtre', Synchro_Colonnes: filtered.actions[0][3].Synchro_Colonnes[0] }];
  assert.deepEqual(exportTables(withFilter, E)[0].filter, { id: 'Statut', source: 'Choice', visible: '', value: 'actif' });
  const unfiltered = exportRowsActions(withFilter, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(unfiltered, { actions: [['BulkRemoveRecord', 'Synchro', [10]]], changed: ['Contacts'] });
  assert.equal(rowFilter({ id: 'a;b', value: 'x' }), null);
  assert.equal(rowFilter({ id: 'Actif', source: 'Bool', value: 'Yes' }).value, 'oui', 'case à cocher : oui ou non, en français comme en anglais');
  assert.equal(rowFilter({ id: 'Actif', source: 'Bool', value: 'faux' }).value, 'non');
});

test('webhook d\'un destinataire : condition sur son export, relue à l\'identique seulement', () => {
  const E = '0123456789abcdef';
  assert.equal(exportCondition(E), 'rec.Synchro_Export == "0123456789abcdef" and rec.Synchro_Type in ("cles", "lot")');
  assert.equal(conditionExport(exportCondition(E)), E);
  assert.equal(conditionExport(''), '');
  assert.equal(conditionExport(null), '');
  assert.equal(conditionExport('rec.Synchro_Export == "0123456789abcdef" or True and rec.Synchro_Type in ("cles", "lot")'), '');
  assert.equal(conditionExport(exportCondition('0123456789ABCDEF')), '');
  assert.equal(hookName('Annuaire', E), 'Synchro Annuaire #0123456789abcdef');
  assert.equal(resendValue('ab12', [3, 4]), 'ab12:3,4');
});

test('renvoi reprenable : lignes depuis la marque, dans l\'ordre de MajLe ; la marque avance par tranche', () => {
  const rows = [{ id: 1, MajLe: 30 }, { id: 2, MajLe: null }, { id: 3, MajLe: 10 }, { id: 4, MajLe: 20 }, { id: 5, MajLe: 10 }];
  assert.deepEqual(rowsSince(rows, RESEND_ALL).map(r => r.id), [2, 3, 5, 4, 1], 'toute la table, lignes sans MajLe d\'abord');
  assert.deepEqual(rowsSince(rows, 20).map(r => r.id), [4, 1]);
  assert.deepEqual(rowsSince(rows, 31), []);
  const all = rowsSince(rows, RESEND_ALL);
  assert.equal(chunkMark(all.slice(0, 2), RESEND_ALL), RESEND_ALL, 'lignes sans MajLe : toute la table reste à envoyer');
  assert.equal(chunkMark(all.slice(2, 4), RESEND_ALL), 10);
  assert.equal(chunkMark(all.slice(4), RESEND_ALL), 30);
  assert.equal(chunkMark([{ id: 4, MajLe: 20 }], 15), 20);
});

test('liste des clés : seaux, morceau de liste complète, ancienne liste d\'un seul tenant', () => {
  assert.deepEqual(parseList('ids:a b  c'), { full: ['a', 'b', 'c'] });
  for (const bad of ['', null, '{}', 'x', '{"seaux": {"3": ["a"]}}', '{"t": 5, "seaux": {"300": ["a"], "x": []}}']) assert.equal(parseList(bad), null);
  assert.deepEqual(parseList('{"t": 5, "seaux": {"3": ["a", "", 3], "7": []}}'), { buckets: { t: 5, keys: new Map([[3, new Set(['a', '3'])], [7, new Set()]]) } });
  assert.equal(listRequest('abcd1234', 2, 'k9'), '{"marque":"abcd1234","n":2,"apres":"k9"}');
  const part = { liste: { marque: 'abcd1234', n: 2, t: 7, cles: ['a'], fin: true } };
  assert.deepEqual(parseList(JSON.stringify({ t: 6, seaux: { 1: ['z'] }, ...part })),
    { buckets: { t: 6, keys: new Map([[1, new Set(['z'])]]) }, part: { mark: 'abcd1234', n: 2, t: 7, keys: ['a'], last: true } });
  assert.equal(parseList(JSON.stringify({ liste: { ...part.liste, n: 0 } })), null, 'morceau mal formé');
  const track = { Synchro_Type: 'suivi', Sync_Etat: '{"t": 1, "top": 4, "s": [], "trop": "1.5"}', Synchro_Renvoi: '' };
  assert.deepEqual(trackState(track), { t: 1, top: 4, s: [], trop: '1.5' });
  assert.equal(listOverdue(track), true, 'trop de clés parties : liste complète à renvoyer');
  assert.equal(listOverdue({ ...track, Synchro_Renvoi: '1.5' }), false, 'renvoyée depuis');
  assert.deepEqual(trackState({ Synchro_Type: 'lot', Sync_Etat: 12 }), {});
  assert.equal(listOverdue({ Synchro_Type: 'suivi', Sync_Etat: 'illisible' }), false);
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
  const { actions, missing, resent } = planUnpack(rows, 'J');
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
  assert.deepEqual(planUnpack(rows.slice(0, 1), 'J'), { actions: [], missing: {}, big: {}, arrived: {}, resent: [] });
  const empty = raw(10, 'cles', { Synchro_Ids: '', Synchro_Colonnes: '' });
  assert.deepEqual(planUnpack([empty], 'J').actions, [['BulkRemoveRecord', 'J', [10]]], 'liste vide sans colonnes : rien à garder');
  assert.deepEqual(planUnpack([{ ...empty, Synchro_Ids: '{"t": 1, "moins": ["a"]}' }], 'J').actions[0][3].Synchro_Ids, ['{"t": 1, "moins": ["a"]}']);
  const cut = raw(7, 'lot', { Synchro_Lot: JSON.stringify({ lignes: [], total: 4 }) });
  const again = raw(8, 'lot', { Synchro_Renvoi: 'm:1', Synchro_Lot: JSON.stringify({ lignes: [], total: 1 }) });
  assert.deepEqual(planUnpack([cut, again], 'J').missing, { Contacts: 0 }, 'coupé puis renvoyé');
  assert.deepEqual(planUnpack([again, { ...cut, id: 9 }], 'J').missing, { Contacts: 4 }, 'renvoyé puis coupé');
});

test('CIBLE : lignes manquantes et lignes trop grosses suivies d\'un dépliage à l\'autre', () => {
  const unpack = { missing: { A: 2 }, big: { A: ['k1'], B: ['k2'] }, arrived: { A: ['k9'] }, resent: [] };
  let gaps = nextGaps({}, unpack);
  assert.deepEqual(gaps, { missing: { A: 2 }, big: { A: ['k1'], B: ['k2'] } });
  gaps = nextGaps(gaps, { missing: {}, big: {}, arrived: { B: ['k2'] }, resent: [] });
  assert.deepEqual(gaps.big, { A: ['k1'] }, 'une ligne arrivée n\'est plus signalée');
  assert.deepEqual(nextGaps(gaps, { missing: { A: 0 }, big: {}, arrived: {}, resent: ['A'] }), { missing: {}, big: {} }, 'un renvoi remet à zéro');
});

test('CIBLE : destination renommée suivie par ses numéros Grist', () => {
  const schemaOf = (tableId, cols) => ({
    tableIdOf: ref => (ref === 7 ? tableId : null),
    table: id => (id === tableId ? { id: 7, tableId } : undefined),
    columns: id => (id === tableId ? cols : null),
  });
  const before = schemaOf('Contacts', [{ id: 70, colId: 'Nom' }, { id: 71, colId: 'Ville' }, { id: 72, colId: 'Code' }]);
  const entry = { table: 'Contacts', dest: 'Contacts', columns: [{ id: 'Nom' }, { id: 'Ville' }], map: { Cp: 'Code' }, match: 'Code' };
  const noted = { ...entry, refs: destRefs(before, 'Contacts') };
  assert.deepEqual(noted.refs, { table: 7, cols: { Nom: 70, Ville: 71, Code: 72 } });
  assert.equal(followRenames(noted, before), noted, 'rien de renommé : même entrée');
  const after = schemaOf('Personnes', [{ id: 70, colId: 'Nom' }, { id: 71, colId: 'Commune' }, { id: 72, colId: 'CodePostal' }]);
  const next = followRenames(noted, after);
  assert.equal(next.dest, 'Personnes');
  assert.deepEqual(next.map, { Cp: 'CodePostal', Ville: 'Commune' });
  assert.equal(next.match, 'CodePostal');
  assert.equal(followRenames({ ...entry, refs: { table: 9, cols: {} } }, before).dest, 'Contacts', 'table disparue : son nom noté');
  assert.equal(destRefs(before, 'Absente'), undefined);
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

test('préparation de la SOURCE : colonnes manquantes et clés des lignes existantes', () => {
  assert.deepEqual(prepareSourceActions('T', ['MajLe']), [
    ['AddColumn', 'T', 'MajLe', { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 2 }],
  ]);
  let n = 0;
  const actions = fillKeyActions('T', [{ id: 1, id_sync: '' }, { id: 2, id_sync: 'x' }, { id: 3 }], () => `u${++n}`);
  assert.deepEqual(actions, [['BulkUpdateRecord', 'T', [1, 3], { id_sync: ['u1', 'u2'] }]]);
});

test('invitation : aller-retour, plusieurs tables, refus des codes invalides', () => {
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom' }, { id: 'Ville', type: 'Text', label: 'Ville é' }, { id: 'Vu', type: 'DateTime:Europe/Paris', label: 'Vu' }];
  const id = '0123456789abcdef';
  const exportId = 'fedcba9876543210';
  const code = buildInvitation({ id, exportId, name: 'Annuaire', secret: SECRET, origin: 'https://g.fr', tables: [{ table: 'Contacts', columns }, { table: 'Villes', columns }] });
  assert.ok(code.startsWith('GRISTSYNC2.'));
  const inv = parseInvitation(code);
  assert.equal(inv.export, exportId);
  assert.deepEqual(inv.tables.map(tb => tb.table), ['Contacts', 'Villes']);
  assert.deepEqual(inv.tables[0].columns[1], { id: 'Ville', type: 'Text', label: 'Ville é' });
  assert.equal(inv.tables[0].columns[2].type, 'DateTime:Europe/Paris', 'une date à fuseau passe');
  assert.equal(parseInvitation(buildInvitation({ id, exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })).secret, '');
  assert.throws(() => parseInvitation(buildInvitation({ id, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })), /codeInvalid/, 'sans export');
  assert.throws(() => parseInvitation('bonjour'), /codeFormat/);
  assert.throws(() => parseInvitation('GRISTSYNC1.eyJ9'), /codeOld/);
  assert.throws(() => decodeCode(code, 'reponse'), /notReply/);
  const bad = buildInvitation({ id, exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns: [{ id: 'a;b', type: 'Text' }] }] });
  assert.throws(() => parseInvitation(bad), /codeInvalid/);
  const twice = buildInvitation({ id, exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }, { table: 'Contacts', columns }] });
  assert.throws(() => parseInvitation(twice), /codeInvalid/);
});

test('réponse : même instance, une adresse par clé de formulaire seulement', () => {
  const url = 'https://g.fr/o/eq/api/s/Abc123/tables/Journal_Annuaire/records?flat=1';
  const id = '0123456789abcdef';
  const recipient = { email: 'a@b.fr', docId: 'doc1', docName: 'Annuaire', team: 'eq', at: '2026-10-14', extra: 'x' };
  const reply = parseReply(buildReply({ id, secret: SECRET, recipient, url }), 'https://g.fr');
  assert.equal(reply.url, url);
  assert.equal(docLabel(reply.recipient.docName, reply.recipient.docId), 'Annuaire (doc1)', 'le document par son nom et son identifiant');
  assert.equal(docLabel('', 'doc1'), 'doc1');
  assert.equal(reply.secret, SECRET);
  assert.equal(reply.recipient.extra, undefined);
  assert.equal(parseReply(buildReply({ id, recipient, url }), 'https://g.fr').secret, '');
  assert.throws(() => parseReply(buildReply({ id, secret: 'court', recipient, url }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(buildReply({ id, recipient, url }), 'https://autre.fr'), /otherInstance/);
  assert.throws(() => parseReply(buildReply({ id, recipient, url: url.replace('?flat=1', '') }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(buildReply({ id, recipient, url: 'https://g.fr/api/docs/doc1/tables/T/records?flat=1' }), 'https://g.fr'), /codeInvalid/);
});

test('adresses : lien de formulaire, webhook, masque, baseUrl', () => {
  const link = 'https://grist.numerique.gouv.fr/o/mon-equipe/forms/Ab12Cd34Ef56/2';
  assert.deepEqual(parseFormLink(link), { origin: 'https://grist.numerique.gouv.fr', prefix: '/o/mon-equipe', key: 'Ab12Cd34Ef56' });
  assert.equal(buildWebhookUrl(link, 'Journal'), 'https://grist.numerique.gouv.fr/o/mon-equipe/api/s/Ab12Cd34Ef56/tables/Journal/records?flat=1');
  assert.equal(buildWebhookUrl('https://x.fr/forms/K1/3', 'J'), 'https://x.fr/api/s/K1/tables/J/records?flat=1');
  assert.equal(parseFormLink('https://x.fr/doc/abc'), null);
  assert.equal(parseFormLink('javascript:alert(1)//forms/a/1'), null);
  assert.equal(parseWebhookUrl('https://u:p@x.fr/api/s/K/tables/J/records?flat=1'), null);
  assert.equal(maskKey('https://x.fr/api/s/Ab12Cd34Ef56/tables/J/records?flat=1'), 'https://x.fr/api/s/Ab12…/tables/J/records?flat=1');
  assert.deepEqual(parseDocBaseUrl('https://x.fr/o/eq/api/docs/d1'), { origin: 'https://x.fr', team: 'eq', docId: 'd1' });
  assert.deepEqual(parseDocBaseUrl('http://localhost:8484/api/docs/d2'), { origin: 'http://localhost:8484', team: '', docId: 'd2' });
});

test('lien public : règles d\'accès du widget, avant les règles existantes, retirables', () => {
  const E = '0123456789abcdef';
  const F = 'fedcba9876543210';
  assert.deepEqual(publicAclRules([F, E, 'pas un export']), [
    { tableId: 'Synchro', permissionsText: '+R', aclFormula: `user.Access == VIEWER and rec.Synchro_Export in ["${E}", "${F}"] and rec.Synchro_Type == "complet"` },
    { tableId: '*', aclFormula: 'user.Access == VIEWER', permissionsText: '-R' },
  ]);
  assert.deepEqual(publicAclRules([]), []);
  assert.deepEqual(publicAclRules([], { keepDeny: true }).map(r => r.tableId), ['*']);
  const resources = [{ id: 1, tableId: '*', colIds: '*' }];
  const rules = [{ id: 5, resource: 1, rulePos: 1, memo: '' }, { id: 6, resource: 1, rulePos: -1, memo: 'Synchro : lecture limitée aux vues d’export' }];
  const actions = publicAclActions(resources, rules, [E]);
  assert.deepEqual(actions[0], ['BulkRemoveRecord', '_grist_ACLRules', [6]], 'règle d\'une version précédente retirée');
  assert.deepEqual(actions.filter(a => a[1] === '_grist_ACLResources').map(a => a[3].tableId), ['Synchro']);
  const added = actions.filter(a => a[1] === '_grist_ACLRules' && a[0] === 'AddRecord');
  assert.deepEqual(added.map(a => [a[3].resource, a[3].permissionsText]), [[-1, '+R'], [1, '-R']]);
  assert.ok(added.every(a => a[3].rulePos < -1 && a[3].memo === 'Synchro : lecture limitée aux exports publics'));
  assert.deepEqual(publicAclActions(resources, rules, []), [['BulkRemoveRecord', '_grist_ACLRules', [6]]]);
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
  assert.deepEqual(planPull({ records: [full(both)], journalRows, journalTable: 'J' }), [
    ['BulkAddRecord', 'J', [null], { Synchro_Table: ['Contacts'], id_sync: ['b'], MajLe: [20], Supprime: [false], Synchro_Donnees: ['{"Nom":"B2"}'] }],
  ]);
  const gone = planPull({ records: [full(both.slice(0, 1))], journalRows, journalTable: 'J' });
  assert.deepEqual(gone, [['AddRecord', 'J', null, { Synchro_Table: 'Contacts', Synchro_Ids: 'ids:a', Synchro_Colonnes: schema }]]);
  const other = { id: 2, fields: { ...full(both).fields, Synchro_Type: 'lot' } };
  assert.deepEqual(planPull({ records: [other], journalRows, journalTable: 'J' }), [], 'seules les lignes « complet » comptent');
});

test('invitation par lien public : adresse du document réécrite, sinon refusée', () => {
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom' }];
  const id = '0123456789abcdef';
  const exportId = id;
  const code = buildInvitation({ id, exportId, name: 'x', origin: 'https://g.fr', base: 'https://g.fr/o/eq/api/docs/abcDEF12', tables: [{ table: 'Contacts', columns }] });
  const inv = parseInvitation(code);
  assert.equal(inv.mode, 'public');
  assert.equal(inv.base, 'https://g.fr/o/eq/api/docs/abcDEF12');
  const bad = buildInvitation({ id, exportId, name: 'x', origin: '', base: 'https://g.fr/api/docs/abc?x=1', tables: [{ table: 'Contacts', columns }] });
  assert.throws(() => parseInvitation(bad), /codeInvalid/);
  assert.equal(parseInvitation(buildInvitation({ id, exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })).mode, 'reponse');
});

test('boucles : retour vers le document d’origine refusé, relais et copie dans le même document permis', () => {
  const received = [{ dest: 'Contacts', fromDocId: 'docX' }];
  assert.deepEqual(loopingTables(['Contacts', 'Villes'], 'docX', received), ['Contacts'], 'retour vers X');
  assert.deepEqual(loopingTables(['Contacts', 'Villes'], 'docZ', received), [], 'relais vers Z');
  assert.deepEqual(loopingTables(['Contacts', 'Villes'], 'docY', []), [], 'copie dans le même document : une destination neuve');
  assert.deepEqual(loopingTables(['Contacts'], '', received), [], 'document inconnu');
});
