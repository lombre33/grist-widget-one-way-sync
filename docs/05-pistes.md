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

## Faites le 15 octobre 2026 (version 0.4.1)

- Valeurs venues d'une autre table (Référence renommée, formule) envoyées tout de suite : `MajLe`
  suit les colonnes envoyées et leur texte affiché.
- Gros changements envoyés en entier : Grist note l'envoi coupé, le widget SOURCE envoie le reste
  seul dès qu'un propriétaire ouvre sa page ; un renvoi interrompu reprend où il s'était arrêté.
- Garde-fou des grandes tables (choisi par Antoine) : table de plus de 20 000 lignes refusée,
  lots d'un export qui se partagent la taille d'un envoi, file bloquée par un envoi trop gros
  vidée et renvoyée seule.

## Faites le 15 octobre 2026 (version 0.4.3, audit)

- Une table SOURCE renommée ou supprimée ne casse plus les autres tables de l'export ; la carte la
  signale, comme une colonne renommée, supprimée ou changée de type.
- Une colonne ajoutée plus tard à l'export n'écrase plus une colonne de même nom dans une
  destination existante : elle prend un nom libre.
- Le lien public ne pose plus de règle de refus sur un document public que le widget n'a pas
  partagé ; un document dont l'état public est inconnu (réseau) n'est plus modifié.
- Nettoyer un ancien montage n'efface plus que ses propres webhooks.
- « Débloquer la file » renvoie seul ce que la file abandonnée portait ; un renvoi interrompu
  avant sa première tranche reprend aussi.
- Une colonne `Supprime` qui contient « Non » ne supprime plus la ligne.
- Une table nommée `T` ou `D` ne casse plus les formules.
- Double clic sur un bouton de fenêtre : plus de webhook ni d'export en double.
- Type « Date et heure » avec fuseau accepté dans les invitations.
- Interface : types des colonnes affichés à côté de leur nom, confirmation avant les actions
  qui effacent, raisons affichées sur les boutons grisés, erreurs d'envoi expliquées (trop gros,
  colonne inconnue, lien refusé), espaces insécables et nombres à la française, crédits Grist
  Factory dans les Réglages, message clair si Grist ne répond pas au démarrage.

## Encore possibles, sans alourdir l'outil

1. **Échange (synchro dans les deux sens)** : choisi par Antoine le 15 octobre, après les exports.
   Deux exports croisés entre deux documents, avec une règle de conflit simple et un test d'écho
   (une ligne reçue ne doit pas repartir vers son document d'origine).
2. **Filtre de lignes par table** : n'envoyer que les lignes qui passent une condition simple
   (colonne = valeur). La formule du lot le permet : une ligne qui sort du filtre part une
   dernière fois marquée supprimée.
3. **Tables de plus de 20 000 lignes** : n'envoyer à chaque changement que les clés supprimées
   (une formule de déclenchement garde la liste précédente dans une ligne de `Synchro` qui ne part
   pas), et la liste complète seulement lors d'un renvoi, par morceaux. Couper la liste en
   morceaux ne suffit pas : un import touche tous les morceaux, que Grist regroupe en un envoi
   (vérifié le 15 octobre). Écarté pour l'instant par Antoine au profit du garde-fou.

4. **Destination renommée dans la CIBLE** : suivre le renommage d'une table ou d'une colonne de
   destination (aujourd'hui une table renommée n'est plus trouvée, et une colonne renommée est
   recréée sous son ancien nom).
   La note du journal garderait la référence de la table plutôt que son nom.
5. **Annulation (Ctrl+Z) dans la SOURCE** : vérifier qu'une annulation repart bien vers la
   CIBLE (`MajLe` est une formule de déclenchement ; une annulation la remet-elle à jour ?).
6. **Réponse vérifiée au collage** : contrôler le code de réponse dès qu'il est collé, sans
   attendre le bouton.
7. **Nom des documents** : afficher le nom du document SOURCE et CIBLE, plutôt que son
   identifiant, sur les cartes.

## À éviter, pour rester simple

- Des notifications par courriel : il faudrait un service tiers.
- Un tableau de bord multi-documents : chaque document reste maître de ses branchements.
