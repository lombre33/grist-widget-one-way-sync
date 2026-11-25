// SOURCE : les tables de résumé de Grist (« Résumer » une table par une ou plusieurs colonnes : une ligne par groupe, avec le nombre de
// lignes et des sommes). Elles partent comme une table ordinaire, mais Grist y refuse toute colonne de données (« cannot add a non-formula
// column to a summary table », vérifié dans Grist 1.7.22) : ni la clé `id_sync` (un UUID posé à la création de la ligne), ni `MajLe`
// (une formule de déclenchement) ne peuvent y vivre. Ce fichier les remplace par deux colonnes de FORMULE, que les formules de Synchro
// lisent comme celles des autres tables (`getattr(r, "id_sync")`, `r.MajLe`) : leur texte, et donc la liste des formules de Synchro,
// n'a pas à changer.
// - Clé : une empreinte des valeurs du regroupement. Elle suit ce qui fait l'identité d'une ligne de résumé : un groupe qui disparaît
//   puis revient reprend sa clé, et les numéros de ligne, que Grist renumérote, ne comptent pas. Renommer une valeur du regroupement
//   change de groupe : l'ancienne clé s'efface chez le destinataire, la nouvelle s'ajoute.
// - MajLe : l'heure du dernier recalcul de la ligne. La formule LIT les colonnes envoyées (et la clé), et Grist la recalcule quand l'une
//   d'elles change : seule la ligne du groupe touché repart (vérifié : une colonne non envoyée, ou un autre groupe, ne bouge rien).
//   Différence avec une table ordinaire : Grist recalcule aussi toutes les formules au chargement du document, donc chaque ligne repart
//   une fois à chaque chargement (sans effet chez le destinataire si rien n'a changé, voir sameValue).
// Une table de résumé ne s'écrit pas : pas d'Échange (voir `summaryTables`), pas de remplissage des clés ni de réparation par écriture.
import { KEY_COL, ORDER_COL, RECALC_COL } from './common.js';
import { RECALC_SPEC } from './formulas.js';

// Clé : SHA-1 des valeurs du regroupement (`by` : ses colonnes, dans l'ordre de la table). `repr` d'une Référence rend la table et le
// numéro de la ligne visée, que Grist garde quand on renomme la ligne.
export function summaryKeyFormula(by) {
  const values = by.map(id => `rec.${id}`).join(', ');
  return `import hashlib\nreturn hashlib.sha1(repr([${values}]).encode("utf-8")).hexdigest()`;
}

// MajLe : lit la clé et chaque colonne envoyée (`sent` : leurs identifiants ; `cols` : les colonnes de la table, pour le texte qu'une
// Référence affiche), chacune à l'abri d'une erreur (une colonne effacée ou en erreur ne doit pas mettre la ligne en erreur : elle ne
// partirait plus), puis rend l'heure. Un identifiant trié : le même texte pour le même choix (voir summaryActions).
export function summaryMajleFormula(cols, sent) {
  const byId = new Map(cols.map(c => [c.colId, c]));
  const reads = [KEY_COL, ...[...new Set(sent)].filter(id => byId.has(id) && ![KEY_COL, ORDER_COL, RECALC_COL].includes(id)).sort()]
    .map(id => `("${id}", "${(byId.get(id) || {}).visible || ''}")`);
  return [
    `for name, shown in [${reads.join(', ')}]:`,
    '  try:',
    '    x = getattr(rec, name)',
    '    if shown: getattr(x, shown)',
    '  except Exception:',
    '    pass',
    'import time, datetime',
    'return datetime.datetime.fromtimestamp(time.time(), datetime.timezone.utc)',
  ].join('\n');
}

// Les colonnes de la synchro d'une table de résumé, comme elles doivent être : { colId: spécification }.
const specs = (cols, by, sent) => ({
  [KEY_COL]: { type: 'Text', isFormula: true, formula: summaryKeyFormula(by) },
  [ORDER_COL]: { type: 'DateTime:UTC', isFormula: true, formula: summaryMajleFormula(cols, sent) },
  [RECALC_COL]: RECALC_SPEC,
});

// Ce qu'il faut écrire pour que la table de résumé `table` ait ses trois colonnes. `by` : les colonnes de son regroupement ; `sent` : celles
// que ses exports envoient. La clé et RecalculLe sont toujours remises d'accord (la clé d'une table dont le regroupement a changé, que
// Grist recopie avec l'ancienne formule, ferait des doublons) ; MajLe n'est réécrite que si `refresh` (à l'affichage de l'onglet, voir
// refreshMajLe : réécrire sa formule renvoie toute la table) ; sinon elle n'est posée que si elle manque.
export function summaryActions(table, cols, by, sent, { refresh = false } = {}) {
  const wanted = specs(cols, by, sent);
  return [KEY_COL, ORDER_COL, RECALC_COL].flatMap((id) => {
    const here = cols.find(c => c.colId === id);
    if (!here) return [['AddColumn', table, id, wanted[id]]];
    if (id === ORDER_COL && !refresh) return [];
    const same = here.isFormula && here.type === wanted[id].type && here.formula === wanted[id].formula;
    return same ? [] : [['ModifyColumn', table, id, wanted[id]]];
  });
}

// Les tables de résumé parmi `tables` (leurs noms), d'après le schéma.
export const summaryTables = (schema, tables) => tables.filter(table => schema.summary?.(table));
