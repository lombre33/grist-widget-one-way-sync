// La page du widget dans le document (builder/ : build.mjs et loader.js). Le build lit les sources du dépôt : cet essai
// vérifie ce qu'il garantit (même page à chaque fois, aucun module qui cite une adresse relative, pas de cycle, politique de
// sécurité qui signe exactement ce que la page contient, instances écrites aux deux endroits) et que ses retouches échouent
// bruyamment quand le dépôt change, plutôt que de s'ignorer. Le chargeur est essayé dans un contexte `vm` : ses remplacements
// (verrous, stockage, canal) sont du code de la page, pas du widget. L'essai dans un vrai Grist est tests/e2e/builder.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { build, checkOrigin, orderModules } from '../../builder/build.mjs';
import { GRIST_ORIGINS } from '../../js/config.js';

const REPO = new URL('../../', import.meta.url).pathname;
const sha256 = text => createHash('sha256').update(text).digest('base64');

// Les modules d'une page (construite sans --compact) : { id: texte }.
const modulesOf = html => Object.fromEntries([...html.matchAll(/<script type="text\/plain" data-module="([^"]+)">([\s\S]*?)<\/script>/g)].map(m => [m[1], m[2]]));
// Le texte du script en ligne (le chargeur) et celui des styles.
const inlineScript = html => html.match(/<script>([\s\S]*?)<\/script>\n<\/body>/)[1];
const inlineStyle = html => html.match(/<style>([\s\S]*?)<\/style>/)[1];
const policyOf = html => Object.fromEntries(html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)[1].split(';').map(p => p.trim().split(/\s+/)).filter(p => p[0]).map(([name, ...sources]) => [name, sources]));

const plain = await build();
const compact = await build({ compact: true });

test('deux builds des mêmes sources donnent la même page, octet pour octet', async () => {
  const again = await build();
  assert.equal(again.html, plain.html);
  assert.equal(again.sha256, plain.sha256);
  assert.equal(again.contentSha256, plain.contentSha256);
  assert.notEqual((await build({ instances: ['https://grist.exemple.org'] })).sha256, plain.sha256);
});

test('aucun module ne cite plus une adresse relative, et chacun ne cite que des modules déjà chargés', () => {
  const modules = modulesOf(plain.html);
  const ids = Object.keys(modules);
  assert.equal(ids.length, plain.modules);
  assert.ok(ids.length > 100, 'tout le widget y est');
  ids.forEach((id, index) => {
    if (id.endsWith('.json')) return;
    assert.doesNotMatch(modules[id], /\bfrom\s*['"]\.{1,2}\//, `${id} : adresse relative restante`);
    assert.doesNotMatch(modules[id], /^import\s*['"]\.{1,2}\//m, `${id} : import sans nom restant`);
    for (const m of modules[id].matchAll(/(['"])@syncplus:(\d+)\1/g)) {
      assert.ok(Number(m[2]) < index, `${id} (rang ${index}) cite le module ${m[2]}, pas encore chargé`);
    }
  });
  assert.equal(ids.at(-1), 'js/main.js', 'le module de départ est le dernier');
});

test('la page compacte contient les mêmes modules que la page lisible', () => {
  const packed = compact.html.match(/<script type="text\/plain" id="syncplus-payload">([\s\S]*?)<\/script>/)[1].replace(/\s+/g, '');
  const modules = JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8'));
  const readable = modulesOf(plain.html);
  assert.deepEqual(Object.fromEntries(modules.map(m => [m.id, m.text])), readable);
  assert.equal(compact.contentSha256, plain.contentSha256);
  assert.ok(Buffer.byteLength(compact.html) < Buffer.byteLength(plain.html) / 2, 'compacte : moins de la moitié');
  assert.ok(Buffer.byteLength(compact.html) < 900 * 1024, 'sous la limite de 1 Mo de l’API REST de Grist, avec de la marge');
});

test('la politique de sécurité signe le chargeur et les styles de la page, et rien de plus', () => {
  const policy = policyOf(plain.html);
  assert.deepEqual(policy['default-src'], ["'none'"]);
  assert.ok(policy['script-src'].includes(`'sha256-${sha256(inlineScript(plain.html))}'`), 'l’empreinte du chargeur est celle du script en ligne');
  assert.equal(plain.loaderHash, sha256(inlineScript(plain.html)));
  assert.deepEqual(policy['style-src'], [`'sha256-${sha256(inlineStyle(plain.html))}'`]);
  assert.doesNotMatch(Object.values(policy).flat().join(' '), /unsafe-inline|unsafe-eval|\*/);
  assert.deepEqual(Object.keys(policy).filter(name => (policy[name] || []).includes('data:')), ['img-src'], 'data: seulement pour les images');
  assert.deepEqual(policy['img-src'], ['data:']);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.deepEqual(policy['form-action'], ["'none'"]);
  assert.ok(policy['script-src'].includes('blob:'), 'les modules sont des adresses blob:');
  // Le seul script chargé par adresse est l'API des widgets, que Grist sert à côté de la page ; les modules sont du texte.
  assert.deepEqual([...plain.html.matchAll(/<script[^>]*\ssrc=/g)].length, 1);
  assert.match(plain.html, /<script src="grist-plugin-api.js"><\/script>/);
  assert.doesNotMatch(plain.html, /<link\b/i);
});

test('les instances sont écrites aux deux endroits, d’accord : le code (GRIST_ORIGINS) et la politique', async () => {
  const same = origins => origins.slice().sort();
  const config = modulesOf(plain.html)['js/config.js'];
  const inCode = config.match(/export const GRIST_ORIGINS = \[([^\]]*)\];/)[1].match(/'[^']+'/g).map(s => s.slice(1, -1));
  const policy = policyOf(plain.html);
  assert.deepEqual(same(inCode), same(GRIST_ORIGINS), 'd’office : la liste de js/config.js');
  assert.deepEqual(same(policy['script-src'].filter(s => s.startsWith('http'))), same(GRIST_ORIGINS));
  assert.deepEqual(same(policy['connect-src'].filter(s => s.startsWith('http'))), same(GRIST_ORIGINS));

  const own = await build({ instances: ['https://grist.exemple.org', 'http://localhost:8484'] });
  const ownPolicy = policyOf(own.html);
  assert.deepEqual(own.origins, ['https://grist.exemple.org', 'http://localhost:8484']);
  assert.match(modulesOf(own.html)['js/config.js'], /GRIST_ORIGINS = \['https:\/\/grist\.exemple\.org', 'http:\/\/localhost:8484'\];/);
  assert.deepEqual(ownPolicy['script-src'].filter(s => s.startsWith('http')), own.origins);
  assert.deepEqual(ownPolicy['connect-src'].filter(s => s.startsWith('http')), own.origins);
  assert.doesNotMatch(Object.values(ownPolicy).flat().join(' ') + modulesOf(own.html)['js/config.js'].match(/GRIST_ORIGINS[^;]*;/)[0], /numerique\.gouv|getgrist/, 'la liste d’origine ne reste ni dans le code ni dans la politique');
});

test('une instance est une origine https seule (http sur localhost pour les essais)', () => {
  for (const good of ['https://grist.exemple.org', 'https://grist.exemple.org:8443', 'https://grist.numerique.gouv.fr', 'http://localhost:8484', 'http://127.0.0.1:8484']) assert.equal(checkOrigin(good), good);
  for (const bad of ['http://grist.exemple.org', 'https://grist.exemple.org/', 'https://grist.exemple.org/o/equipe', 'grist.exemple.org', 'javascript:alert(1)', 'https://a.org https://b.org', "https://a.org';", 'https://a.org;script-src', "https://a'.org", 'https://a.org:99999', 'https://.a.org', 'https://a.org?x', 'https://u@a.org', 'HTTP://grist.exemple.org']) {
    assert.throws(() => checkOrigin(bad), /origine|adresse/, bad);
  }
});

test('l’adresse des consignes et la langue sont contrôlées', async () => {
  await assert.rejects(build({ widgetUrl: 'http://exemple.org/widget/' }), /https/);
  await assert.rejects(build({ widgetUrl: 'https://exemple.org/widget' }), /barre/);
  await assert.rejects(build({ lang: 'de' }), /fr ou en/);
  const own = await build({ widgetUrl: 'https://exemple.org/syncplus/', lang: 'en' });
  assert.match(modulesOf(own.html)['js/config.js'], /const WIDGET_URL = 'https:\/\/exemple\.org\/syncplus\/';/);
  assert.match(inlineScript(own.html), /"gristsync\.lang":"en"/);
});

test('le graphe des modules du widget n’a pas de cycle, et un cycle est refusé', () => {
  assert.equal(plain.patches.length >= 6, true);
  const files = new Map([['js/a.js', "import { b } from './b.js';\nexport const a = 1;"], ['js/b.js', "import { a } from './a.js';\nexport const b = 2;"]]);
  assert.throws(() => orderModules(files, 'js/a.js'), /Cycle entre modules : js\/a\.js → js\/b\.js → js\/a\.js/);
  assert.throws(() => orderModules(new Map([['js/a.js', "import './manque.js';"]]), 'js/a.js'), /introuvable/);
  const ok = new Map([['js/a.js', "import { b } from './sub/b.js';\nexport * from './sub/c.js';"], ['js/sub/b.js', "export * from '../d.js';"], ['js/sub/c.js', "export const c = 1;"], ['js/d.js', 'export const d = 1;']]);
  assert.deepEqual(orderModules(ok, 'js/a.js'), ['js/d.js', 'js/sub/b.js', 'js/sub/c.js', 'js/a.js']);
});

test('une retouche dont le texte a disparu du dépôt arrête le build au lieu de s’ignorer', async () => {
  const copy = mkdtempSync(join(tmpdir(), 'syncplus-build-'));
  try {
    for (const name of ['js', 'i18n', 'css', 'img', 'index.html']) cpSync(join(REPO, name), join(copy, name), { recursive: true });
    assert.ok((await build({ root: copy })).html, 'la copie se construit telle quelle');
    const path = join(copy, 'js/config.js');
    writeFileSync(path, readFileSync(path, 'utf8').replace('export const servedAt', 'export const servedAtRenamed'));
    await assert.rejects(build({ root: copy }), /Retouche « adresse du widget » : 0 occurrence/);
    cpSync(join(REPO, 'js/config.js'), path);
    const main = join(copy, 'js/main.js');
    writeFileSync(main, `${readFileSync(main, 'utf8')}\nconst lazy = () => import('./lazy.js');\n`);
    await assert.rejects(build({ root: copy }), /import\(\) et import\.meta/);
    cpSync(join(REPO, 'js/main.js'), main);
    writeFileSync(main, `${readFileSync(main, 'utf8')}\nconst tag = '</script>';\n`);
    await assert.rejects(build({ root: copy }), /casserait la page/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

// --- Le chargeur, dans un contexte sans navigateur.
const loaderText = (seeds = {}) => readFileSync(new URL('../../builder/loader.js', import.meta.url), 'utf8')
  .replace('/*SEEDS*/{}/*END*/', () => JSON.stringify(seeds)).replace('/*ENTRY*/0/*END*/', '0');

function runLoader({ name = '', seeds = { 'gristsync.news': '0.21' } } = {}) {
  const win = { name, navigator: {}, document: { getElementById: () => null, querySelectorAll: () => [] }, BroadcastChannel: class {}, console };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(loaderText(seeds), win);
  return win;
}

test('chargeur : le stockage est une mémoire de la page, avec les préférences d’avance, gardée dans window.name', () => {
  const win = runLoader();
  assert.equal(win.localStorage.getItem('gristsync.news'), '0.21');
  assert.equal(win.localStorage.getItem('absent'), null);
  win.localStorage.setItem('gristsync.lang', 'en');
  win.sessionStorage.setItem('une', 'valeur');
  assert.equal(win.localStorage.length, 2);
  assert.equal(win.localStorage.key(0), 'gristsync.news');
  assert.match(win.name, /^syncplus-creator:/);
  // Un rechargement du cadre (même window.name) retrouve ce qui a été rangé.
  const again = runLoader({ name: win.name });
  assert.equal(again.localStorage.getItem('gristsync.lang'), 'en');
  assert.equal(again.sessionStorage.getItem('une'), 'valeur');
  again.localStorage.removeItem('gristsync.lang');
  assert.equal(again.localStorage.getItem('gristsync.lang'), null);
  again.localStorage.clear();
  assert.equal(again.localStorage.length, 0);
});

test('chargeur : un window.name qui n’est pas le sien n’est jamais écrasé ni lu', () => {
  const other = runLoader({ name: 'nom-d-un-autre' });
  other.localStorage.setItem('k', 'v');
  assert.equal(other.name, 'nom-d-un-autre');
  assert.equal(other.localStorage.getItem('k'), 'v');
  const broken = runLoader({ name: 'syncplus-creator:{pas du json' });
  assert.equal(broken.localStorage.getItem('gristsync.news'), '0.21');
  const hostile = runLoader({ name: `syncplus-creator:${JSON.stringify({ local: { '__proto__': 'x', a: 'b' } })}` });
  assert.equal(hostile.localStorage.getItem('a'), 'b');
  assert.equal(Object.prototype.x, undefined);
});

test('chargeur : les verrous se mettent en file par nom, et « ifAvailable » rend null quand le verrou est pris', async () => {
  const win = runLoader();
  const order = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const first = win.navigator.locks.request('a', async () => { order.push('a1 début'); await pause(30); order.push('a1 fin'); return 1; });
  const second = win.navigator.locks.request('a', async () => { order.push('a2'); return 2; });
  const other = win.navigator.locks.request('b', async () => { order.push('b'); return 3; });
  const skipped = await win.navigator.locks.request('a', { ifAvailable: true }, async lock => lock);
  assert.equal(skipped, null, 'verrou pris : pas de rappel avec un verrou');
  assert.deepEqual(await Promise.all([first, second, other]), [1, 2, 3]);
  assert.ok(order.indexOf('b') < order.indexOf('a1 fin'), 'un autre nom n’attend pas');
  assert.deepEqual(order.filter(x => x.startsWith('a')), ['a1 début', 'a1 fin', 'a2']);
  // Un rappel qui échoue ne retient pas les suivants.
  await assert.rejects(win.navigator.locks.request('c', async () => { throw new Error('boum'); }), /boum/);
  assert.equal(await win.navigator.locks.request('c', async () => 'suite'), 'suite');
  const free = await win.navigator.locks.request('d', { ifAvailable: true }, async lock => lock && lock.name);
  assert.equal(free, 'd');
});

test('chargeur : le canal entre onglets est retiré (il ne joindrait personne)', () => {
  assert.equal(runLoader().BroadcastChannel, undefined);
});
