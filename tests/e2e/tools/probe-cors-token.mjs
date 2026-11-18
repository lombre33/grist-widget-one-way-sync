// Sonde : quelles réponses de Grist, à une requête du widget avec son jeton `?auth=`, n'ont PAS les en-têtes CORS ? Le navigateur
// les montre alors comme « NetworkError when attempting to fetch resource » / « Access-Control-Allow-Origin manquant » (retour d'une
// personne sur DINUM, 18 novembre 2026), sans le code d'état de la réponse : le widget ne peut pas le lire.
// Chaque essai est joué DANS le cadre du widget (une autre origine que Grist), comme le fait `gristFetch` : `credentials: 'omit'`.
// Résultat connu (Grist 1.7, 18 novembre 2026) : un jeton que Grist refuse (« Broken token », 401) n'a aucun en-tête CORS ; un refus de
// droits (403) en a. Voir la fin du résultat pour le détail.
// Usage : tests/e2e/start-grist.sh, puis `PORT=8588 node tests/e2e/tools/probe-cors-token.mjs`.
import assert from 'node:assert/strict';
import { createHarness, log } from '../harness.mjs';

const h = await createHarness({ port: Number(process.env.PORT || 8588) });
try {
  const src = await h.newDocWithWidget('Sonde CORS jeton');
  const view = await h.newView('sonde');
  await h.login(view);
  await view.open(src.url);
  const frame = view.page.frames().find(f => f.url().startsWith(`http://localhost:${process.env.PORT || 8588}`));
  await frame.waitForFunction(() => typeof grist !== 'undefined' && grist.docApi, null, { timeout: 60000 });
  const results = await frame.evaluate(async () => {
    const read = await grist.docApi.getAccessToken({ readOnly: true });
    const full = await grist.docApi.getAccessToken({ readOnly: false });
    const out = { shape: { tokenLength: full.token.length, dots: full.token.split('.').length - 1, baseUrl: full.baseUrl.replace(/\/docs\/.*/, '/docs/<doc>'), ttlMsec: full.ttlMsecs } };
    try { const payload = JSON.parse(atob(full.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); out.shape.claims = Object.keys(payload); } catch (e) { out.shape.claims = 'illisible'; }
    const docId = full.baseUrl.split('/docs/')[1];
    const origin = new URL(full.baseUrl).origin;
    const team = /\/o\/([^/]+)/.exec(full.baseUrl)[1];
    const altered = full.token.slice(0, -2) + (full.token.endsWith('aa') ? 'bb' : 'aa');
    const cases = {
      'jeton valide, GET /webhooks': { url: `${full.baseUrl}/webhooks?auth=${full.token}` },
      'jeton valide, POST (préalable CORS + corps JSON)': { url: `${full.baseUrl}/webhooks?auth=${full.token}`, method: 'POST', body: '{"webhooks":[]}' },
      'jeton valide en lecture seule, GET /webhooks': { url: `${read.baseUrl}/webhooks?auth=${read.token}` },
      'jeton altéré (fin changée), GET': { url: `${full.baseUrl}/webhooks?auth=${altered}` },
      'jeton altéré, POST (préalable)': { url: `${full.baseUrl}/webhooks?auth=${altered}`, method: 'POST', body: '{"webhooks":[]}' },
      'jeton tronqué, GET': { url: `${full.baseUrl}/webhooks?auth=${full.token.slice(0, 20)}` },
      'jeton vide, GET': { url: `${full.baseUrl}/webhooks?auth=` },
      'jeton valide, mauvaise équipe dans le chemin': { url: `${origin}/o/autre/api/docs/${docId}/webhooks?auth=${full.token}` },
      'jeton valide, sans équipe dans le chemin': { url: `${origin}/api/docs/${docId}/webhooks?auth=${full.token}` },
      'jeton valide, autre document': { url: `${origin}/o/${team}/api/docs/ZZZZZZZZZZZZZZZZZZZZZZ/webhooks?auth=${full.token}` },
      'jeton valide, route inconnue': { url: `${full.baseUrl}/nimporte?auth=${full.token}` },
      'sans jeton, GET': { url: `${full.baseUrl}/webhooks` },
    };
    for (const [name, { url, method = 'GET', body }] of Object.entries(cases)) {
      const headers = method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
      try {
        const response = await fetch(url, { method, headers, body, credentials: 'omit' });
        out[name] = `HTTP ${response.status} (CORS ok) ${(await response.text()).slice(0, 70).replace(/\s+/g, ' ')}`;
      } catch (e) {
        out[name] = `ÉCHEC ${e.name}: ${e.message}  <-- ce que verrait la personne`;
      }
    }
    return out;
  });
  for (const [name, value] of Object.entries(results)) log(`${name} : ${typeof value === 'string' ? value : JSON.stringify(value)}`);
} finally {
  await h.close();
}

// Ce que lit la personne quand Grist refuse le jeton : le widget, dont on altère le jeton avant l'envoi, montre un texte qui dit
// quelle requête a échoué et quoi faire, jamais le « NetworkError when attempting to fetch resource » du navigateur.
const broken = await createHarness({
  port: Number(process.env.PORT || 8588) + 1,
  patches: { '/js/grist.js': text => text.replace('auth=${encodeURIComponent(token)}', 'auth=${encodeURIComponent(token)}zz') },
});
try {
  const doc = await broken.newDocWithWidget('Sonde jeton refusé');
  const view = await broken.newView('refusé');
  await broken.login(view);
  await view.openTab(doc.url, 'Envoyer');
  await view.widget().getByText(/n’a pas répondu à la requête du widget/).waitFor({ timeout: 60000 });
  const said = await view.text();
  log(`Le widget dit : ${said.slice(said.indexOf('Grist n’a pas répondu'), said.indexOf('Grist n’a pas répondu') + 520)}`);
  assert.ok(/« GET \/webhooks »/.test(said.replace(/\s+/g, ' ')), 'la requête qui a échoué est nommée');
  assert.ok(!/NetworkError|Failed to fetch/.test(said), 'pas le texte brut du navigateur');
  assert.ok(!said.includes('auth='), 'aucun jeton ni adresse dans le texte');
  console.log('ATTENDU : jeton refusé dit clairement, requête nommée, sans jeton … OUI');
} finally {
  await broken.close();
}
