# Synchro Grist à sens unique

Synchroniser une table d'un document Grist SOURCE vers un document Grist CIBLE de la même instance
(cible principale : `grist.numerique.gouv.fr`), sans serveur à héberger : le webhook natif de la
SOURCE écrit dans un `Journal` de la CIBLE par la clé d'un formulaire publié (`?flat=1`), et un
widget ouvert dans la CIBLE consolide le journal dans une table éditable.

**Statut : conception (octobre 2026).** Le transport est vérifié sur DINUM ; le widget est en cours
de définition.

| Document | Contenu |
|---|---|
| `docs/01-etude-faisabilite.md` | Étude complète : mécanismes, pièges vérifiés, designs A, B, C |
| `docs/02-procedure-test-dinum.md` | Procédure pas à pas et résultat du test réel sur DINUM |
| `docs/03-proposition-ux-et-droits.md` | Proposition de parcours, de fonctionnalités et de gestion des droits, à valider |

## Licence

À définir.
