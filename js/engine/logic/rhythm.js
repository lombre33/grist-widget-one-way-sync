// Rythme de la recopie de la CIBLE : que faire de la réponse de Grist à « qu'est-ce qui a changé ? » (docChanges, voir
// rest-port.js). Trois cas :
//  - 'answered'   : Grist a répondu (une empreinte et les tables touchées, ou « tout relire » avec une empreinte neuve) ;
//  - 'unanswered' : Grist n'a pas pu répondre (réseau coupé, document rechargé, ou refus que le navigateur ne laisse pas lire,
//                   par exemple un 403 sans en-tête CORS : fetch lève alors une erreur, sans code) ; l'empreinte reste celle
//                   d'avant et les tables sont inconnues ;
//  - 'refused'    : Grist refuse la comparaison (401, 403 lisible : il faut pouvoir lire tout le document).
// Une réponse manquée ne veut pas dire « rien n'a changé » : mesuré dans un vrai Grist (le 18 novembre), la CIBLE, qui la lisait
// ainsi, ne recopiait plus que toutes les 5 minutes quand /compare était bloqué comme sur DINUM (221 s et 301 s au lieu de 10 s).
// Elle garde alors le rythme d'avant la comparaison (toutes les 10 s tant que des lignes arrivent, puis toutes les minutes), et
// renonce à la comparaison après COMPARE_TRIES réponses manquées de suite (un raté isolé ne la coupe pas).
export const COMPARE_TRIES = 3;

export function changeVerdict(changes, hash) {
  if (!changes) return 'refused';
  return changes.tables === null && changes.hash === hash ? 'unanswered' : 'answered';
}

// Réponses manquées de suite après celle-ci (`fails`) et la comparaison est-elle gardée (`keep`) ?
export function nextCompare(fails, verdict) {
  if (verdict === 'answered') return { fails: 0, keep: true };
  const next = fails + 1;
  return { fails: next, keep: verdict === 'unanswered' && next < COMPARE_TRIES };
}
