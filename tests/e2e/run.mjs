// Test d'intégration : le parcours complet, dans un vrai Grist (tests/e2e/start-grist.sh) et un
// vrai navigateur (Playwright). Trois documents, le widget installé dans chacun :
//   SOURCE : créer un export, inviter (avec secret) ;  CIBLE : accepter, coller le lien, répondre ;
//   SOURCE : approuver, envoyer l'existant ;  CIBLE : consolider ; ajout, modification, suppression
//   logique et vraie suppression ; un second destinataire, puis sa seule révocation ; une table
//   ajoutée à l'export (fenêtre côté CIBLE, table existante) ; pause et reprise ; lien public.
// Seul écart avec un humain : le lien du formulaire est lu dans la base du serveur de test au lieu
// d'être copié depuis le bouton « Partager » de Grist (hors du widget).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = JSON.parse(await readFile(join(ROOT, 'tests/e2e/.env.json'), 'utf8'));
const WIDGET_PORT = 8585;
const WIDGET_URL = `http://localhost:${WIDGET_PORT}/index.html`;
const TEAM = `${env.grist}/o/${env.team}`;

// --- Widget servi en local. L'instance de test est ajoutée à la liste des instances autorisées
// (config.js) et à la politique de sécurité (index.html), comme le ferait une instance qui
// héberge sa propre copie.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    let body = await readFile(join(ROOT, path));
    if (path === '/index.html') body = String(body).replaceAll('https://grist.numerique.gouv.fr', `${env.grist} https://grist.numerique.gouv.fr`);
    if (path === '/js/config.js') body = String(body).replace("GRIST_ORIGINS = [", `GRIST_ORIGINS = ['${env.grist}', `);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404); res.end();
  }
});
await new Promise(resolve => server.listen(WIDGET_PORT, resolve));

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
const records = async (doc, table) => (await api('GET', `/docs/${doc}/tables/${table}/records`)).records.map(r => ({ id: r.id, ...r.fields }));
const tableRef = async (doc, tableId) => (await records(doc, '_grist_Tables')).find(t => t.tableId === tableId).id;

async function newDocWithWidget(name, setup) {
  const workspace = (await api('GET', `/orgs/${env.team}/workspaces`))[0].id;
  const doc = await api('POST', `/workspaces/${workspace}/docs`, { name });
  if (setup) await applyActions(doc, setup);
  const view = (await applyActions(doc, [['CreateViewSection', await tableRef(doc, 'Table1'), 0, 'record', null, null]])).retValues[0];
  await applyActions(doc, [
    ['UpdateRecord', '_grist_Views', view.viewRef, { name: 'Synchro' }],
    ['UpdateRecord', '_grist_Views_section', view.sectionRef, {
      parentKey: 'custom', options: JSON.stringify({ customView: JSON.stringify({ mode: 'url', url: WIDGET_URL, access: 'full', renderAfterReady: false }) }),
    }],
  ]);
  return { doc, url: `${TEAM}/doc/${doc}/p/${view.viewRef}` };
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

const step = text => console.log(`· ${text}`);
// Images d'aide montrées par l'assistant à l'étape Lien (img/) : la carte du formulaire publié
// avec son bouton « Partager », puis la fenêtre de partage avec « Copier le lien ».
async function helpShots() {
  await clean();
  const pad = async (locator, path, margin = 12) => {
    const box = await locator.boundingBox();
    await page.screenshot({ path: join(ROOT, 'img', path), clip: {
      x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin), width: box.width + 2 * margin, height: box.height + 2 * margin } });
  };
  const share = page.getByRole('button', { name: 'Partager', exact: true }).first();
  const banner = share.locator('xpath=ancestor::div[.//button[normalize-space()="Dépublier"]][1]');
  await pad(banner, 'aide-partager.png');
  await share.click();
  const copy = page.getByText('Copier le lien', { exact: true }).first();
  await copy.waitFor();
  await pad(copy.locator('xpath=ancestor::div[5]'), 'aide-copier.png', 4);
  await page.keyboard.press('Escape');
  await page.mouse.click(1090, 690);
  await copy.waitFor({ state: 'hidden' });
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
  await save('00d-installer-acces');
  await page.getByRole('button', { name: 'Accepter' }).click();
  await widget().locator('.guide-steps').waitFor({ timeout: 30000 });
  await page.locator('.test-right-opener').click().catch(() => {});
}
// CAPTURES=1 : enregistre les captures du tutoriel (docs/images) au fil du parcours.
// Captures sans le bandeau du serveur de test ni l'erreur de la galerie de widgets (hors ligne).
const clean = () => page.addStyleTag({ content: '.dev_warning, .test-notifier-toast-wrapper { display: none !important; }' });
const shot = async name => { if (process.env.CAPTURES) { await clean(); await page.screenshot({ path: join(ROOT, 'docs/images', `${name}.png`) }); } };

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
  // Erreurs du widget seulement. La feuille de thème que grist-plugin-api.js insère en ligne est
  // bloquée exprès par la politique de sécurité du widget (style-src 'self') : attendu.
  if (!where.startsWith(`http://localhost:${WIDGET_PORT}`) && !where.endsWith('grist-plugin-api.js')) return;
  if (/Refused to apply inline style/.test(m.text())) return;
  errors.push(`${m.text()} (${where})`);
});
await page.goto(`${env.grist}/test/login?username=${env.email}&name=Test&next=${env.grist}/`);

const widget = () => page.frameLocator('iframe').first();
const button = name => widget().getByRole('button', { name, exact: true });
async function openWidget(url) {
  await page.goto(url);
  await widget().locator('.topbar').waitFor({ timeout: 30000 });
}

try {
  const dialog = () => widget().getByRole('dialog');
  const dialogButton = name => dialog().getByRole('button', { name, exact: true });
  const pick = async (field, option) => {
    // Nom accessible du bouton : « Champ : choix en cours ».
    await dialog().getByRole('button', { name: `${field} : ` }).click();
    await dialog().getByRole('option', { name: option, exact: true }).click();
  };
  const formKey = async (doc) => {
    const share = (await records(doc, '_grist_Shares'))[0];
    return execFileSync('docker', ['exec', env.container, 'python3', '-c',
      `import sqlite3;print(sqlite3.connect('/persist/home.sqlite3').execute("select key from shares where link_id=?",("${share.linkId}",)).fetchone()[0])`]).toString().trim();
  };
  const publishedForms = async doc => (await records(doc, '_grist_Views_section')).filter(sc => JSON.parse(sc.shareOptions || '{}').publish);

  // CIBLE : accepter une invitation (destinations par défaut), coller le lien du formulaire
  // publié, rendre la réponse.
  async function accept(doc, url, code) {
    await openWidget(url);
    await widget().locator('.tile', { hasText: 'Recevoir des tables' }).click();
    await button('Accepter une invitation').click();
    await dialog().locator('textarea.code').first().fill(code);
    await dialogButton('Continuer').click();
    await dialog().getByText('« Annuaire » : table Contacts.').waitFor();
    await dialogButton('Continuer').click();
    const forms = await waitFor(async () => { const f = await publishedForms(doc); return f.length === 1 && f; }, 'formulaire publié');
    await openWidget(url); // l'assistant se rouvre seul à l'étape Lien
    await dialog().getByLabel('Lien du formulaire').fill(`${TEAM}/forms/${await formKey(doc)}/${forms[0].id}`);
    await dialogButton('Tester le lien').click();
    await dialog().getByText('Le lien fonctionne').waitFor();
    const code2 = await dialog().locator('textarea.code').first().inputValue();
    await dialogButton('Fermer').click();
    return code2;
  }
  // SOURCE : coller la réponse sur la ligne de l'invitation, approuver, envoyer l'existant.
  async function approve(reply, shots = false) {
    await openWidget(source.url);
    await button('Coller la réponse').click();
    await dialog().locator('textarea.code').first().fill(reply);
    await dialogButton('Vérifier').click();
    await dialog().getByText(env.email).waitFor();
    if (shots) await shot('11-source-fiche');
    await dialogButton('Approuver et brancher').click();
    await dialog().getByText('Branché').waitFor();
    if (shots) await shot('12-source-envoi');
    await dialogButton('Envoyer').click();
    await dialog().getByText('Lignes existantes envoyées').waitFor();
    await dialogButton('Fermer').click();
    await dialog().waitFor({ state: 'detached' });
  }
  const rawRows = async (doc, journal) => (await records(doc, journal)).filter(r => r.Synchro_Type);

  if (process.env.CAPTURES) await installShots();
  if (process.env.INSTALL_ONLY) process.exit(0);
  // --- Accueil et Tutoriel
  await openWidget(source.url);
  await widget().locator('.guide-steps').waitFor();
  await shot('01-accueil');
  await widget().getByRole('tab', { name: 'Tutoriel' }).click();
  await widget().locator('.tuto-section').first().waitFor();
  await widget().getByRole('button', { name: 'Je suis la CIBLE' }).click();
  assert.ok(await widget().locator('#tuto-t-link').isVisible() && !(await widget().locator('#tuto-s-tables').isVisible()), 'filtre CIBLE');
  await widget().getByRole('button', { name: 'Tout', exact: true }).click();
  assert.ok(await widget().locator('.tuto-shot img').first().evaluate(img => img.decode().then(() => img.naturalWidth > 0)), 'captures chargées');
  await shot('16-tutoriel');

  // --- SOURCE : un export (Tables, Colonnes, Nom), puis son premier destinataire
  await openWidget(source.url);
  await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
  await button('Nouvel export').click();
  await dialog().getByRole('checkbox', { name: 'Contacts' }).check();
  await shot('02-source-tables');
  await dialogButton('Continuer').click();
  await dialog().getByText('Le widget ajoutera').waitFor();
  assert.equal(await dialog().getByRole('checkbox', { name: 'Supprime' }).count(), 0, 'Supprime n\'est pas une colonne envoyée');
  await dialog().getByRole('checkbox', { name: 'Interne' }).uncheck();
  await dialog().getByRole('checkbox', { name: 'Delta' }).uncheck();
  await shot('03-source-colonnes');
  assert.ok(!(await records(source.doc, '_grist_Tables')).some(tb => tb.tableId === 'Synchro'), 'rien d\'écrit avant la fin de l\'assistant');
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
  assert.match(await dialog().locator('.guide-steps li.current').innerText(), /CIBLE[\s\S]*Accepter une invitation/);
  await dialogButton('Copier avec les consignes').waitFor();
  await shot('05-source-invitation');
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
  await shot('08-cible-destinations');
  await dialogButton('Continuer').click();
  const formSections = await waitFor(async () => { const f = await publishedForms(target.doc); return f.length === 1 && f; }, 'formulaire publié');
  const widgetSection = (await records(target.doc, '_grist_Views_section')).find(sc => sc.parentKey === 'custom');
  assert.equal(formSections[0].parentId, widgetSection.parentId, 'formulaire sur la page du widget');
  await openWidget(target.url); // l'assistant se rouvre seul à l'étape Lien
  await dialog().getByLabel('Lien du formulaire').waitFor();
  await dialog().getByText(/il sert pour toutes les tables de l’export/).waitFor();
  await dialog().evaluate(d => d.querySelectorAll('*').forEach(e => { e.scrollTop = 0; }));
  await shot('09-cible-lien');
  if (process.env.CAPTURES) await helpShots();
  await dialog().getByLabel('Lien du formulaire').fill(`${TEAM}/forms/${await formKey(target.doc)}/${formSections[0].id}`);
  await dialogButton('Tester le lien').click();
  await dialog().getByText('Le lien fonctionne').waitFor();
  const reply = await dialog().locator('textarea.code').first().inputValue();
  await shot('10-cible-reponse');
  await dialogButton('Fermer').click();
  step('CIBLE : un journal pour l\'export, un formulaire, réponse produite');

  // --- SOURCE : approuver, envoyer l'existant ; un webhook sur Synchro, filtré sur l'export
  await approve(reply, true);
  await widget().getByText('Actif').first().waitFor();
  const hooks = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks;
  assert.deepEqual(hooks.map(h => h.fields.tableId), ['Synchro']);
  const triggers = (await api('POST', `/docs/${source.doc}/sql`, { sql: 'select condition from _grist_Triggers' })).records;
  assert.equal(JSON.parse(triggers[0].fields.condition).text, `rec.Synchro_Export == "${synchro[0].Synchro_Export}" and rec.Synchro_Type in ("cles", "lot")`);
  await waitFor(async () => (await records(target.doc, 'Journal_Annuaire')).length >= 2, 'liste et lot reçus dans le journal');
  step('SOURCE : un webhook filtré sur l\'export, lignes existantes envoyées');

  // --- CIBLE : dépliage et consolidation à l'ouverture
  await openWidget(target.url);
  const dest = await waitFor(async () => { const rows = await records(target.doc, 'Contacts'); return rows.length === 4 && rows; }, 'consolidation');
  assert.deepEqual(dest.map(r => `${r.Nom}:${r.Ville}:${r.Lieu}`).sort(), ['Alice:Lyon:Lyon', 'Bob:Paris:Paris', 'Chloé:Nantes:', 'Dora:Brest:']);
  await widget().getByText(`Données de ${env.email}`).waitFor();
  step('CIBLE : Contacts consolidée, propriétaire affiché');

  // --- Pages et tables : aucune page technique, une seule table technique côté SOURCE
  const pagesOf = async doc => (await api('POST', `/docs/${doc}/sql`, {
    sql: 'select p.indentation, v.name from _grist_Pages p join _grist_Views v on v.id = p.viewRef order by p.pagePos' })).records.map(r => r.fields);
  assert.deepEqual((await pagesOf(source.doc)).map(p => p.name), ['Table1', 'Contacts', 'Villes', 'Synchro'], 'SOURCE : aucune page technique');
  assert.deepEqual((await pagesOf(target.doc)).map(p => p.name).sort(), ['Communes', 'Contacts', 'Synchro', 'Table1'], 'CIBLE : aucune page technique');
  assert.deepEqual((await records(source.doc, '_grist_Tables')).map(tb => tb.tableId).sort(), ['Contacts', 'Synchro', 'Table1', 'Villes']);
  assert.deepEqual((await records(target.doc, '_grist_Tables')).map(tb => tb.tableId).sort(), ['Communes', 'Contacts', 'Journal_Annuaire', 'Table1']);
  const columnsOf = async (doc, table) => (await api('GET', `/docs/${doc}/tables/${table}/columns`)).columns.map(c => c.id).sort();
  assert.deepEqual(await columnsOf(target.doc, 'Contacts'), ['Lieu', 'Nom', 'Ville', 'id_sync']);
  const hiddenOf = async (doc, table) => (await api('GET', `/docs/${doc}/tables/${table}/columns?hidden=true`)).columns.map(c => c.id);
  assert.ok(!(await hiddenOf(source.doc, 'Synchro')).includes('manualSort'), 'Synchro sans manualSort (le webhook l\'enverrait)');
  await waitFor(async () => {
    const views = (await api('POST', `/docs/${target.doc}/sql`, { sql: "select layoutSpec from _grist_Views where name = 'Synchro'" })).records;
    return (JSON.parse(views[0].fields.layoutSpec || '{}').collapsed || []).length === 1;
  }, 'formulaire replié');
  step('SOURCE et CIBLE : tables techniques sans page, destination sans colonne technique, formulaire replié');

  // --- Ajout, modification, retouche manuelle, suppression logique, vraie suppression
  const bob = dest.find(r => r.Nom === 'Bob');
  await applyActions(target.doc, [['UpdateRecord', 'Contacts', bob.id, { Ville: 'retouche' }]]);
  const byName = name => contacts.find(r => r.Nom === name);
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
  await shot('14-cible-historique');
  await waitFor(async () => {
    const rows = await records(target.doc, 'Journal_Annuaire');
    return !rows.some(r => r.Synchro_Type) && rows.filter(r => r.id_sync).length === 5;
  }, 'journal déplié et nettoyé : une version par ligne');
  step('CIBLE : ajout, modification, suppression logique et vraie suppression appliqués seuls ; retouche préservée ; journal nettoyé');

  // --- Second destinataire du même export, sans secret, sans refaire l'export
  await openWidget(source.url);
  await button('Ajouter un destinataire').click();
  await dialog().getByRole('checkbox', { name: 'Protéger l’invitation par un secret' }).uncheck();
  await dialogButton('Créer l’invitation').click();
  await dialog().getByText('Transmettez ce code').waitFor();
  const invitation2 = await dialog().locator('textarea.code').first().inputValue();
  await dialogButton('Plus tard').click();
  const reply2 = await accept(target2.doc, target2.url, invitation2);
  await approve(reply2);
  await widget().locator('.person').nth(1).getByText('Actif').waitFor();
  await waitFor(async () => (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.every(h => !(h.usage || {}).numWaiting), 'file vide');
  await shot('13-source-actif');
  await openWidget(target2.url);
  await waitFor(async () => (await records(target2.doc, 'Contacts')).map(r => r.Nom).sort().join() === 'Alice,Bob,Denis', 'second destinataire servi');
  await openWidget(target.url);
  await waitFor(async () => !(await rawRows(target.doc, 'Journal_Annuaire')).length && !(await records(target.doc, 'Journal_Annuaire')).some(r => !r.Sync_Applique && r.id_sync), 'renvoi reçu par le premier');
  assert.equal((await records(target.doc, 'Contacts')).find(r => r.Nom === 'Bob').Ville, 'retouche', 'le renvoi ne défait pas la retouche');
  step('SOURCE : second destinataire ajouté et servi ; le premier ne voit rien changer');

  // --- Révoquer le second seulement : le premier continue
  await openWidget(source.url);
  await widget().locator('.person', { hasText: target2.doc.slice(0, 10) }).getByRole('button', { name: 'Révoquer' }).click();
  await dialogButton('Révoquer').click();
  await waitFor(async () => (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.length === 1, 'un webhook en moins');
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', byName('Alice').id, { Ville: 'Nancy' }]]);
  await openWidget(target.url);
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Ville === 'Nancy'), 'le premier reçoit toujours');
  await new Promise(r => setTimeout(r, 2000));
  assert.ok(!(await records(target2.doc, 'Journal_Annuaire')).some(r => (r.Synchro_Lot || r.Synchro_Donnees || '').includes('Nancy')), 'le second ne reçoit plus');
  step('SOURCE : une seule personne révoquée, l\'autre reçoit toujours');

  // --- Modifier l'export : une table et une colonne de plus ; la CIBLE range la table (fenêtre)
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
  assert.equal((await records(source.doc, 'Synchro')).length, 6, 'trois lignes Synchro par table');
  assert.ok(!(await columnsOf(source.doc, 'Villes')).includes('Supprime'), 'le widget n\'ajoute pas Supprime');
  await openWidget(target.url);
  await dialog().getByText('Table ajoutée à l’export : Villes').waitFor({ timeout: 30000 });
  await dialog().getByText(/envoie maintenant la table Villes \(2 lignes/).waitFor();
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
  await waitFor(async () => { const rows = await records(target.doc, 'Contacts'); return ['Alice:i1', 'Bob:i2'].every(x => rows.some(r => `${r.Nom}:${r.Interne}` === x)); }, 'colonne ajoutée reçue et remplie');
  await historyHas('Paris', 'ajout');
  assert.deepEqual(await widget().locator('.history-head strong').allTextContents(), ['Contacts', 'Communes'], 'historique groupé par table');
  await applyActions(source.doc, [['RemoveRecord', 'Villes', 2]]);
  await waitFor(async () => (await records(target.doc, 'Communes')).map(r => r.Commune).join() === 'Lyon', 'vraie suppression dans la table ajoutée');
  step('SOURCE puis CIBLE : table et colonne ajoutées à l\'export, rangées par la CIBLE dans une table existante');

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

  // --- Filtre de lignes : seule Alice part, les autres lignes sont effacées chez la CIBLE ; le
  // filtre retiré, elles reviennent
  const names = async () => (await records(target.doc, 'Contacts')).map(r => r.Nom).sort().join();
  const everyone = await names();
  const setFilter = async (column, value) => {
    await openWidget(source.url);
    await button('Modifier').click();
    await dialogButton('Continuer').click();
    await pick('Lignes de Contacts à envoyer', column);
    if (value) await dialog().getByRole('textbox', { name: 'Valeur des lignes de Contacts à envoyer' }).fill(value);
    await dialogButton('Continuer').click();
    await dialogButton('Enregistrer').click();
    await dialog().getByText(/^Enregistré/).waitFor();
    await dialogButton('Fermer').click();
    await openWidget(target.url);
  };
  await setFilter('Nom', 'alice');
  await waitFor(async () => (await names()) === 'Alice', 'seule la ligne du filtre reste');
  await setFilter('Toutes les lignes');
  await waitFor(async () => (await names()) === everyone, 'lignes revenues sans le filtre');
  step('SOURCE : filtre de lignes posé puis retiré, la CIBLE suit');

  // --- Document monté en version 0.4 : marque d'envoi coupé numérique, sans suivi des clés ni
  // dépendances de MajLe. Tout est posé à l'ouverture du widget SOURCE, et une suppression suit.
  const synchroRef = await tableRef(source.doc, 'Synchro');
  const tracks = (await records(source.doc, 'Synchro')).filter(r => r.Synchro_Type === 'suivi').map(r => r.id);
  const lotRef = (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'Synchro_Lot' && c.parentId === synchroRef).id;
  const syncIds = (await records(source.doc, 'Synchro')).map(r => r.id).filter(id => !tracks.includes(id));
  await applyActions(source.doc, [['BulkRemoveRecord', 'Synchro', tracks], ['ModifyColumn', 'Synchro', 'Sync_Etat', { type: 'Numeric' }],
    ['UpdateRecord', '_grist_Tables_column', majle.id, { recalcWhen: 2, recalcDeps: null }],
    ['AddColumn', 'Synchro', 'manualSort', { type: 'ManualSortPos', isFormula: false }], ['BulkUpdateRecord', 'Synchro', syncIds, { manualSort: syncIds }]]);
  const markRef = (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'Sync_Etat' && c.parentId === synchroRef).id;
  await applyActions(source.doc, [['UpdateRecord', '_grist_Tables_column', markRef, { recalcDeps: ['L', lotRef] }]]);
  await openWidget(source.url);
  await waitFor(async () => {
    const cols = await records(source.doc, '_grist_Tables_column');
    const mark = cols.find(c => c.id === markRef);
    const rows = await records(source.doc, 'Synchro');
    return cols.find(c => c.id === majle.id).recalcWhen === 0 && mark.type === 'Any' && (mark.recalcDeps || []).length === 3 &&
      rows.filter(r => r.Synchro_Type === 'suivi').length === rows.filter(r => r.Synchro_Type === 'cles').length &&
      !cols.some(c => c.colId === 'manualSort' && c.parentId === synchroRef);
  }, 'montage 0.4 mis à niveau');
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
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Nom === 'Yann'), 'ajout après la mise à niveau');
  await applyActions(source.doc, [['RemoveRecord', 'Contacts', (await records(source.doc, 'Contacts')).find(r => r.Nom === 'Yann').id]]);
  await waitFor(async () => !(await records(target.doc, 'Contacts')).some(r => r.Nom === 'Yann'), 'suppression après la mise à niveau');
  step('SOURCE : un montage 0.4 reçoit le suivi des clés, la marque d\'envoi coupé, les dépendances de MajLe et perd manualSort ; 70 envois page CIBLE fermée passent');

  // --- Gros import (4 000 lignes d'un coup) : le lot ne part qu'en partie, la CIBLE le signale ;
  // le widget SOURCE, une fois sa page ouverte, envoie le reste seul
  const before = (await records(target.doc, 'Contacts')).length;
  const big = Array.from({ length: 4000 }, (_, i) => `Import ${i} ${'x'.repeat(80)}`);
  const imported = (await applyActions(source.doc, [['BulkAddRecord', 'Contacts', big.map(() => null), { Nom: big }]])).retValues[0];
  const lotRow = async () => (await records(source.doc, 'Synchro')).find(r => r.Synchro_Table === 'Contacts' && r.Synchro_Type === 'lot');
  assert.ok((await lotRow()).Sync_Etat > 0, 'envoi coupé noté dans Synchro');
  await widget().getByText(/Contacts\s:\s[\d\s]+\slignes ne sont pas encore arrivées/).waitFor({ timeout: 60000 });
  await shot('19-cible-envoi-coupe');
  await openWidget(source.url);
  await widget().getByText('Un envoi n’est pas terminé').waitFor();
  await widget().getByText('Un envoi n’est pas terminé').waitFor({ state: 'detached', timeout: 240000 });
  assert.equal((await lotRow()).Sync_Etat, 0, 'marque effacée');
  await openWidget(target.url);
  await waitFor(async () => (await records(target.doc, 'Contacts')).length === before + big.length, 'gros import reçu en entier', 120000);
  await waitFor(async () => !(await widget().getByText('pas encore arrivées').count()), 'avis de la CIBLE retiré', 30000);
  await applyActions(source.doc, [['BulkRemoveRecord', 'Contacts', imported]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).length === before, 'gros import effacé', 120000);
  step('SOURCE : un import de 4 000 lignes part en entier, le widget SOURCE envoie seul ce qu\'un envoi n\'a pas porté');

  // --- File bloquée par un envoi trop gros : la CIBLE refuse un moment (colonne du journal
  // renommée), cinq gros lots attendent, Grist les regroupe en un envoi de plus de 1 Mo (413). Le
  // widget SOURCE vide la file et renvoie tout, seul.
  const bloc = Array.from({ length: 1500 }, (_, i) => `Bloc ${i} ${'y'.repeat(80)}`);
  const blocIds = (await applyActions(source.doc, [['BulkAddRecord', 'Contacts', bloc.map(() => null), { Nom: bloc }]])).retValues[0];
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
    return rows.filter(r => r.Interne === 'r5').length === bloc.length && rows.find(r => r.Nom === 'Bob').Ville === 'Brest';
  }, 'tout reçu après le déblocage', 240000);
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
  assert.ok(!(await records(target.doc, '_grist_Tables')).some(tb => tb.tableId === 'Synchro'), 'assistant fermé : rien d\'écrit');
  step('CIBLE : une table reçue peut être relayée (avis affiché), journaux exclus');

  // --- Lignes forgées avec le lien du formulaire : rejetées et signalées ; lien coupé, puis la
  // même réception reprend avec une nouvelle invitation
  const hookUrl = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks[0].fields.url;
  const exportId = (await records(source.doc, 'Synchro'))[0].Synchro_Export;
  const forge = rows => fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) });
  const pirate = JSON.stringify({ lignes: [['pirate', 9e9, false, { Nom: 'Pirate' }]], total: 1 });
  assert.ok((await forge([
    { Synchro_Export: 'ffffffffffffffff', Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Lot: pirate },
    { Synchro_Export: exportId, Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Lot: 'pas du JSON' },
    { Synchro_Export: exportId, Synchro_Table: 'Contacts', Synchro_Type: 'complet', Synchro_Lot: pirate },
  ])).ok, 'le lien du formulaire accepte n\'importe quelle ligne');
  await widget().getByRole('tab', { name: 'Recevoir' }).click();
  await widget().getByText('Arrivées suspectes').waitFor();
  await widget().getByText(/3\s+lignes rejetées/).waitFor();
  assert.ok(!(await records(target.doc, 'Contacts')).some(r => r.Nom === 'Pirate'), 'rien de recopié');
  assert.equal((await rawRows(target.doc, 'Journal_Annuaire')).length, 0, 'lignes rejetées effacées');
  await shot('17-cible-suspect');
  await button('Couper le lien').click();
  await dialogButton('Couper le lien').click();
  await widget().getByText('Lien coupé').waitFor();
  assert.ok(!(await forge([{ id_sync: '' }])).ok, 'l\'ancien lien n\'écrit plus');
  await openWidget(source.url);
  await button('Révoquer').click();
  await dialogButton('Révoquer').click();
  await waitFor(async () => !(await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.length, 'ancien destinataire révoqué');
  await button('Ajouter un destinataire').click();
  await dialogButton('Créer l’invitation').click();
  await dialog().getByText('Transmettez ce code').waitFor();
  const invitation3 = await dialog().locator('textarea.code').first().inputValue();
  await dialogButton('Plus tard').click();
  await openWidget(target.url);
  await widget().getByRole('tab', { name: 'Recevoir' }).click();
  await button('Accepter une invitation').click();
  await dialog().locator('textarea.code').first().fill(invitation3);
  await dialogButton('Continuer').click();
  await dialog().getByText('la même réception reprend').waitFor();
  const forms3 = await publishedForms(target.doc);
  assert.equal(forms3.length, 1, 'toujours un seul formulaire');
  await dialog().getByLabel('Lien du formulaire').fill(`${TEAM}/forms/${await formKey(target.doc)}/${forms3[0].id}`);
  await dialogButton('Tester le lien').click();
  await dialog().getByText('Le lien fonctionne').waitFor();
  const reply3 = await dialog().locator('textarea.code').first().inputValue();
  await dialogButton('Fermer').click();
  await approve(reply3);
  assert.equal((await records(target.doc, '_grist_Tables')).filter(tb => tb.tableId.startsWith('Journal_')).length, 1, 'même journal');
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', byName('Alice').id, { Ville: 'Brest' }]]);
  await openWidget(target.url);
  await waitFor(async () => (await records(target.doc, 'Contacts')).some(r => r.Ville === 'Brest'), 'la réception reprend');
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
  assert.ok(leaves.every(l => targetSections.some(sc => sc.id === Number(l.slice(7)) && sc.parentId === synchroPage.id)), 'disposition de la page nettoyée');
  assert.equal((await records(target.doc, 'Contacts')).length, 4, 'destination gardée');
  await openWidget(source.url);
  await button('Révoquer').click();
  await dialogButton('Révoquer').click();
  await widget().getByText('Personne ne reçoit encore cet export.').waitFor();
  await button('Supprimer').click();
  await dialogButton('Supprimer').click();
  await widget().getByText('Aucun export.', { exact: false }).waitFor();
  assert.deepEqual((await records(source.doc, '_grist_Tables')).map(tb => tb.tableId).sort(), ['Contacts', 'Table1', 'Villes'], 'table Synchro effacée');
  assert.equal((await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.length, 0);
  step('CIBLE puis SOURCE : réception arrêtée, révocation, export supprimé avec sa table technique');

  // --- Lien public : un seul code, la CIBLE lit les instantanés de l'export sans identifiant
  await button('Nouvel export').click();
  await dialog().getByRole('checkbox', { name: 'Contacts' }).check();
  await dialogButton('Continuer').click();
  await dialogButton('Continuer').click();
  await dialog().getByLabel('Nom de l’export').fill('Annuaire');
  await dialogButton('Créer l’export').click();
  await dialogButton('Ajouter un destinataire').click();
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
  await openWidget(source.url);
  await widget().getByText('Public', { exact: true }).waitFor();

  await openWidget(target.url);
  await widget().locator('.tile', { hasText: 'Recevoir des tables' }).click();
  await button('Accepter une invitation').click();
  await dialog().locator('textarea.code').first().fill(publicCode);
  await dialogButton('Continuer').click();
  await dialog().getByLabel('Nom de la nouvelle table pour Contacts').fill('Annuaire');
  await dialogButton('Continuer').click();
  await dialog().getByText('Branché').waitFor();
  await dialogButton('Fermer').click();
  const live = (await records(source.doc, 'Contacts')).filter(r => !r.Supprime).length;
  await waitFor(async () => (await records(target.doc, 'Annuaire')).length === live, 'lien public : lignes lues');
  await applyActions(source.doc, [['AddRecord', 'Contacts', null, { Nom: 'Émile', Interne: 'i5' }]]);
  await waitFor(async () => (await records(target.doc, 'Annuaire')).some(r => r.Nom === 'Émile'), 'lien public : ajout lu');
  step('Lien public : seul l\'instantané de l\'export est lisible, la CIBLE le recopie sans échange de réponse');

  await openWidget(source.url);
  await button('Couper le lien public').click();
  await dialogButton('Couper le lien public').click();
  await waitFor(async () => (await anon('Synchro')).status === 403, 'instantané fermé');
  await openWidget(source.url);
  await button('Supprimer').click();
  await dialogButton('Supprimer').click();
  await widget().getByText('Aucun export.', { exact: false }).waitFor();
  assert.equal((await anon('Contacts')).status, 403, 'reste du document toujours caché tant qu\'il est public');
  step('Lien public coupé, export supprimé : plus rien de lisible');

  // --- Montages d'avant la version 0.4 : signalés, effacés d'un clic
  const idSyncRef = (await records(source.doc, '_grist_Tables_column')).find(c => c.colId === 'id_sync' && c.parentId === contactsRefId).id;
  await applyActions(source.doc, [['AddTable', 'Synchro_Contacts', [{ id: 'Synchro_Ids', type: 'Text', isFormula: true, formula: '"ids:"' }]],
    ['CreateViewSection', contactsRefId, 0, 'record', [idSyncRef], null]]);
  assert.ok((await records(source.doc, '_grist_Tables')).some(tb => tb.tableId === 'Contacts_summary_id_sync'));
  await openWidget(source.url);
  await widget().getByText('Montage d’une version précédente').waitFor();
  await button('Effacer l’ancien montage').click();
  await dialogButton('Effacer l’ancien montage').click();
  await waitFor(async () => (await records(source.doc, '_grist_Tables')).map(tb => tb.tableId).sort().join() === 'Contacts,Table1,Villes', 'ancien montage effacé (SOURCE)');
  await applyActions(target.doc, [['AddTable', 'Journal_Contacts', [{ id: 'id_sync', type: 'Text' }, { id: 'Synchro_Ids', type: 'Text' }]]]);
  await openWidget(target.url);
  await widget().getByText('Réception d’une version précédente').waitFor();
  await button('Effacer les anciens journaux').click();
  await dialogButton('Effacer les anciens journaux').click();
  await waitFor(async () => !(await records(target.doc, '_grist_Tables')).some(tb => tb.tableId === 'Journal_Contacts'), 'ancien journal effacé (CIBLE)');
  step('Montages d\'avant la version 0.4 : signalés et effacés, côté SOURCE et côté CIBLE');

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
