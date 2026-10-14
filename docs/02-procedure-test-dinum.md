# Test DINUM : la synchro sans serveur passe-t-elle sur grist.numerique.gouv.fr ?

**Ce que le test tranche** : est-ce qu'un webhook d'un document peut écrire, via la clé d'un
formulaire, dans un autre document de la même instance DINUM. Si oui, la synchro « sans serveur »
de l'étude (`docs/01-etude-faisabilite.md`) fonctionne là-bas.

**Durée** : 10 à 15 minutes. **Il faut** : être propriétaire des deux documents, et les créer dans
un **espace d'équipe** (pas « Espace personnel » : le lien du formulaire doit fonctionner sans être
connecté).

Les libellés ci-dessous sont ceux de l'interface Grist en français.

---

## Étape 1 : le document CIBLE

1. Crée un document vide, nommé par exemple `Test synchro cible`.
2. Il contient déjà une table `Table1` avec les colonnes `A`, `B`, `C`. Renomme-les **exactement** :
   - `A` devient `Nom` (double-clic sur l'en-tête de colonne, tape `Nom`, Entrée) ;
   - `B` devient `Ville` ;
   - supprime `C` (clic droit sur l'en-tête, Supprimer).
3. Renomme la table `Table1` en `Journal` : clique sur le titre de la vue en haut de la grille
   (`TABLE1`), puis dans le champ **NOM DE LA TABLE** tape `Journal` et valide. (Autre chemin :
   OUTILS, **Données source**, menu de la table, **Renommer la table**.)
4. Ajoute le formulaire : bouton **Ajouter**, **Ajouter une page**, « Choisir la vue » :
   **Formulaire**, « Choisir les données source » : **Journal**, puis valide.
5. Sur la page du formulaire, clique **Publier** (confirme), puis **Partager**, puis
   **Copier le lien**. Tu obtiens un lien de la forme :

   ```
   https://grist.numerique.gouv.fr/o/<équipe>/forms/<CLÉ>/<numéro>
   ```

   (le morceau `/o/<équipe>` peut être absent, c'est normal).

6. **Construis l'URL du webhook** à partir de ce lien : remplace `forms/<CLÉ>/<numéro>` par
   `api/s/<CLÉ>/tables/Journal/records?flat=1`, en gardant tout le début. Exemple :

   ```
   lien copié     : https://grist.numerique.gouv.fr/o/mon-equipe/forms/Ab12Cd34Ef56/2
   URL du webhook : https://grist.numerique.gouv.fr/o/mon-equipe/api/s/Ab12Cd34Ef56/tables/Journal/records?flat=1
   ```

   Garde cette URL pour l'étape 3. Ne la diffuse pas : elle permet d'écrire dans `Journal`.

## Étape 2 (facultative mais utile) : vérifier la clé seule, sans webhook

Ce contrôle sépare deux causes d'échec possibles (la clé et `?flat=1` d'un côté, le réglage des
webhooks de l'autre). Au choix :

**Depuis l'invite de commandes Windows (`cmd`)** : les guillemets intérieurs doivent être
précédés d'une barre oblique inverse, `cmd` ne comprenant pas les apostrophes :

```
curl -sS -X POST "<URL du webhook>" -H "Content-Type: application/json" -d "[{\"Nom\":\"Test curl\",\"Ville\":\"Paris\"}]"
```

**Depuis un terminal macOS ou Linux :**

```
curl -sS -X POST "<URL du webhook>" -H "Content-Type: application/json" -d '[{"Nom":"Test curl","Ville":"Paris"}]'
```

Une réponse `Unexpected token … is not valid JSON` veut seulement dire que les guillemets ont été
mal passés par le terminal (cas typique : la version macOS/Linux lancée dans `cmd`).

**Ou depuis le navigateur**, sur n'importe quelle page de grist.numerique.gouv.fr, ouvre la console
des outils de développement (F12, onglet Console) et colle :

```
fetch("<URL du webhook>", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify([{Nom: "Test console", Ville: "Paris"}])}).then(r => r.text()).then(console.log)
```

**Attendu** : une réponse `{"records":[{"id":1}]}` et une ligne « Test… / Paris » dans `Journal`.

| Réponse | Signification |
|---|---|
| `{"records":[{"id":…}]}` | La clé et `?flat=1` fonctionnent sur DINUM. Passe à l'étape 3. |
| `body.records is missing` | `?flat=1` est absent de l'URL, ou la version DINUM ne le connaît pas. Note-le et arrête-toi : c'est déjà une réponse. |
| `Share not known`, 404 ou 403 | Clé mal recopiée, formulaire non publié, ou document dans l'espace personnel. |
| `Invalid column` | Colonnes de `Journal` mal renommées (vérifie `Nom` et `Ville`). |

## Étape 3 : le document SOURCE et son webhook

1. Crée un second document vide, `Test synchro source`, dans le même espace d'équipe.
2. Fais exactement la même chose qu'à l'étape 1 points 2 et 3 : colonnes `Nom` et `Ville`, `C`
   supprimée. Appelle la table `Contacts`. **Aucune colonne Référence, aucune couleur
   conditionnelle** dans cette table : elles ajoutent des colonnes cachées qui font échouer
   l'envoi.
3. Panneau de gauche, OUTILS, **Paramètres**, section **API**, bouton **Gérer les points d'ancrage
   Web** (réservé aux propriétaires).
4. Remplis la carte vide :
   - **Nom** : `Test synchro`
   - **Table** : `Contacts`
   - **URL** : l'URL du webhook construite à l'étape 1 point 6
   - **Types d'événements** : coche `add` et `update`
   - **Activé** : coché
   - laisse vides « Colonne de déclenchement », le filtre de colonnes et « Entête de sécurité ».
5. Regarde le champ **Statut** de la carte juste après :
   - `Added` : le webhook est enregistré, continue ;
   - `Incomplete | … Provided url is forbidden` : **DINUM n'autorise pas son propre domaine**.
     C'est la réponse au test : la voie sans serveur est impossible sur DINUM. Tu peux t'arrêter.

## Étape 4 : le vrai test

1. Dans `Contacts` (SOURCE), ajoute une ligne : `Alice` / `Lyon`.
2. Attends 5 secondes, puis ouvre `Journal` (CIBLE) : une ligne `Alice` / `Lyon` doit être apparue.
3. Dans `Contacts`, change `Lyon` en `Marseille`. Une **deuxième** ligne `Alice` / `Marseille`
   doit arriver dans `Journal`. C'est normal : le journal empile les versions, la consolidation
   viendra ensuite.
4. Reviens sur la carte du webhook (SOURCE) et lis le champ **Statut** (un petit JSON). Repère
   `status`, `lastHttpStatus` et `lastErrorMessage`.

| Ce que tu vois | Ce que ça veut dire |
|---|---|
| Les lignes arrivent, `lastHttpStatus: 200` | **Ça marche sur DINUM.** |
| `retrying`, `400`, `Invalid column "X"` | Une colonne de `Contacts` n'existe pas dans `Journal` (souvent `C` oubliée). Aligne les colonnes. |
| `retrying`, `400`, `body.records is missing` | `?flat=1` manque dans l'URL du webhook. |
| `retrying`, `403` ou `404` | Clé ou formulaire (voir étape 2). |
| `retrying` avec une erreur réseau (`ECONNREFUSED`, `ETIMEDOUT`, `socket hang up`, code `407`) | L'URL est acceptée, mais le proxy sortant de DINUM bloque l'aller-retour vers l'instance elle-même. Voie sans serveur impossible en l'état. |
| `idle`, aucune erreur, mais rien n'arrive | Cas rare (envoi bloqué silencieusement côté serveur). Envoie-moi le Statut. |

## Étape 5 : ranger

- Webhook : décoche **Activé** ou supprime la carte.
- Formulaire de la CIBLE : **Dépublier** (la clé cesse alors d'accepter des écritures).
- Les deux documents peuvent être supprimés.

## Ce qu'il me faut en retour

L'étape où ça s'est arrêté, et le texte du champ **Statut** (ou une capture). Une seule ligne
suffit si tout a marché.

---

## Résultat du test réel du 14 octobre 2026 (Antoine, grist.numerique.gouv.fr)

**La chaîne fonctionne sur DINUM.**

- Étape 2 : `{"records":[{"id":3}]}` : la clé et `?flat=1` sont acceptés par l'instance.
- Étape 3 : webhook accepté à la création (Statut `{"status":"idle","numWaiting":0,"lastEventBatch":null}`,
  pas de « Provided url is forbidden ») : l'instance s'autorise elle-même dans
  `ALLOWED_WEBHOOK_DOMAINS`.
- Étape 4 : premier envoi livré à la CIBLE, qui a répondu `400 Invalid column "C"` : la colonne
  `C` par défaut était restée dans `Contacts`. L'aller-retour DINUM vers DINUM passe donc le proxy
  sortant.
- Supprimer `C` dans la SOURCE n'a pas suffi : l'envoi en échec, en tête de file, bloquait les
  suivants (`numWaiting: 6`). Après **Effacer la file d'attente**, les nouvelles lignes sont
  arrivées dans `Journal`. Les lignes envoyées avant l'effacement ne repartent pas d'elles-mêmes :
  il faut les retoucher.
- Sous l'invite de commandes Windows, il faut la variante `curl` avec guillemets échappés.

Toujours inconnus sur DINUM : Redis (persistance de la file en cas de redémarrage), comptes de
service, `REQUEST()`, plafond de lignes par document.
