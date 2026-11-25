// Ce qu'une colonne (ou une table) dit en plus de son type, que la personne garde ou laisse de côté d'un bloc, à l'export
// comme à l'import de la copie unique. Chaque sorte est comptée sur les colonnes (les tables) qui la portent vraiment : seules
// celles-là sont proposées.

export const ELEMENTS = ['labels', 'descriptions', 'tableDescriptions', 'choices', 'options', 'displayColumns', 'twoWay', 'formulas'];

// Clé de texte (`copy.el.<élément>`) du nom de chaque élément, et de la ligne qui dit ce qu'il est (`.hint`).
export const elementKey = element => `copy.el.${element}`;
export const elementHint = element => `copy.el.${element}.hint`;

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const CHOICE_KEYS = new Set(['choices', 'choiceOptions']);
const filled = object => (Object.keys(object).length > 0 ? object : null);

// Ce que des options (déjà contrôlées) portent de chaque sorte : une liste de choix avec ses couleurs, d'autres réglages d'affichage.
export function optionKinds(options) {
  const keys = isObject(options) ? Object.keys(options) : [];
  return {
    choices: (Array.isArray(options?.choices) && options.choices.length > 0) || keys.includes('choiceOptions'),
    display: keys.some(key => !CHOICE_KEYS.has(key)),
  };
}

// Les options sans ce qu'on laisse de côté (`choices` : la liste de choix, `display` : le reste), ou null s'il n'en reste rien.
export function selectOptions(options, { choices, display }) {
  if (!isObject(options)) return null;
  return filled(Object.fromEntries(Object.entries(options).filter(([key]) => (CHOICE_KEYS.has(key) ? choices : display))));
}

// Les éléments d'une colonne : une colonne du schéma d'export (`colId`) ou lue d'un texte (`id`).
function elementsOf(col) {
  const kinds = optionKinds(col.widgetOptions);
  return {
    labels: Boolean(col.label) && col.label !== (col.colId ?? col.id),
    descriptions: Boolean(col.description),
    choices: kinds.choices,
    options: kinds.display,
    displayColumns: Boolean(col.visibleColId),
    twoWay: Boolean(col.reverseColId),
    formulas: Boolean(col.formula?.trim()),
  };
}

// Combien de `columns` portent chaque élément, et combien de `tables` (celles qui ont une `description`) portent le leur.
export function elementCounts(columns, tables = []) {
  const found = columns.map(elementsOf);
  const counts = Object.fromEntries(ELEMENTS.map(element => [element, found.filter(has => has[element]).length]));
  return { ...counts, tableDescriptions: tables.filter(table => table.description).length };
}

// La somme de plusieurs `elementCounts`.
export const sumCounts = list => Object.fromEntries(ELEMENTS.map(element => [element, list.reduce((total, counts) => total + counts[element], 0)]));

// La table comme si elle n'avait pas de description quand `omitted` (un Set d'éléments) le dit.
export const omitTable = (table, omitted) => ({ ...table, description: omitted.has('tableDescriptions') ? null : table.description });

// La colonne comme si elle ne portait aucun des éléments de `omitted`, sauf sa formule, que chaque onglet traite à sa façon : l'export
// écrit la colonne en données, l'import la crée vide sauf demande.
export function omitElements(col, omitted) {
  return {
    ...col,
    label: omitted.has('labels') ? null : col.label,
    description: omitted.has('descriptions') ? null : col.description,
    widgetOptions: selectOptions(col.widgetOptions, { choices: !omitted.has('choices'), display: !omitted.has('options') }),
    visibleColId: omitted.has('displayColumns') ? null : col.visibleColId,
    reverseColId: omitted.has('twoWay') ? null : col.reverseColId,
  };
}
