// Onglet « Envoyer » (document SOURCE) : préparer une table, inviter un destinataire, approuver
// sa réponse en créant les webhooks, suivre et piloter les envois. Rien n'est stocké hors des
// webhooks eux-mêmes et de la note de la table liste (invitations en attente).
import {
  CHUNK, ORDER_COL, buildInvitation, checkSourceColumns, chunk, fillKeyActions, listTableId,
  maskKey, parseReply, prepareSourceActions,
} from './core.js';
import {
  apply, clearWebhookQueue, createWebhook, deleteWebhook, docIdentity, fetchRows, listWebhooks, readSchema,
  setWebhookEnabled,
} from './grist.js';
import { createListTable, readNote, sentTables, writeNote } from './tables.js';
import { checkList, confirmDialog, copyField, el, icon, message, openModal, run } from './ui.js';
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
function recipients(tables, hooks) {
  return hooks.filter(h => tables.includes(h.fields.tableId)).map(main => ({
    table: main.fields.tableId,
    main,
    list: hooks.find(h => h.fields.tableId === listTableId(main.fields.tableId) && h.fields.url === main.fields.url),
  }));
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
    el('button', { class: 'btn btn-primary', type: 'button', disabled: ownerOnly, onclick: () => newRecipient() }, icon('plus'), t('send.new')),
    el('button', { class: 'btn', type: 'button', disabled: ownerOnly || !pending.length, onclick: () => pasteReply() }, icon('paste'), t('send.reply')));
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
    el('div', { class: 'card-actions' }, actionButton(t('send.action.cancel'), 'trash', () => cancelInvitation(inv), ownerOnly, out, 'btn-danger-text')));
}

function recipientStatus({ main, list }) {
  if (!main.fields.enabled) return ['paused', 'off'];
  const failing = [main, list].filter(Boolean).find(h => ['retrying', 'error'].includes((h.usage || {}).status) || (h.usage || {}).lastHttpStatus >= 400);
  return failing ? ['error', 'err'] : ['active', 'ok'];
}

function recipientCard(r, ownerOnly, out) {
  const status = recipientStatus(r);
  const hooks = [r.main, r.list].filter(Boolean);
  const usage = hooks.map(h => h.usage || {});
  const waiting = usage.reduce((n, u) => n + (u.numWaiting || 0), 0);
  const failure = usage.find(u => u.lastErrorMessage);
  const action = (label, iconName, fn, kind) => actionButton(label, iconName, fn, ownerOnly, out, kind);
  const enable = on => Promise.all(hooks.map(h => setWebhookEnabled(h.id, on)));
  const actions = [
    action(t('send.action.load'), 'send', () => sendAll(r.table, out)),
    r.main.fields.enabled ? action(t('send.action.pause'), 'pause', () => enable(false)) : action(t('send.action.resume'), 'play', () => enable(true)),
    status[0] === 'error' ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
    action(t('send.action.revoke'), 'trash', () => revoke(r), 'btn-danger-text'),
  ].filter(Boolean);
  return card(r.main.fields.name.replace(/^Synchro /, ''), status,
    [r.table, r.main.fields.memo, maskKey(r.main.fields.url)].filter(Boolean).join(' → '),
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

async function revoke(r) {
  const ok = await confirmDialog({
    title: t('send.revoke.title', { name: r.main.fields.name.replace(/^Synchro /, '') }), body: t('send.revoke.body'),
    confirmLabel: t('send.action.revoke'), danger: true,
  });
  if (ok) for (const h of [r.main, r.list].filter(Boolean)) await deleteWebhook(h.id);
}

async function unblockQueue() {
  const ok = await confirmDialog({ title: t('send.unblock.title'), body: t('send.unblock.body'), confirmLabel: t('send.action.unblock'), danger: true });
  if (ok) await clearWebhookQueue();
}

// ---------------------------------------------------------------------------------------------
// Invitation

async function newRecipient() {
  const tables = (await readSchema()).tableIds.filter(id => !id.startsWith('Synchro_'));
  const nameInput = el('input', { type: 'text', class: 'input' });
  const secretBox = el('input', { type: 'checkbox', checked: true });
  const report = el('div', { class: 'report' });
  let chosen = [];
  let checks = [];

  const modal = openModal({
    title: t('send.new'),
    body: el('div', { class: 'form' },
      el('label', {}, t('send.step1')),
      checkList({ items: tables.map(id => ({ value: id, label: id })), onChange: (values) => { chosen = values; if (!nameInput.dataset.edited) nameInput.value = values.join(' + '); refresh(); } }),
      el('label', {}, t('send.name')), nameInput,
      el('label', { class: 'check' }, secretBox, t('send.secret')),
      report),
    buttons: [{ label: t('common.cancel') }],
  });
  nameInput.addEventListener('input', () => { nameInput.dataset.edited = '1'; });

  // Contrôle de chaque table choisie : ce qui bloque, ce qu'il faut ajouter.
  async function refresh() {
    const schema = await readSchema();
    checks = chosen.map(table => ({ table, ...checkSourceColumns(schema.columns(table)), listMissing: !schema.has(listTableId(table)) }));
    const blocking = checks.some(c => c.problems.some(p => p.blocking));
    const toAdd = checks.flatMap(c => [...c.missing.map(col => `${c.table}.${col}`), ...(c.listMissing ? [t('send.check.table', { table: listTableId(c.table) })] : [])]);
    report.replaceChildren(...[
      ...checks.flatMap(c => c.problems.map(p => message(p.blocking ? 'err' : 'warn', t(`send.problem.${p.code}`, { col: `${c.table}.${p.colId}` })))),
      !chosen.length || blocking ? null : toAdd.length
        ? message('warn', t('send.check.missing', { items: toAdd.join(', ') }))
        : message('ok', t('send.check.ok', { n: chosen.length }))].filter(Boolean));
    const buttons = [{ label: t('common.cancel') }];
    if (chosen.length && !blocking && toAdd.length) buttons.push({ label: t('send.prepare'), kind: 'btn-primary', onClick: () => run(null, report, prepare) });
    if (chosen.length && !blocking && !toAdd.length) buttons.push({ label: t('send.invite'), kind: 'btn-primary', onClick: () => run(null, report, invite) });
    modal.setButtons(buttons);
  }

  async function prepare() {
    for (const c of checks) {
      await apply(prepareSourceActions(c.table, c.missing));
      await apply(fillKeyActions(c.table, await fetchRows(c.table), () => crypto.randomUUID()));
      await createListTable(c.table);
    }
    await refresh();
  }

  async function invite() {
    const secret = secretBox.checked ? randomHex(16) : '';
    const entry = { id: randomHex(8), name: nameInput.value.trim() || chosen.join(' + '), hash: secret ? await sha256(secret) : '', at: now(), tables: chosen };
    const schema = await readSchema();
    for (const table of chosen) {
      const id = listTableId(table);
      await writeNote(schema, id, [...(readNote(schema, id) || []), entry]);
    }
    const { origin } = await docIdentity();
    const code = buildInvitation({ id: entry.id, name: entry.name, origin, secret, tables: checks.map(c => ({ table: c.table, columns: c.sent })) });
    modal.close();
    openModal({
      title: t('send.invite.title'),
      body: el('div', { class: 'form' }, el('p', {}, t('send.invite.help')), copyField(code)),
      onClose: () => renderSource(),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Réponse : vérifier, montrer la fiche, approuver

async function pasteReply() {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false' });
  const report = el('div', { class: 'report' });
  const modal = openModal({
    title: t('send.reply.title'),
    body: el('div', { class: 'form' }, el('p', {}, t('send.reply.help')), area, report),
    buttons: [{ label: t('common.cancel') }, { label: t('send.reply.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }],
  });

  // La réponse doit désigner une invitation en attente, porter le même secret (comparé par
  // empreinte) et ne viser que des tables de cette invitation.
  async function check() {
    const { origin } = await docIdentity();
    const reply = parseReply(area.value, origin);
    const inv = pendingInvitations(await readSchema()).find(i => i.id === reply.id);
    if (!inv || inv.hash !== (reply.secret ? await sha256(reply.secret) : '')) throw new Error('unknownInvitation');
    if (!reply.links.every(l => inv.tables.includes(l.table))) throw new Error('codeInvalid');
    const r = reply.recipient;
    const fiche = [[t('send.reply.tables'), reply.links.map(l => l.table).join(', ')], [t('send.reply.email'), r.email],
      [t('send.reply.doc'), r.docId], [t('send.reply.team'), r.team], [t('send.reply.at'), r.at]];
    report.replaceChildren(...[el('dl', { class: 'fiche' }, fiche.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')])),
      reply.secret ? null : message('warn', t('send.reply.nosecret')),
      el('p', { class: 'muted small' }, maskKey(reply.links[0].url))].filter(Boolean));
    modal.setButtons([{ label: t('common.cancel') }, { label: t('send.reply.approve'), kind: 'btn-primary', onClick: () => run(null, report, () => approve(inv, reply)) }]);
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
    modal.close();
    const count = (await Promise.all(reply.links.map(l => fetchRows(l.table)))).reduce((n, rows) => n + rows.length, 0);
    if (count && await confirmDialog({ title: t('send.load.title'), body: t('send.load.body', { n: count }), confirmLabel: t('send.load.ok') })) {
      for (const link of reply.links) await sendAll(link.table, null);
    }
    await renderSource();
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
