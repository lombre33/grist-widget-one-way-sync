// Options d'une réception (hors Échange), choisies à l'acceptation et changeables sur sa carte :
//  - archive : une ligne effacée à la SOURCE reste ici, cochée « Supprimée à la source » (voir
//    planConsolidation) ;
//  - verrou : les tables reçues sont en lecture seule pour tous sauf les propriétaires (règle
//    posée par un propriétaire, voir acl.js) ; la recopie attend alors qu'un propriétaire ouvre
//    la page. Seul un propriétaire change ce réglage sur la carte : un éditeur qui le retirerait
//    resterait bloqué par la règle jusqu'à la visite d'un propriétaire.
import { updateJournalNote } from './journals.js';
import { optionsNote } from '../logic/received.js';
import { cancelButton, el, openModal, run } from '../ui.js';
import { t } from '../i18n.js';

// Les deux cases, cochées selon `current` ; `lockable` : la personne peut changer le verrou ;
// `change` : réception déjà en place (des lignes peuvent déjà être archivées).
export function receptionOptions(current, { lockable = true, change = false } = {}) {
  const archive = el('input', { type: 'checkbox', checked: Boolean(current.archive) });
  const verrou = el('input', { type: 'checkbox', checked: Boolean(current.verrou), disabled: !lockable });
  return {
    node: el('div', {},
      el('label', { class: 'check' }, archive, t('recv.archive')),
      change ? el('p', { class: 'muted small' }, t('recv.archive.off')) : null,
      el('label', { class: 'check' }, verrou, t('recv.lock')),
      el('p', { class: 'muted small' }, t('recv.lock.limit')),
      lockable ? null : el('p', { class: 'muted small' }, t('recv.lock.ownerOnly'))),
    read: () => ({ archive: archive.checked, verrou: verrou.checked }),
  };
}

// Fenêtre « Options » d'une réception. Le dessin qui suit pose ou retire la règle du verrou (un
// propriétaire) ; le passage suivant ajoute la case d'archive aux destinations.
export function optionsDialog(group, owner, render) {
  const { note } = group;
  const options = receptionOptions(note, { lockable: owner, change: true });
  const report = el('div', { class: 'report' });
  const save = async (m) => {
    const { archive, verrou } = options.read();
    await updateJournalNote(group.journal, ({ archive: a, verrou: v, ...rest }) => ({ ...rest, ...optionsNote({ archive, verrou: owner ? verrou : v }) }));
    m.close();
    await render();
  };
  openModal({
    title: t('recv.options.title', { name: note.name }), width: 480,
    body: [options.node, report],
    buttons: [cancelButton(), { label: t('common.save'), kind: 'btn-primary', onClick: m => run(null, report, () => save(m)) }],
  });
}
