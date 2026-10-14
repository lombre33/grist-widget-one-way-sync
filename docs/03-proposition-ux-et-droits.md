# Proposition : parcours, fonctionnalités et droits d'accès du widget

Document de travail du 14 octobre 2026, à valider avec Antoine avant d'écrire la version
définitive du widget. Il part du design C (`01-etude-faisabilite.md`, section 5) et du test réel
DINUM (`02-procedure-test-dinum.md`). « Vérifié » signale un essai réel sur Grist 1.7.21 en local
(Docker) le 14 octobre ; « à vérifier » ce qui reste déduit.

## 1. Le principe en une phrase

Un seul widget, installé des deux côtés : côté SOURCE il **publie** une table vers un
destinataire, côté CIBLE il **reçoit** et tient à jour une table éditable. Le transport reste le
webhook natif vers la clé d'un formulaire (aucun serveur), le widget ne fait que préparer,
contrôler et consolider.

## 2. Le parcours : une invitation, une réponse

Aujourd'hui il faut recopier des colonnes à la main, construire l'adresse du webhook, la coller
dans les paramètres : c'est là que tout casse (`Invalid column "C"`, file bloquée). Proposition :
deux codes à copier-coller, dans le sens naturel d'une invitation.

| Étape | Qui | Où | Ce que fait le widget |
|---|---|---|---|
| 1. Préparer | Propriétaire SOURCE | Widget SOURCE | Choisit la table, contrôle qu'elle passe (colonnes cachées `gristHelper_*`, pièces jointes, Références), ajoute `id_sync`, `MajLe`, `Supprime` et remplit `id_sync` des lignes existantes. |
| 2. Inviter | Propriétaire SOURCE | Widget SOURCE | Choisit les colonnes et les lignes envoyées à ce destinataire (section 4), puis produit un **code d'invitation** (schéma des colonnes + nom de la synchro). |
| 3. Accepter | Éditeur CIBLE | Widget CIBLE | Colle le code : le widget crée le `Journal` (colonnes exactement alignées, toutes en données) et la table de destination éditable. |
| 4. Ouvrir la porte | Éditeur CIBLE | Grist (4 clics) | Publie un formulaire sur le `Journal` et copie son lien. Seule étape manuelle : la clé de partage est générée par le serveur et illisible par un widget (constat FormPlus). |
| 5. Répondre | Éditeur CIBLE | Widget CIBLE | Colle le lien : le widget construit l'adresse `…/api/s/<clé>/tables/<Journal>/records?flat=1`, la **teste** (envoi d'une ligne vide puis effacement) et produit un **code de réponse** (adresse + fiche du destinataire, section 5). |
| 6. Approuver | Propriétaire SOURCE | Widget SOURCE | Colle la réponse, lit la fiche du destinataire, approuve : le widget crée le webhook (`add` + `update`) et propose le chargement initial. |
| 7. Vivre | Éditeur CIBLE | Page du widget CIBLE | À chaque ouverture, puis toutes les 30 s et à chaque arrivée dans le `Journal`, recopie les dernières versions dans la table éditable. |

## 3. Fonctionnalités proposées

### Côté SOURCE

**Socle**

- Contrôle de la table avant envoi, avec la colonne fautive nommée (« la mise en forme
  conditionnelle de `Statut` ajoute `gristHelper_ConditionalRule` »).
- Ajout des colonnes techniques et remplissage des `id_sync` existants (vérifié : une formule de
  déclenchement `UUID()` ajoutée après coup laisse les lignes existantes vides).
- Création du webhook par le widget (`getAccessToken`, vérifié par l'étude).
- Tableau de bord des destinataires : statut de chaque webhook (`idle`, `retrying`, dernier code
  HTTP, nombre en attente), en clair (« la CIBLE refuse la colonne X »), avec les boutons
  **Effacer la file**, **Suspendre**, **Révoquer**.
- Chargement initial : « toucher » `MajLe` par tranches de 500 en attendant que la file se vide
  entre deux tranches (file plafonnée à 1000).

**Utile ensuite**

- Alerte « schéma changé » : une colonne ajoutée ou renommée côté SOURCE casse l'envoi au
  suivant ; le widget compare au schéma envoyé et prévient avant.
- Suspension automatique proposée quand un webhook est en `retrying` depuis longtemps : un seul
  destinataire en panne bloque les envois de tous les autres du document (file FIFO commune).
- Resynchronisation complète (même geste que le chargement initial) pour rattraper une perte
  (file en mémoire sans Redis).

### Côté CIBLE

**Socle**

- Création du `Journal` et de la table de destination depuis le code d'invitation.
- Test de l'adresse avant de la donner à la SOURCE.
- Consolidation : dernière version par `id_sync` (ordre `MajLe`, puis numéro de ligne), écrite
  par `BulkAddOrUpdateRecord` (vérifié dans `useractions.py` : `require`, `col_values`,
  `options.on_many`). Chaque ligne garde `Sync_JournalId` / `Sync_Ordre` : seule une version
  plus récente l'écrase, une retouche manuelle survit jusqu'à la prochaine modification côté
  SOURCE.
- Suppression logique : `Supprime` vrai retire la ligne de la destination (ou la garde en la
  marquant, au choix).
- Deux onglets ou deux éditeurs en même temps : verrou entre onglets du même navigateur, et
  écritures idempotentes sinon (vérifié : supprimer deux fois la même ligne ne lève pas
  d'erreur).
- Purge du `Journal` : retire les versions remplacées, garde la dernière de chaque ligne.
- Réglages dans une table visible `Synchro_Config` (une ligne par synchro), parce que
  `grist.setOptions` n'est enregistré qu'après un clic sur « Enregistrer ».

**Utile ensuite**

- Bandeau « en retard » pour un lecteur : la consolidation exige un éditeur, le widget le dit au
  lieu de rester muet.
- Proposition de règles d'accès toutes faites : `Journal` visible des seuls propriétaires.
- Colonnes « réservées CIBLE » : colonnes ajoutées à la destination que la synchro ne touche
  jamais (commentaires, suivi local). C'est déjà le cas de fait, à rendre explicite à l'écran.

## 4. Droits d'accès : ce que le propriétaire SOURCE peut contrôler

Rappel de l'étude : le webhook lit les lignes **sans les règles d'accès** et envoie **toutes les
colonnes** de la table surveillée. Ce que voit la CIBLE se décide donc entièrement dans la
SOURCE, au moment de choisir la table surveillée.

### Découverte : une vue d'export par destinataire, sans recopier de données (vérifié)

Une **table de synthèse** de la table SOURCE groupée par `id_sync` crée et retire ses lignes toute
seule, et ses colonnes sont des formules. Testé ce jour :

- un webhook peut surveiller une table de synthèse (accepté à la création) ;
- un recalcul de formule déclenche bien l'envoi : modifier la ligne d'origine envoie la nouvelle
  version de la ligne de synthèse ;
- avec `Visible = $group.Ville[0] == "Lyon"`, `Nom = $group.Nom[0] if $Visible else ""` et
  `Supprime = not $Visible`, une ligne qui **sort du filtre** part une dernière fois avec
  `Supprime: true` et ses données **vidées** : la CIBLE la retire, et la donnée n'a jamais quitté
  la SOURCE.

Le widget SOURCE peut donc générer, pour chaque destinataire, une vue d'export qui ne contient
**que les colonnes cochées** et **que les lignes qui passent un filtre** (formule libre ou
assistant « colonne = valeur »). Avantages : une seule table maîtresse, la mise en forme de la
table maîtresse ne gêne plus (seule la vue exportée doit être « plate »), et retirer une ligne du
périmètre la supprime chez le destinataire.

Limites constatées ou déduites :

- la synthèse envoie aussi `group` et `count` : le `Journal` doit les accepter (le widget les
  crée) et la consolidation les ignore ;
- une suppression **physique** dans la table maîtresse fait disparaître la ligne de synthèse sans
  événement : la suppression logique (`Supprime`) reste nécessaire dans la table maîtresse ;
- toutes les lignes doivent avoir un `id_sync`, sinon elles se regroupent sous la clé vide ;
- une vue d'export par destinataire ajoute une table de synthèse par destinataire au document
  SOURCE.

### Ce qui reste hors de portée

- Une fois envoyée, une donnée est chez la CIBLE : révoquer arrête les envois, pas ce qui est déjà
  copié.
- Qui lit les données dans la CIBLE dépend des règles de la CIBLE, que la SOURCE ne contrôle pas.

## 5. Identifier le destinataire avec les outils de Grist

Rien dans Grist ne permet à la SOURCE de vérifier cryptographiquement qui est derrière une clé de
formulaire : l'adresse dit seulement quelle instance et quelle équipe (`/o/<équipe>`). Trois
niveaux possibles, cumulables :

1. **Fiche du destinataire dans le code de réponse (déclaratif).** Le widget CIBLE y met le nom
   et l'identifiant du document, l'équipe, la date et l'**adresse e-mail de l'éditeur** qui a
   accepté. Cette adresse est calculée par le serveur Grist de la CIBLE, pas saisie : une formule
   de déclenchement `user.Email` dans `Synchro_Config` donne l'e-mail réel de la personne
   connectée (vérifié). Elle reste falsifiable par un propriétaire CIBLE qui modifierait le code
   à la main, d'où les deux niveaux suivants.
2. **Lien de vérification.** La fiche contient l'adresse du document CIBLE. Si le propriétaire
   SOURCE exige d'être invité comme **lecteur** du document CIBLE, il peut l'ouvrir et voir avec
   le bouton natif « Gérer les utilisateurs » qui y a accès, aujourd'hui et plus tard. C'est la
   seule vérification forte que Grist offre sans serveur ; le widget SOURCE peut la rendre
   obligatoire (case « j'ai vérifié l'accès au document CIBLE » avant approbation). À vérifier :
   si le jeton `getAccessToken` du widget CIBLE permet de lire `/api/docs/<doc>/access`, la fiche
   pourrait aussi lister les membres de la CIBLE.
3. **Code d'invitation à usage unique.** Le code d'invitation contient un secret aléatoire,
   recopié dans le code de réponse : la SOURCE sait que la réponse vient de la personne à qui elle
   a remis l'invitation, et pas d'un tiers qui aurait deviné la démarche.

Le widget SOURCE tient un **registre des destinataires** (table visible `Synchro_Destinataires`) :
nom, fiche, colonnes et filtre envoyés, webhook, date d'approbation, statut. C'est la réponse
pratique à « qui reçoit quoi » pour tous les propriétaires de la SOURCE.

## 6. Ce qui est déjà prototypé

Un premier jet du moteur CIBLE existe en local (non publié) : logique pure de consolidation et de
purge, création du `Journal` et de la destination depuis un schéma, test de l'adresse. Il sera
adapté une fois les choix ci-dessus arrêtés.
