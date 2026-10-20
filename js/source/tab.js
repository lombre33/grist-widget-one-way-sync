// Onglet « Envoyer » (document SOURCE) : une carte par export (un nom, des tables et leurs
// colonnes) avec ses destinataires. Une seule table technique, Synchro ; un webhook par
// destinataire, filtré par Grist sur les lignes de son export.
import { EXPORT_COL, KIND, LOT_COL, MISSING_COL, RESEND_COL, SYNC_TABLE, TABLE_COL, TYPE_COL, nowS } from '../logic/common.js';
import { maskKey, parseWebhookUrl } from '../logic/codes.js';
import { conditionExport, exportEmail, exportStatus, exportTables, exportableColumns, hookErrorKey, hookLabel, hookStatus, hooksOf, readTables } from '../logic/exports.js';
import { editorsEditStructure, hiddenTables } from '../logic/acl.js';
import { STATES, parseLot } from '../logic/journal.js';
import { exchangeRules } from '../logic/consolidation.js';
import { listDue, parseCharge } from '../logic/resend.js';
import { deleteWebhook, docIdentity, fetchRows, listWebhooks, publicAccess, readSchema, shareInfo, webhookConditions } from '../grist.js';
import { expiresAt, isExpired, memoMatches } from '../logic/trust.js';
import { reloading, syncRules } from '../acl.js';
import { ensureSyncTable, isCharge, readSourceNote, refreshMajLe } from './synchro.js';
import { catchUp, chargeNotice, resendTables } from './resend.js';
import { filesPending, resendFiles } from './files.js';
import { cancelInvitation, deleteExport, pause, resume, revoke, showPublicCode, stopPublic, unblockQueue } from './actions.js';
import { exportWizard } from './export-wizard.js';
import { filterSummary } from './filter-editor.js';
import { recipientWizard } from './recipient-wizard.js';
import { confirmDialog, el, icon, message, pill, run } from '../ui.js';
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
  const all = schema.has(SYNC_TABLE) ? await fetchRows(SYNC_TABLE) : [];
  const rows = all.filter(r => !isCharge(r));
  const note = readSourceNote(schema);
  // Règles d'accès (lisibles par un propriétaire seulement) : revérifiées à chaque affichage.
  const [resources, aclRules] = ownerOnly ? [[], []] : await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const acl = { resources, rules: aclRules };
  const ids = [...new Set([...note.exports.map(e => e.id), ...rows.map(r => r[EXPORT_COL])])];
  const exports = ids.map(id => exportState(id, { note, rows, schema, acl, recipients: hooksOf(hooks, conditions, id) }));
  const unsafe = hooks.filter(h => h.fields.tableId === SYNC_TABLE && !conditionExport(conditions.get(h.id)));
  const charge = parseCharge((all.find(isCharge) || {})[RESEND_COL]);
  return { ownerOnly, schema, rows, note, exports, unsafe, charge };
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
    partial: recipients.some(h => h.fields.enabled) && mine.some(r => (r[TYPE_COL] === KIND.lot && r[MISSING_COL] > 0) || listDue(r)),
    // Lien public : tables dont l'instantané dépasse la taille permise (il reste vide).
    tooBig: mine.filter(r => r[TYPE_COL] === KIND.full && (parseLot(r[LOT_COL]) || {}).tooBig).map(r => r[TABLE_COL]),
    ...drift(schema, tables),
  };
}

// Ce que la SOURCE a changé depuis l'enregistrement de l'export : tables introuvables (renommées
// ou effacées : leurs lignes ne partent plus) et colonnes renommées, effacées ou d'un autre type
// (elles partiraient vides ou fausses). « Modifier » remet l'export d'accord avec les tables.
function drift(schema, tables) {
  const lost = tables.filter(tb => !schema.has(tb.table)).map(tb => tb.table);
  const changed = tables.filter(tb => schema.has(tb.table)).flatMap(({ table, columns }) => {
    const current = new Map(exportableColumns(schema.columns(table)).map(c => [c.id, c]));
    return columns.filter((c) => {
      const cur = current.get(c.id);
      return !cur || cur.source !== (c.source || c.type) || (cur.visible || '') !== (c.visible || '');
    }).map(c => `${table}.${c.id}`);
  });
  return { lost, changed };
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
  container.replaceChildren(...sourceView(state, access, open));
  if (state.ownerOnly) return;
  resumeExchange(state);
  if (await checkHooks(state.exports.flatMap(exp => exp.recipients))) await renderSource(root, { periodic });
}

// Mise à niveau silencieuse du montage (colonnes de Synchro, dépendances de MajLe), puis
// rattrapage d'un envoi coupé. Les lectures de loadState servent aux deux : l'état n'est relu
// qu'après une écriture.
async function upgradeSource(state) {
  if (state.ownerOnly || !state.schema.has(SYNC_TABLE)) return state;
  let current = state;
  if (await ensureSyncTable(current.schema, current.rows)) current = await loadState();
  if (await refreshMajLe(current.schema, current.rows)) current = await loadState();
  catchUp(refreshSource);
  return current;
}

// Contenu de l'onglet : « Nouvel export », avertissements, avis de la dernière action, cartes.
function sourceView(state, access, open) {
  const out = el('div', { class: 'out' }, notice);
  notice = null;
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: state.ownerOnly, onclick: () => exportWizard(null, renderSource) }, icon('plus'), t('send.new')));
  // Les exports ne se montrent qu'aux propriétaires : Synchro leur est réservée (voir acl.js).
  const cards = state.ownerOnly ? [] : state.exports.map(exp => exportCard(exp, state, open, out));
  if (state.unsafe.length) cards.unshift(unsafeCard(state.unsafe, state.ownerOnly, out));
  return [toolbar,
    state.ownerOnly ? message('warn', t('common.ownerOnly')) : null,
    access && access !== 'viewers' ? message('err', t('send.public.editors')) : null,
    chargeNotice(state.charge),
    out,
    cards.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'muted' }, t(state.ownerOnly && state.exports.length ? 'send.ownersOnly' : 'send.empty')),
    roleGuide({ you: 'source' })].filter(Boolean);
}

// Échange qui attend le lien de son formulaire de retour (page fermée en route) : l'assistant
// reprend à cette étape, une fois par chargement.
function resumeExchange(state) {
  const pending = state.exports.flatMap(exp => exp.invitations.filter(inv => inv.journal && !inv.ready).map(inv => [exp, inv]))[0];
  if (pending && !resumed && !document.querySelector('.scrim')) openRecipient(...pending);
}

// Chaque destinataire est revérifié chez Grist au plus une fois par heure (voir shareInfo) : la clé
// de son webhook désigne-t-elle toujours le document de sa fiche (mémo) ? Un co-propriétaire peut
// changer l'adresse d'un webhook dans les réglages de Grist, même vers un autre site : une adresse
// qui n'est pas celle d'un formulaire de cette instance est signalée sans rien demander à personne.
// Le nom du document, lu au passage, complète la fiche affichée (voir hookLabel). Rend vrai si un
// résultat ou une fiche a changé.
const CHECK_MS = 3600000;
const checked = new Map(); // webhook -> { at, url, other : document désigné à la place, ou '' ; bad ; docName }
const personLabel = h => hookLabel(h.fields.memo, (checked.get(h.id) || {}).docName) || '—';
async function checkHooks(hooks) {
  const due = hooks.filter((h) => {
    const was = checked.get(h.id);
    return !was || was.url !== h.fields.url || Date.now() - was.at > CHECK_MS;
  });
  if (!due.length) return false;
  const { origin } = await docIdentity();
  let changed = false;
  const note = (h, result) => {
    const was = checked.get(h.id) || { other: '', bad: false };
    const label = personLabel(h);
    checked.set(h.id, { at: Date.now(), url: h.fields.url, ...result });
    changed ||= was.other !== result.other || was.bad !== result.bad || label !== personLabel(h);
  };
  await Promise.all(due.map(async (h) => {
    const target = parseWebhookUrl(h.fields.url);
    if (!target || !target.flat || target.origin !== origin) return note(h, { other: '', bad: true });
    const info = await shareInfo(h.fields.url).catch(() => undefined);
    if (info === undefined) return; // Grist ne répond pas : au prochain affichage
    const other = info && !memoMatches(h.fields.memo, info.docId) ? info.name || info.docId : '';
    note(h, { other, bad: false, docName: info && !other ? info.name : '' });
  }));
  return changed;
}

const openRecipient = (exp, pending = null) => {
  resumed = true;
  recipientWizard(exp, pending, renderSource);
};

// Bouton d'une carte : grisé pour qui n'est pas propriétaire, ou avec la raison (`reason`).
// L'action finie, l'onglet est redessiné.
function actionButton(label, iconName, fn, ownerOnly, out, { kind = '', reason = '' } = {}) {
  return el('button', {
    class: `btn btn-small ${kind}`, type: 'button', disabled: ownerOnly || Boolean(reason), title: reason || null,
    onclick: e => run(e.currentTarget, out, async () => { await fn(); await renderSource(); }),
  }, icon(iconName), label);
}

// Bouton qui ouvre un assistant.
const wizardButton = (label, iconName, onclick, { primary = false, ownerOnly = false, reason = '' } = {}) => el('button', {
  class: `btn btn-small ${primary ? 'btn-primary' : ''}`, type: 'button', disabled: ownerOnly || Boolean(reason), title: reason || null, onclick,
}, icon(iconName), label);

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
  exp.hidden.length ? message('err', t('send.public.hiddenNow', { tables: exp.hidden.join(', ') })) : null,
  exp.structure ? message('warn', t('send.renforce.structure')) : null,
  exp.lost.length ? message('warn', t('send.export.lost', { tables: exp.lost.join(', ') })) : null,
  exp.changed.length ? message('warn', t('send.export.drift', { cols: exp.changed.join(', ') })) : null,
  exp.partial ? message('info', t('send.export.partial')) : null,
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
    ...exp.recipients.map(h => personRow(exp, h, ownerOnly, out)),
    ...exp.invitations.map(inv => inviteRow(exp, inv, ownerOnly, out)),
    exp.public ? publicRow(exp, open, ownerOnly, out) : null,
  ].filter(Boolean);
  const load = async () => {
    await resendFiles(exp.id);
    const total = await resendTables(exp.id, exp.tables.map(tb => tb.table), out);
    notice = total === null ? message('info', t('send.load.queued')) : message('ok', t('send.load.done', { n: total }));
  };
  // L'export de retour d'un Échange (reçu d'un autre document) se règle depuis l'onglet Recevoir.
  // Un seul bouton principal par carte, l'étape suivante : ajouter un premier destinataire, ou
  // celui d'une invitation en attente.
  return el('article', { class: 'card', 'data-export': exp.id },
    el('div', { class: 'card-head' }, el('strong', {}, exp.name), statusPill(status, tone, { n: n + (exp.public ? 1 : 0) })),
    el('p', { class: 'muted small' }, tablesLine(exp)),
    exportNotes(exp),
    rows.length ? el('ul', { class: 'people' }, rows) : el('p', { class: 'small' }, t('send.export.nobody')),
    el('div', { class: 'card-actions' },
      exp.retour ? null : wizardButton(t(exp.echange ? 'send.action.addParticipant' : 'send.action.addPerson'), 'plus', () => openRecipient(exp), { primary: !rows.length, ownerOnly }),
      exp.retour ? null : wizardButton(t('send.action.edit'), 'edit', () => exportWizard(exp, renderSource), { ownerOnly }),
      actionButton(t('send.action.load'), 'send', load, ownerOnly, out, { reason: n ? '' : t('send.load.nobody') }),
      actionButton(t('send.action.delete'), 'trash', () => deleteExport(exp), ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Un destinataire : sa fiche (mémo du webhook), son état, et ce qu'on peut faire pour lui seul.
function personRow(exp, h, ownerOnly, out) {
  const [status, tone] = hookStatus(h);
  const u = h.usage || {};
  const action = (label, iconName, fn, options) => actionButton(label, iconName, fn, ownerOnly, out, options);
  const failing = status === 'error';
  const { other, bad } = checked.get(h.id) || {};
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, personLabel(h)), statusPill(status, tone)),
    bad ? message('err', t('send.person.badAddress')) : null,
    other ? message('err', t('send.person.otherDoc', { doc: other })) : null,
    u.lastSuccessTime ? el('p', { class: 'muted small' }, t('send.lastOk', { at: dateText(u.lastSuccessTime) })) : null,
    u.numWaiting ? el('p', { class: 'small' }, t('send.waiting', { n: u.numWaiting })) : null,
    failing ? el('p', { class: 'small text-danger' }, t(hookErrorKey(h))) : null,
    failing && u.lastErrorMessage ? el('p', { class: 'muted small' }, t('send.error.detail', { detail: maskKey(`${u.lastHttpStatus || ''} ${u.lastErrorMessage}`) })) : null,
    el('div', { class: 'person-actions' },
      status === 'paused' ? action(t('send.action.resume'), 'play', () => resume(exp, h, out)) : action(t('send.action.pause'), 'pause', () => pause(exp, h)),
      failing ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
      action(t('send.action.revoke'), 'revoke', () => revoke(exp, h), { kind: 'btn-danger-text' })));
}

// Invitation en attente. Celle d'un Échange attend d'abord le lien de son formulaire de retour, et
// son code peut être refait (nouveau secret) : il n'est gardé nulle part.
// Une invitation vaut 7 jours : expirée, son code est à refaire.
function inviteRow(exp, inv, ownerOnly, out) {
  const back = inv.journal && !inv.ready;
  const expired = !back && isExpired(inv.at, nowS());
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
