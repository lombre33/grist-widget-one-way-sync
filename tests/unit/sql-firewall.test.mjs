// Les requêtes SQL du widget voyagent dans l'adresse de la demande (`GET /sql?q=…`). Le pare-feu devant le Grist de la DINUM
// (Incapsula) refuse en 403, sans en-tête CORS (le navigateur dit « CORS manquant »), toute demande dont le texte ressemble à une
// injection SQL : `case when`, `or 1=1`, `drop table` (vérifié en direct le 18 novembre 2026 ; `iif`, `nullif`, `sum(a is null)`,
// `!= ''`, `max`, `count(distinct …)` passent). Le widget garde donc ses requêtes sans `case`. Cet essai les relit toutes :
// celles que bâtissent le moteur et ses clés, et tout texte de `js/` qui commence par `select `.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRestPort } from '../../js/engine/index.js';
import { keyCountSql } from '../../js/engine/logic/keys.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUSPECT = /\bcase\b|\bwhen\b|\bunion\b|\bdrop\b|\binsert\b|\bdelete\b|\bupdate\b|--|;|\b1\s*=\s*1\b/i;

const sources = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? sources(path) : (name.endsWith('.js') ? [path] : []);
});

test('les requêtes SQL du moteur n\'ont aucun mot que le pare-feu de la DINUM prend pour une injection', async () => {
  const sent = [];
  const http = {
    request: async (method, path, options = {}) => { sent.push(options.params && options.params.q); return { status: 200, body: { records: [] } }; },
    docBaseUrl: async () => 'https://grist.example.org/o/equipe/api/docs/abcdefghijklmn',
  };
  const rest = createRestPort({ docApi: {}, http });
  await rest.selectRows('Synchro', ['Synchro_Lot'], { Synchro_Export: 'export', Synchro_Type: 'lot' });
  await rest.journalStats('Journal_X', 'Sync_Recu', 'Synchro_Type');
  await rest.querySql(keyCountSql('Contacts'));
  assert.equal(sent.length, 3);
  for (const q of sent) {
    assert.match(q, /^select /);
    assert.doesNotMatch(q, SUSPECT, `requête que le pare-feu refuserait : ${q}`);
  }
});

test('aucun texte de js/ qui commence par « select » ne contient case, when ou autre mot suspect', () => {
  const found = [];
  for (const file of sources(join(ROOT, 'js'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/`select [^`]*`|'select [^']*'|"select [^"]*"/g)) found.push({ file, sql: m[0] });
  }
  assert.ok(found.length >= 3, 'les trois requêtes du moteur sont trouvées');
  for (const { file, sql } of found) assert.doesNotMatch(sql, SUSPECT, `${file} : ${sql}`);
});
