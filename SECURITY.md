# Sécurité

Ce document s'adresse à la personne qui audite le widget. Il dit ce qui sort de quel document,
par quel canal, avec quels droits, et ce que le widget refuse de faire.

## Signaler une faille

Ne pas ouvrir de ticket public. Utiliser la VDP de l'État
(https://vdp.numerique.gouv.fr/p/Send-a-report) ou contacter Grist Factory (grist-factory.fr).

## Surface

- Page statique : HTML, CSS et modules JavaScript natifs, sans bibliothèque tierce, sans étape de
  build. Le seul script externe est `grist-plugin-api.js`, servi par l'instance Grist elle-même.
- Politique de sécurité du contenu (`index.html`) : `default-src 'none'`, scripts du widget et des
  instances Grist listées seulement, requêtes réseau vers ces instances seulement, aucun style ni
  script en ligne. La feuille de thème que `grist-plugin-api.js` tente d'insérer en ligne est
  bloquée par cette règle, sans effet sur le widget (il a sa propre charte).
- Aucun texte venu du document ou d'un code collé n'est inséré comme HTML : l'interface est
  construite avec `textContent` (`js/ui.js`, fonction `el`).
- Stockage local du navigateur : la langue et le thème choisis dans les Réglages, et la date de
  la dernière visite par document (pour l'historique « depuis votre dernière visite »), rien
  d'autre.
- Accès demandé à Grist : **complet**, nécessaire pour créer les tables, lire les métadonnées
  (colonnes) et écrire dans la table de destination.

## Où passent les données

Quand SOURCE et CIBLE sont sur la même instance (par exemple `grist.numerique.gouv.fr`), **aucune
donnée ne quitte l'instance** :

- le webhook va du serveur Grist au même serveur Grist (adresse du formulaire de la CIBLE) ;
- le widget lit et écrit par `grist.docApi`, dans le navigateur de l'éditeur, avec ses droits ;
- GitHub Pages (ou l'hébergeur choisi) ne sert que le **code** du widget : il ne reçoit aucune
  donnée, aucun code d'invitation, aucune clé.

Le seul passage hors de Grist est le navigateur des personnes qui ont déjà accès aux documents, et
les deux codes qu'elles s'échangent (noms de tables et de colonnes, adresse d'écriture, fiche).

## Chaîne d'approvisionnement

Le widget a un **accès complet** au document : qui peut modifier son code peut lire et écrire le
document de quiconque l'ouvre. Le risque n'est donc pas le transit des données mais l'origine du
code. Pour un usage en production :

- héberger une **copie figée** du dépôt (version relue, étiquette Git) sur un serveur de
  l'organisation, plutôt que la branche `main` sur GitHub Pages ;
- ajouter cette adresse à la liste des widgets de l'instance, et à `connect-src` / `script-src`
  seulement les instances Grist utilisées (`js/config.js`, `index.html`) ;
- relire le code à chaque mise à jour : il tient en une dizaine de fichiers sans dépendance.

## Requêtes réseau (toutes vers l'instance Grist qui affiche le widget)

| Requête | Quand | Authentification |
|---|---|---|
| `GET <instance>/grist-plugin-api.js` | au démarrage | aucune |
| `GET/POST/PATCH/DELETE <document>/webhooks…` | onglet Envoyer : lister, créer, suspendre, supprimer un webhook, vider la file | jeton d'accès court du document (`getAccessToken`), en paramètre `auth=` ; Grist réserve ces appels aux propriétaires |
| `POST <instance>/api/s/<clé>/tables/<Journal>/records?flat=1` | onglet Recevoir, bouton « Tester le lien » : une ligne vide par journal, effacée au passage suivant | aucune (clé du formulaire) |
| `GET <document SOURCE>` | onglet Envoyer, à chaque affichage : le document est-il lisible par lien public ? | aucune (requête anonyme) |
| `GET <document SOURCE>/tables/<vue d'export ou Synchro_<table>>/records` | onglet Recevoir, mode lien public seulement, toutes les 10 s page ouverte | aucune (requête anonyme) |

Les écritures REST portent l'en-tête `X-Requested-With`, exigé par Grist contre les requêtes
forgées.

Tout le reste passe par l'API des widgets (`grist.docApi`, messages entre le cadre et Grist), avec
les droits de la personne connectée.

## Flux de données

- **SOURCE vers CIBLE** : par les webhooks natifs de Grist, côté serveur, jamais par le
  navigateur. Un webhook envoie toutes les colonnes de la table qu'il surveille, sans appliquer
  les règles d'accès (comportement de Grist) : c'est pourquoi il surveille la **vue d'export**
  (table de résumé par `id_sync`), qui ne contient que `id_sync`, `MajLe`, `Supprime`, `group`
  (numéros des lignes d'origine, imposé par Grist) et `Synchro_Donnees`, les **colonnes cochées**
  en un bloc JSON calculé par une formule. Les autres colonnes ne sortent pas. Le second webhook
  de chaque table envoie `Synchro_<table>` : la liste des `id_sync` existants, l'e-mail de la
  personne qui a préparé la table et la description des colonnes envoyées.
- **Mode lien public** : le document SOURCE est partagé en lecture « toute personne ayant le
  lien », par son propriétaire, dans Grist. Le widget pose d'abord des règles d'accès, marquées
  du mémo « Synchro : lecture limitée aux vues d'export » et placées avant les autres : pour
  `user.Access == VIEWER`, lecture refusée sur tout le document, sauf les vues d'export et les
  tables `Synchro_<table>` partagées. Conséquences : tout lecteur (pas seulement le lien public)
  ne voit plus que ces tables ; les données exportées sont publiques. Révoquer retire les
  autorisations ; le refus général reste tant que le document est public (le widget le vérifie
  par une requête anonyme). Vérifié par le test d'intégration : sans identifiant, la table
  d'origine et les autres tables répondent 403, la vue d'export 200.
- **Contrôles faits avant de créer un webhook** (`parseReply`, `js/core.js`) : l'adresse doit être
  sur la **même instance** que la SOURCE, de la forme exacte
  `/api/s/<clé>/tables/<table>/records?flat=1` (écriture par clé de formulaire, rien d'autre),
  sans identifiant dans l'adresse ; le code de réponse doit porter le secret d'une invitation en
  attente de ce document.
- **Invitation et réponse** : l'invitation contient un identifiant, le nom des tables et de leurs
  colonnes envoyées (en mode lien public, l'adresse REST du document SOURCE, réécrite et contrôlée
  à la lecture : même instance que la CIBLE), et, si la case est cochée, un secret aléatoire de 128 bits. La SOURCE ne garde que
  l'empreinte SHA-256 du secret, dans la description de la colonne `Synchro_Ids` de chaque table
  envoyée (métadonnée lisible par les personnes qui voient le document) ; la CIBLE garde le secret
  dans la description de la même colonne de son journal jusqu'à la réponse. La réponse contient
  les adresses d'écriture et la fiche du destinataire : e-mail de la personne qui a collé le lien
  (calculé par le serveur Grist de la CIBLE, formule `user.Email`), identifiant du document,
  équipe, date. Cette fiche est **déclarative** : un propriétaire de la CIBLE pourrait la modifier.
  Le secret garantit seulement que la réponse vient de quelqu'un qui a reçu l'invitation ; sans
  secret, l'approbation repose sur la seule fiche, et le widget le signale.
- **Rien d'autre n'est stocké** : pas de table de réglages. Les destinataires branchés sont les
  webhooks eux-mêmes (le mémo garde la fiche), visibles par les propriétaires dans les paramètres
  du document.

## La clé du formulaire de réception

- Elle donne le droit d'**ajouter** des lignes au journal de la CIBLE, et rien d'autre (ni lecture,
  ni modification, ni suppression : règles de Grist pour les formulaires). Elle ne doit pas être
  diffusée.
- Elle est lisible en clair par les propriétaires de la SOURCE (réglages du webhook). Le widget ne
  l'écrit dans aucune table et la masque à l'écran (`…/api/s/Ab12…/…`).
- Quiconque la connaît peut injecter de fausses versions dans le journal : la consolidation les
  appliquerait. Elle peut aussi écrire les colonnes techniques du journal (`Sync_Applique`,
  `Synchro_Ids`), ce qui ne lui donne pas plus de pouvoir : la consolidation n'écrit jamais que
  dans la table de destination, par clé `id_sync`. Pour la changer : dépublier puis republier le formulaire, et refaire l'échange de
  codes.
- Révoquer côté SOURCE supprime les webhooks : les envois s'arrêtent, les données déjà reçues
  restent dans la CIBLE. Arrêter la réception côté CIBLE efface les journaux, donc les
  formulaires : la clé n'écrit plus nulle part.

## Ce que le widget ne fait pas

- Aucune requête vers un service tiers, aucune télémétrie, aucune donnée hors de Grist.
- Aucune clé d'API personnelle : seuls le jeton court du document et la clé du formulaire servent.
- Aucune lecture du document CIBLE depuis la SOURCE. La CIBLE ne lit la SOURCE qu'en mode lien
  public, sans identifiant, et seulement ce que les règles d'accès laissent voir.
