// Codes d'invitation et de réponse, adresses : aller-retour, puis codes abîmés ou forgés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvitation, buildReply, buildWebhookUrl, decodeCode, loopingTables, maskKey, parseDocBaseUrl, parseFormLink, parseInvitation, parseReply, parseWebhookUrl } from '../../js/logic/codes.js';
import { SECRET, ID, EXPORT, COLUMNS, invitation, forge } from './fixtures.mjs';

test('Échange : invitation avec adresse de retour, réponse avec les tables de la CIBLE', () => {
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom' }];
  const id = '0123456789abcdef';
  const exportId = 'fedcba9876543210';
  const retour = 'https://g.fr/o/eq/api/s/Abc123/tables/Journal_Annuaire/records?flat=1';
  const inv = parseInvitation(buildInvitation({ id, exportId, name: 'Annuaire', origin: 'https://g.fr', secret: SECRET, retour, tables: [{ table: 'Contacts', columns }] }));
  assert.equal(inv.mode, 'echange');
  assert.equal(inv.retour, retour);
  assert.equal(inv.retourOrigin, 'https://g.fr');
  for (const wrong of ['https://g.fr/api/docs/d/tables/T/records?flat=1', retour.replace('?flat=1', ''), 'javascript:alert(1)']) {
    assert.throws(() => parseInvitation(buildInvitation({ id, exportId, name: 'x', origin: '', retour: wrong, tables: [{ table: 'Contacts', columns }] })), /codeInvalid/, wrong);
  }
  const url = 'https://g.fr/o/eq/api/s/Xyz789/tables/Journal_Annuaire/records?flat=1';
  const recipient = { email: 'b@c.fr', docId: 'doc2' };
  const reply = parseReply(buildReply({ id, recipient, url, retour: [{ table: 'Contacts_2', dest: 'Contacts', extra: 1 }] }), 'https://g.fr');
  assert.deepEqual(reply.retour, [{ table: 'Contacts_2', dest: 'Contacts' }]);
  assert.equal(parseReply(buildReply({ id, recipient, url }), 'https://g.fr').retour, undefined, 'réponse ordinaire');
  for (const wrong of [[], [{ table: 'a;b', dest: 'Contacts' }], [{ table: 'A', dest: 'C' }, { table: 'B', dest: 'C' }], 'Contacts']) {
    assert.throws(() => parseReply(buildReply({ id, recipient, url, retour: wrong }), 'https://g.fr'), /codeInvalid/, JSON.stringify(wrong));
  }
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
  const recipient = { email: 'a@b.fr', docId: 'doc1', team: 'eq', at: '2026-10-14', extra: 'x' };
  const reply = parseReply(buildReply({ id, secret: SECRET, recipient, url }), 'https://g.fr');
  assert.equal(reply.url, url);
  assert.deepEqual({ ...reply.recipient }, { email: 'a@b.fr', docId: 'doc1', team: 'eq', at: '2026-10-14' }, 'seulement les champs connus');
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

// Cas limites.

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

test('masque : toutes les clés d\'un texte, adresses d\'envoi et liens de formulaire', () => {
  assert.equal(maskKey('a /api/s/AbCdEfGh/x et /api/s/IjKlMnOp/y'), 'a /api/s/AbCd…/x et /api/s/IjKl…/y');
  assert.equal(maskKey('https://g.fr/o/eq/forms/AbCdEfGh/3'), 'https://g.fr/o/eq/forms/AbCd…/3');
  assert.equal(maskKey(42), '42');
});
