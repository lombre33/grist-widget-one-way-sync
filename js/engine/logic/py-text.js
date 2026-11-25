// Texte Python lu et écrit sans jamais l'exécuter : la copie unique (voir code-view-parse.js) lit le code d'une table
// collé par la personne, qui peut venir de n'importe où. Ici, seulement des motifs fixes et un scanner de caractères :
// ni `eval`, ni `Function`, ni import dynamique, et tout ce qui est lu est borné par la taille du texte (une seule passe).

const ESCAPED = { '\\': '\\\\', '\'': '\\\'', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const UNESCAPED = { n: '\n', r: '\r', t: '\t' };
// Une séquence d'échappement d'un texte : `\xNN`, `\uNNNN`, ou un caractère après la barre oblique inverse.
const ESCAPE = /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|(.))/g;
const unescaped = (_, hex2, hex4, ch) => (hex2 || hex4 ? String.fromCharCode(parseInt(hex2 || hex4, 16)) : UNESCAPED[ch] ?? ch);
const STRING_LITERAL = /^(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")$/s;

// Le texte en littéral entre apostrophes, qui tient sur une ligne.
export function quotePython(text) {
  return `'${String(text).replace(/[\\'\n\r\t]/g, ch => ESCAPED[ch])}'`;
}

// La valeur d'un littéral de texte donné tel qu'il est écrit (l'une ou l'autre des deux sortes de guillemets, l'inverse de
// quotePython), ou null.
export function parseString(source) {
  const match = typeof source === 'string' ? source.match(STRING_LITERAL) : null;
  return match ? (match[1] ?? match[2]).replace(ESCAPE, unescaped) : null;
}

// Nombre d'espaces et de tabulations en tête d'une ligne, et d'espaces insécables, que met un texte copié d'une page web à leur place.
export const indentOf = line => line.match(/^[ \t\u00a0]*/)[0].length;

const WORD = /\w+/y;
const STRING_PREFIX = /^(?:[rubf]|r[bf]|[bf]r)$/i;
const isQuote = ch => ch === '\'' || ch === '"';
const UNKNOWN = -2;

// Fin d'un texte à guillemets simples dont l'ouverture est en `at` : la fin de sa ligne s'il reste ouvert.
function lineStringEnd(text, at, delimiter) {
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === delimiter) return i + 1;
    else if (text[i] === '\n') return i;
  }
  return text.length;
}

// Fin d'un texte à triple guillemet dont l'ouverture est en `at`, ou -1 s'il n'est jamais fermé. `reached` retient, pour
// chaque sorte de triple guillemet, où aboutit une marche qui passe par une position : celles des ouvertures suivantes du
// même texte rejoignent les marches déjà faites au lieu d'aller encore jusqu'à la fin (un texte piégé reste lu en une passe).
function tripleStringEnd(text, at, delimiter, reached) {
  const memo = (reached[delimiter] ??= new Int32Array(text.length + 2).fill(UNKNOWN));
  const path = [];
  let end = -1;
  for (let i = at + 3; i < text.length;) {
    if (memo[i] !== UNKNOWN) {
      end = memo[i];
      break;
    }
    path.push(i);
    if (text[i] === '\\') i += 2;
    else if (text.startsWith(delimiter, i)) {
      end = i + 3;
      break;
    } else i++;
  }
  for (const position of path) memo[position] = end;
  return end;
}

function stringEnd(text, at, reached) {
  const delimiter = text.startsWith(text[at].repeat(3), at) ? text[at].repeat(3) : text[at];
  return delimiter.length === 1 ? lineStringEnd(text, at, delimiter) : tripleStringEnd(text, at, delimiter, reached);
}

// [début, fin[ de chaque texte du Python de `text`. Des littéraux qui se suivent n'en font qu'un, comme Python les lit :
// après une barre oblique inverse, ou entre parenthèses, par-dessus commentaires et sauts de ligne.
function stringRanges(text) {
  const scan = { ranges: [], joined: null, depth: 0, reached: {} }; // joined : le texte, ou les textes, en cours de lecture ; depth : parenthèses ouvertes
  for (let i = 0; i < text.length;) i = scanFrom(text, i, scan);
  endJoined(scan);
  return scan.ranges;
}

function endJoined(scan) {
  if (scan.joined) scan.ranges.push(scan.joined);
  scan.joined = null;
}

const lineEnd = (text, from) => (text.indexOf('\n', from) === -1 ? text.length : text.indexOf('\n', from));
const nextDepth = (depth, ch) => ('([{'.includes(ch) ? depth + 1 : ')]}'.includes(ch) ? Math.max(0, depth - 1) : depth);

// Lit ce qui commence en `i` (un texte, un commentaire, une espace ou du code) ; rend où commence la suite.
function scanFrom(text, i, scan) {
  WORD.lastIndex = i;
  const word = WORD.exec(text)?.[0] ?? '';
  const quote = i + (STRING_PREFIX.test(word) ? word.length : 0);
  if (isQuote(text[quote])) return scanString(text, i, quote, scan);
  const ch = text[i];
  if (ch === '#') return lineEnd(text, i);
  if (ch === '\n') {
    if (scan.depth === 0) endJoined(scan); // seul un saut de ligne hors parenthèses termine une instruction
    return i + 1;
  }
  if (ch === '\\' && text[i + 1] === '\n') return i + 2;
  if (/\s/.test(ch)) return i + 1;
  endJoined(scan); // un nom, un nombre, un opérateur ou une parenthèse
  scan.depth = nextDepth(scan.depth, ch);
  return i + Math.max(word.length, 1);
}

// Le texte dont les guillemets s'ouvrent en `quote` (son préfixe commence en `i`) : un de plus pour le texte en cours de
// jonction, ou aucun s'il n'est jamais fermé.
function scanString(text, i, quote, scan) {
  const end = stringEnd(text, quote, scan.reached);
  if (end === -1) {
    endJoined(scan); // ouvert et jamais fermé : ce n'est pas un texte, les guillemets ne veulent rien dire
    return quote + 3; // après les guillemets d'ouverture, trois au plus : la suite est du code
  }
  scan.joined = [scan.joined?.[0] ?? i, end];
  return end;
}

// Pour chaque ligne, vrai si elle commence dans un texte Python qui court sur plusieurs lignes : entre triples guillemets,
// prolongé par une barre oblique inverse, ou fait de littéraux joints (`("a"\n"b")`). Grist 1.7.20 et après écrit les lignes d'un
// tel texte, dans une formule, telles quelles, sans indentation : elle ne dit rien de la mise en page autour.
export function stringLines(lines) {
  const ranges = stringRanges(lines.join('\n'));
  let next = 0; // le premier texte qui peut encore contenir un saut de ligne
  let start = 0; // position de la ligne
  return lines.map((line) => {
    const lineBreak = start - 1; // avant cette ligne
    start += line.length + 1;
    while (next < ranges.length && ranges[next][1] <= lineBreak) next++;
    return next < ranges.length && ranges[next][0] <= lineBreak;
  });
}

// [position, caractère, profondeur] de chaque caractère hors d'un texte ; la profondeur compte les parenthèses ouvertes autour.
function* codeChars(text, from = 0) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else {
      if (')]}'.includes(ch)) depth--;
      yield [i, ch, depth];
      if ('([{'.includes(ch)) depth++;
    }
  }
}

// Le texte sans le commentaire qui le termine (un `#` dans un texte n'en est pas un).
export function withoutComment(text) {
  for (const [i, ch] of codeChars(text)) if (ch === '#') return text.slice(0, i).trimEnd();
  return text;
}

// Position de la parenthèse qui ferme celle de `openIndex` (une `)` dans « Oui (confirmé) » ne compte pas), ou -1.
export function findMatchingClose(text, openIndex) {
  if (!'([{'.includes(text[openIndex])) return -1;
  for (const [i, ch, depth] of codeChars(text, openIndex)) if (')]}'.includes(ch) && depth === 0) return i;
  return -1;
}

// Les arguments d'un appel, en texte source : `'People', visible_col='Name'` donne positional ["'People'"] et kwargs { visible_col: "'Name'" }.
export function parseArguments(text) {
  const pieces = [];
  let start = 0;
  for (const [i, ch, depth] of codeChars(text)) {
    if (ch === ',' && depth === 0) {
      pieces.push(text.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(text.slice(start));

  const positional = [];
  const kwargs = Object.create(null); // un nom d'argument comme `constructor` n'est pas celui d'un objet
  for (const piece of pieces.map(item => item.trim()).filter(Boolean)) {
    const named = piece.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/);
    if (named) kwargs[named[1]] = named[2];
    else positional.push(piece);
  }
  return { positional, kwargs };
}

// Les textes d'une liste donnée en texte source (`['a', "b"]`), ou null s'il n'y en a pas ; `onSkipped` apprend chaque élément
// qui n'est pas un texte, laissé de côté.
export function parseStringList(source, onSkipped = () => {}) {
  if (typeof source !== 'string' || !source.startsWith('[') || !source.endsWith(']')) return null;
  const items = parseArguments(source.slice(1, -1)).positional.map((piece) => {
    const item = parseString(piece);
    if (item === null) onSkipped(piece);
    return item;
  });
  const strings = items.filter(item => item !== null);
  return strings.length > 0 ? strings : null;
}
