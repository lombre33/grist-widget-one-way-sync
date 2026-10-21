// SOURCE : assistant d'export, en trois étapes (Tables, Colonnes, Nom). Crée l'export, ou le
// modifie (`exp`) : ajouter ou retirer des tables, changer les colonnes ou le nom vaut pour tous
// ses destinataires.
import { SYNC_TABLE, isUserTable, nowS, randomHex } from '../logic/common.js';
import { exportEmail, exportableColumns, hookName, isFileColumn, readTables } from '../logic/exports.js';
import { linkTables, linkable } from '../logic/links.js';
import { hiddenTables } from '../logic/acl.js';
import { putExport } from '../logic/notes.js';
import { REFUSALS, RULES, exchangeRules } from '../logic/consolidation.js';
import { STATES } from '../logic/journal.js';
import { fillKeyActions, missingSyncColumns, prepareSourceActions } from '../logic/formulas.js';
import { apply, fetchRows, readSchema, renameWebhook } from '../grist.js';
import { recordEvent, saveExport, syncRows, updateSourceNote } from './synchro.js';
import { receivedDests } from '../logic/received.js';
import { resendTables } from './resend.js';
import { recipientWizard } from './recipient-wizard.js';
import { backButton, cancelButton, checkList, closeButtons, el, failure, laterButton, message, openWizard, pickField, run } from '../ui.js';
import { filterEditor, filterSummary } from './filter-editor.js';
import { roleGuide } from '../guide.js';
import { stepHelp } from '../tutorial.js';
import { t, typeName } from '../i18n.js';

const cancel = cancelButton();
const columnLabel = c => (c.label === c.id ? c.id : `${c.label} (${c.id})`);

// `onClose` : appelé à la fermeture (l'onglet se redessine).
export function exportWizard(exp, onClose) {
  const wizard = openWizard({
    title: exp ? t('send.edit.title', { name: exp.name }) : t('send.new'),
    steps: ['send.step.tables', 'send.step.columns', 'send.step.name'].map(k => t(k)),
    onClose,
  });
  wizard.start(() => showTables({
    exp, wizard, onClose,
    chosen: exp ? exp.tables.map(tb => tb.table) : [],
    selected: new Map(exp ? exp.tables.map(tb => [tb.table, tb.columns.map(c => c.id)]) : []), // table -> colonnes cochées
    filters: new Map(exp ? exp.tables.map(tb => [tb.table, tb.filter]) : []), // table -> filtre de lignes, ou null
  }));
}

// 1. Tables de l'export. Une table introuvable (renommée, effacée) en sort.
async function showTables(ctx) {
  const tables = (await readSchema()).tableIds.filter(isUserTable);
  ctx.chosen = ctx.chosen.filter(table => tables.includes(table));
  const report = el('div', { class: 'report' });
  const next = { label: t('common.next'), kind: 'btn-primary', disabled: !ctx.chosen.length, onClick: () => run(null, report, () => showColumns(ctx)) };
  const list = checkList({
    items: tables.map(id => ({ value: id, label: id })), checked: ctx.chosen, label: t('send.step.tables'),
    onChange: (values) => { ctx.chosen = values; next.disabled = !values.length; ctx.wizard.buttons([cancel, next]); },
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
      checked: ctx.selected.get(table), label: table, onChange: (values) => { ctx.selected.set(table, values); describe(); } }),
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

// Case « Garder les liens » (voir links.js), proposée quand une colonne Référence vise une autre
// table de l'export (hors Échange, où les colonnes vont dans les deux sens par leur nom). Cochée
// d'emblée pour un nouvel export ; pour un export modifié, telle que l'export l'est déjà.
function linksBlock(ctx, schema) {
  const usable = ctx.chosen.map(table => ({ table, columns: exportableColumns(schema.columns(table)) }));
  if (ctx.exp?.echange || !linkable(usable)) {
    ctx.links = false;
    return null;
  }
  if (ctx.links === undefined) ctx.links = ctx.exp ? ctx.exp.tables.some(tb => tb.columns.some(c => c.link)) : true;
  const box = el('input', { type: 'checkbox', checked: ctx.links, onchange: () => { ctx.links = box.checked; } });
  return el('div', { class: 'form' }, el('label', { class: 'check' }, box, t('send.links')), el('p', { class: 'muted small' }, t('send.links.help')));
}

// 2. Colonnes, par table, et ce que le widget ajoutera pour la synchro.
async function showColumns(ctx) {
  const schema = await readSchema();
  const relays = receivedDests(schema).map(d => d.dest);
  const report = el('div', { class: 'report' });
  const blocks = ctx.chosen.map(table => columnsBlock(ctx, schema, table, relays.includes(table)));
  const adds = ctx.chosen.flatMap(table => missingSyncColumns(schema.columns(table)).map(col => `${table}.${col}`));
  if (!schema.has(SYNC_TABLE)) adds.push(t('send.check.sync'));
  const removed = ctx.exp ? ctx.exp.tables.map(tb => tb.table).filter(table => !ctx.chosen.includes(table)) : [];
  const next = () => {
    if (ctx.chosen.some(table => !(ctx.selected.get(table) || []).length)) throw new Error('noColumn');
    showName(ctx);
  };
  ctx.wizard.show(1, [el('p', {}, t('send.columns.help')),
    removed.length ? message('warn', t('send.edit.removed', { tables: removed.join(', ') })) : null,
    ...blocks, linksBlock(ctx, schema),
    adds.length ? el('p', { class: 'muted small' }, t('send.check.missing', { items: adds.join(', ') })) : null, report, stepHelp(['s-columns'])], [
    backButton(() => showTables(ctx)),
    { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
}

// Échange administré ici : ce que ce document fait de chaque type de changement reçu des
// participants (`ctx.rules`, voir exchangeRules), et d'un refus. Le choix du refus ne se montre
// que si un type n'est pas accepté d'office.
function rulesBlock(ctx) {
  const rules = exchangeRules(ctx.exp) || { ajout: RULES[0], modif: RULES[0], suppression: RULES[0], refus: REFUSALS[0] };
  ctx.rules = { ...rules, ...ctx.rules };
  const refusal = el('div', { class: 'form', role: 'radiogroup', 'aria-labelledby': 'gristsync-refusal-title' },
    el('p', { class: 'field-title', id: 'gristsync-refusal-title' }, t('send.refusal.title')),
    REFUSALS.map(value => el('label', { class: 'check' },
      el('input', { type: 'radio', name: 'gristsync-refusal', value, checked: ctx.rules.refus === value, onchange: () => { ctx.rules.refus = value; } }),
      t(`send.refusal.${value}`))),
    el('p', { class: 'muted small' }, t('send.refusal.help')));
  const showRefusal = () => refusal.classList.toggle('hidden', STATES.every(st => ctx.rules[st] === RULES[0]));
  const pickers = el('div', { class: 'rules-grid' }, STATES.map(st => [el('span', {}, t(`send.rules.${st}`)), pickField({
    items: RULES.map(value => ({ value, label: t(`send.rules.${value}`) })), value: ctx.rules[st], label: t(`send.rules.${st}`),
    onChange: (value) => { ctx.rules[st] = value; showRefusal(); },
  })]));
  showRefusal();
  return el('div', { class: 'form table-block' }, el('h3', {}, t('send.rules.title')), el('p', { class: 'small' }, t('send.rules.help')), pickers, refusal);
}

// 3. Nom, puis création (ou enregistrement) : c'est ici seulement que le widget écrit.
function showName(ctx) {
  const fallback = ctx.chosen.join(' + ');
  const nameInput = el('input', { type: 'text', class: 'input', id: 'gristsync-export-name', value: ctx.exp ? ctx.exp.name : fallback });
  const report = el('div', { class: 'report' });
  const hub = ctx.exp && ctx.exp.echange && !ctx.exp.retour;
  ctx.wizard.show(2, [el('label', { for: 'gristsync-export-name' }, t('send.name')), nameInput, el('p', { class: 'muted small' }, t('send.name.help')),
    hub ? rulesBlock(ctx) : null, report], [
    backButton(() => run(null, report, () => showColumns(ctx))),
    { label: ctx.exp ? t('common.save') : t('send.create'), kind: 'btn-primary', onClick: () => run(null, report, () => save(ctx, nameInput.value.trim() || fallback, report)) }]);
}

// Tables prêtes à partir (id_sync, MajLe…) et leurs colonnes choisies. Une table reçue (relais)
// garde la clé de son document d'origine : une ligne ajoutée ici à la main reste sans clé, donc
// locale (avec une clé, la prochaine liste de l'origine, qui ne la connaît pas, l'effacerait).
// Un seul instantané suffit : chaque étape ne touche que sa table, et les colonnes que le widget
// ajoute ne sont pas envoyables.
async function prepareTables(ctx) {
  const schema = await readSchema();
  const relays = receivedDests(schema).map(d => d.dest);
  const tables = [];
  for (const table of ctx.chosen) {
    await apply(prepareSourceActions(table, missingSyncColumns(schema.columns(table))));
    if (!relays.includes(table)) await apply(fillKeyActions(table, await fetchRows(table), () => crypto.randomUUID()));
    const columns = exportableColumns(schema.columns(table)).filter(c => ctx.selected.get(table).includes(c.id));
    tables.push({ table, columns, filter: ctx.filters.get(table) || null });
  }
  return linkTables(tables, Boolean(ctx.links));
}

async function save(ctx, name, report) {
  const { exp } = ctx;
  const tables = await prepareTables(ctx);
  if (exp?.public) await refuseHidden(tables);
  const id = exp ? exp.id : randomHex(8);
  const changed = await saveExport(id, tables, { isPublic: Boolean(exp?.public), swap: Boolean(exp?.echange) });
  await noteExport(ctx, id, name);
  return exp ? showEdited(ctx, { name, changed, report }) : showCreated(ctx, { id, name, tables });
}

// Export partagé par lien public : rien de ce qu'une règle d'accès cache ne doit s'y ajouter.
async function refuseHidden(tables) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const hidden = hiddenTables(resources, rules, readTables(tables));
  if (hidden.length) throw failure('publicHiddenEdit', { tables: hidden.join(', ') });
}

// Nom et date de l'export dans la note SOURCE. Règles d'un Échange administré ici : notées
// seulement si elles ne sont pas toutes « Accepter ».
async function noteExport({ exp, rules: chosen }, id, name) {
  const rules = chosen ? exchangeRules({ regles: chosen, refus: chosen.refus }) : undefined;
  await updateSourceNote((note) => {
    const entry = { at: nowS(), ...note.exports.find(e => e.id === id), id, name };
    if (chosen) Object.assign(entry, { regles: rules ? Object.fromEntries(STATES.map(st => [st, rules[st]])) : undefined, refus: rules?.refus });
    return putExport(note, JSON.parse(JSON.stringify(entry)));
  });
}

// Export créé : la fenêtre propose d'ajouter tout de suite une personne.
async function showCreated({ wizard, onClose }, { id, name, tables }) {
  const created = { id, name, tables, recipients: [], invitations: [], public: false, email: exportEmail(await syncRows(), id) };
  wizard.show(3, [message('ok', t('send.created', { name })), el('p', {}, t('send.created.next'))], [
    laterButton(),
    { label: t('send.action.addPerson'), kind: 'btn-primary', onClick: () => { wizard.close(); recipientWizard(created, null, onClose); } }]);
}

// Export modifié : webhooks renommés, tables changées renvoyées. Fenêtre fermée pendant le
// renvoi, qui continue : l'onglet se redessine à la fin.
async function showEdited({ exp, wizard, onClose }, { name, changed, report }) {
  await recordEvent(exp.id, changed.length ? 'editSent' : 'edit', { n: changed.length });
  if (name !== exp.name) for (const h of exp.recipients) await renameWebhook(h.id, hookName(name, exp.id));
  if (changed.length) wizard.show(3, [report, el('p', { class: 'muted small' }, t('send.load.background'))], closeButtons());
  const n = changed.length ? await resendTables(exp.id, changed, report) : 0;
  if (changed.length && !report.isConnected) return onClose && onClose();
  const saved = n === null ? message('info', t('send.load.queued')) : message('ok', n ? t('send.edit.saved', { n }) : t('send.edit.savedNone'));
  return wizard.show(3, saved, closeButtons());
}
