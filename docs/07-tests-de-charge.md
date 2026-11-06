# Tests de charge et « bêtises » : fiabiliser les envois

Demande d'Antoine (6 novembre 2026), après le retour d'un utilisateur de l'Alpha dont l'envoi de 30 000 lignes de
20 colonnes n'avait laissé que 400 lignes chez le destinataire, sans aucune erreur : monter deux Grist réels,
essayer de **faire échouer** la transmission de toutes les façons possibles, et pour chaque échec trouvé, soit le
corriger dans le code, soit faire dire clairement à l'écran ce qui se passe et quoi faire.

Les scénarios sont des tests de bout en bout (deux vrais Grist 1.7.22 dans Docker, le widget dans un vrai
navigateur). Ils sont longs (de quelques minutes à un quart d'heure) et ne font pas partie de `npm test` ni du
parcours `run.mjs`.

## Lancer

```sh
tests/e2e/start-grist.sh                          # Grist de test sur le port 8484 (Docker requis)
node tests/e2e/charge.mjs                         # tous les scénarios de charge (long)
ONLY=volume ROWS=30000 COLS=20 node tests/e2e/charge.mjs
PORT=8700 ONLY=colonneSupprimee,tableRenommee node tests/e2e/betises.mjs
```

Variables communes : `PORT` (port où le test sert le widget, un par exécution lancée en parallèle), `ONLY`
(liste de scénarios séparés par des virgules).

Pannes d'envoi (429, 500, 503, connexion coupée, réponse qui ne vient jamais ou lente) : un second Grist derrière
un mandataire qui fait échouer les envois de webhooks à la demande (`chaos-proxy.mjs`).

```sh
PORT=8494 INTERNAL_PORT=8493 CONTAINER=grist-sync-chaos ENV_FILE=.env-chaos.json tests/e2e/start-grist.sh
CHAOS=1 INTERNAL_PORT=8493 ONLY=webhooksEnEchec MODES=status:429,reset node tests/e2e/charge.mjs
```

Autres variables : `FAST_BUDGET=1` (budget des renvois réduit à 3 Mo par 2 minutes, pour voir la pause en
quelques minutes), `RECIPIENTS=256` (scénario `beaucoupDestinataires`), `FIX=none|pause|revoke|unblock|auto`
(scénario `destinataireMort`), `ROWS`, `COLS`.

Le banc sert le widget depuis l'arbre de travail : modifier le code pendant un test change ce que les pages
ouvertes ensuite chargent.

## Scénarios de charge (`tests/e2e/charge.mjs`)

| Scénario | Ce qu'il fait |
| --- | --- |
| `smoke` | un export, quelques lignes : le banc marche |
| `volume` | 30 000 lignes × 20 colonnes : tout arrive (environ 4 minutes) |
| `valeursEtranges` | NaN, infini, très longs textes, retours à la ligne, émojis, guillemets, listes, dates |
| `doublons` | clés `id_sync` vides ou en double |
| `sourceFermee` | page SOURCE fermée en plein envoi, puis rouverte |
| `cibleFermee` | page CIBLE fermée ou cachée pendant tout l'envoi, puis ouverte |
| `destinataireMort` | un destinataire dont le document est supprimé bloque-t-il les autres ? (`FIX=…`) |
| `webhooksEnEchec` | 429, 500, 503, connexion coupée, réponse muette, réponse lente (`CHAOS=1`) |
| `budget` | « Tout renvoyer » à répétition : pause annoncée, reprise seule (`FAST_BUDGET=1`) |
| `celluleGeante`, `colonnesLarges`, `grandeTable` | cellule de plusieurs Mo, 120 colonnes, 100 000 lignes |
| `plusieursDestinataires`, `beaucoupDestinataires` | 3 destinataires, puis 256 sur une dizaine de lignes |
| `modifMasse`, `renvoisRepetes` | modifications en masse pendant un envoi, renvois enchaînés |

## « L'humain qui clique partout » (`tests/e2e/betises.mjs`)

Une quarantaine de bêtises faites dans Grist sur un document SOURCE ou CIBLE d'une synchro qui marche : colonne ou
table supprimée, renommée, retypée ; colonnes du widget (`id_sync`, `MajLe`) supprimées ; table `Synchro` vidée,
bricolée ou supprimée ; webhook supprimé, désactivé, redirigé ; règles d'accès sur la table, une colonne, les
lignes ou les tables du widget ; journal ou table reçue supprimés ou vidés ; formulaire dépublié ou supprimé ;
document CIBLE supprimé ; personne éditrice ou lectrice qui ouvre le widget ; données modifiées pendant l'envoi.

Pour chacune, le test fait une modification dans la SOURCE et relève : arrive-t-elle, que disent les deux cartes,
la file de Grist est-elle bloquée, y a-t-il des erreurs en console. Ce n'est pas un test qui passe ou échoue : c'est
un **relevé**, à lire ligne à ligne. Ce qui est corrigé l'est avec un test d'unité (`tests/unit/*.test.mjs`).

## Ce que Grist fait vraiment (mesuré, Grist 1.7.22)

- Une seule file d'envoi par document, dans l'ordre, 1 000 événements au plus (au-delà, **chaque écriture du
  document attend**, par pas de 5 s). Avec N destinataires, une modification fait N événements : 1 000 / N
  modifications rapprochées suffisent à la remplir (256 destinataires : 15 à 20 s par écriture).
- Un envoi qui échoue est retenté vingt fois (1, 2, 4 … 64 s, environ 15 minutes) pendant lesquelles les envois
  suivants du **document** attendent, puis il passe en fin de file (« postponed »).
- Désactiver un webhook (pause) vide sa file d'un coup et libère les autres. Supprimer un webhook **n'arrête
  pas** un envoi en cours de nouvelle tentative ; `DELETE /webhooks/queue/<id>` le fait.
- Pas de délai d'attente côté Grist : une réponse qui ne vient jamais laisse l'envoi « en cours » environ 5 minutes.
- Textes réels de l'échec : lien mort `404 {"error":"Share not known"}` ; journal supprimé
  `404 {"error":"Table not found \"Journal_X\""}` ; quota `429 {"error":"Too Many Requests"}` ; connexion coupée
  `request to … failed, reason: socket hang up` (statut HTTP nul, `lastHttpStatus` garde celui de l'envoi réussi
  d'avant). Le dernier lot (`lastEventBatch`) dit ce qui vient d'arriver, `lastHttpStatus` non.
- Reprise après 429, 500, 503 ou connexion coupée : environ 70 s après la fin de la panne, sans rien faire.
- SQLite lit un identifiant inconnu entre guillemets comme un texte : un `COUNT(DISTINCT "id_sync")` sur une
  colonne supprimée ne plante pas, il répond faux (corrigé : le schéma est lu d'abord).

## Ce que les tests ont trouvé, et ce qui a changé

| Échec trouvé | Correction |
| --- | --- |
| Valeur `NaN` ou infinie dans une cellule : le JSON du lot est invalide, l'export s'arrête sans bruit | `v()` de `formulas.js` envoie `None` |
| Lignes sans clé ou de même clé : elles n'arrivent pas, sans message | carte « Des lignes n'arriveront pas » et bouton « Réparer les clés » (`js/source/keys.js`, `js/logic/keys.js`) |
| Colonne `id_sync`, `MajLe` ou `RecalculLe` supprimée : plus rien ne part, et le décompte des clés mentait | même carte, qui nomme la colonne perdue et la remet |
| Un destinataire mort bloque tous ceux du document pendant 15 minutes ou plus | texte clair, « Mettre en pause » en tête, mise en pause **automatique** au bout de 60 s de lien mort (page SOURCE ouverte), vérifiée de bout en bout |
| Révoquer un destinataire mort ne libérait pas la file (plus de 4 minutes) | `deleteWebhook` vide d'abord la file de ce webhook |
| « Débloquer la file » proposé pour une erreur qu'il ne règle pas | masqué pour lien mort, journal supprimé, quota, panne du serveur, réseau, réponse muette |
| Erreur de connexion affichée avec un « 200 » périmé | `failureStatus` lit le dernier lot |
| Quota (429), panne (5xx), serveur injoignable ou muet : un seul texte « autre » | un texte par cause, qui dit aussi que les autres destinataires attendent |
| Un envoi « en cours » depuis plus de 3 minutes passait pour sain | compté comme erreur, texte « ne répond pas » |
| Journal supprimé chez le destinataire : « le lien ne marche plus » | texte propre (`send.error.journal`), pause automatique comme un lien mort |
| Webhook supprimé à la main dans Grist : « Personne ne reçoit encore » | avis « N destinataires ajoutés n'apparaissent plus » (`vanishedRecipients`) |
| Lignes de `Synchro` supprimées : la carte montre « — » sans rien dire | avis « Les lignes de cet export ont disparu », « Modifier » les remet (vérifié) |
| 256 destinataires : 512 contrôles de lien simultanés à chaque dessin | six à la fois (`pool`) et un seul contrôle par webhook à la fois |
| 256 destinataires : un message « attend derrière » par personne | un seul avis par export |
| CIBLE : « Arrivées suspectes » sans autre explication possible | le texte donne aussi l'explication innocente (SOURCE retouchée à la main) |
| CIBLE : clé de signature perdue (table reçue effacée) : la carte disait « En attente du lien » et ouvrait l'assistant | la carte dit l'erreur (`keyLost`) ; un premier passage en erreur ne compte plus pour un journal vide |
| CIBLE : formulaire dépublié ou page supprimée : la carte disait « À jour » | avis « Le formulaire de réception n'est plus publié » |
| Règle d'accès qui interdit l'écriture : « Erreur : Blocked by table update access rules » | texte qui dit où regarder (`error.blockedRules`) |
| Colonne masquée par une règle d'accès : « renommées, supprimées ou d'un autre type » | le texte cite aussi les règles d'accès |

## Ce qui reste (limites connues)

- La pause automatique ne se fait que **page SOURCE ouverte** (un widget ne tourne pas page fermée).
- Un lien mort ne se voit que par la SOURCE : le destinataire dont le formulaire est dépublié l'est dans sa carte,
  mais la SOURCE reste la seule à pouvoir réinviter.
- La table `Synchro` est la mémoire du widget (liste des exports, colonnes, clés). La supprimer ou la rendre
  illisible à tous, propriétaires compris, est irréparable : la SOURCE revient au premier écran, sans rien dire.
- Les erreurs passagères (429, 5xx, réseau) ne mettent pas en pause toutes seules : Grist réessaie pendant
  15 minutes et les autres destinataires attendent. Choix à faire : étendre la pause automatique à ces erreurs
  (au risque de couper un destinataire qui allait reprendre).
- Table de plus de 100 000 lignes, cellules de plusieurs Mo : voir les mesures de `grandeTable` et
  `celluleGeante` ; la limite de Grist (1 Mo par envoi) reste celle du format du lot.
- Onglet caché du navigateur : les minuteries sont ralenties (une fois par minute) ; non testable sans tête.
