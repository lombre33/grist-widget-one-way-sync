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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
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
// Colonnes affichées sur la page d'une table (ses vues en grille).
async function pageColumns(doc, tableId) {
  const table = (await records(doc, '_grist_Tables')).find(t => t.tableId === tableId);
  const sections = new Set((await records(doc, '_grist_Views_section')).filter(sc => sc.parentId === table.primaryViewId && sc.parentKey === 'record').map(sc => sc.id));
  const cols = new Map((await records(doc, '_grist_Tables_column')).map(c => [c.id, c.colId]));
  return [...new Set((await records(doc, '_grist_Views_section_field')).filter(f => sections.has(f.parentId)).map(f => cols.get(f.colRef)))];
}

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
  await pad(banner, 'aide-partager.png');
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
  await save('00d-installer-acces');
  await page.getByRole('button', { name: 'Accepter' }).click();
  await widget().locator('.guide-steps').waitFor({ timeout: 30000 });
  await page.locator('.test-right-opener').click().catch(() => {});
}
// CAPTURES=1 : enregistre les captures du tutoriel (docs/images) au fil du parcours.
// Captures sans le bandeau du serveur de test ni l'erreur de la galerie de widgets (hors ligne).
const clean = () => page.addStyleTag({ content: '.dev_warning, .test-notifier-toast-wrapper { display: none !important; }' });
// Avec `part`, la même capture recadrée sur la fenêtre ouverte (`modal`, sans le voile derrière)
// ou sur la première carte (`card`), pour le README (docs/images/readme) : lisible en vignette.
const shot = async (name, part) => {
  if (!process.env.CAPTURES) return;
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
  const pageOf = async (doc, viewRef) => (await records(doc, '_grist_Pages')).find(p => p.viewRef === viewRef);
  // Clé de la page d'un formulaire (une par page partagée), lue dans la base du serveur de test ;
  // Grist l'enregistre juste après le partage.
  const formKey = async (doc, form) => {
    const { shareRef } = await pageOf(doc, form.parentId);
    const share = (await records(doc, '_grist_Shares')).find(sh => sh.id === shareRef);
    return waitFor(() => {
      try {
        return execFileSync('docker', ['exec', env.container, 'python3', '-c',
          `import sqlite3;print(sqlite3.connect('/persist/home.sqlite3').execute("select key from shares where link_id=?",("${share.linkId}",)).fetchone()[0])`]).toString().trim();
      } catch (e) {
        return null;
      }
    }, 'clé du formulaire enregistrée', 10000);
  };
  const formLink = async (doc, form) => `${TEAM}/forms/${await formKey(doc, form)}/${form.id}`;
  const publishedForms = async doc => (await records(doc, '_grist_Views_section')).filter(sc => JSON.parse(sc.shareOptions || '{}').publish);
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

  // SOURCE : un export d'une table, toutes ses colonnes.
  async function newExport(table, name) {
    await button('Nouvel export').click();
    await dialog().getByRole('checkbox', { name: table }).check();
    await dialogButton('Continuer').click();
    await dialogButton('Continuer').click();
    await dialog().getByLabel('Nom de l’export').fill(name);
    await dialogButton('Créer l’export').click();
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

  // CIBLE : accepter une invitation (destinations par défaut), coller le lien du formulaire
  // publié, rendre la réponse.
  async function accept(doc, url, code, tables = '« Annuaire » : table Contacts.') {
    await openWidget(url);
    await widget().locator('.tile', { hasText: 'Recevoir des tables' }).click();
    await button('Accepter une invitation').click();
    await dialog().locator('textarea.code').first().fill(code);
    await dialogButton('Continuer').click();
    await dialog().getByText(tables).waitFor();
    await dialogButton('Continuer').click();
    const forms = await waitFor(async () => { const f = await publishedForms(doc); return f.length === 1 && f; }, 'formulaire publié');
    await openWidget(url); // l'assistant se rouvre seul à l'étape Lien
    const code2 = await testLink('Lien du formulaire', await formLink(doc, forms[0]), 'Le lien fonctionne');
    await dialogButton('Fermer').click();
    return code2;
  }
  // SOURCE : coller la réponse sur la ligne de l'invitation, approuver, envoyer l'existant.
  async function approve(reply, { shots = false, url = source.url } = {}) {
    await openWidget(url);
    await button('Coller la réponse').click();
    await dialog().locator('textarea.code').first().fill(reply);
    await dialogButton('Vérifier').click();
    await dialog().getByText(env.email).waitFor();
    if (shots) await shot('11-source-fiche', 'modal');
    await dialogButton('Approuver et brancher').click();
    await dialog().getByText('Branché').waitFor();
    if (shots) await shot('12-source-envoi');
    await dialogButton('Envoyer').click();
    await dialog().getByText('Lignes existantes envoyées').waitFor();
    await dialogButton('Fermer').click();
    await dialog().waitFor({ state: 'detached' });
  }
  const rawRows = async (doc, journal) => (await records(doc, journal)).filter(r => r.Synchro_Type);

  // --- Échange : deux documents se tiennent à jour l'un l'autre. A invite (formulaire de retour
  // publié chez A, son lien dans le code), B accepte et répond, A approuve. Une modification va
  // d'un côté à l'autre sans revenir (pas d'écho) ; la plus récente l'emporte ; la case Supprime
  // efface des deux côtés.
  async function exchangeSteps() {
    const a = await newDocWithWidget('Échange A', [
      ['AddTable', 'Fiches', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }]],
      ['BulkAddRecord', 'Fiches', [null, null, null], { Nom: ['Anna', 'Basile', 'Céline'], Ville: ['Lyon', 'Paris', 'Nantes'] }],
    ]);
    const b = await newDocWithWidget('Échange B');
    await openWidget(a.url);
    await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await newExport('Fiches', 'Partage');
    await dialogButton('Ajouter un destinataire').click();
    await dialog().getByRole('radio', { name: /Échange/ }).check();
    await dialog().getByText('la plus récente l’emporte', { exact: false }).first().waitFor();
    await shot('20-echange-mode', 'modal');
    await dialogButton('Créer l’invitation').click();
    const back = await waitFor(async () => { const f = await publishedForms(a.doc); return f.length === 1 && f; }, 'formulaire de retour publié');
    await openWidget(a.url); // l'assistant reprend à l'étape du lien de retour
    const code = await testLink('Lien du formulaire de retour', await formLink(a.doc, back[0]), 'Transmettez ce code');
    await dialogButton('Plus tard').click();
    assert.ok(!JSON.stringify(await api('POST', `/docs/${a.doc}/sql`, { sql: 'select description from _grist_Tables_column' })).includes('/api/s/'),
      'adresse de retour notée nulle part chez A');
    const answer = await accept(b.doc, b.url, code, '« Partage » : table Fiches.');
    const bHooks = (await api('GET', `/docs/${b.doc}/webhooks`)).webhooks;
    assert.equal(bHooks.length, 1, 'B renvoie vers A par un webhook');
    await approve(answer, { url: a.url });
    const fiches = async doc => Object.fromEntries((await records(doc, 'Fiches')).map(r => [r.Nom, r]));
    const aRows = await fiches(a.doc);
    assert.ok(Object.values(aRows).every(r => r.Supprime === false), 'A : case Supprime ajoutée');
    await openWidget(b.url);
    const bRows = await waitFor(async () => { const r = await fiches(b.doc); return Object.keys(r).length === 3 && r; }, 'B reçoit les fiches de A');
    assert.deepEqual(Object.values(bRows).map(r => `${r.Nom}:${r.Ville}:${r.id_sync === aRows[r.Nom].id_sync}`).sort(), ['Anna:Lyon:true', 'Basile:Paris:true', 'Céline:Nantes:true']);
    assert.ok(['MajLe', 'RecalculLe', 'Supprime'].every(c => c in bRows.Anna), 'B : colonnes de l\'envoi de retour');
    await widget().getByText('Échange : vos modifications de ces tables repartent vers ce document.').waitFor();
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
    await new Promise(r => setTimeout(r, 3000));
    assert.ok(!(await sentLines(b.doc, bJournal)).some(l => ['Brest', 'Metz'].includes(l[3].Ville)), 'pas d\'écho vers B');

    // A modifie : B reçoit.
    await applyActions(a.doc, [['UpdateRecord', 'Fiches', aRows.Anna.id, { Ville: 'Lille' }]]);
    await openWidget(b.url);
    await waitFor(async () => (await fiches(b.doc)).Anna.Ville === 'Lille', 'B reçoit la modification de A');

    // Les deux modifient Céline, B d'abord : la version de A, plus récente, l'emporte des deux côtés.
    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bRows.Céline.id, { Ville: 'Rennes' }]]);
    await waitFor(async () => (await sentLines(a.doc, aJournal)).some(l => l[3].Ville === 'Rennes'), 'version de B arrivée chez A');
    await applyActions(a.doc, [['UpdateRecord', 'Fiches', aRows.Céline.id, { Ville: 'Dijon' }]]);
    await openWidget(a.url);
    await waitFor(async () => !(await sentLines(a.doc, aJournal)).length, 'A a lu la version de B');
    assert.equal((await fiches(a.doc)).Céline.Ville, 'Dijon', 'A garde sa version, plus récente');
    await openWidget(b.url);
    await waitFor(async () => (await fiches(b.doc)).Céline.Ville === 'Dijon', 'B prend la version de A, plus récente');

    // B coche Supprime : la ligne disparaît chez A, reste cochée chez B.
    await applyActions(b.doc, [['UpdateRecord', 'Fiches', bRows.Anna.id, { Supprime: true }]]);
    await openWidget(a.url);
    await waitFor(async () => !(await fiches(a.doc)).Anna, 'Supprime cochée chez B : ligne effacée chez A');
    assert.equal((await fiches(b.doc)).Anna.Supprime, true);
    step('Échange : modifications dans les deux sens, sans écho, la plus récente l\'emporte, Supprime efface des deux côtés');
  }
  if (process.env.ONLY_EXCHANGE) {
    await exchangeSteps();
    assert.deepEqual(errors, [], 'aucune erreur dans la console');
    process.exit(0);
  }

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
  await shot('03-source-colonnes', 'modal');
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
  await shot('08-cible-destinations', 'modal');
  const widgetFrame = page.frames().find(f => f.url().startsWith(WIDGET_URL));
  await widgetFrame.evaluate(() => { window.sameFrame = true; });
  await dialogButton('Continuer').click();
  await dialog().getByLabel('Lien du formulaire').waitFor();
  assert.ok(await widgetFrame.evaluate(() => window.sameFrame), 'formulaire publié sans recharger le widget');
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
  step('SOURCE : un webhook filtré sur l\'export, lignes existantes envoyées');

  // --- Une autre page renvoie déjà (signe de vie récent) : « Tout renvoyer » ne lance rien et
  // note le lot ; la main rendue, le rattrapage l'envoie seul
  const chargeRow = (await records(source.doc, 'Synchro')).find(r => r.Synchro_Type === 'charge');
  const holdCharge = par => applyActions(source.doc, [['UpdateRecord', 'Synchro', chargeRow.id, { Synchro_Renvoi: JSON.stringify({ ...charge, par, le: Date.now() / 1000 }) }]]);
  await holdCharge('autre');
  await openWidget(source.url);
  await widget().getByText('Un renvoi est en cours depuis une autre page').waitFor();
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
  await viewerWidget.getByText('Lecture seule : un éditeur doit ouvrir cette page').waitFor({ timeout: 30000 });
  assert.ok(await viewerWidget.getByRole('button', { name: 'Accepter une invitation' }).isDisabled(), 'lecteur : boutons grisés');
  await viewerContext.close();
  step('CIBLE : un lecteur voit les boutons grisés d\'emblée');

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
  await shot('13-source-actif', 'card');
  await openWidget(target2.url);
  await waitFor(async () => (await records(target2.doc, 'Contacts')).map(r => r.Nom).sort().join() === 'Alice,Bob,Denis', 'second destinataire servi');
  await openWidget(target.url);
  await waitFor(async () => !(await rawRows(target.doc, 'Journal_Annuaire')).length && !(await records(target.doc, 'Journal_Annuaire')).some(r => !r.Sync_Applique && r.id_sync), 'renvoi reçu par le premier');
  assert.equal((await records(target.doc, 'Contacts')).find(r => r.Nom === 'Bob').Ville, 'retouche', 'le renvoi ne défait pas la retouche');
  step('SOURCE : second destinataire ajouté et servi ; le premier ne voit rien changer');

  // --- Révoquer le second seulement : le premier continue
  await openWidget(source.url);
  await revoke(widget().locator('.person', { hasText: target2.doc.slice(0, 10) }));
  await waitFor(async () => (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.length === 1, 'un webhook en moins');
  await moveAlice('Nancy', 'le premier reçoit toujours');
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
  assert.equal((await records(source.doc, 'Synchro')).filter(r => r.Synchro_Type !== 'charge').length, 6, 'trois lignes Synchro par table');
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
  const shown = await pageColumns(target.doc, 'Contacts');
  assert.ok(shown.includes('Interne') && !shown.includes('id_sync'), `colonne ajoutée visible sur la page, clé masquée : ${shown}`);
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
    return cols.find(c => c.id === majle.id).recalcWhen === 0 && mark.type === 'Any' && (mark.recalcDeps || []).length === 4 &&
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
  const imported = await addContacts('Import', 4000, 'x');
  const lotRow = async () => (await records(source.doc, 'Synchro')).find(r => r.Synchro_Table === 'Contacts' && r.Synchro_Type === 'lot');
  assert.ok((await lotRow()).Sync_Etat > 0, 'envoi coupé noté dans Synchro');
  await widget().getByText(/Contacts\s:\s[\d\s]+\slignes ne sont pas encore arrivées/).waitFor({ timeout: 60000 });
  await shot('19-cible-envoi-coupe');
  await openWidget(source.url);
  await widget().getByText('Un envoi n’est pas terminé').waitFor();
  await widget().getByText('Un envoi n’est pas terminé').waitFor({ state: 'detached', timeout: 240000 });
  assert.equal((await lotRow()).Sync_Etat, 0, 'marque effacée');
  await openWidget(target.url);
  await waitFor(async () => (await records(target.doc, 'Contacts')).length === before + imported.length, 'gros import reçu en entier', 120000);
  await waitFor(async () => !(await widget().getByText('pas encore arrivées').count()), 'avis de la CIBLE retiré', 30000);
  await applyActions(source.doc, [['BulkRemoveRecord', 'Contacts', imported]]);
  await waitFor(async () => (await records(target.doc, 'Contacts')).length === before, 'gros import effacé', 120000);
  step('SOURCE : un import de 4 000 lignes part en entier, le widget SOURCE envoie seul ce qu\'un envoi n\'a pas porté');

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
  // même réception reprend avec une nouvelle invitation. Le formulaire partage d'abord sa page avec
  // un autre (montage d'avant la 0.5) : le lien commun est signalé, et la coupure le sépare.
  const hookUrl = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks[0].fields.url;
  const journalForm = (await publishedForms(target.doc))[0];
  const neighbour = (await applyActions(target.doc, [['CreateViewSection', await tableRef(target.doc, 'Communes'), journalForm.parentId, 'form', null, null]])).retValues[0];
  await applyActions(target.doc, [['UpdateRecord', '_grist_Views_section', neighbour.sectionRef, { shareOptions: '{"form": true, "publish": true}' }]]);
  const exportId = (await records(source.doc, 'Synchro'))[0].Synchro_Export;
  const forge = rows => fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) });
  const pirate = JSON.stringify({ lignes: [['pirate', 9e9, false, { Nom: 'Pirate' }]], total: 1 });
  assert.ok((await forge([
    { Synchro_Export: 'ffffffffffffffff', Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Lot: pirate },
    { Synchro_Export: exportId, Synchro_Table: 'Contacts', Synchro_Type: 'lot', Synchro_Lot: 'pas du JSON' },
    { Synchro_Export: exportId, Synchro_Table: 'Contacts', Synchro_Type: 'complet', Synchro_Lot: pirate },
  ])).ok, 'le lien du formulaire accepte n\'importe quelle ligne');
  await widget().getByRole('tab', { name: 'Recevoir' }).click();
  // Rien n'est arrivé depuis plus d'une minute : le passage suivant viendrait dans une minute.
  await widget().getByRole('button', { name: 'Synchroniser', exact: true }).click();
  await widget().getByText('Arrivées suspectes').waitFor();
  await widget().getByText(/3\s+lignes rejetées/).waitFor();
  await widget().getByText('Lien commun à d’autres formulaires').waitFor();
  assert.ok(!(await records(target.doc, 'Contacts')).some(r => r.Nom === 'Pirate'), 'rien de recopié');
  assert.equal((await rawRows(target.doc, 'Journal_Annuaire')).length, 0, 'lignes rejetées effacées');
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
  const invitation3 = await dialog().locator('textarea.code').first().inputValue();
  await dialogButton('Plus tard').click();
  await openWidget(target.url);
  await widget().getByRole('tab', { name: 'Recevoir' }).click();
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
  await dialogButton('Fermer').click();
  await approve(reply3);
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
  await widget().getByText('Aucun export.', { exact: false }).waitFor();
  assert.deepEqual((await records(source.doc, '_grist_Tables')).map(tb => tb.tableId).sort(), ['Contacts', 'Table1', 'Villes'], 'table Synchro effacée');
  assert.equal((await api('GET', `/docs/${source.doc}/webhooks`)).webhooks.length, 0);
  step('CIBLE puis SOURCE : réception arrêtée, révocation, export supprimé avec sa table technique');

  // --- Lien public : un seul code, la CIBLE lit les instantanés de l'export sans identifiant
  await newExport('Contacts', 'Annuaire');
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
  // La note (exports, invitations) est la description de Synchro_Export ; les formules des autres
  // colonnes citent ce nom, lisible, lui.
  const anonColumns = (await (await fetch(`${TEAM}/api/docs/${source.doc}/tables/Synchro/columns`)).json()).columns;
  assert.ok(anonColumns.some(c => c.id === 'Synchro_Lot') && !anonColumns.some(c => c.id === 'Synchro_Export'), 'colonne de la note cachée au lien public');
  assert.ok(!anonColumns.some(c => /invitations|exports/.test(c.fields.description || '')), 'note de la SOURCE cachée au lien public');
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
  step('Lien public : seul l\'instantané de l\'export est lisible (sans la note de la SOURCE), la CIBLE le recopie sans échange de réponse');

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

  await exchangeSteps();

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
