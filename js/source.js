// Onglet « Envoyer » (document SOURCE) : des exports (un nom, des tables et leurs colonnes) et,
// pour chacun, ses destinataires. Une seule table technique, Synchro ; un webhook par
// destinataire, filtré par Grist sur les lignes de son export. Les exports, les invitations en
// attente et les pauses sont notés dans la description d'une colonne de Synchro.
import {
  AUTHOR_COL, EXPORT_COL, KIND, LIST_COL, LOT_COL, MISSING_COL, ORDER_COL, PUBLIC_MEMO, RESEND_ALL, RESEND_CHUNK, RESEND_COL, STATE_COL,
  SYNC_TABLE, TABLE_COL, TYPE_COL, addSpent, budgetWait, buildInvitation, chargeBusy, parseCharge, chunk, chunkMark, conditionExport, docLabel, exportCondition, exportTables, exportableColumns,
  fillKeyActions, hookName, isPublicRule, listOverdue, listRequest, loopingTables, maskKey, missingSyncColumns, parseList, parseLot, parseReply,
  prepareSourceActions, publicAclActions, publicAclRules, randomHex, resendValue, rowsSince, toHex, trackState,
} from './core.js';
import {
  apply, clearWebhookQueue, createWebhook, deleteWebhook, docIdentity, docInfo, fetchRows, listWebhooks, readSchema, renameWebhook, selectRows,
  setWebhookEnabled, webhookConditions, withLock,
} from './grist.js';
import {
  chargeRow, ensureSyncTable, isCharge, isUserTable, legacyTables, readSourceNote, receivedDests, refreshMajLe, removeExport, removeLegacy, saveExport, syncRows,
  writeSourceNote, writeSync,
} from './tables.js';
import { checkList, confirmDialog, copyButton, copyField, el, icon, message, openModal, openWizard, pickField, run } from './ui.js';
import { handoffText, roleGuide } from './guide.js';
import { stepHelp } from './tutorial.js';
import { LANG, t, typeName } from './i18n.js';
import { readPref, writePref } from './prefs.js';

const now = () => Date.now() / 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dateText = ms => new Date(ms).toLocaleString(LANG);
const timeText = sec => new Date(sec * 1000).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
const sha256 = async text => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
// Ligne Synchro qui demande d'envoyer la liste complète de sa table : renvoi de la liste interrompu
// (la demande est restée dans la ligne 'cles'), ou trop de clés parties d'un coup (suivi).
const listDue = r => (r[TYPE_COL] === KIND.keys && Boolean(r[RESEND_COL])) || listOverdue(r);
// Destinataires d'un export : les webhooks sur Synchro dont la condition nomme cet export.
const hooksOf = (hooks, conditions, exportId) => hooks.filter(h => h.fields.tableId === SYNC_TABLE && conditionExport(conditions.get(h.id)) === exportId);

let container;
let notice = null; // message à montrer au prochain affichage (fin d'un renvoi)

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
  const ids = [...new Set([...note.exports.map(e => e.id), ...rows.map(r => r[EXPORT_COL])])];
  const exports = ids.map((id) => {
    const meta = note.exports.find(e => e.id === id) || { id, name: id };
    const recipients = hooksOf(hooks, conditions, id);
    const tables = exportTables(rows, id);
    return {
      ...meta, tables, recipients, invitations: note.invitations.filter(i => i.export === id),
      email: (rows.find(r => r[EXPORT_COL] === id) || {})[AUTHOR_COL] || '',
      partial: recipients.some(h => h.fields.enabled) && rows.some(r => r[EXPORT_COL] === id && ((r[TYPE_COL] === KIND.lot && r[MISSING_COL] > 0) || listDue(r))),
      // Lien public : tables dont l'instantané dépasse la taille permise (il reste vide).
      tooBig: rows.filter(r => r[EXPORT_COL] === id && r[TYPE_COL] === KIND.full && (parseLot(r[LOT_COL]) || {}).tooBig).map(r => r[TABLE_COL]),
      ...drift(schema, tables),
    };
  });
  const legacy = legacyTables(schema);
  // Webhooks de l'ancien montage : sur ses tables, ou vers un journal par une clé de formulaire.
  // Les autres webhooks du document (autres outils) ne sont pas à lui.
  const legacyHooks = hooks.filter(h => h.fields.tableId !== SYNC_TABLE && (legacy.includes(h.fields.tableId) || /\/api\/s\/[^/]+\/tables\/[^/]+\/records\?flat=1$/.test(h.fields.url || '')));
  const unsafe = hooks.filter(h => h.fields.tableId === SYNC_TABLE && !conditionExport(conditions.get(h.id)));
  const charge = parseCharge((all.find(isCharge) || {})[RESEND_COL]);
  return { ownerOnly, schema, note, exports, unsafe, charge, legacy: { tables: legacy, hooks: legacyHooks } };
}

// Ce que la SOURCE a changé depuis l'enregistrement de l'export : tables introuvables (renommées
// ou effacées : leurs lignes ne partent plus) et colonnes renommées, effacées ou d'un autre type
// (elles partiraient vides ou fausses). « Modifier » remet l'export d'accord avec les tables.
function drift(schema, tables) {
  const lost = tables.filter(tb => !schema.has(tb.table)).map(tb => tb.table);
  const changed = tables.filter(tb => schema.has(tb.table)).flatMap(({ table, columns }) => {
    const now = new Map(exportableColumns(schema.columns(table)).map(c => [c.id, c]));
    return columns.filter((c) => {
      const cur = now.get(c.id);
      return !cur || cur.source !== (c.source || c.type) || (cur.visible || '') !== (c.visible || '');
    }).map(c => `${table}.${c.id}`);
  });
  return { lost, changed };
}

async function updateNote(change) {
  const note = readSourceNote(await readSchema());
  change(note);
  await writeSourceNote(note);
}

// Lien public : le document est-il lisible sans identifiant ? (requête anonyme) Vrai, faux, ou
// null quand la réponse ne permet pas de le dire (réseau, serveur occupé) : rien ne change alors.
async function isPublic(base) {
  try {
    const response = await fetch(base, { credentials: 'omit' });
    if (response.ok) return true;
    return [401, 403, 404].includes(response.status) ? false : null;
  } catch (e) {
    return null;
  }
}

// Règles d'accès du lien public, accordées aux exports partagés : réécrites seulement si elles
// diffèrent (changer une règle fait recharger le document, et donc le widget). Le refus général
// posé par le widget reste tant que le document est public ; le widget n'en pose jamais un sur un
// document qu'il n'a pas partagé lui-même (un document public sans export public reste lisible).
async function syncPublicRules(exportIds, open) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const mine = rules.filter(isPublicRule);
  const keepDeny = open && mine.length > 0;
  const name = id => (resources.find(r => r.id === id) || {}).tableId;
  const have = mine.map(r => `${name(r.resource)}|${r.aclFormula}|${r.permissionsText}|${r.memo}`).sort().join('\n');
  const want = publicAclRules(exportIds, { keepDeny }).map(r => `${r.tableId}|${r.aclFormula}|${r.permissionsText}|${PUBLIC_MEMO}`).sort().join('\n');
  if (have !== want) await apply(publicAclActions(resources, rules, exportIds, { keepDeny }));
}

// ---------------------------------------------------------------------------------------------
// Tableau de bord : une carte par export.

export async function renderSource(root = container) {
  container = root;
  let state = await loadState();
  // Mise à niveau silencieuse du montage (colonnes de Synchro, dépendances de MajLe), puis
  // rattrapage d'un envoi coupé.
  if (!state.ownerOnly && state.schema.has(SYNC_TABLE)) {
    const upgraded = await ensureSyncTable();
    const majle = await refreshMajLe();
    if (upgraded || majle) state = await loadState();
    catchUp();
  }
  // Document lisible par lien public ? Vérifié à chaque affichage : tant qu'il l'est, le refus
  // général posé par le widget reste en place, même sans export public.
  const open = await isPublic((await docIdentity()).baseUrl);
  if (!state.ownerOnly && open !== null) await syncPublicRules(state.exports.filter(e => e.public).map(e => e.id), open);

  const out = el('div', { class: 'out' }, notice);
  notice = null;
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: state.ownerOnly, onclick: () => exportWizard() }, icon('plus'), t('send.new')));
  const cards = state.exports.map(exp => exportCard(exp, state, open, out));
  if (state.unsafe.length) cards.unshift(unsafeCard(state.unsafe, state.ownerOnly, out));
  if (state.legacy.tables.length) cards.push(legacyCard(state, out));
  container.replaceChildren(...[toolbar,
    state.ownerOnly ? message('warn', t('common.ownerOnly')) : null,
    chargeNotice(state.charge),
    out,
    cards.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'muted' }, t('send.empty')),
    roleGuide({ you: 'source', open: !cards.length })].filter(Boolean));
}

// Bouton d'une carte : grisé pour qui n'est pas propriétaire, ou avec la raison (`reason`).
function actionButton(label, iconName, fn, ownerOnly, out, { kind = '', reason = '' } = {}) {
  return el('button', {
    class: `btn btn-small ${kind}`, type: 'button', disabled: ownerOnly || Boolean(reason), title: reason || null,
    onclick: e => run(e.currentTarget, out, async () => { await fn(); await renderSource(); }),
  }, icon(iconName), label);
}

const pill = (key, tone, vars) => el('span', { class: `pill pill-${tone}` }, t(`send.status.${key}`, vars));

function hookStatus(h) {
  if (!h.fields.enabled) return ['paused', 'off'];
  const u = h.usage || {};
  return ['retrying', 'error'].includes(u.status) || u.lastHttpStatus >= 400 ? ['error', 'err'] : ['active', 'ok'];
}

// Erreur d'envoi d'un destinataire, dite simplement, et ce qu'il faut faire.
function hookError(u) {
  const status = u.lastHttpStatus || (u.lastEventBatch || {}).httpStatus;
  if (status === 413) return t('send.error.size');
  if (/Invalid column/i.test(u.lastErrorMessage || '')) return t('send.error.column');
  return t([401, 403, 404].includes(status) ? 'send.error.link' : 'send.error.other');
}

function exportCard(exp, state, open, out) {
  const { ownerOnly } = state;
  const action = (label, iconName, fn, options) => actionButton(label, iconName, fn, ownerOnly, out, options);
  const n = exp.recipients.length;
  const failing = exp.recipients.some(h => hookStatus(h)[0] === 'error');
  const [status, tone] = failing ? ['error', 'err'] : n || exp.public ? ['people', 'ok'] : exp.invitations.length ? ['invited', 'pending'] : ['alone', 'off'];
  const rows = [
    ...exp.recipients.map(h => personRow(exp, h, ownerOnly, out)),
    ...exp.invitations.map(inv => inviteRow(exp, inv, ownerOnly, out)),
    exp.public ? publicRow(exp, open, ownerOnly, out) : null,
  ].filter(Boolean);
  const load = async () => {
    const total = await resendTables(exp.id, exp.tables.map(tb => tb.table), out);
    notice = total === null ? message('info', t('send.load.queued')) : message('ok', t('send.load.done', { n: total }));
  };
  return el('article', { class: 'card', 'data-export': exp.id },
    el('div', { class: 'card-head' }, el('strong', {}, exp.name), pill(status, tone, { n: n + (exp.public ? 1 : 0) })),
    el('p', { class: 'muted small' }, exp.tables.map(tb => t(tb.filter ? 'send.export.tableFiltered' : 'send.export.table',
      { table: tb.table, n: tb.columns.length, ...(tb.filter ? { col: tb.filter.id, value: tb.filter.value } : {}) })).join(' · ') || '—'),
    exp.lost.length ? message('warn', t('send.export.lost', { tables: exp.lost.join(', ') })) : null,
    exp.changed.length ? message('warn', t('send.export.drift', { cols: exp.changed.join(', ') })) : null,
    exp.partial ? message('info', t('send.export.partial')) : null,
    rows.length ? el('ul', { class: 'people' }, rows) : el('p', { class: 'small' }, t('send.export.nobody')),
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: ownerOnly, onclick: () => recipientWizard(exp) }, icon('plus'), t('send.action.addPerson')),
      el('button', { class: 'btn btn-small', type: 'button', disabled: ownerOnly, onclick: () => exportWizard(exp) }, icon('edit'), t('send.action.edit')),
      action(t('send.action.load'), 'send', load, { reason: n ? '' : t('send.load.nobody') }),
      action(t('send.action.delete'), 'trash', () => deleteExport(exp), { kind: 'btn-danger-text' })));
}

// Un destinataire : sa fiche (mémo du webhook), son état, et ce qu'on peut faire pour lui seul.
function personRow(exp, h, ownerOnly, out) {
  const [status, tone] = hookStatus(h);
  const u = h.usage || {};
  const action = (label, iconName, fn, options) => actionButton(label, iconName, fn, ownerOnly, out, options);
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, h.fields.memo || '—'), pill(status, tone)),
    u.lastSuccessTime ? el('p', { class: 'muted small' }, t('send.lastOk', { at: dateText(u.lastSuccessTime) })) : null,
    u.numWaiting ? el('p', { class: 'small' }, t('send.waiting', { n: u.numWaiting })) : null,
    status === 'error' ? el('p', { class: 'small text-danger' }, hookError(u)) : null,
    status === 'error' && u.lastErrorMessage ? el('p', { class: 'muted small' }, t('send.error.detail', { detail: `${u.lastHttpStatus || ''} ${u.lastErrorMessage}` })) : null,
    el('div', { class: 'person-actions' },
      status === 'paused' ? action(t('send.action.resume'), 'play', () => resume(exp, h, out))
        : action(t('send.action.pause'), 'pause', () => pause(exp, h)),
      status === 'error' ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
      action(t('send.action.revoke'), 'revoke', () => revoke(exp, h), { kind: 'btn-danger-text' })));
}

function inviteRow(exp, inv, ownerOnly, out) {
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' },
      el('span', { class: 'person-who' }, t('send.invite.pending', { at: dateText(inv.at * 1000) })), pill('invited', 'pending')),
    el('p', { class: 'muted small' }, inv.hash ? t('send.secret.on') : t('send.secret.off')),
    el('div', { class: 'person-actions' },
      el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: ownerOnly, onclick: () => recipientWizard(exp, inv) }, icon('paste'), t('send.reply')),
      actionButton(t('send.action.cancel'), 'trash', () => cancelInvitation(inv), ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Lien public : pas de webhook, la CIBLE lit elle-même les instantanés de l'export.
function publicRow(exp, open, ownerOnly, out) {
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, t('send.public.label')), pill(open ? 'public' : 'publicOff', open ? 'ok' : 'pending')),
    open ? null : el('p', { class: 'small' }, t('send.public.turnOn')),
    exp.tooBig.length ? message('warn', t('send.public.tooBig', { tables: exp.tooBig.join(', ') })) : null,
    el('div', { class: 'person-actions' },
      actionButton(t('send.public.code'), 'key', () => showPublicCode(exp), ownerOnly, out),
      actionButton(t('send.public.stop'), 'unlink', () => stopPublic(exp), ownerOnly, out, { kind: 'btn-danger-text' })));
}

function unsafeCard(hooks, ownerOnly, out) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, t('send.unsafe.title')), pill('error', 'err')),
    el('p', { class: 'small' }, t('send.unsafe.body', { who: hooks.map(h => h.fields.memo || h.fields.name).join(', ') })),
    el('div', { class: 'card-actions' }, actionButton(t('send.unsafe.delete'), 'trash', async () => {
      if (!(await confirmDialog({ title: t('send.unsafe.title'), body: t('send.unsafe.confirm'), confirmLabel: t('send.unsafe.delete') }))) return;
      for (const h of hooks) await deleteWebhook(h.id);
    }, ownerOnly, out, { kind: 'btn-danger-text' })));
}

// Montage d'avant la version 0.4 : à refaire avec un export ; le bouton efface l'ancien.
function legacyCard(state, out) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, t('send.legacy.title')), pill('legacy', 'pending')),
    el('p', { class: 'small' }, t('send.legacy.body', { tables: state.legacy.tables.join(', ') })),
    el('div', { class: 'card-actions' }, actionButton(t('send.legacy.clean'), 'trash', async () => {
      if (!(await confirmDialog({ title: t('send.legacy.title'), body: t('send.legacy.confirm'), confirmLabel: t('send.legacy.clean') }))) return;
      for (const h of state.legacy.hooks) await deleteWebhook(h.id);
      await removeLegacy(await readSchema());
    }, state.ownerOnly, out, { kind: 'btn-danger-text' })));
}

// ---------------------------------------------------------------------------------------------
// Actions sur un destinataire

// Mise en pause : un webhook désactivé perd son historique d'envoi (Grist remet son état à zéro),
// il ne peut donc pas dire depuis quand il ne livre plus. On note la plus récente MajLe des tables
// de l'export (heure du serveur, sans écart d'horloge avec le navigateur) et leurs colonnes.
async function pause(exp, h) {
  let at = 0;
  for (const { table } of exp.tables) for (const r of await fetchRows(table)) at = Math.max(at, r[ORDER_COL] || 0);
  await updateNote((note) => {
    note.pauses = note.pauses.filter(p => p.hook !== h.id).concat([{ hook: h.id, export: exp.id, at, columns: JSON.stringify(exp.tables) }]);
  });
  await setWebhookEnabled(h.id, false);
}

// Reprendre après une pause : un webhook désactivé ne met rien en file, les changements de la
// pause sont donc perdus pour la CIBLE. Le rattrapage renvoie les lignes dont MajLe est plus
// récente que la pause, et la liste des clés pour les suppressions. Heure inconnue, ou colonnes
// changées pendant la pause : tout l'export.
async function resume(exp, h, out) {
  const entry = readSourceNote(await readSchema()).pauses.find(p => p.hook === h.id);
  const all = !entry || entry.columns !== JSON.stringify(exp.tables);
  const since = all ? RESEND_ALL : entry.at + 0.0001; // MajLe plus récente que la pause
  let n = 0;
  for (const { table } of exp.tables) n += rowsSince(await fetchRows(table), since).length;
  const choice = (value, label, help, checked) => [el('label', { class: 'check' },
    el('input', { type: 'radio', name: 'gristsync-resume', value, checked }), el('strong', {}, label)), el('p', { class: 'muted small choice-help' }, help)];
  const title = t('send.resume.title', { name: h.fields.memo || exp.name });
  const body = el('div', { class: 'form', role: 'radiogroup', 'aria-label': title },
    choice('catchup', t('send.resume.catchup'), [t('send.resume.catchup.help', { n }), all ? t('send.resume.all') : ''].filter(Boolean).join(' '), true),
    choice('as-is', t('send.resume.asIs'), t('send.resume.asIs.help'), false));
  const picked = await new Promise((resolve) => {
    let answered = false;
    const done = (m, value) => { answered = true; resolve(value); m.close(); };
    openModal({
      title, body,
      onClose: () => { if (!answered) resolve(null); },
      buttons: [{ label: t('common.cancel'), onClick: m => done(m, null) },
        { label: t('send.action.resume'), kind: 'btn-primary', onClick: m => done(m, body.querySelector('input:checked').value) }],
    });
  });
  if (!picked) return;
  await setWebhookEnabled(h.id, true);
  await updateNote((note) => { note.pauses = note.pauses.filter(p => p.hook !== h.id); });
  // Le renvoi pose sa marque avant tout : s'il s'interrompt, le rattrapage automatique le finit.
  if (picked === 'catchup') await resendTables(exp.id, exp.tables.map(tb => tb.table), out, since);
}

// Révoquer une personne : son webhook disparaît, les autres destinataires continuent.
async function revoke(exp, h) {
  const ok = await confirmDialog({ title: t('send.revoke.title', { name: h.fields.memo || exp.name }), body: t('send.revoke.body'), confirmLabel: t('send.action.revoke') });
  if (!ok) return;
  await deleteWebhook(h.id);
  await updateNote((note) => { note.pauses = note.pauses.filter(p => p.hook !== h.id); });
}

async function cancelInvitation(inv) {
  const ok = await confirmDialog({ title: t('send.cancel.title'), body: t('send.cancel.body'), confirmLabel: t('send.action.cancel') });
  if (ok) await updateNote((note) => { note.invitations = note.invitations.filter(i => i.id !== inv.id); });
}

// Débloquer : la file de Grist est commune au document, la vider abandonne les envois en attente
// de tous les destinataires. Les lots des exports servis sont marqués à renvoyer en entier : le
// rattrapage les renvoie ensuite.
async function unblockQueue() {
  const ok = await confirmDialog({ title: t('send.unblock.title'), body: t('send.unblock.body'), confirmLabel: t('send.action.unblock') });
  if (ok) await clearAndMark();
}

async function clearAndMark() {
  await clearWebhookQueue();
  const [rows, hooks, conditions] = await Promise.all([syncRows(), listWebhooks(), webhookConditions()]);
  const lots = rows.filter(r => r[TYPE_COL] === KIND.lot && hooksOf(hooks, conditions, r[EXPORT_COL]).some(h => h.fields.enabled)).map(r => r.id);
  await writeSync(lots, { [MISSING_COL]: RESEND_ALL });
}

// Supprimer un export : ses destinataires sont coupés, ses lignes Synchro effacées (la table
// disparaît avec le dernier export). Les colonnes id_sync et MajLe restent dans les tables.
async function deleteExport(exp) {
  const ok = await confirmDialog({ title: t('send.delete.title', { name: exp.name }), body: t('send.delete.body', { n: exp.recipients.length }), confirmLabel: t('send.action.delete') });
  if (!ok) return;
  for (const h of exp.recipients) await deleteWebhook(h.id);
  await updateNote((note) => {
    note.exports = note.exports.filter(e => e.id !== exp.id);
    note.invitations = note.invitations.filter(i => i.export !== exp.id);
    note.pauses = note.pauses.filter(p => p.export !== exp.id);
  });
  await removeExport(exp.id);
}

// ---------------------------------------------------------------------------------------------
// Lien public

async function publicCode(exp) {
  const [{ origin, docId, baseUrl }, { name: docName }] = await Promise.all([docIdentity(), docInfo()]);
  return buildInvitation({ id: exp.id, exportId: exp.id, name: exp.name, origin, base: baseUrl, from: { email: exp.email, docId, docName }, tables: exp.tables });
}

// Bouton « copier avec les consignes » : le code et les étapes de la CIBLE, prêts pour un courriel.
const handoff = (mode, code) => el('div', { class: 'handoff' },
  copyButton(() => handoffText('target', mode, 1, code), t('guide.copyHandoff')), el('span', { class: 'muted small' }, t('guide.copyHandoff.help')));

async function showPublicCode(exp) {
  const code = await publicCode(exp);
  await new Promise(resolve => openModal({ title: exp.name, onClose: resolve,
    body: [el('p', {}, t('send.public.help')), copyField(code), handoff('public', code)], buttons: [{ label: t('common.close'), kind: 'btn-primary' }] }));
}

// Couper le lien public d'un export : ses instantanés disparaissent, les règles d'accès suivent au
// prochain affichage. Tant que le document reste public, le refus général reste en place.
async function stopPublic(exp) {
  const ok = await confirmDialog({ title: t('send.public.stopTitle', { name: exp.name }), body: t('send.public.revokeBody'), confirmLabel: t('send.public.stop') });
  if (!ok) return;
  await updateNote((note) => { note.exports = note.exports.map(e => (e.id === exp.id ? { ...e, public: false } : e)); });
  await saveExport(exp.id, exp.tables, { isPublic: false });
}

// ---------------------------------------------------------------------------------------------
// Renvoi des tables d'un export depuis `since` (secondes ; RESEND_ALL : toutes les lignes), par
// tranches, puis de leur liste complète des clés (voir sendList). Rien n'est modifié dans les tables : le widget écrit les
// lignes voulues dans Synchro_Renvoi et Grist recalcule le lot. La tranche suivante attend que les
// destinataires aient tout reçu (un envoi reste sous la limite de taille de Grist) ; une tranche
// trop grosse pour un lot est coupée en deux. Le renvoi est reprenable : la marque du lot
// (MISSING_COL, voir chunkMark) est posée avant la première tranche et avance avec chacune ; une
// page fermée en cours de route, le rattrapage reprend à la prochaine ouverture. Une marque déjà
// plus ancienne l'emporte. Rend le nombre de lignes renvoyées. Un renvoi à la fois, tous onglets
// confondus, et un seul par document (voir withCharge) : si une autre page renvoie déjà, les lots
// sont seulement marqués, et le rattrapage les enverra ensuite (rend alors null).
const startOf = (lot, since) => (lot[MISSING_COL] > 0 ? Math.min(lot[MISSING_COL], since) : since);

function resendTables(exportId, tables, out, since = RESEND_ALL) {
  return withLock('gristsync-resend', async () => {
    try {
      return await withCharge(() => resendLocked(exportId, tables, out, since), out);
    } catch (e) {
      if (e.message !== 'resendBusy') throw e;
      const lots = (await syncRows()).filter(r => r[EXPORT_COL] === exportId && tables.includes(r[TABLE_COL]) && r[TYPE_COL] === KIND.lot);
      for (const lot of lots) await writeSync([lot.id], { [MISSING_COL]: startOf(lot, since) });
      return null;
    }
  });
}

async function resendLocked(exportId, tables, out, since) {
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  const hookIds = hooksOf(hooks, conditions, exportId).filter(h => h.fields.enabled).map(h => h.id);
  if (!hookIds.length) return 0;
  const rowsOf = async (table, kind) => (await fetchRows(SYNC_TABLE)).filter(r => r[EXPORT_COL] === exportId && r[TABLE_COL] === table && r[TYPE_COL] === kind);
  const plans = [];
  for (const table of tables) {
    const [lot] = await rowsOf(table, KIND.lot);
    if (!lot || !(await readSchema()).has(table)) continue; // table retirée ou introuvable : la carte le dit
    const start = startOf(lot, since);
    await writeSync([lot.id], { [MISSING_COL]: start });
    plans.push({ table, lot: lot.id, start, rows: rowsSince(await fetchRows(table), start) });
  }
  const total = plans.reduce((n, p) => n + p.rows.length, 0);
  let done = 0;
  const progress = () => {
    if (!out) return;
    out.replaceChildren(message('info', t('send.load.progress', { done, total })));
    out.scrollIntoView({ block: 'nearest' });
  };
  for (const { table, lot, start, rows } of plans) {
    // Une table sans ligne à renvoyer part quand même en lot de renvoi (vide) : la CIBLE remet à
    // zéro son compte de lignes non arrivées.
    const queue = rows.length ? chunk(rows, RESEND_CHUNK) : [[]];
    while (queue.length) {
      const part = queue.shift();
      await waitForQueue(hookIds);
      await writeSync([lot], { [RESEND_COL]: resendValue(randomHex(4), part.map(r => r.id)), [MISSING_COL]: part.length ? chunkMark(part, start) : start });
      const cell = String(((await fetchRows(SYNC_TABLE)).find(r => r.id === lot) || {})[LOT_COL] || '');
      await spend(cell.length * hookIds.length);
      const sent = parseLot(cell);
      if (sent && sent.total > sent.lines.length && part.length > 1) {
        queue.unshift(part.slice(0, part.length / 2), part.slice(part.length / 2));
        continue;
      }
      done += part.length;
      progress();
    }
    await waitForQueue(hookIds);
    // Marque effacée à part : écrite avec le lot ordinaire, elle cacherait un nouvel envoi coupé.
    await writeSync([lot], { [MISSING_COL]: 0 });
    await writeSync([lot], { [RESEND_COL]: '' });
    await sendList(exportId, table, hookIds);
  }
  if (out) out.replaceChildren();
  return total;
}

// Liste complète des clés d'une table, en morceaux (PART_KEYS clés), chacun quand le précédent est
// parti : la CIBLE efface les clés absentes une fois tous les morceaux arrivés. Ses lignes sont
// déjà là : c'est elle qui fait partir les suppressions qu'une liste des clés parties n'a pas
// portées (file vidée, pause, trop de clés parties d'un coup). La demande du morceau reste dans la
// ligne 'cles' jusqu'à la fin : une page fermée en cours de route, le rattrapage recommence.
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

// Rattrapage, tant qu'un propriétaire a la page du widget ouverte : à l'affichage, puis toutes les
// 10 secondes, un onglet à la fois.
//  - Envoi refusé pour sa taille (413 : plus de 1 Mo, quand Grist regroupe des envois qui ont
//    attendu) : Grist le retenterait sans fin et la file resterait bloquée. Le widget la vide, et
//    marque à renvoyer en entier chaque export qui a un destinataire actif. Pas plus d'une fois en
//    10 minutes, et pas quand une table est trop grande (sa liste seule déborde : la carte le dit).
//  - Lot marqué (envoi coupé par un gros changement ou une référence très utilisée renommée,
//    renvoi interrompu, file vidée) : ses lignes depuis la marque repartent, puis la liste
//    complète. Liste demandée (renvoi de la liste interrompu, trop de clés parties d'un coup) :
//    la liste complète repart. Export sans destinataire : marque et demande effacées (un
//    destinataire ajouté reçoit tout). Destinataires tous en pause : marque gardée pour après la
//    reprise. File bloquée par un autre échec (lien de réception mort) : rien ne part tant que la
//    carte le signale, renvoyer ne ferait qu'attendre.
let catching = false;
let notOwner = false;
let repairedAt = 0;
async function catchUp() {
  if (catching || notOwner) return;
  catching = true;
  try {
    const done = await withLock('gristsync-resend', async () => {
      let rows = await lightRows();
      if (!rows) return 0;
      const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
      if (hooks.some(tooLarge) && Date.now() - repairedAt > 600000) {
        repairedAt = Date.now();
        await clearAndMark();
        rows = await lightRows();
      }
      if (hooks.some(h => h.fields.enabled && !tooLarge(h) && hookStatus(h)[0] === 'error')) return 0;
      const late = rows.filter(r => r[TYPE_COL] === KIND.lot && r[MISSING_COL] > 0);
      const same = (a, b) => a[EXPORT_COL] === b[EXPORT_COL] && a[TABLE_COL] === b[TABLE_COL];
      const lists = rows.filter(r => listDue(r) && !late.some(l => same(l, r)));
      if (!late.length && !lists.length) return 0;
      await withCharge(async () => {
        for (const row of late) {
          const mine = hooksOf(hooks, conditions, row[EXPORT_COL]);
          if (!mine.length) await writeSync([row.id], { [MISSING_COL]: 0 });
          else if (mine.some(h => h.fields.enabled)) await resendLocked(row[EXPORT_COL], [row[TABLE_COL]], null, row[MISSING_COL]);
        }
        for (const row of lists) {
          const mine = hooksOf(hooks, conditions, row[EXPORT_COL]);
          if (!mine.length) await writeSync([row.id], { [RESEND_COL]: row[TYPE_COL] === KIND.keys ? '' : trackState(row).trop });
          else if (mine.some(h => h.fields.enabled)) await sendList(row[EXPORT_COL], row[TABLE_COL], mine.filter(h => h.fields.enabled).map(h => h.id));
        }
      });
      return late.length + lists.length;
    });
    if (done && container && container.isConnected && !document.querySelector('.scrim')) await renderSource();
  } catch (e) {
    if (e.message === 'ownerOnly') notOwner = true;
    else if (e.message !== 'resendBusy') console.warn(e);
  } finally {
    catching = false;
  }
}

// Lignes de Synchro utiles au rattrapage, sans les lots ni les listes (de grosses cellules), car
// lues toutes les 10 secondes. Null sans la table.
async function lightRows() {
  const rows = await selectRows(SYNC_TABLE, [EXPORT_COL, TABLE_COL, TYPE_COL, RESEND_COL, STATE_COL]);
  if (rows) return rows.filter(r => !isCharge(r));
  return (await readSchema()).has(SYNC_TABLE) ? syncRows() : null;
}

// ---------------------------------------------------------------------------------------------
// Renvois ménagés (voir parseCharge) : la ligne 'charge' de Synchro dit quelle page renvoie et ce
// qui est parti ces dix dernières minutes. Une page qui dépasse le budget attend, en donnant signe
// de vie ; une autre page (autre personne, autre navigateur) ne lance rien pendant ce temps.
const BROWSER = readPref('browser') || randomHex(4);
writePref('browser', BROWSER);
const PAGE = `${BROWSER}.${randomHex(4)}`;
let charge = null; // { id, state, saved, out } pendant un renvoi de cette page

// Page fermée en plein renvoi : elle rend la main si Grist reçoit encore son écriture (sinon une
// autre page de ce navigateur la reprend aussitôt, une autre personne après LEASE_S secondes).
window.addEventListener('pagehide', () => {
  if (charge) apply([['UpdateRecord', SYNC_TABLE, charge.id, { [RESEND_COL]: JSON.stringify({ ...charge.state, par: '', reprise: 0 }) }]]);
});

async function readCharge() {
  const rows = await selectRows(SYNC_TABLE, [TYPE_COL, RESEND_COL]);
  return (rows && rows.find(isCharge)) || chargeRow();
}

async function withCharge(fn, out = null) {
  const row = await readCharge();
  const state = parseCharge(row[RESEND_COL]);
  if (chargeBusy(state, PAGE, now())) throw new Error('resendBusy');
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
  if (charge.state.par && chargeBusy(current, PAGE, now())) throw new Error('resendBusy');
  if (!charge.state.par && current.par && current.par !== PAGE) return;
  charge.state.le = now();
  charge.saved = now();
  await writeSync([charge.id], { [RESEND_COL]: JSON.stringify(charge.state) });
}

// Signe de vie pendant une longue attente (file d'envoi, budget).
async function beat() {
  if (charge && now() - charge.saved > 20) await saveCharge();
}

// Octets partis (une copie par destinataire). Au-delà du budget, attendre que la fenêtre se vide.
async function spend(bytes) {
  charge.state = addSpent(charge.state, now(), bytes);
  const wait = budgetWait(charge.state, now());
  if (wait > 0) {
    charge.state.reprise = now() + wait;
    await saveCharge();
    if (charge.out) charge.out.replaceChildren(message('info', t('send.charge.wait', { at: timeText(charge.state.reprise) })));
    while (now() < charge.state.reprise) {
      await sleep(Math.min(30, charge.state.reprise - now()) * 1000);
      await saveCharge();
    }
    charge.state.reprise = 0;
  }
  await beat();
}

function chargeNotice(state) {
  if (state.reprise > now()) return message('info', t('send.charge.wait', { at: timeText(state.reprise) }));
  return chargeBusy(state, PAGE, now()) ? message('info', t('send.charge.busy')) : null;
}

export function startAutoCatchUp() {
  setInterval(catchUp, 10000);
}

// Lot refusé pour sa taille. L'état d'un webhook est remis à zéro quand la file est vidée, mais un
// envoi en vol peut encore y écrire son échec : seul compte l'envoi que Grist retente.
function tooLarge(h) {
  const u = h.usage || {};
  return ['retrying', 'postponed'].includes(u.status) && (u.lastEventBatch || {}).httpStatus === 413;
}

async function waitForQueue(hookIds) {
  for (let i = 0; i < 60; i++) {
    const hooks = (await listWebhooks()).filter(h => hookIds.includes(h.id));
    if (hooks.some(tooLarge)) throw new Error('tooLarge');
    if (!hooks.some(h => h.usage && h.usage.numWaiting)) return;
    await beat();
    await sleep(1500);
  }
  throw new Error('queueStuck');
}

// ---------------------------------------------------------------------------------------------
// Assistant d'export : Tables, Colonnes, Nom. Crée l'export, ou le modifie (`exp`) : ajouter ou
// retirer des tables, changer les colonnes ou le nom vaut pour tous ses destinataires.

function exportWizard(exp = null) {
  const wizard = openWizard({
    title: exp ? t('send.edit.title', { name: exp.name }) : t('send.new'),
    steps: ['send.step.tables', 'send.step.columns', 'send.step.name'].map(k => t(k)),
    onClose: () => renderSource(),
  });
  const cancel = { label: t('common.cancel') };
  let chosen = exp ? exp.tables.map(tb => tb.table) : [];
  const selected = new Map(exp ? exp.tables.map(tb => [tb.table, tb.columns.map(c => c.id)]) : []); // table -> colonnes cochées
  const filters = new Map(exp ? exp.tables.map(tb => [tb.table, tb.filter]) : []); // table -> filtre de lignes, ou null
  showTables();

  // 1. Tables de l'export. Une table introuvable (renommée, effacée) en sort.
  async function showTables() {
    const tables = (await readSchema()).tableIds.filter(isUserTable);
    chosen = chosen.filter(table => tables.includes(table));
    const report = el('div', { class: 'report' });
    const next = { label: t('common.next'), kind: 'btn-primary', disabled: !chosen.length, onClick: () => run(null, report, showColumns) };
    const body = [el('p', {}, t(exp ? 'send.edit.tables' : 'send.tables.help')), checkList({
      items: tables.map(id => ({ value: id, label: id })), checked: chosen, label: t('send.step.tables'),
      onChange: (values) => { chosen = values; next.disabled = !chosen.length; wizard.buttons([cancel, next]); },
    }), report, stepHelp(['s-tables']), exp ? null : roleGuide({ you: 'source', current: 0 })];
    wizard.show(0, body, [cancel, next]);
  }

  // 2. Colonnes, par table (toutes par défaut), et ce que le widget ajoutera pour la synchro.
  async function showColumns() {
    const schema = await readSchema();
    const relays = receivedDests(schema).map(d => d.dest);
    const report = el('div', { class: 'report' });
    const adds = [];
    const blocks = chosen.map((table) => {
      const all = exportableColumns(schema.columns(table));
      const usable = all.filter(c => !c.blocked);
      if (!selected.has(table)) selected.set(table, usable.map(c => c.id));
      const blocked = all.filter(c => c.blocked).map(c => c.id);
      adds.push(...missingSyncColumns(schema.columns(table)).map(col => `${table}.${col}`));
      return el('div', { class: 'form' }, el('h3', {}, table),
        relays.includes(table) ? message('info', t('send.columns.relay')) : null,
        checkList({ items: usable.map(c => ({ value: c.id, label: columnLabel(c), hint: typeName(c.source) })),
          checked: selected.get(table), label: table, onChange: (values) => { selected.set(table, values); } }),
        blocked.length ? el('p', { class: 'muted small' }, t('send.columns.blocked', { cols: blocked.join(', ') })) : null,
        filterField(table, usable, filters.get(table), (filter) => { filters.set(table, filter); }));
    });
    if (!schema.has(SYNC_TABLE)) adds.push(t('send.check.sync'));
    const removed = exp ? exp.tables.map(tb => tb.table).filter(table => !chosen.includes(table)) : [];
    wizard.show(1, [el('p', {}, t('send.columns.help')),
      removed.length ? message('warn', t('send.edit.removed', { tables: removed.join(', ') })) : null,
      ...blocks,
      adds.length ? message('info', t('send.check.missing', { items: adds.join(', ') })) : null, report, stepHelp(['s-columns'])], [
      { label: t('common.back'), onClick: showTables },
      { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, () => {
        if (chosen.some(table => !(selected.get(table) || []).length)) throw new Error('noColumn');
        showName();
      }) }]);
  }

  // 3. Nom, puis création (ou enregistrement) : c'est ici seulement que le widget écrit.
  function showName() {
    const nameInput = el('input', { type: 'text', class: 'input', id: 'gristsync-export-name', value: exp ? exp.name : chosen.join(' + ') });
    const report = el('div', { class: 'report' });
    wizard.show(2, [el('label', { for: 'gristsync-export-name' }, t('send.name')), nameInput, el('p', { class: 'muted small' }, t('send.name.help')), report], [
      { label: t('common.back'), onClick: () => run(null, report, showColumns) },
      { label: exp ? t('common.save') : t('send.create'), kind: 'btn-primary', onClick: () => run(null, report, () => save(nameInput.value.trim() || chosen.join(' + '), report)) }]);
  }

  async function save(name, report) {
    // Un seul instantané suffit : chaque étape ne touche que sa table, et les colonnes que le
    // widget ajoute (id_sync, MajLe) ne sont pas envoyables.
    const schema = await readSchema();
    const relays = receivedDests(schema).map(d => d.dest);
    const tables = [];
    for (const table of chosen) {
      await apply(prepareSourceActions(table, missingSyncColumns(schema.columns(table))));
      // Table reçue (relais) : ses lignes gardent la clé de leur document d'origine. Une ligne
      // ajoutée ici à la main reste sans clé, donc locale : avec une clé, la prochaine liste
      // de l'origine, qui ne la connaît pas, l'effacerait.
      if (!relays.includes(table)) await apply(fillKeyActions(table, await fetchRows(table), () => crypto.randomUUID()));
      tables.push({
        table, columns: exportableColumns(schema.columns(table)).filter(c => !c.blocked && selected.get(table).includes(c.id)), filter: filters.get(table) || null,
      });
    }
    const id = exp ? exp.id : randomHex(8);
    const changed = await saveExport(id, tables, { isPublic: Boolean(exp && exp.public) });
    await updateNote((note) => {
      const others = note.exports.filter(e => e.id !== id);
      note.exports = [...others, { ...(exp ? note.exports.find(e => e.id === id) : {}), id, name, at: exp ? exp.at : now() }];
    });
    if (!exp) {
      const created = { id, name, tables, recipients: [], invitations: [], public: false, email: '' };
      wizard.show(3, [message('ok', t('send.created', { name })), el('p', {}, t('send.created.next'))], [
        { label: t('common.later') },
        { label: t('send.action.addPerson'), kind: 'btn-primary', onClick: () => { wizard.close(); recipientWizard(created); } }]);
      return;
    }
    if (name !== exp.name) for (const h of exp.recipients) await renameWebhook(h.id, hookName(name, id));
    const n = changed.length ? await resendTables(id, changed, report) : 0;
    const saved = n === null ? message('info', t('send.load.queued')) : message('ok', n ? t('send.edit.saved', { n }) : t('send.edit.savedNone'));
    wizard.show(3, saved, [{ label: t('common.close'), kind: 'btn-primary' }]);
  }
}

const columnLabel = c => (c.label === c.id ? c.id : `${c.label} (${c.id})`);

// Filtre de lignes d'une table, facultatif : une colonne et la valeur qu'ont les lignes envoyées.
// `onChange` reçoit le filtre ({ id, source, visible, value }), ou null pour toutes les lignes.
function filterField(table, columns, current, onChange) {
  const input = el('input', { type: 'text', class: 'input', value: current ? current.value : '', 'aria-label': t('send.filter.value', { table }) });
  const hint = el('p', { class: 'muted small' });
  const filter = () => {
    const c = columns.find(col => col.id === pick.value());
    return c ? { id: c.id, source: c.source, visible: c.visible, value: input.value } : null;
  };
  const show = (id) => {
    const c = columns.find(col => col.id === id);
    input.hidden = !c;
    hint.textContent = c ? t(c.source === 'Bool' ? 'send.filter.bool' : 'send.filter.help') : '';
    onChange(filter());
  };
  const pick = pickField({
    items: [{ value: '', label: t('send.filter.all') }, ...columns.map(c => ({ value: c.id, label: columnLabel(c) }))],
    value: current ? current.id : '', label: t('send.filter.title', { table }), onChange: show,
  });
  input.addEventListener('input', () => onChange(filter()));
  show(current ? current.id : '');
  return el('div', { class: 'filter-field' }, el('p', { class: 'field-title' }, t('send.filter.title', { table })), pick, input, hint);
}

// ---------------------------------------------------------------------------------------------
// Assistant d'ajout d'un destinataire : Options, Invitation, Réponse, Envoi (Options et Invitation
// seulement pour le lien public). Une invitation en attente le rouvre à l'étape Réponse
// (`pending`).

const STEP = { options: 0, invitation: 1, reply: 2, load: 3 };

function recipientWizard(exp, pending = null) {
  const steps = ['send.step.options', 'send.step.invitation', 'send.step.reply', 'send.step.load'].map(k => t(k));
  const wizard = openWizard({ title: t('send.person.title', { name: exp.name }), steps, onClose: () => renderSource() });
  const cancel = { label: t('common.cancel') };
  if (pending) return showReply(pending);
  return showOptions();

  // 1. Mode (réponse ou lien public) et secret (sans objet pour le lien public : grisé).
  function showOptions() {
    const secretBox = el('input', { type: 'checkbox', checked: true });
    const secretPart = el('div', { class: 'form' }, el('label', { class: 'check' }, secretBox, t('send.secret')), el('p', { class: 'muted small' }, t('send.secret.help')));
    const publicPart = el('div', { class: 'hidden' }, message('warn', t('send.public.warn')));
    const radio = (value, label, checked, disabled) => el('label', { class: 'check' },
      el('input', { type: 'radio', name: 'gristsync-mode', value, checked, disabled, onchange: () => {
        secretBox.disabled = value === 'public'; publicPart.classList.toggle('hidden', value !== 'public');
      } }), label);
    const report = el('div', { class: 'report' });
    const mode = () => (document.querySelector('input[name="gristsync-mode"]:checked') || {}).value;
    wizard.show(STEP.options, [
      message('info', t('send.person.tables', { tables: exp.tables.map(tb => tb.table).join(', ') })),
      el('p', { class: 'field-title', id: 'gristsync-mode-title' }, t('send.mode')),
      el('div', { class: 'form', role: 'radiogroup', 'aria-labelledby': 'gristsync-mode-title' },
        radio('reponse', t('send.mode.reply'), true, false),
        radio('public', exp.public ? t('send.mode.publicDone') : t('send.mode.public'), false, exp.public)),
      secretPart, publicPart, report, stepHelp(['s-options', 'public']), roleGuide({ you: 'source', current: 0 }),
    ], [cancel, { label: t('send.invite'), kind: 'btn-primary', onClick: () => run(null, report, () => invite(mode() !== 'public' && secretBox.checked, mode() === 'public')) }]);
  }

  // 2. Invitation : le code à transmettre ; elle attend sa réponse sur la carte de l'export.
  async function invite(withSecret, isPublicMode) {
    if (isPublicMode) {
      await updateNote((note) => { note.exports = note.exports.map(e => (e.id === exp.id ? { ...e, public: true } : e)); });
      await saveExport(exp.id, exp.tables, { isPublic: true });
      // Les règles d'accès sont posées à la fermeture (le document se recharge alors).
      const code = await publicCode(exp);
      wizard.setSteps(steps.slice(0, 2));
      wizard.show(STEP.invitation, [el('p', {}, t('send.public.help')), copyField(code), handoff('public', code),
        message('warn', t('send.public.turnOn')), roleGuide({ you: 'source', mode: 'public', current: 1, open: true }), stepHelp(['public'])],
      [{ label: t('common.close'), kind: 'btn-primary' }]);
      return;
    }
    const secret = withSecret ? randomHex(16) : '';
    const entry = { id: randomHex(8), export: exp.id, hash: secret ? await sha256(secret) : '', at: now() };
    await updateNote((note) => { note.invitations = [...note.invitations, entry]; });
    const [{ origin, docId }, { name: docName }, rows] = await Promise.all([docIdentity(), docInfo(), syncRows()]);
    const email = (rows.find(r => r[EXPORT_COL] === exp.id) || {})[AUTHOR_COL] || '';
    const code = buildInvitation({ id: entry.id, exportId: exp.id, name: exp.name, origin, secret, from: { email, docId, docName }, tables: exp.tables });
    wizard.show(STEP.invitation, [el('p', {}, t('send.invite.help')), copyField(code), handoff('reponse', code),
      roleGuide({ you: 'source', current: 1, open: true }), stepHelp(['s-invite', 't-code', 't-dest', 't-link', 't-reply'])],
    [{ label: t('common.later') }, { label: t('send.reply.ready'), kind: 'btn-primary', onClick: () => showReply(entry) }]);
  }

  // 3. Réponse : vérifier, montrer la fiche, approuver. La réponse doit désigner cette invitation
  // et porter le même secret (comparé par empreinte).
  function showReply(inv) {
    const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('send.reply.title') });
    const report = el('div', { class: 'report' });
    const check = async () => {
      const { origin, docId } = await docIdentity();
      const reply = parseReply(area.value, origin);
      if (reply.id !== inv.id || inv.hash !== (reply.secret ? await sha256(reply.secret) : '')) throw new Error('unknownInvitation');
      if (loopingTables(exp.tables.map(tb => tb.table), reply.recipient.docId, receivedDests(await readSchema())).length) throw new Error('loop');
      const r = reply.recipient;
      const fiche = [[t('send.reply.tables'), exp.tables.map(tb => tb.table).join(', ')], [t('send.reply.email'), r.email],
        [t('send.reply.doc'), r.docId === docId ? `${docLabel(r.docName, r.docId)} · ${t('send.reply.sameDoc')}` : docLabel(r.docName, r.docId)], [t('send.reply.team'), r.team], [t('send.reply.at'), r.at]];
      report.replaceChildren(...[el('dl', { class: 'fiche' }, fiche.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')])),
        reply.secret ? null : message('warn', t('send.reply.nosecret')),
        el('p', { class: 'muted small' }, maskKey(reply.url))].filter(Boolean));
      wizard.show(STEP.reply, body, [{ label: t('common.later') },
        { label: t('send.reply.approve'), kind: 'btn-primary', onClick: () => run(null, report, () => approve(inv, reply)) }]);
    };
    const body = [el('p', {}, t('send.reply.help')), area, report, stepHelp(['s-reply', 's-load']), roleGuide({ you: 'source', current: 3 })];
    wizard.show(STEP.reply, body, [{ label: t('common.later') }, { label: t('send.reply.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }]);
  }

  // Un webhook sur Synchro, filtré sur l'export, vers le journal de la CIBLE.
  async function approve(inv, reply) {
    const r = reply.recipient;
    await createWebhook({
      name: hookName(exp.name, exp.id), memo: [r.email, docLabel(r.docName, r.docId), r.team].filter(Boolean).join(' · '), url: reply.url,
      tableId: SYNC_TABLE, condition: exportCondition(exp.id),
    });
    await updateNote((note) => { note.invitations = note.invitations.filter(i => i.id !== inv.id); });
    await showLoad();
  }

  // 4. Envoi : le branchement n'envoie que les modifications à venir ; proposer l'existant.
  async function showLoad() {
    let total = 0;
    for (const { table } of exp.tables) total += (await fetchRows(table)).length;
    const report = el('div', { class: 'report' });
    const send = async () => {
      const n = await resendTables(exp.id, exp.tables.map(tb => tb.table), report);
      wizard.show(STEP.load + 1, n === null ? message('info', t('send.load.queued')) : message('ok', t('send.done')), [{ label: t('common.close'), kind: 'btn-primary' }]);
    };
    if (!total) {
      wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.empty'))], [{ label: t('common.close'), kind: 'btn-primary' }]);
      return;
    }
    wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.body', { n: total })), report],
      [{ label: t('common.later') }, { label: t('send.load.ok'), kind: 'btn-primary', onClick: () => run(null, report, send) }]);
  }
}
