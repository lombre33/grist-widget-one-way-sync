// Diagnostic à copier (Réglages) : relit le document et l'état des onglets, puis le met en texte
// (choix de ce qui en fait partie et forme : logic/diagnostic.js).
import { SYNC_TABLE, TYPE_COL, EXPORT_COL, TABLE_COL, RESEND_COL, nowS } from './logic/common.js';
import { diagnosticText, exportFacts, journalFacts } from './logic/diagnostic.js';
import { conditionExport, exportDrift, exportTables, hooksOf } from './logic/exports.js';
import { receivedJournals, receivedKey } from './logic/received.js';
import { LEASE_S, budgetWait, dueRows, parseCharge } from './logic/resend.js';
import { docIdentity, fetchRows, isOwner, isReadOnly, listWebhooks, readSchema, webhookConditions } from './grist.js';
import { isCharge, readSourceNote } from './source/synchro.js';
import { comparing, state, tableKey } from './target/loop.js';
import { VERSION, servedFrom } from './config.js';
import { recentErrors } from './ui.js';

async function sourceFacts(schema) {
  if (!schema.has(SYNC_TABLE)) return null;
  const owner = await isOwner().catch(() => false);
  const [hooks, conditions] = owner ? await Promise.all([listWebhooks(), webhookConditions()]) : [[], new Map()];
  const all = await fetchRows(SYNC_TABLE);
  const rows = all.filter(r => !isCharge(r));
  const note = readSourceNote(schema);
  const { late, lists } = dueRows(rows);
  const ids = [...new Set([...note.exports.map(e => e.id), ...rows.map(r => r[EXPORT_COL])])].filter(Boolean);
  const exports = ids.map((id) => {
    const tables = exportTables(rows, id);
    const of = list => list.filter(r => r[EXPORT_COL] === id).map(r => r[TABLE_COL]);
    return exportFacts({
      ...(note.exports.find(e => e.id === id) || { id, name: '' }), tables, ...exportDrift(schema, tables),
      invitations: note.invitations.filter(i => i.export === id), late: of(late), lists: of(lists), recipients: hooksOf(hooks, conditions, id),
    });
  });
  const charge = parseCharge((all.find(isCharge) || {})[RESEND_COL]);
  const now = nowS();
  const busy = charge.par && now - charge.le < LEASE_S ? `signe de vie il y a ${Math.round(now - charge.le)} s` : '';
  const wait = budgetWait(charge, now);
  return {
    ownerOnly: !owner,
    unsafe: hooks.filter(h => h.fields.tableId === SYNC_TABLE && !conditionExport(conditions.get(h.id))).length,
    charge: [busy, wait ? `budget atteint, reprise dans ${Math.round(wait)} s` : ''].filter(Boolean).join(', '),
    exports,
    kinds: rows.reduce((n, r) => ({ ...n, [r[TYPE_COL]]: (n[r[TYPE_COL]] || 0) + 1 }), {}),
  };
}

function targetFacts(schema) {
  const journals = receivedJournals(schema).map(({ journal, note }) => journalFacts({
    journal, note, signed: receivedKey(schema, journal, note),
    results: [state.results.get(journal), ...note.tables.map(tb => state.results.get(tableKey(journal, tb.table)))],
    offers: (state.offers.get(journal) || []).length,
  }));
  return { journals, compare: comparing() };
}

export async function diagnostic() {
  const schema = await readSchema();
  const owner = await isOwner().catch(() => false);
  return diagnosticText({
    version: VERSION,
    served: servedFrom(),
    origin: await docIdentity().then(d => d.origin, () => ''),
    access: isReadOnly() ? 'lecteur' : owner ? 'propriétaire' : 'éditeur',
    at: Date.now(),
    agent: navigator.userAgent,
    source: await sourceFacts(schema),
    target: targetFacts(schema),
    errors: recentErrors,
  });
}
