# Synchro Grist : instructions pour Claude

## Le projet

Synchroniser **à sens unique** une table d'un document Grist SOURCE vers un document Grist CIBLE
de la même instance (cible principale : `grist.numerique.gouv.fr`, instance DINUM), sans serveur
à héberger. L'idée est née dans FormPlus (https://github.com/lombre33/FormPlus), mais le widget est
**totalement indépendant** : aucun code partagé, aucune mention de FormPlus dans l'interface.
FormPlus ne sert que de référence sur la gestion des clés de formulaire ; ne jamais le modifier
depuis ici.

Lire d'abord : `docs/01-etude-faisabilite.md` (étude complète, preuves dans le code de
grist-core et tests réels) et `docs/02-procedure-test-dinum.md` (test réel réussi sur DINUM le
14 octobre 2026).

## Conventions d'Antoine

- Répondre en français.
- Toute question à choix (2 à 4 options) passe par une carte de décision dédiée quand l'outil
  existe dans la session, jamais par des options écrites dans le corps du texte.
- Jamais la charte graphique DSFR (réservée aux services de l'État).
- **Charte d'interface** : les règles communes des widgets Grist Factory s'appliquent
  (`planning/identite-ui-ux-grist-factory.md` du dépôt https://github.com/lombre33/publipostageGrist,
  §1). Résumé de ce qu'elles imposent ici : `docs/03-proposition-ux-et-droits.md`, section 6.
- Git : travail directement sur `main`, commit et push sans pull request ni confirmation, une
  fois le travail vérifié (tests verts).
- Avant de coder lourdement, se mettre d'accord avec Antoine sur le parcours et les
  fonctionnalités (proposition en cours : `docs/03-proposition-ux-et-droits.md`).

## Ce qui est établi (ne pas redécouvrir)

**La chaîne qui marche, vérifiée en local (Grist 1.7.21) et sur DINUM :**

1. Dans la CIBLE, un formulaire Grist publié sur une table `Journal` fournit une clé de partage.
   Son lien copié a la forme `https://<instance>[/o/<équipe>]/forms/<clé>/<n>`.
2. Dans la SOURCE, un **webhook natif** (Paramètres du document, API, « Gérer les points
   d'ancrage Web », événements `add` et `update`) pointe sur
   `https://<instance>[/o/<équipe>]/api/s/<clé>/tables/Journal/records?flat=1`.
3. `?flat=1` (non documenté, utilisé par les tests de grist-core, `DocApi.ts:595-609`) fait
   accepter le corps du webhook (tableau nu de lignes complètes) et retire `id`. Chaque ajout ou
   modification devient une nouvelle ligne de `Journal`, en anonyme, en ~1 s.

**Pièges vérifiés :**

- La clé de formulaire n'autorise **que l'ajout** : `PUT` (upsert), `PATCH`, suppression et
  lecture lui sont refusés. La mise à jour se fait donc dans la CIBLE (designs A et C) ou par un
  relais authentifié (design B).
- Chaque clé envoyée doit être une **colonne de données** de `Journal` (colonnes formules de la
  SOURCE comprises), sinon `400 Invalid column` : la file du webhook se bloque.
- Une **Référence** affichant une autre colonne, ou une **mise en forme conditionnelle**, dans la
  table SOURCE ajoute des colonnes cachées `gristHelper_*` impossibles à créer dans la CIBLE : le
  mode direct casse. Table SOURCE « plate » obligatoire.
- **Pas d'événement de suppression** (`add` et `update` seulement) : suppression logique par une
  colonne booléenne `Supprime`.
- Les `id` sont retirés et réutilisés : clé stable = colonne remplie à la création par une
  formule de déclenchement `UUID()`.
- La file d'envoi est **FIFO et bloquante** : un envoi en échec est retenté ~15 min et bloque
  tous les suivants du document, puis est repoussé en fin de file (l'ordre d'arrivée n'est plus
  garanti, trier sur un horodatage `MajLe`). Bouton « Effacer la file d'attente » ou
  `DELETE /api/docs/<doc>/webhooks/queue`. Vécu sur DINUM le 14 octobre.
- Sans Redis, la file vit en mémoire (perdue au redémarrage). Livraison « au moins une fois ».
- Créer le webhook n'envoie aucune ligne existante : chargement initial en « touchant » les
  lignes par tranches de moins de 1000.
- Le lien du formulaire est un **droit d'écriture** sur toutes les colonnes de `Journal` : ne
  jamais le diffuser. Il est lisible par tout propriétaire de la SOURCE.
- Le webhook lit les lignes sans les règles d'accès : une table d'export minimale évite de copier
  des colonnes masquées.
- Un widget ne peut pas être le « travail de fond » : il ne tourne que page ouverte, et chaque
  onglet ouvert agit en double.
- Un widget servi depuis une autre origine (GitHub Pages) ne peut envoyer ni cookie ni en-tête
  `Authorization` à Grist (403 « Credentials not supported for cross-origin requests ») : pas de
  clé d'API depuis un widget. L'accès au document courant passe par `grist.docApi`.

- La clé du formulaire peut écrire **toutes** les colonnes de `Journal`, même absentes du
  formulaire : aucun état qui donnerait plus de pouvoir que l'injection de versions ne doit y vivre
  (la marque `Sync_Applique` en est l'exemple acceptable).
- Les vraies suppressions passent sans formulaire : une table SOURCE d'une ligne, formule
  `"ids:" + " ".join(T.all.id_sync)`, surveillée par un second webhook : recalculée (et envoyée)
  à chaque ajout ou suppression, pas à une modification. Vérifié le 14 octobre.
- Un widget **replié** dans Grist continue de tourner (vérifié le 14 octobre).
- Plusieurs formulaires publiés sur la même page partagent une seule clé : un seul lien suffit
  pour tous les journaux d'un envoi (vérifié par le test d'intégration).
- `_grist_Pages.options` `{"collapsed": true}` replie une page par défaut ; `indentation` en fait
  une sous-page.
- Ajouter une section à la page du widget recrée l'iframe du widget : toute étape qui en ajoute
  une (publication du formulaire) doit pouvoir reprendre où elle s'est arrêtée.

## Le design préféré d'Antoine (design C)

Le webhook dépose les versions dans `Journal` (table A). Un widget en accès complet, ouvert dans
la CIBLE par un éditeur, lit `Journal` (`grist.docApi.fetchTable`) et met à jour une table normale
éditable B avec les droits de cette personne (`grist.docApi.applyUserActions`, par exemple une
action `BulkAddOrUpdateRecord` par clé `id_sync` : vérifier sa signature exacte dans
`sandbox/grist/useractions.py` de grist-core). Conditions : ne tourne que si un éditeur ouvre la
page du widget ; noter dans B la dernière version de `Journal` appliquée pour ne pas écraser une
retouche manuelle ; écritures idempotentes (deux onglets ouverts ne doivent rien casser) ; purge
possible des lignes de `Journal` déjà appliquées.

Autre rôle utile du widget côté SOURCE : créer le webhook lui-même. Vérifié : un widget en accès
complet ouvert par un propriétaire obtient un jeton par `grist.docApi.getAccessToken()` et peut
appeler `POST /api/docs/<source>/webhooks?auth=<jeton>` depuis GitHub Pages.

## État : V0.3 (15 octobre 2026)

Pas de table de réglages. SOURCE : `id_sync`, `MajLe`, `Supprime` dans la table, une vue d'export
`<table>_summary_id_sync` (colonnes cochées en un bloc JSON `Synchro_Donnees`) surveillée par le
webhook, et `Synchro_<table>` (liste des clés, colonnes envoyées). CIBLE : `Journal_<table>` à
colonnes fixes. Invitations en attente et partages par lien public notés dans la description de
leur colonne `Synchro_Ids`. Mode lien public : règles d'accès marquées par un mémo, lecture
anonyme des vues d'export par la CIBLE. Code à la racine, sans build : `index.html`, `css/`, `js/`
(carte des modules dans `README.md`, analyse de sécurité dans `SECURITY.md`, tutoriel
`docs/04-tutoriel.md`). Tests : `npm test` (logique pure), `npm run test:e2e` après
`tests/e2e/start-grist.sh` (parcours complet dans un Grist Docker ; `CAPTURES=1` refait les
captures de `docs/images` et les images d'aide de `img/`). Les instances autorisées sont à la fois
dans `js/config.js` et dans la CSP de `index.html`.

V0.3 : aide intégrée au widget (Antoine veut que chaque rôle sache ce qu'il fait et ce que fait
l'autre, sans sortir du widget) : onglet Tutoriel (`js/tutorial.js`, captures `docs/images`, dont
l'installation `00*` faite par `installShots`), « Qui fait quoi ? » et « Copier avec les
consignes » (`js/guide.js`), aide en images repliée à chaque étape des assistants, logo Grist
Factory. « Reprendre » propose de rattraper les changements de la pause : l'heure de pause
(plus grande `MajLe` de la table, heure du serveur) est notée dans la note `Synchro_Ids`
(entrée `mode: 'pause'`).

Pièges vus en V0.2 : toute écriture REST depuis le widget doit porter `X-Requested-With` (sinon
401, vu comme une erreur CORS) ; changer une règle d'accès recharge le document, donc le widget ;
une table de résumé n'est lisible par une règle que si une ressource la nomme explicitement.
Désactiver un webhook remet à zéro son état d'envoi (`lastSuccessTime` perdu) et Grist ne met rien
en file pendant la pause. Dans les tests, `getByText` de Playwright est insensible à la casse et
cherche une sous-chaîne (« En pause » trouve « Mettre en pause »).
