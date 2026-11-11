// Robustesse : ce que le widget lit dans le document ou sur le réseau peut avoir été retouché à la main ou forgé
// (note d'une colonne, lignes du journal, lot, liste, code, message d'un autre onglet). Aucune de ces lectures ne doit
// lever une erreur qu'elle n'a pas prévue : une exception dans un passage de la recopie l'arrêterait pour tous les
// envois. Les entrées sont des versions abîmées d'entrées valides (types changés, clés retirées ou ajoutées, valeurs
// extrêmes, `__proto__`), tirées avec un générateur à graine fixe : le test est reproductible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCode, docUrl, exportSchema, parseDocBaseUrl, parseFormLink, parseInvitation, parseReply, parseWebhookUrl, validColumns } from '../../js/engine/logic/codes.js';
import { columnNote } from '../../js/engine/logic/common.js';
import { planConsolidation } from '../../js/engine/logic/consolidation.js';
import { expandRows, parseList, parseLot, planPurge, planUnpack, recentChanges, sentColumns } from '../../js/engine/logic/journal.js';
import { readMark } from '../../js/engine/logic/lost.js';
import { addEvent, eventsOf, observeRows, rowsOf } from '../../js/engine/logic/notes.js';
import { liveKeys, tallyGap } from '../../js/engine/logic/tally.js';
import { docFormat, docFormatOf, formatAction, formatGap } from '../../js/engine/logic/docformat.js';
import { columnOptions, ruleStyles, sentRules } from '../../js/engine/logic/options.js';
import { normalizeRule, parseRule, printRule } from '../../js/engine/logic/rules.js';
import { readKeys } from '../../js/engine/logic/trust.js';
import { parseMessage } from '../../js/tab-link.js';
import { COLUMNS, EXPORT, ID, PUB, forge, invitation, j } from './fixtures.mjs';

let seed = 20261111;
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = list => list[Math.floor(random() * list.length)];
const ODD = [null, undefined, true, false, 0, -1, 1e308, NaN, Infinity, '', ' ', 'x', '__proto__', 'constructor', 'toString', [], {}, [[]],
  '0'.repeat(10000), -0, 2 ** 53, '\u0000', '{"a":1}', '[]', 'null', 'ids:', 'ids:a b c'];

// Une copie abîmée de `value` : un morceau de l'arbre est remplacé, retiré ou allongé.
function spoil(value) {
  if (random() < 0.15) return pick(ODD);
  if (Array.isArray(value)) {
    const copy = value.map(spoil);
    if (random() < 0.2) copy.push(pick(ODD));
    if (random() < 0.1) copy.length = Math.floor(random() * copy.length);
    return copy;
  }
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) if (random() >= 0.08) copy[key] = spoil(item);
    if (random() < 0.15) copy[pick(['__proto__', 'constructor', 'toString', 'x'])] = pick(ODD);
    return copy;
  }
  if (typeof value === 'string' && random() < 0.1) return value + String(pick(ODD));
  if (typeof value === 'number' && random() < 0.2) return pick([NaN, -1, 1e308, 0, value + 1]);
  return value;
}
// Un objet abîmé qui reste un objet (une ligne de tableau, une note, une charge utile de code).
const spoilObject = value => { const copy = spoil(value); return copy && typeof copy === 'object' && !Array.isArray(copy) ? copy : { ...value }; };
const text = value => (typeof value === 'string' ? value : JSON.stringify(value));
// Les erreurs voulues (`codeInvalid`, `codeNewer`…) sont des mots seuls : le texte de l'écran les reconnaît.
const planned = error => /^[a-z][A-Za-z]+$/.test(error.message);

function mustNotThrow(name, run) {
  try {
    run();
  } catch (error) {
    if (!planned(error)) assert.fail(`${name} a levé « ${error.message} » (graine ${seed})`);
  }
}

const LOT = { lignes: [['a', 10, false, { Nom: 'x' }], ['b', 11, true, {}]], total: 2, tropGros: ['c'], restant: 5, bilan: { n: 3, t: 100 } };
const LIST = { seaux: { 3: ['a', 'b'] }, t: 5, liste: { marque: 'm', n: 1, t: 5, cles: ['a'], fin: false } };
const RAW = { id: 1, Synchro_Type: 'lot', Synchro_Export: EXPORT, Synchro_Table: 'Contacts', Synchro_Lot: JSON.stringify(LOT), Synchro_Colonnes: JSON.stringify(COLUMNS), Synchro_Ids: JSON.stringify(LIST), id_sync: '', MajLe: 5 };
const NOTE = { exports: [{ id: ID, name: 'x', tables: [] }], invitations: [], pauses: [], historique: { [ID]: [{ at: 5, kind: 'join', who: 'x', n: 1 }] }, lignes: { [ID]: { at: 5, n: { T: 20 } } }, fichiers: {} };
const INVITATION = { f: 1, v: '0.15.2', kind: 'invitation', id: ID, export: EXPORT, name: 'Annuaire', origin: 'https://g.fr', tables: [{ table: 'Contacts', columns: COLUMNS }], pub: PUB, from: { docName: 'x', docId: 'abc' } };
const REPLY = { f: 1, v: '0.15.2', kind: 'reponse', id: ID, recipient: 'a@b.fr', url: 'https://g.fr/api/s/abcdefghijkl/tables/Journal/records?flat=1', pub: PUB };

test('lot, liste, lignes du journal et recopie : jamais d\'exception sur des données abîmées', () => {
  for (let i = 0; i < 250; i++) {
    const lot = spoil(LOT);
    const list = spoil(LIST);
    mustNotThrow('parseLot', () => parseLot(text(lot)));
    mustNotThrow('parseList', () => parseList(text(list)));
    const raws = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, k) => spoilObject({ ...RAW, id: k + 1 }));
    mustNotThrow('planUnpack', () => planUnpack(raws, 'J', { exportId: random() < 0.5 ? EXPORT : null, now: 10 }));
    const rows = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, k) => spoilObject(j(k + 1, pick(['a', 'b', 'c', '', 5, null]), pick([1, 2, 3, null, 'x']), {
      Synchro_Table: 'Contacts', Sync_Avant: pick([null, '{"v":{"Nom":"z"}}', '{"n":3}', '{"k":"a"}', 'x']), Sync_Etat: pick(['ajout', 'modif', 'suppression', 'refus', 'partie', '', null]) })));
    const dest = Array.from({ length: Math.floor(random() * 4) }, (_, k) => spoilObject({ id: k + 1, id_sync: pick(['a', 'b', '']), Nom: 'q', Supprime: false }));
    for (const mode of [{}, { exchange: true }, { exchange: true, hub: true, deleteCol: true }, { archive: true }]) {
      mustNotThrow(`planConsolidation ${JSON.stringify(mode)}`, () => planConsolidation({ journalRows: rows, destRows: dest, copyCols: [['Nom', 'Nom']], destTable: 'D', journalTable: 'J', ...mode }));
    }
    mustNotThrow('expandRows', () => expandRows(rows));
    mustNotThrow('planPurge', () => planPurge(rows, 'J'));
    mustNotThrow('recentChanges', () => recentChanges(rows, 'Nom', 0, 10, { copyCols: [['Nom', 'Nom']] }));
    mustNotThrow('sentColumns', () => sentColumns(rows));
    mustNotThrow('liveKeys', () => liveKeys(rows.map(row => ({ row }))));
    mustNotThrow('tallyGap', () => tallyGap(spoil({ n: 3, t: 5 }), rows.map(row => ({ row }))));
  }
});

test('notes, marques et clés : jamais d\'exception sur une note retouchée à la main', () => {
  for (let i = 0; i < 250; i++) {
    const note = spoilObject(NOTE);
    mustNotThrow('eventsOf', () => eventsOf(note, ID));
    mustNotThrow('rowsOf', () => rowsOf(note, ID));
    mustNotThrow('observeRows', () => observeRows(note, ID, { T: 5, U: 100 }, 50));
    mustNotThrow('addEvent', () => addEvent(note, ID, { at: 60, kind: 'join', who: 'x' }));
    mustNotThrow('readKeys', () => readKeys(text(spoil({ [ID]: 'a'.repeat(32) }))));
    mustNotThrow('readMark', () => readMark(text(spoil({ syncPlus: { journal: 'Journal', name: 'x', dests: ['A'] } }))));
    mustNotThrow('columnNote', () => columnNote({ description: text(spoil({ export: ID, tables: [] })) }));
  }
});

test('codes et messages d\'un autre onglet : seules les erreurs prévues sortent', () => {
  for (let i = 0; i < 250; i++) {
    const invite = forge(spoilObject(INVITATION));
    mustNotThrow('parseInvitation', () => parseInvitation(invite));
    mustNotThrow('decodeCode', () => decodeCode(invite, 'invitation'));
    mustNotThrow('parseReply', () => parseReply(forge(spoilObject(REPLY)), 'https://g.fr'));
    mustNotThrow('validColumns', () => validColumns(spoil(COLUMNS)));
    mustNotThrow('parseMessage', () => parseMessage(spoilObject({ app: 'gristsync', k: pick(['offer', 'reply', 'want', 'seen', 'got', 'wantReply']), id: ID, code: invite })));
    mustNotThrow('parseMessage (invitation)', () => parseMessage(spoilObject({ app: 'gristsync', k: 'offer', code: invitation() })));
    mustNotThrow('parseFormLink', () => parseFormLink(text(pick(ODD))));
    mustNotThrow('parseWebhookUrl', () => parseWebhookUrl(text(pick(ODD))));
    mustNotThrow('docUrl', () => docUrl(pick(ODD), pick(ODD), pick(ODD), pick(ODD)));
  }
  assert.throws(() => parseDocBaseUrl('pas une adresse'), 'l\'adresse du jeton vient de Grist : une valeur illisible est une erreur, pas un cas à traiter');
});

// Mise en forme reçue : les règles de mise en forme conditionnelle et les réglages de langue viennent d'un autre
// document. Une règle n'est jamais copiée : elle est lue par une grammaire stricte, puis réécrite avec les noms d'ici.
// Quoi qu'on lui donne, le lecteur ne lève rien, et ce qu'il réécrit se relit à l'identique (point fixe).
test('mise en forme reçue : règles et réglages abîmés, aucune exception, et ce qui est réécrit se relit à l\'identique', () => {
  const RULES = ['$Montant < 0', 'rec.Reel > $Montant * 0.9', '$A == "x" and ($B != 3 or not $C)', '$A in ["a", "b"] and $B not in [1, 2]', '$D is None or $D is not None',
    '-$A + 2 * ($B - 1) / 4 >= TODAY()', '$A == True or $A == False', '$Date < TODAY()'];
  const RISKY = ['(', ')', '"', '\'', '\\', '.', '_', '[', ']', ',', '`', '\n', '‮', '\u0000', 'lambda ', '__import__', 'import ', ' if ', ' else ', '**', '//', '%', '@', ':', ';', '{', '}', '$', 'rec.', 'TODAY(', 'None'];
  const mutate = (rule) => {
    let out = rule;
    for (let n = 1 + Math.floor(random() * 2); n > 0; n--) {
      const at = Math.floor(random() * (out.length + 1));
      const kind = random();
      if (kind < 0.4) out = out.slice(0, at) + pick(RISKY) + out.slice(at);
      else if (kind < 0.7) out = out.slice(0, at) + out.slice(at + 1 + Math.floor(random() * 4));
      else if (kind < 0.85) out = out.slice(0, at) + out.slice(Math.floor(random() * out.length));
      else out += pick(RULES);
    }
    return out;
  };
  const rename = id => (random() < 0.9 ? `${id}_2` : null);
  const sample = Array.from({ length: 600 }, () => (random() < 0.1 ? text(pick(ODD)) : random() < 0.3 ? pick(RULES) : mutate(pick(RULES))));
  let kept = 0;
  for (const rule of sample) {
    mustNotThrow('parseRule', () => parseRule(rule));
    mustNotThrow('normalizeRule', () => normalizeRule(rule));
    const tree = parseRule(rule);
    if (!tree) continue;
    kept++;
    const printed = printRule(tree);
    assert.ok(printed && !/__|import|lambda|[;`\\{}@%]|\*\*|\/\//.test(printed.replace(/"[^"]*"/g, '""').replace(/\$[A-Za-z][A-Za-z0-9_]*/g, '$X')), `une règle gardée n'a que des signes permis : ${printed}`);
    assert.equal(printRule(parseRule(printed)), printed, `la règle réécrite se relit à l'identique : ${rule}`);
    const renamed = printRule(tree, rename);
    if (renamed) assert.ok(parseRule(renamed), `la règle aux noms d'ici est une règle : ${renamed}`);
  }
  assert.ok(kept > 100 && kept < sample.length, `le tirage garde des règles et en écarte (${kept} sur ${sample.length})`);
  const OPTS = { numMode: 'currency', decimals: 2, currency: 'EUR', alignment: 'right', headerFillColor: '#336699', headerFontBold: true,
    rules: [{ when: '$Montant < 0', fillColor: '#FF0000', textColor: '#FFFFFF', fontBold: true }, { when: '$Reel > 3', fillColor: '#FFCC00' }] };
  const SETTINGS = { locale: 'fr-FR', currency: 'EUR', engine: 'python3' };
  for (let i = 0; i < 400; i++) {
    const opts = spoilObject(OPTS);
    mustNotThrow('columnOptions', () => columnOptions('Numeric', text(opts), { extras: true }));
    mustNotThrow('columnOptions (sans extras)', () => columnOptions('Numeric', text(opts)));
    mustNotThrow('sentRules', () => sentRules(opts));
    mustNotThrow('ruleStyles', () => ruleStyles(text(spoilObject({ rulesOptions: opts.rules }))));
    mustNotThrow('exportSchema', () => exportSchema([{ id: 'Montant', type: 'Numeric', label: 'Montant', opts, fmt: pick([true, false, 1, 'oui']), doc: spoilObject(SETTINGS) }]));
    const settings = text(spoilObject(SETTINGS));
    mustNotThrow('docFormat', () => docFormat(settings));
    mustNotThrow('docFormatOf', () => docFormatOf([{ documentSettings: settings }]));
    mustNotThrow('docFormatOf (lignes abîmées)', () => docFormatOf(spoil([{ documentSettings: settings }])));
    mustNotThrow('formatGap', () => formatGap(docFormat(settings), docFormat(text(spoilObject(SETTINGS)))));
    mustNotThrow('formatAction', () => formatAction([{ id: 1, documentSettings: text(spoilObject(SETTINGS)) }], docFormat(settings)));
  }
  // Une langue ou une devise qui n'a pas la forme d'un code est écartée, jamais écrite dans le document.
  assert.equal(docFormat(JSON.stringify({ locale: '<script>', currency: 'euro!' })), null);
  assert.deepEqual(docFormat(JSON.stringify({ locale: 'fr-FR', currency: 'EUR', engine: 'x', autre: 1 })), { locale: 'fr-FR', currency: 'EUR' });
});
