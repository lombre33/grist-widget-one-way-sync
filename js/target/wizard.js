// CIBLE : assistant de réception, en quatre étapes (Code, Destinations, Lien, Réponse). Une
// réception en attente (ou à rebrancher) l'ouvre directement à l'étape Lien (`group`).
import { APPLIED_COL, AUTHOR_COL, EXPORT_COL, LIST_COL, journalId, nowS } from '../logic/common.js';
import { buildReply, buildWebhookUrl, parseFormLink, parseInvitation } from '../logic/codes.js';
import { controlCode, sameDoc } from '../logic/trust.js';
import { apply, docIdentity, fetchRows, isOwner, readSchema, shareInfo } from '../grist.js';
import { ensureForm, removeTechnicalTables } from '../pages.js';
import { formWhere, linkFigures, testUrl } from '../form-link.js';
import { wireExchange } from '../exchange.js';
import { readSourceNote, signingKey, syncRows } from '../source/synchro.js';
import { createJournal, prepareDest, receivedJournals, receivedKey, storeKey, updateJournalNote } from './journals.js';
import { consolidateAll } from './loop.js';
import { checkDests, confirmOutgoing, destField, mappingBlock } from './dest.js';
import { backButton, cancelButton, codeField, confirmDialog, controlLine, el, message, openWizard, run } from '../ui.js';
import { handoffButton, roleGuide } from '../guide.js';
import { stepHelp } from '../tutorial.js';
import { t } from '../i18n.js';

const STEP = { code: 0, dest: 1, link: 2, reply: 3 };
const cancel = cancelButton();
const back = backButton;
const flowOf = note => (note.mode === 'echange' ? 'echange' : 'reponse');

// `onClose` : appelé à la fermeture (l'onglet se redessine).
export function receiveWizard(group, onClose) {
  const steps = ['recv.step.code', 'recv.step.dest', 'recv.step.link', 'recv.step.reply'].map(k => t(k));
  const ctx = { steps, onClose, wizard: openWizard({ title: t('recv.new'), steps, onClose }) };
  return ctx.wizard.start(() => (group ? showLink(ctx, group) : showCode(ctx)));
}

// 1. Code d'invitation.
function showCode(ctx) {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('recv.invite.title') });
  const report = el('div', { class: 'report' });
  const next = async () => {
    const invitation = await readInvitation(area.value);
    const schema = await readSchema();
    const known = receivedJournals(schema).find(r => r.note.export === invitation.export);
    // La clé de signature d'un export ne change pas : une autre clé dans une nouvelle invitation
    // pour la même réception est à faire confirmer par la SOURCE.
    const oldKey = known ? receivedKey(schema, known.journal, known.note) : '';
    return known ? showRelink(ctx, known, invitation, Boolean(oldKey && invitation.cle && oldKey !== invitation.cle)) : showDest(ctx, invitation);
  };
  ctx.wizard.show(STEP.code, [el('p', {}, t('recv.invite.help')), area, report, stepHelp(['t-code']), roleGuide({ you: 'target', current: 1 })],
    [cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
}

// Invitation lue et contrôlée : même instance que ce document, encore valable ; un Échange suppose
// un propriétaire (ce document enverra aussi, par un webhook), et son adresse de retour doit
// désigner le document qui invite (demandé à Grist, voir shareInfo) : `share` le décrit, et
// `backCode` est le code de contrôle de l'envoi de retour.
async function readInvitation(text) {
  const invitation = parseInvitation(text);
  const { origin } = await docIdentity();
  if (invitation.mode === 'public' && new URL(invitation.base).origin !== origin) throw new Error('otherInstance');
  if (invitation.expire && nowS() > invitation.expire) throw new Error('invitationExpired');
  if (invitation.mode !== 'echange') return invitation;
  if (invitation.retourOrigin !== origin) throw new Error('otherInstance');
  if (!(await isOwner())) throw new Error('exchangeOwner');
  // L'Échange reprend l'identifiant de l'export de l'autre document : ce ne doit pas être celui
  // d'un export d'ici, qu'il remplacerait en coupant ses destinataires, sauf le retour de ce même
  // Échange (nouvelle invitation pour une réception déjà là, voir showRelink).
  const schema = await readSchema();
  const local = readSourceNote(schema).exports.some(e => e.id === invitation.export) || (await syncRows(schema)).some(r => r[EXPORT_COL] === invitation.export);
  const again = receivedJournals(schema).some(r => r.note.export === invitation.export && r.note.mode === 'echange' && !r.note.retour);
  if (local && !again) throw new Error('exportTaken');
  const share = await shareInfo(invitation.retour);
  if (!share) throw new Error('shareUnknown');
  if (!sameDoc(share.docId, invitation.from.docId || '')) throw new Error('shareOtherDoc');
  return { ...invitation, share, backCode: await controlCode(invitation.retour, invitation.secret) };
}

// Document vérifié chez Grist : nom (dossier · équipe), ou espace personnel.
const shareText = share => `${share.name} (${[share.folder, share.personal ? t('send.reply.personalSpace') : share.teamName || share.team].filter(Boolean).join(' · ')})`;

// Nouvelle invitation pour un export déjà reçu (lien coupé, destinataire révoqué) : la même
// réception reprend, avec son journal et ses tables, si l'invitation vient du même document, dans
// le même mode. La fiche est montrée avant : la personne confirme que c'est bien la même SOURCE.
// Un Échange rebranche son retour sur la nouvelle adresse.
function showRelink(ctx, known, invitation, newKey = false) {
  const same = invitation.mode !== 'public' && invitation.mode === (known.note.mode || 'reponse') && !known.note.retour
    && (known.note.from || {}).docId === invitation.from.docId;
  if (!same) throw new Error('alreadyReceived');
  const report = el('div', { class: 'report' });
  const relink = async () => {
    const { id, secret, name, renforce } = invitation;
    const from = { ...invitation.from, ...(invitation.share ? { docName: invitation.share.name } : {}) };
    await updateJournalNote(known.journal, n => ({ ...n, id, secret, name, from, renforce: renforce || undefined }));
    await storeKey(known.note.tables.map(tb => tb.dest), invitation.export, invitation.cle);
    const note = receivedJournals(await readSchema()).find(r => r.journal === known.journal).note;
    if (invitation.mode === 'echange') await wireExchange(note, invitation.retour);
    await ensureForm(known.journal);
    return showLink(ctx, { journal: known.journal, note }, message('info', t('recv.relink')));
  };
  ctx.wizard.show(STEP.dest, [message('info', t('recv.relink.confirm', { name: known.note.name, journal: known.journal })),
    newKey ? message('warn', t('recv.relink.newKey')) : null, sourceFiche(invitation), report],
    [back(() => showCode(ctx)), cancel, { label: t('recv.relink.ok'), kind: 'btn-primary', onClick: () => run(null, report, relink) }]);
}

// D'où vient une invitation : export, tables, personne et document qui l'ont faite ; pour un
// Échange, le document vérifié chez Grist et le code de contrôle de l'envoi de retour.
function sourceFiche(invitation) {
  const { from, share } = invitation;
  return el('div', {},
    message('info', t('recv.invite.summary', { name: invitation.name, n: invitation.tables.length, tables: invitation.tables.map(tb => tb.table).join(', ') })),
    from.email ? el('p', { class: 'small' }, t(from.docId ? 'recv.fromDoc' : 'recv.from', { from: from.email, doc: from.docId })) : null,
    share ? el('p', { class: 'small' }, t('recv.backDoc', { doc: shareText(share) })) : null,
    share && share.personal ? message('warn', t('recv.backPersonal')) : null,
    invitation.backCode ? controlLine(t('recv.backCode'), invitation.backCode) : null,
    invitation.renforce ? el('p', { class: 'small' }, t('recv.renforce')) : null);
}

// 2. Destinations : une par table reçue.
// Le journal est lisible par les éditeurs seulement (case cochée par défaut, voir acl.js) : il garde
// les versions reçues, quelles que soient les règles des tables de destination. Un Échange
// renforcé demande d'avoir comparé le code de contrôle de l'envoi de retour.
async function showDest(ctx, invitation) {
  const schema = await readSchema();
  const rows = invitation.tables.map(tb => ({ tb, pick: destField(schema, tb.table) }));
  const report = el('div', { class: 'report' });
  const reserveBox = el('input', { type: 'checkbox', checked: ctx.reserve !== false });
  const compared = el('input', { type: 'checkbox' });
  const mustCompare = invitation.renforce && invitation.mode === 'echange';
  const next = async () => {
    if (mustCompare && !compared.checked) throw new Error('codeNotCompared');
    ctx.reserve = reserveBox.checked;
    const current = await readSchema();
    const plans = rows.map(({ tb, pick }) => ({ tb, dest: pick.dest() }));
    await checkDests(current, plans.map(p => ({ table: p.tb.table, dest: p.dest })), invitation.from.docId);
    if (plans.some(p => current.has(p.dest))) return showColumns(ctx, invitation, plans, current);
    return create(ctx, invitation, plans);
  };
  ctx.wizard.show(STEP.dest, [
    sourceFiche(invitation),
    el('p', {}, t('recv.dest')),
    el('div', { class: 'dest-grid' }, el('span', { class: 'dest-head' }, t('recv.dest.from')), el('span', { class: 'dest-head' }, t('recv.dest.to')),
      ...rows.flatMap(r => [el('span', { class: 'dest-from' }, r.tb.table), r.pick.node])),
    invitation.mode === 'echange' ? message('info', t('recv.consent.echange')) : null,
    el('p', { class: 'muted small' }, t(invitation.mode === 'public' ? 'recv.consent.public' : 'recv.consent')),
    el('label', { class: 'check' }, reserveBox, t('recv.reserve')),
    mustCompare ? el('label', { class: 'check' }, compared, t('recv.backCompared')) : null,
    report, stepHelp(['t-dest']), roleGuide({ you: 'target', mode: invitation.mode, current: 1 }),
  ], [back(() => showCode(ctx)), cancel, { label: t('common.next'), kind: 'btn-primary', onClick: () => run(null, report, next) }]);
}

// 2 bis. Tables existantes : correspondance des colonnes et rattachement.
function showColumns(ctx, invitation, plans, schema) {
  const report = el('div', { class: 'report' });
  const blocks = plans.filter(p => schema.has(p.dest)).map(p => ({ p, block: mappingBlock(schema, p.tb.table, p.dest, p.tb.columns) }));
  const next = async () => {
    for (const { p, block } of blocks) Object.assign(p, block.read());
    if (invitation.mode === 'echange' && !(await confirmOutgoing(schema, plans.map(p => p.dest), shareText(invitation.share)))) return null;
    return create(ctx, invitation, plans);
  };
  ctx.wizard.show(STEP.dest, [el('p', {}, t('recv.existing')), ...blocks.map(b => b.block.node), report, stepHelp(['t-dest'])], [
    back(() => showDest(ctx, invitation)),
    { label: t('recv.create'), kind: 'btn-primary', onClick: () => run(null, report, next) },
  ]);
}

// Un journal pour l'export, nommé d'après lui, et une destination par table. Échange : l'envoi de
// retour est branché aussitôt ; l'adresse de retour, un droit d'écriture, n'est notée nulle part.
async function create(ctx, invitation, plans) {
  const journal = journalId(invitation.name, (await readSchema()).tableIds);
  const { mode } = invitation;
  const reserve = ctx.reserve !== false;
  const note = {
    id: invitation.id, export: invitation.export, name: invitation.name, secret: invitation.secret,
    from: { ...invitation.from, ...(invitation.share ? { docName: invitation.share.name } : {}) },
    ...(mode === 'public' ? { mode, base: invitation.base } : mode === 'echange' ? { mode } : {}),
    ...(invitation.renforce ? { renforce: true } : {}), ...(reserve ? { reserve: true } : {}),
    tables: plans.map(p => ({ table: p.tb.table, dest: p.dest, columns: p.tb.columns, ...(p.map ? { map: p.map } : {}), ...(p.match ? { match: p.match } : {}) })),
    refused: [], missing: {},
  };
  const before = await readSchema();
  for (const p of plans) await prepareDest({ dest: p.dest, columns: p.tb.columns, map: p.map });
  await storeKey(plans.map(p => p.dest), invitation.export, invitation.cle);
  await createJournal(journal, note);
  ctx.made = mode === 'reponse' || !mode ? { invitation, journal, tables: plans.map(p => p.dest).filter(d => !before.has(d)) } : null;
  if (mode === 'echange') await wireExchange(note, invitation.retour);
  if (mode !== 'public') {
    await ensureForm(journal);
    return showLink(ctx, { journal, note });
  }
  ctx.wizard.setSteps(ctx.steps.slice(0, 2));
  ctx.wizard.show(STEP.link, [message('ok', t('recv.public.done')), roleGuide({ you: 'target', mode: 'public', current: 1 })], [{ label: t('common.close'), kind: 'btn-primary' }]);
  consolidateAll();
  return null;
}

// 3. Lien du formulaire de réception.
async function showLink(ctx, group, intro = null) {
  const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('recv.link.title') });
  const report = el('div', { class: 'report' });
  const where = await formWhere(group.journal);
  const made = ctx.made && ctx.made.journal === group.journal ? ctx.made : null;
  ctx.wizard.show(STEP.link, [intro, el('p', {}, t('recv.link.help', { where, n: group.note.tables.length })),
    ...linkFigures(), input, report, roleGuide({ you: 'target', mode: flowOf(group.note), current: 2 })],
  [made ? back(() => run(null, report, () => undoCreate(ctx, made))) : null, { label: t('common.later') },
    { label: t('recv.link.check'), kind: 'btn-primary', onClick: () => run(null, report, () => showReply(ctx, group, input.value)) }].filter(Boolean));
}

// Retour aux destinations depuis l'étape Lien : le journal et son formulaire (avec son lien
// d'écriture) sont effacés, et les tables que cette réception a créées, si elles sont encore vides.
async function undoCreate(ctx, made) {
  if (!(await confirmDialog({ title: t('recv.undo.title'), body: t('recv.undo.body'), confirmLabel: t('common.back') }))) return null;
  const empty = [];
  for (const table of made.tables) if (!(await fetchRows(table).catch(() => [null])).length) empty.push(table);
  await removeTechnicalTables([made.journal]);
  await apply(empty.map(table => ['RemoveTable', table]));
  ctx.made = null;
  return showDest(ctx, made.invitation);
}

// 4. Réponse à renvoyer, une fois le lien vérifié.
async function showReply(ctx, { journal, note }, link) {
  if (!parseFormLink(link)) throw new Error('formLink');
  const url = buildWebhookUrl(link, journal);
  await testUrl(url, journal);
  const identity = await docIdentity();
  const exchange = note.mode === 'echange';
  const code = buildReply({
    id: note.id, secret: note.secret, url, retour: exchange ? note.tables.map(tb => ({ table: tb.dest, dest: tb.table })) : null,
    cle: exchange ? await signingKey(note.export) : '',
    recipient: { email: await myEmail(journal), docId: identity.docId, team: identity.team, at: new Date().toISOString().slice(0, 16).replace('T', ' ') },
  });
  const flow = flowOf(note);
  ctx.wizard.show(STEP.reply, [message('ok', t('recv.link.ok')), el('p', {}, t('recv.reply.help')), codeField(code),
    controlLine(t('recv.reply.code'), await controlCode(url, note.secret)),
    handoffButton('source', flow, 3, code),
    stepHelp(['t-reply', 's-reply', 's-load', 't-daily']), roleGuide({ you: 'target', mode: flow, current: 3 })],
  [back(() => showLink(ctx, { journal, note })), { label: t('common.close'), kind: 'btn-primary' }]);
}

// E-mail de la personne connectée, calculé par le serveur Grist : une ligne vide ajoutée au
// journal avec ses droits remplit la colonne Sync_Par (formule user.Email). Le nettoyage l'efface.
async function myEmail(journal) {
  const id = (await apply([['AddRecord', journal, null, { [APPLIED_COL]: true, [LIST_COL]: '' }]])).retValues[0];
  return ((await fetchRows(journal)).find(r => r.id === id) || {})[AUTHOR_COL] || '';
}
