// Diagnostic : que reste-t-il dans la SOURCE quand la table Synchro est supprimée, ou cachée à tous ?
// (webhooks, déclencheurs, règles d'accès, lignes de métadonnées) : de quoi reconnaître « le widget était là ».
import { log, sleep } from '../harness.mjs';
import { startProbe } from './probe.mjs';
const { h, p } = await startProbe({ port: Number(process.env.PORT || 8752), name: 'Sonde Synchro' });
const { records, applyActions, webhooks } = h;
const dump = async (what) => {
  const hooks = await webhooks(p.src.doc);
  const trig = await records(p.src.doc, '_grist_Triggers');
  const res = await records(p.src.doc, '_grist_ACLResources');
  const rules = await records(p.src.doc, '_grist_ACLRules');
  const tabs = (await records(p.src.doc, '_grist_Tables')).map(t => t.tableId);
  log(`${what}: tables ${tabs.join(',')}`);
  log(`${what}: webhooks ${JSON.stringify(hooks.map(w => [w.usage && w.usage.status, w.fields.tableId, String(w.fields.memo).slice(0, 40)]))}`);
  log(`${what}: _grist_Triggers ${JSON.stringify(trig.map(t => [t.tableRef, String(t.condition).slice(0, 40)]))}`);
  log(`${what}: ACL ressources ${JSON.stringify(res.map(r => [r.tableId, r.colIds]))} règles ${rules.length} mémos ${JSON.stringify(rules.map(r => String(r.memo).slice(0, 40)))}`);
};
await dump('avant');
if (process.env.MODE === 'hide') {
  await applyActions(p.src.doc, [['AddRecord', '_grist_ACLResources', -1, { tableId: 'Synchro', colIds: '*' }]]);
}
await applyActions(p.src.doc, [['RemoveTable', 'Synchro']]);
await sleep(3000);
await dump('après RemoveTable');
await h.close();
process.exit(0);
