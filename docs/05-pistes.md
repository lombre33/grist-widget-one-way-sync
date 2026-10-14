# Pistes pour la suite

## Faites le 14 octobre 2026

- Vue d'export en un bloc : colonnes choisies et modifiables à tout moment, sans bloquer la file ;
  la table SOURCE n'a plus besoin d'être « plate ».
- Mode lien public : un seul code, règles d'accès posées par le widget.
- Destination existante : correspondance des colonnes, rattachement des lignes déjà là par une
  colonne commune.
- Historique : ajoutées, modifiées, supprimées (vraies suppressions comprises), colonne affichée
  au choix.
- Carte SOURCE : dernier envoi reçu. Révoquer efface les tables techniques devenues inutiles ;
  la CIBLE peut arrêter la réception.

## Encore possibles, sans alourdir l'outil

1. **Filtre de lignes par table** : n'envoyer que les lignes qui passent une condition simple
   (colonne = valeur). La vue d'export le permet : une ligne qui sort du filtre part une dernière
   fois marquée supprimée.
2. **Colonnes différentes par destinataire** : aujourd'hui une table n'a qu'une vue d'export,
   commune à tous ses destinataires. Il faudrait une vue par destinataire.
3. **Ajouter une table à un envoi existant** : aujourd'hui, une nouvelle invitation.

## À éviter, pour rester simple

- Une synchro dans les deux sens : conflits, droits croisés, file bloquante des deux côtés.
- Des notifications par courriel : il faudrait un service tiers.
- Un tableau de bord multi-documents : chaque document reste maître de ses branchements.
