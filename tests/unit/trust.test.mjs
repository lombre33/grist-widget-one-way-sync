// Ce qui prouve qui est à l'autre bout : document désigné par une clé de formulaire (réponse de
// Grist), code de contrôle, durée de vie d'une invitation, signature des envois.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INVITE_DAYS, checkSeals, checkSigned, controlCode, expiresAt, hmac, isExpired, isUnpacked, memoMatches, readShare, sameDoc, sealMark, sealRows, sealText, sealer, signText,
  signature,
} from '../../js/logic/trust.js';
import { planUnpack, unpackActions } from '../../js/logic/journal.js';

const FULL = 'hX3ab9Kq2LmZ7pRtVw8yNc';

test('fiche du document d\'une clé de formulaire : lue dans la réponse de Grist', () => {
  const answer = { id: FULL, name: 'Suivi RH', access: 'editors', workspace: { name: 'Service RH', org: { name: 'Mairie X', domain: 'mairie-x' } } };
  assert.deepEqual(readShare(answer), { docId: FULL, name: 'Suivi RH', folder: 'Service RH', team: 'mairie-x', teamName: 'Mairie X', personal: false });
  const personal = { id: FULL, name: 'Perso', workspace: { name: 'Home', org: { name: 'Personnel', domain: null, billingAccount: { individual: true } } } };
  assert.equal(readShare(personal).personal, true, 'espace personnel : son propriétaire n\'est pas vérifiable');
  assert.equal(readShare({ ...answer, workspace: { name: 'Home', org: { name: 'Personal', domain: 'docs-12' } } }).personal, true);
  assert.equal(readShare({ ...answer, workspace: undefined }).personal, true, 'sans équipe : rien de vérifiable');
  assert.equal(readShare({ ...answer, name: 'x'.repeat(500) }).name.length, 200);
  for (const bad of [null, 'texte', {}, { id: 'court' }, { id: `${FULL}"` }]) assert.equal(readShare(bad), null);
});

test('document désigné : identifiant court (au moins 12 caractères) ou complet ; mémo d\'un webhook', () => {
  assert.ok(sameDoc(FULL, FULL.slice(0, 12)) && sameDoc(FULL, FULL));
  assert.ok(!sameDoc(FULL, FULL.slice(0, 11)), 'trop court : n\'importe quel document commencerait ainsi');
  assert.ok(!sameDoc(FULL, 'hX3ab9Kq2LmY') && !sameDoc(FULL, undefined));
  assert.ok(memoMatches(`a@b.fr · ${FULL.slice(0, 12)} · mairie-x`, FULL));
  assert.ok(!memoMatches('a@b.fr · zzzzzzzzzzzz · mairie-x', FULL), 'autre document que celui approuvé');
  assert.ok(memoMatches('a@b.fr', FULL) && memoMatches('', FULL), 'un mémo sans document ne dit rien');
});

test('code de contrôle : six caractères lisibles, tirés de la clé de l\'adresse et du secret', async () => {
  const url = 'https://g.fr/api/s/abc/tables/Journal_A/records?flat=1';
  const code = await controlCode(url, 'secret');
  assert.match(code, /^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/, 'ni 0, 1, I, L ni O');
  assert.equal(await controlCode(url, 'secret'), code, 'le même des deux côtés');
  assert.notEqual(await controlCode(url.replace('abc', 'abd'), 'secret'), code, 'adresse remplacée : autre code');
  assert.notEqual(await controlCode(url, 'autre'), code);
  // Seule la clé, tirée par Grist, compte : changer l'équipe ou la table ne permet pas de chercher
  // une adresse à soi qui donne le même code.
  assert.equal(await controlCode('https://g.fr/o/equipe/api/s/abc/tables/Journal_B/records?flat=1', 'secret'), code);
  assert.notEqual(await controlCode('https://g.fr/o/equipe/api/s/abd/tables/Journal_A/records?flat=1', 'secret'), code);
});

test('invitation : valable 7 jours', () => {
  const at = 1760000000;
  assert.equal(INVITE_DAYS, 7);
  assert.equal(expiresAt(at), at + 7 * 86400);
  assert.ok(!isExpired(at, at + 7 * 86400) && isExpired(at, at + 7 * 86400 + 1));
  assert.ok(isExpired(undefined, 7 * 86400 + 1), 'sans date : expirée');
});

// Vecteur calculé par la formule de Synchro (Python : hmac.new(clé, message, sha256)).
const KEY = '0123456789abcdef0123456789abcdef';
const COLS = '[{"id": "Nom", "type": "Text"}]';
const SIGNED = '{"lignes": [["k1", 1760000000.5, false, {"Nom": "Élise"}]], "total": 1, "sig": "00aa7f6715718866efcfccdf325244bcd192f91e8d4776857bce39ba1c51f25e"}';
const row = (fields = {}) => ({ id: 1, Synchro_Export: '00112233aabbccdd', Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Colonnes: COLS, Synchro_Lot: SIGNED, ...fields });

test('signature : la même en Python (formule) et ici, sur l\'export, la table, le type, les colonnes et le texte', async () => {
  assert.equal(await signature(row(), KEY), 'ok');
  assert.equal(await signature(row(), KEY.replace('0', '1')), 'bad', 'autre clé');
  for (const changed of [{ Synchro_Export: 'ffffffffffffffff' }, { Synchro_Table: 'Villes' }, { Synchro_Colonnes: '[]' },
    { Synchro_Lot: SIGNED.replace('Élise', 'Elise') }, { Synchro_Lot: SIGNED.replace(', "sig"', ',"sig"') }]) {
    assert.equal(await signature(row(changed), KEY), 'bad', JSON.stringify(changed));
  }
  assert.equal(await signature(row({ Synchro_Lot: '{"lignes": [], "total": 0}' }), KEY), 'bad', 'non signé');
  assert.equal(await signature(row({ Synchro_Lot: '' }), KEY), 'bad', 'lot vide');
  const body = SIGNED.replace(/, "sig": "[0-9a-f]{64}"\}$/, '}');
  assert.equal(await signText(KEY, row(), body), SIGNED, 'le widget signe comme la formule');
  assert.match(await hmac(KEY, 'x'), /^[0-9a-f]{64}$/);
});

test('signature : liste des clés, avis de fin, types non signés', async () => {
  const keys = row({ Synchro_Type: 'cles', Synchro_Lot: '', Synchro_Ids: '' });
  assert.equal(await signature(keys, KEY), 'bare', 'liste vide : rien à prouver, mais ses colonnes ne sont pas lues');
  const list = '{"t": 1760000000.0, "seaux": {"3": ["a"]}}';
  const signedList = await signText(KEY, keys, list);
  assert.equal(await signature({ ...keys, Synchro_Ids: signedList }, KEY), 'ok');
  assert.equal(await signature({ ...keys, Synchro_Ids: list }, KEY), 'bad');
  const end = { id: 3, Synchro_Export: '00112233aabbccdd', Synchro_Type: 'fin' };
  assert.equal(await signature({ ...end, Synchro_Lot: await signText(KEY, end, '{"fin": true}') }, KEY), 'ok');
  assert.equal(await signature(end, KEY), 'bad', 'avis de fin non signé : un lien volé ne coupe pas la réception');
  assert.equal(await signature({ id: 4, Synchro_Type: 'morceau', Synchro_Lot: 'x' }, KEY), 'ok', 'morceau de fichier : protégé par son empreinte');
  const rows = [row(), { ...row(), id: 2, Synchro_Lot: '{"lignes": [], "total": 0}' }, { ...keys, id: 5 }, { ...row(), id: 6, Synchro_Export: 'ffffffffffffffff', Synchro_Lot: 'x' }];
  const { bad, bare } = await checkSigned(rows, KEY, '00112233aabbccdd');
  assert.deepEqual([...bad], [2]);
  assert.deepEqual([...bare], [5]);
});

test('sceau des lignes dépliées : une ligne d\'une table sans sceau valide est écartée, quelle que soit sa forme', async () => {
  const E = '0123456789abcdef';
  const seal = await sealer('k'.repeat(32));
  assert.match(await sealMark(seal), /^[0-9a-f]{8}$/);
  assert.notEqual(await sealMark(seal), await sealMark(await sealer('j'.repeat(32))), 'empreinte propre à la clé');
  // Un lot reçu, déplié puis scellé : les lignes écrites gardent leur sceau.
  const lot = JSON.stringify({ lignes: [['k1', 100, false, { Nom: 'A' }], ['k2', 101, true, {}]], total: 2 });
  const plan = planUnpack([{ id: 1, Synchro_Export: E, Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Lot: lot, Synchro_Colonnes: '[]', Sync_Recu: 99 }], 'J', { exportId: E });
  const added = await sealRows(plan.added, E, seal);
  const [add] = unpackActions('J', added, plan.removed);
  assert.equal(add[3].Sync_Sceau.length, 2);
  // Relues comme Grist les rend (numéros, valeurs vides normalisées), avec les marques que la
  // recopie pose ensuite (une suppression vue dans une liste récrit l'heure d'arrivée).
  const stored = added.map((r, i) => ({ id: 10 + i, Synchro_Type: '', Synchro_Ids: '', Synchro_Donnees: '', ...r,
    Sync_Applique: true, Sync_Etat: i ? 'suppression' : 'ajout', Sync_Avant: '{"n":4}', ...(i ? { Sync_Recu: 500 } : {}) }));
  const probe = { id: 20, Synchro_Type: '', Synchro_Table: '', id_sync: '', Sync_Par: 'test' };
  const raw = { id: 21, Synchro_Type: 'lot', Synchro_Table: 'Contacts', Synchro_Lot: lot };
  const forged = [
    { id: 30, Synchro_Type: '', Synchro_Table: 'Contacts', id_sync: 'x1', MajLe: 1e10, Synchro_Donnees: '{"Nom":"Faux"}' },
    { id: 31, Synchro_Type: '', Synchro_Table: 'Contacts', Synchro_Ids: '{"seaux":{"17":[]},"t":1}' },
    { ...stored[0], id: 32, Synchro_Donnees: '{"Nom":"Autre"}' },
    { ...stored[1], id: 33, Sync_Sceau: await seal(sealText('fedcba9876543210', stored[1])) },
  ];
  assert.equal(isUnpacked(probe), false, 'test du lien : sans table');
  assert.equal(isUnpacked(raw), false, 'ligne reçue : contrôlée au dépliage');
  const seen = new Map();
  const out = await checkSeals([...stored, probe, raw, ...forged], E, seal, seen);
  assert.deepEqual(out.forged, [30, 31, 32, 33], 'sans sceau, liste forgée, contenu changé, sceau d\'un autre export');
  assert.deepEqual(out.kept.map(r => r.id), [10, 11, 20, 21]);
  assert.deepEqual([...seen.keys()], [10, 11], 'sceaux vérifiés gardés');
  const again = await checkSeals([stored[1]], E, seal, seen);
  assert.deepEqual([again.forged, [...seen.keys()]], [[], [11]], 'une ligne disparue sort du cache');
  assert.deepEqual((await checkSeals(stored, E, await sealer('j'.repeat(32)), new Map())).forged, [10, 11], 'autre clé');
});
