// Diagnostic à copier (Réglages) : ce qu'il faut pour comprendre un souci sans aller-retour, et rien
// de plus. Ce module choisit ce qui en fait partie (fonctions `…Facts`) et l'écrit en texte. Jamais :
// une valeur des tables, un courriel, une adresse de webhook ou de formulaire, un code, une clé, un
// identifiant de document (seulement l'instance). Les messages d'erreur de Grist passent par `clip`
// (adresses, jetons et longs identifiants retirés).
//
// Les textes sont ceux du port (`t(clé, valeurs)`, clés `diag.*` de i18n/fr.json et en.json) : chaque
// fonction qui écrit du texte reçoit `t`, ce module reste pur. Les nombres sont donnés en texte (`String`)
// pour rester des chiffres simples, sans séparateur de milliers : le diagnostic se colle dans un message.
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
export function exportFacts(exp, t) {
  const mode = t(`diag.mode.${exp.public ? 'public' : exp.retour ? 'return' : exp.echange ? 'exchange' : 'oneway'}`);
  return {
    id: short(exp.id),
    name: String(exp.name || ''),
    mode: `${mode}${exp.renforce ? t('diag.suffix.renforce') : ''}`,
    tables: (exp.tables || []).map(tb => t(tb.filter ? 'diag.table.filter' : 'diag.table', { table: tb.table, n: String((tb.columns || []).length) })),
    lost: exp.lost || [],
    changed: exp.changed || [],
    invitations: (exp.invitations || []).length,
    late: exp.late || [],
    lists: exp.lists || [],
    recipients: (exp.recipients || []).map(hookFacts),
  };
}

// Renvoi en cours ou interrompu (`prog` de la ligne 'charge'), en une phrase ; '' sans renvoi.
export function progressFact(prog, now, t) {
  if (!prog) return '';
  const ago = prog.last ? t('diag.progress.last', { n: String(Math.max(0, Math.round(now - prog.last))) }) : '';
  return t('diag.progress', { export: short(prog.exp), done: String(prog.done), total: String(prog.total), lots: String(prog.lots), lotsTotal: String(prog.lotsTotal) }) + ago;
}

// Dernier passage du rattrapage de cette page et ce qu'il a trouvé.
const PASS = ['idle', 'sent', 'blocked', 'busy', 'nosync'];
export function catchFact({ at, why, running }, t) {
  if (!at) return t(running ? 'diag.catch.first' : 'diag.catch.never');
  return `${t('diag.catch.last', { when: when(at) })}${why ? ` (${PASS.includes(why) ? t(`diag.pass.${why}`) : why})` : ''}${running ? t('diag.catch.running') : ''}`;
}

const JOURNAL_MODES = { public: 'public', echange: 'exchange' };
// Réception (CIBLE) : note du journal sans son secret, ses clés ni l'adresse de la SOURCE ; état
// du dernier passage (erreurs) et tables proposées.
export function journalFacts({ journal, note, signed, results = [], offers = 0, stats = null, t }) {
  const count = { n: String(stats ? stats.n : 0), raw: String(stats ? stats.raw : 0), when: stats && stats.last ? when(stats.last * 1000) : '' };
  return {
    arrival: stats ? t(stats.last ? 'diag.arrival' : 'diag.arrival.nodate', count) : '',
    journal,
    export: short(note.export),
    mode: `${t(`diag.mode.${JOURNAL_MODES[note.mode] || 'reply'}`)}${note.retour ? t('diag.suffix.return') : ''}${note.renforce ? t('diag.suffix.renforce') : ''}`,
    tables: (note.tables || []).map(tb => `${tb.table} → ${tb.dest}`),
    refused: (note.refused || []).length,
    offers,
    signed: Boolean(signed),
    sealed: Boolean(note.sceau),
    reserve: t(note.reserve ? (note.reserved ? 'diag.reserve.set' : 'diag.reserve.waiting') : 'diag.no'),
    ended: note.ended ? when(note.ended * 1000) : '',
    missing: Object.entries(note.missing || {}).map(([table, n]) => `${table}: ${n}`),
    announced: Object.entries(note.tally || {}).map(([table, a]) => `${table}: ${a.n}`),
    gap: results.flatMap(r => Object.entries((r && r.tally) || {}).map(([table, g]) => t('diag.gap', { table, got: String(g.got), expected: String(g.expected) }))),
    big: Object.entries(note.big || {}).map(([table, keys]) => `${table}: ${(keys || []).length}`),
    suspect: note.suspect ? t(note.suspect.flood ? 'diag.suspect.flood' : 'diag.suspect', { n: String(note.suspect.n || 0), when: when((note.suspect.at || 0) * 1000) }) : '',
    errors: results.filter(r => r && r.error).map(r => `${r.table || journal}: ${clip(r.text || r.error)}`),
  };
}

const line = (t, label, value) => (value === '' || value === undefined || (Array.isArray(value) && !value.length) ? null
  : t('diag.line', { label: t(`diag.l.${label}`), value: Array.isArray(value) ? value.join(', ') : value }));

function recipientLine(t, r) {
  const parts = [t(r.enabled ? 'diag.rcpt.on' : 'diag.rcpt.paused'), r.status, t('diag.rcpt.queue', { n: String(r.waiting) }),
    r.success && t('diag.rcpt.success', { when: r.success }), r.failure && t('diag.rcpt.failure', { when: r.failure }), r.http && `HTTP ${r.http}`,
    r.attempts && t('diag.rcpt.attempts', { n: String(r.attempts) }), r.error && t('diag.rcpt.error', { error: r.error })];
  return t('diag.line', { label: `${t('diag.rcpt')} ${r.id}`, value: parts.filter(Boolean).join(', ') });
}

function exportLines(e, t) {
  return [
    t('diag.export', { id: e.id, name: e.name, mode: e.mode }),
    line(t, 'tables', e.tables), line(t, 'lost', e.lost), line(t, 'changed', e.changed),
    line(t, 'invitations', e.invitations ? String(e.invitations) : ''), line(t, 'late', e.late), line(t, 'lists', e.lists),
    ...e.recipients.map(r => recipientLine(t, r)),
    e.recipients.length ? null : `  ${t('diag.rcpt.none')}`,
  ];
}

function journalLines(j, t) {
  return [
    t('diag.journal', { journal: j.journal, export: j.export, mode: j.mode }),
    line(t, 'tables', j.tables), line(t, 'refused', j.refused ? String(j.refused) : ''), line(t, 'offers', j.offers ? String(j.offers) : ''),
    t('diag.journal.flags', { signed: t(j.signed ? 'diag.yes' : 'diag.no'), sealed: t(j.sealed ? 'diag.yes' : 'diag.no'), reserve: j.reserve }),
    line(t, 'ended', j.ended), line(t, 'missing', j.missing), line(t, 'announced', j.announced), line(t, 'gap', j.gap), line(t, 'big', j.big),
    line(t, 'suspect', j.suspect), line(t, 'journal', j.arrival), line(t, 'errors', j.errors),
  ];
}

// Texte du diagnostic. `facts` : { version, served, origin, access, at (ms), agent, source
// ({ ownerOnly, exports, unsafe, charge, kinds } ou null), target ({ journals, compare } ou null),
// errors ([{ at, text }]), t }. `access` : 'reader', 'editor' ou 'owner'.
export function diagnosticText({ version, served, origin, access, at, agent, source, target, errors = [], t }) {
  const kinds = Object.entries((source && source.kinds) || {}).map(([kind, n]) => `${kind} ${n}`).join(', ');
  return [
    t('diag.title', { version, served }),
    t('diag.date', { value: when(at) }),
    t('diag.instance', { value: origin || t('diag.unknown') }),
    t('diag.access', { value: t(`diag.access.${access}`) }),
    t('diag.browser', { value: agent }),
    '',
    t('diag.send'),
    ...(!source ? [t('diag.send.none')] : [
      source.ownerOnly ? t('diag.send.ownerOnly') : null,
      source.unsafe ? t('diag.send.unsafe', { n: String(source.unsafe) }) : null,
      source.charge ? t('diag.send.charge', { value: source.charge }) : null,
      source.progress ? t('diag.send.progress', { value: source.progress }) : null,
      source.catchUp ? t('diag.send.catchUp', { value: source.catchUp }) : null,
      t('diag.send.kinds', { value: kinds || t('diag.none') }),
      ...(source.exports.length ? source.exports.flatMap(e => exportLines(e, t)) : [t('diag.send.noExport')]),
    ]),
    '',
    t('diag.receive'),
    ...(!target || !target.journals.length ? [t('diag.recv.none')] : [
      target.compare === false ? t('diag.recv.compare') : null,
      target.visible === undefined ? null : t('diag.recv.visible', { value: t(target.visible ? 'diag.yes' : 'diag.recv.hidden') }),
      ...target.journals.flatMap(j => journalLines(j, t)),
    ]),
    '',
    t('diag.errors'),
    ...(errors.length ? errors.map(e => `${when(e.at)} ${clip(e.text)}`) : [t('diag.errors.none')]),
  ].filter(l => l !== null).join('\n');
}
