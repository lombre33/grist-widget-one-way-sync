// Ce que partagent le parcours complet (run.mjs), l'outillage des autres essais (harness.mjs) et les outils de
// diagnostic (tools/) : le widget servi en local, et la préparation d'un document SOURCE ou CIBLE avec le widget
// posé, avec le formulaire publié qu'on y retrouve. Un seul texte pour chacun : un correctif vaut pour tous les essais.
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };

// Le widget servi en local. L'instance de test est ajoutée à la liste des instances autorisées (config.js) et à la
// politique de sécurité (index.html), comme le ferait une instance qui héberge sa propre copie. `adjust(chemin,
// corps)` rend le corps à servir : un essai y change une constante (un budget, un délai) quand son scénario l'exige.
export async function serveWidget({ env, port, adjust = (path, body) => body }) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    try {
      let body = await readFile(join(ROOT, path));
      if (path === '/index.html') body = String(body).replaceAll('https://grist.numerique.gouv.fr', `${env.grist} https://grist.numerique.gouv.fr`);
      if (path === '/js/config.js') body = String(body).replace('GRIST_ORIGINS = [', `GRIST_ORIGINS = ['${env.grist}', `);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(adjust(path, body));
    } catch (e) {
      res.writeHead(404); res.end();
    }
  });
  await new Promise(resolve => server.listen(port, resolve));
  return server;
}

// Documents et formulaires, au-dessus de l'API de Grist de l'essai : `api`, `applyActions`, `records` et `waitFor`
// viennent de l'essai ; `widgetUrl` est l'adresse du widget servi par `serveWidget`.
export function docTools({ env, api, applyActions, records, waitFor, widgetUrl }) {
  const team = `${env.grist}/o/${env.team}`;
  const tableRef = async (doc, tableId) => (await records(doc, '_grist_Tables')).find(t => t.tableId === tableId).id;

  // Document avec le widget posé sur sa table Table1 (page « Synchro »). `access` : niveau déjà accordé au widget
  // ('none' : Grist demande l'accès complet, que le widget réclame).
  async function newDocWithWidget(name, setup, access = 'full') {
    const workspace = (await api('GET', `/orgs/${env.team}/workspaces`))[0].id;
    const doc = await api('POST', `/workspaces/${workspace}/docs`, { name });
    if (setup) await applyActions(doc, setup);
    const view = (await applyActions(doc, [['CreateViewSection', await tableRef(doc, 'Table1'), 0, 'record', null, null]])).retValues[0];
    await applyActions(doc, [
      ['UpdateRecord', '_grist_Views', view.viewRef, { name: 'Synchro' }],
      ['UpdateRecord', '_grist_Views_section', view.sectionRef, {
        parentKey: 'custom', options: JSON.stringify({ customView: JSON.stringify({ mode: 'url', url: widgetUrl, access, renderAfterReady: false }) }),
      }],
    ]);
    return { doc, url: `${team}/doc/${doc}/p/${view.viewRef}` };
  }

  const pageOf = async (doc, viewRef) => (await records(doc, '_grist_Pages')).find(p => p.viewRef === viewRef);
  const publishedForms = async doc => (await records(doc, '_grist_Views_section')).filter(sc => JSON.parse(sc.shareOptions || '{}').publish);
  // Clé de la page d'un formulaire (une par page partagée), lue dans la base du serveur de test ; Grist l'enregistre
  // juste après le partage.
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
  const formLink = async (doc, form) => `${team}/forms/${await formKey(doc, form)}/${form.id}`;
  return { tableRef, newDocWithWidget, pageOf, publishedForms, formKey, formLink };
}
