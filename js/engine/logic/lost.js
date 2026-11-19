// Logique pure : une réception dont le journal a été supprimé. (Ni DOM, ni `grist`, ni réseau.)
//
// Le journal porte tout ce que le widget sait d'une réception (sa note : export, destinations, clé de
// signature) : effacé, il n'en reste rien, et le widget repart de zéro sans rien dire. Mais Grist garde le
// partage de son formulaire quand la page du formulaire disparaît avec la table (vérifié : `_grist_Shares`
// garde la ligne, description comprise). Le widget y note donc, dans `description`, de quoi reconnaître la
// réception : le nom du journal, de l'export et les tables qui reçoivent. Jamais le secret ni une clé :
// le document en garde le texte lisible par qui lit `_grist_Shares`. Une réception sans formulaire (lien
// public) n'a pas de partage, donc pas de marque.
import { cleanLabel } from './codes.js';
import { JOURNAL_PREFIX } from './common.js';
import { journalNote } from './received.js';

const MARK_KEY = 'syncPlus';
// Identifiant de table Grist, tel qu'un journal ou une destination le porte.
const TABLE_ID = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const DESTS_MAX = 100;

// Texte de la marque d'une réception : `journal` et sa `note` (voir receivedJournals).
export function receptionMark(journal, note) {
  const dests = [...new Set((note.tables || []).map(tb => tb.dest).filter(d => TABLE_ID.test(d)))].slice(0, DESTS_MAX);
  return JSON.stringify({ [MARK_KEY]: { journal, name: cleanLabel(note.name), dests } });
}

// Ce que dit la description d'un partage : `{ journal, name, dests }`, ou null (pas de marque, texte
// d'une autre personne ou abîmé).
export function readMark(description) {
  let parsed;
  try { parsed = JSON.parse(String(description || '')); } catch { return null; }
  const mark = parsed && typeof parsed === 'object' ? parsed[MARK_KEY] : null;
  if (!mark || typeof mark !== 'object' || !TABLE_ID.test(String(mark.journal))) return null;
  const dests = Array.isArray(mark.dests) ? mark.dests.filter(d => typeof d === 'string' && TABLE_ID.test(d)).slice(0, DESTS_MAX) : [];
  return { journal: mark.journal, name: cleanLabel(mark.name), dests };
}

// Table qui porte le formulaire de chaque partage : `Map(numéro du partage -> table)`. `forms` : voir formPages (table ->
// { viewRef, shared }) ; `pages` : les lignes de `_grist_Pages`. Une page qui montre plusieurs formulaires ne dit rien.
export function shareTables(forms, pages) {
  const shareOf = new Map(pages.filter(page => page.shareRef).map(page => [page.viewRef, page.shareRef]));
  const out = new Map();
  for (const [table, form] of forms) {
    const share = shareOf.get(form.viewRef);
    if (share && !form.shared && !out.has(share)) out.set(share, table);
  }
  return out;
}

// Réceptions dont le journal n'existe plus sous son nom : `[{ journal, name, shares, dests: [{ dest, there }],
// renamedTo, recognized }]` (`shares` : les lignes de `_grist_Shares` qui la portent ; `there` : la table qui recevait
// existe encore). `renamedTo` : le journal existe encore sous un autre nom (la SOURCE écrit toujours sous l'ancien, que
// Grist ne trouve plus : « Table not found »), sinon ''. On le retrouve par la table du formulaire de la réception
// (`onTable` : voir shareTables), qui suit la table quand on la renomme, et par sa note, que seul un journal porte.
// `recognized` : le widget le reconnaît encore comme journal (son nom commence par le préfixe des journaux).
// `schema` : voir readSchema ; `shares` : les lignes de `_grist_Shares`.
export function lostReceptions(schema, shares, onTable = new Map()) {
  const lost = new Map();
  for (const share of shares) {
    const mark = readMark(share.description);
    if (!mark || schema.has(mark.journal)) continue;
    const known = lost.get(mark.journal);
    if (known) known.shares.push(share.id);
    else lost.set(mark.journal, { journal: mark.journal, name: mark.name, shares: [share.id], dests: mark.dests.map(dest => ({ dest, there: schema.has(dest) })), renamedTo: '', recognized: false });
  }
  for (const entry of lost.values()) {
    const found = entry.shares.map(id => onTable.get(id)).find(table => table && schema.has(table) && (journalNote(schema, table) || {}).export);
    if (found) Object.assign(entry, { renamedTo: found, recognized: found.startsWith(JOURNAL_PREFIX) });
  }
  return [...lost.values()];
}

// Le journal a-t-il été renommé depuis que la marque de son partage a été écrite ? Alors le nom de la marque est celui que
// la SOURCE vise toujours : on le garde (markReceptions ne la réécrit pas) tant que le journal n'a pas repris son nom.
export const renamedSince = (schema, mark, journal) => Boolean(mark) && mark.journal !== journal && !schema.has(mark.journal);
