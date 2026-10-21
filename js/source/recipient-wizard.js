// SOURCE : assistant d'ajout d'un destinataire, en quatre étapes (Options, Invitation, Réponse,
// Envoi ; Options et Invitation seulement pour le lien public). Une invitation en attente le
// rouvre à l'étape Réponse (`pending`), ou à l'étape Invitation pour un Échange qui attend le lien
// de son formulaire de retour.
// Une invitation porte toujours un secret, vaut 7 jours, et la clé publique d'une paire tirée pour
// elle ; la réponse porte celle de la CIBLE, et chaque côté en tire la clé qui signe les envois vers
// ce destinataire (voir linkKeys, trust.js). La réponse est contrôlée chez Grist : la clé de son
// formulaire doit désigner le document que dit la fiche. Un code de contrôle, tiré de l'adresse, du
// secret, des clés publiques et du niveau de sécurité, s'affiche des deux côtés ; en sécurité
// renforcée (`renforce`), il faut l'avoir comparé.
import { SYNC_TABLE, journalId, nowS, randomHex, sha256 } from '../logic/common.js';
import { buildInvitation, buildWebhookUrl, loopingTables, maskKey, parseFormLink, parseReply } from '../logic/codes.js';
import { exportCondition, exportEmail, hookLabel, hookMemo, hookName, readTables } from '../logic/exports.js';
import { dropInvitation, putInvitation, setExport } from '../logic/notes.js';
import { codeFacts, controlCode, expiresAt, isExpired, isPrivateKey, linkKeys, newKeyPair, sameDoc } from '../logic/trust.js';
import { hiddenTables } from '../logic/acl.js';
import { createWebhook, docIdentity, fetchRows, readSchema, shareInfo } from '../grist.js';
import { VERSION } from '../config.js';
import { ensureForm, removeTechnicalTables } from '../pages.js';
import { formWhere, linkFigures, testUrl } from '../form-link.js';
import { addDeleteColumns, markHub } from '../exchange.js';
import { pruneKeys, putRecipientKey, recordEvent, saveExport, syncRows, updateSourceNote } from './synchro.js';
import { createJournal, storeKey, updateJournalNote } from '../target/journals.js';
import { receivedDests } from '../logic/received.js';
import { resendTables } from './resend.js';
import { publicCode } from './actions.js';
import {
  backButton, cancelButton, closeButtons, codeField, confirmDialog, controlLine, copyField, el, failure, laterButton, message, openWizard, run,
  versionNote,
} from '../ui.js';
import { handoffButton, roleGuide } from '../guide.js';
import { stepHelp } from '../tutorial.js';
import { dateText, t } from '../i18n.js';

const STEP = { options: 0, invitation: 1, reply: 2, load: 3 };
const later = laterButton();
const back = backButton;

// `onClose` : appelé à la fermeture (l'onglet se redessine). Une invitation expirée est refaite,
// après confirmation (voir renew).
export async function recipientWizard(exp, pending, onClose) {
  const expired = pending && !(pending.journal && !pending.ready) && isExpired(pending.at, nowS());
  if (expired && !(await confirmNewCode())) return null;
  const steps = ['send.step.options', 'send.step.invitation', 'send.step.reply', 'send.step.load'].map(k => t(k));
  const ctx = { exp, steps, onClose, codes: new Map(), wizard: openWizard({ title: t('send.person.title', { name: exp.name }), steps, onClose }) };
  return ctx.wizard.start(() => {
    if (!pending) return showOptions(ctx);
    if (pending.journal && !pending.ready) return showBack(ctx, pending);
    return expired ? renew(ctx, pending) : showReply(ctx, pending);
  });
}

// 1. Mode (réponse, lien public ou Échange) et sécurité renforcée (sans objet pour le lien public :
// grisée ; un export renforcé ne peut pas être public). L'Échange suppose un export sans autre
// destinataire, ou déjà en Échange : un participant de plus (Échange à plusieurs, ce document
// administre) ; un export en Échange n'a que des participants.
function showOptions(ctx) {
  const { exp } = ctx;
  const more = (exp.echange && !exp.retour) || exp.invitations.some(inv => inv.journal);
  const strongBox = el('input', { type: 'checkbox', checked: Boolean(exp.renforce) });
  const strongPart = el('div', { class: 'form' }, el('label', { class: 'check' }, strongBox, t('send.renforce')), el('p', { class: 'muted small' }, t('send.renforce.help')));
  const parts = {
    public: el('div', { class: 'hidden' }, message('err', t('send.public.columns', { list: publicList(exp) })), message('warn', t('send.public.warn'))),
    echange: el('div', { class: more ? '' : 'hidden' }, message('info', t(more ? 'send.mode.echange.moreHelp' : 'send.mode.echange.help'))),
  };
  const radio = (value, label, checked, disabled) => el('label', { class: 'check' },
    el('input', { type: 'radio', name: 'gristsync-mode', value, checked, disabled, onchange: () => {
      strongBox.disabled = value === 'public';
      for (const [key, part] of Object.entries(parts)) part.classList.toggle('hidden', value !== key);
    } }), label);
  const report = el('div', { class: 'report' });
  const mode = () => (document.querySelector('input[name="gristsync-mode"]:checked') || {}).value;
  const exchangeOk = more || (!exp.recipients.length && !exp.invitations.length && !exp.public);
  // Le parcours principal d'abord (un seul sens, avec secret) ; les autres modes, plus discrets.
  ctx.wizard.show(STEP.options, [
    el('p', { class: 'muted small' }, t('send.person.tables', { tables: exp.tables.map(tb => tb.table).join(', ') })),
    el('p', { class: 'field-title', id: 'gristsync-mode-title' }, t('send.mode')),
    el('div', { class: 'form', role: 'radiogroup', 'aria-labelledby': 'gristsync-mode-title' },
      radio('reponse', t('send.mode.reply'), !more, more),
      el('p', { class: 'muted small' }, t('send.mode.others')),
      radio('echange', more ? t('send.mode.echange.more') : exchangeOk ? t('send.mode.echange') : t('send.mode.echange.off'), more, !exchangeOk),
      radio('public', exp.public ? t('send.mode.publicDone') : exp.renforce ? t('send.mode.publicStrong') : t('send.mode.public'), false, exp.public || more || exp.renforce)),
    strongPart, parts.public, parts.echange, report, stepHelp(['s-options', 'public']), roleGuide({ you: 'source', current: 0 }),
  ], [cancelButton(), { label: t('send.invite'), kind: 'btn-primary', onClick: () => run(null, report, () => invite(ctx, mode(), mode() !== 'public' && strongBox.checked)) }]);
}

// Colonnes qu'un lien public rend lisibles par tous, table par table.
const publicList = exp => exp.tables.map(tb => `${tb.table} (${tb.columns.map(c => c.id).join(', ')})`).join(' ; ');

// 2. Invitation : le code à transmettre ; elle attend sa réponse sur la carte de l'export. Une
// invitation renforcée rend l'export renforcé (plus de lien public).
async function invite(ctx, mode, renforce) {
  if (mode === 'public') return invitePublic(ctx);
  if (renforce && !ctx.exp.renforce) {
    await updateSourceNote(note => setExport(note, ctx.exp.id, { renforce: true }));
    ctx.exp = { ...ctx.exp, renforce: true };
  }
  if (mode === 'echange') return openBack(ctx, renforce);
  const secret = randomHex(16);
  const entry = await withKeys({ id: randomHex(8), export: ctx.exp.id, hash: await sha256(secret), at: nowS(), ...(renforce ? { renforce: true } : {}) });
  await updateSourceNote(note => putInvitation(note, entry));
  return showInvitation(ctx, entry, secret);
}

// Lien public : l'export devient lisible par ses instantanés. Refusé si une règle d'accès cache
// une partie de ses tables. Les règles d'accès sont posées à la fermeture (le document se
// recharge alors).
async function invitePublic({ exp, wizard, steps }) {
  const [resources, rules] = await Promise.all([fetchRows('_grist_ACLResources'), fetchRows('_grist_ACLRules')]);
  const hidden = hiddenTables(resources, rules, readTables(exp.tables));
  if (hidden.length) throw failure('publicHidden', { tables: hidden.join(', ') });
  await updateSourceNote(note => setExport(note, exp.id, { public: true }));
  await saveExport(exp.id, exp.tables, { isPublic: true });
  const code = await publicCode(exp);
  wizard.setSteps(steps.slice(0, 2));
  wizard.show(STEP.invitation, [el('p', {}, t('send.public.help')), copyField(code), handoffButton('target', 'public', 1, code),
    message('warn', t('send.public.turnOn')), stepHelp(['public']), roleGuide({ you: 'source', mode: 'public', current: 1 })], closeButtons());
}

// Paire de clés d'une invitation (voir linkKeys) : la publique part dans le code, la privée reste
// dans la note jusqu'à l'approbation de la réponse. Une invitation d'avant la 0.10 en reçoit une
// quand son code est refait.
async function withKeys(entry) {
  if (isPrivateKey(entry.prive) && entry.pub) return entry;
  const { pub, priv } = await newKeyPair();
  return { ...entry, pub, prive: priv };
}

async function showInvitation(ctx, entry, secret, retour = '') {
  const { exp } = ctx;
  const mode = retour ? 'echange' : 'reponse';
  const [{ origin, docId }, rows] = await Promise.all([docIdentity(), syncRows()]);
  const email = exportEmail(rows, exp.id);
  const code = buildInvitation({
    id: entry.id, exportId: exp.id, name: exp.name, origin, secret, from: { email, docId }, tables: exp.tables, retour,
    expire: expiresAt(entry.at), renforce: Boolean(entry.renforce), pub: entry.pub, version: VERSION,
  });
  ctx.codes.set(entry.id, { secret, retour });
  const report = el('div', { class: 'report' });
  // Échange : le code de contrôle de l'envoi de retour, que la CIBLE voit en lisant l'invitation.
  const backCode = retour ? controlLine(t('send.invite.backCode'), await controlCode(retour, secret, codeFacts(entry))) : null;
  ctx.wizard.show(STEP.invitation, [el('p', {}, t('send.invite.help')), codeField(code),
    el('p', { class: 'muted small' }, t('send.invite.until', { at: dateText(expiresAt(entry.at) * 1000) })), backCode, handoffButton('target', mode, 1, code), report,
    stepHelp(['s-invite', 't-code', 't-dest', 't-link', 't-reply']), roleGuide({ you: 'source', mode, current: 1 })],
  [back(() => run(null, report, () => backToOptions(ctx, entry))), later, { label: t('send.reply.ready'), kind: 'btn-primary', onClick: () => showReply(ctx, entry) }]);
}

// Retour aux options : l'invitation est annulée (son code ne sert plus), avec le journal de retour
// d'un Échange ; la personne en crée une autre.
async function backToOptions(ctx, inv) {
  if (!(await confirmDialog({ title: t('send.backOptions.title'), body: t('send.backOptions.body'), confirmLabel: t('common.back') }))) return;
  await updateSourceNote(note => dropInvitation(note, inv.id));
  if (inv.journal) await removeTechnicalTables([inv.journal]);
  showOptions(ctx);
}

// Retour à l'invitation depuis l'étape Réponse : le même code s'il a été fait dans cette fenêtre
// (et n'a pas expiré) ; sinon il est refait (ni le code ni son secret ne sont gardés), avec un
// nouveau secret et 7 jours de plus, et l'ancien code ne sert plus : la personne le confirme. Un
// Échange le refait par son lien de retour.
async function backToInvitation(ctx, inv) {
  const kept = ctx.codes.get(inv.id);
  if (kept && !isExpired(inv.at, nowS())) return showInvitation(ctx, inv, kept.secret, kept.retour);
  if (!(await confirmNewCode())) return null;
  return renew(ctx, inv);
}

const confirmNewCode = () => confirmDialog({ title: t('send.newCode.title'), body: t('send.newCode.body'), confirmLabel: t('send.newCode.ok') });

async function renew(ctx, inv) {
  if (inv.journal) return showBack(ctx, inv);
  const secret = randomHex(16);
  const entry = await withKeys({ ...inv, hash: await sha256(secret), at: nowS() });
  await updateSourceNote(note => putInvitation(note, entry));
  return showInvitation(ctx, entry, secret);
}

// 2 bis. Échange : un journal de retour, que la CIBLE remplira par le formulaire publié ici, sur
// sa propre page. Le secret est tiré quand le code est fait, et le code n'est gardé nulle part :
// il peut être refait.
async function openBack(ctx, renforce) {
  const { exp } = ctx;
  const journal = journalId(exp.name, (await readSchema()).tableIds);
  const entry = await withKeys({ id: randomHex(8), export: exp.id, hash: '', at: nowS(), journal, ...(renforce ? { renforce: true } : {}) });
  await createJournal(journal, {
    id: entry.id, export: exp.id, name: exp.name, secret: '', from: {}, mode: 'echange', retour: true, reserve: true, tables: [], refused: [], missing: {},
  });
  await updateSourceNote(note => putInvitation(note, entry));
  return showBack(ctx, entry);
}

async function showBack(ctx, inv) {
  await ensureForm(inv.journal);
  const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('send.back.title') });
  const report = el('div', { class: 'report' });
  const check = async () => {
    if (!parseFormLink(input.value)) throw new Error('formLink');
    const retour = buildWebhookUrl(input.value, inv.journal);
    await testUrl(retour, inv.journal);
    const secret = randomHex(16);
    const entry = await withKeys({ ...inv, hash: await sha256(secret), at: nowS(), ready: true });
    await updateSourceNote(note => putInvitation(note, entry));
    await showInvitation(ctx, entry, secret, retour);
  };
  ctx.wizard.show(STEP.invitation, [el('p', {}, t('send.back.help', { where: await formWhere(inv.journal) })), ...linkFigures(), input, report,
    roleGuide({ you: 'source', mode: 'echange', current: 0 })],
  [back(() => run(null, report, () => backToOptions(ctx, inv))), later, { label: t('recv.link.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }]);
}

// 3. Réponse : vérifier, montrer la fiche, approuver. La réponse doit désigner cette invitation,
// encore valable, et porter le même secret (comparé par empreinte). En sécurité renforcée, le code
// de contrôle doit avoir été comparé avec la personne.
function showReply(ctx, inv) {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('send.reply.title') });
  const fiche = el('div');
  const report = el('div', { class: 'report' });
  const body = [el('p', {}, t('send.reply.help')), area, fiche, report, stepHelp(['s-reply', 's-load']), roleGuide({ you: 'source', current: 3 })];
  const check = async () => {
    const reply = await checkReply(ctx.exp, inv, area.value);
    const compared = el('input', { type: 'checkbox' });
    fiche.replaceChildren(...replyFiche(reply, (await docIdentity()).docId),
      ...(inv.renforce ? [el('label', { class: 'check' }, compared, t('send.reply.compared'))] : []));
    const go = () => {
      if (inv.renforce && !compared.checked) throw new Error('codeNotCompared');
      return approve(ctx, inv, reply);
    };
    ctx.wizard.show(STEP.reply, body, [toInvitation, later, { label: t('send.reply.approve'), kind: 'btn-primary', onClick: () => run(null, report, go) }]);
  };
  const toInvitation = back(() => run(null, report, () => backToInvitation(ctx, inv)));
  if (isExpired(inv.at, nowS())) report.replaceChildren(message('warn', t('send.invite.expired')));
  ctx.wizard.show(STEP.reply, body, [toInvitation, later, { label: t('send.reply.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }]);
}

// Réponse lue et contrôlée : même instance, cette invitation, encore valable, même secret, pas de
// boucle ; la clé de son formulaire désigne bien le document de la fiche (demandé à Grist, voir
// shareInfo) ; un Échange dit où la CIBLE a rangé chaque table de l'export. Une invitation en
// attente d'avant le secret obligatoire (sans empreinte) est acceptée sans secret. Les clés de ce
// destinataire sont tirées ici (`keys`) : une clé publique qui n'en est pas une rend la réponse
// invalide avant toute approbation.
async function checkReply(exp, inv, text) {
  const reply = parseReply(text, (await docIdentity()).origin, VERSION);
  if (reply.id !== inv.id || inv.hash !== (reply.secret ? await sha256(reply.secret) : '')) throw new Error('unknownInvitation');
  if (!isPrivateKey(inv.prive)) throw new Error('inviteOld');
  if (isExpired(inv.at, nowS())) throw new Error('invitationExpired');
  if (loopingTables(exp.tables.map(tb => tb.table), reply.recipient.docId, receivedDests(await readSchema())).length) throw new Error('loop');
  if (Boolean(inv.journal) !== Boolean(reply.retour) || (reply.retour || []).some(b => !exp.tables.some(tb => tb.table === b.dest))) throw new Error('codeInvalid');
  const share = await shareInfo(reply.url);
  if (!share) throw new Error('shareUnknown');
  if (!sameDoc(share.docId, reply.recipient.docId)) throw new Error('shareOtherDoc');
  return {
    ...reply, share, keys: await linkKeys(inv.prive, reply.pub, exp.id, inv.id), code: await controlCode(reply.url, reply.secret, codeFacts(inv, reply.pub)),
    tables: reply.retour ? reply.retour.map(b => t('send.exchange.map', b)).join(', ') : exp.tables.map(tb => tb.table).join(', '),
  };
}

// Date de la réponse : écrite en UTC par la CIBLE (« AAAA-MM-JJ HH:MM »), montrée à l'heure d'ici.
const replyDate = (at) => {
  const ms = Date.parse(`${String(at).replace(' ', 'T')}:00Z`);
  return Number.isNaN(ms) ? at : dateText(ms);
};

// Fiche de la personne qui répond, à vérifier avant d'approuver : le document, son dossier et son
// équipe sont dits par Grist ; l'e-mail et la date, par le code collé.
function replyFiche(reply, docId) {
  const r = reply.recipient;
  const { share } = reply;
  const doc = `${share.name} (${share.folder || '—'}${share.personal ? '' : ` · ${share.teamName || share.team}`})`;
  const fiche = [[t('send.reply.tables'), reply.tables], [t('send.reply.doc'), r.docId === docId ? `${doc} · ${t('send.reply.sameDoc')}` : doc],
    [t('send.reply.team'), share.personal ? t('send.reply.personalSpace') : share.teamName || share.team], [t('send.reply.email'), r.email], [t('send.reply.at'), replyDate(r.at)]];
  return [el('dl', { class: 'fiche' }, fiche.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')])),
    el('p', { class: 'muted small' }, t('send.reply.verified')),
    share.personal ? message('warn', t('send.reply.personal')) : null,
    reply.secret ? null : message('warn', t('send.reply.nosecret')),
    versionNote(reply.version, VERSION),
    controlLine(t('send.reply.code'), reply.code),
    el('p', { class: 'muted small' }, maskKey(reply.url))].filter(Boolean);
}

// Un webhook sur Synchro, filtré sur l'export, vers le journal de la CIBLE ; la clé de ce
// destinataire est posée avant (rangée sous l'invitation, puis sous le webhook) : rien ne part vers
// lui sans sa signature. Échange : l'export reçoit sa ligne 'echange', le journal de retour sait
// d'où viennent ses tables (il commence à recopier) et quel webhook est celui de ce participant ;
// dès deux participants, l'Échange est à plusieurs (markHub).
async function approve(ctx, inv, reply) {
  const { exp } = ctx;
  const r = reply.recipient;
  await putRecipientKey(exp.id, inv.id, reply.keys.down);
  const memo = hookMemo({ ...r, docName: reply.share.name });
  const hook = await createWebhook({ name: hookName(exp.name, exp.id), memo, url: reply.url, tableId: SYNC_TABLE, condition: exportCondition(exp.id) });
  await recordEvent(exp.id, 'join', { who: hookLabel(memo) });
  await putRecipientKey(exp.id, hook, reply.keys.down, inv.id);
  if (inv.journal) {
    await addDeleteColumns(exp.tables.map(tb => tb.table));
    await saveExport(exp.id, exp.tables, { swap: true });
    // Le journal de retour vérifie la signature des envois du participant, avec la clé de retour
    // tirée de sa réponse : elle est rangée dans ses destinations, les tables de l'export (voir
    // receivedKey).
    await storeKey(exp.tables.map(tb => tb.table), inv.journal, reply.keys.up);
    // `own` vide : les tables de l'export sont les nôtres, le widget n'y a créé aucune colonne.
    await updateJournalNote(inv.journal, n => ({
      ...n, from: { email: r.email, docId: r.docId, docName: reply.share.name }, hook, tables: reply.retour.map(b => ({ table: b.table, dest: b.dest, columns: [], own: [] })),
    }));
    await markHub(exp.id);
  }
  await updateSourceNote((note) => {
    const rest = dropInvitation(note, inv.id);
    return inv.journal ? setExport(rest, exp.id, { echange: true }) : rest;
  });
  await pruneKeys(exp.id);
  await showLoad(ctx);
}

// 4. Envoi : le branchement n'envoie que les modifications à venir ; proposer l'existant. La
// fenêtre se ferme pendant l'envoi, qui continue (voir resendTables) : l'onglet se redessine à la fin.
async function showLoad({ exp, wizard, onClose }) {
  let total = 0;
  for (const { table } of exp.tables) total += (await fetchRows(table)).length;
  const report = el('div', { class: 'report' });
  if (!total) {
    wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.empty'))], closeButtons());
    return;
  }
  const send = async () => {
    wizard.show(STEP.load, [message('ok', t('send.connected')), report, el('p', { class: 'muted small' }, t('send.load.background'))], closeButtons());
    report.replaceChildren(message('info', t('send.load.progress', { done: 0, total })));
    const n = await resendTables(exp.id, exp.tables.map(tb => tb.table), report);
    if (!report.isConnected) return onClose && onClose();
    return wizard.show(STEP.load + 1, n === null ? message('info', t('send.load.queued')) : message('ok', t('send.done')), closeButtons());
  };
  wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.body', { n: total })), report],
    [later, { label: t('send.load.ok'), kind: 'btn-primary', onClick: () => run(null, report, send) }]);
}
