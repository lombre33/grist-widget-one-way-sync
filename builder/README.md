# builder : le widget dans le document

Construit **une page HTML autonome** du widget, à coller dans le choix « Créez le vôtre » de Grist (le
*Widget Creator* : le code du widget vit dans le document). Guide de la personne qui l'utilise :
[`docs/09-widget-dans-le-document.md`](../docs/09-widget-dans-le-document.md) (anglais :
[`docs/09-in-document-widget.en.md`](../docs/09-in-document-widget.en.md)). Ce fichier est celui du
développement.

Rien ne change pour le widget servi : `index.html`, `js/`, `css/` et `i18n/` ne contiennent aucune
référence à ce dossier, et le build ne les modifie jamais (il travaille sur des copies en mémoire).

```bash
node builder/build.mjs --instance https://grist.exemple.org --compact --out syncplus-document.html
```

| Fichier | Rôle |
|---|---|
| `build.mjs` | le build : lit `js/`, `i18n/`, `css/`, `index.html` ; exporte `build()`, `checkOrigin()`, `orderModules()` ; ligne de commande sans dépendance |
| `loader.js` | le chargeur, écrit en ligne dans la page : remplace verrous, stockage et canal, puis charge les modules |
| `dist/` | sorties locales, ignorées par Git |

## Comment une page est faite

Grist range le code du widget dans `_grist_Views_section.options` (clé `html`) et l'affiche dans
`<iframe sandbox="allow-scripts" srcdoc=…>` : une page, une origine opaque. Le widget a ~110 modules
JavaScript qui s'importent par adresses relatives : le build les met dans la page et le chargeur les
rend à `import()`.

1. **Lecture** : tous les `js/**/*.js`, plus les JSON que des modules importent (`i18n/*.json`).
2. **Retouches** (`patches()`, appliquées par `applyPatches`) : chaque retouche remplace **un** texte qui doit
   exister **une seule fois** dans son fichier ; sinon le build s'arrête en nommant la retouche (une retouche qui
   ne s'applique plus doit être relue, pas ignorée). Les sept fixes : adresse du widget (`servedAt`), son nom dans
   le diagnostic (`servedFrom`), l'API des widgets déjà chargée par la page (`loadPluginApi`), pas d'ajout du
   widget sur une page (`widget-page.js`), pas de captures du tutoriel (`figure`), les deux images d'aide de
   `form-link.js` écrites en `data:`. Avec options : `GRIST_ORIGINS` (`--instance`), `WIDGET_URL` (`--widget-url`).
3. **Ordre** (`orderModules`) : parcours en profondeur depuis `js/main.js`, chemins triés, donc toujours le même ordre ;
   **un cycle est refusé** (le chargeur ne connaît l'adresse d'un module qu'après l'avoir créé). Le graphe actuel est
   acyclique.
4. **Liaison** (`link`) : chaque adresse relative d'un `import`/`export … from` devient la marque `'@syncplus:<rang>'`
   (le rang du module cité dans l'ordre). Refus : une adresse relative restante, `import()`, `import.meta`, `<!--` ou
   `</script` dans un module (ils casseraient la page).
5. **Chargeur** : les marques `/*SEEDS*/…/*END*/` (préférences d'avance) et `/*ENTRY*/…/*END*/` (rang de `main.js`)
   sont remplacées avant de signer. Au démarrage il installe `navigator.locks` (une file par nom, dans la page),
   `localStorage` et `sessionStorage` (mémoire, gardée dans `window.name` sous le préfixe `syncplus-creator:`),
   retire `BroadcastChannel`, puis crée pour chaque module (dans l'ordre) une adresse `blob:` en remplaçant les
   marques par les adresses déjà créées, et fait `import()` du module de départ.
6. **Politique de sécurité** : balise `<meta http-equiv="Content-Security-Policy">` de la page remplacée par
   `default-src 'none'; script-src 'sha256-<chargeur>' blob: <instances>; connect-src blob: <instances>;
   style-src 'sha256-<styles>'; img-src data:; base-uri 'none'; form-action 'none'`. `blob:` est dans `connect-src`
   parce que le navigateur lit les modules JSON comme une requête. Les instances viennent de `GRIST_ORIGINS` **après
   retouche** : le code et la politique disent donc toujours la même chose.
7. **Charge utile** : un `<script type="text/plain" data-module="…">` par module, ou, avec `--compact`, un seul
   `<script type="text/plain" id="syncplus-payload">` (JSON compressé en gzip puis base64, lu par
   `DecompressionStream`).

Le résultat est **déterministe** (aucune date, aucun hasard) : `result.sha256` (la page) et `result.contentSha256`
(les modules) sont affichés par la ligne de commande. `build({ root })` accepte un autre dossier (les essais y
mettent une copie qu'ils abîment).

## Ce qui a été vérifié, et où

Dans Grist 1.7.22 (image officielle extraite, `tests/e2e/builder.mjs`), widget en accès complet :

- parcours complet d'une synchro à sens unique : export, invitation, réception (création du formulaire, test du
  lien, réponse), approbation, envoi de l'existant, modification reçue par le webhook, sans erreur dans la console ;
- le cadre : `sandbox="allow-scripts"` seul, `allow="clipboard-write"`, `location.origin === 'null'` ; un lien
  `target=_blank` n'ouvre rien ; `navigator.clipboard.writeText` marche ;
- l'invite d'accès : « Le widget a besoin de full access à ce document » avec Accepter, dans le panneau de droite
  (comme un widget servi) ; l'accord est dans `customView.access` de la section ;
- la pose de la page : l'éditeur de Grist (websocket) accepte 576 Ko **et** 1,3 Mo ; l'API REST (`/apply`) refuse
  plus de 1 Mo (413) : `--compact` pour poser par programme ;
- le CSP d'une balise `<meta>` dans `srcdoc` est appliqué (une empreinte fausse bloque le chargeur).

Dans Chromium seulement. Non essayés : Firefox et Safari (`DecompressionStream`, modules depuis des adresses `blob:`
devraient convenir), une instance https réelle derrière un mandataire, une page de plusieurs milliers de lignes de
SOURCE avec deux onglets ouverts.

## Essais

- `npm test` : `tests/unit/builder.test.mjs` (même page à chaque build, aucune adresse relative restante, chaque
  module ne cite que des modules déjà chargés, page compacte égale à la page lisible, politique de sécurité qui
  signe exactement le chargeur et les styles, instances d'accord, `checkOrigin`, cycles, retouches qui échouent
  bruyamment, chargeur dans un contexte `vm` : stockage, verrous, canal). Il lit le dépôt tel quel : il échoue dès
  qu'une retouche ne s'applique plus.
- `tests/e2e/builder.mjs` : le parcours ci-dessus dans un vrai Grist (`ENV_FILE=.env-builder.json`, `homeDb` pour lire
  la clé du formulaire sans Docker ; voir l'en-tête du fichier).
- `tests/tools/figures-widget-dans-le-document.mjs` : les captures du guide.

## Quand le build échoue

« Retouche « … » : 0 occurrence(s) » : le dépôt a changé les lignes qu'elle remplace. Relire la retouche et le
fichier cité, adapter `find`, relancer `npm test`. Ne jamais l'ôter pour faire passer le build : chaque retouche existe
parce que son texte ne marche pas (ou n'a pas de sens) dans le cadre de Grist.
« Cycle entre modules » : un nouvel `import` ferme une boucle ; la casser (déplacer ce que les deux modules partagent
dans un troisième).
« import() et import.meta ne sont pas pris en charge » : un `import()` dynamique ou `import.meta` est entré dans `js/` ;
ils n'ont pas d'équivalent dans la page (les adresses sont des `blob:`).
