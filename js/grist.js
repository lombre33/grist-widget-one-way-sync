// Accès au document courant, avec les droits de la personne qui a ouvert la page.
// Deux canaux seulement :
//  - l'API des widgets (`grist.docApi`) : lecture des tables, écritures groupées ;
//  - l'API REST de la même instance pour les webhooks, que l'API des widgets n'expose pas,
//    avec un jeton d'accès court (`getAccessToken`) passé en paramètre `auth=`.
import { toRows, parseDocBaseUrl } from './core.js';

export const fetchRows = async tableId => toRows(await grist.docApi.fetchTable(tableId));

export const apply = actions => (actions.length ? grist.docApi.applyUserActions(actions) : null);

// Instantané des métadonnées du document (tables et colonnes), lu en deux requêtes : chaque
// écran ou passage de synchro le lit une fois, puis le relit après une écriture qui change le
// schéma. Les tables de résumé (vues d'export) et les tables cachées de Grist ne sont pas
// listées, mais `has` et `columns` les connaissent.
export async function readSchema() {
  const [tables, columns] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Tables_column')]);
  const byId = new Map(tables.map(tb => [tb.tableId, tb]));
  const colById = new Map(columns.map(c => [c.id, c]));
  return {
    tableIds: tables.filter(tb => !tb.summarySourceTable && !tb.tableId.startsWith('GristHidden')).map(tb => tb.tableId).sort(),
    has: tableId => byId.has(tableId),
    table: tableId => byId.get(tableId),
    // Colonnes d'une table, dans l'ordre de leur création ; null si la table n'existe pas.
    // `visible` : colonne affichée d'une Référence, dans la table visée.
    columns(tableId) {
      const table = byId.get(tableId);
      if (!table) return null;
      return columns.filter(c => c.parentId === table.id).sort((x, y) => x.parentPos - y.parentPos).map(c => ({
        id: c.id, colId: c.colId, type: c.type, isFormula: c.isFormula, label: c.label, description: c.description,
        displayCol: c.displayCol, rules: Array.isArray(c.rules) ? c.rules.slice(1) : [],
        visible: (colById.get(c.visibleCol) || {}).colId || '',
      }));
    },
  };
}

// Identité du document, déduite de l'adresse REST du jeton : instance, équipe, identifiant.
export async function docIdentity() {
  const { baseUrl } = await grist.docApi.getAccessToken({ readOnly: true });
  return parseDocBaseUrl(baseUrl);
}

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

export async function createWebhook({ name, memo, url, tableId }) {
  const result = await rest('POST', '/webhooks', {
    webhooks: [{ fields: { name, memo, url, tableId, eventTypes: ['add', 'update'], enabled: true, isReadyColumn: null } }],
  });
  return result.webhooks[0].id;
}

export const setWebhookEnabled = (id, enabled) => rest('PATCH', `/webhooks/${encodeURIComponent(id)}`, { enabled });
export const deleteWebhook = id => rest('DELETE', `/webhooks/${encodeURIComponent(id)}`);
export const clearWebhookQueue = () => rest('DELETE', '/webhooks/queue');

// ---------------------------------------------------------------------------------------------
// Formulaire de réception (CIBLE) : mêmes trois actions que le bouton « Publier » de Grist. Le
// serveur crée alors la clé de partage, que le widget ne peut pas lire : la personne copie le
// lien depuis la carte du formulaire.

// Idempotent, et repris là où il s'est arrêté : ajouter une section à la page du widget fait
// recréer son cadre par Grist, ce qui interrompt le script. Le widget rappelle donc cette
// fonction à chaque affichage tant que la table reçue attend son lien.
export async function ensureForm(tableId) {
  const table = (await readSchema()).table(tableId);
  let section = (await fetchRows('_grist_Views_section')).find(s => s.parentKey === 'form' && s.tableRef === table.id);
  if (!section) {
    const created = (await apply([['CreateViewSection', table.id, await widgetViewRef(), 'form', null, null]])).retValues[0];
    section = { id: created.sectionRef, parentId: created.viewRef, shareOptions: '' };
  }
  const page = (await fetchRows('_grist_Pages')).find(p => p.viewRef === section.parentId);
  if (!page.shareRef) {
    const linkId = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    const shareRef = (await apply([['AddRecord', '_grist_Shares', null, { linkId, options: JSON.stringify({ publish: true }) }]])).retValues[0];
    await apply([['UpdateRecord', '_grist_Pages', page.id, { shareRef }]]);
  }
  if (!JSON.parse(section.shareOptions || '{}').publish) {
    await apply([['UpdateRecord', '_grist_Views_section', section.id, { shareOptions: JSON.stringify({ form: true, publish: true }) }]]);
  }
}

// Page de chaque formulaire publié, par table : { samePage, name }, pour dire où cliquer.
export async function formPages() {
  const [sections, tables, views, mine] = await Promise.all([
    fetchRows('_grist_Views_section'), fetchRows('_grist_Tables'), fetchRows('_grist_Views'), widgetViewRef()]);
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
  const viewRef = await widgetViewRef();
  if (!viewRef) return;
  const [tables, sections, views] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Views_section'), fetchRows('_grist_Views')]);
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

// Range les pages de ces tables sous la page du widget, à la fin de ses sous-pages, et replie
// celle-ci par défaut : les tables techniques ne s'empilent pas dans la liste des pages.
// `viewRefs` : autres pages à ranger (celle d'une vue d'export, qui n'est pas une page principale).
export async function tuckUnderWidgetPage(tableIds, viewRefs = []) {
  const viewRef = await widgetViewRef();
  if (!viewRef) return;
  const [tables, allPages] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Pages')]);
  const views = new Set([...tables.filter(tb => tableIds.includes(tb.tableId)).map(tb => tb.primaryViewId), ...viewRefs]);
  const moving = allPages.filter(p => views.has(p.viewRef));
  const pages = allPages.filter(p => !views.has(p.viewRef)).sort((a, b) => a.pagePos - b.pagePos);
  const at = pages.findIndex(p => p.viewRef === viewRef);
  if (at < 0 || !moving.length) return;
  const parent = pages[at];
  let last = at;
  while (last + 1 < pages.length && pages[last + 1].indentation > parent.indentation) last++;
  const low = pages[last].pagePos;
  const high = last + 1 < pages.length ? pages[last + 1].pagePos : low + 1;
  const step = (high - low) / (moving.length + 1);
  const options = { ...JSON.parse(parent.options || '{}'), collapsed: true };
  await apply([
    ['BulkUpdateRecord', '_grist_Pages', moving.map(p => p.id), {
      pagePos: moving.map((_, i) => low + step * (i + 1)), indentation: moving.map(() => parent.indentation + 1) }],
    ['UpdateRecord', '_grist_Pages', parent.id, { options: JSON.stringify(options) }],
  ]);
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
async function widgetViewRef() {
  const here = location.origin + location.pathname;
  const mine = (await fetchRows('_grist_Views_section')).filter((section) => {
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
