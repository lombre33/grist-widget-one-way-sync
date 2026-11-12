// Formules des colonnes, que la SOURCE peut envoyer avec ses colonnes (case « Formules » de l'assistant d'export,
// à part, jamais cochée d'emblée) et que la CIBLE ne pose que sur le clic d'un propriétaire, après lecture.
//
// Une formule est du Python que Grist exécute sur les données du document. Rien de ce fichier ne l'interprète : il la
// nettoie, la borne, la lit pour dire à la personne ce qu'elle cite (colonnes, tables) et refuse d'office ce qui n'a rien à
// faire dans une formule de colonne (modules système, accès aux entrailles de Python). Ce n'est pas une garantie : le
// bac à sable de Grist et la lecture de la personne restent les vraies protections (SECURITY.md).
//
// Dans la description signée des colonnes (`Synchro_Colonnes`) : `fx` (texte de la formule, vide pour une colonne qui
// n'est pas une formule) sur chaque colonne d'un export qui envoie les formules. La présence de la clé dit que l'export
// les envoie, même vide. `fd` (seulement quand il y en a une) : la formule par défaut d'une colonne de données, c'est-à-dire
// une formule de déclenchement « sur les nouvelles lignes » seulement (voir sourceDefault).
import { KEY_COL } from './common.js';

// Longueur maximale d'une formule, et de toutes celles d'une table de l'export (la description des colonnes part avec
// chaque envoi : 20 000 caractères restent loin du mégaoctet que Grist accepte). Une formule trop longue n'est pas
// coupée (un Python tronqué n'est plus le même programme) : elle ne part pas.
export const FORMULA_MAX = 1500;
export const FORMULAS_TOTAL_MAX = 20000;

// Texte d'une formule, nettoyé : sans caractères de contrôle (sauf le retour à la ligne et la tabulation, qui comptent en
// Python) ni de sens d'écriture ou invisibles (un U+202E ferait lire autre chose que ce que Python exécute), retours
// à la ligne unifiés, espaces de fin retirées. Un texte qui n'en est pas un, vide ou trop long donne ''.
export function cleanFormula(text, max = FORMULA_MAX) {
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return [...clean].length > max ? '' : clean;
}

// Une Référence ou une colonne de pièces jointes part comme du texte : sa formule rendrait une fiche ou des fichiers,
// pas du texte. Elle ne part pas.
const CONVERTED = /^(Ref(List)?:|Attachments$)/;

// Formule envoyée pour la colonne `col` du schéma de la SOURCE : celle d'une vraie colonne de formule (pas d'une
// colonne de données à formule de déclenchement), nettoyée ; '' sinon.
export function sourceFormula(col) {
  if (!col || !col.isFormula || CONVERTED.test(col.type || '')) return '';
  return cleanFormula(col.formula);
}

// Formule par défaut de la colonne de données `col` : sa formule de déclenchement quand elle ne joue que sur les **nouvelles
// lignes** (`recalcWhen` 0, aucune colonne suivie), nettoyée ; '' sinon. Vérifié dans Grist 1.7 : une telle formule ne remplit
// qu'une cellule que l'ajout ne donne pas (une valeur donnée, même vide, l'emporte), ne touche jamais aux lignes déjà là ; la
// recopie de la CIBLE, qui écrit chaque colonne, ne la déclenche donc jamais. Une formule qui se recalcule quand une colonne
// change (ou à toute modification) ne part pas : elle réécrirait ici des valeurs que la SOURCE envoie déjà, et la carte les
// signalerait comme retouchées. Même exclusion que pour les formules de colonne : Référence et Pièces jointes.
export function sourceDefault(col) {
  if (!col || col.isFormula || CONVERTED.test(col.type || '')) return '';
  if (col.recalcWhen && col.recalcWhen !== 0) return '';
  if (Array.isArray(col.recalcDeps) && col.recalcDeps.length > 1) return '';
  return cleanFormula(col.formula);
}

// Les colonnes exportées `columns` avec leur formule (`fx`), et leur formule par défaut (`fd`, seulement s'il y en a une),
// d'après les colonnes du schéma `live`. Au-delà de `FORMULAS_TOTAL_MAX` caractères pour la table, les formules suivantes ne
// partent pas.
export function withFormulas(columns, live) {
  const here = new Map((live || []).map(c => [c.colId, c]));
  let total = 0;
  const fit = (formula) => {
    const sent = formula && total + formula.length <= FORMULAS_TOTAL_MAX ? formula : '';
    total += sent.length;
    return sent;
  };
  return columns.map(({ fx, fd, ...c }) => {
    const col = here.get(c.id);
    const formula = fit(col ? sourceFormula(col) : '');
    const initial = fit(col ? sourceDefault(col) : '');
    return { ...c, fx: formula, ...(initial ? { fd: initial } : {}) };
  });
}

// Colonnes qui portent une formule envoyée (de colonne ou par défaut), et ce que dit la liste : l'export envoie les formules
// (`offered`, même s'il n'y en a aucune), et il y en a au moins une (`sent`).
const hasText = value => typeof value === 'string' && value !== '';
export const formulaItems = columns => (Array.isArray(columns) ? columns : []).filter(c => c && (hasText(c.fx) || hasText(c.fd)));
export const formulasOffered = columns => (Array.isArray(columns) ? columns : []).some(c => c && typeof c.fx === 'string');
export const formulasSent = columns => formulaItems(columns).length > 0;

// ---------------------------------------------------------------------------------------------
// CIBLE : lire une formule avant de la poser

// Modules qu'une formule peut importer : calcul, dates, texte. Tout autre est refusé (système, réseau, fichiers).
export const SAFE_MODULES = ['math', 'datetime', 'time', 'calendar', 're', 'json', 'decimal', 'fractions', 'statistics', 'string',
  'itertools', 'functools', 'collections', 'random', 'unicodedata'];

// Mots qui n'ont rien à faire dans une formule de colonne : exécution de texte, fichiers, modules système et réseau.
// Cherchés hors des textes entre guillemets et des commentaires (« open » est un statut possible) ; `__` (tout nom à
// doubles tirets bas : les entrailles de Python) l'est partout, y compris dans un texte (`"{0.__class__}".format(x)` le lit).
const FORBIDDEN = /\b(?:eval|exec|compile|open|input|breakpoint|getattr|setattr|delattr|globals|locals|vars|memoryview|os|sys|subprocess|socket|urllib|requests|http|ftplib|smtplib|ctypes|importlib|pickle|shelve|shutil|pathlib|builtins|inspect|gc|signal|threading|multiprocessing|asyncio)\b/g;

// La formule sans ses commentaires ni le contenu de ses textes (remplacé par `""`), pour la lire sans prendre un mot d'un
// texte pour du code. Le contenu d'un texte f"…" reste : Python y exécute ce qui est entre accolades. Un texte simple
// s'arrête à la fin de la ligne (Python ne le laisse pas la dépasser) : rien de ce qui suit n'est caché.
function stripStrings(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (ch === '"' || ch === "'") {
      const { body, end } = readString(src, i);
      const prefix = /([A-Za-z]{1,2})$/.exec(out);
      out += prefix && /f/i.test(prefix[1]) ? ` ${body} ` : '""';
      i = end;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Le texte qui s'ouvre en `start` : son contenu et la position qui suit sa fin.
function readString(src, start) {
  const quote = src.startsWith(src[start].repeat(3), start) ? src[start].repeat(3) : src[start];
  let end = start + quote.length;
  while (end < src.length && !src.startsWith(quote, end) && !(quote.length === 1 && src[end] === '\n')) end += src[end] === '\\' ? 2 : 1;
  return { body: src.slice(start + quote.length, end), end: src.startsWith(quote, end) ? end + quote.length : end };
}

// Modules cités par les `import …` et `from … import …` (où qu'ils soient dans la ligne : après un `;` ou un `:` aussi).
function importedModules(code) {
  const found = [...code.matchAll(/\bfrom\s+([A-Za-z_][\w.]*)\s+import\b/g)].map(m => m[1].split('.')[0]);
  const rest = code.replace(/\bfrom\s+[A-Za-z_][\w.]*\s+import\b[^\n;]*/g, ' ');
  for (const m of rest.matchAll(/\bimport\s+([^\n;]+)/g)) {
    found.push(...m[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0].split('.')[0]).filter(Boolean));
  }
  return found;
}

const unique = list => list.filter((p, i) => list.findIndex(q => q.code === p.code && q.name === p.name) === i);

// Ce qui empêche de poser la formule `formula` d'une colonne de la table reçue, en liste de `{ code, name, to? }` (vide :
// rien à signaler). `here` : colonnes de la destination ; `map` : correspondance des colonnes envoyées (nom de la SOURCE vers
// celui d'ici) ; `tables` : tables de l'export, du nom de la SOURCE vers celui d'ici.
//  - `unsafe` : mot interdit (`name`) ; `import` : module hors de la liste (`name`) ;
//  - `missingCol` : colonne citée (`$Nom`, `rec.Nom`) absente d'ici ; `renamedCol` : elle s'appelle `to` ici ;
//  - `foreignTable` : table citée (`Nom.lookupRecords`, `.lookupOne`, `.all`) qui n'est pas une table de l'export ; `renamedTable` : elle s'appelle `to` ici.
// Une formule qui cite une colonne ou une table renommée n'est pas réécrite (Python n'est pas réécrit à l'aveugle) : la
// personne la corrige à la main si elle le veut.
export function formulaProblems(formula, { here, map = {}, tables = new Map() }) {
  const code = stripStrings(formula);
  return unique([...forbiddenProblems(formula, code), ...referenceProblems(code, { here, map, tables })]);
}

// Mots et modules refusés (`formula` : le texte entier, pour les doubles tirets bas ; `code` : sans textes ni commentaires).
function forbiddenProblems(formula, code) {
  const problems = formula.includes('__') ? [{ code: 'unsafe', name: '__' }] : [];
  for (const word of new Set(code.match(FORBIDDEN) || [])) problems.push({ code: 'unsafe', name: word });
  const flagged = new Set(problems.map(p => p.name));
  for (const module of new Set(importedModules(code))) if (!SAFE_MODULES.includes(module) && !flagged.has(module)) problems.push({ code: 'import', name: module });
  return problems;
}

// Colonnes (`$Nom`, `rec.Nom`) et tables (`Nom.lookupRecords`, `.lookupOne`, `.all`) citées, à lire chez la CIBLE.
function referenceProblems(code, { here, map, tables }) {
  const problems = [];
  const names = [...code.matchAll(/\$([A-Za-z_]\w*)/g), ...code.matchAll(/\brec\.([A-Za-z_]\w*)/g)].map(m => m[1]);
  for (const name of names.filter(n => n !== 'id')) {
    const to = map[name] || name;
    if (to !== name) problems.push({ code: 'renamedCol', name, to });
    else if (!here.has(name)) problems.push({ code: 'missingCol', name });
  }
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\.(?:lookupRecords|lookupOne|all)\b/g)) {
    const to = tables.get(m[1]);
    if (to === undefined) problems.push({ code: 'foreignTable', name: m[1] });
    else if (to !== m[1]) problems.push({ code: 'renamedTable', name: m[1], to });
  }
  return problems;
}

// Où en est la colonne d'ici : 'same' (la formule est déjà posée), 'other' (une autre formule est là), 'data' (aucune).
function placed(column, kind, formula) {
  if (kind === 'column') return !column.isFormula ? 'data' : column.formula === formula ? 'same' : 'other';
  if (column.isFormula || !column.formula) return 'data';
  return column.formula === formula && !column.recalcWhen && !(Array.isArray(column.recalcDeps) && column.recalcDeps.length > 1) ? 'same' : 'other';
}

// Les formules à poser dans la destination `entry.dest` (voir la note de l'entrée : `own`, `map`). Une formule ne remplace
// jamais que ce que le widget a créé (`own`) : une colonne qui existait déjà ici garde ses données. `columns` : colonnes envoyées
// (avec `fx`) ; `tables` : voir formulaProblems. Rend `items`, une ligne par formule envoyée dont la colonne existe ici :
// `{ id, to, label, formula, state, problems, ok, applied }` où `state` vaut 'data' (colonne de données ici), 'other' (autre
// formule ici) ou 'same' (déjà posée), et `ok` dit que rien ne s'y oppose. `actions` : les écritures, seulement avec `replace`
// (le clic d'un propriétaire) : `ModifyColumn` en colonne de formule, pour les formules sans objection qui ne sont pas déjà là.
// Une formule par défaut (`kind: 'default'`) ne remplace aucune valeur : la colonne reste de données, elle reçoit la formule de
// déclenchement « sur les nouvelles lignes » (`state` : 'data' sans formule par défaut ici, 'other' une autre, 'same' déjà posée) ;
// une colonne qui est de formule ici n'est pas transformée (`formulaHere`).
export function planFormulas(schema, entry, columns, { tables = new Map(), replace = false } = {}) {
  const cols = schema.columns(entry.dest) || [];
  const here = new Map(cols.map(c => [c.colId, c]));
  const own = new Set(Array.isArray(entry.own) ? entry.own : []);
  const map = entry.map || {};
  const items = [];
  const actions = [];
  for (const c of formulaItems(columns)) {
    const kind = hasText(c.fx) ? 'column' : 'default';
    const formula = cleanFormula(kind === 'column' ? c.fx : c.fd);
    const to = map[c.id] || c.id;
    const column = here.get(to);
    if (!formula || !column || to === KEY_COL) continue;
    const problems = formulaProblems(formula, { here, map, tables });
    if (!own.has(c.id)) problems.unshift({ code: 'notOwn', name: to });
    if (kind === 'default' && column.isFormula) problems.unshift({ code: 'formulaHere', name: to });
    const state = placed(column, kind, formula);
    const ok = !problems.length;
    const applied = replace && ok && state !== 'same';
    if (applied) actions.push(['ModifyColumn', entry.dest, to, kind === 'column' ? { isFormula: true, formula } : { isFormula: false, formula, recalcWhen: 0 }]);
    items.push({ id: c.id, to, label: c.label || c.id, formula, kind, state: applied ? 'same' : state, problems, ok, applied });
  }
  return { items, actions };
}
