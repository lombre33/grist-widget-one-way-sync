# Sécurité

Ce document s'adresse à la personne qui audite le widget. Il dit ce qui sort de quel document,
par quel canal, avec quels droits, ce que le widget refuse de faire, et les risques acceptés.
Les affirmations marquées « vérifié » ont été essayées dans un vrai Grist (test d'intégration,
`tests/e2e/run.mjs`, ou essai dédié).

## Signaler une faille

Ne pas ouvrir de ticket public. Utiliser la VDP de l'État
(https://vdp.numerique.gouv.fr/p/Send-a-report) ou contacter Grist Factory (grist-factory.fr).

## En bref

- Aucun serveur, aucune dépendance, aucune donnée hors de l'instance Grist : le transport est le
  webhook natif de Grist, d'un document à l'autre de la même instance.
- Une seule table technique dans la SOURCE (`Synchro`), qui ne porte que les colonnes cochées des
  exports. Un webhook par destinataire, filtré sur son export.
- Chaque réception a sa propre clé d'écriture (un formulaire publié sur sa propre page), qui ne
  peut qu'ajouter des lignes à son journal. La CIBLE contrôle ce qui y arrive avant de recopier.
- Les codes échangés sont des **identifiants** : ils se transmettent comme un mot de passe. Une
  invitation vaut 7 jours et porte toujours un secret.
- Le document qui recevra est lu **chez Grist** (nom, dossier, équipe) à l'approbation, puis
  revérifié toutes les heures ; un code de contrôle court se compare de vive voix.
- Les envois sont **signés** (HMAC-SHA256, une clé par destinataire, tirée d'un échange de clés
  publiques : aucune clé secrète ne voyage dans les codes), et ce que la CIBLE en déplie est
  **scellé** avec la même clé : la clé d'écriture d'une réception ne suffit plus pour y faire
  recopier des données, et un destinataire ne peut pas signer pour un autre.
- Règles d'accès posées par le widget : `Synchro` réservée aux propriétaires de la SOURCE, journaux
  de la CIBLE réservés à ses éditeurs (case cochée par défaut).
- Niveau **Renforcé**, au choix à l'invitation : code de contrôle à comparer obligatoirement,
  toute suppression reçue à valider, pas de lien public.

## Surface

- Page statique : HTML, CSS et modules JavaScript natifs, sans bibliothèque tierce, sans étape de
  build. Le seul script externe est `grist-plugin-api.js`, chargé depuis l'instance qui affiche le
  widget si elle est dans la liste de `js/config.js`, sinon depuis la première de la liste.
- Politique de sécurité du contenu (`index.html`) : `default-src 'none'` ; scripts du widget et
  `grist-plugin-api.js` des instances listées, rien d'autre de ces instances ; requêtes réseau vers le widget lui-même (textes `i18n/*.json`) et ces
  instances ; styles et images du widget seulement ; aucun script ni style en ligne ;
  `base-uri` et `form-action` à `'none'` ; pas de référent envoyé.
- Toute requête réseau passe par `gristFetch` (`js/grist.js`), qui refuse une adresse hors des
  instances listées et n'envoie jamais de cookie (`credentials: 'omit'`). Les envois directs à une
  adresse d'écriture (test du lien, ligne « fin », morceaux de fichiers) ne partent que vers
  l'instance du document, comme le webhook.
- Aucun texte venu d'un document ou d'un code collé n'est inséré comme HTML : l'interface est
  construite avec des nœuds texte (`js/ui.js`, fonction `el`). Aucun `innerHTML`, `eval` ou
  `Function`. Les classes CSS ne viennent que du code (l'état d'une ligne d'historique est l'un de
  trois mots connus).
- Stockage local du navigateur : langue, thème, date de la dernière visite par document CIBLE
  (historique), identifiant tiré au hasard pour ce navigateur (renvois). Aucune donnée du document.
- Accès demandé à Grist : **complet**. Le widget crée des tables et des colonnes, lit les
  métadonnées, écrit dans les tables de destination et gère les webhooks (propriétaires).

## Requêtes réseau

Toutes vont vers l'instance Grist qui affiche le widget (ou une autre instance de la liste, jamais
ailleurs).

| Requête | Quand | Authentification |
|---|---|---|
| `GET <instance>/grist-plugin-api.js` | au démarrage | aucune |
| `GET/POST/PATCH/DELETE <document>/webhooks…` | onglet Envoyer et Échange : lister, créer, renommer, suspendre, supprimer un webhook, vider la file ; page ouverte par un propriétaire, toutes les 10 s (60 s onglet caché) : état des envois | jeton court du document (`getAccessToken`) en paramètre `auth=` ; Grist réserve ces appels aux propriétaires |
| `GET <document>/sql?q=select …` | lectures légères répétées (colonnes de `Synchro`, ligne de test d'un journal) | jeton court aux droits de la personne (un jeton en lecture seule y est refusé dès que le document a des règles d'accès, vérifié) ; Grist le réserve à qui peut lire tout le document, sinon le widget lit la table entière |
| `GET <document>/compare?left=<état>&right=HEAD&maxRows=1` | onglet Recevoir, toutes les 10 s page ouverte : quelles tables ont changé depuis le coup d'œil précédent (seuls leurs noms servent ; Grist renvoie aussi au plus une valeur par colonne changée, que le widget ignore) | jeton court aux droits de la personne, comme `/sql` ; Grist le réserve à qui peut lire tout le document, sinon le widget relit comme avant |
| `POST <instance>/api/s/<clé>/tables/<journal>/records?flat=1` | bouton « Tester le lien » : une ligne marquée d'un nombre au hasard ; SOURCE, page ouverte par un propriétaire : morceaux des pièces jointes (adresse lue dans le webhook du destinataire), ligne « fin » | aucune (clé du formulaire) |
| `GET <document SOURCE>/attachments/<n°>/download` | SOURCE, page ouverte par un propriétaire : contenu d'un fichier d'une colonne Pièces jointes cochée, à envoyer | jeton court en lecture seule |
| `POST <document CIBLE>/attachments` | CIBLE, page ouverte par un éditeur : dépôt d'un fichier reçu en entier et vérifié | jeton court du document |
| `GET <instance>[/o/<équipe>]/api/s/<clé>` | SOURCE : vérification d'une réponse, puis de chaque destinataire au plus une fois par heure, page ouverte par un propriétaire ; CIBLE : lecture d'une invitation d'Échange | aucune (requête anonyme) ; Grist rend le nom, l'identifiant, le dossier et l'équipe du document de la clé |
| `GET <document SOURCE>` | onglet Envoyer : le document est-il lisible par lien public, et avec quel rôle ? | aucune (requête anonyme) |
| `GET <document SOURCE>/tables/Synchro/records?filter=…` | CIBLE en mode lien public, page ouverte : les lignes `empreinte`, puis `complet` si elles ont changé | aucune (requête anonyme) |

Les écritures REST portent l'en-tête `X-Requested-With`, exigé par Grist contre les requêtes
forgées. Le reste passe par l'API des widgets (`grist.docApi`), avec les droits de la personne.

## Flux de données

- **SOURCE vers CIBLE** : par les webhooks natifs de Grist, côté serveur, même page fermée. Un
  webhook envoie toutes les colonnes de la table qu'il surveille, sans appliquer les règles
  d'accès (comportement de Grist) : c'est pourquoi il surveille la table technique `Synchro`, où
  une formule calcule, dans `Synchro_Lot`, les **colonnes cochées** de l'export en un bloc JSON.
  Les autres colonnes ne sortent pas. Par table d'un export, `Synchro` a une ligne `cles` (seaux
  d'empreintes des clés `id_sync`, pour les suppressions), une ligne `lot` (lignes modifiées depuis
  5 secondes, ou demandées en renvoi), et pour un export public une ligne `complet` et sa ligne
  `empreinte`.
- **Isolation entre exports** : chaque webhook a une **condition** Grist (1.7.11 et plus),
  `rec.Synchro_Export == "<export>" and rec.Synchro_Type in ("cles", "lot")`. Le widget n'écrit
  cette condition que pour un identifiant de 16 chiffres hexadécimaux, relit celle que Grist a
  enregistrée et supprime le webhook si elle manque ou diffère (instance trop ancienne), et signale
  « Webhook sans filtre » tout webhook sur `Synchro` dont la condition n'a pas exactement cette
  forme. Vérifié : un webhook ne reçoit pas les lignes d'un autre export, et un destinataire
  révoqué ne reçoit plus rien alors qu'un autre continue.
- **Échange** (synchro dans les deux sens, deux documents qui ont chacun le widget) : chaque côté
  envoie par son propre webhook vers le journal de l'autre. Les deux côtés doivent être tenus par
  un propriétaire (création de webhook). Chaque document n'écrit, dans ses tables, que les
  colonnes qu'il envoie lui-même pour ces tables : une colonne de plus annoncée par l'autre côté,
  ou renommée vers une autre colonne, est ignorée. L'adresse de retour (clé d'écriture du journal
  du document qui invite) voyage dans le code d'invitation et n'est notée nulle part ailleurs que
  dans le webhook de l'autre côté. Les règles du document qui administre (accepter, refuser, à
  valider) sont notées dans sa note d'exports, jamais dans un journal : un participant ne peut pas
  faire passer un changement pour accepté. Un changement à valider n'est écrit qu'au clic sur
  **Accepter** ; une ligne de journal forgée marquée « refusée » ne change que l'affichage. Une
  invitation d'Échange qui reprend l'identifiant d'un export de ce document est refusée (elle
  remplacerait cet export et couperait ses destinataires).
- **Pièces jointes** : une colonne Pièces jointes ne part que cochée. Le lot ne porte que la liste
  de ses fichiers (empreinte, nom, taille). Le contenu ne passe pas par le webhook : le widget
  SOURCE, page ouverte par un propriétaire, télécharge chaque fichier cité par une ligne de
  l'export (filtre compris) avec son jeton, et le poste à l'adresse du webhook de chaque
  destinataire (la clé de son formulaire), en morceaux. La CIBLE ne dépose un fichier qu'arrivé en
  entier, de la taille annoncée et dont le SHA-1 est l'empreinte annoncée (25 Mo au plus, 50
  morceaux, nom sans chemin ni caractère de contrôle) ; un morceau illisible ou un fichier altéré
  est effacé et compté parmi les « Arrivées suspectes ». Les morceaux ne sont pas signés, les
  versions si : un fichier n'est déposé que si une version reçue le cite (ou une cellule qui
  l'attend encore) ; sinon il attend la sienne un jour au plus, puis est effacé (vérifié). Les
  morceaux en attente (envois en cours, fichiers non cités) sont bornés à 50 Mo par journal : au-delà,
  les plus anciens sont effacés, et un envoi incomplet en trop compte parmi les « Arrivées
  suspectes ». Le nom d'un fichier perd aussi ses caractères invisibles et de sens d'écriture
  (« facture\u202Efdp.exe »). Les fichiers ne vont jamais de la CIBLE vers la SOURCE, ni par lien
  public.
- **`Synchro` réservée aux propriétaires** : ses formules lisent les tables sans les règles
  d'accès, et elle porte les clés de signature des destinataires. À l'ouverture de l'onglet Envoyer par un
  propriétaire, le widget pose des règles de mémo « Synchro : réservée aux propriétaires », avant
  les autres : un lecteur ne la voit pas, un éditeur ne voit ni ne modifie ses lignes. Seule
  exception, pour la recopie d'un Échange par un éditeur : les lignes `echange` et `lot` des
  exports en Échange, sans leur contenu, et leur colonne `Synchro_Renvoi`. Un éditeur ne voit donc
  plus les cartes des exports. **Limite** : par défaut, Grist laisse les éditeurs modifier la
  structure du document, donc les formules de `Synchro` (ce qui part) et la description de ses
  colonnes ; une règle d'accès n'y peut rien. Il faut décocher « Permettre aux éditeurs de modifier
  la structure » ; en Renforcé, la carte de l'export le demande tant que ce n'est pas fait. Changer
  une règle recharge le document (une fois) ; le widget ne le fait jamais pendant un assistant
  ouvert, et ne touche jamais aux règles des autres (vérifié : l'ordre est gardé, rien n'est
  reposé au chargement suivant).
- **Mode lien public** : la SOURCE est partagée en lecture « toute personne ayant le lien », par
  son propriétaire. Le widget pose d'abord des règles d'accès, de mémo « Synchro : lecture limitée
  aux exports publics », placées avant les autres, pour `user.Access == VIEWER` : lecture refusée
  sur tout le document sauf, dans `Synchro`, les lignes `complet` et `empreinte` des exports
  publics, et sans la colonne `Synchro_Export`, dont la description porte la note de la SOURCE
  (sinon lisible par tous, vérifié). Conséquences : tout lecteur du document (pas seulement le lien
  public) ne voit plus que ces lignes, et les données des exports publics sont publiques. Les noms
  des tables des exports restent lisibles dans les formules de `Synchro`. Vérifié : sans
  identifiant, les tables d'origine répondent 403, la note n'est pas lisible, et `Synchro` ne
  montre que les lignes de l'export public. L'assistant liste en rouge les colonnes rendues
  publiques, refuse une table dont une règle d'accès (d'autrui) cache des lignes ou des colonnes
  (les formules de `Synchro` liraient sans elle) ; une règle sur toutes les tables compte, comme
  celle d'une table dont une colonne Référence de l'export affiche le texte. Ce contrôle est refait
  à chaque modification d'un export public (refusée s'il échoue) et à chaque affichage de sa carte
  (une règle posée depuis y est signalée). La carte alerte aussi si le lien public donne plus que
  la lecture. Un export Renforcé n'a pas de lien public.

## Codes d'invitation et de réponse

Ils sont faits pour être copiés dans un courriel : ce sont des **identifiants**, à transmettre à
la seule personne concernée. Sous chaque code, le widget le rappelle : ne le coller ni dans une
IA, ni dans un ticket, ni dans un salon de discussion.

- **Invitation** : identifiants de l'invitation et de l'export, nom de l'export, instance,
  e-mail de la personne qui l'a créée et identifiant du document SOURCE (affichés à la CIBLE avant
  d'accepter, et utiles pour refuser une boucle), tables et colonnes envoyées, un secret aléatoire
  de 128 bits, la date d'expiration, le niveau (Renforcé ou non) et la **clé publique** d'une paire
  tirée pour cette invitation (ECDH P-256). En mode lien public : l'adresse REST du document, réécrite et contrôlée
  (même instance que la CIBLE). En Échange : l'adresse d'écriture du journal de retour, c'est-à-dire
  **une clé d'écriture**.
- **Réponse** : adresse d'écriture du journal de la CIBLE (**une clé d'écriture**), fiche du
  destinataire (e-mail calculé par le serveur Grist de la CIBLE, `user.Email`, identifiant du
  document, équipe, date), le secret, la clé publique d'une paire tirée par la CIBLE, et en
  Échange les tables de retour.
- **Aucune clé secrète dans les codes** : de sa clé privée et de la clé publique de l'autre côté,
  chacun tire le même secret (ECDH P-256), puis deux clés de 128 bits propres à cette invitation
  (HKDF-SHA256 sur l'export et l'invitation) : l'une signe les envois de la SOURCE vers ce
  destinataire, l'autre l'envoi de retour d'un Échange. Qui lit les deux codes (un fil de
  courriel) n'en tire rien (vérifié). La clé privée de la SOURCE reste dans la note de `Synchro`
  jusqu'à l'approbation ; celle de la CIBLE n'est gardée nulle part. Un code d'avant la 0.10
  (clé de signature de l'export en clair) est refusé : l'invitation est à refaire.
- La SOURCE ne garde que l'empreinte SHA-256 du secret ; la CIBLE garde le secret dans la note de
  son journal, utile seulement tant que l'invitation est en attente. Le secret est obligatoire
  depuis la 0.8 ; une invitation en attente créée avant, sans secret, est encore acceptée une fois.
- **Expiration** : une invitation vaut 7 jours (date dans le code et sur la carte). Expirée, la
  CIBLE la refuse et la SOURCE refuse sa réponse ; « Refaire le code » en produit une nouvelle,
  avec un nouveau secret.
- **Document vérifié par Grist** : l'e-mail de la fiche est déclaratif (il voyage dans le code
  collé). Le document, son dossier et son équipe, eux, sont lus chez Grist à partir de la clé de
  la réponse (`GET /api/s/<clé>`, anonyme, vérifié) et comparés à l'identifiant de la fiche : refus
  s'ils diffèrent, avertissement pour un espace personnel (n'importe qui peut en créer un). La
  CIBLE fait de même pour l'adresse de retour d'un Échange. La SOURCE revérifie chaque webhook au
  plus une fois par heure, page ouverte : un co-propriétaire peut en changer l'adresse dans les
  réglages de Grist ; la carte signale un autre document que celui de la fiche, et une adresse qui
  n'est plus celle d'un formulaire de cette instance. Ce contrôle protège de l'erreur, pas d'un
  co-propriétaire décidé, qui peut aussi réécrire la fiche (le mémo du webhook).
- **Code de contrôle** : 6 caractères tirés de SHA-256(clé de partage, secret, niveau, clés
  publiques de l'invitation et de la réponse), montrés des deux côtés (sans 0, 1, I, L, O). La clé
  de partage est tirée par Grist : le reste de l'adresse (le préfixe d'équipe, que Grist ne
  contrôle pas pour une clé de partage) n'entre pas dans le calcul, sinon un intermédiaire
  pourrait le faire varier jusqu'à retomber sur le même code. Ils ne coïncident que si la réponse
  vient de qui a reçu l'invitation, désigne ce formulaire, et si personne n'a remplacé une clé
  publique ni retiré la sécurité renforcée en route (vérifié par les tests) : à comparer par
  téléphone, ce qui ferme le cas d'un attaquant dans la même équipe ou placé entre les deux. Conseillé en Standard ; en Renforcé, une case « J'ai comparé » est exigée avant
  d'approuver (et, en Échange, côté CIBLE avant de répondre).
- Contrôles à la lecture (`js/logic/codes.js`) : préfixe et version, identifiants, secret,
  colonnes (noms Grist, types connus, 400 au plus), textes coupés à 200 caractères, adresses de la
  forme exacte `/api/s/<clé>/tables/<table>/records?flat=1` sur la **même instance**, sans
  identifiant dans l'adresse, réécrites avant usage. La réponse doit porter le secret d'une
  invitation en attente de ce document.
- Une nouvelle invitation pour un export déjà reçu (lien coupé, destinataire révoqué) ne reprend
  la réception qu'après confirmation, fiche affichée, et seulement si elle vient du même document
  dans le même mode.

## La clé du formulaire de réception

- **Une clé par réception** : Grist donne une clé par page partagée, et cette clé lit aussi les
  colonnes des tables de tous les formulaires de la page, descriptions comprises (vérifié). Chaque
  journal a donc son formulaire sur sa propre page, à la racine de la liste des pages. Les formulaires
  publiés par une version d'avant la 0.5 sur une même page sont signalés (« Lien commun à
  d'autres formulaires ») avec un bouton qui les sépare.
- **Ce qu'elle permet** (vérifié) : ajouter des lignes au journal de sa réception ; lire les
  colonnes de ce journal et leurs descriptions (donc la note de la réception, dont le secret), et
  le nom et l'identifiant du document. Elle ne lit aucune ligne, ne modifie ni ne supprime rien,
  et n'atteint pas le journal d'une autre page (403 en écriture, 404 en lecture).
- **Qui la connaît** : la personne qui l'a copiée, les propriétaires de la SOURCE (réglages du
  webhook), et, en Échange, quiconque a vu le code d'invitation. Le widget ne l'écrit dans aucune
  table ni note, et la masque partout à l'écran, messages d'erreur de Grist compris
  (`…/api/s/Ab12…/…`).
- **Signatures** : chaque destinataire a sa clé de signature (tirée des clés publiques des deux
  codes, voir plus haut). Côté SOURCE, elle est dans la ligne `signature` de `Synchro` (réservée
  aux propriétaires), rangée sous l'identifiant du webhook ; la CIBLE la garde dans la
  description de la colonne `id_sync` de ses destinations, **pas** dans la note du journal, que
  la clé du formulaire lit. Les formules de `Synchro` signent chaque liste de clés et chaque lot
  pour chaque destinataire de l'export (HMAC-SHA256 de l'empreinte de l'export, de la table, du
  type, des colonnes et du contenu, rangé sous l'empreinte de sa clé) ; le widget signe la ligne
  « fin » pour le seul destinataire concerné. La CIBLE efface sans effet, et compte parmi les
  « Arrivées suspectes », toute ligne sans signature valide pour sa clé (vérifié, y compris un lot
  signé avec la clé d'un autre destinataire du même export) ; une liste de clés vide non signée
  n'est lue que comme vide, sans les colonnes qu'elle annonce. Révoquer un destinataire efface sa
  clé : plus rien n'est signé pour lui (vérifié). Une réception branchée avant la 0.8 ne connaît
  pas de clé : elle accepte les envois non signés jusqu'à une nouvelle invitation, et sa carte le
  dit ; une réception de la 0.8 ou de la 0.9 garde la clé commune de son export (la SOURCE la
  garde tant qu'un de ses webhooks n'a pas la sienne) jusqu'à une nouvelle invitation. Qui a la
  clé du formulaire **et** la clé de signature de cette réception (un lecteur de la CIBLE peut
  lire cette dernière) peut encore forger pour elle seule : couper le lien y met fin. En Échange,
  chaque côté signe son envoi de retour avec la clé de retour, tirée de même (vérifié : un lot
  signé avec une clé tirée de l'invitation seule est rejeté par le document qui invite).
- **Sceau des lignes dépliées** : la clé du formulaire peut créer une ligne avec n'importe quelles
  colonnes, donc une ligne qui ressemble à une version déjà dépliée, qui n'aurait jamais été
  contrôlée. La CIBLE scelle donc chaque version et chaque liste qu'elle déplie (colonne
  `Sync_Sceau` du journal : HMAC-SHA256, avec la clé de signature de la réception, de l'export, de la
  table, de la clé, de l'horodatage, de `Supprime` et du contenu). Une ligne dépliée au sceau
  faux ou absent est effacée sans effet et comptée parmi les « Arrivées suspectes » (vérifié). L'empreinte de la clé est notée dans la note du journal : à la première
  fois, ou quand une nouvelle invitation change la clé, les lignes dépliées déjà là sont scellées ;
  ensuite, une clé introuvable (destination effacée, description vidée) arrête la recopie de ce
  journal au lieu de tout accepter. Une reprise (nouvelle invitation pour la même réception) tire
  toujours une nouvelle clé : elle se confirme, fiche de la SOURCE affichée.
- **Dates du futur** : une version ou une liste datée de plus de 10 minutes après l'heure de la
  CIBLE est rejetée (même instance, même horloge) : elle l'emporterait sur toutes les vraies.
- **Vague de suppressions** : quand un passage effacerait plus de 10 lignes et plus de 20 % des
  lignes reçues d'une table, rien n'est effacé ; la carte demande « Appliquer » ou « Ignorer »
  (les lignes restent ici, détachées de la SOURCE). En Renforcé, toute suppression reçue attend
  cette décision. Pas en Échange, où les suppressions passent par la case `Supprime`.
- **Ce que la CIBLE accepte** : l'expéditeur fait foi pour le contenu de son export (versions,
  suppressions, colonnes ajoutées à l'export, tables proposées). Une table nouvelle n'est jamais
  rangée sans l'accord d'un éditeur ; une colonne nouvelle prend un nom libre dans la destination,
  jamais celui d'une colonne existante. Une ligne qui ne peut pas venir du webhook de cet export
  (autre export, type inconnu, contenu illisible, nom de table invalide) est effacée sans effet et
  comptée ; une arrivée anormale est signalée (« Arrivées suspectes ») avec un bouton pour couper
  le lien. Aucun nom reçu ne peut viser une propriété des objets JavaScript (`__proto__`…), et les
  volumes sont bornés (100 000 lignes par lot, 1 000 clés trop grosses et 200 tables suivies par
  journal, 500 lignes reçues par passage). Une date d'arrivée hors bornes ne peut pas casser
  l'affichage, et une carte qui ne se dessine pas laisse les autres, et ses boutons « Couper le
  lien » et « Arrêter », à leur place.
- **Fin d'un envoi** : quand la SOURCE révoque un destinataire, supprime l'export ou arrête un
  Échange, son widget envoie d'abord une ligne « fin » à l'adresse du webhook, puis l'efface ; la
  carte de la CIBLE affiche « Coupé par la SOURCE ». Cette ligne est signée ; pour une réception
  sans clé de signature (branchée avant la 0.8), qui a la clé du formulaire peut la forger : la
  carte le dirait à tort, jusqu'aux données suivantes, qui effacent l'avis. Rien n'est supprimé.
- **Historique et valeurs retouchées** : la colonne `Sync_Avant` du journal garde, pour
  l'historique, les valeurs qu'une recopie a remplacées dans la destination (colonnes modifiées
  seulement) et le numéro d'une ligne supprimée. Ces valeurs restent dans le document, visibles de
  qui lit le journal comme les versions reçues ; la clé du formulaire ne lit pas les lignes, et la
  purge efface les versions remplacées. Qui a la clé peut écrire cette colonne : l'historique
  montrerait un « avant » faux, comme le ferait une version forgée ; rien n'est recopié depuis
  elle. Les retouches faites à la main se calculent à l'affichage ; seules deux marques s'écrivent :
  une colonne reçue effacée ici, dans la note du journal (que la clé ne peut pas écrire), et l'état
  `partie` d'une version dont la ligne a quitté la SOURCE alors qu'elle n'était plus ici. Qui a la
  clé peut écrire cet état sur une version : la carte tairait alors une ligne effacée ici, rien de
  plus ; « Corriger » ne recopie que les dernières versions reçues, comme la recopie normale.
- **Échange rangé dans une table existante** : avant de brancher le retour, la CIBLE confirme la
  liste des colonnes de cette table qui partiront vers le document qui invite (nommé tel que Grist
  le donne).
- **Rattachement** : si la CIBLE a choisi une colonne commune pour une table existante, une ligne
  locale sans clé dont la valeur est égale à celle d'une ligne reçue est rattachée à celle-ci
  (puis tenue à jour par la SOURCE).
- **Test du lien** : une ligne marquée d'un nombre tiré au hasard part par la clé et doit arriver
  dans le journal de cette réception ; le lien d'un autre formulaire ou d'un autre document est
  refusé (vérifié), car la réponse y enverrait les données.
- **Couper le lien** : la page du formulaire change de clé (l'ancienne n'écrit plus, vérifié), ou
  le formulaire quitte une page commune ; la SOURCE révoque puis réinvite, et la même réception
  reprend. **Arrêter la réception** efface le journal, son formulaire et sa page, donc la clé.

## Qui peut quoi

- SOURCE : seul un **propriétaire** crée, suspend ou supprime un webhook, donc branche ou révoque
  un destinataire, et lui seul voit et modifie les lignes de `Synchro` (règles posées par le
  widget, voir plus haut). Un éditeur voit « réservé aux propriétaires » à la place des cartes ; il
  ne peut élargir ce que reçoivent les destinataires branchés que si Grist lui laisse modifier la
  structure (réglage par défaut, voir plus haut).
- CIBLE : un **éditeur** accepte une invitation, range les tables et recopie. Les journaux sont
  réservés aux éditeurs (règle de mémo « Synchro : journaux réservés aux éditeurs », case cochée par
  défaut à l'acceptation) : ils gardent les versions reçues et ce qu'elles ont remplacé, quelles
  que soient les règles des tables de destination. Un lecteur ne voit donc pas les réceptions,
  seulement les boutons grisés. Seul un propriétaire peut poser cette règle : une réception
  acceptée par un éditeur le dit sur sa carte jusqu'à ce qu'un propriétaire ouvre la page. Un
  Échange demande un propriétaire.

## Ce que le widget écrit et garde

- Pas de table de réglages. Les destinataires branchés sont les webhooks eux-mêmes (le mémo garde
  la fiche), visibles par les propriétaires dans les paramètres du document.
- SOURCE : `id_sync` et `MajLe` dans chaque table envoyée (et la case `Supprime` en Échange), la
  table `Synchro` (dont une ligne `signature` par export, qui garde la clé de chaque
  destinataire), une note (exports, invitations en attente avec l'empreinte de leur secret, leur
  date et leur paire de clés, pauses, empreintes abrégées des fichiers déjà envoyés) dans la
  description de `Synchro_Export`, et ses règles d'accès, reconnues à leur mémo. En Échange, la
  clé de retour de chaque participant est dans la description de la colonne `id_sync` des tables
  envoyées, une par journal de retour.
- CIBLE : les tables de destination (plus `id_sync`, masquée, dont la description garde la clé de
  signature), les pièces jointes reçues, un journal par export reçu avec sa note (destinations,
  colonnes, tables refusées, fichiers attendus, vagues de suppressions en attente, secret, clés
  publiques des deux côtés) dans la
  description de `Synchro_Ids`, le formulaire de réception sur sa page, et la règle des journaux.
- Un renvoi ne modifie jamais les tables de la personne : il n'écrit que dans `Synchro`.

## Chaîne d'approvisionnement

Le widget a un **accès complet** au document : qui peut modifier son code peut lire et écrire le
document de quiconque l'ouvre. Le risque n'est pas le transit des données mais l'origine du code.
Pour un usage en production :

- installer le widget depuis la **galerie de l'instance** quand il y est ; sinon n'utiliser que
  l'adresse officielle, celle que donnent les consignes du widget (`WIDGET_URL` dans
  `js/config.js`), jamais une adresse reçue par courriel ;
- héberger une **copie figée** du dépôt (version relue, étiquette Git) sur un serveur de
  l'organisation, plutôt que la branche `main` sur GitHub Pages, et y changer `WIDGET_URL` ;
- ajouter cette adresse à la liste des widgets de l'instance, et ne garder dans `js/config.js` et
  la politique de `index.html` que les instances Grist utilisées ;
- relire le code à chaque mise à jour : environ 7 200 lignes de JavaScript commenté, sans dépendance.

## Ce que le widget ne fait pas

- Aucune requête vers un service tiers, aucune télémétrie, aucune donnée hors de Grist.
- Aucune clé d'API personnelle : seuls le jeton court du document et la clé du formulaire servent.
- Aucune lecture du document CIBLE depuis la SOURCE. La CIBLE ne lit la SOURCE qu'en mode lien
  public, sans identifiant, et seulement ce que les règles d'accès laissent voir.

## Risques acceptés

- L'expéditeur d'un export peut écrire dans les tables de destination ce que l'export pourrait y
  écrire : c'est le principe de la synchro (une vague de suppressions attend une décision, une date
  du futur est refusée). La vague se compte par passage : une SOURCE qui efface peu à la fois n'est
  pas retenue (en Renforcé, toute suppression l'est). Seule la SOURCE peut le faire : qui a obtenu
  la clé d'une réception ne le peut plus sans la clé de signature de cette réception (signature et
  sceau), ni un autre destinataire du même export, sauf pour une réception branchée avant la 0.8. Couper le lien y met fin. Pour un export qui envoie des pièces jointes, la SOURCE dépose
  ses fichiers (25 Mo chacun au plus) : un fichier reçu s'ouvre avec la même prudence qu'une pièce
  jointe de courriel. Qui n'a que la clé du formulaire peut faire attendre des morceaux de fichier
  dans le journal (50 Mo au plus, un jour au plus), sans dépôt.
- Les lignes dépliées présentes quand la CIBLE pose son sceau pour la première fois (ou pour une
  nouvelle clé) sont tenues pour bonnes. Un onglet resté ouvert sur une version d'avant la 0.9
  déplierait sans sceau : ces lignes seraient effacées comme suspectes, et la SOURCE renverra. Un
  onglet CIBLE resté ouvert sur la 0.9 ne lit pas les signatures de la 0.10 : les lots arrivés
  pendant ce temps sont rejetés ; recharger la page, puis « Tout renvoyer » côté SOURCE.
- La clé privée d'une invitation en attente est gardée dans la note de `Synchro` jusqu'à
  l'approbation : qui peut lire cette note (propriétaires, éditeurs qui ont le droit de
  structure) et voit la réponse pourrait tirer la clé de ce destinataire. Chaque destinataire voit
  combien de signatures porte un lot, donc combien de destinataires a l'export.
- Chaque passage de la CIBLE relit son journal en entier, morceaux de fichiers en attente compris
  (50 Mo au plus) ; une seconde fois seulement si la recopie y a écrit.
- La clé du formulaire lit la note de son journal, dont le secret de l'invitation, et le nom du
  document : le secret ne sert plus une fois l'invitation acceptée.
- Un envoi en échec bloque la file de tous les webhooks du document SOURCE environ 15 minutes
  (comportement de Grist) : un destinataire qui refuse ses envois retarde les autres. Le widget
  le signale et propose de débloquer la file.
- Sans Redis, la file d'envoi de Grist vit en mémoire : un redémarrage du serveur la perd (le
  widget renvoie ce qui manque à la prochaine ouverture par un propriétaire).
- Le paramètre `?flat=1` n'est pas documenté par Grist (couvert par ses tests depuis 2023).
