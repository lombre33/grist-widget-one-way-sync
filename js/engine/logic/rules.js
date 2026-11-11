// Mise en forme conditionnelle d'une colonne. Une règle de Grist est une formule Python (une colonne
// cachée `gristHelper_ConditionalRule`) : la copier telle quelle ferait exécuter dans la CIBLE un texte
// écrit ailleurs, avec accès à toutes ses tables. La règle ne passe donc jamais par son texte d'origine :
// elle est lue dans une grammaire stricte (`parseRule`), et c'est la formule réécrite d'après l'arbre
// lu (`printRule`) que la CIBLE pose. Ce qui sort de la grammaire (appel de fonction, attribut,
// chaîne spéciale, comparaison enchaînée…) ne part pas : la SOURCE le dit.
//
// Grammaire (priorités de Python) :
//   ou      := et ('or' et)*          et   := non ('and' non)*        non := 'not' non | comparaison
//   comparaison := somme ( ('=='|'!='|'<'|'<='|'>'|'>=') somme | ['not'] 'in' liste | 'is' ['not'] 'None' )?
//   somme   := produit (('+'|'-') produit)*      produit := unaire (('*'|'/') unaire)*     unaire := '-' unaire | atome
//   atome   := nombre | chaîne | True | False | None | colonne | TODAY() | '(' ou ')'
//   colonne := '$' nom | 'rec.' nom           liste := '(' valeur, … ')' | '[' valeur, … ']'
// Une comparaison ne s'enchaîne pas (`a < b < c` n'est pas lue) ; un nom de colonne est un identifiant
// simple ; une chaîne n'a ni guillemet, ni barre oblique inverse, ni caractère de contrôle.
import { COL_ID } from './common.js';

export const RULE_MAX = 300; // caractères d'une règle
const STRING_MAX = 100;
const LIST_MAX = 50;
const NODES_MAX = 60;
const DEPTH_MAX = 12;
const NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const WORD = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '(', ')', '[', ']', ','];
const COMPARE = new Set(['==', '!=', '<', '<=', '>', '>=']);
const WORDS = new Set(['and', 'or', 'not', 'in', 'is', 'True', 'False', 'None', 'TODAY']);

class Refused extends Error {}
const refuse = () => { throw new Refused('règle hors grammaire'); };

function tokens(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (' \t\r\n'.includes(ch)) { i++; continue; }
    const rest = text.slice(i);
    if (ch === '$') {
      const name = WORD.exec(rest.slice(1));
      if (!name || !COL_ID.test(name[0])) refuse();
      out.push({ type: 'col', value: name[0] });
      i += 1 + name[0].length;
    } else if (/[0-9]/.test(ch)) {
      const num = NUMBER.exec(rest);
      if (!num || /^[A-Za-z_]/.test(rest.slice(num[0].length))) refuse();
      out.push({ type: 'num', value: num[0] });
      i += num[0].length;
    } else if (ch === '"' || ch === "'") {
      const end = text.indexOf(ch, i + 1);
      const value = end < 0 ? '' : text.slice(i + 1, end);
      if (end < 0 || value.length > STRING_MAX || /[\\"'\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200b-\u200f\u202a-\u202e\u2066-\u206f\ufeff]/.test(value)) refuse();
      out.push({ type: 'str', value });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const word = WORD.exec(rest)[0];
      if (word === 'rec' && rest[3] === '.') {
        const name = WORD.exec(rest.slice(4));
        if (!name) refuse();
        out.push({ type: 'col', value: name[0] });
        i += 4 + name[0].length;
      } else {
        if (!WORDS.has(word)) refuse();
        out.push({ type: 'word', value: word });
        i += word.length;
      }
    } else {
      const op = OPERATORS.find(o => rest.startsWith(o));
      if (!op) refuse();
      out.push({ type: 'op', value: op });
      i += op.length;
    }
  }
  return out;
}

function parser(list) {
  let at = 0;
  let nodes = 0;
  const peek = () => list[at];
  const is = (type, value) => list[at] && list[at].type === type && (value === undefined || list[at].value === value);
  const take = (type, value) => { if (!is(type, value)) refuse(); return list[at++]; };
  const make = (node) => { if (++nodes > NODES_MAX) refuse(); return node; };

  function literal() {
    const minus = is('op', '-') && list[at++];
    const tok = peek();
    if (!tok || (minus && tok.type !== 'num')) refuse();
    if (tok.type === 'num') return make({ k: 'num', v: `${minus ? '-' : ''}${list[at++].value}` });
    if (tok.type === 'str') return make({ k: 'str', v: list[at++].value });
    if (tok.type === 'word' && ['True', 'False', 'None'].includes(tok.value)) return make({ k: 'const', v: list[at++].value });
    return refuse();
  }
  function items() {
    const close = take('op', is('op', '(') ? '(' : '[').value === '(' ? ')' : ']';
    const found = [];
    while (!is('op', close)) {
      found.push(literal());
      if (found.length > LIST_MAX) refuse();
      if (is('op', ',')) at++;
      else if (!is('op', close)) refuse();
    }
    take('op', close);
    return found;
  }
  function atom(depth) {
    if (depth > DEPTH_MAX) refuse();
    const tok = peek();
    if (!tok) return refuse();
    if (tok.type === 'num') return make({ k: 'num', v: list[at++].value });
    if (tok.type === 'str') return make({ k: 'str', v: list[at++].value });
    if (tok.type === 'col') return make({ k: 'col', v: list[at++].value });
    if (is('word', 'TODAY')) { at++; take('op', '('); take('op', ')'); return make({ k: 'today' }); }
    if (tok.type === 'word' && ['True', 'False', 'None'].includes(tok.value)) return make({ k: 'const', v: list[at++].value });
    if (is('op', '(')) { at++; const inner = or(depth + 1); take('op', ')'); return inner; }
    return refuse();
  }
  function unary(depth) {
    if (is('op', '-')) { at++; return make({ k: 'neg', a: unary(depth + 1) }); }
    return atom(depth);
  }
  function binary(next, ops, depth) {
    let left = next(depth);
    while (list[at] && list[at].type === 'op' && ops.includes(list[at].value)) {
      const op = list[at++].value;
      left = make({ k: 'bin', op, a: left, b: next(depth) });
    }
    return left;
  }
  const product = depth => binary(unary, ['*', '/'], depth);
  const sum = depth => binary(product, ['+', '-'], depth);
  function comparison(depth) {
    const left = sum(depth);
    if (list[at] && list[at].type === 'op' && COMPARE.has(list[at].value)) {
      const op = list[at++].value;
      return make({ k: 'cmp', op, a: left, b: sum(depth) });
    }
    if (is('word', 'in') || (is('word', 'not') && list[at + 1] && list[at + 1].value === 'in')) {
      const negated = is('word', 'not') && ++at;
      take('word', 'in');
      return make({ k: 'in', not: Boolean(negated), a: left, list: items() });
    }
    if (is('word', 'is')) {
      at++;
      const negated = is('word', 'not') && ++at;
      take('word', 'None');
      return make({ k: 'isnone', not: Boolean(negated), a: left });
    }
    return left;
  }
  function not(depth) {
    if (depth > DEPTH_MAX) refuse();
    if (is('word', 'not')) { at++; return make({ k: 'not', a: not(depth + 1) }); }
    return comparison(depth);
  }
  function and(depth) {
    let left = not(depth);
    while (is('word', 'and')) { at++; left = make({ k: 'and', a: left, b: not(depth) }); }
    return left;
  }
  function or(depth) {
    let left = and(depth);
    while (is('word', 'or')) { at++; left = make({ k: 'or', a: left, b: and(depth) }); }
    return left;
  }
  return { run() { const tree = or(0); if (at !== list.length) refuse(); return tree; } };
}

// Arbre d'une règle, ou null si elle sort de la grammaire (texte trop long, jeton inconnu…).
export function parseRule(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > RULE_MAX) return null;
  try {
    return parser(tokens(text.trim())).run();
  } catch (e) {
    if (e instanceof Refused) return null;
    throw e;
  }
}

// Colonnes qu'une règle lit (arbre de parseRule).
export function ruleRefs(tree) {
  const found = new Set();
  const walk = (node) => {
    if (!node) return;
    if (node.k === 'col') found.add(node.v);
    walk(node.a);
    walk(node.b);
  };
  walk(tree);
  return [...found];
}

// Priorité d'un nœud (comme Python) : le texte écrit ne met de parenthèses que là où elles changent le sens,
// et autour d'un et/ou imbriqué dans un autre (pour la lecture).
const LEVEL = { or: 1, and: 2, not: 3, cmp: 4, in: 4, isnone: 4, neg: 7 };
const levelOf = node => (node.k === 'bin' ? (node.op === '+' || node.op === '-' ? 5 : 6) : LEVEL[node.k] || 9);

// Opérandes d'une suite de `and` ou de `or` (l'arbre est penché à gauche).
const chain = (node, kind) => (node.k === kind ? [...chain(node.a, kind), node.b] : [node]);

function show(node, name, min = 0) {
  const text = body(node, name);
  return levelOf(node) < min ? `(${text})` : text;
}
function body(node, name) {
  switch (node.k) {
    case 'num': return node.v;
    case 'str': return `"${node.v}"`;
    case 'const': return node.v;
    case 'col': return `$${name(node.v)}`;
    case 'today': return 'TODAY()';
    case 'neg': return `-${show(node.a, name, 7)}`;
    case 'not': return `not ${show(node.a, name, 3)}`;
    case 'and':
    case 'or': return chain(node, node.k).map(operand => show(operand, name, 3)).join(` ${node.k} `);
    case 'in': return `${show(node.a, name, 5)} ${node.not ? 'not in' : 'in'} [${node.list.map(v => show(v, name)).join(', ')}]`;
    case 'isnone': return `${show(node.a, name, 5)} is ${node.not ? 'not ' : ''}None`;
    case 'cmp': return `${show(node.a, name, 5)} ${node.op} ${show(node.b, name, 5)}`;
    default: {
      const wide = node.op === '+' || node.op === '-' ? 5 : 6;
      return `${show(node.a, name, wide)} ${node.op} ${show(node.b, name, wide + 1)}`;
    }
  }
}

// La formule d'un arbre, écrite par nous : seules des colonnes (`rename(nom)` rend leur nom dans le
// document qui l'écrit, ou null si elle n'y est pas : la règle est alors laissée), des nombres, des
// chaînes sûres, des constantes et des opérateurs y figurent. Null si une colonne manque.
export function printRule(tree, rename = id => id) {
  if (!tree) return null;
  const missing = ruleRefs(tree).some(id => !rename(id));
  return missing ? null : show(tree, id => rename(id));
}

// Règle ramenée à sa forme d'écriture, ou null : `normalizeRule(x)` est stable (la relire redonne le même texte).
export const normalizeRule = (text) => {
  const tree = parseRule(text);
  return tree ? printRule(tree) : null;
};
