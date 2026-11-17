// Les captures du guide « widget dans le document » (docs/09-widget-dans-le-document.md) : le parcours réel dans un Grist
// (Grist 1.7), refait à chaque changement de l'interface de Grist ou du widget. Un Grist neuf et son fichier d'environnement
// (tests/e2e/start-grist.sh, ou le Grist extrait de l'image : voir tests/e2e/builder.mjs), puis
//   ENV_FILE=.env-builder.json node tests/tools/figures-widget-dans-le-document.mjs
// Images écrites dans docs/images/widget-doc-*.png (échelle 2). Le cadre rouge et la bande « Authentication is not enforced » (le
// mode d'essai de Grist) sont posés ou retirés dans la page, jamais dans le widget.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from '../../builder/build.mjs';
import { ROOT, gristApi } from '../e2e/shared.mjs';

const ENV_FILE = process.env.ENV_FILE || '.env.json';
const OUT = join(ROOT, 'docs/images');
const env = JSON.parse(await readFile(join(ROOT, 'tests/e2e', ENV_FILE), 'utf8'));
const team = `${env.grist}/o/${env.team}`;
const { api } = gristApi(env);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const page0 = await build({ instances: [env.grist], compact: true });
const workspace = (await api('GET', `/orgs/${env.team}/workspaces`))[0].id;
const doc = await api('POST', `/workspaces/${workspace}/docs`, { name: 'Mon document' });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1180, height: 740 }, locale: 'fr-FR', deviceScaleFactor: 2 });
const page = await context.newPage();
await page.goto(`${env.grist}/test/login?username=${env.email}&name=Test&next=${env.grist}/`);
await page.goto(`${team}/doc/${doc}`);
await page.locator('.test-dp-add-new').waitFor();

// Retire la bande du mode d'essai ; pose (ou ôte) un cadre rouge autour de la zone donnée (rectangle en pixels de la page).
async function clean() {
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('div')) if (el.children.length === 0 && el.textContent === 'Authentication is not enforced') el.style.display = 'none';
  });
}
async function frame(...boxes) {
  await page.evaluate((list) => {
    document.querySelectorAll('.figure-frame').forEach(n => n.remove());
    for (const b of list) {
      const n = document.createElement('div');
      n.className = 'figure-frame';
      n.style.cssText = `position:fixed;left:${b.x - 6}px;top:${b.y - 6}px;width:${b.width + 12}px;height:${b.height + 12}px;border:3px solid #e03131;border-radius:6px;z-index:99999;pointer-events:none`;
      document.body.appendChild(n);
    }
  }, boxes);
}
const union = async (...locators) => {
  const boxes = [];
  for (const l of locators) boxes.push(await l.first().boundingBox());
  const x = Math.min(...boxes.map(b => b.x)); const y = Math.min(...boxes.map(b => b.y));
  return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x, height: Math.max(...boxes.map(b => b.y + b.height)) - y };
};
const shot = async (name) => { await clean(); await sleep(300); await page.screenshot({ path: join(OUT, `widget-doc-${name}.png`) }); console.log(`widget-doc-${name}.png`); };

// 1. Ajouter une page.
await page.locator('.test-dp-add-new').click();
await sleep(600);
await frame(await union(page.getByText('Ajouter une page').first()));
await shot('1-ajouter-une-page');

// 2. Le choix « Créez le vôtre ».
await page.getByText('Ajouter une page').first().click();
const creator = page.locator('.test-wselect-type').filter({ hasText: 'Créez le vôtre' });
await creator.waitFor();
// L'astuce de Grist qui recouvre le choix des données : masquée pour de bon, puis fermée.
const tip = page.getByText('Masquer les astuces');
if (await tip.count()) { await tip.first().click(); await page.getByRole('button', { name: /J.ai compris/ }).click(); }
await sleep(500);
await frame(await union(creator));
await shot('2-creez-le-votre');

// 3. Le code collé dans l'éditeur, enregistré.
await creator.click();
await page.locator('.test-wselect-table').filter({ hasText: 'Table1' }).click();
await page.getByRole('button', { name: 'Ajouter une page' }).last().click();
await page.locator('.ace_editor').waitFor({ timeout: 30000 });
await page.evaluate((html) => window.ace.edit(document.querySelector('.ace_editor')).setValue(html, -1), page0.html);
await sleep(800);
await frame(await union(page.locator('.ace_editor')));
await shot('3-coller-le-code');
await page.keyboard.press('Control+s');
await sleep(6000);

// 4. L'accès complet, dans le panneau de droite.
await page.mouse.click(700, 500);
await page.locator('.test-right-opener').click().catch(async () => { await page.mouse.click(1135, 22); });
await sleep(1500);
const accept = page.getByRole('button', { name: 'Accepter' });
await accept.waitFor({ timeout: 20000 });
await frame(await union(page.getByText(/Le widget a besoin de full access/), accept, page.getByRole('button', { name: 'Refuser' })));
await shot('4-acces-complet');

// 5. Le widget démarré.
await accept.click();
await sleep(7000);
await page.getByText(/Fermer l.éditeur/).first().click();
await sleep(1500);
await frame();
await page.evaluate(() => document.querySelectorAll('.figure-frame').forEach(n => n.remove()));
await shot('5-widget-demarre');
await browser.close();
