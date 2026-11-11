// Mise en forme conditionnelle : une règle n'est jamais copiée, elle est lue dans une grammaire stricte
// puis réécrite. Tout ce qui en sort est refusé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRule, parseRule, printRule, ruleRefs } from '../../js/engine/logic/rules.js';

test('règles lues : comparaisons, et/ou/non, listes, arithmétique, TODAY()', () => {
  const same = ['$Montant < 0', '$Statut == "Payé"', '$A >= 10 and $B != "x"', 'not $Fait', '$Date < TODAY()', '$Cat in ["a", "b"]', '$Cat not in ("a", "b")',
    '$Note is None', '$Note is not None', '($A + 1) * 2 > $B', '$Reel > $Budget * 0.9', '-$A < -5', '$Fait == True', '$A > 1 or ($B < 2 and not $C)'];
  for (const rule of same) assert.equal(normalizeRule(rule), rule.replace('("a", "b")', '["a", "b"]'), rule);
  assert.equal(normalizeRule('rec.Montant < 0'), '$Montant < 0', 'rec.X vaut $X');
  assert.equal(normalizeRule("$Statut == 'Payé'"), '$Statut == "Payé"', 'guillemets simples réécrits');
  assert.equal(normalizeRule('  $A   <\n0 '), '$A < 0', 'espaces et retours à la ligne');
});

test('la forme écrite se relit à l\'identique', () => {
  for (const rule of ['$A > 1 or ($B < 2 and not $C)', '($A + 1) * 2 > $B', '$Cat not in ("a", "b") and $D is None', 'not ($A == 1 or $B == 2)', '$A - -1 > 0', '- ($A + 1) < 2', '$A - ($B - $C) > 0', '($A and $B) or $C']) {
    const once = normalizeRule(rule);
    assert.ok(once, rule);
    assert.equal(normalizeRule(once), once, rule);
  }
});

test('hors grammaire : refusé, jamais copié', () => {
  const refused = ['__import__("os").system("x")', 'open("f")', '$A.lower() == "x"', '$Ref.Nom == "x"', 'len($A) > 3', 'Autre.all', '$A < 1 < 2', '$A ** 2 > 1', '$A // 2 > 1', '$A % 2 == 0',
    '[x for x in $A]', 'lambda: 1', '$A < 1; $B', '$A < 1 # commentaire', '$A == "a\\nb"', '$A == "a\'b"', '$A == f"x"', '$A == r"x"', '$A == b"x"', '$A == """x"""', '$A == "a" "b"',
    '$A == 1_000', '$A == 0x10', '$A == 007', '$A == 1abc', '$A == .5', '$ A < 1', '$1A < 1', '$A <', '< 1', '$A < ', '', '   ', 'TODAY', 'TODAY(1)', 'NOW()', 'DATE(2026, 1, 1) < $A',
    '$A in {1, 2}', '$A in $B', '$A in ($B,)', '$A in [$B]', '$A if $B else $C', '$A := 1', '$A = 1', '$A and', 'and $A', '$A not', '$A is', '$A is not 1', '(', ')', '$A < (1', 'rec', 'rec.', 'rec.A.b < 1',
    'True', '$A in [' + Array.from({ length: 51 }, (_, i) => i).join(',') + ']', `$A == "${'x'.repeat(101)}"`, `$A == ${'1 + '.repeat(40)}1`,
    '$A == ' + '('.repeat(20) + '1' + ')'.repeat(20), 'not '.repeat(20) + '$A', '- '.repeat(20) + '$A', '$A == "‮"', '$A == "a\u0000"', 'x' + ' '.repeat(RULE_PAD) + '$A'];
  // une constante, ou une somme de chaînes, est lue : sans danger
  for (const rule of refused.filter(r => r !== 'True')) assert.equal(parseRule(rule), null, JSON.stringify(rule));
  assert.ok(parseRule('True') && parseRule('1 + 2') && parseRule('$A < "x" + "y"'), 'une constante est lue');
  assert.equal(parseRule(null), null);
  assert.equal(parseRule(42), null);
  assert.equal(parseRule(`$A == 1${' '.repeat(300)}`), null, 'texte trop long');
});
const RULE_PAD = 300;

test('colonnes lues par une règle, et formule écrite pour une autre destination', () => {
  const tree = parseRule('$Reel > $Budget * 0.9 and rec.Statut != "Payé"');
  assert.deepEqual(ruleRefs(tree).sort(), ['Budget', 'Reel', 'Statut']);
  assert.equal(printRule(tree), '$Reel > $Budget * 0.9 and $Statut != "Payé"');
  assert.equal(printRule(tree, id => ({ Reel: 'Reel2', Budget: 'Budget', Statut: 'Statut_1' })[id]), '$Reel2 > $Budget * 0.9 and $Statut_1 != "Payé"');
  assert.equal(printRule(tree, id => (id === 'Statut' ? null : id)), null, 'une colonne absente d\'ici : la règle ne se pose pas');
  assert.equal(printRule(null), null);
  const all = printRule(parseRule('$A in ["x", "y", "z"]'));
  assert.ok(/^[\w$()[\]", <>=!+*/.-]*$/.test(all), 'rien d\'autre que la grammaire dans le texte écrit');
});

test('texte écrit : jamais autre chose que la grammaire, même pour des entrées tordues', () => {
  const nasty = ['$A == "$(rm -rf)"', '$A == "{{x}}"', '$A == "%s %d"', '$A == "éè 日本 ✓"', '$A in ["a)", "(b", "c, d"]'];
  for (const rule of nasty) {
    const out = normalizeRule(rule);
    assert.ok(out, rule);
    assert.equal(parseRule(out) && printRule(parseRule(out)), out);
    assert.ok(!/[\\\n\r\t;#]|__|import|open\(|exec|eval/.test(out.replace(/"[^"]*"/g, '""')), `hors chaînes : ${out}`);
  }
});
