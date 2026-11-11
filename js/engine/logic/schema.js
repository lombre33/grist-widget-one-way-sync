// Le schéma du document, tel que le moteur le lit : un instantané des tables et colonnes, fait de deux
// listes de lignes (celles des tables internes `_grist_Tables` et `_grist_Tables_column`). Le port rend
// ce que `schemaFrom` produit, par exemple `async () => schemaFrom(await fetchRows('_grist_Tables'),
// await fetchRows('_grist_Tables_column'))`. Les tables de résumé et les tables cachées de Grist ne sont
// pas listées (`tableIds`), mais `has` et `columns` les connaissent.
export function schemaFrom(tables, columns) {
  const byId = new Map(tables.map(tb => [tb.tableId, tb]));
  const colById = new Map(columns.map(c => [c.id, c]));
  return {
    tableIds: tables.filter(tb => !tb.summarySourceTable && !tb.tableId.startsWith('GristHidden')).map(tb => tb.tableId).sort(),
    has: tableId => byId.has(tableId),
    table: tableId => byId.get(tableId),
    // Nom exact d'une table nommée `tableId` aux majuscules près (Grist ne les distingue pas), ou
    // null.
    resolve: tableId => (tables.find(tb => tb.tableId.toLowerCase() === String(tableId).toLowerCase()) || {}).tableId || null,
    // Nom actuel de la table de numéro `ref` (il change si on la renomme), ou null.
    tableIdOf: ref => (tables.find(tb => tb.id === ref) || {}).tableId || null,
    // Colonnes d'une table, dans l'ordre de leur création ; null si la table n'existe pas.
    // `visible` : colonne affichée d'une Référence, dans la table visée.
    columns(tableId) {
      const table = byId.get(tableId);
      if (!table) return null;
      return columns.filter(c => c.parentId === table.id).sort((x, y) => x.parentPos - y.parentPos).map(c => ({
        id: c.id, colId: c.colId, type: c.type, isFormula: c.isFormula, formula: c.formula, label: c.label, description: c.description,
        displayCol: c.displayCol, recalcWhen: c.recalcWhen, recalcDeps: c.recalcDeps, widgetOptions: c.widgetOptions, rules: c.rules,
        visible: (colById.get(c.visibleCol) || {}).colId || '',
      }));
    },
  };
}
