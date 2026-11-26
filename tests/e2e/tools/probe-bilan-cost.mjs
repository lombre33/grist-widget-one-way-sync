// Mesure du coût, côté SOURCE, de l'annonce des dernières modifications ajoutée au bilan du lot (0.31.2).
// Une SOURCE de N lignes branchée à une CIBLE ; le temps d'une écriture d'une cellule (POST /apply) est mesuré avec la formule du
// lot d'avant (`ANCIEN`, le dossier js/ d'un commit d'avant extrait avec git archive) puis avec celle d'ici, posées à la main dans la
// colonne Synchro_Lot (le widget SOURCE est fermé pendant la mesure : il réécrirait sa formule).
// Piste écartée par cette mesure : un maximum de MajLe par seau de clés, lu sur toutes les lignes, ajoutait 90 à 130 ms par écriture
// à 10 000 lignes (écriture : 33 ms), parce que Grist lit une date cinq fois plus lentement qu'un nombre.
// Usage : ANCIEN=/tmp/old-engine WIDGET_PORT=8786 ROWS=10000 node tests/e2e/tools/probe-bilan-cost.mjs
import { startProbe } from './probe.mjs';
import { log, sleep } from '../harness.mjs';
import { syncFormulas } from '../../../js/engine/logic/formulas.js';

const ROWS = Number(process.env.ROWS || 10000);
const old = process.env.ANCIEN ? (await import(`${process.env.ANCIEN}/js/engine/logic/formulas.js`)).syncFormulas : null;
const { h, p } = await startProbe({ port: Number(process.env.WIDGET_PORT || 8786), name: 'Coût du bilan', rows: Math.min(ROWS, 30) });
const { applyActions, records } = h;
const have = (await records(p.src.doc, 'Contacts')).length;
for (let n = have; n < ROWS; n += 2000) {
  const size = Math.min(2000, ROWS - n);
  await applyActions(p.src.doc, [['BulkAddRecord', 'Contacts', Array(size).fill(null), { Nom: Array.from({ length: size }, (_, i) => `N${n + i}`), Ville: Array(size).fill('Lyon') }]]);
}
log(`SOURCE : ${(await records(p.src.doc, 'Contacts')).length} lignes`);
await p.sv.page.goto('about:blank');
await p.dv.page.goto('about:blank');
await sleep(15000);

const variants = { ...(old ? { ancienne: old(['Contacts']).lot } : {}), nouvelle: syncFormulas(['Contacts']).lot };
const target = (await records(p.src.doc, 'Contacts'))[5].id;
async function timeWrites(label) {
  const times = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    await applyActions(p.src.doc, [['UpdateRecord', 'Contacts', target, { Ville: `Ville ${label} ${i}` }]]);
    times.push(performance.now() - t0);
    await sleep(300);
  }
  times.sort((a, b) => a - b);
  return { median: Math.round(times[7]), min: Math.round(times[0]), max: Math.round(times[14]) };
}
for (const name of [...Object.keys(variants), ...Object.keys(variants)]) {
  await applyActions(p.src.doc, [['ModifyColumn', 'Synchro', 'Synchro_Lot', { formula: variants[name] }]]);
  await sleep(4000);
  const lot = (await records(p.src.doc, 'Synchro')).find(r => r.Synchro_Type === 'lot').Synchro_Lot;
  log(`${name} (${ROWS} lignes) : écriture ${JSON.stringify(await timeWrites(name))} ms, lot de ${String(lot || '').length} caractères`);
}
await h.close();
