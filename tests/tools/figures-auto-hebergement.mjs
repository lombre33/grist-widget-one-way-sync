// Fabrique les figures du guide docs/08-auto-hebergement.md : quatre schémas (SVG, puis PNG rendus par Chromium) et la
// capture réelle de l'écran que montre le widget quand son instance n'est pas dans sa liste. Les schémas ont les couleurs
// de ceux de docs/06 (blanc : ce qui existe ; gris : natif de Grist ; bleu : ce que vous faites). Les lignes de code de la
// figure « trois modifications » sont lues dans js/config.js et index.html : si elles changent, la figure suit.
//
// Usage (Playwright installé, voir tests/e2e) :  node tests/tools/figures-auto-hebergement.mjs
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'docs', 'images');

const COLORS = {
  blue: '#2f6fed', navy: '#1a3f94', ink: '#1b2430', muted: '#5f6b7e', panel: '#f4f6fa', grey: '#eef1f6', line: '#c3cad6',
  white: '#ffffff', widget: '#e8f0fe', amber: '#fcf1dc', amberLine: '#e0b45a', amberInk: '#8a5a00', red: '#b3261e', redBg: '#fdecea',
  code: '#f6f8fa', green: '#1e7b4a', greenBg: '#e6f4ec',
};
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Liberation Sans", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const FILLS = { white: ['#ffffff', COLORS.line], grey: [COLORS.grey, COLORS.line], blue: [COLORS.widget, COLORS.blue], amber: [COLORS.amber, COLORS.amberLine], red: [COLORS.redBg, COLORS.red], green: [COLORS.greenBg, COLORS.green] };

// Une boîte : titre en gras, lignes en gris, pastille numérotée facultative. `h` se calcule si absent.
function box({ x, y, w, h, kind = 'white', title, lines = [], num, ink = COLORS.ink, mono = false }) {
  const [fill, stroke] = FILLS[kind];
  const left = num ? x + 46 : x + 16; // titre ; les lignes partent toujours de x + 16
  const height = h ?? 22 + (title ? 28 : 0) + lines.length * 19 + 8;
  const parts = [`<rect x="${x}" y="${y}" width="${w}" height="${height}" rx="9" fill="${fill}" stroke="${stroke}" stroke-width="${kind === 'blue' ? 2 : 1.4}"/>`];
  if (num) parts.push(`<circle cx="${x + 24}" cy="${y + 26}" r="12.5" fill="${COLORS.blue}"/><text x="${x + 24}" y="${y + 31}" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">${num}</text>`);
  let ty = y + 31;
  if (title) { parts.push(`<text x="${left}" y="${ty}" font-size="15.5" font-weight="700" fill="${ink}">${esc(title)}</text>`); ty += 21; }
  for (const line of lines) {
    parts.push(`<text x="${x + 16}" y="${ty}" font-size="13" fill="${kind === 'amber' ? COLORS.amberInk : COLORS.muted}"${mono ? ` font-family='${MONO}'` : ''}>${esc(line)}</text>`);
    ty += 19;
  }
  return { svg: parts.join(''), h: height };
}

const arrow = (x1, y1, x2, y2, { color = COLORS.blue, marker = 'ah', dashed = false } = {}) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2.4"${dashed ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#${marker})"/>`;
const label = (x, y, text, { anchor = 'middle', size = 12.5, color = COLORS.muted, bold = false } = {}) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="${size}" fill="${color}"${bold ? ' font-weight="700"' : ''}>${esc(text)}</text>`;
const panel = (x, y, w, h, title, sub) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.line}" stroke-width="1.5"/>`
  + `<text x="${x + 18}" y="${y + 28}" font-size="17" font-weight="700" fill="${COLORS.ink}">${esc(title)}</text>`
  + (sub ? `<text x="${x + 18}" y="${y + 47}" font-size="13" fill="${COLORS.muted}">${esc(sub)}</text>` : '');

function svg({ w, h, title, desc, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d" font-family='${FONT}'>\n`
    + `<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>\n`
    + `<defs><marker id="ah" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 z" fill="${COLORS.blue}"/></marker>`
    + `<marker id="ar" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 z" fill="${COLORS.red}"/></marker>`
    + `<marker id="ag" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 z" fill="${COLORS.muted}"/></marker></defs>\n`
    + `<rect width="${w}" height="${h}" fill="#ffffff"/>\n${body}\n</svg>\n`;
}

const legend = (x, y, items) => items.map(([kind, text], i) => {
  const [fill, stroke] = FILLS[kind];
  return `<rect x="${x}" y="${y + i * 30}" width="34" height="20" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>${label(x + 46, y + 15 + i * 30, text, { anchor: 'start', size: 13.5, color: COLORS.ink })}`;
}).join('');

// 1. Le principe : d'où vient le code, où il est servi, comment il arrive dans Grist.
function principle() {
  const parts = [];
  parts.push(panel(20, 20, 960, 350, 'Le parcours, de la copie au document', 'Rien de ce qui suit ne se configure dans le widget : tout est dans votre copie et dans les réglages de votre instance'));
  parts.push(box({ x: 40, y: 80, w: 180, kind: 'white', title: 'Dépôt de référence', lines: ['GitHub, code lisible,', 'sans dépendance', 'ni étape de build'], h: 112 }).svg);
  parts.push(box({ x: 270, y: 80, w: 190, kind: 'blue', num: '1', title: 'Votre copie', lines: ['fork ou copie interne,', 'fixée sur un commit relu,', 'plus 3 modifications'], h: 112 }).svg);
  parts.push(box({ x: 510, y: 80, w: 190, kind: 'blue', num: '2', title: 'Hébergement', lines: ['GitHub Pages ou serveur', 'interne, en https :', 'des fichiers statiques'], h: 112 }).svg);
  parts.push(arrow(220, 136, 268, 136), arrow(460, 136, 508, 136), arrow(700, 136, 748, 136));
  parts.push(label(244, 124, 'copier', { size: 12 }), label(484, 124, 'publier', { size: 12 }), label(724, 124, 'URL', { size: 12 }));
  parts.push(`<rect x="750" y="66" width="214" height="288" rx="10" fill="#fff" stroke="${COLORS.line}" stroke-width="1.5" stroke-dasharray="6 5"/>`);
  parts.push(label(857, 90, 'Votre instance Grist', { size: 14, color: COLORS.ink, bold: true }));
  parts.push(box({ x: 762, y: 104, w: 190, kind: 'blue', num: '3', title: 'Ajouter le widget', lines: ['URL personnalisée', '(chaque personne)', 'ou galerie (admin)'], h: 112 }).svg);
  parts.push(box({ x: 762, y: 224, w: 190, kind: 'grey', num: '4', title: 'Webhooks', lines: ['ALLOWED_WEBHOOK_', 'DOMAINS, réglé par', 'l’administrateur'], h: 112 }).svg);
  parts.push(box({ x: 40, y: 212, w: 680, kind: 'amber', title: 'À savoir', lines: ['Aucune donnée ne passe par votre hébergement : le navigateur y télécharge le code du widget,', 'puis ne parle plus qu’à votre instance.', 'Une copie est une version relue : vous décidez quand elle change (voir « Suivre les mises à jour »).'], h: 108 }).svg);
  parts.push(legend(40, 386, [['blue', 'ce que vous faites']]));
  parts.push(legend(330, 386, [['grey', 'ce que fait l’administrateur de l’instance']]));
  parts.push(legend(720, 386, [['white', 'ce qui existe déjà']]));
  return svg({ w: 1000, h: 430, title: 'Héberger sa propre copie du widget', desc: 'Du dépôt de référence à votre copie modifiée, publiée en https, puis ajoutée dans Grist ; l’administrateur autorise les webhooks de l’instance vers elle-même.', body: parts.join('') });
}

// 2. Les deux verrous : chaque requête doit passer le code puis le navigateur.
function locks() {
  const parts = [];
  parts.push(panel(20, 20, 960, 410, 'Pourquoi la liste des instances est écrite en deux endroits', 'Une requête du widget ne part que si le code et le navigateur sont d’accord, et ni l’un ni l’autre ne lit un réglage venu de la page ou d’un lien'));
  parts.push(box({ x: 40, y: 92, w: 150, kind: 'white', title: 'Le widget', lines: ['votre copie, dans', 'un cadre de Grist'], h: 118 }).svg);
  parts.push(box({ x: 240, y: 92, w: 250, kind: 'blue', num: '1', title: 'Le code', lines: ['js/config.js : GRIST_ORIGINS', 'gristFetch refuse toute adresse', 'hors de la liste, et n’envoie', 'jamais de cookie'], h: 118 }).svg);
  parts.push(box({ x: 540, y: 92, w: 250, kind: 'blue', num: '2', title: 'Le navigateur', lines: ['index.html : politique de', 'sécurité (script-src, connect-src)', 'ne laisse sortir le widget que', 'vers les mêmes instances'], h: 118 }).svg);
  parts.push(box({ x: 840, y: 92, w: 120, kind: 'grey', title: 'Instance', lines: ['votre Grist'], h: 118 }).svg);
  parts.push(arrow(190, 151, 238, 151), arrow(490, 151, 538, 151), arrow(790, 151, 838, 151));
  parts.push(label(214, 140, 'liste ?', { size: 11.5 }), label(514, 140, 'liste ?', { size: 11.5 }), label(814, 140, 'ok', { size: 11.5 }));
  const refused = (x, text1, text2) => `<rect x="${x}" y="262" width="250" height="64" rx="9" fill="${COLORS.redBg}" stroke="${COLORS.red}" stroke-width="1.4"/>`
    + label(x + 16, 288, text1, { anchor: 'start', size: 14.5, color: COLORS.red, bold: true }) + label(x + 16, 309, text2, { anchor: 'start', size: 12.5, color: COLORS.red });
  parts.push(refused(240, 'Autre adresse : refusée', 'erreur « autre instance »'));
  parts.push(refused(540, 'Autre adresse : bloquée', 'erreur réseau dans la console'));
  parts.push(arrow(365, 210, 365, 260, { color: COLORS.red, marker: 'ar' }), arrow(665, 210, 665, 260, { color: COLORS.red, marker: 'ar' }));
  parts.push(box({ x: 40, y: 344, w: 920, kind: 'amber', title: 'Les deux listes disent la même chose', lines: ['npm test le vérifie : une instance ajoutée à l’une et oubliée dans l’autre fait échouer l’essai de cohérence (tests/unit/instances.test.mjs).'], h: 66 }).svg);
  return svg({ w: 1000, h: 450, title: 'Deux verrous : le code et le navigateur', desc: 'Chaque requête du widget doit passer deux contrôles, la liste GRIST_ORIGINS de js/config.js puis la politique de sécurité de index.html, avant d’atteindre l’instance Grist.', body: parts.join('') });
}

// 3. Les trois modifications, lues dans les vrais fichiers.
async function threeEdits() {
  const config = await readFile(join(ROOT, 'js', 'config.js'), 'utf8');
  const index = await readFile(join(ROOT, 'index.html'), 'utf8');
  const originsLine = config.split('\n').find(line => line.startsWith('export const GRIST_ORIGINS'));
  const widgetLine = config.split('\n').find(line => line.startsWith('const WIDGET_URL'));
  const csp = index.match(/Content-Security-Policy" content="([^"]*)"/)[1];
  const directive = name => `${csp.split(';').map(d => d.trim()).find(d => d.startsWith(name))};`;
  const instance = 'https://grist.exemple.org';
  const edits = [
    { num: '1', file: 'js/config.js', what: 'la liste des instances (GRIST_ORIGINS)',
      before: [originsLine], after: [`export const GRIST_ORIGINS = ['${instance}'];`], hl: [instance] },
    { num: '2', file: 'index.html', what: 'la politique de sécurité : scripts et requêtes',
      before: [directive('script-src'), directive('connect-src')],
      after: [`script-src 'self' ${instance}/grist-plugin-api.js;`, `connect-src 'self' ${instance};`], hl: [instance] },
    { num: '3', file: 'js/config.js', what: 'l’adresse que donnent les consignes (WIDGET_URL)',
      before: [widgetLine], after: ["const WIDGET_URL = 'https://widgets.exemple.org/syncplus/';"], hl: ['https://widgets.exemple.org/syncplus/'] },
  ];
  const codeLine = (x, y, text, hl, kind) => {
    const color = kind === 'before' ? COLORS.muted : COLORS.ink;
    const found = hl.find(h => text.includes(h));
    const body = found
      ? text.split(found).map(esc).join(`<tspan font-weight="700" fill="${COLORS.navy}">${esc(found)}</tspan>`)
      : esc(text);
    return `<text x="${x}" y="${y}" font-family='${MONO}' font-size="11.8" fill="${color}" xml:space="preserve">${body}</text>`;
  };
  const parts = [];
  let y = 20;
  for (const edit of edits) {
    const rows = edit.before.length;
    const height = 70 + rows * 2 * 22 + 24;
    parts.push(`<rect x="20" y="${y}" width="960" height="${height}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.line}" stroke-width="1.5"/>`);
    parts.push(`<circle cx="46" cy="${y + 30}" r="12.5" fill="${COLORS.blue}"/><text x="46" y="${y + 35}" text-anchor="middle" font-size="14" font-weight="700" fill="#fff">${edit.num}</text>`);
    parts.push(`<text x="70" y="${y + 35}" font-size="16" font-weight="700" fill="${COLORS.ink}">${esc(edit.file)}</text>`);
    parts.push(label(70 + edit.file.length * 8.8 + 12, y + 35, `: ${edit.what}`, { anchor: 'start', size: 14, color: COLORS.muted }));
    let ly = y + 70;
    parts.push(`<rect x="40" y="${ly - 20}" width="920" height="${rows * 22 + 10}" rx="7" fill="${COLORS.grey}"/>`);
    parts.push(label(52, ly - 4, 'avant', { anchor: 'start', size: 11.5, color: COLORS.muted, bold: true }));
    edit.before.forEach((line, i) => { parts.push(codeLine(110, ly - 4 + i * 22, line, [], 'before')); });
    ly += rows * 22 + 18;
    parts.push(`<rect x="40" y="${ly - 20}" width="920" height="${rows * 22 + 10}" rx="7" fill="${COLORS.widget}" stroke="${COLORS.blue}" stroke-width="1.4"/>`);
    parts.push(label(52, ly - 4, 'après', { anchor: 'start', size: 11.5, color: COLORS.navy, bold: true }));
    edit.after.forEach((line, i) => { parts.push(codeLine(110, ly - 4 + i * 22, line, edit.hl, 'after')); });
    y += height + 14;
  }
  parts.push(label(500, y + 14, 'Exemple avec une instance « grist.exemple.org » et un hébergement « widgets.exemple.org ». Rien d’autre ne change.', { size: 13.5, color: COLORS.muted }));
  return svg({ w: 1000, h: y + 34, title: 'Les trois modifications d’une copie', desc: 'Dans js/config.js la liste des instances et l’adresse du widget ; dans index.html les directives script-src et connect-src de la politique de sécurité ; chacune montrée avant et après.', body: parts.join('') });
}

// 4. Les mises à jour : on lit ce qui change avant de reprendre.
function updates() {
  const parts = [];
  parts.push(panel(20, 20, 960, 290, 'Suivre les mises à jour, une version relue à la fois', 'Vos trois modifications sont dans un seul commit : elles se reposent seules sur la nouvelle version'));
  const steps = [
    ['1', 'white', 'Voir', ['git fetch amont', 'git log, git diff', 'sur amont/main']],
    ['2', 'blue', 'Relire', ['js/, i18n/, css/ et', 'index.html : le code', 'exécuté chez vous']],
    ['3', 'blue', 'Reprendre', ['git rebase', 'amont/main (vos 3', 'modifications suivent)']],
    ['4', 'blue', 'Tester', ['npm test, listes', 'd’instances comprises']],
    ['5', 'blue', 'Publier', ['étiquette, puis', 'publication de', 'la copie']],
  ];
  steps.forEach(([num, kind, title, lines], i) => {
    const x = 36 + i * 188;
    parts.push(box({ x, y: 80, w: 166, kind, num, title, lines, h: 112 }).svg);
    if (i < steps.length - 1) parts.push(arrow(x + 166, 136, x + 186, 136));
  });
  parts.push(box({ x: 36, y: 212, w: 912, kind: 'amber', title: 'Dans les documents', lines: ['Chaque document reprend la nouvelle version en rechargeant la page. Deux documents qui s’envoient des données', 'doivent avoir la même version : le widget le dit (« L’autre document utilise la version … ») et refuse un code plus récent que lui.'], h: 82 }).svg);
  return svg({ w: 1000, h: 330, title: 'Suivre les mises à jour', desc: 'On lit ce qui change dans le dépôt de référence, on relit le code, on reprend la nouvelle version sous ses trois modifications, on teste, puis on publie.', body: parts.join('') });
}

// 5. Les captures réelles. Un petit serveur sert le dépôt tel quel ; `adjust` réécrit en mémoire une valeur
// de js/config.js, comme le fait un hébergeur qui a fait ses trois modifications.
async function serveRepo({ adjust = (path, body) => body, host = '' } = {}) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/host.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(host);
    }
    try {
      const raw = await readFile(join(ROOT, path));
      const body = /\.(png|jpg)$/.test(path) ? raw : adjust(path, String(raw));
      res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch (e) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, resolve));
  return server;
}

// Le widget dans un cadre dont l'instance n'est pas dans sa liste, API des widgets injoignable.
async function startScreen(browser) {
  const server = await serveRepo({ host: '<!doctype html><body style="margin:0;background:#fff"><iframe id="w" src="/index.html" style="border:0;width:780px;height:190px;display:block"></iframe></body>' });
  const context = await browser.newContext({ viewport: { width: 780, height: 190 }, deviceScaleFactor: 2, locale: 'fr-FR' });
  const page = await context.newPage();
  // Le réseau ne laisse pas passer l'API des widgets : c'est ce que voit une copie dont la liste n'a pas l'instance.
  await page.route('**/grist-plugin-api.js', route => route.abort());
  await page.goto(`http://localhost:${server.address().port}/host.html`);
  const frame = page.frameLocator('#w');
  await frame.getByText(/ne peut pas charger l.API de Grist/).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(OUT, 'auto-heberger-instance-absente.png') });
  await context.close();
  server.close();
}

// La copie ouverte seule dans un onglet, hors de Grist : elle donne l'adresse de WIDGET_URL, donc celle de la copie.
async function outsideScreen(browser) {
  const adjust = (path, body) => (path === '/js/config.js' ? body.replace(/const WIDGET_URL = '[^']+'/, "const WIDGET_URL = 'https://widgets.exemple.org/syncplus/'") : body);
  const server = await serveRepo({ adjust });
  const context = await browser.newContext({ viewport: { width: 780, height: 230 }, deviceScaleFactor: 2, locale: 'fr-FR' });
  const page = await context.newPage();
  await page.goto(`http://localhost:${server.address().port}/index.html`);
  await page.getByText(/Ce widget s.ouvre dans Grist/).waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(OUT, 'auto-heberger-hors-de-grist.png') });
  await context.close();
  server.close();
}

async function renderPngs(browser, names) {
  for (const name of names) {
    const file = join(OUT, `${name}.svg`);
    const text = await readFile(file, 'utf8');
    const [w, h] = text.match(/viewBox="0 0 (\d+) (\d+)"/).slice(1).map(Number);
    const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.setContent(`<body style="margin:0">${text}</body>`);
    await page.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: w, height: h } });
    await context.close();
  }
}

const figures = { 'auto-heberger-principe': principle(), 'auto-heberger-verrous': locks(), 'auto-heberger-trois-modifications': await threeEdits(), 'auto-heberger-mises-a-jour': updates() };
for (const [name, text] of Object.entries(figures)) await writeFile(join(OUT, `${name}.svg`), text);
const browser = await chromium.launch();
await renderPngs(browser, Object.keys(figures));
await startScreen(browser);
await outsideScreen(browser);
await browser.close();
console.log('Figures écrites dans docs/images :', [...Object.keys(figures), 'auto-heberger-instance-absente (png)', 'auto-heberger-hors-de-grist (png)'].join(', '));
