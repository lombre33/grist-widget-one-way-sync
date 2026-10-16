// Règles d'accès posées par le widget, toutes reconnues à leur mémo : le widget ne touche jamais aux
// autres. Elles passent avant les règles existantes, dans l'ordre où elles sont listées ici (la
// lecture du lien public avant la réserve aux propriétaires, sur la même table).
//  - Lien public : les lecteurs (dont le lien public) ne lisent que les lignes 'complet' et
//    'empreinte' des exports publics dans Synchro, sans la colonne Synchro_Export (sa description
//    est la note de la SOURCE : noms des exports, invitations en attente ; vérifié). Le filtre sur
//    cette colonne marche encore (vérifié). Sans export public, `keepDeny` garde le refus général
//    tant que le document reste partagé publiquement.
//  - Synchro réservée aux propriétaires : ses formules lisent les tables sans les règles d'accès,
//    ses lots et ses listes montreraient à un lecteur ce que d'autres règles lui cachent, et un
//    éditeur y choisirait ce qui sort. Exception : la recopie d'un Échange par un éditeur lit les
//    lignes 'echange' et 'lot' (sans leur lot ni leurs listes) et écrit leur Synchro_Renvoi.
//  - Journaux réservés aux éditeurs : un journal garde les versions reçues et ce qu'elles ont
//    remplacé, quelles que soient les règles des tables de destination. La clé du formulaire y
//    écrit toujours (vérifié).
import { EXPORT_COL, HEX16, KIND, LIST_COL, LOT_COL, AUTHOR_COL, MISSING_COL, RESEND_COL, SYNC_TABLE, TYPE_COL } from './common.js';

export const PUBLIC_MEMO = 'Synchro : lecture limitée aux exports publics';
export const OWNER_MEMO = 'Synchro : réservée aux propriétaires';
export const JOURNAL_MEMO = 'Synchro : journaux réservés aux éditeurs';
const LEGACY_MEMO = 'Synchro : lecture limitée aux vues d’export';
const MEMOS = [PUBLIC_MEMO, OWNER_MEMO, JOURNAL_MEMO, LEGACY_MEMO];

export const isWidgetRule = r => MEMOS.includes(r.memo);
export const isPublicRule = r => r.memo === PUBLIC_MEMO || r.memo === LEGACY_MEMO;

const VIEWER = 'user.Access == VIEWER';
const EDITOR = 'user.Access == EDITOR';
const EXCHANGE_ROWS = `${EDITOR} and rec.${TYPE_COL} in ["${KIND.swap}", "${KIND.lot}"]`;

// Règles voulues : [{ tableId, colIds, aclFormula, permissionsText, memo }], dans l'ordre.
export function publicAclRules(exportIds, { keepDeny = false } = {}) {
  const ids = exportIds.filter(id => HEX16.test(id)).sort();
  if (!ids.length && !keepDeny) return [];
  const rule = (tableId, colIds, aclFormula, permissionsText) => ({ tableId, colIds, aclFormula, permissionsText, memo: PUBLIC_MEMO });
  return [
    ...(ids.length ? [
      rule(SYNC_TABLE, EXPORT_COL, VIEWER, '-R'),
      rule(SYNC_TABLE, '*', `${VIEWER} and rec.${EXPORT_COL} in [${ids.map(id => `"${id}"`).join(', ')}] and rec.${TYPE_COL} in ["${KIND.full}", "${KIND.mark}"]`, '+R'),
    ] : []),
    rule('*', '*', VIEWER, '-R'),
  ];
}

export function ownerAclRules() {
  const rule = (colIds, aclFormula, permissionsText) => ({ tableId: SYNC_TABLE, colIds, aclFormula, permissionsText, memo: OWNER_MEMO });
  return [
    rule(EXPORT_COL, VIEWER, '-R'),
    rule([LOT_COL, LIST_COL, MISSING_COL, AUTHOR_COL].join(','), EDITOR, '-RU'),
    rule(RESEND_COL, EXCHANGE_ROWS, '+RU'),
    rule('*', EXCHANGE_ROWS, '+R'),
    rule('*', 'user.Access != OWNER', '-CRUD'),
  ];
}

export const journalAclRules = journals => [...journals].sort()
  .map(tableId => ({ tableId, colIds: '*', aclFormula: VIEWER, permissionsText: '-R', memo: JOURNAL_MEMO }));

// Une règle, telle que la compare syncRules (sa ressource lue dans `resources` si besoin).
export const ruleText = ({ tableId, colIds, aclFormula, permissionsText, memo }) => `${tableId}|${colIds}|${aclFormula}|${permissionsText}|${memo || ''}`;
export const currentRules = (resources, rules) => rules.filter(isWidgetRule).sort((a, b) => (a.rulePos || 0) - (b.rulePos || 0))
  .map(r => ({ ...(resources.find(x => x.id === r.resource) || {}), ...r }));

// Actions qui remplacent les règles du widget par `wanted`, dans cet ordre, avant toutes les autres.
// `resources`, `rules` : lignes de _grist_ACLResources et _grist_ACLRules. Rien si elles sont déjà
// là, dans le même ordre (changer une règle fait recharger le document). Les ressources d'une table
// effacée (`missing`) dont plus aucune règle ne se sert partent aussi : Grist refuse tout changement
// de règle tant qu'une ressource nomme une table absente (vérifié). Les règles partent en un seul
// BulkAddRecord : Grist range chaque ajout avant la première position plus grande que la sienne, et
// ses positions sont positives, donc des AddRecord successifs à positions négatives s'inversaient
// (vérifié : le document se rechargeait à chaque affichage).
export function aclActions(resources, rules, wanted, missing = () => false) {
  if (currentRules(resources, rules).map(ruleText).join('\n') === wanted.map(ruleText).join('\n')) return [];
  const mine = rules.filter(isWidgetRule);
  const others = new Set(rules.filter(r => !isWidgetRule(r)).map(r => r.resource));
  const free = resources.filter(r => r.tableId !== '*' && missing(r.tableId) && !others.has(r.id)).map(r => r.id);
  const actions = [['BulkRemoveRecord', '_grist_ACLRules', mine.map(r => r.id)], ['BulkRemoveRecord', '_grist_ACLResources', free]].filter(a => a[2].length);
  const kept = resources.filter(r => !free.includes(r.id));
  let pos = Math.min(0, ...rules.filter(r => !isWidgetRule(r)).map(r => r.rulePos || 0)) - wanted.length - 1;
  let newRef = 0;
  const added = [];
  const resourceFor = (tableId, colIds) => {
    const found = kept.find(r => r.tableId === tableId && r.colIds === colIds) || added.find(r => r.tableId === tableId && r.colIds === colIds);
    if (found) return found.id;
    added.push({ id: --newRef, tableId, colIds });
    actions.push(['AddRecord', '_grist_ACLResources', newRef, { tableId, colIds }]);
    return newRef;
  };
  const resource = wanted.map(w => resourceFor(w.tableId, w.colIds));
  if (wanted.length) {
    actions.push(['BulkAddRecord', '_grist_ACLRules', wanted.map(() => null), {
      resource, aclFormula: wanted.map(w => w.aclFormula), permissionsText: wanted.map(w => w.permissionsText),
      rulePos: wanted.map(() => ++pos), memo: wanted.map(w => w.memo),
    }]);
  }
  return actions;
}

// Lien public : tables de `tables` dont une règle d'accès (hors règles du widget) cache des lignes ou
// des colonnes, à quelqu'un ou à tous. Les formules de Synchro lisent sans les règles : le lien
// public montrerait à tous ce qu'elles cachent.
const deniesRead = p => p === 'none' || /-[A-Z]*R/.test(p || '');
export function hiddenTables(resources, rules, tables) {
  const tableOf = id => (resources.find(r => r.id === id) || {}).tableId;
  return tables.filter(table => rules.some(r => !isWidgetRule(r) && tableOf(r.resource) === table && deniesRead(r.permissionsText)));
}
