// Sonde : une instance Grist qui n'autorise pas les webhooks vers sa propre adresse (sa liste ALLOWED_WEBHOOK_DOMAINS
// ne la contient pas ; c'est aussi le cas d'une instance où le réglage est vide). Que dit le widget au branchement ?
// Attendu : le texte de `error.webhookForbidden` (demander à l'administrateur), jamais « réservé aux propriétaires »,
// et aucun webhook créé. Grist répond 403 « Provided url is forbidden » (vérifié sur 1.7).
// Lancer d'abord un second Grist qui refuse, puis la sonde :
//   PORT=8474 CONTAINER=grist-sync-refus ENV_FILE=.env-refus.json WEBHOOK_DOMAINS=example.com tests/e2e/start-grist.sh
//   node tests/e2e/tools/probe-webhook-refused.mjs        (SHOTS=<dossier> fait une capture)
import assert from 'node:assert/strict';
import { createHarness, shootPage } from '../harness.mjs';
import { columnsOf, makeRow } from '../data.mjs';

const h = await createHarness({ port: 8588, envFile: '.env-refus.json' });
try {
  const src = await h.newDocWithWidget('Refus SOURCE');
  await h.fillTable(src.doc, 'Contacts', columnsOf(4), 5, makeRow);
  const dst = await h.newDocWithWidget('Refus CIBLE');
  const sv = await h.newView('source');
  await h.login(sv);
  await sv.open(src.url);
  await h.createExport(sv, 'Contacts', 'Annuaire');
  const code = await h.invite(sv);
  const dv = await h.newView('cible');
  await h.login(dv);
  const answer = await h.accept(dv, dst, code, { exportName: 'Annuaire', table: 'Contacts' });

  await sv.open(src.url);
  await sv.button('Coller la réponse').click();
  await sv.dialog().locator('textarea.code').first().fill(answer.reply);
  await sv.dialogButton('Vérifier').click();
  await sv.dialog().getByText(h.env.email).waitFor({ timeout: 60000 });
  await sv.dialogButton('Approuver et brancher').click();
  await sv.dialog().getByText('n’autorise pas les webhooks vers sa propre adresse').waitFor({ timeout: 60000 });
  await shootPage(sv, 'webhook-refuse');
  const said = (await sv.dialog().innerText()).replace(/\s+/g, ' ');
  console.log(`Le widget dit : ${said.slice(said.indexOf('Grist a refusé'), said.indexOf('Grist a refusé') + 420)}`);
  assert.ok(/administrateur de l’instance/.test(said), 'le texte dit à qui écrire');
  assert.ok(!/Seul un propriétaire/.test(said), 'pas pris pour un manque de droits');
  assert.equal((await h.webhooks(src.doc)).length, 0, 'aucun webhook créé');
  console.log('ATTENDU : refus de l\'adresse dit clairement, rien de branché … OUI');
} finally {
  await h.close();
}
