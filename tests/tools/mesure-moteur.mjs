// Mesure les fonctions de js/engine/ avec les fonctions mêmes de l'outil d'audit de GFS (`src/moteur/fonctions.js` de
// Grist-widget-audit : complexité de McCabe sur le corps propre de la fonction, lignes de la première à la dernière,
// profondeur des blocs) et ses seuils (`src/regles/a-qualite.js` : 80 lignes, complexité 15, imbrication 5). Ce n'est pas
// l'audit complet (gwaudit), seulement la mesure des fonctions que les consignes de GFS demandent de tenir (006).
//
// Usage : GWAUDIT_DIR=/chemin/vers/grist-widget-audit node tests/tools/mesure-moteur.mjs [dossier, défaut js/engine]
// (dans le dossier de l'outil : `npm install --ignore-scripts --omit=optional` une fois, pour acorn)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const TOOL = process.env.GWAUDIT_DIR;
if (!TOOL) {
  console.error('GWAUDIT_DIR : dossier de l\'outil d\'audit (Grist-widget-audit) requis');
  process.exit(2);
}
const acorn = await import(`${resolve(TOOL)}/node_modules/acorn/dist/acorn.mjs`);
const walk = await import(`${resolve(TOOL)}/node_modules/acorn-walk/dist/walk.mjs`);
const { mesurerFonction, estAutoAppelee, nomDeFonction } = await import(`${resolve(TOOL)}/src/moteur/fonctions.js`);

const SEUILS = { lignes: 80, complexite: 15, imbrication: 5 };
const root = resolve(process.argv[2] || 'js/engine');
const files = [];
(function scan(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) scan(path);
    else if (path.endsWith('.js')) files.push(path);
  }
})(root);

let count = 0;
let [maxLines, maxComplexity, maxNesting] = [0, 0, 0];
const over = [];
for (const file of files.sort()) {
  const ast = acorn.parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const visit = (node, _state, ancestors) => {
    count++;
    const m = mesurerFonction(node);
    const lines = estAutoAppelee(node, ancestors) ? m.lignesPropres : m.etendue;
    [maxLines, maxComplexity, maxNesting] = [Math.max(maxLines, lines), Math.max(maxComplexity, m.complexite), Math.max(maxNesting, m.imbrication)];
    if (lines > SEUILS.lignes || m.complexite > SEUILS.complexite || m.imbrication > SEUILS.imbrication) {
      over.push(`${relative(root, file)}:${node.loc.start.line} ${nomDeFonction(node, ancestors).titre} : ${lines} lignes, complexité ${m.complexite}, imbrication ${m.imbrication}`);
    }
  };
  walk.ancestor(ast, { FunctionDeclaration: visit, FunctionExpression: visit, ArrowFunctionExpression: visit });
}
console.log(`${files.length} fichiers, ${count} fonctions mesurées ; plus grandes valeurs : ${maxLines} lignes, complexité ${maxComplexity}, imbrication ${maxNesting}`);
if (over.length) {
  console.log(`AU-DESSUS DES SEUILS (${over.length}) :\n${over.join('\n')}`);
  process.exit(1);
}
console.log('aucune fonction au-dessus des seuils (81 lignes ou plus, complexité au-dessus de 15, imbrication au-dessus de 5)');
