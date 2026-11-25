// Les boucles qui font tourner la synchro (recopie de la CIBLE) ne doivent pas s'arrêter en silence : un dessin de
// l'onglet qui échoue (Grist injoignable une seconde, carte abîmée) ne tue pas la boucle, le passage suivant a lieu.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { readSchema } from '../../js/engine/port.js';
import { createJournal, prepareDest } from '../../js/engine/target/journals.js';
import { FAILURE_SHOWN, retryDelay, startAutoConsolidation, state } from '../../js/engine/target/loop.js';
import { fakeDoc, fakePort } from './engine-fake.mjs';
import { receivedNames } from './engine-wire.mjs';

const EXPORT = 'fedcba9876543210';
const COLUMNS = [{ id: 'Nom', type: 'Text', label: 'Nom' }, { id: 'Ville', type: 'Text', label: 'Ville' }];
const JOURNAL = 'Journal_Annuaire';

async function receive(doc) {
  const entry = { table: 'Contacts', dest: 'Contacts', columns: COLUMNS, own: ['Nom', 'Ville'] };
  await createJournal(JOURNAL, {
    id: '0123456789abcdef', export: EXPORT, name: 'Annuaire', secret: '', from: { email: 'source@fake.local', docId: 'zyxwvutsrqpo', docName: 'Source' }, tables: [entry], refused: [], missing: {},
  });
  await prepareDest({ dest: 'Contacts', columns: COLUMNS });
  return doc;
}
const dropLot = (doc, lines) => doc.addRow(JOURNAL, {
  [EXPORT_COL]: EXPORT, [TABLE_COL]: 'Contacts', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: JSON.stringify(COLUMNS), [LOT_COL]: JSON.stringify({ lignes: lines, total: lines.length }), Sync_Recu: doc.now(),
});
// Le moteur garde son rythme (dernier passage…) d'un essai à l'autre : chaque essai repart d'une heure plus tardive que le précédent.
let clockBase = 0;
const flush = () => new Promise(resolve => setImmediate(resolve));
async function ticks(n, ms = 10000) {
  for (let i = 0; i < n; i++) {
    mock.timers.tick(ms);
    for (let j = 0; j < 40; j++) await flush();
  }
}

test('la recopie de la CIBLE continue quand le dessin de l\'onglet échoue une fois', async () => {
  const doc = fakeDoc();
  startEngine({ port: fakePort(doc) });
  await readSchema();
  await receive(doc);
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: (clockBase += 1e7) });
  try {
    let draws = 0;
    startAutoConsolidation(async () => { draws++; throw new Error('Failed to fetch'); });
    dropLot(doc, [['k1', 100, false, { Nom: 'Alice', Ville: 'Lyon' }]]);
    await ticks(2);
    assert.deepEqual(receivedNames(doc, 'Contacts'), ['k1:Alice:Lyon'], 'la première ligne est recopiée');
    assert.ok(draws >= 1, 'le dessin a été tenté');
    // Le dessin a échoué : la boucle doit encore tourner.
    doc.tick();
    dropLot(doc, [['k2', 200, false, { Nom: 'Bob', Ville: 'Nice' }]]);
    await ticks(3);
    assert.deepEqual(receivedNames(doc, 'Contacts'), ['k1:Alice:Lyon', 'k2:Bob:Nice'], 'la boucle tourne toujours : la seconde ligne arrive');
  } finally {
    mock.timers.reset();
  }
});

test('un passage qui échoue est dit à l\'écran au deuxième échec, réessayé à intervalles croissants, et le dit cesse au retour de Grist', async () => {
  const doc = fakeDoc();
  const port = fakePort(doc);
  const readSchemaOk = port.readSchema;
  let broken = false;
  let reads = 0;
  port.readSchema = async () => {
    if (broken) { reads++; throw new Error('Failed to fetch'); }
    return readSchemaOk();
  };
  startEngine({ port });
  await readSchema();
  await receive(doc);
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: (clockBase += 1e7) });
  try {
    const drawn = [];
    startAutoConsolidation(async () => { drawn.push(state.failure ? state.failure.n : 0); });
    dropLot(doc, [['k0', 50, false, { Nom: 'Zoé', Ville: 'Metz' }]]); // une arrivée remet le rythme à 10 s
    await ticks(1);
    assert.equal(state.failure, null, 'rien à dire tant que tout va bien');
    assert.deepEqual(receivedNames(doc, 'Contacts'), ['k0:Zoé:Metz']);
    broken = true;
    dropLot(doc, [['k1', 100, false, { Nom: 'Alice', Ville: 'Lyon' }]]);
    await ticks(1); // premier échec : trop tôt pour le dire
    assert.equal(state.failure && state.failure.n, 1);
    assert.deepEqual(drawn.filter(n => n >= FAILURE_SHOWN), [], 'un seul échec : rien à l\'écran');
    await ticks(1); // le réessai part 10 s plus tard : deuxième échec, l'écran se redessine
    assert.equal(state.failure.n, FAILURE_SHOWN);
    assert.ok(state.failure.text, 'le texte de l\'erreur est gardé pour l\'écran');
    assert.ok(drawn.includes(FAILURE_SHOWN), 'l\'onglet est redessiné pour montrer l\'échec');
    const tries = reads;
    await ticks(1); // 10 s plus tard : le délai du troisième essai est de 20 s, il n'a pas lieu
    assert.equal(reads, tries, 'les essais s\'espacent');
    await ticks(2);
    assert.ok(reads > tries, 'et reviennent');
    broken = false;
    await ticks(14, 10000); // jusqu'au prochain essai (au plus 2 minutes)
    assert.equal(state.failure, null, 'le dit est retiré quand le passage réussit');
    assert.deepEqual(receivedNames(doc, 'Contacts'), ['k0:Zoé:Metz', 'k1:Alice:Lyon'], 'la ligne arrivée pendant la panne est recopiée');
    assert.equal(drawn.at(-1), 0, 'l\'onglet est redessiné quand l\'échec disparaît');
  } finally {
    mock.timers.reset();
  }
});

test('délai de réessai : 10 s, 20 s, 40 s, au plus 2 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(retryDelay), [10000, 20000, 40000, 80000, 120000, 120000, 120000]);
});

// Un clic dont l'action échoue : le navigateur ne dit rien d'un refus de Grist (vérifié dans un vrai Grist), le gestionnaire le rapporte.
test('un gestionnaire de clic dont la promesse échoue est rapporté, le reste ne change pas', async () => {
  const { guarded, setUncaughtReporter } = await import('../../js/guard.js');
  const seen = [];
  setUncaughtReporter(error => seen.push(error));
  try {
    const refused = new Error('Blocked by table structure access rules');
    const failing = guarded(async () => { throw refused; });
    await failing().catch(() => {});
    assert.deepEqual(seen, [refused], 'l\'échec est rapporté');
    seen.length = 0;
    const fine = guarded(function ok(value) { return Promise.resolve([this.tag, value]); });
    assert.deepEqual(await fine.call({ tag: 'x' }, 7), ['x', 7], 'valeur et `this` gardés');
    assert.equal(guarded(() => 3)(), 3, 'une action synchrone passe telle quelle');
    const listener = { handleEvent() {} };
    assert.equal(guarded(listener), listener, 'ce qui n\'est pas une fonction n\'est pas touché');
    assert.deepEqual(seen, [], 'rien n\'est rapporté quand tout va bien');
    // La promesse rejetée reste rendue à l'appelant (qui peut la lire) : elle n'est pas avalée.
    await assert.rejects(guarded(() => Promise.reject(new Error('x')))(), /x/);
  } finally {
    setUncaughtReporter(error => console.error(error));
  }
});
