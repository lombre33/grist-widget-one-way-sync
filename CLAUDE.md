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

## État : V0.4.2 (15 octobre 2026)

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
Une liste des clés de plus de 25 000 lignes environ, ou plusieurs listes en attente regroupées,
dépassent 1 Mo et bloquent la file (piste : liste en morceaux, `docs/05-pistes.md`). Les montages
d'avant la V0.4 sont signalés « à refaire » avec un bouton de nettoyage (`legacyTables`,
`legacyJournals`).

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

Garde-fou (choix d'Antoine du 15 octobre, plutôt qu'un nouveau format d'envoi, voir
`docs/05-pistes.md`) : table de plus de `MAX_ROWS` (20 000) lignes refusée par l'assistant et
signalée sur la carte (liste des clés trop grosse pour un envoi) ; les lots d'un export se
partagent le budget (formule du lot : `lookupRecords` des lignes `cles` de l'export) ; un envoi
refusé pour sa taille (413 : Grist retente 20 fois, environ 15 minutes, puis remet le lot en fin de
file, sans fin ; à la fermeture du document, il abandonne après 5 essais) est vu par `catchUp`, qui vide
la file et marque tous les lots servis `RESEND_ALL`. Tout renvoi est reprenable : chaque tranche
part avec la marque `chunkMark` (lignes dans l'ordre de `MajLe`), effacée à part à la fin.

Code à la racine, sans build : `index.html`, `css/`, `js/` (carte des modules dans `README.md`,
analyse de sécurité dans `SECURITY.md`, tutoriel `docs/04-tutoriel.md`). Tests : `npm test`
(logique pure), `npm run test:e2e` après `tests/e2e/start-grist.sh` (parcours complet dans un
Grist Docker, trois documents ; `CAPTURES=1` refait les captures de `docs/images` et les images
d'aide de `img/`). Les instances autorisées sont à la fois dans `js/config.js` et dans la CSP de
`index.html`. Aide intégrée (V0.3) : onglet Tutoriel (`js/tutorial.js`), « Qui fait quoi ? » et
« Copier avec les consignes » (`js/guide.js`), aide en images à chaque étape des assistants.

Pièges : toute écriture REST depuis le widget doit porter `X-Requested-With` (sinon 401, vu comme
une erreur CORS) ; changer une règle d'accès recharge le document, donc le widget. Désactiver un
webhook remet à zéro son état d'envoi (`lastSuccessTime` perdu) et Grist ne met rien en file
pendant la pause : l'heure de pause (plus grande `MajLe`) est notée dans la note. Dans les tests,
`getByText` de Playwright est insensible à la casse et cherche une sous-chaîne (« En pause »
trouve « Mettre en pause ») ; le mémo d'un webhook porte l'identifiant court du document (urlId).

Relais (A → B → C) : possible, la table reçue garde les `id_sync` de A ; l'export ne remplit pas
les clés vides d'une table reçue (une ligne locale à clé serait effacée par la prochaine liste de
A). Les boucles (retour vers le document d'origine, table vers elle-même dans le même document)
sont refusées (`loopingTables` à « Vérifier », `checkDests` côté CIBLE). Le second saut dépend de
la page du widget ouverte dans B.

Effacer une table efface ses sections, mais pas leurs cases dans `layoutSpec` (repliés compris ;
les numéros de sections sont réutilisés ensuite) ni le partage de la page (`_grist_Pages.shareRef`
et `_grist_Shares`, donc la clé d'écriture). `tidyPages` nettoie les deux après
`removeTechnicalTables`. Les tables techniques n'ont pas de page (`dropPages`). Créer une section
sur une autre page que celle du widget ne recharge pas le widget.
