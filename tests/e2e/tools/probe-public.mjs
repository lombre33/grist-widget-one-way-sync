// Sonde : que voit un visiteur du lien public (lecture seule, sans identifiant) sur une SOURCE et une CIBLE branchées ?
// Les deux documents sont rendus publics, puis lus en anonyme : tables, lignes, descriptions de colonnes, tables de
// métadonnées de Grist (`_grist_*`). Le rapport dit ce qui est caché et ce qui fuit (clé de signature, clé privée
// d'une invitation en attente, secret, courriel, clé du formulaire). Fait le 12 novembre (Grist 1.7.22) : les lignes
// des tables techniques sont cachées, mais leurs notes (descriptions de colonnes) se lisent dans `_grist_Tables_column`,
// car Grist n'y vide pas `description` pour une colonne qu'un lecteur ne peut pas lire.
// Usage : tests/e2e/start-grist.sh, puis `node tests/e2e/tools/probe-public.mjs` (STRICT=1 : code de sortie 1 s'il y a une fuite).
import { log } from '../harness.mjs';
import { startProbe } from './probe.mjs';

const { h, p } = await startProbe({ port: Number(process.env.PORT || 8753), name: 'Sonde publique', rows: 5 });
const { env, TEAM } = h;
// Une invitation en attente garde sa clé privée dans la note de la SOURCE jusqu'à l'approbation.
await p.sv.openTab(p.src.url, 'Envoyer');
await p.sv.button('Ajouter un destinataire').click();
await p.sv.dialogButton('Créer l’invitation').click();
await p.sv.dialog().getByText('Transmettez ce code').waitFor({ timeout: 60000 });
await p.sv.dialogButton('Plus tard').click();
await p.dv.openTab(p.dst.url, 'Recevoir'); // un propriétaire passe : les règles sont en place
await new Promise(r => setTimeout(r, 12000));

for (const doc of [p.src.doc, p.dst.doc]) await h.shareDoc(doc, 'everyone@getgrist.com', 'viewers');
const anon = async path => {
  const res = await fetch(`${TEAM}/api${path}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* binaire ou texte */ }
  return { status: res.status, json, text };
};
const META = ['_grist_Tables', '_grist_Tables_column', '_grist_Triggers', '_grist_ACLRules', '_grist_ACLResources', '_grist_Shares', '_grist_Views_section', '_grist_Pages'];

// Ce qu'on cherche : la clé d'écriture du formulaire (dans l'adresse du webhook, que seul un propriétaire lit), la clé de
// signature (description de `id_sync` dans la CIBLE), la clé privée et le secret d'une invitation, le courriel du propriétaire.
const hook = (await h.webhooks(p.src.doc))[0].fields.url;
const formKey = /\/api\/s\/([^/]+)\//.exec(hook)[1];
const leaks = [];
for (const [label, doc] of [['SOURCE', p.src.doc], ['CIBLE', p.dst.doc]]) {
  const tables = (await anon(`/docs/${doc}/tables`)).json.tables.map(t => t.id);
  log(`${label} : tables listées au visiteur : ${tables.join(', ')}`);
  for (const t of ['Synchro', p.journal]) {
    const rows = await anon(`/docs/${doc}/tables/${t}/records`);
    log(`${label} : lignes de ${t} : HTTP ${rows.status}${rows.status === 200 ? ' (LISIBLES)' : ''}`);
    if (rows.status === 200) leaks.push(`${label} : lignes de ${t} lisibles`);
  }
  log(`${label} : SQL : HTTP ${(await anon(`/docs/${doc}/sql?q=select+1`)).status}, téléchargement SQLite : HTTP ${(await anon(`/docs/${doc}/download`)).status}`);
  let all = '';
  for (const meta of META) {
    const res = await anon(`/docs/${doc}/tables/${meta}/records`);
    const n = res.json && res.json.records ? res.json.records.length : 0;
    log(`${label} : ${meta} : HTTP ${res.status}, ${n} lignes`);
    all += res.text;
  }
  const columns = await anon(`/docs/${doc}/tables/Contacts/columns`);
  all += columns.text;
  const found = {
    'clé du formulaire': all.includes(formKey),
    'clé de signature': /"signature":\{"[0-9a-f]{16}":"[0-9a-f]{32}"/.test(all.replaceAll('\\"', '"')),
    'clé privée d’une invitation en attente': /\\"prive\\":\{\\"x\\"/.test(all),
    'secret d’invitation': /\\"secret\\":\\"[0-9a-f]{32}\\"/.test(all),
    'courriel du propriétaire': all.includes(env.email),
  };
  for (const [what, yes] of Object.entries(found)) {
    log(`${label} : ${what} : ${yes ? 'LISIBLE' : 'caché'}`);
    if (yes) leaks.push(`${label} : ${what}`);
  }
}
log(leaks.length ? `Lisible par le lien public (${leaks.length}) : ${leaks.join(' ; ')}` : 'Rien de sensible lisible par le lien public');
await h.close();
process.exit(process.env.STRICT && leaks.length ? 1 : 0);
