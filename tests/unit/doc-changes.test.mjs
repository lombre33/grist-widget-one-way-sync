// docChanges (js/grist.js) : ce qui a changé depuis un état du document. Un état que Grist ne connaît plus
// (500 « Cannot read hash », mesuré sur Grist 1.7.19) ne veut PAS dire « rien n'a changé » : la fonction
// relit depuis HEAD et rend `tables: null` (« inconnu »), que la boucle de la CIBLE traite en relisant tout.
// Le réseau et le jeton sont simulés (globalThis.fetch, globalThis.grist) ; rien ne sort de ce fichier.
import test from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'https://grist.numerique.gouv.fr/o/equipe/api/docs/abcdefghijklmn';
const asked = [];
let answers = () => new Response('{}', { status: 500 });

globalThis.grist = { docApi: { getAccessToken: async () => ({ token: 'jeton', baseUrl: BASE }) } };
globalThis.fetch = async (url) => {
  const left = new URL(url).searchParams.get('left');
  asked.push(left);
  return answers(left);
};

const { docChanges } = await import('../../js/grist.js');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const lost = () => json({ error: 'Cannot read hash' }, 500);
const delta = (hash, tableDeltas = {}, tableRenames = []) => json({ right: { h: hash }, details: { rightChanges: { tableDeltas, tableRenames } } });
const run = async (since, respond) => {
  asked.length = 0;
  answers = respond;
  return { result: await docChanges(since), asked: [...asked] };
};

test('docChanges : un état connu rend les tables touchées', async () => {
  const { result, asked: calls } = await run('H1', () => delta('H2', { Journal_Annuaire: {}, Contacts: {} }));
  assert.deepEqual(calls, ['H1']);
  assert.equal(result.hash, 'H2');
  assert.deepEqual([...result.tables].sort(), ['Contacts', 'Journal_Annuaire']);
});

test('docChanges : un état connu sans changement rend un ensemble vide', async () => {
  const { result } = await run('H1', () => delta('H1'));
  assert.equal(result.hash, 'H1');
  assert.ok(result.tables instanceof Set && result.tables.size === 0);
});

test('docChanges : un état perdu (500 « Cannot read hash ») relit HEAD et rend « inconnu », pas « rien »', async () => {
  const { result, asked: calls } = await run('PERDU', left => (left === 'PERDU' ? lost() : delta('H9')));
  assert.deepEqual(calls, ['PERDU', 'HEAD']);
  assert.equal(result.hash, 'H9', 'le nouvel état de départ est celui de HEAD');
  assert.equal(result.tables, null, 'les changements arrivés pendant que l\'état était perdu sont inconnus : tout relire');
});

test('docChanges : un état perdu qui rend 404 ou 400 est traité de même', async () => {
  for (const status of [404, 400]) {
    const { result } = await run('PERDU', left => (left === 'PERDU' ? json({ error: 'x' }, status) : delta('H9')));
    assert.equal(result.tables, null, String(status));
    assert.equal(result.hash, 'H9');
  }
});

test('docChanges : pas d\'état de départ, ou une table renommée : inconnu', async () => {
  const first = await run('', () => delta('H1'));
  assert.deepEqual(first.asked, ['HEAD']);
  assert.equal(first.result.hash, 'H1');
  assert.equal(first.result.tables, null);

  const renamed = await run('H1', () => delta('H2', { Contacts: {} }, [{ from: 'A', to: 'B' }]));
  assert.equal(renamed.result.tables, null);
  assert.equal(renamed.result.hash, 'H2');
});

test('docChanges : sans droit de tout lire (401, 403), rien (la boucle garde son rythme d\'avant)', async () => {
  for (const status of [401, 403]) assert.equal((await run('H1', () => json({ error: 'x' }, status))).result, null, String(status));
});

test('docChanges : Grist ne répond plus, ni pour l\'état ni pour HEAD : inconnu, l\'état de départ reste', async () => {
  const bothFail = await run('H1', () => json({ error: 'boum' }, 500));
  assert.deepEqual(bothFail.asked, ['H1', 'HEAD']);
  assert.deepEqual(bothFail.result, { hash: 'H1', tables: null });

  const network = await run('H1', () => { throw new Error('réseau'); });
  assert.deepEqual(network.result, { hash: 'H1', tables: null });
});
