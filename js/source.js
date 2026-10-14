// Onglet « Envoyer » (document SOURCE) : préparer une table, inviter un destinataire, approuver
// sa réponse en créant les webhooks, suivre et piloter les envois. Rien n'est stocké hors des
// webhooks eux-mêmes et de la note de la table liste (invitations en attente).
import {
  AUTHOR_COL, CHUNK, ORDER_COL, buildInvitation, checkSourceColumns, chunk, fillKeyActions, listTableId,
  maskKey, parseReply, parseWebhookUrl, prepareSourceActions,
} from './core.js';
import {
  apply, clearWebhookQueue, createWebhook, deleteWebhook, docIdentity, fetchRows, listWebhooks, readSchema,
  setWebhookEnabled,
} from './grist.js';
import { createListTable, readNote, sentTables, writeNote } from './tables.js';
import { checkList, confirmDialog, copyField, el, icon, message, openWizard, run } from './ui.js';
import { t } from './i18n.js';

const now = () => Date.now() / 1000;
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

let container;

// Destinataires branchés : un webhook sur la table (ajouts, modifications) et un sur sa table
// liste (suppressions), vers la même adresse.
// Les webhooks d'un même branchement (même nom, même destinataire) forment une carte.
function recipients(tables, hooks) {
  const groups = new Map();
  for (const main of hooks.filter(h => tables.includes(h.fields.tableId))) {
    const key = `${main.fields.name}\n${main.fields.memo}`;
    if (!groups.has(key)) groups.set(key, { name: main.fields.name.replace(/^Synchro /, ''), memo: main.fields.memo, feeds: [] });
    const list = hooks.find(h => h.fields.tableId === listTableId(main.fields.tableId) && h.fields.url === main.fields.url);
    groups.get(key).feeds.push({ table: main.fields.tableId, main, list, journal: (parseWebhookUrl(main.fields.url) || {}).table });
  }
  return [...groups.values()];
}

// Invitations en attente, notées dans la table liste de chacune de leurs tables.
function pendingInvitations(schema) {
  const byId = new Map();
  for (const table of sentTables(schema)) for (const inv of readNote(schema, listTableId(table)) || []) byId.set(inv.id, inv);
  return [...byId.values()];
}

// ---------------------------------------------------------------------------------------------
// Tableau de bord

export async function renderSource(root = container) {
  container = root;
  let hooks = [];
  let ownerOnly = false;
  try { hooks = await listWebhooks(); } catch (e) { ownerOnly = e.message === 'ownerOnly'; }
  const schema = await readSchema();
  const tables = sentTables(schema);
  const pending = pendingInvitations(schema);

  const out = el('div', { class: 'out' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: ownerOnly, onclick: () => invitationWizard() }, icon('plus'), t('send.new')));
  const cards = [
    ...pending.map(inv => pendingCard(inv, ownerOnly, out)),
    ...recipients(tables, hooks).map(r => recipientCard(r, ownerOnly, out)),
  ];
  container.replaceChildren(...[toolbar,
    ownerOnly ? message('warn', t('common.ownerOnly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards) : el('p', { class: 'muted' }, t('send.empty'))].filter(Boolean));
}

function actionButton(label, iconName, fn, ownerOnly, out, kind = '') {
  return el('button', {
    class: `btn btn-small ${kind}`, type: 'button', disabled: ownerOnly,
    onclick: e => run(e.currentTarget, out, async () => { await fn(); await renderSource(); }),
  }, icon(iconName), label);
}

function card(title, [status, tone], detail, ...rest) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, title), el('span', { class: `pill pill-${tone}` }, t(`send.status.${status}`))),
    el('p', { class: 'muted small' }, detail), ...rest);
}

function pendingCard(inv, ownerOnly, out) {
  return card(inv.name, ['invited', 'pending'], `${inv.tables.join(', ')} · ${inv.hash ? t('send.secret.on') : t('send.secret.off')}`,
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: ownerOnly, onclick: () => invitationWizard(inv) }, icon('paste'), t('send.reply')),
      actionButton(t('send.action.cancel'), 'trash', () => cancelInvitation(inv), ownerOnly, out, 'btn-danger-text')));
}

function recipientStatus(hooks) {
  if (!hooks.some(h => h.fields.enabled)) return ['paused', 'off'];
  const failing = hooks.some(h => ['retrying', 'error'].includes((h.usage || {}).status) || (h.usage || {}).lastHttpStatus >= 400);
  return failing ? ['error', 'err'] : ['active', 'ok'];
}

function recipientCard(r, ownerOnly, out) {
  const hooks = r.feeds.flatMap(f => [f.main, f.list]).filter(Boolean);
  const status = recipientStatus(hooks);
  const usage = hooks.map(h => h.usage || {});
  const waiting = usage.reduce((n, u) => n + (u.numWaiting || 0), 0);
  const failure = usage.find(u => u.lastErrorMessage);
  const action = (label, iconName, fn, kind) => actionButton(label, iconName, fn, ownerOnly, out, kind);
  const enable = on => Promise.all(hooks.map(h => setWebhookEnabled(h.id, on)));
  const actions = [
    action(t('send.action.load'), 'send', async () => { for (const f of r.feeds) await sendAll(f.table, out); }),
    status[0] === 'paused' ? action(t('send.action.resume'), 'play', () => enable(true)) : action(t('send.action.pause'), 'pause', () => enable(false)),
    status[0] === 'error' ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
    action(t('send.action.revoke'), 'trash', () => revoke(r, hooks), 'btn-danger-text'),
  ].filter(Boolean);
  return card(r.name, status, t('send.to', { who: r.memo || '—' }),
    r.feeds.map(f => el('p', { class: 'muted small' }, `${f.table} → ${f.journal || '?'}`)),
    waiting ? el('p', { class: 'small' }, t('send.waiting', { n: waiting })) : null,
    status[0] === 'error' && failure ? el('p', { class: 'small text-danger' }, `${failure.lastHttpStatus || ''} ${failure.lastErrorMessage}`) : null,
    el('div', { class: 'card-actions' }, actions));
}

async function cancelInvitation(inv) {
  const schema = await readSchema();
  for (const table of inv.tables) {
    const note = readNote(schema, listTableId(table));
    if (note) await writeNote(schema, listTableId(table), note.filter(i => i.id !== inv.id));
  }
}

async function revoke(r, hooks) {
  const ok = await confirmDialog({
    title: t('send.revoke.title', { name: r.name }), body: t('send.revoke.body'),
    confirmLabel: t('send.action.revoke'), danger: true,
  });
  if (ok) for (const h of hooks) await deleteWebhook(h.id);
}

async function unblockQueue() {
  const ok = await confirmDialog({ title: t('send.unblock.title'), body: t('send.unblock.body'), confirmLabel: t('send.action.unblock'), danger: true });
  if (ok) await clearWebhookQueue();
}

// ---------------------------------------------------------------------------------------------
// Assistant d'envoi : Tables, Préparation, Options, Invitation, Réponse, Envoi. Une invitation
// en attente rouvre l'assistant à l'étape Réponse (`pending`).

const STEP = { tables: 0, prepare: 1, options: 2, invitation: 3, reply: 4, load: 5 };

async function invitationWizard(pending = null) {
  const wizard = openWizard({
    title: pending ? pending.name : t('send.new'),
    steps: ['send.step.tables', 'send.step.prepare', 'send.step.options', 'send.step.invitation', 'send.step.reply', 'send.step.load'].map(k => t(k)),
    onClose: () => renderSource(),
  });
  const cancel = { label: t('common.cancel') };
  let chosen = [];
  let checks = [];

  if (pending) return showReply(pending);
  return showTables();

  // 1. Tables : cocher, contrôler. Ce qui bloque l'envoi est expliqué table par table.
  async function showTables() {
    const tables = (await readSchema()).tableIds.filter(id => !id.startsWith('Synchro_'));
    const report = el('div', { class: 'report' });
    const next = { label: t('common.next'), kind: 'btn-primary', disabled: true, onClick: () => (toAdd().length ? showPrepare() : showOptions()) };
    const toAdd = () => checks.flatMap(c => [...c.missing.map(col => `${c.table}.${col}`), ...(c.listMissing ? [t('send.check.table', { table: listTableId(c.table) })] : [])]);
    async function refresh() {
      const schema = await readSchema();
      checks = chosen.map(table => ({ table, ...checkSourceColumns(schema.columns(table)), listMissing: !schema.has(listTableId(table)) }));
      const problems = checks.flatMap(c => c.problems.map(p => message(p.blocking ? 'err' : 'warn', t(`send.problem.${p.code}`, { col: `${c.table}.${p.colId}` }))));
      report.replaceChildren(...problems);
      next.disabled = !chosen.length || checks.some(c => c.problems.some(p => p.blocking));
      wizard.show(STEP.tables, body, [cancel, next]);
    }
    const body = [el('p', {}, t('send.tables.help')),
      checkList({ items: tables.map(id => ({ value: id, label: id })), onChange: (values) => { chosen = values; refresh(); } }), report];
    wizard.show(STEP.tables, body, [cancel, next]);

    // 2. Préparation : ce que le widget ajoute, avant de l'ajouter.
    function showPrepare() {
      const report2 = el('div', { class: 'report' });
      wizard.show(STEP.prepare, [message('warn', t('send.check.missing', { items: toAdd().join(', ') })), el('p', { class: 'small' }, t('send.prepare.help')), report2], [
        { label: t('common.back'), onClick: () => wizard.show(STEP.tables, body, [cancel, next]) },
        { label: t('send.prepare'), kind: 'btn-primary', onClick: () => run(null, report2, prepare) }]);
    }
  }

  async function prepare() {
    for (const c of checks) {
      await apply(prepareSourceActions(c.table, c.missing));
      await apply(fillKeyActions(c.table, await fetchRows(c.table), () => crypto.randomUUID()));
      await createListTable(c.table);
    }
    const schema = await readSchema();
    checks = chosen.map(table => ({ table, ...checkSourceColumns(schema.columns(table)), listMissing: false }));
    showOptions();
  }

  // 3. Options : nom de l'envoi, secret.
  function showOptions() {
    const nameInput = el('input', { type: 'text', class: 'input', value: chosen.join(' + ') });
    const secretBox = el('input', { type: 'checkbox', checked: true });
    const report = el('div', { class: 'report' });
    wizard.show(STEP.options, [
      message('ok', t('send.check.ok', { n: chosen.length })),
      el('label', {}, t('send.name')), nameInput,
      el('label', { class: 'check' }, secretBox, t('send.secret')),
      el('p', { class: 'muted small' }, t('send.secret.help')), report,
    ], [cancel, { label: t('send.invite'), kind: 'btn-primary', onClick: () => run(null, report, () => invite(nameInput.value.trim(), secretBox.checked)) }]);
  }

  // 4. Invitation : le code à transmettre ; l'invitation attend sa réponse dans une carte.
  async function invite(name, withSecret) {
    const secret = withSecret ? randomHex(16) : '';
    const entry = { id: randomHex(8), name: name || chosen.join(' + '), hash: secret ? await sha256(secret) : '', at: now(), tables: chosen };
    const schema = await readSchema();
    for (const table of chosen) {
      const id = listTableId(table);
      await writeNote(schema, id, [...(readNote(schema, id) || []), entry]);
    }
    const [{ origin, docId }, list] = await Promise.all([docIdentity(), fetchRows(listTableId(chosen[0]))]);
    const code = buildInvitation({
      id: entry.id, name: entry.name, origin, secret, from: { email: (list[0] || {})[AUTHOR_COL] || '', docId },
      tables: checks.map(c => ({ table: c.table, columns: c.sent })),
    });
    wizard.show(STEP.invitation, [el('p', {}, t('send.invite.help')), copyField(code)],
      [{ label: t('common.later') }, { label: t('send.reply.ready'), kind: 'btn-primary', onClick: () => showReply(entry) }]);
  }

  // 5. Réponse : vérifier, montrer la fiche, approuver. La réponse doit désigner cette invitation,
  // porter le même secret (comparé par empreinte) et ne viser que ses tables.
  function showReply(inv) {
    const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('send.reply.title') });
    const report = el('div', { class: 'report' });
    const check = async () => {
      const { origin } = await docIdentity();
      const reply = parseReply(area.value, origin);
      if (reply.id !== inv.id || inv.hash !== (reply.secret ? await sha256(reply.secret) : '')) throw new Error('unknownInvitation');
      if (!reply.links.every(l => inv.tables.includes(l.table))) throw new Error('codeInvalid');
      const r = reply.recipient;
      const fiche = [[t('send.reply.tables'), reply.links.map(l => l.table).join(', ')], [t('send.reply.email'), r.email],
        [t('send.reply.doc'), r.docId], [t('send.reply.team'), r.team], [t('send.reply.at'), r.at]];
      report.replaceChildren(...[el('dl', { class: 'fiche' }, fiche.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')])),
        reply.secret ? null : message('warn', t('send.reply.nosecret')),
        el('p', { class: 'muted small' }, maskKey(reply.links[0].url))].filter(Boolean));
      wizard.show(STEP.reply, body, [{ label: t('common.later') },
        { label: t('send.reply.approve'), kind: 'btn-primary', onClick: () => run(null, report, () => approve(inv, reply)) }]);
    };
    const body = [el('p', {}, t('send.reply.help')), area, report];
    wizard.show(STEP.reply, body, [{ label: t('common.later') }, { label: t('send.reply.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }]);
  }

  // Deux webhooks par table : la table (ajouts, modifications) et sa table liste (suppressions).
  async function approve(inv, reply) {
    const r = reply.recipient;
    const memo = [r.email, r.docId, r.team].filter(Boolean).join(' · ');
    const name = `Synchro ${inv.name}`;
    for (const link of reply.links) {
      await createWebhook({ name, memo, url: link.url, tableId: link.table });
      await createWebhook({ name, memo, url: link.url, tableId: listTableId(link.table) });
    }
    await cancelInvitation(inv);
    showLoad(reply.links.map(l => l.table));
  }

  // 6. Envoi : le branchement n'envoie que les modifications à venir ; proposer l'existant.
  async function showLoad(tables) {
    const count = (await Promise.all(tables.map(table => fetchRows(table)))).reduce((n, rows) => n + rows.length, 0);
    const report = el('div', { class: 'report' });
    const send = async () => {
      for (const table of tables) await sendAll(table, report);
      wizard.show(STEP.load + 1, message('ok', t('send.done')), [{ label: t('common.close'), kind: 'btn-primary' }]);
    };
    wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.body', { n: count })), report],
      [{ label: t('common.later') }, { label: t('send.load.ok'), kind: 'btn-primary', disabled: !count, onClick: () => run(null, report, send) }]);
  }
}

// Chargement initial ou rattrapage : « toucher » MajLe par tranches, en laissant la file des
// webhooks (plafonnée à 1000 événements) se vider entre deux tranches, puis renvoyer la liste des
// clés en recréant la ligne de la table liste (rattrape les suppressions faites pendant une pause).
async function sendAll(tableId, out) {
  const ids = (await fetchRows(tableId)).map(r => r.id);
  let done = 0;
  for (const part of chunk(ids)) {
    await apply([['BulkUpdateRecord', tableId, part, { [ORDER_COL]: part.map(() => now()) }]]);
    done += part.length;
    if (out) out.replaceChildren(message('info', t('send.load.progress', { done, total: ids.length })));
    if (done < ids.length) await waitForQueue();
  }
  const list = listTableId(tableId);
  await apply([['BulkRemoveRecord', list, (await fetchRows(list)).map(r => r.id)], ['AddRecord', list, null, {}]]);
}

async function waitForQueue() {
  for (let i = 0; i < 60; i++) {
    const waiting = (await listWebhooks()).reduce((n, h) => n + ((h.usage && h.usage.numWaiting) || 0), 0);
    if (waiting < 1000 - CHUNK) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
