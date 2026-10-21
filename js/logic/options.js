// Listes de choix et formats d'une colonne (widgetOptions de Grist) : la SOURCE les envoie avec la
// description des colonnes (`opts`), la CIBLE les reprend dans les colonnes qu'elle a créées. Rien
// n'est changé dans une colonne que la CIBLE a choisie : seules ses colonnes à elle sont complétées,
// et seulement de ce qui leur manque (un choix ajouté à la SOURCE s'ajoute à la liste ; un format
// retouché ici reste). Dans les deux sens, seules des clés connues aux valeurs contrôlées passent.
const COLOR = /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/;
const FORMAT = /^[A-Za-z0-9 .,:;/_'()[\]-]{1,40}$/; // format de date ou d'heure (moment.js)
const bool = v => typeof v === 'boolean';
const oneOf = list => v => list.includes(v);
const int = max => v => Number.isInteger(v) && v >= 0 && v <= max;
const STYLE = {
  fillColor: v => COLOR.test(v), textColor: v => COLOR.test(v),
  fontBold: bool, fontItalic: bool, fontUnderline: bool, fontStrikethrough: bool,
};
const COMMON = { alignment: oneOf(['left', 'center', 'right']), wrap: bool, ...STYLE };
const NUMBER = {
  numMode: oneOf(['currency', 'decimal', 'percent', 'scientific']), currency: v => /^[A-Z]{3}$/.test(v), numSign: oneOf(['parens']),
  decimals: int(10), maxDecimals: int(10), widget: oneOf(['TextBox', 'Spinner']),
};
const DATE = { dateFormat: v => FORMAT.test(v), isCustomDateFormat: bool };
const KEYS = {
  Text: { widget: oneOf(['TextBox']) }, // ni HyperLink ni Markdown : le texte reçu ne devient pas un lien cliquable ni du texte mis en forme
  Bool: { widget: oneOf(['CheckBox', 'Switch', 'TextBox']) },
  Numeric: NUMBER,
  Int: NUMBER,
  Date: DATE,
  DateTime: { ...DATE, timeFormat: v => FORMAT.test(v), isCustomTimeFormat: bool },
  Choice: {},
  ChoiceList: {},
};
const CHOICES_MAX = 500;
const CHOICE_LEN = 200;
const OPTS_MAX = 20000; // caractères de JSON par colonne : au-delà, les couleurs des choix, puis rien

const parse = (value) => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
};
const isChoice = type => type === 'Choice' || type === 'ChoiceList';

function choicesOf(raw) {
  const choices = Array.isArray(raw.choices) ? [...new Set(raw.choices.filter(c => typeof c === 'string' && c && c.length <= CHOICE_LEN))].slice(0, CHOICES_MAX) : [];
  const given = raw.choiceOptions && typeof raw.choiceOptions === 'object' ? raw.choiceOptions : {};
  const choiceOptions = Object.fromEntries(choices.filter(c => Object.hasOwn(given, c)).map(c => [c, pick(given[c], STYLE)])
    .filter(([, style]) => Object.keys(style).length));
  return { ...(choices.length ? { choices } : {}), ...(Object.keys(choiceOptions).length ? { choiceOptions } : {}) };
}

function pick(raw, keys) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(Object.entries(keys).filter(([k, ok]) => Object.hasOwn(source, k) && ok(source[k])).map(([k]) => [k, source[k]]));
}

// Options d'une colonne de type `type` (celui qu'elle a dans l'autre document : une Référence part
// en texte), contrôlées ; null s'il n'y en a pas.
export function columnOptions(type, widgetOptions) {
  const base = String(type || '').split(':')[0];
  if (!KEYS[base]) return null;
  const raw = parse(widgetOptions);
  let opts = { ...pick(raw, { ...COMMON, ...KEYS[base] }), ...(isChoice(base) ? choicesOf(raw) : {}) };
  if (JSON.stringify(opts).length > OPTS_MAX) delete opts.choiceOptions;
  if (JSON.stringify(opts).length > OPTS_MAX) opts = {};
  return Object.keys(opts).length ? opts : null;
}

// Options d'une colonne d'ici (`current`, widgetOptions) complétées par celles reçues (`sent`) :
// clés absentes ajoutées, choix nouveaux ajoutés en fin de liste avec leurs couleurs. Rend le texte
// à écrire, ou null si rien ne manque.
export function fillOptions(type, current, sent) {
  const here = parse(current);
  const wanted = columnOptions(type, sent);
  if (!wanted) return null;
  const next = { ...here };
  for (const [k, v] of Object.entries(wanted)) if (!['choices', 'choiceOptions'].includes(k) && !Object.hasOwn(here, k)) next[k] = v;
  if (wanted.choices) {
    const had = Array.isArray(here.choices) ? here.choices : [];
    const added = wanted.choices.filter(c => !had.includes(c)).slice(0, Math.max(0, CHOICES_MAX - had.length)); // la liste d'ici reste bornée
    if (added.length) next.choices = [...had, ...added];
    const styles = Object.entries(wanted.choiceOptions || {}).filter(([c]) => added.includes(c));
    if (styles.length) next.choiceOptions = { ...(here.choiceOptions || {}), ...Object.fromEntries(styles) };
  }
  return JSON.stringify(next) === JSON.stringify(here) ? null : JSON.stringify(next);
}

// Colonne d'ici qu'on peut compléter : créée par le widget (`own`, colonnes envoyées notées à la
// création), ou, pour une réception d'avant la 0.12 (`own` absent), une colonne de choix sans
// aucun choix (le widget les créait ainsi).
export const ownsColumn = (own, sentId, column) => (own ? own.includes(sentId)
  : isChoice(column.type) && !(parse(column.widgetOptions).choices || []).length);
