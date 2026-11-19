// CIBLE : réceptions dont le journal a été supprimé (voir logic/lost.js). Le widget note, dans le
// partage du formulaire de chaque réception, de quoi la reconnaître ; si le journal disparaît, le partage
// reste et dit ce qui a été perdu.
import { apply, fetchRows, readSchema } from '../port.js';
import { formPages } from '../pages.js';
import { lostReceptions, readMark, receptionMark, renamedSince, shareTables } from '../logic/lost.js';

// Pose la marque sur le partage du formulaire de chaque réception qui n'en a pas (ou plus à jour : une
// table rangée plus tard change la liste des destinations). `receptions` : [{ journal, note }], voir
// receivedJournals. Réceptions sans formulaire (lien public, retour d'un Échange) et formulaires qui
// partagent une page avec d'autres (montage d'avant la 0.5) sont laissés. Rend vrai si quelque chose
// a changé. Un propriétaire (le partage est dans les données du document). Un journal renommé garde la marque
// qu'il avait : elle dit le nom que la SOURCE vise toujours (voir renamedSince).
export async function markReceptions(receptions) {
  const [forms, pages, shares, schema] = await Promise.all([formPages(), fetchRows('_grist_Pages'), fetchRows('_grist_Shares'), readSchema()]);
  const actions = [];
  for (const { journal, note } of receptions) {
    const form = forms.get(journal);
    if (note.mode === 'public' || note.retour || !form || form.shared) continue;
    const page = pages.find(p => p.viewRef === form.viewRef);
    const share = page && page.shareRef ? shares.find(s => s.id === page.shareRef) : null;
    if (share && renamedSince(schema, readMark(share.description), journal)) continue;
    const mark = receptionMark(journal, note);
    if (share && share.description !== mark) actions.push(['UpdateRecord', '_grist_Shares', share.id, { description: mark }]);
  }
  if (actions.length) await apply(actions);
  return actions.length > 0;
}

// Réceptions dont le journal a été supprimé ou renommé, que le document dit encore (voir lostReceptions). Une personne
// qui ne lit pas `_grist_Shares` n'en voit aucune.
export async function readLost() {
  try {
    const [schema, shares, forms, pages] = await Promise.all([readSchema(), fetchRows('_grist_Shares'), formPages(), fetchRows('_grist_Pages')]);
    return lostReceptions(schema, shares, shareTables(forms, pages));
  } catch (e) {
    return [];
  }
}

// Retire l'avis d'une réception supprimée : ses partages, et avec eux l'ancienne clé d'écriture, qui ne
// servait plus à rien (le partage reste dans Grist quand la page de son formulaire disparaît).
export async function dismissLost(lost) {
  await apply(lost.shares.map(id => ['RemoveRecord', '_grist_Shares', id]));
}
