// Accès au document courant, avec les droits de la personne qui a ouvert la page.
// Deux canaux seulement :
//  - l'API des widgets (`grist.docApi`) : lecture des tables, écritures groupées ;
//  - l'API REST de la même instance pour les webhooks, que l'API des widgets n'expose pas,
//    avec un jeton d'accès court (`getAccessToken`) passé en paramètre `auth=`.
import { toRows, parseDocBaseUrl } from './core.js';

export const fetchRows = async tableId => toRows(await grist.docApi.fetchTable(tableId));

export const apply = actions => (actions.length ? grist.docApi.applyUserActions(actions) : null);

export async function listTables() {
  const tables = await fetchRows('_grist_Tables');
  return tables.filter(t => !t.summarySourceTable && !t.tableId.startsWith('GristHidden')).map(t => ({ ref: t.id, tableId: t.tableId }));
}

// Colonnes d'une table, dans l'ordre de leur création.
export async function listColumns(tableId) {
  const table = (await listTables()).find(t => t.tableId === tableId);
  if (!table) return null;
  return (await fetchRows('_grist_Tables_column'))
    .filter(c => c.parentId === table.ref)
    .sort((a, b) => a.parentPos - b.parentPos)
    .map(c => ({
      id: c.id, colId: c.colId, type: c.type, isFormula: c.isFormula, label: c.label,
      displayCol: c.displayCol, rules: Array.isArray(c.rules) ? c.rules.slice(1) : [],
    }));
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
    headers: body ? { 'Content-Type': 'application/json' } : {},
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
  const table = (await listTables()).find(tb => tb.tableId === tableId);
  let section = (await fetchRows('_grist_Views_section')).find(s => s.parentKey === 'form' && s.tableRef === table.ref);
  if (!section) {
    const created = (await apply([['CreateViewSection', table.ref, await widgetViewRef(), 'form', null, null]])).retValues[0];
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
    fetchRows('_grist_Views_section'), listTables(), fetchRows('_grist_Views'), widgetViewRef()]);
  const pages = new Map();
  for (const section of sections) {
    if (section.parentKey !== 'form' || !JSON.parse(section.shareOptions || '{}').publish) continue;
    const table = tables.find(tb => tb.ref === section.tableRef);
    const view = views.find(v => v.id === section.parentId);
    if (table) pages.set(table.tableId, { samePage: section.parentId === mine, name: view ? view.name : '' });
  }
  return pages;
}

// Range les pages de ces tables sous la page du widget, à la fin de ses sous-pages, et replie
// celle-ci par défaut : les tables techniques ne s'empilent pas dans la liste des pages.
export async function tuckUnderWidgetPage(tableIds) {
  const viewRef = await widgetViewRef();
  if (!viewRef) return;
  const [tables, allPages] = await Promise.all([fetchRows('_grist_Tables'), fetchRows('_grist_Pages')]);
  const views = new Set(tables.filter(tb => tableIds.includes(tb.tableId)).map(tb => tb.primaryViewId));
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
