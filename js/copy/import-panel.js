// Copie unique, volet « Coller ici » : coller le texte, voir ce qu'il ferait dans ce document, choisir (une table du texte à créer ou à
// verser dans une table d'ici, les colonnes, ce qui est repris avec elles, les formules), puis créer. Rien n'est écrit avant le clic
// confirmé ; le plan est refait par le moteur au moment d'écrire (engine/copy.js).
import { t } from '../i18n.js';
import { confirmDialog, el, message, notice, run, withHelp } from '../ui.js';
import { isReadOnly } from '../grist.js';
import { importText, readCopyDocument } from '../engine/copy.js';
import { parseCodeView } from '../engine/logic/code-view-parse.js';
import { planImport } from '../engine/logic/copy-plan.js';
import { ELEMENTS } from '../engine/logic/copy-elements.js';
import { formulaApplies, isComputed } from '../engine/logic/copy-resolve.js';
import { elementBoxes, formulasDialog, section, warningsBlock } from './parts.js';
import { paintCardStatus, tableCard } from './import-card.js';

const SHOWN_ELEMENTS = ELEMENTS.filter(element => element !== 'formulas'); // les formules ont leur propre case
const TYPING_MS = 250; // attente après la dernière frappe avant de relire le texte

// Ce que la personne a décidé, gardé d'un dessin à l'autre : le texte collé, le but de chaque table, les colonnes et éléments laissés de côté.
export const newImportState = () => ({ text: '', targets: new Map(), excluded: new Map(), omit: new Set(), withFormulas: false, result: null });

const resetChoices = (imp, text) => Object.assign(imp, { text, targets: new Map(), excluded: new Map(), omit: new Set(), withFormulas: false });
const choicesOf = imp => ({ targets: imp.targets, excluded: imp.excluded, omit: imp.omit, withFormulas: imp.withFormulas });
const planOf = (view, extra = {}) => planImport(view.parsed, view.ctx.doc, { ...choicesOf(view.ctx.imp), ...extra });

// Les remarques du plan rangées par table du texte (celles qui nomment une table du plan) ; `loose` : celles qui ne vont à aucune carte.
function groupWarnings(plan) {
  const byTable = new Map(plan.tables.map(table => [table.sourceId, []]));
  const loose = [];
  for (const warning of plan.warnings) {
    const owner = plan.tables.find(table => table.sourceId === warning.table) ?? plan.tables.find(table => table.mode !== 'skip' && table.tableId === warning.table);
    if (owner) byTable.get(owner.sourceId).push(warning); else loose.push(warning);
  }
  return { byTable, loose };
}

// Ce qui sera fait, une phrase par table (les tables qui ont un problème n'y sont pas), puis les formules posées.
function summaryLines(plan, withFormulas) {
  const lines = plan.tables.filter(table => !table.problem).flatMap((table) => {
    if (table.mode === 'create') return [t('copy.import.plan.create', { table: table.tableId, n: table.columns.length })];
    if (table.mode === 'add' && table.columns.length > 0) return [t('copy.import.plan.add', { table: table.tableId, n: table.columns.length })];
    return [];
  });
  const formulas = plan.tables.flatMap(table => table.columns).filter(col => isComputed(col) && formulaApplies(col, withFormulas)).length;
  return formulas > 0 ? [...lines, t('copy.import.plan.formulas', { n: formulas })] : lines;
}

// Pourquoi on ne peut pas créer pour le moment (clé de texte), ou null.
function blockedBy(plan) {
  if (isReadOnly()) return 'copy.import.readOnly';
  if (plan.tables.some(table => table.problem)) return 'copy.import.blocked';
  return plan.work === 0 ? 'copy.import.nothing' : null;
}

// Ce qu'une copie réussie dit : les tables créées, celles qui ont reçu des colonnes, ce qui n'a pas pu suivre.
export function resultView(result) {
  const lines = [
    ...result.created.map(table => t('copy.import.done.created', { table: table.tableId, n: table.columns })),
    ...result.filled.map(table => t('copy.import.done.filled', { table: table.tableId, n: table.columns })),
    t('copy.import.done.undo'),
  ];
  return el('div', { class: 'form', 'data-copy-done': '' }, notice({ tone: 'info', title: t('copy.import.done'), lines }), warningsBlock(result.notes));
}

// La case des formules : cochée, elle ouvre la fenêtre qui les fait lire ; sans elle les colonnes calculées sont créées vides.
function formulasControl(view) {
  const { ctx } = view;
  const box = el('input', {
    type: 'checkbox',
    onchange: async (event) => {
      ctx.imp.withFormulas = false;
      if (event.target.checked) ctx.imp.withFormulas = await formulasDialog(planOf(view, { withFormulas: true }));
      paintAll(view);
    },
  });
  const count = el('span', { class: 'muted small' });
  const note = el('p', { class: 'muted small' });
  const label = el('label', { class: 'check' }, box, t('copy.import.formulas'), count);
  return { node: el('div', { class: 'form' }, withHelp(label, t('copy.import.formulas.help'), t('copy.import.formulas')), note), box, count, note };
}

function paintFormulas(view, plan) {
  const { box, count, note } = view.formulas;
  const n = plan.counts.formulas;
  if (n === 0) view.ctx.imp.withFormulas = false;
  box.checked = view.ctx.imp.withFormulas;
  box.disabled = n === 0 || !view.ctx.owner;
  count.textContent = n > 0 ? ` · ${t('copy.import.formulas.count', { n })}` : '';
  note.textContent = n === 0 ? t('copy.import.formulas.none') : (view.ctx.owner ? '' : t('copy.import.formulas.owner'));
}

// Les cases des éléments repris avec les colonnes : redessinées seulement quand ce qu'elles comptent change (pas à chaque frappe ni à chaque case).
function paintElements(view, plan) {
  const signature = JSON.stringify(plan.counts); // les cases gardent leur état : seul un autre compte les redessine (le focus reste où il est)
  if (signature === view.elementsSignature) return;
  view.elementsSignature = signature;
  view.boxes.elements.replaceChildren(section('copy.import.elements', 'copy.import.elements.sub',
    elementBoxes({ elements: SHOWN_ELEMENTS, counts: plan.counts, omit: view.ctx.imp.omit, onChange: () => paintAll(view) })));
}

// Tout ce qui dépend du plan, redessiné sur place : les champs que la personne est en train de remplir ne sont jamais remplacés.
function paintAll(view) {
  const plan = planOf(view);
  const { byTable, loose } = groupWarnings(plan);
  for (const table of plan.tables) paintCardStatus(view.cards.get(table.sourceId).status, table, byTable.get(table.sourceId));
  view.boxes.loose.replaceChildren(...[warningsBlock(loose)].filter(Boolean));
  paintElements(view, plan);
  paintFormulas(view, plan);
  const lines = summaryLines(plan, view.ctx.imp.withFormulas);
  view.boxes.summary.replaceChildren(...(lines.length > 0 ? [section('copy.import.plan', null, el('ul', { class: 'small copy-list' }, lines.map(line => el('li', {}, line))))] : []));
  const why = blockedBy(plan);
  view.action.button.disabled = Boolean(why);
  view.action.reason.textContent = why ? t(why) : '';
}

// Le clic sur « Créer » : confirmation (ce qui sera fait), puis écriture. Un échec relit le document (une table a pu arriver entre-temps).
async function createClicked(view) {
  const { ctx } = view;
  const confirmed = await confirmDialog({
    title: t('copy.import.confirm.title'), confirmLabel: t('copy.import.confirm.ok'), kind: 'btn-primary',
    body: [el('p', {}, t('copy.import.confirm.body')), el('ul', { class: 'small copy-list' }, summaryLines(planOf(view), ctx.imp.withFormulas).map(line => el('li', {}, line)))],
  });
  if (!confirmed) return;
  const done = await run(view.action.button, ctx.errors, () => importText(ctx.imp.text, choicesOf(ctx.imp)));
  if (!done) return ctx.reread();
  ctx.imp.result = { created: done.created, filled: done.filled, notes: done.notes };
  resetChoices(ctx.imp, '');
  return ctx.onDone();
}

// Le bouton « Créer dans ce document » et la raison pour laquelle il est grisé.
function actionControl(view) {
  const button = el('button', { class: 'btn btn-primary', type: 'button', onclick: () => createClicked(view) }, t('copy.import.create'));
  const reason = el('p', { class: 'muted small', 'aria-live': 'polite' });
  return { node: el('div', { class: 'card-actions' }, button, reason), button, reason };
}

// Ce que le texte collé ferait ici. `ctx` : { doc, imp, owner, errors, reread, onDone }.
function detailView(ctx) {
  if (ctx.imp.text.trim() === '') return el('p', { class: 'muted small' }, t('copy.import.empty'));
  const root = el('div', { class: 'form' });
  const parsed = parseCodeView(ctx.imp.text);
  const view = { ctx, parsed, cards: new Map(), boxes: { loose: el('div'), elements: el('div', { class: 'form' }), summary: el('div', { class: 'form' }) }, elementsSignature: '' };
  view.formulas = formulasControl(view);
  view.action = actionControl(view);
  const rebuild = (tableId) => {
    const fresh = detailView(ctx);
    root.replaceWith(fresh);
    fresh.querySelector(`[data-copy-table="${CSS.escape(tableId)}"] .mode-select`)?.focus(); // le focus reste sur le choix qu'on vient de faire
  };
  const cards = parsed.tables.map((table) => {
    const card = tableCard({ table, doc: ctx.doc, imp: ctx.imp, replan: () => paintAll(view), columnsChanged: () => paintAll(view), rebuild });
    view.cards.set(table.tableId, card);
    return card.node;
  });
  root.append(view.boxes.loose);
  if (parsed.tables.length > 0) {
    root.append(section('copy.import.tables', null, el('p', { class: 'muted small' }, t('copy.import.read', { n: parsed.tables.length })), ...cards),
      view.boxes.elements, view.formulas.node, view.boxes.summary, view.action.node);
  }
  paintAll(view);
  return root;
}

// Le volet : la zone où coller le texte, ce qu'il ferait, et les erreurs d'écriture. `ctx` : { doc, imp, owner, onDone } ; `onDone` redessine l'onglet
// quand des tables ont été créées (le document a changé).
export function importPanel(ctx) {
  const holder = el('div', { class: 'form' });
  const errors = el('div');
  const full = { ...ctx, errors };
  const paint = () => holder.replaceChildren(detailView(full));
  full.reread = async () => { full.doc = await readCopyDocument(); paint(); };
  const area = el('textarea', { class: 'code', rows: 10, spellcheck: 'false', placeholder: t('copy.import.placeholder'), 'aria-label': t('copy.import.text') });
  area.value = ctx.imp.text;
  const resultBox = el('div', {}, ctx.imp.result ? resultView(ctx.imp.result) : null);
  let timer = null;
  area.addEventListener('input', () => {
    resetChoices(ctx.imp, area.value); // les choix étaient ceux de l'ancien texte
    ctx.imp.result = null;
    resultBox.replaceChildren();
    clearTimeout(timer);
    timer = setTimeout(() => { errors.replaceChildren(); paint(); }, TYPING_MS);
  });
  paint();
  return el('div', { class: 'form' },
    resultBox, isReadOnly() ? message('info', t('copy.import.readOnly')) : null,
    section('copy.import.text', 'copy.import.text.help', area), holder, errors);
}
