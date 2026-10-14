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
- Stockage local du navigateur : la langue et le thème choisis dans les Réglages, rien d'autre.
- Accès demandé à Grist : **complet**, nécessaire pour créer les tables, lire les métadonnées
  (colonnes) et écrire dans la table de destination.

## Requêtes réseau (toutes vers l'instance Grist qui affiche le widget)

| Requête | Quand | Authentification |
|---|---|---|
| `GET <instance>/grist-plugin-api.js` | au démarrage | aucune |
| `GET/POST/PATCH/DELETE <document>/webhooks…` | onglet Envoyer : lister, créer, suspendre, supprimer un webhook, vider la file | jeton d'accès court du document (`getAccessToken`), en paramètre `auth=` ; Grist réserve ces appels aux propriétaires |
| `POST <instance>/api/s/<clé>/tables/<Journal>/records?flat=1` | onglet Recevoir, bouton « Tester le lien » : une ligne vide par journal, effacée au passage suivant | aucune (clé du formulaire) |

Tout le reste passe par l'API des widgets (`grist.docApi`, messages entre le cadre et Grist), avec
les droits de la personne connectée.

## Flux de données

- **SOURCE vers CIBLE** : par les webhooks natifs de Grist, côté serveur, jamais par le
  navigateur. Ils envoient **toutes les colonnes** de la table surveillée, **sans appliquer les
  règles d'accès** de la SOURCE (comportement de Grist). Il faut donc envoyer une table qui ne
  contient que ce que la CIBLE a le droit de voir. Le second webhook de chaque table envoie la
  table `Synchro_<table>` : la liste des `id_sync` existants, rien d'autre.
- **Contrôles faits avant de créer un webhook** (`parseReply`, `js/core.js`) : l'adresse doit être
  sur la **même instance** que la SOURCE, de la forme exacte
  `/api/s/<clé>/tables/<table>/records?flat=1` (écriture par clé de formulaire, rien d'autre),
  sans identifiant dans l'adresse ; le code de réponse doit porter le secret d'une invitation en
  attente de ce document.
- **Invitation et réponse** : l'invitation contient un identifiant, le nom des tables et de leurs
  colonnes, et, si la case est cochée, un secret aléatoire de 128 bits. La SOURCE ne garde que
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
- Révoquer côté SOURCE supprime le webhook : les envois s'arrêtent, les données déjà reçues
  restent dans la CIBLE.

## Ce que le widget ne fait pas

- Aucune requête vers un service tiers, aucune télémétrie, aucune donnée hors de Grist.
- Aucune clé d'API personnelle : seuls le jeton court du document et la clé du formulaire servent.
- Aucune lecture du document CIBLE depuis la SOURCE, ni l'inverse.
