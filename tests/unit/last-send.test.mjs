// Dernier envoi ordinaire d'un export, d'après l'état d'envoi que Grist donne aux webhooks (voir js/source/last-send.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastSend } from '../../js/source/last-send.js';

const hook = (id, lastSuccessTime, extra = {}) => ({ id, fields: { enabled: true }, usage: lastSuccessTime === undefined ? undefined : { lastSuccessTime, ...extra } });

test('aucun destinataire, aucun envoi réussi : rien à dire', () => {
  assert.equal(lastSend([]), null);
  assert.equal(lastSend(undefined), null);
  assert.equal(lastSend([hook(1)]), null, 'webhook sans état d\'envoi');
  assert.equal(lastSend([hook(1, null), hook(2, 0)]), null, 'aucun envoi réussi (null, 0)');
});

test('un destinataire : l\'heure de son dernier envoi réussi', () => {
  const last = lastSend([hook(7, 1760000000000)]);
  assert.equal(last.at, 1760000000000);
  assert.equal(last.hook.id, 7);
  assert.equal(last.n, 1);
  assert.equal(last.of, 1);
});

test('plusieurs destinataires : le plus récent, et combien en ont reçu un', () => {
  const last = lastSend([hook(1, 1760000000000), hook(2, 1760000500000), hook(3), hook(4, 1759999000000, { numWaiting: 2 })]);
  assert.equal(last.at, 1760000500000);
  assert.equal(last.hook.id, 2);
  assert.equal(last.n, 3, 'trois destinataires ont un envoi réussi');
  assert.equal(last.of, 4, 'sur quatre');
});

test('un destinataire en pause garde son heure tant que Grist la donne ; une valeur absurde ne compte pas', () => {
  const paused = { id: 5, fields: { enabled: false }, usage: { lastSuccessTime: 1760000000000 } };
  assert.equal(lastSend([paused]).at, 1760000000000);
  assert.equal(lastSend([hook(1, 'bientôt'), hook(2, -5), hook(3, NaN), hook(4, 1e15)]), null, 'texte, négatif, NaN, année lointaine : ignorés');
  assert.equal(lastSend([hook(1, '1760000000000')]).at, 1760000000000, 'un nombre écrit en texte se lit');
});
