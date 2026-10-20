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
- Publication : l'Alpha est en ligne sur grist-factory (V0.5.8 transmise le 16 octobre). Seule la
  branche `alpha` y part : un bug de l'Alpha s'y corrige (puis `main` le reprend). Depuis le
  16 octobre (Antoine : « si les correctifs sont prêts pour l'alpha ils peuvent être publiés
  directement sur le dépôt live »), un correctif prêt et testé sur `alpha` est transmis pour
  publication sans lui redemander (le commit au fil coordinateur du projet). **`main` (V0.6 et
  plus) n'y part pas sans demande explicite d'Antoine.**
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
- Plusieurs formulaires publiés sur la même page partagent une seule clé, et cette clé lit aussi
  les colonnes **et leurs descriptions** (donc les notes) des tables de tous les formulaires de la
  page (vérifié). Depuis la V0.5 : un formulaire par page, une clé par réception.
- `_grist_Pages.options` `{"collapsed": true}` replie une page par défaut ; `indentation` en fait
  une sous-page.
- Ajouter une section à la page du widget recrée l'iframe du widget : toute étape qui en ajoute
  une doit pouvoir reprendre où elle s'est arrêtée. Créer le formulaire sur une autre page, la
  ranger sous celle du widget (`indentation`) et replier celle-ci ne recharge pas le widget
  (vérifié en V0.5, `window.sameFrame` dans le test). Depuis la V0.5.1 (Antoine, 16 octobre :
  « pour que les gens la trouvent »), la page du formulaire reste à la racine, en fin de liste, et
  la page du widget n'est plus repliée. `Synchro` n'a toujours pas de page.
- `AddColumn` ne met une colonne que dans « Données source » et la fiche, pas dans les vues de la
  page : une colonne ajoutée plus tard à une destination arrivait cachée. `AddVisibleColumn` l'ajoute
  aux vues en grille (vérifié, V0.5.1).
- `CreateViewSection(table, 0, 'form')` crée une page nommée « New page » : la renommer.
  `RemoveTable` efface aussi la page devenue vide de son formulaire (mais pas son partage).
- Une règle de colonne `user.Access == VIEWER` → `-R` sur `Synchro_Export` retire la colonne **et
  sa description** de `GET /tables/Synchro/columns` en anonyme ; le filtre des lignes sur cette
  colonne et la règle de ligne marchent toujours (vérifié, lien public).

## Après l'Alpha (branche `beta` fusionnée dans `main` le 16 octobre)

Plan : `/mnt/project-files/notes/beta-plan.md` ; pièces jointes :
`/mnt/project-files/notes/beta-pieces-jointes.md` (accord d'Antoine le 16 octobre, codé en V0.7.0).
- Échange à plusieurs (fait) : un export en Échange accepte plusieurs participants (« Ajouter un
  participant », mode Échange seul). Chaque participant a son journal de retour chez A, dont la note
  garde l'id de son webhook (`hook`, posé à l'approbation ; un Échange plus ancien est retrouvé par
  le document cité dans le mémo). Dès deux participants, `markHub` marque la ligne `echange` de
  `Synchro` (`Synchro_Colonnes` = `HUB`, 'plusieurs' ; le webhook ne l'envoie pas) : la formule du lot
  ne tait plus l'écho (`mute`), donc ce qu'un participant envoie repart vers tous, lui compris (sans
  effet chez lui, même MajLe). Chez A (`hub` dans `copyContext`, journal `retour` d'un export
  marqué), une ligne cochée `Supprime` n'est pas effacée mais recopiée cochée (sinon elle ne
  repartirait pas) ; `withoutEffect` compare alors aussi `Supprime`. Révoquer un participant
  (`removeParticipant`) n'enlève que son webhook (avec la ligne `fin`) et son journal ; chez lui,
  un journal `echange` qui voit `ended` arrête son envoi de retour (`stopReturn`, propriétaire),
  pour ne pas bloquer sa file. Testé de bout en bout (A, B, C) dans `exchangeSteps`.
- Règles de A (fait) : dans « Modifier » d'un export en Échange (étape Nom, `rulesBlock`), chaque type
  de changement des participants (ajout, modif, suppression) est Accepter, Refuser ou À valider, et
  un refus « corriger » (défaut) ou « signaler », notés dans la note d'exports (`regles`, `refus` ;
  `exchangeRules` rend null si tout est accepté). Chez A, `planConsolidation` classe d'abord
  (`versionEffect`), puis écrit (`writeEffect`), refuse (`refuseEffect` : marque `refus`, `Sync_Avant`
  `{v, k}`) ou laisse en attente (`reviewItem`, version non marquée, gardée par la purge). Décision
  sur la carte (`decide`, par id de version, appliquée par un passage). Refus corrigé (`fixActions`) :
  MajLe de la ligne d'ici = version refusée + 1 ms, ajout refusé = ligne cochée Supprime ici, dans un
  lot d'écritures à part (sans toucher la ligne `echange`, sinon l'écho est tu à deux), puis
  `Synchro_Renvoi` du lot = `refus<heure>:<ids>` (`askResend`), effacé après 60 s
  (`clearFixMarks`). En Échange, Supprime est comparée et écrite partout où la destination l'a
  (`deleteCol`) : une version plus récente non cochée fait revenir une ligne cochée. Écarts
  (`refusedGaps`) : dernière version `refus` d'une clé que la ligne d'ici n'a pas dépassée.
- Pièces jointes (V0.7.0, `js/logic/files.js`, `js/source/files.js`, `js/target/files.js`) : une
  colonne Pièces jointes ne part que cochée (décochée par défaut). Dans le lot, la cellule vaut
  `[[fileIdent, nom, taille], ...]` (formule `g()`), que `expandRows` rend `['L', triplet...]`. Une
  table qui envoie des fichiers a une ligne `fichiers` dans `Synchro` (`Synchro_Lot` : JSON
  `fileIdent -> [n°, nom, taille]` des lignes de l'export, filtre compris ; le webhook ne l'envoie
  pas). Le rattrapage SOURCE (`catchUp`, propriétaire, page ouverte) télécharge chaque fichier dû
  (`/attachments/<n°>/download`) et poste ses morceaux (512 Kio bruts, environ 700 ko en base64)
  directement à l'adresse du webhook de chaque destinataire (`postToHook`), en lignes `fichier`
  (`Synchro_Colonnes` : sha, nom, taille, n, parts, envoi ; `Synchro_Lot` : le morceau), sous le
  budget des renvois. Suivi par export dans la note SOURCE (`fichiers` : `{f, h, p}`, empreintes
  abrégées à 16 caractères ; tout webhook de `h` a tous les fichiers de `f`, `p` garde ce qu'ont
  reçu les autres), sans table de plus ; « Tout renvoyer » le vide (`forgetHooks`), un webhook en
  échec attend 10 min. On reconnaît un fichier aux 40 premiers caractères de `fileIdent` (SHA-1 ;
  l'extension peut être devinée du type). CIBLE : `planUnpack` laisse les morceaux de son export
  (ceux d'un autre export sont suspects) ; `receiveFiles` garde l'envoi le plus récent de chaque
  fichier, vérifie taille et SHA-1, dépose (`POST /attachments`) s'il n'est pas déjà là, efface les
  morceaux (un envoi incomplet depuis un jour aussi) ; un dépôt refusé est retenté au bout de
  10 min. La recopie ne met dans une cellule que les fichiers présents (`resolveRows`), note
  `waiting` (empreintes abrégées) dans la note du journal, et complète une cellule quand un fichier
  arrive si elle vaut encore la résolution partielle (`fillActions`). Carte : « N fichiers
  attendus », fichiers de plus de 25 Mo, rien par lien public. En Échange, les colonnes Pièces
  jointes ne sont pas proposées. Une CIBLE d'avant la 0.7 refuse un lot qui porte des fichiers.
  Testé de bout en bout dans `filesSteps` (`ONLY_FILES=1`). Depuis la 0.8, un fichier n'est déposé
  que si une version du journal ou une cellule en attente (`waiting`) le cite (`citedFiles`) : les
  morceaux ne sont pas signés ; un fichier non cité attend un jour (`old`), puis est effacé. Depuis
  la 0.9, les morceaux en attente (envois incomplets `partial`, fichiers non cités) sont bornés à
  `PARKED_MAX` (2 × 25 Mo) par journal, une fois toutes les versions dépliées (`parkedOverflow`, les
  plus anciens partent ; seuls les envois incomplets en trop comptent comme suspects).
- Sécurité (V0.8.0, corrections 1 à 13 de `/mnt/project-files/notes/audit-securite-donnees/corrections-impacts.md`,
  niveau choisi par Antoine : « Standard + case Renforcé ») ; logique pure dans `js/logic/trust.js`
  et `js/logic/acl.js`, règles posées par `js/acl.js` (`syncRules`) :
  - `GET <instance>[/o/<équipe>]/api/s/<clé>` en anonyme rend nom, identifiant (complet), dossier
    et équipe du document de la clé (vérifié) : `shareInfo` dans `js/grist.js`, `sameDoc` compare
    par préfixe d'urlId (12 caractères au moins). Vérifié à « Vérifier » (SOURCE), à la lecture d'une
    invitation d'Échange (CIBLE), et toutes les heures par webhook (`checkHooks`, onglet Envoyer ;
    depuis la 0.9, une adresse qui n'est plus `…/api/s/<clé>/tables/<T>/records?flat=1` sur l'instance
    du document est signalée, `send.person.badAddress`).
  - Code de contrôle (`controlCode`) : 6 caractères de SHA-256(`<clé de partage>\nsecret\n…`) depuis
    la 0.9 (avant : l'adresse entière, dont le préfixe `/o/<équipe>` que Grist ne contrôle pas pour
    une clé de partage : forgeable par essais), « XXX-XXX ». Depuis la 0.10, ce que chaque côté a
    lu y entre (`codeFacts` : niveau, clé publique de l'invitation, et pour le code de la réponse
    celle de la réponse) : une clé publique remplacée en route ou une sécurité renforcée retirée
    (N12) change le code, que A compare obligatoirement en Renforcé. Secret
    toujours ; invitation valable 7 jours (`expire`, `isExpired`, « Refaire le code » remet `at`).
  - Signatures (clé par destinataire depuis la 0.10, N4) : aucune clé secrète dans les codes.
    L'invitation porte `pub` (ECDH P-256, `newKeyPair` ; la privée reste dans l'entrée de la note
    SOURCE, champ `prive`, jusqu'à l'approbation), la réponse aussi (paire tirée par la CIBLE,
    privée jamais gardée ; `pub` et `pubSource` dans la note du journal pour refaire la réponse) ;
    `linkKeys` (ECDH puis HKDF-SHA256, sel `export|invitation`) rend `down` (envois de la SOURCE) et
    `up` (retour d'un Échange). SOURCE : ligne `signature` de `Synchro` = JSON `{ webhook : clé }`
    (`readKeys` ; une clé hexadécimale seule = clé commune d'avant la 0.10, `'*'`, gardée par
    `keptKeys` tant qu'un webhook n'a pas la sienne), posée sous l'id de l'invitation avant
    `createWebhook` puis sous l'id du webhook (`putRecipientKey`), effacée à la révocation
    (`pruneKeys`). Côté CIBLE d'un Échange : `setOnlyKey` (étiquette `retour`, puis le webhook). Les
    formules (`signed()` de `formulas.js`) ajoutent `, "sigs": {<8 hex de SHA-256(clé)>: <32 hex>}}`
    (HMAC de SHA-256(`export|table|type|colonnes|texte`), une par clé, triées) ; `endRows(export,
    hook)` signe la ligne `fin` pour ce seul webhook. Le format `"sig"` d'avant la 0.10 est encore lu.
    Écrire la ligne `signature` recalcule tous les lots de l'export : `updateKeys` n'écrit que si les
    clés changent (un renommage d'étiquette ne change pas le texte signé, donc rien ne part).
    CIBLE : clé dans la description de `id_sync` des destinations (`{"signature": {<place>: clé}}`,
    `storeKey`, `receivedKey`) ; place = export, ou le journal pour un journal de retour d'Échange
    (`keySlot`). Un code d'invitation 0.9 (`cle` sans `pub`) : `codeOld` ; une réponse sans `pub` :
    `inviteOld` (refaire le code). Vérifié (e2e) : clés différentes pour deux destinataires, clé du
    révoqué retirée, lot signé avec la clé du révoqué rejeté par l'autre, lot signé avec une clé
    tirée de l'invitation seule rejeté en Échange. `checkSigned` : 'bad' rejeté (suspect), 'bare' (liste vide non signée : colonnes non
    lues), morceaux de fichiers non signés. Une réception sans clé accepte tout (branchée avant ;
    sa carte le dit, `recv.unsigned`). Versions et listes de plus de 600 s dans le futur rejetées
    (`planUnpack`, `now`). `SIG_KEY` est dans `logic/common.js` (trust.js et codes.js s'importent).
  - **Sceau (0.9)** : la clé du formulaire peut créer une ligne SANS `Synchro_Type`, prise avant pour
    une version déjà dépliée, jamais contrôlée (injection de versions, listes de seaux vides,
    citations de fichiers, offres de tables). Le dépliage scelle chaque ligne qu'il crée : colonne
    `Sync_Sceau` du journal (propre au journal, ajoutée par `upgradeJournal`), HMAC de `sealText`
    (export, table, clé, MajLe, Supprime, données, listes ; pas `Sync_Recu`, que la recopie récrit pour une suppression vue dans une liste : l'e2e l'a montré, 11 000 versions légitimes effacées) avec la clé de signature
    (`sealer`, `sealRows`, `checkSeals` dans trust.js ; `sealing`, `trusted` dans target/loop.js,
    cache des sceaux vérifiés par journal). Une ligne dépliée (`isUnpacked`) au sceau faux est
    effacée et comptée suspecte. Note du journal : `sceau` = empreinte de la clé (8 hex) ; si elle
    change (première fois, nouvelle invitation), les lignes dépliées présentes sont rescellées ;
    `sceau` noté sans clé trouvée : `failure('keyLost')`, le journal n'est plus recopié. Testé
    dans l'étape « lignes forgées » de l'e2e (11 lignes rejetées). Les colonnes d'état
    (`Sync_Applique`, `Sync_Etat`, `Sync_Avant`, `Sync_Recu`) restent hors sceau : la clé ne peut
    que créer. Toute colonne qu'une recopie récrit sur une version doit rester hors sceau.
  - Échange (0.9) : une invitation dont l'export est un export local (note SOURCE ou `Synchro`)
    est refusée (`exportTaken`, dans `readInvitation` et `wireExchange`), sauf reprise du même
    Échange. Une reprise (`showRelink`) tire toujours de nouvelles clés (0.10) : elle se confirme,
    fiche affichée.
  - Règles d'accès du widget (mémos dans `logic/acl.js`) : lien public, puis `Synchro` réservée aux
    propriétaires (5 règles, exception éditeur pour la recopie d'un Échange, limitée depuis la 0.9
    aux exports en Échange : `ownerAclRules(exchangeIds)`), puis journaux réservés aux éditeurs
    (`note.reserve`, case cochée à l'acceptation ; seul un propriétaire pose la règle, qui note
    `reserved` dans la note du journal quand elle est en place, et la carte d'un éditeur dit
    `recv.reserve.owner` en attendant : un non-propriétaire ne lit pas `_grist_ACLRules`, vérifié
    dans GranularAccess). **Limite** : par défaut, Grist donne aux éditeurs le droit de structure
    (règle spéciale SchemaEdit, rangée par l'interface dans la ressource `*` : `user.Access != OWNER`
    → `-S` quand la case est décochée) ; ils peuvent alors réécrire les formules de `Synchro`. En
    Renforcé, la carte de l'export le signale (`editorsEditStructure`). **Piège vérifié** : Grist range chaque
    `AddRecord` de règle avant la première position plus grande, positions toujours positives :
    des ajouts successifs à positions négatives s'inversent, et le widget reposait les règles à
    chaque chargement (rechargement en boucle). Tout part en un seul `BulkAddRecord`. Changer une
    règle recharge le document : l'onglet affiche `common.reloading` et se redessine au bout de 8 s
    s'il est encore là ; jamais pendant un assistant (`.scrim`). Grist refuse tout changement de
    règle tant qu'une ressource nomme une table absente (« Invalid tables in rules »), mais rien
    d'autre (vérifié) : `removeTechnicalTables` laisse donc les règles d'une table effacée, et le
    `syncRules` suivant d'un propriétaire libère sa ressource (`aclActions`, `missing`). Les retirer
    tout de suite rechargeait le widget au milieu de l'action (`markHub` sautait). Pour la même
    raison, les redessins périodiques (`refreshSource`, `refreshTarget` : `periodic`) ne posent
    jamais de règle ; seuls l'ouverture d'un onglet et le dessin qui suit une action le font (vu :
    un redessin du passage de recopie rechargeait le widget pendant « Arrêter la réception », et
    le partage du formulaire effacé restait). Une requête en cours pendant ce rechargement échoue
    (« Failed to fetch ») : `select` (`js/main.js`) réessaie l'onglet une fois au bout de 3 s et ne
    l'écrit qu'en avertissement (vu une fois au test, au démarrage d'Envoyer). Un onglet cliqué
    pendant le démarrage l'emporte sur le premier écran (`picked`, `ready` dans `js/main.js` ; le
    test clique dès que la barre d'onglets paraît). Un lecteur de la CIBLE ne voit plus le journal, donc pas la réception (accueil
    à deux tuiles, puis `recv.emptyViewer`).
  - Vague de suppressions (`WAVE` : plus de 10 lignes et plus de 20 % ; `WAVE_STRICT` en Renforcé :
    toute suppression ; jamais en Échange) : rien n'est effacé, `held` sur la carte, Appliquer ou
    Ignorer (`decideWave` ; Ignorer détache les lignes, `id_sync` vide, versions `partie`).
  - Renforcé (case à l'invitation, `renforce` dans l'invitation et la note) : comparaison du code
    exigée (`codeNotCompared`), vague stricte, pas de lien public. Lien public refusé si une règle
    d'autrui cache des lignes ou colonnes d'une table de l'export (`hiddenTables` ; depuis la 0.9,
    une règle sur `*` les vise toutes, et les tables affichées par une Référence de l'export comptent,
    `readTables` ; revérifié à chaque « Modifier » d'un export public, refus `publicHiddenEdit`, et à
    chaque affichage de la carte, `send.public.hiddenNow`), colonnes publiques listées en rouge,
    alerte si le lien public n'est pas en lecture seule. Échange rangé dans une
    table existante : `confirmOutgoing` liste ce qui repartira. Consignes : `WIDGET_URL`
    (`js/config.js`), galerie d'abord.

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

## État : V0.11.3 (20 octobre 2026)

V0.11.3 (Antoine, 20 octobre : « consignes à vérifier ») : étapes de « Qui fait quoi ? » à
l'infinitif (le courriel de « Copier avec les consignes » vouvoie, elles disaient « Installe »,
« dont elle est propriétaire »), salutation propre à l'Échange (`guide.handoff.target.echange`,
document dont on est propriétaire), pas de mode d'installation dans la réponse renvoyée à la
SOURCE, code de contrôle cité aux deux bouts, rythme réel d'un lien public (chaque minute, 10 s
après une arrivée). **Vérifié dans Grist** : le réglage s'appelle Partager, Gérer les
utilisateurs, « Accès public » Activé, en « Lecture seule », puis Confirmer (il n'y a ni « Lien
public » ni « Lecture »). Adresse des consignes : `widgetUrl()` (`js/config.js`) rend `BETA_URL`
quand le widget est servi depuis la bêta (ses codes ne se lisent pas par l'Alpha publiée), sinon
`WIDGET_URL` ; jamais l'adresse d'une autre copie. Le test vérifie le texte copié.

V0.11.2 (Antoine, 20 octobre : « un message relou » en rangeant une table ajoutée à l'export dans
une table déjà reçue) : `destProblem` (`js/logic/journal.js`) dit quelle table pose problème
(`destTaken` : « Annuaire reçoit déjà la table BDD », `destTwice`, `destReserved`), et la liste
des destinations (`destField`) marque « (reçoit déjà X) » les tables d'ici qui reçoivent déjà
(`receivedDests`). Une destination ne reçoit toujours qu'une table envoyée.

V0.11.1 (audit de performance demandé par Antoine le 20 octobre, rapport
`/mnt/project-files/notes/audits-v0.8/performance.md`, scripts de mesure dans
`/mnt/project-files/notes/audits-v0.8/perf/`) :
- **Piège vérifié** : Grist recalcule toutes les heures (action système `UpdateCurrentTime`,
  document chargé) toute formule qui appelle `NOW()`, sur toutes les lignes. `RecalculLe` le
  faisait : 20 000 lignes réécrites, 6 s de calcul et 1,1 Mo d'historique par heure. Les formules
  du widget lisent l'heure par `time.time()` (`RECALC_SPEC`, `cut` du lot) ; `refreshMajLe`
  remplace l'ancienne formule. Au chargement du document, Grist recalcule toutes les formules :
  `RecalculLe` y est réécrite pour toutes les lignes (prix de la détection de Ctrl+Z, mesuré
  3 s et 0,56 Mo pour 20 000 lignes).
- **Piège vérifié** : un jeton `getAccessToken({ readOnly: true })` est traité en lecteur : `/sql`
  et `/compare` le refusent (403) dès que le document a des règles d'accès, donc toujours une
  fois le widget installé. `selectRows` et `docChanges` prennent le jeton aux droits de la
  personne (`authUrl(…, { full: true })`). Avant : la CIBLE relisait chaque journal en entier
  toutes les minutes (16 Mo/min pour deux réceptions de 10 000 lignes), la SOURCE relisait
  `Synchro` et le schéma toutes les 10 s.
- CIBLE : quand Grist dit ce qui a changé, un passage sans changement n'a lieu que toutes les
  5 minutes (`QUIET_MS`).
- Lot : seule `RecalculLe` est lue sur toutes les lignes, clé et filtre seulement sur les lignes
  recalculées ou à renvoyer (`hit`) : écriture SOURCE de 75 à 38 ms (10 000 lignes ; témoin sans
  widget 15 ms).

V0.11.0 (Antoine, 20 octobre : boutons « tous » et « aucun », fenêtre agrandissable, et « améliorer
l'outil de filtrage des tables, opérateur, valeurs existantes [...] tout type de colonne (référence,
référence multiple incluse) ») :
- `checkList` (`js/ui.js`) : « Tous » et « Aucun » agissent sur ce que la recherche trouve, compteur
  « n sur N », `wide` (grille, colonnes d'une table), longue liste haute de son contenu jusqu'à 45 %
  de la fenêtre puis étirable au coin (`fitHeight`, mesurée à son premier affichage), 300 éléments
  montrés au plus. Les assistants (`.modal-720`) s'agrandissent par leur coin.
- Filtre de lignes (`js/logic/filters.js`, fenêtre `js/source/filter-editor.js`) : ligne `filtre` =
  `{ mode: 'all'|'any', conds: [{ id, source, visible, op, values, labels }] }`. Opérateurs par type
  (`OPERATORS`, `filterKind`) ; une Référence ou Liste de références se filtre par **numéro de
  fiche** (renommer une fiche ne fait sortir aucune ligne, vérifié e2e), « contient » sur le texte
  affiché ; une date se compare en jour « AAAA-MM-JJ », dans le fuseau d'une colonne Date et heure.
  Une condition incomplète est ignorée (`rowFilter`) : « est l'une de » sans rien de coché aurait tout
  effacé chez les destinataires. **La formule Python (`FILTER` dans `formulas.js`) et `filterTester`
  doivent comparer pareil** (aperçu « n lignes partiront ») : vérifié sur 31 cas avec des objets
  Grist simulés. Un filtre d'avant la 0.11 (`{ id, value }`) est lu par la formule (`"conds" not in
  spec`) et par `rowFilter` (op `eq`, texte affiché) ; réécrit au prochain enregistrement de l'export,
  la table repart une fois. MajLe suit toutes les colonnes du filtre (`filterColumns`). Pas de
  condition relative à la date du jour : une formule ne se recalcule pas avec l'heure.

V0.10.1 (Antoine, 20 octobre : « nomEspace/nomDoc ») : la fiche d'un destinataire, côté SOURCE,
montre « e-mail · document · équipe/nom du document ». Le nom (lu chez Grist à l'approbation) est
dans le mémo des nouveaux webhooks (`hookMemo`, `docName`) ; à l'affichage (`hookLabel`), le nom vu
par le contrôle horaire (`checkHooks`, `docName`) complète un mémo plus ancien et suit un document
renommé. Le mémo garde l'identifiant du document (`memoMatches`, `ownJournal`).

V0.10.0 (Antoine, 19 octobre : « corriger les failles de sécurité et défauts d'UX restants ») :
clé de signature par destinataire (N4, voir « Signatures »), code de contrôle qui couvre niveau et
clés publiques (N12), CSP limitée à `grist-plugin-api.js` des instances et envois directs
(`postRows`) limités à l'instance du document (N13), journal relu une seule fois par passage quand
la recopie n'y écrit rien (N7, `wrote` de `copyTable`). Correction 9 (vague cumulée) : fermée par le
sceau et la clé par destinataire, seule la SOURCE peut encore effacer. Format changé : toute
invitation en attente faite par la 0.9 est à refaire (`codeOld` côté CIBLE, `inviteOld` côté
SOURCE) ; les réceptions déjà branchées gardent la clé commune de leur export jusqu'à une nouvelle
invitation ; un onglet CIBLE 0.9 resté ouvert rejette les lots signés par la 0.10.

V0.9.0 (demande d'Antoine du 19 octobre : audits UI/UX, code, sécurité, gwaudit ; comptes rendus
dans `/mnt/project-files/notes/audits-v0.8/`) : parcours harmonisés (43641ec), refacto (b112bb0 :
réseau dans `grist.js` seul, notes SOURCE par `logic/notes.js`, tutoriel dans `i18n/tutorial.json`,
montages d'avant la 0.5 retirés sur décision d'Antoine), puis sécurité (sceau, code de contrôle
sur la clé de partage, Échange, voir « Après l'Alpha »). Format changé : un code de contrôle
calculé par la 0.8 ne correspond plus ; un onglet 0.8 resté ouvert déplierait sans sceau (lignes
effacées comme suspectes, la SOURCE renvoie).
Puis gwaudit (88/100) : les 13 fonctions trop complexes ou trop imbriquées sont découpées (axe A à
100, complexité de 15 au plus) ; restent, structurels et expliqués dans `SECURITY.md` : C-GRIST-03,
C-EXFIL-02, C-STOCK-01, et B-VERB-01 (plus de 4 000 lignes ; carte dans `docs/06-architecture.md`).

V0.8.0 : corrections de sécurité 1 à 13 (voir « Après l'Alpha »). Piège vu au test : au chargement
du document SOURCE (Grist décharge un document inactif), une petite table (20 lignes au plus) part
en entier avec l'heure du chargement (`undone`) ; un renvoi plus tard (colonne ajoutée à l'export)
portait la `MajLe` des lignes, plus ancienne, et la CIBLE l'ignorait : la colonne restait vide.
Hors Échange, une ligne renvoyée part donc au plus tôt à son `RecalculLe` (`when` de la formule du
lot). L'Alpha (0.5.7) a le même défaut. V0.7.0 : pièces jointes. V0.6.0 : `main` reprend la Bêta (Échange à
plusieurs, règles de A). L'Alpha publiée est la V0.5.7 (branche `alpha`).

V0.5.1, correctifs de l'Alpha signalés par Antoine (le reste est gelé, voir la mémoire) : fenêtre
d'envoi de l'existant fermable pendant l'envoi, qui continue (l'onglet se redessine à la fin) ;
colonnes ajoutées plus tard visibles dans la destination ; formulaires à la racine des pages.
V0.5.2 : révoquer, supprimer l'export ou arrêter un Échange envoie d'abord une ligne `fin`
(`KIND.end`, `endNotice`) directement à l'adresse du webhook (`deleteWebhookWithNotice`) ; la CIBLE
la lit (`planUnpack` rend `ended`), la note (`ended` dans la note du journal) et la carte affiche
« Coupé par la SOURCE ». Des données arrivées après effacent l'avis.
V0.5.3 (retours UX d'Antoine : « le parcours principal, sens unique d'une table complète avec
secret, doit être super clair, le reste en option discrète ») : assistants larges de 720 px
(`openWizard`, repliés sur un petit panneau), « Qui fait quoi ? » toujours replié, bouton Retour
à chaque étape (changer d'options après l'invitation la retire et en refait une, avec
confirmation ; côté CIBLE, revenir avant le lien défait la réception créée), colonnes et filtre
d'un export repliés derrière deux boutons (tout part par défaut), modes « Dans un seul sens
(recommandé) » puis « Autres modes », destinations en grille avec le libellé « Nom de la
nouvelle table ».
V0.5.4 (Antoine) : côté CIBLE, les valeurs retouchées à la main sont signalées sur la carte
(`manualEdits` : cellule d'une ligne reçue différente de sa dernière version ; rien en Échange),
avec numéro de ligne, valeur d'ici et de la SOURCE. La destination est relue pour cela au plus
toutes les 5 minutes (`REREAD_MS`), au retour sur la page ou sur « Synchroniser ». L'historique
montre le numéro de ligne (`rowNumbers` : rang de `manualSort`, comme Grist l'affiche, pas l'`id`)
et l'avant/après en petit tableau ; la recopie note ce qu'elle remplace dans `Sync_Avant`, colonne
propre au journal (`{v}` modification, `{n}` numéro d'une ligne supprimée), ajoutée aux anciens
journaux par `upgradeJournal`.
V0.5.5 (Antoine : « Synchroniser ne corrige pas une retouche ») : bouton « Corriger » sous l'alerte,
avec confirmation (`restoreSource` : relit journal et destination, `restoreActions` remet la valeur
de la dernière version reçue dans chaque cellule retouchée, et seulement elles). « Synchroniser »
garde les retouches, par choix.
V0.5.6 (Antoine : « l'historique doit être replié par défaut », « la suppression d'une ligne côté
cible », « aussi pour une colonne supprimée ») : historique et chacune de ses lignes repliés, ce
qu'on ouvre le reste d'un dessin à l'autre (`opened`, événement `toggle`). Une ligne reçue effacée
ici est un écart (`gone`) tant que sa clé reste dans la SOURCE ; une clé partie de la SOURCE alors
qu'elle n'était plus ici prend l'état `partie` (`LEFT`, non montré dans l'historique) et n'est plus
signalée. Une colonne reçue effacée ici (`droppedColumns` : dans `refs.cols` ou `dropped` de la note,
absente de la destination) n'est plus recréée vide à chaque passage : elle est notée (`dropped`),
signalée, et « Corriger » la recrée (`AddVisibleColumn`) puis remet lignes et valeurs de la SOURCE.
L'Échange recrée toujours seul une colonne effacée.
V0.5.7 (Antoine : l'alerte « dès que ça se passe », et « dire dans l'historique qu'une colonne a
été ajoutée à l'export ») : toutes les 10 s, `due` (`js/target/loop.js`) demande à Grist les tables
changées depuis l'état vu au coup d'œil précédent (`docChanges` : `GET /compare?left=<hash>&right=HEAD&maxRows=1`,
jeton aux droits de la personne (refusé en lecture seule), une dizaine de ms ; 500 « Cannot read hash » si l'état est sorti de l'historique, alors relu depuis
HEAD ; `tableRenames` non vide : tout relire ; réservé à qui peut tout lire du document, sinon
l'ancien rythme). Un passage n'a lieu que si un journal, une destination ou `_grist_Tables*` a
changé (`touchedTables`), au moins toutes les 5 minutes depuis la 0.11.1 (une fois par minute avant), et au rythme d'avant pour un lien public ;
une destination changée perd son cache (`settled`, qui note `dest`) et est relue. Nos propres
écritures valent un passage de plus, sans effet. Colonnes ajoutées à l'export : notées dans
l'entrée (`addedCols`, `addedColumns`, les 10 dernières) quand `newColumnsMap` les range, et
montrées dans l'historique (état `colonne`, icône `column`).


V0.5 (backlog d'Antoine du 15 octobre au soir, puis feuille de route de la nuit : tests,
audit, refacto, gwaudit) : Échange (deux sens, la plus récente l'emporte, sans écho, deux codes),
filtre de lignes par table (`filtre`), suivi des clés par 256 seaux d'empreintes CRC-32 (`suivi`,
plus de limite de 20 000 lignes, liste complète par morceaux de 5 000 clés lors d'un renvoi),
destinations renommées suivies par référence, Ctrl+Z SOURCE (`RecalculLe`), un formulaire par
réception sur sa propre page rangée sous celle du widget, test du lien qui prouve qu'il écrit
dans ce journal (`linkElsewhere`), « Arrivées suspectes » et « Couper le lien », reprise de la
même réception après confirmation, renvois ménagés (un à la fois par document, ligne `charge`,
budget), note SOURCE masquée en lien public. Les paragraphes suivants décrivent le montage de la
V0.4, encore valable sauf là où la V0.5 le remplace (la liste `cles` d'un seul tenant ne reste
que pour le lien public et les montages 0.4 ; le garde-fou `MAX_ROWS` a disparu). Code découpé
en `js/logic/` (pur, testé par `tests/unit/*.test.mjs`, un fichier par module), `js/source/`,
`js/target/`, plus `pages.js`, `form-link.js`, `exchange.js` (carte dans `docs/06-architecture.md`).
Plusieurs listes des clés d'une même table peuvent attendre le même passage de la CIBLE (une
ligne brute arrivée entre le dépliage et la recopie attend le passage suivant) : seule la plus
récente qui couvre un seau décide (`droppedKeys`), sinon une ligne revenue dans un filtre était
effacée par la liste d'avant (vu par le test d'intégration).
`el()` met à plat les enfants à toute profondeur (`flat(Infinity)`) : une liste de listes
affichait « [object HTMLParagraphElement] ». `ui.run` n'écrit dans la console que les erreurs
sans texte `error.<code>` (le test vérifie une console sans erreur).

Décisions d'Antoine du 15 octobre : la SOURCE s'organise en **exports** (nom, tables, colonnes ;
ajouter ou révoquer une personne sans refaire l'export ; la synchro dans les deux sens, « Échange »,
viendra après) ; côté CIBLE, **un journal et un formulaire par export**, et une **fenêtre** qui
s'ouvre seule pour ranger une table ajoutée à l'export. **Contrainte forte** : côté SOURCE, au
plus 3 tables techniques pour tout le widget (1 idéal), quel que soit le nombre d'exports et de
tables.

Montage (une seule table technique SOURCE, `Synchro`) : par table d'un export, une ligne `cles`
(formule `Synchro_Ids` : liste des clés) et une ligne `lot` (formule `Synchro_Lot` : lignes à
`MajLe` de moins de 5 s, ou listées dans `Synchro_Renvoi`, en JSON, plafonné à 250 ko), plus une
ligne `complet` (toutes les lignes) pour un export public. Les formules choisissent la table par
un dictionnaire `{"Contacts": Contacts}` réécrit quand les tables changent (`syncFormulas`). Un
webhook par destinataire sur `Synchro`, avec la **condition** Grist
`rec.Synchro_Export == "<id>" and rec.Synchro_Type in ("cles", "lot")` (Grist ≥ 1.7.11 ;
`createWebhook` relit la condition enregistrée dans `_grist_Triggers` et supprime le webhook si
elle manque : erreur `gristTooOld`). L'export d'un webhook se relit dans sa condition
(`conditionExport`) ; un webhook sur `Synchro` sans condition reconnue est signalé « sans filtre ».
Un renvoi écrit `marque:numéros` dans `Synchro_Renvoi` (jamais `MajLe`), par tranches de 200 en
attendant que la file soit vide, puis efface `Synchro_Renvoi`. Notes : SOURCE dans la description
de `Synchro_Export` (`exports`, `invitations` avec empreinte du secret, `pauses`) ; CIBLE dans
celle de `Synchro_Ids` du journal (`export`, `tables` : destination, colonnes, correspondance,
rattachement, colonne affichée ; `refused` ; `missing`). Codes `GRISTSYNC2.` (`GRISTSYNC1.` :
erreur `codeOld`), réponse à une seule adresse. `Supprime` n'est plus ajoutée (prise en compte si
présente).

CIBLE : le journal a les colonnes de `Synchro` (le webhook envoie la ligne entière) plus celles
des versions. Le widget déplie les lignes brutes (`planUnpack`, dans l'ordre d'arrivée, effacées
dans le même lot), puis consolide par table (`rowsByTable`, `planConsolidation`), puis purge
(`planPurge`, qui garde tout d'une table proposée et rien d'une table refusée). Une version sans
changement depuis la dernière recopiée, ou égale à la destination, est sans effet (`sameValue`) :
un renvoi vers un nouveau destinataire ne défait pas les retouches des autres.

Limites : un envoi Grist est limité à 1 Mo (corps JSON, `express.json`) et regroupe jusqu'à 100
événements consécutifs d'un même webhook ; la liste des clés et le lot qui changent ensemble partent
donc dans le même envoi, d'où le budget du lot `max(20 ko, min(250 ko, 950 ko - 40 o × lignes))`.
En V0.4, une liste des clés de plus de 25 000 lignes environ, ou plusieurs listes en attente
regroupées, dépassaient 1 Mo et bloquaient la file : la V0.5 n'envoie plus que les seaux qui
changent, et la liste complète par morceaux lors d'un renvoi. Depuis le 19 octobre (Antoine,
carte « Retirer »), les montages d'avant la 0.5 (tables `Synchro_<table>`, journaux par table,
lignes sans `suivi`, règle « lecture limitée aux vues d'export ») ne sont plus reconnus ni
nettoyés par le widget.

V0.4.1 (demande d'Antoine : « on anticipe et on fait partir en auto ») :
- `MajLe` est une formule de déclenchement (`recalcWhen` 0) dont `recalcDeps` liste les colonnes
  envoyées par les exports, leur `displayCol` (texte d'une Référence) et `Supprime`
  (`majleAction`, appliqué par `refreshMajLe` à chaque affichage de l'onglet Envoyer). Vérifié :
  une formule ou un `gristHelper_Display` qui change à cause d'une autre table déclenche la
  formule, donc une ville renommée repart seule.
- Un lot coupé (non renvoi) dit `depuis` ; la colonne `Sync_Etat` de `Synchro` (formule de
  déclenchement sur `Synchro_Lot`, `missingFormula`) garde la plus ancienne. Le widget SOURCE
  (`catchUp`, à l'affichage puis toutes les 10 s, propriétaire seulement, verrou
  `navigator.locks`) l'efface puis renvoie les lignes à `MajLe` >= cette date. Rien ne peut le
  faire sans page ouverte (une formule ne programme rien).
- **Toute colonne de `Synchro` doit déjà exister dans les journaux des CIBLES** (le webhook envoie
  la ligne entière, une colonne inconnue donne 400 et bloque la file) : la marque porte donc le nom
  `Sync_Etat`, déjà dans tous les journaux. Ne jamais ajouter à `Synchro` une colonne d'un nom
  nouveau.
- `recalcDeps` se pose par `UpdateRecord` sur `_grist_Tables_column` après `AddColumn` (dans
  `AddColumn`, Grist échoue : « 'AltText' object is not iterable »). Dans une formule de
  déclenchement, `value` est la valeur précédente de la cellule (`$Col` sur elle-même rend
  `None`). Vérifié le 15 octobre : la formule se recalcule dès qu'une colonne suivie est
  **recalculée**, même sans changement de valeur ; une action qui écrit la colonne elle-même
  l'emporte sur la formule dans la même action. Un webhook n'envoie que les lignes dont une valeur
  a changé.

Garde-fou de la V0.4.2 (le refus des tables de plus de 20 000 lignes a disparu en V0.5) : les lots d'un export se
partagent le budget (formule du lot : `lookupRecords` des lignes `cles` de l'export) ; un envoi
refusé pour sa taille (413 : Grist retente 20 fois, environ 15 minutes, puis remet le lot en fin de
file, sans fin ; à la fermeture du document, il abandonne après 5 essais) est vu par `catchUp`, qui vide
la file et marque tous les lots servis `RESEND_ALL` (`clearAndMark`, aussi derrière « Débloquer la
file »). Tout renvoi est reprenable : la marque de chaque lot est écrite avant le premier envoi,
puis réécrite à chaque tranche (`chunkMark`, lignes dans l'ordre de `MajLe`), et effacée à part à
la fin.

Code à la racine, sans build : `index.html`, `css/`, `js/` (présentation dans `README.md` et `README.en.md`, carte des modules dans `docs/06-architecture.md`,
analyse de sécurité dans `SECURITY.md`, tutoriel `docs/04-tutoriel.md`). Tests : `npm test`
(logique pure), `npm run test:e2e` après `tests/e2e/start-grist.sh` (parcours complet dans un
Grist Docker, trois documents ; `CAPTURES=1` refait les captures de `docs/images`, leurs vignettes
recadrées du README (`docs/images/readme`, `shot(nom, 'modal' | 'card')`) et les images d'aide
de `img/` ; `npm test` vérifie les images et liens des README). Les instances autorisées sont à la fois dans `js/config.js` et dans la CSP de
`index.html`. Aide intégrée (V0.3) : onglet Tutoriel (`js/tutorial.js`, texte dans `i18n/tutorial.json`), « Qui fait quoi ? » et
« Copier avec les consignes » (`js/guide.js`), aide en images à chaque étape des assistants.

Piège vérifié le 15 octobre (V0.4.4) : la table `Synchro` n'a pas de colonne `manualSort`
(`ensureSyncTable` la retire). Le webhook l'envoyait : chaque ligne reçue visait le même rang du
journal, et après une cinquantaine d'envois en attente (page CIBLE fermée), Grist renumérotait les
lignes voisines, refusé à la clé du formulaire (403 « Blocked by table update access rules »),
file bloquée. Grist borne aussi : file de 1 000 événements par document (au-delà, il bloque les
écritures du document), 10 requêtes simultanées par document (429), historique de 1 000 actions
ou 1 Go (une cellule recalculée à chaque ajout y est copiée deux fois par action).

Pièges : toute écriture REST depuis le widget doit porter `X-Requested-With` (sinon 401, vu comme
une erreur CORS ; un `POST` anonyme en JSON passe sans) ; changer une règle d'accès recharge le document, donc le widget. Désactiver un
webhook remet à zéro son état d'envoi (`lastSuccessTime` perdu) et Grist ne met rien en file
pendant la pause : l'heure de pause (plus grande `MajLe`) est notée dans la note. Dans les tests,
`getByText` de Playwright est insensible à la casse et cherche une sous-chaîne (« En pause »
trouve « Mettre en pause ») ; le mémo d'un webhook porte l'identifiant court du document (urlId).

Relais (A → B → C) : possible, la table reçue garde les `id_sync` de A ; l'export ne remplit pas
les clés vides d'une table reçue (une ligne locale à clé serait effacée par la prochaine liste de
A). Les boucles (retour vers le document d'origine, table vers elle-même dans le même document)
sont refusées (`loopingTables` à « Vérifier », `checkDests` côté CIBLE). Le second saut dépend de
la page du widget ouverte dans B.

V0.4.3 (audit du 15 octobre) :
- Les formules de `Synchro` ne nomment que des tables existantes (`refreshFormulas`), sinon une
  table renommée ou supprimée met toutes les lignes en erreur ; leurs variables sont en minuscules
  (`tables`, `src`) car un identifiant de table Grist commence par une majuscule. La carte de
  l'export signale table perdue et colonnes changées (`drift`). `Supprime` part telle quelle,
  lue par `isTrue` côté CIBLE.
- Une colonne ajoutée plus tard à l'export prend un nom libre dans une destination existante
  (`newColumnsMap`). Une table envoyée par ce document ne peut pas être destination
  (`destExported`) ; `isUserTable` écarte `Synchro`, `Synchro_*` et `Journal_*`.
- Lien public : `isPublic` vaut vrai, faux ou inconnu (inconnu : rien ne change) ; le refus
  général n'est posé que si le widget a déjà ses propres règles.
- Un lot vide part pour une table vide lors d'un renvoi (la CIBLE remet son compte de lignes
  manquantes à zéro). Les boutons d'une fenêtre sont grisés pendant l'action (pas de doublon sur
  double clic).
- Textes : `t()` met une espace insécable avant `: ; ? ! »` et après `«` (modèle seulement, pas
  les valeurs) et écrit les nombres à la française (séparateur U+202F). Dans les tests, une
  expression régulière de `getByText` lit le texte brut : `\s` autour de ces signes, `[\d\s]+`
  pour les nombres ; une chaîne simple normalise les espaces.

Effacer une table efface ses sections, mais pas leurs cases dans `layoutSpec` (repliés compris ;
les numéros de sections sont réutilisés ensuite) ni le partage de la page (`_grist_Pages.shareRef`
et `_grist_Shares`, donc la clé d'écriture). Quand la page ne portait que le formulaire de la
table, Grist efface la page mais garde le partage. `removeTechnicalTables` (`js/pages.js`) relève
les partages avant d'effacer et nettoie les deux (`tidyActions`). Les tables techniques n'ont pas
de page (`dropPages`). Créer une section sur une autre page que celle du widget ne recharge pas
le widget.
