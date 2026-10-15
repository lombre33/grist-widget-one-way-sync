// Logique pure de la synchro : ni DOM, ni `grist`, ni réseau. Tout ce qui décide (quelle
// version gagne, quoi écrire, quelle adresse accepter, quelles colonnes posent problème) est
// ici, testé par `tests/unit/core.test.mjs`. Les autres modules lisent Grist, appellent ces
// fonctions et appliquent le résultat.

export const KEY_COL = 'id_sync';
export const ORDER_COL = 'MajLe';
export const DELETE_COL = 'Supprime'; // facultative : prise en compte si la table SOURCE l'a
export const LIST_COL = 'Synchro_Ids'; // liste des clés existantes, envoyée par la SOURCE
export const APPLIED_COL = 'Sync_Applique'; // version déjà recopiée dans la destination
export const AUTHOR_COL = 'Sync_Par'; // e-mail de la personne qui a ajouté la ligne (user.Email)
export const RECEIVED_COL = 'Sync_Recu'; // date d'arrivée de la ligne dans le Journal (NOW())
export const STATE_COL = 'Sync_Etat'; // effet de la version recopiée : ajout, modif, suppression
export const DATA_COL = 'Synchro_Donnees'; // colonnes envoyées d'une ligne, en un bloc JSON
export const SCHEMA_COL = 'Synchro_Colonnes'; // colonnes envoyées : [{ id, type, label }] en JSON
export const JOURNAL_PREFIX = 'Journal_'; // CIBLE : un journal par export reçu

// SOURCE : la seule table technique du widget, quel que soit le nombre d'exports et de tables.
// Chaque table d'un export y a deux lignes : sa liste des clés et son lot de lignes modifiées.
export const SYNC_TABLE = 'Synchro';
export const EXPORT_COL = 'Synchro_Export'; // identifiant de l'export
export const TABLE_COL = 'Synchro_Table'; // table SOURCE (et, dans le journal, table d'origine d'une ligne)
export const TYPE_COL = 'Synchro_Type'; // 'cles', 'lot', ou 'complet' (lien public)
export const RESEND_COL = 'Synchro_Renvoi'; // lignes à renvoyer, écrites par le widget
export const LOT_COL = 'Synchro_Lot'; // lot : lignes récentes avec leurs colonnes, en JSON
// Lot coupé : depuis quand des lignes restent à envoyer (0 : rien). Le webhook envoie chaque ligne
// de Synchro entière, et un journal refuse une colonne qu'il n'a pas : la marque reprend donc le nom
// d'une colonne que tous les journaux ont déjà, pour que les CIBLES existantes l'acceptent.
export const MISSING_COL = STATE_COL;
export const KIND = { keys: 'cles', lot: 'lot', full: 'complet' };
const WINDOW_S = 5; // un lot porte les lignes modifiées depuis 5 secondes
// Octets d'un lot. Grist refuse un envoi de plus de 1 Mo, et un même envoi regroupe la liste des
// clés et le lot quand les deux changent ensemble : le lot prend ce que la liste laisse.
const LOT_MAX = 250000;
const POST_MAX = 950000;
const LOT_MIN = 20000;
const KEY_BYTES = 40; // une clé dans la liste : UUID et séparateur
export const RESEND_CHUNK = 200; // lignes par renvoi

const LIST_PREFIX = 'ids:';
const CODE_PREFIX = 'GRISTSYNC2.';
export const CHUNK = 500; // lignes par action

// ---------------------------------------------------------------------------------------------
// Utilitaires

// fetchTable renvoie des colonnes ({id: [...], Nom: [...]}) : on travaille en lignes.
export function toRows(columnar) {
  if (!columnar || !Array.isArray(columnar.id)) return [];
  const cols = Object.keys(columnar);
  return columnar.id.map((_, i) => Object.fromEntries(cols.map(c => [c, columnar[c][i]])));
}

export function chunk(items, size = CHUNK) {
  const parts = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function isTrue(value) {
  return value === true || value === 1 || (typeof value === 'string' && ['true', 'oui', 'vrai', '1'].includes(value.trim().toLowerCase()));
}

function parseJson(text, fallback = null) {
  try { return JSON.parse(text); } catch (e) { return fallback; }
}

const COL_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEX16 = /^[0-9a-f]{16}$/;
const SECRET = /^[0-9a-f]{32}$/;

// Identifiant de table Grist valide à partir d'un nom libre.
export function toTableId(name, fallback = 'Table') {
  let id = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
  if (/^[0-9]/.test(id)) id = 'T_' + id;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// Premier identifiant libre : `base`, puis `base_2`, `base_3`…
export function freeTableId(base, taken) {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}

// ---------------------------------------------------------------------------------------------
// SOURCE : la table Synchro

// Formules de la table Synchro. Elles nomment en clair les tables qu'elles peuvent lire (`tables`) :
// le widget les réécrit quand un export gagne ou perd une table.
//  - Synchro_Ids (lignes 'cles') : la liste des clés, recalculée à chaque ajout ou suppression ;
//  - Synchro_Lot (lignes 'lot') : les lignes modifiées depuis WINDOW_S secondes et celles
//    demandées dans Synchro_Renvoi, avec les colonnes de l'export, plafonné à LOT_MAX octets
//    (`total` dit combien il y en avait) ; lignes 'complet' (lien public) : toutes les lignes.
// Une valeur est lue à part : une cellule en erreur part vide sans bloquer les autres. Dates en
// secondes (format de Grist), Référence par son texte affiché. Un lot coupé dit depuis quand
// (`depuis`) : la marque MISSING_COL le retient, et le widget SOURCE envoie le reste.
export function syncFormulas(tables) {
  const ids = [...new Set(tables)].filter(id => COL_ID.test(id)).sort();
  const pick = `T = {${ids.map(id => `"${id}": ${id}`).join(', ')}}.get($${TABLE_COL})`;
  const keys = [
    `if $${TYPE_COL} != "${KIND.keys}": return ""`, pick, 'if T is None: return ""',
    `return "${LIST_PREFIX}" + " ".join(k for k in T.all.${KEY_COL} if k)`,
  ].join('\n');
  const lot = [
    'import json, datetime',
    `if $${TYPE_COL} not in ("${KIND.lot}", "${KIND.full}"): return ""`, pick, 'if T is None: return ""',
    `cols = json.loads($${SCHEMA_COL} or "[]")`,
    'def v(x):',
    '  if isinstance(x, datetime.datetime): return x.timestamp()',
    '  if isinstance(x, datetime.date): return (x - datetime.date(1970, 1, 1)).days * 86400',
    '  if isinstance(x, (list, tuple)): return [v(y) for y in x]',
    '  return x if x is None or isinstance(x, (str, int, float, bool)) else str(x)',
    'def g(r, c):',
    '  try:',
    '    x, s, w = getattr(r, c["id"]), c.get("source", ""), c.get("visible", "")',
    '    if s.startswith("RefList:"): return ", ".join(str(getattr(y, w) if w else y.id) for y in x)',
    '    if s.startswith("Ref:"): return v(getattr(x, w) if w else x.id)',
    '    return v(x)',
    '  except Exception:',
    '    return None',
    `again = set(int(i) for i in ($${RESEND_COL} or "").split(":")[-1].split(",") if i.strip().isdigit())`,
    `rows = [r for r in T.all if r.${KEY_COL}]`,
    `if $${TYPE_COL} == "${KIND.lot}":`,
    `  cut = NOW() - datetime.timedelta(seconds=${WINDOW_S})`,
    `  rows = [r for r in rows if r.id in again or (r.${ORDER_COL} and r.${ORDER_COL} >= cut)]`,
    `budget = max(${LOT_MIN}, min(${LOT_MAX}, ${POST_MAX} - ${KEY_BYTES} * len(T.all)))`,
    'out, size = [], 0',
    `for r in sorted(rows, key=lambda r: v(r.${ORDER_COL}) or 0, reverse=True):`,
    `  line = [r.${KEY_COL}, v(r.${ORDER_COL}), bool(getattr(r, "${DELETE_COL}", False)), {c["id"]: g(r, c) for c in cols}]`,
    '  size += len(json.dumps(line, ensure_ascii=False))',
    `  if $${TYPE_COL} == "${KIND.lot}" and size > budget: break`,
    '  out.append(line)',
    'lot = {"lignes": out, "total": len(rows)}',
    `if $${TYPE_COL} == "${KIND.lot}" and len(out) < len(rows): lot.update(depuis=v(cut), renvoi=bool(again))`,
    'return json.dumps(lot, ensure_ascii=False)',
  ].join('\n');
  return { keys, lot };
}

// Marque d'envoi coupé (formule de déclenchement, recalculée quand le lot change) : la plus ancienne
// date d'un lot coupé, gardée jusqu'à ce que le widget SOURCE envoie le reste et l'efface. Un lot
// de renvoi coupé ne compte pas : le widget le recoupe lui-même.
export const missingFormula = [
  'import json',
  `lot = json.loads($${LOT_COL} or "{}") if $${TYPE_COL} == "${KIND.lot}" else {}`,
  'if lot.get("depuis") and not lot.get("renvoi"):',
  '  return min(value, lot["depuis"]) if value else lot["depuis"]',
  'return value',
].join('\n');

// Colonnes de la table Synchro. Le journal de la CIBLE doit toutes les avoir (le webhook envoie
// chaque ligne entière) : une colonne ajoutée ici doit déjà exister dans les journaux.
export function syncColumns(tables) {
  const { keys, lot } = syncFormulas(tables);
  return [
    { id: EXPORT_COL, type: 'Text', isFormula: false },
    { id: TABLE_COL, type: 'Text', isFormula: false },
    { id: TYPE_COL, type: 'Text', isFormula: false },
    { id: SCHEMA_COL, type: 'Text', isFormula: false },
    { id: RESEND_COL, type: 'Text', isFormula: false },
    { id: LIST_COL, type: 'Text', isFormula: true, formula: keys },
    { id: LOT_COL, type: 'Text', isFormula: true, formula: lot },
    { id: MISSING_COL, type: 'Numeric', isFormula: false, formula: missingFormula, recalcWhen: 0 },
    // E-mail de la personne qui crée l'export : présenté à la CIBLE comme propriétaire.
    { id: AUTHOR_COL, type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 },
  ];
}

// Lignes Synchro d'un export : par table, sa liste des clés, son lot, et son instantané complet
// s'il est partagé par lien public. `rows` : lignes Synchro existantes. Rend les actions qui
// amènent l'export à `tables` ([{ table, columns }], colonnes de `exportableColumns`) : lignes
// ajoutées, colonnes changées, lignes des tables retirées effacées. `changed` : tables nouvelles
// ou aux colonnes changées, dont les lignes sont à renvoyer.
export function exportRowsActions(rows, exportId, tables, { isPublic = false } = {}) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId);
  const kinds = [KIND.keys, KIND.lot, ...(isPublic ? [KIND.full] : [])];
  const add = [];
  const update = [];
  const changed = [];
  for (const { table, columns } of tables) {
    const schema = JSON.stringify(columns.map(({ id, type, label, source, visible }) => ({ id, type, label, source, visible })));
    const here = mine.filter(r => r[TABLE_COL] === table);
    if (!here.length || here.some(r => r[SCHEMA_COL] !== schema)) changed.push(table);
    for (const kind of kinds) {
      const row = here.find(r => r[TYPE_COL] === kind);
      if (!row) add.push({ [EXPORT_COL]: exportId, [TABLE_COL]: table, [TYPE_COL]: kind, [SCHEMA_COL]: schema, [RESEND_COL]: '' });
      else if (row[SCHEMA_COL] !== schema) update.push([row.id, schema]);
    }
  }
  const keep = new Set(tables.map(tb => tb.table));
  const remove = mine.filter(r => !keep.has(r[TABLE_COL]) || !kinds.includes(r[TYPE_COL])).map(r => r.id);
  const cols = [EXPORT_COL, TABLE_COL, TYPE_COL, SCHEMA_COL, RESEND_COL];
  const actions = [];
  if (add.length) actions.push(['BulkAddRecord', SYNC_TABLE, add.map(() => null), Object.fromEntries(cols.map(c => [c, add.map(r => r[c])]))]);
  if (update.length) actions.push(['BulkUpdateRecord', SYNC_TABLE, update.map(u => u[0]), { [SCHEMA_COL]: update.map(u => u[1]) }]);
  if (remove.length) actions.push(['BulkRemoveRecord', SYNC_TABLE, remove]);
  return { actions, changed };
}

// Tables et colonnes d'un export, lues dans ses lignes Synchro.
export function exportTables(rows, exportId) {
  const tables = new Map();
  for (const r of rows) {
    if (r[EXPORT_COL] !== exportId || tables.has(r[TABLE_COL])) continue;
    tables.set(r[TABLE_COL], parseJson(r[SCHEMA_COL], []) || []);
  }
  return [...tables].map(([table, columns]) => ({ table, columns }));
}

// Condition du webhook d'un destinataire : Grist ne lui envoie que les lignes de son export.
export const exportCondition = exportId =>
  `rec.${EXPORT_COL} == "${exportId}" and rec.${TYPE_COL} in ("${KIND.keys}", "${KIND.lot}")`;

// Export d'un webhook, lu dans sa condition ; '' si elle n'a pas exactement la forme attendue
// (webhook à ne pas laisser : il recevrait d'autres lignes que celles d'un export).
export function conditionExport(text) {
  const [before, after] = exportCondition('\u0000').split('\u0000');
  const s = String(text || '');
  if (!s.startsWith(before) || !s.endsWith(after)) return '';
  const id = s.slice(before.length, s.length - after.length);
  return HEX16.test(id) ? id : '';
}

// Nom du webhook d'un destinataire : lisible dans les réglages de Grist, avec l'export en fin.
export const hookName = (name, exportId) => `Synchro ${name} #${exportId}`;

// Renvoi de lignes (numéros de ligne de la table SOURCE) : une marque nouvelle à chaque fois,
// pour que la valeur change même si les lignes sont les mêmes.
export const resendValue = (mark, ids) => `${mark}:${ids.join(',')}`;

// Lot reçu : { lines: [{ key, order, deleted, data }], total } ; null s'il est illisible.
export function parseLot(text) {
  const lot = parseJson(text);
  if (!lot || !Array.isArray(lot.lignes)) return null;
  const lines = lot.lignes.filter(l => Array.isArray(l) && !isBlank(l[0]) && l[3] && typeof l[3] === 'object')
    .map(([key, order, deleted, data]) => ({ key: String(key), order: order ?? null, deleted: isTrue(deleted), data }));
  return { lines, total: Number(lot.total) || lines.length };
}

// Colonnes qu'une table SOURCE peut envoyer : toutes ses colonnes de données et formules, hors
// colonnes de la synchro et colonnes internes de Grist. Les pièces jointes ne peuvent pas partir
// (`blocked`). Une Référence part comme le texte qu'elle affiche.
export function exportableColumns(cols) {
  const skip = new Set(['manualSort', KEY_COL, ORDER_COL, DELETE_COL]);
  return cols.filter(c => !skip.has(c.colId) && !c.colId.startsWith('gristHelper_')).map(c => ({
    id: c.colId, label: c.label || c.colId, type: /^Ref(List)?:/.test(c.type) ? 'Text' : c.type, source: c.type,
    visible: c.visible || '', blocked: c.type === 'Attachments',
  }));
}

// Description des colonnes envoyées, telle que la CIBLE la reçoit.
export const exportSchema = columns => columns.map(({ id, type, label }) => ({ id, type, label }));

// Colonnes de la synchro qui manquent à la table SOURCE.
export const missingSyncColumns = cols => [KEY_COL, ORDER_COL].filter(id => !cols.some(c => c.colId === id));

// id_sync : UUID posé à la création. MajLe : NOW() à toute modification de la ligne.
export function prepareSourceActions(tableId, missing) {
  const specs = {
    [KEY_COL]: { type: 'Text', isFormula: false, formula: 'UUID()', recalcWhen: 0 },
    [ORDER_COL]: { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 2 },
  };
  return missing.map(colId => ['AddColumn', tableId, colId, specs[colId]]);
}

// MajLe change quand une valeur envoyée change, et seulement alors : formule de déclenchement sur
// les colonnes envoyées par les exports (`colIds`), leurs colonnes d'affichage (texte d'une
// Référence) et Supprime. Une valeur qui change à cause d'une autre table (ville renommée, formule)
// la fait donc changer aussi (vérifié). Rend l'action qui la met à jour, ou null.
export function majleAction(cols, colIds) {
  const majle = cols.find(c => c.colId === ORDER_COL);
  if (!majle) return null;
  const sent = cols.filter(c => colIds.includes(c.colId) || c.colId === DELETE_COL);
  const refs = [...new Set(sent.flatMap(c => [c.id, c.displayCol]).filter(Boolean))].sort((a, b) => a - b);
  const deps = ['L', ...refs];
  const same = majle.recalcWhen === 0 && JSON.stringify(majle.recalcDeps || null) === JSON.stringify(deps);
  return same || !refs.length ? null : ['UpdateRecord', '_grist_Tables_column', majle.id, { recalcWhen: 0, recalcDeps: deps }];
}

// Une formule de déclenchement ajoutée après coup laisse les lignes existantes vides (vérifié).
export function fillKeyActions(tableId, rows, newId) {
  const empty = rows.filter(r => isBlank(r[KEY_COL])).map(r => r.id);
  return chunk(empty).map(ids => ['BulkUpdateRecord', tableId, ids, { [KEY_COL]: ids.map(() => newId()) }]);
}

// Lien public : règles d'accès qui ne laissent aux lecteurs (dont le lien public) que les lignes
// 'complet' des exports `exportIds` dans la table Synchro. Les règles du widget portent ce mémo ;
// elles passent avant les règles existantes. `resources`, `rules` : lignes de _grist_ACLResources
// et _grist_ACLRules. Sans export, `keepDeny` garde le refus général : à utiliser tant que le
// document reste partagé publiquement.
export const PUBLIC_MEMO = 'Synchro : lecture limitée aux exports publics';
const VIEWER_ONLY = 'user.Access == VIEWER';

// Règles voulues : [{ tableId, aclFormula, permissionsText }], dans l'ordre.
export function publicAclRules(exportIds, { keepDeny = false } = {}) {
  const ids = exportIds.filter(id => HEX16.test(id)).sort();
  if (!ids.length && !keepDeny) return [];
  return [
    ...(ids.length ? [{ tableId: SYNC_TABLE, permissionsText: '+R',
      aclFormula: `${VIEWER_ONLY} and rec.${EXPORT_COL} in [${ids.map(id => `"${id}"`).join(', ')}] and rec.${TYPE_COL} == "${KIND.full}"` }] : []),
    { tableId: '*', aclFormula: VIEWER_ONLY, permissionsText: '-R' },
  ];
}

const LEGACY_MEMO = 'Synchro : lecture limitée aux vues d’export';
export const isPublicRule = r => r.memo === PUBLIC_MEMO || r.memo === LEGACY_MEMO;

export function publicAclActions(resources, rules, exportIds, options = {}) {
  const actions = [['BulkRemoveRecord', '_grist_ACLRules', rules.filter(isPublicRule).map(r => r.id)]].filter(a => a[2].length);
  let pos = Math.min(0, ...rules.map(r => r.rulePos || 0));
  let temp = 0;
  const resourceFor = (tableId) => {
    const found = resources.find(r => r.tableId === tableId && r.colIds === '*');
    if (found) return found.id;
    actions.push(['AddRecord', '_grist_ACLResources', --temp, { tableId, colIds: '*' }]);
    return temp;
  };
  for (const { tableId, aclFormula, permissionsText } of publicAclRules(exportIds, options)) {
    actions.push(['AddRecord', '_grist_ACLRules', null, { resource: resourceFor(tableId), aclFormula, permissionsText, rulePos: --pos, memo: PUBLIC_MEMO }]);
  }
  return actions;
}

// ---------------------------------------------------------------------------------------------
// Versions : (valeur de MajLe, numéro de ligne du Journal). Vide = plus ancien ; à égalité
// d'horodatage, la dernière ligne arrivée gagne.

function compareOrder(a, b) {
  if (isBlank(a) || isBlank(b)) return (isBlank(a) ? 0 : 1) - (isBlank(b) ? 0 : 1);
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function compareVersion(a, b) {
  return compareOrder(a.order, b.order) || Math.sign((a.id || 0) - (b.id || 0));
}

// Dernière version de chaque clé du Journal. Les lignes sans clé (listes, test du lien) sont
// ignorées.
export function latestByKey(journalRows) {
  const latest = new Map();
  for (const row of journalRows) {
    const key = row[KEY_COL];
    if (isBlank(key)) continue;
    const version = { order: row[ORDER_COL], id: row.id, row };
    const current = latest.get(key);
    if (!current || compareVersion(version, current) > 0) latest.set(key, version);
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------
// CIBLE : journal d'un export

// Lignes telles que déposées par le webhook (ou le lien public) : une liste des clés ou un lot.
const isRaw = row => !isBlank(row[TYPE_COL]);

// Dépliage, dans l'ordre d'arrivée : chaque lot devient une ligne par version (clé, date,
// suppression, bloc des colonnes, table d'origine), chaque liste des clés une ligne de liste ; les
// lignes reçues sont effacées dans le même lot. Les nouvelles lignes gardent l'ordre d'arrivée
// (numéros croissants) et la date d'arrivée. Rend aussi, par table, les lignes qu'un lot trop gros
// n'a pas portées depuis le dernier renvoi (`missing`) et les tables reçues par un renvoi
// (`resent`), dont le compte précédent ne vaut plus.
export function planUnpack(journalRows, journalTable) {
  const raw = journalRows.filter(isRaw).sort((a, b) => a.id - b.id);
  const added = [];
  const missing = {};
  const resent = new Set();
  for (const row of raw) {
    const table = String(row[TABLE_COL] || '');
    if (!COL_ID.test(table)) continue;
    const base = { [TABLE_COL]: table, [RECEIVED_COL]: row[RECEIVED_COL] ?? null };
    if (row[TYPE_COL] === KIND.keys && String(row[LIST_COL] || '').startsWith(LIST_PREFIX)) {
      added.push({ ...base, [LIST_COL]: row[LIST_COL], [SCHEMA_COL]: row[SCHEMA_COL] || '' });
      continue;
    }
    const lot = parseLot(row[LOT_COL]);
    if (!lot) continue;
    lot.lines.forEach((l, i) => added.push({
      ...base, [KEY_COL]: l.key, [ORDER_COL]: l.order, [DELETE_COL]: l.deleted, [DATA_COL]: JSON.stringify(l.data),
      ...(i === 0 ? { [SCHEMA_COL]: row[SCHEMA_COL] || '' } : {}),
    }));
    // Un renvoi remet le compte à zéro (la SOURCE recoupe elle-même un lot de renvoi trop gros) ;
    // un lot coupé ajoute ce qui manque.
    if (!isBlank(row[RESEND_COL])) {
      resent.add(table);
      missing[table] = 0;
    } else if (lot.total > lot.lines.length) missing[table] = (missing[table] || 0) + lot.total - lot.lines.length;
  }
  const cols = [...new Set(added.flatMap(Object.keys))];
  const actions = chunk(added).map(part => ['BulkAddRecord', journalTable, part.map(() => null),
    Object.fromEntries(cols.map(c => [c, part.map(r => r[c] ?? (c === DELETE_COL ? false : c === ORDER_COL || c === RECEIVED_COL ? null : ''))]))]);
  for (const part of chunk(raw.map(r => r.id))) actions.push(['BulkRemoveRecord', journalTable, part]);
  return { actions, missing, resent: [...resent] };
}

// Lignes dépliées du journal, par table d'origine.
export function rowsByTable(journalRows) {
  const groups = new Map();
  for (const row of journalRows) {
    if (isRaw(row) || isBlank(row[TABLE_COL])) continue;
    if (!groups.has(row[TABLE_COL])) groups.set(row[TABLE_COL], []);
    groups.get(row[TABLE_COL]).push(row);
  }
  return groups;
}

// Colonnes recopiées, en couples [colonne du Journal, colonne de la destination] : colonnes
// envoyées présentes des deux côtés (sous le nom choisi dans `map`, sinon le même), hors colonnes
// techniques de la synchro et formules de la destination. La destination ne garde que `id_sync`.
const TECHNICAL = new Set(['id', 'manualSort', KEY_COL, ORDER_COL, DELETE_COL, LIST_COL, APPLIED_COL, AUTHOR_COL, RECEIVED_COL, STATE_COL,
  DATA_COL, SCHEMA_COL, EXPORT_COL, TABLE_COL, TYPE_COL, RESEND_COL, LOT_COL]);
export function copyColumns(journalCols, destCols, map = {}) {
  const writable = new Set(destCols.filter(c => !c.isFormula).map(c => c.colId));
  return journalCols.map(c => c.colId).filter(id => !TECHNICAL.has(id) && !id.startsWith('gristHelper_'))
    .map(id => [id, map[id] || id]).filter(([, to]) => writable.has(to) && to !== KEY_COL);
}

// Lignes du Journal avec leurs colonnes envoyées dépliées (bloc JSON). Une liste devient une
// ChoiceList au format de Grist.
export function expandRows(journalRows) {
  return journalRows.map((row) => {
    if (isBlank(row[DATA_COL])) return row;
    const data = parseJson(row[DATA_COL]);
    if (!data || typeof data !== 'object') return row;
    const values = Object.fromEntries(Object.entries(data).filter(([k]) => COL_ID.test(k))
      .map(([k, v]) => [k, Array.isArray(v) ? ['L', ...v] : v]));
    return { ...values, ...row };
  });
}

// Dernière ligne qui porte la description des colonnes (listes, et première version de chaque
// lot) : les colonnes envoyées, sinon `fallback` (celles de l'invitation).
function latestSchemaRow(rows) {
  let latest = null;
  for (const row of rows) if (!isBlank(row[SCHEMA_COL]) && (!latest || row.id > latest.id)) latest = row;
  return latest;
}

export function sentColumns(rows, fallback = []) {
  const cols = parseJson((latestSchemaRow(rows) || {})[SCHEMA_COL]);
  return validColumns(cols) ? exportSchema(cols) : fallback;
}

// Dernière liste des clés reçue (ligne du Journal sans clé, colonne Synchro_Ids).
function latestList(rows) {
  let latest = null;
  for (const row of rows) {
    if (String(row[LIST_COL] || '').startsWith(LIST_PREFIX) && (!latest || row.id > latest.id)) latest = row;
  }
  return latest;
}

// Valeur reçue et valeur de la destination égales ? Vide vaut vide ; une liste de choix lue dans
// Grist commence par la marque 'L'.
function sameValue(sent, have) {
  const norm = x => (isBlank(x) ? null : Array.isArray(x) && x[0] === 'L' ? x.slice(1) : x);
  return JSON.stringify(norm(sent)) === JSON.stringify(norm(have));
}

// Actions qui amènent la destination à l'état de la SOURCE, en un seul lot, pour une table
// (lignes du journal de cette table seulement) :
//  - la dernière version de chaque clé, si elle n'a pas encore été recopiée ; une clé inconnue
//    de la destination peut y reprendre une ligne existante sans clé de même valeur dans la
//    colonne `matchCol` (rattachement d'un référentiel déjà rempli) ;
//  - la suppression des lignes cochées `Supprime`, ou absentes de la dernière liste des clés
//    (ligne effacée dans la SOURCE) quand aucune version plus récente n'est arrivée depuis ;
//  - le marquage des versions et de la liste traitées (`Sync_Applique`) et de leur effet
//    (`Sync_Etat`), pour l'historique ; une suppression venue de la liste est notée sur la
//    dernière version de la clé, à la date d'arrivée de la liste.
// Une retouche manuelle survit donc jusqu'à la prochaine modification côté SOURCE, et rejouer le
// plan après application ne change rien (idempotent).
export function planConsolidation({ journalRows, destRows, copyCols, destTable, journalTable, matchCol = '' }) {
  const destByKey = new Map();
  const unkeyed = new Map(); // valeur de matchCol -> lignes de la destination sans clé
  for (const row of destRows) {
    if (isBlank(row[KEY_COL])) {
      if (!matchCol || isBlank(row[matchCol])) continue;
      if (!unkeyed.has(row[matchCol])) unkeyed.set(row[matchCol], []);
      unkeyed.get(row[matchCol]).push(row);
      continue;
    }
    if (!destByKey.has(row[KEY_COL])) destByKey.set(row[KEY_COL], []);
    destByKey.get(row[KEY_COL]).push(row);
  }
  const matchFrom = (copyCols.find(([, to]) => to === matchCol) || [])[0];
  const latest = latestByKey(journalRows);
  const applied = latestByKey(journalRows.filter(r => isTrue(r[APPLIED_COL]) && !isTrue(r[DELETE_COL])));
  const list = latestList(journalRows);
  const marks = new Map(); // ligne du Journal -> effet ('' pour la liste ou une version sans effet)
  const listGone = [];
  const gone = new Set();
  if (list && !isTrue(list[APPLIED_COL])) {
    const present = new Set(String(list[LIST_COL]).slice(LIST_PREFIX.length).split(' ').filter(Boolean));
    for (const key of destByKey.keys()) {
      const version = latest.get(key);
      if (present.has(key) || (version && version.id > list.id)) continue;
      gone.add(key);
      if (version) listGone.push(version.id);
    }
    marks.set(list.id, '');
  }

  const upserts = [];
  const attached = []; // [ligne de la destination, version]
  const stats = { added: 0, updated: 0, removed: 0 };
  for (const [key, version] of latest) {
    if (isTrue(version.row[APPLIED_COL])) continue;
    if (isTrue(version.row[DELETE_COL])) gone.add(key);
    if (gone.has(key)) {
      marks.set(version.id, destByKey.has(key) ? 'suppression' : '');
      continue;
    }
    const candidates = !destByKey.has(key) && matchFrom ? unkeyed.get(version.row[matchFrom]) : null;
    if (candidates && candidates.length) {
      attached.push([candidates.shift(), version]);
      marks.set(version.id, 'modif');
      stats.updated++;
      continue;
    }
    // Sans effet : la destination a déjà ces valeurs, ou la SOURCE n'a rien changé depuis la
    // version déjà recopiée (un renvoi, l'arrivée d'un autre destinataire, une colonne non
    // envoyée modifiée). Une retouche faite à la main dans la destination reste donc en place.
    const before = applied.get(key);
    const unchanged = before && copyCols.every(([from]) => sameValue(version.row[from], before.row[from]));
    if (destByKey.has(key) && (unchanged || destByKey.get(key).every(row => copyCols.every(([from, to]) => sameValue(version.row[from], row[to]))))) {
      marks.set(version.id, '');
      continue;
    }
    marks.set(version.id, destByKey.has(key) ? 'modif' : 'ajout');
    stats[destByKey.has(key) ? 'updated' : 'added']++;
    upserts.push(version);
  }
  const removeIds = [];
  for (const key of gone) {
    if (!destByKey.has(key)) continue;
    removeIds.push(...destByKey.get(key).map(r => r.id));
    stats.removed++;
  }

  const values = (versions) => {
    const out = {};
    for (const [from, to] of copyCols) out[to] = versions.map(v => v.row[from] ?? null);
    return out;
  };
  const actions = chunk(upserts).map(part =>
    ['BulkAddOrUpdateRecord', destTable, { [KEY_COL]: part.map(v => v.row[KEY_COL]) }, values(part), { on_many: 'all' }]);
  for (const part of chunk(attached)) {
    actions.push(['BulkUpdateRecord', destTable, part.map(([row]) => row.id),
      { [KEY_COL]: part.map(([, v]) => v.row[KEY_COL]), ...values(part.map(([, v]) => v)) }]);
  }
  for (const part of chunk(removeIds)) actions.push(['BulkRemoveRecord', destTable, part]);
  for (const part of chunk([...marks])) {
    actions.push(['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [APPLIED_COL]: part.map(() => true), [STATE_COL]: part.map(([, state]) => state) }]);
  }
  for (const part of chunk(listGone)) {
    actions.push(['BulkUpdateRecord', journalTable, part,
      { [STATE_COL]: part.map(() => 'suppression'), [RECEIVED_COL]: part.map(() => list[RECEIVED_COL] ?? null) }]);
  }
  return { actions, stats };
}

// Nettoyage du Journal, dans le même lot. Restent, par table : la dernière version de chaque clé,
// la dernière liste et la dernière description des colonnes (avec leur marque `Sync_Applique`) ;
// toutes les lignes des tables `keep` (proposées par la SOURCE, pas encore rangées) ; les lignes
// reçues pas encore dépliées ; et la ligne la plus récente, pour que Grist ne réutilise pas son
// numéro. Le reste (versions remplacées, tables `drop` refusées, test du lien) disparaît.
export function planPurge(journalRows, journalTable, { keep = [], drop = [] } = {}) {
  const kept = new Set(journalRows.filter(isRaw).map(r => r.id));
  for (const [table, rows] of rowsByTable(journalRows)) {
    if (drop.includes(table)) continue;
    if (keep.includes(table)) {
      rows.forEach(r => kept.add(r.id));
      continue;
    }
    for (const v of latestByKey(rows).values()) kept.add(v.id);
    for (const row of [latestList(rows), latestSchemaRow(rows)]) if (row) kept.add(row.id);
  }
  kept.add(journalRows.reduce((max, r) => Math.max(max, r.id), 0));
  const ids = journalRows.filter(r => !kept.has(r.id)).map(r => r.id);
  return chunk(ids).map(part => ['BulkRemoveRecord', journalTable, part]);
}

// Historique : dernière version de chaque clé recopiée avec un effet, arrivée après `since`
// (secondes), la plus récente d'abord, au plus `max`. `labelCol` nomme la ligne.
export function recentChanges(journalRows, labelCol, since, max) {
  return [...latestByKey(journalRows).values()]
    .map(v => ({ at: v.row[RECEIVED_COL] ?? v.order, state: v.row[STATE_COL], row: v.row }))
    .filter(c => c.state && typeof c.at === 'number' && c.at > since)
    .sort((a, b) => b.at - a.at).slice(0, max)
    .map(c => ({ at: c.at, label: labelCol ? String(c.row[labelCol] ?? '') : '', state: c.state }));
}

// Lien public, côté CIBLE : lignes à ajouter au Journal pour qu'il reflète les instantanés lus
// (`records` : lignes 'complet' de la table Synchro, lues par l'API REST), comme l'aurait fait un
// webhook. Par table, une version n'est ajoutée que si elle diffère de la dernière reçue ; une
// liste des clés, que si l'ensemble des clés ou les colonnes ont changé.
export function planPull({ records, journalRows, journalTable }) {
  const byTable = rowsByTable(journalRows);
  const versions = [];
  const lists = [];
  for (const { fields } of records) {
    const table = String(fields[TABLE_COL] || '');
    const lot = fields[TYPE_COL] === KIND.full && COL_ID.test(table) && parseLot(fields[LOT_COL]);
    if (!lot) continue;
    const rows = byTable.get(table) || [];
    const latest = latestByKey(rows);
    for (const l of lot.lines) {
      const known = latest.get(l.key);
      const data = JSON.stringify(l.data);
      if (known && known.order === l.order && known.row[DATA_COL] === data && isTrue(known.row[DELETE_COL]) === l.deleted) continue;
      versions.push({ [TABLE_COL]: table, [KEY_COL]: l.key, [ORDER_COL]: l.order, [DELETE_COL]: l.deleted, [DATA_COL]: data });
    }
    const sortedKeys = keys => `${LIST_PREFIX}${keys.filter(Boolean).sort().join(' ')}`;
    const ids = sortedKeys(lot.lines.map(l => l.key));
    const list = latestList(rows);
    const schema = fields[SCHEMA_COL] || '';
    if (!list || sortedKeys(String(list[LIST_COL]).slice(LIST_PREFIX.length).split(' ')) !== ids || (latestSchemaRow(rows) || {})[SCHEMA_COL] !== schema) {
      lists.push({ [TABLE_COL]: table, [LIST_COL]: ids, [SCHEMA_COL]: schema });
    }
  }
  const cols = [TABLE_COL, KEY_COL, ORDER_COL, DELETE_COL, DATA_COL];
  const actions = chunk(versions).map(part => ['BulkAddRecord', journalTable, part.map(() => null),
    Object.fromEntries(cols.map(col => [col, part.map(v => v[col])]))]);
  for (const l of lists) actions.push(['AddRecord', journalTable, null, l]);
  return actions;
}

// ---------------------------------------------------------------------------------------------
// Codes échangés entre SOURCE et CIBLE : préfixe + JSON en base64url, sur une ligne.

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, ch => ch.charCodeAt(0)));
}

function encodeCode(payload) {
  return CODE_PREFIX + toBase64Url(JSON.stringify(payload));
}

export function decodeCode(text, kind) {
  const raw = String(text || '').trim();
  if (raw.startsWith('GRISTSYNC1.')) throw new Error('codeOld');
  if (!raw.startsWith(CODE_PREFIX)) throw new Error('codeFormat');
  const payload = parseJson(fromBase64UrlSafe(raw.slice(CODE_PREFIX.length)));
  if (!payload) throw new Error('codeFormat');
  if (payload.kind !== kind) throw new Error(kind === 'invitation' ? 'notInvitation' : 'notReply');
  return payload;
}

function fromBase64UrlSafe(text) {
  try { return fromBase64Url(text); } catch (e) { return ''; }
}

function validColumns(cols) {
  return Array.isArray(cols) && cols.length > 0 && new Set(cols.map(c => c && c.id)).size === cols.length &&
    cols.every(c => c && COL_ID.test(c.id) && typeof c.type === 'string' && /^[A-Za-z:_0-9]+$/.test(c.type));
}

// Une invitation donne accès à un export (`export`, ses tables et colonnes) pour une personne :
// `id` la désigne dans la réponse ; `secret`, facultatif et choisi à la création, prouve que la
// réponse vient de quelqu'un qui l'a reçue (la SOURCE n'en garde que l'empreinte).
// Mode « lien public » (`base` : adresse REST du document SOURCE) : pas de réponse, la CIBLE lit
// les instantanés de l'export elle-même, sans identifiant.
export function buildInvitation({ id, exportId, name, origin, secret = '', from = {}, tables, base = '' }) {
  return encodeCode({
    kind: 'invitation', id, export: exportId, name, origin, secret, from, ...(base ? { mode: 'public', base } : {}),
    tables: tables.map(({ table, columns }) => ({ table, columns: exportSchema(columns) })),
  });
}

export function parseInvitation(text) {
  const inv = decodeCode(text, 'invitation');
  const ok = HEX16.test(inv.id) && HEX16.test(inv.export) && typeof inv.name === 'string' && (!inv.secret || SECRET.test(inv.secret)) &&
    Array.isArray(inv.tables) && inv.tables.length > 0 && inv.tables.every(tb => tb && COL_ID.test(tb.table) && validColumns(tb.columns)) &&
    new Set(inv.tables.map(tb => tb.table)).size === inv.tables.length;
  const publicBase = inv.mode === 'public' ? safeDocBaseUrl(inv.base) : '';
  if (!ok || (inv.mode === 'public' && !publicBase)) throw new Error('codeInvalid');
  const from = inv.from && typeof inv.from === 'object' ? inv.from : {};
  return {
    id: inv.id, export: inv.export, name: inv.name.slice(0, 200), secret: inv.secret || '', origin: String(inv.origin || ''),
    mode: publicBase ? 'public' : 'reponse', base: publicBase,
    from: { email: String(from.email || '').slice(0, 200), docId: String(from.docId || '').slice(0, 200) },
    tables: inv.tables.map(tb => ({ table: tb.table, columns: exportSchema(tb.columns) })),
  };
}

// `url` : l'adresse d'écriture du journal de l'export dans la CIBLE.
export function buildReply({ id, secret = '', recipient, url }) {
  return encodeCode({ kind: 'reponse', id, secret, recipient, url });
}

// `sourceOrigin` : origine de l'instance du document SOURCE. Le webhook ne part que vers la même
// instance, à une adresse d'écriture par clé de formulaire, rien d'autre.
export function parseReply(text, sourceOrigin) {
  const reply = decodeCode(text, 'reponse');
  const target = parseWebhookUrl(reply.url);
  if (!HEX16.test(reply.id) || (reply.secret && !SECRET.test(reply.secret)) || !target || !target.flat ||
      !reply.recipient || typeof reply.recipient !== 'object') {
    throw new Error('codeInvalid');
  }
  if (target.origin !== sourceOrigin) throw new Error('otherInstance');
  const r = reply.recipient;
  const recipient = Object.fromEntries(['email', 'docId', 'team', 'at'].map(k => [k, String(r[k] ?? '').slice(0, 200)]));
  return { id: reply.id, secret: reply.secret || '', recipient, url: reply.url };
}

// ---------------------------------------------------------------------------------------------
// Adresses

// Lien « Copier le lien » d'un formulaire publié : https://<instance>[/o/<équipe>]/forms/<clé>/<n>
export function parseFormLink(link) {
  let url;
  try { url = new URL(String(link || '').trim()); } catch (e) { return null; }
  const m = url.pathname.match(/^((?:\/o\/[^/]+)?)\/forms\/([A-Za-z0-9]+)\/\d+\/?$/);
  return m && /^https?:$/.test(url.protocol) ? { origin: url.origin, prefix: m[1], key: m[2] } : null;
}

export function buildWebhookUrl(formLink, journalTable) {
  const form = parseFormLink(formLink);
  return form && COL_ID.test(journalTable) ? `${form.origin}${form.prefix}/api/s/${form.key}/tables/${journalTable}/records?flat=1` : null;
}

export function parseWebhookUrl(text) {
  let url;
  try { url = new URL(String(text || '')); } catch (e) { return null; }
  const m = url.pathname.match(/^((?:\/o\/[^/]+)?)\/api\/s\/([A-Za-z0-9]+)\/tables\/([A-Za-z_][A-Za-z0-9_]*)\/records$/);
  if (!m || !/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  return { origin: url.origin, prefix: m[1], key: m[2], table: m[3], flat: url.search === '?flat=1' };
}

// Boucles refusées à l'approbation : renvoyer une table reçue vers le document d'où elle vient
// (relais retour, ou table vers elle-même dans le même document). `received` : tables reçues ici,
// avec le document qui les envoie ({ dest, fromDocId }). Rend les tables en cause.
export function loopingTables(tables, recipientDocId, received) {
  if (!recipientDocId) return [];
  return tables.filter(table => received.some(r => r.dest === table && r.fromDocId === recipientDocId));
}

// La clé de partage est un droit d'écriture : on ne l'affiche jamais en entier.
export function maskKey(url) {
  return String(url || '').replace(/\/api\/s\/([A-Za-z0-9]{4})[A-Za-z0-9]*/, '/api/s/$1…');
}

// `baseUrl` renvoyé par getAccessToken : https://<instance>[/o/<équipe>]/api/docs/<docId>
// Adresse REST d'un document, réécrite à partir de ses seuls éléments reconnus ; '' sinon.
function safeDocBaseUrl(text) {
  try {
    const url = new URL(String(text));
    const { team, docId } = parseDocBaseUrl(url.href);
    if (!/^https?:$/.test(url.protocol) || url.search || url.username || !/^[A-Za-z0-9_-]+$/.test(docId)) return '';
    return `${url.origin}${team ? `/o/${encodeURIComponent(team)}` : ''}/api/docs/${docId}`;
  } catch (e) {
    return '';
  }
}

export function parseDocBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const m = url.pathname.match(/^(?:\/o\/([^/]+))?\/api\/docs\/([^/]+)\/?$/);
  return { origin: url.origin, team: m ? m[1] || '' : '', docId: m ? m[2] : '' };
}
