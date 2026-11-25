// Ce que les deux volets de la copie unique partagent : les remarques du moteur, les cases des éléments copiés avec les colonnes, et la
// fenêtre qui fait lire les formules avant de les poser.
import { t } from '../i18n.js';
import { el, notice, openModal, withHelp } from '../ui.js';
import { ELEMENTS, elementHint, elementKey } from '../engine/logic/copy-elements.js';

const FOLD_FROM = 4; // au-delà, les remarques se replient

// Une section d'un volet : son titre, une phrase qui dit à quoi elle sert (facultative), puis son contenu.
export const section = (title, sub, ...nodes) => el('section', { class: 'sec' },
  el('div', {}, el('h3', { class: 'sec-title' }, t(title)), sub ? el('p', { class: 'sec-sub' }, t(sub)) : null), ...nodes);

// Le texte d'une remarque du moteur (`{ key, params }`).
export const warningText = warning => t(warning.key, warning.params);

// Les remarques en un seul avis (rien s'il n'y en a pas) ; replié quand elles sont nombreuses. `tone` : `warn` ou `info`.
export function warningsBlock(warnings, tone = 'warn') {
  if (warnings.length === 0) return null;
  const list = el('ul', { class: 'small copy-list' }, warnings.map(warning => el('li', {}, warningText(warning))));
  const body = warnings.length > FOLD_FROM ? el('details', {}, el('summary', { class: 'small' }, t('copy.ui.warnings', { n: warnings.length })), list) : list;
  return notice({ tone, body: [body] });
}

// Une case par élément de `elements`, avec son compte (`counts`) et son « ? ». Une case est cochée tant que l'élément n'est pas dans
// `omit` (un Set que les cases modifient) ; un élément que rien ne porte est grisé. `onChange(élément, case)` après chaque changement.
export function elementBoxes({ elements = ELEMENTS, counts, omit, onChange }) {
  return el('div', { class: 'opts' }, elements.map((element) => {
    const box = el('input', {
      type: 'checkbox', checked: counts[element] > 0 && !omit.has(element), disabled: counts[element] === 0,
      onchange: (event) => {
        if (event.target.checked) omit.delete(element); else omit.add(element);
        onChange(element, event.target);
      },
    });
    const label = el('label', { class: 'check' }, box, t(elementKey(element)), el('span', { class: 'muted small' }, ` · ${counts[element]}`));
    return withHelp(label, t(elementHint(element)), t(elementKey(element)));
  }));
}

// Une formule à lire : la colonne, de quelle sorte, ce qu'on en fera, le texte, et pourquoi elle est refusée s'il y a lieu.
function formulaView({ col }) {
  const refused = col.problems.length > 0;
  const kind = t(col.kind === 'formula' ? 'copy.formulas.kind.formula' : 'copy.formulas.kind.trigger');
  return el('li', { class: 'formula-item' },
    el('div', {}, el('strong', {}, col.id), el('span', { class: 'muted small' }, ` · ${kind} · ${t(refused ? 'copy.formulas.refused' : 'copy.formulas.ok')}`)),
    el('pre', { class: 'code formula-code' }, col.formula),
    refused ? el('ul', { class: 'small' }, col.problems.map(problem => el('li', {}, t(`recv.formulas.problem.${problem.code}`, { name: problem.name, to: problem.to || '' })))) : null);
}

// La fenêtre « Poser ces formules ? » : chaque formule du plan (`plan` : planImport avec `withFormulas`), puis une case « J'ai lu »
// sans laquelle le bouton reste grisé. Rend vrai si la personne confirme.
export function formulasDialog(plan) {
  const groups = plan.tables
    .map(table => ({ table: table.tableId, items: table.columns.filter(col => col.formula !== '').map(col => ({ col })) }))
    .filter(group => group.items.length > 0);
  return new Promise((resolve) => {
    let answered = false;
    const sure = el('input', { type: 'checkbox', onchange: () => modal.setButtons(buttons()) });
    const close = (value, m) => { answered = true; resolve(value); m.close(); };
    const buttons = () => [
      { label: t('common.cancel'), onClick: m => close(false, m) },
      { label: t('copy.formulas.confirm'), kind: 'btn-primary', disabled: !sure.checked, onClick: m => close(true, m) },
    ];
    const modal = openModal({
      title: t('copy.formulas.title'), width: 720, buttons: buttons(),
      onClose: () => { if (!answered) resolve(false); },
      body: el('div', { class: 'form' },
        el('p', { class: 'msg msg-warn' }, t('copy.formulas.intro')),
        groups.map(group => [el('h3', {}, t('copy.formulas.table', { table: group.table })), el('ul', { class: 'formula-list' }, group.items.map(formulaView))]),
        el('label', { class: 'check' }, sure, t('copy.formulas.read'))),
    });
  });
}
