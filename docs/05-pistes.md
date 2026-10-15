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

## Faites le 15 octobre 2026 (version 0.4)

- Exports : un nom, des tables et leurs colonnes ; des destinataires ajoutés un à un, révocables
  un à un, sans refaire l'export.
- Une seule table technique côté SOURCE (`Synchro`), quel que soit le nombre d'exports et de
  tables ; un webhook par destinataire, filtré par Grist sur son export.
- Ajouter une table à un export : la CIBLE la range (nouvelle table ou existante) dans une fenêtre,
  ou la refuse. Un journal et un formulaire par export côté CIBLE.
- Un renvoi des mêmes valeurs ne défait plus une retouche faite à la main dans la CIBLE.
- `Supprime` n'est plus ajoutée : prise en compte seulement si la table l'a déjà.

## Encore possibles, sans alourdir l'outil

1. **Échange (synchro dans les deux sens)** : choisi par Antoine le 15 octobre, après les exports.
   Deux exports croisés entre deux documents, avec une règle de conflit simple et un test d'écho
   (une ligne reçue ne doit pas repartir vers son document d'origine).
2. **Filtre de lignes par table** : n'envoyer que les lignes qui passent une condition simple
   (colonne = valeur). La formule du lot le permet : une ligne qui sort du filtre part une
   dernière fois marquée supprimée.
3. **Valeurs de Référence à jour tout de suite** : aujourd'hui, une valeur affichée par une
   Référence part à la prochaine modification de sa ligne. Un renvoi des lignes concernées, quand
   la table référencée change, réglerait ce cas.

## À éviter, pour rester simple

- Des notifications par courriel : il faudrait un service tiers.
- Un tableau de bord multi-documents : chaque document reste maître de ses branchements.
