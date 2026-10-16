// Formules de la table Synchro et colonnes de synchro des tables envoyées (SOURCE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteColumnAction, fillKeyActions, keyTriggerAction, majleAction, missingSyncColumns, prepareSourceActions, syncColumns, syncFormulas } from '../../js/logic/formulas.js';

test('table Synchro : ses colonnes, et des formules qui nomment les tables des exports', () => {
  assert.deepEqual(syncColumns([]).map(c => c.id),
    ['Synchro_Export', 'Synchro_Table', 'Synchro_Type', 'Synchro_Colonnes', 'Synchro_Renvoi', 'Synchro_Ids', 'Synchro_Lot', 'Sync_Etat', 'Sync_Par']);
  const { keys, lot, state } = syncFormulas(['Villes', 'Contacts', 'Villes', 'mauvais nom']);
  assert.match(keys, /^if \$Synchro_Type == "empreinte":\n  import zlib\n  c = Synchro\.lookupOne\(Synchro_Export=\$Synchro_Export, Synchro_Table=\$Synchro_Table, Synchro_Type="complet"\)\.Synchro_Lot or ""\n  return "%d:%08x" % \(len\(c\), zlib\.crc32\(c\.encode\(\)\)\)\n/,
    'empreinte de l\'instantané public : la CIBLE ne le relit que s\'il change');
  assert.match(keys, /\nif \$Synchro_Type not in \("cles", "suivi"\): return ""\n.*\ntables = \{"Contacts": Contacts, "Villes": Villes\}\nsrc = tables\.get\(\$Synchro_Table\)/);
  assert.match(keys, /\nif \$Synchro_Type == "cles" and Synchro\.lookupOne\(Synchro_Export=\$Synchro_Export, Synchro_Type="echange"\)\.id: return ""\n/,
    'Échange : la liste des clés ne part pas');
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
  assert.match(lot, /  if not capped and size > 2000000: return json\.dumps\(\{"lignes": \[\], "total": len\(rows\), "trop": True\}\)/, 'instantané public plafonné');
  assert.match(lot, /  touched = \[r for r in rows if \(v\(getattr\(r, "RecalculLe", None\)\) or 0\) > v\(cut\)\]\n/,
    'seule RecalculLe (un nombre) est lue sur toutes les lignes, MajLe sur les lignes recalculées');
  assert.match(lot, /  recent = set\(r\.id for r in touched if r\.MajLe and r\.MajLe >= cut and not \(mute and echo\(r\)\)\)/,
    'une ligne reçue par l\'Échange ne repart pas vers l\'autre document, même dans les 5 secondes');
  assert.match(lot, /  mute = swap\.id and swap\.Synchro_Colonnes != "plusieurs"\n/,
    'Échange à plusieurs : ce qu\'envoie un participant repart vers les autres');
  assert.match(lot, /  fresh = set\(\) if mute else set\(r\.id for r in touched if r\.id not in recent and echo\(r\)\)/,
    'une ligne reçue par l\'Échange part vers les autres exports (relais), à l\'heure de sa version');
  assert.match(lot, /undone = set\(r\.id for r in touched if r\.id not in recent and r\.id not in fresh and not echo\(r\)\)/,
    'une ligne annulée (RecalculLe récent, MajLe ancienne) repart');
  assert.match(lot, /  stamps = \[x\.Sync_Etat for x in Synchro\.lookupRecords\(Synchro_Type="echange"\) if isinstance\(x\.Sync_Etat, \(int, float\)\)\]/,
    'heures des dernières consolidations d\'Échange');
  assert.match(lot, /    t, m = v\(getattr\(r, "RecalculLe"\)\) or 0, v\(r\.MajLe\) or 0\n    return any\(abs\(t - s\) < 1 and m < s for s in stamps\)/,
    'écho : ligne recalculée par la consolidation, MajLe plus ancienne qu\'elle');
  assert.match(lot, /  swap = Synchro\.lookupOne\(Synchro_Export=\$Synchro_Export, Synchro_Type="echange"\)\n/);
  assert.match(lot, /if len\(touched\) == len\(rows\) > \(0 if swap\.id else 20\): undone = set\(\)/, 'un rechargement du document n\'est pas une annulation');
  assert.match(lot, /def when\(r\): return v\(getattr\(r, "RecalculLe"\) if r\.id in undone else r\.MajLe\)/, 'une annulation part à son heure');
  assert.match(lot, /lot\.update\(depuis=v\(cut\), renvoi=bool\(again\)\)/, 'un lot coupé dit depuis quand');
  assert.match(lot, /v\(getattr\(r, "Supprime", False\)\)/, 'Supprime part telle quelle : « Non » ne supprime pas');
  assert.match(syncFormulas([]).keys, /tables = \{\}\nsrc = tables\.get/);
});

test('suivi des clés et envoi coupé : une colonne de déclenchement, nommée comme une colonne des journaux', () => {
  const { state } = syncFormulas(['Contacts']);
  const mark = syncColumns(['Contacts']).find(c => c.id === 'Sync_Etat');
  assert.deepEqual(mark, { id: 'Sync_Etat', type: 'Any', isFormula: false, formula: state, recalcWhen: 0 });
  assert.match(state, /^import json\nif \$Synchro_Type == "echange": return NOW\(\)\.timestamp\(\)\nif \$Synchro_Type == "lot":\n  lot = json\.loads\(\$Synchro_Lot or "\{\}"\)\n  if lot\.get\("depuis"\) and not lot\.get\("renvoi"\):\n/,
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

test('préparation de la SOURCE : colonnes manquantes et clés des lignes existantes', () => {
  assert.deepEqual(prepareSourceActions('T', ['MajLe']), [
    ['AddColumn', 'T', 'MajLe', { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 2 }],
  ]);
  let n = 0;
  const actions = fillKeyActions('T', [{ id: 1, id_sync: '' }, { id: 2, id_sync: 'x' }, { id: 3 }], () => `u${++n}`);
  assert.deepEqual(actions, [['BulkUpdateRecord', 'T', [1, 3], { id_sync: ['u1', 'u2'] }]]);
});

// Cas limites.

test('colonnes de la synchro : clé posée à la création, case Supprime', () => {
  assert.deepEqual(missingSyncColumns([{ colId: 'id_sync' }]), ['MajLe', 'RecalculLe']);
  assert.deepEqual(keyTriggerAction('T', [{ colId: 'id_sync', isFormula: false, formula: '' }]), ['ModifyColumn', 'T', 'id_sync', { formula: 'UUID()', recalcWhen: 0 }]);
  assert.equal(keyTriggerAction('T', [{ colId: 'id_sync', isFormula: false, formula: 'UUID()' }]), null, 'déjà posée');
  assert.equal(keyTriggerAction('T', [{ colId: 'id_sync', isFormula: true, formula: '$x' }]), null, 'une formule de la personne n\'est pas touchée');
  assert.equal(keyTriggerAction('T', []), null);
  assert.deepEqual(deleteColumnAction('T', []), ['AddColumn', 'T', 'Supprime', { type: 'Bool', isFormula: false }]);
  assert.equal(deleteColumnAction('T', [{ colId: 'Supprime' }]), null);
});
