# GFS-ETAT : Sync+ (« Synchro Grist »)

Mis à jour le 2026-11-07, au commit `f37cfd9` (le dernier commit de code que cette page décrit). Moteur 1.0.0 ; l'écran de Sync+ reste à la 0.13.2.
Fichier de développement : il ne se publie pas (hors du dépôt public).

## Consignes
- 001 · faite · `f37cfd9` · relevé en partie périmé (ci-dessous)
- 002 · faite · `f37cfd9` · moteur dans `js/engine/`, port, préfixe, version ; les assistants (orchestration) restent côté écran (ci-dessous)

**001, ce que le relevé a de faux ou de périmé** (lu sur 0.12.2 ; `main` était à la 0.13.2) :
- Taille : 10 339 lignes de JavaScript (pas 8 800), toujours sans bibliothèque. Après la 002 : `js/engine/` 6 487 lignes, dont `js/engine/logic/` 4 275 (pas 3 700) ; le reste est écran.
- `js/grist.js` n'est plus « la seule porte » du moteur : le moteur n'appelle plus que son `port`. `js/sync-port.js` branche `js/grist.js` en port ; `js/main.js` (écran) appelle aussi `grist.ready` et `grist.docApi` pour démarrer et vérifier l'accès complet.
- Le moteur écrit aussi la colonne `RecalculLe` (avec `id_sync` et `MajLe`) dans chaque table envoyée, et les colonnes `Sync_*` des journaux.
- Tables internes `_grist_*` lues ou écrites : `_grist_Tables`, `_grist_Tables_column`, `_grist_Views`, `_grist_Views_section`, `_grist_Views_section_field`, `_grist_Pages`, `_grist_Shares`, `_grist_ACLResources`, `_grist_ACLRules`, `_grist_Attachments` ; `_grist_Triggers` (conditions des webhooks) seulement dans le port.
- Juste : une seule table technique `Synchro` côté SOURCE ; un `Journal_…` par réception avec sa page et son formulaire ; règles d'accès dont le mémo commence par « Synchro : » ; webhooks ; même instance pour les deux documents ; Grist 1.7.11 au moins. À ajouter aux limites : un envoi Grist fait 1 Mo au plus (lots de 250 ko au plus, découpés en tranches), file de 1 000 événements par document, renvois sous un budget de 20 Mo par 10 minutes.

**002, ce qui est fait :**
- Dossier `js/engine/` (mode d'emploi : `js/engine/README.md`). Version : `ENGINE_VERSION` = `1.0.0` dans `js/engine/version.js` (elle ne suit pas celle de Sync+).
- Démarrage : `startEngine({ port, prefix })` (`js/engine/index.js`). Port, liste de `PORT_SHAPE` (`js/engine/port.js`, refusé s'il est incomplet) : `fetchRows`, `apply`, `readSchema`, `selectRows`, `querySql`, `docIdentity`, `isOwner`, `docChanges`, `downloadAttachment`, `uploadAttachment`, `listWebhooks`, `createWebhook`, `webhookConditions`, `setWebhookEnabled`, `deleteWebhook`, `deleteWebhookWithNotice`, `clearWebhookQueue`, `postToHook`, `postRows`, `publicRecords`, `withLock`, `text`, `page.{visible, busy, onShow, onLeave}`, `prefs.{read, write}`.
- Préfixe : paramètre `prefix` de `startEngine`, **défaut `''`** (les noms d'aujourd'hui, aucun document existant ne change) ; forme `[A-Z][A-Za-z0-9_]{0,31}`. Avec `Gfs_` : `Gfs_Synchro`, `Gfs_Journal_<export>`, destinations `Gfs_<nom>`. Les noms de colonnes (`Synchro_Export`, `id_sync`, `MajLe`…) sont le protocole entre deux documents et ne changent pas.
- Accès à l'écran dans le moteur : **aucun** (`document`, `window`, `location`, `navigator`, `localStorage`, `grist` : refusés par `tests/unit/engine.test.mjs`, qui vérifie aussi que le moteur n'importe aucun écran).
- Essais : les 248 essais Node passent (les essais d'avant n'ont changé que leurs chemins d'import) ; le parcours complet dans un vrai Grist passe (chemins des fichiers servis seuls adaptés) ; un essai de plus, `tests/unit/engine-port.test.mjs`, fait tourner le moteur sur un Grist en mémoire (`tests/unit/engine-fake.mjs`) avec le préfixe `Gfs_`.
- **Ce qui reste côté écran, sciemment** : l'orchestration des assistants, qui mêle fenêtre et appels du moteur : SOURCE (`checkReply`, `approve`, retour d'un Échange), CIBLE (`readInvitation`, création de la réception, réponse), contrôle horaire des webhooks (`checkHooks` de `js/source/tab.js`), et `js/diagnostic.js` (lit l'état). Sans eux, un écran de GFS appelle les fonctions du moteur (`saveExport`, `createJournal`, `consolidateAll`…) mais refait ces enchaînements.

## Changements qui touchent GFS
- 2026-11-07 · `f37cfd9` · port unique, préfixe de tables, `ENGINE_VERSION` 1.0.0 ; erreurs prévues dans `js/engine/errors.js`
- 2026-11-07 · `7c052b6` · la logique, les pages, les règles d'accès, l'Échange et les parties SOURCE et CIBLE sans écran déménagent dans `js/engine/` (chemins d'import seuls) ; aucune table, colonne ni règle de plus ou de moins, aucune bibliothèque, CSP inchangée

## Questions pour GFS
- Textes : oui, le moteur écrit des textes lus par la personne. Par `port.text` : `recv.archive.col`, `recv.lock.waiting`, `recv.result`, `recv.result.none`, plus 22 messages d'erreur `error.<code>` (liste : `js/engine/README.md`) ; ils sont en français et en anglais dans `i18n/fr.json` et `i18n/en.json`. Restent en français fixe : les mémos des règles d'accès et le texte du diagnostic à copier. GFS veut-il aussi ces deux-là par le port ?
- Les tables de destination créées prennent aussi le préfixe (`Gfs_Contacts`) : est-ce voulu, ou GFS préfère-t-il préfixer seulement `Synchro` et les journaux ?
- Lien public : la CIBLE y lit la table `Synchro` de la SOURCE par son nom ; les deux documents doivent donc avoir le même préfixe (aucun changement de protocole fait). Est-ce le cas dans GFS ?
- Extraire l'orchestration des assistants (liste ci-dessus) dans un second lot, ou GFS écrit-il son propre enchaînement ?
- `apply(actions)` rend `{ retValues }` et accepte une liste vide (sans effet) : à confirmer pour le port de GFS.

## Demandes à GFS
- aucune
