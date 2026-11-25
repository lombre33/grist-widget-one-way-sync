// Les types de colonne de Grist, entre le `type` d'une colonne (« Ref:People ») et son constructeur dans la « Code View » de Grist
// (`grist.Reference('People')`), et ce qu'une colonne dit en plus de son type (étiquette, description, choix, format, colonne
// affichée, lien réciproque). Lu pour la copie unique (voir code-view-parse.js) ; chaque valeur lue passe par les contrôles de
// ce moteur (identifiants sûrs, options connues, textes nettoyés et bornés) avant de pouvoir être écrite dans un document.

import { parseArguments, parseString, parseStringList, quotePython } from './py-text.js';
import { ARCHIVE_COL, KEY_COL, ORDER_COL, RECALC_COL, isSafeId, parseJson } from './common.js';
import { cleanNote } from './descriptions.js';
import { columnOptions } from './options.js';

// Identifiants que Grist garde pour lui, et colonnes que le widget pose lui-même dans les tables qu'il synchronise (la clé,
// l'heure de modification, l'archive, ses états) : ni l'une ni l'autre ne se copie, et un texte collé ne peut pas en créer.
const RESERVED = new Set(['id', 'manualsort', KEY_COL, ORDER_COL, RECALC_COL, ARCHIVE_COL].map(id => id.toLowerCase()));
const RESERVED_PREFIX = /^(?:gristhelper_|synchro_|sync_)/i;
export const isReservedColumnId = colId => RESERVED.has(String(colId).toLowerCase()) || RESERVED_PREFIX.test(colId);

const DEFAULT_TIMEZONE = 'UTC';
// À quoi ressemble le nom d'un fuseau horaire (`UTC`, `Europe/Paris`, `America/Argentina/Buenos_Aires`, `Etc/GMT+5`) : il entre
// dans le type de la colonne, que Grist écrit dans le code généré du document, rien d'autre ne doit y aller.
const TIMEZONE = /^[A-Za-z][A-Za-z0-9_+-]{0,39}(?:\/[A-Za-z0-9_+-]{1,40}){0,3}$/;
const SHOWN_LENGTH = 40; // d'un texte donné par la personne, quand une remarque le cite
const shown = text => (text.length > SHOWN_LENGTH ? `${text.slice(0, SHOWN_LENGTH)}…` : text);
const EMPTY_LIST = /^\[\s*\]$/;
export const OPTIONS_JSON_MAX = 20000; // caractères du JSON de `widget_options`, comme les options envoyées par un export
export const COPY_NOTE_MAX = 2000; // description d'une colonne ou d'une table, dans un texte copié à la main (le lot d'un envoi la borne plus bas)
export const COPY_LABEL_MAX = 200; // étiquette d'une colonne

// dsl : le nom du constructeur dans la Code View ; blank : la valeur Python d'une formule vide (`_type_defaults` de usertypes.py) ;
// arg : ce qu'est le premier argument du constructeur, s'il en a un ; choices : s'il liste des choix.
const TYPES = {
  Text: { dsl: 'Text', blank: '\'\'' },
  Numeric: { dsl: 'Numeric', blank: '0.0' },
  Int: { dsl: 'Int', blank: '0' },
  Bool: { dsl: 'Bool', blank: 'False' },
  Date: { dsl: 'Date', blank: 'None' },
  DateTime: { dsl: 'DateTime', blank: 'None', arg: 'timezone' },
  Choice: { dsl: 'Choice', blank: '\'\'', choices: true },
  ChoiceList: { dsl: 'ChoiceList', blank: 'None', choices: true },
  Ref: { dsl: 'Reference', blank: '0', arg: 'table' },
  RefList: { dsl: 'ReferenceList', blank: 'None', arg: 'table' },
  Attachments: { dsl: 'Attachments', blank: 'None' },
  Blob: { dsl: 'Blob', blank: 'None' },
  Any: { dsl: 'Any', blank: 'None' },
};
const TYPE_OF_DSL = new Map(Object.entries(TYPES).map(([type, { dsl }]) => [dsl, type])); // une Map : `constructor` n'est pas un type

// « Ref:People » donne { name: 'Ref', arg: 'People' }.
export function splitType(type) {
  const colon = type.indexOf(':');
  return colon === -1 ? { name: type, arg: '' } : { name: type.slice(0, colon), arg: type.slice(colon + 1) };
}

// Les options d'une colonne qui voyagent dans un texte : celles que le moteur envoie déjà avec un export (liste blanche de
// `columnOptions`, couleurs et formats contrôlés), pour un type qui n'en a pas de propre (une Référence, des pièces jointes,
// `Any`) celles d'un texte (alignement, retour à la ligne, couleurs). Un texte peut en plus rester un lien (`HyperLink`) ou du texte
// mis en forme (`Markdown`) : une copie de structure ne porte aucune cellule, rien de reçu ne devient donc cliquable. Les règles de
// mise en forme conditionnelle ne voyagent pas par ce texte (elles vivent dans des colonnes cachées). Null s'il ne reste rien.
const OPTIONS_LIKE = { Ref: 'Text', RefList: 'Text', Attachments: 'Text', Any: 'Text' };
const TEXT_WIDGETS = ['HyperLink', 'Markdown'];
export function copyOptions(type, widgetOptions) {
  const name = splitType(String(type || '')).name;
  const kept = columnOptions(OPTIONS_LIKE[name] || name, widgetOptions, { extras: true }) || {};
  const { rules, ...rest } = kept;
  const raw = typeof widgetOptions === 'string' ? parseJson(widgetOptions, null) : widgetOptions;
  if (name === 'Text' && TEXT_WIDGETS.includes(raw?.widget)) rest.widget = raw.widget;
  return Object.keys(rest).length ? rest : null;
}

// Lit le constructeur d'une colonne (`dslType`, `argsRaw` : le texte entre ses parenthèses). Les remarques ({ key, params })
// vont dans `warnings` ; un type inutilisable devient `Any`.
// Rend { type, widgetOptions, refTarget, label, description, visibleColId, reverseColId }.
export function resolveColumnType(dslType, argsRaw, colId, warnings) {
  const { positional, kwargs } = parseArguments(argsRaw);
  const warn = (key, params) => warnings.push({ key, params: { colId, ...params } });
  const readString = option => stringOption(kwargs, option, warn);
  const { type, refTarget } = typeOf(dslType, positional, warn);
  const hasChoices = TYPES[TYPE_OF_DSL.get(dslType)]?.choices;
  const choices = hasChoices ? readChoices(kwargs.choices, given => warn('copy.warn.unreadableOption', { option: 'choices', given })) : null;
  const options = copyOptions(type, { ...restoredOptions(readString('widget_options'), warn), ...(choices && { choices }) });
  return {
    type,
    widgetOptions: options,
    refTarget,
    label: cleanText(readString('label'), COPY_LABEL_MAX),
    description: cleanText(readString('description'), COPY_NOTE_MAX),
    visibleColId: safeId(readString('visible_col')),
    reverseColId: safeId(readString('reverse_of')),
  };
}

// Le texte donné pour `option` ; une option qui est là sans être un littéral de texte est dite ignorée.
function stringOption(kwargs, option, warn) {
  const value = parseString(kwargs[option]);
  if (value === null && kwargs[option] !== undefined) warn('copy.warn.unreadableOption', { option, given: shown(kwargs[option]) });
  return value;
}

const cleanText = (text, max) => cleanNote(text, max) || null;
const safeId = text => (isSafeId(text) ? text : null);

// Le type d'une colonne d'après le nom du constructeur et son premier argument, avec la table qu'une référence vise (null pour
// les autres) ; ce qui ne se lit pas devient `Any`, avec une remarque.
function typeOf(dslType, positional, warn) {
  const name = TYPE_OF_DSL.get(dslType);
  if (!name) {
    warn('copy.warn.unknownType', { dslType: shown(dslType) });
    return { type: 'Any', refTarget: null };
  }
  const { arg } = TYPES[name];
  if (arg === 'table') {
    const refTarget = parseString(positional[0]);
    if (isSafeId(refTarget)) return { type: `${name}:${refTarget}`, refTarget };
    warn('copy.warn.refTargetMissingSyntax', { dslType });
    return { type: 'Any', refTarget: null };
  }
  return { type: arg === 'timezone' ? `${name}:${timezoneOf(positional[0], warn)}` : name, refTarget: null };
}

// Le fuseau d'une colonne Date et heure ; un nom qui n'en est pas un, ou pas de nom, donne UTC, avec une remarque.
function timezoneOf(source, warn) {
  const given = parseString(source);
  if (given && TIMEZONE.test(given)) return given;
  warn(given ? 'copy.warn.dateTimeBadTimezone' : 'copy.warn.dateTimeNoTimezone', { timezone: DEFAULT_TIMEZONE, given: shown(given ?? '') });
  return DEFAULT_TIMEZONE;
}

// L'argument `choices=[...]` en liste de textes ; ce qui ne s'y lit pas est laissé de côté et dit, par `unreadable`, avec ce qui était donné.
function readChoices(source, unreadable) {
  if (source === undefined) return null;
  let skipped = false;
  const choices = parseStringList(source, () => { skipped = true; });
  if (skipped || (choices === null && !EMPTY_LIST.test(source))) unreadable(shown(source));
  return choices;
}

// L'argument `widget_options='<JSON>'` : lu comme du JSON (jamais évalué), un objet ; ce qui n'en est pas un, ou est trop long, est dit et laissé.
function restoredOptions(json, warn) {
  if (!json) return null;
  const parsed = json.length <= OPTIONS_JSON_MAX ? parseJson(json, null) : null;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  warn('copy.warn.invalidWidgetOptions');
  return null;
}

// Le constructeur d'un type de colonne, écrit comme la Code View (`get_grist_type` de gencode.py). `kwargs` : d'autres arguments,
// déjà du texte Python : { label: "'Nom'" } donne `label='Nom'`.
export function buildTypeExpression(type, kwargs = {}) {
  const { name, arg } = splitType(type);
  const args = [...(arg ? [quotePython(arg.trim())] : []), ...Object.entries(kwargs).map(([key, value]) => `${key}=${value}`)];
  return `grist.${TYPES[name]?.dsl ?? name}(${args.join(', ')})`;
}

// La valeur Python d'une colonne vide de ce type, `''` pour un texte.
export function defaultLiteralForType(type) {
  return TYPES[splitType(type).name]?.blank ?? 'None';
}
