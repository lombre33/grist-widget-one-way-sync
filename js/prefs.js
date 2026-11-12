// Préférences de la personne dans le stockage local du navigateur : langue, thème, l'heure de sa
// dernière visite par document CIBLE (`visit.<docId>`, pour l'historique), un identifiant
// tiré au hasard pour ce navigateur (`browser`, voir chargeBusy) et l'heure d'un assistant à rouvrir après le rechargement
// du document (`wizard.<nom>`, voir askWizard). Aucune donnée du document n'y est écrite.
const PREFIX = 'gristsync.';

export function readPref(name) {
  try { return localStorage.getItem(PREFIX + name); } catch (e) { return null; }
}

export function writePref(name, value) {
  try { localStorage.setItem(PREFIX + name, value); return true; } catch (e) { return false; }
}

export function applyTheme() {
  const theme = readPref('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// Assistant à rouvrir après le rechargement du document : poser les règles d'accès de Synchro avant d'y écrire recharge
// Grist, donc le widget (voir protectSync). L'écran note l'heure AVANT la pose (le rechargement coupe le widget en plein appel) ;
// le widget qui repart rouvre l'assistant s'il l'est (`wizardAsked`, moins d'une minute après). Seule l'heure est gardée.
const WIZARD_MS = 60000;
export const askWizard = name => writePref(`wizard.${name}`, String(Date.now()));
export const dropWizard = name => writePref(`wizard.${name}`, '');
export function wizardAsked(name, { consume = false } = {}) {
  const at = Number(readPref(`wizard.${name}`));
  if (consume && at) dropWizard(name);
  return Number.isFinite(at) && at > 0 && Date.now() - at < WIZARD_MS;
}
