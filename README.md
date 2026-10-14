# Synchro Grist à sens unique

Widget Grist qui recopie une table d'un document **SOURCE** dans un document **CIBLE** de la même
instance, et la tient à jour, **sans serveur à héberger**. Pensé pour `grist.numerique.gouv.fr`,
compatible avec toute instance Grist récente.

Version 0.1 · Grist Factory · licence GNU GPL v3.0 · aucune dépendance, aucune étape de build.

## Comment ça marche

```
SOURCE                                      CIBLE
Contacts ─────── webhook natif de Grist ───▶ Journal_Contacts ─┐ le widget, page ouverte par
Synchro_Contacts (liste des clés) ─────────▶   (versions)      │ un éditeur, recopie la
                 POST anonyme par la clé d'un formulaire        ▼ dernière version de chaque ligne
                 publié dans la CIBLE (…/records?flat=1)     Contacts (table normale, éditable)
```

- Le **transport** est celui de Grist, côté serveur, même quand personne n'a la page ouverte :
  chaque ajout ou modification d'une ligne part vers le journal de la CIBLE, à l'adresse
  d'écriture d'un formulaire publié.
- Les **suppressions** partent aussi toutes seules : la table `Synchro_<table>` de la SOURCE a une
  ligne dont la formule liste les clés existantes ; Grist l'envoie à chaque ajout ou suppression,
  et la CIBLE efface les lignes qui n'y sont plus. La case `Supprime` reste possible.
- La **recopie** dans la table de destination est faite par le widget, avec les droits de
  l'éditeur qui ouvre sa page (même replié), toutes les 10 secondes ; il efface au passage les
  versions remplacées du journal. Astuce : mettre le widget, replié, sur la page de la table de
  destination.
- Une **retouche** faite à la main dans la CIBLE reste en place jusqu'à la prochaine modification
  de la même ligne dans la SOURCE.
- Un envoi peut porter **plusieurs tables** ; la CIBLE choisit chaque table de destination,
  nouvelle ou existante (un référentiel déjà là, complété de la clé `id_sync` masquée et des
  colonnes manquantes ; ses lignes actuelles ne sont jamais touchées).

## Installer

Dans chaque document : **Ajouter**, **Ajouter un widget**, **Personnalisé**, **URL
personnalisée**, coller l'adresse du widget, puis choisir **Accès complet** dans l'onglet Widget du
panneau de droite. Les documents doivent être dans un **espace d'équipe** (l'écriture anonyme par
formulaire n'existe pas dans un espace personnel).

## Brancher une synchro (deux codes à copier-coller)

Pas à pas, avec captures d'écran : [`docs/04-tutoriel.md`](docs/04-tutoriel.md).

| Où | Qui | Quoi |
|---|---|---|
| SOURCE, onglet **Envoyer** | un propriétaire | **Nouveau destinataire** ouvre un assistant : cocher les tables, accepter la préparation (`id_sync`, `MajLe`, `Supprime`, table `Synchro_<table>`), nommer l'envoi, secret en option. Il donne un code d'invitation. |
| CIBLE, onglet **Recevoir** | un éditeur | **Accepter une invitation** : coller le code, choisir chaque table de destination (nouvelle ou existante). Le widget publie les formulaires de réception sur sa page ; dans la carte d'un formulaire, **Partager**, **Copier le lien**, coller ce seul lien. Il donne un code de réponse. |
| SOURCE, onglet **Envoyer** | un propriétaire | **Coller la réponse** : vérifier qui a accepté (e-mail, document, équipe), **Approuver et brancher**, puis **Tout envoyer** pour les lignes déjà là. |

Ensuite, côté SOURCE, une carte par destinataire : pause, reprise, déblocage de la file d'envoi,
renvoi complet, révocation. Côté CIBLE, une carte par envoi : e-mail du propriétaire des données,
dernier passage par table, lignes modifiées depuis la dernière visite (20 au plus),
synchronisation immédiate. Les formulaires se replient en haut de la page dès que les données
arrivent.

## Ce que le widget écrit dans les documents

Une seule table technique par table synchronisée, de chaque côté, rangée sous la page du widget
(repliée par défaut). Pas de table de réglages.

| Document | Ajouts |
|---|---|
| SOURCE | Dans chaque table envoyée : `id_sync` (UUID à la création), `MajLe` (date de modification), `Supprime` (case à cocher). La table `Synchro_<table>` (une ligne, liste des clés). Deux webhooks par table et par destinataire (la table, sa liste), dont le mémo garde la fiche du destinataire. Les invitations en attente (nom, tables, empreinte du secret) sont notées dans la description de la colonne `Synchro_Ids`. |
| CIBLE | La table de destination, avec ses seules colonnes de données plus `id_sync`, masquée de sa page. `Journal_<table>` : colonnes reçues, `Synchro_Ids`, `Sync_Applique` (version déjà recopiée), `Sync_Par` (auteur de la ligne). Une section Formulaire publiée par journal, sur la page du widget. L'invitation (nom, table source, secret) est notée dans la description de la colonne `Synchro_Ids` du journal. |

## Limites connues

- La table SOURCE doit être « plate » : une Référence qui affiche une autre colonne, une mise en
  forme conditionnelle ou des pièces jointes ajoutent des colonnes que la CIBLE ne peut pas
  recevoir. Le widget le signale avant l'invitation.
- La table de destination n'est à jour que lorsqu'un éditeur ouvre la page du widget ;
  entre-temps les versions attendent dans le journal.
- La liste des clés est envoyée entière à chaque ajout ou suppression : pour une table de
  plusieurs dizaines de milliers de lignes, chaque envoi pèse quelques centaines de kilo-octets.
- Un envoi en échec bloque la file de **tous** les webhooks du document SOURCE pendant environ
  15 minutes (comportement de Grist). Le bouton **Débloquer la file** la vide.
- Le paramètre `?flat=1` n'est pas documenté par Grist ; il est couvert par ses tests depuis 2023.

Détails et preuves : `docs/01-etude-faisabilite.md`, `docs/02-procedure-test-dinum.md`,
`docs/03-proposition-ux-et-droits.md`. Pistes : [`docs/05-pistes.md`](docs/05-pistes.md). Sécurité : [`SECURITY.md`](SECURITY.md).

## Code

| Fichier | Rôle |
|---|---|
| `index.html`, `css/style.css` | Page du widget, politique de sécurité du contenu, charte graphique |
| `js/main.js` | Démarrage, chargement de l'API des widgets, onglets, Réglages |
| `js/core.js` | Logique pure : versions, consolidation, purge, contrôle de la table, codes, adresses |
| `js/grist.js` | Accès au document (API des widgets) et aux webhooks (API REST, même instance) |
| `js/source.js` / `js/target.js` | Onglets Envoyer / Recevoir |
| `js/tables.js` | Tables techniques (liste des clés, journal) et leurs notes |
| `js/ui.js`, `js/i18n.js`, `js/prefs.js` | Éléments d'interface, textes fr/en, préférences d'affichage |
| `js/config.js` | Instances Grist autorisées, version |

## Tests

```bash
npm test                      # tests unitaires de js/core.js (Node 20+, sans dépendance)
npm install                   # Playwright, pour le test d'intégration seulement
tests/e2e/start-grist.sh      # Grist jetable dans Docker
npm run test:e2e              # parcours complet SOURCE -> CIBLE dans un vrai navigateur
```

Le test d'intégration déroule tout le parcours ci-dessus avec deux tables, puis vérifie l'envoi
des lignes existantes, la consolidation, un ajout, une modification, une suppression logique, une
vraie suppression, la conservation d'une retouche manuelle, l'historique, le nettoyage du journal
et le rangement des pages. Avec `CAPTURES=1`, il refait les captures de `docs/images`. Les deux suites tournent à chaque push
(`.github/workflows/tests.yml`).
