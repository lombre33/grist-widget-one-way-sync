// Les notes du widget sont dans les options des colonnes, jamais dans leur description (Grist laisse lire les
// descriptions aux lecteurs du document, lien public compris, même pour une colonne qu'ils ne peuvent pas lire).
// Une SOURCE et une CIBLE en mémoire (engine-fake.mjs) : ce que le moteur écrit, ce qu'il déplace d'un document
// d'avant la 3.0.0, et la règle qui cache la clé de signature aux lecteurs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { readSchema } from '../../js/engine/port.js';
import { syncRules } from '../../js/engine/acl.js';
import { moveNotes } from '../../js/engine/note-move.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { invitationCode, startInvitation } from '../../js/engine/source/invite.js';
import { ensureSyncTable, readSourceNote, updateSourceNote } from '../../js/engine/source/synchro.js';
import { createReception, readInvitation } from '../../js/engine/target/receive.js';
import { consolidateAll } from '../../js/engine/target/loop.js';
import { KEY_MEMO } from '../../js/engine/logic/acl.js';
import { receivedJournals, receivedKey, signedTables } from '../../js/engine/logic/received.js';
import { SIG_KEY } from '../../js/engine/logic/common.js';
import { fakePair } from './engine-fake.mjs';

// Une SOURCE qui exporte Contacts et une CIBLE qui le reçoit dans Annuaire_recu.
async function reception() {
  const { world, source, target } = fakePair('11');
  const as = doc => startEngine({ port: world.port(doc), version: '9.9.9' });
  as(source);
  const { created: exp } = await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom'], filter: null }] });
  const { entry, secret } = await startInvitation(exp);
  const { code } = await invitationCode(exp, entry, secret);
  as(target);
  const invitation = await readInvitation(code);
  const made = await createReception(invitation, invitation.tables.map(tb => ({ tb, dest: 'Annuaire_recu' })), { reserve: true, options: {} });
  return { source, target, made, as };
}

const columnsOf = (doc, tableId) => {
  const table = doc.fetchRows('_grist_Tables').find(tb => tb.tableId === tableId);
  return doc.fetchRows('_grist_Tables_column').filter(c => c.parentId === table.id);
};
const columnOf = (doc, tableId, colId) => columnsOf(doc, tableId).find(c => c.colId === colId);
const noteOf = column => (JSON.parse(column.widgetOptions || '{}')).syncNote;

// Remet les notes comme les écrivait une version d'avant la 3.0.0 : dans la description, sans options.
function makeLegacy(doc, columns) {
  for (const [tableId, colId] of columns) {
    const column = columnOf(doc, tableId, colId);
    const note = noteOf(column);
    assert.ok(note, `${tableId}.${colId} a une note à reculer`);
    doc.apply([['UpdateRecord', '_grist_Tables_column', column.id, { description: JSON.stringify(note), widgetOptions: '' }]]);
  }
}
const SOURCE_NOTE = ['Synchro', 'Synchro_Export'];
const NOTES = [['Journal_Annuaire', 'Synchro_Ids'], ['Annuaire_recu', 'id_sync']];

test('ce que le moteur écrit : les notes sont dans les options, les descriptions restent vides', async () => {
  const { source, target } = await reception();
  const exportColumn = columnOf(source, ...SOURCE_NOTE);
  assert.equal(exportColumn.description, '', 'la description de Synchro_Export est vide');
  assert.equal(noteOf(exportColumn).exports.length, 1, 'la note de la SOURCE est dans ses options');
  const journal = columnOf(target, ...NOTES[0]);
  assert.equal(journal.description, '');
  assert.equal(noteOf(journal).export.length > 0, true);
  const key = columnOf(target, ...NOTES[1]);
  assert.equal(key.description, '', 'la clé de signature n\'est pas dans la description d\'id_sync');
  assert.ok(Object.values(noteOf(key).signature).some(k => SIG_KEY.test(k)), 'elle est dans ses options');
  // Aucune description du document ne porte de JSON du widget.
  for (const doc of [source, target]) {
    assert.deepEqual(doc.fetchRows('_grist_Tables_column').filter(c => /^\s*[{[]/.test(c.description || '')).map(c => c.colId), []);
  }
});

test('document d\'avant la 3.0.0 : la SOURCE déplace sa note, qui se lit pareil avant et après', async () => {
  const { source, as } = await reception();
  as(source);
  const before = readSourceNote(await readSchema());
  makeLegacy(source, [SOURCE_NOTE]);
  assert.deepEqual(readSourceNote(await readSchema()), before, 'lue dans la description tant qu\'elle n\'est pas déplacée');
  assert.equal(await ensureSyncTable(), true, 'ensureSyncTable dit que le document a changé');
  const column = columnOf(source, ...SOURCE_NOTE);
  assert.equal(column.description, '');
  assert.deepEqual(readSourceNote(await readSchema()), before);
  assert.equal(await ensureSyncTable(), false, 'une fois déplacée, rien n\'est plus écrit');
});

test('document d\'avant la 3.0.0 : un passage de la CIBLE déplace la note du journal et la clé de signature', async () => {
  const { target, made, as } = await reception();
  as(target);
  const schema = await readSchema();
  const journalBefore = receivedJournals(schema)[0].note;
  const keyBefore = receivedKey(schema, made.journal, journalBefore);
  assert.ok(SIG_KEY.test(keyBefore));
  makeLegacy(target, NOTES);
  assert.ok(columnOf(target, ...NOTES[1]).description.includes(keyBefore), 'la clé est de nouveau dans la description');
  await consolidateAll({ reread: true });
  for (const [tableId, colId] of NOTES) assert.equal(columnOf(target, tableId, colId).description, '', `${tableId}.${colId}`);
  const after = await readSchema();
  assert.equal(receivedKey(after, made.journal, receivedJournals(after)[0].note), keyBefore, 'la même clé');
  assert.equal(receivedJournals(after)[0].note.export, journalBefore.export);
  assert.ok(!JSON.stringify(target.fetchRows('_grist_Tables_column').map(c => c.description)).includes(keyBefore), 'la clé n\'est plus dans aucune description');
});

test('une note déjà déplacée puis changée n\'est pas remplacée par la copie d\'avant (schéma lu trop tôt)', async () => {
  const { source, as } = await reception();
  as(source);
  makeLegacy(source, [SOURCE_NOTE]);
  const stale = await readSchema();
  await ensureSyncTable(); // un autre onglet déplace…
  await updateSourceNote(note => ({ ...note, nomDoc: 'Après le déplacement' })); // …puis change la note
  assert.equal(await moveNotes(stale), false, 'le schéma relu sous le verrou ne montre plus rien à déplacer');
  assert.equal(readSourceNote(await readSchema()).nomDoc, 'Après le déplacement');
});

test('une description d\'avant qui revient (version plus ancienne restée ouverte) est vidée, la note des options fait foi', async () => {
  const { source, as } = await reception();
  as(source);
  const column = columnOf(source, ...SOURCE_NOTE);
  source.apply([['UpdateRecord', '_grist_Tables_column', column.id, { description: JSON.stringify({ exports: [], invitations: [], pauses: [] }) }]]);
  assert.equal(readSourceNote(await readSchema()).exports.length, 1, 'les options font foi');
  assert.equal(await moveNotes(await readSchema()), true);
  assert.equal(columnOf(source, ...SOURCE_NOTE).description, '');
  assert.equal(readSourceNote(await readSchema()).exports.length, 1);
});

test('règle d\'accès : la colonne id_sync des tables qui portent une clé est cachée aux lecteurs', async () => {
  const { target, as } = await reception();
  as(target);
  assert.deepEqual(signedTables(await readSchema()), ['Annuaire_recu']);
  assert.equal(await syncRules(), true, 'les règles sont posées (le document se recharge)');
  const resources = target.fetchRows('_grist_ACLResources');
  const rules = target.fetchRows('_grist_ACLRules').filter(r => r.memo === KEY_MEMO);
  assert.equal(rules.length, 1);
  const resource = resources.find(r => r.id === rules[0].resource);
  assert.deepEqual([resource.tableId, resource.colIds, rules[0].aclFormula, rules[0].permissionsText], ['Annuaire_recu', 'id_sync', 'user.Access == VIEWER', '-R']);
  assert.equal(await syncRules(), false, 'posées une fois, elles ne changent plus');
  // La table n'est plus reçue : sa règle part avec sa clé.
  target.apply([['RemoveTable', 'Annuaire_recu']]);
  assert.equal(await syncRules(), true);
  assert.equal(target.fetchRows('_grist_ACLRules').filter(r => r.memo === KEY_MEMO).length, 0);
});
