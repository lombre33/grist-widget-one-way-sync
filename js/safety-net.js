// Dernier filet (audit du 25 novembre 2026) : une erreur qu'aucun code n'a attrapée — un clic dont l'action échoue, une promesse
// oubliée — ne laisse plus l'écran muet. Elle est dite en tête de page, avec son texte lisible, jusqu'à ce que la personne la ferme.
// Ce n'est pas la manière de gérer une erreur : les erreurs prévues ont leur message à l'endroit de l'action (`run`), les boucles
// de fond ont leur propre garde (recopie de la CIBLE, relecture de la SOURCE). Ici, seulement ce qui serait resté sans un mot.
import { t } from './i18n.js';
import { setUncaughtReporter } from './guard.js';
import { el, errorText, noteError, unreachable } from './ui.js';

const ID = 'safety-net';

// Une promesse peut être rejetée avec n'importe quoi (texte, rien) : on en fait toujours une erreur lisible.
export const asError = reason => (reason instanceof Error ? reason : new Error(reason === undefined || reason === null ? 'unknown' : String(reason)));

// Une requête coupée par le rechargement du document (règles d'accès posées) n'est pas une panne : le widget se recharge et reprend, la page
// disparaît avant ce délai. Si elle est encore là, la requête a bien échoué et la personne doit le savoir.
export const RELOAD_GRACE_MS = 3000;

export function showUncaught(reason) {
  const e = asError(reason);
  noteError(e);
  if (!unreachable(e)) return display(e, console.error);
  console.warn(e);
  setTimeout(() => display(e, () => {}), RELOAD_GRACE_MS);
}

function display(e, report) {
  report(e);
  let box = document.getElementById(ID);
  if (!box) {
    box = el('div', { id: ID });
    const main = document.getElementById('main');
    if (main) main.before(box);
    else document.body.append(box);
  }
  const close = el('button', { class: 'btn btn-small', type: 'button', onclick: () => box.remove() }, t('common.close'));
  box.replaceChildren(el('div', { class: 'msg msg-err safety-net', role: 'alert' },
    el('p', {}, t('error.uncaught', { detail: errorText(e) })), close));
}

export function installSafetyNet(target = window) {
  setUncaughtReporter(showUncaught); // les clics dont l'action échoue (voir guard.js : le navigateur ne dit rien d'un refus de Grist)
  target.addEventListener('unhandledrejection', event => showUncaught(event.reason));
  target.addEventListener('error', (event) => {
    // Un script d'une autre origine (le script de l'API de Grist) ne donne pas de détail : rien d'utile à dire.
    if (event.error) showUncaught(event.error);
  });
}

