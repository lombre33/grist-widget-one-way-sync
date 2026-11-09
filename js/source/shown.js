// Ce que l'écran montre d'un destinataire (la fiche du moteur, `hookLabel`, reste dans l'infobulle et
// l'historique) : « e-mail · équipe/nom du document », sans l'identifiant du document, qui ne dit rien à la
// personne. Sans nom connu, l'identifiant reste. Affichage seul : rien dans le moteur.
import { hookLabel } from '../engine/logic/exports.js';

export function hookShown(memo, docName = '') {
  const parts = hookLabel(memo, docName).split(' · ').filter(Boolean);
  return (parts.length === 3 ? [parts[0], parts[2]] : parts).join(' · ');
}
