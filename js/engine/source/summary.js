// SOURCE : une table de résumé ne peut pas être dans un Échange. Grist en calcule les lignes, le widget n'y écrit jamais : le retour de
// l'autre document n'aurait nulle part où se recopier (voir logic/summary.js).
import { summaryTables } from '../logic/summary.js';
import { failure } from '../errors.js';
import { readSchema } from '../port.js';

// Refuse un Échange (ou la modification d'un export en Échange) qui compte une table de résumé parmi `tables`.
export async function refuseSummaryExchange(tables) {
  const found = summaryTables(await readSchema(), tables);
  if (found.length) throw failure('exchangeSummary', { tables: found.join(', ') });
}
