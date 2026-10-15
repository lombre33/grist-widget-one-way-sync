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

## Faites le 15 octobre 2026 (version 0.5)

- **Échange** : deux documents se tiennent à jour l'un l'autre, pour un destinataire. La
  modification la plus récente l'emporte des deux côtés, une ligne reçue ne repart pas vers son
  document d'origine. Branchement en deux codes : l'invitation porte le lien de retour, la réponse
  branche les deux sens d'un coup.
- **Filtre de lignes par table** (colonne = valeur) : une ligne qui sort du filtre part une
  dernière fois marquée supprimée, et revient si elle y rentre.
- **Tables sans limite de 20 000 lignes** : la liste des clés est remplacée par 256 empreintes,
  la CIBLE ne compare que les seaux qui changent, et un renvoi envoie la liste complète par
  morceaux (vérifié avec 21 000 lignes).
- **Destination renommée dans la CIBLE** : une table ou une colonne de destination renommée est
  suivie par sa référence, la recopie continue.
- **Annulation (Ctrl+Z) dans la SOURCE** : la valeur rétablie repart, la CIBLE revient à la valeur
  d'avant.
- **Un formulaire par réception, sur sa propre page** rangée sous celle du widget (la page du
  widget est repliée une fois le lien donné) : une clé n'atteint qu'un journal. « Tester le lien »
  vérifie que le lien écrit bien dans ce journal-là.
- **Garde-fous** : lignes forgées rejetées et signalées (« Arrivées suspectes »), bouton « Couper
  le lien », reprise de la même réception par une nouvelle invitation après confirmation ; un
  renvoi à la fois par document, budget de renvoi avec heure de reprise affichée, relecture de la
  CIBLE seulement quand il arrive quelque chose ; en lien public, la note de la SOURCE n'est plus
  lisible.
- Boutons de la CIBLE grisés d'emblée pour un lecteur.

## Encore possibles, sans alourdir l'outil

1. **Échange à plusieurs** : aujourd'hui un export en Échange n'a qu'un destinataire. Plusieurs
   demanderaient de choisir quoi faire d'une modification venue de l'un pour les autres.
2. **Nom des documents sur les cartes** : le jeton du widget ne lit pas la fiche du document
   (vérifié), la carte montre donc l'identifiant court. Il faudrait que la personne le saisisse.
3. **Ligne de plus de 1 Mo** : non découpée (choix d'Antoine du 15 octobre), la carte la signale.

Écarté par Antoine le 15 octobre : vérifier le code de réponse dès qu'il est collé, sans attendre
le bouton.

## À éviter, pour rester simple

- Des notifications par courriel : il faudrait un service tiers.
- Un tableau de bord multi-documents : chaque document reste maître de ses branchements.
