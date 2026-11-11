// Outil de diagnostic : ouvre le widget d'un document des tests de charge (par le début de son nom) et imprime le texte de
// l'onglet demandé. Usage : node tests/e2e/tools/card.mjs "Valeurs étranges CIBLE" Recevoir
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { ROOT, serveWidget } from '../shared.mjs';
const env = JSON.parse(await readFile(`${ROOT}/tests/e2e/.env.json`,'utf8'));
const TEAM = `${env.grist}/o/${env.team}`;
const [,, name, tab] = process.argv;
const call = async (m,p) => (await fetch(`${TEAM}/api${p}`, {method:m, headers:{Authorization:`Bearer ${env.apiKey}`}})).json();
const ws = await call('GET',`/orgs/${env.team}/workspaces`);
const d = ws[0].docs.filter(x=>x.name.startsWith(name)).pop();
const views = await call('GET', `/docs/${d.id}/tables/_grist_Views/records`);
const view = views.records.find(v=>v.fields.name==='Synchro');
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale:'fr-FR', viewport:{width:1100,height:900}});
const page = await ctx.newPage();
await page.goto(`${env.grist}/test/login?username=${env.email}&name=Test&next=${env.grist}/`);
// Le widget est servi sur le port inscrit dans le document.
const sec = (await call('GET', `/docs/${d.id}/tables/_grist_Views_section/records`)).records.find(r => r.fields.parentKey === 'custom');
const port = Number(new URL(JSON.parse(JSON.parse(sec.fields.options).customView).url).port);
const server = await serveWidget({ env, port });
await page.goto(`${TEAM}/doc/${d.id}/p/${view.id}`);
const w = page.frameLocator('iframe').first();
await w.locator('.topbar').waitFor({timeout:60000});
if (tab) await w.getByRole('tab', {name: tab}).click().catch(()=>{});
await page.waitForTimeout(Number(process.env.WAIT||12000));
console.log((await w.locator('body').innerText()).replace(/\n+/g,' | '));
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/card-${name.replace(/\W+/g, '_')}.png` });
await browser.close(); server.close();
