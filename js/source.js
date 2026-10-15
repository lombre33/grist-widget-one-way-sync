// Onglet « Envoyer » (document SOURCE) : préparer une table, inviter un destinataire, approuver
// sa réponse en créant les webhooks, suivre et piloter les envois. Rien n'est stocké hors des
// webhooks eux-mêmes et de la note de la table liste (invitations en attente).
import {
  AUTHOR_COL, CHUNK, ORDER_COL, SCHEMA_COL, buildInvitation, chunk, exportTableId, exportableColumns, fillKeyActions, listTableId, loopingTables,
  PUBLIC_MEMO, maskKey, masterTableId, missingSyncColumns, parseReply, parseWebhookUrl, prepareSourceActions, publicAclActions,
} from './core.js';
import {
  apply, clearWebhookQueue, createWebhook, deleteWebhook, docIdentity, fetchRows, listWebhooks, readSchema,
  setWebhookEnabled,
} from './grist.js';
import {
  JOURNAL_PREFIX, createListTable, readExport, readNote, receivedTables, removeSyncTables, sentTables, setExport, writeNote,
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

// Invitations en attente et partages par lien public, notés dans la table liste de chacune de
// leurs tables (`mode: 'public'` pour les seconds).
function notedInvitations(schema) {
  const byId = new Map();
  for (const table of sentTables(schema)) for (const inv of readNote(schema, listTableId(table)) || []) if (inv.mode !== PAUSE) byId.set(inv.id, inv);
  return [...byId.values()];
}
// Mise en pause, notée avec les invitations : un webhook désactivé perd son historique d'envoi
// (Grist remet son état à zéro), il ne peut donc pas dire depuis quand il ne livre plus. On note
// la plus récente MajLe de la table : heure du serveur, sans écart d'horloge avec le navigateur.
const PAUSE = 'pause';
const pauseEntry = (schema, feed) => (readNote(schema, listTableId(feed.table)) || []).find(e => e.mode === PAUSE && feed.main && e.hook === feed.main.id);

async function notePause(r, pausing) {
  const schema = await readSchema();
  for (const f of r.feeds.filter(f => f.main)) {
    const at = pausing && Math.max(0, ...(await fetchRows(f.table)).map(row => row[ORDER_COL] || 0));
    const id = listTableId(f.table);
    const note = (readNote(schema, id) || []).filter(e => !(e.mode === PAUSE && e.hook === f.main.id));
    // Les colonnes aussi : en changer pendant la pause ne touche pas MajLe, il faut alors tout renvoyer.
    const columns = pausing && JSON.stringify(await readExport(f.table));
    await writeNote(schema, id, pausing ? [...note, { id: `${PAUSE}-${f.main.id}`, mode: PAUSE, hook: f.main.id, at, columns }] : note);
  }
}

const pendingInvitations = schema => notedInvitations(schema).filter(inv => inv.mode !== 'public');
const publicShares = schema => notedInvitations(schema).filter(inv => inv.mode === 'public');

// Lien public : le document est-il lisible sans identifiant ? (requête anonyme)
async function isPublic(base) {
  try { return (await fetch(base, { credentials: 'omit' })).ok; } catch (e) { return false; }
}

// Règles d'accès du lien public, accordées aux partages notés : réécrites seulement si elles
// diffèrent (changer une règle fait recharger le document, et donc le widget). Le refus général
// reste tant que le document est public.
async function syncPublicRules(shares, open) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const tables = [...new Set(shares.flatMap(sh => sh.tables))];
  const name = id => (resources.find(r => r.id === id) || {}).tableId;
  const want = new Set([...tables.flatMap(tb => [exportTableId(tb), listTableId(tb)]), ...(tables.length || open ? ['*'] : [])]);
  const have = new Set(rules.filter(r => r.memo === PUBLIC_MEMO).map(r => name(r.resource)));
  if (want.size === have.size && [...want].every(tb => have.has(tb))) return;
  await apply(publicAclActions(resources, rules, tables, { keepDeny: open }));
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
  const shares = publicShares(schema);
  // Document lisible par lien public ? Vérifié à chaque affichage : tant qu'il l'est, le refus
  // général posé par le widget reste en place, même sans partage.
  const open = await isPublic((await grist.docApi.getAccessToken({ readOnly: true })).baseUrl);
  if (!ownerOnly) await syncPublicRules(shares, open);

  const out = el('div', { class: 'out' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: ownerOnly, onclick: () => invitationWizard() }, icon('plus'), t('send.new')));
  const cards = [
    ...pending.map(inv => pendingCard(inv, ownerOnly, out)),
    ...shares.map(share => publicCard(share, open, ownerOnly, out)),
    ...recipients(tables, hooks).map(r => recipientCard(r, ownerOnly, out)),
  ];
  const orphans = ownerOnly ? [] : unusedTables(schema, hooks, tables);
  if (orphans.length) cards.push(orphanCard(orphans, out));
  container.replaceChildren(...[toolbar,
    ownerOnly ? message('warn', t('common.ownerOnly')) : null,
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

function card(title, [status, tone], detail, ...rest) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, title), el('span', { class: `pill pill-${tone}` }, t(`send.status.${status}`))),
    el('p', { class: 'muted small' }, detail), ...rest);
}

function pendingCard(inv, ownerOnly, out) {
  return card(inv.name, ['invited', 'pending'], `${inv.tables.join(', ')} · ${inv.hash ? t('send.secret.on') : t('send.secret.off')}`,
    el('div', { class: 'card-actions' },
      el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: ownerOnly, onclick: () => invitationWizard(inv) }, icon('paste'), t('send.reply')),
      actionButton(t('send.action.cancel'), 'trash', () => cancelPending(inv), ownerOnly, out, 'btn-danger-text')));
}

// Tables préparées qu'aucun envoi n'utilise : ni webhook, ni invitation en attente, ni partage
// public (mise en place annulée, page rechargée en cours de route, envoi révoqué sans nettoyage).
function unusedTables(schema, hooks, tables = sentTables(schema)) {
  const noted = notedInvitations(schema).flatMap(inv => inv.tables);
  return tables.filter(table => !noted.includes(table) && !hooks.some(h => masterTableId(h.fields.tableId) === table));
}

function orphanCard(orphans, out) {
  return card(t('send.orphan.title'), ['orphan', 'off'], t('send.orphan.desc', { tables: orphans.join(', ') }),
    el('div', { class: 'card-actions' }, actionButton(t('send.orphan.clean'), 'trash', async () => {
      const { ok } = await confirmCleanup({ title: t('send.orphan.title'), body: t('send.orphan.body'), confirmLabel: t('send.orphan.clean'), orphans: [] });
      if (ok) await removeSyncTables(orphans);
    }, false, out, 'btn-danger-text')));
}

// Annuler une invitation en attente : son code ne pourra plus être accepté. Propose d'effacer
// les tables techniques que plus rien n'utilise.
async function cancelPending(inv) {
  const others = notedInvitations(await readSchema()).filter(i => i.id !== inv.id).flatMap(i => i.tables);
  const hooks = await listWebhooks();
  const orphans = inv.tables.filter(table => !others.includes(table) && !hooks.some(h => masterTableId(h.fields.tableId) === table));
  const { ok, cleanup } = await confirmCleanup({
    title: t('send.cancel.title', { name: inv.name }), body: t('send.cancel.body'), confirmLabel: t('send.action.cancel'), orphans,
  });
  if (!ok) return;
  await cancelInvitation(inv);
  if (cleanup) await removeSyncTables(orphans);
}

// Confirmation d'une action destructrice, avec la case « effacer les tables techniques » quand
// des tables deviennent inutiles. Promesse de { ok, cleanup }.
function confirmCleanup({ title, body, confirmLabel, orphans }) {
  const box = el('input', { type: 'checkbox', checked: true });
  return new Promise((resolve) => {
    let answered = false;
    const done = (m, ok) => { answered = true; resolve({ ok, cleanup: ok && orphans.length > 0 && box.checked }); m.close(); };
    const modal = openModal({
      title, width: 400,
      body: [el('p', {}, body),
        orphans.length ? el('label', { class: 'check' }, box, t('send.revoke.cleanup', { tables: orphans.map(listTableId).join(', ') })) : null],
      onClose: () => { if (!answered) resolve({ ok: false, cleanup: false }); },
      buttons: [
        { label: t('common.cancel'), onClick: m => done(m, false) },
        { label: confirmLabel, kind: 'btn-danger', onClick: m => done(m, true) },
      ],
    });
    modal.footer.querySelector('button').focus();
  });
}

// Partage par lien public : pas de webhook, la CIBLE lit les vues d'export elle-même.
function publicCard(share, open, ownerOnly, out) {
  const r = { name: share.name, feeds: share.tables.map(table => ({ table })) };
  return card(share.name, open ? ['public', 'ok'] : ['publicOff', 'pending'], `${share.tables.join(', ')} · ${t('send.public.label')}`,
    open ? null : el('p', { class: 'small' }, t('send.public.turnOn')),
    el('div', { class: 'card-actions' },
      actionButton(t('send.public.code'), 'copy', () => showPublicCode(share), ownerOnly, out),
      actionButton(t('send.action.columns'), 'columns', () => editColumns(r, out), ownerOnly, out),
      actionButton(t('send.action.revoke'), 'trash', () => revokePublic(share), ownerOnly, out, 'btn-danger-text')));
}

async function publicCode(share) {
  const [{ origin, docId }, { baseUrl }, list] = await Promise.all([
    docIdentity(), grist.docApi.getAccessToken({ readOnly: true }), fetchRows(listTableId(share.tables[0]))]);
  const tables = await Promise.all(share.tables.map(async table => ({ table, columns: await readExport(table) })));
  return buildInvitation({
    id: share.id, name: share.name, origin, base: baseUrl, from: { email: (list[0] || {})[AUTHOR_COL] || '', docId }, tables,
  });
}

// Bouton « copier avec les consignes » : le code et les étapes de la CIBLE, prêts pour un courriel.
const handoff = (mode, code) => el('div', { class: 'handoff' },
  copyButton(() => handoffText('target', mode, 1, code), t('guide.copyHandoff')), el('span', { class: 'muted small' }, t('guide.copyHandoff.help')));

async function showPublicCode(share) {
  const code = await publicCode(share);
  await new Promise(resolve => openModal({ title: share.name, onClose: resolve,
    body: [el('p', {}, t('send.public.help')), copyField(code), handoff('public', code)], buttons: [{ label: t('common.close'), kind: 'btn-primary' }] }));
}

// Révoquer un lien public retire l'accès des lecteurs à ses vues d'export. Tant que le document
// reste public, le refus général reste en place : rien d'autre ne devient lisible.
async function revokePublic(share) {
  const schema = await readSchema();
  const others = notedInvitations(schema).filter(i => i.id !== share.id).flatMap(i => i.tables);
  const hooks = await listWebhooks();
  const orphans = share.tables.filter(table => !others.includes(table) && !hooks.some(h => masterTableId(h.fields.tableId) === table));
  const { ok, cleanup } = await confirmCleanup({
    title: t('send.revoke.title', { name: share.name }), body: t('send.public.revokeBody'), confirmLabel: t('send.action.revoke'), orphans,
  });
  if (!ok) return;
  await cancelInvitation(share); // le tableau de bord redessiné ajuste les règles d'accès
  if (cleanup) await removeSyncTables(orphans);
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
    status[0] === 'paused' ? action(t('send.action.resume'), 'play', () => resume(r, enable, out))
      : action(t('send.action.pause'), 'pause', async () => { await notePause(r, true); await enable(false); }),
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

// Reprendre après une pause : un webhook désactivé ne met rien en file, les changements de la
// pause sont donc perdus pour la CIBLE. Le rattrapage renvoie les lignes dont MajLe est plus
// récente que la plus récente au moment de la pause, et la liste des clés pour les suppressions. Heure inconnue
// (pause faite avant cette version) : toute la table.
async function resume(r, enable, out) {
  const schema = await readSchema();
  const plans = [];
  for (const f of r.feeds) {
    const entry = pauseEntry(schema, f) || {};
    const rows = await fetchRows(f.table);
    const reshaped = entry.columns !== undefined && entry.columns !== JSON.stringify(await readExport(f.table));
    const all = entry.at === undefined || reshaped;
    const ids = all ? rows.map(row => row.id) : rows.filter(row => row[ORDER_COL] > entry.at).map(row => row.id);
    plans.push({ table: f.table, ids, unknown: entry.at === undefined, reshaped });
  }
  const n = plans.reduce((sum, p) => sum + p.ids.length, 0);
  const unknown = plans.filter(p => p.unknown).map(p => p.table);
  const reshaped = plans.filter(p => p.reshaped && !p.unknown).map(p => p.table);
  const choice = (value, label, help, checked) => [el('label', { class: 'check' },
    el('input', { type: 'radio', name: 'gristsync-resume', value, checked }), el('strong', {}, label)), el('p', { class: 'muted small choice-help' }, help)];
  const body = el('div', { class: 'form', role: 'radiogroup' },
    choice('catchup', t('send.resume.catchup'), [t('send.resume.catchup.help', { n }),
      unknown.length ? t('send.resume.all', { tables: unknown.join(', ') }) : '',
      reshaped.length ? t('send.resume.columns', { tables: reshaped.join(', ') }) : ''].filter(Boolean).join(' '), true),
    choice('as-is', t('send.resume.asIs'), t('send.resume.asIs.help'), false));
  const picked = await new Promise((resolve) => {
    let answered = false;
    const done = (m, value) => { answered = true; resolve(value); m.close(); };
    openModal({
      title: t('send.resume.title', { name: r.name }), body,
      onClose: () => { if (!answered) resolve(null); },
      buttons: [{ label: t('common.cancel'), onClick: m => done(m, null) },
        { label: t('send.action.resume'), kind: 'btn-primary', onClick: m => done(m, body.querySelector('input:checked').value) }],
    });
  });
  if (!picked) return;
  await enable(true);
  if (picked === 'catchup') for (const p of plans) await touchRows(p.table, p.ids, out);
  await notePause(r, false);
}

// Révoquer supprime les webhooks du destinataire. Si plus rien n'envoie une table (ni webhook ni
// invitation), le widget propose aussi d'effacer ses tables techniques (liste, vue d'export) ;
// les colonnes id_sync, MajLe et Supprime de la table restent (elles portent des données).
async function revoke(r, hooks) {
  const others = (await listWebhooks()).filter(h => !hooks.some(mine => mine.id === h.id));
  const pending = notedInvitations(await readSchema()).flatMap(inv => inv.tables);
  const orphans = r.feeds.map(f => f.table)
    .filter(table => !others.some(h => masterTableId(h.fields.tableId) === table) && !pending.includes(table));
  const { ok, cleanup } = await confirmCleanup({
    title: t('send.revoke.title', { name: r.name }), body: t('send.revoke.body'), confirmLabel: t('send.action.revoke'), orphans,
  });
  if (!ok) return;
  for (const h of hooks) await deleteWebhook(h.id);
  if (cleanup) await removeSyncTables(orphans);
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
          let n = 0;
          for (const f of fields) {
            const before = (await readExport(f.table)).map(c => c.id).join();
            const chosen = f.usable.filter(c => f.values.includes(c.id));
            if (chosen.map(c => c.id).join() === before) continue;
            // Changer la formule de la vue d'export renvoie chaque ligne avec les colonnes choisies.
            await setExport(f.table, chosen);
            const rows = (await fetchRows(f.table)).length;
            if (rows > 1000 - CHUNK) await sendAll(f.table, report);
            n += rows;
          }
          report.replaceChildren(message('ok', n ? t('send.columns.sent', { n }) : t('send.columns.same')));
          m.setButtons([{ label: t('common.close'), kind: 'btn-primary' }]);
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
    onClose: async () => { if (!invited && added.size) await run(null, null, undoPrepare); renderSource(); },
  });
  const cancel = { label: t('common.cancel') };
  let chosen = [];
  const selected = new Map(); // table -> colonnes choisies (exportableColumns)
  // Mise en place annulée (fenêtre fermée avant l'invitation) : on retire ce que la préparation
  // a ajouté et que rien d'autre n'utilise, colonnes de la synchro comprises.
  const added = new Map(); // table -> { cols: colonnes ajoutées, fresh: tables techniques créées ici }
  let invited = false;

  if (pending) return showReply(pending);
  return showTables();

  // 1. Tables à envoyer.
  async function showTables() {
    const tables = (await readSchema()).tableIds.filter(id => !id.startsWith('Synchro_') && !id.startsWith(JOURNAL_PREFIX));
    const next = { label: t('common.next'), kind: 'btn-primary', disabled: !chosen.length, onClick: () => run(null, null, showColumns) };
    const body = [el('p', {}, t('send.tables.help')), checkList({
      items: tables.map(id => ({ value: id, label: id })), checked: chosen,
      onChange: (values) => { chosen = values; next.disabled = !chosen.length; wizard.show(STEP.tables, body, [cancel, next]); },
    }), stepHelp(['s-tables']), roleGuide({ you: 'source', current: 0 })];
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
        schema.has(JOURNAL_PREFIX + table) ? message('info', t('send.columns.relay')) : null,
        checkList({ items: usable.map(c => ({ value: c.id, label: c.label === c.id ? c.id : `${c.label} (${c.id})` })), checked: start,
          onChange: (values) => { selected.set(table, usable.filter(c => values.includes(c.id))); } }),
        blocked.length ? el('p', { class: 'muted small' }, t('send.columns.blocked', { cols: blocked.join(', ') })) : null));
    }
    const prepare = async () => {
      if (chosen.some(table => !selected.get(table).length)) throw new Error('noColumn');
      for (const table of chosen) {
        const before = await readSchema();
        const missing = missingSyncColumns(before.columns(table));
        if (!added.has(table)) added.set(table, { cols: missing, fresh: !before.has(listTableId(table)) });
        await apply(prepareSourceActions(table, missing));
        // Table reçue (relais) : ses lignes gardent la clé de leur document d'origine. Une ligne
        // ajoutée ici à la main reste sans clé, donc locale : avec une clé, la prochaine liste
        // de l'origine, qui ne la connaît pas, l'effacerait.
        if (!schema.has(JOURNAL_PREFIX + table)) await apply(fillKeyActions(table, await fetchRows(table), () => crypto.randomUUID()));
        await createListTable(table);
        await setExport(table, selected.get(table));
      }
      showOptions();
    };
    wizard.show(STEP.columns, [el('p', {}, t('send.columns.help')), ...blocks,
      adds.length ? el('p', { class: 'muted small' }, t('send.check.missing', { items: adds.join(', ') })) : null, report, stepHelp(['s-columns'])], [
      { label: t('common.back'), onClick: showTables },
      { label: adds.length ? t('send.prepare') : t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, prepare) }]);
  }

  // 3. Options : nom de l'envoi, mode (réponse ou lien public), secret.
  function showOptions() {
    const nameInput = el('input', { type: 'text', class: 'input', value: chosen.join(' + ') });
    const secretBox = el('input', { type: 'checkbox', checked: true });
    const radio = (value, label, checked) => el('label', { class: 'check' },
      el('input', { type: 'radio', name: 'gristsync-mode', value, checked, onchange: () => { secretPart.classList.toggle('hidden', value === 'public'); publicPart.classList.toggle('hidden', value !== 'public'); } }), label);
    const secretPart = el('div', { class: 'form' }, el('label', { class: 'check' }, secretBox, t('send.secret')), el('p', { class: 'muted small' }, t('send.secret.help')));
    const publicPart = el('div', { class: 'hidden' }, message('warn', t('send.public.warn')));
    const report = el('div', { class: 'report' });
    const mode = () => (document.querySelector('input[name="gristsync-mode"]:checked') || {}).value;
    wizard.show(STEP.options, [
      message('ok', t('send.check.ok', { n: chosen.length })),
      el('label', {}, t('send.name')), nameInput,
      el('label', {}, t('send.mode')),
      radio('reponse', t('send.mode.reply'), true), radio('public', t('send.mode.public'), false),
      secretPart, publicPart, report, stepHelp(['s-options', 'public']),
    ], [cancel, { label: t('send.invite'), kind: 'btn-primary', onClick: () => run(null, report, () => invite(nameInput.value.trim(), mode() !== 'public' && secretBox.checked, mode() === 'public')) }]);
  }

  // 4. Invitation : le code à transmettre ; l'invitation attend sa réponse dans une carte.
  async function invite(name, withSecret, isPublicMode) {
    const secret = withSecret ? randomHex(16) : '';
    const entry = { id: randomHex(8), name: name || chosen.join(' + '), hash: secret ? await sha256(secret) : '', at: now(), tables: chosen,
      ...(isPublicMode ? { mode: 'public' } : {}) };
    const schema = await readSchema();
    for (const table of chosen) {
      const id = listTableId(table);
      await writeNote(schema, id, [...(readNote(schema, id) || []), entry]);
    }
    invited = true;
    // Les règles d'accès sont posées à la fermeture (le document se recharge alors).
    if (isPublicMode) {
      const code = await publicCode(entry);
      wizard.show(STEP.invitation, [el('p', {}, t('send.public.help')), copyField(code), handoff('public', code),
        message('warn', t('send.public.turnOn')), roleGuide({ you: 'source', mode: 'public', current: 1, open: true }), stepHelp(['public'])],
        [{ label: t('common.close'), kind: 'btn-primary' }]);
      return;
    }
    const [{ origin, docId }, list] = await Promise.all([docIdentity(), fetchRows(listTableId(chosen[0]))]);
    const code = buildInvitation({
      id: entry.id, name: entry.name, origin, secret, from: { email: (list[0] || {})[AUTHOR_COL] || '', docId },
      tables: chosen.map(table => ({ table, columns: selected.get(table) })),
    });
    wizard.show(STEP.invitation, [el('p', {}, t('send.invite.help')), copyField(code), handoff('reponse', code),
      roleGuide({ you: 'source', current: 1, open: true }), stepHelp(['s-invite', 't-code', 't-dest', 't-link', 't-reply'])],
      [{ label: t('common.later') }, { label: t('send.reply.ready'), kind: 'btn-primary', onClick: () => showReply(entry) }]);
  }

  async function undoPrepare() {
    const schema = await readSchema();
    const unused = unusedTables(schema, await listWebhooks(), [...added.keys()].filter(table => schema.has(listTableId(table))));
    await removeSyncTables(unused.filter(table => added.get(table).fresh));
    const columns = unused.flatMap(table => added.get(table).cols.map(col => ['RemoveColumn', table, col]));
    if (columns.length) await apply(columns);
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
      const schema = await readSchema();
      const received = receivedTables(schema).map(p => ({ dest: p.dest, fromDocId: ((readNote(schema, p.journal) || {}).from || {}).docId }));
      if (loopingTables(reply.links, reply.recipient.docId, (await docIdentity()).docId, received).length) throw new Error('loop');
      const r = reply.recipient;
      const fiche = [[t('send.reply.tables'), reply.links.map(l => l.table).join(', ')], [t('send.reply.email'), r.email],
        [t('send.reply.doc'), r.docId], [t('send.reply.team'), r.team], [t('send.reply.at'), r.at]];
      report.replaceChildren(...[el('dl', { class: 'fiche' }, fiche.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')])),
        reply.secret ? null : message('warn', t('send.reply.nosecret')),
        el('p', { class: 'muted small' }, maskKey(reply.links[0].url))].filter(Boolean));
      wizard.show(STEP.reply, body, [{ label: t('common.later') },
        { label: t('send.reply.approve'), kind: 'btn-primary', onClick: () => run(null, report, () => approve(inv, reply)) }]);
    };
    const body = [el('p', {}, t('send.reply.help')), area, report, stepHelp(['s-reply', 's-load']), roleGuide({ you: 'source', current: 3 })];
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
  await touchRows(tableId, (await fetchRows(tableId)).map(r => r.id), out);
}

// Renvoie les lignes `ids` (MajLe remise à maintenant) et la liste des clés.
async function touchRows(tableId, ids, out) {
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
