// Non-régression de la montée de version : des partages ACTIFS, montés avec l'Alpha publiée (V0.5.9, extraite de git),
// passent sur la Bêta (le code d'ici), dans un vrai Grist et un vrai navigateur. Ce qui est vérifié :
//  - les envois continuent à chaque étape, rien n'est perdu ni doublé (la CIBLE reflète la SOURCE, clé par clé) ;
//  - les webhooks, leurs conditions et leurs files restent ceux d'avant (rien n'est recréé, rien ne bloque) ;
//  - chaque combinaison de versions marche : CIBLE montée seule, SOURCE montée seule, puis les deux ;
//  - les écrans de la Bêta s'ouvrent sur ces partages sans erreur, et proposent « Renforcer la sécurité » sans l'imposer ;
//  - l'Échange et le lien public d'avant continuent aussi.
// Le widget est servi par deux serveurs (l'Alpha sur ALPHA_PORT, la Bêta sur BETA_PORT) : monter un document, c'est changer
// l'adresse du widget dans sa page, ce que fait une publication de la Bêta à l'adresse de l'Alpha, document par document
// (un document que personne n'ouvre garde ses webhooks et formules d'avant).
// Usage : tests/e2e/start-grist.sh puis `node tests/e2e/upgrade.mjs` ; ENV_FILE=.env-upg.json pour un autre Grist ;
// ALPHA_COMMIT=<commit> pour une autre Alpha ; SHOTS=<dossier> pour des captures de chaque écran de la Bêta.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { ROOT, docTools, gestures, gristApi, pickTab, serveWidget } from './shared.mjs';

const env = JSON.parse(await readFile(join(ROOT, 'tests/e2e', process.env.ENV_FILE || '.env.json'), 'utf8'));
const ALPHA_COMMIT = process.env.ALPHA_COMMIT || '7646875'; // V0.5.9, l'Alpha publiée (tag v0.5.9 de grist-factory)
const ALPHA_PORT = Number(process.env.ALPHA_PORT) || 8685;
const BETA_PORT = Number(process.env.BETA_PORT) || 8686;
const ALPHA_URL = `http://localhost:${ALPHA_PORT}/index.html`;
const BETA_URL = `http://localhost:${BETA_PORT}/index.html`;
const TEAM = `${env.grist}/o/${env.team}`;

// L'Alpha, extraite du dépôt (le commit doit y être : `git fetch origin alpha`).
const alphaDir = join(tmpdir(), `syncplus-alpha-${ALPHA_COMMIT}`);
if (!existsSync(join(alphaDir, 'index.html'))) {
  mkdirSync(alphaDir, { recursive: true });
  execFileSync('sh', ['-c', `git -C "${ROOT}" archive ${ALPHA_COMMIT} | tar -x -C "${alphaDir}"`]);
}
let newsOn = false; // la fenêtre des nouveautés de la Bêta : montrée une fois, au premier document monté
await serveWidget({ env, port: ALPHA_PORT, root: alphaDir });
await serveWidget({ env, port: BETA_PORT, news: () => newsOn });

const { api, applyActions } = gristApi(env);
const records = async (doc, table) => (await api('GET', `/docs/${doc}/tables/${table}/records`)).records.map(r => ({ id: r.id, ...r.fields }));
const sql = async (doc, query) => (await api('POST', `/docs/${doc}/sql`, { sql: query })).records.map(r => r.fields);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, what, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Délai dépassé : ${what}`);
    await sleep(500);
  }
}
const { tableRef, newDocWithWidget, pageOf, publishedForms, formLink } = docTools({ env, api, applyActions, records, waitFor, widgetUrl: ALPHA_URL });
const step = text => console.log(`· ${text}`);

const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1100, height: 800 } });
const page = await context.newPage();
const betaErrors = [];
const alphaErrors = [];
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const where = m.location().url || '';
  if (where.startsWith(`http://localhost:${BETA_PORT}`)) betaErrors.push(`${m.text()} (${where})`);
  else if (where.startsWith(`http://localhost:${ALPHA_PORT}`)) alphaErrors.push(`${m.text()} (${where})`);
});
page.on('pageerror', e => betaErrors.push(`pageerror : ${e.message}`));
await page.goto(`${env.grist}/test/login?username=${env.email}&name=Test&next=${env.grist}/`);

const { widget, button, dialog, dialogButton, openWidget, testLink, pasteReply, acceptInvitation } = gestures({ page, env });
let shotN = 0;
const shot = async name => {
  if (!process.env.SHOTS) return;
  mkdirSync(process.env.SHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`) });
};

// ----------------------------------------------------------------------------------------------------------------
// Ce qu'un humain fait avec l'Alpha (les textes sont ceux de la V0.5.9).

async function newExport(table, name) {
  await button('Nouvel export').click();
  await dialog().getByRole('checkbox', { name: table }).check();
  await dialogButton('Continuer').click();
  await dialogButton('Continuer').click();
  await dialog().getByLabel('Nom de l’export').fill(name);
  await dialogButton('Créer l’export').click();
}
// SOURCE : une invitation (avec ou sans secret) ; rend le code.
// `exp` : l'export dont on ajoute une personne depuis sa carte ; sans `exp`, depuis la fenêtre qui suit la création d'un export.
async function invite({ secret = true, mode = '', exp = '' } = {}) {
  const scope = exp ? widget().locator('.card', { hasText: exp }) : dialog();
  await scope.getByRole('button', { name: 'Ajouter un destinataire', exact: true }).click();
  if (!secret) await dialog().getByRole('checkbox', { name: 'Protéger l’invitation par un secret' }).uncheck();
  if (mode) await dialog().getByRole('radio', { name: mode }).check();
  await dialogButton('Créer l’invitation').click();
  await dialog().getByText('Transmettez ce code').waitFor();
  return dialog().locator('textarea.code').first().inputValue();
}
// Un document neuf montre l'accueil à deux tuiles, un document déjà reçu ouvre sur Recevoir : on attend l'un ou l'autre.
async function receiveScreen() {
  const tile = widget().locator('.tile', { hasText: 'Recevoir des tables' });
  const accept = button('Accepter une invitation');
  await tile.or(accept).first().waitFor({ timeout: 30000 });
  if (await tile.isVisible()) await tile.click();
}
// CIBLE : accepter une invitation (destinations par défaut), coller le lien du formulaire publié, rendre la réponse.
async function accept(doc, url, code, tables) {
  await openWidget(url);
  const before = (await publishedForms(doc.doc)).length;
  await receiveScreen();
  await button('Accepter une invitation').click();
  await dialog().locator('textarea.code').first().fill(code);
  await dialogButton('Continuer').click();
  await dialog().getByText(tables).waitFor();
  await dialogButton('Continuer').click();
  const forms = await waitFor(async () => { const f = await publishedForms(doc.doc); return f.length === before + 1 && f; }, 'formulaire publié');
  await openWidget(url); // l'assistant se rouvre seul à l'étape Lien
  const reply = await testLink('Lien du formulaire', await formLink(doc.doc, forms[forms.length - 1]), 'Le lien fonctionne');
  await dialogButton('Fermer').click();
  return reply;
}
// SOURCE : coller la réponse, approuver, envoyer l'existant.
async function approve(src, reply) {
  await openWidget(src.url);
  await pasteReply(reply);
  await dialogButton('Approuver et brancher').click();
  await dialog().getByText('Branché').waitFor();
  await dialogButton('Envoyer').click();
  await dialog().getByText('Lignes existantes envoyées').waitFor({ timeout: 180000 });
  await dialogButton('Fermer').click();
  await dialog().waitFor({ state: 'detached' });
}

// La personne n° `n` (de 0) de l'export `name`, sur l'onglet Envoyer (Alpha comme Bêta).
const person = (name, n) => widget().locator('.card', { hasText: name }).locator('.person').nth(n);

// ----------------------------------------------------------------------------------------------------------------
// Comparer une SOURCE et une CIBLE : mêmes clés, mêmes valeurs, aucune ligne en double, aucune ligne cochée Supprime.

const norm = (rows, cols) => rows.map(r => [r.id_sync, ...cols.map(c => r[c] ?? '')].join('|')).sort();
async function mirror(src, dst, { srcTable = 'Contacts', dstTable = 'Contacts', cols = ['Nom', 'Ville'], keep = () => true } = {}) {
  const wanted = (await records(src.doc, srcTable)).filter(r => !r.Supprime && keep(r));
  const got = await records(dst.doc, dstTable);
  const keys = got.map(r => r.id_sync);
  const expected = norm(wanted, cols);
  const actual = norm(got, cols);
  const same = expected.length === actual.length && expected.every((v, i) => v === actual[i]);
  return { same, doubles: keys.length - new Set(keys).size, missing: expected.filter(v => !actual.includes(v)), extra: actual.filter(v => !expected.includes(v)), n: [expected.length, actual.length] };
}
// Ouvre la CIBLE (par `open`) tant que la copie n'est pas identique à la SOURCE.
async function converge(label, open, src, dst, options, timeout = 120000) {
  await open();
  let last;
  try {
    await waitFor(async () => { last = await mirror(src, dst, options); return last.same && !last.doubles; }, label, timeout);
  } catch (e) {
    throw new Error(`${label} : CIBLE ≠ SOURCE (${JSON.stringify({ ...last, missing: (last.missing || []).slice(0, 5), extra: (last.extra || []).slice(0, 5) })})`);
  }
}

let seq = 0;
// Un jeu de changements dans la SOURCE : une ville change, une ligne est cochée Supprime, une ligne est supprimée, une ligne arrive.
async function sourceOps(src, table = 'Contacts') {
  seq++;
  const rows = (await records(src.doc, table)).filter(r => !r.Supprime);
  const [a, b, c] = rows;
  await applyActions(src.doc, [
    ['UpdateRecord', table, a.id, { Ville: `Ville${seq}` }],
    ['UpdateRecord', table, b.id, { Supprime: true }],
    ['RemoveRecord', table, c.id],
    ['AddRecord', table, null, { Nom: `Nouveau${seq}`, Ville: `N${seq}` }],
  ]);
}

// L'état technique des webhooks : ce que Grist a enregistré (identifiant, adresse, mémo) et l'état de leur file.
async function hooks(doc) {
  return (await api('GET', `/docs/${doc}/webhooks`)).webhooks.map(h => ({
    id: h.id, url: h.fields.url, enabled: h.fields.enabled, tableId: h.fields.tableId, memo: h.fields.memo, usage: h.usage || {},
  }));
}
const queueIdle = async doc => (await hooks(doc)).every(h => !(h.usage.numWaiting) && !h.usage.lastErrorMessage);

async function setWidgetUrl(doc, url) {
  const section = (await records(doc, '_grist_Views_section')).find(s => s.parentKey === 'custom');
  const options = JSON.parse(section.options || '{}');
  const view = JSON.parse(options.customView);
  view.url = url;
  await applyActions(doc, [['UpdateRecord', '_grist_Views_section', section.id, { options: JSON.stringify({ ...options, customView: JSON.stringify(view) }) }]]);
}

// ----------------------------------------------------------------------------------------------------------------
// Les partages d'avant, montés avec l'Alpha.

const world = {};
async function buildAlphaShares() {
  const names = Array.from({ length: 60 }, (_, i) => `Personne ${String(i).padStart(2, '0')}`);
  world.source = await newDocWithWidget('Source', [
    ['AddTable', 'Contacts', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }, { id: 'Interne', type: 'Text' }, { id: 'Supprime', type: 'Bool' }]],
    ['BulkAddRecord', 'Contacts', names.map(() => null), { Nom: names, Ville: names.map((_, i) => ['Lyon', 'Paris', 'Nantes', 'Brest'][i % 4]), Interne: names.map(() => 'secret interne') }],
    ['AddTable', 'Villes', [{ id: 'Ville', type: 'Text' }, { id: 'Habitants', type: 'Numeric' }]],
    ['BulkAddRecord', 'Villes', [null, null, null], { Ville: ['Lyon', 'Paris', 'Nantes'], Habitants: [500, 2100, 320] }],
  ]);
  world.t1 = await newDocWithWidget('Cible 1');
  world.t2 = await newDocWithWidget('Cible 2');

  // Export « Annuaire » (Contacts) : T1 avec secret, T2 sans secret.
  await openWidget(world.source.url);
  await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
  await newExport('Contacts', 'Annuaire');
  const code1 = await invite({ secret: true });
  await dialogButton('Plus tard').click();
  await approve(world.source, await accept(world.t1, world.t1.url, code1, '« Annuaire » : table Contacts.'));
  await openWidget(world.source.url);
  const code2 = await invite({ secret: false, exp: 'Annuaire' });
  await dialogButton('Plus tard').click();
  await approve(world.source, await accept(world.t2, world.t2.url, code2, '« Annuaire » : table Contacts.'));
  // Export « Lieux » (Villes) vers T1 : un second journal, un second formulaire.
  await openWidget(world.source.url);
  await newExport('Villes', 'Lieux');
  const code3 = await invite({ secret: false });
  await dialogButton('Plus tard').click();
  await approve(world.source, await accept(world.t1, world.t1.url, code3, '« Lieux » : table Villes.'));
  await converge('Alpha : Annuaire chez T1', () => openWidget(world.t1.url), world.source, world.t1);
  await converge('Alpha : Annuaire chez T2', () => openWidget(world.t2.url), world.source, world.t2);
  await converge('Alpha : Lieux chez T1', () => openWidget(world.t1.url), world.source, world.t1, { srcTable: 'Villes', dstTable: 'Villes', cols: ['Ville', 'Habitants'] });
  step('Alpha : un export de Contacts vers deux CIBLE (avec et sans secret), un export de Villes vers la première');

  // Changements avec l'Alpha des deux côtés.
  await sourceOps(world.source);
  await converge('Alpha : changements chez T1', () => openWidget(world.t1.url), world.source, world.t1);
  await converge('Alpha : changements chez T2', () => openWidget(world.t2.url), world.source, world.t2);
  step('Alpha : ajout, modification, suppression logique et vraie suppression reçus des deux côtés');

  // T2 est mise en pause, puis la SOURCE change : T2 prend du retard (elle restera en pause pendant la montée).
  await openWidget(world.source.url);
  await person('Annuaire', 1).getByRole('button', { name: 'Mettre en pause' }).click();
  await person('Annuaire', 1).getByRole('button', { name: 'Reprendre' }).waitFor();
  await sourceOps(world.source);
  await converge('Alpha : T1 suit pendant la pause de T2', () => openWidget(world.t1.url), world.source, world.t1);
  assert.ok(!(await mirror(world.source, world.t2)).same, 'T2, en pause, n\'a pas reçu les derniers changements');
  step('Alpha : T2 en pause, la SOURCE continue (T1 suit)');
}

// Échange d'avant : A et B se tiennent à jour l'un l'autre.
async function buildAlphaExchange() {
  const a = world.a = await newDocWithWidget('Échange A', [
    ['AddTable', 'Fiches', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }]],
    ['BulkAddRecord', 'Fiches', [null, null, null], { Nom: ['Anna', 'Basile', 'Céline'], Ville: ['Lyon', 'Paris', 'Nantes'] }],
  ]);
  const b = world.b = await newDocWithWidget('Échange B');
  await openWidget(a.url);
  await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
  await newExport('Fiches', 'Partage');
  await dialogButton('Ajouter un destinataire').click();
  await dialog().getByRole('radio', { name: /Échange/ }).check();
  await dialogButton('Créer l’invitation').click();
  const back = await waitFor(async () => { const f = await publishedForms(a.doc); return f.length === 1 && f; }, 'formulaire de retour publié');
  await openWidget(a.url); // l'assistant reprend à l'étape du lien de retour
  const code = await testLink('Lien du formulaire de retour', await formLink(a.doc, back[0]), 'Transmettez ce code');
  await dialogButton('Plus tard').click();
  const answer = await accept(b, b.url, code, '« Partage » : table Fiches.');
  await approve(a, answer);
  const fiches = async doc => Object.fromEntries((await records(doc, 'Fiches')).map(r => [r.Nom, r]));
  await openWidget(b.url);
  await waitFor(async () => Object.keys(await fiches(b.doc)).length === 3, 'B reçoit les fiches de A');
  const bRows = await fiches(b.doc);
  await applyActions(b.doc, [['UpdateRecord', 'Fiches', bRows.Basile.id, { Ville: 'Brest' }], ['AddRecord', 'Fiches', null, { Nom: 'Damien', Ville: 'Metz' }]]);
  await openWidget(a.url);
  await waitFor(async () => { const r = await fiches(a.doc); return r.Basile.Ville === 'Brest' && r.Damien; }, 'A reçoit les modifications de B');
  step('Alpha : un Échange A↔B en route, des changements dans les deux sens');
}

// Lien public d'avant : la CIBLE lit les instantanés de l'export, sans échange de réponse.
async function buildAlphaPublic() {
  const s = world.ps = await newDocWithWidget('Public SOURCE', [
    ['AddTable', 'Contacts', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }, { id: 'Supprime', type: 'Bool' }]],
    ['BulkAddRecord', 'Contacts', [null, null, null, null], { Nom: ['Alice', 'Bob', 'Chloé', 'Dora'], Ville: ['Lyon', 'Paris', 'Nantes', 'Brest'] }],
  ]);
  const t = world.pt = await newDocWithWidget('Public CIBLE');
  await openWidget(s.url);
  await widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
  await newExport('Contacts', 'Public');
  const code = await invite({ mode: /Lien public/ });
  await dialogButton('Fermer').click();
  await widget().getByText('Lien public à activer').waitFor();
  await api('PATCH', `/docs/${s.doc}/access`, { delta: { users: { 'everyone@getgrist.com': 'viewers' } } });
  await openWidget(s.url);
  await widget().locator('.pill', { hasText: /^Public$/ }).waitFor();
  await openWidget(t.url);
  await receiveScreen();
  await acceptInvitation(code);
  await dialog().getByText('Branché').waitFor();
  await dialogButton('Fermer').click();
  await waitFor(async () => (await records(t.doc, 'Annuaire')).length === 4, 'lien public : lignes lues');
  await applyActions(s.doc, [['AddRecord', 'Contacts', null, { Nom: 'Émile', Ville: 'Metz' }]]);
  await waitFor(async () => (await records(t.doc, 'Annuaire')).some(r => r.Nom === 'Émile'), 'lien public : ajout lu');
  step('Alpha : un lien public en route (la CIBLE lit les instantanés)');
}

// ----------------------------------------------------------------------------------------------------------------
// La Bêta.

const settled = new Set();
// Ouvre un document avec la Bêta. Au premier passage d'un document, la Bêta pose ses règles d'accès et Grist recharge le
// document (donc le widget) : on laisse faire, puis on rouvre.
async function openBeta(doc, tab) {
  await openWidget(doc.url);
  if (!settled.has(doc.doc)) {
    settled.add(doc.doc);
    await sleep(4500);
    await openWidget(doc.url);
  }
  if (tab) await pickTab(widget(), tab);
}
async function upgrade(doc) {
  await setWidgetUrl(doc.doc, BETA_URL);
}
const text = async () => (await widget().locator('body').innerText()).replace(/\s+/g, ' ');
// Rien ne doit être en erreur sur l'écran : ni avis « role=alert », ni état « Erreur ».
async function noErrorOnScreen(label) {
  await sleep(1500);
  const body = await text();
  assert.equal(await widget().locator('[role=alert]').count(), 0, `${label} : un avis d'erreur est affiché : ${body.slice(0, 600)}`);
  assert.ok(!/\bErreur\b/.test(body), `${label} : un état « Erreur » est affiché : ${body.slice(0, 600)}`);
  assert.deepEqual(betaErrors, [], `${label} : erreurs dans la console de la Bêta`);
}

// La fenêtre des nouveautés s'ouvre une fois, au premier document monté (par navigateur) : deux écrans, le second dit que les partages
// d'avant continuent et que rien n'est obligatoire.
async function checkNews(doc) {
  newsOn = true;
  await openWidget(doc.url);
  if (!settled.has(doc.doc)) { // première ouverture : règles d'accès posées, le document se recharge
    settled.add(doc.doc);
    await sleep(4500);
    await openWidget(doc.url);
  }
  await dialog().getByText(/Sync\+\s:\sles nouveautés/).waitFor({ timeout: 30000 });
  await dialogButton('Continuer').click();
  await dialog().getByText('Vos partages actuels continuent de fonctionner').waitFor();
  await shot('nouveautes-partages');
  await dialogButton('Plus tard').click();
  await dialog().waitFor({ state: 'detached' });
  newsOn = false;
  step('Bêta : la fenêtre des nouveautés s\'ouvre une fois et dit que les partages d\'avant continuent');
}

async function phaseTargetFirst() {
  await upgrade(world.t1);
  await checkNews(world.t1);
  await pickTab(widget(), 'Recevoir');
  await shot('t1-bêta');
  await noErrorOnScreen('T1 montée');
  step('Bêta : la CIBLE T1 est montée seule, ses deux réceptions s\'ouvrent sans erreur');
  // La SOURCE est encore l'Alpha : ses envois arrivent chez une CIBLE de la Bêta.
  await sourceOps(world.source);
  await converge('SOURCE Alpha → T1 Bêta : Annuaire', () => openBeta(world.t1, 'Recevoir'), world.source, world.t1);
  const villes = await records(world.source.doc, 'Villes');
  await applyActions(world.source.doc, [['UpdateRecord', 'Villes', villes[0].id, { Habitants: 999 }], ['AddRecord', 'Villes', null, { Ville: 'Rouen', Habitants: 110 }]]);
  await converge('SOURCE Alpha → T1 Bêta : Lieux', () => openBeta(world.t1, 'Recevoir'), world.source, world.t1, { srcTable: 'Villes', dstTable: 'Villes', cols: ['Ville', 'Habitants'] });
  await noErrorOnScreen('T1 après des envois de l\'Alpha');
  step('SOURCE Alpha vers CIBLE Bêta : ajout, modification et suppressions reçus, sans doublon, deux exports');
}

async function phaseSource() {
  const before = await hooks(world.source.doc);
  await upgrade(world.source);
  await openBeta(world.source, 'Envoyer');
  await shot('source-bêta');
  await noErrorOnScreen('SOURCE montée');
  const after = await hooks(world.source.doc);
  assert.deepEqual(after.map(h => h.id).sort(), before.map(h => h.id).sort(), 'aucun webhook recréé ou perdu');
  assert.equal(after.length, 3, 'trois destinataires, trois webhooks');
  assert.ok(after.every(h => h.tableId === 'Synchro'), 'tous sur la table Synchro');
  step('Bêta : la SOURCE est montée, ses trois webhooks sont ceux d\'avant');
  // La CIBLE T1 (Bêta) reçoit ce que la SOURCE (Bêta) envoie.
  await sourceOps(world.source);
  await converge('SOURCE Bêta → T1 Bêta', () => openBeta(world.t1, 'Recevoir'), world.source, world.t1);
  // T2 (Alpha, en pause) n'a rien reçu : la reprise se fait depuis l'écran de la Bêta.
  await openBeta(world.source, 'Envoyer');
  await person('Annuaire', 1).getByRole('button', { name: 'Reprendre' }).click();
  await dialogButton('Reprendre').click();
  await dialog().waitFor({ state: 'detached', timeout: 30000 });
  // La reprise continue page ouverte (webhook rallumé, note, puis renvoi) : on reste sur la SOURCE jusqu'à ce que le renvoi soit
  // arrivé au journal de T2 (qui n'est pas ouverte : seul le webhook y dépose).
  await person('Annuaire', 1).getByRole('button', { name: 'Mettre en pause' }).waitFor({ timeout: 30000 });
  await waitFor(async () => (await records(world.t2.doc, 'Journal_Annuaire')).some(r => String(r.Synchro_Lot || '').includes(`Nouveau${seq}`)),
    'le renvoi de la reprise arrive au journal de T2', 90000);
  await shot('source-reprise');
  // La CIBLE T2 est encore l'Alpha : elle reçoit les lots de la SOURCE de la Bêta.
  await converge('SOURCE Bêta → T2 Alpha, après la reprise', () => openWidget(world.t2.url), world.source, world.t2);
  step('SOURCE Bêta vers CIBLE Alpha : la pause d\'avant se lève depuis la Bêta, T2 rattrape tout');
}

async function phaseBigImport() {
  const names = Array.from({ length: 700 }, (_, i) => `Import ${i} ${'x'.repeat(60)}`);
  await applyActions(world.source.doc, [['BulkAddRecord', 'Contacts', names.map(() => null), { Nom: names, Ville: names.map(() => 'Lille') }]]);
  await openBeta(world.source, 'Envoyer'); // le rattrapage de la SOURCE complète ce qu'un seul envoi n'a pas porté
  await converge('Import de 700 lignes : T1 Bêta', () => openBeta(world.t1, 'Recevoir'), world.source, world.t1, {}, 240000);
  await converge('Import de 700 lignes : T2 Alpha', () => openWidget(world.t2.url), world.source, world.t2, {}, 240000);
  await waitFor(() => queueIdle(world.source.doc), 'files des webhooks vides', 60000);
  step('SOURCE Bêta : un import de 700 lignes arrive en entier chez la CIBLE Bêta et chez la CIBLE Alpha');
}

async function phaseTargetLast() {
  await upgrade(world.t2);
  await openBeta(world.t2, 'Recevoir');
  await shot('t2-bêta');
  await noErrorOnScreen('T2 montée');
  await sourceOps(world.source);
  await converge('Les deux côtés sur la Bêta : T2', () => openBeta(world.t2, 'Recevoir'), world.source, world.t2);
  await converge('Les deux côtés sur la Bêta : T1', () => openBeta(world.t1, 'Recevoir'), world.source, world.t1);
  await waitFor(() => queueIdle(world.source.doc), 'files des webhooks vides', 60000);
  step('Bêta des deux côtés : tout le monde est à jour, aucune file ne bloque');
}

async function phaseExchange() {
  const fiches = async doc => Object.fromEntries((await records(doc, 'Fiches')).map(r => [r.Nom, r]));
  // A monte seul, B reste l'Alpha.
  await upgrade(world.a);
  await openBeta(world.a, 'Envoyer');
  await shot('echange-a-bêta');
  await noErrorOnScreen('Échange : A monté');
  const aRows = await fiches(world.a.doc);
  await applyActions(world.a.doc, [['UpdateRecord', 'Fiches', aRows.Anna.id, { Ville: 'Lille' }]]);
  await openWidget(world.b.url);
  await waitFor(async () => (await fiches(world.b.doc)).Anna.Ville === 'Lille', 'B (Alpha) reçoit la modification de A (Bêta)');
  const bRows = await fiches(world.b.doc);
  await applyActions(world.b.doc, [['UpdateRecord', 'Fiches', bRows.Céline.id, { Ville: 'Rennes' }]]);
  await openBeta(world.a, 'Envoyer');
  await waitFor(async () => (await fiches(world.a.doc)).Céline.Ville === 'Rennes', 'A (Bêta) reçoit la modification de B (Alpha)');
  // B monte à son tour.
  await upgrade(world.b);
  await openBeta(world.b, 'Recevoir');
  await noErrorOnScreen('Échange : B monté');
  await applyActions(world.b.doc, [['UpdateRecord', 'Fiches', (await fiches(world.b.doc)).Basile.id, { Ville: 'Tours' }]]);
  await openBeta(world.a, 'Envoyer');
  await waitFor(async () => (await fiches(world.a.doc)).Basile.Ville === 'Tours', 'A reçoit la modification de B (Bêta)');
  await applyActions(world.a.doc, [['UpdateRecord', 'Fiches', (await fiches(world.a.doc)).Damien.id, { Ville: 'Nice' }]]);
  await openBeta(world.b, 'Recevoir');
  await waitFor(async () => (await fiches(world.b.doc)).Damien.Ville === 'Nice', 'B (Bêta) reçoit la modification de A');
  const ids = async doc => Object.values(await fiches(doc)).map(r => r.id_sync).sort();
  assert.deepEqual(await ids(world.a.doc), await ids(world.b.doc), 'mêmes clés des deux côtés, aucune ligne en double');
  step('Échange d\'avant : monté côté A puis côté B, les changements passent dans les deux sens à chaque étape');
}

async function phasePublic() {
  const anon = table => fetch(`${TEAM}/api/docs/${world.ps.doc}/tables/${table}/records`);
  await upgrade(world.pt);
  await openBeta(world.pt, 'Recevoir');
  await noErrorOnScreen('Lien public : CIBLE montée');
  await applyActions(world.ps.doc, [['AddRecord', 'Contacts', null, { Nom: 'Fanny', Ville: 'Caen' }]]);
  await waitFor(async () => (await records(world.pt.doc, 'Annuaire')).some(r => r.Nom === 'Fanny'), 'lien public : la CIBLE Bêta lit la SOURCE Alpha');
  await upgrade(world.ps);
  await openBeta(world.ps, 'Envoyer');
  await noErrorOnScreen('Lien public : SOURCE montée');
  assert.equal((await anon('Contacts')).status, 403, 'table source toujours cachée au lien public');
  await applyActions(world.ps.doc, [['AddRecord', 'Contacts', null, { Nom: 'Gabriel', Ville: 'Dax' }]]);
  await openBeta(world.pt, 'Recevoir'); // la CIBLE lit les instantanés page ouverte
  await waitFor(async () => (await records(world.pt.doc, 'Annuaire')).some(r => r.Nom === 'Gabriel'), 'lien public : la CIBLE lit la SOURCE montée');
  step('Lien public d\'avant : CIBLE puis SOURCE montées, la lecture continue, la table reste cachée');
}

// Ce que la Bêta a migré dans les documents montés : notes hors des descriptions de colonnes (lisibles par un visiteur d'un
// document public), courriels hors du mémo des webhooks ; et ce qu'elle laisse tel quel : les destinataires d'avant n'ont pas de clé
// de signature, la Bêta le dit (« Renforcer la sécurité ») sans l'imposer, leurs envois passent encore.
async function phaseMigrations() {
  const columns = async (doc, table) => sql(doc, `select c.colId as id, c.description as description, c.widgetOptions as options from _grist_Tables_column c join _grist_Tables t on c.parentId = t.id where t.tableId = '${table}'`);
  const sourceColumns = await columns(world.source.doc, 'Synchro');
  const exportCol = sourceColumns.find(c => c.id === 'Synchro_Export');
  assert.ok(String(exportCol.options).includes('syncNote'), 'la note de la SOURCE est dans les options de la colonne');
  assert.ok(!String(exportCol.description || '').includes('exports'), 'et plus dans sa description');
  const journal = (await sql(world.t1.doc, "select tableId from _grist_Tables where tableId like 'Journal%'")).map(r => r.tableId)[0];
  const journalIds = (await columns(world.t1.doc, journal)).find(c => c.id === 'Synchro_Ids');
  assert.ok(String(journalIds.options).includes('syncNote'), 'la note du journal de la CIBLE est dans les options de la colonne');
  assert.ok(!String(journalIds.description || '').includes('"export"'), 'et plus dans sa description');
  for (const h of await hooks(world.source.doc)) assert.ok(!String(h.memo).includes(env.email), `le mémo d'un webhook ne porte plus le courriel (${h.memo})`);
  await openBeta(world.source, 'Envoyer');
  await person('Annuaire', 0).waitFor({ timeout: 30000 });
  await waitFor(async () => (await widget().getByRole('button', { name: 'Renforcer la sécurité' }).count()) >= 1, 'la Bêta propose de renforcer la sécurité des partages d\'avant', 30000);
  assert.equal((await hooks(world.source.doc)).length, 3, 'rien n\'est imposé : les trois webhooks sont encore là');
  await noErrorOnScreen('SOURCE : partages d\'avant');
  step('Migrations : notes dans les options, courriels hors des mémos, « Renforcer la sécurité » proposé sans rien imposer');
}

// Les phases de la Bêta, dans l'ordre. `RESUME=<phases>` (séparées par des virgules) ne rejoue que celles-là sur les documents déjà
// montés d'un essai précédent (même Grist, pas de reconstruction de l'Alpha) : pour mettre au point une phase sans tout refaire.
const PHASES = { target: phaseTargetFirst, source: phaseSource, big: phaseBigImport, last: phaseTargetLast, exchange: phaseExchange, public: phasePublic, migrations: phaseMigrations };
// Retrouve les documents d'un essai précédent par leur nom (ils sont déjà montés : pas de pause à l'ouverture).
async function resumeWorld() {
  const names = { source: 'Source', t1: 'Cible 1', t2: 'Cible 2', a: 'Échange A', b: 'Échange B', ps: 'Public SOURCE', pt: 'Public CIBLE' };
  const docs = (await api('GET', `/orgs/${env.team}/workspaces`)).flatMap(w => w.docs);
  for (const [key, name] of Object.entries(names)) {
    const { id } = docs.find(d => d.name === name);
    const section = (await records(id, '_grist_Views_section')).find(s => s.parentKey === 'custom');
    world[key] = { doc: id, url: `${TEAM}/doc/${id}/p/${section.parentId}` };
    settled.add(id);
  }
}

try {
  if (process.env.RESUME) {
    await resumeWorld();
    for (const name of process.env.RESUME.split(',')) await ({ ...PHASES, news: () => checkNews(world.t1) })[name]();
  } else {
    await buildAlphaShares();
    await buildAlphaExchange();
    await buildAlphaPublic();
    assert.deepEqual(alphaErrors.filter(e => !/Failed to load resource/.test(e)), [], 'aucune erreur de console de l\'Alpha (témoin)');
    for (const phase of Object.values(PHASES)) await phase();
  }
  assert.deepEqual(betaErrors, [], 'aucune erreur dans la console de la Bêta');
  step('Montée de version : terminé');
} catch (e) {
  await page.screenshot({ path: join(ROOT, 'tests/e2e/echec-upgrade.png') }).catch(() => {});
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  process.exit();
}
