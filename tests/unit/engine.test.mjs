// Le moteur (js/engine/) : ce qu'il s'interdit, le préfixe de ses tables, et un passage complet avec un
// port qui n'est pas celui de Grist (voir engine-fake.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = join(ROOT, 'js/engine');

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.js')) out.push(path);
  }
  return out;
};

// Le code d'un fichier sans ses commentaires ni le contenu de ses chaînes (remplacés par des espaces) : ce
// qui reste est ce que le fichier exécute. Les expressions `${…}` d'un gabarit restent du code.
export function codeOnly(text) {
  let out = '';
  const stack = []; // accolades ouvertes dans une expression de gabarit
  let i = 0;
  let regexAllowed = true;
  const blank = (from, to) => text.slice(from, to).replace(/[^\n]/g, ' ');
  const template = () => { // lit un gabarit depuis son premier caractère après « ` » ; rend la fin ou -1 si une expression s'ouvre
    const start = i;
    while (i < text.length) {
      if (text[i] === '\\') i += 2;
      else if (text[i] === '`') { out += blank(start, i); out += '`'; i++; return false; }
      else if (text[i] === '$' && text[i + 1] === '{') { out += blank(start, i); out += '${'; i += 2; stack.push('t'); return true; }
      else i++;
    }
    out += blank(start, i);
    return false;
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') { const end = text.indexOf('\n', i); const to = end < 0 ? text.length : end; out += blank(i, to); i = to; continue; }
    if (c === '/' && next === '*') { const end = text.indexOf('*/', i + 2); const to = end < 0 ? text.length : end + 2; out += blank(i, to); i = to; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += c + blank(i + 1, j) + (text[j] === c ? c : '');
      i = j + 1; regexAllowed = false; continue;
    }
    if (c === '`') { out += '`'; i++; template(); regexAllowed = false; continue; }
    if (c === '{') { stack.push('b'); out += c; i++; regexAllowed = true; continue; }
    if (c === '}') {
      const top = stack.pop();
      out += c; i++;
      if (top === 't') { template(); regexAllowed = false; } else regexAllowed = true;
      continue;
    }
    if (c === '/' && regexAllowed) { // littéral d'expression régulière
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') j += 2;
        else if (text[j] === '[') { inClass = true; j++; } else if (text[j] === ']') { inClass = false; j++; } else if (text[j] === '/' && !inClass) break;
        else j++;
      }
      out += `/${blank(i + 1, j)}/`;
      i = j + 1; regexAllowed = false; continue;
    }
    out += c; i++;
    if (/\s/.test(c)) continue;
    regexAllowed = /[(,=:[!&|?{};+\-*%<>~^]/.test(c);
  }
  return out;
}

test('le lecteur de code ne garde ni commentaires ni chaînes', () => {
  const code = codeOnly("const a = 'document'; // window\nconst b = `x ${document.title} y`; /* grist */ const re = /grist\\//;\nconst c = \"navigator\";");
  assert.ok(!/window|grist|navigator/.test(code));
  assert.ok(/document\.title/.test(code), 'une expression de gabarit reste du code');
});

// ---------------------------------------------------------------------------------------------
// Ce que le moteur s'interdit

const FORBIDDEN = ['document', 'window', 'location', 'navigator', 'localStorage', 'sessionStorage', 'grist', 'globalThis'];

test('rien dans js/engine/ ne touche l\'écran, la page ou le global grist', () => {
  const seen = [];
  for (const file of walk(ENGINE)) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const word of FORBIDDEN) {
      for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${word}(?![\\w$])`, 'g'))) {
        const line = code.slice(0, m.index).split('\n').length;
        seen.push(`${relative(ROOT, file)}:${line} ${word}`);
      }
    }
  }
  assert.deepEqual(seen, []);
});

test('le moteur n\'importe que lui-même', () => {
  const out = [];
  for (const file of walk(ENGINE)) {
    const text = readFileSync(file, 'utf8');
    if (/\bimport\s*\(/.test(codeOnly(text))) out.push(`${relative(ROOT, file)} : import dynamique`);
    for (const m of text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"\n]+)\1;?[ \t]*$/gm)) {
      const spec = m[2];
      if (!spec.startsWith('.')) out.push(`${relative(ROOT, file)} importe ${spec}`); // un module du système ou une bibliothèque
      else if (relative(ENGINE, resolve(dirname(file), spec)).startsWith('..')) out.push(`${relative(ROOT, file)} sort du moteur : ${spec}`);
      else if (spec.endsWith('.json')) out.push(`${relative(ROOT, file)} lit un JSON : ${spec}`);
    }
  }
  assert.deepEqual(out, []);
});

test('les écrans appellent le moteur, jamais l\'inverse', () => {
  // Aucun fichier du moteur ne cite un fichier d'écran (ui, i18n, prefs, config, guide, tutoriel, onglets).
  const screens = /(?:^|\/)(ui|i18n|prefs|config|guide|tutorial|diagnostic|main|grist|sync-port)\.js$/;
  for (const file of walk(ENGINE)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*(['"])(\.[^'"\n]+)\1;?[ \t]*$/gm)) assert.ok(!screens.test(m[2]), `${relative(ROOT, file)} : ${m[2]}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Préfixe des tables

const engine = await import('../../js/engine/index.js');
const common = await import('../../js/engine/logic/common.js');
const { syncColumns, syncFormulas } = await import('../../js/engine/logic/formulas.js');
const { ownerAclRules, publicAclRules } = await import('../../js/engine/logic/acl.js');
const { freeTableName } = await import('../../js/engine/logic/strays.js');
const { fakePort, fakeDoc } = await import('./engine-fake.mjs');

// Une référence à la table technique dans un texte (pas ses colonnes, `Synchro_Export`…).
const bareSynchro = text => [...text.matchAll(/(?<![A-Za-z0-9_])Synchro(?![A-Za-z0-9_])/g)].length;

test('sans préfixe, les noms sont ceux d\'avant', () => {
  assert.equal(common.TABLE_PREFIX, '');
  assert.equal(common.SYNC_TABLE, 'Synchro');
  assert.equal(common.JOURNAL_PREFIX, 'Journal_');
  assert.equal(common.journalId('Annuaire', []), 'Journal_Annuaire');
  assert.equal(common.destTableId('Mes contacts'), 'Mes_contacts');
  assert.equal(common.isUserTable('Synchro'), false);
  assert.equal(common.isUserTable('Synchro_2'), false);
  assert.equal(common.isUserTable('Journal_Annuaire'), false);
  assert.equal(common.isUserTable('Annuaire'), true);
  assert.equal(freeTableName(['Synchro']), 'Table_Synchro');
  assert.ok(syncFormulas(['Contacts']).lot.includes('Synchro.lookupOne('));
});

test('un préfixe change le nom de Synchro, des journaux et des destinations proposées, et rien d\'autre', () => {
  engine.startEngine({ port: fakePort(fakeDoc()), prefix: 'Gfs_' });
  try {
    assert.equal(common.SYNC_TABLE, 'Gfs_Synchro');
    assert.equal(common.JOURNAL_PREFIX, 'Gfs_Journal_');
    assert.equal(common.journalId('Annuaire', []), 'Gfs_Journal_Annuaire');
    assert.equal(common.journalId('Annuaire', ['gfs_journal_annuaire']), 'Gfs_Journal_Annuaire_2', 'Grist ne distingue pas les majuscules');
    assert.equal(common.destTableId('Mes contacts'), 'Gfs_Mes_contacts');
    assert.equal(common.toTableId('Mes contacts'), 'Mes_contacts', 'toTableId reste sans préfixe : il sert aussi aux colonnes et aux journaux');
    assert.equal(common.isUserTable('Gfs_Synchro'), false);
    assert.equal(common.isUserTable('Gfs_Synchro_x'), false);
    assert.equal(common.isUserTable('Gfs_Journal_Annuaire'), false);
    assert.equal(common.isUserTable('Annuaire'), true);
    assert.equal(common.isUserTable('Synchro'), true, 'une table nommée Synchro n\'est plus celle du moteur');
    assert.equal(freeTableName(['Gfs_Synchro']), 'Table_Gfs_Synchro');
    // Les noms de colonnes sont le protocole entre SOURCE et CIBLE : ils ne changent pas.
    assert.equal(common.EXPORT_COL, 'Synchro_Export');
    // Les formules, les colonnes et les règles nomment la table préfixée, jamais l'ancienne.
    const formulas = syncFormulas(['Contacts']);
    for (const [name, text] of Object.entries(formulas)) {
      assert.equal(bareSynchro(text), 0, `la formule ${name} nomme encore Synchro`);
      assert.ok(text.includes('Gfs_Synchro.lookup'), `la formule ${name} cherche dans Gfs_Synchro`);
    }
    for (const column of syncColumns(['Contacts'])) assert.equal(bareSynchro(column.formula || ''), 0, column.id);
    for (const rule of [...ownerAclRules(['0123456789abcdef']), ...publicAclRules(['0123456789abcdef'])].filter(r => r.tableId !== '*')) {
      assert.equal(rule.tableId, 'Gfs_Synchro');
    }
  } finally {
    engine.startEngine({ port: fakePort(fakeDoc()), prefix: '' });
  }
  assert.equal(common.SYNC_TABLE, 'Synchro', 'le préfixe se remet à zéro');
});

test('un préfixe invalide est refusé, sans rien changer', () => {
  for (const bad of ['gfs_', '1Gfs', 'Gfs-', 'Gfs ', 'É', 'A'.repeat(40), 42, null]) {
    assert.throws(() => engine.startEngine({ port: fakePort(fakeDoc()), prefix: bad }), /préfixe/, String(bad));
    assert.equal(common.SYNC_TABLE, 'Synchro');
  }
  assert.doesNotThrow(() => engine.startEngine({ port: fakePort(fakeDoc()), prefix: 'G' }));
  engine.startEngine({ port: fakePort(fakeDoc()) });
  assert.equal(common.SYNC_TABLE, 'Synchro');
});

// ---------------------------------------------------------------------------------------------
// Le port

test('un port incomplet est refusé et dit ce qui manque', () => {
  const port = fakePort(fakeDoc());
  delete port.fetchRows;
  delete port.page.onLeave;
  assert.throws(() => engine.startEngine({ port }), /fetchRows.*page\.onLeave/);
  assert.throws(() => engine.startEngine({}), /port incomplet/);
});

test('le port de Sync+ a la forme que le moteur demande', async () => {
  // js/sync-port.js ne se charge pas sans navigateur (il importe i18n et prefs) : on compare les noms.
  const text = readFileSync(join(ROOT, 'js/sync-port.js'), 'utf8');
  const shape = engine.PORT_SHAPE;
  for (const name of [...shape.data, ...shape.files, ...shape.hooks, ...shape.publicDoc, ...shape.environment]) {
    assert.ok(new RegExp(`^  ${name}[,:]`, 'm').test(text), `sync-port.js : ${name}`);
  }
  for (const name of shape.page) assert.ok(new RegExp(`^    ${name}[,:(]`, 'm').test(text), `sync-port.js : page.${name}`);
  assert.ok(/prefs: \{ read: /.test(text));
});

test('la version du moteur est un numéro', () => {
  assert.match(engine.ENGINE_VERSION, /^\d+\.\d+\.\d+$/);
});
