// Test d'intégration : le parcours complet, dans un vrai Grist (tests/e2e/start-grist.sh) et un
// vrai navigateur (Playwright). Trois documents, le widget installé dans chacun :
//   SOURCE : créer un export, inviter (avec secret) ;  CIBLE : accepter, coller le lien, répondre ;
//   SOURCE : approuver, envoyer l'existant ;  CIBLE : consolider ; ajout, modification, suppression
//   logique et vraie suppression ; un second destinataire, puis sa seule révocation ; une table
//   ajoutée à l'export (fenêtre côté CIBLE, table existante) ; pause et reprise ; lien public.
// Seul écart avec un humain : le lien du formulaire est lu dans la base du serveur de test au lieu
// d'être copié depuis le bouton « Partager » de Grist (hors du widget).
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { partRow } from '../../js/engine/logic/files.js';
import { decodeCode } from '../../js/engine/logic/codes.js';
import { linkKeys, newKeyPair, readKeys, signText } from '../../js/engine/logic/trust.js';
import { PUBLIC_KEY, bucketOf } from '../../js/engine/logic/common.js';
import { ROOT, docTools, pickTab, serveWidget } from './shared.mjs';

// ENV_FILE=.env-dev.json WIDGET_PORT=8685 : un second Grist (voir start-grist.sh) et un autre port du widget, pour deux parcours à la fois.
const env = JSON.parse(await readFile(join(ROOT, 'tests/e2e', process.env.ENV_FILE || '.env.json'), 'utf8'));
const WIDGET_PORT = Number(process.env.WIDGET_PORT) || 8585;
const WIDGET_URL = `http://localhost:${WIDGET_PORT}/index.html`;
const TEAM = `${env.grist}/o/${env.team}`;

// --- Widget servi en local (shared.mjs). Le bilan des lignes (tally.js) : le délai de 10 minutes est ramené à
// 20 secondes pour le test.
let newsOn = false; // vrai pendant l'essai de la fenêtre des nouveautés (voir newsSteps)
const server = await serveWidget({
  env, port: WIDGET_PORT, news: () => newsOn,
  adjust(path, body) {
    if (path !== '/js/engine/logic/tally.js') return body;
    const patched = String(body).replace('TALLY_GRACE_S = 600', 'TALLY_GRACE_S = 20');
    if (!patched.includes('TALLY_GRACE_S = 20')) throw new Error('délai du bilan introuvable dans tally.js');
    return patched;
  },
});

// --- API REST de Grist (préparation et vérifications seulement)
async function api(method, path, body) {
  const res = await fetch(`${TEAM}/api${path}`, {
    method, headers: { Authorization: `Bearer ${env.apiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const applyActions = (doc, actions) => api('POST', `/docs/${doc}/apply`, actions);

// Règle d'accès qui cache une colonne aux lecteurs ; rend de quoi la retirer.
async function hideColumn(doc, tableId, colIds) {
  const resource = (await applyActions(doc, [['AddRecord', '_grist_ACLResources', null, { tableId, colIds }]])).retValues[0];
  const rule = (await applyActions(doc, [['AddRecord', '_grist_ACLRules', null,
    { resource, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', rulePos: 100, memo: 'e2e' }]])).retValues[0];
  return () => applyActions(doc, [['RemoveRecord', '_grist_ACLRules', rule], ['RemoveRecord', '_grist_ACLResources', resource]]);
}
const records = async (doc, table) => (await api('GET', `/docs/${doc}/tables/${table}/records`)).records.map(r => ({ id: r.id, ...r.fields }));
// Note du widget que porte une colonne : dans ses options (clé syncNote), jamais dans sa description, que Grist laisse lire
// aux lecteurs du document (voir columnNote). `syncNoteWrite` : l’action qui la réécrit, sans toucher aux autres options.
const syncNoteOf = column => JSON.parse(column.widgetOptions || '{}').syncNote || {};
const syncNoteWrite = (column, note) => ['UpdateRecord', '_grist_Tables_column', column.id, { widgetOptions: JSON.stringify({ ...JSON.parse(column.widgetOptions || '{}'), syncNote: note }) }];
// Fiche d'un destinataire (« e-mail · document · équipe/nom ») : le mémo de son webhook n'est qu'un jeton (il se lit dans les
// métadonnées du document, que Grist montre aux lecteurs), la fiche est dans la note de la SOURCE (`dest`).
const hookCard = async (doc, hook) => {
  const column = (await records(doc, '_grist_Tables_column')).find(c => c.colId === 'Synchro_Export' && syncNoteOf(c).exports);
  const entry = ((column && syncNoteOf(column).dest) || {})[hook.fields.memo];
  return entry ? entry.m : hook.fields.memo;
};
// Clé de signature reçue par une destination (note de sa colonne id_sync, voir storeKey).
const receivedKeyOf = async (doc, table, slot) => {
  const ref = await tableRef(doc, table);
  const col = (await records(doc, '_grist_Tables_column')).find(c => c.parentId === ref && c.colId === 'id_sync');
  return (syncNoteOf(col).signature || {})[slot];
};
// Colonnes affichées sur la page d'une table (ses vues en grille).
async function pageColumns(doc, tableId) {
  const table = (await records(doc, '_grist_Tables')).find(t => t.tableId === tableId);
  const sections = new Set((await records(doc, '_grist_Views_section')).filter(sc => sc.parentId === table.primaryViewId && sc.parentKey === 'record').map(sc => sc.id));
  const cols = new Map((await records(doc, '_grist_Tables_column')).map(c => [c.id, c.colId]));
  return [...new Set((await records(doc, '_grist_Views_section_field')).filter(f => sections.has(f.parentId)).map(f => cols.get(f.colRef)))];
}

async function waitFor(check, what, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Délai dépassé : ${what}`);
    await new Promise(r => setTimeout(r, 500));
  }
}

const { tableRef, newDocWithWidget, pageOf, publishedForms, formKey, formLink } = docTools({ env, api, applyActions, records, waitFor, widgetUrl: WIDGET_URL });

let lastStep = 'départ';
const step = text => { lastStep = text; console.log(`· ${text}`); };
// Images d'aide montrées par l'assistant à l'étape Lien (img/) : la carte du formulaire publié
// avec son bouton « Partager », puis la fenêtre de partage avec « Copier le lien ».
async function helpShots(formUrl, back) {
  await page.goto(formUrl);
  await clean();
  const pad = async (locator, path, margin = 12) => {
    const box = await locator.boundingBox();
    await page.screenshot({ path: join(ROOT, 'img', path), clip: {
      x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin), width: box.width + 2 * margin, height: box.height + 2 * margin } });
  };
  const share = page.getByRole('button', { name: 'Partager', exact: true }).first();
  const banner = share.locator('xpath=ancestor::div[.//button[normalize-space()="Dépublier"]][1]');
  // Seuls les trois boutons (Vue, Partager, Dépublier) : la bannière entière, large et vide, devenait illisible en vignette.
  const grouped = await banner.boundingBox();
  const shareBox = await share.boundingBox();
  const left = shareBox.x - 70 - 12;
  await page.screenshot({ path: join(ROOT, 'img', 'aide-partager.png'), clip: {
    x: Math.max(0, left), y: Math.max(0, grouped.y - 12), width: grouped.x + grouped.width + 12 - left, height: grouped.height + 24 } });
  await share.click();
  const copy = page.getByText('Copier le lien', { exact: true }).first();
  await copy.waitFor();
  await pad(copy.locator('xpath=ancestor::div[5]'), 'aide-copier.png', 4);
  await page.keyboard.press('Escape');
  await page.mouse.click(1090, 690);
  await copy.waitFor({ state: 'hidden' });
  await page.goto(back);
  await widget().locator('.topbar').waitFor({ timeout: 30000 });
}
// Captures de l'installation du widget (docs/images/00-*), dans un document neuf, comme un humain :
// Ajouter, Ajouter une page, Personnalisée, URL personnalisée, avertissement, accès complet.
async function installShots() {
  const ws = (await api('GET', `/orgs/${env.team}/workspaces`))[0].id;
  const doc = await api('POST', `/workspaces/${ws}/docs`, { name: 'Installation' });
  await page.goto(`${TEAM}/doc/${doc}`);
  const save = shot;
  await page.getByText('Ajouter', { exact: true }).first().click();
  await page.getByText('Ajouter une page', { exact: true }).first().waitFor();
  await save('00a-installer-ajouter');
  await page.getByText('Ajouter une page', { exact: true }).first().click();
  await page.getByText('Masquer les astuces').click({ timeout: 3000 }).catch(() => {});
  await page.getByText('J’ai compris').or(page.getByText("J'ai compris")).first().click({ timeout: 3000 }).catch(() => {});
  await page.getByText('Personnalisée', { exact: true }).first().click();
  await page.getByText('Table1', { exact: true }).last().click();
  await save('00b-installer-page');
  await page.getByRole('button', { name: 'Ajouter une page' }).click();
  await page.getByPlaceholder('URL du widget').fill(WIDGET_URL);
  await page.getByText('URL personnalisée', { exact: true }).click();
  await save('00c-installer-url');
  await page.getByRole('button', { name: 'Ajouter un widget' }).click();
  const warning = page.getByText('J’ai bien lu ces recommandations', { exact: false });
  if (await warning.isVisible({ timeout: 3000 }).catch(() => false)) {
    await warning.click();
    await page.getByRole('button', { name: 'Confirmer' }).click();
  }
  await page.locator('.test-right-opener').click();
  await page.locator('.test-right-tab-pagewidget').click();
  await page.getByRole('button', { name: 'Accepter' }).waitFor();
  await page.getByRole('button', { name: 'Accepter' }).click();
  await widget().locator('.guide summary').first().waitFor({ timeout: 30000 });
  await page.locator('.test-right-opener').click().catch(() => {});
}
// Captures du réglage d'accès (docs/images/00g, 00e et 00f), que montrent le message de démarrage et
// le tutoriel : la page entière, widget ouvert, pour qu'on voie où est le panneau de droite de Grist
// et son bouton, avec un cadre rouge sur ce qu'il faut trouver. Panneau fermé (l'icône qui l'ouvre),
// ouvert (section « Niveau d'accès » et « Accepter »), puis la liste des niveaux. À l'échelle 2.
async function accessShots(url) {
  const ctx = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1200, height: 720 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`${env.grist}/test/login?username=${env.email}&name=Test&next=${env.grist}/`);
  await p.goto(url);
  await p.addStyleTag({ content: '.dev_warning, .test-notifier-toast-wrapper { display: none !important; }' });
  // Le widget montre lui-même ces captures : elles sont retirées ici, pour que la capture ne les contienne pas.
  const inner = await waitFor(() => p.frames().find(f => f.url().startsWith(widgetCode)), 'iframe du widget');
  await inner.locator('.access-help').waitFor();
  await inner.evaluate(() => document.querySelector('.access-help').remove());
  // Cadre rouge autour de `box`, ramené dans la fenêtre (l'icône du panneau touche le bord droit).
  const frame = box => p.evaluate(({ x, y, width, height }) => {
    const left = Math.max(3, x - 6), top = Math.max(3, y - 6);
    const right = Math.min(window.innerWidth - 3, x + width + 6), bottom = Math.min(window.innerHeight - 3, y + height + 6);
    const d = document.createElement('div');
    d.className = 'capture-frame';
    d.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;border:3px solid #e5484d;`
      + 'box-sizing:border-box;border-radius:10px;box-shadow:0 0 0 4px rgba(229,72,77,.25);pointer-events:none;z-index:2147483647';
    document.body.append(d);
  }, box);
  const save = async (name, box) => {
    await frame(box);
    await p.screenshot({ path: join(ROOT, 'docs/images', `${name}.png`) });
    await p.evaluate(() => document.querySelectorAll('.capture-frame').forEach(d => d.remove()));
  };
  const opener = p.locator('.test-right-opener');
  await save('00g-installer-acces-ouvrir', await opener.boundingBox());
  await opener.click();
  const accept = p.locator('.test-config-widget-access-accept');
  await accept.waitFor();
  await p.waitForTimeout(600);
  const select = await p.locator('.test-config-widget-access').boundingBox();
  const prompt = await accept.boundingBox();
  const top = select.y - 34; // l'intitulé « Niveau d'accès » au-dessus de la liste
  await save('00e-installer-acces-accepter', { x: select.x - 8, y: top, width: select.width + 16, height: prompt.y + prompt.height + 14 - top });
  await p.locator('.test-config-widget-access').click();
  await p.getByText('Accès complet au document', { exact: true }).hover();
  await p.waitForTimeout(300);
  const menu = await p.locator('.test-select-menu').boundingBox();
  await save('00f-installer-acces-liste', menu);
  await ctx.close();
}
// Widget sans accès complet : Grist demande l'accès dans son panneau de droite ; le widget dit quoi
// faire, avec les deux captures. L'accès accordé, par « Accepter » comme par la liste, il démarre.
async function accessSteps() {
  const { doc, url } = await newDocWithWidget('Accès', null, 'none');
  await page.goto(url);
  const help = widget().locator('.access-help');
  await help.waitFor({ timeout: 30000 });
  if (process.env.CAPTURES) await accessShots(url);
  await widget().getByText('Le widget a besoin de l’accès complet au document', { exact: false }).waitFor();
  assert.equal(await help.locator('img').count(), 3, 'trois captures du réglage');
  assert.ok(await help.locator('img').evaluateAll(imgs => Promise.all(imgs.map(i => i.decode().then(() => i.naturalWidth > 0)))).then(all => all.every(Boolean)), 'captures chargées');
  assert.ok(await widget().locator('[data-tab]').evaluateAll(tabs => tabs.every(tab => tab.disabled)), 'onglets grisés tant que l’accès manque');
  assert.equal(await widget().getByRole('button', { name: 'Recharger la page' }).count(), 1);
  await page.locator('.test-right-opener').click();
  await page.locator('.test-config-widget-access-accept').click();
  await widget().locator('.guide summary').first().waitFor({ timeout: 30000 });
  step('Accès complet : message et captures sans accès, le widget démarre après « Accepter »');
  // Accès retiré, puis rendu par la liste « Niveau d'accès ».
  await page.locator('.test-config-widget-access').click();
  await page.getByText('Pas d’accès au document', { exact: true }).last().click();
  await widget().locator('.access-help').waitFor({ timeout: 30000 });
  await page.locator('.test-config-widget-access').click();
  await page.getByText('Accès complet au document', { exact: true }).last().click();
  await widget().locator('.guide summary').first().waitFor({ timeout: 30000 });
  step('Accès complet : le widget démarre aussi après le choix dans la liste');
  await page.locator('.test-right-opener').click().catch(() => {});
  return doc;
}
// CAPTURES=1 : enregistre les captures du tutoriel (docs/images) au fil du parcours.
// Captures sans le bandeau du serveur de test ni l'erreur de la galerie de widgets (hors ligne).
const clean = () => page.addStyleTag({ content: '.dev_warning, .test-notifier-toast-wrapper { display: none !important; }' });
// Avec `part`, la même capture recadrée sur la fenêtre ouverte (`modal`, sans le voile derrière)
// ou sur la première carte (`card`), pour le README (docs/images/readme) : lisible en vignette.
const shot = async (name, part) => {
  if (!process.env.CAPTURES) return;
  await page.waitForTimeout(400); // transitions finies (chevrons des parties repliables)
  await clean();
  await page.screenshot({ path: join(ROOT, 'docs/images', `${name}.png`) });
  if (!part) return;
  const target = part === 'modal' ? widget().locator('[role=dialog]').last() : widget().locator('.card').first();
  const { x, y, width, height } = await target.boundingBox();
  const m = part === 'modal' ? 0 : 8;
  await page.screenshot({ path: join(ROOT, 'docs/images/readme', `${name}.png`), style: '.scrim { background: none !important; }',
    clip: { x: x - m, y: y - m, width: width + 2 * m, height: height + 2 * m } });
};

// --- Documents
const source = await newDocWithWidget('Source', [
  // Interne n'est pas cochée à la création : elle ne doit arriver qu'une fois ajoutée à l'export.
  // Supprime existe déjà : la suppression logique est prise en compte (le widget ne l'ajoute plus).
  ['AddTable', 'Contacts', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }, { id: 'Interne', type: 'Text' }, { id: 'Delta', type: 'Numeric' },
    { id: 'Supprime', type: 'Bool' }]],
  ['BulkAddRecord', 'Contacts', [null, null, null, null], { Nom: ['Alice', 'Bob', 'Chloé', 'Dora'], Ville: ['Lyon', 'Paris', 'Nantes', 'Brest'],
    Interne: ['i1', 'i2', 'i3', 'i4'], Delta: [1, 2, 3, 4] }],
  ['AddTable', 'Villes', [{ id: 'Ville', type: 'Text' }]],
  ['BulkAddRecord', 'Villes', [null, null], { Ville: ['Lyon', 'Paris'] }],
]);
// La CIBLE a déjà un référentiel « Communes » (colonne Commune, une ligne Lyon annotée), choisi
// comme destination de Villes quand la SOURCE l'ajoute à l'export : Ville va dans Commune, et Lyon
// est rattachée au lieu d'être doublée.
const target = await newDocWithWidget('Cible', [
  ['AddTable', 'Communes', [{ id: 'Commune', type: 'Text' }, { id: 'Note', type: 'Text' }]],
  ['AddRecord', 'Communes', null, { Commune: 'Lyon', Note: 'déjà là' }],
]);
// Lieu : Référence vers Villes, affichée par le nom de la ville (Alice à Lyon, Bob à Paris).
{
  const colRef = async (table, colId) => {
    const parentId = await tableRef(source.doc, table);
    return (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === colId && c.parentId === parentId).id;
  };
  await applyActions(source.doc, [['AddColumn', 'Contacts', 'Lieu', { type: 'Ref:Villes' }]]);
  await applyActions(source.doc, [['UpdateRecord', '_grist_Tables_column', await colRef('Contacts', 'Lieu'), { visibleCol: await colRef('Villes', 'Ville') }],
    ['SetDisplayFormula', 'Contacts', null, await colRef('Contacts', 'Lieu'), '$Lieu.Ville'], ['BulkUpdateRecord', 'Contacts', [1, 2], { Lieu: [1, 2] }]]);
}
const target2 = await newDocWithWidget('Cible 2');
step('documents SOURCE et CIBLE créés');

const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1100, height: 700 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
  if (process.env.DEBUG && m.type() === 'warning') console.log(`  [widget] ${m.text()}`);
  if (m.type() !== 'error') return;
  const where = m.location().url || '';
  // Erreurs du widget seulement, grist-plugin-api.js compris (son thème ne doit plus heurter la
  // politique de sécurité du widget).
  if (!where.startsWith(`http://localhost:${WIDGET_PORT}`) && !where.endsWith('grist-plugin-api.js')) return;
  errors.push(`${m.text()} (${where}) [après : ${lastStep.slice(0, 70)}]`);
});
// Exception non rattrapée dans le widget (la console ne la voit pas toujours).
const widgetCode = `http://localhost:${WIDGET_PORT}`;
page.on('pageerror', (e) => { if ((e.stack || '').includes(widgetCode)) errors.push(`${e.message} (pageerror) [après : ${lastStep.slice(0, 70)}]`); });
await page.goto(`${env.grist}/test/login?username=${env.email}&name=Test&next=${env.grist}/`);

const widget = () => page.frameLocator('iframe').first();
const button = name => widget().getByRole('button', { name, exact: true });
async function openWidget(url) {
  await page.goto(url);
  await widget().locator('.topbar').waitFor({ timeout: 30000 });
}
// Ouvre la page du widget, puis son onglet `name` (voir pickTab : un clic donné trop tôt serait perdu).
async function openWidgetTab(url, name) {
  await openWidget(url);
  await pickTab(widget(), name);
}

try {
  const dialog = () => widget().getByRole('dialog');
  const dialogButton = name => dialog().getByRole('button', { name, exact: true });
  // Le widget pose les règles d'accès de `Synchro` au premier dessin qui suit la fermeture d'un assistant (jamais pendant
  // un assistant, voir syncRules), et Grist recharge alors le document, donc le widget, environ 250 ms plus tard : un clic
  // donné entre-temps est perdu (c'était déjà le cas avant la 0.18). Attend que les règles soient là, puis que le widget
  // soit revenu et resté en place un moment.
  const rulesSettled = async doc => {
    await waitFor(async () => (await records(doc, '_grist_ACLRules')).some(r => r.memo === 'Synchro : réservée aux propriétaires'), 'règles du widget posées', 30000);
    let last = Date.now();
    const moved = () => { last = Date.now(); };
    page.on('framenavigated', moved);
    while (Date.now() - last < 1500) await page.waitForTimeout(100);
    page.off('framenavigated', moved);
    await widget().locator('.topbar').waitFor({ timeout: 30000 });
  };
  // Une table neuve : le widget demande de confirmer (le widget ne sera pas sur sa page, voir confirmNewTables).
  const confirmNewTable = async () => {
    await dialog().getByText('Nouvelle table : le widget n’y sera pas').waitFor({ timeout: 30000 });
    await dialogButton('Continuer avec une nouvelle table').click();
  };
  const pick = async (field, option) => {
    // Nom accessible du bouton : « Champ : choix en cours ».
    await dialog().getByRole('button', { name: `${field} : ` }).click();
    await dialog().getByRole('option', { name: option, exact: true }).click();
  };
  // Formulaire publié sur sa page, dans `doc`, pour une table créée pour l'occasion.
  async function strayForm(doc, tableId, columns) {
    await applyActions(doc, [['AddTable', tableId, columns]]);
    const { sectionRef, viewRef } = (await applyActions(doc, [['CreateViewSection', await tableRef(doc, tableId), 0, 'form', null, null]])).retValues[0];
    const shareRef = (await applyActions(doc, [['AddRecord', '_grist_Shares', null, { linkId: `e2e${Date.now()}`, options: '{"publish": true}' }]])).retValues[0];
    await applyActions(doc, [['UpdateRecord', '_grist_Pages', (await pageOf(doc, viewRef)).id, { shareRef }],
      ['UpdateRecord', '_grist_Views_section', sectionRef, { shareOptions: '{"form": true, "publish": true}' }]]);
    // Effacer la table efface aussi sa page devenue vide ; le partage reste.
    return { form: { id: sectionRef, parentId: viewRef }, remove: () => applyActions(doc, [['RemoveTable', tableId], ['RemoveRecord', '_grist_Shares', shareRef]]) };
  }
  const pagesOf = async doc => (await api('POST', `/docs/${doc}/sql`, {
    sql: 'select p.indentation, p.options, v.name from _grist_Pages p join _grist_Views v on v.id = p.viewRef order by p.pagePos' })).records.map(r => r.fields);

  // SOURCE : un export d'une table, toutes ses colonnes (ou ce que `columns` règle à l'étape des colonnes).
  async function newExport(table, name, columns = async () => {}) {
    await button('Nouvel export').click();
    await dialog().getByRole('checkbox', { name: table }).check();
    await dialogButton('Continuer').click();
    await columns();
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill(name);
    await dialogButton('Créer l’export').click();
  }
  // SOURCE de test : une table Fiches de trois lignes (Anna, Basile, Céline).
  const fichesDoc = name => newDocWithWidget(name, [
    ['AddTable', 'Fiches', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }]],
    ['BulkAddRecord', 'Fiches', [null, null, null], { Nom: ['Anna', 'Basile', 'Céline'], Ville: ['Lyon', 'Paris', 'Nantes'] }],
  ]);
  // SOURCE : ouvre le widget de `src` et y crée un export de `table`, nommé `name`.
  async function startExport(src, table, name, columns) {
    await openWidget(src.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await newExport(table, name, columns);
  }
  // SOURCE : une invitation aux options par défaut pour l'export affiché ; rend son code, fenêtre refermée.
  async function plainInvitation() {
    await dialogButton('Ajouter un destinataire').click();
    await dialogButton('Créer l’invitation').click();
    await dialog().getByText('Transmettez ce code').waitFor();
    const code = await dialog().locator('textarea.code').first().inputValue();
    await dialogButton('Plus tard').click();
    return code;
  }
  // SOURCE : révoquer la personne de `where` (par défaut la seule affichée).
  async function revoke(where = widget()) {
    await where.getByRole('button', { name: 'Révoquer', exact: true }).click();
    await dialogButton('Révoquer').click();
  }
  // Coller un lien de formulaire dans le champ `label`, le tester ; rend le code affiché si le
  // test donne le texte `ok`.
  async function testLink(label, link, ok) {
    await dialog().getByLabel(label).fill(link);
    await dialogButton('Tester le lien').click();
    await dialog().getByText(ok).waitFor();
    return dialog().locator('textarea.code').first().inputValue();
  }
  // `count` lignes de Contacts (`prefix` numéro, remplissage de 80 caractères) ; rend leurs id.
  async function addContacts(prefix, count, fill) {
    const names = Array.from({ length: count }, (_, i) => `${prefix} ${i} ${fill.repeat(80)}`);
    return (await applyActions(source.doc, [['BulkAddRecord', 'Contacts', names.map(() => null), { Nom: names }]])).retValues[0];
  }

  // SOURCE d'un Échange, « Créer l'invitation » cliqué : attend le formulaire de retour publié en plus de ceux de `known`,
  // rouvre l'assistant à l'étape du lien de retour, et rend ce formulaire avec le code à transmettre.
  async function returnInvitation(a, known = []) {
    const forms = await waitFor(async () => { const f = (await publishedForms(a.doc)).filter(x => !known.some(k => k.id === x.id)); return f.length === 1 && f; },
      known.length ? 'second formulaire de retour publié' : 'formulaire de retour publié');
    await openWidget(a.url);
    const code = await testLink('Lien du formulaire de retour', await formLink(a.doc, forms[0]), 'Transmettez ce code');
    await dialogButton('Plus tard').click();
    return { form: forms[0], code };
  }
  // CIBLE : coller le code de l'invitation dans l'assistant de réception.
  async function pasteInvitation(url, code) {
    const paste = async (again = false) => {
      if (!again) {
        await openWidget(url);
        await widget().locator('.tile', { hasText: 'Recevoir des tables' }).click();
        await button('Accepter une invitation').click();
      }
      await dialog().locator('textarea.code').first().fill(code);
      await dialogButton('Continuer').click();
    };
    // Un Échange renvoie des tables d'ici par la table Synchro : ses règles d'accès sont posées d'abord (le document se recharge
    // et l'assistant avec lui), le code est à recoller. Les autres invitations passent à l'étape suivante (bouton « Retour »).
    const protect = dialogButton('Protéger et recharger');
    for (let tries = 0; tries < 3; tries++) {
      await paste(tries > 0); // après le rechargement, l'assistant se rouvre seul sur l'étape Code
      await Promise.race([protect.waitFor({ timeout: 30000 }), dialogButton('Retour').waitFor({ timeout: 30000 })]).catch(() => {});
      if (!(await protect.count())) return;
      await protect.click();
      await protect.waitFor({ state: 'detached', timeout: 60000 });
      await page.waitForTimeout(3000);
    }
  }
  // CIBLE : accepter une invitation (destinations par défaut), coller le lien du formulaire
  // publié, rendre la réponse.
  // Depuis la 0.22, une réception nouvelle demande l'accord pour les colonnes que la SOURCE ajoute (case décochée d'emblée) : les essais
  // qui ne la testent pas la cochent (`ask: true` la laisse décochée, après avoir vérifié qu'elle l'est).
  const AUTO_BOX = 'Appliquer automatiquement les colonnes que la SOURCE ajoute à l’export';
  async function accept(doc, url, code, tables = '« Annuaire » : table Contacts.', checks = [], { ask = false } = {}) {
    await pasteInvitation(url, code);
    await dialog().getByText(tables).waitFor();
    // Un Échange et un lien public n'ont pas ce réglage (leurs options avancées ne sont pas offertes).
    const more = dialog().getByText('Options avancées');
    if (checks.length || await more.count()) {
      await more.click();
      const auto = dialog().getByRole('checkbox', { name: AUTO_BOX });
      if (await auto.count()) {
        assert.ok(!(await auto.isChecked()), 'les colonnes ajoutées par la SOURCE attendent l\'accord, d\'emblée');
        if (!ask) await auto.check();
      }
    }
    for (const name of checks) await dialog().getByRole('checkbox', { name }).check();
    await dialogButton('Continuer').click();
    await confirmNewTable();
    const forms = await waitFor(async () => { const f = await publishedForms(doc); return f.length === 1 && f; }, 'formulaire publié');
    await openWidget(url); // l'assistant se rouvre seul à l'étape Lien
    const code2 = await testLink('Lien du formulaire', await formLink(doc, forms[0]), 'Le lien fonctionne');
    shownControl = await dialog().locator('.control-code strong').first().textContent();
    await dialogButton('Fermer').click();
    return code2;
  }
  // Code de contrôle montré par la CIBLE avec sa réponse : la SOURCE doit voir le même.
  let shownControl = '';
  // SOURCE : coller la réponse sur la ligne de l'invitation, approuver, envoyer l'existant.
  async function approve(reply, { shots = false, url = source.url, compare = false } = {}) {
    await openWidget(url);
    await button('Coller la réponse').click();
    await dialog().locator('textarea.code').first().fill(reply);
    await dialogButton('Vérifier').click();
    await dialog().getByText(env.email).waitFor();
    await dialog().getByText('Document, dossier et équipe sont donnés par Grist').waitFor();
    assert.equal(await dialog().locator('.control-code strong').textContent(), shownControl, 'même code de contrôle des deux côtés');
    assert.ok(!/\bnull\b/.test(await dialog().innerText()), 'aucun « null » écrit dans la fiche');
    if (shots) await shot('11-source-fiche', 'modal');
    if (compare) {
      await dialogButton('Approuver et brancher').click();
      await dialog().getByText('comparez d’abord le code de contrôle').waitFor();
      await dialog().getByRole('checkbox', { name: 'J’ai comparé ce code avec la personne' }).check();
    }
    await dialogButton('Approuver et brancher').click();
    await dialog().getByText('Branché').waitFor();
    if (shots) await shot('12-source-envoi');
    await dialog().getByText(/lignes? à envoyer, environ [\d\s]+ Ko, en [\d\s]+ lots?/).waitFor();
    await dialogButton('Envoyer').click();
    await dialog().getByText(/Lignes existantes envoyées\s:\s[\d\s]+\./).waitFor();
    await dialogButton('Fermer').click();
    await dialog().waitFor({ state: 'detached' });
  }
  const rawRows = async (doc, journal) => (await records(doc, journal)).filter(r => r.Synchro_Type);

  // --- Échange : deux documents se tiennent à jour l'un l'autre. A invite (formulaire de retour
  // publié chez A, son lien dans le code), B accepte et répond, A approuve. Une modification va
  // d'un côté à l'autre sans revenir (pas d'écho) ; la plus récente l'emporte ; la case Supprime
  // efface des deux côtés.
  async function exchangeSteps() {
    const a = await fichesDoc('Échange A');
    const b = await newDocWithWidget('Échange B');
    await startExport(a, 'Fiches', 'Partage');
    await dialogButton('Ajouter un destinataire').click();
    await dialog().getByRole('radio', { name: /Échange/ }).check();
    await dialog().getByText('la plus récente l’emporte', { exact: false }).first().waitFor();
    await shot('20-echange-mode', 'modal');
    await dialogButton('Créer l’invitation').click();
    const { form: back, code } = await returnInvitation(a);
    assert.ok(!JSON.stringify(await api('POST', `/docs/${a.doc}/sql`, { sql: 'select description from _grist_Tables_column' })).includes('/api/s/'),
      'adresse de retour notée nulle part chez A');
    const answer = await accept(b.doc, b.url, code, '« Partage » : table Fiches.');
    const bHooks = (await api('GET', `/docs/${b.doc}/webhooks`)).webhooks;
    assert.equal(bHooks.length, 1, 'B renvoie vers A par un webhook');
    await approve(answer, { url: a.url });
    const fiches = async doc => Object.fromEntries((await records(doc, 'Fiches')).map(r => [r.Nom, r]));
    // Ouvre le widget du document `w` et attend que ses fiches (par nom) vérifient `ok`.
    const seenIn = async (w, ok, what) => { await openWidget(w.url); return waitFor(async () => ok(await fiches(w.doc)), what); };
    const aRows = await fiches(a.doc);
    assert.ok(Object.values(aRows).every(r => r.Supprime === false), 'A : case Supprime ajoutée');
    await openWidget(b.url);
    const bRows = await waitFor(async () => { const r = await fiches(b.doc); return Object.keys(r).length === 3 && r; }, 'B reçoit les fiches de A');
    assert.deepEqual(Object.values(bRows).map(r => `${r.Nom}:${r.Ville}:${r.id_sync === aRows[r.Nom].id_sync}`).sort(), ['Anna:Lyon:true', 'Basile:Paris:true', 'Céline:Nantes:true']);
    assert.ok(['MajLe', 'RecalculLe', 'Supprime'].every(c => c in bRows.Anna), 'B : colonnes de l\'envoi de retour');
    await widget().getByText('Échange : vos modifications de ces tables repartent vers ce document, qui peut les transmettre à d’autres participants.').waitFor();
    await shot('21-echange-cible');
    // Lignes de A recopiées chez B : rien ne repart vers A.
    const sentLines = async (doc, table) => (await rawRows(doc, table)).flatMap(r => (r.Synchro_Type === 'lot' ? JSON.parse(r.Synchro_Lot || '{}').lignes || [] : []));
    const aJournal = (await records(a.doc, '_grist_Tables')).find(tb => tb.tableId.startsWith('Journal_')).tableId;
    const bJournal = (await records(b.doc, '_grist_Tables')).find(tb => tb.tableId.startsWith('Journal_')).tableId;
    await new Promise(r => setTimeout(r, 3000));
    assert.deepEqual(await sentLines(a.doc, aJournal), [], 'pas d\'écho vers A');
    assert.ok(!(await rawRows(a.doc, aJournal)).some(r => r.Synchro_Type === 'cles' && r.Synchro_Ids), 'pas de liste des clés dans un Échange');

    // B modifie et ajoute : A reçoit, sans écho vers B.
    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bRows.Basile.id, { Ville: 'Brest' }], ['AddRecord', 'Fiches', null, { Nom: 'Damien', Ville: 'Metz' }]]);
    await openWidget(a.url);
    await waitFor(async () => { const r = await fiches(a.doc); return r.Basile.Ville === 'Brest' && r.Damien && r.Damien.Ville === 'Metz'; }, 'A reçoit les modifications de B');
    const damien = (await fiches(b.doc)).Damien.id_sync;
    assert.match(damien, /^[0-9a-f-]{36}$/, 'B : clé posée à la création');
    assert.equal((await fiches(a.doc)).Damien.id_sync, damien, 'même clé des deux côtés');
    // Qui a vu l'invitation a l'adresse de retour et la clé publique de A, aucune clé de
    // signature : les clés qu'il en tire avec une paire à lui ne sont pas celles de B, et son lot
    // est rejeté par A.
    const invitation = decodeCode(code, 'invitation');
    assert.equal(invitation.cle, undefined, 'aucune clé de signature dans l\'invitation');
    assert.match(invitation.pub, PUBLIC_KEY);
    const intruder = await linkKeys((await newKeyPair()).priv, invitation.pub, invitation.export, invitation.id);
    const row = { Synchro_Export: invitation.export, Synchro_Table: 'Fiches', Synchro_Type: 'lot', Synchro_Colonnes: '' };
    const lot = await signText(intruder.up, row, JSON.stringify({ lignes: [['intrus', Date.now() / 1000, false, { Nom: 'Intrus', Ville: 'Nulle part' }]], total: 1 }));
    assert.ok((await fetch(invitation.retour, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ ...row, Synchro_Lot: lot }]) })).ok);
    await waitFor(async () => !(await rawRows(a.doc, aJournal)).some(r => r.Synchro_Lot === lot), 'lot forgé lu par A');
    assert.ok(!(await fiches(a.doc)).Intrus, 'lot signé avec une clé tirée de l\'invitation seule : rejeté');
    await new Promise(r => setTimeout(r, 3000));
    assert.ok(!(await sentLines(b.doc, bJournal)).some(l => ['Brest', 'Metz'].includes(l[3].Ville)), 'pas d\'écho vers B');

    // A modifie : B reçoit.
    await applyActions(a.doc, [['UpdateRecord', 'Fiches', aRows.Anna.id, { Ville: 'Lille' }]]);
    await seenIn(b, r => r.Anna.Ville === 'Lille', 'B reçoit la modification de A');

    // Les deux modifient Céline, B d'abord : la version de A, plus récente, l'emporte des deux côtés.
    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bRows.Céline.id, { Ville: 'Rennes' }]]);
    await waitFor(async () => (await sentLines(a.doc, aJournal)).some(l => l[3].Ville === 'Rennes'), 'version de B arrivée chez A');
    await applyActions(a.doc, [['UpdateRecord', 'Fiches', aRows.Céline.id, { Ville: 'Dijon' }]]);
    await openWidget(a.url);
    await waitFor(async () => !(await sentLines(a.doc, aJournal)).length, 'A a lu la version de B');
    assert.equal((await fiches(a.doc)).Céline.Ville, 'Dijon', 'A garde sa version, plus récente');
    await seenIn(b, r => r.Céline.Ville === 'Dijon', 'B prend la version de A, plus récente');

    // B coche Supprime : la ligne disparaît chez A, reste cochée chez B.
    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bRows.Anna.id, { Supprime: true }]]);
    await seenIn(a, r => !r.Anna, 'Supprime cochée chez B : ligne effacée chez A');
    assert.equal((await fiches(b.doc)).Anna.Supprime, true);
    step('Échange : modifications dans les deux sens, sans écho, la plus récente l\'emporte, Supprime efface des deux côtés');

    // --- Échange à plusieurs : C rejoint l'Échange que A administre. Ce que B envoie repart vers C
    // par A, et inversement ; une ligne cochée Supprime chez C reste cochée chez A et disparaît chez
    // B ; A retire C, dont l'envoi de retour s'arrête ; B continue.
    const c = await newDocWithWidget('Échange C');
    await openWidget(a.url);
    await button('Ajouter un participant').click();
    assert.ok(await dialog().getByRole('radio', { name: /Un participant de plus/ }).isChecked(), 'l\'Échange est proposé d\'office');
    assert.ok(await dialog().getByRole('radio', { name: /Dans un seul sens/ }).isDisabled(), 'un export en Échange n\'a que des participants');
    await dialogButton('Créer l’invitation').click();
    const { code: codeC } = await returnInvitation(a, [back]);
    const answerC = await accept(c.doc, c.url, codeC, '« Partage » : table Fiches.');
    await approve(answerC, { url: a.url });
    const swapRow = async () => (await records(a.doc, 'Synchro')).find(r => r.Synchro_Type === 'echange');
    assert.equal((await swapRow()).Synchro_Colonnes, 'plusieurs', 'Échange à plusieurs dès deux participants');
    await widget().getByText(/Échange à plusieurs \(2 participants\)/).waitFor();
    await shot('22-echange-plusieurs');
    const names = async doc => Object.values(await fiches(doc)).filter(r => !r.Supprime).map(r => `${r.Nom}:${r.Ville}`).sort().join();
    await openWidget(c.url);
    await waitFor(async () => (await names(c.doc)) === (await names(a.doc)), 'C reçoit les fiches de A');

    const bNow = await fiches(b.doc);
    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bNow.Basile.id, { Ville: 'Vannes' }]]);
    await seenIn(a, r => r.Basile.Ville === 'Vannes', 'A reçoit la modification de B');
    await seenIn(c, r => r.Basile.Ville === 'Vannes', 'C reçoit, par A, la modification de B');
    await applyActions(c.doc, [['AddRecord', 'Fiches', null, { Nom: 'Élise', Ville: 'Caen' }]]);
    await seenIn(a, r => (r.Élise || {}).Ville === 'Caen', 'A reçoit l\'ajout de C');
    await seenIn(b, r => (r.Élise || {}).Ville === 'Caen', 'B reçoit, par A, l\'ajout de C');
    await applyActions(c.doc, [['UpdateRecord', 'Fiches', (await fiches(c.doc)).Damien.id, { Supprime: true }]]);
    await seenIn(a, r => (r.Damien || {}).Supprime === true, 'A garde Damien, cochée Supprime');
    await seenIn(b, r => !r.Damien, 'B efface Damien');

    await openWidget(a.url);
    await revoke(widget().locator(`.person[data-memo*="${c.doc.slice(0, 10)}"]`));
    await waitFor(async () => (await api('GET', `/docs/${a.doc}/webhooks`)).webhooks.length === 1, 'un participant de moins');
    assert.deepEqual((await publishedForms(a.doc)).map(f => f.id), [back.id], 'son journal de retour et sa clé sont effacés, pas ceux de B');
    assert.equal((await swapRow()).Synchro_Colonnes, '', 'retour à l\'Échange à deux');
    await openWidget(c.url);
    await widget().getByText('Coupé par la SOURCE').waitFor({ timeout: 30000 });
    await waitFor(async () => !(await api('GET', `/docs/${c.doc}/webhooks`)).webhooks.length, 'C : envoi de retour arrêté');
    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bNow.Céline.id, { Ville: 'Tours' }]]);
    await seenIn(a, r => r.Céline.Ville === 'Tours', 'B et A continuent');
    step('Échange à plusieurs : ce que B envoie repart vers C par A, et inversement ; Supprime cochée chez C efface chez B, reste cochée chez A ; A retire C, B continue');

    // --- Règles de A pour les changements des participants : les modifications de B sont à
    // valider, ses ajouts refusés. Une modification acceptée est recopiée chez A ; refusée, B
    // reprend la version de A. Un ajout refusé disparaît chez B et reste chez A, coché Supprime.
    await openWidget(a.url);
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    await dialogButton('Continuer').click();
    await dialog().getByText('Changements reçus des participants').waitFor();
    assert.ok(!(await dialog().getByText('En cas de refus').isVisible()), 'le refus ne se règle que si un changement n\'est pas accepté d\'office');
    await pick('Ligne modifiée', 'À valider');
    await pick('Ligne ajoutée', 'Refuser');
    assert.ok(await dialog().getByRole('radio', { name: /reprend la ligne d’ici/ }).isChecked(), 'par défaut, le participant reprend la ligne de A');
    await shot('23-echange-regles');
    await dialogButton('Enregistrer').click();
    await dialog().getByText('Enregistré.').waitFor();
    await dialogButton('Fermer').click();
    await widget().getByText(/Changements des participants\s:\sLigne ajoutée \(Refuser\), Ligne modifiée \(À valider\)/).waitFor();
    const review = name => widget().locator('.review-item', { hasText: name });

    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bNow.Basile.id, { Ville: 'Quimper' }]]);
    await openWidgetTab(a.url, 'Recevoir');
    await review('Basile').waitFor({ timeout: 30000 });
    await widget().getByText(/Fiches\s:\s1 changement à valider/).waitFor();
    assert.equal((await fiches(a.doc)).Basile.Ville, 'Vannes', 'rien n\'est écrit chez A avant la décision');
    await shot('24-echange-valider');
    await review('Basile').getByRole('button', { name: 'Accepter', exact: true }).click();
    await waitFor(async () => (await fiches(a.doc)).Basile.Ville === 'Quimper', 'acceptée : recopiée chez A');
    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bNow.Céline.id, { Ville: 'Angers' }]]);
    await review('Céline').waitFor({ timeout: 30000 });
    await review('Céline').getByRole('button', { name: 'Refuser', exact: true }).click();
    await waitFor(async () => (await widget().locator('.chg-row.chg-refus', { hasText: 'Céline' }).count()) > 0, 'historique : modification refusée');
    assert.equal((await fiches(a.doc)).Céline.Ville, 'Tours', 'refusée : A garde sa version');
    await seenIn(b, r => r.Céline.Ville === 'Tours', 'refusée : B reprend la version de A');
    await applyActions(b.doc, [['AddRecord', 'Fiches', null, { Nom: 'Fanny', Ville: 'Laval' }]]);
    await seenIn(a, r => (r.Fanny || {}).Supprime === true, 'ajout refusé : la ligne reste chez A, cochée Supprime');
    await seenIn(b, r => !r.Fanny, 'ajout refusé : effacé chez B');
    step('Échange administré : modification à valider, acceptée puis refusée (B reprend la version de A) ; ajout refusé, effacé chez B');
  }
  // --- Options d'une réception : archive (une ligne effacée à la SOURCE reste ici, cochée) et
  // tables en lecture seule (règle d'accès posée par un propriétaire) ; et historique des envois
  // noté dans la SOURCE.
  async function optionsSteps() {
    const src = await fichesDoc('Options SOURCE');
    const dst = await newDocWithWidget('Options CIBLE');
    await startExport(src, 'Fiches', 'Annuaire');
    const code = await plainInvitation();
    const answer = await accept(dst.doc, dst.url, code, '« Annuaire » : table Fiches.', [/^Archive/, /lecture seule/]);
    await approve(answer, { url: src.url });
    const fiches = async () => Object.fromEntries((await records(dst.doc, 'Fiches')).map(r => [r.Nom, r]));
    await openWidget(dst.url);
    await waitFor(async () => Object.keys(await fiches()).length === 3, 'fiches reçues', 60000);
    const column = (await records(dst.doc, '_grist_Tables_column')).find(c => c.colId === 'Supprimee_a_la_source');
    assert.equal(column && column.type, 'Bool', 'la case de l\'archive est créée dans la destination');
    const lockRules = async () => (await records(dst.doc, '_grist_ACLRules')).filter(r => r.memo === 'Synchro : table reçue en lecture seule');
    await waitFor(async () => (await lockRules()).length === 1, 'règle de lecture seule posée par un propriétaire', 60000);
    assert.deepEqual(lockRules && (await lockRules()).map(r => [r.aclFormula, r.permissionsText]), [['user.Access != OWNER', '-CUD']]);
    await openWidgetTab(dst.url, 'Recevoir');
    // Archive : Basile disparaît de la SOURCE, il reste ici, coché ; ni retouche ni suppression.
    await applyActions(src.doc, [['RemoveRecord', 'Fiches', 2]]);
    await waitFor(async () => (await fiches()).Basile?.Supprimee_a_la_source === true, 'ligne effacée à la SOURCE gardée ici, cochée', 90000);
    const kept = await fiches();
    assert.deepEqual([kept.Anna.Supprimee_a_la_source, kept.Céline.Supprimee_a_la_source], [false, false]);
    assert.equal(Object.keys(kept).length, 3, 'rien n\'est effacé');
    assert.equal(await widget().locator('.drift').count(), 0, 'une ligne gardée en archive n\'est pas une retouche');
    await shot('27-cible-archive', 'card');
    // La note du journal, réécrite par quelqu'un d'autre (un éditeur peut le faire), ne retire pas la
    // règle de lecture seule : le passage d'un propriétaire remet la note d'accord avec la règle.
    const journalNote = async () => {
      const journal = (await records(dst.doc, '_grist_Tables')).find(tb => tb.tableId.startsWith('Journal_'));
      const column = (await records(dst.doc, '_grist_Tables_column')).find(c => c.colId === 'Synchro_Ids' && c.parentId === journal.id);
      return { column, note: syncNoteOf(column) };
    };
    const tampered = await journalNote();
    assert.equal(tampered.note.verrou, true);
    await applyActions(dst.doc, [syncNoteWrite(tampered.column, { ...tampered.note, verrou: false })]);
    await openWidget(dst.url);
    await waitFor(async () => (await journalNote()).note.verrou === true, 'note remise d\'accord avec la règle de lecture seule', 60000);
    assert.equal((await lockRules()).length, 1, 'la règle reste en place');
    await widget().getByRole('tab', { name: 'Recevoir' }).click();
    // Options de la carte : archive et verrou retirés, la règle part (seul un propriétaire la lève).
    await button('Options').click();
    await dialog().getByRole('checkbox', { name: /lecture seule/ }).uncheck();
    await dialog().getByRole('checkbox', { name: /^Archive/ }).uncheck();
    await dialog().getByText(/ne supprime pas les lignes déjà archivées/).waitFor();
    await dialogButton('Enregistrer').click();
    await waitFor(async () => (await lockRules()).length === 0, 'règle de lecture seule retirée', 60000);
    // Archive décochée : la ligne déjà archivée reste, la suivante est effacée.
    await applyActions(src.doc, [['RemoveRecord', 'Fiches', 3]]);
    await waitFor(async () => !(await fiches()).Céline, 'ligne effacée à la SOURCE après l\'arrêt de l\'archive : effacée ici', 90000);
    const after = await fiches();
    assert.equal(after.Basile?.Supprimee_a_la_source, true, 'la ligne archivée reste, cochée');
    assert.deepEqual(Object.keys(after).sort(), ['Anna', 'Basile']);
    // Historique des envois, côté SOURCE : le destinataire, puis l'envoi de l'existant.
    await openWidget(src.url);
    const history = widget().locator('.history', { hasText: 'Historique des envois' });
    await history.waitFor();
    await history.locator('summary').click();
    await history.getByText(/reçoit désormais cet export/).waitFor();
    await history.getByText(/Envoi de 3 lignes à tous les destinataires actifs/).waitFor();
    await shot('28-source-historique', 'card');
    step('Options d\'une réception : archive (ligne effacée à la SOURCE gardée, cochée, sans alerte), tables en lecture seule (règle posée puis retirée), archive décochée (la ligne archivée reste) ; historique des envois dans la SOURCE');
  }
  // --- Effacer l'historique sur demande (CIBLE : l'avant des modifications et les valeurs des lignes supprimées du journal ; SOURCE :
  // l'historique des envois). Rien ne se fait seul ; la recopie continue ensuite comme avant.
  async function cleanSteps() {
    const src = await fichesDoc('Effacer SOURCE');
    const dst = await newDocWithWidget('Effacer CIBLE');
    await startExport(src, 'Fiches', 'Annuaire');
    const code = await plainInvitation();
    const answer = await accept(dst.doc, dst.url, code, '« Annuaire » : table Fiches.');
    await approve(answer, { url: src.url });
    const fiches = async () => Object.fromEntries((await records(dst.doc, 'Fiches')).map(r => [r.Nom, r]));
    const journalRows = async () => (await records(dst.doc, (await records(dst.doc, '_grist_Tables')).find(tb => tb.tableId.startsWith('Journal_')).tableId)).filter(r => r.id_sync);
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => Object.keys(await fiches()).length === 3, 'fiches reçues', 60000);
    // Une modification et une suppression : l'avant de la première et les valeurs de la seconde sont dans le journal.
    await applyActions(src.doc, [['UpdateRecord', 'Fiches', 1, { Ville: 'Marseille' }], ['RemoveRecord', 'Fiches', 3]]);
    await waitFor(async () => (await fiches()).Anna?.Ville === 'Marseille' && !(await fiches()).Céline, 'modification et suppression reçues', 90000);
    await waitFor(async () => (await journalRows()).some(r => r.Sync_Avant) && (await journalRows()).some(r => r.Sync_Etat === 'suppression' && r.Synchro_Donnees), 'avant et valeurs supprimées dans le journal', 60000);
    await openWidgetTab(dst.url, 'Recevoir');
    const history = widget().locator('details.history');
    await history.waitFor();
    assert.ok(await history.locator('.chg-item').count() >= 2, 'l\'historique montre les deux changements');
    await shot('31-cible-effacer-historique', 'card');
    // « Annuler » ne vide rien.
    await button('Effacer l’historique').click();
    await dialog().getByText(/L’historique de la carte repart de zéro/).waitFor();
    await dialog().getByText(/Ce que Grist garde de son côté/).waitFor();
    await dialogButton('Annuler').click();
    await dialog().waitFor({ state: 'detached' });
    assert.ok((await journalRows()).some(r => r.Sync_Avant), 'annulé : l\'avant est toujours là');
    // Confirmé : le journal est vidé de l'avant et des valeurs supprimées, la carte repart de zéro.
    await button('Effacer l’historique').click();
    await dialogButton('Effacer').click();
    await widget().getByText(/Historique effacé \(journal nettoyé\s:\s2 valeurs d’avant, 1 ligne supprimée\)/).waitFor({ timeout: 60000 });
    assert.ok((await journalRows()).every(r => !r.Sync_Avant), 'plus aucun avant dans le journal');
    assert.ok(!(await journalRows()).find(r => r.Sync_Etat === 'suppression').Synchro_Donnees, 'valeurs de la ligne supprimée vidées');
    assert.equal(await widget().locator('details.history .chg-item').count(), 0, 'l\'historique de la carte est vide');
    const after = await fiches();
    assert.deepEqual([after.Anna.Ville, after.Basile.Ville, Boolean(after.Céline)], ['Marseille', 'Paris', false], 'les lignes d\'ici ne changent pas');
    // La recopie continue, sans arrivée suspecte : les versions vidées gardent leur sceau.
    await applyActions(src.doc, [['UpdateRecord', 'Fiches', 2, { Ville: 'Brest' }]]);
    await waitFor(async () => (await fiches()).Basile?.Ville === 'Brest', 'modification reçue après l\'effacement', 90000);
    await openWidgetTab(dst.url, 'Recevoir');
    assert.equal(await widget().getByText('Arrivées suspectes').count(), 0, 'aucune arrivée suspecte');
    await waitFor(async () => (await journalRows()).some(r => r.Sync_Avant), 'la nouvelle modification a son avant', 30000);
    await widget().locator('details.history').waitFor();
    assert.equal(await widget().locator('details.history .chg-item').count(), 1, 'seul le changement d\'après l\'effacement figure dans l\'historique');

    // SOURCE : l'historique des envois est effacé de la note, le destinataire reste branché.
    await openWidgetTab(src.url, 'Envoyer');
    const sent = widget().locator('details.history', { hasText: 'Historique des envois' });
    await sent.locator('summary').click();
    await sent.getByText(/reçoit désormais cet export/).waitFor();
    await sent.getByRole('button', { name: 'Effacer l’historique' }).click();
    await dialog().getByText(/L’historique des envois de cet export est effacé/).waitFor();
    await dialogButton('Effacer l’historique').click();
    await widget().locator('details.history', { hasText: 'Historique des envois' }).waitFor({ state: 'detached', timeout: 60000 });
    assert.equal((await api('GET', `/docs/${src.doc}/webhooks`)).webhooks.length, 1, 'le destinataire est toujours branché');
    const sourceNote = JSON.stringify((await records(src.doc, '_grist_Tables_column')).filter(c => c.colId === 'Synchro_Export'));
    assert.ok(!/reçoit|resend|cible@|\\"who\\"/.test(sourceNote), 'rien de nominatif ne reste dans la note de la SOURCE');
    step('Effacer l\'historique : CIBLE (avant et valeurs supprimées du journal vidés, carte à zéro, recopie intacte) et SOURCE (historique des envois effacé, destinataire gardé)');
  }

  // --- « Ajouter le widget à la page de la table reçue » (carte d'une réception). La table que la réception a créée a sa propre page,
  // sans le widget : le bouton y pose une section du widget, sans l'accès accordé (Grist le demande), une seule fois. Une fois
  // l'accès accepté, ce widget-là recopie les envois suivants (un seul widget ouvert suffit pour tout le document).
  async function widgetPageSteps() {
    const src = await fichesDoc('Page SOURCE');
    const dst = await newDocWithWidget('Page CIBLE');
    await startExport(src, 'Fiches', 'Annuaire');
    const code = await plainInvitation();
    const answer = await accept(dst.doc, dst.url, code, '« Annuaire » : table Fiches.');
    await approve(answer, { url: src.url });
    const fiches = async () => Object.fromEntries((await records(dst.doc, 'Fiches')).map(r => [r.Nom, r]));
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => Object.keys(await fiches()).length === 3, 'fiches reçues', 60000);
    const customs = async () => (await records(dst.doc, '_grist_Views_section')).filter(sc => sc.parentKey === 'custom');
    const fichesView = async () => (await records(dst.doc, '_grist_Tables')).find(tb => tb.tableId === 'Fiches').primaryViewId;
    assert.equal((await customs()).length, 1, 'un seul widget au départ, sur la page Synchro');
    const add = button('Ajouter le widget à la page de Fiches');
    await add.waitFor({ timeout: 30000 });
    // Rien ne dit sinon que le bouton est nécessaire : la carte est orange (« Widget à ajouter », pas « À jour ») et un avis
    // l'explique, avec le bouton dedans.
    const card = widget().locator('article.card', { hasText: 'Annuaire' });
    const missing = card.locator('[data-widget-missing]');
    await missing.waitFor({ timeout: 30000 });
    await card.locator('.pill-pending', { hasText: 'Widget à ajouter' }).waitFor();
    assert.equal(await card.locator('.pill-ok').count(), 0, 'pas « À jour » tant que le widget n’est sur aucune table reçue');
    assert.ok(await missing.evaluate(node => node.classList.contains('msg-warn')), 'avis orange');
    await missing.getByText('Le widget n’est sur la page d’aucune table reçue').waitFor();
    await missing.getByText(/Si vous ouvrez la page de Fiches, il s’arrête et rien de nouveau n’y arrive/).waitFor();
    assert.equal(await missing.getByRole('button', { name: 'Ajouter le widget à la page de Fiches' }).count(), 1, 'le bouton est dans l’avis');
    if (process.env.SHOTS) await card.screenshot({ path: join(process.env.SHOTS, 'widget-a-ajouter.png') });
    await widget().locator('.card-actions').first().scrollIntoViewIfNeeded();
    const widgetFrame = page.frames().find(f => f.url().startsWith(WIDGET_URL));
    await widgetFrame.evaluate(() => { window.sameFrame = true; });
    // « Annuler » n'ajoute rien.
    await add.click();
    await dialog().getByText('Ajouter le widget à la page d’une table reçue').waitFor();
    await dialog().getByText(/Un seul widget ouvert suffit pour tout le document/).waitFor();
    await dialog().getByText(/Grist demandera ensuite l’accès complet pour cette nouvelle section/).waitFor();
    await dialogButton('Annuler').click();
    await dialog().waitFor({ state: 'detached' });
    assert.equal((await customs()).length, 1, 'annulé : rien n’est ajouté');
    // Confirmé : une section du widget sur la page de Fiches, sans accès accordé ; le bouton disparaît.
    await add.click();
    await dialogButton('Ajouter le widget').click();
    await widget().getByText(/Widget ajouté à la page de Fiches\. Ouvrez cette page/).waitFor({ timeout: 30000 });
    const view = await fichesView();
    const placed = (await customs()).filter(sc => sc.parentId === view);
    assert.equal(placed.length, 1, 'une section du widget sur la page de la table reçue');
    const def = JSON.parse(JSON.parse(placed[0].options).customView);
    assert.deepEqual([def.mode, def.url, def.access], ['url', WIDGET_URL, 'none'], 'même widget, accès non accordé');
    assert.equal(await add.count(), 0, 'le bouton disparaît une fois le widget sur la page');
    assert.equal(await missing.count(), 0, 'l’avis disparaît avec lui');
    await card.locator('.pill-ok', { hasText: 'À jour' }).waitFor();
    assert.equal(await card.locator('.pill-pending').count(), 0, 'la carte n’est plus orange');
    assert.ok(await widgetFrame.evaluate(() => window.sameFrame), 'ajouter une section à une autre page ne recharge pas le widget');
    assert.equal((await customs()).length, 2);

    // La personne ouvre la page de Fiches : le widget y demande l'accès complet ; elle l'accepte dans le panneau de droite.
    await page.goto(`${TEAM}/doc/${dst.doc}/p/${view}`);
    await widget().locator('.access-help').waitFor({ timeout: 30000 });
    await widget().getByText('Le widget a besoin de l’accès complet au document', { exact: false }).waitFor();
    await widget().locator('.access-help').click();
    await page.locator('.test-right-opener').click();
    await page.locator('.test-config-widget-access-accept').click();
    await widget().locator('[data-tab]').first().waitFor({ timeout: 30000 });
    await pickTab(widget(), 'Recevoir');
    await widget().locator('.card', { hasText: 'Annuaire' }).waitFor();
    assert.equal(await widget().getByRole('button', { name: /Ajouter le widget à la page/ }).count(), 0, 'sur la page de la table : plus de bouton');
    // Ce widget-là recopie : la page Synchro n'est pas ouverte, le changement de la SOURCE arrive quand même.
    await applyActions(src.doc, [['UpdateRecord', 'Fiches', 1, { Ville: 'Marseille' }]]);
    await waitFor(async () => (await fiches()).Anna?.Ville === 'Marseille', 'modification reçue par le widget de la page de la table', 90000);
    step('Ajouter le widget à la page de la table reçue : bouton sur la carte, fenêtre (annuler n\'ajoute rien), section sans accès accordé, widget non rechargé, accès accepté dans Grist puis recopie par ce widget');

    // Une réception de deux tables : la fenêtre demande laquelle, et la section arrive sur la page choisie (un seul widget suffit,
    // le bouton disparaît ensuite).
    const src2 = await newDocWithWidget('Pages SOURCE 2', [
      ['AddTable', 'Fiches', [{ id: 'Nom', type: 'Text' }]], ['BulkAddRecord', 'Fiches', [null, null], { Nom: ['Anna', 'Basile'] }],
      ['AddTable', 'Dossiers', [{ id: 'Titre', type: 'Text' }]], ['AddRecord', 'Dossiers', null, { Titre: 'Un' }],
    ]);
    const dst2 = await newDocWithWidget('Pages CIBLE 2');
    await openWidget(src2.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await button('Nouvel export').click();
    await dialog().getByRole('checkbox', { name: 'Fiches' }).check();
    await dialog().getByRole('checkbox', { name: 'Dossiers' }).check();
    await dialogButton('Continuer').click();
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill('Deux tables');
    await dialogButton('Créer l’export').click();
    const answer2 = await accept(dst2.doc, dst2.url, await plainInvitation(), '« Deux tables » : tables');
    await approve(answer2, { url: src2.url });
    await openWidgetTab(dst2.url, 'Recevoir');
    await waitFor(async () => (await records(dst2.doc, 'Fiches')).length === 2 && (await records(dst2.doc, 'Dossiers')).length === 1, 'deux tables reçues', 60000);
    const customs2 = async () => (await records(dst2.doc, '_grist_Views_section')).filter(sc => sc.parentKey === 'custom');
    const viewOf = async tableId => (await records(dst2.doc, '_grist_Tables')).find(tb => tb.tableId === tableId).primaryViewId;
    await button('Ajouter le widget à la page d’une table reçue').click();
    await dialog().getByText(/Une section du widget est ajoutée à la page de la table choisie ci-dessous/).waitFor();
    const picker = dialog().locator('.pick-button');
    const first = (await picker.textContent()).trim();
    assert.ok(['Fiches', 'Dossiers'].includes(first), `la première table est proposée : ${first}`);
    const other = first === 'Fiches' ? 'Dossiers' : 'Fiches';
    await picker.click();
    await dialog().getByRole('option', { name: other, exact: true }).click();
    await dialogButton('Ajouter le widget').click();
    await widget().getByText(new RegExp(`Widget ajouté à la page de ${other}\\. Ouvrez cette page`)).waitFor({ timeout: 30000 });
    const onPages = (await customs2()).map(sc => sc.parentId);
    assert.ok(onPages.includes(await viewOf(other)) && !onPages.includes(await viewOf(first)), `la section est sur la page de ${other}, pas sur celle de ${first}`);
    assert.equal(await widget().getByRole('button', { name: /Ajouter le widget à la page/ }).count(), 0, 'le widget est sur la page d\'une table de la réception : plus de bouton');
    step('Ajouter le widget : réception de deux tables, la fenêtre demande laquelle, la section arrive sur la page choisie, le bouton disparaît');
  }

  // --- Renforcer la sécurité d'un partage d'avant les clés de signature (V0.21) : suggestion des deux côtés, invitation qui
  // remplace l'envoi, attente de la première livraison signée, retour à l'ancien fonctionnement, puis partage renforcé.
  async function renfSteps() {
    const src = await fichesDoc('Renforcer SOURCE');
    const dst = await newDocWithWidget('Renforcer CIBLE');
    await startExport(src, 'Fiches', 'Annuaire');
    const code = await plainInvitation();
    const answer = await accept(dst.doc, dst.url, code, '« Annuaire » : table Fiches.');
    await approve(answer, { url: src.url });
    const fiches = async () => Object.fromEntries((await records(dst.doc, 'Fiches')).map(r => [r.Nom, r]));
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => Object.keys(await fiches()).length === 3, 'fiches reçues', 60000);
    // Le partage devient « d'avant les clés » : la SOURCE n'a plus de clé pour ce destinataire, la CIBLE ni clé ni sceau.
    const signRow = (await records(src.doc, 'Synchro')).find(r => r.Synchro_Type === 'signature');
    await applyActions(src.doc, [['UpdateRecord', 'Synchro', signRow.id, { Synchro_Colonnes: '' }]]);
    const columns = await records(dst.doc, '_grist_Tables_column');
    const keyColumn = columns.find(c => c.colId === 'id_sync');
    const noteColumn = columns.find(c => c.colId === 'Synchro_Ids' && JSON.parse(c.widgetOptions || '{}').syncNote?.sceau);
    const noteOf = JSON.parse(noteColumn.widgetOptions);
    const { sceau, pub, pubSource, ...oldNote } = noteOf.syncNote;
    await applyActions(dst.doc, [['UpdateRecord', '_grist_Tables_column', keyColumn.id, { widgetOptions: '' }],
      ['UpdateRecord', '_grist_Tables_column', noteColumn.id, { widgetOptions: JSON.stringify({ ...noteOf, syncNote: oldNote }) }]]);
    await applyActions(src.doc, [['UpdateRecord', 'Fiches', 1, { Ville: 'Brest' }]]);
    await waitFor(async () => (await fiches()).Anna?.Ville === 'Brest', 'envoi sans signature reçu comme avant', 90000);

    // Suggestion des deux côtés, rien d'alarmant.
    await openWidgetTab(src.url, 'Envoyer');
    await widget().locator('[data-renf="suggest"]').waitFor({ timeout: 60000 });
    await widget().getByText('Renforcer la sécurité (1)').waitFor();
    assert.equal(await widget().locator('.msg-warn, .msg-err').count(), 0, 'la suggestion n\'est ni un avertissement ni une erreur');
    await openWidgetTab(dst.url, 'Recevoir');
    await widget().locator('[data-renf="suggest"]').waitFor({ timeout: 60000 });
    await widget().getByText('Rien ne s’arrête et rien n’est imposé').waitFor();
    await shot('32-renforcer-cible-suggestion', 'card');

    // SOURCE : « Renforcer la sécurité » prépare l'invitation qui remplace l'envoi.
    await openWidgetTab(src.url, 'Envoyer');
    const oldHooks = (await api('GET', `/docs/${src.doc}/webhooks`)).webhooks.map(h => h.id);
    await button('Renforcer la sécurité').click();
    await dialog().getByText('Cette invitation remplace l’ancien envoi').waitFor();
    const newCode = await dialog().locator('textarea.code').first().inputValue();
    await dialogButton('Plus tard').click();
    await widget().getByText(/Renforcement de [\s\S]*invitation du/).waitFor();
    await widget().getByText('Renforcement : attend sa réponse').waitFor();
    assert.deepEqual((await api('GET', `/docs/${src.doc}/webhooks`)).webhooks.map(h => h.id), oldHooks, 'l\'ancien envoi continue en attendant');

    // CIBLE : coller le nouveau code reprend la même réception ; l'ancien envoi reste accepté.
    const reinforce = async () => {
      await openWidgetTab(dst.url, 'Recevoir');
      await button('Accepter une invitation').click();
      await dialog().locator('textarea.code').first().fill(newCode);
      await dialogButton('Continuer').click();
      await dialog().getByText(/n’avait pas encore de clé de signature/).waitFor();
      await dialogButton('Renforcer la sécurité').click();
      const forms = await publishedForms(dst.doc);
      const reply = await testLink('Lien du formulaire', await formLink(dst.doc, forms[0]), 'Le lien fonctionne');
      shownControl = await dialog().locator('.control-code strong').first().textContent();
      await dialogButton('Fermer').click();
      return reply;
    };
    await reinforce();
    await widget().locator('[data-renf="pending"]').waitFor({ timeout: 60000 });
    await widget().getByText(/Les envois de la SOURCE continuent d’arriver comme avant/).waitFor();
    await shot('33-renforcer-cible-en-cours', 'card');
    await applyActions(src.doc, [['UpdateRecord', 'Fiches', 2, { Ville: 'Lille' }]]);
    await waitFor(async () => (await fiches()).Basile?.Ville === 'Lille', 'ancien envoi accepté pendant l\'attente', 90000);

    // Retour à l'ancien fonctionnement : la CIBLE redevient comme avant, l'invitation reste valable ; on recommence.
    await button('Revenir à l’ancien fonctionnement').click();
    await dialog().getByText(/redevient telle qu’avant/).waitFor();
    await dialogButton('Revenir à l’ancien fonctionnement').click();
    await widget().locator('[data-renf="suggest"]').waitFor({ timeout: 60000 });
    const reply = await reinforce();
    await widget().locator('[data-renf="pending"]').waitFor({ timeout: 60000 });

    // SOURCE : approuver la réponse remplace l'envoi (un webhook neuf), puis l'envoi de contrôle part.
    await openWidget(src.url);
    await button('Coller la réponse').click();
    await dialog().locator('textarea.code').first().fill(reply);
    await dialogButton('Vérifier').click();
    await dialog().getByText(env.email).waitFor();
    assert.equal(await dialog().locator('.control-code strong').textContent(), shownControl, 'même code de contrôle des deux côtés');
    await shot('34-renforcer-source-approuver', 'modal');
    await dialogButton('Approuver et brancher').click();
    await dialog().getByText('Nouvel envoi branché').waitFor();
    await dialog().getByText(/Envoi de contrôle terminé|en attente|déjà en cours|Envoi en file/).waitFor({ timeout: 120000 });
    await dialogButton('Fermer').click();
    await dialog().waitFor({ state: 'detached' });
    const hooks = (await api('GET', `/docs/${src.doc}/webhooks`)).webhooks.map(h => h.id);
    assert.equal(hooks.length, 1, 'un seul envoi : l\'ancien est remplacé');
    assert.ok(!oldHooks.includes(hooks[0]), 'le webhook est neuf');
    assert.ok(Object.keys(JSON.parse((await records(src.doc, 'Synchro')).find(r => r.Synchro_Type === 'signature').Synchro_Colonnes || '{}')).includes(String(hooks[0])), 'la clé du nouvel envoi est notée');

    // La première livraison signée finit le renforcement, sans rien perdre.
    await applyActions(src.doc, [['UpdateRecord', 'Fiches', 3, { Ville: 'Metz' }]]);
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => (await fiches()).Céline?.Ville === 'Metz', 'livraison signée reçue', 120000);
    await widget().locator('[data-renf="done"]').waitFor({ timeout: 120000 });
    await widget().getByText(/Partage renforcé le/).waitFor();
    assert.equal(await widget().getByText('Arrivées suspectes').count(), 0, 'aucune arrivée suspecte');
    await openWidgetTab(src.url, 'Envoyer');
    await widget().locator('[data-renf="suggest"]').waitFor({ state: 'detached' });
    const history = widget().locator('details.history', { hasText: 'Historique des envois' });
    await history.locator('summary').click();
    await history.getByText(/sécurité renforcée/).waitFor();
    step('Renforcer la sécurité : suggestion des deux côtés, invitation qui remplace l\'envoi, ancien envoi accepté pendant l\'attente, retour à l\'ancien fonctionnement, approbation, première livraison signée, partage renforcé');
  }

  // --- Fenêtre des nouveautés : une fois par version, deux écrans, « Plus tard » la ferme pour de bon.
  async function newsSteps() {
    newsOn = true;
    try {
      const doc = await fichesDoc('Nouveautés');
      await startExport(doc, 'Fiches', 'Annuaire');
      await plainInvitation();
      await rulesSettled(doc.doc);
      await openWidget(doc.url);
      await widget().getByRole('heading', { name: 'Sync+ : les nouveautés' }).waitFor({ timeout: 30000 });
      await widget().getByRole('button', { name: 'Pièces jointes', exact: true }).click();
      await widget().getByText(/une seule fois par destinataire/).waitFor();
      await shot('35-nouveautes', 'modal');
      await dialogButton('Continuer').click();
      await dialog().getByText('Vos partages actuels continuent de fonctionner').waitFor();
      await dialog().getByText(/1 export/).waitFor();
      await shot('36-nouveautes-partages', 'modal');
      await dialogButton('Plus tard').click();
      await dialog().waitFor({ state: 'detached' });
      await openWidget(doc.url); // déjà vue : elle ne revient pas
      await widget().locator('.topbar').waitFor();
      await page.waitForTimeout(3000);
      assert.equal(await dialog().count(), 0, 'les nouveautés ne reviennent pas');
    } finally {
      newsOn = false;
    }
    step('Nouveautés : une fois par version, deux écrans, ne revient pas');
  }

  // --- Export filtré : la liste des choix d'une colonne Choix ne part pas (elle montrerait des
  // valeurs de lignes que le filtre retient pas) ; la CIBLE n'apprend que les valeurs qu'elle reçoit.
  async function choicesSteps() {
    const etat = { choices: ['Ouvert', 'Clos', 'Secret'], choiceOptions: { Clos: { fillColor: '#FF0000' } } };
    const src = await newDocWithWidget('Choix SOURCE', [
      ['AddTable', 'Dossiers', [{ id: 'Nom', type: 'Text' }, { id: 'Etat', type: 'Choice', widgetOptions: JSON.stringify(etat) }]],
      ['BulkAddRecord', 'Dossiers', [null, null, null], { Nom: ['Un', 'Deux', 'Trois'], Etat: ['Ouvert', 'Clos', 'Secret'] }],
    ]);
    const dst = await newDocWithWidget('Choix CIBLE');
    await startExport(src, 'Dossiers', 'Annuaire', async () => {
      const block = dialog().locator('.table-block').filter({ has: widget().locator('h3', { hasText: /^Dossiers$/ }) });
      await block.getByRole('button', { name: 'Filtrer les lignes', exact: true }).click();
      await block.getByRole('button', { name: 'Ajouter une condition', exact: true }).click();
      const values = block.getByRole('group', { name: 'Valeur de la condition 1' });
      await values.getByRole('checkbox', { name: /^Un/ }).check();
      await values.getByRole('checkbox', { name: /^Deux/ }).check();
    });
    const code = await plainInvitation();
    await approve(await accept(dst.doc, dst.url, code, '« Annuaire » : table Dossiers.'), { url: src.url });
    await openWidget(dst.url);
    const dossiers = async () => (await records(dst.doc, 'Dossiers')).map(r => r.Nom).sort().join();
    await waitFor(async () => (await dossiers()) === 'Deux,Un', 'lignes du filtre reçues', 60000);
    const etatOf = async () => JSON.parse((await records(dst.doc, '_grist_Tables_column')).find(c => c.colId === 'Etat').widgetOptions || '{}');
    await waitFor(async () => (await etatOf()).choices?.length === 2, 'choix reçus', 60000);
    const received = await etatOf();
    assert.deepEqual([...received.choices].sort(), ['Clos', 'Ouvert'], 'seules les valeurs reçues');
    assert.equal(received.choiceOptions, undefined, 'les couleurs de la liste ne partent pas');
    const sent = (await records(src.doc, 'Synchro')).map(r => r.Synchro_Colonnes || '').join();
    assert.ok(!sent.includes('Secret') && !sent.includes('choices'), 'la SOURCE n\'envoie pas sa liste de choix');
    const journal = (await records(dst.doc, '_grist_Tables')).find(tb => tb.tableId.startsWith('Journal_'));
    const note = JSON.stringify(syncNoteOf((await records(dst.doc, '_grist_Tables_column')).find(c => c.colId === 'Synchro_Ids' && c.parentId === journal.id)));
    assert.ok(!note.includes('Secret'), 'la note du journal ne garde aucune liste');
    // Une ligne qui entre dans le filtre apporte sa valeur, et seulement elle.
    await applyActions(src.doc, [['UpdateRecord', 'Dossiers', 3, { Nom: 'Un' }]]);
    await waitFor(async () => (await etatOf()).choices?.includes('Secret'), 'valeur d\'une ligne entrée dans le filtre reprise', 90000);
    step('Export filtré : la liste des choix ne part pas, la CIBLE reprend les valeurs reçues (une ligne entrée dans le filtre apporte la sienne)');
  }
  // --- Types de colonnes : chaque type que Grist propose traverse l'export et arrive chez la CIBLE avec son type et sa valeur.
  // Un Blob ne part pas (Grist n'écrit pas d'octets par ses API : seule une formule Python en fabrique) ; l'assistant le dit,
  // sans case à cocher, et l'invitation reste lisible (avant, elle ne l'était plus).
  async function typesSteps() {
    const jour = Date.UTC(2026, 10, 12) / 1000;
    const instant = Date.UTC(2026, 10, 12, 8, 30, 15) / 1000;
    const src = await newDocWithWidget('Types SOURCE', [
      ['AddTable', 'Villes', [{ id: 'Nom', type: 'Text' }]],
      ['AddRecord', 'Villes', null, { Nom: 'Lyon' }],
      ['AddTable', 'Fiches', [
        { id: 'Nom', type: 'Text' }, { id: 'Montant', type: 'Numeric' }, { id: 'Entier', type: 'Int' }, { id: 'Actif', type: 'Bool' },
        { id: 'Jour', type: 'Date' }, { id: 'Instant', type: 'DateTime:Europe/Paris' },
        { id: 'Etat', type: 'Choice', widgetOptions: JSON.stringify({ choices: ['A', 'B'] }) },
        { id: 'Multi', type: 'ChoiceList', widgetOptions: JSON.stringify({ choices: ['A', 'B'] }) },
        { id: 'Rang', type: 'PositionNumber' }, { id: 'Libre', type: 'Any' },
        { id: 'Binaire', type: 'Blob', isFormula: true, formula: 'b"octets"' },
      ]],
      ['AddRecord', 'Fiches', null, { Nom: 'Alice', Montant: 12.5, Entier: 7, Actif: true, Jour: jour, Instant: instant, Etat: 'B', Multi: ['L', 'A', 'B'], Libre: 'texte libre' }],
    ]);
    const dst = await newDocWithWidget('Types CIBLE');
    await startExport(src, 'Fiches', 'Types', async () => {
      await dialog().getByText(/Ne part pas \(Binaire/).waitFor({ timeout: 30000 });
      const text = await dialog().innerText();
      assert.match(text, /Ne part pas \(Binaire\s·\sBinaire \(Blob\)\)/, 'le Blob est dit, avec son type');
      assert.equal(await dialog().getByRole('checkbox', { name: 'Binaire' }).count(), 0, 'et n\'a pas de case');
      await dialogButton('Choisir les colonnes').click();
      assert.equal(await dialog().getByRole('checkbox', { name: 'Binaire' }).count(), 0, 'ni dans la liste des colonnes');
      assert.ok(await dialog().getByRole('checkbox', { name: /^Rang/ }).isChecked(), 'un rang part comme un nombre');
    });
    const code = await plainInvitation();
    const answer = await accept(dst.doc, dst.url, code, '« Types » : table Fiches.');
    await approve(answer, { url: src.url });
    await openWidget(dst.url);
    await waitFor(async () => (await records(dst.doc, 'Fiches')).length === 1, 'ligne reçue', 90000);
    const types = Object.fromEntries((await records(dst.doc, '_grist_Tables_column')).filter(c => c.colId && !c.colId.startsWith('gristHelper_') && c.type).map(c => [c.colId, c.type]));
    const [row] = await records(dst.doc, 'Fiches');
    const [origin] = await records(src.doc, 'Fiches');
    assert.deepEqual(['Nom', 'Montant', 'Entier', 'Actif', 'Jour', 'Instant', 'Etat', 'Multi', 'Rang', 'Libre'].map(c => [c, types[c]]), [
      ['Nom', 'Text'], ['Montant', 'Numeric'], ['Entier', 'Int'], ['Actif', 'Bool'], ['Jour', 'Date'], ['Instant', 'DateTime:Europe/Paris'],
      ['Etat', 'Choice'], ['Multi', 'ChoiceList'], ['Rang', 'Numeric'], ['Libre', 'Any']]);
    assert.equal(row.Binaire, undefined, 'pas de colonne Binaire chez la CIBLE');
    assert.deepEqual([row.Nom, row.Montant, row.Entier, row.Actif, row.Jour, row.Instant, row.Etat, row.Multi, row.Rang, row.Libre],
      ['Alice', 12.5, 7, true, jour, instant, 'B', ['L', 'A', 'B'], origin.Rang, 'texte libre'], 'Grist numérote lui-même un rang : la CIBLE reçoit celui de la SOURCE');
    // Cellules vides, valeurs négatives, case décochée, date effacée, autre type de valeur dans une colonne Quelconque : la CIBLE
    // reçoit chaque cellule telle que la SOURCE la montre, à l'ajout comme à la modification.
    await applyActions(src.doc, [['AddRecord', 'Fiches', null, { Nom: 'Bob' }],
      ['UpdateRecord', 'Fiches', 1, { Montant: -0.5, Entier: -3, Actif: false, Jour: null, Instant: null, Etat: 'A', Multi: ['L', 'B'], Libre: 42 }]]);
    const COLS = ['Nom', 'Montant', 'Entier', 'Actif', 'Jour', 'Instant', 'Etat', 'Multi', 'Libre'];
    const shown = async doc => (await records(doc, 'Fiches')).sort((a, b) => a.Nom.localeCompare(b.Nom)).map(r => COLS.map(c => r[c]));
    await waitFor(async () => (await records(dst.doc, 'Fiches')).length === 2 && JSON.stringify(await shown(dst.doc)) === JSON.stringify(await shown(src.doc)), 'ajout et modification reçus', 90000);
    assert.deepEqual((await shown(dst.doc))[0], ['Alice', -0.5, -3, false, null, null, 'A', ['L', 'B'], 42]);
    step('Types : chaque type traverse l\'export avec son type et sa valeur (dates, choix, rang) ; le Blob est dit « ne part pas », sans case, et l\'invitation reste lisible');
  }
  // --- Changements de structure : une réception qui demande l'accord (case décochée d'emblée) ne crée pas la colonne que la SOURCE
  // ajoute à l'export, la propose avec son détail ; « Appliquer » la crée et la remplit ; une colonne retirée de l'export est dite ;
  // « Appliquer, puis traiter automatiquement » ne demande plus la suivante ; une réception d'avant (sans choix) crée toute seule.
  async function structureSteps() {
    const src = await fichesDoc('Structure SOURCE');
    const dst = await newDocWithWidget('Structure CIBLE');
    const columnsHere = async () => (await api('GET', `/docs/${dst.doc}/tables/Fiches/columns`)).columns.map(c => c.id).sort();
    const ficheNotice = () => widget().locator('.structure');
    await startExport(src, 'Fiches', 'Annuaire');
    const code = await plainInvitation();
    await approve(await accept(dst.doc, dst.url, code, '« Annuaire » : table Fiches.', [], { ask: true }), { url: src.url });
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => (await records(dst.doc, 'Fiches')).length === 3, 'lignes reçues', 90000);
    assert.equal(await ficheNotice().count(), 0, 'rien à décider');
    // Une colonne de plus à l'export : proposée, pas créée.
    const addColumn = async (id, values, reopen) => {
      await applyActions(src.doc, [['AddColumn', 'Fiches', id, { type: 'Text' }], ['BulkUpdateRecord', 'Fiches', [1, 2, 3], { [id]: values }]]);
      await openWidget(src.url);
      await button('Modifier').click();
      await dialogButton('Continuer').click();
      await dialog().getByRole('checkbox', { name: id }).first().check();
      await dialogButton('Continuer').click();
      await dialogButton('Enregistrer').click();
      await dialog().getByText(/Enregistré\s:/).waitFor();
      await dialogButton('Fermer').click();
      await reopen();
    };
    const toCible = () => openWidgetTab(dst.url, 'Recevoir');
    await addColumn('Pays', ['France', 'France', 'Belgique'], toCible);
    await ficheNotice().getByText(/La SOURCE a ajouté 1 colonne à l’export/).waitFor({ timeout: 90000 });
    assert.match(await ficheNotice().innerText(), /Fiches → Fiches\s:\sla colonne\s«\sPays\s»\s\(Texte\) serait créée sous le nom\s«\sPays\s»/);
    assert.deepEqual(await columnsHere(), ['Nom', 'Ville', 'id_sync'].sort(), 'rien n\'est créé sans accord');
    if (process.env.SHOTS) await widget().locator('article.card').first().screenshot({ path: join(process.env.SHOTS, 'structure-1-propose.png') });
    await shot('37-cible-colonnes-proposees', 'card');
    // Une ligne de la SOURCE continue d'arriver pendant l'attente.
    await applyActions(src.doc, [['AddRecord', 'Fiches', null, { Nom: 'Denis', Ville: 'Metz', Pays: 'France' }]]);
    await waitFor(async () => (await records(dst.doc, 'Fiches')).some(r => r.Nom === 'Denis'), 'ligne reçue pendant l\'attente', 90000);
    assert.ok(!(await columnsHere()).includes('Pays'), 'toujours rien de créé');
    await ficheNotice().getByRole('button', { name: 'Appliquer', exact: true }).click();
    await waitFor(async () => (await records(dst.doc, 'Fiches')).every(r => r.Pays), 'colonne créée et remplie pour toutes les lignes', 90000);
    assert.deepEqual((await records(dst.doc, 'Fiches')).map(r => `${r.Nom}:${r.Pays}`).sort(), ['Anna:France', 'Basile:France', 'Céline:Belgique', 'Denis:France']);
    await waitFor(async () => (await ficheNotice().count()) === 0, 'avis retiré', 30000);
    step('Structure : la colonne ajoutée à l\'export est proposée avec son détail sans rien créer ; les lignes arrivent ; « Appliquer » la crée et la remplit');

    // Une colonne retirée de l'export : dite, une fois, jusqu'à « Compris ».
    await openWidget(src.url);
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    await dialogButton('Choisir les colonnes').click();
    await dialog().getByRole('checkbox', { name: 'Ville' }).first().uncheck();
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/Enregistré\s:/).waitFor();
    await dialogButton('Fermer').click();
    await toCible();
    await ficheNotice().getByText(/La SOURCE a changé son export/).waitFor({ timeout: 90000 });
    assert.match(await ficheNotice().innerText(), /la SOURCE n’envoie plus la colonne\s«\sVille\s»/);
    await ficheNotice().getByRole('button', { name: 'Compris', exact: true }).click();
    await waitFor(async () => (await ficheNotice().count()) === 0, 'avis vu', 30000);
    assert.ok((await columnsHere()).includes('Ville'), 'la colonne reste ici');
    step('Structure : une colonne que la SOURCE n\'envoie plus est dite, elle reste ici, « Compris » ne la répète plus');

    // « Appliquer, puis traiter automatiquement » : la colonne suivante est créée sans demander.
    await addColumn('Age', ['30', '40', '50'], toCible);
    await ficheNotice().getByText(/La SOURCE a ajouté 1 colonne à l’export/).waitFor({ timeout: 90000 });
    await ficheNotice().getByRole('button', { name: 'Appliquer, puis traiter automatiquement' }).click();
    await widget().getByRole('dialog', { name: 'Traiter automatiquement à partir de maintenant ?' }).getByRole('button', { name: 'Appliquer et traiter automatiquement' }).click();
    await waitFor(async () => (await records(dst.doc, 'Fiches')).filter(r => r.Age).length === 4 - 1, 'colonne Age créée et remplie', 90000);
    await addColumn('Rue', ['a', 'b', 'c'], toCible);
    await waitFor(async () => (await columnsHere()).includes('Rue'), 'colonne Rue créée sans demander', 90000);
    assert.equal(await ficheNotice().count(), 0, 'plus d\'avis');
    await button('Options').click();
    assert.ok(await dialog().getByRole('checkbox', { name: AUTO_BOX }).isChecked(), 'le réglage est devenu « automatique »');
    await dialogButton('Annuler').click();
    step('Structure : « Appliquer, puis traiter automatiquement » (avec confirmation) ne demande plus ; la colonne suivante est créée seule et « Options » le montre');
  }
  // --- Table déjà remplie : la CIBLE choisit une table qui existe, avec ses lignes. Le type de chaque colonne d'ici qui ne convient pas est
  // dit sous le champ et à confirmer ; une réception qui demande l'accord n'écrit rien avant d'avoir montré ce qui arriverait aux lignes déjà
  // là (ajoutées, rattachées, valeurs remplacées, lignes qui ne bougent pas) ; « Appliquer » le fait ; ensuite les modifications passent seules.
  async function adoptSteps() {
    const src = await fichesDoc('Adopte SOURCE');
    const dst = await newDocWithWidget('Adopte CIBLE', [
      ['AddTable', 'Annuaire', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Numeric' }]],
      ['BulkAddRecord', 'Annuaire', [null, null], { Nom: ['Anna', 'Zoé'], Ville: [12, 7] }],
    ]);
    await startExport(src, 'Fiches', 'Annuaire');
    const code = await plainInvitation();
    await pasteInvitation(dst.url, code);
    await dialog().getByText('« Annuaire » : table Fiches.').waitFor();
    await dialog().getByText('Options avancées').click();
    assert.ok(!(await dialog().getByRole('checkbox', { name: AUTO_BOX }).isChecked()), 'la réception demande l\'accord, d\'emblée');
    await pick('Fiches', 'Annuaire');
    await dialogButton('Continuer').click();
    await dialog().getByText(/Choisissez la colonne qui reçoit chaque colonne envoyée/).waitFor();
    await dialog().getByText(/Ville\s→\sVille\s:\sla SOURCE envoie le type Texte, la colonne d’ici est de type Numérique/).waitFor();
    await pick('Rattacher les lignes déjà là par la colonne', 'Nom');
    if (process.env.SHOTS) await dialog().screenshot({ path: join(process.env.SHOTS, 'adopte-1-types.png') });
    await dialogButton('Créer les tables').click();
    await dialog().getByText('Des types de colonnes ne correspondent pas').waitFor();
    await dialogButton('Continuer quand même').click();
    const forms = await waitFor(async () => { const f = await publishedForms(dst.doc); return f.length === 1 && f; }, 'formulaire publié');
    await openWidget(dst.url);
    const reply = await testLink('Lien du formulaire', await formLink(dst.doc, forms[0]), 'Le lien fonctionne');
    shownControl = await dialog().locator('.control-code strong').first().textContent();
    await dialogButton('Fermer').click();
    await approve(reply, { url: src.url });
    // Les lignes arrivent dans le journal, la table d'ici ne bouge pas, l'aperçu le dit.
    await openWidgetTab(dst.url, 'Recevoir');
    const preview = widget().locator('[data-structure="adopt"]');
    await preview.waitFor({ timeout: 90000 });
    const said = await preview.innerText();
    assert.match(said, /«\sAnnuaire\s»\scontient déjà des lignes\s:\srien n’y est encore écrit/);
    for (const part of [/2 lignes seront ajoutées/, /1 ligne d’ici sera rattachée à celles de la SOURCE par la colonne\s«\sNom\s»/, /1 valeur d’ici sera remplacée/, /1 ligne d’ici ne bouge pas/,
      /«\sAnna\s»\s:\sVille passe de\s«\s12\s»\sà\s«\sLyon\s»/]) assert.match(said, part);
    const rows = await records(dst.doc, 'Annuaire');
    assert.match(await widget().locator('article.card').first().innerText(), /À valider/, 'la carte attend l\'accord, elle n\'est pas « À jour »');
    assert.deepEqual(rows.map(r => `${r.Nom}:${r.Ville}`).sort(), ['Anna:12', 'Zoé:7'], 'rien n\'est écrit avant l\'accord');
    assert.ok(rows.every(r => !r.id_sync), 'aucune clé posée');
    if (process.env.SHOTS) await widget().locator('article.card').first().screenshot({ path: join(process.env.SHOTS, 'adopte-2-apercu.png') });
    await shot('38-cible-apercu-adoption', 'card');
    step('Table déjà remplie : le type qui ne convient pas est dit et confirmé ; rien n\'est écrit avant l\'accord, l\'aperçu dit lignes ajoutées, rattachées, valeurs remplacées, lignes qui ne bougent pas');
    await preview.getByRole('button', { name: 'Appliquer', exact: true }).click();
    await waitFor(async () => (await records(dst.doc, 'Annuaire')).length === 4, 'lignes ajoutées après l\'accord', 90000);
    const after = await records(dst.doc, 'Annuaire');
    assert.deepEqual(after.map(r => r.Nom).sort(), ['Anna', 'Basile', 'Céline', 'Zoé']);
    assert.equal(after.find(r => r.Nom === 'Anna').Ville, 'Lyon', 'la valeur d\'ici est remplacée par celle de la SOURCE');
    assert.ok(after.find(r => r.Nom === 'Anna').id_sync, 'la ligne d\'ici rattachée a pris la clé');
    assert.ok(!after.find(r => r.Nom === 'Zoé').id_sync, 'la ligne d\'ici sans pendant ne bouge pas');
    await waitFor(async () => (await preview.count()) === 0, 'aperçu retiré', 30000);
    // La table reçue a sa page sans le widget : la carte est à jour mais orange (« Widget à ajouter », voir widgetPageSteps).
    assert.match(await widget().locator('article.card').first().innerText(), /À jour|Widget à ajouter/);
    await applyActions(src.doc, [['UpdateRecord', 'Fiches', 2, { Ville: 'Metz' }]]);
    await waitFor(async () => (await records(dst.doc, 'Annuaire')).some(r => r.Nom === 'Basile' && r.Ville === 'Metz'), 'modification reçue sans nouvel aperçu', 90000);
    assert.equal(await widget().locator('[data-structure="adopt"]').count(), 0, 'plus d\'aperçu');
    step('Table déjà remplie : « Appliquer » rattache, ajoute et remplace, laisse les autres lignes ; les modifications suivantes passent seules');
  }
  // --- SOURCE : une colonne ajoutée à une table de l'export ne part pas toute seule ; la carte le dit, avec « Envoyer ces colonnes » (l'export
  // est enregistré avec elles, la table renvoyée) ou « Ne pas les envoyer » (elles sont connues, plus rien n'est dit). Une colonne
  // renommée, d'un autre type, est dite par son nom ; la case « Envoyer aussi les colonnes que j'ajouterai » les envoie ensuite seule.
  async function newColumnsSteps() {
    const src = await fichesDoc('Colonnes ajoutées SOURCE');
    const dst = await newDocWithWidget('Colonnes ajoutées CIBLE');
    const columnsHere = async () => (await api('GET', `/docs/${dst.doc}/tables/Fiches/columns`)).columns.map(c => c.id).sort();
    const fresh = () => widget().locator('[data-new-columns]');
    const drift = () => widget().locator('[data-drift]');
    await startExport(src, 'Fiches', 'Annuaire');
    await approve(await accept(dst.doc, dst.url, await plainInvitation(), '« Annuaire » : table Fiches.'), { url: src.url });
    // La CIBLE recopie tant que sa page est ouverte : l'essai y passe pour attendre, puis revient à la SOURCE.
    const toCible = () => openWidgetTab(dst.url, 'Recevoir');
    await toCible();
    await waitFor(async () => (await records(dst.doc, 'Fiches')).length === 3, 'lignes reçues', 90000);
    await openWidgetTab(src.url, 'Envoyer');
    await widget().locator('[data-export]').first().waitFor();
    assert.equal(await fresh().count(), 0, 'rien n\'a changé : aucun avis');
    // Une colonne de plus : dite, pas envoyée.
    await applyActions(src.doc, [['AddColumn', 'Fiches', 'Population', { type: 'Int' }], ['BulkUpdateRecord', 'Fiches', [1, 2, 3], { Population: [10, 20, 30] }]]);
    await openWidgetTab(src.url, 'Envoyer');
    await fresh().getByText(/1 colonne ne part pas/).waitFor({ timeout: 30000 });
    assert.match(await fresh().innerText(), /Fiches\s:\sPopulation/);
    if (process.env.SHOTS) await widget().locator('article.card').first().screenshot({ path: join(process.env.SHOTS, 'colonnes-1-avis.png') });
    await shot('39-source-colonnes-ajoutees', 'card');
    await page.waitForTimeout(3000);
    assert.deepEqual(await columnsHere(), ['Nom', 'Ville', 'id_sync'].sort(), 'rien n\'est parti');
    // « Ne pas les envoyer » : connue, plus rien n'est dit, même après un rechargement.
    await fresh().getByRole('button', { name: 'Ne pas les envoyer', exact: true }).click();
    await waitFor(async () => (await fresh().count()) === 0, 'avis retiré', 30000);
    await openWidgetTab(src.url, 'Envoyer');
    await widget().locator('[data-export]').first().waitFor();
    assert.equal(await fresh().count(), 0, 'toujours rien à dire');
    assert.ok(!(await columnsHere()).includes('Population'), 'la colonne ignorée ne part pas');
    // Une autre colonne : seule celle-ci est dite ; « Envoyer ces colonnes » l'envoie.
    await applyActions(src.doc, [['AddColumn', 'Fiches', 'Region', { type: 'Text' }], ['BulkUpdateRecord', 'Fiches', [1, 2, 3], { Region: ['Rhône', 'Île-de-France', 'Loire'] }]]);
    await openWidgetTab(src.url, 'Envoyer');
    await fresh().getByText(/1 colonne ne part pas/).waitFor({ timeout: 30000 });
    assert.match(await fresh().innerText(), /Fiches\s:\sRegion/);
    assert.ok(!/Population/.test(await fresh().innerText()), 'la colonne ignorée n\'est plus citée');
    await fresh().getByRole('button', { name: 'Envoyer ces colonnes', exact: true }).click();
    await waitFor(async () => (await fresh().count()) === 0, 'avis retiré après l\'envoi', 60000);
    await toCible();
    await waitFor(async () => { const rows = await records(dst.doc, 'Fiches'); return rows.length === 3 && rows.every(r => r.Region); }, 'colonne envoyée reçue et remplie', 90000);
    assert.deepEqual((await records(dst.doc, 'Fiches')).map(r => `${r.Nom}:${r.Region}`).sort(), ['Anna:Rhône', 'Basile:Île-de-France', 'Céline:Loire']);
    step('SOURCE : une colonne ajoutée est dite et ne part pas ; « Ne pas les envoyer » la range (rien de plus dit) ; « Envoyer ces colonnes » l\'envoie et la CIBLE la reçoit');
    // Colonne renommée (son seul pendant du même type est cité), autre type : dits par leur nom.
    await applyActions(src.doc, [['RenameColumn', 'Fiches', 'Ville', 'Commune'], ['ModifyColumn', 'Fiches', 'Region', { type: 'Int' }]]);
    await openWidgetTab(src.url, 'Envoyer');
    await drift().getByText(/2 colonnes ont changé depuis l’export/).waitFor({ timeout: 30000 });
    const said = await drift().innerText();
    assert.match(said, /Fiches\s:\sla colonne\s«\sVille\s»\sn’existe plus\s;\s«\sCommune\s»\sest du même type, elle a sans doute été renommée/);
    assert.match(said, /Fiches\s:\sla colonne\s«\sRegion\s»\sest passée du type Texte au type Entier/);
    if (process.env.SHOTS) await widget().locator('article.card').first().screenshot({ path: join(process.env.SHOTS, 'colonnes-2-changees.png') });
    // « Modifier » remet l'export d'accord (Commune au lieu de Ville) et pose la case : les colonnes ajoutées partent ensuite seules.
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    await dialog().getByRole('checkbox', { name: 'Commune' }).first().check();
    const auto = dialog().getByRole('checkbox', { name: 'Envoyer aussi les colonnes que j’ajouterai à ces tables' });
    assert.ok(!(await auto.isChecked()), 'décochée d\'emblée : une colonne ajoutée ne part pas sans accord');
    await auto.check();
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/Enregistré\s:/).waitFor({ timeout: 90000 });
    await dialogButton('Fermer').click();
    await waitFor(async () => (await drift().count()) === 0, 'plus aucune colonne changée', 30000);
    await applyActions(src.doc, [['AddColumn', 'Fiches', 'Note', { type: 'Text' }], ['BulkUpdateRecord', 'Fiches', [1, 2, 3], { Note: ['n-a', 'n-b', 'n-c'] }]]);
    await openWidgetTab(src.url, 'Envoyer');
    // Le widget de la SOURCE l'envoie à l'ouverture de l'onglet : les valeurs sont dans le journal de la CIBLE (le renvoi est fini) avant qu'on y passe.
    await waitFor(async () => { const journal = JSON.stringify(await records(dst.doc, 'Journal_Annuaire')); return ['n-a', 'n-b', 'n-c'].every(v => journal.includes(v)); }, 'colonne ajoutée envoyée seule', 90000);
    await toCible();
    await waitFor(async () => (await columnsHere()).includes('Note'), 'colonne ajoutée créée chez la CIBLE', 90000);
    await waitFor(async () => (await records(dst.doc, 'Fiches')).every(r => r.Note), 'colonne envoyée seule remplie', 90000);
    assert.equal(await fresh().count(), 0, 'rien n\'est dit : elle est partie');
    step('SOURCE : colonne renommée et colonne d\'un autre type dites par leur nom ; la case « Envoyer aussi les colonnes que j\'ajouterai » envoie la suivante seule');
  }
  // --- Références conservées, choix par colonne (0.27) : une colonne Référence vers une autre table de l'export
  // devient une vraie Référence chez le destinataire (elle affiche la même colonne et suit une ville renommée) ;
  // une Liste de références vers une table hors de l'export, dont la personne garde le lien, ajoute cette table
  // (avec sa seule colonne affichée) et arrive en vraie Liste de références ; une ligne qui cite une ligne arrivée
  // en même temps (la table vise elle-même) est complétée au passage suivant ; « Valeurs seulement » rend le texte ;
  // une colonne restée du texte parce qu'elle était remplie se refait d'un clic (« Refaire les références »).
  async function linksSteps() {
    const src = await newDocWithWidget('Liens SOURCE', [
      ['AddTable', 'Villes', [{ id: 'Nom', type: 'Text' }]],
      ['BulkAddRecord', 'Villes', [null, null], { Nom: ['Lyon', 'Paris'] }],
      ['AddTable', 'Gens', [{ id: 'Prenom', type: 'Text' }]],
      ['BulkAddRecord', 'Gens', [null, null, null], { Prenom: ['Anna', 'Basile', 'Céline'] }],
      ['AddTable', 'Services', [{ id: 'Libelle', type: 'Text' }, { id: 'Budget', type: 'Numeric' }]],
      ['BulkAddRecord', 'Services', [null, null, null], { Libelle: ['Compta', 'RH', 'IT'], Budget: [1, 2, 3] }],
    ]);
    const column = async (doc, table, colId) => {
      const parentId = await tableRef(doc, table);
      return (await records(doc, '_grist_Tables_column')).find(c => c.colId === colId && c.parentId === parentId);
    };
    // Lieu : Référence vers Villes (nom de la ville) ; Chef : Référence vers Gens elle-même (prénom) ; Equipes : Liste de
    // références vers Services (libellé), table que l'export ne contient pas au départ.
    const addRef = async (table, colId, target, shown, values, list = false) => {
      await applyActions(src.doc, [['AddColumn', table, colId, { type: `${list ? 'RefList' : 'Ref'}:${target}` }]]);
      const ref = (await column(src.doc, table, colId)).id;
      await applyActions(src.doc, [['UpdateRecord', '_grist_Tables_column', ref, { visibleCol: (await column(src.doc, target, shown)).id }],
        ['SetDisplayFormula', table, null, ref, `$${colId}.${shown}`], ['BulkUpdateRecord', table, values.map((_, i) => i + 1), { [colId]: values }]]);
    };
    await addRef('Gens', 'Lieu', 'Villes', 'Nom', [1, 2, 0]);
    await addRef('Gens', 'Chef', 'Gens', 'Prenom', [0, 1, 2]);
    await addRef('Gens', 'Equipes', 'Services', 'Libelle', [['L', 1, 2], ['L', 2], null], true);
    const dst = await newDocWithWidget('Liens CIBLE');
    await openWidget(src.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await button('Nouvel export').click();
    await dialog().getByRole('checkbox', { name: 'Gens' }).check();
    await dialog().getByRole('checkbox', { name: 'Villes' }).check();
    await dialogButton('Continuer').click();
    const refRow = key => dialog().locator(`[data-ref="${key}"]`);
    const keeps = async key => refRow(key).getByLabel('Garder le lien').isChecked();
    assert.ok(await keeps('Gens.Lieu') && await keeps('Gens.Chef'), 'liens gardés d\'emblée quand la table visée est cochée');
    assert.ok(!(await keeps('Gens.Equipes')), 'Services n\'est pas cochée : les valeurs seules, rien ne s\'ajoute sans le choix');
    assert.equal(await dialog().locator('.table-added').count(), 0);
    const toRefs = () => dialog().getByRole('heading', { name: 'Références entre tables' }).evaluate(node => node.scrollIntoView({ block: 'start' }));
    await toRefs();
    await shot('29-source-liens', 'modal');
    // Garder le lien de la Liste de références ajoute la table Services, avec sa seule colonne affichée.
    await refRow('Gens.Equipes').getByLabel('Garder le lien').check();
    await dialog().locator('.table-added', { hasText: 'Services' }).waitFor();
    const added = dialog().locator('.table-added', { hasText: 'Services' });
    const summary = () => dialog().locator('.table-block', { hasText: 'Références entre tables' }).innerText();
    assert.match(await added.innerText(), /1 colonne sur 2 \(Libelle\)/);
    assert.ok(await added.getByLabel(/Seulement la colonne affichée \(Libelle\)/).isChecked(), 'd\'emblée : la colonne affichée seule');
    assert.match(await summary(), /Part en plus des tables cochées\s:\sServices \(Libelle\)/);
    // Trois choix pour la table ajoutée : la colonne affichée seule, toute la table, ou des colonnes au choix (0.28).
    assert.ok(!(await added.getByText('Budget').isVisible()), 'la liste des colonnes est repliée tant qu\'on ne choisit pas les colonnes');
    await added.getByLabel(/Toute la table \(2 colonnes\)/).check();
    assert.match(await added.innerText(), /2 colonnes sur 2 \(toute la table\)/);
    assert.match(await summary(), /Part en plus des tables cochées\s:\sServices \(toute la table\)/);
    await added.getByLabel('Choisir les colonnes').check();
    await added.getByRole('checkbox', { name: /Budget/ }).waitFor();
    assert.ok(await added.getByRole('checkbox', { name: /Budget/ }).isChecked(), 'de « toute la table » à « choisir » : Budget reste coché');
    assert.ok(await added.getByRole('checkbox', { name: /Libelle/ }).isDisabled(), 'la colonne que le lien affiche est verrouillée');
    await added.getByRole('checkbox', { name: /Budget/ }).uncheck();
    assert.match(await added.innerText(), /1 colonne sur 2 \(Libelle\)/);
    await added.getByRole('checkbox', { name: /Budget/ }).check();
    assert.match(await added.innerText(), /2 colonnes sur 2 \(Libelle, Budget\)/);
    await added.evaluate(node => node.scrollIntoView({ block: 'end' }));
    await shot('29b-source-liens-tables-ajoutees', 'modal');
    await added.getByLabel(/Seulement la colonne affichée/).check();
    assert.match(await added.innerText(), /1 colonne sur 2 \(Libelle\)/, 'retour à la colonne affichée seule');
    // Reprise d'avis : revenir aux valeurs retire la table ajoutée, puis la rajouter.
    await refRow('Gens.Equipes').getByLabel('Valeurs seulement').check();
    await dialog().locator('.table-added').waitFor({ state: 'detached' });
    await refRow('Gens.Equipes').getByLabel('Garder le lien').check();
    await dialog().locator('.table-added', { hasText: 'Services' }).waitFor();
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill('Annuaire');
    await dialogButton('Créer l’export').click();
    const code = await plainInvitation();
    const answer = await accept(dst.doc, dst.url, code, /Annuaire\s»\s:\stables/);
    await approve(answer, { url: src.url });
    await openWidget(dst.url);
    const byName = async (table, key) => Object.fromEntries((await records(dst.doc, table)).map(r => [r[key], r]));
    const settled = async () => {
      const gens = await byName('Gens', 'Prenom');
      const villes = await byName('Villes', 'Nom');
      const services = await byName('Services', 'Libelle');
      return Object.keys(gens).length === 3 && Object.keys(villes).length === 2 && Object.keys(services).length === 3 && { gens, villes, services };
    };
    await waitFor(settled, 'tables reçues', 90000);
    const lieu = await column(dst.doc, 'Gens', 'Lieu');
    const chef = await column(dst.doc, 'Gens', 'Chef');
    const equipes = await column(dst.doc, 'Gens', 'Equipes');
    assert.deepEqual([lieu.type, chef.type, equipes.type], ['Ref:Villes', 'Ref:Gens', 'RefList:Services'], 'des vraies Références et une vraie Liste de références chez le destinataire');
    assert.equal(equipes.visibleCol, (await column(dst.doc, 'Services', 'Libelle')).id, 'la liste affiche la colonne de la SOURCE');
    assert.ok(!(await records(dst.doc, '_grist_Tables_column')).some(c => c.colId === 'Budget'), 'la colonne Budget de Services ne part pas : seule la colonne affichée est envoyée');
    assert.equal(lieu.visibleCol, (await column(dst.doc, 'Villes', 'Nom')).id, 'elles affichent la colonne de la SOURCE');
    const links = async () => {
      const { gens, villes, services } = await settled();
      return { lieu: [gens.Anna.Lieu, gens.Basile.Lieu, gens.Céline.Lieu], chef: [gens.Anna.Chef, gens.Basile.Chef, gens.Céline.Chef], equipes: [gens.Anna.Equipes, gens.Basile.Equipes, gens.Céline.Equipes], gens, villes, services };
    };
    // La ligne visée est dans la même table et arrive en même temps : complétée au passage suivant.
    await waitFor(async () => {
      const now = await links();
      return now.chef[1] === now.gens.Anna.id && now.chef[2] === now.gens.Basile.id;
    }, 'Chef : la ligne visée arrivée en même temps est retrouvée', 90000);
    let now = await links();
    assert.deepEqual(now.lieu, [now.villes.Lyon.id, now.villes.Paris.id, 0], 'Lieu : le numéro de la ligne reçue, vide si la SOURCE est vide');
    assert.equal(now.chef[0], 0);
    await waitFor(async () => {
      const next = await links();
      return Array.isArray(next.equipes[0]) && next.equipes[0].length === 3;
    }, 'Equipes : la Liste de références arrive', 90000);
    now = await links();
    assert.deepEqual(now.equipes[0], ['L', now.services.Compta.id, now.services.RH.id], 'Equipes : les numéros des lignes reçues, dans l\'ordre de la SOURCE');
    assert.deepEqual(now.equipes[1], ['L', now.services.RH.id]);
    assert.ok(!now.equipes[2] || now.equipes[2].length <= 1, 'liste vide chez la SOURCE : vide ici');
    assert.equal(await widget().locator('.drift').count(), 0, 'les Références ne sont pas des retouches');
    assert.match(await widget().locator('.links-done').first().innerText(), /Références refaites/);
    // Une ville renommée dans la SOURCE : la ligne reste la même, la Référence aussi.
    await applyActions(src.doc, [['UpdateRecord', 'Villes', 1, { Nom: 'Villeurbanne' }]]);
    await waitFor(async () => (await records(dst.doc, 'Villes')).some(r => r.Nom === 'Villeurbanne'), 'ville renommée reçue', 90000);
    now = await links();
    assert.equal(now.lieu[0], now.villes.Villeurbanne.id, 'la Référence suit la ligne renommée');
    // Une Référence changée dans la SOURCE : la cellule suit.
    await applyActions(src.doc, [['UpdateRecord', 'Gens', 2, { Lieu: 1 }], ['UpdateRecord', 'Gens', 3, { Lieu: 2 }]]);
    await waitFor(async () => {
      const next = await links();
      return next.lieu[1] === next.villes.Villeurbanne.id && next.lieu[2] === next.villes.Paris.id;
    }, 'Référence changée dans la SOURCE', 90000);
    assert.equal(await widget().locator('.drift').count(), 0, 'toujours aucune retouche');
    step('Références conservées : vraies Références chez le destinataire (colonne affichée reprise), ligne visée arrivée en même temps retrouvée, ville renommée et Référence changée suivies');

    // « Valeurs seulement » dans « Modifier » : la colonne redevient du texte, les autres gardent leur lien.
    await openWidget(src.url);
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    assert.ok(await keeps('Gens.Lieu') && await keeps('Gens.Equipes'), 'export modifié : tels que l\'export les a enregistrés');
    await refRow('Gens.Lieu').getByLabel('Valeurs seulement').check();
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/Enregistré/).waitFor({ timeout: 60000 });
    await dialogButton('Fermer').click();
    await openWidget(dst.url);
    await waitFor(async () => (await column(dst.doc, 'Gens', 'Lieu')).type === 'Text', 'colonne rendue au texte', 90000);
    await waitFor(async () => (await records(dst.doc, 'Gens')).some(r => r.Lieu === 'Paris'), 'texte affiché reçu', 90000);
    now = await byName('Gens', 'Prenom');
    assert.deepEqual([now.Anna.Lieu, now.Basile.Lieu, now.Céline.Lieu], ['Villeurbanne', 'Villeurbanne', 'Paris']);
    assert.equal((await column(dst.doc, 'Gens', 'Chef')).type, 'Ref:Gens', 'les autres colonnes gardent leur lien');
    assert.equal((await column(dst.doc, 'Gens', 'Equipes')).type, 'RefList:Services');
    step('Références conservées : « Valeurs seulement » rend le texte d\'une colonne, les autres gardent leur lien');

    // Le lien est redonné alors que la colonne est remplie de texte : rien n'est touché sans accord, un clic la refait.
    await openWidget(src.url);
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    await refRow('Gens.Lieu').getByLabel('Garder le lien').check();
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/Enregistré/).waitFor({ timeout: 60000 });
    await dialogButton('Fermer').click();
    await openWidget(dst.url);
    await widget().locator('.links-text').waitFor({ timeout: 90000 });
    assert.match(await widget().locator('.links-text').innerText(), /Gens\.Lieu/);
    assert.equal((await column(dst.doc, 'Gens', 'Lieu')).type, 'Text', 'rien n\'est touché sans accord');
    await shot('29c-cible-liens-refaire', 'card');
    await widget().getByRole('button', { name: 'Refaire les références' }).click();
    await dialog().getByText(/devient une Référence vers la table Villes/).waitFor();
    await dialogButton('Refaire les références').click();
    await waitFor(async () => (await column(dst.doc, 'Gens', 'Lieu')).type === 'Ref:Villes', 'colonne refaite en Référence', 90000);
    await waitFor(async () => {
      const next = await links();
      return next.lieu[0] === next.villes.Villeurbanne.id && next.lieu[1] === next.villes.Villeurbanne.id && next.lieu[2] === next.villes.Paris.id;
    }, 'cellules refaites d\'après le lien de la SOURCE', 90000);
    assert.equal(await widget().locator('.links-text').count(), 0, 'plus rien à refaire');
    step('Références conservées : une colonne remplie de texte reste du texte, « Refaire les références » la convertit et reprend le lien de la SOURCE');

    // Toute la table (0.28) : un second export prend Services en entier avec le lien de Equipes ; un second destinataire reçoit aussi Budget.
    await openWidget(src.url);
    await button('Nouvel export').click();
    await dialog().getByRole('checkbox', { name: 'Gens' }).check();
    await dialogButton('Continuer').click();
    await refRow('Gens.Equipes').getByLabel('Garder le lien').check();
    await dialog().locator('.table-added', { hasText: 'Services' }).getByLabel(/Toute la table \(2 colonnes\)/).check();
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill('Annuaire complet');
    await dialogButton('Créer l’export').click();
    const wholeCode = await plainInvitation();
    const dst2 = await newDocWithWidget('Liens CIBLE 2');
    const wholeAnswer = await accept(dst2.doc, dst2.url, wholeCode, /Annuaire complet\s»\s:\stables/);
    await approve(wholeAnswer, { url: src.url });
    await openWidget(dst2.url);
    await waitFor(async () => {
      const rows = await records(dst2.doc, 'Services');
      return rows.length === 3 && rows.every(r => r.Budget) && rows;
    }, 'Services reçue en entier (Libelle et Budget)', 90000);
    const budgets = Object.fromEntries((await records(dst2.doc, 'Services')).map(r => [r.Libelle, r.Budget]));
    assert.deepEqual(budgets, { Compta: 1, RH: 2, IT: 3 }, 'la colonne Budget de la table prise en entier arrive');
    assert.equal((await column(dst2.doc, 'Gens', 'Equipes')).type, 'RefList:Services', 'le lien est refait chez le second destinataire');
    step('Références conservées : « Toute la table » envoie aussi les autres colonnes de la table ajoutée (Budget) et le lien est refait chez le destinataire');
  }
  // --- Mise en forme des colonnes : une SOURCE en français (fr-FR) avec une colonne Montant (monnaie sans devise
  // propre, en-tête coloré, règle « négatif en rouge » et une règle qui sort de la grammaire) envoie sa mise en forme
  // à une CIBLE par défaut (en-US). La CIBLE reprend format, devise et en-tête dans les colonnes qu'elle crée, y
  // reconstruit la règle (jamais la formule d'origine, jamais la règle piégée), dit l'écart de langue et ne règle le
  // document que sur un clic confirmé d'un propriétaire ; une retouche d'ici reste, « Reprendre depuis la SOURCE »
  // remet tout d'accord. Les descriptions des colonnes et de la table partent avec (cases à part) et se reprennent de même.
  // Ordre et colonnes cachées de la page de la table (0.26) : la SOURCE les envoie avec ses colonnes quand la case est cochée ; la CIBLE les pose une
  // fois sur ce que le widget a créé, sans refaire ce qui est décidé ; « Reprendre depuis la SOURCE » remet tout d'accord.
  async function layoutSteps() {
    const columnNames = ['Libelle', 'Montant', 'Reel', 'Note', 'Code'];
    const src = await newDocWithWidget('Mise en page SOURCE', [
      ['AddTable', 'Budget', columnNames.map(id => ({ id, type: 'Text' }))],
      ['BulkAddRecord', 'Budget', [null, null], { Libelle: ['Loyer', 'Eau'], Montant: ['100', '30'], Reel: ['90', '28'], Note: ['n1', 'n2'], Code: ['c1', 'c2'] }],
    ]);
    // La page de la table : sa section de type tableau (hors données brutes et fiche), et ses champs rangés comme Grist les affiche.
    const pageOf = async (doc, table) => {
      const tb = (await records(doc, '_grist_Tables')).find(x => x.tableId === table);
      const section = (await records(doc, '_grist_Views_section')).filter(sec => sec.tableRef === tb.id && sec.parentKey === 'record' && sec.parentId > 0
        && sec.id !== tb.rawViewSectionRef && sec.id !== tb.recordCardViewSectionRef)[0];
      const columns = (await records(doc, '_grist_Tables_column')).filter(c => c.parentId === tb.id);
      const fields = (await records(doc, '_grist_Views_section_field')).filter(f => f.parentId === section.id).sort((a, b) => a.parentPos - b.parentPos);
      return { section: section.id, columns, fields: fields.map(f => ({ id: f.id, col: columns.find(c => c.id === f.colRef).colId, pos: f.parentPos })) };
    };
    const pageOrder = async (doc, table) => (await pageOf(doc, table)).fields.map(f => f.col);
    const fieldOf = async (doc, col) => (await pageOf(doc, 'Budget')).fields.find(f => f.col === col);
    // La SOURCE : « Note » cachée, « Code » en tête.
    await applyActions(src.doc, [['RemoveRecord', '_grist_Views_section_field', (await fieldOf(src.doc, 'Note')).id]]);
    await applyActions(src.doc, [['UpdateRecord', '_grist_Views_section_field', (await fieldOf(src.doc, 'Code')).id, { parentPos: 1 }]]);
    assert.deepEqual(await pageOrder(src.doc, 'Budget'), ['Code', 'Libelle', 'Montant', 'Reel']);

    const dst = await newDocWithWidget('Mise en page CIBLE');
    await openWidget(src.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await button('Nouvel export').click();
    await dialog().getByRole('checkbox', { name: 'Budget' }).check();
    await dialogButton('Continuer').click();
    const elements = dialog().locator('details:not(.tuto-step)', { hasText: 'Envoyé avec les colonnes' });
    assert.ok(!/ordre et colonnes cachées/.test(await elements.locator('summary').innerText()), 'la mise en page ne part pas sans accord');
    await elements.locator('summary').click();
    const send = dialog().getByRole('checkbox', { name: 'Envoyer l’ordre et les colonnes cachées de la page' });
    assert.ok(!(await send.isChecked()), 'décochée d\'emblée : elle change l\'affichage chez le destinataire');
    assert.match(await elements.innerText(), /1\stable concernée/);
    await send.check();
    if (process.env.SHOTS) await dialog().screenshot({ path: join(process.env.SHOTS, 'mise-en-page-1-case.png') });
    await shot('40-source-ordre-colonnes', 'modal');
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill('Budget');
    await dialogButton('Créer l’export').click();
    const code = await plainInvitation();
    await approve(await accept(dst.doc, dst.url, code, /Budget\s»\s:\stable/), { url: src.url });
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => (await records(dst.doc, 'Budget')).length === 2, 'lignes reçues', 90000);
    await waitFor(async () => (await pageOrder(dst.doc, 'Budget')).join() === 'Code,Libelle,Montant,Reel', 'page de la CIBLE rangée comme celle de la SOURCE', 60000);
    assert.deepEqual((await records(dst.doc, 'Budget')).map(r => r.Note).sort(), ['n1', 'n2'], 'les données de la colonne cachée sont bien là');
    step('Mise en page : case décochée d\'emblée ; la CIBLE cache « Note » et range « Code » en tête, les données de « Note » sont reçues');

    // Une retouche d'ici (« Note » remontrée à la fin) reste, même quand la SOURCE change l'ordre : la décision est prise une fois.
    const here = await pageOf(dst.doc, 'Budget');
    await applyActions(dst.doc, [['AddRecord', '_grist_Views_section_field', null, { parentId: here.section, colRef: here.columns.find(c => c.colId === 'Note').id, parentPos: 9999 }]]);
    await applyActions(src.doc, [['UpdateRecord', '_grist_Views_section_field', (await fieldOf(src.doc, 'Reel')).id, { parentPos: 0.5 }]]);
    assert.deepEqual(await pageOrder(src.doc, 'Budget'), ['Reel', 'Code', 'Libelle', 'Montant']);
    await openWidgetTab(src.url, 'Envoyer'); // la SOURCE met la description de ses colonnes à jour
    await widget().locator('[data-export]').first().waitFor();
    await page.waitForTimeout(3000);
    await applyActions(src.doc, [['AddRecord', 'Budget', null, { Libelle: 'Assurance', Montant: '80', Reel: '79', Note: 'n3', Code: 'c3' }]]);
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => (await records(dst.doc, 'Budget')).length === 3, 'ligne de plus reçue (un passage a eu lieu)', 90000);
    assert.deepEqual(await pageOrder(dst.doc, 'Budget'), ['Code', 'Libelle', 'Montant', 'Reel', 'Note'], 'la mise en page décidée une fois n\'est pas refaite');
    step('Mise en page : une colonne remontrée ici reste, l\'ordre nouveau de la SOURCE ne défait rien tout seul');

    // « Reprendre depuis la SOURCE » : l'ordre de la SOURCE et sa colonne cachée.
    await button('Reprendre depuis la SOURCE').click();
    assert.ok(await dialog().getByRole('checkbox', { name: 'Ordre et colonnes cachées de la page de la table' }).isChecked());
    if (process.env.SHOTS) await dialog().screenshot({ path: join(process.env.SHOTS, 'mise-en-page-2-reprendre.png') });
    await shot('41-cible-reprendre', 'modal');
    await dialogButton('Reprendre').click();
    await waitFor(async () => (await pageOrder(dst.doc, 'Budget')).join() === 'Reel,Code,Libelle,Montant', 'ordre de la SOURCE repris', 90000);
    assert.deepEqual((await records(dst.doc, 'Budget')).map(r => r.Note).sort(), ['n1', 'n2', 'n3'], 'cacher une colonne ne touche pas à ses données');
    step('Mise en page : « Reprendre depuis la SOURCE » range la page comme celle de la SOURCE et recache « Note »');
  }

  async function formatSteps() {
    const src = await newDocWithWidget('Format SOURCE', [
      ['AddTable', 'Budget', [{ id: 'Libelle', type: 'Text' }, { id: 'Montant', type: 'Numeric' }]],
      ['BulkAddRecord', 'Budget', [null, null], { Libelle: ['Loyer', 'Remboursement'], Montant: [1234.5, -20] }],
    ]);
    const docSettings = async doc => JSON.parse((await records(doc, '_grist_DocInfo'))[0].documentSettings || '{}');
    const column = async (doc, table, colId) => {
      const parentId = await tableRef(doc, table);
      return (await records(doc, '_grist_Tables_column')).find(c => c.colId === colId && c.parentId === parentId);
    };
    const optionsOf = col => JSON.parse(col.widgetOptions || '{}');
    // Règles d'une colonne : [{ formula, style }] dans l'ordre de ses règles (RefList : ['L', ref, ...]).
    const rulesOf = async (doc, table, colId) => {
      const col = await column(doc, table, colId);
      const all = await records(doc, '_grist_Tables_column');
      return (Array.isArray(col.rules) ? col.rules.slice(1) : []).map((ref, i) => ({ formula: all.find(c => c.id === ref).formula, style: (optionsOf(col).rulesOptions || [])[i] }));
    };
    const addRule = async (table, colId, formula, style) => {
      const col = await column(src.doc, table, colId);
      const helper = (await applyActions(src.doc, [['AddEmptyRule', table, 0, col.id]])).retValues[0];
      await applyActions(src.doc, [['ModifyColumn', table, helper.colId, { formula }]]);
      const list = optionsOf(await column(src.doc, table, colId)).rulesOptions || [];
      await applyActions(src.doc, [['UpdateRecord', '_grist_Tables_column', col.id, { widgetOptions: JSON.stringify({ ...optionsOf(await column(src.doc, table, colId)), rulesOptions: [...list, style] }) }]]);
    };
    const rawSectionOf = async (doc, table) => (await records(doc, '_grist_Tables')).find(tb => tb.tableId === table).rawViewSectionRef;
    await applyActions(src.doc, [['UpdateRecord', '_grist_DocInfo', 1, { documentSettings: JSON.stringify({ ...(await docSettings(src.doc)), locale: 'fr-FR' }) }],
      ['UpdateRecord', '_grist_Tables_column', (await column(src.doc, 'Budget', 'Montant')).id,
        { description: 'Montant TTC en euros', widgetOptions: JSON.stringify({ numMode: 'currency', decimals: 2, headerFillColor: '#336699', headerFontBold: true, alignment: 'right' }) }],
      ['UpdateRecord', '_grist_Tables_column', (await column(src.doc, 'Budget', 'Libelle')).id, { description: 'Intitulé de la ligne' }],
      ['UpdateRecord', '_grist_Views_section', await rawSectionOf(src.doc, 'Budget'), { description: 'Lignes du budget 2026' }]]);
    await addRule('Budget', 'Montant', '$Montant < 0', { fillColor: '#FF0000', textColor: '#FFFFFF', fontBold: true });
    await addRule('Budget', 'Libelle', 'len($Libelle) > 3', { fillColor: '#00FF00' }); // hors de la grammaire : ne part jamais

    const dst = await newDocWithWidget('Format CIBLE');
    assert.equal((await docSettings(dst.doc)).locale, 'en-US', 'la CIBLE est un document par défaut');
    await openWidget(src.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await button('Nouvel export').click();
    await dialog().getByRole('checkbox', { name: 'Budget' }).check();
    await dialogButton('Continuer').click();
    // Les éléments envoyés avec les colonnes sont repliés derrière une ligne qui dit ce qui part ; chacun a sa case, cochée d'emblée.
    const elements = dialog().locator('details:not(.tuto-step)', { hasText: 'Envoyé avec les colonnes' });
    assert.match(await elements.locator('summary').innerText(), /mise en forme, descriptions des colonnes, descriptions des tables/);
    await elements.locator('summary').click();
    const send = dialog().getByRole('checkbox', { name: 'Envoyer la mise en forme des colonnes' });
    assert.ok(await send.isChecked(), 'cochée d\'emblée pour un nouvel export');
    assert.ok(await dialog().getByRole('checkbox', { name: 'Envoyer les descriptions des colonnes' }).isChecked());
    assert.ok(await dialog().getByRole('checkbox', { name: 'Envoyer la description des tables' }).isChecked());
    assert.match(await elements.innerText(), /2\scolonnes concernées/, 'chaque case dit combien de colonnes sont concernées');
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill('Budget');
    await dialogButton('Créer l’export').click();
    const code = await plainInvitation();
    const answer = await accept(dst.doc, dst.url, code, /Budget\s»\s:\stable/);
    await approve(answer, { url: src.url });
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => (await records(dst.doc, 'Budget')).length === 2, 'lignes reçues', 90000);

    // Format, devise résolue (fr-FR : l'euro), en-tête : repris dans la colonne créée ; la règle est refaite.
    const montant = async () => optionsOf(await column(dst.doc, 'Budget', 'Montant'));
    await waitFor(async () => (await rulesOf(dst.doc, 'Budget', 'Montant')).length === 1, 'règle reconstruite', 90000);
    const { rulesOptions, ...base } = await montant();
    assert.deepEqual(base, { numMode: 'currency', decimals: 2, currency: 'EUR', alignment: 'right', headerFillColor: '#336699', headerFontBold: true });
    assert.deepEqual(rulesOptions, [{ fillColor: '#FF0000', textColor: '#FFFFFF', fontBold: true }]);
    assert.deepEqual(await rulesOf(dst.doc, 'Budget', 'Montant'), [{ formula: '$Montant < 0', style: { fillColor: '#FF0000', textColor: '#FFFFFF', fontBold: true } }]);
    assert.deepEqual(await rulesOf(dst.doc, 'Budget', 'Libelle'), [], 'la règle hors grammaire n\'est jamais posée');
    assert.ok(!JSON.stringify(await records(dst.doc, '_grist_Tables_column')).includes('len('), 'aucune formule de la SOURCE telle quelle');
    const helpers = async () => (await records(dst.doc, '_grist_Tables_column')).filter(c => c.colId.startsWith('gristHelper_')).length;
    assert.equal(await helpers(), 1, 'une seule colonne cachée de règle');

    // L'écart de langue est dit ; le document n'est réglé que par un clic confirmé d'un propriétaire.
    const notice = widget().locator('.notice.format');
    await notice.waitFor({ timeout: 60000 });
    assert.match(await notice.innerText(), /fr-FR/);
    assert.equal((await docSettings(dst.doc)).locale, 'en-US', 'aucun passage n\'a touché au réglage du document');
    await notice.getByRole('button', { name: 'Régler le document comme la SOURCE' }).click();
    await dialogButton('Annuler').click();
    assert.equal((await docSettings(dst.doc)).locale, 'en-US', '« Annuler » ne règle rien');
    await notice.getByRole('button', { name: 'Régler le document comme la SOURCE' }).click();
    await dialogButton('Régler le document comme la SOURCE').click();
    await waitFor(async () => (await docSettings(dst.doc)).locale === 'fr-FR', 'document réglé en fr-FR', 30000);
    assert.equal((await docSettings(dst.doc)).engine, (await docSettings(src.doc)).engine, 'le reste du réglage est gardé');
    await notice.waitFor({ state: 'detached', timeout: 30000 });
    step('Mise en forme : format, devise (euro), en-tête et règle refaite chez la CIBLE (formule jamais copiée, règle piégée écartée), écart de langue dit puis réglé sur un clic confirmé');

    // Descriptions des colonnes et de la table, posées une fois sur ce que le widget a créé.
    const noteOf = async (doc, table, colId) => (await column(doc, table, colId)).description;
    const dstSection = await rawSectionOf(dst.doc, 'Budget');
    const dstTableNote = async () => (await records(dst.doc, '_grist_Views_section')).find(sec => sec.id === dstSection).description;
    await waitFor(async () => (await noteOf(dst.doc, 'Budget', 'Libelle')) === 'Intitulé de la ligne' && (await dstTableNote()) === 'Lignes du budget 2026', 'descriptions reçues', 90000);
    assert.equal(await noteOf(dst.doc, 'Budget', 'Montant'), 'Montant TTC en euros');
    assert.equal(await noteOf(dst.doc, 'Budget', 'id_sync'), '', 'la description de la clé reste vide : la note du widget est dans ses options, et ne reçoit rien de la SOURCE');
    assert.ok(!JSON.stringify(syncNoteOf(await column(dst.doc, 'Budget', 'id_sync'))).includes('Intitulé'));
    step('Descriptions : celles des colonnes et de la table arrivent chez la CIBLE');
    await applyActions(dst.doc, [['UpdateRecord', '_grist_Tables_column', (await column(dst.doc, 'Budget', 'Libelle')).id, { description: 'Ma description' }]]);

    // Ce que Grist affiche : nombre écrit à la française, règle appliquée à la ligne négative.
    await page.goto(dst.url.replace(/\/p\/\d+$/, ''));
    await page.getByText('Budget', { exact: true }).first().click();
    await page.locator('.field_clip').first().waitFor({ timeout: 30000 });
    const cells = async () => page.locator('.gridview_row .field').evaluateAll(nodes => nodes.map(node => {
      const clip = node.querySelector('.field_clip') || node; // le fond est sur la case, la couleur du texte sur son contenu
      return { text: node.textContent.replace(/\s/g, ' ').trim(), fill: getComputedStyle(node).backgroundColor, color: getComputedStyle(clip).color };
    }));
    const shown = await waitFor(async () => { const now = (await cells()).filter(c => /€/.test(c.text)); return now.length === 2 && now; }, 'montants affichés en euros', 30000);
    assert.deepEqual(shown.map(c => c.text).sort(), ['-20,00 €', '1 234,50 €'], 'écriture française, euro');
    const negative = shown.find(c => c.text.startsWith('-'));
    assert.equal(negative.fill, 'rgb(255, 0, 0)', 'la règle colore la ligne négative');
    assert.equal(negative.color, 'rgb(255, 255, 255)');
    assert.notEqual(shown.find(c => !c.text.startsWith('-')).fill, 'rgb(255, 0, 0)');
    step('Mise en forme : la CIBLE affiche 1 234,50 € et la ligne négative est en rouge');

    // Une retouche d'ici (devise, règle retirée) reste après un nouveau passage ; « Reprendre la mise en forme » la défait.
    const col = await column(dst.doc, 'Budget', 'Montant');
    await applyActions(dst.doc, [['UpdateRecord', '_grist_Tables_column', col.id, { widgetOptions: JSON.stringify({ ...await montant(), currency: 'USD', rulesOptions: [] }) }],
      ['RemoveColumn', 'Budget', (await records(dst.doc, '_grist_Tables_column')).find(c => c.colId.startsWith('gristHelper_')).colId]]);
    await applyActions(src.doc, [['AddRecord', 'Budget', null, { Libelle: 'Assurance', Montant: 80 }]]);
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => (await records(dst.doc, 'Budget')).length === 3, 'ligne de plus reçue (un passage a eu lieu)', 90000);
    assert.equal((await montant()).currency, 'USD', 'la devise choisie ici reste');
    assert.deepEqual(await rulesOf(dst.doc, 'Budget', 'Montant'), [], 'la règle retirée ici n\'est pas refaite');
    assert.equal(await noteOf(dst.doc, 'Budget', 'Libelle'), 'Ma description', 'la description retouchée ici reste');
    // « Reprendre depuis la SOURCE » : on ne coche que la mise en forme, puis seulement les descriptions.
    await button('Reprendre depuis la SOURCE').click();
    await dialog().getByRole('checkbox', { name: 'Descriptions des colonnes' }).uncheck();
    await dialog().getByRole('checkbox', { name: 'Description de la table' }).uncheck();
    await dialogButton('Reprendre').click();
    await waitFor(async () => (await montant()).currency === 'EUR' && (await rulesOf(dst.doc, 'Budget', 'Montant')).length === 1, 'mise en forme reprise', 90000);
    assert.deepEqual((await rulesOf(dst.doc, 'Budget', 'Montant')).map(r => r.formula), ['$Montant < 0']);
    assert.equal(await helpers(), 1, 'la règle est remplacée, pas doublée');
    assert.equal(await noteOf(dst.doc, 'Budget', 'Libelle'), 'Ma description', 'les descriptions n\'étaient pas demandées');
    step('Mise en forme : une retouche d\'ici est gardée, « Reprendre depuis la SOURCE » remet la SOURCE sans doubler la règle');
    await button('Reprendre depuis la SOURCE').click();
    await dialog().getByRole('checkbox', { name: 'Mise en forme' }).uncheck();
    await dialogButton('Reprendre').click();
    await waitFor(async () => (await noteOf(dst.doc, 'Budget', 'Libelle')) === 'Intitulé de la ligne', 'description reprise', 90000);
    assert.equal(await dstTableNote(), 'Lignes du budget 2026');
    step('Descriptions : « Reprendre depuis la SOURCE » remet la description retouchée ici, élément par élément');

    // Case décochée : ce que la SOURCE envoie redevient le format de base (rien ne part de plus que les listes de choix d'avant).
    await openWidget(src.url);
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    await dialog().locator('details:not(.tuto-step) > summary', { hasText: 'Envoyé avec les colonnes' }).click();
    for (const name of ['Envoyer la mise en forme des colonnes', 'Envoyer les descriptions des colonnes', 'Envoyer la description des tables']) {
      const again = dialog().getByRole('checkbox', { name });
      assert.ok(await again.isChecked(), 'export modifié : telle que l\'export l\'est déjà');
      await again.uncheck();
    }
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/Enregistré/).waitFor({ timeout: 60000 });
    await dialogButton('Fermer').click();
    const lot = JSON.parse((await records(src.doc, 'Synchro')).find(r => r.Synchro_Type === 'lot' && r.Synchro_Table === 'Budget').Synchro_Colonnes);
    assert.ok(lot.every(c => !c.fmt && !c.doc), 'plus de marque de mise en forme dans la description des colonnes');
    assert.ok(!JSON.stringify(lot).includes('rules') && !JSON.stringify(lot).includes('headerFill'), 'ni règle ni en-tête');
    assert.ok(lot.every(c => c.desc === undefined && c.tdesc === undefined), 'ni description de colonne ni de table');
    step('Mise en forme : cases décochées, la SOURCE n\'envoie plus ni règle, ni en-tête, ni langue, ni description');
  }
  // Formules de colonne : à part, jamais envoyées sans la case et son message, jamais posées sans le clic d'un propriétaire.
  async function formulasSteps() {
    const src = await newDocWithWidget('Formules SOURCE', [
      ['AddTable', 'Budget', [{ id: 'Libelle', type: 'Text' }, { id: 'Montant', type: 'Numeric' },
        { id: 'TVA', type: 'Numeric', isFormula: true, formula: '$Montant * 0.2' },
        { id: 'Fuite', type: 'Text', isFormula: true, formula: 'import os\nreturn "ok"' }]],
      ['BulkAddRecord', 'Budget', [null, null], { Libelle: ['Loyer', 'Assurance'], Montant: [100, 80] }],
      // Pays : formule par défaut (déclenchement sur les nouvelles lignes), envoyée avec les formules ; Suivi : formule qui se recalcule à toute
      // modification, jamais envoyée (elle réécrirait ici des valeurs que la SOURCE envoie déjà).
      ['AddColumn', 'Budget', 'Pays', { type: 'Text' }],
      ['ModifyColumn', 'Budget', 'Pays', { isFormula: false, formula: '"France"', recalcWhen: 0 }],
      ['AddColumn', 'Budget', 'Suivi', { type: 'Text' }],
      ['ModifyColumn', 'Budget', 'Suivi', { isFormula: false, formula: '"suivi"', recalcWhen: 2 }],
    ]);
    const dst = await newDocWithWidget('Formules CIBLE');
    const column = async (doc, table, colId) => {
      const parentId = await tableRef(doc, table);
      return (await records(doc, '_grist_Tables_column')).find(c => c.colId === colId && c.parentId === parentId);
    };
    const sentColumns = async () => JSON.parse((await records(src.doc, 'Synchro')).find(r => r.Synchro_Type === 'lot' && r.Synchro_Table === 'Budget').Synchro_Colonnes);
    await openWidget(src.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await button('Nouvel export').click();
    await dialog().getByRole('checkbox', { name: 'Budget' }).check();
    await dialogButton('Continuer').click();
    // La case est à part (hors du repli des autres éléments), décochée d'emblée, et dit combien de colonnes sont concernées.
    const box = dialog().getByRole('checkbox', { name: /Envoyer aussi les formules des colonnes/ });
    await box.waitFor({ timeout: 30000 });
    assert.ok(await box.isVisible(), 'visible sans ouvrir le repli');
    assert.ok(!(await box.isChecked()), 'décochée d\'emblée, même pour un nouvel export');
    assert.match(await dialog().locator('.formulas-box').innerText(), /3\sformules/, 'deux formules de colonne et une formule par défaut');
    const warning = widget().getByRole('dialog', { name: 'Envoyer aussi les formules ?' });
    await box.click();
    await warning.waitFor();
    assert.match(await warning.innerText(), /code Python/);
    assert.match(await warning.innerText(), /seul un propriétaire du document destinataire/);
    if (process.env.SHOTS) await warning.screenshot({ path: join(process.env.SHOTS, 'formules-1-source-message.png') }); // SHOTS=<dossier> : captures de contrôle
    await shot('42-source-formules-message', 'modal');
    await warning.getByRole('button', { name: 'Annuler', exact: true }).click();
    assert.ok(!(await box.isChecked()), '« Annuler » : la case reste décochée');
    await box.click();
    await warning.getByRole('button', { name: 'Envoyer les formules', exact: true }).click();
    assert.ok(await box.isChecked(), 'cochée après le message');
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill('Budget');
    await dialogButton('Créer l’export').click();
    const code = await plainInvitation();
    assert.deepEqual((await sentColumns()).map(c => [c.id, c.fx]), [['Libelle', ''], ['Montant', ''], ['TVA', '$Montant * 0.2'], ['Fuite', 'import os\nreturn "ok"'], ['Pays', ''], ['Suivi', '']]);
    assert.deepEqual((await sentColumns()).map(c => c.fd), [undefined, undefined, undefined, undefined, '"France"', undefined], 'la formule par défaut part à part ; celle qui se recalcule ne part pas');
    const answer = await accept(dst.doc, dst.url, code, /Budget\s»\s:\stable/);
    await approve(answer, { url: src.url });
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => (await records(dst.doc, 'Budget')).length === 2, 'lignes reçues', 90000);
    assert.ok(!(await column(dst.doc, 'Budget', 'TVA')).isFormula && !(await column(dst.doc, 'Budget', 'Fuite')).isFormula, 'rien n\'est posé par la réception : les valeurs arrivent comme des données');
    const received = async () => (await records(dst.doc, 'Budget')).map(r => [r.Libelle, r.Montant, r.TVA, r.Fuite]).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(await received(), [['Assurance', 80, 16, 'ok'], ['Loyer', 100, 20, 'ok']]);
    step('Formules : la SOURCE les envoie derrière une case à part et son message (« Annuler » ne coche rien), la CIBLE reçoit les valeurs sans rien poser');

    // CIBLE : la liste des formules lues, avec ce qui s'oppose ; rien ne se pose sans la case « J'ai lu ».
    await button('Reprendre depuis la SOURCE').click();
    const formulas = dialog().getByRole('checkbox', { name: /Formules : poser celles de la SOURCE/ });
    assert.ok(!(await formulas.isChecked()), 'décochée d\'emblée');
    assert.match(await dialog().innerText(), /2\sformules à poser/, 'la formule de colonne et la formule par défaut ; celle qui cite os est refusée');
    await formulas.check();
    const panel = dialog().locator('.formulas-panel');
    assert.match(await panel.innerText(), /\$Montant \* 0\.2/);
    assert.match(await panel.innerText(), /import os/);
    assert.match(await panel.innerText(), /"France"/);
    assert.match(await panel.innerText(), /formule par défaut/);
    assert.ok(!/suivi/.test(await panel.innerText()), 'la formule qui se recalcule n\'est pas proposée');
    assert.match(await panel.innerText(), /contient\s«\sos\s», refusé dans une formule reçue/);
    assert.match(await panel.innerText(), /ne sera pas posée/);
    assert.ok(await dialogButton('Reprendre').isDisabled(), 'grisé tant que « J\'ai lu » n\'est pas coché');
    if (process.env.SHOTS) await dialog().screenshot({ path: join(process.env.SHOTS, 'formules-2-cible-liste.png') });
    await shot('43-cible-formules-liste', 'modal');
    await dialog().getByRole('checkbox', { name: /J’ai lu ces formules/ }).check();
    await dialogButton('Reprendre').click();
    await waitFor(async () => (await column(dst.doc, 'Budget', 'TVA')).isFormula === true, 'formule posée', 90000);
    assert.equal((await column(dst.doc, 'Budget', 'TVA')).formula, '$Montant * 0.2');
    assert.equal((await column(dst.doc, 'Budget', 'TVA')).type, 'Numeric');
    assert.equal((await column(dst.doc, 'Budget', 'Fuite')).isFormula, false, 'la formule refusée d\'office n\'est jamais posée');
    await waitFor(async () => (await column(dst.doc, 'Budget', 'Pays')).formula === '"France"', 'formule par défaut posée', 90000);
    const pays = await column(dst.doc, 'Budget', 'Pays');
    assert.deepEqual([pays.isFormula, pays.recalcWhen], [false, 0], 'la colonne reste de données, la formule ne joue que sur les nouvelles lignes');
    assert.equal((await column(dst.doc, 'Budget', 'Suivi')).formula, '', 'la formule qui se recalcule n\'est pas posée');
    assert.deepEqual(await received(), [['Assurance', 80, 16, 'ok'], ['Loyer', 100, 20, 'ok']], 'Grist calcule la TVA ici ; l\'autre colonne garde ses valeurs');
    step('Formules : « Reprendre depuis la SOURCE » les liste (colonne, texte Python, objections), grise le bouton jusqu\'à « J\'ai lu », pose celle qui n\'a pas d\'objection et refuse celle qui cite os');

    // Une ligne de plus arrive : la colonne de formule n'est pas recopiée (Grist refuserait), le reste l'est.
    await applyActions(src.doc, [['AddRecord', 'Budget', null, { Libelle: 'Eau', Montant: 50 }]]);
    await openWidgetTab(dst.url, 'Recevoir');
    await waitFor(async () => (await records(dst.doc, 'Budget')).length === 3, 'ligne de plus reçue sans erreur', 90000);
    assert.deepEqual(await received(), [['Assurance', 80, 16, 'ok'], ['Eau', 50, 10, 'ok'], ['Loyer', 100, 20, 'ok']]);
    assert.equal(await widget().locator('.msg.err, [role="alert"]').count(), 0, 'aucune erreur sur la carte');
    // Reprendre de nouveau : rien à poser.
    await button('Reprendre depuis la SOURCE').click();
    assert.match(await dialog().innerText(), /rien à poser pour le moment/);
    assert.ok(await dialog().getByRole('checkbox', { name: /Formules : poser celles de la SOURCE/ }).isDisabled());
    await dialogButton('Annuler').click();
    // La formule par défaut joue pour une ligne ajoutée ici à la main, pas pour les lignes reçues ; la ligne d'essai est retirée aussitôt.
    const [local] = (await api('POST', `/docs/${dst.doc}/apply`, [['AddRecord', 'Budget', null, { Libelle: 'Local', Montant: 1 }]])).retValues;
    const localRow = (await records(dst.doc, 'Budget')).find(r => r.id === local);
    assert.equal(localRow && localRow.Pays, 'France', 'la formule par défaut remplit la ligne ajoutée ici');
    await applyActions(dst.doc, [['RemoveRecord', 'Budget', local]]);
    assert.deepEqual(Object.fromEntries((await records(dst.doc, 'Budget')).filter(r => r.Libelle !== 'Local').map(r => [r.Libelle, r.Pays || ''])), { Loyer: '', Assurance: '', Eau: 'France' },
      'les lignes reçues gardent leur valeur : vide pour les deux d\'avant, celle que la formule de la SOURCE a remplie pour la nouvelle');
    step('Formules : une colonne devenue formule n\'est plus recopiée et ne casse rien, la reprise suivante n\'a plus rien à poser ; la formule par défaut remplit une ligne ajoutée ici');

    // SOURCE : décocher la case retire les formules de la description des colonnes.
    await openWidget(src.url);
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    const again = dialog().getByRole('checkbox', { name: /Envoyer aussi les formules des colonnes/ });
    assert.ok(await again.isChecked(), 'export modifié : telle que l\'export l\'est déjà');
    await again.uncheck();
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/Enregistré/).waitFor({ timeout: 60000 });
    await dialogButton('Fermer').click();
    assert.ok((await sentColumns()).every(c => c.fx === undefined && c.fd === undefined), 'plus de formule dans la description des colonnes');
    step('Formules : case décochée dans « Modifier », la SOURCE n\'envoie plus aucune formule');
  }
  // Pièces jointes d'un document par l'API REST : dépôt, lecture, et empreinte courte d'un contenu.
  function attachmentTools() {
    const auth = { Authorization: `Bearer ${env.apiKey}` };
    const upload = async (doc, name, bytes) => {
      const form = new FormData();
      form.append('upload', new Blob([bytes]), name);
      return (await (await fetch(`${TEAM}/api/docs/${doc}/attachments`, { method: 'POST', headers: auth, body: form })).json())[0];
    };
    const download = async (doc, id) => new Uint8Array(await (await fetch(`${TEAM}/api/docs/${doc}/attachments/${id}/download`, { headers: auth })).arrayBuffer());
    const sha = bytes => createHash('sha1').update(bytes).digest('hex').slice(0, 16);
    return { upload, download, sha };
  }
  // --- Pièces jointes : la liste des fichiers part avec les lignes, leur contenu quand la page
  // SOURCE est ouverte, une fois par destinataire, en morceaux ; la CIBLE dépose chaque fichier une
  // seule fois et remplit les cellules dès son arrivée.
  async function filesSteps() {
    const { upload, download, sha } = attachmentTools();
    const small = new TextEncoder().encode('bonjour');
    const big = Uint8Array.from({ length: 1300000 }, (_, i) => (i * 31 + (i >> 8)) % 251); // trois morceaux
    // Etat : liste de choix, que la CIBLE reprend (choix ajoutés plus tard compris).
    const etat = { choices: ['Ouvert', 'Clos'], choiceOptions: { Clos: { fillColor: '#FF0000' } } };
    const src = await newDocWithWidget('Fichiers SOURCE', [
      ['AddTable', 'Dossiers', [{ id: 'Nom', type: 'Text' }, { id: 'Piece', type: 'Attachments' }, { id: 'Etat', type: 'Choice', widgetOptions: JSON.stringify(etat) }]],
      ['BulkAddRecord', 'Dossiers', [null, null, null], { Nom: ['Un', 'Deux', 'Trois'], Etat: ['Ouvert', 'Clos', 'Ouvert'] }],
    ]);
    const etatOf = async doc => JSON.parse((await records(doc, '_grist_Tables_column')).find(c => c.colId === 'Etat').widgetOptions || '{}');
    const dst = await newDocWithWidget('Fichiers CIBLE');
    const dst2 = await newDocWithWidget('Fichiers CIBLE 2');
    // Trois ne cite pas le même dépôt que Un, mais le même contenu : un seul fichier part.
    const ids = [await upload(src.doc, 'bonjour.txt', small), await upload(src.doc, 'gros.bin', big), await upload(src.doc, 'copie.txt', small)];
    await applyActions(src.doc, [['BulkUpdateRecord', 'Dossiers', [1, 2, 3], { Piece: ids.map(id => ['L', id]) }]]);
    await startExport(src, 'Dossiers', 'Dossiers', async () => {
      await dialog().getByText(/Pièces jointes \(Piece\)\s:\sà cocher pour les envoyer/).waitFor();
      await dialog().getByRole('checkbox', { name: /Piece/ }).check();
      await shot('25-source-pieces-jointes', 'modal');
    });
    await dialogButton('Ajouter un destinataire').waitFor();
    const exportId = (await records(src.doc, 'Synchro'))[0].Synchro_Export;
    assert.deepEqual((await records(src.doc, 'Synchro')).map(r => r.Synchro_Type), ['cles', 'lot', 'suivi', 'fichiers'], 'une liste des fichiers, dans Synchro');
    const invite = async () => {
      await dialogButton('Créer l’invitation').click();
      await dialog().getByText('Transmettez ce code').waitFor();
      const code = await dialog().locator('textarea.code').first().inputValue();
      await dialogButton('Plus tard').click();
      return code;
    };
    await dialogButton('Ajouter un destinataire').click();
    const answer = await accept(dst.doc, dst.url, await invite(), '« Dossiers » : table Dossiers.');
    await approve(answer, { url: src.url });
    const sent = async () => (syncNoteOf((await records(src.doc, '_grist_Tables_column')).find(c => c.colId === 'Synchro_Export')).fichiers || {})[exportId] || { f: '', h: [] };
    await waitFor(async () => { const s = await sent(); return s.f === [sha(small), sha(big)].sort().join(' ') && s.h.length === 1; }, 'fichiers envoyés, page SOURCE ouverte', 60000);
    const piece = async (doc, nom) => (await records(doc, 'Dossiers')).find(r => r.Nom === nom).Piece;
    await openWidget(dst.url);
    await waitFor(async () => { const rows = await records(dst.doc, 'Dossiers'); return rows.length === 3 && rows.every(r => Array.isArray(r.Piece) && r.Piece.length === 2); }, 'cellules remplies', 60000);
    assert.equal((await records(dst.doc, '_grist_Tables_column')).find(c => c.colId === 'Piece').type, 'Attachments', 'une vraie colonne Pièces jointes');
    assert.equal((await records(dst.doc, '_grist_Attachments')).length, 2, 'un même contenu déposé une seule fois');
    assert.deepEqual(await download(dst.doc, (await piece(dst.doc, 'Deux'))[1]), big, 'gros fichier reconstitué à l\'identique');
    assert.deepEqual(await download(dst.doc, (await piece(dst.doc, 'Trois'))[1]), small);
    assert.equal((await rawRows(dst.doc, 'Journal_Dossiers')).length, 0, 'morceaux effacés du journal');
    assert.deepEqual(await etatOf(dst.doc), etat, 'liste de choix et couleurs reprises par la colonne créée ici');
    step('Pièces jointes : liste des fichiers avec les lignes, contenu envoyé page SOURCE ouverte (gros fichier en trois morceaux), déposé une fois, cellules remplies ; liste de choix reprise');

    // Page SOURCE fermée : un fichier remplacé est attendu, un fichier retiré l'est aussi ici.
    const later = new TextEncoder().encode('bonsoir');
    const laterId = await upload(src.doc, 'bonsoir.txt', later);
    await applyActions(src.doc, [['UpdateRecord', 'Dossiers', 1, { Piece: ['L', laterId] }], ['UpdateRecord', 'Dossiers', 2, { Piece: null }]]);
    await widget().getByText(/1 fichier attendu dans Dossiers/).waitFor({ timeout: 30000 });
    await widget().getByText('Incomplet', { exact: true }).waitFor();
    assert.equal(await piece(dst.doc, 'Deux'), null, 'fichier retiré dans la SOURCE : retiré ici');
    assert.equal(await piece(dst.doc, 'Un'), null, 'fichier remplacé, pas encore arrivé');
    await shot('26-cible-fichiers-attendus', 'card');
    // Un choix ajouté à la SOURCE s'ajoute ici, sans renvoi des lignes.
    const etatCol = (await records(src.doc, '_grist_Tables_column')).find(c => c.colId === 'Etat');
    await applyActions(src.doc, [['UpdateRecord', '_grist_Tables_column', etatCol.id, { widgetOptions: JSON.stringify({ ...etat, choices: [...etat.choices, 'Archivé'] }) }]]);
    await openWidget(src.url);
    await waitFor(async () => (await sent()).f.includes(sha(later)), 'fichier envoyé à l\'ouverture de la page SOURCE', 60000);
    await openWidget(dst.url);
    await waitFor(async () => { const p = await piece(dst.doc, 'Un'); return Array.isArray(p) && p.length === 2; }, 'cellule complétée à l\'arrivée du fichier', 60000);
    assert.deepEqual(await download(dst.doc, (await piece(dst.doc, 'Un'))[1]), later);
    await widget().getByText(/fichier attendu/).waitFor({ state: 'detached' });
    await waitFor(async () => (await etatOf(dst.doc)).choices.join() === 'Ouvert,Clos,Archivé', 'choix ajouté à la SOURCE repris ici');
    step('Pièces jointes : page SOURCE fermée, fichier remplacé attendu (signalé), retiré ici ; envoyé à l\'ouverture, cellule complétée ; choix ajouté repris');

    // Nouveau destinataire : il reçoit tous les fichiers, le premier rien de plus.
    await openWidget(src.url);
    await button('Ajouter un destinataire').click();
    const answer2 = await accept(dst2.doc, dst2.url, await invite(), '« Dossiers » : table Dossiers.');
    await approve(answer2, { url: src.url });
    await waitFor(async () => (await sent()).h.length === 2, 'second destinataire servi', 60000);
    await openWidget(dst2.url);
    await waitFor(async () => { const rows = await records(dst2.doc, 'Dossiers'); return rows.length === 3 && rows.filter(r => Array.isArray(r.Piece)).length === 2; }, 'second destinataire : fichiers reçus', 60000);
    assert.deepEqual(await download(dst2.doc, (await piece(dst2.doc, 'Un'))[1]), later);
    assert.equal((await records(dst.doc, '_grist_Attachments')).length, 3, 'le premier destinataire ne reçoit rien de plus');
    step('Pièces jointes : un nouveau destinataire reçoit tous les fichiers');
  }
  // --- Pièces jointes dans les deux sens d'un Échange : les fichiers de B arrivent chez A comme ceux de A
  // chez B ; un fichier reçu du partenaire ne lui est pas renvoyé ; une ligne attend ses fichiers avant
  // d'être recopiée (sinon une cellule incomplète repartirait vers les autres) ; à plusieurs, un fichier de B
  // va chez C par A, sans copie pour B.
  async function exchangeFilesSteps() {
    const { upload, download, sha } = attachmentTools();
    const text = value => new TextEncoder().encode(value);
    const medium = Uint8Array.from({ length: 600000 }, (_, i) => (i * 37 + (i >> 8)) % 253); // deux morceaux
    const a = await newDocWithWidget('Échange fichiers A', [
      ['AddTable', 'Dossiers', [{ id: 'Nom', type: 'Text' }, { id: 'Statut', type: 'Text' }, { id: 'Piece', type: 'Attachments' }]],
      ['BulkAddRecord', 'Dossiers', [null, null], { Nom: ['Un', 'Deux'], Statut: ['ouvert', 'ouvert'] }],
    ]);
    const b = await newDocWithWidget('Échange fichiers B');
    const c = await newDocWithWidget('Échange fichiers C');
    const hello = text('bonjour');
    const ids = [await upload(a.doc, 'bonjour.txt', hello), await upload(a.doc, 'moyen.bin', medium)];
    await applyActions(a.doc, [['BulkUpdateRecord', 'Dossiers', [1, 2], { Piece: ids.map(id => ['L', id]) }]]);
    await startExport(a, 'Dossiers', 'Partage', async () => {
      await dialog().getByText(/Pièces jointes \(Piece\)\s:\sà cocher pour les envoyer/).waitFor();
      await dialog().getByRole('checkbox', { name: /Piece/ }).check();
    });
    await dialogButton('Ajouter un destinataire').click();
    await dialog().getByRole('radio', { name: /Échange/ }).check();
    await dialogButton('Créer l’invitation').click();
    const { form: back, code } = await returnInvitation(a);
    const exportId = (await records(a.doc, 'Synchro'))[0].Synchro_Export;
    const answer = await accept(b.doc, b.url, code, '« Partage » : table Dossiers.');
    await approve(answer, { url: a.url });
    const journalOf = async doc => (await records(doc, '_grist_Tables')).find(tb => tb.tableId.startsWith('Journal_')).tableId;
    const aJournal = await journalOf(a.doc);
    const bJournal = await journalOf(b.doc);
    // Morceaux de fichiers vus passer dans un journal (ils y sont effacés une fois le fichier déposé).
    const spy = (doc, journal) => {
      const seen = new Set();
      let on = true;
      (async () => {
        while (on) {
          for (const r of await rawRows(doc, journal).catch(() => [])) if (r.Synchro_Type === 'fichier') seen.add(r.id);
          await new Promise(r => setTimeout(r, 300).unref());
        }
      })();
      return { seen: () => seen.size, stop: () => { on = false; } };
    };
    // La note SOURCE est dans les options de Synchro_Export de la table Synchro (les journaux ont la même colonne).
    const noted = async doc => {
      const note = (await records(doc, '_grist_Tables_column')).filter(col => col.colId === 'Synchro_Export').map(syncNoteOf).find(n => n.exports) || {};
      return (note.fichiers || {})[exportId] || { f: '', h: [], o: {} };
    };
    const dossiers = async doc => Object.fromEntries((await records(doc, 'Dossiers')).map(r => [r.Nom, r]));
    // Ajoute un fichier à la cellule Piece du dossier `nom` de `doc`.
    const addPiece = async (doc, nom, fileName, content) => {
      const id = await upload(doc, fileName, content);
      const row = (await dossiers(doc))[nom];
      await applyActions(doc, [['UpdateRecord', 'Dossiers', row.id, { Piece: [...row.Piece, id] }]]);
    };
    const pieces = async (doc, nom) => ((await dossiers(doc))[nom] || {}).Piece;
    // Ouvre le widget du document `w` et attend que `ok()` soit vrai.
    const seenIn = async (w, ok, what) => { await openWidget(w.url); return waitFor(ok, what, 60000); };
    const filesOf = async (doc, nom) => { const p = await pieces(doc, nom); return Array.isArray(p) ? p.slice(1) : []; };
    // A vers B : les fichiers de A arrivent chez B, qui n'en renvoie aucun.
    const toA = spy(a.doc, aJournal);
    // La page de A, ouverte, envoie ses fichiers (rattrapage d'un propriétaire) ; puis B les dépose.
    await waitFor(async () => { const n = await noted(a.doc); return n.f === [sha(hello), sha(medium)].sort().join(' ') && n.h.length === 1; }, 'A envoie ses fichiers, page ouverte', 90000);
    await openWidget(b.url);
    await waitFor(async () => (await filesOf(b.doc, 'Un')).length === 1 && (await filesOf(b.doc, 'Deux')).length === 1, 'B reçoit les fichiers de A', 90000);
    assert.deepEqual(await download(b.doc, (await filesOf(b.doc, 'Deux'))[0]), medium, 'fichier de deux morceaux reconstitué chez B');
    // La page de B reste ouverte : son rattrapage passe plusieurs fois (toutes les 10 s) sans rien renvoyer.
    await waitFor(async () => { const n = await noted(b.doc); return n.f === [sha(hello), sha(medium)].sort().join(' ') && n.h.length === 1; }, 'B : fichiers reçus notés comme déjà chez A', 60000);
    assert.deepEqual(Object.values((await noted(b.doc)).o || {}).map(s => s.split(' ').sort().join(' ')), [[sha(hello), sha(medium)].sort().join(' ')], 'B : ce que A a envoyé est noté chez A');
    await new Promise(r => setTimeout(r, 25000));
    assert.equal(toA.seen(), 0, 'les fichiers de A ne repartent pas vers A');
    assert.equal((await records(a.doc, '_grist_Attachments')).length, 2);
    step('Échange et pièces jointes : les fichiers de A arrivent chez B, qui ne les renvoie pas à A');

    // B ajoute un fichier en changeant aussi le statut : A reçoit la version tout de suite, mais la ligne attend
    // son fichier (B n'a pas sa page ouverte) ; elle est recopiée, statut compris, quand le fichier est arrivé.
    toA.stop();
    const extra = text('pièce de B');
    const extraId = await upload(b.doc, 'de-b.txt', extra);
    const bUn = (await dossiers(b.doc)).Un;
    await applyActions(b.doc, [['UpdateRecord', 'Dossiers', bUn.id, { Statut: 'à revoir', Piece: [...bUn.Piece, extraId] }]]);
    await openWidgetTab(a.url, 'Recevoir');
    await widget().getByText(/1 ligne attend son fichier avant d.être recopiée dans Dossiers/).waitFor({ timeout: 60000 });
    await widget().getByText('Incomplet', { exact: true }).waitFor();
    assert.equal((await dossiers(a.doc)).Un.Statut, 'ouvert', 'la ligne attend son fichier : rien n\'est recopié');
    assert.equal((await filesOf(a.doc, 'Un')).length, 1, 'cellule de A inchangée');
    await openWidget(b.url);
    await waitFor(async () => (await noted(b.doc)).f.includes(sha(extra)), 'B envoie le fichier à l\'ouverture de sa page', 60000);
    await openWidget(a.url);
    await waitFor(async () => (await dossiers(a.doc)).Un.Statut === 'à revoir' && (await filesOf(a.doc, 'Un')).length === 2, 'A recopie la ligne avec le fichier de B', 60000);
    const aUn = await filesOf(a.doc, 'Un');
    assert.deepEqual(await download(a.doc, aUn[aUn.length - 1]), extra, 'fichier de B reconstitué chez A');
    await widget().getByRole('tab', { name: 'Recevoir' }).click();
    await widget().getByText(/attend son fichier/).waitFor({ state: 'detached' });
    step('Échange et pièces jointes : une ligne de B attend son fichier chez A, puis est recopiée avec lui');

    // A modifie la même ligne : B garde ses fichiers (la modification de A ne remplace plus sa cellule).
    await applyActions(a.doc, [['UpdateRecord', 'Dossiers', (await dossiers(a.doc)).Un.id, { Statut: 'clos' }]]);
    await openWidget(b.url);
    await waitFor(async () => (await dossiers(b.doc)).Un.Statut === 'clos', 'B reçoit la modification de A', 60000);
    assert.equal((await filesOf(b.doc, 'Un')).length, 2, 'B garde ses deux fichiers');
    // B retire son fichier : A le retire aussi (tous les fichiers de la version sont là : pas d'attente).
    await applyActions(b.doc, [['UpdateRecord', 'Dossiers', (await dossiers(b.doc)).Un.id, { Piece: ['L', (await filesOf(b.doc, 'Un'))[0]] }]]);
    await seenIn(a, async () => (await filesOf(a.doc, 'Un')).length === 1, 'A retire le fichier retiré chez B');
    step('Échange et pièces jointes : la modification de A ne défait pas la cellule de B, un fichier retiré chez B l\'est chez A');

    // A ajoute un fichier : B le reçoit, ne le renvoie pas.
    const later = text('envoi de A');
    await addPiece(a.doc, 'Deux', 'de-a.txt', later);
    const toA2 = spy(a.doc, aJournal);
    await openWidget(a.url);
    await waitFor(async () => (await noted(a.doc)).f.includes(sha(later)), 'A envoie son nouveau fichier', 60000);
    await openWidget(b.url);
    await waitFor(async () => (await filesOf(b.doc, 'Deux')).length === 2, 'B reçoit le nouveau fichier de A', 60000);
    await waitFor(async () => (await noted(b.doc)).f.includes(sha(later)), 'B note le fichier de A comme déjà chez A', 60000);
    await new Promise(r => setTimeout(r, 25000));
    assert.equal(toA2.seen(), 0, 'le fichier reçu de A ne repart pas');
    toA2.stop();
    step('Échange et pièces jointes : un fichier ajouté chez A arrive chez B sans repartir');

    // Échange à plusieurs : C rejoint ; ce que B ajoute arrive chez C par A, et B n'en reçoit pas de copie.
    await openWidget(a.url);
    await button('Ajouter un participant').click();
    await dialogButton('Créer l’invitation').click();
    const { code: codeC } = await returnInvitation(a, [back]);
    const answerC = await accept(c.doc, c.url, codeC, '« Partage » : table Dossiers.');
    await approve(answerC, { url: a.url });
    // La page de A, ouverte, envoie à C tous les fichiers (B les a, il n'en reçoit pas) ; puis C les dépose.
    await waitFor(async () => (await noted(a.doc)).h.length === 2, 'A envoie ses fichiers à C, page ouverte', 120000);
    await openWidget(c.url);
    await waitFor(async () => (await filesOf(c.doc, 'Un')).length === 1 && (await filesOf(c.doc, 'Deux')).length === 2, 'C reçoit tous les fichiers de A', 120000);
    const viaA = text('pièce de B pour C');
    await addPiece(b.doc, 'Un', 'pour-c.txt', viaA);
    const intoB = spy(b.doc, bJournal);
    await openWidget(b.url);
    await waitFor(async () => (await noted(b.doc)).f.includes(sha(viaA)), 'B envoie son fichier à A', 60000);
    await openWidget(a.url);
    await waitFor(async () => (await filesOf(a.doc, 'Un')).length === 2, 'A recopie la ligne avec le fichier de B', 60000);
    await waitFor(async () => { const n = await noted(a.doc); return n.f.includes(sha(viaA)) && n.h.length === 2; }, 'A envoie le fichier de B à C, et note que B l\'a', 60000);
    await openWidget(c.url);
    await waitFor(async () => (await filesOf(c.doc, 'Un')).length === 2, 'C reçoit le fichier de B', 60000);
    const cUn = await filesOf(c.doc, 'Un');
    assert.deepEqual(await download(c.doc, cUn[cUn.length - 1]), viaA, 'fichier de B reconstitué chez C');
    assert.equal(intoB.seen(), 0, 'B ne reçoit pas de copie de son propre fichier');
    intoB.stop();
    assert.ok(Object.values((await noted(a.doc)).o || {}).some(s => s.includes(sha(viaA))), 'A : le fichier de B est noté chez B');
    step('Échange à plusieurs et pièces jointes : le fichier de B arrive chez C par A, sans copie pour B');
  }
  // --- Table Synchro remise en état. Cas vu avec l'Alpha 0.5.9 : une table Synchro faite à la main (colonnes A, B et C
  // de Grist) reprise par le widget ; chaque envoi emportait A, le journal du destinataire le refusait (« Invalid column »)
  // et la file se bloquait. D'abord une table du widget qui porte des colonnes en trop (envoi bloqué, carte, fenêtre qui
  // dit ce que les colonnes contiennent, file débloquée ensuite), puis une table Synchro qui n'est pas la sienne (jamais
  // reprise, renommée avec l'accord de la personne).
  async function straySteps() {
    const src = await fichesDoc('Colonnes en trop SOURCE');
    const dst = await newDocWithWidget('Colonnes en trop CIBLE');
    await startExport(src, 'Fiches', 'Annuaire');
    const code = await plainInvitation();
    await approve(await accept(dst.doc, dst.url, code, '« Annuaire » : table Fiches.'), { url: src.url });
    await openWidget(dst.url);
    const fiches = async () => Object.fromEntries((await records(dst.doc, 'Fiches')).map(r => [r.Nom, r]));
    await waitFor(async () => Object.keys(await fiches()).length === 3, 'fiches reçues', 60000);
    const syncColumns = async (doc) => {
      const parent = await tableRef(doc, 'Synchro');
      return (await records(doc, '_grist_Tables_column')).filter(c => c.parentId === parent && c.colId !== 'manualSort').map(c => c.colId);
    };
    const WIDGET_COLUMNS = ['Sync_Etat', 'Sync_Par', 'Synchro_Colonnes', 'Synchro_Export', 'Synchro_Ids', 'Synchro_Lot', 'Synchro_Renvoi', 'Synchro_Table', 'Synchro_Type'];
    assert.deepEqual((await syncColumns(src.doc)).sort(), WIDGET_COLUMNS, 'neuf colonnes à la création');
    // Trois colonnes ajoutées à la main (A, B, C), B avec une valeur, puis un changement : l'envoi emporte A, refusé.
    const lot = (await records(src.doc, 'Synchro')).find(r => r.Synchro_Type === 'lot');
    await applyActions(src.doc, [['AddColumn', 'Synchro', 'A', { type: 'Any' }], ['AddColumn', 'Synchro', 'B', { type: 'Text' }], ['AddColumn', 'Synchro', 'C', { type: 'Any' }]]);
    await applyActions(src.doc, [['UpdateRecord', 'Synchro', lot.id, { B: 'à garder' }], ['UpdateRecord', 'Fiches', 1, { Nom: 'Anna2' }]]);
    const hooks = async () => (await api('GET', `/docs/${src.doc}/webhooks`)).webhooks;
    await waitFor(async () => (await hooks()).some(h => /Invalid column/.test((h.usage || {}).lastErrorMessage || '')), 'envoi refusé par le journal (Invalid column)', 60000);
    // L'onglet Envoyer : la carte, et la fenêtre qui s'ouvre d'elle-même.
    await openWidget(src.url);
    await dialog().getByText('Retirer les colonnes en trop ?').waitFor({ timeout: 30000 });
    await dialog().getByText(/Ces colonnes seront retirées de la table Synchro/).waitFor();
    for (const line of [/^A \(Quelconque\)\s:\svide$/, /^B \(Texte\)\s:\s1 cellule remplie$/, /^C \(Quelconque\)\s:\svide$/]) await dialog().locator('.stray-list li').filter({ hasText: line }).waitFor();
    await dialog().getByText(/Cette colonne contient des valeurs ou une formule \(B\).*sauvegardez-la/).waitFor();
    await dialog().getByText(/Des envois sont bloqués à cause de ces colonnes/).waitFor();
    assert.ok(await dialogButton('Retirer').isDisabled(), 'des valeurs à perdre : la case « sauvegardé » d\'abord');
    await shot('31-source-colonnes-en-trop');
    await dialogButton('Plus tard').click();
    await dialog().waitFor({ state: 'detached' });
    assert.deepEqual((await syncColumns(src.doc)).sort(), [...WIDGET_COLUMNS, 'A', 'B', 'C'].sort(), '« Plus tard » ne retire rien');
    const card = widget().locator('.card[data-stray]');
    await card.getByText(/Le widget y trouve 3 colonnes de plus\s:\sA, B, C/).waitFor();
    await card.getByText(/Contient des valeurs ou une formule\s:\sB/).waitFor();
    await widget().getByText(/à cause de la colonne «\sA\s» de la table Synchro de ce document/).waitFor({ timeout: 30000 });
    assert.equal(await widget().getByText(/ouvrir la page de son widget/).count(), 0, 'le texte ne renvoie plus vers la CIBLE');
    // Retirer, après avoir dit qu'on a sauvegardé : les trois colonnes partent, la file est vidée, tout est renvoyé.
    await card.getByRole('button', { name: 'Voir et retirer', exact: true }).click();
    await dialog().getByRole('checkbox', { name: /J’ai sauvegardé/ }).check();
    await dialogButton('Retirer').click();
    await dialog().waitFor({ state: 'detached' });
    await widget().getByText('Colonnes retirées de la table Synchro.').waitFor();
    assert.deepEqual((await syncColumns(src.doc)).sort(), WIDGET_COLUMNS, 'seules les colonnes du widget restent');
    assert.equal(await widget().locator('.card[data-stray]').count(), 0, 'la carte disparaît');
    await openWidget(dst.url);
    await waitFor(async () => (await fiches()).Anna2, 'envois repris après le retrait (Anna2 reçue)', 120000);
    assert.equal((await records(src.doc, 'Fiches')).length, 3);
    // Une colonne vide ajoutée plus tard : la fenêtre le dit, et n'exige rien.
    await applyActions(src.doc, [['AddColumn', 'Synchro', 'D', { type: 'Any' }]]);
    await openWidget(src.url);
    await dialog().getByText(/Cette colonne sera retirée de la table Synchro/).waitFor({ timeout: 30000 });
    await dialog().getByText('Elle est vide : rien ne sera perdu.').waitFor();
    assert.equal(await dialog().getByRole('checkbox').count(), 0, 'rien à sauvegarder : pas de case');
    assert.equal(await dialog().getByText(/Des envois sont bloqués/).count(), 0, 'aucun envoi bloqué : la file n\'est pas touchée');
    await dialogButton('Retirer').click();
    await dialog().waitFor({ state: 'detached' });
    assert.deepEqual((await syncColumns(src.doc)).sort(), WIDGET_COLUMNS);
    step('Colonnes en trop dans Synchro : envoi refusé (« Invalid column »), carte et fenêtre (colonnes, valeurs, sauvegarde demandée), « Plus tard » ne retire rien, retrait puis file débloquée et envois repris ; colonne vide sans case');

    // Une table Synchro qui n'est pas celle du widget : sa page est celle du widget (Table1 renommée Synchro, A, B, C).
    const mine = await newDocWithWidget('Table Synchro d\'une autre personne', [
      ['AddTable', 'Fiches', [{ id: 'Nom', type: 'Text' }]], ['AddRecord', 'Fiches', null, { Nom: 'Anna' }],
    ]);
    await applyActions(mine.doc, [['RenameTable', 'Table1', 'Synchro']]);
    await openWidget(mine.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await dialog().getByText('Une table nommée Synchro existe déjà').waitFor({ timeout: 30000 });
    await dialog().getByText(/Votre table Synchro\s:\s3 colonnes \(A, B, C\), 0 ligne/).waitFor();
    assert.equal(await dialog().getByLabel('Nouveau nom de votre table').inputValue(), 'Table_Synchro');
    await shot('32-source-table-existante');
    await dialogButton('Plus tard').click();
    await dialog().waitFor({ state: 'detached' });
    assert.deepEqual((await syncColumns(mine.doc)).sort(), ['A', 'B', 'C'], 'la table d\'une autre personne n\'est pas reprise : aucune colonne ajoutée');
    assert.ok(await button('Nouvel export').isDisabled(), 'pas d\'export tant que le nom n\'est pas libre');
    await widget().locator('.card[data-foreign]').getByRole('button', { name: 'Renommer la table', exact: true }).click();
    await dialog().getByLabel('Nouveau nom de votre table').fill('Ma table');
    await dialogButton('Renommer ma table').click();
    await dialog().getByText(/lettres sans accent/).waitFor();
    await dialog().getByLabel('Nouveau nom de votre table').fill('Table_Synchro');
    await dialogButton('Renommer ma table').click();
    await dialog().waitFor({ state: 'detached' });
    await widget().getByText(/Table renommée/).waitFor();
    const names = (await records(mine.doc, '_grist_Tables')).map(tb => tb.tableId);
    assert.deepEqual([names.includes('Synchro'), names.includes('Table_Synchro')], [false, true], 'la table est renommée');
    assert.equal((await api('GET', `/docs/${mine.doc}/tables/Table_Synchro/columns`)).columns.map(c => c.id).join(), 'A,B,C', 'elle garde ses colonnes');
    await newExport('Fiches', 'Annuaire');
    await widget().getByText('Export « Annuaire » créé.').waitFor();
    assert.deepEqual((await syncColumns(mine.doc)).sort(), WIDGET_COLUMNS, 'le widget crée sa propre table Synchro');
    assert.equal((await api('GET', `/docs/${mine.doc}/tables/Table_Synchro/columns`)).columns.map(c => c.id).join(), 'A,B,C', 'celle de l\'autre personne n\'a pas bougé');
    step('Table Synchro d\'une autre personne : jamais reprise, fenêtre qui propose de la renommer (nom invalide refusé), le widget crée ensuite la sienne');

    // Installations d'avant : le widget est posé sur la table Synchro elle-même. Supprimer le dernier export ne doit
    // pas effacer la table, donc la page du widget.
    const section = (await records(mine.doc, '_grist_Views_section')).find(sc => sc.parentKey === 'custom');
    await applyActions(mine.doc, [['UpdateRecord', '_grist_Views_section', section.id, { tableRef: await tableRef(mine.doc, 'Synchro') }]]);
    await openWidgetTab(mine.url, 'Envoyer');
    await button('Supprimer').click();
    await dialogButton('Supprimer').click();
    await widget().getByText(/^Aucun export\./).waitFor({ timeout: 30000 });
    assert.ok((await records(mine.doc, '_grist_Tables')).some(tb => tb.tableId === 'Synchro'), 'la table sur laquelle est posé le widget reste');
    assert.equal((await records(mine.doc, 'Synchro')).filter(r => r.Synchro_Type !== 'charge').length, 0, 'sans ligne d\'export');
    await newExport('Fiches', 'Autre export');
    await widget().getByText('Export « Autre export » créé.').waitFor();
    step('Widget posé sur la table Synchro : supprimer le dernier export garde la table et la page, un nouvel export repart');
  }
  // --- Le document de l'autre côté : son nom et un lien (nouvel onglet) sur la ligne du destinataire (SOURCE), la
  // carte de réception et l'assistant (CIBLE). Le widget ne peut pas lire le nom de son document (getDocName rend
  // l'identifiant, la fiche REST est refusée au jeton) : la SOURCE le saisit, une fois, et peut le corriger.
  async function docLinkSteps() {
    const src = await fichesDoc('Lien SOURCE');
    const dst = await newDocWithWidget('Lien CIBLE');
    const shortId = doc => doc.slice(0, 12);
    // Un clic sur le lien ouvre le document voulu dans un nouvel onglet (les liens du widget ne quittent pas Grist).
    // Le document doit s'ouvrir vraiment (son titre dans l'onglet) : une mauvaise équipe ou un mauvais identifiant donne
    // « Page non trouvée ».
    const opensDoc = async (link, doc, title) => {
      const [tab] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      await tab.waitForURL(url => url.pathname.startsWith(`/o/${env.team}/${shortId(doc)}`), { timeout: 60000 });
      await tab.waitForFunction(name => document.title.startsWith(name), title, { timeout: 60000 });
      await tab.close();
    };
    // SHOTS=<dossier> : captures de contrôle (pas celles du README).
    // Une carte redessinée pendant la prise de vue (toutes les 10 s) : la capture se refait, sans faire échouer le test.
    const keep = async (name, locator) => {
      for (let i = 0; process.env.SHOTS && i < 3; i++) {
        try { await locator.screenshot({ path: join(process.env.SHOTS, `${name}.png`), timeout: 5000 }); return; } catch (e) { await page.waitForTimeout(500); }
      }
    };
    await startExport(src, 'Fiches', 'Annuaire');
    await dialogButton('Ajouter un destinataire').click();
    const nameField = dialog().getByLabel('Nom de ce document');
    assert.equal(await nameField.inputValue(), '', 'rien à lire : le nom du document n\'est pas donné au widget, le champ attend la saisie');
    await dialog().locator('p.muted.small', { hasText: 'Grist ne permet pas au widget de lire le nom du document' }).waitFor(); // l'aide du tutoriel le redit : une seule phrase du champ
    await nameField.fill('Lien SOURCE <i>saisi</i> & co');
    await keep('28-source-nom-du-document', dialog());
    await dialogButton('Créer l’invitation').click();
    await dialog().getByText('Transmettez ce code').waitFor();
    const code = await dialog().locator('textarea.code').first().inputValue();
    assert.equal(JSON.parse(Buffer.from(code.slice('GRISTSYNC2.'.length), 'base64url')).from.docName, 'Lien SOURCE <i>saisi</i> & co', 'le nom part dans l\'invitation');
    await dialogButton('Plus tard').click();
    await rulesSettled(src.doc);
    // Le nom est gardé pour l'invitation suivante, et se corrige.
    await button('Ajouter un destinataire').click();
    assert.equal(await dialog().getByLabel('Nom de ce document').inputValue(), 'Lien SOURCE <i>saisi</i> & co', 'nom retenu, proposé de nouveau');
    await dialogButton('Annuler').click();

    // CIBLE : la fiche de l'invitation montre le document en lien, avant toute écriture.
    await pasteInvitation(dst.url, code);
    await dialog().getByText('« Annuaire » : table Fiches.').waitFor();
    const wizardLink = dialog().locator('a.doc-link');
    assert.equal(await wizardLink.count(), 1);
    const wizardHref = await wizardLink.getAttribute('href');
    assert.ok(wizardHref.startsWith(`${TEAM}/${shortId(src.doc)}`) && wizardHref.endsWith('/Lien-SOURCE-i-saisi-i-co'), `adresse refaite comme Grist l'écrit : instance et équipe de ce document, identifiant de la SOURCE, nom (${wizardHref})`);
    assert.deepEqual([await wizardLink.getAttribute('target'), await wizardLink.getAttribute('rel')], ['_blank', 'noopener noreferrer']);
    assert.equal(await wizardLink.evaluate(a => a.firstChild.textContent), 'Lien SOURCE <i>saisi</i> & co', 'le nom est du texte, jamais du HTML');
    assert.equal(await wizardLink.locator('i').count(), 0);
    await keep('29-cible-document-source', dialog());
    await dialogButton('Annuler').click();

    const answer = await accept(dst.doc, dst.url, code, '« Annuaire » : table Fiches.');
    await approve(answer, { url: src.url });

    // CIBLE : la carte de réception.
    await openWidgetTab(dst.url, 'Recevoir');
    const cardLink = widget().locator('.card a.doc-link');
    await cardLink.waitFor();
    assert.equal(await cardLink.evaluate(a => a.firstChild.textContent), 'Lien SOURCE <i>saisi</i> & co');
    assert.ok((await cardLink.getAttribute('href')).startsWith(`${TEAM}/${shortId(src.doc)}`) && (await cardLink.getAttribute('href')).endsWith('/Lien-SOURCE-i-saisi-i-co'));
    assert.match(await cardLink.getAttribute('title'), /Ouvrir le document dans un nouvel onglet — Nom indiqué par la SOURCE, non vérifié/);
    assert.equal(await cardLink.locator('.sr-only').textContent(), ' (s’ouvre dans un nouvel onglet)');
    await widget().getByText(`Données de ${env.email}`).waitFor();
    await keep('30-cible-carte-document', widget().locator('.card').first());
    await opensDoc(cardLink, src.doc, 'Lien SOURCE');
    assert.ok(await widget().locator('.card').isVisible(), 'l\'onglet du widget est resté en place');

    // SOURCE : la ligne du destinataire, avec le nom du document vu chez Grist.
    await openWidgetTab(src.url, 'Envoyer');
    const personLink = widget().locator('.person .person-who a.doc-link');
    await personLink.waitFor();
    assert.equal(await personLink.evaluate(a => a.firstChild.textContent), `${env.team}/Lien CIBLE`, 'équipe/nom du document, comme la fiche');
    assert.ok((await personLink.getAttribute('href')).startsWith(`${TEAM}/${shortId(dst.doc)}`) && (await personLink.getAttribute('href')).endsWith('/Lien-CIBLE'));
    assert.deepEqual([await personLink.getAttribute('target'), await personLink.getAttribute('rel')], ['_blank', 'noopener noreferrer']);
    assert.ok(!(await widget().locator('.person .person-who').innerText()).includes(shortId(dst.doc)), 'l\'identifiant brut reste dans l\'infobulle');
    await keep('31-source-document-destinataire', widget().locator('.card').first());
    await opensDoc(personLink, dst.doc, 'Lien CIBLE');
    step('Document de l\'autre côté : nom saisi côté SOURCE (retenu, corrigeable), lien dans un nouvel onglet des deux côtés, jamais de HTML');

    // Coller l'adresse de la page (barre d'adresse du navigateur) à la place du nom : le nom y est lu, tel que Grist l'écrit (sans
    // accents ni ponctuation), et refusé si l'adresse n'est pas celle de ce document ; l'adresse elle-même n'est jamais gardée.
    const pageAddress = page.url();
    assert.ok(pageAddress.startsWith(`${TEAM}/${shortId(src.doc)}/Lien-SOURCE`), `l'adresse de la page de la SOURCE (${pageAddress})`);
    await button('Ajouter un destinataire').click();
    const pasteField = dialog().getByLabel('Nom de ce document');
    const pasted = async (text) => { await pasteField.fill(text); return pasteField.inputValue(); };
    assert.equal(await pasted(pageAddress), 'Lien SOURCE', 'adresse collée : le nom est lu à sa place');
    await dialog().getByText('Nom lu dans l’adresse de la page').waitFor();
    await keep('28b-source-nom-lu-dans-adresse', dialog());
    assert.equal(await pasted(`${TEAM}/${shortId(dst.doc)}/Lien-CIBLE`), '', 'l\'adresse d\'un autre document ne donne pas son nom');
    await dialog().getByText('Cette adresse n’est pas celle de ce document').waitFor();
    assert.equal(await pasted(`https://example.org/o/${env.team}/${shortId(src.doc)}/Lien-SOURCE`), '', 'ni celle d\'un autre site');
    await dialog().getByText('Cette adresse est celle d’un autre site Grist').waitFor();
    assert.equal(await pasted(`${TEAM}/doc/${shortId(src.doc)}`), '', 'une adresse sans nom (forme /doc/)');
    await dialog().getByText('Cette adresse ne contient pas le nom du document').waitFor();
    assert.equal(await pasted(TEAM), '', 'ni une adresse sans document');
    await dialog().getByText('Adresse non reconnue').waitFor();
    assert.equal(await pasted('Un nom tapé <b>tel quel</b>'), 'Un nom tapé <b>tel quel</b>', 'un nom tapé reste intact');
    assert.equal(await dialog().getByText('Adresse non reconnue').isVisible(), false, 'et l\'avis disparaît');
    assert.equal(await pasted(pageAddress), 'Lien SOURCE');
    await dialogButton('Créer l’invitation').click();
    await dialog().getByText('Transmettez ce code').waitFor();
    const readCode = await dialog().locator('textarea.code').first().inputValue();
    const readFrom = JSON.parse(Buffer.from(readCode.slice('GRISTSYNC2.'.length), 'base64url')).from;
    assert.equal(readFrom.docName, 'Lien SOURCE', 'le nom lu dans l\'adresse part dans l\'invitation');
    assert.ok(!JSON.stringify(readFrom).includes('http'), 'jamais l\'adresse de la page');
    await dialogButton('Plus tard').click();
    step('Nom du document : l\'adresse de la page collée donne le nom (sans accents), refusée pour un autre document, un autre site ou sans nom, jamais gardée');
  }

  // --- Deux documents ouverts dans deux onglets du même navigateur : l'invitation et la réponse passent d'un
  // widget à l'autre sans copier-coller (js/tab-link.js). Le lien du formulaire, lui, reste à coller (Grist ne le
  // donne pas à un widget). Rien n'est écrit chez la CIBLE avant « Recevoir », le moteur juge le code comme s'il
  // était collé, et la personne approuve sur la fiche de la réponse.
  async function tabSteps() {
    // Les pages de tous les onglets du navigateur écoutent le canal : celle des étapes d'avant, restée sur un document
    // avec le widget, répondrait à la place du silence qu'on veut voir.
    await page.goto('about:blank');
    const src = await fichesDoc('Onglets SOURCE');
    const dst = await newDocWithWidget('Onglets CIBLE');
    const openTab = async (url) => {
      const tab = await context.newPage();
      const watch = (m) => { if (m.type() === 'error' && (m.location().url || '').startsWith(widgetCode)) errors.push(`${m.text()} (${m.location().url})`); };
      tab.on('console', watch);
      tab.on('pageerror', (e) => { if ((e.stack || '').includes(widgetCode)) errors.push(`${e.message} (pageerror)`); });
      await tab.goto(url);
      const frame = tab.frameLocator('iframe').first();
      await frame.locator('.topbar').waitFor({ timeout: 30000 });
      return { tab, frame, dialog: frame.getByRole('dialog'), button: name => frame.getByRole('button', { name, exact: true }) };
    };
    const dlgButton = (x, name) => x.dialog.getByRole('button', { name, exact: true });
    // TAB_SHOTS=<dossier> : une capture de chaque écran du parcours, pour le relire à l'œil.
    const snap = async (x, name) => { if (process.env.TAB_SHOTS) await x.tab.screenshot({ path: join(process.env.TAB_SHOTS, `${name}.png`) }); };
    const A = await openTab(src.url);
    const sameDocTab = await openTab(src.url); // un autre onglet du même document que la SOURCE
    await A.frame.locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await A.button('Nouvel export').click();
    await A.dialog.getByRole('checkbox', { name: 'Fiches' }).check();
    await dlgButton(A, 'Continuer').click();
    await dlgButton(A, 'Continuer').click();
    await A.dialog.getByLabel('Nom de l’export').fill('Annuaire');
    await dlgButton(A, 'Créer l’export').click();
    await A.dialog.getByText('Export « Annuaire » créé.').waitFor();
    await dlgButton(A, 'Ajouter un destinataire').click();
    await dlgButton(A, 'Créer l’invitation').click();
    await A.dialog.getByText('Transmettez ce code').waitFor();
    const invitationCode = await A.dialog.locator('textarea.code').first().inputValue();
    const tabButton = A.dialog.getByRole('button', { name: 'Envoyer à un document ouvert dans ce navigateur', exact: true });
    await tabButton.waitFor();
    assert.ok(await A.dialog.locator('textarea.code').first().isVisible(), 'le code reste à copier : le canal n\'est qu\'un raccourci');

    // Aucun document ne l'écoute encore : la SOURCE le dit, au lieu d'attendre sans fin.
    await tabButton.click();
    await A.dialog.getByText('Aucun document n’a répondu.').waitFor({ timeout: 10000 });
    await snap(A, '1-source-silence');
    step('Onglets : sans autre document à l\'écoute, la SOURCE dit pourquoi rien n\'arrive (et le code reste à copier)');

    // La CIBLE s'ouvre après coup : elle demande ce qui attend, et la SOURCE le redit.
    const B = await openTab(dst.url);
    await B.frame.locator('.tile', { hasText: 'Recevoir des tables' }).click();
    const notice = B.frame.locator('[data-offer]');
    await notice.waitFor({ timeout: 15000 });
    const noticeText = await notice.innerText();
    assert.match(noticeText, /«\s+Annuaire\s+»/);
    assert.match(noticeText, /Rien n’est écrit tant que vous n’avez pas accepté/);
    assert.match(noticeText, /ne dit pas de quel document vient l’invitation/);
    await A.dialog.getByText('L’autre document l’a reçue').waitFor({ timeout: 10000 });
    await snap(A, '2-source-invitation-vue');
    await snap(B, '3-cible-avis');
    assert.deepEqual((await records(dst.doc, '_grist_Tables')).map(tb => tb.tableId).filter(id => /^Journal_|^Fiches$/.test(id)), [],
      'rien n\'est écrit chez la CIBLE avant « Recevoir »');
    // Un autre onglet du document qui invite n'est pas une CIBLE : pas d'avis.
    assert.equal(await sameDocTab.frame.locator('[data-offer]').count(), 0, 'pas d\'avis dans un autre onglet du document qui invite');
    await sameDocTab.tab.close();
    step('Onglets : l\'invitation arrive dans l\'autre document (avis, rien d\'écrit), la SOURCE sait qu\'elle est vue, pas d\'avis dans un autre onglet du même document');

    // « Recevoir » ouvre l'assistant habituel sur ce code, déjà contrôlé : on arrive aux destinations.
    await B.frame.locator('[data-offer]').getByRole('button', { name: 'Recevoir', exact: true }).click();
    await B.dialog.getByText('« Annuaire » : table Fiches.').waitFor({ timeout: 30000 });
    assert.equal(await B.frame.locator('[data-offer]').count(), 0, 'l\'avis disparaît quand l\'assistant s\'ouvre');
    await dlgButton(B, 'Continuer').click();
    await B.dialog.getByText('Nouvelle table : le widget n’y sera pas').waitFor({ timeout: 30000 });
    await dlgButton(B, 'Continuer avec une nouvelle table').click();
    const forms = await waitFor(async () => { const f = await publishedForms(dst.doc); return f.length === 1 && f; }, 'formulaire publié');
    await B.dialog.getByLabel('Lien du formulaire').fill(await formLink(dst.doc, forms[0]));
    await dlgButton(B, 'Tester le lien').click();
    await B.dialog.getByText('Le lien fonctionne').waitFor();
    const controlB = await B.dialog.locator('.control-code strong').first().textContent();
    step('Onglets : « Recevoir » ouvre l\'assistant sur le code (destinations, lien du formulaire à coller, comme avant)');

    // La réponse repart d'elle-même vers le document d'origine : l'assistant de la SOURCE passe à la réponse, contrôlée.
    await B.dialog.getByText('Le document d’origine l’a reçue').waitFor({ timeout: 15000 });
    await snap(B, '4-cible-reponse');
    await A.dialog.getByText('Réponse reçue d’un autre onglet de ce navigateur').waitFor({ timeout: 15000 });
    await A.dialog.getByText('Document, dossier et équipe sont donnés par Grist').waitFor({ timeout: 30000 });
    await A.dialog.getByText(env.email).waitFor();
    assert.equal(await A.dialog.locator('.control-code strong').first().textContent(), controlB, 'même code de contrôle des deux côtés');
    assert.equal(await A.dialog.locator('textarea.code').first().inputValue(), await B.dialog.locator('textarea.code').first().inputValue(), 'la réponse arrivée est celle de la CIBLE');
    assert.ok(invitationCode.startsWith('GRISTSYNC2.'));
    await snap(A, '5-source-reponse-arrivee');
    step('Onglets : la réponse revient seule, contrôlée chez Grist, même code de contrôle des deux côtés');

    // Une autre réponse pour la même invitation, forgée par une page de la même origine (un message posé à la main sur le
    // canal), ne remplace pas celle que la personne a sous les yeux : la première arrivée reste, et l'avis le dit.
    const genuine = await A.dialog.locator('textarea.code').first().inputValue();
    const forged = decodeCode(genuine, 'reponse');
    const forgedCode = `GRISTSYNC2.${Buffer.from(JSON.stringify({ ...forged, recipient: { ...forged.recipient, email: 'pirate@exemple.fr' } })).toString('base64url')}`;
    await B.frame.locator('body').evaluate((_, code) => {
      const channel = new BroadcastChannel('gristsync-link');
      channel.postMessage({ app: 'gristsync', k: 'reply', code });
      setTimeout(() => channel.close(), 500);
    }, forgedCode);
    await A.dialog.getByText('Une autre réponse est arrivée d’un autre onglet').waitFor({ timeout: 10000 });
    assert.equal(await A.dialog.locator('textarea.code').first().inputValue(), genuine, 'la réponse forgée n\'a pas remplacé la vraie');
    assert.ok(!(await A.dialog.innerText()).includes('pirate@exemple.fr'), 'la fiche montre toujours la vraie réponse');
    step('Onglets : une réponse forgée, arrivée après la vraie par le canal, ne la remplace pas');

    // L'approbation reste un geste de la personne.
    await dlgButton(A, 'Approuver et brancher').click();
    await A.dialog.getByText('Branché').waitFor();
    await A.dialog.getByText(/lignes? à envoyer/).waitFor();
    await dlgButton(A, 'Envoyer').click();
    await A.dialog.getByText(/Lignes existantes envoyées\s:\s[\d\s]+\./).waitFor();
    await dlgButton(A, 'Fermer').click();
    await dlgButton(B, 'Fermer').click();
    await B.button('Synchroniser').click();
    const got = await waitFor(async () => { const rows = await records(dst.doc, 'Fiches'); return rows.length === 3 && rows; }, 'les trois fiches reçues', 60000);
    assert.deepEqual(got.map(r => r.Nom).sort(), ['Anna', 'Basile', 'Céline']);
    step('Onglets : approuvé, envoyé, reçu — trois fiches chez la CIBLE, sans un code copié');
    await A.tab.close();
    await B.tab.close();
  }


  // Règles d'accès posées AVANT la première donnée d'un export (protectSync). Le document est public et une règle cache la colonne
  // Email aux lecteurs : la table Synchro est créée vide, refusée au public dès que l'assistant est ouvert, et le reste ; le
  // document se recharge avant l'assistant, qui se rouvre seul. Puis Grist refuse de poser les règles (une règle d'autrui vise
  // une colonne effacée) : aucun export n'est créé, l'onglet le dit ; la règle corrigée, tout reprend.
  async function protectSteps() {
    const OWNER_MEMO = 'Synchro : réservée aux propriétaires';
    const src = await fichesDoc('Protection SOURCE');
    await applyActions(src.doc, [['BulkUpdateRecord', 'Fiches', [1, 2, 3], { Ville: ['anna@secret.fr', 'basile@secret.fr', 'celine@secret.fr'] }],
      ['AddRecord', '_grist_ACLResources', -1, { tableId: 'Fiches', colIds: 'Ville' }],
      ['AddRecord', '_grist_ACLRules', null, { resource: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: 'Ville cachée aux lecteurs' }]]);
    await api('PATCH', `/docs/${src.doc}/access`, { delta: { users: { 'everyone@getgrist.com': 'viewers' } } });
    const anon = async (doc, path) => {
      const res = await fetch(`${TEAM}/api/docs/${doc}${path}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      return { status: res.status, text: await res.text() };
    };
    const hidden = async (doc, label) => {
      for (const path of ['/tables/Synchro/records', '/tables/Synchro/columns', '/sql?q=select+*+from+Synchro', '/download/csv?tableId=Synchro']) {
        const res = await anon(doc, path);
        assert.ok([403, 404].includes(res.status), `${label} : ${path} refusée au public (HTTP ${res.status})`);
        assert.ok(!res.text.includes('secret.fr'), `${label} : ${path} ne montre pas la colonne cachée`);
      }
    };
    await openWidget(src.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    assert.equal((await anon(src.doc, '/tables/Synchro/records')).status, 404, 'pas encore de table Synchro');
    await button('Nouvel export').click();
    // Les règles sont posées d'abord, le document se recharge, puis l'assistant s'ouvre : rien à recliquer.
    await dialog().getByRole('checkbox', { name: 'Fiches' }).check();
    assert.ok((await records(src.doc, '_grist_ACLRules')).some(r => r.memo === OWNER_MEMO), 'règles du widget en place avant la première donnée');
    assert.equal((await records(src.doc, 'Synchro')).length, 0, 'table Synchro vide tant que l\'export n\'est pas créé');
    await hidden(src.doc, 'assistant ouvert, rien d\'écrit');
    await dialogButton('Continuer').click();
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill('Secret');
    await dialogButton('Créer l’export').click();
    await dialog().getByText('Export « Secret » créé.').waitFor({ timeout: 120000 });
    assert.ok((await records(src.doc, 'Synchro')).length > 0, 'l\'export est écrit');
    await hidden(src.doc, 'fenêtre « Export créé » encore ouverte');
    step('Protection : la table Synchro naît vide avec ses règles, le document se recharge avant l\'assistant, qui se rouvre seul ; rien de la colonne cachée n\'est lisible par le public pendant l\'assistant');

    // Grist refuse de poser les règles : une règle d'autrui vise une colonne qui n'existe plus.
    const bad = await fichesDoc('Protection refus');
    await applyActions(bad.doc, [['AddRecord', '_grist_ACLResources', -1, { tableId: 'Fiches', colIds: 'Ville' }],
      ['AddRecord', '_grist_ACLRules', null, { resource: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: 'Ville cachée' }]]);
    await applyActions(bad.doc, [['RemoveColumn', 'Fiches', 'Ville']]);
    await openWidget(bad.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await button('Nouvel export').click();
    await widget().getByText(/Invalid columns in rules for table Fiches: Ville/).first().waitFor({ timeout: 60000 });
    assert.equal(await dialog().count(), 0, 'aucun assistant : un export ne s\'écrit pas sans ses règles');
    assert.ok(!(await records(bad.doc, '_grist_ACLRules')).some(r => r.memo === OWNER_MEMO), 'Grist a refusé : aucune règle du widget');
    assert.equal((await records(bad.doc, 'Synchro')).length, 0, 'aucune ligne dans Synchro');
    await openWidgetTab(bad.url, 'Envoyer');
    await widget().getByText('Les règles d’accès du widget n’ont pas pu être posées').waitFor({ timeout: 60000 });
    assert.ok((await records(bad.doc, '_grist_ACLRules')).some(r => r.memo === 'Ville cachée'), 'la règle de la personne est intacte : le widget ne touche jamais aux règles d\'autrui');
    // La personne corrige sa règle : l'avis part, les règles du widget sont posées, l'export se crée.
    const mine = (await records(bad.doc, '_grist_ACLRules')).filter(r => r.memo === 'Ville cachée').map(r => r.resource);
    await applyActions(bad.doc, [['BulkRemoveRecord', '_grist_ACLRules', (await records(bad.doc, '_grist_ACLRules')).filter(r => r.memo === 'Ville cachée').map(r => r.id)],
      ['BulkRemoveRecord', '_grist_ACLResources', mine]]);
    await openWidgetTab(bad.url, 'Envoyer');
    await waitFor(async () => (await records(bad.doc, '_grist_ACLRules')).some(r => r.memo === OWNER_MEMO), 'règles du widget posées une fois la règle corrigée', 60000);
    await rulesSettled(bad.doc);
    // Le document s'est rechargé : une table Synchro sans export n'est pas un rôle, le widget revient à l'accueil.
    await openWidgetTab(bad.url, 'Envoyer');
    assert.equal(await widget().getByText('Les règles d’accès du widget n’ont pas pu être posées').count(), 0, 'l\'avis est parti');
    // Le serveur est parfois occupé par les étapes d'avant (files de webhooks, grosses tables) : l'onglet se dessine plus tard.
    await widget().getByRole('button', { name: 'Nouvel export', exact: true }).waitFor({ timeout: 120000 })
      .catch(async (e) => { console.log('écran à ce moment :', JSON.stringify((await widget().locator('body').innerText()).slice(0, 800))); throw e; });
    await newExport('Fiches', 'Net');
    await dialog().getByText('Export « Net » créé.').waitFor({ timeout: 120000 });
    step('Protection : Grist refuse les règles (colonne effacée) — message précis, aucun export, avis dans l\'onglet, règle d\'autrui intacte ; corrigée, tout reprend');
  }

  // Une seule série d'étapes (ONLY_EXCHANGE=1, ONLY_OPTIONS=1, ONLY_CHOICES=1, ONLY_TYPES=1, ONLY_STRUCTURE=1, ONLY_ADOPT=1, ONLY_NEWCOLS=1, ONLY_LAYOUT=1, ONLY_LINKS=1, ONLY_FORMAT=1, ONLY_FORMULAS=1, ONLY_FILES=1, ONLY_EXCHANGE_FILES=1, ONLY_STRAYS=1, ONLY_DOCLINK=1, ONLY_PROTECT=1, ONLY_CLEAN=1, ONLY_WIDGETPAGE=1, ONLY_RENF=1, ONLY_NEWS=1, ONLY_ACCESS=1, ONLY_TABS=1).
  const only = Object.entries({ EXCHANGE: exchangeSteps, OPTIONS: optionsSteps, CHOICES: choicesSteps, TYPES: typesSteps, STRUCTURE: structureSteps, ADOPT: adoptSteps, NEWCOLS: newColumnsSteps, LAYOUT: layoutSteps, LINKS: linksSteps, FORMAT: formatSteps, FORMULAS: formulasSteps, FILES: filesSteps, EXCHANGE_FILES: exchangeFilesSteps, STRAYS: straySteps, DOCLINK: docLinkSteps, PROTECT: protectSteps, CLEAN: cleanSteps, RENF: renfSteps, NEWS: newsSteps, WIDGETPAGE: widgetPageSteps, TABS: tabSteps, ACCESS: accessSteps }).find(([name]) => process.env[`ONLY_${name}`]);
  if (only) {
    await only[1]();
    assert.deepEqual(errors, [], 'aucune erreur dans la console');
    process.exit(0);
  }

  if (process.env.CAPTURES) await installShots();
  if (process.env.INSTALL_ONLY) process.exit(0);
  await accessSteps();
  // --- Accueil et Tutoriel
  await openWidget(source.url);
  await widget().locator('.guide summary').first().waitFor();
  assert.ok(!(await widget().locator('.guide-steps').first().isVisible()), '« Qui fait quoi ? » replié par défaut');
  await shot('01-accueil');
  await widget().getByRole('tab', { name: 'Tutoriel' }).click();
  await widget().locator('.tuto-section').first().waitFor();
  await widget().getByRole('button', { name: 'Je suis la CIBLE' }).click();
  assert.ok(await widget().locator('#tuto-t-link').isVisible() && !(await widget().locator('#tuto-s-tables').isVisible()), 'filtre CIBLE');
  await widget().getByRole('button', { name: 'Tout', exact: true }).click();
  // Les captures se chargent à l'approche (loading=lazy) : un texte plus long en repousse une hors de portée,
  // et decode() n'aboutit jamais sur une image qui n'est pas demandée. On l'amène donc à l'écran d'abord.
  const firstShot = widget().locator('.tuto-shot img').first();
  await firstShot.scrollIntoViewIfNeeded();
  assert.ok(await firstShot.evaluate(img => img.decode().then(() => img.naturalWidth > 0)), 'captures chargées');
  await shot('16-tutoriel');

  // --- SOURCE : un export (Tables, Colonnes, Nom), puis son premier destinataire
  await openWidget(source.url);
  await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
  await button('Nouvel export').click();
  await dialog().getByRole('checkbox', { name: 'Contacts' }).check();
  await shot('02-source-tables');
  await dialogButton('Continuer').click();
  await dialog().getByText('Le widget ajoutera').waitFor();
  await dialog().getByText(/Toutes les colonnes \(5\) · toutes les lignes/).waitFor();
  assert.ok(!(await dialog().getByRole('checkbox', { name: 'Interne' }).isVisible()), 'colonnes repliées : toutes partent par défaut');
  await dialogButton('Choisir les colonnes').click();
  assert.equal(await dialog().getByRole('checkbox', { name: 'Supprime' }).count(), 0, 'Supprime n\'est pas une colonne envoyée');
  await dialog().getByRole('checkbox', { name: 'Interne' }).uncheck();
  await dialog().getByRole('checkbox', { name: 'Delta' }).uncheck();
  await dialog().getByText(/3 colonnes sur 5 · toutes les lignes/).waitFor();
  await shot('03-source-colonnes', 'modal');
  // Depuis la 0.19 la table Synchro est créée vide, avec ses règles d'accès, avant l'assistant (voir protectSync) : aucune ligne
  // d'export n'existe encore, donc rien de lisible avant la fin de l'assistant.
  assert.equal((await records(source.doc, 'Synchro')).length, 0, 'aucune ligne d\'export avant la fin de l\'assistant');
  assert.ok((await records(source.doc, '_grist_ACLRules')).some(r => r.memo === 'Synchro : réservée aux propriétaires'), 'règles de Synchro posées avant la première ligne');
  await dialogButton('Continuer').click();
  await dialog().getByLabel('Nom de l’export').fill('Annuaire');
  await shot('03b-source-nom');
  await dialogButton('Créer l’export').click();
  await dialog().getByText('Export « Annuaire » créé.').waitFor();
  const contacts = await records(source.doc, 'Contacts');
  const contactsRefId = await tableRef(source.doc, 'Contacts');
  assert.ok(contacts.every(r => /^[0-9a-f-]{36}$/.test(r.id_sync)), 'id_sync rempli pour les lignes existantes');
  const synchro = await records(source.doc, 'Synchro');
  assert.deepEqual(synchro.map(r => `${r.Synchro_Table}:${r.Synchro_Type}`), ['Contacts:cles', 'Contacts:lot', 'Contacts:suivi']);
  assert.match(synchro[0].Synchro_Export, /^[0-9a-f]{16}$/);
  assert.equal(synchro[0].Synchro_Ids, '', 'aucune clé partie : la liste n\'envoie rien');
  const track = JSON.parse(synchro[2].Sync_Etat);
  assert.ok(track.s.length === 256 && track.top === Math.max(...contacts.map(r => r.id)), 'le suivi tient en 256 sommes, quelle que soit la table');
  assert.equal(synchro[2].Synchro_Ids.split(':')[0], String(contacts.length), 'le suivi compte les clés');
  assert.deepEqual(JSON.parse(synchro[0].Synchro_Colonnes).map(c => c.id), ['Nom', 'Ville', 'Lieu']);
  const majle = (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'MajLe' && c.parentId === contactsRefId);
  const helper = (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'Lieu' && c.parentId === contactsRefId).displayCol;
  assert.equal(majle.recalcWhen, 0, 'MajLe : formule de déclenchement sur les colonnes envoyées');
  assert.ok(helper && majle.recalcDeps.includes(helper), 'MajLe suit le texte affiché par la Référence');
  await dialogButton('Ajouter un destinataire').click();
  await dialog().getByText('Tables de l’export : Contacts.').waitFor();
  await shot('04-source-options');
  await dialogButton('Créer l’invitation').click();
  await dialog().getByText('Transmettez ce code').waitFor();
  const invitation = await dialog().locator('textarea.code').first().inputValue();
  assert.ok(invitation.startsWith('GRISTSYNC2.'));
  assert.match(await dialog().locator('.guide-steps li.current').textContent(), /CIBLE[\s\S]*Accepter une invitation/);
  assert.ok(!(await dialog().locator('.guide-steps').isVisible()), '« Qui fait quoi ? » replié dans la fenêtre');
  await dialogButton('Copier avec les consignes').waitFor();
  await shot('05-source-invitation');
  // Consignes copiées : les étapes de la CIBLE, l'adresse officielle (widget servi d'ailleurs) et le code.
  const sourceFrame = page.frames().find(f => f.url().startsWith(WIDGET_URL));
  await sourceFrame.evaluate(() => { navigator.clipboard.writeText = async (text) => { window.copiedText = text; }; });
  await dialogButton('Copier avec les consignes').click();
  const handoff = await sourceFrame.evaluate(() => window.copiedText);
  assert.ok(/«\sAccepter une invitation\s»/.test(handoff) && handoff.includes('\nhttps://grist-factory.github.io/grist-widget-syncPlus/\n'), handoff);
  assert.ok(handoff.endsWith(`\n${invitation}`));
  await dialogButton('Plus tard').click();
  await widget().locator('.person').getByText('En attente de réponse').waitFor();
  await shot('06-source-attente');
  step('SOURCE : export créé (une table technique, Synchro), invitation créée');

  // --- CIBLE : Code, Destinations, Lien, Réponse
  await openWidget(target.url);
  await widget().locator('.tile', { hasText: 'Recevoir des tables' }).click();
  await button('Accepter une invitation').click();
  await dialog().locator('textarea.code').first().fill(invitation);
  await shot('07-cible-code');
  await dialogButton('Continuer').click();
  await dialog().getByText('« Annuaire » : table Contacts.').waitFor();
  await dialog().getByText(`Données de ${env.email}`).waitFor();
  await shot('08-cible-destinations', 'modal');
  // Depuis la 0.22 la réception demande l'accord pour les colonnes ajoutées (case décochée d'emblée) : ce parcours les veut appliquées seules.
  await dialog().getByText('Options avancées').click();
  await dialog().getByRole('checkbox', { name: AUTO_BOX }).check();
  const widgetFrame = page.frames().find(f => f.url().startsWith(WIDGET_URL));
  await widgetFrame.evaluate(() => { window.sameFrame = true; });
  await dialogButton('Continuer').click();
  // Nouvelle table : l'avertissement dit que le widget n'y sera pas et ce qu'il faut faire ; « Annuler » ne crée rien.
  const warning = dialog().last(); // la fenêtre d'avertissement est posée sur l'assistant
  await warning.getByText('Nouvelle table : le widget n’y sera pas').waitFor();
  await warning.getByText(/n’est pas ajouté tout seul à cette page/).waitFor();
  await warning.getByText(/la carte de la réception passera en orange/).waitFor();
  await warning.getByText(/Pour sécuriser la réception\s:\scréez d’abord la table vous-même, ajoutez-y le widget/).waitFor();
  await warning.getByRole('button', { name: 'Annuler', exact: true }).click();
  assert.ok(!(await records(target.doc, '_grist_Tables')).some(tb => tb.tableId.startsWith('Journal_')), 'rien de créé tant que la personne ne confirme pas');
  await dialogButton('Continuer').click();
  await confirmNewTable();
  await dialog().getByLabel('Lien du formulaire').waitFor();
  assert.ok(await widgetFrame.evaluate(() => window.sameFrame), 'formulaire publié sans recharger le widget');
  const markPages = (await pagesOf(target.doc)).map(p => p.name);
  assert.equal(markPages[markPages.indexOf('Contacts') + 1], 'Journal_Annuaire', 'la page du journal est juste sous celle de la table reçue');
  const [formShare] = await records(target.doc, '_grist_Shares');
  assert.equal(JSON.parse(formShare.options).publish, true, 'le partage reste publié');
  assert.equal(JSON.parse(formShare.description).syncPlus.journal, 'Journal_Annuaire', 'le partage garde de quoi reconnaître la réception');
  const formSections = await publishedForms(target.doc);
  assert.equal(formSections.length, 1, 'un formulaire publié');
  const widgetSection = (await records(target.doc, '_grist_Views_section')).find(sc => sc.parentKey === 'custom');
  const widgetPage = await pageOf(target.doc, widgetSection.parentId);
  const formPage = await pageOf(target.doc, formSections[0].parentId);
  assert.notEqual(formPage.id, widgetPage.id, 'formulaire sur sa propre page');
  assert.equal(formPage.indentation, 0, 'page du formulaire à la racine');
  await dialog().getByText(/sur la page\s+«\s+Journal_Annuaire\s+»/).waitFor();
  await dialog().getByText(/il sert pour toutes les tables de l’export/).waitFor();
  await dialog().evaluate(d => d.querySelectorAll('*').forEach(e => { e.scrollTop = 0; }));
  await shot('09-cible-lien');
  if (process.env.CAPTURES) await helpShots(`${TEAM}/doc/${target.doc}/p/${formPage.viewRef}`, target.url);
  // Lien d'un formulaire d'un autre document, sur une table du même nom : refusé, la réponse
  // enverrait les données ailleurs.
  const stray = await strayForm(source.doc, 'Journal_Annuaire', [{ id: 'id_sync', type: 'Text' }, { id: 'Sync_Par', type: 'Text' }]);
  await dialog().getByLabel('Lien du formulaire').fill(await formLink(source.doc, stray.form));
  await dialogButton('Tester le lien').click();
  await dialog().getByText('Ce lien n’écrit pas dans le journal de cette réception').waitFor();
  assert.equal((await records(source.doc, 'Journal_Annuaire')).length, 1, 'la ligne de test est arrivée dans l\'autre document');
  await stray.remove();
  const reply = await testLink('Lien du formulaire', await formLink(target.doc, formSections[0]), 'Le lien fonctionne');
  shownControl = await dialog().locator('.control-code strong').first().textContent();
  assert.match(shownControl, /^[A-HJKMNP-Z2-9]{3}-[A-HJKMNP-Z2-9]{3}$/, 'code de contrôle montré avec la réponse');
  await shot('10-cible-reponse');
  await dialogButton('Fermer').click();
  step('CIBLE : un journal pour l\'export, un formulaire, réponse produite');

  // --- SOURCE : approuver, envoyer l'existant ; un webhook sur Synchro, filtré sur l'export
  await approve(reply, { shots: true });
  await widget().getByText('Actif').first().waitFor();
  const hooks = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks;
  assert.deepEqual(hooks.map(h => h.fields.tableId), ['Synchro']);
  const triggers = (await api('POST', `/docs/${source.doc}/sql`, { sql: 'select condition from _grist_Triggers' })).records;
  assert.equal(JSON.parse(triggers[0].fields.condition).text, `rec.Synchro_Export == "${synchro[0].Synchro_Export}" and rec.Synchro_Type in ("cles", "lot")`);
  await waitFor(async () => (await records(target.doc, 'Journal_Annuaire')).length >= 2, 'liste et lot reçus dans le journal');
  const charge = JSON.parse((await records(source.doc, 'Synchro')).find(r => r.Synchro_Type === 'charge').Synchro_Renvoi);
  assert.ok(!charge.par && charge.envoye.length && charge.envoye[0][1] > 0, 'renvoi compté dans la charge du document, la main rendue');
  // Diagnostic (Réglages) : l'export et son destinataire, sans l'adresse de son webhook.
  await widget().locator('#settings').click();
  const diag = dialog().getByLabel('Diagnostic', { exact: true });
  const diagText = await waitFor(async () => { const v = await diag.inputValue(); return v.includes('== Erreurs récentes') && v; }, 'diagnostic relu');
  assert.ok(diagText.includes(`destinataire ${hooks[0].id.slice(0, 8)} : actif`) && diagText.includes('Droits : propriétaire'), diagText);
  assert.ok(!diagText.includes(hooks[0].fields.url.split('/api/s/')[1].slice(4, 12)), 'pas de clé de formulaire dans le diagnostic');
  await dialogButton('Fermer').click();
  step('SOURCE : un webhook filtré sur l\'export, lignes existantes envoyées ; diagnostic sans adresse');

  // --- Une autre page renvoie déjà (signe de vie récent) : « Tout renvoyer » ne lance rien et
  // note le lot ; la main rendue, le rattrapage l'envoie seul
  const chargeRow = (await records(source.doc, 'Synchro')).find(r => r.Synchro_Type === 'charge');
  const nowSec = () => Date.now() / 1000;
  const prog = { exp: synchro[0].Synchro_Export, table: 'Contacts', done: 2, total: 4, lots: 1, lotsTotal: 2, bytes: 1000, at: nowSec() - 60, last: nowSec() };
  const holdCharge = par => applyActions(source.doc, [['UpdateRecord', 'Synchro', chargeRow.id, { Synchro_Renvoi: JSON.stringify({ ...charge, par, le: nowSec(), prog: par ? prog : null }) }]]);
  await holdCharge('autre');
  await openWidget(source.url);
  await widget().getByText(/Un envoi est en cours depuis une autre page ou une autre personne\s:\s2 sur 4 lignes \(50\s%\), lot 2 sur environ 2\./).waitFor();
  assert.equal(await widget().locator('[data-flow="runningOther"] progress').getAttribute('value'), '2', 'barre d\'avancement');
  await button('Tout renvoyer').click();
  await widget().getByText('Un autre renvoi est en cours pour ce document').waitFor();
  const lotOf = async () => (await records(source.doc, 'Synchro')).find(r => r.Synchro_Type === 'lot');
  assert.equal((await lotOf()).Sync_Etat, 1, 'lot noté à renvoyer en entier');
  await holdCharge('');
  const released = async () => !JSON.parse((await records(source.doc, 'Synchro')).find(r => r.id === chargeRow.id).Synchro_Renvoi).par;
  await waitFor(async () => !(await lotOf()).Sync_Etat && await released(), 'renvoi noté parti seul, la main rendue', 60000);
  step('SOURCE : un renvoi à la fois par document, celui d\'une autre page attend son tour');

  // --- CIBLE : dépliage et consolidation à l'ouverture
  await openWidget(target.url);
  const dest = await waitFor(async () => { const rows = await records(target.doc, 'Contacts'); return rows.length === 4 && rows; }, 'consolidation');
  assert.deepEqual(dest.map(r => `${r.Nom}:${r.Ville}:${r.Lieu}`).sort(), ['Alice:Lyon:Lyon', 'Bob:Paris:Paris', 'Chloé:Nantes:', 'Dora:Brest:']);
  await widget().getByText(`Données de ${env.email}`).waitFor();
  step('CIBLE : Contacts consolidée, propriétaire affiché');

  // --- Un lecteur de la CIBLE voit les boutons grisés d'emblée
  await api('PATCH', `/docs/${target.doc}/access`, { delta: { users: { 'lecteur@sync.local': 'viewers' } } });
  const viewerContext = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1100, height: 700 } });
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(`${env.grist}/test/login?username=lecteur@sync.local&name=Lecteur&next=${env.grist}/`);
  await viewerPage.goto(target.url);
  const viewerWidget = viewerPage.frameLocator('iframe').first();
  // Le journal lui est caché : le widget ne sait pas que ce document reçoit, il propose les deux rôles.
  await viewerWidget.locator('.tile', { hasText: 'Recevoir des tables' }).click({ timeout: 30000 });
  await viewerWidget.getByText('Lecture seule : un éditeur doit ouvrir cette page').waitFor({ timeout: 30000 });
  assert.ok(await viewerWidget.getByRole('button', { name: 'Accepter une invitation' }).isDisabled(), 'lecteur : boutons grisés');
  assert.equal(await viewerWidget.locator('.card').count(), 0, 'journal réservé aux éditeurs : le lecteur ne voit pas la réception');
  await viewerWidget.getByText('Aucune réception visible').waitFor();
  await viewerContext.close();
  const memos = async doc => (await records(doc, '_grist_ACLRules')).map(r => r.memo);
  assert.ok((await memos(target.doc)).includes('Synchro : journaux réservés aux éditeurs'));
  assert.ok((await memos(source.doc)).includes('Synchro : réservée aux propriétaires'));
  step('CIBLE : un lecteur voit les boutons grisés d\'emblée, pas le journal ; Synchro réservée aux propriétaires de la SOURCE');

  // --- Pages et tables : aucune page technique, une seule table technique côté SOURCE
  assert.deepEqual((await pagesOf(source.doc)).map(p => p.name), ['Table1', 'Contacts', 'Villes', 'Synchro'], 'SOURCE : aucune page technique');
  const targetPages = (await pagesOf(target.doc)).map(p => `${p.indentation}:${p.name}`);
  assert.ok(targetPages.includes('0:Journal_Annuaire'), 'CIBLE : la page du formulaire à la racine');
  assert.ok(!JSON.parse((await pagesOf(target.doc)).find(p => p.name === 'Synchro').options || '{}').collapsed, 'page du widget laissée dépliée');
  assert.deepEqual(targetPages.map(p => p.slice(2)).sort(), ['Communes', 'Contacts', 'Journal_Annuaire', 'Synchro', 'Table1'], 'CIBLE : aucune autre page technique');
  assert.deepEqual((await records(source.doc, '_grist_Tables')).map(tb => tb.tableId).sort(), ['Contacts', 'Synchro', 'Table1', 'Villes']);
  assert.deepEqual((await records(target.doc, '_grist_Tables')).map(tb => tb.tableId).sort(), ['Communes', 'Contacts', 'Journal_Annuaire', 'Table1']);
  const columnsOf = async (doc, table) => (await api('GET', `/docs/${doc}/tables/${table}/columns`)).columns.map(c => c.id).sort();
  assert.deepEqual(await columnsOf(target.doc, 'Contacts'), ['Lieu', 'Nom', 'Ville', 'id_sync']);
  const hiddenOf = async (doc, table) => (await api('GET', `/docs/${doc}/tables/${table}/columns?hidden=true`)).columns.map(c => c.id);
  assert.ok(!(await hiddenOf(source.doc, 'Synchro')).includes('manualSort'), 'Synchro sans manualSort (le webhook l\'enverrait)');
  step('SOURCE et CIBLE : tables techniques sans page, destination sans colonne technique, formulaire sur sa page, à la racine');

  // --- Ajout, modification, retouche manuelle, suppression logique, vraie suppression
  const bob = dest.find(r => r.Nom === 'Bob');
  await applyActions(target.doc, [['UpdateRecord', 'Contacts', bob.id, { Ville: 'retouche' }]]);
  const byName = name => contacts.find(r => r.Nom === name);
  // Alice change de ville dans la SOURCE ; rend la main quand la CIBLE l'a recopiée.
  const moveAlice = async (ville, what) => {
    await applyActions(source.doc, [['UpdateRecord', 'Contacts', byName('Alice').id, { Ville: ville }]]);
    await openWidget(target.url);
    await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Ville === ville), what);
  };
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', byName('Alice').id, { Ville: 'Marseille' }], ['UpdateRecord', 'Contacts', byName('Chloé').id, { Supprime: true }],
    ['AddRecord', 'Contacts', null, { Nom: 'Denis' }], ['RemoveRecord', 'Contacts', byName('Dora').id]]);
  const after = await waitFor(async () => {
    const rows = await records(target.doc, 'Contacts');
    return rows.length === 3 && rows.some(r => r.Nom === 'Denis') && rows.some(r => r.Ville === 'Marseille') && rows;
  }, 'ajout, modification et suppressions consolidés sans clic');
  assert.equal(after.find(r => r.Nom === 'Bob').Ville, 'retouche', 'retouche manuelle préservée');
  const historyHas = (label, state) => waitFor(async () => (await widget().locator('.chg-row').evaluateAll(rows =>
    rows.map(r => `${r.querySelector('.chg-label').textContent}|${r.className}`))).some(r => r.startsWith(`${label}|`) && r.includes(`chg-${state}`)), `historique : ${label} ${state}`);
  await historyHas('Denis', 'ajout');
  await historyHas('Alice', 'modif');
  await historyHas('Chloé', 'suppression');
  await historyHas('Dora', 'suppression');
  // Avant et après en petit tableau, numéros de ligne de la table d'ici. L'historique et chacune
  // de ses lignes sont repliés par défaut ; ce qu'on ouvre le reste quand l'onglet se redessine.
  const item = label => widget().locator('.chg-item', { has: widget().locator('.chg-label', { hasText: label }) });
  const isOpen = details => details.evaluate(d => d.open);
  const history = widget().locator('details.history');
  assert.ok(!(await isOpen(history)), 'historique replié par défaut');
  assert.ok(!(await isOpen(item('Alice').locator('details'))) && !(await isOpen(item('Denis').locator('details'))), 'chaque changement est replié');
  await history.locator(':scope > summary').click();
  await item('Alice').locator('summary').click();
  await widget().getByRole('tab', { name: 'Tutoriel' }).click();
  await widget().getByRole('tab', { name: 'Recevoir' }).click();
  assert.ok(await isOpen(history) && await isOpen(item('Alice').locator('details')), 'ouverts, ils le restent quand l\'onglet se redessine');
  assert.ok(!(await isOpen(item('Denis').locator('details'))), 'les autres restent repliés');
  const gridOf = async label => item(label).locator('.mini-grid tbody tr').evaluateAll(rows => rows.map(r => [...r.children].map(c => c.textContent)));
  assert.deepEqual(await gridOf('Alice'), [['Avant', 'Lyon'], ['Après', 'Marseille']], 'Alice : Ville avant et après');
  assert.deepEqual((await gridOf('Denis'))[0].slice(0, 2), ['Après', 'Denis'], 'ajout : ses valeurs après');
  assert.deepEqual((await gridOf('Dora'))[0].slice(0, 3), ['Avant', 'Dora', 'Brest'], 'suppression : ses valeurs avant');
  const numberOf = async label => Number(await item(label).locator('.chg-n').textContent());
  const destOrder = (await api('GET', `/docs/${target.doc}/tables/Contacts/records?hidden=true`)).records
    .sort((x, y) => x.fields.manualSort - y.fields.manualSort).map(r => r.fields.Nom);
  assert.equal(await numberOf('Alice'), destOrder.indexOf('Alice') + 1, 'numéro de la ligne dans la table d\'ici');
  assert.equal(await numberOf('Denis'), destOrder.indexOf('Denis') + 1);
  assert.ok(await numberOf('Dora') > 0, 'une ligne supprimée garde le numéro qu\'elle avait');
  // La retouche de Bob est signalée, avec son numéro de ligne, la valeur d'ici et celle de la SOURCE.
  const drift = widget().locator('.drift');
  await drift.getByText(/Contacts\s:\s1 modification faite à la main ici/).waitFor({ timeout: 30000 });
  const driftRows = () => drift.locator('tbody tr').evaluateAll(rows => rows.map(r => [...r.children].map(c => c.textContent)));
  assert.deepEqual(await driftRows(), [[String(destOrder.indexOf('Bob') + 1), 'Bob', 'Ville', 'retouche', 'Paris']], 'écart : ligne, nom, colonne, ici, SOURCE');
  await shot('14-cible-historique');
  await waitFor(async () => {
    const rows = await records(target.doc, 'Journal_Annuaire');
    return !rows.some(r => r.Synchro_Type) && rows.filter(r => r.id_sync).length === 5;
  }, 'journal déplié et nettoyé : une version par ligne');
  step('CIBLE : ajout, modification, suppression logique et vraie suppression appliqués seuls ; retouche préservée et signalée ; historique avant/après numéroté ; journal nettoyé');

  // --- Second destinataire du même export, en sécurité renforcée, sans refaire l'export : le code
  // de contrôle doit avoir été comparé, et ses suppressions reçues attendent une décision.
  await openWidget(source.url);
  await button('Ajouter un destinataire').click();
  await dialog().getByRole('checkbox', { name: 'Sécurité renforcée' }).check();
  await dialogButton('Créer l’invitation').click();
  await dialog().getByText('Transmettez ce code').waitFor();
  await dialog().getByText(/Valable jusqu’au/).waitFor();
  await dialog().getByText('Ce code vaut un mot de passe').first().waitFor();
  const invitation2 = await dialog().locator('textarea.code').first().inputValue();
  await dialogButton('Plus tard').click();
  await widget().locator('.person', { hasText: 'sécurité renforcée' }).waitFor();
  const reply2 = await accept(target2.doc, target2.url, invitation2);
  await approve(reply2, { compare: true });
  await widget().locator('.person').nth(1).getByText('Actif').waitFor();
  // Fiche du destinataire : équipe/nom du document, lu chez Grist ; un mémo d'avant la 0.10.1, sans
  // le nom, est complété à l'affichage.
  await widget().locator('.person-who', { hasText: `${env.team}/Cible 2` }).waitFor();
  const sourceHooks = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks;
  for (const h of sourceHooks) assert.match(h.fields.memo, /^r-[0-9a-f]{12}$/, 'le mémo d’un webhook n’est qu’un jeton : il se lit dans les métadonnées du document');
  const cards = await Promise.all(sourceHooks.map(async h => ({ hook: h, card: await hookCard(source.doc, h) })));
  const firstHook = cards.find(c => !c.card.includes('Cible 2'));
  assert.ok(firstHook.card.endsWith(`${env.team}/Cible`), 'nom du document dans la fiche, rangée dans la note');
  // Un webhook d’avant (mémo = fiche, sans le nom du document) : repris dans la note au prochain affichage, le nom complété.
  await api('PATCH', `/docs/${source.doc}/webhooks/${firstHook.hook.id}`, { memo: firstHook.card.replace('/Cible', '') });
  await openWidget(source.url);
  // Le nom est un lien : le texte réservé aux lecteurs d'écran le suit.
  await widget().locator('.person-who', { hasText: new RegExp(`${env.team}/Cible(?! 2)`) }).waitFor({ timeout: 30000 });
  await waitFor(async () => (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.every(h => !(h.usage || {}).numWaiting), 'file vide');
  await shot('13-source-actif', 'card');
  await openWidget(target2.url);
  await waitFor(async () => (await records(target2.doc, 'Contacts')).map(r => r.Nom).sort().join() === 'Alice,Bob,Denis', 'second destinataire servi');
  // Une clé de signature par destinataire, tirée des clés publiques des deux codes.
  const signExport = (await records(source.doc, 'Synchro')).find(r => r.Synchro_Export).Synchro_Export;
  const key1 = await receivedKeyOf(target.doc, 'Contacts', signExport);
  const key2 = await receivedKeyOf(target2.doc, 'Contacts', signExport);
  assert.match(key2, /^[0-9a-f]{32}$/);
  assert.notEqual(key1, key2, 'une clé par destinataire');
  const sourceKeys = async () => Object.values(readKeys((await records(source.doc, 'Synchro')).find(r => r.Synchro_Type === 'signature').Synchro_Colonnes));
  assert.deepEqual((await sourceKeys()).sort(), [key1, key2].sort(), 'la SOURCE signe pour chacun, rien d\'autre');
  // La CIBLE est passive, même en sécurité renforcée : une ligne effacée dans la SOURCE est effacée ici sans rien
  // demander (plus de carte « Appliquer / Ignorer »).
  const ulysse = (await applyActions(source.doc, [['AddRecord', 'Contacts', null, { Nom: 'Ulysse' }]])).retValues[0];
  await waitFor(async () => (await records(target2.doc, 'Contacts')).some(r => r.Nom === 'Ulysse'), 'ajout reçu');
  await applyActions(source.doc, [['RemoveRecord', 'Contacts', ulysse]]);
  await waitFor(async () => !(await records(target2.doc, 'Contacts')).some(r => r.Nom === 'Ulysse'), 'suppression appliquée sans décision', 90000);
  assert.equal(await widget().locator('.wave').count(), 0, 'aucune carte de décision côté CIBLE');
  // La SOURCE est avertie après coup quand beaucoup de lignes quittent l'export : la référence est notée à
  // l'ouverture de sa page, puis 14 lignes (plus de 10, et plus de 20 % de la table) s'en vont : avis sur la
  // carte de l'export et ligne d'historique, avec le rappel de Ctrl+Z.
  const moreRows = (await applyActions(source.doc, [['BulkAddRecord', 'Contacts', Array(14).fill(null), { Nom: Array.from({ length: 14 }, (_, i) => `Plus${i}`) }]])).retValues[0];
  const syncRef2 = await tableRef(source.doc, 'Synchro');
  const noteColumn = async () => (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'Synchro_Export' && c.parentId === syncRef2);
  const rowsNote = async () => syncNoteOf(await noteColumn());
  // La référence d'une observation plus ancienne est vieillie : elle se renouvelle à l'ouverture (avec les 14 lignes de plus).
  const seenBefore = await rowsNote();
  if ((seenBefore.lignes || {})[signExport]) {
    seenBefore.lignes[signExport].at = 1;
    await applyActions(source.doc, [syncNoteWrite(await noteColumn(), seenBefore)]);
  }
  await openWidget(source.url);
  await page.bringToFront(); // une page en arrière-plan ne se rattrape qu'une fois par minute
  const withMore = (await records(source.doc, 'Contacts')).length;
  await waitFor(async () => (((await rowsNote()).lignes || {})[signExport] || { n: {} }).n.Contacts === withMore, 'nombre de lignes de l\'export noté', 60000);
  await applyActions(source.doc, [['BulkRemoveRecord', 'Contacts', moreRows]]);
  await widget().locator('.notice').getByText(/Contacts\s:\s14 lignes de moins dans l’export/).waitFor({ timeout: 90000 });
  await widget().getByText(/Ctrl\+Z/).first().waitFor();
  assert.ok((await rowsNote()).historique[signExport].some(e => e.kind === 'shrink' && e.who === 'Contacts' && e.n === 14), 'événement dans l\'historique de la note');
  await shot('13b-source-lignes-en-moins', 'card');
  await waitFor(async () => (await records(target2.doc, 'Contacts')).map(r => r.Nom).sort().join() === 'Alice,Bob,Denis', 'lignes en moins suivies chez le second destinataire', 90000);
  await openWidget(target.url);
  await waitFor(async () => !(await rawRows(target.doc, 'Journal_Annuaire')).length && !(await records(target.doc, 'Journal_Annuaire')).some(r => !r.Sync_Applique && r.id_sync), 'renvoi reçu par le premier');
  assert.equal((await records(target.doc, 'Contacts')).find(r => r.Nom === 'Bob').Ville, 'retouche', 'le renvoi ne défait pas la retouche');
  // Une ligne et une colonne reçues, effacées ici, sont signalées aussi, sans clic : le widget voit
  // que la destination a changé ; « Corriger » remet alors l'état exact de la SOURCE.
  const denis = (await records(target.doc, 'Contacts')).find(r => r.Nom === 'Denis');
  await applyActions(target.doc, [['RemoveRecord', 'Contacts', denis.id], ['RemoveColumn', 'Contacts', 'Lieu']]);
  await drift.getByText(/Contacts\s:\s3 modifications faites à la main ici/).waitFor({ timeout: 30000 });
  assert.deepEqual((await driftRows()).map(r => r.slice(1)), [['', 'Lieu', 'Colonne supprimée ici, toujours envoyée par la SOURCE'],
    ['Bob', 'Ville', 'retouche', 'Paris'], ['Denis', 'Ligne supprimée ici, toujours dans la SOURCE']], 'écarts : colonne, valeur, ligne');
  await drift.getByRole('button', { name: 'Corriger' }).click();
  await dialog().getByText(/3 modifications faites à la main ici sont remplacées par l’état exact de la SOURCE\. 1 ligne supprimée ici revient, en fin de table\. 1 colonne supprimée ici est recréée\./).waitFor();
  await dialogButton('Corriger').click();
  await drift.waitFor({ state: 'detached', timeout: 30000 });
  assert.deepEqual((await records(target.doc, 'Contacts')).map(r => `${r.Nom}:${r.Ville}:${r.Lieu}`).sort(), ['Alice:Marseille:Lyon', 'Bob:Paris:Paris', 'Denis::'],
    'Corriger : valeur, ligne et colonne de la SOURCE reviennent');
  step('SOURCE : second destinataire ajouté et servi ; le premier ne voit rien changer ; ligne, colonne et valeur retouchées ici signalées, « Corriger » remet la SOURCE');

  // --- Révoquer le second seulement : le premier continue
  // Un webhook détourné (adresse changée dans les réglages de Grist) est signalé sur sa ligne.
  const hooksNow = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks;
  const second = (await Promise.all(hooksNow.map(async h => ({ h, card: await hookCard(source.doc, h) })))).find(x => x.card.includes(target2.doc.slice(0, 10))).h;
  const first = hooksNow.find(h => h.id !== second.id);
  await api('PATCH', `/docs/${source.doc}/webhooks/${second.id}`, { url: first.fields.url });
  await openWidget(source.url);
  await widget().locator(`.person[data-memo*="${target2.doc.slice(0, 10)}"]`).getByText(/envoie maintenant vers un autre document/).waitFor({ timeout: 30000 });
  // Adresse qui n'est plus celle d'un formulaire (ici, une barre en plus : Grist l'accepte encore).
  await api('PATCH', `/docs/${source.doc}/webhooks/${second.id}`, { url: second.fields.url.replace('/records?', '/records/?') });
  await openWidget(source.url);
  await widget().locator(`.person[data-memo*="${target2.doc.slice(0, 10)}"]`).getByText(/n’est plus celle d’un formulaire de cette instance/).waitFor({ timeout: 30000 });
  await api('PATCH', `/docs/${source.doc}/webhooks/${second.id}`, { url: second.fields.url });
  await openWidget(source.url);
  assert.equal(await widget().getByText(/envoie maintenant vers un autre document|n’est plus celle d’un formulaire/).count(), 0);
  await revoke(widget().locator(`.person[data-memo*="${target2.doc.slice(0, 10)}"]`));
  await waitFor(async () => (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.length === 1, 'un webhook en moins');
  await waitFor(async () => (await sourceKeys()).join() === key1, 'clé du révoqué retirée : plus rien n\'est signé pour lui');
  await moveAlice('Nancy', 'le premier reçoit toujours');
  await new Promise(r => setTimeout(r, 2000));
  assert.ok(!(await records(target2.doc, 'Journal_Annuaire')).some(r => (r.Synchro_Lot || r.Synchro_Donnees || '').includes('Nancy')), 'le second ne reçoit plus');
  await openWidget(target2.url);
  await widget().getByText('Coupé par la SOURCE').waitFor({ timeout: 30000 });
  await widget().getByText(/La SOURCE a coupé cet envoi le/).waitFor();
  assert.ok(!(await rawRows(target2.doc, 'Journal_Annuaire')).length, 'la ligne de fin est dépliée, pas rejetée');
  assert.ok(!(await widget().getByText('Arrivées suspectes').count()), 'la fin n\'est pas une arrivée suspecte');
  step('SOURCE : une seule personne révoquée, l\'autre reçoit toujours ; la carte du révoqué le dit');

  // --- Lien public sur la CIBLE : sa note de journal (journal réservé aux éditeurs) et la clé de signature de la table reçue (colonne
  // id_sync, cachée aux lecteurs par une règle) ne se lisent pas dans les métadonnées du document, en anonyme. Les notes sont dans les
  // options des colonnes, que Grist vide pour qui ne les lit pas ; leur description, elle, se lirait.
  await openWidget(target.url);
  await waitFor(async () => (await records(target.doc, '_grist_ACLResources')).some(r => r.tableId === 'Contacts' && r.colIds === 'id_sync'), 'règle qui cache id_sync de Contacts aux lecteurs', 60000);
  assert.ok((await records(target.doc, '_grist_Tables_column')).some(c => c.colId === 'id_sync' && syncNoteOf(c).signature), 'une clé de signature existe côté CIBLE (contrôle non vide)');
  assert.ok((await records(target.doc, '_grist_Tables_column')).some(c => c.colId === 'Synchro_Ids' && syncNoteOf(c).secret), 'une note de journal existe côté CIBLE (contrôle non vide)');
  const metadataOf = async (doc) => {
    const res = await fetch(`${TEAM}/api/docs/${doc}/tables/_grist_Tables_column/records`);
    return { status: res.status, columns: res.status === 200 ? (await res.json()).records.map(r => r.fields) : [] };
  };
  await api('PATCH', `/docs/${target.doc}/access`, { delta: { users: { 'everyone@getgrist.com': 'viewers' } } });
  const onTarget = await metadataOf(target.doc);
  await api('PATCH', `/docs/${target.doc}/access`, { delta: { users: { 'everyone@getgrist.com': null } } });
  assert.equal(onTarget.status, 200, 'les métadonnées de la CIBLE sont lisibles en anonyme (sinon ce contrôle ne prouve rien)');
  assert.ok(onTarget.columns.length > 10, 'des colonnes sont rendues');
  assert.deepEqual(onTarget.columns.filter(c => /syncNote|"signature"|"secret"|"prive"/.test(`${c.description || ''}${c.widgetOptions || ''}`)), [],
    'ni la note du journal, ni la clé de signature ne sont lisibles dans les métadonnées de la CIBLE, en anonyme');
  step('Lien public sur la CIBLE : ni la note du journal, ni la clé de signature ne se lisent dans les métadonnées du document');

  // --- Modifier l'export : une table et une colonne de plus ; la CIBLE range la table (fenêtre).
  // D'abord un rechargement du document SOURCE : Grist recalcule RecalculLe de toutes les lignes, et
  // la petite table Contacts repart à l'heure du rechargement. Les renvois qui suivent (colonne
  // ajoutée, filtre retiré), plus anciens selon MajLe, doivent quand même l'emporter dans la
  // CIBLE (sans quoi les lignes revenues dans le filtre ne sont pas recopiées : vérifié).
  await api('POST', `/docs/${source.doc}/force-reload`);
  await new Promise(r => setTimeout(r, 3000));
  await waitFor(async () => (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.every(h => !(h.usage || {}).numWaiting), 'envoi du rechargement parti');
  await openWidget(source.url);
  await button('Modifier').click();
  await dialog().getByRole('checkbox', { name: 'Villes' }).check();
  await shot('18-source-modifier');
  await dialogButton('Continuer').click();
  await dialog().getByRole('checkbox', { name: 'Interne' }).first().check();
  await dialogButton('Continuer').click();
  await dialogButton('Enregistrer').click();
  await dialog().getByText(/Enregistré\s:\s[\d\s]+\slignes sont parties/).waitFor();
  await dialogButton('Fermer').click();
  assert.equal((await records(source.doc, 'Synchro')).filter(r => !['charge', 'signature'].includes(r.Synchro_Type)).length, 6, 'trois lignes Synchro par table (plus la charge et la clé de signature)');
  assert.ok(!(await columnsOf(source.doc, 'Villes')).includes('Supprime'), 'le widget n\'ajoute pas Supprime');
  await openWidget(target.url);
  await dialog().getByText('Table ajoutée à l’export : Villes').waitFor({ timeout: 30000 });
  await dialog().getByText(/envoie maintenant la table Villes \(2 lignes/).waitFor();
  // La colonne ajoutée à l'export est déjà dans l'historique (sa note est dans le journal), derrière la fenêtre : on le lit avant que le
  // document ne se recharge (la règle d'accès de la table qui reçoit sa clé, plus bas, remet l'historique de la page à zéro).
  await waitFor(async () => (await widget().locator('.chg-row.chg-colonne').allTextContents()).some(x => /Colonne\s«\sInterne\s».*ajoutée par la SOURCE/.test(x)),
    'historique : colonne Interne ajoutée par la SOURCE');
  // Une table qui reçoit déjà une synchro le dit dans la liste, et le refus dit pourquoi.
  await pick('Villes', 'Contacts (reçoit déjà Contacts)');
  await dialogButton('Recevoir').click();
  await dialog().getByText(/Contacts reçoit déjà la table Contacts\s:/).waitFor();
  await pick('Villes', 'Communes');
  await shot('17-cible-nouvelle-table');
  await dialogButton('Recevoir').click();
  await pick('Ville', 'Commune');
  await pick('Rattacher les lignes déjà là par la colonne', 'Commune');
  await shot('08b-cible-colonnes');
  await dialogButton('Recevoir').click();
  await dialog().waitFor({ state: 'detached' });
  const communes = await waitFor(async () => { const rows = await records(target.doc, 'Communes'); return rows.length === 2 && rows.every(r => r.id_sync) && rows; }, 'table ajoutée rangée dans Communes');
  assert.deepEqual(communes.map(r => `${r.Commune}:${r.Note}`).sort(), ['Lyon:déjà là', 'Paris:'], 'Lyon rattachée, pas doublée');
  assert.deepEqual(await columnsOf(target.doc, 'Communes'), ['Commune', 'Note', 'id_sync'], 'table existante complétée de la seule clé');
  // La table qui reçoit une clé de signature a sa colonne id_sync cachée aux lecteurs par une règle d'accès (mémo « clé de signature
  // cachée aux lecteurs »), posée par un propriétaire : le document se recharge, le widget revient sur son premier écran.
  await waitFor(async () => (await records(target.doc, '_grist_ACLResources')).some(r => r.tableId === 'Communes' && r.colIds === 'id_sync'), 'règle qui cache id_sync de Communes aux lecteurs', 60000);
  await openWidgetTab(target.url, 'Recevoir');
  await waitFor(async () => { const rows = await records(target.doc, 'Contacts'); return ['Alice:i1', 'Bob:i2'].every(x => rows.some(r => `${r.Nom}:${r.Interne}` === x)); }, 'colonne ajoutée reçue et remplie');
  const shown = await pageColumns(target.doc, 'Contacts');
  assert.ok(shown.includes('Interne') && !shown.includes('id_sync'), `colonne ajoutée visible sur la page, clé masquée : ${shown}`);
  // Le document s'est rechargé : l'historique repart de zéro. Un changement dans chaque table le remplit de nouveau, groupé par table.
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', byName('Bob').id, { Interne: 'i2b' }], ['RemoveRecord', 'Villes', 2]]);
  await waitFor(async () => (await records(target.doc, 'Communes')).map(r => r.Commune).join() === 'Lyon', 'vraie suppression dans la table ajoutée');
  await historyHas('Bob', 'modif');
  await historyHas('Paris', 'suppression');
  assert.deepEqual(await widget().locator('.history-head strong').allTextContents(), ['Contacts', 'Communes'], 'historique groupé par table');
  step('SOURCE puis CIBLE : table et colonne ajoutées à l\'export, rangées par la CIBLE dans une table existante, colonne annoncée dans l\'historique');

  // --- Une ville renommée : le texte affiché par la Référence repart seul, sans toucher Contacts
  await applyActions(source.doc, [['UpdateRecord', 'Villes', 1, { Ville: 'Villeurbanne' }]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).find(r => r.Nom === 'Alice').Lieu === 'Villeurbanne', 'ville renommée reçue');
  step('SOURCE : une ville renommée repart seule dans les lignes qui la citent');

  // --- Annulation (Ctrl+Z) dans la SOURCE : Grist remet MajLe à sa valeur d'avant, mais recalcule
  // RecalculLe, qui fait repartir la ligne avec l'heure de l'annulation
  const sourcePage = await context.newPage();
  const contactsView = (await records(source.doc, '_grist_Views')).find(v => v.name === 'Contacts').id;
  await sourcePage.goto(`${TEAM}/doc/${source.doc}/p/${contactsView}`);
  await sourcePage.locator('.field_clip', { hasText: /^Alice$/ }).first().click();
  await sourcePage.keyboard.press('Enter');
  await sourcePage.keyboard.press('Control+a');
  await sourcePage.keyboard.type('Alicia');
  await sourcePage.keyboard.press('Enter');
  await page.bringToFront();
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Nom === 'Alicia'), 'modification reçue');
  await sourcePage.bringToFront();
  await sourcePage.keyboard.press('Control+z');
  await page.bringToFront();
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Nom === 'Alice'), 'annulation reçue');
  await sourcePage.close();
  step('SOURCE : une modification annulée (Ctrl+Z) repart, la CIBLE revient à la valeur d\'avant');

  // --- Destination renommée dans la CIBLE (table et colonne) : la recopie suit, sans recréer
  // l'ancienne colonne ; puis les noms d'origine reviennent
  const alice = byName('Alice').id;
  await applyActions(target.doc, [['RenameTable', 'Contacts', 'Personnes'], ['RenameColumn', 'Personnes', 'Ville', 'Commune']]);
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', alice, { Ville: 'Lille' }]]);
  await waitFor(async () => (await records(target.doc, 'Personnes')).find(r => r.Nom === 'Alice').Commune === 'Lille', 'destination renommée suivie');
  assert.ok(!(await columnsOf(target.doc, 'Personnes')).includes('Ville'), 'la colonne renommée n\'est pas recréée');
  await applyActions(target.doc, [['RenameColumn', 'Personnes', 'Commune', 'Ville'], ['RenameTable', 'Personnes', 'Contacts']]);
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', alice, { Ville: 'Marseille' }]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).find(r => r.Nom === 'Alice').Ville === 'Marseille', 'noms d\'origine suivis');
  step('CIBLE : table et colonne de destination renommées, la recopie suit');

  // --- Choix des colonnes et filtre de lignes. « Aucun » puis « Tous » ; seule Alice part (Nom
  // est l'une de), les autres lignes sont effacées chez la CIBLE ; puis par sa ville (Référence),
  // qui reste dans le filtre une fois renommée ; le filtre retiré, tout revient.
  const names = async () => (await records(target.doc, 'Contacts')).map(r => r.Nom).sort().join();
  const everyone = await names();
  const contactsBlock = () => dialog().locator('.table-block').filter({ has: widget().locator('h3', { hasText: /^Contacts$/ }) });
  const editFilter = async (change) => {
    await openWidget(source.url);
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    const rowsButton = contactsBlock().getByRole('button', { name: 'Filtrer les lignes', exact: true });
    if (await rowsButton.getAttribute('aria-expanded') !== 'true') await rowsButton.click();
    await change();
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/^Enregistré/).waitFor();
    await dialogButton('Fermer').click();
    await openWidget(target.url);
  };
  await editFilter(async () => {
    const columnsButton = contactsBlock().getByRole('button', { name: 'Choisir les colonnes', exact: true });
    if (await columnsButton.getAttribute('aria-expanded') !== 'true') await columnsButton.click();
    const columnsTotal = (await contactsBlock().locator('.check-count').first().textContent()).match(/sur\s(\d+)/)[1];
    const boxes = contactsBlock().locator('.check-list').first().getByRole('checkbox');
    const before = await boxes.evaluateAll(list => list.map(box => box.checked));
    await contactsBlock().getByRole('button', { name: 'Aucun', exact: true }).first().click();
    await contactsBlock().getByText(`0 sur ${columnsTotal}`).waitFor();
    await dialogButton('Continuer').click();
    await dialog().getByText('Cochez au moins une colonne', { exact: false }).waitFor();
    await contactsBlock().getByRole('button', { name: 'Tous', exact: true }).first().click();
    await contactsBlock().getByText(`${columnsTotal} sur ${columnsTotal}`).waitFor();
    for (const [i, box] of (await boxes.all()).entries()) if (!before[i]) await box.uncheck();
    await contactsBlock().getByRole('button', { name: 'Ajouter une condition', exact: true }).click();
    await contactsBlock().getByRole('group', { name: 'Valeur de la condition 1' }).getByRole('checkbox', { name: /^Alice/ }).check();
    await contactsBlock().getByText(/^1\sligne partira sur \d+/).waitFor();
  });
  await waitFor(async () => (await names()) === 'Alice', 'seule la ligne du filtre reste');
  await editFilter(async () => {
    await pick('Colonne de la condition 1', 'Lieu');
    await contactsBlock().getByRole('group', { name: 'Valeur de la condition 1' }).getByRole('checkbox', { name: /^Villeurbanne/ }).check();
    await contactsBlock().getByText(/^1\sligne partira sur \d+/).waitFor();
    assert.match(await contactsBlock().locator('p.small').first().textContent(), /lignes où Lieu est l’une de\s«\sVilleurbanne\s»/, 'résumé du filtre');
  });
  await applyActions(source.doc, [['UpdateRecord', 'Villes', 1, { Ville: 'Villeurbanne-Est' }]]);
  await waitFor(async () => (await names()) === 'Alice' && (await records(target.doc, 'Contacts'))[0].Lieu === 'Villeurbanne-Est', 'ville renommée : la ligne reste dans le filtre');
  await editFilter(async () => {
    await contactsBlock().getByRole('button', { name: 'Retirer la condition 1', exact: true }).click();
    await contactsBlock().getByText('Aucune condition : toutes les lignes partent.').waitFor();
  });
  await waitFor(async () => (await names()) === everyone, 'lignes revenues sans le filtre');
  step('SOURCE : colonnes (Aucun, Tous) ; filtre de lignes par valeurs cochées puis par Référence (renommée, elle reste), retiré, la CIBLE suit');

  // --- Table Synchro abîmée : marque d'envoi coupé numérique, sans dépendances de MajLe, avec
  // manualSort. Tout est remis en état à l'ouverture du widget SOURCE, et une suppression suit.
  const synchroRef = await tableRef(source.doc, 'Synchro');
  const lotRef = (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'Synchro_Lot' && c.parentId === synchroRef).id;
  const syncIds = (await records(source.doc, 'Synchro')).map(r => r.id);
  await applyActions(source.doc, [['ModifyColumn', 'Synchro', 'Sync_Etat', { type: 'Numeric' }],
    ['UpdateRecord', '_grist_Tables_column', majle.id, { recalcWhen: 2, recalcDeps: null }],
    ['AddColumn', 'Synchro', 'manualSort', { type: 'ManualSortPos', isFormula: false }], ['BulkUpdateRecord', 'Synchro', syncIds, { manualSort: syncIds }]]);
  const markRef = (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'Sync_Etat' && c.parentId === synchroRef).id;
  await applyActions(source.doc, [['UpdateRecord', '_grist_Tables_column', markRef, { recalcDeps: ['L', lotRef] }]]);
  await openWidget(source.url);
  await waitFor(async () => {
    const cols = await records(source.doc, '_grist_Tables_column');
    const mark = cols.find(c => c.id === markRef);
    return cols.find(c => c.id === majle.id).recalcWhen === 0 && mark.type === 'Any' && (mark.recalcDeps || []).length === 4 &&
      !cols.some(c => c.colId === 'manualSort' && c.parentId === synchroRef);
  }, 'Synchro remise en état');
  // Page de la CIBLE fermée : 70 envois du même lot attendent dans son journal. Avec manualSort,
  // ils se plaçaient tous au même rang et Grist finissait par renuméroter (403, file bloquée).
  const city = (await records(source.doc, 'Contacts')).find(r => r.id === alice).Ville;
  for (let i = 0; i < 70; i++) await applyActions(source.doc, [['UpdateRecord', 'Contacts', alice, { Ville: `Ville ${i}` }]]);
  await waitFor(async () => {
    const [hook] = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks;
    assert.notEqual(hook.usage.lastHttpStatus, 403, 'aucun envoi refusé par la CIBLE');
    return !hook.usage.numWaiting;
  }, '70 envois partis, page de la CIBLE fermée', 120000);
  await applyActions(source.doc, [['AddRecord', 'Contacts', null, { Nom: 'Yann' }]]);
  await openWidget(target.url);
  await waitFor(async () => (await records(target.doc, 'Contacts')).find(r => r.Nom === 'Alice').Ville === 'Ville 69', 'dernière valeur recopiée', 60000);
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', alice, { Ville: city }]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Nom === 'Yann'), 'ajout après la remise en état');
  await applyActions(source.doc, [['RemoveRecord', 'Contacts', (await records(source.doc, 'Contacts')).find(r => r.Nom === 'Yann').id]]);
  await waitFor(async () => !(await records(target.doc, 'Contacts')).some(r => r.Nom === 'Yann'), 'suppression après la remise en état');
  step('SOURCE : Synchro remise en état (marque d\'envoi coupé, dépendances de MajLe, sans manualSort) ; 70 envois page CIBLE fermée passent');

  // --- Gros import (4 000 lignes d'un coup) : le lot ne part qu'en partie, la CIBLE le signale ;
  // le widget SOURCE, une fois sa page ouverte, envoie le reste seul
  const before = (await records(target.doc, 'Contacts')).length;
  const imported = await addContacts('Import', 4000, 'x');
  const lotRow = async () => (await records(source.doc, 'Synchro')).find(r => r.Synchro_Table === 'Contacts' && r.Synchro_Type === 'lot');
  assert.ok((await lotRow()).Sync_Etat > 0, 'envoi coupé noté dans Synchro');
  await widget().getByText(/Contacts\s:\s[\d\s]+\slignes ne sont pas encore arrivées/).waitFor({ timeout: 60000 });
  await shot('19-cible-envoi-coupe');
  await openWidget(source.url);
  await widget().locator('[data-export-flow] [data-flow]').first().waitFor();
  // Le widget envoie le reste seul : la carte dit où il en est (lignes, lots), puis l'avis disparaît.
  await widget().locator('[data-flow="running"] progress').waitFor({ timeout: 120000 });
  // Chaque tranche annonce ce qui reste à venir (marque:reste:numéros), pour la CIBLE.
  await waitFor(async () => /^[0-9a-f]+:\d+:[\d,]*$/.test((await lotRow()).Synchro_Renvoi || ''), 'chaque tranche du renvoi annonce ce qui reste à venir', 30000);
  await widget().getByText(/Envoi en cours\s:\s[\d\s]+ sur [\d\s]+ lignes \([\d\s]+%\), lot [\d\s]+ sur environ [\d\s]+/).first().waitFor();
  await widget().locator('[data-export-flow] [data-flow]').first().waitFor({ state: 'detached', timeout: 240000 });
  assert.equal((await lotRow()).Sync_Etat, 0, 'marque effacée');
  await openWidget(target.url);
  await waitFor(async () => (await records(target.doc, 'Contacts')).length === before + imported.length, 'gros import reçu en entier', 120000);
  await waitFor(async () => !(await widget().getByText('pas encore arrivées').count()), 'avis de la CIBLE retiré', 30000);
  await applyActions(source.doc, [['BulkRemoveRecord', 'Contacts', imported]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).length === before, 'gros import effacé', 120000);
  step('SOURCE : un import de 4 000 lignes part en entier, le widget SOURCE envoie seul ce qu\'un envoi n\'a pas porté');

  // --- Renvoi en tranches interrompu (page SOURCE fermée en route) : la CIBLE dit combien de lignes
  // restent à venir au lieu de rester « À jour » avec une table à moitié reçue. On écrit à la main ce
  // que le widget écrit à chaque tranche, puis la dernière tranche (reste zéro).
  const sliceLot = await lotRow();
  const slice = (await records(source.doc, 'Contacts')).slice(0, 2).map(r => r.id);
  await applyActions(source.doc, [['UpdateRecord', 'Synchro', sliceLot.id, { Synchro_Renvoi: `ab12:123:${slice.join(',')}` }]]);
  assert.equal(JSON.parse((await lotRow()).Synchro_Lot).restant, 123, 'le lot annonce ce qui reste');
  await widget().getByText(/Contacts\s:\s123\slignes ne sont pas encore arrivées/).waitFor({ timeout: 60000 });
  await applyActions(source.doc, [['UpdateRecord', 'Synchro', sliceLot.id, { Synchro_Renvoi: `ab13:0:${slice[0]}` }]]);
  await waitFor(async () => !(await widget().getByText('pas encore arrivées').count()), 'dernière tranche : avis retiré', 60000);
  await applyActions(source.doc, [['UpdateRecord', 'Synchro', sliceLot.id, { Synchro_Renvoi: '' }]]);
  step('CIBLE : un renvoi en tranches interrompu dit combien de lignes restent à venir, la dernière tranche efface l\'avis');

  // --- Bilan : un envoi perdu (webhook coupé, comme une file vidée ou un Grist redémarré) ne laisse
  // pas la CIBLE « À jour » avec une table incomplète. Chaque lot annonce le nombre de clés de la
  // SOURCE ; la CIBLE dit le manque s'il dure (20 secondes ici, 10 minutes en vrai).
  const syncNow = () => widget().getByRole('button', { name: 'Synchroniser', exact: true }).click();
  const tallyText = /Contacts\s:\sla SOURCE annonce [\d\s]+ lignes, mais seules [\d\s]+ sont arrivées ici/;
  const hookList = async () => (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks;
  const setHooks = async enabled => { for (const h of await hookList()) await api('PATCH', `/docs/${source.doc}/webhooks/${h.id}`, { enabled }); };
  // Rien de perdu depuis le début du parcours : pas de fausse alerte, même après le délai.
  await syncNow();
  await new Promise(r => setTimeout(r, 22000));
  await syncNow();
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(await widget().getByText(tallyText).count(), 0, 'aucun manque signalé quand rien n\'est perdu');
  await setHooks(false);
  await applyActions(source.doc, [['AddRecord', 'Contacts', null, { Nom: 'Perdue' }]]);
  await new Promise(r => setTimeout(r, 7000)); // hors de la fenêtre d'un lot : 'Visible' part seul
  await setHooks(true);
  await applyActions(source.doc, [['AddRecord', 'Contacts', null, { Nom: 'Visible' }]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Nom === 'Visible'), 'ligne envoyée après la reprise reçue', 60000);
  assert.ok(!(await records(target.doc, 'Contacts')).some(r => r.Nom === 'Perdue'), 'la ligne ajoutée pendant la coupure n\'est jamais partie');
  await syncNow();
  await new Promise(r => setTimeout(r, 22000));
  await syncNow();
  await widget().getByText(tallyText).waitFor({ timeout: 20000 });
  // La SOURCE renvoie la ligne perdue : le manque disparaît.
  const lostId = (await records(source.doc, 'Contacts')).find(r => r.Nom === 'Perdue').id;
  await applyActions(source.doc, [['UpdateRecord', 'Synchro', (await lotRow()).id, { Synchro_Renvoi: `ab77:0:${lostId}` }]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Nom === 'Perdue'), 'ligne perdue renvoyée et reçue', 60000);
  await syncNow();
  await waitFor(async () => !(await widget().getByText(tallyText).count()), 'manque effacé une fois la ligne reçue', 30000);
  await applyActions(source.doc, [['UpdateRecord', 'Synchro', (await lotRow()).id, { Synchro_Renvoi: '' }]]);
  const extra = (await records(source.doc, 'Contacts')).filter(r => ['Perdue', 'Visible'].includes(r.Nom)).map(r => r.id);
  await applyActions(source.doc, [['BulkRemoveRecord', 'Contacts', extra]]);
  await waitFor(async () => !(await records(target.doc, 'Contacts')).some(r => ['Perdue', 'Visible'].includes(r.Nom)), 'lignes de l\'essai effacées aussi chez le destinataire', 120000);
  step('CIBLE : un envoi perdu est signalé comme un manque après le délai (aucune fausse alerte avant), puis effacé quand la ligne est renvoyée');

  // --- File bloquée par un envoi trop gros : la CIBLE refuse un moment (colonne du journal
  // renommée), cinq gros lots attendent, Grist les regroupe en un envoi de plus de 1 Mo (413). Le
  // widget SOURCE vide la file et renvoie tout, seul.
  const blocIds = await addContacts('Bloc', 1500, 'y');
  await openWidget(source.url);
  const usages = async () => (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.map(h => h.usage || {});
  await waitFor(async () => (await lotRow()).Sync_Etat === 0 && (await usages()).every(u => !u.numWaiting), 'bloc envoyé', 120000);
  await applyActions(target.doc, [['RenameColumn', 'Journal_Annuaire', 'Sync_Par', 'Sync_Par_x']]);
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', byName('Bob').id, { Ville: 'Brest' }]]);
  await waitFor(async () => (await usages()).some(u => u.lastHttpStatus === 400), 'envoi refusé par la CIBLE');
  for (const round of [1, 2, 3, 4, 5]) await applyActions(source.doc, [['BulkUpdateRecord', 'Contacts', blocIds, { Interne: blocIds.map(() => `r${round}`) }]]);
  await applyActions(target.doc, [['RenameColumn', 'Journal_Annuaire', 'Sync_Par_x', 'Sync_Par']]);
  await waitFor(async () => (await usages()).some(u => u.lastHttpStatus === 413), 'envois regroupés refusés (413)', 120000);
  // Fini quand plus aucun lot n'est marqué ni en renvoi : la page peut se fermer.
  const settled = async () => (await records(source.doc, 'Synchro'))
    .every(r => (r.Synchro_Type === 'lot' ? !r.Sync_Etat && !r.Synchro_Renvoi : r.Synchro_Type !== 'cles' || !r.Synchro_Renvoi));
  await waitFor(async () => !(await usages()).some(u => u.lastHttpStatus === 413) && await settled(), 'file débloquée, tout renvoyé', 240000);
  await openWidget(target.url);
  await waitFor(async () => {
    const rows = await records(target.doc, 'Contacts');
    return rows.filter(r => r.Interne === 'r5').length === blocIds.length && rows.find(r => r.Nom === 'Bob').Ville === 'Brest';
  }, 'tout reçu après le déblocage', 240000);
  await widget().locator('.drift').waitFor({ state: 'detached', timeout: 30000 }); // la SOURCE a changé la ligne de Bob : plus d'écart
  await applyActions(source.doc, [['BulkRemoveRecord', 'Contacts', blocIds]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).length === before, 'bloc effacé', 120000);
  step('SOURCE : une file bloquée par un envoi de plus de 1 Mo est vidée et tout est renvoyé, seul');

  // --- Grande table (21 000 lignes) : envoyée en plusieurs fois. Ses suppressions suivent par les
  // seaux qui ont perdu une clé ; plus de 5 000 clés à envoyer d'un coup, le widget SOURCE renvoie
  // la liste complète, en morceaux, et la CIBLE n'efface qu'une fois tous les morceaux arrivés.
  const N = 21000;
  await applyActions(source.doc, [['AddTable', 'Grande', [{ id: 'N', type: 'Int' }]],
    ['BulkAddRecord', 'Grande', Array(N).fill(null), { N: Array.from({ length: N }, (_, i) => i) }]]);
  const editTables = async (table, on) => {
    await openWidget(source.url);
    await button('Modifier').click();
    await dialog().getByRole('checkbox', { name: table })[on ? 'check' : 'uncheck']();
    await dialogButton('Continuer').click();
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/^Enregistré/).waitFor({ timeout: 900000 });
    await dialogButton('Fermer').click();
  };
  await editTables('Grande', true);
  await openWidget(target.url);
  await dialog().getByText('Table ajoutée à l’export : Grande').waitFor({ timeout: 60000 });
  await dialogButton('Recevoir').click();
  await confirmNewTable();
  await dialog().waitFor({ state: 'detached', timeout: 120000 });
  const grande = async () => (await records(target.doc, 'Grande')).length;
  await waitFor(async () => await grande() === N, 'grande table reçue en entier', 300000);
  const sourceTab = await context.newPage();
  await sourceTab.goto(source.url);
  await sourceTab.frameLocator('iframe').first().locator('.topbar').waitFor({ timeout: 30000 });
  await page.bringToFront();
  const grandeIds = (await records(source.doc, 'Grande')).map(r => r.id);
  await applyActions(source.doc, [['BulkRemoveRecord', 'Grande', grandeIds.slice(0, 5500)]]);
  await waitFor(async () => await grande() === N - 5500, 'suppression de 5 500 lignes suivie (liste complète)', 300000);
  await applyActions(source.doc, [['BulkRemoveRecord', 'Grande', grandeIds.slice(5500, 5502)]]);
  await waitFor(async () => await grande() === N - 5502, 'suppression de 2 lignes suivie (seaux)', 120000);
  await sourceTab.close();
  await editTables('Grande', false);
  await applyActions(source.doc, [['RemoveTable', 'Grande']]);
  step('SOURCE : une table de 21 000 lignes part en plusieurs fois, ses suppressions suivent, même 5 500 d\'un coup');

  // --- Pause puis reprise avec rattrapage : seules les lignes changées pendant la pause repartent,
  // et une ligne effacée pendant la pause disparaît de la CIBLE (liste complète)
  const zoe = (await applyActions(source.doc, [['AddRecord', 'Contacts', null, { Nom: 'Zoé' }]])).retValues[0];
  await openWidget(target.url);
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Nom === 'Zoé'), 'Zoé reçue');
  await openWidget(source.url);
  await button('Mettre en pause').click();
  await button('Reprendre').waitFor();
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', byName('Alice').id, { Ville: 'Toulon' }], ['AddRecord', 'Contacts', null, { Nom: 'Emma' }],
    ['RemoveRecord', 'Contacts', zoe]]);
  await new Promise(r => setTimeout(r, 3000));
  assert.ok(!(await records(target.doc, 'Journal_Annuaire')).some(r => (r.Synchro_Lot || r.Synchro_Donnees || '').includes('Toulon')), 'rien envoyé pendant la pause');
  await button('Reprendre').click();
  await dialog().getByText('Renvoie 2 lignes ajoutées ou modifiées').waitFor();
  await shot('13b-source-reprendre');
  await dialogButton('Reprendre').click();
  await dialog().waitFor({ state: 'detached' });
  await button('Mettre en pause').waitFor();
  await openWidget(target.url);
  await waitFor(async () => {
    const rows = await records(target.doc, 'Contacts');
    return rows.some(r => r.Nom === 'Emma') && rows.some(r => r.Ville === 'Toulon') && !rows.some(r => r.Nom === 'Zoé');
  }, 'modifications et suppression de la pause rattrapées');
  step('SOURCE : pause, puis reprise qui rattrape les deux lignes changées et la ligne effacée pendant la pause');

  // --- Relais : la CIBLE peut renvoyer une table reçue ; ses journaux ne sont pas proposés
  await widget().getByRole('tab', { name: 'Envoyer' }).click();
  await button('Nouvel export').click();
  await dialog().getByRole('checkbox', { name: 'Contacts' }).waitFor();
  const offered = await dialog().locator('.check-list label').allTextContents();
  assert.ok(offered.some(l => l.includes('Contacts')) && !offered.some(l => l.includes('Journal_')), 'journaux exclus de l\'envoi');
  await dialog().getByRole('checkbox', { name: 'Contacts' }).check();
  await dialogButton('Continuer').click();
  await dialog().getByText('Table reçue d’un autre document').waitFor();
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' });
  // La table Synchro, vide et protégée, est posée avant l'assistant (0.19) : aucune ligne n'est écrite.
  const syncAfter = (await records(target.doc, '_grist_Tables')).some(tb => tb.tableId === 'Synchro') ? (await records(target.doc, 'Synchro')).length : 0;
  assert.equal(syncAfter, 0, 'assistant fermé : aucune ligne d\'export écrite');
  step('CIBLE : une table reçue peut être relayée (avis affiché), journaux exclus');

  // --- Lignes forgées avec le lien du formulaire : rejetées et signalées ; lien coupé, puis la
  // même réception reprend avec une nouvelle invitation. Le formulaire partage d'abord sa page avec
  // un autre (montage d'avant la 0.5) : le lien commun est signalé, et la coupure le sépare.
  const hookUrl = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks[0].fields.url;
  const journalForm = (await publishedForms(target.doc))[0];
  const neighbour = (await applyActions(target.doc, [['CreateViewSection', await tableRef(target.doc, 'Communes'), journalForm.parentId, 'form', null, null]])).retValues[0];
  await applyActions(target.doc, [['UpdateRecord', '_grist_Views_section', neighbour.sectionRef, { shareOptions: '{"form": true, "publish": true}' }]]);
  const exportId = (await records(source.doc, 'Synchro'))[0].Synchro_Export;
  const forgedSha = createHash('sha1').update('pirate').digest('hex');
  const forge = rows => fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) });
  const pirate = JSON.stringify({ lignes: [['pirate', 9e9, false, { Nom: 'Pirate' }]], total: 1 });
  const unsigned = JSON.stringify({ lignes: [['pirate2', Date.now() / 1000, false, { Nom: 'Pirate' }]], total: 1 });
  const revokedRow = { Synchro_Export: exportId, Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Colonnes: (await records(source.doc, 'Synchro')).find(r => r.Synchro_Type === 'lot' && r.Synchro_Table === 'Contacts').Synchro_Colonnes };
  // Versions « déjà dépliées » (sans Synchro_Type), postées par la clé du formulaire : elles ne
  // passent pas par le dépliage, donc ni par la signature ; sans le sceau du widget, rejetées.
  const victim = (await records(target.doc, 'Contacts')).find(r => r.id_sync);
  const now = Date.now() / 1000;
  const injected = [
    { Synchro_Table: 'Contacts', id_sync: victim.id_sync, MajLe: 32503680000, Supprime: true, Synchro_Donnees: '{}' },
    { Synchro_Table: 'Contacts', id_sync: 'pirate3', MajLe: now, Synchro_Donnees: JSON.stringify({ Nom: 'Pirate', Photo: [[`${forgedSha}.txt`, 'pirate.txt', 6]] }) },
    { Synchro_Table: 'Contacts', Synchro_Ids: JSON.stringify({ seaux: { [bucketOf(victim.id_sync)]: [] }, t: now }) },
    { Synchro_Table: 'Contacts', id_sync: victim.id_sync, MajLe: 32503680000, Sync_Applique: true, Sync_Etat: 'ajout', Sync_Recu: 1e13, Synchro_Donnees: '{"Nom":"Faux"}' },
    { Synchro_Table: 'Inconnue', id_sync: 'pirate4', MajLe: now, Synchro_Donnees: '{"Nom":"Pirate"}', Synchro_Colonnes: '[{"id":"Nom","type":"Text"}]' },
  ];
  assert.ok((await forge([
    ...injected,
    { Synchro_Export: 'ffffffffffffffff', Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Lot: pirate },
    { Synchro_Export: exportId, Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Lot: 'pas du JSON' },
    { Synchro_Export: exportId, Synchro_Table: 'Contacts', Synchro_Type: 'complet', Synchro_Lot: pirate },
    // Bien formées, du bon export, mais sans la signature de la SOURCE : un lot, un avis de fin ;
    // un lot signé avec la clé du destinataire révoqué (qui a reçu le même export).
    { Synchro_Export: exportId, Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Lot: unsigned },
    { ...revokedRow, Synchro_Lot: await signText(key2, revokedRow, unsigned) },
    { Synchro_Export: exportId, Synchro_Type: 'fin', Synchro_Lot: '{"fin": true}' },
    // Un fichier complet et intègre, mais qu'aucune version signée ne cite : il attend, sans dépôt.
    partRow(exportId, { sha: forgedSha, name: 'pirate.txt', size: 6 }, '0000abcd', 0, 1, Buffer.from('pirate').toString('base64')),
  ])).ok, 'le lien du formulaire accepte n\'importe quelle ligne');
  await widget().getByRole('tab', { name: 'Recevoir' }).click();
  // Rien n'est arrivé depuis plus d'une minute : le passage suivant viendrait dans une minute.
  await widget().getByRole('button', { name: 'Synchroniser', exact: true }).click();
  await widget().getByText('Arrivées suspectes').waitFor();
  // Exactement 11 (« 11 011 lignes » contient aussi « 11 lignes ») : aucune ligne légitime écartée.
  await widget().getByText(/(?<!\d\s?)11\s+lignes rejetées/).waitFor();
  assert.equal(await widget().getByText('Coupé par la SOURCE').count(), 0, 'un avis de fin forgé ne coupe pas la réception');
  await widget().getByText('Lien commun à d’autres formulaires').waitFor();
  const contactsAfter = await records(target.doc, 'Contacts');
  assert.ok(!contactsAfter.some(r => r.Nom === 'Pirate' || r.Nom === 'Faux'), 'rien de recopié');
  assert.equal(contactsAfter.find(r => r.id === victim.id).Nom, victim.Nom, 'rien d\'effacé ni de modifié');
  assert.equal(await widget().getByText(/\bInconnue\b/).count(), 0, 'aucune table proposée');
  assert.ok(!(await records(target.doc, 'Journal_Annuaire')).some(r => !r.Synchro_Type && r.Synchro_Table && !r.Sync_Sceau), 'versions injectées effacées');
  const leftRaw = await rawRows(target.doc, 'Journal_Annuaire');
  assert.deepEqual(leftRaw.map(r => r.Synchro_Type), ['fichier'], 'lignes rejetées effacées, le fichier non cité attend');
  assert.ok(!(await records(target.doc, '_grist_Attachments')).some(a => a.fileIdent.startsWith(forgedSha)), 'fichier non cité : pas déposé');
  await applyActions(target.doc, [['BulkRemoveRecord', 'Journal_Annuaire', leftRaw.map(r => r.id)]]);
  await shot('17-cible-suspect');
  await button('Couper le lien').first().click();
  await dialogButton('Couper le lien').click();
  await widget().getByText('Lien coupé').waitFor();
  await waitFor(async () => !(await forge([{ id_sync: '' }])).ok, 'l\'ancien lien n\'écrit plus dans le journal', 10000);
  assert.ok(!(await publishedForms(target.doc)).some(f => f.id === journalForm.id), 'formulaire du journal retiré de la page commune');
  const commonPage = await pageOf(target.doc, journalForm.parentId);
  assert.ok((await records(target.doc, '_grist_Shares')).some(sh => sh.id === commonPage.shareRef), 'la page commune garde son partage pour l\'autre formulaire');
  await openWidget(source.url);
  await revoke();
  await waitFor(async () => !(await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.length, 'ancien destinataire révoqué');
  await button('Ajouter un destinataire').click();
  await dialogButton('Créer l’invitation').click();
  await dialog().getByText('Transmettez ce code').waitFor();
  const syncRef = await tableRef(source.doc, 'Synchro');
  await dialogButton('Plus tard').click();
  // Une invitation vaut 7 jours : expirée, son code est refait d'un clic.
  const noteCol = (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'Synchro_Export' && c.parentId === syncRef);
  const sourceNote = syncNoteOf(noteCol);
  sourceNote.invitations = sourceNote.invitations.map(i => ({ ...i, at: i.at - 8 * 86400 }));
  await applyActions(source.doc, [syncNoteWrite(noteCol, sourceNote)]);
  await openWidget(source.url);
  await widget().getByText('Expirée', { exact: true }).waitFor();
  await button('Refaire le code').click();
  await dialogButton('Refaire le code').click();
  await dialog().getByText('Transmettez ce code').waitFor();
  const invitation3 = await dialog().locator('textarea.code').first().inputValue();
  await dialogButton('Plus tard').click();
  await openWidgetTab(target.url, 'Recevoir');
  await button('Accepter une invitation').click();
  await dialog().locator('textarea.code').first().fill(invitation3);
  await dialogButton('Continuer').click();
  await dialog().getByText('Cette invitation reprend la même réception').waitFor();
  await dialog().getByText(`Données de ${env.email}`).waitFor();
  await dialogButton('Reprendre la réception').click();
  await dialog().getByText('la même réception reprend').waitFor();
  const journalRef = await tableRef(target.doc, 'Journal_Annuaire');
  const forms3 = (await publishedForms(target.doc)).filter(f => f.tableRef === journalRef);
  assert.equal(forms3.length, 1, 'un seul formulaire pour le journal');
  assert.notEqual(forms3[0].parentId, journalForm.parentId, 'sur une nouvelle page, à lui seul');
  assert.equal((await records(target.doc, '_grist_Views_section')).filter(sc => sc.parentId === forms3[0].parentId).length, 1);
  const reply3 = await testLink('Lien du formulaire', await formLink(target.doc, forms3[0]), 'Le lien fonctionne');
  shownControl = await dialog().locator('.control-code strong').first().textContent();
  await dialogButton('Fermer').click();
  await approve(reply3, { compare: true }); // l'export est passé en sécurité renforcée avec le second destinataire
  // Fin du montage d'avant la 0.5 simulé : la page commune et son partage disparaissent.
  const oldPage = await pageOf(target.doc, journalForm.parentId);
  await applyActions(target.doc, [['RemoveView', journalForm.parentId], ['RemoveRecord', '_grist_Shares', oldPage.shareRef]]);
  assert.equal((await records(target.doc, '_grist_Tables')).filter(tb => tb.tableId.startsWith('Journal_')).length, 1, 'même journal');
  await moveAlice('Brest', 'la réception reprend');
  step('CIBLE : lignes forgées par le lien du formulaire rejetées et signalées ; lien coupé, la même réception reprend avec une nouvelle invitation');

  // --- Arrêts : la CIBLE efface son journal ; la SOURCE révoque, puis supprime l'export
  await widget().getByRole('tab', { name: 'Recevoir' }).click();
  await button('Arrêter la réception').click();
  await dialogButton('Arrêter la réception').click();
  await waitFor(async () => !(await records(target.doc, '_grist_Tables')).some(tb => tb.tableId.startsWith('Journal_')), 'journal effacé');
  await waitFor(async () => !(await records(target.doc, '_grist_Shares')).length, 'partage du formulaire retiré');
  const targetSections = await records(target.doc, '_grist_Views_section');
  assert.ok(!targetSections.some(sc => sc.parentKey === 'form'), 'formulaire effacé');
  const synchroPage = (await records(target.doc, '_grist_Views')).find(v => v.name === 'Synchro');
  const leaves = JSON.stringify(JSON.parse(synchroPage.layoutSpec || '{}')).match(/"leaf":\d+/g) || [];
  assert.ok(leaves.every(l => targetSections.some(sc => sc.id === Number(l.slice(7)) && sc.parentId === synchroPage.id)), 'disposition de la page du widget intacte');
  assert.ok(!(await pagesOf(target.doc)).some(p => p.name.startsWith('Journal_')), 'page du formulaire effacée');
  assert.equal((await records(target.doc, 'Contacts')).length, 4, 'destination gardée');
  await openWidget(source.url);
  await revoke();
  await widget().getByText('Personne ne reçoit encore cet export.').waitFor();
  await button('Supprimer').click();
  await dialogButton('Supprimer').click();
  // Synchro effacée, ses règles partent au dessin suivant : le document se recharge, et le widget,
  // sans rôle, revient à l'accueil.
  const home = () => widget().locator('.tile', { hasText: 'Envoyer des tables' });
  await home().waitFor({ timeout: 60000 });
  assert.ok(!(await records(source.doc, '_grist_ACLRules')).some(r => r.memo === 'Synchro : réservée aux propriétaires'), 'règles de Synchro retirées avec elle');
  assert.deepEqual((await records(source.doc, '_grist_Tables')).map(tb => tb.tableId).sort(), ['Contacts', 'Table1', 'Villes'], 'table Synchro effacée');
  assert.equal((await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.length, 0);
  step('CIBLE puis SOURCE : réception arrêtée, révocation, export supprimé avec sa table technique');

  // --- Lien public : un seul code, la CIBLE lit les instantanés de l'export sans identifiant. Refusé
  // tant qu'une règle d'accès cache une partie d'une table de l'export (le lien public la montrerait).
  const unhide = await hideColumn(source.doc, 'Contacts', 'Interne');
  await openWidget(source.url);
  await home().click();
  await newExport('Contacts', 'Annuaire');
  await dialogButton('Ajouter un destinataire').click();
  await dialog().getByRole('radio', { name: /Lien public/ }).check();
  await dialog().getByText(/Toute personne qui a le lien du document pourra lire ces colonnes\s:\sContacts \(/).waitFor();
  await dialogButton('Créer l’invitation').click();
  await dialog().getByText(/Lien public refusé\s:\sune règle d’accès cache une partie de Contacts/).waitFor();
  await dialogButton('Annuler').click();
  await unhide();
  await openWidget(source.url);
  await button('Ajouter un destinataire').click();
  await dialog().getByRole('radio', { name: /Lien public/ }).check();
  await shot('15-source-public');
  await dialogButton('Créer l’invitation').click();
  await dialog().getByText('Transmettez ce code').waitFor();
  const publicCode = await dialog().locator('textarea.code').first().inputValue();
  await dialogButton('Fermer').click();
  await widget().getByText('Lien public à activer').waitFor();
  await api('PATCH', `/docs/${source.doc}/access`, { delta: { users: { 'everyone@getgrist.com': 'viewers' } } });
  const anon = async table => fetch(`${TEAM}/api/docs/${source.doc}/tables/${table}/records`);
  assert.equal((await anon('Contacts')).status, 403, 'table source cachée au lien public');
  assert.equal((await anon('Villes')).status, 403, 'autres tables cachées');
  const visible = (await (await anon('Synchro')).json()).records;
  assert.deepEqual(visible.map(r => r.fields.Synchro_Type).sort(), ['complet', 'empreinte'], 'seuls l\'instantané de l\'export public et son empreinte sont lisibles');
  assert.match(visible.find(r => r.fields.Synchro_Type === 'empreinte').fields.Synchro_Ids, /^\d+:[0-9a-f]{8}$/);
  // La note (exports, invitations) est la description de Synchro_Export ; les formules des autres
  // colonnes citent ce nom, lisible, lui.
  const anonColumns = (await (await fetch(`${TEAM}/api/docs/${source.doc}/tables/Synchro/columns`)).json()).columns;
  assert.ok(anonColumns.some(c => c.id === 'Synchro_Lot') && !anonColumns.some(c => c.id === 'Synchro_Export'), 'colonne de la note cachée au lien public');
  assert.ok(!anonColumns.some(c => /invitations|exports/.test(c.fields.description || '')), 'note de la SOURCE cachée au lien public');
  // Les métadonnées du document (`_grist_Tables_column`) se lisent en anonyme quand aucune règle générale ne les refuse : Grist y vide
  // les options d'une colonne qu'un lecteur ne lit pas, mais pas sa description. Les notes du widget sont dans les options (voir
  // columnNote) : ni le courriel d'un destinataire, ni la clé privée d'une invitation, ni le secret d'un journal, ni la clé de
  // signature ne s'y lisent. Une SOURCE qui a un export public refuse même ces tables (la règle `*` → -R, vu : 403) ; la sonde
  // tests/e2e/tools/probe-public.mjs couvre la SOURCE sans export public.
  const metadata = async (doc) => {
    const res = await fetch(`${TEAM}/api/docs/${doc}/tables/_grist_Tables_column/records`);
    return { status: res.status, columns: res.status === 200 ? (await res.json()).records.map(r => r.fields) : [] };
  };
  const noteLeaks = columns => columns.filter(c => /syncNote|"invitations"|"exports"|"signature"|"prive"|"secret"/.test(`${c.description || ''}${c.widgetOptions || ''}`));
  assert.ok((await records(source.doc, '_grist_Tables_column')).some(c => c.colId === 'Synchro_Export' && syncNoteOf(c).exports), 'la note de la SOURCE existe (contrôle non vide)');
  const onSource = await metadata(source.doc);
  assert.ok(onSource.status === 403 || noteLeaks(onSource.columns).length === 0, 'la note de la SOURCE n\'est pas lisible dans les métadonnées, en anonyme');
  // Les webhooks sont dans les métadonnées (`_grist_Triggers`), lisibles par tous : leur mémo n'y dit rien du destinataire.
  const anonTriggers = await fetch(`${TEAM}/api/docs/${source.doc}/tables/_grist_Triggers/records`);
  const triggerText = anonTriggers.status === 200 ? await anonTriggers.text() : '';
  if (anonTriggers.status === 200) assert.ok(triggerText.includes('"memo":"r-'), 'contrôle non vide : les webhooks de la SOURCE sont lus');
  assert.ok(!triggerText.includes('@') && !triggerText.includes(target.doc.slice(0, 10)), 'le mémo des webhooks ne montre ni e-mail ni document du destinataire, en anonyme');
  step('Lien public sur une SOURCE qui a un export public : les métadonnées du document ne montrent pas sa note');
  await openWidget(source.url);
  await widget().getByText('Public', { exact: true }).waitFor();
  // Une règle d'accès posée après coup sur une table de l'export public est signalée sur sa carte.
  const unhideLater = await hideColumn(source.doc, 'Contacts', 'Interne');
  await openWidget(source.url);
  await widget().getByText(/Une règle d’accès cache maintenant une partie de Contacts/).waitFor();
  await unhideLater();
  // Lien public réglé sur Éditeur : les règles du widget, qui visent les lecteurs, ne protègent plus.
  await api('PATCH', `/docs/${source.doc}/access`, { delta: { users: { 'everyone@getgrist.com': 'editors' } } });
  await openWidget(source.url);
  await widget().getByText(/Le lien public de ce document est réglé sur Éditeur/).waitFor();
  await api('PATCH', `/docs/${source.doc}/access`, { delta: { users: { 'everyone@getgrist.com': 'viewers' } } });
  await openWidget(source.url);
  assert.equal(await widget().getByText(/réglé sur Éditeur/).count(), 0);

  await openWidget(target.url);
  await widget().locator('.tile', { hasText: 'Recevoir des tables' }).click();
  await button('Accepter une invitation').click();
  await dialog().locator('textarea.code').first().fill(publicCode);
  await dialogButton('Continuer').click();
  await dialog().getByLabel('Nom de la nouvelle table pour Contacts').fill('Annuaire');
  await dialogButton('Continuer').click();
  await confirmNewTable();
  await dialog().getByText('Branché').waitFor();
  await dialogButton('Fermer').click();
  const live = (await records(source.doc, 'Contacts')).filter(r => !r.Supprime).length;
  await waitFor(async () => (await records(target.doc, 'Annuaire')).length === live, 'lien public : lignes lues');
  await applyActions(source.doc, [['AddRecord', 'Contacts', null, { Nom: 'Émile', Interne: 'i5' }]]);
  await waitFor(async () => (await records(target.doc, 'Annuaire')).some(r => r.Nom === 'Émile'), 'lien public : ajout lu');
  step('Lien public : seul l\'instantané de l\'export est lisible (sans la note de la SOURCE), la CIBLE le recopie sans échange de réponse');

  await openWidget(source.url);
  await button('Couper le lien public').click();
  await dialogButton('Couper le lien public').click();
  await waitFor(async () => (await anon('Synchro')).status === 403, 'instantané fermé');
  await openWidget(source.url);
  await button('Supprimer').click();
  await dialogButton('Supprimer').click();
  await home().waitFor({ timeout: 60000 });
  assert.equal((await anon('Contacts')).status, 403, 'reste du document toujours caché tant qu\'il est public');
  step('Lien public coupé, export supprimé : plus rien de lisible');

  await exchangeSteps();
  await filesSteps();
  await exchangeFilesSteps();
  await optionsSteps();
  await choicesSteps();
  await typesSteps();
  await structureSteps();
  await adoptSteps();
  await newColumnsSteps();
  await layoutSteps();
  await linksSteps();
  await formatSteps();
  await formulasSteps();
  await straySteps();
  await docLinkSteps();
  await protectSteps();
  await cleanSteps();
  await widgetPageSteps();
  await renfSteps();
  await newsSteps();
  await tabSteps();

  assert.deepEqual(errors, [], 'aucune erreur dans la console');
  console.log('Parcours complet : OK');
} catch (e) {
  await page.screenshot({ path: join(ROOT, 'tests/e2e/echec.png') });
  console.error(e);
  console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
