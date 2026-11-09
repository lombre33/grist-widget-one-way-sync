# Le moteur de Sync+ (`js/engine/`)

Ce dossier crée, lit, écrit et décide ; il ne dessine rien. Les écrans (`js/source/`, `js/target/`, `js/ui.js`…)
appellent le moteur, jamais l'inverse. Modules ES, sans bibliothèque ni étape de build.

**Version du moteur : `ENGINE_VERSION` dans `version.js`** (2.1.0). Elle ne suit pas la version de Sync+ : elle
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
startEngine({ port, prefix: '', version: '0.13.2' });   // une fois, avant tout appel ; le même préfixe pour un même document
```

- `version` : la version de l'application, écrite dans les codes d'invitation et de réponse (qui s'en servent pour
  avertir d'un code plus ancien ou plus récent). Facultative : `ENGINE_VERSION` à défaut. `appVersion()` la rend.

- `prefix` : texte de 0 à 32 caractères, majuscule en tête (`/^(?:[A-Z][A-Za-z0-9_]{0,31})?$/`, `TABLE_PREFIX_RULE`).
  **Défaut `''` : les noms d'avant** (`Synchro`, `Journal_<export>`, destinations au nom proposé). Avec `Gfs_` :
  `Gfs_Synchro`, `Gfs_Journal_<export>`, destinations `Gfs_<nom>`. Les colonnes (`Synchro_Export`, `id_sync`, `MajLe`…)
  font partie du protocole entre deux documents et ne changent pas. Deux documents qui s'envoient des données avec un
  lien public doivent avoir le même préfixe.
- `port` : voir ci-dessous. `setPort` le refuse s'il est incomplet (`port incomplet : …`).

## Le `port` (`PORT_SHAPE`)

| Groupe | Fonctions |
|---|---|
| Document, avec les droits de la personne | `fetchRows`, `apply`, `readSchema`, `selectRows`, `querySql`, `journalStats`, `docIdentity`, `isOwner`, `docChanges` |
| Pièces jointes | `downloadAttachment`, `uploadAttachment` |
| Webhooks (propriétaires) et envois directs | `listWebhooks`, `createWebhook`, `webhookConditions`, `setWebhookEnabled`, `renameWebhook`, `deleteWebhook`, `deleteWebhookWithNotice`, `clearWebhookQueue`, `postToHook`, `postRows` |
| Document public, lu sans identifiant ; document d'une clé de formulaire | `publicRecords`, `publicAccess(base)` : le droit du lien public du document (`'viewers'`, `'editors'`, `''` s'il est fermé, `null` si Grist ne répond pas), `shareInfo(adresse)` : nom, identifiant, dossier et équipe du document que désigne la clé (requête anonyme à `…/api/s/<clé>`), `null` si la clé n'existe pas, une erreur `shareUnreadable` si Grist ne répond pas |
| Environnement | `withLock(nom, fn)`, `text(clé, valeurs)` |
| `page` | `visible()`, `busy()`, `onShow(fn)`, `onLeave(fn)` |
| `prefs` | `read(nom)`, `write(nom, valeur)` : deux petites valeurs par navigateur (dernière visite d'un document, identifiant du navigateur), jamais une donnée de table |

Contrat de `docChanges(since)` : rend `null` si l'hôte ne sait pas comparer (droits), sinon `{ hash, tables }` où `hash` est le
nouvel état de départ et `tables` l'ensemble des tables touchées depuis `since`, ou **`null` = inconnu, tout relire** (pas
d'état de départ, état que Grist ne connaît plus, table renommée, Grist muet). Un ensemble **vide** ne se rend que pour un
état connu et sans changement : un état perdu ne doit jamais passer pour « rien n'a changé » (`tests/unit/doc-changes.test.mjs`).

**Tout ce qui passe par REST est écrit une fois, dans `createRestPort`** (voir plus bas) : `selectRows`, `querySql`,
`journalStats`, `docChanges`, `isOwner`, les pièces jointes, les webhooks, les envois directs, `publicRecords`, `publicAccess`, `shareInfo`.
Un hôte écrit `fetchRows`, `apply`, `readSchema`, `docIdentity`, `withLock`, `text`, `page`, `prefs`, et donne `http` à
`createRestPort` pour le reste.

Sync+ seul remplit ce port avec `js/sync-port.js`. `tests/unit/engine-fake.mjs` en est un autre : un Grist en mémoire.
`readSchema` rend un schéma bâti par `logic/schema.js` (`schemaFrom(lignes de _grist_Tables, lignes de _grist_Tables_column)`).

## Les requêtes REST : `createRestPort({ docApi, http })` (`rest-port.js`)

```js
import { createRestPort, startEngine } from './engine/index.js';
const rest = createRestPort({ docApi: { fetchRows }, http });
startEngine({ port: { fetchRows, apply, readSchema, docIdentity, withLock, text, page, prefs, ...rest } });
```

`docApi.fetchRows(tableId)` : les lignes d'une table du document (celles de `_grist_Triggers` y sont lues pour la condition
des webhooks). Ce que le moteur écrit lui-même, une fois pour tous les hôtes : la condition d'un webhook relue après sa
création (webhook effacé et erreur `gristTooOld` si elle manque), la file d'un webhook vidée avant son effacement, l'avis de
fin envoyé avant d'effacer (un lien mort ne retient rien), l'envoi direct limité à l'instance du document (`otherInstance`),
les clés abrégées dans les messages d'erreur, la comparaison d'états de `docChanges` (état perdu = inconnu, jamais « rien »),
le SQL de `selectRows` et `journalStats`.

**`http` (fourni par l'hôte, qui ajoute le jeton et décide d'où l'on peut écrire) :**

| Fonction | Rôle |
|---|---|
| `request(méthode, chemin, { body, params, full, timeout })` | REST du document courant. `chemin` relatif à son adresse (`/webhooks`, `/webhooks/queue/<id>`, `/sql`, `/compare`), `params` : paramètres d'adresse (texte, l'hôte les encode), `body` : objet envoyé en JSON, `full` : avec les droits de la personne (sinon lecture seule ; `/sql` et `/compare` demandent `full`), `timeout` en ms. Rend `{ status, body }` (`body` : le JSON lu, `null` si vide). |
| `anonymous(méthode, adresse, { body, timeout })` | Requête **sans jeton** à une adresse complète : clé d'un formulaire (POST de lignes), fiche d'un partage (`…/api/s/<clé>`), document public. L'hôte ne l'autorise que vers le serveur du document. Rend comme `request`. |
| `download(numéro)` | Les octets (`Uint8Array`) de la pièce jointe du document. |
| `upload(nom, octets)` | Dépose un fichier, avec les droits de la personne ; rend son numéro. |
| `docBaseUrl()` | L'adresse REST du document (`https://hôte[/o/équipe]/api/docs/<id>`), ou une promesse qui la rend. |

**Erreurs :** sur tout refus (statut hors 2xx), `request`, `anonymous`, `download` et `upload` **lèvent** une erreur qui porte
`status` (nombre) et `message` (le début du texte de la réponse, 200 caractères au plus) ; sans réponse (réseau muet,
délai dépassé), une erreur **sans** `status`. Le moteur distingue les deux : un refus devient une réponse `{ status }` qu'il
interprète (403 = pas propriétaire, 404 = clé inconnue…), un réseau muet remonte ou vaut « inconnu » selon la fonction.
`tests/unit/rest-port.test.mjs` joue ces cas sur un `http` en mémoire ; `js/grist.js` est l'`http` de Sync+ (jeton `auth=`,
liste des instances).

## Les enchaînements des assistants, sans fenêtre

Un assistant de l'écran de Sync+ est une suite d'étapes ; ce que chaque étape fait quand la personne la valide est dans
le moteur, en fonctions qui prennent des données simples et rendent des données (aucun nœud, aucun texte d'écran :
la personne ne lit que `port.text` ou une erreur prévue, `failure('<code>')`). L'écran (ou GFS) garde les fenêtres,
les boutons et l'ordre des écrans. `tests/unit/engine-flow.test.mjs` joue tout le parcours (SOURCE, CIBLE, un lot
signé recopié) sur deux Grist en mémoire, sans écran.

SOURCE (`source/export.js`, `source/invite.js`, plus `source/actions.js` pour révoquer, suspendre, arrêter) :

| Fonction | Prend | Rend |
|---|---|---|
| `saveChosenExport({ exp?, name, selection, links?, rules? })` | `selection` : `[{ table, columns: [identifiants cochés], filter }]` | `{ id, name, tables, changed, created }` (`created` : l'export tel que l'écran des destinataires l'attend) |
| `finishEdit(exp, { name, changed }, progress?)` | l'export modifié | lignes renvoyées (ou `null` si le renvoi attend son tour) |
| `startInvitation(exp, { renforce? })` | l'export | `{ exp, entry, secret }` : `secret` n'est gardé nulle part |
| `invitationCode(exp, entry, secret, retour?)` | | `{ code, expire, backCode }` (le code à transmettre) |
| `renewInvitation(inv)` | l'invitation en attente | `{ entry, secret }`, ou `null` pour un Échange |
| `enablePublicLink(exp)` | | le code du lien public |
| `startReturn(exp, …)` puis `linkReturn(inv, lien)` | Échange : le lien du formulaire de retour | `{ entry, secret, retour }` |
| `checkReply(exp, inv, texte)` | la réponse collée | la réponse lue et contrôlée chez Grist (`share`, `code` de contrôle, `keys`, `url`, `tables`) |
| `approveReply(exp, inv, reply)` | | l'identifiant du webhook créé |
| `loadPlan(exp)`, `sendExisting(exp, progress?)` | | ce que l'envoi de l'existant coûterait, puis son envoi |

CIBLE (`target/receive.js`) :

| Fonction | Prend | Rend |
|---|---|---|
| `readInvitation(texte)` | le code collé | l'invitation contrôlée (instance, validité, propriétaire pour un Échange, `share`, `backCode`) |
| `knownReception(invitation)`, `canRelink(known, invitation)`, `relinkReception(known, invitation)` | | la réception de cet export qui existe déjà, si elle peut reprendre, et sa reprise (nouvelles clés) |
| `checkDestinations(invitation, plans)` | `plans` : `[{ tb, dest }]` | `{ schema, existing }` : les destinations qui existent déjà (à faire correspondre : `plan.map`, `plan.match`) |
| `createReception(invitation, plans, { reserve?, options? })` | | `{ journal, note, created }` : le journal, son formulaire, les destinations |
| `undoReception({ journal, created })` | | défait la réception qu'on vient de créer |
| `receptionReply({ journal, note }, lien)` | le lien du formulaire collé | `{ code, control }` : le code de réponse et le code de contrôle |
| `myEmail(journal)` | | l'e-mail de la personne connectée, calculé par Grist |

Ce que ces fonctions supposent du port : `shareInfo` (document de la clé du formulaire), `createWebhook` (condition
relue), `isOwner`, `docIdentity`, `apply`, `fetchRows`, `readSchema` et `withLock` pour les notes ; **aucun accès à
l'écran**.

**Le jugement d'un lien collé est dans le moteur, jamais dans un écran** (consigne 005). L'écran affiche des champs, des cases
et des erreurs ; le moteur refuse :
- un lien qui écrirait dans un autre document (`shareOtherDoc`, par `shareInfo` : à la lecture d'une invitation d'Échange, à
  `checkReply`), une clé inconnue ou coupée (`shareUnknown`), Grist muet ou une réponse inattendue (`shareUnreadable`), un
  lien de formulaire qui n'écrit pas dans ce journal (`linkTest`, `linkElsewhere`, par `testUrl`) ;
- une autre instance (`otherInstance`), une invitation périmée (`invitationExpired`, 7 jours ; `invitationState(inv)` dit
  `'link'`, `'expired'` ou `'valid'`), un code plus récent que le moteur, une réponse qui ne vient pas de cette invitation ;
- en sécurité renforcée, un code de contrôle non comparé : `approveReply(exp, inv, reply, { compared })` et, pour un Échange
  renforcé, `checkDestinations(invitation, plans, { compared })` et `createReception(…, { compared })` lèvent
  `codeNotCompared` avant toute écriture si `compared` n'est pas vrai (`mustCompare(invitation)` dit si la CIBLE doit le
  demander) ; la case à cocher est à l'écran, la règle est ici ;
- une signature fausse (`checkSigned`), une clé publique remplacée en route (le code de contrôle change : `controlCode` y met
  ce que chaque côté a lu). Essais : `tests/unit/engine-links.test.mjs`.

Aussi sans écran : le contrôle des webhooks « tenus à jour » (`source/hook-check.js` : `checkHooks(webhooks)`, une
vérification par heure et par destinataire, rend vrai si une fiche a changé ; `hookCheck(id)`, `personLabel(webhook)`) et le
diagnostic à copier (`diagnostic.js` : `diagnostic({ version, served, readOnly, agent })` rend le texte, rien d'autre que
ce que l'hôte dit lui-même n'est supposé : le moteur lit le document par le port).

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
`recv.archive.col`, `recv.lock.waiting`, `recv.result`, `recv.result.none`, les messages d'erreur `error.<code>` des
erreurs prévues, et les 86 clés `diag.*` du diagnostic (`logic/diagnostic.js` reçoit `t` en paramètre et reste pur ; les
nombres y sont donnés en texte, sans séparateur de milliers : le diagnostic se colle dans un message). Reste **en français,
écrit dans le document** : les mémos des règles d'accès (« Synchro : réservée aux propriétaires »…), qui sont des données
lues par des personnes de langues différentes et qui servent à reconnaître les règles du widget.
