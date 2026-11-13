// Audit d'interface : une capture de chaque fenêtre et de quelques cartes du widget, dans un vrai Grist, pour comparer
// l'écran avant et après une réécriture des textes ou un allègement de l'interface.
//
// Usage (Grist lancé par tests/e2e/start-grist.sh) :
//   OUT=/chemin/avant node tests/e2e/tools/audit-ui.mjs            # français (par défaut)
//   OUT=/chemin/apres LANG_UI=en node tests/e2e/tools/audit-ui.mjs # anglais
// Chaque capture est un essai à part : un sélecteur qui ne trouve plus son élément est signalé, les autres captures sont faites.
// La fenêtre du navigateur est très haute (1100 × 2000) pour que chaque fenêtre du widget tienne en entier, sans défilement.
import { mkdir } from 'node:fs/promises';
import { createHarness, log, sleep } from '../harness.mjs';

const OUT = process.env.OUT || '/tmp/audit-ui';
const LANG = process.env.LANG_UI || 'fr';
await mkdir(OUT, { recursive: true });
const h = await createHarness({ port: 8590 });
const failed = [];

const SIZE = { width: 1100, height: Number(process.env.HEIGHT || 2000) };

// Capture de la fenêtre ouverte (la dernière) ou, à défaut, du premier écran du widget.
async function snap(view, name, what = 'dialog') {
  try {
    await view.page.setViewportSize(SIZE);
    await sleep(500);
    const frame = view.widget();
    const target = what === 'dialog' ? frame.locator('[role=dialog]').last() : what === 'page' ? frame.locator('body') : frame.locator(what).first();
    await target.waitFor({ timeout: 8000 });
    await target.screenshot({ path: `${OUT}/${name}.png`, style: '.scrim { background: none !important; }' });
    log(`capture ${name}`);
  } catch (e) {
    failed.push(`${name} : ${String(e.message).split('\n')[0]}`);
    log(`ECHEC ${name} : ${String(e.message).split('\n')[0]}`);
  }
}
// Les « ? » d'une fenêtre (absents des captures d'avant) : tous dépliés pour la capture, puis refermés.
async function toggleHelps(view) {
  const buttons = view.widget().locator('[role=dialog]').last().locator('.help-btn');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) await buttons.nth(i).click();
  return count;
}
// Un pas qui peut échouer sans arrêter la suite.
async function attempt(name, fn) {
  try { await fn(); } catch (e) { failed.push(`${name} : ${String(e.message).split('\n')[0]}`); log(`ECHEC ${name} : ${String(e.message).split('\n')[0]}`); }
}

try {
  // --- Documents : la SOURCE a des tables de tous les types utiles aux options, la CIBLE une table déjà là.
  const src = await h.newDocWithWidget('Audit SOURCE', [
    ['AddTable', 'Villes', [{ id: 'Ville', type: 'Text' }, { id: 'CodePostal', type: 'Text' }]],
    ['BulkAddRecord', 'Villes', [null, null], { Ville: ['Lyon', 'Paris'], CodePostal: ['69000', '75000'] }],
    ['AddTable', 'Contacts', [
      { id: 'Nom', type: 'Text' }, { id: 'Age', type: 'Int' }, { id: 'Actif', type: 'Bool' },
      { id: 'Statut', type: 'Choice', widgetOptions: JSON.stringify({ choices: ['Nouveau', 'Suivi'] }) },
      { id: 'Lieu', type: 'Ref:Villes' }, { id: 'Pieces', type: 'Attachments' },
      { id: 'Double', type: 'Numeric', isFormula: true, formula: '$Age * 2' },
      { id: 'Note', type: 'Text', label: 'Note' },
    ]],
    ['BulkAddRecord', 'Contacts', [null, null, null], { Nom: ['Alice', 'Bob', 'Chloé'], Age: [30, 41, 52], Actif: [true, false, true], Statut: ['Nouveau', 'Suivi', 'Suivi'] }],
  ]);
  const colRef = async (doc, table, col) => {
    const parent = await h.tableRef(doc, table);
    return (await h.records(doc, '_grist_Tables_column')).find(c => c.colId === col && c.parentId === parent).id;
  };
  await h.applyActions(src.doc, [
    ['UpdateRecord', '_grist_Tables_column', await colRef(src.doc, 'Contacts', 'Lieu'), { visibleCol: await colRef(src.doc, 'Villes', 'Ville') }],
    ['SetDisplayFormula', 'Contacts', null, await colRef(src.doc, 'Contacts', 'Lieu'), '$Lieu.Ville'],
    ['BulkUpdateRecord', 'Contacts', [1, 2], { Lieu: [1, 2] }],
    ['UpdateRecord', '_grist_Tables_column', await colRef(src.doc, 'Contacts', 'Note'), { description: 'Remarque libre sur la personne' }],
  ]);
  const dst = await h.newDocWithWidget('Audit CIBLE', [
    ['AddTable', 'Annuaire', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }]],
    ['BulkAddRecord', 'Annuaire', [null], { Nom: ['Alice'], Ville: ['Lyon'] }],
  ]);

  const sv = await h.newView('source');
  await h.login(sv);
  // Le widget parle la langue du navigateur ; un choix des Réglages la change aussi, mais la langue du contexte suffit ici.
  if (LANG === 'en') await sv.page.addInitScript(() => localStorage.setItem('gristsync.lang', 'en'));
  await sv.open(src.url);
  const bar = name => sv.widget().locator('.topbar').getByRole('tab', { name });
  const sw = () => sv.widget();
  // La dernière fenêtre ouverte (une confirmation peut être posée sur l'assistant) et son bouton de droite.
  const top = view => view.widget().locator('[role=dialog]').last();
  const dlg = () => top(sv);
  const nextBtn = view => top(view).locator('.modal-footer button').last();

  // --- SOURCE : première visite (accueil) puis assistant d'export
  await snap(sv, 's00-accueil', 'body');
  await attempt('export', async () => {
    await sw().locator('.tile').first().click();
    await sw().locator('main').getByRole('button').first().click(); // « Nouvel export »
    await dlg().waitFor();
    await snap(sv, 's01-export-tables');
    await dlg().getByRole('checkbox', { name: 'Contacts' }).check();
    await nextBtn(sv).click();
    await dlg().locator('.table-block').first().waitFor();
    await snap(sv, 's02-export-colonnes');
    // Tout ouvrir : éléments envoyés, choix des colonnes, filtre.
    for (const summary of await dlg().locator('details.options-more > summary').all()) await summary.click().catch(() => {});
    const buttons = dlg().locator('.table-block .block-actions button');
    for (let i = 0; i < await buttons.count(); i++) await buttons.nth(i).click().catch(() => {});
    await snap(sv, 's03-export-colonnes-ouvert');
    await attempt('aides-colonnes', async () => {
      if (await toggleHelps(sv)) { await snap(sv, 's03b-export-colonnes-aides-ouvertes'); await toggleHelps(sv); }
    });
    await attempt('filtre', async () => {
      await dlg().locator('.filter-field .btn, .filter-field button').first().click();
      await snap(sv, 's04-export-filtre');
    });
    await attempt('formules', async () => {
      await dlg().locator('.formulas-box input[type=checkbox]').check();
      await snap(sv, 's05-export-formules');
      await sv.page.keyboard.press('Escape');
    });
    await nextBtn(sv).click();
    await dlg().locator('#gristsync-export-name').waitFor();
    await snap(sv, 's06-export-nom');
    await nextBtn(sv).click();
    await dlg().locator('.msg-ok').waitFor({ timeout: 60000 });
    await snap(sv, 's07-export-cree');
    await nextBtn(sv).click(); // « Ajouter un destinataire »
    await dlg().locator('input[name="gristsync-mode"]').first().waitFor();
    await snap(sv, 's08-destinataire-options');
    await attempt('aides-destinataire', async () => {
      if (await toggleHelps(sv)) { await snap(sv, 's08b-destinataire-aides-ouvertes'); await toggleHelps(sv); }
    });
    await attempt('options-echange', async () => {
      await dlg().locator('input[name="gristsync-mode"][value="echange"]').check();
      await snap(sv, 's09-destinataire-echange');
      await dlg().locator('input[name="gristsync-mode"][value="public"]').check();
      await snap(sv, 's10-destinataire-public');
      await dlg().locator('input[name="gristsync-mode"][value="reponse"]').check();
    });
    await nextBtn(sv).click(); // « Créer l'invitation »
    await dlg().locator('textarea.code').first().waitFor({ timeout: 60000 });
    await snap(sv, 's11-destinataire-invitation');
  });
  const code = await dlg().locator('textarea.code').first().inputValue().catch(() => '');
  await attempt('reponse-vide', async () => {
    await nextBtn(sv).click(); // « J'ai la réponse »
    await dlg().locator('textarea.code').first().waitFor();
    await snap(sv, 's12-destinataire-reponse');
  });
  await sv.page.keyboard.press('Escape');
  await snap(sv, 's13-carte-export-invitation', 'main');

  // --- CIBLE : réception
  const dv = await h.newView('cible');
  await h.login(dv);
  if (LANG === 'en') await dv.page.addInitScript(() => localStorage.setItem('gristsync.lang', 'en'));
  await dv.open(dst.url);
  let reply = null;
  await attempt('reception', async () => {
    await dv.widget().locator('.tile').nth(1).click();
    await dv.widget().locator('main').getByRole('button').first().click(); // « Accepter une invitation »
    await top(dv).locator('textarea.code').first().waitFor();
    await snap(dv, 'r01-recevoir-code');
    await top(dv).locator('textarea.code').first().fill(code);
    await nextBtn(dv).click();
    await top(dv).locator('.dest-grid').waitFor({ timeout: 60000 });
    await snap(dv, 'r02-recevoir-destinations');
    for (const summary of await top(dv).locator('details.options-more > summary').all()) await summary.click().catch(() => {});
    await snap(dv, 'r03-recevoir-options');
    await attempt('aides-reception', async () => {
      if (await toggleHelps(dv)) { await snap(dv, 'r03c-recevoir-options-aides-ouvertes'); await toggleHelps(dv); }
    });
    // Aide en images et « Qui fait quoi ? » ouverts : ce que voit quelqu'un qui ouvre les aides.
    await attempt('aides', async () => {
      for (const summary of await top(dv).locator('details.guide:not(.options-more) > summary').all()) await summary.click().catch(() => {});
      await snap(dv, 'r03b-recevoir-aides-ouvertes');
      for (const summary of await top(dv).locator('details.guide:not(.options-more)[open] > summary').all()) await summary.click().catch(() => {});
    });
    // Table existante : correspondance des colonnes.
    await attempt('existante', async () => {
      await top(dv).locator('.dest-grid button.pick-button').first().click();
      await top(dv).locator('.pick-option', { hasText: 'Annuaire' }).first().click();
      await nextBtn(dv).click();
      await top(dv).locator('select, .pick-button').nth(1).waitFor({ timeout: 15000 });
      await snap(dv, 'r04-recevoir-table-existante');
      await top(dv).locator('.modal-footer .btn-back').click();
      await top(dv).locator('.dest-grid button.pick-button').first().click();
      await top(dv).locator('.pick-option').first().click();
    });
    await nextBtn(dv).click();
    await top(dv).locator('p, h2').filter({ hasText: /./ }).first().waitFor();
    await snap(dv, 'r05-nouvelle-table');
    await nextBtn(dv).click();
    const forms = await h.waitFor(async () => { const f = await h.publishedForms(dst.doc); return f.length === 1 && f; }, 'formulaire publié', 60000);
    await dv.open(dst.url);
    await top(dv).locator('input[type=url]').waitFor({ timeout: 30000 });
    await snap(dv, 'r06-recevoir-lien');
    await top(dv).locator('input[type=url]').fill(await h.formLink(dst.doc, forms[0]));
    await nextBtn(dv).click();
    await top(dv).locator('textarea.code').first().waitFor({ timeout: 60000 });
    reply = await top(dv).locator('textarea.code').first().inputValue();
    await snap(dv, 'r07-recevoir-reponse');
    await dv.page.keyboard.press('Escape');
  });

  // --- SOURCE : réponse, approbation, envoi
  if (reply) {
    await attempt('approbation', async () => {
      await sv.open(src.url);
      await sw().locator('.card-actions button, .person button, button').filter({ hasText: /réponse|reply/i }).first().click();
      await dlg().locator('textarea.code').first().fill(reply);
      await nextBtn(sv).click();
      await dlg().locator('.fiche').waitFor({ timeout: 60000 });
      await snap(sv, 's14-reponse-fiche');
      await nextBtn(sv).click(); // « Approuver et brancher »
      await dlg().locator('.msg-ok').waitFor({ timeout: 60000 });
      await snap(sv, 's15-envoi-existant');
      await nextBtn(sv).click(); // « Envoyer » : les lignes existantes arrivent chez la CIBLE
      await dlg().getByText(/Lignes existantes envoyées|Existing rows sent/).waitFor({ timeout: 120000 });
      await nextBtn(sv).click(); // « Fermer »
    });
  }
  await attempt('carte-export', async () => {
    await sv.open(src.url);
    await sw().locator('.tile').first().click().catch(() => {});
    await sw().locator('.card').first().waitFor();
    await snap(sv, 's16-carte-export', 'main');
  });
  // Fenêtres de confirmation de la carte de l'export (rien n'est confirmé : Échap).
  await attempt('historique-source', async () => {
    await sw().locator('main details > summary').first().click();
    await snap(sv, 's21-carte-export-historique', 'main');
  });
  for (const [name, action] of [['s17-confirm-revoquer', /Révoquer|Revoke/], ['s18-confirm-supprimer-export', /^Supprimer$|^Delete$/], ['s19-confirm-effacer-historique', /Effacer l.historique|Clear the history/]]) {
    await attempt(name, async () => {
      const button = sw().locator('main button').filter({ hasText: action }).first();
      await button.click({ timeout: 5000 });
      await snap(sv, name);
      await sv.page.keyboard.press('Escape');
    });
  }
  // Pause puis reprise : la fenêtre de reprise.
  await attempt('s20-reprise', async () => {
    await sw().locator('main button').filter({ hasText: /Mettre en pause|Pause/ }).first().click({ timeout: 5000 });
    const resume = sw().locator('main button').filter({ hasText: /^Reprendre$|^Resume$/ }).first();
    await resume.waitFor({ timeout: 30000 });
    await resume.click();
    await snap(sv, 's20-reprise');
    await sv.page.keyboard.press('Escape');
  });

  // Modifier l'export puis quitter après un changement : la fenêtre « Quitter sans enregistrer ? » (absente avant).
  await attempt('s22-modifier-quitter', async () => {
    await sw().locator('main button').filter({ hasText: /^Modifier$|^Edit$/ }).first().click({ timeout: 5000 });
    await dlg().waitFor();
    await snap(sv, 's22-modifier-confirmation');
    await nextBtn(sv).click(); // « Continuer »
    await dlg().locator('.table-block').first().waitFor({ timeout: 30000 });
    await dlg().getByRole('checkbox', { name: /colonnes que j.ajouterai|columns I add/ }).check();
    await sv.page.keyboard.press('Escape');
    await sleep(300);
    await snap(sv, 's23-modifier-quitter-sans-enregistrer');
    await sv.page.keyboard.press('Escape'); // « Continuer à modifier »
    await dlg().getByRole('button', { name: /Fermer la fenêtre|Close window/ }).click();
    await dlg().getByRole('button', { name: /Abandonner|Discard/ }).click();
  });

  // --- CIBLE : carte de réception et ses fenêtres
  await attempt('carte-reception', async () => {
    await dv.open(dst.url);
    await sleep(25000); // la page ouverte recopie les lignes reçues, ce qui fait apparaître les options de reprise
    await dv.open(dst.url);
    await dv.widget().locator('.tile').nth(1).click().catch(() => {});
    await dv.widget().locator('.card').first().waitFor({ timeout: 30000 });
    await snap(dv, 'r08-carte-reception', 'main');
  });
  for (const [name, action] of [['r09-options', /^Options$/], ['r10-reprendre-depuis-la-source', /Reprendre depuis la SOURCE|Take again from the SOURCE/], ['r11-confirm-effacer-historique', /Effacer l.historique|Clear the history/], ['r12-confirm-arreter', /Arrêter la réception|Stop receiving/]]) {
    await attempt(name, async () => {
      await dv.widget().locator('main button').filter({ hasText: action }).first().click({ timeout: 5000 });
      await snap(dv, name);
      await dv.page.keyboard.press('Escape');
    });
  }

  await attempt('r09b-options-aides-quitter', async () => {
    await dv.widget().locator('main button').filter({ hasText: /^Options$/ }).first().click({ timeout: 5000 });
    await top(dv).waitFor();
    if (await toggleHelps(dv)) { await snap(dv, 'r09b-options-aides-ouvertes'); await toggleHelps(dv); }
    await top(dv).locator('input[type=checkbox]').first().check();
    await dv.page.keyboard.press('Escape');
    await sleep(300);
    await snap(dv, 'r09c-options-quitter-sans-enregistrer');
    await dv.page.keyboard.press('Escape');
    await top(dv).getByRole('button', { name: /Fermer la fenêtre|Close window/ }).click();
    await top(dv).getByRole('button', { name: /Abandonner|Discard/ }).click();
  });

  // --- Nouveautés, réglages
  await attempt('reglages', async () => {
    await dv.widget().locator('.topbar button[aria-label], .topbar .icon-button').last().click();
    await snap(dv, 'r13-reglages', 'main');
  });
} catch (e) {
  failed.push(`script : ${e.stack}`);
} finally {
  await h.close();
}
console.log(failed.length ? `\n${failed.length} échec(s) :\n${failed.join('\n')}` : '\nToutes les captures sont faites.');
process.exit(0);
