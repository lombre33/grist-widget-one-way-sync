# Tutoriel : brancher une synchro en dix minutes

Deux documents Grist de la même instance, dans un espace d'équipe :

- la **SOURCE**, qui a la table à partager (ici `Contacts` et `Villes`) ;
- la **CIBLE**, qui recevra une copie tenue à jour (ici `Contacts`, et `Communes`, une table qui
  existait déjà).

Il faut un **propriétaire** de la SOURCE et un **éditeur** de la CIBLE. Ils échangent deux codes,
par le canal de leur choix (courriel, messagerie). Aucune donnée ne passe par ce canal : seulement
le nom des tables et une adresse d'écriture.

Les captures viennent du test d'intégration (`CAPTURES=1 npm run test:e2e`) : elles montrent
l'écran tel qu'il est dans la version du dépôt.

## 0. Installer le widget (dans chaque document)

**Ajouter**, **Ajouter un widget**, **Personnalisé**, **URL personnalisée**, coller l'adresse du
widget, puis **Accès complet** dans l'onglet Widget du panneau de droite. Renommer la page, par
exemple « Synchro » : les tables techniques se rangeront dessous.

![Le widget à l'ouverture](images/01-accueil.png)

Au premier lancement, le widget demande le rôle du document. Ensuite il ouvre directement
**Recevoir** dans un document qui reçoit, **Envoyer** dans un document qui envoie.

## Côté SOURCE : inviter

### 1. Choisir les tables

**Envoyer**, **Nouveau destinataire**. Cocher les tables à partager (le filtre aide quand il y en
a beaucoup).

![Choix des tables](images/02-source-tables.png)

Le widget contrôle chaque table. Une table qui affiche une Référence par une autre colonne, qui a
une mise en forme conditionnelle ou des pièces jointes ne peut pas partir telle quelle : faire une
table « d'export » plate, qui ne contient que ce que la CIBLE a le droit de voir (les webhooks de
Grist ignorent les règles d'accès).

### 2. Préparer

Le widget dit exactement ce qu'il va ajouter et attend votre accord.

![Préparation](images/03-source-preparation.png)

- `id_sync` : identifiant stable de chaque ligne (les `id` de Grist sont réutilisés) ;
- `MajLe` : date de dernière modification, pour remettre les versions dans l'ordre ;
- `Supprime` : case à cocher pour retirer une ligne de la CIBLE sans l'effacer de la SOURCE ;
- `Synchro_<table>` : une table d'une ligne qui liste les `id_sync` existants, pour que les vraies
  suppressions partent aussi. Elle se range sous la page du widget, repliée.

### 3. Options

![Options](images/04-source-options.png)

Donner un nom à l'envoi : le destinataire le verra. Le **secret** (coché par défaut) garantit que la réponse vient de quelqu'un qui a reçu
l'invitation. Sans secret, l'approbation repose sur la seule fiche du destinataire, que vous
vérifiez à l'étape 5.

### 4. Copier l'invitation

![Invitation](images/05-source-invitation.png)

Envoyer ce code à la personne de la CIBLE. Il ne contient aucune donnée. **Plus tard** ferme
l'assistant : l'invitation reste en attente sur sa carte.

![Invitation en attente](images/06-source-attente.png)

## Côté CIBLE : accepter

### 5. Coller le code

**Recevoir**, **Accepter une invitation**, coller le code.

![Code](images/07-cible-code.png)

### 6. Choisir les destinations

Pour chaque table reçue, le nom de la table qui recevra les lignes. La liste propose les tables
du document : choisir une table existante (un référentiel déjà là) la complète des colonnes
manquantes et d'une colonne `id_sync` masquée, sans toucher à ses lignes actuelles. Le widget
demande confirmation.

![Destinations](images/08-cible-destinations.png)

Le widget crée alors un `Journal_<table>` par table (rangé sous sa page, replié) et publie sur sa
page un formulaire de réception par journal. Grist recharge le widget : l'assistant se rouvre de
lui-même à l'étape suivante.

### 7. Copier le lien du formulaire

Dans la carte d'**un** des formulaires apparus à côté du widget : **Partager**, **Copier le
lien**, coller ce lien dans le widget, **Tester le lien**. Un seul lien suffit pour toutes les
tables (les formulaires d'une même page partagent la même clé).

![Lien](images/09-cible-lien.png)

Ce lien est un **droit d'écriture** dans vos journaux : ne le diffusez pas ailleurs.

### 8. Renvoyer la réponse

![Réponse](images/10-cible-reponse.png)

Copier le code de réponse et le renvoyer à la SOURCE. Il contient l'adresse d'écriture et votre
fiche (e-mail, document, équipe).

## Côté SOURCE : approuver

### 9. Coller la réponse

Sur la carte de l'invitation, **Coller la réponse**. Le widget montre qui a accepté et vers quelles
tables : vérifier que c'est la bonne personne, puis **Approuver et brancher**.

![Fiche du destinataire](images/11-source-fiche.png)

### 10. Envoyer les lignes existantes

Les webhooks n'envoient que les changements à venir. **Tout envoyer** pousse les lignes déjà là.

![Envoi](images/12-source-envoi.png)

La carte du destinataire montre ensuite l'état des envois et les actions : **Tout renvoyer**,
**Mettre en pause**, **Débloquer la file** (quand un envoi échoue, Grist bloque toute la file du
document environ 15 minutes), **Révoquer**.

![Destinataire actif](images/13-source-actif.png)

## Au quotidien, côté CIBLE

Chaque ajout, modification ou suppression dans la SOURCE arrive dans le journal en une seconde
environ, même si personne n'a le widget ouvert. La **recopie** dans la table de destination se fait
quand un éditeur ouvre la page du widget (même replié), puis toutes les 10 secondes tant qu'elle
reste ouverte. Une fois les données arrivées, les formulaires se replient dans la barre en haut de
la page.

![Synchro à jour et historique](images/14-cible-historique.png)

La carte montre le propriétaire des données, le dernier passage par table, et les lignes modifiées
depuis votre dernière visite (20 au plus). Une retouche faite à la main dans la CIBLE reste en
place jusqu'à la prochaine modification de la même ligne dans la SOURCE.

## Si quelque chose coince

| Symptôme | Cause probable | Que faire |
|---|---|---|
| La carte SOURCE est rouge, « 400 Invalid column » | Une colonne a été ajoutée à la table SOURCE après le branchement | Ajouter la même colonne au journal de la CIBLE (et à la table de destination pour la recevoir), puis **Débloquer la file** et **Tout renvoyer** |
| Rien n'arrive dans la table de destination | Personne n'a ouvert la page du widget dans la CIBLE | Ouvrir la page ; les versions attendaient dans le journal |
| Tous les webhooks du document SOURCE sont en retard | Un envoi en échec bloque la file | **Débloquer la file** |
| Les lignes déjà présentes ne sont pas arrivées | Le branchement n'envoie que les changements | **Tout renvoyer** |
