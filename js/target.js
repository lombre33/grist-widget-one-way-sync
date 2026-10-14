// Onglet « Recevoir » (document CIBLE) : accepter une invitation (Journal, table de destination,
// formulaire de réception), produire le code de réponse, puis consolider chaque Journal dans sa
// table de destination tant que la page est ouverte par un éditeur.
import {
  APPLIED_COL, AUTHOR_COL, KEY_COL, LIST_COL, buildReply, buildWebhookUrl, copyColumns, parseFormLink, parseInvitation,
  planConsolidation, planPurge, recentChanges, toTableId,
} from './core.js';
import { apply, collapseForms, docIdentity, ensureForm, fetchRows, formPages, readSchema } from './grist.js';
import { JOURNAL_PREFIX, createReceivingTables, destColumns, readNote, receivedTables } from './tables.js';
import { copyField, el, icon, message, openWizard, run } from './ui.js';
import { t } from './i18n.js';
import { readPref, writePref } from './prefs.js';

const POLL_MS = 10000;
const HISTORY_MAX = 20;
const results = new Map(); // Journal -> { at, text, error, rows, recent } du dernier passage
let container;
let busy = false;
let readOnly = false;
let lastVisit = null; // date de la visite précédente sur ce document (secondes), ou 0
let wizardOpened = false; // l'assistant ne se rouvre seul qu'une fois par chargement

export function startAutoConsolidation() {
  setInterval(() => { if (document.visibilityState === 'visible') consolidateAll(); }, POLL_MS);
}

// Date de la visite précédente, retenue par navigateur et par document : la seule chose que le
// widget garde hors de Grist pour l'historique (aucune donnée des tables).
async function readLastVisit() {
  if (lastVisit !== null) return;
  const key = `visit.${(await docIdentity()).docId}`;
  lastVisit = Number(readPref(key)) || 0;
  writePref(key, String(Math.floor(Date.now() / 1000)));
}

// ---------------------------------------------------------------------------------------------
// Consolidation

// Un seul lot d'écritures, donc tout ou rien : destination, marques et nettoyage du Journal.
async function consolidate(schema, { journal, dest }) {
  const [journalRows, destRows] = await Promise.all([fetchRows(journal), fetchRows(dest)]);
  const copyCols = copyColumns(schema.columns(journal), schema.columns(dest));
  const { actions, stats } = planConsolidation({ journalRows, destRows, copyCols, destTable: dest, journalTable: journal });
  await apply([...actions, ...planPurge(journalRows, journal)]);
  return { ...stats, rows: journalRows.length, recent: recentChanges(journalRows, copyCols[0], lastVisit, HISTORY_MAX) };
}

function summary(s) {
  return s.added || s.updated || s.removed ? t('recv.result', s) : t('recv.result.none');
}

// Deux onglets du même navigateur ne consolident pas en même temps (verrou du navigateur) ;
// entre deux navigateurs, les écritures sont idempotentes.
async function withLock(fn) {
  return navigator.locks ? navigator.locks.request('gristsync-consolidation', fn) : fn();
}

// L'écran n'est redessiné que si un passage a changé quelque chose.
export async function consolidateAll() {
  if (busy) return;
  busy = true;
  let changed = false;
  try {
    await readLastVisit();
    await withLock(async () => {
      const schema = await readSchema();
      for (const pair of receivedTables(schema)) {
        const before = results.get(pair.journal);
        const at = Date.now() / 1000;
        try {
          const stats = await consolidate(schema, pair);
          results.set(pair.journal, { at, text: summary(stats), rows: stats.rows, recent: stats.recent });
          changed ||= stats.added + stats.updated + stats.removed > 0 || Boolean(before && (before.error || !before.rows !== !stats.rows));
          readOnly = false;
        } catch (e) {
          readOnly = /access|denied|blocked|permission/i.test(e.message);
          results.set(pair.journal, { ...before, at, text: e.message, error: true });
          changed ||= !(before && before.error);
        }
      }
    });
  } finally {
    busy = false;
  }
  if (changed && container && container.isConnected) await renderTarget();
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
    if (!groups.has(key)) {
      groups.set(key, { id: note.id, name: note.name || pair.dest, secret: note.secret || '', from: note.from || {}, pairs: [], waiting: true });
    }
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
  // Grist recrée alors le cadre du widget : l'assistant se rouvre à l'étape Lien au chargement.
  try {
    for (const group of groups.filter(g => g.waiting)) for (const pair of group.pairs) await ensureForm(pair.journal);
  } catch (e) {
    readOnly = true; // un lecteur ne peut pas publier le formulaire
  }
  const out = el('div', { class: 'out' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: readOnly, onclick: () => receiveWizard() }, icon('plus'), t('recv.new')),
    el('button', { class: 'btn', type: 'button', disabled: readOnly || !groups.length, onclick: e => run(e.currentTarget, out, () => consolidateAll()) }, icon('refresh'), t('recv.action.sync')));
  const cards = groups.map(syncCard);
  container.replaceChildren(...[toolbar,
    readOnly ? message('warn', t('common.readonly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards, el('p', { class: 'muted small' }, t('recv.auto'))) : el('p', { class: 'muted' }, t('recv.empty'))].filter(Boolean));
  // Les journaux qui reçoivent déjà n'ont plus besoin de leur formulaire à l'écran.
  if (!readOnly) collapseForms(groups.filter(g => !g.waiting).flatMap(g => g.pairs.map(p => p.journal))).catch(() => {});
  const waiting = groups.find(g => g.waiting);
  if (waiting && !readOnly && !wizardOpened) {
    wizardOpened = true;
    receiveWizard(waiting);
  }
}

function syncCard(group) {
  const failed = group.pairs.some(p => (results.get(p.journal) || {}).error);
  const [status, tone] = group.waiting ? ['waiting', 'pending'] : failed ? ['error', 'err'] : ['ok', 'ok'];
  const line = (pair) => {
    const result = results.get(pair.journal);
    const when = result && !group.waiting ? ` · ${new Date(result.at * 1000).toLocaleTimeString()} · ${result.text}` : '';
    return el('p', { class: `small ${result && result.error ? 'text-danger' : 'muted'}` }, `${pair.table} → ${pair.dest}${when}`);
  };
  const from = group.from.email;
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, group.name), el('span', { class: `pill pill-${tone}` }, t(`recv.status.${status}`))),
    from ? el('p', { class: 'small' }, t('recv.from', { from })) : null,
    group.pairs.map(line),
    group.waiting ? null : history(group),
    el('div', { class: 'card-actions' },
      el('button', { class: `btn btn-small ${group.waiting ? 'btn-primary' : ''}`, type: 'button', disabled: readOnly, onclick: () => receiveWizard(group) },
        icon('paste'), t(group.waiting ? 'recv.action.continue' : 'recv.action.link'))));
}

// Dernières lignes reçues depuis la visite précédente (toutes les tables de l'envoi), au plus 20.
function history(group) {
  const items = group.pairs.flatMap(p => ((results.get(p.journal) || {}).recent || []).map(c => ({ ...c, dest: p.dest })))
    .sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX);
  const title = t(lastVisit ? 'recv.history.since' : 'recv.history.last', { n: items.length });
  if (!items.length) return el('p', { class: 'muted small' }, t('recv.history.none'));
  return el('details', { class: 'history' }, el('summary', { class: 'small' }, title),
    el('ul', { class: 'small' }, items.map(c => el('li', {},
      `${new Date(c.at * 1000).toLocaleString()} · ${c.dest} · ${c.label || '—'} · ${t(c.deleted ? 'recv.history.deleted' : 'recv.history.changed')}`))));
}

// ---------------------------------------------------------------------------------------------
// Assistant de réception : Code, Destinations, Lien, Réponse. Un envoi en attente (ou à
// rebrancher) l'ouvre directement à l'étape Lien (`group`).

const STEP = { code: 0, dest: 1, link: 2, reply: 3 };

function receiveWizard(group = null) {
  const wizard = openWizard({
    title: group ? group.name : t('recv.new'),
    steps: ['recv.step.code', 'recv.step.dest', 'recv.step.link', 'recv.step.reply'].map(k => t(k)),
    onClose: () => renderTarget(),
  });
  const cancel = { label: t('common.cancel') };
  if (group) return showLink(group);
  return showCode();

  // 1. Code d'invitation.
  function showCode() {
    const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('recv.invite.title') });
    const report = el('div', { class: 'report' });
    wizard.show(STEP.code, [el('p', {}, t('recv.invite.help')), area, report],
      [cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, () => showDest(parseInvitation(area.value))) }]);
  }

  // 2. Destinations : une par table reçue, nouvelle ou existante (proposées à la saisie). Une
  // table existante n'est utilisée qu'après avoir montré ce qui lui sera ajouté.
  async function showDest(invitation) {
    const schema = await readSchema();
    const known = el('datalist', { id: 'gristsync-tables' },
      schema.tableIds.filter(id => !id.startsWith(JOURNAL_PREFIX) && !id.startsWith('Synchro_')).map(id => el('option', { value: id })));
    let confirmed = false;
    const inputs = invitation.tables.map(tb => el('input', {
      type: 'text', class: 'input', value: toTableId(tb.table), list: 'gristsync-tables', 'aria-label': tb.table,
      oninput: () => { confirmed = false; },
    }));
    const report = el('div', { class: 'report' });
    const from = invitation.from.email;
    const create = async () => {
      const plans = invitation.tables.map((tb, i) => {
        const dest = toTableId(inputs[i].value, tb.table);
        return { tb, dest, journal: JOURNAL_PREFIX + dest };
      });
      const now = await readSchema();
      if (new Set(plans.map(p => p.dest)).size !== plans.length || plans.some(p => now.has(p.journal))) throw new Error('destTaken');
      const existing = plans.filter(p => now.has(p.dest));
      if (existing.length && !confirmed) {
        confirmed = true;
        report.replaceChildren(...existing.map((p) => {
          const have = new Set(now.columns(p.dest).map(c => c.colId));
          const added = destColumns(p.tb.columns).map(c => c.id).filter(id => !have.has(id))
            .map(id => (id === KEY_COL ? t('recv.hidden', { col: id }) : id));
          return message('warn', t('recv.existing', { table: p.dest, cols: added.join(', ') }));
        }));
        wizard.show(STEP.dest, body, [cancel, { label: t('recv.useExisting'), kind: 'btn-primary', onClick: () => run(null, report, create) }]);
        return;
      }
      for (const p of plans) {
        await createReceivingTables({
          journal: p.journal, dest: p.dest,
          columns: p.tb.columns.map(c => ({ id: c.id, type: c.type, label: c.label, isFormula: false })),
          note: { id: invitation.id, name: invitation.name, table: p.tb.table, secret: invitation.secret, from: invitation.from },
        });
      }
      wizard.show(STEP.link, message('info', t('recv.publishing')), []);
      await renderTarget(); // publie les formulaires ; le cadre est en général recréé ici
    };
    const body = [
      message('ok', t('recv.invite.summary', { name: invitation.name, n: invitation.tables.length, tables: invitation.tables.map(tb => tb.table).join(', ') })),
      from ? el('p', { class: 'small' }, t('recv.from', { from })) : null,
      known, el('label', {}, t('recv.dest')),
      ...invitation.tables.map((tb, i) => el('div', { class: 'dest-row' }, el('span', {}, `${tb.table} →`), inputs[i])),
      report,
    ];
    wizard.show(STEP.dest, body, [cancel, { label: t('recv.create'), kind: 'btn-primary', onClick: () => run(null, report, create) }]);
  }

  // 3. Lien du formulaire : un seul lien sert pour toutes les tables de l'envoi.
  async function showLink(g) {
    const page = (await formPages()).get(g.pairs[0].journal);
    const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('recv.link.title') });
    const report = el('div', { class: 'report' });
    const help = page && !page.samePage ? t('recv.link.help.other', { page: page.name }) : t('recv.link.help');
    wizard.show(STEP.link, [el('p', {}, help), input, report],
      [{ label: t('common.later') }, { label: t('recv.link.check'), kind: 'btn-primary', onClick: () => run(null, report, () => check(g, input.value)) }]);
  }

  async function check(g, link) {
    if (!parseFormLink(link)) throw new Error('formLink');
    const links = g.pairs.map(pair => ({ table: pair.table, url: buildWebhookUrl(link, pair.journal) }));
    for (const l of links) await testUrl(l.url);
    const identity = await docIdentity();
    const code = buildReply({
      id: g.id, secret: g.secret, links,
      recipient: { email: await myEmail(g.pairs[0].journal), docId: identity.docId, team: identity.team, at: new Date().toISOString().slice(0, 16).replace('T', ' ') },
    });
    // 4. Réponse à renvoyer.
    wizard.show(STEP.reply, [message('ok', t('recv.link.ok')), el('p', {}, t('recv.reply.help')), copyField(code)],
      [{ label: t('common.close'), kind: 'btn-primary' }]);
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
  return ((await fetchRows(journal)).find(r => r.id === id) || {})[AUTHOR_COL] || '';
}
