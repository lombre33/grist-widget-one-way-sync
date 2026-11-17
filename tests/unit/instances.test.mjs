// La liste des instances Grist est écrite en deux endroits qui doivent dire la même chose : le code
// (GRIST_ORIGINS de js/config.js, que lit gristFetch) et la politique de sécurité de index.html
// (script-src et connect-src, que lit le navigateur). Qui héberge sa propre copie pour une autre
// instance change les deux (docs/08-auto-hebergement.md) : cet essai échoue s'il en oublie un.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GRIST_ORIGINS } from '../../js/config.js';

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const html = read('index.html');
const config = read('js/config.js');

// La politique de sécurité de index.html, directive par directive : { 'script-src': [sources…] }.
function policy() {
  const content = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1];
  assert.ok(content, 'index.html porte une balise Content-Security-Policy');
  return Object.fromEntries(content.split(';').map(part => part.trim().split(/\s+/)).filter(p => p[0]).map(([name, ...sources]) => [name, sources]));
}

const httpsSources = sources => sources.filter(s => /^https?:\/\//.test(s));

test('chaque instance de GRIST_ORIGINS est une origine propre, https (ou http sur localhost)', () => {
  assert.ok(GRIST_ORIGINS.length >= 1);
  for (const origin of GRIST_ORIGINS) {
    const url = new URL(origin);
    assert.equal(url.origin, origin, `${origin} : une origine seule, sans chemin ni barre finale`);
    assert.ok(url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname), `${origin} : https`);
  }
  assert.equal(new Set(GRIST_ORIGINS).size, GRIST_ORIGINS.length, 'aucune instance en double');
});

test('la politique de sécurité autorise exactement le script de l’API de chaque instance de la liste', () => {
  const scripts = httpsSources(policy()['script-src']).sort();
  assert.deepEqual(scripts, GRIST_ORIGINS.map(origin => `${origin}/grist-plugin-api.js`).sort());
});

test('la politique de sécurité autorise exactement les instances de la liste pour les requêtes', () => {
  assert.deepEqual(httpsSources(policy()['connect-src']).sort(), [...GRIST_ORIGINS].sort());
});

test('la politique de sécurité n’ouvre rien d’autre vers l’extérieur', () => {
  const rules = policy();
  assert.deepEqual(rules['default-src'], ["'none'"]);
  for (const [name, sources] of Object.entries(rules)) {
    if (['script-src', 'connect-src'].includes(name)) continue;
    assert.deepEqual(httpsSources(sources), [], `${name} : aucune adresse externe`);
  }
  assert.deepEqual(rules['base-uri'], ["'none'"]);
  assert.deepEqual(rules['form-action'], ["'none'"]);
});

test('l’adresse donnée par les consignes (WIDGET_URL) est une adresse https qui finit par une barre', () => {
  const address = config.match(/const WIDGET_URL = '([^']+)'/)?.[1];
  assert.ok(address, 'WIDGET_URL est écrite dans js/config.js');
  assert.ok(address.startsWith('https://') && address.endsWith('/'), address);
  assert.equal(new URL(address).search, '');
});
