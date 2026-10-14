# Synchronisation à sens unique entre deux documents Grist : étude de faisabilité

> **Origine** : ce document est la copie, au 14 octobre 2026, de l'étude menée dans le projet
> FormPlus (`docs/05-etude-synchro-inter-grist.md` sur https://github.com/lombre33/FormPlus).
> FormPlus est le widget de formulaire Grist d'Antoine ; l'idée de synchro y est née, d'où les
> mentions de FormPlus ci-dessous. Dans ce nouveau projet, « FormPlus » désigne simplement le
> widget qui joue le rôle d'assistant et de consolidateur : il peut être un nouveau widget dédié.

Étude du 14 octobre 2026, à partir de l'idée d'Antoine : un document SOURCE et un document CIBLE
sur la même instance ; un formulaire FormPlus est créé sur la CIBLE et sa clé est confiée à la
SOURCE ; un « travail de fond » observe une table de la SOURCE et, à chaque ajout ou modification,
envoie le formulaire ; côté CIBLE, on compare avec l'existant et on met à jour.

Rien n'a été implémenté dans le widget. Tout ce qui est marqué « vérifié » ci-dessous a été
exécuté sur un Grist 1.7.21 local (image `gristlabs/grist:latest`, conteneurs Docker jetables) et
relu dans le code de `grist-core` (commit `7a510f9` du 13 octobre 2026). « Déduit » signale ce qui
vient du code ou de la documentation sans test réel.

## Réponse courte

**Oui, une synchronisation à sens unique est faisable, et plus simplement qu'imaginé : ni widget
ni serveur ne sont nécessaires pour le transport.** Le « travail de fond » existe déjà dans Grist :
c'est le **webhook natif** du document SOURCE. Pointé sur l'adresse d'écriture du formulaire de la
CIBLE avec le paramètre `?flat=1`, il dépose chaque ajout ou modification dans une table de la
CIBLE environ une seconde plus tard, en anonyme, sans clé d'API (vérifié).

Trois corrections à l'idée de départ :

1. **Le widget ne peut pas être le travail de fond.** Il ne s'exécute que pendant qu'un navigateur
   affiche sa page, et chaque onglet ouvert envoie sa propre copie (vérifié, section 1).
2. **La CIBLE ne peut pas « comparer et mettre à jour » avec la clé du formulaire**, qui n'autorise
   que l'ajout. La mise à jour se calcule dans la CIBLE : un journal en ajout seul, plus une table
   de synthèse qui garde la dernière version de chaque ligne (vérifié, section 3). Une vraie table
   éditable mise à jour en place demande soit un widget FormPlus dans la CIBLE qui recopie le
   journal quand un éditeur ouvre la page (design C, section 5), soit un relais muni d'une clé
   d'API ou d'un compte de service (design B).
3. **Les suppressions ne sont jamais transmises** (Grist ne connaît que « ajout » et
   « modification ») : il faut une suppression logique côté SOURCE.

Le seul point bloquant était un réglage de l'instance DINUM : la variable
`ALLOWED_WEBHOOK_DOMAINS` doit autoriser `grist.numerique.gouv.fr` lui-même. **Le test réel du
14 octobre 2026 l'a confirmé : la chaîne fonctionne sur DINUM** (section 7).

Le rôle naturel de FormPlus n'est donc pas d'être le moteur de la synchro mais son **assistant de
configuration** : préparer les tables et le formulaire dédié côté CIBLE, puis créer le webhook côté
SOURCE (section 6).

## 1. Le « travail de fond » : le webhook natif, pas le widget

| Mécanisme | Tourne sans navigateur ouvert ? | Verdict |
|---|---|---|
| Widget FormPlus « observateur » dans la SOURCE | Non | Écarté |
| Webhook natif du document SOURCE | Oui, côté serveur | **Retenu** |
| Fonction de formule `REQUEST()` dans une formule de déclenchement | Oui, côté serveur | Écarté sauf instance qui l'active |

**Widget observateur (vérifié, Chromium headless).** Page ouverte, un ajout ou une modification
faite par l'API arrive bien dans la CIBLE en 0,2 s. Mais :

- rien ne part quand personne n'a la page ouverte, ni quand l'utilisateur est sur une autre page
  du document : l'iframe est détruite à chaque changement de page (`GristDoc.ts:860-883`) ;
- `onRecords` ne donne jamais d'écart, seulement tout le jeu de lignes visibles, à chaque
  changement : le widget doit mémoriser un état pour savoir ce qui a changé ;
- pour rattraper ce qui s'est passé page fermée, cet état doit survivre : la mémoire et
  `grist.setOption` (jamais enregistré sans clic sur « Enregistrer ») ne rattrapent rien ; le
  `localStorage` rattrape dans le même navigateur seulement ; une colonne d'empreinte dans la
  table SOURCE rattrape pour tous mais exige l'accès complet ;
- **deux onglets ouverts donnent des doublons systématiques** (4 lignes au lieu de 2), y compris
  avec la colonne d'empreinte : les deux instances reçoivent le même événement à la même
  milliseconde ;
- un onglet en arrière-plan est bridé, voire gelé par Chrome (non tranché en headless).

C'est d'ailleurs la voie qu'avait explorée le prototype `grist-sync-connector` du 4 septembre
2026 (widget dans la SOURCE, écriture avec une clé d'API), arrêté sur un blocage CORS. Ce blocage
est structurel : Grist refuse tout en-tête `Authorization` ou cookie venant d'une origine non
reconnue comme `*.github.io` (« 403 Credentials not supported for cross-origin requests »,
vérifié). La clé de formulaire, elle, passe parce qu'elle ne demande aucun identifiant.

**Webhook natif (vérifié).** Réglé dans Paramètres du document, section API, « Gérer les
webhooks » (ou `POST /api/docs/<doc>/webhooks`). Il tourne côté serveur, envoie en `POST` un
tableau JSON nu des lignes complètes (toutes les colonnes, formules comprises, plus `id` et
`manualSort`), par lots de 100 au plus, environ une seconde après la modification. Il sait filtrer
sur une liste de colonnes surveillées et sur une colonne booléenne « prête ».

**`REQUEST()` (vérifié).** Désactivée par défaut (`GRIST_ENABLE_REQUEST_FUNCTION`, présentée comme
un risque de sécurité par la documentation d'administration). Activée et placée dans une formule
de déclenchement, elle POSTe une ligne par modification vers la CIBLE. Mais dans une formule
ordinaire elle se relance à chaque chargement du document et toutes les heures, et avec `NOW()`
dans ses arguments elle part en boucle infinie (261 envois en 13 s). Rien n'indique qu'elle soit
activée sur l'instance DINUM.

## 2. Le transport : la clé de formulaire et `?flat=1`

Le corps envoyé par un webhook (`[{...}, {...}]`) ne correspond pas à ce qu'attend l'écriture
REST (`{"records": [{"fields": {...}}]}`) : pointé tel quel sur la CIBLE, le webhook échoue en
`400 body.records is missing` et réessaie en boucle (vérifié). C'est ce qu'a répondu le forum
Grist francophone en février 2025 : « il faut un intermédiaire ».

**Sauf avec `?flat=1`.** `POST /tables/<T>/records?flat=1` accepte précisément un tableau nu,
enveloppe chaque objet dans `{fields}` et retire `id` (`DocApi.ts:595-609`). Les tests officiels
de la page Webhooks de Grist utilisent exactement ce montage (`test/nbrowser/WebhookPage.ts:71`).
Le paramètre fonctionne aussi derrière une clé de partage, donc l'adresse du webhook devient :

```
https://<instance>/api/s/<clé du formulaire CIBLE>/tables/Journal/records?flat=1
```

Vérifié de bout en bout par trois tests indépendants : ajout et modification arrivent dans la
CIBLE en environ 1 s, statut du webhook `200`, aucune clé d'API, aucun relais.

Réserve : `?flat` n'apparaît pas dans la référence publique de l'API (seul `noparse` y est
documenté). Il est stable depuis mai 2023 et couvert par les tests de Grist, mais rien ne garantit
qu'il ne changera pas : à revérifier à chaque mise à jour de l'instance.

## 3. « Comparer et mettre à jour » côté CIBLE

### La clé de formulaire n'autorise que l'ajout (vérifié)

| Opération via `/api/s/<clé>/…` | Résultat |
|---|---|
| `POST /records` (y compris colonnes absentes du formulaire) | 200 |
| `PUT /records` (upsert « ajouter ou mettre à jour ») | 403 « Blocked by table read access rules » |
| `PATCH /records` | 403 « Blocked by table update access rules » |
| `POST /records/delete` | 403 « Blocked by table delete access rules » |
| `GET /records` | 200 mais toujours vide |
| `GET /sql` | 403 |

Code : règles virtuelles des partages, `ACLRulesReader.ts:270-316` (création seule sur la table du
formulaire, lecture limitée à `rec.id == 0`). Un widget côté CIBLE qui passerait par la clé ne
peut donc ni relire l'existant ni le modifier.

### Miroir à jour par formules, sans aucune clé d'API (vérifié)

1. **Table `Journal`** (celle du formulaire dédié) : une ligne par événement reçu, en ajout seul.
   Elle doit contenir, en colonnes de données, toutes les colonnes envoyées par la SOURCE, dont
   une clé de ligne (`id_source`) et un horodatage de modification (`MajLe`).
2. **Table de synthèse** de `Journal` groupée par `id_source` : Grist y crée et y met à jour
   automatiquement une ligne par clé source (c'est la seule façon de « créer des lignes » par
   formule). Une colonne `derniere = max($group, key=lambda r: (r.MajLe, r.id))` désigne la
   dernière version, et chaque colonne utile vaut `$derniere.Nom`, `$derniere.Statut`, etc.
   Piège vérifié : la synthèse crée d'office une somme pour chaque colonne numérique
   (`Score = SUM($group.Score)`), à remplacer.
3. Résultat vérifié : ajout, puis deux modifications, puis le miroir égale la SOURCE ; un événement
   rejoué en double est sans effet ; un événement plus ancien arrivé en retard est ignoré.

Limites : la table miroir se lit mais ne s'édite pas (pas de saisie, pas de colonne de données,
pas de suppression de ligne), et le journal grossit sans fin (une purge demande un éditeur).

### Upsert réel dans une table éditable : il faut un identifiant (vérifié)

`PUT /api/docs/<cible>/tables/<T>/records` avec `require: {id_source: …}` est exactement la brique
« comparer et mettre à jour » : la ligne est créée puis mise à jour en place, sans doublon. Mais
elle exige de lire la table, donc une clé d'API ou un compte de service, et un webhook ne fait
que des `POST`. Il faut donc un relais (section 5, design B). Deux pièges vérifiés : le relais
doit garder une seule version par `id_source` dans chaque lot (sinon `400 require values must be
unique`, qui bloque le webhook), et une clé d'API personnelle donne tous les droits de son
propriétaire sur toute l'instance. Les comptes de service, limitables à un seul document et même à
une table par règle d'accès, existent dans cette version mais seulement si l'instance active
`GRIST_ENABLE_SERVICE_ACCOUNTS`.

## 4. Limites et pièges

**Suppressions.** Seuls `add` et `update` existent (`Triggers.ts:55`), `remove` est refusé en
400 (vérifié). Parade : une colonne booléenne `Supprime` dans la SOURCE, surveillée par le
webhook ; le miroir filtre les lignes dont la dernière version la porte à vrai.

**Clé de ligne.** L'`id` est retiré à la réception, et Grist réattribue l'`id` de la dernière ligne
supprimée (vérifié). Une colonne `id_source = $id` ne convient donc que si la suppression physique
est interdite dans la SOURCE ; sinon, une colonne remplie à la création par une formule de
déclenchement `UUID()`.

**Couplage de schéma strict (mode direct).** Chaque clé envoyée doit être une colonne de données
du `Journal` (sinon `400 Invalid column`, et le webhook réessaie en bloquant). Pire, toute
**Référence** affichant une autre colonne ou toute **mise en forme conditionnelle** dans la table
SOURCE ajoute des colonnes cachées (`gristHelper_Display`, `gristHelper_ConditionalRule`) que la
CIBLE ne peut pas créer : le mode direct devient impossible (vérifié, y compris pour une simple
règle de couleur). Renommer une colonne d'un côté casse la synchro au premier envoi suivant
(vérifié). Le mode direct ne convient donc qu'à une table SOURCE « plate », dédiée à l'export,
que personne ne met en forme ; une Référence affichée par son identifiant de ligne, doublée d'une
colonne formule texte (`$Ville.Nom`), devrait passer (déduit, non testé). Une Référence arrive de
toute façon comme un identifiant de ligne de la SOURCE, sans signification dans la CIBLE.

**Pièces jointes.** Ne transitent pas : refusées par la clé de partage (vérifié).

**Fiabilité de la file.**

- Livraison « au moins une fois » : doublons possibles, absorbés par le miroir.
- Un lot en échec est retenté jusqu'à 20 fois (environ 15 min) en bloquant tous les webhooks du
  document, puis repoussé en fin de file, ce qui casse l'ordre (d'où le tri sur `MajLe`).
- Sans Redis, la file vit en mémoire : un événement en attente est perdu au redémarrage du
  serveur ou à la fermeture du document (vérifié). La file est plafonnée à 1000 événements ;
  au-delà, les lots en échec sont abandonnés définitivement.
- Une adresse non autorisée est refusée dès l'enregistrement du webhook (403 « Provided url is
  forbidden »). Mais si l'instance retire l'autorisation après coup, les envois sont abandonnés
  sans aucune erreur visible dans le statut du webhook, seulement dans le journal du serveur
  (vérifié).

**Chargement initial.** Créer le webhook n'envoie aucune ligne existante (vérifié). Il faut
« toucher » les lignes (modifier en masse une colonne surveillée) par tranches de moins de 1000,
geste qui sert aussi de resynchronisation périodique pour rattraper d'éventuelles pertes.

**Sécurité.**

- La clé de partage est celle du lien public du formulaire : quiconque l'a vue peut injecter de
  faux événements dans n'importe quelle colonne du `Journal`. Le formulaire de synchro doit être
  dédié et jamais diffusé.
- L'adresse du webhook (donc la clé) et un éventuel en-tête `Authorization` sont lisibles en clair
  par tout propriétaire du document SOURCE (vérifié).
- Le webhook lit les lignes en session « système », sans les règles d'accès : des colonnes masquées
  dans la SOURCE deviennent visibles dans la CIBLE. Raison de plus pour une table d'export
  minimale.
- Seul un propriétaire de la SOURCE peut créer le webhook.

**Quotas.** Les écritures par clé de partage ne sont pas décomptées du quota d'appels d'API
(`DocApiUsageTracker.ts:122-135`, seules les requêtes authentifiées par clé d'API le sont).

## 5. Designs possibles

| | A. Miroir sans serveur | B. Relais avec upsert | C. Widget CIBLE consolidateur |
|---|---|---|---|
| Transport | Webhook → clé de formulaire `?flat=1` → `Journal` | Webhook → petite fonction hébergée → `PUT` upsert | Webhook → clé de formulaire → `Journal` |
| Mise à jour côté CIBLE | Table de synthèse, en lecture seule | Table normale, éditable | Le widget recopie les dernières versions de `Journal` (table A) dans une table éditable (table B) |
| Tourne sans personne | Oui | Oui | Transport oui ; consolidation seulement quand un éditeur ouvre la page de B |
| Tables avec Références ou mise en forme | Non (table d'export plate) | Oui (le relais filtre) | Non (même transport que A) |
| Secret à gérer | Aucun | Clé d'API ou compte de service | Aucun |
| Hébergement | Aucun | Une fonction serverless (quasi gratuite à ce volume) | Aucun |
| Conditions DINUM | Son propre domaine autorisé | Domaine du relais autorisé (`.gouv.fr` ou démarche RSSI) | Comme A |
| État | Vérifié en local | Vérifié en local | Transport vérifié (comme A) ; consolidation non testée, déduite du code |

**Précision sur C (proposée par Antoine le 14 octobre 2026).** La limite « la clé n'autorise que
l'ajout » ne concerne que le transport. La consolidation de C ne passe pas par la clé : le widget,
ouvert dans la CIBLE par un éditeur avec l'accès complet, lit `Journal` (`grist.docApi.fetchTable`)
et écrit dans la table B avec les droits de cette personne (`grist.docApi.applyUserActions`, déjà
utilisé par FormPlus pour écrire dans d'autres tables). Conditions pour que ce soit fiable :

- la consolidation n'a lieu que si un éditeur ouvre la page qui porte le widget (même replié) ; B
  consultée autrement, ou par un lecteur, reste en retard, comme tout ce qui la lit entre deux
  ouvertures (formules, exports, autres vues) ;
- pour ne pas écraser une retouche faite à la main dans B par une version plus ancienne, B garde
  pour chaque ligne l'identifiant de la dernière ligne de `Journal` appliquée, et seules les
  versions plus récentes sont recopiées ;
- deux éditeurs qui ouvrent la page en même temps ne posent pas de problème si l'écriture se fait
  par clé source (`BulkAddOrUpdateRecord` avec `require`) : appliquer deux fois la même version
  donne le même résultat ;
- `Journal` grossit toujours : le widget peut le purger des versions déjà appliquées, puisqu'il
  écrit avec les droits d'un éditeur.

Écartés : le widget observateur côté SOURCE (section 1) et `REQUEST()` (désactivée par défaut).
Le design B correspond au « relais serveur (transport 3) » déjà classé V3 dans la feuille de
route.

## 6. Rôle de FormPlus : assistant de configuration

Le moteur est Grist lui-même ; ce que FormPlus peut apporter, c'est de rendre le montage faisable
sans connaître les pièges ci-dessus :

- **côté CIBLE** : créer le `Journal` avec les bonnes colonnes, le formulaire dédié (non diffusé)
  et la table miroir avec ses formules ;
- **côté SOURCE** : créer le webhook vers la bonne adresse, avec les colonnes surveillées.
  Vérifié : un widget en accès complet, ouvert par un propriétaire, obtient un jeton par
  `grist.docApi.getAccessToken()` et peut appeler `POST /api/docs/<source>/webhooks?auth=<jeton>`
  depuis `github.io` (réponse 200). Il pourrait aussi contrôler que la table SOURCE est « plate »
  et proposer le chargement initial.

Ce serait une fonctionnalité nouvelle. Elle n'a pas de lien avec la « 3e voie (sync V2) »
évoquée le 18 septembre 2026, qui visait la synchronisation entre un formulaire FormPlus et le
formulaire natif d'un même document.

## 7. À vérifier sur grist.numerique.gouv.fr

Le forum Grist francophone (animateurs, rien d'officiel) indique que les webhooks DINUM sont
filtrés par liste blanche et que les domaines `.gouv.fr` sont autorisés « de facto ». Si c'est
le cas, `grist.numerique.gouv.fr` s'autorise lui-même et les designs A et C fonctionnent tels
quels ; sinon ils sont impossibles là-bas. La procédure de test pas à pas (10 à 15 minutes, avec
les libellés de l'interface en français et la lecture de chaque message d'erreur possible) est
dans [`02-procedure-test-dinum.md`](02-procedure-test-dinum.md). En résumé : un formulaire publié sur
une table `Journal` dans un document CIBLE, un webhook dans un document SOURCE vers
`<début du lien du formulaire>/api/s/<clé>/tables/Journal/records?flat=1`, puis un ajout et une
modification dans la SOURCE.

**Résultat du test réel, 14 octobre 2026 (Antoine, sur grist.numerique.gouv.fr) : ça marche.**

- Étape 2 : un `POST` anonyme `?flat=1` par la clé du formulaire répond `{"records":[{"id":3}]}`,
  donc la version de l'instance accepte le format des webhooks.
- Étape 3 : le webhook vers `grist.numerique.gouv.fr` lui-même est accepté à la création (Statut
  `idle`, pas de « Provided url is forbidden »), donc `ALLOWED_WEBHOOK_DOMAINS` autorise
  l'instance elle-même.
- Étape 4 : le premier envoi a été livré à la CIBLE, qui a répondu `400 Invalid column "C"` (la
  colonne `C` par défaut restait dans la SOURCE) : l'aller-retour DINUM vers DINUM passe le proxy
  sortant. Supprimer `C` côté SOURCE n'a pas suffi, car l'envoi en échec, en tête de file, bloquait
  les suivants (6 en attente) ; après « Effacer la file d'attente », les nouvelles lignes sont
  arrivées dans `Journal`.
- Piège pratique : sous l'invite de commandes Windows, `curl` exige des guillemets échappés
  (`\"`) et pas d'apostrophes (variante ajoutée à l'annexe).

Les designs A et C sont donc réalisables sur DINUM sans serveur. Restent inconnus : la présence de
Redis (persistance de la file), l'activation des comptes de service et de `REQUEST()`, le plafond
de lignes par document.

## 8. État de l'art

- **Grist Labs** : pas de référence entre documents en natif, « pour des raisons techniques »
  (forum, 2022). La demande est suivie dans `grist-core#416`, où des contributeurs (a priori
  liés à l'ANCT/DINUM, non confirmé) annoncent pour 2026 un « premier pas » plutôt que la demande
  complète. Seules réponses officielles : « Copy data from another document » (annoncée en
  septembre 2026) et les Automations (mars 2026), toutes deux payantes
  (plan Business ou édition complète) et absentes de `grist-core`. Aucune n'écrit dans un autre
  document en continu.
- **Communauté** : le schéma courant est webhook, puis un intégrateur (n8n, Zapier, Activepieces),
  puis l'API de la CIBLE. Le nœud Grist de n8n sait faire l'upsert depuis la version 2.37 (août
  2026). Sur DINUM, n8n en SaaS ne peut pas recevoir les webhooks et il n'existe pas de n8n
  interministériel connu (seuls les agents de l'Éducation nationale en ont un).
- **Côté État** : aucun outil public de synchronisation Grist vers Grist trouvé.

Le montage sans serveur (webhook vers une clé de formulaire avec `?flat=1`) n'a été trouvé
documenté nulle part : c'est un vrai différenciateur possible pour FormPlus, à condition que
l'instance DINUM l'autorise.

## Pièces jointes

Elles ne transitent pas par cette chaîne : refusées par la clé de partage dans le corps d'un
webhook (vérifié), et plus généralement une pièce jointe envoyée en anonyme depuis une autre
origine ne peut pas être rattachée à une ligne (limitation de Grist analysée dans FormPlus,
`docs/05-etude-synchro-inter-grist.md`, section « Découverte annexe »). Pour synchroniser des
fichiers, il faudrait un relais authentifié (design B) ou transmettre un lien texte.
