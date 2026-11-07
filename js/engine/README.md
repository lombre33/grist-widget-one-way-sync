# Le moteur de Sync+ (`js/engine/`)

Ce dossier crée, lit, écrit et décide ; il ne dessine rien. Les écrans (`js/source/`, `js/target/`, `js/ui.js`…)
appellent le moteur, jamais l'inverse. Modules ES, sans bibliothèque ni étape de build.

**Version du moteur : `ENGINE_VERSION` dans `version.js`** (1.0.0). Elle ne suit pas la version de Sync+ : elle
change quand le moteur change ce qu'il attend du port, ce qu'il écrit dans les documents ou le sens d'un champ des
codes (`CODE_FORMAT`). Majeure : un port, un nom de table ou un format qui ne se lisent plus comme avant.

## Règles

1. Rien ici n'utilise `document`, `window`, `location`, `navigator`, `localStorage` ni le global `grist`
   (`tests/unit/engine.test.mjs` le vérifie, ainsi que les imports : rien ne remonte vers `js/ui.js` ou un écran).
2. Tout ce qui sort ou entre passe par le `port` (`port.js`). Les modules importent de `port.js` les mêmes noms que
   l'ancien `js/grist.js` ; chaque appel est rendu au port courant, **au moment de l'appel** (rien n'est lu à l'import).
3. Les noms des tables que le moteur crée viennent du préfixe (`SYNC_TABLE`, `JOURNAL_PREFIX`, `destTableId` de
   `logic/common.js`), lus à l'appel et non à l'import.
4. Un texte lu par la personne vient de `port.text(clé, valeurs)` ou d'une erreur prévue (`failure('<code>')`, texte
   `error.<code>`). Le port rend **la clé elle-même** quand elle est inconnue : `errors.js` s'en sert pour reconnaître
   une erreur prévue.

## Démarrer

```js
import { startEngine } from './engine/index.js';
startEngine({ port, prefix: '' });   // une fois, avant tout appel ; le même préfixe pour un même document
```

- `prefix` : texte de 0 à 32 caractères, majuscule en tête (`/^(?:[A-Z][A-Za-z0-9_]{0,31})?$/`, `TABLE_PREFIX_RULE`).
  **Défaut `''` : les noms d'avant** (`Synchro`, `Journal_<export>`, destinations au nom proposé). Avec `Gfs_` :
  `Gfs_Synchro`, `Gfs_Journal_<export>`, destinations `Gfs_<nom>`. Les colonnes (`Synchro_Export`, `id_sync`, `MajLe`…)
  font partie du protocole entre deux documents et ne changent pas. Deux documents qui s'envoient des données avec un
  lien public doivent avoir le même préfixe.
- `port` : voir ci-dessous. `setPort` le refuse s'il est incomplet (`port incomplet : …`).

## Le `port` (`PORT_SHAPE`)

| Groupe | Fonctions |
|---|---|
| Document, avec les droits de la personne | `fetchRows`, `apply`, `readSchema`, `selectRows`, `querySql`, `docIdentity`, `isOwner`, `docChanges` |
| Pièces jointes | `downloadAttachment`, `uploadAttachment` |
| Webhooks (propriétaires) et envois directs | `listWebhooks`, `createWebhook`, `webhookConditions`, `setWebhookEnabled`, `deleteWebhook`, `deleteWebhookWithNotice`, `clearWebhookQueue`, `postToHook`, `postRows` |
| Document public, lu sans identifiant | `publicRecords` |
| Environnement | `withLock(nom, fn)`, `text(clé, valeurs)` |
| `page` | `visible()`, `busy()`, `onShow(fn)`, `onLeave(fn)` |
| `prefs` | `read(nom)`, `write(nom, valeur)` : deux petites valeurs par navigateur (dernière visite d'un document, identifiant du navigateur), jamais une donnée de table |

Sync+ seul remplit ce port avec `js/sync-port.js`. `tests/unit/engine-fake.mjs` en est un autre : un Grist en mémoire.
`readSchema` rend un schéma bâti par `logic/schema.js` (`schemaFrom(lignes de _grist_Tables, lignes de _grist_Tables_column)`).

## Ce que le moteur écrit dans un document

- SOURCE : la table `<préfixe>Synchro` (une seule table technique), les colonnes `id_sync`, `MajLe`, `RecalculLe` de
  chaque table envoyée, des webhooks (via le port), des règles d'accès dont le mémo commence par « Synchro : ».
- CIBLE : une table `<préfixe>Journal_<export>` par réception avec sa page et son formulaire, les tables de destination
  (colonne `id_sync`), des règles d'accès, des pièces jointes.
- Tables internes lues ou écrites : `_grist_Tables`, `_grist_Tables_column`, `_grist_Views`, `_grist_Views_section`,
  `_grist_Views_section_field`, `_grist_Pages`, `_grist_Shares`, `_grist_ACLResources`, `_grist_ACLRules`,
  `_grist_Attachments`.

## Textes

Les clés que le moteur demande au port (`port.text`) sont toutes dans `i18n/fr.json` et `i18n/en.json` :
`recv.archive.col`, `recv.lock.waiting`, `recv.result`, `recv.result.none`, plus les messages d'erreur
`error.<code>` des erreurs prévues. Restent **en français, écrits dans le document** : les mémos des règles d'accès
(« Synchro : réservée aux propriétaires »…), le texte du diagnostic à copier (`logic/diagnostic.js`).
