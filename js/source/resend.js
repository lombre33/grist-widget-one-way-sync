// SOURCE : renvois de lignes et de listes des clés, et rattrapage automatique tant qu'un
// propriétaire a la page du widget ouverte. Rien n'est modifié dans les tables : le widget écrit
// les lignes voulues dans Synchro_Renvoi et Grist recalcule le lot.
import { EXPORT_COL, KIND, LIST_COL, LOT_COL, MISSING_COL, RESEND_ALL, RESEND_COL, STATE_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, chunk, nowS, randomHex, sleep } from '../logic/common.js';
import { hookStatus, swapExports, tooLarge } from '../logic/exports.js';
import { parseList, parseLot } from '../logic/journal.js';
import {
  RESEND_CHUNK, addSpent, budgetWait, chargeBusy, chunkMark, dueRows, listRequest, parseCharge, resendValue, rowsSince, trackState,
} from '../logic/resend.js';
import { apply, clearWebhookQueue, fetchRows, listWebhooks, readSchema, selectRows, withLock } from '../grist.js';
import { chargeRow, isCharge, readHooks, recordEvent, syncRows, writeSync } from './synchro.js';
import { planFiles, sendFiles } from './files.js';
import { message, noteError } from '../ui.js';
import { t, timeText } from '../i18n.js';
import { readPref, writePref } from '../prefs.js';

// Rythmes : file d'envoi relue (60 fois au plus, rapprochées au début : un envoi met en général
// moins d'une seconde) ; rattrapage toutes les 10 s, la minute quand l'onglet est caché ; file
// bloquée par un envoi trop gros vidée au plus une fois en 10 minutes ; signe de vie d'un renvoi
// toutes les 20 s ; attente du budget par pas de 30 s au plus. Un document sans table Synchro (qui
// ne fait que recevoir) n'est relu qu'à ce dernier rythme (HIDDEN_MS).
const QUEUE_READS = 60;
const QUEUE_FIRST_MS = 500;
const QUEUE_MS = 1500;
const CATCHUP_MS = 10000;
const HIDDEN_MS = 60000;
const REPAIR_MS = 600000;
const BEAT_S = 20;
const WAIT_STEP_S = 30;

async function waitForQueue(hookIds) {
  for (let i = 0; i < QUEUE_READS; i++) {
    const hooks = (await listWebhooks()).filter(h => hookIds.includes(h.id));
    if (hooks.some(tooLarge)) throw new Error('tooLarge');
    if (!hooks.some(h => h.usage && h.usage.numWaiting)) return;
    await beat();
    await sleep(i < 3 ? QUEUE_FIRST_MS : QUEUE_MS);
  }
  throw new Error('queueStuck');
}

// Vide la file de Grist (commune au document) et marque à renvoyer en entier les lots des exports
// servis : le rattrapage les renvoie ensuite.
export async function clearAndMark() {
  await clearWebhookQueue();
  const [rows, hooks] = await Promise.all([syncRows(), readHooks()]);
  const served = rows.filter(r => r[TYPE_COL] === KIND.lot && hooks.of(r[EXPORT_COL]).some(h => h.fields.enabled));
  await writeSync(served.map(r => r.id), { [MISSING_COL]: RESEND_ALL });
  for (const id of new Set(served.map(r => r[EXPORT_COL]))) await recordEvent(id, 'unblock');
}

// ---------------------------------------------------------------------------------------------
// Renvoi des tables d'un export depuis `since` (secondes ; RESEND_ALL : toutes les lignes), par
// tranches, puis de leur liste complète des clés (voir sendList). La tranche suivante attend que
// les destinataires aient tout reçu (un envoi reste sous la limite de taille de Grist) ; une
// tranche trop grosse pour un lot est coupée en deux. Le renvoi est reprenable : la marque du lot
// (MISSING_COL, voir chunkMark) est posée avant la première tranche et avance avec chacune ; une
// page fermée en cours de route, le rattrapage reprend à la prochaine ouverture. Une marque déjà
// plus ancienne l'emporte. Rend le nombre de lignes renvoyées. Un renvoi à la fois, tous onglets
// confondus, et un seul par document (voir withCharge) : si une autre page renvoie déjà, les lots
// sont seulement marqués, et le rattrapage les enverra ensuite (rend alors null). `out` reçoit
// l'avancement. Un renvoi est noté dans l'historique de l'export (`kind` : 'resend', ou 'catchup'
// pour le rattrapage automatique).
const startOf = (lot, since) => (lot[MISSING_COL] > 0 ? Math.min(lot[MISSING_COL], since) : since);
const lotsOf = async (exportId, tables) => (await syncRows()).filter(r => r[EXPORT_COL] === exportId && tables.includes(r[TABLE_COL]) && r[TYPE_COL] === KIND.lot);

export function resendTables(exportId, tables, out, since = RESEND_ALL) {
  return withLock('gristsync-resend', async () => {
    try {
      return await withCharge(() => resendLocked(exportId, tables, out, since), out);
    } catch (e) {
      if (e.message !== 'resendBusy') throw e;
      for (const lot of await lotsOf(exportId, tables)) await writeSync([lot.id], { [MISSING_COL]: startOf(lot, since) });
      return null;
    }
  });
}

async function resendLocked(exportId, tables, out, since, kind = 'resend') {
  const hookIds = (await readHooks()).of(exportId).filter(h => h.fields.enabled).map(h => h.id);
  if (!hookIds.length) return 0;
  const plans = await markLots(exportId, tables, since);
  const total = plans.reduce((n, p) => n + p.rows.length, 0);
  let done = 0;
  for (const plan of plans) {
    await sendRows(plan, hookIds, (n) => {
      done += n;
      if (!out) return;
      out.replaceChildren(message('info', t('send.load.progress', { done, total })));
      out.scrollIntoView({ block: 'nearest' });
    });
    // Un Échange n'efface rien d'après les listes des clés : inutile de l'envoyer.
    if (!swapExports(await syncRows()).has(exportId)) await sendList(exportId, plan.table, hookIds);
  }
  if (out) out.replaceChildren();
  if (total) await recordEvent(exportId, kind, { n: total });
  return total;
}

// Marque de chaque lot posée avant tout envoi, et lignes à renvoyer. Une table retirée ou
// introuvable est passée : la carte le dit.
async function markLots(exportId, tables, since) {
  const schema = await readSchema();
  const plans = [];
  for (const lot of await lotsOf(exportId, tables)) {
    if (!schema.has(lot[TABLE_COL])) continue;
    const start = startOf(lot, since);
    await writeSync([lot.id], { [MISSING_COL]: start });
    plans.push({ table: lot[TABLE_COL], lot: lot.id, start, rows: rowsSince(await fetchRows(lot[TABLE_COL]), start) });
  }
  return plans;
}

// Lignes d'une table, tranche par tranche. Une table sans ligne à renvoyer part quand même en lot
// de renvoi (vide) : la CIBLE remet à zéro son compte de lignes non arrivées. La marque est
// effacée à part à la fin : écrite avec le lot ordinaire, elle cacherait un nouvel envoi coupé.
async function sendRows({ lot, start, rows }, hookIds, onSent) {
  const queue = rows.length ? chunk(rows, RESEND_CHUNK) : [[]];
  while (queue.length) {
    const part = queue.shift();
    await waitForQueue(hookIds);
    await writeSync([lot], { [RESEND_COL]: resendValue(randomHex(4), part.map(r => r.id)), [MISSING_COL]: part.length ? chunkMark(part, start) : start });
    const cell = String(((await fetchRows(SYNC_TABLE)).find(r => r.id === lot) || {})[LOT_COL] || '');
    await spend(cell.length * hookIds.length);
    const sent = parseLot(cell);
    if (sent && sent.total > sent.lines.length && part.length > 1) queue.unshift(part.slice(0, part.length / 2), part.slice(part.length / 2));
    else onSent(part.length);
  }
  await waitForQueue(hookIds);
  await writeSync([lot], { [MISSING_COL]: 0 });
  await writeSync([lot], { [RESEND_COL]: '' });
}

// Liste complète des clés d'une table, en morceaux, chacun quand le précédent est parti : la CIBLE
// efface les clés absentes une fois tous les morceaux arrivés. Ses lignes sont déjà là : c'est
// elle qui fait partir les suppressions qu'une liste des clés parties n'a pas portées (file vidée,
// pause, trop de clés parties d'un coup). La demande du morceau reste dans la ligne 'cles' jusqu'à
// la fin : une page fermée en cours de route, le rattrapage recommence.
async function sendList(exportId, table, hookIds) {
  const mine = async kind => (await fetchRows(SYNC_TABLE)).find(r => r[EXPORT_COL] === exportId && r[TABLE_COL] === table && r[TYPE_COL] === kind);
  const [keys, track] = [await mine(KIND.keys), await mine(KIND.track)];
  if (!keys) return;
  const overdue = trackState(track).trop;
  const mark = randomHex(4);
  for (let n = 1, after = ''; track; n++) {
    await waitForQueue(hookIds);
    await writeSync([keys.id], { [RESEND_COL]: listRequest(mark, n, after) });
    const cell = String((await mine(KIND.keys))[LIST_COL] || '');
    await spend(cell.length * hookIds.length);
    const { part } = parseList(cell) || {};
    if (!part || part.last || !part.keys.length) break;
    after = part.keys[part.keys.length - 1];
  }
  await waitForQueue(hookIds);
  await writeSync([keys.id], { [RESEND_COL]: '' });
  if (overdue) await writeSync([track.id], { [RESEND_COL]: overdue });
}

// ---------------------------------------------------------------------------------------------
// Rattrapage, tant qu'un propriétaire a la page du widget ouverte : à l'affichage, puis toutes les
// 10 secondes (la minute quand l'onglet est caché), un onglet à la fois.
//  - Envoi refusé pour sa taille (413 : plus de 1 Mo, quand Grist regroupe des envois qui ont
//    attendu) : Grist le retenterait sans fin et la file resterait bloquée. Le widget la vide, et
//    marque à renvoyer en entier chaque export qui a un destinataire actif. Pas plus d'une fois en
//    10 minutes.
//  - Lot marqué (envoi coupé, renvoi interrompu, file vidée) : ses lignes depuis la marque
//    repartent, puis la liste complète. Liste demandée (renvoi de la liste interrompu, trop de clés
//    parties d'un coup) : la liste complète repart. Export sans destinataire : marque et demande
//    effacées (un destinataire ajouté reçoit tout). Destinataires tous en pause : marque gardée
//    pour après la reprise. File bloquée par un autre échec (lien de réception mort) : rien ne part
//    tant que la carte le signale, renvoyer ne ferait qu'attendre.
//  - Pièces jointes : les fichiers que les destinataires n'ont pas encore partent (voir files.js).
// `onDone` est appelé quand quelque chose est parti.
let catching = false;
let notOwner = false;
let repairedAt = 0;
let caughtAt = 0;

export async function catchUp(onDone = () => {}) {
  if (catching || notOwner) return;
  catching = true;
  caughtAt = Date.now();
  try {
    if (await withLock('gristsync-resend', catchUpLocked)) await onDone();
  } catch (e) {
    if (e.message === 'ownerOnly') notOwner = true;
    else if (e.message !== 'resendBusy') {
      console.warn(e);
      noteError(e);
    }
  } finally {
    catching = false;
  }
}

export function startAutoCatchUp(onDone) {
  writePref('browser', BROWSER);
  // Page fermée en plein renvoi : elle rend la main si Grist reçoit encore son écriture (sinon une
  // autre page de ce navigateur la reprend aussitôt, une autre personne après LEASE_S secondes).
  window.addEventListener('pagehide', () => {
    if (charge) apply([['UpdateRecord', SYNC_TABLE, charge.id, { [RESEND_COL]: JSON.stringify({ ...charge.state, par: '', reprise: 0 }) }]]).catch(() => {});
  });
  setInterval(() => {
    if (!document.hidden || Date.now() - caughtAt > HIDDEN_MS) catchUp(onDone);
  }, CATCHUP_MS);
}

async function catchUpLocked() {
  let rows = await lightRows();
  if (!rows) return 0;
  const { hooks, conditions, of: recipients } = await readHooks();
  if (hooks.some(tooLarge) && Date.now() - repairedAt > REPAIR_MS) {
    repairedAt = Date.now();
    await clearAndMark();
    rows = await lightRows();
  }
  if (hooks.some(h => h.fields.enabled && !tooLarge(h) && hookStatus(h)[0] === 'error')) return 0;
  const { late, lists } = dueRows(rows);
  const files = rows.some(r => r[TYPE_COL] === KIND.files) ? await planFiles(hooks, conditions, h => h.fields.enabled && hookStatus(h)[0] !== 'error') : [];
  if (!late.length && !lists.length && !files.length) return 0;
  const active = row => recipients(row[EXPORT_COL]).filter(h => h.fields.enabled).map(h => h.id);
  let sent = 0;
  await withCharge(async () => {
    for (const row of late) {
      if (!recipients(row[EXPORT_COL]).length) await writeSync([row.id], { [MISSING_COL]: 0 });
      else if (active(row).length) await resendLocked(row[EXPORT_COL], [row[TABLE_COL]], null, row[MISSING_COL], 'catchup');
    }
    for (const row of lists) {
      if (!recipients(row[EXPORT_COL]).length) await writeSync([row.id], { [RESEND_COL]: row[TYPE_COL] === KIND.keys ? '' : trackState(row).trop });
      else if (active(row).length) await sendList(row[EXPORT_COL], row[TABLE_COL], active(row));
    }
    sent = await sendFiles(files, spend);
  });
  return late.length + lists.length + sent + files.length;
}

// Lignes de Synchro utiles au rattrapage, sans les lots ni les listes (de grosses cellules), car
// lues toutes les 10 secondes. Null sans la table.
let noSyncAt = 0;
async function lightRows() {
  if (Date.now() - noSyncAt < HIDDEN_MS) return null;
  const rows = await selectRows(SYNC_TABLE, [EXPORT_COL, TABLE_COL, TYPE_COL, RESEND_COL, STATE_COL]);
  if (rows) return rows.filter(r => !isCharge(r));
  if ((await readSchema()).has(SYNC_TABLE)) return syncRows();
  noSyncAt = Date.now();
  return null;
}

// ---------------------------------------------------------------------------------------------
// Renvois ménagés (voir parseCharge) : la ligne 'charge' de Synchro dit quelle page renvoie et ce
// qui est parti ces dix dernières minutes. Une page qui dépasse le budget attend, en donnant signe
// de vie ; une autre page (autre personne, autre navigateur) ne lance rien pendant ce temps.
const BROWSER = readPref('browser') || randomHex(4);
const PAGE = `${BROWSER}.${randomHex(4)}`;
let charge = null; // { id, state, saved, out } pendant un renvoi de cette page

async function readCharge() {
  const rows = await selectRows(SYNC_TABLE, [TYPE_COL, RESEND_COL]);
  return (rows && rows.find(isCharge)) || chargeRow();
}

async function withCharge(fn, out = null) {
  const row = await readCharge();
  const state = parseCharge(row[RESEND_COL]);
  if (chargeBusy(state, PAGE, nowS())) throw new Error('resendBusy');
  charge = { id: row.id, state: { ...state, par: PAGE, reprise: 0 }, saved: 0, out };
  await saveCharge();
  try {
    return await fn();
  } finally {
    charge.state = { ...charge.state, par: '', reprise: 0 };
    await saveCharge().catch(() => {});
    charge = null;
  }
}

// Écrit l'état, avec un signe de vie. Une autre page qui aurait pris la main entre-temps (deux
// renvois lancés au même instant) la garde : celle-ci s'arrête, ses marques restent pour le
// rattrapage.
async function saveCharge() {
  const current = parseCharge((await readCharge())[RESEND_COL]);
  if (charge.state.par && chargeBusy(current, PAGE, nowS())) throw new Error('resendBusy');
  if (!charge.state.par && current.par && current.par !== PAGE) return;
  charge.state.le = nowS();
  charge.saved = nowS();
  await writeSync([charge.id], { [RESEND_COL]: JSON.stringify(charge.state) });
}

// Signe de vie pendant une longue attente (file d'envoi, budget).
async function beat() {
  if (charge && nowS() - charge.saved > BEAT_S) await saveCharge();
}

// Octets partis (une copie par destinataire). Au-delà du budget, attendre que la fenêtre se vide.
async function spend(bytes) {
  charge.state = addSpent(charge.state, nowS(), bytes);
  const wait = budgetWait(charge.state, nowS());
  if (wait > 0) {
    charge.state.reprise = nowS() + wait;
    await saveCharge();
    if (charge.out) charge.out.replaceChildren(message('info', t('send.charge.wait', { at: timeText(charge.state.reprise) })));
    while (nowS() < charge.state.reprise) {
      await sleep(Math.min(WAIT_STEP_S, charge.state.reprise - nowS()) * 1000);
      await saveCharge();
    }
    charge.state.reprise = 0;
  }
  await beat();
}

export function chargeNotice(state) {
  if (state.reprise > nowS()) return message('info', t('send.charge.wait', { at: timeText(state.reprise) }));
  return chargeBusy(state, PAGE, nowS()) ? message('info', t('send.charge.busy')) : null;
}
