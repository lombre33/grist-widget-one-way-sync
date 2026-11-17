// Sonde : ce que la clé d'un formulaire (le droit d'écriture du webhook de la SOURCE) peut faire par la route des
// enregistrements sur les TABLES DE MÉTADONNÉES (`_grist_*`) du document de la CIBLE. Une écriture acceptée changerait la
// structure, les règles d'accès ou les webhooks du document à partir d'une simple clé de partage. Chaque essai part d'une paire
// neuve (un document chaque fois : une écriture refusée par le moteur laisse le document dans un état douteux) et se juge
// par une lecture du propriétaire, avant et après, puis après un rechargement du document.
// Résultat connu (Grist 1.7.22, 17 novembre 2026) : règles d'accès, partages, réglages, webhooks, colonnes et vues sont refusés (403) ;
// seul l'ajout d'une ligne à `_grist_Tables` (essai 1) passe jusqu'au moteur, qui lève « KeyError » : rien n'est enregistré, mais le moteur
// du document reste de travers (le propriétaire ne peut plus écrire, « KeyError ») jusqu'au rechargement du document. Défaut de Grist,
// pas du widget : un déni de service passager que fait toute personne qui tient la clé du formulaire. Le code de sortie est 1 tant que
// l'essai 1 se reproduit.
// Usage : tests/e2e/start-grist.sh, puis `PORT=8756 [ONLY=1,2] node tests/e2e/tools/probe-form-key-meta.mjs`.
import { log } from '../harness.mjs';
import { startProbe } from './probe.mjs';

const basePort = Number(process.env.PORT || 8756);
const only = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;
let wrote = 0;

async function experiment(number, name, fields) {
  const { h, p } = await startProbe({ port: basePort + number, name: `Sonde clé métadonnées ${number}`, rows: 3 });
  const { TEAM } = h;
  const doc = p.dst.doc;
  const key = /\/api\/s\/([^/]+)\//.exec((await h.webhooks(p.src.doc))[0].fields.url)[1];
  const viaKey = async (path, body, method = 'POST') => {
    const r = await fetch(`${TEAM}/api/s/${key}${path}`, { method, headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return `HTTP ${r.status} ${(await r.text()).slice(0, 130).replace(/\s+/g, ' ')}`;
  };
  const ctx = {
    tableRef: (await h.records(doc, '_grist_Tables')).find(t => t.tableId === p.dest).id,
    resource: ((await h.records(doc, '_grist_ACLResources')).find(r => r.tableId === '*') || {}).id,
  };
  const table = name;
  const before = (await h.records(doc, table)).length;
  const sent = fields(ctx);
  log(`#${number} ${table} <- ${JSON.stringify(sent)}`);
  log(`#${number} réponse : ${await viaKey(`/tables/${table}/records`, { records: [{ fields: sent }] })}`);
  const after = await h.records(doc, table);
  log(`#${number} lignes de ${table} : ${before} -> ${after.length}`);
  if (after.length !== before) { wrote++; log(`#${number}   dernière ligne : ${JSON.stringify(after[after.length - 1]).slice(0, 220)}  <-- ÉCRITURE VUE PAR LE PROPRIÉTAIRE`); }
  // Le document marche-t-il encore ? Une écriture du propriétaire, puis un rechargement.
  let works = 'oui';
  try { await h.applyActions(doc, [['AddRecord', p.dest, null, { Nom: 'après' }]]); } catch (e) { works = `NON : ${e.message.slice(0, 160)}`; }
  log(`#${number} le propriétaire écrit encore dans ${p.dest} : ${works}`);
  try {
    await h.api('POST', `/docs/${doc}/force-reload`);
    const names = (await h.records(doc, '_grist_Tables')).map(t => t.tableId);
    log(`#${number} après rechargement : tables ${names.join(', ')}`);
  } catch (e) { log(`#${number} après rechargement : ERREUR ${e.message.slice(0, 200)}`); }
  await h.close();
}

const all = [
  [1, '_grist_Tables', () => ({ tableId: 'Pwn' })],
  [2, '_grist_ACLRules', ({ resource }) => ({ resource, aclFormula: '', permissionsText: 'all', memo: 'pwn', rulePos: 99 })],
  [3, '_grist_Shares', () => ({ linkId: 'pwn', options: '{"publish":true}' })],
  [4, '_grist_DocInfo', () => ({ documentSettings: '{"locale":"fr-FR"}' })],
  [5, '_grist_Triggers', ({ tableRef }) => ({ tableRef, eventTypes: ['L', 'add', 'update'], enabled: true, actions: '[{"type":"webhook","id":"1"}]' })],
  [6, '_grist_Tables_column', ({ tableRef }) => ({ parentId: tableRef, colId: 'Pwn', type: 'Text', label: 'Pwn', isFormula: false, formula: '', widgetOptions: '' })],
  [7, '_grist_Views_section', ({ tableRef }) => ({ tableRef, parentKey: 'record', title: 'pwn' })],
];
for (const [number, table, fields] of all) if (!only || only.includes(number)) await experiment(number, table, fields);
log(wrote ? `RÉSULTAT : ${wrote} écriture(s) de métadonnées vue(s) par le propriétaire après un essai de la clé du formulaire` : 'RÉSULTAT : aucune écriture de métadonnées par la clé du formulaire');
process.exit(wrote ? 1 : 0);
