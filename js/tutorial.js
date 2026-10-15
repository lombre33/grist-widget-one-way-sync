// Tutoriel intégré : le mode d'emploi pas à pas, avec les captures du test d'intégration
// (docs/images, refaites par `CAPTURES=1 npm run test:e2e`). Affiché en entier dans l'onglet
// Tutoriel, et par morceaux (`stepHelp`) en bas des étapes des assistants.
import { LANG, t } from './i18n.js';
import { el, openModal } from './ui.js';

const IMG = name => (name.startsWith('img/') ? name : `docs/images/${name}.png`);

// role : 'source', 'target' ou 'both'. text : paragraphes, fr puis en.
const SECTIONS = [
  { id: 'install', role: 'both',
    title: ['Installer le widget (dans chaque document)', 'Install the widget (in each document)'],
    text: [[
      'Il faut un propriétaire du document SOURCE et un éditeur du document CIBLE, sur la même instance Grist. Chacun installe le widget dans son document :',
      '1. Ajouter, puis Ajouter une page.',
      '2. Choisir la vue Personnalisée, avec n’importe quelle table, puis Ajouter une page.',
      '3. Cliquer « URL personnalisée », coller l’adresse du widget (onglet Tutoriel, en bas), puis Ajouter un widget. Grist peut demander de confirmer que vous faites confiance au widget.',
      '4. Dans le panneau de droite, accepter l’accès complet au document. Renommer la page, par exemple « Synchro » : les tables techniques se rangeront dessous.',
    ], [
      'You need an owner of the SOURCE document and an editor of the TARGET document, on the same Grist instance. Each installs the widget in their document:',
      '1. Add, then Add page.',
      '2. Pick the Custom view, with any table, then Add page.',
      '3. Click “Custom URL”, paste the widget address (Tutorial tab, at the bottom), then Add widget. Grist may ask you to confirm you trust the widget.',
      '4. In the right panel, accept full access to the document. Rename the page, for example “Sync”: technical tables are tucked under it.',
    ]],
    images: ['00a-installer-ajouter', '00b-installer-page', '00c-installer-url', '00d-installer-acces', '01-accueil'] },
  { id: 's-tables', role: 'source',
    title: ['Choisir les tables', 'Pick the tables'],
    text: [['Envoyer, Nouveau destinataire, cocher les tables à partager.'], ['Send, New recipient, tick the tables to share.']],
    images: ['02-source-tables'] },
  { id: 's-columns', role: 'source',
    title: ['Choisir les colonnes', 'Pick the columns'],
    text: [[
      'Cocher les colonnes qui partent (toutes par défaut). Le reste ne sort jamais du document : le widget crée une vue d’export par table, qui ne contient que ces colonnes.',
      'Au clic sur « Préparer pour la synchro », il ajoute id_sync (identifiant stable), MajLe (date de modification), Supprime (case pour retirer une ligne de la CIBLE) et une table Synchro_<table> qui liste les clés, pour que les suppressions partent aussi.',
    ], [
      'Tick the columns to send (all by default). The rest never leaves the document: the widget creates one export view per table holding only these columns.',
      'On “Prepare for sync”, it adds id_sync (stable key), MajLe (last change), Supprime (box to remove a row from the TARGET) and a Synchro_<table> table listing the keys, so deletions are sent too.',
    ]],
    images: ['03-source-preparation'] },
  { id: 's-options', role: 'source',
    title: ['Options', 'Options'],
    text: [[
      'Donner un nom à l’envoi : le destinataire le verra. Mode « avec réponse » (recommandé) : Grist pousse chaque modification, même page fermée. Le secret garantit que la réponse vient de quelqu’un qui a reçu l’invitation.',
    ], [
      'Name the share: the recipient sees it. “With reply” mode (recommended): Grist pushes every change, even with the page closed. The secret guarantees the reply comes from someone who received the invitation.',
    ]],
    images: ['04-source-options'] },
  { id: 's-invite', role: 'source',
    title: ['Transmettre l’invitation', 'Send the invitation'],
    text: [[
      'Copier le code, ou « Copier avec les consignes » pour un message prêt à envoyer par courriel à la personne de la CIBLE. « Plus tard » ferme l’assistant : l’invitation attend sur sa carte.',
    ], [
      'Copy the code, or “Copy with instructions” for a message ready to email to the TARGET person. “Later” closes the wizard: the invitation waits on its card.',
    ]],
    images: ['05-source-invitation', '06-source-attente'] },
  { id: 't-code', role: 'target',
    title: ['Coller le code d’invitation', 'Paste the invitation code'],
    text: [['Recevoir, Accepter une invitation, coller le code reçu de la SOURCE.'], ['Receive, Accept an invitation, paste the code received from the SOURCE.']],
    images: ['07-cible-code'] },
  { id: 't-dest', role: 'target',
    title: ['Choisir les destinations', 'Pick the destinations'],
    text: [[
      'Pour chaque table reçue : Nouvelle table (nom modifiable) ou une table du document.',
      'Pour une table existante, dire où va chaque colonne et par quelle colonne rattacher les lignes déjà là : une ligne dont cette colonne a la même valeur est mise à jour au lieu d’être doublée.',
      'Le widget publie alors un formulaire de réception par table, à côté de lui. Grist recharge le widget : l’assistant se rouvre seul à l’étape suivante.',
    ], [
      'For each table received: New table (name editable) or a table of the document.',
      'For an existing table, say where each column goes and which column attaches rows already there: a row with the same value is updated instead of duplicated.',
      'The widget then publishes one receiving form per table, next to it. Grist reloads the widget: the wizard reopens at the next step.',
    ]],
    images: ['08-cible-destinations', '08b-cible-colonnes'] },
  { id: 't-link', role: 'target',
    title: ['Copier le lien du formulaire', 'Copy the form link'],
    text: [[
      'Dans la carte d’un des formulaires apparus (s’il y en a plusieurs, n’importe lequel : ils ont le même lien) : Partager, puis Copier le lien. Coller ce lien dans le widget, Tester le lien.',
      'Ce lien est un droit d’écriture dans vos journaux : ne le diffusez pas ailleurs.',
    ], [
      'In the card of one of the new forms (if there are several, any of them: they share the same link): Share, then Copy link. Paste it in the widget, Test the link.',
      'This link is a write right into your journals: do not share it elsewhere.',
    ]],
    images: ['img/aide-partager.png', 'img/aide-copier.png', '09-cible-lien'] },
  { id: 't-reply', role: 'target',
    title: ['Renvoyer la réponse', 'Send the reply back'],
    text: [[
      'Copier le code de réponse, ou « Copier avec les consignes », et l’envoyer à la SOURCE. Il contient l’adresse d’écriture et votre fiche (e-mail, document, équipe), pas de données.',
    ], [
      'Copy the reply code, or “Copy with instructions”, and send it to the SOURCE. It holds the write address and your card (email, document, team), no data.',
    ]],
    images: ['10-cible-reponse'] },
  { id: 's-reply', role: 'source',
    title: ['Approuver la réponse', 'Approve the reply'],
    text: [[
      'Sur la carte de l’invitation, Coller la réponse. Vérifier qui a accepté et vers quelles tables, puis Approuver et brancher.',
    ], [
      'On the invitation card, Paste the reply. Check who accepted and for which tables, then Approve and connect.',
    ]],
    images: ['11-source-fiche'] },
  { id: 's-load', role: 'source',
    title: ['Envoyer les lignes existantes', 'Send the existing rows'],
    text: [[
      'Le branchement n’envoie que les changements à venir : Envoyer pousse les lignes déjà là.',
      'La carte du destinataire montre le dernier envoi reçu. Actions : Tout renvoyer ; Colonnes (ajouter ou retirer à tout moment) ; Mettre en pause ; Débloquer la file si un envoi échoue ; Révoquer.',
      'Reprendre après une pause propose de rattraper les changements faits pendant la pause (recommandé) : seules les lignes changées repartent, avec les suppressions.',
    ], [
      'Connecting only sends future changes: Send pushes the rows already there.',
      'The recipient card shows the last delivery. Actions: Resend all; Columns (add or remove anytime); Pause; Unblock the queue when a delivery fails; Revoke.',
      'Resuming after a pause offers to catch up on changes made during the pause (recommended): only changed rows are sent, with the deletions.',
    ]],
    images: ['12-source-envoi', '13-source-actif', '13b-source-reprendre'] },
  { id: 't-daily', role: 'target',
    title: ['Au quotidien, côté CIBLE', 'Day to day, TARGET side'],
    text: [[
      'Chaque changement de la SOURCE arrive dans le journal en une seconde environ, même page fermée. La recopie dans vos tables se fait quand un éditeur ouvre la page du widget (même replié), puis toutes les 10 secondes.',
      'L’historique montre, par table, les lignes ajoutées, modifiées et supprimées depuis votre dernière visite, nommées par la colonne de votre choix.',
      'Une retouche faite à la main reste en place jusqu’à la prochaine modification de la même ligne dans la SOURCE. Arrêter la réception efface les journaux et garde vos tables.',
    ], [
      'Each SOURCE change reaches the journal in about a second, even with the page closed. Copying into your tables happens when an editor opens the widget page (even collapsed), then every 10 seconds.',
      'The history shows, per table, the rows added, changed and deleted since your last visit, named by the column of your choice.',
      'A manual edit stays until the same row changes again in the SOURCE. Stop receiving deletes the journals and keeps your tables.',
    ]],
    images: ['14-cible-historique'] },
  { id: 'public', role: 'both',
    title: ['Variante : lien public', 'Variant: public link'],
    text: [[
      'SOURCE : à l’étape Options, choisir Lien public. Le widget pose des règles d’accès : un lecteur du document, dont le lien public, ne voit plus que les vues d’export. Puis, dans Partager, régler « Lien public » sur Lecture.',
      'CIBLE : coller le code, choisir les destinations, c’est tout. Le widget lit la SOURCE toutes les 10 secondes tant que sa page est ouverte. À éviter pour des données qui ne doivent pas être publiques.',
    ], [
      'SOURCE: at the Options step, pick Public link. The widget adds access rules: a viewer of the document, including the public link, only sees the export views. Then, in Share, set “Public link” to Viewer.',
      'TARGET: paste the code, pick the destinations, that is all. The widget reads the SOURCE every 10 seconds while its page is open. Avoid for data that must not be public.',
    ]],
    images: ['15-source-public'] },
  { id: 'relay', role: 'both',
    title: ['Envoyer et recevoir dans le même document, relais', 'Send and receive in the same document, relay'],
    text: [[
      'Un document peut envoyer certaines tables et en recevoir d’autres : les deux onglets fonctionnent ensemble.',
      'Une table reçue peut être relayée vers un troisième document (A vers B vers C). Le second saut part quand un éditeur ouvre la page du widget de B. Une ligne ajoutée à la main dans la table relayée reste dans B.',
      'Le widget refuse les boucles : renvoyer une table reçue au document d’où elle vient, ou une table vers elle-même.',
    ], [
      'A document can send some tables and receive others: both tabs work together.',
      'A received table can be relayed to a third document (A to B to C). The second hop leaves when an editor opens the widget page of B. A row added by hand in the relayed table stays in B.',
      'The widget refuses loops: sending a received table back to the document it comes from, or a table to itself.',
    ]],
    images: [] },
  { id: 'trouble', role: 'both',
    title: ['Si quelque chose coince', 'If something gets stuck'],
    text: [[
      'Rien n’arrive dans la table de la CIBLE : ouvrir la page du widget dans la CIBLE, les versions attendaient dans le journal.',
      'Carte SOURCE rouge : la CIBLE a arrêté la réception ou dépublié son formulaire. Révoquer, puis refaire une invitation.',
      'Tous les envois du document SOURCE sont en retard : un envoi en échec bloque la file. Débloquer la file.',
      'Les lignes déjà présentes ne sont pas arrivées : Tout renvoyer.',
    ], [
      'Nothing reaches the TARGET table: open the widget page in the TARGET, versions were waiting in the journal.',
      'Red SOURCE card: the TARGET stopped receiving or unpublished its form. Revoke, then invite again.',
      'All deliveries of the SOURCE document are late: a failed delivery blocks the queue. Unblock the queue.',
      'Rows already there did not arrive: Resend all.',
    ]],
    images: [] },
];

const pick = pair => pair[LANG === 'en' ? 1 : 0];

// Une capture, agrandie au clic dans une fenêtre.
function figure(name) {
  const img = el('img', { src: IMG(name), alt: '', loading: 'lazy' });
  return el('button', { class: 'tuto-shot', type: 'button', 'aria-label': t('tuto.zoom'),
    onclick: () => openModal({ title: t('tuto.zoom'), width: 'full', body: el('img', { class: 'tuto-full', src: IMG(name), alt: '' }),
      buttons: [{ label: t('common.close'), kind: 'btn-primary' }] }) }, img);
}

function section(s, number) {
  return el('section', { class: 'tuto-section', id: `tuto-${s.id}`, 'data-role': s.role },
    el('h2', {}, number ? `${number}. ` : '', pick(s.title),
      s.role === 'both' ? null : el('span', { class: `role-badge role-${s.role}` }, t(`guide.role.${s.role}`))),
    pick(s.text).map(p => el('p', {}, p)),
    s.images.length ? el('div', { class: 'tuto-shots' }, s.images.map(figure)) : null);
}

// Onglet Tutoriel : tout le parcours, filtrable par rôle.
export function tutorialView(address) {
  const sections = SECTIONS.map((s, i) => section(s, i + 1));
  const filter = role => {
    for (const node of sections) node.classList.toggle('hidden', role !== 'all' && !['both', role].includes(node.dataset.role));
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.role === role));
  };
  const buttons = [['all', t('tuto.all')], ['source', t('tuto.source')], ['target', t('tuto.target')]].map(([role, label]) =>
    el('button', { class: 'btn btn-small', type: 'button', 'data-role': role, 'aria-pressed': String(role === 'all'), onclick: () => filter(role) }, label));
  return el('div', { class: 'tuto' },
    el('h1', { class: 'home-title' }, t('tuto.title')),
    el('p', { class: 'muted' }, t('tuto.intro')),
    el('div', { class: 'tuto-filter', role: 'group', 'aria-label': t('tuto.filter') }, buttons),
    sections,
    address);
}

// Aide en images pour une étape d'assistant : les sections `ids`, repliées.
export function stepHelp(ids, open = false) {
  const chosen = SECTIONS.filter(s => ids.includes(s.id));
  return el('details', { class: 'guide tuto-step', open }, el('summary', {}, t('tuto.step')), chosen.map(s => section(s)));
}
