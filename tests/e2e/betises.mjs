// « L'humain qui clique partout » : des bêtises qu'une personne peut faire dans Grist sur les documents SOURCE et
// CIBLE d'une synchro qui marche (colonnes ou tables supprimées, renommées, retypées, tables du widget bricolées,
// règles d'accès, droits d'éditeur ou de lecteur, données modifiées en pleine rafale). Pour chacune, le scénario
// fait une modification dans la SOURCE et note : arrive-t-elle chez le destinataire, que disent les cartes du
// widget (ce que lit la personne), la file de Grist est-elle bloquée, le widget a-t-il écrit des erreurs en console.
// Rien n'est affirmé ici : c'est un relevé, à lire ligne à ligne ; ce qui est corrigé dans le code l'est avec un
// test d'unité ou d'intégration à part.
// Usage : PORT=8700 node tests/e2e/betises.mjs                (tout)
//         PORT=8701 ONLY=colonneSupprimee,tableRenommee node tests/e2e/betises.mjs
import { mkdir } from 'node:fs/promises';
import { createHarness, log, sleep } from './harness.mjs';
import { columnsOf, makeRow } from './data.mjs';

const h = await createHarness({ port: Number(process.env.PORT || 8700) });
const { records, count, applyActions, webhooks, waitFor, api } = h;

const flat = text => String(text || '').replace(/\s+/g, ' ');
const rowsOf = 30;

// Page du widget d'un document : texte de l'onglet demandé, ou ce que la page montre si le widget ne démarre pas.
// SHOTS=<dossier> : une capture de la page (le widget dans Grist) pour chaque carte relevée, nommée `<shot>.png`.
async function read(view, url, tab, shot = '') {
  try {
    await view.open(url);
    if (tab) await view.widget().getByRole('tab', { name: tab }).click({ timeout: 10000 });
    await sleep(tab ? 6000 : 12000);
    if (process.env.SHOTS && shot) {
      await mkdir(process.env.SHOTS, { recursive: true });
      await view.page.setViewportSize({ width: 1100, height: 900 });
      await sleep(500);
      await view.page.screenshot({ path: `${process.env.SHOTS}/${shot}.png` });
    }
    return flat(await view.text()).replace(/^Synchro Envoyer Recevoir Tutoriel/, '').trim().slice(0, 1100);
  } catch (e) {
    const body = flat(await view.page.locator('body').innerText().catch(() => ''));
    return `[le widget ne s'affiche pas : ${e.message.split('\n')[0]}] page : ${body.slice(0, 300)}`;
  }
}

const queue = async (doc) => {
  try {
    return (await webhooks(doc)).map(w => `${w.usage.status}/${w.usage.numWaiting}/${w.usage.lastHttpStatus ?? '-'}`).join(' ');
  } catch (e) {
    return `(illisible : ${e.message.slice(0, 80)})`;
  }
};

// Règle d'accès sur une table (ou des colonnes) : refus de lecture à tous, propriétaires compris.
async function deny(doc, { tableId, colIds = '*' }, formula = 'True', permissions = '-R') {
  // Le widget a déjà ses règles sur Synchro : la ressource existe, la règle de la bêtise se range avant les siennes.
  const known = (await records(doc, '_grist_ACLResources')).find(r => r.tableId === tableId && r.colIds === colIds);
  const resource = known ? known.id : (await applyActions(doc, [['AddRecord', '_grist_ACLResources', null, { tableId, colIds }]])).retValues[0];
  await applyActions(doc, [['AddRecord', '_grist_ACLRules', null, { resource, aclFormula: formula, permissionsText: permissions, rulePos: known ? 0.5 : 1, memo: '' }]]);
}

const tableIdOf = async (doc, prefix) => (await records(doc, '_grist_Tables')).map(t => t.tableId).find(id => id.startsWith(prefix));

// La personne suit le conseil de la carte : « Réparer les clés », puis elle modifie une ligne.
async function repairKeys(p) {
  await p.sv.open(p.src.url);
  await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
  await p.sv.button('Réparer les clés').click();
  await p.sv.dialogButton('Réparer les clés').click();
  await p.sv.dialog().waitFor({ state: 'detached', timeout: 120000 }).catch(() => {});
  await sleep(5000);
  const columns = (await records(p.src.doc, '_grist_Tables_column')).map(c => c.colId);
  const [first] = await records(p.src.doc, 'Contacts');
  await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', first.id, { Email: 'reparee@x.fr' }]]);
  const t0 = Date.now();
  const ok = await waitFor(async () => (await count(p.dst.doc, p.dest, `where "Email" = 'reparee@x.fr'`)) >= 1, 'arrivée après réparation', 90000, 3000).then(() => true, () => false);
  await sleep(20000);
  const card = flat(await p.dv.text().catch(() => '')).slice(0, 500);
  return `après « Réparer les clés » : colonnes id_sync/MajLe présentes ${columns.includes('id_sync')}/${columns.includes('MajLe')} ; modification ${ok ? `arrivée en ${Math.round((Date.now() - t0) / 1000)} s` : 'NON arrivée (90 s)'} ; CIBLE ${await count(p.dst.doc, p.dest)} lignes ; carte CIBLE : ${card}`;
}

// Chaque cas : `act(p)` fait la bêtise ; `side` dit où l'on regarde en premier (les deux cartes sont lues de toute façon).
const cases = {
  colonneSupprimee: { note: 'colonne exportée supprimée dans la SOURCE', act: p => applyActions(p.src.doc, [['RemoveColumn', 'Contacts', 'Prenom']]) },
  colonneRenommee: { note: 'colonne exportée renommée dans la SOURCE', act: p => applyActions(p.src.doc, [['RenameColumn', 'Contacts', 'Ville', 'Commune']]) },
  tableRenommee: { note: 'table exportée renommée dans la SOURCE', act: p => applyActions(p.src.doc, [['RenameTable', 'Contacts', 'Personnes']]), probeTable: 'Personnes' },
  tableSupprimee: { note: 'table exportée supprimée dans la SOURCE', act: p => applyActions(p.src.doc, [['RemoveTable', 'Contacts']]), probe: false },
  cleSupprimee: { note: 'colonne id_sync supprimée dans la SOURCE', act: p => applyActions(p.src.doc, [['RemoveColumn', 'Contacts', 'id_sync']]), after: repairKeys },
  majleSupprimee: { note: 'colonne MajLe supprimée dans la SOURCE', act: p => applyActions(p.src.doc, [['RemoveColumn', 'Contacts', 'MajLe']]), after: repairKeys },
  typeChange: { note: 'type d\'une colonne exportée changé (Texte vers Entier) dans la SOURCE', act: p => applyActions(p.src.doc, [['ModifyColumn', 'Contacts', 'Quantite', { type: 'Text' }], ['ModifyColumn', 'Contacts', 'Nom', { type: 'Int' }]]) },
  toutSupprimer: { note: 'toutes les lignes de la table exportée supprimées dans la SOURCE (vague de suppressions)', act: async p => { await applyActions(p.src.doc, [['BulkRemoveRecord', 'Contacts', (await records(p.src.doc, 'Contacts')).map(r => r.id)]]); }, probe: false },
  lignesEnDouble: { note: 'dix lignes dupliquées avec leur clé dans la SOURCE', act: async p => { const rows = (await records(p.src.doc, 'Contacts')).slice(0, 10); await applyActions(p.src.doc, [['BulkAddRecord', 'Contacts', rows.map(() => null), Object.fromEntries(columnsOf(8).map(c => [c.id, rows.map(r => r[c.id])]).concat([['id_sync', rows.map(r => r.id_sync)]]))]]); }, probe: false },
  synchroLignesSupprimees: {
    note: 'lignes de la table Synchro supprimées',
    act: async p => { await applyActions(p.src.doc, [['BulkRemoveRecord', 'Synchro', (await records(p.src.doc, 'Synchro')).map(r => r.id)]]); },
    // La personne suit le conseil de la carte : « Modifier », elle recoche la table et enregistre.
    after: async (p) => {
      await p.sv.open(p.src.url);
      await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
      await p.sv.button('Modifier').click();
      await p.sv.dialog().getByRole('checkbox', { name: 'Contacts' }).check();
      await p.sv.dialogButton('Continuer').click();
      await p.sv.dialogButton('Continuer').click();
      await p.sv.dialogButton('Enregistrer').click();
      await p.sv.dialog().getByText(/Enregistré/).waitFor({ timeout: 120000 });
      await p.sv.dialogButton('Fermer').click();
      const [first] = await records(p.src.doc, 'Contacts');
      await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', first.id, { Email: 'reparee@x.fr' }]]);
      const t0 = Date.now();
      const ok = await waitFor(async () => (await count(p.dst.doc, p.dest, `where "Email" = 'reparee@x.fr'`)) === 1, 'arrivée après réparation', 90000, 3000).then(() => true, () => false);
      return `après « Modifier » : modification ${ok ? `arrivée en ${Math.round((Date.now() - t0) / 1000)} s` : 'NON arrivée (90 s)'} ; CIBLE ${await count(p.dst.doc, p.dest)} lignes`;
    },
  },
  synchroSupprimee: {
    note: 'table Synchro supprimée', act: p => applyActions(p.src.doc, [['RemoveTable', 'Synchro']]), probe: false,
    expect: /La table Synchro a été supprimée/, after: removeOldHooks,
  },
  synchroRenommee: {
    note: 'table Synchro renommée', act: p => applyActions(p.src.doc, [['RenameTable', 'Synchro', 'Ma_table']]), probe: false,
    expect: /La table Synchro a été renommée.*« Ma_table »/s,
  },
  synchroColonneSupprimee: { note: 'colonne Synchro_Lot supprimée', act: p => applyActions(p.src.doc, [['RemoveColumn', 'Synchro', 'Synchro_Lot']]) },
  synchroFormuleRetouchee: { note: 'formule de Synchro_Lot remplacée par du texte', act: p => applyActions(p.src.doc, [['ModifyColumn', 'Synchro', 'Synchro_Lot', { formula: '"oups"', isFormula: true }]]) },
  synchroValeurEcrite: { note: 'Synchro_Export modifié à la main sur une ligne', act: async p => { const [r] = (await records(p.src.doc, 'Synchro')).filter(x => x.Synchro_Type === 'lot'); await applyActions(p.src.doc, [['UpdateRecord', 'Synchro', r.id, { Synchro_Export: 'bidule' }]]); } },
  webhookSupprime: { note: 'webhook supprimé à la main dans les réglages de Grist', act: async p => { const [w] = await webhooks(p.src.doc); await api('DELETE', `/docs/${p.src.doc}/webhooks/${w.id}`); }, expectArrive: false },
  webhookDesactive: { note: 'webhook désactivé à la main dans les réglages de Grist', act: async p => { const [w] = await webhooks(p.src.doc); await api('PATCH', `/docs/${p.src.doc}/webhooks/${w.id}`, { enabled: false }); }, expectArrive: false },
  webhookAdresse: { note: 'adresse du webhook changée à la main (clé inconnue)', act: async p => { const [w] = await webhooks(p.src.doc); await api('PATCH', `/docs/${p.src.doc}/webhooks/${w.id}`, { url: w.fields.url.replace(/\/api\/s\/[^/]+/, '/api/s/cleinconnue') }); } },
  webhookAutreTable: { note: 'table du webhook changée à la main', act: async p => { const [w] = await webhooks(p.src.doc); await api('PATCH', `/docs/${p.src.doc}/webhooks/${w.id}`, { tableId: 'Contacts' }); } },
  regleColonne: { note: 'règle d\'accès : colonne Prenom illisible pour tous', act: p => deny(p.src.doc, { tableId: 'Contacts', colIds: 'Prenom' }) },
  regleLignes: { note: 'règle d\'accès : lignes de Lyon illisibles pour tous', act: p => deny(p.src.doc, { tableId: 'Contacts' }, 'rec.Ville == "Lyon"') },
  regleSynchro: { note: 'règle d\'accès : table Synchro illisible pour tous', act: p => deny(p.src.doc, { tableId: 'Synchro' }), probe: false, expect: /La table Synchro n’est plus lisible par le widget/ },
  regleSourceEcriture: { note: 'règle d\'accès : table Contacts en lecture seule pour tous (le widget n\'écrit plus dedans)', act: p => deny(p.src.doc, { tableId: 'Contacts' }, 'True', '-U-C-D') },
  regleSynchroEcriture: { note: 'règle d\'accès : table Synchro en écriture interdite pour tous', act: p => deny(p.src.doc, { tableId: 'Synchro' }, 'True', '-U-C-D') },
  journalColonneSupprimee: { note: 'CIBLE : colonne Sync_Recu supprimée du journal', side: 'dst', act: async p => { await applyActions(p.dst.doc, [['RemoveColumn', p.journal, 'Sync_Recu']]); } },
  journalColonneDonnee: { note: 'CIBLE : colonne de données (Ville) supprimée du journal', side: 'dst', act: async p => { await applyActions(p.dst.doc, [['RemoveColumn', p.journal, 'Ville']]); } },
  journalSupprime: { note: 'CIBLE : table journal supprimée', side: 'dst', act: p => applyActions(p.dst.doc, [['RemoveTable', p.journal]]) },
  journalVide: { note: 'CIBLE : toutes les lignes du journal supprimées', side: 'dst', act: async p => { await applyActions(p.dst.doc, [['BulkRemoveRecord', p.journal, (await records(p.dst.doc, p.journal)).map(r => r.id)]]); } },
  destinationLignesSupprimees: { note: 'CIBLE : toutes les lignes de la table reçue supprimées', side: 'dst', act: async p => { await applyActions(p.dst.doc, [['BulkRemoveRecord', p.dest, (await records(p.dst.doc, p.dest)).map(r => r.id)]]); } },
  destinationColonneSupprimee: { note: 'CIBLE : colonne Ville de la table reçue supprimée', side: 'dst', act: p => applyActions(p.dst.doc, [['RemoveColumn', p.dest, 'Ville']]) },
  destinationCleSupprimee: { note: 'CIBLE : colonne id_sync de la table reçue supprimée', side: 'dst', act: p => applyActions(p.dst.doc, [['RemoveColumn', p.dest, 'id_sync']]) },
  destinationSupprimee: { note: 'CIBLE : table reçue supprimée', side: 'dst', act: p => applyActions(p.dst.doc, [['RemoveTable', p.dest]]) },
  destinationRenommee: { note: 'CIBLE : table reçue renommée', side: 'dst', act: p => applyActions(p.dst.doc, [['RenameTable', p.dest, 'Autre_nom']]), dest: 'Autre_nom' },
  destinationTypeChange: { note: 'CIBLE : colonne Email de la table reçue passée en Entier', side: 'dst', act: p => applyActions(p.dst.doc, [['ModifyColumn', p.dest, 'Email', { type: 'Int' }]]) },
  formulaireDepublie: { note: 'CIBLE : formulaire dépublié', side: 'dst', act: async p => { const [f] = await h.publishedForms(p.dst.doc); await applyActions(p.dst.doc, [['UpdateRecord', '_grist_Views_section', f.id, { shareOptions: JSON.stringify({ ...JSON.parse(f.shareOptions), publish: false }) }]]); } },
  formulaireSupprime: { note: 'CIBLE : page du formulaire supprimée', side: 'dst', act: async p => { const [f] = await h.publishedForms(p.dst.doc); await applyActions(p.dst.doc, [['BulkRemoveRecord', '_grist_Pages', [(await records(p.dst.doc, '_grist_Pages')).find(pg => pg.viewRef === f.parentId).id]]]); } },
  regleJournalCible: { note: 'CIBLE : règle d\'accès : journal illisible pour tous', side: 'dst', act: p => deny(p.dst.doc, { tableId: p.journal }) },
  regleDestinationCible: { note: 'CIBLE : règle d\'accès : table reçue en écriture interdite pour tous', side: 'dst', act: p => deny(p.dst.doc, { tableId: p.dest }, 'True', '-U-C-D') },
  documentCibleSupprime: { note: 'CIBLE : document supprimé', side: 'dst', act: p => h.request('DELETE', `/docs/${p.dst.doc}`) },
};

// Les cas qui font intervenir une autre personne.
const people = {
  editeurSource: { note: 'SOURCE : une personne éditrice (non propriétaire) ouvre le widget', doc: 'src', access: 'editors', first: /Vous n’êtes pas propriétaire de ce document/ },
  lecteurSource: { note: 'SOURCE : une personne lectrice ouvre le widget', doc: 'src', access: 'viewers', first: /Vous n’êtes pas propriétaire de ce document/ },
  editeurCible: { note: 'CIBLE : une personne éditrice (non propriétaire) ouvre le widget', doc: 'dst', access: 'editors' },
  lecteurCible: { note: 'CIBLE : une personne lectrice ouvre le widget', doc: 'dst', access: 'viewers' },
};

// « Retirer les anciens webhooks » (Synchro supprimée) : la carte propose le bouton, la confirmation, et plus rien ne reste.
async function removeOldHooks(p) {
  await p.sv.open(p.src.url);
  await p.sv.widget().getByRole('tab', { name: 'Envoyer' }).click();
  await p.sv.button('Retirer les anciens webhooks').click();
  await p.sv.dialogButton('Retirer les anciens webhooks').click();
  await p.sv.widget().getByText(/ancien webhook retiré/).waitFor({ timeout: 30000 });
  const left = (await webhooks(p.src.doc)).length;
  const card = flat(await p.sv.text());
  return `après « Retirer les anciens webhooks » : ${left} webhook restant ; carte : ${card.slice(0, 500)}`;
}

async function fresh(name) {
  const p = await h.pair({ name: `Bétise ${name}`, table: 'Contacts', columns: columnsOf(8), rows: rowsOf, makeRow, send: 'wait' });
  await waitFor(async () => (await count(p.dst.doc, p.dest)) === rowsOf, 'départ', 90000, 2000);
  return p;
}

async function runCase(name, spec) {
  const p = await fresh(name);
  const problems0 = h.problems.length;
  const dest = spec.dest || p.dest;
  let acted = 'ok';
  try { await spec.act(p); } catch (e) { acted = `refusé par Grist : ${e.message.split('\n')[0].slice(0, 200)}`; }
  await sleep(3000);
  // La modification qui doit arriver (sauf si le cas la rend impossible).
  let arrived = null;
  if (spec.probe !== false) {
    const table = spec.probeTable || 'Contacts';
    try {
      const [first] = await records(p.src.doc, table);
      await applyActions(p.src.doc, [['UpdateRecord', table, first.id, { Email: `apres-${name}@x.fr` }]]);
      const t0 = Date.now();
      arrived = await waitFor(async () => (await count(p.dst.doc, dest, `where "Email" = 'apres-${name}@x.fr'`)) === 1, 'arrivée', 75000, 3000).then(() => `${Math.round((Date.now() - t0) / 1000)} s`, () => 'NON (75 s)');
    } catch (e) {
      arrived = `écriture impossible : ${e.message.split('\n')[0].slice(0, 120)}`;
    }
  }
  const q = await queue(p.src.doc);
  const src = await read(p.sv, p.src.url, 'Envoyer', `${name}-source`);
  const dst = await read(p.dv, p.dst.url, null, `${name}-cible`);
  log(`[${name}] ${spec.note}`);
  log(`[${name}] action : ${acted} ; modification arrivée : ${arrived ?? '(sans objet)'} ; file Grist : ${q}`);
  log(`[${name}] carte SOURCE : ${src}`);
  if (spec.expect) log(`[${name}] ATTENDU dans la carte SOURCE (${spec.expect}) : ${spec.expect.test(src) ? 'OUI' : 'NON'}`);
  log(`[${name}] carte CIBLE : ${dst}`);
  if (spec.after) log(`[${name}] ${await spec.after(p).catch(e => `la suite échoue : ${e.message.split('\n')[0]}`)}`);
  const errs = h.problems.slice(problems0);
  log(`[${name}] erreurs du widget en console : ${errs.length ? errs.slice(0, 3).join(' | ').slice(0, 400) : 'aucune'}`);
}

async function runPerson(name, spec) {
  const p = await fresh(name);
  const email = `${name.toLowerCase()}@sync.local`;
  const doc = p[spec.doc].doc;
  await h.shareDoc(doc, email, spec.access);
  const view = await h.userView(name, email);
  const problems0 = h.problems.length;
  // Chaque onglet du widget, tel que la personne le voit.
  const url = p[spec.doc].url;
  log(`[${name}] ${spec.note}`);
  try {
    await view.open(url);
    if (spec.first) {
      await sleep(6000);
      const first = flat(await view.text());
      log(`[${name}] premier écran : ${first.replace(/^Synchro Envoyer Recevoir Tutoriel/, '').trim().slice(0, 700)}`);
      log(`[${name}] ATTENDU au premier écran (${spec.first}) : ${spec.first.test(first) ? 'OUI' : 'NON'}`);
    }
    for (const tab of spec.doc === 'src' ? ['Envoyer', 'Recevoir'] : ['Recevoir', 'Envoyer']) {
      await view.widget().getByRole('tab', { name: tab }).click({ timeout: 10000 }).catch(() => {});
      await sleep(7000);
      log(`[${name}] onglet ${tab} : ${flat(await view.text()).replace(/^Synchro Envoyer Recevoir Tutoriel/, '').trim().slice(0, 900)}`);
      if (process.env.SHOTS) {
        await mkdir(process.env.SHOTS, { recursive: true });
        await view.page.setViewportSize({ width: 1100, height: 900 });
        await view.page.screenshot({ path: `${process.env.SHOTS}/${name}-${tab}.png` });
      }
    }
  } catch (e) {
    log(`[${name}] le widget ne s'affiche pas : ${e.message.split('\n')[0]} ; page : ${flat(await view.page.locator('body').innerText().catch(() => '')).slice(0, 300)}`);
  }
  // Une modification de la SOURCE continue-t-elle d'arriver quand cette personne a la page ouverte ?
  const [first] = await records(p.src.doc, 'Contacts');
  await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', first.id, { Email: `apres-${name}@x.fr` }]]);
  const ok = await waitFor(async () => (await count(p.dst.doc, p.dest, `where "Email" = 'apres-${name}@x.fr'`)) === 1, 'arrivée', 60000, 3000).then(() => true, () => false);
  log(`[${name}] modification de la SOURCE arrivée pendant que la personne a la page ouverte : ${ok ? 'oui' : 'NON'} ; file Grist : ${await queue(p.src.doc)}`);
  const errs = h.problems.slice(problems0);
  log(`[${name}] erreurs du widget en console : ${errs.length ? errs.slice(0, 3).join(' | ').slice(0, 400) : 'aucune'}`);
}

// Des données qui changent en pleine rafale : 6 000 lignes en cours d'envoi, pendant lesquelles on modifie, supprime et
// ajoute des lignes, puis on compare les deux tables ligne à ligne.
async function pleinEnvoi() {
  const rows = Number(process.env.ROWS || 6000);
  const p = await h.pair({ name: 'Bétise plein envoi', table: 'Contacts', columns: columnsOf(8), rows, makeRow, send: 'start' });
  await waitFor(async () => (await count(p.dst.doc, p.dest)) > 300, 'envoi commencé', 300000, 1000);
  const all = await records(p.src.doc, 'Contacts');
  const pick = (from, n) => all.slice(from, from + n).map(r => r.id);
  log(`envoi en cours (${await count(p.dst.doc, p.dest)}/${rows}) : modifications, suppressions et ajouts`);
  await applyActions(p.src.doc, [['BulkUpdateRecord', 'Contacts', pick(0, 200), { Email: Array(200).fill('modifie@x.fr') }]]);
  await applyActions(p.src.doc, [['BulkRemoveRecord', 'Contacts', pick(rows - 200, 200)]]);
  await applyActions(p.src.doc, [['BulkUpdateRecord', 'Contacts', pick(rows - 400, 100), { Email: Array(100).fill('tardif@x.fr') }]]);
  const extra = Array.from({ length: 150 }, (_, i) => makeRow(rows + i));
  await applyActions(p.src.doc, [['BulkAddRecord', 'Contacts', Array(150).fill(null), Object.fromEntries(columnsOf(8).map(c => [c.id, extra.map(r => r[c.id])]))]]);
  await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', all[300].id, { Nom: 'Renomme' }], ['RemoveRecord', 'Contacts', all[301].id]]);
  const want = (await records(p.src.doc, 'Contacts')).length;
  const t0 = Date.now();
  let diff;
  for (;;) {
    const [src, dst] = await Promise.all([records(p.src.doc, 'Contacts'), records(p.dst.doc, p.dest)]);
    const byKey = new Map(dst.map(r => [r.id_sync, r]));
    diff = { missing: 0, extra: 0, other: 0 };
    for (const r of src) {
      const got = byKey.get(r.id_sync);
      if (!got) diff.missing++;
      else if (got.Email !== r.Email || got.Nom !== r.Nom || got.Ville !== r.Ville) diff.other++;
    }
    const keys = new Set(src.map(r => r.id_sync));
    diff.extra = dst.filter(r => !keys.has(r.id_sync)).length;
    log(`plein envoi : SOURCE ${src.length} lignes, CIBLE ${dst.length} ; manquantes ${diff.missing}, en trop ${diff.extra}, différentes ${diff.other} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (!diff.missing && !diff.extra && !diff.other) break;
    if (Date.now() - t0 > 900000) break;
    await sleep(20000);
  }
  log(`plein envoi : ${diff.missing || diff.extra || diff.other ? 'ÉCARTS RESTANTS' : 'les deux tables sont identiques'} (${want} lignes attendues)`);
  log(`carte SOURCE : ${await read(p.sv, p.src.url, 'Envoyer')}`);
  log(`carte CIBLE : ${await read(p.dv, p.dst.url, null)}`);
}

const everything = [...Object.keys(cases), ...Object.keys(people), 'pleinEnvoi'];
const wanted = process.env.ONLY ? process.env.ONLY.split(',') : everything;
let failed = false;
try {
  for (const name of wanted) {
    log(`=== ${name}`);
    try {
      if (cases[name]) await runCase(name, cases[name]);
      else if (people[name]) await runPerson(name, people[name]);
      else if (name === 'pleinEnvoi') await pleinEnvoi();
      else throw new Error(`cas inconnu : ${name}`);
    } catch (e) {
      log(`[${name}] LE SCÉNARIO LUI-MÊME A ÉCHOUÉ : ${e.message.split('\n')[0].slice(0, 300)}`);
    }
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await h.close();
}
process.exit(failed ? 1 : 0);
