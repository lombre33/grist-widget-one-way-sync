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
  dans sa destination et nettoie le journal.

L'étude de départ, avec les preuves dans le code de Grist, est dans
[`01-etude-faisabilite.md`](01-etude-faisabilite.md).

## Ce que le widget écrit dans les documents

Ses tables techniques n'ont pas de page : elles ne se voient que dans « Données source ». Pas de
table de réglages.

| Document | Ajouts |
|---|---|
| SOURCE | Dans chaque table d'un export : `id_sync` (UUID à la création) et `MajLe` (date du dernier changement d'une valeur envoyée : formule de déclenchement sur les colonnes des exports). Une colonne `Supprime` déjà présente est prise en compte (ajoutée en Échange). La table `Synchro` : par table d'un export, une ligne `cles`, une ligne `lot`, une ligne de suivi, et pour un export public `complet` et `empreinte`. Un webhook par destinataire, sur `Synchro`, avec la condition de son export ; son mémo garde la fiche du destinataire. Les exports, les invitations en attente (empreinte du secret) et les pauses sont notés dans la description de la colonne `Synchro_Export`. En mode lien public : des règles d'accès marquées « Synchro : lecture limitée aux exports publics ». |
| CIBLE | Les tables de destination, avec leurs colonnes de données plus `id_sync`, masquée de leur page. `Journal_<export>` : les colonnes de `Synchro` (lignes reçues, contrôlées, dépliées puis effacées), puis par version : table d'origine, clé, date, suppression, bloc des colonnes, et `Sync_Applique`, `Sync_Etat`, `Sync_Par`, `Sync_Recu`. Une page `Journal_<export>` par réception, sous celle du widget, avec son formulaire publié (sauf en mode lien public). Ce que la CIBLE a choisi est noté dans la description de la colonne `Synchro_Ids` du journal. |

Les envois créés avant la version 0.4 sont signalés « à refaire », avec un bouton qui efface
l'ancien montage. Les réceptions d'avant la 0.5 dont le formulaire partage sa page avec un autre
sont signalées, avec un bouton qui les sépare.

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
- Un Échange est le seul destinataire de son export ; en cas de conflit, la version la plus
  récente de la ligne entière l'emporte.
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
| `js/logic/` | Logique pure, testée sans navigateur : `common.js` (constantes, noms, outils), `formulas.js` (formules de `Synchro`), `exports.js` (exports, webhooks, règles du lien public), `resend.js` (renvois, budget), `codes.js` (codes, adresses), `journal.js` (lecture et dépliage du journal, purge, historique), `consolidation.js` (recopie) |
| `js/source/` | Onglet Envoyer : `synchro.js` (table `Synchro` et sa note), `resend.js` (renvois, rattrapage, charge du document), `actions.js` (pause, reprise, révocation, file), `tab.js` (cartes), `export-wizard.js`, `recipient-wizard.js` |
| `js/target/` | Onglet Recevoir : `journals.js` (journaux et leur note), `loop.js` (recopie automatique), `tab.js` (cartes, historique), `dest.js` (destinations, table proposée), `wizard.js` (assistant de réception) |
| `js/guide.js`, `js/tutorial.js` | « Qui fait quoi ? », consignes à copier, onglet Tutoriel et aide en images |
| `js/ui.js`, `js/i18n.js`, `i18n/*.json`, `js/prefs.js` | Éléments d'interface, textes fr/en, préférences d'affichage |

## Tests

```bash
npm test                      # tests unitaires de js/logic, des textes et des images du tutoriel (Node 20+, sans dépendance)
npm install                   # Playwright, pour le test d'intégration seulement
tests/e2e/start-grist.sh      # Grist jetable dans Docker
npm run test:e2e              # parcours complet dans un vrai Grist et un vrai navigateur
```

Le test d'intégration déroule tout le parcours avec plusieurs documents : envoi des lignes
existantes, recopie, ajout, modification, suppressions, retouche manuelle préservée, historique,
second destinataire et révocation d'un seul, table et colonne ajoutées à l'export (table existante
rattachée), Référence renommée, Ctrl+Z, destinations renommées, filtre de lignes, montage 0.4 mis
à niveau, gros import, file bloquée par un envoi trop gros, table de 21 000 lignes, pause et
reprise avec rattrapage, relais, lignes forgées rejetées, lien d'un autre document refusé, lien
commun signalé puis coupé, réception reprise, arrêts, lien public (seul l'instantané est lisible,
sans la note de la SOURCE) et Échange. Avec `CAPTURES=1`, il refait les captures de `docs/images`,
leurs vignettes recadrées pour le README (`docs/images/readme`) et les images d'aide de `img/`. Les deux suites tournent à chaque push
(`.github/workflows/tests.yml`).
