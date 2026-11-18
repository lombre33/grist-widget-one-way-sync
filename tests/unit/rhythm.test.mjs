// Rythme de la recopie de la CIBLE (js/engine/logic/rhythm.js) : ce que la boucle fait de la réponse de Grist à
// « qu'est-ce qui a changé ? ». Cas vécu le 18 novembre : une comparaison bloquée en route (403 sans en-tête CORS, comme
// sur DINUM) passait pour « rien n'a changé » et la recopie n'avait plus lieu que toutes les 5 minutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPARE_TRIES, changeVerdict, nextCompare } from '../../js/engine/logic/rhythm.js';

test('changeVerdict : une réponse de Grist, avec ou sans table touchée, est une réponse', () => {
  assert.equal(changeVerdict({ hash: 'H2', tables: new Set(['Journal_A']) }, 'H1'), 'answered');
  assert.equal(changeVerdict({ hash: 'H1', tables: new Set() }, 'H1'), 'answered', 'aucun changement : un ensemble vide, une vraie réponse');
  assert.equal(changeVerdict({ hash: 'H2', tables: null }, 'H1'), 'answered', 'état perdu relu depuis HEAD : tout relire, mais Grist a répondu');
  assert.equal(changeVerdict({ hash: 'H9', tables: null }, ''), 'answered', 'premier coup d\'œil, sans état de départ');
});

test('changeVerdict : « inconnu » sans nouvel état, c\'est une comparaison qui n\'a pas abouti', () => {
  assert.equal(changeVerdict({ hash: 'H1', tables: null }, 'H1'), 'unanswered');
  assert.equal(changeVerdict({ hash: '', tables: null }, ''), 'unanswered', 'rien n\'a encore répondu');
});

test('changeVerdict : le refus de Grist (droits) reste un refus', () => {
  assert.equal(changeVerdict(null, 'H1'), 'refused');
});

test('nextCompare : une réponse remet le compte à zéro', () => {
  assert.deepEqual(nextCompare(2, 'answered'), { fails: 0, keep: true });
});

test('nextCompare : la comparaison est laissée après COMPARE_TRIES coups d\'œil sans réponse de suite', () => {
  let state = { fails: 0, keep: true };
  const seen = [];
  for (let n = 0; n < COMPARE_TRIES; n++) {
    state = nextCompare(state.fails, 'unanswered');
    seen.push(state.keep);
  }
  assert.deepEqual(seen, [...Array(COMPARE_TRIES - 1).fill(true), false]);
});

test('nextCompare : un raté isolé ne coupe pas la comparaison', () => {
  let state = nextCompare(0, 'unanswered');
  assert.equal(state.keep, true);
  state = nextCompare(state.fails, 'answered');
  assert.deepEqual(state, { fails: 0, keep: true });
  state = nextCompare(state.fails, 'unanswered');
  assert.equal(state.keep, true, 'le compte est reparti de zéro');
});

test('nextCompare : un refus coupe la comparaison tout de suite', () => {
  assert.equal(nextCompare(0, 'refused').keep, false);
});
