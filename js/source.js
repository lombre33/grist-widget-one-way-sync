// Onglet « Envoyer » (document SOURCE) : préparer une table, inviter un destinataire, approuver
// sa réponse en créant les webhooks, suivre et piloter les envois. Rien n'est stocké hors des
// webhooks eux-mêmes et de la note de la table liste (invitations en attente).
import {
  AUTHOR_COL, CHUNK, ORDER_COL, SCHEMA_COL, buildInvitation, chunk, exportTableId, exportableColumns, fillKeyActions, listTableId,
  maskKey, masterTableId, missingSyncColumns, parseReply, parseWebhookUrl, prepareSourceActions,
} from './core.js';
import {
  apply, clearWebhookQueue, createWebhook, deleteWebhook, docIdentity, fetchRows, listWebhooks, readSchema,
  setWebhookEnabled,
} from './grist.js';
import { createListTable, readExport, readNote, removeSyncTables, sentTables, setExport, writeNote } from './tables.js';
import { checkList, confirmDialog, copyField, el, icon, message, openModal, openWizard, run } from './ui.js';
import { t } from './i18n.js';

const now = () => Date.now() / 1000;
const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

let container;

// Destinataires branchés : un webhook sur la vue d'export de la table (ajouts, modifications) et
// un sur sa table liste (suppressions), vers la même adresse. Les webhooks d'un même branchement
// (même nom, même destinataire) forment une carte.
function recipients(tables, hooks) {
  const groups = new Map();
  const isMain = h => tables.includes(masterTableId(h.fields.tableId)) && h.fields.tableId !== listTableId(masterTableId(h.fields.tableId));
  for (const main of hooks.filter(isMain)) {
    const key = `${main.fields.name}\n${main.fields.memo}`;
    if (!groups.has(key)) groups.set(key, { name: main.fields.name.replace(/^Synchro /, ''), memo: main.fields.memo, feeds: [] });
    const table = masterTableId(main.fields.tableId);
    const list = hooks.find(h => h.fields.tableId === listTableId(table) && h.fields.url === main.fields.url);
    groups.get(key).feeds.push({ table, main, list, journal: (parseWebhookUrl(main.fields.url) || {}).table });
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
    action(t('send.action.columns'), 'columns', () => editColumns(r, out)),
    status[0] === 'paused' ? action(t('send.action.resume'), 'play', () => enable(true)) : action(t('send.action.pause'), 'pause', () => enable(false)),
    status[0] === 'error' ? action(t('send.action.unblock'), 'unblock', unblockQueue) : null,
    action(t('send.action.revoke'), 'trash', () => revoke(r, hooks), 'btn-danger-text'),
  ].filter(Boolean);
  return card(r.name, status, t('send.to', { who: r.memo || '—' }),
    r.feeds.map(f => el('p', { class: 'muted small' }, `${f.table} → ${f.journal || '?'}`)),
    lastSuccess(usage),
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

// Dernier envoi accepté par le destinataire (Grist le date en millisecondes).
function lastSuccess(usage) {
  const at = Math.max(0, ...usage.map(u => u.lastSuccessTime || 0));
  return at ? el('p', { class: 'muted small' }, t('send.lastOk', { at: new Date(at).toLocaleString() })) : null;
}

// Révoquer supprime les webhooks du destinataire. Si plus rien n'envoie une table (ni webhook ni
// invitation), le widget propose aussi d'effacer ses tables techniques (liste, vue d'export) ;
// les colonnes id_sync, MajLe et Supprime de la table restent (elles portent des données).
async function revoke(r, hooks) {
  const others = (await listWebhooks()).filter(h => !hooks.some(mine => mine.id === h.id));
  const pending = pendingInvitations(await readSchema()).flatMap(inv => inv.tables);
  const orphans = r.feeds.map(f => f.table)
    .filter(table => !others.some(h => masterTableId(h.fields.tableId) === table) && !pending.includes(table));
  const cleanup = el('input', { type: 'checkbox', checked: true });
  const ok = await new Promise((resolve) => {
    let answered = false;
    const modal = openModal({
      title: t('send.revoke.title', { name: r.name }), width: 400,
      body: [el('p', {}, t('send.revoke.body')),
        orphans.length ? el('label', { class: 'check' }, cleanup, t('send.revoke.cleanup', { tables: orphans.map(listTableId).join(', ') })) : null],
      onClose: () => { if (!answered) resolve(false); },
      buttons: [
        { label: t('common.cancel'), onClick: m => { answered = true; resolve(false); m.close(); } },
        { label: t('send.action.revoke'), kind: 'btn-danger', onClick: m => { answered = true; resolve(true); m.close(); } },
      ],
    });
    modal.footer.querySelector('button').focus();
  });
  if (!ok) return;
  for (const h of hooks) await deleteWebhook(h.id);
  if (orphans.length && cleanup.checked) await removeSyncTables(orphans);
}

// Colonnes envoyées, par table : changer la vue d'export vaut pour tous les destinataires de la
// table. Grist renvoie alors toutes les lignes ; au-delà de la file des webhooks, on les renvoie
// par tranches.
async function editColumns(r, out) {
  const schema = await readSchema();
  const fields = [];
  for (const { table } of r.feeds) {
    const usable = exportableColumns(schema.columns(table)).filter(c => !c.blocked);
    const current = (await readExport(table)).map(c => c.id);
    const field = { table, usable, values: usable.map(c => c.id).filter(id => current.includes(id)) };
    field.list = checkList({ items: usable.map(c => ({ value: c.id, label: c.id })), checked: field.values, onChange: (v) => { field.values = v; } });
    fields.push(field);
  }
  const report = el('div', { class: 'report' });
  await new Promise((resolve) => {
    openModal({
      title: t('send.columns.title', { name: r.name }), onClose: resolve,
      body: [message('warn', t('send.columns.shared')), ...fields.map(f => el('div', { class: 'form' }, el('h3', {}, f.table), f.list)), report],
      buttons: [{ label: t('common.cancel') }, {
        label: t('common.save'), kind: 'btn-primary', onClick: m => run(null, report, async () => {
          if (fields.some(f => !f.values.length)) throw new Error('noColumn');
          for (const f of fields) {
            await setExport(f.table, f.usable.filter(c => f.values.includes(c.id)));
            if ((await fetchRows(f.table)).length > 1000 - CHUNK) await sendAll(f.table, out);
          }
          m.close();
        }),
      }],
    });
  });
}

async function unblockQueue() {
  const ok = await confirmDialog({ title: t('send.unblock.title'), body: t('send.unblock.body'), confirmLabel: t('send.action.unblock'), danger: true });
  if (ok) await clearWebhookQueue();
}

// ---------------------------------------------------------------------------------------------
// Assistant d'envoi : Tables, Préparation, Options, Invitation, Réponse, Envoi. Une invitation
// en attente rouvre l'assistant à l'étape Réponse (`pending`).

const STEP = { tables: 0, columns: 1, options: 2, invitation: 3, reply: 4, load: 5 };

async function invitationWizard(pending = null) {
  const wizard = openWizard({
    title: pending ? pending.name : t('send.new'),
    steps: ['send.step.tables', 'send.step.columns', 'send.step.options', 'send.step.invitation', 'send.step.reply', 'send.step.load'].map(k => t(k)),
    onClose: () => renderSource(),
  });
  const cancel = { label: t('common.cancel') };
  let chosen = [];
  const selected = new Map(); // table -> colonnes choisies (exportableColumns)

  if (pending) return showReply(pending);
  return showTables();

  // 1. Tables à envoyer.
  async function showTables() {
    const tables = (await readSchema()).tableIds.filter(id => !id.startsWith('Synchro_'));
    const next = { label: t('common.next'), kind: 'btn-primary', disabled: !chosen.length, onClick: () => run(null, null, showColumns) };
    const body = [el('p', {}, t('send.tables.help')), checkList({
      items: tables.map(id => ({ value: id, label: id })), checked: chosen,
      onChange: (values) => { chosen = values; next.disabled = !chosen.length; wizard.show(STEP.tables, body, [cancel, next]); },
    })];
    wizard.show(STEP.tables, body, [cancel, next]);
  }

  // 2. Colonnes : celles qui partent, par table (toutes par défaut, ou celles déjà envoyées), et
  // ce que le widget ajoute pour la synchro, avant de l'ajouter.
  async function showColumns() {
    const schema = await readSchema();
    const report = el('div', { class: 'report' });
    const adds = [];
    const blocks = [];
    for (const table of chosen) {
      const all = exportableColumns(schema.columns(table));
      const usable = all.filter(c => !c.blocked);
      const current = (await readExport(table)).map(c => c.id).filter(id => usable.some(c => c.id === id));
      const start = selected.has(table) ? selected.get(table).map(c => c.id) : current.length ? current : usable.map(c => c.id);
      selected.set(table, usable.filter(c => start.includes(c.id)));
      const blocked = all.filter(c => c.blocked).map(c => c.id);
      adds.push(...missingSyncColumns(schema.columns(table)).map(col => `${table}.${col}`));
      if (!schema.has(listTableId(table))) adds.push(t('send.check.table', { table: listTableId(table) }));
      if (!schema.has(exportTableId(table))) adds.push(t('send.check.export', { table }));
      blocks.push(el('div', { class: 'form' }, el('h3', {}, table),
        current.length ? message('warn', t('send.columns.shared')) : null,
        checkList({ items: usable.map(c => ({ value: c.id, label: c.label === c.id ? c.id : `${c.label} (${c.id})` })), checked: start,
          onChange: (values) => { selected.set(table, usable.filter(c => values.includes(c.id))); } }),
        blocked.length ? el('p', { class: 'muted small' }, t('send.columns.blocked', { cols: blocked.join(', ') })) : null));
    }
    const prepare = async () => {
      if (chosen.some(table => !selected.get(table).length)) throw new Error('noColumn');
      for (const table of chosen) {
        await apply(prepareSourceActions(table, missingSyncColumns((await readSchema()).columns(table))));
        await apply(fillKeyActions(table, await fetchRows(table), () => crypto.randomUUID()));
        await createListTable(table);
        await setExport(table, selected.get(table));
      }
      showOptions();
    };
    wizard.show(STEP.columns, [el('p', {}, t('send.columns.help')), ...blocks,
      adds.length ? el('p', { class: 'muted small' }, t('send.check.missing', { items: adds.join(', ') })) : null, report], [
      { label: t('common.back'), onClick: showTables },
      { label: adds.length ? t('send.prepare') : t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, prepare) }]);
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
      tables: chosen.map(table => ({ table, columns: selected.get(table) })),
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
      await createWebhook({ name, memo, url: link.url, tableId: exportTableId(link.table) });
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
    if (!count) {
      wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.empty'))], [{ label: t('common.close'), kind: 'btn-primary' }]);
      return;
    }
    wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.body', { n: count })), report],
      [{ label: t('common.later') }, { label: t('send.load.ok'), kind: 'btn-primary', onClick: () => run(null, report, send) }]);
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
  const rows = await fetchRows(list);
  await apply([['BulkRemoveRecord', list, rows.map(r => r.id)], ['AddRecord', list, null, { [SCHEMA_COL]: (rows[0] || {})[SCHEMA_COL] || '' }]]);
}

async function waitForQueue() {
  for (let i = 0; i < 60; i++) {
    const waiting = (await listWebhooks()).reduce((n, h) => n + ((h.usage && h.usage.numWaiting) || 0), 0);
    if (waiting < 1000 - CHUNK) return;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
