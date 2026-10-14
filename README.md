# Synchro Grist à sens unique

Widget Grist qui recopie une table d'un document **SOURCE** dans un document **CIBLE** de la même
instance, et la tient à jour, **sans serveur à héberger**. Pensé pour `grist.numerique.gouv.fr`,
compatible avec toute instance Grist récente.

Version 0.1 · Grist Factory · licence GNU GPL v3.0 · aucune dépendance, aucune étape de build.

## Comment ça marche

```
SOURCE                                  CIBLE
table Contacts ──webhook natif de Grist──▶ Journal_Contacts (une ligne par version reçue)
  (add, update)   POST anonyme par la clé       │
                  d'un formulaire publié         │ le widget, ouvert par un éditeur,
                  …/api/s/<clé>/tables/          ▼ recopie la dernière version de chaque ligne
                  Journal_Contacts/records?flat=1  Contacts (table normale, éditable)
```

- Le **transport** est celui de Grist : le webhook du document SOURCE envoie chaque ajout ou
  modification à l'adresse d'écriture d'un formulaire publié dans la CIBLE. Il tourne côté
  serveur, même quand personne n'a la page ouverte.
- La **consolidation** est faite par le widget, dans la CIBLE, avec les droits de l'éditeur qui
  ouvre la page : il recopie la dernière version de chaque ligne (clé `id_sync`, ordre `MajLe`)
  dans la table de destination, toutes les 30 secondes tant que la page est ouverte.
- Les **suppressions** sont logiques : cocher `Supprime` dans la SOURCE retire la ligne de la
  CIBLE (Grist n'envoie pas les suppressions).
- Une **retouche** faite à la main dans la CIBLE reste en place jusqu'à la prochaine modification
  de la même ligne dans la SOURCE.

## Installer

Dans chaque document : **Ajouter**, **Ajouter un widget**, **Personnalisé**, **URL
personnalisée**, coller l'adresse du widget, puis choisir **Accès complet** dans l'onglet Widget du
panneau de droite. Les documents doivent être dans un **espace d'équipe** (l'écriture anonyme par
formulaire n'existe pas dans un espace personnel).

## Brancher une synchro (deux codes à copier-coller)

| Où | Qui | Quoi |
|---|---|---|
| SOURCE, onglet **Envoyer** | un propriétaire | **Nouveau destinataire** : choisir la table. Le widget signale ce qui empêche l'envoi et ajoute au besoin les colonnes `id_sync`, `MajLe`, `Supprime`. **Créer l'invitation** donne un code à transmettre. |
| CIBLE, onglet **Recevoir** | un éditeur | **Accepter une invitation** : coller le code. Le widget crée le journal, la table de destination et publie un formulaire de réception sur sa page. Dans la carte du formulaire : **Partager**, **Copier le lien**, coller le lien dans le widget, **Tester le lien**. Le widget donne un code de réponse. |
| SOURCE, onglet **Envoyer** | un propriétaire | **Coller la réponse** : le widget montre qui a accepté (e-mail, document, équipe), puis **Approuver et brancher** crée le webhook et propose d'envoyer les lignes existantes. |

Ensuite, côté SOURCE : pause, reprise, déblocage de la file d'envoi, renvoi complet, révocation.
Côté CIBLE : synchronisation et purge du journal.

## Ce que le widget écrit dans les documents

| Document | Tables et colonnes |
|---|---|
| SOURCE | Colonnes `id_sync` (UUID à la création), `MajLe` (date de modification), `Supprime` (case à cocher) dans la table envoyée ; table `Synchro_Destinataires` (registre des invitations et des webhooks) ; le webhook. |
| CIBLE | `Journal_<table>` ; la table de destination, avec `Sync_JournalId` et `Sync_Ordre` (dernière version appliquée) ; table `Synchro_Config` ; une section Formulaire publiée sur le journal. |

Les tables `Synchro_…` ne sont créées qu'après accord, à la première action qui en a besoin.

## Limites connues

- La table SOURCE doit être « plate » : une Référence qui affiche une autre colonne, une mise en
  forme conditionnelle ou des pièces jointes ajoutent des colonnes que la CIBLE ne peut pas
  recevoir. Le widget le signale avant l'invitation.
- La CIBLE n'est à jour que lorsqu'un éditeur ouvre la page du widget ; entre-temps les versions
  attendent dans le journal.
- Un envoi en échec bloque la file de **tous** les webhooks du document SOURCE pendant environ
  15 minutes (comportement de Grist). Le bouton **Débloquer la file** la vide.
- Le paramètre `?flat=1` n'est pas documenté par Grist ; il est couvert par ses tests depuis 2023.

Détails et preuves : `docs/01-etude-faisabilite.md`, `docs/02-procedure-test-dinum.md`,
`docs/03-proposition-ux-et-droits.md`. Sécurité : [`SECURITY.md`](SECURITY.md).

## Code

| Fichier | Rôle |
|---|---|
| `index.html`, `css/style.css` | Page du widget, politique de sécurité du contenu, charte graphique |
| `js/main.js` | Démarrage, chargement de l'API des widgets, onglets, Réglages |
| `js/core.js` | Logique pure : versions, consolidation, purge, contrôle de la table, codes, adresses |
| `js/grist.js` | Accès au document (API des widgets) et aux webhooks (API REST, même instance) |
| `js/source.js` / `js/target.js` | Onglets Envoyer / Recevoir |
| `js/tables.js` | Tables du widget et accord avant création |
| `js/ui.js`, `js/i18n.js`, `js/prefs.js` | Éléments d'interface, textes fr/en, préférences d'affichage |
| `js/config.js` | Instances Grist autorisées, version |

## Tests

```bash
npm test                      # tests unitaires de js/core.js (Node 20+, sans dépendance)
npm install                   # Playwright, pour le test d'intégration seulement
tests/e2e/start-grist.sh      # Grist jetable dans Docker
npm run test:e2e              # parcours complet SOURCE -> CIBLE dans un vrai navigateur
```

Le test d'intégration déroule tout le parcours ci-dessus sur deux documents, puis vérifie
l'envoi des lignes existantes, la consolidation, une modification, une suppression logique, la
conservation d'une retouche manuelle et la purge. Les deux suites tournent à chaque push
(`.github/workflows/tests.yml`).
