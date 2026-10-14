// Onglet « Envoyer » (document SOURCE) : inviter un destinataire, approuver sa réponse en créant
// le webhook, suivre et piloter les envois.
import {
  CHUNK, ORDER_COL, RECIPIENTS_TABLE, buildInvitation, checkSourceColumns, chunk, fillKeyActions,
  maskKey, parseReply, prepareSourceActions,
} from './core.js';
import {
  apply, clearWebhookQueue, createWebhook, deleteWebhook, docIdentity, fetchRows, listColumns, listTables,
  listWebhooks, setWebhookEnabled,
} from './grist.js';
import { ensureTable, hasTable } from './tables.js';
import { confirmDialog, copyField, el, icon, message, openModal, run, searchSelect } from './ui.js';
import { t } from './i18n.js';

const now = () => Date.now() / 1000;
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

let container;

// ---------------------------------------------------------------------------------------------
// Tableau de bord

export async function renderSource(root = container) {
  container = root;
  const rows = (await hasTable(RECIPIENTS_TABLE)) ? (await fetchRows(RECIPIENTS_TABLE)).filter(r => r.Statut !== 'revoque') : [];
  let hooks = [];
  let ownerOnly = false;
  try { hooks = await listWebhooks(); } catch (e) { ownerOnly = e.message === 'ownerOnly'; }

  const out = el('div', { class: 'out' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: ownerOnly, onclick: () => newRecipient() }, icon('plus'), t('send.new')),
    el('button', { class: 'btn', type: 'button', disabled: ownerOnly || !rows.some(r => r.Statut === 'invite'), onclick: () => pasteReply(rows) }, icon('paste'), t('send.reply')));
  const cards = rows.map(row => recipientCard(row, hooks.find(h => h.id === row.Webhook), ownerOnly, out));
  container.replaceChildren(...[toolbar,
    ownerOnly ? message('warn', t('common.ownerOnly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'muted' }, t('send.empty'))].filter(Boolean));
}

function recipientStatus(row, hook) {
  if (row.Statut === 'invite') return ['invited', 'pending'];
  if (!hook) return ['revoked', 'off'];
  if (!hook.fields.enabled) return ['paused', 'off'];
  const usage = hook.usage || {};
  if (usage.status === 'retrying' || usage.status === 'error' || usage.lastHttpStatus >= 400) return ['error', 'err'];
  return ['active', 'ok'];
}

function recipientCard(row, hook, ownerOnly, out) {
  const [status, tone] = recipientStatus(row, hook);
  const usage = (hook && hook.usage) || {};
  const action = (label, iconName, fn, kind = '') => el('button', {
    class: `btn btn-small ${kind}`, type: 'button', disabled: ownerOnly,
    onclick: e => run(e.currentTarget, out, async () => { await fn(); await renderSource(); }),
  }, icon(iconName), label);

  const actions = [];
  if (status !== 'invited' && hook) {
    actions.push(action(t('send.action.load'), 'send', () => sendAll(row.Table, out)));
    actions.push(hook.fields.enabled
      ? action(t('send.action.pause'), 'pause', () => setWebhookEnabled(hook.id, false))
      : action(t('send.action.resume'), 'play', () => setWebhookEnabled(hook.id, true)));
    if (status === 'error') actions.push(action(t('send.action.unblock'), 'unblock', unblockQueue));
  }
  actions.push(action(t('send.action.revoke'), 'trash', () => revoke(row, hook), 'btn-danger-text'));

  const detail = [];
  if (row.Destinataire) detail.push(row.Destinataire);
  if (hook) detail.push(maskKey(hook.fields.url));
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' },
      el('strong', {}, row.Nom || row.Table),
      el('span', { class: `pill pill-${tone}` }, t(`send.status.${status}`))),
    el('p', { class: 'muted small' }, `${row.Table}${detail.length ? ' → ' + detail.join(' · ') : ''}`),
    usage.numWaiting ? el('p', { class: 'small' }, t('send.waiting', { n: usage.numWaiting })) : null,
    status === 'error' && usage.lastErrorMessage ? el('p', { class: 'small text-danger' }, `${usage.lastHttpStatus || ''} ${usage.lastErrorMessage}`) : null,
    el('div', { class: 'card-actions' }, actions));
}

async function revoke(row, hook) {
  const ok = await confirmDialog({
    title: t('send.revoke.title', { name: row.Nom || row.Table }), body: t('send.revoke.body'),
    confirmLabel: t('send.action.revoke'), danger: true,
  });
  if (!ok) return;
  if (hook) await deleteWebhook(hook.id);
  await apply([['UpdateRecord', RECIPIENTS_TABLE, row.id, { Statut: 'revoque' }]]);
}

async function unblockQueue() {
  const ok = await confirmDialog({ title: t('send.unblock.title'), body: t('send.unblock.body'), confirmLabel: t('send.action.unblock'), danger: true });
  if (ok) await clearWebhookQueue();
}

// ---------------------------------------------------------------------------------------------
// Invitation

async function newRecipient() {
  const tables = (await listTables()).filter(tb => !tb.tableId.startsWith('Synchro_'));
  const nameInput = el('input', { type: 'text', class: 'input' });
  const report = el('div', { class: 'report' });
  let tableId = '';
  let check = null;

  const modal = openModal({
    title: t('send.new'),
    body: el('div', { class: 'form' },
      el('label', {}, t('send.step1')),
      searchSelect({ items: tables.map(tb => ({ value: tb.tableId, label: tb.tableId })), onChange: (value) => { tableId = value; nameInput.value = value; refresh(); } }),
      el('label', {}, t('send.name')), nameInput,
      report),
    buttons: [{ label: t('common.cancel') }],
  });

  async function refresh() {
    check = checkSourceColumns(await listColumns(tableId));
    const blocking = check.problems.filter(p => p.blocking);
    report.replaceChildren(
      ...check.problems.map(p => message(p.blocking ? 'err' : 'warn', t(`send.problem.${p.code}`, { col: p.colId }))),
      blocking.length ? null : check.missing.length
        ? message('warn', t('send.check.missing', { cols: check.missing.join(', ') }))
        : message('ok', t('send.check.ok', { n: check.sent.length })));
    const buttons = [{ label: t('common.cancel') }];
    if (!blocking.length && check.missing.length) buttons.push({ label: t('send.prepare'), kind: 'btn-primary', onClick: () => run(null, report, prepare) });
    if (!blocking.length && !check.missing.length) buttons.push({ label: t('send.invite'), kind: 'btn-primary', onClick: () => run(null, report, invite) });
    modal.setButtons(buttons);
  }

  async function prepare() {
    await apply(prepareSourceActions(tableId, check.missing));
    await apply(fillKeyActions(tableId, await fetchRows(tableId), () => crypto.randomUUID()));
    await refresh();
  }

  async function invite() {
    if (!(await ensureTable(RECIPIENTS_TABLE))) return;
    const secret = randomHex(16);
    const name = nameInput.value.trim() || tableId;
    const { origin } = await docIdentity();
    await apply([['AddRecord', RECIPIENTS_TABLE, null, {
      Nom: name, Table: tableId, Statut: 'invite', Empreinte_secret: await sha256(secret), Invite_le: now(),
    }]]);
    modal.close();
    openModal({
      title: t('send.invite.title'),
      body: el('div', { class: 'form' }, el('p', {}, t('send.invite.help')),
        copyField(buildInvitation({ name, table: tableId, columns: check.sent, secret, origin }))),
      onClose: () => renderSource(),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Réponse : vérifier, montrer la fiche, approuver

async function pasteReply(rows) {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false' });
  const report = el('div', { class: 'report' });
  const modal = openModal({
    title: t('send.reply.title'),
    body: el('div', { class: 'form' }, el('p', {}, t('send.reply.help')), area, report),
    buttons: [{ label: t('common.cancel') }, { label: t('send.reply.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }],
  });

  async function check() {
    const { origin } = await docIdentity();
    const reply = parseReply(area.value, origin);
    const hash = await sha256(reply.secret);
    const row = rows.find(r => r.Statut === 'invite' && r.Empreinte_secret === hash);
    if (!row) throw new Error('unknownInvitation');
    const r = reply.recipient;
    const fiche = [[t('send.reply.email'), r.email], [t('send.reply.doc'), r.docId], [t('send.reply.team'), r.team], [t('send.reply.at'), r.at]];
    report.replaceChildren(el('dl', { class: 'fiche' }, fiche.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')])),
      el('p', { class: 'muted small' }, maskKey(reply.url)));
    modal.setButtons([{ label: t('common.cancel') }, { label: t('send.reply.approve'), kind: 'btn-primary', onClick: () => run(null, report, () => approve(row, reply)) }]);
  }

  async function approve(row, reply) {
    const r = reply.recipient;
    const who = [r.email, r.docId, r.team].filter(Boolean).join(' · ');
    const id = await createWebhook({ name: `Synchro ${row.Nom}`, memo: who, url: reply.url, tableId: row.Table });
    await apply([['UpdateRecord', RECIPIENTS_TABLE, row.id, { Statut: 'actif', Webhook: id, Destinataire: who, Approuve_le: now() }]]);
    modal.close();
    const count = (await fetchRows(row.Table)).length;
    if (count && await confirmDialog({ title: t('send.load.title'), body: t('send.load.body', { n: count, table: row.Table }), confirmLabel: t('send.load.ok') })) {
      await sendAll(row.Table, null);
    }
    await renderSource();
  }
}

// Chargement initial ou rattrapage : « toucher » MajLe par tranches, en laissant la file des
// webhooks (plafonnée à 1000 événements) se vider entre deux tranches.
async function sendAll(tableId, out) {
  const ids = (await fetchRows(tableId)).map(r => r.id);
  let done = 0;
  for (const part of chunk(ids)) {
    await apply([['BulkUpdateRecord', tableId, part, { [ORDER_COL]: part.map(() => now()) }]]);
    done += part.length;
    if (out) out.replaceChildren(message('info', t('send.load.progress', { done, total: ids.length })));
    if (done < ids.length) await waitForQueue();
  }
}

async function waitForQueue() {
  for (let i = 0; i < 60; i++) {
    const waiting = (await listWebhooks()).reduce((n, h) => n + ((h.usage && h.usage.numWaiting) || 0), 0);
    if (waiting < 1000 - CHUNK) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
