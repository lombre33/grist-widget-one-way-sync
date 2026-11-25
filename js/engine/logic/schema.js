// Le schéma du document, tel que le moteur le lit : un instantané des tables et colonnes, fait de deux
// listes de lignes (celles des tables internes `_grist_Tables` et `_grist_Tables_column`). Le port rend
// ce que `schemaFrom` produit, par exemple `async () => schemaFrom(await fetchRows('_grist_Tables'),
// await fetchRows('_grist_Tables_column'))`. Les tables de résumé et les tables cachées de Grist ne sont
// pas listées (`tableIds` : les tables où l'on peut écrire, donc les destinations d'une CIBLE, que `everyTableId` complète),
// mais `has` et `columns` les connaissent. `sourceTableIds` : les tables qu'une SOURCE peut envoyer, les tables de résumé
// comprises (voir summary.js : leurs lignes sont celles de Grist, jamais écrites par le widget).
export function schemaFrom(tables, columns) {
  const byId = new Map(tables.map(tb => [tb.tableId, tb]));
  const colById = new Map(columns.map(c => [c.id, c]));
  const hidden = tb => tb.tableId.startsWith('GristHidden');
  return {
    tableIds: tables.filter(tb => !tb.summarySourceTable && !hidden(tb)).map(tb => tb.tableId).sort(),
    sourceTableIds: tables.filter(tb => !hidden(tb)).map(tb => tb.tableId).sort(),
    // Toutes les tables, résumés et tables cachées comprises : une formule les lit par leur nom (le garde-fou des formules reçues).
    everyTableId: tables.map(tb => tb.tableId).sort(),
    has: tableId => byId.has(tableId),
    table: tableId => byId.get(tableId),
    // Nom exact d'une table nommée `tableId` aux majuscules près (Grist ne les distingue pas), ou
    // null.
    resolve: tableId => (tables.find(tb => tb.tableId.toLowerCase() === String(tableId).toLowerCase()) || {}).tableId || null,
    // Nom actuel de la table de numéro `ref` (il change si on la renomme), ou null.
    tableIdOf: ref => (tables.find(tb => tb.id === ref) || {}).tableId || null,
    // Table de résumé : `{ source, by }` (la table résumée, et les colonnes du regroupement dans l'ordre de la table), sinon null.
    summary(tableId) {
      const table = byId.get(tableId);
      if (!table || !table.summarySourceTable) return null;
      const source = tables.find(tb => tb.id === table.summarySourceTable);
      const by = columns.filter(c => c.parentId === table.id && c.summarySourceCol).sort((x, y) => x.parentPos - y.parentPos).map(c => c.colId);
      return { source: source ? source.tableId : null, by };
    },
    // Colonnes d'une table, dans l'ordre de leur création ; null si la table n'existe pas.
    // `visible` : colonne affichée d'une Référence, dans la table visée. `summaryBy` : colonne du regroupement d'une table de résumé ;
    // `summaryGroup` : sa colonne `group`, la liste des lignes de la table résumée, que Grist ajoute (elle ne part pas, voir summary.js).
    columns(tableId) {
      const table = byId.get(tableId);
      if (!table) return null;
      const summary = Boolean(table.summarySourceTable);
      return columns.filter(c => c.parentId === table.id).sort((x, y) => x.parentPos - y.parentPos).map(c => ({
        id: c.id, colId: c.colId, type: c.type, isFormula: c.isFormula, formula: c.formula, label: c.label, description: c.description,
        displayCol: c.displayCol, recalcWhen: c.recalcWhen, recalcDeps: c.recalcDeps, widgetOptions: c.widgetOptions, rules: c.rules,
        visible: (colById.get(c.visibleCol) || {}).colId || '',
        ...(summary ? { summaryBy: Boolean(c.summarySourceCol), summaryGroup: !c.summarySourceCol && c.colId === 'group' && /^RefList:/.test(c.type) } : {}),
      }));
    },
  };
}

// Ce que les plans d'une destination (`entry.dest`) lisent d'abord : ses colonnes d'ici par nom (`here`), la correspondance « colonne
// envoyée → colonne d'ici » (`map`) et les colonnes que le widget y a créées (`own`, voir la note de l'entrée).
export function destContext(schema, entry) {
  return {
    here: new Map((schema.columns(entry.dest) || []).map(c => [c.colId, c])),
    map: entry.map || {},
    own: new Set(Array.isArray(entry.own) ? entry.own : []),
  };
}
