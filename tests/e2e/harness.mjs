// Outillage commun des tests de charge (tests/e2e/charge.mjs) : un Grist jetable (start-grist.sh), le
// widget servi en local, un navigateur, et de quoi monter une paire SOURCE / CIBLE branchée par le
// parcours d'un humain (export, invitation, réception, approbation). Le parcours complet
// (tests/e2e/run.mjs) garde ses propres copies de ces fonctions.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const started = Date.now();
export const clock = () => `${String(Math.floor((Date.now() - started) / 60000)).padStart(3)}:${String(Math.floor((Date.now() - started) / 1000) % 60).padStart(2, '0')}`;
export const log = text => console.log(`[${clock()}] ${text}`);

export async function createHarness({ port = 8586, patches = {}, envFile = '.env.json' } = {}) {
  const env = JSON.parse(await readFile(join(ROOT, 'tests/e2e', envFile), 'utf8'));
  const TEAM = `${env.grist}/o/${env.team}`;
  const WIDGET_URL = `http://localhost:${port}/index.html`;

  // Widget servi en local ; `patches` : { '/js/chemin.js': texte => texte } pour changer une constante
  // (par exemple le budget des renvois) quand un scénario l'exige. Toujours dit à l'écran.
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      let body = await readFile(join(ROOT, path));
      if (path === '/index.html') body = String(body).replaceAll('https://grist.numerique.gouv.fr', `${env.grist} https://grist.numerique.gouv.fr`);
      if (path === '/js/config.js') body = String(body).replace('GRIST_ORIGINS = [', `GRIST_ORIGINS = ['${env.grist}', `);
      if (patches[path]) body = patches[path](String(body));
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => server.listen(port, resolve));

  // --- API REST de Grist (préparation et mesures)
  async function request(method, path, body, { raw = false } = {}) {
    const res = await fetch(`${TEAM}/api${path}`, {
      method, headers: { Authorization: `Bearer ${env.apiKey}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (raw) return { status: res.status, text };
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  }
  const api = (method, path, body) => request(method, path, body);
  const applyActions = (doc, actions) => api('POST', `/docs/${doc}/apply`, actions);
  const records = async (doc, table) => (await api('GET', `/docs/${doc}/tables/${table}/records`)).records.map(r => ({ id: r.id, ...r.fields }));
  const sql = async (doc, query, args) => (await api('POST', `/docs/${doc}/sql`, { sql: query, args })).records.map(r => r.fields);
  // Nombre de lignes d'une table (0 si elle n'existe pas encore).
  const count = async (doc, table, where = '') => {
    try {
      return (await sql(doc, `select count(*) as n from "${table}" ${where}`))[0].n;
    } catch (e) {
      if (/no such table/.test(e.message)) return 0;
      throw e;
    }
  };
  const tableRef = async (doc, tableId) => (await records(doc, '_grist_Tables')).find(t => t.tableId === tableId).id;
  const webhooks = async doc => (await api('GET', `/docs/${doc}/webhooks`)).webhooks;
  const journalOf = async doc => (await records(doc, '_grist_Tables')).map(tb => tb.tableId).find(id => id.startsWith('Journal_'));

  async function waitFor(check, what, timeout = 30000, every = 500) {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > end) throw new Error(`Délai dépassé : ${what}`);
      await sleep(every);
    }
  }

  // Document avec le widget posé sur sa table Table1 (page « Synchro »).
  async function newDocWithWidget(name, setup, access = 'full') {
    const workspace = (await api('GET', `/orgs/${env.team}/workspaces`))[0].id;
    const doc = await api('POST', `/workspaces/${workspace}/docs`, { name });
    if (setup) await applyActions(doc, setup);
    const view = (await applyActions(doc, [['CreateViewSection', await tableRef(doc, 'Table1'), 0, 'record', null, null]])).retValues[0];
    await applyActions(doc, [
      ['UpdateRecord', '_grist_Views', view.viewRef, { name: 'Synchro' }],
      ['UpdateRecord', '_grist_Views_section', view.sectionRef, {
        parentKey: 'custom', options: JSON.stringify({ customView: JSON.stringify({ mode: 'url', url: WIDGET_URL, access, renderAfterReady: false }) }),
      }],
    ]);
    return { doc, url: `${TEAM}/doc/${doc}/p/${view.viewRef}` };
  }

  // Table de `rows` lignes remplie par paquets (le corps d'une requête reste petit).
  async function fillTable(doc, tableId, columns, rows, makeRow, { prefix = 0 } = {}) {
    await applyActions(doc, [['AddTable', tableId, columns]]);
    // Paquets d'au plus 2 000 lignes et d'environ 30 000 cellules (le corps d'une requête de Grist est limité à 1 Mo).
    const step = Math.max(50, Math.min(2000, Math.floor(30000 / columns.length)));
    for (let from = 0; from < rows; from += step) {
      const n = Math.min(step, rows - from);
      const cols = Object.fromEntries(columns.map(c => [c.id, []]));
      for (let i = 0; i < n; i++) {
        const row = makeRow(prefix + from + i);
        for (const c of columns) cols[c.id].push(row[c.id]);
      }
      await applyActions(doc, [['BulkAddRecord', tableId, Array(n).fill(null), cols]]);
    }
  }

  // --- Navigateur
  const browser = await chromium.launch();
  const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 1100, height: 700 } });
  const problems = []; // erreurs du widget (console, exceptions)
  const widgetCode = `http://localhost:${port}`;

  class View {
    constructor(page, name) {
      this.page = page; this.name = name; this.messages = [];
      page.on('console', (m) => {
        const where = m.location().url || '';
        if (!where.startsWith(widgetCode) && !where.endsWith('grist-plugin-api.js')) return;
        if (m.type() === 'error' || m.type() === 'warning') this.messages.push(`${m.type()} ${m.text()}`);
        if (m.type() === 'error') problems.push(`${name}: ${m.text()} (${where})`);
      });
      page.on('pageerror', (e) => { if ((e.stack || '').includes(widgetCode)) problems.push(`${name}: ${e.message} (pageerror)`); });
    }
    widget() { return this.page.frameLocator('iframe').first(); }
    button(name) { return this.widget().getByRole('button', { name, exact: true }); }
    dialog() { return this.widget().getByRole('dialog'); }
    dialogButton(name) { return this.dialog().getByRole('button', { name, exact: true }); }
    async open(url) {
      await this.page.goto(url);
      await this.widget().locator('.topbar').waitFor({ timeout: 60000 });
    }
    // Texte de la carte affichée par le widget (pour les messages d'erreur à lire).
    async text() {
      return (await this.widget().locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    }
    // Page rendue cachée aux yeux du widget (onglet d'arrière-plan) ou de nouveau visible : le widget est dans
    // un cadre d'une autre origine que Grist, on évalue donc dans chaque cadre.
    async hide(hidden = true) {
      for (const frame of this.page.frames()) {
        await frame.evaluate((h) => {
          const state = h ? 'hidden' : 'visible';
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
          document.dispatchEvent(new Event('visibilitychange'));
        }, hidden).catch(() => {});
      }
    }
  }
  async function newView(name) {
    const page = await context.newPage();
    return new View(page, name);
  }
  const login = async (view, email = env.email) => { await view.page.goto(`${env.grist}/test/login?username=${email}&name=${email.split('@')[0]}&next=${env.grist}/`); };
  // Vue d'une autre personne (son propre contexte de navigateur, donc ses propres cookies) : éditeur, lecteur…
  // Le document lui est ouvert par `shareDoc`.
  async function userView(name, email) {
    const page = await (await browser.newContext({ locale: 'fr-FR', viewport: { width: 1100, height: 700 } })).newPage();
    const view = new View(page, name);
    await login(view, email);
    return view;
  }
  const shareDoc = (doc, email, access) => api('PATCH', `/docs/${doc}/access`, { delta: { users: { [email]: access } } });

  // --- Parcours d'un humain : export, invitation, réception, approbation
  const pageOf = async (doc, viewRef) => (await records(doc, '_grist_Pages')).find(p => p.viewRef === viewRef);
  const publishedForms = async doc => (await records(doc, '_grist_Views_section')).filter(sc => JSON.parse(sc.shareOptions || '{}').publish);
  // Clé de la page d'un formulaire, lue dans la base du serveur de test (Grist l'enregistre juste après le partage).
  async function formKey(doc, form) {
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
  }
  const formLink = async (doc, form) => `${TEAM}/forms/${await formKey(doc, form)}/${form.id}`;

  // SOURCE : crée un export de `table` (toutes les colonnes), nommé `name`.
  async function createExport(view, table, name) {
    await view.widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
    await view.button('Nouvel export').click();
    await view.dialog().getByRole('checkbox', { name: table }).check();
    await view.dialogButton('Continuer').click();
    await view.dialogButton('Continuer').click();
    await view.dialog().getByLabel('Nom de l’export').fill(name);
    await view.dialogButton('Créer l’export').click();
    await view.dialog().getByText(`Export « ${name} » créé.`).waitFor({ timeout: 600000 });
  }
  // SOURCE : invitation aux options par défaut pour l'export affiché ; rend le code.
  async function invite(view) {
    await view.dialogButton('Ajouter un destinataire').click();
    await view.dialogButton('Créer l’invitation').click();
    await view.dialog().getByText('Transmettez ce code').waitFor({ timeout: 60000 });
    const code = await view.dialog().locator('textarea.code').first().inputValue();
    await view.dialogButton('Plus tard').click();
    return code;
  }
  // CIBLE : accepte l'invitation, colle le lien du formulaire publié ; rend la réponse et le code de contrôle.
  async function accept(view, target, code, { exportName, table }) {
    await view.open(target.url);
    await view.widget().locator('.tile', { hasText: 'Recevoir des tables' }).click();
    await view.button('Accepter une invitation').click();
    await view.dialog().locator('textarea.code').first().fill(code);
    await view.dialogButton('Continuer').click();
    await view.dialog().getByText(`« ${exportName} » : table ${table}.`).waitFor({ timeout: 60000 });
    await view.dialogButton('Continuer').click();
    const forms = await waitFor(async () => { const f = await publishedForms(target.doc); return f.length === 1 && f; }, 'formulaire publié', 60000);
    await view.open(target.url); // l'assistant se rouvre seul à l'étape Lien
    await view.dialog().getByLabel('Lien du formulaire').fill(await formLink(target.doc, forms[0]));
    await view.dialogButton('Tester le lien').click();
    await view.dialog().getByText('Le lien fonctionne').waitFor({ timeout: 60000 });
    const reply = await view.dialog().locator('textarea.code').first().inputValue();
    const control = await view.dialog().locator('.control-code strong').first().textContent();
    await view.dialogButton('Fermer').click();
    return { reply, control };
  }
  // SOURCE : colle la réponse, approuve et branche. `send` : 'wait' (envoie l'existant et attend la fin),
  // 'start' (lance l'envoi, rend la main), 'skip' (ne l'envoie pas).
  async function approve(view, source, { reply, control }, { send = 'skip' } = {}) {
    await view.open(source.url);
    await view.button('Coller la réponse').click();
    await view.dialog().locator('textarea.code').first().fill(reply);
    await view.dialogButton('Vérifier').click();
    await view.dialog().getByText(env.email).waitFor({ timeout: 60000 });
    if (control && (await view.dialog().locator('.control-code strong').textContent()) !== control) throw new Error('codes de contrôle différents');
    await view.dialogButton('Approuver et brancher').click();
    await view.dialog().getByText('Branché').waitFor({ timeout: 60000 });
    if (send === 'skip') {
      await view.dialogButton('Plus tard').click();
      return;
    }
    await view.dialogButton('Envoyer').click();
    if (send === 'start') {
      await view.dialog().getByText(/Envoi : /).waitFor({ timeout: 60000 }).catch(() => {});
      return;
    }
    await view.dialog().getByText('Lignes existantes envoyées').waitFor({ timeout: 3 * 3600 * 1000 });
    await view.dialogButton('Fermer').click();
    await view.dialog().waitFor({ state: 'detached' });
  }

  // Paire branchée : SOURCE (table `table` déjà remplie) et CIBLE, un export, un destinataire.
  // Rend les documents, les vues ouvertes sur chacun, et l'identifiant de l'export.
  async function pair({ name, table, columns, rows, makeRow, exportName = 'Annuaire', send = 'skip', source: setup = [], afterAccept = async () => {}, beforeExport = async () => {} }) {
    const src = await newDocWithWidget(`${name} SOURCE`, setup);
    if (columns) await fillTable(src.doc, table, columns, rows, makeRow);
    const dst = await newDocWithWidget(`${name} CIBLE`);
    await beforeExport({ src });
    const sv = await newView('source');
    await login(sv);
    await sv.open(src.url);
    await createExport(sv, table, exportName);
    const code = await invite(sv);
    const dv = await newView('cible');
    await login(dv);
    const answer = await accept(dv, dst, code, { exportName, table });
    await afterAccept({ sv, dv, src, dst });
    await approve(sv, src, answer, { send });
    const exportId = (await records(src.doc, 'Synchro')).find(r => r.Synchro_Type === 'lot').Synchro_Export;
    return { src, dst, sv, dv, exportId, table, dest: table, exportName, journal: await journalOf(dst.doc), code };
  }

  // Destinataire de plus pour l'export d'une paire : nouvelle CIBLE, invitation par la carte de l'export, approbation.
  async function addRecipient(p, { name, send = 'skip' }) {
    const dst = await newDocWithWidget(`${name} CIBLE`);
    await p.sv.open(p.src.url);
    await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
    await p.sv.button('Ajouter un destinataire').click();
    await p.sv.dialogButton('Créer l’invitation').click();
    await p.sv.dialog().getByText('Transmettez ce code').waitFor({ timeout: 60000 });
    const code = await p.sv.dialog().locator('textarea.code').first().inputValue();
    await p.sv.dialogButton('Plus tard').click();
    const dv = await newView('cible2');
    await login(dv);
    const answer = await accept(dv, dst, code, { exportName: p.exportName, table: p.table });
    await approve(p.sv, p.src, answer, { send });
    return { dst, dv, journal: await journalOf(dst.doc), dest: p.table };
  }

  async function close() {
    await browser.close();
    server.close();
  }

  return {
    env, TEAM, WIDGET_URL, api, request, applyActions, records, sql, count, tableRef, webhooks, journalOf, waitFor, newDocWithWidget, fillTable,
    newView, userView, shareDoc, login, createExport, invite, accept, approve, pair, addRecipient, close, problems, formKey, formLink, publishedForms,
  };
}
