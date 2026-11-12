# syncPlus : instructions pour Claude

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
- **Nom du produit : « syncPlus »** (Antoine, 12 novembre : « Le produit sera syncPlus pour être cohérent avec le reste du
  naming de GFS »), écrit ainsi partout où une personne le lit (titre de l'écran en français et en anglais, README, tutoriel,
  diagnostic, consignes à transmettre) et dans la doc de développement. Plus de « Synchro », « Sync », « Synchro Grist », « Grist
  Sync » ni « Sync+ » comme nom de produit. **Ne changent pas** : la table technique `Synchro` et ses colonnes (formules,
  webhooks, règles d'accès, codes), la marque `syncPlus` des partages (`MARK_KEY`), l'adresse publique (`WIDGET_URL`).
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
  directement sur le dépôt live »), un correctif prêt et testé sur `alpha` était transmis pour
  publication sans lui redemander (le commit au fil coordinateur du projet). **`main` (V0.6 et
  plus) n'y part pas sans demande explicite d'Antoine.**
  **Depuis le 6 novembre, l'Alpha est gelée** (Antoine : « on ne touche pas au code de l'alpha et au
  dépôt public. On corrige sur dev. On pushera une v beta bientôt ») : rien n'est commité sur `alpha`,
  rien n'est transmis à grist-factory ; cela remplace la règle du 16 octobre. Tout correctif va sur
  `main` et part avec la prochaine Bêta.
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
- **Accès complet** (Antoine, 6 novembre : « bien rajouter que le widget a besoin d'avoir les accès
  complets et un screen dédié du panneau », dans le tutoriel et dans l'interface) : le réglage est
  dans le **panneau de droite** de Grist (pas celui de gauche, qui liste les pages), onglet du
  widget (« Personnalisée »), section « Niveau d'accès » : liste « Pas d'accès au document » /
  « Lire les données source sélectionnées » / « Accès complet au document », et, tant que rien n'est
  décidé, une bulle « Le widget a besoin de full access à ce document » avec Accepter et Refuser
  (vérifié dans Grist 1.7). Le panneau est **fermé** à l'ouverture d'un document déjà installé :
  icône tout en haut à droite. Sans accès, `grist.docApi` refuse la lecture : le widget montre le
  message `start.access` et `accessHelp()` (`js/tutorial.js`), avec trois captures **pleine page**
  (Antoine : un screen « qui montre où est le panel », widget ouvert assez large pour qu'on le voie)
  à cadre rouge : `docs/images/00g` (panneau fermé, icône d'ouverture), `00e` (panneau ouvert,
  « Niveau d'accès » et Accepter) et `00f` (la liste), faites à l'échelle 2 par `accessShots`
  (`CAPTURES=1 ONLY_ACCESS=1` ; le widget y retire ses propres images pour ne pas se montrer
  lui-même). Une fois l'accès accordé, par « Accepter » comme par la liste,
  Grist recharge le widget qui démarre seul (testé : `accessSteps`). Même écran pour SOURCE et CIBLE :
  le contrôle se fait au démarrage, avant de connaître le rôle.
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
  sa description** de `GET /tables/Synchro/columns` en anonyme (cette route seulement : dans les
  métadonnées, `_grist_Tables_column`, Grist vide les **options** d'une colonne cachée mais pas sa
  **description**, voir la V0.18.0) ; le filtre des lignes sur cette colonne et la règle de ligne
  marchent toujours (vérifié, lien public).

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
  attendus », fichiers de plus de 25 Mo, rien par lien public. Depuis la 0.14, en Échange, les
  fichiers circulent dans les deux sens (voir l'état V0.14.0). Une CIBLE d'avant la 0.7 refuse un lot qui porte des fichiers.
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
  - Vague de suppressions : **retirée en 0.13.4** (voir l'état ci-dessus) ; la CIBLE applique toutes les suppressions.
  - Renforcé (case à l'invitation, `renforce` dans l'invitation et la note) : comparaison du code
    exigée (`codeNotCompared`), pas de lien public (la vague stricte a été retirée en 0.13.4). Lien public refusé si une règle
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

## Moteur 1.0.0 (7 novembre 2026, rien de visible : l'écran reste à la V0.13.2)

Consignes de GFS (suite d'apps Grist Factory) : son explorateur lira **le moteur** de syncPlus pour partager un dossier ou un
fichier entre deux documents qui ont GFS (décision du porteur du 6 novembre, dépôt `lombre33/grist-widget-GFS`, `consignes/sync/`,
001 et 002 ; la réponse est `GFS-ETAT.md` à la racine, **fichier de développement, jamais publié** ; ne rien pousser chez GFS).
Antoine, 7 novembre : « tu peux travailler sur main [...] attention à ne pas créer des risques de sécurité ou modifier des
comportements du standalone pour GFS ». Donc : aucun lien avec GFS dans le code de syncPlus (pas de `gfs.json`, pas d'entrée au
catalogue), syncPlus seul se comporte comme avant, tout est dans `js/engine/` (mode d'emploi : `js/engine/README.md`) :
- **`js/engine/`** : logique pure, pages, règles d'accès, Échange, et la part sans écran de la SOURCE et de la CIBLE (renvois,
  rattrapage, journaux, recopie, pièces jointes). Rien n'y lit `document`, `window`, `location`, `navigator`, `localStorage` ni
  `grist` ; les écrans appellent le moteur, jamais l'inverse (`tests/unit/engine.test.mjs`, avec le contrôle des imports).
- **Un seul `port`** (`engine/port.js`, `PORT_SHAPE`) : `startEngine({ port, prefix })` dans `js/main.js`, avec `js/sync-port.js`
  (les fonctions de `js/grist.js`, les textes `i18n`, la visibilité de la page, `localStorage`). Les modules du moteur importent de
  `port.js` les noms de l'ancien `grist.js`, résolus **à l'appel**, jamais à l'import.
- **Préfixe de tables** (`prefix`, défaut `''` : les noms d'avant) : `SYNC_TABLE`, `JOURNAL_PREFIX` (liaisons vivantes de
  `logic/common.js`, fixées par `setTablePrefix`) et `destTableId` ; les colonnes (`Synchro_*`, `id_sync`, `MajLe`) et les mémos
  de règles d'accès ne changent pas. Une valeur évaluée à l'import ne verrait pas le préfixe (d'où `filterLines()` et `readLines()`
  dans `formulas.js`). Lien public : les deux documents doivent avoir le même préfixe.
- **`ENGINE_VERSION`** (`engine/version.js`) : 1.0.0, elle ne suit pas la version de syncPlus ; mineure pour un ajout, majeure pour
  un port, un nom de table ou un format qui ne se lisent plus pareil. À dire dans `GFS-ETAT.md` avec le commit.
- Fichiers scindés en deux parties (écran / moteur) : `form-link.js` (le test du lien), `source/{actions,estimate,keys}.js`,
  `target/dest.js` (`checkDests`) ; `schemaFrom` (`logic/schema.js`) bâtit le schéma pour n'importe quel port ; `resendTables`
  rend son avancement par un rappel (`progress`), l'écran le montre (`progressTo`).
- **Moteur 2.0.0 (9 novembre, consignes 003 second lot, 004 et 005)** : version **majeure** parce que le port exige quatre
  fonctions de plus (`shareInfo`, `publicAccess`, `renameWebhook`, `journalStats` : un port écrit pour 1.0.0 est refusé par
  `setPort`), toutes dans `createRestPort`. Ce qui est entré dans le moteur :
  - **les requêtes REST, une seule fois** (`engine/rest-port.js`, `createRestPort({ docApi, http })`) : webhooks (condition
    relue, file vidée avant l'effacement, avis de fin), `docChanges` (état perdu = inconnu), SQL, envois directs limités à
    l'instance, fiche d'un partage, document public, pièces jointes. L'hôte ne donne que `http` (`request`, `anonymous`,
    `download`, `upload`, `docBaseUrl` ; les refus **lèvent** une erreur à `status` et `message`, contrat dans
    `engine/README.md`). `js/grist.js` n'est plus que l'`http` de syncPlus (jeton `auth=`, liste des instances) et la lecture
    des tables. Essai : `tests/unit/rest-port.test.mjs`, `doc-changes.test.mjs`.
  - **l'orchestration des assistants sans fenêtre** : `engine/source/export.js` (`saveChosenExport`, `finishEdit`),
    `engine/source/invite.js` (invitation, code, lien public, retour d'Échange, `checkReply`, `approveReply`, `loadPlan`,
    `sendExisting`), `engine/target/receive.js` (`readInvitation`, `knownReception`, `relinkReception`,
    `checkDestinations`, `createReception`, `undoReception`, `receptionReply`, `myEmail`). Les écrans
    (`source/export-wizard.js`, `source/recipient-wizard.js`, `target/wizard.js`) ne gardent que les fenêtres. Essai :
    `tests/unit/engine-flow.test.mjs` (SOURCE puis CIBLE sur deux Grist en mémoire, lot signé recopié, reprise,
    renouvellement, diagnostic).
  - **le contrôle horaire des webhooks** (`engine/source/hook-check.js` : `checkHooks`, `hookCheck`, `personLabel`).
  - **le diagnostic** (`engine/diagnostic.js`, `diagnostic({ version, served, readOnly, agent })` ; `logic/diagnostic.js` reçoit
    `t` et reste pur ; 86 clés `diag.*` en fr et en ; espaces insécables retirées du texte rendu ; `js/diagnostic.js` ne dit
    que version, origine du widget, lecture seule et navigateur). Le texte français est celui d'avant (mots `echange` et
    `reponse` sans accent gardés). Seul changement visible : en anglais, le diagnostic est maintenant en anglais.
  - **le jugement d'un lien collé, tout dans le moteur** (consigne 005, décision du porteur du 9 novembre : « le copier-coller
    des liens, il faut garder le cœur du moteur de Sync+ ») : les écrans n'ont plus aucun contrôle de lien. La comparaison du
    code de contrôle en sécurité renforcée (`codeNotCompared`) était une règle d'écran : elle est dans `approveReply(…, { compared })`
    et, pour un Échange renforcé, dans `checkDestinations` et `createReception` (`mustCompare`) ; la durée de vie d'une
    invitation (`invitationState`). Essai : `tests/unit/engine-links.test.mjs` (autre document, clé coupée, Grist muet, code
    non comparé, clé publique remplacée, invitation périmée ou d'une autre instance).
  - `startEngine({ version })` (version de l'application écrite dans les codes). Le comportement de syncPlus seul n'a pas changé
    (unit et e2e complets verts avant le commit).
- **Moteur 2.6.0 (10 novembre, consigne 006 de GFS, sans changement visible)** : l'outil d'audit lit `js/engine/` quand il juge GFS ;
  cinq fonctions passaient ses seuils (80 lignes, complexité 15) : `createRestPort` (226 lignes), `lotFormula` (87), `journalFacts`
  (22), `diagnosticText` (18), et `docUrl` (16, venue avec la 2.5.0, que GFS n'avait pas mesurée). Découpées sans rien changer à ce
  qu'elles rendent : `createRestPort` n'assemble plus que des groupes (`sqlPort`, `changesPort`, `webhookListPort`, `directPort`,
  `webhookEditPort`, `sharePort`, `attachmentPort`, chacun avec son état de session dans sa fermeture), mêmes vingt noms dans le même
  ordre ; `lotFormula` met bout à bout sept fonctions d'étapes (`lotHeadLines`… `lotTallyLines`). **Le texte des formules de `Synchro` est
  gardé octet pour octet** par `tests/unit/formulas-golden.test.mjs` (référence `tests/unit/golden/formulas.json`, trois montages :
  sans préfixe, `Gfs_`, aucune table ; `UPDATE_GOLDEN=1` ne se lance que pour un changement voulu, avec la version du moteur relevée).
  Avant/après comparés sur des cas en masse hors dépôt (diagnostic : 1 056 cas fr et en ; `docUrl` : 22 869 combinaisons ; `createRestPort` :
  196 appels sur sept serveurs simulés, requêtes comprises). Mesure : `tests/tools/mesure-moteur.mjs` (fonctions de l'outil d'audit,
  `GWAUDIT_DIR=<dépôt de l'outil>`, ce n'est pas gwaudit) : 51 fichiers, 1 680 fonctions, plus grande 49 lignes, complexité 15 au plus.
  Mineure, par la règle de `version.js` (rien d'ajouté ni de retiré au port, aux tables, aux codes). Règle ajoutée au `README` du moteur
  (5 et 6) : une fonction qui grossit se découpe, le texte des formules ne change pas sans décision.
- **Reste côté écran, dit à GFS** : les fenêtres, boutons et l'ordre des écrans des assistants (`js/source/*-wizard.js`,
  `js/target/wizard.js`), les cartes. Restent en français fixe : les mémos des règles d'accès (consigne 003, point 1).
- **Anciens chemins** : ceux que cite ce fichier plus bas (`js/logic/…`, `js/pages.js`, `js/acl.js`, `js/exchange.js`,
  `js/source/{synchro,files,pausing,resend}.js`, `js/target/{journals,files,loop}.js`) sont maintenant sous `js/engine/`.
- Essais : `tests/unit/engine.test.mjs` (garde-fous, préfixe), `engine-port.test.mjs` (SOURCE et CIBLE sur un Grist en mémoire,
  `engine-fake.mjs`, préfixe `Gfs_`) ; les autres essais n'ont changé que leurs chemins d'import (`js/logic` devient
  `js/engine/logic`), l'e2e que les chemins des fichiers servis.

## État : V0.21.0 (12 novembre 2026)

V0.21.0 (Antoine, 12 novembre, « pour moi c'est good » sur la maquette de la fenêtre « Renforcer la sécurité » et des nouveautés, après la carte
« Maquette puis code » ; décisions de fond du 6 novembre : mise à niveau **optionnelle** (option B), vocabulaire « Renforcer la sécurité » (jamais « renouveler »
ni « Bêta » dans l'interface, suggestion et non ordre, avis informatifs en gris-bleu), anciens partages **jamais forcés**, rien ne casse). Moteur **4.4.0**
(mineure, dite dans `GFS-ETAT.md`). **Rien n'est publié** (Alpha gelée, `main` n'est pas transmis à grist-factory sans demande explicite).
- **Partage « d'avant les clés »** = destinataire sans clé de signature : côté SOURCE `unsignedHooks` (ligne `signature` de `Synchro` sans clé pour ce webhook ;
  une clé commune `'*'` d'avant la 0.10 = rien à dire), côté CIBLE réception sans sceau ni clé notée (`isUnsignedReception`). Pas d'identification possible d'un
  webhook d'Alpha au sein d'un export déjà « à clés » (aucun champ ne le dit) : l'avis `send.person.noKey` d'un destinataire sans clé est donc remplacé par la
  suggestion de renforcer quand elle est possible (le renforcement répare aussi une clé perdue), et reste pour un destinataire en pause.
- **Parcours** (SOURCE puis CIBLE, `js/source/tab.js` `reinforceNotice`/`reinforceLine`/`reinforce`, `js/source/recipient-wizard.js` en mode `renf`, `js/target/reinforce.js`) :
  (1) SOURCE, bouton « Renforcer la sécurité » sur la ligne de la personne → `startReinforcement` (invitation avec `replaces`) → assistant à 3 étapes
  (Invitation, Réponse, Contrôle) sans l'étape Options ; (2) CIBLE : coller le code d'une invitation d'une réception connue sans clé → écran « reprise »
  avec texte dédié (`recv.relink.*.renf`), `relinkReception` fait `startRenf` ; (3) SOURCE : coller la réponse, comparer, approuver → `approveReply`
  crée le webhook neuf, **supprime l'ancien sans avis de fin**, événement `reinforce` ; `controlResend` renvoie ce qui a changé depuis l'invitation ;
  (4) CIBLE : la première livraison signée vue finit (`finishRenf`) → « Partage renforcé » (un mois). Un renforcement se fait **une personne à la fois**
  (la maquette montrait un choix multiple : non codé, dit à Antoine).
- **Délai de 7 jours** (`GRACE_S`, `logic/reinforce.js`) : tant que la première livraison signée n'est pas vue, la CIBLE accepte aussi les envois SANS signature
  (`checkSigned(..., { grace })` : jamais une mauvaise signature, jamais une ligne `fin`). Passé le délai : carte « Renforcement interrompu » (erreur, `role=alert`,
  état « Erreur »), qui dit la date, ce qui est refusé, et offre « Renvoyer ma réponse » ou « Revenir à l'ancien fonctionnement » (`revertReinforcement` : retire clé
  publique, sceau, attente ; permis tant que ce n'est pas fini). Côté SOURCE : « Renforcement : attend sa réponse », « Renforcement expiré » (sur la ligne de
  l'invitation, « Refaire le code »). Risque accepté écrit dans `SECURITY.md`.
- **Nouveautés** (`js/news.js`, `NEWS_VERSION` = '0.21', préférence `news` du navigateur) : fenêtre en deux écrans (« Nouveautés », neuf points cliquables ; « Vos
  partages », chiffres de ce document : exports, destinataires à renforcer, invitations d'avant les clés à refaire, réceptions à renforcer) ouverte **une fois par
  version et par navigateur**, seulement dans un document déjà installé, pas en lecture seule, jamais par-dessus un assistant (`showNews` de `js/main.js`) ; son
  bouton « Renforcer la sécurité » ouvre l'onglet Envoyer ou Recevoir. À relever (`NEWS_VERSION`, textes `news.*`) à chaque version qui mérite une fenêtre.
  Les essais la **désactivent** (`serveWidget({ news })` de `tests/e2e/shared.mjs` réécrit `newsSeen`) sauf `newsSteps`.
- **Pas couvert, dit** : un Échange d'avant les clés (sa « reprise » tire déjà de nouvelles clés) ; un destinataire en pause (à reprendre d'abord) ; le renvoi de
  contrôle part pour **tous** les destinataires de l'export (ce qu'ils ont déjà est sans effet chez eux) ; les invitations en attente d'avant les clés restent à
  refaire (`codeOld`, comme avant).
- Testé : unit 425 (`engine-reinforce.test.mjs` : états, délai, fin à la première livraison signée, mauvaise signature rejetée même dans le délai, retour arrière,
  remplacement du webhook et de la clé, réponse d'un autre document refusée) ; e2e `ONLY_RENF=1` (vrai Grist : partage rendu « d'avant » à la main des deux côtés,
  suggestion, invitation, ancien envoi accepté pendant l'attente, retour à l'ancien fonctionnement, reprise, approbation, un seul webhook et neuf, clé notée, livraison signée
  reçue, « Partage renforcé », historique) et `ONLY_NEWS=1` (deux écrans, ne revient pas), captures `docs/images/32` à `36`.

## État précédent : V0.20.0 (12 novembre 2026)

V0.20.0 (Antoine, 12 novembre, sur le bouton proposé en 0.15.1 : « ajouter sur la carte de réception un bouton « Ajouter le widget à la page de la table reçue » : oui » ;
et la question « si un même import est multi table avec sous référence il suffit que le widget soit ouvert dans une table pour gérer tous les imports et les mises à jour ? »).
Moteur **4.3.0** (mineure, dite dans `GFS-ETAT.md`).
- **Réponse à la question (relu dans le code, `passAll` de `engine/target/loop.js`)** : oui, **un seul widget ouvert suffit pour tout le document**. Chaque passage (toutes les
  10 s) parcourt tous les journaux (`receivedJournals`), donc toutes les réceptions, toutes les tables d'un export multi-tables et leurs mises à jour ; les tables qui gardent un
  lien (Référence conservée) sont recopiées après celles qu'elles visent ; le widget écrit à distance (`grist.docApi`), il n'a pas à être sur la page de chaque table. **Limites** :
  page du widget ouverte **et visible** (l'iframe est détruite quand la personne change de page), par une personne qui peut modifier le document (pas en lecture seule), accès
  complet accepté ; certains réglages demandent un propriétaire (tables reçues en lecture seule, formules, fichiers d'un Échange). Page fermée, rien ne se perd : le webhook dépose
  les envois dans le journal, recopiés à la prochaine ouverture. Le texte de la fenêtre « Nouvelle table » (0.15.1) était trop strict (« si vous n'ouvrez que cette table, rien
  n'y arrive ») : le vrai risque est de rester sur la page de la table créée, qui n'a pas le widget ; `recv.new.body` et `recv.new.after` sont corrigés (le titre est inchangé, l'e2e l'attend).
- **Le bouton** (`js/target/widget-page.js`, `widgetButton` de `js/target/tab.js`, textes `recv.widget.*`) : sur la carte d'une réception (hors attente du lien et retour d'un Échange),
  « Ajouter le widget à la page de <table> » (« … d'une table reçue » s'il y en a plusieurs : la fenêtre demande laquelle, `pickField`). **Il disparaît dès que le widget est sur la page
  d'une table de la réception** (`widgetCandidates`) ; les emplacements sont relus à l'ouverture de l'onglet, pas à chaque redessin périodique (`readWidgetSpots`). Une fenêtre dit ce qui
  se passe (une section du widget est ajoutée, un seul widget suffit pour le document, Grist demandera l'accès complet) et le résultat reste une minute sur l'onglet (« Widget ajouté à la
  page de X. Ouvrez cette page, puis acceptez l'accès complet dans le panneau de droite… »). Désactivé en lecture seule ; un refus de Grist (droit de structure) s'affiche comme les autres erreurs.
- **Moteur** (`widgetSpots`, `addWidgetToPage` de `engine/pages.js`, `engine/logic/page-widget.js`) : `CreateViewSection(table, page, 'custom')` puis `options` = `{customView: "<JSON>"}` (la valeur est
  elle-même un texte JSON : `{mode:'url', url, access:'none', renderAfterReady:false}`, vérifié). **L'accès n'est jamais accordé par le widget** (`access: 'none'`) : Grist le demande à la
  personne dans son panneau de droite (bulle « Le widget a besoin de full access », Accepter), comme pour une installation à la main, et le widget montre alors `start.access` et `accessHelp()`.
  L'adresse vient de l'écran (`servedAt()` de `js/config.js`, jamais lue par le moteur) ; si une section du document est déjà ce widget, son adresse écrite par la personne est reprise (`sectionUrl`).
  Comparaison d'adresses sans requête, fragment, `index.html` ni barre finale (`widgetAddress`). Sous le verrou `gristsync-widget-page`. Erreurs : `noPageForTable`, `badWidgetUrl`.
- **Vérifié dans un Grist 1.7** : `CreateViewSection` accepte `'custom'` sur la page d'une table existante (la section reçoit `parentKey: 'custom'`, `options` vide) ; ajouter la section à une page
  autre que celle du widget ne recharge pas le widget (`window.sameFrame` dans l'e2e) ; la nouvelle section affiche le message d'accès jusqu'à « Accepter », puis le widget démarre et recopie
  (l'e2e fait la page de la table, le panneau de droite et l'accord, puis une modification de la SOURCE arrive alors que la page Synchro n'est pas ouverte).
- **Limites** : une table sans page n'a pas de bouton (`noPageForTable` si l'appel est forcé) ; la page qui montre la table est la sienne (`destPageViews`) ; un document dont la
  personne ne peut pas lire les métadonnées n'a pas de bouton. SECURITY.md (« Actions de structure ») : une section du widget lui-même, sur clic confirmé, sans accès accordé.
- Testé : unit 427+ (`page-widget`, `engine-widget-page` : ajout sans accès, deuxième clic sans effet, widget d'une autre page, adresse de la personne reprise, refus sans écriture ; le fake de
  Grist gère `CreateViewSection` `'custom'`) ; e2e `ONLY_WIDGETPAGE=1` (`widgetPageSteps`, dans le parcours complet après `cleanSteps`) : une table (bouton, fenêtre, « Annuler » sans effet, section sans accès accordé, widget
  non rechargé, accord dans le panneau de droite, recopie par ce widget), puis une réception de deux tables (la fenêtre demande laquelle, la section arrive sur la page choisie, le bouton
  disparaît). Parcours complet vert (71 étapes) sur le premier commit de la 0.20.0.

## État précédent : V0.19.2 (12 novembre 2026)

V0.19.2 (Antoine, 12 novembre, carte de décision sur le nom du produit puis : « Le produit sera syncPlus pour être cohérent avec le
reste du naming de GFS » ; et sur le point 14 de l'audit de sécurité, « demander à DINUM si les webhooks sont limités à l'instance » :
« oui c'est le cas. sinon il faut écrire de demander à être whitelist »). Moteur **4.2.0** (mineure, dite dans `GFS-ETAT.md`).
- **Nom** : « syncPlus » dans `index.html` (titre de l'onglet et de la barre), `app.title` et `diag.title` (fr et en), `guide.install`
  (« Installer le widget syncPlus »), le tutoriel (`i18n/tutorial.json`, `docs/04`), les deux README ; « Sync+ » remplacé dans la doc de
  développement et les commentaires (une citation d'Antoine gardée telle quelle). Barre du haut mesurée à 700, 420, 380 et 360 px en
  français et en anglais : rien ne déborde. Voir « Conventions d'Antoine » pour ce qui ne change pas.
- **Webhooks limités à l'instance (point 14, clos)** : fait donné par Antoine, DINUM n'est pas joignable depuis une session. Grist ne crée
  un webhook que vers une adresse de la liste `ALLOWED_WEBHOOK_DOMAINS` de l'instance (**vérifié dans Grist 1.7** : `isUrlAllowed` de
  `requestUtils`, liste vide par défaut donc aucun webhook, `*` pour tout autoriser, `http` pour `localhost` seulement) et répond sinon
  `403 {"error":"Provided url is forbidden"}`. **Le widget disait alors « Seul un propriétaire du document peut faire cela » à un
  propriétaire** (`restOf` rendait `ownerOnly` pour tout 403). Maintenant : erreur `webhookForbidden` (`URL_REFUSED` de
  `js/engine/rest-port.js`), texte `error.webhookForbidden` (« cette instance n'autorise pas les webhooks vers sa propre adresse […]
  demandez à l'administrateur de l'instance d'ajouter l'adresse de l'instance à la liste des domaines autorisés »), une ligne de
  dépannage dans le tutoriel du widget et `docs/04`, un paragraphe « Webhooks de l'instance » dans les README, et dans `SECURITY.md`
  (« En bref », « Chaîne d'approvisionnement ») la barrière contre l'exfiltration par webhook d'une copie piégée.
- **Sonde rejouable** : `tests/e2e/tools/probe-webhook-refused.mjs`, sur un second Grist lancé avec `WEBHOOK_DOMAINS=example.com`
  (variable ajoutée à `start-grist.sh`) : le message s'affiche à « Approuver et brancher », aucun webhook n'est créé.
- Corrigé en passant dans `SECURITY.md` : le Renforcé ne fait plus valider les suppressions (retiré en 0.13.4), et le nombre de lignes
  de JavaScript (environ 13 500).
- Testé : unit 416 (`rest-port` : refus de l'adresse contre manque de droits), sonde dans un vrai Grist, e2e complet (70 étapes).
- **Captures refaites** (`CAPTURES=1`, parcours complet vert) : les 41 images de `docs/images`, leurs 10 vignettes du README et les deux images d'aide de
  `img/` montrent la barre « syncPlus » et l'écran d'aujourd'hui (elles dataient de la 0.12.2). Deux captures que le parcours faisait sans qu'elles
  soient au dépôt y entrent : `13b-source-lignes-en-moins`, `31-cible-effacer-historique` (pas encore citées par le tutoriel).

## État précédent : V0.19.1 (12 novembre 2026)

V0.19.1 (Antoine, 12 novembre, après la carte sur la conservation du journal, réponse « Comme aujourd'hui » : « peut-être prévoir côté cible et source un bouton pour
effacer manuellement l'historique et clean les journaux ? »). Moteur **4.1.0** (mineure, dite dans `GFS-ETAT.md`). Aucune purge automatique, tout est sur demande.
- **CIBLE** : bouton « Effacer l'historique » sur la carte de chaque réception (propriétaires, hors « attente du lien »), confirmation qui dit que ça ne se défait pas
  et que l'historique de Grist (Ctrl+Z, « Historique du document ») n'est pas touché. `cleanJournal` (`js/engine/target/clean.js`, `logic/clean.js`) vide `Sync_Avant`
  (états ajout, modif, suppression : l'avant et le numéro des lignes supprimées) et `Synchro_Donnees` de la dernière version des clés `suppression` ou `partie`,
  **rescelle** ces lignes (le sceau couvre les données : sans cela le passage suivant les efface comme forgées, contrôlé par un test qui retire le rescellage), note
  `histo` dans la note du journal (l'historique de la carte ne montre que ce qui arrive après `max(dernière visite, histo)`, `tableResult`). **Rien n'est vidé en Échange**
  (valeurs de comparaison) ni pour un `refus` (avant utile à la correction). Message : « Historique effacé (journal nettoyé : N valeurs d'avant, M lignes supprimées). »
  Les lignes d'ici, les listes, les clés, les heures et les états ne changent pas ; une version en retard ne ressuscite pas une ligne supprimée (testé).
- **SOURCE** : bouton « Effacer l'historique » dans le bloc « Historique des envois » de chaque export (`clearHistory` de `js/source/actions.js`, `clearExportHistory` de
  `js/engine/source/history.js`) : `clearEvents` (`logic/notes.js`) vide la note ; des **repères** `cleared` (ajouts et retraits, sans nom ni nombre) restent parce que
  `vanishedRecipients` (webhook supprimé à la main) et `unkeyedRecipients` (clé de signature perdue, via `hasJoin`) lisent l'historique (`eventsOf(note, id, { all: true })`,
  `ledger` dans `loadState`). Les journaux de retour d'un Échange de cet export sont nettoyés aussi. Les avis de baisse de lignes (`shrink`) partent avec l'historique.
- Testé : unit 415 (`engine-clean.test.mjs` : plan, repères, nettoyage avec recopie ensuite, SOURCE), e2e `ONLY_CLEAN=1` (`cleanSteps`, vrai Grist : annuler ne vide rien,
  confirmer vide l'avant et les valeurs, carte à zéro, recopie suivante sans arrivée suspecte, note SOURCE sans nom).

## État précédent : V0.19.0 (12 novembre 2026)

V0.19.0 (Antoine, 12 novembre : « Peux-tu vérifier si d'autres edge cases comme ça sont possibles ? vérifier toutes les approches possibles qui seraient
exploitées pour tenter d'accéder à la donnée en récupérant des infos mal protégées ? »). Moteur **4.0.0, majeure** (dite dans `GFS-ETAT.md`).
- **Audit offensif** (Grist 1.7.22, sondes rejouables `tests/e2e/tools/probe-surfaces.mjs`, `probe-gaps.mjs`) : 415 routes de lecture de l'API lues par
  un visiteur du lien public, un lecteur nommé, un éditeur nommé et le détenteur de la clé d'un formulaire, sur une SOURCE et une CIBLE branchées.
  **Protégé** (403 ou invisible) : données, SQL, CSV, XLSX, téléchargement, historique, instantanés, webhooks, règles, partages ; la clé d'un formulaire
  n'est lisible nulle part et n'écrit ni métadonnées, ni autre table, ni SQL, ni règles ; l'adresse de l'iframe du widget n'a pas l'identifiant du
  document ; `localStorage` sans secret. **Quatre trous corrigés** :
  1. **Mémo des webhooks** : `_grist_Triggers` se lit en anonyme sur un document public ; le mémo (courriel, document, équipe du destinataire) est
     maintenant un jeton `r-<12 hex>` (`MEMO_TOKEN`), la fiche est dans la note de la SOURCE (`dest`). `rememberDest` (avant `createWebhook`),
     `readHooks()` (remet la fiche), `protectMemos()` (migre les webhooks d'avant, verrou `gristsync-memos`, retire les fiches des partis après 10 min).
  2. **Fenêtre avant les règles** : `Synchro` naissait avec le premier export, ses règles à la fermeture du premier assistant ; entre les deux, une colonne
     cachée par une règle de la personne se lisait dans le lot. `protectSync()` (`js/engine/acl.js`) crée la table vide et pose les règles **avant**
     l'assistant (`syncRules({ force, strict })`, même assistant ouvert) ; le document se recharge et l'assistant se rouvre seul (`askWizard` /
     `wizardAsked` de `js/prefs.js`, une heure de vie, aucune donnée). **Piège** : la préférence se note AVANT `protectSync` (la page se recharge avant qu'il
     ne rende). Un Échange reçu passe par la même étape (`syncUnprotected`, `showProtect` de `js/target/wizard.js`).
  3. **Refus de Grist tu** : une règle d'une personne qui nomme une colonne effacée (« Invalid columns in rules for table X: Y ») fait refuser tout
     changement de règles. `ruleRefusal()` garde le texte, `rulesRefusedNotice` (`js/rules-notice.js`) le montre aux propriétaires, « Nouvel export » est
     bloqué. Le widget ne touche jamais aux règles d'autrui.
  4. **Éditeurs et note de la SOURCE** : la règle de `Synchro` portait une condition de ligne, Grist ne vide les options d'une colonne que pour un refus sans
     condition : un éditeur lisait la note (fiches, clé privée d'une invitation en attente) par les métadonnées. Sans Échange, `ownerAclRules` est un seul
     refus `user.Access != OWNER` → `-CRUD`. Avec un Échange, les cinq règles d'avant restent. **Effet visible** : un éditeur de la SOURCE arrive sur l'accueil
     grisé (comme un lecteur), plus sur l'écran « réservé aux propriétaires ».
- **Effets à dire** : « Nouvel export » sur un document sans protection recharge le document une fois, puis l'assistant se rouvre ; fermer l'assistant laisse
  une table `Synchro` vide (sans ligne) et ses règles, et le widget ne la prend pas pour un rôle (`openFirstScreen` : `Synchro` sans export = accueil à deux tuiles, vu à l'e2e sur la CIBLE) ; un onglet 3.x resté ouvert repose les règles d'avant et réécrit la fiche dans le mémo : recharger.
- **Reste lisible, dit à Antoine** : nom et condition des webhooks (nom et identifiant de l'export) ; note de la SOURCE par les éditeurs d'un document qui
  a un Échange ; note du journal par les éditeurs de la CIBLE et la clé du formulaire (voulu : le secret refait la réponse) ; le journal de la CIBLE
  pendant l'assistant « Recevoir » (environ une seconde, vide). À faire par Antoine : lire sur DINUM, en fenêtre privée, `…/api/docs/<id>/tables/_grist_Tables_column/records`
  et `…/_grist_Triggers/records` d'un document public.
- **Carte de décision « Combien de temps garder les valeurs d'une ligne supprimée dans le journal de la CIBLE ? »** : répondue le 12 novembre,
  **« Comme aujourd'hui »** (aucune purge automatique, rien de codé). Antoine a ajouté : « peut-être prévoir côté cible et source un bouton pour effacer
  manuellement l'historique et clean les journaux » (voir l'état suivant si codé).
- **Deux correctifs trouvés à l'e2e complet** : `createSyncTable` retire `manualSort` dans la même action que `AddTable` (sinon deux onglets, l'écran qui s'affiche
  et l'assistant qui crée l'export, la retirent chacun et le second reçoit « No such column: Synchro.manualSort ») ; `run` (`js/ui.js`) n'écrit qu'un avertissement
  pour une requête coupée par le rechargement du document (`unreachable`, aussi employé par `select`).
- Testé : unit 411 (`engine-protect`, `engine-memo`, `acl`) ; e2e complet, `ONLY_PROTECT=1` (règles avant la première ligne, refus d'une règle orpheline
  dit et « Nouvel export » bloqué, Échange avec l'étape de protection, mémos opaques lus en anonyme). Le test de la SOURCE vérifie maintenant que `Synchro` est
  vide avec ses règles avant la fin de l'assistant (avant : « rien d'écrit »).

## État précédent : V0.18.0 (12 novembre 2026)

V0.18.0 (Antoine, 12 novembre : « peux-tu regarder dans un document partagé en lecture seule mais public via lien […] si un user qui arrive sur le
lien voit les tables gérées par le widget (côté cible et source) » ; carte de décision « Comment corriger la fuite des notes du widget sur un
document public ? » : **« Notes à l'abri, complet »**). Moteur **3.0.0, majeure** (dite dans `GFS-ETAT.md`).
- **Constat vérifié** (Grist 1.7.22, requêtes anonymes, navigateur sans compte, lecteur nommé, éditeur nommé ; sonde rejouable
  `tests/e2e/tools/probe-public.mjs`, `STRICT=1`) : les lignes et colonnes de `Synchro` et d'un journal réservé sont cachées partout (tables,
  enregistrements, SQL 403, CSV, XLSX, téléchargement, historique, Code view, données brutes) ; les règles d'accès, les partages et la liste des
  webhooks sont réservés aux propriétaires ; **la clé d'écriture d'un formulaire n'est lisible nulle part**. **Mais** `GET
  /api/docs/<id>/tables/_grist_Tables_column/records` (anonyme) rendait les notes du widget : Grist (`CensorshipInfo`, `GranularAccess.js`) vide
  `label`, `colId`, `widgetOptions`, `formula`, `type` d'une colonne illisible, **pas `description`**. Fuyaient : courriel du destinataire, documents,
  exports, nombre de lignes, clé privée d'une invitation en attente, secret d'invitation, clés publiques, **clé de signature** (description de `id_sync`).
  Rien d'écrit n'était possible sans la clé du formulaire.
- **Correction** : les notes sont dans les **options** de la colonne (`widgetOptions`, clé `syncNote`, `columnNote` / `noteAction` de
  `logic/common.js`) : `Synchro_Export` (SOURCE), `Synchro_Ids` du journal, `id_sync` des tables reçues (clé de signature). Lecture : options d'abord,
  description d'avant ensuite ; écriture : options (autres clés gardées), description d'une note d'avant vidée, description écrite à la main jamais touchée.
  `moveNotes` (`engine/note-move.js`, `logic/note-store.js`) déplace les notes d'un document d'avant, sous le verrou `gristsync-note-move`, en relisant
  le schéma avant d'écrire (une note déjà déplacée puis changée n'est pas remplacée par sa copie d'avant) : appelé par `ensureSyncTable` (SOURCE) et par
  `passAll` (CIBLE, sauf page en lecture seule). Une note déjà dans les options fait foi, la description d'avant revenue (version plus ancienne restée
  ouverte) est seulement vidée. **Règle d'accès de plus** : `keyAclRules` (mémo `KEY_MEMO`, « Synchro : clé de signature cachée aux lecteurs »),
  `-R` pour `user.Access == VIEWER` sur la colonne `id_sync` des tables que `signedTables` trouve (clé de signature présente), posée par `syncRules`.
- **Vérifié** : la sonde ne trouve plus ni clé de signature, ni clé privée, ni secret, SOURCE et CIBLE ; l'e2e lit les métadonnées en anonyme sur les deux
  documents (`noteLeaks`) ; la clé du formulaire lit toujours la note du journal (par ses colonnes : c'est voulu, voir SECURITY.md).
- **Reste lisible, dit à Antoine** (le mémo des webhooks a été mis à l'abri en 0.19) : le mémo des webhooks (`_grist_Triggers` : courriel du destinataire · document · équipe/nom) et leur condition
  (identifiant de l'export) ; le journal d'une réception dont la case « réservé aux éditeurs » est décochée. Mises à niveau : un onglet resté ouvert sur
  le moteur 2.x ne lit pas les notes déplacées (il les croit vides et pourrait les réécrire) : recharger. À vérifier par Antoine sur DINUM : lire
  `…/api/docs/<id>/tables/_grist_Tables_column/records` d'un document public dans une fenêtre privée.
- Testé : unit 400 (`note-store`, `engine-note-store` : écriture dans les options, déplacement SOURCE et CIBLE, schéma lu trop tôt, description d'avant
  revenue, règle posée et retirée ; `acl`, `common`, `received`) ; e2e complet (lecture anonyme des métadonnées SOURCE et CIBLE).

## État précédent : V0.17.0 (12 novembre 2026)

V0.17.0 (Antoine, 12 novembre : « également prévoir de pouvoir sync les formules. c'est du python mais très très controlé dans grist (pas d'appel
externe etc.) donc peu de risque, par contre une case à part et un message qui demande si l'user est sûr de le vouloir avec les risques de passer du
python » ; carte de décision « Quand la CIBLE applique-t-elle les formules envoyées par la SOURCE ? » : **« Sur clic d'un propriétaire »**). Moteur
**2.9.0** (mineure, dite dans `GFS-ETAT.md`).
- **Fait vérifié dans un Grist 1.7 (image Docker officielle) qui contredit « très contrôlé »** : une formule de colonne a pu `import os` et lister les
  fichiers du serveur (`os.listdir("/")`) ; l'image n'a pas de bac à sable renforcé par défaut. La protection dépend de l'instance
  (`GRIST_SANDBOX_FLAVOR`) : à vérifier auprès de l'administrateur de DINUM avant de proposer la case aux utilisateurs. Dit à Antoine, écrit dans
  `SECURITY.md` (« Formules de colonne ») et au moteur (`README`, `GFS-ETAT.md`). Aussi vérifié : `ModifyColumn` (`isFormula`, `formula`) transforme une
  colonne de données en colonne de formule, garde le type et calcule les valeurs ; une formule qui cite une colonne absente ou qui a une faute de syntaxe
  est acceptée par Grist (cellules en erreur, `null` par l'API) : le widget doit donc lire les formules avant, Grist ne les refuse pas.
- **SOURCE** (`js/engine/logic/column-formulas.js`) : case « Envoyer aussi les formules des colonnes (Python) », **hors du repli** des autres éléments,
  **décochée d'emblée** (même pour un nouvel export), grisée s'il n'y a aucune colonne de formule, avec le nombre de colonnes concernées ; cocher ouvre une
  fenêtre (« Envoyer aussi les formules ? », cinq points : rien ne se pose seul, le destinataire exécute le code chez lui, ce qui est refusé d'office, le bac à
  sable dépend de l'instance, une formule lourde ralentit) ; « Annuler » laisse la case décochée. Part dans la description signée des colonnes : `fx` sur chaque
  colonne (texte, vide pour une colonne qui n'est pas une formule : la clé dit que l'export les envoie). Seules les **vraies colonnes de formule** partent
  (`isFormula`) : ni formule de déclenchement, ni Référence, ni Pièces jointes (elles partent comme du texte ou des fichiers) ; nettoyées (`cleanFormula` :
  pas de caractère de contrôle ni de sens d'écriture, indentation gardée), 1 500 caractères par formule et 20 000 par table, **jamais coupées** (une formule
  trop longue ne part pas). Hors de `withoutOpts` (changer une formule ne renvoie aucune ligne), tenues à jour par `optionsActions`. Jamais en Échange.
- **CIBLE** (`js/engine/target/formulas.js`, `planFormulas`) : **un passage ne pose jamais une formule** ; il les lit et met `formulas` dans le résultat de la
  table (`state.results`, `tableResult`), une ligne par formule `{ id, to, label, formula, state ('data' | 'other' | 'same'), problems, ok }`. Aucun état de plus
  dans la note (l'état se lit dans la destination). `entry.sends` contient `'formulas'` quand une formule au moins est envoyée. « Reprendre depuis la SOURCE »
  (`js/target/restyle.js`, `restyleDialog`, 720 px) : la case « Formules » est **à part, décochée, réservée aux propriétaires** (un éditeur lit « se pose par un
  propriétaire »), grisée quand rien n'est à poser ; la cocher montre le message, la liste par table (colonne, état, texte Python, objections) et une case
  **« J'ai lu ces formules… »** sans laquelle « Reprendre » reste grisé. `restyle(journal, { formulas: true })` pose les formules sans objection
  (`ModifyColumn`) sur les colonnes **créées par le widget** (`own`) : jamais sur une colonne qui existait déjà, sur `id_sync`, ni en Échange. La colonne
  devient une colonne de formule : `copyColumns` ne l'écrit plus (Grist refuserait, 500 « Can't save value to formula column »), Grist la calcule.
- **Lecture avant pose** (`formulaProblems`, garde-fou et non preuve) : refus d'office d'un mot interdit hors des textes et commentaires (`eval`, `exec`,
  `open`, `getattr`, `os`, `sys`, `subprocess`, réseau, fichiers… ; `stripStrings` garde le contenu d'un f"…", où Python exécute les accolades), de tout nom à
  doubles tirets bas (partout, texte compris : `"{0.__class__}".format(x)`), de tout `import` hors de `SAFE_MODULES` (quinze modules de calcul, de dates et de
  texte, même derrière un `;` ou un `:`), d'une colonne citée (`$Col`, `rec.Col`) absente d'ici ou renommée (`renamedCol`), d'une table citée
  (`T.lookupRecords`, `.lookupOne`, `.all`) qui n'est pas une table de l'export ou y a changé de nom. Le texte n'est **jamais réécrit** (Python ne se réécrit pas à
  l'aveugle). Une colonne qui existait déjà : objection `notOwn`.
- Testé : unit 386 (`engine-formulas.test.mjs` : envoi sans et avec la case, lecture sans pose, pose sur clic, valeur non recopiée dans la colonne de formule,
  reprise idempotente, formule changée à la SOURCE, colonne non créée par le widget, Échange, nettoyage, plafonds, 40 cas de lecture) ; e2e `ONLY_FORMULAS=1` dans un
  vrai Grist (`formulasSteps` : case à part et message, « Annuler », liste et objection « os », bouton grisé jusqu'à « J'ai lu », TVA calculée par Grist, ligne
  de plus reçue sans erreur, case décochée dans « Modifier » ; `SHOTS=<dossier>` fait deux captures).
- **Pas fait, dit à Antoine** : une formule qui cite une colonne ou une table renommée n'est pas réécrite (la personne la corrige à la main) ; les règles de
  mise en forme restent reconstruites par leur grammaire fermée (`rules.js`), jamais copiées ; les formules de déclenchement ne partent pas.
- **Piège vu à l'e2e, cause trouvée le 12 novembre (V0.18.0)** : le parcours complet échouait parfois dans `docLinkSteps` (`dialogButton('Annuler')` ou
  « Nom de ce document » introuvable, la fenêtre « Ajouter un destinataire » avait disparu). **Cause** : sur un document neuf, `syncRules` ne pose jamais les
  règles d'accès de `Synchro` pendant un assistant ; elles le sont au premier dessin qui suit la fermeture du premier assistant (« Plus tard »), et Grist recharge
  alors le document, donc le widget, environ 250 ms après (mesuré : règles 1 → 6 à +150 ms, nouvelle iframe à +270 ms, **déjà ainsi sur la 0.17.0**). Un clic donné
  dans ces 250 ms (« Ajouter un destinataire » juste après « Plus tard ») est perdu, ou sa fenêtre disparaît. Pas un défaut du widget (comportement voulu : une
  personne qui clique si vite revoit simplement l'écran), mais une course du test : `rulesSettled(doc)` de `run.mjs` attend les règles puis 1,5 s sans navigation de
  l'iframe. À employer avant tout clic qui suit la fermeture du premier assistant d'un document neuf, quand le test reste sur la même page. Une boucle de
  25 minutes d'inactivité du conteneur coupe les processus de fond (e2e) : garder le tour actif (commande avec `timeout` dans une boucle d'attente) pendant un
  parcours complet.

## État précédent : V0.16.1 (12 novembre 2026)

V0.16.1 (Antoine, 12 novembre : « est-ce que les éléments de mise en forme des colonnes pourraient être repris aussi (à la demande) » ; « plus
globalement, regarde tous les éléments qu'il serait bien de reprendre, inspire-toi du widget import/export de table »
(`lombre33/Grist_Table_structure_import`, lu en lecture seule). Carte de décision « Jusqu'où étendre ce qui est repris de la SOURCE ? » :
**Descriptions + sélecteur d'éléments** (la mise en forme à la demande existait déjà, voir la 0.16.0). Moteur **2.8.0** (mineure, dite dans `GFS-ETAT.md`).
- **Descriptions** (`js/engine/logic/descriptions.js`, `target/describe.js`) : `desc` (description de chaque colonne, vide si elle n'en a pas : la clé
  dit que l'export l'envoie) et `tdesc` (description de la table, sur la première colonne) dans la description signée des colonnes ; nettoyées et
  bornées (`cleanNote` : pas de caractère de contrôle ni de sens d'écriture, 300 et 500 caractères). Hors `withoutOpts` : changer un texte ne renvoie
  aucune ligne ; `refreshOptions` réécrit la description des colonnes quand un texte change (et lit `_grist_Views_section` seulement si un export
  envoie `tdesc`). **Vérifié dans un Grist 1.7** : la description d'une table est celle de sa **section de données brutes**
  (`_grist_Tables.rawViewSectionRef` → `_grist_Views_section.description`, `UpdateRecord` ; la page « Données brutes » la montre dans une infobulle) ;
  `AddColumn` **ignore** `description` (il faut `ModifyColumn` ou `UpdateRecord` sur `_grist_Tables_column`) ; **écrire une valeur dans une colonne formule
  est refusé** (500 « Can't save value to formula column », utile pour les formules à venir).
- **CIBLE** : comme pour les formats, seules les colonnes créées par le widget (`own`) reçoivent la description, une fois (`entry.described`) et
  seulement si elles n'en ont pas ; la table la reçoit quand la sienne est vide (`entry.tabled`) ; une description retouchée ou effacée ici n'est pas
  refaite. Jamais sur `id_sync` (sa description est la note du widget), jamais en Échange. `entry.sends` (`style`, `notes`, `table`) dit ce que l'export
  envoie (marque `fmt` gardée par `exportSchema`).
- **Sélecteur d'éléments** : à l'étape Colonnes de l'assistant d'export, une ligne repliée « Envoyé avec les colonnes : … » (`elementsBlock`, remplace
  la case `styleBlock`) ouvre trois cases (mise en forme, descriptions des colonnes, descriptions des tables), cochées d'emblée pour un nouvel export,
  telles que l'export l'est pour un export modifié, chacune avec le nombre de colonnes ou de tables concernées (`elementCounts`). Côté CIBLE, le bouton
  « Reprendre depuis la SOURCE » (ancien « Reprendre la mise en forme ») ouvre une fenêtre à une case par élément que l'export envoie
  (`restyle(journal, { style, notes, table })`) ; le bouton n'apparaît que si l'export envoie quelque chose.
- Testé : unit 368 (`engine-notes.test.mjs` : envoi, application, retouche gardée, mise à jour sans renvoi, reprise par élément, texte nettoyé, `planNotes`) ;
  e2e `ONLY_FORMAT=1` (vrai Grist : les trois cases, les descriptions arrivent, retouche gardée, reprise élément par élément, cases décochées).
- **Pas repris, par choix** (triage dit à Antoine) : formules et formules de déclenchement (demandées ensuite, voir plus bas si codées), liens
  bidirectionnels, règles d'accès, tables de résumé, tri / filtres / graphiques / mise en page des vues. Réglages de la vue modèle (largeurs, ordre
  des colonnes, règles par vue) : option écartée par Antoine, à vérifier dans un vrai Grist avant tout.
- **Formules** (Antoine, 12 novembre, après la carte : « également prévoir de pouvoir sync les formules […] une case à part et un message qui demande
  si l'user est sûr de le vouloir avec les risques de passer du python »). Carte de décision posée : quand la CIBLE applique les formules (sur clic d'un
  propriétaire — recommandé —, à l'acceptation, ou dès l'envoi). **Répondue le 12 novembre : « Sur clic d'un propriétaire »** ; codé en V0.17.0 (voir plus haut).

## État précédent : V0.16.0 (11 novembre 2026)

V0.16.0 (retour d'un utilisateur, relayé par Antoine, 11 novembre : « une page de budget à dupliquer, le style est américain (USD par
défaut) et, quand je passe en Euro, le style d'écriture reste américain » ; Antoine : « il faudrait rajouter une option pour que ça
push aussi tous les paramètres de colonnes (mise en forme, mise en forme conditionnelle etc.) »). Moteur **2.7.0** (mineure, dite dans
`GFS-ETAT.md`). Trois cartes de décision posées à Antoine (sens de la reprise, langue du document, règles conditionnelles) : voir plus
bas ce qui a été codé en attendant, et la mémoire du projet pour les réponses.
- **Cause (vérifiée dans un Grist 1.7 réel)** : l'écriture des nombres et la devise par défaut viennent des **réglages du document**
  (`_grist_DocInfo.documentSettings` : `locale`, `currency`, `engine`), pas des options de la colonne. `getCurrency(options, docSettings) =
  options.currency || docSettings.currency || localeCurrency(docSettings.locale)` : une colonne « Monnaie » sans `currency` prend celle
  du document. Les `widgetOptions` copiés par le widget (0.12) ne portaient donc pas la devise d'une colonne qui n'en avait pas, et un
  document créé en en-US reste en USD. Choisir l'euro dans la colonne fixe la devise, **pas** la langue (séparateurs).
- **SOURCE** : case « Envoyer la mise en forme des colonnes » (étape Colonnes, `styleBlock`, cochée d'emblée pour un nouvel export, telle
  que l'export l'est pour un export modifié, absente en Échange). Chaque colonne porte `fmt: true` dans la description signée des
  colonnes (`Synchro_Colonnes`) ; la première porte `doc` (`{ locale, currency? }`, validé par `docFormat`). Les options envoyées en plus :
  en-têtes (`headerFillColor`, `headerTextColor`, `headerFontBold`…), alignement, couleurs, **monnaie résolue** (la devise de la langue du
  document quand la colonne n'en a pas : `currencyOf`) et `rules`. `fmt` et `doc` sont retirés de `withoutOpts`, donc cocher ou décocher
  ne renvoie aucune ligne. Un export sans `fmt` envoie exactement la description d'avant (essai `engine-format`, garde de formules
  `formulas-golden` inchangée).
- **Règles de mise en forme conditionnelle** (`js/engine/logic/rules.js`) : sécurité d'abord, une règle est une formule Python. Elle n'est
  **jamais copiée** : `parseRule` la lit par une grammaire fermée (et/ou/non, comparaisons, `in` avec liste littérale, `is None`,
  `+ - * /`, `TODAY()`, `$Col`/`rec.Col`, nombres, textes courts propres ; 300 caractères, 60 nœuds, profondeur 12), `printRule` la
  réécrit avec les noms de colonnes de la CIBLE (précédence respectée, parenthèses seulement où il faut), tout le reste est abandonné ;
  une colonne qui n'existe pas ici fait tomber la règle. Dix règles par colonne au plus. Côté SOURCE, les règles sont lues dans les colonnes
  cachées `gristHelper_ConditionalRule…` de la colonne (`rules` : RefList) et dans `rulesOptions` ; les règles « par vue » ne sont pas reprises.
- **CIBLE** (`js/engine/target/style.js`, `logic/received.js`) : pour les colonnes **que le widget a créées** (`entry.own`), l'en-tête, la
  devise et les couleurs viennent avec les options de la colonne (`addDestColumnsActions`, extras) ; les règles sont posées en deux temps
  (`AddEmptyRule` rend le nom de la colonne cachée, puis `ModifyColumn` écrit la formule et `UpdateRecord` les styles dans `rulesOptions`),
  avec retrait des colonnes cachées déjà créées si le second temps échoue. Décidé **une fois** par colonne (`entry.styled`) : une retouche
  d'ici, une règle effacée ici ne sont pas refaites. Bouton « Reprendre la mise en forme » (carte, hors Échange et attente) : `restyle(journal)`
  remplace options et règles par celles de la SOURCE, après confirmation. L'entrée garde aussi `sourceDoc` (langue et devise de la SOURCE).
- **Langue du document** (`logic/docformat.js`, `formatNotes` de `js/target/tab.js`) : un avis d'information quand la langue ou la devise de
  la SOURCE diffère de celles d'ici (`formatGap`) ; un **propriétaire** peut cliquer « Régler le document comme la SOURCE », après une
  confirmation qui dit que tout le document change d'écriture (`alignDocFormat` : `locale` et `currency` seulement, `engine` gardé ; une
  devise explicite d'ici est retirée si la SOURCE n'en a pas). **Aucun passage ne règle le document tout seul.** Ctrl+Z défait.
- **Piège vu en préparant** : la clé `rules` d'une colonne est une RefList (`['L', ref…]`) vers des colonnes cachées ; `RemoveColumn` d'une
  colonne cachée la retire de la liste (vérifié) ; `AddColumn` d'une règle par l'API serait plus fragile qu'`AddEmptyRule`. Une règle
  par vue (champ) n'est pas dans la colonne : non reprise, dit dans l'aide de la case.
- Testé : unit 354 (`rules`, `engine-format` : SOURCE fr-FR vers CIBLE en-US sur deux Grist en mémoire, règle piégée écartée, retouche
  gardée, reprise, langue réglée sur geste ; `robustness` : tirage de règles et de réglages abîmés, point fixe de la réécriture) ; e2e
  `ONLY_FORMAT=1` (`formatSteps`, vrai Grist 1.7) : réception de `1 234,50 €` avec en-tête, devise euro et règle rouge sur la ligne
  négative, avis de langue, « Annuler » ne règle rien, clic confirmé règle `fr-FR` sans toucher `engine`, retouche (USD, règle retirée)
  gardée, « Reprendre la mise en forme » sans doubler la règle, case décochée dans « Modifier ».
- Cartes de décision, **les trois répondues par Antoine le 12 novembre, toutes sur l'option recommandée, donc ce qui est codé** : reprise
  « Compléter + bouton Reprendre » (colonnes créées par le widget seulement, retouche gardée, bouton « Reprendre la mise en forme ») ;
  règles conditionnelles « Règles simples, reconstruites » (grammaire fermée, jamais de formule copiée) ; langue et devise du document
  « Bouton, propriétaires seulement » (jamais réglées par un passage). Écartés, au cas où : suivre la SOURCE en continu (option de la CIBLE
  levant `styled` à chaque changement), réglage à l'acceptation (case de l'assistant CIBLE appelant `alignDocFormat`), pas de règles (vider
  `sentRules` côté SOURCE).

## État précédent : V0.15.3 (11 novembre 2026)

V0.15.3 (Antoine, 11 novembre : « avant la sortie de la v2 peux tu si c'est pertinent faire audit et correction en ui/ux, sécurité, et
qualité du code/refacto ? […] + Gw audit »). Rapport : Claude Doc « Audit avant la Bêta (V0.15.3) : sécurité, code, UI/UX, gwaudit » ;
pièces dans `/mnt/project-files/notes/audit-v2/` (captures, rapports gwaudit avant et après, `ux-audit.mjs`). Moteur **2.6.1**
(correctif : rien d'ajouté ni de retiré au port, aux tables, aux codes ; texte des formules inchangé ; dit dans `GFS-ETAT.md`).
- **Sécurité** : rien de nouveau sur le fil. Recontrôlé sur le code final : ni `innerHTML` ni `eval` dans `js/`, un seul `fetch`
  (`gristFetch`, `credentials: 'omit'`), `localStorage` dans `js/prefs.js` seul, aucune dépendance. Essai de robustesse
  (`tests/unit/robustness.test.mjs`, graine fixe) : des versions abîmées de lots, listes, notes, codes et messages d'un autre onglet
  passent dans les fonctions de lecture ; seule `addEvent` levait (historique de note qui n'est pas une liste), corrigée.
  `SECURITY.md` (« Ce que le widget écrit et garde ») liste les **actions de structure** ; hors de ses tables et colonnes, le widget ne
  renomme et ne supprime que sur un clic, après une fenêtre (table `Synchro` faite à la main, colonnes en trop dans `Synchro`).
- **Code** : fonctions d'écran découpées sous les seuils de gwaudit (80 lignes, complexité 15), sans rien changer à l'affichage :
  `parseMessage`, `createLink` (`js/tab-link.js`), `sourceView`, `tickFlows` (`js/source/tab.js`), `receivedGroups`, `renderTarget`,
  `cardNotes` (`js/target/tab.js`). Variables d'une lettre ou `data` renommées (moteur compris). Mesure sur tout `js/`
  (`GWAUDIT_DIR=<dépôt de l'outil> node tests/tools/mesure-moteur.mjs js`) : 78 fichiers, 2 486 fonctions, plus grande 79 lignes,
  complexité 15 au plus.
- **Essais, un seul texte par outil** : `tests/e2e/shared.mjs` (`serveWidget({ env, port, adjust })` : le widget servi en local, un
  essai y change une constante par `adjust` ; `docTools` : document avec le widget posé, formulaires publiés, clé et lien du
  formulaire), employé par `run.mjs`, `harness.mjs` et `tools/` ; `tools/probe.mjs` (`startProbe`) pour les sondes ; dans le
  harnais : `shootPage`, `openTab`, `editExport` ; dans `charge.mjs` : `settledPair`, `twoRecipients`, `changeFive`, `sourceCard` ;
  dans `run.mjs` : `returnInvitation`, `pasteInvitation`, `attachmentTools` ; `fakePair(tag)` de `tests/unit/engine-fake.mjs`.
- **Piège vu à l'e2e** : la barre d'onglets est dans `index.html`, elle paraît avant que les modules du widget soient chargés ; un
  clic d'onglet donné à ce moment n'est entendu par personne (les écoutes sont posées par `start()`), et le premier écran reste
  affiché. Un essai qui ouvre la page puis un onglet passe par `pickTab` (`shared.mjs` : l'onglet est recliqué tant qu'il n'est pas
  choisi ; `openWidgetTab` dans `run.mjs`, `openTab` du harnais). Côté widget, rien de changé : une personne qui clique un onglet
  dans la demi-seconde du chargement doit recliquer (correction possible : onglets grisés tant que le widget n'écoute pas ; non
  faite, changement visible).
- **UI/UX** (0 violation axe sur les écrans parcourus par `ux-audit.mjs`) : barre du haut qui débordait à 380 px en français
  (resserrée sous 420 px), boutons `.btn-small` de 24 px de haut, phrase « Mise à jour automatique » courte (le rythme en
  infobulle). Constats 11 et 12 de l'audit 0.13.1 clos ici, 13 et 14 l'étaient (carte « incomplet » depuis la 0.12.4, « Réception
  supprimée » depuis la 0.15.1). **Reste le 15, nom du produit** (« Synchro », « Sync », « Synchro Grist », « syncPlus ») : carte de
  décision posée à Antoine le 11 novembre, à appliquer selon sa réponse (titre fr et en, README, tutoriel, diagnostic ; revoir la
  barre du haut à 380 px).
- **gwaudit : 87 puis 89/100** (A 97, B 97, C 61, D, E, F 100). Le 93 de la V0.12.1 ne se compare pas : l'outil a depuis une règle
  majeure de plus, **C-GRIST-04** (toute écriture de structure), que la documentation ne lève pas. Restent, structurels : C-GRIST-03,
  C-GRIST-04, C-EXFIL-02, C-STOCK-01, B-VERB-01 (plus de 8 000 lignes), et trois blocs A-DUP-01 (dont la liste d'exports de
  `js/engine/port.js`, faux positif de l'outil).
- **Lancer l'e2e sans geler le dépôt** : `git worktree add /tmp/e2e-tree <commit>`, y copier `tests/e2e/.env.json` et y lier
  `node_modules/playwright` ; le parcours complet (55 étapes, une vingtaine de minutes) tourne là pendant qu'on travaille ici.
- Testé : unit (340), e2e complet (55 étapes, vert sur la version finale), `charge.mjs` (`smoke`, `doublons`, `destinataireMort`), un
  scénario de `betises.mjs`.

## État précédent : V0.15.2 (10 novembre 2026)

V0.15.2 (Antoine, 10 novembre : « l'url du document source/cible ne fonctionne pas car le nom du document est dans l'URL. Est-ce que tu peux
récupérer l'url de la page via le navigateur par ex ? »). Moteur **2.5.0** (mineure, dit dans `GFS-ETAT.md`).
- **Récupérer l'adresse de la page est impossible** : le widget est une iframe d'une autre origine, il ne lit ni `window.top.location`
  ni `document.referrer` autrement que par l'origine (voir 0.13.5). Il ne connaît de son document que l'identifiant et l'équipe
  (`getAccessToken().baseUrl`) ; de l'autre, ce que la fiche de partage (`shareInfo`) ou l'invitation (`from`) disent.
- **Vérifié dans un Grist 1.7 réel** (sondes en Playwright, document connecté en propriétaire) : `/o/<équipe>/doc/<id>`, `/o/<équipe>/<id>`,
  `/o/<équipe>/<id12>/<nom>`, avec un mauvais nom ou « document » : **toutes ouvrent le document**, et Grist remplace le nom par le sien
  (le nom n'est donc pas indispensable ici). **Mais sans la bonne équipe** (aucune, `/o/docs/` pour un document d'équipe, équipe
  inconnue) : « Page non trouvée ». L'équipe est la pièce qui compte. Cause exacte de l'échec sur DINUM **non reproduite** (DINUM n'est pas
  joignable depuis la session) : l'adresse est donc refaite comme Grist l'écrit lui-même, et le retour du porteur dira si cela suffit.
- `docUrl(origin, team, docId, name)` (`logic/codes.js`) : `<instance>[/o/<équipe>]/<id>/<nom>` (`docSlug` : lettres et chiffres sans
  accent séparés par des tirets, 80 caractères au plus ; « document » sans nom ; identifiant de moins de 12 caractères : `/doc/<id>`). Un
  espace personnel `docs-<numéro>` (domaine que la fiche d'un document donne pour l'espace personnel de son propriétaire) s'écrit
  `docs`, comme Grist l'écrit (`normalizeOrgDomain`, grist-core) : `/o/docs-5/…` ne s'ouvre que pour le numéro 5, `/o/docs/…` pour toute
  personne qui a accès au document. Les appelants donnent le nom connu : `from.docName` (CIBLE), `share.name` (fiche de réponse),
  nom du mémo ou lu au contrôle horaire (`hookDoc`).
- Testé : unit (`docUrl`, `docSlug`, `hookDoc`) ; e2e `ONLY_DOCLINK=1` : les liens ont la nouvelle forme et **le clic ouvre vraiment le
  document** (le titre de l'onglet est le nom du document ; avant, seul le début du chemin était contrôlé, et Grist rétablissait tout
  seul une forme cassée).
- Dit à Antoine : si le lien ne marche toujours pas sur DINUM, il faut l'adresse qui marche (copiée dans la barre) et celle du lien
  (survol), masquées, pour voir ce qui diffère (équipe ?).

## État précédent : V0.15.1 (10 novembre 2026)

V0.15.1 (Antoine, 10 novembre, côté CIBLE : « si l'user fait "nouvelle table" le widget ne sera pas dans cette table là : pas de
sync s'il n'ouvre pas la table/vue où il l'a mis ? » ; « hyper important de l'indiquer en pop-up » ; « la table journal en dessous
de la table dans le menu de gauche » ; « si on supprime la table de réception et la table journal le widget est réinitialisé sans
message »). Moteur **2.4.0** (mineure, dit dans `GFS-ETAT.md`).
- **Fait établi (code, étude `docs/01`, `GristDoc.ts:860-883`)** : le webhook dépose chaque envoi dans le journal de la CIBLE sans
  le widget, page fermée ; seule la recopie dans les tables de destination demande la page du widget ouverte et visible par un
  éditeur (toutes les 10 s, `startAutoConsolidation`). Grist **détruit l'iframe du widget quand on change de page** : le choix
  « Nouvelle table » ne change rien en soi (le widget écrit à distance par `grist.docApi`), mais la table créée a sa propre page
  (`AddTable`), sans le widget : qui reste dessus ne recopie rien. L'état du widget est **dans le document** (tables, notes de
  colonnes) : une seconde instance du widget, posée sur la page d'une autre table, montre et recopie toutes les réceptions ; rien
  à « copier d'un widget à l'autre ».
- **Avertissement « Nouvelle table »** (`confirmNewTables`, `js/target/dest.js`) : à l'étape Destinations, avant toute écriture,
  et dans la fenêtre d'une table ajoutée par la SOURCE (`offerDialog`) : titre, pourquoi (le widget n'y sera pas, il ne recopie que
  page ouverte), le conseil sûr (créer la table d'abord, y poser le widget, refaire la procédure depuis cette page) et l'autre voie
  (continuer puis poser le widget sur la page de la table). `confirmDialog` accepte un corps en plusieurs blocs et un bouton
  neutre (`kind`). Textes `recv.new.*`. L'e2e confirme à chaque table neuve (`confirmNewTable` de `run.mjs`, aussi dans
  `harness.mjs`).
- **Page du journal sous la table** (`placeBelow`, `destPageViews` de `logic/page-order.js`, `placeForm` de `pages.js`) : à la
  création du formulaire seulement, `ensureForm(journal, { below })` met sa page juste sous la plus basse des pages des tables qui
  reçoivent, après leurs sous-pages, au même niveau (`pagePos` intermédiaire et `indentation`, vérifié dans Grist 1.7 : `UpdateRecord`
  sur `_grist_Pages`). Une page que la personne a rangée n'est jamais déplacée. Avec une table neuve, la page est déjà dessous (créée
  juste après) : le gain est pour une table existante. **Le menu « Données source »** (page des tables brutes) est **alphabétique**
  (vérifié) : le journal y reste entre les J, `Journal_<export>` ne s'y range pas sous une table.
- **Réception supprimée** (`logic/lost.js`, `target/lost.js`, `lostCard` de `target/tab.js`, textes `recv.lost.*`) : le journal
  porte tout ce que le widget sait ; effacé (avec ou sans la table reçue), le widget repartait de zéro sans rien dire. **Vérifié dans
  Grist 1.7** : la ligne de `_grist_Shares` du formulaire survit à `RemoveTable` (la page part, le partage reste) et sa colonne
  `description` est libre. Le widget y note `{"syncPlus": {journal, name, dests}}` (`receptionMark`, jamais un secret ni une clé) à la
  création du formulaire (`ensureForm(…, { note })`) et, pour les réceptions d'avant, au passage d'un propriétaire sur l'onglet
  (`markReceptions`, aussi quand une table est rangée plus tard). `lostReceptions` : une marque dont le journal n'existe plus ;
  la carte « Réception supprimée : <export> » dit ce qui reste des tables, que la SOURCE ne le sait pas (envoi en échec, pause
  d'office), Ctrl+Z / « Historique du document », sinon révoquer et réinviter. « Retirer cet avis » (propriétaire) efface le
  partage, donc l'ancienne clé d'écriture. Un document sans autre réception ouvre sur Recevoir (`openFirstScreen`). **Limites** :
  pas de marque pour un lien public (pas de formulaire) ni pour le journal de retour d'un Échange ; seuls les partages lisibles par
  la personne comptent (un non-propriétaire peut ne rien voir).
- **Option `arrange` de `createReception`** : faux par défaut dans le moteur (GFS garde sa mise en page) ; l'écran de syncPlus le pose.
- Testé : unit `page-order` (placement, sous-pages, déjà dessous), `engine-lost` (arrange, marque sans secret, journal puis table
  supprimés, avis retiré, journal recréé, `markReceptions`) ; e2e : avertissement (texte, « Annuler » ne crée rien, confirmation),
  page du journal juste sous `Contacts`, partage marqué et toujours publié ; `betises.mjs` : `journalSupprime` et
  `journalEtTableSupprimes` (carte, bouton « Retirer cet avis »).
- **Proposé à Antoine, accepté et codé en V0.20.0** : un bouton « Ajouter le widget à la page de <table reçue> » sur la carte (le widget crée
  lui-même la section ; l'accès complet de cette nouvelle instance reste à accepter dans le panneau de droite).

## État précédent : V0.15.0 (10 novembre 2026)

V0.15.0 (Antoine, 10 novembre, après l'étude de GFS sur le canal entre deux onglets : « c'est un cas d'usage courant que pour
le setup la personne ait accès aux deux, du coup oui, prévoir un bouton/procédure dédié simplifié serait chouette »).
**Aucun changement du moteur** (2.3.0) : le canal est du transport de texte, côté écran (`js/tab-link.js`, `js/tab-link-ui.js`), et
le moteur juge ce qui arrive comme un code collé (document de la clé chez Grist, code de contrôle, péremption, Renforcé).
- **Mesure de GFS** (faits vérifiés 47, 06/11, vrai Grist sous Chromium) : deux documents d'une même instance, ouverts dans le
  même navigateur et le même profil, se parlent par `BroadcastChannel` entre leurs widgets, même en arrière-plan ; autre profil :
  rien. Refait ici (e2e `ONLY_TABS=1`, vrai Grist, widget servi de `localhost:8585` aux deux onglets) : ça passe.
- **Parcours** (le lien du formulaire reste à coller : Grist ne le donne pas à un widget) : SOURCE, étape Invitation, bouton
  « Envoyer à un document ouvert dans ce navigateur » (`offerInvitation`, le code reste à copier) ; CIBLE, un avis en haut de
  l'écran (`#offer`, `startOfferNotice`) : « Recevoir » ouvre l'assistant habituel sur ce code, déjà lu (`receiveWizard(…, offered)`),
  « Ignorer » ; pas d'avis dans un document en lecture seule ni pour une invitation de son propre document (autre onglet du même
  document) ; après le lien du formulaire, la réponse repart d'elle-même (`sendReply`, bouton « Renvoyer au document d'origine » si
  l'invitation n'est pas venue du canal) ; l'assistant de la SOURCE passe à l'étape Réponse, remplie et contrôlée
  (`checkReply`), et la personne approuve après comparaison des codes de contrôle (case obligatoire en Renforcé : le moteur refuse
  sans elle). Sans réponse au bout de 3 s, la SOURCE ou la CIBLE dit pourquoi (autre onglet, profil, navigateur, lecture seule,
  même adresse de widget) et que le copier-coller reste là.
- **Protocole** (`tab-link.js`, six messages : `offer`, `want`, `seen`, `reply`, `wantReply`, `got`) : chaque côté écoute tant que
  son écran est affiché (`alive`) ; un onglet ouvert après coup demande (`want`, `wantReply`) ce qui a été dit avant lui ;
  `parseMessage` n'accepte que ces genres, un identifiant de la forme voulue et un code du bon genre ; noms montrés nettoyés par
  `cleanLabel`. Essais : `tests/unit/tab-link.test.mjs` (8, deux « onglets » dans un processus), e2e `tabSteps` (`TAB_SHOTS=<dossier>`
  pour des captures).
- **Sécurité** (SECURITY.md, « Canal entre onglets » et « Risques acceptés ») : le canal est audible de toute page de la même
  origine que le widget dans ce navigateur (un GitHub Pages est commun à tous les dépôts d'un compte), secret d'invitation et
  adresse d'écriture de réponse compris : même exposition qu'un courriel, devant plus de monde. Il n'identifie personne : seul
  Grist le fait (`shareInfo`). Rien ne part ni ne s'écrit sans geste, sauf le renvoi de la réponse quand l'invitation est venue
  du canal.
- **Vu en lisant le code, non mesuré** : les verrous `navigator.locks` (`gristsync-resend`, `gristsync-consolidation`…) valent
  « toutes pages du navigateur » : deux documents ouverts ensemble se font la queue (un long renvoi de la SOURCE retient le
  rattrapage de l'autre). Ancien, sans danger, mais à noter pour ce scénario.

V0.14.0 (état précédent, 9 novembre 2026) :

V0.14.0 (Antoine, 9 novembre : « prévoir une sync dans les deux sens pour les pj également » ; proposition
`/mnt/project-files/notes/pieces-jointes-deux-sens.md`, carte de décision : « Complet, dans la Bêta »). Moteur **2.3.0**
(mineure, dit dans `GFS-ETAT.md`). Seul l'Échange a un flux CIBLE vers SOURCE : le sens unique ne change pas.
- **Avant** : `exchangeTables` retirait toute colonne Pièces jointes de l'export de retour ; pire, la modification suivante de
  A sur une ligne remplaçait la cellule de B (`['L',5,6]` devenait `['L',5]`). **Maintenant** (`exchangeTables` garde les
  colonnes cochées par A) un fichier ajouté, remplacé ou retiré chez l'un arrive chez l'autre, par le mécanisme du sens
  unique (liste dans le lot, morceaux postés par la page d'un propriétaire, dépôt après contrôle taille et SHA-1).
- **Pas d'écho** : champ `o` du suivi `fichiers` de la note SOURCE (`{ webhook: "empreinte16 …" }`, `HELD_MAX` = 1000 par
  webhook) = fichiers que le partenaire a déjà, remplis (`noteHeldFiles`, `source/files.js`, appelé par `consolidate` avant
  `receiveFiles`) à partir des fichiers cités par les versions **déjà signées et scellées** du journal. `fileSends` n'envoie pas à
  un webhook ce qu'il détient (`holdFiles`, `mergeHeld`) ; les marques sont écrites **avant** le dépôt et `mergeHeld` garde `o`
  à chaque écriture du suivi (course entre deux onglets). Un participant ne peut que se priver lui-même d'un fichier.
- **Une ligne attend ses fichiers (Échange seulement)** : `waitingVersions` (`logic/files.js`) donne à `planConsolidation` les
  versions dont un fichier cité manque ; elles ne sont pas recopiées (`plan.waiting`, ni écriture, ni refus, ni « À valider »,
  restent dans le journal, gardées par la purge) et s'appliquent à l'arrivée du fichier ; une suppression n'attend rien ; une
  version plus récente de la ligne remplace celle qui attend. `fillActions` (complément de cellule) est sauté en Échange : une
  cellule incomplète repartirait comme la plus récente. Carte : « N lignes attendent leurs fichiers » (`recv.files.held`,
  `filesSummary` rend `held`, état « incomplet »), `recv.files.bigHeld` pour un fichier de plus de 25 Mo (la ligne ne se
  recopie jamais tant qu'il est dans la cellule).
- **Échange à plusieurs** : deux sauts (participant vers A, puis A vers les autres), sans copie pour l'émetteur. Chaque saut
  demande la page ouverte d'un propriétaire du document qui envoie. Aucune table technique ni colonne de plus.
- **Sécurité** : rien de nouveau sur le fil. Ce qui change : un participant peut faire déposer des fichiers (25 Mo au plus) dans
  le document de A, dans les colonnes cochées seulement, et A les relaie ; dit dans `SECURITY.md` (« Pièces jointes », « Risques
  acceptés »). `CODE_FORMAT` inchangé parce que la Bêta n'est pas publiée : les deux documents d'un Échange doivent avoir la
  0.14 (un participant plus ancien écrirait des cellules incomplètes) ; après la publication il faudrait relever `CODE_FORMAT`.
- Testé : unit (`files`, `consolidation`, `exports`) ; e2e `exchangeFilesSteps` (`ONLY_EXCHANGE_FILES=1`, dans le parcours
  complet après `filesSteps`) : fichiers de A chez B sans renvoi, ligne de B qui attend son fichier chez A puis recopiée avec lui,
  modification de A qui ne défait pas la cellule de B, fichier retiré, puis C qui rejoint (fichier de B chez C par A, sans copie
  pour B).

## État précédent : V0.13.5 (9 novembre 2026)

V0.13.5 (Antoine, 9 novembre : « côté cible on ne voit pas le nom du doc d'où proviennent les données […] et côté cible et
source rajouter le lien du document, pas de lien public, le lien fonctionnel […] dans un nouvel onglet au clic » ; carte de
décision : « A, mais récupérer par défaut le nom du document, et laisser corriger au choix de l'user ») : nom et lien du
document de l'autre côté, des deux côtés.
- **Un widget ne peut pas lire le nom de son propre document** (vérifié sur Grist 1.7) : `grist.docApi.getDocName()` rend
  l'identifiant, la fiche REST `GET /api/docs/<id>` est refusée (403) à un jeton d'accès (lecture seule comme complet),
  `document.referrer` n'a que l'origine. Seule la clé de **partage d'un formulaire** donne le nom (`GET /api/s/<clé>`, anonyme :
  `shareInfo`, `readShare`) : la SOURCE connaît ainsi le nom de la CIBLE (déjà en 0.10.1), la CIBLE ne connaissait celui de la
  SOURCE qu'en Échange. « Récupérer par défaut » est donc impossible pour une SOURCE privée : l'assistant de destinataire a un
  champ « Nom de ce document » (`showOptions`), vide la première fois, **retenu** dans la note SOURCE (`nomDoc`, `docNameOf`,
  `setDocName`, `rememberDocName`, `sourceDocName`) puis proposé de nouveau, corrigeable. Il part dans l'invitation et la
  réponse publique (`from.docName`, `from.team`, `sourceFrom`).
- **Liens** : `docUrl(origin, team, docId)` (`logic/codes.js`) refait `<instance>[/o/<équipe>]/doc/<id>` (forme changée en 0.15.2, voir plus haut) de l'instance de CE
  document (https, ou http sur localhost), équipe et identifiant en `[A-Za-z0-9_-]` : jamais une adresse tirée d'un code.
  `docLink` (`js/ui.js`) : `target="_blank" rel="noopener noreferrer"`, icône, texte réservé aux lecteurs d'écran, infobulle (« Nom
  indiqué par la SOURCE, non vérifié » côté CIBLE sauf en Échange, où le nom vient de Grist). Montré sur la carte de réception
  (`js/target/source-line.js`), à la fiche de l'assistant CIBLE (`sourceFiche`), à la ligne du destinataire côté SOURCE
  (`hookDoc`, `memoDoc`, `personWho`) et à la fiche de réponse. Sans équipe (code d'avant), pas de lien. Le nom reste un
  « dire » : jamais dans une décision ni dans le code de contrôle. Piège : une adresse sans équipe échoue sur un site à équipes
  (`/doc/<id>` seul).
- Moteur 2.2.0 (mineure : champs facultatifs, `CODE_FORMAT` inchangé), dit dans `GFS-ETAT.md`. `sourceOf` exporté de
  `target/receive.js`. `updateSourceNote` ne réécrit plus une note inchangée.
- Testé : unit (304 : `docUrl`, `cleanLabel`, `memoDoc`, `nomDoc`, `readShare`, parcours moteur) ; e2e `ONLY_DOCLINK=1`
  (`docLinkSteps` : champ vide puis retenu, nom `<i>…</i>` rendu en texte, adresse, `target`/`rel`, clic = nouvel onglet,
  captures avec `SHOTS=<dossier>`).
- Le texte de `docs/04-tutoriel.md` sur le Renforcé (« fait valider toute suppression reçue par la CIBLE ») date d'avant la
  0.13.4 : à corriger à la prochaine passe de tutoriel.

## État précédent : V0.13.4 (9 novembre 2026)

V0.13.4 (Antoine, 9 novembre : « ce n'est pas à la cible de faire ce genre de choix, c'est bien un enjeu de la source
d'être responsable des données. Côté cible on est passif » ; carte de décision : « CIBLE passive partout, SOURCE
avertie », renforcé compris) :
- **CIBLE passive** : la retenue des grosses suppressions est retirée du moteur (`WAVE`, `WAVE_STRICT`, `holdWave`,
  `decideWave`, `held`, la carte `waveBlock`, les textes `recv.wave.*`). Toute suppression de la SOURCE (ligne effacée,
  sortie du filtre, case Supprime) est appliquée, quel qu'en soit le nombre, en Renforcé aussi. Ce qui reste à la CIBLE :
  l'option **Archive** (les lignes restent, cochées). La signature et le sceau (0.9, 0.10) ferment déjà la liste forgée.
  Les textes du Renforcé (`send.renforce.help`, `recv.renforce`) ne parlent plus de suppressions à valider.
- **SOURCE avertie, après coup** (aucune confirmation avant l'envoi n'est possible : le webhook de Grist envoie sans le
  widget) : page d'un propriétaire ouverte, `watchRows` (`engine/source/synchro.js`, appelé par `upgradeSource`) compare le
  nombre de lignes de chaque table de l'export (suivi `N:crc`, `eligibleRows`) à la dernière observation gardée dans la note
  SOURCE (`lignes` : `{ <export>: { at, n: { <table>: nombre } } }`, renouvelée au plus toutes les 5 minutes). Plus de 10 lignes
  **et** plus de 20 % de la table en moins : événement `shrink` dans l'historique (`who` = table, `n`) et avis de 24 h sur la
  carte de l'export (`shrinkNotices`, textes `send.shrink.*`, rappel de Ctrl+Z / « Historique du document »). Logique pure
  dans `logic/notes.js` (`observeRows`, `rowDrops`, `recentDrops`, `rowsOf`, testée). Pas pour les exports en Échange (leurs
  suppressions passent par la case Supprime) ; l'export public compte un destinataire. **Limites dites** : le compte ne distingue pas
  une suppression d'une sortie du filtre ; une baisse faite page fermée n'est vue qu'à l'ouverture suivante, comparée à la
  dernière observation (« constaté le … ») ; sans destinataire, la référence suit sans événement.
- Moteur 2.1.0 (`engine/version.js`), dit dans `GFS-ETAT.md` : GFS aussi applique désormais toute suppression.
- Testé : unit (`notes` : seuils, référence, avis de 24 h ; `consolidation` : tout est effacé, un seul ou tout) ; e2e : la
  suppression d'une ligne en Renforcé s'applique seule, 14 lignes ajoutées puis retirées font apparaître l'avis côté SOURCE.

## État précédent : V0.13.3 (9 novembre 2026)

V0.13.3 (Antoine, 9 novembre, carte de décision « Tout, parcours compris » sur les constats 1 à 10 de l'audit UI/UX de
la 0.13.1) : écran seul, rien dans le moteur (`hookShown` est dans `js/source/shown.js`).
- **Un seul composant d'avis** (`notice` de `js/ui.js`, `message(kind, text, titre)` pour un avis à titre) : ton `info`
  (à savoir), `warn` (à décider ou à surveiller), `err` (ne marche plus, `role="alert"` ; les autres `role="status"`) ;
  titre en gras, lignes `small`, corps libre, boutons en pied. Alerte de retouches, vague de suppressions, écarts,
  clés manquantes (`keysBlock`), avis réservés aux propriétaires l'emploient. `flowView` n'a volontairement aucun rôle
  vivant (redessiné toutes les 10 s).
- **Retouches à la main** : au-delà de `FOLD_FROM` (5) lignes, le détail est replié (`fold`, mémorisé par `opened`).
- **Destinataire** : la ligne montre « courriel · équipe/nom du document » sans l'identifiant brut (`hookShown`, le
  complet reste dans `title`) ; la carte CIBLE dit « Données de … » + document (`recv.docId`) ; la pause manuelle a sa
  phrase (`send.paused.manual`).
- **Assistants** : ancrés en haut (plus de centrage vertical, les boutons ne sautent plus d'une étape à l'autre) ;
  options de la CIBLE (archive, lecture seule) repliées sous « Options avancées » (`recv.options.advanced`) : l'e2e
  les ouvre avant de cocher (`accept()` de `run.mjs`).
- **Tutoriel** : étape 1 scindée (`install` + `access`), listes numérotées en vraie `<ol>` (`paragraphs`), « Pourquoi »
  replié (`s.more`). Image d'aide `img/aide-partager.png` rognée sur les trois boutons (`helpShots`) ; cibles de clic
  de 24 px au moins sur les `summary`.
- **Pas fait** : constats 11 à 15 (débordement de 1 px à 380 px, phrase flottante de mise à jour, badge « À jour »
  contre avis, réception sans journal, noms du produit).

V0.13.2 (état précédent, 6 novembre 2026) :

V0.13.2 (Antoine, 6 novembre : « refaire un audit UI/UX pour vérifier que tout est cohérent, fluide »). Rapport
classé (15 constats, captures) : Claude Doc « Audit UI/UX de la Bêta V0.13.1 », captures dans
`/mnt/project-files/notes/audit-ux-0.13/`. Corrigé ici, vérifié dans un Grist réel :
- **Fausse alerte de retouches** : une Référence qui affiche le numéro de ligne arrive du journal en nombre, la
  destination la garde en texte ; `sameValue` (`logic/consolidation.js`) tient un nombre et le même nombre en texte
  pour égaux (43 retouches annoncées sur le document d'essai, 3 vraies).
- **Assistants coupés à 700 px** : `.scrim` est une grille à piste automatique, `max-width: 100%` ne contraignait pas
  sous 744 px ; `grid-template-columns: minmax(0, 1fr)`.
- **Focus perdu à chaque redessin** : `redraw`, `focusSpot`, `restoreFocus` (`js/ui.js`) retrouvent l'élément actif
  par son rôle et son nom ; une fenêtre rend le focus à son bouton d'origine à la fermeture.
- Textes : apostrophes, « courriel », libellé de réponse « Date ».
Constats restants (avertissements hétérogènes, pause sans explication, identifiants bruts, « lignes dans le
journal » qui compte des versions, tutoriel étape 1 dense, assistants centrés verticalement, options de la
CIBLE à replier) : attendent le choix d'Antoine, voir le rapport.

V0.13.1 (état précédent, même jour) :

V0.13.1 (Antoine, 6 novembre, après le récap des tests de charge : « je veux un max de message d'erreur ciblés
et précis donc oui tous à faire », sur les cas que la 0.12.5 laissait sans message sur mesure) :
- **Table `Synchro` perdue** (`lostSync` de `logic/strays.js`, `lostCard` et `lostSynchro` de `source/tab.js`,
  textes `send.lost.*`) : **vérifié sur Grist 1.7.22** (`tests/e2e/tools/probe-synchro-gone.mjs`) : une table
  effacée laisse ses webhooks (sans table, `tableId` nul) et ses règles d'accès ; renommée, les webhooks la
  suivent (`tableId` = le nouveau nom) ; ces webhooks, avec leur condition `rec.Synchro_Export == "<export>"`,
  prouvent que le widget était là. Trois cartes (propriétaires seulement, ils sont seuls à lire les webhooks) :
  `deleted` (dit ce qui est perdu, Ctrl+Z ou « Historique du document », et un bouton « Retirer les anciens
  webhooks » après confirmation ; un nouvel export reste possible), `renamed` (le nouveau nom, « redonnez-lui le
  nom Synchro : tout reprend »), `hidden` (la table porte son nom mais le widget n'y retrouve pas
  `Synchro_Export` : colonne effacée ou règle d'accès qui cache la table à tous, propriétaires compris ;
  « Permissions avancées »). Dans les deux derniers cas « Nouvel export » est grisé. Au premier écran, un
  propriétaire dont la table est perdue arrive directement dans Envoyer (`openFirstScreen`), pas à l'accueil.
  La carte « une table nommée Synchro existe déjà » (`foreign`) cède la place quand `lost` s'applique.
- **Document CIBLE supprimé** (sonde `tools/probe-dead-target.mjs`) : Grist répond `404 Share not known`,
  retente environ une minute puis **abandonne l'envoi** (file à 0, plus d'erreur visible) ; le widget met le
  destinataire en pause d'office après 60 s de lien mort, et les textes (`send.error.link`, `send.paused.auto`)
  citent maintenant le document supprimé parmi les quatre causes, que Grist ne distingue pas (même 404).
- **Personne non propriétaire** : l'onglet Envoyer dit « Vous n'êtes pas propriétaire de ce document : la
  liste des exports et de leurs destinataires est réservée à ses propriétaires… » (avant : « Aucun export »,
  faux) ; l'accueil le dit aussi (`home.notOwner`, via `isOwnerHere`). Éditeur et lecteur de la SOURCE ont le
  même écran (Grist ne laisse lire les webhooks qu'aux propriétaires).
- Testé : unit (`lostSync`) ; e2e `betises.mjs` : `synchroSupprimee` (bouton compris), `synchroRenommee`,
  `regleSynchro`, `lecteurSource`, `editeurSource` (ligne « ATTENDU … OUI » dans le relevé, `SHOTS=<dossier>` fait
  des captures).

## V0.13.0 (6 novembre 2026)

V0.13.0 (Antoine, 6 novembre, sur ma réserve « comparaison finale pas faite » de la 0.12.4 : « si ce cas
n'est pas étudié dans l'autre fil il faudrait le prévoir non ? ») : **bilan des lignes annoncées et reçues**.
Cas visé : un envoi qui ne part jamais (Grist redémarré : la file vit en mémoire sans Redis ; file vidée ;
webhook coupé un temps). Aucune tranche n'annonce de reste, et la CIBLE restait « À jour » avec une table
incomplète.
- **SOURCE** : la formule du lot (ligne `lot`, hors Échange) ajoute `"bilan": {"n", "t"}` : `n` = nombre
  de clés lu dans la ligne `suivi` (`Synchro_Ids` = `N:crc`, clé présente et filtre appliqué, doublons
  comptés), `t` = `Sync_Etat` du suivi (heure du dernier changement des clés). Le texte du lot ne change que
  quand les clés changent : pas d'événement de plus pour une modification. Signé avec le lot. Pas de nouvelle
  colonne ni table, `CODE_FORMAT` inchangé (une CIBLE d'avant ignore la clé, une SOURCE d'avant n'annonce rien).
- **CIBLE** (`js/logic/tally.js`, `parseLot` rend `tally`, `planUnpack` rend `tally` par table, la plus récente
  par `t` : un lot arrivé dans le désordre ne remplace pas une annonce plus récente) : `nextTally` garde
  l'annonce par table dans la note du journal (`tally`, bornée à 200 tables, écrite seulement si elle change).
  `liveKeys` compte les clés que la SOURCE a encore d'après les versions du journal (dernière version de
  chaque clé, sauf celle marquée `suppression` ou `partie` sans case Supprime ; la case laisse la ligne dans la
  SOURCE donc dans le compte annoncé). `tallyGap` ne signale que **reçues < annoncées** (un surplus, par exemple une
  ligne cochée Supprime puis effacée, n'est pas un manque) ; `tallyDue` exige que le même manque dure
  `TALLY_GRACE_S` (600 s) de page ouverte (suivi en mémoire, `tallySeen` de `target/loop.js`), ce qui couvre
  l'envoi en route, une liste de suppressions pas encore passée et un lot arrivé dans le désordre.
  Rien tant que des envois bruts attendent (`unpacked.left`), en Échange, par lien public, en archive, ni
  pour une table dont l'écart a déjà son avis (`missing`, `big`).
- Affichage : `recv.tally` sur la carte (attendues, reçues, manque, pistes : envoi perdu ou clés en double,
  demander un « Tout renvoyer »), la carte passe à « incomplet », l'état à copier dit les annonces et le
  manque. Un passage tous les 5 minutes au plus quand rien ne change : le manque sort entre 10 et 15 minutes.
- **Limite dite** : le manque n'est vu qu'à l'arrivée d'un lot suivant (qui porte l'annonce à jour). Si plus
  rien n'est modifié à la SOURCE après la perte, la CIBLE ne peut pas le deviner. Un moteur de relance (ping
  périodique de la SOURCE) aurait coûté un événement par table et par destinataire (file Grist de 1 000).
- Testé : unit (`tally`, `journal`, `formulas`) ; e2e : le délai est ramené à 20 s (`tally.js` réécrit par le
  petit serveur du test) ; aucun avis après tout le parcours précédent (pas de fausse alerte), webhook coupé
  (`PATCH enabled:false`), ligne ajoutée pendant la coupure puis une autre après la reprise : « la SOURCE
  annonce … mais seules … » ; renvoi à la main de la ligne perdue, avis effacé ; lignes d'essai supprimées.

V0.12.5 (état précédent, même jour) :

V0.12.5 (Antoine, 6 novembre : « fiabiliser les envois à mort », tests réels qui essaient de les faire
échouer, messages d'erreur « super clairs », puis « se mettre à la place d'un humain dans Grist qui clique
partout ») : banc `tests/e2e/charge.mjs` et `tests/e2e/betises.mjs`, mode d'emploi, mesures de Grist et tableau
« trouvé / corrigé » dans `docs/07-tests-de-charge.md`. Deux Grist réels (le second derrière
`chaos-proxy.mjs`, qui fait échouer les envois à la demande), jusqu'à 30 000 × 20, 100 000 lignes, 256
destinataires sur dix lignes, une quarantaine de bêtises. À retenir :
- **Grist (mesuré, 1.7.22)** : une file d'envoi par document, 1 000 événements (au-delà, chaque écriture du
  document attend, par pas de 5 s ; N destinataires = N événements par modification). Un envoi qui échoue est
  retenté ~15 min et retient tous les autres destinataires du document. Un serveur qui ne répond jamais laisse
  l'envoi « en cours » **sans fin** (20 min sans reprise). Désactiver un webhook libère les autres ;
  `DELETE /webhooks/<id>` n'arrête pas un envoi en cours, `DELETE /webhooks/queue/<id>` oui (`deleteWebhook`
  le fait d'abord). `lastHttpStatus` reste celui du dernier envoi réussi après une connexion coupée : c'est
  `lastEventBatch` qui dit l'échec en cours (`failureStatus`).
- **Pause d'office** (`js/source/pausing.js`, `autoPauseKind` de `logic/exports.js`) : un destinataire dont le
  lien est mort (404, 401, 403), dont le journal est supprimé (`Table not found`) ou dont un envoi attend plus de
  3 min (`SLOW_MS`) est mis en pause par le widget après 60 s vu ainsi, page d'un propriétaire ouverte
  (`pauseDeadLinks`, dans `catchUpLocked`), note `auto` + `why` (`link` ou `slow`), événement `autopause`, la carte
  le dit. Les erreurs qui passent seules (429, 5xx, connexion coupée) ne sont **jamais** mises en pause d'office :
  Antoine a tranché le 6 novembre (carte de décision) : **on laisse comme ça** (une pause fait perdre les
  changements faits pendant qu'elle dure, sauf renvoi) ; à rouvrir si un cas réel le demande. « Débloquer la file » n'est plus proposé pour ces erreurs (`NO_UNBLOCK`).
- **Textes d'erreur** (`hookErrorKey`) : un par cause (`size`, `column`, `link`, `journal`, `rate`, `server`,
  `network`, `slow`, `other`), qui disent aussi que les autres destinataires attendent et quoi faire ; un seul avis
  « N destinataires attendent derrière… » par export (`behindNotice`) ; la carte se relit toute seule tant qu'un
  envoi est en cours (`hookBusy`, `tickFlows`).
- **Clés `id_sync` / colonnes du widget** (`js/logic/keys.js`, `js/source/keys.js`) : lignes sans clé ou de même
  clé, colonne `id_sync`, `MajLe` ou `RecalculLe` supprimée : carte « Des lignes n'arriveront pas » et bouton
  « Réparer les clés » (colonnes remises, clés neuves, toutes les lignes repartent). Le compte des clés lit le
  schéma d'abord : SQLite lit un identifiant inconnu entre guillemets comme un texte.
- **Bêtises vues et corrigées** : valeurs `NaN` ou infinies (`v()` de `formulas.js` envoie `None`) ; webhook
  supprimé à la main (avis `vanishedRecipients` : ajoutés moins présents) ; lignes de `Synchro` supprimées (avis
  « les lignes de cet export ont disparu » ; **les clés de signature des destinataires étaient dans ces lignes** :
  `unkeyedRecipients`, avis par personne, révoquer puis réinviter) ; CIBLE : **renommer la seule table reçue
  perdait la clé de signature et arrêtait la réception** (`receivedKey` suit `refs.table`), clé perdue ou table
  effacée dite par la carte (un premier passage en erreur ne passe plus pour « En attente du lien »), formulaire
  dépublié ou page supprimée (`formGone`), refus d'une règle d'accès (`error.blockedRules`), 512 contrôles de lien
  simultanés à 256 destinataires (`pool`, six à la fois).
- **Pas traité** (traité en 0.13.1 : table `Synchro` supprimée ou cachée, document CIBLE supprimé, lecteur de la
  SOURCE) : minuteries d'un onglet caché (non testable sans tête).

V0.12.4 (état précédent, même jour) :

V0.12.4 (étape 2 de la même demande d'Antoine, 6 novembre) : **un renvoi en tranches annonce ce qui
reste à venir**. Cas visé : la page du widget SOURCE se ferme en plein renvoi (premier envoi, « Tout
renvoyer », rattrapage) ; la CIBLE restait « À jour » avec une table à moitié reçue, rien ne lui disait
qu'il en manquait (mesuré par le fil des essais de charge).
- Format : `Synchro_Renvoi` vaut `marque:reste:numéros` (`resendValue(mark, ids, rest)`, `announceRest`
  de `logic/resend.js`) ; la formule du lot lit la dernière partie pour les numéros (comme avant : une
  formule d'avant lit aussi la nouvelle valeur) et pose `"restant": reste` dans le lot (ligne `lot`
  seulement, signé avec le reste du texte). `refus<heure>:<numéros>` (renvoi d'un refus corrigé, CIBLE)
  n'a pas de reste. Pas de nouvelle colonne ni table, `CODE_FORMAT` inchangé (une CIBLE d'avant ignore la clé).
- Le reste est le nombre de lignes des tranches à venir ramené à celles qui partent vraiment
  (`ratio` = lignes du suivi `N:crc` / lignes de la table, le filtre et les clés vides pèsent) ; la
  dernière tranche annonce 0. Une tranche coupée refaite en tranches plus petites annonce le reste de la
  tranche refaite à l'envoi suivant.
- CIBLE : `parseLot` lit `rest` (entier ≥ 0, borné à 1e9, absent sinon) ; `noteGaps` met le compte de
  la table à `rest` (0 sans annonce : SOURCE d'avant, comme avant) ; `nextGaps` remplace le compte (il ne
  s'additionne pas d'une tranche à l'autre). Texte `recv.missing` : « envoi en plusieurs morceaux ... tant
  qu'un propriétaire de la SOURCE a la page de son widget ouverte : si ce nombre ne baisse pas, demandez-lui
  de l'ouvrir ». L'état de la carte passe à « incomplet » (`cardStatus`).
- Testé : unit (`resend`, `journal`, `formulas`) ; e2e (`Synchro_Renvoi` de chaque tranche du rattrapage
  de 4 000 lignes au bon format ; renvoi interrompu écrit à la main : lot `restant` = 123, avis « 123 lignes »
  sur la CIBLE, puis tranche à reste 0 et avis retiré).
- **Pas fait, volontairement** : comparaison finale « lignes attendues / lignes reçues » (nombre annoncé par
  `N:crc` contre les lignes vivantes du journal). Faux positifs en usage normal (ajouts et suppressions entre
  l'annonce et l'arrivée, filtre qui change) ; la vérification des clés (doublons, clés vides) est dans le fil
  des essais de charge. À reprendre si un cas réel échappe au reste annoncé.

V0.12.3 (état précédent, même jour) :

V0.12.3 (Antoine, 6 novembre : un utilisateur de l'Alpha 0.5.9 voyait ~400 lignes sur ~30 000 dans la
CIBLE ; « anticiper et fiabiliser les envois », « donner plus de contexte aux users sur les blocages »,
« pendant que des envois sont en cours ou prévus par lot, l'user ait un feedback » ; carte de décision :
« Tout, par étapes »). **Étape 1 = cette version, étape 2 (V0.13.0) = bilan attendues/reçues.** Les
essais de charge et d'échec (deux Grists, 30 000 × 20) sont dans l'autre fil « Fiabiliser les envois par
des tests de charge » (`js/source/keys.js`, `js/logic/keys.js`, `queueBlocker`, `deleteWebhook`, `personRow`).
- **Mesuré (Grist 1.7.22)** : 30 000 lignes × 20 colonnes = 715 o/ligne, ~21 Mo par destinataire, 160 lots
  en 2 min 40 ; 40 colonnes = 1 388 o/ligne, ~42 Mo. Le budget `RESEND_BUDGET` (20 Mo / 600 s) est une
  fenêtre glissante, pas une pause entre envois : après les 20 premiers Mo, environ 2 Mo/min (42 Mo pour
  un destinataire ≈ 11 min, trois destinataires ≈ 55 min). Le budget n'a pas bougé (protection de DINUM,
  à ne pas relever sans décision d'Antoine). Une page CIBLE fermée pendant tout l'envoi n'empêche rien.
- **Estimation avant l'envoi** (`js/logic/estimate.js`, `js/source/flow.js` `exportEstimate`,
  `confirmSend`) : lignes qui partiront (suivi `N:crc` de `Synchro`, `eligibleRows`), poids d'après 50
  lignes, lots, destinataires, durée = max(lots × `LOT_SECONDS`, budget). Dite dans l'assistant de
  destinataire (`showLoad`) ; au-delà de `LONG_SECONDS` (180 s) un envoi manuel demande confirmation.
- **Avancement** (`js/logic/health.js` `exportFlow`, `flowView`) : la ligne `charge` porte `prog`
  (`{exp, table, done, total, lots, lotsTotal, bytes, at, last}`, gardé après la fermeture de la page,
  `startProg`/`addProg`/`etaSeconds`). La carte de l'export dit : en cours (barre, lot n sur N, temps
  restant = max du rythme observé et du rythme du budget), autre page (`runningOther`), attente du budget
  (`budget`, `budgetWait`), file (`queued`), tout en pause, bloqué par un destinataire en erreur,
  interrompu (page fermée, `done` sur `total`), en attente du rattrapage. Redessin toutes les 10 s
  (`tickFlows`, lectures légères). Le rattrapage garde la raison de son dernier passage
  (`lastPass`, `catchState`).
- **Lots plus économes** (`nextChunkSize`) : un lot coupé (`lotCut`, `total > lines + big`) est quand même
  envoyé et mangeait le budget ; la tranche suivante se règle sur ce qui tient (0,9 × lignes qui tiennent).
  30 000 × 40 colonnes : ~38 Mo au lieu de ~75 Mo.
- **Erreurs d'envoi** (`hookErrorKey`) : 429, 5xx et erreur réseau ont leur texte. `errorText` reçoit le
  statut.
- **CIBLE** (`journalStats`, une agrégation SQL ; `arrivalNotes`, `reportButton`) : « Dernier envoi
  arrivé » (`Sync_Recu`), lignes brutes pas encore recopiées, page visible ou non, « Copier l'état pour la
  SOURCE » (= diagnostic F1 étendu : avancement, rattrapage, journaux).
- **Pièges** : `wizard.show(index, body, buttons)` n'aplatit qu'un niveau du tableau du corps : y étaler
  (`...`) les listes de nœuds ; les clés i18n composées (`common.size.*`) vont dans `DYNAMIC` de
  `tests/unit/i18n.test.mjs`. Lancer l'e2e depuis une session cloud : `gristlabs/grist:latest` de Docker
  Hub (l'image de mirror.gcr.io échoue), voir `access-full-help-and-cloud-e2e` en mémoire.

V0.12.2 (état précédent) :

V0.12.2 (Antoine, 6 novembre : un utilisateur de l'Alpha 0.5.9 avait des envois bloqués par
`400 {"error":"Invalid column \"A\""}` ; Antoine : « on ne touche pas au code de l'alpha et au dépôt
public, on corrige sur dev »). **Cause** : une table nommée `Synchro` faite à la main (pour y poser le
widget, colonnes A, B, C de Grist) était reprise par le widget, qui n'y retirait rien : le webhook
envoie la ligne entière de `Synchro` et le journal de la CIBLE refuse toute clé qui n'est pas une de ses
colonnes (et ne nomme que la première). Rapport : `/mnt/project-files/notes/erreur-colonne-A/pistes.md`.
Choix d'Antoine (carte de décision) : garder le nom `Synchro` et poser un garde-fou, pas de nom
distinctif (le nom est en dur dans les formules, webhooks, règles d'accès, lien public et codes).
- **Logique pure** `js/logic/strays.js` (testée, `tests/unit/strays.test.mjs`) : `ownsSync` (la table
  `Synchro` est celle du widget quand elle a `Synchro_Export`), `foreignSync` (une table de ce nom sans
  cette colonne : jamais reprise), `strayColumns` (colonnes de `Synchro` hors `syncColumns`, `manualSort`
  et `gristHelper_*`, avec le nombre de cellules remplies, 0 ou faux ou liste vide ne comptent pas, et la
  formule), `refusedColumn` / `columnFault` (colonne nommée par le refus : `stray` encore dans Synchro,
  `gone` déjà retirée mais gardée par la file, `''` colonne du widget qui manque au journal),
  `freeTableName` (`Table_Synchro`, pas `Synchro_…` que `isUserTable` écarterait).
- **Colonnes en trop** (onglet Envoyer, propriétaires) : carte « Colonnes en trop dans la table
  Synchro » (`data-stray`) et fenêtre qui s'ouvre seule une fois par chargement (`askAboutSync`,
  « Plus tard » ne retire rien) : liste chaque colonne (vide, N cellules remplies, formule), demande de
  sauvegarder avant et une case « J'ai sauvegardé » quand il y a quelque chose à perdre
  (`js/source/strays.js`). `removeStrayColumns` ne retire que ce que `strayColumns` voit encore. Un envoi
  bloqué par l'une d'elles : la file de Grist garde ses envois (qui portent la colonne), donc
  `clearAndMark` après le retrait, puis le rattrapage renvoie. Le texte ne dit pas à la personne qu'elle a
  fait une faute (Grist met A, B, C à toute table neuve).
- **Erreur d'un destinataire** : `errorText` (`source/tab.js`) dit « colonne X de la table Synchro, rien à
  faire de son côté » (`stray`) ou « la file garde d'anciens envois » (`gone`) ; le texte d'avant
  (« ouvrez la page de son widget ») ne reste que pour une colonne du widget qui manque au journal, et il
  nomme la colonne.
- **Table `Synchro` qui n'est pas celle du widget** : `ensureSyncTable`, `syncRows`, `saveExport`, les
  règles d'accès (`syncRules`), le diagnostic, le premier écran et l'assistant d'export testent
  `ownsSync`. `saveExport` lève `syncTableForeign` ; la CIBLE d'un Échange le refuse dès la lecture de
  l'invitation (`readInvitation`). L'onglet Envoyer montre la carte « Une table nommée Synchro existe
  déjà » (`data-foreign`), grise « Nouvel export », et propose de la renommer (`RenameTable` : colonnes,
  valeurs et formules restent, nom proposé `Table_Synchro`, modifiable) ; le widget crée ensuite la sienne.
- Tutoriel (`i18n/tutorial.json`, `docs/04`) : « Renommer la page, par exemple « Synchro Grist » », ne pas
  créer soi-même de table Synchro ; deux lignes de dépannage.
- Testé de bout en bout (`ONLY_STRAYS=1`, `straySteps`, Grist 1.7.22) : envoi refusé, fenêtre, « Plus
  tard », retrait, file débloquée et envois repris ; colonne vide sans case ; table d'une autre personne
  (sa page est celle du widget) jamais reprise, renommée, le widget crée la sienne.
- **Risque connu, non traité** : un widget posé sur la table `Synchro` elle-même (page sur cette table)
  perd sa page quand le dernier export est supprimé (`removeTechnicalTables`). Les nouveaux documents ne
  s'y mettent plus (la table d'une autre personne est renommée).

V0.12.1 (état précédent, 21 octobre 2026) :

V0.12.1 (Antoine, 21 octobre : « oui faire les corrections necessaire », après la liste des limites
non corrigées de la 0.12) :
- **Lecture seule, la règle seule fait foi** (`lockedTables`, `lockMirrors` de `logic/acl.js`,
  `syncRules({ release })` de `js/acl.js`) : la note du journal (`verrou`) peut demander un verrou,
  jamais le retirer ; la règle posée (`LOCK_MEMO`) reste tant qu'un propriétaire ne la lève pas par
  « Options » de la carte (`release`, `js/target/options.js`) ; un passage de propriétaire remet
  `verrou: true` dans une note retouchée ; une règle dont la table n'est plus reçue est retirée.
  Testé de bout en bout (`optionsSteps` : note retouchée à `verrou:false`, règle toujours là, note
  remise ; la levée par la boîte de dialogue marche toujours). **Reste vrai** : un éditeur (droit de
  structure par défaut, descriptions de colonnes lisibles, clé de signature dedans) peut toujours
  écrire une version dans le journal ; Grist ne permet pas de l'empêcher.
- **Listes de choix et filtre de lignes** : avec un filtre (`rowFilter` non nul), la SOURCE n'envoie ni
  `choices` ni `choiceOptions` (le format part ; `filteredColumns` de `logic/exports.js`, dans
  `wantedValues` et `optionsActions`) ; la CIBLE complète les colonnes Choix et Liste de choix **qu'elle
  a créées** et qui n'ont pas reçu de liste avec les valeurs des lignes reçues
  (`valueChoiceActions` de `logic/received.js`, `receivedChoices` de `logic/options.js`, 500 valeurs
  de 200 caractères au plus, sans couleur ; `currentRows` de `logic/journal.js` : dernière version non
  supprimée de chaque clé ; appelé dans `prepareColumns` de `target/loop.js`). Une ligne qui entre
  dans le filtre apporte sa valeur. Testé de bout en bout : `ONLY_CHOICES=1` (`choicesSteps` ; sans
  le correctif le test échoue). Texte du filtre (`send.filter.help`) mis à jour.
- Archive : inchangée, par choix (option de la CIBLE ; la SOURCE ne voit ni n'empêche la ligne gardée ;
  droit à l'effacement à la charge du propriétaire de la CIBLE).
- Tous les autres points de la 0.12.0 ci-dessous restent vrais.

V0.12.0 (Antoine, 21 octobre : « vérifier si des features ne seraient pas manquantes » avant la bêta ;
choix sur la carte de décision : F1 à F3, puis « les autres sauf F7 » ; propositions dans
`/mnt/project-files/notes/beta-deploy/fonctions-proposees.md`) :
- **F1, diagnostic à copier** (Réglages, `js/diagnostic.js` lit, `js/logic/diagnostic.js` choisit
  et écrit) : version, instance, droits, navigateur, exports et destinataires (état d'envoi
  de Grist sans leur adresse), réceptions (note sans secret, clés ni adresse), erreurs récentes
  (`noteError` de `ui.js`, `maskKey`). **Jamais** : valeur de table, courriel, adresse de webhook ou
  de formulaire, code, clé, identifiant de document. Testé (unit et e2e : « diagnostic sans adresse »).
- **F2, version dans les codes** (`codes.js`, `f` = format, `v` = version) : un code dont le format
  `f` dépasse celui d'ici (`CODE_FORMAT`) est refusé (`codeNewer`, deux versions dites) ; la version
  `v` ne sert qu'à l'avertissement de la fiche (`versionNote`, code plus ancien ou plus récent de
  même format). Toute version qui change le sens d'un champ doit donc augmenter `CODE_FORMAT`.
- **F3, listes de choix et formats** (`js/logic/options.js`) : `opts` dans la description des
  colonnes (`exportSchema`, signée avec les colonnes). Seules des clés connues aux valeurs
  contrôlées passent (`columnOptions`). La CIBLE ne complète que les colonnes qu'elle a créées
  (`own` de l'entrée de la note, `missingColumns`, `ownsColumn`) : un choix ajouté à la SOURCE
  s'ajoute à la liste (`optionActions`, `fillOptions`), un format retouché ici reste. `refreshOptions`
  (SOURCE) réécrit `Synchro_Colonnes` quand une liste change. **Piège vérifié** : un lot vide est
  signé mais `unpackedRows` ne garde la description des colonnes que sur sa première ligne, donc un
  lot sans ligne la perdait, et la liste vide des clés n'est pas signée (`bare`) ; `planUnpack`
  garde maintenant une ligne sans clé qui porte seulement la description changée (`known`).
- **F6, archive** (case à l'acceptation ou « Options » de la carte, `archive` dans la note, hors
  Échange) : `planConsolidation({ archive })` n'efface rien ; une ligne partie de la SOURCE reste,
  cochée `Supprimee_a_la_source` (`ARCHIVE_COL`, colonne Bool ajoutée à la destination au passage
  suivant), n'est plus suivie par les listes (`followed`), ni signalée comme retouche ; une nouvelle
  version de sa clé la décoche. Pas de vague de suppressions en archive.
- **F5, tables reçues en lecture seule** (`verrou` dans la note, hors Échange) : règle
  `user.Access != OWNER` → `-CUD` par table de destination (`lockAclRules`, mémo `LOCK_MEMO`, posée
  par `syncRules` comme les autres). La recopie écrit avec les droits de la personne : un non-propriétaire
  ne recopie pas (`copyTables`, `locked`, la carte dit « En lecture seule : la recopie attend… »).
  Seul un propriétaire change ce réglage (`js/target/options.js`).
- **F8, historique des envois** (SOURCE, sans table de plus) : `historique` dans la note SOURCE
  (`{ <export>: [{ at, kind, who, n }] }`, 30 événements, `addEvent`/`eventsOf` dans `logic/notes.js`,
  `recordEvent` dans `source/synchro.js`). Seuls les événements que le widget conduit y sont :
  destinataire ajouté, envoi ou renvoi, rattrapage, file vidée, pause, reprise, révocation, export
  modifié. Les envois ordinaires partent de Grist sans lui ; l'état de chaque destinataire les dit.
- **F4, Références conservées** (`js/logic/links.js`, case « Garder les liens entre les tables » à
  l'étape Colonnes, cochée d'emblée pour un nouvel export, hors Échange) : une colonne Référence
  (pas Liste de références) qui vise une table de l'export, dont la colonne affichée part aussi
  (`linkTables`, `aim`), reçoit `link` (et garde `visible`) dans la description des colonnes
  (`exportSchema(…, true)`, signée avec elles ; cocher ou décocher renvoie la table). La formule du
  lot ajoute à son bloc de données la clé de la ligne visée (`Synchro_Cle_<colonne>`, `LINK_PREFIX`
  dans `common.js`, `data()` de `formulas.js`) ; la colonne part toujours comme son texte affiché.
  CIBLE (`linkColumns` de `target/loop.js`) : une colonne créée par le widget (`own`), encore du
  texte et **vide** devient une Référence vers la table reçue qui affiche la même colonne
  (`ModifyColumn` + `visibleCol` + `SetDisplayFormula`, vérifié dans Grist) ; une colonne déjà remplie
  reste du texte ; le sort est noté (`linked` dans l'entrée de la note) et plus relu. Les lignes du
  journal prennent alors le numéro de la ligne d'ici qui porte la clé (`resolveLinks`, `keyIds`), 0
  (vide de Grist) si elle n'est pas là ; `fillLinks` complète plus tard les cellules restées vides
  (les tables qui gardent un lien sont recopiées après celles qu'elles visent ; une table qui se vise
  elle-même est complétée au passage suivant). Une destination qui garde un lien est relue quand la
  table visée change (`deps` de `settled`). Si la SOURCE ne garde plus le lien, la colonne redevient du
  texte (`undo`, `unlinkActions` ; Grist garde l'affichage). **Limite** : l'historique et les
  retouches signalées montrent les numéros de ligne d'une Référence ; une Liste de références reste
  du texte ; une table visée doit être dans le même export.
- Relecture indépendante de la 0.12 (`/mnt/project-files/notes/beta-deploy/audit-0.12-relecture.md`,
  16 constats, aucun critique), corrigés : décocher l'archive n'efface plus les lignes déjà
  archivées (`archived` se lit toujours, `uncheck` décoche une clé revenue) ; `fillLinks` refait une
  cellule Référence qui vise une ligne effacée (`targetRows` : `keys` et `live`) ; la note du journal
  ne garde ni `opts` ni `link` (`exportSchema(offer.columns)` dans `target/dest.js`) ; la liste de
  choix d'une colonne reçue est bornée à 500 ; ni `HyperLink` ni `Markdown` repris ; journal de retour
  d'Échange avec `own: []` ; règles de lecture seule limitées aux tables d'utilisateur qui portent
  `id_sync` ; options non proposées en lien public ; `updateSourceNote` sous le verrou
  `gristsync-source-note` ; `eventsOf` n'accepte que des événements bien formés ; le diagnostic
  masque adresses, jetons et longs identifiants (`clip`) et ignore une date impossible (`when`).
  **Limites dites** (SECURITY.md, « Risques acceptés ») : le verrou de lecture seule ne protège pas
  d'un éditeur qui écrit dans le journal (corrigé en 0.12.1 pour la note : la règle fait foi) ; un
  export sans filtre envoie la liste complète des choix d'une colonne Choix (avec un filtre, corrigé en
  0.12.1) ; l'archive garde une ligne supprimée à la SOURCE (droit à l'effacement : à la charge de la
  CIBLE).
- Test de bout en bout : `ONLY_OPTIONS=1` (archive, lecture seule, historique), `ONLY_CHOICES=1`
  (filtre et listes de choix, 0.12.1) et `ONLY_LINKS=1` (Références conservées), inclus dans le
  parcours complet ; `ONLY_FILES=1` vérifie aussi les choix repris.

V0.11.5 (Antoine, 21 octobre : « traiter tous les points des anciens audits » avant la bêta) :
reliquats de `/mnt/project-files/notes/audits-v0.8/code-constats.md`. Logique pure sortie et testée :
`js/logic/report.js` (ce qu'un passage de recopie garde pour la carte, quittée de `target/loop.js`),
`js/logic/received.js` (journaux reçus, destinations, clés de signature lus dans le schéma ;
`target/journals.js` ne garde que les écritures), `exportDrift` (`logic/exports.js`), `dueRows`
et `lotLate` (`logic/resend.js`). `offerDialog` passe par `run` (ses erreurs s'affichent) ;
formulaire et ménage des pages de la CIBLE hors redessin périodique ; `smallButton` et boutons
communs de `ui.js` partout ; `digest` commun ; `pageerror` vérifié par l'e2e. Un document sans
table `Synchro` n'est plus relu toutes les 10 s par le rattrapage (`noSyncAt`, toutes les minutes).
Reste : E1 (retirer l'invitation sans secret) à partir du 23 octobre.

V0.11.4 (Antoine, 21 octobre : « oui tu peux corriger sur la beta », deux erreurs des consignes ;
la V0.11.3, réécriture plus large des consignes, a été annulée à sa demande) :
- **Vérifié dans Grist** : le réglage du lien public s'appelle Partager, Gérer les utilisateurs,
  « Accès public » Activé, en « Lecture seule », puis Confirmer (ni « Lien public » ni « Lecture »
  n'existent dans Grist). Textes du widget, tutoriels et `docs/04-tutoriel.md` corrigés.
- Adresse des consignes : `widgetUrl()` (`js/config.js`) rend `BETA_URL` quand le widget est
  servi depuis la bêta (ses codes ne se lisent pas par l'Alpha publiée), sinon `WIDGET_URL` ;
  jamais l'adresse d'une autre copie. Le test vérifie le texte copié.

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
