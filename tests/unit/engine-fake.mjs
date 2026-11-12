// Un « Grist » en mémoire pour faire tourner le moteur sans Grist ni navigateur : des tables, leurs
// colonnes et lignes, et les actions que le moteur envoie (AddTable, BulkAddRecord…). Il ne calcule
// aucune formule (sauf `NOW()` et `user.Email` à l'ajout d'une ligne, que le journal utilise) : les
// essais y posent eux-mêmes ce que Grist aurait calculé. `fakePort` en fait un port du moteur
// (engine/port.js) qui n'a rien de commun avec celui de syncPlus.
import { schemaFrom } from '../../js/engine/logic/schema.js';
import { parseWebhookUrl } from '../../js/engine/logic/codes.js';

export function fakeDoc({ docId = 'abcdefghijkl', email = 'test@fake.local', name = 'Document d\'essai', locale = 'en-US', currency = '' } = {}) {
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
      displayCol: 0, recalcWhen: 0, recalcDeps: null, widgetOptions: '', visibleCol: 0, rules: null, ...info,
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
    _grist_Tables: () => [...tables].map(([tableId, tb]) => ({ id: tb.id, tableId, primaryViewId: 0, summarySourceTable: 0, rawViewSectionRef: tb.rawSection || 0 })),
    _grist_Tables_column: columnRows,
  };

  // Les autres tables internes (pages, vues, partages, règles) : de simples listes de lignes, sans effet
  // sur le reste, qu'on lit (`ensureForm` relit sa page) et qu'on complète par les mêmes actions.
  const meta = new Map();
  const metaTable = (id) => {
    if (!meta.has(id)) meta.set(id, { rows: [], next: 1 });
    return meta.get(id);
  };
  // Les réglages du document (langue, monnaie), comme `_grist_DocInfo` les range.
  metaTable('_grist_DocInfo').rows.push({ id: 1, documentSettings: JSON.stringify({ locale, ...(currency ? { currency } : {}), engine: 'python3' }) });
  metaTable('_grist_DocInfo').next = 2;
  const runMeta = (name, tableId, args) => {
    const table = metaTable(tableId);
    const find = id => table.rows.find(r => r.id === id);
    switch (name) {
      case 'AddRecord': { const row = { id: args[0] ?? table.next++, ...args[1] }; table.rows.push(row); return row.id; }
      case 'UpdateRecord': if (find(args[0])) Object.assign(find(args[0]), args[1]); return null;
      case 'RemoveRecord': table.rows = table.rows.filter(r => r.id !== args[0]); return null;
      case 'BulkRemoveRecord': table.rows = table.rows.filter(r => !args[0].includes(r.id)); return null;
      case 'BulkUpdateRecord':
        args[0].forEach((id, i) => { if (find(id)) Object.assign(find(id), Object.fromEntries(Object.entries(args[1]).map(([k, v]) => [k, v[i]]))); });
        return null;
      case 'BulkAddRecord':
        return args[0].map((id, i) => { const row = { id: id ?? table.next++, ...Object.fromEntries(Object.entries(args[1]).map(([k, v]) => [k, v[i]])) }; table.rows.push(row); return row.id; });
      default: return null;
    }
  };
  // Un formulaire sur une table : sa vue, sa section et sa page (ce que Grist crée, comme `ensureForm` le lit).
  const createFormSection = (tableRef) => {
    const view = runMeta('AddRecord', '_grist_Views', [null, { name: 'New page' }]);
    const section = runMeta('AddRecord', '_grist_Views_section', [null, { parentId: view, parentKey: 'form', tableRef, shareOptions: '' }]);
    runMeta('AddRecord', '_grist_Pages', [null, { viewRef: view, shareRef: 0, indentation: 0, pagePos: view }]);
    return { viewRef: view, sectionRef: section };
  };

  // Une section « Personnalisée » sur une page existante (`viewRef`) : ses options sont écrites ensuite, comme Grist les range.
  const createCustomSection = (tableRef, viewRef) => {
    const section = runMeta('AddRecord', '_grist_Views_section', [null, { parentId: viewRef, parentKey: 'custom', tableRef, options: '' }]);
    return { tableRef, viewRef, sectionRef: section };
  };

  const run = (action) => {
    const [name, tableId, ...args] = action;
    log.push(action);
    if (name === 'CreateViewSection') return args[1] === 'custom' && args[0] ? createCustomSection(tableId, args[0]) : createFormSection(tableId);
    if (tableId === '_grist_Tables_column') {
      const column = columnRows().find(c => c.id === args[0]);
      if (name === 'UpdateRecord' && column) { Object.assign(column, args[1]); return null; }
      throw new Error(`fake : ${name} sur _grist_Tables_column`);
    }
    if (tableId.startsWith('_grist_')) return runMeta(name, tableId, args);
    switch (name) {
      case 'AddTable': {
        if (tables.has(tableId)) throw new Error(`Table already exists "${tableId}"`);
        const table = { id: nextTable++, columns: [], rows: [], next: 1 };
        tables.set(tableId, table);
        // Comme Grist, la table a une section de données brutes ; sa description est celle de la table.
        table.rawSection = runMeta('AddRecord', '_grist_Views_section', [null, { tableRef: table.id, parentKey: 'record', description: '' }]);
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
        const gone = table.columns.find(c => c.colId === args[0]);
        table.columns = table.columns.filter(c => c.colId !== args[0]);
        // Une colonne cachée de règle qui part sort aussi de la liste des règles de sa colonne (RefList).
        for (const c of table.columns) {
          if (gone && c.rules && c.rules.includes(gone.id)) {
            const left = c.rules.slice(1).filter(r => r !== gone.id);
            c.rules = left.length ? ['L', ...left] : null;
          }
        }
        for (const row of table.rows) delete row[args[0]];
        return null;
      }
      // Règle de mise en forme conditionnelle d'une colonne (au niveau de la colonne) : sa colonne cachée, sans formule.
      case 'AddEmptyRule': {
        const table = need(tableId);
        const column = table.columns.find(c => c.id === args[1]);
        if (!column) throw new Error(`Column not found "${args[1]}"`);
        let colId = 'gristHelper_ConditionalRule';
        for (let n = 2; table.columns.some(c => c.colId === colId); n++) colId = `gristHelper_ConditionalRule${n}`;
        addColumn(table, colId, { type: 'Any', isFormula: true });
        const helper = table.columns.find(c => c.colId === colId);
        column.rules = column.rules ? [...column.rules, helper.id] : ['L', helper.id];
        return { colRef: helper.id, colId };
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
    name,
    email,
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
      if (tableId.startsWith('_grist_')) return metaTable(tableId).rows.map(r => ({ ...r }));
      return doc.rows(tableId);
    },
    apply(actions) {
      const retValues = actions.map(run);
      return { retValues };
    },
  };
  return doc;
}

const ORIGIN = 'https://fake.example';
const TEAM = '/o/equipe';

// Le port du moteur : les fonctions de Grist parlent à `doc`, la page est toujours visible, le texte
// rend sa clé (donc aucune erreur n'est « prévue » : voir errors.js). Sans `world`, rien n'est joignable
// hors du document (webhooks et formulaires publiés) ; avec, voir fakeWorld.
export function fakePort(doc, { owner = true, world = null } = {}) {
  const prefs = new Map();
  const unsupported = name => async () => { throw new Error(`fake : ${name} n'est pas gérée`); };
  const abroad = world ? world.hooksOf(doc) : null;
  return {
    fetchRows: async tableId => doc.fetchRows(tableId),
    apply: async actions => (actions.length ? doc.apply(actions) : null),
    readSchema: async () => schemaFrom(doc.fetchRows('_grist_Tables'), doc.fetchRows('_grist_Tables_column')),
    selectRows: async () => null,
    querySql: async () => null,
    journalStats: async () => null,
    docIdentity: async () => ({ origin: ORIGIN, team: 'equipe', docId: doc.docId, baseUrl: `${ORIGIN}${TEAM}/api/docs/${doc.docId}` }),
    isOwner: async () => owner,
    docChanges: async () => null,
    downloadAttachment: unsupported('downloadAttachment'),
    uploadAttachment: unsupported('uploadAttachment'),
    listWebhooks: async () => (abroad ? abroad.list() : []),
    createWebhook: abroad ? async fields => abroad.create(fields) : unsupported('createWebhook'),
    webhookConditions: async () => (abroad ? abroad.conditions() : new Map()),
    setWebhookEnabled: abroad ? async (id, enabled) => abroad.patch(id, { enabled }) : unsupported('setWebhookEnabled'),
    renameWebhook: abroad ? async (id, name, memo) => abroad.patch(id, memo === undefined ? { name } : { name, memo }) : async () => {},
    deleteWebhook: abroad ? async id => abroad.remove(id) : unsupported('deleteWebhook'),
    deleteWebhookWithNotice: unsupported('deleteWebhookWithNotice'),
    clearWebhookQueue: async () => {},
    postToHook: unsupported('postToHook'),
    postRows: world ? async (url, rows) => world.postRows(url, rows) : unsupported('postRows'),
    publicRecords: unsupported('publicRecords'),
    publicAccess: async () => '',
    shareInfo: world ? async url => world.shareInfo(url) : async () => null,
    withLock: (name, fn) => fn(),
    text: (key, values) => (values && Object.keys(values).length ? `${key} ${JSON.stringify(values)}` : key),
    page: { visible: () => true, busy: () => false, onShow: () => {}, onLeave: () => {} },
    prefs: { read: name => prefs.get(name) ?? null, write: (name, value) => { prefs.set(name, value); return true; } },
  };
}

// Une SOURCE (table Contacts d'une ligne) et une CIBLE neuves sur le même monde. `tag` (deux caractères) range les
// identifiants de document d'un fichier d'essai : deux essais ne partagent jamais le même (`n` : le rang de la paire).
let pairs = 0;
export function fakePair(tag) {
  const world = fakeWorld();
  const n = String(++pairs).padStart(2, '0');
  const source = fakeDoc({ docId: `sourcedoc${tag}${n}x`, name: 'Annuaire', email: 'source@fake.local' });
  const target = fakeDoc({ docId: `targetdoc${tag}${n}x`, name: 'Réception', email: 'cible@fake.local' });
  source.addTable('Contacts', [{ id: 'Nom', type: 'Text' }], [{ Nom: 'Alice' }]);
  return { world, source, target, n };
}

// Plusieurs documents sur la même instance : de quoi jouer une SOURCE puis une CIBLE. La personne
// « publie » le formulaire d'un journal et en copie le lien (`formLink`) ; l'écriture par ce lien
// (`postRows`) n'arrive que dans ce journal, comme chez Grist, et une colonne inconnue est refusée. Les
// webhooks de chaque document sont gardés (`hooksOf`), mais rien ne les envoie : le test dépose lui-même,
// dans le journal de la CIBLE, ce que le webhook y aurait posé (`deliver`).
export function fakeWorld() {
  const forms = new Map(); // clé de partage -> { doc, journal }
  const hooks = new Map(); // document -> [{ id, fields }]
  let counter = 0;
  const world = {
    port: (doc, options = {}) => fakePort(doc, { ...options, world }),
    formLink(doc, journal) {
      const key = `Form${String(++counter).padStart(3, '0')}abcdefghijklmn`;
      forms.set(key, { doc, journal });
      return `${ORIGIN}${TEAM}/forms/${key}/1`;
    },
    shareInfo(url) {
      const target = parseWebhookUrl(url);
      const form = target && target.origin === ORIGIN ? forms.get(target.key) : null;
      return form ? { docId: form.doc.docId, name: form.doc.name, folder: 'Dossier', team: 'equipe', teamName: 'Équipe', personal: false } : null;
    },
    postRows(url, rows) {
      const target = parseWebhookUrl(url);
      if (!target || target.origin !== ORIGIN) throw new Error('otherInstance');
      const form = forms.get(target.key);
      if (!form) throw new Error('HTTP 404 Share not known');
      if (form.journal !== target.table) throw new Error('HTTP 403 Blocked by table update access rules');
      const columns = form.doc.tables.get(form.journal).columns.map(c => c.colId);
      for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) throw new Error(`HTTP 400 Invalid column "${key}"`);
      for (const row of rows) form.doc.addRow(form.journal, row);
    },
    // Ce que le webhook de `fromDoc` a posé : les lignes `rows` ajoutées au journal que désigne son adresse.
    deliver(url, rows) { world.postRows(url, rows); },
    hooksOf(doc) {
      if (!hooks.has(doc)) hooks.set(doc, []);
      const list = hooks.get(doc);
      return {
        list: () => list.map(h => ({ id: h.id, fields: { ...h.fields }, usage: null })),
        create: ({ name, memo, url, tableId, condition }) => {
          const id = ++counter;
          list.push({ id, fields: { name, memo, url, tableId, condition, enabled: true } });
          return id;
        },
        conditions: () => new Map(list.map(h => [h.id, h.fields.condition])),
        patch: (id, fields) => Object.assign(list.find(h => h.id === id).fields, fields),
        remove: (id) => { const at = list.findIndex(h => h.id === id); if (at >= 0) list.splice(at, 1); },
      };
    },
    webhooks: doc => world.hooksOf(doc).list(),
  };
  return world;
}
