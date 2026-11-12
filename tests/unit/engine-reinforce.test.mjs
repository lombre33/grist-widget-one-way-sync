// Renforcer la sécurité d'un partage déjà branché (reinforce.js) : un partage d'avant les clés de signature (ni la
// SOURCE ni la CIBLE n'ont de clé pour lui) est renforcé par une nouvelle invitation. Le moteur joue seul les deux
// documents : l'ancien envoi reste accepté jusqu'à la première livraison signée (7 jours au plus), la nouvelle clé
// remplace l'ancien webhook, et la CIBLE peut revenir à l'ancien fonctionnement tant que rien n'est signé.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KEY_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL, nowS } from '../../js/engine/logic/common.js';
import { signText } from '../../js/engine/logic/trust.js';
import { GRACE_S, canRevert, finishRenf, graceOpen, renfState, startRenf, unsignedHooks } from '../../js/engine/logic/reinforce.js';
import { readSchema } from '../../js/engine/port.js';
import { readHooks, readSourceNote, syncRows, writeSync } from '../../js/engine/source/synchro.js';
import { eventsOf } from '../../js/engine/logic/notes.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, canReinforce, checkReply, invitationCode, renewInvitation, startInvitation, startReinforcement } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, knownReception, readInvitation, receptionReply, relinkReception, revertReinforcement } from '../../js/engine/target/receive.js';
import { dropKey, updateJournalNote } from '../../js/engine/target/journals.js';
import { consolidateAll } from '../../js/engine/target/loop.js';
import { receivedJournals, receivedKey } from '../../js/engine/logic/received.js';
import { fakePair } from './engine-fake.mjs';

test('états du renforcement (logique pure)', () => {
  const now = 1_800_000_000;
  assert.equal(renfState({}, now), 'none');
  assert.equal(renfState({ renf: 'x' }, now), 'none', 'une note retouchée à la main ne casse rien');
  assert.equal(renfState({ renf: { at: now - 10 } }, now), 'pending');
  assert.equal(renfState({ renf: { at: now - GRACE_S + 1 } }, now), 'pending');
  assert.equal(renfState({ renf: { at: now - GRACE_S } }, now), 'expired', 'à 7 jours pile, l\'ancien envoi n\'est plus toléré');
  assert.equal(renfState({ renf: { at: now - 5, done: now - 1 } }, now), 'done');
  assert.ok(graceOpen({ renf: { at: now - 10 } }, now));
  assert.ok(!graceOpen({ renf: { at: now - GRACE_S - 1 } }, now));
  assert.ok(!graceOpen({}, now));
  // Début : une réception sans clé attend ; déjà attendue, le délai repart ; renforcée ou avec sa clé, rien.
  assert.deepEqual(startRenf({ a: 1 }, true, now).renf, { at: now });
  assert.deepEqual(startRenf({ renf: { at: now - 99 } }, false, now).renf, { at: now }, 'un nouveau code relance le délai');
  assert.deepEqual(startRenf({ renf: { at: now - GRACE_S - 5 } }, false, now).renf, { at: now }, 'un délai passé repart aussi');
  assert.equal(startRenf({ a: 1 }, false, now).renf, undefined, 'avait sa clé : rien à attendre');
  assert.deepEqual(startRenf({ renf: { at: 5, done: 9 } }, false, now).renf, { at: 5, done: 9 }, 'déjà renforcée : gardée telle quelle');
  assert.deepEqual(finishRenf({ renf: { at: 5 } }, 9).renf, { at: 5, done: 9 });
  assert.equal(finishRenf({}, 9).renf, undefined);
  assert.ok(canRevert({ renf: { at: now - 10 } }, now) && canRevert({ renf: { at: now - GRACE_S } }, now));
  assert.ok(!canRevert({ renf: { at: 5, done: 9 } }, now) && !canRevert({}, now));
  // Destinataires sans clé : ceux qu'aucune clé ne nomme (et aucune clé commune d'avant la 0.10 ne couvre).
  const hooks = [{ id: 11 }, { id: 12 }];
  assert.deepEqual(unsignedHooks('', hooks), [11, 12]);
  assert.deepEqual(unsignedHooks(JSON.stringify({ 11: 'a'.repeat(32) }), hooks), [12]);
  assert.deepEqual(unsignedHooks('b'.repeat(32), hooks), [], 'une clé commune d\'avant la 0.10 signe pour tous');
});


// Branche un partage de bout en bout (SOURCE, CIBLE, réponse approuvée) sur `world` ; rend l'export, la réception, le
// lien du formulaire, l'adresse d'envoi et le webhook.
async function wire(w, src, dst, tag) {
  const as = d => startEngine({ port: w.port(d), version: '9.9.9' });
  as(src);
  const exp = (await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom'], filter: null }] })).created;
  const first = await startInvitation(exp);
  const { code } = await invitationCode(exp, first.entry, first.secret);
  as(dst);
  const invitation = await readInvitation(code);
  const plans = invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' }));
  await checkDestinations(invitation, plans);
  const made = await createReception(invitation, plans, { reserve: true, options: {} });
  const link = w.formLink(dst, made.journal);
  const reply = await receptionReply(made, link);
  as(src);
  const checked = await checkReply(exp, first.entry, reply.code);
  const oldHook = await approveReply(exp, first.entry, checked);
  return { exp, made, link, url: checked.url, oldHook, firstReply: checked };
}

// Ramène la réception de la CIBLE à l'état d'avant les signatures.
async function unsign(made, exp) {
  await dropKey(made.note.tables.map(tb => tb.dest), exp.id);
  await updateJournalNote(made.journal, ({ pub, pubSource, sceau, ...rest }) => rest);
}

const { world, source, target } = fakePair('rf');
const asDoc = doc => startEngine({ port: world.port(doc), version: '9.9.9' });
const story = {};

// Un lot comme la SOURCE l'enverrait : signé avec `key`, ou sans signature (l'ancien envoi).
async function send(url, lotRow, key, lines) {
  const row = { [EXPORT_COL]: story.exp.id, [TABLE_COL]: 'Contacts', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lotRow[SCHEMA_COL] };
  const text = JSON.stringify({ lignes: lines, total: lines.length });
  world.deliver(url, [{ ...row, [LOT_COL]: key ? await signText(key, row, text) : text }]);
}
const names = () => target.rows('Annuaire_recu').filter(r => r.Supprime !== true).map(r => `${r[KEY_COL]}:${r.Nom}`).sort();
const suspect = async () => (receivedJournals(await readSchema())[0].note.suspect || {}).n || 0;

test('un partage d\'avant les clés se renforce sans rien couper', async (t) => {
  await t.test('un partage branché, puis ramené à l\'état d\'avant les signatures', async () => {
    const wired = await wire(world, source, target, 'rf');
    Object.assign(story, wired);
    // L'état d'une réception branchée par l'Alpha : ni clé ni sceau chez la CIBLE, aucune clé chez la SOURCE.
    asDoc(target);
    await unsign(story.made, story.exp);
    asDoc(source);
    const row = (await syncRows()).find(r => r[TYPE_COL] === KIND.sign);
    await writeSync([row.id], { [SCHEMA_COL]: '' });
    assert.deepEqual(unsignedHooks(((await syncRows()).find(r => r[TYPE_COL] === KIND.sign) || {})[SCHEMA_COL], (await readHooks()).of(story.exp.id)), [story.oldHook]);
    story.lotRow = (await syncRows()).find(r => r[TYPE_COL] === KIND.lot);
    asDoc(target);
    assert.equal(receivedKey(await readSchema(), story.made.journal, receivedJournals(await readSchema())[0].note), '', 'plus de clé chez la CIBLE');
    await send(story.url, story.lotRow, null, [['k1', 100, false, { Nom: 'Alice' }]]);
    await consolidateAll();
    assert.deepEqual(names(), ['k1:Alice'], 'l\'ancien envoi sans signature est accepté');
  });

  await t.test('SOURCE : renforcer un destinataire actif, jamais un autre cas', async () => {
    asDoc(source);
    const hook = (await readHooks()).of(story.exp.id)[0];
    assert.ok(canReinforce(story.exp, hook));
    assert.ok(!canReinforce({ ...story.exp, echange: true }, hook) && !canReinforce({ ...story.exp, public: true }, hook));
    assert.ok(!canReinforce(story.exp, { ...hook, fields: { ...hook.fields, enabled: false } }), 'en pause : reprendre d\'abord');
    await assert.rejects(startReinforcement({ ...story.exp, echange: true }, hook), /reinforceNot/);
    story.second = await startReinforcement(story.exp, hook);
    assert.equal(story.second.entry.replaces, hook.id, 'l\'invitation sait quel envoi elle remplace');
    const renewed = await renewInvitation(story.second.entry);
    assert.equal(renewed.entry.replaces, hook.id, 'refaire le code garde le remplacement');
    story.code = (await invitationCode(story.exp, renewed.entry, renewed.secret)).code;
    story.secondEntry = renewed.entry;
  });

  await t.test('CIBLE : le nouveau code reprend la même réception, l\'ancien envoi reste accepté', async () => {
    asDoc(target);
    const invitation = await readInvitation(story.code);
    const known = await knownReception(invitation);
    const { journal, note } = await relinkReception(known, invitation);
    assert.equal(journal, story.made.journal);
    assert.equal(renfState(note, nowS()), 'pending', 'l\'attente commence au code collé');
    assert.ok(note.pub, 'de nouvelles clés sont tirées');
    story.reply = (await receptionReply({ journal, note }, story.link)).code;
    // Les clés sont déjà là chez la CIBLE, mais l'ancien webhook envoie encore sans signature : accepté.
    await send(story.url, story.lotRow, null, [['k2', 200, false, { Nom: 'Bob' }]]);
    await consolidateAll({ reread: true });
    assert.deepEqual(names(), ['k1:Alice', 'k2:Bob'], 'rien n\'est coupé pendant l\'échange');
    assert.equal(await suspect(), 0, 'ni rejet ni arrivée suspecte');
    // Une signature fausse reste rejetée, même pendant l'attente.
    await send(story.url, story.lotRow, '0'.repeat(32), [['k9', 300, false, { Nom: 'Intrus' }]]);
    await consolidateAll({ reread: true });
    assert.deepEqual(names(), ['k1:Alice', 'k2:Bob']);
    assert.ok(await suspect() >= 1, 'une signature fausse est une arrivée suspecte');
    assert.equal(renfState(receivedJournals(await readSchema())[0].note, nowS()), 'pending', 'rien de signé encore');
  });

  await t.test('SOURCE : la réponse remplace l\'ancien webhook, sans avis de fin', async () => {
    asDoc(source);
    const reply = await checkReply(story.exp, story.secondEntry, story.reply);
    story.accepted = reply;
    const hook = await approveReply(story.exp, story.secondEntry, reply);
    const hooks = world.webhooks(source);
    assert.deepEqual(hooks.map(h => h.id), [hook], 'un seul webhook : le nouveau');
    assert.notEqual(hook, story.oldHook);
    assert.deepEqual(eventsOf(readSourceNote(await readSchema()), story.exp.id).filter(e => ['join', 'reinforce', 'revoke'].includes(e.kind)).map(e => e.kind), ['reinforce', 'join'], 'un renforcement n\'est ni une arrivée ni un départ');
    const keys = JSON.parse(((await syncRows()).find(r => r[TYPE_COL] === KIND.sign) || {})[SCHEMA_COL] || '{}');
    assert.deepEqual(Object.keys(keys), [String(hook)], 'la clé du nouveau webhook seulement');
    assert.deepEqual(readSourceNote(await readSchema()).invitations, []);
    assert.equal((await syncRows()).filter(r => r[TYPE_COL] === KIND.end).length, 0, 'aucune ligne d\'avis de fin');
  });

  await t.test('CIBLE : la première livraison signée finit le renforcement, l\'ancien envoi n\'est plus accepté', async () => {
    await send(story.url, story.lotRow, story.accepted.keys.down, [['k1', 300, false, { Nom: 'Alice B.' }]]);
    asDoc(target);
    await consolidateAll({ reread: true });
    assert.deepEqual(names(), ['k1:Alice B.', 'k2:Bob']);
    const note = receivedJournals(await readSchema())[0].note;
    assert.equal(renfState(note, nowS()), 'done');
    assert.ok(note.renf.done >= note.renf.at);
    const before = await suspect();
    await send(story.url, story.lotRow, null, [['k8', 400, false, { Nom: 'Ancien' }]]);
    await consolidateAll({ reread: true });
    assert.deepEqual(names(), ['k1:Alice B.', 'k2:Bob'], 'sans signature : refusé, comme tout envoi non signé');
    assert.ok(await suspect() > before);
    await assert.rejects(revertReinforcement(story.made.journal), /revertNone/, 'plus de retour en arrière une fois renforcé');
  });
});

test('un délai passé sans approbation : l\'ancien envoi est refusé, puis la CIBLE revient à l\'ancien fonctionnement', async (t) => {
  const pair = fakePair('rg');
  const doc = d => startEngine({ port: pair.world.port(d), version: '9.9.9' });
  const local = await wire(pair.world, pair.source, pair.target, 'rg');
  doc(pair.target);
  await unsign(local.made, local.exp);
  doc(pair.source);
  const lotRow = (await syncRows()).find(r => r[TYPE_COL] === KIND.lot);
  const second = await startInvitation(local.exp);
  const code2 = (await invitationCode(local.exp, second.entry, second.secret)).code;
  doc(pair.target);
  const invitation = await readInvitation(code2);
  await relinkReception(await knownReception(invitation), invitation);
  const deliver = async (lines) => {
    const row = { [EXPORT_COL]: local.exp.id, [TABLE_COL]: 'Contacts', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lotRow[SCHEMA_COL] };
    pair.world.deliver(local.url, [{ ...row, [LOT_COL]: JSON.stringify({ lignes: lines, total: lines.length }) }]);
  };
  const got = () => pair.target.rows('Annuaire_recu').filter(r => r.Supprime !== true).map(r => r.Nom).sort();
  const journal = local.made.journal;

  await t.test('sept jours après le code collé, l\'ancien envoi n\'est plus toléré', async () => {
    await deliver([['a1', 100, false, { Nom: 'Avant' }]]);
    await consolidateAll();
    assert.deepEqual(got(), ['Avant'], 'dans le délai : accepté');
    await updateJournalNote(journal, n => ({ ...n, renf: { at: nowS() - GRACE_S - 60 } }));
    assert.equal(renfState(receivedJournals(await readSchema())[0].note, nowS()), 'expired');
    await deliver([['a2', 200, false, { Nom: 'Apres' }]]);
    await consolidateAll({ reread: true });
    assert.deepEqual(got(), ['Avant'], 'passé le délai : refusé');
  });

  await t.test('revenir à l\'ancien fonctionnement : la clé s\'efface et l\'ancien envoi est accepté tel quel', async () => {
    const note = await revertReinforcement(journal);
    assert.ok(!note.pub && !note.pubSource && !note.sceau && !note.renf);
    assert.equal(receivedKey(await readSchema(), journal, note), '', 'plus de clé dans les destinations');
    assert.equal(renfState(note, nowS()), 'none');
    await deliver([['a3', 300, false, { Nom: 'Revenu' }]]);
    await consolidateAll({ reread: true });
    assert.ok(got().includes('Revenu'), 'l\'ancien envoi arrive de nouveau');
    await assert.rejects(revertReinforcement(journal), /revertNone/, 'rien à défaire une seconde fois');
    await assert.rejects(receptionReply({ journal, note }, local.link), /codeOld/, 'pas de réponse à renvoyer : il faut une nouvelle invitation');
  });
});
