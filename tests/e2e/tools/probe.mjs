// Départ commun des sondes de diagnostic : un Grist jetable, le widget servi, et une paire SOURCE / CIBLE de `rows` lignes
// de Contacts déjà arrivées chez le destinataire. Rend l'outillage (`h`) et la paire (`p`).
import { createHarness } from '../harness.mjs';
import { columnsOf, makeRow } from '../data.mjs';

export async function startProbe({ port, name, rows = 30 }) {
  const h = await createHarness({ port });
  const p = await h.pair({ name, table: 'Contacts', columns: columnsOf(8), rows, makeRow, send: 'wait' });
  await h.waitFor(async () => (await h.count(p.dst.doc, p.dest)) === rows, 'départ', 90000, 2000);
  return { h, p };
}
