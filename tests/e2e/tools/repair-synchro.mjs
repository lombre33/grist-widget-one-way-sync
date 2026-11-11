// Diagnostic : lignes de Synchro supprimées, puis « Modifier » : que contient Synchro, que dit le webhook ?
import { log, sleep } from '../harness.mjs';
import { startProbe } from './probe.mjs';
const { h, p } = await startProbe({ port: Number(process.env.PORT || 8751), name: 'Réparation Synchro' });
const { records, count, applyActions, webhooks, waitFor } = h;
const dump = async (what) => {
  const rows = await records(p.src.doc, 'Synchro');
  log(`${what}: Synchro ${rows.length} lignes : ${rows.map(r => `${r.Synchro_Type}/${r.Synchro_Table}/${r.Synchro_Export.slice(0, 4)}`).join(' ')}`);
  log(`${what}: webhooks ${JSON.stringify((await webhooks(p.src.doc)).map(w => [w.usage.status, w.usage.numWaiting, w.usage.lastHttpStatus, w.fields.tableId]))}`);
};
await dump('avant');
await applyActions(p.src.doc, [['BulkRemoveRecord', 'Synchro', (await records(p.src.doc, 'Synchro')).map(r => r.id)]]);
await sleep(3000);
await dump('après suppression');
await p.sv.openTab(p.src.url, 'Envoyer');
await sleep(3000);
await h.editExport(p.sv, 'Contacts');
log(`étape : ${(await p.sv.dialog().innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
await p.sv.dialogButton('Enregistrer').click();
await p.sv.dialog().getByText(/Enregistré/).waitFor({ timeout: 120000 });
log(`dialogue : ${(await p.sv.dialog().innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
await p.sv.dialogButton('Fermer').click();
await sleep(5000);
await dump('après Modifier');
const [first] = await records(p.src.doc, 'Contacts');
await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', first.id, { Email: 'reparee@x.fr' }]]);
for (let i = 0; i < 3; i++) { await sleep(10000); log(`arrivée: ${await count(p.dst.doc, p.dest, `where "Email" = 'reparee@x.fr'`)} ; CIBLE ${await count(p.dst.doc, p.dest)} lignes`); }
await dump('fin');
await p.sv.openTab(p.src.url, 'Envoyer');
await sleep(4000);
log(`carte SOURCE : ${(await p.sv.text()).replace(/\s+/g, ' ').slice(0, 1200)}`);
await p.dv.open(p.dst.url);
await sleep(8000);
log(`carte CIBLE : ${(await p.dv.text()).replace(/\s+/g, ' ').slice(0, 1200)}`);
await h.close();
process.exit(0);
