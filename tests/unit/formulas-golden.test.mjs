// Le texte des formules de la table Synchro, octet pour octet. C'est ce que le moteur pose dans les colonnes des
// documents déjà partagés (`Synchro_Lot`, `Synchro_Ids`, `Sync_Etat`) : tant que le texte ne change pas, rien ne
// bouge chez eux (aucune écriture de formule, aucun recalcul). Un découpage du code de `formulas.js` doit donc le
// laisser identique. Les textes de référence sont dans `golden/formulas.json`, figés avant la consigne GFS 006 (découpe de
// `lotFormula`) ; trois montages : sans préfixe, préfixe `Gfs_`, aucune table.
//
// Si le texte DOIT changer (une vraie évolution du protocole), c'est une décision, pas un détail : relever la version du
// moteur (`engine/version.js`) et le dire dans GFS-ETAT.md, puis réécrire la référence avec `UPDATE_GOLDEN=1 npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startEngine } from '../../js/engine/index.js';
import { syncFormulas } from '../../js/engine/logic/formulas.js';
import { fakeDoc, fakePort } from './engine-fake.mjs';

const GOLDEN = fileURLToPath(new URL('./golden/formulas.json', import.meta.url));
const CASES = {
  'sans préfixe, deux tables': { prefix: '', tables: ['Contacts', 'Villes'] },
  'préfixe Gfs_, une table': { prefix: 'Gfs_', tables: ['Annuaire'] },
  'aucune table': { prefix: '', tables: [] },
};

function render({ prefix, tables }) {
  startEngine({ port: fakePort(fakeDoc()), prefix });
  try {
    return syncFormulas(tables);
  } finally {
    startEngine({ port: fakePort(fakeDoc()), prefix: '' });
  }
}

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');

if (process.env.UPDATE_GOLDEN === '1') {
  const out = {};
  for (const [name, spec] of Object.entries(CASES)) {
    out[name] = Object.fromEntries(Object.entries(render(spec)).map(([key, text]) => [key, { sha256: sha(text), text }]));
  }
  writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}\n`);
}

const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));

for (const [name, spec] of Object.entries(CASES)) {
  test(`le texte des formules de Synchro reste identique octet pour octet : ${name}`, () => {
    const now = render(spec);
    assert.deepEqual(Object.keys(now).sort(), Object.keys(golden[name]).sort(), 'les mêmes formules');
    for (const [key, text] of Object.entries(now)) {
      const ref = golden[name][key];
      assert.equal(sha(ref.text), ref.sha256, `${key} : la référence elle-même a été retouchée`);
      assert.equal(text.length, ref.text.length, `${key} : longueur du texte`);
      assert.equal(text, ref.text, `${key} : le texte posé dans les documents a changé`);
      assert.equal(sha(text), ref.sha256, `${key} : empreinte SHA-256`);
    }
  });
}

test('chaque formule du montage garde ses marques : signature, bilan, plafond, fenêtre des lignes recalculées', () => {
  const { lot } = render(CASES['sans préfixe, deux tables']);
  for (const mark of ['def body():', '"sigs"', 'lot["bilan"]', 'lot["restant"]', 'lot.update(depuis=v(cut), renvoi=bool(again))',
    'time.time() - 5', 'room = 950000', 'max(20000, min(250000, room', 'json.dumps(files, ensure_ascii=False)']) {
    assert.ok(lot.includes(mark), mark);
  }
});
