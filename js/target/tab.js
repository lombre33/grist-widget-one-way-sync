// Onglet « Recevoir » (document CIBLE) : une carte par export reçu, avec ses tables, ce qui manque,
// les arrivées suspectes, les valeurs retouchées à la main et l'historique des changements. Un
// journal encore vide attend son lien.
import { isBlank } from '../logic/common.js';
import { REFUSED, STATES, awaitingPartner } from '../logic/journal.js';
import { FILE_MAX, fileList } from '../logic/files.js';
import { fetchRows, isOwner, isReadOnly, readSchema } from '../grist.js';
import { reloading, syncRules } from '../acl.js';
import { dropPages, ensureForm, formPages, removeTechnicalTables, renewFormLink } from '../pages.js';
import { closeExport } from '../exchange.js';
import { receivedJournals, receivedKey, updateJournalNote } from './journals.js';
import { SHOWN, consolidateAll, decide, decideWave, forgetJournal, isAccessError, restoreSource, state, tableKey } from './loop.js';
import { uploadErrors } from './files.js';
import { offerDialog } from './dest.js';
import { receiveWizard } from './wizard.js';
import { confirmDialog, el, errorText, icon, message, openModal, pickField, pill, run } from '../ui.js';
import { roleGuide } from '../guide.js';
import { LANG, dateText, t, timeText } from '../i18n.js';

const HISTORY_MAX = 20;
let container;
let wizardOpened = false; // l'assistant ne se rouvre seul qu'une fois par chargement
const offered = new Set(); // tables déjà proposées en fenêtre pendant ce chargement
// Historiques et lignes d'historique ouverts : repliés par défaut, ils le restent d'un dessin à
// l'autre de l'onglet (un passage qui change quelque chose le redessine).
const opened = new Set();
const keepOpen = id => e => (e.currentTarget.open ? opened.add(id) : opened.delete(id));

// Redessine l'onglet s'il est affiché (un passage de la recopie a changé quelque chose).
// Redessin périodique (après un passage) : il ne touche pas aux règles d'accès, dont le changement
// rechargerait le widget au milieu d'une action en cours (voir syncRules).
export async function refreshTarget() {
  if (container && container.isConnected) await renderTarget(container, { periodic: true });
}

// Réceptions à montrer. Le journal de retour d'un Échange se règle depuis l'onglet Envoyer : il
// n'attend jamais son lien ici. `shared` : autres formulaires atteints par la même clé.
// `owner` : la personne pose les règles d'accès elle-même (voir syncRules) ; sinon, un journal
// réservé aux éditeurs ne l'est qu'une fois qu'un propriétaire a ouvert la page (`reserved`).
async function receivedGroups(schema, owner) {
  const forms = await formPages();
  const groups = [];
  for (const { journal, note } of receivedJournals(schema).filter(r => !awaitingPartner(r.note))) {
    const known = state.results.get(journal);
    const rows = known ? known.rows : (await fetchRows(journal)).length;
    const waiting = note.mode !== 'public' && !note.retour && !rows;
    // Sans clé de signature jamais vue : réception d'avant la 0.8 (une clé perdue arrête la
    // recopie, voir sealing dans loop.js).
    const unsigned = note.mode !== 'public' && !note.sceau && !receivedKey(schema, journal, note);
    const unreserved = Boolean(note.reserve) && !note.reserved && !owner;
    groups.push({ journal, note, public: note.mode === 'public', waiting, unsigned, unreserved, shared: (forms.get(journal) || {}).shared || 0 });
  }
  return groups;
}

const button = (label, iconName, onclick, kind = '') => el('button', { class: `btn btn-small ${kind}`, type: 'button', disabled: state.readOnly, onclick }, icon(iconName), label);

export async function renderTarget(root = container, { periodic = false } = {}) {
  if (!container) state.viewer = isReadOnly();
  container = root;
  state.readOnly ||= state.viewer;
  // Règles d'accès du widget (journaux cachés aux lecteurs, Synchro d'un Échange réservée aux
  // propriétaires) : seul un propriétaire peut les poser.
  const owner = !state.readOnly && await isOwner().catch(() => true);
  if (!periodic && owner && await syncRules()) {
    reloading(container, renderTarget);
    return;
  }
  const schema = await readSchema();
  const groups = await receivedGroups(schema, owner || state.viewer);
  // Formulaire des exports en attente, chacun sur sa page.
  const out = el('div', { class: 'out' });
  try {
    for (const group of groups.filter(g => g.waiting)) await ensureForm(group.journal);
  } catch (e) {
    if (isAccessError(e)) state.readOnly = true; // un lecteur ne peut pas publier le formulaire
    else out.append(message('err', errorText(e)));
  }
  const sync = async () => { if ((await consolidateAll({ reread: true })) === false) out.replaceChildren(message('ok', t('recv.sync.none'))); };
  const toolbar = el('div', { class: 'toolbar' },
    el('button', { class: 'btn btn-primary', type: 'button', disabled: state.readOnly, onclick: () => receiveWizard(null, renderTarget) }, icon('plus'), t('recv.new')),
    el('button', { class: 'btn', type: 'button', disabled: state.readOnly || !groups.length, onclick: e => run(e.currentTarget, out, sync) }, icon('refresh'), t('recv.action.sync')));
  const cards = groups.map(safeCard);
  container.replaceChildren(...[toolbar,
    state.readOnly ? message('warn', t('common.readonly')) : null,
    out,
    cards.length ? el('div', { class: 'cards' }, cards, el('p', { class: 'muted small' }, t('recv.auto'))) : el('p', { class: 'muted' }, t(state.readOnly ? 'recv.emptyViewer' : 'recv.empty')),
    roleGuide({ you: 'target' })].filter(Boolean));
  if (!state.readOnly) await openPending(groups);
}

// Ouvre seul, une fois par chargement : l'assistant d'une réception qui attend son lien, sinon la
// fenêtre d'une table ajoutée par la SOURCE.
async function openPending(groups) {
  dropPages(groups.map(g => g.journal)).catch(() => {});
  if (document.querySelector('.scrim')) return;
  const waiting = groups.find(g => g.waiting);
  if (waiting && !wizardOpened) {
    wizardOpened = true;
    receiveWizard(waiting, renderTarget);
    return;
  }
  for (const group of groups) {
    const offer = (state.offers.get(group.journal) || []).find(o => !offered.has(tableKey(group.journal, o.table)));
    if (!offer) continue;
    offered.add(tableKey(group.journal, offer.table));
    offerDialog(group, offer, renderTarget);
    return;
  }
}

function cardStatus(group) {
  const { journal, note } = group;
  if (group.waiting) return ['waiting', 'pending'];
  if (note.ended) return ['ended', 'off'];
  const tables = note.tables.map(tb => state.results.get(tableKey(journal, tb.table)) || {});
  if ((state.results.get(journal) || {}).error || tables.some(r => r.error)) return ['error', 'err'];
  if (tables.some(r => r.pendingCount || r.held)) return ['review', 'pending'];
  const incomplete = Object.keys({ ...note.missing, ...note.big }).length || tables.some(r => r.files && r.files.waiting);
  return incomplete ? ['incomplete', 'pending'] : ['ok', 'ok'];
}

// Pièces jointes d'une table reçue : fichiers attendus (ils partent quand un propriétaire de la
// SOURCE ouvre la page du widget), trop gros pour partir, refusés par Grist ici ; aucun par lien public.
const MB = 1024 * 1024;
const megabytes = bytes => (bytes / MB).toLocaleString(LANG, { maximumFractionDigits: 1 });
function filesNotes(group, entry) {
  const { files } = state.results.get(tableKey(group.journal, entry.table)) || {};
  if (!files) return null;
  const named = list => list.map(f => t('recv.files.named', { name: f.name, size: megabytes(f.size) })).join(', ');
  return [
    files.public ? message('info', t('recv.files.public', { dest: entry.dest })) : null,
    files.waiting ? message('info', t('recv.files.waiting', { n: files.waiting, dest: entry.dest })) : null,
    files.big.length ? message('warn', t('recv.files.big', { files: named(files.big), max: FILE_MAX / MB })) : null,
  ];
}

// Une table reçue : origine → destination, heure du dernier passage, ou l'erreur. Le détail des
// changements est dans l'historique.
function tableLine(group, entry) {
  const journalResult = state.results.get(group.journal) || {};
  const result = state.results.get(tableKey(group.journal, entry.table)) || (journalResult.error ? journalResult : null);
  const detail = result && !group.waiting ? ` · ${timeText(result.at)}${result.error ? ` · ${result.text}` : ''}` : '';
  return el('p', { class: `small ${result && result.error ? 'text-danger' : 'muted'}` }, `${entry.table} → ${entry.dest}${detail}`);
}

// Avis d'une réception : envoi coupé par la SOURCE, lignes manquantes, trop grosses, instantané
// trop gros, lien partagé, arrivées suspectes, tables proposées ou refusées.
function cardNotes(group) {
  const { note } = group;
  return [
    note.ended ? message('warn', t('recv.ended', { at: dateText(note.ended * 1000) })) : null,
    group.unsigned && !group.waiting ? message('warn', t('recv.unsigned')) : null,
    group.unreserved ? message('info', t('recv.reserve.owner')) : null,
    Object.entries(note.missing || {}).map(([table, n]) => message('warn', t('recv.missing', { table, n }))),
    Object.entries(note.big || {}).map(([table, keys]) => message('warn', t('recv.big', { table, n: keys.length }))),
    (note.tooBig || []).length ? message('warn', t('recv.tooBig', { tables: note.tooBig.join(', ') })) : null,
    group.shared && !group.public ? alertBlock(t('recv.shared.title'), [t('recv.shared.body', { n: group.shared })], [button(t('recv.suspect.cut'), 'unlink', () => cutLink(group), 'btn-danger-text')]) : null,
    note.suspect ? suspectBlock(group) : null,
    (state.offers.get(group.journal) || []).map(o => el('div', { class: 'offer' }, el('span', { class: 'small' }, t('recv.offer.line', { table: o.table, n: o.n })),
      button(t('recv.offer.place'), 'plus', () => offerDialog(group, o, renderTarget), 'btn-primary'))),
    note.refused.length ? el('p', { class: 'muted small' }, t('recv.offer.refusedList', { tables: note.refused.join(', ') })) : null,
  ];
}

function syncCard(group) {
  const { note } = group;
  const [status, tone] = cardStatus(group);
  const from = (note.from || {}).email;
  // Le nom du document vérifié chez Grist (Échange), sinon son identifiant.
  const fromDoc = (note.from || {}).docName || (note.from || {}).docId || '';
  return el('article', { class: 'card', 'data-journal': group.journal },
    el('div', { class: 'card-head' }, el('strong', {}, note.name), pill(t(`recv.status.${status}`), tone)),
    from ? el('p', { class: 'small' }, t(fromDoc ? 'recv.fromDoc' : 'recv.from', { from, doc: fromDoc })) : null,
    group.public ? el('p', { class: 'muted small' }, t('recv.public')) : null,
    note.mode === 'echange' ? el('p', { class: 'muted small' }, t(note.retour ? 'recv.exchange.back' : 'recv.exchange')) : null,
    note.tables.map(entry => tableLine(group, entry)),
    cardNotes(group),
    note.tables.map(entry => filesNotes(group, entry)),
    uploadErrors(group.journal).map(e => message('warn', t('recv.files.refused', { name: e.name, error: e.error }))),
    note.tables.map(entry => [waveBlock(group, entry), reviewBlock(group, entry), gapBlock(group, entry), driftBlock(group, entry)]),
    group.waiting ? null : history(group),
    el('div', { class: 'card-actions' },
      group.public || note.retour ? null : button(t(group.waiting ? 'recv.action.continue' : 'recv.action.link'), 'link', () => receiveWizard(group, renderTarget), group.waiting ? 'btn-primary' : ''),
      button(t('recv.action.stop'), 'stop', () => stopReceiving(group), 'btn-danger-text')));
}

// Une carte qui ne peut pas se dessiner (journal abîmé) n'empêche pas les autres de l'être : elle
// garde son nom, l'erreur, et de quoi couper le lien ou arrêter la réception.
function safeCard(group) {
  try {
    return syncCard(group);
  } catch (e) {
    console.error(e);
    return el('article', { class: 'card', 'data-journal': group.journal },
      el('div', { class: 'card-head' }, el('strong', {}, String(group.note.name || group.journal)), pill(t('recv.status.error'), 'err')),
      message('err', errorText(e)),
      el('div', { class: 'card-actions' },
        group.public ? null : button(t('recv.suspect.cut'), 'unlink', () => cutLink(group), 'btn-danger-text'),
        button(t('recv.action.stop'), 'stop', () => stopReceiving(group), 'btn-danger-text')));
  }
}

const alertBlock = (title, lines, actions) => el('div', { class: 'msg msg-warn suspect', role: 'status' },
  el('strong', {}, title), lines.filter(Boolean).map(line => el('p', { class: 'small' }, line)), el('div', { class: 'card-actions' }, actions));

// Arrivées suspectes : lignes rejetées (elles ne pouvaient pas venir du webhook de cet export) et
// arrivée anormale. Le lien du formulaire est peut-être connu d'un autre : on peut le couper.
function suspectBlock(group) {
  const { n = 0, at, flood } = group.note.suspect;
  const dismiss = async (e) => {
    e.currentTarget.disabled = true;
    await updateJournalNote(group.journal, ({ suspect, ...note }) => note);
    await renderTarget();
  };
  return alertBlock(t('recv.suspect.title'), [
    n ? t('recv.suspect.rejected', { n, at: dateText(at * 1000) }) : null,
    flood ? t('recv.suspect.flood', { at: dateText(flood * 1000) }) : null,
    t('recv.suspect.help'),
  ], [button(t('recv.suspect.cut'), 'unlink', () => cutLink(group), 'btn-danger-text'), button(t('recv.suspect.dismiss'), 'ignore', dismiss)]);
}

// Couper le lien : le formulaire de cette réception prend une nouvelle clé, sur sa propre page. La
// SOURCE révoque l'ancien destinataire et envoie une nouvelle invitation, acceptée ici sur la même
// réception.
async function cutLink(group) {
  if (!(await confirmDialog({ title: t('recv.cut.title'), body: t('recv.cut.body'), confirmLabel: t('recv.suspect.cut') }))) return;
  await updateJournalNote(group.journal, ({ suspect, ...note }) => note);
  await renewFormLink(group.journal);
  await renderTarget();
  container.querySelector('.out').replaceChildren(message('ok', t('recv.cut.done')));
}

// Arrêter de recevoir : efface le journal (et son formulaire, donc la clé d'écriture) ; les tables
// de destination et leurs lignes restent. Un Échange s'arrête dans les deux sens (voir closeExport).
async function stopReceiving(group) {
  const { note } = group;
  const exchange = note.mode === 'echange';
  const body = t(exchange ? 'send.revoke.exchange' : 'recv.stop.body', { journal: group.journal });
  if (!(await confirmDialog({ title: t('recv.stop.title', { name: note.name }), body, confirmLabel: t('recv.action.stop') }))) return;
  if (exchange) await closeExport(note.export, { keepExport: Boolean(note.retour) });
  else await removeTechnicalTables([group.journal]);
  forgetJournal(group.journal);
  await renderTarget();
}

// ---------------------------------------------------------------------------------------------
// Valeurs en petit tableau, comme dans une vue Grist.

// Texte d'une valeur reçue ou lue dans la destination : liste de choix, date, case à cocher,
// pièces jointes (noms des fichiers reçus, ou nombre de fichiers ici).
function cellText(value, type = '') {
  if (type === 'Attachments' && Array.isArray(value)) {
    const files = fileList(value);
    return files.length ? files.map(f => f.name).join(', ') : t('recv.files.count', { n: value.length - (value[0] === 'L' ? 1 : 0) });
  }
  if (Array.isArray(value)) return value[0] === 'L' ? value.slice(1).join(', ') : JSON.stringify(value);
  if (typeof value === 'boolean') return t(value ? 'common.yes' : 'common.no');
  if (typeof value === 'number' && /^Date/.test(type)) {
    const zone = type.startsWith('DateTime:') ? type.slice(9) : 'UTC';
    try {
      const date = new Date(value * 1000);
      return type.startsWith('DateTime') ? date.toLocaleString(LANG, { timeZone: zone }) : date.toLocaleDateString(LANG, { timeZone: 'UTC' });
    } catch (e) { /* fuseau inconnu : la valeur brute */ }
  }
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

const cell = (value, type, kind = '') => {
  if (isBlank(value)) return el('td', { class: `${kind} mg-blank` }, t('common.blank'));
  const text = cellText(value, type);
  return el('td', { class: kind, title: text }, text);
};

// Valeurs d'une ligne avant ou après un changement (`kind`), sous l'intitulé `heading`.
const valuesRow = (kind, heading, values, typesOf) => el('tr', { class: `mg-${kind}` }, el('th', { scope: 'row' }, heading),
  values.map((v, i) => cell(v, typesOf(i))));

// Tête d'un changement (historique, changement à valider) : numéro de ligne, icône, nom, état.
const changeHead = ({ n, state: change, label }, nTitle = null) => [
  el('span', { class: 'chg-n', title: nTitle }, n ? String(n) : ''),
  el('span', { class: 'chg-dot', title: t(`recv.history.${change}`) }, icon(STATE_ICON[change])),
  el('span', { class: 'chg-label' }, label || '—'),
  el('span', { class: 'chg-state' }, t(`recv.history.${change}`))];

const miniGrid = (head, rows) => el('div', { class: 'mini-grid-wrap' }, el('table', { class: 'mini-grid' },
  el('thead', {}, el('tr', {}, head.map(h => el('th', { scope: 'col' }, h)))), el('tbody', {}, rows)));

// Écarts en petit tableau (retouches faites ici, écarts laissés par un refus), une ligne de tableau
// par cellule, SHOWN au plus. `lines` : [{ n, label, cells: [[colonne reçue, colonne d'ici,
// valeur d'ici, autre valeur]] }], ou une phrase (`said`) pour une ligne entière, ou pour une
// colonne entière (`col`). Rend le tableau et ce qu'il montre : lignes de tableau (`rows`) et
// lignes d'écart (`lines`), pour dire combien restent.
function diffGrid(lines, { types = {}, labelCol = '', otherHead }) {
  const said = (text, span) => el('td', { class: 'mg-here', colspan: String(span) }, text);
  const head = l => [el('td', { class: 'mg-n' }, l.n ? String(l.n) : ''), el('td', { title: l.label }, l.label)];
  const all = lines.flatMap((l, i) => {
    if (l.col) return [[i, el('tr', {}, el('td', {}), el('td', {}), el('td', {}, l.col), said(l.said, 2))]];
    if (l.said) return [[i, el('tr', {}, head(l), said(l.said, 3))]];
    return l.cells.map(([from, to, here, other]) => [i, el('tr', {}, head(l), el('td', {}, to), cell(here, types[from], 'mg-here'), cell(other, types[from], 'mg-source'))]);
  });
  const shown = all.slice(0, SHOWN);
  const columns = [t('recv.drift.row'), labelCol, t('recv.drift.col'), t('recv.drift.here'), otherHead];
  return { grid: miniGrid(columns, shown.map(([, tr]) => tr)), rows: shown.length, lines: new Set(shown.map(([i]) => i)).size };
}

const more = n => (n > 0 ? el('p', { class: 'small' }, t('recv.history.more', { n })) : null);

// Retouches faites à la main dans une destination : colonnes reçues effacées, cellules qui
// diffèrent de la dernière version reçue (avec leur numéro de ligne), lignes reçues effacées. Elles
// restent jusqu'à ce que la SOURCE change leur ligne, ou que l'on clique sur « Corriger ». Le
// compte est celui des retouches (une par cellule, ligne ou colonne).
function driftBlock(group, entry) {
  const result = state.results.get(tableKey(group.journal, entry.table)) || {};
  const total = result.driftCount || 0;
  if (!total) return null;
  const lines = [
    ...(result.droppedCols || []).map(([, to]) => ({ col: to, said: t('recv.drift.colGone') })),
    ...(result.drift || []).map(d => (d.gone ? { label: d.label, said: t('recv.drift.rowGone') } : d)),
  ];
  const { grid, rows } = diffGrid(lines, { types: result.types, labelCol: result.labelCol, otherHead: t('recv.drift.source') });
  return el('div', { class: 'msg msg-warn drift', role: 'status' },
    el('strong', {}, t('recv.drift.title', { dest: entry.dest, n: total })),
    el('p', { class: 'small' }, t('recv.drift.body', { n: total })),
    grid, more(total - rows),
    el('div', { class: 'card-actions' }, button(t('recv.drift.fix'), 'undo', e => run(e.currentTarget, container.querySelector('.out'), () => correct(group, entry, result)))));
}

// « Corriger » : la table reprend l'état exact de la SOURCE, après confirmation.
async function correct(group, entry, { driftCount, driftGone = 0, droppedCols = [] }) {
  const body = [t('recv.drift.fixBody', { n: driftCount }), driftGone ? t('recv.drift.fixRows', { n: driftGone }) : '',
    droppedCols.length ? t('recv.drift.fixCols', { n: droppedCols.length }) : ''].filter(Boolean).join(' ');
  if (!(await confirmDialog({ title: t('recv.drift.fixTitle', { dest: entry.dest }), body, confirmLabel: t('recv.drift.fix') }))) return;
  await restoreSource(group.journal, entry.table);
  await renderTarget();
}

// Vague de suppressions retenue (voir WAVE) : rien n'est effacé avant la décision. « Appliquer »
// efface les lignes ; « Ignorer » les garde ici, détachées de la SOURCE (après confirmation).
function waveBlock(group, entry) {
  const { held } = state.results.get(tableKey(group.journal, entry.table)) || {};
  if (!held) return null;
  const out = () => container.querySelector('.out');
  const texts = {
    appliquer: [t('recv.wave.applyTitle', { n: held.n, dest: entry.dest }), t('recv.wave.applyBody', { n: held.n }), t('recv.wave.apply')],
    ignorer: [t('recv.wave.ignoreTitle', { n: held.n, dest: entry.dest }), t('recv.wave.ignoreBody', { n: held.n }), t('recv.wave.ignore')],
  };
  const choose = async (e, choice) => {
    const target = e.currentTarget;
    const [title, body, confirmLabel] = texts[choice];
    if (!(await confirmDialog({ title, body, confirmLabel }))) return;
    await run(target, out(), async () => {
      await decideWave(group.journal, entry.table, choice);
      await renderTarget();
    });
  };
  return el('div', { class: 'msg msg-warn wave', role: 'status' },
    el('strong', {}, t('recv.wave.title', { n: held.n, dest: entry.dest })),
    el('p', { class: 'small' }, t(group.note.renforce ? 'recv.wave.strict' : 'recv.wave.body')),
    held.numbers.length ? el('p', { class: 'small' }, t('recv.wave.rows', { rows: held.numbers.join(', ') })) : null,
    el('div', { class: 'card-actions' },
      button(t('recv.wave.apply'), 'trash', e => choose(e, 'appliquer'), 'btn-danger-text'),
      button(t('recv.wave.ignore'), 'ignore', e => choose(e, 'ignorer'))));
}

// ---------------------------------------------------------------------------------------------
// Échange administré ici : changements d'un participant à valider, puis écarts laissés par un refus.

// Chaque changement à valider montre ce qu'il changerait ici (valeur d'ici, valeur proposée) et a
// ses deux boutons ; « Tout accepter » et « Tout refuser » valent aussi pour ceux que la carte ne
// montre pas, après confirmation. Rien n'est écrit ici avant la décision.
function reviewBlock(group, entry) {
  const result = state.results.get(tableKey(group.journal, entry.table)) || {};
  const total = result.pendingCount || 0;
  if (!total) return null;
  const types = result.types || {};
  const out = () => container.querySelector('.out');
  const choose = async (e, ids, choice) => run(e.currentTarget, out(), async () => {
    await decide(group.journal, ids, choice);
    await renderTarget();
  });
  const all = async (e, choice) => {
    const target = e.currentTarget;
    const label = t(`recv.review.${choice}All`);
    if (await confirmDialog({ title: label, body: t(`recv.review.${choice}AllBody`, { n: total }), confirmLabel: label })) await choose({ currentTarget: target }, result.pendingIds, choice);
  };
  const values = (kind, cells, at) => valuesRow(kind, t(`recv.review.${kind === 'before' ? 'here' : 'proposed'}`), cells.map(c => c[at]), i => types[cells[i][0]]);
  const items = result.pending.slice(0, SHOWN).map(p => el('li', { class: `review-item chg-${p.state}` },
    el('div', { class: 'review-head' },
      changeHead(p),
      el('span', { class: 'review-actions' },
        button(t('recv.review.accept'), 'check', e => choose(e, [p.id], 'accepter')),
        button(t('recv.review.refuse'), 'refuse', e => choose(e, [p.id], 'refuser'), 'btn-danger-text'))),
    p.cells.length ? miniGrid(['', ...p.cells.map(([, to]) => to)], [
      p.state === 'ajout' ? null : values('before', p.cells, 2),
      p.state === 'suppression' ? null : values('after', p.cells, 3)].filter(Boolean)) : null));
  return el('div', { class: 'msg msg-info review', role: 'status' },
    el('strong', {}, t('recv.review.title', { dest: entry.dest, n: total })),
    el('p', { class: 'small' }, t('recv.review.body')),
    el('ul', { class: 'review-rows' }, items),
    more(total - items.length),
    el('div', { class: 'card-actions' },
      button(t('recv.review.accepterAll'), 'check', e => all(e, 'accepter')),
      button(t('recv.review.refuserAll'), 'refuse', e => all(e, 'refuser'), 'btn-danger-text')));
}

// Refus avec écart signalé : la ligne refusée reste différente chez le participant, jusqu'à la
// prochaine modification de la ligne, ici ou chez lui.
// Le compte est celui des lignes refusées.
function gapBlock(group, entry) {
  const result = state.results.get(tableKey(group.journal, entry.table)) || {};
  const total = result.gapCount || 0;
  if (!total) return null;
  const lines = result.gaps.map(g => (g.state !== 'modif' || !g.cells.length ? { n: g.n, label: g.label, said: t(`recv.gap.${g.state}`) } : g));
  const { grid, lines: shown } = diffGrid(lines, { types: result.types, labelCol: result.labelCol, otherHead: t('recv.gap.theirs') });
  return el('div', { class: 'msg msg-warn drift', role: 'status' },
    el('strong', {}, t('recv.gap.title', { dest: entry.dest, n: total })),
    el('p', { class: 'small' }, t('recv.gap.body')),
    grid, more(total - shown));
}

// ---------------------------------------------------------------------------------------------
// Historique : lignes changées depuis la visite précédente, par table de destination : compteurs
// par état (ajoutées, modifiées, supprimées, et colonnes ajoutées par la SOURCE), puis les plus
// récentes (HISTORY_MAX par table), numérotées comme dans la table et nommées par la colonne
// choisie pour chaque table. Chacune s'ouvre au clic sur son avant et son après. Tout est replié
// par défaut.

const STATE_ICON = { ajout: 'plus', modif: 'edit', suppression: 'minus', colonne: 'column', [REFUSED]: 'refuse' };
const COUNTED = [...STATES, 'colonne', REFUSED];

function stateCounts(items) {
  return el('span', { class: 'history-counts' }, COUNTED.map((st) => {
    const n = items.filter(c => c.state === st).length;
    return n ? el('span', { class: `chg chg-${st}` }, icon(STATE_ICON[st]), t(`recv.history.n.${st}`, { n })) : null;
  }));
}

function when(at) {
  const date = new Date(at * 1000);
  const today = date.toDateString() === new Date().toDateString();
  return today ? date.toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(LANG, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function historyRow(c, types, id) {
  const gone = c.state === 'suppression';
  const label = c.state === 'colonne' ? t('recv.history.colLabel', { col: c.label }) : c.label;
  const line = [
    changeHead({ ...c, label }, c.n ? t(gone ? 'recv.history.rowGone' : 'recv.history.row', { n: c.n }) : null),
    el('time', { class: 'chg-time', datetime: new Date(c.at * 1000).toISOString() }, when(c.at))];
  const rowClass = `chg-row chg-${c.state}`;
  if (!c.detail) return el('li', { class: `chg-item chg-${c.state}` }, el('div', { class: rowClass }, line));
  const { cols, before, after } = c.detail;
  // Un refus montre ce qui est gardé ici et ce qui était proposé.
  const heading = kind => (c.state === REFUSED ? t(`recv.review.${kind === 'before' ? 'here' : 'proposed'}`) : t(`recv.history.${kind}`));
  const values = (kind, list) => list && valuesRow(kind, heading(kind), list, i => types[cols[i][0]]);
  return el('li', { class: `chg-item chg-${c.state}` }, el('details', { open: opened.has(id), ontoggle: keepOpen(id) },
    el('summary', { class: rowClass }, line),
    miniGrid(['', ...cols.map(([, to]) => to)], [values('before', before), values('after', after)])));
}

const historyTable = ({ id, dest, items, types }) => (items.length ? el('section', { class: 'history-table' },
  el('div', { class: 'history-head' }, el('strong', {}, dest), stateCounts(items)),
  el('ul', { class: 'history-rows' }, items.slice(0, HISTORY_MAX).map(c => historyRow(c, types, `${id}|${c.key}|${c.at}`))),
  items.length > HISTORY_MAX ? el('p', { class: 'muted small' }, t('recv.history.more', { n: items.length - HISTORY_MAX })) : null) : null);

function history(group) {
  const tables = group.note.tables.map((tb) => {
    const result = state.results.get(tableKey(group.journal, tb.table)) || {};
    // Une colonne ajoutée par la SOURCE prend place parmi les lignes, à son heure.
    const columns = (result.added || []).map(a => ({ at: a.at, key: `col:${a.col}`, state: 'colonne', label: a.col, n: null, detail: null }));
    const items = [...columns, ...(result.recent || [])].sort((x, y) => y.at - x.at);
    return { id: tableKey(group.journal, tb.table), dest: tb.dest, items, types: result.types || {} };
  });
  const all = tables.flatMap(tb => tb.items);
  if (!all.length) return el('p', { class: 'muted small' }, t('recv.history.none'));
  return el('details', { class: 'history', open: opened.has(group.journal), ontoggle: keepOpen(group.journal) },
    el('summary', {}, el('span', { class: 'history-title' }, t(state.lastVisit ? 'recv.history.since' : 'recv.history.last')), stateCounts(all)),
    tables.map(historyTable),
    el('button', { class: 'btn btn-small btn-link', type: 'button', disabled: state.readOnly, onclick: () => labelDialog(group) }, t('recv.label.change')));
}

// Colonne qui nomme les lignes dans l'historique, par table reçue (notée dans le journal).
function labelDialog(group) {
  const pickers = group.note.tables.map((entry) => {
    const result = state.results.get(tableKey(group.journal, entry.table)) || {};
    const cols = result.labelCols || [];
    return { entry, field: pickField({ items: cols.map(c => ({ value: c, label: c })), value: result.labelCol || cols[0], label: entry.dest }) };
  });
  const report = el('div', { class: 'report' });
  const save = async (m) => {
    await updateJournalNote(group.journal, note => ({
      ...note, tables: note.tables.map(tb => ({ ...tb, label: (pickers.find(p => p.entry.table === tb.table) || {}).field.value() })),
    }));
    m.close();
    state.results.clear();
    await consolidateAll();
  };
  openModal({
    title: t('recv.label.title'), width: 400,
    body: [el('p', { class: 'small' }, t('recv.label.help')), ...pickers.map(p => el('div', { class: 'dest-row' }, el('span', {}, p.entry.dest), p.field)), report],
    buttons: [{ label: t('common.cancel') }, { label: t('common.save'), kind: 'btn-primary', onClick: m => run(null, report, () => save(m)) }],
  });
}
