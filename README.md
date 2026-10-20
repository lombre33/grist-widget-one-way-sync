<div align="center">

<img src="img/grist-factory-logo.jpg" alt="" width="56" height="56">

# Synchro Grist

**Recopiez des tables d'un document Grist dans un autre, tenues à jour toutes seules.**<br>
Sans serveur à héberger, sans dépendance, et seules les colonnes que vous choisissez sortent.

**Français** · [English](README.en.md)

<img src="docs/images/14-cible-historique.png" width="820" alt="Le widget dans le document qui reçoit : l'export « Annuaire » est à jour et liste les lignes ajoutées, modifiées et supprimées depuis la dernière visite">

<sub>Version 0.11.3 · Grist 1.7.11 ou plus récent · licence GPL-3.0 · Grist Factory</sub>

</div>

## À quoi ça sert

Un service tient une table de référence dans Grist (contacts, établissements, nomenclature) et
d'autres équipes en ont besoin dans leurs propres documents. Synchro Grist leur en envoie une copie
qu'elles peuvent compléter, et la met à jour à chaque ajout, modification ou suppression dans
l'original.

- **Rien à héberger** : c'est Grist qui transporte les changements, même quand personne n'a le
  document ouvert.
- **Vous choisissez ce qui sort** : les tables, les colonnes et, en option, les lignes.
- **Chaque destinataire à part** : on en ajoute, on en met un en pause, on en révoque un sans
  toucher aux autres.
- **Dans les deux sens si besoin** : en mode Échange, deux documents se tiennent à jour l'un
  l'autre ; à plusieurs, un document administre, relaie entre les participants et peut garder
  leurs changements à valider ou les refuser.

## Comment ça marche

```mermaid
flowchart LR
  A["Tables partagées<br>(colonnes choisies)"] --> B["Table technique<br>Synchro"]
  B -- "webhook Grist,<br>à chaque changement" --> C["Journal<br>de réception"]
  C -- "le widget,<br>page ouverte" --> D["Tables recopiées,<br>éditables"]
  subgraph SOURCE["Document SOURCE"]
    A
    B
  end
  subgraph CIBLE["Document CIBLE"]
    C
    D
  end
```

Le document qui envoie (la **SOURCE**) et celui qui reçoit (la **CIBLE**) ont chacun le widget.
Dans la SOURCE, il prépare les lignes modifiées dans une seule table technique ; un webhook de
Grist les pousse aussitôt dans le journal de la CIBLE, par un formulaire qu'elle a publié pour
cela. Dans la CIBLE, le widget contrôle ce qui arrive et le recopie dans des tables normales dès
qu'un éditeur ouvre sa page. Le détail est dans [`docs/06-architecture.md`](docs/06-architecture.md).

## Brancher une synchro en trois étapes

Deux codes à copier-coller entre les deux personnes. Ils ne contiennent aucune donnée.

<table>
<tr>
<td width="33%" valign="top">
<img src="docs/images/readme/03-source-colonnes.png" alt="Nouvel export : choix des colonnes qui partent">
<br><b>1. SOURCE : créer l'export</b><br>
Choisir les tables et les colonnes, puis ajouter un destinataire. Le widget donne un
<b>code d'invitation</b>.
</td>
<td width="33%" valign="top">
<img src="docs/images/readme/08-cible-destinations.png" alt="Accepter une invitation : choix de la table qui recevra les lignes">
<br><b>2. CIBLE : accepter l'invitation</b><br>
Coller le code, choisir où ranger chaque table, copier le lien du formulaire publié. Le widget
donne un <b>code de réponse</b>.
</td>
<td width="33%" valign="top">
<img src="docs/images/readme/11-source-fiche.png" alt="Coller la réponse : fiche de la personne qui a accepté, bouton Approuver et brancher">
<br><b>3. SOURCE : approuver</b><br>
Coller la réponse, vérifier qui a accepté, <b>Approuver et brancher</b>. Les lignes existantes
partent, puis chaque modification.
</td>
</tr>
</table>

Le pas à pas complet, capture par capture, est dans le [tutoriel](docs/04-tutoriel.md). Il est
aussi dans le widget (onglet **Tutoriel**), et chaque étape des assistants a son aide en images.

## Fonctionnalités

- **Exports** : plusieurs par document, chacun avec ses tables, ses colonnes et un filtre de
  lignes (conditions sur tout type de colonne, Références comprises, avec le nombre de lignes qui
  partiront) ; une modification de l'export vaut pour tous ses destinataires.
- **Trois modes par destinataire** : *dans un seul sens* (deux codes, l'envoi est fait par Grist même
  page fermée), *Échange* (dans les deux sens, la modification la plus récente l'emporte) et
  *lien public* (un seul code, la CIBLE lit ce que la SOURCE publie).
- **Recopie fidèle** : ajouts, modifications, suppressions, valeurs venues d'une autre table
  (Référence, formule), annulation (Ctrl+Z).
- **Pièces jointes** : une colonne cochée arrive comme une vraie colonne Pièces jointes ; chaque
  fichier part une fois par destinataire, quand la page SOURCE est ouverte, et n'est déposé
  qu'une fois.
- **Destinations au choix** : table nouvelle ou existante, colonnes mises en correspondance,
  lignes déjà présentes rattachées. Une table ajoutée plus tard à l'export est proposée dans une
  fenêtre.
- **Retouches respectées** : une valeur corrigée, une ligne ou une colonne supprimée à la main
  dans la CIBLE reste ainsi jusqu'au prochain changement de la ligne dans la SOURCE, et la carte la
  signale une dizaine de secondes après, avec le détail (ligne, valeur d'ici, valeur de la SOURCE)
  et un bouton « Corriger » qui remet l'état exact de la SOURCE.
- **Grandes tables** : pas de limite de lignes (testé avec 21 000), gros imports envoyés par
  tranches, file d'envoi bloquée vidée puis renvoyée.
- **Suivi clair** : une carte par export et par réception, dernier envoi, erreurs expliquées,
  historique replié des changements depuis la dernière visite, avec numéro de ligne, valeurs
  avant et après, et colonnes ajoutées à l'export.
- **Aide intégrée** : tutoriel en images, « Qui fait quoi ? », consignes prêtes à envoyer par
  courriel. Français et anglais, thème clair ou sombre.

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/images/readme/13-source-actif.png" alt="Carte de l'export Annuaire dans la SOURCE, avec deux destinataires actifs">
<br><sub>Dans la SOURCE, chaque destinataire a sa ligne : pause, reprise, révocation.</sub>
</td>
<td width="50%" valign="top">
<img src="docs/images/readme/20-echange-mode.png" alt="Ajout d'un destinataire : choix du mode, dans un seul sens, dans les deux sens (Échange) ou lien public">
<br><sub>Trois modes par destinataire, dont l'Échange dans les deux sens.</sub>
</td>
</tr>
</table>

## Installation

**Prérequis** : deux documents de la même instance Grist, version 1.7.11 ou plus récente, dans un
espace d'équipe ; un propriétaire du document SOURCE, un éditeur du document CIBLE (propriétaire
en Échange). **Aucune dépendance** : ni bibliothèque, ni étape de build, ni service tiers.

1. Dans chaque document : **Ajouter**, **Ajouter une page**, vue **Personnalisée**. Choisir
   Synchro Grist dans la **galerie** de l'instance s'il y est ; sinon **URL personnalisée** et
   l'adresse officielle, `https://grist-factory.github.io/grist-widget-syncPlus/`, jamais une
   adresse reçue par courriel. Puis **Ajouter un widget**.
2. Dans le panneau de droite, accepter l'**accès complet** : le widget lit et écrit le document
   (voir plus bas).

Le widget fonctionne avec `grist.numerique.gouv.fr` et `docs.getgrist.com`. Pour une autre
instance, ajouter son adresse dans `js/config.js` et dans la CSP de `index.html`. Pour héberger sa
propre copie (conseillé en production, voir [`SECURITY.md`](SECURITY.md#chaîne-dapprovisionnement)),
publier ce dossier tel quel sur une adresse https et la reporter dans `WIDGET_URL`
(`js/config.js`) : c'est l'adresse que donnent les consignes du widget.

### Accès au document

- **Accès complet** (`requiredAccess: 'full'`) : le widget lit la structure de l'ensemble du
  document (tables et colonnes, pour proposer exports et destinations). Il crée sa table technique
  et ses colonnes de suivi, écrit dans les tables de destination choisies et, pour un
  propriétaire, gère les webhooks et les règles d'accès qu'il pose (table technique réservée aux
  propriétaires, journaux aux éditeurs, lien public). Un accès en lecture ne
  permettrait aucune de ces écritures, dont la liste complète est dans
  [`docs/06-architecture.md`](docs/06-architecture.md#ce-que-le-widget-écrit-dans-les-documents).
- **Réseau** : en dehors de l'API des widgets, le widget ne parle qu'à l'instance Grist, par une
  seule fonction (`gristFetch`, `js/grist.js`) qui refuse toute autre origine et n'envoie aucun
  cookie. La CSP de `index.html` reprend la même liste.
- **Navigateur** : `localStorage` (clés `gristsync.*`) garde la langue, le thème, l'heure de la
  dernière visite par document CIBLE et un identifiant de navigateur tiré au hasard. Aucune donnée
  du document n'y est écrite.

## Sécurité

- Seules les colonnes cochées quittent le document SOURCE.
- Chaque réception a sa propre clé d'écriture, testée sur son journal et jamais affichée en
  entier. Le lien du formulaire est un droit d'écriture : il ne se diffuse pas.
- La CIBLE rejette et signale les lignes forgées (« Arrivées suspectes ») ; un bouton coupe le
  lien, et une nouvelle invitation fait reprendre la même réception, avec ses tables.
- Le document qui recevra est vérifié auprès de Grist (nom, dossier, équipe) à l'approbation,
  puis toutes les heures ; un code de contrôle de six caractères se compare par téléphone.
- Les envois sont signés, avec une clé propre à chaque destinataire que les deux documents tirent
  de leurs codes sans jamais la transmettre : la clé d'écriture d'une réception ne suffit pas pour
  y faire recopier quoi que ce soit, et un destinataire ne peut pas signer pour un autre. Une vague
  de suppressions attend une décision sur la carte.
- La table technique est réservée aux propriétaires de la SOURCE, les journaux aux éditeurs de la
  CIBLE (règles d'accès posées par le widget).
- Les codes ne contiennent que des noms de tables et de colonnes, une fiche, une adresse
  d'écriture, un secret et une clé publique : ils se transmettent à la seule personne
  concernée, comme un mot de passe, et une invitation vaut 7 jours.
- Une case **Sécurité renforcée**, à l'invitation, rend la comparaison du code obligatoire, fait
  valider toute suppression reçue et interdit le lien public pour cet export.

L'analyse complète est dans [`SECURITY.md`](SECURITY.md).

## Limites

- La recopie dans la CIBLE se fait quand un éditeur a la page du widget ouverte (même repliée) ;
  entre-temps, les changements attendent dans le journal.
- Le reste d'un très gros changement, le rattrapage après une pause et le contenu des pièces
  jointes (25 Mo par fichier au plus) ne partent que lorsqu'un propriétaire de la SOURCE ouvre la
  page du widget.
- Un envoi en échec bloque la file de tous les webhooks du document SOURCE pendant environ
  15 minutes (comportement de Grist) ; **Débloquer la file** la vide puis renvoie.
- Une table ou une colonne renommée dans la SOURCE ne part plus correctement : la carte de
  l'export le signale, et **Modifier** permet de cocher de nouveau les colonnes.
- Un export en Échange n'a que des participants à l'Échange. Une ligne de plus de 1 Mo ne peut pas
  partir.

La liste complète est dans [`docs/06-architecture.md`](docs/06-architecture.md#limites-connues).

## Documentation

| Pour | Lire |
|---|---|
| Brancher une synchro, capture par capture | [`docs/04-tutoriel.md`](docs/04-tutoriel.md) |
| Fonctionnement, ce que le widget écrit, carte du code, tests | [`docs/06-architecture.md`](docs/06-architecture.md) |
| Analyse de sécurité | [`SECURITY.md`](SECURITY.md) |
| Étude de faisabilité, test sur `grist.numerique.gouv.fr` | [`docs/01-etude-faisabilite.md`](docs/01-etude-faisabilite.md), [`docs/02-procedure-test-dinum.md`](docs/02-procedure-test-dinum.md) |
| Idées pour la suite | [`docs/05-pistes.md`](docs/05-pistes.md) |

## Tests

```bash
npm test                    # logique, textes et images du tutoriel (Node 20+, sans dépendance)
npm install                 # Playwright, pour le test d'intégration seulement
tests/e2e/start-grist.sh    # Grist jetable dans Docker
npm run test:e2e            # parcours complet dans un vrai Grist et un vrai navigateur
```

Les deux suites tournent à chaque push.

## Licence

[GNU GPL v3.0](LICENSE).
