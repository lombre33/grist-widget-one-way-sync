#!/usr/bin/env node
// Construit UNE page HTML autonome du widget, à coller dans un widget « Widget Creator » de Grist (widget dans le
// document : le code vit dans le document, il n'y a rien à héberger). Aucune dépendance, aucun outil de build : ce
// fichier lit les sources du dépôt (js/, i18n/, css/, index.html), applique quelques retouches nommées (PATCHES),
// range les modules dans l'ordre de leurs dépendances, et écrit la page. Le résultat ne dépend que des sources et des
// options : deux builds identiques donnent le même fichier, octet pour octet.
//
// Usage : node builder/build.mjs [--instance https://grist.exemple.org]... [--widget-url <adresse>] [--lang fr|en]
//                                 [--compact] [--out <fichier>]
//   --instance   instance Grist (origine seule, https) ; répétable ; d'office, la liste de js/config.js
//   --widget-url adresse que le widget donne dans ses consignes ; d'office, WIDGET_URL de js/config.js
//   --lang       langue de départ (fr ou en) ; d'office, celle du navigateur
//   --compact    modules compressés (gzip, base64) : environ 4 fois plus petit, mais illisible
//   --out        fichier écrit ; d'office builder/dist/syncplus-creator.html
//
// Ce que la page change par rapport au widget servi (voir docs/09-widget-dans-le-document.md) : tout est dans `patches` et dans
// builder/loader.js ; aucune autre ligne du widget n'est touchée, et le widget servi, lui, ne change pas.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const ENTRY_MODULE = 'js/main.js';

const sha256 = text => createHash('sha256').update(text).digest('base64');
const sha256Hex = text => createHash('sha256').update(text).digest('hex');

// Une origine propre : https (ou http sur localhost, pour les essais), sans chemin ni barre finale. Le texte est écrit tel quel
// dans la politique de sécurité de la page et dans js/config.js : seuls des caractères de nom d'hôte et un port passent (un « ; »,
// un « ' » ou une espace refermerait une directive ou un texte).
const ORIGIN = /^(https?):\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::([0-9]{1,5}))?$/i;
export function checkOrigin(origin) {
  const match = ORIGIN.exec(String(origin));
  const local = match && ['localhost', '127.0.0.1'].includes(match[2].toLowerCase());
  if (!match || !(match[1] === 'https' || local) || (match[3] && Number(match[3]) > 65535)) {
    throw new Error(`« ${origin} » : une origine https seule (par exemple https://grist.exemple.org), sans chemin ni barre finale`);
  }
  return origin;
}

const dataUri = async (root, path, type) => `data:${type};base64,${(await readFile(join(root, path))).toString('base64')}`;

// Les retouches, nommées. Chacune remplace un texte qui doit exister UNE fois : si le dépôt change ces lignes, le build
// s'arrête et dit laquelle (une retouche qui ne s'applique plus doit être relue, pas ignorée).
function patches({ instances, widgetUrl, images }) {
  const list = [
    // L'adresse du widget n'existe pas : le code est dans le document. `servedAt` ne sert qu'aux consignes, au diagnostic et
    // à l'ajout du widget sur une page, qui n'ont pas de sens ici.
    { name: 'adresse du widget', file: 'js/config.js',
      find: 'export const servedAt = () => `${location.origin}${location.pathname}`.replace(/index\\.html$/, \'\');',
      replace: 'export const servedAt = () => \'widget dans le document\';' },
    { name: 'origine du widget dans le diagnostic', file: 'js/config.js',
      find: 'export const servedFrom = () => ({ [BETA_URL]: \'bêta\', [WIDGET_URL]: \'officielle\' }[servedAt()] || servedAt());',
      replace: 'export const servedFrom = () => \'widget dans le document\';' },
    // La page charge déjà l'API des widgets (balise de la page, adresse relative que Grist sert à côté de lui).
    { name: 'API des widgets déjà chargée', file: 'js/main.js',
      find: 'function loadPluginApi() {\n',
      replace: 'function loadPluginApi() {\n  if (typeof grist !== \'undefined\') return Promise.resolve(); // widget dans le document : la page l\'a déjà chargée\n' },
    // Sans adresse, pas de bouton « Ajouter le widget à la page de la table reçue » ni d'avis orange qui y renvoie.
    { name: 'ajout du widget sur une page', file: 'js/target/widget-page.js',
      find: '  spots = dests.length ? await widgetSpots(dests, servedAt()).catch(() => new Map()) : new Map();',
      replace: '  spots = new Map(); // widget dans le document : pas d\'adresse à retrouver, donc pas de bouton' },
    // Les captures du tutoriel pèsent 11 Mo : la page n'en emporte aucune ; les deux petites images d'aide du lien du
    // formulaire sont écrites dans la page.
    { name: 'captures du tutoriel', file: 'js/tutorial.js',
      find: 'function figure(name) {\n',
      replace: 'function figure(name) {\n  if (name) return null; // widget dans le document : pas de captures\n' },
    { name: 'image d\'aide : partager', file: 'js/form-link.js', find: '\'img/aide-partager.png\'', replace: `'${images.share}'` },
    { name: 'image d\'aide : copier', file: 'js/form-link.js', find: '\'img/aide-copier.png\'', replace: `'${images.copy}'` },
  ];
  if (instances) {
    list.push({ name: 'instances', file: 'js/config.js',
      find: /export const GRIST_ORIGINS = \[[^\]]*\];/,
      replace: `export const GRIST_ORIGINS = [${instances.map(origin => `'${origin}'`).join(', ')}];` });
  }
  if (widgetUrl) {
    list.push({ name: 'adresse des consignes', file: 'js/config.js', find: /const WIDGET_URL = '[^']+';/, replace: `const WIDGET_URL = '${widgetUrl}';` });
  }
  return list;
}

function applyPatches(files, list) {
  for (const patch of list) {
    const text = files.get(patch.file);
    if (text === undefined) throw new Error(`Retouche « ${patch.name} » : ${patch.file} n'existe pas`);
    const count = typeof patch.find === 'string' ? text.split(patch.find).length - 1 : [...text.matchAll(new RegExp(patch.find.source, 'g'))].length;
    if (count !== 1) throw new Error(`Retouche « ${patch.name} » : ${count} occurrence(s) de son texte dans ${patch.file} (une seule attendue) : le dépôt a changé, relire builder/build.mjs`);
    files.set(patch.file, typeof patch.find === 'string' ? text.replace(patch.find, () => patch.replace) : text.replace(patch.find, () => patch.replace));
  }
}

// Les citations de modules : `import … from './x.js'`, `export … from '../y.js'` (sur plusieurs lignes aussi), `import './z.js'`.
const FROM = /^((?:import|export)\b[^;'"`]*?\bfrom\s*)(['"])(\.{1,2}\/[^'"\n]+)\2/gm;
const SIDE = /^(import\s*)(['"])(\.{1,2}\/[^'"\n]+)\2/gm;

const specifiersOf = text => [...text.matchAll(FROM), ...text.matchAll(SIDE)].map(match => match[3]);

// Ordre des modules : chacun après ceux qu'il cite (parcours en profondeur, chemins triés : le même ordre à chaque fois).
// Un cycle est refusé : le chargeur ne connaît l'adresse d'un module qu'une fois créé.
export function orderModules(files, entry) {
  const order = [];
  const state = new Map();
  const visit = (id, chain) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'doing') throw new Error(`Cycle entre modules : ${[...chain.slice(chain.indexOf(id)), id].join(' → ')} (la page du widget dans le document les charge un par un, sans cycle)`);
    state.set(id, 'doing');
    const text = files.get(id);
    if (text === undefined) throw new Error(`Module ${id} introuvable (cité par ${chain[chain.length - 1]})`);
    const deps = id.endsWith('.json') ? [] : [...new Set(specifiersOf(text).map(spec => posix.normalize(posix.join(posix.dirname(id), spec))))].sort();
    for (const dep of deps) visit(dep, [...chain, id]);
    state.set(id, 'done');
    order.push(id);
  };
  visit(entry, []);
  return order;
}

// Écrit à la place des adresses relatives la marque `@syncplus:<rang>` ; refuse ce que le chargeur ne sait pas faire.
function link(files, order) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return order.map((id) => {
    let text = files.get(id);
    if (!id.endsWith('.json')) {
      const swap = (all, head, quote, spec) => {
        const target = posix.normalize(posix.join(posix.dirname(id), spec));
        if (!rank.has(target)) throw new Error(`${id} : module ${target} absent`);
        return `${head}${quote}@syncplus:${rank.get(target)}${quote}`;
      };
      text = text.replace(FROM, swap).replace(SIDE, swap);
      if (/\bfrom\s*['"]\.{1,2}\//.test(text)) throw new Error(`${id} : une adresse de module relative n'a pas été réécrite`);
      if (/\bimport\s*\(/.test(text) || /\bimport\.meta\b/.test(text)) throw new Error(`${id} : import() et import.meta ne sont pas pris en charge par la page du widget dans le document`);
    }
    if (/<!--|<\/script/i.test(text)) throw new Error(`${id} : « <!-- » ou « </script » casserait la page`);
    return { id, text };
  });
}

async function readSources(root) {
  const files = new Map();
  for (const name of await readdir(join(root, 'js'), { recursive: true })) {
    if (name.endsWith('.js')) files.set(`js/${name.split('\\').join('/')}`, await readFile(join(root, 'js', name), 'utf8'));
  }
  // Les textes en JSON que des modules importent (`import … from '../i18n/fr.json' with { type: 'json' }`).
  for (const [id, text] of [...files]) {
    for (const spec of specifiersOf(text).filter(s => s.endsWith('.json'))) {
      const path = posix.normalize(posix.join(posix.dirname(id), spec));
      if (!files.has(path)) files.set(path, await readFile(join(root, path), 'utf8'));
    }
  }
  return files;
}

const lines = (text, width = 100) => text.match(new RegExp(`.{1,${width}}`, 'g')).join('\n');

export async function build({ root = REPO, instances = null, widgetUrl = null, lang = null, compact = false } = {}) {
  if (instances) for (const origin of instances) checkOrigin(origin);
  if (widgetUrl && !/^https:\/\/[^'\s]+\/$/.test(widgetUrl)) throw new Error(`« ${widgetUrl} » : une adresse https qui finit par une barre`);
  if (lang && !['fr', 'en'].includes(lang)) throw new Error(`« ${lang} » : fr ou en`);

  const files = await readSources(root);
  const images = { share: await dataUri(root, 'img/aide-partager.png', 'image/png'), copy: await dataUri(root, 'img/aide-copier.png', 'image/png') };
  applyPatches(files, patches({ instances, widgetUrl, images }));

  const origins = [...new Set((files.get('js/config.js').match(/export const GRIST_ORIGINS = \[([^\]]*)\];/)?.[1] || '').match(/'[^']+'/g)?.map(s => s.slice(1, -1)) || [])];
  if (!origins.length) throw new Error('js/config.js : GRIST_ORIGINS introuvable');
  origins.forEach(checkOrigin);
  const version = files.get('js/config.js').match(/export const VERSION = '([^']+)'/)?.[1];
  const newsVersion = files.get('js/news.js').match(/export const NEWS_VERSION = '([^']+)'/)?.[1];
  if (!version || !newsVersion) throw new Error('js/config.js ou js/news.js : version introuvable');

  const order = orderModules(files, ENTRY_MODULE);
  const modules = link(files, order);
  const entryRank = order.indexOf(ENTRY_MODULE);

  // Préférences d'avance : la fenêtre des nouveautés déjà vue (elle s'ouvrirait à chaque chargement, la page ne gardant
  // rien), et la langue demandée.
  const seeds = { 'gristsync.news': newsVersion, ...(lang ? { 'gristsync.lang': lang } : {}) };
  const loader = (await readFile(join(HERE, 'loader.js'), 'utf8'))
    .replace('/*SEEDS*/{}/*END*/', () => JSON.stringify(seeds)).replace('/*ENTRY*/0/*END*/', () => String(entryRank));
  if (loader.includes('/*SEEDS*/') || loader.includes('/*ENTRY*/')) throw new Error('builder/loader.js : une marque n\'a pas été remplacée');

  const css = await readFile(join(root, 'css/style.css'), 'utf8');
  const logo = await dataUri(root, 'img/grist-factory-logo.jpg', 'image/jpeg');

  // La politique de sécurité de la page : le texte du chargeur et celui des styles sont signés (empreintes), les modules ne sont
  // chargés que par des adresses blob: que le chargeur fabrique, l'API des widgets et les requêtes ne vont qu'aux instances.
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${sha256(loader)}' blob: ${origins.join(' ')}`,
    `connect-src blob: ${origins.join(' ')}`, // blob: : les textes JSON (i18n) sont des modules, que le navigateur lit comme une requête
    `style-src 'sha256-${sha256(css)}'`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  let page = await readFile(join(root, 'index.html'), 'utf8');
  const swap = (find, replace) => {
    const count = page.split(find).length - 1;
    if (count !== 1) throw new Error(`index.html : « ${find.slice(0, 50)}… » ${count} fois (une seule attendue) : relire builder/build.mjs`);
    page = page.replace(find, () => replace);
  };
  page = page.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, (all) => {
    if (!all) throw new Error('index.html : pas de politique de sécurité');
    return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  });
  if (!page.includes(`content="${policy}"`)) throw new Error('index.html : la politique de sécurité n\'a pas été remplacée');
  swap('<link rel="stylesheet" href="css/style.css">', `<style>${css}</style>`);
  swap('<script type="module" src="js/main.js"></script>\n', '<script src="grist-plugin-api.js"></script>\n');
  swap('src="img/grist-factory-logo.jpg"', `src="${logo}"`);

  let payload;
  if (compact) {
    const packed = gzipSync(Buffer.from(JSON.stringify(modules)), { level: 9 }).toString('base64');
    payload = `<script type="text/plain" id="syncplus-payload">\n${lines(packed)}\n</script>\n`;
  } else {
    payload = modules.map(({ id, text }) => `<script type="text/plain" data-module="${id}">${text}</script>\n`).join('');
  }
  swap('</body>', `${payload}<script>${loader}</script>\n</body>`);
  page = page.replace('<!DOCTYPE html>\n', () => `<!DOCTYPE html>\n<!-- Sync+ ${version} : page du widget dans le document (Widget Creator de Grist), construite par builder/build.mjs depuis les sources du dépôt. -->\n`);

  return {
    html: page, version, origins, modules: modules.length, policy, loaderHash: sha256(loader),
    sha256: sha256Hex(page), contentSha256: sha256Hex(modules.map(m => `${m.id}\n${m.text}`).join('\n')),
    patches: patches({ instances, widgetUrl, images }).map(p => p.name),
  };
}

function parseArguments(argv) {
  const options = { instances: [], out: join(HERE, 'dist', 'syncplus-creator.html') };
  const take = (flag, index) => {
    if (argv[index + 1] === undefined || argv[index + 1].startsWith('--')) throw new Error(`${flag} attend une valeur`);
    return argv[index + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--instance') options.instances.push(take(flag, i++));
    else if (flag === '--widget-url') options.widgetUrl = take(flag, i++);
    else if (flag === '--lang') options.lang = take(flag, i++);
    else if (flag === '--out') options.out = resolve(take(flag, i++));
    else if (flag === '--compact') options.compact = true;
    else throw new Error(`Option inconnue : ${flag}`);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const { out, instances, ...options } = parseArguments(process.argv.slice(2));
    const result = await build({ ...options, instances: instances.length ? instances : null });
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, result.html);
    console.log(`Sync+ ${result.version} : ${out}`);
    console.log(`  ${result.modules} modules, ${(Buffer.byteLength(result.html) / 1024).toFixed(0)} Ko, instances : ${result.origins.join(', ')}`);
    console.log(`  SHA-256 de la page : ${result.sha256}`);
    console.log(`  SHA-256 des modules : ${result.contentSha256}`);
  } catch (error) {
    console.error(`Erreur : ${error.message}`);
    process.exit(1);
  }
}
