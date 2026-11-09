// Le jugement d'un lien collé reste dans le moteur, jamais dans un écran (consigne 005) : un lien qui écrirait
// dans un autre document est refusé, une clé coupée est reconnue, un Grist muet est dit, le code de contrôle
// qu'on n'a pas comparé en sécurité renforcée bloque, une invitation périmée ou d'une autre instance est
// refusée. Deux ou trois documents en mémoire sur la même instance (engine-fake.mjs), un seul port à la fois.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PORT_SHAPE, startEngine } from '../../js/engine/index.js';
import { buildReply, buildWebhookUrl } from '../../js/engine/logic/codes.js';
import { newKeyPair } from '../../js/engine/logic/trust.js';
import { readSchema } from '../../js/engine/port.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, enablePublicLink, invitationCode, invitationState, linkReturn, startInvitation, startReturn } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, mustCompare, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { fakeDoc, fakePort, fakeWorld } from './engine-fake.mjs';

let serial = 0;

// Une SOURCE avec un export et une invitation, une CIBLE qui l'a lue, a créé sa réception et répondu.
async function handshake({ renforce = false } = {}) {
  const world = fakeWorld();
  const n = String(++serial).padStart(2, '0');
  const source = fakeDoc({ docId: `sourcedoc00${n}x`, name: 'Annuaire', email: 'source@fake.local' });
  const target = fakeDoc({ docId: `targetdoc00${n}x`, name: 'Réception', email: 'cible@fake.local' });
  const other = fakeDoc({ docId: `otherdoc000${n}x`, name: 'Ailleurs', email: 'autre@fake.local' });
  source.addTable('Contacts', [{ id: 'Nom', type: 'Text' }], [{ Nom: 'Alice' }]);
  const as = (doc, over = {}) => startEngine({ port: { ...world.port(doc), ...over }, version: '9.9.9' });
  as(source);
  const { created: exp } = await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom'], filter: null }] });
  const { entry, secret } = await startInvitation(exp, { renforce });
  const { code } = await invitationCode(exp, entry, secret);
  as(target);
  const invitation = await readInvitation(code);
  const plans = invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' }));
  const made = await createReception(invitation, plans, { reserve: true, options: {} });
  const { code: reply, control } = await receptionReply(made, world.formLink(target, made.journal));
  return { world, source, target, other, as, exp, entry, secret, code, invitation, made, reply, control };
}

// Un code lu, modifié, réécrit (les codes ne sont pas signés : c'est un message que la personne copie).
const tamper = (code, change) => {
  const [prefix, body] = [code.slice(0, code.indexOf('.') + 1), code.slice(code.indexOf('.') + 1)];
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  change(payload);
  return prefix + Buffer.from(JSON.stringify(payload)).toString('base64url');
};

test('le port exige les trois fonctions du contrôle de lien', () => {
  for (const name of ['shareInfo', 'publicAccess', 'journalStats']) {
    const group = Object.values(PORT_SHAPE).find(names => names.includes(name));
    assert.ok(group, `${name} est dans PORT_SHAPE`);
    const world = fakeWorld();
    const port = world.port(fakeDoc());
    delete port[name];
    assert.throws(() => startEngine({ port }), new RegExp(`port incomplet.*${name}`));
  }
});

test('un lien qui écrit dans un autre document est refusé à la CIBLE comme à la SOURCE', async () => {
  const h = await handshake();
  // CIBLE : le lien du formulaire d'un autre document ne peut pas écrire dans ce journal.
  h.as(h.target);
  await assert.rejects(receptionReply(h.made, h.world.formLink(h.other, 'Journal_Annuaire')), e => ['linkTest', 'linkElsewhere'].includes(e.message));
  // SOURCE : une réponse dont l'adresse désigne un autre document que celui de la fiche (code forgé) est refusée.
  h.as(h.source);
  const forged = buildReply({
    id: h.entry.id, secret: h.secret, pub: (await newKeyPair()).pub, version: '9.9.9',
    recipient: { email: 'cible@fake.local', docId: h.target.docId, team: 'equipe', at: '2026-11-09 08:00' },
    url: buildWebhookUrl(h.world.formLink(h.other, 'Journal_Annuaire'), 'Journal_Annuaire'),
  });
  await assert.rejects(checkReply(h.exp, h.entry, forged), /shareOtherDoc/);
  assert.deepEqual(h.world.webhooks(h.source), [], 'aucun webhook');
});

test('une clé de formulaire inconnue (lien coupé) est reconnue', async () => {
  const h = await handshake();
  h.as(h.source);
  const cut = buildReply({
    id: h.entry.id, secret: h.secret, pub: (await newKeyPair()).pub, version: '9.9.9',
    recipient: { email: 'cible@fake.local', docId: h.target.docId, team: 'equipe', at: '2026-11-09 08:00' },
    url: 'https://fake.example/o/equipe/api/s/Coupee0000abcdefghijklmn/tables/Journal_Annuaire/records?flat=1',
  });
  await assert.rejects(checkReply(h.exp, h.entry, cut), /shareUnknown/);
});

test('Grist muet ou réponse inattendue : dit, jamais pris pour une clé valide', async () => {
  const h = await handshake();
  const mute = { shareInfo: async () => { throw new Error('shareUnreadable'); } };
  h.as(h.source, mute);
  await assert.rejects(checkReply(h.exp, h.entry, h.reply), /shareUnreadable/);
  assert.deepEqual(h.world.webhooks(h.source), []);
  // CIBLE : l'invitation d'un Échange vérifie de même l'adresse de retour qu'elle porte, chez Grist.
  h.as(h.source);
  const back = await startReturn(h.exp);
  const linked = await linkReturn(back.entry, h.world.formLink(h.source, back.entry.journal));
  const { code: exchange } = await invitationCode(h.exp, linked.entry, linked.secret, linked.retour);
  h.as(h.target, mute);
  await assert.rejects(readInvitation(exchange), /shareUnreadable/);
  h.as(h.target, { shareInfo: async () => null });
  await assert.rejects(readInvitation(exchange), /shareUnknown/);
  h.as(h.target, { shareInfo: async () => ({ docId: h.other.docId, name: 'Ailleurs', folder: '', team: 'equipe', teamName: 'Équipe', personal: false }) });
  await assert.rejects(readInvitation(exchange), /shareOtherDoc/);
  h.as(h.target);
  assert.equal((await readInvitation(exchange)).share.docId, h.source.docId, 'avec Grist, l\'adresse de retour désigne bien le document qui invite');
  // Et une fois Grist revenu, la même réponse passe.
  h.as(h.source);
  assert.equal((await checkReply(h.exp, h.entry, h.reply)).code, h.control);
});

test('le code de contrôle d\'une clé publique remplacée en route n\'est plus le même des deux côtés', async () => {
  const h = await handshake();
  const otherPub = (await newKeyPair()).pub;
  h.as(h.source);
  assert.equal((await checkReply(h.exp, h.entry, h.reply)).code, h.control, 'sans intrus : le même code');
  // Une clé publique d'un tiers à la place de celle de la CIBLE (le reste de la réponse est intact).
  const withOther = tamper(h.reply, (p) => { p.pub = otherPub; });
  assert.notEqual((await checkReply(h.exp, h.entry, withOther)).code, h.control, 'clé remplacée : un autre code, que la comparaison fait voir');
});

test('sécurité renforcée : sans comparaison du code de contrôle, rien n\'est écrit', async () => {
  const h = await handshake({ renforce: true });
  h.as(h.source);
  const reply = await checkReply(h.exp, h.entry, h.reply);
  const before = JSON.stringify(h.source.fetchRows('Synchro'));
  await assert.rejects(approveReply(h.exp, h.entry, reply), /codeNotCompared/);
  await assert.rejects(approveReply(h.exp, h.entry, reply, { compared: false }), /codeNotCompared/);
  assert.deepEqual(h.world.webhooks(h.source), [], 'aucun webhook');
  assert.equal(JSON.stringify(h.source.fetchRows('Synchro')), before, 'et rien dans Synchro');
  const hook = await approveReply(h.exp, h.entry, reply, { compared: true });
  assert.deepEqual(h.world.webhooks(h.source).map(w => w.id), [hook]);
  // Sans renforcé, la comparaison n'est pas exigée.
  const plain = await handshake();
  plain.as(plain.source);
  assert.ok(await approveReply(plain.exp, plain.entry, await checkReply(plain.exp, plain.entry, plain.reply)));
});

test('Échange renforcé : la CIBLE compare le code de l\'envoi de retour avant de choisir ses tables et de créer la réception', async () => {
  const h = await handshake();
  const invitation = { ...h.invitation, mode: 'echange', renforce: true };
  assert.equal(mustCompare(invitation), true);
  assert.equal(mustCompare({ ...invitation, renforce: false }), false);
  assert.equal(mustCompare({ ...invitation, mode: 'reponse' }), false, 'hors Échange, la CIBLE n\'a pas ce code à comparer');
  h.as(h.target);
  const tables = [...h.target.tables.keys()].sort();
  const plans = [{ tb: invitation.tables[0], dest: 'Autre_table' }];
  await assert.rejects(checkDestinations(invitation, plans), /codeNotCompared/);
  await assert.rejects(createReception(invitation, plans, { compared: false }), /codeNotCompared/);
  assert.deepEqual([...h.target.tables.keys()].sort(), tables, 'aucune table créée par le refus');
  assert.deepEqual((await checkDestinations(invitation, plans, { compared: true })).existing, []);
});

test('une invitation périmée ou d\'une autre instance est refusée à la lecture', async () => {
  const h = await handshake();
  h.as(h.source);
  const pastCode = tamper(h.code, (p) => { p.expire = 1000; });
  h.as(h.target);
  await assert.rejects(readInvitation(pastCode), /invitationExpired/);
  h.as(h.source);
  const publicCode = await enablePublicLink(h.exp);
  h.as(h.target);
  assert.equal((await readInvitation(publicCode)).mode, 'public');
  const elsewhere = tamper(publicCode, (p) => { p.base = p.base.replace('fake.example', 'autre.example'); });
  await assert.rejects(readInvitation(elsewhere), /otherInstance/);
});

test('état d\'une invitation en attente : lien attendu, périmée, valable', () => {
  const now = 1_800_000_000;
  const week = 7 * 24 * 3600;
  assert.equal(invitationState({ at: now - 10 }, now), 'valid');
  assert.equal(invitationState({ at: now - week - 10 }, now), 'expired');
  assert.equal(invitationState({ at: now - week - 10, journal: 'Journal_X', ready: true }, now), 'expired');
  assert.equal(invitationState({ at: now - week - 10, journal: 'Journal_X' }, now), 'link', 'un Échange sans lien de retour ne périme pas');
});
