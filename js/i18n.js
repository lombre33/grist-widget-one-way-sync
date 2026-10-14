// Textes de l'interface, français et anglais. La langue est lue une fois au démarrage : le choix
// des Réglages, sinon la première des deux que propose le navigateur. Changer de langue recharge
// la page. Pluriels : « {n|singulier|pluriel} » (en français, 0 et 1 au singulier).
import { readPref } from './prefs.js';

const TEXTS = {
  fr: {
    'app.title': 'Synchro',
    'tab.send': 'Envoyer',
    'tab.receive': 'Recevoir',
    'settings.title': 'Réglages',
    'settings.lang': 'Langue',
    'settings.theme': 'Thème',
    'settings.theme.system': 'Système',
    'settings.theme.light': 'Clair',
    'settings.theme.dark': 'Sombre',
    'settings.credits': 'Crédits',
    'settings.credits.text': 'Grist Factory · grist-factory.fr · Licence GNU GPL v3.0 · Version {version}',
    'common.close': 'Fermer',
    'common.cancel': 'Annuler',
    'common.copy': 'Copier',
    'common.copied': 'Copié',
    'common.next': 'Continuer',
    'common.filter': 'Filtrer les tables',
    'common.none': 'Aucun résultat',
    'common.readonly': 'Lecture seule : un éditeur doit ouvrir cette page pour que les actions soient possibles.',
    'common.ownerOnly': 'Réservé aux propriétaires du document.',

    'home.title': 'Que voulez-vous faire dans ce document ?',
    'home.send': 'Envoyer une table',
    'home.send.desc': 'Ce document est la SOURCE : ses lignes sont recopiées dans un autre document.',
    'home.receive': 'Recevoir une table',
    'home.receive.desc': 'Ce document est la CIBLE : il reçoit et tient à jour une copie éditable.',

    'send.empty': 'Aucun destinataire. Invitez un autre document à recevoir une table.',
    'send.new': 'Nouveau destinataire',
    'send.step1': 'Tables à envoyer',
    'send.name': 'Nom de l’envoi',
    'send.check.ok': 'Prêt à envoyer : {n} {n|table|tables}.',
    'send.check.missing': 'Le widget doit ajouter : {items}.',
    'send.check.table': 'la table {table} (suppressions)',
    'send.prepare': 'Préparer pour la synchro',
    'send.problem.helperDisplay': '« {col} » est une Référence qui affiche une autre colonne : Grist ajoute une colonne cachée que la CIBLE ne peut pas recevoir. Affichez l’identifiant (Row ID) ou exportez une autre table.',
    'send.problem.helperRule': '« {col} » a une mise en forme conditionnelle : Grist ajoute une colonne cachée que la CIBLE ne peut pas recevoir. Retirez la règle.',
    'send.problem.attachments': '« {col} » contient des pièces jointes, qui ne peuvent pas être envoyées.',
    'send.problem.reference': '« {col} » est une Référence : elle arrivera comme un numéro de ligne sans signification dans la CIBLE.',
    'send.secret': 'Protéger l’invitation par un secret',
    'send.secret.on': 'avec secret',
    'send.secret.off': 'sans secret',
    'send.invite': 'Créer l’invitation',
    'send.invite.title': 'Invitation à transmettre',
    'send.invite.help': 'Transmettez ce code à la personne qui gère le document CIBLE. Elle le colle dans ce widget, onglet « Recevoir », puis vous renvoie un code de réponse.',
    'send.reply': 'Coller la réponse',
    'send.reply.title': 'Réponse du destinataire',
    'send.reply.help': 'Collez le code de réponse reçu du document CIBLE.',
    'send.reply.check': 'Vérifier',
    'send.reply.tables': 'Tables',
    'send.reply.email': 'Accepté par',
    'send.reply.doc': 'Document',
    'send.reply.team': 'Équipe',
    'send.reply.at': 'Le',
    'send.reply.approve': 'Approuver et brancher',
    'send.reply.nosecret': 'Invitation sans secret : vérifiez la fiche avant d’approuver.',
    'send.load.title': 'Envoyer les lignes existantes ?',
    'send.load.body': 'Le branchement n’envoie que les modifications à venir. Envoyer maintenant {n} {n|ligne existante|lignes existantes} ?',
    'send.load.ok': 'Envoyer',
    'send.load.progress': 'Envoi : {done} sur {total}…',
    'send.status.invited': 'En attente de réponse',
    'send.status.active': 'Actif',
    'send.status.paused': 'En pause',
    'send.status.error': 'Erreur',
        'send.waiting': '{n|envoi en attente|envois en attente}',
    'send.action.load': 'Tout renvoyer',
    'send.action.pause': 'Mettre en pause',
    'send.action.resume': 'Reprendre',
    'send.action.unblock': 'Débloquer la file',
    'send.action.revoke': 'Révoquer',
    'send.action.cancel': 'Annuler l’invitation',
    'send.revoke.title': 'Révoquer « {name} » ?',
    'send.revoke.body': 'Les envois s’arrêtent. Ce qui a déjà été reçu reste dans le document CIBLE.',
    'send.unblock.title': 'Débloquer la file d’envoi ?',
    'send.unblock.body': 'Les envois en attente de tout le document sont abandonnés. Utilisez ensuite « Tout renvoyer » pour rattraper.',

    'recv.empty': 'Aucune table reçue. Collez une invitation reçue du document SOURCE.',
    'recv.new': 'Accepter une invitation',
    'recv.invite.title': 'Invitation reçue',
    'recv.invite.help': 'Collez le code d’invitation transmis par le document SOURCE.',
    'recv.invite.summary': '« {name} » : {n|table|tables} {tables}.',
    'recv.dest': 'Tables qui recevront les lignes (nouvelles ou existantes)',
    'recv.create': 'Créer les tables',
    'recv.existing': '« {table} » existe déjà : le widget lui ajoutera la clé id_sync (masquée) et les colonnes manquantes ({cols}). Ses lignes actuelles ne seront pas touchées : si elles sont aussi dans la SOURCE, elles seront en double.',
    'recv.useExisting': 'Utiliser cette table',
    'recv.link.title': 'Lien du formulaire',
    'recv.link.help': 'Un formulaire de réception vient d’être publié sur cette page. Dans sa carte, cliquez « Partager » puis « Copier le lien », et collez le lien ici (un seul lien suffit pour toutes les tables).',
    'recv.link.help.other': 'Un formulaire de réception vient d’être publié sur la page « {page} ». Ouvrez-la, cliquez « Partager » puis « Copier le lien », et collez le lien ici.',
    'recv.link.check': 'Tester le lien',
    'recv.reply.title': 'Réponse à renvoyer',
    'recv.reply.help': 'Le lien fonctionne. Renvoyez ce code à la personne qui vous a invité : elle le colle dans son widget pour brancher l’envoi.',
    'recv.status.waiting': 'En attente du lien',
    'recv.status.ok': 'À jour',
    'recv.status.error': 'Erreur',
    'recv.action.sync': 'Synchroniser',
    'recv.action.link': 'Coller le lien',
    'recv.result': '{added} {added|ajoutée|ajoutées}, {updated} {updated|mise à jour|mises à jour}, {removed} {removed|supprimée|supprimées}',
    'recv.result.none': 'Rien à faire',
    'recv.auto': 'Mise à jour automatique tant que cette page est ouverte.',

    'error.codeFormat': 'Ce texte n’est pas un code de synchro. Recopiez tout le code, de « GRISTSYNC1. » jusqu’à la fin.',
    'error.notInvitation': 'Ce code est une réponse, pas une invitation.',
    'error.notReply': 'Ce code est une invitation, pas une réponse.',
    'error.codeInvalid': 'Ce code est incomplet ou modifié.',
    'error.otherInstance': 'Le document CIBLE est sur une autre instance Grist : l’envoi est refusé.',
    'error.unknownInvitation': 'Cette réponse ne correspond à aucune invitation en attente de ce document, ou son secret est différent.',
    'error.destTaken': 'Deux tables reçues ont le même nom de destination, ou cette destination reçoit déjà une synchro : choisissez un autre nom.',
    'error.formLink': 'Ce lien n’a pas la forme attendue : https://<instance>/o/<équipe>/forms/<clé>/<numéro>.',
    'error.linkTest': 'Le lien ne fonctionne pas ({detail}). Vérifiez que le formulaire est publié et que le document est dans un espace d’équipe.',
    'error.generic': 'Erreur : {detail}',

    'start.outside': 'Ce widget s’ouvre dans Grist : ajoutez un widget personnalisé, URL personnalisée, collez l’adresse ci-dessous et choisissez l’accès complet.',
    'start.access': 'Le widget a besoin de l’accès complet au document : dans le panneau de droite, onglet Widget, choisissez « Accès complet ».',
  },
  en: {
    'app.title': 'Sync',
    'tab.send': 'Send',
    'tab.receive': 'Receive',
    'settings.title': 'Settings',
    'settings.lang': 'Language',
    'settings.theme': 'Theme',
    'settings.theme.system': 'System',
    'settings.theme.light': 'Light',
    'settings.theme.dark': 'Dark',
    'settings.credits': 'Credits',
    'settings.credits.text': 'Grist Factory · grist-factory.fr · GNU GPL v3.0 license · Version {version}',
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.next': 'Continue',
    'common.filter': 'Filter tables',
    'common.none': 'No result',
    'common.readonly': 'Read only: an editor must open this page for actions to be available.',
    'common.ownerOnly': 'Document owners only.',

    'home.title': 'What do you want to do in this document?',
    'home.send': 'Send a table',
    'home.send.desc': 'This document is the SOURCE: its rows are copied into another document.',
    'home.receive': 'Receive a table',
    'home.receive.desc': 'This document is the TARGET: it receives and maintains an editable copy.',

    'send.empty': 'No recipient yet. Invite another document to receive a table.',
    'send.new': 'New recipient',
    'send.step1': 'Tables to send',
    'send.name': 'Name of this feed',
    'send.check.ok': 'Ready to send: {n} {n|table|tables}.',
    'send.check.missing': 'The widget must add: {items}.',
    'send.check.table': 'the table {table} (deletions)',
    'send.prepare': 'Prepare for sync',
    'send.problem.helperDisplay': '“{col}” is a Reference showing another column: Grist adds a hidden column the TARGET cannot receive. Show the Row ID or send another table.',
    'send.problem.helperRule': '“{col}” has conditional formatting: Grist adds a hidden column the TARGET cannot receive. Remove the rule.',
    'send.problem.attachments': '“{col}” holds attachments, which cannot be sent.',
    'send.problem.reference': '“{col}” is a Reference: it will arrive as a row number with no meaning in the TARGET.',
    'send.secret': 'Protect the invitation with a secret',
    'send.secret.on': 'with secret',
    'send.secret.off': 'without secret',
    'send.invite': 'Create the invitation',
    'send.invite.title': 'Invitation to share',
    'send.invite.help': 'Give this code to the person managing the TARGET document. They paste it in this widget, “Receive” tab, then send you back a reply code.',
    'send.reply': 'Paste the reply',
    'send.reply.title': 'Recipient’s reply',
    'send.reply.help': 'Paste the reply code received from the TARGET document.',
    'send.reply.check': 'Check',
    'send.reply.tables': 'Tables',
    'send.reply.email': 'Accepted by',
    'send.reply.doc': 'Document',
    'send.reply.team': 'Team',
    'send.reply.at': 'On',
    'send.reply.approve': 'Approve and connect',
    'send.reply.nosecret': 'Invitation without secret: check the details before approving.',
    'send.load.title': 'Send existing rows?',
    'send.load.body': 'Connecting only sends future changes. Send {n} {n|existing row|existing rows} now?',
    'send.load.ok': 'Send',
    'send.load.progress': 'Sending: {done} of {total}…',
    'send.status.invited': 'Waiting for reply',
    'send.status.active': 'Active',
    'send.status.paused': 'Paused',
    'send.status.error': 'Error',
    'send.waiting': '{n|pending delivery|pending deliveries}',
    'send.action.load': 'Resend all',
    'send.action.pause': 'Pause',
    'send.action.resume': 'Resume',
    'send.action.unblock': 'Unblock the queue',
    'send.action.revoke': 'Revoke',
    'send.action.cancel': 'Cancel the invitation',
    'send.revoke.title': 'Revoke “{name}”?',
    'send.revoke.body': 'Deliveries stop. What was already received stays in the TARGET document.',
    'send.unblock.title': 'Unblock the delivery queue?',
    'send.unblock.body': 'Pending deliveries of the whole document are dropped. Then use “Resend all” to catch up.',

    'recv.empty': 'No table received. Paste an invitation received from the SOURCE document.',
    'recv.new': 'Accept an invitation',
    'recv.invite.title': 'Invitation received',
    'recv.invite.help': 'Paste the invitation code sent by the SOURCE document.',
    'recv.invite.summary': '“{name}”: {n|table|tables} {tables}.',
    'recv.dest': 'Tables receiving the rows (new or existing)',
    'recv.create': 'Create the tables',
    'recv.existing': '“{table}” already exists: the widget will add the id_sync key (hidden) and the missing columns ({cols}). Its current rows will not be touched: if they are also in the SOURCE, they will be duplicated.',
    'recv.useExisting': 'Use this table',
    'recv.link.title': 'Form link',
    'recv.link.help': 'A receiving form was just published on this page. In its card, click “Share” then “Copy link”, and paste the link here (one link is enough for all tables).',
    'recv.link.help.other': 'A receiving form was just published on page “{page}”. Open it, click “Share” then “Copy link”, and paste the link here.',
    'recv.link.check': 'Test the link',
    'recv.reply.title': 'Reply to send back',
    'recv.reply.help': 'The link works. Send this code back to the person who invited you: they paste it in their widget to connect the feed.',
    'recv.status.waiting': 'Waiting for the link',
    'recv.status.ok': 'Up to date',
    'recv.status.error': 'Error',
    'recv.action.sync': 'Synchronize',
    'recv.action.link': 'Paste the link',
    'recv.result': '{added} added, {updated} updated, {removed} removed',
    'recv.result.none': 'Nothing to do',
    'recv.auto': 'Updated automatically while this page is open.',

    'error.codeFormat': 'This text is not a sync code. Copy the whole code, from “GRISTSYNC1.” to the end.',
    'error.notInvitation': 'This code is a reply, not an invitation.',
    'error.notReply': 'This code is an invitation, not a reply.',
    'error.codeInvalid': 'This code is incomplete or altered.',
    'error.otherInstance': 'The TARGET document is on another Grist instance: sending is refused.',
    'error.unknownInvitation': 'This reply matches no pending invitation of this document, or its secret differs.',
    'error.destTaken': 'Two received tables have the same destination name, or this destination already receives a sync: choose another name.',
    'error.formLink': 'This link does not have the expected form: https://<instance>/o/<team>/forms/<key>/<number>.',
    'error.linkTest': 'The link does not work ({detail}). Check that the form is published and the document is in a team site.',
    'error.generic': 'Error: {detail}',

    'start.outside': 'This widget opens inside Grist: add a custom widget, custom URL, paste the address below and choose full access.',
    'start.access': 'The widget needs full access to the document: in the right panel, Widget tab, choose “Full document access”.',
  },
};

function initialLang() {
  const stored = readPref('lang');
  if (stored === 'fr' || stored === 'en') return stored;
  for (const lang of navigator.languages || []) {
    const short = String(lang).slice(0, 2).toLowerCase();
    if (short === 'fr' || short === 'en') return short;
  }
  return navigator.languages && navigator.languages.length ? 'en' : 'fr';
}

export const LANG = initialLang();

// t('send.waiting', {n: 3}) -> « 3 envois en attente ».
export function t(key, vars = {}) {
  const text = TEXTS[LANG][key] ?? TEXTS.fr[key] ?? key;
  return text
    .replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_, name, one, many) => {
      const n = Number(vars[name]);
      return (LANG === 'fr' ? n <= 1 : n === 1) ? one : many;
    })
    .replace(/\{(\w+)\}/g, (_, name) => (vars[name] ?? `{${name}}`));
}

// Textes statiques de index.html : attributs data-i18n (contenu) et data-i18n-label (aria-label
// et title).
export function translatePage(root = document) {
  document.documentElement.lang = LANG;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    el.title = t(el.dataset.i18nLabel);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
}
