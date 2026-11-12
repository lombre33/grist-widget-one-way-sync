// Le mémo d'un webhook se lit dans les métadonnées du document (`_grist_Triggers`), que Grist montre à toute personne qui
// lit le document, lien public compris. Il ne porte donc qu'un jeton ; la fiche du destinataire (e-mail, document, équipe,
// nom) est dans la note de la SOURCE, que les lecteurs ne lisent pas, et remise dans les webhooks que lit le widget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { readSchema } from '../../js/engine/port.js';
import { protectMemos, readHooks, readSourceNote, rememberDest, updateSourceNote } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { dropDest, identifyHooks, isMemoToken, putDest, staleDest } from '../../js/engine/logic/notes.js';
import { hookLabel, memoDoc } from '../../js/engine/logic/exports.js';
import { deleteWebhook } from '../../js/engine/port.js';
import { fakePair } from './engine-fake.mjs';

// Une SOURCE qui a un destinataire (webhook branché), et la CIBLE qui reçoit.
async function wired() {
  const { world, source, target } = fakePair('mm');
  const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });
  as(source);
  const { created: exp } = await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom'], filter: null }] });
  const { entry, secret } = await startInvitation(exp);
  const { code } = await invitationCode(exp, entry, secret);
  as(target);
  const invitation = await readInvitation(code);
  const made = await createReception(invitation, invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' })), { reserve: true, options: {} });
  const { code: reply } = await receptionReply(made, world.formLink(target, made.journal));
  as(source);
  const accepted = await checkReply(exp, entry, reply);
  const hook = await approveReply(exp, entry, accepted);
  return { world, source, target, as, exp, hook };
}

const FICHE = /cible@fake\.local|targetdoc/;

test('le mémo du webhook ne dit rien du destinataire, sa fiche est dans la note', async () => {
  const { world, source, exp } = await wired();
  const [raw] = world.webhooks(source);
  assert.ok(isMemoToken(raw.fields.memo), `jeton attendu : ${raw.fields.memo}`);
  assert.doesNotMatch(raw.fields.memo, FICHE);
  assert.doesNotMatch(JSON.stringify(source.fetchRows('_grist_Triggers')), FICHE, 'rien dans les métadonnées que Grist montre aux lecteurs');
  const note = readSourceNote(await readSchema());
  assert.match(note.dest[raw.fields.memo].m, /cible@fake\.local · targetdoc/);
  // Ce que lit le widget : la fiche d'avant, dans le même format.
  const { hooks, of } = await readHooks();
  assert.equal(of(exp.id).length, 1, 'rangé sous son export');
  assert.match(hooks[0].fields.memo, /^cible@fake\.local · targetdoc/);
  assert.equal(memoDoc(hooks[0].fields.memo).email, 'cible@fake.local');
  assert.equal(hooks[0].fields.memoToken, raw.fields.memo);
});

test('un webhook d\'avant (mémo = fiche) prend un jeton, une fois, sans rien perdre', async () => {
  const { world, source, hook } = await wired();
  const card = 'ancien@fake.local · olddoc1234567 · equipe/Ancien';
  world.hooksOf(source).patch(hook, { memo: card }); // ce qu'écrivait une version d'avant
  assert.equal(await protectMemos(), true);
  const [raw] = world.webhooks(source);
  assert.ok(isMemoToken(raw.fields.memo));
  assert.doesNotMatch(JSON.stringify(source.fetchRows('_grist_Triggers')), /ancien@fake/);
  const [seen] = (await readHooks()).hooks;
  assert.equal(seen.fields.memo, card, 'la fiche complète est toujours là');
  assert.equal(hookLabel(seen.fields.memo), card);
  assert.equal(await protectMemos(), false, 'rien de plus à faire');
  assert.equal(world.webhooks(source)[0].fields.memo, raw.fields.memo, 'le jeton ne change plus');
});

test('la fiche d\'un destinataire révoqué quitte la note, après le délai', async () => {
  const { world, source, hook } = await wired();
  const token = world.webhooks(source)[0].fields.memo;
  await deleteWebhook(hook);
  assert.equal(world.webhooks(source).length, 0);
  await protectMemos();
  assert.ok(readSourceNote(await readSchema()).dest[token], 'récente : gardée le temps qu\'un onglet crée son webhook');
  // Une fiche posée il y a plus de dix minutes, sans webhook, est retirée.
  await updateSourceNote(note => putDest(note, 'r-aaaaaaaaaaaa', 'vieux@fake.local · x', 1));
  await protectMemos();
  const left = readSourceNote(await readSchema()).dest || {};
  assert.equal(left['r-aaaaaaaaaaaa'], undefined, 'ancienne et sans webhook : retirée');
  assert.ok(left[token], 'la récente reste');
});

test('rememberDest : le jeton est neuf à chaque fois et sa fiche se relit', async () => {
  const { source } = await wired();
  const a = await rememberDest('a@fake.local · docA12345678');
  const b = await rememberDest('b@fake.local · docB12345678');
  assert.notEqual(a, b);
  assert.ok(isMemoToken(a));
  const note = readSourceNote(await readSchema());
  assert.equal(note.dest[a].m, 'a@fake.local · docA12345678');
  assert.equal(source.fetchRows('_grist_Triggers').length, 0, 'aucun webhook : rien dans les métadonnées');
});

test('identifyHooks, staleDest, dropDest : cas limites', () => {
  const hook = memo => ({ id: 1, fields: { memo, name: 'n' } });
  const note = putDest({ exports: [] }, 'r-0123456789ab', 'x@y.fr · doc', 100);
  assert.equal(identifyHooks([hook('r-0123456789ab')], note)[0].fields.memo, 'x@y.fr · doc');
  assert.equal(identifyHooks([hook('r-ffffffffffff')], note)[0].fields.memo, 'r-ffffffffffff', 'jeton inconnu : rendu tel quel');
  assert.equal(identifyHooks([hook('texte libre')], note)[0].fields.memo, 'texte libre', 'ancien mémo : tel quel');
  assert.equal(identifyHooks([hook('__proto__')], note)[0].fields.memo, '__proto__', 'jamais une clé du prototype');
  assert.equal(identifyHooks([hook('r-0123456789ab')], { exports: [] })[0].fields.memo, 'r-0123456789ab', 'note sans fiches');
  assert.deepEqual(staleDest(note, new Set(), 100 + 599, 600), [], 'dans le délai');
  assert.deepEqual(staleDest(note, new Set(), 100 + 600, 600), ['r-0123456789ab'], 'passé le délai');
  assert.deepEqual(staleDest(note, new Set(['r-0123456789ab']), 99999, 600), [], 'un webhook le porte');
  assert.deepEqual(dropDest(note, ['r-0123456789ab']), { exports: [] }, 'la dernière fiche emporte la clé `dest`');
  assert.equal(dropDest(note, []), note);
  // Une entrée abîmée (note retouchée à la main) ne casse rien.
  assert.equal(identifyHooks([hook('r-0123456789ab')], { dest: { 'r-0123456789ab': 5 } })[0].fields.memo, 'r-0123456789ab');
});
