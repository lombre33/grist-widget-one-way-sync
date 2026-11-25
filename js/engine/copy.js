// La copie unique, côté document : lire les tables et colonnes de ce document, et créer celles d'un texte « Code View » lu
// (js/engine/logic/code-view-parse.js). Une seule fois, sans lien entre les deux documents : le texte passe par un copier-coller.
// Le moteur ne fait que ce qu'une personne a demandé, par ses choix (`choices` de planImport) : il ne reprend aucune valeur de
// table, aucune règle d'accès, aucune page, et il ne touche jamais à une colonne ou une table qui existe déjà.
import { apply, fetchRows, isOwner, withLock } from './port.js';
import { errorText, failure } from './errors.js';
import { parseCodeView } from './logic/code-view-parse.js';
import { readDocument } from './logic/copy-read.js';
import { planImport } from './logic/copy-plan.js';
import {
  addColumnActions, columnActions, createActions, descriptionActions, detailsOf, linkActions, missingDisplays, pairsToLink, refusedNames,
} from './logic/copy-actions.js';

const LOCK = 'gristsync-copy';

// Les tables, colonnes, sections et réglages du document, tels que la copie les lit (voir readDocument).
export async function readCopyDocument() {
  const [tables, columns, sections, info] = await Promise.all([
    fetchRows('_grist_Tables'), fetchRows('_grist_Tables_column'), fetchRows('_grist_Views_section'), fetchRows('_grist_DocInfo'),
  ]);
  return readDocument({ tables, columns, sections, info });
}

// Ce que le texte `text` ferait dans le document d'ici avec les choix `choices` (voir planImport) : rien n'est écrit. Rend le plan et ce
// que le texte a dit à la lecture.
export async function previewImport(text, choices = {}) {
  const parsed = parseCodeView(text);
  return { parsed, plan: planImport(parsed, await readCopyDocument(), choices) };
}

// Les tables du plan que Grist va créer et celles qui reçoivent des colonnes (celles qui n'ont rien à recevoir ne sont pas touchées).
const tablesToCreate = plan => plan.tables.filter(table => table.mode === 'create');
const tablesToFill = plan => plan.tables.filter(table => table.mode === 'add' && table.columns.length > 0);

// Ce qui empêche d'écrire, dit comme une erreur de l'écran : la copie est refusée entière, rien n'est écrit.
function assertWritable(plan, choices, owner) {
  if (plan.work === 0) throw failure('copyNothing');
  const clashing = plan.tables.filter(table => table.problem);
  if (clashing.length > 0) throw failure('copyNotReady', { tables: clashing.map(table => table.tableId).join(', ') });
  if (choices.withFormulas && !owner) throw failure('copyFormulasOwner');
  const refused = refusedNames([...tablesToCreate(plan), ...tablesToFill(plan)].map(table => ({ id: table.tableId, columns: table.columns })));
  if (refused.length > 0) throw failure('copyReserved', { names: refused.join(', ') });
}

// Les tables telles que Grist les a nommées après la création : `retValues` dans l'ordre des actions (une par table à créer, puis une par
// colonne ajoutée). Chaque colonne garde ce que le texte disait d'elle, avec l'identifiant que Grist lui a donné.
function placed(plan, retValues) {
  const created = tablesToCreate(plan).map((table, i) => ({
    id: retValues[i].table_id,
    description: table.description,
    columns: table.columns.map((col, j) => ({ ...col, id: retValues[i].columns[j] })),
  }));
  let next = created.length;
  const filled = tablesToFill(plan).map(table => ({ id: table.tableId, columns: table.columns.map(col => ({ ...col, id: retValues[next++].colId })) }));
  return [...created, ...filled];
}

// Ce que les actions de création ne savent pas faire (descriptions, colonne affichée d'une Référence, identifiant de colonne qui ne
// suit plus son étiquette) : une seconde série d'actions, qui ne défait rien de ce qui est créé si elle échoue ; l'échec est dit.
async function refine(created) {
  const { columns, described } = detailsOf(created);
  if (columns.length === 0 && described.length === 0) return [];
  try {
    const doc = await readCopyDocument();
    const actions = [...descriptionActions(doc, described), ...columns.flatMap(col => columnActions(doc, col))];
    if (actions.length > 0) await apply(actions);
    return missingDisplays(doc, columns).map(missing => ({ key: 'copy.warn.visibleColMissing', params: missing }));
  } catch (e) {
    return [{ key: 'copy.note.refineFailed', params: { error: errorText(e) } }];
  }
}

// Les liens dans les deux sens des colonnes créées ensemble : Grist met l'autre bout d'accord. Un échec est dit sans rien défaire.
async function linkTwoWay(pairs) {
  if (pairs.length === 0) return [];
  try {
    await apply(linkActions(await readCopyDocument(), pairs));
    return [];
  } catch (e) {
    return [{ key: 'copy.note.linkFailed', params: { error: errorText(e) } }];
  }
}

// Écrit ce que le texte `text` demande, avec les choix `choices` (planImport). Le plan est refait au moment d'écrire, sur le document tel
// qu'il est alors : si une table du même nom est arrivée entre l'aperçu et le clic, rien n'est écrit. Tables et colonnes sont créées
// par un seul lot (Grist le défait en entier s'il échoue). Les formules ne sont posées que si la personne l'a demandé (`withFormulas`),
// qu'elle est propriétaire du document et que leur lecture n'a rien trouvé (voir formulaProblems) ; les autres colonnes sont créées vides.
// Rend les tables créées (`created`), celles qui ont reçu des colonnes (`filled`), le plan et ce qui n'a pas pu suivre (`notes`).
export function importText(text, choices = {}) {
  return withLock(LOCK, async () => {
    const parsed = parseCodeView(text);
    const plan = planImport(parsed, await readCopyDocument(), choices);
    assertWritable(plan, choices, choices.withFormulas ? await isOwner() : true);
    const withFormulas = Boolean(choices.withFormulas);
    const actions = [
      ...createActions(tablesToCreate(plan).map(table => ({ id: table.tableId, columns: table.columns })), withFormulas),
      ...tablesToFill(plan).flatMap(table => addColumnActions(table.tableId, table.columns, withFormulas)),
    ];
    const { retValues } = await apply(actions);
    const created = placed(plan, retValues);
    const requested = [...tablesToCreate(plan), ...tablesToFill(plan)].map(table => ({ id: table.tableId, columns: table.columns }));
    const notes = [...await refine(created), ...await linkTwoWay(pairsToLink(requested, created))];
    return {
      plan,
      notes,
      created: created.slice(0, tablesToCreate(plan).length).map(table => ({ tableId: table.id, columns: table.columns.length })),
      filled: created.slice(tablesToCreate(plan).length).map(table => ({ tableId: table.id, columns: table.columns.length })),
    };
  });
}
