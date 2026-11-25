// Ce que la copie unique fait d'un texte une fois lu (code-view-parse.js) : les colonnes en définitions de colonnes de Grist, les
// identifiants de tables et de colonnes que Grist garderait, les formules lues avant d'être posées, et les liens dans les deux sens
// (deux colonnes Référence qui se nomment l'une l'autre). Rien ici n'écrit dans un document : voir engine/copy.js.

import { defaultLiteralForType, resolveColumnType, splitType } from './code-view-types.js';
import { elementCounts, omitElements } from './copy-elements.js';
import { formulaProblems } from './column-formulas.js';

// Les identifiants de tables que Grist crée tels quels. Il réécrit tout autre (majuscule en tête, ASCII seul, « None » en « TNone »…)
// et renomme ceux qui en heurtent un autre, quelle que soit la casse, en y ajoutant un numéro.
const TABLE_ID = /^[A-Z][A-Za-z0-9_]*$/;
const PYTHON_CONSTANTS = new Set(['None', 'True', 'False']);
const PYTHON_KEYWORDS = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));

// L'identifiant que Grist garderait pour une table appelée `sourceId` dans le texte.
export function defaultTableId(sourceId) {
  const id = sourceId.replace(/^_+/, '');
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// La clé de texte de ce qui ne va pas dans l'identifiant `id` d'une table à créer, ou null. `documentTableIds` : les tables du document ;
// `otherIds` : les autres tables créées en même temps.
export function checkTableId(id, documentTableIds, otherIds) {
  if (!id) return 'copy.validation.emptyId';
  if (!TABLE_ID.test(id) || PYTHON_CONSTANTS.has(id)) return 'copy.validation.invalidId';
  const same = other => other.toLowerCase() === id.toLowerCase();
  if (otherIds.some(same)) return 'copy.validation.duplicateId';
  if (documentTableIds?.some(same)) return 'copy.validation.tableExists';
  return null;
}

// L'identifiant de colonne que Grist tire d'une étiquette (`pick_col_ident` de son moteur, sans le numéro des doublons) : accents ôtés,
// autres caractères remplacés par `_`, `c` devant un chiffre ou un mot réservé. Une colonne dont l'identifiant n'est pas celui-là a
// reçu le sien à part de son étiquette.
export function idFromLabel(label) {
  let id = label.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '');
  if (/^\d/.test(id)) id = `c${id}`;
  if (PYTHON_KEYWORDS.has(id)) id = `c${id}`;
  return id;
}

// Si `id` est ce que Grist a tiré de `label` : cet identifiant, numéroté à partir de 2 quand il était pris (`ID2`, `Col1_2` après un
// chiffre), ou des lettres (`A`, `B`…) quand il ne reste rien de l'étiquette. Tout autre identifiant a été donné à la colonne à part de
// son étiquette : Grist ne le renomme alors plus quand l'étiquette change.
export function isTied(label, id) {
  const base = idFromLabel(label);
  if (!base) return /^[A-Z]+$/.test(id);
  const number = /\d$/.test(base) ? /^_(?:[2-9]|[1-9]\d+)$/ : /^(?:[2-9]|[1-9]\d+)$/;
  return id.startsWith(base) && (id === base || number.test(id.slice(base.length)));
}

export const isUntied = col => Boolean(col.label) && !isTied(col.label, col.id);

// Une colonne de formule, ou de données à formule de déclenchement : ce qu'une copie ne refait pas sans `withFormulas` (une formule vide n'en est pas une).
export const isComputed = col => col.formula !== '';

// La formule que Grist garde pour le corps d'une fonction de la Code View : un `return X` seul est X, et ce que rend une formule vide
// pour le type (`return None`) veut dire pas de formule.
function formulaOf(code, type) {
  const formula = code.replace(/^return(\s+|$)/, '').trim();
  return formula === defaultLiteralForType(type) ? '' : formula;
}

// Le type d'une Référence dont la table visée (`resolved.refTarget`) devient `target`, ou `Any` avec une remarque si elle n'existe pas.
function pointRef(resolved, col, { tableIds, documentTableIds }, warnings) {
  const inDocument = !documentTableIds || documentTableIds.includes(resolved.refTarget);
  const target = tableIds.get(resolved.refTarget) ?? (inDocument ? resolved.refTarget : null);
  if (target) {
    resolved.type = `${splitType(resolved.type).name}:${target}`;
    return;
  }
  warnings.push({ key: 'copy.warn.refTargetMissingInDoc', params: { colId: col.id, target: resolved.refTarget } });
  Object.assign(resolved, { type: 'Any', widgetOptions: null, visibleColId: null, reverseColId: null });
}

// Ce qui empêche de poser la formule d'une colonne (liste de { code, name, to? } de formulaProblems ; vide : rien) : la même lecture
// que pour une formule reçue d'une SOURCE, avec pour tables celles qu'on crée (leur nom dans le texte, vers celui qu'elles auront ici).
function problemsOf(formula, context) {
  if (!formula) return [];
  const every = new Set([...(context.documentTableIds || []), ...context.tableIds.values()]);
  return formulaProblems(formula, { here: context.here, tables: context.tableIds, every });
}

// Les définitions de colonnes de Grist pour les colonnes lues de `table`. `tableIds` donne, pour chaque table du texte qui reçoit
// des colonnes, son identifiant dans le document ; `documentTableIds` (null si inconnu) liste les tables déjà là. Une Référence
// n'en reste une que si sa table visée est l'une d'elles, sinon la colonne devient `Any`. Les colonnes de `excluded` ne disent rien ;
// `withFormulas` dit qu'on pose les formules (celles qu'une lecture refuse ne sont pas posées, la colonne est créée vide, et c'est
// dit) ; les colonnes arrivent sans les éléments de `omit` (voir copy-elements.js) ; `existing` : les colonnes déjà dans la table
// (mode « table existante »), qu'une formule peut citer ; `counts` : combien de colonnes non exclues portent chaque élément.
export function resolveColumns(table, tableIds, documentTableIds, { excluded = new Set(), withFormulas = false, omit = new Set(), existing = [] } = {}) {
  const warnings = [];
  const here = new Set([...table.columns.map(col => col.id), ...existing]);
  const context = { tableIds, documentTableIds, here };
  const columns = table.columns.map((col) => {
    const colWarnings = excluded.has(col.id) ? [] : warnings;
    const resolved = resolveColumnType(col.dslType, col.argsRaw, col.id, colWarnings);
    const formula = formulaOf(col.code, resolved.type);
    if (resolved.refTarget) pointRef(resolved, col, context, colWarnings);
    const problems = withFormulas ? problemsOf(formula, context) : [];
    return { id: col.id, kind: col.kind, formula, problems, ...resolved };
  });
  warnings.push(...formulaWarnings(columns.filter(col => !excluded.has(col.id)), withFormulas));
  const kept = columns.filter(col => !excluded.has(col.id));
  return { columns: columns.map(col => omitElements(col, omit)), warnings, counts: elementCounts(kept) };
}

// Ce qui est dit des formules : sans `withFormulas`, que les colonnes calculées sont créées vides ; avec, que celles qu'une lecture refuse le sont aussi.
function formulaWarnings(columns, withFormulas) {
  if (!withFormulas) {
    const computed = columns.filter(isComputed);
    return computed.length > 0 ? [{ key: 'copy.warn.computedColumns', params: { columns: computed.map(col => col.id).join(', ') } }] : [];
  }
  return columns.filter(col => col.problems.length > 0).map(col => ({
    key: 'copy.warn.formulaRefused',
    params: { colId: col.id, names: [...new Set(col.problems.map(problem => problem.name))].slice(0, 6).join(', ') },
  }));
}

// La formule d'une colonne résolue est-elle posée : demandée (`withFormulas`) et sans objection.
export const formulaApplies = (col, withFormulas) => withFormulas && col.problems.length === 0;

const keyOf = (tableId, colId) => `${tableId}.${colId}`;

// Les liens dans les deux sens parmi `tables` (`[{ id, columns }]`) : deux colonnes qui se nomment chacune dans `reverse_of` et visent la
// table de l'autre, en `[{ tableId, col }, { tableId, col }]`. Seules des colonnes créées ensemble peuvent être liées : lier une
// colonne qui existe écraserait ses valeurs.
export function twoWayPairs(tables) {
  const all = tables.flatMap(({ id, columns }) => columns.map(col => ({ tableId: id, col })));
  const byKey = new Map(all.map(entry => [keyOf(entry.tableId, entry.col.id), entry]));
  return all.flatMap((entry, i) => {
    const other = entry.col.reverseColId && byKey.get(keyOf(splitType(entry.col.type).arg, entry.col.reverseColId));
    const mutual = other && other.col.reverseColId === entry.col.id && splitType(other.col.type).arg === entry.tableId;
    return mutual && i < all.indexOf(other) ? [[entry, other]] : []; // chaque paire une fois, depuis l'entrée qui vient en premier
  });
}

// Les colonnes de `tables` qu'un lien dans les deux sens joint.
export const linkedColumns = tables => new Set(twoWayPairs(tables).flat().map(({ col }) => col));

// Ce qui est dit, par table, des liens dans les deux sens que `tables` ne peut pas faire : ils deviennent de simples références.
export function twoWayWarnings(tables) {
  const linked = linkedColumns(tables);
  return tables.flatMap(({ id, columns }) => {
    const plain = columns.filter(col => col.reverseColId && !linked.has(col));
    return plain.length > 0 ? [{ key: 'copy.warn.twoWayColumns', params: { columns: plain.map(col => col.id).join(', ') }, table: id }] : [];
  });
}
