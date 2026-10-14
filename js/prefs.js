// Préférences d'affichage de la personne (langue, thème), dans le stockage local du navigateur.
// Rien d'autre n'y est jamais écrit : aucune donnée du document ne sort de Grist.
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
