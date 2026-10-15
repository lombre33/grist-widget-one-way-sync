# Synchro Grist à sens unique

Widget Grist qui recopie une table d'un document **SOURCE** dans un document **CIBLE** de la même
instance, et la tient à jour, **sans serveur à héberger**. Pensé pour `grist.numerique.gouv.fr`,
compatible avec toute instance Grist récente.

Version 0.4 · Grist Factory · licence GNU GPL v3.0 · aucune dépendance, aucune étape de build.
Il faut Grist 1.7.11 ou plus récent (filtre des webhooks).

## Comment ça marche

```
SOURCE                                                   CIBLE
Contacts ─┐                                              Journal_Annuaire ─┐ le widget, page ouverte
Villes  ──┤ formules ─▶ Synchro ── un webhook par ──────▶ (listes, lots)    │ par un éditeur, déplie
          │            (2 lignes par   destinataire,                       ▼ et recopie par table
          │             table d'un     filtré sur                  Contacts, Communes (tables
          │             export)        son export)                 normales, éditables)
              POST anonyme par la clé d'un formulaire publié dans la CIBLE (…/records?flat=1)
```

- La SOURCE organise ses envois en **exports** : un nom, des tables et, pour chacune, les colonnes
  qui partent. On y ajoute des personnes une à une, on en révoque une seule, on modifie l'export
  (tables, colonnes, nom) pour tous ses destinataires.
- Une **seule table technique**, `Synchro`, quel que soit le nombre d'exports et de tables. Pour
  chaque table d'un export, une ligne liste les clés existantes (les vraies suppressions partent
  ainsi) et une ligne porte, en un bloc JSON, les lignes modifiées depuis 5 secondes avec les
  colonnes cochées. Le reste ne sort jamais du document.
- Le **transport** est celui de Grist, côté serveur, même quand personne n'a la page ouverte : un
  webhook natif par destinataire, sur `Synchro`, avec une **condition** qui ne laisse passer que
  les lignes de son export. Il écrit dans le journal de la CIBLE, à l'adresse d'écriture d'un
  formulaire publié.
- La **recopie** est faite par le widget, avec les droits de l'éditeur qui ouvre sa page (même
  replié), toutes les 10 secondes : il déplie ce qui est arrivé, recopie chaque table dans sa
  destination, et efface les versions remplacées du journal.
- Une **retouche** faite à la main dans la CIBLE reste en place jusqu'à la prochaine modification
  de la même ligne dans la SOURCE ; un renvoi des mêmes valeurs ne la défait pas.
- Une valeur qui change à cause d'une **autre table** (nom d'une ville renommée, affiché par une
  Référence ; formule) repart seule : `MajLe` suit les colonnes envoyées et leur texte affiché.
- Un **gros changement** (plus de 2 000 lignes environ d'un coup) ne tient pas dans un envoi :
  Grist note dans `Synchro` depuis quand des lignes manquent, et le widget SOURCE envoie le reste
  par tranches, seul, dès qu'un propriétaire ouvre sa page. Un renvoi interrompu (page fermée)
  reprend de même là où il s'était arrêté.
- La CIBLE choisit chaque destination, nouvelle ou existante (correspondance des colonnes,
  rattachement des lignes déjà là par une colonne commune). Une table ajoutée plus tard à
  l'export lui est **proposée dans une fenêtre** : la recevoir, la refuser, ou plus tard.
- **Mode lien public**, au choix par destinataire : un seul code ; la SOURCE est partagée en
  lecture par lien public, et des règles d'accès posées par le widget n'y laissent lire que les
  instantanés des exports publics ; la CIBLE les lit toutes les 10 secondes, page ouverte.

## Installer

Dans chaque document : **Ajouter**, **Ajouter un widget**, **Personnalisé**, **URL
personnalisée**, coller l'adresse du widget, puis choisir **Accès complet** dans l'onglet Widget du
panneau de droite. Les documents doivent être dans un **espace d'équipe** (l'écriture anonyme par
formulaire n'existe pas dans un espace personnel).

## Brancher une synchro (deux codes à copier-coller)

Pas à pas, avec captures d'écran : [`docs/04-tutoriel.md`](docs/04-tutoriel.md).

| Où | Qui | Quoi |
|---|---|---|
| SOURCE, onglet **Envoyer** | un propriétaire | **Nouvel export** : tables, colonnes, nom (rien n'est écrit avant la fin). Puis **Ajouter un destinataire** : mode, secret en option. Il donne un code d'invitation. |
| CIBLE, onglet **Recevoir** | un éditeur | **Accepter une invitation** : coller le code, choisir chaque destination. Le widget publie le formulaire de réception sur sa page et montre où cliquer : **Partager**, **Copier le lien**, coller ce lien. Il donne un code de réponse. |
| SOURCE, onglet **Envoyer** | un propriétaire | **Coller la réponse** : vérifier qui a accepté, **Approuver et brancher**, puis **Envoyer** les lignes déjà là. |

En mode lien public, la deuxième ligne s'arrête au choix des destinations et la troisième
disparaît ; il reste à régler « Lien public » sur Lecture dans le menu Partager de la SOURCE.

Ensuite, côté SOURCE, une carte par export : ses tables, ses destinataires (état, dernier envoi
reçu, pause et reprise avec rattrapage, déblocage de la file, révocation d'une seule personne),
ajout d'un destinataire, modification, renvoi complet, suppression. Côté CIBLE, une carte par
export reçu : e-mail du propriétaire des données, chaque table et sa destination, lignes
non arrivées (gros import), tables proposées, lignes ajoutées, modifiées ou supprimées depuis la
dernière visite (20 au plus par table), synchronisation immédiate, arrêt de la réception.

## Ce que le widget écrit dans les documents

Ses tables techniques n'ont pas de page : elles ne se voient que dans « Données source ». Pas de
table de réglages.

| Document | Ajouts |
|---|---|
| SOURCE | Dans chaque table d'un export : `id_sync` (UUID à la création) et `MajLe` (date du dernier changement d'une valeur envoyée : formule de déclenchement sur les colonnes des exports). Une colonne `Supprime` déjà présente est prise en compte, jamais ajoutée. La table `Synchro` : par table d'un export, une ligne `cles` (liste des clés) et une ligne `lot` (lignes récentes), plus une ligne `complet` (toutes les lignes) pour un export public ; la colonne `Sync_Etat` y note depuis quand des lignes restent à envoyer (envoi coupé, renvoi en cours), jusqu'à ce que le widget les envoie. Un webhook par destinataire, sur `Synchro`, avec la condition de son export ; son mémo garde la fiche du destinataire. Les exports, les invitations en attente (empreinte du secret) et les pauses sont notés dans la description de la colonne `Synchro_Export`. En mode lien public : des règles d'accès marquées « Synchro : lecture limitée aux exports publics ». |
| CIBLE | Les tables de destination, avec leurs colonnes de données plus `id_sync`, masquée de leur page. `Journal_<export>` : les colonnes de `Synchro` (lignes reçues, dépliées puis effacées par le widget), puis par version : table d'origine, clé, date, suppression, bloc des colonnes, et `Sync_Applique`, `Sync_Etat`, `Sync_Par`, `Sync_Recu` (marque, effet, auteur, date d'arrivée). Une section Formulaire publiée par journal, sur la page du widget (sauf en mode lien public). Ce que la CIBLE a choisi (destinations, colonnes, tables refusées) est noté dans la description de la colonne `Synchro_Ids` du journal. |

Les envois créés avant la version 0.4 (vues d'export, tables `Synchro_<table>`, un journal par
table) sont signalés « à refaire », avec un bouton qui efface l'ancien montage.

## Limites connues

- Il faut **Grist 1.7.11** ou plus récent : le widget vérifie au branchement que Grist a bien
  enregistré le filtre du webhook, et refuse sinon.
- Le reste d'un gros changement ne part que lorsqu'un **propriétaire** de la SOURCE ouvre la page
  du widget (Grist ne sait pas programmer un envoi seul). En attendant, la CIBLE dit combien de
  lignes manquent ; **Tout renvoyer** reste possible.
- Les colonnes d'un export valent pour tous ses destinataires ; un renvoi part vers chacun d'eux
  (sans effet chez ceux qui avaient déjà les mêmes valeurs).
- Les tables de destination ne sont à jour que lorsqu'un éditeur ouvre la page du widget ;
  entre-temps les versions attendent dans le journal (mode lien public : rien n'est lu).
- **20 000 lignes au plus par table envoyée** : la liste des clés part entière à chaque ajout ou
  suppression, en un envoi que Grist limite à 1 Mo. Le widget refuse une table plus grande, et
  signale sur la carte une table qui a grandi au-delà.
- Grist regroupe jusqu'à 100 envois en attente d'un même destinataire (CIBLE qui a refusé un
  moment, ajouts très rapprochés) : ensemble, ils peuvent dépasser 1 Mo, et Grist les retenterait
  sans fin. Le widget SOURCE le voit, vide la file et renvoie tout, seul, dès qu'un propriétaire
  ouvre sa page.
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
| `js/core.js` | Logique pure : formules de `Synchro`, lots, dépliage, versions, consolidation, purge, codes, adresses |
| `js/grist.js` | Accès au document (API des widgets) et aux webhooks (API REST, même instance) |
| `js/source.js` / `js/target.js` | Onglets Envoyer / Recevoir |
| `js/tables.js` | Tables techniques (`Synchro`, journal par export) et leurs notes |
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

Le test d'intégration déroule tout le parcours ci-dessus avec trois documents, puis vérifie
l'envoi des lignes existantes, la consolidation, un ajout, une modification, une suppression
logique, une vraie suppression, la conservation d'une retouche manuelle (y compris pendant le
renvoi vers un second destinataire), l'historique, le nettoyage du journal, l'absence de page
technique, la révocation d'une seule personne, l'ajout d'une table à l'export (fenêtre côté CIBLE,
référentiel existant rattaché par une colonne commune) et d'une colonne, la pause et la reprise
avec rattrapage, l'arrêt de la réception, la suppression de l'export, et le mode lien public
(seul l'instantané de l'export est lisible sans identifiant). Avec `CAPTURES=1`, il refait les captures de `docs/images`. Les deux suites tournent à chaque push
(`.github/workflows/tests.yml`).
