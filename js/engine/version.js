// Version du moteur. Elle ne suit pas celle de syncPlus : elle change quand le moteur change ce qu'il
// attend du port, ce qu'il écrit dans les documents, ou le sens d'un champ des codes (CODE_FORMAT).
// Mineure : une fonction ou un réglage de plus, sans rien casser. Majeure : un port, un nom de table
// ou un format qui ne se lisent plus comme avant. Elle est dite dans GFS-ETAT.md avec le commit.
// 1.0.0 : le moteur sort de l'écran de syncPlus 0.13.2 (port, préfixe de tables, dossier à part).
// 2.0.0 (9 novembre 2026) : le port exige quatre fonctions de plus (`shareInfo`, `publicAccess`, `renameWebhook`, `journalStats`),
//         donc un port écrit pour 1.0.0 est refusé par `setPort` tant qu'il ne les a pas : c'est une version
//         majeure au sens ci-dessus. Elles sont toutes dans `createRestPort` (rest-port.js), qui écrit les
//         requêtes REST une fois pour tous les hôtes (l'hôte ne donne que `http`). S'y ajoutent les
//         enchaînements des assistants sans fenêtre (source/export.js, source/invite.js, target/receive.js),
//         le contrôle des webhooks (source/hook-check.js), le diagnostic (diagnostic.js, textes `diag.*` par
//         `port.text`), `version` dans startEngine, et le jugement d'un lien collé tout entier dans le moteur (consigne 005 :
//         `approveReply` et `createReception` exigent `compared` en sécurité renforcée, `invitationState`).
// 2.1.0 (9 novembre 2026) : la CIBLE est passive, elle applique toutes les suppressions de la SOURCE (la retenue des
//         grosses suppressions, `WAVE`, `WAVE_STRICT`, `decideWave`, `held`, est retirée) ; la SOURCE en est avertie après
//         coup (`watchRows`, événement `shrink`, `lignes` dans la note SOURCE). Ni port, ni nom de table, ni format de code
//         ne changent : mineure, mais un hôte qui montrait la carte « Appliquer / Ignorer » n'en a plus l'usage.
// 2.2.0 (9 novembre 2026) : le document de la SOURCE est dit à la CIBLE : l'invitation porte `from.team` et `from.docName` (le nom
//         saisi une fois par la personne, `rememberDocName` de `source/synchro.js` : un widget ne peut pas lire le nom de son
//         document), la note du journal les garde, et `docUrl` (`logic/codes.js`) refait l'adresse du document pour que l'hôte en
//         fasse un lien. Champs facultatifs, ignorés par une version d'avant : ni port, ni nom de table, ni `CODE_FORMAT` ne changent.
// 2.3.0 (9 novembre 2026) : les pièces jointes vont dans les deux sens d'un Échange. L'export de retour garde les
//         colonnes Pièces jointes (`exchangeTables`) ; un fichier reçu du partenaire ne lui est pas renvoyé (`o` dans
//         le suivi `fichiers`, `holdFiles`, `noteHeldFiles`) ; en Échange, une version attend ses fichiers avant
//         d'être recopiée (`waitingVersions`, `plan.waiting`). Ni port, ni nom de table, ni format de code ne changent.
// 2.4.0 (10 novembre 2026) : deux ajouts facultatifs, que l'hôte demande ou non. `createReception(…, { arrange: true })` range la
//         page du formulaire sous celle de la destination (`ensureForm(…, { below })`, `placeBelow`) et note la réception dans la
//         `description` du partage du formulaire (`receptionMark`) ; `markReceptions`, `readLost` et `dismissLost` (`target/lost.js`)
//         disent qu'une réception a existé quand son journal est supprimé. Sans `arrange`, rien ne change : ni port, ni nom de table,
//         ni format de code.
// 2.5.0 (10 novembre 2026) : `docUrl(origin, team, docId, name)` (`logic/codes.js`) écrit l'adresse d'un document comme Grist
//         l'écrit, `<instance>[/o/<équipe>]/<identifiant>/<nom>` (nom facultatif, `docSlug`), au lieu de `/doc/<identifiant>` que
//         l'instance DINUM n'ouvrait pas ; un espace personnel `docs-<numéro>` s'écrit `docs`. Seule l'adresse rendue change : ni port,
//         ni nom de table, ni format de code. Un hôte qui montrait l'adresse de `docUrl` l'obtient sous la nouvelle forme.
// 2.6.0 (10 novembre 2026, consigne GFS 006) : cinq fonctions du moteur passaient les seuils de l'outil d'audit (81 lignes ou plus,
//         complexité au-dessus de 15) : `createRestPort` (226 lignes), `lotFormula` (87), `journalFacts` (complexité 22),
//         `diagnosticText` (18) et `docUrl` (16, depuis la 2.5.0). Elles sont découpées en petites fonctions, **sans changer ce
//         qu'elles rendent** : le texte de `syncFormulas` (`keys`, `lot`, `state`), celui du diagnostic, ce que `docUrl` rend et les
//         requêtes que `createRestPort` fait sont identiques (tests/unit/formulas-golden.test.mjs, garde du texte octet pour octet ;
//         comparaison avant/après sur des milliers de cas pour le reste). La forme du port que rend `createRestPort` (ses vingt noms,
//         dans le même ordre) ne change pas. Aucune formule à réécrire dans les documents déjà partagés. Mineure par convention :
//         rien n'est ajouté ni retiré au port, aux tables ou aux codes.
// 2.6.1 (11 novembre 2026, audit avant la Bêta) : correctif, sans ajout ni retrait. `addEvent` (`logic/notes.js`) ne lève plus
//         d'erreur quand l'historique d'une note SOURCE retouchée à la main n'est pas une liste (il repart d'une liste vide) ; cinq
//         variables locales renommées (`logic/journal.js`, `logic/lost.js`, `logic/notes.js`, `source/estimate.js`,
//         `source/resend.js`). Port, tables, codes et texte des formules inchangés ; essai `tests/unit/robustness.test.mjs`
//         (lectures de données abîmées : aucune exception imprévue).
// 2.7.0 (11 novembre 2026, retour du porteur : une page de budget dupliquée gardait l'écriture américaine et la devise USD) : la
//         mise en forme des colonnes peut partir avec l'export (`saveChosenExport({ …, style: true })`, marque `fmt` par colonne et
//         `doc` sur la première dans la description signée des colonnes) : en-têtes, couleurs, alignement, monnaie résolue (celle
//         de la langue du document quand la colonne n'en a pas) et règles de mise en forme conditionnelle simples. Une règle n'est
//         **jamais copiée** : `logic/rules.js` la lit par une grammaire stricte (comparaisons, et/ou/non, listes littérales,
//         arithmétique, `$Col`), la CIBLE la réécrit avec ses propres noms de colonnes (`printRule`), ce qui sort de la grammaire
//         est abandonné. CIBLE : `target/style.js` (`styleColumns`, `readDocFormat`, `alignDocFormat`), `restyle(journal)`
//         (`target/loop.js`) pour reprendre la mise en forme sur demande ; langue et devise du document (`logic/docformat.js`) :
//         l'écart est dit, le réglage du document n'est écrit que par `alignDocFormat`, sur un geste d'un propriétaire. Lit
//         `_grist_DocInfo` (SOURCE et CIBLE). Ni port, ni nom de table, ni `CODE_FORMAT`, ni texte des formules ne changent : un
//         export sans `style` envoie exactement la description d'avant (essai `engine-format`, `formulas-golden`), une version
//         d'avant ignore les champs en plus.
// 2.8.0 (12 novembre 2026, demande du porteur : « les éléments de mise en forme, plus globalement tout ce qu'il serait bien de reprendre »,
//         d'après le widget d'import/export de structure) : les descriptions des colonnes et des tables peuvent partir avec l'export
//         (`saveChosenExport({ …, notes, tableNote })`, clés `desc` et `tdesc` de la description signée des colonnes, nettoyées et
//         bornées par `logic/descriptions.js`). CIBLE : `target/describe.js` les pose sur les colonnes créées par le moteur, une
//         fois, et sur la table si sa description est vide ; `restyle(journal, elements)` reprend sur demande les éléments choisis
//         (`style`, `notes`, `table`) ; la note de chaque table garde `sends`, `described`, `tabled`. Le moteur lit
//         `_grist_Views_section` (`fetchRows`). Ni port, ni nom de table, ni `CODE_FORMAT`, ni texte des formules ne changent.
// 2.9.0 (12 novembre 2026, demande du porteur : « également prévoir de pouvoir sync les formules […] une case à part et un message
//         qui demande si l'user est sûr de le vouloir avec les risques de passer du python ») : les formules des colonnes peuvent partir
//         avec l'export (`saveChosenExport({ …, formulas })`, clé `fx` de la description signée des colonnes, nettoyée et bornée par
//         `logic/column-formulas.js`). CIBLE : un passage ne pose jamais une formule, il les lit (`formulas` dans le résultat de chaque
//         table) ; `restyle(journal, { formulas: true })`, sur le clic d'un propriétaire après lecture, transforme en colonnes de formule
//         celles que le moteur a créées et dont la formule n'a pas d'objection (`target/formulas.js`). Ni port, ni nom de table, ni
//         `CODE_FORMAT`, ni texte des formules de `Synchro` ne changent.
// 3.0.0 (12 novembre 2026, vérification du lien public demandée par le porteur : « regarder si un user qui arrive sur le lien voit les
//         tables gérées par le widget », puis choix « Notes à l'abri, complet ») : les notes du widget (SOURCE : `Synchro_Export` ;
//         CIBLE : `Synchro_Ids` du journal et clé de signature d'`id_sync`) ne sont plus dans la description des colonnes mais dans leurs
//         options (`widgetOptions`, clé `syncNote`, voir `columnNote` de `logic/common.js`) : Grist vide les options d'une colonne qu'un
//         lecteur ne lit pas, pas sa description, et `_grist_Tables_column` se lit en anonyme sur un document public. Les documents
//         d'avant sont lus tels quels puis déplacés (`moveNotes` de `note-move.js`, appelé par `ensureSyncTable` et par chaque passage de
//         recopie, `legacyNoteActions` de `logic/note-store.js`) ; une règle d'accès de plus (`keyAclRules`, mémo `KEY_MEMO`) cache la
//         colonne `id_sync` des tables qui portent une clé de signature aux lecteurs, posée par `syncRules`. Majeure au sens ci-dessus :
//         un moteur 2.x ne lit pas les notes d'un document 3.x (il les croit vides et pourrait les réécrire), donc tous les onglets d'un
//         même document doivent avoir le moteur 3 (recharger les onglets ouverts). Ni port, ni nom de table, ni `CODE_FORMAT`, ni texte
//         des formules de `Synchro` ne changent.
// 4.0.0 (12 novembre 2026, audit des fuites d'information demandé par le porteur : « vérifier toutes les approches possibles qui seraient
//         exploitées pour accéder à la donnée en récupérant des infos mal protégées ») : MAJEURE parce que le mémo d'un webhook ne dit plus
//         rien du destinataire. Grist montre `_grist_Triggers` (mémo compris) à toute personne qui lit le document, lien public compris :
//         le mémo n'est plus qu'un jeton (`r-` et douze chiffres hexadécimaux), la fiche « e-mail · document · équipe/nom » est dans la note
//         de la SOURCE (`dest`, `putDest`, `identifyHooks` de `logic/notes.js`), remise dans les webhooks que lit le moteur (`readHooks`) ;
//         `rememberDest` la range avant de créer un webhook, `protectMemos` (propriétaires, à l'affichage) donne un jeton aux webhooks
//         d'avant et retire les fiches des destinataires partis. Un moteur 3.x lit le jeton comme un nom de destinataire et écrit encore la
//         fiche dans le mémo : `protectMemos` la reprend. Sont aussi dans cette version : (1) les règles d'accès de `Synchro` se posent AVANT la
//         première donnée d'un export (`protectSync` de `acl.js` : table créée vide, règles posées même pendant un assistant, le document se
//         recharge avant que l'assistant s'ouvre ; `syncUnprotected` pour un Échange reçu ; `createSyncTable` de `source/synchro.js`) ; (2) un
//         refus de Grist à poser les règles n'est plus tu (`ruleRefusal`, `syncRules({ strict })`) ; (3) sans Échange, `ownerAclRules` n'est plus
//         qu'un refus sans condition de ligne pour qui n'est pas propriétaire, ce qui cache aussi la note de la SOURCE aux éditeurs (Grist vide
//         les options d'une colonne illisible) ; avec un Échange, les règles d'avant restent. Port : `renameWebhook(id, nom, mémo?)` prend un
//         mémo facultatif (`createRestPort`), `PORT_SHAPE` ne change pas. Ni nom de table, ni `CODE_FORMAT`, ni texte des formules de `Synchro` ne
//         changent. Tous les onglets d'un même document doivent avoir le moteur 4 : un onglet 3.x resté ouvert repose les règles d'avant à
//         chaque affichage (le document se recharge) et réécrit la fiche dans le mémo ; recharger les onglets.
// 4.1.0 (12 novembre 2026, demande du porteur après la carte « Combien de temps garder les valeurs d'une ligne supprimée dans le journal de la CIBLE ? »,
//         réponse « Comme aujourd'hui » : « un bouton pour effacer manuellement l'historique et nettoyer les journaux, côté CIBLE et SOURCE ») :
//         deux fonctions de plus, sur demande seulement (aucun passage ne purge seul). `cleanJournal(journal)` (`target/clean.js`) vide dans un
//         journal reçu l'avant des modifications et le numéro des lignes supprimées (`Sync_Avant`) ainsi que les valeurs de la dernière version
//         d'une clé supprimée ou partie (`Synchro_Donnees`, rescellée avec la clé de signature de l'export), et note `histo` dans la note du
//         journal : avant cette heure, l'historique de la carte ne montre plus rien (`tableResult`). Rien n'est vidé en Échange (les valeurs y
//         servent à comparer) ni pour un changement refusé. `clearExportHistory(exportId)` (`source/history.js`) efface l'historique des envois de la
//         note SOURCE (`clearEvents` de `logic/notes.js` : des repères d'ajout et de retrait restent, sans nom ni nombre, pour les destinataires
//         disparus et les clés de signature) et nettoie les journaux de retour de cet export. Ni port, ni nom de table, ni `CODE_FORMAT`, ni texte
//         des formules de `Synchro` ne changent ; la note du journal gagne une clé facultative, ignorée d'un moteur plus ancien.
// 4.2.0 (12 novembre 2026, réponse du porteur au point 14 de l'audit de sécurité : sur DINUM les webhooks sont limités à l'instance ; ailleurs,
//         il faut demander à l'administrateur d'être dans la liste autorisée) : un code d'erreur de plus. Grist refuse par 403 « Provided url is
//         forbidden » un webhook dont l'adresse n'est pas dans la liste des domaines autorisés de l'instance (`ALLOWED_WEBHOOK_DOMAINS`, vérifié sur
//         Grist 1.7) ; le moteur rendait `ownerOnly` pour tout 403, donc « réservé aux propriétaires » à un propriétaire. `restOf` (rest-port.js) rend
//         maintenant `webhookForbidden` pour ce refus (reconnu au texte que l'`http` de l'hôte met dans `message`), `ownerOnly` pour les autres 403.
//         Un hôte ajoute le texte `error.webhookForbidden` ; sans lui, la phrase générique cite le code. Ni port, ni table, ni code, ni formule ne changent.
// 4.3.0 (12 novembre 2026, demande du porteur : « ajouter sur la carte de réception un bouton « Ajouter le widget à la page de la table
//         reçue » ») : deux fonctions de plus, que l'hôte appelle ou non (`pages.js`). `widgetSpots(tables, url)` dit, pour chaque table, la page
//         qui la montre et si le widget d'adresse `url` y est déjà ; `addWidgetToPage(table, url)` ajoute à cette page une section
//         « Personnalisée » sur `url`, **sans l'accès accordé** (`access: 'none'` : Grist le demande à la personne, le moteur ne se le donne
//         jamais), une seule fois (verrou `gristsync-widget-page`), et lève `noPageForTable` ou `badWidgetUrl`. L'adresse est donnée par l'hôte
//         (le moteur ne lit pas `location`) et reprise telle que la personne l'a écrite si une section du document est déjà ce widget
//         (`logic/page-widget.js` : `widgetAddress`, `customUrl`, `widgetSpot`, `sectionUrl`, `customOptions`). Ni port, ni nom de table, ni
//         `CODE_FORMAT`, ni texte des formules de `Synchro` ne changent.
export const ENGINE_VERSION = '4.3.0';

// Version de l'application qui fait tourner le moteur : elle est écrite dans les codes d'invitation
// et de réponse (qui s'en servent pour avertir d'un code plus ancien ou plus récent, voir
// versionNote). Donnée par startEngine ; à défaut, celle du moteur.
let appVersionValue = ENGINE_VERSION;
export const setAppVersion = (version) => {
  if (version !== undefined && (typeof version !== 'string' || !/^[0-9A-Za-z.+_-]{1,32}$/.test(version))) throw new Error(`version invalide : ${JSON.stringify(version)}`);
  appVersionValue = version || ENGINE_VERSION;
};
export const appVersion = () => appVersionValue;
