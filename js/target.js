// Onglet « Recevoir » (document CIBLE) : accepter une invitation (Journal, table de destination,
// formulaire de réception), produire le code de réponse, puis consolider le Journal dans la
// table de destination tant que la page est ouverte par un éditeur.
import {
  CONFIG_TABLE, KEY_COL, META_JOURNAL_ID, META_ORDER, ORDER_COL, buildReply, buildWebhookUrl, copyColumns,
  parseFormLink, parseInvitation, planConsolidation, planPurge, toTableId,
} from './core.js';
import { apply, docIdentity, ensureForm, fetchRows, formPages, listColumns } from './grist.js';
import { ensureTable, hasTable } from './tables.js';
import { confirmDialog, copyField, el, icon, message, openModal, run } from './ui.js';
import { t } from './i18n.js';

const POLL_MS = 30000;
const results = new Map(); // ligne de Synchro_Config -> { at, text, error }
let container;
let busy = false;
let readOnly = false;

export function startAutoConsolidation() {
  setInterval(() => { if (document.visibilityState === 'visible') consolidateAll(); }, POLL_MS);
}

// ---------------------------------------------------------------------------------------------
// Consolidation

async function consolidate(config, purge) {
  const journalCols = await listColumns(config.Journal);
  let destCols = await listColumns(config.Destination);
  if (!journalCols || !destCols) throw new Error(`${config.Journal} / ${config.Destination} ?`);
  const orderType = (journalCols.find(c => c.colId === ORDER_COL) || {}).type || 'Any';
  const missingMeta = [[META_JOURNAL_ID, 'Int'], [META_ORDER, orderType]].filter(([id]) => !destCols.some(c => c.colId === id));
  if (missingMeta.length) {
    await apply(missingMeta.map(([id, type]) => ['AddColumn', config.Destination, id, { type, isFormula: false }]));
    destCols = await listColumns(config.Destination);
  }
  const [journalRows, destRows] = await Promise.all([fetchRows(config.Journal), fetchRows(config.Destination)]);
  const { actions, stats } = planConsolidation({ journalRows, destRows, copyCols: copyColumns(journalCols, destCols), destTable: config.Destination });
  await apply(actions);
  const purgeActions = purge ? planPurge(journalRows, config.Journal) : [];
  await apply(purgeActions);
  return { ...stats, purged: purgeActions.reduce((n, a) => n + a[2].length, 0) };
}

function summary(s) {
  const parts = [s.added || s.updated || s.removed ? t('recv.result', s) : t('recv.result.none')];
  if (s.purged) parts.push(t('recv.purged', { n: s.purged }));
  return parts.join(' · ');
}

// Deux onglets du même navigateur ne consolident pas en même temps (verrou du navigateur) ;
// entre deux navigateurs, les écritures par clé sont idempotentes.
async function withLock(fn) {
  return navigator.locks ? navigator.locks.request('gristsync-consolidation', fn) : fn();
}

export async function consolidateAll({ purge = false } = {}) {
  if (busy || !(await hasTable(CONFIG_TABLE))) return;
  busy = true;
  try {
    await withLock(async () => {
      for (const config of await fetchRows(CONFIG_TABLE)) {
        if (!config.Journal || !config.Destination) continue;
        const at = Date.now() / 1000;
        try {
          const stats = await consolidate(config, purge);
          results.set(config.id, { at, text: summary(stats) });
          if (stats.added || stats.updated || stats.removed || stats.purged) {
            await apply([['UpdateRecord', CONFIG_TABLE, config.id, { Derniere_execution: at, Bilan: summary(stats) }]]);
          }
          readOnly = false;
        } catch (e) {
          readOnly = /access|denied|blocked|permission/i.test(e.message);
          results.set(config.id, { at, text: e.message, error: true });
        }
      }
    });
  } finally {
    busy = false;
  }
  if (container && container.isConnected) await renderTarget();
}

// ---------------------------------------------------------------------------------------------
// Tableau de bord

export async function renderTarget(root = container) {
  container = root;
  const configs = (await hasTable(CONFIG_TABLE)) ? await fetchRows(CONFIG_TABLE) : [];
  try {
    for (const config of configs.filter(c => c.Statut !== 'actif')) await ensureForm(config.Journal);
  } catch (e) {
    readOnly = true; // un lecteur ne peut pas publier le formulaire
  }
  const out = el('div', { class: 'out' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: readOnly, onclick: () => acceptInvitation() }, icon('plus'), t('recv.new')),
    el('button', { class: 'btn', type: 'button', disabled: readOnly || !configs.length, onclick: e => run(e.currentTarget, out, () => consolidateAll()) }, icon('refresh'), t('recv.action.sync')),
    el('button', { class: 'btn', type: 'button', disabled: readOnly || !configs.length, onclick: e => run(e.currentTarget, out, purge) }, icon('trash'), t('recv.action.purge')));
  const pages = await formPages();
  const cards = configs.map(config => syncCard(config, pages.get(config.Journal)));
  container.replaceChildren(...[toolbar,
    readOnly ? message('warn', t('common.readonly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards, el('p', { class: 'muted small' }, t('recv.auto'))) : el('p', { class: 'muted' }, t('recv.empty'))].filter(Boolean));
}

function syncCard(config, formPage) {
  const result = results.get(config.id);
  const waiting = config.Statut !== 'actif';
  const [status, tone] = waiting ? ['waiting', 'pending'] : result && result.error ? ['error', 'err'] : ['ok', 'ok'];
  const when = result ? new Date(result.at * 1000).toLocaleTimeString() : '';
  const linkStep = linkForm(config, formPage);
  if (!waiting) linkStep.classList.add('hidden');
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, config.Nom || config.Destination), el('span', { class: `pill pill-${tone}` }, t(`recv.status.${status}`))),
    el('p', { class: 'muted small' }, `${config.Journal} → ${config.Destination}`),
    result ? el('p', { class: `small ${result.error ? 'text-danger' : ''}` }, `${when} · ${result.text}`) : null,
    waiting ? null : el('div', { class: 'card-actions' },
      el('button', { class: 'btn btn-small', type: 'button', disabled: readOnly, onclick: () => linkStep.classList.toggle('hidden') }, icon('paste'), t('recv.action.link'))),
    linkStep);
}

async function purge() {
  if (await confirmDialog({ title: t('recv.purge.title'), body: t('recv.purge.body'), confirmLabel: t('recv.action.purge'), danger: true })) {
    await consolidateAll({ purge: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Invitation : créer Journal, destination, réglage, formulaire publié

async function acceptInvitation() {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false' });
  const destInput = el('input', { type: 'text', class: 'input' });
  const details = el('div', { class: 'form hidden' }, el('label', {}, t('recv.dest')), destInput);
  const report = el('div', { class: 'report' });
  let invitation = null;

  const modal = openModal({
    title: t('recv.invite.title'),
    body: el('div', { class: 'form' }, el('p', {}, t('recv.invite.help')), area, report, details),
    buttons: [{ label: t('common.cancel') }, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, read) }],
  });

  function read() {
    invitation = parseInvitation(area.value);
    destInput.value = toTableId(invitation.table);
    details.classList.remove('hidden');
    report.replaceChildren(message('ok', t('recv.invite.summary', { name: invitation.name, table: invitation.table, n: invitation.columns.length })));
    modal.setButtons([{ label: t('common.cancel') }, { label: t('recv.create'), kind: 'btn-primary', onClick: () => run(null, report, create) }]);
  }

  async function create() {
    if (!(await ensureTable(CONFIG_TABLE))) return;
    const destination = toTableId(destInput.value, invitation.table);
    const journal = `Journal_${destination}`;
    const columns = invitation.columns.map(c => ({ id: c.id, type: c.type, label: c.label, isFormula: false }));
    await createOrComplete(journal, columns);
    await createOrComplete(destination, [...columns,
      { id: META_JOURNAL_ID, type: 'Int', isFormula: false },
      { id: META_ORDER, type: (columns.find(c => c.id === ORDER_COL) || {}).type || 'Any', isFormula: false }]);
    await apply([['AddRecord', CONFIG_TABLE, null, {
      Nom: invitation.name, Table_source: invitation.table, Journal: journal, Destination: destination,
      Statut: 'attente_lien', Secret: invitation.secret, Origine_source: invitation.origin,
    }]]);
    modal.close();
    await renderTarget();
  }
}

// Ajoute la table, ou les colonnes qui lui manquent si elle existe déjà.
async function createOrComplete(tableId, columns) {
  const existing = await listColumns(tableId);
  if (!existing) return apply([['AddTable', tableId, columns]]);
  const have = new Set(existing.map(c => c.colId));
  return apply(columns.filter(c => !have.has(c.id)).map(({ id, ...info }) => ['AddColumn', tableId, id, info]));
}

// ---------------------------------------------------------------------------------------------
// Lien du formulaire -> test -> code de réponse

// Étape du lien, dans la carte de la table reçue : elle reste affichée si Grist recharge le widget
// (ajouter le formulaire à la page recrée son cadre).
function linkForm(config, formPage) {
  const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('recv.link.title') });
  const report = el('div', { class: 'report' });
  const help = formPage && !formPage.samePage ? t('recv.link.help.other', { page: formPage.name }) : t('recv.link.help');
  const test = el('button', { class: 'btn btn-primary', type: 'button', disabled: readOnly, onclick: e => run(e.currentTarget, report, check) }, t('recv.link.check'));
  return el('div', { class: 'form link-step' }, el('p', { class: 'small' }, help), el('div', { class: 'copy-field' }, input, test), report);

  async function check() {
    if (!parseFormLink(input.value)) throw new Error('formLink');
    const url = buildWebhookUrl(input.value, config.Journal);
    await testUrl(url, config.Journal);
    const identity = await docIdentity();
    const fresh = (await fetchRows(CONFIG_TABLE)).find(c => c.id === config.id);
    await apply([['UpdateRecord', CONFIG_TABLE, config.id, { Statut: 'actif' }]]);
    const code = buildReply({
      url, secret: fresh.Secret,
      recipient: { email: fresh.Accepte_par, docId: identity.docId, team: identity.team, journal: config.Journal, at: new Date().toISOString().slice(0, 16).replace('T', ' ') },
    });
    openModal({ title: t('recv.reply.title'), body: el('div', { class: 'form' }, el('p', {}, t('recv.reply.help')), copyField(code)), onClose: () => renderTarget() });
  }
}

// Envoie une ligne vide par la clé, comme le fera le webhook, puis l'efface du Journal : valide
// d'un coup la clé, la publication, le nom de la table et `?flat=1`.
async function testUrl(url, journal) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ [KEY_COL]: '' }]) });
  } catch (e) {
    throw new Error(t('error.linkTest', { detail: e.message }));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(t('error.linkTest', { detail: `HTTP ${response.status} ${text.slice(0, 120)}` }));
  const id = JSON.parse(text).records[0].id;
  await apply([['RemoveRecord', journal, id]]);
}

