// Onglet « Recevoir » (document CIBLE) : accepter une invitation (Journal, table de destination,
// formulaire de réception), produire le code de réponse, puis consolider chaque Journal dans sa
// table de destination tant que la page est ouverte par un éditeur.
import {
  APPLIED_COL, AUTHOR_COL, KEY_COL, LIST_COL, buildReply, buildWebhookUrl, copyColumns, expandRows, parseFormLink, parseInvitation,
  exportTableId, listTableId, planConsolidation, planPull, planPurge, recentChanges, sentColumns, toTableId,
} from './core.js';
import { apply, collapseForms, docIdentity, ensureForm, fetchRows, formPages, readSchema } from './grist.js';
import {
  JOURNAL_PREFIX, addDestColumnsActions, createReceivingTables, destColumns, readNote, receivedTables, removeTechnicalTables,
  upgradeJournal, writeNote,
} from './tables.js';
import { confirmDialog, copyField, el, icon, message, openModal, openWizard, pickField, run } from './ui.js';
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
// La note du journal donne les noms de colonnes choisis (`map`), la colonne de rattachement
// (`match`) et la colonne qui nomme les lignes dans l'historique (`label`).
// Lien public : lit la vue d'export et la liste de la SOURCE sans identifiant, et ajoute au
// Journal ce qui a changé, comme l'aurait fait un webhook.
async function pull(note, journal) {
  const read = async (tableId) => {
    let response;
    try {
      response = await fetch(`${note.base}/tables/${encodeURIComponent(tableId)}/records`, { credentials: 'omit' });
    } catch (e) {
      throw new Error('publicClosed');
    }
    if (!response.ok) throw new Error('publicClosed');
    return (await response.json()).records || [];
  };
  const [records, list] = await Promise.all([read(exportTableId(note.table)), read(listTableId(note.table))]);
  let schema = [];
  try { schema = JSON.parse(((list[0] || {}).fields || {}).Synchro_Colonnes || '[]') || []; } catch (e) { /* liste sans colonnes */ }
  await apply(planPull({ records, schema, journalRows: await fetchRows(journal), journalTable: journal }));
}

// Une colonne nouvelle dans la vue d'export de la SOURCE est d'abord ajoutée à la destination.
async function consolidate(schema, { journal, dest }) {
  const note = readNote(schema, journal) || {};
  if (note.mode === 'public') await pull(note, journal);
  const journalRows = expandRows(await fetchRows(journal));
  const sent = sentColumns(journalRows, note.columns || []);
  const added = addDestColumnsActions(schema, dest, sent, note.map);
  if (added.length) {
    await apply(added);
    schema = await readSchema();
  }
  const destRows = await fetchRows(dest);
  // Journal d'avant la vue d'export : les colonnes envoyées sont celles du Journal.
  const from = sent.length ? sent.map(c => ({ colId: c.id })) : schema.columns(journal);
  const copyCols = copyColumns(from, schema.columns(dest), note.map);
  const { actions, stats } = planConsolidation({
    journalRows, destRows, copyCols, destTable: dest, journalTable: journal, matchCol: note.match || '',
  });
  const writes = [...actions, ...planPurge(journalRows, journal)];
  await apply(writes);
  const after = writes.length ? expandRows(await fetchRows(journal)) : journalRows;
  const labelCol = copyCols.some(([from]) => from === note.label) ? note.label : (copyCols[0] || [])[0];
  return { ...stats, rows: after.length, labelCol, labelCols: copyCols.map(([c]) => c), recent: recentChanges(after, labelCol, lastVisit, HISTORY_MAX) };
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
      for (const pair of receivedTables(schema)) upgraded = (await upgradeJournal(schema, pair.journal)) || upgraded;
      if (upgraded) schema = await readSchema();
      for (const pair of receivedTables(schema)) {
        const before = results.get(pair.journal);
        const at = Date.now() / 1000;
        try {
          const stats = await consolidate(schema, pair);
          results.set(pair.journal, { at, text: summary(stats), rows: stats.rows, recent: stats.recent, labelCol: stats.labelCol, labelCols: stats.labelCols });
          changed ||= stats.added + stats.updated + stats.removed > 0 || !before || Boolean(before.error || !before.rows !== !stats.rows);
          readOnly = false;
        } catch (e) {
          readOnly = /access|denied|blocked|permission/i.test(e.message);
          const key = `error.${e.message}`;
          results.set(pair.journal, { ...before, at, text: t(key) === key ? e.message : t(key), error: true });
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
      groups.set(key, {
        id: note.id, name: note.name || pair.dest, secret: note.secret || '', from: note.from || {}, pairs: [],
        public: note.mode === 'public', waiting: note.mode !== 'public',
      });
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
    group.public ? el('p', { class: 'muted small' }, t('recv.public')) : null,
    group.pairs.map(line),
    group.waiting ? null : history(group),
    el('div', { class: 'card-actions' },
      group.public ? null : el('button', { class: `btn btn-small ${group.waiting ? 'btn-primary' : ''}`, type: 'button', disabled: readOnly, onclick: () => receiveWizard(group) },
        icon('paste'), t(group.waiting ? 'recv.action.continue' : 'recv.action.link')),
      el('button', { class: 'btn btn-small btn-danger-text', type: 'button', disabled: readOnly, onclick: () => stopReceiving(group) },
        icon('trash'), t('recv.action.stop'))));
}

// Arrêter de recevoir : efface les journaux (et leurs formulaires, donc la clé d'écriture) ; les
// tables de destination et leurs lignes restent.
async function stopReceiving(group) {
  const ok = await confirmDialog({
    title: t('recv.stop.title', { name: group.name }), body: t('recv.stop.body', { tables: group.pairs.map(p => p.journal).join(', ') }),
    confirmLabel: t('recv.action.stop'), danger: true,
  });
  if (!ok) return;
  await removeTechnicalTables(group.pairs.map(p => p.journal));
  for (const p of group.pairs) results.delete(p.journal);
  await renderTarget();
}

// Dernières lignes reçues depuis la visite précédente (toutes les tables de l'envoi), au plus 20,
// nommées par la colonne choisie pour chaque table.
function history(group) {
  const items = group.pairs.flatMap(p => ((results.get(p.journal) || {}).recent || []).map(c => ({ ...c, dest: p.dest })))
    .sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX);
  const choose = el('button', { class: 'btn btn-small', type: 'button', disabled: readOnly, onclick: () => labelDialog(group) }, t('recv.label.change'));
  if (!items.length) return el('p', { class: 'muted small' }, t('recv.history.none'));
  const title = t(lastVisit ? 'recv.history.since' : 'recv.history.last', { n: items.length });
  return el('details', { class: 'history' }, el('summary', { class: 'small' }, title),
    el('ul', { class: 'small' }, items.map(c => el('li', {},
      `${new Date(c.at * 1000).toLocaleString()} · ${c.dest} · ${c.label || '—'} · ${t(`recv.history.${c.state}`)}`))),
    choose);
}

// Colonne qui nomme les lignes dans l'historique, par table reçue (notée dans le journal).
async function labelDialog(group) {
  const schema = await readSchema();
  const pickers = group.pairs.map((pair) => {
    const note = readNote(schema, pair.journal) || {};
    const cols = (results.get(pair.journal) || {}).labelCols || [];
    const current = (results.get(pair.journal) || {}).labelCol || cols[0];
    return { pair, note, field: pickField({ items: cols.map(c => ({ value: c, label: c })), value: current, label: pair.dest }) };
  });
  openModal({
    title: t('recv.label.title'), width: 400,
    body: [el('p', { class: 'small' }, t('recv.label.help')),
      ...pickers.map(p => el('div', { class: 'dest-row' }, el('span', {}, p.pair.dest), p.field))],
    buttons: [{ label: t('common.cancel') }, {
      label: t('common.save'), kind: 'btn-primary', onClick: async (m) => {
        for (const p of pickers) await writeNote(await readSchema(), p.pair.journal, { ...p.note, label: p.field.value() });
        m.close();
        results.clear();
        await consolidateAll();
      },
    }],
  });
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
      [cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, async () => {
        const invitation = parseInvitation(area.value);
        if (invitation.mode === 'public' && new URL(invitation.base).origin !== (await docIdentity()).origin) throw new Error('otherInstance');
        return showDest(invitation);
      }) }]);
  }

  // 2. Destinations : une par table reçue, nouvelle ou existante (liste filtrable). Une table
  // existante passe ensuite par la correspondance des colonnes et le rattachement des lignes.
  async function showDest(invitation) {
    const schema = await readSchema();
    const tables = schema.tableIds.filter(id => !id.startsWith(JOURNAL_PREFIX) && !id.startsWith('Synchro_'));
    const rows = invitation.tables.map((tb) => {
      const name = el('input', { type: 'text', class: 'input', value: toTableId(tb.table), 'aria-label': t('recv.dest.name', { table: tb.table }) });
      const field = pickField({
        label: tb.table, value: '',
        items: [{ value: '', label: t('recv.dest.new') }, ...tables.map(id => ({ value: id, label: id }))],
        onChange: (v) => { name.classList.toggle('hidden', v !== ''); },
      });
      return { tb, field, name };
    });
    const report = el('div', { class: 'report' });
    const from = invitation.from.email;
    const next = async () => {
      const now = await readSchema();
      const plans = rows.map(({ tb, field, name }) => {
        const dest = field.value() || toTableId(name.value, tb.table);
        return { tb, dest, journal: JOURNAL_PREFIX + dest, existing: now.has(dest) };
      });
      if (new Set(plans.map(p => p.dest)).size !== plans.length || plans.some(p => now.has(p.journal))) throw new Error('destTaken');
      if (plans.some(p => p.existing)) return showColumns(invitation, plans, now);
      return create(invitation, plans);
    };
    wizard.show(STEP.dest, [
      message('ok', t('recv.invite.summary', { name: invitation.name, n: invitation.tables.length, tables: invitation.tables.map(tb => tb.table).join(', ') })),
      from ? el('p', { class: 'small' }, t('recv.from', { from })) : null,
      el('label', {}, t('recv.dest')),
      ...rows.map(r => el('div', { class: 'dest-row' }, el('span', {}, `${r.tb.table} →`), el('div', {}, r.field, r.name))),
      report,
    ], [cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
  }

  // 2 bis. Table existante : colonne qui reçoit chaque colonne envoyée (la même, une autre, ou une
  // nouvelle), et colonne commune qui rattache les lignes déjà là au lieu de les doubler.
  function showColumns(invitation, plans, schema) {
    const report = el('div', { class: 'report' });
    const blocks = plans.filter(p => p.existing).map((p) => {
      const destCols = schema.columns(p.dest).filter(c => !c.isFormula && c.colId !== KEY_COL).map(c => c.colId);
      const sent = destColumns(p.tb.columns).filter(c => c.id !== KEY_COL);
      const maps = sent.map(c => ({
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
      p.read = () => {
        const map = Object.fromEntries(maps.map(m => [m.id, m.field.value() || m.id]));
        const targets = Object.values(map);
        if (new Set(targets).size !== targets.length) throw new Error('mapTwice');
        if (match.value() && !targets.includes(match.value())) throw new Error('matchUnmapped');
        p.map = map;
        p.match = match.value();
      };
      return el('div', { class: 'form' },
        el('h3', {}, `${p.tb.table} → ${p.dest}`),
        ...maps.map(m => el('div', { class: 'dest-row' }, el('span', {}, `${m.id} →`), m.field)),
        el('label', {}, t('recv.match')), match,
        el('p', { class: 'muted small' }, t('recv.match.help')));
    });
    wizard.show(STEP.dest, [el('p', {}, t('recv.existing')), ...blocks, report], [
      { label: t('common.back'), onClick: () => showDest(invitation) },
      { label: t('recv.create'), kind: 'btn-primary', onClick: () => run(null, report, () => { plans.forEach(p => p.read && p.read()); return create(invitation, plans); }) },
    ]);
  }

  async function create(invitation, plans) {
    for (const p of plans) {
      await createReceivingTables({
        journal: p.journal, dest: p.dest, map: p.map,
        columns: p.tb.columns,
        note: {
          id: invitation.id, name: invitation.name, table: p.tb.table, secret: invitation.secret, from: invitation.from, columns: p.tb.columns,
          ...(p.map ? { map: p.map } : {}), ...(p.match ? { match: p.match } : {}),
          ...(invitation.mode === 'public' ? { mode: 'public', base: invitation.base } : {}),
        },
      });
    }
    if (invitation.mode === 'public') {
      wizard.show(STEP.reply, message('ok', t('recv.public.done')), [{ label: t('common.close'), kind: 'btn-primary' }]);
      consolidateAll();
      return;
    }
    wizard.show(STEP.link, message('info', t('recv.publishing')), []);
    await renderTarget(); // publie les formulaires ; le cadre est en général recréé ici
  }

  // 3. Lien du formulaire : un seul lien sert pour toutes les tables de l'envoi.
  async function showLink(g) {
    const page = (await formPages()).get(g.pairs[0].journal);
    const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('recv.link.title') });
    const report = el('div', { class: 'report' });
    const help = page && !page.samePage ? t('recv.link.help.other', { page: page.name }) : t('recv.link.help');
    const figure = (text, src) => el('figure', { class: 'help-figure' }, el('figcaption', {}, text), el('img', { src, alt: '' }));
    wizard.show(STEP.link, [el('p', {}, help),
      figure(t('recv.link.step1'), 'img/aide-partager.png'), figure(t('recv.link.step2'), 'img/aide-copier.png'), input, report],
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
