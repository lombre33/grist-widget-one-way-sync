// CIBLE : réception des pièces jointes. Les morceaux d'un fichier arrivent dans le journal (lignes
// 'fichier', envoyées par le widget SOURCE, voir logic/files.js). Arrivé en entier et vérifié
// (taille, SHA-1), le fichier est déposé dans le document avec les droits de la personne, sauf s'il
// y est déjà, puis ses morceaux sont effacés. Les cellules qui le citent sont remplies par la
// recopie (voir loop.js).
import { apply, fetchRows, uploadAttachment } from '../grist.js';
import { chunk, nowS } from '../logic/common.js';
import { fileArrivals, joinParts, sha1, shaOf, short } from '../logic/files.js';

// Dépôt refusé par Grist (taille maximale de l'instance, droits) : ses morceaux restent, et il
// n'est retenté qu'au bout de RETRY_MS. Gardé ici pour la carte : journal -> Map(empreinte -> { name, error, at }).
const RETRY_MS = 600000;
const refused = new Map();
export const uploadErrors = journal => [...(refused.get(journal) || new Map()).values()];

// Fichiers du document : empreinte -> numéro dans _grist_Attachments.
export async function attachments() {
  const present = new Map();
  for (const a of await fetchRows('_grist_Attachments')) {
    const sha = shaOf(a.fileIdent);
    if (sha && !present.has(sha)) present.set(sha, a.id);
  }
  return present;
}

// Reçoit les fichiers arrivés en entier dans le journal `journal` (lignes `rows`) ; `files()` rend
// les fichiers du document (voir attachments), complétés au fil des dépôts. Un fichier qu'aucune
// version ne cite (`cited`, voir citedFiles) attend la sienne, un jour au plus (il peut arriver
// avant elle), puis est effacé. Rend les lignes qui restent dans le journal et le nombre de lignes
// ou de fichiers rejetés (illisibles, altérés).
export async function receiveFiles(journal, exportId, rows, files, cited) {
  const { ready, stale, rejected } = fileArrivals(rows, exportId, nowS());
  if (!ready.length && !stale.length && !rejected.length) return { rows, rejected: 0 };
  const errors = refused.get(journal) || new Map();
  refused.set(journal, errors);
  const done = [...stale, ...rejected];
  let bad = rejected.length;
  const present = await files();
  for (const file of ready) {
    if (!present.has(file.sha) && !cited.has(short(file.sha))) {
      if (file.old) done.push(...file.ids);
      continue;
    }
    if (!present.has(file.sha)) {
      if (Date.now() - ((errors.get(file.sha) || {}).at || 0) < RETRY_MS) continue;
      const bytes = joinParts(file.data);
      if (bytes.length !== file.size || await sha1(bytes) !== file.sha) {
        bad++;
        done.push(...file.ids);
        continue;
      }
      try {
        present.set(file.sha, await uploadAttachment(file.name, bytes));
        errors.delete(file.sha);
      } catch (e) {
        errors.set(file.sha, { name: file.name, error: e.message, at: Date.now() });
        continue;
      }
    }
    done.push(...file.ids);
  }
  await apply(chunk(done).map(part => ['BulkRemoveRecord', journal, part]));
  const gone = new Set(done);
  return { rows: rows.filter(r => !gone.has(r.id)), rejected: bad };
}
