// Sonde des cas limites de protection : ce que lit un visiteur public (1) PENDANT que le widget n'a pas encore posé ses règles
// d'accès (fenêtre ouverte juste après la création d'un export), (2) quand Grist refuse de poser les règles (règle d'autrui qui
// vise une colonne absente), (3) ce que la clé d'un formulaire peut écrire, (4) ce qui reste dans le journal d'une ligne
// supprimée à la SOURCE, (5) l'adresse que Grist donne au widget (cadre), (6) une pièce jointe sans cellule.
// Usage : tests/e2e/start-grist.sh, puis `node tests/e2e/tools/probe-gaps.mjs`.
import { log } from '../harness.mjs';
import { columnsOf, makeRow } from '../data.mjs';
import { startProbe } from './probe.mjs';

const { h, p } = await startProbe({ port: Number(process.env.PORT || 8755), name: 'Sonde cas limites', rows: 5 });
const { env, TEAM } = h;
const want = n => !process.env.ONLY || process.env.ONLY.split(',').includes(String(n));
const anon = async (path, init = {}) => {
  const r = await fetch(`${TEAM}/api${path}`, { ...init, headers: { 'X-Requested-With': 'XMLHttpRequest', ...(init.headers || {}) } });
  return { status: r.status, text: await r.text() };
};

// (1) Fenêtre avant les règles : un document public, un export créé, la fenêtre « Export créé » encore ouverte.
if (want(1)) {
  const src = await h.newDocWithWidget('Cas limites SOURCE', []);
  await h.fillTable(src.doc, 'Contacts', columnsOf(8), 5, makeRow);
  await h.shareDoc(src.doc, 'everyone@getgrist.com', 'viewers');
  await h.applyActions(src.doc, [['AddRecord', '_grist_ACLResources', -1, { tableId: 'Contacts', colIds: 'Email' }],
    ['AddRecord', '_grist_ACLRules', null, { resource: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: 'Email caché aux lecteurs' }]]);
  const view = await h.newView('fenetre');
  await h.login(view);
  await view.open(src.url);
  const probe = async quand => {
    const rows = await anon(`/docs/${src.doc}/tables/Synchro/records`);
    const lot = rows.status === 200 ? JSON.parse(rows.text).records.filter(r => r.fields.Synchro_Type === 'lot').map(r => r.fields.Synchro_Lot) : [];
    const mail = /personne\d@exemple\.fr/.test(lot.join(''));
    const nRules = (await h.records(src.doc, '_grist_ACLRules')).length;
    log(`(1) ${quand} : règles ${nRules}, Synchro HTTP ${rows.status}, lignes ${rows.status === 200 ? JSON.parse(rows.text).records.length : '-'}, courriels de la colonne cachée dans le lot : ${mail ? 'OUI (fuite)' : 'non'}`);
  };
  await probe('avant tout');
  await h.createExport(view, 'Contacts', 'Fenetre'); // la fenêtre « Export créé » reste ouverte
  await probe('fenêtre « Export créé » ouverte');
  await new Promise(r => setTimeout(r, 15000));
  await probe('15 s plus tard, fenêtre toujours ouverte');
  await view.dialogButton('Fermer').click().catch(() => view.dialogButton('Plus tard').click().catch(() => {}));
  await new Promise(r => setTimeout(r, 6000));
  await probe('fenêtre fermée + 6 s');
  // L'export public (lien) n'est pas ici : seul le cas ordinaire.
}

// (2) Grist refuse de poser les règles : une règle d'autrui vise une colonne qui n'existe pas.
if (want(2)) {
  const src = await h.newDocWithWidget('Cas limites refus', []);
  await h.fillTable(src.doc, 'Contacts', columnsOf(4), 3, makeRow);
  await h.shareDoc(src.doc, 'everyone@getgrist.com', 'viewers');
  try {
    await h.applyActions(src.doc, [['AddRecord', '_grist_ACLResources', -1, { tableId: 'Contacts', colIds: 'Fantome' }],
      ['AddRecord', '_grist_ACLRules', null, { resource: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: 'colonne absente' }]]);
    log('(2) Grist accepte une règle sur une colonne absente');
  } catch (e) { log(`(2) Grist refuse une règle sur une colonne absente : ${e.message.slice(0, 160)}`); }
  try {
    await h.applyActions(src.doc, [['AddRecord', '_grist_ACLResources', -1, { tableId: 'Contacts', colIds: 'Nom' }],
      ['AddRecord', '_grist_ACLRules', null, { resource: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: 'ajout après' }]]);
    log('(2) un ajout de règle passe malgré la colonne absente');
  } catch (e) { log(`(2) un ajout de règle est refusé tant que la colonne absente est là : ${e.message.slice(0, 200)}`); }
}

// (3) La clé du formulaire : que peut-elle écrire ?
if (want(3)) {
  const hook = (await h.webhooks(p.src.doc))[0].fields.url;
  const key = /\/api\/s\/([^/]+)\//.exec(hook)[1];
  const post = (path, body) => anon(`/s/${key}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const attempts = [
    ['ligne du journal avec une colonne inconnue', `/tables/${p.journal}/records`, { records: [{ fields: { Inconnue: 'x' } }] }],
    ['ligne du journal avec Sync_Applique', `/tables/${p.journal}/records`, { records: [{ fields: { Sync_Applique: true } }] }],
    ['ligne dans Contacts (table reçue)', `/tables/${p.dest}/records`, { records: [{ fields: { Nom: 'forgé' } }] }],
    ['ligne dans une table de métadonnées', '/tables/_grist_Tables/records', { records: [{ fields: { tableId: 'X' } }] }],
    ['actions brutes (apply)', '/apply', [['UpdateRecord', p.dest, 1, { Nom: 'forgé' }]]],
    ['ajout sur le journal par /records?flat=1', `/tables/${p.journal}/records?flat=1`, [{ Synchro_Export: 'forgé' }]],
  ];
  for (const [what, path, body] of attempts) {
    const res = await post(path, body);
    log(`(3) clé : ${what} : HTTP ${res.status} ${res.text.slice(0, 110).replace(/\s+/g, ' ')}`);
  }
  const before = (await h.records(p.dst.doc, p.dest)).length;
  log(`(3) lignes de ${p.dest} après les essais : ${before} (5 avant)`);
}

// (4) Ligne supprimée à la SOURCE : que reste-t-il dans le journal de la CIBLE ?
if (want(4)) {
  await p.dv.openTab(p.dst.url, 'Recevoir');
  const rows = await h.records(p.src.doc, 'Contacts');
  const victim = rows.find(r => r.Nom === 'Nom4');
  await h.applyActions(p.src.doc, [['RemoveRecord', 'Contacts', victim.id]]);
  await h.waitFor(async () => (await h.count(p.dst.doc, p.dest)) === 4, 'suppression arrivée', 120000, 2000);
  await new Promise(r => setTimeout(r, 15000));
  const journal = await h.records(p.dst.doc, p.journal);
  const kept = journal.filter(r => JSON.stringify(r).includes('Nom4') || JSON.stringify(r).includes('personne4@exemple'));
  log(`(4) journal de la CIBLE après suppression de la ligne Nom4 à la SOURCE : ${journal.length} lignes, dont ${kept.length} gardent ses données`);
  for (const r of kept) log(`(4)   ligne ${r.id} : type ${r.Synchro_Type || 'version'}, état ${r.Sync_Etat || ''}, Supprime ${r.Supprime}`);
}

// (5) L'adresse du widget, vue par le serveur qui l'héberge.
if (want(5)) {
  const frames = p.sv.page.frames().filter(f => f.url().includes('index.html'));
  for (const f of frames) log(`(5) adresse du cadre du widget : ${f.url().replace(/(documentId|docId)=[^&]*/g, '$1=…')}`);
}

// (6) Une pièce jointe sans cellule : lisible par le lien public ?
if (want(6)) {
  const form = new FormData();
  form.append('upload', new Blob(['contenu confidentiel du fichier orphelin'], { type: 'text/plain' }), 'orphelin.txt');
  const up = await fetch(`${TEAM}/api/docs/${p.dst.doc}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${env.apiKey}` }, body: form });
  const ids = JSON.parse(await up.text());
  await h.shareDoc(p.dst.doc, 'everyone@getgrist.com', 'viewers');
  const res = await anon(`/docs/${p.dst.doc}/attachments/${ids[0]}/download`);
  log(`(6) pièce jointe orpheline (aucune cellule) lue sans identifiant : HTTP ${res.status} ${res.status === 200 ? '(LISIBLE)' : res.text.slice(0, 80)}`);
}

// (7) La clé du formulaire sur les métadonnées de Grist : lecture déjà vue ; écriture valide (renommer une table, ajouter une colonne).
if (want(7)) {
  const hook = (await h.webhooks(p.src.doc))[0].fields.url;
  const key = /\/api\/s\/([^/]+)\//.exec(hook)[1];
  const call = (method, path, body) => anon(`/s/${key}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const tables = (await h.records(p.dst.doc, '_grist_Tables'));
  const journalRow = tables.find(t => t.tableId === p.journal);
  const cols = (await h.records(p.dst.doc, '_grist_Tables_column'));
  const attempts = [
    ['renommer la table du journal (PATCH _grist_Tables)', 'PATCH', '/tables/_grist_Tables/records', { records: [{ id: journalRow.id, fields: { tableId: 'Pirate' } }] }],
    ['ajouter une colonne au journal (POST _grist_Tables_column)', 'POST', '/tables/_grist_Tables_column/records', { records: [{ fields: { parentId: journalRow.id, colId: 'Pirate', type: 'Text', label: 'Pirate' } }] }],
    ['changer la formule d\'une colonne (PATCH _grist_Tables_column)', 'PATCH', '/tables/_grist_Tables_column/records', { records: [{ id: cols.find(c => c.parentId === journalRow.id && c.colId === 'Synchro_Ids').id, fields: { description: 'pirate' } }] }],
    ['réécrire les réglages du document (PATCH _grist_DocInfo)', 'PATCH', '/tables/_grist_DocInfo/records', { records: [{ id: 1, fields: { documentSettings: '{"locale":"fr-FR"}' } }] }],
    ['ajouter une règle d\'accès (POST _grist_ACLRules)', 'POST', '/tables/_grist_ACLRules/records', { records: [{ fields: { permissionsText: '+R', aclFormula: 'True' } }] }],
    ['ajouter un déclencheur (POST _grist_Triggers)', 'POST', '/tables/_grist_Triggers/records', { records: [{ fields: { tableRef: journalRow.id, label: 'pirate' } }] }],
    ['PATCH d\'une ligne du journal existante', 'PATCH', `/tables/${p.journal}/records`, { records: [{ id: 15, fields: { Sync_Applique: true } }] }],
    ['supprimer une ligne du journal', 'POST', `/tables/${p.journal}/data/delete`, [15]],
    ['lire le journal par SQL', 'POST', '/sql', { sql: 'select 1' }],
  ];
  for (const [what, method, path, body] of attempts) {
    const res = await call(method, path, body);
    log(`(7) clé : ${what} : HTTP ${res.status} ${res.text.slice(0, 100).replace(/\s+/g, ' ')}`);
  }
  const after = (await h.records(p.dst.doc, '_grist_Tables')).map(t => t.tableId).join(',');
  log(`(7) tables de la CIBLE après les essais : ${after}`);
}

// (8) Une colonne effacée alors qu'une règle d'autrui la nomme : Grist refuse-t-il ensuite les règles du widget ?
if (want(8)) {
  const src = await h.newDocWithWidget('Cas limites colonne', []);
  await h.fillTable(src.doc, 'Contacts', columnsOf(4), 3, makeRow);
  await h.applyActions(src.doc, [['AddRecord', '_grist_ACLResources', -1, { tableId: 'Contacts', colIds: 'Prenom' }],
    ['AddRecord', '_grist_ACLRules', null, { resource: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: 'Prenom caché' }]]);
  const nb = async () => (await h.records(src.doc, '_grist_ACLRules')).length;
  log(`(8) règles avant : ${await nb()}`);
  try { await h.applyActions(src.doc, [['RemoveColumn', 'Contacts', 'Prenom']]); log('(8) colonne effacée'); } catch (e) { log(`(8) effacement refusé : ${e.message.slice(0, 160)}`); }
  log(`(8) règles après effacement : ${await nb()}`);
  try {
    await h.applyActions(src.doc, [['AddRecord', '_grist_ACLResources', -1, { tableId: 'Contacts', colIds: 'Nom' }],
      ['AddRecord', '_grist_ACLRules', null, { resource: -1, aclFormula: 'user.Access == VIEWER', permissionsText: '-R', memo: 'ajout' }]]);
    log('(8) ajout de règle accepté après effacement de la colonne');
  } catch (e) { log(`(8) ajout de règle REFUSÉ après effacement : ${e.message.slice(0, 200)}`); }
}

// (9) CIBLE : fenêtre entre la création du journal et la pose de la règle qui le cache, pendant l'assistant « Recevoir ».
if (want(9)) {
  const src = await h.newDocWithWidget('Fenetre cible SOURCE', []);
  await h.fillTable(src.doc, 'Contacts', columnsOf(4), 3, makeRow);
  const dst = await h.newDocWithWidget('Fenetre cible CIBLE', []);
  await h.shareDoc(dst.doc, 'everyone@getgrist.com', 'viewers');
  const sv = await h.newView('s9');
  await h.login(sv);
  await sv.open(src.url);
  await h.createExport(sv, 'Contacts', 'Annuaire');
  const code = await h.invite(sv);
  const dv = await h.newView('d9');
  await h.login(dv);
  const t0 = Date.now();
  let last = '';
  let running = true;
  const poll = (async () => {
    while (running) {
      const res = await anon(`/docs/${dst.doc}/tables/_grist_Tables_column/records`);
      const seen = [/\\"secret\\":\\"[0-9a-f]{32}\\"|"secret":"[0-9a-f]{32}"/.test(res.text) ? 'secret lisible' : 'secret caché', res.status === 200 ? '' : `HTTP ${res.status}`].filter(Boolean).join(', ');
      const rules = (await h.records(dst.doc, '_grist_ACLRules')).length;
      const line = `${seen}, règles ${rules}`;
      if (line !== last) { log(`(9) +${((Date.now() - t0) / 1000).toFixed(1)} s : ${line}`); last = line; }
      await new Promise(r => setTimeout(r, 250));
    }
  })();
  await h.accept(dv, dst, code, { exportName: 'Annuaire', table: 'Contacts' });
  await new Promise(r => setTimeout(r, 5000));
  running = false;
  await poll;
}
await h.close();
process.exit(0);
