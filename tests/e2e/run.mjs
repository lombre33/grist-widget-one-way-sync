// Test d'intégration : le parcours complet, dans un vrai Grist (tests/e2e/start-grist.sh) et un
// vrai navigateur (Playwright). Deux documents, le widget installé dans chacun :
//   SOURCE : préparer deux tables, inviter (avec secret) ;  CIBLE : accepter, coller le lien,
//   répondre ;  SOURCE : approuver, envoyer l'existant ;  CIBLE : consolider ; puis ajout,
//   modification, suppression logique et vraie suppression côté SOURCE, vérifiées dans la CIBLE.
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
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
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
// CAPTURES=1 : enregistre les captures du tutoriel (docs/images) au fil du parcours.
const shot = async name => { if (process.env.CAPTURES) await page.screenshot({ path: join(ROOT, 'docs/images', `${name}.png`) }); };

// --- Documents
const source = await newDocWithWidget('Source', [
  ['AddTable', 'Contacts', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }]],
  ['BulkAddRecord', 'Contacts', [null, null, null], { Nom: ['Alice', 'Bob', 'Chloé'], Ville: ['Lyon', 'Paris', 'Nantes'] }],
  ['AddTable', 'Villes', [{ id: 'Ville', type: 'Text' }]],
  ['BulkAddRecord', 'Villes', [null, null], { Ville: ['Lyon', 'Paris'] }],
]);
// La CIBLE a déjà un référentiel « Communes » (colonne Commune, une ligne Lyon annotée), choisi
// comme destination de Villes : Ville va dans Commune, et Lyon est rattachée au lieu d'être doublée.
const target = await newDocWithWidget('Cible', [
  ['AddTable', 'Communes', [{ id: 'Commune', type: 'Text' }, { id: 'Note', type: 'Text' }]],
  ['AddRecord', 'Communes', null, { Commune: 'Lyon', Note: 'déjà là' }],
]);
step('documents SOURCE et CIBLE créés');

const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1100, height: 700 } });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => {
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

  // --- SOURCE : assistant d'envoi, étapes Tables, Préparation, Options, Invitation
  await openWidget(source.url);
  await shot('01-accueil');
  await widget().locator('.tile', { hasText: 'Envoyer une table' }).click();
  await button('Nouveau destinataire').click();
  await dialog().getByRole('checkbox', { name: 'Contacts' }).check();
  await dialog().getByRole('checkbox', { name: 'Villes' }).check();
  await shot('02-source-tables');
  await dialogButton('Continuer').click();
  await dialog().getByText('Le widget doit ajouter').waitFor();
  await shot('03-source-preparation');
  await dialogButton('Préparer pour la synchro').click();
  await dialog().getByText('Prêt à envoyer : 2 tables').waitFor();
  await shot('04-source-options');
  const contacts = await records(source.doc, 'Contacts');
  assert.ok(contacts.every(r => /^[0-9a-f-]{36}$/.test(r.id_sync)), 'id_sync rempli pour les lignes existantes');
  assert.ok((await records(source.doc, 'Synchro_Contacts'))[0].Synchro_Ids.startsWith('ids:'));
  await dialogButton('Créer l’invitation').click();
  const invitation = await dialog().locator('textarea.code').inputValue();
  assert.ok(invitation.startsWith('GRISTSYNC1.'));
  await shot('05-source-invitation');
  await dialogButton('Plus tard').click();
  await widget().getByText('En attente de réponse').waitFor();
  await shot('06-source-attente');
  step('SOURCE : deux tables préparées, invitation créée');

  // --- CIBLE : assistant de réception, étapes Code, Destinations, Lien, Réponse
  await openWidget(target.url);
  await widget().locator('.tile', { hasText: 'Recevoir une table' }).click();
  await button('Accepter une invitation').click();
  await dialog().locator('textarea.code').fill(invitation);
  await shot('07-cible-code');
  await dialogButton('Continuer').click();
  await dialog().getByText('« Contacts + Villes » : tables Contacts, Villes').waitFor();
  await dialog().getByText(`Données de ${env.email}`).waitFor();
  const pick = async (field, option) => {
    await dialog().getByRole('button', { name: field, exact: true }).click();
    await dialog().getByRole('option', { name: option, exact: true }).click();
  };
  await pick('Villes', 'Communes');
  await shot('08-cible-destinations');
  await dialogButton('Continuer').click();
  await pick('Ville', 'Commune');
  await pick('Rattacher les lignes déjà là par la colonne', 'Commune');
  await shot('08b-cible-colonnes');
  await dialogButton('Créer les tables').click();
  // Les deux formulaires sont publiés sur la page du widget (le cadre est recréé à chaque ajout).
  const formSections = await waitFor(async () => {
    const sections = (await records(target.doc, '_grist_Views_section')).filter(sc => JSON.parse(sc.shareOptions || '{}').publish);
    return sections.length === 2 && sections;
  }, 'deux formulaires publiés');
  const widgetSection = (await records(target.doc, '_grist_Views_section')).find(sc => sc.parentKey === 'custom');
  assert.ok(formSections.every(sc => sc.parentId === widgetSection.parentId), 'formulaires sur la page du widget');
  const share = (await records(target.doc, '_grist_Shares'))[0];
  const key = execFileSync('docker', ['exec', env.container, 'python3', '-c',
    `import sqlite3;print(sqlite3.connect('/persist/home.sqlite3').execute("select key from shares where link_id=?",("${share.linkId}",)).fetchone()[0])`]).toString().trim();
  await openWidget(target.url); // l'assistant se rouvre seul à l'étape Lien
  await dialog().getByLabel('Lien du formulaire').waitFor();
  await shot('09-cible-lien');
  if (process.env.CAPTURES) await helpShots();
  await dialog().getByLabel('Lien du formulaire').fill(`${TEAM}/forms/${key}/${formSections[0].id}`);
  await dialogButton('Tester le lien').click();
  await dialog().getByText('Le lien fonctionne').waitFor();
  const reply = await dialog().locator('textarea.code').inputValue();
  await shot('10-cible-reponse');
  await dialogButton('Fermer').click();
  step('CIBLE : tables créées (dont une existante), formulaires publiés, un lien pour les deux, réponse produite');

  // --- SOURCE : la carte de l'invitation rouvre l'assistant à l'étape Réponse, puis Envoi
  await openWidget(source.url);
  await button('Coller la réponse').click();
  await dialog().locator('textarea.code').fill(reply);
  await dialogButton('Vérifier').click();
  await dialog().getByText(env.email).waitFor();
  await shot('11-source-fiche');
  await dialogButton('Approuver et brancher').click();
  await dialog().getByText('Branché').waitFor();
  await shot('12-source-envoi');
  await dialogButton('Envoyer').click();
  await dialog().getByText('Lignes existantes envoyées').waitFor();
  await dialogButton('Fermer').click();
  await widget().getByText('Actif').first().waitFor();
  await shot('13-source-actif');
  const hooks = (await api('GET', `/docs/${source.doc}/webhooks`)).webhooks;
  assert.deepEqual(hooks.map(h => h.fields.tableId).sort(), ['Contacts', 'Synchro_Contacts', 'Synchro_Villes', 'Villes']);
  await waitFor(async () => (await records(target.doc, 'Journal_Contacts')).length >= 3, 'lignes reçues dans le journal');
  step('SOURCE : quatre webhooks créés, lignes existantes envoyées');

  // --- CIBLE : consolidation à l'ouverture
  await openWidget(target.url);
  const dest = await waitFor(async () => { const rows = await records(target.doc, 'Contacts'); return rows.length === 3 && rows; }, 'consolidation');
  assert.deepEqual(dest.map(r => r.Nom).sort(), ['Alice', 'Bob', 'Chloé']);
  const communes = await waitFor(async () => { const rows = await records(target.doc, 'Communes'); return rows.length === 2 && rows.every(r => r.id_sync) && rows; }, 'seconde table consolidée');
  assert.deepEqual(communes.map(r => `${r.Commune}:${r.Note}`).sort(), ['Lyon:déjà là', 'Paris:'], 'Lyon rattachée, pas doublée');
  await widget().getByText(`Données de ${env.email}`).waitFor();
  step('CIBLE : Contacts et Communes consolidées, propriétaire affiché');

  // --- Tables techniques rangées sous la page du widget, destination propre
  const tucked = async (doc) => {
    const list = (await api('POST', `/docs/${doc}/sql`, { sql: 'select p.indentation, p.options, v.name from _grist_Pages p join _grist_Views v on v.id = p.viewRef order by p.pagePos' })).records.map(r => r.fields);
    const at = list.findIndex(p => p.indentation === 0 && JSON.parse(p.options || '{}').collapsed);
    assert.ok(at >= 0, 'page du widget repliée');
    return list.slice(at + 1).filter(p => p.indentation === 1).map(p => p.name).sort();
  };
  assert.deepEqual(await tucked(source.doc), ['Synchro_Contacts', 'Synchro_Villes']);
  assert.deepEqual(await tucked(target.doc), ['Journal_Communes', 'Journal_Contacts']);
  const tables = (await records(target.doc, '_grist_Tables')).map(tb => tb.tableId).filter(id => !id.startsWith('Table'));
  assert.deepEqual(tables.sort(), ['Communes', 'Contacts', 'Journal_Communes', 'Journal_Contacts']);
  const columnsOf = async table => (await api('GET', `/docs/${target.doc}/tables/${table}/columns`)).columns.map(c => c.id).sort();
  assert.deepEqual(await columnsOf('Contacts'), ['Nom', 'Ville', 'id_sync']);
  assert.deepEqual(await columnsOf('Communes'), ['Commune', 'Note', 'id_sync'], 'table existante complétée de la seule clé');
  const layout = await waitFor(async () => {
    const views = (await api('POST', `/docs/${target.doc}/sql`, { sql: "select layoutSpec from _grist_Views where name = 'Synchro'" })).records;
    const spec = JSON.parse(views[0].fields.layoutSpec || '{}');
    return (spec.collapsed || []).length === 2 && spec;
  }, 'formulaires repliés');
  step('SOURCE et CIBLE : une table technique par table, rangée ; destination sans colonne technique ; formulaires repliés');

  // --- Ajout, modification, retouche manuelle, suppression logique, vraie suppression
  const bob = dest.find(r => r.Nom === 'Bob');
  await applyActions(target.doc, [['UpdateRecord', 'Contacts', bob.id, { Ville: 'retouche' }]]);
  const alice = contacts.find(r => r.Nom === 'Alice');
  const chloe = contacts.find(r => r.Nom === 'Chloé');
  await applyActions(source.doc, [['UpdateRecord', 'Contacts', alice.id, { Ville: 'Marseille' }], ['UpdateRecord', 'Contacts', chloe.id, { Supprime: true }], ['AddRecord', 'Contacts', null, { Nom: 'Denis' }]]);
  await applyActions(source.doc, [['RemoveRecord', 'Villes', 2]]);
  const after = await waitFor(async () => {
    const rows = await records(target.doc, 'Contacts');
    return rows.some(r => r.Nom === 'Denis') && !rows.some(r => r.Nom === 'Chloé') && rows.some(r => r.Ville === 'Marseille') && rows;
  }, 'ajout, modification et suppression consolidés sans clic');
  assert.equal(after.length, 3);
  assert.equal(after.find(r => r.Nom === 'Bob').Ville, 'retouche', 'retouche manuelle préservée');
  await waitFor(async () => (await records(target.doc, 'Communes')).map(r => r.Commune).join() === 'Lyon', 'vraie suppression consolidée');
  const historyHas = text => waitFor(async () => (await widget().locator('.history li').allTextContents()).some(li => li.includes(text)), `historique : ${text}`);
  await historyHas('Denis · ajoutée');
  await historyHas('Alice · modifiée');
  await historyHas('Chloé · supprimée');
  await historyHas('Paris · supprimée');
  await widget().locator('.history summary').first().click();
  await shot('14-cible-historique');
  step('CIBLE : ajout, modification, suppression logique et vraie suppression appliqués seuls ; retouche préservée');

  // --- Journal nettoyé à chaque passage : une version par ligne et la dernière liste
  await waitFor(async () => (await records(target.doc, 'Journal_Contacts')).filter(r => r.id_sync).length === 4, 'journal nettoyé');
  step('CIBLE : journal nettoyé');

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
