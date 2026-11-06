// Données de test communes aux scénarios (charge.mjs, betises.mjs) : 20 colonnes de tout genre, lignes reproductibles.
// 20 colonnes de données de tout genre ; `cols` en garde les premières.
export const COLUMNS = [
  { id: 'Nom', type: 'Text' }, { id: 'Prenom', type: 'Text' }, { id: 'Adresse', type: 'Text' }, { id: 'CP', type: 'Text' }, { id: 'Ville', type: 'Text' },
  { id: 'Pays', type: 'Text' }, { id: 'Email', type: 'Text' }, { id: 'Tel', type: 'Text' }, { id: 'Service', type: 'Text' }, { id: 'Commentaire', type: 'Text' },
  { id: 'Montant', type: 'Numeric' }, { id: 'Quantite', type: 'Int' }, { id: 'Taux', type: 'Numeric' }, { id: 'Score', type: 'Numeric' }, { id: 'Annee', type: 'Int' },
  { id: 'Naissance', type: 'Date' }, { id: 'Actif', type: 'Bool' }, { id: 'Statut', type: 'Choice' }, { id: 'Code', type: 'Text' }, { id: 'Note', type: 'Text' },
];
export const VILLES = ['Lyon', 'Paris', 'Nantes', 'Brest', 'Lille', 'Metz', 'Dijon', 'Rennes'];
export const makeRow = (i) => ({
  Nom: `Nom${i}`, Prenom: `Prénom ${i % 97}`, Adresse: `${i % 200} rue des Tests, bâtiment ${i % 13}`, CP: String(10000 + (i % 80000)).padStart(5, '0'),
  Ville: VILLES[i % VILLES.length], Pays: 'France', Email: `personne${i}@exemple.fr`, Tel: `06${String(10000000 + i).slice(-8)}`, Service: `Service numéro ${i % 41}`,
  Commentaire: `Commentaire de la ligne ${i}, avec un peu de texte pour faire du volume.`, Montant: i * 1.25, Quantite: i % 1000, Taux: (i % 100) / 100,
  Score: Math.sin(i), Annee: 1950 + (i % 70), Naissance: 86400 * (3650 + (i % 20000)), Actif: i % 3 === 0, Statut: ['A', 'B', 'C'][i % 3], Code: `C-${i}`, Note: `n${i}`,
});
export const columnsOf = n => COLUMNS.slice(0, n);

