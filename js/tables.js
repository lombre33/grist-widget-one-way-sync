// Tables du widget. Elles sont visibles dans le document et ne sont créées qu'avec l'accord de
// la personne ; un refus n'est pas retenu, la question revient à l'action suivante.
import { CONFIG_TABLE, RECIPIENTS_TABLE } from './core.js';
import { apply, listTables, tuckUnderWidgetPage } from './grist.js';
import { confirmDialog } from './ui.js';
import { t } from './i18n.js';

const choice = choices => JSON.stringify({ choices });

const TABLE_SPECS = {
  // CIBLE : une ligne par table reçue.
  [CONFIG_TABLE]: [
    { id: 'Nom', type: 'Text' },
    { id: 'Table_source', type: 'Text' },
    { id: 'Journal', type: 'Text' },
    { id: 'Destination', type: 'Text' },
    { id: 'Statut', type: 'Choice', widgetOptions: choice(['attente_lien', 'actif']) },
    { id: 'Secret', type: 'Text' },
    { id: 'Origine_source', type: 'Text' },
    // E-mail de la personne qui accepte l'invitation, calculé par le serveur Grist.
    { id: 'Accepte_par', type: 'Text', formula: 'user.Email', recalcWhen: 0 },
    { id: 'Derniere_execution', type: 'DateTime:UTC' },
    { id: 'Bilan', type: 'Text' },
    // Plus grand numéro de ligne du Journal déjà traité.
    { id: 'Derniere_ligne', type: 'Int' },
  ],
  // SOURCE : registre des destinataires. Le secret de l'invitation n'y est gardé qu'en empreinte.
  [RECIPIENTS_TABLE]: [
    { id: 'Nom', type: 'Text' },
    { id: 'Table', type: 'Text' },
    { id: 'Statut', type: 'Choice', widgetOptions: choice(['invite', 'actif', 'revoque']) },
    { id: 'Empreinte_secret', type: 'Text' },
    { id: 'Webhook', type: 'Text' },
    { id: 'Destinataire', type: 'Text' },
    { id: 'Invite_le', type: 'DateTime:UTC' },
    { id: 'Approuve_le', type: 'DateTime:UTC' },
  ],
};

export async function hasTable(tableId) {
  return (await listTables()).some(t => t.tableId === tableId);
}

// true si la table existe ou vient d'être créée avec l'accord de la personne.
export async function ensureTable(tableId) {
  if (await hasTable(tableId)) return true;
  const ok = await confirmDialog({
    title: t('consent.title'), body: t('consent.body', { tables: tableId }), confirmLabel: t('consent.ok'), cancelLabel: t('consent.no'),
  });
  if (!ok) return false;
  await apply([['AddTable', tableId, TABLE_SPECS[tableId].map(c => ({ isFormula: false, ...c }))]]);
  await tuckUnderWidgetPage([tableId]);
  return true;
}
