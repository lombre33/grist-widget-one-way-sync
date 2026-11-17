// Essai de bout en bout du mode « widget dans le document » (builder/) dans un vrai Grist : la page construite par
// builder/build.mjs (version compacte, que l'API de Grist accepte : 1 Mo au plus par requête) est posée dans une section
// Widget Creator de deux documents, puis une synchro à sens unique est montée comme le fait une personne (export, invitation,
// réception, lien du formulaire, réponse, approbation, envoi de l'existant), et une modification de la SOURCE arrive dans
// la CIBLE par le webhook. Le but : prouver que le widget tourne, tel quel, dans le cadre `sandbox="allow-scripts"` que Grist
// donne à un widget du Creator (origine opaque, pas de stockage, pas de verrous Web), et dire ce qui ne marche pas.
//
// Mode d'emploi : un Grist neuf et son fichier d'environnement (tests/e2e/start-grist.sh avec Docker, ou, sans Docker, le Grist
// extrait de l'image : `homeDb` dans le fichier d'environnement donne la base de Grist), puis
//   ENV_FILE=.env-builder.json node tests/e2e/builder.mjs        (SHOTS=<dossier> : captures)
import { build } from '../../builder/build.mjs';
import { createHarness, log, shootPage, sleep } from './harness.mjs';

const ENV_FILE = process.env.ENV_FILE || '.env.json';
const env = JSON.parse(await (await import('node:fs/promises')).readFile(new URL(`./${ENV_FILE}`, import.meta.url), 'utf8'));
const page = await build({ instances: [env.grist], compact: true });
log(`page construite : ${page.modules} modules, ${(Buffer.byteLength(page.html) / 1024).toFixed(0)} Ko (version ${page.version})`);

const h = await createHarness({ envFile: ENV_FILE, creatorHtml: page.html });
const checks = [];
const check = (what, ok, detail = '') => { checks.push({ what, ok }); log(`${ok ? 'OK ' : 'ÉCHEC'} ${what}${detail ? ` : ${detail}` : ''}`); };

try {
  const rows = 12;
  const p = await h.pair({
    name: 'Creator', table: 'Contacts', columns: [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }, { id: 'Age', type: 'Int' }],
    rows, makeRow: i => ({ Nom: `Personne ${i}`, Ville: i % 2 ? 'Lyon' : 'Brest', Age: 20 + i }), send: 'wait',
    // Sur un document neuf, « Nouvel export » fait poser les règles d'accès : Grist recharge le document, et l'assistant, que le widget
    // rouvre d'ordinaire par une préférence du navigateur, ne se rouvre pas ici (le cadre du Creator n'a pas de stockage qui survive à
    // un rechargement) : la personne retombe sur l'accueil et recommence. Limite dite dans le guide ; l'essai la passe d'abord.
    beforeExport: async ({ src }) => {
      const first = await h.newView('protection');
      await h.login(first);
      await first.open(src.url);
      await first.widget().locator('.tile', { hasText: 'Envoyer des tables' }).click();
      await first.button('Nouvel export').click();
      await h.waitFor(async () => (await h.records(src.doc, '_grist_ACLRules')).length > 1, 'règles d’accès posées', 60000);
      await sleep(5000);
      await first.page.close();
      log('document SOURCE protégé (rechargé une fois, assistant non rouvert : limite du mode)');
    },
  });
  log(`SOURCE ${p.src.doc}, CIBLE ${p.dst.doc}, export ${p.exportId}`);
  await shootPage(p.sv, 'creator-source-envoi');

  const received = await h.waitFor(async () => {
    const n = await h.count(p.dst.doc, 'Contacts');
    return n === rows && n;
  }, `${rows} lignes dans la table reçue`, 120000).catch(() => null);
  const dest = (await h.records(p.dst.doc, '_grist_Tables')).map(t => t.tableId);
  check('l’envoi de l’existant arrive dans la CIBLE', Boolean(received), `tables de la CIBLE : ${dest.join(', ')}`);

  // Une modification de la SOURCE : le webhook la dépose dans le journal, la page ouverte de la CIBLE la recopie.
  const first = (await h.records(p.src.doc, 'Contacts'))[0];
  await h.applyActions(p.src.doc, [['UpdateRecord', 'Contacts', first.id, { Ville: 'Nantes' }]]);
  const changed = await h.waitFor(async () => {
    const found = await h.sql(p.dst.doc, 'select Ville from "Contacts" where Nom = ?', ['Personne 0']);
    return found[0]?.Ville === 'Nantes';
  }, 'modification arrivée dans la CIBLE', 120000).catch(() => false);
  check('une modification de la SOURCE arrive dans la CIBLE', Boolean(changed));
  await shootPage(p.dv, 'creator-cible-recue');

  // Limites du cadre de Grist (sandbox="allow-scripts", sans allow-popups ni allow-same-origin), dites dans le guide : si Grist les
  // lève un jour, cet essai échoue et le guide est à relire.
  const popup = p.dv.page.waitForEvent('popup', { timeout: 4000 }).then(() => true, () => false);
  await p.dv.widget().getByRole('link', { name: /Document source/ }).click();
  check('limite : le lien vers l’autre document ne s’ouvre pas', !(await popup));
  const frame = p.dv.page.frames().find(f => f.url() === 'about:srcdoc');
  const sandbox = await p.dv.page.locator('iframe').first().getAttribute('sandbox');
  check('limite : le cadre est « allow-scripts » seul, d’origine opaque', sandbox === 'allow-scripts' && await frame.evaluate(() => location.origin) === 'null', `sandbox="${sandbox}"`);

  const text = await p.dv.text();
  check('la carte de la CIBLE ne montre aucune erreur', !/erreur|échec/i.test(text), text.slice(0, 200));
  check('aucune erreur du widget dans la console', h.problems.length === 0, h.problems.slice(0, 3).join(' | '));
} catch (error) {
  check('parcours', false, error.message);
} finally {
  await h.close();
}
const failed = checks.filter(c => !c.ok);
log(failed.length ? `${failed.length} échec(s) sur ${checks.length}` : `${checks.length} contrôles verts`);
process.exit(failed.length ? 1 : 0);
