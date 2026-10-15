// Logique pure de la synchro : ni DOM, ni `grist`, ni réseau. Tout ce qui décide (quelle
// version gagne, quoi écrire, quelle adresse accepter, quelles colonnes posent problème) est
// ici, testé par `tests/unit/core.test.mjs`. Les autres modules lisent Grist, appellent ces
// fonctions et appliquent le résultat.

export const KEY_COL = 'id_sync';
export const ORDER_COL = 'MajLe';
// Heure du dernier recalcul de MajLe (formule ordinaire). Une annulation (Ctrl+Z) remet MajLe à sa
// valeur d'avant, mais Grist recalcule cette colonne : c'est ainsi que le lot repère une annulation.
export const RECALC_COL = 'RecalculLe';
// Échange : heure (NOW()) où la consolidation a écrit la ligne (formule de déclenchement sur
// MajLe). La consolidation y écrit MajLe à l'heure de la version reçue : la ligne ressemble alors à
// une annulation (MajLe ancienne, RecalculLe recalculée à l'instant), mais RecuLe, recalculée dans le
// même lot, la désigne comme reçue. Elle ne repart pas vers l'autre document (pas d'écho).
export const ECHO_COL = 'RecuLe';
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
// Chaque table d'un export y a ses lignes : sa liste des clés et son lot de lignes modifiées
// (envoyés), son suivi des clés (jamais envoyé), son filtre de lignes s'il y en a un, et son
// instantané complet pour un export partagé par lien public.
export const SYNC_TABLE = 'Synchro';
export const EXPORT_COL = 'Synchro_Export'; // identifiant de l'export
export const TABLE_COL = 'Synchro_Table'; // table SOURCE (et, dans le journal, table d'origine d'une ligne)
export const TYPE_COL = 'Synchro_Type'; // voir KIND
export const RESEND_COL = 'Synchro_Renvoi'; // lignes à renvoyer, écrites par le widget
export const LOT_COL = 'Synchro_Lot'; // lot : lignes récentes avec leurs colonnes, en JSON
// Lot coupé : depuis quand des lignes restent à envoyer (0 : rien). Le webhook envoie chaque ligne
// de Synchro entière, et un journal refuse une colonne qu'il n'a pas : la marque reprend donc le nom
// d'une colonne que tous les journaux ont déjà, pour que les CIBLES existantes l'acceptent.
export const MISSING_COL = STATE_COL;
// Même colonne, ligne 'suivi' : le suivi des clés de la table, par seaux (JSON, voir syncFormulas).
export const TRACK_COL = STATE_COL;
// Types de ligne. Les webhooks n'envoient que les listes et les lots ('cles', 'lot') ; le suivi des
// clés, le filtre de lignes et la marque d'un export en Échange ('echange') restent dans la SOURCE ;
// 'complet' n'est lu que par le lien public.
export const KIND = { keys: 'cles', lot: 'lot', full: 'complet', filter: 'filtre', track: 'suivi', swap: 'echange' };
const WINDOW_S = 5; // un lot porte les lignes modifiées depuis 5 secondes
// Au chargement du document, Grist recalcule RECALC_COL pour toutes les lignes : ce n'est pas une
// annulation, sauf dans une petite table, renvoyée alors en entier (quelques lignes).
const SMALL_TABLE = 20;
// Octets d'un lot. Grist refuse un envoi de plus de 1 Mo, et un même envoi regroupe les listes des
// clés et les lots des tables d'un export qui changent ensemble : chaque lot prend sa part de ce
// que les listes laissent.
const LOT_MAX = 250000;
const POST_MAX = 950000;
const LOT_MIN = 20000;
// Les clés d'une table sont réparties en BUCKETS seaux (selon le CRC-32 de la clé) ; le suivi ne
// garde qu'une somme par seau, de taille fixe quelle que soit la table (la liste de toutes les
// clés, réécrite à chaque ajout, faisait grossir l'historique du document de 1,5 Mo par ligne
// ajoutée sur 20 000 lignes ; les sommes, de quelques Ko, mesuré). Un seau qui perd une clé part
// en entier (ses clés restantes) ; au-delà de PART_KEYS clés à envoyer d'un coup, le widget SOURCE
// renvoie la liste complète, par morceaux de PART_KEYS clés. Une clé (UUID) fait une quarantaine
// d'octets : de quoi laisser la place aux lots.
const BUCKETS = 256;
const PART_KEYS = 5000;
export const RESEND_CHUNK = 200; // lignes par renvoi
export const RESEND_ALL = 1; // marque de renvoi : toute la table, lignes sans MajLe comprises

const LIST_PREFIX = 'ids:';
const CODE_PREFIX = 'GRISTSYNC2.';
const CHUNK = 500; // lignes par action

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

export const toHex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const randomHex = n => toHex(crypto.getRandomValues(new Uint8Array(n)));

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

// Formules de la table Synchro. Elles nomment en clair les tables qu'elles peuvent lire (`tables`,
// qui doivent exister : une table inconnue mettrait toutes les lignes en erreur) : le widget les
// réécrit quand un export gagne ou perd une table. Leurs variables sont en minuscules, comme aucun
// nom de table Grist.
//  - TRACK_COL (lignes 'suivi', formule de déclenchement) : l'heure du dernier changement des clés
//    (`t`), le plus grand numéro de ligne vu (`top`), la somme des CRC-32 des clés de chaque seau
//    (`s`), et les clés des seaux qui en ont perdu une (`seaux`). Une ligne de numéro supérieur à
//    `top` est nouvelle : un seau dont la somme a bougé d'autre chose que ses nouvelles clés a perdu
//    une clé (ou changé une clé). Au-delà de PART_KEYS clés à envoyer, `trop` (l'heure) reste posé
//    jusqu'à ce que le widget SOURCE ait renvoyé la liste complète (il recopie alors `trop` dans
//    Synchro_Renvoi du suivi). Sur les lignes 'lot',
//    la même colonne est la marque d'envoi coupé : la plus ancienne date d'un lot coupé, gardée
//    jusqu'à ce que le widget envoie le reste (un lot de renvoi coupé ne compte pas : le widget le
//    recoupe lui-même).
//  - Synchro_Ids : lignes 'cles', ce qu'il faut envoyer de la liste, en JSON : les seaux qui ont
//    perdu une clé, et pendant un renvoi le morceau de la liste complète demandé dans
//    Synchro_Renvoi ({ marque, n, apres }), à l'heure `t` du suivi ; lignes 'suivi', le nombre de
//    clés et la somme de leurs CRC-32 : recalculés à chaque changement des clés, ils déclenchent le
//    suivi.
//  - Synchro_Lot (lignes 'lot') : les lignes modifiées depuis WINDOW_S secondes et celles
//    demandées dans Synchro_Renvoi, avec les colonnes de l'export, plafonné à LOT_MAX octets
//    (`total` dit combien il y en avait) ; lignes 'complet' (lien public) : toutes les lignes.
// Une ligne annulée (Ctrl+Z : MajLe revenue en arrière, RECALC_COL recalculée à l'instant) part avec
// l'heure de l'annulation, pour l'emporter sur la version qu'elle annule. Une ligne écrite par la
// consolidation d'un Échange (ECHO_COL recalculée en même temps que RECALC_COL) part avec l'heure
// de sa version vers les autres exports, et pas vers l'autre document de l'Échange.
// Une valeur est lue à part : une cellule en erreur part vide sans bloquer les autres. Dates en
// secondes (format de Grist), Référence par son texte affiché. Un lot coupé dit depuis quand
// (`depuis`) : la marque MISSING_COL le retient, et le widget SOURCE envoie le reste. `Supprime`
// part telle quelle : la CIBLE la lit comme une case à cocher (« Non » ne supprime pas).
export function syncFormulas(tables) {
  const ids = [...new Set(tables)].filter(id => COL_ID.test(id)).sort();
  const pick = `tables = {${ids.map(id => `"${id}": ${id}`).join(', ')}}\nsrc = tables.get($${TABLE_COL})`;
  // Lecture d'une valeur (`g`) et filtre de lignes de la table dans l'export (`keep`), communs aux
  // formules : une ligne qui sort du filtre quitte les clés, la CIBLE l'efface.
  const read = [
    'import json, datetime',
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
    'def txt(x):',
    '  if isinstance(x, bool): return "oui" if x else "non"',
    '  if isinstance(x, float) and x.is_integer(): x = int(x)',
    '  if isinstance(x, list): return ", ".join(txt(y) for y in x)',
    '  return "" if x is None else str(x).strip().lower()',
    `f = ${SYNC_TABLE}.lookupOne(${EXPORT_COL}=$${EXPORT_COL}, ${TABLE_COL}=$${TABLE_COL}, ${TYPE_COL}="${KIND.filter}")`,
    `spec = json.loads(f.${SCHEMA_COL} or "null") if f.id else None`,
    'def keep(r): return not spec or txt(g(r, spec)) == spec["value"]',
  ];
  const keys = [
    `if $${TYPE_COL} not in ("${KIND.keys}", "${KIND.track}"): return ""`, pick, 'if src is None: return ""', ...read,
    `if $${TYPE_COL} == "${KIND.track}":`,
    '  import zlib',
    `  sums = [zlib.crc32(str(r.${KEY_COL}).encode()) for r in src.all if r.${KEY_COL} and keep(r)]`,
    '  return "%d:%08x" % (len(sums), sum(sums) & 0xffffffff)',
    'import bisect',
    `s = ${SYNC_TABLE}.lookupOne(${EXPORT_COL}=$${EXPORT_COL}, ${TABLE_COL}=$${TABLE_COL}, ${TYPE_COL}="${KIND.track}")`,
    `state = json.loads(s.${TRACK_COL}) if s.id and isinstance(s.${TRACK_COL}, str) and s.${TRACK_COL}.startswith("{") else {}`,
    'out = {"t": state["t"], "seaux": state["seaux"]} if state.get("seaux") else {}',
    `ask = json.loads($${RESEND_COL}) if ($${RESEND_COL} or "").startswith("{") else None`,
    // Le morceau porte l'heure du suivi : les clés n'ont pas changé depuis (sinon le suivi aussi).
    'if ask and state.get("t"):',
    `  have = sorted(set(str(r.${KEY_COL}) for r in src.all if r.${KEY_COL} and keep(r)))`,
    '  i = bisect.bisect_right(have, str(ask.get("apres") or ""))',
    `  out["liste"] = {"marque": ask.get("marque"), "n": ask.get("n"), "t": state["t"], "cles": have[i:i + ${PART_KEYS}], "fin": i + ${PART_KEYS} >= len(have)}`,
    'return json.dumps(out) if out else ""',
  ].join('\n');
  const lot = [
    `if $${TYPE_COL} not in ("${KIND.lot}", "${KIND.full}"): return ""`, pick, 'if src is None: return ""', ...read,
    `cols = json.loads($${SCHEMA_COL} or "[]")`,
    `again = set(int(i) for i in ($${RESEND_COL} or "").split(":")[-1].split(",") if i.strip().isdigit())`,
    `rows = [r for r in src.all if r.${KEY_COL} and keep(r)]`,
    'undone = set()',
    `if $${TYPE_COL} == "${KIND.lot}":`,
    `  swap = ${SYNC_TABLE}.lookupOne(${EXPORT_COL}=$${EXPORT_COL}, ${TYPE_COL}="${KIND.swap}").id`,
    `  cut = NOW() - datetime.timedelta(seconds=${WINDOW_S})`,
    `  recent = set(r.id for r in rows if r.${ORDER_COL} and r.${ORDER_COL} >= cut)`,
    '  def echo(r):',
    `    x, y = getattr(r, "${ECHO_COL}", None), getattr(r, "${RECALC_COL}", None)`,
    '    return bool(x and y and y > cut and abs((y - x).total_seconds()) < 1)',
    '  fresh = set() if swap else set(r.id for r in rows if r.id not in recent and echo(r))',
    `  undone = set(r.id for r in rows if r.id not in recent and not echo(r) and (getattr(r, "${RECALC_COL}", None) or cut) > cut)`,
    // Toutes les lignes recalculées d'un coup : un rechargement du document, pas une annulation (une
    // petite table repart, sauf dans un Échange, où une version ancienne écraserait l'autre côté).
    `  if len(recent) + len(undone) == len(rows) > (0 if swap else ${SMALL_TABLE}): undone = set()`,
    '  rows = [r for r in rows if r.id in again or r.id in recent or r.id in undone or r.id in fresh]',
    `def when(r): return v(getattr(r, "${RECALC_COL}") if r.id in undone else r.${ORDER_COL})`,
    // Les listes de l'export partent dans le même envoi : chaque lot prend sa part de ce qu'elles laissent.
    `lists = ${SYNC_TABLE}.lookupRecords(${EXPORT_COL}=$${EXPORT_COL}, ${TYPE_COL}="${KIND.keys}")`,
    `room = ${POST_MAX} - sum(len(r.${LIST_COL} or "") for r in lists)`,
    `budget = max(${LOT_MIN}, min(${LOT_MAX}, room // max(1, len(lists))))`,
    `capped = $${TYPE_COL} == "${KIND.lot}"`,
    'out, size, big = [], 0, []',
    `for r in sorted(rows, key=lambda r: when(r) or 0, reverse=True):`,
    `  line = [r.${KEY_COL}, when(r), v(getattr(r, "${DELETE_COL}", False)), {c["id"]: g(r, c) for c in cols}]`,
    '  n = len(json.dumps(line, ensure_ascii=False))',
    // Une ligne plus grosse qu'un envoi ne partira jamais : signalée, pas renvoyée sans fin.
    `  if capped and n > max(budget, room):`,
    `    big.append(r.${KEY_COL})`,
    '    continue',
    // Le premier venu part même s'il dépasse le plafond du lot : seul, il tient dans un envoi.
    '  if capped and out and size + n > budget: break',
    '  size += n',
    '  out.append(line)',
    'lot = {"lignes": out, "total": len(rows)}',
    'if big: lot["tropGros"] = big',
    `if capped and len(out) + len(big) < len(rows): lot.update(depuis=v(cut), renvoi=bool(again))`,
    'return json.dumps(lot, ensure_ascii=False)',
  ].join('\n');
  const state = [
    'import json',
    `if $${TYPE_COL} == "${KIND.lot}":`,
    `  lot = json.loads($${LOT_COL} or "{}")`,
    '  if lot.get("depuis") and not lot.get("renvoi"):',
    '    return min(value, lot["depuis"]) if value else lot["depuis"]',
    '  return value',
    `if $${TYPE_COL} != "${KIND.track}": return value`, pick, 'if src is None: return value', ...read,
    'import zlib',
    'old = json.loads(value) if isinstance(value, str) and value.startswith("{") else {}',
    'top = old.get("top", 0)',
    `sums, fresh, keys = [0] * ${BUCKETS}, [0] * ${BUCKETS}, []`,
    'for r in src.all:',
    `  if not r.${KEY_COL} or not keep(r): continue`,
    `  k = str(r.${KEY_COL})`,
    '  h = zlib.crc32(k.encode())',
    `  b = h * ${BUCKETS} >> 32`,
    '  sums[b] = (sums[b] + h) & 0xffffffff',
    '  if r.id > top: fresh[b] = (fresh[b] + h) & 0xffffffff',
    '  keys.append((b, k))',
    'was = old.get("s")',
    'if was == sums: return value',
    't = v(NOW())',
    'state = {"t": t, "top": max([top] + [r.id for r in src.all]), "s": sums}',
    `if isinstance(was, list) and len(was) == ${BUCKETS}:`,
    `  moved = set(b for b in range(${BUCKETS}) if (was[b] + fresh[b]) & 0xffffffff != sums[b])`,
    '  left = {str(b): [] for b in moved}',
    '  for b, k in keys:',
    '    if b in moved: left[str(b)].append(k)',
    `  if sum(len(x) for x in left.values()) > ${PART_KEYS}: state["trop"] = str(t)`,
    '  elif left: state["seaux"] = {b: sorted(x) for b, x in left.items()}',
    `if old.get("trop") and old["trop"] != $${RESEND_COL} and "trop" not in state: state["trop"] = old["trop"]`,
    'return json.dumps(state)',
  ].join('\n');
  return { keys, lot, state };
}

// Colonnes de la table Synchro. Le journal de la CIBLE doit toutes les avoir (le webhook envoie
// chaque ligne entière) : une colonne ajoutée ici doit déjà exister dans les journaux.
export function syncColumns(tables) {
  const { keys, lot, state } = syncFormulas(tables);
  return [
    { id: EXPORT_COL, type: 'Text', isFormula: false },
    { id: TABLE_COL, type: 'Text', isFormula: false },
    { id: TYPE_COL, type: 'Text', isFormula: false },
    { id: SCHEMA_COL, type: 'Text', isFormula: false },
    { id: RESEND_COL, type: 'Text', isFormula: false },
    { id: LIST_COL, type: 'Text', isFormula: true, formula: keys },
    { id: LOT_COL, type: 'Text', isFormula: true, formula: lot },
    // Formule de déclenchement : ses dépendances (Synchro_Lot et Synchro_Ids) sont posées après coup.
    { id: TRACK_COL, type: 'Any', isFormula: false, formula: state, recalcWhen: 0 },
    // E-mail de la personne qui crée l'export : présenté à la CIBLE comme propriétaire.
    { id: AUTHOR_COL, type: 'Text', isFormula: false, formula: 'user.Email', recalcWhen: 0 },
  ];
}

// Lignes Synchro d'un export : par table, sa liste des clés, son lot, son suivi des clés, son
// filtre s'il en a un, et son instantané complet s'il est partagé par lien public. `rows` : lignes Synchro existantes. Rend les actions qui
// amènent l'export à `tables` ([{ table, columns }], colonnes de `exportableColumns`) : lignes
// ajoutées, colonnes changées, lignes des tables retirées effacées. `changed` : tables nouvelles
// ou aux colonnes changées, dont les lignes sont à renvoyer.
export function exportRowsActions(rows, exportId, tables, { isPublic = false } = {}) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId);
  const kinds = [KIND.keys, KIND.lot, KIND.track, ...(isPublic ? [KIND.full] : [])];
  const add = [];
  const update = [];
  const changed = [];
  const wanted = new Set(); // `table|type` des lignes à garder
  for (const { table, columns, filter } of tables) {
    const schema = JSON.stringify(columns.map(({ id, type, label, source, visible }) => ({ id, type, label, source, visible })));
    const kept = rowFilter(filter);
    // Valeur de Synchro_Colonnes par type de ligne : les colonnes, ou le filtre de la table.
    const values = new Map([...kinds.map(kind => [kind, schema]), ...(kept ? [[KIND.filter, JSON.stringify(kept)]] : [])]);
    const here = mine.filter(r => r[TABLE_COL] === table);
    const was = (here.find(r => r[TYPE_COL] === KIND.filter) || {})[SCHEMA_COL] || '';
    if (!here.length || here.some(r => r[TYPE_COL] !== KIND.filter && r[SCHEMA_COL] !== schema) || was !== (values.get(KIND.filter) || '')) changed.push(table);
    for (const [kind, value] of values) {
      wanted.add(`${table}|${kind}`);
      const row = here.find(r => r[TYPE_COL] === kind);
      if (!row) add.push({ [EXPORT_COL]: exportId, [TABLE_COL]: table, [TYPE_COL]: kind, [SCHEMA_COL]: value, [RESEND_COL]: '' });
      else if (row[SCHEMA_COL] !== value) update.push([row.id, value]);
    }
  }
  const remove = mine.filter(r => !wanted.has(`${r[TABLE_COL]}|${r[TYPE_COL]}`)).map(r => r.id);
  const cols = [EXPORT_COL, TABLE_COL, TYPE_COL, SCHEMA_COL, RESEND_COL];
  const actions = [];
  if (add.length) actions.push(['BulkAddRecord', SYNC_TABLE, add.map(() => null), Object.fromEntries(cols.map(c => [c, add.map(r => r[c])]))]);
  if (update.length) actions.push(['BulkUpdateRecord', SYNC_TABLE, update.map(u => u[0]), { [SCHEMA_COL]: update.map(u => u[1]) }]);
  if (remove.length) actions.push(['BulkRemoveRecord', SYNC_TABLE, remove]);
  return { actions, changed };
}

// Montage d'avant la version 0.5 : le suivi des clés manque aux tables des exports. Rend l'action
// qui l'ajoute (le suivi part des clés présentes : rien n'est effacé dans les CIBLES), ou null.
export function addTrackRowsAction(rows) {
  const has = new Set(rows.filter(r => r[TYPE_COL] === KIND.track).map(r => `${r[EXPORT_COL]}|${r[TABLE_COL]}`));
  const add = rows.filter(r => r[TYPE_COL] === KIND.keys && !has.has(`${r[EXPORT_COL]}|${r[TABLE_COL]}`));
  if (!add.length) return null;
  const cols = [EXPORT_COL, TABLE_COL, SCHEMA_COL];
  return ['BulkAddRecord', SYNC_TABLE, add.map(() => null),
    { ...Object.fromEntries(cols.map(c => [c, add.map(r => r[c] ?? '')])), [TYPE_COL]: add.map(() => KIND.track), [RESEND_COL]: add.map(() => '') }];
}

// Tables et colonnes d'un export, lues dans ses lignes Synchro.
export function exportTables(rows, exportId) {
  const mine = rows.filter(r => r[EXPORT_COL] === exportId);
  const tables = new Map();
  for (const r of mine) {
    if (r[TYPE_COL] !== KIND.filter && !tables.has(r[TABLE_COL])) tables.set(r[TABLE_COL], parseJson(r[SCHEMA_COL], []) || []);
  }
  const filterOf = table => rowFilter(parseJson((mine.find(r => r[TABLE_COL] === table && r[TYPE_COL] === KIND.filter) || {})[SCHEMA_COL], null));
  return [...tables].map(([table, columns]) => ({ table, columns, filter: filterOf(table) }));
}

// Filtre de lignes d'une table : n'envoyer que les lignes dont la colonne `id` vaut `value` (texte
// affiché, sans tenir compte des majuscules ; une case à cocher vaut « oui » ou « non »). Rend le
// filtre tel que la formule le lit, ou null s'il est vide ou mal formé.
const YES = ['oui', 'yes', 'vrai', 'true', '1', 'x'];
export function rowFilter(filter) {
  if (!filter || !COL_ID.test(String(filter.id || ''))) return null;
  const source = String(filter.source || '');
  const text = String(filter.value ?? '').trim().toLowerCase();
  const value = source === 'Bool' ? (YES.includes(text) ? 'oui' : 'non') : text;
  return { id: filter.id, source, visible: String(filter.visible || ''), value };
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

// Morceau `n` de la liste complète d'un renvoi, après la clé `after` (Synchro_Renvoi de la ligne
// 'cles'). `mark` distingue un renvoi des autres.
export const listRequest = (mark, n, after) => JSON.stringify({ marque: mark, n, apres: after });

// Suivi des clés d'une table (ligne 'suivi') : { t, top, s, seaux, trop } ; {} s'il n'y en a pas.
export const trackState = row => (row && row[TYPE_COL] === KIND.track ? parseJson(row[TRACK_COL], null) || {} : {});

// Trop de clés à envoyer d'un coup, et la liste complète pas encore renvoyée depuis.
export const listOverdue = (row) => {
  const { trop } = trackState(row);
  return Boolean(trop) && trop !== row[RESEND_COL];
};

// Seau d'une clé (voir BUCKETS) : les premiers bits de son CRC-32, comme zlib.crc32 en Python.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(text) {
  let c = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const bucketOf = key => Math.floor(crc32(String(key)) * BUCKETS / 2 ** 32);

// Liste reçue (Synchro_Ids d'une ligne 'cles') : { buckets: { t, keys: Map(seau -> Set(clés)) } }
// pour les seaux qui ont perdu une clé, { part: { mark, n, t, keys, last } } pour un morceau de
// liste complète, les deux à la fois, ou
// { full: [clés] } pour une liste complète d'un seul tenant (« ids:… » : montage 0.4, lien public).
// null si elle est vide ou illisible.
export function parseList(text) {
  const s = String(text || '');
  if (s.startsWith(LIST_PREFIX)) return { full: s.slice(LIST_PREFIX.length).split(' ').filter(Boolean) };
  const list = parseJson(s);
  if (!list || typeof list !== 'object') return null;
  const strings = a => (Array.isArray(a) ? a.filter(k => !isBlank(k)).map(String) : []);
  const out = {};
  const seaux = list.seaux && typeof list.seaux === 'object' ? Object.entries(list.seaux).filter(([b]) => /^\d+$/.test(b) && Number(b) < BUCKETS) : [];
  if (seaux.length && typeof list.t === 'number') out.buckets = { t: list.t, keys: new Map(seaux.map(([b, keys]) => [Number(b), new Set(strings(keys))])) };
  const p = list.liste;
  if (p && typeof p === 'object' && typeof p.marque === 'string' && p.marque && Number.isInteger(p.n) && p.n > 0 && typeof p.t === 'number') {
    out.part = { mark: p.marque, n: p.n, t: p.t, keys: strings(p.cles), last: p.fin === true };
  }
  return out.buckets || out.part ? out : null;
}

// Lot reçu : { lines: [{ key, order, deleted, data }], total } ; null s'il est illisible.
export function parseLot(text) {
  const lot = parseJson(text);
  if (!lot || !Array.isArray(lot.lignes)) return null;
  const lines = lot.lignes.filter(l => Array.isArray(l) && !isBlank(l[0]) && l[3] && typeof l[3] === 'object')
    .map(([key, order, deleted, data]) => ({ key: String(key), order: order ?? null, deleted: isTrue(deleted), data }));
  const big = Array.isArray(lot.tropGros) ? lot.tropGros.map(String) : [];
  return { lines, total: Number(lot.total) || lines.length, big };
}

// Colonnes qu'une table SOURCE peut envoyer : toutes ses colonnes de données et formules, hors
// colonnes de la synchro et colonnes internes de Grist. Les pièces jointes ne peuvent pas partir
// (`blocked`). Une Référence part comme le texte qu'elle affiche.
export function exportableColumns(cols) {
  const skip = new Set(['manualSort', KEY_COL, ORDER_COL, RECALC_COL, ECHO_COL, DELETE_COL]);
  return cols.filter(c => !skip.has(c.colId) && !c.colId.startsWith('gristHelper_')).map(c => ({
    id: c.colId, label: c.label || c.colId, type: /^Ref(List)?:/.test(c.type) ? 'Text' : c.type, source: c.type,
    visible: c.visible || '', blocked: c.type === 'Attachments',
  }));
}

// Description des colonnes envoyées, telle que la CIBLE la reçoit.
const exportSchema = columns => columns.map(({ id, type, label }) => ({ id, type, label }));

// Colonnes de la synchro qui manquent à la table SOURCE.
export const missingSyncColumns = cols => [KEY_COL, ORDER_COL, RECALC_COL].filter(id => !cols.some(c => c.colId === id));

// id_sync : UUID posé à la création. MajLe : NOW() à toute modification de la ligne.
export function prepareSourceActions(tableId, missing) {
  const specs = {
    [KEY_COL]: { type: 'Text', isFormula: false, formula: 'UUID()', recalcWhen: 0 },
    [ORDER_COL]: { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 2 },
    [RECALC_COL]: { type: 'DateTime:UTC', isFormula: true, formula: `$${ORDER_COL}\nreturn NOW()` },
    [ECHO_COL]: { type: 'DateTime:UTC', isFormula: false, formula: 'NOW()', recalcWhen: 0 },
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

// Renvoi reprenable : lignes d'une table à renvoyer depuis `since` (RESEND_ALL : toutes), dans
// l'ordre de MajLe. Chaque tranche part avec la marque `chunkMark` : ses lignes et les suivantes
// restent à envoyer, de sorte qu'un renvoi interrompu reprend à la dernière tranche.
const majle = r => r[ORDER_COL] || 0;
export const rowsSince = (rows, since) => rows.filter(r => since <= RESEND_ALL || majle(r) >= since)
  .sort((a, b) => majle(a) - majle(b) || a.id - b.id);
export const chunkMark = (part, since) => Math.max(since, majle(part[0]));

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
// suppression, bloc des colonnes, table d'origine), chaque liste des clés une ligne de liste (qui
// porte aussi la description des colonnes) ; les
// lignes reçues sont effacées dans le même lot. Les nouvelles lignes gardent l'ordre d'arrivée
// (numéros croissants) et la date d'arrivée. Rend aussi, par table, les lignes qu'un lot trop gros
// n'a pas portées depuis le dernier renvoi (`missing`) et les tables reçues par un renvoi
// (`resent`), dont le compte précédent ne vaut plus.
export function planUnpack(journalRows, journalTable) {
  const raw = journalRows.filter(isRaw).sort((a, b) => a.id - b.id);
  const added = [];
  const missing = {};
  const big = {}; // table -> clés des lignes trop grosses pour un envoi, et clés arrivées
  const arrived = {};
  const resent = new Set();
  for (const row of raw) {
    const table = String(row[TABLE_COL] || '');
    if (!COL_ID.test(table)) continue;
    const base = { [TABLE_COL]: table, [RECEIVED_COL]: row[RECEIVED_COL] ?? null };
    if (row[TYPE_COL] === KIND.keys) {
      const list = String(row[LIST_COL] || '');
      if (list || row[SCHEMA_COL]) added.push({ ...base, [LIST_COL]: list, [SCHEMA_COL]: row[SCHEMA_COL] || '' });
      continue;
    }
    const lot = parseLot(row[LOT_COL]);
    if (!lot) continue;
    lot.lines.forEach((l, i) => added.push({
      ...base, [KEY_COL]: l.key, [ORDER_COL]: l.order, [DELETE_COL]: l.deleted, [DATA_COL]: JSON.stringify(l.data),
      ...(i === 0 ? { [SCHEMA_COL]: row[SCHEMA_COL] || '' } : {}),
    }));
    if (lot.big.length) big[table] = [...(big[table] || []), ...lot.big];
    arrived[table] = [...(arrived[table] || []), ...lot.lines.map(l => l.key)];
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
  return { actions, missing, big, arrived, resent: [...resent] };
}

// Ce qui manque encore dans la CIBLE, mis à jour d'après un dépliage : le nombre de lignes pas
// encore arrivées par table (`missing`) et les clés des lignes trop grosses pour un envoi de Grist
// (`big`). Un renvoi remet sa table à zéro ; une ligne arrivée sort de `big`.
export function nextGaps({ missing = {}, big = {} }, unpack) {
  const nextMissing = { ...missing };
  const nextBig = { ...big };
  for (const table of unpack.resent) {
    delete nextMissing[table];
    delete nextBig[table];
  }
  for (const [table, n] of Object.entries(unpack.missing)) if (n > 0) nextMissing[table] = (nextMissing[table] || 0) + n;
  for (const table of new Set([...Object.keys(unpack.big), ...Object.keys(unpack.arrived)])) {
    const gone = new Set(unpack.arrived[table] || []);
    const keys = [...new Set([...(nextBig[table] || []), ...(unpack.big[table] || [])])].filter(k => !gone.has(k));
    if (keys.length) nextBig[table] = keys;
    else delete nextBig[table];
  }
  return { missing: nextMissing, big: nextBig };
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
const TECHNICAL = new Set(['id', 'manualSort', KEY_COL, ORDER_COL, RECALC_COL, ECHO_COL, DELETE_COL, LIST_COL, APPLIED_COL, AUTHOR_COL, RECEIVED_COL, STATE_COL,
  DATA_COL, SCHEMA_COL, EXPORT_COL, TABLE_COL, TYPE_COL, RESEND_COL, LOT_COL]);
export function copyColumns(journalCols, destCols, map = {}) {
  const writable = new Set(destCols.filter(c => !c.isFormula).map(c => c.colId));
  return journalCols.map(c => c.colId).filter(id => !TECHNICAL.has(id) && !id.startsWith('gristHelper_'))
    .map(id => [id, map[id] || id]).filter(([, to]) => writable.has(to) && to !== KEY_COL);
}

// Destination renommée dans la CIBLE : la table et ses colonnes sont suivies par leur numéro dans
// Grist, noté à chaque passage (`refs`, voir destRefs). Rend l'entrée avec les noms actuels : la
// destination, la correspondance des colonnes (`map`) et la colonne de rattachement (`match`).
export function followRenames(entry, schema) {
  const { table: tableRef, cols = {} } = entry.refs || {};
  const dest = (tableRef && schema.tableIdOf(tableRef)) || entry.dest;
  const current = new Map((schema.columns(dest) || []).map(c => [c.id, c.colId]));
  const renamed = new Map(Object.entries(cols).filter(([colId, ref]) => current.has(ref) && current.get(ref) !== colId)
    .map(([colId, ref]) => [colId, current.get(ref)]));
  if (dest === entry.dest && !renamed.size) return entry;
  const map = { ...entry.map };
  for (const id of new Set([...(entry.columns || []).map(c => c.id), ...Object.keys(map)])) {
    const to = map[id] || id;
    if (renamed.has(to)) map[id] = renamed.get(to);
  }
  const next = { ...entry, dest, map };
  if (entry.match) next.match = renamed.get(entry.match) || entry.match;
  return next;
}

// Numéros Grist de la destination et de ses colonnes, notés pour suivre un renommage.
export function destRefs(schema, dest) {
  const table = schema.table(dest);
  return table ? { table: table.id, cols: Object.fromEntries(schema.columns(dest).map(c => [c.colId, c.id])) } : undefined;
}

// Colonnes envoyées arrivées après l'invitation (ni dans `columns`, ni dans `map` d'une table
// reçue) : chacune prend son nom dans la destination, ou un nom libre (`Note_2`) si une colonne de
// la destination (`destColIds`) le porte déjà, pour ne jamais écraser une colonne à elle. Rend la
// correspondance complétée, ou null s'il n'y a rien de nouveau.
export function newColumnsMap({ columns = [], map = {} }, sent, destColIds) {
  const known = new Set([...columns.map(c => c.id), ...Object.keys(map)]);
  const fresh = sent.filter(c => !known.has(c.id));
  if (!fresh.length) return null;
  const taken = [...destColIds, ...Object.values(map)];
  const next = { ...map };
  for (const { id } of fresh) {
    next[id] = freeTableId(id, taken);
    taken.push(next[id]);
  }
  return next;
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

// Dernière liste complète d'un seul tenant reçue (« ids:… », voir parseList).
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

// Listes du journal pas encore traitées, dans l'ordre d'arrivée, avec leur contenu lu.
const pendingLists = rows => rows.filter(r => isBlank(r[KEY_COL]) && !isTrue(r[APPLIED_COL]))
  .map(row => ({ row, list: parseList(row[LIST_COL]) })).filter(l => l.list).sort((a, b) => a.row.id - b.row.id);

// Marque du dernier renvoi dont un morceau de liste est arrivé.
const lastMark = pending => (pending.filter(l => l.list.part).pop() || { list: { part: {} } }).list.part.mark;

// Morceaux de liste complète arrivés en entier (du premier au dernier), par renvoi : { rows,
// keys, t } avec l'heure du premier morceau.
function completeLists(pending) {
  const byMark = new Map();
  for (const { row, list } of pending) {
    if (!list.part) continue;
    if (!byMark.has(list.part.mark)) byMark.set(list.part.mark, []);
    byMark.get(list.part.mark).push({ row, part: list.part });
  }
  const done = [];
  for (const parts of byMark.values()) {
    const last = parts.find(p => p.part.last);
    const have = new Set(parts.map(p => p.part.n));
    if (!last || Array.from({ length: last.part.n }, (_, i) => i + 1).some(n => !have.has(n))) continue;
    done.push({ rows: parts.map(p => p.row), keys: new Set(parts.flatMap(p => p.part.keys)), t: Math.min(...parts.map(p => p.part.t)) });
  }
  return done;
}

// Actions qui amènent la destination à l'état de la SOURCE, en un seul lot, pour une table
// (lignes du journal de cette table seulement) :
//  - la dernière version de chaque clé, si elle n'a pas encore été recopiée ; une clé inconnue
//    de la destination peut y reprendre une ligne existante sans clé de même valeur dans la
//    colonne `matchCol` (rattachement d'un référentiel déjà rempli) ;
//  - la suppression des lignes cochées `Supprime`, des clés parties de la SOURCE (absentes d'un
//    seau qui a perdu une clé, ou d'une liste complète arrivée en entier), sauf si une version plus récente
//    que la liste est arrivée (clé recréée, annulation) : « plus récente » se lit à l'heure de la
//    SOURCE, ou à l'ordre d'arrivée pour une liste « ids:… » qui n'a pas d'heure ;
//  - le marquage des versions et des listes traitées (`Sync_Applique`) et de leur effet
//    (`Sync_Etat`), pour l'historique ; une suppression venue d'une liste est notée sur la
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
  const marks = new Map(); // ligne du Journal -> effet ('' pour une liste ou une version sans effet)
  const listGone = []; // [version, date d'arrivée de la liste]
  const gone = new Set();
  // Clé partie d'après une liste (heure `t` de la SOURCE, ou null : ordre d'arrivée).
  const drop = (key, t, listRow) => {
    if (gone.has(key)) return;
    const version = latest.get(key);
    if (version && (t === null ? version.id > listRow.id : compareOrder(version.order, t) > 0)) return;
    gone.add(key);
    if (version && destByKey.has(key)) listGone.push([version.id, listRow[RECEIVED_COL] ?? null]);
  };
  const known = () => new Set([...destByKey.keys(), ...latest.keys()]);
  let byBucket = null; // seau -> clés connues, calculé une fois
  const bucketed = () => {
    if (!byBucket) {
      byBucket = new Map();
      for (const key of known()) {
        const b = bucketOf(key);
        if (!byBucket.has(b)) byBucket.set(b, []);
        byBucket.get(b).push(key);
      }
    }
    return byBucket;
  };
  const pending = pendingLists(journalRows);
  const mark = lastMark(pending);
  for (const { row, list } of pending) {
    if (list.buckets) {
      const { t, keys } = list.buckets;
      for (const [b, left] of keys) for (const key of bucketed().get(b) || []) if (!left.has(key)) drop(key, t, row);
    }
    // Un morceau de liste complète attend les autres ; celui d'un renvoi remplacé par un autre
    // (interrompu, repris sous une autre marque) ne servira plus.
    if (!list.part || list.part.mark !== mark) marks.set(row.id, '');
  }
  const full = pending.filter(l => l.list.full).pop();
  if (full) {
    const present = new Set(full.list.full);
    for (const key of known()) if (!present.has(key)) drop(key, null, full.row);
  }
  for (const { rows, keys, t } of completeLists(pending)) {
    for (const key of known()) if (!keys.has(key)) drop(key, t, rows[rows.length - 1]);
    rows.forEach(row => marks.set(row.id, ''));
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
    actions.push(['BulkUpdateRecord', journalTable, part.map(([id]) => id),
      { [STATE_COL]: part.map(() => 'suppression'), [RECEIVED_COL]: part.map(([, at]) => at) }]);
  }
  return { actions, stats };
}

// Nettoyage du Journal, dans le même lot. Restent, par table : la dernière version de chaque clé,
// la dernière liste « ids:… » et la dernière description des colonnes (avec leur marque
// `Sync_Applique`) ; les seaux pas encore traités et les morceaux du dernier renvoi pas
// encore arrivé en entier ;
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
    const pending = pendingLists(rows);
    const mark = lastMark(pending);
    for (const { row, list } of pending) if (list.buckets || (list.part && list.part.mark === mark)) kept.add(row.id);
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
    cols.every(c => c && COL_ID.test(c.id) && typeof c.type === 'string' && /^[A-Za-z0-9:_/+-]+$/.test(c.type)); // DateTime:Europe/Paris
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
    from: Object.fromEntries(['email', 'docId', 'docName'].map(k => [k, String(from[k] ?? '').slice(0, 200)])),
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
  const recipient = Object.fromEntries(['email', 'docId', 'docName', 'team', 'at'].map(k => [k, String(r[k] ?? '').slice(0, 200)]));
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

// Un document pour les personnes : son nom et son identifiant, « Annuaire (i446PPRFLcTP) ».
export const docLabel = (name, id) => (name ? `${name} (${id})` : String(id || ''));

// `baseUrl` renvoyé par getAccessToken : https://<instance>[/o/<équipe>]/api/docs/<docId>
export function parseDocBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const m = url.pathname.match(/^(?:\/o\/([^/]+))?\/api\/docs\/([^/]+)\/?$/);
  return { origin: url.origin, team: m ? m[1] || '' : '', docId: m ? m[2] : '' };
}
