// Sonde : dans quel ordre les lignes arrivent-elles dans la CIBLE ? Antoine, 18 novembre : la SOURCE montre Bob, Alice,
// Henri IV, Jacques (lignes 1 à 4) et la CIBLE Jacques, Henri IV, Alice, Bob. Le lot de la SOURCE range ses lignes de la
// plus récente à la plus ancienne (pour qu'un lot coupé garde les dernières) et la recopie les ajoutait dans cet ordre.
// Cette sonde crée une SOURCE dont les lignes naissent l'une après l'autre (comme à la main), envoie l'existant, puis
// ajoute des lignes une à une et par paquet, et compare l'ordre de la CIBLE (`manualSort`) à celui de la SOURCE.
// Mode d'emploi : tests/e2e/start-grist.sh, puis  node tests/e2e/tools/probe-row-order.mjs
//   AVANT=1 : ne fait pas échouer la sonde (pour mesurer le défaut sur le code d'avant le correctif).
//   MIXED=1 : la SOURCE a une ligne retouchée après coup et une ligne glissée en tête (l'ordre de la table n'est plus celui des dates).
import assert from 'node:assert/strict';
import { createHarness, log, sleep } from '../harness.mjs';

const MEASURE = Boolean(process.env.AVANT);
const MIXED = Boolean(process.env.MIXED);
const names = ['Bob', 'Alice', 'Henri IV', 'Jacques', 'Clara', 'Denis'];
const h = await createHarness({ port: 8764 });
try {
  const order = async (doc, table = 'Contacts') => (await h.sql(doc, `select Prenom from "${table}" order by manualSort, id`)).map(r => r.Prenom);
  const p = await h.pair({
    name: 'Sonde ordre', table: 'Contacts', send: 'wait',
    beforeExport: async ({ src }) => {
      await h.applyActions(src.doc, [['AddTable', 'Contacts', [{ id: 'Prenom', type: 'Text' }, { id: 'Nom', type: 'Text' }]]]);
      for (const name of names.slice(0, 4)) { // des lignes qui naissent l'une après l'autre, comme à la main
        await h.applyActions(src.doc, [['AddRecord', 'Contacts', null, { Prenom: name, Nom: 'N' }]]);
        await sleep(1200);
      }
      if (MIXED) { // MIXED=1 : une ligne retouchée après coup (sa date de MajLe est la plus récente) et une ligne glissée en tête
        await h.applyActions(src.doc, [['UpdateRecord', 'Contacts', 1, { Nom: 'Retouchee' }]]);
        await sleep(1200);
        await h.applyActions(src.doc, [['UpdateRecord', 'Contacts', 4, { manualSort: 0.5 }]]);
      }
    },
  });
  await p.dv.openTab(p.dst.url, 'Recevoir');
  const same = async (what, wanted) => {
    const end = Date.now() + 90000;
    let got = [];
    while (Date.now() < end) {
      got = await order(p.dst.doc);
      if (got.length >= wanted.length) break;
      await sleep(3000);
    }
    const src = await order(p.src.doc);
    log(`${what}\n    SOURCE : ${src.join(', ')}\n    CIBLE  : ${got.join(', ')}`);
    if (!MEASURE) assert.deepEqual(got, src, `${what} : l'ordre de la CIBLE n'est pas celui de la SOURCE`);
  };

  await same('envoi de l\'existant (4 lignes nées une à une)', names.slice(0, 4));

  await h.applyActions(p.src.doc, [['AddRecord', 'Contacts', null, { Prenom: names[4], Nom: 'N' }]]);
  await same('une ligne de plus', names.slice(0, 5));

  await h.applyActions(p.src.doc, [['BulkAddRecord', 'Contacts', [null, null, null], { Prenom: ['Eva', 'Fred', 'Gina'], Nom: ['N', 'N', 'N'] }]]);
  await same('trois lignes ajoutées d\'un coup', [...names.slice(0, 5), 'Eva', 'Fred', 'Gina']);

  // Lignes ajoutées une à une, rapidement : un lot qui porte plusieurs versions.
  for (const name of ['Hugo', 'Iris', 'Jules']) await h.applyActions(p.src.doc, [['AddRecord', 'Contacts', null, { Prenom: name, Nom: 'N' }]]);
  await same('trois lignes ajoutées coup sur coup', [...names.slice(0, 5), 'Eva', 'Fred', 'Gina', 'Hugo', 'Iris', 'Jules']);
  if (MIXED) { // une ligne insérée entre la première et la deuxième de la SOURCE (« Insérer une ligne ») : elle arrive à la fin chez la CIBLE
    await h.applyActions(p.src.doc, [['AddRecord', 'Contacts', null, { Prenom: 'Inseree', Nom: 'N', manualSort: 1.5 }]]);
    await same('une ligne insérée au milieu de la SOURCE', [...names.slice(0, 5), 'Eva', 'Fred', 'Gina', 'Hugo', 'Iris', 'Jules', 'Inseree']);
  }
  log('OK');
} finally {
  await h.close();
}
