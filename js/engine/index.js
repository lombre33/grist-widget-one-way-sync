// Point d'entrée du moteur : le branche (un port, un préfixe de tables) avant tout appel. Rien d'autre
// n'est à appeler ici : les écrans importent les modules dont ils ont besoin (source/, target/, logic/).
// Ce dossier ne dessine rien et ne lit ni `document`, ni `window`, ni `location`, ni `navigator`, ni le
// global `grist` (tests/unit/engine.test.mjs le vérifie).
import { setPort } from './port.js';
import { setTablePrefix } from './logic/common.js';

export { ENGINE_VERSION } from './version.js';
export { PORT_SHAPE } from './port.js';
export { TABLE_PREFIX_RULE } from './logic/common.js';

// `port` : voir engine/port.js. `prefix` : préfixe des tables que le moteur crée (Synchro, journaux,
// destinations proposées), vide par défaut : les noms d'avant, aucun document existant ne change. À
// donner une fois, avant le premier appel, et toujours le même pour un même document : changer de
// préfixe fait perdre de vue les tables créées avec l'ancien.
export function startEngine({ port, prefix = '' } = {}) {
  setTablePrefix(prefix);
  setPort(port);
}
