# Synchro Grist à sens unique

Widget Grist qui recopie une table d'un document **SOURCE** dans un document **CIBLE** de la même
instance, et la tient à jour, **sans serveur à héberger**. Pensé pour `grist.numerique.gouv.fr`,
compatible avec toute instance Grist récente.

Version 0.3 · Grist Factory · licence GNU GPL v3.0 · aucune dépendance, aucune étape de build.

## Comment ça marche

```
SOURCE                                         CIBLE
Contacts ─▶ vue d'export ── webhook natif ───▶ Journal_Contacts ─┐ le widget, page ouverte par
 (table)    (colonnes                           (versions)        │ un éditeur, recopie la
            choisies)                                             ▼ dernière version de chaque ligne
Synchro_Contacts (liste des clés) ───────────▶                  Contacts (table normale, éditable)
              POST anonyme par la clé d'un formulaire publié dans la CIBLE (…/records?flat=1)
```

- Ce qui part est une **vue d'export** : une table de résumé de la table SOURCE par `id_sync`,
  tenue à jour par Grist, qui ne contient que la clé, la date, la case de suppression et les
  **colonnes cochées**, en un bloc. Changer les colonnes ne bloque jamais l'envoi ; la CIBLE crée
  seule les colonnes nouvelles.
- Le **transport** est celui de Grist, côté serveur, même quand personne n'a la page ouverte :
  chaque ajout ou modification part vers le journal de la CIBLE, à l'adresse d'écriture d'un
  formulaire publié.
- Les **suppressions** partent aussi : la table `Synchro_<table>` a une ligne dont la formule liste
  les clés existantes ; Grist l'envoie à chaque ajout ou suppression, et la CIBLE efface les lignes
  qui n'y sont plus. La case `Supprime` reste possible.
- La **recopie** dans la table de destination est faite par le widget, avec les droits de
  l'éditeur qui ouvre sa page (même replié), toutes les 10 secondes ; il efface au passage les
  versions remplacées du journal.
- Une **retouche** faite à la main dans la CIBLE reste en place jusqu'à la prochaine modification
  de la même ligne dans la SOURCE.
- Un envoi peut porter **plusieurs tables** ; la CIBLE choisit chaque destination, nouvelle ou
  existante (correspondance des colonnes, rattachement des lignes déjà là par une colonne
  commune).
- **Mode lien public**, au choix à l'invitation : un seul code ; la SOURCE est partagée en lecture
  par lien public, et des règles d'accès posées par le widget n'y laissent lire que les vues
  d'export ; la CIBLE les lit toutes les 10 secondes tant que sa page est ouverte.

## Installer

Dans chaque document : **Ajouter**, **Ajouter un widget**, **Personnalisé**, **URL
personnalisée**, coller l'adresse du widget, puis choisir **Accès complet** dans l'onglet Widget du
panneau de droite. Les documents doivent être dans un **espace d'équipe** (l'écriture anonyme par
formulaire n'existe pas dans un espace personnel).

## Brancher une synchro (deux codes à copier-coller)

Pas à pas, avec captures d'écran : [`docs/04-tutoriel.md`](docs/04-tutoriel.md).

| Où | Qui | Quoi |
|---|---|---|
| SOURCE, onglet **Envoyer** | un propriétaire | **Nouveau destinataire** ouvre un assistant : tables, colonnes, préparation (accord avant tout ajout), nom, mode, secret en option. Il donne un code d'invitation. |
| CIBLE, onglet **Recevoir** | un éditeur | **Accepter une invitation** : coller le code, choisir chaque destination. Le widget publie les formulaires de réception sur sa page et montre où cliquer : **Partager**, **Copier le lien**, coller ce seul lien. Il donne un code de réponse. |
| SOURCE, onglet **Envoyer** | un propriétaire | **Coller la réponse** : vérifier qui a accepté, **Approuver et brancher**, puis **Envoyer** les lignes déjà là. |

En mode lien public, la deuxième ligne s'arrête au choix des destinations et la troisième
disparaît ; il reste à régler « Lien public » sur Lecture dans le menu Partager de la SOURCE.

Ensuite, côté SOURCE, une carte par destinataire : colonnes envoyées, pause, reprise, déblocage
de la file d'envoi, renvoi complet, dernier envoi reçu, révocation (avec effacement des tables
techniques devenues inutiles). Côté CIBLE, une carte par envoi : e-mail du propriétaire des
données, dernier passage par table, lignes ajoutées, modifiées ou supprimées depuis la dernière
visite (20 au plus), synchronisation immédiate, arrêt de la réception.

## Ce que le widget écrit dans les documents

Ses tables techniques sont rangées sous la page du widget, repliée par défaut. Pas de table de
réglages.

| Document | Ajouts |
|---|---|
| SOURCE | Dans chaque table envoyée : `id_sync` (UUID à la création), `MajLe` (date de modification), `Supprime` (case à cocher). La vue d'export `<table>_summary_id_sync`. La table `Synchro_<table>` (une ligne : liste des clés, colonnes envoyées). Deux webhooks par table et par destinataire, dont le mémo garde la fiche du destinataire. Les invitations en attente et les partages par lien public sont notés dans la description de la colonne `Synchro_Ids`. En mode lien public : des règles d'accès marquées « Synchro : lecture limitée aux vues d'export ». |
| CIBLE | La table de destination, avec ses colonnes de données plus `id_sync`, masquée de sa page. `Journal_<table>` : clé, date, suppression, bloc des colonnes, liste des clés, et `Sync_Applique`, `Sync_Etat`, `Sync_Par`, `Sync_Recu` (marque, effet, auteur, date d'arrivée). Une section Formulaire publiée par journal, sur la page du widget (sauf en mode lien public). L'invitation est notée dans la description de la colonne `Synchro_Ids` du journal. |

## Limites connues

- Une table n'a qu'une vue d'export : tous ses destinataires reçoivent les mêmes colonnes.
- La table de destination n'est à jour que lorsqu'un éditeur ouvre la page du widget ;
  entre-temps les versions attendent dans le journal (mode lien public : rien n'est lu).
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
| `js/tables.js` | Tables techniques (vue d'export, liste des clés, journal) et leurs notes |
| `js/guide.js`, `js/tutorial.js` | « Qui fait quoi ? », consignes à copier, onglet Tutoriel et aide en images des assistants |
| `js/ui.js`, `js/i18n.js`, `js/prefs.js` | Éléments d'interface, textes fr/en, préférences d'affichage |
| `js/config.js` | Instances Grist autorisées, version |

## Tests

```bash
npm test                      # tests unitaires de js/core.js (Node 20+, sans dépendance)
npm install                   # Playwright, pour le test d'intégration seulement
tests/e2e/start-grist.sh      # Grist jetable dans Docker
npm run test:e2e              # parcours complet SOURCE -> CIBLE dans un vrai navigateur
```

Le test d'intégration déroule tout le parcours ci-dessus avec deux tables (dont un référentiel
existant rattaché par une colonne commune), puis vérifie l'envoi des lignes existantes, la
consolidation, un ajout, une modification, une suppression logique, une vraie suppression, la
conservation d'une retouche manuelle, l'historique, le nettoyage du journal, le rangement des
pages, l'ajout d'une colonne à l'export, l'arrêt de la réception, la révocation, et le mode lien
public (seule la vue d'export est lisible sans identifiant). Avec `CAPTURES=1`, il refait les captures de `docs/images`. Les deux suites tournent à chaque push
(`.github/workflows/tests.yml`).
