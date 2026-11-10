// Canal entre onglets (js/tab-link.js) : le contrôle des messages, puis le parcours invitation, vue, réponse, reçue
// entre deux « onglets » (deux canaux de même nom dans un seul processus). Rien d'autre qu'un transport de texte :
// ce que le moteur juge d'un code (document, code de contrôle, péremption) est essayé dans engine-links.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReply } from '../../js/engine/logic/codes.js';
import { createLink, parseMessage } from '../../js/tab-link.js';
import { ID, PUB, forge, invitation } from './fixtures.mjs';

const url = 'https://g.fr/o/eq/api/s/Xyz789/tables/Journal_Annuaire/records?flat=1';
const reply = (id = ID) => buildReply({ pub: PUB, id, recipient: { email: 'b@c.fr', docId: 'doc2' }, url });
const offer = fields => ({ app: 'gristsync', k: 'offer', code: invitation(fields) });
const pause = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

test('un message ne passe que s\'il est exactement de l\'un des six genres, avec ce qu\'il doit porter', () => {
  const parsed = parseMessage(offer({ from: { docName: 'Budget', docId: 'doc1' } }));
  assert.deepEqual([parsed.k, parsed.id, parsed.name, parsed.docName, parsed.docId], ['offer', ID, 'Annuaire', 'Budget', 'doc1']);
  assert.equal(parsed.code, invitation({ from: { docName: 'Budget', docId: 'doc1' } }));
  assert.deepEqual(parseMessage({ app: 'gristsync', k: 'want' }), { k: 'want' });
  for (const k of ['seen', 'wantReply', 'got']) assert.deepEqual(parseMessage({ app: 'gristsync', k, id: ID }), { k, id: ID });
  assert.equal(parseMessage({ app: 'gristsync', k: 'reply', code: reply() }).id, ID);
  for (const bad of [null, 'offer', 42, [], {}, { k: 'want' }, { app: 'autre', k: 'want' }, { app: 'gristsync', k: 'inconnu' },
    { app: 'gristsync', k: 'seen' }, { app: 'gristsync', k: 'seen', id: 'xyz' }, { app: 'gristsync', k: 'got', id: ID.toUpperCase() },
    { app: 'gristsync', k: 'offer' }, { app: 'gristsync', k: 'offer', code: 42 }, { app: 'gristsync', k: 'offer', code: 'GRISTSYNC2.pas-du-json' },
    { app: 'gristsync', k: 'offer', code: 'rien' }, { app: 'gristsync', k: 'offer', code: `GRISTSYNC2.${'A'.repeat(500000)}` }]) {
    assert.equal(parseMessage(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('une invitation n\'est pas une réponse, ni l\'inverse, et l\'identifiant doit avoir la forme d\'un identifiant', () => {
  assert.equal(parseMessage({ app: 'gristsync', k: 'reply', code: invitation() }), null, 'une invitation proposée comme réponse');
  assert.equal(parseMessage({ app: 'gristsync', k: 'offer', code: reply() }), null, 'une réponse proposée comme invitation');
  assert.equal(parseMessage({ app: 'gristsync', k: 'offer', code: forge({ kind: 'invitation', id: '<script>', export: 'a' }) }), null);
  assert.equal(parseMessage({ app: 'gristsync', k: 'offer', code: forge({ kind: 'invitation', id: ID, f: 99, v: '9.9.9' }) }).id, ID,
    'un code d\'une version plus récente passe : le moteur dira laquelle quand la personne s\'en servira');
});

test('ce que le code dit de lui est nettoyé avant d\'être montré, et les blancs d\'un code coupé sont ôtés', () => {
  const sneaky = parseMessage(offer({ name: 'A‮B\u0007C', from: { docName: ' Un   \n nom​' } }));
  assert.equal(sneaky.name, 'A B C', 'ni sens d\'écriture ni caractère de contrôle');
  assert.equal(sneaky.docName, 'Un nom');
  const code = invitation();
  const cut = parseMessage({ app: 'gristsync', k: 'offer', code: `  ${code.slice(0, 40)}\n${code.slice(40)}  ` });
  assert.equal(cut.id, ID);
  assert.equal(cut.code, `${code.slice(0, 40)}\n${code.slice(40)}`.trim(), 'le code est rendu tel quel (le moteur retire les blancs)');
});

test('le canal : invitation proposée, vue, réponse rendue, reçue ; chacun ne dit que ce qu\'on lui demande', async () => {
  const source = createLink('essai-parcours');
  const target = createLink('essai-parcours');
  const seen = [];
  const got = [];
  const offers = [];
  const replies = [];
  let sourceShown = true;
  let targetShown = true;
  try {
    // La CIBLE est déjà à l'écoute quand la SOURCE propose.
    target.watchOffers((o) => { offers.push(o); return true; }, { alive: () => targetShown });
    await pause();
    const code = invitation({ from: { docName: 'Budget' } });
    source.offerInvitation(code, { alive: () => sourceShown, onSeen: () => seen.push('vue') });
    await pause();
    assert.deepEqual(offers.map(o => [o.id, o.docName, o.code]), [[ID, 'Budget', code]]);
    assert.deepEqual(seen, ['vue'], 'la SOURCE apprend que la CIBLE l\'a montrée');

    // La SOURCE attend la réponse ; la CIBLE la rend ; chacune apprend que l'autre l'a eue.
    source.awaitReply(ID, c => replies.push(c), { alive: () => sourceShown });
    await pause();
    const answer = reply();
    target.sendReply(answer, { alive: () => targetShown, onGot: () => got.push('reçue') });
    await pause();
    assert.deepEqual(replies, [answer]);
    assert.deepEqual(got, ['reçue']);

    // Une réponse à une autre invitation n'est pas pour cette SOURCE.
    target.sendReply(reply('aaaaaaaaaaaaaaaa'), { alive: () => targetShown });
    await pause();
    assert.deepEqual(replies, [answer], 'seule la réponse à son invitation arrive');
  } finally {
    sourceShown = false; targetShown = false;
    source.close(); target.close();
  }
});

test('un onglet ouvert après coup demande ce qui a été dit avant lui ; un écran qui n\'est plus affiché se tait', async () => {
  const source = createLink('essai-apres');
  const late = createLink('essai-apres');
  const offers = [];
  let shown = true;
  try {
    const code = invitation();
    source.offerInvitation(code, { alive: () => shown });
    await pause();
    late.watchOffers((o) => { offers.push(o.id); return false; });
    await pause();
    assert.deepEqual(offers, [ID], 'la CIBLE ouverte plus tard reçoit l\'invitation que la SOURCE redit');
    shown = false; // l'assistant de la SOURCE est fermé : plus rien ne se redit
    offers.length = 0;
    late.watchOffers((o) => { offers.push(o.id); return false; });
    await pause();
    assert.deepEqual(offers, [], 'une SOURCE qui n\'est plus à l\'écran ne répond plus');
  } finally {
    source.close(); late.close();
  }
});

test('la réponse prête avant que la SOURCE ne l\'attende lui est redite à sa demande', async () => {
  const source = createLink('essai-reponse');
  const target = createLink('essai-reponse');
  const replies = [];
  try {
    const answer = reply();
    target.sendReply(answer); // personne n'écoute encore
    await pause();
    source.awaitReply(ID, c => replies.push(c));
    await pause();
    assert.deepEqual(replies, [answer]);
  } finally {
    source.close(); target.close();
  }
});

test('une CIBLE qui ne montre pas l\'invitation (lecture seule, même document) ne dit pas qu\'elle l\'a vue', async () => {
  const source = createLink('essai-silence');
  const target = createLink('essai-silence');
  const seen = [];
  try {
    target.watchOffers(() => false);
    source.offerInvitation(invitation(), { onSeen: () => seen.push('vue') });
    await pause();
    assert.deepEqual(seen, []);
  } finally {
    source.close(); target.close();
  }
});

test('un code qui n\'est pas du bon genre n\'est jamais proposé, et sans canal (BroadcastChannel absent) rien ne casse', () => {
  const link = createLink('essai-genre');
  try {
    assert.equal(link.offerInvitation('GRISTSYNC2.xx'), null);
    assert.equal(link.offerInvitation(reply()), null, 'une réponse n\'est pas une invitation');
    assert.equal(link.sendReply(invitation()), null, 'une invitation n\'est pas une réponse');
    assert.equal(link.awaitReply('pas-un-identifiant', () => {}), null);
  } finally {
    link.close();
  }
  const real = globalThis.BroadcastChannel;
  delete globalThis.BroadcastChannel;
  try {
    const none = createLink('essai-absent');
    assert.equal(none.supported(), false);
    assert.equal(none.offerInvitation(invitation()), null);
    assert.equal(none.watchOffers(() => true), null);
    assert.equal(none.sendReply(reply()), null);
    assert.equal(none.awaitReply(ID, () => {}), null);
    none.close();
  } finally {
    globalThis.BroadcastChannel = real;
  }
});
