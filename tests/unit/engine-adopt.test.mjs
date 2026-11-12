// Adopter une table qui existe déjà (voir logic/adopt.js) : le contrôle du type de chaque colonne d'ici, et l'aperçu qui précède la
// première recopie quand la réception demande l'accord. Deux documents en mémoire : une SOURCE (Fiches : Nom, Ville) et une CIBLE dont la
// table `Annuaire` est déjà remplie. Puis la logique pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { EXPORT_COL, KIND, LOT_COL, SCHEMA_COL, TABLE_COL, TYPE_COL } from '../../js/engine/logic/common.js';
import { adoptionPreview, adoptionStep, fitIssues, typeFit } from '../../js/engine/logic/adopt.js';
import { receivedJournals } from '../../js/engine/logic/received.js';
import { signText } from '../../js/engine/logic/trust.js';
import { readSchema } from '../../js/engine/port.js';
import { syncRows } from '../../js/engine/source/synchro.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { approveReply, checkReply, invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { checkDestinations, createReception, readInvitation, receptionReply } from '../../js/engine/target/receive.js';
import { approveStructure, consolidateAll, state, tableKey } from '../../js/engine/target/loop.js';
import { fakeDoc, fakeWorld } from './engine-fake.mjs';

// `existing` : lignes de la table `Annuaire` d'ici avant la réception (null : la table n'existe pas) ; `options` : réglages de la réception ;
// `match` : colonne commune qui rattache les lignes d'ici.
async function pair(tag, { existing = null, options, match = '', hereCols = [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }] } = {}) {
  const world = fakeWorld();
  const source = fakeDoc({ docId: `source${tag}docx`, name: `Source ${tag}`, email: 'source@fake.local' });
  const target = fakeDoc({ docId: `target${tag}docx`, name: `Cible ${tag}`, email: 'cible@fake.local' });
  const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });
  source.addTable('Fiches', [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text' }], []);
  if (existing) target.addTable('Annuaire', hereCols, existing);
  as(source);
  const saved = await saveChosenExport({ name: 'Fiches', selection: [{ table: 'Fiches', columns: ['Nom', 'Ville'], filter: null }] });
  const { entry, secret } = await startInvitation(saved.created);
  const { code } = await invitationCode(saved.created, entry, secret);
  as(target);
  const invitation = await readInvitation(code);
  const plans = invitation.tables.map(tb => ({ tb, dest: 'Annuaire', ...(match ? { match } : {}) }));
  await checkDestinations(invitation, plans);
  const made = await createReception(invitation, plans, { reserve: false, options });
  const { code: reply } = await receptionReply(made, world.formLink(target, made.journal));
  as(source);
  const accepted = await checkReply(saved.created, entry, reply);
  await approveReply(saved.created, entry, accepted);
  const lot = (await syncRows()).find(r => r[EXPORT_COL] === saved.id && r[TYPE_COL] === KIND.lot && r[TABLE_COL] === 'Fiches');
  const base = JSON.parse(lot[SCHEMA_COL]);
  const deliver = async (rows) => {
    const row = { [EXPORT_COL]: saved.id, [TABLE_COL]: 'Fiches', [TYPE_COL]: KIND.lot, [SCHEMA_COL]: JSON.stringify(base) };
    world.deliver(accepted.url, [{ ...row, [LOT_COL]: await signText(accepted.keys.down, row, JSON.stringify({ lignes: rows, total: rows.length })) }]);
  };
  return { target, made, as, deliver };
}

const journalNote = async () => receivedJournals(await readSchema())[0].note;
const resultOf = made => state.results.get(tableKey(made.journal, 'Fiches'));
const names = doc => doc.rows('Annuaire').map(r => [r.Nom, r.Ville]).sort((a, b) => a[0].localeCompare(b[0]));
const FIRST = [['k1', 100, false, { Nom: 'Alice', Ville: 'Lyon' }], ['k2', 100, false, { Nom: 'Bob', Ville: 'Nice' }]];
const HERE = [{ Nom: 'Alice', Ville: 'Paris' }, { Nom: 'Zoé', Ville: 'Brest' }];

test('réception qui demande l\'accord, table déjà remplie : un aperçu d\'abord, puis « Appliquer »', async (t) => {
  const p = await pair('adopt1', { existing: HERE, options: { ask: true }, match: 'Nom' });
  await t.test('la note marque la table adoptée', async () => {
    p.as(p.target);
    assert.equal((await journalNote()).tables[0].adopt, true);
  });
  await t.test('rien n\'est écrit, l\'aperçu dit ce qui arriverait', async () => {
    await p.deliver(FIRST);
    p.as(p.target);
    await consolidateAll();
    assert.deepEqual(names(p.target), [['Alice', 'Paris'], ['Zoé', 'Brest']], 'la table n\'a pas bougé');
    assert.ok(p.target.rows('Annuaire').every(r => !r.id_sync), 'aucune clé posée');
    const { adoption } = resultOf(p.made).structure;
    assert.deepEqual({ ...adoption, samples: undefined }, { added: 1, attached: 1, match: 'Nom', overwritten: 1, filled: 0, untouched: 1, samples: undefined });
    assert.deepEqual(adoption.samples, [{ key: 'Alice', col: 'Ville', here: 'Paris', sent: 'Lyon' }]);
    assert.equal((await journalNote()).tables[0].adopted, undefined);
  });
  await t.test('un passage de plus ne change rien tant que la personne n\'a pas accepté', async () => {
    await consolidateAll({ reread: true });
    assert.deepEqual(names(p.target), [['Alice', 'Paris'], ['Zoé', 'Brest']]);
    assert.ok(resultOf(p.made).structure.adoption);
  });
  await t.test('« Appliquer » rattache, ajoute, remplace, et note la table adoptée', async () => {
    await approveStructure(p.made.journal);
    assert.deepEqual(names(p.target), [['Alice', 'Lyon'], ['Bob', 'Nice'], ['Zoé', 'Brest']]);
    assert.equal(p.target.rows('Annuaire').find(r => r.Nom === 'Alice').id_sync, 'k1', 'la ligne d\'ici a pris la clé');
    assert.equal(p.target.rows('Annuaire').find(r => r.Nom === 'Zoé').id_sync || '', '', 'la ligne d\'ici sans pendant ne bouge pas');
    assert.equal(resultOf(p.made).structure, null);
    assert.equal((await journalNote()).tables[0].adopted, true);
  });
  await t.test('ensuite, les modifications passent sans aperçu', async () => {
    await p.deliver([['k2', 200, false, { Nom: 'Bob', Ville: 'Metz' }]]);
    p.as(p.target);
    await consolidateAll({ reread: true });
    assert.deepEqual(names(p.target), [['Alice', 'Lyon'], ['Bob', 'Metz'], ['Zoé', 'Brest']]);
    assert.equal(resultOf(p.made).structure, null);
  });
});

test('sans colonne commune, l\'aperçu dit que les lignes déjà là seront en double', async () => {
  const p = await pair('adopt2', { existing: HERE, options: { ask: true } });
  await p.deliver(FIRST);
  p.as(p.target);
  await consolidateAll();
  const { adoption } = resultOf(p.made).structure;
  assert.deepEqual([adoption.added, adoption.attached, adoption.untouched, adoption.match], [2, 0, 2, '']);
  await approveStructure(p.made.journal);
  assert.equal(p.target.rows('Annuaire').length, 4, 'Alice est en double : c\'est ce que l\'aperçu annonçait');
});

test('réception qui applique seule, ou table qui n\'existait pas : aucun aperçu', async (t) => {
  await t.test('applique seule', async () => {
    const p = await pair('adopt3', { existing: HERE, options: {}, match: 'Nom' });
    p.as(p.target);
    assert.equal((await journalNote()).tables[0].adopt, undefined);
    await p.deliver(FIRST);
    p.as(p.target);
    await consolidateAll();
    assert.deepEqual(names(p.target), [['Alice', 'Lyon'], ['Bob', 'Nice'], ['Zoé', 'Brest']]);
    assert.equal(resultOf(p.made).structure, null);
  });
  await t.test('table créée par la réception', async () => {
    const p = await pair('adopt4', { options: { ask: true } });
    p.as(p.target);
    assert.equal((await journalNote()).tables[0].adopt, undefined);
    await p.deliver(FIRST);
    p.as(p.target);
    await consolidateAll();
    assert.deepEqual(names(p.target), [['Alice', 'Lyon'], ['Bob', 'Nice']]);
  });
  await t.test('table existante mais vide : rien à protéger, la table est notée adoptée à la première recopie', async () => {
    const p = await pair('adopt5', { existing: [], options: { ask: true } });
    await p.deliver(FIRST);
    p.as(p.target);
    await consolidateAll();
    assert.deepEqual(names(p.target), [['Alice', 'Lyon'], ['Bob', 'Nice']]);
    assert.equal((await journalNote()).tables[0].adopted, true);
  });
});

test('logique : type, colonnes à signaler, étape, aperçu', async (t) => {
  await t.test('typeFit', () => {
    const cases = [['Text', 'Text', 'same'], ['Int', 'Numeric', 'fine'], ['Numeric', 'Int', 'risky'], ['Int', 'Text', 'fine'], ['Bool', 'Text', 'fine'],
      ['Date', 'Text', 'risky'], ['DateTime:UTC', 'Text', 'risky'], ['Text', 'Any', 'fine'], ['Text', 'Choice', 'fine'], ['Int', 'Choice', 'risky'], ['Text', 'Date', 'risky'],
      ['Text', 'Ref:Villes', 'bad'], ['Text', 'RefList:Villes', 'bad'], ['Attachments', 'Text', 'bad'], ['Text', 'Attachments', 'bad'], ['Int', 'PositionNumber', 'bad'],
      ['DateTime:Europe/Paris', 'DateTime:UTC', 'same']];
    for (const [sent, here, level] of cases) assert.equal(typeFit(sent, here), level, `${sent} -> ${here}`);
  });
  await t.test('fitIssues : seules les colonnes d\'ici qui existent et ne conviennent pas', () => {
    const columns = [{ id: 'Nom', type: 'Text' }, { id: 'Age', type: 'Int' }, { id: 'Ville', type: 'Text' }, { id: 'Neuve', type: 'Text' }, { id: 'id_sync', type: 'Text' }];
    const here = [{ colId: 'Nom', type: 'Text' }, { colId: 'Age', type: 'Date' }, { colId: 'Lieu', type: 'Ref:Villes' }];
    assert.deepEqual(fitIssues(columns, { Ville: 'Lieu' }, here), [
      { id: 'Age', to: 'Age', sent: 'Int', here: 'Date', level: 'risky' },
      { id: 'Ville', to: 'Lieu', sent: 'Text', here: 'Ref:Villes', level: 'bad' },
    ]);
  });
  await t.test('adoptionStep', () => {
    const entry = { adopt: true };
    assert.equal(adoptionStep({ ask: true }, {}, [{}]), 'go', 'table non adoptée');
    assert.equal(adoptionStep({ ask: true }, { adopt: true, adopted: true }, [{}]), 'go', 'déjà adoptée');
    assert.equal(adoptionStep({ ask: true }, entry, [{}]), 'hold');
    assert.equal(adoptionStep({ ask: true, approve: true }, entry, [{}]), 'mark');
    assert.equal(adoptionStep({ ask: false }, entry, [{}]), 'mark', 'la réception applique seule');
    assert.equal(adoptionStep({ ask: true }, entry, []), 'mark', 'table vide');
  });
  await t.test('adoptionPreview : valeurs longues coupées, cellules vides remplies et non comptées comme remplacées', () => {
    const long = 'x'.repeat(100);
    const row = { id: 1, Nom: 'Alice', Ville: long, Pays: '' };
    const version = { id: 7, row: { Nom: 'Alice', Ville: 'Lyon', Pays: 'France', id_sync: 'k1' } };
    const copyCols = [['Nom', 'Nom'], ['Ville', 'Ville'], ['Pays', 'Pays']];
    const preview = adoptionPreview({ attached: [[row, version]], stats: { added: 2, updated: 1, removed: 0 } }, { copyCols, destRows: [row, { id: 2, Nom: 'Zoé' }], match: 'Nom' });
    assert.deepEqual({ ...preview, samples: preview.samples.map(s => s.here.length) },
      { added: 2, attached: 1, match: 'Nom', overwritten: 1, filled: 1, untouched: 1, samples: [40] });
  });
});
