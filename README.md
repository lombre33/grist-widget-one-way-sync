# Synchro Grist

Widget Grist qui recopie des tables d'un document **SOURCE** dans un document **CIBLE** de la même
instance, et les tient à jour, **sans serveur à héberger** ; ou, en **Échange**, tient deux
documents à jour l'un l'autre. Pensé pour `grist.numerique.gouv.fr`, compatible avec toute instance
Grist récente.

Version 0.5.0 · Grist Factory · licence GNU GPL v3.0 · aucune dépendance, aucune étape de build.
Il faut Grist 1.7.11 ou plus récent (filtre des webhooks).

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

## Fonctionnalités

- **Exports** : tables, colonnes cochées, filtre de lignes « colonne = valeur » ; destinataires
  ajoutés, mis en pause, repris (avec rattrapage) ou révoqués un à un.
- **Trois modes par destinataire** : avec réponse (deux codes, envoi par Grist même page fermée),
  **Échange** (dans les deux sens, la modification la plus récente l'emporte, pas d'écho) et
  **lien public** (un seul code, la CIBLE lit les instantanés publiés).
- **Destinations au choix** dans la CIBLE : table nouvelle ou existante, correspondance des
  colonnes, rattachement des lignes déjà là par une colonne commune ; table ajoutée plus tard
  proposée dans une fenêtre (recevoir, refuser, plus tard) ; tables et colonnes de destination
  renommées suivies.
- **Fidèle** : ajouts, modifications, suppressions (vraies, ou par une case `Supprime`), valeurs
  venues d'une autre table (Référence, formule), annulation (Ctrl+Z) ; une retouche faite à la
  main dans la CIBLE reste jusqu'au prochain changement de la ligne dans la SOURCE.
- **Grandes tables et gros changements** : liste des clés en 256 empreintes, liste complète par
  morceaux au besoin, reste d'un gros import envoyé seul par tranches, renvoi reprenable, file
  bloquée par un envoi trop gros vidée et renvoyée seule.
- **Ménagement de l'instance** : un renvoi à la fois par document, budget de 20 Mo par 10 minutes,
  relecture de la CIBLE espacée quand rien n'arrive, rattrapage ralenti onglet caché.
- **Sécurité** : une clé d'écriture par réception, lien testé sur son journal, lignes forgées
  rejetées et signalées (« Arrivées suspectes »), lien coupé puis repris, codes contrôlés, clés
  jamais affichées en entier, lien public limité aux instantanés (voir [`SECURITY.md`](SECURITY.md)).
- **Suivi** : carte par export (destinataires, dernier envoi reçu, erreurs expliquées), carte par
  réception (propriétaire des données, lignes manquantes, historique des changements depuis la
  dernière visite), lecteurs en lecture seule.
- **Aide intégrée** : onglet Tutoriel, aide en images à chaque étape, « Qui fait quoi ? »,
  « Copier avec les consignes » pour un courriel prêt à envoyer. Français et anglais, thème clair
  ou sombre.

## Installer

Dans chaque document : **Ajouter**, **Ajouter une page**, vue **Personnalisée**, **URL
personnalisée**, coller l'adresse du widget, puis accepter l'**accès complet** dans le panneau de
droite. Les documents doivent être dans un **espace d'équipe** (l'écriture anonyme par formulaire
n'existe pas dans un espace personnel).

Ce que le widget demande, appelle et garde (détail dans [`SECURITY.md`](SECURITY.md)) :

- **Accès complet** (`requiredAccess: 'full'`) : le widget crée sa table technique et ses
  colonnes de suivi, lit les métadonnées du document, écrit dans les tables de destination
  choisies et, pour un propriétaire, gère les webhooks et les règles d'accès du lien public. Les
  écritures sont listées plus bas, dans « Ce que le widget écrit ».
- **Réseau** : hors de l'API des widgets, toute requête passe par `gristFetch` (`js/grist.js`),
  qui refuse toute origine absente de `js/config.js` (`https://grist.numerique.gouv.fr`,
  `https://docs.getgrist.com`) et n'envoie aucun cookie. La CSP de `index.html` (`connect-src`)
  répète la même liste. Aucun service tiers, aucune bibliothèque chargée.
- **Navigateur** (`localStorage`, clés `gristsync.*`, `js/prefs.js`) : la langue, le thème,
  l'heure de la dernière visite par document CIBLE et un identifiant de navigateur tiré au
  hasard. Aucune donnée du document.

## Brancher une synchro (deux codes à copier-coller)

Pas à pas, avec captures d'écran : [`docs/04-tutoriel.md`](docs/04-tutoriel.md).

| Où | Qui | Quoi |
|---|---|---|
| SOURCE, onglet **Envoyer** | un propriétaire | **Nouvel export** : tables, colonnes, nom. Puis **Ajouter un destinataire** : mode, secret en option. Il donne un code d'invitation. |
| CIBLE, onglet **Recevoir** | un éditeur | **Accepter une invitation** : coller le code, choisir chaque destination. Le widget publie le formulaire de réception sur sa page, sous celle du widget : **Partager**, **Copier le lien**, coller ce lien, **Tester le lien**. Il donne un code de réponse. |
| SOURCE, onglet **Envoyer** | un propriétaire | **Coller la réponse** : vérifier qui a accepté, **Approuver et brancher**, puis **Envoyer** les lignes déjà là. |

En Échange, la SOURCE colle d'abord le lien de son formulaire de retour, et la CIBLE doit être
tenue par un propriétaire. En mode lien public, la deuxième ligne s'arrête au choix des
destinations et la troisième disparaît ; il reste à régler « Lien public » sur Lecture dans le
menu Partager de la SOURCE.

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

Détails et preuves : `docs/01-etude-faisabilite.md`, `docs/02-procedure-test-dinum.md`,
`docs/03-proposition-ux-et-droits.md`. Pistes : [`docs/05-pistes.md`](docs/05-pistes.md).
Sécurité : [`SECURITY.md`](SECURITY.md).

## Code

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

Le test d'intégration déroule tout le parcours ci-dessus avec plusieurs documents : envoi des
lignes existantes, recopie, ajout, modification, suppressions, retouche manuelle préservée,
historique, second destinataire et révocation d'un seul, table et colonne ajoutées à l'export
(table existante rattachée), Référence renommée, Ctrl+Z, destinations renommées, filtre de
lignes, montage 0.4 mis à niveau, gros import, file bloquée par un envoi trop gros, table de
21 000 lignes, pause et reprise avec rattrapage, relais, lignes forgées rejetées, lien d'un autre
document refusé, lien commun signalé puis coupé, réception reprise, arrêts, lien public (seul
l'instantané est lisible, sans la note de la SOURCE) et Échange. Avec `CAPTURES=1`, il refait les
captures de `docs/images` et les images d'aide de `img/`. Les deux suites tournent à chaque push
(`.github/workflows/tests.yml`).
