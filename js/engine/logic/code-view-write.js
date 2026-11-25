// Le texte « Code View » d'après le schéma de tables, au format du `gencode.py` de Grist. Deux différences : une formule (ou une
// formule de déclenchement) garde la syntaxe `$col` de Grist (la réécrire en `rec.col` demanderait un lecteur de Python), et le
// constructeur d'une colonne peut porter des arguments de ce widget (voir buildKwargs). Ce texte se relit par code-view-parse.js.

import { buildTypeExpression, defaultLiteralForType } from './code-view-types.js';
import { indentOf, quotePython, stringLines } from './py-text.js';

const HEADER = 'import grist\n'
  + 'from functions import *       # fonctions globales en majuscules\n'
  + 'import datetime, math, re     # modules souvent utiles dans les formules\n';

const INDENT = '  ';
const STATEMENT_START = /^(return|if|for|while|with|try|raise|assert|import|def|class|pass)\b/;
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

// `tables` : celles de buildExportSchema (copy-read.js) : [{ tableId, description, columns: [{ colId, type, isFormula, formula, label,
// description, widgetOptions, visibleColId, reverseColId }] }].
export function generateCode(tables) {
  return HEADER + tables.map(table => `\n\n${tableText(table)}`).join('');
}

function tableText({ tableId, description, columns }) {
  const docstring = description ? `${INDENT}${quotePython(description)}\n` : ''; // la description de la table, sur une ligne comme celle d'une colonne
  const body = columns.length > 0 ? columns.map(fieldText).join('') : `${INDENT}pass\n`;
  return `@grist.UserTable\nclass ${tableId}:\n${docstring}${body}`;
}

function fieldText(col) {
  const kwargs = buildKwargs(col);
  const typeExpr = buildTypeExpression(col.type, kwargs);
  if (!col.isFormula) {
    const trigger = col.formula?.trim() ? `\n${INDENT}def _default_${col.colId}(rec, table, value, user):\n${formulaBody(col.formula)}\n` : '';
    return `${trigger}${INDENT}${col.colId} = ${typeExpr}\n`;
  }
  const typed = col.type !== 'Any' || Object.keys(kwargs).length > 0;
  const decorator = typed ? `${INDENT}@grist.formulaType(${typeExpr})\n` : '';
  return `\n${decorator}${INDENT}def ${col.colId}(rec, table):\n${formulaBody(col.formula, defaultLiteralForType(col.type))}\n`;
}

// Ce qu'une colonne dit en plus de son type, en Python : seulement ce qu'il y a à dire. Les options (déjà contrôlées par
// copyOptions) vont dans `widget_options`, sauf la liste de choix, qui a son `choices=[...]`.
function buildKwargs(col) {
  const { choices, ...others } = isObject(col.widgetOptions) ? col.widgetOptions : {};
  return {
    ...(col.reverseColId && { reverse_of: quotePython(col.reverseColId) }),
    ...(Array.isArray(choices) && choices.length > 0 && { choices: `[${choices.map(quotePython).join(', ')}]` }),
    ...(Object.keys(others).length > 0 && { widget_options: quotePython(JSON.stringify(others)) }),
    ...(col.label && col.label !== col.colId && { label: quotePython(col.label) }),
    ...(col.description && { description: quotePython(col.description) }),
    ...(col.visibleColId && { visible_col: quotePython(col.visibleColId) }),
  };
}

// Le corps d'une fonction de formule : une formule d'une ligne devient `return <formule>` (sauf si c'est déjà une instruction), une
// formule vide rend la valeur vide du type (`blankLiteral`).
function formulaBody(formula, blankLiteral) {
  const text = String(formula ?? '');
  const body = INDENT + INDENT;
  if (!text.trim()) return `${body}return ${blankLiteral}`;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) return body + (STATEMENT_START.test(text.trim()) ? text.trim() : `return ${text.trim()}`);
  return multilineBody(lines, body);
}

// Les lignes d'un texte sur plusieurs lignes font partie du texte : écrites telles quelles, comme Grist depuis la 1.7.20, quand l'une
// est moins indentée que le code (c'est ainsi que le lecteur reconnaît cette mise en page), sinon indentées avec lui, comme Grist avant.
function multilineBody(lines, body) {
  const inString = stringLines(lines);
  const common = lines.reduce((least, line, i) => (inString[i] || line.trim() === '' ? least : Math.min(least, indentOf(line))), Infinity);
  const asWritten = lines.some((line, i) => inString[i] && line.trim() !== '' && indentOf(line) < body.length);
  return lines.map((line, i) => {
    if (inString[i] && asWritten) return line;
    if (line === '' || (!inString[i] && line.trim() === '')) return ''; // des espaces seuls dans un texte en font partie
    return body + (inString[i] ? line : line.slice(common));
  }).join('\n');
}
