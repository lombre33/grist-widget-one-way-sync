// SOURCE : ce que l'onglet Envoyer dit d'un envoi. Où il en est (lignes, lots, temps restant), ce
// qu'il attend (budget, autre page, rattrapage), pourquoi il ne bouge pas (destinataire en erreur,
// tout en pause), et ce qu'un envoi va coûter avant de le lancer.
import { EXPORT_COL, LIST_COL, SYNC_TABLE, TABLE_COL, TYPE_COL } from '../engine/logic/common.js';
import { LONG_SECONDS, durationParts, estimateSend, lineBytes, sizeParts } from '../engine/logic/estimate.js';
import { BUDGET_WINDOW, RESEND_BUDGET, eligibleRows } from '../engine/logic/resend.js';
import { fetchRows, selectRows } from '../grist.js';
import { readHooks } from '../engine/source/synchro.js';
import { el, openModal } from '../ui.js';
import { t, timeText } from '../i18n.js';

export function durationText(seconds) {
  const { h, min } = durationParts(seconds);
  if (!h && !min) return t('common.dur.under');
  if (!h) return t('common.dur.min', { n: min });
  return min ? t('common.dur.hm', { h, m: min }) : t('common.dur.h', { h });
}

export function sizeText(bytes) {
  const { n, unit } = sizeParts(bytes);
  return t(`common.size.${unit}`, { n });
}

// ---------------------------------------------------------------------------------------------
// Avancement d'un export (voir exportFlow)

const TONE = { blocked: 'err', paused: 'warn', interrupted: 'warn' };
const MOVING = ['running', 'runningOther', 'budget'];

// Le message d'un état d'envoi, avec sa barre d'avancement quand le total est connu. Sans rôle
// d'alerte : il se met à jour de lui-même, un lecteur d'écran ne doit pas le répéter à chaque lot.
export function flowView(flow) {
  if (!flow) return null;
  const v = flow.vars;
  const parts = [t(`send.flow.${flow.key}`, { ...v, at: v.at ? timeText(v.at) : '' })];
  if (v.left && MOVING.includes(flow.key)) parts.push(t('send.flow.left', { left: durationText(v.left) }));
  if (flow.key === 'waiting' && v.at) parts.push(t('send.flow.lastPass', { at: timeText(v.at) }));
  const box = el('div', { class: 'flow', 'data-flow': flow.key },
    el('p', { class: `msg msg-${TONE[flow.key] || 'info'}`, role: TONE[flow.key] === 'err' ? 'alert' : null }, parts.join(' ')));
  if (v.total && MOVING.includes(flow.key)) box.append(el('progress', { max: v.total, value: Math.min(v.done, v.total), 'aria-label': t('send.flow.bar', { pct: v.pct }) }));
  return box;
}

// ---------------------------------------------------------------------------------------------
// Estimation avant un envoi complet

// { rows, bytes, lots, seconds, recipients } pour l'envoi de toutes les lignes des tables de l'export
// (`exp.tables`) : lignes qui peuvent partir lues dans le suivi de Synchro (clé présente, filtre
// appliqué), poids d'après les 50 premières lignes de chaque table.
export async function exportEstimate(exp) {
  const sync = (await selectRows(SYNC_TABLE, [EXPORT_COL, TABLE_COL, TYPE_COL, LIST_COL])) || [];
  const recipients = (await readHooks()).of(exp.id).filter(h => h.fields.enabled).length;
  const tables = [];
  for (const tb of exp.tables) {
    const data = await fetchRows(tb.table);
    const ids = tb.columns.map(c => c.id);
    const sample = data.slice(0, 50).map(r => Object.fromEntries(ids.map(id => [id, r[id]])));
    tables.push({ rows: eligibleRows(sync, exp.id, tb.table) ?? data.length, bytesPerLine: lineBytes(sample), all: data.length });
  }
  return { ...estimateSend({ tables, recipients: Math.max(1, recipients) }), all: tables.reduce((n, tb) => n + tb.all, 0) };
}

// Lignes de texte qui disent ce que l'envoi va coûter et pourquoi il ne part pas d'un coup.
export function estimateLines(est) {
  return [
    el('p', {}, t('send.estimate.body', {
      rows: est.rows, size: sizeText(est.bytes), lots: est.lots, n: est.recipients, dur: durationText(est.seconds),
    })),
    est.seconds >= LONG_SECONDS ? el('p', { class: 'muted small' }, t('send.estimate.pace', { mb: RESEND_BUDGET / 1000000, min: BUDGET_WINDOW / 60 })) : null,
  ];
}

// Confirmation d'un envoi long : le coût d'abord, puis Envoyer ou Annuler. Vrai si la personne envoie.
export function confirmSend(est) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title: t('send.estimate.title'), body: estimateLines(est), width: 480,
      onClose: () => { if (!answered) resolve(false); },
      buttons: [
        { label: t('common.cancel'), onClick: (m) => { answered = true; resolve(false); m.close(); } },
        { label: t('send.load.ok'), kind: 'btn-primary', onClick: (m) => { answered = true; resolve(true); m.close(); } },
      ],
    });
  });
}
