// Note SOURCE : chaque opération rend une nouvelle note, sans toucher à celle qu'elle reçoit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS_KEPT, addEvent, clearExport, dropExport, eventsOf, dropInvitation, putExport, putInvitation, setExport, setFiles, setPause } from '../../js/logic/notes.js';

const note = () => ({
  exports: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
  invitations: [{ id: 'i1', export: 'a' }, { id: 'i2', export: 'b' }],
  pauses: [{ hook: 'h1', export: 'a', at: 10 }, { hook: 'h2', export: 'b', at: 20 }],
});

test('exports : champs changés à leur place, remplacé ou ajouté à la fin, retiré avec ses invitations et pauses', () => {
  const before = note();
  const frozen = JSON.stringify(before);
  assert.deepEqual(setExport(before, 'a', { name: 'A2' }).exports.map(e => [e.id, e.name]), [['a', 'A2'], ['b', 'B']], 'l\'ordre des cartes ne change pas');
  assert.deepEqual(putExport(before, { id: 'a', name: 'X' }).exports.map(e => e.id), ['a', 'b']);
  assert.deepEqual(putExport(before, { id: 'c', name: 'C' }).exports.map(e => e.id), ['a', 'b', 'c']);
  const cleared = clearExport(before, 'a');
  assert.deepEqual([cleared.exports.length, cleared.invitations.map(i => i.id), cleared.pauses.map(p => p.hook)], [2, ['i2'], ['h2']]);
  const dropped = dropExport(before, 'a');
  assert.deepEqual([dropped.exports.map(e => e.id), dropped.invitations.map(i => i.id), dropped.pauses.map(p => p.hook)], [['b'], ['i2'], ['h2']]);
  assert.equal(JSON.stringify(before), frozen, 'la note reçue est intacte');
});

test('invitations, pauses et suivi des fichiers', () => {
  const before = note();
  assert.deepEqual(putInvitation(before, { id: 'i1', export: 'a', at: 5 }).invitations, [{ id: 'i1', export: 'a', at: 5 }, { id: 'i2', export: 'b' }]);
  assert.deepEqual(putInvitation(before, { id: 'i3', export: 'a' }).invitations.map(i => i.id), ['i1', 'i2', 'i3']);
  assert.deepEqual(dropInvitation(before, 'i1').invitations.map(i => i.id), ['i2']);
  assert.deepEqual(setPause(before, 'h1', { hook: 'h1', export: 'a', at: 30 }).pauses, [{ hook: 'h2', export: 'b', at: 20 }, { hook: 'h1', export: 'a', at: 30 }], 'une seule pause par webhook');
  assert.deepEqual(setPause(before, 'h1').pauses.map(p => p.hook), ['h2'], 'pause levée');
  const files = setFiles(before, { a: { f: ['x'], h: [], p: {} } });
  assert.deepEqual(files.fichiers, { a: { f: ['x'], h: [], p: {} } });
  assert.equal('fichiers' in setFiles(files, {}), false, 'retiré quand il est vide');
  assert.equal('fichiers' in before, false);
});

test('historique des envois : plus récent d\'abord, borné, par export, effacé avec l\'export', () => {
  const before = note();
  const frozen = JSON.stringify(before);
  let next = addEvent(before, 'a', { at: 10, kind: 'resend', n: 120 });
  next = addEvent(next, 'a', { at: 20, kind: 'pause', who: 'x'.repeat(200) });
  next = addEvent(next, 'b', { at: 30, kind: 'unblock' });
  assert.equal(JSON.stringify(before), frozen);
  assert.deepEqual(eventsOf(next, 'a').map(e => [e.kind, e.at]), [['pause', 20], ['resend', 10]]);
  assert.equal(eventsOf(next, 'a')[0].who.length, 80, 'le nom du destinataire est borné');
  assert.deepEqual(eventsOf(next, 'a')[1], { at: 10, kind: 'resend', n: 120 }, 'sans destinataire ni nombre : rien de plus');
  assert.deepEqual(eventsOf(next, 'b'), [{ at: 30, kind: 'unblock' }]);
  for (let i = 0; i < EVENTS_KEPT + 5; i++) next = addEvent(next, 'a', { at: 100 + i, kind: 'catchup', n: 1 });
  assert.equal(eventsOf(next, 'a').length, EVENTS_KEPT);
  assert.equal(eventsOf(next, 'a')[0].at, 100 + EVENTS_KEPT + 4, 'les plus anciens partent');
  assert.deepEqual(Object.keys(dropExport(next, 'a').historique), ['b']);
  assert.equal('historique' in dropExport(dropExport(next, 'a'), 'b'), false, 'plus rien à garder : la clé disparaît');
  assert.deepEqual(eventsOf({ historique: { a: [null, { kind: 3, at: 1 }, { kind: 'resend', at: 'x' }, { kind: 'resend', at: 5 }] } }, 'a'), [{ kind: 'resend', at: 5 }], 'entrées abîmées écartées');
  assert.deepEqual(eventsOf(before, 'a'), []);
  for (const bad of [{ x: 1 }, 'texte', 7, null]) assert.deepEqual(eventsOf({ historique: { a: bad } }, 'a'), [], 'ce n\'est pas une liste');
  assert.deepEqual(eventsOf({ historique: { a: [{ kind: 'resend', at: 1e20 }, { kind: 'resend', at: -3 }, { kind: 'inconnu', at: 5 }, { kind: 'edit', at: 7, who: 42, n: 'x' }] } }, 'a'),
    [{ kind: 'edit', at: 7, who: '42' }], 'date impossible, genre inconnu et nombre faux écartés');
});
