// Références conservées entre tables d'un même export. Une colonne Référence part toujours comme le
// texte qu'elle affiche (la CIBLE la lit sans rien savoir de plus) ; quand elle vise une autre table
// de l'export, le lot porte en plus la clé de la ligne visée (`Synchro_Cle_<colonne>` dans le bloc
// de données, voir formulas.js) et la description de la colonne dit vers quelle table (`link`). La
// CIBLE transforme alors la colonne qu'elle a créée en vraie Référence vers la table reçue : la
// valeur écrite est le numéro de la ligne d'ici qui porte cette clé. Une ligne visée pas encore
// arrivée laisse la cellule vide ; elle est complétée à son arrivée (voir fillLinks).
import { APPLIED_COL, DELETE_COL, KEY_COL, LINK_PREFIX, chunk, isBlank, isTrue } from './common.js';
import { latestByKey } from './journal.js';

const linkKey = id => `${LINK_PREFIX}${id}`;
const REF = /^Ref:(\w+)$/;

// Table visée par une colonne Référence qui pourrait garder son lien : elle est dans l'export (la
// même table convient), avec la colonne que la Référence affiche (la CIBLE la reprend pour afficher
// la Référence ; sans elle, elle montrerait des numéros).
const aim = (tables, c) => {
  const target = (REF.exec(c.source || '') || [])[1];
  const there = target && tables.find(tb => tb.table === target);
  return there && c.visible && there.columns.some(x => x.id === c.visible) ? target : '';
};

// SOURCE : les colonnes Référence d'un export qui visent une autre table de l'export (ou la même)
// reçoivent `link` (le nom de la table visée) quand `on`, et le perdent sinon. `tables` : [{ table,
// columns, filter }], colonnes de exportableColumns.
export const linkTables = (tables, on) => tables.map(tb => ({
  ...tb,
  columns: tb.columns.map(({ link, ...c }) => (on && aim(tables, c) ? { ...c, link: aim(tables, c) } : c)),
}));

// Une colonne Référence de l'export pourrait-elle garder son lien ? (pour proposer la case)
export const linkable = tables => tables.some(tb => tb.columns.some(c => aim(tables, c)));

// CIBLE : une colonne envoyée qui garde son lien (`c.link`), avec ce qu'il faut pour en faire une
// Référence : son numéro et son type ici, la table d'ici visée, et la colonne que la Référence
// affiche (numéro et nom ici). Rien si la colonne, ou la colonne affichée, n'est pas là.
// `aim` : entrée de la note de la table visée (destination et correspondance de colonnes).
const columnFor = (schema, entry, id) => {
  const to = (entry.map || {})[id] || id;
  return { to, column: schema.columns(entry.dest).find(x => x.colId === to) };
};
function linkSpec(schema, entry, c, aim) {
  const { to, column } = columnFor(schema, entry, c.id);
  const shownId = (aim.map || {})[c.visible] || c.visible;
  const shown = c.visible && (schema.columns(aim.dest).find(x => x.colId === shownId) || {}).id;
  return column && shown ? { from: c.id, to, ref: column.id, type: column.type, target: aim.dest, shownId, shown } : null;
}

// CIBLE : les colonnes reçues qui gardent leur lien, pour la table `entry` de la note (`sent` :
// colonnes envoyées ; `dests` : table envoyée -> entrée de la note). `ready` : déjà des Références
// vers la table reçue. `todo` : colonnes créées par le widget (`entry.own`), encore du texte, dont
// le sort n'est pas encore décidé (`entry.linked`) ; elles deviennent des Références si elles sont
// vides. `undo` : colonnes que le widget avait faites des Références et que la SOURCE n'envoie plus
// avec leur lien (case décochée, table retirée de l'export) : elles redeviennent du texte.
export function planLinks(schema, entry, sent, dests) {
  if (!schema.has(entry.dest)) return { ready: [], todo: [], undo: [] };
  const decided = new Set(entry.linked || []);
  const own = new Set(entry.own || []);
  const specs = sent.filter(c => c.link && dests.has(c.link) && schema.has(dests.get(c.link).dest))
    .map(c => linkSpec(schema, entry, c, dests.get(c.link))).filter(Boolean);
  const received = new Set([...dests.values()].map(d => d.dest));
  const undo = sent.filter(c => !c.link && own.has(c.id) && decided.has(c.id)).map((c) => {
    const { to, column } = columnFor(schema, entry, c.id);
    return column && /^Ref:/.test(column.type) && received.has(column.type.slice(4)) ? { from: c.id, to } : null;
  }).filter(Boolean);
  return {
    ready: specs.filter(s => s.type === `Ref:${s.target}`),
    todo: specs.filter(s => s.type === 'Text' && own.has(s.from) && !decided.has(s.from)),
    undo,
  };
}

// Actions qui font d'une colonne de texte vide une Référence vers `spec.target`, affichant la
// colonne que la SOURCE affichait (le texte reçu reste dans la description du lot).
export const linkActions = (table, spec) => [
  ['ModifyColumn', table, spec.to, { type: `Ref:${spec.target}` }],
  ['UpdateRecord', '_grist_Tables_column', spec.ref, { visibleCol: spec.shown }],
  ['SetDisplayFormula', table, null, spec.ref, `$${spec.to}.${spec.shownId}`],
];

// Texte seul : le type d'une colonne dont la SOURCE ne garde plus le lien.
export const unlinkActions = (table, specs) => specs.map(spec => ['ModifyColumn', table, spec.to, { type: 'Text' }]);

// Cellules d'une colonne rendue au texte : Grist y a laissé les numéros de ligne (vérifié), et non
// le texte affiché. Chacune reprend le texte de la dernière version reçue de sa ligne (recopiée ou
// non : un renvoi sans changement serait sans effet et laisserait le numéro).
export function textFill({ journalRows, destRows, specs, destTable }) {
  if (!specs.length) return [];
  const latest = latestByKey(journalRows);
  return specs.flatMap((s) => {
    const cells = destRows.map(row => [row.id, latest.get(row[KEY_COL])]).filter(([, v]) => v && Object.hasOwn(v.row, s.from));
    return chunk(cells).map(part => ['BulkUpdateRecord', destTable, part.map(([id]) => id), { [s.to]: part.map(([, v]) => v.row[s.from] ?? '') }]);
  });
}

// Colonnes à décider : `empty` dit si la colonne d'ici n'a aucune valeur. Les vides deviennent des
// Références (`convert`) ; toutes sont notées décidées (`decided`, ids envoyés), pour ne plus
// relire la destination.
export function decideLinks(todo, empty) {
  return { convert: todo.filter(spec => empty(spec.to)), decided: todo.map(spec => spec.from) };
}

// Numéro de la ligne d'ici de chaque clé : Map(clé -> numéro).
export function keyIds(rows) {
  const ids = new Map();
  for (const r of rows) if (!isBlank(r[KEY_COL]) && !ids.has(r[KEY_COL])) ids.set(r[KEY_COL], r.id);
  return ids;
}

// Ce que la recopie sait d'une table d'ici visée par une Référence : numéro de la ligne de chaque clé
// (`keys`, voir keyIds) et numéros de toutes ses lignes (`live`).
export const targetRows = rows => ({ keys: keyIds(rows), live: new Set(rows.map(r => r.id)) });

// Lignes du journal dont les cellules Référence (`specs`) valent le numéro de la ligne d'ici visée
// (0, la valeur vide de Grist, si elle n'est pas là ou si la version ne porte pas la clé).
// `lookups` : table d'ici visée -> targetRows.
export function resolveLinks(rows, specs, lookups) {
  if (!specs.length) return rows;
  return rows.map((row) => {
    const here = specs.filter(s => Object.hasOwn(row, s.from));
    return here.length ? { ...row, ...Object.fromEntries(here.map(s => [s.from, lookups.get(s.target).keys.get(row[linkKey(s.from)]) || 0])) } : row;
  });
}

// Cellules à compléter : la dernière version déjà recopiée d'une ligne cite une ligne visée arrivée
// depuis (`journalRows` non résolues, dans l'état où la recopie les a laissées). La cellule n'est
// complétée que si elle est restée vide, ou si la ligne qu'elle visait n'existe plus (effacée puis
// revenue sous un autre numéro) : une retouche vers une ligne qui existe reste.
export function fillLinks({ journalRows, destRows, specs, lookups, destTable }) {
  if (!specs.length) return [];
  const latest = latestByKey(journalRows);
  const updates = new Map(); // colonne d'ici -> [[ligne, numéro]]
  for (const row of destRows) {
    const version = latest.get(row[KEY_COL]);
    if (!version || !isTrue(version.row[APPLIED_COL]) || isTrue(version.row[DELETE_COL])) continue;
    for (const s of specs) {
      const { keys, live } = lookups.get(s.target);
      const want = keys.get(version.row[linkKey(s.from)]);
      if (want && want !== row[s.to] && (!row[s.to] || !live.has(row[s.to]))) updates.set(s.to, [...(updates.get(s.to) || []), [row.id, want]]);
    }
  }
  return [...updates].flatMap(([to, list]) => chunk(list).map(part => ['BulkUpdateRecord', destTable, part.map(([id]) => id), { [to]: part.map(([, id]) => id) }]));
}
