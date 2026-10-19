# Fonctionnement et code

Le [README](../README.md) présente le widget. Cette page dit comment il marche, ce qu'il écrit
dans les documents, ses limites détaillées, la carte du code et les tests.

## Comment ça marche

```
SOURCE                                                    CIBLE
Contacts ─┐                                               Journal_Annuaire ─┐ le widget, page ouverte
Villes  ──┤ formules ─▶ Synchro ── un webhook par ───────▶ (listes, lots)    │ par un éditeur, contrôle,
          │            (lignes par   destinataire,                          ▼ déplie et recopie
          │             table d'un   filtré sur                  Contacts, Communes (tables
          │             export)      son export)                 normales, éditables)
              POST anonyme par la clé du formulaire de cette réception (…/records?flat=1)
```

- La SOURCE organise ses envois en **exports** : un nom, des tables et, pour chacune, les colonnes
  qui partent (et en option un filtre de lignes). On y ajoute des personnes une à une, on en
  révoque une seule, on modifie l'export pour tous ses destinataires.
- Une **seule table technique**, `Synchro`, quel que soit le nombre d'exports et de tables. Pour
  chaque table d'un export, une ligne suit les clés existantes (256 empreintes, pour les
  suppressions) et une ligne porte, en un bloc JSON, les lignes modifiées depuis 5 secondes avec
  les colonnes cochées. Le reste ne sort jamais du document.
- Le **transport** est celui de Grist, côté serveur, même page fermée : un webhook natif par
  destinataire, sur `Synchro`, avec une **condition** qui ne laisse passer que les lignes de son
  export. Il écrit dans le journal de la CIBLE, par la clé d'un formulaire publié : **une clé par
  réception**, chaque formulaire sur sa propre page.
- La **recopie** est faite par le widget, avec les droits de l'éditeur qui ouvre sa page (même
  replié) : il écarte ce qui ne peut pas venir de la SOURCE, déplie le reste, recopie chaque table
  dans sa destination et nettoie le journal. Toutes les 10 secondes, il demande à Grist quelles
  tables ont changé (`docChanges`, comparaison de deux états du document) et ne passe que si un
  journal, une destination ou le schéma a bougé, et au moins une fois par minute.
- Les **pièces jointes** : une formule ne lit pas le contenu d'un fichier. Le lot porte la liste des
  fichiers de chaque cellule (`fileIdent`, nom, taille) ; une ligne `fichiers` de `Synchro` (que le
  webhook n'envoie pas) liste tous ceux d'une table. Le widget SOURCE, page ouverte par un
  propriétaire, télécharge chaque fichier et le poste en morceaux de 512 Ko (700 Ko en base64) à
  l'adresse du webhook de chaque destinataire qui ne l'a pas (lignes `fichier` du journal) ; ce qui
  est parti est noté dans la note de `Synchro` (`fichiers` : par export, les fichiers que tous les
  destinataires à jour ont, et ce qu'ont les autres). Le widget CIBLE rassemble les morceaux,
  vérifie taille et SHA-1, dépose le fichier (sauf s'il a déjà ce contenu) et écrit dans les
  cellules les fichiers présents ; un fichier arrivé ensuite complète la cellule si elle est
  restée telle que la recopie l'a laissée (`fillActions`, fichiers attendus notés par table).
  Code : `js/logic/files.js`, `js/source/files.js`, `js/target/files.js`.

L'étude de départ, avec les preuves dans le code de Grist, est dans
[`01-etude-faisabilite.md`](01-etude-faisabilite.md).

## Ce que le widget écrit dans les documents

Ses tables techniques n'ont pas de page : elles ne se voient que dans « Données source ». Pas de
table de réglages.

| Document | Ajouts |
|---|---|
| SOURCE | Dans chaque table d'un export : `id_sync` (UUID à la création) et `MajLe` (date du dernier changement d'une valeur envoyée : formule de déclenchement sur les colonnes des exports). Une colonne `Supprime` déjà présente est prise en compte (ajoutée en Échange). La table `Synchro` : par table d'un export, une ligne `cles`, une ligne `lot`, une ligne de suivi, une ligne `fichiers` si elle envoie des pièces jointes, et pour un export public `complet` et `empreinte` ; par export, une ligne `signature` qui garde la clé de signature de ses envois. Un webhook par destinataire, sur `Synchro`, avec la condition de son export ; son mémo garde la fiche du destinataire. Les exports, les invitations en attente (empreinte du secret), les pauses et les fichiers déjà envoyés (empreintes abrégées) sont notés dans la description de la colonne `Synchro_Export`. Des règles d'accès marquées « Synchro : réservée aux propriétaires », et en mode lien public « Synchro : lecture limitée aux exports publics ». En Échange, la clé de signature de chaque participant dans la description de `id_sync` des tables envoyées. |
| CIBLE | Les tables de destination, avec leurs colonnes de données plus `id_sync`, masquée de leur page, dont la description garde la clé de signature de l'export reçu. Les pièces jointes reçues, déposées une fois chacune. `Journal_<export>` : les colonnes de `Synchro` (lignes reçues, contrôlées, dépliées puis effacées ; morceaux de fichiers, effacés une fois le fichier déposé), puis par version : table d'origine, clé, date, suppression, bloc des colonnes, et `Sync_Applique`, `Sync_Etat`, `Sync_Avant` (ce que la recopie a remplacé, pour l'historique), `Sync_Par`, `Sync_Recu`. Une page `Journal_<export>` par réception, à la racine de la liste des pages, avec son formulaire publié (sauf en mode lien public). Ce que la CIBLE a choisi est noté dans la description de la colonne `Synchro_Ids` du journal, avec les fichiers attendus et les vagues de suppressions en attente. Une règle d'accès « Synchro : journaux réservés aux éditeurs » (case cochée à l'acceptation). |

Les réceptions d'avant la 0.5 dont le formulaire partage sa page avec un autre sont signalées,
avec un bouton qui les sépare. Les montages d'avant la 0.5 (développement, 14 et 15 octobre) ne
sont plus reconnus : leurs tables techniques s'effacent à la main.

## Limites connues

- Il faut **Grist 1.7.11** ou plus récent : le widget vérifie au branchement que Grist a bien
  enregistré le filtre du webhook, et refuse sinon.
- Les tables de destination ne sont à jour que lorsqu'un éditeur ouvre la page du widget dans la
  CIBLE ; entre-temps les versions attendent dans le journal (mode lien public : rien n'est lu).
- Le reste d'un gros changement, et un rattrapage, ne partent que lorsqu'un **propriétaire** de la
  SOURCE ouvre la page du widget (Grist ne sait pas programmer un envoi seul). En attendant, la
  CIBLE dit combien de lignes manquent.
- Un envoi en échec bloque la file de **tous** les webhooks du document SOURCE pendant environ
  15 minutes (comportement de Grist). Le bouton **Débloquer la file** la vide, puis renvoie seul.
- Les colonnes d'un export valent pour tous ses destinataires ; un renvoi part vers chacun d'eux
  (sans effet chez ceux qui avaient déjà les mêmes valeurs).
- Une table ou une colonne **renommée, supprimée ou changée de type dans la SOURCE** ne part plus
  correctement : la carte de l'export le signale, et **Modifier** permet de cocher de nouveau les
  bonnes colonnes.
- Une seule ligne plus grosse qu'un envoi de Grist (1 Mo) ne peut pas partir : la CIBLE le signale.
- Le **contenu des pièces jointes** ne part que lorsqu'un propriétaire de la SOURCE a la page du
  widget ouverte ; 25 Mo par fichier au plus (la CIBLE nomme les fichiers trop gros), au rythme du
  budget des renvois (20 Mo par dix minutes et par document). Chaque morceau passe par le journal
  de la CIBLE : son historique d'actions (1 000 actions au plus chez Grist) garde un temps environ
  deux fois la taille des fichiers reçus. Une cellule retouchée à la main pendant qu'un fichier est
  attendu n'est pas complétée (la carte la signale, **Corriger** la remet). Un fichier que la CIBLE
  aurait perdu (pièce jointe purgée) ne revient qu'avec **Tout renvoyer**. Pas de pièces jointes
  par lien public, ni de la CIBLE vers la SOURCE dans un Échange.
- Tous les documents d'un export doivent avoir la version 0.7 ou plus pour qu'une colonne Pièces
  jointes y soit cochée : une version plus ancienne rejette ses lots.
- Un export en Échange n'a que des participants à l'Échange ; en cas de conflit, la version la plus
  récente de la ligne entière l'emporte. À plusieurs, une modification d'un participant n'atteint
  les autres que lorsque la page du widget du document qui administre est ouverte, et un
  changement à valider attend sa décision.
- En mode lien public, tout lecteur de la SOURCE ne voit plus que les instantanés publics, et les
  noms des tables des exports restent lisibles dans les formules de `Synchro`.
- Les noms `Synchro`, `Synchro_…` et `Journal_…` sont réservés aux tables du widget.
- Le paramètre `?flat=1` n'est pas documenté par Grist ; il est couvert par ses tests depuis 2023.

## Carte du code

Par où commencer : `js/main.js` (démarrage et onglets), puis `js/logic/`, qui porte toutes les
règles et se lit sans navigateur.

| Fichier | Rôle |
|---|---|
| `index.html`, `css/style.css` | Page du widget, politique de sécurité du contenu, charte graphique |
| `js/main.js`, `js/config.js` | Démarrage, onglets, Réglages ; instances Grist autorisées, version |
| `js/grist.js` | Accès au document (API des widgets), webhooks et lectures SQL (API REST de la même instance) ; `gristFetch`, seule porte vers le réseau |
| `js/pages.js` | Formulaires de réception, un par page, et ménage des pages |
| `js/form-link.js` | Lien du formulaire : où le trouver, images d'aide, test sur son journal |
| `js/exchange.js` | Échange : export de retour, webhook vers l'autre document, arrêt |
| `js/acl.js` | Règles d'accès du widget, remises d'accord par un propriétaire, et attente du rechargement |
| `js/logic/` | Logique pure, testée sans navigateur : `common.js` (constantes, noms, outils), `formulas.js` (formules de `Synchro`), `exports.js` (exports, webhooks), `acl.js` (règles d'accès du widget), `trust.js` (document vérifié par Grist, code de contrôle, expiration, signatures), `resend.js` (renvois, budget), `codes.js` (codes, adresses), `journal.js` (lecture et dépliage du journal, purge, historique), `consolidation.js` (recopie), `files.js` (pièces jointes : suivi des envois, morceaux, réception, cellules) |
| `js/source/` | Onglet Envoyer : `synchro.js` (table `Synchro` et sa note), `resend.js` (renvois, rattrapage, charge du document), `files.js` (envoi des pièces jointes), `actions.js` (pause, reprise, révocation, file), `tab.js` (cartes), `export-wizard.js`, `recipient-wizard.js` |
| `js/target/` | Onglet Recevoir : `journals.js` (journaux et leur note), `loop.js` (recopie automatique), `files.js` (réception des pièces jointes), `tab.js` (cartes, historique), `dest.js` (destinations, table proposée), `wizard.js` (assistant de réception) |
| `js/guide.js`, `js/tutorial.js`, `i18n/tutorial.json` | « Qui fait quoi ? », consignes à copier, onglet Tutoriel et aide en images (texte du tutoriel dans le JSON) |
| `js/ui.js`, `js/i18n.js`, `i18n/*.json`, `js/prefs.js` | Éléments d'interface, textes fr/en, préférences d'affichage |

## Tests

```bash
npm test                      # tests unitaires de js/logic, des textes et des images du tutoriel (Node 20+, sans dépendance)
npm install                   # Playwright, pour le test d'intégration seulement
tests/e2e/start-grist.sh      # Grist jetable dans Docker
npm run test:e2e              # parcours complet dans un vrai Grist et un vrai navigateur
```

Le test d'intégration déroule tout le parcours avec plusieurs documents : envoi des lignes
existantes, recopie, ajout, modification, suppressions, retouche manuelle préservée et signalée, historique avec avant et après,
second destinataire et révocation d'un seul, table et colonne ajoutées à l'export (table existante
rattachée), Référence renommée, Ctrl+Z, destinations renommées, filtre de lignes, table Synchro
remise en état, gros import, file bloquée par un envoi trop gros, table de 21 000 lignes, pause et
reprise avec rattrapage, relais, lignes forgées rejetées, lien d'un autre document refusé, lien
commun signalé puis coupé, réception reprise, arrêts, lien public (seul l'instantané est lisible,
sans la note de la SOURCE) et Échange. Avec `CAPTURES=1`, il refait les captures de `docs/images`,
leurs vignettes recadrées pour le README (`docs/images/readme`) et les images d'aide de `img/`. Les deux suites tournent à chaque push
(`.github/workflows/tests.yml`).
