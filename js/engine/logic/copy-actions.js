// Les actions de Grist que la copie unique envoie : créer des tables avec leurs colonnes, ajouter des colonnes à une table, puis ce
// que ces actions ne savent pas faire (descriptions, colonne affichée d'une Référence, identifiant qui ne suit plus son étiquette,
// lien dans les deux sens). Rien ici n'écrit : les actions se construisent, engine/copy.js les envoie.

import { splitType, isReservedColumnId } from './code-view-types.js';
import { isReservedTableId } from './code-view-parse.js';
import { formulaApplies, isUntied, twoWayPairs } from './copy-resolve.js';
import { isSafeId } from './common.js';

// La colonne telle que `AddTable` et `AddVisibleColumn` la reçoivent. Une formule n'y est que si la personne l'a demandée et que
// la lecture n'a rien à y redire (formulaApplies) ; sinon la colonne est créée vide.
export function columnPayload(col, withFormulas) {
  const applies = formulaApplies(col, withFormulas);
  return {
    id: col.id,
    type: col.type,
    isFormula: applies && col.kind === 'formula',
    formula: applies ? col.formula : '',
    label: col.label || col.id,
    ...(col.widgetOptions && { widgetOptions: JSON.stringify(col.widgetOptions) }),
  };
}

// Ce qu'on refuse d'écrire, quoi que dise le texte : une table ou une colonne qui n'a pas un identifiant sûr, ou qui porte un nom que
// Grist ou le widget gardent pour eux. Rend la liste des noms refusés (vide : rien à redire). Lu juste avant l'écriture : ce qui
// arrive jusqu'ici a déjà été écarté à la lecture, c'est la ceinture après les bretelles.
export function refusedNames(tables) {
  return tables.flatMap(({ id, columns }) => [
    ...(!isSafeId(id) || isReservedTableId(id) ? [id] : []),
    ...columns.filter(col => !isSafeId(col.id) || isReservedColumnId(col.id)).map(col => `${id}.${col.id}`),
  ]);
}

// Les tables à créer d'un coup (`[{ id, columns }]`), une seule action pour chacune : le lot est atomique, Grist le défait en entier s'il échoue.
export const createActions = (tables, withFormulas) => tables.map(({ id, columns }) => ['AddTable', id, columns.map(col => columnPayload(col, withFormulas))]);

// `AddVisibleColumn` ajoute la colonne aux vues de la table aussi : sans cela elle arrive cachée.
export const addColumnActions = (tableId, columns, withFormulas) => columns.map(col => ['AddVisibleColumn', tableId, col.id, columnPayload(col, withFormulas)]);

// Les colonnes (avec leur `tableId`) qui ont une description, une colonne affichée, ou un identifiant resté tel qu'écrit : ce que la
// création ne sait pas faire ; et les tables qui ont une description.
export function detailsOf(tables) {
  const columns = tables.flatMap(({ id, columns: list }) => list.filter(col => col.description || col.visibleColId || isUntied(col)).map(col => ({ ...col, tableId: id })));
  return { columns, described: tables.filter(table => table.description) };
}

// Numéro de ligne d'une colonne du document (`doc` : voir readDocument), d'après l'identifiant de sa table et le sien.
export function columnRef(doc, tableId, colId) {
  const table = doc.tables.find(candidate => candidate.tableId === tableId);
  return table && doc.allColumns.find(col => col.parentId === table.tableRef && col.colId === colId)?.id;
}

// Numéro de ligne de la colonne que `col.visibleColId` désigne dans la table que `col` vise.
const displayColumnRef = (doc, col) => columnRef(doc, splitType(col.type).arg, col.visibleColId);

// La description d'une table est celle de sa section de données brutes : c'est là qu'on l'écrit.
export const descriptionActions = (doc, described) => described.flatMap(({ id, description }) => {
  const section = doc.tables.find(table => table.tableId === id)?.rawViewSectionRef;
  return section ? [['UpdateRecord', '_grist_Views_section', section, { description }]] : [];
});

// Ce que `col` reçoit en plus : sa description, sa colonne affichée (avec la colonne d'affichage que Grist calcule), et le droit de
// garder son identifiant quand l'étiquette change.
export function columnActions(doc, col) {
  const displayRef = col.visibleColId ? displayColumnRef(doc, col) : null;
  const changes = {
    ...(col.description && { description: col.description }),
    ...(displayRef && { visibleCol: displayRef }),
    ...(isUntied(col) && { untieColIdFromLabel: true }),
  };
  return [
    ...(Object.keys(changes).length > 0 ? [['ModifyColumn', col.tableId, col.id, changes]] : []),
    ...(displayRef ? [['SetDisplayFormula', col.tableId, null, columnRef(doc, col.tableId, col.id), `$${col.id}.${col.visibleColId}`]] : []),
  ];
}

// Les colonnes d'affichage demandées que leur table n'a pas : { colId, visibleColId, target }.
export const missingDisplays = (doc, columns) => columns
  .filter(col => col.visibleColId && !displayColumnRef(doc, col))
  .map(col => ({ colId: col.id, visibleColId: col.visibleColId, target: splitType(col.type).arg }));

// Les liens dans les deux sens : `ModifyColumn { reverseCol }` sur un des deux bouts de chaque paire (`[{ tableId, id }, { tableId, id }]`) ;
// Grist met l'autre bout d'accord.
export const linkActions = (doc, pairs) => pairs.map(([column, counterpart]) => ['ModifyColumn', column.tableId, column.id, { reverseCol: columnRef(doc, counterpart.tableId, counterpart.id) }]);

// Les paires de colonnes à lier, avec les identifiants que Grist a donnés (`requested` : les tables comme on les a demandées, `created` :
// les mêmes comme Grist les a nommées, colonne pour colonne).
export function pairsToLink(requested, created) {
  const placed = new Map(requested.flatMap(({ columns }, i) => columns.map((col, j) => [col, { tableId: created[i].id, id: created[i].columns[j].id }])));
  return twoWayPairs(requested).map(pair => pair.map(({ col }) => placed.get(col)));
}
