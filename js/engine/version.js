// Version du moteur. Elle ne suit pas celle de Sync+ : elle change quand le moteur change ce qu'il
// attend du port, ce qu'il écrit dans les documents, ou le sens d'un champ des codes (CODE_FORMAT).
// Mineure : une fonction ou un réglage de plus, sans rien casser. Majeure : un port, un nom de table
// ou un format qui ne se lisent plus comme avant. Elle est dite dans GFS-ETAT.md avec le commit.
// 1.0.0 : le moteur sort de l'écran de Sync+ 0.13.2 (port, préfixe de tables, dossier à part).
export const ENGINE_VERSION = '1.0.0';
