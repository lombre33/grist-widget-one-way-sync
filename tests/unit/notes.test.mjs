// Note SOURCE : chaque opération rend une nouvelle note, sans toucher à celle qu'elle reçoit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearExport, dropExport, dropInvitation, putExport, putInvitation, setExport, setFiles, setPause } from '../../js/logic/notes.js';

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
