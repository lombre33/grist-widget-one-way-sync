// Sonde : la comparaison de Grist (`GET /compare`) et les requêtes `/sql` sont bloquées en route, comme sur DINUM le
// 18 novembre (403 sans en-tête CORS : le navigateur lève une TypeError, le widget ne reçoit aucun code). La CIBLE
// doit continuer à recopier ce qui change à la SOURCE (cellule vidée, ligne supprimée) à son rythme d'avant la
// comparaison (10 s tant que des lignes arrivent, puis une minute), et non toutes les 5 minutes : avant la correction
// (moteur 5.0.3), 221 s pour une cellule vidée et 301 s pour une ligne supprimée, mesurés ici.
// Mode d'emploi : tests/e2e/start-grist.sh, puis  node tests/e2e/tools/probe-compare-blocked.mjs
//   BLOCK=compare,sql (défaut) : les chemins que le faux réseau coupe ; LIMIT=150 : secondes permises à une recopie.
import assert from 'node:assert/strict';
import { createHarness, log } from '../harness.mjs';

const BLOCK = (process.env.BLOCK || 'compare,sql').split(',');
const LIMIT = Number(process.env.LIMIT || 150) * 1000;
const patch = text => text.replace('async request(method, path, { body, params, full = false, timeout } = {}) {',
  `async request(method, path, { body, params, full = false, timeout } = {}) {\n    if (${JSON.stringify(BLOCK)}.some(p => path === '/' + p)) throw new TypeError('NetworkError when attempting to fetch resource.');`);
assert.ok(patch('async request(method, path, { body, params, full = false, timeout } = {}) {') !== 'async request(method, path, { body, params, full = false, timeout } = {}) {', 'js/grist.js a changé : adapter le point d\'accroche de la sonde');

const h = await createHarness({ port: 8762, patches: { '/js/grist.js': patch } });
try {
  const names = [['Anna', 'Lyon'], ['Bob', 'Paris'], ['Clara', 'Nantes']];
  const p = await h.pair({ name: 'Sonde bloquee', table: 'Fiches', columns: [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], rows: 3, makeRow: i => ({ Nom: names[i % 3][0], Ville: names[i % 3][1] }), send: 'wait' });
  await p.dv.openTab(p.dst.url, 'Recevoir');
  const dst = async () => (await h.records(p.dst.doc, 'Fiches')).map(r => `${r.Nom}|${r.Ville}`).sort();
  await h.waitFor(async () => (await h.records(p.dst.doc, 'Fiches')).length >= 3, 'départ', 120000, 2000);
  log(`départ (bloqué : ${BLOCK.join(', ')}) : ${(await dst()).join(' ; ')}`);
  await new Promise(r => setTimeout(r, 90000)); // le widget reste ouvert, au repos plus d'une minute
  const idOf = async name => (await h.records(p.src.doc, 'Fiches')).find(r => r.Nom === name).id;
  const arrives = async (what, test) => {
    const start = Date.now();
    while (Date.now() - start < LIMIT) {
      if (await test()) { log(`OK  ${what} après ${Math.round((Date.now() - start) / 1000)} s`); return; }
      await new Promise(r => setTimeout(r, 5000));
    }
    assert.fail(`${what} : pas arrivé en ${LIMIT / 1000} s`);
  };

  await h.applyActions(p.src.doc, [['UpdateRecord', 'Fiches', await idOf('Bob'), { Ville: '' }]]);
  await arrives('cellule vidée (Bob)', async () => (await dst()).includes('Bob|'));
  await h.applyActions(p.src.doc, [['RemoveRecord', 'Fiches', await idOf('Clara')]]);
  await arrives('ligne supprimée (Clara)', async () => !(await dst()).some(row => row.startsWith('Clara|')));
  log(`fin : ${(await dst()).join(' ; ')}`);
} finally {
  await h.close();
}
