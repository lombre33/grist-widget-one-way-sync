// Exports (SOURCE) : colonnes envoyables, lignes de Synchro, webhooks et leur condition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionExport, exchangeColumns, exchangeTables, exportDrift, exportEmail, exportStatus, exportableColumns, exportCondition, exportRowsActions, exportTables, hookErrorKey,
  hookLabel, hookMemo, hookName, hookStatus, hooksOf, isFileColumn, optionsActions, ownJournal, readTables, tooLarge,
} from '../../js/logic/exports.js';
import { sentColumns } from '../../js/logic/journal.js';
import { memoMatches } from '../../js/logic/trust.js';
import { EXPORT } from './fixtures.mjs';

test('Échange : ligne \'echange\' de l\'export, colonnes avec leur nom dans l\'autre document', () => {
  const E = '0123456789abcdef';
  const columns = [{ id: 'Nom_2', type: 'Text', label: 'Nom', source: 'Text', visible: '', as: 'Nom' }];
  const { actions } = exportRowsActions([], E, [{ table: 'Contacts', columns }], { swap: true });
  const values = actions[0][3];
  assert.deepEqual(values.Synchro_Type, ['cles', 'lot', 'suivi', 'echange']);
  assert.deepEqual(values.Synchro_Table, ['Contacts', 'Contacts', 'Contacts', '']);
  assert.equal(values.Synchro_Colonnes[0], '[{"id":"Nom_2","type":"Text","label":"Nom","source":"Text","visible":"","as":"Nom"}]');
  const rows = values.Synchro_Type.map((type, i) => ({ id: i + 1, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]])) }));
  assert.deepEqual(exportTables(rows, E).map(tb => tb.table), ['Contacts'], 'la ligne \'echange\' n\'est pas une table');
  assert.deepEqual(exportRowsActions(rows, E, [{ table: 'Contacts', columns }], { swap: true }).actions, []);
  assert.deepEqual(exportRowsActions(rows, E, [{ table: 'Contacts', columns }]).actions, [['BulkRemoveRecord', 'Synchro', [4]]]);
  assert.deepEqual(sentColumns([{ id: 1, Synchro_Colonnes: values.Synchro_Colonnes[0] }]), [{ id: 'Nom_2', type: 'Text', label: 'Nom', as: 'Nom' }]);
  assert.deepEqual(sentColumns([{ id: 1, Synchro_Colonnes: '[{"id":"Nom","type":"Text","as":"a b"}]' }]), [], 'nom dans l\'autre document invalide');
});

test('colonnes envoyables : Référence en texte, pièces jointes en liste de fichiers, colonnes techniques exclues', () => {
  const cols = [
    { colId: 'Nom', type: 'Text', label: 'Nom' },
    { colId: 'Ville', type: 'Ref:Villes', visible: 'Nom' },
    { colId: 'Tags', type: 'RefList:Tags', visible: '' },
    { colId: 'Photo', type: 'Attachments' },
    { colId: 'gristHelper_Display', type: 'Any' },
    { colId: 'manualSort', type: 'ManualSortPos' },
    { colId: 'id_sync', type: 'Text' }, { colId: 'MajLe', type: 'DateTime:UTC' }, { colId: 'Supprime', type: 'Bool' },
  ];
  const sendable = exportableColumns(cols);
  assert.deepEqual(sendable.map(c => [c.id, c.type, isFileColumn(c)]), [['Nom', 'Text', false], ['Ville', 'Text', false], ['Tags', 'Text', false], ['Photo', 'Attachments', true]]);
  assert.deepEqual(sendable[1], { id: 'Ville', label: 'Ville', type: 'Text', source: 'Ref:Villes', visible: 'Nom' });
});

test('pièces jointes : une table qui en envoie a sa liste de fichiers, que le webhook n\'envoie pas', () => {
  const E = '0123456789abcdef';
  const columns = [{ id: 'Nom', type: 'Text', label: 'Nom', source: 'Text', visible: '' }, { id: 'Photo', type: 'Attachments', label: 'Photo', source: 'Attachments', visible: '' }];
  const { actions, changed } = exportRowsActions([], E, [{ table: 'Contacts', columns }, { table: 'Villes', columns: columns.slice(0, 1) }]);
  assert.deepEqual(actions[0][3].Synchro_Type, ['cles', 'lot', 'suivi', 'fichiers', 'cles', 'lot', 'suivi']);
  assert.deepEqual(changed, ['Contacts', 'Villes']);
  const rows = actions[0][3].Synchro_Type.map((type, i) => ({ id: i + 1, ...Object.fromEntries(Object.entries(actions[0][3]).map(([k, v]) => [k, v[i]])) }));
  assert.deepEqual(exportTables(rows, E).map(tb => [tb.table, tb.columns.length]), [['Contacts', 2], ['Villes', 1]]);
  const without = exportRowsActions(rows, E, [{ table: 'Contacts', columns: columns.slice(0, 1) }, { table: 'Villes', columns: columns.slice(0, 1) }]);
  assert.deepEqual(without.actions.map(a => [a[0], a[2]]), [['BulkUpdateRecord', [1, 2, 3]], ['BulkRemoveRecord', [4]]], 'colonne retirée : la liste des fichiers part');
  assert.ok(!exportCondition(E).includes('fichiers'));
});

test('table Synchro : lignes d\'un export (liste, lot, instantané public), tables ajoutées, changées ou retirées', () => {
  const col = id => ({ id, type: 'Text', label: id, source: 'Text', visible: '', blocked: false });
  const E = '0123456789abcdef';
  const first = exportRowsActions([], E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(first.changed, ['Contacts', 'Villes']);
  assert.equal(first.actions.length, 1);
  const [, table, ids, values] = first.actions[0];
  assert.equal(table, 'Synchro');
  assert.equal(ids.length, 6);
  assert.deepEqual(values.Synchro_Type, ['cles', 'lot', 'suivi', 'cles', 'lot', 'suivi']);
  assert.deepEqual(values.Synchro_Colonnes[0], '[{"id":"Nom","type":"Text","label":"Nom","source":"Text","visible":""}]');
  const rows = ids.map((_, i) => ({ id: i + 1, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]])) }));
  rows.push({ id: 9, Synchro_Export: 'fedcba9876543210', Synchro_Table: 'Contacts', Synchro_Type: 'cles', Synchro_Colonnes: '[]' });
  assert.deepEqual(exportTables(rows, E), [{ table: 'Contacts', columns: JSON.parse(values.Synchro_Colonnes[0]), filter: null }, { table: 'Villes', columns: JSON.parse(values.Synchro_Colonnes[3]), filter: null }]);
  assert.deepEqual(exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]), { actions: [], changed: [] });
  const edit = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom'), col('Age')] }]);
  assert.deepEqual(edit.changed, ['Contacts']);
  assert.deepEqual(edit.actions.map(a => [a[0], a[2]]), [['BulkUpdateRecord', [1, 2, 3]], ['BulkRemoveRecord', [4, 5, 6]]], 'l\'autre export n\'est pas touché');
  const pub = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }], { isPublic: true });
  assert.deepEqual(pub.actions[0][3].Synchro_Type, ['complet', 'empreinte', 'complet', 'empreinte']);
  assert.deepEqual(pub.changed, []);
  // Filtre de lignes : une ligne 'filtre' par table filtrée ; poser, changer ou retirer un filtre
  // renvoie la table.
  const filter = { mode: 'all', conds: [{ id: 'Statut', source: 'Choice', visible: '', op: 'in', values: [' Actif '], labels: ['Actif'] }] };
  const filtered = exportRowsActions(rows, E, [{ table: 'Contacts', columns: [col('Nom')], filter }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(filtered.changed, ['Contacts']);
  assert.deepEqual(filtered.actions[0][3].Synchro_Type, ['filtre']);
  assert.equal(filtered.actions[0][3].Synchro_Colonnes[0], '{"mode":"all","conds":[{"id":"Statut","source":"Choice","visible":"","op":"in","values":["actif"],"labels":["Actif"]}]}');
  const withFilter = [...rows, { id: 10, Synchro_Export: E, Synchro_Table: 'Contacts', Synchro_Type: 'filtre', Synchro_Colonnes: filtered.actions[0][3].Synchro_Colonnes[0] }];
  assert.deepEqual(exportTables(withFilter, E)[0].filter, { mode: 'all', conds: [{ id: 'Statut', source: 'Choice', visible: '', op: 'in', values: ['actif'], labels: ['Actif'] }] });
  const unfiltered = exportRowsActions(withFilter, E, [{ table: 'Contacts', columns: [col('Nom')] }, { table: 'Villes', columns: [col('Ville')] }]);
  assert.deepEqual(unfiltered, { actions: [['BulkRemoveRecord', 'Synchro', [10]]], changed: ['Contacts'] });
});

test('webhook d\'un destinataire : condition sur son export, relue à l\'identique seulement', () => {
  const E = '0123456789abcdef';
  assert.equal(exportCondition(E), 'rec.Synchro_Export == "0123456789abcdef" and rec.Synchro_Type in ("cles", "lot")');
  assert.equal(conditionExport(exportCondition(E)), E);
  assert.equal(conditionExport(''), '');
  assert.equal(conditionExport(null), '');
  assert.equal(conditionExport('rec.Synchro_Export == "0123456789abcdef" or True and rec.Synchro_Type in ("cles", "lot")'), '');
  assert.throws(() => exportCondition('0123456789ABCDEF'), /codeInvalid/, 'l\'identifiant entre dans une formule : 16 chiffres hexadécimaux en minuscules');
  assert.throws(() => exportCondition('" or True or "'), /codeInvalid/);
  assert.equal(conditionExport('rec.Synchro_Export == "0123456789ABCDEF" and rec.Synchro_Type in ("cles", "lot")'), '');
  assert.equal(hookName('Annuaire', E), 'Synchro Annuaire #0123456789abcdef');
});

// Cas limites.

test('condition d\'un webhook : rien d\'autre que la forme exacte', () => {
  const ok = `rec.Synchro_Export == "${EXPORT}" and rec.Synchro_Type in ("cles", "lot")`;
  assert.equal(conditionExport(ok), EXPORT);
  assert.equal(conditionExport(` ${ok}`), '');
  assert.equal(conditionExport(ok.replace('"lot")', '"lot", "complet")')), '');
  assert.equal(conditionExport(ok.replace(EXPORT, `${EXPORT}" or "1`)), '');
  assert.equal(conditionExport(null), '');
  const hooks = [{ id: 'h1', fields: { tableId: 'Synchro' } }, { id: 'h2', fields: { tableId: 'Contacts' } }, { id: 'h3', fields: { tableId: 'Synchro' } }];
  const conditions = new Map([['h1', ok], ['h2', ok], ['h3', '']]);
  assert.deepEqual(hooksOf(hooks, conditions, EXPORT).map(h => h.id), ['h1'], 'webhook d\'une autre table ou sans filtre : pas un destinataire');
});

test('Échange : colonnes renvoyées sous leur nom d\'origine, correspondance déduite', () => {
  const entries = [{ table: 'Contacts', dest: 'Fiches', columns: [{ id: 'Nom' }, { id: 'Ville' }], map: { Ville: 'Commune' } }, { table: 'Vide', dest: 'Rien', columns: [{ id: 'X' }] }];
  entries[0].columns.push({ id: 'Photo' });
  const columnsOf = dest => (dest === 'Fiches' ? [{ id: 'Nom', type: 'Text' }, { id: 'Commune', type: 'Text' }, { id: 'Note', type: 'Text' }, { id: 'Photo', type: 'Attachments' }] : []);
  assert.deepEqual(exchangeTables(entries, columnsOf), [{ table: 'Fiches', filter: null, columns: [{ id: 'Nom', type: 'Text', as: 'Nom' }, { id: 'Commune', type: 'Text', as: 'Ville' }] }],
    'seules les colonnes reçues repartent (pas les pièces jointes) ; une destination sans colonne ne part pas');
  const allowed = new Set(['Ville', 'Nom', 'Lieu']);
  assert.deepEqual(exchangeColumns([{ id: 'Commune', as: 'Ville' }, { id: 'Nom' }], allowed),
    { sent: [{ id: 'Commune', as: 'Ville' }, { id: 'Nom' }], map: { Commune: 'Ville', Nom: 'Nom' } });
  assert.deepEqual(exchangeColumns([{ id: 'Commune', as: 'Ville' }], allowed, { Commune: 'Lieu' }).map, { Commune: 'Lieu' }, 'un choix noté l\'emporte');
  // L'autre document n'écrit que les colonnes que l'export d'ici envoie : ni colonne gardée pour
  // soi (Salaire), ni colonne nouvelle (Pirate).
  const forged = exchangeColumns([{ id: 'X', as: 'Salaire' }, { id: 'Salaire' }, { id: 'Pirate' }, { id: 'Commune', as: 'Ville' }], allowed);
  assert.deepEqual(forged, { sent: [{ id: 'Commune', as: 'Ville' }], map: { Commune: 'Ville' } });
});

test('état d\'un destinataire et d\'un export : pastille, erreur dite simplement', () => {
  const hook = (enabled, usage) => ({ id: 'h', fields: { enabled, memo: 'a@b.fr · docA12345678 · equipe' }, usage });
  assert.deepEqual(hookStatus(hook(false, {})), ['paused', 'off']);
  assert.deepEqual(hookStatus(hook(true, { status: 'idle', lastHttpStatus: 200 })), ['active', 'ok']);
  assert.deepEqual(hookStatus(hook(true, { status: 'retrying' })), ['error', 'err']);
  assert.deepEqual(hookStatus(hook(true, { lastHttpStatus: 403 })), ['error', 'err']);
  assert.equal(tooLarge(hook(true, { status: 'retrying', lastEventBatch: { httpStatus: 413 } })), true);
  assert.equal(tooLarge(hook(true, { status: 'idle', lastEventBatch: { httpStatus: 413 } })), false, 'seul compte l\'envoi que Grist retente');
  assert.equal(hookErrorKey(hook(true, { lastEventBatch: { httpStatus: 413 } })), 'send.error.size');
  assert.equal(hookErrorKey(hook(true, { lastHttpStatus: 400, lastErrorMessage: 'Invalid column "X"' })), 'send.error.column');
  assert.equal(hookErrorKey(hook(true, { lastHttpStatus: 404 })), 'send.error.link');
  assert.equal(hookErrorKey(hook(true, { lastHttpStatus: 500 })), 'send.error.other');
  const exp = fields => ({ recipients: [], invitations: [], ...fields });
  assert.deepEqual(exportStatus(exp({})), ['alone', 'off']);
  assert.deepEqual(exportStatus(exp({ invitations: [{}] })), ['invited', 'pending']);
  assert.deepEqual(exportStatus(exp({ public: true })), ['people', 'ok']);
  assert.deepEqual(exportStatus(exp({ recipients: [hook(true, {})] })), ['people', 'ok']);
  assert.deepEqual(exportStatus(exp({ recipients: [hook(true, {})], echange: true })), ['participants', 'ok']);
  assert.deepEqual(exportStatus(exp({ recipients: [hook(true, {})], echange: true, retour: true })), ['people', 'ok'], 'un retour d\'Échange n\'a qu\'un destinataire');
  assert.deepEqual(exportStatus(exp({ recipients: [hook(true, {}), hook(true, { lastHttpStatus: 403 })] })), ['error', 'err'], 'une erreur l\'emporte');
});

test('fiche d\'un destinataire : mémo, journal de retour, auteur de l\'export', () => {
  assert.equal(hookMemo({ email: 'a@b.fr', docId: 'docA12345678', team: '' }), 'a@b.fr · docA12345678');
  const memo = hookMemo({ email: 'a@b.fr', docId: 'docA12345678', team: 'equipe', docName: 'Suivi · RH' });
  assert.equal(memo, 'a@b.fr · docA12345678 · equipe/Suivi - RH', 'équipe/nom du document, sans « · » dans le nom');
  assert.ok(memoMatches(memo, 'docA12345678xyz'), 'le document se lit toujours dans le mémo');
  assert.equal(hookLabel(memo), memo);
  assert.equal(hookLabel(memo, 'Suivi 2027'), 'a@b.fr · docA12345678 · equipe/Suivi 2027', 'document renommé : son nom actuel');
  assert.equal(hookLabel('a@b.fr · docA12345678 · equipe', 'Suivi RH'), 'a@b.fr · docA12345678 · equipe/Suivi RH', 'mémo d\'avant la 0.10.1 complété');
  assert.equal(hookLabel('a@b.fr · docA12345678 · equipe'), 'a@b.fr · docA12345678 · equipe');
  assert.equal(hookLabel('a@b.fr · docA12345678', 'Perso'), 'a@b.fr · docA12345678 · Perso', 'sans équipe');
  assert.equal(hookLabel(hookMemo({ email: 'a@b.fr', docId: 'docA12345678', docName: 'Perso' })), 'a@b.fr · docA12345678 · Perso');
  assert.equal(hookLabel('', ''), '');
  const h = { id: 7, fields: { memo: 'a@b.fr · docA12345678 · equipe' } };
  assert.equal(ownJournal(h)({ note: { hook: 7 } }), true, 'noté à l\'approbation');
  assert.equal(ownJournal(h)({ note: { hook: 8, from: { docId: 'docA12345678' } } }), false, 'le webhook noté l\'emporte sur le document');
  assert.equal(ownJournal(h)({ note: { from: { docId: 'docA12345678' } } }), true, 'Échange branché avant : retrouvé par le document');
  assert.equal(ownJournal(h)({ note: { from: { docId: 'docA1234' } } }), false, 'document entier, pas un préfixe');
  assert.equal(ownJournal(h)({ note: { from: {} } }), false);
  const rows = [{ Synchro_Export: 'x', Sync_Par: 'x@b.fr' }, { Synchro_Export: 'y', Sync_Par: 'y@b.fr' }];
  assert.equal(exportEmail(rows, 'y'), 'y@b.fr');
  assert.equal(exportEmail(rows, 'z'), '');
});

test('tables lues pour un export : les siennes et celles qu\'affichent ses Références', () => {
  const tables = [
    { table: 'Contacts', columns: [{ id: 'Nom', source: 'Text' }, { id: 'Ville', source: 'Ref:Villes' }, { id: 'Tags', source: 'RefList:Tags' }] },
    { table: 'Villes', columns: [{ id: 'Nom', type: 'Text' }] },
  ];
  assert.deepEqual(readTables(tables), ['Contacts', 'Villes', 'Tags']);
});

test('écart d\'un export : table perdue, colonnes renommées, effacées, d\'un autre type ou affichage changé', () => {
  const cols = { Contacts: [{ colId: 'Nom', type: 'Text' }, { colId: 'Ville', type: 'Ref:Villes', visible: 'Code' }, { colId: 'Age', type: 'Text' }] };
  const schema = { has: t => t in cols, columns: t => cols[t] };
  const tables = [
    { table: 'Contacts', columns: [{ id: 'Nom', type: 'Text' }, { id: 'Ville', type: 'Text', source: 'Ref:Villes', visible: 'Nom' }, { id: 'Age', type: 'Numeric', source: 'Numeric' }, { id: 'Tel', type: 'Text' }] },
    { table: 'Perdue', columns: [{ id: 'X', type: 'Text' }] },
  ];
  assert.deepEqual(exportDrift(schema, tables), { lost: ['Perdue'], changed: ['Contacts.Ville', 'Contacts.Age', 'Contacts.Tel'] });
  assert.deepEqual(exportDrift(schema, [{ table: 'Contacts', columns: [{ id: 'Nom', type: 'Text' }] }]), { lost: [], changed: [] });
});

test('choix avec un filtre de lignes : la liste ne part pas, le format part ; sans filtre elle revient seule', () => {
  const E = '0123456789abcdef';
  const cols = { Contacts: [{ colId: 'Etat', type: 'Choice', widgetOptions: '{"choices":["A","B"],"choiceOptions":{"A":{"fillColor":"#FF0000"}},"alignment":"center"}' }, { colId: 'Nom', type: 'Text' }] };
  const schema = { has: t => t in cols, columns: t => cols[t] };
  const columns = exportableColumns(cols.Contacts);
  const filter = { mode: 'all', conds: [{ id: 'Nom', source: 'Text', visible: '', op: 'eq', values: ['x'] }] };
  const { actions } = exportRowsActions([], E, [{ table: 'Contacts', columns, filter }]);
  const sentOpts = text => JSON.parse(text)[0].opts;
  assert.deepEqual(sentOpts(actions[0][3].Synchro_Colonnes[0]), { alignment: 'center' }, 'format seul');
  const rows = actions[0][3].Synchro_Type.map((type, i) => ({ id: i + 1, ...Object.fromEntries(Object.entries(actions[0][3]).map(([k, v]) => [k, v[i]])) }));
  assert.deepEqual(rows.map(r => r.Synchro_Type), ['cles', 'lot', 'suivi', 'filtre']);
  assert.deepEqual(optionsActions(rows, schema), [], 'le contrôle périodique ne remet pas la liste');
  const unfiltered = rows.filter(r => r.Synchro_Type !== 'filtre');
  assert.equal(optionsActions(unfiltered, schema).length, 1, 'filtre retiré : la liste revient à la prochaine lecture');
  assert.deepEqual(sentOpts(optionsActions(unfiltered, schema)[0][3].Synchro_Colonnes[0]).choices, ['A', 'B']);
  const plain = exportRowsActions([], E, [{ table: 'Contacts', columns }]).actions[0][3];
  assert.deepEqual(sentOpts(plain.Synchro_Colonnes[0]).choices, ['A', 'B'], 'sans filtre : la liste part');
});

test('choix et formats : envoyés avec les colonnes, réécrits quand ils changent, sans renvoi des lignes', () => {
  const E = '0123456789abcdef';
  const cols = { Contacts: [{ colId: 'Etat', type: 'Choice', widgetOptions: '{"choices":["A"]}' }, { colId: 'Ville', type: 'Ref:Villes', widgetOptions: '{"alignment":"right","widget":"Reference"}' }, { colId: 'Nom', type: 'Text' }] };
  const schema = { has: t => t in cols, columns: t => cols[t] };
  const columns = exportableColumns(cols.Contacts);
  assert.deepEqual(columns.map(c => c.opts || null), [{ choices: ['A'] }, { alignment: 'right' }, null]);
  const { actions } = exportRowsActions([], E, [{ table: 'Contacts', columns }]);
  const values = actions[0][3];
  const rows = values.Synchro_Type.map((type, i) => ({ id: i + 1, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v[i]])) }));
  assert.deepEqual(optionsActions(rows, schema), [], 'rien n\'a changé');
  cols.Contacts[0].widgetOptions = '{"choices":["A","B"]}';
  const update = optionsActions(rows, schema);
  assert.equal(update.length, 1);
  assert.deepEqual(update[0][2], [1, 2, 3], 'liste, lot et suivi');
  assert.ok(update[0][3].Synchro_Colonnes.every(v => JSON.parse(v)[0].opts.choices.join() === 'A,B'));
  const after = rows.map((r, i) => ({ ...r, Synchro_Colonnes: update[0][3].Synchro_Colonnes[i] }));
  assert.deepEqual(optionsActions(after, schema), []);
  const again = exportRowsActions(rows, E, [{ table: 'Contacts', columns: exportableColumns(cols.Contacts) }]);
  assert.deepEqual(again.changed, [], 'une liste de choix changée ne renvoie pas la table');
  assert.equal(again.actions.length, 1);
  assert.deepEqual(optionsActions([...rows, { id: 9, Synchro_Export: E, Synchro_Table: 'Perdue', Synchro_Type: 'cles', Synchro_Colonnes: '[]' }], { has: t => t === 'Contacts', columns: t => cols[t] }).length, 1, 'table introuvable laissée');
});
