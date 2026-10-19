// CIBLE : la recopie, tant qu'un éditeur a la page du widget ouverte. Toutes les 10 secondes, le
// widget demande à Grist quelles tables ont changé (voir due) ; si un journal ou une destination a
// changé, et au moins une fois par minute, chaque journal est déplié, recopié dans ses
// destinations, puis nettoyé. Le résultat de chaque passage est gardé ici pour l'onglet.
import {
  DELETE_COL, EXPORT_COL, HUB, KEY_COL, KIND, LIST_COL, RESEND_COL, SCHEMA_COL, SEAL_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, chunk, nowS, randomHex, sleep,
} from '../logic/common.js';
import { exportTables, returnExportTables } from '../logic/exports.js';
import {
  awaitingPartner, expandRows, isRaw, nextGaps, planPull, planPurge, planUnpack, recentChanges, rowsByTable, sentColumns, touchedTables, unpackActions,
} from '../logic/journal.js';
import {
  WAVE, WAVE_STRICT, copyColumns, destRefs, droppedColumns, exchangeRules, followRenames, manualEdits, planConsolidation, receivedColumns, refusedGaps,
  restoreActions, rowNumbers,
} from '../logic/consolidation.js';
import { resendValue } from '../logic/resend.js';
import { citedFiles, fillActions, filesState, resolveRows, short } from '../logic/files.js';
import { apply, docChanges, docIdentity, fetchRows, isOwner, publicRecords, readSchema, withLock } from '../grist.js';
import { addDestColumnsActions, receivedJournals, receivedKey, updateJournalNote, upgradeJournal } from './journals.js';
import { checkSeals, checkSigned, isUnpacked, sealMark, sealRows, sealer } from '../logic/trust.js';
import { attachments, receiveFiles } from './files.js';
import { readSourceNote, syncRows } from '../source/synchro.js';
import { stopReturn, wireExchange } from '../exchange.js';
import { errorText, failure } from '../ui.js';
import { t } from '../i18n.js';
import { readPref, writePref } from '../prefs.js';

const POLL_MS = 10000;
const IDLE_MS = 60000;
// Décision prise pendant un passage : le suivant est relancé dès que celui-ci finit.
const DECIDE_RETRY_MS = 300;
// Lignes reçues dépliées par passage, au plus ; au-delà de FLOOD_PER_MIN lignes reçues par minute,
// l'arrivée est anormale (le webhook n'en dépose que quelques-unes) : la carte le signale.
const RAW_BATCH = 500;
const FLOOD_PER_MIN = 600;
// Une destination dont le journal n'a pas changé n'est relue, pour y voir les retouches faites à la
// main, que si Grist dit qu'elle a changé (voir due), au retour sur la page, sur « Synchroniser »,
// et au plus tard au bout de 5 minutes.
const REREAD_MS = 300000;
// Retouches, changements à valider et écarts d'un refus : les SHOWN premiers sont gardés pour la
// carte, qui les montre (avec le compte du reste).
export const SHOWN = 10;
// Refus corrigé, chez le document qui administre un Échange : la demande d'envoi posée au lot
// (Synchro_Renvoi, marque FIX_MARK suivie de l'heure) est effacée au premier passage après
// FIX_HOLD_S secondes ; l'envoi est parti depuis longtemps (Grist le met en file aussitôt).
const FIX_MARK = 'refus';
const FIX_VALUE = new RegExp(`^${FIX_MARK}(\\d+):`);
const FIX_HOLD_S = 60;
// Pièces jointes : fichiers attendus notés par table (pour compléter les cellules à leur arrivée,
// voir fillActions), et fichiers trop gros nommés sur la carte, au plus.
const WAITING_KEPT = 1000;
const BIG_KEPT = 20;

// Ce que l'onglet montre. `results` : dernier passage par journal ({ at, rows, gaps } ; { at,
// error, text } en cas d'erreur) et par table reçue (clé `journal|table` : { at, text, table,
// stats, recent, dest, copyCols, labelCol, labelCols, types, drift, droppedCols, driftCount,
// driftGone, pending, gaps, files }, ou { at, error, text }). `drift` : les premières lignes retouchées à la main
// (SHOWN), `droppedCols` : les colonnes reçues effacées ici ([colonne du journal, d'ici]),
// `driftCount` : le nombre de retouches en tout (cellules, lignes et colonnes effacées),
// `driftGone` : celui des lignes effacées. Échange administré ici : `pending`, les changements d'un
// participant à valider ; `gaps`, les lignes refusées restées différentes chez lui (voir
// planConsolidation). `files` : pièces jointes attendues, trop grosses ({ waiting, big, public }).
// `offers` : tables proposées par
// journal ([{ table, columns, n }]). `readOnly` : le document refuse l'écriture (lecteur).
// `lastVisit` : date de la visite précédente sur ce document (secondes), ou 0.
export const state = { results: new Map(), offers: new Map(), readOnly: false, viewer: false, lastVisit: null };
export const tableKey = (journal, table) => `${journal}|${table}`;
// Refus de Grist faute de droits (lecteur) : le widget passe en lecture seule.
export const isAccessError = e => /access|denied|blocked|permission/i.test(e.message);

let busy = false;
let lastArrival = Date.now(); // dernière arrivée dans un journal (ou retour sur la page)
let lastPass = 0; // début du dernier passage
// Coup d'œil sur le document (voir due) : son état au coup d'œil précédent (`hash`), les journaux
// et destinations du dernier passage (`tables`), un journal en lien public (`pull`) ; `compare`
// passe à faux si Grist refuse.
const watch = { hash: '', tables: new Set(), pull: false, compare: true };
let onChange = async () => {}; // l'onglet, redessiné quand un passage a changé quelque chose
const inflow = new Map(); // journal -> { ids, at } : lignes reçues vues au passage précédent
const settled = new Map(); // `journal|table` -> { signature, at } : journal déjà recopié sans effet
const lastRead = new Map(); // `journal|table` -> { numbers, drift } : numéros de ligne et retouches, à la dernière lecture
const pulled = new Map(); // journal -> empreintes des instantanés publics déjà lus
const stopped = new Set(); // Échanges coupés par l'autre document dont l'envoi de retour est arrêté
const decided = new Map(); // `journal|version` -> 'accepter' ou 'refuser', jusqu'au passage qui l'applique
let choices = new Map(); // les décisions prises en compte par le passage en cours

export function startAutoConsolidation(render) {
  onChange = render;
  const tick = async () => {
    if (document.visibilityState === 'visible' && await due()) await consolidateAll();
    setTimeout(tick, POLL_MS);
  };
  setTimeout(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    lastArrival = Date.now();
    consolidateAll({ reread: true });
  });
}

// Un passage est-il dû ? Grist dit quelles tables ont changé depuis le coup d'œil précédent
// (docChanges) : un journal où des lignes sont arrivées, une destination retouchée à la main (elle
// est alors relue), ou le schéma. Sinon un passage par minute suffit (retouche que la comparaison
// n'aurait pas dite). Un lien public, que rien ne signale ici, et le cas où Grist refuse la
// comparaison (droits) gardent le rythme d'avant : toutes les POLL_MS tant que des lignes
// arrivent, puis toutes les minutes.
async function due() {
  if (busy) return false; // un passage en cours : le coup d'œil attend le suivant
  const elapsed = Date.now() - lastPass;
  const steady = elapsed >= (Date.now() - lastArrival > IDLE_MS ? IDLE_MS : POLL_MS);
  if (watch.compare) {
    const changes = await docChanges(watch.hash).catch(() => ({ hash: watch.hash, tables: null }));
    if (changes) {
      const touched = changes.hash === watch.hash ? [] : touchedTables(changes.tables, watch.tables);
      watch.hash = changes.hash;
      if (touched === null) settled.clear();
      else for (const [key, was] of settled) if (touched.includes(was.dest)) settled.delete(key);
      return elapsed >= IDLE_MS || touched === null || touched.length > 0 || (watch.pull && steady);
    }
    watch.compare = false;
  }
  return steady;
}

// Date de la visite précédente, retenue par navigateur et par document : la seule chose que le
// widget garde hors de Grist pour l'historique (aucune donnée des tables).
async function readLastVisit() {
  if (state.lastVisit !== null) return;
  const key = `visit.${(await docIdentity()).docId}`;
  state.lastVisit = Number(readPref(key)) || 0;
  writePref(key, String(Math.floor(nowS())));
}

// Oublie ce qui est gardé d'un journal (réception arrêtée).
export function forgetJournal(journal) {
  for (const key of [...state.results.keys()]) if (key === journal || key.startsWith(`${journal}|`)) state.results.delete(key);
  for (const map of [settled, lastRead]) for (const key of [...map.keys()]) if (key.startsWith(`${journal}|`)) map.delete(key);
  state.offers.delete(journal);
}

// ---------------------------------------------------------------------------------------------
// Un passage sur un journal

// Lien public : lit les instantanés de l'export dans la table Synchro de la SOURCE, sans
// identifiant, et ajoute au journal ce qui a changé, comme l'aurait fait un webhook. Les
// instantanés ne sont relus que si leur empreinte (taille et CRC-32, une petite ligne à part) a
// changé depuis la dernière lecture de cette page. Rend vrai si quelque chose est arrivé.
async function pull(note, journal) {
  const read = kind => publicRecords(note.base, SYNC_TABLE, { [EXPORT_COL]: [note.export], [TYPE_COL]: [kind] });
  const marks = await read(KIND.mark);
  const seen = JSON.stringify(marks.map(r => [r.fields[TABLE_COL], r.fields[LIST_COL]]).sort());
  if (pulled.get(journal) === seen) return false;
  const { actions, tooBig } = planPull({ records: await read(KIND.full), journalRows: await fetchRows(journal), journalTable: journal });
  await apply(actions);
  if (JSON.stringify(tooBig) !== JSON.stringify(note.tooBig || [])) await updateJournalNote(journal, n => ({ ...n, tooBig }));
  pulled.set(journal, seen);
  return actions.length > 0;
}

// Arrivée anormale : plus de FLOOD_PER_MIN lignes reçues par minute depuis le passage précédent.
// Le premier passage d'un chargement ne peut pas le dire (on ne sait pas depuis quand elles sont là).
function flooded(journal, raw) {
  const at = nowS();
  const was = inflow.get(journal);
  inflow.set(journal, { ids: new Set(raw.map(r => r.id)), at });
  if (!was) return false;
  return raw.filter(r => !was.ids.has(r.id)).length > FLOOD_PER_MIN * Math.max(1, (at - was.at) / 60);
}

function nextSuspect(was = {}, rejected, flood) {
  const at = Math.floor(nowS());
  return { n: (was.n || 0) + rejected, at, ...(flood ? { flood: at } : was.flood ? { flood: was.flood } : {}) };
}

// Clé de signature de l'export reçu (voir receivedKey) et sceau des lignes dépliées (voir trust.js).
// Première fois avec une clé, ou clé changée par une nouvelle invitation : les lignes dépliées
// déjà là sont scellées avec elle (confiance à ce moment-là) et son empreinte notée (`sceau`). Une
// fois notée, une clé introuvable (destination effacée, description vidée) arrête la recopie de ce
// journal, au lieu de tout accepter. Sans clé jamais vue (réception d'avant la 0.8, lien public) :
// rien n'est vérifié. Rend { key, seal, note }.
async function sealing(schema, journal, note) {
  const key = note.mode === 'public' ? '' : receivedKey(schema, journal, note);
  if (!key) {
    if (note.sceau) throw failure('keyLost');
    return { key: '', seal: null, note };
  }
  const seal = await sealer(key);
  const mark = await sealMark(seal);
  if (note.sceau === mark) return { key, seal, note };
  sealsSeen.delete(journal);
  const sealed = await sealRows((await fetchRows(journal)).filter(isUnpacked), note.export, seal);
  await apply(chunk(sealed).map(part => ['BulkUpdateRecord', journal, part.map(r => r.id), { [SEAL_COL]: part.map(r => r[SEAL_COL]) }]));
  return { key, seal, note: await updateJournalNote(journal, n => ({ ...n, sceau: mark })) };
}

// Sceaux déjà vérifiés, par journal (voir checkSeals).
const sealsSeen = new Map();

// Lignes du journal sans les lignes dépliées au sceau faux (`forged`, numéros) : ajoutées par la
// clé du formulaire sans passer par le dépliage. Sans sceau (voir sealing) : toutes.
async function trusted(journal, note, rows, seal) {
  if (!seal) return { rows, forged: [] };
  if (!sealsSeen.has(journal)) sealsSeen.set(journal, new Map());
  const { kept, forged } = await checkSeals(rows, note.export, seal, sealsSeen.get(journal));
  return { rows: kept, forged };
}

// Déplie ce qui est arrivé (lignes scellées, voir sealing), efface les lignes au sceau faux, et note
// dans le journal ce qui manque encore, les arrivées suspectes (lignes rejetées ou au sceau faux,
// flot anormal) et la fin de l'envoi annoncée par la SOURCE (`ended`, heure ; effacée si des
// données arrivent ensuite). Avec la clé de signature, les lignes mal signées sont rejetées. Rend
// la note à jour, les lignes du journal, et s'il reste des lignes reçues pour le passage suivant.
async function unpack(journal, { key, seal, note: noteBefore }) {
  let note = noteBefore;
  let rows = await fetchRows(journal);
  const raw = rows.filter(isRaw);
  const flood = flooded(journal, raw);
  const { bad, bare } = key && raw.length ? await checkSigned(raw, key, note.export) : {};
  const plan = planUnpack(rows, journal, { exportId: note.mode === 'public' ? null : note.export, max: RAW_BATCH, now: nowS(), bad, bare });
  if (plan.actions.length) {
    lastArrival = Date.now();
    await apply(seal ? unpackActions(journal, await sealRows(plan.added, note.export, seal), plan.removed) : plan.actions);
    rows = await fetchRows(journal);
  }
  const checked = await trusted(journal, note, rows, seal);
  rows = checked.rows;
  if (checked.forged.length) await apply(chunk(checked.forged).map(ids => ['BulkRemoveRecord', journal, ids]));
  if (!plan.actions.length && !checked.forged.length) return { note, rows, left: 0 };
  const rejected = plan.rejected + checked.forged.length;
  const gaps = nextGaps(note, plan);
  if (rejected || flood) gaps.suspect = nextSuspect(note.suspect, rejected, flood);
  const ended = (plan.ended === undefined ? note.ended : plan.ended && (plan.ended.at || Math.floor(nowS()))) || undefined;
  if (gaps.suspect || ended !== note.ended || JSON.stringify(gaps) !== JSON.stringify({ missing: note.missing || {}, big: note.big || {} })) {
    note = { ...note, ...gaps, ended };
    await updateJournalNote(journal, n => ({ ...n, ...gaps, ended }));
  }
  return { note, rows, left: plan.left };
}

// Tables que la SOURCE a ajoutées à l'export, pas encore rangées ni refusées (`pending`), et
// celles qu'on peut déjà proposer (leurs colonnes sont connues).
function offersOf(groups, note) {
  const known = new Set(note.tables.map(tb => tb.table));
  const pending = [...groups.keys()].filter(table => !known.has(table) && !note.refused.includes(table));
  const offers = pending.map((table) => {
    const tableRows = groups.get(table);
    return { table, columns: sentColumns(tableRows, []), n: new Set(tableRows.map(r => r[KEY_COL]).filter(Boolean)).size };
  }).filter(o => o.columns.length);
  return { pending, offers };
}

// Colonnes d'une table reçue, avant sa recopie : celles qui arrivent (voir receivedColumns),
// celles effacées ici (notées ; l'Échange les recrée, comme avant : la destination repart vers
// l'autre document), et celles qui manquent à la destination, ajoutées tout de suite. Rend
// l'entrée à jour (correspondance, colonnes effacées, numéros des colonnes), les colonnes
// recopiées, leurs types et les colonnes de pièces jointes.
async function prepareColumns(ctx, noted, tableRows) {
  const received = receivedColumns(noted, tableRows, ctx.schema, ctx.allowedFor(noted.dest), Math.floor(nowS()));
  const dropped = ctx.exchange ? [] : droppedColumns(received.entry, received.sent, ctx.schema.columns(received.entry.dest).map(c => c.colId));
  const kept = received.sent.filter(c => !dropped.some(([from]) => from === c.id));
  const added = addDestColumnsActions(ctx.schema, received.entry.dest, kept, received.entry.map);
  if (added.length) {
    await apply(added);
    ctx.schema = await readSchema();
  }
  const entry = { ...received.entry, refs: destRefs(ctx.schema, received.entry.dest), dropped: dropped.length ? dropped.map(([, to]) => to) : undefined };
  const copyCols = copyColumns(received.sent.map(c => c.id), ctx.schema.columns(entry.dest), entry.map);
  const types = Object.fromEntries(received.sent.map(c => [c.id, c.type]));
  return { entry, dropped, copyCols, types, fileCols: copyCols.filter(([from]) => types[from] === 'Attachments') };
}

// Recopie d'une table dans sa destination (voir prepareColumns pour ses colonnes). Rend l'entrée à
// jour (destination renommée, correspondance, colonnes effacées), les compteurs, les colonnes
// recopiées et leurs types, les numéros de ligne et les retouches faites à la main (lus après la
// recopie).
async function copyTable(ctx, noted) {
  const { journal, groups, exchange, hub, swap, rules, decisions } = ctx;
  const renamed = followRenames(noted, ctx.schema);
  if (!ctx.schema.has(renamed.dest)) return { entry: renamed, error: failure('destMissing', { dest: renamed.dest }) };
  const tableRows = groups.get(renamed.table) || [];
  const prepared = await prepareColumns(ctx, renamed, tableRows);
  const { copyCols, types, dropped, fileCols } = prepared;
  let { entry } = prepared;
  const present = fileCols.length ? await ctx.files() : new Map();
  // La destination n'est relue que si le journal de cette table a changé depuis le dernier
  // passage resté sans effet (ou qu'un fichier est arrivé), ou pour y revoir les retouches (REREAD_MS).
  const key = tableKey(journal, entry.table);
  const signature = JSON.stringify([tableRows.map(r => r.id), copyCols, entry.match || '', entry.dest, present.size]);
  const was = settled.get(key);
  if (was && was.signature === signature && Date.now() - was.at < REREAD_MS && lastRead.has(key)) {
    return { entry, stats: { added: 0, updated: 0, removed: 0 }, copyCols, types, dropped, ...lastRead.get(key) };
  }
  // Pièces jointes : la recopie écrit les fichiers que le document a déjà ; ceux qui arrivent
  // ensuite complètent les cellules (fillActions).
  const rows = resolveRows(tableRows, fileCols.map(([from]) => from), present);
  const destRows = await fetchRows(entry.dest);
  const deleteCol = ctx.schema.columns(entry.dest).some(c => c.colId === DELETE_COL);
  const { actions, stats, gone, pending, fix, held } = planConsolidation({
    journalRows: rows, destRows, copyCols, destTable: entry.dest, journalTable: journal, matchCol: entry.match || '', exchange, hub, deleteCol, rules, decisions,
    hold: exchange ? null : ctx.renforce ? WAVE_STRICT : WAVE, wave: ctx.waves.get(entry.table) || '', now: nowS(),
  });
  const presentKeys = new Set([...present.keys()].map(short));
  const fill = fillActions({
    journalRows: tableRows, destRows, copyCols: fileCols, present, destTable: entry.dest, arrived: new Set((entry.waiting || []).filter(k => presentKeys.has(k))),
  });
  // Échange : la ligne 'echange' de l'export est touchée dans le même lot (voir syncFormulas) :
  // les lignes reçues ne repartent pas vers l'autre document. Un refus corrigé, au contraire, fait
  // repartir la ligne d'ici : à part, puis demandé au lot.
  const written = stats.added + stats.updated + stats.removed > 0;
  await apply([...(swap && written ? [['UpdateRecord', SYNC_TABLE, swap.id, { [RESEND_COL]: randomHex(4) }]] : []), ...actions, ...fill]);
  if (fix.actions.length) {
    await apply(fix.actions);
    await askResend(ctx.lots.get(entry.dest), entry.dest, fix.keys);
  }
  if (actions.length || fix.actions.length || fill.length) settled.delete(key);
  else settled.set(key, { signature, at: Date.now(), dest: entry.dest });
  const after = written || fix.actions.length || fill.length ? await fetchRows(entry.dest) : destRows;
  const files = filesState(tableRows, fileCols.map(([from]) => from), present);
  const isPublic = ctx.mode === 'public';
  entry = { ...entry, waiting: files.waiting.length && !isPublic ? files.waiting.map(short).slice(0, WAITING_KEPT) : undefined };
  lastRead.set(key, {
    numbers: rowNumbers(after), drift: manualEdits({ journalRows: rows, destRows: after, copyCols, exchange, except: gone }),
    pending, held, gaps: ctx.review ? refusedGaps({ journalRows: rows, destRows: after, copyCols }) : [],
    files: fileCols.length ? { waiting: isPublic ? 0 : files.waiting.length, big: files.big.slice(0, BIG_KEPT), public: isPublic } : undefined,
  });
  return { entry, stats, copyCols, types, dropped, ...lastRead.get(key) };
}

// Refus corrigé : le lot de la table (`lot`, ligne de Synchro) envoie les lignes corrigées, quoi
// qu'il en soit de leur heure (Synchro_Renvoi, comme un renvoi). La demande est effacée plus tard
// (voir clearFixMarks).
async function askResend(lot, dest, keys) {
  if (!lot || !keys.length) return;
  const wanted = new Set(keys);
  const ids = (await fetchRows(dest)).filter(r => wanted.has(r[KEY_COL])).map(r => r.id);
  if (ids.length) await apply([['UpdateRecord', SYNC_TABLE, lot.id, { [RESEND_COL]: resendValue(`${FIX_MARK}${Math.floor(nowS())}`, ids) }]]);
}

async function clearFixMarks(lots) {
  const now = nowS();
  const age = value => { const m = FIX_VALUE.exec(String(value || '')); return m ? now - Number(m[1]) : -1; };
  const stale = lots.filter(lot => age(lot[RESEND_COL]) > FIX_HOLD_S);
  if (stale.length) await apply(stale.map(lot => ['UpdateRecord', SYNC_TABLE, lot.id, { [RESEND_COL]: '' }]));
}

// Contexte de la recopie d'un journal. Échange : la ligne 'echange' de l'export et, côté du
// document qui a invité (`review`), les colonnes que son export envoie par table, s'il administre
// un Échange à plusieurs (`hub`), ses règles pour les changements reçus (`rules`), les décisions
// prises sur la carte (`decisions`) et les lots de l'export, par table (`lots`). Voir
// planConsolidation.
async function copyContext(schema, journal, note, groups) {
  const exchange = note.mode === 'echange';
  const review = exchange && Boolean(note.retour);
  const rows = exchange ? await syncRows(schema) : [];
  const own = review ? new Map(exportTables(rows, note.export).map(tb => [tb.table, new Set(tb.columns.map(c => c.id))])) : null;
  const swap = rows.find(r => r[EXPORT_COL] === note.export && r[TYPE_COL] === KIND.swap) || null;
  const lots = new Map(rows.filter(r => r[EXPORT_COL] === note.export && r[TYPE_COL] === KIND.lot).map(r => [r[TABLE_COL], r]));
  if (review) await clearFixMarks([...lots.values()]);
  const prefix = `${journal}|`;
  return {
    schema, journal, groups, exchange, swap, review, lots, rows, mode: note.mode, renforce: Boolean(note.renforce),
    waves: new Map([...choices].filter(([k]) => k.startsWith(`${journal}#`)).map(([k, v]) => [k.slice(journal.length + 1), v])),
    hub: Boolean(review && swap && swap[SCHEMA_COL] === HUB),
    rules: review ? exchangeRules(readSourceNote(schema).exports.find(e => e.id === note.export)) : null,
    decisions: new Map([...choices].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [Number(k.slice(prefix.length)), v])),
    allowedFor: dest => (own ? own.get(dest) || new Set() : null),
  };
}

// Notes des tables changées (destination renommée, colonnes arrivées après coup). Échange, côté
// CIBLE : l'export de retour suit (voir followExchange).
// Fusionné dans la note relue au moment d'écrire : une table rangée ou une colonne de nom choisie
// pendant le passage (fenêtres de l'onglet) reste.
async function saveEntries(journal, updates) {
  if (!updates.size) return;
  const noted = ({ dest, map, match, refs, dropped, addedCols, waiting }) => JSON.parse(JSON.stringify({ dest, map, match, refs, dropped, addedCols, waiting }));
  const merged = n => ({ ...n, tables: n.tables.map(tb => (updates.has(tb.table) ? { ...tb, dropped: undefined, waiting: undefined, ...noted(updates.get(tb.table)) } : tb)) });
  await followExchange(await updateJournalNote(journal, merged));
}

// Échange, côté CIBLE : l'export de retour envoie les destinations de la note, avec leurs colonnes.
// Seul un propriétaire peut le changer (Synchro lui est réservée, voir acl.js) : après le passage
// d'un éditeur, celui d'un propriétaire le remet d'accord (`rows` : lignes de Synchro déjà lues).
const exportShape = tables => JSON.stringify(tables.map(tb => [tb.table, tb.columns.map(c => `${c.id}>${c.as || ''}`)]).sort());
async function followExchange(note, rows = null) {
  if (note.mode !== 'echange' || note.retour || !(await isOwner().catch(() => false))) return;
  if (rows) {
    const schema = await readSchema();
    const want = returnExportTables(note, schema);
    if (exportShape(exportTables(rows, note.export)) === exportShape(want)) return;
  }
  await wireExchange(note);
}

// Changements à valider et écarts d'un refus, nommés pour la carte : les SHOWN premiers, et
// toutes les versions à valider (`pendingIds`, pour « Tout accepter »).
const named = (items, labelCol) => items.slice(0, SHOWN).map(({ id, n, state: change, row, cells, gone }) => ({
  id, n, state: change, label: labelCol ? String(row[labelCol] ?? '') : '', cells, ...(gone ? { gone } : {}),
}));
const reviewResult = (pending = [], gaps = [], labelCol = '') => ({
  pending: named(pending, labelCol), pendingIds: pending.map(p => p.id), pendingCount: pending.length, gaps: named(gaps, labelCol), gapCount: gaps.length,
});

// Retouches gardées pour la carte : les premières lignes, nommées, les colonnes effacées et les comptes.
const driftResult = (drift, labelCol, droppedCols) => ({
  drift: drift.slice(0, SHOWN).map(({ n, row, cells, gone }) => ({ n, label: labelCol ? String(row[labelCol] ?? '') : '', cells, ...(gone ? { gone } : {}) })),
  droppedCols,
  driftCount: drift.reduce((sum, d) => sum + (d.gone ? 1 : d.cells.length), 0) + droppedCols.length,
  driftGone: drift.filter(d => d.gone).length,
});

// Ce que la carte montre d'une table : compteurs, colonne qui nomme les lignes, historique (dont
// les colonnes ajoutées par la SOURCE, `added`), valeurs retouchées à la main (`drift`).
function tableResult({ entry, stats, copyCols, types, numbers, drift, dropped, pending, gaps, files, held, error }, groups) {
  if (error) return { table: entry.table, error };
  const labelCol = copyCols.some(([from]) => from === entry.label) ? entry.label : (copyCols[0] || [])[0];
  const recent = recentChanges(groups.get(entry.table) || [], labelCol, state.lastVisit, Infinity, { copyCols, numbers });
  const added = (entry.addedCols || []).filter(a => a.at > (state.lastVisit || 0));
  return {
    table: entry.table, stats, dest: entry.dest, copyCols, labelCol, labelCols: copyCols.map(([c]) => c), types, recent, added, files, held: held || null,
    ...driftResult(drift, labelCol, dropped), ...reviewResult(pending, gaps, labelCol),
  };
}

// « Corriger » : une table reçue reprend l'état exact de la SOURCE (la dernière version reçue de
// chaque ligne), relu au moment du clic : les colonnes effacées ici sont recréées, les lignes
// effacées reviennent, les cellules retouchées reprennent leur valeur. La carte suit aussitôt.
export async function restoreSource(journal, table) {
  const key = tableKey(journal, table);
  const result = state.results.get(key);
  if (!result || !result.copyCols) return;
  const { dest, labelCol, types = {}, droppedCols = [] } = result;
  const copyCols = [...result.copyCols, ...droppedCols];
  await withLock('gristsync-consolidation', async () => {
    if (droppedCols.length) {
      const columns = droppedCols.map(([from]) => ({ id: from, type: types[from] || 'Any', label: from }));
      await apply(addDestColumnsActions(await readSchema(), dest, columns, Object.fromEntries(droppedCols)));
      await updateJournalNote(journal, n => ({ ...n, tables: n.tables.map(tb => (tb.table === table ? { ...tb, dropped: undefined } : tb)) }));
    }
    const fileCols = copyCols.filter(([from]) => types[from] === 'Attachments').map(([from]) => from);
    const schema = await readSchema();
    const { note } = receivedJournals(schema).find(r => r.journal === journal);
    const { seal } = await sealing(schema, journal, note);
    const rows = (await trusted(journal, note, await fetchRows(journal), seal)).rows;
    const journalRows = resolveRows(rowsByTable(expandRows(rows)).get(table) || [], fileCols, fileCols.length ? await attachments() : new Map());
    await apply(restoreActions(manualEdits({ journalRows, destRows: await fetchRows(dest), copyCols }), dest, copyCols));
    const after = await fetchRows(dest);
    const drift = manualEdits({ journalRows, destRows: after, copyCols });
    lastRead.set(key, { numbers: rowNumbers(after), drift });
    state.results.set(key, { ...state.results.get(key), copyCols, ...driftResult(drift, labelCol, []) });
  });
}

// Un passage sur un journal : déplier, recopier chaque table rangée, noter les tables proposées,
// nettoyer. Chaque étape est un seul lot d'écritures, donc tout ou rien.
async function consolidate(schema, { journal, note: noteBefore }) {
  if (noteBefore.mode === 'public' && await pull(noteBefore, journal)) lastArrival = Date.now();
  const trust = await sealing(schema, journal, noteBefore);
  const unpacked = await unpack(journal, trust);
  let { note } = unpacked;
  if (note.ended && note.mode === 'echange' && !note.retour && !stopped.has(note.export)) {
    await stopReturn(note.export).then(() => stopped.add(note.export), () => {});
  }
  // Fichiers du document, lus une fois par passage et seulement s'il en faut.
  let present = null;
  const files = async () => (present ||= await attachments());
  const cited = citedFiles(unpacked.rows, note.tables.flatMap(tb => tb.waiting || []));
  const { rows, rejected } = await receiveFiles(journal, note.export, unpacked.rows, files, cited, !unpacked.left);
  if (rejected) {
    const suspect = nextSuspect(note.suspect, rejected, false);
    note = { ...note, suspect };
    await updateJournalNote(journal, n => ({ ...n, suspect }));
  }
  const groups = rowsByTable(expandRows(rows));
  const { pending, offers } = offersOf(groups, note);
  state.offers.set(journal, offers);
  const ctx = { ...await copyContext(schema, journal, note, groups), files };
  if (ctx.exchange && !ctx.review) await followExchange(note, ctx.rows);
  const tables = [];
  for (const noted of note.tables) {
    const done = await copyTable(ctx, noted);
    tables.push({ ...done, changed: !done.error && JSON.stringify(done.entry) !== JSON.stringify(noted) });
  }
  await saveEntries(journal, new Map(tables.filter(tb => tb.changed).map(tb => [tb.entry.table, tb.entry])));
  const after = (await trusted(journal, note, await fetchRows(journal), trust.seal)).rows;
  await apply(planPurge(after, journal, { keep: pending, drop: note.refused }));
  // Lignes reçues laissées pour le passage suivant : il vient sans attendre la minute.
  if (unpacked.left) lastArrival = Date.now();
  const afterGroups = rowsByTable(expandRows(after));
  return { rows: after.length, note, tables: tables.map(tb => tableResult(tb, afterGroups)) };
}

// ---------------------------------------------------------------------------------------------
// Un passage sur tous les journaux

const summary = s => (s.added || s.updated || s.removed ? t('recv.result', s) : t('recv.result.none'));

// Résultat d'un passage noté pour l'onglet ; rend vrai si la carte change.
function notePass(journal, pass, before, offersBefore, at) {
  // Ce que la carte montre du journal : lignes manquantes, trop grosses, arrivées suspectes, fin.
  const gaps = JSON.stringify([pass.note.missing, pass.note.big, pass.note.suspect, pass.note.ended]);
  state.results.set(journal, { at, rows: pass.rows, gaps });
  let changed = !before || Boolean(before.error) || !before.rows !== !pass.rows || before.gaps !== gaps || offersBefore !== JSON.stringify(state.offers.get(journal) || []);
  for (const tb of pass.tables) {
    const key = tableKey(journal, tb.table);
    const was = state.results.get(key);
    state.results.set(key, tb.error ? { at, error: true, text: errorText(tb.error) } : { at, text: summary(tb.stats), ...tb });
    changed ||= Boolean(tb.error) !== Boolean(was && was.error) || Boolean(tb.stats && tb.stats.added + tb.stats.updated + tb.stats.removed)
      || JSON.stringify([(was && was.drift) || [], (was && was.driftCount) || 0, (was && was.pendingIds) || [], (was && was.gapCount) || 0, (was && was.files) || null, (was && was.held) || null])
        !== JSON.stringify([tb.drift || [], tb.driftCount || 0, tb.pendingIds || [], tb.gapCount || 0, tb.files || null, tb.held || null]);
  }
  return changed;
}

async function passAll() {
  let changed = false;
  lastPass = Date.now();
  choices = new Map(decided);
  let schema = await readSchema();
  let upgraded = false;
  for (const { journal } of receivedJournals(schema)) upgraded = (await upgradeJournal(schema, journal)) || upgraded;
  if (upgraded) schema = await readSchema();
  watch.tables = new Set(receivedJournals(schema).flatMap(r => [r.journal, ...r.note.tables.map(tb => tb.dest)]));
  watch.pull = receivedJournals(schema).some(r => r.note.mode === 'public');
  for (const received of receivedJournals(schema).filter(r => !awaitingPartner(r.note))) {
    const { journal } = received;
    const before = state.results.get(journal);
    const offersBefore = JSON.stringify(state.offers.get(journal) || []);
    const at = nowS();
    try {
      changed = notePass(journal, await consolidate(schema, received), before, offersBefore, at) || changed;
      state.readOnly = state.viewer;
      schema = await readSchema();
    } catch (e) {
      state.readOnly = state.viewer || isAccessError(e);
      state.results.set(journal, { ...before, at, text: errorText(e), error: true });
      changed ||= !(before && before.error);
    }
  }
  for (const k of choices.keys()) decided.delete(k);
  choices = new Map();
  return changed;
}

// Décision prise sur la carte pour des changements à valider (versions du journal `journal`) :
// appliquée par un passage lancé aussitôt, ou par le suivant si un passage est déjà en cours.
export const decide = (journal, ids, choice) => applyDecisions(ids.map(id => `${journal}|${id}`), choice);

// Décision sur une vague de suppressions retenue (table `table` du journal) : 'appliquer' ou
// 'ignorer' (voir WAVE), pour le passage lancé aussitôt.
export const decideWave = (journal, table, choice) => applyDecisions([`${journal}#${table}`], choice);

// Décisions notées, puis un passage, dès que celui en cours est fini.
async function applyDecisions(keys, choice) {
  for (const key of keys) decided.set(key, choice);
  while ((await consolidateAll({ reread: true })) === null) await sleep(DECIDE_RETRY_MS);
}

// Un passage sur tous les journaux. Deux onglets du même navigateur ne recopient pas en même
// temps (verrou du navigateur) ; entre deux navigateurs, les écritures sont idempotentes.
// L'onglet n'est redessiné que si un passage a changé quelque chose. Rend vrai si c'est le cas,
// null si un passage était déjà en cours. `reread` : relire toutes les destinations.
export async function consolidateAll({ reread = false } = {}) {
  if (busy) return null;
  busy = true;
  if (reread) settled.clear();
  let changed = false;
  try {
    await readLastVisit();
    changed = await withLock('gristsync-consolidation', passAll);
  } catch (e) {
    // Document illisible (droits, réseau) : la boucle continue, le prochain passage réessaie.
    if (isAccessError(e)) state.readOnly = true;
    console.warn(e);
  } finally {
    busy = false;
  }
  if (changed) await onChange();
  return changed;
}
