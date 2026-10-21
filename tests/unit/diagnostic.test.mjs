// Diagnostic à copier : ce qu'il dit, et surtout ce qu'il ne dit jamais (adresses, clés, courriels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticText, exportFacts, hookFacts, journalFacts } from '../../js/logic/diagnostic.js';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const hook = {
  id: 'f00dcafe-1234-5678',
  fields: { enabled: true, url: `https://g.fr/api/s/${KEY}/tables/Journal_x/records?flat=1`, memo: 'ana@exemple.fr · doc123 · Annuaire' },
  usage: { status: 'retrying', numWaiting: 3, lastSuccessTime: 1760000000000, lastFailureTime: 1760000060000, lastHttpStatus: 400,
    lastErrorMessage: `Invalid column "Tel" at https://g.fr/api/s/${KEY}/tables/Journal_x/records`, lastEventBatch: { attempts: 4 } },
};
const exp = {
  id: '0123456789abcdef', name: 'Annuaire', echange: true, renforce: true,
  tables: [{ table: 'Contacts', columns: [{ id: 'Nom' }, { id: 'Tel' }], filter: { conds: [] } }],
  lost: ['Villes'], changed: ['Contacts.Tel'], invitations: [{ secret: 'chut' }], late: ['Contacts'], lists: [], recipients: [hook],
};
const note = {
  export: 'fedcba9876543210', mode: 'echange', name: 'Annuaire', secret: 'chut', pub: 'B'.repeat(80), from: { email: 'bob@exemple.fr', docId: 'docXYZ' },
  tables: [{ table: 'Contacts', dest: 'Annuaire' }], refused: ['Pays'], missing: { Contacts: 2 }, big: {}, suspect: { n: 4, at: 1760000000, flood: 1760000000 },
  sceau: 'abcd1234', reserve: true, renforce: true,
};

test('destinataire : état d\'envoi seulement, erreur sans la clé du formulaire', () => {
  const facts = hookFacts(hook);
  assert.equal(facts.id, 'f00dcafe');
  assert.deepEqual([facts.enabled, facts.status, facts.waiting, facts.http, facts.attempts], [true, 'retrying', 3, 400, 4]);
  assert.equal(facts.success, '2025-10-09T08:53:20Z');
  assert.ok(!JSON.stringify(facts).includes(KEY.slice(4)));
  assert.ok(!JSON.stringify(facts).includes('ana@'));
  assert.deepEqual(hookFacts({ id: 'x', fields: { enabled: false } }), { id: 'x', enabled: false, status: '', waiting: 0, success: '', failure: '', http: 0, error: '', attempts: 0 });
});

test('erreur de Grist : adresse, document, équipe et jeton retirés ; dates absurdes sans exception', () => {
  const error = 'request to https://grist.exemple.fr/o/equipe-x/api/docs/aBcDeFgHiJkLmNoPqRsTuV/tables/T/records?auth=eyJhbGciOiJIUzI1NiJ9.abc failed, Bearer eyJhbGciOiJIUzI1NiJ9 doc aBcDeFgHiJkLmNoPqRsTuV';
  const facts = hookFacts({ id: 'h', fields: { enabled: true }, usage: { lastErrorMessage: error, lastSuccessTime: NaN, lastFailureTime: 1e20 } });
  for (const secret of ['equipe-x', 'aBcDeFgHiJkLmNoPqRsTuV', 'eyJhbGci', 'grist.exemple.fr']) assert.ok(!facts.error.includes(secret), secret);
  assert.ok(facts.error.includes('[adresse]') && facts.error.includes('Bearer …'));
  assert.deepEqual([facts.success, facts.failure], ['', ''], 'une date impossible est omise');
  assert.ok(hookFacts({ id: 'h', usage: { lastErrorMessage: 'x'.repeat(500) } }).error.length <= 160);
});

test('texte : exports, réceptions, erreurs, sans secret, clé, courriel ni document', () => {
  const text = diagnosticText({
    version: '0.12.0', served: 'bêta', origin: 'https://g.fr', access: 'propriétaire', at: 1760000000000, agent: 'Navigateur',
    source: { ownerOnly: false, unsafe: 1, charge: '', kinds: { cles: 1, lot: 1 }, exports: [exportFacts(exp), exportFacts({ id: 'e2', name: 'Vide', public: true })] },
    target: { compare: false, journals: [journalFacts({ journal: 'Journal_annuaire', note, signed: 'k', results: [undefined, { table: 'Contacts', error: 'x', text: `HTTP 403 /api/s/${KEY}` }], offers: 1 })] },
    errors: [{ at: 1760000000000, text: 'Lien refusé' }],
  });
  for (const secret of [KEY.slice(4), 'ana@', 'bob@', 'chut', 'docXYZ', 'doc123', 'B'.repeat(20), 'abcd1234']) assert.ok(!text.includes(secret), secret);
  for (const said of ['Diagnostic Synchro Grist 0.12.0 (bêta)', 'Instance : https://g.fr', 'Export 01234567 « Annuaire » (echange, renforcé)',
    'tables : Contacts (2 col., filtre)', 'tables introuvables : Villes', 'colonnes changées : Contacts.Tel', 'lots coupés : Contacts',
    'destinataire f00dcafe : actif, retrying, file 3', 'HTTP 400, 4 essais, « Invalid column', 'Export e2 « Vide » (public)', 'aucun destinataire',
    'Webhooks sur Synchro sans filtre reconnu : 1', 'Lignes de Synchro : cles 1, lot 1', 'rythme lent',
    'Réception Journal_annuaire (export fedcba98, echange, renforcé)', 'tables : Contacts → Annuaire', 'tables refusées : 1', 'tables proposées : 1',
    'signée : oui, sceau : oui, réservée aux éditeurs : en attente', 'lignes manquantes : Contacts: 2', 'arrivées suspectes : 4 (', ', flot)',
    'erreurs : Contacts: HTTP 403 /api/s/AbCd…', 'Lien refusé']) assert.ok(text.includes(said), said);
});

test('texte : document sans export ni réception', () => {
  const text = diagnosticText({ version: '1', served: 'officielle', origin: '', access: 'lecteur', at: 0, agent: '', source: null, target: { journals: [] } });
  assert.ok(text.includes('Aucun export (pas de table Synchro).'));
  assert.ok(text.includes('Aucune réception.'));
  assert.ok(text.includes('Instance : inconnue'));
  assert.ok(text.endsWith('Aucune.'));
  const owner = diagnosticText({ version: '1', served: '', origin: '', access: '', at: 0, agent: '', source: { ownerOnly: true, exports: [], charge: 'budget atteint' }, target: null });
  assert.ok(owner.includes('lecture réservée aux propriétaires') && owner.includes('Aucun export.') && owner.includes('Renvoi en cours : budget atteint'));
  assert.equal(journalFacts({ journal: 'J', note: { export: 'e' } }).reserve, 'non');
  assert.equal(journalFacts({ journal: 'J', note: { export: 'e', reserve: true, reserved: true, ended: 10 } }).reserve, 'posée');
});
