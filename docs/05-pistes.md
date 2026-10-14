# Pistes pour la suite

Tri par rapport coût / utilité, en gardant l'outil simple. Rien de ceci n'est commencé.

## Déjà décidé pour la V0.2

- **Lien public, un seul code.** La SOURCE partage son document en lecture « toute personne ayant
  le lien », la CIBLE lit par l'API REST anonyme (vérifié en local : réponse 200 et en-tête
  `Access-Control-Allow-Origin: *`). Pas de webhook, pas de réponse à renvoyer. À vérifier : que
  l'instance DINUM autorise ce partage.

## Petites, utiles, sans nouvel écran

1. **Alerte de schéma.** Quand la table SOURCE gagne une colonne, la file se bloque
   (`400 Invalid column`). La carte SOURCE pourrait le dire en clair (« la colonne Téléphone
   n'existe pas chez le destinataire ») au lieu du message brut de Grist.
2. **Vraies suppressions dans l'historique.** L'historique CIBLE montre les ajouts, modifications
   et suppressions logiques ; les lignes effacées par la liste des clés n'y figurent pas encore.
3. **« Ajoutée » ou « modifiée ».** L'historique dit « modifiée » pour une ligne nouvelle ; la
   distinction est possible en regardant si la clé existait avant.
4. **Libellé de ligne choisi.** L'historique nomme la ligne par sa première colonne ; un choix de
   colonne (dans les Réglages) aiderait quand c'est un code.
5. **Dernier envoi réussi** sur la carte SOURCE (Grist le fournit dans l'état du webhook).

## Moyennes, à discuter

6. **Rattacher les lignes existantes.** Quand la destination est un référentiel déjà rempli, les
   lignes déjà présentes sont aujourd'hui doublées. Choisir une colonne commune (un SIRET, un
   code INSEE) permettrait de remplir `id_sync` sur les lignes existantes au premier passage.
7. **Correspondance de colonnes.** Recevoir `Ville` dans une colonne `Commune` existante, sans
   renommer.
8. **Vue filtrée par destinataire** (piste vérifiée en local avec Grist 1.7) : une table
   résumé par `id_sync` avec une condition, pour n'envoyer qu'une partie des lignes à un
   destinataire.

## À éviter, pour rester simple

- Une synchro dans les deux sens : conflits, droits croisés, file bloquante des deux côtés.
- Des notifications par courriel : il faudrait un service tiers.
- Un tableau de bord multi-documents : chaque document reste maître de ses branchements.
