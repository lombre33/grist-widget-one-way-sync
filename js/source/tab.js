// Onglet « Envoyer » (document SOURCE) : une carte par export (un nom, des tables et leurs
// colonnes) avec ses destinataires. Une seule table technique, Synchro ; un webhook par
// destinataire, filtré par Grist sur les lignes de son export.
import { EXPORT_COL, KIND, LOT_COL, RESEND_COL, SCHEMA_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, nowS } from '../engine/logic/common.js';
import { maskKey } from '../engine/logic/codes.js';
import { conditionExport, exportDrift, exportEmail, exportStatus, exportTables, failureStatus, hookBusy, hookErrorKey, hookStatus, hooksOf, NO_UNBLOCK, queueBlocker, readTables } from '../engine/logic/exports.js';
import { editorsEditStructure, hiddenTables } from '../engine/logic/acl.js';
import { STATES, parseLot } from '../engine/logic/journal.js';
import { eventsOf, vanishedRecipients } from '../engine/logic/notes.js';
import { exchangeRules } from '../engine/logic/consolidation.js';
import { listDue, lotLate, parseCharge } from '../engine/logic/resend.js';
import { flowMoves } from '../engine/logic/health.js';
import { LONG_SECONDS } from '../engine/logic/estimate.js';
import { deleteWebhook, docIdentity, fetchRows, listWebhooks, publicAccess, readSchema, webhookConditions } from '../grist.js';
import { expiresAt, unkeyedRecipients } from '../engine/logic/trust.js';
import { columnFault, foreignSync, hasContent, lostSync, ownsSync, refusedColumn, strayColumns, syncColumnIds } from '../engine/logic/strays.js';
import { syncRules } from '../engine/acl.js';
import { ensureSyncTable, isCharge, readSourceNote, refreshMajLe, refreshOptions } from '../engine/source/synchro.js';
import { catchUp, currentCharge, flowOf, resendTables } from '../engine/source/resend.js';
import { exportEstimate } from '../engine/source/estimate.js';
import { checkHooks, hookCheck, personLabel } from '../engine/source/hook-check.js';
import { invitationState } from '../engine/source/invite.js';
import { confirmSend, flowView } from './flow.js';
import { filesPending, resendFiles } from '../engine/source/files.js';
import { cancelInvitation, deleteExport, pause, resume, revoke, showPublicCode, stopPublic, unblockQueue } from './actions.js';
import { exportWizard } from './export-wizard.js';
import { foreignDialog, strayDialog } from './strays.js';
import { checkKeys } from '../engine/source/keys.js';
import { keysBlock } from './keys.js';
import { filterSummary } from './filter-editor.js';
import { recipientWizard } from './recipient-wizard.js';
import { confirmDialog, el, icon, message, noteError, pill, redraw, reloading, run, smallButton } from '../ui.js';
import { roleGuide } from '../guide.js';
import { dateText, t } from '../i18n.js';

let container;
let notice = null; // message à montrer au prochain affichage (fin d'un renvoi)
let resumed = false; // l'assistant d'un Échange ne se rouvre seul qu'une fois par chargement

// ---------------------------------------------------------------------------------------------
// État du document : exports (note + lignes Synchro), destinataires (webhooks sur Synchro, rangés
// par l'export que nomme leur condition), invitations en attente.

async function loadState() {
  let hooks = [];
  let ownerOnly = false;
  try { hooks = await listWebhooks(); } catch (e) { if (e.message !== 'ownerOnly') throw e; ownerOnly = true; }
  const conditions = ownerOnly ? new Map() : await webhookConditions();
  const schema = await readSchema();
  // Une table nommée Synchro qui n'est pas celle du widget n'est pas lue (voir foreignSync).
  const all = ownsSync(schema) ? await fetchRows(SYNC_TABLE) : [];
  const rows = all.filter(r => !isCharge(r));
  const note = readSourceNote(schema);
  // Règles d'accès (lisibles par un propriétaire seulement) : revérifiées à chaque affichage.
  const [resources, aclRules] = ownerOnly ? [[], []] : await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const acl = { resources, rules: aclRules };
  const ids = [...new Set([...note.exports.map(e => e.id), ...rows.map(r => r[EXPORT_COL])])];
  const exports = ids.map(id => exportState(id, { note, rows, schema, acl, recipients: hooksOf(hooks, conditions, id) }));
  const unsafe = hooks.filter(h => h.fields.tableId === SYNC_TABLE && !conditionExport(conditions.get(h.id)));
  const charge = parseCharge((all.find(isCharge) || {})[RESEND_COL]);
  // Colonnes de Synchro qui ne sont pas au widget : un envoi les emporte, un journal les refuse.
  const syncCols = ownsSync(schema) ? schema.columns(SYNC_TABLE).map(c => c.colId) : [];
  const strays = ownerOnly || !syncCols.length ? [] : strayColumns(schema.columns(SYNC_TABLE), all);
  // Lignes sans clé ou de même clé dans les tables envoyées : elles n'arrivent pas chez les destinataires.
  const keys = ownerOnly ? new Map() : await checkKeys(exports.flatMap(exp => exp.tables.map(tb => tb.table)));
  const blocker = queueBlocker(exports.flatMap(exp => exp.recipients));
  // Synchro perdue (effacée, renommée, illisible) alors que des webhooks du widget restent : voir lostSync.
  const lost = ownerOnly ? null : lostSync(schema, hooks, conditions);
  return { ownerOnly, schema, rows, note, exports, unsafe, charge, strays, syncCols, keys, blocker, lost, foreign: !ownerOnly && !lost && foreignSync(schema) };
}

function exportState(id, { note, rows, schema, acl, recipients }) {
  const mine = rows.filter(r => r[EXPORT_COL] === id);
  const tables = exportTables(rows, id);
  const entry = note.exports.find(e => e.id === id) || { id, name: id };
  return {
    ...entry, tables, recipients, invitations: note.invitations.filter(i => i.export === id),
    // Lien public : une règle d'accès posée depuis cache une partie de ce qu'il montre à tous.
    hidden: entry.public ? hiddenTables(acl.resources, acl.rules, readTables(tables)) : [],
    // Renforcé : les éditeurs peuvent réécrire les formules de Synchro (droit de structure).
    structure: Boolean(entry.renforce) && editorsEditStructure(acl.resources, acl.rules),
    email: exportEmail(mine, id),
    events: eventsOf(note, id),
    // Destinataires sans clé de signature (ligne 'signature' de Synchro perdue) : leur CIBLE rejette les envois.
    unkeyed: new Set(unkeyedRecipients((mine.find(r => r[TYPE_COL] === KIND.sign) || {})[SCHEMA_COL], recipients.map(h => h.id), eventsOf(note, id).some(e => e.kind === 'join'))),
    // Tables dont des lignes ou la liste des clés restent à envoyer (voir exportFlow).
    owed: recipients.length ? new Set(mine.filter(r => lotLate(r) || listDue(r)).map(r => r[TABLE_COL])).size : 0,
    // Lien public : tables dont l'instantané dépasse la taille permise (il reste vide).
    tooBig: mine.filter(r => r[TYPE_COL] === KIND.full && (parseLot(r[LOT_COL]) || {}).tooBig).map(r => r[TABLE_COL]),
    ...exportDrift(schema, tables),
  };
}

// ---------------------------------------------------------------------------------------------
// Tableau de bord

// Redessine l'onglet s'il est affiché et qu'aucune fenêtre n'est ouverte (rattrapage terminé). Ce
// redessin périodique ne touche pas aux règles d'accès : leur changement rechargerait le widget au
// milieu d'une action en cours (vu : le partage d'un formulaire effacé restait).
export async function refreshSource() {
  if (container && container.isConnected && !document.querySelector('.scrim')) await renderSource(container, { periodic: true });
}

export async function renderSource(root = container, { periodic = false } = {}) {
  container = root;
  const state = await upgradeSource(await loadState());
  // Règles d'accès du widget (voir syncRules) : Synchro réservée aux propriétaires, et lien public
  // accordé aux exports partagés. Document lisible par lien public ? Vérifié à chaque affichage :
  // tant qu'il l'est, le refus général posé par le widget reste en place, même sans export public ;
  // le widget n'en pose jamais un sur un document qu'il n'a pas partagé lui-même. Lien public réglé
  // sur Éditeur : les règles du widget, qui visent les lecteurs, ne protègent plus rien. Réponse
  // inconnue (null) : rien ne change.
  const access = await publicAccess((await docIdentity()).baseUrl);
  const open = access === null ? null : Boolean(access);
  if (!periodic && !state.ownerOnly && await syncRules({ publicIds: state.exports.filter(e => e.public).map(e => e.id), open })) {
    reloading(container, renderSource);
    return;
  }
  redraw(container, sourceView(state, access, open));
  if ([...flowSlots.values()].some(slot => slot.moving) || state.exports.some(exp => exp.recipients.some(hookBusy))) watchFlows();
  if (state.ownerOnly) return;
  resumeExchange(state);
  if (!periodic) askAboutSync(state);
  if (await checkHooks(state.exports.flatMap(exp => exp.recipients))) await renderSource(root, { periodic });
}

// Mise à niveau silencieuse du montage (colonnes de Synchro, dépendances de MajLe), puis
// rattrapage d'un envoi coupé. Les lectures de loadState servent aux deux : l'état n'est relu
// qu'après une écriture.
async function upgradeSource(state) {
  if (state.ownerOnly || !ownsSync(state.schema)) return state;
  let current = state;
  if (await ensureSyncTable(current.schema, current.rows)) current = await loadState();
  if (await refreshMajLe(current.schema, current.rows)) current = await loadState();
  if (await refreshOptions(current.schema, current.rows)) current = await loadState();
  catchUp(refreshSource);
  return current;
}

// Contenu de l'onglet : « Nouvel export », avertissements, avis de la dernière action, cartes.
function sourceView(state, access, open) {
  flowSlots.clear();
  personSlots.clear();
  const out = el('div', { class: 'out' }, notice);
  notice = null;
  const toolbar = el('div', { class: 'toolbar' },
    el('button', {
      class: 'btn btn-primary', type: 'button', disabled: state.ownerOnly || state.foreign || blocksNew(state.lost),
      title: state.foreign ? t('send.foreign.blocked') : blocksNew(state.lost) ? t('send.lost.blocked') : null,
      onclick: () => exportWizard(null, renderSource),
    }, icon('plus'), t('send.new')));
  // Les exports ne se montrent qu'aux propriétaires : Synchro leur est réservée (voir acl.js).
  const cards = state.ownerOnly || state.foreign ? [] : state.exports.map(exp => exportCard(exp, state, open, out));
  if (state.unsafe.length) cards.unshift(unsafeCard(state.unsafe, state.ownerOnly, out));
  if (state.strays.length) cards.unshift(strayCard(state, out));
  if (state.foreign) cards.unshift(foreignCard(state, out));
  if (state.lost) cards.unshift(lostCard(state.lost, out));
  return [toolbar,
    state.ownerOnly ? message('warn', t('send.ownersOnly')) : null,
    access && access !== 'viewers' ? message('err', t('send.public.editors')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards) : state.ownerOnly ? null : el('p', { class: 'muted' }, t('send.empty')),
    roleGuide({ you: 'source' })].filter(Boolean);
}

// Échange qui attend le lien de son formulaire de retour (page fermée en route) : l'assistant
// reprend à cette étape, une fois par chargement.
function resumeExchange(state) {
  const pending = state.exports.flatMap(exp => exp.invitations.filter(inv => inv.journal && !inv.ready).map(inv => [exp, inv]))[0];
  if (pending && !resumed && !document.querySelector('.scrim')) openRecipient(...pending);
}

const openRecipient = (exp, pending = null) => {
  resumed = true;
  recipientWizard(exp, pending, renderSource);
};

// Bouton d'une carte : grisé pour qui n'est pas propriétaire, ou avec la raison (`reason`).
// L'action finie, l'onglet est redessiné.
const actionButton = (label, iconName, fn, ownerOnly, out, { kind = '', reason = '' } = {}) => smallButton(label, iconName,
  e => run(e.currentTarget, out, async () => { await fn(); await renderSource(); }), { kind, disabled: ownerOnly || Boolean(reason), title: reason || null });

// Bouton qui ouvre un assistant.
const wizardButton = (label, iconName, onclick, { primary = false, ownerOnly = false, reason = '' } = {}) =>
  smallButton(label, iconName, onclick, { kind: primary ? 'btn-primary' : '', disabled: ownerOnly || Boolean(reason), title: reason || null });

const statusPill = (key, tone, vars) => pill(t(`send.status.${key}`, vars), tone);

// Échange administré ici : les types de changement des participants qui ne sont pas acceptés d'office.
function rulesLine(exp) {
  const rules = exchangeRules(exp);
  if (!rules) return null;
  const list = STATES.filter(st => rules[st] !== 'accepter').map(st => `${t(`send.rules.${st}`)} (${t(`send.rules.${rules[st]}`)})`);
  return el('p', { class: 'muted small' }, t('send.exchange.rules', { rules: list.join(', ') }));
}

// Avis d'un export : tables perdues, colonnes changées, envoi incomplet, fichiers à envoyer, Échange.
const exportNotes = exp => [
  !exp.tables.length && !exp.retour ? message('err', t('send.export.rowsGone')) : null,
  exp.hidden.length ? message('err', t('send.public.hiddenNow', { tables: exp.hidden.join(', ') })) : null,
  exp.structure ? message('warn', t('send.renforce.structure')) : null,
  exp.lost.length ? message('warn', t('send.export.lost', { tables: exp.lost.join(', ') })) : null,
  exp.changed.length ? message('warn', t('send.export.drift', { cols: exp.changed.join(', ') })) : null,
  filesPending(exp.id) ? message('info', t('send.files.pending', { n: filesPending(exp.id) })) : null,
  exp.retour ? message('info', t('send.exchange.managed')) : null,
  exp.echange && !exp.retour ? el('p', { class: 'muted small' }, exp.recipients.length > 1 ? t('send.exchange.hub', { n: exp.recipients.length }) : t('send.exchange.with')) : null,
  exp.echange && !exp.retour ? rulesLine(exp) : null,
];

const tablesLine = exp => exp.tables.map(tb => t(tb.filter ? 'send.export.tableFiltered' : 'send.export.table',
  { table: tb.table, n: tb.columns.length, filter: filterSummary(tb.filter) })).join(' · ') || '—';

function exportCard(exp, state, open, out) {
  const { ownerOnly } = state;
  const n = exp.recipients.length;
  const [status, tone] = exportStatus(exp);
  const rows = [
    ...exp.recipients.map(h => personRow(exp, h, ownerOnly, out, state)),
    ...exp.invitations.map(inv => inviteRow(exp, inv, ownerOnly, out)),
    exp.public ? publicRow(exp, open, ownerOnly, out) : null,
  ].filter(Boolean);
  // Un envoi long se confirme avec son coût (lignes, lots, durée) ; il se suit sur la carte (voir
  // flowSlot), pendant que ce bouton attend la fin.
  const load = async () => {
    const est = await exportEstimate(exp).catch(() => null);
    if (est && est.seconds >= LONG_SECONDS && !(await confirmSend(est))) return;
    await resendFiles(exp.id);
    loading++;
    watchFlows();
    try {
      const total = await resendTables(exp.id, exp.tables.map(tb => tb.table), null);
      notice = total === null ? message('info', t('send.load.queued')) : message('ok', t('send.load.done', { n: total }));
    } finally {
      loading--;
    }
  };
  // L'export de retour d'un Échange (reçu d'un autre document) se règle depuis l'onglet Recevoir.
  // Un seul bouton principal par carte, l'étape suivante : ajouter un premier destinataire, ou
  // celui d'une invitation en attente.
  return el('article', { class: 'card', 'data-export': exp.id },
    el('div', { class: 'card-head' }, el('strong', {}, exp.name), statusPill(status, tone, { n: n + (exp.public ? 1 : 0) })),
    el('p', { class: 'muted small' }, tablesLine(exp)),
    keyNotice(exp, state),
    behindNotice(exp, state),
    vanishedNotice(exp),
    exportNotes(exp),
    flowSlot(exp, state.charge),
    rows.length ? el('ul', { class: 'people' }, rows) : el('p', { class: 'small' }, t('send.export.nobody')),
    eventsBlock(exp),
    el('div', { class: 'card-actions' },
      exp.retour ? null : wizardButton(t(exp.echange ? 'send.action.addParticipant' : 'send.action.addPerson'), 'plus', () => openRecipient(exp), { primary: !rows.length, ownerOnly }),
      exp.retour ? null : wizardButton(t('send.action.edit'), 'edit', () => exportWizard(exp, renderSource), { ownerOnly }),
      actionButton(t('send.action.load'), 'send', load, ownerOnly, out, { reason: n ? '' : t('send.load.nobody') }),
      actionButton(t('send.action.delete'), 'trash', () => deleteExport(exp), ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Destinataires de cet export dont les envois attendent derrière l'envoi en échec d'une autre personne (la file de
// Grist est commune à tout le document) : un seul avis, quel que soit leur nombre.
function behindNotice(exp, { blocker }) {
  if (!blocker) return null;
  const n = exp.recipients.filter(h => h.id !== blocker.id && hookStatus(h)[0] !== 'error' && (h.usage || {}).numWaiting > 0).length;
  return n ? message('warn', t('send.behind', { n, who: personLabel(blocker) })) : null;
}

// Destinataires dont le webhook a disparu des réglages de Grist (supprimé à la main) : rien ne leur est plus envoyé,
// et la carte n'en montre aucun.
function vanishedNotice(exp) {
  const n = exp.retour || exp.public ? 0 : vanishedRecipients(exp.events, exp.recipients.length);
  return n ? message('warn', t('send.vanished', { n })) : null;
}

// Clés manquantes ou en double dans les tables de l'export (voir keysBlock).
function keyNotice(exp, state) {
  const problems = new Map([...state.keys].filter(([table]) => exp.tables.some(tb => tb.table === table)));
  return problems.size ? keysBlock(problems, () => renderSource(), { ownerOnly: state.ownerOnly }) : null;
}

// Historique des envois (voir addEvent), replié par défaut ; ce qu'on ouvre le reste d'un dessin à
// l'autre.
const eventsOpen = new Set();
const eventLine = e => el('li', { class: 'send-event' },
  el('time', { class: 'chg-time', datetime: new Date(e.at * 1000).toISOString() }, dateText(e.at * 1000)),
  el('span', {}, t(`send.history.${e.kind}`, { who: e.who || '—', n: e.n || 0 })));
const eventsBlock = exp => (exp.events.length ? el('details', {
  class: 'history', open: eventsOpen.has(exp.id), ontoggle: e => (e.currentTarget.open ? eventsOpen.add(exp.id) : eventsOpen.delete(exp.id)),
}, el('summary', {}, el('span', { class: 'history-title' }, t('send.history.title', { n: exp.events.length }))),
  el('p', { class: 'muted small' }, t('send.history.help')), el('ul', { class: 'history-rows' }, exp.events.map(eventLine))) : null);

// Ce que dit l'erreur d'un destinataire. Un journal qui refuse une colonne que Synchro porte sans
// qu'elle soit au widget, ou qu'elle ne porte plus mais que la file garde, n'a rien à faire de son
// côté : le texte le dit (voir columnFault).
function errorText(h, syncCols) {
  const fault = columnFault(h.usage, syncCols);
  if (fault === 'stray') return t('send.error.stray', { col: refusedColumn(h.usage) });
  if (fault === 'gone') return t('send.error.gone', { col: refusedColumn(h.usage) });
  return t(hookErrorKey(h), { col: refusedColumn(h.usage) || '?', status: failureStatus(h) || '' });
}

// Un destinataire : sa fiche (mémo du webhook), son état, et ce qu'on peut faire pour lui seul. Son
// état d'envoi (pastille, dernier envoi, envois en attente, erreur) est redessiné sur place tant
// qu'un envoi bouge (voir tickFlows).
function personRow(exp, h, ownerOnly, out, { syncCols, note }) {
  const [status] = hookStatus(h);
  const action = (label, iconName, fn, options) => actionButton(label, iconName, fn, ownerOnly, out, options);
  const failing = status === 'error';
  const autoPaused = status === 'paused' ? note.pauses.find(p => p.hook === h.id && p.auto) : null;
  // Vider la file ne règle ni un lien mort, ni un serveur qui n'en peut plus (l'envoi suivant échoue de la même
  // façon) : la pause libère les autres destinataires, ou l'on attend (Grist retente seul).
  const waits = failing && !columnFault(h.usage, syncCols) && NO_UNBLOCK.includes(hookErrorKey(h));
  const { other, bad } = hookCheck(h.id);
  const slot = { pill: el('span', {}), lines: el('div', {}), syncCols, status };
  personSlots.set(h.id, slot);
  fillPerson(slot, h);
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, personLabel(h)), slot.pill),
    bad ? message('err', t('send.person.badAddress')) : null,
    other ? message('err', t('send.person.otherDoc', { doc: other })) : null,
    exp.unkeyed.has(h.id) ? message('err', t('send.person.noKey')) : null,
    autoPaused ? message('info', t(autoPaused.why === 'slow' ? 'send.paused.slow' : 'send.paused.auto')) : null,
    slot.lines,
    el('div', { class: 'person-actions' },
      status === 'paused' ? action(t('send.action.resume'), 'play', () => resume(exp, h, out)) : action(t('send.action.pause'), 'pause', () => pause(exp, h)),
      failing && !waits ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
      action(t('send.action.revoke'), 'revoke', () => revoke(exp, h), { kind: 'btn-danger-text' })));
}

function fillPerson(slot, h) {
  const [status, tone] = hookStatus(h);
  const u = h.usage || {};
  const failing = status === 'error';
  slot.status = status;
  slot.pill.replaceChildren(statusPill(status, tone));
  slot.lines.replaceChildren(...[
    u.lastSuccessTime ? el('p', { class: 'muted small' }, t('send.lastOk', { at: dateText(u.lastSuccessTime) })) : null,
    u.numWaiting ? el('p', { class: 'small' }, t('send.waiting', { n: u.numWaiting })) : null,
    failing ? el('p', { class: 'small text-danger' }, errorText(h, slot.syncCols)) : null,
    failing && u.lastErrorMessage ? el('p', { class: 'muted small' }, t('send.error.detail', { detail: maskKey(`${failureStatus(h) || ''} ${u.lastErrorMessage}`.trim()) })) : null,
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------------------------
// Où en est l'envoi de chaque export : sa phrase (voir exportFlow) est redessinée sur place, avec l'état
// de ses destinataires, tant qu'un envoi bouge ; une page qui change d'état se redessine en entier.
// Une lecture légère toutes les 10 s (ligne 'charge', webhooks), jamais la table Synchro.
const FLOW_MS = 10000;
const flowSlots = new Map(); // export -> { node, exp, moving }
const personSlots = new Map(); // webhook -> { pill, lines, syncCols, status }
let flowTimer = 0;
let loading = 0; // envois lancés depuis cette page par « Tout renvoyer »

function flowSlot(exp, charge) {
  const node = el('div', { class: 'flow-slot', 'data-export-flow': exp.id });
  const flow = flowOf(exp, charge);
  const view = flowView(flow);
  if (view) node.append(view);
  flowSlots.set(exp.id, { node, exp, moving: flowMoves(flow) });
  return node;
}

function watchFlows() {
  if (!flowTimer) flowTimer = setTimeout(tickFlows, FLOW_MS);
}

async function tickFlows() {
  flowTimer = 0;
  if (!container || !container.isConnected) return;
  let charge;
  let hooks;
  let conditions;
  try {
    [charge, hooks, conditions] = await Promise.all([currentCharge(), listWebhooks(), webhookConditions()]);
  } catch (e) {
    if (loading) watchFlows();
    return;
  }
  let moving = loading > 0;
  let changed = false;
  for (const [id, slot] of flowSlots) {
    if (!slot.node.isConnected) {
      flowSlots.delete(id);
      continue;
    }
    slot.exp = { ...slot.exp, recipients: hooksOf(hooks, conditions, id) };
    const flow = flowOf(slot.exp, charge);
    const view = flowView(flow);
    slot.node.replaceChildren(...(view ? [view] : []));
    changed ||= slot.moving && !flowMoves(flow);
    slot.moving = flowMoves(flow);
    moving ||= slot.moving;
  }
  for (const h of hooks) {
    const slot = personSlots.get(h.id);
    if (!slot || !slot.pill.isConnected) continue;
    changed ||= hookStatus(h)[0] !== slot.status;
    moving ||= hookBusy(h);
    fillPerson(slot, h);
  }
  if (changed && !document.querySelector('.scrim')) await refreshSource();
  else if (moving || changed) watchFlows();
}

// Invitation en attente. Celle d'un Échange attend d'abord le lien de son formulaire de retour, et
// son code peut être refait (nouveau secret) : il n'est gardé nulle part.
// Une invitation vaut 7 jours : expirée, son code est à refaire.
function inviteRow(exp, inv, ownerOnly, out) {
  const state = invitationState(inv);
  const back = state === 'link';
  const expired = state === 'expired';
  const until = t(expired ? 'send.invite.expiredOn' : 'send.invite.until', { at: dateText(expiresAt(inv.at) * 1000) });
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' },
      el('span', { class: 'person-who' }, t('send.invite.pending', { at: dateText(inv.at * 1000) })), expired ? statusPill('expired', 'err') : statusPill('invited', 'pending')),
    el('p', { class: 'muted small' }, [back ? t('send.mode.echange') : until, inv.renforce ? t('send.renforce.on') : ''].filter(Boolean).join(' · ')),
    el('div', { class: 'person-actions' },
      wizardButton(back ? t('send.back.resume') : expired ? t('send.newCode.ok') : t('send.reply'), back ? 'link' : expired ? 'key' : 'paste', () => openRecipient(exp, inv), { primary: true, ownerOnly }),
      inv.journal && inv.ready ? wizardButton(t('send.back.again'), 'key', () => openRecipient(exp, { ...inv, ready: false }), { ownerOnly }) : null,
      actionButton(t('send.action.cancel'), 'trash', () => cancelInvitation(inv), ownerOnly, out, { kind: 'btn-danger-text' })));
}

function publicRow(exp, open, ownerOnly, out) {
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, t('send.public.label')), statusPill(open ? 'public' : 'publicOff', open ? 'ok' : 'pending')),
    open ? null : el('p', { class: 'small' }, t('send.public.turnOn')),
    exp.tooBig.length ? message('warn', t('send.public.tooBig', { tables: exp.tooBig.join(', ') })) : null,
    el('div', { class: 'person-actions' },
      actionButton(t('send.public.code'), 'key', () => showPublicCode(exp), ownerOnly, out),
      actionButton(t('send.public.stop'), 'unlink', () => stopPublic(exp), ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Carte d'avertissement avec un bouton qui nettoie, après confirmation.
function cleanupCard({ title, body, status, clean, confirm, ownerOnly, out, fn }) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, title), status),
    el('p', { class: 'small' }, body),
    el('div', { class: 'card-actions' }, actionButton(clean, 'trash', async () => {
      if (await confirmDialog({ title, body: confirm, confirmLabel: clean })) await fn();
    }, ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Webhook sur Synchro sans filtre reconnu : il recevrait les lignes de tous les exports.
const unsafeCard = (hooks, ownerOnly, out) => cleanupCard({
  title: t('send.unsafe.title'), status: statusPill('error', 'err'), body: t('send.unsafe.body', { who: hooks.map(h => h.fields.memo || h.fields.name).join(', ') }),
  clean: t('send.unsafe.delete'), confirm: t('send.unsafe.confirm'), ownerOnly, out,
  fn: async () => { for (const h of hooks) await deleteWebhook(h.id); },
});

// ---------------------------------------------------------------------------------------------
// Table Synchro à remettre en état (voir logic/strays.js) : colonnes en trop, ou table de ce nom qui
// n'est pas celle du widget. Chaque cas a sa carte, avec le bouton qui ouvre la fenêtre ; la
// fenêtre s'ouvre aussi d'elle-même, une fois par chargement de la page (« Plus tard » la ferme).

const strayCard = (state, out) => {
  const risky = state.strays.filter(hasContent);
  return el('article', { class: 'card', 'data-stray': '' },
    el('div', { class: 'card-head' }, el('strong', {}, t('send.stray.title')), statusPill('error', 'err')),
    el('p', { class: 'small' }, t('send.stray.body', { n: state.strays.length, list: state.strays.map(s => s.id).join(', '), total: syncColumnIds().size })),
    risky.length ? message('warn', t('send.stray.filled', { cols: risky.map(s => s.id).join(', ') })) : null,
    el('div', { class: 'card-actions' }, actionButton(t('send.stray.open'), 'trash', () => removeStrays(state), false, out, { kind: 'btn-primary' })));
};

// Synchro perdue : ce qui s'est passé, ce qu'on peut faire. Effacée : un nouvel export recrée la table (les anciens
// webhooks, qui ne servent plus, se retirent d'un bouton). Renommée ou illisible : un nouvel export se heurterait à
// la table qui reste, il est refusé tant que ce n'est pas réglé.
// Synchro perdue ? Dit au premier écran (propriétaires seulement : eux seuls lisent les webhooks).
export async function lostSynchro(schema) {
  try {
    return lostSync(schema, await listWebhooks(), await webhookConditions());
  } catch (e) {
    return null;
  }
}
// Personne propriétaire du document ? (Eux seuls lisent les webhooks.) Null : Grist n'a pas répondu, on ne sait pas.
export async function isOwnerHere() {
  try {
    await listWebhooks();
    return true;
  } catch (e) {
    return e.message === 'ownerOnly' ? false : null;
  }
}
const blocksNew = lost => Boolean(lost) && lost.kind !== 'deleted';
function lostCard(lost, out) {
  const vars = { name: lost.name, n: lost.hooks.length };
  const title = t(`send.lost.${lost.kind}.title`, vars);
  const clean = lost.kind !== 'deleted' ? null : actionButton(t('send.lost.deleted.clean'), 'trash', async () => {
    if (!(await confirmDialog({ title, body: t('send.lost.deleted.confirm', vars), confirmLabel: t('send.lost.deleted.clean') }))) return;
    for (const id of lost.hooks) await deleteWebhook(id);
    notice = message('ok', t('send.lost.deleted.done', vars));
  }, false, out, { kind: 'btn-danger-text' });
  return el('article', { class: 'card', 'data-lost': lost.kind },
    el('div', { class: 'card-head' }, el('strong', {}, title), statusPill('error', 'err')),
    el('p', { class: 'small' }, t(`send.lost.${lost.kind}.body`, vars)),
    el('p', { class: 'small' }, t(`send.lost.${lost.kind}.how`, vars)),
    clean ? el('div', { class: 'card-actions' }, clean) : null);
}

const foreignCard = (state, out) => el('article', { class: 'card', 'data-foreign': '' },
  el('div', { class: 'card-head' }, el('strong', {}, t('send.foreign.title')), statusPill('error', 'err')),
  el('p', { class: 'small' }, t('send.foreign.body')),
  el('div', { class: 'card-actions' }, actionButton(t('send.foreign.open'), 'edit', renameForeign, false, out, { kind: 'btn-primary' })));

// Un envoi bloqué par l'une des colonnes : la fenêtre vide ensuite la file de Grist (voir strayDialog).
async function removeStrays(state) {
  const stuck = state.exports.some(exp => exp.recipients.some(h => columnFault(h.usage, state.syncCols) === 'stray'));
  if (await strayDialog(state.strays, { stuck })) notice = message('ok', t('send.stray.done', { n: state.strays.length }));
}

async function renameForeign() {
  if (await foreignDialog()) notice = message('ok', t('send.foreign.done'));
}

const asked = new Set();
function askAboutSync(state) {
  if (state.ownerOnly || document.querySelector('.scrim')) return;
  const [kind, open] = state.foreign ? ['foreign', renameForeign] : state.strays.length ? ['stray', () => removeStrays(state)] : [];
  if (!kind || asked.has(kind)) return;
  asked.add(kind);
  open().then(() => renderSource()).catch((e) => { console.error(e); noteError(e); });
}
