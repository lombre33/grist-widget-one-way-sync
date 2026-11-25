// Lit le texte Python de la « Code View » d'une table, sans l'exécuter : des motifs fixes et un scanner de parenthèses, rien
// d'autre. Ce que la lecture ne comprend pas devient une remarque, `{ key, params, table }`, que l'écran met en phrase
// (textes `copy.warn.*`). Le texte vient de la personne, qui l'a collé : il peut venir de n'importe où.

import { findMatchingClose, indentOf, parseString, stringLines, withoutComment } from './py-text.js';
import { isReservedColumnId } from './code-view-types.js';
import { isSafeId, isUserTable } from './common.js';

const CLASS_HEAD = /^class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\)\s*)?:\s*$/; // les espaces après les bases sont dans le groupe : deux `\s*` côte à côte essaieraient chaque coupe d'une longue suite
const ASSIGNMENT = /^([A-Za-z_]\w*)\s*=\s*grist\.([A-Za-z_]\w*)\s*\(/;
const FORMULA_TYPE = /^@grist\.formulaType\(\s*grist\.([A-Za-z_]\w*)\s*\(/;
const FORMULA_DEF = /^def\s+([A-Za-z_]\w*)\s*\(\s*rec\s*,\s*table\s*\)\s*:\s*$/;
const TRIGGER_DEF = /^def\s+_default_(\w+)\s*\(\s*rec\s*,\s*table\s*,\s*value\s*,\s*user\s*\)\s*:\s*$/;
const SUMMARY_CLASS = /^class\s+_Summary\s*:\s*$/;
const SNIPPET_MAX = 80;

// Limites d'un texte collé : au-delà, la lecture le refuse en le disant (un texte de plusieurs mégaoctets bloquerait l'onglet).
export const TEXT_MAX = 2000000; // caractères
export const TABLES_MAX = 100;
export const COLUMNS_MAX = 500; // par table

// Les tables du widget et celles de Grist ne se copient pas : le texte ne peut pas en créer. Le nom d'une table de Grist
// commence par un tiret bas (`_grist_Tables`), et `Synchro` comme `Journal_` sont les noms de ce widget, avec ou sans préfixe.
export const isReservedTableId = tableId => tableId.startsWith('_') || !isUserTable(tableId) || /^(?:Synchro(?:_|$)|Journal_)/.test(tableId);

// `prefix` suivi d'un appel fermé, puis de `tail` seulement : ce que `prefix` a lu et les arguments de l'appel, ou null.
function matchCall(text, prefix, tail) {
  const start = text.match(prefix);
  if (!start) return null;
  const open = start[0].length - 1;
  const close = findMatchingClose(text, open);
  if (close === -1 || !tail.test(text.slice(close + 1))) return null;
  return { start, args: text.slice(open + 1, close).trim() };
}

// Ce qu'une instruction dit : une colonne, le type d'une colonne de formule, une fonction (formule, formule de déclenchement),
// ou rien qu'on connaisse.
function classify(text) {
  const column = matchCall(text, ASSIGNMENT, /^\s*$/);
  if (column) return { kind: 'column', id: column.start[1], dslType: column.start[2], argsRaw: column.args };
  const type = matchCall(text, FORMULA_TYPE, /^\s*\)\s*$/);
  if (type) return { kind: 'formulaType', dslType: type.start[1], argsRaw: type.args };
  const formula = text.match(FORMULA_DEF);
  if (formula) return { kind: 'formula', id: formula[1] };
  const trigger = text.match(TRIGGER_DEF);
  if (trigger) return { kind: 'trigger', id: trigger[1] };
  if (text === 'pass' || SUMMARY_CLASS.test(text)) return { kind: 'ignored' };
  return { kind: text.startsWith('@') ? 'unknownDecorator' : 'unknown' };
}

const isCode = line => line.trim() !== '' && !line.trim().startsWith('#');
// Ce qu'une ligne dit comme instruction : sans les espaces autour ni le commentaire qui la termine (vide pour une ligne vide ou un commentaire).
const statementOf = line => withoutComment(line.trim());
const snippet = text => (text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text);

// Le corps de la fonction écrite à `parentIndent` dont l'en-tête précède la ligne `from` : son code sans l'indentation commune, et
// l'indice de la ligne qui suit. Les lignes d'un texte sur plusieurs lignes (`inString`) en font partie quelle que soit leur
// indentation. Grist avant la 1.7.20 les indente avec le code, après il les écrit telles que la formule les a : une ligne moins
// indentée que le code veut dire qu'elles sont laissées telles quelles, sinon elles sont désindentées.
function readBlock(lines, inString, from, parentIndent) {
  const end = blockEnd(lines, inString, from, parentIndent);
  const layout = [];
  const strings = [];
  for (let i = from; i < end; i++) {
    if (!inString[i]) {
      if (isCode(lines[i])) layout.push(indentOf(lines[i]));
    } else if (lines[i].trim() !== '') {
      strings.push(indentOf(lines[i]));
    }
  }
  if (layout.length === 0) return { code: '', end };
  const common = layout.reduce((least, indent) => Math.min(least, indent)); // pas Math.min(...) : trop de lignes feraient déborder l'appel
  const asWritten = strings.some(indent => indent < common);
  const code = lines.slice(from, end)
    .map((line, k) => (asWritten && inString[from + k] ? line : line.slice(Math.min(common, indentOf(line)))))
    .join('\n').trim();
  return { code, end };
}

// Où s'arrête le corps d'une fonction : à la première ligne de code qui n'est pas plus indentée que son en-tête.
function blockEnd(lines, inString, from, parentIndent) {
  let end = from;
  for (let i = from; i < lines.length; i++) {
    if (inString[i]) end = i + 1;
    else if (lines[i].trim() === '') continue;
    else if (indentOf(lines[i]) > parentIndent) end = i + 1;
    else if (isCode(lines[i])) break;
  }
  return end;
}

// Les tables du texte : [{ tableId, description, columns: [{ id, dslType, argsRaw, kind: 'data' | 'formula' | 'trigger', code, line }] }] et
// les remarques. `description` : celle de la table, écrite en texte juste après `class` (sa docstring) ; `kind` : colonne de données,
// colonne de formule, ou colonne de données avec une formule de déclenchement ; `code` : le corps de cette formule, tel qu'écrit (vide
// pour une colonne de données).
export function parseCodeView(sourceText) {
  const text = String(sourceText);
  if (text.length > TEXT_MAX) return { tables: [], warnings: [{ key: 'copy.warn.textTooLong', params: { max: TEXT_MAX } }] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const inString = stringLines(lines);
  const tables = [];
  const warnings = [];
  for (let i = 0; i < lines.length; i++) {
    if (inString[i] || statementOf(lines[i]) !== '@grist.UserTable') continue;
    const read = readTable(lines, inString, i);
    if (read.warning) warnings.push(read.warning);
    else if (read.table && tables.length >= TABLES_MAX) warnings.push({ key: 'copy.warn.tooManyTables', params: { max: TABLES_MAX } });
    else if (read.table) tables.push(read.table);
    for (const warning of read.warnings || []) warnings.push(warning); // pas push(...) : un texte de centaines de milliers de lignes ferait déborder l'appel
    i = read.end - 1;
  }
  if (tables.length === 0 && warnings.length === 0) warnings.push({ key: 'copy.warn.noTableFound' });
  return { tables, warnings };
}

// La table dont `@grist.UserTable` est à la ligne `at` : sa classe et son corps. Rend { table, warnings, end }, ou { warning, end } si
// la ligne n'est pas suivie d'une classe, ou { warnings, end } si la table est de celles qu'on ne copie pas.
function readTable(lines, inString, at) {
  let header = at + 1;
  while (header < lines.length && statementOf(lines[header]) === '') header++;
  const match = header < lines.length ? statementOf(lines[header]).match(CLASS_HEAD) : null;
  if (!match) return { warning: { key: 'copy.warn.decoratorNoClass', params: { line: at + 1 } }, end: at + 1 };
  const [, tableId] = match;
  const body = parseTableBody(lines, inString, header + 1, tableId);
  if (!isSafeId(tableId) || isReservedTableId(tableId)) {
    return { warnings: [{ key: 'copy.warn.reservedTableId', params: { line: header + 1, tableId }, table: tableId }], end: body.end };
  }
  return { table: { tableId, description: body.description, columns: body.columns }, warnings: body.warnings, end: body.end };
}

// Ce que le corps d'une classe donne à mesure qu'on lit ses instructions ; `source` : { lines, inString, bodyIndent }.
const newBody = (table, source) => ({ table, source, description: null, columns: [], warnings: [], triggers: new Map(), seen: new Set(), pendingType: null });

const warn = (body, key, params) => body.warnings.push({ key, params, table: body.table });

// Ajoute la colonne `column` lue à la ligne `line`, sauf si son identifiant est réservé ou déjà pris, ou s'il y en a trop.
function addColumn(body, column, line) {
  const { id } = column;
  if (!isSafeId(id) || isReservedColumnId(id)) warn(body, 'copy.warn.reservedColumnId', { line, colId: id });
  else if (body.seen.has(id.toLowerCase())) warn(body, 'copy.warn.duplicateColumnId', { line, colId: id });
  else if (body.columns.length >= COLUMNS_MAX) warn(body, 'copy.warn.tooManyColumns', { line, max: COLUMNS_MAX });
  else {
    body.seen.add(id.toLowerCase());
    body.columns.push({ ...column, line });
  }
}

// Comment chaque sorte d'instruction se lit. Une instruction est ce que `classify` a trouvé, avec son `text`, son numéro de `line` et
// son indice `index` dans les lignes ; sa lecture rend l'indice de sa dernière ligne (celui d'une fonction est plus bas).

// `@grist.formulaType(...)` donne son type à la colonne de formule qui suit.
function readFormulaType(body, statement) {
  if (body.pendingType) warn(body, 'copy.warn.formulaTypeDuplicate', { line: body.pendingType.line });
  body.pendingType = statement;
  return statement.index;
}

// Une fonction : la formule d'une colonne, ou la formule de déclenchement d'une colonne de données, lue plus loin.
function readFunction(body, statement) {
  const { lines, inString, bodyIndent } = body.source;
  const block = readBlock(lines, inString, statement.index + 1, bodyIndent);
  if (statement.kind === 'trigger') {
    body.triggers.set(statement.id, block.code);
  } else {
    const { dslType = 'Any', argsRaw = '' } = body.pendingType ?? {};
    addColumn(body, { id: statement.id, dslType, argsRaw, kind: 'formula', code: block.code }, statement.line);
    body.pendingType = null;
  }
  return block.end - 1;
}

function readColumn(body, statement) {
  if (body.pendingType) warn(body, 'copy.warn.formulaTypeNoFunction', { line: body.pendingType.line });
  body.pendingType = null;
  const { id, dslType, argsRaw } = statement;
  addColumn(body, { id, dslType, argsRaw, kind: 'data', code: '' }, statement.line);
  return statement.index;
}

function readUnknown(body, statement) {
  warn(body, statement.kind === 'unknownDecorator' ? 'copy.warn.unknownDecorator' : 'copy.warn.unrecognizedContent', { line: statement.line, snippet: snippet(statement.text) });
  return statement.index;
}

const READERS = {
  formulaType: readFormulaType,
  formula: readFunction,
  trigger: readFunction,
  column: readColumn,
  ignored: (body, statement) => statement.index,
  unknownDecorator: readUnknown,
  unknown: readUnknown,
};

// La description et les colonnes du corps de classe qui commence à `start` et finit à la première ligne moins indentée que lui.
function parseTableBody(lines, inString, start, table) {
  let i = start;
  while (i < lines.length && statementOf(lines[i]) === '') i++; // le corps commence à sa première instruction, pas à un commentaire qui la précède
  const bodyIndent = i < lines.length ? indentOf(lines[i]) : 0;
  if (bodyIndent === 0) return { description: null, columns: [], warnings: [], end: i };
  const body = newBody(table, { lines, inString, bodyIndent });
  let opening = true; // aucune instruction lue encore : un texte n'est la docstring que là
  for (; i < lines.length; i++) {
    const text = statementOf(lines[i]);
    const indent = indentOf(lines[i]);
    if (inString[i] || text === '' || indent > bodyIndent) continue;
    if (indent < bodyIndent) break;
    const docstring = opening ? parseString(text) : null;
    opening = false;
    if (docstring !== null) {
      body.description = docstring || null;
      continue;
    }
    const statement = { ...classify(text), text, line: i + 1, index: i };
    i = READERS[statement.kind](body, statement);
  }
  return finishBody(body, i);
}

// Ce que le corps a donné : un type de formule resté sans fonction est dit, et une formule de déclenchement rejoint sa colonne de données.
function finishBody(body, end) {
  if (body.pendingType) warn(body, 'copy.warn.formulaTypeNoFunction', { line: body.pendingType.line });
  for (const col of body.columns) if (col.kind === 'data' && body.triggers.has(col.id)) Object.assign(col, { kind: 'trigger', code: body.triggers.get(col.id) });
  return { description: body.description, columns: body.columns, warnings: body.warnings, end };
}
