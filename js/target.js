// Onglet « Recevoir » (document CIBLE) : accepter une invitation (un journal par export, ses
// tables de destination, le formulaire de réception), produire le code de réponse, puis recopier
// chaque journal dans ses tables de destination tant que la page est ouverte par un éditeur.
// Une table que la SOURCE ajoute à l'export arrive dans le même journal : une fenêtre demande où
// la ranger.
import {
  APPLIED_COL, AUTHOR_COL, EXPORT_COL, KEY_COL, KIND, LIST_COL, SYNC_TABLE, TYPE_COL, buildReply, buildWebhookUrl, copyColumns, expandRows,
  freeTableId, parseFormLink, parseInvitation, planConsolidation, planPull, planPurge, planUnpack, recentChanges, rowsByTable, sentColumns, toTableId,
} from './core.js';
import { apply, collapseForms, docIdentity, dropPages, ensureForm, fetchRows, formPages, readSchema } from './grist.js';
import {
  JOURNAL_PREFIX, addDestColumnsActions, createJournal, destColumns, legacyJournals, prepareDest, readNote, receivedDests, receivedJournals,
  removeTechnicalTables, upgradeJournal, writeNote,
} from './tables.js';
import { confirmDialog, copyButton, copyField, el, icon, message, openModal, openWizard, pickField, run } from './ui.js';
import { handoffText, roleGuide } from './guide.js';
import { stepHelp } from './tutorial.js';
import { t } from './i18n.js';
import { readPref, writePref } from './prefs.js';

const POLL_MS = 10000;
const HISTORY_MAX = 20;
// Dernier passage : par journal ({ at, error, text, rows }) et par table reçue (clé
// `journal|table` : { at, text, error, recent, labelCol, labelCols }) ; tables proposées par
// journal ([{ table, columns, n }]).
const results = new Map();
const offers = new Map();
let container;
let busy = false;
let readOnly = false;
let lastVisit = null; // date de la visite précédente sur ce document (secondes), ou 0
let wizardOpened = false; // l'assistant ne se rouvre seul qu'une fois par chargement
const offered = new Set(); // tables déjà proposées en fenêtre pendant ce chargement

const tableKey = (journal, table) => `${journal}|${table}`;

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

// Lien public : lit les instantanés de l'export dans la table Synchro de la SOURCE, sans
// identifiant, et ajoute au journal ce qui a changé, comme l'aurait fait un webhook.
async function pull(note, journal) {
  const filter = encodeURIComponent(JSON.stringify({ [EXPORT_COL]: [note.export], [TYPE_COL]: [KIND.full] }));
  let response;
  try {
    response = await fetch(`${note.base}/tables/${SYNC_TABLE}/records?filter=${filter}`, { credentials: 'omit' });
  } catch (e) {
    throw new Error('publicClosed');
  }
  if (!response.ok) throw new Error('publicClosed');
  const records = (await response.json()).records || [];
  await apply(planPull({ records, journalRows: await fetchRows(journal), journalTable: journal }));
}

// Un passage sur un journal : déplier ce qui est arrivé, recopier chaque table rangée dans sa
// destination (une colonne nouvelle y est d'abord ajoutée), noter les tables proposées, nettoyer.
// Chaque étape est un seul lot d'écritures, donc tout ou rien.
async function consolidate(schema, { journal, note }) {
  if (note.mode === 'public') await pull(note, journal);
  let rows = await fetchRows(journal);
  const unpack = planUnpack(rows, journal);
  if (unpack.actions.length) {
    await apply(unpack.actions);
    const missing = { ...note.missing };
    for (const table of unpack.resent) delete missing[table];
    for (const [table, n] of Object.entries(unpack.missing)) if (n > 0) missing[table] = (missing[table] || 0) + n;
    if (JSON.stringify(missing) !== JSON.stringify(note.missing || {})) {
      note = { ...note, missing };
      await writeNote(schema, journal, note);
    }
    rows = await fetchRows(journal);
  }
  const groups = rowsByTable(expandRows(rows));
  const known = new Set(note.tables.map(tb => tb.table));
  const pending = [...groups.keys()].filter(table => !known.has(table) && !note.refused.includes(table));
  offers.set(journal, pending.map((table) => {
    const tableRows = groups.get(table);
    return { table, columns: sentColumns(tableRows, []), n: new Set(tableRows.map(r => r[KEY_COL]).filter(Boolean)).size };
  }).filter(o => o.columns.length));

  const tables = [];
  for (const entry of note.tables) {
    const tableRows = groups.get(entry.table) || [];
    if (!schema.has(entry.dest)) {
      tables.push({ entry, error: t('error.destMissing', { dest: entry.dest }) });
      continue;
    }
    const sent = sentColumns(tableRows, entry.columns || []);
    const added = addDestColumnsActions(schema, entry.dest, sent, entry.map);
    if (added.length) {
      await apply(added);
      schema = await readSchema();
    }
    const copyCols = copyColumns(sent.map(c => ({ colId: c.id })), schema.columns(entry.dest), entry.map);
    const { actions, stats } = planConsolidation({
      journalRows: tableRows, destRows: await fetchRows(entry.dest), copyCols, destTable: entry.dest, journalTable: journal, matchCol: entry.match || '',
    });
    await apply(actions);
    tables.push({ entry, stats, copyCols });
  }
  const after = await fetchRows(journal);
  await apply(planPurge(after, journal, { keep: pending, drop: note.refused }));
  const afterGroups = rowsByTable(expandRows(after));
  return {
    rows: after.length, note,
    tables: tables.map(({ entry, stats, copyCols, error }) => {
      if (error) return { table: entry.table, error };
      const labelCol = copyCols.some(([from]) => from === entry.label) ? entry.label : (copyCols[0] || [])[0];
      return { table: entry.table, stats, labelCol, labelCols: copyCols.map(([c]) => c), recent: recentChanges(afterGroups.get(entry.table) || [], labelCol, lastVisit, Infinity) };
    }),
  };
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
      let schema = await readSchema();
      let upgraded = false;
      for (const { journal } of receivedJournals(schema)) upgraded = (await upgradeJournal(schema, journal)) || upgraded;
      if (upgraded) schema = await readSchema();
      for (const received of receivedJournals(schema)) {
        const { journal } = received;
        const before = results.get(journal);
        const offersBefore = JSON.stringify(offers.get(journal) || []);
        const at = Date.now() / 1000;
        try {
          const pass = await consolidate(schema, received);
          results.set(journal, { at, rows: pass.rows, missing: pass.note.missing });
          for (const tb of pass.tables) {
            const key = tableKey(journal, tb.table);
            const was = results.get(key);
            results.set(key, tb.error ? { at, error: true, text: tb.error } : { at, text: summary(tb.stats), ...tb });
            changed ||= Boolean(tb.error) !== Boolean(was && was.error) || Boolean(tb.stats && tb.stats.added + tb.stats.updated + tb.stats.removed);
          }
          changed ||= !before || Boolean(before.error) || !before.rows !== !pass.rows || JSON.stringify(before.missing) !== JSON.stringify(pass.note.missing)
            || offersBefore !== JSON.stringify(offers.get(journal) || []);
          readOnly = false;
          schema = await readSchema();
        } catch (e) {
          readOnly = /access|denied|blocked|permission/i.test(e.message);
          const key = `error.${e.message}`;
          results.set(journal, { ...before, at, text: t(key) === key ? e.message : t(key), error: true });
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
// Tableau de bord : une carte par export reçu. Un journal encore vide attend son lien.

async function receivedGroups(schema) {
  const groups = [];
  for (const { journal, note } of receivedJournals(schema)) {
    const known = results.get(journal);
    const rows = known ? known.rows : (await fetchRows(journal)).length;
    groups.push({ journal, note, public: note.mode === 'public', waiting: note.mode !== 'public' && !rows });
  }
  return groups;
}

export async function renderTarget(root = container) {
  container = root;
  const schema = await readSchema();
  const groups = await receivedGroups(schema);
  // Formulaire des exports en attente, publié sur la page du widget (une seule clé de partage).
  // Grist recrée alors le cadre du widget : l'assistant se rouvre à l'étape Lien au chargement.
  try {
    for (const group of groups.filter(g => g.waiting)) await ensureForm(group.journal);
  } catch (e) {
    readOnly = true; // un lecteur ne peut pas publier le formulaire
  }
  const legacy = legacyJournals(schema);
  const out = el('div', { class: 'out' });
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: readOnly, onclick: () => receiveWizard() }, icon('plus'), t('recv.new')),
    el('button', { class: 'btn', type: 'button', disabled: readOnly || !groups.length, onclick: e => run(e.currentTarget, out, () => consolidateAll()) }, icon('refresh'), t('recv.action.sync')));
  const cards = groups.map(syncCard);
  if (legacy.length) cards.push(legacyCard(legacy, out));
  container.replaceChildren(...[toolbar,
    readOnly ? message('warn', t('common.readonly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards, el('p', { class: 'muted small' }, t('recv.auto'))) : el('p', { class: 'muted' }, t('recv.empty')),
    roleGuide({ you: 'target', open: !cards.length })].filter(Boolean));
  if (readOnly) return;
  // Les journaux qui reçoivent déjà n'ont plus besoin de leur formulaire à l'écran.
  collapseForms(groups.filter(g => !g.waiting).map(g => g.journal)).catch(() => {});
  dropPages(groups.map(g => g.journal)).catch(() => {});
  const waiting = groups.find(g => g.waiting);
  if (waiting && !wizardOpened) {
    wizardOpened = true;
    receiveWizard(waiting);
    return;
  }
  // Une table ajoutée par la SOURCE : la fenêtre s'ouvre une fois par chargement.
  for (const group of groups) {
    const offer = (offers.get(group.journal) || []).find(o => !offered.has(tableKey(group.journal, o.table)));
    if (offer && !document.querySelector('.scrim')) {
      offered.add(tableKey(group.journal, offer.table));
      offerDialog(group, offer);
      return;
    }
  }
}

function syncCard(group) {
  const { journal, note } = group;
  const journalResult = results.get(journal) || {};
  const failed = journalResult.error || note.tables.some(tb => (results.get(tableKey(journal, tb.table)) || {}).error);
  const [status, tone] = group.waiting ? ['waiting', 'pending'] : failed ? ['error', 'err'] : ['ok', 'ok'];
  const line = (entry) => {
    const result = results.get(tableKey(journal, entry.table)) || (journalResult.error ? journalResult : null);
    // Le détail des changements est dans l'historique : la ligne ne garde que l'heure, ou l'erreur.
    const when = result && !group.waiting ? ` · ${new Date(result.at * 1000).toLocaleTimeString()}${result.error ? ` · ${result.text}` : ''}` : '';
    return el('p', { class: `small ${result && result.error ? 'text-danger' : 'muted'}` }, `${entry.table} → ${entry.dest}${when}`);
  };
  const from = (note.from || {}).email;
  const pending = offers.get(journal) || [];
  return el('article', { class: 'card', 'data-journal': journal },
    el('div', { class: 'card-head' }, el('strong', {}, note.name), el('span', { class: `pill pill-${tone}` }, t(`recv.status.${status}`))),
    from ? el('p', { class: 'small' }, t('recv.from', { from })) : null,
    group.public ? el('p', { class: 'muted small' }, t('recv.public')) : null,
    note.tables.map(line),
    Object.entries(note.missing || {}).map(([table, n]) => message('warn', t('recv.missing', { table, n }))),
    pending.map(o => el('div', { class: 'offer' }, el('span', { class: 'small' }, t('recv.offer.line', { table: o.table, n: o.n })),
      el('button', { class: 'btn btn-small btn-primary', type: 'button', disabled: readOnly, onclick: () => offerDialog(group, o) }, t('recv.offer.place')))),
    note.refused.length ? el('p', { class: 'muted small' }, t('recv.offer.refusedList', { tables: note.refused.join(', ') })) : null,
    group.waiting ? null : history(group),
    el('div', { class: 'card-actions' },
      group.public ? null : el('button', { class: `btn btn-small ${group.waiting ? 'btn-primary' : ''}`, type: 'button', disabled: readOnly, onclick: () => receiveWizard(group) },
        icon('paste'), t(group.waiting ? 'recv.action.continue' : 'recv.action.link')),
      el('button', { class: 'btn btn-small btn-danger-text', type: 'button', disabled: readOnly, onclick: () => stopReceiving(group) },
        icon('trash'), t('recv.action.stop'))));
}

// Réceptions d'avant la version 0.4 (un journal par table) : à refaire avec la SOURCE.
function legacyCard(journals, out) {
  return el('article', { class: 'card' },
    el('div', { class: 'card-head' }, el('strong', {}, t('recv.legacy.title')), el('span', { class: 'pill pill-pending' }, t('send.status.legacy'))),
    el('p', { class: 'small' }, t('recv.legacy.body', { tables: journals.join(', ') })),
    el('div', { class: 'card-actions' }, el('button', {
      class: 'btn btn-small btn-danger-text', type: 'button', disabled: readOnly,
      onclick: e => run(e.currentTarget, out, async () => { await removeTechnicalTables(journals); await renderTarget(); }),
    }, icon('trash'), t('recv.legacy.clean'))));
}

// Arrêter de recevoir : efface le journal (et son formulaire, donc la clé d'écriture) ; les tables
// de destination et leurs lignes restent.
async function stopReceiving(group) {
  const ok = await confirmDialog({
    title: t('recv.stop.title', { name: group.note.name }), body: t('recv.stop.body', { tables: group.journal }),
    confirmLabel: t('recv.action.stop'), danger: true,
  });
  if (!ok) return;
  await removeTechnicalTables([group.journal]);
  for (const key of [...results.keys()]) if (key === group.journal || key.startsWith(`${group.journal}|`)) results.delete(key);
  offers.delete(group.journal);
  await renderTarget();
}

// Lignes changées depuis la visite précédente, par table de destination : compteurs par état
// (ajoutées, modifiées, supprimées), puis les plus récentes (HISTORY_MAX par table), nommées par
// la colonne choisie pour chaque table.
const STATES = ['ajout', 'modif', 'suppression'];
const STATE_ICON = { ajout: 'plus', modif: 'edit', suppression: 'minus' };

function stateCounts(items) {
  return el('span', { class: 'history-counts' }, STATES.map((state) => {
    const n = items.filter(c => c.state === state).length;
    return n ? el('span', { class: `chg chg-${state}` }, icon(STATE_ICON[state]), t(`recv.history.n.${state}`, { n })) : null;
  }));
}

function when(at) {
  const date = new Date(at * 1000);
  const today = date.toDateString() === new Date().toDateString();
  return today ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function history(group) {
  const tables = group.note.tables.map(tb => ({ dest: tb.dest, items: (results.get(tableKey(group.journal, tb.table)) || {}).recent || [] }));
  const all = tables.flatMap(tb => tb.items);
  if (!all.length) return el('p', { class: 'muted small' }, t('recv.history.none'));
  const block = ({ dest, items }) => (items.length ? el('section', { class: 'history-table' },
    el('div', { class: 'history-head' }, el('strong', {}, dest), stateCounts(items)),
    el('ul', { class: 'history-rows' }, items.slice(0, HISTORY_MAX).map(c => el('li', { class: `chg-row chg-${c.state}` },
      el('span', { class: 'chg-dot', title: t(`recv.history.${c.state}`) }, icon(STATE_ICON[c.state])),
      el('span', { class: 'chg-label' }, c.label || '—'),
      el('span', { class: 'chg-state' }, t(`recv.history.${c.state}`)),
      el('time', { class: 'chg-time', datetime: new Date(c.at * 1000).toISOString() }, when(c.at))))),
    items.length > HISTORY_MAX ? el('p', { class: 'muted small' }, t('recv.history.more', { n: items.length - HISTORY_MAX })) : null) : null);
  return el('details', { class: 'history', open: true },
    el('summary', {}, el('span', { class: 'history-title' }, t(lastVisit ? 'recv.history.since' : 'recv.history.last')), stateCounts(all)),
    tables.map(block),
    el('button', { class: 'btn btn-small btn-link', type: 'button', disabled: readOnly, onclick: () => labelDialog(group) }, t('recv.label.change')));
}

// Colonne qui nomme les lignes dans l'historique, par table reçue (notée dans le journal).
async function labelDialog(group) {
  const pickers = group.note.tables.map((entry) => {
    const result = results.get(tableKey(group.journal, entry.table)) || {};
    const cols = result.labelCols || [];
    return { entry, field: pickField({ items: cols.map(c => ({ value: c, label: c })), value: result.labelCol || cols[0], label: entry.dest }) };
  });
  openModal({
    title: t('recv.label.title'), width: 400,
    body: [el('p', { class: 'small' }, t('recv.label.help')),
      ...pickers.map(p => el('div', { class: 'dest-row' }, el('span', {}, p.entry.dest), p.field))],
    buttons: [{ label: t('common.cancel') }, {
      label: t('common.save'), kind: 'btn-primary', onClick: async (m) => {
        await updateJournalNote(group.journal, note => ({
          ...note, tables: note.tables.map(tb => ({ ...tb, label: (pickers.find(p => p.entry.table === tb.table) || {}).field.value() })),
        }));
        m.close();
        results.clear();
        await consolidateAll();
      },
    }],
  });
}

async function updateJournalNote(journal, change) {
  const schema = await readSchema();
  await writeNote(schema, journal, change(readNote(schema, journal)));
}

// ---------------------------------------------------------------------------------------------
// Destination d'une table reçue : nouvelle (nom libre) ou existante (liste filtrable). Une table
// existante passe ensuite par la correspondance des colonnes et le rattachement des lignes.

function destField(schema, table) {
  const tables = schema.tableIds.filter(id => !id.startsWith(JOURNAL_PREFIX) && id !== SYNC_TABLE && !id.startsWith('Synchro_'));
  const name = el('input', { type: 'text', class: 'input', value: toTableId(table), 'aria-label': t('recv.dest.name', { table }) });
  const field = pickField({
    label: table, value: '',
    items: [{ value: '', label: t('recv.dest.new') }, ...tables.map(id => ({ value: id, label: id }))],
    onChange: (v) => { name.classList.toggle('hidden', v !== ''); },
  });
  return { node: el('div', {}, field, name), dest: () => field.value() || toTableId(name.value, table) };
}

// Colonne qui reçoit chaque colonne envoyée (la même, une autre, ou une nouvelle), et colonne
// commune qui rattache les lignes déjà là au lieu de les doubler. `read()` rend { map, match }.
function mappingBlock(schema, table, dest, columns) {
  const destCols = schema.columns(dest).filter(c => !c.isFormula && c.colId !== KEY_COL).map(c => c.colId);
  const maps = destColumns(columns).filter(c => c.id !== KEY_COL).map(c => ({
    id: c.id,
    field: pickField({
      label: c.id, value: destCols.includes(c.id) ? c.id : '',
      items: [...(destCols.includes(c.id) ? [] : [{ value: '', label: t('recv.col.new', { col: c.id }) }]), ...destCols.map(d => ({ value: d, label: d }))],
    }),
  }));
  const match = pickField({
    label: t('recv.match'), value: '',
    items: [{ value: '', label: t('recv.match.none') }, ...destCols.map(d => ({ value: d, label: d }))],
  });
  const node = el('div', { class: 'form' },
    el('h3', {}, `${table} → ${dest}`),
    ...maps.map(m => el('div', { class: 'dest-row' }, el('span', {}, `${m.id} →`), m.field)),
    el('label', {}, t('recv.match')), match,
    el('p', { class: 'muted small' }, t('recv.match.help')));
  const read = () => {
    const map = Object.fromEntries(maps.map(m => [m.id, m.field.value() || m.id]));
    const targets = Object.values(map);
    if (new Set(targets).size !== targets.length) throw new Error('mapTwice');
    if (match.value() && !targets.includes(match.value())) throw new Error('matchUnmapped');
    return { map, match: match.value() };
  };
  return { node, read };
}

// Une destination ne reçoit qu'une table, d'un seul export. Copie dans le même document : une
// table ne peut pas se recevoir elle-même (`plans` : [{ table, dest }]).
async function checkDests(schema, plans, fromDocId) {
  const taken = receivedDests(schema).map(d => d.dest);
  const dests = plans.map(p => p.dest);
  if (new Set(dests).size !== dests.length || dests.some(d => taken.includes(d) || d.startsWith(JOURNAL_PREFIX))) throw new Error('destTaken');
  if (fromDocId && fromDocId === (await docIdentity()).docId && plans.some(p => p.dest === p.table)) throw new Error('loop');
}

// ---------------------------------------------------------------------------------------------
// Table ajoutée par la SOURCE à un export reçu : la ranger (nouvelle table ou existante), la
// refuser (ses lignes sont effacées du journal à mesure qu'elles arrivent), ou plus tard.

async function offerDialog(group, offer) {
  const schema = await readSchema();
  const pick = destField(schema, offer.table);
  const report = el('div', { class: 'report' });
  const step = el('div', { class: 'form' });
  const accept = async (entry, m) => {
    await prepareDest({ dest: entry.dest, columns: offer.columns, map: entry.map });
    await updateJournalNote(group.journal, note => ({ ...note, tables: [...note.tables, entry] }));
    m.close();
    await consolidateAll();
    await renderTarget();
  };
  const choose = async (m) => {
    const dest = pick.dest();
    await checkDests(schema, [{ table: offer.table, dest }], (group.note.from || {}).docId);
    const entry = { table: offer.table, dest, columns: offer.columns };
    if (!schema.has(dest)) return accept(entry, m);
    const mapping = mappingBlock(schema, offer.table, dest, offer.columns);
    step.replaceChildren(el('p', {}, t('recv.existing')), mapping.node);
    m.setButtons([{ label: t('common.back'), onClick: () => { step.replaceChildren(first); m.setButtons(buttons); } },
      { label: t('recv.offer.accept'), kind: 'btn-primary', onClick: mm => run(null, report, () => {
        const { map, match } = mapping.read();
        return accept({ ...entry, map, ...(match ? { match } : {}) }, mm);
      }) }]);
    return null;
  };
  const first = el('div', { class: 'form' },
    message('info', t('recv.offer.body', { name: group.note.name, table: offer.table, n: offer.n, cols: offer.columns.map(c => c.id).join(', ') })),
    el('label', {}, t('recv.offer.where')), pick.node, stepHelp(['t-offer']));
  step.replaceChildren(first);
  const buttons = [
    { label: t('common.later') },
    { label: t('recv.offer.refuse'), kind: 'btn-danger-text', onClick: m => run(null, report, async () => {
      await updateJournalNote(group.journal, note => ({ ...note, refused: [...(note.refused || []), offer.table] }));
      m.close();
      await consolidateAll();
      await renderTarget();
    }) },
    { label: t('recv.offer.accept'), kind: 'btn-primary', onClick: m => run(null, report, () => choose(m)) },
  ];
  openModal({ title: t('recv.offer.title', { table: offer.table }), body: [step, report], buttons });
}

// ---------------------------------------------------------------------------------------------
// Assistant de réception : Code, Destinations, Lien, Réponse. Un export en attente (ou à
// rebrancher) l'ouvre directement à l'étape Lien (`group`).

const STEP = { code: 0, dest: 1, link: 2, reply: 3 };

function receiveWizard(group = null) {
  const wizard = openWizard({
    title: group ? group.note.name : t('recv.new'),
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
    wizard.show(STEP.code, [el('p', {}, t('recv.invite.help')), area, report, stepHelp(['t-code']), roleGuide({ you: 'target', current: 1 })],
      [cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, async () => {
        const invitation = parseInvitation(area.value);
        if (invitation.mode === 'public' && new URL(invitation.base).origin !== (await docIdentity()).origin) throw new Error('otherInstance');
        if (receivedJournals(await readSchema()).some(r => r.note.export === invitation.export)) throw new Error('alreadyReceived');
        return showDest(invitation);
      }) }]);
  }

  // 2. Destinations : une par table reçue.
  async function showDest(invitation) {
    const schema = await readSchema();
    const rows = invitation.tables.map(tb => ({ tb, pick: destField(schema, tb.table) }));
    const report = el('div', { class: 'report' });
    const from = invitation.from.email;
    const next = async () => {
      const now = await readSchema();
      const plans = rows.map(({ tb, pick }) => ({ tb, dest: pick.dest() }));
      await checkDests(now, plans.map(p => ({ table: p.tb.table, dest: p.dest })), invitation.from.docId);
      if (plans.some(p => now.has(p.dest))) return showColumns(invitation, plans, now);
      return create(invitation, plans);
    };
    wizard.show(STEP.dest, [
      message('ok', t('recv.invite.summary', { name: invitation.name, n: invitation.tables.length, tables: invitation.tables.map(tb => tb.table).join(', ') })),
      from ? el('p', { class: 'small' }, t('recv.from', { from })) : null,
      el('label', {}, t('recv.dest')),
      ...rows.map(r => el('div', { class: 'dest-row' }, el('span', {}, `${r.tb.table} →`), r.pick.node)),
      report, stepHelp(['t-dest']), roleGuide({ you: 'target', current: 1 }),
    ], [cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
  }

  // 2 bis. Tables existantes : correspondance des colonnes et rattachement.
  function showColumns(invitation, plans, schema) {
    const report = el('div', { class: 'report' });
    const blocks = plans.filter(p => schema.has(p.dest)).map(p => ({ p, block: mappingBlock(schema, p.tb.table, p.dest, p.tb.columns) }));
    wizard.show(STEP.dest, [el('p', {}, t('recv.existing')), ...blocks.map(b => b.block.node), report, stepHelp(['t-dest'])], [
      { label: t('common.back'), onClick: () => showDest(invitation) },
      { label: t('recv.create'), kind: 'btn-primary', onClick: () => run(null, report, () => {
        for (const { p, block } of blocks) Object.assign(p, block.read());
        return create(invitation, plans);
      }) },
    ]);
  }

  // Un journal pour l'export, nommé d'après lui, et une destination par table.
  async function create(invitation, plans) {
    const schema = await readSchema();
    const journal = freeTableId(JOURNAL_PREFIX + toTableId(invitation.name, 'Export'), schema.tableIds);
    const note = {
      id: invitation.id, export: invitation.export, name: invitation.name, secret: invitation.secret, from: invitation.from,
      ...(invitation.mode === 'public' ? { mode: 'public', base: invitation.base } : {}),
      tables: plans.map(p => ({ table: p.tb.table, dest: p.dest, columns: p.tb.columns, ...(p.map ? { map: p.map } : {}), ...(p.match ? { match: p.match } : {}) })),
      refused: [], missing: {},
    };
    for (const p of plans) await prepareDest({ dest: p.dest, columns: p.tb.columns, map: p.map });
    await createJournal(journal, note);
    if (invitation.mode === 'public') {
      wizard.show(STEP.reply, [message('ok', t('recv.public.done')), roleGuide({ you: 'target', mode: 'public', current: 1 })], [{ label: t('common.close'), kind: 'btn-primary' }]);
      consolidateAll();
      return;
    }
    wizard.show(STEP.link, message('info', t('recv.publishing')), []);
    await renderTarget(); // publie le formulaire ; le cadre est en général recréé ici
  }

  // 3. Lien du formulaire de réception.
  async function showLink(g) {
    const page = (await formPages()).get(g.journal);
    const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('recv.link.title') });
    const report = el('div', { class: 'report' });
    const where = page && !page.samePage ? t('recv.link.where.other', { page: page.name }) : t('recv.link.where');
    const figure = (text, src) => el('figure', { class: 'help-figure' }, el('figcaption', {}, text), el('img', { src, alt: '' }));
    wizard.show(STEP.link, [el('p', {}, t('recv.link.help', { where, n: g.note.tables.length })),
      figure(t('recv.link.step1'), 'img/aide-partager.png'), figure(t('recv.link.step2'), 'img/aide-copier.png'), input, report, roleGuide({ you: 'target', current: 2 })],
    [{ label: t('common.later') }, { label: t('recv.link.check'), kind: 'btn-primary', onClick: () => run(null, report, () => check(g, input.value)) }]);
  }

  async function check(g, link) {
    if (!parseFormLink(link)) throw new Error('formLink');
    const url = buildWebhookUrl(link, g.journal);
    await testUrl(url);
    const identity = await docIdentity();
    const code = buildReply({
      id: g.note.id, secret: g.note.secret, url,
      recipient: { email: await myEmail(g.journal), docId: identity.docId, team: identity.team, at: new Date().toISOString().slice(0, 16).replace('T', ' ') },
    });
    // 4. Réponse à renvoyer.
    wizard.show(STEP.reply, [message('ok', t('recv.link.ok')), el('p', {}, t('recv.reply.help')), copyField(code),
      el('div', { class: 'handoff' }, copyButton(() => handoffText('source', 'reponse', 3, code), t('guide.copyHandoff')),
        el('span', { class: 'muted small' }, t('guide.copyHandoff.help'))),
      roleGuide({ you: 'target', current: 3, open: true }), stepHelp(['t-reply', 's-reply', 's-load', 't-daily'])],
    [{ label: t('common.close'), kind: 'btn-primary' }]);
  }
}

// Envoie une ligne vide par la clé, comme le fera le webhook (le nettoyage du journal l'efface) :
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
// journal avec ses droits remplit la colonne Sync_Par (formule user.Email). Le nettoyage l'efface.
async function myEmail(journal) {
  const id = (await apply([['AddRecord', journal, null, { [APPLIED_COL]: true, [LIST_COL]: '' }]])).retValues[0];
  return ((await fetchRows(journal)).find(r => r.id === id) || {})[AUTHOR_COL] || '';
}
