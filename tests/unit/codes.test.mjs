// Codes d'invitation et de réponse, adresses : aller-retour, puis codes abîmés ou forgés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_FORMAT, buildInvitation, buildReply, buildWebhookUrl, cleanLabel, decodeCode, docNameFrom, docSlug, docUrl, loopingTables, maskKey, parseDocBaseUrl, parseFormLink, parseInvitation, parsePageAddress, parseReply, parseWebhookUrl } from '../../js/engine/logic/codes.js';
import { SECRET, ID, EXPORT, COLUMNS, PUB, invitation, forge } from './fixtures.mjs';

test('Échange : invitation avec adresse de retour, réponse avec les tables de la CIBLE', () => {
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom' }];
  const id = '0123456789abcdef';
  const exportId = 'fedcba9876543210';
  const retour = 'https://g.fr/o/eq/api/s/Abc123/tables/Journal_Annuaire/records?flat=1';
  const inv = parseInvitation(buildInvitation({ pub: PUB, id, exportId, name: 'Annuaire', origin: 'https://g.fr', secret: SECRET, retour, tables: [{ table: 'Contacts', columns }] }));
  assert.equal(inv.mode, 'echange');
  assert.equal(inv.retour, retour);
  assert.equal(inv.retourOrigin, 'https://g.fr');
  for (const wrong of ['https://g.fr/api/docs/d/tables/T/records?flat=1', retour.replace('?flat=1', ''), 'javascript:alert(1)']) {
    assert.throws(() => parseInvitation(buildInvitation({ pub: PUB, id, exportId, name: 'x', origin: '', retour: wrong, tables: [{ table: 'Contacts', columns }] })), /codeInvalid/, wrong);
  }
  const url = 'https://g.fr/o/eq/api/s/Xyz789/tables/Journal_Annuaire/records?flat=1';
  const recipient = { email: 'b@c.fr', docId: 'doc2' };
  const reply = parseReply(buildReply({ pub: PUB, id, recipient, url, retour: [{ table: 'Contacts_2', dest: 'Contacts', extra: 1 }] }), 'https://g.fr');
  assert.deepEqual(reply.retour, [{ table: 'Contacts_2', dest: 'Contacts' }]);
  assert.equal(parseReply(buildReply({ pub: PUB, id, recipient, url }), 'https://g.fr').retour, undefined, 'réponse ordinaire');
  assert.equal(reply.pub, PUB, 'clé publique de la CIBLE');
  assert.throws(() => parseReply(buildReply({ pub: 'xyz', id, recipient, url }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(buildReply({ pub: [PUB], id, recipient, url }), 'https://g.fr'), /codeInvalid/);
  const old = forge({ kind: 'reponse', id, recipient, url, cle: '0123456789abcdef0123456789abcdef' });
  assert.throws(() => parseReply(old, 'https://g.fr'), /inviteOld/, 'réponse d\'avant la 0.10 : invitation à refaire');
  for (const wrong of [[], [{ table: 'a;b', dest: 'Contacts' }], [{ table: 'A', dest: 'C' }, { table: 'B', dest: 'C' }], 'Contacts']) {
    assert.throws(() => parseReply(buildReply({ pub: PUB, id, recipient, url, retour: wrong }), 'https://g.fr'), /codeInvalid/, JSON.stringify(wrong));
  }
});

test('invitation : aller-retour, plusieurs tables, refus des codes invalides', () => {
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom' }, { id: 'Ville', type: 'Text', label: 'Ville é' }, { id: 'Vu', type: 'DateTime:Europe/Paris', label: 'Vu' }];
  const id = '0123456789abcdef';
  const exportId = 'fedcba9876543210';
  const code = buildInvitation({ pub: PUB, id, exportId, name: 'Annuaire', secret: SECRET, origin: 'https://g.fr', tables: [{ table: 'Contacts', columns }, { table: 'Villes', columns }] });
  assert.ok(code.startsWith('GRISTSYNC2.'));
  const inv = parseInvitation(code);
  assert.equal(inv.export, exportId);
  assert.deepEqual(inv.tables.map(tb => tb.table), ['Contacts', 'Villes']);
  assert.deepEqual(inv.tables[0].columns[1], { id: 'Ville', type: 'Text', label: 'Ville é' });
  assert.equal(inv.tables[0].columns[2].type, 'DateTime:Europe/Paris', 'une date à fuseau passe');
  assert.equal(parseInvitation(buildInvitation({ pub: PUB, id, exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })).secret, '');
  assert.throws(() => parseInvitation(buildInvitation({ pub: PUB, id, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })), /codeInvalid/, 'sans export');
  assert.throws(() => parseInvitation('bonjour'), /codeFormat/);
  assert.throws(() => parseInvitation('GRISTSYNC1.eyJ9'), /codeOld/);
  assert.throws(() => decodeCode(code, 'reponse'), /notReply/);
  const bad = buildInvitation({ pub: PUB, id, exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns: [{ id: 'a;b', type: 'Text' }] }] });
  assert.throws(() => parseInvitation(bad), /codeInvalid/);
  const twice = buildInvitation({ pub: PUB, id, exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }, { table: 'Contacts', columns }] });
  assert.throws(() => parseInvitation(twice), /codeInvalid/);
  // Durée de vie, sécurité renforcée et clé publique de la SOURCE voyagent avec l'invitation.
  const strong = parseInvitation(buildInvitation({ pub: PUB, id, exportId, name: 'x', secret: SECRET, origin: '', tables: [{ table: 'Contacts', columns }], expire: 1760604800, renforce: true }));
  assert.deepEqual([strong.expire, strong.renforce, strong.pub], [1760604800, true, PUB]);
  assert.deepEqual([inv.expire, inv.renforce], [0, false]);
  // Sans clé publique : une invitation d'avant la 0.10 (clé de l'export) est à refaire.
  const plain = { kind: 'invitation', id, export: exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] };
  assert.throws(() => parseInvitation(forge({ ...plain, cle: SECRET })), /codeOld/);
  assert.throws(() => parseInvitation(forge(plain)), /codeInvalid/);
  assert.equal(parseInvitation(forge({ ...plain, mode: 'public', base: 'https://g.fr/api/docs/abc' })).pub, '', 'lien public : pas de clé');
});

test('réponse : même instance, une adresse par clé de formulaire seulement', () => {
  const url = 'https://g.fr/o/eq/api/s/Abc123/tables/Journal_Annuaire/records?flat=1';
  const id = '0123456789abcdef';
  const recipient = { email: 'a@b.fr', docId: 'doc1', team: 'eq', at: '2026-10-14', extra: 'x' };
  const reply = parseReply(buildReply({ pub: PUB, id, secret: SECRET, recipient, url }), 'https://g.fr');
  assert.equal(reply.url, url);
  assert.deepEqual({ ...reply.recipient }, { email: 'a@b.fr', docId: 'doc1', team: 'eq', at: '2026-10-14' }, 'seulement les champs connus');
  assert.equal(reply.secret, SECRET);
  assert.equal(reply.recipient.extra, undefined);
  assert.equal(parseReply(buildReply({ pub: PUB, id, recipient, url }), 'https://g.fr').secret, '');
  assert.throws(() => parseReply(buildReply({ pub: PUB, id, secret: 'court', recipient, url }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(buildReply({ pub: PUB, id, recipient, url }), 'https://autre.fr'), /otherInstance/);
  assert.throws(() => parseReply(buildReply({ pub: PUB, id, recipient, url: url.replace('?flat=1', '') }), 'https://g.fr'), /codeInvalid/);
  assert.throws(() => parseReply(buildReply({ pub: PUB, id, recipient, url: 'https://g.fr/api/docs/doc1/tables/T/records?flat=1' }), 'https://g.fr'), /codeInvalid/);
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
  const code = buildInvitation({ pub: PUB, id, exportId, name: 'x', origin: 'https://g.fr', base: 'https://g.fr/o/eq/api/docs/abcDEF12', tables: [{ table: 'Contacts', columns }] });
  const inv = parseInvitation(code);
  assert.equal(inv.mode, 'public');
  assert.equal(inv.base, 'https://g.fr/o/eq/api/docs/abcDEF12');
  const bad = buildInvitation({ pub: PUB, id, exportId, name: 'x', origin: '', base: 'https://g.fr/api/docs/abc?x=1', tables: [{ table: 'Contacts', columns }] });
  assert.throws(() => parseInvitation(bad), /codeInvalid/);
  assert.equal(parseInvitation(buildInvitation({ pub: PUB, id, exportId, name: 'x', origin: '', tables: [{ table: 'Contacts', columns }] })).mode, 'reponse');
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
  const base = { kind: 'invitation', id: ID, export: EXPORT, name: 'A', origin: 'https://g.fr', pub: PUB, tables: [{ table: 'Contacts', columns: COLUMNS }] };
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
    'date d\'expiration qui n\'est pas un nombre': { expire: '2026-10-23' },
    'clé publique mal formée': { pub: 'zz' },
    'clé publique dans un tableau': { pub: [PUB] },
    'clé publique trop longue': { pub: `${PUB}A` },
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
  const reply = fields => buildReply({ pub: PUB, id: ID, secret: SECRET, recipient: { email: 'a@b.fr' }, url, ...fields });
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

test('version : portée par les codes, un code d\'une forme plus récente refusé en nommant les deux versions', () => {
  assert.equal(parseInvitation(invitation({ version: '0.12.0' }), '0.12.0').version, '0.12.0');
  assert.equal(parseInvitation(invitation(), '0.12.0').version, '', 'code sans version : d\'avant la 0.12');
  assert.equal(parseInvitation(invitation({ version: 'x.y' })).version, '');
  const url = 'https://g.fr/api/s/Abc123/tables/Journal_A/records?flat=1';
  const reply = buildReply({ pub: PUB, id: ID, secret: SECRET, recipient: { email: 'a@b.fr' }, url, version: '0.12.1' });
  assert.equal(parseReply(reply, 'https://g.fr', '0.12.0').version, '0.12.1', 'une autre version de même forme est lue');
  const raw = JSON.parse(Buffer.from(invitation({ version: '0.12.0' }).slice('GRISTSYNC2.'.length), 'base64url').toString());
  assert.equal(raw.f, CODE_FORMAT);
  assert.throws(() => parseInvitation(forge({ ...raw, f: CODE_FORMAT + 1, v: '0.14.0' }), '0.12.0'), e => e.message === 'codeNewer' && e.vars.theirs === '0.14.0' && e.vars.mine === '0.12.0');
  assert.throws(() => parseReply(forge({ kind: 'reponse', f: 9, v: 'bizarre' }), 'https://g.fr'), e => e.message === 'codeNewer' && e.vars.theirs === '?' && e.vars.mine === '?');
  assert.throws(() => decodeCode(forge({ ...raw, f: CODE_FORMAT + 1 }), 'reponse'), /codeNewer/, 'la forme est lue avant le type');
});

test('forme 2 (moteur 5.0.0) : les codes d\'avant restent lus, ceux d\'aujourd\'hui portent la forme 2', () => {
  assert.equal(CODE_FORMAT, 2, 'relevée avec les références entre tables par colonne (moteur 4.11.0)');
  const url = 'https://g.fr/api/s/Abc123/tables/Journal_A/records?flat=1';
  const fresh = JSON.parse(Buffer.from(invitation({ version: '0.28.2' }).slice('GRISTSYNC2.'.length), 'base64url').toString());
  assert.equal(fresh.f, 2);
  assert.equal(JSON.parse(Buffer.from(buildReply({ pub: PUB, id: ID, secret: SECRET, recipient: { email: 'a@b.fr' }, url, version: '0.28.2' }).slice('GRISTSYNC2.'.length), 'base64url').toString()).f, 2);
  // Un code fait par la forme 1 (Bêta jusqu'à la 0.28.1) : lu tel quel, invitation comme réponse.
  const old = { ...fresh, f: 1, v: '0.28.1' };
  assert.equal(parseInvitation(forge(old), '0.28.2').version, '0.28.1');
  const oldReply = { kind: 'reponse', f: 1, v: '0.28.1', id: ID, secret: SECRET, recipient: { email: 'a@b.fr' }, url, pub: PUB };
  assert.equal(parseReply(forge(oldReply), 'https://g.fr', '0.28.2').version, '0.28.1');
});

test('document de la SOURCE dans l\'invitation : équipe et nom lus avec méfiance', () => {
  const columns = [{ id: 'Nom', type: 'Text' }];
  const make = from => parseInvitation(buildInvitation({ pub: PUB, id: ID, exportId: EXPORT, name: 'x', origin: 'https://g.fr', secret: SECRET, from, tables: [{ table: 'T', columns }] })).from;
  assert.deepEqual(make({ email: 'a@b.fr', docId: 'doc123456789', team: 'dinum', docName: 'Budget 2026' }),
    { email: 'a@b.fr', docId: 'doc123456789', team: 'dinum', docName: 'Budget 2026' });
  assert.deepEqual(make({ email: 'a@b.fr', docId: 'doc123456789' }), { email: 'a@b.fr', docId: 'doc123456789' }, 'invitation d\'avant : ni équipe ni nom, donc aucun lien');
  assert.equal(make({ docId: 'd', team: '' }).team, '', 'site sans équipe dans le chemin : connu, vide');
  for (const team of ['a/b', '../x', 'x y', 'é', 'x'.repeat(121), 7, null, {}]) assert.equal('team' in make({ docId: 'd', team }), false, `équipe refusée : ${JSON.stringify(team)}`);
  assert.equal(make({ docId: 'd', docName: '<img src=x onerror=alert(1)>' }).docName, '<img src=x onerror=alert(1)>', 'le texte est gardé tel quel : il n\'est jamais interprété comme du HTML (textContent)');
  assert.equal('docName' in make({ docId: 'd', docName: '   ' }), false, 'nom vide : absent');
  assert.equal(make({ docId: 'd', docName: 'x'.repeat(500) }).docName.length, 200);
  assert.equal(make({ docId: 'd', docName: 42 }).docName, '42');
  assert.equal(make({ docId: 'd', docName: { a: 1 } }).docName, '[object Object]'.slice(0, 200), 'jamais d\'erreur à la lecture d\'un code forgé');
});

test('cleanLabel : contrôles et sens d\'écriture ôtés, espaces ramenées à une, 200 caractères', () => {
  assert.equal(cleanLabel('  a \n\t b\u0000c\u202Ed\u2066e\u200Bf\ufeffg  '), 'a b c d e f g');
  assert.equal(cleanLabel(undefined), '');
  assert.equal(cleanLabel(null), '');
  assert.equal(cleanLabel('é « ça » 日本'), 'é « ça » 日本');
  assert.equal(cleanLabel('x'.repeat(300)).length, 200);
});

test('docUrl : adresse du document dans Grist, refaite d\'après l\'instance de ce document, sous la forme que Grist écrit', () => {
  assert.equal(docUrl('https://g.fr', 'dinum', 'Abc123xyz789', 'Suivi RH 2027'), 'https://g.fr/o/dinum/Abc123xyz789/Suivi-RH-2027', 'identifiant puis nom');
  assert.equal(docUrl('https://g.fr', 'dinum', 'Abc123xyz789'), 'https://g.fr/o/dinum/Abc123xyz789/document', 'nom inconnu : un nom neutre, Grist rétablit le sien');
  assert.equal(docUrl('https://g.fr', '', 'Abc123xyz789', 'Suivi'), 'https://g.fr/Abc123xyz789/Suivi', 'sans équipe');
  assert.equal(docUrl('https://g.fr', 'docs-12', 'Abc123xyz789', 'Perso'), 'https://g.fr/o/docs/Abc123xyz789/Perso', 'espace personnel : « docs », comme Grist l\'écrit');
  assert.equal(docUrl('https://g.fr', 'docsx-12', 'Abc123xyz789'), 'https://g.fr/o/docsx-12/Abc123xyz789/document', 'seul docs-<numéro> est un espace personnel');
  assert.equal(docUrl('http://localhost:8484', 'synctest', 'Abc123xyz789', 'Lien'), 'http://localhost:8484/o/synctest/Abc123xyz789/Lien', 'Grist local d\'essai');
  assert.equal(docUrl('http://127.0.0.1:8484', 'e', 'd'), 'http://127.0.0.1:8484/o/e/doc/d', 'identifiant de moins de 12 caractères : forme /doc/ de Grist');
  assert.equal(docUrl('https://g.fr', 'e', 'Abc123xyz789', '<i>x</i>/../?#'), 'https://g.fr/o/e/Abc123xyz789/i-x-i', 'le nom ne peut rien ajouter à l\'adresse');
  for (const origin of ['', undefined, 'g.fr', 'http://g.fr', 'ftp://g.fr', 'javascript:alert(1)', 'https://g.fr/o/x', 'https://g.fr/', 'https://u:p@g.fr', 'https://g.fr?x=1', 'data:text/html,x']) {
    assert.equal(docUrl(origin, 'e', 'doc123456789'), '', `instance refusée : ${origin}`);
  }
  for (const [team, docId] of [['e/x', 'd'], ['e', 'd/..'], ['e', 'd?x=1'], ['e', 'd#x'], ['e', ''], ['e', undefined], ['e x', 'd'], ['e', 'd'.repeat(121)], ['e\n', 'd'], ['e', 'd\n']]) {
    assert.equal(docUrl('https://g.fr', team, docId), '', `refusé : ${team} ${docId}`);
  }
});

test('docSlug : le nom d\'un document comme Grist l\'écrit dans une adresse', () => {
  assert.equal(docSlug('Lien SOURCE'), 'Lien-SOURCE');
  assert.equal(docSlug('Éléphant à l\'été 2027'), 'Elephant-a-l-ete-2027');
  assert.equal(docSlug('  --a  b--  '), 'a-b');
  assert.equal(docSlug('日本'), '', 'rien de lisible : vide');
  assert.equal(docSlug(null), '');
  assert.equal(docSlug('x'.repeat(200)).length, 80);
  assert.ok(!docSlug('a'.repeat(79) + ' b').endsWith('-'), 'coupé sans tiret final');
});

test('parsePageAddress : ce que dit l\'adresse d\'une page de document (formes réelles de Grist, relevées dans un Grist 1.7)', () => {
  const page = (address, name = '') => ({ origin: 'https://g.fr', team: 'dinum', docId: 'fcLELfFeTQ1x', name, ...address });
  assert.deepEqual(parsePageAddress('https://g.fr/o/dinum/fcLELfFeTQ1x/Donnees-Ministere-2026-v2'), page({}, 'Donnees Ministere 2026 v2'), 'équipe, identifiant, nom');
  assert.deepEqual(parsePageAddress('  https://g.fr/o/dinum/fcLELfFeTQ1x/Suivi-des-contacts/p/3?compare=a#frag '), page({}, 'Suivi des contacts'), 'page, requête et ancre ignorées, espaces autour');
  assert.deepEqual(parsePageAddress('https://g.fr/fcLELfFeTQ1x/Suivi'), page({ team: '' }, 'Suivi'), 'sans équipe');
  assert.deepEqual(parsePageAddress('https://g.fr/o/dinum/doc/hzarkQz3bxWc'), page({ docId: 'hzarkQz3bxWc' }), 'forme /doc/ : un nom sans lettre latine n\'a pas de nom dans l\'adresse');
  assert.deepEqual(parsePageAddress('https://g.fr/o/dinum/doc/hzarkQz3bxWc/p/2'), page({ docId: 'hzarkQz3bxWc' }), '/doc/ avec une page');
  assert.equal(parsePageAddress('https://g.fr/o/dinum/fcLELfFeTQ1x/p/4').name, '', 'sans nom, la page n\'est pas prise pour un nom');
  assert.equal(parsePageAddress('https://g.fr/o/dinum/fcLELfFeTQ1x/p/p/4').name, 'p', 'un document nommé « p »');
  assert.equal(parsePageAddress('https://g.fr/o/dinum/fcLELfFeTQ1x/document').name, '', '« document » est le nom neutre de nos liens : aucun nom');
  assert.equal(parsePageAddress('https://g.fr/o/dinum/fcLELfFeTQ1x/Ete-Ca-va-OEuvre-and-co').name, 'Ete Ca va OEuvre and co');
  assert.equal(parsePageAddress('http://localhost:8484/o/synctest/oyvXvwNTnh4Q/Lien').origin, 'http://localhost:8484', 'Grist local d\'essai');
  assert.equal(parsePageAddress('https://g.fr/o/dinum/fcLELfFeTQ1x/%3Ci%3Ex%3C%2Fi%3E%0A').name, '<i>x</i>', 'décodé puis nettoyé comme tout nom (du texte, montré comme tel)');
  for (const bad of ['', 'Suivi RH', 'ftp://g.fr/o/dinum/fcLELfFeTQ1x/x', 'javascript:alert(1)', 'https://g.fr/', 'https://g.fr/o/dinum', 'https://g.fr/o/dinum/doc', 'https://g.fr/o/di num/fcLELfFeTQ1x/x', 'https://g.fr/fcLELfFeTQ1x~fork/x', 'https://g.fr/%E0%A4%A/x']) {
    assert.equal(parsePageAddress(bad), null, `refusé : ${bad}`);
  }
});

test('docNameFrom : le champ « Nom de ce document », nom tapé ou adresse de la page collée, jamais une adresse gardée', () => {
  const here = { origin: 'https://g.fr', docId: 'fcLELfFeTQ1x' };
  assert.deepEqual(docNameFrom('  Suivi   RH  ', here), { kind: 'typed', name: 'Suivi RH' }, 'nom tapé : nettoyé');
  assert.deepEqual(docNameFrom('', here), { kind: 'typed', name: '' });
  assert.deepEqual(docNameFrom('https://g.fr/o/dinum/fcLELfFeTQ1x/Suivi-RH-2027/p/1', here), { kind: 'address', name: 'Suivi RH 2027' }, 'nom lu dans l\'adresse');
  assert.deepEqual(docNameFrom('https://g.fr/o/dinum/fcLELfFeTQ1xABCDEFGHIJ/Suivi', here), { kind: 'address', name: 'Suivi' }, 'identifiant complet de 22 caractères : même document');
  assert.deepEqual(docNameFrom('https://g.fr/o/dinum/doc/fcLELfFeTQ1x', here), { kind: 'noName', name: '' }, 'adresse de ce document sans nom');
  assert.deepEqual(docNameFrom('https://g.fr/o/dinum/iStdbZSjRjut/Autre', here), { kind: 'otherDoc', name: '' }, 'un autre document : pas son nom');
  assert.deepEqual(docNameFrom('https://g.fr/o/dinum/fcLELfFeT/Court', here), { kind: 'otherDoc', name: '' }, 'identifiant tronqué de moins de 12 caractères : pas le même');
  assert.deepEqual(docNameFrom('https://autre.fr/o/dinum/fcLELfFeTQ1x/Suivi', here), { kind: 'otherSite', name: '' }, 'une autre instance');
  assert.deepEqual(docNameFrom('http://g.fr/o/dinum/fcLELfFeTQ1x/Suivi', here), { kind: 'otherSite', name: '' }, 'http n\'est pas l\'origine de ce document');
  assert.deepEqual(docNameFrom('https://g.fr/o/dinum', here), { kind: 'invalid', name: '' });
  assert.deepEqual(docNameFrom('https://g.fr/o/dinum/fcLELfFeTQ1x/Suivi', null), { kind: 'otherSite', name: '' }, 'document inconnu : rien n\'est lu');
  assert.deepEqual(docNameFrom('https://g.fr/o/dinum/abc/Suivi', { origin: 'https://g.fr', docId: 'abc' }), { kind: 'address', name: 'Suivi' }, 'identifiant choisi à la main (moins de 12 caractères) : identique');
  for (const text of ['https://g.fr/o/dinum/iStdbZSjRjut/X', 'https://g.fr/', 'https://autre.fr/fcLELfFeTQ1x/x', 'http://x']) {
    assert.equal(docNameFrom(text, here).name.includes('/'), false, `jamais une adresse : ${text}`);
  }
});
