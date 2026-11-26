// CIBLE : le bilan des lignes. Chaque lot que la SOURCE envoie annonce combien de clés sa table a
// (`bilan` : { n, t }, t = heure du dernier changement des clés). La CIBLE compte celles qu'elle a
// reçues et ne signale qu'un manque qui dure : un envoi perdu (Grist redémarré, file vidée) ne laisse
// sinon aucune trace, la carte restant « À jour » avec une table incomplète.
//
// Le lot annonce aussi ses dernières modifications (`bilan.r` : [[début de la clé, heure de MajLe]]) : le compte des
// clés ne voit pas une ligne qui a changé d'un côté et pas de l'autre, par exemple quand quelqu'un coupe le webhook à la
// main dans Grist, modifie une ligne, puis le rallume (Grist ne met rien en file pendant la coupure). Une ligne de la
// CIBLE dont la dernière version est plus ancienne que celle que la SOURCE annonce est « en retard » ; elle est gardée
// dans la note (`late`) jusqu'à ce qu'une version assez récente arrive. Une version peut être PLUS récente que MajLe
// (Ctrl+Z, renvoi : la SOURCE les date de leur recalcul) : on compare donc « plus ancienne », jamais « différente ».
//
// Pas de fausse alerte en usage normal :
//  - seul un manque est signalé (reçues < annoncées) ; un surplus (une ligne cochée Supprime puis
//    effacée, une ligne gardée en archive) n'en est pas un ;
//  - un manque qui n'a pas bougé pendant TALLY_GRACE_S secondes de page ouverte (un envoi en route,
//    une liste de suppressions qui n'est pas encore passée, un lot qui arrive dans le désordre
//    changent les comptes avant) ;
//  - rien quand l'écart a déjà son avis (lignes à venir, trop grosses), ni en Échange (les deux
//    côtés écrivent), ni par lien public (instantané), ni en archive (les lignes parties restent) ;
//  - une ligne annoncée qui n'existe pas du tout ici n'est pas « en retard » : c'est une ligne qui manque, dite par le compte.
import { DELETE_COL, KEY_COL, KEY_PREFIX, STATE_COL, isTrue } from './common.js';
import { latestByKey } from './journal.js';

export const TALLY_GRACE_S = 600;
// Lignes en retard gardées dans la note d'une table, au plus.
export const LATE_MAX = 24;

// Annonces notées dans le journal (`was`, par table) mises à jour d'après un dépliage (`announced`,
// par table) : la plus récente (t le plus grand) l'emporte, à égalité la dernière arrivée. Une table
// qui n'est plus reçue (`tables`) est oubliée ; au plus `max` tables.
export function nextTally(was = {}, announced = {}, tables = null, max = 200) {
  const next = { ...was };
  for (const [table, a] of Object.entries(announced)) {
    if (!next[table] || a.t >= next[table].t) next[table] = a;
  }
  const kept = Object.entries(next).filter(([table]) => !tables || tables.includes(table));
  return Object.fromEntries(kept.slice(-max));
}

// Nombre de clés que la SOURCE a encore, d'après les versions du journal (`tableRows` : lignes
// dépliées de la table) : la dernière version de chaque clé, sauf celle d'une clé partie de la SOURCE
// (marquée 'suppression' ou 'partie' sans case Supprime : la case, elle, laisse la ligne dans la
// table de la SOURCE, donc dans son compte).
const GONE = new Set(['suppression', 'partie']);
const isLive = row => isTrue(row[DELETE_COL]) || !GONE.has(row[STATE_COL]);
export function liveKeys(tableRows) {
  let n = 0;
  for (const { row } of latestByKey(tableRows).values()) {
    if (isLive(row)) n++;
  }
  return n;
}

// Début d'une clé, tel que la SOURCE l'écrit dans le bilan (KEY_PREFIX caractères ; Python compte des caractères, JavaScript des
// unités de 16 bits : une clé qui s'écrit en dehors du plan de base se découpe autrement).
export function keyPrefix(key) {
  const text = String(key);
  const head = text.slice(0, KEY_PREFIX);
  return /[\ud800-\udfff]/.test(head) ? Array.from(text).slice(0, KEY_PREFIX).join('') : head;
}

// Annonces de dernières modifications (`entries` : [[début de clé, heure]]) que la table n'a pas : celles dont la ligne existe
// ici, encore suivie, mais dont la dernière version est plus ancienne que l'heure annoncée. Un début de clé qui désigne
// plusieurs lignes compte pour la plus récente d'entre elles (jamais de fausse alerte). `tableRows` : lignes dépliées de la table.
export function lateEntries(entries, tableRows) {
  if (!entries.length) return [];
  const wanted = new Set(entries.map(([prefix]) => prefix));
  const newest = new Map();
  for (const { order, row } of latestByKey(tableRows).values()) {
    const prefix = keyPrefix(row[KEY_COL]);
    if (!wanted.has(prefix) || !isLive(row)) continue;
    const time = typeof order === 'number' ? order : -Infinity;
    if (!(newest.get(prefix) >= time)) newest.set(prefix, time);
  }
  return entries.filter(([prefix, time]) => newest.has(prefix) && newest.get(prefix) < time);
}

// Lignes en retard que la note garde (`late` : { début de clé: heure }), lues sans se fier à leur forme : une note retouchée à la main
// ne doit ni lever d'erreur ni inventer un retard (seules les paires texte et heure lisible comptent).
const keptLate = late => (late && typeof late === 'object' && !Array.isArray(late)
  ? Object.entries(late).filter(([prefix, time]) => prefix && typeof time === 'number' && Number.isFinite(time)) : []);

// Lignes en retard à garder dans la note (`was` : { début de clé: heure }) d'après les annonces d'un dépliage (`batch` :
// [[début de clé, heure]], de tous les lots arrivés) : celles d'avant et les nouvelles qui ne sont toujours pas arrivées.
export function nextLate(was, batch, tableRows) {
  const merged = new Map(keptLate(was));
  for (const [prefix, time] of batch) merged.set(prefix, Math.max(merged.has(prefix) ? merged.get(prefix) : -Infinity, time));
  return Object.fromEntries(lateEntries([...merged], tableRows).slice(-LATE_MAX));
}

// Manque d'une table : { expected, got, gap } si la SOURCE annonce plus de clés qu'il n'en est arrivé ;
// { late, keys } si des lignes ont une version plus ancienne que la dernière modification annoncée ; null sinon
// (pas d'annonce, ou compte complet, ou déjà expliqué par `explained`).
export function tallyGap(announce, tableRows, explained = false) {
  if (!announce || explained) return null;
  const got = liveKeys(tableRows);
  if (got < announce.n) return { expected: announce.n, got, gap: announce.n - got };
  const late = lateEntries(keptLate(announce.late), tableRows);
  return late.length ? { late: late.length, keys: late.map(([prefix]) => prefix).sort() } : null;
}

// Un manque est signalé une fois qu'il a duré TALLY_GRACE_S secondes sans changer (`seen` : table de
// suivi en mémoire de la page, `key` : réception et table). Rend vrai quand il faut le dire. Un manque
// qui change (autres annonces, autres arrivées) repart de zéro ; plus de manque, on oublie.
export function tallyDue(seen, key, gap, now, grace = TALLY_GRACE_S) {
  if (!gap) {
    seen.delete(key);
    return false;
  }
  const sign = gap.late ? `late:${gap.keys.join(',')}` : `${gap.expected}:${gap.got}`;
  const was = seen.get(key);
  if (!was || was.sign !== sign) {
    seen.set(key, { sign, since: now });
    return false;
  }
  return now - was.since >= grace;
}
