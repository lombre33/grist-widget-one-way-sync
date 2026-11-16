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

// Une invitation en attente garde sa clé privée dans la note de la SOURCE jusqu'à l'approbation : la sonde la laisse là, puis
// un propriétaire passe sur la CIBLE (les règles d'accès y sont alors en place).
export async function leavePendingInvitation(p) {
  await p.sv.openTab(p.src.url, 'Envoyer');
  await p.sv.button('Ajouter un destinataire').click();
  await p.sv.dialogButton('Créer l’invitation').click();
  await p.sv.dialog().getByText('Transmettez ce code').waitFor({ timeout: 60000 });
  await p.sv.dialogButton('Plus tard').click();
  await p.dv.openTab(p.dst.url, 'Recevoir');
  await new Promise(resolve => setTimeout(resolve, 12000));
}
