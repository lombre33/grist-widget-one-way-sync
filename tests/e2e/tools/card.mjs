// Outil de diagnostic : ouvre le widget d'un document des tests de charge (par le début de son nom) et imprime le texte de
// l'onglet demandé. Usage : node tests/e2e/tools/card.mjs "Valeurs étranges CIBLE" Recevoir
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const env = JSON.parse(await readFile('/home/claude/grist-widget-one-way-sync/tests/e2e/.env.json','utf8'));
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
import { createServer } from 'node:http'; import { join, extname } from 'node:path';
const ROOT='/home/claude/grist-widget-one-way-sync';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = createServer(async (req,res)=>{ const path = decodeURIComponent(new URL(req.url,'http://x').pathname); try { let body = await readFile(join(ROOT,path)); if (path==='/index.html') body = String(body).replaceAll('https://grist.numerique.gouv.fr', `${env.grist} https://grist.numerique.gouv.fr`); if (path==='/js/config.js') body = String(body).replace('GRIST_ORIGINS = [', `GRIST_ORIGINS = ['${env.grist}', `); res.writeHead(200,{'Content-Type':TYPES[extname(path)]||'application/octet-stream'}); res.end(body);} catch { res.writeHead(404); res.end(); } });
const sec = (await call('GET', `/docs/${d.id}/tables/_grist_Views_section/records`)).records.find(r => r.fields.parentKey === 'custom');
const port = Number(new URL(JSON.parse(JSON.parse(sec.fields.options).customView).url).port);
await new Promise(r=>server.listen(port,r));
await page.goto(`${TEAM}/doc/${d.id}/p/${view.id}`);
const w = page.frameLocator('iframe').first();
await w.locator('.topbar').waitFor({timeout:60000});
if (tab) await w.getByRole('tab', {name: tab}).click().catch(()=>{});
await page.waitForTimeout(Number(process.env.WAIT||12000));
console.log((await w.locator('body').innerText()).replace(/\n+/g,' | '));
await page.screenshot({path:`/tmp/claude-0/scratch/card-${name.replace(/\W+/g,'_')}.png`});
await browser.close(); server.close();
