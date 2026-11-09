// Le moteur joue seul un envoi de bout en bout, sans écran ni Grist : une SOURCE crée un export et une
// invitation, une CIBLE la lit, crée sa réception et répond, la SOURCE contrôle la réponse et branche le
// webhook, puis un lot signé arrive dans le journal et la CIBLE le recopie. Deux documents en mémoire sur la
// même instance (tests/unit/engine-fake.mjs), un seul port à la fois (le moteur n'en a qu'un : on passe de
// l'un à l'autre avec startEngine, comme le ferait un hôte qui sert deux documents).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KEY_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { signText } from '../../js/engine/logic/trust.js';
import { readSchema } from '../../js/engine/port.js';
import { readSourceNote, syncRows } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, loadPlan, renewInvitation, startInvitation } from '../../js/engine/source/invite.js';
import { canRelink, checkDestinations, createReception, knownReception, readInvitation, receptionReply, relinkReception } from '../../js/engine/target/receive.js';
import { consolidateAll } from '../../js/engine/target/loop.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { diagnostic } from '../../js/engine/diagnostic.js';
import { format } from '../../js/i18n.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

const world = fakeWorld();
const source = fakeDoc({ docId: 'sourcedoc0001x', name: 'Annuaire de la source', email: 'source@fake.local' });
const target = fakeDoc({ docId: 'targetdoc0002x', name: 'Réception', email: 'cible@fake.local' });
const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });

source.addTable('Contacts', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], [{ Nom: 'Alice', Ville: 'Lyon' }, { Nom: 'Bob', Ville: 'Nice' }]);

// Ce que le scénario garde d'une étape à l'autre.
const story = {};

test('SOURCE puis CIBLE : un envoi de bout en bout, sans écran', async (t) => {
  await t.test('SOURCE : un export est créé, ses tables sont prêtes', async () => {
    as(source);
    const saved = await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom', 'Ville'], filter: null }] });
    story.exp = saved.created;
    assert.equal(saved.name, 'Annuaire');
    assert.equal(saved.created.recipients.length, 0);
    assert.deepEqual(saved.tables.map(tb => [tb.table, tb.columns.map(c => c.id)]), [['Contacts', ['Nom', 'Ville']]]);
    assert.ok(source.has('Synchro'), 'la seule table technique de la SOURCE');
    assert.deepEqual([...source.tables.keys()].sort(), ['Contacts', 'Synchro']);
    assert.ok(readSourceNote(await readSchema()).exports.some(e => e.id === saved.id && e.name === 'Annuaire'));
    assert.ok(source.rows('Contacts').every(r => r.id_sync), 'chaque ligne a sa clé');
  });

  await t.test('SOURCE : une invitation, son code, ce que l\'existant coûterait', async () => {
    const { entry, secret } = await startInvitation(story.exp);
    story.entry = entry;
    const { code, expire, backCode } = await invitationCode(story.exp, entry, secret);
    story.code = code;
    assert.match(code, /^GRISTSYNC2\./);
    assert.ok(expire > Date.now() / 1000, 'valable encore');
    assert.equal(backCode, null, 'pas d\'Échange : pas de code de retour');
    assert.ok(readSourceNote(await readSchema()).invitations.some(i => i.id === entry.id), 'l\'invitation attend sa réponse dans la note');
    const plan = await loadPlan(story.exp);
    assert.equal(plan.total, 2);
    assert.equal(plan.count, 2);
  });

  await t.test('CIBLE : l\'invitation est lue, la réception est créée', async () => {
    as(target);
    const invitation = await readInvitation(story.code);
    assert.equal(invitation.name, 'Annuaire');
    assert.equal(invitation.from.docId, source.docId);
    assert.equal(invitation.version, '9.9.9', 'la version de l\'application est dans le code');
    assert.equal(await knownReception(invitation), null);
    const plans = invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' }));
    const { existing } = await checkDestinations(invitation, plans);
    assert.deepEqual(existing, []);
    const made = await createReception(invitation, plans, { reserve: true, options: {} });
    story.invitation = invitation;
    story.made = made;
    assert.equal(made.journal, 'Journal_Annuaire');
    assert.deepEqual(made.created, ['Annuaire_recu']);
    assert.ok(target.has('Annuaire_recu') && target.has('Journal_Annuaire'));
    assert.deepEqual(receivedJournals(await readSchema()).map(r => r.journal), ['Journal_Annuaire']);
    assert.ok(target.fetchRows('_grist_Pages').length === 1, 'un formulaire publié sur sa propre page');
  });

  await t.test('CIBLE : le lien du formulaire est vérifié, la réponse est produite', async () => {
    story.link = world.formLink(target, story.made.journal);
    const { code, control } = await receptionReply(story.made, story.link);
    story.reply = code;
    assert.match(code, /^GRISTSYNC2\./);
    assert.match(control, /^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    await assert.rejects(receptionReply(story.made, 'https://fake.example/o/equipe/pas-un-formulaire'), /formLink/);
    // Le lien d'un autre formulaire ne peut pas écrire dans ce journal : refusé, sinon la réponse enverrait les données ailleurs.
    const other = world.formLink(source, 'Contacts');
    await assert.rejects(receptionReply(story.made, other), e => ['linkTest', 'linkElsewhere'].includes(e.message));
    story.control = control;
  });

  await t.test('SOURCE : la réponse est contrôlée chez Grist, le webhook est branché', async () => {
    as(source);
    await assert.rejects(checkReply(story.exp, story.entry, 'GRISTSYNC2.pasuncode'), /.+/);
    const reply = await checkReply(story.exp, story.entry, story.reply);
    story.accepted = reply;
    assert.equal(reply.share.docId, target.docId, 'le document est dit par Grist, pas par le code');
    assert.equal(reply.code, story.control, 'le même code de contrôle des deux côtés');
    assert.equal(reply.tables, 'Contacts');
    const hook = await approveReply(story.exp, story.entry, reply);
    const hooks = world.webhooks(source);
    assert.deepEqual(hooks.map(h => h.id), [hook]);
    assert.equal(hooks[0].fields.tableId, 'Synchro');
    assert.equal(hooks[0].fields.url, reply.url);
    assert.ok(hooks[0].fields.condition.includes(story.exp.id), 'filtré sur cet export');
    assert.deepEqual(readSourceNote(await readSchema()).invitations, [], 'l\'invitation est consommée');
    assert.ok((await syncRows()).some(r => r.Synchro_Type === 'signature'), 'la clé de ce destinataire est gardée');
  });

  await t.test('CIBLE : un lot signé arrive dans le journal et est recopié', async () => {
    const lotRow = (await syncRows()).find(r => r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Contacts');
    assert.ok(lotRow, 'la SOURCE a une ligne de lot pour la table');
    const send = async (key, lines) => {
      const row = { [EXPORT_COL]: story.exp.id, [TABLE_COL]: 'Contacts', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: lotRow[SCHEMA_COL] };
      world.deliver(story.accepted.url, [{ ...row, [LOT_COL]: await signText(key, row, JSON.stringify({ lignes: lines, total: lines.length })) }]);
    };
    await send(story.accepted.keys.down, [['k1', 100, false, { Nom: 'Alice', Ville: 'Lyon' }], ['k2', 100, false, { Nom: 'Bob', Ville: 'Nice' }]]);
    as(target);
    await consolidateAll();
    const names = () => target.rows('Annuaire_recu').filter(r => r.Supprime !== true).map(r => `${r[KEY_COL]}:${r.Nom}:${r.Ville}`).sort();
    assert.deepEqual(names(), ['k1:Alice:Lyon', 'k2:Bob:Nice']);

    // Un lot signé avec une autre clé (celle d'un autre destinataire, ou inventée) n'est pas recopié.
    await send('0'.repeat(64), [['k9', 200, false, { Nom: 'Intrus', Ville: 'Ailleurs' }]]);
    await consolidateAll({ reread: true });
    assert.deepEqual(names(), ['k1:Alice:Lyon', 'k2:Bob:Nice'], 'le lot mal signé est rejeté');
    assert.deepEqual(target.rows('Journal_Annuaire').filter(r => r[TYPE_COL] === KIND.lot), [], 'et il ne reste pas dans le journal');

    // Une version plus récente, bien signée : la destination suit.
    target.tick();
    await send(story.accepted.keys.down, [['k1', 300, false, { Nom: 'Alice', Ville: 'Paris' }]]);
    await consolidateAll({ reread: true });
    assert.deepEqual(names(), ['k1:Alice:Paris', 'k2:Bob:Nice']);
  });

  await t.test('CIBLE : une nouvelle invitation du même document reprend la même réception', async () => {
    as(source);
    const second = await startInvitation(story.exp);
    const { code } = await invitationCode(story.exp, second.entry, second.secret);
    as(target);
    const invitation = await readInvitation(code);
    const known = await knownReception(invitation);
    assert.equal(known.journal, 'Journal_Annuaire');
    assert.ok(canRelink(known, invitation));
    const before = known.note.pub;
    const { journal, note } = await relinkReception(known, invitation);
    assert.equal(journal, 'Journal_Annuaire');
    assert.equal(note.id, invitation.id, 'la réception suit la nouvelle invitation');
    assert.notEqual(note.pub, before, 'de nouvelles clés sont tirées');
    assert.equal(receivedJournals(await readSchema()).length, 1, 'aucune seconde réception');
    // D'un autre document : refusée.
    assert.equal(canRelink(known, { ...invitation, from: { ...invitation.from, docId: 'otherdoc00003' } }), false);
    assert.equal(canRelink(known, { ...invitation, mode: 'public' }), false);
  });

  await t.test('SOURCE : une invitation se refait, avec un autre secret', async () => {
    as(source);
    const note = readSourceNote(await readSchema());
    const pending = note.invitations[0];
    const renewed = await renewInvitation(pending);
    assert.ok(renewed.secret && renewed.entry.hash !== pending.hash);
    assert.equal(renewed.entry.id, pending.id);
    assert.equal(await renewInvitation({ ...pending, journal: 'Journal_Retour' }), null, 'un Échange se refait par son lien de retour');
  });

  await t.test('SOURCE puis CIBLE : le diagnostic se lit sans écran, dans les deux langues, sans adresse ni clé', async () => {
    const withText = (doc, lang) => startEngine({ port: { ...world.port(doc), text: (key, values) => format(lang, key, values) }, version: '9.9.9' });
    const key = new URL(story.accepted.url).pathname.split('/')[5];
    const leaks = ['source@fake.local', 'cible@fake.local', key, story.exp.id, story.entry.id, 'sourcedoc0001x', 'targetdoc0002x'];
    withText(source, 'fr');
    const sent = await diagnostic({ version: '9.9.9', served: 'essai', readOnly: false, agent: 'Node' });
    assert.match(sent, /^Diagnostic Synchro Grist 9\.9\.9 \(essai\)/);
    assert.match(sent, /Instance : https:\/\/fake\.example/);
    assert.match(sent, /Droits : propriétaire/);
    assert.match(sent, new RegExp(`Export ${story.exp.id.slice(0, 8)} « Annuaire » \\(sens unique\\)`));
    assert.match(sent, /tables : Contacts \(2 col\.\)/);
    assert.match(sent, /destinataire [0-9a-z-]+ : actif/);
    withText(target, 'en');
    const received = await diagnostic({ version: '9.9.9', served: 'essai', readOnly: true, agent: 'Node' });
    assert.match(received, /^Synchro Grist diagnostic 9\.9\.9 \(essai\)/);
    assert.match(received, /Access: reader/);
    assert.match(received, /Reception Journal_Annuaire \(export /);
    assert.match(received, /tables: Contacts → Annuaire_recu/);
    for (const text of [sent, received]) for (const secret of leaks) assert.ok(!text.includes(secret), `le diagnostic ne dit pas ${secret}`);
    for (const french of ['Droits', 'Navigateur', 'Aucune']) assert.ok(!received.includes(french), french);
  });
});
