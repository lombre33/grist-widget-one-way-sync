// Onglet « Recevoir » (document CIBLE) : accepter une invitation (Journal, table de destination,
// formulaire de réception), produire le code de réponse, puis consolider chaque Journal dans sa
// table de destination tant que la page est ouverte par un éditeur.
import {
  APPLIED_COL, KEY_COL, LIST_COL, buildReply, buildWebhookUrl, copyColumns, parseFormLink, parseInvitation,
  planConsolidation, planPurge, toTableId,
} from './core.js';
import { apply, docIdentity, ensureForm, fetchRows, formPages, readSchema } from './grist.js';
import { JOURNAL_PREFIX, createReceivingTables, destColumns, readNote, receivedTables } from './tables.js';
import { copyField, el, icon, message, openModal, run } from './ui.js';
import { t } from './i18n.js';

const POLL_MS = 10000;
const results = new Map(); // Journal -> { at, text, error, rows } du dernier passage
let container;
let busy = false;
let readOnly = false;

export function startAutoConsolidation() {
  setInterval(() => { if (document.visibilityState === 'visible') consolidateAll(); }, POLL_MS);
}

// ---------------------------------------------------------------------------------------------
// Consolidation

// Un seul lot d'écritures, donc tout ou rien : destination, marques et nettoyage du Journal.
async function consolidate(schema, { journal, dest }) {
  const [journalRows, destRows] = await Promise.all([fetchRows(journal), fetchRows(dest)]);
  const { actions, stats } = planConsolidation({
    journalRows, destRows, copyCols: copyColumns(schema.columns(journal), schema.columns(dest)), destTable: dest, journalTable: journal,
  });
  await apply([...actions, ...planPurge(journalRows, journal)]);
  return { ...stats, rows: journalRows.length };
}

function summary(s) {
  return s.added || s.updated || s.removed ? t('recv.result', s) : t('recv.result.none');
}

// Deux onglets du même navigateur ne consolident pas en même temps (verrou du navigateur) ;
// entre deux navigateurs, les écritures sont idempotentes.
async function withLock(fn) {
  return navigator.locks ? navigator.locks.request('gristsync-consolidation', fn) : fn();
}

// L'écran n'est redessiné que si un passage a changé quelque chose, et jamais quand un lien de
// formulaire est en cours de saisie.
export async function consolidateAll() {
  if (busy) return;
  busy = true;
  let changed = false;
  try {
    await withLock(async () => {
      const schema = await readSchema();
      for (const pair of receivedTables(schema)) {
        const before = results.get(pair.journal);
        const at = Date.now() / 1000;
        try {
          const stats = await consolidate(schema, pair);
          results.set(pair.journal, { at, text: summary(stats), rows: stats.rows });
          changed ||= stats.added + stats.updated + stats.removed > 0 || Boolean(before && (before.error || !before.rows !== !stats.rows));
          readOnly = false;
        } catch (e) {
          readOnly = /access|denied|blocked|permission/i.test(e.message);
          results.set(pair.journal, { at, text: e.message, error: true, rows: before ? before.rows : 0 });
          changed ||= !(before && before.error);
        }
      }
    });
  } finally {
    busy = false;
  }
  const typing = container && [...container.querySelectorAll('.link-step input')].some(input => input.value);
  if (changed && container && container.isConnected && !typing) await renderTarget();
}

// ---------------------------------------------------------------------------------------------
// Tableau de bord

// Les tables reçues par une même invitation forment un envoi : une carte, un lien, une réponse.
// Un envoi dont les journaux sont tous vides attend encore son lien.
async function receivedGroups(schema) {
  const groups = new Map();
  for (const pair of receivedTables(schema)) {
    const note = readNote(schema, pair.journal) || {};
    const key = note.id || pair.journal;
    if (!groups.has(key)) groups.set(key, { id: note.id, name: note.name || pair.dest, secret: note.secret || '', pairs: [], waiting: true });
    const group = groups.get(key);
    group.pairs.push({ ...pair, table: note.table || pair.dest });
    const known = results.get(pair.journal);
    if (known ? known.rows : (await fetchRows(pair.journal)).length) group.waiting = false;
  }
  return [...groups.values()];
}

export async function renderTarget(root = container) {
  container = root;
  const groups = await receivedGroups(await readSchema());
  // Formulaires des envois en attente, publiés sur la page du widget (une seule clé de partage).
  try {
    for (const group of groups.filter(g => g.waiting)) for (const pair of group.pairs) await ensureForm(pair.journal);
  } catch (e) {
    readOnly = true; // un lecteur ne peut pas publier le formulaire
  }
  const out = el('div', { class: 'out' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: readOnly, onclick: () => acceptInvitation() }, icon('plus'), t('recv.new')),
    el('button', { class: 'btn', type: 'button', disabled: readOnly || !groups.length, onclick: e => run(e.currentTarget, out, () => consolidateAll()) }, icon('refresh'), t('recv.action.sync')));
  const pages = await formPages();
  const cards = groups.map(group => syncCard(group, pages.get(group.pairs[0].journal)));
  container.replaceChildren(...[toolbar,
    readOnly ? message('warn', t('common.readonly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards, el('p', { class: 'muted small' }, t('recv.auto'))) : el('p', { class: 'muted' }, t('recv.empty'))].filter(Boolean));
}

function syncCard(group, formPage) {
  const failed = group.pairs.some(p => (results.get(p.journal) || {}).error);
  const [status, tone] = group.waiting ? ['waiting', 'pending'] : failed ? ['error', 'err'] : ['ok', 'ok'];
  const linkStep = linkForm(group, formPage);
  if (!group.waiting) linkStep.classList.add('hidden');
  const line = (pair) => {
    const result = results.get(pair.journal);
    const when = result && !group.waiting ? ` · ${new Date(result.at * 1000).toLocaleTimeString()} · ${result.text}` : '';
    return el('p', { class: `small ${result && result.error ? 'text-danger' : 'muted'}` }, `${pair.table} → ${pair.dest}${when}`);
  };
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, group.name), el('span', { class: `pill pill-${tone}` }, t(`recv.status.${status}`))),
    group.pairs.map(line),
    group.waiting ? null : el('div', { class: 'card-actions' },
      el('button', { class: 'btn btn-small', type: 'button', disabled: readOnly, onclick: () => linkStep.classList.toggle('hidden') }, icon('paste'), t('recv.action.link'))),
    linkStep);
}

// ---------------------------------------------------------------------------------------------
// Invitation : un Journal et une destination par table ; les formulaires sont publiés à
// l'affichage suivant

async function acceptInvitation() {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false' });
  const details = el('div', { class: 'form hidden' });
  const report = el('div', { class: 'report' });
  let invitation = null;
  let inputs = [];
  let confirmed = false; // tables existantes acceptées comme destinations

  const modal = openModal({
    title: t('recv.invite.title'),
    body: el('div', { class: 'form' }, el('p', {}, t('recv.invite.help')), area, report, details),
    buttons: [{ label: t('common.cancel') }, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, read) }],
  });

  // Une destination par table reçue, nommée d'après la table SOURCE par défaut ; une table
  // existante du document peut être choisie (liste proposée à la saisie).
  async function read() {
    invitation = parseInvitation(area.value);
    const known = el('datalist', { id: 'gristsync-tables' },
      (await readSchema()).tableIds.filter(id => !id.startsWith(JOURNAL_PREFIX) && !id.startsWith('Synchro_')).map(id => el('option', { value: id })));
    inputs = invitation.tables.map(tb => el('input', {
      type: 'text', class: 'input', value: toTableId(tb.table), list: 'gristsync-tables', 'aria-label': tb.table,
      oninput: () => { confirmed = false; },
    }));
    details.replaceChildren(known, el('label', {}, t('recv.dest')),
      ...invitation.tables.map((tb, i) => el('div', { class: 'dest-row' }, el('span', {}, `${tb.table} →`), inputs[i])));
    details.classList.remove('hidden');
    report.replaceChildren(message('ok', t('recv.invite.summary', { name: invitation.name, n: invitation.tables.length, tables: invitation.tables.map(tb => tb.table).join(', ') })));
    modal.setButtons([{ label: t('common.cancel') }, { label: t('recv.create'), kind: 'btn-primary', onClick: () => run(null, report, create) }]);
  }

  async function create() {
    const plans = invitation.tables.map((tb, i) => {
      const dest = toTableId(inputs[i].value, tb.table);
      return { tb, dest, journal: JOURNAL_PREFIX + dest };
    });
    const schema = await readSchema();
    if (new Set(plans.map(p => p.dest)).size !== plans.length || plans.some(p => schema.has(p.journal))) throw new Error('destTaken');
    // Une table existante n'est utilisée qu'après avoir montré ce qui lui sera ajouté.
    const existing = plans.filter(p => schema.has(p.dest));
    if (existing.length && !confirmed) {
      report.replaceChildren(...existing.map((p) => {
        const have = new Set(schema.columns(p.dest).map(c => c.colId));
        const added = destColumns(p.tb.columns).map(c => c.id).filter(id => !have.has(id));
        return message('warn', t('recv.existing', { table: p.dest, cols: added.join(', ') || '—' }));
      }));
      confirmed = true;
      modal.setButtons([{ label: t('common.cancel') }, { label: t('recv.useExisting'), kind: 'btn-primary', onClick: () => run(null, report, create) }]);
      return;
    }
    for (const p of plans) {
      await createReceivingTables({
        journal: p.journal, dest: p.dest,
        columns: p.tb.columns.map(c => ({ id: c.id, type: c.type, label: c.label, isFormula: false })),
        note: { id: invitation.id, name: invitation.name, table: p.tb.table, secret: invitation.secret },
      });
    }
    modal.close();
    await renderTarget();
  }
}

// ---------------------------------------------------------------------------------------------
// Lien du formulaire -> test -> code de réponse

// Étape du lien, dans la carte de la table reçue : elle reste affichée si Grist recharge le widget
// (ajouter le formulaire à la page recrée son cadre).
function linkForm(group, formPage) {
  const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('recv.link.title') });
  const report = el('div', { class: 'report' });
  const help = formPage && !formPage.samePage ? t('recv.link.help.other', { page: formPage.name }) : t('recv.link.help');
  const test = el('button', { class: 'btn btn-primary', type: 'button', disabled: readOnly, onclick: e => run(e.currentTarget, report, check) }, t('recv.link.check'));
  return el('div', { class: 'form link-step' }, el('p', { class: 'small' }, help), el('div', { class: 'copy-field' }, input, test), report);

  async function check() {
    if (!parseFormLink(input.value)) throw new Error('formLink');
    const links = group.pairs.map(pair => ({ table: pair.table, url: buildWebhookUrl(input.value, pair.journal) }));
    for (const link of links) await testUrl(link.url);
    const identity = await docIdentity();
    const code = buildReply({
      id: group.id, secret: group.secret, links,
      recipient: { email: await myEmail(group.pairs[0].journal), docId: identity.docId, team: identity.team, at: new Date().toISOString().slice(0, 16).replace('T', ' ') },
    });
    openModal({ title: t('recv.reply.title'), body: el('div', { class: 'form' }, el('p', {}, t('recv.reply.help')), copyField(code)), onClose: () => renderTarget() });
  }
}

// Envoie une ligne vide par la clé, comme le fera le webhook (le nettoyage du Journal l'efface) :
// valide d'un coup la clé, la publication, le nom de la table et `?flat=1`.
async function testUrl(url) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([{ [KEY_COL]: '' }]) });
  } catch (e) {
    throw new Error(t('error.linkTest', { detail: e.message }));
  }
  const text = await response.text();
  if (!response.ok) throw new Error(t('error.linkTest', { detail: `HTTP ${response.status} ${text.slice(0, 120)}` }));
}

// E-mail de la personne connectée, calculé par le serveur Grist : une ligne vide ajoutée au
// Journal avec ses droits remplit la colonne Sync_Par (formule user.Email). Le nettoyage l'efface.
async function myEmail(journal) {
  const id = (await apply([['AddRecord', journal, null, { [APPLIED_COL]: true, [LIST_COL]: '' }]])).retValues[0];
  return ((await fetchRows(journal)).find(r => r.id === id) || {}).Sync_Par || '';
}
