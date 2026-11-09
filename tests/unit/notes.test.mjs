// Note SOURCE : chaque opération rend une nouvelle note, sans toucher à celle qu'elle reçoit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DROP_SHOWN_S, EVENTS_KEPT, docNameOf, setDocName, ROWS_REFRESH_S, addEvent, clearExport, dropExport, eventsOf, observeRows, recentDrops, rowDrops, rowsOf, vanishedRecipients, dropInvitation, putExport, putInvitation, setExport, setFiles, setPause,
} from '../../js/engine/logic/notes.js';

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

test('destinataires disparus : webhook supprimé à la main dans Grist', () => {
  const ev = (kind, at) => ({ kind, at });
  assert.equal(vanishedRecipients([], 0), 0);
  assert.equal(vanishedRecipients([ev('join', 3), ev('edit', 2)], 1), 0, 'un destinataire ajouté et toujours là');
  assert.equal(vanishedRecipients([ev('join', 3), ev('edit', 2)], 0), 1, 'ajouté, plus de webhook');
  assert.equal(vanishedRecipients([ev('revoke', 4), ev('join', 3)], 0), 0, 'révoqué par le widget : rien ne manque');
  assert.equal(vanishedRecipients([ev('join', 5), ev('join', 4), ev('revoke', 3)], 1), 0);
  assert.equal(vanishedRecipients([ev('join', 5), ev('join', 4), ev('join', 3)], 1), 2);
  assert.equal(vanishedRecipients([ev('revoke', 4)], 0), 0, 'jamais négatif (ajout sorti de l\'historique)');
});

test('lignes en moins dans un export : référence, seuil (plus de 10 lignes et 20 %), événement, avis de 24 h', () => {
  const frozen = JSON.stringify(note());
  // Première observation : la référence est écrite, sans avis.
  const first = observeRows(note(), 'a', { Contacts: 100, Notes: 5 }, 1000);
  assert.deepEqual(first.lignes, { a: { at: 1000, n: { Contacts: 100, Notes: 5 } } });
  assert.equal(JSON.stringify(note()), frozen, 'la note reçue est intacte');
  assert.equal(observeRows(first, 'a', { Contacts: 100, Notes: 5 }, 1100), null, 'rien n\'a changé : rien à écrire');
  assert.equal(observeRows(first, 'a', { Contacts: 101, Notes: 5 }, 1100), null, 'changé mais référence récente : pas de nouvelle écriture');
  assert.deepEqual(observeRows(first, 'a', { Contacts: 101, Notes: 5 }, 1000 + ROWS_REFRESH_S).lignes.a, { at: 1000 + ROWS_REFRESH_S, n: { Contacts: 101, Notes: 5 } }, 'référence renouvelée');
  // Seuils : plus de 10 lignes ET plus de 20 % de la table. 10 en moins : non ; 11 sur 100 : non (11 %) ;
  // 11 sur 50 : oui (22 %) ; 20 sur 100 : non (pas plus de 20 %) ; 21 sur 100 : oui.
  assert.deepEqual(rowDrops({ T: 100 }, { T: 90 }), []);
  assert.deepEqual(rowDrops({ T: 100 }, { T: 89 }), []);
  assert.deepEqual(rowDrops({ T: 50 }, { T: 39 }), [{ table: 'T', n: 11, was: 50 }]);
  assert.deepEqual(rowDrops({ T: 100 }, { T: 80 }), []);
  assert.deepEqual(rowDrops({ T: 100 }, { T: 79 }).map(d => d.n), [21]);
  assert.deepEqual(rowDrops({ T: 1000 }, { T: 950 }), [], '50 lignes sur 1 000 : moins de 20 %');
  assert.deepEqual(rowDrops({ T: 1000 }, { T: 700 }).map(d => d.n), [300]);
  assert.deepEqual(rowDrops({ T: 10 }, { T: 0 }), [], 'moins de 11 lignes : jamais');
  assert.deepEqual(rowDrops({ T: 50 }, { U: 0 }), [], 'une table qui n\'était pas observée, ou perdue : pas de baisse');
  // Une baisse s'écrit aussitôt, avec son événement, référence récente ou non.
  const dropped = observeRows(first, 'a', { Contacts: 70, Notes: 5 }, 1010);
  assert.deepEqual(dropped.lignes.a, { at: 1010, n: { Contacts: 70, Notes: 5 } });
  assert.deepEqual(eventsOf(dropped, 'a'), [{ at: 1010, kind: 'shrink', who: 'Contacts', n: 30 }]);
  assert.deepEqual(recentDrops(eventsOf(dropped, 'a'), 1010 + 60), [{ table: 'Contacts', n: 30, at: 1010 }]);
  assert.deepEqual(recentDrops(eventsOf(dropped, 'a'), 1010 + DROP_SHOWN_S), [], 'l\'avis dure 24 heures');
  // Sans destinataire (warn faux) : aucun événement ; la référence suit au rythme habituel.
  assert.equal(observeRows(first, 'a', { Contacts: 70, Notes: 5 }, 1010, false), null);
  const quiet = observeRows(first, 'a', { Contacts: 70, Notes: 5 }, 1000 + ROWS_REFRESH_S, false);
  assert.deepEqual(quiet.lignes.a.n, { Contacts: 70, Notes: 5 });
  assert.deepEqual(eventsOf(quiet, 'a'), []);
  // La plus récente de chaque table seulement.
  const twice = observeRows(dropped, 'a', { Contacts: 40, Notes: 5 }, 1020);
  assert.deepEqual(recentDrops(eventsOf(twice, 'a'), 1030).map(d => [d.table, d.n]), [['Contacts', 30]], 'deux baisses de la même table : une seule ligne d\'avis, la plus récente');
  assert.equal(eventsOf(twice, 'a').length, 2, 'les deux restent dans l\'historique');
  // Note retouchée à la main : référence mal formée ignorée, jamais d'erreur.
  assert.equal(rowsOf({ lignes: { a: { at: 'x', n: 3 } } }, 'a'), null);
  assert.deepEqual(rowsOf({ lignes: { a: { at: 5, n: { T: 3, U: -1, V: 'x' } } } }, 'a'), { at: 5, n: { T: 3 } });
  assert.equal(observeRows(note(), 'a', {}, 1), null, 'aucune table observée : rien');
  // Un export retiré emporte sa référence.
  assert.equal(dropExport(first, 'a').lignes, undefined);
  assert.deepEqual(dropExport(observeRows(first, 'b', { X: 1 }, 1000), 'a').lignes, { b: { at: 1000, n: { X: 1 } } });
});

test('nom du document : saisi par la personne, nettoyé, effacé par un nom vide, sans toucher au reste de la note', () => {
  const before = note();
  const frozen = JSON.stringify(before);
  assert.equal(docNameOf(before), '');
  const named = setDocName(before, '  Budget\u202E 2026  ');
  assert.equal(named.nomDoc, 'Budget 2026');
  assert.equal(docNameOf(named), 'Budget 2026');
  assert.deepEqual(named.exports, before.exports, 'le reste de la note est gardé');
  assert.equal(JSON.stringify(before), frozen, 'la note reçue n\'est pas modifiée');
  assert.equal('nomDoc' in setDocName(named, '   '), false, 'un nom vide l\'efface');
  assert.equal(docNameOf({ nomDoc: '\u202Ex\n y' }), 'x y', 'une note retouchée à la main est nettoyée à la lecture');
  assert.equal(docNameOf({ nomDoc: 42 }), '42');
  assert.equal('nomDoc' in dropExport(named, 'a'), true, 'supprimer un export garde le nom du document');
});
