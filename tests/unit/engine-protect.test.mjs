// Les règles d'accès du widget sont posées AVANT la première donnée d'un export (protectSync) : la première ligne de
// Synchro copie les colonnes envoyées, y compris celles qu'une règle d'autrui cache aux lecteurs. Et quand Grist refuse
// de poser les règles (une règle d'autrui vise une colonne effacée), le refus est dit (ruleRefusal) au lieu d'être tu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startEngine } from '../../js/engine/index.js';
import { protectSync, ruleRefusal, syncRules } from '../../js/engine/acl.js';
import { saveChosenExport } from '../../js/engine/source/export.js';
import { SYNC_TABLE } from '../../js/engine/logic/common.js';
import { fakePair } from './engine-fake.mjs';

const OWNER_MEMO = 'Synchro : réservée aux propriétaires';
const REFUSAL = 'POST /docs/abc/apply: 400 {"error":"Invalid columns in rules for table Contacts: Prenom"}';

// Un moteur sur la SOURCE d'une paire, dont on règle l'assistant ouvert (`busy`) et le refus des règles par Grist (`refuse`).
function sourceEngine() {
  const { world, source } = fakePair('pr');
  const flags = { busy: false, refuse: false };
  const port = world.port(source);
  startEngine({
    version: '9.9.9',
    port: {
      ...port,
      page: { ...port.page, busy: () => flags.busy },
      apply: async (actions) => {
        if (flags.refuse && actions.some(a => a[1] === '_grist_ACLRules' || a[1] === '_grist_ACLResources')) throw new Error(REFUSAL);
        return port.apply(actions);
      },
    },
  });
  const rules = () => source.fetchRows('_grist_ACLRules').filter(r => r.memo === OWNER_MEMO);
  return { source, flags, rules };
}

test('protectSync : la table Synchro est créée vide et ses règles sont posées avant tout export', async () => {
  const { source, rules } = sourceEngine();
  assert.equal(source.tables.has(SYNC_TABLE), false);
  assert.equal(await protectSync(), true, 'le document va se recharger');
  assert.equal(source.fetchRows(SYNC_TABLE).length, 0, 'aucune ligne : aucune donnée à lire');
  assert.ok(rules().length >= 1, 'la règle des propriétaires est là');
  assert.equal(await protectSync(), false, 'déjà protégée : rien à recharger, l\'assistant s\'ouvre');
});

test('protectSync : le premier export arrive dans une table déjà protégée', async () => {
  const { source, rules } = sourceEngine();
  await protectSync();
  const before = rules().length;
  await saveChosenExport({ name: 'Annuaire', selection: [{ table: 'Contacts', columns: ['Nom'], filter: null }] });
  assert.ok(source.fetchRows(SYNC_TABLE).length > 0, 'l\'export est écrit');
  assert.equal(rules().length, before, 'les règles n\'ont pas changé : pas de second rechargement');
  assert.equal(await syncRules(), false);
});

test('pendant un assistant, syncRules attend, protectSync pose quand même les règles', async () => {
  const { source, flags, rules } = sourceEngine();
  flags.busy = true;
  await protectSync();
  assert.ok(rules().length >= 1, 'posées malgré l\'assistant ouvert');
  assert.equal(source.fetchRows(SYNC_TABLE).length, 0);
  // Une règle qui manque redevient à poser : syncRules, lui, ne fait rien tant que l'assistant est ouvert.
  source.apply([['RemoveRecord', '_grist_ACLRules', rules()[0].id]]);
  const left = rules().length;
  assert.equal(await syncRules(), false);
  assert.equal(rules().length, left, 'rien posé pendant l\'assistant');
});

test('protectSync : une table Synchro qui n\'est pas celle du widget n\'est pas touchée', async () => {
  const { source, rules } = sourceEngine();
  source.addTable(SYNC_TABLE, [{ id: 'A', type: 'Text' }, { id: 'B', type: 'Text' }], [{ A: 'x', B: 'y' }]);
  await assert.rejects(() => protectSync(), { message: 'syncTableForeign' });
  assert.equal(rules().length, 0);
  assert.equal(source.fetchRows(SYNC_TABLE).length, 1);
});

test('refus de Grist : syncRules le garde, protectSync le lève, et plus rien n\'est écrit', async () => {
  const { source, flags, rules } = sourceEngine();
  flags.refuse = true;
  assert.equal(ruleRefusal(), null);
  await assert.rejects(() => protectSync(), (e) => {
    assert.equal(e.message, 'rulesRefused');
    assert.equal(e.vars.why, 'Invalid columns in rules for table Contacts: Prenom');
    return true;
  });
  assert.equal(ruleRefusal(), 'Invalid columns in rules for table Contacts: Prenom');
  assert.equal(rules().length, 0);
  // Sans `strict`, l'onglet continue (syncRules rend faux) et le refus reste lisible pour l'avis.
  assert.equal(await syncRules(), false);
  assert.match(ruleRefusal(), /Prenom/);
  // L'utilisateur corrige sa règle : le refus s'efface avec la pose réussie.
  flags.refuse = false;
  assert.equal(await syncRules(), true);
  assert.equal(ruleRefusal(), null);
  assert.ok(rules().length >= 1);
  assert.ok(source.tables.has(SYNC_TABLE));
});
