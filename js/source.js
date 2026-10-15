// Onglet « Envoyer » (document SOURCE) : des exports (un nom, des tables et leurs colonnes) et,
// pour chacun, ses destinataires. Une seule table technique, Synchro ; un webhook par
// destinataire, filtré par Grist sur les lignes de son export. Les exports, les invitations en
// attente et les pauses sont notés dans la description d'une colonne de Synchro.
import {
  AUTHOR_COL, EXPORT_COL, KIND, LOT_COL, MISSING_COL, ORDER_COL, PUBLIC_MEMO, RESEND_CHUNK, SYNC_TABLE, TABLE_COL, TYPE_COL,
  buildInvitation, chunk, conditionExport, exportCondition, exportTables, exportableColumns, fillKeyActions, hookName, isPublicRule, loopingTables,
  maskKey, missingSyncColumns, parseLot, parseReply, prepareSourceActions, publicAclActions, publicAclRules, resendValue,
} from './core.js';
import {
  apply, clearWebhookQueue, createWebhook, deleteWebhook, docIdentity, fetchRows, listWebhooks, readSchema, renameWebhook, setWebhookEnabled,
  webhookConditions,
} from './grist.js';
import {
  JOURNAL_PREFIX, ensureSyncTable, legacyTables, readSourceNote, receivedDests, refreshMajLe, removeExport, removeLegacy, saveExport, syncRows,
  writeResend, writeSourceNote,
} from './tables.js';
import { checkList, confirmDialog, copyButton, copyField, el, icon, message, openModal, openWizard, run } from './ui.js';
import { handoffText, roleGuide } from './guide.js';
import { stepHelp } from './tutorial.js';
import { t } from './i18n.js';

const now = () => Date.now() / 1000;
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

// Tables que l'on peut envoyer : celles de la personne, pas celles du widget.
const isUserTable = id => id !== SYNC_TABLE && !id.startsWith('Synchro_') && !id.startsWith(JOURNAL_PREFIX);

let container;

// ---------------------------------------------------------------------------------------------
// État du document : exports (note + lignes Synchro), destinataires (webhooks sur Synchro, rangés
// par l'export que nomme leur condition), invitations en attente.

async function loadState() {
  let hooks = [];
  let ownerOnly = false;
  try { hooks = await listWebhooks(); } catch (e) { if (e.message !== 'ownerOnly') throw e; ownerOnly = true; }
  const conditions = ownerOnly ? new Map() : await webhookConditions();
  const schema = await readSchema();
  const rows = await syncRows();
  const note = readSourceNote(schema);
  const exportOf = h => conditionExport(conditions.get(h.id));
  const syncHooks = hooks.filter(h => h.fields.tableId === SYNC_TABLE);
  const ids = [...new Set([...note.exports.map(e => e.id), ...rows.map(r => r[EXPORT_COL])])];
  const exports = ids.map((id) => {
    const meta = note.exports.find(e => e.id === id) || { id, name: id };
    const recipients = syncHooks.filter(h => exportOf(h) === id);
    return {
      ...meta, tables: exportTables(rows, id), recipients, invitations: note.invitations.filter(i => i.export === id),
      email: (rows.find(r => r[EXPORT_COL] === id) || {})[AUTHOR_COL] || '',
      partial: recipients.some(h => h.fields.enabled) && rows.some(r => r[EXPORT_COL] === id && r[MISSING_COL] > 0),
    };
  });
  const legacy = { tables: legacyTables(schema), hooks: hooks.filter(h => h.fields.tableId !== SYNC_TABLE) };
  return { ownerOnly, schema, note, exports, unsafe: syncHooks.filter(h => !exportOf(h)), legacy };
}

async function updateNote(change) {
  const note = readSourceNote(await readSchema());
  change(note);
  await writeSourceNote(note);
}

// Lien public : le document est-il lisible sans identifiant ? (requête anonyme)
async function isPublic(base) {
  try { return (await fetch(base, { credentials: 'omit' })).ok; } catch (e) { return false; }
}

// Règles d'accès du lien public, accordées aux exports partagés : réécrites seulement si elles
// diffèrent (changer une règle fait recharger le document, et donc le widget). Le refus général
// reste tant que le document est public.
async function syncPublicRules(exportIds, open) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const name = id => (resources.find(r => r.id === id) || {}).tableId;
  const have = rules.filter(isPublicRule).map(r => `${name(r.resource)}|${r.aclFormula}|${r.permissionsText}|${r.memo}`).sort().join('\n');
  const want = publicAclRules(exportIds, { keepDeny: open }).map(r => `${r.tableId}|${r.aclFormula}|${r.permissionsText}|${PUBLIC_MEMO}`).sort().join('\n');
  if (have !== want) await apply(publicAclActions(resources, rules, exportIds, { keepDeny: open }));
}

// ---------------------------------------------------------------------------------------------
// Tableau de bord : une carte par export.

export async function renderSource(root = container) {
  container = root;
  let state = await loadState();
  // Mise à niveau silencieuse du montage (colonnes de Synchro, dépendances de MajLe), puis
  // rattrapage d'un envoi coupé.
  if (!state.ownerOnly && state.schema.has(SYNC_TABLE)) {
    await ensureSyncTable();
    await refreshMajLe();
    state = await loadState();
    catchUp();
  }
  // Document lisible par lien public ? Vérifié à chaque affichage : tant qu'il l'est, le refus
  // général posé par le widget reste en place, même sans export public.
  const open = await isPublic((await grist.docApi.getAccessToken({ readOnly: true })).baseUrl);
  if (!state.ownerOnly) await syncPublicRules(state.exports.filter(e => e.public).map(e => e.id), open);

  const out = el('div', { class: 'out' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: state.ownerOnly, onclick: () => exportWizard() }, icon('plus'), t('send.new')));
  const cards = state.exports.map(exp => exportCard(exp, state, open, out));
  if (state.unsafe.length) cards.unshift(unsafeCard(state.unsafe, out));
  if (state.legacy.tables.length) cards.push(legacyCard(state, out));
  container.replaceChildren(...[toolbar,
    state.ownerOnly ? message('warn', t('common.ownerOnly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'muted' }, t('send.empty')),
    roleGuide({ you: 'source', open: !cards.length })].filter(Boolean));
}

function actionButton(label, iconName, fn, ownerOnly, out, kind = '') {
  return el('button', {
    class: `btn btn-small ${kind}`, type: 'button', disabled: ownerOnly,
    onclick: e => run(e.currentTarget, out, async () => { await fn(); await renderSource(); }),
  }, icon(iconName), label);
}

const pill = (key, tone, vars) => el('span', { class: `pill pill-${tone}` }, t(`send.status.${key}`, vars));

function hookStatus(h) {
  if (!h.fields.enabled) return ['paused', 'off'];
  const u = h.usage || {};
  return ['retrying', 'error'].includes(u.status) || u.lastHttpStatus >= 400 ? ['error', 'err'] : ['active', 'ok'];
}

function exportCard(exp, state, open, out) {
  const { ownerOnly } = state;
  const action = (label, iconName, fn, kind) => actionButton(label, iconName, fn, ownerOnly, out, kind);
  const n = exp.recipients.length;
  const failing = exp.recipients.some(h => hookStatus(h)[0] === 'error');
  const [status, tone] = failing ? ['error', 'err'] : n || exp.public ? ['people', 'ok'] : exp.invitations.length ? ['invited', 'pending'] : ['alone', 'off'];
  const rows = [
    ...exp.recipients.map(h => personRow(exp, h, ownerOnly, out)),
    ...exp.invitations.map(inv => inviteRow(exp, inv, ownerOnly, out)),
    exp.public ? publicRow(exp, open, ownerOnly, out) : null,
  ].filter(Boolean);
  return el('article', { class: 'card', 'data-export': exp.id },
    el('div', { class: 'card-head' }, el('strong', {}, exp.name), pill(status, tone, { n: n + (exp.public ? 1 : 0) })),
    el('p', { class: 'muted small' }, exp.tables.map(tb => t('send.export.table', { table: tb.table, n: tb.columns.length })).join(' · ') || '—'),
    exp.partial && n ? message('info', t('send.export.partial')) : null,
    rows.length ? el('ul', { class: 'people' }, rows) : el('p', { class: 'small' }, t('send.export.nobody')),
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: ownerOnly, onclick: () => recipientWizard(exp) }, icon('plus'), t('send.action.addPerson')),
      el('button', { class: 'btn btn-small', type: 'button', disabled: ownerOnly, onclick: () => exportWizard(exp) }, icon('edit'), t('send.action.edit')),
      n ? action(t('send.action.load'), 'send', () => resendTables(exp.id, exp.tables.map(tb => tb.table), out)) : null,
      action(t('send.action.delete'), 'trash', () => deleteExport(exp), 'btn-danger-text')));
}

// Un destinataire : sa fiche (mémo du webhook), son état, et ce qu'on peut faire pour lui seul.
function personRow(exp, h, ownerOnly, out) {
  const [status, tone] = hookStatus(h);
  const u = h.usage || {};
  const action = (label, iconName, fn, kind) => actionButton(label, iconName, fn, ownerOnly, out, kind);
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, h.fields.memo || '—'), pill(status, tone)),
    u.lastSuccessTime ? el('p', { class: 'muted small' }, t('send.lastOk', { at: new Date(u.lastSuccessTime).toLocaleString() })) : null,
    u.numWaiting ? el('p', { class: 'small' }, t('send.waiting', { n: u.numWaiting })) : null,
    status === 'error' && u.lastErrorMessage ? el('p', { class: 'small text-danger' }, `${u.lastHttpStatus || ''} ${u.lastErrorMessage}`) : null,
    el('div', { class: 'person-actions' },
      status === 'paused' ? action(t('send.action.resume'), 'play', () => resume(exp, h, out))
        : action(t('send.action.pause'), 'pause', () => pause(exp, h)),
      status === 'error' ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
      action(t('send.action.revoke'), 'trash', () => revoke(exp, h), 'btn-danger-text')));
}

function inviteRow(exp, inv, ownerOnly, out) {
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' },
      el('span', { class: 'person-who' }, t('send.invite.pending', { at: new Date(inv.at * 1000).toLocaleString() })), pill('invited', 'pending')),
    el('p', { class: 'muted small' }, inv.hash ? t('send.secret.on') : t('send.secret.off')),
    el('div', { class: 'person-actions' },
      el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: ownerOnly, onclick: () => recipientWizard(exp, inv) }, icon('paste'), t('send.reply')),
      actionButton(t('send.action.cancel'), 'trash', () => cancelInvitation(inv), ownerOnly, out, 'btn-danger-text')));
}

// Lien public : pas de webhook, la CIBLE lit elle-même les instantanés de l'export.
function publicRow(exp, open, ownerOnly, out) {
  return el('li', { class: 'person' },
    el('div', { class: 'person-head' }, el('span', { class: 'person-who' }, t('send.public.label')), pill(open ? 'public' : 'publicOff', open ? 'ok' : 'pending')),
    open ? null : el('p', { class: 'small' }, t('send.public.turnOn')),
    el('div', { class: 'person-actions' },
      actionButton(t('send.public.code'), 'copy', () => showPublicCode(exp), ownerOnly, out),
      actionButton(t('send.public.stop'), 'trash', () => stopPublic(exp), ownerOnly, out, 'btn-danger-text')));
}

function unsafeCard(hooks, out) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, t('send.unsafe.title')), pill('error', 'err')),
    el('p', { class: 'small' }, t('send.unsafe.body', { who: hooks.map(h => h.fields.memo || h.fields.name).join(', ') })),
    el('div', { class: 'card-actions' }, actionButton(t('send.unsafe.delete'), 'trash', async () => {
      for (const h of hooks) await deleteWebhook(h.id);
    }, false, out, 'btn-danger-text')));
}

// Montage d'avant la version 0.4 : à refaire avec un export ; le bouton efface l'ancien.
function legacyCard(state, out) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, t('send.legacy.title')), pill('legacy', 'pending')),
    el('p', { class: 'small' }, t('send.legacy.body', { tables: state.legacy.tables.join(', ') })),
    el('div', { class: 'card-actions' }, actionButton(t('send.legacy.clean'), 'trash', async () => {
      const ok = await confirmDialog({ title: t('send.legacy.title'), body: t('send.legacy.confirm'), confirmLabel: t('send.legacy.clean'), danger: true });
      if (!ok) return;
      for (const h of state.legacy.hooks) await deleteWebhook(h.id);
      await removeLegacy(await readSchema());
    }, state.ownerOnly, out, 'btn-danger-text')));
}

// ---------------------------------------------------------------------------------------------
// Actions sur un destinataire

// Mise en pause : un webhook désactivé perd son historique d'envoi (Grist remet son état à zéro),
// il ne peut donc pas dire depuis quand il ne livre plus. On note la plus récente MajLe des tables
// de l'export (heure du serveur, sans écart d'horloge avec le navigateur) et leurs colonnes.
async function pause(exp, h) {
  const at = Math.max(0, ...(await Promise.all(exp.tables.map(tb => fetchRows(tb.table)))).flat().map(r => r[ORDER_COL] || 0));
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
  const ids = {};
  for (const { table } of exp.tables) {
    const rows = await fetchRows(table);
    ids[table] = (all ? rows : rows.filter(r => r[ORDER_COL] > entry.at)).map(r => r.id);
  }
  const n = Object.values(ids).reduce((sum, list) => sum + list.length, 0);
  const choice = (value, label, help, checked) => [el('label', { class: 'check' },
    el('input', { type: 'radio', name: 'gristsync-resume', value, checked }), el('strong', {}, label)), el('p', { class: 'muted small choice-help' }, help)];
  const body = el('div', { class: 'form', role: 'radiogroup' },
    choice('catchup', t('send.resume.catchup'), [t('send.resume.catchup.help', { n }), all ? t('send.resume.all') : ''].filter(Boolean).join(' '), true),
    choice('as-is', t('send.resume.asIs'), t('send.resume.asIs.help'), false));
  const picked = await new Promise((resolve) => {
    let answered = false;
    const done = (m, value) => { answered = true; resolve(value); m.close(); };
    openModal({
      title: t('send.resume.title', { name: h.fields.memo || exp.name }), body,
      onClose: () => { if (!answered) resolve(null); },
      buttons: [{ label: t('common.cancel'), onClick: m => done(m, null) },
        { label: t('send.action.resume'), kind: 'btn-primary', onClick: m => done(m, body.querySelector('input:checked').value) }],
    });
  });
  if (!picked) return;
  await setWebhookEnabled(h.id, true);
  if (picked === 'catchup') await resendTables(exp.id, exp.tables.map(tb => tb.table), out, ids);
  await updateNote((note) => { note.pauses = note.pauses.filter(p => p.hook !== h.id); });
}

// Révoquer une personne : son webhook disparaît, les autres destinataires continuent.
async function revoke(exp, h) {
  const ok = await confirmDialog({
    title: t('send.revoke.title', { name: h.fields.memo || exp.name }), body: t('send.revoke.body'), confirmLabel: t('send.action.revoke'), danger: true,
  });
  if (!ok) return;
  await deleteWebhook(h.id);
  await updateNote((note) => { note.pauses = note.pauses.filter(p => p.hook !== h.id); });
}

async function cancelInvitation(inv) {
  const ok = await confirmDialog({ title: t('send.cancel.title'), body: t('send.cancel.body'), confirmLabel: t('send.action.cancel'), danger: true });
  if (ok) await updateNote((note) => { note.invitations = note.invitations.filter(i => i.id !== inv.id); });
}

async function unblockQueue() {
  const ok = await confirmDialog({ title: t('send.unblock.title'), body: t('send.unblock.body'), confirmLabel: t('send.action.unblock'), danger: true });
  if (ok) await clearWebhookQueue();
}

// Supprimer un export : ses destinataires sont coupés, ses lignes Synchro effacées (la table
// disparaît avec le dernier export). Les colonnes id_sync et MajLe restent dans les tables.
async function deleteExport(exp) {
  const ok = await confirmDialog({
    title: t('send.delete.title', { name: exp.name }), body: t('send.delete.body', { n: exp.recipients.length }), confirmLabel: t('send.action.delete'), danger: true,
  });
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
  const [{ origin, docId }, { baseUrl }] = await Promise.all([docIdentity(), grist.docApi.getAccessToken({ readOnly: true })]);
  return buildInvitation({ id: exp.id, exportId: exp.id, name: exp.name, origin, base: baseUrl, from: { email: exp.email, docId }, tables: exp.tables });
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
  const ok = await confirmDialog({ title: t('send.public.stopTitle', { name: exp.name }), body: t('send.public.revokeBody'), confirmLabel: t('send.public.stop'), danger: true });
  if (!ok) return;
  await updateNote((note) => { note.exports = note.exports.map(e => (e.id === exp.id ? { ...e, public: false } : e)); });
  await saveExport(exp.id, exp.tables, { isPublic: false });
}

// ---------------------------------------------------------------------------------------------
// Renvoi : les lignes `ids` (toutes par défaut) des tables d'un export, par tranches, puis sa
// liste des clés. Rien n'est modifié dans les tables : le widget écrit les lignes voulues dans
// Synchro_Renvoi et Grist recalcule le lot. La tranche suivante attend que les destinataires aient
// tout reçu (un envoi reste sous la limite de taille de Grist) ; une tranche trop grosse pour un
// lot est coupée en deux. Rend le nombre de lignes renvoyées.
// Un renvoi à la fois, tous onglets confondus (« Tout renvoyer », rattrapage automatique).
const withResendLock = fn => (navigator.locks ? navigator.locks.request('gristsync-resend', fn) : fn());
const resendTables = (...args) => withResendLock(() => resendLocked(...args));

async function resendLocked(exportId, tables, out, idsByTable = {}) {
  const hookIds = await exportHookIds(exportId);
  if (!hookIds.length) return 0;
  const plans = [];
  for (const table of tables) plans.push({ table, ids: idsByTable[table] || (await fetchRows(table)).map(r => r.id) });
  const total = plans.reduce((n, p) => n + p.ids.length, 0);
  let done = 0;
  for (const { table, ids } of plans) {
    const queue = chunk(ids, RESEND_CHUNK);
    while (queue.length) {
      const part = queue.shift();
      await waitForQueue(hookIds);
      await writeResend(exportId, table, [KIND.lot], resendValue(randomHex(4), part));
      const row = (await syncRows()).find(r => r[EXPORT_COL] === exportId && r[TABLE_COL] === table && r[TYPE_COL] === KIND.lot);
      const lot = parseLot((row || {})[LOT_COL]);
      if (lot && lot.total > lot.lines.length && part.length > 1) {
        queue.unshift(part.slice(0, part.length / 2), part.slice(part.length / 2));
        continue;
      }
      done += part.length;
      if (out) out.replaceChildren(message('info', t('send.load.progress', { done, total })));
    }
    await waitForQueue(hookIds);
    await writeResend(exportId, table, [KIND.lot], '');
    await writeResend(exportId, table, [KIND.keys], resendValue(randomHex(4), []));
  }
  if (out) out.replaceChildren();
  return total;
}

// Rattrapage d'un envoi coupé (gros import, référence très utilisée renommée) : la marque du lot
// (MISSING_COL) dit depuis quand des lignes n'ont pas pu partir. Le widget l'efface, puis renvoie
// les lignes modifiées depuis ; un nouvel envoi coupé entre-temps pose une nouvelle marque. Tourne
// tant qu'un propriétaire a la page du widget ouverte : à l'affichage, puis toutes les 10 secondes.
// Export sans destinataire : marque effacée (un destinataire ajouté reçoit tout). Destinataires
// tous en pause : marque gardée pour après la reprise.
let catching = false;
export async function catchUp() {
  if (catching) return;
  catching = true;
  try {
    const done = await withResendLock(async () => {
      if (!(await readSchema()).has(SYNC_TABLE)) return 0;
      const late = (await syncRows()).filter(r => r[TYPE_COL] === KIND.lot && r[MISSING_COL] > 0);
      if (!late.length) return 0;
      const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
      for (const row of late) {
        const table = row[TABLE_COL];
        const mine = hooks.filter(h => h.fields.tableId === SYNC_TABLE && conditionExport(conditions.get(h.id)) === row[EXPORT_COL]);
        if (mine.length && !mine.some(h => h.fields.enabled)) continue;
        await apply([['UpdateRecord', SYNC_TABLE, row.id, { [MISSING_COL]: 0 }]]);
        if (!mine.length) continue;
        const ids = (await fetchRows(table)).filter(r => r[ORDER_COL] >= row[MISSING_COL]).map(r => r.id);
        await resendLocked(row[EXPORT_COL], [table], null, { [table]: ids });
      }
      return late.length;
    });
    if (done && container && container.isConnected && !document.querySelector('.scrim')) await renderSource();
  } catch (e) {
    if (e.message !== 'ownerOnly') console.warn(e);
  } finally {
    catching = false;
  }
}

export function startAutoCatchUp() {
  setInterval(catchUp, 10000);
}

async function exportHookIds(exportId) {
  const [hooks, conditions] = await Promise.all([listWebhooks(), webhookConditions()]);
  return hooks.filter(h => h.fields.tableId === SYNC_TABLE && h.fields.enabled && conditionExport(conditions.get(h.id)) === exportId).map(h => h.id);
}

async function waitForQueue(hookIds) {
  for (let i = 0; i < 60; i++) {
    const waiting = (await listWebhooks()).filter(h => hookIds.includes(h.id)).reduce((n, h) => n + ((h.usage && h.usage.numWaiting) || 0), 0);
    if (!waiting) return;
    await new Promise(resolve => setTimeout(resolve, 1500));
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
  showTables();

  // 1. Tables de l'export.
  async function showTables() {
    const tables = (await readSchema()).tableIds.filter(isUserTable);
    const next = { label: t('common.next'), kind: 'btn-primary', disabled: !chosen.length, onClick: () => run(null, null, showColumns) };
    const body = [el('p', {}, t(exp ? 'send.edit.tables' : 'send.tables.help')), checkList({
      items: tables.map(id => ({ value: id, label: id })), checked: chosen,
      onChange: (values) => { chosen = values; next.disabled = !chosen.length; wizard.show(0, body, [cancel, next]); },
    }), stepHelp(['s-tables']), exp ? null : roleGuide({ you: 'source', current: 0 })];
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
        checkList({ items: usable.map(c => ({ value: c.id, label: c.label === c.id ? c.id : `${c.label} (${c.id})` })), checked: selected.get(table),
          onChange: (values) => { selected.set(table, values); } }),
        blocked.length ? el('p', { class: 'muted small' }, t('send.columns.blocked', { cols: blocked.join(', ') })) : null);
    });
    if (!schema.has(SYNC_TABLE)) adds.push(t('send.check.sync'));
    const removed = exp ? exp.tables.map(tb => tb.table).filter(table => !chosen.includes(table)) : [];
    wizard.show(1, [el('p', {}, t('send.columns.help')),
      removed.length ? message('warn', t('send.edit.removed', { tables: removed.join(', ') })) : null,
      ...blocks,
      adds.length ? el('p', { class: 'muted small' }, t('send.check.missing', { items: adds.join(', ') })) : null, report, stepHelp(['s-columns'])], [
      { label: t('common.back'), onClick: showTables },
      { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, () => {
        if (chosen.some(table => !(selected.get(table) || []).length)) throw new Error('noColumn');
        showName();
      }) }]);
  }

  // 3. Nom, puis création (ou enregistrement) : c'est ici seulement que le widget écrit.
  function showName() {
    const nameInput = el('input', { type: 'text', class: 'input', value: exp ? exp.name : chosen.join(' + '), 'aria-label': t('send.name') });
    const report = el('div', { class: 'report' });
    wizard.show(2, [el('label', {}, t('send.name')), nameInput, el('p', { class: 'muted small' }, t('send.name.help')), report], [
      { label: t('common.back'), onClick: () => run(null, report, showColumns) },
      { label: exp ? t('common.save') : t('send.create'), kind: 'btn-primary', onClick: () => run(null, report, () => save(nameInput.value.trim() || chosen.join(' + '), report)) }]);
  }

  async function save(name, report) {
    const schema = await readSchema();
    const relays = receivedDests(schema).map(d => d.dest);
    const tables = [];
    for (const table of chosen) {
      await apply(prepareSourceActions(table, missingSyncColumns((await readSchema()).columns(table))));
      // Table reçue (relais) : ses lignes gardent la clé de leur document d'origine. Une ligne
      // ajoutée ici à la main reste sans clé, donc locale : avec une clé, la prochaine liste
      // de l'origine, qui ne la connaît pas, l'effacerait.
      if (!relays.includes(table)) await apply(fillKeyActions(table, await fetchRows(table), () => crypto.randomUUID()));
      const columns = exportableColumns((await readSchema()).columns(table)).filter(c => !c.blocked && selected.get(table).includes(c.id));
      tables.push({ table, columns });
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
    wizard.show(3, message('ok', n ? t('send.edit.saved', { n }) : t('send.edit.savedNone')), [{ label: t('common.close'), kind: 'btn-primary' }]);
  }
}

// ---------------------------------------------------------------------------------------------
// Assistant d'ajout d'un destinataire : Options, Invitation, Réponse, Envoi. Une invitation en
// attente le rouvre à l'étape Réponse (`pending`).

const STEP = { options: 0, invitation: 1, reply: 2, load: 3 };

function recipientWizard(exp, pending = null) {
  const wizard = openWizard({
    title: t('send.person.title', { name: exp.name }),
    steps: ['send.step.options', 'send.step.invitation', 'send.step.reply', 'send.step.load'].map(k => t(k)),
    onClose: () => renderSource(),
  });
  const cancel = { label: t('common.cancel') };
  if (pending) return showReply(pending);
  return showOptions();

  // 1. Mode (réponse ou lien public) et secret.
  function showOptions() {
    const secretBox = el('input', { type: 'checkbox', checked: true });
    const secretPart = el('div', { class: 'form' }, el('label', { class: 'check' }, secretBox, t('send.secret')), el('p', { class: 'muted small' }, t('send.secret.help')));
    const publicPart = el('div', { class: 'hidden' }, message('warn', t('send.public.warn')));
    const radio = (value, label, checked, disabled) => el('label', { class: 'check' },
      el('input', { type: 'radio', name: 'gristsync-mode', value, checked, disabled, onchange: () => {
        secretPart.classList.toggle('hidden', value === 'public'); publicPart.classList.toggle('hidden', value !== 'public');
      } }), label);
    const report = el('div', { class: 'report' });
    const mode = () => (document.querySelector('input[name="gristsync-mode"]:checked') || {}).value;
    wizard.show(STEP.options, [
      message('ok', t('send.person.tables', { tables: exp.tables.map(tb => tb.table).join(', ') })),
      el('label', {}, t('send.mode')),
      radio('reponse', t('send.mode.reply'), true, false),
      radio('public', exp.public ? t('send.mode.publicDone') : t('send.mode.public'), false, exp.public),
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
      wizard.show(STEP.invitation, [el('p', {}, t('send.public.help')), copyField(code), handoff('public', code),
        message('warn', t('send.public.turnOn')), roleGuide({ you: 'source', mode: 'public', current: 1, open: true }), stepHelp(['public'])],
      [{ label: t('common.close'), kind: 'btn-primary' }]);
      return;
    }
    const secret = withSecret ? randomHex(16) : '';
    const entry = { id: randomHex(8), export: exp.id, hash: secret ? await sha256(secret) : '', at: now() };
    await updateNote((note) => { note.invitations = [...note.invitations, entry]; });
    const [{ origin, docId }, rows] = await Promise.all([docIdentity(), syncRows()]);
    const email = (rows.find(r => r[EXPORT_COL] === exp.id) || {})[AUTHOR_COL] || '';
    const code = buildInvitation({ id: entry.id, exportId: exp.id, name: exp.name, origin, secret, from: { email, docId }, tables: exp.tables });
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
        [t('send.reply.doc'), r.docId === docId ? `${r.docId} (${t('send.reply.sameDoc')})` : r.docId], [t('send.reply.team'), r.team], [t('send.reply.at'), r.at]];
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
      name: hookName(exp.name, exp.id), memo: [r.email, r.docId, r.team].filter(Boolean).join(' · '), url: reply.url,
      tableId: SYNC_TABLE, condition: exportCondition(exp.id),
    });
    await updateNote((note) => { note.invitations = note.invitations.filter(i => i.id !== inv.id); });
    showLoad();
  }

  // 4. Envoi : le branchement n'envoie que les modifications à venir ; proposer l'existant.
  async function showLoad() {
    const count = (await Promise.all(exp.tables.map(tb => fetchRows(tb.table)))).reduce((n, rows) => n + rows.length, 0);
    const report = el('div', { class: 'report' });
    const send = async () => {
      await resendTables(exp.id, exp.tables.map(tb => tb.table), report);
      wizard.show(STEP.load + 1, message('ok', t('send.done')), [{ label: t('common.close'), kind: 'btn-primary' }]);
    };
    if (!count) {
      wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.empty'))], [{ label: t('common.close'), kind: 'btn-primary' }]);
      return;
    }
    wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.body', { n: count })), report],
      [{ label: t('common.later') }, { label: t('send.load.ok'), kind: 'btn-primary', onClick: () => run(null, report, send) }]);
  }
}
