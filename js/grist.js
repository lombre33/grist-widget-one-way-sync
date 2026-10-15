// Accès au document courant, avec les droits de la personne qui a ouvert la page.
// Deux canaux seulement :
//  - l'API des widgets (`grist.docApi`) : lecture des tables, écritures groupées ;
//  - l'API REST de la même instance pour les webhooks, que l'API des widgets n'expose pas,
//    avec un jeton d'accès court (`getAccessToken`) passé en paramètre `auth=`.
import { parseDocBaseUrl, randomHex, toRows } from './core.js';

export const fetchRows = async tableId => toRows(await grist.docApi.fetchTable(tableId));

export const apply = actions => (actions.length ? grist.docApi.applyUserActions(actions) : null);

// Instantané des métadonnées du document (tables et colonnes), lu en deux requêtes, et relu après
// une écriture qui change le schéma. Les tables de résumé et les tables cachées de Grist ne sont
// pas listées, mais `has` et `columns` les connaissent.
export async function readSchema() {
  const [tables, columns] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Tables_column')]);
  const byId = new Map(tables.map(tb => [tb.tableId, tb]));
  const colById = new Map(columns.map(c => [c.id, c]));
  return {
    tableIds: tables.filter(tb => !tb.summarySourceTable && !tb.tableId.startsWith('GristHidden')).map(tb => tb.tableId).sort(),
    has: tableId => byId.has(tableId),
    table: tableId => byId.get(tableId),
    // Nom actuel de la table de numéro `ref` (il change si on la renomme), ou null.
    tableIdOf: ref => (tables.find(tb => tb.id === ref) || {}).tableId || null,
    // Colonnes d'une table, dans l'ordre de leur création ; null si la table n'existe pas.
    // `visible` : colonne affichée d'une Référence, dans la table visée.
    columns(tableId) {
      const table = byId.get(tableId);
      if (!table) return null;
      return columns.filter(c => c.parentId === table.id).sort((x, y) => x.parentPos - y.parentPos).map(c => ({
        id: c.id, colId: c.colId, type: c.type, isFormula: c.isFormula, formula: c.formula, label: c.label, description: c.description,
        displayCol: c.displayCol, recalcWhen: c.recalcWhen, recalcDeps: c.recalcDeps,
        visible: (colById.get(c.visibleCol) || {}).colId || '',
      }));
    },
  };
}

// Identité du document, déduite de l'adresse REST du jeton : instance, équipe, identifiant, et
// l'adresse elle-même (`baseUrl`).
export async function docIdentity() {
  const { baseUrl } = await grist.docApi.getAccessToken({ readOnly: true });
  return { ...parseDocBaseUrl(baseUrl), baseUrl };
}

// Nom du document et niveau d'accès de la personne (`owners`, `editors` ou `viewers`), lus par
// l'API REST avec un jeton en lecture seule. Vide si Grist ne répond pas : rien n'en dépend.
export async function docInfo() {
  try {
    const { token, baseUrl } = await grist.docApi.getAccessToken({ readOnly: true });
    const response = await fetch(`${baseUrl}?auth=${encodeURIComponent(token)}`);
    const info = response.ok ? await response.json() : {};
    return { name: String(info.name || ''), access: String(info.access || '') };
  } catch (e) {
    return { name: '', access: '' };
  }
}

// Une seule exécution à la fois de `fn` sous ce nom, tous onglets du navigateur confondus.
export const withLock = (name, fn) => (navigator.locks ? navigator.locks.request(name, fn) : fn());

// ---------------------------------------------------------------------------------------------
// Webhooks (propriétaires du document seulement : Grist refuse sinon en 403)

async function rest(method, path, body) {
  const { token, baseUrl } = await grist.docApi.getAccessToken({ readOnly: false });
  const response = await fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}auth=${encodeURIComponent(token)}`, {
    method,
    // Grist exige l'un de ces en-têtes pour toute écriture sans cookie (protection CSRF).
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(response.status === 403 ? 'ownerOnly' : `HTTP ${response.status} ${text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

export const listWebhooks = async () => (await rest('GET', '/webhooks')).webhooks;

// Un webhook par destinataire, sur la table Synchro, filtré par `condition` (formule évaluée par
// Grist sur chaque ligne : seules celles de l'export partent). Grist accepte les conditions depuis
// la version 1.7.11 : une instance plus ancienne refuse le champ, ou l'ignore ; le widget vérifie
// donc la condition enregistrée et efface le webhook si elle manque (il recevrait tout).
export async function createWebhook({ name, memo, url, tableId, condition }) {
  let result;
  try {
    result = await rest('POST', '/webhooks', {
      webhooks: [{ fields: { name, memo, url, tableId, condition, eventTypes: ['add', 'update'], enabled: true, isReadyColumn: null } }],
    });
  } catch (e) {
    if (/condition/i.test(e.message)) throw new Error('gristTooOld');
    throw e;
  }
  const id = result.webhooks[0].id;
  if ((await webhookConditions()).get(id) !== condition) {
    await deleteWebhook(id).catch(() => {});
    throw new Error('gristTooOld');
  }
  return id;
}

// Condition de chaque webhook du document (texte de la formule), par identifiant de webhook :
// lue dans _grist_Triggers, où Grist garde aussi l'identifiant de chaque webhook.
export async function webhookConditions() {
  const conditions = new Map();
  for (const trigger of await fetchRows('_grist_Triggers')) {
    let text = '';
    try { text = (JSON.parse(trigger.condition || '{}') || {}).text || ''; } catch (e) { /* condition illisible */ }
    let actions = [];
    try { actions = JSON.parse(trigger.actions || '[]') || []; } catch (e) { /* actions illisibles */ }
    for (const action of actions) if (action && action.type === 'webhook') conditions.set(action.id, text);
  }
  return conditions;
}

export const setWebhookEnabled = (id, enabled) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, { enabled });
export const renameWebhook = (id, name) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, { name });
export const deleteWebhook = id => rest('DELETE', `/webhooks/${encodeURIComponent(id)}`);
export const clearWebhookQueue = () => rest('DELETE', '/webhooks/queue');

// ---------------------------------------------------------------------------------------------
// Formulaire de réception (CIBLE) : mêmes trois actions que le bouton « Publier » de Grist. Le
// serveur crée alors la clé de partage, que le widget ne peut pas lire : la personne copie le
// lien depuis la carte du formulaire.

// Idempotent, et repris là où il s'est arrêté : ajouter une section à la page du widget fait
// recréer son cadre par Grist, ce qui interrompt le script. Le widget rappelle donc cette
// fonction à chaque affichage tant que le journal de l'export attend son lien.
export async function ensureForm(tableId) {
  const table = (await readSchema()).table(tableId);
  const sections = await fetchRows('_grist_Views_section');
  let section = sections.find(s => s.parentKey === 'form' && s.tableRef === table.id);
  if (!section) {
    const created = (await apply([['CreateViewSection', table.id, widgetViewRef(sections), 'form', null, null]])).retValues[0];
    section = { id: created.sectionRef, parentId: created.viewRef, shareOptions: '' };
  }
  const page = (await fetchRows('_grist_Pages')).find(p => p.viewRef === section.parentId);
  if (!page.shareRef) {
    const shareRef = (await apply([['AddRecord', '_grist_Shares', null, { linkId: randomHex(12), options: JSON.stringify({ publish: true }) }]])).retValues[0];
    await apply([['UpdateRecord', '_grist_Pages', page.id, { shareRef }]]);
  }
  if (!JSON.parse(section.shareOptions || '{}').publish) {
    await apply([['UpdateRecord', '_grist_Views_section', section.id, { shareOptions: JSON.stringify({ form: true, publish: true }) }]]);
  }
}

// Couper le lien du formulaire de cette table : le partage de sa page change d'identifiant, et
// Grist remplace alors sa clé (il efface celle d'un identifiant disparu, vérifié dans
// HomeDBManager.syncShares). La clé est celle de la page : tous ses formulaires en changent.
export async function renewFormLink(tableId) {
  await ensureForm(tableId);
  const table = (await readSchema()).table(tableId);
  const section = (await fetchRows('_grist_Views_section')).find(s => s.parentKey === 'form' && s.tableRef === table.id);
  const page = (await fetchRows('_grist_Pages')).find(p => p.viewRef === section.parentId);
  await apply([['UpdateRecord', '_grist_Shares', page.shareRef, { linkId: randomHex(12) }]]);
}

// Page de chaque formulaire publié, par table : { samePage, name }, pour dire où cliquer.
export async function formPages() {
  const [sections, tables, views] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Tables'), fetchRows('_grist_Views')]);
  const mine = widgetViewRef(sections);
  const pages = new Map();
  for (const section of sections) {
    if (section.parentKey !== 'form' || !JSON.parse(section.shareOptions || '{}').publish) continue;
    const table = tables.find(tb => tb.id === section.tableRef);
    const view = views.find(v => v.id === section.parentId);
    if (table) pages.set(table.tableId, { samePage: section.parentId === mine, name: view ? view.name : '' });
  }
  return pages;
}

// Replie dans la barre de la page du widget les formulaires de ces tables, une fois leur lien
// donné : la page ne montre plus que le widget. Ils restent publiés, un clic les rouvre.
export async function collapseForms(tableIds) {
  const [tables, sections, views] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section'), fetchRows('_grist_Views')]);
  const viewRef = widgetViewRef(sections);
  if (!viewRef) return;
  const refs = new Set(tables.filter(tb => tableIds.includes(tb.tableId)).map(tb => tb.id));
  const forms = new Set(sections.filter(s => s.parentId === viewRef && s.parentKey === 'form' && refs.has(s.tableRef)).map(s => s.id));
  const view = views.find(v => v.id === viewRef);
  // Sans disposition enregistrée, Grist empile les sections de la page : on part de là.
  const layout = JSON.parse(view.layoutSpec || '{}');
  if (!layout.children) layout.children = sections.filter(s => s.parentId === viewRef).map(s => ({ leaf: s.id }));
  const collapsed = layout.collapsed || [];
  if ([...forms].every(id => collapsed.some(c => c.leaf === id))) return;
  const keep = box => {
    if (box.leaf !== undefined) return forms.has(box.leaf) ? null : box;
    const children = (box.children || []).map(keep).filter(Boolean);
    return children.length ? { ...box, children } : null;
  };
  const root = keep(layout) || { children: [] };
  root.collapsed = [...collapsed, ...[...forms].filter(id => !collapsed.some(c => c.leaf === id)).map(leaf => ({ leaf }))];
  await apply([['UpdateRecord', '_grist_Views', viewRef, { layoutSpec: JSON.stringify(root) }]]);
}

// Après l'effacement de tables : leurs sections (dont les formulaires) disparaissent, mais pas
// leurs cases dans la disposition de la page, ni dans la barre des repliés (vérifié : les numéros
// de sections sont ensuite réutilisés). On les retire, et une page qui n'a plus de formulaire
// publié perd son partage : la clé d'écriture disparaît avec lui.
export async function tidyPages(viewRefs) {
  const [sections, views, pages] = await Promise.all([fetchRows('_grist_Views_section'), fetchRows('_grist_Views'), fetchRows('_grist_Pages')]);
  const actions = [];
  for (const viewRef of viewRefs) {
    const view = views.find(v => v.id === viewRef);
    if (!view) continue;
    const here = sections.filter(s => s.parentId === viewRef);
    const ids = new Set(here.map(s => s.id));
    if (view.layoutSpec) {
      const layout = JSON.parse(view.layoutSpec);
      const keep = box => {
        if (box.leaf !== undefined) return ids.has(box.leaf) ? box : null;
        return { ...box, children: (box.children || []).map(keep).filter(Boolean) };
      };
      const { collapsed = [], ...tree } = layout;
      const tidy = { ...keep(tree), collapsed: collapsed.filter(c => ids.has(c.leaf)) };
      if (!tidy.collapsed.length) delete tidy.collapsed;
      if (JSON.stringify(tidy) !== view.layoutSpec) actions.push(['UpdateRecord', '_grist_Views', viewRef, { layoutSpec: JSON.stringify(tidy) }]);
    }
    const page = pages.find(p => p.viewRef === viewRef);
    const published = here.some(s => JSON.parse(s.shareOptions || '{}').publish);
    if (page && page.shareRef && !published && !pages.some(p => p.id !== page.id && p.shareRef === page.shareRef)) {
      actions.push(['UpdateRecord', '_grist_Pages', page.id, { shareRef: 0 }], ['RemoveRecord', '_grist_Shares', page.shareRef]);
    }
  }
  if (actions.length) await apply(actions);
}

// Tables techniques sans page : elles restent dans « Données source », pas dans la liste des
// pages. Seule la page propre à la table est retirée (celle qui ne montre qu'elle).
export async function dropPages(tableIds) {
  const [tables, sections] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section')]);
  const views = tables.filter(tb => tableIds.includes(tb.tableId) && tb.primaryViewId).filter(tb =>
    sections.filter(s => s.parentId === tb.primaryViewId).every(s => s.tableRef === tb.id)).map(tb => tb.primaryViewId);
  if (views.length) await apply(views.map(v => ['RemoveView', v]));
}

// Page commune aux vues d'export de la version 0.3 (SOURCE), effacée avec l'ancien montage. 0 si
// elle n'existe pas.
const EXPORTS_PAGE = 'Synchro_Exports';
export async function exportsViewRef() {
  const view = (await fetchRows('_grist_Views')).find(v => v.name === EXPORTS_PAGE);
  return view ? view.id : 0;
}

// Retire une colonne de la page principale de sa table (elle reste dans les données brutes).
export async function hideColumn(tableId, colId) {
  const table = (await fetchRows('_grist_Tables')).find(tb => tb.tableId === tableId);
  const column = (await fetchRows('_grist_Tables_column')).find(c => c.parentId === table.id && c.colId === colId);
  const sections = new Set((await fetchRows('_grist_Views_section')).filter(s => s.parentId === table.primaryViewId).map(s => s.id));
  const fields = (await fetchRows('_grist_Views_section_field')).filter(f => f.colRef === column.id && sections.has(f.parentId));
  await apply(fields.length ? [['BulkRemoveRecord', '_grist_Views_section_field', fields.map(f => f.id)]] : []);
}

// Page qui porte ce widget : la seule section « personnalisée » dont l'adresse est celle de cette
// page. Sinon (aucune ou plusieurs), 0 : le formulaire va sur une nouvelle page.
function widgetViewRef(sections) {
  const here = location.origin + location.pathname;
  const mine = sections.filter((section) => {
    if (section.parentKey !== 'custom') return false;
    try {
      const url = new URL(JSON.parse(JSON.parse(section.options || '{}').customView || '{}').url);
      return url.origin + url.pathname === here;
    } catch (e) {
      return false;
    }
  });
  return mine.length === 1 ? mine[0].parentId : 0;
}
