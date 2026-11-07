// Un « Grist » en mémoire pour faire tourner le moteur sans Grist ni navigateur : des tables, leurs
// colonnes et lignes, et les actions que le moteur envoie (AddTable, BulkAddRecord…). Il ne calcule
// aucune formule (sauf `NOW()` et `user.Email` à l'ajout d'une ligne, que le journal utilise) : les
// essais y posent eux-mêmes ce que Grist aurait calculé. `fakePort` en fait un port du moteur
// (engine/port.js) qui n'a rien de commun avec celui de Sync+.
import { schemaFrom } from '../../js/engine/logic/schema.js';

export function fakeDoc({ docId = 'abcdefghijkl', email = 'test@fake.local' } = {}) {
  const tables = new Map(); // tableId -> { id, columns: [{ id, colId, ... }], rows: [{ id, ... }], next }
  let nextTable = 1;
  let nextColumn = 1;
  let clock = 1_700_000_000;
  const log = [];

  const need = (tableId) => {
    const table = tables.get(tableId);
    if (!table) throw new Error(`Table not found "${tableId}"`);
    return table;
  };
  const addColumn = (table, colId, info = {}) => {
    if (table.columns.some(c => c.colId === colId)) throw new Error(`Column already exists "${colId}"`);
    table.columns.push({
      id: nextColumn++, parentId: table.id, parentPos: table.columns.length + 1, colId, type: 'Text', isFormula: false, formula: '', label: colId, description: '',
      displayCol: 0, recalcWhen: 0, recalcDeps: null, widgetOptions: '', visibleCol: 0, ...info,
    });
    for (const row of table.rows) row[colId] = null;
  };
  const addRow = (table, fields, id = null) => {
    const row = { id: id ?? table.next++ };
    for (const c of table.columns) row[c.colId] = null;
    // Ce que Grist calcule à l'ajout d'une ligne : formules de déclenchement (recalcWhen 0).
    for (const c of table.columns) {
      if (c.formula === 'NOW()') row[c.colId] = clock;
      if (c.formula === 'user.Email') row[c.colId] = email;
    }
    Object.assign(row, fields);
    table.rows.push(row);
    return row.id;
  };
  const columnRows = () => [...tables.values()].flatMap(tb => tb.columns);

  const records = {
    _grist_Tables: () => [...tables].map(([tableId, tb]) => ({ id: tb.id, tableId, primaryViewId: 0, summarySourceTable: 0 })),
    _grist_Tables_column: columnRows,
  };

  const run = (action) => {
    const [name, tableId, ...args] = action;
    log.push(action);
    if (tableId === '_grist_Tables_column') {
      const column = columnRows().find(c => c.id === args[0]);
      if (name === 'UpdateRecord' && column) { Object.assign(column, args[1]); return null; }
      throw new Error(`fake : ${name} sur _grist_Tables_column`);
    }
    if (tableId.startsWith('_grist_')) return null; // pages, partages, règles : sans effet ici
    switch (name) {
      case 'AddTable': {
        if (tables.has(tableId)) throw new Error(`Table already exists "${tableId}"`);
        const table = { id: nextTable++, columns: [], rows: [], next: 1 };
        tables.set(tableId, table);
        for (const { id, ...info } of args[0]) addColumn(table, id, info);
        return { table_id: tableId };
      }
      case 'AddColumn': case 'AddVisibleColumn': addColumn(need(tableId), args[0], args[1]); return null;
      case 'ModifyColumn': {
        const column = need(tableId).columns.find(c => c.colId === args[0]);
        if (!column) throw new Error(`Column not found "${args[0]}"`);
        Object.assign(column, args[1]);
        return null;
      }
      case 'RemoveColumn': {
        const table = need(tableId);
        table.columns = table.columns.filter(c => c.colId !== args[0]);
        for (const row of table.rows) delete row[args[0]];
        return null;
      }
      case 'RenameTable': tables.set(args[0], need(tableId)); tables.delete(tableId); return null;
      case 'RemoveTable': need(tableId); tables.delete(tableId); return null;
      case 'AddRecord': return addRow(need(tableId), args[1], args[0]);
      case 'BulkAddRecord': {
        const [rowIds, values] = args;
        return rowIds.map((rowId, i) => addRow(need(tableId), Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]])), rowId));
      }
      case 'UpdateRecord': Object.assign(need(tableId).rows.find(r => r.id === args[0]), args[1]); return null;
      case 'BulkUpdateRecord': {
        const [ids, values] = args;
        ids.forEach((id, i) => Object.assign(need(tableId).rows.find(r => r.id === id), Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]]))));
        return null;
      }
      case 'RemoveRecord': need(tableId).rows = need(tableId).rows.filter(r => r.id !== args[0]); return null;
      case 'BulkRemoveRecord': need(tableId).rows = need(tableId).rows.filter(r => !args[0].includes(r.id)); return null;
      case 'BulkAddOrUpdateRecord': {
        const [require, values, options = {}] = args;
        const table = need(tableId);
        const n = Object.values(require)[0].length;
        for (let i = 0; i < n; i++) {
          const key = Object.fromEntries(Object.entries(require).map(([k, v]) => [k, v[i]]));
          const fields = { ...key, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]])) };
          const found = table.rows.filter(r => Object.entries(key).every(([k, v]) => r[k] === v));
          if (!found.length) addRow(table, fields);
          else for (const row of options.on_many === 'all' ? found : found.slice(0, 1)) Object.assign(row, fields);
        }
        return null;
      }
      default: throw new Error(`fake : action non gérée ${name}`);
    }
  };

  const doc = {
    docId,
    log,
    tables,
    // Une table de la personne, avec ses lignes (ce que Grist aurait déjà là).
    addTable(tableId, columns, rows = []) {
      run(['AddTable', tableId, columns]);
      for (const row of rows) addRow(need(tableId), row);
    },
    addRow: (tableId, fields) => addRow(need(tableId), fields),
    rows: tableId => need(tableId).rows.map(r => ({ ...r })),
    has: tableId => tables.has(tableId),
    tick: (seconds = 1) => { clock += seconds; return clock; },
    now: () => clock,
    fetchRows(tableId) {
      if (records[tableId]) return records[tableId]().map(r => ({ ...r }));
      if (tableId.startsWith('_grist_')) return [];
      return doc.rows(tableId);
    },
    apply(actions) {
      const retValues = actions.map(run);
      return { retValues };
    },
  };
  return doc;
}

// Le port du moteur : les fonctions de Grist parlent à `doc`, la page est toujours visible, le texte
// rend sa clé (donc aucune erreur n'est « prévue » : voir errors.js).
export function fakePort(doc, { owner = true } = {}) {
  const prefs = new Map();
  const unsupported = name => async () => { throw new Error(`fake : ${name} n'est pas gérée`); };
  return {
    fetchRows: async tableId => doc.fetchRows(tableId),
    apply: async actions => (actions.length ? doc.apply(actions) : null),
    readSchema: async () => schemaFrom(doc.fetchRows('_grist_Tables'), doc.fetchRows('_grist_Tables_column')),
    selectRows: async () => null,
    querySql: async () => null,
    docIdentity: async () => ({ origin: 'https://fake.example', team: 'equipe', docId: doc.docId, baseUrl: `https://fake.example/o/equipe/api/docs/${doc.docId}` }),
    isOwner: async () => owner,
    docChanges: async () => null,
    downloadAttachment: unsupported('downloadAttachment'),
    uploadAttachment: unsupported('uploadAttachment'),
    listWebhooks: async () => [],
    createWebhook: unsupported('createWebhook'),
    webhookConditions: async () => new Map(),
    setWebhookEnabled: unsupported('setWebhookEnabled'),
    deleteWebhook: unsupported('deleteWebhook'),
    deleteWebhookWithNotice: unsupported('deleteWebhookWithNotice'),
    clearWebhookQueue: async () => {},
    postToHook: unsupported('postToHook'),
    postRows: unsupported('postRows'),
    publicRecords: unsupported('publicRecords'),
    withLock: (name, fn) => fn(),
    text: (key, values) => (values && Object.keys(values).length ? `${key} ${JSON.stringify(values)}` : key),
    page: { visible: () => true, busy: () => false, onShow: () => {}, onLeave: () => {} },
    prefs: { read: name => prefs.get(name) ?? null, write: (name, value) => { prefs.set(name, value); return true; } },
  };
}
