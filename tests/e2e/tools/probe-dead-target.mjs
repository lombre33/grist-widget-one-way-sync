// Diagnostic : le document CIBLE est supprimé, puis la SOURCE est modifiée. Que fait la file de Grist, minute par
// minute, et que dit la carte SOURCE ? (Grist met-il l'envoi « en cours » sans jamais répondre ?)
import { log, sleep } from '../harness.mjs';
import { startProbe } from './probe.mjs';
const { h, p } = await startProbe({ port: Number(process.env.PORT || 8753), name: 'Sonde CIBLE morte' });
const { records, applyActions, webhooks } = h;
await h.request('DELETE', `/docs/${p.dst.doc}`);
const [first] = await records(p.src.doc, 'Contacts');
await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', first.id, { Email: 'sonde@x.fr' }]]);
const t0 = Date.now();
const usage = async () => JSON.stringify((await webhooks(p.src.doc)).map(w => { const u = w.usage || {}; return [u.status, u.numWaiting, u.lastHttpStatus, u.lastEventBatch && u.lastEventBatch.status, String(u.lastErrorMessage || '').slice(0, 60)]; }));
const card = async () => { await p.sv.openTab(p.src.url, 'Envoyer'); await sleep(5000); return (await p.sv.text()).replace(/\s+/g, ' ').slice(0, 900); };
for (let i = 0; i < Number(process.env.MINUTES || 7) * 3; i++) {
  log(`${Math.round((Date.now() - t0) / 1000)} s : ${await usage()}`);
  if (i % 6 === 5) log(`carte : ${await card()}`);
  await sleep(20000);
}
log(`carte finale : ${await card()}`);
await h.close();
process.exit(0);
