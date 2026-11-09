// Le contrôle des webhooks (js/engine/source/hook-check.js) : à quel document chaque destinataire est-il
// vraiment branché ? Le port est celui du Grist en mémoire, dont `shareInfo` est remplacé pour dire ce
// que chaque clé de formulaire désigne ; la montre est simulée pour la revérification horaire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { checkHooks, hookCheck, personLabel } from '../../js/engine/source/hook-check.js';
import { fakeDoc, fakePort } from './engine-fake.mjs';

const link = (key, { origin = 'https://fake.example', flat = true } = {}) => `${origin}/o/equipe/api/s/${key}/tables/Journal/records${flat ? '?flat=1' : ''}`;
const hook = (id, key, memo = 'cible@fake.local · targetdoc0002x · equipe/Réception', options) => ({ id, fields: { url: link(key, options), memo } });

const asked = [];
let designated = {}; // clé -> fiche du document que désigne la clé, ou erreur à lever
const doc = fakeDoc({ docId: 'sourcedoc0001x' });
startEngine({ port: { ...fakePort(doc), shareInfo: async (url) => {
  const key = new URL(url).pathname.split('/')[5];
  asked.push(key);
  const answer = designated[key];
  if (answer instanceof Error) throw answer;
  return answer ?? null;
} } });

let now = 1_700_000_000_000;
Date.now = () => now;

test('un destinataire branché sur le document de sa fiche : le nom vu chez Grist complète la fiche', async () => {
  designated = { K1: { docId: 'targetdoc0002x', name: 'Réception renommée' } };
  const h = hook('w1', 'K1');
  assert.deepEqual(hookCheck('w1'), {}, 'rien avant le premier contrôle');
  assert.equal(await checkHooks([h]), true, 'la fiche a changé (le document a été renommé)');
  assert.deepEqual([hookCheck('w1').other, hookCheck('w1').bad, hookCheck('w1').docName], ['', false, 'Réception renommée']);
  assert.match(personLabel(h), /equipe\/Réception renommée/);
});

test('un contrôle par heure : un second affichage ne redemande rien, une heure plus tard si', async () => {
  const h = hook('w1', 'K1');
  asked.length = 0;
  assert.equal(await checkHooks([h]), false);
  assert.deepEqual(asked, []);
  now += 3600001;
  assert.equal(await checkHooks([h]), false, 'même résultat : rien à redessiner');
  assert.deepEqual(asked, ['K1']);
});

test('la clé désigne un autre document que la fiche : signalé avec son nom', async () => {
  designated = { K2: { docId: 'intrusdoc0003x', name: 'Autre document' } };
  const h = hook('w2', 'K2');
  assert.equal(await checkHooks([h]), true);
  assert.equal(hookCheck('w2').other, 'Autre document');
  assert.equal(hookCheck('w2').docName, '', 'le nom d\'un autre document ne complète pas la fiche');
});

test('une adresse qui n\'est pas celle d\'un formulaire de cette instance : signalée sans rien demander', async () => {
  asked.length = 0;
  const elsewhere = hook('w3', 'K3', undefined, { origin: 'https://ailleurs.example' });
  const notFlat = hook('w4', 'K4', undefined, { flat: false });
  assert.equal(await checkHooks([elsewhere, notFlat]), true);
  assert.equal(hookCheck('w3').bad, true);
  assert.equal(hookCheck('w4').bad, true);
  assert.deepEqual(asked, [], 'aucune requête partie');
});

test('Grist ne répond pas : rien n\'est noté, le prochain affichage réessaie ; une adresse changée est revérifiée', async () => {
  designated = { K5: new Error('réseau muet') };
  const h = hook('w5', 'K5');
  asked.length = 0;
  assert.equal(await checkHooks([h]), false);
  assert.deepEqual(hookCheck('w5'), {});
  designated = { K5: { docId: 'targetdoc0002x', name: 'Réception' }, K6: { docId: 'targetdoc0002x', name: 'Réception' } };
  await checkHooks([h]);
  assert.equal(hookCheck('w5').bad, false);
  assert.deepEqual(asked, ['K5', 'K5'], 'la panne n\'a rien retenu');
  asked.length = 0;
  await checkHooks([hook('w5', 'K6')]);
  assert.deepEqual(asked, ['K6'], 'l\'adresse a changé : contrôlée sans attendre l\'heure');
});

test('une clé qui n\'existe plus (lien coupé) est sans document : ni autre document, ni mauvaise adresse', async () => {
  designated = {};
  const h = hook('w6', 'K7');
  await checkHooks([h]);
  assert.deepEqual([hookCheck('w6').other, hookCheck('w6').bad], ['', false]);
});
