// Sonde : la table du journal de la CIBLE (`Journal_<export>`) est renommée à la main (retour d'un testeur, 19 novembre : « j'avais
// renommé la table du journal », puis la synchro ne se mettait plus à jour). Que montrent la CIBLE et la SOURCE, et que devient l'envoi ?
// Mode d'emploi : tests/e2e/start-grist.sh, puis  node tests/e2e/tools/probe-journal-renamed.mjs   (NEW=Autre_nom : le nouveau nom)
import { createHarness, log } from '../harness.mjs';

const NEW = process.env.NEW || 'Mon_journal';
const h = await createHarness({ port: 8763 });
try {
  const names = [['Anna', 'Lyon'], ['Bob', 'Paris'], ['Clara', 'Nantes']];
  const p = await h.pair({ name: 'Sonde renomme', table: 'Fiches', columns: [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], rows: 3, makeRow: i => ({ Nom: names[i % 3][0], Ville: names[i % 3][1] }), send: 'wait' });
  await p.dv.openTab(p.dst.url, 'Recevoir');
  await h.waitFor(async () => (await h.records(p.dst.doc, 'Fiches')).length >= 3, 'départ', 120000, 2000);
  log(`journal avant : ${p.journal}`);
  await h.applyActions(p.dst.doc, [['RenameTable', p.journal, NEW]]);
  const tables = async doc => (await h.records(doc, '_grist_Tables')).map(t => t.tableId).join(', ');
  log(`tables de la CIBLE après : ${await tables(p.dst.doc)}`);
  const shares = await h.records(p.dst.doc, '_grist_Shares');
  log(`partages : ${JSON.stringify(shares.map(s => ({ id: s.id, description: s.description })))}`);
  await p.dv.openTab(p.dst.url, 'Recevoir');
  await new Promise(r => setTimeout(r, 12000));
  log(`CIBLE, onglet Recevoir : ${(await p.dv.text()).slice(0, 1500)}`);
  await h.applyActions(p.src.doc, [['AddRecord', 'Fiches', null, { Nom: 'Denis', Ville: 'Lille' }]]);
  await new Promise(r => setTimeout(r, 45000));
  log(`lignes de Fiches (CIBLE) : ${(await h.records(p.dst.doc, 'Fiches')).map(r => r.Nom).join(', ')}`);
  log(`webhooks SOURCE : ${JSON.stringify((await h.webhooks(p.src.doc)).map(w => ({ id: w.id, usage: w.usage, fields: w.fields && { enabled: w.fields.enabled, url: String(w.fields.url).replace(/s\/[^/]+/, 's/<clé>') } })))}`);
  await p.sv.openTab(p.src.url, 'Envoyer');
  await new Promise(r => setTimeout(r, 12000));
  log(`SOURCE, onglet Envoyer : ${(await p.sv.text()).slice(0, 2000)}`);
  await p.dv.page.screenshot({ path: '/tmp/claude-0/-home-claude/7c947f78-5f02-5f15-8fce-ac7e25773250/scratchpad/renomme-cible.png' });
  await p.sv.page.screenshot({ path: '/tmp/claude-0/-home-claude/7c947f78-5f02-5f15-8fce-ac7e25773250/scratchpad/renomme-source.png' });
} finally {
  await h.close();
}
