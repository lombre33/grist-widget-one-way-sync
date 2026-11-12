// CIBLE : changements de structure que la SOURCE apporte à une table reçue (voir engine/logic/structure.js), avec leur
// détail, et le geste qui les accepte. Une colonne ajoutée à l'export attend un clic quand la réception « demande » ;
// ce qui n'est pas une décision d'ici (colonne que la SOURCE n'envoie plus, type changé) est seulement dit.
import { approveStructure, state, tableKey } from '../engine/target/loop.js';
import { confirmDialog, el, notice, run, smallButton } from '../ui.js';
import { t, typeName } from '../i18n.js';

// Une ligne de détail par changement : table reçue et destination, la colonne, ce qui se passe.
function details(group) {
  return group.note.tables.flatMap((entry) => {
    const found = (state.results.get(tableKey(group.journal, entry.table)) || {}).structure;
    if (!found) return [];
    const where = { table: entry.table, dest: entry.dest };
    return [
      ...found.held.map(c => ({ held: true, text: t('recv.structure.held.line', { ...where, col: c.label, to: c.to, type: typeName(c.type) }) })),
      ...found.gone.map(c => ({ held: false, text: t('recv.structure.gone.line', { ...where, col: c.id, to: c.to }) })),
      ...found.retyped.map(c => ({ held: false, text: t('recv.structure.retyped.line', { ...where, col: c.id, to: c.to, sent: typeName(c.sent), here: typeName(c.here) }) })),
    ];
  });
}

// L'avis de la carte, ou rien. `rerender` : redessin de l'onglet ; `out` : où montrer l'erreur d'un bouton.
export function structureNotes(group, { rerender, out, readOnly = false }) {
  if (group.waiting || group.public || group.note.mode === 'echange') return [];
  const items = details(group);
  if (!items.length) return [];
  const held = items.filter(i => i.held).length;
  const act = async (event, auto) => {
    if (auto && !(await confirmDialog({ title: t('recv.structure.auto.title'), body: t('recv.structure.auto.body'), confirmLabel: t('recv.structure.auto.confirm'), kind: 'btn-primary' }))) return;
    await run(event.currentTarget, out(), async () => { await approveStructure(group.journal, { auto }); await rerender(); });
  };
  const action = (label, auto, primary) => smallButton(label, auto ? 'settings' : 'check', e => act(e, auto), { kind: primary ? 'btn-primary' : '', disabled: readOnly });
  return [notice({
    tone: held ? 'warn' : 'info', className: 'structure', 'data-structure': held ? 'held' : 'info',
    title: held ? t('recv.structure.held.title', { n: held }) : t('recv.structure.info.title'),
    lines: [t(held ? 'recv.structure.held.body' : 'recv.structure.info.body')],
    body: [el('ul', { class: 'small structure-list' }, ...items.map(item => el('li', {}, item.text)))],
    actions: [action(t(held ? 'recv.structure.apply' : 'recv.structure.ok'), false, true), group.note.ask ? action(t('recv.structure.auto.action'), true, false) : null].filter(Boolean),
  })];
}
