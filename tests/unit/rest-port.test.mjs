// Les requêtes REST du moteur (js/engine/rest-port.js), essayées sur un `http` en mémoire : aucun réseau, aucun
// Grist, aucun navigateur. C'est ce que fait un hôte (Sync+, GFS) : donner `http` et recevoir les fonctions du
// port. L'`http` du test garde la liste des appels pour vérifier l'ordre et ce qui n'est pas parti.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PORT_SHAPE, createRestPort } from '../../js/engine/index.js';

const BASE = 'https://grist.example.org/o/equipe/api/docs/abcdefghijklmn';
const KEY = 'ABCDEF0123456789abcdef';
const HOOK_URL = `https://grist.example.org/o/equipe/api/s/${KEY}/tables/Journal/records?flat=1`;

const refusal = (status, message = '') => Object.assign(new Error(message), { status });

// Un `http` dont `reply(méthode, chemin)` décide de la réponse : un objet `{ status?, body }`, un nombre
// (refus de ce statut), ou une erreur à lever (réseau muet).
function fakeHttp(reply) {
  const calls = [];
  const answer = (kind, method, path, options) => {
    calls.push({ kind, method, path, ...options });
    const result = reply(method, path, options, kind);
    if (result instanceof Error) throw result;
    if (typeof result === 'number') throw refusal(result, 'refus');
    return { status: 200, body: null, ...result };
  };
  return {
    calls,
    request: async (method, path, options = {}) => answer('request', method, path, options),
    anonymous: async (method, url, options = {}) => answer('anonymous', method, url, options),
    download: async (id) => {
      calls.push({ kind: 'download', path: id });
      const result = reply('GET', `/attachments/${id}/download`, {}, 'download');
      if (result instanceof Error) throw result;
      if (typeof result === 'number') throw refusal(result, `HTTP ${result}`);
      return result.body;
    },
    upload: async (name, bytes) => {
      calls.push({ kind: 'upload', path: name, bytes });
      const result = reply('POST', '/attachments', { name, bytes }, 'upload');
      if (result instanceof Error) throw result;
      if (typeof result === 'number') throw refusal(result, 'refus du dépôt');
      return result.body;
    },
    docBaseUrl: async () => BASE,
  };
}

const port = (reply, triggers = []) => {
  const http = fakeHttp(reply);
  return { http, rest: createRestPort({ docApi: { fetchRows: async () => triggers }, http }) };
};

const trigger = (id, text) => ({ condition: JSON.stringify({ text }), actions: JSON.stringify([{ type: 'webhook', id }]) });

test('createWebhook : la condition enregistrée est relue ; l\'id du webhook est rendu', async () => {
  const { rest, http } = port(() => ({ body: { webhooks: [{ id: 'w1' }] } }), [trigger('w1', 'rec.Synchro_Export == "e1"')]);
  const id = await rest.createWebhook({ name: 'n', memo: 'm', url: HOOK_URL, tableId: 'Synchro', condition: 'rec.Synchro_Export == "e1"' });
  assert.equal(id, 'w1');
  const [call] = http.calls;
  assert.deepEqual([call.method, call.path, call.full], ['POST', '/webhooks', true]);
  assert.deepEqual(call.body.webhooks[0].fields.eventTypes, ['add', 'update']);
});

test('createWebhook : une condition qui manque à l\'enregistrement efface le webhook (il recevrait tout)', async () => {
  const { rest, http } = port(() => ({ body: { webhooks: [{ id: 'w2' }] } }), [trigger('w2', '')]);
  await assert.rejects(rest.createWebhook({ name: 'n', memo: 'm', url: HOOK_URL, tableId: 'Synchro', condition: 'rec.X' }), /gristTooOld/);
  const methods = http.calls.map(c => `${c.method} ${c.path}`);
  assert.deepEqual(methods, ['POST /webhooks', 'DELETE /webhooks/queue/w2', 'DELETE /webhooks/w2']);
});

test('createWebhook : un Grist qui refuse le champ « condition » est dit trop ancien', async () => {
  const { rest } = port(() => refusal(400, 'Unknown field condition'));
  await assert.rejects(rest.createWebhook({ name: 'n', memo: 'm', url: HOOK_URL, tableId: 'Synchro', condition: 'x' }), /gristTooOld/);
  const other = port(() => refusal(500, 'boum')).rest;
  await assert.rejects(other.createWebhook({ name: 'n', memo: 'm', url: HOOK_URL, tableId: 'Synchro', condition: 'x' }), /HTTP 500/);
});

test('deleteWebhook : la file de ce webhook est vidée avant, et un échec de la file ne retient pas l\'effacement', async () => {
  const ok = port(() => ({ body: null }));
  await ok.rest.deleteWebhook('w3');
  assert.deepEqual(ok.http.calls.map(c => `${c.method} ${c.path}`), ['DELETE /webhooks/queue/w3', 'DELETE /webhooks/w3']);
  const noRoute = port((method, path) => (path.includes('/queue/') ? 404 : { body: null }));
  await noRoute.rest.deleteWebhook('w3');
  assert.equal(noRoute.http.calls.at(-1).path, '/webhooks/w3', 'un Grist sans cette route est effacé quand même');
});

test('deleteWebhookWithNotice : un avis qui échoue (lien mort, trop lent) ne retient pas l\'effacement', async () => {
  const { rest, http } = port((method, path, options, kind) => (kind === 'anonymous' ? 404 : { body: null }));
  await rest.deleteWebhookWithNotice({ id: 'w4', fields: { url: HOOK_URL } }, [{ Synchro_Type: 'fin' }]);
  assert.equal(http.calls[0].kind, 'anonymous');
  assert.equal(http.calls[0].timeout, 10000, 'le délai court de l\'avis de fin');
  assert.equal(http.calls.at(-1).path, '/webhooks/w4');
  const silent = port((method, path, options, kind) => (kind === 'anonymous' ? new Error('réseau muet') : { body: null }));
  await silent.rest.deleteWebhookWithNotice({ id: 'w5', fields: { url: HOOK_URL } }, []);
  assert.equal(silent.http.calls.at(-1).path, '/webhooks/w5');
});

test('postRows : rien ne part vers une autre instance ; une erreur ne montre pas la clé en entier', async () => {
  const { rest, http } = port(() => ({ status: 200 }));
  await assert.rejects(rest.postRows(`https://autre.example.org/api/s/${KEY}/tables/J/records`, [{ a: 1 }]), /otherInstance/);
  assert.equal(http.calls.length, 0, 'aucune requête partie');
  await rest.postRows(HOOK_URL, [{ a: 1 }]);
  assert.deepEqual([http.calls[0].kind, http.calls[0].method, http.calls[0].path, http.calls[0].body], ['anonymous', 'POST', HOOK_URL, [{ a: 1 }]]);
  assert.equal(http.calls[0].timeout, 60000);
  const failing = port(() => refusal(403, `Blocked on https://grist.example.org/o/equipe/api/s/${KEY}/tables/J`)).rest;
  await assert.rejects(failing.postRows(HOOK_URL, []), (e) => {
    assert.match(e.message, /^HTTP 403 /);
    assert.ok(!e.message.includes(KEY), 'la clé est abrégée');
    return true;
  });
});

test('isOwner : 403 = pas propriétaire ; une erreur réseau remonte et ne reste pas en mémoire', async () => {
  let mode = 'network';
  const { rest, http } = port(() => (mode === 'network' ? new Error('réseau muet') : mode === 'viewer' ? 403 : { body: { webhooks: [] } }));
  await assert.rejects(rest.isOwner(), /réseau muet/);
  mode = 'viewer';
  assert.equal(await rest.isOwner(), false);
  mode = 'owner';
  assert.equal(await rest.isOwner(), false, 'la réponse sûre est gardée pour la session');
  assert.equal(http.calls.length, 2);
  const owner = port(() => ({ body: { webhooks: [] } })).rest;
  assert.equal(await owner.isOwner(), true);
});

test('selectRows et journalStats : le SQL écrit, null quand Grist refuse', async () => {
  const { rest, http } = port(() => ({ body: { records: [{ fields: { id: 1, Nom: 'A' } }] } }));
  assert.deepEqual(await rest.selectRows('Synchro', ['Nom'], { Synchro_Export: "o'brien" }), [{ id: 1, Nom: 'A' }]);
  const call = http.calls[0];
  assert.deepEqual([call.method, call.path, call.full], ['GET', '/sql', true]);
  assert.equal(call.params.q, `select "id", "Nom" from "Synchro" where "Synchro_Export" = 'o''brien'`);
  assert.equal(await port(() => 403).rest.selectRows('T', ['a']), null);
  assert.equal(await port(() => new Error('réseau muet')).rest.querySql('select 1'), null);

  const stats = port(() => ({ body: { records: [{ fields: { n: 12, last: 1700000000, raw: 3 } }] } })).rest;
  assert.deepEqual(await stats.journalStats('Journal_X', 'Sync_Recu', 'Synchro_Type'), { n: 12, last: 1700000000, raw: 3 });
  const blocked = port(() => ({ body: { records: [] } }));
  assert.equal(await blocked.rest.journalStats('Journal_X', 'Sync_Recu', 'Synchro_Type'), null);
  assert.equal(await blocked.rest.journalStats('Journal"; drop', 'a', 'b'), null);
  assert.equal(blocked.http.calls.length, 1, 'un nom de table douteux n\'est pas envoyé');
});

test('docChanges : un état connu, perdu (500), sans état, renommé, refusé', async () => {
  const delta = (hash, tableDeltas = {}, tableRenames = []) => ({ body: { right: { h: hash }, details: { rightChanges: { tableDeltas, tableRenames } } } });
  const known = port(() => delta('H2', { A: {} }));
  const result = await known.rest.docChanges('H1');
  assert.deepEqual([...result.tables], ['A']);
  assert.deepEqual(known.http.calls[0].params, { left: 'H1', right: 'HEAD', maxRows: 1 });
  assert.equal(known.http.calls[0].full, true, 'la comparaison se fait avec les droits de la personne');

  const lost = port((method, path, options) => (options.params.left === 'PERDU' ? 500 : delta('H9')));
  const afterLoss = await lost.rest.docChanges('PERDU');
  assert.deepEqual(lost.http.calls.map(c => c.params.left), ['PERDU', 'HEAD']);
  assert.deepEqual(afterLoss, { hash: 'H9', tables: null });

  assert.equal((await port(() => delta('H1')).rest.docChanges('')).tables, null, 'pas d\'état de départ : inconnu');
  assert.equal((await port(() => delta('H3', { A: {} }, [['A', 'B']])).rest.docChanges('H1')).tables, null, 'table renommée : tout relire');
  assert.equal(await port(() => 403).rest.docChanges('H1'), null, 'réservé à qui peut tout lire');
  assert.deepEqual(await port(() => new Error('réseau muet')).rest.docChanges('H1'), { hash: 'H1', tables: null });
});

test('shareInfo : le document que désigne la clé, lu sans jeton ; clé inconnue = null', async () => {
  const doc = { id: 'cibleDocId0001x', name: 'Réception', workspace: { name: 'Dossier', org: { domain: 'equipe', name: 'Équipe' } } };
  const { rest, http } = port(() => ({ body: doc }));
  const info = await rest.shareInfo(HOOK_URL);
  assert.equal(info.docId, 'cibleDocId0001x');
  assert.equal(info.team, 'equipe');
  assert.deepEqual([http.calls[0].kind, http.calls[0].path, http.calls[0].timeout], ['anonymous', `https://grist.example.org/o/equipe/api/s/${KEY}`, 15000]);
  assert.equal(await port(() => 404).rest.shareInfo(HOOK_URL), null);
  assert.equal(await port(() => 403).rest.shareInfo(HOOK_URL), null);
  assert.equal(await rest.shareInfo('https://grist.example.org/pas-un-lien'), null, 'rien n\'est demandé pour une adresse inconnue');
  assert.equal(http.calls.length, 1);
  await assert.rejects(port(() => 500).rest.shareInfo(HOOK_URL), /shareUnreadable/);
  await assert.rejects(port(() => ({ body: { id: 'x' } })).rest.shareInfo(HOOK_URL), /shareUnreadable/);
});

test('publicAccess et publicRecords : document public lu sans jeton', async () => {
  assert.equal(await port(() => ({ body: { access: 'editors' } })).rest.publicAccess(BASE), 'editors');
  assert.equal(await port(() => ({ body: null })).rest.publicAccess(BASE), 'viewers');
  for (const status of [401, 403, 404]) assert.equal(await port(() => status).rest.publicAccess(BASE), '', String(status));
  assert.equal(await port(() => 503).rest.publicAccess(BASE), null);
  assert.equal(await port(() => new Error('réseau muet')).rest.publicAccess(BASE), null);

  const { rest, http } = port(() => ({ body: { records: [{ id: 1 }] } }));
  assert.deepEqual(await rest.publicRecords(BASE, 'Journal', { Synchro_Export: ['e1'] }), [{ id: 1 }]);
  assert.equal(http.calls[0].path, `${BASE}/tables/Journal/records?filter=${encodeURIComponent('{"Synchro_Export":["e1"]}')}`);
  await assert.rejects(port(() => 403).rest.publicRecords(BASE, 'Journal', {}), /publicClosed/);
  await assert.rejects(port(() => new Error('réseau muet')).rest.publicRecords(BASE, 'Journal', {}), /publicClosed/);
});

test('pièces jointes : octets rendus, refus dit par son statut', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { rest, http } = port((method, path, options, kind) => ({ body: kind === 'download' ? bytes : 7 }));
  assert.equal(await rest.downloadAttachment('12'), bytes);
  assert.equal(http.calls[0].path, 12, 'le numéro est un nombre');
  assert.equal(await rest.uploadAttachment('a.bin', bytes), 7);
  await assert.rejects(port(() => 404).rest.downloadAttachment(5), /^Error: HTTP 404$/);
  await assert.rejects(port(() => 413).rest.uploadAttachment('a', bytes), /HTTP 413 refus du dépôt/);
});

test('setWebhookEnabled, renameWebhook, clearWebhookQueue : les appels attendus, avec les droits de la personne', async () => {
  const { rest, http } = port(() => ({ body: null }));
  await rest.setWebhookEnabled('a/b', false);
  await rest.renameWebhook('w', 'Nouveau');
  await rest.clearWebhookQueue();
  assert.deepEqual(http.calls.map(c => [c.method, c.path, c.body, c.full]), [
    ['PATCH', '/webhooks/a%2Fb', { enabled: false }, true],
    ['PATCH', '/webhooks/w', { name: 'Nouveau' }, true],
    ['DELETE', '/webhooks/queue', undefined, true],
  ]);
  await assert.rejects(port(() => 403).rest.renameWebhook('w', 'n'), /ownerOnly/);
});

test('createRestPort donne au port tout ce qui passe par REST, et rien que des fonctions', () => {
  const { rest } = port(() => ({ body: null }));
  const given = Object.keys(rest).sort();
  assert.ok(given.every(name => typeof rest[name] === 'function'));
  // Tout ce que PORT_SHAPE demande du réseau est là ; le reste (lecture et écriture des tables, texte, page) est à l'hôte.
  const network = ['selectRows', 'querySql', 'journalStats', 'docChanges', 'isOwner', ...PORT_SHAPE.files, ...PORT_SHAPE.hooks, ...PORT_SHAPE.publicDoc];
  assert.deepEqual(network.filter(name => !given.includes(name)), []);
  assert.deepEqual(given.filter(name => !network.includes(name)), [], 'rien de plus que ce que le port connaît');
});
