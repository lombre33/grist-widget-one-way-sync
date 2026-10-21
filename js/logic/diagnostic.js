// Diagnostic à copier (Réglages) : ce qu'il faut pour comprendre un souci sans aller-retour, et rien
// de plus. Ce module choisit ce qui en fait partie (fonctions `…Facts`) et l'écrit en texte. Jamais :
// une valeur des tables, un courriel, une adresse de webhook ou de formulaire, un code, une clé, un
// identifiant de document (seulement l'instance). Les messages d'erreur de Grist passent par `clip`
// (adresses, jetons et longs identifiants retirés).
import { maskKey } from './codes.js';

const short = id => String(id || '').slice(0, 8);
const when = (ms) => {
  const date = new Date(ms || 0);
  return ms && Number.isFinite(date.getTime()) ? date.toISOString().replace(/\.\d+Z$/, 'Z') : '';
};
// Un message d'erreur de Grist cite parfois l'adresse demandée (document, équipe, jeton) : toute
// adresse est remplacée, ainsi que les jetons d'accès et les longues suites de caractères d'un
// identifiant ou d'une clé.
const clip = text => maskKey(String(text || ''))
  .replace(/https?:\/\/\S+/gi, '[adresse]')
  .replace(/\b(auth|token|key|secret)=\S+/gi, '$1=…')
  .replace(/\bBearer\s+\S+/gi, 'Bearer …')
  .replace(/[A-Za-z0-9_-]{20,}/g, '…')
  .replace(/\s+/g, ' ').slice(0, 160);

// Destinataire (webhook) : état d'envoi que Grist donne (`usage`), sans son adresse ni son mémo.
export function hookFacts(h) {
  const u = h.usage || {};
  const batch = u.lastEventBatch || {};
  return {
    id: short(h.id),
    enabled: Boolean(h.fields && h.fields.enabled),
    status: u.status || '',
    waiting: u.numWaiting || 0,
    success: when(u.lastSuccessTime),
    failure: when(u.lastFailureTime),
    http: u.lastHttpStatus || batch.httpStatus || 0,
    error: clip(u.lastErrorMessage || batch.errorMessage),
    attempts: batch.attempts || 0,
  };
}

// Export (SOURCE) : mode, tables (nombre de colonnes, filtre), écarts avec le document, destinataires,
// invitations en attente, lots coupés et listes dues.
export function exportFacts(exp) {
  const mode = exp.public ? 'public' : exp.retour ? 'retour' : exp.echange ? 'echange' : 'sens unique';
  return {
    id: short(exp.id),
    name: String(exp.name || ''),
    mode: `${mode}${exp.renforce ? ', renforcé' : ''}`,
    tables: (exp.tables || []).map(tb => `${tb.table} (${(tb.columns || []).length} col.${tb.filter ? ', filtre' : ''})`),
    lost: exp.lost || [],
    changed: exp.changed || [],
    invitations: (exp.invitations || []).length,
    late: exp.late || [],
    lists: exp.lists || [],
    recipients: (exp.recipients || []).map(hookFacts),
  };
}

// Réception (CIBLE) : note du journal sans son secret, ses clés ni l'adresse de la SOURCE ; état
// du dernier passage (erreurs) et tables proposées.
export function journalFacts({ journal, note, signed, results = [], offers = 0 }) {
  return {
    journal,
    export: short(note.export),
    mode: `${note.mode || 'reponse'}${note.retour ? ', retour' : ''}${note.renforce ? ', renforcé' : ''}`,
    tables: (note.tables || []).map(tb => `${tb.table} → ${tb.dest}`),
    refused: (note.refused || []).length,
    offers,
    signed: Boolean(signed),
    sealed: Boolean(note.sceau),
    reserve: note.reserve ? (note.reserved ? 'posée' : 'en attente') : 'non',
    ended: note.ended ? when(note.ended * 1000) : '',
    missing: Object.entries(note.missing || {}).map(([table, n]) => `${table}: ${n}`),
    big: Object.entries(note.big || {}).map(([table, keys]) => `${table}: ${(keys || []).length}`),
    suspect: note.suspect ? `${note.suspect.n || 0} (dernière ${when((note.suspect.at || 0) * 1000)}${note.suspect.flood ? ', flot' : ''})` : '',
    errors: results.filter(r => r && r.error).map(r => `${r.table || journal}: ${clip(r.text || r.error)}`),
  };
}

const line = (label, value) => (value === '' || value === undefined || (Array.isArray(value) && !value.length) ? null
  : `  ${label} : ${Array.isArray(value) ? value.join(', ') : value}`);

function exportLines(e) {
  return [
    `Export ${e.id} « ${e.name} » (${e.mode})`,
    line('tables', e.tables), line('tables introuvables', e.lost), line('colonnes changées', e.changed),
    line('invitations en attente', e.invitations || ''), line('lots coupés', e.late), line('listes dues', e.lists),
    ...e.recipients.map(r => `  destinataire ${r.id} : ${r.enabled ? 'actif' : 'en pause'}${r.status ? `, ${r.status}` : ''}, file ${r.waiting}`
      + `${r.success ? `, dernier succès ${r.success}` : ''}${r.failure ? `, dernier échec ${r.failure}` : ''}${r.http ? `, HTTP ${r.http}` : ''}`
      + `${r.attempts ? `, ${r.attempts} essais` : ''}${r.error ? `, « ${r.error} »` : ''}`),
    e.recipients.length ? null : '  aucun destinataire',
  ];
}

function journalLines(j) {
  return [
    `Réception ${j.journal} (export ${j.export}, ${j.mode})`,
    line('tables', j.tables), line('tables refusées', j.refused || ''), line('tables proposées', j.offers || ''),
    `  signée : ${j.signed ? 'oui' : 'non'}, sceau : ${j.sealed ? 'oui' : 'non'}, réservée aux éditeurs : ${j.reserve}`,
    line('coupée par la SOURCE', j.ended), line('lignes manquantes', j.missing), line('clés trop grosses', j.big),
    line('arrivées suspectes', j.suspect), line('erreurs', j.errors),
  ];
}

// Texte du diagnostic. `facts` : { version, served, origin, access, at (ms), agent, source
// ({ ownerOnly, exports, unsafe, charge, kinds } ou null), target ({ journals, compare } ou null),
// errors ([{ at, text }]) }.
export function diagnosticText({ version, served, origin, access, at, agent, source, target, errors = [] }) {
  return [
    `Diagnostic Synchro Grist ${version} (${served})`,
    `Date : ${when(at)}`,
    `Instance : ${origin || 'inconnue'}`,
    `Droits : ${access}`,
    `Navigateur : ${agent}`,
    '',
    '== Envoyer',
    ...(!source ? ['Aucun export (pas de table Synchro).'] : [
      source.ownerOnly ? 'Destinataires : lecture réservée aux propriétaires.' : null,
      source.unsafe ? `Webhooks sur Synchro sans filtre reconnu : ${source.unsafe}` : null,
      source.charge ? `Renvoi en cours : ${source.charge}` : null,
      `Lignes de Synchro : ${Object.entries(source.kinds || {}).map(([kind, n]) => `${kind} ${n}`).join(', ') || 'aucune'}`,
      ...(source.exports.length ? source.exports.flatMap(exportLines) : ['Aucun export.']),
    ]),
    '',
    '== Recevoir',
    ...(!target || !target.journals.length ? ['Aucune réception.'] : [
      target.compare === false ? 'Grist refuse la comparaison d\'états : relecture au rythme lent.' : null,
      ...target.journals.flatMap(journalLines),
    ]),
    '',
    '== Erreurs récentes',
    ...(errors.length ? errors.map(e => `${when(e.at)} ${clip(e.text)}`) : ['Aucune.']),
  ].filter(l => l !== null).join('\n');
}
