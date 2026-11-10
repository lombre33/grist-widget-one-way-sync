// Version du moteur. Elle ne suit pas celle de Sync+ : elle change quand le moteur change ce qu'il
// attend du port, ce qu'il écrit dans les documents, ou le sens d'un champ des codes (CODE_FORMAT).
// Mineure : une fonction ou un réglage de plus, sans rien casser. Majeure : un port, un nom de table
// ou un format qui ne se lisent plus comme avant. Elle est dite dans GFS-ETAT.md avec le commit.
// 1.0.0 : le moteur sort de l'écran de Sync+ 0.13.2 (port, préfixe de tables, dossier à part).
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
export const ENGINE_VERSION = '2.5.0';

// Version de l'application qui fait tourner le moteur : elle est écrite dans les codes d'invitation
// et de réponse (qui s'en servent pour avertir d'un code plus ancien ou plus récent, voir
// versionNote). Donnée par startEngine ; à défaut, celle du moteur.
let appVersionValue = ENGINE_VERSION;
export const setAppVersion = (version) => {
  if (version !== undefined && (typeof version !== 'string' || !/^[0-9A-Za-z.+_-]{1,32}$/.test(version))) throw new Error(`version invalide : ${JSON.stringify(version)}`);
  appVersionValue = version || ENGINE_VERSION;
};
export const appVersion = () => appVersionValue;
