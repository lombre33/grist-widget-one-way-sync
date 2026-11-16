// Lien public de Grist vu de l'onglet Envoyer : relecture, lien coupé mais partage resté ouvert (voir js/source/public-stay.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessMoved, clearStay, forgettable, isOpen, lingering, markStay, staysPublic, waitsForAccess, watchesAccess } from '../../js/source/public-stay.js';

const base = { exports: [], invitations: [], pauses: [] };
const stopped = { ...base, publicCoupe: true };
const pub = { id: 'a', public: true };
const mail = { id: 'b', public: false };

test('le partage public de Grist est ouvert en lecture ou en édition, fermé s\'il est vide, inconnu si null', () => {
  assert.equal(isOpen('viewers'), true);
  assert.equal(isOpen('editors'), true);
  assert.equal(isOpen(''), false);
  assert.equal(isOpen(null), false);
  assert.equal(isOpen(undefined), false);
});

test('la note retient un lien coupé, une seule fois, sans toucher à la note reçue', () => {
  assert.equal(staysPublic(base), false);
  const marked = markStay(base);
  assert.equal(staysPublic(marked), true);
  assert.equal('publicCoupe' in base, false, 'la note d\'avant est intacte');
  assert.equal(markStay(marked), marked, 'déjà retenu : même note, rien à écrire');
  const cleared = clearStay(marked);
  assert.equal(staysPublic(cleared), false);
  assert.equal('publicCoupe' in cleared, false);
  assert.deepEqual(cleared, base, 'le reste de la note est gardé');
  assert.equal(clearStay(base), base, 'rien à effacer : même note');
  assert.equal(staysPublic({ ...base, publicCoupe: 'oui' }), false, 'une note retouchée à la main n\'est pas crue');
  assert.equal(staysPublic(null), false);
});

test('l\'avis orange : lien coupé, plus aucun export public, partage encore ouvert dans Grist', () => {
  assert.equal(lingering({ note: stopped, exports: [mail], access: 'viewers' }), true);
  assert.equal(lingering({ note: stopped, exports: [], access: 'editors' }), true, 'réglé sur Éditeur : encore ouvert');
  assert.equal(lingering({ note: stopped, exports: [mail], access: '' }), false, 'fermé dans Grist : plus rien à dire');
  assert.equal(lingering({ note: stopped, exports: [mail], access: null }), false, 'Grist ne répond pas : rien ne s\'affiche');
  assert.equal(lingering({ note: stopped, exports: [mail, pub], access: 'viewers' }), false, 'un export public existe de nouveau : le lien sert');
  assert.equal(lingering({ note: base, exports: [mail], access: 'viewers' }), false, 'un document public pour une autre raison n\'est pas signalé');
});

test('la note du lien coupé s\'efface seulement quand Grist dit le lien fermé', () => {
  assert.equal(forgettable({ note: stopped, access: '' }), true);
  assert.equal(forgettable({ note: stopped, access: null }), false, 'réponse inconnue : on garde');
  assert.equal(forgettable({ note: stopped, access: 'viewers' }), false);
  assert.equal(forgettable({ note: base, access: '' }), false);
});

test('l\'écran relit le droit du lien public seulement quand il en dépend', () => {
  assert.equal(watchesAccess({ note: base, exports: [mail], access: '' }), false, 'un document sans lien public : aucune lecture de plus');
  assert.equal(watchesAccess({ note: base, exports: [mail], access: 'viewers' }), false, 'public pour une autre raison, aucun export public');
  assert.equal(watchesAccess({ note: base, exports: [mail, pub], access: '' }), true, 'pastille « à activer »');
  assert.equal(watchesAccess({ note: base, exports: [pub], access: 'viewers' }), true, 'pastille « Public »');
  assert.equal(watchesAccess({ note: stopped, exports: [mail], access: '' }), true, 'note du lien coupé à effacer');
  assert.equal(watchesAccess({ note: base, exports: [], access: 'editors' }), true, 'bannière « réglé sur Éditeur »');
});

test('un changement du droit se voit, une réponse inconnue ne change rien', () => {
  assert.equal(accessMoved('', 'viewers'), true, 'lien activé dans Partager');
  assert.equal(accessMoved('viewers', ''), true, 'lien fermé');
  assert.equal(accessMoved('viewers', 'editors'), true);
  assert.equal(accessMoved('viewers', 'viewers'), false);
  assert.equal(accessMoved('', null), false);
  assert.equal(accessMoved('viewers', undefined), false);
  assert.equal(accessMoved(null, 'viewers'), true, 'le premier dessin n\'avait pas de réponse');
});

test('relecture rapprochée quand la personne règle le lien dans Grist', () => {
  assert.equal(waitsForAccess({ note: base, exports: [pub], access: '' }), true, 'export public qui attend d\'être activé');
  assert.equal(waitsForAccess({ note: base, exports: [pub], access: 'viewers' }), false, 'activé : au repos');
  assert.equal(waitsForAccess({ note: stopped, exports: [mail], access: 'viewers' }), true, 'avis du lien resté ouvert : on attend la fermeture ou la confirmation');
  assert.equal(waitsForAccess({ note: base, exports: [mail], access: '' }), false);
});
