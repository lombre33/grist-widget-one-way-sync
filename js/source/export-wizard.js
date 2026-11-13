// SOURCE : assistant d'export, en trois étapes (Tables, Colonnes, Nom). Crée l'export, ou le
// modifie (`exp`) : ajouter ou retirer des tables, changer les colonnes ou le nom vaut pour tous
// ses destinataires.
import { isUserTable } from '../engine/logic/common.js';
import { ownsSync } from '../engine/logic/strays.js';
import { elementCounts, exportableColumns, isFileColumn, unsentColumns } from '../engine/logic/exports.js';
import { noteSent } from '../engine/logic/descriptions.js';
import { formulasOffered } from '../engine/logic/column-formulas.js';
import { layoutSent } from '../engine/logic/layout.js';
import { linkOffers, refKey, refOf } from '../engine/logic/links.js';
import { REFUSALS, RULES, exchangeRules } from '../engine/logic/consolidation.js';
import { missingSyncColumns } from '../engine/logic/formulas.js';
import { STATES } from '../engine/logic/journal.js';
import { fetchRows, readSchema } from '../grist.js';
import { finishEdit, saveChosenExport } from '../engine/source/export.js';
import { receivedDests } from '../engine/logic/received.js';
import { recipientWizard } from './recipient-wizard.js';
import { progressTo } from './flow.js';
import { backButton, cancelButton, checkList, closeButtons, confirmDialog, el, laterButton, message, notice, openWizard, pickField, run, withHelp } from '../ui.js';
import { filterEditor, filterSummary } from './filter-editor.js';
import { PULL_MODES, extrasFor, pullColumns, pullLeftOut } from './pull.js';
import { roleGuide } from '../guide.js';
import { stepHelp } from '../tutorial.js';
import { t, typeName } from '../i18n.js';

const cancel = cancelButton();
const columnLabel = c => (c.label === c.id ? c.id : `${c.label} (${c.id})`);

// `onClose` : appelé à la fermeture (l'onglet se redessine). Échap et la croix demandent quoi faire de ce qui a été changé :
// un export modifié peut s'enregistrer tel quel sans passer par les étapes qui restent (`quickSave`) ; un export qu'on crée
// n'a rien d'enregistré, on peut seulement l'abandonner.
export function exportWizard(exp, onClose) {
  const ctx = {
    exp, onClose,
    chosen: exp ? exp.tables.map(tb => tb.table) : [],
    selected: new Map(exp ? exp.tables.map(tb => [tb.table, tb.columns.map(c => c.id)]) : []), // table -> colonnes cochées
    filters: new Map(exp ? exp.tables.map(tb => [tb.table, tb.filter]) : []), // table -> filtre de lignes, ou null
    choices: new Map(), // colonne Référence (refKey) -> garder son lien ? (choix fait dans cette fenêtre)
    extras: new Map(), // table ajoutée pour un lien -> colonnes cochées en plus de celle que le lien affiche (choix « Choisir les colonnes »)
    pulls: new Map(), // table ajoutée pour un lien -> ce qu'elle envoie : 'shown' (d'emblée), 'all' ou 'pick' (voir pull.js)
    saved: savedLinks(exp), // refKey -> la colonne de l'export enregistré gardait son lien
  };
  ctx.wizard = openWizard({
    title: exp ? t('send.edit.title', { name: exp.name }) : t('send.new'),
    steps: ['send.step.tables', 'send.step.columns', 'send.step.name'].map(k => t(k)),
    onClose,
    guard: { save: exp ? () => quickSave(ctx) : null },
  });
  ctx.wizard.start(() => showTables(ctx));
}

// Les liens de l'export enregistré, colonne par colonne (voir linkOffers). Rien pour un nouvel export ni un Échange.
const savedLinks = exp => (exp && !exp.echange
  ? new Map(exp.tables.flatMap(tb => tb.columns.filter(c => refOf(c)).map(c => [refKey(tb.table, c.id), Boolean(c.link)]))) : null);

// 1. Tables de l'export. Une table introuvable (renommée, effacée) en sort.
async function showTables(ctx) {
  const tables = (await readSchema()).tableIds.filter(isUserTable);
  ctx.chosen = ctx.chosen.filter(table => tables.includes(table));
  const report = ctx.report = el('div', { class: 'report' });
  const next = { label: t('common.next'), kind: 'btn-primary', disabled: !ctx.chosen.length, onClick: () => run(null, report, () => showColumns(ctx)) };
  const list = checkList({
    items: tables.map(id => ({ value: id, label: id })), checked: ctx.chosen, label: t('send.step.tables'),
    onChange: (values) => {
      // Une table cochée ici n'est plus « ajoutée pour un lien » : elle repart de ses colonnes et de son filtre habituels.
      for (const table of values.filter(v => !ctx.chosen.includes(v))) for (const map of [ctx.extras, ctx.pulls, ctx.selected, ctx.filters]) map.delete(table);
      ctx.chosen = values; next.disabled = !values.length; ctx.wizard.buttons([cancel, next]);
    },
  });
  ctx.wizard.show(0, [el('p', {}, t(ctx.exp ? 'send.edit.tables' : 'send.tables.help')), list, report, stepHelp(['s-tables']),
    ctx.exp ? null : roleGuide({ you: 'source', current: 0 })], [cancel, next]);
}

// Bloc d'une table à l'étape Colonnes : par défaut toutes ses colonnes et toutes ses lignes, dit
// en une ligne ; deux boutons ouvrent le choix des colonnes et le filtre des lignes (ouverts
// d'emblée quand l'export modifié les précise déjà). Une colonne Pièces jointes ne part que cochée
// (ses fichiers partent page ouverte, et peuvent peser lourd) : le choix des colonnes est alors
// ouvert.
function columnsBlock(ctx, schema, table, relayed) {
  const usable = exportableColumns(schema.columns(table));
  if (!ctx.selected.has(table)) ctx.selected.set(table, usable.filter(c => !isFileColumn(c)).map(c => c.id));
  const files = usable.filter(isFileColumn).map(c => c.label);
  const unsent = unsentColumns(schema.columns(table)).map(c => `${c.label} · ${typeName(c.type)}`);
  const summary = el('p', { class: 'small' });
  const describe = () => {
    const n = ctx.selected.get(table).length;
    const filter = ctx.filters.get(table);
    const rows = filterSummary(filter);
    summary.textContent = `${n === usable.length ? t('send.columns.all', { n }) : t('send.columns.some', { n, total: usable.length })} · ${
      rows ? t('send.rows.filtered', { filter: rows }) : t('send.rows.all')}`;
  };
  const columns = el('div', { class: 'form' },
    checkList({ items: usable.map(c => ({ value: c.id, label: columnLabel(c), hint: typeName(c.source), keywords: typeName(c.source) })), wide: true,
      checked: ctx.selected.get(table), label: table, onChange: (values) => { ctx.selected.set(table, values); describe(); if (ctx.refresh) ctx.refresh(); } }),
    files.length ? el('p', { class: 'muted small' }, t('send.columns.files', { cols: files.join(', ') })) : null);
  const editor = filterEditor({
    table, columns: usable, current: ctx.filters.get(table), labelOf: columnLabel,
    onChange: (filter) => { ctx.filters.set(table, filter); describe(); },
  });
  const filtered = Boolean(filterSummary(ctx.filters.get(table)));
  if (filtered) editor.load();
  describe();
  return el('div', { class: 'form table-block' }, el('h3', {}, table),
    relayed ? message('info', t('send.columns.relay')) : null, summary,
    unsent.length ? message('info', t('send.columns.unsent', { cols: unsent.join(', ') })) : null,
    el('div', { class: 'block-actions' },
      togglePart(columns, t('send.columns.pick'), ctx.selected.get(table).length !== usable.length),
      togglePart(editor.node, t('send.rows.pick'), filtered, editor.load)),
    columns, editor.node);
}

// Bouton qui ouvre ou ferme une partie de la fenêtre ; `onOpen` à chaque ouverture.
function togglePart(part, label, open, onOpen = () => {}) {
  part.classList.toggle('hidden', !open);
  const button = el('button', { class: 'btn btn-small', type: 'button', 'aria-expanded': String(open), onclick: () => {
    const now = part.classList.toggle('hidden') === false;
    button.setAttribute('aria-expanded', String(now));
    if (now) onOpen();
  } }, label);
  return button;
}

// Ce que la personne décide pour chaque colonne Référence ou Liste de références cochée (voir linkOffers), à
// l'état de la fenêtre : les choix faits, ceux de l'export enregistré, sinon le lien est gardé quand la table visée est
// cochée. Les colonnes d'une table ajoutée pour un lien sont celles que le lien affiche et celles que la personne y prend
// (toute la table, ou celles qu'elle y coche : voir pull.js).
const pullMode = (ctx, table) => ctx.pulls.get(table) || 'shown';
const pulledColumns = (ctx, schema, table, required = []) => pullColumns({
  mode: pullMode(ctx, table), usable: exportableColumns(schema.columns(table) || []), required, extras: [...(ctx.extras.get(table) || [])],
});
const offersOf = (ctx, schema) => linkOffers({
  chosen: ctx.chosen, columnsOf: table => exportableColumns(schema.columns(table) || []),
  picked: table => (ctx.chosen.includes(table) ? ctx.selected.get(table) : pulledColumns(ctx, schema, table)),
  choices: ctx.choices, saved: ctx.saved,
});

// Bloc d'une table ajoutée pour un lien. Trois choix (voir pull.js) : la seule colonne que la Référence affiche (d'emblée), toute la
// table, ou les colonnes que la personne coche (la colonne affichée reste verrouillée). Ses lignes peuvent se filtrer comme celles
// des autres tables.
function pulledBlock(ctx, schema, { table, required, because, onChange }) {
  const usable = exportableColumns(schema.columns(table) || []);
  const mode = () => pullMode(ctx, table);
  const picked = () => pulledColumns(ctx, schema, table, required);
  const labels = ids => usable.filter(c => ids.includes(c.id)).map(c => c.label);
  const summary = el('p', { class: 'small' });
  const leftOut = el('p', { class: 'muted small' });
  const describe = () => {
    const rows = filterSummary(ctx.filters.get(table));
    const names = mode() === 'all' ? t('send.refs.summary.whole') : labels(picked()).join(', ');
    summary.textContent = `${t('send.columns.some', { n: picked().length, total: usable.length })} (${names}) · ${rows ? t('send.rows.filtered', { filter: rows }) : t('send.rows.all')}`;
    const files = pullLeftOut({ mode: mode(), usable }).map(c => c.label);
    leftOut.textContent = files.length ? t('send.refs.mode.files', { cols: files.join(', ') }) : '';
    leftOut.classList.toggle('hidden', !files.length);
  };
  const columns = el('div', { class: 'form' });
  const drawColumns = () => {
    columns.replaceChildren(checkList({
      items: usable.map(c => ({ value: c.id, label: columnLabel(c), hint: typeName(c.source), keywords: typeName(c.source), locked: required.includes(c.id) })), wide: true,
      checked: picked(), label: table, onChange: (values) => { ctx.extras.set(table, values.filter(v => !required.includes(v))); describe(); onChange(); },
    }));
    columns.classList.toggle('hidden', mode() !== 'pick');
  };
  const choose = (next) => {
    // De « toute la table » à « choisir » : ce qui partait reste coché, pour pouvoir y retirer des colonnes.
    if (next === 'pick' && mode() !== 'pick') ctx.extras.set(table, extrasFor({ usable, required, columns: picked() }));
    ctx.pulls.set(table, next);
    drawColumns();
    describe();
    onChange();
  };
  const name = `gristsync-pull-${table}`;
  const texts = {
    shown: t('send.refs.mode.shown', { cols: labels(required).join(', ') }),
    all: t('send.refs.mode.all', { n: usable.filter(c => !pullLeftOut({ mode: 'all', usable }).includes(c)).length }),
    pick: t('send.refs.mode.pick'),
  };
  const modes = el('div', { class: 'radios pull-modes', role: 'radiogroup', 'aria-label': t('send.refs.mode', { table }) },
    PULL_MODES.map(value => el('label', { class: 'check' },
      el('input', { type: 'radio', name, value, checked: mode() === value, onchange: () => choose(value) }), el('span', {}, texts[value]))));
  const editor = filterEditor({ table, columns: usable, current: ctx.filters.get(table), labelOf: columnLabel, onChange: (filter) => { ctx.filters.set(table, filter); describe(); } });
  const filtered = Boolean(filterSummary(ctx.filters.get(table)));
  if (filtered) editor.load();
  drawColumns();
  describe();
  return el('div', { class: 'form table-block table-added', 'data-pulled': table },
    el('div', { class: 'added-head' }, el('h3', {}, table), el('span', { class: 'pill pill-ok' }, t('send.refs.added'))),
    el('p', { class: 'muted small' }, t('send.refs.added.because', { cols: because.join(', ') })),
    el('p', { class: 'field-title' }, t('send.refs.mode', { table })), modes, summary, leftOut,
    el('div', { class: 'block-actions' }, togglePart(editor.node, t('send.rows.pick'), filtered, editor.load)),
    columns, editor.node);
}

// Une ligne du bloc « Références entre tables » : la colonne, ce qu'elle vise, le choix « Valeurs seulement » / « Garder le lien »
// et ce que ce choix fait. `update` la remet à l'état des choix sans la redessiner (le focus reste sur le bouton radio).
function refRow(ctx, offer, onPick) {
  const name = `gristsync-ref-${offer.key}`;
  const note = el('p', { class: 'ref-note muted small' });
  const radio = (link, label) => {
    const input = el('input', { type: 'radio', name, checked: false, onchange: () => { ctx.choices.set(offer.key, link); onPick(); } });
    return { input, node: el('label', { class: 'check' }, input, el('span', {}, label)) };
  };
  const values = radio(false, t('send.refs.values'));
  const keep = radio(true, t('send.refs.link'));
  const kind = t(offer.list ? 'type.RefList' : 'type.Ref');
  const update = (now) => {
    values.input.checked = !now.link;
    keep.input.checked = now.link;
    keep.input.disabled = !now.ok;
    const vars = { target: now.target, shown: now.shown, kind };
    note.textContent = t(!now.ok ? `send.refs.note.${now.why}` : now.link ? (now.inside ? 'send.refs.note.inside' : 'send.refs.note.pull') : 'send.refs.note.values', vars);
  };
  update(offer);
  return {
    key: offer.key, update,
    node: el('div', { class: 'ref-row', 'data-ref': offer.key },
      el('div', {}, el('strong', {}, offer.label), ' ', el('span', { class: 'muted small' }, t('send.refs.of', { table: offer.table })), ' ', el('span', { class: 'pill pill-off' }, kind),
        el('div', { class: 'muted small' }, t('send.refs.aim', { target: offer.target, shown: offer.shown || '—' }))),
      el('div', { class: 'radios', role: 'radiogroup', 'aria-label': `${offer.table} · ${offer.label}` }, values.node, keep.node), note),
  };
}

// Colonnes Référence et Liste de références (voir links.js) : pour chacune, n'envoyer que le texte affiché ou garder le lien (la table
// visée s'ajoute alors à l'export : sa colonne affichée seule, toute la table ou des colonnes au choix). Hors Échange, où les colonnes vont dans les deux sens par leur
// nom. `onTables` reçoit les tables de l'export à chaque changement. Rend les nœuds (tables ajoutées, puis bloc des choix).
function linkSection(ctx, schema, onTables) {
  if (ctx.exp?.echange) return null;
  const pulledSlot = el('div', { class: 'form' });
  const refsSlot = el('div', { class: 'form' });
  const state = { shown: '', pulled: '', rows: new Map(), summary: el('p', { class: 'small summary' }) };
  const redrawPulled = (offers) => {
    const because = (table) => offers.rows.filter(r => r.link && r.target === table).map(r => `${r.table}.${r.label}`);
    pulledSlot.replaceChildren(...[...offers.pulled].map(([table, required]) => pulledBlock(ctx, schema, { table, required, because: because(table), onChange: refresh })));
  };
  const redrawRefs = (offers) => {
    state.rows = new Map(offers.rows.map(r => [r.key, refRow(ctx, r, refresh)]));
    const n = offers.rows.length;
    refsSlot.replaceChildren(...(n ? [el('div', { class: 'form table-block' }, el('h3', {}, t('send.refs.title')),
      withHelp(el('p', { class: 'field-title' }, t('send.refs.found', { n })), t('send.refs.found.help'), t('send.refs.title')),
      ...[...state.rows.values()].map(row => row.node), state.summary)] : []));
  };
  function refresh() {
    const offers = offersOf(ctx, schema);
    for (const map of [ctx.extras, ctx.pulls]) for (const table of [...map.keys()]) if (!offers.pulled.has(table)) map.delete(table);
    const rowsSig = JSON.stringify(offers.rows.map(r => [r.key, r.ok, r.why]));
    if (rowsSig !== state.shown) { state.shown = rowsSig; redrawRefs(offers); } else offers.rows.forEach(r => state.rows.get(r.key).update(r));
    const pulledSig = JSON.stringify([[...offers.pulled], offers.rows.filter(r => r.link).map(r => [r.key, r.target])]);
    if (pulledSig !== state.pulled) { state.pulled = pulledSig; redrawPulled(offers); }
    const items = [...offers.pulled].map(([table, required]) => {
      const names = pullMode(ctx, table) === 'all' ? [t('send.refs.summary.whole')] : pulledColumns(ctx, schema, table, required).map(id => (exportableColumns(schema.columns(table) || []).find(c => c.id === id) || { label: id }).label);
      return `${table} (${names.join(', ')})`;
    });
    state.summary.textContent = items.length ? t('send.refs.summary.some', { items: items.join(', ') }) : t('send.refs.summary.none');
    onTables([...ctx.chosen, ...offers.pulled.keys()]);
  }
  ctx.refresh = refresh;
  refresh();
  return [pulledSlot, refsSlot];
}

// Case « Envoyer aussi les colonnes que j'ajouterai » (voir new-columns.js) : décochée d'emblée, telle que l'export l'est pour un export
// modifié, jamais en Échange. Sans elle, une colonne ajoutée plus tard ne part pas : la carte de l'export le dit, avec un bouton pour l'envoyer.
function autoColsBlock(ctx) {
  if (ctx.exp?.echange) {
    ctx.autoCols = false;
    return null;
  }
  if (ctx.autoCols === undefined) ctx.autoCols = Boolean(ctx.exp?.autoCols);
  const box = el('input', { type: 'checkbox', checked: ctx.autoCols, onchange: () => { ctx.autoCols = box.checked; } });
  return el('div', { class: 'form auto-cols' }, withHelp(el('label', { class: 'check' }, box, t('send.autoCols')), t('send.autoCols.help'), t('send.autoCols')));
}

// Éléments des colonnes envoyés en plus des données, chacun sa case (`ctx.elements`) : la mise en forme (voir options.js,
// rules.js, docformat.js : en-têtes, règles conditionnelles simples, monnaie résolue, langue du document, en plus des
// formats que la CIBLE reprend déjà), les descriptions des colonnes et celle de chaque table (voir descriptions.js), l'ordre et
// les colonnes cachées de la page de chaque table (voir layout.js : décochée d'emblée, elle change l'affichage chez le destinataire).
// Chaque case dit combien de colonnes (de tables) sont concernées. Cochées d'emblée pour un nouvel export (sauf la mise en page) ; pour un export
// modifié, telles que l'export l'est déjà. Repliées derrière une ligne qui dit ce qui part. Jamais en Échange (les
// colonnes y vont dans les deux sens). Les formules (voir column-formulas.js) ont leur case à part, hors du repli, décochée
// d'emblée, et un message qui demande si l'on est sûr : c'est du Python qu'un destinataire exécutera chez lui.
const ELEMENTS = [['style', 'send.el.style', 'send.el.style.count'], ['notes', 'send.el.notes', 'send.el.notes.count'], ['tableNote', 'send.el.tableNote', 'send.el.tableNote.count'], ['layout', 'send.el.layout', 'send.el.layout.count']];
async function elementsBlock(ctx, schema) {
  if (ctx.exp?.echange) {
    ctx.elements = { style: false, notes: false, tableNote: false, layout: false, formulas: false };
    return null;
  }
  if (!ctx.elements) {
    const sent = ctx.exp ? noteSent(ctx.exp.tables.flatMap(tb => tb.columns)) : null;
    ctx.elements = ctx.exp
      ? { style: ctx.exp.tables.some(tb => tb.columns.some(c => c.fmt)), notes: sent.notes, tableNote: sent.table, layout: layoutSent(ctx.exp.tables.flatMap(tb => tb.columns)), formulas: formulasOffered(ctx.exp.tables.flatMap(tb => tb.columns)) }
      : { style: true, notes: true, tableNote: true, layout: false, formulas: false };
  }
  const counts = elementCounts(schema, ctx.chosen, await fetchRows('_grist_Views_section'));
  const summary = el('summary', {});
  const names = () => ELEMENTS.filter(([key]) => ctx.elements[key]).map(([, name]) => t(`${name}.short`));
  const refresh = () => { summary.textContent = t('send.elements', { items: names().join(', ') || t('send.elements.none') }); };
  const boxes = ELEMENTS.map(([key, name, count]) => {
    const box = el('input', { type: 'checkbox', checked: ctx.elements[key], onchange: () => { ctx.elements[key] = box.checked; refresh(); } });
    return el('div', { class: 'form' }, withHelp(el('label', { class: 'check' }, box, t(name), el('span', { class: 'muted small' }, ` · ${t(count, { n: counts[key] })}`)), t(`${name}.help`), t(name)));
  });
  refresh();
  return el('div', {}, el('details', { class: 'guide options-more' }, summary, ...boxes), formulasBox(ctx, counts.formulas));
}

// La case des formules : hors du repli, jamais cochée sans que la personne ait lu le message. Rien à envoyer (aucune colonne
// de formule) : grisée, sauf si l'export les envoie déjà (on peut alors la décocher).
function formulasBox(ctx, count) {
  const box = el('input', {
    type: 'checkbox', checked: ctx.elements.formulas, disabled: !count && !ctx.elements.formulas,
    onchange: async () => {
      if (box.checked && !(await formulasWarning())) box.checked = false;
      ctx.elements.formulas = box.checked;
    },
  });
  return el('div', { class: 'form formulas-box' },
    withHelp(el('label', { class: 'check' }, box, t('send.el.formulas'), el('span', { class: 'muted small' }, ` · ${t('send.el.formulas.count', { n: count })}`)), t('send.el.formulas.help'), t('send.el.formulas')));
}

// Le message avant d'envoyer des formules : du Python, que seul un propriétaire du document destinataire peut poser, après les
// avoir lues.
const formulasWarning = () => confirmDialog({
  title: t('send.formulas.title'), confirmLabel: t('send.formulas.confirm'), kind: 'btn-primary',
  body: [el('p', {}, t('send.formulas.intro')), el('ul', {}, ['own', 'run', 'refused', 'initial', 'sandbox', 'slow'].map(k => el('li', {}, t(`send.formulas.${k}`))))],
});

// 2. Colonnes, par table, et ce que le widget ajoutera pour la synchro.
async function showColumns(ctx) {
  const schema = await readSchema();
  const relays = receivedDests(schema).map(d => d.dest);
  const report = ctx.report = el('div', { class: 'report' });
  ctx.refresh = null;
  const blocks = ctx.chosen.map(table => columnsBlock(ctx, schema, table, relays.includes(table)));
  // Ce que le widget ajoute aux tables de l'export, celles ajoutées pour un lien comprises (la ligne suit les choix).
  const addsNode = el('p', { class: 'muted small' });
  const showAdds = (tables) => {
    const adds = tables.flatMap(table => missingSyncColumns(schema.columns(table)).map(col => `${table}.${col}`));
    if (!ownsSync(schema)) adds.push(t('send.check.sync'));
    addsNode.textContent = adds.length ? t('send.check.missing', { items: adds.join(', ') }) : '';
    addsNode.classList.toggle('hidden', !adds.length);
  };
  const links = linkSection(ctx, schema, showAdds) || (showAdds(ctx.chosen), null);
  const removed = ctx.exp ? ctx.exp.tables.map(tb => tb.table).filter(table => !ctx.chosen.includes(table)) : [];
  const elementsNode = await elementsBlock(ctx, schema);
  const next = () => {
    if (ctx.chosen.some(table => !(ctx.selected.get(table) || []).length)) throw new Error('noColumn');
    showName(ctx);
  };
  ctx.wizard.show(1, [el('p', {}, t('send.columns.help')),
    removed.length ? message('warn', t('send.edit.removed', { tables: removed.join(', ') })) : null,
    ...blocks, ...(links || []), elementsNode, autoColsBlock(ctx), addsNode, report, stepHelp(['s-columns'])], [
    backButton(() => showTables(ctx)), cancel,
    { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
}

// Échange administré ici : ce que ce document fait de chaque type de changement reçu des
// participants (`ctx.rules`, voir exchangeRules), et d'un refus. Le choix du refus ne se montre
// que si un type n'est pas accepté d'office.
function rulesBlock(ctx) {
  const rules = exchangeRules(ctx.exp) || { ajout: RULES[0], modif: RULES[0], suppression: RULES[0], refus: REFUSALS[0] };
  ctx.rules = { ...rules, ...ctx.rules };
  const refusal = el('div', { class: 'form', role: 'radiogroup', 'aria-labelledby': 'gristsync-refusal-title' },
    withHelp(el('p', { class: 'field-title', id: 'gristsync-refusal-title' }, t('send.refusal.title')), t('send.refusal.help')),
    REFUSALS.map(value => el('label', { class: 'check' },
      el('input', { type: 'radio', name: 'gristsync-refusal', value, checked: ctx.rules.refus === value, onchange: () => { ctx.rules.refus = value; } }),
      t(`send.refusal.${value}`))));
  const showRefusal = () => refusal.classList.toggle('hidden', STATES.every(st => ctx.rules[st] === RULES[0]));
  const pickers = el('div', { class: 'rules-grid' }, STATES.map(st => [el('span', {}, t(`send.rules.${st}`)), pickField({
    items: RULES.map(value => ({ value, label: t(`send.rules.${value}`) })), value: ctx.rules[st], label: t(`send.rules.${st}`),
    onChange: (value) => { ctx.rules[st] = value; showRefusal(); },
  })]));
  showRefusal();
  return el('div', { class: 'form table-block' }, withHelp(el('h3', {}, t('send.rules.title')), t('send.rules.help')), pickers, refusal);
}

// 3. Nom, puis création (ou enregistrement) : c'est ici seulement que le widget écrit.
function showName(ctx) {
  const fallback = ctx.chosen.join(' + ');
  const nameInput = ctx.nameInput = el('input', { type: 'text', class: 'input', id: 'gristsync-export-name', value: ctx.exp ? ctx.exp.name : fallback });
  const report = ctx.report = el('div', { class: 'report' });
  const hub = ctx.exp && ctx.exp.echange && !ctx.exp.retour;
  ctx.wizard.show(2, [el('label', { for: 'gristsync-export-name' }, t('send.name')), nameInput, el('p', { class: 'muted small' }, t('send.name.help')),
    hub ? rulesBlock(ctx) : null, report], [
    backButton(() => run(null, report, () => showColumns(ctx))), cancel,
    { label: ctx.exp ? t('common.save') : t('send.create'), kind: 'btn-primary', onClick: () => run(null, report, () => save(ctx, nameInput.value.trim() || fallback, report)) }]);
}

// Les choix de la personne : par table, ses colonnes cochées et son filtre (saveChosenExport les écrit), les tables ajoutées
// pour un lien (avec ce que la personne y prend : la colonne affichée seule, toute la table ou ses colonnes cochées) et les colonnes qui gardent leur lien.
async function choicesOf(ctx) {
  const schema = await readSchema();
  const offers = ctx.exp?.echange ? null : offersOf(ctx, schema);
  const added = offers ? [...offers.pulled].map(([table, required]) => ({ table, columns: pulledColumns(ctx, schema, table, required), filter: ctx.filters.get(table) || null })) : [];
  const explicit = ctx.chosen.map(table => ({ table, columns: ctx.selected.get(table), filter: ctx.filters.get(table) || null }));
  return { selection: [...explicit, ...added], links: new Set(offers ? offers.rows.filter(r => r.link).map(r => r.key) : []) };
}

// « Enregistrer » de la fenêtre « Quitter ? » : ce qui est choisi à cet instant, sans passer par les étapes qui restent. Les choix
// des étapes jamais ouvertes sont ceux de l'export enregistré (`showColumns` les pose). Une erreur reste affichée dans la fenêtre,
// qui reste « à enregistrer ».
async function quickSave(ctx) {
  await run(null, ctx.report, async () => {
    if (!ctx.elements) await showColumns(ctx);
    if (!ctx.chosen.length || ctx.chosen.some(table => !(ctx.selected.get(table) || []).length)) throw new Error('noColumn');
    await save(ctx, (ctx.nameInput && ctx.nameInput.value.trim()) || ctx.exp.name, ctx.report);
  });
}

async function save(ctx, name, report) {
  const { exp } = ctx;
  const { selection, links } = await choicesOf(ctx);
  const saved = await saveChosenExport({ exp, name, selection, links, ...ctx.elements, rules: ctx.rules, autoCols: Boolean(ctx.autoCols) });
  ctx.wizard.clean(); // enregistré : plus rien à perdre en fermant
  return exp ? showEdited(ctx, { name, changed: saved.changed, report }) : showCreated(ctx, { name, created: saved.created });
}

// Export créé : la fenêtre propose d'ajouter tout de suite une personne.
async function showCreated({ wizard, onClose }, { name, created }) {
  wizard.show(3, [message('ok', t('send.created', { name })), el('p', {}, t('send.created.next'))], [
    laterButton(),
    { label: t('send.action.addPerson'), kind: 'btn-primary', onClick: () => { wizard.close(); recipientWizard(created, null, onClose); } }]);
}

// Export modifié : webhooks renommés, tables changées renvoyées. Fenêtre fermée pendant le
// renvoi, qui continue : l'onglet se redessine à la fin.
async function showEdited({ exp, wizard, onClose }, { name, changed, report }) {
  if (changed.length) wizard.show(3, [report, el('p', { class: 'muted small' }, t('send.load.background'))], closeButtons());
  const n = await finishEdit(exp, { name, changed }, progressTo(report));
  if (changed.length && !report.isConnected) return onClose && onClose();
  const saved = n === null ? message('info', t('send.load.queued')) : message('ok', n ? t('send.edit.saved', { n }) : t('send.edit.savedNone'));
  return wizard.show(3, saved, closeButtons());
}
