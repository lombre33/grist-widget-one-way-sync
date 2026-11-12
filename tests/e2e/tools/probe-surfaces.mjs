// Sonde offensive : toutes les routes de lecture d'un document Grist, lues par quatre personnes qui ne devraient pas tout voir
// (visiteur du lien public sans identifiant, lecteur nommé, éditeur nommé, détenteur de la clé d'un formulaire), sur une
// SOURCE et une CIBLE branchées. Le rapport dit, pour chaque route, le statut et les secrets ou données qu'elle laisse lire.
// Les corps lisibles sont écrits dans OUT (par défaut /tmp/probe-surfaces) pour être relus à la main.
// Usage : tests/e2e/start-grist.sh, puis `node tests/e2e/tools/probe-surfaces.mjs` (STRICT=1 : sortie 1 s'il y a une fuite inconnue).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../harness.mjs';
import { startProbe } from './probe.mjs';

const OUT = process.env.OUT || '/tmp/probe-surfaces';
await mkdir(OUT, { recursive: true });
const { h, p } = await startProbe({ port: Number(process.env.PORT || 8754), name: 'Sonde surfaces', rows: 5 });
const { env, TEAM } = h;
// Une invitation en attente garde sa clé privée dans la note de la SOURCE jusqu'à l'approbation.
await p.sv.openTab(p.src.url, 'Envoyer');
await p.sv.button('Ajouter un destinataire').click();
await p.sv.dialogButton('Créer l’invitation').click();
await p.sv.dialog().getByText('Transmettez ce code').waitFor({ timeout: 60000 });
await p.sv.dialogButton('Plus tard').click();
await p.dv.openTab(p.dst.url, 'Recevoir'); // un propriétaire passe : les règles sont en place
await new Promise(r => setTimeout(r, 12000));

const VIEWER = 'lecteur@sync.local';
const EDITOR = 'editeur@sync.local';
for (const doc of [p.src.doc, p.dst.doc]) {
  await h.shareDoc(doc, 'everyone@getgrist.com', 'viewers');
  await h.shareDoc(doc, VIEWER, 'viewers');
  await h.shareDoc(doc, EDITOR, 'editors');
}
const viewerView = await h.userView('lecteur', VIEWER);
const editorView = await h.userView('editeur', EDITOR);
const hook = (await h.webhooks(p.src.doc))[0].fields.url;
const formKey = /\/api\/s\/([^/]+)\//.exec(hook)[1];

const get = {
  anonyme: async url => { const r = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } }); return { status: r.status, text: await r.text() }; },
  lecteur: async url => { const r = await viewerView.page.request.get(url); return { status: r.status(), text: await r.text() }; },
  editeur: async url => { const r = await editorView.page.request.get(url); return { status: r.status(), text: await r.text() }; },
};

const META = ['_grist_DocInfo', '_grist_Tables', '_grist_Tables_column', '_grist_Views', '_grist_Views_section', '_grist_Views_section_field', '_grist_Pages',
  '_grist_TabItems', '_grist_TabBar', '_grist_Triggers', '_grist_Shares', '_grist_ACLRules', '_grist_ACLResources', '_grist_Attachments', '_grist_Cells',
  '_grist_Filters', '_grist_Imports', '_grist_External_database', '_grist_External_table', '_grist_REPL_Hist'];
const routes = doc => [
  '', '/tables', '/tables/Contacts/columns', '/tables/Contacts/records', '/tables/Synchro/records', '/tables/Synchro/columns',
  `/tables/${p.journal}/records`, `/tables/${p.journal}/columns`, `/tables/${p.dest}/records`,
  '/sql?q=select+1', '/sql?q=select+*+from+Synchro', '/download', '/download/sqlite', '/download/csv?tableId=Synchro', '/download/csv?tableId=Contacts',
  '/download/xlsx', '/download/table-schema?tableId=Synchro', '/states', '/snapshots', '/webhooks', '/attachments', '/access', '/usersForViewing',
  '/timing', '/forks', '/properties', ...META.map(m => `/tables/${m}/records`), ...META.map(m => `/tables/${m}/columns`),
];

// Ce qu'on cherche. Les données de Contacts sont celles de `makeRow` ; le courriel est celui du propriétaire (et du destinataire).
const needles = (docKind) => ({
  'clé du formulaire': text => text.includes(formKey),
  'clé de signature': text => /"signature":\{"[0-9a-f]{16}":"[0-9a-f]{32}"/.test(text.replaceAll('\\"', '"')),
  'clé privée d’invitation': text => /\\"prive\\":\{\\"x\\"/.test(text) || /"prive":\{"x"/.test(text),
  'secret d’invitation': text => /\\"secret\\":\\"[0-9a-f]{32}\\"/.test(text) || /"secret":"[0-9a-f]{32}"/.test(text),
  'courriel': text => text.includes(env.email),
  'donnée de la table': text => /Nom[1-4]\b|personne[1-4]@exemple/.test(text),
  'note du widget (syncNote)': text => text.includes('syncNote'),
  'nom de l’export': text => text.includes('Annuaire'),
  'identifiant de l’autre document': text => text.includes((docKind === 'SOURCE' ? p.dst.doc : p.src.doc).slice(0, 12)),
});

const rows = [];
for (const [kind, doc] of [['SOURCE', p.src.doc], ['CIBLE', p.dst.doc]]) {
  for (const who of Object.keys(get)) {
    for (const route of routes(doc)) {
      const res = await get[who](`${TEAM}/api/docs/${doc}${route}`);
      const hits = Object.entries(needles(kind)).filter(([, test]) => test(res.text)).map(([name]) => name);
      rows.push({ kind, who, route, status: res.status, size: res.text.length, hits });
      if (res.status === 200 && res.text.length) await writeFile(join(OUT, `${kind}-${who}-${route.replace(/[^A-Za-z0-9_.-]+/g, '_')}.txt`), res.text);
    }
  }
}
// Le détenteur de la clé : les routes `/api/s/<clé>/...` (la clé d'écriture du formulaire, lisible par les propriétaires de la SOURCE).
const keyRoutes = ['', '/tables', '/tables/Journal/columns', `/tables/${p.journal}/columns`, `/tables/${p.journal}/records`, '/tables/Contacts/records',
  `/tables/${p.dest}/records`, '/tables/_grist_Tables/records', '/tables/_grist_Tables_column/records', '/tables/_grist_Triggers/records', '/tables/_grist_Shares/records',
  '/sql?q=select+1', '/download', '/states', '/webhooks', '/attachments', '/access', '/forms', '/docs'];
for (const route of keyRoutes) {
  const res = await get.anonyme(`${TEAM}/api/s/${formKey}${route}`);
  const hits = Object.entries(needles('CIBLE')).filter(([, test]) => test(res.text)).map(([name]) => name);
  rows.push({ kind: 'CIBLE', who: 'clé', route: `/s/<clé>${route}`, status: res.status, size: res.text.length, hits });
  if (res.status === 200 && res.text.length) await writeFile(join(OUT, `CIBLE-cle-${route.replace(/[^A-Za-z0-9_.-]+/g, '_')}.txt`), res.text);
}
for (const r of rows.filter(r => r.status === 200)) log(`${r.kind} ${r.who} ${r.route} : 200 (${r.size} o)${r.hits.length ? ` LIT : ${r.hits.join(', ')}` : ''}`);
log(`Refusées : ${rows.filter(r => r.status !== 200).length} routes sur ${rows.length}`);
await writeFile(join(OUT, 'matrice.json'), JSON.stringify(rows, null, 1));
await h.close();
process.exit(0);
