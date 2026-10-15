// Cas limites de la logique pure : codes abîmés ou forgés, noms en conflit, valeurs inattendues.
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND, buildInvitation, buildReply, compareVersion, conditionExport, crc32, decodeCode, deleteColumnAction, exchangeMap, exchangeTables,
  expandRows, freeTableId, hooksOf, isPublicRule, isRaw, keyTriggerAction, maskKey, missingSyncColumns, newColumnsMap, parseFormLink,
  parseInvitation, parseList, parseLot, parseReply, parseWebhookUrl, planConsolidation, planPurge, planUnpack, recentChanges, rowFilter,
  toRows, toTableId,
} from '../../js/core.js';

const ID = '0123456789abcdef';
const EXPORT = 'fedcba9876543210';
const SECRET = '0123456789abcdef0123456789abcdef';
const COLUMNS = [{ id: 'Nom', type: 'Text', label: 'Nom' }];
const invitation = (fields = {}) => buildInvitation({ id: ID, exportId: EXPORT, name: 'Annuaire', origin: 'https://g.fr', tables: [{ table: 'Contacts', columns: COLUMNS }], ...fields });
// Code forgé à la main : préfixe et JSON en base64url, sans passer par buildInvitation.
const forge = payload => `GRISTSYNC2.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;

test('noms : identifiants Grist, conflits sans tenir compte des majuscules', () => {
  assert.equal(toTableId('Été 2026 / RH'), 'Ete_2026_RH');
  assert.equal(toTableId('___'), 'Table');
  assert.equal(toTableId(null, 'Export'), 'Export');
  assert.equal(toTableId('éà'), 'Ea');
  assert.equal(freeTableId('Journal_ANNUAIRE', ['Journal_Annuaire']), 'Journal_ANNUAIRE_2', 'Grist confondrait les deux');
  assert.equal(freeTableId('Note', ['note', 'NOTE_2']), 'Note_3');
  assert.deepEqual(newColumnsMap({ columns: [] }, [{ id: 'nom' }], ['Nom']), { nom: 'nom_2' }, 'une colonne nouvelle ne prend pas la place d\'une autre');
});

test('toRows : colonnes manquantes ou absentes', () => {
  assert.deepEqual(toRows({}), []);
  assert.deepEqual(toRows({ id: [] }), []);
  assert.deepEqual(toRows({ id: [1], A: [] }), [{ id: 1, A: undefined }]);
});

test('codes : coupés en plusieurs lignes (courriel), ou abîmés', () => {
  const code = invitation();
  const wrapped = `  ${code.slice(0, 30)}\n${code.slice(30, 70)}\r\n ${code.slice(70)}  `;
  assert.equal(parseInvitation(wrapped).export, EXPORT, 'les blancs sont ôtés');
  assert.throws(() => parseInvitation(code.slice(0, -10)), /codeFormat|codeInvalid/, 'code tronqué');
  assert.throws(() => parseInvitation('GRISTSYNC2.!!!'), /codeFormat/);
  assert.throws(() => parseInvitation('GRISTSYNC2.'), /codeFormat/);
  assert.throws(() => parseInvitation(''), /codeFormat/);
  assert.throws(() => parseInvitation(undefined), /codeFormat/);
  assert.throws(() => decodeCode(forge(null), 'invitation'), /codeFormat/);
  assert.throws(() => decodeCode(forge([1, 2]), 'invitation'), /notInvitation/);
  assert.throws(() => decodeCode(forge('texte'), 'reponse'), /notReply/);
});

test('invitation forgée : chaque champ est contrôlé', () => {
  const base = { kind: 'invitation', id: ID, export: EXPORT, name: 'A', origin: 'https://g.fr', tables: [{ table: 'Contacts', columns: COLUMNS }] };
  assert.equal(parseInvitation(forge(base)).mode, 'reponse');
  const refused = {
    'identifiant court': { id: 'abc' },
    'identifiant dans un tableau': { id: [ID] },
    'table dans un tableau': { tables: [{ table: ['Contacts'], columns: COLUMNS }] },
    'colonne sans identifiant': { tables: [{ table: 'Contacts', columns: [{ type: 'Text' }] }] },
    'export en majuscules': { export: EXPORT.toUpperCase() },
    'nom qui n\'est pas un texte': { name: 42 },
    'secret mal formé': { secret: 'zz' },
    'aucune table': { tables: [] },
    'tables absentes': { tables: null },
    'table au nom invalide': { tables: [{ table: 'Contacts; drop', columns: COLUMNS }] },
    'table sans colonne': { tables: [{ table: 'Contacts', columns: [] }] },
    'colonne en double': { tables: [{ table: 'Contacts', columns: [...COLUMNS, ...COLUMNS] }] },
    'type de colonne étrange': { tables: [{ table: 'Contacts', columns: [{ id: 'Nom', type: 'Text"); import os' }] }] },
    'nom dans l\'autre document invalide': { tables: [{ table: 'Contacts', columns: [{ id: 'Nom', type: 'Text', as: 'a b' }] }] },
    'lien public vers une adresse quelconque': { mode: 'public', base: 'https://g.fr/forms/x' },
    'lien public avec identifiants': { mode: 'public', base: 'https://u:p@g.fr/api/docs/abc' },
    'Échange sans adresse de retour': { mode: 'echange' },
    'Échange vers une adresse de lecture': { mode: 'echange', retour: 'https://g.fr/api/docs/abc/tables/T/records' },
    'Échange vers une adresse sans ?flat=1': { mode: 'echange', retour: 'https://g.fr/api/s/Key1/tables/Journal_A/records' },
  };
  for (const [why, change] of Object.entries(refused)) assert.throws(() => parseInvitation(forge({ ...base, ...change })), /codeInvalid/, why);
  const long = parseInvitation(forge({ ...base, name: 'x'.repeat(500), from: { email: 7, docId: { a: 1 }, extra: 'x' } }));
  assert.equal(long.name.length, 200, 'nom borné');
  assert.deepEqual(long.from, { email: '7', docId: '[object Object]' }, 'fiche : textes seulement, champs connus seulement');
  const exchange = parseInvitation(forge({ ...base, mode: 'echange', retour: 'http://localhost:8484/o/t/api/s/K1/tables/Journal_A/records?flat=1' }));
  assert.equal(exchange.retourOrigin, 'http://localhost:8484', 'l\'instance de retour est dite, la CIBLE la compare à la sienne');
});

test('réponse forgée : adresse, secret et tables de l\'Échange contrôlés', () => {
  const url = 'https://g.fr/api/s/Key1/tables/Journal_A/records?flat=1';
  const reply = fields => buildReply({ id: ID, secret: SECRET, recipient: { email: 'a@b.fr' }, url, ...fields });
  assert.equal(parseReply(`\n${reply()}\n`, 'https://g.fr').url, url);
  assert.throws(() => parseReply(reply({ recipient: null }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(reply({ url: `${url}&x=1` }), 'https://g.fr'), /codeInvalid/, 'paramètre de plus');
  assert.throws(() => parseReply(reply({ url: url.replace('https://', 'https://u:p@') }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(reply({ url: 'ftp://g.fr/api/s/Key1/tables/J/records?flat=1' }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(reply({ url: 'https://g.fr/api/s/Key1/tables/J/records/1?flat=1' }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(reply({ url: 'https://g.fr.evil.fr/api/s/Key1/tables/J/records?flat=1' }), 'https://g.fr'), /otherInstance/);
  const retour = [{ table: 'Contacts', dest: 'Fiches' }];
  assert.deepEqual(parseReply(reply({ retour }), 'https://g.fr').retour, retour);
  assert.throws(() => parseReply(reply({ id: [ID] }), 'https://g.fr'), /codeInvalid/);
  for (const bad of [[], [{ table: 'Contacts' }], [{ table: ['Contacts'], dest: 'Fiches' }], [{ table: 'A b', dest: 'C' }], [...retour, { table: 'Contacts', dest: 'Autre' }], [...retour, { table: 'Villes', dest: 'Fiches' }], 'Contacts']) {
    assert.throws(() => parseReply(reply({ retour: bad }), 'https://g.fr'), /codeInvalid/, JSON.stringify(bad));
  }
});

test('adresses : lien de formulaire copié avec des blancs ou des paramètres, clé masquée', () => {
  assert.deepEqual(parseFormLink('  https://g.fr/forms/Ab12/3/  '), { origin: 'https://g.fr', prefix: '', key: 'Ab12' });
  assert.equal(parseFormLink('https://g.fr/forms/Ab12/3?embed=1').key, 'Ab12');
  assert.equal(parseFormLink('https://g.fr/forms/Ab-12/3'), null, 'clé au format inattendu');
  assert.equal(parseFormLink('https://g.fr/o/eq/forms/Ab12'), null, 'sans numéro de formulaire');
  assert.equal(parseFormLink('file:///forms/Ab12/3'), null);
  assert.equal(parseFormLink(null), null);
  assert.equal(parseWebhookUrl('https://g.fr/api/s/K/tables/1Table/records?flat=1'), null, 'table au nom invalide');
  assert.equal(parseWebhookUrl('https://g.fr/api/s/K/tables/T/records').flat, false);
  assert.equal(maskKey('https://g.fr/api/s/Ab/tables/T/records'), 'https://g.fr/api/s/Ab/tables/T/records', 'clé courte : rien à cacher de plus');
  assert.equal(maskKey(undefined), '');
});

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
  const lot = parseLot(JSON.stringify({ lignes: [['k', 1, 'oui', { A: 1 }], ['', 2, false, {}], ['j', 3, false, null], 'x', [5, null, 0, []]], total: 'trois' }));
  assert.deepEqual(lot.lines.map(l => [l.key, l.deleted]), [['k', true], ['5', false]], 'clé vide ou bloc absent écartés');
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

test('consolidation : clés en double dans la destination, version supprimée d\'une clé inconnue', () => {
  const journalRows = [
    { id: 1, id_sync: 'a', MajLe: 5, Supprime: false, Nom: 'A2' },
    { id: 2, id_sync: 'z', MajLe: 5, Supprime: true, Nom: 'Z' },
  ];
  const destRows = [{ id: 10, id_sync: 'a', Nom: 'A' }, { id: 11, id_sync: 'a', Nom: 'A' }];
  const { actions, stats } = planConsolidation({ journalRows, destRows, copyCols: [['Nom', 'Nom']], destTable: 'D', journalTable: 'J' });
  assert.deepEqual(stats, { added: 0, updated: 1, removed: 0 });
  assert.deepEqual(actions[0], ['BulkAddOrUpdateRecord', 'D', { id_sync: ['a'] }, { Nom: ['A2'] }, { on_many: 'all' }], 'les deux lignes de la clé suivent');
  assert.deepEqual(actions[1][3].Sync_Etat, ['modif', ''], 'suppression d\'une clé jamais reçue : sans effet');
});

test('Échange : suppression plus ancienne que la ligne d\'ici sans effet, plus récente appliquée', () => {
  const destRows = [{ id: 10, id_sync: 'a', MajLe: 50, Nom: 'A' }];
  const run = order => planConsolidation({
    journalRows: [{ id: 1, id_sync: 'a', MajLe: order, Supprime: true, Nom: 'A' }], destRows, copyCols: [['Nom', 'Nom']], destTable: 'D', journalTable: 'J', exchange: true,
  });
  assert.deepEqual(run(40).stats, { added: 0, updated: 0, removed: 0 });
  assert.deepEqual(run(60).stats, { added: 0, updated: 0, removed: 1 });
  const fresh = planConsolidation({ journalRows: [{ id: 1, id_sync: 'b', MajLe: null, Supprime: false, Nom: 'B' }], destRows, copyCols: [['Nom', 'Nom']], destTable: 'D', journalTable: 'J', exchange: true });
  assert.deepEqual(fresh.actions[0][3], { Nom: ['B'], MajLe: [null] }, 'ligne nouvelle sans date : ajoutée');
});

test('purge : journal vide, tables refusées effacées', () => {
  assert.deepEqual(planPurge([], 'J'), []);
  const rows = [{ id: 1, Synchro_Table: 'Villes', id_sync: 'v', MajLe: 1 }, { id: 2, Synchro_Table: 'Contacts', id_sync: 'c', MajLe: 1 }, { id: 3, Synchro_Table: 'Villes', id_sync: 'v', MajLe: 2 }];
  assert.deepEqual(planPurge(rows, 'J', { drop: ['Villes'] }), [['BulkRemoveRecord', 'J', [1]]], 'la ligne la plus récente reste (numéro non réutilisé)');
});

test('historique : dates illisibles écartées', () => {
  const rows = [{ id: 1, id_sync: 'a', MajLe: 'hier', Sync_Etat: 'ajout' }, { id: 2, id_sync: 'b', MajLe: 5, Sync_Etat: 'modif', Sync_Recu: 9, Nom: null }];
  assert.deepEqual(recentChanges(rows, 'Nom', 0, 10), [{ at: 9, label: '', state: 'modif' }]);
});

test('filtre de lignes : formes acceptées', () => {
  assert.equal(rowFilter(null), null);
  assert.equal(rowFilter({ id: 'a b', value: 'x' }), null);
  assert.deepEqual(rowFilter({ id: 'Actif', source: 'Bool', value: ' Oui ' }), { id: 'Actif', source: 'Bool', visible: '', value: 'oui' });
  assert.deepEqual(rowFilter({ id: 'Actif', source: 'Bool', value: 'peut-être' }).value, 'non');
  assert.equal(rowFilter({ id: 'Ville', value: '  LYON ' }).value, 'lyon');
  assert.equal(rowFilter({ id: 'N', value: 0 }).value, '0');
});

test('condition d\'un webhook : rien d\'autre que la forme exacte', () => {
  const ok = `rec.Synchro_Export == "${EXPORT}" and rec.Synchro_Type in ("cles", "lot")`;
  assert.equal(conditionExport(ok), EXPORT);
  assert.equal(conditionExport(` ${ok}`), '');
  assert.equal(conditionExport(ok.replace('"lot")', '"lot", "complet")')), '');
  assert.equal(conditionExport(ok.replace(EXPORT, `${EXPORT}" or "1`)), '');
  assert.equal(conditionExport(null), '');
  const hooks = [{ id: 'h1', fields: { tableId: 'Synchro' } }, { id: 'h2', fields: { tableId: 'Contacts' } }, { id: 'h3', fields: { tableId: 'Synchro' } }];
  const conditions = new Map([['h1', ok], ['h2', ok], ['h3', '']]);
  assert.deepEqual(hooksOf(hooks, conditions, EXPORT).map(h => h.id), ['h1'], 'webhook d\'une autre table ou sans filtre : pas un destinataire');
  assert.ok(isPublicRule({ memo: 'Synchro : lecture limitée aux exports publics' }) && !isPublicRule({ memo: '' }));
});

test('Échange : colonnes renvoyées sous leur nom d\'origine, correspondance déduite', () => {
  const entries = [{ table: 'Contacts', dest: 'Fiches', columns: [{ id: 'Nom' }, { id: 'Ville' }], map: { Ville: 'Commune' } }, { table: 'Vide', dest: 'Rien', columns: [{ id: 'X' }] }];
  const columnsOf = dest => (dest === 'Fiches' ? [{ id: 'Nom', type: 'Text' }, { id: 'Commune', type: 'Text' }, { id: 'Note', type: 'Text' }, { id: 'Photo', blocked: true }] : []);
  assert.deepEqual(exchangeTables(entries, columnsOf), [{ table: 'Fiches', filter: null, columns: [{ id: 'Nom', type: 'Text', as: 'Nom' }, { id: 'Commune', type: 'Text', as: 'Ville' }] }],
    'seules les colonnes reçues repartent ; une destination sans colonne ne part pas');
  assert.deepEqual(exchangeMap([{ id: 'Commune', as: 'Ville' }, { id: 'Nom' }]), { Commune: 'Ville' });
  assert.deepEqual(exchangeMap([{ id: 'Commune', as: 'Ville' }], { Commune: 'Lieu' }), { Commune: 'Lieu' }, 'un choix fait à la main l\'emporte');
});

test('colonnes de la synchro : clé posée à la création, case Supprime', () => {
  assert.deepEqual(missingSyncColumns([{ colId: 'id_sync' }]), ['MajLe', 'RecalculLe']);
  assert.deepEqual(keyTriggerAction('T', [{ colId: 'id_sync', isFormula: false, formula: '' }]), ['ModifyColumn', 'T', 'id_sync', { formula: 'UUID()', recalcWhen: 0 }]);
  assert.equal(keyTriggerAction('T', [{ colId: 'id_sync', isFormula: false, formula: 'UUID()' }]), null, 'déjà posée');
  assert.equal(keyTriggerAction('T', [{ colId: 'id_sync', isFormula: true, formula: '$x' }]), null, 'une formule de la personne n\'est pas touchée');
  assert.equal(keyTriggerAction('T', []), null);
  assert.deepEqual(deleteColumnAction('T', []), ['AddColumn', 'T', 'Supprime', { type: 'Bool', isFormula: false }]);
  assert.equal(deleteColumnAction('T', [{ colId: 'Supprime' }]), null);
});

test('CRC-32 : texte accentué lu en UTF-8, comme zlib.crc32(texte.encode()) en Python', () => {
  assert.equal(crc32(''), 0);
  assert.equal(crc32('é'), 235179326);
});
