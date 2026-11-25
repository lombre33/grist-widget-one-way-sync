// « Les pannes qui ne disent rien » : des scénarios qui cherchent une synchro cassée sans que personne ne soit prévenu
// (audit de fiabilité du 25 novembre 2026). Pour chacun, on casse quelque chose, on modifie la SOURCE, et on relève :
// la modification arrive-t-elle, et que disent les deux cartes du widget, SANS rouvrir la page (rouvrir relance le widget et
// cacherait une boucle arrêtée). Rien n'est affirmé : c'est un relevé, à lire ligne à ligne ; une ligne « ATTENDU » dit ce
// qu'une personne devrait lire.
// Usage : PORT=8710 node tests/e2e/silencieux.mjs                         (tout)
//         PORT=8711 ONLY=hookRallume,noteJournalPerdue node tests/e2e/silencieux.mjs
// Les cas `boucleCible` et `boucleSource` font échouer un seul dessin de l'onglet (une requête perdue un instant) : ils servent
// un widget dont `refreshTarget` ou `refreshSource` échoue une fois (BOOM=1, posé d'office par ces cas).
import { createHarness, log, sleep } from './harness.mjs';
import { columnsOf, makeRow } from './data.mjs';

const wanted = process.env.ONLY ? process.env.ONLY.split(',') : null;
const boom = (wanted || []).some(name => /^boucle/.test(name)) || process.env.BOOM === '1';
const patches0 = {};
// requeteSansReponse : le délai de 2 minutes (REQUEST_MS de js/grist.js) est ramené à 8 s pour que le scénario ne dure pas des minutes.
const shortTimeout = (wanted || []).includes('requeteSansReponse') || process.env.SHORT_TIMEOUT === '1';
const patches = boom ? {
  '/js/target/tab.js': text => text.replace('export async function refreshTarget() {', "export async function refreshTarget() {\n  if (window.__armed && !window.__boom) { window.__boom = 1; throw new Error('Failed to fetch'); }"),
  '/js/source/tab.js': text => text.replace('export async function refreshSource() {', "export async function refreshSource() {\n  if (window.__armed && !window.__boom) { window.__boom = 1; throw new Error('Failed to fetch'); }"),
} : {};
// horsLigne : la lecture du schéma échoue tant que la page dit `window.__offline` (Grist qui ne répond plus, au niveau de la page).
if ((wanted || []).includes('horsLigne')) {
  patches['/js/grist.js'] = text => text.replace('export async function readSchema() {', "export async function readSchema() {\n  if (window.__offline) throw new TypeError('Failed to fetch');");
}
if (shortTimeout) patches['/js/grist.js'] = text => text.replace('const REQUEST_MS = 120000;', 'const REQUEST_MS = 8000;');
Object.assign(patches0, patches);
// BEFORE=1 : le widget sert l'ancien texte des deux boucles (avant la correction du 25 novembre), pour voir la panne avant/après.
if (process.env.BEFORE === '1') {
  patches['/js/engine/target/loop.js'] = text => text
    .replace(/  const tick = async \(\) => \{\n    try \{\n      if \(page.visible\(\) && await due\(\)\) await consolidateAll\(\);\n    \} catch \(e\) \{[\s\S]*?\n    \} finally \{\n      setTimeout\(tick, POLL_MS\);\n    \}\n  \};/, '  const tick = async () => {\n    if (page.visible() && await due()) await consolidateAll();\n    setTimeout(tick, POLL_MS);\n  };')
    .replace(/  if \(changed \|\| failureShown\(\) !== shown\) await Promise.resolve\(\).then\(onChange\).*\n/, '  if (changed) await onChange();\n');
  patches['/js/source/tab.js'] = text => (patches0['/js/source/tab.js'] ? patches0['/js/source/tab.js'](text) : text)
    .replace(/  try \{\n    const \{ moving, changed \} = refreshPeople[\s\S]*?\n  \} catch \(e\) \{[\s\S]*?if \(!flowTimer\) watchFlows\(IDLE_MS\);\n  \}\n\}/, "  const { moving, changed } = refreshPeople(hooks, refreshFlows(charge, hooks, conditions, loading > 0));\n  const moved = await accessChanged();\n  if ((changed || moved) && !document.querySelector('.scrim')) await refreshSource();\n  else watchFlows(moving || changed || moved ? FLOW_MS : restMs());\n}");
}
const h = await createHarness({ port: Number(process.env.PORT || 8710), patches });
const { records, count, applyActions, webhooks, waitFor, api } = h;

const flat = text => String(text || '').replace(/\s+/g, ' ');
const cut = text => flat(text).replace(/^Sync\+ Envoyer Recevoir Tutoriel/, '').trim().slice(0, 900);
const ROWS = 20;

async function fresh(name) {
  const p = await h.pair({ name: `Silence ${name}`, table: 'Contacts', columns: columnsOf(8), rows: ROWS, makeRow, send: 'wait' });
  await waitFor(async () => (await count(p.dst.doc, p.dest)) === ROWS, 'départ', 90000, 2000);
  return p;
}
// Le widget de la CIBLE (ou de la SOURCE) ouvert et laissé tourner, sur l'onglet voulu.
async function keepOpen(view, url, tab) {
  await view.openTab(url, tab, 20000);
  await sleep(4000);
}
// Arme l'échec unique du dessin (patch BOOM) : le prochain dessin qui suit un passage lève une erreur, une seule fois.
const boomed = view => view.widget().locator('body').evaluate(() => String(window.__boom)).catch(() => '?');
const arm = view => view.widget().locator('body').evaluate(() => { window.__armed = true; });
const change = async (p, n, email) => {
  const rows = await records(p.src.doc, 'Contacts');
  await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', rows[n].id, { Email: email }]]);
};
const arrives = async (p, email, ms = 75000) => {
  const t0 = Date.now();
  return waitFor(async () => (await count(p.dst.doc, p.dest, `where "Email" = '${email}'`)) >= 1, `arrivée de ${email}`, ms, 3000)
    .then(() => `arrivée en ${Math.round((Date.now() - t0) / 1000)} s`, () => `NON arrivée (${Math.round(ms / 1000)} s)`);
};
// Écart ligne à ligne entre la SOURCE et la CIBLE (clé id_sync) : lignes qui diffèrent, manquantes, en trop.
async function gap(p) {
  const [src, dst] = await Promise.all([records(p.src.doc, 'Contacts'), records(p.dst.doc, p.dest)]);
  const byKey = new Map(dst.map(r => [r.id_sync, r]));
  const differ = src.filter(r => byKey.has(r.id_sync) && byKey.get(r.id_sync).Email !== r.Email).map(r => r.Email);
  const missing = src.filter(r => !byKey.has(r.id_sync)).length;
  const keys = new Set(src.map(r => r.id_sync));
  return `SOURCE ${src.length} lignes, CIBLE ${dst.length} ; lignes qui diffèrent : ${differ.length} ${differ.slice(0, 2).join(',')} ; manquantes : ${missing} ; en trop : ${dst.filter(r => !keys.has(r.id_sync)).length}`;
}
const cards = async (p, tag) => {
  log(`[${tag}] carte SOURCE (sans rouvrir) : ${cut(await p.sv.text())}`);
  log(`[${tag}] carte CIBLE (sans rouvrir) : ${cut(await p.dv.text())}`);
};

const cases = {
  // Quelqu'un coupe le webhook dans les réglages de Grist, modifie une ligne, le rallume, puis modifie une autre ligne.
  async hookRallume(p) {
    await keepOpen(p.dv, p.dst.url, 'Recevoir');
    const [hook] = await webhooks(p.src.doc);
    await api('PATCH', `/docs/${p.src.doc}/webhooks/${hook.id}`, { enabled: false });
    await sleep(3000);
    await change(p, 0, 'pendant-coupure@x.fr');
    await sleep(3000);
    await api('PATCH', `/docs/${p.src.doc}/webhooks/${hook.id}`, { enabled: true });
    await sleep(3000);
    await change(p, 1, 'apres-rallume@x.fr');
    log(`[hookRallume] modification après le rallumage : ${await arrives(p, 'apres-rallume@x.fr')}`);
    log(`[hookRallume] modification faite pendant la coupure : ${await arrives(p, 'pendant-coupure@x.fr', 150000)}`);
    log(`[hookRallume] ${await gap(p)}`);
    await sleep(20000);
    await keepOpen(p.sv, p.src.url, 'Envoyer');
    await cards(p, 'hookRallume');
    log(`[hookRallume] ATTENDU : une des deux cartes dit qu'une modification n'est pas arrivée (ou elle arrive seule) : ${/pendant-coupure/.test(await gap(p)) ? 'ÉCART SILENCIEUX si aucune carte ne le dit' : 'pas d\'écart'}`);
  },

  // Une personne remet à zéro la colonne Synchro_Ids du journal (elle y garde la note du widget, dans les options de la colonne).
  async noteJournalPerdue(p) {
    await keepOpen(p.dv, p.dst.url, 'Recevoir');
    const tables = await records(p.dst.doc, '_grist_Tables');
    const journal = tables.find(tb => tb.tableId === p.journal);
    const column = (await records(p.dst.doc, '_grist_Tables_column')).find(c => c.parentId === journal.id && c.colId === 'Synchro_Ids');
    await applyActions(p.dst.doc, [['UpdateRecord', '_grist_Tables_column', column.id, { widgetOptions: '', description: '' }]]);
    await sleep(15000);
    await change(p, 0, 'note-perdue@x.fr');
    log(`[noteJournalPerdue] modification : ${await arrives(p, 'note-perdue@x.fr', 90000)}`);
    log(`[noteJournalPerdue] lignes du journal ${await count(p.dst.doc, p.journal)}, lignes de la table reçue ${await count(p.dst.doc, p.dest)} ; ${await gap(p)}`);
    await cards(p, 'noteJournalPerdue');
    const here = flat(await p.dv.text());
    log(`[noteJournalPerdue] page restée ouverte, ATTENDU : la carte CIBLE dit que la réception ne se lit plus : ${/Réception illisible/.test(here) ? 'OUI' : 'NON (la carte d\'avant reste affichée sans un mot jusqu\'à la réouverture de l\'onglet)'}`);
    await keepOpen(p.dv, p.dst.url, 'Recevoir');
    const reopened = flat(await p.dv.text());
    log(`[noteJournalPerdue] onglet rouvert, ATTENDU : « Réception illisible » avec ce qu'il faut faire : ${/Réception illisible/.test(reopened) && /Ctrl\+Z/.test(reopened) ? 'OUI' : 'NON'} ; texte : ${cut(reopened).slice(0, 500)}`);
  },

  // Une requête REST qui ne répond jamais (mandataire, réseau qui n'abandonne pas) pendant que la CIBLE tourne.
  async requeteSansReponse(p) {
    await keepOpen(p.dv, p.dst.url, 'Recevoir');
    let held = 0;
    await p.dv.page.route(/\/api\/docs\/[^/]+\/(compare|sql)/, () => { held++; });
    await sleep(15000);
    await change(p, 0, 'requete-muette@x.fr');
    log(`[requeteSansReponse] modification, requêtes /compare et /sql sans réponse : ${await arrives(p, 'requete-muette@x.fr', 120000)} (requêtes retenues : ${held})`);
    await cards(p, 'requeteSansReponse');
    await p.dv.page.unroute(/\/api\/docs\/[^/]+\/(compare|sql)/);
    await change(p, 1, 'requete-reprise@x.fr');
    log(`[requeteSansReponse] modification après le retour du réseau (page non rouverte) : ${await arrives(p, 'requete-reprise@x.fr', 90000)}`);
  },

  // Page du widget cachée (autre onglet du navigateur) : rien n'est recopié ; au retour, un passage a lieu.
  async ongletCache(p) {
    await keepOpen(p.dv, p.dst.url, 'Recevoir');
    await p.dv.hide(true);
    await sleep(2000);
    await change(p, 0, 'page-cachee@x.fr');
    log(`[ongletCache] page cachée : ${await arrives(p, 'page-cachee@x.fr', 45000)}`);
    log(`[ongletCache] lignes brutes dans le journal : ${await count(p.dst.doc, p.journal, `where "Synchro_Type" is not null and "Synchro_Type" != ''`)}`);
    await p.dv.hide(false);
    log(`[ongletCache] page de nouveau visible : ${await arrives(p, 'page-cachee@x.fr', 40000)}`);
  },

  // Grist ne répond plus à la page de la CIBLE : « Synchroniser » ne doit pas dire « tout est à jour », l'écran doit le dire, et se rétablir seul.
  async horsLigne(p) {
    await keepOpen(p.dv, p.dst.url, 'Recevoir');
    const offline = value => p.dv.widget().locator('body').evaluate((_, v) => { window.__offline = v; }, value);
    await offline(true);
    await change(p, 0, 'hors-ligne@x.fr');
    await p.dv.button('Synchroniser').click();
    await sleep(4000);
    const clicked = flat(await p.dv.text());
    log(`[horsLigne] clic sur « Synchroniser » pendant la panne : ${/tout est à jour/.test(clicked) ? 'MENT : dit « tout est à jour »' : /échoue/.test(clicked) ? 'dit que la recopie échoue' : `ne dit rien d'utile : ${clicked.slice(0, 200)}`}`);
    await sleep(40000);
    const later = flat(await p.dv.text());
    log(`[horsLigne] 45 s plus tard, sans clic : ${/La recopie des données reçues dans vos tables échoue/.test(later) ? 'l\'écran dit que la recopie échoue' : 'AUCUN avis (écran muet)'}`);
    await offline(false);
    log(`[horsLigne] Grist répond de nouveau : ${await arrives(p, 'hors-ligne@x.fr', 150000)}`);
    await sleep(15000);
    log(`[horsLigne] l'avis a disparu : ${/La recopie des données reçues dans vos tables échoue/.test(flat(await p.dv.text())) ? 'NON' : 'oui'}`);
  },

  // Un dessin de l'onglet CIBLE échoue une fois (Grist ne répond pas une seconde) : la recopie continue-t-elle ?
  async boucleCible(p) {
    await keepOpen(p.dv, p.dst.url, 'Recevoir');
    await arm(p.dv);
    await change(p, 0, 'boucle-un@x.fr');
    log(`[boucleCible] première modification (son dessin échoue une fois) : ${await arrives(p, 'boucle-un@x.fr')} ; dessin raté : ${await boomed(p.dv) === '1' ? 'oui' : 'NON (le scénario ne s\'est pas produit)'}`);
    await sleep(5000);
    await change(p, 1, 'boucle-deux@x.fr');
    log(`[boucleCible] seconde modification, page non rouverte : ${await arrives(p, 'boucle-deux@x.fr', 90000)}`);
    await cards(p, 'boucleCible');
    log(`[boucleCible] ${await gap(p)}`);
  },

  // Un redessin de l'onglet Envoyer échoue une fois : l'état des destinataires se met-il encore à jour ?
  async boucleSource(p) {
    await keepOpen(p.sv, p.src.url, 'Envoyer');
    await arm(p.sv);
    const [hook] = await webhooks(p.src.doc);
    await api('PATCH', `/docs/${p.src.doc}/webhooks/${hook.id}`, { enabled: false });
    await sleep(45000);
    log(`[boucleSource] dessin raté : ${await boomed(p.sv) === '1' ? 'oui' : 'NON (le scénario ne s\'est pas produit)'}`);
    log(`[boucleSource] webhook coupé à la main, carte SOURCE 45 s après (premier redessin en échec) : ${/En pause/.test(flat(await p.sv.text())) ? 'dit « En pause »' : 'NE DIT PAS « En pause »'}`);
    await api('PATCH', `/docs/${p.src.doc}/webhooks/${hook.id}`, { enabled: true });
    await sleep(60000);
    log(`[boucleSource] webhook rallumé, carte SOURCE 60 s après : ${/En pause/.test(flat(await p.sv.text())) ? 'dit encore « En pause »' : 'ne dit plus « En pause »'}`);
    await cards(p, 'boucleSource');
  },

  // Éditeur d'un document CIBLE dont le droit de structure est réservé aux propriétaires : « Arrêter la réception » échoue.
  async editeurSansStructure(p) {
    // Ce que fait la case « Permettre aux éditeurs de modifier la structure » décochée : règle `user.Access != OWNER` → `-S` sur la ressource `*`.
    const known = (await records(p.dst.doc, '_grist_ACLResources')).find(r => r.tableId === '*' && r.colIds === '*');
    const resource = known ? known.id : (await applyActions(p.dst.doc, [['AddRecord', '_grist_ACLResources', null, { tableId: '*', colIds: '*' }]])).retValues[0];
    await applyActions(p.dst.doc, [['AddRecord', '_grist_ACLRules', null, { resource, aclFormula: 'user.Access != OWNER', permissionsText: '-S', rulePos: known ? 0.5 : 1, memo: '' }]]);
    await sleep(3000);
    await h.shareDoc(p.dst.doc, 'editeur@sync.local', 'editors');
    const view = await h.userView('editeur', 'editeur@sync.local');
    await view.open(p.dst.url);
    await view.widget().getByRole('tab', { name: 'Recevoir' }).click({ timeout: 20000 });
    await sleep(8000);
    log(`[editeurSansStructure] carte vue par l'éditeur : ${cut(await view.text())}`);
    await view.button('Arrêter la réception').click({ timeout: 20000 }).catch(e => log(`[editeurSansStructure] bouton introuvable : ${e.message.split('\n')[0]}`));
    await view.dialogButton('Arrêter la réception').click({ timeout: 20000 }).catch(e => log(`[editeurSansStructure] bouton de confirmation introuvable : ${e.message.split('\n')[0]}`));
    await sleep(8000);
    const after = cut(await view.text());
    log(`[editeurSansStructure] après « Arrêter la réception » (refusée par Grist) : ${after}`);
    log(`[editeurSansStructure] ATTENDU : un message d'erreur : ${/Erreur|refus|Blocked|impossible|n’a pas pu/i.test(after) ? 'OUI' : 'NON (aucun message)'} ; journal encore là : ${(await records(p.dst.doc, '_grist_Tables')).some(tb => tb.tableId === p.journal)}`);
    await change(p, 0, 'editeur-structure@x.fr');
    log(`[editeurSansStructure] modification de la SOURCE pendant que l'éditeur a la page ouverte : ${await arrives(p, 'editeur-structure@x.fr', 60000)}`);
    log(`[editeurSansStructure] erreurs du widget en console : ${h.problems.slice(-3).join(' | ').slice(0, 400) || 'aucune'}`);
  },
};

let failed = false;
try {
  for (const name of wanted || Object.keys(cases)) {
    log(`=== ${name}`);
    if (!cases[name]) { log(`cas inconnu : ${name}`); continue; }
    try {
      const p = await fresh(name);
      const problems0 = h.problems.length;
      await cases[name](p);
      const errs = h.problems.slice(problems0);
      log(`[${name}] erreurs du widget en console : ${errs.length ? errs.slice(0, 3).join(' | ').slice(0, 400) : 'aucune'}`);
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
