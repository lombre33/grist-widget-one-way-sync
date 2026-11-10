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
import { nowS } from '../engine/logic/common.js';
import { docUrl, maskKey } from '../engine/logic/codes.js';
import { docIdentity } from '../grist.js';
import { VERSION } from '../config.js';
import { ensureForm } from '../engine/pages.js';
import { formWhere, linkFigures } from '../form-link.js';
import { cancelPendingInvitation } from '../engine/source/actions.js';
import { rememberDocName, sourceDocName } from '../engine/source/synchro.js';
import {
  approveReply, checkReply, enablePublicLink, invitationCode, invitationState, linkReturn, loadPlan, renewInvitation, sendExisting, startInvitation, startReturn,
} from '../engine/source/invite.js';
import { estimateLines, progressTo } from './flow.js';
import {
  backButton, cancelButton, closeButtons, codeField, confirmDialog, controlLine, copyField, docLink, el, laterButton, message, openWizard, run,
  versionNote,
} from '../ui.js';
import { handoffButton, roleGuide } from '../guide.js';
import { stepHelp } from '../tutorial.js';
import { tabLink } from '../tab-link.js';
import { tabSendBlock } from '../tab-link-ui.js';
import { dateText, t } from '../i18n.js';

const STEP = { options: 0, invitation: 1, reply: 2, load: 3 };
const later = laterButton();
const back = backButton;

// `onClose` : appelé à la fermeture (l'onglet se redessine). Une invitation expirée est refaite,
// après confirmation (voir renew).
export async function recipientWizard(exp, pending, onClose) {
  const expired = pending && invitationState(pending) === 'expired';
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
async function showOptions(ctx) {
  const { exp } = ctx;
  // Le widget ne peut pas lire le nom de son document : la personne le donne une fois (gardé dans la note), il part
  // dans les invitations, que la CIBLE montre à côté du lien vers ce document.
  const nameInput = el('input', { type: 'text', class: 'input', id: 'gristsync-doc-name', maxlength: 200, autocomplete: 'off', value: await sourceDocName() });
  const namePart = el('div', { class: 'form' }, el('label', { for: 'gristsync-doc-name' }, t('send.docName')), nameInput, el('p', { class: 'muted small' }, t('send.docName.help')));
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
    strongPart, namePart, parts.public, parts.echange, report, stepHelp(['s-options', 'public']), roleGuide({ you: 'source', current: 0 }),
  ], [cancelButton(), { label: t('send.invite'), kind: 'btn-primary', onClick: () => run(null, report, async () => {
    await rememberDocName(nameInput.value);
    return invite(ctx, mode(), mode() !== 'public' && strongBox.checked);
  }) }]);
}

// Colonnes qu'un lien public rend lisibles par tous, table par table.
const publicList = exp => exp.tables.map(tb => `${tb.table} (${tb.columns.map(c => c.id).join(', ')})`).join(' ; ');

// 2. Invitation : le code à transmettre ; elle attend sa réponse sur la carte de l'export. Une
// invitation renforcée rend l'export renforcé (plus de lien public).
async function invite(ctx, mode, renforce) {
  if (mode === 'public') return invitePublic(ctx);
  if (mode === 'echange') return openBack(ctx, renforce);
  const { exp, entry, secret } = await startInvitation(ctx.exp, { renforce });
  ctx.exp = exp;
  return showInvitation(ctx, entry, secret);
}

// Lien public : l'export devient lisible par ses instantanés (enablePublicLink : refusé si une règle
// d'accès cache une partie de ses tables). Les règles d'accès sont posées à la fermeture (le document se
// recharge alors).
async function invitePublic({ exp, wizard, steps }) {
  const code = await enablePublicLink(exp);
  wizard.setSteps(steps.slice(0, 2));
  wizard.show(STEP.invitation, [el('p', {}, t('send.public.help')), copyField(code), handoffButton('target', 'public', 1, code), inviteOnTab(code),
    message('warn', t('send.public.turnOn')), stepHelp(['public']), roleGuide({ you: 'source', mode: 'public', current: 1 })], closeButtons());
}

// Le même code, envoyé d'un clic à l'autre document quand il est ouvert dans un autre onglet de ce navigateur (voir
// tab-link.js) : un raccourci à côté du copier-coller, qui reste ; le code est jugé de la même façon à l'arrivée.
const inviteOnTab = code => tabSendBlock({
  texts: { button: t('tab.out.button'), help: t('tab.out.help'), sent: t('tab.out.sent'), done: t('tab.out.seen'), silent: t('tab.out.silent') },
  start: (alive, ack) => tabLink().offerInvitation(code, { alive, onSeen: ack }),
});

async function showInvitation(ctx, entry, secret, retour = '') {
  const mode = retour ? 'echange' : 'reponse';
  const { code, expire, backCode: control } = await invitationCode(ctx.exp, entry, secret, retour);
  ctx.codes.set(entry.id, { secret, retour });
  const report = el('div', { class: 'report' });
  // Échange : le code de contrôle de l'envoi de retour, que la CIBLE voit en lisant l'invitation.
  const backCode = control ? controlLine(t('send.invite.backCode'), control) : null;
  const onTab = inviteOnTab(code);
  ctx.wizard.show(STEP.invitation, [el('p', {}, t('send.invite.help')), codeField(code),
    el('p', { class: 'muted small' }, t('send.invite.until', { at: dateText(expire * 1000) })), backCode, handoffButton('target', mode, 1, code), onTab, report,
    stepHelp(['s-invite', 't-code', 't-dest', 't-link', 't-reply']), roleGuide({ you: 'source', mode, current: 1 })],
  [back(() => run(null, report, () => backToOptions(ctx, entry))), later, { label: t('send.reply.ready'), kind: 'btn-primary', onClick: () => showReply(ctx, entry) }]);
  // La réponse de l'autre onglet fait passer à l'étape Réponse, déjà remplie et contrôlée.
  if (onTab) tabLink().awaitReply(entry.id, reply => showReply(ctx, entry, reply), { alive: () => report.isConnected });
}

// Retour aux options : l'invitation est annulée (son code ne sert plus), avec le journal de retour
// d'un Échange ; la personne en crée une autre.
async function backToOptions(ctx, inv) {
  if (!(await confirmDialog({ title: t('send.backOptions.title'), body: t('send.backOptions.body'), confirmLabel: t('common.back') }))) return;
  await cancelPendingInvitation(inv);
  await showOptions(ctx);
}

// Retour à l'invitation depuis l'étape Réponse : le même code s'il a été fait dans cette fenêtre
// (et n'a pas expiré) ; sinon il est refait (ni le code ni son secret ne sont gardés), avec un
// nouveau secret et 7 jours de plus, et l'ancien code ne sert plus : la personne le confirme. Un
// Échange le refait par son lien de retour.
async function backToInvitation(ctx, inv) {
  const kept = ctx.codes.get(inv.id);
  if (kept && invitationState(inv) !== 'expired') return showInvitation(ctx, inv, kept.secret, kept.retour);
  if (!(await confirmNewCode())) return null;
  return renew(ctx, inv);
}

const confirmNewCode = () => confirmDialog({ title: t('send.newCode.title'), body: t('send.newCode.body'), confirmLabel: t('send.newCode.ok') });

async function renew(ctx, inv) {
  if (inv.journal) return showBack(ctx, inv);
  const { entry, secret } = await renewInvitation(inv);
  return showInvitation(ctx, entry, secret);
}

// 2 bis. Échange : un journal de retour, que la CIBLE remplira par le formulaire publié ici, sur
// sa propre page. Le secret est tiré quand le code est fait, et le code n'est gardé nulle part :
// il peut être refait.
async function openBack(ctx, renforce) {
  const { exp, entry } = await startReturn(ctx.exp, { renforce });
  ctx.exp = exp;
  return showBack(ctx, entry);
}

async function showBack(ctx, inv) {
  await ensureForm(inv.journal);
  const input = el('input', { type: 'url', class: 'input', spellcheck: 'false', 'aria-label': t('send.back.title') });
  const report = el('div', { class: 'report' });
  const check = async () => {
    const { entry, secret, retour } = await linkReturn(inv, input.value);
    await showInvitation(ctx, entry, secret, retour);
  };
  ctx.wizard.show(STEP.invitation, [el('p', {}, t('send.back.help', { where: await formWhere(inv.journal) })), ...linkFigures(), input, report,
    roleGuide({ you: 'source', mode: 'echange', current: 0 })],
  [back(() => run(null, report, () => backToOptions(ctx, inv))), later, { label: t('recv.link.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }]);
}

// 3. Réponse : vérifier, montrer la fiche, approuver. La réponse doit désigner cette invitation,
// encore valable, et porter le même secret (comparé par empreinte). En sécurité renforcée, le code
// de contrôle doit avoir été comparé avec la personne.
// `arrived` : le code de la réponse, quand elle vient d'un autre onglet (tab-link.js) ; il est contrôlé aussitôt, comme
// s'il venait d'être collé, et la personne approuve ou non sur la fiche.
function showReply(ctx, inv, arrived = '') {
  const area = el('textarea', { class: 'code', rows: 4, spellcheck: 'false', 'aria-label': t('send.reply.title') });
  const fiche = el('div');
  const report = el('div', { class: 'report' });
  const tabLine = tabLink().supported() ? el('p', { class: 'muted small', role: 'status' }, t('tab.reply.wait')) : null;
  const body = [el('p', {}, t('send.reply.help')), area, tabLine, fiche, report, stepHelp(['s-reply', 's-load']), roleGuide({ you: 'source', current: 3 })];
  const check = async () => {
    const reply = await checkReply(ctx.exp, inv, area.value);
    const compared = el('input', { type: 'checkbox' });
    const identity = await docIdentity();
    fiche.replaceChildren(...replyFiche(reply, identity),
      ...(inv.renforce ? [el('label', { class: 'check' }, compared, t('send.reply.compared'))] : []));
    const go = () => approve(ctx, inv, reply, compared.checked); // le moteur refuse sans elle en sécurité renforcée
    ctx.wizard.show(STEP.reply, body, [toInvitation, later, { label: t('send.reply.approve'), kind: 'btn-primary', onClick: () => run(null, report, go) }]);
  };
  const toInvitation = back(() => run(null, report, () => backToInvitation(ctx, inv)));
  if (invitationState(inv) === 'expired') report.replaceChildren(message('warn', t('send.invite.expired')));
  ctx.wizard.show(STEP.reply, body, [toInvitation, later, { label: t('send.reply.check'), kind: 'btn-primary', onClick: () => run(null, report, check) }]);
  // La première réponse arrivée de l'autre onglet reste : une autre, différente, ne la remplace pas sous les yeux de la
  // personne (rien n'identifie l'expéditeur d'un message du canal) ; elle peut la recoller elle-même si c'est celle-là.
  let taken = '';
  const take = (code) => {
    if (area.value === code) return; // la même réponse redite par l'autre onglet
    if (taken) { tabLine.replaceChildren(t('tab.reply.other')); return; }
    taken = code;
    area.value = code;
    tabLine.replaceChildren(t('tab.reply.got'));
    run(null, report, check);
  };
  if (tabLine) tabLink().awaitReply(inv.id, take, { alive: () => area.isConnected });
  if (arrived) take(arrived);
}

// Date de la réponse : écrite en UTC par la CIBLE (« AAAA-MM-JJ HH:MM »), montrée à l'heure d'ici.
const replyDate = (at) => {
  const ms = Date.parse(`${String(at).replace(' ', 'T')}:00Z`);
  return Number.isNaN(ms) ? at : dateText(ms);
};

// Fiche de la personne qui répond, à vérifier avant d'approuver : le document, son dossier et son
// équipe sont dits par Grist ; l'e-mail et la date, par le code collé.
function replyFiche(reply, { docId, origin }) {
  const r = reply.recipient;
  const { share } = reply;
  // Le document en lien (nouvel onglet) : son adresse est refaite d'après l'équipe et l'identifiant que dit Grist.
  const place = ` (${share.folder || '—'}${share.personal ? '' : ` · ${share.teamName || share.team}`})`;
  const doc = [docLink(share.name, docUrl(origin, share.team, share.docId, share.name), t('common.docChecked')), place];
  const fiche = [[t('send.reply.tables'), reply.tables], [t('send.reply.doc'), r.docId === docId ? [...doc, ` · ${t('send.reply.sameDoc')}`] : doc],
    [t('send.reply.team'), share.personal ? t('send.reply.personalSpace') : share.teamName || share.team], [t('send.reply.email'), r.email], [t('send.reply.at'), replyDate(r.at)]];
  return [el('dl', { class: 'fiche' }, fiche.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v || '—')])),
    el('p', { class: 'muted small' }, t('send.reply.verified')),
    share.personal ? message('warn', t('send.reply.personal')) : null,
    reply.secret ? null : message('warn', t('send.reply.nosecret')),
    versionNote(reply.version, VERSION),
    controlLine(t('send.reply.code'), reply.code),
    el('p', { class: 'muted small' }, maskKey(reply.url))].filter(Boolean);
}

// Approuver la réponse (approveReply : le webhook et la clé de ce destinataire), puis proposer l'existant.
async function approve(ctx, inv, reply, compared) {
  await approveReply(ctx.exp, inv, reply, { compared });
  await showLoad(ctx);
}

// 4. Envoi : le branchement n'envoie que les modifications à venir ; proposer l'existant. La
// fenêtre se ferme pendant l'envoi, qui continue (voir resendTables) : l'onglet se redessine à la fin.
async function showLoad({ exp, wizard, onClose }) {
  const { total, est, count } = await loadPlan(exp);
  const report = el('div', { class: 'report' });
  if (!total) {
    wizard.show(STEP.load, [message('ok', t('send.connected')), el('p', {}, t('send.load.empty'))], closeButtons());
    return;
  }
  const send = async () => {
    wizard.show(STEP.load, [message('ok', t('send.connected')), report, el('p', { class: 'muted small' }, t('send.load.background'))], closeButtons());
    report.replaceChildren(message('info', t('send.load.start')));
    const n = await sendExisting(exp, progressTo(report));
    if (!report.isConnected) return onClose && onClose();
    return wizard.show(STEP.load + 1, n === null ? message('info', t('send.load.queued')) : message('ok', t('send.done', { n })), closeButtons());
  };
  const intro = count ? [el('p', {}, t('send.load.body', { n: count })), ...(est ? estimateLines(est) : [])]
    : [message('warn', t('send.load.nothing', { n: total }))];
  wizard.show(STEP.load, [message('ok', t('send.connected')), ...intro, report],
    [later, { label: t('send.load.ok'), kind: 'btn-primary', onClick: () => run(null, report, send) }]);
}
