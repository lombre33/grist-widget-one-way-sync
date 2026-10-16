// Textes de l'interface : les deux langues ont les mêmes clés et les mêmes valeurs à insérer, toute
// clé employée par le code existe, la mise en forme suit la typographie de chaque langue, et les
// images du tutoriel, comme les images et liens des README, existent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { format } from '../../js/i18n.js';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const fr = JSON.parse(read('i18n/fr.json'));
const en = JSON.parse(read('i18n/en.json'));
const jsFiles = readdirSync(new URL('../../js', import.meta.url), { recursive: true }).filter(f => f.endsWith('.js'));
const code = [...jsFiles.map(f => read(`js/${f}`)), read('index.html')].join('\n');
// Familles de clés que le code compose (`t(`send.status.${key}`)`, `error.${e.message}`).
const DYNAMIC = ['type.', 'guide.role.', 'guide.handoff.', 'send.status.', 'recv.status.', 'recv.history.', 'error.'];
const placeholders = text => [...new Set([...text.matchAll(/\{(\w+)(?:\|[^}]*)?\}/g)].map(m => m[1]))].sort();

test('les deux langues ont les mêmes clés et les mêmes valeurs à insérer', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort());
  for (const key of Object.keys(fr)) {
    assert.deepEqual(placeholders(en[key]), placeholders(fr[key]), key);
    assert.ok(fr[key].trim() && en[key].trim(), `${key} : texte vide`);
  }
});

test('toute clé écrite dans le code existe, toute clé existante sert', () => {
  const written = new Set([...code.matchAll(/(?:\bt\(|data-i18n(?:-label)?=)["'`]([a-z][\w.]*)["'`]/g)].map(m => m[1]));
  for (const key of written) assert.ok(key in fr, `clé absente : ${key}`);
  const unused = Object.keys(fr).filter(key => !written.has(key) && !DYNAMIC.some(prefix => key.startsWith(prefix)) && !code.includes(`'${key}'`));
  assert.deepEqual(unused, []);
});

test('chaque erreur levée par le code a son texte', () => {
  const thrown = new Set([...code.matchAll(/new Error\('(\w+)'\)/g)].map(m => m[1]));
  // Erreurs rattrapées avant d'être montrées : un renvoi déjà en cours, Grist trop lent au démarrage.
  for (const handled of ['resendBusy', 'timeout']) thrown.delete(handled);
  for (const name of thrown) assert.ok(`error.${name}` in fr, `error.${name}`);
});

test('chaque type de colonne Grist a son nom en clair', () => {
  for (const type of ['Text', 'Numeric', 'Int', 'Bool', 'Date', 'DateTime', 'Choice', 'ChoiceList', 'Ref', 'RefList', 'Attachments', 'Any']) {
    assert.ok(`type.${type}` in fr, type);
  }
});

test('mise en forme : espaces insécables et nombres en français, pluriels des deux langues', () => {
  const key = Object.keys(fr).find(k => /\{n\|/.test(fr[k]) && placeholders(fr[k]).every(p => p === 'n'));
  assert.ok(key, 'une clé avec un pluriel en {n|…|…}');
  const [one, many] = fr[key].match(/\{n\|([^|}]*)\|([^}]*)\}/).slice(1);
  assert.ok(format('fr', key, { n: 0 }).includes(one), '0 au singulier en français');
  assert.ok(format('fr', key, { n: 2 }).includes(many));
  const [enOne, enMany] = en[key].match(/\{n\|([^|}]*)\|([^}]*)\}/).slice(1);
  assert.ok(format('en', key, { n: 0 }).includes(enMany), '0 au pluriel en anglais');
  assert.ok(format('en', key, { n: 1 }).includes(enOne));
  assert.ok(format('fr', key, { n: 3000 }).includes('3 000'), 'séparateur des milliers français');
  assert.ok(format('en', key, { n: 3000 }).includes('3,000'));
  const colon = Object.keys(fr).find(k => fr[k].includes(' : '));
  assert.ok(format('fr', colon).includes(' :') && !format('fr', colon).includes(' :'), 'espace insécable avant les deux-points');
  assert.ok(format('en', colon).length > 0);
  assert.equal(format('fr', 'error.generic', { detail: 'a : b' }), `${fr['error.generic'].replace(' :', ' :').replace('{detail}', 'a : b')}`,
    'une valeur insérée garde ses espaces');
  assert.equal(format('fr', 'cle.inconnue'), 'cle.inconnue');
  assert.equal(format('fr', 'error.generic'), fr['error.generic'].replace(' :', ' :'), 'valeur absente : laissée entre accolades');
});

test('toute image du tutoriel existe', () => {
  const names = [...read('js/tutorial.js').matchAll(/images: \[([^\]]*)\]/g)].flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(n => n[1]));
  assert.ok(names.length > 20);
  const missing = names.map(name => (name.startsWith('img/') ? name : `docs/images/${name}.png`)).filter(path => !existsSync(new URL(`../../${path}`, import.meta.url)));
  assert.deepEqual(missing, []);
});

test('toute image et tout lien des README et de la documentation existent', () => {
  const pages = ['README.md', 'README.en.md', 'docs/04-tutoriel.md', 'docs/06-architecture.md'];
  const missing = pages.flatMap(page => {
    const dir = new URL(`../../${page}`, import.meta.url);
    return [...read(page).matchAll(/(?:src="|\]\()([^")#]+)/g)].map(m => m[1])
      .filter(path => !/^https?:/.test(path) && !existsSync(new URL(path, dir)))
      .map(path => `${page} : ${path}`);
  });
  assert.deepEqual(missing, []);
});
